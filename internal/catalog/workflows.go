package catalog

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/catalog/match"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/datasetimport"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/extid"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/matchedge"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/matchmodel"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	"github.com/nickheyer/DiscoFlix/internal/workflow"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

// Workflow names and the cron lines, six fields with seconds first, in UTC
const (
	wfRefresh   = "catalog.refresh"
	wfSnapshot  = "catalog.snapshot"
	wfDataset   = "catalog.dataset"
	wfRetrain   = "catalog.retrain"
	wfArtwork   = "catalog.artwork"
	wfDatasets  = "catalog.datasets"
	wfPropagate = "catalog.propagate"

	cronSnapshot  = "0 17 4 * * *"
	cronDatasets  = "0 30 5 * * *"
	cronRetrain   = "0 0 6 * * 0"
	cronArtwork   = "0 5 * * * *"
	cronPropagate = "0 35 * * * *"
	queueName     = "catalog"
)

type refreshInput struct {
	EntityID string `json:"entity_id"`
}

// refreshResult counts what one refresh did
type refreshResult struct {
	Sources  int      `json:"sources"`
	Groups   int      `json:"groups"`
	Artworks int      `json:"artworks"`
	Failed   []string `json:"failed,omitempty"`
}

type snapshotInput struct {
	Force bool `json:"force"`
}

type snapshotOutcome struct {
	Version string `json:"version"`
	Skipped bool   `json:"skipped"`
	Via     string `json:"via"`
	Bytes   int64  `json:"bytes"`
}

type datasetInput struct {
	Name string `json:"name"`
}

type datasetOutcome struct {
	Rows      int64 `json:"rows"`
	Bytes     int64 `json:"bytes"`
	Unchanged bool  `json:"unchanged"`
}

type retrainOutcome struct {
	Kinds   map[string]int    `json:"kinds"`
	Skipped map[string]string `json:"skipped,omitempty"`
}

type propagateOutcome struct {
	Merged int `json:"merged"`
}

type artworkOutcome struct {
	Ingested int      `json:"ingested"`
	Failed   []string `json:"failed,omitempty"`
}

// snapshotState is what the status page shows about the snapshot workflow
type snapshotState struct {
	mu        sync.Mutex
	state     string
	lastError string
	checkedAt time.Time
}

func (s *Service) registerWorkflows() {
	workflow.Register(s.Workflows, wfRefresh, s.refreshWorkflow)
	workflow.Register(s.Workflows, wfSnapshot, s.snapshotWorkflow)
	workflow.Register(s.Workflows, wfDataset, s.datasetWorkflow)
	workflow.Register(s.Workflows, wfRetrain, s.retrainWorkflow)
	workflow.Register(s.Workflows, wfArtwork, s.artworkWorkflow)
	workflow.Register(s.Workflows, wfDatasets, s.datasetsWorkflow)
	workflow.Register(s.Workflows, wfPropagate, s.propagateWorkflow)
	workflow.Register(s.Workflows, wfPropagate+".scheduled", s.scheduledPropagate)
	workflow.Register(s.Workflows, wfSnapshot+".scheduled", s.scheduledSnapshot)
	workflow.Register(s.Workflows, wfDatasets+".scheduled", s.scheduledDatasets)
	workflow.Register(s.Workflows, wfRetrain+".scheduled", s.scheduledRetrain)
	workflow.Register(s.Workflows, wfArtwork+".scheduled", s.scheduledArtwork)
}

// schedule registers the queue and the periodic work once the runtime is launched
func (s *Service) schedule() error {
	q, err := s.Workflows.Queue(queueName, 2)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.queue = q
	s.mu.Unlock()
	return s.Workflows.Schedule(
		dbos.ScheduleSpec{ScheduleName: wfSnapshot, Workflow: s.scheduledSnapshot, Schedule: cronSnapshot},
		dbos.ScheduleSpec{ScheduleName: wfDatasets, Workflow: s.scheduledDatasets, Schedule: cronDatasets},
		dbos.ScheduleSpec{ScheduleName: wfRetrain, Workflow: s.scheduledRetrain, Schedule: cronRetrain},
		dbos.ScheduleSpec{ScheduleName: wfArtwork, Workflow: s.scheduledArtwork, Schedule: cronArtwork},
		dbos.ScheduleSpec{ScheduleName: wfPropagate, Workflow: s.scheduledPropagate, Schedule: cronPropagate},
	)
}

