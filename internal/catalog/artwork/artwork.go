// Stores entity images by sha256 with AVIF and WebP renditions and thumbhash placeholders
package artwork

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/artwork"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
)

// Outbound source every artwork download is limited and counted under
const PolicyName = "artwork"

// Rendition widths each artwork kind is encoded at
var targets = map[artwork.Kind][]int{
	artwork.KindPoster:   {185, 342, 500, 780},
	artwork.KindBackdrop: {300, 780, 1280},
	artwork.KindStill:    {300, 780, 1280},
	artwork.KindThumb:    {300, 780, 1280},
	artwork.KindBanner:   {300, 780, 1280},
	artwork.KindLogo:     {300, 500},
}

// Downloads, encodes, and serves artwork blobs kept in one directory
type Store struct {
	blobs  string
	client *outbound.Client
	ent    *ent.Client
	log    *slog.Logger
	slots  chan struct{}
	locks  *hashLocks
}

// Registers the download policy and creates the blob directory inside dir
func New(dir string, client *outbound.Client, entc *ent.Client, log *slog.Logger) *Store {
	client.Register(outbound.Policy{Name: PolicyName, Title: "Artwork downloads", Rate: 4, Burst: 4, Timeout: 60 * time.Second})
	s := &Store{
		blobs:  filepath.Join(dir, "blobs"),
		client: client,
		ent:    entc,
		log:    log,
		slots:  make(chan struct{}, runtime.GOMAXPROCS(0)),
		locks:  &hashLocks{held: map[string]*hashLock{}},
	}
	if err := os.MkdirAll(s.blobs, 0o750); err != nil {
		log.Error("create artwork blob directory", "dir", s.blobs, "error", err)
	}
	return s
}

// Everything a ready row records about one original and its renditions
type blob struct {
	hash      string
	width     int32
	height    int32
	mime      string
	bytes     int64
	thumbhash []byte
	variants  []schema.ArtworkVariant
}

// Stores the image of a row and marks it ready, or failed with the error text
func (s *Store) Ingest(ctx context.Context, a *ent.Artwork) error {
	start := time.Now()
	row, err := s.ingest(ctx, a)
	if err == nil {
		*a = *row
		s.log.Debug("artwork ready", "id", a.ID, "hash", a.Hash, "variants", len(a.Variants), "elapsed", time.Since(start))
		return nil
	}
	failed, uerr := s.ent.Artwork.UpdateOneID(a.ID).SetState(artwork.StateFailed).SetError(err.Error()).Save(context.WithoutCancel(ctx))
	if uerr != nil {
		return errors.Join(err, fmt.Errorf("artwork: record failure of %s: %w", a.ID, uerr))
	}
	*a = *failed
	return err
}

// Downloads the source, stores its blobs under the content hash, and saves the ready row
func (s *Store) ingest(ctx context.Context, a *ent.Artwork) (*ent.Artwork, error) {
	kindTargets, ok := targets[a.Kind]
	if !ok {
		return nil, fmt.Errorf("artwork: unknown kind %q", a.Kind)
	}
	res, err := s.client.Do(ctx, PolicyName, outbound.Request{URL: a.SourceURL, NoRecord: true, Namespace: "artwork", ExtValue: a.ID})
	if err != nil {
		return nil, fmt.Errorf("artwork: download: %w", err)
	}
	if len(res.Body) == 0 {
		return nil, fmt.Errorf("artwork: %s answered with an empty body", a.SourceURL)
	}
	sum := sha256.Sum256(res.Body)
	hash := hex.EncodeToString(sum[:])
	release := s.locks.acquire(hash)
	defer release()
	b, err := s.materialize(ctx, a.ID, hash, res.Body, kindTargets)
	if err != nil {
		return nil, err
	}
	row, err := s.ent.Artwork.UpdateOneID(a.ID).
		SetHash(b.hash).SetWidth(b.width).SetHeight(b.height).SetMime(b.mime).SetBytes(b.bytes).
		SetThumbhash(b.thumbhash).SetVariants(b.variants).
		SetState(artwork.StateReady).SetError("").SetFetchedAt(res.FetchedAt).
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("artwork: save %s: %w", a.ID, err)
	}
	return row, nil
}

