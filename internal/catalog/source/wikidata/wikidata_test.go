package wikidata

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

// Lists the stored records whose URL has the given host
func (m *memRecorder) byHost(host string) []*outbound.Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*outbound.Record
	for _, r := range m.records {
		if u, err := url.Parse(r.URL); err == nil && u.Host == host {
			out = append(out, r)
		}
	}
	return out
}

// Sends every request to the test server, keeping the original host in the Host header
type rewrite struct{ target *url.URL }

func (rw rewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	out := r.Clone(r.Context())
	out.Host = r.URL.Host
	out.URL.Scheme, out.URL.Host = rw.target.Scheme, rw.target.Host
	return http.DefaultTransport.RoundTrip(out)
}

// Fakes QLever, the query service, and the search API, answering by query shape
type endpoints struct {
	t       *testing.T
	qlever  int
	wdqs    int
	resolve string
	facts   string
	search  string

	mu       sync.Mutex
	requests []*http.Request
}

func (e *endpoints) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	e.requests = append(e.requests, r)
	e.mu.Unlock()
	if r.Host == "www.wikidata.org" {
		if r.URL.Path != "/w/api.php" || r.URL.Query().Get("action") != "query" || r.URL.Query().Get("list") != "search" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(e.search))
		return
	}
	status := map[string]int{"qlever.dev": e.qlever, "query.wikidata.org": e.wdqs}[r.Host]
	if status != http.StatusOK {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"exception":"unavailable"}`))
		return
	}
	query := r.URL.Query().Get("query")
	for _, prefix := range []string{"wd", "wdt", "p", "ps", "pq", "psv", "rdfs", "skos", "wikibase"} {
		if !strings.Contains(query, "PREFIX "+prefix+": <") {
			e.t.Errorf("query lacks PREFIX %s", prefix)
		}
	}
	if r.Header.Get("Accept") != "text/tab-separated-values" {
		e.t.Errorf("accept = %q", r.Header.Get("Accept"))
	}
	w.Header().Set("Content-Type", "text/tab-separated-values")
	if strings.Contains(query, "SELECT DISTINCT ?item") {
		_, _ = w.Write([]byte(e.resolve))
		return
	}
	_, _ = w.Write([]byte(e.facts))
}

func (e *endpoints) count(host string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := 0
	for _, r := range e.requests {
		if r.Host == host {
			n++
		}
	}
	return n
}

func (e *endpoints) queries() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, r := range e.requests {
		if q := r.URL.Query().Get("query"); q != "" {
			out = append(out, q)
		}
	}
	return out
}

func newSource(t *testing.T, e *endpoints) (*Source, *memRecorder) {
	t.Helper()
	e.t = t
	srv := httptest.NewServer(e)
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	rec := &memRecorder{}
	client := outbound.New(rec, "DiscoFlix/test", slog.New(slog.DiscardHandler))
	client.SetHTTPClient(&http.Client{Transport: rewrite{target: target}})
	src := New(client)
	client.Register(src.Policy())
	return src, rec
}

// Builds a SPARQL TSV answer from rows of terms
func tsv(header string, rows ...[]string) string {
	lines := []string{header}
	for _, r := range rows {
		lines = append(lines, strings.Join(r, "\t"))
	}
	return strings.Join(lines, "\n") + "\n"
}

const (
	itemHeader = "?item\t?k\t?v\t?q"
	ent        = "<http://www.wikidata.org/entity/"
)

func q(id string) string { return ent + id + ">" }

// Lists every value claimed for one field
func values(claims []model.Claim, field string) []string {
	var out []string
	for _, c := range claims {
		if c.Field == field {
			out = append(out, c.Value.(string))
		}
	}
	return out
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

// Holds the query service answer about The Matrix with typed literals and a mul label
var matrixWDQS = tsv(itemHeader,
	[]string{q("Q83495"), `"class"`, q("Q11424"), ""},
	[]string{q("Q83495"), `"label"`, `"The Matrix"@mul`, ""},
	[]string{q("Q83495"), `"label"`, `"Matrix"@es`, ""},
	[]string{q("Q83495"), `"alias"`, `"Matrix I"@en`, ""},
	[]string{q("Q83495"), `"alias"`, `"Мatrix"@ru`, ""},
	[]string{q("Q83495"), `"P1476"`, `"The Matrix"@en`, ""},
	[]string{q("Q83495"), `"date"`, `"1999-06-17T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, ""},
	[]string{q("Q83495"), `"date"`, `"1999-03-31T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, ""},
	[]string{q("Q83495"), `"P364"`, `"en"`, ""},
	[]string{q("Q83495"), `"P495"`, `"US"`, ""},
	[]string{q("Q83495"), `"P495"`, `"AU"`, ""},
	[]string{q("Q83495"), `"P2047"`, `"136"^^<http://www.w3.org/2001/XMLSchema#decimal>`, q("Q7727")},
	[]string{q("Q83495"), `"P2047"`, `8280.0`, q("Q11574")},
	[]string{q("Q83495"), `"P136"`, `"cine de acción"@es`, q("Q188473")},
	[]string{q("Q83495"), `"P136"`, `"action film"@en`, q("Q188473")},
	[]string{q("Q83495"), `"P136"`, `"cyberpunk"@en`, q("Q174526")},
	[]string{q("Q83495"), `"P179"`, q("Q1210827"), `"1"`},
	[]string{q("Q83495"), `"P345"`, `"tt0133093"`, ""},
	[]string{q("Q83495"), `"P4947"`, `"603"`, ""},
	[]string{q("Q83495"), `"P12196"`, `"169"`, ""},
	[]string{q("Q83495"), `"P8013"`, `"movies/the-matrix-1999"`, ""},
	[]string{q("Q83495"), `"P12492"`, `"481"`, ""},
	[]string{q("Q83495"), `"tmdbSeason"`, `"603/1"`, ""},
	[]string{q("Q83495"), `"P6127"`, `"the-matrix"`, ""},
	[]string{q("Q83495"), `"P1258"`, `"m/matrix"`, ""},
)

