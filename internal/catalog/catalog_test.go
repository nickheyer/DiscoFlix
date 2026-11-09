package catalog

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	"google.golang.org/protobuf/proto"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/catalog/match"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/datasetimport"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entityfield"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/extid"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/matchedge"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	"github.com/nickheyer/DiscoFlix/internal/workflow"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

// The matcher satisfies both catalog interfaces
var (
	_ Scorer  = (*match.Model)(nil)
	_ Trainer = (*match.Model)(nil)
)

type noPublisher struct{}

func (noPublisher) Publish(string, []byte) error { return nil }

// fakeSource answers lookups and searches from maps and records every call
type fakeSource struct {
	name        string
	local       bool
	mu          sync.Mutex
	namespaces  []string
	unsupported []string
	artwork     bool
	lookups     map[string][]model.Claim
	results     []model.Claim
	calls       []string
	options     map[string]string
	fail        error
}

func (f *fakeSource) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "test.source." + f.name, Name: strings.ToUpper(f.name), Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}
func (f *fakeSource) Name() string            { return f.name }
func (f *fakeSource) Policy() outbound.Policy { return outbound.Policy{Name: f.name} }
func (f *fakeSource) Namespaces() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.namespaces) > 0 {
		return f.namespaces
	}
	return []string{f.name}
}
func (f *fakeSource) Kinds() []string { return []string{model.KindMovie, model.KindSeries} }
func (f *fakeSource) Artwork() bool   { return f.artwork }
func (f *fakeSource) License() string { return "test" }
func (f *fakeSource) Local() bool     { return f.local }
func (f *fakeSource) Configure(options map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.options = options
	return nil
}

func (f *fakeSource) Lookup(_ context.Context, kind, ns, id string) ([]model.Claim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "lookup:"+kind+":"+ns+":"+id)
	if f.fail != nil {
		return nil, f.fail
	}
	if slices.Contains(f.unsupported, ns) {
		return nil, ErrUnsupported
	}
	return f.lookups[ns+":"+id], nil
}

func (f *fakeSource) Search(_ context.Context, kind, text string, year int) ([]model.Claim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "search:"+kind+":"+text)
	if f.fail != nil {
		return nil, f.fail
	}
	return f.results, nil
}

// fakeMatcher scores exact normalized titles with equal years as near certain and nearby years as doubtful
type fakeMatcher struct {
	mu      sync.Mutex
	weights map[string][]byte
}

func (m *fakeMatcher) Score(_ string, a, b model.Record) (float64, map[string]float64) {
	f := map[string]float64{"title": 0, "year": 0}
	for _, ta := range a.Titles {
		for _, tb := range b.Titles {
			if model.Normalize(ta) == model.Normalize(tb) {
				f["title"] = 1
			}
		}
	}
	diff := a.Year - b.Year
	if diff < 0 {
		diff = -diff
	}
	switch {
	case f["title"] == 1 && diff == 0:
		f["year"] = 1
		return 0.97, f
	case f["title"] == 1 && diff <= 2:
		return 0.7, f
	}
	return 0.1, f
}

func (m *fakeMatcher) Explain(f map[string]float64) string {
	return "title " + map[bool]string{true: "matches", false: "differs"}[f["title"] == 1]
}

func (m *fakeMatcher) Fit(string, []Labeled, []map[string]float64) (int, error) { return 0, nil }

func (m *fakeMatcher) Weights(kind string) ([]byte, error) {
	return []byte(`{"kind":"` + kind + `"}`), nil
}

func (m *fakeMatcher) Load(kind string, w []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.weights == nil {
		m.weights = map[string][]byte{}
	}
	m.weights[kind] = w
	return nil
}

type fakeArt struct{ ent *ent.Client }

func (a *fakeArt) Ingest(ctx context.Context, row *ent.Artwork) error {
	return a.ent.Artwork.UpdateOneID(row.ID).SetHash(strings.Repeat("a", 64)).SetWidth(900).SetHeight(1350).SetState(artwork.StateReady).
		SetThumbhash([]byte{1, 2, 3}).SetVariants([]schema.ArtworkVariant{{Width: 342, Format: "webp", Bytes: 1000}}).Exec(ctx)
}

func (a *fakeArt) URL(row *ent.Artwork, width int32, format string) string {
	if row.State != artwork.StateReady {
		return ""
	}
	if format == "" {
		format = "webp"
	}
	return "/blobs/" + row.Hash + "/342." + format
}

type fakeSnap struct {
	mu       sync.Mutex
	mirror   string
	peers    []string
	checkErr error
	absent   bool
}

func (s *fakeSnap) Check(context.Context) (SnapshotCheck, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.checkErr != nil {
		return SnapshotCheck{}, s.checkErr
	}
	return SnapshotCheck{Remote: "v2", Local: "v1", Newer: true}, nil
}