// Writes the original and every missing rendition, reusing dimensions a ready twin already measured
func (s *Store) materialize(ctx context.Context, id, hash string, body []byte, kindTargets []int) (*blob, error) {
	f, err := sniff(body)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(s.blobs, hash)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("artwork: create blob directory: %w", err)
	}
	if err := syncDir(s.blobs); err != nil {
		return nil, err
	}
	b := &blob{hash: hash, mime: f.mime, bytes: int64(len(body))}
	twin, err := s.twin(ctx, id, hash)
	if err != nil {
		return nil, err
	}
	var img image.Image
	if twin != nil {
		b.width, b.height, b.thumbhash = twin.Width, twin.Height, twin.Thumbhash
	} else {
		if img, err = decodeOriginal(f, body); err != nil {
			return nil, err
		}
		b.width, b.height = int32(img.Bounds().Dx()), int32(img.Bounds().Dy())
		b.thumbhash = placeholder(img)
	}
	if err := keep(dir, "original."+f.ext, body); err != nil {
		return nil, err
	}
	var missing []int
	for _, w := range widthsFor(kindTargets, int(b.width)) {
		for _, format := range renditionFormats {
			size, ok, err := present(dir, fileName(w, format))
			if err != nil {
				return nil, err
			}
			if !ok {
				missing = append(missing, len(b.variants))
			}
			b.variants = append(b.variants, schema.ArtworkVariant{Width: int32(w), Format: format, Bytes: size})
		}
	}
	if len(missing) == 0 {
		return b, nil
	}
	if img == nil {
		if img, err = decodeOriginal(f, body); err != nil {
			return nil, err
		}
	}
	if err := s.render(ctx, dir, img, b.variants, missing); err != nil {
		return nil, err
	}
	return b, nil
}

// Another ready row with the same content hash and measured dimensions, nil when none exists
func (s *Store) twin(ctx context.Context, id, hash string) (*ent.Artwork, error) {
	row, err := s.ent.Artwork.Query().
		Where(artwork.Hash(hash), artwork.StateEQ(artwork.StateReady), artwork.IDNEQ(id), artwork.WidthGT(0), artwork.HeightGT(0), artwork.ThumbhashNotNil()).
		First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("artwork: look up hash %s: %w", hash, err)
	}
	return row, nil
}

// Encodes missing renditions in parallel across the shared encoder slots and records their sizes
func (s *Store) render(ctx context.Context, dir string, src image.Image, variants []schema.ArtworkVariant, missing []int) error {
	srcW, srcH := src.Bounds().Dx(), src.Bounds().Dy()
	canvases := map[int32]func() *image.RGBA{}
	for _, i := range missing {
		w := int(variants[i].Width)
		if _, ok := canvases[variants[i].Width]; !ok {
			canvases[variants[i].Width] = sync.OnceValue(func() *image.RGBA { return resize(src, w, scaledHeight(srcW, srcH, w)) })
		}
	}
	g, gctx := errgroup.WithContext(ctx)
	for _, i := range missing {
		v := &variants[i]
		canvas := canvases[v.Width]
		g.Go(func() error {
			select {
			case s.slots <- struct{}{}:
			case <-gctx.Done():
				return gctx.Err()
			}
			defer func() { <-s.slots }()
			if err := gctx.Err(); err != nil {
				return err
			}
			data, err := encode(canvas(), v.Format)
			if err != nil {
				return fmt.Errorf("%w at width %d", err, v.Width)
			}
			if err := writeAtomic(dir, fileName(int(v.Width), v.Format), data); err != nil {
				return err
			}
			v.Bytes = int64(len(data))
			return nil
		})
	}
	return g.Wait()
}

// Caps each target at the original width so nothing is upscaled and the widest fit is kept
func widthsFor(kindTargets []int, original int) []int {
	out := make([]int, 0, len(kindTargets))
	for _, t := range kindTargets {
		out = append(out, min(t, original))
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// Blob file name holding one rendition
func fileName(width int, format string) string {
	return fmt.Sprintf("%d.%s", width, format)
}

// Path of the smallest stored width at or above the request, the largest for zero or oversized requests
func (s *Store) URL(a *ent.Artwork, width int32, format string) string {
	if a == nil || a.State != artwork.StateReady || !validHash(a.Hash) {
		return ""
	}
	if format == "" {
		format = FormatWebP
	}
	best, largest := int32(0), int32(0)
	for _, v := range a.Variants {
		if v.Format != format {
			continue
		}
		largest = max(largest, v.Width)
		if width > 0 && v.Width >= width && (best == 0 || v.Width < best) {
			best = v.Width
		}
	}
	if largest == 0 {
		return ""
	}
	if best == 0 {
		best = largest
	}
	return "/blobs/" + a.Hash + "/" + fileName(int(best), format)
}

// Serializes work per content hash so twins never encode the same files at once
type hashLocks struct {
	mu   sync.Mutex
	held map[string]*hashLock
}

type hashLock struct {
	mu   sync.Mutex
	refs int
}

// Blocks until the hash is free and returns the function that frees it
func (l *hashLocks) acquire(hash string) func() {
	l.mu.Lock()
	h, ok := l.held[hash]
	if !ok {
		h = &hashLock{}
		l.held[hash] = h
	}
	h.refs++
	l.mu.Unlock()
	h.mu.Lock()
	return func() {
		h.mu.Unlock()
		l.mu.Lock()
		if h.refs--; h.refs == 0 {
			delete(l.held, hash)
		}
		l.mu.Unlock()
	}
}