func (s *Service) queued() []dbos.WorkflowOption {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.queue == nil {
		return nil
	}
	return []dbos.WorkflowOption{dbos.WithQueue(s.queue)}
}

// bucket makes workflow ids that collapse repeats inside a window into one run
func bucket(prefix string, window time.Duration) string {
	return fmt.Sprintf("%s:%d", prefix, time.Now().Unix()/int64(window.Seconds()))
}

// Refresh starts a durable refresh of one entity from every enabled source, at most one per five minutes
func (s *Service) Refresh(ctx context.Context, entityID string) (string, error) {
	if _, err := s.GetEntity(ctx, entityID); err != nil {
		return "", err
	}
	h, err := workflow.Run[refreshInput, refreshResult](s.Workflows, s.refreshWorkflow, bucket("refresh:"+entityID, 5*time.Minute), refreshInput{EntityID: entityID}, s.queued()...)
	if err != nil {
		return "", err
	}
	return h.GetWorkflowID(), nil
}

// UpdateSnapshot starts a snapshot check and update now
func (s *Service) UpdateSnapshot(force bool) (string, error) {
	h, err := workflow.Run[snapshotInput, snapshotOutcome](s.Workflows, s.snapshotWorkflow, bucket("snapshot", time.Minute), snapshotInput{Force: force})
	if err != nil {
		return "", err
	}
	return h.GetWorkflowID(), nil
}

// ImportDataset enables a dataset and starts its import now
func (s *Service) ImportDataset(ctx context.Context, name string, enabled bool) (string, error) {
	info, ok := s.datasetInfo(name)
	if !ok {
		return "", fmt.Errorf("%w: dataset %s", ErrNotFound, name)
	}
	if err := s.Ent.DatasetImport.Create().SetID(info.Name).SetEnabled(enabled).
		OnConflictColumns(datasetimport.FieldID).UpdateEnabled().UpdateUpdatedAt().Exec(ctx); err != nil {
		return "", err
	}
	if !enabled {
		return "", nil
	}
	h, err := workflow.Run[datasetInput, datasetOutcome](s.Workflows, s.datasetWorkflow, bucket("dataset:"+name, 5*time.Minute), datasetInput{Name: name}, s.queued()...)
	if err != nil {
		return "", err
	}
	return h.GetWorkflowID(), nil
}

func (s *Service) datasetInfo(name string) (DatasetInfo, bool) {
	for _, d := range s.Datasets.List() {
		if d.Name == name {
			return d, true
		}
	}
	return DatasetInfo{}, false
}

