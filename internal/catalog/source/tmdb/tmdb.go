// Reads movies, series, seasons, and episodes from The Movie Database v3 API
package tmdb

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
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
	apiBase   = "https://api.themoviedb.org/3"
	imageBase = "https://image.tmdb.org/t/p/original"
	license   = "TMDB API terms, not endorsed or certified by TMDB"
	castLimit = 20
)

var imdbID = regexp.MustCompile(`^tt[0-9]+$`)

// Answers catalog lookups and searches from TMDB
type Source struct {
	client *outbound.Client
	key    string

	mu   sync.RWMutex
	lang language.Tag
}

// Returns a source that calls TMDB through the outbound client with the project's v3 api key or v4 read access token
func New(client *outbound.Client, key string) *Source {
	return &Source{client: client, key: strings.TrimSpace(key), lang: language.English}
}

func (s *Source) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.tmdb", Name: "TMDB", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (s *Source) Name() string { return catalog.SourceTMDB }

func (s *Source) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceTMDB, Title: "TMDB", Rate: 20, Burst: 20, Timeout: 20 * time.Second, CacheTTL: 24 * time.Hour, License: license}
}

func (s *Source) Namespaces() []string { return []string{model.NSTMDB, model.NSIMDb, model.NSTVDB} }

func (s *Source) Kinds() []string {
	return []string{model.KindMovie, model.KindSeries, model.KindSeason, model.KindEpisode}
}

// Posters, backdrops, and logos come with every record
func (s *Source) Artwork() bool { return true }

func (s *Source) License() string { return license }

// Stores the response language
func (s *Source) Configure(options map[string]string) error {
	lang := language.English
	if raw := strings.TrimSpace(options["language"]); raw != "" {
		tag, err := language.Parse(raw)
		if err != nil {
			return fmt.Errorf("tmdb: language %q: %w", raw, err)
		}
		lang = tag
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lang = lang
	return nil
}

// Holds the key and language one call runs with
type settings struct {
	key  string
	lang language.Tag
}

// Snapshots the configuration one call runs with
func (s *Source) settings() settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return settings{key: s.key, lang: s.lang}
}

// Builds the query of a record fetch with appended sub-requests and images in the configured language
func (c settings) detail(appends string) url.Values {
	base, _ := c.lang.Base()
	return url.Values{
		"append_to_response":     {appends},
		"language":               {c.lang.String()},
		"include_image_language": {base.String() + ",null"},
	}
}

// Names the record a request is about
type provenance struct {
	namespace, value, kind string
}

// Fetches one API path, authenticating by query key or bearer token, and returns the record id
func (s *Source) get(ctx context.Context, cfg settings, path string, query url.Values, p provenance, out any) (string, error) {
	header := http.Header{"Accept": {"application/json"}}
	var redact []string
	if strings.HasPrefix(cfg.key, "eyJ") {
		header.Set("Authorization", "Bearer "+cfg.key)
	} else {
		query.Set("api_key", cfg.key)
		redact = []string{"api_key"}
	}
	req := outbound.Request{URL: apiBase + path + "?" + query.Encode(), Header: header, Namespace: p.namespace, ExtValue: p.value, Kind: p.kind, Redact: redact}
	res, err := s.client.GetJSON(ctx, catalog.SourceTMDB, req, out)
	if err != nil {
		return "", err
	}
	return res.RecordID, nil
}

// Reports whether TMDB answered that the requested record does not exist
func missing(err error) bool {
	se, ok := errors.AsType[*outbound.StatusError](err)
	return ok && se.Status == http.StatusNotFound
}

// Holds the kind and numbers of a parsed TMDB id
type ref struct {
	kind            string
	id              int64
	season, episode int
}

