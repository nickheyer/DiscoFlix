package outbound

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type memRecorder struct {
	mu      sync.Mutex
	records []*Record
	calls   map[string]int
	resets  map[string]time.Time
	health  []string
}

func newMem() *memRecorder {
	return &memRecorder{calls: map[string]int{}, resets: map[string]time.Time{}}
}

func (m *memRecorder) Latest(_ context.Context, source, url string) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range slices.Backward(m.records) {
		if r.Source == source && r.URL == url {
			return r, nil
		}
	}
	return nil, nil
}

func (m *memRecorder) Save(_ context.Context, r *Record) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.ID = strconv.Itoa(len(m.records) + 1)
	m.records = append(m.records, r)
	return r.ID, nil
}

func (m *memRecorder) Touch(_ context.Context, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.records {
		if r.ID == id {
			r.FetchedAt = at
		}
	}
	return nil
}

func (m *memRecorder) LoadCalls(_ context.Context, source string) (int, time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls[source], m.resets[source], nil
}

func (m *memRecorder) StoreCalls(_ context.Context, source string, calls int, resetAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls[source], m.resets[source] = calls, resetAt
	return nil
}

func (m *memRecorder) Health(_ context.Context, source string, ok bool, detail string, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.health = append(m.health, source+":"+strconv.FormatBool(ok)+":"+detail)
	return nil
}

func newClient(t *testing.T, rec Recorder) *Client {
	t.Helper()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	return New(rec, "DiscoFlix/test", log)
}

func TestCacheAndRevalidate(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte(`{"title":"Heat"}`))
	}))
	defer srv.Close()
	rec := newMem()
	c := newClient(t, rec)
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	c.Register(Policy{Name: "tmdb", CacheTTL: time.Hour})
	ctx := context.Background()
	var out struct{ Title string }
	res, err := c.GetJSON(ctx, "tmdb", Request{URL: srv.URL + "/movie/1", Namespace: "tmdb", ExtValue: "1"}, &out)
	if err != nil || out.Title != "Heat" || res.Cached || res.RecordID == "" {
		t.Fatalf("first = %+v %v %v", res, out, err)
	}
	res, err = c.Do(ctx, "tmdb", Request{URL: srv.URL + "/movie/1"})
	if err != nil || !res.Cached || hits != 1 {
		t.Fatalf("cached = %+v hits %d %v", res, hits, err)
	}
	now = now.Add(2 * time.Hour)
	res, err = c.Do(ctx, "tmdb", Request{URL: srv.URL + "/movie/1"})
	if err != nil || res.Cached || hits != 2 || string(res.Body) != `{"title":"Heat"}` || res.RecordID != "1" {
		t.Fatalf("revalidated = %+v hits %d %v", res, hits, err)
	}
	if len(rec.records) != 1 || !rec.records[0].FetchedAt.Equal(now) {
		t.Fatalf("records = %+v", rec.records)
	}
	if h, _ := c.State("tmdb"); h.Calls != 2 || h.Breaker != "closed" || !h.LastOK.Equal(now) {
		t.Fatalf("health = %+v", h)
	}
}

