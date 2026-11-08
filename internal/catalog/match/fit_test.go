package match

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"math"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Known generating model for synthetic comparison vectors
type truth struct {
	lambda float64
	m, u   [nFeatures][]float64
}

// Departs from the priors so exact titles are common among non-matches and runtime decides more
var generator = truth{
	lambda: 0.35,
	m: [nFeatures][]float64{
		featTitle:    {0.05, 0.10, 0.25, 0.60},
		featYear:     {0.10, 0.05, 0.05, 0.20, 0.60},
		featRuntime:  {0.20, 0.10, 0.30, 0.40},
		featLanguage: {0.15, 0.15, 0.70},
		featXID:      {0.05, 0.80, 0.15},
		featKind:     {0.05, 0.95},
	},
	u: [nFeatures][]float64{
		featTitle:    {0.55, 0.20, 0.10, 0.15},
		featYear:     {0.10, 0.50, 0.20, 0.12, 0.08},
		featRuntime:  {0.20, 0.45, 0.25, 0.10},
		featLanguage: {0.15, 0.40, 0.45},
		featXID:      {0.30, 0.68, 0.02},
		featKind:     {0.30, 0.70},
	},
}

// Picks one level position from a categorical distribution
func draw(r *rand.Rand, probs []float64) int {
	x := r.Float64()
	for i, p := range probs {
		if x -= p; x < 0 {
			return i
		}
	}
	return len(probs) - 1
}

// Draws vectors with their hidden class from the generating model
func sampleTruth(r *rand.Rand, tr truth, n int) ([][nFeatures]int, []bool) {
	idx := make([][nFeatures]int, n)
	match := make([]bool, n)
	for j := range n {
		match[j] = r.Float64() < tr.lambda
		table := tr.u
		if match[j] {
			table = tr.m
		}
		for f := range schema {
			idx[j][f] = draw(r, table[f])
		}
	}
	return idx, match
}

// Returns log loss and rank AUC of a posterior on vectors with known classes
func quality(p *params, idx [][nFeatures]int, match []bool) (float64, float64) {
	type scored struct {
		p     float64
		match bool
	}
	all := make([]scored, len(idx))
	loss := 0.0
	for j := range idx {
		q := p.posterior(idx[j])
		all[j] = scored{q, match[j]}
		if match[j] {
			loss -= math.Log(q)
		} else {
			loss -= math.Log(1 - q)
		}
	}
	slices.SortFunc(all, func(a, b scored) int {
		switch {
		case a.p < b.p:
			return -1
		case a.p > b.p:
			return 1
		}
		return 0
	})
	rankSum, positives := 0.0, 0.0
	for i := 0; i < len(all); {
		j := i
		for j < len(all) && all[j].p == all[i].p {
			j++
		}
		mid := float64(i+j+1) / 2
		for k := i; k < j; k++ {
			if all[k].match {
				rankSum += mid
				positives++
			}
		}
		i = j
	}
	negatives := float64(len(all)) - positives
	return loss / float64(len(all)), (rankSum - positives*(positives+1)/2) / (positives * negatives)
}

// Checks EM over unlabeled vectors recovers the generating m, u, and lambda and separates better than the priors
func TestFitRecoversKnownParameters(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	train, _ := sampleTruth(r, generator, 20000)
	vectors := make([]map[string]float64, len(train))
	for j, idx := range train {
		vectors[j] = featureMap(idx)
	}
	md := New()
	n, err := md.Fit(model.KindMovie, nil, vectors)
	if err != nil {
		t.Fatal(err)
	}
	if n != len(vectors) {
		t.Fatalf("used %d vectors, want %d", n, len(vectors))
	}
	fitted := md.weightsFor(model.KindMovie)
	const within = 0.03
	if math.Abs(fitted.lambda-generator.lambda) > within {
		t.Errorf("lambda %.4f, want %.4f", fitted.lambda, generator.lambda)
	}
	for f, feat := range schema {
		for i, l := range feat.levels {
			if d := math.Abs(fitted.m[f][i] - generator.m[f][i]); d > within {
				t.Errorf("%s level %d m %.4f, want %.4f", feat.key, l.value, fitted.m[f][i], generator.m[f][i])
			}
			if d := math.Abs(fitted.u[f][i] - generator.u[f][i]); d > within {
				t.Errorf("%s level %d u %.4f, want %.4f", feat.key, l.value, fitted.u[f][i], generator.u[f][i])
			}
		}
	}
	held, match := sampleTruth(r, generator, 5000)
	priorLoss, priorAUC := quality(md.prior, held, match)
	fitLoss, fitAUC := quality(fitted, held, match)
	t.Logf("priors log loss %.4f AUC %.4f, fitted log loss %.4f AUC %.4f", priorLoss, priorAUC, fitLoss, fitAUC)
	if fitLoss >= priorLoss || fitAUC <= priorAUC {
		t.Errorf("fitting did not improve separation, log loss %.4f to %.4f, AUC %.4f to %.4f", priorLoss, fitLoss, priorAUC, fitAUC)
	}
	if other := md.weightsFor(model.KindSeries); other != md.prior {
		t.Error("fitting movies changed the series weights")
	}
}

