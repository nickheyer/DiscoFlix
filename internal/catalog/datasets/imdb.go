package datasets

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
)

const searchLimit = 10

// IMDb title types grouped by the catalog kind they resolve to
var kindTypes = map[string][]string{
	model.KindMovie:   {"movie", "tvMovie", "short", "video", "tvShort", "tvSpecial"},
	model.KindSeries:  {"tvSeries", "tvMiniSeries"},
	model.KindEpisode: {"tvEpisode"},
}

// Maps an IMDb title type to its catalog kind, empty for types the catalog does not resolve
func kindOf(titleType string) string {
	for kind, types := range kindTypes {
		if slices.Contains(types, titleType) {
			return kind
		}
	}
	return ""
}

// Answers lookups and searches from the loaded IMDb datasets
type imdbSource struct {
	db *sql.DB
}

func (*imdbSource) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.imdb", Name: "IMDb datasets", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (*imdbSource) Name() string { return catalog.SourceIMDb }

func (*imdbSource) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceIMDb, Title: "IMDb datasets", License: imdbLicense}
}

func (*imdbSource) Namespaces() []string { return []string{model.NSIMDb} }

func (*imdbSource) Kinds() []string {
	return []string{model.KindMovie, model.KindSeries, model.KindSeason, model.KindEpisode}
}

func (*imdbSource) NeedsKey() bool  { return false }
func (*imdbSource) Artwork() bool   { return false }
func (*imdbSource) KeyHint() string { return "" }
func (*imdbSource) License() string { return imdbLicense }
func (*imdbSource) Local() bool     { return true }

// Accepts any keys and options since lookups and searches read only the loaded tables
func (*imdbSource) Configure(catalog.Keys, map[string]string) error {
	return nil
}

// Fails until title.basics has been loaded
func (s *imdbSource) ready(ctx context.Context) error {
	var ok bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM `im_db_titles`)").Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: the IMDb datasets are not imported yet, run the imdb.basics import", ErrNotImported)
	}
	return nil
}

// Fails until title.episode has been loaded
func (s *imdbSource) episodesReady(ctx context.Context) error {
	var ok bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM `im_db_episodes`)").Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: the IMDb episode dataset is not imported yet, run the imdb.episode import", ErrNotImported)
	}
	return nil
}

// Splits a season id of the form series tconst slash season number
func seasonID(id string) (series string, season int, ok bool) {
	series, raw, found := strings.Cut(id, "/")
	if !found || !validTconst(series) {
		return "", 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return "", 0, false
	}
	return series, n, true
}

func seasonValue(series string, season int) string { return series + "/" + strconv.Itoa(season) }

// Reads one title, or one season with its episodes, as claim groups
func (s *imdbSource) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	if namespace != model.NSIMDb {
		return nil, fmt.Errorf("%w: imdb has no %s ids", catalog.ErrUnsupported, namespace)
	}
	if kind != "" && !model.ValidKind(kind) {
		return nil, fmt.Errorf("%w: %s", catalog.ErrBadKind, kind)
	}
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if series, season, ok := seasonID(id); ok {
		if kind != "" && kind != model.KindSeason {
			return nil, nil
		}
		return s.season(ctx, series, season)
	}
	if !validTconst(id) {
		return nil, fmt.Errorf("imdb: %q is neither a title id nor a season id", id)
	}
	if kind == model.KindSeason {
		return nil, nil
	}
	rows, err := s.titles(ctx, titleFrom+" WHERE t.`id` = ?", id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	r := rows[0]
	k := kindOf(r.titleType)
	if k == "" || (kind != "" && k != kind) {
		return nil, nil
	}
	if k == model.KindEpisode {
		if err := s.episodesReady(ctx); err != nil {
			return nil, err
		}
	}
	claims, err := s.claims(ctx, r, k)
	if err != nil {
		return nil, err
	}
	if k == model.KindEpisode && r.parent != "" && r.season > 0 {
		claims = append(claims, seasonClaims(r.parent, r.season)...)
	}
	return claims, nil
}

