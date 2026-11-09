package credentials

import (
	"slices"
	"testing"
)

func TestMissingNamesEveryEmptyBuildVariable(t *testing.T) {
	saved := []string{TMDB, TVDB, Trakt, Fanart}
	t.Cleanup(func() { TMDB, TVDB, Trakt, Fanart = saved[0], saved[1], saved[2], saved[3] })
	TMDB, TVDB, Trakt, Fanart = "", "", "", ""
	if got := Missing(); !slices.Equal(got, []string{"TMDB_API_KEY", "TVDB_API_KEY", "TRAKT_CLIENT_ID", "FATV_PROJECT_API_KEY"}) {
		t.Fatalf("missing = %v", got)
	}
	TMDB, TVDB, Trakt, Fanart = "a", "", "c", "d"
	if got := Missing(); !slices.Equal(got, []string{"TVDB_API_KEY"}) {
		t.Fatalf("missing = %v", got)
	}
	TVDB = "b"
	if got := Missing(); got != nil {
		t.Fatalf("missing = %v", got)
	}
}
