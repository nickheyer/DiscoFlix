package catalog

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	connect "connectrpc.com/connect/v2"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/extid"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/matchedge"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

// Card is the EntityCard schema, posted when a title resolves
func Card() extension.CardSchema { return extension.BuiltinCard(&cardv1.EntityCard{}) }

// ReportCard is the CatalogReport schema for snapshot, dataset, and refresh progress
func ReportCard() extension.CardSchema { return extension.BuiltinCard(&cardv1.CatalogReport{}) }

// EntityURL is the web page of an entity
func (s *Service) EntityURL(id string) string {
	base := s.LinkBase()
	if base == "" {
		return "/catalog/e/" + id
	}
	return base + "/catalog/e/" + id
}

// xidURL links an external id to its page on the source site
func xidURL(namespace, value string) string {
	switch namespace {
	case model.NSIMDb:
		return "https://www.imdb.com/title/" + value + "/"
	case model.NSTMDB:
		prefix, rest := model.SplitValue(value)
		parts := strings.Split(rest, "/")
		switch {
		case prefix == "movie":
			return "https://www.themoviedb.org/movie/" + rest
		case len(parts) == 1:
			return "https://www.themoviedb.org/tv/" + rest
		case len(parts) == 2:
			return "https://www.themoviedb.org/tv/" + parts[0] + "/season/" + parts[1]
		default:
			return "https://www.themoviedb.org/tv/" + parts[0] + "/season/" + parts[1] + "/episode/" + parts[2]
		}
	case model.NSTVDB:
		prefix, rest := model.SplitValue(value)
		if prefix == "" {
			prefix = "series"
		}
		return "https://thetvdb.com/dereferrer/" + prefix + "/" + rest
	case model.NSWikidata:
		return "https://www.wikidata.org/wiki/" + value
	case model.NSTrakt:
		prefix, rest := model.SplitValue(value)
		if prefix == "" {
			prefix = "show"
		}
		return "https://trakt.tv/search/trakt/" + rest + "?id_type=" + prefix
	case model.NSLetterboxd:
		return "https://letterboxd.com/film/" + value + "/"
	case model.NSTVmaze:
		return "https://www.tvmaze.com/shows/" + value
	case model.NSNetflix:
		return "https://www.netflix.com/title/" + value
	case model.NSRottenTomatoes:
		return "https://www.rottentomatoes.com/" + value
	case model.NSMetacritic:
		return "https://www.metacritic.com/" + value
	case model.NSAniDB:
		return "https://anidb.net/anime/" + value
	case model.NSAniList:
		return "https://anilist.co/anime/" + value
	case model.NSMAL:
		return "https://myanimelist.net/anime/" + value
	case model.NSDouban:
		return "https://movie.douban.com/subject/" + value + "/"
	case model.NSKinopoisk:
		return "https://www.kinopoisk.ru/film/" + value + "/"
	}
	return ""
}

// fieldString reads one resolved string field
func fieldString(fields []*ent.EntityField, name string) string {
	for _, f := range fields {
		if f.Field == name {
			var v string
			if json.Unmarshal(f.Value, &v) == nil {
				return v
			}
		}
	}
	return ""
}

