// TileDeck texture decoders for formats browsers cannot open natively.
// Each decoder takes an ArrayBuffer and returns { w, h, fmt, data } where data is
// non-premultiplied RGBA8 (Uint8ClampedArray), rows top to bottom.
const Decoders = (() => {
  // ---------- DDS ----------
  // Block-compressed formats are decoded by the GPU (compressed upload, render to an RGBA8
  // framebuffer, read back). Uncompressed formats are decoded on the CPU. Mip 0 / slice 0 only.
  // sRGB variants are uploaded as UNORM so the stored values are shown as-is, like a PNG.
  const CC = s => (s.charCodeAt(0) | s.charCodeAt(1) << 8 | s.charCodeAt(2) << 16 | s.charCodeAt(3) << 24) >>> 0;
  const LEGACY_CC = {
    [CC('DXT1')]: 'BC1', [CC('DXT2')]: 'BC2', [CC('DXT3')]: 'BC2', [CC('DXT4')]: 'BC3', [CC('DXT5')]: 'BC3',
    [CC('ATI1')]: 'BC4', [CC('BC4U')]: 'BC4', [CC('ATI2')]: 'BC5', [CC('BC5U')]: 'BC5',
    [CC('BC4S')]: 'BC4 signed', [CC('BC5S')]: 'BC5 signed',
  };
  const DXGI = {
    70: 'BC1', 71: 'BC1', 72: 'BC1', 73: 'BC2', 74: 'BC2', 75: 'BC2', 76: 'BC3', 77: 'BC3', 78: 'BC3',
    79: 'BC4', 80: 'BC4', 81: 'BC4 signed', 82: 'BC5', 83: 'BC5', 84: 'BC5 signed',
    94: 'BC6H', 95: 'BC6H', 96: 'BC6H', 97: 'BC7', 98: 'BC7', 99: 'BC7',
    27: 'RGBA8', 28: 'RGBA8', 29: 'RGBA8', 90: 'BGRA8', 87: 'BGRA8', 91: 'BGRA8',
    92: 'BGRX8', 88: 'BGRX8', 93: 'BGRX8', 61: 'R8',
  };
  const GPU_FMT = {   // [extension key, GL enum, bytes per 4x4 block]
    BC1: ['s3tc', 0x83F1, 8], BC2: ['s3tc', 0x83F2, 16], BC3: ['s3tc', 0x83F3, 16],
    BC4: ['rgtc', 0x8DBB, 8], BC5: ['rgtc', 0x8DBD, 16], BC7: ['bptc', 0x8E8C, 16],
  };

  function decodeDDS(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 128 || dv.getUint32(0, true) !== CC('DDS ')) throw new Error('not a valid DDS file');
    const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
    const pf = dv.getUint32(80, true), four = dv.getUint32(84, true);
    let off = 128, fmt = null;
    if (pf & 0x4) {                                   // DDPF_FOURCC
      if (four === CC('DX10')) {
        if (buf.byteLength < 148) throw new Error('file is truncated');
        const dxgi = dv.getUint32(128, true); off = 148;
        fmt = DXGI[dxgi];
        if (!fmt) throw new Error(`unsupported format (DXGI ${dxgi})`);
      } else {
        fmt = LEGACY_CC[four];
        if (!fmt) throw new Error('unsupported format');
      }
    }
    const take = n => {
      if (off + n > buf.byteLength) throw new Error('file is truncated');
      return new Uint8Array(buf, off, n);
    };

    if (fmt && GPU_FMT[fmt]) {
      const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
      return { w, h, fmt, data: gpuDecode(fmt, take(bw * bh * GPU_FMT[fmt][2]), bw * 4, bh * 4, w, h) };
    }
    if (fmt && !['RGBA8', 'BGRA8', 'BGRX8', 'R8'].includes(fmt)) throw new Error(`${fmt} is not supported`);

    const out = new Uint8ClampedArray(w * h * 4);
    if (fmt) {                                        // DX10 uncompressed
      const bpp = fmt === 'R8' ? 1 : 4, src = take(w * h * bpp);
      for (let i = 0, j = 0; i < w * h; i++, j += bpp) {
        const o = i * 4;
        if (fmt === 'R8') { out[o] = out[o + 1] = out[o + 2] = src[j]; out[o + 3] = 255; }
        else if (fmt === 'RGBA8') { out[o] = src[j]; out[o + 1] = src[j + 1]; out[o + 2] = src[j + 2]; out[o + 3] = src[j + 3]; }
        else { out[o] = src[j + 2]; out[o + 1] = src[j + 1]; out[o + 2] = src[j]; out[o + 3] = fmt === 'BGRA8' ? src[j + 3] : 255; }
      }
      return { w, h, fmt, data: out };
    }

    // legacy uncompressed, described by bit masks
    const RGB = 0x40, LUM = 0x20000, ALPHA = 0x2, HAS_A = 0x1;
    if (!(pf & (RGB | LUM | ALPHA))) throw new Error('unsupported format');
    const bits = dv.getUint32(88, true), bpp = bits / 8;
    if (![1, 2, 3, 4].includes(bpp)) throw new Error(`unsupported ${bits}-bit format`);
    const masks = [92, 96, 100, 104].map(o => dv.getUint32(o, true));
    const chans = masks.map(m => {
      if (!m) return null;
      let s = 0; while (!((m >>> s) & 1)) s++;
      return { m, s, k: 255 / (m >>> s) };
    });
    const get = (v, c) => c ? Math.round(((v & c.m) >>> c.s) * c.k) : 0;
    const alphaOnly = (pf & ALPHA) && !(pf & (RGB | LUM));
    const hasA = alphaOnly || (pf & HAS_A);
    const src = take(w * h * bpp);
    for (let i = 0, j = 0; i < w * h; i++, j += bpp) {
      let v = 0;
      for (let b = bpp - 1; b >= 0; b--) v = (v << 8) | src[j + b];
      v >>>= 0;
      const o = i * 4;
      if (alphaOnly) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = get(v, chans[3] || chans[0]); continue; }
      const r = get(v, chans[0]);
      if (pf & LUM) { out[o] = out[o + 1] = out[o + 2] = r; }
      else { out[o] = r; out[o + 1] = get(v, chans[1]); out[o + 2] = get(v, chans[2]); }
      out[o + 3] = hasA ? get(v, chans[3]) : 255;
    }
    return { w, h, fmt: `${bits}-bit`, data: out };
  }

  let glc = null;
  function gpuInit() {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const gl = c.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL is unavailable');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER,
      'attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,
      'precision highp float; varying vec2 uv; uniform sampler2D t; uniform int grey;' +
      'void main(){ vec4 c = texture2D(t, uv); gl_FragColor = grey == 1 ? vec4(c.rrr, 1.0) : c; }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('WebGL shader failed');
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    glc = {
      gl, grey: gl.getUniformLocation(prog, 'grey'),
      ext: {
        s3tc: gl.getExtension('WEBGL_compressed_texture_s3tc'),
        rgtc: gl.getExtension('EXT_texture_compression_rgtc'),
        bptc: gl.getExtension('EXT_texture_compression_bptc'),
      },
    };
  }

  function gpuDecode(fmt, bytes, pw, ph, w, h) {
    if (!glc) gpuInit();
    const { gl } = glc, [extKey, glFmt] = GPU_FMT[fmt];
    if (!glc.ext[extKey]) throw new Error(`${fmt} decoding isn't supported by this browser/GPU`);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (pw > max || ph > max) throw new Error(`too large for this GPU (max ${max}px)`);
    const mkTex = () => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    gl.getError();
    // target: RGBA8 framebuffer
    const dst = mkTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    // source: compressed texture
    const src = mkTex();
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, glFmt, pw, ph, 0, bytes);
    const err = gl.getError();
    try {
      if (err) throw new Error(`GPU rejected the ${fmt} data (error ${err})`);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL framebuffer failed');
      gl.viewport(0, 0, pw, ph);
      gl.uniform1i(glc.grey, fmt === 'BC4' ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // framebuffer row 0 = texture row 0 = top of the image, so rows come back in image order
      const out = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return new Uint8ClampedArray(out.buffer);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb); gl.deleteTexture(src); gl.deleteTexture(dst);
    }
  }

  // ---------- TGA ----------
  // Types 1/2/3 (color-mapped, truecolor, greyscale), uncompressed or RLE (9/10/11).
  // 8/15/16/24/32-bit; honors the top-down and right-to-left origin bits.
  function decodeTGA(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf);
    if (b.length < 18) throw new Error('not a valid TGA file');
    const idLen = b[0], cmType = b[1], type = b[2];
    const cmStart = dv.getUint16(3, true), cmLen = dv.getUint16(5, true), cmDepth = b[7];
    const w = dv.getUint16(12, true), h = dv.getUint16(14, true), bpp = b[16], desc = b[17];
    const rle = type >= 9, base = rle ? type - 8 : type;
    if (![1, 2, 3].includes(base) || (type > 3 && type < 9) || type > 11 || !w || !h)
      throw new Error('not a valid TGA file');
    const Bpp = (bpp + 7) >> 3;
    let off = 18 + idLen;

    // truecolor pixel at offset o -> rgba at out[k]
    const color = (depth, src, o, out, k) => {
      if (depth === 24 || depth === 32) {
        out[k] = src[o + 2]; out[k + 1] = src[o + 1]; out[k + 2] = src[o];
        out[k + 3] = depth === 32 ? src[o + 3] : 255;
      } else if (depth === 15 || depth === 16) {
        const v = src[o] | src[o + 1] << 8;
        out[k] = ((v >> 10) & 31) * 255 / 31; out[k + 1] = ((v >> 5) & 31) * 255 / 31; out[k + 2] = (v & 31) * 255 / 31;
        out[k + 3] = depth === 16 && (desc & 15) ? (v >> 15) * 255 : 255;
      } else throw new Error(`unsupported ${depth}-bit TGA`);
    };

    let pal = null;
    if (cmType === 1) {
      const eb = (cmDepth + 7) >> 3;
      if (off + cmLen * eb > b.length) throw new Error('file is truncated');
      pal = new Uint8ClampedArray(cmLen * 4);
      for (let i = 0; i < cmLen; i++) color(cmDepth, b, off + i * eb, pal, i * 4);
      off += cmLen * eb;
    }
    if (base === 1 && !pal) throw new Error('color-mapped TGA without a palette');
    if (base === 3 && bpp !== 8 && bpp !== 16) throw new Error(`unsupported ${bpp}-bit greyscale TGA`);

    const one = (o, out, k) => {
      if (base === 3) { out[k] = out[k + 1] = out[k + 2] = b[o]; out[k + 3] = bpp === 16 ? b[o + 1] : 255; }
      else if (base === 2) color(bpp, b, o, out, k);
      else {
        const p = ((Bpp === 1 ? b[o] : b[o] | b[o + 1] << 8) - cmStart) * 4;
        out[k] = pal[p]; out[k + 1] = pal[p + 1]; out[k + 2] = pal[p + 2]; out[k + 3] = pal[p + 3];
      }
    };

    const n = w * h, lin = new Uint8ClampedArray(n * 4);
    if (!rle) {
      if (off + n * Bpp > b.length) throw new Error('file is truncated');
      for (let i = 0; i < n; i++) one(off + i * Bpp, lin, i * 4);
    } else {
      for (let i = 0; i < n; ) {
        if (off >= b.length) throw new Error('file is truncated');
        const hd = b[off++], c = Math.min((hd & 127) + 1, n - i);
        if (off + (hd & 128 ? 1 : c) * Bpp > b.length) throw new Error('file is truncated');
        if (hd & 128) {
          one(off, lin, i * 4); off += Bpp;
          for (let j = 1; j < c; j++) lin.copyWithin((i + j) * 4, i * 4, i * 4 + 4);
        } else {
          for (let j = 0; j < c; j++, off += Bpp) one(off, lin, (i + j) * 4);
        }
        i += c;
      }
    }

    // 32-bit (or 16-bit with an alpha bit) where every alpha is zero: treat as opaque
    if ((base !== 3 && (bpp === 32 || (bpp === 16 && (desc & 15)))) || pal) {
      let any = false;
      for (let i = 3; i < lin.length; i += 4) if (lin[i]) { any = true; break; }
      if (!any) for (let i = 3; i < lin.length; i += 4) lin[i] = 255;
    }

    // reorder to top-down, left-to-right
    const topDown = desc & 0x20, rtl = desc & 0x10;
    let data = lin;
    if (!topDown || rtl) {
      data = new Uint8ClampedArray(n * 4);
      const px = new Uint32Array(lin.buffer), dst = new Uint32Array(data.buffer);
      for (let r = 0; r < h; r++) {
        const dy = topDown ? r : h - 1 - r;
        for (let c = 0; c < w; c++) dst[dy * w + (rtl ? w - 1 - c : c)] = px[r * w + c];
      }
    }
    return { w, h, fmt: `${bpp}-bit${rle ? ' RLE' : ''}`, data };
  }

  // ---------- TIFF ----------
  // UTIF.js handles parsing and decompression (none, LZW, ZIP via pako, PackBits, JPEG, predictors)
  // and converts 16-bit samples to little-endian. Pixel layout conversion is done here so that
  // greyscale+alpha, 16-bit and premultiplied alpha come out right. First image only.
  const TIFF_CMPR = { 1: 'uncompressed', 5: 'LZW', 7: 'JPEG', 8: 'ZIP', 32946: 'ZIP', 32773: 'PackBits' };

  function decodeTIFF(buf) {
    if (typeof UTIF === 'undefined') throw new Error('TIFF library failed to load');
    let ifds;
    try { ifds = UTIF.decode(buf); } catch (e) { throw new Error('not a valid TIFF file'); }
    const ifd = ifds.find(d => d.t256 && d.t257);
    if (!ifd) throw new Error('no image found in TIFF');

    const bps = ifd.t258 ? ifd.t258[0] : 1;
    const spp = ifd.t277 ? ifd.t277[0] : (ifd.t258 ? ifd.t258.length : 1);
    const photo = ifd.t262 ? ifd.t262[0] : 1;
    const sfmt = ifd.t339 ? ifd.t339[0] : 1;
    const cmpr = ifd.t259 ? ifd.t259[0] : 1;
    if (sfmt === 3) throw new Error('floating-point (HDR) TIFF is not supported');
    if (ifd.t284 && ifd.t284[0] === 2) throw new Error('planar TIFF is not supported');
    if (cmpr === 8 || cmpr === 32946) { if (typeof pako === 'undefined') throw new Error('ZIP library failed to load'); }

    try { UTIF.decodeImage(buf, ifd, ifds); } catch (e) { throw new Error('could not decode TIFF data'); }
    const w = ifd.width, h = ifd.height, n = w * h, src = ifd.data;
    if (!src) throw new Error('could not decode TIFF data');
    const fmt = `${bps}-bit ${TIFF_CMPR[cmpr] || 'compression ' + cmpr}`;

    // palette, CMYK, 1/2/4-bit: UTIF's own conversion covers these
    if (!((photo === 0 || photo === 1 || photo === 2) && (bps === 8 || bps === 16))) {
      return { w, h, fmt, data: new Uint8ClampedArray(UTIF.toRGBA8(ifd).buffer) };
    }

    const bytes = bps >> 3, need = n * spp * bytes;
    if (src.length < need) throw new Error('file is truncated');
    const at = bytes === 1 ? i => src[i] : i => Math.round((src[2 * i] | src[2 * i + 1] << 8) / 257);
    const grey = photo !== 2;
    if (!grey && spp < 3) throw new Error(`unsupported RGB TIFF with ${spp} channels`);
    const hasA = grey ? spp >= 2 : spp >= 4;
    const premul = hasA && ifd.t338 && ifd.t338[0] === 1;   // ExtraSamples: 1 = associated alpha
    const out = new Uint8ClampedArray(n * 4);

    for (let p = 0, s = 0; p < n; p++, s += spp) {
      const o = p * 4;
      let r, g, bl, a = hasA ? at(s + (grey ? 1 : 3)) : 255;
      if (grey) { r = g = bl = at(s); if (photo === 0) r = g = bl = 255 - r; }
      else { r = at(s); g = at(s + 1); bl = at(s + 2); }
      if (premul && a > 0 && a < 255) { const k = 255 / a; r *= k; g *= k; bl *= k; }
      out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a;
    }
    return { w, h, fmt, data: out };
  }

  return { decodeDDS, decodeTGA, decodeTIFF };
})();
