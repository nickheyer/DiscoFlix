package datasets

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/datasetimport"
)

// Loader batch sizes and the token that keeps an FTS phrase from spanning two titles
const (
	batchRows    = 5000
	stmtRows     = 500
	progressRows = 50000
	diffChunk    = 50000
	titleJoin    = " \uE000 "
	nullField    = `\N`
)

// One live table a dataset fills, its unique key, the columns it writes, and the kind it owns
type table struct {
	name  string
	key   []string
	cols  []string
	scope string
}

func quote(id string) string { return "`" + id + "`" }

func (t table) list(prefix string, cols []string) string {
	parts := make([]string, len(cols))
	for i, c := range cols {
		parts[i] = prefix + quote(c)
	}
	return strings.Join(parts, ", ")
}

// Joins two aliases on every key column
func (t table) keyMatch(a, b string) string {
	parts := make([]string, len(t.key))
	for i, k := range t.key {
		parts[i] = a + "." + quote(k) + " = " + b + "." + quote(k)
	}
	return strings.Join(parts, " AND ")
}

// Matches two aliases on every written column outside the key
func (t table) valueMatch(a, b string) string {
	var parts []string
	for _, c := range t.cols {
		if !slices.Contains(t.key, c) {
			parts = append(parts, a+"."+quote(c)+" = "+b+"."+quote(c))
		}
	}
	if len(parts) == 0 {
		return "1"
	}
	return strings.Join(parts, " AND ")
}

func (t table) scopeFilter(alias string) string {
	if t.scope == "" {
		return ""
	}
	return " AND " + alias + ".`kind` = ?"
}

func (t table) scopeArgs(args ...any) []any {
	if t.scope == "" {
		return args
	}
	return append(args, t.scope)
}

// Reports whether the live table holds any row this dataset owns
func (t table) populated(ctx context.Context, q querier) (bool, error) {
	where := ""
	if t.scope != "" {
		where = " WHERE `kind` = ?"
	}
	var ok bool
	err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM "+quote(t.name)+where+")", t.scopeArgs()...).Scan(&ok)
	return ok, err
}

// Writes a multi-row upsert into the staging copy
func (t table) insertSQL(rows int) string {
	var b strings.Builder
	b.WriteString("INSERT OR REPLACE INTO staging." + quote(t.name) + " (" + t.list("", t.cols) + ") VALUES ")
	tuple := "(" + strings.TrimSuffix(strings.Repeat("?, ", len(t.cols)), ", ") + ")"
	for i := range rows {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(tuple)
	}
	return b.String()
}

// Collects the keys of live rows within a rowid range that the new file no longer holds
func (t table) goneSQL() string {
	return "INSERT INTO staging.gone (" + t.list("", t.key) + ") SELECT " + t.list("l.", t.key) +
		" FROM main." + quote(t.name) + " l WHERE l.rowid > ? AND l.rowid <= ?" + t.scopeFilter("l") +
		" AND NOT EXISTS (SELECT 1 FROM staging." + quote(t.name) + " s WHERE " + t.keyMatch("s", "l") + ")"
}

// Drops staged rows within a rowid range that already match their live copy
func (t table) pruneSQL() string {
	return "DELETE FROM staging." + quote(t.name) + " WHERE rowid IN (SELECT s.rowid FROM staging." + quote(t.name) +
		" s JOIN main." + quote(t.name) + " l ON " + t.keyMatch("l", "s") +
		" WHERE s.rowid > ? AND s.rowid <= ? AND " + t.valueMatch("l", "s") + ")"
}

func (t table) deleteSQL() string {
	return "DELETE FROM main." + quote(t.name) + " WHERE (" + t.list("", t.key) + ") IN (SELECT " + t.list("", t.key) + " FROM staging.gone)"
}

