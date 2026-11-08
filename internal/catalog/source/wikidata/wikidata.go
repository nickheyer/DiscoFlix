// Reads movies, series, seasons, and episodes from Wikidata over SPARQL
package wikidata

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/language"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
)

const (
	qleverURL = "https://qlever.dev/api/wikidata"
	wdqsURL   = "https://query.wikidata.org/sparql"
	apiURL    = "https://www.wikidata.org/w/api.php"
	license   = "CC0-1.0"
)

var (
	qid    = regexp.MustCompile(`^Q[1-9][0-9]*$`)
	imdbID = regexp.MustCompile(`^tt[0-9]+$`)
	digits = regexp.MustCompile(`^[1-9][0-9]*$`)
)

// Answers catalog lookups and searches from Wikidata
type Source struct {
	client *outbound.Client

	mu   sync.RWMutex
	lang language.Tag
}

// Returns a source that queries Wikidata through the outbound client
func New(client *outbound.Client) *Source {
	return &Source{client: client, lang: language.English}
}

func (s *Source) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.wikidata", Name: "Wikidata", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (s *Source) Name() string { return catalog.SourceWikidata }

func (s *Source) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceWikidata, Title: "Wikidata", Rate: 3, Burst: 3, Timeout: 20 * time.Second, CacheTTL: 24 * time.Hour, License: license}
}

// Lists Wikidata itself and every namespace the property map can look up
func (s *Source) Namespaces() []string {
	out := []string{model.NSWikidata}
	for _, p := range properties {
		if !slices.Contains(out, p.namespace) {
			out = append(out, p.namespace)
		}
	}
	return out
}

func (s *Source) Kinds() []string {
	return []string{model.KindMovie, model.KindSeries, model.KindSeason, model.KindEpisode}
}

func (s *Source) NeedsKey() bool { return false }

func (s *Source) KeyHint() string { return "" }

func (s *Source) License() string { return license }

// Stores the language labels, aliases, and genres are read in
func (s *Source) Configure(_ catalog.Keys, options map[string]string) error {
	lang := language.English
	if raw := strings.TrimSpace(options["language"]); raw != "" {
		tag, err := language.Parse(raw)
		if err != nil {
			return fmt.Errorf("wikidata: language %q: %w", raw, err)
		}
		lang = tag
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lang = lang
	return nil
}

// Lists label languages in preference order and the base language searches use
func (s *Source) languages() (labels []string, base string) {
	s.mu.RLock()
	tag := s.lang
	s.mu.RUnlock()
	b, _ := tag.Base()
	labels = []string{strings.ToLower(tag.String())}
	for _, l := range []string{b.String(), "en", "mul"} {
		if !slices.Contains(labels, l) {
			labels = append(labels, l)
		}
	}
	return labels, b.String()
}

// Names the record a request is about
type provenance struct {
	namespace, value, kind string
}

// Runs a query on QLever and repeats it on the Wikidata Query Service when QLever fails
func (s *Source) sparql(ctx context.Context, query string, p provenance) ([]row, string, error) {
	header := http.Header{"Accept": {"text/tab-separated-values"}}
	params := url.Values{"query": {query}}.Encode()
	res, err := s.client.Do(ctx, catalog.SourceWikidata, outbound.Request{URL: qleverURL + "?" + params, Header: header, Namespace: p.namespace, ExtValue: p.value, Kind: p.kind})
	if err != nil && ctx.Err() == nil && !errors.Is(err, outbound.ErrOpen) && !errors.Is(err, outbound.ErrBudget) {
		res, err = s.client.Do(ctx, catalog.SourceWikidata, outbound.Request{URL: wdqsURL + "?" + params, Header: header, Namespace: p.namespace, ExtValue: p.value, Kind: p.kind})
	}
	if err != nil {
		return nil, "", err
	}
	rows, err := parseTSV(res.Body)
	if err != nil {
		return nil, "", err
	}
	return rows, res.RecordID, nil
}

// Finds the items carrying an id through the property map and reads those of the requested kind
func (s *Source) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	if !model.ValidKind(kind) {
		return nil, fmt.Errorf("wikidata: unknown kind %q", kind)
	}
	p := provenance{namespace, id, kind}
	ids := []string{id}
	if namespace == model.NSWikidata {
		if !qid.MatchString(id) {
			return nil, fmt.Errorf("wikidata: %q is not an item id like Q83495", id)
		}
	} else {
		pattern, err := binding(kind, namespace, id)
		if err != nil || pattern == "" {
			return nil, err
		}
		rows, _, err := s.sparql(ctx, resolveQuery(pattern), p)
		if err != nil {
			return nil, err
		}
		ids = ids[:0]
		for _, r := range rows {
			if q := entityID(r["item"].value); q != "" && !slices.Contains(ids, q) {
				ids = append(ids, q)
			}
		}
	}
	langs, _ := s.languages()
	items, rec, err := s.items(ctx, ids, langs, p)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	for _, it := range items {
		if it.kind() == kind {
			it.claims(rec[it.id], langs, &out)
		}
	}
	return out, nil
}

