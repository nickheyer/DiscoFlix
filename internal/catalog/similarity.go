package catalog

import "strings"

// jaroWinkler returns the Jaro-Winkler similarity of two strings in [0,1]
func jaroWinkler(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	if len(ra) == 0 && len(rb) == 0 {
		return 1
	}
	if len(ra) == 0 || len(rb) == 0 {
		return 0
	}
	window := max(max(len(ra), len(rb))/2-1, 0)
	matchA := make([]bool, len(ra))
	matchB := make([]bool, len(rb))
	matches := 0
	for i := range ra {
		lo := max(0, i-window)
		hi := min(len(rb)-1, i+window)
		for j := lo; j <= hi; j++ {
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
	transpositions := 0
	k := 0
	for i := range ra {
		if !matchA[i] {
			continue
		}
		for !matchB[k] {
			k++
		}
		if ra[i] != rb[k] {
			transpositions++
		}
		k++
	}
	m := float64(matches)
	jaro := (m/float64(len(ra)) + m/float64(len(rb)) + (m-float64(transpositions)/2)/m) / 3
	prefix := 0
	for prefix < min(4, len(ra), len(rb)) && ra[prefix] == rb[prefix] {
		prefix++
	}
	return jaro + float64(prefix)*0.1*(1-jaro)
}

// titleSimilarity compares two normalized titles, rewarding exact and prefix matches before edit similarity
func titleSimilarity(query, title string) float64 {
	if query == title {
		return 1
	}
	if query == "" || title == "" {
		return 0
	}
	if strings.HasPrefix(title, query+" ") || strings.HasPrefix(query, title+" ") {
		short, long := len(query), len(title)
		if short > long {
			short, long = long, short
		}
		ratio := float64(short) / float64(long)
		return 0.8 + 0.15*ratio
	}
	return jaroWinkler(query, title)
}
