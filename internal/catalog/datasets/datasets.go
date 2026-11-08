// Loads the IMDb and TMDB bulk files into local tables and answers catalog lookups from them
package datasets

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/imdbaka"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/imdbepisode"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/imdbrating"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/imdbtitle"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/tmdbexport"
)

// Download policies, hosts, and licenses of the bulk files
const (
	imdbPolicy      = "imdb-datasets"
	tmdbPolicy      = "tmdb-exports"
	imdbBase        = "https://datasets.imdbws.com/"
	tmdbBase        = "https://files.tmdb.org/p/exports/"
	imdbLicense     = "IMDb Non-Commercial Licensing, personal and non-commercial use only, never redistributed"
	tmdbLicense     = "TMDB API terms, not endorsed or certified by TMDB"
	downloadTimeout = 30 * time.Minute
	exportDays      = 4
)

// Returned by a source whose dataset has never been loaded
var ErrNotImported = fmt.Errorf("%w: datasets not imported", catalog.ErrNoData)

// One bulk file, where it comes from, and the table it fills
type dataset struct {
	info   catalog.DatasetInfo
	policy string
	file   string
	daily  bool
	table  table
	read   func(r io.Reader, emit func(row []any) error) error
	fts    bool
	lock   chan struct{}
}

// Waits until no other import of the same dataset runs
func (d *dataset) acquire(ctx context.Context) error {
	select {
	case d.lock <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *dataset) release() { <-d.lock }

// Downloads the bulk datasets and serves the two local sources over them
type Service struct {
	db     *sql.DB
	ent    *ent.Client
	client *outbound.Client
	dir    string
	log    *slog.Logger
	now    func() time.Time
	sets   []*dataset
	imdb   *imdbSource
	tmdb   *tmdbSource
}

// Registers the download policies and describes every dataset in display order
func New(db *sql.DB, entc *ent.Client, client *outbound.Client, dir string, log *slog.Logger) *Service {
	client.Register(outbound.Policy{Name: imdbPolicy, Title: "IMDb dataset downloads", Rate: 1, Burst: 1, Timeout: downloadTimeout, License: imdbLicense})
	client.Register(outbound.Policy{Name: tmdbPolicy, Title: "TMDB export downloads", Rate: 1, Burst: 1, Timeout: downloadTimeout, License: tmdbLicense})
	s := &Service{db: db, ent: entc, client: client, dir: dir, log: log, now: time.Now, imdb: &imdbSource{db: db}, tmdb: &tmdbSource{db: db}}
	imdbFile := func(name, title, file string, def bool, t table, read func(io.Reader, func([]any) error) error, fts bool) *dataset {
		return &dataset{
			info:   catalog.DatasetInfo{Name: name, Title: title, License: imdbLicense, URL: imdbBase + file, Default: def},
			policy: imdbPolicy, file: file, table: t, read: read, fts: fts, lock: make(chan struct{}, 1),
		}
	}
	tmdbFile := func(name, title, prefix, kind string) *dataset {
		return &dataset{
			info:   catalog.DatasetInfo{Name: name, Title: title, License: tmdbLicense, URL: tmdbBase + prefix + "_MM_DD_YYYY.json.gz", Default: true},
			policy: tmdbPolicy, file: prefix, daily: true, read: exportReader(kind), lock: make(chan struct{}, 1),
			table: table{
				name:  tmdbexport.Table,
				key:   []string{tmdbexport.FieldKind, tmdbexport.FieldTmdbID},
				cols:  []string{tmdbexport.FieldKind, tmdbexport.FieldTmdbID, tmdbexport.FieldOriginalTitle, tmdbexport.FieldNormalized, tmdbexport.FieldPopularity, tmdbexport.FieldAdult, tmdbexport.FieldVideo},
				scope: kind,
			},
		}
	}
	s.sets = []*dataset{
		imdbFile("imdb.basics", "IMDb title basics", "title.basics.tsv.gz", false, table{
			name: imdbtitle.Table,
			key:  []string{imdbtitle.FieldID},
			cols: []string{imdbtitle.FieldID, imdbtitle.FieldTitleType, imdbtitle.FieldPrimaryTitle, imdbtitle.FieldOriginalTitle, imdbtitle.FieldNormalized, imdbtitle.FieldAdult, imdbtitle.FieldStartYear, imdbtitle.FieldEndYear, imdbtitle.FieldRuntime, imdbtitle.FieldGenres},
		}, tsv(basicsHeader, basicsRow), true),
		imdbFile("imdb.ratings", "IMDb title ratings", "title.ratings.tsv.gz", false, table{
			name: imdbrating.Table,
			key:  []string{imdbrating.FieldID},
			cols: []string{imdbrating.FieldID, imdbrating.FieldRating, imdbrating.FieldVotes},
		}, tsv(ratingsHeader, ratingsRow), false),
		imdbFile("imdb.akas", "IMDb alternative titles", "title.akas.tsv.gz", false, table{
			name: imdbaka.Table,
			key:  []string{imdbaka.FieldTconst, imdbaka.FieldOrdering},
			cols: []string{imdbaka.FieldTconst, imdbaka.FieldOrdering, imdbaka.FieldTitle, imdbaka.FieldNormalized, imdbaka.FieldRegion, imdbaka.FieldLanguage, imdbaka.FieldTypes, imdbaka.FieldOriginal},
		}, tsv(akasHeader, akasRow), false),
		imdbFile("imdb.episode", "IMDb episodes", "title.episode.tsv.gz", false, table{
			name: imdbepisode.Table,
			key:  []string{imdbepisode.FieldID},
			cols: []string{imdbepisode.FieldID, imdbepisode.FieldParent, imdbepisode.FieldSeason, imdbepisode.FieldEpisode},
		}, tsv(episodeHeader, episodeRow), false),
		tmdbFile("tmdb.movies", "TMDB movie ids", "movie_ids", model.KindMovie),
		tmdbFile("tmdb.series", "TMDB series ids", "tv_series_ids", model.KindSeries),
	}
	return s
}

// Describes every dataset in display order
func (s *Service) List() []catalog.DatasetInfo {
	out := make([]catalog.DatasetInfo, 0, len(s.sets))
	for _, d := range s.sets {
		out = append(out, d.info)
	}
	return out
}

// Returns the IMDb and TMDB export sources that answer from the loaded tables
func (s *Service) Sources() []catalog.Source {
	return []catalog.Source{s.imdb, s.tmdb}
}

func (s *Service) dataset(name string) *dataset {
	for _, d := range s.sets {
		if d.info.Name == name {
			return d
		}
	}
	return nil
}

// One downloaded file, or the answer that the stored copy is still current
type fetched struct {
	path      string
	bytes     int64
	etag      string
	modified  time.Time
	unchanged bool
}

// Downloads a dataset when it changed and swaps its rows into the live table in one transaction
func (s *Service) Import(ctx context.Context, name string, progress func(rows, bytes int64)) (catalog.DatasetResult, error) {
	d := s.dataset(name)
	if d == nil {
		return catalog.DatasetResult{}, fmt.Errorf("%w: dataset %s", catalog.ErrNotFound, name)
	}
	if progress == nil {
		progress = func(int64, int64) {}
	}
	if err := d.acquire(ctx); err != nil {
		return catalog.DatasetResult{}, err
	}
	defer d.release()
	dir := filepath.Join(s.dir, "datasets")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return catalog.DatasetResult{}, fmt.Errorf("datasets: create %s: %w", dir, err)
	}
	if err := s.clean(dir, d); err != nil {
		return catalog.DatasetResult{}, err
	}
	f, err := s.fetch(ctx, d, dir)
	if err != nil {
		return catalog.DatasetResult{}, err
	}
	if f.unchanged {
		return catalog.DatasetResult{ETag: f.etag, LastModified: f.modified, Unchanged: true}, nil
	}
	rows, err := s.load(ctx, d, f, progress)
	if err != nil {
		return catalog.DatasetResult{}, fmt.Errorf("datasets: load %s: %w", name, err)
	}
	return catalog.DatasetResult{Rows: rows, Bytes: f.bytes, ETag: f.etag, LastModified: f.modified}, nil
}

