// Reads movies, series, seasons, and episodes from TheTVDB v4 API
package tvdb

import (
	"context"
	"encoding/json"
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
	apiBase = "https://api4.thetvdb.com/v4"
	artBase = "https://artworks.thetvdb.com"
	license = "TheTVDB API terms"
)

var imdbID = regexp.MustCompile(`^tt[0-9]+$`)

// Answers catalog lookups and searches from TheTVDB
type Source struct {
	client *outbound.Client
	key    string

	mu    sync.RWMutex
	lang  language.Tag
	token string

	auth sync.Mutex
}

// Returns a source that calls TheTVDB through the outbound client with the project's v4 key
func New(client *outbound.Client, key string) *Source {
	return &Source{client: client, key: strings.TrimSpace(key), lang: language.English}
}

func (s *Source) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.tvdb", Name: "TheTVDB", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (s *Source) Name() string { return catalog.SourceTVDB }

func (s *Source) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceTVDB, Title: "TheTVDB", Rate: 5, Burst: 5, Timeout: 20 * time.Second, CacheTTL: 24 * time.Hour, License: license}
}

func (s *Source) Namespaces() []string { return []string{model.NSTVDB, model.NSIMDb, model.NSTMDB} }

func (s *Source) Kinds() []string {
	return []string{model.KindMovie, model.KindSeries, model.KindSeason, model.KindEpisode}
}

// Posters, backdrops, and banners come with every record
func (s *Source) Artwork() bool { return true }

func (s *Source) License() string { return license }

// Stores the language
func (s *Source) Configure(options map[string]string) error {
	lang := language.English
	if raw := strings.TrimSpace(options["language"]); raw != "" {
		tag, err := language.Parse(raw)
		if err != nil {
			return fmt.Errorf("tvdb: language %q: %w", raw, err)
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
	key, lang3 string
}

// Snapshots the configuration one call runs with
func (s *Source) settings() settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	base, _ := s.lang.Base()
	return settings{key: s.key, lang3: base.ISO3()}
}

// Returns the held token or logs in, replacing a token the API just rejected
func (s *Source) bearer(ctx context.Context, cfg settings, rejected string) (string, error) {
	s.auth.Lock()
	defer s.auth.Unlock()
	s.mu.RLock()
	token := s.token
	s.mu.RUnlock()
	if token != "" && token != rejected {
		return token, nil
	}
	body, err := json.Marshal(map[string]string{"apikey": cfg.key})
	if err != nil {
		return "", err
	}
	header := http.Header{"Content-Type": {"application/json"}, "Accept": {"application/json"}}
	res, err := s.client.Do(ctx, catalog.SourceTVDB, outbound.Request{Method: http.MethodPost, URL: apiBase + "/login", Header: header, Body: body, NoRecord: true})
	if err != nil {
		return "", fmt.Errorf("tvdb: login: %w", err)
	}
	var out struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body, &out); err != nil {
		return "", fmt.Errorf("tvdb: login: %w", err)
	}
	if out.Data.Token == "" {
		return "", errors.New("tvdb: login answered without a token")
	}
	s.mu.Lock()
	s.token = out.Data.Token
	s.mu.Unlock()
	return out.Data.Token, nil
}

// Names the record a request is about
type provenance struct {
	namespace, value, kind string
}

// Fetches one API path with the bearer token, logging in again once when the token is rejected
func (s *Source) get(ctx context.Context, cfg settings, path string, query url.Values, p provenance, out any) (string, error) {
	u := apiBase + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	token, err := s.bearer(ctx, cfg, "")
	if err != nil {
		return "", err
	}
	request := func(token string) outbound.Request {
		return outbound.Request{URL: u, Header: http.Header{"Authorization": {"Bearer " + token}, "Accept": {"application/json"}}, Namespace: p.namespace, ExtValue: p.value, Kind: p.kind}
	}
	res, err := s.client.GetJSON(ctx, catalog.SourceTVDB, request(token), out)
	if status(err) == http.StatusUnauthorized {
		if token, err = s.bearer(ctx, cfg, token); err != nil {
			return "", err
		}
		res, err = s.client.GetJSON(ctx, catalog.SourceTVDB, request(token), out)
	}
	if err != nil {
		return "", err
	}
	return res.RecordID, nil
}

// Reads the HTTP status of an outbound error, zero for other failures
func status(err error) int {
	if se, ok := errors.AsType[*outbound.StatusError](err); ok {
		return se.Status
	}
	return 0
}

