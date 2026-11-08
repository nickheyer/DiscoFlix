package tmdb

import (
	"strconv"
	"strings"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
)

// Appends claims about one TMDB record, skipping values that carry nothing
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
	*c.out = append(*c.out, model.Claim{Kind: c.kind, Namespace: model.NSTMDB, ExternalID: c.id, Field: field, Value: value, RecordID: c.recordID})
}

// Appends the TMDB rating and vote count when anyone voted
func (c claimer) rating(average float64, votes int) {
	if votes <= 0 {
		return
	}
	c.put(model.RatingField(model.NSTMDB), average)
	c.put(model.VotesField(model.NSTMDB), votes)
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

// Reads the year of a YYYY-MM-DD date, zero when absent
func yearOf(date string) int {
	if len(date) < 4 {
		return 0
	}
	y, _ := strconv.Atoi(date[:4])
	return y
}

type named struct {
	ID   int64  `json:"id"`
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

type externalIDs struct {
	IMDb     string `json:"imdb_id"`
	TVDB     int64  `json:"tvdb_id"`
	Wikidata string `json:"wikidata_id"`
}

// Appends the imdb, tvdb, and wikidata ids, formatting the tvdb id for the record kind
func (x externalIDs) claims(c claimer) {
	c.put(model.XIDField(model.NSIMDb), x.IMDb)
	if x.TVDB > 0 {
		c.put(model.XIDField(model.NSTVDB), model.TVDBValue(c.kind, x.TVDB))
	}
	c.put(model.XIDField(model.NSWikidata), x.Wikidata)
}

type image struct {
	FilePath    string  `json:"file_path"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Language    *string `json:"iso_639_1"`
	VoteAverage float64 `json:"vote_average"`
	VoteCount   int     `json:"vote_count"`
}

type images struct {
	Posters   []image `json:"posters"`
	Backdrops []image `json:"backdrops"`
	Logos     []image `json:"logos"`
	Stills    []image `json:"stills"`
}

// Points at the original size, asking for the rendered PNG of an SVG logo
func imageURL(path string) string {
	if p, ok := strings.CutSuffix(path, ".svg"); ok {
		path = p + ".png"
	}
	return imageBase + path
}

// Shrinks the vote average toward zero when few people voted
func score(average float64, votes int) float64 {
	return average * float64(votes) / float64(votes+3)
}

// Lists the offered images plus the primary path when the list lacks it
func artwork(list []image, primary string) []model.Image {
	out := make([]model.Image, 0, len(list)+1)
	seen := map[string]bool{}
	for _, img := range list {
		if img.FilePath == "" || seen[img.FilePath] {
			continue
		}
		seen[img.FilePath] = true
		lang := ""
		if img.Language != nil {
			lang = *img.Language
		}
		out = append(out, model.Image{URL: imageURL(img.FilePath), Width: img.Width, Height: img.Height, Language: lang, Score: score(img.VoteAverage, img.VoteCount)})
	}
	if primary != "" && !seen[primary] {
		out = append(out, model.Image{URL: imageURL(primary)})
	}
	return out
}

type credit struct {
	Name        string `json:"name"`
	Character   string `json:"character"`
	Job         string `json:"job"`
	Department  string `json:"department"`
	Order       int    `json:"order"`
	ProfilePath string `json:"profile_path"`
}

type credits struct {
	Cast []credit `json:"cast"`
	Crew []credit `json:"crew"`
}

func (p credit) person(role string) model.Person {
	out := model.Person{Name: p.Name, Role: role, Character: p.Character, Order: p.Order}
	if p.ProfilePath != "" {
		out.ImageURL = imageBase + p.ProfilePath
	}
	return out
}

// Lists the first twenty billed performers under one role
func castOf(list []credit, role string) []model.Person {
	out := make([]model.Person, 0, min(len(list), castLimit))
	for _, p := range list {
		if len(out) == castLimit {
			break
		}
		if p.Name != "" {
			out = append(out, p.person(role))
		}
	}
	return out
}

// Lists creators, directors, and writers once each
func crewOf(creators, crew []credit) []model.Person {
	var out []model.Person
	seen := map[string]bool{}
	add := func(p credit, role string) {
		if p.Name == "" || seen[p.Name+"|"+role] {
			return
		}
		seen[p.Name+"|"+role] = true
		person := p.person(role)
		person.Character, person.Order = "", 0
		out = append(out, person)
	}
	for _, p := range creators {
		add(p, "Creator")
	}
	for _, p := range crew {
		switch {
		case p.Job == "Director":
			add(p, "Director")
		case p.Department == "Writing":
			add(p, p.Job)
		}
	}
	return out
}

type keywords struct {
	Keywords []named `json:"keywords"`
	Results  []named `json:"results"`
}

func (k keywords) names() []string { return names(append(k.Keywords, k.Results...)) }

type altTitle struct {
	Title string `json:"title"`
}

type altTitles struct {
	Titles  []altTitle `json:"titles"`
	Results []altTitle `json:"results"`
}

// Lists alternative titles once each, leaving out the titles already claimed
func (a altTitles) aliases(known ...string) []string {
	seen := map[string]bool{}
	for _, k := range known {
		seen[k] = true
	}
	var out []string
	for _, t := range append(a.Titles, a.Results...) {
		if t.Title != "" && !seen[t.Title] {
			seen[t.Title] = true
			out = append(out, t.Title)
		}
	}
	return out
}

type country struct {
	ISO string `json:"iso_3166_1"`
}

// Prefers the origin countries and otherwise lists the production countries
func countries(origin []string, production []country) []string {
	out := make([]string, 0, max(len(origin), len(production)))
	for _, c := range origin {
		out = append(out, strings.ToUpper(c))
	}
	if len(out) > 0 {
		return out
	}
	for _, c := range production {
		if c.ISO != "" {
			out = append(out, strings.ToUpper(c.ISO))
		}
	}
	return out
}

type releaseDates struct {
	Results []struct {
		ISO          string `json:"iso_3166_1"`
		ReleaseDates []struct {
			Certification string `json:"certification"`
			Type          int    `json:"type"`
		} `json:"release_dates"`
	} `json:"results"`
}

// Picks the US theatrical rating, then any other US rating
func (r releaseDates) certification() string {
	best := ""
	for _, c := range r.Results {
		if c.ISO != "US" {
			continue
		}
		for _, d := range c.ReleaseDates {
			if d.Certification == "" {
				continue
			}
			if d.Type == 3 {
				return d.Certification
			}
			if best == "" {
				best = d.Certification
			}
		}
	}
	return best
}

type contentRatings struct {
	Results []struct {
		ISO    string `json:"iso_3166_1"`
		Rating string `json:"rating"`
	} `json:"results"`
}

func (r contentRatings) certification() string {
	for _, c := range r.Results {
		if c.ISO == "US" && c.Rating != "" {
			return c.Rating
		}
	}
	return ""
}

type movieRecord struct {
	Title               string       `json:"title"`
	OriginalTitle       string       `json:"original_title"`
	ReleaseDate         string       `json:"release_date"`
	Overview            string       `json:"overview"`
	Tagline             string       `json:"tagline"`
	Runtime             int          `json:"runtime"`
	Genres              []named      `json:"genres"`
	Status              string       `json:"status"`
	OriginalLanguage    string       `json:"original_language"`
	OriginCountry       []string     `json:"origin_country"`
	ProductionCountries []country    `json:"production_countries"`
	Homepage            string       `json:"homepage"`
	Popularity          float64      `json:"popularity"`
	VoteAverage         float64      `json:"vote_average"`
	VoteCount           int          `json:"vote_count"`
	IMDbID              string       `json:"imdb_id"`
	PosterPath          string       `json:"poster_path"`
	BackdropPath        string       `json:"backdrop_path"`
	Collection          *named       `json:"belongs_to_collection"`
	ExternalIDs         externalIDs  `json:"external_ids"`
	Images              images       `json:"images"`
	Credits             credits      `json:"credits"`
	Keywords            keywords     `json:"keywords"`
	ReleaseDates        releaseDates `json:"release_dates"`
	AlternativeTitles   altTitles    `json:"alternative_titles"`
}

func (m *movieRecord) claims(c claimer) {
	c.put(model.FieldTitle, m.Title)
	c.put(model.FieldOriginalTitle, m.OriginalTitle)
	c.put(model.FieldYear, yearOf(m.ReleaseDate))
	c.put(model.FieldReleaseDate, m.ReleaseDate)
	c.put(model.FieldOverview, m.Overview)
	c.put(model.FieldTagline, m.Tagline)
	c.put(model.FieldRuntime, m.Runtime)
	c.put(model.FieldGenres, names(m.Genres))
	c.put(model.FieldStatus, strings.ToLower(m.Status))
	c.put(model.FieldLanguage, m.OriginalLanguage)
	c.put(model.FieldCountries, countries(m.OriginCountry, m.ProductionCountries))
	c.put(model.FieldCertification, m.ReleaseDates.certification())
	c.put(model.FieldHomepage, m.Homepage)
	c.put(model.FieldPopularity, m.Popularity)
	c.rating(m.VoteAverage, m.VoteCount)
	c.put(model.FieldKeywords, m.Keywords.names())
	c.put(model.FieldCast, castOf(m.Credits.Cast, "Actor"))
	c.put(model.FieldCrew, crewOf(nil, m.Credits.Crew))
	if m.Collection != nil {
		c.put(model.FieldCollection, m.Collection.Name)
	}
	c.put(model.FieldAliases, m.AlternativeTitles.aliases(m.Title, m.OriginalTitle))
	if m.ExternalIDs.IMDb == "" {
		m.ExternalIDs.IMDb = m.IMDbID
	}
	m.ExternalIDs.claims(c)
	c.put(model.ArtworkField("poster"), artwork(m.Images.Posters, m.PosterPath))
	c.put(model.ArtworkField("backdrop"), artwork(m.Images.Backdrops, m.BackdropPath))
	c.put(model.ArtworkField("logo"), artwork(m.Images.Logos, ""))
}

type seasonSummary struct {
	SeasonNumber int    `json:"season_number"`
	Name         string `json:"name"`
	Overview     string `json:"overview"`
	AirDate      string `json:"air_date"`
	EpisodeCount int    `json:"episode_count"`
	PosterPath   string `json:"poster_path"`
}

// Appends one season listed by its series, linked to the series
func (s seasonSummary) claims(c claimer, parent string) {
	c.put(model.FieldTitle, s.Name)
	c.always(model.FieldOrdinal, s.SeasonNumber)
	c.put(model.FieldOverview, s.Overview)
	c.put(model.FieldAirDate, s.AirDate)
	c.put(model.FieldEpisodeCount, s.EpisodeCount)
	c.put(model.ArtworkField("poster"), artwork(nil, s.PosterPath))
	c.put(model.ParentXIDField(model.NSTMDB), parent)
}

type seriesRecord struct {
	Name              string          `json:"name"`
	OriginalName      string          `json:"original_name"`
	FirstAirDate      string          `json:"first_air_date"`
	LastAirDate       string          `json:"last_air_date"`
	Overview          string          `json:"overview"`
	Tagline           string          `json:"tagline"`
	EpisodeRunTime    []int           `json:"episode_run_time"`
	Genres            []named         `json:"genres"`
	Status            string          `json:"status"`
	OriginalLanguage  string          `json:"original_language"`
	OriginCountry     []string        `json:"origin_country"`
	Homepage          string          `json:"homepage"`
	Networks          []named         `json:"networks"`
	NumberOfSeasons   int             `json:"number_of_seasons"`
	NumberOfEpisodes  int             `json:"number_of_episodes"`
	Popularity        float64         `json:"popularity"`
	VoteAverage       float64         `json:"vote_average"`
	VoteCount         int             `json:"vote_count"`
	PosterPath        string          `json:"poster_path"`
	BackdropPath      string          `json:"backdrop_path"`
	CreatedBy         []credit        `json:"created_by"`
	Seasons           []seasonSummary `json:"seasons"`
	ExternalIDs       externalIDs     `json:"external_ids"`
	Images            images          `json:"images"`
	Credits           credits         `json:"credits"`
	Keywords          keywords        `json:"keywords"`
	ContentRatings    contentRatings  `json:"content_ratings"`
	AlternativeTitles altTitles       `json:"alternative_titles"`
}

func (t *seriesRecord) claims(c claimer) {
	c.put(model.FieldTitle, t.Name)
	c.put(model.FieldOriginalTitle, t.OriginalName)
	c.put(model.FieldYear, yearOf(t.FirstAirDate))
	c.put(model.FieldFirstAirDate, t.FirstAirDate)
	c.put(model.FieldLastAirDate, t.LastAirDate)
	c.put(model.FieldOverview, t.Overview)
	c.put(model.FieldTagline, t.Tagline)
	if len(t.EpisodeRunTime) > 0 {
		c.put(model.FieldRuntime, t.EpisodeRunTime[0])
	}
	c.put(model.FieldGenres, names(t.Genres))
	c.put(model.FieldStatus, strings.ToLower(t.Status))
	c.put(model.FieldLanguage, t.OriginalLanguage)
	c.put(model.FieldCountries, countries(t.OriginCountry, nil))
	c.put(model.FieldCertification, t.ContentRatings.certification())
	c.put(model.FieldHomepage, t.Homepage)
	c.put(model.FieldNetworks, names(t.Networks))
	c.put(model.FieldSeasonCount, t.NumberOfSeasons)
	c.put(model.FieldEpisodeCount, t.NumberOfEpisodes)
	c.put(model.FieldPopularity, t.Popularity)
	c.rating(t.VoteAverage, t.VoteCount)
	c.put(model.FieldKeywords, t.Keywords.names())
	c.put(model.FieldCast, castOf(t.Credits.Cast, "Actor"))
	c.put(model.FieldCrew, crewOf(t.CreatedBy, t.Credits.Crew))
	c.put(model.FieldAliases, t.AlternativeTitles.aliases(t.Name, t.OriginalName))
	t.ExternalIDs.claims(c)
	c.put(model.ArtworkField("poster"), artwork(t.Images.Posters, t.PosterPath))
	c.put(model.ArtworkField("backdrop"), artwork(t.Images.Backdrops, t.BackdropPath))
	c.put(model.ArtworkField("logo"), artwork(t.Images.Logos, ""))
}

type seasonRecord struct {
	Name         string          `json:"name"`
	Overview     string          `json:"overview"`
	AirDate      string          `json:"air_date"`
	SeasonNumber int             `json:"season_number"`
	PosterPath   string          `json:"poster_path"`
	Episodes     []episodeRecord `json:"episodes"`
	ExternalIDs  externalIDs     `json:"external_ids"`
	Images       images          `json:"images"`
}

// Appends the season itself, linked to its series
func (s *seasonRecord) claims(c claimer, parent string) {
	c.put(model.FieldTitle, s.Name)
	c.always(model.FieldOrdinal, s.SeasonNumber)
	c.put(model.FieldOverview, s.Overview)
	c.put(model.FieldAirDate, s.AirDate)
	c.put(model.FieldEpisodeCount, len(s.Episodes))
	s.ExternalIDs.claims(c)
	c.put(model.ArtworkField("poster"), artwork(s.Images.Posters, s.PosterPath))
	c.put(model.ParentXIDField(model.NSTMDB), parent)
}

type episodeRecord struct {
	Name          string      `json:"name"`
	Overview      string      `json:"overview"`
	AirDate       string      `json:"air_date"`
	EpisodeNumber int         `json:"episode_number"`
	Runtime       int         `json:"runtime"`
	StillPath     string      `json:"still_path"`
	VoteAverage   float64     `json:"vote_average"`
	VoteCount     int         `json:"vote_count"`
	Crew          []credit    `json:"crew"`
	GuestStars    []credit    `json:"guest_stars"`
	ExternalIDs   externalIDs `json:"external_ids"`
	Images        images      `json:"images"`
}

// Appends one episode, linked to its season
func (e *episodeRecord) claims(c claimer, parent string) {
	c.put(model.FieldTitle, e.Name)
	c.always(model.FieldOrdinal, e.EpisodeNumber)
	c.put(model.FieldOverview, e.Overview)
	c.put(model.FieldAirDate, e.AirDate)
	c.put(model.FieldRuntime, e.Runtime)
	c.rating(e.VoteAverage, e.VoteCount)
	c.put(model.FieldCast, castOf(e.GuestStars, "Guest Star"))
	c.put(model.FieldCrew, crewOf(nil, e.Crew))
	e.ExternalIDs.claims(c)
	c.put(model.ArtworkField("still"), artwork(e.Images.Stills, e.StillPath))
	c.put(model.ParentXIDField(model.NSTMDB), parent)
}

type findResult struct {
	Movies  []named `json:"movie_results"`
	Series  []named `json:"tv_results"`
	Seasons []struct {
		ShowID       int64 `json:"show_id"`
		SeasonNumber int   `json:"season_number"`
	} `json:"tv_season_results"`
	Episodes []struct {
		ShowID        int64 `json:"show_id"`
		SeasonNumber  int   `json:"season_number"`
		EpisodeNumber int   `json:"episode_number"`
	} `json:"tv_episode_results"`
}

type searchHit struct {
	ID               int64    `json:"id"`
	Title            string   `json:"title"`
	Name             string   `json:"name"`
	OriginalTitle    string   `json:"original_title"`
	OriginalName     string   `json:"original_name"`
	ReleaseDate      string   `json:"release_date"`
	FirstAirDate     string   `json:"first_air_date"`
	Overview         string   `json:"overview"`
	OriginalLanguage string   `json:"original_language"`
	OriginCountry    []string `json:"origin_country"`
	Popularity       float64  `json:"popularity"`
	VoteAverage      float64  `json:"vote_average"`
	VoteCount        int      `json:"vote_count"`
}

type searchPage struct {
	Results []searchHit `json:"results"`
}

// Appends one search result as a movie or series group
func (h *searchHit) claims(kind, recordID string, out *[]model.Claim) {
	if h.ID <= 0 {
		return
	}
	id := model.TMDBMovie(h.ID)
	if kind == model.KindSeries {
		id = model.TMDBSeries(h.ID)
	}
	c := claimer{kind: kind, id: id, recordID: recordID, out: out}
	if kind == model.KindMovie {
		c.put(model.FieldTitle, h.Title)
		c.put(model.FieldOriginalTitle, h.OriginalTitle)
		c.put(model.FieldYear, yearOf(h.ReleaseDate))
		c.put(model.FieldReleaseDate, h.ReleaseDate)
	} else {
		c.put(model.FieldTitle, h.Name)
		c.put(model.FieldOriginalTitle, h.OriginalName)
		c.put(model.FieldYear, yearOf(h.FirstAirDate))
		c.put(model.FieldFirstAirDate, h.FirstAirDate)
	}
	c.put(model.FieldOverview, h.Overview)
	c.put(model.FieldLanguage, h.OriginalLanguage)
	c.put(model.FieldCountries, countries(h.OriginCountry, nil))
	c.put(model.FieldPopularity, h.Popularity)
	c.rating(h.VoteAverage, h.VoteCount)
}
