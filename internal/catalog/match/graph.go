package match

import (
	"cmp"
	"slices"
)

// One scored link between two node ids
type Edge struct {
	A, B string
	P    float64
}

// One connected set of node ids with the product of the edge probabilities that joined it
type Component struct {
	Nodes []string
	P     float64
}

// Joins nodes over edges at or above the threshold strongest first, giving sorted components their joining product
func Propagate(edges []Edge, threshold float64) []Component {
	kept := make([]Edge, 0, len(edges))
	for _, e := range edges {
		if e.P >= threshold {
			kept = append(kept, e)
		}
	}
	slices.SortFunc(kept, func(x, y Edge) int {
		xl, xh := ordered(x.A, x.B)
		yl, yh := ordered(y.A, y.B)
		return cmp.Or(cmp.Compare(y.P, x.P), cmp.Compare(xl, yl), cmp.Compare(xh, yh))
	})
	ids := map[string]int{}
	var names []string
	var parent, size []int
	var prob []float64
	node := func(name string) int {
		if i, ok := ids[name]; ok {
			return i
		}
		i := len(names)
		ids[name] = i
		names = append(names, name)
		parent, size, prob = append(parent, i), append(size, 1), append(prob, 1)
		return i
	}
	find := func(i int) int {
		root := i
		for parent[root] != root {
			root = parent[root]
		}
		for parent[i] != root {
			parent[i], i = root, parent[i]
		}
		return root
	}
	for _, e := range kept {
		ra, rb := find(node(e.A)), find(node(e.B))
		if ra == rb {
			continue
		}
		if size[ra] < size[rb] {
			ra, rb = rb, ra
		}
		parent[rb] = ra
		size[ra] += size[rb]
		prob[ra] *= prob[rb] * e.P
	}
	groups := map[int]*Component{}
	var out []*Component
	for i, name := range names {
		root := find(i)
		c, ok := groups[root]
		if !ok {
			c = &Component{P: prob[root]}
			groups[root] = c
			out = append(out, c)
		}
		c.Nodes = append(c.Nodes, name)
	}
	result := make([]Component, 0, len(out))
	for _, c := range out {
		slices.Sort(c.Nodes)
		result = append(result, *c)
	}
	slices.SortFunc(result, func(x, y Component) int { return cmp.Compare(x.Nodes[0], y.Nodes[0]) })
	return result
}

// Returns two node ids lowest first so an edge sorts the same in either direction
func ordered(a, b string) (string, string) {
	if b < a {
		return b, a
	}
	return a, b
}
