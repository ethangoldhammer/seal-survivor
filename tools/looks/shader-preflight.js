// ---------------------------------------------------------------------------
// SHADER PREFLIGHT — can this creature take the layer at all
//
//   npm run looks:preflight
//
// Run this BEFORE a shader-lab session, on the animals the session is for. The
// lab is a room full of live sliders; what it cannot tell you is that a slider
// is connected to nothing on THIS body. Every one of the failures below renders
// a perfectly plausible creature and silently ignores the control you are
// moving, so an hour goes into a look that was never reachable:
//
//   1. AN UNLIT MODEL CANNOT BAND. attachToonShade reads `reflectedLight`,
//      which only the lighting chunks declare, so it refuses the attach on a
//      MeshBasicMaterial. `modelUnlit: true` in ASSETS puts a body there — and
//      so does KHR_materials_unlit inside the .glb, which nothing in ASSETS
//      mentions. The lab says "unlit" once the model is on screen; this says it
//      before you pick the animal.
//
//   2. A PIGMENT IS MULTIPLIED BY WHATEVER THE BODY ALREADY IS. FRAG_SURFACE
//      writes `diffuseColor` at <map_fragment> — and three's own
//      <color_fragment>, which runs AFTER it, does `diffuseColor *= vColor`.
//      So on a body whose colour is baked into COLOR_0 rather than into a jpeg,
//      the pattern you paint is filtered through the animal's existing hide: a
//      white pigment on the sea turtle comes out turtle-brown, and no slider on
//      the page will move it. The material's own `diffuse` multiplies too —
//      that one is deliberate (it is how several species share one preset) but
//      it is the same trap when the factor is a saturated orange, which is
//      exactly what the untextured reef fish carry.
//
//   3. WIREFRAME NEEDS THE GEOMETRY SPLIT FIRST. `aBioEdge` is baked by
//      bakeEdges at attach time and only on non-indexed geometry; an indexed
//      body gets no attribute, the shader reads 0 at every fragment and its
//      guard draws NOTHING. That is a creature that vanishes, not one that
//      looks wrong. assets.js pays the split at load for anything declaring
//      `biolumEdges`; the lab now pays it too (see splitForEdges there).
//
// HOW IT DECIDES, and why it is not a screenshot diff against a golden file:
// every check is an A/B of the SAME body one setting apart, so it measures
// whether the control is connected rather than whether the result is pretty.
// Two renders, mean absolute difference over the pixels the animal covers. A
// connected control moves them; a dead one leaves them bit-identical. That is
// robust to the lighting rig, the model, and the size of the animal, and it
// needs no reference image to go stale.
//
// The colour tests A/B RED against GREEN rather than on/off, because "the
// pattern drew something" and "the pattern drew something YOU CHOSE" are
// different questions and only the second one matters when the body underneath
// is already coloured.
//
// IT WRITES NOTHING but the frames it posts to serve.mjs — a vite build with no
// dev server behind it and no save path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, ASSETS } from '../../path/src/assets.js';
import { attachBiolumSkin, applyBiolumSkinSettings, splitForEdges, BIOLUM_PATTERNS } from '../../path/src/systems/biolumSkin.js';
import { attachNoiseShader, applyNoiseSettings } from '../../path/src/systems/noiseShader.js';
import { attachToonShade, applyToonSettings } from '../../path/src/systems/toonShade.js';

const logEl = document.getElementById('log');
const sheetEl = document.getElementById('sheet');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};

const W = 300;
const H = 240;

// One WebGL context for the whole page — a renderer per cell goes black past a
// dozen panels and this sheet is three times that.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
gl.setPixelRatio(1);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

// A COMPILE FAILURE RENDERS NOTHING AND THROWS NOTHING. Every biolum creature in
// the ocean shares one program, so a pattern that fails to compile is not a
// wrong-looking fish — it is every glowing animal gone. three hands the log to
// this hook and then carries on, so it is the only place the page can see it.
const shaderErrors = [];
gl.debug.onShaderError = (ctx, program, vs, fs) => {
  shaderErrors.push([ctx.getShaderInfoLog(vs), ctx.getShaderInfoLog(fs)].filter(Boolean).join('\n').trim());
};