// Reads movie/603, tv/1396, tv/1396/1, or tv/1396/1/2
func parseRef(value string) (ref, error) {
	parts := strings.Split(value, "/")
	nums := make([]int64, 0, len(parts)-1)
	for _, p := range parts[1:] {
		n, err := strconv.ParseInt(p, 10, 64)
		if err != nil || n < 0 {
			return ref{}, fmt.Errorf("tmdb: %q is not an id like movie/603 or tv/1396/1/2", value)
		}
		nums = append(nums, n)
	}
	switch {
	case parts[0] == "movie" && len(nums) == 1 && nums[0] > 0:
		return ref{kind: model.KindMovie, id: nums[0]}, nil
	case parts[0] == "tv" && len(nums) == 1 && nums[0] > 0:
		return ref{kind: model.KindSeries, id: nums[0]}, nil
	case parts[0] == "tv" && len(nums) == 2 && nums[0] > 0:
		return ref{kind: model.KindSeason, id: nums[0], season: int(nums[1])}, nil
	case parts[0] == "tv" && len(nums) == 3 && nums[0] > 0:
		return ref{kind: model.KindEpisode, id: nums[0], season: int(nums[1]), episode: int(nums[2])}, nil
	}
	return ref{}, fmt.Errorf("tmdb: %q is not an id like movie/603 or tv/1396/1/2", value)
}

// Reads one record by a tmdb id directly or by an imdb or tvdb id through the find endpoint
func (s *Source) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	cfg := s.settings()
	if !model.ValidKind(kind) {
		return nil, fmt.Errorf("tmdb: unknown kind %q", kind)
	}
	switch namespace {
	case model.NSTMDB:
		r, err := parseRef(id)
		if err != nil {
			return nil, err
		}
		if r.kind != kind {
			return nil, nil
		}
		return s.fetch(ctx, cfg, r)
	case model.NSIMDb, model.NSTVDB:
		return s.find(ctx, cfg, kind, namespace, id)
	}
	return nil, fmt.Errorf("%w: tmdb has no lookup by %s ids", catalog.ErrUnsupported, namespace)
}

// Reads the record a parsed tmdb id names
func (s *Source) fetch(ctx context.Context, cfg settings, r ref) ([]model.Claim, error) {
	switch r.kind {
	case model.KindMovie:
		return s.movie(ctx, cfg, r.id)
	case model.KindSeries:
		return s.series(ctx, cfg, r.id)
	case model.KindSeason:
		return s.season(ctx, cfg, r.id, r.season)
	}
	return s.episode(ctx, cfg, r.id, r.season, r.episode)
}

// Maps a foreign id to the find endpoint's id and source, empty when it names another kind
func findKey(kind, namespace, id string) (external, source string, err error) {
	if namespace == model.NSIMDb {
		if !imdbID.MatchString(id) {
			return "", "", fmt.Errorf("tmdb: %q is not an imdb id like tt0133093", id)
		}
		return id, "imdb_id", nil
	}
	prefix, rest := model.SplitValue(id)
	if n, perr := strconv.ParseInt(rest, 10, 64); perr != nil || n <= 0 {
		return "", "", fmt.Errorf("tmdb: %q is not a tvdb id like series/81189", id)
	}
	want := map[string]string{model.KindMovie: "movie", model.KindSeries: "series", model.KindSeason: "season", model.KindEpisode: "episode"}[kind]
	if prefix != want {
		return "", "", nil
	}
	return rest, "tvdb_id", nil
}

// Resolves an imdb or tvdb id to a tmdb record and reads it
func (s *Source) find(ctx context.Context, cfg settings, kind, namespace, id string) ([]model.Claim, error) {
	external, source, err := findKey(kind, namespace, id)
	if err != nil || external == "" {
		return nil, err
	}
	var out findResult
	query := url.Values{"external_source": {source}, "language": {cfg.lang.String()}}
	if _, err := s.get(ctx, cfg, "/find/"+url.PathEscape(external), query, provenance{namespace, id, kind}, &out); err != nil {
		return nil, err
	}
	switch {
	case kind == model.KindMovie && len(out.Movies) > 0:
		return s.movie(ctx, cfg, out.Movies[0].ID)
	case kind == model.KindSeries && len(out.Series) > 0:
		return s.series(ctx, cfg, out.Series[0].ID)
	case kind == model.KindSeason && len(out.Seasons) > 0:
		return s.season(ctx, cfg, out.Seasons[0].ShowID, out.Seasons[0].SeasonNumber)
	case kind == model.KindEpisode && len(out.Episodes) > 0:
		e := out.Episodes[0]
		return s.episode(ctx, cfg, e.ShowID, e.SeasonNumber, e.EpisodeNumber)
	}
	return nil, nil
}

