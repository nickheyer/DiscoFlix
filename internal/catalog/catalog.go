// Package catalog is the metadata graph, resolving titles and external ids to entities with field provenance
package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/datasetimport"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/sourcestate"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	"github.com/nickheyer/DiscoFlix/internal/workflow"
)

// Setting keys the catalog owns
const (
	SettingMirror   = "catalog.mirror_url"
	SettingPeers    = "catalog.peers"
	SettingLanguage = "catalog.language"
	channelName     = "catalog"
)

// Source names the core knows the shape of
const (
	SourceUser       = "user"
	SourceSnapshot   = "snapshot"
	SourceTMDB       = "tmdb"
	SourceTVDB       = "tvdb"
	SourceIMDb       = "imdb"
	SourceTrakt      = "trakt"
	SourceWikidata   = "wikidata"
	SourceFanart     = "fanart"
	SourceTMDBExport = "tmdbexport"
)

var (
	ErrNotFound      = errors.New("catalog: not found")
	ErrNoMatch       = errors.New("catalog: nothing matched")
	ErrUnknownSource = errors.New("catalog: unknown source")
	ErrBadKind       = errors.New("catalog: unknown entity kind")
	ErrBadField      = errors.New("catalog: field name not accepted")
	ErrMerged        = errors.New("catalog: entity was merged into another")
	// ErrUnsupported is returned by a source for an operation it has no API for, such as searching an artwork site
	ErrUnsupported = errors.New("catalog: operation not supported by this source")
	// ErrNoData is wrapped by a local source whose dataset or snapshot has not been loaded yet
	ErrNoData = errors.New("catalog: local data not loaded")
	// ErrNoRelease is wrapped when the snapshot mirror answers but has never published a release
	ErrNoRelease = errors.New("catalog: the mirror has not published a crosswalk snapshot yet")
	// ErrTooFewPairs is returned by a trainer that keeps its previous weights because the sample is too small
	ErrTooFewPairs = model.ErrTooFewPairs
	ErrNotLaunched = workflow.ErrNotLaunched
)

// Source is one metadata provider the catalog fans out to, built in or from a plugin
type Source interface {
	extension.Extension
	Name() string
	Policy() outbound.Policy
	// Namespaces this source can look up directly
	Namespaces() []string
	Kinds() []string
	License() string
	// Artwork reports whether lookups return poster, backdrop, or logo images
	Artwork() bool
	Configure(options map[string]string) error
	Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error)
	Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error)
}

// Local marks a source that answers from files on this machine and is never unreachable
type Local interface {
	Local() bool
}

// Scorer estimates whether two records describe the same title
type Scorer interface {
	Score(kind string, a, b model.Record) (float64, map[string]float64)
	Explain(features map[string]float64) string
}

// Artworks downloads and encodes the pending artwork rows of entities
type Artworks interface {
	Ingest(ctx context.Context, a *ent.Artwork) error
	URL(a *ent.Artwork, width int32, format string) string
}

// SnapshotInfo describes the crosswalk file in use
type SnapshotInfo struct {
	Version   string
	BuiltAt   time.Time
	Items     int64
	XIDs      int64
	Bytes     int64
	UpdatedAt time.Time
	Via       string
	Present   bool
}

// SnapshotCheck is the outcome of asking the mirror and peers for a newer snapshot
type SnapshotCheck struct {
	Remote string
	Local  string
	Newer  bool
}

// SnapshotResult is one completed update
type SnapshotResult struct {
	Version string
	Bytes   int64
	Via     string
	Skipped bool
}

// Snapshots keeps the crosswalk current from the mirror and peers
type Snapshots interface {
	Check(ctx context.Context) (SnapshotCheck, error)
	Update(ctx context.Context, progress func(stage string)) (SnapshotResult, error)
	Current() SnapshotInfo
	SetMirror(url string, peers []string)
}

// DatasetInfo describes one bulk dataset
type DatasetInfo struct {
	Name    string
	Title   string
	License string
	URL     string
	Default bool
}

// DatasetResult is one completed import
type DatasetResult struct {
	Rows         int64
	Bytes        int64
	ETag         string
	LastModified time.Time
	Unchanged    bool
}

// Datasets downloads bulk files into the local tables
type Datasets interface {
	List() []DatasetInfo
	Import(ctx context.Context, name string, progress func(rows, bytes int64)) (DatasetResult, error)
}

// Labeled is one scored pair with the decision a person or a hard id made about it
type Labeled = model.Labeled