// Caps how many items one facts query lists so its URL stays within endpoint limits
const batch = 10

// Reads the facts of every listed item in batches, returning them in list order with their record ids
func (s *Source) items(ctx context.Context, ids, langs []string, p provenance) ([]*item, map[string]string, error) {
	byID := map[string]*item{}
	records := map[string]string{}
	for chunk := range slices.Chunk(ids, batch) {
		rows, rec, err := s.sparql(ctx, itemQuery(chunk, langs), p)
		if err != nil {
			return nil, nil, err
		}
		for _, it := range collect(rows) {
			byID[it.id] = it
			records[it.id] = rec
		}
	}
	out := make([]*item, 0, len(ids))
	for _, id := range ids {
		if it := byID[id]; it != nil {
			out = append(out, it)
		}
	}
	return out, records, nil
}

// Builds the pattern that binds ?item to the items an id names, empty when the id names another kind
func binding(kind, namespace, id string) (string, error) {
	switch namespace {
	case model.NSIMDb:
		if !imdbID.MatchString(id) {
			return "", fmt.Errorf("wikidata: %q is not an imdb id like tt0133093", id)
		}
		return "?item wdt:P345 " + literal(id) + " .\n", nil
	case model.NSTMDB:
		return tmdbBinding(kind, id)
	case model.NSTVDB:
		prefix, rest := model.SplitValue(id)
		named := map[string]string{"movie": model.KindMovie, "series": model.KindSeries, "season": model.KindSeason, "episode": model.KindEpisode}[prefix]
		if named == "" || !digits.MatchString(rest) {
			return "", fmt.Errorf("wikidata: %q is not a tvdb id like series/81189", id)
		}
		if named != kind {
			return "", nil
		}
		prop := map[string]string{model.KindMovie: "P12196", model.KindSeries: "P4835", model.KindSeason: "P12397", model.KindEpisode: "P7043"}[kind]
		return "?item wdt:" + prop + " " + literal(rest) + " .\n", nil
	case model.NSTrakt:
		prefix, rest := model.SplitValue(id)
		named := map[string]string{"movie": model.KindMovie, "show": model.KindSeries, "season": model.KindSeason, "episode": model.KindEpisode}[prefix]
		if named == "" || rest == "" {
			return "", fmt.Errorf("wikidata: %q is not a trakt id like movie/the-matrix-1999", id)
		}
		switch {
		case named != kind:
			return "", nil
		case kind == model.KindMovie && digits.MatchString(rest):
			return "?item wdt:P12492 " + literal(rest) + " .\n", nil
		case kind == model.KindMovie:
			return "?item wdt:P8013 " + literal("movies/"+rest) + " .\n", nil
		case kind == model.KindSeries:
			return "?item wdt:P8013 " + literal("shows/"+rest) + " .\n", nil
		}
		return "", fmt.Errorf("%w: wikidata stores trakt seasons and episodes as show paths, not numeric ids", catalog.ErrUnsupported)
	}
	for _, p := range properties {
		if p.namespace == namespace && p.prefix == "" {
			if strings.TrimSpace(id) == "" {
				return "", fmt.Errorf("wikidata: empty %s id", namespace)
			}
			return "?item wdt:" + p.id + " " + literal(id) + " .\n", nil
		}
	}
	return "", fmt.Errorf("%w: wikidata has no property for %s ids", catalog.ErrUnsupported, namespace)
}