func (t table) copySQL() string {
	return "INSERT OR REPLACE INTO main." + quote(t.name) + " (" + t.list("", t.cols) + ") SELECT " + t.list("", t.cols) + " FROM staging." + quote(t.name)
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// FTS maintenance keyed by the numeric part of the tconst so changed titles are replaced by rowid
const (
	ftsHasTitles = "SELECT EXISTS(SELECT 1 FROM main.`im_db_titles`)"
	ftsClear     = "DELETE FROM main.`imdb_title_fts`"
	ftsDrop      = "DELETE FROM main.`imdb_title_fts` WHERE rowid IN (SELECT CAST(substr(`id`, 3) AS INTEGER) FROM staging.gone UNION ALL SELECT CAST(substr(`id`, 3) AS INTEGER) FROM staging.`im_db_titles`)"
	ftsFill      = "INSERT INTO main.`imdb_title_fts` (rowid, `tconst`, `title`) SELECT CAST(substr(`id`, 3) AS INTEGER), `id`, " +
		"CASE WHEN `original_title` <> '' AND `original_title` <> `primary_title` THEN `primary_title` || ? || `original_title` ELSE `primary_title` END " +
		"FROM staging.`im_db_titles` WHERE `title_type` <> 'tvEpisode'"
	recordImport = "INSERT INTO main.`dataset_imports` (`id`, `state`, `rows`, `bytes`, `error`, `etag`, `last_modified`, `finished_at`, `updated_at`) " +
		"VALUES (?, ?, ?, ?, '', ?, ?, ?, ?) ON CONFLICT (`id`) DO UPDATE SET `state` = excluded.`state`, `rows` = excluded.`rows`, " +
		"`bytes` = excluded.`bytes`, `error` = '', `etag` = excluded.`etag`, `last_modified` = excluded.`last_modified`, " +
		"`finished_at` = excluded.`finished_at`, `updated_at` = excluded.`updated_at`"
)

// Counts compressed bytes read from the downloaded file
type counter struct {
	r io.Reader
	n int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// Fills an attached staging database from the file, diffs it against the live rows, and swaps the change in
func (s *Service) load(ctx context.Context, d *dataset, f fetched, progress func(rows, bytes int64)) (int64, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = conn.Close() }()
	stage := s.stagingPath(d)
	if _, err := conn.ExecContext(ctx, "ATTACH DATABASE ? AS staging", stage); err != nil {
		return 0, fmt.Errorf("attach staging: %w", err)
	}
	defer func() {
		if _, err := conn.ExecContext(context.WithoutCancel(ctx), "DETACH DATABASE staging"); err != nil {
			s.log.Warn("detach dataset staging", "dataset", d.info.Name, "error", err)
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		for _, p := range stagingFiles(stage) {
			if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
				s.log.Warn("remove dataset staging", "path", p, "error", err)
			}
		}
	}()
	if err := createStaging(ctx, conn, d.table); err != nil {
		return 0, err
	}
	rows, err := fill(ctx, conn, d, f.path, progress)
	if err != nil {
		return 0, err
	}
	if err := diff(ctx, conn, d.table); err != nil {
		return 0, err
	}
	changed, removed, err := s.swap(ctx, conn, d, rows, f)
	if err != nil {
		return 0, err
	}
	s.log.Info("dataset imported", "dataset", d.info.Name, "rows", rows, "bytes", f.bytes, "changed", changed, "removed", removed)
	return rows, nil
}

// Copies the live table shape and its unique indexes into a staging database that skips disk syncs
func createStaging(ctx context.Context, conn *sql.Conn, t table) error {
	for _, p := range []string{"PRAGMA staging.journal_mode = MEMORY", "PRAGMA staging.synchronous = OFF"} {
		if _, err := conn.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
	}
	rows, err := conn.QueryContext(ctx, "SELECT `sql` FROM main.sqlite_master WHERE `tbl_name` = ? AND `sql` IS NOT NULL AND (`type` = 'table' OR `sql` LIKE 'CREATE UNIQUE INDEX %') ORDER BY `type` DESC", t.name)
	if err != nil {
		return err
	}
	var ddl []string
	for rows.Next() {
		var stmt string
		if err := rows.Scan(&stmt); err != nil {
			_ = rows.Close()
			return err
		}
		if stmt, err = stagingDDL(stmt); err != nil {
			_ = rows.Close()
			return err
		}
		ddl = append(ddl, stmt)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	if len(ddl) == 0 {
		return fmt.Errorf("table %s is missing, run the migrations", t.name)
	}
	for _, stmt := range append(ddl, "CREATE TABLE staging.gone ("+t.list("", t.key)+")") {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("create staging copy of %s: %w", t.name, err)
		}
	}
	return nil
}

// Qualifies a live CREATE TABLE or CREATE UNIQUE INDEX statement with the staging schema
func stagingDDL(stmt string) (string, error) {
	for _, prefix := range []string{"CREATE TABLE ", "CREATE UNIQUE INDEX "} {
		if rest, ok := strings.CutPrefix(stmt, prefix); ok {
			return prefix + "staging." + rest, nil
		}
	}
	return "", fmt.Errorf("unexpected schema statement %q", stmt)
}

// Streams the gzip file into staging in batches, reporting progress after every batch that crosses a step
func fill(ctx context.Context, conn *sql.Conn, d *dataset, path string, progress func(rows, bytes int64)) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = file.Close() }()
	src := &counter{r: file}
	gz, err := gzip.NewReader(bufio.NewReaderSize(src, 1<<20))
	if err != nil {
		return 0, fmt.Errorf("open gzip: %w", err)
	}
	defer func() { _ = gz.Close() }()
	var rows int64
	batch := make([][]any, 0, batchRows)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := insertBatch(ctx, conn, d.table, batch); err != nil {
			return err
		}
		rows += int64(len(batch))
		batch = batch[:0]
		if rows%progressRows == 0 {
			progress(rows, src.n)
		}
		return nil
	}
	err = d.read(gz, func(row []any) error {
		batch = append(batch, row)
		if len(batch) == batchRows {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	if err != nil {
		return 0, err
	}
	progress(rows, src.n)
	if rows == 0 {
		return 0, fmt.Errorf("%s held no rows", d.info.Name)
	}
	return rows, nil
}

// Upserts one batch into staging in a single transaction
func insertBatch(ctx context.Context, conn *sql.Conn, t table, batch [][]any) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for i := 0; i < len(batch); i += stmtRows {
		part := batch[i:min(i+stmtRows, len(batch))]
		args := make([]any, 0, len(part)*len(t.cols))
		for _, r := range part {
			args = append(args, r...)
		}
		if _, err := tx.ExecContext(ctx, t.insertSQL(len(part)), args...); err != nil {
			return fmt.Errorf("stage %s: %w", t.name, err)
		}
	}
	return tx.Commit()
}

// Records vanished keys and drops unchanged staged rows in short rowid ranges so writers interleave
func diff(ctx context.Context, conn *sql.Conn, t table) error {
	steps := []struct {
		schema string
		stmt   string
		scoped bool
	}{{"main", t.goneSQL(), true}, {"staging", t.pruneSQL(), false}}
	for _, step := range steps {
		var top int64
		if err := conn.QueryRowContext(ctx, "SELECT COALESCE(MAX(rowid), 0) FROM "+step.schema+"."+quote(t.name)).Scan(&top); err != nil {
			return err
		}
		for lo := int64(0); lo < top; lo += diffChunk {
			args := []any{lo, lo + diffChunk}
			if step.scoped {
				args = t.scopeArgs(args...)
			}
			if _, err := conn.ExecContext(ctx, step.stmt, args...); err != nil {
				return fmt.Errorf("diff %s: %w", t.name, err)
			}
		}
	}
	return nil
}

// Applies removals and changed rows, maintains the title index, and records the import in one transaction
func (s *Service) swap(ctx context.Context, conn *sql.Conn, d *dataset, rows int64, f fetched) (changed, removed int64, err error) {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if d.fts {
		var live bool
		if err := tx.QueryRowContext(ctx, ftsHasTitles).Scan(&live); err != nil {
			return 0, 0, err
		}
		stmt := ftsDrop
		if !live {
			stmt = ftsClear
		}
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return 0, 0, fmt.Errorf("clear title index: %w", err)
		}
	}
	res, err := tx.ExecContext(ctx, d.table.deleteSQL())
	if err != nil {
		return 0, 0, fmt.Errorf("remove vanished rows: %w", err)
	}
	if removed, err = res.RowsAffected(); err != nil {
		return 0, 0, err
	}
	if res, err = tx.ExecContext(ctx, d.table.copySQL()); err != nil {
		return 0, 0, fmt.Errorf("copy staged rows: %w", err)
	}
	if changed, err = res.RowsAffected(); err != nil {
		return 0, 0, err
	}
	if d.fts {
		if _, err := tx.ExecContext(ctx, ftsFill, titleJoin); err != nil {
			return 0, 0, fmt.Errorf("fill title index: %w", err)
		}
	}
	now := s.now()
	var modified any
	if !f.modified.IsZero() {
		modified = f.modified
	}
	if _, err := tx.ExecContext(ctx, recordImport, d.info.Name, datasetimport.StateDone.String(), rows, f.bytes, f.etag, modified, now, now); err != nil {
		return 0, 0, fmt.Errorf("record import: %w", err)
	}
	return changed, removed, tx.Commit()
}