// refreshWorkflow looks the entity up at every enabled live source by the first namespace it serves, stores artwork, and resolves it again
func (s *Service) refreshWorkflow(ctx dbos.Context, in refreshInput) (refreshResult, error) {
	var result refreshResult
	type loaded struct {
		Kind    string            `json:"kind"`
		XIDs    map[string]string `json:"xids"`
		Sources []string          `json:"sources"`
	}
	type looked struct {
		Groups      []Group `json:"groups,omitempty"`
		Unsupported bool    `json:"unsupported,omitempty"`
	}
	info, err := workflow.Step(ctx, "load", 2, func(c context.Context) (loaded, error) {
		e, err := s.GetEntity(c, in.EntityID)
		if err != nil {
			return loaded{}, err
		}
		xids, err := s.Ent.ExtID.Query().Where(extid.EntityID(e.ID)).All(c)
		if err != nil {
			return loaded{}, err
		}
		l := loaded{Kind: e.Kind, XIDs: map[string]string{}}
		for _, x := range xids {
			l.XIDs[x.Namespace] = x.Value
		}
		for _, src := range s.enabledSources(false) {
			if !src.local {
				l.Sources = append(l.Sources, src.Name())
			}
		}
		return l, nil
	})
	if err != nil {
		return result, err
	}
	for _, name := range info.Sources {
		src, ok := s.Source(name)
		if !ok {
			continue
		}
		namespaces := append([]string(nil), src.Namespaces()...)
		sort.Strings(namespaces)
		for _, ns := range namespaces {
			value, ok := info.XIDs[ns]
			if !ok {
				continue
			}
			lk, err := workflow.Step(ctx, "lookup:"+name+":"+ns, 2, func(c context.Context) (looked, error) {
				claims, err := src.Lookup(c, info.Kind, ns, value)
				if errors.Is(err, ErrUnsupported) {
					return looked{Unsupported: true}, nil
				}
				if err != nil {
					return looked{}, err
				}
				return looked{Groups: groupClaims(name, claims)}, nil
			})
			if err != nil {
				result.Failed = append(result.Failed, name+": "+err.Error())
				break
			}
			if lk.Unsupported {
				continue
			}
			n, err := workflow.Step(ctx, "observe:"+name+":"+ns, 1, func(c context.Context) (int, error) {
				for _, g := range lk.Groups {
					if _, _, err := s.Observe(c, g); err != nil {
						return 0, err
					}
				}
				return len(lk.Groups), nil
			})
			if err != nil {
				return result, err
			}
			result.Sources++
			result.Groups += n
			break
		}
	}
	art, err := s.ingestPending(ctx, in.EntityID, 25)
	if err != nil {
		return result, err
	}
	result.Artworks = art.Ingested
	result.Failed = append(result.Failed, art.Failed...)
	if _, err := workflow.Step(ctx, "resolve", 2, func(c context.Context) (bool, error) {
		if err := s.Resolve(c, in.EntityID); err != nil {
			return false, err
		}
		return true, s.Ent.Entity.UpdateOneID(in.EntityID).SetRefreshedAt(time.Now()).Exec(c)
	}); err != nil {
		return result, err
	}
	if len(result.Failed) > 0 {
		_, err = workflow.Step(ctx, "report", 1, func(c context.Context) (int64, error) {
			e, err := s.GetEntity(c, in.EntityID)
			if err != nil {
				return 0, err
			}
			return s.report(c, &cardv1.CatalogReport{Kind: "refresh", Name: e.Title, State: "failed", Error: strings.Join(result.Failed, "\n"), Detail: fmt.Sprintf("%d of %d sources answered", result.Sources, result.Sources+len(result.Failed))},
				fmt.Sprintf("Refreshing %s hit %d source failures", describe(e.Title, int(e.Year)), len(result.Failed)))
		})
		if err != nil {
			return result, err
		}
	}
	return result, nil
}

// ingestPending stores the pending artwork rows of one entity, or of every entity when the id is empty
func (s *Service) ingestPending(ctx dbos.Context, entityID string, limit int) (artworkOutcome, error) {
	var out artworkOutcome
	ids, err := workflow.Step(ctx, "pending-artwork", 1, func(c context.Context) ([]string, error) {
		q := s.Ent.Artwork.Query().Where(artwork.StateEQ(artwork.StatePending))
		if entityID != "" {
			q = q.Where(artwork.EntityID(entityID))
		}
		return q.Order(ent.Desc(artwork.FieldScore), ent.Asc(artwork.FieldCreatedAt)).Limit(limit).IDs(c)
	})
	if err != nil {
		return out, err
	}
	for _, id := range ids {
		ok, err := workflow.Step(ctx, "artwork:"+id, 2, func(c context.Context) (bool, error) {
			a, err := s.Ent.Artwork.Get(c, id)
			if ent.IsNotFound(err) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			if a.State != artwork.StatePending {
				return true, nil
			}
			return true, s.Artworks.Ingest(c, a)
		})
		if err != nil {
			out.Failed = append(out.Failed, "artwork "+id+": "+err.Error())
			continue
		}
		if ok {
			out.Ingested++
		}
	}
	return out, nil
}

// artworkWorkflow sweeps pending artwork left behind by interrupted refreshes
func (s *Service) artworkWorkflow(ctx dbos.Context, _ struct{}) (artworkOutcome, error) {
	return s.ingestPending(ctx, "", 200)
}

func (s *Service) scheduledArtwork(ctx dbos.Context, _ dbos.ScheduledWorkflowInput) (any, error) {
	return s.ingestPending(ctx, "", 200)
}

