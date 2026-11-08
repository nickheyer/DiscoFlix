package artwork

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"maps"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	_ "unsafe"

	"github.com/gen2brain/avif"
	"github.com/gen2brain/webp"
	"go.n16f.net/thumbhash"
	xwebp "golang.org/x/image/webp"

	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
)

// Codec engine switches flipped to run the embedded WebAssembly and the system library in one process
var (
	//go:linkname avifDynamic github.com/gen2brain/avif.dynamic
	avifDynamic bool
	//go:linkname webpDynamic github.com/gen2brain/webp.dynamic
	webpDynamic bool
)

// Keeps outbound records, counters, and health in memory
type memRecorder struct {
	mu      sync.Mutex
	records []*outbound.Record
	calls   map[string]int
	resets  map[string]time.Time
	health  map[string]string
}

func (m *memRecorder) Latest(_ context.Context, source, url string) (*outbound.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range slices.Backward(m.records) {
		if r.Source == source && r.URL == url {
			return r, nil
		}
	}
	return nil, nil
}

func (m *memRecorder) Save(_ context.Context, r *outbound.Record) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	saved := *r
	saved.ID = fmt.Sprintf("rec-%d", len(m.records)+1)
	m.records = append(m.records, &saved)
	return saved.ID, nil
}

func (m *memRecorder) Touch(_ context.Context, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.records {
		if r.ID == id {
			r.FetchedAt = at
			return nil
		}
	}
	return fmt.Errorf("no record %s", id)
}

func (m *memRecorder) LoadCalls(_ context.Context, source string) (int, time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls[source], m.resets[source], nil
}

func (m *memRecorder) StoreCalls(_ context.Context, source string, calls int, resetAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls[source], m.resets[source] = calls, resetAt
	return nil
}

func (m *memRecorder) Health(_ context.Context, source string, ok bool, detail string, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ok {
		detail = ""
	}
	m.health[source] = detail
	return nil
}

func (m *memRecorder) healthOf(source string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.health[source]
}

func (m *memRecorder) recordCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.records)
}

type harness struct {
	ctx    context.Context
	ent    *ent.Client
	rec    *memRecorder
	art    *Store
	dir    string
	srv    *httptest.Server
	entity *ent.Entity

	mu   sync.Mutex
	hits map[string]int
}

