// Package web embeds the built SvelteKit client
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:build
var build embed.FS

// Build is the static site rooted at the SvelteKit output directory
var Build fs.FS = mustSub(build, "build")

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic(err)
	}
	return sub
}