// DAYLIGHT, NOT THE ABYSS — the same rig as tools/looks/skins.js and the shader
// lab, so a number measured here means the same thing as a look judged there.
// Bands only exist where there is a gradient to band, and paint is only
// distinguishable from glow under a light.
const scene = new THREE.Scene();
const BG = 0x0a1420;
scene.background = new THREE.Color(BG);
scene.add(new THREE.AmbientLight(0xbcd8ff, 1.1));
const key = new THREE.DirectionalLight(0xfff4e0, 2.4);
key.position.set(4, 7, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fb4ff, 0.8);
rim.position.set(-5, 2, -4);
scene.add(rim);
const camera = new THREE.PerspectiveCamera(34, W / H, 0.05, 400);

await preloadAssets();

// ---------------------------------------------------------------------------
// THE ROSTER. The session this was written for is the beluga, the seagull, the
// sea turtle and the small reef fish — none of which has ever worn a surface,
// which is exactly why none of them has ever been checked. enemyGreatWhite is
// on the end as a CONTROL: it is textured, lit, white-diffused and carries no
// vertex colours, so it is the body every reach number below is read against.
// A reading that looks alarming on the turtle means nothing until you have seen
// what the same measurement does on an animal known to take paint.
// ---------------------------------------------------------------------------
const SUBJECTS = [
  ['belugaDrone', 'Beluga', 'beluga.fbx'],
  ['seagull', 'Seagull', 'seagull.fbx'],
  ['enemySeaTurtle', 'Sea turtle', 'seaturtle.glb'],
  ['enemyFishesA', 'Fishes A', 'fishes.glb'],
  ['enemyBrownFish', 'Brown fish', 'brownfish.glb'],
  ['enemyClownFish', 'Clown fish', 'clownfish.glb'],
  ['enemySurgeonFish', 'Surgeon fish', 'surgeonfish.glb'],
  ['enemyFishPackA', 'Fish pack A', 'fishpack.glb'],
  ['enemyTrout', 'Trout', 'trout.fbx'],
  ['enemyPuffer', 'Puffer', 'puffer.glb'],
  ['enemyGlowFishesA', 'Glow fishes A', 'fishes.glb — the night variant'],
  ['enemyGreatWhite', 'Great white', 'greatwhite.glb — the CONTROL'],
];

// ---------------------------------------------------------------------------
// Rendering and measuring
// ---------------------------------------------------------------------------
const meter = document.createElement('canvas');
meter.width = W;
meter.height = H;
const mctx = meter.getContext('2d', { willReadFrequently: true });

const bg = [(BG >> 16) & 255, (BG >> 8) & 255, BG & 255];

// The pixels the animal covers, as a mask, plus the frame's bytes. The
// background is one flat known colour and there is no post here, so "not the
// background" is an exact silhouette rather than a threshold that needs tuning.
function grab() {
  gl.render(scene, camera);
  mctx.drawImage(gl.domElement, 0, 0);
  const px = mctx.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  let n = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const off = Math.abs(px[p] - bg[0]) + Math.abs(px[p + 1] - bg[1]) + Math.abs(px[p + 2] - bg[2]);
    if (off > 6) { mask[i] = 1; n++; }
  }
  return { px, mask, n };
}

// MEAN ABSOLUTE DIFFERENCE OVER THE BODY, 0..255. Measured on the union of the
// two silhouettes so a setting that changes the outline (nothing here does, but
// a future one might) is not measured as a change in the background.
function delta(a, b) {
  let sum = 0, n = 0;
  for (let i = 0, p = 0; i < a.mask.length; i++, p += 4) {
    if (!a.mask[i] && !b.mask[i]) continue;
    sum += Math.abs(a.px[p] - b.px[p]) + Math.abs(a.px[p + 1] - b.px[p + 1]) + Math.abs(a.px[p + 2] - b.px[p + 2]);
    n += 3;
  }
  return n ? sum / n : 0;
}

// A control is CONNECTED if a full-swing change moves the body at all. 1.5/255
// is above the antialiasing noise of two renders of a static scene (which is
// zero here — nothing animates between grabs — but a margin costs nothing) and
// far below any change a person would call visible.
const BITES = 1.5;

