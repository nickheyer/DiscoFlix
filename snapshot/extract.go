package snapshot

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"math"
	"slices"
	"strings"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Extraction sizing defaults
const (
	DefaultPageSize = 250_000
	DefaultChunk    = 300
	minPageSize     = 1_000
	bucketItems     = 30_000
	maxTitles       = 1 << 16
)

const (
	directPrefix = "<http://www.wikidata.org/prop/direct/"
	entityIRI    = "<http://www.wikidata.org/entity/"
)

// One crosswalk row with everything the builder writes about it
type Item struct {
	QID           int64
	Kind          string
	Label         string
	OriginalTitle string
	Year          int
	Start         int
	Lang          string
	Langs         []string
	Countries     []string
	Runtime       int
	ParentQID     int64
	Ordinal       int
	XIDs          []XID
	Titles        []Title
}

// One external id of an item
type XID struct {
	Namespace string
	Value     string
}

// One name of an item with its language and where it came from
type Title struct {
	Text string
	Lang string
	Kind string
}

// A finished extraction ready to write
type Dataset struct {
	Index      string
	Items      []*Item
	Skipped    map[string]int
	Collisions map[string]int
	Rows       map[string]int
}

// Pulls the crosswalk out of a Wikidata SPARQL endpoint
type Extractor struct {
	Endpoint Endpoint
	PageSize int
	Limit    int
	Chunk    int
	Log      *slog.Logger
}

// One query shape the pager runs against a scope
type spec struct {
	name  string
	cols  []string
	sel   string
	where string
	group string
}

// What the classification queries learned about one item
type evidence struct {
	movieProp  bool
	seriesProp bool
	film       bool
	series     bool
	season     bool
	episode    bool
	partOf     map[int64]int
	inSeason   map[int64]int
	ordinal    int
}

// Runs the classification queries, picks the items, and fetches their ids, titles, and facts
func (x *Extractor) Extract(ctx context.Context) (*Dataset, error) {
	if x.PageSize <= 0 {
		x.PageSize = DefaultPageSize
	}
	if x.Chunk <= 0 {
		x.Chunk = DefaultChunk
	}
	d := &Dataset{Skipped: map[string]int{}, Collisions: map[string]int{}, Rows: map[string]int{}}
	var err error
	if d.Index, err = x.Endpoint.Index(ctx); err != nil {
		return nil, err
	}
	ev := map[int64]*evidence{}
	if err := x.classify(ctx, d, ev); err != nil {
		return nil, err
	}
	items := kinds(ev)
	if x.Limit > 0 {
		items = limitItems(items, x.Limit)
	}
	if len(items) == 0 {
		return nil, errors.New("snapshot: the classification queries found no items")
	}
	x.Log.Info("classified items", "items", len(items))
	if err := x.attributes(ctx, d, items); err != nil {
		return nil, err
	}
	d.Items = finish(items, d.Collisions)
	return d, nil
}

// Pages through one query, halving the page whenever QLever times out
func (x *Extractor) run(ctx context.Context, d *Dataset, s spec, fn func(row []string)) error {
	limit, offset := x.PageSize, 0
	for {
		body, err := x.Endpoint.Select(ctx, Query{Name: s.name, Select: s.sel, Where: s.where, GroupBy: s.group, Limit: limit, Offset: offset})
		if errors.Is(err, ErrTimeout) && limit > minPageSize {
			limit = max(limit/2, minPageSize)
			x.Log.Warn("qlever timed out, shrinking the page", "query", s.name, "offset", offset, "limit", limit)
			continue
		}
		if err != nil {
			return fmt.Errorf("snapshot: query %s: %w", s.name, err)
		}
		t, err := ParseTSV(body)
		if err != nil {
			return fmt.Errorf("snapshot: query %s: %w", s.name, err)
		}
		if !slices.Equal(t.Vars, s.cols) {
			return fmt.Errorf("snapshot: query %s answered columns %v, want %v", s.name, t.Vars, s.cols)
		}
		for _, row := range t.Rows {
			fn(row)
		}
		d.Rows[s.name] += len(t.Rows)
		x.Log.Info("qlever page", "query", s.name, "offset", offset, "rows", len(t.Rows))
		if len(t.Rows) < limit {
			return nil
		}
		offset += len(t.Rows)
	}
}

