package match

import (
	"math"
	"strings"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Feature keys of the comparison vector, each valued at one integer level encoded as float64
const (
	FeatureTitle    = "title"
	FeatureYear     = "year"
	FeatureRuntime  = "runtime"
	FeatureLanguage = "language"
	FeatureXID      = "xid"
	FeatureKind     = "kind"
)

// Title levels from exact normalized equality down through best Jaro-Winkler at 0.92 and 0.80
const (
	TitleDifferent = 0
	TitleSimilar   = 1
	TitleClose     = 2
	TitleExact     = 3
)

// Year levels by absolute difference in release year, unknown when either side has none
const (
	YearUnknown  = -1
	YearFar      = 0
	YearNear     = 1
	YearAdjacent = 2
	YearSame     = 3
)

// Runtime levels by absolute difference in minutes, unknown when either side has none
const (
	RuntimeUnknown = -1
	RuntimeFar     = 0
	RuntimeNear    = 1
	RuntimeClose   = 2
)

// Language levels by primary language subtag, unknown when either side has none
const (
	LanguageUnknown   = -1
	LanguageDifferent = 0
	LanguageSame      = 1
)

// External id levels by agreement inside the namespaces both records carry
const (
	XIDConflict = 0
	XIDDisjoint = 1
	XIDShared   = 2
)

// Kind levels by whether both records are of the kind being scored
const (
	KindDifferent = 0
	KindSame      = 1
)

// Level cutoffs for title, year, and runtime plus the Winkler boost threshold, prefix scale, and prefix length
const (
	closeTitle   = 0.92
	similarTitle = 0.80
	nearYears    = 3
	closeMinutes = 2
	nearMinutes  = 10
	boostJaro    = 0.7
	prefixScale  = 0.1
	prefixRunes  = 4
)

// Positions of the features inside every vector and parameter table
const (
	featTitle = iota
	featYear
	featRuntime
	featLanguage
	featXID
	featKind
	nFeatures
)

// One outcome of a feature with its prior m and u and the words that explain it
type level struct {
	value  int
	m, u   float64
	clause string
}

// One comparison with its levels in ascending contiguous order
type feature struct {
	key    string
	levels []level
}

// Prior m and u per level, unknown levels carry equal m and u so absence weighs zero
var schema = [nFeatures]feature{
	featTitle: {FeatureTitle, []level{
		{TitleDifferent, 0.01, 0.95, "title differs"},
		{TitleSimilar, 0.03, 0.04, "title loosely similar"},
		{TitleClose, 0.06, 0.008, "title nearly matches"},
		{TitleExact, 0.90, 0.002, "title matches exactly"},
	}},
	featYear: {FeatureYear, []level{
		{YearUnknown, 0.04, 0.04, "release year unknown"},
		{YearFar, 0.01, 0.76, "released more than three years apart"},
		{YearNear, 0.02, 0.11, "released two or three years apart"},
		{YearAdjacent, 0.08, 0.06, "released a year apart"},
		{YearSame, 0.85, 0.03, "released the same year"},
	}},
	featRuntime: {FeatureRuntime, []level{
		{RuntimeUnknown, 0.10, 0.10, "runtime unknown"},
		{RuntimeFar, 0.04, 0.70, "runtime more than ten minutes apart"},
		{RuntimeNear, 0.20, 0.14, "runtime within ten minutes"},
		{RuntimeClose, 0.66, 0.06, "runtime within two minutes"},
	}},
	featLanguage: {FeatureLanguage, []level{
		{LanguageUnknown, 0.08, 0.08, "language unknown"},
		{LanguageDifferent, 0.04, 0.47, "different language"},
		{LanguageSame, 0.88, 0.45, "same language"},
	}},
	featXID: {FeatureXID, []level{
		{XIDConflict, 0.01, 0.1999, "conflicting external id"},
		{XIDDisjoint, 0.70, 0.80, "no external id in common"},
		{XIDShared, 0.29, 0.0001, "shares an external id"},
	}},
	featKind: {FeatureKind, []level{
		{KindDifferent, 0.01, 0.10, "different kind"},
		{KindSame, 0.99, 0.90, "same kind"},
	}},
}

// Maps a level value to its table position, false for any value the feature does not define
func (f feature) index(v float64) (int, bool) {
	lo, hi := float64(f.levels[0].value), float64(f.levels[len(f.levels)-1].value)
	if !(v >= lo && v <= hi) || v != math.Trunc(v) {
		return 0, false
	}
	return int(v - lo), true
}

// Compares two records scored as a kind into the level of every feature keyed by feature name
func Features(kind string, a, b model.Record) map[string]float64 {
	return featureMap(compare(kind, a, b))
}

// Renders level positions as the named float vector stored on match edges
func featureMap(idx [nFeatures]int) map[string]float64 {
	out := make(map[string]float64, nFeatures)
	for f, i := range idx {
		out[schema[f].key] = float64(schema[f].levels[i].value)
	}
	return out
}

// Returns the level position of every feature in schema order
func compare(kind string, a, b model.Record) [nFeatures]int {
	values := [nFeatures]int{
		featTitle:    titleLevel(a.Titles, b.Titles),
		featYear:     yearLevel(a.Year, b.Year),
		featRuntime:  runtimeLevel(a.Runtime, b.Runtime),
		featLanguage: languageLevel(a.Language, b.Language),
		featXID:      xidLevel(a.XIDs, b.XIDs),
		featKind:     kindLevel(kind, a.Kind, b.Kind),
	}
	var idx [nFeatures]int
	for f, v := range values {
		idx[f] = v - schema[f].levels[0].value
	}
	return idx
}

// Exact when any normalized pair is equal, otherwise graded by the best Jaro-Winkler pair
func titleLevel(a, b []string) int {
	na, nb := normalizedTitles(a), normalizedTitles(b)
	best := 0.0
	for _, x := range na {
		for _, y := range nb {
			if x == y {
				return TitleExact
			}
			best = max(best, jaroWinkler(x, y))
		}
	}
	switch {
	case best >= closeTitle:
		return TitleClose
	case best >= similarTitle:
		return TitleSimilar
	}
	return TitleDifferent
}

// Folds titles with the catalog normalizer, dropping empty and repeated ones
func normalizedTitles(titles []string) []string {
	out := make([]string, 0, len(titles))
	seen := make(map[string]bool, len(titles))
	for _, t := range titles {
		n := model.Normalize(t)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// Grades the gap between two release years, unknown when either is unset
func yearLevel(a, b int) int {
	if a <= 0 || b <= 0 {
		return YearUnknown
	}
	switch d := absInt(a - b); {
	case d == 0:
		return YearSame
	case d == 1:
		return YearAdjacent
	case d <= nearYears:
		return YearNear
	}
	return YearFar
}

// Grades the gap between two runtimes in minutes, unknown when either is unset
func runtimeLevel(a, b int) int {
	if a <= 0 || b <= 0 {
		return RuntimeUnknown
	}
	switch d := absInt(a - b); {
	case d <= closeMinutes:
		return RuntimeClose
	case d <= nearMinutes:
		return RuntimeNear
	}
	return RuntimeFar
}

// Compares primary language subtags so en and en-US agree, unknown when either is blank
func languageLevel(a, b string) int {
	pa, pb := primaryLanguage(a), primaryLanguage(b)
	switch {
	case pa == "" || pb == "":
		return LanguageUnknown
	case pa == pb:
		return LanguageSame
	}
	return LanguageDifferent
}

// Lowercases a language tag and keeps the part before any region or script
func primaryLanguage(tag string) string {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if i := strings.IndexAny(tag, "-_"); i >= 0 {
		tag = tag[:i]
	}
	return tag
}

// Shared when any common namespace agrees, conflict when common ones only disagree, else disjoint
func xidLevel(a, b map[string]string) int {
	out := XIDDisjoint
	for ns, va := range a {
		vb, ok := b[ns]
		if va == "" || !ok || vb == "" {
			continue
		}
		if va == vb {
			return XIDShared
		}
		out = XIDConflict
	}
	return out
}

// Same only when both records are of the kind being scored
func kindLevel(kind, a, b string) int {
	if a == kind && b == kind {
		return KindSame
	}
	return KindDifferent
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Similarity from zero to one by matched runes and transpositions, raised by up to four shared leading runes
func jaroWinkler(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	if len(ra) == 0 || len(rb) == 0 {
		if len(ra) == len(rb) {
			return 1
		}
		return 0
	}
	window := max(max(len(ra), len(rb))/2-1, 0)
	matchA := make([]bool, len(ra))
	matchB := make([]bool, len(rb))
	matches := 0
	for i := range ra {
		for j := max(0, i-window); j <= min(len(rb)-1, i+window); j++ {
			if !matchB[j] && ra[i] == rb[j] {
				matchA[i], matchB[j] = true, true
				matches++
				break
			}
		}
	}
	if matches == 0 {
		return 0
	}
	half, k := 0, 0
	for i := range ra {
		if !matchA[i] {
			continue
		}
		for !matchB[k] {
			k++
		}
		if ra[i] != rb[k] {
			half++
		}
		k++
	}
	m := float64(matches)
	jaro := (m/float64(len(ra)) + m/float64(len(rb)) + (m-float64(half)/2)/m) / 3
	if jaro <= boostJaro {
		return jaro
	}
	prefix := 0
	for prefix < min(prefixRunes, len(ra), len(rb)) && ra[prefix] == rb[prefix] {
		prefix++
	}
	return jaro + float64(prefix)*prefixScale*(1-jaro)
}