// Opens a migrated database, an image origin serving bodies, and a store over both
func newHarness(t *testing.T, bodies map[string][]byte) *harness {
	t.Helper()
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	st, err := store.Open(ctx, t.TempDir(), log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	h := &harness{ctx: ctx, ent: st.Ent, dir: t.TempDir(), hits: map[string]int{}}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.hits[r.URL.Path]++
		h.mu.Unlock()
		if r.URL.Path == "/broken" {
			http.Error(w, "origin exploded", http.StatusInternalServerError)
			return
		}
		body, ok := bodies[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(h.srv.Close)
	h.rec = &memRecorder{calls: map[string]int{}, resets: map[string]time.Time{}, health: map[string]string{}}
	h.art = New(h.dir, outbound.New(h.rec, "discoflix-test", log), st.Ent, log)
	if h.entity, err = st.Ent.Entity.Create().SetKind("movie").SetTitle("Heat").SetYear(1995).Save(ctx); err != nil {
		t.Fatal(err)
	}
	return h
}

// Creates a pending artwork of the test entity pointing at path on the origin
func (h *harness) row(t *testing.T, kind artwork.Kind, path string) *ent.Artwork {
	t.Helper()
	a, err := h.ent.Artwork.Create().SetEntityID(h.entity.ID).SetKind(kind).SetSource("tmdb").SetSourceURL(h.srv.URL + path).Save(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// Runs one ingest that must succeed and reloads the persisted row
func (h *harness) ingest(t *testing.T, a *ent.Artwork, label string) *ent.Artwork {
	t.Helper()
	start := time.Now()
	if err := h.art.Ingest(h.ctx, a); err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	t.Logf("%s ingest took %s", label, time.Since(start).Round(time.Millisecond))
	if a.State != artwork.StateReady {
		t.Fatalf("%s: caller row state %s, want ready", label, a.State)
	}
	return h.reload(t, a.ID)
}

func (h *harness) reload(t *testing.T, id string) *ent.Artwork {
	t.Helper()
	row, err := h.ent.Artwork.Get(h.ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func (h *harness) hitsFor(path string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.hits[path]
}

func (h *harness) blobDir(hash string) string { return filepath.Join(h.dir, "blobs", hash) }

// Paints gradients over a checkerboard so the encoders see real detail
func pattern(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: uint8((x/48 + y/48) % 2 * 200), A: 255})
		}
	}
	return img
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Asserts the persisted row describes the original bytes
func checkReady(t *testing.T, row *ent.Artwork, original []byte, w, h int32, mime string) {
	t.Helper()
	if row.State != artwork.StateReady || row.Error != "" {
		t.Fatalf("state %s error %q, want ready with no error", row.State, row.Error)
	}
	if row.Hash != sha(original) {
		t.Fatalf("hash %s, want %s", row.Hash, sha(original))
	}
	if row.Width != w || row.Height != h || row.Mime != mime || row.Bytes != int64(len(original)) {
		t.Fatalf("got %dx%d %s %d bytes, want %dx%d %s %d bytes", row.Width, row.Height, row.Mime, row.Bytes, w, h, mime, len(original))
	}
	if row.FetchedAt == nil || time.Since(*row.FetchedAt) > time.Minute {
		t.Fatalf("fetched_at %v is not a fresh timestamp", row.FetchedAt)
	}
}

// Decodes every stored rendition with its own library and compares sizes and dimensions
func checkRenditions(t *testing.T, dir string, row *ent.Artwork, sizes []image.Point) {
	t.Helper()
	if len(row.Variants) != len(sizes)*2 {
		t.Fatalf("got %d variants %+v, want %d", len(row.Variants), row.Variants, len(sizes)*2)
	}
	for i, size := range sizes {
		for j, format := range []string{"avif", "webp"} {
			v := row.Variants[i*2+j]
			if v.Width != int32(size.X) || v.Format != format {
				t.Fatalf("variant %d is %d %s, want %d %s", i*2+j, v.Width, v.Format, size.X, format)
			}
			data, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("%d.%s", size.X, format)))
			if err != nil {
				t.Fatal(err)
			}
			if int64(len(data)) != v.Bytes {
				t.Fatalf("%d.%s holds %d bytes, row says %d", size.X, format, len(data), v.Bytes)
			}
			decoders := map[string]func(io.Reader) (image.Image, error){}
			if format == "avif" {
				decoders["gen2brain/avif"] = func(r io.Reader) (image.Image, error) { return avif.Decode(r) }
			} else {
				decoders["gen2brain/webp"] = func(r io.Reader) (image.Image, error) { return webp.Decode(r) }
				decoders["x/image/webp"] = xwebp.Decode
			}
			for name, decode := range decoders {
				img, err := decode(bytes.NewReader(data))
				if err != nil {
					t.Fatalf("%s decode %d.%s: %v", name, size.X, format, err)
				}
				if got := img.Bounds().Size(); got != size {
					t.Fatalf("%s decoded %d.%s as %v, want %v", name, size.X, format, got, size)
				}
			}
		}
	}
}

// Asserts the thumbhash header records the alpha, orientation, and short side detail of the original
func checkPlaceholder(t *testing.T, data []byte, w, h int, alpha bool) {
	t.Helper()
	if len(data) < 5 || len(data) > 25 {
		t.Fatalf("thumbhash is %d bytes, want between 5 and 25", len(data))
	}
	var hh thumbhash.Hash
	if err := hh.Decode(data, &thumbhash.DecodingCfg{}); err != nil {
		t.Fatal(err)
	}
	if _, err := thumbhash.DecodeImage(data); err != nil {
		t.Fatal(err)
	}
	long, short := float64(max(w, h)), float64(min(w, h))
	copyLong := math.Min(long, 100)
	copyShort := math.Round(short * copyLong / long)
	limit := 7.0
	if alpha {
		limit = 5
	}
	wantCount := int(math.Round(limit * copyShort / copyLong))
	if hh.HasAlpha != alpha || hh.IsLandscape != (w > h) || hh.LCount != wantCount {
		t.Fatalf("thumbhash alpha %v landscape %v count %d, want %v %v %d", hh.HasAlpha, hh.IsLandscape, hh.LCount, alpha, w > h, wantCount)
	}
	t.Logf("thumbhash of %dx%d is %d bytes", w, h, len(data))
}

type fileState struct {
	info os.FileInfo
	data []byte
}

// Captures every file in dir with its identity and contents
func snapshot(t *testing.T, dir string) map[string]fileState {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]fileState{}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = fileState{info: info, data: data}
	}
	return out
}