// Binds a tmdb movie or series directly and a season or episode through its series and ordinals
func tmdbBinding(kind, id string) (string, error) {
	parts := strings.Split(id, "/")
	nums := make([]int, 0, len(parts)-1)
	for _, p := range parts[1:] {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return "", fmt.Errorf("wikidata: %q is not a tmdb id like movie/603 or tv/1396/1/2", id)
		}
		nums = append(nums, n)
	}
	named := ""
	switch {
	case parts[0] == "movie" && len(nums) == 1 && nums[0] > 0:
		named = model.KindMovie
	case parts[0] == "tv" && len(nums) >= 1 && len(nums) <= 3 && nums[0] > 0:
		named = []string{model.KindSeries, model.KindSeason, model.KindEpisode}[len(nums)-1]
	default:
		return "", fmt.Errorf("wikidata: %q is not a tmdb id like movie/603 or tv/1396/1/2", id)
	}
	if named != kind {
		return "", nil
	}
	series := literal(strconv.Itoa(nums[0]))
	switch kind {
	case model.KindMovie:
		return "?item wdt:P4947 " + series + " .\n", nil
	case model.KindSeries:
		return "?item wdt:P4983 " + series + " .\n", nil
	}
	season := func(v string) string {
		return "?bSeries wdt:P4983 " + series + " .\n" +
			v + " p:P179 ?bSeasonStatement .\n?bSeasonStatement ps:P179 ?bSeries ; pq:P1545 " + literal(strconv.Itoa(nums[1])) + " .\n" +
			v + " wdt:P31/wdt:P279* wd:" + classSeason + " .\n"
	}
	if kind == model.KindSeason {
		return season("?item"), nil
	}
	return season("?bSeason") + "?item p:P4908 ?bEpisodeStatement .\n?bEpisodeStatement ps:P4908 ?bSeason ; pq:P1545 " + literal(strconv.Itoa(nums[2])) + " .\n", nil
}

// Finds items by label or alias, keeping films and series of the requested kind and year
func (s *Source) Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error) {
	switch kind {
	case "", model.KindMovie, model.KindSeries:
	default:
		return nil, fmt.Errorf("%w: wikidata searches movies and series, not %s", catalog.ErrUnsupported, kind)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	langs, base := s.languages()
	params := url.Values{"action": {"wbsearchentities"}, "search": {text}, "language": {base}, "type": {"item"}, "limit": {"10"}, "format": {"json"}}
	var found struct {
		Search []struct {
			ID string `json:"id"`
		} `json:"search"`
	}
	p := provenance{namespace: model.NSWikidata, kind: kind}
	if _, err := s.client.GetJSON(ctx, catalog.SourceWikidata, outbound.Request{URL: apiURL + "?" + params.Encode(), Header: http.Header{"Accept": {"application/json"}}, Namespace: p.namespace, Kind: p.kind}, &found); err != nil {
		return nil, err
	}
	var ids []string
	for _, f := range found.Search {
		if qid.MatchString(f.ID) && !slices.Contains(ids, f.ID) {
			ids = append(ids, f.ID)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	items, rec, err := s.items(ctx, ids, langs, p)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	for _, it := range items {
		k := it.kind()
		if (k != model.KindMovie && k != model.KindSeries) || (kind != "" && k != kind) || (year > 0 && !it.releasedIn(year)) {
			continue
		}
		it.claims(rec[it.id], langs, &out)
	}
	return out, nil
}
