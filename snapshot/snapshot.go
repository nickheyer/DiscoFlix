// Builds, signs, and verifies the Wikidata crosswalk that DiscoFlix installs read offline
package snapshot

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// File and target names shared by the builder, the publisher, and the client
const (
	FileName   = "crosswalk.sqlite"
	TargetName = "crosswalk.sqlite.zst"
	Source     = "wikidata"
	License    = "CC0-1.0"
	// Formats built_at into the compact version string
	VersionLayout = "20060102T150405Z"
)

// Title kinds stored in the title table
const (
	TitleLabel    = "label"
	TitleOriginal = "original"
	TitleAlias    = "alias"
)

// Trusted TUF root every client starts from
//
//go:embed root.json
var Root []byte

// Target metadata the client compares and verifies before swapping files
type Custom struct {
	Version      string `json:"version"`
	BuiltAt      string `json:"built_at"`
	SQLiteSHA256 string `json:"sqlite_sha256"`
	SQLiteLength int64  `json:"sqlite_length"`
	Items        int64  `json:"items"`
	XIDs         int64  `json:"xids"`
}

// Decodes and checks the custom block of the crosswalk target
func ParseCustom(raw *json.RawMessage) (Custom, error) {
	var c Custom
	if raw == nil {
		return c, fmt.Errorf("snapshot: target %s carries no custom metadata", TargetName)
	}
	if err := json.Unmarshal(*raw, &c); err != nil {
		return c, fmt.Errorf("snapshot: decode target custom metadata: %w", err)
	}
	if c.Version == "" || len(c.SQLiteSHA256) != 64 || c.SQLiteLength <= 0 {
		return c, fmt.Errorf("snapshot: target custom metadata is incomplete: %+v", c)
	}
	return c, nil
}

// One Wikidata external-id property and how its values are written
type Property struct {
	ID        string
	Namespace string
	Kind      string
	Format    func(value string) (string, bool)
}

// Every external-id property the crosswalk extracts
var Properties = []Property{
	{ID: "P345", Namespace: model.NSIMDb, Format: imdbValue},
	{ID: "P4947", Namespace: model.NSTMDB, Kind: model.KindMovie, Format: prefixed("movie/")},
	{ID: "P4983", Namespace: model.NSTMDB, Kind: model.KindSeries, Format: prefixed("tv/")},
	{ID: "P4835", Namespace: model.NSTVDB, Kind: model.KindSeries, Format: prefixed("series/")},
	{ID: "P12196", Namespace: model.NSTVDB, Kind: model.KindMovie, Format: prefixed("movie/")},
	{ID: "P8013", Namespace: model.NSTrakt, Format: traktValue},
	{ID: "P6127", Namespace: model.NSLetterboxd, Kind: model.KindMovie, Format: raw},
	{ID: "P8600", Namespace: model.NSTVmaze, Kind: model.KindSeries, Format: raw},
	{ID: "P1874", Namespace: model.NSNetflix, Format: raw},
	{ID: "P1258", Namespace: model.NSRottenTomatoes, Format: raw},
	{ID: "P1712", Namespace: model.NSMetacritic, Format: raw},
	{ID: "P5646", Namespace: model.NSAniDB, Format: raw},
	{ID: "P8729", Namespace: model.NSAniList, Format: raw},
	{ID: "P4086", Namespace: model.NSMAL, Format: raw},
	{ID: "P4529", Namespace: model.NSDouban, Format: raw},
	{ID: "P2603", Namespace: model.NSKinopoisk, Format: raw},
	{ID: "P9586", Namespace: model.NSAppleTV, Format: raw},
	{ID: "P11460", Namespace: model.NSPlex, Format: raw},
}

// Every namespace a crosswalk file can hold, wikidata included
func Namespaces() []string {
	out := []string{model.NSWikidata}
	for _, p := range Properties {
		if !slices.Contains(out, p.Namespace) {
			out = append(out, p.Namespace)
		}
	}
	return out
}

// Formats a QID number as the wikidata namespace value
func WikidataValue(qid int64) string { return fmt.Sprintf("Q%d", qid) }

// Wikidata classes the extraction walks
const (
	ClassSeason  = "Q3464665"
	ClassEpisode = "Q21191270"
)

// Classes that map to movie through instance of and the subclass walk
var FilmClasses = []string{"Q11424", "Q24862", "Q202866", "Q506240", "Q93204"}

// Classes that map to series through instance of and the subclass walk
var SeriesClasses = []string{"Q5398426", "Q15416", "Q1259759", "Q581714"}

func raw(v string) (string, bool) { return v, clean(v) }

func clean(v string) bool { return v != "" && !strings.ContainsAny(v, " \t\r\n") }

func imdbValue(v string) (string, bool) { return v, clean(v) && strings.HasPrefix(v, "tt") }

func prefixed(prefix string) func(string) (string, bool) {
	return func(v string) (string, bool) { return prefix + v, clean(v) && !strings.Contains(v, "/") }
}

// Rewrites movies, shows, seasons, and episodes paths to the singular catalog prefixes
func traktValue(v string) (string, bool) {
	kind, slug, ok := strings.Cut(v, "/")
	if !ok || !clean(slug) || strings.Contains(slug, "/") {
		return "", false
	}
	switch kind {
	case "movies", "movie":
		return "movie/" + slug, true
	case "shows", "show":
		return "show/" + slug, true
	case "seasons", "season":
		return "season/" + slug, true
	case "episodes", "episode":
		return "episode/" + slug, true
	}
	return "", false
}