func get(ev map[int64]*evidence, qid int64) *evidence {
	e := ev[qid]
	if e == nil {
		e = &evidence{}
		ev[qid] = e
	}
	return e
}

// Runs the kind, class walk, and season and episode queries
func (x *Extractor) classify(ctx context.Context, d *Dataset, ev map[int64]*evidence) error {
	var kindProps []string
	propKind := map[string]string{}
	for _, p := range Properties {
		if p.Kind != "" {
			kindProps = append(kindProps, "wdt:"+p.ID)
			propKind[p.ID] = p.Kind
		}
	}
	err := x.run(ctx, d, spec{
		name: "kinds", cols: []string{"?item", "?p"}, sel: "DISTINCT ?item ?p",
		where: fmt.Sprintf("VALUES ?p { %s }\n?item ?p [] .", strings.Join(kindProps, " ")),
	}, func(row []string) {
		qid, ok := QID(row[0])
		if !ok {
			return
		}
		switch propKind[strings.TrimSuffix(strings.TrimPrefix(row[1], directPrefix), ">")] {
		case model.KindMovie:
			get(ev, qid).movieProp = true
		case model.KindSeries:
			get(ev, qid).seriesProp = true
		}
	})
	if err != nil {
		return err
	}
	film, series := map[int64]bool{}, map[int64]bool{}
	for _, c := range FilmClasses {
		film[mustQID(c)] = true
	}
	for _, c := range SeriesClasses {
		series[mustQID(c)] = true
	}
	err = x.run(ctx, d, spec{
		name: "classes", cols: []string{"?item", "?class"}, sel: "DISTINCT ?item ?class",
		where: fmt.Sprintf("VALUES ?class { %s }\n?item wdt:P345 ?imdb .\nFILTER(STRSTARTS(?imdb, \"tt\"))\n?item wdt:P31/wdt:P279* ?class .",
			wdList(append(slices.Clone(FilmClasses), SeriesClasses...))),
	}, func(row []string) {
		qid, ok := QID(row[0])
		class, ok2 := QID(row[1])
		if !ok || !ok2 {
			return
		}
		switch {
		case film[class]:
			get(ev, qid).film = true
		case series[class]:
			get(ev, qid).series = true
		}
	})
	if err != nil {
		return err
	}
	season, episode := mustQID(ClassSeason), mustQID(ClassEpisode)
	return x.run(ctx, d, spec{
		name: "parts", cols: []string{"?item", "?type", "?series", "?ord", "?season", "?sord", "?dord"},
		sel: "?item ?type ?series ?ord ?season ?sord ?dord",
		where: fmt.Sprintf(`VALUES ?type { wd:%s wd:%s }
?item wdt:P31 ?type .
?item p:P179 ?st .
?st ps:P179 ?series .
OPTIONAL { ?st pq:P1545 ?ord }
OPTIONAL { ?item wdt:P1545 ?dord }
OPTIONAL { ?item p:P4908 ?sst . ?sst ps:P4908 ?season . OPTIONAL { ?sst pq:P1545 ?sord } }`, ClassSeason, ClassEpisode),
	}, func(row []string) {
		qid, ok := QID(row[0])
		typ, ok2 := QID(row[1])
		parent, ok3 := QID(row[2])
		if !ok || !ok2 || !ok3 {
			return
		}
		e := get(ev, qid)
		e.season = e.season || typ == season
		e.episode = e.episode || typ == episode
		if e.partOf == nil {
			e.partOf = map[int64]int{}
		}
		ord, _ := Ordinal(row[3])
		e.partOf[parent] = max(e.partOf[parent], ord)
		if s, ok := QID(row[4]); ok {
			if e.inSeason == nil {
				e.inSeason = map[int64]int{}
			}
			sord, _ := Ordinal(row[5])
			e.inSeason[s] = max(e.inSeason[s], sord)
		}
		if n, ok := Ordinal(row[6]); ok {
			e.ordinal = n
		}
	})
}

