// ---------------------------------------------------------------------------
// THE BOOST METER'S CORE — LOOK DEV
//
//   npm run looks:core
//
// The question this sheet exists to answer: does the banked-power readout read
// as a DROP OF LIQUID being gathered — and does the moment it is fully loaded
// (CONFIG.strike.charge.perfectAt) arrive as an event you could learn to hit?
//
// The core used to be a second arc sweeping the same way as the fuel ring
// around it, which is one instrument saying two things in the same words. It is
// now a radial fill built as a metaball field: the same cubic splat kernel
// entities/particles.js splats with, cut at an isoline exactly like
// CONFIG.fx.goo, with that pass's wet rim and gradient-lit highlight. See the
// long version at the top of systems/strikeRing.js.
//
// WHY A PAGE AND NOT A NODE HARNESS. All of the above is one GLSL program, and
// a GLSL error renders NOTHING and throws nothing a Node harness can see — the
// meter would simply be missing from the game with a clean test suite. This
// page imports the SHIPPING module and the SHIPPING post chain, so a panel that
// comes up black is a real compile failure, and the radius checks below are
// measured off the pixels the game would actually draw.
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createStrikeRing, updateStrikeRing, resetStrikeRing, RING_OVERSCAN } from '../../path/src/systems/strikeRing.js';

const logEl = document.getElementById('log');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
let fails = 0;
const check = (name, ok, detail = '') => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, ok ? 'ok' : 'bad');
  if (!ok) fails++;
};

// A shader that fails to compile renders NOTHING and three only writes to the
// console about it, so the page would look like a bad tuning decision instead
// of a broken program. Collected from the first frame onward.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 340;
const H = 340;
const DT = 1 / 60;
// The frame the meter is actually judged at: the ring is ~2.5 world units
// across against a 44-unit view in the game, which is what makes it a 90px
// instrument. This page is a magnifying glass — a 12-unit view — because the
// question is what the SHAPE does, and a shape that only works at 90px is not
// a shape, it is a smudge. The measurements below correct for the difference.
const VIEW = 12;

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water to sit the instrument in. The core composites ADDITIVELY, so a panel
// over empty black would flatter it — what it looks like over the blue it is
// actually drawn on is the whole question.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14344a }),
);
water.position.z = -40;
scene.add(water);

// A stand-in for the seal, so the drop is judged with something in front of it:
// the ring is drawn BEHIND the whole animal (playerOverlayZ), and a core that
// only reads on an empty patch of water reads on nothing.
const seal = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.42, 1.7, 4, 12),
  new THREE.MeshBasicMaterial({ color: 0x1d2c3a }),
);
seal.rotation.z = Math.PI / 2;
scene.add(seal);

const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100,
);
camera.position.set(0, 0, 20);

const post = createPost(gl);
const ring = createStrikeRing();
scene.add(ring);
const U = ring.material.uniforms;

// The stats block updateStrikeRing reads, shaped like recomputeStats' output.
// Only the refill matters here — it is what the pip count is derived from.
const stats = { strikeChumRefill: CONFIG.strike.charge.chumRefill };

// A strikeState the page drives by hand. Deliberately NOT systems/strike.js's
// real one: this sheet is about what the meter DRAWS for a given state, and
// stepping the model to reach each state would make every panel depend on the
// charge economy as well as on the shader.
const state = () => ({
  charge: 1, pending: 0, charging: false, power: 0, flash: 0,
  perfect: false, perfectFlash: 0, perfectStrike: false,
  chainTimer: 0, chainPips: 0, chainCount: 0,
});

// Hold the ring at one state for `frames` so the springs settle, then leave it
// there. `settle` runs the frames with the state pinned; anything that has to
// ANIMATE (a pop, a burst) counts its own clock down instead.
function settle(s, frames = 90) {
  for (let i = 0; i < frames; i++) updateStrikeRing(DT, ORIGIN, s, true, stats);
}
const ORIGIN = new THREE.Vector3(0, 0, 0);

function draw(cam = camera) {
  post.resize();
  post.render(scene, cam, DT);
}

// --- the sheet --------------------------------------------------------------

let shotIndex = 0;
const posted = [];
let row = null;

function section(title, columns) {
  const h = document.createElement('h2');
  h.innerHTML = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}

