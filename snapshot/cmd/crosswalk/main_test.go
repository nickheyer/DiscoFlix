package main

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/nickheyer/DiscoFlix/snapshot"
	"github.com/nickheyer/DiscoFlix/snapshot/snapshottest"
)

var (
	nameRe  = regexp.MustCompile(`^# discoflix crosswalk (\S+)\n`)
	limitRe = regexp.MustCompile(` LIMIT (\d+)`)
	skipRe  = regexp.MustCompile(` OFFSET (\d+)`)
)

// Answers SPARQL GETs from the recording, routing by the query name comment
func fakeQLever(t *testing.T) *httptest.Server {
	t.Helper()
	e := snapshottest.NewEndpoint()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cmd") == "stats" {
			_, _ = w.Write([]byte(`{"name-index": "` + snapshottest.Index + `"}`))
			return
		}
		text := r.URL.Query().Get("query")
		m := nameRe.FindStringSubmatch(text)
		if m == nil || r.Header.Get("Accept") != "text/tab-separated-values" {
			http.Error(w, `{"exception": "unnamed query"}`, http.StatusBadRequest)
			return
		}
		q := snapshot.Query{Name: m[1]}
		if l := limitRe.FindStringSubmatch(text); l != nil {
			q.Limit, _ = strconv.Atoi(l[1])
		}
		if o := skipRe.FindStringSubmatch(text); o != nil {
			q.Offset, _ = strconv.Atoi(o[1])
		}
		body, err := e.Select(r.Context(), q)
		if err != nil {
			http.Error(w, `{"exception": "`+err.Error()+`"}`, http.StatusBadRequest)
			return
		}
		_, _ = w.Write(body)
	}))
}

func TestBuildPublishVerifyCommands(t *testing.T) {
	ctx := context.Background()
	log := slog.New(slog.DiscardHandler)
	srv := fakeQLever(t)
	defer srv.Close()
	dir := t.TempDir()
	keys, repo, db := filepath.Join(dir, "keys"), filepath.Join(dir, "repo"), filepath.Join(dir, "crosswalk.sqlite")
	steps := []struct {
		args []string
		want []string
	}{
		{[]string{"keys", "init", "--dir", keys}, []string{"root key", "online key"}},
		{[]string{"build", "--out", db, "--endpoint", srv.URL, "--pace", "0"}, []string{"items 9: episode 2, movie 4, season 1, series 2", "tmdb 5", "wikidata 9", "values without a catalog form: trakt 1", "ids claimed by two items: tmdb 1", "qlever index " + snapshottest.Index}},
		{[]string{"publish", "--repo", repo, "--root", filepath.Join(keys, "root.json"), "--online-key", filepath.Join(keys, "online.key"), "--sqlite", db}, []string{"root v1, targets v1, snapshot v1, timestamp v1"}},
		{[]string{"verify", "--repo", repo, "--root", filepath.Join(keys, "root.json")}, []string{"verified crosswalk", "9 items"}},
		{[]string{"publish", "--repo", repo, "--root", filepath.Join(keys, "root.json"), "--online-key", filepath.Join(keys, "online.key"), "--sqlite", db}, []string{"targets v2, snapshot v2, timestamp v2"}},
	}
	for _, step := range steps {
		var out bytes.Buffer
		if err := run(ctx, step.args, &out, log); err != nil {
			t.Fatalf("%v: %v", step.args, err)
		}
		for _, want := range step.want {
			if !strings.Contains(out.String(), want) {
				t.Fatalf("%v printed %q, want %q", step.args, out.String(), want)
			}
		}
	}
	for _, args := range [][]string{{}, {"keys"}, {"build"}, {"publish", "--repo", repo}, {"verify"}, {"build", "--out", db, "--limit", "-1"}} {
		if err := run(ctx, args, &bytes.Buffer{}, log); err == nil {
			t.Fatalf("%v succeeded", args)
		}
	}
}
