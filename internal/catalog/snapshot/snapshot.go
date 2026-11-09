// Answers catalog lookups from the signed Wikidata crosswalk and keeps it current from the mirror and peers
package snapshot

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	crosswalk "github.com/nickheyer/DiscoFlix/snapshot"
)

// Rolling GitHub release that carries the signed repository
const DefaultMirror = "https://github.com/nickheyer/DiscoFlix/releases/download/snapshot"

// Outbound policies for the mirror and for peers
const (
	MirrorPolicy  = "snapshot-mirror"
	PeerPolicy    = "snapshot-peer"
	mirrorTimeout = 10 * time.Minute
	peerTimeout   = 30 * time.Second
	tufDir        = "snapshot-tuf"
	viaFile       = "crosswalk.via"
	searchLimit   = 10
	ftsCandidates = 200
	ftsMinRunes   = 3
)

// Returned by lookups and searches before any crosswalk file is in place
var ErrNotDownloaded = fmt.Errorf("%w: the crosswalk snapshot has not been downloaded yet", catalog.ErrNoData)

// Adjusts a Service at construction
type Option func(*Service)

// Replaces the embedded trusted TUF root
func WithRoot(root []byte) Option {
	return func(s *Service) { s.root = root }
}

// The snapshot source and the crosswalk updater
type Service struct {
	dir    string
	path   string
	client *outbound.Client
	log    *slog.Logger
	root   []byte

	update sync.Mutex
	file   sync.RWMutex

	mu      sync.RWMutex
	db      *sql.DB
	meta    crosswalk.Meta
	openErr error
	sum     string
	via     string
	mirror  string
	peers   []string
	lang    string
}

// Opens the crosswalk in dir when present and registers the mirror and peer policies
func New(dir string, client *outbound.Client, log *slog.Logger, opts ...Option) (*Service, error) {
	s := &Service{dir: dir, path: filepath.Join(dir, crosswalk.FileName), client: client, log: log, root: crosswalk.Root, lang: "en"}
	for _, o := range opts {
		o(s)
	}
	if _, err := crosswalk.RootVersion(s.root); err != nil {
		return nil, fmt.Errorf("snapshot: trusted root: %w", err)
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	if err := crosswalk.RemoveDB(s.next()); err != nil {
		return nil, err
	}
	client.Register(outbound.Policy{Name: MirrorPolicy, Title: "Crosswalk mirror", Rate: 2, Burst: 4, Timeout: mirrorTimeout, License: crosswalk.License})
	client.Register(outbound.Policy{Name: PeerPolicy, Title: "Crosswalk peers", Rate: 2, Burst: 4, Timeout: peerTimeout, License: crosswalk.License})
	via, err := os.ReadFile(filepath.Join(dir, viaFile))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	s.via = strings.TrimSpace(string(via))
	s.mu.Lock()
	s.open()
	s.mu.Unlock()
	return s, nil
}

func (s *Service) next() string { return s.path + ".next" }

// Points the read handle at the file on disk, keeping the reason when the file is unusable
func (s *Service) open() {
	s.db, s.meta, s.openErr, s.sum = nil, crosswalk.Meta{}, nil, ""
	if _, err := os.Stat(s.path); errors.Is(err, fs.ErrNotExist) {
		return
	}
	db, err := sql.Open("sqlite", crosswalk.ReadOnlyDSN(s.path))
	if err != nil {
		s.openErr = err
		return
	}
	db.SetMaxOpenConns(4)
	meta, err := crosswalk.ReadMeta(context.Background(), db)
	if err != nil {
		_ = db.Close()
		s.openErr = err
		s.log.Error("crosswalk snapshot unusable", "path", s.path, "error", err)
		return
	}
	s.db, s.meta = db, meta
}

// Open crosswalk connection pool, held under the read lock until release runs
func (s *Service) handle() (*sql.DB, func(), error) {
	s.mu.RLock()
	if s.db == nil {
		err := s.openErr
		s.mu.RUnlock()
		if err != nil {
			return nil, nil, fmt.Errorf("snapshot: the crosswalk snapshot could not be opened: %w", err)
		}
		return nil, nil, ErrNotDownloaded
	}
	return s.db, s.mu.RUnlock, nil
}

// Releases the read handle
func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func (s *Service) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.source.snapshot", Name: "Wikidata snapshot", Version: "1", Kind: extension.KindMetadataSource, Origin: "builtin"}
}

func (s *Service) Name() string { return catalog.SourceSnapshot }

func (s *Service) Policy() outbound.Policy {
	return outbound.Policy{Name: catalog.SourceSnapshot, Title: "Wikidata snapshot", License: crosswalk.License}
}