// Reads a season group followed by one child group per episode in episode order
func (s *imdbSource) season(ctx context.Context, series string, season int) ([]model.Claim, error) {
	if err := s.episodesReady(ctx); err != nil {
		return nil, err
	}
	rows, err := s.titles(ctx, episodeFrom+" WHERE e.`parent` = ? AND e.`season` = ? ORDER BY e.`episode`, e.`id`", series, season)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	claims := seasonClaims(series, season)
	for _, r := range rows {
		c, err := s.claims(ctx, r, model.KindEpisode)
		if err != nil {
			return nil, err
		}
		claims = append(claims, c...)
	}
	return claims, nil
}

// Finds movies and series, or episodes when asked, by exact title or alias then by indexed phrase, most voted first
func (s *imdbSource) Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	var types []string
	switch kind {
	case "":
		types = append(slices.Clone(kindTypes[model.KindMovie]), kindTypes[model.KindSeries]...)
	case model.KindMovie, model.KindSeries:
		types = kindTypes[kind]
	case model.KindEpisode:
		if err := s.episodesReady(ctx); err != nil {
			return nil, err
		}
		types = kindTypes[kind]
	case model.KindSeason:
		return nil, fmt.Errorf("%w: IMDb seasons have no titles to search", catalog.ErrUnsupported)
	default:
		return nil, fmt.Errorf("%w: %s", catalog.ErrBadKind, kind)
	}
	norm := model.Normalize(text)
	if norm == "" {
		return nil, nil
	}
	filter := " AND t.`title_type` IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(types)), ", ") + ")"
	var args []any
	for _, t := range types {
		args = append(args, t)
	}
	if year > 0 {
		filter += " AND t.`start_year` BETWEEN ? AND ?"
		args = append(args, year-1, year+1)
	}
	const order = " ORDER BY COALESCE(r.`votes`, 0) DESC, t.`start_year`, t.`id` LIMIT ?"
	exactArgs := append(append([]any{norm, norm}, args...), searchLimit)
	found, err := s.titles(ctx, titleFrom+" WHERE (t.`normalized` = ? OR t.`id` IN (SELECT `tconst` FROM `im_db_akas` WHERE `normalized` = ?))"+filter+order, exactArgs...)
	if err != nil {
		return nil, err
	}
	if kind != model.KindEpisode {
		phrase := `"` + strings.ReplaceAll(strings.ReplaceAll(text, strings.TrimSpace(titleJoin), " "), `"`, `""`) + `"`
		ftsArgs := append(append([]any{phrase}, args...), searchLimit+len(found))
		fuzzy, err := s.titles(ctx, ftsFrom+" WHERE `imdb_title_fts` MATCH ?"+filter+order, ftsArgs...)
		if err != nil {
			return nil, fmt.Errorf("imdb: title search: %w", err)
		}
		for _, r := range fuzzy {
			if len(found) < searchLimit && !slices.ContainsFunc(found, func(f titleRow) bool { return f.id == r.id }) {
				found = append(found, r)
			}
		}
	}
	var claims []model.Claim
	for _, r := range found {
		c, err := s.claims(ctx, r, kindOf(r.titleType))
		if err != nil {
			return nil, err
		}
		claims = append(claims, c...)
	}
	return claims, nil
}

// One title joined with its rating and episode position
type titleRow struct {
	id, titleType, primary, original, genres, parent string
	year, runtime, votes, season, episode            int
	rated                                            bool
	rating                                           float64
}