// snapshotWorkflow checks the mirror and peers, swaps in a newer crosswalk, and reports in #catalog
func (s *Service) snapshotWorkflow(ctx dbos.Context, in snapshotInput) (snapshotOutcome, error) {
	s.setSnapshotState("updating", "")
	seq, err := workflow.Step(ctx, "announce", 1, func(c context.Context) (int64, error) {
		return s.report(c, &cardv1.CatalogReport{Kind: "snapshot", Name: "crosswalk", State: "started", Version: s.Snapshots.Current().Version}, "Checking for a newer crosswalk snapshot")
	})
	if err != nil {
		return snapshotOutcome{}, err
	}
	fail := func(stepErr error) (snapshotOutcome, error) {
		s.setSnapshotState("failed", stepErr.Error())
		_, _ = workflow.Step(ctx, "fail", 1, func(c context.Context) (bool, error) {
			return true, s.updateReport(c, seq, &cardv1.CatalogReport{Kind: "snapshot", Name: "crosswalk", State: "failed", Version: s.Snapshots.Current().Version, Error: stepErr.Error()})
		})
		return snapshotOutcome{}, stepErr
	}
	type checked struct {
		Check     SnapshotCheck `json:"check"`
		NoRelease bool          `json:"no_release,omitempty"`
		Reason    string        `json:"reason,omitempty"`
	}
	looked, err := workflow.Step(ctx, "check", 2, func(c context.Context) (checked, error) {
		res, err := s.Snapshots.Check(c)
		if errors.Is(err, ErrNoRelease) {
			return checked{NoRelease: true, Reason: err.Error()}, nil
		}
		return checked{Check: res}, err
	})
	if err != nil {
		return fail(err)
	}
	if looked.NoRelease {
		cur := s.Snapshots.Current()
		if cur.Present {
			s.setSnapshotState("ready", "")
		} else {
			s.setSnapshotState("missing", looked.Reason)
		}
		s.Log.Info("crosswalk mirror has nothing to offer yet", "detail", looked.Reason, "local", cur.Version)
		_, err := workflow.Step(ctx, "no-release", 1, func(c context.Context) (bool, error) {
			return true, s.updateReport(c, seq, &cardv1.CatalogReport{Kind: "snapshot", Name: "crosswalk", State: "skipped", Version: cur.Version, Detail: looked.Reason})
		})
		return snapshotOutcome{Version: cur.Version, Skipped: true}, err
	}
	check := looked.Check
	if !check.Newer && !in.Force {
		s.setSnapshotState("ready", "")
		_, err := workflow.Step(ctx, "skip", 1, func(c context.Context) (bool, error) {
			return true, s.updateReport(c, seq, &cardv1.CatalogReport{Kind: "snapshot", Name: "crosswalk", State: "skipped", Version: check.Local, Detail: "The mirror offers " + orNone(check.Remote) + ", which is already in use"})
		})
		return snapshotOutcome{Version: check.Local, Skipped: true}, err
	}
	start := time.Now()
	res, err := workflow.Step(ctx, "update", 1, func(c context.Context) (SnapshotResult, error) {
		return s.Snapshots.Update(c, func(stage string) { s.Log.Info("snapshot update", "stage", stage) })
	})
	if err != nil {
		return fail(err)
	}
	s.setSnapshotState("ready", "")
	_, err = workflow.Step(ctx, "finish", 1, func(c context.Context) (bool, error) {
		return true, s.updateReport(c, seq, &cardv1.CatalogReport{Kind: "snapshot", Name: "crosswalk", State: "done", Version: res.Version, Bytes: res.Bytes, DurationMs: time.Since(start).Milliseconds(), Detail: "Fetched via " + res.Via})
	})
	return snapshotOutcome{Version: res.Version, Via: res.Via, Bytes: res.Bytes, Skipped: res.Skipped}, err
}

func orNone(v string) string {
	if v == "" {
		return "nothing"
	}
	return v
}

func (s *Service) scheduledSnapshot(ctx dbos.Context, _ dbos.ScheduledWorkflowInput) (any, error) {
	return s.snapshotWorkflow(ctx, snapshotInput{})
}

