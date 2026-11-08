package snapshot

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

// Key and metadata file names of a TUF repository directory
const (
	RootKeyFile   = "root.key"
	OnlineKeyFile = "online.key"
	RootFile      = "root.json"
	TimestampFile = "timestamp.json"
)

// Lifetimes of each signed role
const (
	RootExpiry      = 2 * 365 * 24 * time.Hour
	TargetsExpiry   = 60 * 24 * time.Hour
	SnapshotExpiry  = 60 * 24 * time.Hour
	TimestampExpiry = 21 * 24 * time.Hour
)

const pemType = "PRIVATE KEY"

// Roles the online key signs, root alone is signed by the root key
var OnlineRoles = []string{metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP}

// Writes root.key, online.key, and a version 1 root.json signed by the root key, never overwriting
func InitKeys(dir string, now time.Time) (rootID, onlineID string, err error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	for _, name := range []string{RootKeyFile, OnlineKeyFile, RootFile} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return "", "", fmt.Errorf("snapshot: %s already exists in %s", name, dir)
		}
	}
	rootPub, rootPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	onlinePub, onlinePriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	root := metadata.Root(now.UTC().Add(RootExpiry).Truncate(time.Second))
	rootKey, err := metadata.KeyFromPublicKey(rootPub)
	if err != nil {
		return "", "", err
	}
	onlineKey, err := metadata.KeyFromPublicKey(onlinePub)
	if err != nil {
		return "", "", err
	}
	if err := root.Signed.AddKey(rootKey, metadata.ROOT); err != nil {
		return "", "", err
	}
	for _, role := range OnlineRoles {
		if err := root.Signed.AddKey(onlineKey, role); err != nil {
			return "", "", err
		}
	}
	root.Signed.Version = 1
	root.Signed.ConsistentSnapshot = true
	signer, err := signature.LoadED25519Signer(rootPriv)
	if err != nil {
		return "", "", err
	}
	if _, err := root.Sign(signer); err != nil {
		return "", "", err
	}
	if err := writeKey(filepath.Join(dir, RootKeyFile), rootPriv); err != nil {
		return "", "", err
	}
	if err := writeKey(filepath.Join(dir, OnlineKeyFile), onlinePriv); err != nil {
		return "", "", err
	}
	data, err := root.ToBytes(true)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(filepath.Join(dir, RootFile), append(data, '\n'), 0o600); err != nil {
		return "", "", err
	}
	if rootID, err = rootKey.ID(); err != nil {
		return "", "", err
	}
	onlineID, err = onlineKey.ID()
	return rootID, onlineID, err
}

// Stores a private key as PKCS8 PEM readable only by the owner
func writeKey(path string, key ed25519.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := pem.Encode(f, &pem.Block{Type: pemType, Bytes: der}); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// Reads a PKCS8 PEM ed25519 private key
func LoadKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != pemType {
		return nil, fmt.Errorf("snapshot: %s holds no %s block", path, pemType)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("snapshot: %s: %w", path, err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("snapshot: %s is a %T, want ed25519", path, key)
	}
	return priv, nil
}

// Inputs of one publish
type PublishOptions struct {
	Repo      string
	Root      string
	OnlineKey string
	SQLite    string
	Now       time.Time
}

// Versions and target one publish wrote
type Published struct {
	Custom           Custom
	Target           string
	TargetLength     int64
	RootVersion      int64
	TargetsVersion   int64
	SnapshotVersion  int64
	TimestampVersion int64
}

// Compresses the crosswalk into the repo and signs new targets, snapshot, and timestamp with the online key
func Publish(ctx context.Context, o PublishOptions) (Published, error) {
	var out Published
	rootBytes, err := os.ReadFile(o.Root)
	if err != nil {
		return out, err
	}
	root, err := (&metadata.Metadata[metadata.RootType]{}).FromBytes(rootBytes)
	if err != nil {
		return out, fmt.Errorf("snapshot: %s: %w", o.Root, err)
	}
	priv, err := LoadKey(o.OnlineKey)
	if err != nil {
		return out, err
	}
	signer, err := signature.LoadED25519Signer(priv)
	if err != nil {
		return out, err
	}
	if err := checkOnlineKey(root, priv); err != nil {
		return out, err
	}
	custom, err := describe(ctx, o.SQLite)
	if err != nil {
		return out, err
	}
	if err := os.MkdirAll(o.Repo, 0o750); err != nil {
		return out, err
	}
	targetsV, snapshotV, timestampV, err := nextVersions(o.Repo)
	if err != nil {
		return out, err
	}
	target, length, sum, err := compress(o.SQLite, o.Repo)
	if err != nil {
		return out, err
	}
	raw, err := json.Marshal(custom)
	if err != nil {
		return out, err
	}
	msg := json.RawMessage(raw)
	now := o.Now.UTC().Truncate(time.Second)

	targets := metadata.Targets(now.Add(TargetsExpiry))
	targets.Signed.Version = targetsV
	targets.Signed.Targets[TargetName] = &metadata.TargetFiles{Length: length, Hashes: metadata.Hashes{"sha256": sum}, Custom: &msg, Path: TargetName}
	targetsBytes, err := signed(targets, signer)
	if err != nil {
		return out, err
	}
	snap := metadata.Snapshot(now.Add(SnapshotExpiry))
	snap.Signed.Version = snapshotV
	snap.Signed.Meta[metadata.TARGETS+".json"] = metaFile(targetsV, targetsBytes)
	snapBytes, err := signed(snap, signer)
	if err != nil {
		return out, err
	}
	ts := metadata.Timestamp(now.Add(TimestampExpiry))
	ts.Signed.Version = timestampV
	ts.Signed.Meta[metadata.SNAPSHOT+".json"] = metaFile(snapshotV, snapBytes)
	tsBytes, err := signed(ts, signer)
	if err != nil {
		return out, err
	}
	files := []struct {
		name string
		data []byte
	}{
		{versionName(targetsV, metadata.TARGETS), targetsBytes},
		{versionName(snapshotV, metadata.SNAPSHOT), snapBytes},
		{versionName(root.Signed.Version, metadata.ROOT), rootBytes},
		{RootFile, rootBytes},
		{TimestampFile, tsBytes},
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(o.Repo, f.name), f.data, 0o600); err != nil {
			return out, err
		}
	}
	return Published{
		Custom: custom, Target: target, TargetLength: length, RootVersion: root.Signed.Version,
		TargetsVersion: targetsV, SnapshotVersion: snapshotV, TimestampVersion: timestampV,
	}, nil
}