func TestLookupFallsBackToQueryService(t *testing.T) {
	e := &endpoints{qlever: http.StatusServiceUnavailable, wdqs: http.StatusOK, resolve: tsv("?item", []string{q("Q83495")}), facts: matrixWDQS}
	src, rec := newSource(t, e)
	if err := src.Configure(catalog.Keys{}, map[string]string{"language": "es"}); err != nil {
		t.Fatal(err)
	}
	claims, err := src.Lookup(context.Background(), model.KindMovie, model.NSIMDb, "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	if e.count("qlever.dev") != 2 || e.count("query.wikidata.org") != 2 {
		t.Fatalf("qlever %d wdqs %d", e.count("qlever.dev"), e.count("query.wikidata.org"))
	}
	g := groups(claims)
	if len(g) != 1 {
		t.Fatalf("groups = %v", g)
	}
	m := g["movie Q83495"]
	checks := map[string]any{
		model.FieldTitle: "Matrix", model.FieldOriginalTitle: "The Matrix", model.FieldYear: 1999, model.FieldLanguage: "en", model.FieldRuntime: 136,
		model.XIDField("imdb"): "tt0133093", model.XIDField("tmdb"): "movie/603", model.XIDField("tvdb"): "movie/169", model.XIDField("trakt"): "movie/the-matrix-1999",
		model.XIDField("letterboxd"): "the-matrix", model.XIDField("rottentomatoes"): "m/matrix",
	}
	for field, want := range checks {
		if m[field] != want {
			t.Errorf("%s = %v, want %v", field, m[field], want)
		}
	}
	if c := m[model.FieldCountries].([]string); !slices.Equal(c, []string{"AU", "US"}) {
		t.Errorf("countries = %v", c)
	}
	if gs := m[model.FieldGenres].([]string); !slices.Equal(gs, []string{"cyberpunk", "cine de acción"}) {
		t.Errorf("genres = %v", gs)
	}
	if a := m[model.FieldAliases].([]string); !slices.Equal(a, []string{"Matrix I"}) {
		t.Errorf("aliases = %v", a)
	}
	if _, ok := m[model.ParentXIDField("wikidata")]; ok {
		t.Error("a movie carries a parent")
	}
	if v := values(claims, model.XIDField("trakt")); !slices.Equal(v, []string{"movie/481", "movie/the-matrix-1999"}) {
		t.Errorf("trakt ids = %v", v)
	}
	if v := values(claims, model.XIDField("tmdb")); !slices.Equal(v, []string{"movie/603"}) {
		t.Errorf("tmdb ids = %v", v)
	}
	stored := rec.byHost("query.wikidata.org")
	if len(stored) != 2 {
		t.Fatalf("records = %d", len(stored))
	}
	for _, r := range stored {
		if r.Namespace != "imdb" || r.ExtValue != "tt0133093" || r.Kind != model.KindMovie || r.License != "CC0-1.0" {
			t.Errorf("provenance = %+v", r)
		}
	}
	if claims[0].RecordID != stored[1].ID {
		t.Errorf("record id = %s, want %s", claims[0].RecordID, stored[1].ID)
	}
	resolve := e.queries()[0]
	if !strings.Contains(resolve, `?item wdt:P345 "tt0133093"`) {
		t.Errorf("resolve query = %s", resolve)
	}
	facts := e.queries()[2]
	if !strings.Contains(facts, `VALUES ?item { wd:Q83495 }`) || !strings.Contains(facts, `LANG(?v) = "mul"`) || !strings.Contains(facts, `("P11460" wdt:P11460)`) {
		t.Errorf("facts query = %s", facts)
	}
}