func (s *Service) Local() bool { return true }

func (s *Service) Namespaces() []string { return crosswalk.Namespaces() }

func (s *Service) Kinds() []string {
	return []string{model.KindMovie, model.KindSeries, model.KindSeason, model.KindEpisode}
}

func (s *Service) NeedsKey() bool { return false }

// The crosswalk holds ids and titles only
func (s *Service) Artwork() bool { return false }

func (s *Service) KeyHint() string { return "" }

func (s *Service) License() string { return crosswalk.License }

// Stores the language whose label becomes the title claim
func (s *Service) Configure(_ catalog.Keys, options map[string]string) error {
	lang := strings.ToLower(strings.TrimSpace(options["language"]))
	if lang == "" {
		lang = "en"
	}
	s.mu.Lock()
	s.lang = lang
	s.mu.Unlock()
	return nil
}

// One item with its titles and ids
type record struct {
	qid      int64
	kind     string
	label    string
	original string
	lang     string
	country  string
	year     int64
	runtime  int64
	parent   int64
	ordinal  int64
	titles   []title
	xids     []crosswalk.XID
}

type title struct {
	text string
	lang string
	kind string
}

// Reads one item with its titles and ids
func load(ctx context.Context, db *sql.DB, qid int64) (*record, error) {
	r := &record{qid: qid}
	var label, original, lang, country sql.NullString
	var year, runtime, parent, ordinal sql.NullInt64
	err := db.QueryRowContext(ctx, `SELECT kind, label, original_title, lang, country, year, runtime, parent_qid, ordinal FROM item WHERE id = ?`, qid).
		Scan(&r.kind, &label, &original, &lang, &country, &year, &runtime, &parent, &ordinal)
	if err != nil {
		return nil, fmt.Errorf("snapshot: item Q%d: %w", qid, err)
	}
	r.label, r.original, r.lang, r.country = label.String, original.String, lang.String, country.String
	r.year, r.runtime, r.parent, r.ordinal = year.Int64, runtime.Int64, parent.Int64, ordinal.Int64
	rows, err := db.QueryContext(ctx, `SELECT title, lang, kind FROM title WHERE item_id = ? ORDER BY id`, qid)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var t title
		if err := rows.Scan(&t.text, &t.lang, &t.kind); err != nil {
			_ = rows.Close()
			return nil, err
		}
		r.titles = append(r.titles, t)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	rows, err = db.QueryContext(ctx, `SELECT ns, value FROM xid WHERE item_id = ? ORDER BY ns, value`, qid)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x crosswalk.XID
		if err := rows.Scan(&x.Namespace, &x.Value); err != nil {
			_ = rows.Close()
			return nil, err
		}
		r.xids = append(r.xids, x)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	return r, nil
}

// Renders a record as one claim group keyed by the given namespace and value
func (r *record) claims(namespace, value, lang string) []model.Claim {
	var out []model.Claim
	add := func(field string, v any) {
		out = append(out, model.Claim{Kind: r.kind, Namespace: namespace, ExternalID: value, Field: field, Value: v, Confidence: 1})
	}
	name := r.label
	for _, t := range r.titles {
		if t.kind == crosswalk.TitleLabel && t.lang == lang {
			name = t.text
			break
		}
	}
	if name == "" {
		name = r.original
	}
	if name != "" {
		add(model.FieldTitle, name)
	}
	if r.original != "" {
		add(model.FieldOriginalTitle, r.original)
	}
	if r.year > 0 {
		add(model.FieldYear, int(r.year))
	}
	if r.lang != "" {
		add(model.FieldLanguage, r.lang)
	}
	if r.country != "" {
		add(model.FieldCountries, strings.Split(r.country, ","))
	}
	if r.runtime > 0 {
		add(model.FieldRuntime, int(r.runtime))
	}
	seen := map[string]bool{name: true, r.original: true}
	var aliases []string
	for _, t := range r.titles {
		if !seen[t.text] {
			seen[t.text] = true
			aliases = append(aliases, t.text)
		}
	}
	if len(aliases) > 0 {
		add(model.FieldAliases, aliases)
	}
	for _, x := range r.xids {
		add(model.XIDField(x.Namespace), x.Value)
	}
	if r.parent != 0 {
		add(model.ParentXIDField(model.NSWikidata), crosswalk.WikidataValue(r.parent))
	}
	if r.ordinal > 0 {
		add(model.FieldOrdinal, int(r.ordinal))
	}
	return out
}

func (s *Service) language() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lang
}

