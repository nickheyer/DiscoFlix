package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	crosswalk "github.com/nickheyer/DiscoFlix/snapshot"
	"github.com/nickheyer/DiscoFlix/snapshot/snapshottest"
)

var (
	_ catalog.Source    = (*Service)(nil)
	_ catalog.Local     = (*Service)(nil)
	_ catalog.Snapshots = (*Service)(nil)
)

type memRecorder struct{}

func (memRecorder) Latest(context.Context, string, string) (*outbound.Record, error) { return nil, nil }

func (memRecorder) Save(context.Context, *outbound.Record) (string, error) { return "", nil }
func (memRecorder) Touch(context.Context, string, time.Time) error         { return nil }
func (memRecorder) LoadCalls(context.Context, string) (int, time.Time, error) {
	return 0, time.Time{}, nil
}
func (memRecorder) StoreCalls(context.Context, string, int, time.Time) error      { return nil }
func (memRecorder) Health(context.Context, string, bool, string, time.Time) error { return nil }

var quiet = slog.New(slog.DiscardHandler)

func newService(t *testing.T, root []byte, mirror string, peers ...string) *Service {
	t.Helper()
	s, err := New(t.TempDir(), outbound.New(memRecorder{}, "discoflix-test", quiet), quiet, WithRoot(root))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	s.SetMirror(mirror, peers)
	return s
}

// Indexes one claim group by name, keeping every value of a repeated claim
func fields(t *testing.T, claims []model.Claim, ns, id string) map[string][]any {
	t.Helper()
	out := map[string][]any{}
	for _, c := range claims {
		if c.Namespace != ns || c.ExternalID != id {
			t.Fatalf("claim %+v is outside the group %s:%s", c, ns, id)
		}
		out[c.Field] = append(out[c.Field], c.Value)
	}
	return out
}

// External ids of search results in order
func groups(claims []model.Claim) []string {
	var out []string
	for _, c := range claims {
		if len(out) == 0 || out[len(out)-1] != c.ExternalID {
			out = append(out, c.ExternalID)
		}
	}
	return out
}

func sha(t *testing.T, path string) string {
	t.Helper()
	sum, _, err := crosswalk.FileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	return sum
}

func TestSourceDescriptor(t *testing.T) {
	s := newService(t, crosswalk.Root, "")
	d := s.Describe()
	if d.ID != "discoflix.source.snapshot" || d.Name != "Wikidata snapshot" || d.Version != "1" || d.Kind != extension.KindMetadataSource || d.Origin != "builtin" {
		t.Fatalf("descriptor = %+v", d)
	}
	if s.Name() != catalog.SourceSnapshot || !s.Local() || s.NeedsKey() || s.KeyHint() != "" || s.License() != "CC0-1.0" {
		t.Fatal("source identity is wrong")
	}
	if !slices.Equal(s.Kinds(), model.Kinds) || !slices.Contains(s.Namespaces(), model.NSKinopoisk) || !slices.Contains(s.Namespaces(), model.NSWikidata) {
		t.Fatalf("kinds %v namespaces %v", s.Kinds(), s.Namespaces())
	}
	if p := s.client.Policies()[MirrorPolicy]; p.Rate != 2 || p.Burst != 4 || p.Timeout != 10*time.Minute {
		t.Fatalf("mirror policy = %+v", p)
	}
	if mirror, _ := s.mirrorAndPeers(); mirror != DefaultMirror {
		t.Fatalf("mirror = %s", mirror)
	}
}