// ---------------------------------------------------------------------------
// Building one subject the way the lab builds it
// ---------------------------------------------------------------------------
// Each subject gets preset names of its own in all three systems. The systems
// hold a module-level set of every material ever attached and re-stamp all of
// them on any apply(), so shared names would let subject 4's sliders repaint
// subject 2 — which would not be wrong on screen (subject 2 is long gone) but
// would make every number after it a measurement of two animals at once.
const presetFor = (key) => `__preflight_${key}`;

let subject = null;
const facts = [];

function frameSubject(visual) {
  const box = new THREE.Box3().setFromObject(visual);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.9;
  camera.position.set(centre.x + dist * 0.55, centre.y + dist * 0.35, centre.z + dist * 0.75);
  camera.lookAt(centre);
  camera.near = Math.max(0.01, dist * 0.02);
  camera.far = dist * 8;
  camera.updateProjectionMatrix();
  return size;
}

function build(key, { split = false } = {}) {
  if (subject) { scene.remove(subject); subject = null; }
  const visual = createVisual(key);
  if (!visual) return null;
  // Lay the body flat. createVisual points a creature forward at world +Y —
  // nose up — and a nose-up animal measured in a landscape frame is a sliver.
  visual.rotation.z = -Math.PI / 2;
  scene.add(visual);
  subject = visual;
  const size = frameSubject(visual);
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');

  // THE SPLIT, BEFORE THE ATTACH. attachBiolumSkin bakes its per-vertex
  // attributes off whatever geometry it finds, so splitting afterwards throws
  // them away — the same order assets.js uses at load.
  // AND CLEAR THE BAKE. attachBiolumSkin does aBioPos, aBioAxis and the edge
  // distances together inside one `if (!geom.attributes.aBioPos)`, and
  // `toNonIndexed` copies aBioPos onto the split geometry — so an asset already
  // baked (at load, if it ships a skin, or by this page's own first pass, since
  // clones share the asset's geometry) skips the bake and the split buys
  // nothing. This is the same clear the shader lab pays for the same reason.
  if (split) {
    splitForEdges(visual);
    visual.traverse((o) => {
      if (!o.geometry?.attributes?.aBioPos) return;
      o.geometry.deleteAttribute('aBioPos');
      o.geometry.deleteAttribute('aBioAxis');
    });
  }

  const f = {
    key, materials: 0, lit: 0, maps: 0, vertexColors: 0, morphs: 0, skinned: 0,
    indexed: 0, verts: 0, colors: new Set(), classes: new Set(), unlitMaterial: 0,
  };

  // CLONE FIRST, ATTACH SECOND, ALWAYS. createVisual hands back instances that
  // SHARE the asset's materials, so attaching in place would paint every other
  // creature made from the same asset — and Material.clone() drops
  // onBeforeCompile, so cloning after an attach silently throws the shader
  // away while leaving every "attached" flag standing. Clearing those flags and
  // restoring the original map is what makes the clone honest; the shader lab
  // does the identical dance and its header explains the bug it came from.
  visual.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.__isOutline) return;
    if (o.geometry) {
      f.verts += o.geometry.attributes?.position?.count ?? 0;
      if (o.geometry.index) f.indexed++;
      if (o.geometry.attributes?.color) f.vertexColors++;
      if (o.geometry.morphAttributes && Object.keys(o.geometry.morphAttributes).length) f.morphs++;
    }
    if (o.isSkinnedMesh) f.skinned++;
    const one = (m) => {
      const c = m.clone();
      for (const k of Object.keys(c.userData)) {
        if (/^__(bioSkin|noise|toon)/.test(k)) delete c.userData[k];
      }
      // Only if it is still a Texture: Material.copy() round-trips userData
      // through JSON, and THREE.Texture has a toJSON(), so a stashed texture
      // comes back as a DESCRIPTOR with no .matrix — assigning that as `map`
      // throws once per frame from inside the renderer.
      const orig = m.userData.__originalMap;
      if (orig?.isTexture) c.map = orig;
      if ('__originalColor' in m.userData && m.userData.__originalColor != null) {
        c.color.setHex(m.userData.__originalColor);
      }
      c.needsUpdate = true;
      f.materials++;
      if (c.map) f.maps++;
      if (c.isMeshBasicMaterial) f.unlitMaterial++;
      f.classes.add(c.type);
      if (c.vertexColors) f.vertexColors ||= 1;
      f.colors.add('#' + c.color.getHexString());
      // Order matches processMaterial in assets.js: noise, toon, then biolum.
      // All three chain onBeforeCompile; toonShade is the only one that
      // composes rather than assigns.
      attachNoiseShader(c, presetFor(key));
      attachToonShade(c, presetFor(key));
      attachBiolumSkin(c, o, presetFor(key), axis, null);
      if (c.userData.__toonAttached) f.lit++;
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });
  return f;
}

