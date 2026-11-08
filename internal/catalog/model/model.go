// Package model holds the kinds, fields, and value types the catalog and its providers share
package model

import (
	"errors"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Entity kinds the catalog resolves in this phase
const (
	KindMovie   = "movie"
	KindSeries  = "series"
	KindSeason  = "season"
	KindEpisode = "episode"
)

// Kinds lists every kind in display order
var Kinds = []string{KindMovie, KindSeries, KindSeason, KindEpisode}

// ValidKind reports whether a kind string is one the catalog accepts
func ValidKind(k string) bool { return slices.Contains(Kinds, k) }

// Field names every provider writes against, values are JSON
const (
	FieldTitle         = "title"
	FieldOriginalTitle = "original_title"
	FieldYear          = "year"
	FieldReleaseDate   = "release_date"
	FieldOverview      = "overview"
	FieldTagline       = "tagline"
	FieldRuntime       = "runtime"
	FieldGenres        = "genres"
	FieldStatus        = "status"
	FieldLanguage      = "language"
	FieldCountries     = "countries"
	FieldCertification = "certification"
	FieldHomepage      = "homepage"
	FieldNetworks      = "networks"
	FieldFirstAirDate  = "first_air_date"
	FieldLastAirDate   = "last_air_date"
	FieldSeasonCount   = "season_count"
	FieldEpisodeCount  = "episode_count"
	FieldAirDate       = "air_date"
	FieldOrdinal       = "ordinal"
	FieldPopularity    = "popularity"
	FieldKeywords      = "keywords"
	FieldCast          = "cast"
	FieldCrew          = "crew"
	FieldCollection    = "collection"
	FieldAliases       = "aliases"
	FieldRatingPrefix  = "rating."
	FieldVotesPrefix   = "votes."
	FieldXIDPrefix     = "xid."
	FieldParentPrefix  = "parent.xid."
	FieldArtworkPrefix = "artwork."
)

// XIDField names the field that carries an external id in a namespace
func XIDField(namespace string) string { return FieldXIDPrefix + namespace }

// ParentXIDField names the field that carries the parent's external id in a namespace
func ParentXIDField(namespace string) string { return FieldParentPrefix + namespace }

// RatingField names a source's rating field
func RatingField(source string) string { return FieldRatingPrefix + source }

// VotesField names a source's vote count field
func VotesField(source string) string { return FieldVotesPrefix + source }

// ArtworkField names an artwork kind field such as artwork.poster
func ArtworkField(kind string) string { return FieldArtworkPrefix + kind }

// External id namespaces
const (
	NSIMDb           = "imdb"
	NSTMDB           = "tmdb"
	NSTVDB           = "tvdb"
	NSWikidata       = "wikidata"
	NSTrakt          = "trakt"
	NSLetterboxd     = "letterboxd"
	NSTVmaze         = "tvmaze"
	NSNetflix        = "netflix"
	NSRottenTomatoes = "rottentomatoes"
	NSMetacritic     = "metacritic"
	NSAniDB          = "anidb"
	NSAniList        = "anilist"
	NSMAL            = "mal"
	NSDouban         = "douban"
	NSKinopoisk      = "kinopoisk"
	NSAppleTV        = "appletv"
	NSPlex           = "plex"
)

// Claim is one assertion a source makes about one external record
type Claim struct {
	Kind       string
	Namespace  string
	ExternalID string
	Field      string
	Value      any
	Confidence float32
	RecordID   string
}

// Image describes one artwork a source offers, carried as the value of an artwork field
type Image struct {
	URL      string  `json:"url"`
	Width    int     `json:"width,omitempty"`
	Height   int     `json:"height,omitempty"`
	Language string  `json:"lang,omitempty"`
	Score    float64 `json:"score,omitempty"`
}

// Person is one cast or crew credit
type Person struct {
	Name      string `json:"name"`
	Role      string `json:"role,omitempty"`
	Character string `json:"character,omitempty"`
	Order     int    `json:"order,omitempty"`
	ImageURL  string `json:"image,omitempty"`
}

// Labeled is one scored pair with the decision a person or a hard id made about it
type Labeled struct {
	Features map[string]float64
	Match    bool
}

// ErrTooFewPairs is returned by a trainer that keeps its previous weights because the sample is too small
var ErrTooFewPairs = errors.New("catalog: too few comparison vectors to fit")

// Record is the comparison view of one entity or candidate the matcher scores
type Record struct {
	Kind     string
	Titles   []string
	Year     int
	Runtime  int
	Language string
	XIDs     map[string]string
}

// Normalize folds a title for equality and prefix search, lowercase without accents or punctuation
func Normalize(title string) string {
	var b strings.Builder
	lastSpace := true
	for _, r := range norm.NFD.String(title) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(unicode.ToLower(r))
			lastSpace = false
		case r == '&':
			if !lastSpace {
				b.WriteByte(' ')
			}
			b.WriteString("and ")
			lastSpace = true
		default:
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}

// External id value formats, kind-qualified where a source reuses numbers across kinds
//
//	imdb       tt0133093 for every kind
//	tmdb       movie/603, tv/1396, tv/1396/1, tv/1396/1/2
//	tvdb       movie/12, series/81189, season/16, episode/349232
//	trakt      movie/<id or slug>, show/<id or slug>, season/<id>, episode/<id>
//	wikidata   Q83495
//	others     the raw identifier the site uses in its URLs

// TMDBMovie formats a TMDB movie id
func TMDBMovie(id int64) string { return "movie/" + itoa(id) }

// TMDBSeries formats a TMDB series id
func TMDBSeries(id int64) string { return "tv/" + itoa(id) }

// TMDBSeason formats a TMDB season by series id and season number
func TMDBSeason(series int64, season int) string {
	return "tv/" + itoa(series) + "/" + itoa(int64(season))
}

// TMDBEpisode formats a TMDB episode by series id, season number, and episode number
func TMDBEpisode(series int64, season, episode int) string {
	return "tv/" + itoa(series) + "/" + itoa(int64(season)) + "/" + itoa(int64(episode))
}

// TVDBValue formats a TVDB id with its kind prefix
func TVDBValue(kind string, id int64) string {
	switch kind {
	case KindMovie:
		return "movie/" + itoa(id)
	case KindSeason:
		return "season/" + itoa(id)
	case KindEpisode:
		return "episode/" + itoa(id)
	}
	return "series/" + itoa(id)
}

// TraktValue formats a Trakt id or slug with its kind prefix
func TraktValue(kind, id string) string {
	switch kind {
	case KindMovie:
		return "movie/" + id
	case KindSeason:
		return "season/" + id
	case KindEpisode:
		return "episode/" + id
	}
	return "show/" + id
}

// SplitValue separates a kind-qualified id into its prefix and the trailing path
func SplitValue(value string) (prefix, rest string) {
	before, after, found := strings.Cut(value, "/")
	if !found {
		return "", value
	}
	return before, after
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
