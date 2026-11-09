package fanart

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
)

type memRecorder struct {
	mu      sync.Mutex
	records []*outbound.Record
}

func (m *memRecorder) Latest(_ context.Context, source, u string) (*outbound.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range slices.Backward(m.records) {
		if r.Source == source && r.URL == u {
			return r, nil
		}
	}
	return nil, nil
}

func (m *memRecorder) Save(_ context.Context, r *outbound.Record) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.ID = strconv.Itoa(len(m.records) + 1)
	m.records = append(m.records, r)
	return r.ID, nil
}

func (m *memRecorder) Touch(context.Context, string, time.Time) error { return nil }

func (m *memRecorder) LoadCalls(context.Context, string) (int, time.Time, error) {
	return 0, time.Time{}, nil
}

func (m *memRecorder) StoreCalls(context.Context, string, int, time.Time) error { return nil }

func (m *memRecorder) Health(context.Context, string, bool, string, time.Time) error { return nil }

// Returns the latest stored record whose URL has the given path
func (m *memRecorder) byPath(t *testing.T, path string) *outbound.Record {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range slices.Backward(m.records) {
		u, err := url.Parse(r.URL)
		if err == nil && u.Path == path {
			return r
		}
	}
	t.Fatalf("no record for %s", path)
	return nil
}

// Sends every request to the test server, keeping the original host in the Host header
type rewrite struct{ target *url.URL }

func (rw rewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	out := r.Clone(r.Context())
	out.Host = r.URL.Host
	out.URL.Scheme, out.URL.Host = rw.target.Scheme, rw.target.Host
	return http.DefaultTransport.RoundTrip(out)
}

type server struct {
	mu       sync.Mutex
	requests []*http.Request
}

func (s *server) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func (s *server) last() *http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests[len(s.requests)-1]
}

const movie603 = `{"name":"The Matrix","tmdb_id":"603","imdb_id":"tt0133093",
"hdmovielogo":[{"id":"1001","url":"https://assets.fanart.tv/fanart/movies/603/hdmovielogo/the-matrix-5226b1c8bfa7f.png","lang":"en","likes":"12"},{"id":"1002","url":"https://assets.fanart.tv/fanart/movies/603/hdmovielogo/the-matrix-ru.png","lang":"ru","likes":"30"}],
"movielogo":[{"id":"1003","url":"https://assets.fanart.tv/fanart/movies/603/movielogo/the-matrix-4f9b1.png","lang":"en","likes":"2"}],
"movieposter":[{"id":"1004","url":"https://assets.fanart.tv/fanart/movies/603/movieposter/the-matrix-52b8.jpg","lang":"en","likes":"7"},{"id":"1005","url":"https://assets.fanart.tv/fanart/movies/603/movieposter/the-matrix-textless.jpg","lang":"00","likes":"3"}],
"moviebackground":[{"id":"1006","url":"https://assets.fanart.tv/fanart/movies/603/moviebackground/the-matrix-5.jpg","lang":"","likes":0}],
"moviebanner":[{"id":"1007","url":"https://assets.fanart.tv/fanart/movies/603/moviebanner/the-matrix-banner.jpg","lang":"en","likes":"1"}],
"moviethumb":[{"id":"1008","url":"https://assets.fanart.tv/fanart/movies/603/moviethumb/the-matrix-thumb.jpg","lang":"en","likes":"4"}],
"moviedisc":[{"id":"1009","url":"https://assets.fanart.tv/fanart/movies/603/moviedisc/the-matrix-disc.png","lang":"en","likes":"1","disc":"1","disc_type":"bluray"}]}`

const tv81189 = `{"name":"Breaking Bad","thetvdb_id":"81189",
"hdtvlogo":[{"id":"2001","url":"https://assets.fanart.tv/fanart/tv/81189/hdtvlogo/breaking-bad-4fec3.png","lang":"en","likes":"20"}],
"clearlogo":[{"id":"2002","url":"https://assets.fanart.tv/fanart/tv/81189/clearlogo/breaking-bad-4e7.png","lang":"en","likes":"5"}],
"tvposter":[{"id":"2003","url":"https://assets.fanart.tv/fanart/tv/81189/tvposter/breaking-bad-5.jpg","lang":"en","likes":"9"}],
"showbackground":[{"id":"2004","url":"https://assets.fanart.tv/fanart/tv/81189/showbackground/breaking-bad-1.jpg","lang":"","likes":"15","season":"all"}],
"tvbanner":[{"id":"2005","url":"https://assets.fanart.tv/fanart/tv/81189/tvbanner/breaking-bad-b.jpg","lang":"en","likes":"3"}],
"tvthumb":[{"id":"2006","url":"https://assets.fanart.tv/fanart/tv/81189/tvthumb/breaking-bad-t.jpg","lang":"en","likes":"2"}],
"seasonposter":[{"id":"2007","url":"https://assets.fanart.tv/fanart/tv/81189/seasonposter/breaking-bad-s1.jpg","lang":"en","likes":"1","season":"1"}]}`