// ---------------------------------------------------------------------------
// The three preset blocks this page drives. Written into CONFIG under the
// subject's own name, so nothing shared is touched and nothing survives the
// page — there is no dev server behind this build and no save path, so CONFIG
// here is a scratch copy per SERVERS.md.
// ---------------------------------------------------------------------------
CONFIG.toonShade ??= {}; CONFIG.toonShade.presets ??= {};
CONFIG.sealShader ??= {}; CONFIG.sealShader.presets ??= {};
CONFIG.biolumSkin ??= {}; CONFIG.biolumSkin.presets ??= {};

function setToon(key, over) {
  CONFIG.toonShade.presets[presetFor(key)] = { enabled: true, strength: 1, steps: 4, low: 0.25, high: 1, gamma: 1, soft: 0, range: 1, ...over };
  applyToonSettings();
}
// `wet: 0` is not optional here. The wet film rides the same preset block and
// DEFAULTS TO 0.55, so a preset that omits it puts a rim, caustics and a gloss
// on the body — constant across an A/B, so it would not corrupt the delta, but
// it would put a film over every frame this page posts and make the paint look
// like something it is not. The key names are the shader's, not the panel's:
// `size` rather than scale, `baseColor` rather than base.
function setNoise(key, over) {
  CONFIG.sealShader.presets[presetFor(key)] = {
    enabled: true, paint: 1, paintGlow: 0, size: 0.4, strength: 1, contrast: 1.4,
    color: 0xff2ea6, baseColor: 0x101820, wet: 0, ...over,
  };
  applyNoiseSettings();
}
// `luminous: false`, `strength: 0` and both breath amplitudes at 0 — a pigment
// preset that forgets any of them is a daylight animal the night gate reads as
// an emitter, which is how two shipped presets got there. See the header of
// systems/biolumSkin.js and npm run test:glowphase.
function setBio(key, over) {
  CONFIG.biolumSkin.presets[presetFor(key)] = {
    enabled: true, luminous: false, pigment: 1, pigmentGlow: 0, strength: 0, glow: 0,
    pulseAmp: 0, schoolAmp: 0, flow: 0, pattern: 'blotches', scale: 0.18,
    contrast: 1.6, coverage: 0.5, bodyDarken: 1,
    colorA: 0xff0000, colorB: 0xff0000, colorC: 0xff0000, shellColor: 0xff0000, ...over,
  };
  applyBiolumSkinSettings();
}
const allOff = (key) => {
  setToon(key, { enabled: false, strength: 0 });
  setNoise(key, { enabled: false, paint: 0, strength: 0 });
  setBio(key, { enabled: false, pigment: 0 });
};

const RED = { colorA: 0xff0000, colorB: 0xff0000, colorC: 0xff0000, shellColor: 0xff0000 };
const GREEN = { colorA: 0x00ff00, colorB: 0x00ff00, colorC: 0x00ff00, shellColor: 0x00ff00 };
// One colour per band, maximally separated, for asking whether a PATTERN drew
// anything: A/B the three feature colours while the space between them stays
// put, so a pattern that renders nothing leaves two identical frames.
const PAT_A = { colorA: 0xff0000, colorB: 0x00ff00, colorC: 0x0000ff, shellColor: 0x000000 };
const PAT_B = { colorA: 0x00ff00, colorB: 0x0000ff, colorC: 0xff0000, shellColor: 0x000000 };

