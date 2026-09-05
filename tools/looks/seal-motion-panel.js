// ---------------------------------------------------------------------------
// THE SEAL MOTION PANEL — writing the free swimmer's loops, on the real screen.
//
// Mounted into the level-up look page (level-up.js) once the seal is built.
// Four states, each a looping timeline of keyframes (see the header of
// systems/levelUpSealMotion.js for what a keyframe holds); this panel edits
// the live data the puppet reads on its next frame, so every change is seen
// as it is made, against the real cards at the real layout.
//
//   STATE TABS      idle / card 1 / card 2 / card 3. Picking a tab PINS the
//                   puppet to that loop at the scrub time, so the loop can be
//                   read on its own. `Live` releases the pin: the seal then
//                   follows your real hovers, crossfades and all, which is
//                   the only honest way to judge the blend.
//   THE TIMELINE    a strip the length of the loop. Diamonds are keys; drag
//                   one along to move it in time, click it to select it,
//                   click empty strip to add a key THERE (as the pose the
//                   loop already has at that moment, so a new key changes
//                   nothing until you move it). Play runs the loop.
//   THE HANDLES     drawn over the screen for the selected key: the seal's
//                   centre (drag it — x and y), the head's target (eye) and
//                   the two flipper targets (L, R). Dragging a target moves
//                   its OFFSET from its anchor; a `none` target dragged
//                   becomes `free` at that point.
//   THE FIELDS      everything the handles can't say: heading, roll, ease,
//                   each target's anchor and strength, the loop's length.
//   SAVE            writes path/src/levelUpSealMotion.json through the
//                   serve's /motion/ route — the file the game imports, so
//                   what is on this screen is what ships. Reload reads it
//                   back; Reset discards to what was loaded.
// ---------------------------------------------------------------------------
import {
  motionData, setMotionData, clone, evaluateState, STATES, ANCHORS, EASES,
} from '../../path/src/systems/levelUpSealMotion.js';

const LABEL = { idle: 'idle', card1: 'card 1', card2: 'card 2', card3: 'card 3' };

// POINTERUP, NOT CLICK, on every button here. level-up.js swallows every
// `click` inside the panel at window capture (see the note there: it has to,
// to keep a click on a slider from skipping the arrival) and does the page's
// own buttons' work by id. Pointer events are not swallowed, and the click
// that follows a pointerup is — so a button here fires once and skips nothing.
const PRESS = 'pointerup';

