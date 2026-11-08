package match

import (
	"strings"
	"sync"
	"testing"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

var (
	matrix = model.Record{
		Kind: model.KindMovie, Titles: []string{"The Matrix"}, Year: 1999, Runtime: 136, Language: "en",
		XIDs: map[string]string{model.NSIMDb: "tt0133093"},
	}
	matrixElsewhere = model.Record{
		Kind: model.KindMovie, Titles: []string{"Matrix", "The Matrix"}, Year: 1999, Runtime: 136, Language: "en-US",
		XIDs: map[string]string{model.NSTMDB: "movie/603"},
	}
	amelie = model.Record{
		Kind: model.KindMovie, Titles: []string{"Le Fabuleux Destin d'Amélie Poulain"}, Year: 2001, Runtime: 122, Language: "fr",
		XIDs: map[string]string{model.NSTMDB: "movie/194"},
	}
)

// Checks a shared external id scores exactly one whatever the other features say
func TestHardMatch(t *testing.T) {
	other := amelie
	other.Kind = model.KindSeries
	other.XIDs = map[string]string{model.NSIMDb: "tt0133093", model.NSTMDB: "movie/194"}
	p, f := New().Score(model.KindMovie, matrix, other)
	if p != 1 {
		t.Fatalf("shared imdb id scored %v, want 1", p)
	}
	if f[FeatureXID] != XIDShared || f[FeatureTitle] != TitleDifferent || f[FeatureKind] != KindDifferent {
		t.Fatalf("features %v", f)
	}
}

// Checks a conflicting id in a shared namespace caps an otherwise certain match
func TestConflictingID(t *testing.T) {
	md := New()
	twin := matrix
	twin.XIDs = map[string]string{model.NSIMDb: "tt0000001"}
	p, f := md.Score(model.KindMovie, matrix, twin)
	if f[FeatureXID] != XIDConflict {
		t.Fatalf("xid level %v, want conflict", f[FeatureXID])
	}
	if p > conflictCap || p < minProbability {
		t.Fatalf("conflicting id scored %v, want within [%v, %v]", p, minProbability, conflictCap)
	}
	twin.XIDs = map[string]string{model.NSTVDB: "movie/169"}
	if free, _ := md.Score(model.KindMovie, matrix, twin); free < acceptLine {
		t.Fatalf("the same pair without the conflict scored %v, the cap is not what held it down", free)
	}
}

// Checks exact titles outrank close ones, close outrank similar, and similar outrank different
func TestScoreOrdering(t *testing.T) {
	md := New()
	pair := func(a, b string) float64 {
		p, _ := md.Score(model.KindMovie,
			model.Record{Kind: model.KindMovie, Titles: []string{a}, Year: 2000},
			model.Record{Kind: model.KindMovie, Titles: []string{b}, Year: 2000})
		return p
	}
	exact, near, similar, different := pair("Toy Story", "Toy Story"), pair("Toy Story", "Toy Story 2"), pair("Seven", "Se7en"), pair("Inception", "Interstellar")
	if !(exact > near && near > similar && similar > different) {
		t.Fatalf("exact %v close %v similar %v different %v are not strictly ordered", exact, near, similar, different)
	}
}

// Checks the shipped priors accept an obvious match and reject an obvious non-match
func TestUntrainedSeparation(t *testing.T) {
	md := New()
	if p, f := md.Score(model.KindMovie, matrix, matrixElsewhere); p <= acceptLine {
		t.Errorf("obvious match scored %v with %v, want above %v", p, f, acceptLine)
	}
	if p, f := md.Score(model.KindMovie, matrix, amelie); p >= reviewLine {
		t.Errorf("obvious non-match scored %v with %v, want below %v", p, f, reviewLine)
	}
	for _, kind := range model.Kinds {
		a, b := matrix, matrixElsewhere
		a.Kind, b.Kind = kind, kind
		if p, _ := md.Score(kind, a, b); p <= acceptLine {
			t.Errorf("untrained %s scored %v, every kind should share the priors", kind, p)
		}
	}
	if p, _ := md.Score(model.KindMovie, matrix, matrix); p != 1 {
		t.Errorf("a record against itself scored %v", p)
	}
	low := matrix
	low.XIDs = nil
	far := model.Record{Kind: model.KindSeries, Titles: []string{"Bluey"}, Year: 2018, Runtime: 7, Language: "ja"}
	if p, _ := md.Score(model.KindMovie, low, far); p != minProbability {
		t.Errorf("hopeless pair scored %v, want the floor %v", p, minProbability)
	}
}

// Checks plain words for real vectors and for missing, invalid, and unknown features
func TestExplain(t *testing.T) {
	md := New()
	_, f := md.Score(model.KindMovie, matrix, matrixElsewhere)
	want := "title matches exactly, released the same year, runtime within two minutes, same language, no external id in common, same kind"
	if got := md.Explain(f); got != want {
		t.Errorf("Explain = %q\nwant %q", got, want)
	}
	odd := map[string]float64{
		FeatureTitle: TitleClose, FeatureYear: 7, FeatureLanguage: LanguageDifferent,
		FeatureXID: XIDConflict, FeatureKind: 0.5, "plot": 1.5, "cast": 2,
	}
	want = "title nearly matches, year at unrecognized level 7, runtime not compared, different language, conflicting external id, kind at unrecognized level 0.5, unrecognized feature cast at level 2, unrecognized feature plot at level 1.5"
	if got := md.Explain(odd); got != want {
		t.Errorf("Explain = %q\nwant %q", got, want)
	}
	for _, feat := range schema {
		for _, l := range feat.levels {
			v := vec(TitleExact, YearSame, RuntimeClose, LanguageSame, XIDDisjoint, KindSame)
			v[feat.key] = float64(l.value)
			if got := md.Explain(v); len(strings.Split(got, ", ")) != nFeatures || !strings.Contains(got, l.clause) {
				t.Errorf("%s level %d renders %q", feat.key, l.value, got)
			}
		}
	}
}

// Checks scoring, explaining, fitting, and loading run together without tearing a kind's weights
func TestConcurrentUse(t *testing.T) {
	md := New()
	vectors := make([]map[string]float64, 0, 40)
	for i := range 40 {
		if i%2 == 0 {
			vectors = append(vectors, vec(TitleExact, YearSame, RuntimeClose, LanguageSame, XIDDisjoint, KindSame))
		} else {
			vectors = append(vectors, vec(TitleDifferent, YearFar, RuntimeFar, LanguageDifferent, XIDDisjoint, KindSame))
		}
	}
	saved, err := New().Weights(model.KindMovie)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for g := range 8 {
		wg.Go(func() {
			for range 50 {
				switch g % 4 {
				case 0:
					if p, f := md.Score(model.KindMovie, matrix, matrixElsewhere); p < minProbability || p > 1 || md.Explain(f) == "" {
						errs <- errScore
					}
				case 1:
					if _, err := md.Fit(model.KindMovie, []model.Labeled{{Features: vectors[0], Match: true}}, vectors); err != nil {
						errs <- err
					}
				case 2:
					if err := md.Load(model.KindMovie, saved); err != nil {
						errs <- err
					}
				case 3:
					if _, err := md.Weights(model.KindMovie); err != nil {
						errs <- err
					}
				}
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
