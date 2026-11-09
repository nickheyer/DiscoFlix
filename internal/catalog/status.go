package catalog

import (
	"context"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/matchedge"
	catalogv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/catalog/v1"
)

func stamp(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}

func stampPtr(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

// SnapshotProto reports the crosswalk in use and the state of the update workflow
func (s *Service) SnapshotProto() *catalogv1.Snapshot {
	cur := s.Snapshots.Current()
	mirror, _, _ := s.CatalogSettings()
	s.snap.mu.Lock()
	state, lastErr, checked := s.snap.state, s.snap.lastError, s.snap.checkedAt
	s.snap.mu.Unlock()
	if state == "" {
		state = "missing"
		if cur.Present {
			state = "ready"
		}
	}
	return &catalogv1.Snapshot{
		Version:     cur.Version,
		BuiltAt:     stamp(cur.BuiltAt),
		Items:       cur.Items,
		ExternalIds: cur.XIDs,
		Bytes:       cur.Bytes,
		Mirror:      mirror,
		State:       state,
		LastError:   lastErr,
		CheckedAt:   stamp(checked),
		UpdatedAt:   stamp(cur.UpdatedAt),
		Via:         cur.Via,
	}
}

// SourceProto describes one source with its configuration and live health
func (s *Service) SourceProto(ctx context.Context, name string) (*catalogv1.Source, error) {
	s.mu.RLock()
	e, ok := s.sources[name]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrUnknownSource
	}
	keys := s.keysFor(name)
	out := &catalogv1.Source{
		Name:         name,
		Title:        e.Describe().Name,
		Enabled:      e.enabled,
		Configured:   s.configured(e),
		NeedsKey:     e.NeedsKey(),
		KeyHint:      e.KeyHint(),
		License:      e.License(),
		Namespaces:   e.Namespaces(),
		Options:      e.options,
		HasClientKey: keys.ClientKey != "",
		Budget:       int32(e.Policy().Budget),
		Artwork:      e.Artwork(),
	}
	row, err := s.Ent.SourceState.Get(ctx, name)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if row != nil {
		out.LastError = row.LastError
		out.LastOkAt = stampPtr(row.LastOkAt)
		out.LastErrorAt = stampPtr(row.LastErrorAt)
		out.CallsToday = row.CallsToday
	}
	health, live := s.Outbound.State(name)
	if live {
		out.CallsToday = int32(health.Calls)
	}
	switch {
	case !e.enabled:
		out.State = "disabled"
	case !out.Configured:
		out.State = "unconfigured"
	case live && health.Breaker == "open":
		out.State = "open"
	case row != nil && row.LastErrorAt != nil && (row.LastOkAt == nil || row.LastErrorAt.After(*row.LastOkAt)):
		out.State = "failing"
	case row != nil && row.LastOkAt != nil:
		out.State = "ok"
	default:
		out.State = "idle"
	}
	return out, nil
}

// Status assembles everything the catalog settings page shows
func (s *Service) Status(ctx context.Context) (*catalogv1.GetCatalogStatusResponse, error) {
	out := &catalogv1.GetCatalogStatusResponse{Snapshot: s.SnapshotProto()}
	s.mu.RLock()
	names := append([]string(nil), s.order...)
	s.mu.RUnlock()
	for _, name := range names {
		src, err := s.SourceProto(ctx, name)
		if err != nil {
			return nil, err
		}
		out.Sources = append(out.Sources, src)
	}
	rows, err := s.Ent.DatasetImport.Query().All(ctx)
	if err != nil {
		return nil, err
	}
	byName := map[string]*ent.DatasetImport{}
	for _, r := range rows {
		byName[r.ID] = r
	}
	for _, d := range s.Datasets.List() {
		di := &catalogv1.DatasetImport{Dataset: d.Name, Title: d.Title, License: d.License, State: "idle"}
		if r, ok := byName[d.Name]; ok {
			di.Enabled, di.State, di.Rows, di.Bytes, di.Error, di.Etag = r.Enabled, string(r.State), r.Rows, r.Bytes, r.Error, r.Etag
			di.StartedAt, di.FinishedAt, di.LastModified = stampPtr(r.StartedAt), stampPtr(r.FinishedAt), stampPtr(r.LastModified)
		}
		out.Datasets = append(out.Datasets, di)
	}
	models, err := s.Ent.MatchModel.Query().All(ctx)
	if err != nil {
		return nil, err
	}
	out.Model = &catalogv1.MatchModel{}
	for _, m := range models {
		out.Model.Pairs += m.Pairs
		if out.Model.TrainedAt == nil || m.TrainedAt.After(out.Model.TrainedAt.AsTime()) {
			out.Model.TrainedAt = timestamppb.New(m.TrainedAt)
		}
	}
	for state, dst := range map[matchedge.State]*int64{matchedge.StateAccepted: &out.Model.Accepted, matchedge.StateRejected: &out.Model.Rejected, matchedge.StateReview: &out.Model.PendingReviews} {
		n, err := s.Ent.MatchEdge.Query().Where(matchedge.StateEQ(state)).Count(ctx)
		if err != nil {
			return nil, err
		}
		*dst = int64(n)
	}
	entities, err := s.Ent.Entity.Query().Where(entity.MergedIntoIDIsNil()).Count(ctx)
	if err != nil {
		return nil, err
	}
	claims, err := s.Ent.Claim.Query().Count(ctx)
	if err != nil {
		return nil, err
	}
	arts, err := s.Ent.Artwork.Query().Where(artwork.StateEQ(artwork.StateReady)).Count(ctx)
	if err != nil {
		return nil, err
	}
	out.Entities, out.Claims, out.Artworks = int64(entities), int64(claims), int64(arts)
	_, out.Peers, out.Language = s.CatalogSettings()
	return out, nil
}