// Maps the prefix of a tvdb id to the kind it names
var tvdbKinds = map[string]string{"movie": model.KindMovie, "series": model.KindSeries, "season": model.KindSeason, "episode": model.KindEpisode}

// Reads one record by a tvdb id directly or by an imdb or tmdb id through the remote id search
func (s *Source) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	cfg := s.settings()
	if !model.ValidKind(kind) {
		return nil, fmt.Errorf("tvdb: unknown kind %q", kind)
	}
	switch namespace {
	case model.NSTVDB:
		prefix, rest := model.SplitValue(id)
		n, perr := strconv.ParseInt(rest, 10, 64)
		named, ok := tvdbKinds[prefix]
		if perr != nil || n <= 0 || !ok {
			return nil, fmt.Errorf("tvdb: %q is not an id like series/81189", id)
		}
		if named != kind {
			return nil, nil
		}
		return s.fetch(ctx, cfg, kind, n)
	case model.NSIMDb:
		if !imdbID.MatchString(id) {
			return nil, fmt.Errorf("tvdb: %q is not an imdb id like tt0133093", id)
		}
		return s.byRemote(ctx, cfg, kind, provenance{namespace, id, kind}, id)
	case model.NSTMDB:
		return s.byTMDB(ctx, cfg, kind, id)
	}
	return nil, fmt.Errorf("%w: tvdb has no lookup by %s ids", catalog.ErrUnsupported, namespace)
}

// Reads the record a tvdb id names
func (s *Source) fetch(ctx context.Context, cfg settings, kind string, id int64) ([]model.Claim, error) {
	var out []model.Claim
	switch kind {
	case model.KindMovie:
		m, rec, err := s.movie(ctx, cfg, id)
		if m == nil || err != nil {
			return nil, err
		}
		m.claims(claimer{kind: kind, id: model.TVDBValue(kind, id), recordID: rec, out: &out}, cfg.lang3)
	case model.KindSeries:
		t, rec, err := s.series(ctx, cfg, id)
		if t == nil || err != nil {
			return nil, err
		}
		if err := s.seriesClaims(ctx, cfg, t, rec, &out); err != nil {
			return nil, err
		}
	case model.KindSeason:
		return s.season(ctx, cfg, id)
	default:
		e, rec, err := s.episode(ctx, cfg, id)
		if e == nil || err != nil {
			return nil, err
		}
		e.claims(claimer{kind: kind, id: model.TVDBValue(kind, id), recordID: rec, out: &out}, cfg.lang3)
	}
	return out, nil
}