export function mountSealMotionPanel({ panel, getLive }) {
  let state = 'idle';
  let sel = 0;          // selected key index
  let t = 0;            // scrub time, seconds into the loop
  let live = false;     // true: the pin is released and real hovers drive it
  let playing = false;
  let loaded = clone(motionData());

  const puppet = () => getLive()?.puppet ?? null;
  const st = () => motionData().states[state];
  const key = () => st()?.keys?.[sel] ?? null;
  const loopLen = () => Math.max(0.05, st()?.loop ?? 1);

  // --- the panel -------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'sealMotion';
  root.innerHTML = `
    <hr>
    <h2>Seal motion</h2>
    <div class="btns" id="smTabs"></div>
    <div class="btns">
      <button id="smLive" aria-pressed="false">Live</button>
      <button id="smPlay" aria-pressed="false">Play</button>
      <label class="sm-inline">loop <input id="smLoop" type="number" min="0.1" step="0.1" style="width:56px"> s</label>
      <label class="sm-inline"><input id="smRestart" type="checkbox"> restart on hover</label>
    </div>
    <div id="smStrip" title="click: add a key here · drag a diamond: move it"></div>
    <div class="row"><label>time</label><input id="smT" type="range" min="0" max="1" step="0.001"><output id="smTOut"></output></div>
    <div class="btns">
      <button id="smDup">Duplicate key</button>
      <button id="smDel">Delete key</button>
      <button id="smSave">Save to game</button>
      <button id="smReload">Reload</button>
      <button id="smReset">Reset</button>
    </div>
    <div id="smKey"></div>
    <div id="smNote"></div>
  `;
  panel.appendChild(root);
  const $ = (id) => root.querySelector(`#${id}`);
  const tabs = $('smTabs');
  const strip = $('smStrip');
  const tSlider = $('smT');
  const tOut = $('smTOut');
  const keyBox = $('smKey');
  const note = $('smNote');

  function say(msg) { note.textContent = msg; }

  // --- tabs ------------------------------------------------------------------
  function buildTabs() {
    tabs.innerHTML = '';
    for (const s of STATES) {
      const b = document.createElement('button');
      b.textContent = LABEL[s];
      b.setAttribute('aria-pressed', String(s === state && !live));
      b.addEventListener(PRESS, () => { state = s; sel = 0; t = 0; live = false; sync(); });
      tabs.appendChild(b);
    }
  }

  // --- the timeline strip ----------------------------------------------------
  let dragKey = -1;
  function buildStrip() {
    strip.innerHTML = '';
    const keys = st()?.keys ?? [];
    keys.forEach((k, i) => {
      const d = document.createElement('div');
      d.className = 'sm-key' + (i === sel ? ' sel' : '');
      d.style.left = `${(k.t / loopLen()) * 100}%`;
      d.title = `${k.t.toFixed(2)}s`;
      d.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        sel = i; dragKey = i; t = k.t;
        d.setPointerCapture(e.pointerId);
        sync();
      });
      d.addEventListener('pointermove', (e) => {
        if (dragKey !== i) return;
        const r = strip.getBoundingClientRect();
        const u = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
        k.t = Math.round(u * loopLen() * 100) / 100;
        t = k.t;
        sortKeys();
        sync();
      });
      d.addEventListener('pointerup', () => { dragKey = -1; });
      strip.appendChild(d);
    });
    const head = document.createElement('div');
    head.className = 'sm-head';
    head.style.left = `${(t / loopLen()) * 100}%`;
    strip.appendChild(head);
  }
  strip.addEventListener('pointerdown', (e) => {
    const r = strip.getBoundingClientRect();
    const u = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
    addKeyAt(Math.round(u * loopLen() * 100) / 100);
  });

  // Keys stay in time order; the selected one follows its key.
  function sortKeys() {
    const keys = st().keys;
    const k = keys[sel];
    keys.sort((a, b) => a.t - b.t);
    sel = keys.indexOf(k);
  }

  // A new key AS THE LOOP ALREADY IS at that moment, in the loop's own
  // authored units — so adding one changes nothing until it is moved.
  function addKeyAt(at) {
    const s = st();
    if (!s) return;
    const keys = s.keys;
    const p = puppet();
    const frame = p?.frame ?? { w: innerWidth, h: innerHeight };
    const resolve = p?.resolveAnchor ?? (() => null);
    const ev = keys.length ? evaluateState(s, at, resolve, frame) : null;
    // The targets are copied from the key before this time (a resolved
    // point cannot be turned back into an anchor + offset).
    let before = keys.length - 1;
    for (let i = 0; i < keys.length; i++) if (keys[i].t <= at) before = i;
    const base = keys[before] ?? blankKey();
    const k = clone(base);
    k.t = at;
    if (ev) { k.x = ev.x / frame.w; k.y = ev.y; k.heading = ev.heading; k.roll = ev.roll; }
    keys.push(k);
    keys.sort((a, b) => a.t - b.t);
    sel = keys.indexOf(k);
    t = at;
    sync();
  }
  function blankKey() {
    return {
      t: 0, ease: 'smoothstep', x: 0.5, y: 0.05, heading: 0, roll: 0,
      look: { anchor: 'cursor', x: 0, y: 0, out: 1 },
      fins: { left: { anchor: 'none', x: 0, y: 0, w: 0 }, right: { anchor: 'none', x: 0, y: 0, w: 0 } },
    };
  }

  // --- the selected key's fields --------------------------------------------
  function slider(label, get, set, min, max, step) {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label'); l.textContent = label;
    const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = get();
    const o = document.createElement('output'); o.textContent = Number(get()).toFixed(2);
    r.addEventListener('input', () => { set(Number(r.value)); o.textContent = Number(r.value).toFixed(2); drawOverlay(); refreshStrip(); });
    row.append(l, r, o);
    return row;
  }
  function select(label, options, get, set) {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label'); l.textContent = label;
    const s = document.createElement('select');
    for (const o of options) { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); }
    s.value = get();
    s.addEventListener('change', () => { set(s.value); buildKeyBox(); drawOverlay(); });
    row.append(l, s);
    return row;
  }
  function targetRows(title, tg, strengthKey) {
    const h = document.createElement('h3'); h.textContent = title;
    return [
      h,
      select('anchor', ANCHORS, () => tg.anchor, (v) => { tg.anchor = v; }),
      slider(strengthKey === 'out' ? 'look out' : 'points', () => tg[strengthKey] ?? 0, (v) => { tg[strengthKey] = v; }, 0, 1, 0.01),
      slider('offset x', () => tg.x ?? 0, (v) => { tg.x = v; }, -0.6, 0.6, 0.005),
      slider('offset y', () => tg.y ?? 0, (v) => { tg.y = v; }, -0.6, 0.6, 0.005),
    ];
  }
  function buildKeyBox() {
    keyBox.innerHTML = '';
    const k = key();
    if (!k) { keyBox.textContent = 'no keys — click the strip to add one'; return; }
    k.look ??= { anchor: 'none', x: 0, y: 0, out: 0 };
    k.fins ??= {};
    k.fins.left ??= { anchor: 'none', x: 0, y: 0, w: 0 };
    k.fins.right ??= { anchor: 'none', x: 0, y: 0, w: 0 };
    const h = document.createElement('h3');
    h.textContent = `key ${sel + 1} of ${st().keys.length} — ${k.t.toFixed(2)}s`;
    keyBox.append(
      h,
      select('ease to next', EASES, () => k.ease ?? 'smoothstep', (v) => { k.ease = v; }),
      slider('x (of width)', () => k.x, (v) => { k.x = v; }, 0, 1, 0.005),
      slider('y (lengths below row)', () => k.y, (v) => { k.y = v; }, -1.5, 1.5, 0.01),
      slider('heading', () => k.heading ?? 0, (v) => { k.heading = v; }, -Math.PI, Math.PI, 0.01),
      slider('roll', () => k.roll ?? 0, (v) => { k.roll = v; }, -Math.PI, Math.PI, 0.01),
      ...targetRows('look', k.look, 'out'),
      ...targetRows('left flipper', k.fins.left, 'w'),
      ...targetRows('right flipper', k.fins.right, 'w'),
    );
  }

  // --- the overlay -----------------------------------------------------------
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'smOverlay';
  document.body.appendChild(svg);
  const handles = {};
  function handle(name, text) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('sm-handle');
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', name === 'centre' ? 14 : 10);
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    l.textContent = text;
    l.setAttribute('text-anchor', 'middle'); l.setAttribute('dy', '4');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.classList.add('sm-line');
    svg.append(line, g);
    g.append(c, l);
    handles[name] = { g, line };
    let dragging = false;
    g.addEventListener('pointerdown', (e) => { dragging = true; g.setPointerCapture(e.pointerId); e.stopPropagation(); });
    g.addEventListener('pointerup', () => { dragging = false; });
    g.addEventListener('pointermove', (e) => { if (dragging) dragHandle(name, e.clientX, e.clientY); });
    return g;
  }
  handle('centre', '');
  handle('look', '👁');
  handle('left', 'L');
  handle('right', 'R');

  function place(name, x, y, fromX, fromY, on = true) {
    const h = handles[name];
    h.g.style.display = on ? '' : 'none';
    h.line.style.display = on && fromX != null ? '' : 'none';
    if (!on) return;
    h.g.setAttribute('transform', `translate(${x} ${y})`);
    if (fromX != null) {
      h.line.setAttribute('x1', fromX); h.line.setAttribute('y1', fromY);
      h.line.setAttribute('x2', x); h.line.setAttribute('y2', y);
    }
  }

  // The overlay is drawn from the KEY, not the blended frame: the key is
  // what is being edited, and the puppet is pinned to it while a tab is up.
  function drawOverlay() {
    const p = puppet();
    const k = key();
    if (!p || !k || live) { for (const n in handles) place(n, 0, 0, null, null, false); return; }
    const frame = p.frame;
    const m = p.metrics();
    const cx = k.x * frame.w;
    const cy = m.crownLine + k.y * m.unit + m.centreOffset;
    place('centre', cx, cy, null, null, true);
    const targ = (tg) => {
      if (!tg || tg.anchor === 'none') return null;
      const dx = (tg.x ?? 0) * frame.w; const dy = (tg.y ?? 0) * frame.h;
      if (tg.anchor === 'free') return { x: dx, y: dy };
      const a = p.resolveAnchor(tg.anchor);
      return a ? { x: a.x + dx, y: a.y + dy } : null;
    };
    const lk = targ(k.look);
    place('look', lk?.x ?? 0, lk?.y ?? 0, cx, cy, !!lk);
    const lf = targ(k.fins?.left);
    place('left', lf?.x ?? 0, lf?.y ?? 0, cx, cy, !!lf);
    const rf = targ(k.fins?.right);
    place('right', rf?.x ?? 0, rf?.y ?? 0, cx, cy, !!rf);
  }

  function dragHandle(name, px, py) {
    const p = puppet();
    const k = key();
    if (!p || !k) return;
    const frame = p.frame;
    const m = p.metrics();
    if (name === 'centre') {
      k.x = Math.max(0, Math.min(1, px / frame.w));
      k.y = (py - m.crownLine - m.centreOffset) / m.unit;
    } else {
      const tg = name === 'look' ? k.look : k.fins[name];
      if (tg.anchor === 'none') { tg.anchor = 'free'; if (name === 'look') tg.out ??= 1; else tg.w ??= 1; }
      if (tg.anchor === 'free') { tg.x = px / frame.w; tg.y = py / frame.h; } else {
        const a = p.resolveAnchor(tg.anchor);
        if (a) { tg.x = (px - a.x) / frame.w; tg.y = (py - a.y) / frame.h; }
      }
    }
    buildKeyBox();
    drawOverlay();
  }

  // --- the clock -------------------------------------------------------------
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const p = puppet();
    if (!p) return;
    if (live) { p.motion.pin(null); return; }
    if (playing) { t = (t + dt) % loopLen(); refreshStrip(); }
    p.motion.pin({ state, t });
    drawOverlay();
  }, 16);

  // --- buttons ---------------------------------------------------------------
  $('smLive').addEventListener(PRESS, () => { live = !live; sync(); });
  $('smPlay').addEventListener(PRESS, () => { playing = !playing; $('smPlay').setAttribute('aria-pressed', String(playing)); });
  $('smLoop').addEventListener('change', (e) => { st().loop = Math.max(0.1, Number(e.target.value) || 1); for (const k of st().keys) k.t = Math.min(k.t, st().loop - 0.01); sync(); });
  $('smRestart').addEventListener('change', (e) => { st().restart = e.target.checked; });
  tSlider.addEventListener('input', () => { t = Number(tSlider.value) * loopLen(); playing = false; $('smPlay').setAttribute('aria-pressed', 'false'); refreshStrip(); });
  $('smDup').addEventListener(PRESS, () => {
    const k = key(); if (!k) return;
    const c = clone(k); c.t = Math.min(loopLen() - 0.01, k.t + 0.25);
    st().keys.push(c); st().keys.sort((a, b) => a.t - b.t); sel = st().keys.indexOf(c); t = c.t; sync();
  });
  $('smDel').addEventListener(PRESS, () => {
    const keys = st().keys; if (keys.length <= 1) { say('a loop keeps at least one key'); return; }
    keys.splice(sel, 1); sel = Math.max(0, sel - 1); sync();
  });
  $('smSave').addEventListener(PRESS, async () => {
    try {
      const r = await fetch('/motion/levelUpSealMotion.json', { method: 'POST', body: JSON.stringify(motionData()) });
      if (!r.ok) throw new Error(await r.text());
      loaded = clone(motionData());
      say(`saved path/src/levelUpSealMotion.json ${new Date().toLocaleTimeString()}`);
    } catch (err) { say(`save failed: ${err.message}`); }
  });
  $('smReload').addEventListener(PRESS, async () => {
    try {
      const d = await (await fetch('/motion/levelUpSealMotion.json')).json();
      if (!d.states) throw new Error('no states in the file');
      setMotionData(d); loaded = clone(d); sel = 0; sync(); say('reloaded from disk');
    } catch (err) { say(`reload failed: ${err.message}`); }
  });
  $('smReset').addEventListener(PRESS, () => { setMotionData(loaded); sel = 0; sync(); say('back to what was loaded'); });

  function refreshStrip() {
    tSlider.value = t / loopLen();
    tOut.textContent = `${t.toFixed(2)}s`;
    buildStrip();
  }
  function sync() {
    buildTabs();
    $('smLive').setAttribute('aria-pressed', String(live));
    $('smLoop').value = loopLen();
    $('smRestart').checked = !!st()?.restart;
    sel = Math.max(0, Math.min(sel, (st()?.keys?.length ?? 1) - 1));
    refreshStrip();
    buildKeyBox();
    drawOverlay();
  }
  sync();
  say('pinned to a loop — Live to feel the blend');
  return { sync };
}
