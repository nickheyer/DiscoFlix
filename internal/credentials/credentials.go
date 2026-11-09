// Package credentials holds the project keys for the metadata providers, filled by the linker at build time
package credentials

// Project keys the build injects with -ldflags -X from TMDB_API_KEY, TVDB_API_KEY, TRAKT_CLIENT_ID, and FATV_PROJECT_API_KEY
var (
	TMDB   string
	TVDB   string
	Trakt  string
	Fanart string
)