// Column headers of the IMDb files, checked so a format change fails loudly
var (
	basicsHeader  = []string{"tconst", "titleType", "primaryTitle", "originalTitle", "isAdult", "startYear", "endYear", "runtimeMinutes", "genres"}
	ratingsHeader = []string{"tconst", "averageRating", "numVotes"}
	akasHeader    = []string{"titleId", "ordering", "title", "region", "language", "types", "attributes", "isOriginalTitle"}
	episodeHeader = []string{"tconst", "parentTconst", "seasonNumber", "episodeNumber"}
)

func newScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	return sc
}

// Reads a tab separated file with a header row, converting every line into staging values
func tsv(header []string, convert func(f []string) ([]any, error)) func(io.Reader, func([]any) error) error {
	want := strings.Join(header, "\t")
	return func(r io.Reader, emit func([]any) error) error {
		sc := newScanner(r)
		if !sc.Scan() {
			if err := sc.Err(); err != nil {
				return err
			}
			return errors.New("the file is empty")
		}
		if got := strings.TrimSuffix(sc.Text(), "\r"); got != want {
			return fmt.Errorf("unexpected header %q", got)
		}
		for line := 2; sc.Scan(); line++ {
			fields := strings.Split(strings.TrimSuffix(sc.Text(), "\r"), "\t")
			if len(fields) != len(header) {
				return fmt.Errorf("line %d has %d fields, expected %d", line, len(fields), len(header))
			}
			row, err := convert(fields)
			if err != nil {
				return fmt.Errorf("line %d: %w", line, err)
			}
			if err := emit(row); err != nil {
				return err
			}
		}
		return sc.Err()
	}
}