func (s *Service) setSnapshotState(state, lastError string) {
	s.snap.mu.Lock()
	defer s.snap.mu.Unlock()
	s.snap.state, s.snap.lastError, s.snap.checkedAt = state, lastError, time.Now()
}

// datasetWorkflow downloads one bulk dataset into its tables and records the outcome on its row and in #catalog
func (s *Service) datasetWorkflow(ctx dbos.Context, in datasetInput) (datasetOutcome, error) {
	info, ok := s.datasetInfo(in.Name)
	if !ok {
		return datasetOutcome{}, fmt.Errorf("%w: dataset %s", ErrNotFound, in.Name)
	}
	wfID, _ := dbos.GetWorkflowID(ctx)
	seq, err := workflow.Step(ctx, "announce", 1, func(c context.Context) (int64, error) {
		if err := s.Ent.DatasetImport.Create().SetID(info.Name).SetEnabled(true).SetState(datasetimport.StateDownloading).SetStartedAt(time.Now()).SetError("").SetWorkflowID(wfID).
			OnConflictColumns(datasetimport.FieldID).UpdateState().UpdateStartedAt().UpdateError().UpdateWorkflowID().UpdateUpdatedAt().Exec(c); err != nil {
			return 0, err
		}
		return s.report(c, &cardv1.CatalogReport{Kind: "dataset", Name: info.Title, State: "started", Detail: info.URL}, "Importing "+info.Title)
	})
	if err != nil {
		return datasetOutcome{}, err
	}
	start := time.Now()
	res, err := workflow.Step(ctx, "import", 1, func(c context.Context) (DatasetResult, error) {
		return s.Datasets.Import(c, info.Name, func(rows, bytes int64) {
			_ = s.Ent.DatasetImport.UpdateOneID(info.Name).SetState(datasetimport.StateLoading).SetRows(rows).SetBytes(bytes).Exec(c)
		})
	})
	if err != nil {
		_, _ = workflow.Step(ctx, "fail", 1, func(c context.Context) (bool, error) {
			if uerr := s.Ent.DatasetImport.UpdateOneID(info.Name).SetState(datasetimport.StateFailed).SetError(err.Error()).SetFinishedAt(time.Now()).Exec(c); uerr != nil {
				return false, uerr
			}
			return true, s.updateReport(c, seq, &cardv1.CatalogReport{Kind: "dataset", Name: info.Title, State: "failed", Error: err.Error(), DurationMs: time.Since(start).Milliseconds()})
		})
		return datasetOutcome{}, err
	}
	_, err = workflow.Step(ctx, "finish", 1, func(c context.Context) (bool, error) {
		update := s.Ent.DatasetImport.UpdateOneID(info.Name).SetState(datasetimport.StateDone).SetFinishedAt(time.Now()).SetEtag(res.ETag)
		if !res.Unchanged {
			update.SetRows(res.Rows).SetBytes(res.Bytes)
		}
		if !res.LastModified.IsZero() {
			update.SetLastModified(res.LastModified)
		}
		if err := update.Exec(c); err != nil {
			return false, err
		}
		state, detail := "done", ""
		if res.Unchanged {
			state, detail = "skipped", "The file has not changed since the last import"
		}
		return true, s.updateReport(c, seq, &cardv1.CatalogReport{Kind: "dataset", Name: info.Title, State: state, Rows: res.Rows, Bytes: res.Bytes, DurationMs: time.Since(start).Milliseconds(), Detail: detail})
	})
	return datasetOutcome{Rows: res.Rows, Bytes: res.Bytes, Unchanged: res.Unchanged}, err
}

// datasetsWorkflow imports every enabled dataset in name order
func (s *Service) datasetsWorkflow(ctx dbos.Context, _ struct{}) ([]string, error) {
	names, err := workflow.Step(ctx, "enabled", 1, func(c context.Context) ([]string, error) {
		rows, err := s.Ent.DatasetImport.Query().Where(datasetimport.Enabled(true)).Order(ent.Asc(datasetimport.FieldID)).All(c)
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(rows))
		for _, r := range rows {
			out = append(out, r.ID)
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return names, err
		}
		h, err := dbos.RunWorkflow(ctx, s.datasetWorkflow, datasetInput{Name: name})
		if err != nil {
			return names, err
		}
		if _, err := h.GetResult(); err != nil {
			if ctx.Err() != nil || errors.Is(err, dbos.ErrWorkflowCancelled) || errors.Is(err, dbos.ErrAwaitedWorkflowCancelled) {
				return names, err
			}
			s.Log.Warn("dataset import failed", "dataset", name, "error", err)
		}
	}
	return names, nil
}

