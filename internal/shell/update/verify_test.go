package update

import (
	"bytes"
	"encoding/hex"
	"errors"
	"regexp"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/data"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// Recorded keyless bundle signed by the sigstore-js release workflow on refs/heads/main
const (
	foreignBundle = "sigstore.js@2.0.0-provenance.sigstore.json"
	foreignSAN    = "https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main"
	foreignDigest = "46d4e2f74c4877316640000a6fdf8a8b59f1e0847667973e9859f774dd31b8f1e0937813b777fb66a2ac67d50540fe34640966eee9fc2ccca387082b4c85cd3c"
)

// Verifies the recorded bundle with the production verifier settings and the given identity
func verifyForeign(t *testing.T, id verify.CertificateIdentity) error {
	digest, err := hex.DecodeString(foreignDigest)
	if err != nil {
		t.Fatal(err)
	}
	return verifyEntity(data.TrustedRoot(t, "public-good.json"), data.Bundle(t, foreignBundle), verify.WithArtifactDigest("sha512", digest), id)
}

func TestForeignBundleVerifiesForItsOwnIdentity(t *testing.T) {
	id, err := verify.NewShortCertificateIdentity(actionsIssuer, "", foreignSAN, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyForeign(t, id); err != nil {
		t.Fatalf("production verifier rejects a genuine bundle for its own identity: %v", err)
	}
}

func TestForeignBundleRejectedForReleaseIdentity(t *testing.T) {
	id, err := releaseIdentity(Owner, Repo, "v4.0.0")
	if err != nil {
		t.Fatal(err)
	}
	err = verifyForeign(t, id)
	if _, ok := errors.AsType[*verify.ErrNoMatchingCertificateIdentity](err); !ok {
		t.Fatalf("bundle from another project was not rejected on identity: %v", err)
	}
}

func TestSameWorkflowOtherRefRejected(t *testing.T) {
	id, err := releaseIdentity("sigstore", "sigstore-js", "v2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	var mismatch *verify.ErrNoMatchingCertificateIdentity
	if err := verifyForeign(t, id); !errors.As(err, &mismatch) {
		t.Fatalf("bundle signed on another ref was not rejected on identity: %v", err)
	}
}

func TestBundleValidatorRejectsCorruptAndMismatched(t *testing.T) {
	raw, err := data.Bundle(t, foreignBundle).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	trust := func() (root.TrustedMaterial, error) { return data.TrustedRoot(t, "public-good.json"), nil }
	id, err := verify.NewShortCertificateIdentity(actionsIssuer, "", foreignSAN, "")
	if err != nil {
		t.Fatal(err)
	}
	v := &bundleValidator{identity: id, trust: trust}
	if err := v.Validate(checksumsName, []byte("checksums"), []byte("{not json")); err == nil {
		t.Fatal("malformed bundle accepted")
	}
	if err := v.Validate(checksumsName, []byte("not the signed artifact"), raw); err == nil {
		t.Fatal("bundle accepted for an artifact it does not cover")
	}
	loc := regexp.MustCompile(`"sig":\s*"`).FindIndex(raw)
	if loc == nil {
		t.Fatal("recorded bundle has no DSSE signature")
	}
	corrupt := bytes.Clone(raw)
	j := loc[1] + 10
	if corrupt[j] == 'A' {
		corrupt[j] = 'B'
	} else {
		corrupt[j] = 'A'
	}
	var bad bundle.Bundle
	if err := bad.UnmarshalJSON(corrupt); err != nil {
		t.Fatalf("corrupted bundle no longer parses: %v", err)
	}
	digest, _ := hex.DecodeString(foreignDigest)
	err = verifyEntity(data.TrustedRoot(t, "public-good.json"), &bad, verify.WithArtifactDigest("sha512", digest), id)
	var mismatch *verify.ErrNoMatchingCertificateIdentity
	if err == nil || errors.As(err, &mismatch) {
		t.Fatalf("bundle with a corrupted signature was not rejected on its signature: %v", err)
	}
	failing := &bundleValidator{identity: id, trust: func() (root.TrustedMaterial, error) { return nil, errors.New("tuf offline") }}
	if err := failing.Validate(checksumsName, []byte("checksums"), raw); err == nil {
		t.Fatal("verification passed without a trust root")
	}
}

func TestTrustedRootNeedsDataDir(t *testing.T) {
	old := dataDir.Load()
	t.Cleanup(func() { dataDir.Store(old) })
	dataDir.Store(nil)
	if _, err := trustedRoot(); err == nil {
		t.Fatal("trusted root fetched without a data dir")
	}
}
