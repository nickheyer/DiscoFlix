// Reads movies, shows, seasons, and episodes from the Trakt v2 API
package trakt

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
	apiBase = "https://api.trakt.tv"
	license = "Trakt API terms"
)

// Fails every call made before a client id is configured
var ErrNoKey = errors.New("trakt: no client id configured, create an application at https://trakt.tv/oauth/applications")

var imdbID = regexp.MustCompile(`^tt[0-9]+$`)

// Answers catalog lookups and searches from Trakt
type Source struct {
	client *outbound.Client

	mu       sync.RWMutex
	clientID string
	lang     language.Tag
}

// Returns a source that calls Trakt through the outbound client
func New(client *outbound.Client) *Source {
	return &Source{client: client, lang: language.English}
}

func (s *Source) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.trakt", Name: "Trakt", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (s *Source) Name() string { return catalog.SourceTrakt }

func (s *Source) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceTrakt, Title: "Trakt", Rate: 2, Burst: 4, Timeout: 20 * time.Second, CacheTTL: 24 * time.Hour, License: license}
}

func (s *Source) Namespaces() []string {
	return []string{model.NSTrakt, model.NSIMDb, model.NSTMDB, model.NSTVDB}
}

func (s *Source) Kinds() []string {
	return []string{model.KindMovie, model.KindSeries, model.KindSeason, model.KindEpisode}
}

func (s *Source) NeedsKey() bool { return true }

func (s *Source) KeyHint() string { return "https://trakt.tv/oauth/applications (client id)" }

func (s *Source) License() string { return license }

// Stores the client id and the language titles and overviews are translated into
func (s *Source) Configure(keys catalog.Keys, options map[string]string) error {
	lang := language.English
	if raw := strings.TrimSpace(options["language"]); raw != "" {
		tag, err := language.Parse(raw)
		if err != nil {
			return fmt.Errorf("trakt: language %q: %w", raw, err)
		}
		lang = tag
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clientID = strings.TrimSpace(keys.APIKey)
	s.lang = lang
	return nil
}

// Holds the client id and translation language one call runs with
type settings struct {
	clientID, lang, country string
}

// Snapshots the configuration, failing when no client id is set
func (s *Source) settings() (settings, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.clientID == "" {
		return settings{}, ErrNoKey
	}
	base, _ := s.lang.Base()
	cfg := settings{clientID: s.clientID, lang: base.String()}
	if region, conf := s.lang.Region(); conf == language.Exact {
		cfg.country = strings.ToLower(region.String())
	}
	return cfg, nil
}

// Reports whether titles need a translation the record says it has
func (c settings) translates(available []string) bool {
	return c.lang != "en" && slices.Contains(available, c.lang)
}

// Names the record a request is about
type provenance struct {
	namespace, value, kind string
}

// Fetches one API path with the Trakt headers and returns the record id
func (s *Source) get(ctx context.Context, cfg settings, path string, query url.Values, p provenance, out any) (string, error) {
	u := apiBase + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	header := http.Header{"Content-Type": {"application/json"}, "Trakt-Api-Version": {"2"}, "Trakt-Api-Key": {cfg.clientID}}
	res, err := s.client.GetJSON(ctx, catalog.SourceTrakt, outbound.Request{URL: u, Header: header, Namespace: p.namespace, ExtValue: p.value, Kind: p.kind}, out)
	if err != nil {
		return "", err
	}
	return res.RecordID, nil
}

// Reports whether Trakt answered that the requested record does not exist
func missing(err error) bool {
	se, ok := errors.AsType[*outbound.StatusError](err)
	return ok && se.Status == http.StatusNotFound
}

// Reads one record by trakt id or slug, or by imdb, tmdb, or tvdb id through the id search
func (s *Source) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	cfg, err := s.settings()
	if err != nil {
		return nil, err
	}
	if !model.ValidKind(kind) {
		return nil, fmt.Errorf("trakt: unknown kind %q", kind)
	}
	p := provenance{namespace, id, kind}
	switch namespace {
	case model.NSTrakt:
		return s.byTrakt(ctx, cfg, kind, id, p)
	case model.NSIMDb:
		if !imdbID.MatchString(id) {
			return nil, fmt.Errorf("trakt: %q is not an imdb id like tt0133093", id)
		}
		return s.byForeign(ctx, cfg, kind, "imdb", id, p)
	case model.NSTVDB:
		prefix, rest := model.SplitValue(id)
		named := map[string]string{"movie": model.KindMovie, "series": model.KindSeries, "season": model.KindSeason, "episode": model.KindEpisode}[prefix]
		if n, perr := strconv.ParseInt(rest, 10, 64); perr != nil || n <= 0 || named == "" {
			return nil, fmt.Errorf("trakt: %q is not a tvdb id like series/81189", id)
		}
		if named != kind {
			return nil, nil
		}
		return s.byForeign(ctx, cfg, kind, "tvdb", rest, p)
	case model.NSTMDB:
		return s.byTMDB(ctx, cfg, kind, id, p)
	}
	return nil, fmt.Errorf("%w: trakt has no lookup by %s ids", catalog.ErrUnsupported, namespace)
}

