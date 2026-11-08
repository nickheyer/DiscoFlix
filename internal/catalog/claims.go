package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/claim"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entityfield"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entitytitle"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/extid"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/matchedge"
)

// Match thresholds, a candidate above accept links on its own and one above review asks a person
const (
	acceptProbability = 0.95
	reviewProbability = 0.5
	maxCandidates     = 12
)

// Group is the claims one source made about one external record
type Group struct {
	Kind      string
	Namespace string
	ID        string
	Source    string
	Claims    []model.Claim
}

// groupClaims splits a source's flat claim list by the record each claim describes, keeping first-seen order
func groupClaims(source string, claims []model.Claim) []Group {
	var out []Group
	index := map[string]int{}
	for _, c := range claims {
		key := c.Kind + "|" + c.Namespace + "|" + c.ExternalID
		i, ok := index[key]
		if !ok {
			i = len(out)
			index[key] = i
			out = append(out, Group{Kind: c.Kind, Namespace: c.Namespace, ID: c.ExternalID, Source: source})
		}
		out[i].Claims = append(out[i].Claims, c)
	}
	return out
}

// record builds the matcher's view of a group from its claims
func (g Group) record() model.Record {
	r := model.Record{Kind: g.Kind, XIDs: map[string]string{g.Namespace: g.ID}}
	for _, c := range g.Claims {
		switch {
		case c.Field == model.FieldTitle || c.Field == model.FieldOriginalTitle:
			if t, ok := c.Value.(string); ok && t != "" {
				r.Titles = append(r.Titles, t)
			}
		case c.Field == model.FieldAliases:
			r.Titles = append(r.Titles, stringList(c.Value)...)
		case c.Field == model.FieldYear:
			r.Year = asInt(c.Value)
		case c.Field == model.FieldRuntime:
			r.Runtime = asInt(c.Value)
		case c.Field == model.FieldLanguage:
			r.Language, _ = c.Value.(string)
		case strings.HasPrefix(c.Field, model.FieldXIDPrefix):
			if v, ok := c.Value.(string); ok && v != "" {
				r.XIDs[strings.TrimPrefix(c.Field, model.FieldXIDPrefix)] = v
			}
		}
	}
	return r
}

func stringList(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func asInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int32:
		return int(t)
	case int64:
		return int(t)
	case float64:
		return int(math.Round(t))
	case float32:
		return int(math.Round(float64(t)))
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}

// title picks the display title of a group, the title claim first then the original title
func (g Group) title() string {
	var original string
	for _, c := range g.Claims {
		if t, ok := c.Value.(string); ok && t != "" {
			switch c.Field {
			case model.FieldTitle:
				return t
			case model.FieldOriginalTitle:
				original = t
			}
		}
	}
	return original
}

func (g Group) year() int {
	for _, c := range g.Claims {
		if c.Field == model.FieldYear {
			return asInt(c.Value)
		}
	}
	return 0
}

// EntityByXID returns the live entity holding an external id, following merges
func (s *Service) EntityByXID(ctx context.Context, namespace, value string) (*ent.Entity, error) {
	x, err := s.Ent.ExtID.Query().Where(extid.Namespace(namespace), extid.Value(value)).WithEntity().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.live(ctx, x.Edges.Entity)
}

// live follows merged_into links to the entity that absorbed the given one
func (s *Service) live(ctx context.Context, e *ent.Entity) (*ent.Entity, error) {
	for hops := 0; e.MergedIntoID != "" && hops < 8; hops++ {
		next, err := s.Ent.Entity.Get(ctx, e.MergedIntoID)
		if err != nil {
			return nil, err
		}
		e = next
	}
	return e, nil
}

// GetEntity loads one live entity by id
func (s *Service) GetEntity(ctx context.Context, id string) (*ent.Entity, error) {
	e, err := s.Ent.Entity.Get(ctx, id)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.live(ctx, e)
}

