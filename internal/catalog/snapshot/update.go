package snapshot

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/caasmo/go-sqlite-rsync/sqlitersync"
	"github.com/coder/websocket"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"

	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store"
	crosswalk "github.com/nickheyer/DiscoFlix/snapshot"
)

// Paths a peer serves under its base URL
const (
	VersionPath = "/catalog/snapshot/version"
	RsyncPath   = "/catalog/snapshot/rsync"
)

// Ways an update can arrive
const (
	ViaPeer = "peer"
	ViaHTTP = "http"
)

// Identity a peer offers for its crosswalk
type peerVersion struct {
	Version      string `json:"version"`
	SQLiteSHA256 string `json:"sqlite_sha256"`
}

// Routes TUF downloads through the outbound client under the mirror policy
type fetcher struct {
	ctx    context.Context
	client *outbound.Client
}

// Downloads one metadata or target file, failing past maxLength and mapping HTTP statuses for the updater
func (f fetcher) DownloadFile(urlPath string, maxLength int64, _ time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(f.ctx, mirrorTimeout)
	defer cancel()
	res, err := f.client.Stream(ctx, MirrorPolicy, outbound.Request{URL: urlPath})
	if se, ok := errors.AsType[*outbound.StatusError](err); ok {
		return nil, &metadata.ErrDownloadHTTP{StatusCode: se.Status, URL: urlPath}
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.ContentLength > maxLength {
		return nil, &metadata.ErrDownloadLengthMismatch{Msg: fmt.Sprintf("download failed for %s, length %d is larger than expected %d", urlPath, res.ContentLength, maxLength)}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxLength+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxLength {
		return nil, &metadata.ErrDownloadLengthMismatch{Msg: fmt.Sprintf("download failed for %s, more than %d bytes", urlPath, maxLength)}
	}
	return data, nil
}

// Newer of the embedded root and the root the updater last persisted
func (s *Service) trustedRoot() ([]byte, error) {
	cached, err := os.ReadFile(filepath.Join(s.dir, tufDir, "metadata", crosswalk.RootFile))
	if errors.Is(err, fs.ErrNotExist) {
		return s.root, nil
	}
	if err != nil {
		return nil, err
	}
	have, err := crosswalk.RootVersion(cached)
	if err != nil {
		return nil, fmt.Errorf("snapshot: cached root: %w", err)
	}
	embedded, err := crosswalk.RootVersion(s.root)
	if err != nil {
		return nil, err
	}
	if have > embedded {
		return cached, nil
	}
	return s.root, nil
}

// Refreshes the signed metadata from the mirror and returns the crosswalk entry with its custom block
func (s *Service) target(ctx context.Context) (*updater.Updater, *metadata.TargetFiles, crosswalk.Custom, error) {
	mirror, _ := s.mirrorAndPeers()
	root, err := s.trustedRoot()
	if err != nil {
		return nil, nil, crosswalk.Custom{}, err
	}
	cfg, err := config.New(mirror, root)
	if err != nil {
		return nil, nil, crosswalk.Custom{}, err
	}
	cfg.RemoteTargetsURL = mirror
	cfg.PrefixTargetsWithHash = true
	cfg.LocalMetadataDir = filepath.Join(s.dir, tufDir, "metadata")
	cfg.LocalTargetsDir = filepath.Join(s.dir, tufDir, "targets")
	cfg.Fetcher = fetcher{ctx: ctx, client: s.client}
	up, err := updater.New(cfg)
	if err != nil {
		return nil, nil, crosswalk.Custom{}, fmt.Errorf("snapshot: start updater: %w", err)
	}
	if err := up.Refresh(); err != nil {
		if de, ok := errors.AsType[*metadata.ErrDownloadHTTP](err); ok && de.StatusCode == http.StatusNotFound {
			return nil, nil, crosswalk.Custom{}, fmt.Errorf("%w, %s answered 404", catalog.ErrNoRelease, de.URL)
		}
		return nil, nil, crosswalk.Custom{}, fmt.Errorf("snapshot: refresh signed metadata from %s: %w", mirror, err)
	}
	info, err := up.GetTargetInfo(crosswalk.TargetName)
	if err != nil {
		return nil, nil, crosswalk.Custom{}, fmt.Errorf("snapshot: %w", err)
	}
	custom, err := crosswalk.ParseCustom(info.Custom)
	if err != nil {
		return nil, nil, crosswalk.Custom{}, err
	}
	return up, info, custom, nil
}

// Refreshes the signed metadata and compares the offered version with the file in use
func (s *Service) Check(ctx context.Context) (catalog.SnapshotCheck, error) {
	_, _, custom, err := s.target(ctx)
	if err != nil {
		return catalog.SnapshotCheck{}, err
	}
	local := s.Current().Version
	return catalog.SnapshotCheck{Remote: custom.Version, Local: local, Newer: custom.Version > local}, nil
}

// Fetches the signed crosswalk from a peer holding exactly that file or from the mirror and swaps it in
func (s *Service) Update(ctx context.Context, progress func(stage string)) (catalog.SnapshotResult, error) {
	s.update.Lock()
	defer s.update.Unlock()
	if progress == nil {
		progress = func(string) {}
	}
	progress("refreshing signed metadata")
	up, info, want, err := s.target(ctx)
	if err != nil {
		return catalog.SnapshotResult{}, err
	}
	version, sum, ok, err := s.identity()
	if err != nil {
		return catalog.SnapshotResult{}, err
	}
	if ok && version == want.Version && sum == want.SQLiteSHA256 {
		return catalog.SnapshotResult{Version: version, Via: s.Current().Via, Skipped: true}, nil
	}
	_, peers := s.mirrorAndPeers()
	via, n := "", int64(0)
	for _, peer := range peers {
		progress("syncing from peer " + peer)
		if n, err = s.fromPeer(ctx, peer, want); err == nil {
			via = ViaPeer
			break
		}
		s.log.Warn("crosswalk peer did not provide the signed snapshot", "peer", peer, "version", want.Version, "error", err)
		if err := crosswalk.RemoveDB(s.next()); err != nil {
			return catalog.SnapshotResult{}, err
		}
	}
	if via == "" {
		progress("downloading " + crosswalk.TargetName)
		if n, err = s.fromMirror(up, info, want); err != nil {
			return catalog.SnapshotResult{}, errors.Join(err, crosswalk.RemoveDB(s.next()))
		}
		via = ViaHTTP
	}
	progress("swapping in crosswalk " + want.Version)
	if err := s.swap(via, want.SQLiteSHA256); err != nil {
		return catalog.SnapshotResult{}, errors.Join(err, crosswalk.RemoveDB(s.next()))
	}
	return catalog.SnapshotResult{Version: want.Version, Bytes: n, Via: via}, nil
}

// Replicates a peer's crosswalk into the next file when the peer holds the signed version and hash
func (s *Service) fromPeer(ctx context.Context, peer string, want crosswalk.Custom) (int64, error) {
	var v peerVersion
	if _, err := s.client.GetJSON(ctx, PeerPolicy, outbound.Request{URL: peer + VersionPath, NoRecord: true}, &v); err != nil {
		return 0, err
	}
	if v.Version != want.Version || v.SQLiteSHA256 != want.SQLiteSHA256 {
		return 0, fmt.Errorf("snapshot: peer offers %s with sha256 %s", v.Version, v.SQLiteSHA256)
	}
	if err := s.seed(); err != nil {
		return 0, err
	}
	conn, res, err := websocket.Dial(ctx, peer+RsyncPath, nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		return 0, fmt.Errorf("snapshot: dial %s: %w", peer+RsyncPath, err)
	}
	nc := websocket.NetConn(ctx, conn, websocket.MessageBinary)
	stats, err := sqlitersync.Replica(ctx, nc, s.next(), nil)
	if cerr := nc.Close(); err == nil && cerr != nil && !errors.Is(cerr, net.ErrClosed) {
		err = cerr
	}
	if err != nil {
		return 0, fmt.Errorf("snapshot: replicate from %s: %w", peer, err)
	}
	if err := settle(ctx, s.next()); err != nil {
		return 0, err
	}
	if err := crosswalk.PinHeader(s.next()); err != nil {
		return 0, err
	}
	sum, length, err := crosswalk.FileSHA256(s.next())
	if err != nil {
		return 0, err
	}
	if err := crosswalk.CheckContent(want, sum, length); err != nil {
		return 0, err
	}
	return int64(stats.BytesReceived + stats.BytesSent), nil
}

// Copies the current crosswalk to the next file so the replica only pulls changed pages
func (s *Service) seed() error {
	if err := crosswalk.RemoveDB(s.next()); err != nil {
		return err
	}
	s.file.RLock()
	defer s.file.RUnlock()
	in, err := os.Open(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(s.next(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// Merges any WAL the replica left into the next file so its bytes are final
func settle(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", store.DSN(path))
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	if err = errors.Join(err, db.Close()); err != nil {
		return fmt.Errorf("snapshot: checkpoint replica: %w", err)
	}
	if fi, err := os.Stat(path + "-wal"); err == nil && fi.Size() > 0 {
		return fmt.Errorf("snapshot: %s-wal still holds %d bytes", path, fi.Size())
	}
	return nil
}

// Downloads the verified target through the updater and inflates it into the next file
func (s *Service) fromMirror(up *updater.Updater, info *metadata.TargetFiles, want crosswalk.Custom) (int64, error) {
	cached := filepath.Join(s.dir, tufDir, "targets", crosswalk.TargetName)
	path, data, err := up.DownloadTarget(info, cached, "")
	if err != nil {
		return 0, fmt.Errorf("snapshot: download %s: %w", crosswalk.TargetName, err)
	}
	if err := os.Remove(path); err != nil {
		return 0, err
	}
	if err := crosswalk.RemoveDB(s.next()); err != nil {
		return 0, err
	}
	out, err := os.OpenFile(s.next(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, err
	}
	sum, length, err := crosswalk.Decompress(bytes.NewReader(data), out)
	if err = errors.Join(err, out.Sync(), out.Close()); err != nil {
		return 0, err
	}
	if err := crosswalk.CheckContent(want, sum, length); err != nil {
		return 0, err
	}
	return int64(len(data)), nil
}

// Replaces the crosswalk with the verified next file and reopens the read handle while readers wait
func (s *Service) swap(via, sum string) error {
	s.file.Lock()
	defer s.file.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		if err := s.db.Close(); err != nil {
			s.log.Warn("close replaced crosswalk handle", "error", err)
		}
		s.db = nil
	}
	for _, companion := range []string{s.path + "-wal", s.path + "-shm"} {
		if err := os.Remove(companion); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	renameErr := os.Rename(s.next(), s.path)
	s.open()
	if renameErr != nil {
		return fmt.Errorf("snapshot: swap in crosswalk: %w", renameErr)
	}
	if s.openErr != nil {
		return fmt.Errorf("snapshot: open swapped crosswalk: %w", s.openErr)
	}
	if err := os.WriteFile(filepath.Join(s.dir, viaFile), []byte(via+"\n"), 0o600); err != nil {
		return err
	}
	s.via, s.sum = via, sum
	return nil
}

// Version and sha256 of the crosswalk in use, hashing the file once per swap
func (s *Service) identity() (version, sum string, ok bool, err error) {
	s.mu.RLock()
	version, sum, ok = s.meta.Version, s.sum, s.db != nil
	s.mu.RUnlock()
	if !ok || sum != "" {
		return version, sum, ok, nil
	}
	s.file.RLock()
	sum, _, err = crosswalk.FileSHA256(s.path)
	s.file.RUnlock()
	if err != nil {
		return "", "", false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil || s.meta.Version != version {
		return s.meta.Version, s.sum, s.db != nil && s.sum != "", nil
	}
	if s.sum == "" {
		s.sum = sum
	}
	return s.meta.Version, s.sum, true, nil
}
