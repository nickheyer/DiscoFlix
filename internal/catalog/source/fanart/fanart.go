// Reads movie and series artwork from the fanart.tv v3 API
package fanart

import (
	"bytes"
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
	apiBase = "https://webservice.fanart.tv/v3"
	license = "fanart.tv API terms"
)

// Fails every lookup made before a project key is configured
var ErrNoKey = errors.New("fanart: no api key configured, get a project key at https://fanart.tv/get-an-api-key/")

// Explains that fanart.tv indexes artwork by id and has no title search
var errSearch = fmt.Errorf("%w: fanart.tv finds artwork by id only", catalog.ErrUnsupported)

var imdbID = regexp.MustCompile(`^tt[0-9]+$`)

// Answers catalog artwork lookups from fanart.tv
type Source struct {
	client *outbound.Client

	mu        sync.RWMutex
	key       string
	clientKey string
	lang      string
}

// Returns a source that calls fanart.tv through the outbound client
func New(client *outbound.Client) *Source {
	return &Source{client: client, lang: "en"}
}

func (s *Source) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.fanart", Name: "fanart.tv", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (s *Source) Name() string { return catalog.SourceFanart }

func (s *Source) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceFanart, Title: "fanart.tv", Rate: 2, Burst: 2, Timeout: 20 * time.Second, CacheTTL: 7 * 24 * time.Hour, License: license}
}

func (s *Source) Namespaces() []string { return []string{model.NSTMDB, model.NSIMDb, model.NSTVDB} }

func (s *Source) Kinds() []string { return []string{model.KindMovie, model.KindSeries} }

func (s *Source) NeedsKey() bool { return true }

func (s *Source) KeyHint() string {
	return "https://fanart.tv/get-an-api-key/ (project key, personal key optional as the client key)"
}

func (s *Source) License() string { return license }

// Stores the project and personal keys and the language artwork is chosen in
func (s *Source) Configure(keys catalog.Keys, options map[string]string) error {
	lang := "en"
	if raw := strings.TrimSpace(options["language"]); raw != "" {
		tag, err := language.Parse(raw)
		if err != nil {
			return fmt.Errorf("fanart: language %q: %w", raw, err)
		}
		base, _ := tag.Base()
		lang = base.String()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key, s.clientKey, s.lang = strings.TrimSpace(keys.APIKey), strings.TrimSpace(keys.ClientKey), lang
	return nil
}

// Holds the keys and language one call runs with
type settings struct {
	key, clientKey, lang string
}

// Snapshots the configuration, failing when no project key is set
func (s *Source) settings() (settings, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.key == "" {
		return settings{}, ErrNoKey
	}
	return settings{key: s.key, clientKey: s.clientKey, lang: s.lang}, nil
}

// Reads the artwork of a movie by tmdb or imdb id, or of a series by tvdb id
func (s *Source) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	cfg, err := s.settings()
	if err != nil {
		return nil, err
	}
	path, err := endpoint(kind, namespace, id)
	if err != nil || path == "" {
		return nil, err
	}
	query := url.Values{"api_key": {cfg.key}}
	if cfg.clientKey != "" {
		query.Set("client_key", cfg.clientKey)
	}
	var art response
	res, err := s.client.GetJSON(ctx, catalog.SourceFanart, outbound.Request{URL: apiBase + path + "?" + query.Encode(), Header: http.Header{"Accept": {"application/json"}}, Namespace: namespace, ExtValue: id, Kind: kind, Redact: []string{"api_key", "client_key"}}, &art)
	if se, ok := errors.AsType[*outbound.StatusError](err); ok && se.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []model.Claim
	art.claims(claimer{kind: kind, namespace: namespace, id: id, recordID: res.RecordID, out: &out}, cfg.lang)
	return out, nil
}

// Maps a lookup to its API path, empty when the id names another kind
func endpoint(kind, namespace, id string) (string, error) {
	if kind != model.KindMovie && kind != model.KindSeries {
		return "", fmt.Errorf("%w: fanart.tv serves movie and series artwork, not %s", catalog.ErrUnsupported, kind)
	}
	if namespace == model.NSIMDb {
		if !imdbID.MatchString(id) {
			return "", fmt.Errorf("fanart: %q is not an imdb id like tt0133093", id)
		}
		if kind == model.KindSeries {
			return "", fmt.Errorf("%w: fanart.tv finds series by tvdb id only", catalog.ErrUnsupported)
		}
		return "/movies/" + id, nil
	}
	if namespace != model.NSTMDB && namespace != model.NSTVDB {
		return "", fmt.Errorf("%w: fanart.tv has no lookup by %s ids", catalog.ErrUnsupported, namespace)
	}
	named, number := namedKind(namespace, id)
	switch {
	case named == "":
		return "", fmt.Errorf("fanart: %q is not a %s id", id, namespace)
	case named != kind:
		return "", nil
	case namespace == model.NSTMDB && kind == model.KindMovie:
		return "/movies/" + number, nil
	case namespace == model.NSTVDB && kind == model.KindSeries:
		return "/tv/" + number, nil
	case kind == model.KindMovie:
		return "", fmt.Errorf("%w: fanart.tv finds movies by tmdb or imdb id only", catalog.ErrUnsupported)
	}
	return "", fmt.Errorf("%w: fanart.tv finds series by tvdb id only", catalog.ErrUnsupported)
}