// poster returns the best ready artwork of a kind for an entity
func (s *Service) bestArtwork(ctx context.Context, entityID string, kind artwork.Kind) (*ent.Artwork, error) {
	a, err := s.Ent.Artwork.Query().
		Where(artwork.EntityID(entityID), artwork.KindEQ(kind), artwork.StateEQ(artwork.StateReady)).
		Order(ent.Desc(artwork.FieldScore)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	return a, err
}

// EntityCard renders an entity as the card every transport shows
func (s *Service) EntityCard(ctx context.Context, e *ent.Entity, confidence float64, explanation string) (*cardv1.EntityCard, error) {
	fields, err := s.Fields(ctx, e.ID)
	if err != nil {
		return nil, err
	}
	xids, err := s.Ent.ExtID.Query().Where(extid.EntityID(e.ID)).Order(ent.Asc(extid.FieldNamespace)).All(ctx)
	if err != nil {
		return nil, err
	}
	card := &cardv1.EntityCard{
		EntityId:      e.ID,
		Kind:          e.Kind,
		Title:         e.Title,
		OriginalTitle: fieldString(fields, model.FieldOriginalTitle),
		Year:          e.Year,
		Overview:      fieldString(fields, model.FieldOverview),
		Confidence:    float32(confidence),
		Explanation:   explanation,
		Fields:        int32(len(fields)),
		Url:           s.EntityURL(e.ID),
	}
	if card.OriginalTitle == card.Title {
		card.OriginalTitle = ""
	}
	sources := map[string]bool{}
	for _, f := range fields {
		sources[f.Source] = true
	}
	for name := range sources {
		card.Sources = append(card.Sources, name)
	}
	sort.Strings(card.Sources)
	for _, x := range xids {
		card.ExternalIds = append(card.ExternalIds, &cardv1.ExternalRef{Namespace: x.Namespace, Value: x.Value, Url: xidURL(x.Namespace, x.Value)})
	}
	poster, err := s.bestArtwork(ctx, e.ID, artwork.KindPoster)
	if err != nil {
		return nil, err
	}
	if poster != nil {
		card.PosterUrl = s.absolute(s.Artworks.URL(poster, 342, "webp"))
		card.Thumbhash = base64.StdEncoding.EncodeToString(poster.Thumbhash)
	}
	return card, nil
}

// absolute prefixes a served path with the public address when one is known
func (s *Service) absolute(path string) string {
	if path == "" || strings.HasPrefix(path, "http") {
		return path
	}
	if base := s.LinkBase(); base != "" {
		return base + path
	}
	return path
}

// report posts a CatalogReport card to #catalog and returns its seq
func (s *Service) report(ctx context.Context, r *cardv1.CatalogReport, content string) (int64, error) {
	m, err := s.Timeline.PostSystem(ctx, channelName, content, r)
	if err != nil {
		return 0, err
	}
	return m.GetSeq(), nil
}

// updateReport replaces the card of an earlier report
func (s *Service) updateReport(ctx context.Context, seq int64, r *cardv1.CatalogReport) error {
	_, err := s.Timeline.UpdateCard(ctx, seq, r, timeline.OriginSystem)
	return err
}

// openReview records a doubtful link as an edge and asks for a decision in #catalog
func (s *Service) openReview(ctx context.Context, e *ent.Entity, p *pendingReview) error {
	edge, err := s.Ent.MatchEdge.Create().
		SetEntityID(e.ID).SetNamespace("entity").SetValue(p.candidate.ID).SetSource(p.group.Source).
		SetCandidateTitle(p.candidate.Title).SetCandidateYear(p.candidate.Year).
		SetProbability(p.probability).SetFeatures(p.features).SetTier(1).SetState(matchedge.StateReview).Save(ctx)
	if err != nil {
		return err
	}
	return s.postReview(ctx, edge, e, p.candidate.Title, int(p.candidate.Year), s.Scorer.Explain(p.features))
}

// postReview posts the MatchReview card for an edge and remembers its seq
func (s *Service) postReview(ctx context.Context, edge *ent.MatchEdge, e *ent.Entity, candidateTitle string, candidateYear int, evidence string) error {
	card := &cardv1.MatchReview{
		EdgeId:             edge.ID,
		EntityId:           e.ID,
		EntityKind:         e.Kind,
		EntityTitle:        e.Title,
		EntityYear:         e.Year,
		CandidateSource:    edge.Source,
		CandidateNamespace: edge.Namespace,
		CandidateValue:     edge.Value,
		CandidateTitle:     candidateTitle,
		CandidateYear:      int32(candidateYear),
		CandidateUrl:       xidURL(edge.Namespace, edge.Value),
		Probability:        float32(edge.Probability),
		Evidence:           evidence,
		State:              cardv1.MatchState_MATCH_STATE_PENDING,
	}
	content := fmt.Sprintf("Is %s the same title as %s? The matcher puts it at %.0f%%.", describe(e.Title, int(e.Year)), describe(candidateTitle, candidateYear), edge.Probability*100)
	m, err := s.Timeline.PostSystem(ctx, channelName, content, card)
	if err != nil {
		return err
	}
	return s.Ent.MatchEdge.UpdateOneID(edge.ID).SetMessageSeq(m.GetSeq()).Exec(ctx)
}

func describe(title string, year int) string {
	if title == "" {
		title = "an untitled entry"
	}
	if year > 0 {
		return fmt.Sprintf("%s (%d)", title, year)
	}
	return title
}

// reviewCard is the MatchReview schema with its accept and reject interactions
type reviewCard struct {
	svc *Service
}

func (c *reviewCard) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.card.match-review", Name: "MatchReview", Version: "1", Kind: extension.KindCardSchema, Origin: "builtin"}
}