// Checks labeled vectors stay in their class so labeled only data gives the smoothed closed form
func TestFitClampsLabeledVectors(t *testing.T) {
	top := vec(TitleExact, YearSame, RuntimeClose, LanguageSame, XIDShared, KindSame)
	bottom := vec(TitleDifferent, YearUnknown, RuntimeUnknown, LanguageUnknown, XIDConflict, KindDifferent)
	var labeled []model.Labeled
	for range 10 {
		labeled = append(labeled, model.Labeled{Features: bottom, Match: true})
	}
	for range 15 {
		labeled = append(labeled, model.Labeled{Features: top, Match: false})
	}
	md := New()
	if n, err := md.Fit(model.KindSeries, labeled, nil); err != nil || n != 25 {
		t.Fatalf("Fit = %d, %v", n, err)
	}
	p := md.weightsFor(model.KindSeries)
	if want := 11.0 / 27; math.Abs(p.lambda-want) > 1e-12 {
		t.Errorf("lambda %v, want %v", p.lambda, want)
	}
	for f, feat := range schema {
		levels := float64(len(feat.levels))
		last := len(feat.levels) - 1
		for i := range feat.levels {
			wantM, wantU := 1/(10+levels), 1/(15+levels)
			if i == 0 {
				wantM = 11 / (10 + levels)
			}
			if i == last {
				wantU = 16 / (15 + levels)
			}
			if math.Abs(p.m[f][i]-wantM) > 1e-12 || math.Abs(p.u[f][i]-wantU) > 1e-12 {
				t.Errorf("%s position %d m %v u %v, want %v %v", feat.key, i, p.m[f][i], p.u[f][i], wantM, wantU)
			}
		}
	}
}

// Checks fewer than twenty usable vectors is refused and the previous weights stay in place
func TestFitRefusesBelowMinimum(t *testing.T) {
	md := New()
	before, err := md.Weights(model.KindMovie)
	if err != nil {
		t.Fatal(err)
	}
	good := vec(TitleExact, YearSame, RuntimeClose, LanguageSame, XIDDisjoint, KindSame)
	vectors := slices.Repeat([]map[string]float64{good}, 19)
	malformed := []map[string]float64{
		{FeatureTitle: TitleExact},
		mutate(good, func(v map[string]float64) { v["plot"] = 1 }),
		mutate(good, func(v map[string]float64) { v[FeatureYear] = 4 }),
		mutate(good, func(v map[string]float64) { v[FeatureRuntime] = 1.5 }),
		mutate(good, func(v map[string]float64) { v[FeatureXID] = math.NaN() }),
		mutate(good, func(v map[string]float64) { delete(v, FeatureKind); v["genre"] = 1 }),
	}
	n, err := md.Fit(model.KindMovie, nil, append(slices.Clone(vectors), malformed...))
	if !errors.Is(err, ErrTooFew) || n != 0 {
		t.Fatalf("Fit with 19 usable vectors = %d, %v", n, err)
	}
	after, err := md.Weights(model.KindMovie)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("a refused fit changed the weights")
	}
	labeled := []model.Labeled{{Features: good, Match: true}}
	if n, err := md.Fit(model.KindMovie, labeled, append(vectors, malformed...)); err != nil || n != 20 {
		t.Fatalf("Fit with 20 usable vectors = %d, %v", n, err)
	}
	if _, err := md.Fit("book", labeled, vectors); !errors.Is(err, ErrBadKind) {
		t.Fatalf("Fit of an unknown kind = %v", err)
	}
}