func TestSnapshotLifecycle(t *testing.T) {
	ctx := context.Background()
	repo, err := snapshottest.NewRepo(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	built := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	v1, err := repo.Publish(ctx, built)
	if err != nil {
		t.Fatal(err)
	}
	mirror := httptest.NewServer(http.FileServer(http.Dir(repo.Dir)))
	defer mirror.Close()

	first := newService(t, repo.Root, mirror.URL)
	if _, err := first.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/603"); !errors.Is(err, ErrNotDownloaded) {
		t.Fatalf("lookup before download = %v", err)
	}
	if _, err := first.Search(ctx, model.KindMovie, "the matrix", 0); !errors.Is(err, ErrNotDownloaded) || !strings.Contains(err.Error(), "has not been downloaded yet") {
		t.Fatalf("search before download = %v", err)
	}
	if cur := first.Current(); cur.Present || cur.Version != "" {
		t.Fatalf("current before download = %+v", cur)
	}
	check, err := first.Check(ctx)
	if err != nil || check.Remote != v1.Custom.Version || check.Local != "" || !check.Newer {
		t.Fatalf("check = %+v err %v", check, err)
	}
	var stages []string
	res, err := first.Update(ctx, func(stage string) { stages = append(stages, stage) })
	if err != nil || res.Via != ViaHTTP || res.Version != v1.Custom.Version || res.Bytes != v1.TargetLength || res.Skipped {
		t.Fatalf("update = %+v err %v", res, err)
	}
	if len(stages) < 3 {
		t.Fatalf("stages = %v", stages)
	}
	if got := sha(t, first.path); got != v1.Custom.SQLiteSHA256 {
		t.Fatalf("installed sha %s, signed %s", got, v1.Custom.SQLiteSHA256)
	}
	for _, leftover := range []string{first.next(), first.path + "-wal", filepath.Join(first.dir, tufDir, "targets", crosswalk.TargetName)} {
		if _, err := os.Stat(leftover); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s left behind: %v", leftover, err)
		}
	}
	cur := first.Current()
	if !cur.Present || cur.Version != v1.Custom.Version || !cur.BuiltAt.Equal(built) || cur.Items != 9 || cur.XIDs != v1.Custom.XIDs || cur.Bytes != v1.Custom.SQLiteLength || cur.Via != ViaHTTP || cur.UpdatedAt.IsZero() {
		t.Fatalf("current = %+v", cur)
	}
	if check, err = first.Check(ctx); err != nil || check.Newer || check.Local != v1.Custom.Version {
		t.Fatalf("check after update = %+v err %v", check, err)
	}
	if again, err := first.Update(ctx, nil); err != nil || !again.Skipped || again.Version != v1.Custom.Version {
		t.Fatalf("repeat update = %+v err %v", again, err)
	}

	t.Run("lookup", func(t *testing.T) { lookups(ctx, t, first) })
	t.Run("search", func(t *testing.T) { searches(ctx, t, first) })

	peerSrv := httptest.NewServer(first.Handler())
	defer peerSrv.Close()
	second := newService(t, repo.Root, mirror.URL, peerSrv.URL)
	empty := httptest.NewServer(second.Handler())
	defer empty.Close()
	if res, err := http.Get(empty.URL + VersionPath); err != nil || res.StatusCode != http.StatusNotFound {
		t.Fatalf("version from an empty peer = %v %v", res, err)
	} else {
		_ = res.Body.Close()
	}
	if res, err := http.Get(empty.URL + RsyncPath); err != nil || res.StatusCode != http.StatusNotFound {
		t.Fatalf("rsync from an empty peer = %v %v", res, err)
	} else {
		_ = res.Body.Close()
	}
	res, err = second.Update(ctx, nil)
	if err != nil || res.Via != ViaPeer || res.Version != v1.Custom.Version {
		t.Fatalf("peer update = %+v err %v", res, err)
	}
	if sha(t, second.path) != sha(t, first.path) || second.Current().Via != ViaPeer {
		t.Fatal("peer copy is not byte-identical")
	}
	if claims, err := second.Lookup(ctx, model.KindMovie, model.NSIMDb, "tt0133093"); err != nil || fields(t, claims, model.NSIMDb, "tt0133093")[model.FieldTitle][0] != "The Matrix" {
		t.Fatalf("lookup on the peer copy = %v %v", claims, err)
	}
	var offered peerVersion
	if res, err := http.Get(peerSrv.URL + VersionPath); err != nil || json.NewDecoder(res.Body).Decode(&offered) != nil || res.Body.Close() != nil {
		t.Fatalf("version endpoint = %v", err)
	}
	if offered.Version != v1.Custom.Version || offered.SQLiteSHA256 != v1.Custom.SQLiteSHA256 {
		t.Fatalf("offered = %+v", offered)
	}

	v2, err := repo.Publish(ctx, built.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if res, err := first.Update(ctx, nil); err != nil || res.Via != ViaHTTP || res.Version != v2.Custom.Version {
		t.Fatalf("first to v2 = %+v err %v", res, err)
	}
	if check, err := second.Check(ctx); err != nil || !check.Newer || check.Local != v1.Custom.Version || check.Remote != v2.Custom.Version {
		t.Fatalf("second check = %+v err %v", check, err)
	}
	res, err = second.Update(ctx, nil)
	if err != nil || res.Via != ViaPeer || res.Version != v2.Custom.Version {
		t.Fatalf("peer delta update = %+v err %v", res, err)
	}
	if sha(t, second.path) != v2.Custom.SQLiteSHA256 {
		t.Fatal("peer delta copy differs from the signed v2")
	}
	if res.Bytes >= v2.Custom.SQLiteLength {
		t.Fatalf("delta moved %d bytes for a %d byte file", res.Bytes, v2.Custom.SQLiteLength)
	}

	third := newService(t, repo.Root, mirror.URL, empty.URL+"/missing", peerSrv.URL+"/nothing-here")
	if res, err := third.Update(ctx, nil); err != nil || res.Via != ViaHTTP {
		t.Fatalf("update past unusable peers = %+v err %v", res, err)
	}

	v3, err := repo.Publish(ctx, built.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo.Dir, v3.Target), make([]byte, v3.TargetLength), 0o644); err != nil {
		t.Fatal(err)
	}
	before := sha(t, first.path)
	if _, err := first.Update(ctx, nil); err == nil {
		t.Fatal("a tampered target was accepted")
	}
	if first.Current().Version != v2.Custom.Version || sha(t, first.path) != before {
		t.Fatalf("the tampered update replaced the file, current %+v", first.Current())
	}
	if _, err := os.Stat(first.next()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("next file left after a failed update: %v", err)
	}
	if claims, err := first.Lookup(ctx, model.KindSeries, model.NSTMDB, "tv/1396"); err != nil || len(claims) == 0 {
		t.Fatalf("lookup after a failed update = %v %v", claims, err)
	}

	reopened, err := New(first.dir, outbound.New(memRecorder{}, "discoflix-test", quiet), quiet, WithRoot(repo.Root))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	if cur := reopened.Current(); !cur.Present || cur.Version != v2.Custom.Version || cur.Via != ViaHTTP {
		t.Fatalf("reopened current = %+v", cur)
	}
}

