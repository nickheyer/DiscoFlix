package match

import (
	"maps"
	"math"
	"testing"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Checks textbook Jaro-Winkler values and the empty string cases
func TestJaroWinkler(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want float64
	}{
		{"MARTHA", "MARHTA", 0.9611},
		{"DWAYNE", "DUANE", 0.8400},
		{"DIXON", "DICKSONX", 0.8133},
		{"same", "same", 1},
		{"", "", 1},
		{"", "x", 0},
		{"abc", "xyz", 0},
	} {
		if got := jaroWinkler(c.a, c.b); math.Abs(got-c.want) > 5e-4 {
			t.Errorf("jaroWinkler(%q, %q) = %.4f, want %.4f", c.a, c.b, got, c.want)
		}
	}
}

// Checks every feature level for crafted record pairs
func TestFeatures(t *testing.T) {
	for _, c := range []struct {
		name string
		kind string
		a, b model.Record
		want map[string]float64
	}{
		{
			name: "alias exact with everything close",
			kind: model.KindMovie,
			a: model.Record{
				Kind: model.KindMovie, Titles: []string{"Le Fabuleux Destin d'Amélie Poulain", "Amélie"},
				Year: 2001, Runtime: 122, Language: "fr", XIDs: map[string]string{model.NSIMDb: "tt0211915"},
			},
			b: model.Record{
				Kind: model.KindMovie, Titles: []string{"AMELIE!"},
				Year: 2001, Runtime: 124, Language: "FR-fr", XIDs: map[string]string{model.NSTMDB: "movie/194"},
			},
			want: vec(TitleExact, YearSame, RuntimeClose, LanguageSame, XIDDisjoint, KindSame),
		},
		{
			name: "close title a year apart sharing an id",
			kind: model.KindMovie,
			a: model.Record{
				Kind: model.KindMovie, Titles: []string{"Harry Potter and the Philosopher's Stone"},
				Year: 2001, Runtime: 152, Language: "en", XIDs: map[string]string{model.NSIMDb: "tt0241527", model.NSTMDB: "movie/671"},
			},
			b: model.Record{
				Kind: model.KindMovie, Titles: []string{"Harry Potter and the Sorcerer's Stone"},
				Year: 2002, Runtime: 162, Language: "de", XIDs: map[string]string{model.NSIMDb: "tt0241527", model.NSTMDB: "movie/1"},
			},
			want: vec(TitleClose, YearAdjacent, RuntimeNear, LanguageDifferent, XIDShared, KindSame),
		},
		{
			name: "similar title across kinds with a conflicting id",
			kind: model.KindMovie,
			a: model.Record{
				Kind: model.KindMovie, Titles: []string{"Seven"},
				Year: 1995, Runtime: 127, Language: "", XIDs: map[string]string{model.NSIMDb: "tt0114369"},
			},
			b: model.Record{
				Kind: model.KindSeries, Titles: []string{"Se7en"},
				Year: 1998, Runtime: 138, Language: "en", XIDs: map[string]string{model.NSIMDb: "tt9999999"},
			},
			want: vec(TitleSimilar, YearNear, RuntimeFar, LanguageUnknown, XIDConflict, KindDifferent),
		},
		{
			name: "different title far apart with nothing else known",
			kind: model.KindMovie,
			a:    model.Record{Kind: model.KindMovie, Titles: []string{"Inception"}, Year: 2010},
			b:    model.Record{Kind: model.KindMovie, Titles: []string{"Interstellar"}, Year: 2014},
			want: vec(TitleDifferent, YearFar, RuntimeUnknown, LanguageUnknown, XIDDisjoint, KindSame),
		},
		{
			name: "punctuation only titles and empty id values never agree",
			kind: model.KindSeries,
			a:    model.Record{Kind: model.KindSeries, Titles: []string{"!!!"}, XIDs: map[string]string{model.NSIMDb: ""}},
			b:    model.Record{Kind: model.KindSeries, Titles: []string{"???"}, Runtime: 45, XIDs: map[string]string{model.NSIMDb: "tt1"}},
			want: vec(TitleDifferent, YearUnknown, RuntimeUnknown, LanguageUnknown, XIDDisjoint, KindSame),
		},
		{
			name: "records of another kind than the one scored",
			kind: model.KindEpisode,
			a:    model.Record{Kind: model.KindSeason, Titles: []string{"Season 1"}},
			b:    model.Record{Kind: model.KindSeason, Titles: []string{"Season 1"}},
			want: vec(TitleExact, YearUnknown, RuntimeUnknown, LanguageUnknown, XIDDisjoint, KindDifferent),
		},
	} {
		got := Features(c.kind, c.a, c.b)
		if !maps.Equal(got, c.want) {
			t.Errorf("%s\n got %v\nwant %v", c.name, got, c.want)
		}
		if swapped := Features(c.kind, c.b, c.a); !maps.Equal(swapped, got) {
			t.Errorf("%s is not symmetric, %v then %v", c.name, got, swapped)
		}
	}
}

// Checks the year and runtime cutoffs on both sides of every boundary
func TestYearAndRuntimeBoundaries(t *testing.T) {
	years := map[[2]int]int{
		{2000, 2000}: YearSame, {2000, 2001}: YearAdjacent, {2001, 2000}: YearAdjacent,
		{2000, 2002}: YearNear, {2000, 2003}: YearNear, {2000, 2004}: YearFar,
		{0, 2000}: YearUnknown, {2000, 0}: YearUnknown, {-5, 2000}: YearUnknown,
	}
	for in, want := range years {
		if got := yearLevel(in[0], in[1]); got != want {
			t.Errorf("yearLevel%v = %d, want %d", in, got, want)
		}
	}
	runtimes := map[[2]int]int{
		{100, 100}: RuntimeClose, {100, 102}: RuntimeClose, {100, 103}: RuntimeNear,
		{110, 100}: RuntimeNear, {100, 111}: RuntimeFar, {0, 100}: RuntimeUnknown, {100, -1}: RuntimeUnknown,
	}
	for in, want := range runtimes {
		if got := runtimeLevel(in[0], in[1]); got != want {
			t.Errorf("runtimeLevel%v = %d, want %d", in, got, want)
		}
	}
}

// Checks every shipped level is in range, contiguous, and sums to one per feature
func TestSchemaPriors(t *testing.T) {
	for _, f := range schema {
		sumM, sumU := 0.0, 0.0
		for i, l := range f.levels {
			if i > 0 && l.value != f.levels[i-1].value+1 {
				t.Errorf("%s levels are not contiguous at %d", f.key, l.value)
			}
			if !open(l.m) || !open(l.u) {
				t.Errorf("%s level %d prior m %v u %v outside (0, 1)", f.key, l.value, l.m, l.u)
			}
			sumM += l.m
			sumU += l.u
		}
		if math.Abs(sumM-1) > sumTolerance || math.Abs(sumU-1) > sumTolerance {
			t.Errorf("%s priors sum to m %v u %v", f.key, sumM, sumU)
		}
	}
}

// Builds a feature map in schema order from level values
func vec(title, year, runtime, language, xid, kind int) map[string]float64 {
	return map[string]float64{
		FeatureTitle: float64(title), FeatureYear: float64(year), FeatureRuntime: float64(runtime),
		FeatureLanguage: float64(language), FeatureXID: float64(xid), FeatureKind: float64(kind),
	}
}
