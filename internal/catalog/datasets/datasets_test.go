package datasets

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store"
)

type fixture struct {
	body     []byte
	etag     string
	modified time.Time
	status   int
}

type seen struct {
	method, host, path, ifNoneMatch, ifModifiedSince string
}

// Serves fixture files with validators and records every request
type files struct {
	mu     sync.Mutex
	byPath map[string]fixture
	log    []seen
}

func (f *files) set(path string, fx fixture) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byPath[path] = fx
}

func (f *files) requests() []seen {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.log)
}

func (f *files) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.log = append(f.log, seen{r.Method, r.Header.Get("X-Original-Host"), r.URL.Path, r.Header.Get("If-None-Match"), r.Header.Get("If-Modified-Since")})
	fx, ok := f.byPath[r.URL.Path]
	f.mu.Unlock()
	switch {
	case !ok:
		http.NotFound(w, r)
	case fx.status != 0:
		w.WriteHeader(fx.status)
	default:
		w.Header().Set("ETag", fx.etag)
		http.ServeContent(w, r, filepath.Base(r.URL.Path), fx.modified, bytes.NewReader(fx.body))
	}
}

// Sends every request to the fixture server, keeping the original host in a header
type redirect struct{ to *url.URL }

func (rt redirect) RoundTrip(r *http.Request) (*http.Response, error) {
	out := r.Clone(r.Context())
	out.Header.Set("X-Original-Host", r.URL.Host)
	out.URL.Scheme, out.URL.Host, out.Host = rt.to.Scheme, rt.to.Host, rt.to.Host
	return http.DefaultTransport.RoundTrip(out)
}

type env struct {
	t      *testing.T
	ctx    context.Context
	st     *store.Store
	svc    *Service
	files  *files
	client *outbound.Client
	dir    string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	dir := t.TempDir()
	st, err := store.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	fs := &files{byPath: map[string]fixture{}}
	srv := httptest.NewServer(fs)
	t.Cleanup(srv.Close)
	to, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := outbound.New(catalog.NewRecorder(st.Ent), "discoflix-test", log)
	client.SetHTTPClient(&http.Client{Transport: redirect{to: to}})
	return &env{t: t, ctx: ctx, st: st, svc: New(st.DB, st.Ent, client, dir, log), files: fs, client: client, dir: dir}
}