// Observe writes a group's claims onto the entity it identifies, creating the entity when it is new
func (s *Service) Observe(ctx context.Context, g Group) (*ent.Entity, bool, error) {
	if !model.ValidKind(g.Kind) {
		return nil, false, fmt.Errorf("%w: %s", ErrBadKind, g.Kind)
	}
	e, err := s.EntityByXID(ctx, g.Namespace, g.ID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	created := false
	var review *pendingReview
	if e == nil {
		if e, err = s.entityByAnyXID(ctx, g); err != nil {
			return nil, false, err
		}
	}
	if e == nil {
		matched, pending, err := s.matchExisting(ctx, g)
		if err != nil {
			return nil, false, err
		}
		e, review = matched, pending
	}
	if e == nil {
		if e, err = s.Ent.Entity.Create().SetKind(g.Kind).SetTitle(g.title()).SetYear(int32(g.year())).Save(ctx); err != nil {
			return nil, false, err
		}
		created = true
	} else if e.Kind != g.Kind {
		return nil, false, fmt.Errorf("catalog: %s %s:%s is a %s, the source calls it a %s", e.ID, g.Namespace, g.ID, e.Kind, g.Kind)
	}
	if err := s.linkXID(ctx, e, g.Namespace, g.ID, g.Source, 1); err != nil {
		return nil, false, err
	}
	if err := s.writeClaims(ctx, e, g); err != nil {
		return nil, false, err
	}
	if err := s.Resolve(ctx, e.ID); err != nil {
		return nil, false, err
	}
	if review != nil {
		if err := s.openReview(ctx, e, review); err != nil {
			return nil, false, err
		}
	}
	return e, created, nil
}

// entityByAnyXID finds an entity through any other external id the group carries
func (s *Service) entityByAnyXID(ctx context.Context, g Group) (*ent.Entity, error) {
	for _, c := range g.Claims {
		if !strings.HasPrefix(c.Field, model.FieldXIDPrefix) {
			continue
		}
		v, ok := c.Value.(string)
		if !ok || v == "" {
			continue
		}
		e, err := s.EntityByXID(ctx, strings.TrimPrefix(c.Field, model.FieldXIDPrefix), v)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if e.Kind == g.Kind {
			return e, nil
		}
	}
	return nil, nil
}

// pendingReview describes a probable but unproven link the matcher wants a person to decide
type pendingReview struct {
	candidate   *ent.Entity
	probability float64
	features    map[string]float64
	group       Group
}

// matchExisting scores the group against entities with a similar title, linking confident ones and flagging doubtful ones
func (s *Service) matchExisting(ctx context.Context, g Group) (*ent.Entity, *pendingReview, error) {
	rec := g.record()
	if len(rec.Titles) == 0 {
		return nil, nil, nil
	}
	cands, err := s.candidatesByTitle(ctx, g.Kind, rec.Titles, maxCandidates)
	if err != nil {
		return nil, nil, err
	}
	var best *ent.Entity
	bestP := 0.0
	var bestF map[string]float64
	for _, c := range cands {
		other, err := s.recordOf(ctx, c)
		if err != nil {
			return nil, nil, err
		}
		p, f := s.Scorer.Score(g.Kind, rec, other)
		if p > bestP {
			best, bestP, bestF = c, p, f
		}
	}
	if best == nil {
		return nil, nil, nil
	}
	if bestP >= acceptProbability {
		if err := s.recordEdge(ctx, best, g, bestP, bestF, matchedge.StateAuto); err != nil {
			return nil, nil, err
		}
		return best, nil, nil
	}
	if bestP >= reviewProbability {
		return nil, &pendingReview{candidate: best, probability: bestP, features: bestF, group: g}, nil
	}
	return nil, nil, nil
}

// candidatesByTitle finds entities of a kind whose titles match any given title exactly or by trigram
func (s *Service) candidatesByTitle(ctx context.Context, kind string, titles []string, limit int) ([]*ent.Entity, error) {
	seen := map[string]bool{}
	var out []*ent.Entity
	add := func(ids []string) error {
		for _, id := range ids {
			if seen[id] || len(out) >= limit {
				continue
			}
			seen[id] = true
			e, err := s.Ent.Entity.Get(ctx, id)
			if err != nil {
				return err
			}
			if e.MergedIntoID == "" && e.Kind == kind {
				out = append(out, e)
			}
		}
		return nil
	}
	var normalized []string
	for _, t := range titles {
		if n := model.Normalize(t); n != "" {
			normalized = append(normalized, n)
		}
	}
	if len(normalized) == 0 {
		return nil, nil
	}
	rows, err := s.Ent.EntityTitle.Query().Where(entitytitle.NormalizedIn(normalized...)).Limit(limit * 4).All(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.EntityID)
	}
	if err := add(ids); err != nil {
		return nil, err
	}
	if len(out) >= limit {
		return out, nil
	}
	fuzzy, err := s.ftsEntityIDs(ctx, normalized[0], limit*2)
	if err != nil {
		return nil, err
	}
	return out, add(fuzzy)
}

