package snapshot_test

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/snapshot"
	"github.com/nickheyer/DiscoFlix/snapshot/snapshottest"
)

var quiet = slog.New(slog.DiscardHandler)

func extract(t *testing.T, x *snapshot.Extractor) map[int64]*snapshot.Item {
	t.Helper()
	x.Log = quiet
	d, err := x.Extract(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[int64]*snapshot.Item{}
	for _, it := range d.Items {
		out[it.QID] = it
	}
	return out
}

func xid(it *snapshot.Item, ns string) []string {
	var out []string
	for _, x := range it.XIDs {
		if x.Namespace == ns {
			out = append(out, x.Value)
		}
	}
	return out
}

func TestExtractClassifiesLinksAndPicksNames(t *testing.T) {
	e := snapshottest.NewEndpoint()
	x := &snapshot.Extractor{Endpoint: e, PageSize: 2}
	x.Log = quiet
	d, err := x.Extract(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	items := map[int64]*snapshot.Item{}
	for _, it := range d.Items {
		items[it.QID] = it
	}
	kinds := map[int64]string{83495: "movie", 99999: "movie", 55: "movie", 3000: "movie", 1079: "series", 3001: "series", 2001: "season", 2002: "episode", 4000: "episode"}
	if len(items) != len(kinds) {
		t.Fatalf("items = %d, want %d", len(items), len(kinds))
	}
	for qid, kind := range kinds {
		if items[qid] == nil || items[qid].Kind != kind {
			t.Fatalf("Q%d = %+v, want kind %s", qid, items[qid], kind)
		}
	}
	m := items[83495]
	if m.Label != "The Matrix" || m.OriginalTitle != "The Matrix" || m.Year != 1999 || m.Runtime != 136 || m.Lang != "en" || !slices.Equal(m.Countries, []string{"US"}) {
		t.Fatalf("matrix = %+v", m)
	}
	for ns, want := range map[string]string{model.NSIMDb: "tt0133093", model.NSTMDB: "movie/603", model.NSTVDB: "movie/169", model.NSTrakt: "movie/the-matrix-1999", model.NSLetterboxd: "the-matrix", model.NSWikidata: "Q83495"} {
		if got := xid(m, ns); !slices.Equal(got, []string{want}) {
			t.Fatalf("matrix %s = %v, want %s", ns, got, want)
		}
	}
	if got := xid(items[99999], model.NSTMDB); !slices.Equal(got, []string{"movie/604"}) {
		t.Fatalf("reloaded tmdb = %v, the colliding movie/603 must stay with Q83495", got)
	}
	if d.Collisions[model.NSTMDB] != 1 || d.Skipped[model.NSTrakt] != 1 {
		t.Fatalf("collisions %v skipped %v", d.Collisions, d.Skipped)
	}
	a := items[55]
	if a.Label != "Amélie" || a.OriginalTitle != "Le Fabuleux Destin d'Amélie Poulain" || a.Lang != "fr" || !slices.Equal(a.Countries, []string{"DE", "FR"}) || a.Runtime != 122 {
		t.Fatalf("amelie = %+v", a)
	}
	if bb := items[1079]; bb.Year != 2008 || !slices.Equal(xid(bb, model.NSTMDB), []string{"tv/1396"}) || !slices.Equal(xid(bb, model.NSTVDB), []string{"series/81189"}) || !slices.Equal(xid(bb, model.NSTrakt), []string{"show/breaking-bad"}) {
		t.Fatalf("breaking bad = %+v", bb)
	}
	if s := items[2001]; s.ParentQID != 1079 || s.Ordinal != 1 || s.Year != 2008 {
		t.Fatalf("season = %+v", s)
	}
	if ep := items[2002]; ep.ParentQID != 2001 || ep.Ordinal != 1 || ep.Runtime != 58 {
		t.Fatalf("pilot = %+v", ep)
	}
	if ep := items[4000]; ep.ParentQID != 0 || ep.Ordinal != 62 {
		t.Fatalf("felina = %+v", ep)
	}
	if items[3001].Label != "Late Talk" {
		t.Fatalf("talk show = %+v", items[3001])
	}
	paged := false
	for _, q := range e.Calls() {
		if q.Name == "kinds" && q.Offset > 0 {
			paged = true
		}
		if strings.Contains(q.Where, "VALUES ?item") {
			t.Fatalf("an unlimited run scoped %s by VALUES", q.Name)
		}
	}
	if !paged || d.Rows["kinds"] != 8 {
		t.Fatalf("kinds paged %v rows %d", paged, d.Rows["kinds"])
	}
}

func TestExtractShrinksTimedOutPages(t *testing.T) {
	e := snapshottest.NewEndpoint()
	e.TimeoutAbove = 1000
	extract(t, &snapshot.Extractor{Endpoint: e, PageSize: 4000})
	var limits []int
	for _, q := range e.Calls() {
		if q.Name == "kinds" {
			limits = append(limits, q.Limit)
		}
	}
	if !slices.Equal(limits, []int{4000, 2000, 1000}) {
		t.Fatalf("kinds limits = %v", limits)
	}
	e = snapshottest.NewEndpoint()
	e.TimeoutAbove = 500
	_, err := (&snapshot.Extractor{Endpoint: e, PageSize: 4000, Log: quiet}).Extract(context.Background())
	if !errors.Is(err, snapshot.ErrTimeout) {
		t.Fatalf("err = %v, want a timeout once the page cannot shrink", err)
	}
}

func TestExtractLimitKeepsCoherentFamilies(t *testing.T) {
	e := snapshottest.NewEndpoint()
	items := extract(t, &snapshot.Extractor{Endpoint: e, Limit: 1, Chunk: 2})
	want := map[int64]string{55: "movie", 1079: "series", 2001: "season", 2002: "episode"}
	if len(items) != len(want) {
		t.Fatalf("items = %v", items)
	}
	for qid, kind := range want {
		if items[qid] == nil || items[qid].Kind != kind {
			t.Fatalf("Q%d = %+v", qid, items[qid])
		}
	}
	var scopes []string
	for _, q := range e.Calls() {
		if q.Name == "label.en" {
			scopes = append(scopes, strings.SplitN(q.Where, "\n", 2)[0])
		}
	}
	if !slices.Equal(scopes, []string{"VALUES ?item { wd:Q55 wd:Q1079 }", "VALUES ?item { wd:Q2001 wd:Q2002 }"}) {
		t.Fatalf("label scopes = %q", scopes)
	}
}

func TestWriteProducesTheCheckpointedSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), snapshot.FileName)
	built := time.Date(2026, 11, 8, 4, 17, 0, 0, time.UTC)
	_, c, err := snapshottest.Build(ctx, path, built)
	if err != nil {
		t.Fatal(err)
	}
	if c.Meta.Version != "20261108T041700Z" || c.Meta.Items != 9 || c.Kinds["movie"] != 4 || c.XIDs[model.NSWikidata] != 9 {
		t.Fatalf("counts = %+v", c)
	}
	for _, companion := range []string{"-wal", "-shm", ".tmp"} {
		if _, err := os.Stat(path + companion); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s%s left behind: %v", path, companion, err)
		}
	}
	header := make([]byte, 100)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadFull(f, header)
	_ = f.Close()
	if err != nil || header[18] != 2 || header[19] != 2 {
		t.Fatalf("header %v err %v, want WAL read and write versions", header[16:20], err)
	}
	db, err := sql.Open("sqlite", snapshot.ReadOnlyDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	m, err := snapshot.ReadMeta(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity %q err %v", integrity, err)
	}
	if binary.BigEndian.Uint32(header[24:]) != binary.BigEndian.Uint32(header[92:]) {
		t.Fatalf("change counter %v and version-valid-for %v differ", header[24:28], header[92:96])
	}
	if m.Version != c.Meta.Version || !m.BuiltAt.Equal(built) || m.Source != "wikidata" || m.License != "CC0-1.0" || m.QLeverIndex != snapshottest.Index || m.XIDs != c.Meta.XIDs {
		t.Fatalf("meta = %+v", m)
	}
	var kind, label, original, lang, country string
	var year, runtime int
	if err := db.QueryRowContext(ctx, `SELECT kind, label, original_title, lang, country, year, runtime FROM item WHERE qid = 55`).Scan(&kind, &label, &original, &lang, &country, &year, &runtime); err != nil {
		t.Fatal(err)
	}
	if kind != "movie" || label != "Amélie" || lang != "fr" || country != "DE,FR" || year != 2001 || runtime != 122 {
		t.Fatalf("amelie row = %s %s %s %s %s %d %d", kind, label, original, lang, country, year, runtime)
	}
	var parent, ordinal int64
	if err := db.QueryRowContext(ctx, `SELECT parent_qid, ordinal FROM item WHERE qid = 2002`).Scan(&parent, &ordinal); err != nil || parent != 2001 || ordinal != 1 {
		t.Fatalf("pilot parent %d ordinal %d err %v", parent, ordinal, err)
	}
	var normalized string
	if err := db.QueryRowContext(ctx, `SELECT normalized FROM title WHERE item_id = 55 AND kind = 'original'`).Scan(&normalized); err != nil || normalized != "le fabuleux destin d amelie poulain" {
		t.Fatalf("normalized = %q err %v", normalized, err)
	}
	var hit int64
	if err := db.QueryRowContext(ctx, `SELECT t.item_id FROM title_fts f JOIN title t ON t.id = f.rowid WHERE title_fts MATCH '"fabuleux"' LIMIT 1`).Scan(&hit); err != nil || hit != 55 {
		t.Fatalf("fts hit %d err %v", hit, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT t.item_id FROM title_fts f JOIN title t ON t.id = f.rowid WHERE title_fts MATCH '"amelie"' LIMIT 1`).Scan(&hit); err != nil || hit != 55 {
		t.Fatalf("diacritic-free fts hit %d err %v", hit, err)
	}
}

func readJSON(t *testing.T, path string, out any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
}

func TestKeysPublishVerifyAndVersions(t *testing.T) {
	ctx := context.Background()
	r, err := snapshottest.NewRepo(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := snapshot.InitKeys(r.Keys, time.Now()); err == nil {
		t.Fatal("keys init overwrote existing keys")
	}
	var root metadata.Metadata[metadata.RootType]
	readJSON(t, filepath.Join(r.Keys, snapshot.RootFile), &root)
	if root.Signed.Version != 1 || !root.Signed.ConsistentSnapshot || len(root.Signed.Keys) != 2 || time.Until(root.Signed.Expires) < 729*24*time.Hour {
		t.Fatalf("root = %+v", root.Signed)
	}
	online := root.Signed.Roles[metadata.TARGETS].KeyIDs
	for _, role := range []string{metadata.SNAPSHOT, metadata.TIMESTAMP} {
		if !slices.Equal(root.Signed.Roles[role].KeyIDs, online) {
			t.Fatalf("%s keys %v, targets keys %v", role, root.Signed.Roles[role].KeyIDs, online)
		}
	}
	if slices.Equal(root.Signed.Roles[metadata.ROOT].KeyIDs, online) {
		t.Fatal("root and online roles share a key")
	}
	if info, err := os.Stat(filepath.Join(r.Keys, snapshot.OnlineKeyFile)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("online key mode %v err %v", info, err)
	}
	built := time.Now().Add(-time.Hour)
	p, err := r.Publish(ctx, built)
	if err != nil {
		t.Fatal(err)
	}
	if p.TargetsVersion != 1 || p.SnapshotVersion != 1 || p.TimestampVersion != 1 || p.RootVersion != 1 {
		t.Fatalf("first publish = %+v", p)
	}
	for _, name := range []string{"root.json", "1.root.json", "1.targets.json", "1.snapshot.json", "timestamp.json", p.Target} {
		if _, err := os.Stat(filepath.Join(r.Dir, name)); err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
	}
	if !strings.HasSuffix(p.Target, "."+snapshot.TargetName) || len(p.Target) != 64+1+len(snapshot.TargetName) {
		t.Fatalf("target file %s", p.Target)
	}
	var targets metadata.Metadata[metadata.TargetsType]
	readJSON(t, filepath.Join(r.Dir, "1.targets.json"), &targets)
	tf := targets.Signed.Targets[snapshot.TargetName]
	if tf == nil || tf.Length != p.TargetLength || time.Until(targets.Signed.Expires) < 59*24*time.Hour {
		t.Fatalf("targets = %+v", targets.Signed)
	}
	custom, err := snapshot.ParseCustom(tf.Custom)
	if err != nil || custom.Version != built.UTC().Format(snapshot.VersionLayout) || custom.Items != 9 || custom.XIDs != p.Custom.XIDs || custom.BuiltAt != built.UTC().Truncate(time.Second).Format(time.RFC3339) {
		t.Fatalf("custom = %+v err %v", custom, err)
	}
	var ts metadata.Metadata[metadata.TimestampType]
	readJSON(t, filepath.Join(r.Dir, "timestamp.json"), &ts)
	if left := time.Until(ts.Signed.Expires); left > 21*24*time.Hour || left < 20*24*time.Hour {
		t.Fatalf("timestamp expires in %s", left)
	}
	verified, err := snapshot.Verify(ctx, r.Dir, filepath.Join(r.Keys, snapshot.RootFile))
	if err != nil || verified != custom {
		t.Fatalf("verify = %+v err %v", verified, err)
	}
	p2, err := r.Publish(ctx, built.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if p2.TargetsVersion != 2 || p2.SnapshotVersion != 2 || p2.TimestampVersion != 2 || p2.Custom.Version <= p.Custom.Version {
		t.Fatalf("second publish = %+v", p2)
	}
	if verified, err = snapshot.Verify(ctx, r.Dir, filepath.Join(r.Keys, snapshot.RootFile)); err != nil || verified.Version != p2.Custom.Version {
		t.Fatalf("verify second = %+v err %v", verified, err)
	}
	_, err = snapshot.Publish(ctx, snapshot.PublishOptions{Repo: r.Dir, Root: filepath.Join(r.Keys, snapshot.RootFile), OnlineKey: filepath.Join(r.Keys, snapshot.RootKeyFile), SQLite: filepath.Join(filepath.Dir(r.Dir), p2.Custom.Version+".sqlite"), Now: time.Now()})
	if err == nil || !strings.Contains(err.Error(), "not a targets key") {
		t.Fatalf("publishing with the root key = %v", err)
	}
	if err := os.WriteFile(filepath.Join(r.Dir, p2.Target), make([]byte, p2.TargetLength), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshot.Verify(ctx, r.Dir, filepath.Join(r.Keys, snapshot.RootFile)); err == nil {
		t.Fatal("verify accepted a tampered target")
	}
}

// Serves one canned answer per request in arrival order
type scripted struct {
	mu      sync.Mutex
	answers []func(http.ResponseWriter)
	queries []string
}

func (s *scripted) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queries = append(s.queries, r.URL.Query().Get("query")+r.URL.Query().Get("cmd")+" accept="+r.Header.Get("Accept"))
	answer := s.answers[0]
	s.answers = s.answers[1:]
	answer(w)
}

func status(code int, body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}
}

func TestQLeverRetriesAndClassifiesFailures(t *testing.T) {
	ctx := context.Background()
	tsv := "?item\t?p\n<http://www.wikidata.org/entity/Q1>\t<http://www.wikidata.org/prop/direct/P4947>\n"
	s := &scripted{answers: []func(http.ResponseWriter){
		status(http.StatusTooManyRequests, `{"exception": "The query was rejected because all 32 threads for processing queries were busy", "status": "ERROR"}`),
		status(http.StatusBadGateway, "bad gateway"),
		status(http.StatusOK, tsv),
		status(http.StatusOK, tsv+" !!!!>># An error has occurred while exporting the query result. The error message was:\nOperation timed out.\n"),
		status(http.StatusTooManyRequests, `{"exception": "Operation timed out.", "status": "ERROR"}`),
		status(http.StatusBadRequest, `{"exception": "Invalid SPARQL query", "status": "ERROR"}`),
		status(http.StatusServiceUnavailable, "maintenance"),
		status(http.StatusOK, `{"name-index": "Complete Wikidata", "num-triples-normal": 1}`),
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c := snapshot.NewQLever(srv.URL, quiet)
	c.Backoff, c.Pace = time.Millisecond, 0
	q := snapshot.Query{Name: "kinds", Select: "?item ?p", Where: "?item ?p [] .", Limit: 10, Offset: 20}
	body, err := c.Select(ctx, q)
	if err != nil || string(body) != tsv {
		t.Fatalf("select = %q err %v", body, err)
	}
	if _, err := c.Select(ctx, q); !errors.Is(err, snapshot.ErrTimeout) {
		t.Fatalf("export marker err = %v", err)
	}
	if _, err := c.Select(ctx, q); !errors.Is(err, snapshot.ErrTimeout) {
		t.Fatalf("timed out answer err = %v", err)
	}
	if _, err := c.Select(ctx, q); err == nil || !strings.Contains(err.Error(), "Invalid SPARQL query") {
		t.Fatalf("bad query err = %v", err)
	}
	index, err := c.Index(ctx)
	if err != nil || index != "Complete Wikidata" {
		t.Fatalf("index = %q err %v", index, err)
	}
	if len(s.queries) != 8 || !strings.HasPrefix(s.queries[7], "stats accept=application/json") {
		t.Fatalf("requests = %d", len(s.queries))
	}
	first := s.queries[0]
	for _, want := range []string{"# discoflix crosswalk kinds\n", "PREFIX wdt: <http://www.wikidata.org/prop/direct/>", "SELECT ?item ?p WHERE {\n?item ?p [] .\n} LIMIT 10 OFFSET 20", "accept=text/tab-separated-values"} {
		if !strings.Contains(first, want) {
			t.Fatalf("query %q lacks %q", first, want)
		}
	}
}

func TestTermParsing(t *testing.T) {
	if qid, ok := snapshot.QID("<http://www.wikidata.org/entity/Q83495>"); !ok || qid != 83495 {
		t.Fatalf("qid = %d %v", qid, ok)
	}
	if _, ok := snapshot.QID("<http://www.wikidata.org/entity/P31>"); ok {
		t.Fatal("property read as an item")
	}
	if text, lang, ok := snapshot.Literal(`"The Making of "Rocky vs. Drago""@en`); !ok || text != `The Making of "Rocky vs. Drago"` || lang != "en" {
		t.Fatalf("literal = %q %q %v", text, lang, ok)
	}
	if text, _, ok := snapshot.Literal(`"2020"^^<http://www.w3.org/2001/XMLSchema#int>`); !ok || text != "2020" {
		t.Fatalf("typed literal = %q %v", text, ok)
	}
	if n, ok := snapshot.Number("6000.0"); !ok || n != 6000 {
		t.Fatalf("number = %v %v", n, ok)
	}
	if n, ok := snapshot.Ordinal(`"12a"`); !ok || n != 12 {
		t.Fatalf("ordinal = %d %v", n, ok)
	}
	if _, ok := snapshot.Ordinal(`"special"`); ok {
		t.Fatal("non-numeric ordinal accepted")
	}
	if !slices.Contains(snapshot.Namespaces(), model.NSPlex) || snapshot.Namespaces()[0] != model.NSWikidata || len(snapshot.Namespaces()) != 17 {
		t.Fatalf("namespaces = %v", snapshot.Namespaces())
	}
}

func TestEmbeddedRootIsSelfSigned(t *testing.T) {
	var root metadata.Metadata[metadata.RootType]
	if err := json.Unmarshal(snapshot.Root, &root); err != nil {
		t.Fatal(err)
	}
	if err := root.VerifyDelegate(metadata.ROOT, &root); err != nil {
		t.Fatalf("embedded root signature: %v", err)
	}
	if root.Signed.Version != 1 || !root.Signed.ConsistentSnapshot || root.Signed.Expires.Before(time.Now()) {
		t.Fatalf("embedded root = %+v", root.Signed)
	}
}
