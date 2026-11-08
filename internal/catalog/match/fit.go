package match

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Vector minimum, iteration cap, convergence tolerance, Laplace pseudo count, payload sum tolerance, and payload version
const (
	minVectors     = 20
	maxIterations  = 200
	tolerance      = 1e-6
	smoothing      = 1.0
	sumTolerance   = 1e-9
	weightsVersion = 1
)

var (
	ErrTooFew     = model.ErrTooFewPairs
	ErrBadKind    = errors.New("match: unknown entity kind")
	ErrBadWeights = errors.New("match: invalid weights")
)

// Class a training vector is clamped to, or free for the expectation step
const (
	unlabeled = iota
	labeledMatch
	labeledNonMatch
)

// One training vector as level positions with its clamped class
type sample struct {
	idx   [nFeatures]int
	class int
}

// One level's m and u in the stored weights
type probabilities struct {
	M float64 `json:"m"`
	U float64 `json:"u"`
}

// Stored form of one kind's parameters with levels keyed by their integer value
type payload struct {
	Version  int                                 `json:"version"`
	Kind     string                              `json:"kind"`
	Lambda   float64                             `json:"lambda"`
	Features map[string]map[string]probabilities `json:"features"`
}

// Relearns a kind's weights by semi-supervised EM and returns how many schema conforming vectors it used
func (md *Model) Fit(kind string, labeled []model.Labeled, unlabeledVectors []map[string]float64) (int, error) {
	if !model.ValidKind(kind) {
		return 0, fmt.Errorf("%w: %q", ErrBadKind, kind)
	}
	data := make([]sample, 0, len(labeled)+len(unlabeledVectors))
	for _, l := range labeled {
		if idx, ok := vector(l.Features); ok {
			class := labeledNonMatch
			if l.Match {
				class = labeledMatch
			}
			data = append(data, sample{idx: idx, class: class})
		}
	}
	for _, f := range unlabeledVectors {
		if idx, ok := vector(f); ok {
			data = append(data, sample{idx: idx, class: unlabeled})
		}
	}
	if len(data) < minVectors {
		return 0, fmt.Errorf("%w: %d of %d %s vectors fit the comparison schema, %d needed",
			ErrTooFew, len(data), len(labeled)+len(unlabeledVectors), kind, minVectors)
	}
	md.store(kind, expectationMaximization(md.prior, data))
	return len(data), nil
}

// Parses a stored feature map into level positions, false unless it holds exactly the schema features
func vector(features map[string]float64) ([nFeatures]int, bool) {
	var idx [nFeatures]int
	if len(features) != nFeatures {
		return idx, false
	}
	for f, feat := range schema {
		v, ok := features[feat.key]
		if !ok {
			return idx, false
		}
		if idx[f], ok = feat.index(v); !ok {
			return idx, false
		}
	}
	return idx, true
}

// Iterates from a start until the log likelihood settles within tolerance or the iteration cap
func expectationMaximization(start *params, data []sample) *params {
	cur, prev := start, math.Inf(-1)
	for range maxIterations {
		next, ll := cur.step(data)
		cur = next
		if math.Abs(ll-prev) < tolerance {
			break
		}
		prev = ll
	}
	return cur
}

// Scores the data under these parameters and returns the Laplace smoothed re-estimate with the log likelihood
func (p *params) step(data []sample) (*params, float64) {
	var logM, logU, countM, countU [nFeatures][]float64
	for f := range schema {
		n := len(p.m[f])
		logM[f], logU[f] = make([]float64, n), make([]float64, n)
		countM[f], countU[f] = make([]float64, n), make([]float64, n)
		for i := range n {
			logM[f][i], logU[f][i] = math.Log(p.m[f][i]), math.Log(p.u[f][i])
		}
	}
	logLambda, logRest := math.Log(p.lambda), math.Log(1-p.lambda)
	matches, ll := 0.0, 0.0
	for _, s := range data {
		lm, lu := logLambda, logRest
		for f, i := range s.idx {
			lm += logM[f][i]
			lu += logU[f][i]
		}
		var g float64
		switch s.class {
		case labeledMatch:
			g, ll = 1, ll+lm
		case labeledNonMatch:
			g, ll = 0, ll+lu
		default:
			top := max(lm, lu)
			total := top + math.Log(math.Exp(lm-top)+math.Exp(lu-top))
			g, ll = math.Exp(lm-total), ll+total
		}
		matches += g
		for f, i := range s.idx {
			countM[f][i] += g
			countU[f][i] += 1 - g
		}
	}
	n := float64(len(data))
	var m, u [nFeatures][]float64
	for f := range schema {
		levels := float64(len(countM[f]))
		m[f], u[f] = make([]float64, len(countM[f])), make([]float64, len(countU[f]))
		for i := range countM[f] {
			m[f][i] = (countM[f][i] + smoothing) / (matches + smoothing*levels)
			u[f][i] = (countU[f][i] + smoothing) / (n - matches + smoothing*levels)
		}
	}
	return newParams((matches+smoothing)/(n+2*smoothing), m, u), ll
}