// ---------------------------------------------------------------------------
// Frames, posted to serve.mjs — the Browser pane's own screenshot goes blank on
// a tall contact sheet, so each cell is read off disk instead.
// ---------------------------------------------------------------------------
let shotIndex = 0;
const posted = [];
function cell(title, caption) {
  const wrap = document.createElement('div');
  wrap.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  wrap.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = caption;
  wrap.appendChild(cap);
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((b) => fetch(`/shot/${name}`, { method: 'POST', body: b }).then(done, done), 'image/png')));
  return wrap;
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------
const results = [];

for (const [key, title, note] of SUBJECTS) {
  if (!ASSETS[key]) { log(`FAIL ${title} — no asset named ${key}`, 'bad'); continue; }
  shaderErrors.length = 0;
  const f = build(key);
  if (!f) { log(`FAIL ${title} — createVisual returned nothing`, 'bad'); continue; }

  allOff(key);
  const shipped = grab();
  const sheetRow = document.createElement('div');
  sheetRow.className = 'row';
  sheetRow.appendChild(cell(`${key}-shipped`, `<b>${title}</b> as shipped`));

  // --- 1. banding -----------------------------------------------------------
  setToon(key, { strength: 0 });
  const toon0 = grab();
  // A SWEEP, NOT ONE GUESS, and the control is why. `range` is what counts as
  // fully lit, in light units — at 1 against this rig's key the whole body sits
  // at the top of the ramp, every fragment lands in the same band, and the
  // banded result is very close to the unbanded one. Measured that way the
  // great white — an animal shipping `toon:greatWhite` — read 1.1 and failed
  // its own test. So the question "is this control connected" is asked at
  // several ramp widths and answered by the largest swing any of them produces.
  let toonD = 0;
  for (const range of [1, 2.5, 5]) {
    setToon(key, { strength: 1, steps: 2, gamma: 1, low: 0.15, range });
    toonD = Math.max(toonD, delta(toon0, grab()));
  }
  setToon(key, { enabled: false, strength: 0 });

  // --- 2. the noise coat ----------------------------------------------------
  setNoise(key, { paint: 0 });
  const noise0 = grab();
  setNoise(key, { paint: 1 });
  const noiseD = delta(noise0, grab());
  setNoise(key, { enabled: false, paint: 0, strength: 0 });

  // --- 3. does a pigment cover this body ------------------------------------
  setBio(key, { pigment: 0 });
  const pig0 = grab();
  setBio(key, { pigment: 1 });
  const pigD = delta(pig0, grab());

  // --- 4. ...and does it arrive in the COLOUR you asked for -----------------
  // The one that separates "the layer is attached" from "the layer is in
  // charge". Full red against full green, pattern and space alike, so the only
  // thing between the number you typed and the pixel is whatever the body is
  // already multiplying it by.
  setBio(key, { pigment: 1, ...RED });
  const red = grab();
  setBio(key, { pigment: 1, ...GREEN });
  const reach = delta(red, grab());

  sheetRow.appendChild(cell(`${key}-pigment`, `<b>${title}</b> pigment 1, green — reach ${reach.toFixed(1)}`));

  // --- 5. every pattern, including the two that need something of the mesh --
  const patterns = {};
  for (const p of BIOLUM_PATTERNS) {
    setBio(key, { pigment: 1, pattern: p, ...PAT_A });
    const a = grab();
    setBio(key, { pigment: 1, pattern: p, ...PAT_B });
    patterns[p] = delta(a, grab());
  }

  // --- 6. wireframe again, on split geometry -------------------------------
  // The same measurement after the split assets.js pays at load for anything
  // declaring `biolumEdges`. If this moves and the one above did not, the
  // pattern is fine and the geometry was the whole problem.
  // SWEPT ON `coverage`, because two separate things can make this read zero
  // and only one of them is the geometry. `coverage` IS the line width here —
  // `width = max(0.0004, coverage * 0.0025)`, in fractions of the body's
  // longest side — so at the slider's own maximum of 1 the line is 1/400th of
  // the animal, which on a creature 200 pixels tall is half a pixel. A working
  // wireframe measured at coverage 0.5 is indistinguishable from a dead one.
  // The sweep runs past the slider's range on purpose: the number that first
  // makes a line visible is the answer to "what does this control need to be",
  // and it is not a number the panel can currently reach.
  const fSplit = build(key, { split: true });
  let wireSplit = 0;
  let wireAt = 0;
  for (const coverage of [0.5, 4, 20, 100]) {
    setBio(key, { pigment: 1, pattern: 'wireframe', coverage, ...PAT_A });
    const wa = grab();
    setBio(key, { pigment: 1, pattern: 'wireframe', coverage, ...PAT_B });
    const d = delta(wa, grab());
    if (d > wireSplit) { wireSplit = d; wireAt = coverage; }
  }
  sheetRow.appendChild(cell(`${key}-wireframe`, `<b>${title}</b> wireframe on split geometry — ${wireSplit.toFixed(1)}`));

  results.push({
    key, title, note, f, toonD, noiseD, pigD, reach, patterns, wireSplit, wireAt,
    verts: fSplit ? fSplit.verts : f.verts,
    errors: shaderErrors.slice(),
  });

  const h = document.createElement('h2');
  h.innerHTML = `${title} <span>${note}</span>`;
  sheetEl.appendChild(h);
  sheetEl.appendChild(sheetRow);
  log(`${title}: toon ${toonD.toFixed(1)} · noise ${noiseD.toFixed(1)} · pigment ${pigD.toFixed(1)} · reach ${reach.toFixed(1)}`, 'dim');
}

