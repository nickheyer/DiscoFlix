package trakt

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
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

func (s *server) last(path string) *http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range slices.Backward(s.requests) {
		if r.URL.Path == path {
			return r
		}
	}
	return nil
}

func (s *server) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func newSource(t *testing.T, routes map[string]string) (*Source, *memRecorder, *server) {
	t.Helper()
	log := &server{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.mu.Lock()
		log.requests = append(log.requests, r)
		log.mu.Unlock()
		if r.Host != "api.trakt.tv" {
			t.Errorf("host = %s", r.Host)
		}
		if r.Header.Get("trakt-api-key") != "client-id" || r.Header.Get("trakt-api-version") != "2" || r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		body, ok := routes[r.URL.Path]
		switch {
		case !ok:
			w.WriteHeader(http.StatusNotFound)
		case body == "500":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		}
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	rec := &memRecorder{}
	client := outbound.New(rec, "DiscoFlix/test", slog.New(slog.DiscardHandler))
	client.SetHTTPClient(&http.Client{Transport: rewrite{target: target}})
	src := New(client)
	client.Register(src.Policy())
	return src, rec, log
}

func configure(t *testing.T, s *Source, lang string) {
	t.Helper()
	if err := s.Configure(catalog.Keys{APIKey: "client-id"}, map[string]string{"language": lang}); err != nil {
		t.Fatal(err)
	}
}

// Indexes claims by kind and external id, then by field
func groups(claims []model.Claim) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, c := range claims {
		key := c.Kind + " " + c.ExternalID
		if out[key] == nil {
			out[key] = map[string]any{}
		}
		out[key][c.Field] = c.Value
	}
	return out
}

const matrix = `{"title":"The Matrix","year":1999,"ids":{"trakt":481,"slug":"the-matrix-1999","imdb":"tt0133093","tmdb":603},"tagline":"Welcome to the Real World.","overview":"A hacker learns the truth.","released":"1999-03-31","runtime":136,"country":"us","trailer":null,"homepage":"http://www.warnerbros.com/matrix","status":"released","rating":8.7,"votes":61000,"comment_count":120,"updated_at":"2026-10-01T09:00:00.000Z","language":"en","languages":["en"],"available_translations":["en","es","fr"],"genres":["action","science-fiction"],"certification":"R"}`

const breakingBad = `{"title":"Breaking Bad","year":2008,"ids":{"trakt":1388,"slug":"breaking-bad","tvdb":81189,"imdb":"tt0903747","tmdb":1396,"tvrage":null},"overview":"A chemistry teacher turns to crime.","first_aired":"2008-01-21T02:00:00.000Z","airs":{"day":"Sunday","time":"21:00","timezone":"America/New_York"},"runtime":45,"certification":"TV-MA","network":"AMC","country":"us","trailer":null,"homepage":"http://www.amc.com/shows/breaking-bad","status":"ended","rating":9.3,"votes":90000,"language":"en","languages":["en"],"available_translations":["en","es"],"genres":["drama","crime"],"aired_episodes":62}`

const seasons = `[{"number":0,"ids":{"trakt":3962,"tvdb":439371,"tmdb":3577,"tvrage":null},"rating":7.1,"votes":100,"episode_count":1,"aired_episodes":1,"title":"Specials","overview":null,"first_aired":"2009-02-18T02:00:00.000Z","network":"AMC","episodes":[{"season":0,"number":1,"title":"Good Cop / Bad Cop","ids":{"trakt":62082,"tvdb":1232082,"imdb":null,"tmdb":62082,"tvrage":null},"overview":"A minisode.","rating":6.5,"votes":20,"first_aired":"2009-02-18T02:00:00.000Z","runtime":3}]},
{"number":1,"ids":{"trakt":3950,"tvdb":30272,"tmdb":3572,"tvrage":null},"rating":8.6,"votes":3000,"episode_count":2,"aired_episodes":2,"title":"Season 1","overview":"High school chemistry teacher.","first_aired":"2008-01-21T02:00:00.000Z","network":"AMC","episodes":[{"season":1,"number":1,"title":"Pilot","ids":{"trakt":73482,"tvdb":349232,"imdb":"tt0959621","tmdb":62085,"tvrage":null},"overview":"Walter is diagnosed.","rating":8.4,"votes":9000,"first_aired":"2008-01-21T02:00:00.000Z","runtime":58,"translations":[{"title":"Piloto","overview":"Walter recibe un diagnóstico.","language":"es"}]},{"season":1,"number":2,"title":"Cat's in the Bag...","ids":{"trakt":73483,"tvdb":349235,"imdb":"tt1054724","tmdb":62086,"tvrage":null},"overview":"Walt and Jesse clean up.","rating":8.1,"votes":7000,"first_aired":"2008-01-28T02:00:00.000Z","runtime":48,"translations":[]}]}]`