// Trainer relearns the matcher weights from decided and undecided pairs, returning ErrTooFewPairs on a small sample
type Trainer interface {
	Fit(kind string, labeled []Labeled, unlabeled []map[string]float64) (int, error)
	Weights(kind string) ([]byte, error)
	Load(kind string, weights []byte) error
}

// Deps are the subsystems the catalog reads from and writes to
type Deps struct {
	Ent        *ent.Client
	DB         *sql.DB
	Timeline   *timeline.Service
	Check      capability.CheckFunc
	Settings   *store.Settings
	Workflows  *workflow.Service
	Outbound   *outbound.Client
	Extensions *extension.Registry
	Scorer     Scorer
	Trainer    Trainer
	Artworks   Artworks
	Snapshots  Snapshots
	Datasets   Datasets
	Sources    []Source
	LinkBase   func() string
	Log        *slog.Logger
}

type sourceEntry struct {
	Source
	local   bool
	enabled bool
	options map[string]string
}

// Service owns the entity graph, the source registry, and the catalog workflows
type Service struct {
	Deps

	mu      sync.RWMutex
	sources map[string]*sourceEntry
	order   []string
	peers   []string
	mirror  string
	lang    string
	queue   dbos.Queue
	snap    snapshotState
}

// New registers every source with the client layer and the extension registry
func New(ctx context.Context, d Deps) (*Service, error) {
	s := &Service{Deps: d, sources: map[string]*sourceEntry{}}
	for _, src := range d.Sources {
		if _, dup := s.sources[src.Name()]; dup {
			return nil, fmt.Errorf("catalog: source %s registered twice", src.Name())
		}
		if err := d.Extensions.Register(src); err != nil {
			return nil, err
		}
		d.Outbound.Register(src.Policy())
		l, ok := src.(Local)
		s.sources[src.Name()] = &sourceEntry{Source: src, local: ok && l.Local()}
		s.order = append(s.order, src.Name())
	}
	sort.Strings(s.order)
	if err := s.loadSettings(ctx); err != nil {
		return nil, err
	}
	if err := s.loadWeights(ctx); err != nil {
		return nil, err
	}
	for _, card := range []extension.Extension{Card(), ReportCard(), &reviewCard{svc: s}} {
		if err := d.Extensions.Register(card); err != nil {
			return nil, err
		}
	}
	s.registerWorkflows()
	return s, nil
}

// loadWeights hands stored matcher weights to the trainer
func (s *Service) loadWeights(ctx context.Context) error {
	rows, err := s.Ent.MatchModel.Query().All(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.Trainer.Load(row.ID, row.Weights); err != nil {
			return fmt.Errorf("catalog: matcher weights for %s: %w", row.ID, err)
		}
	}
	return nil
}

// loadSettings applies stored enablement, mirror, peers, and language
func (s *Service) loadSettings(ctx context.Context) error {
	var err error
	if s.mirror, err = s.Settings.GetString(ctx, SettingMirror, ""); err != nil {
		return err
	}
	if _, err = s.Settings.Get(ctx, SettingPeers, &s.peers); err != nil {
		return err
	}
	if s.lang, err = s.Settings.GetString(ctx, SettingLanguage, "en"); err != nil {
		return err
	}
	s.Snapshots.SetMirror(s.mirror, s.peers)
	for _, name := range s.order {
		e := s.sources[name]
		row, err := s.Ent.SourceState.Get(ctx, name)
		switch {
		case ent.IsNotFound(err):
			e.enabled = true
			e.options = map[string]string{}
		case err != nil:
			return err
		default:
			e.enabled = row.Enabled
			e.options = row.Options
			if e.options == nil {
				e.options = map[string]string{}
			}
		}
		if err := e.Configure(s.withLanguage(e.options)); err != nil {
			return fmt.Errorf("catalog: configure %s: %w", name, err)
		}
	}
	return nil
}

func (s *Service) withLanguage(options map[string]string) map[string]string {
	out := make(map[string]string, len(options)+1)
	maps.Copy(out, options)
	if _, ok := out["language"]; !ok {
		out["language"] = s.lang
	}
	return out
}

