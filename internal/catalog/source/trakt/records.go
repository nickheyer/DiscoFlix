package trakt

import (
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Appends claims about one Trakt record, skipping values that carry nothing
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
	*c.out = append(*c.out, model.Claim{Kind: c.kind, Namespace: model.NSTrakt, ExternalID: c.id, Field: field, Value: value, RecordID: c.recordID})
}

// Appends the translated text attributed to its own record, otherwise the base text
func (c claimer) localized(field, translated, base, trRecord string) {
	if translated != "" {
		if trRecord != "" {
			c.recordID = trRecord
		}
		c.put(field, translated)
		return
	}
	c.put(field, base)
}

// Appends the Trakt rating and vote count when anyone voted
func (c claimer) rating(average float64, votes int) {
	if votes <= 0 {
		return
	}
	c.put(model.RatingField(model.NSTrakt), average)
	c.put(model.VotesField(model.NSTrakt), votes)
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
	}
	return v == nil
}

// Turns Trakt genre slugs into the title-cased names other sources use
func genres(slugs []string) []string {
	out := make([]string, 0, len(slugs))
	for _, slug := range slugs {
		words := strings.Split(slug, "-")
		for i, w := range words {
			if w != "" {
				words[i] = strings.ToUpper(w[:1]) + w[1:]
			}
		}
		if name := strings.Join(words, " "); name != "" {
			out = append(out, name)
		}
	}
	return out
}

// Upper-cases the one country Trakt reports
func countries(code string) []string {
	if code == "" {
		return nil
	}
	return []string{strings.ToUpper(code)}
}

// Renders an air instant as the calendar date where the show airs
func localDate(instant string, zone *time.Location) string {
	if instant == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, instant)
	if err != nil {
		return ""
	}
	return t.In(zone).Format(time.DateOnly)
}

type ids struct {
	Trakt int64  `json:"trakt"`
	Slug  string `json:"slug"`
	IMDb  string `json:"imdb"`
	TMDB  int64  `json:"tmdb"`
	TVDB  int64  `json:"tvdb"`
}

// Returns the slug other catalogs store, the numeric id when Trakt has no slug
func (i ids) key() string {
	if i.Slug != "" {
		return i.Slug
	}
	return strconv.FormatInt(i.Trakt, 10)
}

type translation struct {
	Title    string `json:"title"`
	Overview string `json:"overview"`
	Tagline  string `json:"tagline"`
	Language string `json:"language"`
	Country  string `json:"country"`
}

// Chooses the translation for the configured region, then any in the configured language
func pick(list []translation, cfg settings) translation {
	for _, t := range list {
		if t.Language == cfg.lang && cfg.country != "" && t.Country == cfg.country {
			return t
		}
	}
	for _, t := range list {
		if t.Language == cfg.lang {
			return t
		}
	}
	return translation{}
}

// Keeps the English title as an alias when a translation replaced it
func aliasOf(translated, base string) []string {
	if translated == "" || translated == base || base == "" {
		return nil
	}
	return []string{base}
}

type movie struct {
	Title                 string   `json:"title"`
	Year                  int      `json:"year"`
	IDs                   ids      `json:"ids"`
	Tagline               string   `json:"tagline"`
	Overview              string   `json:"overview"`
	Released              string   `json:"released"`
	Runtime               int      `json:"runtime"`
	Country               string   `json:"country"`
	Homepage              string   `json:"homepage"`
	Status                string   `json:"status"`
	Rating                float64  `json:"rating"`
	Votes                 int      `json:"votes"`
	Language              string   `json:"language"`
	Genres                []string `json:"genres"`
	Certification         string   `json:"certification"`
	AvailableTranslations []string `json:"available_translations"`
}

func (m *movie) value() string { return model.TraktValue(model.KindMovie, m.IDs.key()) }