func routes() map[string]string {
	return map[string]string{
		"/search/movie,show":          `[{"type":"movie","score":1000,"movie":` + matrix + `},{"type":"show","score":420,"show":` + breakingBad + `}]`,
		"/movies/the-matrix-1999":     matrix,
		"/shows/breaking-bad":         breakingBad,
		"/shows/1388/seasons":         seasons,
		"/search/imdb/tt0133093":      `[{"type":"movie","score":null,"movie":` + matrix + `}]`,
		"/search/imdb/tt9999999":      `[]`,
		"/search/tmdb/1396":           `[{"type":"show","score":null,"show":` + breakingBad + `}]`,
		"/search/tvdb/81189":          `[{"type":"show","score":null,"show":` + breakingBad + `}]`,
		"/search/trakt/73482":         `[{"type":"episode","score":null,"episode":{"season":1,"number":1,"title":"Pilot","ids":{"trakt":73482,"tvdb":349232,"imdb":"tt0959621","tmdb":62085}},"show":` + breakingBad + `}]`,
		"/movies/481/translations/es": `[{"title":"Matrix","overview":"Un hacker descubre la verdad.","tagline":"Bienvenido al mundo real.","language":"es","country":"es"},{"title":"Matrix (MX)","overview":"Un hacker conoce la verdad.","tagline":"","language":"es","country":"mx"}]`,
		"/shows/1388/translations/es": `[{"title":"Breaking Bad: Hasta el fin","overview":"Un maestro de química.","tagline":null,"language":"es","country":"es"}]`,
		"/search/show":                "500",
	}
}

func TestSearch(t *testing.T) {
	src, rec, log := newSource(t, routes())
	configure(t, src, "en")
	claims, err := src.Search(context.Background(), "", "matrix", 1999)
	if err != nil {
		t.Fatal(err)
	}
	q := log.last("/search/movie,show").URL.Query()
	if q.Get("query") != "matrix" || q.Get("years") != "1999" || q.Get("extended") != "full" {
		t.Fatalf("query = %v", q)
	}
	g := groups(claims)
	m := g["movie movie/the-matrix-1999"]
	if m[model.FieldTitle] != "The Matrix" || m[model.FieldYear] != 1999 || m[model.RatingField("trakt")] != 8.7 || m[model.VotesField("trakt")] != 61000 || m[model.XIDField("trakt")] != "movie/481" || m[model.XIDField("tmdb")] != "movie/603" || m[model.XIDField("imdb")] != "tt0133093" || m[model.FieldCertification] != "R" {
		t.Fatalf("movie = %v", m)
	}
	if gs := m[model.FieldGenres].([]string); !slices.Equal(gs, []string{"Action", "Science Fiction"}) {
		t.Fatalf("genres = %v", gs)
	}
	if c := m[model.FieldCountries].([]string); !slices.Equal(c, []string{"US"}) {
		t.Fatalf("countries = %v", c)
	}
	s := g["series show/breaking-bad"]
	if s[model.FieldFirstAirDate] != "2008-01-20" || s[model.XIDField("tvdb")] != "series/81189" || s[model.XIDField("tmdb")] != "tv/1396" || s[model.XIDField("trakt")] != "show/1388" || s[model.FieldEpisodeCount] != 62 {
		t.Fatalf("show = %v", s)
	}
	if r := rec.byPath(t, "/search/movie,show"); r.Namespace != "trakt" {
		t.Fatalf("provenance = %+v", r)
	}
	if _, err := src.Search(context.Background(), model.KindSeries, "breaking bad", 0); err == nil || !outbound.Transient(err) {
		t.Fatalf("500 search = %v", err)
	}
	if _, err := src.Search(context.Background(), model.KindEpisode, "pilot", 0); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("episode search = %v", err)
	}
}

