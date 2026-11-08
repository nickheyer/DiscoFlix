//go:build windows && !headless

package shell

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/png"

	"golang.org/x/sys/windows"
)

// Largest edge an ICO directory entry can describe
const maxICOEdge = 256

var postThreadMessage = windows.NewLazySystemDLL("user32.dll").NewProc("PostThreadMessageW")

// The notification area needs no preflight beyond the window class fyne registers itself
func trayPreflight() error {
	return nil
}

// Wraps the PNG in an ICO container because fyne loads Windows tray icons with LoadImage IMAGE_ICON
func trayIcon(pngData []byte) ([]byte, error) {
	return pngToICO(pngData)
}

// Returns the id of the thread that will run the fyne message loop
func loopThread() uint32 {
	return windows.GetCurrentThreadId()
}

// Posts WM_QUIT to the loop thread so GetMessage returns when the tray never registered
func endTrayLoop(thread uint32) {
	const wmQuit = 0x0012
	postThreadMessage.Call(uintptr(thread), wmQuit, 0, 0)
}

// Builds a single image ICO holding a PNG of at most 256 pixels per edge
func pngToICO(pngData []byte) ([]byte, error) {
	img, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	if b.Dx() == 0 || b.Dy() == 0 {
		return nil, errors.New("is empty")
	}
	if b.Dx() > maxICOEdge || b.Dy() > maxICOEdge {
		small := shrink(img, maxICOEdge)
		var buf bytes.Buffer
		if err := png.Encode(&buf, small); err != nil {
			return nil, err
		}
		pngData = buf.Bytes()
		b = small.Bounds()
	}
	edge := func(n int) byte {
		if n >= maxICOEdge {
			return 0
		}
		return byte(n)
	}
	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, [3]uint16{0, 1, 1})
	out.Write([]byte{edge(b.Dx()), edge(b.Dy()), 0, 0})
	binary.Write(&out, binary.LittleEndian, [2]uint16{1, 32})
	binary.Write(&out, binary.LittleEndian, [2]uint32{uint32(len(pngData)), 22})
	out.Write(pngData)
	return out.Bytes(), nil
}

// Box filters the image so its longest edge equals limit
func shrink(src image.Image, limit int) *image.NRGBA {
	sb := src.Bounds()
	w, h := sb.Dx(), sb.Dy()
	dw, dh := limit, limit
	if w > h {
		dh = max(1, h*limit/w)
	} else {
		dw = max(1, w*limit/h)
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := range dh {
		y0, y1 := sb.Min.Y+y*h/dh, sb.Min.Y+max((y+1)*h/dh, y*h/dh+1)
		for x := range dw {
			x0, x1 := sb.Min.X+x*w/dw, sb.Min.X+max((x+1)*w/dw, x*w/dw+1)
			var r, g, bl, a, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, ca := src.At(sx, sy).RGBA()
					r, g, bl, a, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), a+uint64(ca), n+1
				}
			}
			r, g, bl, a = r/n, g/n, bl/n, a/n
			if a == 0 {
				continue
			}
			i := dst.PixOffset(x, y)
			dst.Pix[i+0] = uint8(r * 0xffff / a >> 8)
			dst.Pix[i+1] = uint8(g * 0xffff / a >> 8)
			dst.Pix[i+2] = uint8(bl * 0xffff / a >> 8)
			dst.Pix[i+3] = uint8(a >> 8)
		}
	}
	return dst
}