func mustQID(id string) int64 {
	qid, ok := QID(entityIRI + id + ">")
	if !ok {
		panic("snapshot: bad class id " + id)
	}
	return qid
}

func wdList(ids []string) string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = "wd:" + id
	}
	return strings.Join(out, " ")
}

// Assigns every item its kind, adds the series that seasons and episodes name, and links parents
func kinds(ev map[int64]*evidence) map[int64]*Item {
	items := map[int64]*Item{}
	for qid, e := range ev {
		kind := ""
		switch {
		case e.season && len(e.partOf) > 0:
			kind = model.KindSeason
		case e.episode && len(e.partOf) > 0:
			kind = model.KindEpisode
		case e.movieProp && e.seriesProp && e.series && !e.film:
			kind = model.KindSeries
		case e.movieProp:
			kind = model.KindMovie
		case e.seriesProp:
			kind = model.KindSeries
		case e.film:
			kind = model.KindMovie
		case e.series:
			kind = model.KindSeries
		}
		if kind != "" {
			items[qid] = &Item{QID: qid, Kind: kind}
		}
	}
	for qid, e := range ev {
		if it := items[qid]; it == nil || (it.Kind != model.KindSeason && it.Kind != model.KindEpisode) {
			continue
		}
		for target := range e.partOf {
			if items[target] == nil {
				items[target] = &Item{QID: target, Kind: model.KindSeries}
			}
		}
	}
	for qid, it := range items {
		e := ev[qid]
		switch it.Kind {
		case model.KindSeason:
			parent, ord := pick(e.partOf, items, model.KindSeries)
			it.ParentQID, it.Ordinal = parent, cmp.Or(ord, e.ordinal)
		case model.KindEpisode:
			parent, ord := pick(e.inSeason, items, model.KindSeason)
			if parent == 0 {
				_, ord = pick(e.partOf, items, model.KindSeries)
			}
			it.ParentQID, it.Ordinal = parent, cmp.Or(ord, e.ordinal)
		}
	}
	return items
}

// Returns the lowest candidate of the wanted kind with the ordinal its statement carried
func pick(candidates map[int64]int, items map[int64]*Item, kind string) (int64, int) {
	for _, qid := range slices.Sorted(maps.Keys(candidates)) {
		if it := items[qid]; it != nil && it.Kind == kind {
			return qid, candidates[qid]
		}
	}
	return 0, 0
}

// Keeps at most n items per kind, preferring seasons with their series and episodes inside kept seasons
func limitItems(items map[int64]*Item, n int) map[int64]*Item {
	byKind := map[string][]*Item{}
	for _, qid := range slices.Sorted(maps.Keys(items)) {
		it := items[qid]
		byKind[it.Kind] = append(byKind[it.Kind], it)
	}
	kept := map[int64]*Item{}
	count := map[string]int{}
	keep := func(it *Item) {
		if kept[it.QID] == nil {
			kept[it.QID] = it
			count[it.Kind]++
		}
	}
	for _, it := range byKind[model.KindMovie][:min(n, len(byKind[model.KindMovie]))] {
		keep(it)
	}
	for _, it := range byKind[model.KindSeason] {
		if count[model.KindSeason] == n {
			break
		}
		if it.ParentQID != 0 {
			keep(it)
			keep(items[it.ParentQID])
		}
	}
	for _, it := range byKind[model.KindSeries] {
		if count[model.KindSeries] >= n {
			break
		}
		keep(it)
	}
	for _, it := range byKind[model.KindEpisode] {
		if count[model.KindEpisode] == n {
			break
		}
		if kept[it.ParentQID] != nil {
			keep(it)
		}
	}
	return kept
}

