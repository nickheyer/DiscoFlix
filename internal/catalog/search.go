package catalog

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entitytitle"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/extid"
)

// States a source can end a request in
const (
	StateAnswered     = "answered"
	StateEmpty        = "empty"
	StateDisabled     = "disabled"
	StateUnconfigured = "unconfigured"
	StateUnreachable  = "unreachable"
	StateBudget       = "budget"
	StateOpen         = "open"
	StateSkipped      = "skipped"
	StateMissing      = "missing"
)

// Outcome reports how one source fared during a request
type Outcome struct {
	Source   string
	State    string
	Detail   string
	Results  int
	Duration time.Duration
	Artwork  bool
}

// Hit is one ranked search result
type Hit struct {
	Entity      *ent.Entity
	Score       float64
	TitleSim    float64
	IDs         int
	Explanation string
	MatchedOn   []string
	Local       bool
	Sources     []string
}

// Each external id lifts a hit by idBonus up to idBonusCap ids, so stubs lose ties to well-referenced titles
const (
	idBonus    = 0.02
	idBonusCap = 8

	localTimeout = 8 * time.Second
	liveTimeout  = 10 * time.Second
	observeCap   = 10
	defaultLimit = 10
)

// outcomeFor classifies a source error
func outcomeFor(name string, err error, results int, d time.Duration) Outcome {
	o := Outcome{Source: name, Results: results, Duration: d}
	switch {
	case errors.Is(err, ErrUnsupported):
		o.State, o.Detail = StateSkipped, "this source has no search"
	case errors.Is(err, ErrNoData):
		o.State, o.Detail = StateMissing, err.Error()
	case err == nil && results == 0:
		o.State = StateEmpty
	case err == nil:
		o.State = StateAnswered
	case errors.Is(err, outbound.ErrBudget):
		o.State, o.Detail = StateBudget, err.Error()
	case errors.Is(err, outbound.ErrOpen):
		o.State, o.Detail = StateOpen, err.Error()
	default:
		o.State, o.Detail = StateUnreachable, err.Error()
	}
	return o
}

// sourceResult is what one source returned for a query
type sourceResult struct {
	name    string
	local   bool
	groups  []Group
	outcome Outcome
}

// fanOut asks every enabled source concurrently and returns their grouped claims
func (s *Service) fanOut(ctx context.Context, kind, query string, year int, localOnly bool) ([]sourceResult, []Outcome) {
	sources := s.enabledSources(localOnly)
	results := make([]sourceResult, len(sources))
	var wg sync.WaitGroup
	for i, src := range sources {
		wg.Add(1)
		go func(i int, e *sourceEntry) {
			defer wg.Done()
			timeout := liveTimeout
			if e.local {
				timeout = localTimeout
			}
			cctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			start := time.Now()
			claims, err := e.Search(cctx, kind, query, year)
			groups := groupClaims(e.Name(), claims)
			outcome := outcomeFor(e.Name(), err, len(groups), time.Since(start))
			outcome.Artwork = e.Artwork()
			results[i] = sourceResult{name: e.Name(), local: e.local, groups: groups, outcome: outcome}
		}(i, src)
	}
	wg.Wait()
	outcomes := s.skippedOutcomes(localOnly)
	for _, r := range results {
		outcomes = append(outcomes, r.outcome)
	}
	sort.Slice(outcomes, func(i, j int) bool { return outcomes[i].Source < outcomes[j].Source })
	return results, outcomes
}

