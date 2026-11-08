package catalog

import (
	"context"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/sourcerecord"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/sourcestate"
)

// Recorder persists outbound records and source counters in the application database
type Recorder struct {
	ent *ent.Client
}

// NewRecorder returns the provenance store the client layer writes through
func NewRecorder(entc *ent.Client) *Recorder { return &Recorder{ent: entc} }

func (r *Recorder) Latest(ctx context.Context, source, url string) (*outbound.Record, error) {
	row, err := r.ent.SourceRecord.Query().
		Where(sourcerecord.Source(source), sourcerecord.URL(url)).
		Order(ent.Desc(sourcerecord.FieldFetchedAt)).
		First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &outbound.Record{ID: row.ID, Source: row.Source, Namespace: row.Namespace, ExtValue: row.ExtValue, Kind: row.Kind, URL: row.URL, Status: int(row.Status), ETag: row.Etag, Body: row.Payload, License: row.License, FetchedAt: row.FetchedAt}, nil
}

func (r *Recorder) Save(ctx context.Context, rec *outbound.Record) (string, error) {
	row, err := r.ent.SourceRecord.Create().
		SetSource(rec.Source).SetNamespace(rec.Namespace).SetExtValue(rec.ExtValue).SetKind(rec.Kind).
		SetURL(rec.URL).SetStatus(int32(rec.Status)).SetEtag(rec.ETag).SetPayload(rec.Body).SetLicense(rec.License).
		SetFetchedAt(rec.FetchedAt).Save(ctx)
	if err != nil {
		return "", err
	}
	return row.ID, nil
}

func (r *Recorder) Touch(ctx context.Context, id string, at time.Time) error {
	return r.ent.SourceRecord.Update().Where(sourcerecord.ID(id)).SetFetchedAt(at).Exec(ctx)
}

func (r *Recorder) LoadCalls(ctx context.Context, source string) (int, time.Time, error) {
	row, err := r.ent.SourceState.Get(ctx, source)
	if ent.IsNotFound(err) {
		return 0, time.Time{}, nil
	}
	if err != nil {
		return 0, time.Time{}, err
	}
	return int(row.CallsToday), row.CallsResetAt, nil
}

func (r *Recorder) StoreCalls(ctx context.Context, source string, calls int, resetAt time.Time) error {
	return r.ent.SourceState.Create().SetID(source).SetCallsToday(int32(calls)).SetCallsResetAt(resetAt).
		OnConflictColumns(sourcestate.FieldID).UpdateCallsToday().UpdateCallsResetAt().UpdateUpdatedAt().Exec(ctx)
}

func (r *Recorder) Health(ctx context.Context, source string, ok bool, detail string, at time.Time) error {
	create := r.ent.SourceState.Create().SetID(source)
	if ok {
		return create.SetLastOkAt(at).OnConflictColumns(sourcestate.FieldID).UpdateLastOkAt().UpdateUpdatedAt().Exec(ctx)
	}
	return create.SetLastError(detail).SetLastErrorAt(at).OnConflictColumns(sourcestate.FieldID).UpdateLastError().UpdateLastErrorAt().UpdateUpdatedAt().Exec(ctx)
}
