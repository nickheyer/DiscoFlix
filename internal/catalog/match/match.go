// Fellegi-Sunter record linkage for catalog entities with EM-learned weights and transitive id propagation
package match

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Prior match probability, the clamp on learned scores, and the cap a conflicting id imposes
const (
	priorLambda    = 0.02
	minProbability = 0.0001
	maxProbability = 0.9999
	conflictCap    = 0.05
)

// Scores record pairs with per kind weights and relearns them, safe for concurrent use
type Model struct {
	mu    sync.RWMutex
	prior *params
	kinds map[string]*params
}

// One kind's m and u per level and prior match probability, never mutated once built
type params struct {
	lambda float64
	m, u   [nFeatures][]float64
	weight [nFeatures][]float64
	odds   float64
}

// Builds a model where every kind scores with the shipped priors until trained or loaded
func New() *Model {
	return &Model{prior: priorParams(), kinds: map[string]*params{}}
}

// Collects the schema's prior m and u per level with the prior match probability
func priorParams() *params {
	var m, u [nFeatures][]float64
	for f, feat := range schema {
		m[f] = make([]float64, len(feat.levels))
		u[f] = make([]float64, len(feat.levels))
		for i, l := range feat.levels {
			m[f][i], u[f][i] = l.m, l.u
		}
	}
	return newParams(priorLambda, m, u)
}

// Derives log2 agreement weights and prior log odds from m, u, and lambda
func newParams(lambda float64, m, u [nFeatures][]float64) *params {
	p := &params{lambda: lambda, m: m, u: u, odds: math.Log2(lambda / (1 - lambda))}
	for f := range m {
		p.weight[f] = make([]float64, len(m[f]))
		for i := range m[f] {
			p.weight[f][i] = math.Log2(m[f][i] / u[f][i])
		}
	}
	return p
}

// Returns the trained parameters of a kind, the shipped priors when it has none
func (md *Model) weightsFor(kind string) *params {
	md.mu.RLock()
	defer md.mu.RUnlock()
	if p, ok := md.kinds[kind]; ok {
		return p
	}
	return md.prior
}

// Replaces the parameters of one kind under the write lock
func (md *Model) store(kind string, p *params) {
	md.mu.Lock()
	defer md.mu.Unlock()
	md.kinds[kind] = p
}

// Returns the match probability of two records and the comparison vector it came from
func (md *Model) Score(kind string, a, b model.Record) (float64, map[string]float64) {
	idx := compare(kind, a, b)
	return md.weightsFor(kind).probability(idx), featureMap(idx)
}

// One for a shared external id, otherwise the posterior capped when an id conflicts
func (p *params) probability(idx [nFeatures]int) float64 {
	switch schema[featXID].levels[idx[featXID]].value {
	case XIDShared:
		return 1
	case XIDConflict:
		return min(p.posterior(idx), conflictCap)
	}
	return p.posterior(idx)
}

// Sums the observed level weights with the prior log odds through a clamped logistic
func (p *params) posterior(idx [nFeatures]int) float64 {
	w := p.odds
	for f, i := range idx {
		w += p.weight[f][i]
	}
	return min(max(1/(1+math.Exp2(-w)), minProbability), maxProbability)
}

// Renders a comparison vector as one plain clause per feature joined by commas
func (md *Model) Explain(features map[string]float64) string {
	clauses := make([]string, 0, nFeatures)
	for _, f := range schema {
		v, ok := features[f.key]
		if !ok {
			clauses = append(clauses, f.key+" not compared")
			continue
		}
		i, ok := f.index(v)
		if !ok {
			clauses = append(clauses, fmt.Sprintf("%s at unrecognized level %s", f.key, levelText(v)))
			continue
		}
		clauses = append(clauses, f.levels[i].clause)
	}
	var extra []string
	for k := range features {
		if !known(k) {
			extra = append(extra, k)
		}
	}
	slices.Sort(extra)
	for _, k := range extra {
		clauses = append(clauses, fmt.Sprintf("unrecognized feature %s at level %s", k, levelText(features[k])))
	}
	return strings.Join(clauses, ", ")
}

// Reports whether a key names a feature of the schema
func known(key string) bool {
	for _, f := range schema {
		if f.key == key {
			return true
		}
	}
	return false
}

func levelText(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