// Explains why a season cannot be found by an id on its own
var errSeasonID = fmt.Errorf("%w: trakt finds seasons through their show, look the season up by its tmdb id", catalog.ErrUnsupported)

// Reads a movie or show by id or slug and an episode through the trakt id search
func (s *Source) byTrakt(ctx context.Context, cfg settings, kind, id string, p provenance) ([]model.Claim, error) {
	prefix, rest := model.SplitValue(id)
	numeric := false
	if n, err := strconv.ParseInt(rest, 10, 64); err == nil && n > 0 {
		numeric = true
	}
	named := ""
	switch {
	case prefix == "movie" && rest != "":
		named = model.KindMovie
	case prefix == "show" && rest != "":
		named = model.KindSeries
	case prefix == "season" && numeric:
		named = model.KindSeason
	case prefix == "episode" && numeric:
		named = model.KindEpisode
	default:
		return nil, fmt.Errorf("trakt: %q is not an id like movie/the-matrix-1999 or episode/73482", id)
	}
	if named != kind {
		return nil, nil
	}
	switch kind {
	case model.KindMovie:
		var m movie
		rec, err := s.get(ctx, cfg, "/movies/"+url.PathEscape(rest), url.Values{"extended": {"full"}}, p, &m)
		if missing(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return s.movieClaims(ctx, cfg, &m, rec)
	case model.KindSeries:
		var sh show
		rec, err := s.get(ctx, cfg, "/shows/"+url.PathEscape(rest), url.Values{"extended": {"full"}}, p, &sh)
		if missing(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return s.showClaims(ctx, cfg, &sh, rec)
	case model.KindSeason:
		return nil, errSeasonID
	}
	return s.byForeign(ctx, cfg, kind, "trakt", rest, p)
}

// Maps catalog kinds to the types the id search accepts
var searchTypes = map[string]string{model.KindMovie: "movie", model.KindSeries: "show", model.KindEpisode: "episode"}

// Runs the id search for one type and returns its hits
func (s *Source) idSearch(ctx context.Context, cfg settings, idType, raw, kind string, p provenance) ([]hit, string, error) {
	var hits []hit
	rec, err := s.get(ctx, cfg, "/search/"+idType+"/"+url.PathEscape(raw), url.Values{"type": {searchTypes[kind]}, "extended": {"full"}}, p, &hits)
	if missing(err) {
		return nil, "", nil
	}
	return hits, rec, err
}

// Resolves a foreign id to a movie, show, or episode and reads it
func (s *Source) byForeign(ctx context.Context, cfg settings, kind, idType, raw string, p provenance) ([]model.Claim, error) {
	if kind == model.KindSeason {
		return nil, errSeasonID
	}
	hits, rec, err := s.idSearch(ctx, cfg, idType, raw, kind, p)
	if err != nil {
		return nil, err
	}
	for i := range hits {
		h := &hits[i]
		switch {
		case kind == model.KindMovie && h.Movie != nil:
			return s.movieClaims(ctx, cfg, h.Movie, rec)
		case kind == model.KindSeries && h.Show != nil:
			return s.showClaims(ctx, cfg, h.Show, rec)
		case kind == model.KindEpisode && h.Show != nil && h.Episode != nil:
			return s.episodeOf(ctx, cfg, h.Show, h.Episode.Season, func(e *episode) bool { return e.IDs.Trakt == h.Episode.IDs.Trakt })
		}
	}
	return nil, nil
}

// Reads a movie or show by tmdb id and a season or episode by its numbers within the show
func (s *Source) byTMDB(ctx context.Context, cfg settings, kind, value string, p provenance) ([]model.Claim, error) {
	parts := strings.Split(value, "/")
	nums := make([]int, 0, len(parts)-1)
	for _, part := range parts[1:] {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("trakt: %q is not a tmdb id like movie/603 or tv/1396/1/2", value)
		}
		nums = append(nums, n)
	}
	named := ""
	switch {
	case parts[0] == "movie" && len(nums) == 1:
		named = model.KindMovie
	case parts[0] == "tv" && len(nums) == 1:
		named = model.KindSeries
	case parts[0] == "tv" && len(nums) == 2:
		named = model.KindSeason
	case parts[0] == "tv" && len(nums) == 3:
		named = model.KindEpisode
	default:
		return nil, fmt.Errorf("trakt: %q is not a tmdb id like movie/603 or tv/1396/1/2", value)
	}
	if named != kind {
		return nil, nil
	}
	if kind == model.KindMovie || kind == model.KindSeries {
		return s.byForeign(ctx, cfg, kind, "tmdb", parts[1], p)
	}
	hits, _, err := s.idSearch(ctx, cfg, "tmdb", parts[1], model.KindSeries, p)
	if err != nil {
		return nil, err
	}
	for i := range hits {
		sh := hits[i].Show
		if sh == nil {
			continue
		}
		if kind == model.KindSeason {
			return s.seasonOf(ctx, cfg, sh, nums[1])
		}
		return s.episodeOf(ctx, cfg, sh, nums[1], func(e *episode) bool { return e.Number == nums[2] })
	}
	return nil, nil
}

// Lists a show's seasons with full episodes, translated when the configured language is not English
func (s *Source) seasons(ctx context.Context, cfg settings, sh *show) ([]season, string, error) {
	query := url.Values{"extended": {"full,episodes"}}
	if cfg.lang != "en" {
		query.Set("translations", cfg.lang)
	}
	var out []season
	rec, err := s.get(ctx, cfg, "/shows/"+strconv.FormatInt(sh.IDs.Trakt, 10)+"/seasons", query, provenance{model.NSTrakt, sh.value(), model.KindSeason}, &out)
	if missing(err) {
		return nil, "", nil
	}
	return out, rec, err
}

// Emits one season of a show with its episodes
func (s *Source) seasonOf(ctx context.Context, cfg settings, sh *show, number int) ([]model.Claim, error) {
	list, rec, err := s.seasons(ctx, cfg, sh)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	for i := range list {
		if list[i].Number == number {
			list[i].claims(sh, rec, cfg, &out)
			return out, nil
		}
	}
	return nil, nil
}

// Emits the episode of one season that matches
func (s *Source) episodeOf(ctx context.Context, cfg settings, sh *show, number int, match func(*episode) bool) ([]model.Claim, error) {
	list, rec, err := s.seasons(ctx, cfg, sh)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	for i := range list {
		if list[i].Number != number {
			continue
		}
		for j := range list[i].Episodes {
			if e := &list[i].Episodes[j]; match(e) {
				e.claims(sh, list[i].value(), rec, cfg, &out)
				return out, nil
			}
		}
	}
	return nil, nil
}

// Fetches the title, overview, and tagline of a movie or show in the configured language
func (s *Source) translation(ctx context.Context, cfg settings, kind, value string, traktID int64) (translation, string, error) {
	path := "/movies/"
	if kind == model.KindSeries {
		path = "/shows/"
	}
	var list []translation
	rec, err := s.get(ctx, cfg, path+strconv.FormatInt(traktID, 10)+"/translations/"+cfg.lang, nil, provenance{model.NSTrakt, value, kind}, &list)
	if missing(err) {
		return translation{}, "", nil
	}
	if err != nil {
		return translation{}, "", err
	}
	return pick(list, cfg), rec, nil
}

// Emits a movie, translated when the configured language is offered
func (s *Source) movieClaims(ctx context.Context, cfg settings, m *movie, rec string) ([]model.Claim, error) {
	var tr translation
	trRec := ""
	if cfg.translates(m.AvailableTranslations) {
		var err error
		if tr, trRec, err = s.translation(ctx, cfg, model.KindMovie, m.value(), m.IDs.Trakt); err != nil {
			return nil, err
		}
	}
	var out []model.Claim
	m.claims(rec, tr, trRec, &out)
	return out, nil
}

// Emits a show, translated when offered, with every season and episode as child groups
func (s *Source) showClaims(ctx context.Context, cfg settings, sh *show, rec string) ([]model.Claim, error) {
	var tr translation
	trRec := ""
	if cfg.translates(sh.AvailableTranslations) {
		var err error
		if tr, trRec, err = s.translation(ctx, cfg, model.KindSeries, sh.value(), sh.IDs.Trakt); err != nil {
			return nil, err
		}
	}
	list, srec, err := s.seasons(ctx, cfg, sh)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	sh.claims(rec, tr, trRec, list, &out)
	for i := range list {
		list[i].claims(sh, srec, cfg, &out)
	}
	return out, nil
}

// Finds movies, shows, or both by title and optional year, translating titles the results offer
func (s *Source) Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error) {
	cfg, err := s.settings()
	if err != nil {
		return nil, err
	}
	var types string
	switch kind {
	case "":
		types = "movie,show"
	case model.KindMovie:
		types = "movie"
	case model.KindSeries:
		types = "show"
	default:
		return nil, fmt.Errorf("%w: trakt searches movies and shows, not %s", catalog.ErrUnsupported, kind)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	query := url.Values{"query": {text}, "extended": {"full"}}
	if year > 0 {
		query.Set("years", strconv.Itoa(year))
	}
	var hits []hit
	rec, err := s.get(ctx, cfg, "/search/"+types, query, provenance{namespace: model.NSTrakt, kind: kind}, &hits)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	for i := range hits {
		h := &hits[i]
		var tr translation
		trRec := ""
		switch {
		case h.Movie != nil:
			if cfg.translates(h.Movie.AvailableTranslations) {
				if tr, trRec, err = s.translation(ctx, cfg, model.KindMovie, h.Movie.value(), h.Movie.IDs.Trakt); err != nil {
					return nil, err
				}
			}
			h.Movie.claims(rec, tr, trRec, &out)
		case h.Show != nil:
			if cfg.translates(h.Show.AvailableTranslations) {
				if tr, trRec, err = s.translation(ctx, cfg, model.KindSeries, h.Show.value(), h.Show.IDs.Trakt); err != nil {
					return nil, err
				}
			}
			h.Show.claims(rec, tr, trRec, nil, &out)
		}
	}
	return out, nil
}
