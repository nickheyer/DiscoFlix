package model

import "testing"

func TestNormalize(t *testing.T) {
	for in, want := range map[string]string{
		"Amélie": "amelie",
		"  The Lord of the Rings: The Two Towers ": "the lord of the rings the two towers",
		"Fast & Furious 6":                         "fast and furious 6",
		"WALL·E":                                   "wall e",
		"Léon: The Professional (1994)":            "leon the professional 1994",
		"":                                         "",
		"!!!":                                      "",
	} {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFieldNames(t *testing.T) {
	if XIDField(NSIMDb) != "xid.imdb" || ParentXIDField(NSTMDB) != "parent.xid.tmdb" || RatingField("tmdb") != "rating.tmdb" || ArtworkField("poster") != "artwork.poster" {
		t.Fatal("field names changed")
	}
	if !ValidKind(KindEpisode) || ValidKind("album") {
		t.Fatal("kind validation")
	}
}

func TestValueFormats(t *testing.T) {
	if TMDBMovie(603) != "movie/603" || TMDBSeries(1396) != "tv/1396" || TMDBSeason(1396, 1) != "tv/1396/1" || TMDBEpisode(1396, 1, 2) != "tv/1396/1/2" {
		t.Fatal("tmdb formats")
	}
	if TVDBValue(KindMovie, 12) != "movie/12" || TVDBValue(KindSeries, 81189) != "series/81189" || TVDBValue(KindEpisode, 5) != "episode/5" {
		t.Fatal("tvdb formats")
	}
	if TraktValue(KindSeries, "breaking-bad") != "show/breaking-bad" || TraktValue(KindMovie, "1") != "movie/1" {
		t.Fatal("trakt formats")
	}
	if p, r := SplitValue("tv/1396/1"); p != "tv" || r != "1396/1" {
		t.Fatal("split")
	}
	if p, r := SplitValue("tt0133093"); p != "" || r != "tt0133093" {
		t.Fatal("split plain")
	}
}