func TestBudgetAndRollover(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer srv.Close()
	rec := newMem()
	rec.calls["tvdb"], rec.resets["tvdb"] = 1, time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	c := newClient(t, rec)
	now := time.Date(2026, 11, 8, 23, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	c.Register(Policy{Name: "tvdb", Budget: 2})
	ctx := context.Background()
	if _, err := c.Do(ctx, "tvdb", Request{URL: srv.URL + "/a", NoRecord: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Do(ctx, "tvdb", Request{URL: srv.URL + "/b", NoRecord: true}); !errors.Is(err, ErrBudget) {
		t.Fatalf("over budget = %v", err)
	}
	now = now.Add(2 * time.Hour)
	if _, err := c.Do(ctx, "tvdb", Request{URL: srv.URL + "/c", NoRecord: true}); err != nil {
		t.Fatalf("after rollover = %v", err)
	}
	if rec.calls["tvdb"] != 1 || len(rec.records) != 0 {
		t.Fatalf("calls %d records %d", rec.calls["tvdb"], len(rec.records))
	}
}

func TestBreakerOpensOnServerErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	rec := newMem()
	c := newClient(t, rec)
	c.Register(Policy{Name: "trakt"})
	ctx := context.Background()
	_, err := c.Do(ctx, "trakt", Request{URL: srv.URL + "/missing"})
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 404 || Transient(err) {
		t.Fatalf("404 = %v", err)
	}
	for range 5 {
		if _, err := c.Do(ctx, "trakt", Request{URL: srv.URL + "/down"}); !Transient(err) {
			t.Fatalf("502 = %v", err)
		}
	}
	if _, err := c.Do(ctx, "trakt", Request{URL: srv.URL + "/down"}); !errors.Is(err, ErrOpen) {
		t.Fatalf("open = %v", err)
	}
	if h, _ := c.State("trakt"); h.Breaker != "open" || h.LastError == "" {
		t.Fatalf("health = %+v", h)
	}
	if len(rec.records) != 1 || rec.records[0].Status != 404 {
		t.Fatalf("records = %d", len(rec.records))
	}
	if _, err := c.Do(ctx, "nope", Request{URL: srv.URL}); !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("unknown = %v", err)
	}
}

func TestStreamCountsAndFailsClosed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/gone" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		for range 3 {
			_, _ = w.Write([]byte("chunk-"))
		}
	}))
	defer srv.Close()
	rec := newMem()
	c := newClient(t, rec)
	c.Register(Policy{Name: "imdb-datasets", Budget: 5})
	ctx := context.Background()
	res, err := c.Stream(ctx, "imdb-datasets", Request{URL: srv.URL + "/file"})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != "chunk-chunk-chunk-" || len(rec.records) != 0 || rec.calls["imdb-datasets"] != 1 {
		t.Fatalf("stream = %q records %d calls %d", body, len(rec.records), rec.calls["imdb-datasets"])
	}
	_, err = c.Stream(ctx, "imdb-datasets", Request{URL: srv.URL + "/gone"})
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 404 {
		t.Fatalf("404 = %v", err)
	}
}

func TestRedactKeepsSecretsOutOfRecordsAndErrors(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Query().Get("api_key") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"status_message":"Invalid API key"}`))
			return
		}
		if r.URL.Path == "/broken" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"title":"Heat"}`))
	}))
	defer srv.Close()
	rec := newMem()
	c := newClient(t, rec)
	c.Register(Policy{Name: "tmdb", CacheTTL: time.Hour})
	ctx := context.Background()
	var out struct{ Title string }
	res, err := c.GetJSON(ctx, "tmdb", Request{URL: srv.URL + "/movie/1?api_key=SECRET1&language=en", Redact: []string{"api_key"}}, &out)
	if err != nil || out.Title != "Heat" || res.URL != srv.URL+"/movie/1?language=en" {
		t.Fatalf("first = %+v %v", res, err)
	}
	if len(rec.records) != 1 || rec.records[0].URL != srv.URL+"/movie/1?language=en" {
		t.Fatalf("stored url = %+v", rec.records)
	}
	res, err = c.Do(ctx, "tmdb", Request{URL: srv.URL + "/movie/1?api_key=SECRET2&language=en", Redact: []string{"api_key"}})
	if err != nil || !res.Cached || hits != 1 {
		t.Fatalf("second key did not share the cache = %+v hits %d %v", res, hits, err)
	}
	_, err = c.Do(ctx, "tmdb", Request{URL: srv.URL + "/broken?api_key=SECRET3", Redact: []string{"api_key"}})
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 404 || se.URL != srv.URL+"/broken" || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("status error = %v", err)
	}
	for _, r := range rec.records {
		if strings.Contains(r.URL, "SECRET") {
			t.Fatalf("record leaked a key: %s", r.URL)
		}
	}
	if _, err := c.Do(ctx, "tmdb", Request{URL: "://bad", Redact: []string{"api_key"}}); err == nil {
		t.Fatal("unparseable url accepted")
	}
}