// ftsEntityIDs runs the trigram index over entity titles for a normalized query
func (s *Service) ftsEntityIDs(ctx context.Context, normalized string, limit int) ([]string, error) {
	if len([]rune(normalized)) < 3 {
		return nil, nil
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT t.entity_id FROM entity_title_fts f JOIN entity_titles t ON t.id = f.rowid WHERE entity_title_fts MATCH ? ORDER BY bm25(entity_title_fts) LIMIT ?`, ftsQuery(normalized), limit)
	if err != nil {
		return nil, fmt.Errorf("catalog: title search: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	seen := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// ftsQuery quotes a normalized title as one FTS5 string token so trigram matching sees the phrase
func ftsQuery(normalized string) string {
	return `"` + strings.ReplaceAll(normalized, `"`, `""`) + `"`
}

// recordOf builds the matcher's view of a stored entity from its titles, fields, and ids
func (s *Service) recordOf(ctx context.Context, e *ent.Entity) (model.Record, error) {
	r := model.Record{Kind: e.Kind, Year: int(e.Year), XIDs: map[string]string{}}
	titles, err := s.Ent.EntityTitle.Query().Where(entitytitle.EntityID(e.ID)).All(ctx)
	if err != nil {
		return r, err
	}
	for _, t := range titles {
		r.Titles = append(r.Titles, t.Title)
	}
	if len(r.Titles) == 0 && e.Title != "" {
		r.Titles = append(r.Titles, e.Title)
	}
	fields, err := s.Ent.EntityField.Query().Where(entityfield.EntityID(e.ID), entityfield.FieldIn(model.FieldRuntime, model.FieldLanguage)).All(ctx)
	if err != nil {
		return r, err
	}
	for _, f := range fields {
		var v any
		if json.Unmarshal(f.Value, &v) != nil {
			continue
		}
		switch f.Field {
		case model.FieldRuntime:
			r.Runtime = asInt(v)
		case model.FieldLanguage:
			r.Language, _ = v.(string)
		}
	}
	xids, err := s.Ent.ExtID.Query().Where(extid.EntityID(e.ID)).All(ctx)
	if err != nil {
		return r, err
	}
	for _, x := range xids {
		r.XIDs[x.Namespace] = x.Value
	}
	return r, nil
}

// recordEdge stores how a candidate was linked, for the review queue and matcher retraining
func (s *Service) recordEdge(ctx context.Context, e *ent.Entity, g Group, p float64, features map[string]float64, state matchedge.State) (err error) {
	_, err = s.Ent.MatchEdge.Create().
		SetEntityID(e.ID).SetNamespace(g.Namespace).SetValue(g.ID).SetSource(g.Source).
		SetCandidateTitle(g.title()).SetCandidateYear(int32(g.year())).
		SetProbability(p).SetFeatures(features).SetTier(1).SetState(state).Save(ctx)
	return err
}

// linkXID attaches an external id to an entity, opening a review when another entity already holds it
func (s *Service) linkXID(ctx context.Context, e *ent.Entity, namespace, value, source string, p float64) error {
	existing, err := s.Ent.ExtID.Query().Where(extid.Namespace(namespace), extid.Value(value)).Only(ctx)
	switch {
	case ent.IsNotFound(err):
		_, err = s.Ent.ExtID.Create().SetEntityID(e.ID).SetNamespace(namespace).SetValue(value).SetSource(source).SetPMatch(p).Save(ctx)
		return err
	case err != nil:
		return err
	case existing.EntityID == e.ID:
		if p > existing.PMatch {
			return s.Ent.ExtID.UpdateOneID(existing.ID).SetPMatch(p).Exec(ctx)
		}
		return nil
	}
	holder, err := s.GetEntity(ctx, existing.EntityID)
	if err != nil {
		return err
	}
	if holder.ID == e.ID {
		return s.Ent.ExtID.UpdateOneID(existing.ID).SetEntityID(e.ID).Exec(ctx)
	}
	return s.conflict(ctx, e, holder, namespace, value, source)
}

// conflict opens a review between two entities that both claim one external id
func (s *Service) conflict(ctx context.Context, a, b *ent.Entity, namespace, value, source string) error {
	open, err := s.Ent.MatchEdge.Query().Where(matchedge.EntityID(a.ID), matchedge.Namespace("entity"), matchedge.Value(b.ID), matchedge.StateEQ(matchedge.StateReview)).Exist(ctx)
	if err != nil || open {
		return err
	}
	ra, err := s.recordOf(ctx, a)
	if err != nil {
		return err
	}
	rb, err := s.recordOf(ctx, b)
	if err != nil {
		return err
	}
	p, features := s.Scorer.Score(a.Kind, ra, rb)
	edge, err := s.Ent.MatchEdge.Create().
		SetEntityID(a.ID).SetNamespace("entity").SetValue(b.ID).SetSource(source).
		SetCandidateTitle(b.Title).SetCandidateYear(b.Year).
		SetProbability(p).SetFeatures(features).SetTier(0).SetState(matchedge.StateReview).Save(ctx)
	if err != nil {
		return err
	}
	return s.postReview(ctx, edge, a, b.Title, int(b.Year), fmt.Sprintf("%s:%s belongs to both", namespace, value))
}

// writeClaims upserts every claim of a group and applies the structural ones, ids, parents, ordinals, and artwork
func (s *Service) writeClaims(ctx context.Context, e *ent.Entity, g Group) error {
	now := time.Now()
	for _, c := range g.Claims {
		if c.Value == nil {
			continue
		}
		switch {
		case strings.HasPrefix(c.Field, model.FieldXIDPrefix):
			if v, ok := c.Value.(string); ok && v != "" {
				if err := s.linkXID(ctx, e, strings.TrimPrefix(c.Field, model.FieldXIDPrefix), v, g.Source, float64(confidenceOf(c))); err != nil {
					return err
				}
			}
			continue
		case strings.HasPrefix(c.Field, model.FieldParentPrefix):
			if err := s.attachParent(ctx, e, strings.TrimPrefix(c.Field, model.FieldParentPrefix), c, g.Source); err != nil {
				return err
			}
			continue
		case c.Field == model.FieldOrdinal:
			if n := asInt(c.Value); n != int(e.Ordinal) {
				if err := s.Ent.Entity.UpdateOneID(e.ID).SetOrdinal(int32(n)).Exec(ctx); err != nil {
					return err
				}
				e.Ordinal = int32(n)
			}
			continue
		case strings.HasPrefix(c.Field, model.FieldArtworkPrefix):
			if err := s.queueArtwork(ctx, e, strings.TrimPrefix(c.Field, model.FieldArtworkPrefix), c.Value, g.Source); err != nil {
				return err
			}
			continue
		}
		if err := s.upsertClaim(ctx, e.ID, c.Field, c.Value, g.Source, c.RecordID, "", confidenceOf(c), false, now); err != nil {
			return err
		}
	}
	return nil
}

func confidenceOf(c model.Claim) float32 {
	if c.Confidence <= 0 || c.Confidence > 1 {
		return 1
	}
	return c.Confidence
}

// upsertClaim records a claim once per entity, field, source, and value, advancing observed_at on repeats
func (s *Service) upsertClaim(ctx context.Context, entityID, field string, value any, source, recordID, userID string, confidence float32, pinned bool, at time.Time) error {
	if field == "" || len(field) > 64 {
		return fmt.Errorf("%w: %q", ErrBadField, field)
	}
	canon, err := canonical(value)
	if err != nil {
		return fmt.Errorf("catalog: encode %s: %w", field, err)
	}
	return s.Ent.Claim.Create().
		SetEntityID(entityID).SetField(field).SetValue(canon).SetValueHash(valueHash(canon)).
		SetSource(source).SetRecordID(recordID).SetUserID(userID).SetConfidence(confidence).
		SetRank(rankOf(field, source)).SetPinned(pinned).SetObservedAt(at).
		OnConflictColumns(claim.FieldEntityID, claim.FieldField, claim.FieldSource, claim.FieldValueHash).
		UpdateObservedAt().UpdateRecordID().UpdateConfidence().UpdateRank().UpdatePinned().UpdateUserID().
		Exec(ctx)
}

// attachParent links a season to its series or an episode to its season, creating a shell parent when unknown
func (s *Service) attachParent(ctx context.Context, e *ent.Entity, namespace string, c model.Claim, source string) error {
	v, ok := c.Value.(string)
	if !ok || v == "" {
		return nil
	}
	parentKind := ""
	switch e.Kind {
	case model.KindSeason:
		parentKind = model.KindSeries
	case model.KindEpisode:
		parentKind = model.KindSeason
	default:
		return nil
	}
	parent, err := s.EntityByXID(ctx, namespace, v)
	if errors.Is(err, ErrNotFound) {
		if parent, err = s.Ent.Entity.Create().SetKind(parentKind).Save(ctx); err != nil {
			return err
		}
		if err := s.linkXID(ctx, parent, namespace, v, source, 1); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if parent.Kind != parentKind || parent.ID == e.ID {
		return fmt.Errorf("catalog: %s %s cannot be the parent of %s %s", parent.Kind, parent.ID, e.Kind, e.ID)
	}
	if e.ParentID == parent.ID {
		return nil
	}
	if err := s.Ent.Entity.UpdateOneID(e.ID).SetParentID(parent.ID).Exec(ctx); err != nil {
		return err
	}
	e.ParentID = parent.ID
	return nil
}

// queueArtwork stores a pending artwork row for an image a source offered, keeping a known score over a zero
func (s *Service) queueArtwork(ctx context.Context, e *ent.Entity, kind string, value any, source string) error {
	var k artwork.Kind
	switch kind {
	case "poster", "backdrop", "logo", "still", "banner", "thumb":
		k = artwork.Kind(kind)
	default:
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var images []model.Image
	if err := json.Unmarshal(raw, &images); err != nil {
		var one model.Image
		if err := json.Unmarshal(raw, &one); err != nil {
			return fmt.Errorf("catalog: artwork claim on %s is not an image list: %w", e.ID, err)
		}
		images = []model.Image{one}
	}
	for _, img := range images {
		if img.URL == "" {
			continue
		}
		upsert := s.Ent.Artwork.Create().
			SetEntityID(e.ID).SetKind(k).SetSource(source).SetSourceURL(img.URL).
			SetWidth(int32(img.Width)).SetHeight(int32(img.Height)).SetLanguage(img.Language).SetScore(img.Score).
			OnConflictColumns(artwork.FieldEntityID, artwork.FieldSourceURL).UpdateLanguage()
		if img.Score > 0 {
			upsert.UpdateScore()
		}
		if err := upsert.Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Resolve recomputes every field of an entity from its claims and refreshes its titles
func (s *Service) Resolve(ctx context.Context, entityID string) error {
	e, err := s.Ent.Entity.Get(ctx, entityID)
	if err != nil {
		return err
	}
	claims, err := s.Ent.Claim.Query().Where(claim.EntityID(entityID)).All(ctx)
	if err != nil {
		return err
	}
	byField := map[string][]*ent.Claim{}
	for _, c := range claims {
		byField[c.Field] = append(byField[c.Field], c)
	}
	fields := make([]string, 0, len(byField))
	for f := range byField {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	tx, err := s.Ent.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.EntityField.Delete().Where(entityfield.EntityID(entityID), entityfield.FieldNotIn(fields...)).Exec(ctx); err != nil {
		return err
	}
	title, original, year := "", "", int32(0)
	titles := map[string]entitytitle.Kind{}
	for _, f := range fields {
		d, ok := decide(byField[f])
		if !ok {
			continue
		}
		if err := tx.EntityField.Create().
			SetEntityID(entityID).SetField(f).SetValue(d.claim.Value).SetClaimID(d.claim.ID).SetSource(d.claim.Source).
			SetReason(d.reason).SetAgreement(d.agreement).SetClaims(d.total).SetConfidence(d.claim.Confidence).SetObservedAt(d.claim.ObservedAt).
			OnConflictColumns(entityfield.FieldEntityID, entityfield.FieldField).
			UpdateValue().UpdateClaimID().UpdateSource().UpdateReason().UpdateAgreement().UpdateClaims().UpdateConfidence().UpdateObservedAt().UpdateResolvedAt().
			Exec(ctx); err != nil {
			return err
		}
		var v any
		_ = json.Unmarshal(d.claim.Value, &v)
		switch f {
		case model.FieldTitle:
			title, _ = v.(string)
		case model.FieldOriginalTitle:
			original, _ = v.(string)
		case model.FieldYear:
			year = int32(asInt(v))
		case model.FieldAliases:
			for _, a := range stringList(v) {
				titles[a] = entitytitle.KindAlias
			}
		}
	}
	for _, c := range claims {
		if c.Field == model.FieldTitle || c.Field == model.FieldOriginalTitle {
			var v string
			if json.Unmarshal(c.Value, &v) == nil && v != "" {
				titles[v] = entitytitle.KindAlias
			}
		}
	}
	if original != "" {
		titles[original] = entitytitle.KindOriginal
	}
	if title == "" {
		title = original
	}
	if title != "" {
		titles[title] = entitytitle.KindPrimary
	}
	if _, err := tx.EntityTitle.Delete().Where(entitytitle.EntityID(entityID)).Exec(ctx); err != nil {
		return err
	}
	seen := map[string]bool{}
	for t, kind := range titles {
		n := model.Normalize(t)
		if n == "" || seen[n+"|"] {
			continue
		}
		seen[n+"|"] = true
		if err := tx.EntityTitle.Create().SetEntityID(entityID).SetTitle(t).SetNormalized(n).SetKind(kind).Exec(ctx); err != nil {
			return err
		}
	}
	update := tx.Entity.UpdateOneID(entityID).SetResolvedAt(time.Now())
	if title != "" {
		update.SetTitle(title)
	}
	if year != 0 {
		update.SetYear(year)
	}
	if err := update.Exec(ctx); err != nil {
		return err
	}
	_ = e
	return tx.Commit()
}

// Pin fixes a field to a value as a user claim that outranks every source
func (s *Service) Pin(ctx context.Context, entityID, field string, value any, userID string) error {
	if _, err := s.GetEntity(ctx, entityID); err != nil {
		return err
	}
	if _, err := s.Ent.Claim.Delete().Where(claim.EntityID(entityID), claim.Field(field), claim.Source(SourceUser)).Exec(ctx); err != nil {
		return err
	}
	if err := s.upsertClaim(ctx, entityID, field, value, SourceUser, "", userID, 1, true, time.Now()); err != nil {
		return err
	}
	return s.Resolve(ctx, entityID)
}

// Unpin removes the user claim on a field so sources decide it again
func (s *Service) Unpin(ctx context.Context, entityID, field string) error {
	if _, err := s.GetEntity(ctx, entityID); err != nil {
		return err
	}
	if _, err := s.Ent.Claim.Delete().Where(claim.EntityID(entityID), claim.Field(field), claim.Source(SourceUser)).Exec(ctx); err != nil {
		return err
	}
	return s.Resolve(ctx, entityID)
}

// Merge moves everything from one entity onto another and leaves a forwarding link behind
func (s *Service) Merge(ctx context.Context, fromID, intoID string) error {
	if fromID == intoID {
		return nil
	}
	from, err := s.Ent.Entity.Get(ctx, fromID)
	if err != nil {
		return err
	}
	into, err := s.GetEntity(ctx, intoID)
	if err != nil {
		return err
	}
	if from.MergedIntoID != "" {
		return ErrMerged
	}
	if from.Kind != into.Kind {
		return fmt.Errorf("catalog: cannot merge %s into %s", from.Kind, into.Kind)
	}
	tx, err := s.Ent.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.ExtID.Update().Where(extid.EntityID(from.ID)).SetEntityID(into.ID).Exec(ctx); err != nil {
		return err
	}
	claims, err := tx.Claim.Query().Where(claim.EntityID(from.ID)).All(ctx)
	if err != nil {
		return err
	}
	for _, c := range claims {
		if err := tx.Claim.Create().
			SetEntityID(into.ID).SetField(c.Field).SetValue(c.Value).SetValueHash(c.ValueHash).SetSource(c.Source).
			SetRecordID(c.RecordID).SetUserID(c.UserID).SetConfidence(c.Confidence).SetRank(c.Rank).SetPinned(c.Pinned).SetObservedAt(c.ObservedAt).
			OnConflictColumns(claim.FieldEntityID, claim.FieldField, claim.FieldSource, claim.FieldValueHash).Ignore().Exec(ctx); err != nil {
			return err
		}
	}
	if _, err := tx.Claim.Delete().Where(claim.EntityID(from.ID)).Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.EntityField.Delete().Where(entityfield.EntityID(from.ID)).Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.EntityTitle.Delete().Where(entitytitle.EntityID(from.ID)).Exec(ctx); err != nil {
		return err
	}
	arts, err := tx.Artwork.Query().Where(artwork.EntityID(from.ID)).All(ctx)
	if err != nil {
		return err
	}
	for _, a := range arts {
		dup, err := tx.Artwork.Query().Where(artwork.EntityID(into.ID), artwork.SourceURL(a.SourceURL)).Exist(ctx)
		if err != nil {
			return err
		}
		if dup {
			if err := tx.Artwork.DeleteOneID(a.ID).Exec(ctx); err != nil {
				return err
			}
			continue
		}
		if err := tx.Artwork.UpdateOneID(a.ID).SetEntityID(into.ID).Exec(ctx); err != nil {
			return err
		}
	}
	if err := tx.Entity.Update().Where(entity.ParentID(from.ID)).SetParentID(into.ID).Exec(ctx); err != nil {
		return err
	}
	if err := tx.MatchEdge.Update().Where(matchedge.EntityID(from.ID)).SetEntityID(into.ID).Exec(ctx); err != nil {
		return err
	}
	if err := tx.Entity.UpdateOneID(from.ID).SetMergedIntoID(into.ID).Exec(ctx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.Resolve(ctx, into.ID)
}

// Fields loads the resolved fields of an entity keyed by name
func (s *Service) Fields(ctx context.Context, entityID string) ([]*ent.EntityField, error) {
	return s.Ent.EntityField.Query().Where(entityfield.EntityID(entityID)).Order(ent.Asc(entityfield.FieldField)).All(ctx)
}