// Asserts every file in before is still the same inode with the same bytes and time
func unchanged(t *testing.T, before, after map[string]fileState) {
	t.Helper()
	for name, b := range before {
		a, ok := after[name]
		if !ok {
			t.Fatalf("%s disappeared", name)
		}
		if !os.SameFile(b.info, a.info) || !b.info.ModTime().Equal(a.info.ModTime()) || !bytes.Equal(b.data, a.data) {
			t.Fatalf("%s was rewritten", name)
		}
	}
}

func names(m map[string]fileState) []string {
	out := make([]string, 0, len(m))
	for name := range m {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

// Valid PNG whose header declares 10000 by 10000 pixels over a single pixel of data
func hugeHeader(t *testing.T) []byte {
	t.Helper()
	b := encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 1, 1)))
	if string(b[12:16]) != "IHDR" {
		t.Fatal("first PNG chunk is not IHDR")
	}
	binary.BigEndian.PutUint32(b[16:20], 10000)
	binary.BigEndian.PutUint32(b[20:24], 10000)
	binary.BigEndian.PutUint32(b[29:33], crc32.ChecksumIEEE(b[12:29]))
	return b
}

func TestNewRegistersPolicyAndBlobDirectory(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := outbound.New(&memRecorder{calls: map[string]int{}, resets: map[string]time.Time{}, health: map[string]string{}}, "discoflix-test", log)
	dir := t.TempDir()
	New(dir, client, nil, log)
	want := outbound.Policy{Name: "artwork", Title: "Artwork downloads", Rate: 4, Burst: 4, Timeout: 60 * time.Second}
	if got := client.Policies()[PolicyName]; got != want {
		t.Fatalf("registered %+v, want %+v", got, want)
	}
	if st, err := os.Stat(filepath.Join(dir, "blobs")); err != nil || !st.IsDir() {
		t.Fatalf("blob directory missing, err %v", err)
	}
}

func TestWidthsFor(t *testing.T) {
	cases := []struct {
		kind     artwork.Kind
		original int
		want     []int
	}{
		{artwork.KindPoster, 900, []int{185, 342, 500, 780}},
		{artwork.KindPoster, 780, []int{185, 342, 500, 780}},
		{artwork.KindPoster, 600, []int{185, 342, 500, 600}},
		{artwork.KindPoster, 150, []int{150}},
		{artwork.KindBackdrop, 1920, []int{300, 780, 1280}},
		{artwork.KindStill, 1000, []int{300, 780, 1000}},
		{artwork.KindThumb, 900, []int{300, 780, 900}},
		{artwork.KindBanner, 758, []int{300, 758}},
		{artwork.KindLogo, 800, []int{300, 500}},
		{artwork.KindLogo, 400, []int{300, 400}},
		{artwork.KindLogo, 250, []int{250}},
	}
	for _, c := range cases {
		if got := widthsFor(targets[c.kind], c.original); !slices.Equal(got, c.want) {
			t.Errorf("%s at %d: got %v, want %v", c.kind, c.original, got, c.want)
		}
	}
	for _, kind := range []artwork.Kind{artwork.KindPoster, artwork.KindBackdrop, artwork.KindLogo, artwork.KindStill, artwork.KindBanner, artwork.KindThumb} {
		if len(targets[kind]) == 0 {
			t.Errorf("kind %s has no target widths", kind)
		}
	}
}