function present(title, note, picked = false) {
  const cell = document.createElement('div');
  cell.className = picked ? 'cell pick' : 'cell';
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
  cap.innerHTML = `<b>${title}</b>${picked ? ' <span class="tag">— shipped</span>' : ''}<br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// --- MEASURING THE DROP -----------------------------------------------------
// How far the goo actually reaches, in world units, read off the pixels.
//
// A DIFFERENCE of two renders, with the core switched off in the second, and
// that is not fussiness: the meter is drawn over water and inside a fuel ring
// whose empty track is lit at all times, so any threshold on the image itself
// measures whichever of those is brightest. Differencing leaves exactly the
// pixels the core is responsible for.
//
// Measured on a RAW render rather than through the post chain: bloom is a blur
// by design and would hand back the radius of the halo instead of the radius of
// the surface — which is precisely the confusion `innerRadiusMul` exists to
// avoid (see the bloom-separation note in systems/strikeRing.js).
//
// The uniform is written directly rather than through CONFIG, because switching
// the core off in the config would need another updateStrikeRing to take
// effect, and that frame would advance the springs and the churn — measuring a
// different drop from the one on screen.
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });
const PX_PER_UNIT = (H * 2) / VIEW;

function grab() {
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height).data;
}

function reach({ withShock = false, threshold = 12 } = {}) {
  const shock = U.uShockGlow.value;
  // The shock ring is not the drop. It is deliberately allowed outside the
  // instrument, so leaving it in would make every measurement of the drop
  // report the ring's travel instead.
  if (!withShock) U.uShockGlow.value = 0;
  const lit = grab();
  U.uCore.value = 0;
  const without = grab();
  U.uCore.value = 1;
  U.uShockGlow.value = shock;

  const cx = probe.width / 2;
  const cy = probe.height / 2;
  let far = 0;
  for (let y = 0; y < probe.height; y += 2) {
    for (let x = 0; x < probe.width; x += 2) {
      const i = (y * probe.width + x) * 4;
      const d = Math.max(
        Math.abs(lit[i] - without[i]),
        Math.abs(lit[i + 1] - without[i + 1]),
        Math.abs(lit[i + 2] - without[i + 2]),
      );
      if (d <= threshold) continue;
      const r = Math.hypot(x - cx, y - cy);
      if (r > far) far = r;
    }
  }
  return far / PX_PER_UNIT;
}

// --- THE COMPILE ------------------------------------------------------------
// First, before any panel, so nothing else can be blamed for a black sheet.
const s0 = state();
s0.pending = 0.8;
settle(s0, 30);
draw();
check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
check('the meter linked a program', gl.info.programs.length > 0, `${gl.info.programs.length} programs`);

const RING = CONFIG.strike.ring;
const CORE = RING.core;
const ringR = RING.radius * (RING.scale ?? 1);

// --- THE FILL ---------------------------------------------------------------
section('The fill <span>— banked power, growing out of the middle. The fuel ring is full in every panel, so the only thing moving is the core.</span>', 5);
for (const p of [0.12, 0.35, 0.6, 0.85, 1]) {
  const s = state();
  s.pending = p;
  settle(s);
  draw();
  const armed = p >= CONFIG.strike.charge.minFire;
  present(`fill ${Math.round(p * 100)}%`,
    `${armed ? 'armed — the ready hue' : 'under minFire — still the charging hue'}`,
    p === 1);
}

// --- WHAT THE LOBES BUY -----------------------------------------------------
section('What makes it liquid <span>— the same fill at 85%, with the lobes turned off and up. `wobble` is how far they ride out; past about 0.5 they stop fusing with the core and the drop becomes a ring of beads.</span>', 4);
const wob0 = CORE.wobble;
for (const w of [0, 0.18, 0.3, 0.55]) {
  CORE.wobble = w;
  const s = state();
  s.pending = 0.85;
  settle(s);
  draw();
  present(`wobble ${w.toFixed(2)}`, w === 0 ? 'a dial, not a substance' : 'lobes rolling under the skin', w === wob0);
}
CORE.wobble = wob0;

// --- THE PERFECT CHARGE -----------------------------------------------------
// Stepped in real time off `perfectFlash`, exactly as systems/strike.js counts
// it down, so the panels are frames of the animation the game plays rather than
// five hand-set poses of it.
section('The perfect charge <span>— the wind-up fully banked. The drop swells past its own full size, blows past the bloom threshold, flings its lobes out and throws a ring through the fuel ring.</span>', 5);
const flashTime = CONFIG.strike.charge.perfectFlashTime;
{
  const s = state();
  s.pending = 1;
  settle(s);
  s.perfect = true;
  s.perfectFlash = flashTime;
  let t = 0;
  const marks = [0, 0.08, 0.16, 0.3, 0.5];
  let next = 0;
  while (next < marks.length) {
    updateStrikeRing(DT, ORIGIN, s, true, stats);
    if (t >= marks[next]) {
      draw();
      present(`+${Math.round(marks[next] * 1000)}ms`,
        `core flare x${(1 + U.uCorePop.value * U.uCorePopGlow.value).toFixed(2)}, shock ring r${U.uShockR.value.toFixed(2)}`,
        next === 1);
      next++;
    }
    s.perfectFlash = Math.max(0, s.perfectFlash - DT);
    t += DT;
  }
}

// --- THE RELEASE ------------------------------------------------------------
section('The release <span>— a radial impulse from the centre. The middle collapses while the lobes are carried out, so the welds fall under the isoline first and the drop TEARS into droplets before any of it fades.</span>', 5);
{
  const s = state();
  s.pending = 1;
  settle(s);
  // What a firing release does to the model, on one frame: the power is spent,
  // the bar is emptied and the spend flash is lit. See tryStrike.
  s.pending = 0;
  s.charge = 0.0;
  s.flash = CONFIG.strike.charge.flashTime;
  let t = 0;
  const marks = [0, 0.06, 0.12, 0.19, 0.27];
  let next = 0;
  while (next < marks.length) {
    updateStrikeRing(DT, ORIGIN, s, true, stats);
    if (t >= marks[next]) {
      draw();
      present(`release +${Math.round(marks[next] * 1000)}ms`,
        `thrown ${U.uSpread.value.toFixed(2)}, middle x${U.uCoreMul.value.toFixed(2)}, drops x${U.uLobeMul.value.toFixed(2)}`,
        next === 2);
      next++;
    }
    s.flash = Math.max(0, s.flash - DT);
    t += DT;
  }
}

// --- WHAT IT PROMISES -------------------------------------------------------
// The isoline sits well inside the kernel that made it — solving (1-q)^3 = iso
// puts it at barely half the kernel radius at the shipped 0.42 — so the drop is
// drawn from a kernel scaled to put the SURFACE where the fill asks for it. Left
// uncorrected, a full bank draws a drop about half the size it promised and
// every knob on the shape resizes it as a side effect.
log('\nWHERE THE SURFACE ACTUALLY LANDS');
{
  const s = state();
  s.charge = 0;          // the fuel ring silenced, so only the core is lit
  s.pending = 1;
  settle(s);
  const full = reach();
  const want = RING.innerRadiusMul * ringR;
  check('a full bank reaches innerRadiusMul, not the kernel behind it',
    Math.abs(full - want) / want < 0.14,
    `${full.toFixed(2)} vs ${want.toFixed(2)} world units`);

  // Growth is linear in banked power, but from a FLOOR rather than from zero:
  // the meter is drawn behind the seal, and a drop mapped honestly from nothing
  // spends its first third hidden inside the animal. See CONFIG's `core.floor`.
  const floor = CORE.floor;
  s.pending = 0.5;
  settle(s);
  const half = reach();
  const wantHalf = full * (floor + (1 - floor) * 0.5);
  check('half a bank lands where the floor mapping says', Math.abs(half - wantHalf) / full < 0.12,
    `${half.toFixed(2)} vs ${wantHalf.toFixed(2)}`);

  s.pending = CORE.minFill;
  settle(s);
  const least = reach();
  check('the smallest drop drawn is already visible past the seal', least > full * floor * 0.8,
    `${least.toFixed(2)}, floor ${(full * floor).toFixed(2)}`);
  check('...and it still grows from there', half > least * 1.15,
    `${least.toFixed(2)} -> ${half.toFixed(2)} -> ${full.toFixed(2)}`);

  // The isoline correction is the thing being tested here, so move `iso` — the
  // knob that would resize the drop if the correction were not there — and
  // check the drop does NOT move.
  const iso0 = CORE.iso;
  CORE.iso = 0.7;
  s.pending = 1;
  settle(s);
  const tight = reach();
  CORE.iso = iso0;
  check('raising the isoline changes the shape, not the size',
    Math.abs(tight - full) / full < 0.15, `${tight.toFixed(2)} vs ${full.toFixed(2)} at iso 0.7`);

  s.pending = CORE.minFill * 0.5;
  settle(s);
  const dregs = reach();
  check('a dreg of power draws nothing rather than a speck', dregs < want * 0.25,
    `${dregs.toFixed(2)} world units`);

  // And the reason for all of it: the drop must not touch the fuel ring, or
  // the bloom welds the two into one smear (see the top of strikeRing.js).
  check('it stays clear of the fuel ring', full < ringR * 0.8,
    `${full.toFixed(2)} of ${ringR.toFixed(2)}`);

  // The pop is allowed past that, briefly, which is what makes it an event.
  // Refilled first: the dreg check above left the drop at almost nothing, and
  // a pop measured off that measures the dreg.
  s.pending = 1;
  settle(s);
  s.perfect = true;
  s.perfectFlash = flashTime * 0.85;
  for (let i = 0; i < 8; i++) updateStrikeRing(DT, ORIGIN, s, true, stats);
  const popped = reach();
  check('the perfect pop is bigger than the full drop it came from', popped > full * 1.1,
    `${popped.toFixed(2)} vs ${full.toFixed(2)}`);
}

// --- IT ALSO HAS TO WORK AT THE SIZE IT SHIPS -------------------------------
// Every panel above is a magnifying glass. The instrument is 90px across in the
// game, and a shape that only survives at four times that is a shape nobody has
// ever seen.
section('At the size it ships <span>— the same states in the frame the game actually draws: the whole meter about 90px across.</span>', 4);
{
  const fightCam = new THREE.OrthographicCamera(
    -44 * (W / H) / 2, 44 * (W / H) / 2, 44 / 2, -44 / 2, -100, 100,
  );
  fightCam.position.set(0, 0, 20);
  const shots = [
    ['filling', (s) => { s.pending = 0.5; settle(s); }],
    ['loaded', (s) => { s.pending = 1; settle(s); }],
    ['the pop', (s) => {
      s.pending = 1; settle(s); s.perfect = true; s.perfectFlash = flashTime;
      for (let i = 0; i < 6; i++) { updateStrikeRing(DT, ORIGIN, s, true, stats); s.perfectFlash -= DT; }
    }],
    ['the release', (s) => {
      s.pending = 1; settle(s); s.pending = 0; s.flash = CONFIG.strike.charge.flashTime;
      for (let i = 0; i < 8; i++) { updateStrikeRing(DT, ORIGIN, s, true, stats); s.flash -= DT; }
    }],
  ];
  for (const [name, pose] of shots) {
    const s = state();
    pose(s);
    post.resize();
    post.render(scene, fightCam, DT);
    present(name, 'the shipped frame', false);
  }
}

// --- THE QUAD HAS TO BE BIGGER THAN THE INSTRUMENT --------------------------
// Everything is drawn in a space where the fuel ring is at r = 1, on a quad
// that used to stop at exactly that — so a band further out existed ONLY where
// the square reaches past the circle, and drew as four corner smears. It is a
// silent failure: the chain arc and the shock ring both look like a tuning
// choice rather than like geometry being cut off.
log('\nTHE INSTRUMENT FITS ON ITS OWN QUAD');
{
  const widest = Math.max(RING.chainRadiusMul ?? 1.14, CORE.ringTo ?? 1.4);
  check('the quad reaches past everything drawn on it', RING_OVERSCAN >= widest,
    `overscan ${RING_OVERSCAN} vs widest band ${widest}`);

  // And measured: the shock ring at full travel has to be lit on the AXES as
  // well as on the diagonals. A clipped ring is bright in the corners and
  // missing at twelve, three, six and nine o'clock, which is exactly the shape
  // that reads as a square frame.
  const s = state();
  s.charge = 0;
  s.pending = 1;
  settle(s);
  s.perfect = true;
  s.perfectFlash = flashTime;
  // Far enough in that the ring is past the fuel ring and still lit.
  for (let i = 0; i < 22; i++) { updateStrikeRing(DT, ORIGIN, s, true, stats); s.perfectFlash -= DT; }
  const shockR = U.uShockR.value;
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
  const rPx = shockR * ringR * PX_PER_UNIT;
  let darkest = 255;
  let where = '';
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const x = Math.round(probe.width / 2 + Math.sin(a) * rPx);
    const y = Math.round(probe.height / 2 - Math.cos(a) * rPx);
    const i = (y * probe.width + x) * 4;
    const lit = Math.max(px[i], px[i + 1], px[i + 2]);
    if (lit < darkest) { darkest = lit; where = `${Math.round((a * 180) / Math.PI)}deg`; }
  }
  check(`the shock ring is a whole circle at r ${shockR.toFixed(2)}`, darkest > 40,
    `dimmest point ${darkest}/255 at ${where}`);
}

check('nothing failed to compile across the whole sheet', shaderErrors.length === 0, shaderErrors[0] ?? '');
resetStrikeRing();

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall panels rendered', fails ? 'bad' : 'ok');