func TestLookupShowEmitsSeasonsAndEpisodes(t *testing.T) {
	src, rec, log := newSource(t, routes())
	configure(t, src, "en")
	claims, err := src.Lookup(context.Background(), model.KindSeries, model.NSTrakt, "show/breaking-bad")
	if err != nil {
		t.Fatal(err)
	}
	if q := log.last("/shows/1388/seasons").URL.Query(); q.Get("extended") != "full,episodes" || q.Has("translations") {
		t.Fatalf("seasons query = %v", q)
	}
	g := groups(claims)
	if len(g) != 6 {
		t.Fatalf("groups = %d %v", len(g), g)
	}
	show := g["series show/breaking-bad"]
	if show[model.FieldSeasonCount] != 1 || show[model.FieldStatus] != "ended" {
		t.Fatalf("show = %v", show)
	}
	if n := show[model.FieldNetworks].([]string); !slices.Equal(n, []string{"AMC"}) {
		t.Fatalf("networks = %v", n)
	}
	first := g["season season/3950"]
	if first[model.ParentXIDField("trakt")] != "show/breaking-bad" || first[model.FieldOrdinal] != 1 || first[model.XIDField("tvdb")] != "season/30272" || first[model.XIDField("tmdb")] != "tv/1396/1" || first[model.FieldAirDate] != "2008-01-20" || first[model.FieldEpisodeCount] != 2 {
		t.Fatalf("season 1 = %v", first)
	}
	if specials := g["season season/3962"]; specials[model.FieldOrdinal] != 0 {
		t.Fatalf("specials = %v", specials)
	}
	pilot := g["episode episode/73482"]
	if pilot[model.ParentXIDField("trakt")] != "season/3950" || pilot[model.FieldOrdinal] != 1 || pilot[model.FieldTitle] != "Pilot" || pilot[model.XIDField("tmdb")] != "tv/1396/1/1" || pilot[model.XIDField("tvdb")] != "episode/349232" || pilot[model.XIDField("imdb")] != "tt0959621" || pilot[model.FieldRuntime] != 58 || pilot[model.FieldAirDate] != "2008-01-20" {
		t.Fatalf("pilot = %v", pilot)
	}
	if r := rec.byPath(t, "/shows/breaking-bad"); r.Namespace != "trakt" || r.ExtValue != "show/breaking-bad" || r.Kind != model.KindSeries {
		t.Fatalf("provenance = %+v", r)
	}
	if r := rec.byPath(t, "/shows/1388/seasons"); r.ExtValue != "show/breaking-bad" || r.Kind != model.KindSeason {
		t.Fatalf("seasons provenance = %+v", r)
	}
}

func TestLookupForeignIDs(t *testing.T) {
	src, rec, log := newSource(t, routes())
	configure(t, src, "en")
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	if m := groups(claims)["movie movie/the-matrix-1999"]; m[model.FieldTitle] != "The Matrix" {
		t.Fatalf("imdb movie = %v", groups(claims))
	}
	if q := log.last("/search/imdb/tt0133093").URL.Query(); q.Get("type") != "movie" || q.Get("extended") != "full" {
		t.Fatalf("id search query = %v", q)
	}
	if r := rec.byPath(t, "/search/imdb/tt0133093"); r.Namespace != "imdb" || r.ExtValue != "tt0133093" || r.Kind != model.KindMovie {
		t.Fatalf("provenance = %+v", r)
	}
	claims, err = src.Lookup(ctx, model.KindSeason, model.NSTMDB, "tv/1396/1")
	if err != nil {
		t.Fatal(err)
	}
	g := groups(claims)
	if len(g) != 3 || g["season season/3950"][model.FieldOrdinal] != 1 || g["episode episode/73483"][model.ParentXIDField("trakt")] != "season/3950" {
		t.Fatalf("tmdb season = %v", g)
	}
	claims, err = src.Lookup(ctx, model.KindEpisode, model.NSTMDB, "tv/1396/1/2")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); len(g) != 1 || g["episode episode/73483"][model.XIDField("imdb")] != "tt1054724" {
		t.Fatalf("tmdb episode = %v", g)
	}
	claims, err = src.Lookup(ctx, model.KindEpisode, model.NSTrakt, "episode/73482")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); len(g) != 1 || g["episode episode/73482"][model.ParentXIDField("trakt")] != "season/3950" {
		t.Fatalf("trakt episode = %v", g)
	}
	if q := log.last("/search/trakt/73482").URL.Query(); q.Get("type") != "episode" {
		t.Fatalf("episode search query = %v", q)
	}
	claims, err = src.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/81189")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["series show/breaking-bad"][model.XIDField("imdb")] != "tt0903747" {
		t.Fatalf("tvdb show = %v", g)
	}
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt9999999"); err != nil || claims != nil {
		t.Fatalf("unknown imdb = %v %v", claims, err)
	}
	before := log.count()
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, "tv/1396"); err != nil || claims != nil {
		t.Fatalf("kind mismatch = %v %v", claims, err)
	}
	if _, err := src.Lookup(ctx, model.KindSeason, model.NSTrakt, "season/3950"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("season by trakt id = %v", err)
	}
	if log.count() != before {
		t.Fatal("rejected lookups reached the network")
	}
}