func TestEncodersRoundTrip(t *testing.T) {
	origAVIF, origWebP := avifDynamic, webpDynamic
	t.Cleanup(func() { avifDynamic, webpDynamic = origAVIF, origWebP })
	type engine struct {
		format string
		name   string
		system bool
	}
	engines := []engine{{"avif", "libavif wasm on wazero", false}, {"webp", "libwebp wasm transpiled by wasm2go", false}}
	if avif.Dynamic() == nil {
		engines = append(engines, engine{"avif", "system libavif via purego", true})
	}
	if webp.Dynamic() == nil {
		engines = append(engines, engine{"webp", "system libwebp via purego", true})
	}
	sources := []*image.RGBA{resize(pattern(1920, 1080), 1280, 720), resize(pattern(900, 1350), 780, 1170)}
	for _, e := range engines {
		avifDynamic, webpDynamic = origAVIF, origWebP
		if e.format == "avif" {
			avifDynamic = e.system
		} else {
			webpDynamic = e.system
		}
		for _, src := range sources {
			start := time.Now()
			data, err := encode(src, e.format)
			if err != nil {
				t.Fatalf("%s: %v", e.name, err)
			}
			took := time.Since(start)
			var img image.Image
			if e.format == "avif" {
				img, err = avif.Decode(bytes.NewReader(data))
			} else {
				img, err = webp.Decode(bytes.NewReader(data))
			}
			if err != nil {
				t.Fatalf("%s decode: %v", e.name, err)
			}
			if got, want := img.Bounds().Size(), src.Bounds().Size(); got != want {
				t.Fatalf("%s round trip gave %v, want %v", e.name, got, want)
			}
			t.Logf("%s encoded %v in %s to %d bytes", e.name, src.Bounds().Size(), took.Round(time.Millisecond), len(data))
		}
	}
}

