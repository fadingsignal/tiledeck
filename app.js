(() => {
  const $ = id => document.getElementById(id);
  const BG = '#0d0d0d';
  const CHANNELS = ['RGBA', 'RGB', 'A', 'R', 'G', 'B'];
  const cv = $('cv'), ctx = cv.getContext('2d');
  const fc = document.createElement('canvas'), fctx = fc.getContext('2d');  // single-frame buffer
  const img = new Image();
  let tex = img, TW = 0, TH = 0;   // current texture source (image or decoded DDS canvas) and size
  let loaded = false, imgURL = null, raw = null, chanCache = {};

  const S = {
    speed: 30, gh: 8, gv: 8, scroll: false, cols: false, rtl: false, btt: false,
    checker: false, sheet: false, smooth: true,
    start: 1, frames: 0, ping: false, blend: false, chan: 'RGBA', add: false, tile: 1,
    tint: false, tintColor: '#ff8a2a', zoom: 'fit',
  };
  try { Object.assign(S, JSON.parse(localStorage.getItem('fbv') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('fbv', JSON.stringify(S)); } catch (e) {} };

  let pos = 0;          // playback position (cells) within the loop period
  let playing = true;
  let last = performance.now();

  // ---------- sequencing ----------
  const wrap = (v, m) => ((v % m) + m) % m;
  const nC = () => Math.max(1, Math.floor(S.gh + 1e-6));
  const nR = () => Math.max(1, Math.floor(S.gv + 1e-6));
  // full path length: discrete frame count (stepped) or continuous length in cells (scroll)
  const total = () => S.scroll ? (S.cols ? nC() * S.gv : nR() * S.gh) : nC() * nR();

  // [first cell, length] of the playback range
  function range() {
    const T = total();
    let s0 = Math.max(0, (+S.start || 1) - 1);
    let L;
    if (S.scroll) { s0 = Math.min(s0, T * 0.999); L = T - s0; if (S.frames > 0) L = Math.min(L, S.frames); }
    else { s0 = Math.min(Math.floor(s0), T - 1); L = T - s0; if (S.frames >= 1) L = Math.min(L, Math.floor(S.frames)); }
    return [s0, L];
  }
  function period() {
    const L = range()[1];
    if (!S.ping) return L;
    return S.scroll ? 2 * L : Math.max(1, 2 * (L - 1));
  }
  // position within the period -> offset within the range
  function mapPos(q) {
    const L = range()[1];
    if (!S.ping) return q;
    if (S.scroll) return q < L ? q : Math.min(L - 1e-6, 2 * L - q);
    return q < L ? q : period() - q;
  }

  // path position (in cells along the full path) -> source cell origin (in cells, may be fractional)
  function origin(p) {
    p = wrap(p, total());
    let cx, cy;
    if (!S.scroll) {
      const i = Math.floor(p);
      if (S.cols) { cx = Math.floor(i / nR()); cy = i % nR(); }
      else        { cy = Math.floor(i / nC()); cx = i % nC(); }
      if (S.rtl) cx = nC() - 1 - cx;
      if (S.btt) cy = nR() - 1 - cy;
    } else if (!S.cols) {
      const line = Math.floor(p / S.gh), along = p - line * S.gh;
      cy = S.btt ? nR() - 1 - line : line;
      cx = S.rtl ? wrap(S.gh - 1 - along, S.gh) : along;
    } else {
      const line = Math.floor(p / S.gv), along = p - line * S.gv;
      cx = S.rtl ? nC() - 1 - line : line;
      cy = S.btt ? wrap(S.gv - 1 - along, S.gv) : along;
    }
    return [cx, cy];
  }

  // current frame(s) to draw: a, optional b with blend factor f, and counter label
  function frameState() {
    const [s0, L] = range(), P = period();
    if (S.scroll) {
      const off = mapPos(wrap(pos, P));
      return { a: origin(s0 + off), b: null, f: 0, label: `${Math.floor(off) + 1} / ${Math.ceil(L)}` };
    }
    const n = Math.floor(pos), k = mapPos(wrap(n, P));
    const st = { a: origin(s0 + k), b: null, f: 0, label: `${k + 1} / ${L}` };
    if (S.blend && L > 1 && pos - n > 1e-4) {
      st.f = pos - n;
      st.b = origin(s0 + mapPos(wrap(n + 1, P)));
    }
    return st;
  }

  // ---------- channel sources ----------
  // Raw, non-premultiplied pixels via WebGL so RGB under zero alpha survives; 2D fallback otherwise.
  function rawPixels() {
    if (raw) return raw;
    const W = TW, H = TH;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl', { premultipliedAlpha: false });
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw 0;
      const d = new Uint8ClampedArray(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(d.buffer));
      const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      raw = d;
    } catch (e) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const cx = c.getContext('2d'); cx.drawImage(tex, 0, 0);
      raw = cx.getImageData(0, 0, W, H).data;
    }
    return raw;
  }

  function source() {
    if (S.chan === 'RGBA') return tex;
    if (chanCache[S.chan]) return chanCache[S.chan];
    const W = TW, H = TH, d = rawPixels(), m = S.chan;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d'), out = cx.createImageData(W, H), o = out.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (m === 'A') r = g = b = d[i + 3];
      else if (m === 'R') g = b = r;
      else if (m === 'G') r = b = g;
      else if (m === 'B') r = g = b;
      o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = 255;
    }
    cx.putImageData(out, 0, 0);
    return (chanCache[m] = c);
  }

  // ---------- tint (multiply RGB, keep alpha) ----------
  // Each color gets a unique filter id so browsers can't reuse a cached filter.
  const tintEl = $('tintF');
  function updateTint() {
    const h = S.tintColor.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    $('tintM').setAttribute('values', `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`);
    tintEl.id = 'tint' + h;
  }
  const tintFilter = () => S.tint ? `url(#tint${S.tintColor.replace('#', '')})` : 'none';

  // ---------- drawing ----------
  function drawWrapped(c, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    const W = TW, H = TH;
    sx = wrap(sx, W); sy = wrap(sy, H);
    const kx = dw / sw, ky = dh / sh;
    for (let y0 = sy, ddy = 0, remY = sh; remY > 1e-3; ) {
      const hh = Math.min(remY, H - y0);
      for (let x0 = sx, ddx = 0, remX = sw; remX > 1e-3; ) {
        const ww = Math.min(remX, W - x0);
        c.drawImage(src, x0, y0, ww, hh, dx + ddx * kx, dy + ddy * ky, ww * kx, hh * ky);
        ddx += ww; remX -= ww; x0 = 0;
      }
      ddy += hh; remY -= hh; y0 = 0;
    }
  }

  function checker(w, h) {
    const s = 12 * (devicePixelRatio || 1);
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1f1f1f';
    for (let j = 0; j * s < h; j++)
      for (let i = (j & 1); i * s < w; i += 2) ctx.fillRect(i * s, j * s, s, s);
  }

  function layout() {
    if (!loaded) { cv.width = cv.height = 0; return; }
    const dpr = window.devicePixelRatio || 1;
    const aw = $('wrap').clientWidth - 32, ah = $('wrap').clientHeight - 32;
    const W = TW, H = TH;
    const n = S.sheet ? 1 : S.tile;
    const uw = S.sheet ? W : W / S.gh, uh = S.sheet ? H : H / S.gv;   // one tile, source px
    // fit: scale to the viewport; 1:1: one texel per device pixel
    const k = S.zoom === '1' ? 1 / dpr : Math.min(aw / (uw * n), ah / (uh * n));
    const tw = Math.max(1, Math.round(uw * k * dpr)), th = Math.max(1, Math.round(uh * k * dpr));
    cv.width = tw * n; cv.height = th * n;
    cv.style.width = cv.width / dpr + 'px'; cv.style.height = cv.height / dpr + 'px';
  }

  function render() {
    if (!loaded) return;
    const W = TW, H = TH;
    const cw = W / S.gh, ch = H / S.gv;
    const st = frameState(), src = source();
    const op = S.add ? 'lighter' : 'source-over';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height);
    if (S.checker) checker(cv.width, cv.height);
    ctx.imageSmoothingEnabled = S.smooth;

    if (S.sheet) {
      ctx.globalCompositeOperation = op; ctx.filter = tintFilter();
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
      const k = cv.width / W;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < S.gh; i++) { const x = Math.round(i * cw * k) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); }
      for (let j = 1; j < S.gv; j++) { const y = Math.round(j * ch * k) + 0.5; ctx.moveTo(0, y); ctx.lineTo(cv.width, y); }
      ctx.stroke();
      ctx.strokeStyle = '#aaa'; ctx.lineWidth = Math.max(1, devicePixelRatio || 1);
      const [cx, cy] = st.a;
      const rx = cx * cw * k, ry = cy * ch * k, rw = cw * k, rh = ch * k;
      ctx.strokeRect(rx, ry, rw, rh);
      if (rx + rw > cv.width + 0.5) ctx.strokeRect(rx - cv.width, ry, rw, rh);
      if (ry + rh > cv.height + 0.5) ctx.strokeRect(rx, ry - cv.height, rw, rh);
    } else {
      const n = S.tile, tw = cv.width / n, th = cv.height / n;
      if (fc.width !== tw || fc.height !== th) { fc.width = tw; fc.height = th; }
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.globalCompositeOperation = 'source-over'; fctx.globalAlpha = 1;
      fctx.clearRect(0, 0, tw, th);
      fctx.imageSmoothingEnabled = S.smooth;
      if (st.b) {
        // premultiplied lerp: A*(1-f) + B*f
        fctx.globalAlpha = 1 - st.f;
        drawWrapped(fctx, src, st.a[0] * cw, st.a[1] * ch, cw, ch, 0, 0, tw, th);
        fctx.globalAlpha = st.f; fctx.globalCompositeOperation = 'lighter';
        drawWrapped(fctx, src, st.b[0] * cw, st.b[1] * ch, cw, ch, 0, 0, tw, th);
        fctx.globalAlpha = 1; fctx.globalCompositeOperation = 'source-over';
      } else {
        drawWrapped(fctx, src, st.a[0] * cw, st.a[1] * ch, cw, ch, 0, 0, tw, th);
      }
      ctx.globalCompositeOperation = op; ctx.filter = tintFilter();
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ctx.drawImage(fc, i * tw, j * th);
      ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    }
    $('frame').textContent = st.label;
  }

  function tick(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (playing && loaded) pos = wrap(pos + S.speed * dt, period());
    render();
    requestAnimationFrame(tick);
  }

  // ---------- UI ----------
  function syncUI() {
    $('speed').value = S.speed; $('gh').value = S.gh; $('gv').value = S.gv;
    $('start').value = S.start; $('frames').value = S.frames;
    $('mStep').classList.toggle('on', !S.scroll); $('mScroll').classList.toggle('on', S.scroll);
    $('oRows').classList.toggle('on', !S.cols);   $('oCols').classList.toggle('on', S.cols);
    $('dH').textContent = S.rtl ? 'R→L' : 'L→R';
    $('dV').textContent = S.btt ? 'B→T' : 'T→B';
    $('bLoop').classList.toggle('on', !S.ping); $('bPing').classList.toggle('on', S.ping);
    $('bBlend').classList.toggle('on', S.blend);
    $('bBlend').classList.toggle('dim', S.scroll);
    $('unit').textContent = S.scroll ? 'cells/s' : 'fps';
    $('bChan').textContent = S.chan;
    $('bChan').classList.toggle('on', S.chan !== 'RGBA');
    $('bAdd').classList.toggle('on', S.add);
    $('bTint').classList.toggle('on', S.tint);
    $('tint').value = S.tintColor;
    updateTint();
    $('bChk').classList.toggle('on', S.checker);
    $('bTile').textContent = `${S.tile}×${S.tile}`;
    $('bTile').classList.toggle('on', S.tile > 1);
    $('bTile').classList.toggle('dim', S.sheet);
    $('bSheet').classList.toggle('on', S.sheet);
    $('bSmooth').classList.toggle('on', S.smooth);
    $('zFit').classList.toggle('on', S.zoom !== '1'); $('z1').classList.toggle('on', S.zoom === '1');
    $('bPlay').textContent = playing ? '❚❚' : '▶';
    $('hint').style.display = loaded ? 'none' : '';
    pos = wrap(pos, period());
    save(); layout();
  }

  const set = (k, v) => { S[k] = v; if (!S.scroll) pos = Math.floor(pos); syncUI(); };
  const num = (el, k, min) => el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (isFinite(v) && (min === undefined || v >= min)) { S[k] = v; pos = wrap(pos, period()); save(); layout(); }
  });
  num($('speed'), 'speed'); num($('gh'), 'gh', 0.01); num($('gv'), 'gv', 0.01);
  num($('start'), 'start', 1); num($('frames'), 'frames', 0);

  $('mStep').onclick   = () => set('scroll', false);
  $('mScroll').onclick = () => set('scroll', true);
  $('oRows').onclick   = () => set('cols', false);
  $('oCols').onclick   = () => set('cols', true);
  $('dH').onclick      = () => set('rtl', !S.rtl);
  $('dV').onclick      = () => set('btt', !S.btt);
  $('bLoop').onclick   = () => set('ping', false);
  $('bPing').onclick   = () => set('ping', true);
  $('bBlend').onclick  = () => set('blend', !S.blend);
  $('bChan').onclick   = () => set('chan', CHANNELS[(CHANNELS.indexOf(S.chan) + 1) % CHANNELS.length]);
  $('bAdd').onclick    = () => set('add', !S.add);
  $('bTint').onclick   = () => set('tint', !S.tint);
  $('tint').addEventListener('input', e => { S.tintColor = e.target.value; S.tint = true; syncUI(); });
  $('bChk').onclick    = () => set('checker', !S.checker);
  $('bTile').onclick   = () => set('tile', S.tile % 3 + 1);
  $('bSheet').onclick  = () => set('sheet', !S.sheet);
  $('bSmooth').onclick = () => set('smooth', !S.smooth);
  $('zFit').onclick    = () => set('zoom', 'fit');
  $('z1').onclick      = () => set('zoom', '1');

  const stepAmt = () => S.scroll ? 1 / 16 : 1;
  const step = d => { playing = false; pos = wrap((S.scroll ? pos : Math.floor(pos)) + d * stepAmt(), period()); syncUI(); };
  $('bPlay').onclick  = () => { playing = !playing; syncUI(); };
  $('bStop').onclick  = () => { playing = false; pos = 0; syncUI(); };
  $('bFwd').onclick   = () => step(1);
  $('bBack').onclick  = () => step(-1);
  $('bStart').onclick = () => { pos = 0; syncUI(); };
  $('bEnd').onclick   = () => { pos = range()[1] - stepAmt(); syncUI(); };

  // Tab order: number fields only; buttons and the color swatch are skipped
  const FIELDS = ['speed', 'gh', 'gv', 'start', 'frames'].map($);
  document.querySelectorAll('#side button, #tint').forEach(el => el.tabIndex = -1);

  document.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      // Tab cycles only the number fields, in order, wrapping around
      e.preventDefault();
      const i = FIELDS.indexOf(e.target);
      const next = i < 0 ? (e.shiftKey ? FIELDS.length - 1 : 0)
                         : (i + (e.shiftKey ? -1 : 1) + FIELDS.length) % FIELDS.length;
      FIELDS[next].focus(); FIELDS[next].select();
      return;
    }
    if (e.target.tagName === 'INPUT') { if (e.key === 'Enter') e.target.blur(); return; }
    if (e.code === 'Space') { e.preventDefault(); $('bPlay').click(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 's' || e.key === 'S') $('bStop').click();
    else if (e.key === 'Home') $('bStart').click();
    else if (e.key === 'End') $('bEnd').click();
  });

  // ---------- loading ----------
  function setTexture(t, w, h, rawData, name, label) {
    tex = t; TW = w; TH = h; raw = rawData; chanCache = {};
    const m = name.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
    if (m) { S.gh = parseFloat(m[1]); S.gv = parseFloat(m[2]); }
    $('name').textContent = label; $('name').title = label;
    loaded = true; pos = 0; syncUI();
  }
  function loadError(name, msg) {
    const t = `${name}: ${msg}`;
    $('name').textContent = t; $('name').title = t;
  }

  const DECODERS = { dds: Decoders.decodeDDS, tga: Decoders.decodeTGA, tif: Decoders.decodeTIFF, tiff: Decoders.decodeTIFF };

  async function loadFile(f) {
    if (!f) return;
    const ext = (f.name.match(/\.(\w+)$/) || [])[1];
    const decode = ext && DECODERS[ext.toLowerCase()];
    if (decode) {
      try {
        const d = decode(await f.arrayBuffer());
        const c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
        c.getContext('2d').putImageData(new ImageData(d.data, d.w, d.h), 0, 0);
        setTexture(c, d.w, d.h, d.data, f.name, `${f.name} · ${d.fmt}`);
      } catch (err) { loadError(f.name, err.message); }
      return;
    }
    if (!f.type.startsWith('image/')) return;
    const url = URL.createObjectURL(f);
    img.onload = () => {
      if (imgURL) URL.revokeObjectURL(imgURL);
      imgURL = url;
      setTexture(img, img.naturalWidth, img.naturalHeight, null, f.name, f.name);
    };
    img.onerror = () => { URL.revokeObjectURL(url); loadError(f.name, 'could not decode image'); };
    img.src = url;
  }
  $('file').addEventListener('change', e => loadFile(e.target.files[0]));
  addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
  addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });
  addEventListener('resize', layout);

  syncUI();
  requestAnimationFrame(tick);
})();