// Fails unless the root delegates every online role to this key
func checkOnlineKey(root *metadata.Metadata[metadata.RootType], priv ed25519.PrivateKey) error {
	key, err := metadata.KeyFromPublicKey(priv.Public())
	if err != nil {
		return err
	}
	id, err := key.ID()
	if err != nil {
		return err
	}
	for _, role := range OnlineRoles {
		r := root.Signed.Roles[role]
		if r == nil || !slices.Contains(r.KeyIDs, id) {
			return fmt.Errorf("snapshot: the online key %s is not a %s key of the root", id, role)
		}
	}
	return nil
}

func signed[T metadata.Roles](m *metadata.Metadata[T], signer signature.Signer) ([]byte, error) {
	if _, err := m.Sign(signer); err != nil {
		return nil, err
	}
	return m.ToBytes(false)
}

func metaFile(version int64, data []byte) *metadata.MetaFiles {
	sum := sha256.Sum256(data)
	return &metadata.MetaFiles{Version: version, Length: int64(len(data)), Hashes: metadata.Hashes{"sha256": sum[:]}}
}

// Reads the current timestamp and snapshot in the repo and returns the versions that follow them
func nextVersions(repo string) (targets, snap, ts int64, err error) {
	data, err := os.ReadFile(filepath.Join(repo, TimestampFile))
	if errors.Is(err, fs.ErrNotExist) {
		return 1, 1, 1, nil
	}
	if err != nil {
		return 0, 0, 0, err
	}
	cur, err := (&metadata.Metadata[metadata.TimestampType]{}).FromBytes(data)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("snapshot: existing %s: %w", TimestampFile, err)
	}
	sm := cur.Signed.Meta[metadata.SNAPSHOT+".json"]
	if sm == nil {
		return 0, 0, 0, fmt.Errorf("snapshot: existing %s names no snapshot", TimestampFile)
	}
	name := versionName(sm.Version, metadata.SNAPSHOT)
	data, err = os.ReadFile(filepath.Join(repo, name))
	if err != nil {
		return 0, 0, 0, fmt.Errorf("snapshot: the existing timestamp names %s: %w", name, err)
	}
	snapMeta, err := (&metadata.Metadata[metadata.SnapshotType]{}).FromBytes(data)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("snapshot: existing %s: %w", name, err)
	}
	tm := snapMeta.Signed.Meta[metadata.TARGETS+".json"]
	if tm == nil {
		return 0, 0, 0, fmt.Errorf("snapshot: existing %s names no targets", name)
	}
	return tm.Version + 1, sm.Version + 1, cur.Signed.Version + 1, nil
}

// Reads the meta table and hashes a finished crosswalk, refusing files that still have a WAL
func describe(ctx context.Context, path string) (Custom, error) {
	if fi, err := os.Stat(path + "-wal"); err == nil && fi.Size() > 0 {
		return Custom{}, fmt.Errorf("snapshot: %s has an unmerged WAL", path)
	}
	header := make([]byte, 20)
	f, err := os.Open(path)
	if err != nil {
		return Custom{}, err
	}
	_, err = io.ReadFull(f, header)
	_ = f.Close()
	if err != nil {
		return Custom{}, fmt.Errorf("snapshot: %s: %w", path, err)
	}
	if string(header[:16]) != "SQLite format 3\x00" || header[18] != 2 || header[19] != 2 {
		return Custom{}, fmt.Errorf("snapshot: %s is not a WAL-mode SQLite file", path)
	}
	db, err := sql.Open("sqlite", ReadOnlyDSN(path))
	if err != nil {
		return Custom{}, err
	}
	m, err := ReadMeta(ctx, db)
	_ = db.Close()
	if err != nil {
		return Custom{}, err
	}
	sum, length, err := FileSHA256(path)
	if err != nil {
		return Custom{}, err
	}
	return Custom{Version: m.Version, BuiltAt: m.BuiltAt.UTC().Format(time.RFC3339), SQLiteSHA256: sum, SQLiteLength: length, Items: m.Items, XIDs: m.XIDs}, nil
}