func TestIngestPoster(t *testing.T) {
	poster := encodePNG(t, pattern(900, 1350))
	h := newHarness(t, map[string][]byte{"/poster.png": poster, "/poster-copy.png": poster, "/poster-thumb.png": poster})
	a := h.ingest(t, h.row(t, artwork.KindPoster, "/poster.png"), "poster 900x1350 png")
	checkReady(t, a, poster, 900, 1350, "image/png")
	dir := h.blobDir(a.Hash)
	checkRenditions(t, dir, a, []image.Point{{185, 278}, {342, 513}, {500, 750}, {780, 1170}})
	checkPlaceholder(t, a.Thumbhash, 900, 1350, false)
	original, err := os.ReadFile(filepath.Join(dir, "original.png"))
	if err != nil || !bytes.Equal(original, poster) {
		t.Fatalf("original.png differs from the download, err %v", err)
	}
	wantFiles := []string{"185.avif", "185.webp", "342.avif", "342.webp", "500.avif", "500.webp", "780.avif", "780.webp", "original.png"}
	if got := names(snapshot(t, dir)); !slices.Equal(got, wantFiles) {
		t.Fatalf("blob directory holds %v, want %v", got, wantFiles)
	}
	if n := h.rec.recordCount(); n != 0 {
		t.Fatalf("binary download stored %d outbound records, want none", n)
	}

	t.Run("dedupe by hash", func(t *testing.T) {
		before := snapshot(t, dir)
		dup := h.ingest(t, h.row(t, artwork.KindPoster, "/poster-copy.png"), "duplicate poster")
		unchanged(t, before, snapshot(t, dir))
		if got := names(snapshot(t, dir)); !slices.Equal(got, wantFiles) {
			t.Fatalf("duplicate left %v, want %v", got, wantFiles)
		}
		checkReady(t, dup, poster, 900, 1350, "image/png")
		if !slices.Equal(dup.Variants, a.Variants) || !bytes.Equal(dup.Thumbhash, a.Thumbhash) {
			t.Fatalf("duplicate variants %+v thumbhash %x, want %+v %x", dup.Variants, dup.Thumbhash, a.Variants, a.Thumbhash)
		}
		if n := h.hitsFor("/poster-copy.png"); n != 1 {
			t.Fatalf("duplicate downloaded %d times, want 1", n)
		}
	})

	t.Run("same bytes as another kind encode only missing widths", func(t *testing.T) {
		before := snapshot(t, dir)
		thumb := h.ingest(t, h.row(t, artwork.KindThumb, "/poster-thumb.png"), "poster bytes as thumb")
		after := snapshot(t, dir)
		unchanged(t, before, after)
		checkReady(t, thumb, poster, 900, 1350, "image/png")
		checkRenditions(t, dir, thumb, []image.Point{{300, 450}, {780, 1170}, {900, 1350}})
		added := slices.DeleteFunc(names(after), func(n string) bool { _, ok := before[n]; return ok })
		if want := []string{"300.avif", "300.webp", "900.avif", "900.webp"}; !slices.Equal(added, want) {
			t.Fatalf("thumb added %v, want %v", added, want)
		}
	})

	t.Run("url selection", func(t *testing.T) {
		base := "/blobs/" + a.Hash + "/"
		cases := []struct {
			width  int32
			format string
			want   string
		}{
			{0, "", "780.webp"},
			{0, "avif", "780.avif"},
			{1, "webp", "185.webp"},
			{185, "webp", "185.webp"},
			{186, "avif", "342.avif"},
			{342, "", "342.webp"},
			{501, "webp", "780.webp"},
			{780, "avif", "780.avif"},
			{5000, "avif", "780.avif"},
		}
		for _, c := range cases {
			if got := h.art.URL(a, c.width, c.format); got != base+c.want {
				t.Errorf("URL(%d, %q) = %q, want %q", c.width, c.format, got, base+c.want)
			}
		}
		if got := h.art.URL(a, 342, "png"); got != "" {
			t.Errorf("URL for a format never encoded = %q, want empty", got)
		}
		pending := h.row(t, artwork.KindPoster, "/never-fetched.png")
		if got := h.art.URL(pending, 342, ""); got != "" {
			t.Errorf("URL of a pending row = %q, want empty", got)
		}
		failed := *a
		failed.State = artwork.StateFailed
		if got := h.art.URL(&failed, 342, ""); got != "" {
			t.Errorf("URL of a failed row = %q, want empty", got)
		}
	})

	t.Run("handler", func(t *testing.T) {
		handler := h.art.Handler()
		serve := func(method, target string, header http.Header) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, target, nil)
			maps.Copy(req.Header, header)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			return rec
		}
		files := map[string]string{"342.avif": "image/avif", "780.webp": "image/webp", "original.png": "image/png"}
		for file, ctype := range files {
			want, err := os.ReadFile(filepath.Join(dir, file))
			if err != nil {
				t.Fatal(err)
			}
			res := serve(http.MethodGet, "/blobs/"+a.Hash+"/"+file, nil)
			if res.Code != http.StatusOK || !bytes.Equal(res.Body.Bytes(), want) {
				t.Fatalf("GET %s: status %d with %d bytes, want 200 with %d", file, res.Code, res.Body.Len(), len(want))
			}
			etag := `"` + a.Hash + "/" + file + `"`
			checks := map[string]string{"Content-Type": ctype, "Cache-Control": "public, max-age=31536000, immutable", "Etag": etag, "Content-Length": fmt.Sprint(len(want))}
			for k, v := range checks {
				if got := res.Header().Get(k); got != v {
					t.Fatalf("GET %s header %s = %q, want %q", file, k, got, v)
				}
			}
			head := serve(http.MethodHead, "/blobs/"+a.Hash+"/"+file, nil)
			if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != fmt.Sprint(len(want)) || head.Header().Get("Content-Type") != ctype {
				t.Fatalf("HEAD %s: status %d body %d length %q type %q", file, head.Code, head.Body.Len(), head.Header().Get("Content-Length"), head.Header().Get("Content-Type"))
			}
			if res := serve(http.MethodGet, "/blobs/"+a.Hash+"/"+file, http.Header{"If-None-Match": {etag}}); res.Code != http.StatusNotModified {
				t.Fatalf("conditional GET %s: status %d, want 304", file, res.Code)
			}
		}
		missing := []string{
			"/blobs/" + a.Hash + "/999.webp",
			"/blobs/" + a.Hash + "/original.jpg",
			"/blobs/" + strings.Repeat("0", 64) + "/342.avif",
		}
		for _, target := range missing {
			if res := serve(http.MethodGet, target, nil); res.Code != http.StatusNotFound {
				t.Errorf("GET %s: status %d, want 404", target, res.Code)
			}
		}
		malformed := []string{
			"/blobs/../app.db",
			"/blobs/" + a.Hash + "/../../app.db",
			"/blobs/" + a.Hash + "/..%2F..%2Fapp.db",
			"/blobs/" + a.Hash + "/%2e%2e",
			"/blobs/" + strings.ToUpper(a.Hash) + "/342.avif",
			"/blobs/" + a.Hash[:63] + "/342.avif",
			"/blobs/" + a.Hash[:63] + "g/342.avif",
			"/blobs/" + a.Hash,
			"/blobs/" + a.Hash + "/342.avif/extra",
			"/blobs/" + a.Hash + "/0342.avif",
			"/blobs/" + a.Hash + "/342.png",
			"/blobs/" + a.Hash + "/original.exe",
			"/blobs/" + a.Hash + "/.342.avif.1.tmp",
			"/assets/" + a.Hash + "/342.avif",
		}
		for _, target := range malformed {
			res := serve(http.MethodGet, target, nil)
			if res.Code != http.StatusBadRequest || res.Header().Get("Cache-Control") != "" {
				t.Errorf("GET %s: status %d cache %q, want 400 without caching", target, res.Code, res.Header().Get("Cache-Control"))
			}
		}
		secret := filepath.Join(h.dir, "secret.txt")
		if err := os.WriteFile(secret, []byte("outside the blob tree"), 0o600); err != nil {
			t.Fatal(err)
		}
		escape := strings.Repeat("e", 64)
		if err := os.MkdirAll(h.blobDir(escape), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(secret, filepath.Join(h.blobDir(escape), "342.avif")); err != nil {
			t.Fatal(err)
		}
		if res := serve(http.MethodGet, "/blobs/"+escape+"/342.avif", nil); res.Code != http.StatusInternalServerError || strings.Contains(res.Body.String(), "outside the blob tree") {
			t.Fatalf("symlink out of the blob tree answered status %d body %q, want 500 without the target", res.Code, res.Body.String())
		}
		res := serve(http.MethodPost, "/blobs/"+a.Hash+"/342.avif", nil)
		if res.Code != http.StatusMethodNotAllowed || res.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("POST: status %d allow %q, want 405 with GET, HEAD", res.Code, res.Header().Get("Allow"))
		}
	})
}

