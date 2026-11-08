package match

import (
	"math"
	"math/rand/v2"
	"reflect"
	"testing"
)

// Checks components, joining products, threshold, cycles, self loops, and ordering
func TestPropagate(t *testing.T) {
	edges := []Edge{
		{A: "tmdb:603", B: "imdb:tt0133093", P: 0.9},
		{A: "imdb:tt0133093", B: "tvdb:169", P: 0.8},
		{A: "tvdb:169", B: "tmdb:603", P: 0.95},
		{A: "wikidata:Q83495", B: "tvdb:169", P: 0.5},
		{A: "trakt:movie/the-matrix", B: "wikidata:Q83495", P: 0.49},
		{A: "tmdb:194", B: "imdb:tt0211915", P: 0.97},
		{A: "imdb:tt0211915", B: "tmdb:194", P: 0.6},
		{A: "plex:abc", B: "plex:abc", P: 0.7},
		{A: "netflix:1", B: "netflix:2", P: math.NaN()},
	}
	want := []Component{
		{Nodes: []string{"imdb:tt0133093", "tmdb:603", "tvdb:169", "wikidata:Q83495"}, P: 0.95 * 0.9 * 0.5},
		{Nodes: []string{"imdb:tt0211915", "tmdb:194"}, P: 0.97},
		{Nodes: []string{"plex:abc"}, P: 1},
	}
	got := Propagate(edges, 0.5)
	check(t, got, want)
	r := rand.New(rand.NewPCG(5, 6))
	for range 20 {
		shuffled := make([]Edge, len(edges))
		for i, j := range r.Perm(len(edges)) {
			e := edges[j]
			if r.IntN(2) == 0 {
				e.A, e.B = e.B, e.A
			}
			shuffled[i] = e
		}
		if again := Propagate(shuffled, 0.5); !reflect.DeepEqual(again, got) {
			t.Fatalf("input order changed the result\n%v\n%v", again, got)
		}
	}
	check(t, Propagate(edges, 0.96), []Component{{Nodes: []string{"imdb:tt0211915", "tmdb:194"}, P: 0.97}})
	if out := Propagate(nil, 0.5); len(out) != 0 {
		t.Errorf("no edges gave %v", out)
	}
}

// Checks a chain multiplies every link and nodes sort regardless of where they joined
func TestPropagateChain(t *testing.T) {
	got := Propagate([]Edge{
		{A: "d", B: "c", P: 0.9},
		{A: "c", B: "b", P: 0.8},
		{A: "b", B: "a", P: 0.7},
		{A: "z", B: "y", P: 0.99},
	}, 0.7)
	check(t, got, []Component{
		{Nodes: []string{"a", "b", "c", "d"}, P: 0.9 * 0.8 * 0.7},
		{Nodes: []string{"y", "z"}, P: 0.99},
	})
}

// Compares components with exact node lists and products within rounding
func check(t *testing.T, got, want []Component) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d components %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if !reflect.DeepEqual(got[i].Nodes, want[i].Nodes) || math.Abs(got[i].P-want[i].P) > 1e-12 {
			t.Errorf("component %d is %v, want %v", i, got[i], want[i])
		}
	}
}
