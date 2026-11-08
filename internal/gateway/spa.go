package gateway

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves a static single page app with precompressed assets and a 200.html fallback
type spaHandler struct {
	fs       fs.FS
	fallback string
}

func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// NewSPA serves the embedded web build, answering unknown paths with the SPA shell
func NewSPA(build fs.FS) http.Handler {
	return &spaHandler{fs: build, fallback: "200.html"}
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/discoflix.") || strings.HasPrefix(r.URL.Path, "/connection/") {
		http.Error(w, "no such procedure", http.StatusNotFound)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" || !h.exists(name) {
		name = h.fallback
	}
	switch {
	case name == h.fallback:
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(name, "_app/immutable/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
	ctype := mime.TypeByExtension(path.Ext(name))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Add("Vary", "Accept-Encoding")
	for _, enc := range []struct{ token, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if strings.Contains(r.Header.Get("Accept-Encoding"), enc.token) && h.exists(name+enc.ext) {
			w.Header().Set("Content-Encoding", enc.token)
			h.copy(w, r, name+enc.ext)
			return
		}
	}
	h.copy(w, r, name)
}

func (h *spaHandler) exists(name string) bool {
	st, err := fs.Stat(h.fs, name)
	return err == nil && !st.IsDir()
}

func (h *spaHandler) copy(w http.ResponseWriter, r *http.Request, name string) {
	f, err := h.fs.Open(name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer func() { _ = f.Close() }()
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, f)
}