func TestIngestBackdropConcurrentTwins(t *testing.T) {
	backdrop := encodeJPEG(t, pattern(1920, 1080))
	h := newHarness(t, map[string][]byte{"/backdrop.jpg": backdrop, "/backdrop-copy.jpg": backdrop})
	rows := []*ent.Artwork{h.row(t, artwork.KindBackdrop, "/backdrop.jpg"), h.row(t, artwork.KindBackdrop, "/backdrop-copy.jpg")}
	start := time.Now()
	errs := make([]error, len(rows))
	var wg sync.WaitGroup
	for i, row := range rows {
		wg.Go(func() { errs[i] = h.art.Ingest(h.ctx, row) })
	}
	wg.Wait()
	t.Logf("two concurrent 1920x1080 jpeg backdrops with identical bytes took %s", time.Since(start).Round(time.Millisecond))
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
	first, second := h.reload(t, rows[0].ID), h.reload(t, rows[1].ID)
	for _, row := range []*ent.Artwork{first, second} {
		checkReady(t, row, backdrop, 1920, 1080, "image/jpeg")
		checkRenditions(t, h.blobDir(row.Hash), row, []image.Point{{300, 169}, {780, 439}, {1280, 720}})
		checkPlaceholder(t, row.Thumbhash, 1920, 1080, false)
	}
	if !slices.Equal(first.Variants, second.Variants) {
		t.Fatalf("twins disagree on variants %+v and %+v", first.Variants, second.Variants)
	}
	want := []string{"1280.avif", "1280.webp", "300.avif", "300.webp", "780.avif", "780.webp", "original.jpg"}
	if got := names(snapshot(t, h.blobDir(first.Hash))); !slices.Equal(got, want) {
		t.Fatalf("blob directory holds %v, want %v", got, want)
	}
	if got := h.art.URL(first, 700, "avif"); got != "/blobs/"+first.Hash+"/780.avif" {
		t.Fatalf("URL(700, avif) = %q", got)
	}
}

