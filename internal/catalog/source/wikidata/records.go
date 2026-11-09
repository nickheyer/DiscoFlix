package wikidata

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Item classes the kind walk starts from
const (
	classFilm       = "Q11424"
	classSeries     = "Q5398426"
	classMiniseries = "Q1259759"
	classSeason     = "Q3464665"
	classEpisode    = "Q21191270"
	entityBase      = "http://www.wikidata.org/entity/"
)

// Classes a film or a series item is an instance of, used to narrow full text search
var (
	movieClasses  = []string{classFilm, "Q24862", "Q202866", "Q506240", "Q93204"}
	seriesClasses = []string{classSeries, "Q15416", classMiniseries, "Q581714"}
)

// Maps one external id property to a catalog namespace and the prefix its values take
type property struct {
	id, namespace, prefix string
}

var properties = []property{
	{"P345", model.NSIMDb, ""},
	{"P4947", model.NSTMDB, "movie/"},
	{"P4983", model.NSTMDB, "tv/"},
	{"P4835", model.NSTVDB, "series/"},
	{"P12196", model.NSTVDB, "movie/"},
	{"P12397", model.NSTVDB, "season/"},
	{"P7043", model.NSTVDB, "episode/"},
	{"P8013", model.NSTrakt, ""},
	{"P12492", model.NSTrakt, "movie/"},
	{"P6127", model.NSLetterboxd, ""},
	{"P8600", model.NSTVmaze, ""},
	{"P1874", model.NSNetflix, ""},
	{"P1258", model.NSRottenTomatoes, ""},
	{"P1712", model.NSMetacritic, ""},
	{"P5646", model.NSAniDB, ""},
	{"P8729", model.NSAniList, ""},
	{"P4086", model.NSMAL, ""},
	{"P4529", model.NSDouban, ""},
	{"P2603", model.NSKinopoisk, ""},
	{"P9586", model.NSAppleTV, ""},
	{"P11460", model.NSPlex, ""},
}

// Formats a stored property value as the catalog id, empty when it is not one
func (p property) value(v string) string {
	switch {
	case p.namespace == model.NSIMDb:
		if imdbID.MatchString(v) {
			return v
		}
		return ""
	case p.id == "P8013":
		kind, slug, _ := strings.Cut(v, "/")
		if slug == "" || strings.Contains(slug, "/") {
			return ""
		}
		switch kind {
		case "movies":
			return model.TraktValue(model.KindMovie, slug)
		case "shows":
			return model.TraktValue(model.KindSeries, slug)
		}
		return ""
	case p.prefix != "":
		if digits.MatchString(v) {
			return p.prefix + v
		}
		return ""
	}
	return v
}

const prefixes = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX psv: <http://www.wikidata.org/prop/statement/value/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX wikibase: <http://wikiba.se/ontology#>
`

// Quotes a string as a SPARQL literal
func literal(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(s) + `"`
}

// Selects every fact the claims need about the listed items as one row per item, key, value, and qualifier
func itemQuery(ids []string, langs []string) string {
	tests := make([]string, 0, len(langs))
	for _, l := range langs {
		tests = append(tests, "LANG(?v) = "+literal(l))
	}
	filter := "FILTER(" + strings.Join(tests, " || ") + ")"
	direct := []string{`("P1476" wdt:P1476)`, `("date" wdt:P577)`, `("date" wdt:P580)`}
	for _, p := range properties {
		direct = append(direct, `("`+p.id+`" wdt:`+p.id+`)`)
	}
	branches := []string{
		`VALUES ?v { wd:` + classFilm + ` wd:` + classSeries + ` wd:` + classMiniseries + ` wd:` + classSeason + ` wd:` + classEpisode + ` } ?item wdt:P31/wdt:P279* ?v . BIND("class" AS ?k)`,
		`?item rdfs:label ?v . ` + filter + ` BIND("label" AS ?k)`,
		`?item skos:altLabel ?v . ` + filter + ` BIND("alias" AS ?k)`,
		`VALUES (?k ?p) { ` + strings.Join(direct, " ") + ` } ?item ?p ?v .`,
		`?item wdt:P364/wdt:P218 ?v . BIND("P364" AS ?k)`,
		`?item wdt:P495/wdt:P297 ?v . BIND("P495" AS ?k)`,
		`?item p:P2047/psv:P2047 ?n . ?n wikibase:quantityAmount ?v ; wikibase:quantityUnit ?q . BIND("P2047" AS ?k)`,
		`?item wdt:P136 ?q . ?q rdfs:label ?v . ` + filter + ` BIND("P136" AS ?k)`,
		`?item p:P179 ?st . ?st ps:P179 ?v . OPTIONAL { ?st pq:P1545 ?q } BIND("P179" AS ?k)`,
		`?item p:P4908 ?st . ?st ps:P4908 ?v . OPTIONAL { ?st pq:P1545 ?q } BIND("P4908" AS ?k)`,
		`?item p:P179 ?st . ?st ps:P179 ?s ; pq:P1545 ?n . ?s wdt:P4983 ?t . BIND(CONCAT(?t, "/", ?n) AS ?v) BIND("tmdbSeason" AS ?k)`,
		`?item p:P4908 ?st . ?st ps:P4908 ?s ; pq:P1545 ?n . ?s p:P179 ?ss . ?ss ps:P179 ?r ; pq:P1545 ?m . ?r wdt:P4983 ?t . BIND(CONCAT(?t, "/", ?m, "/", ?n) AS ?v) BIND("tmdbEpisode" AS ?k)`,
	}
	values := "VALUES ?item { wd:" + strings.Join(ids, " wd:") + " } "
	return prefixes + "SELECT ?item ?k ?v ?q WHERE {\n{ " + values + strings.Join(branches, " }\nUNION { "+values) + " }\n}\n"
}

