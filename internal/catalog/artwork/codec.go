package artwork

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"math"

	"github.com/gen2brain/avif"
	"github.com/gen2brain/webp"
	"go.n16f.net/thumbhash"
	"golang.org/x/image/draw"
	xwebp "golang.org/x/image/webp"
)

// Encoder settings and the pixel ceiling for decoded originals
const (
	avifQuality     = 60
	avifSpeed       = 8
	webpQuality     = 82
	webpMethod      = 4
	placeholderSide = 100
	maxPixels       = 64 << 20
)

// Rendition formats each stored width is encoded in
const (
	FormatAVIF = "avif"
	FormatWebP = "webp"
)

var renditionFormats = []string{FormatAVIF, FormatWebP}

var (
	errUnsupported = errors.New("artwork: unsupported image format")
	errTooLarge    = errors.New("artwork: image exceeds the pixel limit")
	errEmpty       = errors.New("artwork: image has no pixels")
)

// One original encoding the pipeline accepts
type sourceFormat struct {
	ext    string
	mime   string
	magic  func([]byte) bool
	decode func(io.Reader) (image.Image, error)
	config func(io.Reader) (image.Config, error)
}

var sourceFormats = []sourceFormat{
	{ext: "jpg", mime: "image/jpeg", magic: prefixed("\xff\xd8\xff"), decode: jpeg.Decode, config: jpeg.DecodeConfig},
	{ext: "png", mime: "image/png", magic: prefixed("\x89PNG\r\n\x1a\n"), decode: png.Decode, config: png.DecodeConfig},
	{ext: "gif", mime: "image/gif", magic: prefixed("GIF87a", "GIF89a"), decode: gif.Decode, config: gif.DecodeConfig},
	{ext: "webp", mime: "image/webp", magic: isWebP, decode: xwebp.Decode, config: xwebp.DecodeConfig},
}

// Matches data starting with any of the given signatures
func prefixed(signatures ...string) func([]byte) bool {
	return func(b []byte) bool {
		for _, s := range signatures {
			if bytes.HasPrefix(b, []byte(s)) {
				return true
			}
		}
		return false
	}
}

// Matches a RIFF container carrying the WEBP form type
func isWebP(b []byte) bool {
	return len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
}

// Identifies the original encoding from its leading bytes
func sniff(b []byte) (sourceFormat, error) {
	for _, f := range sourceFormats {
		if f.magic(b) {
			return f, nil
		}
	}
	return sourceFormat{}, errUnsupported
}

// Decodes the bytes once the declared dimensions fit under the pixel ceiling
func decodeOriginal(f sourceFormat, b []byte) (image.Image, error) {
	cfg, err := f.config(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("artwork: read %s header: %w", f.ext, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, errEmpty
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return nil, fmt.Errorf("%w: %dx%d", errTooLarge, cfg.Width, cfg.Height)
	}
	img, err := f.decode(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("artwork: decode %s: %w", f.ext, err)
	}
	if img.Bounds().Empty() {
		return nil, errEmpty
	}
	return img, nil
}

// Height that keeps the aspect ratio of a w by h image resized to width
func scaledHeight(w, h, width int) int {
	return max(1, int(math.Round(float64(h)*float64(width)/float64(w))))
}

// Draws src onto a new premultiplied canvas of the given size with Catmull-Rom filtering
func resize(src image.Image, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	if src.Bounds().Dx() == w && src.Bounds().Dy() == h {
		draw.Draw(dst, dst.Bounds(), src, src.Bounds().Min, draw.Src)
		return dst
	}
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst
}

// Thumbhash of a copy of src scaled to fit within 100 pixels on its long side
func placeholder(src image.Image) []byte {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	if long := max(w, h); long > placeholderSide {
		w = max(1, int(math.Round(float64(w)*placeholderSide/float64(long))))
		h = max(1, int(math.Round(float64(h)*placeholderSide/float64(long))))
	}
	return thumbhash.EncodeImage(resize(src, w, h))
}

// Renders img as AVIF or WebP with the fixed quality settings
func encode(img image.Image, format string) ([]byte, error) {
	var buf bytes.Buffer
	var err error
	switch format {
	case FormatAVIF:
		err = avif.Encode(&buf, img, avif.Options{Quality: avifQuality, QualityAlpha: avifQuality, Speed: avifSpeed, ChromaSubsampling: image.YCbCrSubsampleRatio420})
	case FormatWebP:
		err = webp.Encode(&buf, img, webp.Options{Quality: webpQuality, Method: webpMethod})
	default:
		return nil, fmt.Errorf("artwork: unknown rendition format %q", format)
	}
	if err != nil {
		return nil, fmt.Errorf("artwork: encode %s: %w", format, err)
	}
	if buf.Len() == 0 {
		return nil, fmt.Errorf("artwork: %s encoder produced no bytes", format)
	}
	return buf.Bytes(), nil
}
