package artwork

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Media type served for each rendition format
var renditionTypes = map[string]string{FormatAVIF: "image/avif", FormatWebP: "image/webp"}

// Accepts exactly 64 lowercase hexadecimal characters
func validHash(h string) bool {
	if len(h) != 64 {
		return false
	}
	for _, c := range h {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Media type of an original or rendition file name, false for every other name
func blobType(name string) (string, bool) {
	base, ext, ok := strings.Cut(name, ".")
	if !ok {
		return "", false
	}
	if base == "original" {
		for _, f := range sourceFormats {
			if f.ext == ext {
				return f.mime, true
			}
		}
		return "", false
	}
	ctype, ok := renditionTypes[ext]
	if !ok || base == "" || len(base) > 5 || base[0] == '0' {
		return "", false
	}
	for _, c := range base {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	return ctype, true
}

// Size of a nonempty regular file in dir, false when it is absent or empty
func present(dir, name string) (int64, bool, error) {
	st, err := os.Stat(filepath.Join(dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("artwork: stat %s: %w", name, err)
	}
	if !st.Mode().IsRegular() {
		return 0, false, fmt.Errorf("artwork: %s is not a regular file", name)
	}
	return st.Size(), st.Size() > 0, nil
}

// Writes data unless a file of the same length already holds it
func keep(dir, name string, data []byte) error {
	size, ok, err := present(dir, name)
	if err != nil {
		return err
	}
	if ok && size == int64(len(data)) {
		return nil
	}
	return writeAtomic(dir, name, data)
}

// Syncs data to a hidden temporary file, renames it over the final name, and syncs the directory
func writeAtomic(dir, name string, data []byte) error {
	f, err := os.CreateTemp(dir, "."+name+".*.tmp")
	if err != nil {
		return fmt.Errorf("artwork: create %s: %w", name, err)
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(dir, name))
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("artwork: write %s: %w", name, err)
	}
	return syncDir(dir)
}

// Flushes directory entries so a completed rename survives a crash
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("artwork: open directory for sync: %w", err)
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("artwork: sync directory: %w", err)
	}
	return nil
}

// Serves GET and HEAD for /blobs/{hash}/{file} with immutable caching headers
func (s *Store) Handler() http.Handler {
	return http.HandlerFunc(s.serve)
}

// Answers one blob request after rejecting malformed paths before any disk access
func (s *Store) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/blobs/")
	hash, name, split := strings.Cut(rest, "/")
	ctype, named := blobType(name)
	if !ok || !split || !validHash(hash) || !named {
		http.Error(w, "malformed blob path", http.StatusBadRequest)
		return
	}
	f, err := os.OpenInRoot(s.blobs, hash+"/"+name)
	if errors.Is(err, fs.ErrNotExist) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.log.Error("open artwork blob", "hash", hash, "file", name, "error", err)
		http.Error(w, "blob unavailable", http.StatusInternalServerError)
		return
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil {
		s.log.Error("stat artwork blob", "hash", hash, "file", name, "error", err)
		http.Error(w, "blob unavailable", http.StatusInternalServerError)
		return
	}
	if !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("ETag", `"`+hash+"/"+name+`"`)
	http.ServeContent(w, r, name, st.ModTime(), f)
}