// Selects the items a binding pattern names
func resolveQuery(pattern string) string {
	return prefixes + "SELECT DISTINCT ?item WHERE {\n" + pattern + "}\n"
}

// Holds one RDF value from a TSV result, an IRI or a literal with its language tag
type term struct {
	value, lang string
}

type row map[string]term

var errTSV = errors.New("wikidata: malformed sparql tsv answer")

// Reads a SPARQL TSV answer into rows keyed by variable name
func parseTSV(body []byte) ([]row, error) {
	lines := strings.Split(strings.TrimRight(string(body), "\r\n"), "\n")
	if lines[0] == "" {
		return nil, fmt.Errorf("%w: no header", errTSV)
	}
	header := strings.Split(strings.TrimRight(lines[0], "\r"), "\t")
	for i, h := range header {
		header[i] = strings.TrimPrefix(h, "?")
	}
	out := make([]row, 0, len(lines)-1)
	for _, line := range lines[1:] {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != len(header) {
			return nil, fmt.Errorf("%w: %d fields under %d columns", errTSV, len(fields), len(header))
		}
		r := row{}
		for i, f := range fields {
			if f == "" {
				continue
			}
			t, err := parseTerm(f)
			if err != nil {
				return nil, err
			}
			r[header[i]] = t
		}
		out = append(out, r)
	}
	return out, nil
}

// Decodes an IRI, a quoted literal with escapes and tag, or a bare number
func parseTerm(f string) (term, error) {
	if strings.HasPrefix(f, "<") && strings.HasSuffix(f, ">") {
		return term{value: f[1 : len(f)-1]}, nil
	}
	if !strings.HasPrefix(f, `"`) {
		return term{value: f}, nil
	}
	var b strings.Builder
	i := 1
	for ; i < len(f) && f[i] != '"'; i++ {
		if f[i] != '\\' {
			b.WriteByte(f[i])
			continue
		}
		i++
		if i >= len(f) {
			return term{}, fmt.Errorf("%w: dangling escape in %s", errTSV, f)
		}
		switch f[i] {
		case 't':
			b.WriteByte('\t')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case '"', '\'', '\\':
			b.WriteByte(f[i])
		case 'u', 'U':
			width := 4
			if f[i] == 'U' {
				width = 8
			}
			if i+width >= len(f) {
				return term{}, fmt.Errorf("%w: short unicode escape in %s", errTSV, f)
			}
			n, err := strconv.ParseUint(f[i+1:i+1+width], 16, 32)
			if err != nil || !utf8.ValidRune(rune(n)) {
				return term{}, fmt.Errorf("%w: bad unicode escape in %s", errTSV, f)
			}
			b.WriteRune(rune(n))
			i += width
		default:
			return term{}, fmt.Errorf("%w: unknown escape in %s", errTSV, f)
		}
	}
	if i >= len(f) {
		return term{}, fmt.Errorf("%w: unterminated literal %s", errTSV, f)
	}
	t := term{value: b.String()}
	if tag, ok := strings.CutPrefix(f[i+1:], "@"); ok {
		t.lang = strings.ToLower(tag)
	}
	return t, nil
}