// Reads a movie with translations, or nil when TheTVDB has no such movie
func (s *Source) movie(ctx context.Context, cfg settings, id int64) (*movieRecord, string, error) {
	var env struct {
		Data movieRecord `json:"data"`
	}
	rec, err := s.get(ctx, cfg, "/movies/"+strconv.FormatInt(id, 10)+"/extended", url.Values{"meta": {"translations"}}, provenance{model.NSTVDB, model.TVDBValue(model.KindMovie, id), model.KindMovie}, &env)
	if status(err) == http.StatusNotFound {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	return &env.Data, rec, nil
}

// Reads a series with translations, artwork, characters, and seasons, or nil when unknown
func (s *Source) series(ctx context.Context, cfg settings, id int64) (*seriesRecord, string, error) {
	var env struct {
		Data seriesRecord `json:"data"`
	}
	rec, err := s.get(ctx, cfg, "/series/"+strconv.FormatInt(id, 10)+"/extended", url.Values{"meta": {"translations"}, "short": {"false"}}, provenance{model.NSTVDB, model.TVDBValue(model.KindSeries, id), model.KindSeries}, &env)
	if status(err) == http.StatusNotFound {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	return &env.Data, rec, nil
}

// Appends a series and one child group per aired-order season, translated where offered
func (s *Source) seriesClaims(ctx context.Context, cfg settings, t *seriesRecord, rec string, out *[]model.Claim) error {
	value := model.TVDBValue(model.KindSeries, t.ID)
	t.claims(claimer{kind: model.KindSeries, id: value, recordID: rec, out: out}, cfg.lang3)
	for _, season := range t.officialSeasons() {
		tr, trec, err := s.translation(ctx, cfg, model.KindSeason, season.ID, season.NameTranslations, season.OverviewTranslations, t.OriginalLanguage)
		if err != nil {
			return err
		}
		season.claims(claimer{kind: model.KindSeason, id: model.TVDBValue(model.KindSeason, season.ID), recordID: rec, out: out}, tr, trec, value)
	}
	return nil
}

// Reads a season and emits one child group per episode, translated where offered
func (s *Source) season(ctx context.Context, cfg settings, id int64) ([]model.Claim, error) {
	value := model.TVDBValue(model.KindSeason, id)
	var env struct {
		Data seasonRecord `json:"data"`
	}
	rec, err := s.get(ctx, cfg, "/seasons/"+strconv.FormatInt(id, 10)+"/extended", url.Values{"meta": {"translations"}}, provenance{model.NSTVDB, value, model.KindSeason}, &env)
	if status(err) == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r := &env.Data
	var series struct {
		Data struct {
			OriginalLanguage string `json:"originalLanguage"`
		} `json:"data"`
	}
	parent := model.TVDBValue(model.KindSeries, r.SeriesID)
	if _, err := s.get(ctx, cfg, "/series/"+strconv.FormatInt(r.SeriesID, 10), nil, provenance{model.NSTVDB, parent, model.KindSeries}, &series); err != nil {
		return nil, err
	}
	var out []model.Claim
	r.claims(claimer{kind: model.KindSeason, id: value, recordID: rec, out: &out}, cfg.lang3, series.Data.OriginalLanguage, parent)
	for _, e := range r.Episodes {
		tr, trec, err := s.translation(ctx, cfg, model.KindEpisode, e.ID, e.NameTranslations, e.OverviewTranslations, series.Data.OriginalLanguage)
		if err != nil {
			return nil, err
		}
		e.claims(claimer{kind: model.KindEpisode, id: model.TVDBValue(model.KindEpisode, e.ID), recordID: rec, out: &out}, tr, trec, value)
	}
	return out, nil
}

// Reads an episode with translations, or nil when unknown
func (s *Source) episode(ctx context.Context, cfg settings, id int64) (*episodeRecord, string, error) {
	var env struct {
		Data episodeRecord `json:"data"`
	}
	rec, err := s.get(ctx, cfg, "/episodes/"+strconv.FormatInt(id, 10)+"/extended", url.Values{"meta": {"translations"}}, provenance{model.NSTVDB, model.TVDBValue(model.KindEpisode, id), model.KindEpisode}, &env)
	if status(err) == http.StatusNotFound {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	return &env.Data, rec, nil
}

// Fetches a child's name and overview in the configured language when it lists one beyond its original
func (s *Source) translation(ctx context.Context, cfg settings, kind string, id int64, names, overviews []string, original string) (translated, string, error) {
	if cfg.lang3 == original || (!slices.Contains(names, cfg.lang3) && !slices.Contains(overviews, cfg.lang3)) {
		return translated{}, "", nil
	}
	path := "/seasons/"
	if kind == model.KindEpisode {
		path = "/episodes/"
	}
	var env struct {
		Data translated `json:"data"`
	}
	rec, err := s.get(ctx, cfg, path+strconv.FormatInt(id, 10)+"/translations/"+cfg.lang3, nil, provenance{model.NSTVDB, model.TVDBValue(kind, id), kind}, &env)
	if status(err) == http.StatusNotFound {
		return translated{}, "", nil
	}
	if err != nil {
		return translated{}, "", err
	}
	return env.Data, rec, nil
}

// Holds one record the remote id search matched
type remoteHit struct {
	Series  *struct{ ID int64 } `json:"series"`
	Movie   *struct{ ID int64 } `json:"movie"`
	Episode *struct{ ID int64 } `json:"episode"`
}

// Lists the tvdb ids of one kind that carry a foreign id
func (s *Source) remote(ctx context.Context, cfg settings, kind string, p provenance, raw string) ([]int64, error) {
	var env struct {
		Data []remoteHit `json:"data"`
	}
	_, err := s.get(ctx, cfg, "/search/remoteid/"+url.PathEscape(raw), nil, p, &env)
	if status(err) == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, h := range env.Data {
		switch {
		case kind == model.KindMovie && h.Movie != nil:
			ids = append(ids, h.Movie.ID)
		case kind == model.KindSeries && h.Series != nil:
			ids = append(ids, h.Series.ID)
		case kind == model.KindEpisode && h.Episode != nil:
			ids = append(ids, h.Episode.ID)
		}
	}
	return ids, nil
}

// Reads the first record of a kind whose own remote ids confirm the foreign id
func (s *Source) byRemote(ctx context.Context, cfg settings, kind string, p provenance, raw string) ([]model.Claim, error) {
	ids, err := s.remote(ctx, cfg, kind, p, raw)
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	for _, id := range ids {
		c := claimer{kind: kind, id: model.TVDBValue(kind, id), out: &out}
		switch kind {
		case model.KindMovie:
			m, rec, err := s.movie(ctx, cfg, id)
			if err != nil {
				return nil, err
			}
			if m != nil && carries(m.RemoteIDs, p.namespace, raw) {
				c.recordID = rec
				m.claims(c, cfg.lang3)
				return out, nil
			}
		case model.KindSeries:
			t, rec, err := s.series(ctx, cfg, id)
			if err != nil {
				return nil, err
			}
			if t != nil && carries(t.RemoteIDs, p.namespace, raw) {
				if err := s.seriesClaims(ctx, cfg, t, rec, &out); err != nil {
					return nil, err
				}
				return out, nil
			}
		case model.KindEpisode:
			e, rec, err := s.episode(ctx, cfg, id)
			if err != nil {
				return nil, err
			}
			if e != nil && carries(e.RemoteIDs, p.namespace, raw) {
				c.recordID = rec
				e.claims(c, cfg.lang3)
				return out, nil
			}
		}
	}
	return nil, nil
}

// Resolves tmdb movies and series by remote id, and tmdb seasons and episodes by their numbers in the series
func (s *Source) byTMDB(ctx context.Context, cfg settings, kind, value string) ([]model.Claim, error) {
	parts := strings.Split(value, "/")
	nums := make([]int, 0, len(parts)-1)
	for _, p := range parts[1:] {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("tvdb: %q is not a tmdb id like movie/603 or tv/1396/1/2", value)
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
		return nil, fmt.Errorf("tvdb: %q is not a tmdb id like movie/603 or tv/1396/1/2", value)
	}
	if named != kind {
		return nil, nil
	}
	p := provenance{model.NSTMDB, value, kind}
	raw := parts[1]
	if kind == model.KindMovie || kind == model.KindSeries {
		return s.byRemote(ctx, cfg, kind, p, raw)
	}
	ids, err := s.remote(ctx, cfg, model.KindSeries, p, raw)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		t, _, err := s.series(ctx, cfg, id)
		if err != nil {
			return nil, err
		}
		if t == nil || !carries(t.RemoteIDs, model.NSTMDB, raw) {
			continue
		}
		for _, season := range t.officialSeasons() {
			if season.Number != nums[1] {
				continue
			}
			if kind == model.KindSeason {
				return s.season(ctx, cfg, season.ID)
			}
			return s.episodeInSeason(ctx, cfg, season.ID, nums[2])
		}
		return nil, nil
	}
	return nil, nil
}

// Reads the episode with an aired number from one season
func (s *Source) episodeInSeason(ctx context.Context, cfg settings, seasonID int64, number int) ([]model.Claim, error) {
	var env struct {
		Data seasonRecord `json:"data"`
	}
	_, err := s.get(ctx, cfg, "/seasons/"+strconv.FormatInt(seasonID, 10)+"/extended", url.Values{"meta": {"translations"}}, provenance{model.NSTVDB, model.TVDBValue(model.KindSeason, seasonID), model.KindSeason}, &env)
	if status(err) == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for _, e := range env.Data.Episodes {
		if e.Number == number {
			return s.fetch(ctx, cfg, model.KindEpisode, e.ID)
		}
	}
	return nil, nil
}

// Finds movies, series, or both by title and optional year
func (s *Source) Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error) {
	cfg := s.settings()
	var kinds []string
	switch kind {
	case "":
		kinds = []string{model.KindSeries, model.KindMovie}
	case model.KindMovie, model.KindSeries:
		kinds = []string{kind}
	default:
		return nil, fmt.Errorf("%w: tvdb searches movies and series, not %s", catalog.ErrUnsupported, kind)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	var out []model.Claim
	for _, k := range kinds {
		query := url.Values{"query": {text}, "type": {k}}
		if year > 0 {
			query.Set("year", strconv.Itoa(year))
		}
		var env struct {
			Data []searchHit `json:"data"`
		}
		rec, err := s.get(ctx, cfg, "/search", query, provenance{namespace: model.NSTVDB, kind: k}, &env)
		if err != nil {
			return nil, err
		}
		for i := range env.Data {
			env.Data[i].claims(k, rec, cfg.lang3, &out)
		}
	}
	return out, nil
}