// Reports whether a value is a tt prefixed IMDb title id
func validTconst(s string) bool {
	if len(s) < 3 || !strings.HasPrefix(s, "tt") {
		return false
	}
	for _, r := range s[2:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func text(s string) string {
	if s == nullField {
		return ""
	}
	return s
}

func number(s string) (int64, error) {
	if s == nullField {
		return 0, nil
	}
	return strconv.ParseInt(s, 10, 32)
}

func decimal(s string) (float64, error) {
	if s == nullField {
		return 0, nil
	}
	return strconv.ParseFloat(s, 64)
}

func flag(s string) (bool, error) {
	switch s {
	case "0", nullField:
		return false, nil
	case "1":
		return true, nil
	}
	return false, fmt.Errorf("flag %q is neither 0 nor 1", s)
}

func titleID(s string) (string, error) {
	if !validTconst(s) {
		return "", fmt.Errorf("%q is not an IMDb title id", s)
	}
	return s, nil
}

// Converts one title.basics line, normalizing the primary title
func basicsRow(f []string) ([]any, error) {
	id, err := titleID(f[0])
	if err != nil {
		return nil, err
	}
	adult, err := flag(f[4])
	if err != nil {
		return nil, err
	}
	nums := make([]int64, 3)
	for i, raw := range f[5:8] {
		if nums[i], err = number(raw); err != nil {
			return nil, fmt.Errorf("%s %q: %w", basicsHeader[5+i], raw, err)
		}
	}
	primary := text(f[2])
	return []any{id, text(f[1]), primary, text(f[3]), model.Normalize(primary), adult, nums[0], nums[1], nums[2], text(f[8])}, nil
}

// Converts one title.ratings line
func ratingsRow(f []string) ([]any, error) {
	id, err := titleID(f[0])
	if err != nil {
		return nil, err
	}
	rating, err := decimal(f[1])
	if err != nil {
		return nil, fmt.Errorf("averageRating %q: %w", f[1], err)
	}
	votes, err := number(f[2])
	if err != nil {
		return nil, fmt.Errorf("numVotes %q: %w", f[2], err)
	}
	return []any{id, rating, votes}, nil
}

// Converts one title.akas line, normalizing the alternative title
func akasRow(f []string) ([]any, error) {
	id, err := titleID(f[0])
	if err != nil {
		return nil, err
	}
	ordering, err := number(f[1])
	if err != nil {
		return nil, fmt.Errorf("ordering %q: %w", f[1], err)
	}
	original, err := flag(f[7])
	if err != nil {
		return nil, err
	}
	title := text(f[2])
	return []any{id, ordering, title, model.Normalize(title), text(f[3]), text(f[4]), text(f[5]), original}, nil
}

// Converts one title.episode line, unknown seasons and numbers become zero
func episodeRow(f []string) ([]any, error) {
	id, err := titleID(f[0])
	if err != nil {
		return nil, err
	}
	parent, err := titleID(f[1])
	if err != nil {
		return nil, err
	}
	season, err := number(f[2])
	if err != nil {
		return nil, fmt.Errorf("seasonNumber %q: %w", f[2], err)
	}
	episode, err := number(f[3])
	if err != nil {
		return nil, fmt.Errorf("episodeNumber %q: %w", f[3], err)
	}
	return []any{id, parent, season, episode}, nil
}

// One line of a TMDB daily id export, movies carry original_title and series original_name
type exportLine struct {
	ID            int64   `json:"id"`
	OriginalTitle string  `json:"original_title"`
	OriginalName  string  `json:"original_name"`
	Popularity    float64 `json:"popularity"`
	Adult         bool    `json:"adult"`
	Video         bool    `json:"video"`
}

// Reads a TMDB export of one JSON object per line into staging values of one kind
func exportReader(kind string) func(io.Reader, func([]any) error) error {
	return func(r io.Reader, emit func([]any) error) error {
		sc := newScanner(r)
		for line := 1; sc.Scan(); line++ {
			raw := bytes.TrimSpace(sc.Bytes())
			if len(raw) == 0 {
				continue
			}
			var e exportLine
			if err := json.Unmarshal(raw, &e); err != nil {
				return fmt.Errorf("line %d: %w", line, err)
			}
			if e.ID <= 0 {
				return fmt.Errorf("line %d has no id", line)
			}
			title := e.OriginalTitle
			if kind == model.KindSeries {
				title = e.OriginalName
			}
			if err := emit([]any{kind, e.ID, title, model.Normalize(title), e.Popularity, e.Adult, e.Video}); err != nil {
				return err
			}
		}
		return sc.Err()
	}
}
