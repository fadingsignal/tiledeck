<picture>
  <source media="(prefers-color-scheme: dark)" srcset="readme_logo_light.png">
  <img src="readme_logo_dark.png" alt="TileDeck" width="480">
</picture>

A minimal, browser-based viewer for flipbook (sprite sheet) textures used in game VFX. Load a sheet, set the grid, and preview the animation the way it plays in-engine.

Everything runs locally in your browser. Textures are never uploaded anywhere.

## Usage

**Use it online:** https://fadingsignal.github.io/tiledeck/

Or download the repo and open `index.html` in Chrome or Edge. Nothing needs to be installed or built.

Click **Open** or drag a texture onto the window.

If the filename contains the grid size, such as `Fire_8x8.png` or `Smoke_16x16.dds`, the grid is set automatically.

## Supported formats

| Format | Notes |
|---|---|
| PNG, JPG, WebP, GIF, BMP | Native browser formats |
| DDS | BC1–BC5, BC7, uncompressed RGBA/BGRA/R8 and legacy formats. Top mip only. |
| TGA | 8/16/24/32-bit, greyscale, color-mapped, uncompressed or RLE |
| TIFF | 8/16-bit RGB(A) and greyscale(+alpha), palette; uncompressed, LZW, ZIP, PackBits |

Not supported: HDR formats (BC6H, floating-point TIFF).

## Controls

**Playback**: go to start, step back, play/pause, stop, step forward, go to end. Speed is in frames per second, or cells per second in Scroll mode. A negative speed plays in reverse.

**Sheet**
- **Grid**: horizontal × vertical cell count. Decimals are allowed.
- **Start / Frames**: play a sub-range of cells, e.g. to skip empty trailing cells or isolate one animation on a packed sheet. Frames = 0 plays to the end.

**Sequence**
- **Stepped / Scroll**: jump cell to cell, or sweep continuously along each row (a 1×1 grid becomes a scrolling texture).
- **Rows / Cols**, **L→R / R→L**, **T→B / B→T**: the order in which cells are read.
- **Loop / Ping-pong**
- **Blend**: cross-fades between frames, like engine sub-UV frame blending (Stepped mode only).

**Look**
- **Tint**: multiplies RGB by a color, with alpha left untouched. Useful for previewing greyscale FX in a specific color.
- **RGBA / RGB / A / R / G / B**: channel view. RGB shows color hidden under zero alpha.
- **Additive**: previews additive blending.

**Display**
- **Fit / 1:1**: scale to the window, or show at actual size (one texel per screen pixel).
- **Checker**: checkerboard background for judging alpha.
- **1×1 / 2×2 / 3×3**: tiles the current frame to check for seams.
- **Sheet**: shows the whole texture with the current cell outlined.
- **Smooth**: bilinear filtering on or off.

Settings are remembered between sessions.

## Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Step back / forward |
| Home / End | Go to start / end |
| S | Stop |
| Tab / Shift+Tab | Cycle through the number fields |
| Enter | Finish editing a field |

## Project structure

```
index.html     markup
style.css      styling
app.js         viewer logic
decoders.js    DDS / TGA / TIFF decoders
lib/           third-party libraries
```

## License

TileDeck is released under the [MIT License](LICENSE).

## Third-party libraries

- [UTIF.js](https://github.com/photopea/UTIF.js) 3.1.0, MIT License
- [pako](https://github.com/nodeca/pako) 1.0.11 (inflate only), MIT and Zlib Licenses