// Reads the kind and leading number of a tmdb or tvdb id, empty when malformed
func namedKind(namespace, id string) (kind, number string) {
	parts := strings.Split(id, "/")
	if len(parts) < 2 {
		return "", ""
	}
	for i, p := range parts[1:] {
		if n, err := strconv.ParseInt(p, 10, 64); err != nil || n < 0 || (i == 0 && n == 0) {
			return "", ""
		}
	}
	switch {
	case namespace == model.NSTMDB && parts[0] == "movie" && len(parts) == 2:
		kind = model.KindMovie
	case namespace == model.NSTMDB && parts[0] == "tv" && len(parts) <= 4:
		kind = []string{model.KindSeries, model.KindSeason, model.KindEpisode}[len(parts)-2]
	case namespace == model.NSTVDB && len(parts) == 2:
		kind = map[string]string{"movie": model.KindMovie, "series": model.KindSeries, "season": model.KindSeason, "episode": model.KindEpisode}[parts[0]]
	}
	if kind == "" {
		return "", ""
	}
	return kind, parts[1]
}

// Always fails because fanart.tv has no title search
func (s *Source) Search(context.Context, string, string, int) ([]model.Claim, error) {
	return nil, errSearch
}

// Appends claims about the record a lookup named
type claimer struct {
	kind, namespace, id, recordID string
	out                           *[]model.Claim
}

func (c claimer) put(field string, value any) {
	*c.out = append(*c.out, model.Claim{Kind: c.kind, Namespace: c.namespace, ExternalID: c.id, Field: field, Value: value, RecordID: c.recordID})
}

// Reads a like count sent as a JSON string or number
type likes int

func (l *likes) UnmarshalJSON(b []byte) error {
	raw := string(bytes.Trim(b, `"`))
	if raw == "" || raw == "null" {
		*l = 0
		return nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fmt.Errorf("fanart: likes %s: %w", b, err)
	}
	*l = likes(n)
	return nil
}

type item struct {
	URL   string `json:"url"`
	Lang  string `json:"lang"`
	Likes likes  `json:"likes"`
}

type response struct {
	TMDBID          string `json:"tmdb_id"`
	IMDbID          string `json:"imdb_id"`
	MoviePoster     []item `json:"movieposter"`
	MovieBackground []item `json:"moviebackground"`
	HDMovieLogo     []item `json:"hdmovielogo"`
	MovieLogo       []item `json:"movielogo"`
	MovieBanner     []item `json:"moviebanner"`
	MovieThumb      []item `json:"moviethumb"`
	TVPoster        []item `json:"tvposter"`
	ShowBackground  []item `json:"showbackground"`
	HDTVLogo        []item `json:"hdtvlogo"`
	ClearLogo       []item `json:"clearlogo"`
	TVBanner        []item `json:"tvbanner"`
	TVThumb         []item `json:"tvthumb"`
}

// Keeps artwork in the configured language or without text, scored by likes on a zero to ten scale
func images(lang string, lists ...[]item) []model.Image {
	var out []model.Image
	for _, list := range lists {
		for _, it := range list {
			l := it.Lang
			if l == "00" {
				l = ""
			}
			if it.URL == "" || (l != "" && l != lang) {
				continue
			}
			n := float64(it.Likes)
			out = append(out, model.Image{URL: it.URL, Language: l, Score: 10 * n / (n + 5)})
		}
	}
	return out
}

// Appends each artwork kind the response holds plus the ids it reports
func (r *response) claims(c claimer, lang string) {
	kinds := []struct {
		kind  string
		lists [][]item
	}{
		{"poster", [][]item{r.MoviePoster, r.TVPoster}},
		{"backdrop", [][]item{r.MovieBackground, r.ShowBackground}},
		{"logo", [][]item{r.HDMovieLogo, r.MovieLogo, r.HDTVLogo, r.ClearLogo}},
		{"banner", [][]item{r.MovieBanner, r.TVBanner}},
		{"thumb", [][]item{r.MovieThumb, r.TVThumb}},
	}
	for _, k := range kinds {
		if imgs := images(lang, k.lists...); len(imgs) > 0 {
			c.put(model.ArtworkField(k.kind), imgs)
		}
	}
	if imdbID.MatchString(r.IMDbID) {
		c.put(model.XIDField(model.NSIMDb), r.IMDbID)
	}
	if n, err := strconv.ParseInt(r.TMDBID, 10, 64); err == nil && n > 0 && c.kind == model.KindMovie {
		c.put(model.XIDField(model.NSTMDB), model.TMDBMovie(n))
	}
}