// Checks trained and untrained weights survive a JSON round trip and reproduce the same scores
func TestWeightsRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	train, _ := sampleTruth(r, generator, 2000)
	vectors := make([]map[string]float64, len(train))
	for j, idx := range train {
		vectors[j] = featureMap(idx)
	}
	src := New()
	if _, err := src.Fit(model.KindMovie, nil, vectors); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{model.KindMovie, model.KindEpisode} {
		raw, err := src.Weights(kind)
		if err != nil {
			t.Fatal(err)
		}
		dst := New()
		if err := dst.Load(kind, raw); err != nil {
			t.Fatalf("Load %s: %v", kind, err)
		}
		again, err := dst.Weights(kind)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(raw, again) {
			t.Errorf("%s weights changed across a round trip\n%s\n%s", kind, raw, again)
		}
		for _, other := range []model.Record{matrixElsewhere, amelie} {
			a, b := matrix, other
			a.Kind, b.Kind = kind, kind
			pa, _ := src.Score(kind, a, b)
			pb, _ := dst.Score(kind, a, b)
			if pa != pb {
				t.Errorf("%s scored %v before and %v after the round trip", kind, pa, pb)
			}
		}
	}
	if _, err := src.Weights("book"); !errors.Is(err, ErrBadKind) {
		t.Errorf("Weights of an unknown kind = %v", err)
	}
}

// Checks every malformed payload is refused and leaves the loaded weights untouched
func TestLoadRejectsInvalidPayloads(t *testing.T) {
	md := New()
	good, err := md.Weights(model.KindMovie)
	if err != nil {
		t.Fatal(err)
	}
	edit := func(change func(*payload)) []byte {
		var p payload
		if err := json.Unmarshal(good, &p); err != nil {
			t.Fatal(err)
		}
		change(&p)
		out, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	set := func(feature, level string, m, u float64) func(*payload) {
		return func(p *payload) { p.Features[feature][level] = probabilities{M: m, U: u} }
	}
	cases := map[string][]byte{
		"not json":      []byte("weights"),
		"empty":         nil,
		"trailing data": append(slices.Clone(good), []byte(`{}`)...),
		"unknown field": bytes.Replace(good, []byte(`{"version"`), []byte(`{"extra":1,"version"`), 1),
		"version":       edit(func(p *payload) { p.Version = 2 }),
		"kind":          edit(func(p *payload) { p.Kind = model.KindSeries }),
		"lambda zero":   edit(func(p *payload) { p.Lambda = 0 }),
		"lambda one":    edit(func(p *payload) { p.Lambda = 1 }),
		"missing feature": edit(func(p *payload) {
			delete(p.Features, FeatureRuntime)
		}),
		"swapped feature": edit(func(p *payload) {
			p.Features["plot"] = p.Features[FeatureRuntime]
			delete(p.Features, FeatureRuntime)
		}),
		"missing level": edit(func(p *payload) { delete(p.Features[FeatureYear], "-1") }),
		"renamed level": edit(func(p *payload) {
			p.Features[FeatureYear]["4"] = p.Features[FeatureYear]["-1"]
			delete(p.Features[FeatureYear], "-1")
		}),
		"extra level":   edit(set(FeatureKind, "2", 0.5, 0.5)),
		"m zero":        edit(set(FeatureTitle, "3", 0, 0.002)),
		"u above one":   edit(set(FeatureTitle, "3", 0.9, 1.2)),
		"m negative":    edit(set(FeatureKind, "0", -0.01, 0.1)),
		"m sum off":     edit(set(FeatureTitle, "3", 0.5, 0.002)),
		"u sum off":     edit(set(FeatureKind, "1", 0.99, 0.5)),
		"null features": edit(func(p *payload) { p.Features = nil }),
	}
	for name, raw := range cases {
		if err := md.Load(model.KindMovie, raw); !errors.Is(err, ErrBadWeights) {
			t.Errorf("%s: Load = %v, want ErrBadWeights", name, err)
		}
	}
	if err := md.Load("book", good); !errors.Is(err, ErrBadKind) {
		t.Errorf("Load of an unknown kind = %v", err)
	}
	after, err := md.Weights(model.KindMovie)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(good, after) {
		t.Error("a refused payload changed the weights")
	}
}

// Copies a feature map and applies a change to the copy
func mutate(v map[string]float64, change func(map[string]float64)) map[string]float64 {
	out := maps.Clone(v)
	change(out)
	return out
}