// Binds ?item to every entity any classification query can match
func fullScope() string {
	parts := []string{"{ ?item wdt:P345 ?imdb . FILTER(STRSTARTS(?imdb, \"tt\")) }"}
	for _, p := range Properties {
		if p.Kind != "" {
			parts = append(parts, "{ ?item wdt:"+p.ID+" [] }")
		}
	}
	for _, c := range []string{ClassSeason, ClassEpisode} {
		parts = append(parts, "{ ?item wdt:P31 wd:"+c+" }", "{ ?part wdt:P31 wd:"+c+" . ?part wdt:P179 ?item }")
	}
	return "{ SELECT DISTINCT ?item WHERE {\n" + strings.Join(parts, "\nUNION ") + "\n} }"
}

// Item bindings the attribute queries run under, one subquery or VALUES chunks for limited runs
func (x *Extractor) scopes(items map[int64]*Item) []string {
	if x.Limit == 0 {
		return []string{fullScope()}
	}
	var out []string
	for chunk := range slices.Chunk(slices.Sorted(maps.Keys(items)), x.Chunk) {
		ids := make([]string, len(chunk))
		for i, qid := range chunk {
			ids[i] = fmt.Sprintf("wd:Q%d", qid)
		}
		out = append(out, "VALUES ?item { "+strings.Join(ids, " ")+" }")
	}
	return out
}

