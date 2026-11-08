//go:build !headless

package shell

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"testing"
)

// Encodes a solid square PNG of the given edge
func squarePNG(t *testing.T, edge int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, edge, edge))
	for i := range img.Pix {
		img.Pix[i] = 0x80
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestPNGToICO(t *testing.T) {
	for _, tc := range []struct{ edge, want int }{{32, 32}, {256, 0}, {512, 0}} {
		ico, err := pngToICO(squarePNG(t, tc.edge))
		if err != nil {
			t.Fatal(err)
		}
		if binary.LittleEndian.Uint16(ico[2:]) != 1 || binary.LittleEndian.Uint16(ico[4:]) != 1 {
			t.Fatalf("edge %d header % x", tc.edge, ico[:6])
		}
		if int(ico[6]) != tc.want || int(ico[7]) != tc.want {
			t.Fatalf("edge %d directory size %d x %d", tc.edge, ico[6], ico[7])
		}
		size := binary.LittleEndian.Uint32(ico[14:])
		off := binary.LittleEndian.Uint32(ico[18:])
		img, err := png.Decode(bytes.NewReader(ico[off : off+size]))
		if err != nil {
			t.Fatalf("edge %d embedded PNG %v", tc.edge, err)
		}
		if got := img.Bounds().Dx(); got > maxICOEdge {
			t.Fatalf("edge %d embedded width %d", tc.edge, got)
		}
	}
}