// Removes partial downloads and staging databases a crashed earlier import left behind
func (s *Service) clean(dir string, d *dataset) error {
	parts, err := filepath.Glob(filepath.Join(dir, d.info.Name+".*.part"))
	if err != nil {
		return err
	}
	for _, p := range append(parts, stagingFiles(s.stagingPath(d))...) {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("datasets: remove leftover %s: %w", p, err)
		}
	}
	return nil
}

func (s *Service) stagingPath(d *dataset) string {
	return filepath.Join(s.dir, "datasets", "staging-"+d.info.Name+".db")
}

func stagingFiles(path string) []string {
	return []string{path, path + "-journal", path + "-wal", path + "-shm"}
}

// Streams the file to disk under the dataset policy, revalidating against the previous import
func (s *Service) fetch(ctx context.Context, d *dataset, dir string) (fetched, error) {
	u, err := s.url(ctx, d)
	if err != nil {
		return fetched{}, err
	}
	header, prev, err := s.conditions(ctx, d)
	if err != nil {
		return fetched{}, err
	}
	dctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	res, err := s.client.Stream(dctx, d.policy, outbound.Request{URL: u, Header: header})
	if err != nil {
		return fetched{}, err
	}
	defer func() { _ = res.Body.Close() }()
	out := fetched{etag: res.Header.Get("ETag")}
	if lm, err := http.ParseTime(res.Header.Get("Last-Modified")); err == nil {
		out.modified = lm
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotModified:
		if prev == nil {
			return fetched{}, fmt.Errorf("datasets: %s answered 304 to a request without validators", u)
		}
		if out.etag == "" {
			out.etag = prev.Etag
		}
		if out.modified.IsZero() && prev.LastModified != nil {
			out.modified = *prev.LastModified
		}
		out.unchanged = true
		return out, nil
	default:
		return fetched{}, fmt.Errorf("datasets: %s answered %d", u, res.StatusCode)
	}
	out.path = filepath.Join(dir, d.info.Name+".gz")
	if out.bytes, err = save(res.Body, dir, d.info.Name, out.path); err != nil {
		return fetched{}, fmt.Errorf("datasets: download %s: %w", u, err)
	}
	return out, nil
}

