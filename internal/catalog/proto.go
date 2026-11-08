package catalog

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/claim"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/extid"
	catalogv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/catalog/v1"
)

var kindToProto = map[string]catalogv1.EntityKind{
	model.KindMovie:   catalogv1.EntityKind_ENTITY_KIND_MOVIE,
	model.KindSeries:  catalogv1.EntityKind_ENTITY_KIND_SERIES,
	model.KindSeason:  catalogv1.EntityKind_ENTITY_KIND_SEASON,
	model.KindEpisode: catalogv1.EntityKind_ENTITY_KIND_EPISODE,
}

// KindString maps the proto enum onto the kind name, empty for unspecified
func KindString(k catalogv1.EntityKind) string {
	for name, v := range kindToProto {
		if v == k {
			return name
		}
	}
	return ""
}

// value decodes stored JSON into a proto Value
func value(raw []byte) *structpb.Value {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return structpb.NewStringValue(string(raw))
	}
	pv, err := structpb.NewValue(v)
	if err != nil {
		return structpb.NewStringValue(string(raw))
	}
	return pv
}

func fieldProto(f *ent.EntityField) *catalogv1.FieldValue {
	return &catalogv1.FieldValue{
		Field:      f.Field,
		Value:      value(f.Value),
		Source:     f.Source,
		Reason:     string(f.Reason),
		Agreement:  f.Agreement,
		Claims:     f.Claims,
		ObservedAt: timestamppb.New(f.ObservedAt),
		Pinned:     f.Reason == "pin",
		Confidence: f.Confidence,
	}
}

func claimProto(c *ent.Claim) *catalogv1.Claim {
	return &catalogv1.Claim{
		Id:         c.ID,
		Field:      c.Field,
		Value:      value(c.Value),
		Source:     c.Source,
		Confidence: c.Confidence,
		Rank:       c.Rank,
		ObservedAt: timestamppb.New(c.ObservedAt),
		Pinned:     c.Pinned,
		RecordId:   c.RecordID,
	}
}

// artworkProto renders one ready artwork with its served variants
func (s *Service) artworkProto(a *ent.Artwork) *catalogv1.Artwork {
	out := &catalogv1.Artwork{
		Id:        a.ID,
		Kind:      string(a.Kind),
		Url:       s.absolute(s.Artworks.URL(a, 0, "")),
		Width:     a.Width,
		Height:    a.Height,
		Thumbhash: base64.StdEncoding.EncodeToString(a.Thumbhash),
		Source:    a.Source,
		Language:  a.Language,
	}
	for _, v := range a.Variants {
		out.Variants = append(out.Variants, &catalogv1.ArtworkVariant{Width: v.Width, Format: v.Format, Url: s.absolute(s.Artworks.URL(a, v.Width, v.Format)), Bytes: v.Bytes})
	}
	return out
}

// EntityProto renders an entity with its resolved fields, ids, and best artwork
func (s *Service) EntityProto(ctx context.Context, e *ent.Entity) (*catalogv1.Entity, error) {
	fields, err := s.Fields(ctx, e.ID)
	if err != nil {
		return nil, err
	}
	xids, err := s.Ent.ExtID.Query().Where(extid.EntityID(e.ID)).Order(ent.Asc(extid.FieldNamespace)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := &catalogv1.Entity{
		Id:            e.ID,
		Kind:          kindToProto[e.Kind],
		Title:         e.Title,
		OriginalTitle: fieldString(fields, model.FieldOriginalTitle),
		Year:          e.Year,
		Overview:      fieldString(fields, model.FieldOverview),
		ParentId:      e.ParentID,
		Ordinal:       e.Ordinal,
		CreatedAt:     timestamppb.New(e.CreatedAt),
		UpdatedAt:     timestamppb.New(e.UpdatedAt),
		MergedIntoId:  e.MergedIntoID,
	}
	for _, f := range fields {
		out.Fields = append(out.Fields, fieldProto(f))
	}
	for _, x := range xids {
		out.ExternalIds = append(out.ExternalIds, &catalogv1.ExternalId{Namespace: x.Namespace, Value: x.Value, PMatch: float32(x.PMatch), Source: x.Source, Url: xidURL(x.Namespace, x.Value)})
	}
	if e.ParentID != "" {
		parent, err := s.GetEntity(ctx, e.ParentID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if parent != nil {
			out.ParentTitle = parent.Title
		}
	}
	for _, pair := range []struct {
		kind artwork.Kind
		dst  **catalogv1.Artwork
	}{{artwork.KindPoster, &out.Poster}, {artwork.KindBackdrop, &out.Backdrop}} {
		a, err := s.bestArtwork(ctx, e.ID, pair.kind)
		if err != nil {
			return nil, err
		}
		if a != nil {
			*pair.dst = s.artworkProto(a)
		}
	}
	return out, nil
}

// Claims lists every claim on an entity, newest observation first
func (s *Service) Claims(ctx context.Context, entityID string) ([]*catalogv1.Claim, error) {
	rows, err := s.Ent.Claim.Query().Where(claim.EntityID(entityID)).Order(ent.Asc(claim.FieldField), ent.Desc(claim.FieldObservedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*catalogv1.Claim, 0, len(rows))
	for _, c := range rows {
		out = append(out, claimProto(c))
	}
	return out, nil
}

// ReadyArtwork lists the ready artwork of an entity by kind and score
func (s *Service) ReadyArtwork(ctx context.Context, entityID string) ([]*catalogv1.Artwork, error) {
	rows, err := s.Ent.Artwork.Query().Where(artwork.EntityID(entityID), artwork.StateEQ(artwork.StateReady)).Order(ent.Asc(artwork.FieldKind), ent.Desc(artwork.FieldScore)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*catalogv1.Artwork, 0, len(rows))
	for _, a := range rows {
		out = append(out, s.artworkProto(a))
	}
	return out, nil
}

// Children lists the live children of an entity in ordinal order
func (s *Service) Children(ctx context.Context, entityID string) ([]*ent.Entity, error) {
	return s.Ent.Entity.Query().Where(entity.ParentID(entityID), entity.MergedIntoIDIsNil()).Order(ent.Asc(entity.FieldOrdinal)).All(ctx)
}

// hitProto renders a ranked hit as a candidate
func (s *Service) hitProto(ctx context.Context, h Hit) (*catalogv1.Candidate, error) {
	e, err := s.EntityProto(ctx, h.Entity)
	if err != nil {
		return nil, err
	}
	return &catalogv1.Candidate{Entity: e, Score: float32(h.Score), Explanation: h.Explanation, MatchedOn: h.MatchedOn, Local: h.Local}, nil
}

func outcomesProto(outcomes []Outcome) []*catalogv1.SourceOutcome {
	out := make([]*catalogv1.SourceOutcome, 0, len(outcomes))
	for _, o := range outcomes {
		out = append(out, &catalogv1.SourceOutcome{Source: o.Source, State: o.State, Detail: o.Detail, Results: int32(o.Results), DurationMs: o.Duration.Milliseconds()})
	}
	return out
}