// Selected columns shared by title, season, and index queries, tolerating episodes missing from title.basics
const (
	titleCols = "SELECT COALESCE(t.`id`, e.`id`), COALESCE(t.`title_type`, ''), COALESCE(t.`primary_title`, ''), COALESCE(t.`original_title`, ''), " +
		"COALESCE(t.`start_year`, 0), COALESCE(t.`runtime`, 0), COALESCE(t.`genres`, ''), r.`id` IS NOT NULL, COALESCE(r.`rating`, 0), " +
		"COALESCE(r.`votes`, 0), COALESCE(e.`parent`, ''), COALESCE(e.`season`, 0), COALESCE(e.`episode`, 0)"
	titleFrom   = titleCols + " FROM `im_db_titles` t LEFT JOIN `im_db_ratings` r ON r.`id` = t.`id` LEFT JOIN `im_db_episodes` e ON e.`id` = t.`id`"
	episodeFrom = titleCols + " FROM `im_db_episodes` e LEFT JOIN `im_db_titles` t ON t.`id` = e.`id` LEFT JOIN `im_db_ratings` r ON r.`id` = e.`id`"
	ftsFrom     = titleCols + " FROM `imdb_title_fts` JOIN `im_db_titles` t ON t.`id` = `imdb_title_fts`.`tconst` LEFT JOIN `im_db_ratings` r ON r.`id` = t.`id` LEFT JOIN `im_db_episodes` e ON e.`id` = t.`id`"
)

func (s *imdbSource) titles(ctx context.Context, query string, args ...any) ([]titleRow, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []titleRow
	for rows.Next() {
		var r titleRow
		if err := rows.Scan(&r.id, &r.titleType, &r.primary, &r.original, &r.year, &r.runtime, &r.genres, &r.rated, &r.rating, &r.votes, &r.parent, &r.season, &r.episode); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Distinct alternative titles of a title in IMDb order, leaving out its primary and original titles
func (s *imdbSource) aliases(ctx context.Context, r titleRow) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT `title` FROM `im_db_akas` WHERE `tconst` = ? ORDER BY `ordering`", r.id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		if t != "" && t != r.primary && t != r.original && !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

// Builds the claims of one external record
type group struct {
	kind, namespace, id string
	claims              []model.Claim
}

func (g *group) add(field string, value any) {
	g.claims = append(g.claims, model.Claim{Kind: g.kind, Namespace: g.namespace, ExternalID: g.id, Field: field, Value: value, Confidence: 1})
}

// Claims of one title, with episode number and season parent when it is an episode
func (s *imdbSource) claims(ctx context.Context, r titleRow, kind string) ([]model.Claim, error) {
	aliases, err := s.aliases(ctx, r)
	if err != nil {
		return nil, err
	}
	g := &group{kind: kind, namespace: model.NSIMDb, id: r.id}
	if r.primary != "" {
		g.add(model.FieldTitle, r.primary)
	}
	if r.original != "" {
		g.add(model.FieldOriginalTitle, r.original)
	}
	if r.year > 0 {
		g.add(model.FieldYear, r.year)
	}
	if r.runtime > 0 {
		g.add(model.FieldRuntime, r.runtime)
	}
	if r.genres != "" {
		g.add(model.FieldGenres, strings.Split(r.genres, ","))
	}
	if r.rated {
		g.add(model.RatingField(catalog.SourceIMDb), r.rating)
		g.add(model.VotesField(catalog.SourceIMDb), r.votes)
	}
	if len(aliases) > 0 {
		g.add(model.FieldAliases, aliases)
	}
	g.add(model.XIDField(model.NSIMDb), r.id)
	if kind == model.KindEpisode {
		if r.episode > 0 {
			g.add(model.FieldOrdinal, r.episode)
		}
		if r.parent != "" && r.season > 0 {
			g.add(model.ParentXIDField(model.NSIMDb), seasonValue(r.parent, r.season))
		}
	}
	return g.claims, nil
}

// Claims of a season, which IMDb identifies only by its series and number
func seasonClaims(series string, season int) []model.Claim {
	g := &group{kind: model.KindSeason, namespace: model.NSIMDb, id: seasonValue(series, season)}
	g.add(model.FieldOrdinal, season)
	g.add(model.ParentXIDField(model.NSIMDb), series)
	return g.claims
}