// Builds revalidation headers from the previous import while its rows are still loaded
func (s *Service) conditions(ctx context.Context, d *dataset) (http.Header, *ent.DatasetImport, error) {
	header := http.Header{}
	row, err := s.ent.DatasetImport.Get(ctx, d.info.Name)
	if ent.IsNotFound(err) {
		return header, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	loaded, err := d.table.populated(ctx, s.db)
	if err != nil {
		return nil, nil, err
	}
	if !loaded || (row.Etag == "" && row.LastModified == nil) {
		return header, nil, nil
	}
	if row.Etag != "" {
		header.Set("If-None-Match", row.Etag)
	}
	if row.LastModified != nil {
		header.Set("If-Modified-Since", row.LastModified.UTC().Format(http.TimeFormat))
	}
	return header, row, nil
}

// Names the file to download, probing today in UTC and the three days before for dated exports
func (s *Service) url(ctx context.Context, d *dataset) (string, error) {
	if !d.daily {
		return imdbBase + d.file, nil
	}
	today := s.now().UTC()
	for i := range exportDays {
		u := tmdbBase + d.file + "_" + today.AddDate(0, 0, -i).Format("01_02_2006") + ".json.gz"
		_, err := s.client.Do(ctx, d.policy, outbound.Request{Method: http.MethodHead, URL: u, NoRecord: true})
		if err == nil {
			return u, nil
		}
		var se *outbound.StatusError
		if errors.As(err, &se) && (se.Status == http.StatusNotFound || se.Status == http.StatusForbidden) {
			continue
		}
		return "", err
	}
	return "", fmt.Errorf("datasets: no %s export was published in the last %d days", d.file, exportDays)
}

// Writes the body to a temporary file and renames it over the destination once complete
func save(body io.Reader, dir, name, dest string) (int64, error) {
	f, err := os.CreateTemp(dir, name+".*.part")
	if err != nil {
		return 0, err
	}
	tmp := f.Name()
	n, err := io.Copy(f, body)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, dest)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	return n, nil
}
