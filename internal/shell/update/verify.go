package update

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"

	selfupdate "github.com/creativeprojects/go-selfupdate"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

const (
	actionsIssuer = "https://token.actions.githubusercontent.com"
	releaseFlow   = ".github/workflows/release.yml"
)

// Checks archives against checksums.txt and checksums.txt against its Sigstore bundle pinned to the release workflow
func newValidator(tag string, trust func() (root.TrustedMaterial, error)) (selfupdate.Validator, error) {
	id, err := releaseIdentity(Owner, Repo, tag)
	if err != nil {
		return nil, err
	}
	return new(selfupdate.PatternValidator).
		Add(checksumsName, &bundleValidator{identity: id, trust: trust}).
		SkipValidation(bundleName).
		Add("*", &selfupdate.ChecksumValidator{UniqueFilename: checksumsName}), nil
}

// Keyless signer identity of the release workflow run for one tag
func releaseIdentity(owner, repo, tag string) (verify.CertificateIdentity, error) {
	if tag == "" {
		return verify.CertificateIdentity{}, errors.New("update: release tag is empty")
	}
	san := fmt.Sprintf("https://github.com/%s/%s/%s@refs/tags/%s", owner, repo, releaseFlow, tag)
	return verify.NewShortCertificateIdentity(actionsIssuer, "", san, "")
}

// go-selfupdate validator that verifies a cosign bundle over the preceding asset
type bundleValidator struct {
	identity verify.CertificateIdentity
	trust    func() (root.TrustedMaterial, error)
}

// Names the bundle cosign sign-blob writes beside the signed file
func (b *bundleValidator) GetValidationAssetName(name string) string {
	return name + ".sigstore.json"
}

// Parses the bundle and verifies it over the artifact against the public Sigstore trust root
func (b *bundleValidator) Validate(name string, artifact, bundleJSON []byte) error {
	var bun bundle.Bundle
	if err := bun.UnmarshalJSON(bundleJSON); err != nil {
		return fmt.Errorf("sigstore bundle for %s is malformed: %w", name, err)
	}
	tm, err := b.trust()
	if err != nil {
		return err
	}
	return verifyEntity(tm, &bun, verify.WithArtifact(bytes.NewReader(artifact)), b.identity)
}

// Requires an embedded SCT, a transparency log entry, an observer timestamp, the artifact, and the identity
func verifyEntity(tm root.TrustedMaterial, entity verify.SignedEntity, artifact verify.ArtifactPolicyOption, id verify.CertificateIdentity) error {
	v, err := verify.NewVerifier(tm,
		verify.WithSignedCertificateTimestamps(1),
		verify.WithTransparencyLog(1),
		verify.WithObserverTimestamps(1),
	)
	if err != nil {
		return err
	}
	_, err = v.Verify(entity, verify.NewPolicy(artifact, verify.WithCertificateIdentity(id)))
	return err
}

// Fetches the public good trusted root through TUF with metadata cached under the data dir
func trustedRoot() (root.TrustedMaterial, error) {
	dir := dataDir.Load()
	if dir == nil || *dir == "" {
		return nil, errors.New("update: SetDataDir was not called so the Sigstore TUF cache has no home")
	}
	opts := tuf.DefaultOptions().WithCachePath(filepath.Join(*dir, "sigstore", "tuf"))
	return root.FetchTrustedRootWithOptions(opts)
}