// Reads a movie with its ids, images, credits, keywords, certifications, and alternative titles
func (s *Source) movie(ctx context.Context, cfg settings, id int64) ([]model.Claim, error) {
	value := model.TMDBMovie(id)
	var m movieRecord
	rec, err := s.get(ctx, cfg, "/movie/"+strconv.FormatInt(id, 10), cfg.detail("external_ids,images,credits,keywords,release_dates,alternative_titles"), provenance{model.NSTMDB, value, model.KindMovie}, &m)
	if missing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	m.claims(claimer{kind: model.KindMovie, id: value, recordID: rec, out: &out})
	return out, nil
}

// Reads a series and emits one child group per season it lists
func (s *Source) series(ctx context.Context, cfg settings, id int64) ([]model.Claim, error) {
	value := model.TMDBSeries(id)
	var t seriesRecord
	rec, err := s.get(ctx, cfg, "/tv/"+strconv.FormatInt(id, 10), cfg.detail("external_ids,images,credits,keywords,content_ratings,alternative_titles"), provenance{model.NSTMDB, value, model.KindSeries}, &t)
	if missing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	t.claims(claimer{kind: model.KindSeries, id: value, recordID: rec, out: &out})
	for _, season := range t.Seasons {
		season.claims(claimer{kind: model.KindSeason, id: model.TMDBSeason(id, season.SeasonNumber), recordID: rec, out: &out}, value)
	}
	return out, nil
}

// Reads one season and emits one child group per episode it lists
func (s *Source) season(ctx context.Context, cfg settings, series int64, number int) ([]model.Claim, error) {
	value := model.TMDBSeason(series, number)
	var r seasonRecord
	rec, err := s.get(ctx, cfg, fmt.Sprintf("/tv/%d/season/%d", series, number), cfg.detail("external_ids,images"), provenance{model.NSTMDB, value, model.KindSeason}, &r)
	if missing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	r.claims(claimer{kind: model.KindSeason, id: value, recordID: rec, out: &out}, model.TMDBSeries(series))
	for _, e := range r.Episodes {
		e.claims(claimer{kind: model.KindEpisode, id: model.TMDBEpisode(series, number, e.EpisodeNumber), recordID: rec, out: &out}, value)
	}
	return out, nil
}

// Reads one episode with its external ids and stills
func (s *Source) episode(ctx context.Context, cfg settings, series int64, season, number int) ([]model.Claim, error) {
	value := model.TMDBEpisode(series, season, number)
	var e episodeRecord
	rec, err := s.get(ctx, cfg, fmt.Sprintf("/tv/%d/season/%d/episode/%d", series, season, number), cfg.detail("external_ids,images"), provenance{model.NSTMDB, value, model.KindEpisode}, &e)
	if missing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	e.claims(claimer{kind: model.KindEpisode, id: value, recordID: rec, out: &out}, model.TMDBSeason(series, season))
	return out, nil
}

// Finds movies, series, or both by title and optional year
func (s *Source) Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error) {
	cfg := s.settings()
	var kinds []string
	switch kind {
	case "":
		kinds = []string{model.KindMovie, model.KindSeries}
	case model.KindMovie, model.KindSeries:
		kinds = []string{kind}
	default:
		return nil, fmt.Errorf("%w: tmdb searches movies and series, not %s", catalog.ErrUnsupported, kind)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	var out []model.Claim
	for _, k := range kinds {
		query := url.Values{"query": {text}, "language": {cfg.lang.String()}, "include_adult": {"false"}}
		path := "/search/movie"
		if k == model.KindSeries {
			path = "/search/tv"
		}
		if year > 0 && k == model.KindMovie {
			query.Set("year", strconv.Itoa(year))
		}
		if year > 0 && k == model.KindSeries {
			query.Set("first_air_date_year", strconv.Itoa(year))
		}
		var page searchPage
		rec, err := s.get(ctx, cfg, path, query, provenance{namespace: model.NSTMDB, kind: k}, &page)
		if err != nil {
			return nil, err
		}
		for _, hit := range page.Results {
			hit.claims(k, rec, &out)
		}
	}
	return out, nil
}