func gz(t *testing.T, lines ...string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := io.WriteString(w, strings.Join(lines, "\n")+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func (e *env) count(query string) int {
	e.t.Helper()
	var n int
	if err := e.st.DB.QueryRowContext(e.ctx, query).Scan(&n); err != nil {
		e.t.Fatalf("%s: %v", query, err)
	}
	return n
}

func (e *env) tables() []string {
	e.t.Helper()
	rows, err := e.st.DB.QueryContext(e.ctx, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		e.t.Fatal(err)
	}
	return out
}

func (e *env) importOK(name string) catalog.DatasetResult {
	e.t.Helper()
	var last [2]int64
	res, err := e.svc.Import(e.ctx, name, func(rows, bytes int64) { last = [2]int64{rows, bytes} })
	if err != nil {
		e.t.Fatalf("import %s: %v", name, err)
	}
	if !res.Unchanged && (last[0] != res.Rows || last[1] != res.Bytes) {
		e.t.Fatalf("import %s: last progress %v, result rows %d bytes %d", name, last, res.Rows, res.Bytes)
	}
	return res
}

// Leaves only the downloaded file of each imported dataset in the datasets directory
func (e *env) assertCleanDir(want ...string) {
	e.t.Helper()
	entries, err := os.ReadDir(filepath.Join(e.dir, "datasets"))
	if err != nil {
		e.t.Fatal(err)
	}
	var got []string
	for _, en := range entries {
		got = append(got, en.Name())
	}
	slices.Sort(want)
	if !reflect.DeepEqual(got, want) {
		e.t.Fatalf("datasets dir holds %v, want %v", got, want)
	}
}

// Indexes claims by kind, record, and field
func index(claims []model.Claim) map[string]any {
	out := map[string]any{}
	for _, c := range claims {
		out[c.Kind+" "+c.ExternalID+" "+c.Field] = c.Value
	}
	return out
}

// Lists distinct records in first-seen order
func records(claims []model.Claim) []string {
	var out []string
	for _, c := range claims {
		if r := c.Kind + " " + c.ExternalID; !slices.Contains(out, r) {
			out = append(out, r)
		}
	}
	return out
}

func expectClaims(t *testing.T, claims []model.Claim, want map[string]any) {
	t.Helper()
	got := index(claims)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("claims\n got %#v\nwant %#v", got, want)
	}
}

func TestList(t *testing.T) {
	e := newEnv(t)
	got := e.svc.List()
	want := []catalog.DatasetInfo{
		{Name: "imdb.basics", Title: "IMDb title basics", License: imdbLicense, URL: "https://datasets.imdbws.com/title.basics.tsv.gz", Default: false},
		{Name: "imdb.ratings", Title: "IMDb title ratings", License: imdbLicense, URL: "https://datasets.imdbws.com/title.ratings.tsv.gz", Default: false},
		{Name: "imdb.akas", Title: "IMDb alternative titles", License: imdbLicense, URL: "https://datasets.imdbws.com/title.akas.tsv.gz"},
		{Name: "imdb.episode", Title: "IMDb episodes", License: imdbLicense, URL: "https://datasets.imdbws.com/title.episode.tsv.gz"},
		{Name: "tmdb.movies", Title: "TMDB movie ids", License: tmdbLicense, URL: "https://files.tmdb.org/p/exports/movie_ids_MM_DD_YYYY.json.gz", Default: true},
		{Name: "tmdb.series", Title: "TMDB series ids", License: tmdbLicense, URL: "https://files.tmdb.org/p/exports/tv_series_ids_MM_DD_YYYY.json.gz", Default: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("list\n got %+v\nwant %+v", got, want)
	}
	if imdbLicense != "IMDb Non-Commercial Licensing, personal and non-commercial use only, never redistributed" || tmdbLicense != "TMDB API terms, not endorsed or certified by TMDB" {
		t.Fatal("license strings changed")
	}
	policies := e.client.Policies()
	for _, name := range []string{"imdb-datasets", "tmdb-exports"} {
		p, ok := policies[name]
		if !ok || p.Rate != 1 || p.Burst != 1 || p.Timeout != 30*time.Minute {
			t.Fatalf("policy %s registered as %+v", name, p)
		}
	}
	sources := e.svc.Sources()
	wantSources := []struct{ id, name, ns, kinds, policy string }{
		{"discoflix.source.imdb", "imdb", "imdb", "movie series season episode", "imdb"},
		{"discoflix.source.tmdbexport", "tmdbexport", "tmdb", "movie series", "tmdbexport"},
	}
	if len(sources) != len(wantSources) {
		t.Fatalf("%d sources", len(sources))
	}
	for i, w := range wantSources {
		src := sources[i]
		d := src.Describe()
		local, isLocal := src.(catalog.Local)
		p := src.Policy()
		if d.ID != w.id || d.Kind != "metadata-source" || d.Origin != "builtin" || src.Name() != w.name ||
			strings.Join(src.Namespaces(), " ") != w.ns || strings.Join(src.Kinds(), " ") != w.kinds ||
			src.NeedsKey() || !isLocal || !local.Local() || p.Name != w.policy || p.Rate != 0 || p.Budget != 0 {
			t.Fatalf("source %d described as %+v policy %+v", i, d, p)
		}
		if err := src.Configure(catalog.Keys{}, map[string]string{"language": "de"}); err != nil {
			t.Fatalf("configure %s: %v", w.name, err)
		}
	}
}

func TestNotImported(t *testing.T) {
	e := newEnv(t)
	imdb, tmdb := e.svc.Sources()[0], e.svc.Sources()[1]
	checks := []struct {
		name string
		err  error
		text string
	}{
		{"imdb lookup", second(imdb.Lookup(e.ctx, model.KindMovie, model.NSIMDb, "tt0133093")), "the IMDb datasets are not imported yet"},
		{"imdb search", second(imdb.Search(e.ctx, model.KindMovie, "The Matrix", 1999)), "the IMDb datasets are not imported yet"},
		{"tmdb lookup", second(tmdb.Lookup(e.ctx, model.KindMovie, model.NSTMDB, "movie/603")), "the TMDB movie export is not imported yet"},
		{"tmdb search", second(tmdb.Search(e.ctx, model.KindSeries, "Breaking Bad", 0)), "the TMDB series export is not imported yet"},
	}
	for _, c := range checks {
		if !errors.Is(c.err, ErrNotImported) || !strings.Contains(c.err.Error(), c.text) {
			t.Fatalf("%s returned %v", c.name, c.err)
		}
	}
}

func second(_ []model.Claim, err error) error { return err }

var (
	modified = time.Date(2026, 11, 7, 8, 0, 0, 0, time.UTC)

	basicsV1 = []string{
		"tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres",
		"tt0133093\tmovie\tThe Matrix\tThe Matrix\t0\t1999\t\\N\t136\tAction,Sci-Fi",
		"tt0211915\tmovie\tAmélie\tLe fabuleux destin d'Amélie Poulain\t0\t2001\t\\N\t122\tComedy,Romance",
		"tt0903747\ttvSeries\tBreaking Bad\tBreaking Bad\t0\t2008\t2013\t49\tCrime,Drama,Thriller",
		"tt0959621\ttvEpisode\tPilot\tPilot\t0\t2008\t\\N\t58\tCrime,Drama,Thriller",
		"tt9999991\tmovie\tAfter Dark\tAfter Dark\t1\t2010\t\\N\t\\N\tAdult",
	}
	basicsV2 = []string{
		basicsV1[0],
		"tt0133093\tmovie\tThe Matrix\tThe Matrix\t0\t1999\t\\N\t137\tAction,Sci-Fi",
		basicsV1[2], basicsV1[3], basicsV1[4],
		"tt0234215\tmovie\tThe Matrix Reloaded\tThe Matrix Reloaded\t0\t2003\t\\N\t138\tAction,Sci-Fi",
	}
	ratings = []string{
		"tconst\taverageRating\tnumVotes",
		"tt0133093\t8.7\t2100000",
		"tt0211915\t8.3\t800000",
		"tt0903747\t9.5\t2200000",
		"tt0959621\t9.0\t40000",
	}
	akas = []string{
		"titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle",
		"tt0133093\t1\tThe Matrix\t\\N\t\\N\toriginal\t\\N\t1",
		"tt0133093\t2\tMatrix\tDE\t\\N\timdbDisplay\t\\N\t0",
		"tt0211915\t1\tDie fabelhafte Welt der Amélie\tDE\tde\timdbDisplay\t\\N\t0",
	}
	episodes = []string{
		"tconst\tparentTconst\tseasonNumber\tepisodeNumber",
		"tt0959621\ttt0903747\t1\t1",
	}
)

func (e *env) serveIMDb(file string, lines []string, etag string) []byte {
	body := gz(e.t, lines...)
	e.files.set("/"+file, fixture{body: body, etag: etag, modified: modified})
	return body
}

func TestIMDbImport(t *testing.T) {
	e := newEnv(t)
	imdb := e.svc.Sources()[0]
	before := e.tables()
	if err := os.MkdirAll(filepath.Join(e.dir, "datasets"), 0o750); err != nil {
		t.Fatal(err)
	}
	for _, leftover := range []string{"staging-imdb.basics.db", "staging-imdb.basics.db-journal", "imdb.basics.123.part"} {
		if err := os.WriteFile(filepath.Join(e.dir, "datasets", leftover), []byte("crashed"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	body := e.serveIMDb("title.basics.tsv.gz", basicsV1, `"basics-1"`)
	res := e.importOK("imdb.basics")
	if res.Rows != 5 || res.Bytes != int64(len(body)) || res.ETag != `"basics-1"` || !res.LastModified.Equal(modified) || res.Unchanged {
		t.Fatalf("basics import %+v", res)
	}
	if got := e.files.requests()[0]; got.method != http.MethodGet || got.host != "datasets.imdbws.com" || got.path != "/title.basics.tsv.gz" || got.ifNoneMatch != "" {
		t.Fatalf("basics request %+v", got)
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_titles"); n != 5 {
		t.Fatalf("%d titles", n)
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_titles WHERE id = 'tt9999991' AND adult = 1 AND runtime = 0 AND genres = 'Adult'"); n != 1 {
		t.Fatal("adult title not kept with its flag")
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_titles WHERE id = 'tt0211915' AND normalized = 'amelie' AND start_year = 2001 AND end_year = 0"); n != 1 {
		t.Fatal("amelie row not normalized")
	}
	e.assertFTS(map[string]string{
		"tt0133093": "The Matrix",
		"tt0211915": "Amélie" + titleJoin + "Le fabuleux destin d'Amélie Poulain",
		"tt0903747": "Breaking Bad",
		"tt9999991": "After Dark",
	})
	if after := e.tables(); !reflect.DeepEqual(before, after) {
		t.Fatalf("tables changed\nbefore %v\nafter  %v", before, after)
	}
	e.assertCleanDir("imdb.basics.gz")
	row, err := e.st.Ent.DatasetImport.Get(e.ctx, "imdb.basics")
	if err != nil || row.Etag != `"basics-1"` || row.LastModified == nil || !row.LastModified.Equal(modified) || row.Rows != 5 || row.State != "done" {
		t.Fatalf("import row %+v %v", row, err)
	}

	if _, err := imdb.Lookup(e.ctx, model.KindEpisode, model.NSIMDb, "tt0959621"); !errors.Is(err, ErrNotImported) || !strings.Contains(err.Error(), "episode dataset is not imported yet") {
		t.Fatalf("episode lookup without the episode dataset returned %v", err)
	}

	e.serveIMDb("title.ratings.tsv.gz", ratings, `"ratings-1"`)
	e.serveIMDb("title.akas.tsv.gz", akas, `"akas-1"`)
	e.serveIMDb("title.episode.tsv.gz", episodes, `"episode-1"`)
	for name, rows := range map[string]int64{"imdb.ratings": 4, "imdb.akas": 3, "imdb.episode": 1} {
		if res := e.importOK(name); res.Rows != rows {
			t.Fatalf("%s loaded %d rows", name, res.Rows)
		}
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_akas WHERE normalized = 'die fabelhafte welt der amelie' AND region = 'DE' AND language = 'de'"); n != 1 {
		t.Fatal("aka not normalized")
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_ratings WHERE id = 'tt0133093' AND rating = 8.7 AND votes = 2100000"); n != 1 {
		t.Fatal("rating not loaded")
	}

	again := e.importOK("imdb.basics")
	if !again.Unchanged || again.ETag != `"basics-1"` || !again.LastModified.Equal(modified) || again.Rows != 0 {
		t.Fatalf("second basics import %+v", again)
	}
	reqs := e.files.requests()
	if last := reqs[len(reqs)-1]; last.ifNoneMatch != `"basics-1"` || last.ifModifiedSince != modified.Format(http.TimeFormat) {
		t.Fatalf("revalidation request %+v", last)
	}

	matrix := map[string]any{
		"movie tt0133093 title":          "The Matrix",
		"movie tt0133093 original_title": "The Matrix",
		"movie tt0133093 year":           1999,
		"movie tt0133093 runtime":        136,
		"movie tt0133093 genres":         []string{"Action", "Sci-Fi"},
		"movie tt0133093 rating.imdb":    8.7,
		"movie tt0133093 votes.imdb":     2100000,
		"movie tt0133093 aliases":        []string{"Matrix"},
		"movie tt0133093 xid.imdb":       "tt0133093",
	}
	claims, err := imdb.Lookup(e.ctx, model.KindMovie, model.NSIMDb, "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, matrix)
	if claims, err := imdb.Lookup(e.ctx, model.KindSeries, model.NSIMDb, "tt0133093"); err != nil || claims != nil {
		t.Fatalf("series lookup of a movie returned %v %v", claims, err)
	}
	if claims, err := imdb.Lookup(e.ctx, model.KindMovie, model.NSIMDb, "tt7777777"); err != nil || claims != nil {
		t.Fatalf("lookup of a missing title returned %v %v", claims, err)
	}
	if _, err := imdb.Lookup(e.ctx, model.KindMovie, model.NSIMDb, "nm0000206"); err == nil {
		t.Fatal("lookup of a person id succeeded")
	}
	if _, err := imdb.Lookup(e.ctx, model.KindMovie, model.NSTMDB, "movie/603"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("lookup in another namespace returned %v", err)
	}

	pilot := map[string]any{
		"episode tt0959621 title":           "Pilot",
		"episode tt0959621 original_title":  "Pilot",
		"episode tt0959621 year":            2008,
		"episode tt0959621 runtime":         58,
		"episode tt0959621 genres":          []string{"Crime", "Drama", "Thriller"},
		"episode tt0959621 rating.imdb":     9.0,
		"episode tt0959621 votes.imdb":      40000,
		"episode tt0959621 xid.imdb":        "tt0959621",
		"episode tt0959621 ordinal":         1,
		"episode tt0959621 parent.xid.imdb": "tt0903747/1",
	}
	season := map[string]any{
		"season tt0903747/1 ordinal":         1,
		"season tt0903747/1 parent.xid.imdb": "tt0903747",
	}
	claims, err = imdb.Lookup(e.ctx, model.KindEpisode, model.NSIMDb, "tt0959621")
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, merge(pilot, season))
	if got := records(claims); !reflect.DeepEqual(got, []string{"episode tt0959621", "season tt0903747/1"}) {
		t.Fatalf("episode lookup groups %v", got)
	}
	claims, err = imdb.Lookup(e.ctx, model.KindSeason, model.NSIMDb, "tt0903747/1")
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, merge(season, pilot))
	if got := records(claims); !reflect.DeepEqual(got, []string{"season tt0903747/1", "episode tt0959621"}) {
		t.Fatalf("season lookup groups %v", got)
	}
	if claims, err := imdb.Lookup(e.ctx, model.KindSeason, model.NSIMDb, "tt0903747/9"); err != nil || claims != nil {
		t.Fatalf("lookup of a missing season returned %v %v", claims, err)
	}

	searches := []struct {
		kind, text string
		year       int
		want       []string
	}{
		{model.KindMovie, "The Matrix", 1999, []string{"movie tt0133093"}},
		{"", "the matrix", 0, []string{"movie tt0133093"}},
		{model.KindMovie, "matrix", 2005, nil},
		{"", "fabuleux destin", 0, []string{"movie tt0211915"}},
		{"", "Amélie Le fabuleux", 0, nil},
		{"", "Die fabelhafte Welt der Amelie", 2002, []string{"movie tt0211915"}},
		{model.KindSeries, "breaking bad", 2008, []string{"series tt0903747"}},
		{model.KindMovie, "breaking bad", 0, nil},
		{model.KindEpisode, "Pilot", 0, []string{"episode tt0959621"}},
		{"", "Pilot", 0, nil},
		{"", "after", 0, []string{"movie tt9999991"}},
		{"", "!!!", 0, nil},
	}
	for _, s := range searches {
		claims, err := imdb.Search(e.ctx, s.kind, s.text, s.year)
		if err != nil {
			t.Fatalf("search %q: %v", s.text, err)
		}
		if got := records(claims); !reflect.DeepEqual(got, s.want) {
			t.Fatalf("search %s %q %d found %v, want %v", s.kind, s.text, s.year, got, s.want)
		}
	}
	claims, err = imdb.Search(e.ctx, model.KindMovie, "The Matrix", 1999)
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, matrix)
	claims, err = imdb.Search(e.ctx, model.KindEpisode, "pilot", 2008)
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, pilot)
	if _, err := imdb.Search(e.ctx, model.KindSeason, "Season 1", 0); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("season search returned %v", err)
	}

	e.serveIMDb("title.basics.tsv.gz", basicsV2, `"basics-2"`)
	var midLoad [3]int
	res, err = e.svc.Import(e.ctx, "imdb.basics", func(rows, _ int64) {
		if rows == 5 {
			midLoad = [3]int{
				e.count("SELECT COUNT(*) FROM im_db_titles WHERE id = 'tt9999991'"),
				e.count("SELECT runtime FROM im_db_titles WHERE id = 'tt0133093'"),
				e.count("SELECT COUNT(*) FROM imdb_title_fts WHERE tconst = 'tt0234215'"),
			}
		}
	})
	if err != nil || res.Rows != 5 || res.Unchanged || res.ETag != `"basics-2"` {
		t.Fatalf("changed basics import %+v %v", res, err)
	}
	if midLoad != [3]int{1, 136, 0} {
		t.Fatalf("readers saw %v while the new file was staged, want the old rows", midLoad)
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_titles"); n != 5 {
		t.Fatalf("%d titles after the change", n)
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_titles WHERE id = 'tt9999991'"); n != 0 {
		t.Fatal("vanished title kept")
	}
	if n := e.count("SELECT runtime FROM im_db_titles WHERE id = 'tt0133093'"); n != 137 {
		t.Fatalf("changed runtime is %d", n)
	}
	e.assertFTS(map[string]string{
		"tt0133093": "The Matrix",
		"tt0211915": "Amélie" + titleJoin + "Le fabuleux destin d'Amélie Poulain",
		"tt0234215": "The Matrix Reloaded",
		"tt0903747": "Breaking Bad",
	})
	if after := e.tables(); !reflect.DeepEqual(before, after) {
		t.Fatalf("tables changed after the swap\nbefore %v\nafter  %v", before, after)
	}
	claims, err = imdb.Search(e.ctx, model.KindMovie, "matrix", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := records(claims); !reflect.DeepEqual(got, []string{"movie tt0133093", "movie tt0234215"}) {
		t.Fatalf("matrix search after the change found %v", got)
	}

	broken := gz(t, basicsV1...)
	e.files.set("/title.basics.tsv.gz", fixture{body: broken[:len(broken)-12], etag: `"basics-3"`, modified: modified.Add(time.Hour)})
	if _, err := e.svc.Import(e.ctx, "imdb.basics", nil); err == nil {
		t.Fatal("truncated basics imported")
	}
	if n := e.count("SELECT COUNT(*) FROM im_db_titles WHERE id IN ('tt0234215', 'tt0133093')"); n != 2 {
		t.Fatal("failed import touched the live titles")
	}
	if n := e.count("SELECT COUNT(*) FROM imdb_title_fts"); n != 4 {
		t.Fatalf("failed import left %d indexed titles", n)
	}
	if row, err := e.st.Ent.DatasetImport.Get(e.ctx, "imdb.basics"); err != nil || row.Etag != `"basics-2"` {
		t.Fatalf("failed import recorded %+v %v", row, err)
	}
	if after := e.tables(); !reflect.DeepEqual(before, after) {
		t.Fatalf("failed import left tables\nbefore %v\nafter  %v", before, after)
	}
	e.assertCleanDir("imdb.basics.gz", "imdb.ratings.gz", "imdb.akas.gz", "imdb.episode.gz")
}

func (e *env) assertFTS(want map[string]string) {
	e.t.Helper()
	rows, err := e.st.DB.QueryContext(e.ctx, "SELECT rowid, tconst, title FROM imdb_title_fts")
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	got := map[string]string{}
	for rows.Next() {
		var rowid int64
		var tconst, title string
		if err := rows.Scan(&rowid, &tconst, &title); err != nil {
			e.t.Fatal(err)
		}
		if fmt.Sprintf("tt%07d", rowid) != tconst {
			e.t.Fatalf("title index rowid %d holds %s", rowid, tconst)
		}
		got[tconst] = title
	}
	if err := rows.Err(); err != nil {
		e.t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		e.t.Fatalf("title index\n got %q\nwant %q", got, want)
	}
}

func merge(parts ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, m := range parts {
		maps.Copy(out, m)
	}
	return out
}

func TestTMDBExportFallback(t *testing.T) {
	e := newEnv(t)
	e.svc.now = func() time.Time { return time.Date(2026, 11, 8, 6, 30, 0, 0, time.UTC) }
	tmdb := e.svc.Sources()[1]
	before := e.tables()
	movies := gz(t,
		`{"adult":false,"id":603,"original_title":"The Matrix","popularity":80.5,"video":false}`,
		`{"adult":false,"id":604,"original_title":"The Matrix Reloaded","popularity":40.25,"video":false}`,
	)
	e.files.set("/p/exports/movie_ids_11_08_2026.json.gz", fixture{status: http.StatusForbidden})
	e.files.set("/p/exports/movie_ids_11_07_2026.json.gz", fixture{body: movies, etag: `"movies-1107"`, modified: modified})
	e.files.set("/p/exports/tv_series_ids_11_08_2026.json.gz", fixture{body: gz(t, `{"id":1396,"original_name":"Breaking Bad","popularity":300.5}`), etag: `"series-1108"`, modified: modified.Add(24 * time.Hour)})

	res := e.importOK("tmdb.movies")
	if res.Rows != 2 || res.Bytes != int64(len(movies)) || res.ETag != `"movies-1107"` || !res.LastModified.Equal(modified) {
		t.Fatalf("movie export import %+v", res)
	}
	want := []seen{
		{http.MethodHead, "files.tmdb.org", "/p/exports/movie_ids_11_08_2026.json.gz", "", ""},
		{http.MethodHead, "files.tmdb.org", "/p/exports/movie_ids_11_07_2026.json.gz", "", ""},
		{http.MethodGet, "files.tmdb.org", "/p/exports/movie_ids_11_07_2026.json.gz", "", ""},
	}
	if got := e.files.requests(); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests\n got %+v\nwant %+v", got, want)
	}
	if n := e.count("SELECT COUNT(*) FROM tmdb_exports WHERE kind = 'movie' AND normalized = 'the matrix reloaded' AND popularity = 40.25 AND adult = 0"); n != 1 {
		t.Fatal("movie export row not loaded")
	}

	claims, err := tmdb.Lookup(e.ctx, model.KindMovie, model.NSTMDB, "movie/603")
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, map[string]any{
		"movie movie/603 original_title": "The Matrix",
		"movie movie/603 popularity":     80.5,
		"movie movie/603 xid.tmdb":       "movie/603",
	})
	if _, err := tmdb.Lookup(e.ctx, "", model.NSTMDB, "tv/1396"); !errors.Is(err, ErrNotImported) || !strings.Contains(err.Error(), "TMDB series export is not imported yet") {
		t.Fatalf("series lookup before the series export returned %v", err)
	}
	if _, err := tmdb.Lookup(e.ctx, "", model.NSTMDB, "tv/1396/1"); !errors.Is(err, catalog.ErrUnsupported) {
		t.Fatalf("season lookup returned %v", err)
	}
	if claims, err := tmdb.Lookup(e.ctx, model.KindSeries, model.NSTMDB, "movie/603"); err != nil || claims != nil {
		t.Fatalf("series lookup of a movie returned %v %v", claims, err)
	}
	if _, err := tmdb.Search(e.ctx, "", "the matrix", 0); !errors.Is(err, ErrNotImported) {
		t.Fatalf("search across kinds before the series export returned %v", err)
	}
	claims, err = tmdb.Search(e.ctx, model.KindMovie, "The Matrix", 1999)
	if err != nil {
		t.Fatal(err)
	}
	if got := records(claims); !reflect.DeepEqual(got, []string{"movie movie/603", "movie movie/604"}) {
		t.Fatalf("movie search found %v", got)
	}

	if res := e.importOK("tmdb.series"); res.Rows != 1 || res.ETag != `"series-1108"` {
		t.Fatalf("series export import %+v", res)
	}
	claims, err = tmdb.Search(e.ctx, "", "breaking", 0)
	if err != nil {
		t.Fatal(err)
	}
	expectClaims(t, claims, map[string]any{
		"series tv/1396 original_title": "Breaking Bad",
		"series tv/1396 popularity":     300.5,
		"series tv/1396 xid.tmdb":       "tv/1396",
	})

	again := e.importOK("tmdb.movies")
	if !again.Unchanged || again.ETag != `"movies-1107"` {
		t.Fatalf("second movie export import %+v", again)
	}
	reqs := e.files.requests()
	if last := reqs[len(reqs)-1]; last.path != "/p/exports/movie_ids_11_07_2026.json.gz" || last.ifNoneMatch != `"movies-1107"` {
		t.Fatalf("revalidation request %+v", last)
	}
	if n := e.count("SELECT COUNT(*) FROM tmdb_exports"); n != 3 {
		t.Fatalf("%d export rows", n)
	}
	if after := e.tables(); !reflect.DeepEqual(before, after) {
		t.Fatalf("tables changed\nbefore %v\nafter  %v", before, after)
	}
	e.assertCleanDir("tmdb.movies.gz", "tmdb.series.gz")
}

func TestTMDBExportMissing(t *testing.T) {
	e := newEnv(t)
	e.svc.now = func() time.Time { return time.Date(2026, 3, 2, 23, 0, 0, 0, time.UTC) }
	_, err := e.svc.Import(e.ctx, "tmdb.movies", nil)
	if err == nil || !strings.Contains(err.Error(), "no movie_ids export was published in the last 4 days") {
		t.Fatalf("import without any export returned %v", err)
	}
	var paths []string
	for _, r := range e.files.requests() {
		if r.method != http.MethodHead {
			t.Fatalf("unexpected %s request", r.method)
		}
		paths = append(paths, r.path)
	}
	want := []string{
		"/p/exports/movie_ids_03_02_2026.json.gz",
		"/p/exports/movie_ids_03_01_2026.json.gz",
		"/p/exports/movie_ids_02_28_2026.json.gz",
		"/p/exports/movie_ids_02_27_2026.json.gz",
	}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("probed %v", paths)
	}
	if _, err := e.svc.Import(e.ctx, "imdb.nope", nil); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("unknown dataset returned %v", err)
	}
}