func (s *fakeSnap) Update(context.Context, func(string)) (SnapshotResult, error) {
	return SnapshotResult{Version: "v2", Via: "http", Bytes: 10}, nil
}

func (s *fakeSnap) Current() SnapshotInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.absent {
		return SnapshotInfo{}
	}
	return SnapshotInfo{Version: "v1", Present: true, Items: 5}
}

func (s *fakeSnap) SetMirror(url string, peers []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mirror, s.peers = url, peers
}

type fakeData struct{}

func (fakeData) List() []DatasetInfo {
	return []DatasetInfo{{Name: "imdb.basics", Title: "IMDb title basics", License: "IMDb", URL: "https://example.test/basics", Default: true}}
}

func (fakeData) Import(context.Context, string, func(int64, int64)) (DatasetResult, error) {
	return DatasetResult{Rows: 3, Bytes: 30, ETag: "e1"}, nil
}

type harness struct {
	ctx   context.Context
	svc   *Service
	st    *store.Store
	tl    *timeline.Service
	az    *authz.Service
	live  *fakeSource
	local *fakeSource
	art   *fakeArt
	snap  *fakeSnap
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	st, err := store.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	az, err := authz.Open(ctx, dir, st.Ent, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(az.Close)
	tl := timeline.New(st.Ent, az, noPublisher{}, log)
	if err := tl.EnsureSystem(ctx, "Test"); err != nil {
		t.Fatal(err)
	}
	wf, err := workflow.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wf.Close() })
	live := &fakeSource{name: SourceTMDB, lookups: map[string][]model.Claim{}}
	local := &fakeSource{name: SourceIMDb, local: true, lookups: map[string][]model.Claim{}}
	h := &harness{ctx: ctx, st: st, tl: tl, az: az, live: live, local: local, art: &fakeArt{ent: st.Ent}, snap: &fakeSnap{}}
	h.svc, err = New(ctx, Deps{
		Ent: st.Ent, DB: st.DB, Timeline: tl,
		Check: func(ctx context.Context, subject, relation, object string) (bool, error) {
			return az.Check(ctx, subject, relation, object, nil)
		},
		Settings:   store.NewSettings(st.Ent),
		Workflows:  wf,
		Outbound:   outbound.New(NewRecorder(st.Ent), "test", log),
		Extensions: extension.NewRegistry(),
		Scorer:     &fakeMatcher{},
		Trainer:    &fakeMatcher{},
		Artworks:   h.art,
		Snapshots:  h.snap,
		Datasets:   fakeData{},
		Sources:    []Source{live, local},
		LinkBase:   func() string { return "http://test.local" },
		Log:        log,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func claims(ns, id string, fields map[string]any) []model.Claim {
	out := make([]model.Claim, 0, len(fields))
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, model.Claim{Kind: model.KindMovie, Namespace: ns, ExternalID: id, Field: k, Value: fields[k], Confidence: 1})
	}
	return out
}

func matrixTMDB() []model.Claim {
	return claims(model.NSTMDB, "movie/603", map[string]any{
		model.FieldTitle:             "The Matrix",
		model.FieldOriginalTitle:     "The Matrix",
		model.FieldYear:              1999,
		model.FieldRuntime:           136,
		model.FieldOverview:          "A hacker learns the truth",
		model.FieldGenres:            []string{"Action", "Science Fiction"},
		model.XIDField(model.NSIMDb): "tt0133093",
		model.ArtworkField("poster"): []model.Image{{URL: "https://img.test/matrix.jpg", Width: 2000, Height: 3000, Language: "en", Score: 9}},
	})
}

func matrixIMDb() []model.Claim {
	return claims(model.NSIMDb, "tt0133093", map[string]any{
		model.FieldTitle:          "The Matrix",
		model.FieldYear:           1999,
		model.FieldRuntime:        136,
		model.FieldOverview:       "Neo discovers reality is a simulation",
		model.RatingField("imdb"): 8.7,
		model.VotesField("imdb"):  2000000,
		model.FieldAliases:        []string{"Matrix"},
	})
}

func fieldValue(t *testing.T, h *harness, entityID, field string) (*ent.EntityField, string) {
	t.Helper()
	f, err := h.st.Ent.EntityField.Query().Where(entityfield.EntityID(entityID), entityfield.Field(field)).Only(h.ctx)
	if err != nil {
		t.Fatalf("field %s: %v", field, err)
	}
	return f, string(f.Value)
}