func (s *Service) scheduledDatasets(ctx dbos.Context, _ dbos.ScheduledWorkflowInput) (any, error) {
	return s.datasetsWorkflow(ctx, struct{}{})
}

// retrainWorkflow refits the matcher of every kind from decided and undecided edges
func (s *Service) retrainWorkflow(ctx dbos.Context, _ struct{}) (retrainOutcome, error) {
	type sample struct {
		Labeled   []Labeled            `json:"labeled"`
		Unlabeled []map[string]float64 `json:"unlabeled"`
	}
	samples, err := workflow.Step(ctx, "pairs", 1, func(c context.Context) (map[string]sample, error) {
		edges, err := s.Ent.MatchEdge.Query().Order(ent.Desc(matchedge.FieldCreatedAt)).Limit(20000).All(c)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(edges))
		for _, e := range edges {
			ids = append(ids, e.EntityID)
		}
		kinds := map[string]string{}
		for start := 0; start < len(ids); start += 500 {
			end := min(start+500, len(ids))
			rows, err := s.Ent.Entity.Query().Where(entity.IDIn(ids[start:end]...)).Select(entity.FieldID, entity.FieldKind).All(c)
			if err != nil {
				return nil, err
			}
			for _, r := range rows {
				kinds[r.ID] = r.Kind
			}
		}
		out := map[string]sample{}
		for _, e := range edges {
			kind, ok := kinds[e.EntityID]
			if len(e.Features) == 0 || !ok {
				continue
			}
			sm := out[kind]
			switch e.State {
			case matchedge.StateAccepted:
				sm.Labeled = append(sm.Labeled, Labeled{Features: e.Features, Match: true})
			case matchedge.StateRejected:
				sm.Labeled = append(sm.Labeled, Labeled{Features: e.Features, Match: false})
			default:
				sm.Unlabeled = append(sm.Unlabeled, e.Features)
			}
			out[kind] = sm
		}
		return out, nil
	})
	if err != nil {
		return retrainOutcome{}, err
	}
	kinds := make([]string, 0, len(samples))
	for k := range samples {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	out := retrainOutcome{Kinds: map[string]int{}, Skipped: map[string]string{}}
	var failures []string
	for _, kind := range kinds {
		sm := samples[kind]
		type fitted struct {
			Pairs   int    `json:"pairs"`
			Skipped string `json:"skipped,omitempty"`
		}
		res, err := workflow.Step(ctx, "fit:"+kind, 1, func(c context.Context) (fitted, error) {
			n, err := s.Trainer.Fit(kind, sm.Labeled, sm.Unlabeled)
			if errors.Is(err, ErrTooFewPairs) {
				return fitted{Skipped: err.Error()}, nil
			}
			if err != nil {
				return fitted{}, err
			}
			weights, err := s.Trainer.Weights(kind)
			if err != nil {
				return fitted{}, err
			}
			return fitted{Pairs: n}, s.Ent.MatchModel.Create().SetID(kind).SetWeights(weights).SetPairs(int64(n)).
				OnConflictColumns(matchmodel.FieldID).UpdateWeights().UpdatePairs().UpdateTrainedAt().Exec(c)
		})
		if err != nil {
			failures = append(failures, kind+": "+err.Error())
			continue
		}
		if res.Skipped != "" {
			out.Skipped[kind] = res.Skipped
			continue
		}
		out.Kinds[kind] = res.Pairs
	}
	if len(failures) > 0 {
		_, _ = workflow.Step(ctx, "report", 1, func(c context.Context) (int64, error) {
			return s.report(c, &cardv1.CatalogReport{Kind: "matcher", Name: "retrain", State: "failed", Error: strings.Join(failures, "\n")}, "Retraining the matcher failed for some kinds")
		})
		return out, errors.New("catalog: retrain failed for " + strings.Join(failures, "; "))
	}
	return out, nil
}

