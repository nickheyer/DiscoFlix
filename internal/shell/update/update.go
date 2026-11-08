// Finds, verifies, and installs signed DiscoFlix releases from GitHub
package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/Masterminds/semver/v3"
	selfupdate "github.com/creativeprojects/go-selfupdate"
)

const (
	Owner         = "nickheyer"
	Repo          = "DiscoFlix"
	project       = "discoflix"
	checksumsName = "checksums.txt"
	bundleName    = checksumsName + ".sigstore.json"
	maxAssetBytes = 1 << 30
)

// Returned by RestartAfterApply when a service manager must start the new binary after a non-zero exit
var ErrServiceRestart = errors.New("update: exit with a non-zero status so the service manager starts the new binary")

var (
	dataDir atomic.Pointer[string]
	// Path of the running binary captured before any rename, since Windows reports the renamed path afterwards
	startPath, startPathErr = executable()
)

// A newer release whose archive, checksums, and signature bundle are all published
type Release struct {
	Version     string
	Tag         string
	AssetName   string
	URL         string
	Notes       string
	PublishedAt time.Time
}

// Sets the data directory under which the Sigstore TUF metadata is cached
func SetDataDir(dir string) {
	dataDir.Store(&dir)
}

// Returns the newest signed release above current for this OS and arch, or nil when current is the newest
func Check(ctx context.Context, current string) (*Release, error) {
	cur, err := semver.NewVersion(current)
	if err != nil {
		return nil, fmt.Errorf("update: current version %q is not a release version: %w", current, err)
	}
	src, err := newSource()
	if err != nil {
		return nil, err
	}
	probe, err := selfupdate.NewUpdater(selfupdate.Config{Source: src, Filters: []string{assetFilter(runtime.GOOS, runtime.GOARCH)}})
	if err != nil {
		return nil, err
	}
	latest, found, err := probe.DetectLatest(ctx, repository())
	if err != nil {
		return nil, err
	}
	if !found || !latest.GreaterThan(cur.String()) {
		return nil, nil
	}
	tag := src.tag(latest.ReleaseID)
	if tag == "" {
		return nil, fmt.Errorf("update: release %d has no tag", latest.ReleaseID)
	}
	rel, _, err := detect(ctx, src, tag)
	if err != nil {
		return nil, err
	}
	return &Release{
		Version:     rel.Version(),
		Tag:         tag,
		AssetName:   rel.AssetName,
		URL:         rel.URL,
		Notes:       rel.ReleaseNotes,
		PublishedAt: rel.PublishedAt,
	}, nil
}

// Downloads the release archive, verifies its checksum and the Sigstore bundle, and swaps the running binary
func Apply(ctx context.Context, rel *Release) error {
	if rel == nil {
		return errors.New("update: Apply needs a release from Check")
	}
	if startPathErr != nil {
		return fmt.Errorf("update: cannot locate the running binary: %w", startPathErr)
	}
	src, err := newSource()
	if err != nil {
		return err
	}
	sr, v, err := detect(ctx, src, rel.Tag)
	if err != nil {
		return err
	}
	if sr.AssetName != rel.AssetName {
		return fmt.Errorf("update: release %s now offers %s instead of %s", rel.Tag, sr.AssetName, rel.AssetName)
	}
	archive, err := download(ctx, src, sr, sr.AssetID)
	if err != nil {
		return err
	}
	name, data := sr.AssetName, archive
	for _, step := range sr.ValidationChain {
		proof, err := download(ctx, src, sr, step.ValidationAssetID)
		if err != nil {
			return err
		}
		if err := v.Validate(name, data, proof); err != nil {
			return fmt.Errorf("update: %s failed verification: %w", name, err)
		}
		name, data = step.ValidationAssetName, proof
	}
	bin, err := selfupdate.DecompressCommand(bytes.NewReader(archive), sr.AssetName, binaryName(runtime.GOOS), runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return fmt.Errorf("update: %s holds no %s binary: %w", sr.AssetName, binaryName(runtime.GOOS), err)
	}
	return replaceExecutable(startPath, bin)
}