// Item holding an external id as one group keyed by that id
func (s *Service) Lookup(ctx context.Context, kind, namespace, id string) ([]model.Claim, error) {
	lang := s.language()
	db, release, err := s.handle()
	if err != nil {
		return nil, err
	}
	defer release()
	var qid int64
	err = db.QueryRowContext(ctx, `SELECT item_id FROM xid WHERE ns = ? AND value = ?`, namespace, id).Scan(&qid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("snapshot: lookup %s:%s: %w", namespace, id, err)
	}
	r, err := load(ctx, db, qid)
	if err != nil {
		return nil, err
	}
	if kind != "" && r.kind != kind {
		return nil, nil
	}
	return r.claims(namespace, id, lang), nil
}

// Up to ten items, exact normalized title matches first then trigram matches
func (s *Service) Search(ctx context.Context, kind, text string, year int) ([]model.Claim, error) {
	lang := s.language()
	db, release, err := s.handle()
	if err != nil {
		return nil, err
	}
	defer release()
	norm := model.Normalize(text)
	if norm == "" {
		return nil, nil
	}
	filter := ` AND (? = '' OR i.kind = ?) AND (? = 0 OR i.year BETWEEN ? - 1 AND ? + 1)`
	args := []any{kind, kind, year, year, year}
	qids, err := collect(ctx, db, nil, `SELECT t.item_id FROM title t JOIN item i ON i.id = t.item_id WHERE t.normalized = ?`+filter+`
		GROUP BY t.item_id
		ORDER BY MIN(CASE t.kind WHEN 'label' THEN 0 WHEN 'original' THEN 1 ELSE 2 END), (SELECT COUNT(*) FROM xid x WHERE x.item_id = t.item_id) DESC, t.item_id
		LIMIT ?`, append(append([]any{norm}, args...), searchLimit)...)
	if err != nil {
		return nil, err
	}
	if len(qids) < searchLimit && utf8.RuneCountInString(norm) >= ftsMinRunes {
		phrase := `"` + strings.ReplaceAll(norm, `"`, `""`) + `"`
		if qids, err = collect(ctx, db, qids, `SELECT t.item_id FROM title_fts f JOIN title t ON t.id = f.rowid JOIN item i ON i.id = t.item_id WHERE title_fts MATCH ?`+filter+`
			ORDER BY f.rank LIMIT ?`, append(append([]any{phrase}, args...), ftsCandidates)...); err != nil {
			return nil, err
		}
	}
	var out []model.Claim
	for _, qid := range qids {
		r, err := load(ctx, db, qid)
		if err != nil {
			return nil, err
		}
		out = append(out, r.claims(model.NSWikidata, crosswalk.WikidataValue(qid), lang)...)
	}
	return out, nil
}

// Appends the distinct item ids a query returns until the search limit is reached
func collect(ctx context.Context, db *sql.DB, have []int64, query string, args ...any) ([]int64, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("snapshot: search: %w", err)
	}
	defer func() { _ = rows.Close() }()
	seen := map[int64]bool{}
	for _, q := range have {
		seen[q] = true
	}
	for rows.Next() && len(have) < searchLimit {
		var qid int64
		if err := rows.Scan(&qid); err != nil {
			return nil, err
		}
		if !seen[qid] {
			seen[qid] = true
			have = append(have, qid)
		}
	}
	return have, rows.Err()
}

// Describes the crosswalk in use from its meta table and the file on disk
func (s *Service) Current() catalog.SnapshotInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return catalog.SnapshotInfo{}
	}
	fi, err := os.Stat(s.path)
	if err != nil {
		return catalog.SnapshotInfo{}
	}
	return catalog.SnapshotInfo{
		Version: s.meta.Version, BuiltAt: s.meta.BuiltAt, Items: s.meta.Items, XIDs: s.meta.XIDs,
		Bytes: fi.Size(), UpdatedAt: fi.ModTime(), Via: s.via, Present: true,
	}
}

// Stores the mirror and peers, an empty mirror selects the default release
func (s *Service) SetMirror(url string, peers []string) {
	clean := make([]string, 0, len(peers))
	for _, p := range peers {
		if p = strings.TrimRight(strings.TrimSpace(p), "/"); p != "" {
			clean = append(clean, p)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mirror = strings.TrimRight(strings.TrimSpace(url), "/")
	s.peers = clean
}

// Effective mirror and a copy of the peers
func (s *Service) mirrorAndPeers() (string, []string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	mirror := s.mirror
	if mirror == "" {
		mirror = DefaultMirror
	}
	return mirror, append([]string(nil), s.peers...)
}
