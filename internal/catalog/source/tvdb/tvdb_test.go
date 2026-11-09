package tvdb

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

// Returns the latest successful stored record whose URL has the given path
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

// Fakes TheTVDB, issuing numbered tokens and accepting only the latest one
type api struct {
	t      *testing.T
	routes map[string]string

	mu     sync.Mutex
	logins int
	valid  string
	paths  []string
	last   map[string]*http.Request
}

func (a *api) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Host != "api4.thetvdb.com" {
		a.t.Errorf("host = %s", r.Host)
	}
	a.paths = append(a.paths, r.URL.Path)
	a.last[r.URL.Path] = r
	if r.URL.Path == "/v4/login" {
		var body map[string]string
		raw, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || json.Unmarshal(raw, &body) != nil || body["apikey"] != "project-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"status":"failure","message":"Unauthorized"}`))
			return
		}
		a.logins++
		a.valid = "tok-" + strconv.Itoa(a.logins)
		_, _ = w.Write([]byte(`{"status":"success","data":{"token":"` + a.valid + `"}}`))
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+a.valid || a.valid == "" {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"status":"failure","message":"Unauthorized"}`))
		return
	}
	key := r.URL.Path
	if q := r.URL.Query().Get("type"); r.URL.Path == "/v4/search" {
		key += "?" + q
	}
	body, ok := a.routes[key]
	switch {
	case !ok:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"status":"failure","message":"NotFoundException: not found","data":null}`))
	case body == "400":
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"status":"failure","message":"bad request"}`))
	default:
		_, _ = w.Write([]byte(body))
	}
}

func (a *api) calls(path string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for _, p := range a.paths {
		if p == path {
			n++
		}
	}
	return n
}

func newSource(t *testing.T, key string, routes map[string]string) (*Source, *memRecorder, *api) {
	t.Helper()
	fake := &api{t: t, routes: routes, last: map[string]*http.Request{}}
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	rec := &memRecorder{}
	client := outbound.New(rec, "DiscoFlix/test", slog.New(slog.DiscardHandler))
	client.SetHTTPClient(&http.Client{Transport: rewrite{target: target}})
	src := New(client, key)
	client.Register(src.Policy())
	return src, rec, fake
}

func configure(t *testing.T, s *Source, lang string) {
	t.Helper()
	if err := s.Configure(map[string]string{"language": lang}); err != nil {
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

// Finds the claim of one field in one group
func claimOf(claims []model.Claim, id, field string) model.Claim {
	for _, c := range claims {
		if c.ExternalID == id && c.Field == field {
			return c
		}
	}
	return model.Claim{}
}

const searchSeries = `{"status":"success","data":[{"objectID":"series-81189","aliases":["BB","Breaking Bad"],"country":"usa","id":"series-81189","image_url":"https://artworks.thetvdb.com/banners/posters/81189-10.jpg","name":"Breaking Bad","first_air_time":"2008-01-20","overview":"A chemistry teacher turns to crime.","overviews":{"eng":"A chemistry teacher turns to crime.","spa":"Un maestro de química."},"primary_language":"eng","status":"Ended","type":"series","tvdb_id":"81189","year":"2008","slug":"breaking-bad","translations":{"eng":"Breaking Bad","spa":"Breaking Bad: Hasta el fin"},"network":"AMC","genres":["Drama","Crime"],"remote_ids":[{"id":"tt0903747","type":2,"sourceName":"IMDB"},{"id":"1396","type":12,"sourceName":"TheMovieDB.com"}]}],"links":{"prev":null,"self":"https://api4.thetvdb.com/v4/search?query=Breaking%20Bad&page=0","next":null,"total_items":1,"page_size":50}}`

const series81189 = `{"status":"success","data":{"id":81189,"name":"Breaking Bad","slug":"breaking-bad","image":"https://artworks.thetvdb.com/banners/posters/81189-10.jpg","firstAired":"2008-01-20","lastAired":"2013-09-29","year":"2008","overview":"A chemistry teacher turns to crime.","averageRuntime":47,"originalCountry":"usa","originalLanguage":"eng","score":3103284,"status":{"id":2,"name":"Ended","recordType":"series","keepUpdated":false},
"genres":[{"id":2,"name":"Crime","slug":"crime"},{"id":3,"name":"Drama","slug":"drama"}],
"aliases":[{"language":"eng","name":"BrBa"},{"language":"deu","name":"Breaking Bad DE"}],
"artworks":[{"id":1,"image":"https://artworks.thetvdb.com/banners/posters/81189-10.jpg","language":"eng","type":2,"score":100045,"width":680,"height":1000},{"id":2,"image":"https://artworks.thetvdb.com/banners/posters/81189-es.jpg","language":"spa","type":2,"score":100010,"width":680,"height":1000},{"id":3,"image":"/banners/fanart/original/81189-21.jpg","language":null,"type":3,"score":10,"width":1920,"height":1080},{"id":4,"image":"https://artworks.thetvdb.com/banners/graphical/81189-g21.jpg","language":"eng","type":1,"score":5,"width":758,"height":140},{"id":5,"image":"https://artworks.thetvdb.com/banners/v4/series/81189/clearlogo/611be0d1e4b5b.png","language":"eng","type":23,"score":0,"width":800,"height":310}],
"characters":[{"id":10,"name":"Walter White","peopleType":"Actor","personName":"Bryan Cranston","personImgURL":"https://artworks.thetvdb.com/banners/person/279/primary.jpg","sort":0},{"id":11,"name":"Jesse Pinkman","peopleType":"Actor","personName":"Aaron Paul","sort":1},{"id":12,"name":"","peopleType":"Creator","personName":"Vince Gilligan","sort":0}],
"companies":[{"id":45,"name":"AMC","primaryCompanyType":1},{"id":46,"name":"Sony Pictures Television","primaryCompanyType":3}],
"latestNetwork":{"id":45,"name":"AMC","primaryCompanyType":1},"originalNetwork":{"id":45,"name":"AMC","primaryCompanyType":1},
"contentRatings":[{"id":1,"name":"TV-MA","country":"usa","contentType":""}],
"remoteIds":[{"id":"tt0903747","type":2,"sourceName":"IMDB"},{"id":"1396","type":12,"sourceName":"TheMovieDB.com"},{"id":"169","type":13,"sourceName":"TV Maze"}],
"seasons":[{"id":30271,"number":0,"name":"Specials","image":"https://artworks.thetvdb.com/banners/seasons/81189-0.jpg","type":{"id":1,"name":"Aired Order","type":"official"},"nameTranslations":["eng"],"overviewTranslations":[]},{"id":30272,"number":1,"seriesId":81189,"image":"https://artworks.thetvdb.com/banners/seasons/81189-1.jpg","type":{"id":1,"name":"Aired Order","type":"official"},"nameTranslations":["eng","spa"],"overviewTranslations":["eng","spa"]},{"id":40000,"number":1,"type":{"id":2,"name":"DVD Order","type":"dvd"}}],
"translations":{"nameTranslations":[{"language":"eng","name":"Breaking Bad","isPrimary":true},{"language":"spa","name":"Breaking Bad: Hasta el fin"}],"overviewTranslations":[{"language":"eng","overview":"A chemistry teacher turns to crime."},{"language":"spa","overview":"Un maestro de química."}],"alias":["BB"]}}}`

const seriesDecoy = `{"status":"success","data":{"id":99999,"name":"Other Show","originalLanguage":"eng","remoteIds":[{"id":"1396","type":13,"sourceName":"TV Maze"}],"seasons":[]}}`

const season30272 = `{"status":"success","data":{"id":30272,"seriesId":81189,"number":1,"name":"Season 1","image":"https://artworks.thetvdb.com/banners/seasons/81189-1.jpg","year":"2008","type":{"id":1,"name":"Aired Order","type":"official"},
"artwork":[{"id":20,"image":"https://artworks.thetvdb.com/banners/seasons/81189-1.jpg","language":"eng","type":7,"score":100002,"width":680,"height":1000},{"id":21,"image":"https://artworks.thetvdb.com/banners/seasons/81189-1-es.jpg","language":"spa","type":7,"score":50,"width":680,"height":1000}],
"episodes":[{"id":349232,"seriesId":81189,"name":"Pilot","aired":"2008-01-20","runtime":58,"number":1,"seasonNumber":1,"overview":"Walter is diagnosed.","image":"/banners/episodes/81189/349232.jpg","nameTranslations":["eng","spa"],"overviewTranslations":["eng","spa"]},{"id":349235,"seriesId":81189,"name":"Cat's in the Bag...","aired":"2008-01-27","runtime":48,"number":2,"seasonNumber":1,"overview":"Walt and Jesse clean up.","nameTranslations":["eng"],"overviewTranslations":["eng"]}],
"translations":{"nameTranslations":[{"language":"spa","name":"Temporada 1"}],"overviewTranslations":[{"language":"eng","overview":"High school chemistry teacher."}]}}}`

const episode349232 = `{"status":"success","data":{"id":349232,"seriesId":81189,"name":"Pilot","aired":"2008-01-20","runtime":58,"number":1,"seasonNumber":1,"overview":"Walter is diagnosed.","image":"https://artworks.thetvdb.com/banners/episodes/81189/349232.jpg",
"seasons":[{"id":40000,"number":1,"type":{"id":2,"name":"DVD Order","type":"dvd"}},{"id":30272,"number":1,"type":{"id":1,"name":"Aired Order","type":"official"}}],
"remoteIds":[{"id":"tt0959621","type":2,"sourceName":"IMDB"},{"id":"62085","type":10,"sourceName":"TheMovieDB.com"}],
"characters":[{"name":"","peopleType":"Director","personName":"Vince Gilligan","sort":0},{"name":"Carmen Molina","peopleType":"Guest Star","personName":"Carmen Serano","sort":3}],
"translations":{"nameTranslations":[{"language":"spa","name":"Piloto"}],"overviewTranslations":[]}}}`

const movie169 = `{"status":"success","data":{"id":169,"name":"The Matrix","slug":"the-matrix","year":"1999","runtime":136,"originalCountry":"usa","originalLanguage":"eng","score":203492,"status":{"id":5,"name":"Released"},"genres":[{"id":1,"name":"Action"}],"aliases":[],
"artworks":[{"id":30,"image":"https://artworks.thetvdb.com/banners/movies/169/posters/169.jpg","language":"eng","type":14,"score":100,"width":1000,"height":1500},{"id":31,"image":"https://artworks.thetvdb.com/banners/movies/169/backgrounds/169.jpg","type":15,"score":4,"width":1920,"height":1080}],
"characters":[],"contentRatings":[{"name":"R","country":"usa"}],
"remoteIds":[{"id":"tt0133093","type":2,"sourceName":"IMDB"},{"id":"603","type":10,"sourceName":"TheMovieDB.com"}],
"first_release":{"country":"usa","date":"1999-03-31","detail":null},
"translations":{"nameTranslations":[{"language":"eng","name":"The Matrix","isPrimary":true}],"overviewTranslations":[{"language":"eng","overview":"A hacker learns the truth."}]}}}`

func TestLoginAndSearch(t *testing.T) {
	src, rec, fake := newSource(t, "project-key", map[string]string{"/v4/search?series": searchSeries, "/v4/search?movie": `{"status":"success","data":[]}`})
	configure(t, src, "en")
	claims, err := src.Search(context.Background(), "", "Breaking Bad", 2008)
	if err != nil {
		t.Fatal(err)
	}
	g := groups(claims)
	if len(g) != 1 {
		t.Fatalf("groups = %v", g)
	}
	s := g["series series/81189"]
	if s[model.FieldTitle] != "Breaking Bad" || s[model.FieldYear] != 2008 || s[model.XIDField("imdb")] != "tt0903747" || s[model.XIDField("tmdb")] != "tv/1396" || s[model.FieldLanguage] != "en" || s[model.FieldStatus] != "ended" || s[model.FieldFirstAirDate] != "2008-01-20" {
		t.Fatalf("series = %v", s)
	}
	if c := s[model.FieldCountries].([]string); len(c) != 1 || c[0] != "US" {
		t.Fatalf("countries = %v", c)
	}
	if a := s[model.FieldAliases].([]string); len(a) != 1 || a[0] != "BB" {
		t.Fatalf("aliases = %v", a)
	}
	if fake.logins != 1 || fake.calls("/v4/search") != 2 {
		t.Fatalf("logins %d searches %d", fake.logins, fake.calls("/v4/search"))
	}
	q := fake.last["/v4/search"].URL.Query()
	if q.Get("query") != "Breaking Bad" || q.Get("year") != "2008" || q.Get("type") != "movie" {
		t.Fatalf("query = %v", q)
	}
	if r := rec.byPath(t, "/v4/search"); r.Namespace != "tvdb" || r.Kind != model.KindMovie {
		t.Fatalf("provenance = %+v", r)
	}
	if claims[0].RecordID == "" {
		t.Fatal("claim without record id")
	}
}

func TestLookupSeriesEmitsOfficialSeasons(t *testing.T) {
	src, rec, fake := newSource(t, "project-key", map[string]string{"/v4/series/81189/extended": series81189})
	configure(t, src, "en")
	claims, err := src.Lookup(context.Background(), model.KindSeries, model.NSTVDB, "series/81189")
	if err != nil {
		t.Fatal(err)
	}
	if q := fake.last["/v4/series/81189/extended"].URL.Query(); q.Get("meta") != "translations" || q.Get("short") != "false" {
		t.Fatalf("query = %v", q)
	}
	g := groups(claims)
	if len(g) != 3 {
		t.Fatalf("groups = %v", g)
	}
	s := g["series series/81189"]
	checks := map[string]any{
		model.FieldTitle: "Breaking Bad", model.FieldOriginalTitle: "Breaking Bad", model.FieldYear: 2008, model.FieldRuntime: 47,
		model.FieldStatus: "ended", model.FieldCertification: "TV-MA", model.FieldLanguage: "en", model.FieldLastAirDate: "2013-09-29",
		model.RatingField("tvdb"): 3103284.0, model.XIDField("imdb"): "tt0903747", model.XIDField("tmdb"): "tv/1396", model.FieldSeasonCount: 1,
		model.FieldOverview: "A chemistry teacher turns to crime.",
	}
	for field, want := range checks {
		if s[field] != want {
			t.Errorf("%s = %v, want %v", field, s[field], want)
		}
	}
	if n := s[model.FieldNetworks].([]string); len(n) != 1 || n[0] != "AMC" {
		t.Errorf("networks = %v", n)
	}
	if a := s[model.FieldAliases].([]string); !slices.Equal(a, []string{"BB", "BrBa"}) {
		t.Errorf("aliases = %v", a)
	}
	cast := s[model.FieldCast].([]model.Person)
	if len(cast) != 2 || cast[0].Name != "Bryan Cranston" || cast[0].Character != "Walter White" || cast[0].ImageURL == "" {
		t.Errorf("cast = %+v", cast)
	}
	if crew := s[model.FieldCrew].([]model.Person); len(crew) != 1 || crew[0].Role != "Creator" {
		t.Errorf("crew = %+v", crew)
	}
	posters := s[model.ArtworkField("poster")].([]model.Image)
	if len(posters) != 1 || posters[0].Language != "en" || posters[0].Score <= 8 || posters[0].Score >= 10 || posters[0].Width != 680 {
		t.Errorf("posters = %+v", posters)
	}
	if b := s[model.ArtworkField("backdrop")].([]model.Image); len(b) != 1 || b[0].URL != "https://artworks.thetvdb.com/banners/fanart/original/81189-21.jpg" || b[0].Score <= 0 {
		t.Errorf("backdrops = %+v", b)
	}
	if l := s[model.ArtworkField("logo")].([]model.Image); len(l) != 1 || l[0].Height != 310 {
		t.Errorf("logos = %+v", l)
	}
	if b := s[model.ArtworkField("banner")].([]model.Image); len(b) != 1 {
		t.Errorf("banners = %+v", b)
	}
	first := g["season season/30272"]
	if first[model.FieldOrdinal] != 1 || first[model.ParentXIDField("tvdb")] != "series/81189" {
		t.Errorf("season 1 = %v", first)
	}
	if p := first[model.ArtworkField("poster")].([]model.Image); len(p) != 1 || p[0].URL != "https://artworks.thetvdb.com/banners/seasons/81189-1.jpg" {
		t.Errorf("season poster = %+v", p)
	}
	if specials := g["season season/30271"]; specials[model.FieldOrdinal] != 0 || specials[model.FieldTitle] != "Specials" {
		t.Errorf("specials = %v", specials)
	}
	if fake.calls("/v4/seasons/30272/translations/eng") != 0 {
		t.Error("fetched a translation in the original language")
	}
	if r := rec.byPath(t, "/v4/series/81189/extended"); r.Namespace != "tvdb" || r.ExtValue != "series/81189" || r.Kind != model.KindSeries {
		t.Errorf("provenance = %+v", r)
	}
}

func TestLookupSeasonTranslatesEpisodes(t *testing.T) {
	src, rec, fake := newSource(t, "project-key", map[string]string{
		"/v4/seasons/30272/extended":           season30272,
		"/v4/series/81189":                     `{"status":"success","data":{"id":81189,"name":"Breaking Bad","originalLanguage":"eng"}}`,
		"/v4/episodes/349232/translations/spa": `{"status":"success","data":{"name":"Piloto","overview":"Walter recibe un diagnóstico.","language":"spa"}}`,
	})
	configure(t, src, "es")
	claims, err := src.Lookup(context.Background(), model.KindSeason, model.NSTVDB, "season/30272")
	if err != nil {
		t.Fatal(err)
	}
	g := groups(claims)
	if len(g) != 3 {
		t.Fatalf("groups = %v", g)
	}
	season := g["season season/30272"]
	if season[model.FieldTitle] != "Temporada 1" || season[model.FieldOverview] != "High school chemistry teacher." || season[model.ParentXIDField("tvdb")] != "series/81189" || season[model.FieldEpisodeCount] != 2 {
		t.Fatalf("season = %v", season)
	}
	if p := season[model.ArtworkField("poster")].([]model.Image); len(p) != 1 || p[0].Score <= 0 || p[0].Language != "es" {
		t.Fatalf("season poster = %+v", p)
	}
	pilot := g["episode episode/349232"]
	if pilot[model.FieldTitle] != "Piloto" || pilot[model.FieldOverview] != "Walter recibe un diagnóstico." || pilot[model.FieldOrdinal] != 1 || pilot[model.ParentXIDField("tvdb")] != "season/30272" || pilot[model.FieldRuntime] != 58 {
		t.Fatalf("pilot = %v", pilot)
	}
	if st := pilot[model.ArtworkField("still")].([]model.Image); len(st) != 1 || st[0].URL != "https://artworks.thetvdb.com/banners/episodes/81189/349232.jpg" {
		t.Fatalf("still = %+v", st)
	}
	if second := g["episode episode/349235"]; second[model.FieldTitle] != "Cat's in the Bag..." || second[model.FieldOrdinal] != 2 {
		t.Fatalf("episode 2 = %v", second)
	}
	tr := rec.byPath(t, "/v4/episodes/349232/translations/spa")
	if c := claimOf(claims, "episode/349232", model.FieldTitle); c.RecordID != tr.ID {
		t.Fatalf("translated title record = %s, want %s", c.RecordID, tr.ID)
	}
	if tr.ExtValue != "episode/349232" || tr.Kind != model.KindEpisode {
		t.Fatalf("translation provenance = %+v", tr)
	}
	if fake.calls("/v4/episodes/349235/translations/spa") != 0 {
		t.Fatal("fetched a translation the episode does not list")
	}
}

func TestLookupEpisodeMovieAndRemoteIDs(t *testing.T) {
	src, rec, _ := newSource(t, "project-key", map[string]string{
		"/v4/episodes/349232/extended":  episode349232,
		"/v4/movies/169/extended":       movie169,
		"/v4/series/81189/extended":     series81189,
		"/v4/series/99999/extended":     seriesDecoy,
		"/v4/seasons/30272/extended":    season30272,
		"/v4/series/81189":              `{"status":"success","data":{"id":81189,"originalLanguage":"eng"}}`,
		"/v4/search/remoteid/tt0903747": `{"status":"success","data":[{"series":{"id":81189,"name":"Breaking Bad"}}]}`,
		"/v4/search/remoteid/1396":      `{"status":"success","data":[{"series":{"id":99999,"name":"Other Show"}},{"series":{"id":81189,"name":"Breaking Bad"}}]}`,
		"/v4/search/remoteid/603":       `{"status":"success","data":[{"movie":{"id":169,"name":"The Matrix"}}]}`,
	})
	configure(t, src, "en")
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindEpisode, model.NSTVDB, "episode/349232")
	if err != nil {
		t.Fatal(err)
	}
	ep := groups(claims)["episode episode/349232"]
	if ep[model.ParentXIDField("tvdb")] != "season/30272" || ep[model.XIDField("imdb")] != "tt0959621" || ep[model.FieldOrdinal] != 1 || ep[model.FieldAirDate] != "2008-01-20" {
		t.Fatalf("episode = %v", ep)
	}
	if _, ok := ep[model.XIDField("tmdb")]; ok {
		t.Fatal("episode carries a tmdb id it cannot format")
	}
	if cast := ep[model.FieldCast].([]model.Person); len(cast) != 1 || cast[0].Role != "Guest Star" {
		t.Fatalf("cast = %+v", cast)
	}
	claims, err = src.Lookup(ctx, model.KindMovie, model.NSTVDB, "movie/169")
	if err != nil {
		t.Fatal(err)
	}
	m := groups(claims)["movie movie/169"]
	if m[model.FieldReleaseDate] != "1999-03-31" || m[model.XIDField("tmdb")] != "movie/603" || m[model.FieldCertification] != "R" || m[model.FieldOverview] != "A hacker learns the truth." || m[model.FieldStatus] != "released" {
		t.Fatalf("movie = %v", m)
	}
	if p := m[model.ArtworkField("poster")].([]model.Image); len(p) != 1 || p[0].Width != 1000 {
		t.Fatalf("movie poster = %+v", p)
	}
	claims, err = src.Lookup(ctx, model.KindSeries, model.NSIMDb, "tt0903747")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["series series/81189"][model.FieldTitle] != "Breaking Bad" {
		t.Fatalf("imdb lookup = %v", g)
	}
	if r := rec.byPath(t, "/v4/search/remoteid/tt0903747"); r.Namespace != "imdb" || r.ExtValue != "tt0903747" || r.Kind != model.KindSeries {
		t.Fatalf("remote provenance = %+v", r)
	}
	claims, err = src.Lookup(ctx, model.KindSeries, model.NSTMDB, "tv/1396")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["series series/81189"] == nil || g["series series/99999"] != nil {
		t.Fatalf("tmdb series lookup = %v", g)
	}
	claims, err = src.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/603")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["movie movie/169"][model.XIDField("imdb")] != "tt0133093" {
		t.Fatalf("tmdb movie lookup = %v", g)
	}
	claims, err = src.Lookup(ctx, model.KindSeason, model.NSTMDB, "tv/1396/1")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); g["season season/30272"][model.FieldOrdinal] != 1 || g["episode episode/349232"] == nil {
		t.Fatalf("tmdb season lookup = %v", g)
	}
	claims, err = src.Lookup(ctx, model.KindEpisode, model.NSTMDB, "tv/1396/1/1")
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); len(g) != 1 || g["episode episode/349232"][model.ParentXIDField("tvdb")] != "season/30272" {
		t.Fatalf("tmdb episode lookup = %v", g)
	}
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSTVDB, "series/81189"); err != nil || claims != nil {
		t.Fatalf("kind mismatch = %v %v", claims, err)
	}
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSWikidata, "Q83495"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("wikidata namespace = %v", err)
	}
}

func TestReloginOnRejectedToken(t *testing.T) {
	src, _, fake := newSource(t, "project-key", map[string]string{"/v4/movies/169/extended": movie169})
	configure(t, src, "en")
	ctx := context.Background()
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSTVDB, "movie/169"); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.valid = "rotated"
	fake.mu.Unlock()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSTVDB, "movie/169")
	if err != nil || len(claims) == 0 {
		t.Fatalf("after rotation = %v %v", claims, err)
	}
	if fake.logins != 1 {
		t.Fatalf("logins = %d, cached answer should not need a token", fake.logins)
	}
	fake.mu.Lock()
	fake.valid = "rotated"
	fake.mu.Unlock()
	if _, err := src.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/1"); err != nil {
		t.Fatal(err)
	}
	if fake.logins != 2 || fake.calls("/v4/series/1/extended") != 2 {
		t.Fatalf("logins %d calls %d", fake.logins, fake.calls("/v4/series/1/extended"))
	}
}

func TestNotFoundAndErrors(t *testing.T) {
	src, rec, _ := newSource(t, "project-key", map[string]string{"/v4/search?series": "400"})
	configure(t, src, "en")
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/1")
	if err != nil || claims != nil {
		t.Fatalf("404 lookup = %v %v", claims, err)
	}
	if r := rec.byPath(t, "/v4/series/1/extended"); r.Status != http.StatusNotFound {
		t.Fatalf("404 record = %+v", r)
	}
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt9999999"); err != nil || claims != nil {
		t.Fatalf("unknown remote id = %v %v", claims, err)
	}
	var se *outbound.StatusError
	if _, err := src.Search(ctx, model.KindSeries, "Breaking Bad", 0); !errors.As(err, &se) || se.Status != http.StatusBadRequest {
		t.Fatalf("400 search = %v", err)
	}
	if _, err := src.Search(ctx, model.KindMovie, "Heat", 0); !errors.As(err, &se) || se.Status != http.StatusNotFound {
		t.Fatalf("404 search = %v", err)
	}
	if _, err := src.Search(ctx, model.KindEpisode, "Pilot", 0); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("episode search = %v", err)
	}
	if _, err := src.Lookup(ctx, model.KindSeries, model.NSTVDB, "show/81189"); err == nil {
		t.Fatal("malformed tvdb id accepted")
	}
	wrong, _, _ := newSource(t, "wrong", map[string]string{})
	if _, err := wrong.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/2"); !errors.As(err, &se) || se.Status != http.StatusUnauthorized {
		t.Fatalf("bad key = %v", err)
	}
}