// Search fans a title out to every enabled source, folds the answers into the graph, and ranks the entities
func (s *Service) Search(ctx context.Context, query, kind string, year, limit int, localOnly bool) ([]Hit, []Outcome, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, nil
	}
	if kind != "" && !model.ValidKind(kind) {
		return nil, nil, fmt.Errorf("%w: %s", ErrBadKind, kind)
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	results, outcomes := s.fanOut(ctx, kind, query, year, localOnly)
	type agg struct {
		entity  *ent.Entity
		sources map[string]bool
		local   bool
	}
	byID := map[string]*agg{}
	var order []string
	for _, r := range results {
		for i, g := range r.groups {
			if i >= observeCap {
				break
			}
			if kind != "" && g.Kind != kind {
				continue
			}
			e, _, err := s.Observe(ctx, g)
			if err != nil {
				s.Log.Warn("observe search result", "source", r.name, "namespace", g.Namespace, "id", g.ID, "error", err)
				continue
			}
			a, ok := byID[e.ID]
			if !ok {
				a = &agg{entity: e, sources: map[string]bool{}}
				byID[e.ID] = a
				order = append(order, e.ID)
			}
			a.sources[r.name] = true
			a.local = a.local || r.local
		}
	}
	local, err := s.localEntities(ctx, query, kind, limit*2)
	if err != nil {
		return nil, outcomes, err
	}
	for _, e := range local {
		if _, ok := byID[e.ID]; !ok {
			byID[e.ID] = &agg{entity: e, sources: map[string]bool{}, local: true}
			order = append(order, e.ID)
		} else {
			byID[e.ID].local = true
		}
	}
	hits := make([]Hit, 0, len(order))
	for _, id := range order {
		a := byID[id]
		e, err := s.Ent.Entity.Get(ctx, id)
		if err != nil {
			return nil, outcomes, err
		}
		h, err := s.scoreHit(ctx, e, query, year)
		if err != nil {
			return nil, outcomes, err
		}
		h.Local = a.local
		for name := range a.sources {
			h.Sources = append(h.Sources, name)
		}
		sort.Strings(h.Sources)
		if extra := float64(len(h.Sources)-1) * 0.03; extra > 0 {
			h.Score += math.Min(extra, 0.12)
			h.MatchedOn = append(h.MatchedOn, "sources")
		}
		hits = append(hits, h)
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Entity.Year > hits[j].Entity.Year
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	for i := range hits {
		hits[i].Explanation = s.explain(hits[i], year)
	}
	return hits, outcomes, nil
}

// localEntities finds entities already in the graph whose titles match the query
func (s *Service) localEntities(ctx context.Context, query, kind string, limit int) ([]*ent.Entity, error) {
	n := model.Normalize(query)
	if n == "" {
		return nil, nil
	}
	seen := map[string]bool{}
	var out []*ent.Entity
	add := func(id string) error {
		if seen[id] {
			return nil
		}
		seen[id] = true
		e, err := s.Ent.Entity.Get(ctx, id)
		if err != nil {
			return err
		}
		if e.MergedIntoID != "" || (kind != "" && e.Kind != kind) {
			return nil
		}
		out = append(out, e)
		return nil
	}
	exact, err := s.Ent.EntityTitle.Query().Where(entitytitle.Normalized(n)).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, t := range exact {
		if err := add(t.EntityID); err != nil {
			return nil, err
		}
	}
	fuzzy, err := s.ftsEntityIDs(ctx, n, limit)
	if err != nil {
		return nil, err
	}
	for _, id := range fuzzy {
		if err := add(id); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// scoreHit rates how well an entity answers the query from its titles, year, and how many external ids reference it
func (s *Service) scoreHit(ctx context.Context, e *ent.Entity, query string, year int) (Hit, error) {
	h := Hit{Entity: e}
	q := model.Normalize(query)
	titles, err := s.Ent.EntityTitle.Query().Where(entitytitle.EntityID(e.ID)).All(ctx)
	if err != nil {
		return h, err
	}
	best := 0.0
	for _, t := range titles {
		if sim := titleSimilarity(q, t.Normalized); sim > best {
			best = sim
		}
	}
	if len(titles) == 0 {
		best = titleSimilarity(q, model.Normalize(e.Title))
	}
	h.TitleSim = best
	h.Score = best
	if best >= 0.999 {
		h.MatchedOn = append(h.MatchedOn, "title")
	}
	if h.IDs, err = s.Ent.ExtID.Query().Where(extid.EntityID(e.ID)).Count(ctx); err != nil {
		return h, err
	}
	h.Score += idBonus * float64(min(h.IDs, idBonusCap))
	switch {
	case year > 0 && e.Year > 0 && int(e.Year) == year:
		h.Score += 0.25
		h.MatchedOn = append(h.MatchedOn, "year")
	case year > 0 && e.Year > 0 && absInt(int(e.Year)-year) == 1:
		h.Score += 0.1
	case year > 0 && e.Year > 0:
		h.Score -= 0.3
	case year > 0:
		h.Score -= 0.05
	}
	return h, nil
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// explain writes the reasons behind a hit's score in plain words
func (s *Service) explain(h Hit, year int) string {
	var parts []string
	switch {
	case h.TitleSim >= 0.999:
		parts = append(parts, "title matches exactly")
	case h.TitleSim >= 0.8:
		parts = append(parts, fmt.Sprintf("title is close (%.2f)", h.TitleSim))
	default:
		parts = append(parts, fmt.Sprintf("title is a loose match (%.2f)", h.TitleSim))
	}
	switch {
	case year > 0 && h.Entity.Year > 0 && int(h.Entity.Year) == year:
		parts = append(parts, "year matches")
	case year > 0 && h.Entity.Year > 0:
		parts = append(parts, fmt.Sprintf("year differs by %d", absInt(int(h.Entity.Year)-year)))
	case year > 0:
		parts = append(parts, "year unknown")
	}
	switch h.IDs {
	case 0:
		parts = append(parts, "no external ids")
	case 1:
		parts = append(parts, "1 external id")
	default:
		parts = append(parts, fmt.Sprintf("%d external ids", h.IDs))
	}
	switch len(h.Sources) {
	case 0:
		parts = append(parts, "known from the local graph")
	case 1:
		parts = append(parts, "reported by "+h.Sources[0])
	default:
		parts = append(parts, fmt.Sprintf("%d sources agree (%s)", len(h.Sources), strings.Join(h.Sources, ", ")))
	}
	return strings.Join(parts, ", ")
}

// Resolution is the single entity a title resolved to with how sure the catalog is
type Resolution struct {
	Hit          Hit
	Confidence   float64
	Explanation  string
	Alternatives []Hit
	Outcomes     []Outcome
}

// ResolveTitle picks the one entity a typed title means, with a calibrated confidence and the runners-up
func (s *Service) ResolveTitle(ctx context.Context, title, kind string, year int, localOnly bool) (*Resolution, error) {
	hits, outcomes, err := s.Search(ctx, title, kind, year, 8, localOnly)
	if err != nil {
		return nil, err
	}
	if len(hits) == 0 {
		return &Resolution{Outcomes: outcomes}, ErrNoMatch
	}
	top := hits[0]
	conf := math.Min(1, top.TitleSim)
	switch {
	case year > 0 && top.Entity.Year > 0 && int(top.Entity.Year) == year:
	case year > 0 && top.Entity.Year > 0:
		conf *= 0.6
	case year > 0:
		conf *= 0.9
	}
	gap := "no alternative came close"
	if len(hits) > 1 {
		g := top.Score - hits[1].Score
		conf *= 0.5 + 0.5*math.Min(1, g/0.15)
		gap = fmt.Sprintf("closest alternative scored %.2f against %.2f", hits[1].Score, top.Score)
	}
	return &Resolution{Hit: top, Confidence: conf, Explanation: top.Explanation + ", " + gap, Alternatives: hits[1:], Outcomes: outcomes}, nil
}

// LookupExternal resolves one external id through the graph, the snapshot, and then live sources, accepting answers keyed by another namespace
func (s *Service) LookupExternal(ctx context.Context, namespace, value, kind string) (*ent.Entity, bool, []Outcome, error) {
	if e, err := s.EntityByXID(ctx, namespace, value); err == nil {
		return e, false, nil, nil
	} else if !errors.Is(err, ErrNotFound) {
		return nil, false, nil, err
	}
	var outcomes []Outcome
	var found *ent.Entity
	created := false
	for _, pass := range []bool{true, false} {
		for _, e := range s.enabledSources(pass) {
			if pass != e.local || !slices.Contains(e.Namespaces(), namespace) {
				continue
			}
			kinds := e.Kinds()
			if kind != "" {
				kinds = []string{kind}
			}
			for _, k := range kinds {
				start := time.Now()
				cctx, cancel := context.WithTimeout(ctx, liveTimeout)
				claims, err := e.Lookup(cctx, k, namespace, value)
				cancel()
				groups := groupClaims(e.Name(), claims)
				outcome := outcomeFor(e.Name(), err, len(groups), time.Since(start))
				outcome.Artwork = e.Artwork()
				outcomes = append(outcomes, outcome)
				fresh := map[string]bool{}
				for _, g := range groups {
					ent, c, err := s.Observe(ctx, g)
					if err != nil {
						return nil, false, outcomes, err
					}
					fresh[ent.ID] = fresh[ent.ID] || c
				}
				if len(groups) == 0 {
					continue
				}
				linked, err := s.EntityByXID(ctx, namespace, value)
				if err != nil && !errors.Is(err, ErrNotFound) {
					return nil, false, outcomes, err
				}
				if linked != nil {
					found, created = linked, fresh[linked.ID]
					break
				}
			}
			if found != nil {
				break
			}
		}
		if found != nil {
			break
		}
	}
	if found == nil {
		return nil, false, outcomes, ErrNotFound
	}
	return found, created, outcomes, nil
}