// Serializes a kind's lambda and per level m and u as JSON, the shipped priors when untrained
func (md *Model) Weights(kind string) ([]byte, error) {
	if !model.ValidKind(kind) {
		return nil, fmt.Errorf("%w: %q", ErrBadKind, kind)
	}
	p := md.weightsFor(kind)
	out := payload{Version: weightsVersion, Kind: kind, Lambda: p.lambda, Features: make(map[string]map[string]probabilities, nFeatures)}
	for f, feat := range schema {
		levels := make(map[string]probabilities, len(feat.levels))
		for i, l := range feat.levels {
			levels[strconv.Itoa(l.value)] = probabilities{M: p.m[f][i], U: p.u[f][i]}
		}
		out.Features[feat.key] = levels
	}
	return json.Marshal(out)
}

// Restores a kind's parameters from Weights output after checking every probability and level
func (md *Model) Load(kind string, weights []byte) error {
	if !model.ValidKind(kind) {
		return fmt.Errorf("%w: %q", ErrBadKind, kind)
	}
	p, err := decode(kind, weights)
	if err != nil {
		return err
	}
	md.store(kind, p)
	return nil
}

// Parses and validates a weights payload into parameters for the given kind
func decode(kind string, weights []byte) (*params, error) {
	dec := json.NewDecoder(bytes.NewReader(weights))
	dec.DisallowUnknownFields()
	var in payload
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrBadWeights, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing data after the payload", ErrBadWeights)
	}
	switch {
	case in.Version != weightsVersion:
		return nil, fmt.Errorf("%w: version %d, want %d", ErrBadWeights, in.Version, weightsVersion)
	case in.Kind != kind:
		return nil, fmt.Errorf("%w: payload is for %q, loading %q", ErrBadWeights, in.Kind, kind)
	case !open(in.Lambda):
		return nil, fmt.Errorf("%w: lambda %v outside (0, 1)", ErrBadWeights, in.Lambda)
	case len(in.Features) != nFeatures:
		return nil, fmt.Errorf("%w: %d features, want %d", ErrBadWeights, len(in.Features), nFeatures)
	}
	var m, u [nFeatures][]float64
	for f, feat := range schema {
		levels, ok := in.Features[feat.key]
		if !ok {
			return nil, fmt.Errorf("%w: missing feature %s", ErrBadWeights, feat.key)
		}
		if len(levels) != len(feat.levels) {
			return nil, fmt.Errorf("%w: %s has %d levels, want %d", ErrBadWeights, feat.key, len(levels), len(feat.levels))
		}
		m[f], u[f] = make([]float64, len(feat.levels)), make([]float64, len(feat.levels))
		sumM, sumU := 0.0, 0.0
		for i, l := range feat.levels {
			pr, ok := levels[strconv.Itoa(l.value)]
			switch {
			case !ok:
				return nil, fmt.Errorf("%w: %s is missing level %d", ErrBadWeights, feat.key, l.value)
			case !open(pr.M) || !open(pr.U):
				return nil, fmt.Errorf("%w: %s level %d m %v u %v outside (0, 1)", ErrBadWeights, feat.key, l.value, pr.M, pr.U)
			}
			m[f][i], u[f][i] = pr.M, pr.U
			sumM += pr.M
			sumU += pr.U
		}
		if math.Abs(sumM-1) > sumTolerance || math.Abs(sumU-1) > sumTolerance {
			return nil, fmt.Errorf("%w: %s m sums to %v and u to %v, want 1", ErrBadWeights, feat.key, sumM, sumU)
		}
	}
	return newParams(in.Lambda, m, u), nil
}

// Reports whether a probability lies strictly between zero and one
func open(p float64) bool { return p > 0 && p < 1 }