func TestObserveMergesSourcesByExternalID(t *testing.T) {
	h := newHarness(t)
	groups := groupClaims(SourceTMDB, matrixTMDB())
	if len(groups) != 1 {
		t.Fatalf("groups = %d", len(groups))
	}
	e, created, err := h.svc.Observe(h.ctx, groups[0])
	if err != nil || !created {
		t.Fatal(err, created)
	}
	if e.Title != "The Matrix" || e.Year != 1999 || e.Kind != model.KindMovie {
		t.Fatalf("entity = %+v", e)
	}
	xids, _ := h.st.Ent.ExtID.Query().Where(extid.EntityID(e.ID)).All(h.ctx)
	if len(xids) != 2 {
		t.Fatalf("ext ids = %d", len(xids))
	}
	pending, _ := h.st.Ent.Artwork.Query().Where(artwork.EntityID(e.ID), artwork.StateEQ(artwork.StatePending)).Count(h.ctx)
	if pending != 1 {
		t.Fatalf("pending artwork = %d", pending)
	}
	again, created, err := h.svc.Observe(h.ctx, groupClaims(SourceIMDb, matrixIMDb())[0])
	if err != nil || created || again.ID != e.ID {
		t.Fatalf("second observe = %v %v %v", again, created, err)
	}
	overview, v := fieldValue(t, h, e.ID, model.FieldOverview)
	if overview.Source != SourceTMDB || overview.Reason != entityfield.ReasonPriority || !strings.Contains(v, "hacker") {
		t.Fatalf("overview = %+v %s", overview, v)
	}
	year, _ := fieldValue(t, h, e.ID, model.FieldYear)
	if year.Agreement != 2 || year.Claims != 2 || year.Reason != entityfield.ReasonOnly {
		t.Fatalf("year = %+v", year)
	}
	if _, v := fieldValue(t, h, e.ID, model.RatingField("imdb")); v != "8.7" {
		t.Fatalf("rating = %s", v)
	}
	ids, err := h.svc.ftsEntityIDs(h.ctx, "matrix", 5)
	if err != nil || len(ids) != 1 || ids[0] != e.ID {
		t.Fatalf("fts = %v %v", ids, err)
	}
	card, err := h.svc.EntityCard(h.ctx, e, 0.9, "because")
	if err != nil || card.GetTitle() != "The Matrix" || len(card.GetExternalIds()) != 2 || card.GetUrl() != "http://test.local/catalog/e/"+e.ID || card.GetPosterUrl() != "" {
		t.Fatalf("card = %+v %v", card, err)
	}
	for _, ref := range card.GetExternalIds() {
		if ref.GetNamespace() == model.NSTMDB && ref.GetUrl() != "https://www.themoviedb.org/movie/603" {
			t.Fatalf("tmdb url = %s", ref.GetUrl())
		}
	}
}