// Reads the item id of an entity IRI, empty for anything else
func entityID(iri string) string {
	if id, ok := strings.CutPrefix(iri, entityBase); ok && qid.MatchString(id) {
		return id
	}
	return ""
}

// Holds one statement linking a season or episode to what it belongs to
type parent struct {
	item, ordinal string
}

// Gathers the facts the query returned about one Wikidata item
type item struct {
	id        string
	classes   map[string]bool
	labels    map[string]string
	aliases   []term
	originals []string
	dates     []string
	languages []string
	countries []string
	runtimes  []int
	genres    map[string]map[string]string
	xids      map[[2]string]bool
	parents   map[string][]parent
	derived   map[string][]string
}

// Groups result rows by item in first-seen order
func collect(rows []row) []*item {
	byID := map[string]*item{}
	var order []*item
	for _, r := range rows {
		id := entityID(r["item"].value)
		if id == "" {
			continue
		}
		it := byID[id]
		if it == nil {
			it = &item{id: id, classes: map[string]bool{}, labels: map[string]string{}, genres: map[string]map[string]string{}, xids: map[[2]string]bool{}, parents: map[string][]parent{}, derived: map[string][]string{}}
			byID[id] = it
			order = append(order, it)
		}
		it.add(r["k"].value, r["v"], r["q"])
	}
	return order
}

// Files one row's value under the fact its key names
func (it *item) add(key string, v, q term) {
	switch key {
	case "class":
		it.classes[entityID(v.value)] = true
	case "label":
		if _, ok := it.labels[v.lang]; !ok && v.value != "" {
			it.labels[v.lang] = v.value
		}
	case "alias":
		it.aliases = append(it.aliases, v)
	case "P1476":
		it.originals = append(it.originals, v.value)
	case "date":
		it.dates = append(it.dates, v.value)
	case "P364":
		it.languages = append(it.languages, strings.ToLower(v.value))
	case "P495":
		it.countries = append(it.countries, strings.ToUpper(v.value))
	case "P2047":
		if m := minutes(v.value, q.value); m > 0 {
			it.runtimes = append(it.runtimes, m)
		}
	case "P136":
		genre := entityID(q.value)
		if genre == "" {
			return
		}
		if it.genres[genre] == nil {
			it.genres[genre] = map[string]string{}
		}
		it.genres[genre][v.lang] = v.value
	case "P179", "P4908":
		if id := entityID(v.value); id != "" {
			it.parents[key] = append(it.parents[key], parent{item: id, ordinal: q.value})
		}
	case "tmdbSeason", "tmdbEpisode":
		it.derived[key] = append(it.derived[key], v.value)
	default:
		for _, p := range properties {
			if p.id == key {
				if x := p.value(v.value); x != "" {
					it.xids[[2]string{p.namespace, x}] = true
				}
			}
		}
	}
}

// Converts a duration amount in minutes, seconds, or hours to whole minutes, zero for other units
func minutes(amount, unit string) int {
	n, err := strconv.ParseFloat(amount, 64)
	if err != nil || n <= 0 {
		return 0
	}
	switch entityID(unit) {
	case "Q7727":
		return int(math.Round(n))
	case "Q11574":
		return int(math.Round(n / 60))
	case "Q25235":
		return int(math.Round(n * 60))
	}
	return 0
}

// Reads the catalog kind from the matched classes, the most specific first
func (it *item) kind() string {
	switch {
	case it.classes[classEpisode]:
		return model.KindEpisode
	case it.classes[classSeason]:
		return model.KindSeason
	case it.classes[classSeries], it.classes[classMiniseries]:
		return model.KindSeries
	case it.classes[classFilm]:
		return model.KindMovie
	}
	return ""
}

// Lists the years of every publication and start date
func (it *item) years() []int {
	var out []int
	for _, d := range it.dates {
		d = strings.TrimPrefix(d, "+")
		head, _, _ := strings.Cut(d, "-")
		if y, err := strconv.Atoi(head); err == nil && y > 0 && len(head) >= 4 {
			out = append(out, y)
		}
	}
	return out
}

// Reports whether any publication or start date falls in a year
func (it *item) releasedIn(year int) bool {
	return slices.Contains(it.years(), year)
}