func TestSeasonAndEpisodeCarryParents(t *testing.T) {
	season := tsv(itemHeader,
		[]string{q("Q1582890"), `"class"`, q("Q3464665"), ""},
		[]string{q("Q1582890"), `"class"`, q("Q5398426"), ""},
		[]string{q("Q1582890"), `"label"`, `"Breaking Bad, season 1"@en`, ""},
		[]string{q("Q1582890"), `"date"`, `2008-01-20T00:00:00Z`, ""},
		[]string{q("Q1582890"), `"P179"`, q("Q1079"), `"1"`},
		[]string{q("Q1582890"), `"P8013"`, `"shows/breaking-bad/seasons/1"`, ""},
		[]string{q("Q1582890"), `"P12397"`, `"30272"`, ""},
		[]string{q("Q1582890"), `"tmdbSeason"`, `"1396/01"`, ""},
	)
	e := &endpoints{qlever: http.StatusOK, resolve: tsv("?item", []string{q("Q1582890")}), facts: season}
	src, _ := newSource(t, e)
	claims, err := src.Lookup(context.Background(), model.KindSeason, model.NSTMDB, "tv/1396/1")
	if err != nil {
		t.Fatal(err)
	}
	s := groups(claims)["season Q1582890"]
	if s[model.ParentXIDField("wikidata")] != "Q1079" || s[model.FieldOrdinal] != 1 || s[model.FieldTitle] != "Breaking Bad, season 1" || s[model.FieldYear] != 2008 {
		t.Fatalf("season = %v", s)
	}
	if _, ok := s[model.XIDField("trakt")]; ok {
		t.Fatal("kept a trakt season path that is not a catalog id")
	}
	if s[model.XIDField("tvdb")] != "season/30272" || s[model.XIDField("tmdb")] != "tv/1396/1" {
		t.Fatalf("season ids = %v", s)
	}
	resolve := e.queries()[0]
	if !strings.Contains(resolve, `?bSeries wdt:P4983 "1396"`) || !strings.Contains(resolve, `pq:P1545 "1"`) || !strings.Contains(resolve, "wd:"+classSeason) {
		t.Fatalf("resolve = %s", resolve)
	}
	episode := tsv(itemHeader,
		[]string{q("Q14625947"), `"class"`, q("Q21191270"), ""},
		[]string{q("Q14625947"), `"label"`, `"Pilot"@en`, ""},
		[]string{q("Q14625947"), `"P179"`, q("Q1079"), `"1"`},
		[]string{q("Q14625947"), `"P4908"`, q("Q1582890"), `"1"`},
		[]string{q("Q14625947"), `"P2047"`, `58.0`, q("Q7727")},
		[]string{q("Q14625947"), `"P345"`, `"tt0959621"`, ""},
		[]string{q("Q14625947"), `"P7043"`, `"349232"`, ""},
		[]string{q("Q14625947"), `"tmdbSeason"`, `"1396/1"`, ""},
		[]string{q("Q14625947"), `"tmdbEpisode"`, `"1396/1/1"`, ""},
	)
	e2 := &endpoints{qlever: http.StatusOK, resolve: tsv("?item", []string{q("Q14625947")}), facts: episode}
	src2, _ := newSource(t, e2)
	claims, err = src2.Lookup(context.Background(), model.KindEpisode, model.NSWikidata, "Q14625947")
	if err != nil {
		t.Fatal(err)
	}
	ep := groups(claims)["episode Q14625947"]
	if ep[model.ParentXIDField("wikidata")] != "Q1582890" || ep[model.FieldOrdinal] != 1 || ep[model.FieldRuntime] != 58 || ep[model.XIDField("imdb")] != "tt0959621" {
		t.Fatalf("episode = %v", ep)
	}
	if len(e2.queries()) != 1 {
		t.Fatalf("a wikidata id needs no resolve query, ran %d", len(e2.queries()))
	}
	if v := values(claims, model.XIDField("tmdb")); !slices.Equal(v, []string{"tv/1396/1/1"}) {
		t.Fatalf("episode tmdb ids = %v", v)
	}
	if ep[model.XIDField("tvdb")] != "episode/349232" {
		t.Fatalf("episode tvdb id = %v", ep)
	}
	claims, err = src2.Lookup(context.Background(), model.KindEpisode, model.NSTVDB, "episode/349232")
	if err != nil || len(claims) == 0 {
		t.Fatalf("tvdb episode = %v %v", claims, err)
	}
	if resolve := e2.queries()[1]; !strings.Contains(resolve, `?item wdt:P7043 "349232"`) {
		t.Fatalf("tvdb resolve = %s", resolve)
	}
}

