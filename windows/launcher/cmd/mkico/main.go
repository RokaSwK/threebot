// mkico turns Threebot's PNG icon into the .ico Windows wants for the exe and its shortcuts.
// Standard library only: decode, box-filter down to each size, and store the results as PNG
// entries, which Windows Vista and later read directly.
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

func main() {
	in := flag.String("in", "", "source PNG")
	out := flag.String("out", "", "destination .ico")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: mkico -in icon-512.png -out threebot.ico")
		os.Exit(2)
	}
	data, err := os.ReadFile(*in)
	check(err, "read source")
	src, err := png.Decode(bytes.NewReader(data))
	check(err, "decode source")

	sizes := []int{256, 128, 64, 48, 32, 16}
	images := make([][]byte, len(sizes))
	for i, size := range sizes {
		var buf bytes.Buffer
		check(png.Encode(&buf, resize(src, size)), "encode "+fmt.Sprint(size))
		images[i] = buf.Bytes()
	}

	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, uint16(0))          // reserved
	binary.Write(&ico, binary.LittleEndian, uint16(1))          // type: icon
	binary.Write(&ico, binary.LittleEndian, uint16(len(sizes))) // count
	offset := 6 + 16*len(sizes)
	for i, size := range sizes {
		b := byte(size)
		if size >= 256 {
			b = 0 // 0 means 256 in an ICO directory entry
		}
		ico.Write([]byte{b, b, 0, 0})                                  // width, height, palette, reserved
		binary.Write(&ico, binary.LittleEndian, uint16(1))              // colour planes
		binary.Write(&ico, binary.LittleEndian, uint16(32))             // bits per pixel
		binary.Write(&ico, binary.LittleEndian, uint32(len(images[i]))) // bytes in resource
		binary.Write(&ico, binary.LittleEndian, uint32(offset))
		offset += len(images[i])
	}
	for _, image := range images {
		ico.Write(image)
	}
	check(os.WriteFile(*out, ico.Bytes(), 0o644), "write icon")
	fmt.Printf("wrote %s\n", *out)
}

func check(err error, what string) {
	if err != nil {
		fmt.Fprintln(os.Stderr, what+":", err)
		os.Exit(1)
	}
}

// resize averages each source block into a destination pixel, so thin strokes survive shrinking.
func resize(src image.Image, size int) image.Image {
	b := src.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	scaleX, scaleY := float64(b.Dx())/float64(size), float64(b.Dy())/float64(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			x0, x1 := b.Min.X+int(float64(x)*scaleX), b.Min.X+int(float64(x+1)*scaleX)
			y0, y1 := b.Min.Y+int(float64(y)*scaleY), b.Min.Y+int(float64(y+1)*scaleY)
			if x1 <= x0 {
				x1 = x0 + 1
			}
			if y1 <= y0 {
				y1 = y0 + 1
			}
			var r, g, bl, a, n uint32
			for sy := y0; sy < y1 && sy < b.Max.Y; sy++ {
				for sx := x0; sx < x1 && sx < b.Max.X; sx++ {
					cr, cg, cb, ca := src.At(sx, sy).RGBA()
					r, g, bl, a, n = r+cr, g+cg, bl+cb, a+ca, n+1
				}
			}
			if n == 0 {
				n = 1
			}
			dst.Set(x, y, color.NRGBA{
				R: uint8(r / n >> 8), G: uint8(g / n >> 8), B: uint8(bl / n >> 8),
				A: uint8(a / n >> 8),
			})
		}
	}
	return dst
}