func TestIngestFailures(t *testing.T) {
	poster := encodePNG(t, pattern(300, 450))
	h := newHarness(t, map[string][]byte{"/garbage.png": []byte("this is not an image at all"), "/truncated.png": poster[:200], "/huge.png": hugeHeader(t)})
	cases := []struct {
		path   string
		check  func(error) bool
		text   string
		health string
	}{
		{"/broken", func(err error) bool {
			var se *outbound.StatusError
			return errors.As(err, &se) && se.Status == http.StatusInternalServerError
		}, "answered 500", "answered 500"},
		{"/garbage.png", func(err error) bool { return errors.Is(err, errUnsupported) }, "unsupported image format", ""},
		{"/truncated.png", func(err error) bool {
			var fe png.FormatError
			return errors.As(err, &fe)
		}, "decode png", ""},
		{"/huge.png", func(err error) bool { return errors.Is(err, errTooLarge) }, "10000x10000", ""},
	}
	for _, c := range cases {
		a := h.row(t, artwork.KindPoster, c.path)
		err := h.art.Ingest(h.ctx, a)
		if !c.check(err) {
			t.Fatalf("%s: unexpected error %v", c.path, err)
		}
		row := h.reload(t, a.ID)
		if row.State != artwork.StateFailed || !strings.Contains(row.Error, c.text) || row.Error != err.Error() {
			t.Fatalf("%s: state %s error %q, want failed with %q", c.path, row.State, row.Error, err.Error())
		}
		if a.State != artwork.StateFailed {
			t.Fatalf("%s: caller row state %s, want failed", c.path, a.State)
		}
		if got := h.art.URL(row, 0, ""); got != "" {
			t.Fatalf("%s: failed row links %q", c.path, got)
		}
		if got := h.rec.healthOf(PolicyName); !strings.Contains(got, c.health) || (c.health == "") != (got == "") {
			t.Fatalf("%s: source health %q, want %q", c.path, got, c.health)
		}
	}
	entries, err := os.ReadDir(filepath.Join(h.dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() == sha([]byte("this is not an image at all")) {
			t.Fatal("unsupported bytes created a blob directory")
		}
	}
}

// Pins each codec to the embedded engine or the system library until the test ends
func useEngines(t *testing.T, avifSystem, webpSystem bool) {
	t.Helper()
	origAVIF, origWebP := avifDynamic, webpDynamic
	t.Cleanup(func() { avifDynamic, webpDynamic = origAVIF, origWebP })
	avifDynamic, webpDynamic = avifSystem, webpSystem
}

func TestIngestOnEmbeddedEngine(t *testing.T) {
	useEngines(t, false, false)
	poster := encodePNG(t, pattern(900, 1350))
	backdrop := encodeJPEG(t, pattern(1920, 1080))
	h := newHarness(t, map[string][]byte{"/poster.png": poster, "/backdrop.jpg": backdrop})
	p := h.ingest(t, h.row(t, artwork.KindPoster, "/poster.png"), "poster 900x1350 png on libavif wasm and libwebp wasm2go")
	checkReady(t, p, poster, 900, 1350, "image/png")
	checkRenditions(t, h.blobDir(p.Hash), p, []image.Point{{185, 278}, {342, 513}, {500, 750}, {780, 1170}})
	b := h.ingest(t, h.row(t, artwork.KindBackdrop, "/backdrop.jpg"), "backdrop 1920x1080 jpeg on libavif wasm and libwebp wasm2go")
	checkReady(t, b, backdrop, 1920, 1080, "image/jpeg")
	checkRenditions(t, h.blobDir(b.Hash), b, []image.Point{{300, 169}, {780, 439}, {1280, 720}})
}

// Paletted logo with a transparent field around an opaque red bar
func transparentLogo(w, h int) *image.Paletted {
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Transparent, color.NRGBA{R: 220, G: 30, B: 40, A: 255}})
	for y := h / 3; y < 2*h/3; y++ {
		for x := w / 5; x < 4*w/5; x++ {
			img.SetColorIndex(x, y, 1)
		}
	}
	return img
}