func TestSearchKeepsFilmsAndSeries(t *testing.T) {
	facts := tsv(itemHeader,
		[]string{q("Q1079"), `"class"`, q("Q5398426"), ""},
		[]string{q("Q1079"), `"label"`, `"Breaking Bad"@en`, ""},
		[]string{q("Q1079"), `"date"`, `2008-01-20T00:00:00Z`, ""},
		[]string{q("Q1079"), `"date"`, `2013-09-29T00:00:00Z`, ""},
		[]string{q("Q1079"), `"P4983"`, `"1396"`, ""},
		[]string{q("Q1079"), `"P4835"`, `"81189"`, ""},
		[]string{q("Q1079"), `"P8013"`, `"shows/breaking-bad"`, ""},
		[]string{q("Q1079"), `"P8600"`, `"169"`, ""},
		[]string{q("Q83495"), `"class"`, q("Q11424"), ""},
		[]string{q("Q83495"), `"label"`, `"The Matrix"@en`, ""},
		[]string{q("Q83495"), `"date"`, `1999-03-31T00:00:00Z`, ""},
		[]string{q("Q5"), `"label"`, `"human"@en`, ""},
	)
	e := &endpoints{qlever: http.StatusOK, facts: facts, search: `{"batchcomplete":"","query":{"searchinfo":{"totalhits":4},"search":[{"ns":0,"title":"Q1079"},{"ns":0,"title":"Q83495"},{"ns":0,"title":"Q5"},{"ns":120,"title":"Property:P31"}]}}`}
	src, rec := newSource(t, e)
	ctx := context.Background()
	claims, err := src.Search(ctx, "", "breaking", 2008)
	if err != nil {
		t.Fatal(err)
	}
	g := groups(claims)
	if len(g) != 1 {
		t.Fatalf("groups = %v", g)
	}
	s := g["series Q1079"]
	if s[model.XIDField("tmdb")] != "tv/1396" || s[model.XIDField("tvdb")] != "series/81189" || s[model.XIDField("trakt")] != "show/breaking-bad" || s[model.XIDField("tvmaze")] != "169" || s[model.FieldYear] != 2008 {
		t.Fatalf("series = %v", s)
	}
	var search *http.Request
	for _, r := range e.requests {
		if r.Host == "www.wikidata.org" {
			search = r
		}
	}
	if p := search.URL.Query(); p.Get("srsearch") != "breaking haswbstatement:P31=Q11424|P31=Q24862|P31=Q202866|P31=Q506240|P31=Q93204|P31=Q5398426|P31=Q15416|P31=Q1259759|P31=Q581714" || p.Get("srnamespace") != "0" || p.Get("srlimit") != "10" || p.Get("format") != "json" {
		t.Fatalf("search params = %v", p)
	}
	if facts := e.queries()[0]; !strings.Contains(facts, "VALUES ?item { wd:Q1079 wd:Q83495 wd:Q5 }") {
		t.Fatalf("facts = %s", facts)
	}
	if r := rec.byHost("www.wikidata.org"); len(r) != 1 || r[0].Namespace != "wikidata" {
		t.Fatalf("search provenance = %+v", r)
	}
	claims, err = src.Search(ctx, model.KindMovie, "breaking", 0)
	if err != nil {
		t.Fatal(err)
	}
	if g := groups(claims); len(g) != 1 || g["movie Q83495"] == nil {
		t.Fatalf("movie search = %v", g)
	}
	var movieSearch *http.Request
	for _, r := range e.requests {
		if r.Host == "www.wikidata.org" {
			movieSearch = r
		}
	}
	if q := movieSearch.URL.Query().Get("srsearch"); !strings.HasPrefix(q, "breaking haswbstatement:P31=Q11424|") || strings.Contains(q, "Q5398426") {
		t.Fatalf("movie search filter = %s", q)
	}
	if _, err := src.Search(ctx, model.KindEpisode, "pilot", 0); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("episode search = %v", err)
	}
}