func TestTranslations(t *testing.T) {
	src, rec, log := newSource(t, routes())
	configure(t, src, "es-MX")
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSTrakt, "movie/the-matrix-1999")
	if err != nil {
		t.Fatal(err)
	}
	m := groups(claims)["movie movie/the-matrix-1999"]
	if m[model.FieldTitle] != "Matrix (MX)" || m[model.FieldOverview] != "Un hacker conoce la verdad." || m[model.FieldTagline] != "Welcome to the Real World." {
		t.Fatalf("translated movie = %v", m)
	}
	if a := m[model.FieldAliases].([]string); !slices.Equal(a, []string{"The Matrix"}) {
		t.Fatalf("aliases = %v", a)
	}
	tr := rec.byPath(t, "/movies/481/translations/es")
	for _, c := range claims {
		if c.Field == model.FieldTitle && c.RecordID != tr.ID {
			t.Fatalf("title record = %s, want %s", c.RecordID, tr.ID)
		}
	}
	claims, err = src.Lookup(ctx, model.KindSeries, model.NSTrakt, "show/breaking-bad")
	if err != nil {
		t.Fatal(err)
	}
	if q := log.last("/shows/1388/seasons").URL.Query(); q.Get("translations") != "es" {
		t.Fatalf("seasons query = %v", q)
	}
	g := groups(claims)
	if g["series show/breaking-bad"][model.FieldTitle] != "Breaking Bad: Hasta el fin" || g["episode episode/73482"][model.FieldTitle] != "Piloto" || g["episode episode/73483"][model.FieldTitle] != "Cat's in the Bag..." {
		t.Fatalf("translated show = %v", g)
	}
}

func TestMissingKeyFailsBeforeCalling(t *testing.T) {
	src, _, log := newSource(t, routes())
	if _, err := src.Lookup(context.Background(), model.KindMovie, model.NSTrakt, "movie/the-matrix-1999"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("lookup = %v", err)
	}
	if _, err := src.Search(context.Background(), "", "matrix", 0); !errors.Is(err, ErrNoKey) {
		t.Fatalf("search = %v", err)
	}
	if log.count() != 0 {
		t.Fatalf("calls = %d", log.count())
	}
}

func TestNotFoundAndErrors(t *testing.T) {
	src, rec, _ := newSource(t, routes())
	configure(t, src, "en")
	ctx := context.Background()
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSTrakt, "movie/no-such-movie"); err != nil || claims != nil {
		t.Fatalf("404 lookup = %v %v", claims, err)
	}
	if r := rec.byPath(t, "/movies/no-such-movie"); r.Status != http.StatusNotFound {
		t.Fatalf("404 record = %+v", r)
	}
	if err := src.Configure(catalog.Keys{APIKey: "revoked"}, nil); err != nil {
		t.Fatal(err)
	}
	var se *outbound.StatusError
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSTrakt, "movie/the-matrix-1999"); !errors.As(err, &se) || se.Status != http.StatusForbidden {
		t.Fatalf("revoked key = %v", err)
	}
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSTrakt, "film/481"); err == nil {
		t.Fatal("malformed trakt id accepted")
	}
}