func TestIngestGIFAndWebPOriginals(t *testing.T) {
	var logo bytes.Buffer
	if err := gif.Encode(&logo, transparentLogo(640, 320), nil); err != nil {
		t.Fatal(err)
	}
	var still bytes.Buffer
	if err := webp.Encode(&still, pattern(1000, 562), webp.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, map[string][]byte{"/logo.gif": logo.Bytes(), "/still.webp": still.Bytes()})

	l := h.ingest(t, h.row(t, artwork.KindLogo, "/logo.gif"), "logo 640x320 transparent gif")
	checkReady(t, l, logo.Bytes(), 640, 320, "image/gif")
	checkRenditions(t, h.blobDir(l.Hash), l, []image.Point{{300, 150}, {500, 250}})
	checkPlaceholder(t, l.Thumbhash, 640, 320, true)
	for _, format := range []string{"avif", "webp"} {
		data, err := os.ReadFile(filepath.Join(h.blobDir(l.Hash), "500."+format))
		if err != nil {
			t.Fatal(err)
		}
		var img image.Image
		if format == "avif" {
			img, err = avif.Decode(bytes.NewReader(data))
		} else {
			img, err = webp.Decode(bytes.NewReader(data))
		}
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, corner := img.At(5, 5).RGBA()
		r, _, _, center := img.At(250, 125).RGBA()
		if corner > 0x1000 || center < 0xf000 || r < 0xb000 {
			t.Fatalf("500.%s lost transparency, corner alpha %#x center alpha %#x red %#x", format, corner, center, r)
		}
	}
	if _, err := os.Stat(filepath.Join(h.blobDir(l.Hash), "original.gif")); err != nil {
		t.Fatal(err)
	}

	w := h.ingest(t, h.row(t, artwork.KindStill, "/still.webp"), "still 1000x562 webp")
	checkReady(t, w, still.Bytes(), 1000, 562, "image/webp")
	checkRenditions(t, h.blobDir(w.Hash), w, []image.Point{{300, 169}, {780, 438}, {1000, 562}})
	checkPlaceholder(t, w.Thumbhash, 1000, 562, false)
	original, err := os.ReadFile(filepath.Join(h.blobDir(w.Hash), "original.webp"))
	if err != nil || !bytes.Equal(original, still.Bytes()) {
		t.Fatalf("original.webp differs from the download, err %v", err)
	}
	res := httptest.NewRecorder()
	h.art.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/blobs/"+w.Hash+"/original.webp", nil))
	if res.Code != http.StatusOK || res.Header().Get("Content-Type") != "image/webp" || !bytes.Equal(res.Body.Bytes(), still.Bytes()) {
		t.Fatalf("original.webp served status %d type %q", res.Code, res.Header().Get("Content-Type"))
	}
	gifRes := httptest.NewRecorder()
	h.art.Handler().ServeHTTP(gifRes, httptest.NewRequest(http.MethodGet, "/blobs/"+l.Hash+"/original.gif", nil))
	if gifRes.Code != http.StatusOK || gifRes.Header().Get("Content-Type") != "image/gif" {
		t.Fatalf("original.gif served status %d type %q", gifRes.Code, gifRes.Header().Get("Content-Type"))
	}
}
