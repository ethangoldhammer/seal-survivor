// ---------------------------------------------------------------------------
// THE METER — a preload that sits under the game and counts what the GPU is
// handed. Loaded by tools/notex/drive.js with contextIsolation OFF, so it runs
// in the page's own world BEFORE the bundle and can wrap the two things the
// renderer reaches for: `requestAnimationFrame` (the frame) and
// `HTMLCanvasElement.getContext` (the context every upload and draw goes
// through). Nothing here is reachable from the game's code and nothing here
// changes what it renders.
//
// WHY NOT renderer.info. three keeps its own counts, but the renderer is a
// module-scope object in main.js with no window handle, and a build made for
// this one measurement would be measuring a different build. The GL calls are
// the ground truth anyway: `renderer.info.memory.textures` counts objects,
// where texImage2D counts BYTES.
//
// GPU TIME IS THE NUMBER THAT MATTERS, and the only one the frame rate cannot
// show. A hidden Electron window still paces rAF at the display's refresh, so
// a frame that got cheaper on the GPU comes back at exactly the same 8.3ms.
// EXT_disjoint_timer_query_webgl2 puts a query around every rAF callback and
// reads the elapsed nanoseconds back a few frames later. Where the extension
// is missing (`ext: false` in the report) the GPU columns are empty and the
// upload bytes are the reading to trust.
// ---------------------------------------------------------------------------
(() => {
  // PIN THE RESOLUTION. The adaptive controller (systems/adaptiveScale.js)
  // answers slow frames by cutting pixels, and it answered the shipped run
  // with 0.4x while the no-texture run held 0.9x — after which every GPU
  // number compared a third of the pixels against all of them. Written before
  // the page's scripts run, into the settings key systems/settings.js reads at
  // boot; the driver hands each run a throwaway profile, so this reaches no
  // real player's settings.
  // `abset` on the URL is a JSON of extra settings for this run (the driver's
  // --settings), merged over the pin; `abpasses=1` turns on per-pass timer
  // queries, which are off by default because they distort what they measure.
  let PASSES = false;
  try {
    const q = new URLSearchParams(location.search);
    PASSES = q.get('abpasses') === '1';
    const extra = q.get('abset') ? JSON.parse(q.get('abset')) : {};
    const merged = { performance: { adaptiveRes: false, ...(extra.performance ?? {}) } };
    for (const [k, v] of Object.entries(extra)) if (k !== 'performance') merged[k] = v;
    localStorage.setItem('sealsurvivor.settings.v1', JSON.stringify(merged));
  } catch { /* storage blocked: the run is then unpinned and the report's canvas line says so */ }

  const S = {
    ext: false,
    recording: false,
    frames: [],   // rAF-to-rAF ms
    js: [],       // ms inside the rAF callbacks of one frame
    gpu: [],      // GPU ms per frame (timer query), when available
    draws: [],    // draw calls per frame
    uploads: { count: 0, bytes: 0, compressed: 0, targets: 0, targetBytes: 0, storage: 0, reuploads: 0, reuploadBytes: 0 }, // since page load
    cards: 0,
    uploadsAtStart: null,
  };
  window.__ab = S;

  const contexts = [];
  let gl = null;
  let ext = null;
  let drawsThisFrame = 0;

  const bytesOfImage = (img) => {
    if (!img) return 0;
    const w = img.width ?? img.naturalWidth ?? img.videoWidth ?? 0;
    const h = img.height ?? img.naturalHeight ?? img.videoHeight ?? 0;
    return w * h * 4;
  };

  // Every upload path three.js takes. IMAGES and RENDER TARGETS are told
  // apart, because at 3200x1936 one post-processing target is 24MB and the
  // question is about jpegs: an image arrives through texSubImage2D with a
  // source (three uses texStorage2D + texSubImage2D on WebGL2), through
  // texImage2D with a source, or through the compressed pair; a target is a
  // texImage2D with null pixels or a texStorage2D nothing ever fills. Level 0
  // only — mips add a third for both variants alike.
  function wrapUploads(g) {
    const orig = {
      texImage2D: g.texImage2D,
      texStorage2D: g.texStorage2D,
      texSubImage2D: g.texSubImage2D,
      compressedTexImage2D: g.compressedTexImage2D,
      compressedTexSubImage2D: g.compressedTexSubImage2D,
    };
    // Which WebGLTexture is bound where, so an upload can be charged to the
    // texture it lands on. The first full upload of a texture is an IMAGE; every
    // later one is a RE-UPLOAD — a bone matrix texture or a canvas texture
    // refreshed each frame, which is the traffic that made the raw count read
    // half a million.
    const bound = new Map(); // unit -> { target -> WebGLTexture }
    let unit = 0;
    const seen = new WeakSet();
    const origActive = g.activeTexture;
    const origBind = g.bindTexture;
    g.activeTexture = function (u) { unit = u - 0x84C0; return origActive.call(this, u); };
    g.bindTexture = function (target, tex) {
      let m = bound.get(unit);
      if (!m) { m = new Map(); bound.set(unit, m); }
      m.set(target === 0x0DE1 ? 'tex2d' : String(target), tex);
      return origBind.call(this, target, tex);
    };
    const current = (target) => bound.get(unit)?.get(target === 0x0DE1 ? 'tex2d' : String(target)) ?? null;
    const image = (target, bytes, compressed = false) => {
      const tex = current(target);
      if (tex && seen.has(tex)) {
        S.uploads.reuploads++;
        S.uploads.reuploadBytes += bytes;
        return;
      }
      if (tex) seen.add(tex);
      S.uploads.count++;
      S.uploads.bytes += bytes;
      if (compressed) S.uploads.compressed++;
    };
    g.texImage2D = function (...a) {
      if (a[1] === 0) {
        if (a.length >= 9) {
          if (a[8]) image(a[0], a[3] * a[4] * 4);
          else { S.uploads.targets++; S.uploads.targetBytes += a[3] * a[4] * 4; }
        } else {
          image(a[0], bytesOfImage(a[5]));
        }
      }
      return orig.texImage2D.apply(this, a);
    };
    if (orig.texStorage2D) {
      g.texStorage2D = function (target, levels, fmt, w, h) {
        S.uploads.storage++;
        return orig.texStorage2D.call(this, target, levels, fmt, w, h);
      };
    }
    g.texSubImage2D = function (...a) {
      // (target, level, x, y, [w, h,] format, type, source|data)
      if (a[1] === 0 && a[2] === 0 && a[3] === 0) {
        if (a.length >= 9) { if (a[8]) image(a[0], a[4] * a[5] * 4); }
        else image(a[0], bytesOfImage(a[6]));
      }
      return orig.texSubImage2D.apply(this, a);
    };
    g.compressedTexImage2D = function (...a) {
      if (a[1] === 0) image(a[0], a[6]?.byteLength ?? 0, true);
      return orig.compressedTexImage2D.apply(this, a);
    };
    if (orig.compressedTexSubImage2D) {
      g.compressedTexSubImage2D = function (...a) {
        if (a[1] === 0 && a[2] === 0 && a[3] === 0) image(a[0], a[7]?.byteLength ?? 0, true);
        return orig.compressedTexSubImage2D.apply(this, a);
      };
    }
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const fn = g[name];
      if (!fn) continue;
      g[name] = function (...a) { drawsThisFrame++; return fn.apply(this, a); };
    }
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGetContext.call(this, type, ...rest);
    if (ctx && (type === 'webgl2' || type === 'webgl') && !contexts.includes(ctx)) {
      contexts.push(ctx);
      wrapUploads(ctx);
      wrapPipeline(ctx);
    }
    return ctx;
  };

  // The game's context is the one on the biggest canvas; Rive's are small.
  function pickContext() {
    let best = null;
    let area = -1;
    for (const c of contexts) {
      const a = (c.canvas?.width ?? 0) * (c.canvas?.height ?? 0);
      if (a > area) { area = a; best = c; }
    }
    gl = best;
    ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') || null) : null;
    S.ext = !!ext;
  }

  // WHO IS THE FRAME MADE OF. One timer query per stretch of the frame with
  // the same program on the same target: closed and reopened on every
  // useProgram and bindFramebuffer, so the elapsed nanoseconds land on
  // "water fill @ 3200x1936" rather than on "the frame". Programs are named
  // off their fragment source — a distinctive uniform, else three's own
  // SHADER_TYPE define — and targets off the viewport three sets after
  // binding one.
  const programLabels = new Map();
  // A PASS is a program worth its own query: the backdrop planes and the
  // post chain, each one or a few draws. Creature materials are hundreds of
  // draws a frame and get ONE bucket, because a query per program switch is
  // itself the cost — measured that way a 7ms frame read 58ms.
  const MARKERS = [
    ['uScanCount', 'final composite'], ['uThreshold', 'bloom bright'], ['uDirection', 'blur'],
    ['uIso', 'goo composite'], ['uGooHide', 'particles / goo splats'], ['uRayCount', 'water fill'], ['uCausticsIntensity', 'water fill'],
    ['uDrift', 'horizon glow'], ['uCoverage', 'clouds'], ['uAirH', 'sky'], ['uLimb', 'celestial'],
    ['uDecay', 'grid'], ['uChain', 'constellations'], ['uBendMax', 'constellations'],
    ['uClearFeather', 'ink trail'], ['uArmed', 'strike ring'], ['uDashDuty', 'aim indicator'],
    ['uArcGap', 'organic ring'], ['uHaloGain', 'breach trail'], ['uSwirl', 'garlic cloud'], ['uProgress', 'calamari'],
  ];
  const isPass = (label) => MARKERS.some(([, name]) => name === label);
  const TAGS = [['uBioStrength', 'biolum'], ['uNoiseStrength', 'noise'], ['uToon', 'toon'], ['uSway', 'sway'], ['boneTexture', 'skinned']];
  function labelOf(g, program) {
    let label = programLabels.get(program);
    if (label) return label;
    label = 'program';
    try {
      for (const sh of g.getAttachedShaders(program) ?? []) {
        if (g.getShaderParameter(sh, g.SHADER_TYPE) !== g.FRAGMENT_SHADER) continue;
        const src = g.getShaderSource(sh) ?? '';
        const m = MARKERS.find(([tok]) => src.includes(tok));
        if (m) label = m[1];
        else {
          const t = /#define SHADER_TYPE (\S+)/.exec(src);
          label = t ? t[1] : 'program';
          const tags = TAGS.filter(([tok]) => src.includes(tok)).map(([, n]) => n);
          if (tags.length) label += ` +${tags.join('+')}`;
        }
      }
    } catch { /* a program we cannot read stays "program" */ }
    programLabels.set(program, label);
    return label;
  }

  let curProgram = null;
  let curTarget = 'screen';
  let curViewport = '';
  let open = null;          // { q, stamp, key }
  let curStamp = -1;
  const pending = [];       // { q, stamp, key }
  const gpuByStamp = new Map();
  const perKey = new Map(); // key -> ms summed while recording
  const bucket = () => {
    const label = curProgram ? labelOf(gl, curProgram) : '—';
    return isPass(label) ? label : 'scene draws (creatures, props, effects)';
  };
  const keyNow = () => `${bucket()} @ ${curTarget}${curViewport ? ' ' + curViewport : ''}`;

  function closeQuery() {
    if (!open) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(open);
    open = null;
  }
  function openQuery() {
    if (!ext || !S.recording || curStamp < 0) return;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    open = { q, stamp: curStamp, key: keyNow() };
  }
  function reopen() { if (PASSES && open) { closeQuery(); openQuery(); } }

  function wrapPipeline(g) {
    const oUse = g.useProgram; const oBind = g.bindFramebuffer; const oView = g.viewport;
    g.useProgram = function (pr) {
      const r = oUse.call(this, pr);
      if (this === gl && pr !== curProgram) { const before = open ? open.key : null; curProgram = pr; if (open && keyNow() !== before) reopen(); }
      return r;
    };
    g.bindFramebuffer = function (target, fb) {
      const r = oBind.call(this, target, fb);
      if (this === gl) { curTarget = fb ? 'target' : 'screen'; }
      return r;
    };
    g.viewport = function (x, y, w, h) {
      const r = oView.call(this, x, y, w, h);
      if (this === gl) { const v = `${w}x${h}`; if (v !== curViewport) { curViewport = v; reopen(); } }
      return r;
    };
  }

  function pollQueries() {
    while (pending.length) {
      const { q, stamp, key } = pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gpuByStamp.set(stamp, (gpuByStamp.get(stamp) ?? 0) + ms);
        perKey.set(key, (perKey.get(key) ?? 0) + ms);
      }
      gl.deleteQuery(q);
      pending.shift();
    }
    const stamps = [...gpuByStamp.keys()].sort((a, b) => a - b);
    while (stamps.length > 2) {
      const st = stamps.shift();
      if (S.recording) S.gpu.push(gpuByStamp.get(st));
      gpuByStamp.delete(st);
    }
  }

  const nativeRAF = window.requestAnimationFrame.bind(window);
  let lastStamp = -1;
  let jsThisFrame = 0;
  window.requestAnimationFrame = (cb) => nativeRAF((stamp) => {
    if (stamp !== lastStamp) {
      if (S.recording && lastStamp >= 0) {
        S.frames.push(stamp - lastStamp);
        S.js.push(jsThisFrame);
        S.draws.push(drawsThisFrame);
      }
      lastStamp = stamp;
      jsThisFrame = 0;
      drawsThisFrame = 0;
    }
    curStamp = stamp;
    openQuery();
    const t0 = performance.now();
    try {
      cb(stamp);
    } finally {
      jsThisFrame += performance.now() - t0;
      closeQuery();
      if (ext) pollQueries();
    }
  });

  S.start = () => {
    pickContext();
    S.frames.length = S.js.length = S.gpu.length = S.draws.length = 0;
    perKey.clear();
    S.uploadsAtStart = { ...S.uploads };
    S.recording = true;
    return { ext: S.ext, canvas: gl ? [gl.canvas.width, gl.canvas.height] : null };
  };

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  };
  const stats = (arr) => ({
    n: arr.length,
    mean: arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null,
    p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99),
    max: arr.length ? +Math.max(...arr).toFixed(2) : null,
  });

  S.stop = () => {
    S.recording = false;
    const mem = performance.memory
      ? { heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) }
      : {};
    return {
      ext: S.ext,
      canvas: gl ? [gl.canvas.width, gl.canvas.height] : null,
      frame: stats(S.frames),
      hitches: S.frames.filter((f) => f > 33).length,
      js: stats(S.js),
      gpu: stats(S.gpu),
      draws: stats(S.draws),
      uploads: {
        count: S.uploads.count,
        MB: +(S.uploads.bytes / 1048576).toFixed(1),
        compressed: S.uploads.compressed,
        duringRun: S.uploadsAtStart ? S.uploads.count - S.uploadsAtStart.count : null,
        targets: S.uploads.targets,
        targetMB: +(S.uploads.targetBytes / 1048576).toFixed(1),
        reuploadMBPerFrame: S.frames.length ? +((S.uploads.reuploadBytes - (S.uploadsAtStart?.reuploadBytes ?? 0)) / 1048576 / S.frames.length).toFixed(2) : null,
      },
      cards: S.cards,
      // GPU ms per frame by program and target, biggest first.
      passes: S.gpu.length
        ? [...perKey.entries()].map(([key, ms]) => [key, +(ms / S.gpu.length).toFixed(3)]).sort((a, b) => b[1] - a[1])
        : [],
      meta: document.querySelector('.sv-t-meta')?.textContent ?? null,
      ...mem,
    };
  };
})();