func (m *movie) claims(recordID string, tr translation, trRecord string, out *[]model.Claim) {
	if m.IDs.Trakt <= 0 {
		return
	}
	c := claimer{kind: model.KindMovie, id: m.value(), recordID: recordID, out: out}
	c.localized(model.FieldTitle, tr.Title, m.Title, trRecord)
	c.localized(model.FieldOverview, tr.Overview, m.Overview, trRecord)
	c.localized(model.FieldTagline, tr.Tagline, m.Tagline, trRecord)
	c.put(model.FieldAliases, aliasOf(tr.Title, m.Title))
	c.put(model.FieldYear, m.Year)
	c.put(model.FieldReleaseDate, m.Released)
	c.put(model.FieldRuntime, m.Runtime)
	c.put(model.FieldGenres, genres(m.Genres))
	c.put(model.FieldStatus, strings.ToLower(m.Status))
	c.put(model.FieldLanguage, strings.ToLower(m.Language))
	c.put(model.FieldCountries, countries(m.Country))
	c.put(model.FieldCertification, m.Certification)
	c.put(model.FieldHomepage, m.Homepage)
	c.rating(m.Rating, m.Votes)
	c.put(model.XIDField(model.NSTrakt), model.TraktValue(model.KindMovie, strconv.FormatInt(m.IDs.Trakt, 10)))
	c.put(model.XIDField(model.NSIMDb), m.IDs.IMDb)
	if m.IDs.TMDB > 0 {
		c.put(model.XIDField(model.NSTMDB), model.TMDBMovie(m.IDs.TMDB))
	}
}

type show struct {
	Title      string `json:"title"`
	Year       int    `json:"year"`
	IDs        ids    `json:"ids"`
	Tagline    string `json:"tagline"`
	Overview   string `json:"overview"`
	FirstAired string `json:"first_aired"`
	Airs       struct {
		Timezone string `json:"timezone"`
	} `json:"airs"`
	Runtime               int      `json:"runtime"`
	Certification         string   `json:"certification"`
	Network               string   `json:"network"`
	Country               string   `json:"country"`
	Homepage              string   `json:"homepage"`
	Status                string   `json:"status"`
	Rating                float64  `json:"rating"`
	Votes                 int      `json:"votes"`
	Language              string   `json:"language"`
	Genres                []string `json:"genres"`
	AiredEpisodes         int      `json:"aired_episodes"`
	AvailableTranslations []string `json:"available_translations"`
}

func (sh *show) value() string { return model.TraktValue(model.KindSeries, sh.IDs.key()) }

// Returns where the show airs, UTC when Trakt names no known timezone
func (sh *show) zone() *time.Location {
	if loc, err := time.LoadLocation(sh.Airs.Timezone); err == nil {
		return loc
	}
	return time.UTC
}

func (sh *show) claims(recordID string, tr translation, trRecord string, seasons []season, out *[]model.Claim) {
	if sh.IDs.Trakt <= 0 {
		return
	}
	c := claimer{kind: model.KindSeries, id: sh.value(), recordID: recordID, out: out}
	c.localized(model.FieldTitle, tr.Title, sh.Title, trRecord)
	c.localized(model.FieldOverview, tr.Overview, sh.Overview, trRecord)
	c.localized(model.FieldTagline, tr.Tagline, sh.Tagline, trRecord)
	c.put(model.FieldAliases, aliasOf(tr.Title, sh.Title))
	c.put(model.FieldYear, sh.Year)
	c.put(model.FieldFirstAirDate, localDate(sh.FirstAired, sh.zone()))
	c.put(model.FieldRuntime, sh.Runtime)
	c.put(model.FieldGenres, genres(sh.Genres))
	c.put(model.FieldStatus, strings.ToLower(sh.Status))
	c.put(model.FieldLanguage, strings.ToLower(sh.Language))
	c.put(model.FieldCountries, countries(sh.Country))
	c.put(model.FieldCertification, sh.Certification)
	c.put(model.FieldHomepage, sh.Homepage)
	if sh.Network != "" {
		c.put(model.FieldNetworks, []string{sh.Network})
	}
	c.put(model.FieldEpisodeCount, sh.AiredEpisodes)
	numbered := 0
	for _, s := range seasons {
		if s.Number > 0 {
			numbered++
		}
	}
	c.put(model.FieldSeasonCount, numbered)
	c.rating(sh.Rating, sh.Votes)
	c.put(model.XIDField(model.NSTrakt), model.TraktValue(model.KindSeries, strconv.FormatInt(sh.IDs.Trakt, 10)))
	c.put(model.XIDField(model.NSIMDb), sh.IDs.IMDb)
	if sh.IDs.TMDB > 0 {
		c.put(model.XIDField(model.NSTMDB), model.TMDBSeries(sh.IDs.TMDB))
	}
	if sh.IDs.TVDB > 0 {
		c.put(model.XIDField(model.NSTVDB), model.TVDBValue(model.KindSeries, sh.IDs.TVDB))
	}
}