func lookups(ctx context.Context, t *testing.T, s *Service) {
	claims, err := s.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/603")
	if err != nil {
		t.Fatal(err)
	}
	m := fields(t, claims, model.NSTMDB, "movie/603")
	want := map[string]any{
		model.FieldTitle: "The Matrix", model.FieldOriginalTitle: "The Matrix", model.FieldYear: 1999, model.FieldLanguage: "en", model.FieldRuntime: 136,
		"xid.imdb": "tt0133093", "xid.tmdb": "movie/603", "xid.tvdb": "movie/169", "xid.trakt": "movie/the-matrix-1999",
		"xid.letterboxd": "the-matrix", "xid.rottentomatoes": "m/matrix", "xid.wikidata": "Q83495",
	}
	for field, v := range want {
		if len(m[field]) != 1 || m[field][0] != v {
			t.Fatalf("%s = %v, want %v", field, m[field], v)
		}
	}
	if c := m[model.FieldCountries]; len(c) != 1 || !slices.Equal(c[0].([]string), []string{"US"}) {
		t.Fatalf("countries = %v", c)
	}
	if a := m[model.FieldAliases]; len(a) != 1 || !slices.Equal(a[0].([]string), []string{"Matrix"}) {
		t.Fatalf("aliases = %v", a)
	}
	if _, ok := m[model.ParentXIDField(model.NSWikidata)]; ok {
		t.Fatal("a movie carries a parent")
	}
	if claims, err := s.Lookup(ctx, model.KindSeries, model.NSTMDB, "movie/603"); err != nil || claims != nil {
		t.Fatalf("lookup with the wrong kind = %v %v", claims, err)
	}
	if claims, err := s.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/1"); err != nil || claims != nil {
		t.Fatalf("lookup of an unknown id = %v %v", claims, err)
	}
	if claims, err := s.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/604"); err != nil || fields(t, claims, model.NSTMDB, "movie/604")["xid.wikidata"][0] != "Q99999" {
		t.Fatalf("reloaded = %v %v", claims, err)
	}
	ep, err := s.Lookup(ctx, model.KindEpisode, model.NSIMDb, "tt0959621")
	if err != nil {
		t.Fatal(err)
	}
	e := fields(t, ep, model.NSIMDb, "tt0959621")
	if e[model.ParentXIDField(model.NSWikidata)][0] != "Q2001" || e[model.FieldOrdinal][0] != 1 || e[model.FieldTitle][0] != "Pilot" || e[model.FieldYear][0] != 2008 {
		t.Fatalf("episode = %v", e)
	}
	season, err := s.Lookup(ctx, model.KindSeason, model.NSWikidata, "Q2001")
	if err != nil {
		t.Fatal(err)
	}
	if f := fields(t, season, model.NSWikidata, "Q2001"); f[model.ParentXIDField(model.NSWikidata)][0] != "Q1079" || f[model.FieldOrdinal][0] != 1 {
		t.Fatalf("season = %v", f)
	}
	if f := fields(t, must(s.Lookup(ctx, "", model.NSIMDb, "tt2301451")), model.NSIMDb, "tt2301451"); f[model.FieldOrdinal][0] != 62 || f[model.ParentXIDField(model.NSWikidata)] != nil {
		t.Fatalf("episode without a season = %v", f)
	}
	series := fields(t, must(s.Lookup(ctx, model.KindSeries, model.NSTVDB, "series/81189")), model.NSTVDB, "series/81189")
	if series["xid.tmdb"][0] != "tv/1396" || series["xid.trakt"][0] != "show/breaking-bad" || series["xid.tvmaze"][0] != "169" || series[model.FieldYear][0] != 2008 {
		t.Fatalf("series = %v", series)
	}
	amelie := fields(t, must(s.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/194")), model.NSTMDB, "movie/194")
	if amelie[model.FieldTitle][0] != "Amélie" || amelie[model.FieldOriginalTitle][0] != "Le Fabuleux Destin d'Amélie Poulain" || amelie[model.FieldLanguage][0] != "fr" ||
		!slices.Equal(amelie[model.FieldAliases][0].([]string), []string{"Amelie", "Amélie Poulain"}) || !slices.Equal(amelie[model.FieldCountries][0].([]string), []string{"DE", "FR"}) {
		t.Fatalf("amelie = %v", amelie)
	}
	if err := s.Configure(catalog.Keys{}, map[string]string{"language": "FR"}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Configure(catalog.Keys{}, map[string]string{"language": "en"}) }()
	french := fields(t, must(s.Lookup(ctx, model.KindMovie, model.NSTMDB, "movie/194")), model.NSTMDB, "movie/194")
	if french[model.FieldTitle][0] != "Le Fabuleux Destin d'Amélie Poulain" || !slices.Contains(french[model.FieldAliases][0].([]string), "Amélie") {
		t.Fatalf("amelie in french = %v", french)
	}
}

func must(claims []model.Claim, err error) []model.Claim {
	if err != nil {
		panic(err)
	}
	return claims
}

func searches(ctx context.Context, t *testing.T, s *Service) {
	cases := []struct {
		kind, text string
		year       int
		want       []string
	}{
		{model.KindMovie, "The Matrix", 1999, []string{"Q83495"}},
		{model.KindMovie, "the matrix", 0, []string{"Q83495", "Q99999"}},
		{model.KindMovie, "matrix", 0, []string{"Q83495", "Q99999"}},
		{model.KindMovie, "the matrix", 2003, []string{"Q99999"}},
		{model.KindMovie, "the matrix", 2010, nil},
		{model.KindSeries, "the matrix", 0, nil},
		{"", "AMELIE", 0, []string{"Q55"}},
		{model.KindMovie, "fabuleux destin", 2002, []string{"Q55"}},
		{model.KindMovie, "ma", 0, nil},
		{model.KindSeason, "breaking bad", 0, []string{"Q2001"}},
		{"", "breaking bad", 0, []string{"Q1079", "Q2001"}},
		{model.KindMovie, "!!", 0, nil},
	}
	for _, c := range cases {
		claims, err := s.Search(ctx, c.kind, c.text, c.year)
		if err != nil {
			t.Fatal(err)
		}
		if got := groups(claims); !slices.Equal(got, c.want) {
			t.Fatalf("search %s %q %d = %v, want %v", c.kind, c.text, c.year, got, c.want)
		}
		for _, cl := range claims {
			if cl.Namespace != model.NSWikidata {
				t.Fatalf("search group keyed by %s", cl.Namespace)
			}
		}
	}
	m := fields(t, must(s.Search(ctx, model.KindMovie, "The Matrix", 1999)), model.NSWikidata, "Q83495")
	if m["xid.tmdb"][0] != "movie/603" || m[model.FieldTitle][0] != "The Matrix" {
		t.Fatalf("search group = %v", m)
	}
}

func TestCheckAgainstMirrorWithoutRelease(t *testing.T) {
	ctx := context.Background()
	repo, err := snapshottest.NewRepo(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	empty := httptest.NewServer(http.FileServer(http.Dir(t.TempDir())))
	defer empty.Close()
	svc := newService(t, repo.Root, empty.URL)
	_, err = svc.Check(ctx)
	if !errors.Is(err, catalog.ErrNoRelease) || !strings.Contains(err.Error(), "timestamp.json answered 404") {
		t.Fatalf("check against an empty mirror = %v", err)
	}
	if _, err := svc.Update(ctx, nil); !errors.Is(err, catalog.ErrNoRelease) {
		t.Fatalf("update against an empty mirror = %v", err)
	}
	if cur := svc.Current(); cur.Present {
		t.Fatalf("nothing should have been installed, current = %+v", cur)
	}
}