// propagateWorkflow merges entities joined by review edges whose strongest chain reaches the accept threshold
func (s *Service) propagateWorkflow(ctx dbos.Context, _ struct{}) (propagateOutcome, error) {
	type link struct {
		A, B string
		P    float64
	}
	links, err := workflow.Step(ctx, "edges", 1, func(c context.Context) ([]link, error) {
		rows, err := s.Ent.MatchEdge.Query().Where(matchedge.Namespace("entity"), matchedge.StateIn(matchedge.StateReview, matchedge.StateAccepted, matchedge.StateAuto)).All(c)
		if err != nil {
			return nil, err
		}
		out := make([]link, 0, len(rows))
		for _, r := range rows {
			out = append(out, link{A: r.EntityID, B: r.Value, P: r.Probability})
		}
		return out, nil
	})
	if err != nil {
		return propagateOutcome{}, err
	}
	edges := make([]match.Edge, 0, len(links))
	for _, l := range links {
		edges = append(edges, match.Edge{A: l.A, B: l.B, P: l.P})
	}
	var out propagateOutcome
	for _, comp := range match.Propagate(edges, acceptProbability) {
		if len(comp.Nodes) < 2 {
			continue
		}
		merged, err := workflow.Step(ctx, "merge:"+comp.Nodes[0], 1, func(c context.Context) (int, error) {
			return s.mergeComponent(c, comp.Nodes)
		})
		if err != nil {
			return out, err
		}
		out.Merged += merged
	}
	return out, nil
}

// mergeComponent folds every live entity of a component into its oldest member and closes their reviews
func (s *Service) mergeComponent(ctx context.Context, nodes []string) (int, error) {
	var live []*ent.Entity
	for _, id := range nodes {
		e, err := s.GetEntity(ctx, id)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return 0, err
		}
		live = append(live, e)
	}
	if len(live) < 2 {
		return 0, nil
	}
	sort.Slice(live, func(i, j int) bool { return live[i].CreatedAt.Before(live[j].CreatedAt) })
	target := live[0]
	merged := 0
	seen := map[string]bool{target.ID: true}
	for _, e := range live[1:] {
		if seen[e.ID] || e.Kind != target.Kind {
			continue
		}
		seen[e.ID] = true
		if err := s.Merge(ctx, e.ID, target.ID); err != nil {
			return merged, err
		}
		merged++
	}
	edges, err := s.Ent.MatchEdge.Query().Where(matchedge.Namespace("entity"), matchedge.StateEQ(matchedge.StateReview), matchedge.EntityIDIn(nodes...)).All(ctx)
	if err != nil {
		return merged, err
	}
	now := time.Now()
	for _, edge := range edges {
		if err := s.Ent.MatchEdge.UpdateOneID(edge.ID).SetState(matchedge.StateAccepted).SetDecidedBy("propagation").SetDecidedAt(now).Exec(ctx); err != nil {
			return merged, err
		}
		if edge.MessageSeq != 0 {
			if err := s.closeReview(ctx, edge.MessageSeq, now); err != nil {
				return merged, err
			}
		}
	}
	return merged, nil
}

// closeReview marks a review card accepted by the matcher itself
func (s *Service) closeReview(ctx context.Context, seq int64, at time.Time) error {
	m, err := s.Timeline.GetMessage(ctx, seq)
	if err != nil {
		return err
	}
	card := &cardv1.MatchReview{}
	if err := proto.Unmarshal(m.Card, card); err != nil {
		return err
	}
	card.State = cardv1.MatchState_MATCH_STATE_ACCEPTED
	card.DecidedBy = "propagation"
	card.DecidedByName = "the matcher, by transitive evidence"
	card.DecidedAt = timestamppb.New(at)
	_, err = s.Timeline.UpdateCard(ctx, seq, card, timeline.OriginSystem)
	return err
}

func (s *Service) scheduledPropagate(ctx dbos.Context, _ dbos.ScheduledWorkflowInput) (any, error) {
	return s.propagateWorkflow(ctx, struct{}{})
}

func (s *Service) scheduledRetrain(ctx dbos.Context, _ dbos.ScheduledWorkflowInput) (any, error) {
	return s.retrainWorkflow(ctx, struct{}{})
}
