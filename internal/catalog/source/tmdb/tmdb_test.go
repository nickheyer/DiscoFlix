package tmdb

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

// Returns the stored record whose URL has the given path
func (m *memRecorder) byPath(t *testing.T, path string) *outbound.Record {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.records {
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

func newSource(t *testing.T, routes map[string]string) (*Source, *memRecorder, *server) {
	t.Helper()
	log := &server{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.mu.Lock()
		log.requests = append(log.requests, r)
		log.mu.Unlock()
		if r.Host != "api.themoviedb.org" {
			t.Errorf("host = %s", r.Host)
		}
		body, ok := routes[r.URL.Path]
		switch {
		case !ok:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"success":false,"status_code":34,"status_message":"The resource you requested could not be found."}`))
		case body == "401":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"success":false,"status_code":7,"status_message":"Invalid API key"}`))
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

func configure(t *testing.T, s *Source, key string) {
	t.Helper()
	if err := s.Configure(catalog.Keys{APIKey: key}, map[string]string{"language": "en"}); err != nil {
		t.Fatal(err)
	}
}

const searchMovie = `{"page":1,"results":[{"adult":false,"backdrop_path":"/back.jpg","genre_ids":[28,878],"id":603,"original_language":"en","original_title":"The Matrix","overview":"A hacker learns the truth.","popularity":81.5,"poster_path":"/poster.jpg","release_date":"1999-03-31","title":"The Matrix","video":false,"vote_average":8.2,"vote_count":26000}],"total_pages":1,"total_results":1}`

const searchTV = `{"page":1,"results":[{"id":1396,"name":"Breaking Bad","original_name":"Breaking Bad","first_air_date":"2008-01-20","origin_country":["US"],"original_language":"en","overview":"A teacher turns to crime.","popularity":300.1,"poster_path":"/bb.jpg","vote_average":8.9,"vote_count":14000}],"total_pages":1,"total_results":1}`

const movie603 = `{"id":603,"imdb_id":"tt0133093","title":"The Matrix","original_title":"The Matrix","release_date":"1999-03-31","overview":"A hacker learns the truth.","tagline":"Welcome to the Real World.","runtime":136,"genres":[{"id":28,"name":"Action"},{"id":878,"name":"Science Fiction"}],"status":"Released","original_language":"en","origin_country":["US"],"production_countries":[{"iso_3166_1":"US","name":"United States of America"}],"homepage":"https://www.warnerbros.com/movies/matrix","popularity":81.5,"vote_average":8.2,"vote_count":26000,"poster_path":"/primary.jpg","backdrop_path":"/back1.jpg","belongs_to_collection":{"id":2344,"name":"The Matrix Collection"},
"external_ids":{"imdb_id":"tt0133093","wikidata_id":"Q83495","facebook_id":"TheMatrixMovie"},
"images":{"posters":[{"file_path":"/primary.jpg","width":2000,"height":3000,"iso_639_1":"en","vote_average":5.6,"vote_count":12}],"backdrops":[{"file_path":"/back1.jpg","width":3840,"height":2160,"iso_639_1":null,"vote_average":5.4,"vote_count":3}],"logos":[{"file_path":"/logo.svg","width":800,"height":300,"iso_639_1":"en","vote_average":0,"vote_count":0}]},
"credits":{"cast":[{"name":"Keanu Reeves","character":"Neo","order":0,"profile_path":"/keanu.jpg"},{"name":"Laurence Fishburne","character":"Morpheus","order":1,"profile_path":null}],"crew":[{"name":"Lilly Wachowski","job":"Director","department":"Directing"},{"name":"Lilly Wachowski","job":"Writer","department":"Writing"},{"name":"Bill Pope","job":"Director of Photography","department":"Camera"}]},
"keywords":{"keywords":[{"id":310,"name":"artificial intelligence"},{"id":4565,"name":"dystopia"}]},
"release_dates":{"results":[{"iso_3166_1":"DE","release_dates":[{"certification":"16","type":3}]},{"iso_3166_1":"US","release_dates":[{"certification":"","type":1},{"certification":"R","type":3}]}]},
"alternative_titles":{"titles":[{"iso_3166_1":"FR","title":"Matrix","type":""},{"iso_3166_1":"US","title":"The Matrix","type":""}]}}`

const tv1396 = `{"id":1396,"name":"Breaking Bad","original_name":"Breaking Bad","first_air_date":"2008-01-20","last_air_date":"2013-09-29","overview":"A teacher turns to crime.","tagline":"Remember my name","episode_run_time":[47],"genres":[{"id":18,"name":"Drama"},{"id":80,"name":"Crime"}],"status":"Ended","original_language":"en","origin_country":["US"],"homepage":"https://www.sonypictures.com/tv/breakingbad","networks":[{"id":174,"name":"AMC"}],"number_of_seasons":5,"number_of_episodes":62,"popularity":300.1,"vote_average":8.9,"vote_count":14000,"poster_path":"/bb.jpg","backdrop_path":"/bbback.jpg",
"created_by":[{"id":66633,"name":"Vince Gilligan","profile_path":"/vince.jpg"}],
"seasons":[{"air_date":"2009-02-17","episode_count":9,"id":3577,"name":"Specials","overview":"","poster_path":"/s0.jpg","season_number":0},{"air_date":"2008-01-20","episode_count":7,"id":3572,"name":"Season 1","overview":"High school chemistry teacher.","poster_path":"/s1.jpg","season_number":1}],
"external_ids":{"imdb_id":"tt0903747","tvdb_id":81189,"wikidata_id":"Q1079"},
"images":{"posters":[{"file_path":"/bb.jpg","width":680,"height":1000,"iso_639_1":"en","vote_average":5.8,"vote_count":20}],"backdrops":[],"logos":[]},
"credits":{"cast":[{"name":"Bryan Cranston","character":"Walter White","order":0}],"crew":[{"name":"Michelle MacLaren","job":"Director","department":"Directing"}]},
"keywords":{"results":[{"id":2231,"name":"drug dealer"}]},
"content_ratings":{"results":[{"iso_3166_1":"DE","rating":"16"},{"iso_3166_1":"US","rating":"TV-MA"}]},
"alternative_titles":{"results":[{"iso_3166_1":"ES","title":"Hasta el fin","type":""}]}}`

const season1 = `{"_id":"52542282760ee313280017f9","air_date":"2008-01-20","name":"Season 1","overview":"High school chemistry teacher.","id":3572,"poster_path":"/s1.jpg","season_number":1,
"episodes":[{"air_date":"2008-01-20","episode_number":1,"id":62085,"name":"Pilot","overview":"Walter is diagnosed.","runtime":58,"season_number":1,"show_id":1396,"still_path":"/pilot.jpg","vote_average":8.3,"vote_count":220,"crew":[{"name":"Vince Gilligan","job":"Director","department":"Directing"}],"guest_stars":[{"name":"Carmen Serano","character":"Carmen Molina","order":500}]},{"air_date":"2008-01-27","episode_number":2,"id":62086,"name":"Cat's in the Bag...","overview":"Walt and Jesse clean up.","runtime":48,"season_number":1,"show_id":1396,"still_path":"/cat.jpg","vote_average":8.0,"vote_count":160}],
"external_ids":{"tvdb_id":30272,"wikidata_id":"Q16253009"},
"images":{"posters":[{"file_path":"/s1.jpg","width":1000,"height":1500,"iso_639_1":"en","vote_average":5.3,"vote_count":4}]}}`

const episode1 = `{"air_date":"2008-01-20","episode_number":1,"id":62085,"name":"Pilot","overview":"Walter is diagnosed.","runtime":58,"season_number":1,"still_path":"/pilot.jpg","vote_average":8.3,"vote_count":220,"crew":[],"guest_stars":[],
"external_ids":{"imdb_id":"tt0959621","tvdb_id":349232,"wikidata_id":"Q4979254"},
"images":{"stills":[{"file_path":"/pilot.jpg","width":1920,"height":1080,"iso_639_1":null,"vote_average":5.5,"vote_count":6}]}}`

func TestSearchBothKinds(t *testing.T) {
	src, rec, log := newSource(t, map[string]string{"/3/search/movie": searchMovie, "/3/search/tv": searchTV})
	configure(t, src, "v3key")
	claims, err := src.Search(context.Background(), "", "The Matrix", 1999)
	if err != nil {
		t.Fatal(err)
	}
	g := groups(claims)
	if m := g["movie movie/603"]; m == nil || m[model.FieldTitle] != "The Matrix" || m[model.FieldYear] != 1999 || m[model.RatingField("tmdb")] != 8.2 || m[model.VotesField("tmdb")] != 26000 {
		t.Fatalf("movie group = %v", g)
	}
	if s := g["series tv/1396"]; s == nil || s[model.FieldTitle] != "Breaking Bad" || s[model.FieldFirstAirDate] != "2008-01-20" {
		t.Fatalf("series group = %v", g)
	}
	q := log.last("/3/search/movie").URL.Query()
	if q.Get("query") != "The Matrix" || q.Get("year") != "1999" || q.Get("include_adult") != "false" || q.Get("language") != "en" || q.Get("api_key") != "v3key" {
		t.Fatalf("movie query = %v", q)
	}
	if q := log.last("/3/search/tv").URL.Query(); q.Get("first_air_date_year") != "1999" {
		t.Fatalf("tv query = %v", q)
	}
	if r := rec.byPath(t, "/3/search/tv"); r.Namespace != "tmdb" || r.Kind != model.KindSeries {
		t.Fatalf("search provenance = %+v", r)
	}
	for _, c := range claims {
		if c.RecordID == "" || c.Namespace != model.NSTMDB {
			t.Fatalf("claim without provenance %+v", c)
		}
	}
	if _, err := src.Search(context.Background(), model.KindSeason, "Pilot", 0); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("season search = %v", err)
	}
}

func TestLookupMovie(t *testing.T) {
	src, rec, log := newSource(t, map[string]string{"/3/movie/603": movie603})
	configure(t, src, "v3key")
	claims, err := src.Lookup(context.Background(), model.KindMovie, model.NSTMDB, "movie/603")
	if err != nil {
		t.Fatal(err)
	}
	if sent, stored := log.last("/3/movie/603").URL.Query().Get("api_key"), rec.byPath(t, "/3/movie/603").URL; sent != "v3key" || strings.Contains(stored, "v3key") {
		t.Fatalf("key sent as %q but stored url is %s", sent, stored)
	}
	g := groups(claims)
	if len(g) != 1 {
		t.Fatalf("groups = %d", len(g))
	}
	m := g["movie movie/603"]
	checks := map[string]any{
		model.FieldTitle: "The Matrix", model.FieldYear: 1999, model.FieldReleaseDate: "1999-03-31", model.FieldRuntime: 136,
		model.FieldStatus: "released", model.FieldLanguage: "en", model.FieldCertification: "R", model.FieldCollection: "The Matrix Collection",
		model.FieldTagline: "Welcome to the Real World.", model.XIDField("imdb"): "tt0133093", model.XIDField("wikidata"): "Q83495",
		model.FieldHomepage: "https://www.warnerbros.com/movies/matrix", model.FieldPopularity: 81.5,
	}
	for field, want := range checks {
		if m[field] != want {
			t.Errorf("%s = %v, want %v", field, m[field], want)
		}
	}
	if g := m[model.FieldGenres].([]string); len(g) != 2 || g[1] != "Science Fiction" {
		t.Errorf("genres = %v", g)
	}
	if a := m[model.FieldAliases].([]string); len(a) != 1 || a[0] != "Matrix" {
		t.Errorf("aliases = %v", a)
	}
	if k := m[model.FieldKeywords].([]string); len(k) != 2 {
		t.Errorf("keywords = %v", k)
	}
	cast := m[model.FieldCast].([]model.Person)
	if len(cast) != 2 || cast[0].Name != "Keanu Reeves" || cast[0].Character != "Neo" || cast[0].ImageURL != "https://image.tmdb.org/t/p/original/keanu.jpg" || cast[1].Order != 1 {
		t.Errorf("cast = %+v", cast)
	}
	crew := m[model.FieldCrew].([]model.Person)
	if len(crew) != 2 || crew[0].Role != "Director" || crew[1].Role != "Writer" {
		t.Errorf("crew = %+v", crew)
	}
	posters := m[model.ArtworkField("poster")].([]model.Image)
	if len(posters) != 1 || posters[0].URL != "https://image.tmdb.org/t/p/original/primary.jpg" || posters[0].Width != 2000 || posters[0].Language != "en" || posters[0].Score <= 4 || posters[0].Score >= 5.6 {
		t.Errorf("posters = %+v", posters)
	}
	logos := m[model.ArtworkField("logo")].([]model.Image)
	if len(logos) != 1 || logos[0].URL != "https://image.tmdb.org/t/p/original/logo.png" {
		t.Errorf("logos = %+v", logos)
	}
	if b := m[model.ArtworkField("backdrop")].([]model.Image); len(b) != 1 || b[0].Language != "" || b[0].Score <= 0 {
		t.Errorf("backdrops = %+v", b)
	}
	q := log.last("/3/movie/603").URL.Query()
	if q.Get("append_to_response") != "external_ids,images,credits,keywords,release_dates,alternative_titles" || q.Get("include_image_language") != "en,null" || q.Get("api_key") != "v3key" {
		t.Errorf("query = %v", q)
	}
	r := rec.byPath(t, "/3/movie/603")
	if r.Namespace != "tmdb" || r.ExtValue != "movie/603" || r.Kind != model.KindMovie || r.License != license {
		t.Errorf("provenance = %+v", r)
	}
	if claims[0].RecordID != r.ID {
		t.Errorf("record id = %s, want %s", claims[0].RecordID, r.ID)
	}
}

func TestLookupSeriesWithBearerEmitsSeasons(t *testing.T) {
	src, _, log := newSource(t, map[string]string{"/3/tv/1396": tv1396})
	configure(t, src, "eyJhbGciOiJIUzI1NiJ9.token")
	claims, err := src.Lookup(context.Background(), model.KindSeries, model.NSTMDB, "tv/1396")
	if err != nil {
		t.Fatal(err)
	}
	req := log.last("/3/tv/1396")
	if req.Header.Get("Authorization") != "Bearer eyJhbGciOiJIUzI1NiJ9.token" || req.URL.Query().Has("api_key") {
		t.Fatalf("auth = %q %v", req.Header.Get("Authorization"), req.URL.Query())
	}
	if req.URL.Query().Get("append_to_response") != "external_ids,images,credits,keywords,content_ratings,alternative_titles" {
		t.Fatalf("append = %v", req.URL.Query())
	}
	g := groups(claims)
	s := g["series tv/1396"]
	if s[model.XIDField("tvdb")] != "series/81189" || s[model.XIDField("imdb")] != "tt0903747" || s[model.FieldCertification] != "TV-MA" || s[model.FieldSeasonCount] != 5 || s[model.FieldRuntime] != 47 || s[model.FieldLastAirDate] != "2013-09-29" {
		t.Fatalf("series = %v", s)
	}
	if n := s[model.FieldNetworks].([]string); len(n) != 1 || n[0] != "AMC" {
		t.Fatalf("networks = %v", n)
	}
	if crew := s[model.FieldCrew].([]model.Person); len(crew) != 2 || crew[0].Name != "Vince Gilligan" || crew[0].Role != "Creator" {
		t.Fatalf("crew = %+v", crew)
	}
	if k := s[model.FieldKeywords].([]string); len(k) != 1 || k[0] != "drug dealer" {
		t.Fatalf("keywords = %v", k)
	}
	if a := s[model.FieldAliases].([]string); len(a) != 1 || a[0] != "Hasta el fin" {
		t.Fatalf("aliases = %v", a)
	}
	specials, first := g["season tv/1396/0"], g["season tv/1396/1"]
	if specials[model.FieldOrdinal] != 0 || specials[model.ParentXIDField("tmdb")] != "tv/1396" || specials[model.FieldEpisodeCount] != 9 {
		t.Fatalf("specials = %v", specials)
	}
	if first[model.FieldOrdinal] != 1 || first[model.FieldTitle] != "Season 1" || first[model.FieldAirDate] != "2008-01-20" {
		t.Fatalf("season 1 = %v", first)
	}
	if p := first[model.ArtworkField("poster")].([]model.Image); len(p) != 1 || p[0].URL != "https://image.tmdb.org/t/p/original/s1.jpg" {
		t.Fatalf("season poster = %+v", p)
	}
}

func TestLookupSeasonAndEpisode(t *testing.T) {
	src, rec, _ := newSource(t, map[string]string{"/3/tv/1396/season/1": season1, "/3/tv/1396/season/1/episode/1": episode1})
	configure(t, src, "v3key")
	claims, err := src.Lookup(context.Background(), model.KindSeason, model.NSTMDB, "tv/1396/1")
	if err != nil {
		t.Fatal(err)
	}
	g := groups(claims)
	if len(g) != 3 {
		t.Fatalf("groups = %v", g)
	}
	season := g["season tv/1396/1"]
	if season[model.ParentXIDField("tmdb")] != "tv/1396" || season[model.XIDField("tvdb")] != "season/30272" || season[model.FieldOrdinal] != 1 || season[model.FieldEpisodeCount] != 2 {
		t.Fatalf("season = %v", season)
	}
	if p := season[model.ArtworkField("poster")].([]model.Image); len(p) != 1 || p[0].Score <= 0 {
		t.Fatalf("season poster = %+v", p)
	}
	pilot := g["episode tv/1396/1/1"]
	if pilot[model.ParentXIDField("tmdb")] != "tv/1396/1" || pilot[model.FieldOrdinal] != 1 || pilot[model.FieldRuntime] != 58 || pilot[model.RatingField("tmdb")] != 8.3 || pilot[model.FieldTitle] != "Pilot" {
		t.Fatalf("pilot = %v", pilot)
	}
	if st := pilot[model.ArtworkField("still")].([]model.Image); len(st) != 1 || st[0].URL != "https://image.tmdb.org/t/p/original/pilot.jpg" {
		t.Fatalf("still = %+v", st)
	}
	if cast := pilot[model.FieldCast].([]model.Person); len(cast) != 1 || cast[0].Role != "Guest Star" {
		t.Fatalf("guest cast = %+v", cast)
	}
	if g["episode tv/1396/1/2"][model.FieldOrdinal] != 2 {
		t.Fatalf("episode 2 = %v", g["episode tv/1396/1/2"])
	}
	claims, err = src.Lookup(context.Background(), model.KindEpisode, model.NSTMDB, "tv/1396/1/1")
	if err != nil {
		t.Fatal(err)
	}
	ep := groups(claims)["episode tv/1396/1/1"]
	if ep[model.XIDField("imdb")] != "tt0959621" || ep[model.XIDField("tvdb")] != "episode/349232" || ep[model.ParentXIDField("tmdb")] != "tv/1396/1" {
		t.Fatalf("episode = %v", ep)
	}
	if st := ep[model.ArtworkField("still")].([]model.Image); len(st) != 1 || st[0].Width != 1920 || st[0].Score <= 0 {
		t.Fatalf("episode still = %+v", st)
	}
	if r := rec.byPath(t, "/3/tv/1396/season/1/episode/1"); r.ExtValue != "tv/1396/1/1" || r.Kind != model.KindEpisode || r.Namespace != "tmdb" {
		t.Fatalf("provenance = %+v", r)
	}
}

func TestLookupThroughFind(t *testing.T) {
	src, rec, log := newSource(t, map[string]string{
		"/3/find/tt0133093":             `{"movie_results":[{"id":603,"title":"The Matrix"}],"person_results":[],"tv_results":[],"tv_episode_results":[],"tv_season_results":[]}`,
		"/3/find/349232":                `{"movie_results":[],"person_results":[],"tv_results":[],"tv_episode_results":[{"id":62085,"show_id":1396,"season_number":1,"episode_number":1}],"tv_season_results":[]}`,
		"/3/movie/603":                  movie603,
		"/3/tv/1396/season/1/episode/1": episode1,
	})
	configure(t, src, "v3key")
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["movie movie/603"][model.FieldTitle] != "The Matrix" {
		t.Fatalf("imdb lookup = %v", g)
	}
	if r := rec.byPath(t, "/3/find/tt0133093"); r.Namespace != "imdb" || r.ExtValue != "tt0133093" || r.Kind != model.KindMovie {
		t.Fatalf("find provenance = %+v", r)
	}
	if q := log.last("/3/find/tt0133093").URL.Query(); q.Get("external_source") != "imdb_id" {
		t.Fatalf("find query = %v", q)
	}
	claims, err = src.Lookup(ctx, model.KindEpisode, model.NSTVDB, "episode/349232")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["episode tv/1396/1/1"][model.XIDField("tvdb")] != "episode/349232" {
		t.Fatalf("tvdb lookup = %v", g)
	}
	if q := log.last("/3/find/349232").URL.Query(); q.Get("external_source") != "tvdb_id" {
		t.Fatalf("find query = %v", q)
	}
	before := log.count()
	claims, err = src.Lookup(ctx, model.KindMovie, model.NSTVDB, "series/81189")
	if err != nil || claims != nil || log.count() != before {
		t.Fatalf("kind mismatch = %v %v after %d calls", claims, err, log.count()-before)
	}
	claims, err = src.Lookup(ctx, model.KindSeries, model.NSIMDb, "tt0133093")
	if err != nil || claims != nil {
		t.Fatalf("movie id as series = %v %v", claims, err)
	}
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "0133093"); err == nil {
		t.Fatal("malformed imdb id accepted")
	}
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSTrakt, "movie/the-matrix-1999"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("trakt namespace = %v", err)
	}
}

