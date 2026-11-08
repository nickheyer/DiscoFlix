package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"testing"

	selfupdate "github.com/creativeprojects/go-selfupdate"
	"github.com/sigstore/sigstore-go/pkg/root"
)

func TestAssetName(t *testing.T) {
	tests := []struct {
		version, goos, goarch, want string
	}{
		{"4.0.0", "linux", "amd64", "discoflix_4.0.0_linux_amd64.tar.gz"},
		{"4.0.0", "linux", "arm64", "discoflix_4.0.0_linux_arm64.tar.gz"},
		{"4.0.0", "darwin", "arm64", "discoflix_4.0.0_darwin_arm64.tar.gz"},
		{"4.0.0", "darwin", "amd64", "discoflix_4.0.0_darwin_amd64.tar.gz"},
		{"4.0.0", "windows", "amd64", "discoflix_4.0.0_windows_amd64.zip"},
		{"4.1.0-rc.2", "linux", "amd64", "discoflix_4.1.0-rc.2_linux_amd64.tar.gz"},
	}
	for _, tc := range tests {
		got := AssetName(tc.version, tc.goos, tc.goarch)
		if got != tc.want {
			t.Errorf("AssetName(%s, %s, %s) = %s, want %s", tc.version, tc.goos, tc.goarch, got, tc.want)
		}
		if !regexp.MustCompile(assetFilter(tc.goos, tc.goarch)).MatchString(got) {
			t.Errorf("filter for %s/%s rejects %s", tc.goos, tc.goarch, got)
		}
	}
}

func TestAssetFilterRejectsNeighbours(t *testing.T) {
	re := regexp.MustCompile(assetFilter("linux", "amd64"))
	for _, name := range []string{
		"discoflix_4.0.0_linux_arm64.tar.gz",
		"discoflix-headless_4.0.0_linux_amd64.tar.gz",
		"discoflix_4.0.0_linux_amd64.tar.gz.sbom.json",
		"discoflix_4.0.0_linux_amd64.zip",
		"checksums.txt",
		"discoflix_4.0.0_windows_amd64.zip",
	} {
		if re.MatchString(name) {
			t.Errorf("linux/amd64 filter accepts %s", name)
		}
	}
}

func TestValidationChainNames(t *testing.T) {
	v, err := newValidator("v4.0.0", func() (root.TrustedMaterial, error) { return nil, errors.New("unused") })
	if err != nil {
		t.Fatal(err)
	}
	archive := AssetName("4.0.0", "linux", "amd64")
	if got := v.GetValidationAssetName(archive); got != checksumsName {
		t.Fatalf("archive proof is %s, want %s", got, checksumsName)
	}
	if got := v.GetValidationAssetName(checksumsName); got != bundleName {
		t.Fatalf("checksums proof is %s, want %s", got, bundleName)
	}
	rv := v.(selfupdate.RecursiveValidator)
	if !rv.MustContinueValidation(checksumsName) || rv.MustContinueValidation(bundleName) {
		t.Fatal("chain must continue past checksums.txt and stop at the bundle")
	}
}

func TestChecksumStepBindsArchive(t *testing.T) {
	v, err := newValidator("v4.0.0", func() (root.TrustedMaterial, error) { return nil, errors.New("unused") })
	if err != nil {
		t.Fatal(err)
	}
	archive := []byte("archive bytes")
	name := AssetName("4.0.0", "linux", "amd64")
	sum := sha256.Sum256(archive)
	checksums := []byte(hex.EncodeToString(sum[:]) + "  " + name + "\n" + strings.Repeat("0", 64) + "  other.zip\n")
	if err := v.Validate(name, archive, checksums); err != nil {
		t.Fatalf("matching checksum rejected: %v", err)
	}
	if err := v.Validate(name, []byte("tampered"), checksums); err == nil {
		t.Fatal("tampered archive accepted")
	}
}

func TestReleaseIdentityPinsTag(t *testing.T) {
	id, err := releaseIdentity(Owner, Repo, "v4.2.0")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := id.SubjectAlternativeName.SubjectAlternativeName, "https://github.com/nickheyer/DiscoFlix/.github/workflows/release.yml@refs/tags/v4.2.0"; got != want {
		t.Fatalf("SAN %s, want %s", got, want)
	}
	if id.SubjectAlternativeName.Regexp.String() != "" {
		t.Fatal("SAN must be an exact match, not a regex")
	}
	if got := id.Issuer.Issuer; got != actionsIssuer {
		t.Fatalf("issuer %s, want %s", got, actionsIssuer)
	}
	if _, err := releaseIdentity(Owner, Repo, ""); err == nil {
		t.Fatal("empty tag accepted")
	}
}