if (subject) scene.remove(subject);

// ---------------------------------------------------------------------------
// The verdict table
// ---------------------------------------------------------------------------
const control = results.find((r) => r.key === 'enemyGreatWhite');
const ctlReach = control?.reach ?? 0;

function table(cols, rows) {
  const t = document.createElement('table');
  t.innerHTML = `<tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`
    + rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return t;
}
const mark = (ok, text) => `<span class="${ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'bad'}">${text}</span>`;

const head = document.createElement('h2');
head.innerHTML = 'Verdict <span>can this body take this layer at all</span>';
logEl.appendChild(head);

logEl.appendChild(table(
  ['creature', 'materials', 'banding', 'noise coat', 'pigment', 'colour reach', 'wireframe'],
  results.map((r) => {
    const pctReach = ctlReach > 0 ? r.reach / ctlReach : 0;
    return [
      `${r.title} <span class="dim">${r.key}</span>`,
      `${r.f.materials} × ${[...r.f.classes].join('/')} · ${r.f.lit} banded`
        + `${r.f.maps ? ` · ${r.f.maps} mapped` : ' · <span class="warn">no map</span>'}`
        + `${r.f.vertexColors ? ' · <span class="warn">vertex colours</span>' : ''}`,
      r.f.lit === 0 ? mark(false, 'REFUSED — attachToonShade') : mark(r.toonD > BITES, r.toonD.toFixed(1)),
      mark(r.noiseD > BITES, r.noiseD.toFixed(1)),
      mark(r.pigD > BITES, r.pigD.toFixed(1)),
      mark(pctReach > 0.6 ? true : pctReach > 0.25 ? 'warn' : false,
        `${r.reach.toFixed(1)} · ${(pctReach * 100).toFixed(0)}% of control`),
      r.patterns.wireframe > BITES
        ? mark(true, 'draws')
        : r.wireSplit > BITES
          ? mark('warn', `split + coverage ${r.wireAt} (${r.wireSplit.toFixed(1)})`)
          : mark(false, 'DEAD even split'),
    ];
  }),
));

const patHead = document.createElement('h2');
patHead.innerHTML = 'Patterns <span>colour A/B swing per pattern — 0 is a pattern that drew nothing</span>';
logEl.appendChild(patHead);
logEl.appendChild(table(
  ['creature', ...BIOLUM_PATTERNS],
  results.map((r) => [r.title, ...BIOLUM_PATTERNS.map((p) => mark(r.patterns[p] > BITES, r.patterns[p].toFixed(1)))]),
));

const bad = results.filter((r) => r.errors.length);
if (bad.length) {
  log('', 'dim');
  for (const r of bad) log(`SHADER ERROR on ${r.title}: ${r.errors.join(' | ')}`, 'bad');
} else {
  log('');
  log('ok   every layer compiled on every subject — no shader errors', 'ok');
}

await Promise.all(posted);
log(`${shotIndex} frames posted`, 'dim');
window.__preflight = results;