// Start launches the workflow runtime, applies schedules, and fetches the snapshot and default datasets when missing
func (s *Service) Start(ctx context.Context) error {
	if err := s.Workflows.Launch(); err != nil {
		return err
	}
	if err := s.schedule(); err != nil {
		return err
	}
	if err := s.seedDatasets(ctx); err != nil {
		return err
	}
	if !s.Snapshots.Current().Present {
		if _, err := s.UpdateSnapshot(false); err != nil {
			return err
		}
	}
	pending, err := s.Ent.DatasetImport.Query().Where(datasetimport.Enabled(true), datasetimport.StateEQ(datasetimport.StateIdle)).Exist(ctx)
	if err != nil {
		return err
	}
	if pending {
		if _, err := workflow.Run[struct{}, []string](s.Workflows, s.datasetsWorkflow, bucket("datasets:boot", time.Hour), struct{}{}, s.queued()...); err != nil {
			return err
		}
	}
	s.Log.Info("catalog ready", "sources", len(s.order), "snapshot", s.Snapshots.Current().Version)
	return nil
}

// seedDatasets creates the row of every known dataset, enabling the ones that are on by default
func (s *Service) seedDatasets(ctx context.Context) error {
	for _, d := range s.Datasets.List() {
		if err := s.Ent.DatasetImport.Create().SetID(d.Name).SetEnabled(d.Default).
			OnConflictColumns(datasetimport.FieldID).Ignore().Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Source returns the registered source by name
func (s *Service) Source(name string) (Source, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.sources[name]
	if !ok {
		return nil, false
	}
	return e.Source, true
}

// enabledSources lists sources that may be called right now, local ones first
func (s *Service) enabledSources(localOnly bool) []*sourceEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*sourceEntry
	for _, name := range s.order {
		e := s.sources[name]
		if !e.enabled || (localOnly && !e.local) {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].local && !out[j].local })
	return out
}

// outcomes lists why each registered source did or did not take part in a request
func (s *Service) skippedOutcomes(localOnly bool) []Outcome {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Outcome
	for _, name := range s.order {
		e := s.sources[name]
		switch {
		case !e.enabled:
			out = append(out, Outcome{Source: name, State: StateDisabled, Artwork: e.Artwork()})
		case localOnly && !e.local:
			out = append(out, Outcome{Source: name, State: StateSkipped, Artwork: e.Artwork()})
		}
	}
	return out
}

// ConfigureSource stores enablement and options for one source and reconfigures it
func (s *Service) ConfigureSource(ctx context.Context, name string, enabled bool, options map[string]string) error {
	s.mu.Lock()
	e, ok := s.sources[name]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownSource, name)
	}
	if options == nil {
		options = map[string]string{}
	}
	if err := s.Ent.SourceState.Create().SetID(name).SetEnabled(enabled).SetOptions(options).
		OnConflictColumns(sourcestate.FieldID).UpdateEnabled().UpdateOptions().UpdateUpdatedAt().Exec(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	e.enabled = enabled
	e.options = options
	s.mu.Unlock()
	if err := e.Configure(s.withLanguage(options)); err != nil {
		return fmt.Errorf("catalog: configure %s: %w", name, err)
	}
	return nil
}

// ConfigureCatalog stores the mirror, peers, and language, pushing them to the snapshot updater and sources
func (s *Service) ConfigureCatalog(ctx context.Context, mirror string, peers []string, lang string) error {
	mirror = strings.TrimRight(strings.TrimSpace(mirror), "/")
	clean := make([]string, 0, len(peers))
	for _, p := range peers {
		if p = strings.TrimRight(strings.TrimSpace(p), "/"); p != "" {
			clean = append(clean, p)
		}
	}
	lang = strings.ToLower(strings.TrimSpace(lang))
	if lang == "" {
		lang = "en"
	}
	if err := s.Settings.Set(ctx, SettingMirror, mirror); err != nil {
		return err
	}
	if err := s.Settings.Set(ctx, SettingPeers, clean); err != nil {
		return err
	}
	if err := s.Settings.Set(ctx, SettingLanguage, lang); err != nil {
		return err
	}
	s.mu.Lock()
	s.mirror, s.peers, s.lang = mirror, clean, lang
	entries := make([]*sourceEntry, 0, len(s.order))
	for _, name := range s.order {
		entries = append(entries, s.sources[name])
	}
	s.mu.Unlock()
	s.Snapshots.SetMirror(mirror, clean)
	for _, e := range entries {
		if err := e.Configure(s.withLanguage(e.options)); err != nil {
			return fmt.Errorf("catalog: configure %s: %w", e.Name(), err)
		}
	}
	return nil
}

// Settings returns the mirror, peers, and language in effect
func (s *Service) CatalogSettings() (mirror string, peers []string, lang string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.mirror, append([]string(nil), s.peers...), s.lang
}

// principalName renders who did something for cards and claims
func principalName(p capability.Principal) string {
	if p.DisplayName != "" {
		return p.DisplayName
	}
	return p.UserID
}