// Picks the label in the most preferred language that has one
func label(labels map[string]string, langs []string) string {
	for _, l := range langs {
		if v := labels[l]; v != "" {
			return v
		}
	}
	return ""
}

// Lists alternative labels and other-language labels once each, leaving out claimed titles
func (it *item) aliasList(langs []string, claimed ...string) []string {
	var out []string
	add := func(v string) {
		if v != "" && !slices.Contains(claimed, v) && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	for _, l := range langs {
		add(it.labels[l])
	}
	for _, a := range it.aliases {
		if slices.Contains(langs, a.lang) {
			add(a.value)
		}
	}
	slices.Sort(out)
	return out
}

// Names each genre in the most preferred language that labels it
func (it *item) genreLabels(langs []string) []string {
	keys := make([]string, 0, len(it.genres))
	for g := range it.genres {
		keys = append(keys, g)
	}
	slices.Sort(keys)
	var out []string
	for _, g := range keys {
		if name := label(it.genres[g], langs); name != "" && !slices.Contains(out, name) {
			out = append(out, name)
		}
	}
	return out
}

// Formats a derived series, season, and episode number path as a tmdb season or episode id
func tmdbChild(path string) string {
	parts := strings.Split(path, "/")
	nums := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return ""
		}
		nums = append(nums, n)
	}
	switch {
	case len(nums) == 2 && nums[0] > 0:
		return model.TMDBSeason(int64(nums[0]), nums[1])
	case len(nums) == 3 && nums[0] > 0:
		return model.TMDBEpisode(int64(nums[0]), nums[1], nums[2])
	}
	return ""
}

// Picks the statement with a numeric ordinal, the lowest item id first
func (it *item) parentOf(key string) (parent, int, bool) {
	list := slices.Clone(it.parents[key])
	slices.SortFunc(list, func(a, b parent) int { return strings.Compare(a.item, b.item) })
	for _, p := range list {
		if n, err := strconv.Atoi(p.ordinal); err == nil && n >= 0 {
			return p, n, true
		}
	}
	if len(list) > 0 {
		return list[0], 0, false
	}
	return parent{}, 0, false
}

// Appends one group for the item with every fact the query found
func (it *item) claims(recordID string, langs []string, out *[]model.Claim) {
	kind := it.kind()
	put := func(field string, value any) {
		*out = append(*out, model.Claim{Kind: kind, Namespace: model.NSWikidata, ExternalID: it.id, Field: field, Value: value, RecordID: recordID})
	}
	title := label(it.labels, langs)
	if title != "" {
		put(model.FieldTitle, title)
	}
	original := ""
	if len(it.originals) > 0 {
		original = slices.Min(it.originals)
		put(model.FieldOriginalTitle, original)
	}
	if years := it.years(); len(years) > 0 {
		put(model.FieldYear, slices.Min(years))
	}
	if len(it.languages) > 0 {
		put(model.FieldLanguage, slices.Min(it.languages))
	}
	if len(it.countries) > 0 {
		countries := slices.Compact(slices.Sorted(slices.Values(it.countries)))
		put(model.FieldCountries, countries)
	}
	if len(it.runtimes) > 0 {
		put(model.FieldRuntime, slices.Min(it.runtimes))
	}
	if g := it.genreLabels(langs); len(g) > 0 {
		put(model.FieldGenres, g)
	}
	if a := it.aliasList(langs, title, original); len(a) > 0 {
		put(model.FieldAliases, a)
	}
	for _, v := range it.derived[map[string]string{model.KindSeason: "tmdbSeason", model.KindEpisode: "tmdbEpisode"}[kind]] {
		if id := tmdbChild(v); id != "" {
			it.xids[[2]string{model.NSTMDB, id}] = true
		}
	}
	xids := make([][2]string, 0, len(it.xids))
	for x := range it.xids {
		xids = append(xids, x)
	}
	slices.SortFunc(xids, func(a, b [2]string) int { return strings.Compare(a[0]+" "+a[1], b[0]+" "+b[1]) })
	for _, x := range xids {
		put(model.XIDField(x[0]), x[1])
	}
	key := map[string]string{model.KindSeason: "P179", model.KindEpisode: "P4908"}[kind]
	if key == "" {
		return
	}
	if p, n, ok := it.parentOf(key); p.item != "" {
		put(model.ParentXIDField(model.NSWikidata), p.item)
		if ok {
			put(model.FieldOrdinal, n)
		}
	}
}