func TestNotFoundAndErrors(t *testing.T) {
	e := &endpoints{qlever: http.StatusOK, resolve: tsv("?item")}
	src, _ := newSource(t, e)
	ctx := context.Background()
	claims, err := src.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt9999999")
	if err != nil || claims != nil {
		t.Fatalf("unknown id = %v %v", claims, err)
	}
	if len(e.queries()) != 1 {
		t.Fatalf("queries = %d", len(e.queries()))
	}
	before := len(e.queries())
	if claims, err := src.Lookup(ctx, model.KindMovie, model.NSTMDB, "tv/1396"); err != nil || claims != nil {
		t.Fatalf("kind mismatch = %v %v", claims, err)
	}
	if _, err := src.Lookup(ctx, model.KindSeason, model.NSTrakt, "season/3950"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("trakt season = %v", err)
	}
	if _, err := src.Lookup(ctx, model.KindMovie, "spotify", "abc"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("unmapped namespace = %v", err)
	}
	if _, err := src.Lookup(ctx, model.KindMovie, model.NSWikidata, "83495"); err == nil {
		t.Fatal("malformed item id accepted")
	}
	if len(e.queries()) != before {
		t.Fatal("rejected lookups reached the network")
	}
	down := &endpoints{qlever: http.StatusNotFound, wdqs: http.StatusNotFound}
	src2, _ := newSource(t, down)
	var se *outbound.StatusError
	if _, err := src2.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt0133093"); !errors.As(err, &se) || se.Status != http.StatusNotFound {
		t.Fatalf("both endpoints down = %v", err)
	}
	if down.count("qlever.dev") != 1 || down.count("query.wikidata.org") != 1 {
		t.Fatalf("qlever %d wdqs %d", down.count("qlever.dev"), down.count("query.wikidata.org"))
	}
}

func TestParseTerms(t *testing.T) {
	rows, err := parseTSV([]byte("?a\t?b\t?c\t?d\r\n" + `"tab\there \"q\" caf\u00e9 \U0001F600"@EN` + "\t<http://x/y>\t42\t\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["a"].value != "tab\there \"q\" café 😀" || rows[0]["a"].lang != "en" || rows[0]["b"].value != "http://x/y" || rows[0]["c"].value != "42" {
		t.Fatalf("rows = %+v", rows)
	}
	if _, ok := rows[0]["d"]; ok {
		t.Fatal("unbound column decoded")
	}
	for _, bad := range []string{"?a\n\"open", "?a\n\"bad \\x\"", "?a\t?b\nonly-one", ""} {
		if _, err := parseTSV([]byte(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	src := New(nil)
	if err := src.Configure(catalog.Keys{}, map[string]string{"language": "pt-BR"}); err != nil {
		t.Fatal(err)
	}
	if langs, base := src.languages(); !slices.Equal(langs, []string{"pt-br", "pt", "en", "mul"}) || base != "pt" {
		t.Fatalf("languages = %v %s", langs, base)
	}
	if literal("a\"b\\c\nd") != `"a\"b\\c\nd"` {
		t.Fatalf("literal = %s", literal("a\"b\\c\nd"))
	}
}