func (c *reviewCard) TypeURL() string {
	return extension.TypeURLOf((&cardv1.MatchReview{}).ProtoReflect().Descriptor())
}

func (c *reviewCard) Message() proto.Message { return &cardv1.MatchReview{} }

// Actions offers accept and reject while nobody has decided
func (c *reviewCard) Actions(card proto.Message) []extension.Action {
	r, ok := card.(*cardv1.MatchReview)
	if !ok || r.GetState() != cardv1.MatchState_MATCH_STATE_PENDING {
		return nil
	}
	return []extension.Action{{ID: "accept", Label: "Same title", Style: "success"}, {ID: "reject", Label: "Different", Style: "danger"}}
}

// Interact applies a decision, merging on accept and marking the edge on reject
func (c *reviewCard) Interact(ctx context.Context, in extension.Interaction) (proto.Message, error) {
	r, ok := in.Card.(*cardv1.MatchReview)
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, "not a match review")
	}
	if r.GetState() != cardv1.MatchState_MATCH_STATE_PENDING {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "this review was already decided")
	}
	allowed, err := c.svc.Check(ctx, in.Principal.Subject(), "catalog_edit", capability.SystemObject)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, connect.NewError(connect.CodePermissionDenied, "only catalog editors decide matches")
	}
	var state matchedge.State
	switch in.Action {
	case "accept":
		state = matchedge.StateAccepted
	case "reject":
		state = matchedge.StateRejected
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, "unknown action "+in.Action)
	}
	edge, err := c.svc.Ent.MatchEdge.Get(ctx, r.GetEdgeId())
	if ent.IsNotFound(err) {
		return nil, connect.NewError(connect.CodeNotFound, "this review's edge is gone")
	}
	if err != nil {
		return nil, err
	}
	if state == matchedge.StateAccepted {
		if err := c.svc.acceptEdge(ctx, edge); err != nil {
			return nil, err
		}
	}
	now := time.Now()
	if err := c.svc.Ent.MatchEdge.UpdateOneID(edge.ID).SetState(state).SetDecidedBy(in.Principal.UserID).SetDecidedAt(now).Exec(ctx); err != nil {
		return nil, err
	}
	next := proto.Clone(r).(*cardv1.MatchReview)
	next.DecidedBy = in.Principal.UserID
	next.DecidedByName = principalName(in.Principal)
	next.DecidedAt = timestamppb.New(now)
	if state == matchedge.StateAccepted {
		next.State = cardv1.MatchState_MATCH_STATE_ACCEPTED
	} else {
		next.State = cardv1.MatchState_MATCH_STATE_REJECTED
	}
	return next, nil
}

// acceptEdge makes an accepted review real, merging two entities or attaching the external id
func (s *Service) acceptEdge(ctx context.Context, edge *ent.MatchEdge) error {
	if edge.Namespace == "entity" {
		if err := s.Merge(ctx, edge.EntityID, edge.Value); err != nil && !errors.Is(err, ErrMerged) {
			return err
		}
		return nil
	}
	e, err := s.GetEntity(ctx, edge.EntityID)
	if err != nil {
		return err
	}
	return s.linkXID(ctx, e, edge.Namespace, edge.Value, edge.Source, 1)
}