type season struct {
	Number       int       `json:"number"`
	IDs          ids       `json:"ids"`
	Title        string    `json:"title"`
	Overview     string    `json:"overview"`
	FirstAired   string    `json:"first_aired"`
	Rating       float64   `json:"rating"`
	Votes        int       `json:"votes"`
	EpisodeCount int       `json:"episode_count"`
	Episodes     []episode `json:"episodes"`
}

func (s *season) value() string {
	return model.TraktValue(model.KindSeason, strconv.FormatInt(s.IDs.Trakt, 10))
}

// Appends the season linked to its show, then each of its episodes linked to the season
func (s *season) claims(sh *show, recordID string, cfg settings, out *[]model.Claim) {
	if s.IDs.Trakt <= 0 {
		return
	}
	c := claimer{kind: model.KindSeason, id: s.value(), recordID: recordID, out: out}
	c.put(model.FieldTitle, s.Title)
	c.always(model.FieldOrdinal, s.Number)
	c.put(model.FieldOverview, s.Overview)
	c.put(model.FieldAirDate, localDate(s.FirstAired, sh.zone()))
	c.put(model.FieldEpisodeCount, s.EpisodeCount)
	c.rating(s.Rating, s.Votes)
	c.put(model.ParentXIDField(model.NSTrakt), sh.value())
	if s.IDs.TVDB > 0 {
		c.put(model.XIDField(model.NSTVDB), model.TVDBValue(model.KindSeason, s.IDs.TVDB))
	}
	if sh.IDs.TMDB > 0 {
		c.put(model.XIDField(model.NSTMDB), model.TMDBSeason(sh.IDs.TMDB, s.Number))
	}
	for i := range s.Episodes {
		s.Episodes[i].claims(sh, s.value(), recordID, cfg, out)
	}
}

type episode struct {
	Season       int           `json:"season"`
	Number       int           `json:"number"`
	Title        string        `json:"title"`
	IDs          ids           `json:"ids"`
	Overview     string        `json:"overview"`
	Rating       float64       `json:"rating"`
	Votes        int           `json:"votes"`
	FirstAired   string        `json:"first_aired"`
	Runtime      int           `json:"runtime"`
	Translations []translation `json:"translations"`
}

// Appends one episode linked to its season, translated when the seasons call carried translations
func (e *episode) claims(sh *show, parent, recordID string, cfg settings, out *[]model.Claim) {
	if e.IDs.Trakt <= 0 {
		return
	}
	c := claimer{kind: model.KindEpisode, id: model.TraktValue(model.KindEpisode, strconv.FormatInt(e.IDs.Trakt, 10)), recordID: recordID, out: out}
	tr := pick(e.Translations, cfg)
	c.localized(model.FieldTitle, tr.Title, e.Title, "")
	c.localized(model.FieldOverview, tr.Overview, e.Overview, "")
	c.always(model.FieldOrdinal, e.Number)
	c.put(model.FieldAirDate, localDate(e.FirstAired, sh.zone()))
	c.put(model.FieldRuntime, e.Runtime)
	c.rating(e.Rating, e.Votes)
	c.put(model.ParentXIDField(model.NSTrakt), parent)
	c.put(model.XIDField(model.NSIMDb), e.IDs.IMDb)
	if e.IDs.TVDB > 0 {
		c.put(model.XIDField(model.NSTVDB), model.TVDBValue(model.KindEpisode, e.IDs.TVDB))
	}
	if sh.IDs.TMDB > 0 {
		c.put(model.XIDField(model.NSTMDB), model.TMDBEpisode(sh.IDs.TMDB, e.Season, e.Number))
	}
}

// Holds one search result with the record its type names
type hit struct {
	Movie   *movie   `json:"movie"`
	Show    *show    `json:"show"`
	Episode *episode `json:"episode"`
}