// Detects the tagged release with the verifying validator and checks its asset and proof chain
func detect(ctx context.Context, src *releaseSource, tag string) (*selfupdate.Release, selfupdate.Validator, error) {
	v, err := newValidator(tag, trustedRoot)
	if err != nil {
		return nil, nil, err
	}
	up, err := selfupdate.NewUpdater(selfupdate.Config{Source: src, Validator: v, Filters: []string{assetFilter(runtime.GOOS, runtime.GOARCH)}})
	if err != nil {
		return nil, nil, err
	}
	rel, found, err := up.DetectVersion(ctx, repository(), tag)
	if err != nil {
		return nil, nil, fmt.Errorf("update: cannot read release %s: %w", tag, err)
	}
	if !found {
		return nil, nil, fmt.Errorf("update: release %s has no %s asset", tag, AssetName("*", runtime.GOOS, runtime.GOARCH))
	}
	if want := AssetName(rel.Version(), runtime.GOOS, runtime.GOARCH); rel.AssetName != want {
		return nil, nil, fmt.Errorf("update: release %s offers %s where %s was expected", tag, rel.AssetName, want)
	}
	chain := rel.ValidationChain
	if len(chain) != 2 || chain[0].ValidationAssetName != checksumsName || chain[1].ValidationAssetName != bundleName {
		return nil, nil, fmt.Errorf("update: release %s lacks %s and %s", tag, checksumsName, bundleName)
	}
	return rel, v, nil
}

// GoReleaser archive name for a version, OS, and architecture
func AssetName(version, goos, goarch string) string {
	return project + "_" + version + "_" + goos + "_" + goarch + archiveExt(goos)
}

// Anchored filter that matches only this platform's archive in a release
func assetFilter(goos, goarch string) string {
	return "^" + regexp.QuoteMeta(project+"_") + `\d+\.\d+\.\d+[^_]*` + regexp.QuoteMeta("_"+goos+"_"+goarch+archiveExt(goos)) + "$"
}

// Zip on Windows and gzipped tar elsewhere, matching the GoReleaser archive formats
func archiveExt(goos string) string {
	if goos == "windows" {
		return ".zip"
	}
	return ".tar.gz"
}

// Executable name inside the archive
func binaryName(goos string) string {
	if goos == "windows" {
		return project + ".exe"
	}
	return project
}

// GitHub owner and name of the release project
func repository() selfupdate.Repository {
	return selfupdate.NewRepositorySlug(Owner, Repo)
}

// Reads one release asset into memory with a size ceiling
func download(ctx context.Context, src *releaseSource, rel *selfupdate.Release, id int64) ([]byte, error) {
	rc, err := src.DownloadReleaseAsset(ctx, rel, id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, maxAssetBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxAssetBytes {
		return nil, fmt.Errorf("update: asset %d exceeds %d bytes", id, maxAssetBytes)
	}
	return data, nil
}

// GitHub source that lists releases once per operation and remembers each release tag
type releaseSource struct {
	selfupdate.Source
	rels []selfupdate.SourceRelease
}

// Builds a GitHub source that honours GITHUB_TOKEN
func newSource() (*releaseSource, error) {
	gh, err := selfupdate.NewGitHubSource(selfupdate.GitHubConfig{})
	if err != nil {
		return nil, err
	}
	return &releaseSource{Source: gh}, nil
}

// Lists releases from GitHub on first use and serves the same list afterwards
func (s *releaseSource) ListReleases(ctx context.Context, repo selfupdate.Repository) ([]selfupdate.SourceRelease, error) {
	if s.rels != nil {
		return s.rels, nil
	}
	rels, err := s.Source.ListReleases(ctx, repo)
	if err != nil {
		return nil, err
	}
	s.rels = rels
	return rels, nil
}

// Tag name of a listed release
func (s *releaseSource) tag(id int64) string {
	for _, r := range s.rels {
		if r.GetID() == id {
			return r.GetTagName()
		}
	}
	return ""
}

// Absolute path of the running binary with symlinks resolved
func executable() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}