// Writes the zstd form of src into repo under its hash-prefixed target name
func compress(src, repo string) (name string, length int64, sum []byte, err error) {
	in, err := os.Open(src)
	if err != nil {
		return "", 0, nil, err
	}
	defer func() { _ = in.Close() }()
	tmp, err := os.CreateTemp(repo, ".target-*")
	if err != nil {
		return "", 0, nil, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	h := sha256.New()
	counter := &countWriter{w: io.MultiWriter(tmp, h)}
	enc, err := zstd.NewWriter(counter, zstd.WithEncoderLevel(zstd.SpeedBetterCompression))
	if err != nil {
		_ = tmp.Close()
		return "", 0, nil, err
	}
	if _, err := io.Copy(enc, in); err != nil {
		_ = enc.Close()
		_ = tmp.Close()
		return "", 0, nil, err
	}
	if err := enc.Close(); err != nil {
		_ = tmp.Close()
		return "", 0, nil, err
	}
	if err := tmp.Close(); err != nil {
		return "", 0, nil, err
	}
	sum = h.Sum(nil)
	name = hex.EncodeToString(sum) + "." + TargetName
	if err := os.Rename(tmp.Name(), filepath.Join(repo, name)); err != nil {
		return "", 0, nil, err
	}
	return name, counter.n, sum, nil
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// Sha256 hex and byte length of a file
func FileSHA256(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// Inflates a zstd stream into w and returns the sha256 hex and length of what it wrote
func Decompress(r io.Reader, w io.Writer) (string, int64, error) {
	dec, err := zstd.NewReader(r)
	if err != nil {
		return "", 0, err
	}
	defer dec.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), dec)
	if err != nil {
		return "", 0, fmt.Errorf("snapshot: decompress: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// Fails unless decompressed content matches the hash and length the target promises
func CheckContent(c Custom, sum string, length int64) error {
	if sum != c.SQLiteSHA256 {
		return fmt.Errorf("snapshot: crosswalk sha256 is %s, the signed target promises %s", sum, c.SQLiteSHA256)
	}
	if length != c.SQLiteLength {
		return fmt.Errorf("snapshot: crosswalk is %d bytes, the signed target promises %d", length, c.SQLiteLength)
	}
	return nil
}

// Runs a TUF client against the repo over a loopback file server and checks the downloaded crosswalk
func Verify(ctx context.Context, repo, rootPath string) (Custom, error) {
	rootBytes, err := os.ReadFile(rootPath)
	if err != nil {
		return Custom{}, err
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return Custom{}, err
	}
	srv := &http.Server{Handler: http.FileServer(http.Dir(repo)), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	defer func() { _ = srv.Close() }()
	base := "http://" + ln.Addr().String()
	work, err := os.MkdirTemp("", "crosswalk-verify-")
	if err != nil {
		return Custom{}, err
	}
	defer func() { _ = os.RemoveAll(work) }()
	cfg, err := config.New(base, rootBytes)
	if err != nil {
		return Custom{}, err
	}
	cfg.RemoteTargetsURL = base
	cfg.PrefixTargetsWithHash = true
	cfg.LocalMetadataDir = filepath.Join(work, "metadata")
	cfg.LocalTargetsDir = filepath.Join(work, "targets")
	up, err := updater.New(cfg)
	if err != nil {
		return Custom{}, err
	}
	if err := up.Refresh(); err != nil {
		return Custom{}, fmt.Errorf("snapshot: refresh metadata: %w", err)
	}
	info, err := up.GetTargetInfo(TargetName)
	if err != nil {
		return Custom{}, err
	}
	custom, err := ParseCustom(info.Custom)
	if err != nil {
		return Custom{}, err
	}
	path, _, err := up.DownloadTarget(info, filepath.Join(cfg.LocalTargetsDir, TargetName), "")
	if err != nil {
		return Custom{}, fmt.Errorf("snapshot: download target: %w", err)
	}
	f, err := os.Open(path)
	if err != nil {
		return Custom{}, err
	}
	defer func() { _ = f.Close() }()
	sum, length, err := Decompress(f, io.Discard)
	if err != nil {
		return Custom{}, err
	}
	return custom, CheckContent(custom, sum, length)
}

// Reads the version of a root metadata document
func RootVersion(data []byte) (int64, error) {
	root, err := (&metadata.Metadata[metadata.RootType]{}).FromBytes(data)
	if err != nil {
		return 0, err
	}
	return root.Signed.Version, nil
}

// Consistent-snapshot file name of a role version
func versionName(version int64, role string) string {
	return strconv.FormatInt(version, 10) + "." + role + ".json"
}