func newSource(t *testing.T, key string) (*Source, *memRecorder, *server) {
	t.Helper()
	log := &server{}
	routes := map[string]string{"/v3/movies/603": movie603, "/v3/movies/tt0133093": movie603, "/v3/tv/81189": tv81189}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.mu.Lock()
		log.requests = append(log.requests, r)
		log.mu.Unlock()
		if r.Host != "webservice.fanart.tv" {
			t.Errorf("host = %s", r.Host)
		}
		if r.URL.Query().Get("api_key") != "project-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"status":"error","error message":"Invalid API key"}`))
			return
		}
		body, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"status":"error","error message":"Not found"}`))
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	rec := &memRecorder{}
	client := outbound.New(rec, "DiscoFlix/test", slog.New(slog.DiscardHandler))
	client.SetHTTPClient(&http.Client{Transport: rewrite{target: target}})
	src := New(client, key)
	client.Register(src.Policy())
	return src, rec, log
}

func configure(t *testing.T, s *Source) {
	t.Helper()
	if err := s.Configure(map[string]string{"language": "en"}); err != nil {
		t.Fatal(err)
	}
}

// Indexes the claims of one group by field
func fields(t *testing.T, claims []model.Claim, kind, namespace, id string) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, c := range claims {
		if c.Kind != kind || c.Namespace != namespace || c.ExternalID != id {
			t.Fatalf("claim outside the looked up record %+v", c)
		}
		if c.RecordID == "" {
			t.Fatalf("claim without record %+v", c)
		}
		out[c.Field] = c.Value
	}
	return out
}

func urls(images []model.Image) []string {
	out := make([]string, 0, len(images))
	for _, img := range images {
		out = append(out, img.URL)
	}
	return out
}

func TestMovieByTMDB(t *testing.T) {
	src, rec, log := newSource(t, "project-key")
	configure(t, src)
	claims, err := src.Lookup(context.Background(), model.KindMovie, model.NSTMDB, "movie/603")
	if err != nil {
		t.Fatal(err)
	}
	if q := log.last().URL.Query(); len(q) != 1 || q.Get("api_key") != "project-key" || log.last().URL.Path != "/v3/movies/603" {
		t.Fatalf("request = %v", log.last().URL)
	}
	if stored := rec.byPath(t, "/v3/movies/603").URL; strings.Contains(stored, "project-key") {
		t.Fatalf("stored url keeps a key: %s", stored)
	}
	f := fields(t, claims, model.KindMovie, model.NSTMDB, "movie/603")
	if f[model.XIDField("imdb")] != "tt0133093" || f[model.XIDField("tmdb")] != "movie/603" {
		t.Fatalf("ids = %v", f)
	}
	posters := f[model.ArtworkField("poster")].([]model.Image)
	if len(posters) != 2 || posters[0].Language != "en" || posters[1].Language != "" || posters[0].Score <= posters[1].Score || posters[0].Score != 10*7.0/12 {
		t.Fatalf("posters = %+v", posters)
	}
	logos := urls(f[model.ArtworkField("logo")].([]model.Image))
	if !slices.Equal(logos, []string{"https://assets.fanart.tv/fanart/movies/603/hdmovielogo/the-matrix-5226b1c8bfa7f.png", "https://assets.fanart.tv/fanart/movies/603/movielogo/the-matrix-4f9b1.png"}) {
		t.Fatalf("logos = %v", logos)
	}
	if b := f[model.ArtworkField("backdrop")].([]model.Image); len(b) != 1 || b[0].Score != 0 {
		t.Fatalf("backdrops = %+v", b)
	}
	for _, kind := range []string{"banner", "thumb"} {
		if imgs, ok := f[model.ArtworkField(kind)].([]model.Image); !ok || len(imgs) != 1 {
			t.Fatalf("%s = %v", kind, f[model.ArtworkField(kind)])
		}
	}
	if r := rec.byPath(t, "/v3/movies/603"); r.Namespace != "tmdb" || r.ExtValue != "movie/603" || r.Kind != model.KindMovie || r.License != license {
		t.Fatalf("provenance = %+v", r)
	}
}

func TestMovieByIMDbAndSeriesByTVDB(t *testing.T) {
	src, rec, log := newSource(t, "project-key")
	configure(t, src)
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	if f := fields(t, claims, model.KindMovie, model.NSIMDb, "tt0133093"); f[model.XIDField("tmdb")] != "movie/603" {
		t.Fatalf("imdb movie = %v", f)
	}
	if q := log.last().URL.Query(); len(q) != 1 || q.Get("api_key") != "project-key" {
		t.Fatalf("query = %v", q)
	}
	claims, err = src.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/81189")
	if err != nil {
		t.Fatal(err)
	}
	f := fields(t, claims, model.KindSeries, model.NSTVDB, "series/81189")
	if logos := f[model.ArtworkField("logo")].([]model.Image); len(logos) != 2 || logos[0].Score != 10*20.0/25 {
		t.Fatalf("logos = %+v", logos)
	}
	if b := f[model.ArtworkField("backdrop")].([]model.Image); len(b) != 1 || b[0].URL != "https://assets.fanart.tv/fanart/tv/81189/showbackground/breaking-bad-1.jpg" {
		t.Fatalf("backdrops = %+v", b)
	}
	for _, kind := range []string{"poster", "banner", "thumb"} {
		if imgs, ok := f[model.ArtworkField(kind)].([]model.Image); !ok || len(imgs) != 1 {
			t.Fatalf("%s = %v", kind, f[model.ArtworkField(kind)])
		}
	}
	if _, ok := f[model.XIDField("tmdb")]; ok {
		t.Fatal("series carries a tmdb id the response does not report")
	}
	if r := rec.byPath(t, "/v3/tv/81189"); r.Namespace != "tvdb" || r.ExtValue != "series/81189" || r.Kind != model.KindSeries {
		t.Fatalf("provenance = %+v", r)
	}
}

func TestUnsupportedNeverCalls(t *testing.T) {
	src, _, log := newSource(t, "project-key")
	ctx := context.Background()
	configure(t, src)
	if _, err := src.Search(ctx, "", "The Matrix", 1999); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("search = %v", err)
	}
	if _, err := src.Search(ctx, model.KindMovie, "The Matrix", 1999); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("search = %v", err)
	}
	unsupported := [][3]string{
		{model.KindSeries, model.NSTMDB, "tv/1396"},
		{model.KindSeries, model.NSIMDb, "tt0903747"},
		{model.KindMovie, model.NSTVDB, "movie/12"},
		{model.KindSeason, model.NSTVDB, "season/30272"},
		{model.KindMovie, model.NSWikidata, "Q83495"},
	}
	for _, u := range unsupported {
		if _, err := src.Lookup(ctx, u[0], u[1], u[2]); !errors.Is(err, catalog.ErrUnsupported) {
			t.Fatalf("%v = %v", u, err)
		}
	}
	mismatched := [][3]string{
		{model.KindMovie, model.NSTMDB, "tv/1396"},
		{model.KindSeries, model.NSTMDB, "tv/1396/1/2"},
		{model.KindSeries, model.NSTVDB, "episode/349232"},
	}
	for _, m := range mismatched {
		if claims, err := src.Lookup(ctx, m[0], m[1], m[2]); err != nil || claims != nil {
			t.Fatalf("%v = %v %v", m, claims, err)
		}
	}
	for _, bad := range []string{"movie/abc", "tv", "film/603"} {
		if _, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, bad); err == nil || errors.Is(err, catalog.ErrUnsupported) {
			t.Fatalf("malformed %q = %v", bad, err)
		}
	}
	if log.count() != 0 {
		t.Fatalf("calls = %d", log.count())
	}
}

func TestNotFoundAndRejectedKey(t *testing.T) {
	src, rec, _ := newSource(t, "project-key")
	ctx := context.Background()
	configure(t, src)
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/999999")
	if err != nil || claims != nil {
		t.Fatalf("404 = %v %v", claims, err)
	}
	if r := rec.byPath(t, "/v3/movies/999999"); r.Status != http.StatusNotFound || r.ExtValue != "movie/999999" {
		t.Fatalf("404 record = %+v", r)
	}
	rejected, _, _ := newSource(t, "revoked")
	var se *outbound.StatusError
	if _, err := rejected.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/81189"); !errors.As(err, &se) || se.Status != http.StatusUnauthorized {
		t.Fatalf("401 = %v", err)
	}
}
