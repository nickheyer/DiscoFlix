package tvdb

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/text/language"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

const castLimit = 20

// Appends claims about one TheTVDB record, skipping values that carry nothing
type claimer struct {
	kind, id, recordID string
	out                *[]model.Claim
}

// Appends a claim unless the value is empty or zero
func (c claimer) put(field string, value any) {
	if empty(value) {
		return
	}
	c.always(field, value)
}

// Appends a claim even for a zero value such as season 0
func (c claimer) always(field string, value any) {
	*c.out = append(*c.out, model.Claim{Kind: c.kind, Namespace: model.NSTVDB, ExternalID: c.id, Field: field, Value: value, RecordID: c.recordID})
}

// Attributes the following claims to another record, unchanged when that record is empty
func (c claimer) from(recordID string) claimer {
	if recordID != "" {
		c.recordID = recordID
	}
	return c
}

func empty(v any) bool {
	switch t := v.(type) {
	case string:
		return t == ""
	case int:
		return t == 0
	case float64:
		return t == 0
	case []string:
		return len(t) == 0
	case []model.Image:
		return len(t) == 0
	case []model.Person:
		return len(t) == 0
	}
	return v == nil
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// Reads the leading year of a year or date string, zero when absent
func yearOf(values ...string) int {
	for _, v := range values {
		if len(v) >= 4 {
			if y, err := strconv.Atoi(v[:4]); err == nil && y > 0 {
				return y
			}
		}
	}
	return 0
}

// Turns a three-letter language code into the ISO 639-1 code other sources use
func twoLetter(code string) string {
	if code == "" {
		return ""
	}
	b, err := language.ParseBase(code)
	if err != nil {
		return ""
	}
	return b.String()
}

// Turns a three-letter country code into ISO 3166-1 alpha-2
func countryCode(code string) string {
	if code == "" {
		return ""
	}
	r, err := language.ParseRegion(code)
	if err != nil {
		return ""
	}
	return r.String()
}

// Lowercases a status, naming a continuing series a returning series as other sources do
func statusOf(name string) string {
	if strings.EqualFold(name, "Continuing") {
		return "returning series"
	}
	return strings.ToLower(name)
}

// Turns a stored artwork path into a full URL on the artwork host
func absolute(path string) string {
	switch {
	case path == "", strings.HasPrefix(path, "http://"), strings.HasPrefix(path, "https://"):
		return path
	case strings.HasPrefix(path, "/"):
		return artBase + path
	}
	return artBase + "/banners/" + path
}

type named struct {
	Name string `json:"name"`
}

func names(list []named) []string {
	out := make([]string, 0, len(list))
	for _, n := range list {
		if n.Name != "" {
			out = append(out, n.Name)
		}
	}
	return out
}

type remoteID struct {
	ID         string `json:"id"`
	Type       int    `json:"type"`
	SourceName string `json:"sourceName"`
}

// Maps a remote id to a catalog namespace by source name, or by type code when unnamed
func namespaceOf(r remoteID) string {
	switch r.SourceName {
	case "IMDB":
		return model.NSIMDb
	case "TheMovieDB.com":
		return model.NSTMDB
	case "":
		switch r.Type {
		case 2:
			return model.NSIMDb
		case 10:
			return model.NSTMDB
		}
	}
	return ""
}

// Reports whether a record's remote ids include one foreign id
func carries(ids []remoteID, namespace, raw string) bool {
	for _, r := range ids {
		if namespaceOf(r) == namespace && r.ID == raw {
			return true
		}
	}
	return false
}

// Appends imdb ids and tmdb ids formatted for movies and series
func remoteClaims(c claimer, ids []remoteID) {
	for _, r := range ids {
		switch namespaceOf(r) {
		case model.NSIMDb:
			if imdbID.MatchString(r.ID) {
				c.put(model.XIDField(model.NSIMDb), r.ID)
			}
		case model.NSTMDB:
			n, err := strconv.ParseInt(r.ID, 10, 64)
			if err != nil || n <= 0 {
				continue
			}
			switch c.kind {
			case model.KindMovie:
				c.put(model.XIDField(model.NSTMDB), model.TMDBMovie(n))
			case model.KindSeries:
				c.put(model.XIDField(model.NSTMDB), model.TMDBSeries(n))
			}
		}
	}
}

type translation struct {
	Language string `json:"language"`
	Name     string `json:"name"`
	Overview string `json:"overview"`
}

type translations struct {
	Names     []translation
	Overviews []translation
	Aliases   []string
}

// Accepts the extended object form and the flat list form records use
func (t *translations) UnmarshalJSON(b []byte) error {
	if bytes.HasPrefix(bytes.TrimSpace(b), []byte("[")) {
		var list []translation
		if err := json.Unmarshal(b, &list); err != nil {
			return err
		}
		t.Names, t.Overviews = list, list
		return nil
	}
	var obj struct {
		Names     []translation `json:"nameTranslations"`
		Overviews []translation `json:"overviewTranslations"`
		Alias     []string      `json:"alias"`
		Aliases   []string      `json:"aliases"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return err
	}
	t.Names, t.Overviews, t.Aliases = obj.Names, obj.Overviews, slices.Concat(obj.Alias, obj.Aliases)
	return nil
}

func (t translations) name(lang string) string {
	for _, n := range t.Names {
		if n.Language == lang && n.Name != "" {
			return n.Name
		}
	}
	return ""
}

func (t translations) overview(lang string) string {
	for _, n := range t.Overviews {
		if n.Language == lang && n.Overview != "" {
			return n.Overview
		}
	}
	return ""
}

// Holds one child record's name and overview in the configured language
type translated struct {
	Name     string `json:"name"`
	Overview string `json:"overview"`
}

type alias struct {
	Language string `json:"language"`
	Name     string `json:"name"`
}

// Lists other names in the configured, original, and English languages, leaving out claimed titles
func aliasesOf(t translations, list []alias, lang3, original string, claimed ...string) []string {
	seen := map[string]bool{"": true}
	for _, c := range claimed {
		seen[c] = true
	}
	var out []string
	add := func(name string) {
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	add(t.name("eng"))
	for _, a := range t.Aliases {
		add(a)
	}
	for _, a := range list {
		if a.Language == lang3 || a.Language == original || a.Language == "eng" {
			add(a.Name)
		}
	}
	return out
}

type art struct {
	Image    string  `json:"image"`
	Language string  `json:"language"`
	Type     int     `json:"type"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Score    float64 `json:"score"`
}

// Maps TheTVDB artwork type codes to catalog artwork kinds
var artKinds = map[int]string{
	1: "banner", 2: "poster", 3: "backdrop", 5: "logo", 6: "banner", 7: "poster", 8: "backdrop",
	11: "still", 12: "still", 14: "poster", 15: "backdrop", 16: "banner", 23: "logo", 25: "logo",
}

// Folds the open-ended popularity score onto a zero to ten scale, keeping its order
func artScore(score float64) float64 {
	if score <= 0 {
		return 0
	}
	l := math.Log10(1 + score)
	return 10 * l / (1 + l)
}

// Appends artwork grouped by kind, keeping images in the configured language or without text
func artworkClaims(c claimer, list []art, lang3 string) {
	byKind := map[string][]model.Image{}
	var order []string
	for _, a := range list {
		kind, ok := artKinds[a.Type]
		if !ok || a.Image == "" || (a.Language != "" && a.Language != lang3) {
			continue
		}
		if _, seen := byKind[kind]; !seen {
			order = append(order, kind)
		}
		byKind[kind] = append(byKind[kind], model.Image{URL: absolute(a.Image), Width: a.Width, Height: a.Height, Language: twoLetter(a.Language), Score: artScore(a.Score)})
	}
	for _, k := range order {
		c.put(model.ArtworkField(k), byKind[k])
	}
}

type character struct {
	Name         string `json:"name"`
	PeopleType   string `json:"peopleType"`
	PersonName   string `json:"personName"`
	PersonImgURL string `json:"personImgURL"`
	Sort         int    `json:"sort"`
}

// Appends up to twenty billed performers and the directors, writers, and creators
func peopleClaims(c claimer, list []character) {
	sorted := slices.Clone(list)
	slices.SortStableFunc(sorted, func(a, b character) int { return a.Sort - b.Sort })
	var cast, crew []model.Person
	seen := map[string]bool{}
	for _, ch := range sorted {
		if ch.PersonName == "" {
			continue
		}
		switch ch.PeopleType {
		case "Actor", "Guest Star":
			if len(cast) < castLimit {
				cast = append(cast, model.Person{Name: ch.PersonName, Role: ch.PeopleType, Character: ch.Name, Order: ch.Sort, ImageURL: absolute(ch.PersonImgURL)})
			}
		case "Director", "Writer", "Creator":
			if !seen[ch.PersonName+"|"+ch.PeopleType] {
				seen[ch.PersonName+"|"+ch.PeopleType] = true
				crew = append(crew, model.Person{Name: ch.PersonName, Role: ch.PeopleType, ImageURL: absolute(ch.PersonImgURL)})
			}
		}
	}
	c.put(model.FieldCast, cast)
	c.put(model.FieldCrew, crew)
}

type contentRating struct {
	Name    string `json:"name"`
	Country string `json:"country"`
}

func certification(list []contentRating) string {
	for _, r := range list {
		if strings.EqualFold(r.Country, "usa") && r.Name != "" {
			return r.Name
		}
	}
	return ""
}

type company struct {
	Name               string `json:"name"`
	PrimaryCompanyType int    `json:"primaryCompanyType"`
}

type seasonType struct {
	Type string `json:"type"`
}

type seasonBase struct {
	ID                   int64      `json:"id"`
	Number               int        `json:"number"`
	Name                 string     `json:"name"`
	Image                string     `json:"image"`
	Type                 seasonType `json:"type"`
	NameTranslations     []string   `json:"nameTranslations"`
	OverviewTranslations []string   `json:"overviewTranslations"`
}

// Appends one season listed by its series, linked to the series
func (s seasonBase) claims(c claimer, tr translated, trRecord, parent string) {
	c.from(trRecord).put(model.FieldTitle, firstOf(tr.Name, s.Name))
	c.always(model.FieldOrdinal, s.Number)
	c.from(trRecord).put(model.FieldOverview, tr.Overview)
	if s.Image != "" {
		c.put(model.ArtworkField("poster"), []model.Image{{URL: absolute(s.Image)}})
	}
	c.put(model.ParentXIDField(model.NSTVDB), parent)
}

type seriesRecord struct {
	ID               int64           `json:"id"`
	Name             string          `json:"name"`
	Overview         string          `json:"overview"`
	FirstAired       string          `json:"firstAired"`
	LastAired        string          `json:"lastAired"`
	Year             string          `json:"year"`
	AverageRuntime   int             `json:"averageRuntime"`
	OriginalCountry  string          `json:"originalCountry"`
	OriginalLanguage string          `json:"originalLanguage"`
	Score            float64         `json:"score"`
	Status           named           `json:"status"`
	Genres           []named         `json:"genres"`
	Aliases          []alias         `json:"aliases"`
	Artworks         []art           `json:"artworks"`
	Characters       []character     `json:"characters"`
	Companies        []company       `json:"companies"`
	LatestNetwork    *company        `json:"latestNetwork"`
	OriginalNetwork  *company        `json:"originalNetwork"`
	ContentRatings   []contentRating `json:"contentRatings"`
	RemoteIDs        []remoteID      `json:"remoteIds"`
	Seasons          []seasonBase    `json:"seasons"`
	Translations     translations    `json:"translations"`
}

// Lists the aired-order seasons other sources number the same way
func (t *seriesRecord) officialSeasons() []seasonBase {
	var out []seasonBase
	for _, s := range t.Seasons {
		if s.Type.Type == "official" {
			out = append(out, s)
		}
	}
	return out
}

// Lists the latest, original, and other network companies once each
func (t *seriesRecord) networks() []string {
	var out []string
	add := func(c *company) {
		if c != nil && c.Name != "" && !slices.Contains(out, c.Name) {
			out = append(out, c.Name)
		}
	}
	add(t.LatestNetwork)
	add(t.OriginalNetwork)
	for i := range t.Companies {
		if t.Companies[i].PrimaryCompanyType == 1 {
			add(&t.Companies[i])
		}
	}
	return out
}

func (t *seriesRecord) claims(c claimer, lang3 string) {
	title := firstOf(t.Translations.name(lang3), t.Name)
	original := firstOf(t.Translations.name(t.OriginalLanguage), t.Name)
	c.put(model.FieldTitle, title)
	c.put(model.FieldOriginalTitle, original)
	c.put(model.FieldYear, yearOf(t.FirstAired, t.Year))
	c.put(model.FieldFirstAirDate, t.FirstAired)
	c.put(model.FieldLastAirDate, t.LastAired)
	c.put(model.FieldOverview, firstOf(t.Translations.overview(lang3), t.Translations.overview(t.OriginalLanguage), t.Overview))
	c.put(model.FieldRuntime, t.AverageRuntime)
	c.put(model.FieldGenres, names(t.Genres))
	c.put(model.FieldStatus, statusOf(t.Status.Name))
	c.put(model.FieldLanguage, twoLetter(t.OriginalLanguage))
	if cc := countryCode(t.OriginalCountry); cc != "" {
		c.put(model.FieldCountries, []string{cc})
	}
	c.put(model.FieldCertification, certification(t.ContentRatings))
	c.put(model.FieldNetworks, t.networks())
	seasons := 0
	for _, s := range t.officialSeasons() {
		if s.Number > 0 {
			seasons++
		}
	}
	c.put(model.FieldSeasonCount, seasons)
	c.put(model.RatingField(model.NSTVDB), t.Score)
	c.put(model.FieldAliases, aliasesOf(t.Translations, t.Aliases, lang3, t.OriginalLanguage, title, original))
	peopleClaims(c, t.Characters)
	remoteClaims(c, t.RemoteIDs)
	artworkClaims(c, t.Artworks, lang3)
}

type movieRecord struct {
	Name             string          `json:"name"`
	Year             string          `json:"year"`
	Runtime          int             `json:"runtime"`
	OriginalCountry  string          `json:"originalCountry"`
	OriginalLanguage string          `json:"originalLanguage"`
	Score            float64         `json:"score"`
	Status           named           `json:"status"`
	Genres           []named         `json:"genres"`
	Aliases          []alias         `json:"aliases"`
	Artworks         []art           `json:"artworks"`
	Characters       []character     `json:"characters"`
	ContentRatings   []contentRating `json:"contentRatings"`
	RemoteIDs        []remoteID      `json:"remoteIds"`
	Translations     translations    `json:"translations"`
	FirstRelease     struct {
		Date string `json:"date"`
	} `json:"first_release"`
}

func (m *movieRecord) claims(c claimer, lang3 string) {
	title := firstOf(m.Translations.name(lang3), m.Name)
	original := firstOf(m.Translations.name(m.OriginalLanguage), m.Name)
	c.put(model.FieldTitle, title)
	c.put(model.FieldOriginalTitle, original)
	c.put(model.FieldYear, yearOf(m.Year, m.FirstRelease.Date))
	c.put(model.FieldReleaseDate, m.FirstRelease.Date)
	c.put(model.FieldOverview, firstOf(m.Translations.overview(lang3), m.Translations.overview(m.OriginalLanguage)))
	c.put(model.FieldRuntime, m.Runtime)
	c.put(model.FieldGenres, names(m.Genres))
	c.put(model.FieldStatus, statusOf(m.Status.Name))
	c.put(model.FieldLanguage, twoLetter(m.OriginalLanguage))
	if cc := countryCode(m.OriginalCountry); cc != "" {
		c.put(model.FieldCountries, []string{cc})
	}
	c.put(model.FieldCertification, certification(m.ContentRatings))
	c.put(model.RatingField(model.NSTVDB), m.Score)
	c.put(model.FieldAliases, aliasesOf(m.Translations, m.Aliases, lang3, m.OriginalLanguage, title, original))
	peopleClaims(c, m.Characters)
	remoteClaims(c, m.RemoteIDs)
	artworkClaims(c, m.Artworks, lang3)
}

type episodeBase struct {
	ID                   int64    `json:"id"`
	Name                 string   `json:"name"`
	Overview             string   `json:"overview"`
	Aired                string   `json:"aired"`
	Image                string   `json:"image"`
	Number               int      `json:"number"`
	Runtime              int      `json:"runtime"`
	NameTranslations     []string `json:"nameTranslations"`
	OverviewTranslations []string `json:"overviewTranslations"`
}

// Appends one episode listed by its season, linked to the season
func (e episodeBase) claims(c claimer, tr translated, trRecord, parent string) {
	c.from(trRecord).put(model.FieldTitle, firstOf(tr.Name, e.Name))
	c.always(model.FieldOrdinal, e.Number)
	c.from(trRecord).put(model.FieldOverview, firstOf(tr.Overview, e.Overview))
	c.put(model.FieldAirDate, e.Aired)
	c.put(model.FieldRuntime, e.Runtime)
	if e.Image != "" {
		c.put(model.ArtworkField("still"), []model.Image{{URL: absolute(e.Image)}})
	}
	c.put(model.ParentXIDField(model.NSTVDB), parent)
}

type seasonRecord struct {
	Number       int           `json:"number"`
	Name         string        `json:"name"`
	Image        string        `json:"image"`
	SeriesID     int64         `json:"seriesId"`
	Year         string        `json:"year"`
	Episodes     []episodeBase `json:"episodes"`
	Artwork      []art         `json:"artwork"`
	Translations translations  `json:"translations"`
}

// Appends the season itself, linked to its series
func (s *seasonRecord) claims(c claimer, lang3, original, parent string) {
	c.put(model.FieldTitle, firstOf(s.Translations.name(lang3), s.Name))
	c.always(model.FieldOrdinal, s.Number)
	c.put(model.FieldOverview, firstOf(s.Translations.overview(lang3), s.Translations.overview(original)))
	c.put(model.FieldYear, yearOf(s.Year))
	c.put(model.FieldEpisodeCount, len(s.Episodes))
	listed := slices.ContainsFunc(s.Artwork, func(a art) bool { return absolute(a.Image) == absolute(s.Image) })
	if s.Image != "" && !listed {
		s.Artwork = append(s.Artwork, art{Image: s.Image, Type: 7})
	}
	artworkClaims(c, s.Artwork, lang3)
	c.put(model.ParentXIDField(model.NSTVDB), parent)
}

type episodeRecord struct {
	Name         string       `json:"name"`
	Overview     string       `json:"overview"`
	Aired        string       `json:"aired"`
	Image        string       `json:"image"`
	Number       int          `json:"number"`
	Runtime      int          `json:"runtime"`
	Seasons      []seasonBase `json:"seasons"`
	RemoteIDs    []remoteID   `json:"remoteIds"`
	Characters   []character  `json:"characters"`
	Translations translations `json:"translations"`
}

// Appends one episode, linked to its aired-order season
func (e *episodeRecord) claims(c claimer, lang3 string) {
	c.put(model.FieldTitle, firstOf(e.Translations.name(lang3), e.Name))
	c.always(model.FieldOrdinal, e.Number)
	c.put(model.FieldOverview, firstOf(e.Translations.overview(lang3), e.Overview))
	c.put(model.FieldAirDate, e.Aired)
	c.put(model.FieldRuntime, e.Runtime)
	if e.Image != "" {
		c.put(model.ArtworkField("still"), []model.Image{{URL: absolute(e.Image)}})
	}
	peopleClaims(c, e.Characters)
	remoteClaims(c, e.RemoteIDs)
	for _, s := range e.Seasons {
		if s.Type.Type == "official" {
			c.put(model.ParentXIDField(model.NSTVDB), model.TVDBValue(model.KindSeason, s.ID))
			break
		}
	}
}

type searchHit struct {
	TVDBID          string            `json:"tvdb_id"`
	Name            string            `json:"name"`
	Year            string            `json:"year"`
	Overview        string            `json:"overview"`
	Overviews       map[string]string `json:"overviews"`
	Translations    map[string]string `json:"translations"`
	PrimaryLanguage string            `json:"primary_language"`
	Country         string            `json:"country"`
	Network         string            `json:"network"`
	Status          string            `json:"status"`
	FirstAirTime    string            `json:"first_air_time"`
	Genres          []string          `json:"genres"`
	Aliases         []string          `json:"aliases"`
	RemoteIDs       []remoteID        `json:"remote_ids"`
}

// Appends one search result as a movie or series group
func (h *searchHit) claims(kind, recordID, lang3 string, out *[]model.Claim) {
	id, err := strconv.ParseInt(h.TVDBID, 10, 64)
	if err != nil || id <= 0 {
		return
	}
	c := claimer{kind: kind, id: model.TVDBValue(kind, id), recordID: recordID, out: out}
	title := firstOf(h.Translations[lang3], h.Name)
	original := firstOf(h.Translations[h.PrimaryLanguage], h.Name)
	c.put(model.FieldTitle, title)
	c.put(model.FieldOriginalTitle, original)
	c.put(model.FieldYear, yearOf(h.Year, h.FirstAirTime))
	if kind == model.KindSeries {
		c.put(model.FieldFirstAirDate, h.FirstAirTime)
	} else {
		c.put(model.FieldReleaseDate, h.FirstAirTime)
	}
	c.put(model.FieldOverview, firstOf(h.Overviews[lang3], h.Overviews[h.PrimaryLanguage], h.Overview))
	c.put(model.FieldLanguage, twoLetter(h.PrimaryLanguage))
	if cc := countryCode(h.Country); cc != "" {
		c.put(model.FieldCountries, []string{cc})
	}
	if h.Network != "" {
		c.put(model.FieldNetworks, []string{h.Network})
	}
	c.put(model.FieldStatus, statusOf(h.Status))
	c.put(model.FieldGenres, h.Genres)
	var aliases []string
	for _, a := range h.Aliases {
		if a != "" && a != title && a != original && !slices.Contains(aliases, a) {
			aliases = append(aliases, a)
		}
	}
	c.put(model.FieldAliases, aliases)
	remoteClaims(c, h.RemoteIDs)
}