func TestSearchRanksAndReportsSources(t *testing.T) {
	h := newHarness(t)
	h.live.results = append(matrixTMDB(), claims(model.NSTMDB, "movie/604", map[string]any{
		model.FieldTitle: "The Matrix Reloaded", model.FieldYear: 2003, model.XIDField(model.NSIMDb): "tt0234215",
	})...)
	h.local.results = matrixIMDb()
	hits, outcomes, err := h.svc.Search(h.ctx, "the matrix", "", 1999, 10, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[0].Entity.Title != "The Matrix" || hits[1].Entity.Title != "The Matrix Reloaded" {
		t.Fatalf("hits = %+v", hits)
	}
	if hits[0].Score <= hits[1].Score || !strings.Contains(hits[0].Explanation, "title matches exactly") || !strings.Contains(hits[0].Explanation, "2 sources agree") {
		t.Fatalf("top = %+v", hits[0])
	}
	states := map[string]string{}
	for _, o := range outcomes {
		states[o.Source] = o.State
	}
	if states[SourceTMDB] != StateAnswered || states[SourceIMDb] != StateAnswered {
		t.Fatalf("outcomes = %v", states)
	}
	res, err := h.svc.ResolveTitle(h.ctx, "The Matrix", model.KindMovie, 1999, false)
	if err != nil || res.Hit.Entity.Title != "The Matrix" || res.Confidence < 0.85 || len(res.Alternatives) != 1 {
		t.Fatalf("resolve = %+v %v", res, err)
	}
	h.live.fail = errors.New("boom")
	hits, outcomes, err = h.svc.Search(h.ctx, "matrix", "", 0, 10, false)
	if err != nil || len(hits) != 2 {
		t.Fatalf("offline search = %d %v", len(hits), err)
	}
	for _, o := range outcomes {
		if o.Source == SourceTMDB && (o.State != StateUnreachable || o.Detail != "boom") {
			t.Fatalf("tmdb outcome = %+v", o)
		}
	}
	if _, outcomes, err := h.svc.Search(h.ctx, "matrix", "", 0, 10, true); err != nil || len(outcomes) == 0 {
		t.Fatal(err)
	} else {
		for _, o := range outcomes {
			if o.Source == SourceTMDB && o.State != StateSkipped {
				t.Fatalf("local only outcome = %+v", o)
			}
		}
	}
	h.live.fail = nil
	h.live.results = nil
	h.local.results = nil
	if _, err := h.svc.ResolveTitle(h.ctx, "zzzz qqqq", model.KindSeries, 0, false); !errors.Is(err, ErrNoMatch) {
		t.Fatalf("no match = %v", err)
	}
}

func TestPinOverridesSources(t *testing.T) {
	h := newHarness(t)
	e, _, err := h.svc.Observe(h.ctx, groupClaims(SourceTMDB, matrixTMDB())[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Pin(h.ctx, e.ID, model.FieldYear, 2000, "alice"); err != nil {
		t.Fatal(err)
	}
	year, v := fieldValue(t, h, e.ID, model.FieldYear)
	if v != "2000" || year.Reason != entityfield.ReasonPin || year.Source != SourceUser {
		t.Fatalf("pinned year = %+v %s", year, v)
	}
	if got, _ := h.svc.GetEntity(h.ctx, e.ID); got.Year != 2000 {
		t.Fatalf("denormalized year = %d", got.Year)
	}
	if _, _, err := h.svc.Observe(h.ctx, groupClaims(SourceIMDb, matrixIMDb())[0]); err != nil {
		t.Fatal(err)
	}
	if _, v := fieldValue(t, h, e.ID, model.FieldYear); v != "2000" {
		t.Fatalf("pin lost after new claims: %s", v)
	}
	if err := h.svc.Unpin(h.ctx, e.ID, model.FieldYear); err != nil {
		t.Fatal(err)
	}
	if _, v := fieldValue(t, h, e.ID, model.FieldYear); v != "1999" {
		t.Fatalf("unpinned year = %s", v)
	}
	if err := h.svc.Pin(h.ctx, e.ID, "", 1, "alice"); !errors.Is(err, ErrBadField) {
		t.Fatalf("bad field = %v", err)
	}
}

func TestDoubtfulMatchOpensReviewAndAcceptMerges(t *testing.T) {
	h := newHarness(t)
	heat, _, err := h.svc.Observe(h.ctx, groupClaims(SourceTMDB, claims(model.NSTMDB, "movie/949", map[string]any{model.FieldTitle: "Heat", model.FieldYear: 1995}))[0])
	if err != nil {
		t.Fatal(err)
	}
	same, created, err := h.svc.Observe(h.ctx, groupClaims(SourceIMDb, claims(model.NSIMDb, "tt0113277", map[string]any{model.FieldTitle: "Heat", model.FieldYear: 1995}))[0])
	if err != nil || created || same.ID != heat.ID {
		t.Fatalf("confident match = %v %v %v", same, created, err)
	}
	doubt, created, err := h.svc.Observe(h.ctx, groupClaims("trakt", claims(model.NSTrakt, "movie/heat-1996", map[string]any{model.FieldTitle: "Heat", model.FieldYear: 1996}))[0])
	if err != nil || !created || doubt.ID == heat.ID {
		t.Fatalf("doubtful match = %v %v %v", doubt, created, err)
	}
	edge, err := h.st.Ent.MatchEdge.Query().Where(matchedge.StateEQ(matchedge.StateReview)).Only(h.ctx)
	if err != nil || edge.EntityID != doubt.ID || edge.Value != heat.ID || edge.MessageSeq == 0 {
		t.Fatalf("edge = %+v %v", edge, err)
	}
	msg, err := h.tl.GetMessage(h.ctx, edge.MessageSeq)
	if err != nil || msg.CardType != extension.TypeURLOf((&cardv1.MatchReview{}).ProtoReflect().Descriptor()) {
		t.Fatalf("review card = %+v %v", msg, err)
	}
	card := &cardv1.MatchReview{}
	if err := proto.Unmarshal(msg.Card, card); err != nil {
		t.Fatal(err)
	}
	rc := &reviewCard{svc: h.svc}
	if len(rc.Actions(card)) != 2 {
		t.Fatalf("actions = %v", rc.Actions(card))
	}
	bob := capability.Principal{UserID: "bob", DisplayName: "Bob", Kind: "person", Via: "session"}
	if _, err := rc.Interact(h.ctx, extension.Interaction{Principal: bob, Card: card, Action: "accept"}); err == nil {
		t.Fatal("non admin accepted a review")
	}
	tx, _ := h.st.Ent.Tx(h.ctx)
	if err := authz.Stage(h.ctx, tx, authz.Write(authz.SystemObject, "admin", "user:alice")); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit()
	if err := h.az.Flush(h.ctx); err != nil {
		t.Fatal(err)
	}
	alice := capability.Principal{UserID: "alice", DisplayName: "Alice", Kind: "person", Via: "session", SystemAdmin: true}
	next, err := rc.Interact(h.ctx, extension.Interaction{Principal: alice, Card: card, Action: "accept"})
	if err != nil {
		t.Fatal(err)
	}
	if next.(*cardv1.MatchReview).GetState() != cardv1.MatchState_MATCH_STATE_ACCEPTED || next.(*cardv1.MatchReview).GetDecidedByName() != "Alice" {
		t.Fatalf("decided = %+v", next)
	}
	merged, err := h.svc.GetEntity(h.ctx, doubt.ID)
	if err != nil || merged.ID != heat.ID {
		t.Fatalf("merge follow = %v %v", merged, err)
	}
	xids, _ := h.st.Ent.ExtID.Query().Where(extid.EntityID(heat.ID)).All(h.ctx)
	if len(xids) != 3 {
		t.Fatalf("merged ext ids = %d", len(xids))
	}
	if len(rc.Actions(next)) != 0 {
		t.Fatal("decided review still offers actions")
	}
	if _, err := rc.Interact(h.ctx, extension.Interaction{Principal: alice, Card: next, Action: "reject"}); err == nil {
		t.Fatal("decided review accepted a second decision")
	}
}

func TestRefreshWorkflowFetchesSourcesAndArtwork(t *testing.T) {
	h := newHarness(t)
	e, _, err := h.svc.Observe(h.ctx, groupClaims(SourceTMDB, matrixTMDB())[0])
	if err != nil {
		t.Fatal(err)
	}
	fresh := matrixTMDB()
	for i := range fresh {
		if fresh[i].Field == model.FieldOverview {
			fresh[i].Value = "Refreshed overview"
		}
	}
	h.live.lookups["tmdb:movie/603"] = fresh
	h.live.namespaces = []string{model.NSTMDB, model.NSIMDb}
	h.live.unsupported = []string{model.NSIMDb}
	if _, err := h.svc.Refresh(h.ctx, e.ID); !errors.Is(err, ErrNotLaunched) {
		t.Fatalf("before launch = %v", err)
	}
	if err := h.svc.Start(h.ctx); err != nil {
		t.Fatal(err)
	}
	id, err := h.svc.Refresh(h.ctx, e.ID)
	if err != nil || id == "" {
		t.Fatal(id, err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		st, err := h.svc.Workflows.Status(id)
		if err != nil {
			t.Fatal(err)
		}
		if st.Status == dbos.WorkflowStatusSuccess {
			break
		}
		if st.Status == dbos.WorkflowStatusError || time.Now().After(deadline) {
			t.Fatalf("workflow %s ended %s %v", id, st.Status, st.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, v := fieldValue(t, h, e.ID, model.FieldOverview); !strings.Contains(v, "Refreshed") {
		t.Fatalf("overview after refresh = %s", v)
	}
	if calls := h.live.calls; !slices.Contains(calls, "lookup:movie:imdb:tt0133093") || !slices.Contains(calls, "lookup:movie:tmdb:movie/603") {
		t.Fatalf("refresh skipped past the unsupported namespace wrongly, calls = %v", calls)
	}
	ready, _ := h.st.Ent.Artwork.Query().Where(artwork.EntityID(e.ID), artwork.StateEQ(artwork.StateReady)).Count(h.ctx)
	if ready != 1 {
		t.Fatalf("ready artwork = %d", ready)
	}
	card, err := h.svc.EntityCard(h.ctx, e, 1, "")
	if err != nil || card.GetPosterUrl() != "http://test.local/blobs/"+strings.Repeat("a", 64)+"/342.webp" || card.GetThumbhash() == "" {
		t.Fatalf("card after refresh = %+v %v", card, err)
	}
	got, _ := h.svc.GetEntity(h.ctx, e.ID)
	if got.RefreshedAt == nil {
		t.Fatal("refreshed_at not set")
	}
	again, err := h.svc.Refresh(h.ctx, e.ID)
	if err != nil || again != id {
		t.Fatalf("repeat refresh id = %s, want %s (%v)", again, id, err)
	}
	wid, err := h.svc.UpdateSnapshot(true)
	if err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(30 * time.Second); ; {
		st, err := h.svc.Workflows.Status(wid)
		if err != nil {
			t.Fatal(err)
		}
		if st.Status == dbos.WorkflowStatusSuccess {
			break
		}
		if st.Status == dbos.WorkflowStatusError || time.Now().After(deadline) {
			t.Fatalf("snapshot workflow %s %v", st.Status, st.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if snap := h.svc.SnapshotProto(); snap.GetState() != "ready" {
		t.Fatalf("snapshot state = %+v", snap)
	}
	chans, _ := h.tl.ListChannels(h.ctx, h.tl.SystemBotID(), h.tl.SystemSpaceID())
	_ = chans
	msgs, _, err := h.tl.ListMessages(h.ctx, h.tl.SystemBotID(), h.tl.SystemChannelID("catalog"), 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	var reports int
	for _, m := range msgs {
		if m.GetCard().GetTypeUrl() == extension.TypeURLOf((&cardv1.CatalogReport{}).ProtoReflect().Descriptor()) {
			reports++
		}
	}
	if reports != 2 {
		t.Fatalf("catalog reports = %d", reports)
	}
	for deadline := time.Now().Add(30 * time.Second); ; {
		row, err := h.st.Ent.DatasetImport.Get(h.ctx, "imdb.basics")
		if err != nil {
			t.Fatal(err)
		}
		if row.State == datasetimport.StateDone {
			if row.Rows != 3 || row.Etag != "e1" || !row.Enabled {
				t.Fatalf("dataset row = %+v", row)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("default dataset never imported, state %s", row.State)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestResolvePrefersWellReferencedTitle(t *testing.T) {
	h := newHarness(t)
	rich := map[string]any{model.FieldTitle: "Twin Signal", model.FieldYear: 2001}
	for _, ns := range []string{model.NSIMDb, model.NSTVDB, model.NSTrakt, model.NSWikidata, "letterboxd", "tvmaze", "netflix", "plex"} {
		rich[model.XIDField(ns)] = ns + "-rich"
	}
	h.live.results = append(claims(model.NSTMDB, "movie/10", rich), claims(model.NSTMDB, "movie/11", map[string]any{model.FieldTitle: "Twin Signal", model.FieldYear: 2005})...)
	res, err := h.svc.ResolveTitle(h.ctx, "Twin Signal", model.KindMovie, 0, false)
	if err != nil || res.Hit.Entity.Year != 2001 || res.Hit.IDs != 9 || res.Confidence < 0.85 || len(res.Alternatives) != 1 || res.Alternatives[0].IDs != 1 {
		t.Fatalf("resolve = %+v %v", res, err)
	}
	if !strings.Contains(res.Explanation, "9 external ids") || !strings.Contains(res.Alternatives[0].Explanation, "1 external id,") {
		t.Fatalf("explanations = %q / %q", res.Explanation, res.Alternatives[0].Explanation)
	}
	res, err = h.svc.ResolveTitle(h.ctx, "Twin Signal", model.KindMovie, 2005, false)
	if err != nil || res.Hit.Entity.Year != 2005 {
		t.Fatalf("year must beat references = %+v %v", res, err)
	}
}

func TestSnapshotWorkflowWithoutRelease(t *testing.T) {
	h := newHarness(t)
	h.snap.mu.Lock()
	h.snap.checkErr = fmt.Errorf("%w, https://mirror.test/timestamp.json answered 404", ErrNoRelease)
	h.snap.absent = true
	h.snap.mu.Unlock()
	if err := h.svc.Start(h.ctx); err != nil {
		t.Fatal(err)
	}
	wid, err := h.svc.UpdateSnapshot(true)
	if err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(30 * time.Second); ; {
		st, err := h.svc.Workflows.Status(wid)
		if err != nil {
			t.Fatal(err)
		}
		if st.Status == dbos.WorkflowStatusSuccess {
			break
		}
		if st.Status == dbos.WorkflowStatusError || time.Now().After(deadline) {
			t.Fatalf("snapshot workflow %s %v", st.Status, st.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
	snap := h.svc.SnapshotProto()
	if snap.GetState() != "missing" || !strings.Contains(snap.GetLastError(), "has not published") {
		t.Fatalf("snapshot state = %+v", snap)
	}
	msgs, _, err := h.tl.ListMessages(h.ctx, h.tl.SystemBotID(), h.tl.SystemChannelID("catalog"), 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	var skipped int
	for _, m := range msgs {
		var report cardv1.CatalogReport
		if m.GetCard().GetTypeUrl() == extension.TypeURLOf(report.ProtoReflect().Descriptor()) {
			if err := proto.Unmarshal(m.GetCard().GetValue(), &report); err != nil {
				t.Fatal(err)
			}
			if report.GetKind() == "snapshot" && report.GetState() == "skipped" && strings.Contains(report.GetDetail(), "answered 404") {
				skipped++
			}
		}
	}
	if skipped != 1 {
		t.Fatalf("skipped snapshot reports = %d of %d messages", skipped, len(msgs))
	}
}

func TestLookupExternalThroughAnotherNamespace(t *testing.T) {
	h := newHarness(t)
	h.live.namespaces = []string{model.NSTMDB, model.NSIMDb}
	h.live.artwork = true
	h.live.lookups["imdb:tt0133093"] = matrixTMDB()
	e, created, outcomes, err := h.svc.LookupExternal(h.ctx, model.NSIMDb, "tt0133093", model.KindMovie)
	if err != nil || !created || e.Title != "The Matrix" || len(outcomes) != 2 || outcomes[1].Source != SourceTMDB || outcomes[1].State != StateAnswered {
		t.Fatalf("lookup by imdb through tmdb = %v %v %v %v", e, created, outcomes, err)
	}
	if outcomes[0].Artwork || !outcomes[1].Artwork {
		t.Fatalf("artwork flags = %v %v", outcomes[0].Artwork, outcomes[1].Artwork)
	}
	if byTMDB, err := h.svc.EntityByXID(h.ctx, model.NSTMDB, "movie/603"); err != nil || byTMDB.ID != e.ID {
		t.Fatalf("tmdb id not linked = %v %v", byTMDB, err)
	}
	h.live.lookups["imdb:tt0000001"] = matrixTMDB()
	if _, _, _, err := h.svc.LookupExternal(h.ctx, model.NSIMDb, "tt0000001", model.KindMovie); !errors.Is(err, ErrNotFound) {
		t.Fatalf("answer without the asked id = %v", err)
	}
}

func TestLookupExternalAndConfigure(t *testing.T) {
	h := newHarness(t)
	h.live.lookups["tmdb:movie/603"] = matrixTMDB()
	e, created, outcomes, err := h.svc.LookupExternal(h.ctx, model.NSTMDB, "movie/603", model.KindMovie)
	if err != nil || !created || e.Title != "The Matrix" || len(outcomes) == 0 {
		t.Fatalf("lookup = %v %v %v %v", e, created, outcomes, err)
	}
	if again, created, _, err := h.svc.LookupExternal(h.ctx, model.NSIMDb, "tt0133093", ""); err != nil || created || again.ID != e.ID {
		t.Fatalf("known id = %v %v %v", again, created, err)
	}
	if _, _, _, err := h.svc.LookupExternal(h.ctx, model.NSTMDB, "movie/1", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown = %v", err)
	}
	if err := h.svc.ConfigureSource(h.ctx, SourceTMDB, false, map[string]string{"language": "de"}); err != nil {
		t.Fatal(err)
	}
	if h.live.options["language"] != "de" || len(h.svc.enabledSources(false)) != 1 {
		t.Fatalf("configure = %+v %d", h.live.options, len(h.svc.enabledSources(false)))
	}
	src, err := h.svc.SourceProto(h.ctx, SourceTMDB)
	if err != nil || src.GetState() != "disabled" || src.GetOptions()["language"] != "de" {
		t.Fatalf("source proto = %+v %v", src, err)
	}
	if err := h.svc.ConfigureCatalog(h.ctx, "https://mirror.test/ ", []string{" http://peer.test/ ", ""}, ""); err != nil {
		t.Fatal(err)
	}
	mirror, peers, lang := h.svc.CatalogSettings()
	if mirror != "https://mirror.test" || len(peers) != 1 || peers[0] != "http://peer.test" || lang != "en" || h.snap.mirror != mirror {
		t.Fatalf("settings = %s %v %s", mirror, peers, lang)
	}
	st, err := h.svc.Status(h.ctx)
	if err != nil || st.GetEntities() != 1 || len(st.GetSources()) != 2 || len(st.GetDatasets()) != 1 || st.GetSnapshot().GetVersion() != "v1" {
		t.Fatalf("status = %+v %v", st, err)
	}
	if err := h.svc.ConfigureSource(h.ctx, "nope", true, nil); !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("unknown source = %v", err)
	}
}

func TestDecidePolicyOrder(t *testing.T) {
	now := time.Now()
	mk := func(source, hash string, rank int32, pinned bool, at time.Time) *ent.Claim {
		return &ent.Claim{ID: source + hash, Source: source, ValueHash: hash, Rank: rank, Pinned: pinned, ObservedAt: at}
	}
	d, ok := decide([]*ent.Claim{mk("tmdb", "a", 10, false, now), mk("imdb", "b", 30, false, now)})
	if !ok || d.claim.Source != "tmdb" || d.reason != entityfield.ReasonPriority {
		t.Fatalf("priority = %+v", d)
	}
	d, _ = decide([]*ent.Claim{mk("x", "a", 1000, false, now), mk("y", "b", 1000, false, now), mk("z", "b", 1000, false, now.Add(-time.Hour))})
	if d.claim.ValueHash != "b" || d.reason != entityfield.ReasonAgreement || d.agreement != 2 {
		t.Fatalf("agreement = %+v", d)
	}
	d, _ = decide([]*ent.Claim{mk("x", "a", 1000, false, now.Add(-time.Hour)), mk("y", "b", 1000, false, now)})
	if d.claim.ValueHash != "b" || d.reason != entityfield.ReasonRecency {
		t.Fatalf("recency = %+v", d)
	}
	d, _ = decide([]*ent.Claim{mk("tmdb", "a", 10, false, now), mk("user", "c", 0, true, now.Add(-time.Hour))})
	if d.claim.Source != "user" || d.reason != entityfield.ReasonPin {
		t.Fatalf("pin = %+v", d)
	}
	if _, ok := decide(nil); ok {
		t.Fatal("empty decided")
	}
}

func TestTitleSimilarity(t *testing.T) {
	if titleSimilarity("heat", "heat") != 1 || titleSimilarity("heat", "") != 0 {
		t.Fatal("exact and empty")
	}
	if s := titleSimilarity("the matrix", "the matrix reloaded"); s < 0.8 || s >= 1 {
		t.Fatalf("prefix = %f", s)
	}
	if a, b := titleSimilarity("heat", "heat 1995"), titleSimilarity("heat", "the heart"); a <= b {
		t.Fatalf("prefix %f should beat fuzzy %f", a, b)
	}
	if jaroWinkler("martha", "marhta") < 0.95 || jaroWinkler("abc", "xyz") != 0 {
		t.Fatal("jaro winkler")
	}
}

func TestConflictingIDOpensReviewAndPropagationMerges(t *testing.T) {
	h := newHarness(t)
	a, _, err := h.svc.Observe(h.ctx, groupClaims(SourceTMDB, claims(model.NSTMDB, "movie/1", map[string]any{model.FieldTitle: "Alien", model.FieldYear: 1979}))[0])
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := h.svc.Observe(h.ctx, groupClaims(SourceIMDb, claims(model.NSIMDb, "tt0078748", map[string]any{model.FieldTitle: "Alien (1979 film)", model.FieldYear: 1979}))[0])
	if err != nil || b.ID == a.ID {
		t.Fatalf("second entity = %v %v", b, err)
	}
	if _, _, err := h.svc.Observe(h.ctx, groupClaims("trakt", claims(model.NSTMDB, "movie/1", map[string]any{model.FieldTitle: "Alien", model.XIDField(model.NSIMDb): "tt0078748"}))[0]); err != nil {
		t.Fatal(err)
	}
	edge, err := h.st.Ent.MatchEdge.Query().Where(matchedge.Namespace("entity"), matchedge.StateEQ(matchedge.StateReview)).Only(h.ctx)
	if err != nil || edge.EntityID != a.ID || edge.Value != b.ID || edge.Tier != 0 || edge.MessageSeq == 0 {
		t.Fatalf("conflict edge = %+v %v", edge, err)
	}
	if xids, _ := h.st.Ent.ExtID.Query().Where(extid.EntityID(a.ID)).Count(h.ctx); xids != 1 {
		t.Fatalf("conflicting id was stolen, a has %d ids", xids)
	}
	merged, err := h.svc.mergeComponent(h.ctx, []string{a.ID, b.ID})
	if err != nil || merged != 1 {
		t.Fatalf("merge component = %d %v", merged, err)
	}
	if live, _ := h.svc.GetEntity(h.ctx, b.ID); live.ID != a.ID {
		t.Fatalf("b not merged into a")
	}
	if xids, _ := h.st.Ent.ExtID.Query().Where(extid.EntityID(a.ID)).Count(h.ctx); xids != 2 {
		t.Fatalf("merged ids = %d", xids)
	}
	closed, _ := h.st.Ent.MatchEdge.Get(h.ctx, edge.ID)
	if closed.State != matchedge.StateAccepted || closed.DecidedBy != "propagation" {
		t.Fatalf("edge after propagation = %+v", closed)
	}
	msg, _ := h.tl.GetMessage(h.ctx, edge.MessageSeq)
	card := &cardv1.MatchReview{}
	if err := proto.Unmarshal(msg.Card, card); err != nil || card.GetState() != cardv1.MatchState_MATCH_STATE_ACCEPTED || card.GetDecidedBy() != "propagation" {
		t.Fatalf("review card = %+v %v", card, err)
	}
	comps := match.Propagate([]match.Edge{{A: a.ID, B: b.ID, P: 0.97}, {A: b.ID, B: "c", P: 0.5}}, acceptProbability)
	if len(comps) != 1 || len(comps[0].Nodes) != 2 {
		t.Fatalf("components = %+v", comps)
	}
}