// Fetches ids, labels, aliases, and facts for the kept items
func (x *Extractor) attributes(ctx context.Context, d *Dataset, items map[int64]*Item) error {
	scopes := x.scopes(items)
	for _, scope := range scopes {
		for _, s := range x.scopeSpecs(scope) {
			fn := x.handler(s.name, d, items)
			if err := x.run(ctx, d, s, fn); err != nil {
				return err
			}
		}
	}
	for _, bucket := range languageBuckets(items) {
		codes := make([]string, len(bucket))
		for i, c := range bucket {
			codes[i] = `"` + c + `"`
		}
		for _, scope := range scopes {
			for _, pair := range [][2]string{{"label.original", "rdfs:label"}, {"alias.original", "skos:altLabel"}} {
				s := spec{
					name: pair[0], cols: []string{"?item", "?text"}, sel: "?item ?text",
					where: fmt.Sprintf("{ SELECT DISTINCT ?item ?code WHERE {\n%s\n?item wdt:P364 ?language .\n?language wdt:P218 ?code .\nVALUES ?code { %s }\n} }\n?item %s ?text .\nFILTER(LANG(?text) = ?code)",
						scope, strings.Join(codes, " "), pair[1]),
				}
				if err := x.run(ctx, d, s, x.handler(s.name, d, items)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// Id, title, and fact queries for one scope
func (x *Extractor) scopeSpecs(scope string) []spec {
	var out []spec
	seen := map[string]bool{}
	for _, p := range Properties {
		if seen[p.Namespace] {
			continue
		}
		seen[p.Namespace] = true
		var props []string
		for _, q := range Properties {
			if q.Namespace == p.Namespace {
				props = append(props, "wdt:"+q.ID)
			}
		}
		where := fmt.Sprintf("%s\nVALUES ?p { %s }\n?item ?p ?value .", scope, strings.Join(props, " "))
		if p.Namespace == model.NSIMDb {
			where += "\nFILTER(STRSTARTS(?value, \"tt\"))"
		}
		out = append(out, spec{name: "xid." + p.Namespace, cols: []string{"?item", "?p", "?value"}, sel: "?item ?p ?value", where: where})
	}
	for _, lang := range []string{"en", "mul"} {
		for _, pair := range [][2]string{{"label." + lang, "rdfs:label"}, {"alias." + lang, "skos:altLabel"}} {
			out = append(out, spec{
				name: pair[0], cols: []string{"?item", "?text"}, sel: "?item ?text",
				where: fmt.Sprintf("%s\n?item %s ?text .\nFILTER(LANG(?text) = \"%s\")", scope, pair[1], lang),
			})
		}
	}
	return append(out,
		spec{
			name: "year", cols: []string{"?item", "?year"}, sel: "?item (MIN(?y) AS ?year)", group: "?item",
			where: scope + "\n?item wdt:P577 ?date .\nBIND(YEAR(?date) AS ?y)\nFILTER(?y > 0)",
		},
		spec{
			name: "start", cols: []string{"?item", "?year"}, sel: "?item (MIN(?y) AS ?year)", group: "?item",
			where: scope + "\n?item wdt:P580 ?date .\nBIND(YEAR(?date) AS ?y)\nFILTER(?y > 0)",
		},
		spec{
			name: "runtime", cols: []string{"?item", "?seconds"}, sel: "?item (MIN(?secs) AS ?seconds)", group: "?item",
			where: scope + "\n?item p:P2047/psn:P2047/wikibase:quantityAmount ?secs .\nFILTER(?secs > 0)",
		},
		spec{name: "original", cols: []string{"?item", "?title"}, sel: "?item ?title", where: scope + "\n?item wdt:P1476 ?title ."},
		spec{name: "language", cols: []string{"?item", "?code"}, sel: "?item ?code", where: scope + "\n?item wdt:P364 ?language .\n?language wdt:P218 ?code ."},
		spec{name: "country", cols: []string{"?item", "?code"}, sel: "?item ?code", where: scope + "\n?item wdt:P495 ?country .\n?country wdt:P297 ?code ."},
	)
}

// Row consumer for a query name, dropping rows about items outside the crosswalk
func (x *Extractor) handler(name string, d *Dataset, items map[int64]*Item) func([]string) {
	byID := map[string]Property{}
	for _, p := range Properties {
		byID[p.ID] = p
	}
	return func(row []string) {
		qid, ok := QID(row[0])
		it := items[qid]
		if !ok || it == nil {
			return
		}
		switch {
		case strings.HasPrefix(name, "xid."):
			p, known := byID[strings.TrimSuffix(strings.TrimPrefix(row[1], directPrefix), ">")]
			if !known {
				return
			}
			text, _, ok := Literal(row[2])
			value, formatted := p.Format(text)
			if !ok || !formatted {
				d.Skipped[p.Namespace]++
				return
			}
			it.XIDs = append(it.XIDs, XID{Namespace: p.Namespace, Value: value})
		case strings.HasPrefix(name, "label."), strings.HasPrefix(name, "alias."), name == "original":
			text, lang, ok := Literal(row[1])
			if !ok || lang == "" || strings.TrimSpace(text) == "" {
				return
			}
			kind := TitleLabel
			switch {
			case name == "original":
				kind = TitleOriginal
			case strings.HasPrefix(name, "alias."):
				kind = TitleAlias
			}
			it.Titles = append(it.Titles, Title{Text: text, Lang: lang, Kind: kind})
		case name == "year":
			if y, ok := Number(row[1]); ok && y > 0 {
				it.Year = int(y)
			}
		case name == "start":
			if y, ok := Number(row[1]); ok && y > 0 {
				it.Start = int(y)
			}
		case name == "runtime":
			if secs, ok := Number(row[1]); ok && secs > 0 {
				it.Runtime = max(1, int(math.Round(secs/60)))
			}
		case name == "language":
			if code, _, ok := Literal(row[1]); ok && code != "" {
				it.Langs = append(it.Langs, strings.ToLower(code))
			}
		case name == "country":
			if code, _, ok := Literal(row[1]); ok && code != "" {
				it.Countries = append(it.Countries, strings.ToUpper(code))
			}
		}
	}
}

// Groups original languages other than en and mul so each label query names a bounded item count
func languageBuckets(items map[int64]*Item) [][]string {
	counts := map[string]int{}
	for _, it := range items {
		for _, code := range slices.Compact(slices.Sorted(slices.Values(it.Langs))) {
			if code != "en" && code != "mul" {
				counts[code]++
			}
		}
	}
	codes := slices.SortedFunc(maps.Keys(counts), func(a, b string) int {
		return cmp.Or(cmp.Compare(counts[b], counts[a]), cmp.Compare(a, b))
	})
	var out [][]string
	total := 0
	for _, code := range codes {
		if len(out) == 0 || total+counts[code] > bucketItems {
			out = append(out, nil)
			total = 0
		}
		out[len(out)-1] = append(out[len(out)-1], code)
		total += counts[code]
	}
	return out
}

// Dedupes titles and ids, picks the display fields, and gives every external id to exactly one item
func finish(items map[int64]*Item, collisions map[string]int) []*Item {
	out := slices.SortedFunc(maps.Values(items), func(a, b *Item) int { return cmp.Compare(a.QID, b.QID) })
	owner := map[XID]*Item{}
	for _, it := range out {
		it.Langs = slices.Compact(slices.Sorted(slices.Values(it.Langs)))
		it.Countries = slices.Compact(slices.Sorted(slices.Values(it.Countries)))
		slices.SortFunc(it.Titles, func(a, b Title) int {
			return cmp.Or(cmp.Compare(rankTitle(a.Kind), rankTitle(b.Kind)), cmp.Compare(a.Lang, b.Lang), cmp.Compare(a.Text, b.Text))
		})
		it.Titles = slices.Compact(it.Titles)
		pickNames(it)
		it.Year = cmp.Or(it.Year, it.Start)
		it.XIDs = append(it.XIDs, XID{Namespace: model.NSWikidata, Value: WikidataValue(it.QID)})
		slices.SortFunc(it.XIDs, func(a, b XID) int {
			return cmp.Or(cmp.Compare(a.Namespace, b.Namespace), cmp.Compare(a.Value, b.Value))
		})
		it.XIDs = slices.Compact(it.XIDs)
		for _, x := range it.XIDs {
			prev := owner[x]
			switch {
			case prev == nil:
				owner[x] = it
			case fits(it.Kind, x) && !fits(prev.Kind, x):
				owner[x] = it
				collisions[x.Namespace]++
			default:
				collisions[x.Namespace]++
			}
		}
	}
	for _, it := range out {
		it.XIDs = slices.DeleteFunc(it.XIDs, func(x XID) bool { return owner[x] != it })
	}
	return out
}

func rankTitle(kind string) int {
	switch kind {
	case TitleLabel:
		return 0
	case TitleOriginal:
		return 1
	}
	return 2
}

// Reports whether a kind-qualified value names an entity of the given kind
func fits(kind string, x XID) bool {
	prefix, _ := model.SplitValue(x.Value)
	switch prefix {
	case "movie":
		return kind == model.KindMovie
	case "tv", "series", "show":
		return kind == model.KindSeries
	case "season":
		return kind == model.KindSeason
	case "episode":
		return kind == model.KindEpisode
	}
	return true
}

// Chooses the original language, original title, and display label of an item
func pickNames(it *Item) {
	var originals []Title
	labels := map[string]string{}
	for _, t := range it.Titles {
		switch t.Kind {
		case TitleOriginal:
			originals = append(originals, t)
		case TitleLabel:
			if _, ok := labels[t.Lang]; !ok {
				labels[t.Lang] = t.Text
			}
		}
	}
	for _, t := range originals {
		if slices.Contains(it.Langs, t.Lang) {
			it.Lang, it.OriginalTitle = t.Lang, t.Text
			break
		}
	}
	if it.Lang == "" && len(it.Langs) > 0 {
		it.Lang = it.Langs[0]
	}
	if it.OriginalTitle == "" && len(originals) > 0 {
		it.OriginalTitle = originals[0].Text
	}
	for _, lang := range append([]string{"en", "mul", it.Lang}, it.Langs...) {
		if text, ok := labels[lang]; ok && lang != "" {
			it.Label = text
			return
		}
	}
	it.Label = it.OriginalTitle
}