func TestMissingKeyFailsBeforeCalling(t *testing.T) {
	src, _, log := newSource(t, map[string]string{"/3/movie/603": movie603})
	if _, err := src.Lookup(context.Background(), model.KindMovie, model.NSTMDB, "movie/603"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("lookup = %v", err)
	}
	if _, err := src.Search(context.Background(), "", "The Matrix", 0); !errors.Is(err, ErrNoKey) || !strings.Contains(err.Error(), "themoviedb.org/settings/api") {
		t.Fatalf("search = %v", err)
	}
	configure(t, src, "")
	if _, err := src.Search(context.Background(), "", "The Matrix", 0); !errors.Is(err, ErrNoKey) {
		t.Fatalf("blank key = %v", err)
	}
	if log.count() != 0 {
		t.Fatalf("calls = %d", log.count())
	}
}

func TestNotFoundAndErrors(t *testing.T) {
	src, rec, _ := newSource(t, map[string]string{"/3/search/tv": "401"})
	configure(t, src, "v3key")
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/999")
	if err != nil || claims != nil {
		t.Fatalf("404 lookup = %v %v", claims, err)
	}
	if r := rec.byPath(t, "/3/movie/999"); r.Status != http.StatusNotFound || r.ExtValue != "movie/999" {
		t.Fatalf("404 record = %+v", r)
	}
	var se *outbound.StatusError
	if _, err := src.Search(ctx, model.KindSeries, "Breaking Bad", 0); !errors.As(err, &se) || se.Status != http.StatusUnauthorized {
		t.Fatalf("401 search = %v", err)
	}
	if _, err := src.Search(ctx, model.KindMovie, "Heat", 0); !errors.As(err, &se) || se.Status != http.StatusNotFound {
		t.Fatalf("404 search = %v", err)
	}
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, "film/603"); err == nil {
		t.Fatal("malformed tmdb id accepted")
	}
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, "tv/1396"); err != nil || claims != nil {
		t.Fatalf("series id as movie = %v %v", claims, err)
	}
	if err := src.Configure(catalog.Keys{APIKey: "k"}, map[string]string{"language": "not a language"}); err == nil {
		t.Fatal("bad language accepted")
	}
}
