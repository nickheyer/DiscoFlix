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

// Answers lookups and searches from the loaded TMDB daily id exports
type tmdbSource struct {
	db *sql.DB
}

func (*tmdbSource) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.tmdbexport", Name: "TMDB daily exports", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (*tmdbSource) Name() string { return catalog.SourceTMDBExport }

func (*tmdbSource) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceTMDBExport, Title: "TMDB daily exports", License: tmdbLicense}
}

func (*tmdbSource) Namespaces() []string { return []string{model.NSTMDB} }

func (*tmdbSource) Kinds() []string { return []string{model.KindMovie, model.KindSeries} }
func (*tmdbSource) NeedsKey() bool  { return false }
func (*tmdbSource) Artwork() bool   { return false }
func (*tmdbSource) KeyHint() string { return "" }
func (*tmdbSource) License() string { return tmdbLicense }
func (*tmdbSource) Local() bool     { return true }

// Accepts any keys and options since lookups and searches read only the loaded tables
func (*tmdbSource) Configure(catalog.Keys, map[string]string) error {
	return nil
}

// Fails until the export of a kind has been loaded
func (s *tmdbSource) ready(ctx context.Context, kind string) error {
	var ok bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM `tmdb_exports` WHERE `kind` = ?)", kind).Scan(&ok); err != nil {
		return err
	}
	if ok {
		return nil
	}
	if kind == model.KindSeries {
		return fmt.Errorf("%w: the TMDB series export is not imported yet, run the tmdb.series import", ErrNotImported)
	}
	return fmt.Errorf("%w: the TMDB movie export is not imported yet, run the tmdb.movies import", ErrNotImported)
}

// Checks a requested kind, empty meaning movies and series together
func exportKinds(kind string) ([]string, error) {
	switch kind {
	case "":
		return []string{model.KindMovie, model.KindSeries}, nil
	case model.KindMovie, model.KindSeries:
		return []string{kind}, nil
	case model.KindSeason, model.KindEpisode:
		return nil, fmt.Errorf("%w: TMDB exports list no %s records", catalog.ErrUnsupported, kind)
	}
	return nil, fmt.Errorf("%w: %s", catalog.ErrBadKind, kind)
}

// Splits movie slash id or tv slash id into its kind and number
func parseTMDB(id string) (string, int64, error) {
	prefix, rest := model.SplitValue(id)
	kind := ""
	switch prefix {
	case "movie":
		kind = model.KindMovie
	case "tv":
		kind = model.KindSeries
	default:
		return "", 0, fmt.Errorf("tmdbexport: %q is not a TMDB movie or series id", id)
	}
	if prefix == "tv" && strings.Contains(rest, "/") {
		return "", 0, fmt.Errorf("%w: TMDB exports list no seasons or episodes, %q", catalog.ErrUnsupported, id)
	}
	n, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || n < 1 {
		return "", 0, fmt.Errorf("tmdbexport: %q is not a TMDB movie or series id", id)
	}
	return kind, n, nil
}

// Reads one exported movie or series as a claim group
func (s *tmdbSource) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	if namespace != model.NSTMDB {
		return nil, fmt.Errorf("%w: tmdbexport has no %s ids", catalog.ErrUnsupported, namespace)
	}
	if kind != "" {
		if _, err := exportKinds(kind); err != nil {
			return nil, err
		}
	}
	k, n, err := parseTMDB(id)
	if err != nil {
		return nil, err
	}
	if kind != "" && kind != k {
		return nil, nil
	}
	if err := s.ready(ctx, k); err != nil {
		return nil, err
	}
	rows, err := s.rows(ctx, exportSelect+"WHERE `kind` = ? AND `tmdb_id` = ?", k, n)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0].claims(), nil
}

// Finds exported titles by exact normalized title, then by normalized prefix, most popular first
func (s *tmdbSource) Search(ctx context.Context, kind, text string, _ int) ([]model.Claim, error) {
	kinds, err := exportKinds(kind)
	if err != nil {
		return nil, err
	}
	for _, k := range kinds {
		if err := s.ready(ctx, k); err != nil {
			return nil, err
		}
	}
	norm := model.Normalize(text)
	if norm == "" {
		return nil, nil
	}
	in := " AND `kind` IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(kinds)), ", ") + ") ORDER BY `popularity` DESC, `tmdb_id` LIMIT ?"
	args := func(head ...any) []any {
		for _, k := range kinds {
			head = append(head, k)
		}
		return head
	}
	found, err := s.rows(ctx, exportSelect+"WHERE `normalized` = ?"+in, append(args(norm), searchLimit)...)
	if err != nil {
		return nil, err
	}
	prefixed, err := s.rows(ctx, exportSelect+"WHERE `normalized` >= ? AND `normalized` < ?"+in, append(args(norm, norm+"\U0010FFFF"), searchLimit+len(found))...)
	if err != nil {
		return nil, err
	}
	for _, r := range prefixed {
		if len(found) < searchLimit && !slices.Contains(found, r) {
			found = append(found, r)
		}
	}
	var claims []model.Claim
	for _, r := range found {
		claims = append(claims, r.claims()...)
	}
	return claims, nil
}

// One exported movie or series
type exportRow struct {
	kind       string
	id         int64
	title      string
	popularity float64
}

const exportSelect = "SELECT `kind`, `tmdb_id`, `original_title`, `popularity` FROM `tmdb_exports` "

func (s *tmdbSource) rows(ctx context.Context, query string, args ...any) ([]exportRow, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []exportRow
	for rows.Next() {
		var r exportRow
		if err := rows.Scan(&r.kind, &r.id, &r.title, &r.popularity); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Original title, popularity, and TMDB id of one exported record
func (r exportRow) claims() []model.Claim {
	value := model.TMDBMovie(r.id)
	if r.kind == model.KindSeries {
		value = model.TMDBSeries(r.id)
	}
	g := &group{kind: r.kind, namespace: model.NSTMDB, id: value}
	if r.title != "" {
		g.add(model.FieldOriginalTitle, r.title)
	}
	g.add(model.FieldPopularity, r.popularity)
	g.add(model.XIDField(model.NSTMDB), value)
	return g.claims
}
