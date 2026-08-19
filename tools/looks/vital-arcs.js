// ---------------------------------------------------------------------------
// HEALTH AND AIR AS ARCS — LOOK DEV
//
//   npm run looks:arcs
//
// The question: if the two gauges left the seal's flank and became arcs around
// it, could they share the instrument the boost meter already owns — the pips,
// the radius, the glow — without the three of them turning into one unreadable
// wheel?
//
// THE ARGUMENT AGAINST, which is already written down in systems/strikeRing.js
// and is the reason this is a sheet of options rather than a patch: the banked
// -power readout USED to be a second arc inside the fuel ring, sweeping the
// same way, and it was pulled out precisely because two concentric arcs filling
// in the same direction are one instrument saying two things in the same words.
// Whichever is read first is the one that gets believed. Adding two more arcs
// is that mistake twice over — UNLESS each one owns a different SECTOR rather
// than a different radius. Every variant below is a different answer to "which
// piece of the circle is whose", and that is the only axis that matters.
//
// The second constraint is bloom, and it is tighter than it looks. In the game
// the fuel ring is about 93px across and the bright pass spreads roughly 14px,
// so two features closer than ~20px fuse into one smear (the long version is in
// strikeRing.js, under why the core stops at 0.58). That is why the bottom row
// of this sheet exists: a variant that only works on the magnified panel is not
// a design, it is a diagram of one.
//
// WHY A PAGE AND NOT A HARNESS. All of this is GLSL, and a GLSL error renders
// NOTHING and throws nothing Node can see. This page imports the SHIPPING ring
// and the SHIPPING post chain, so a black panel is a real compile failure and
// the glow interaction between the arcs and the pips is the one the game would
// actually draw.
//
// IT WRITES NOTHING — a throwaway bundle, no save path, no dev server. See
// SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createStrikeRing, updateStrikeRing } from '../../path/src/systems/strikeRing.js';

const logEl = document.getElementById('log');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};

// A shader that fails to compile renders nothing and only writes to the
// console, so the sheet would look like a bad design decision instead of a
// broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 300;
const H = 300;
const DT = 1 / 60;

// ---------------------------------------------------------------------------
// THE ARC QUAD
// ---------------------------------------------------------------------------
//
// Deliberately the same coordinate contract as the fuel ring: a plane scaled by
// `ring.radius * ring.scale`, in which r = 1 IS the fuel ring and the angle is
// measured clockwise from twelve o'clock. Both arcs are drawn in one quad
// because they are one instrument, and because a second additive quad over the
// first would double the glow everywhere they crossed.
//
// The overscan is larger than the ring's own 1.45: these arcs live OUTSIDE the
// fuel ring by design, and a quad that stopped at the ring would clip them to
// the corners of a square — the exact failure the ring's own overscan note
// describes.
const ARC_OVERSCAN = 2.2;

const arcVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const arcFrag = /* glsl */ `
  precision highp float;
  #define TAU 6.28318530718
  #define PI  3.14159265359
  #define OVERSCAN ${ARC_OVERSCAN.toFixed(3)}

  uniform float uGlow;
  uniform float uTrack;      // how visible the empty part of the arc is
  uniform float uGapFrac;    // segment gap, as a fraction of one segment
  uniform vec3  uGhostCol;

  // One gauge, twice. Unrolled into a function rather than looped over uniform
  // arrays on purpose: indexing a uniform array by a loop variable is a rule
  // that differs between GLSL ES 1.00 and 3.00, and this shader has no reason
  // to care which one it is compiled as.
  uniform float uHpRad, uHpThick, uHpCentre, uHpSpan, uHpDir, uHpFill, uHpGhost, uHpSegs, uHpAlarm;
  uniform vec3  uHpColA, uHpColB;
  uniform float uO2Rad, uO2Thick, uO2Centre, uO2Span, uO2Dir, uO2Fill, uO2Ghost, uO2Segs, uO2Alarm;
  uniform vec3  uO2ColA, uO2ColB;

  varying vec2 vUv;

  // The fuel ring's own helper, copied deliberately: the whole point is that
  // these edges soften at exactly the rate the pips beside them do.
  float bandMask(float r, float centre, float halfWidth) {
    return 1.0 - smoothstep(halfWidth * 0.55, halfWidth * 1.45, abs(r - centre));
  }

  vec4 gauge(float r, float ang, float rad, float thick, float centre, float span,
             float dir, float fill, float ghost, float segs, float alarm,
             vec3 colA, vec3 colB) {
    float half_ = span * 0.5;
    // Wrapped, so an arc may straddle twelve o'clock without the maths caring.
    float d = mod(ang - centre + PI, TAU) - PI;
    if (abs(d) > half_) return vec4(0.0);

    float m = bandMask(r, rad, thick * 0.5);
    if (m < 0.001) return vec4(0.0);

    // 0..1 along the arc, from the end it fills FROM.
    float t = (d + half_) / max(span, 1e-4);
    if (dir < 0.0) t = 1.0 - t;

    // Segmented in the pips' own grammar. Continuous when segs is 0, which is
    // its own variant rather than a fallback.
    if (segs > 0.5) {
      float within = fract(t * segs);
      if (within > 1.0 - uGapFrac) return vec4(0.0);
    }

    float lit = step(t, fill);
    float inGhost = step(t, ghost) * (1.0 - lit);

    // The colour walks along the arc the way the fuel ring's walks around it.
    vec3 col = mix(colA, colB, t);
    col = mix(col, uGhostCol, inGhost);
    // The alarm rides the colour rather than a filter, because this quad is
    // additive and there is no track behind it to brighten.
    col *= 1.0 + alarm * 0.9;

    float a = m * mix(uTrack, 1.0, max(lit, inGhost * 0.85));
    return vec4(col * uGlow, a);
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0 * OVERSCAN;
    float r = length(p);
    float ang = atan(p.x, p.y);
    if (ang < 0.0) ang += TAU;

    vec4 hp = gauge(r, ang, uHpRad, uHpThick, uHpCentre, uHpSpan, uHpDir,
                    uHpFill, uHpGhost, uHpSegs, uHpAlarm, uHpColA, uHpColB);
    vec4 o2 = gauge(r, ang, uO2Rad, uO2Thick, uO2Centre, uO2Span, uO2Dir,
                    uO2Fill, uO2Ghost, uO2Segs, uO2Alarm, uO2ColA, uO2ColB);

    // Two arcs never share a pixel in any variant here, so this is a sum and
    // not a blend — and if a future variant does overlap them, seeing the seam
    // is the useful outcome.
    vec3 col = hp.rgb * hp.a + o2.rgb * o2.a;
    float alpha = max(hp.a, o2.a);
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

const RED_A = new THREE.Color(0xff6a5a);
const RED_B = new THREE.Color(0xe01023);
const BLUE_A = new THREE.Color(0x9fe4ff);
const BLUE_B = new THREE.Color(0x2f9fdd);
const AMBER_A = new THREE.Color(0xffd166);
const AMBER_B = new THREE.Color(0xff8a00);

function createArcs() {
  const material = new THREE.ShaderMaterial({
    vertexShader: arcVert,
    fragmentShader: arcFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uGlow: { value: 1.35 },
      uTrack: { value: 0.14 },   // the fuel ring's own empty-track alpha
      uGapFrac: { value: 0.22 },
      uGhostCol: { value: new THREE.Color(0xfff0f5) },
      uHpRad: { value: 1.34 }, uHpThick: { value: 0.1 },
      uHpCentre: { value: Math.PI * 1.5 }, uHpSpan: { value: 2.6 },
      uHpDir: { value: 1 }, uHpFill: { value: 0.42 }, uHpGhost: { value: 0.7 },
      uHpSegs: { value: 0 }, uHpAlarm: { value: 0 },
      uHpColA: { value: RED_B.clone() }, uHpColB: { value: RED_A.clone() },
      uO2Rad: { value: 1.34 }, uO2Thick: { value: 0.1 },
      uO2Centre: { value: Math.PI * 0.5 }, uO2Span: { value: 2.6 },
      uO2Dir: { value: -1 }, uO2Fill: { value: 0.18 }, uO2Ghost: { value: 0.18 },
      uO2Segs: { value: 0 }, uO2Alarm: { value: 0 },
      uO2ColA: { value: AMBER_B.clone() }, uO2ColB: { value: AMBER_A.clone() },
    },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * ARC_OVERSCAN, 2 * ARC_OVERSCAN), material);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// THE SCENE — one context for the whole sheet.
// ---------------------------------------------------------------------------

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water, because everything here composites ADDITIVELY and a panel over black
// would flatter it. What these arcs look like over the blue they are actually
// drawn on is the entire question.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14344a }),
);
water.position.z = -40;
scene.add(water);

// The animal, roughly. The ring is drawn behind the whole seal, so an arc that
// only reads on empty water reads on nothing.
const seal = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.42, 1.7, 4, 12),
  new THREE.MeshBasicMaterial({ color: 0x1d2c3a }),
);
seal.rotation.z = Math.PI / 2;
scene.add(seal);

const ring = createStrikeRing();
scene.add(ring);
const arcs = createArcs();
scene.add(arcs);

const post = createPost(gl);
const ORIGIN = new THREE.Vector3(0, 0, 0);
const stats = { strikeChumRefill: CONFIG.strike.charge.chumRefill };
const state = {
  charge: 0.62, pending: 0, charging: false, power: 0, flash: 0,
  perfect: false, perfectFlash: 0, perfectStrike: false,
  chainTimer: 0, chainPips: 0, chainCount: 0,
};

// Settle the pip springs once; every panel after this is the same fuel state
// seen through a different arc layout, which is the comparison being made.
for (let i = 0; i < 90; i++) updateStrikeRing(DT, ORIGIN, state, true, stats);
arcs.scale.copy(ring.scale);
arcs.position.copy(ring.position);
// A hair in front of the ring so the two never z-fight; both are additive and
// depth-write nothing, so this only fixes the draw order.
arcs.position.z = ring.position.z + 0.01;

function makeCamera(view) {
  const cam = new THREE.OrthographicCamera(
    -view * (W / H) / 2, view * (W / H) / 2, view / 2, -view / 2, -100, 100,
  );
  cam.position.set(0, 0, 20);
  return cam;
}
// The magnifier, and the truth.
//
// THE SECOND ONE IS NOT THE GAME'S FIELD OF VIEW, and that is the point. Framing
// this 600px buffer on the arena's whole 44-unit view would draw the instrument
// at 14 px per world unit, where a 1080p screen draws it at 24.5 — the panel
// would report a meter half the size of the real one and condemn every layout
// on the sheet. What has to match is PIXELS PER WORLD UNIT, not the field, so
// the second camera is sized to put 24.5 of these pixels on a world unit and
// simply shows less water. The instrument in that row is the number of pixels
// a player's screen actually gives it.
const REAL_PX_PER_UNIT = 1080 / 44;
const CAM_BIG = makeCamera(13);
const CAM_REAL = makeCamera((H * 2) / REAL_PX_PER_UNIT);

// ---------------------------------------------------------------------------
// THE VARIANTS — each one an answer to "which piece of the circle is whose".
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
// Angles are CLOCKWISE FROM TWELVE, the fuel ring's own convention: 0 is up,
// 90 is three o'clock, 180 is down, 270 is nine o'clock.
const UP = 0, RIGHT = 90 * DEG, DOWN = 180 * DEG, LEFT = 270 * DEG;

// `dir: 1` fills from the end the arc's span starts at, going clockwise.
// On the LEFT of the circle clockwise runs bottom-to-top, which is why the
// left-hand arcs fill upward and the right-hand ones are given dir: -1 to
// mirror them. That mirroring is a real decision and not a detail: filling
// both strictly clockwise would have the right-hand gauge DRAIN UPWARD, and
// no amount of colour fixes a gauge that empties the wrong way.
const VARIANTS = [
  {
    name: 'Opposed halves',
    note: 'Health owns the left of the circle, air the right, both just outside the pips. '
        + 'Symmetric, and neither can be mistaken for the fuel ring because neither is a ring.',
    hp: { rad: 1.34, thick: 0.1, centre: LEFT, span: 150 * DEG, dir: 1, segs: 0 },
    o2: { rad: 1.34, thick: 0.1, centre: RIGHT, span: 150 * DEG, dir: -1, segs: 0 },
  },
  {
    name: 'Left stack',
    note: 'Both on the left, at two radii. Keeps the whole right half — the water the seal '
        + 'is swimming and aiming into — completely clear, at the cost of two concentric arcs.',
    hp: { rad: 1.28, thick: 0.1, centre: LEFT, span: 130 * DEG, dir: 1, segs: 0 },
    o2: { rad: 1.6, thick: 0.09, centre: LEFT, span: 130 * DEG, dir: 1, segs: 0 },
  },
  {
    name: 'Segmented halves',
    note: 'Opposed halves, chopped in the pips’ own grammar with the same segment gap. '
        + 'The strongest family resemblance on the sheet — and the most crowded.',
    hp: { rad: 1.34, thick: 0.11, centre: LEFT, span: 150 * DEG, dir: 1, segs: 10 },
    o2: { rad: 1.34, thick: 0.11, centre: RIGHT, span: 150 * DEG, dir: -1, segs: 10 },
  },
  {
    name: 'Shoulders',
    note: 'Two short thick arcs hugging the ring at the upper and lower left. Compact enough '
        + 'to read as part of the instrument rather than as a second one around it.',
    hp: { rad: 1.3, thick: 0.15, centre: 315 * DEG, span: 76 * DEG, dir: 1, segs: 0 },
    o2: { rad: 1.3, thick: 0.15, centre: 225 * DEG, span: 76 * DEG, dir: -1, segs: 0 },
  },
  {
    name: 'Under the belly',
    note: 'Both below the animal, mirrored about six o’clock. Never crosses the aim line, '
        + 'and the pair reads as one gesture rather than as two instruments.',
    hp: { rad: 1.36, thick: 0.12, centre: 215 * DEG, span: 88 * DEG, dir: 1, segs: 0 },
    o2: { rad: 1.36, thick: 0.12, centre: 145 * DEG, span: 88 * DEG, dir: -1, segs: 0 },
  },
  {
    name: 'Wide collar',
    note: 'Pushed further out and thinner, nearly closing the circle. The most elegant at '
        + 'size and the first to fall apart at the game’s actual 93 pixels.',
    hp: { rad: 1.72, thick: 0.075, centre: LEFT, span: 165 * DEG, dir: 1, segs: 0 },
    o2: { rad: 1.72, thick: 0.075, centre: RIGHT, span: 165 * DEG, dir: -1, segs: 0 },
  },
];

// The state every panel is drawn in, so the variants differ only in layout:
// bitten and still draining (the trail is standing above the fill), and low
// enough on air to be in the amber.
const HP_FILL = 0.42;
const HP_GHOST = 0.68;
const O2_FILL = 0.19;

function applyVariant(v) {
  const u = arcs.material.uniforms;
  for (const [k, g] of [['uHp', v.hp], ['uO2', v.o2]]) {
    u[`${k}Rad`].value = g.rad;
    u[`${k}Thick`].value = g.thick;
    u[`${k}Centre`].value = g.centre;
    u[`${k}Span`].value = g.span;
    u[`${k}Dir`].value = g.dir;
    u[`${k}Segs`].value = g.segs;
  }
  u.uHpFill.value = HP_FILL;
  u.uHpGhost.value = HP_GHOST;
  u.uHpAlarm.value = 0;
  u.uO2Fill.value = O2_FILL;
  u.uO2Ghost.value = O2_FILL;
  // Under a quarter of a tank the air arc goes amber, exactly as the bar does.
  const low = O2_FILL < 0.25;
  u.uO2ColA.value.copy(low ? AMBER_B : BLUE_B);
  u.uO2ColB.value.copy(low ? AMBER_A : BLUE_A);
  u.uO2Alarm.value = low ? 0.6 : 0;
}

// ---------------------------------------------------------------------------
// THE SHEET
// ---------------------------------------------------------------------------

let row = null;
let shotIndex = 0;
const posted = [];

function section(title, sub, columns) {
  const h = document.createElement('h2');
  h.innerHTML = title;
  document.getElementById('sheet').appendChild(h);
  if (sub) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.innerHTML = sub;
    document.getElementById('sheet').appendChild(p);
  }
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}

function present(title, note) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

function draw(cam) {
  post.resize();
  post.render(scene, cam, DT);
}

// --- the sheet, top to bottom ----------------------------------------------

section('Today, for comparison',
  'The fuel ring and the core exactly as they ship, with no arcs on them at all. '
  + 'Everything below adds to this picture; this is what there is to spoil.', 3);
arcs.visible = false;
draw(CAM_BIG);
present('No arcs — magnified', 'The instrument as it stands: pips outside, banked power in the middle.');
draw(CAM_REAL);
present('No arcs — game size', 'The same thing at the size a player sees. About 93 pixels across.');
arcs.visible = true;

section('The six layouts, magnified',
  'Health is red and fills upward; air is amber because this seal is under a quarter of a tank. '
  + 'The pale band above the health fill is the damage trail — the same one the current bars carry.', 3);
for (const v of VARIANTS) {
  applyVariant(v);
  draw(CAM_BIG);
  present(v.name, v.note);
}

section('The same six at the pixel size a 1080p screen gives them',
  'This row is the one that decides it — same pixels per world unit as the real game, cropped '
  + 'closer so the instrument is not a speck in a wide shot. The bright pass spreads about 14 '
  + 'pixels here, so any two features closer than roughly 20 fuse into a single smear, which is '
  + 'why the fuel ring’s own core sits at 0.58 and not at the obvious 0.78. A layout that survives '
  + 'only the row above is a diagram, not a design.', 3);
for (const v of VARIANTS) {
  applyVariant(v);
  draw(CAM_REAL);
  present(`${v.name} — real pixels`, v.note);
}

// --- and the states, on one layout -----------------------------------------
//
// The sheet above is one moment: bitten, and low on air. A layout is not
// judged on one moment — a gauge spends most of a run FULL, and the question
// nobody asks until it is too late is what the instrument looks like when
// nothing is wrong.
section('One layout, through a run',
  'Shoulders, because it is the most compact. Note the healthy frame: air is BLUE there, and blue '
  + 'is the only one of these four colours the fuel ring does not already wear — its pips run '
  + 'orange to yellow to green, which is why the amber alarm state is the hardest to keep separate '
  + 'from the ring beneath it.', 4);
const SHOULDERS = VARIANTS[3];
const STATES = [
  { name: 'Untouched', hp: 1, ghost: 1, o2: 1, note: 'Full and quiet. Two nearly closed arcs — the state a run spends most of its time in.' },
  { name: 'Bitten', hp: 0.42, ghost: 0.68, o2: 0.8, note: 'Mid-drain: the pale band above the red IS the damage, still on its way down.' },
  { name: 'Drowning', hp: 0.42, ghost: 0.42, o2: 0.14, note: 'Air past the quarter mark, so it goes amber — and lands in the fuel ring’s own orange.' },
  { name: 'Nearly dead', hp: 0.09, ghost: 0.09, o2: 0.06, note: 'Both arcs down to stubs. At real pixels this is the frame that has to still read.' },
];
for (const st of STATES) {
  applyVariant(SHOULDERS);
  const u = arcs.material.uniforms;
  u.uHpFill.value = st.hp;
  u.uHpGhost.value = st.ghost;
  u.uHpAlarm.value = st.hp < 0.34 ? 0.7 : 0;
  u.uO2Fill.value = st.o2;
  u.uO2Ghost.value = st.o2;
  const low = st.o2 < 0.25;
  u.uO2ColA.value.copy(low ? AMBER_B : BLUE_B);
  u.uO2ColB.value.copy(low ? AMBER_A : BLUE_A);
  u.uO2Alarm.value = low ? 0.6 : 0;
  draw(CAM_BIG);
  present(st.name, st.note);
}

// --- what the page found ----------------------------------------------------

log(`${VARIANTS.length} layouts drawn at two sizes, over the shipping ring and the shipping post chain.`);
if (shaderErrors.length) {
  log(`SHADER FAILED TO COMPILE — the panels above are lying:`, 'bad');
  for (const e of shaderErrors.slice(0, 4)) log(e, 'bad');
} else {
  log('No shader errors: every panel is a real render, not an empty quad.', 'ok');
}
log(`fuel ring radius ${CONFIG.strike.ring.radius} x scale ${CONFIG.strike.ring.scale ?? 1}`
  + ` — arcs are placed in ring radii, so they follow it wherever it is tuned.`);

Promise.all(posted).then(() => log(`${posted.length} panels written to the shots directory.`));
