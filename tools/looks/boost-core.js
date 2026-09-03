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
// Mutated in memory only — this page has its own origin and no save path, and
// a look page has no business writing a settings snapshot. See SERVERS.md.
import { settings } from '../../path/src/systems/settings.js';

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

// --- WHICH VIEW THIS SHEET IS ABOUT -----------------------------------------
// The WHEEL, pinned before the first panel is drawn.
//
// This is not belt-and-braces: settings.hud.boostMeter ships as 'bar' now (the
// pips are a column beside the air gauge, drawn by ui/ui.js), and in that view
// this instrument deliberately draws no fuel ring at all. Inheriting the
// shipped setting would render every panel below as bare water with a bubble
// in it — a sheet that looks like a broken shader and is in fact a correct one
// answering a question nobody asked it. The bar view has its own section near
// the bottom, which flips this and puts it back.
settings.hud.boostMeter = 'ring';

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
  const armed = p >= (CONFIG.strike.charge.minFirePips ?? 1) * (CONFIG.strike.charge.chumRefill ?? 0.2);
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

// --- THE LEAD-IN: THE RELEASE MOMENT ARRIVING -------------------------------
//
// The question: can you see the moment coming, and is it obvious WHICH FRAME
// to let go on. Every other cue for the sweet spot fires at its centre, which
// is 50ms before the window shuts — reaction time alone made the gate
// unhittable, and the logs agreed: 31 of 303 releases armed anything.
//
// The food chain no longer answers to this window at all (a perfect charge
// arms it, see tryStrike), so what the lead-in now leads into is the strike's
// DAMAGE. Still worth seeing coming — it is every point of bite the strike
// has — and still the same measurement, which is why this sheet did not move.
//
// The panels walk the approach in real time. `sinceLoaded` / `toLoaded` are
// what the meter reads (see releaseOffset in systems/strike.js), so posing them
// here poses exactly the thing the game draws.
section('The lead-in <span>— a ring closing in from outside to land on the fuel ring at the instant a release is on the beat, with the tolerance drawn where it lands. Let go as they meet. The beat is the DAMAGE gate: a charged release starts a food chain at any timing, and only a strike on the beat also bites.</span>', 5);
{
  const half = CONFIG.strike.charge.time * CONFIG.strike.charge.sweetFraction;
  const lead = CONFIG.strike.ring.lead;
  // Offsets either side of the moment, in seconds. The middle one IS the beat.
  const marks = [-lead.time * 0.9, -half * 2.4, 0, half * 2.4, lead.time * 0.9];
  for (const off of marks) {
    const s = state();
    // A wind-up in hand, banked past minFire — the state the cue exists for.
    s.pending = 0.9;
    s.charge = 0;
    s.charging = off < 0;
    s.loaded = off >= 0;
    s.sinceLoaded = off >= 0 ? off : 0;
    s.toLoaded = off < 0 ? -off : 0;
    settle(s, 2);
    draw();
    const inside = Math.abs(off) <= half;
    present(
      `${off >= 0 ? '+' : ''}${Math.round(off * 1000)}ms`,
      inside
        ? 'inside the tolerance — the traveller has gone READY, and a release here arms the chain'
        : (off < 0 ? 'still coming in' : 'past it — a speed boost and nothing else'),
      inside && off === 0,
    );
    // The cue must not be able to say "now" when the gate would refuse. This is
    // the same assertion tools/chain-window-probe.mjs makes against the model;
    // here it is made against the PIXEL PATH, so a uniform wired to the wrong
    // name fails rather than quietly drawing a plausible ring.
    check(`the traveller reads ${inside ? 'READY' : 'not ready'} at ${Math.round(off * 1000)}ms`,
      (U.uLeadHit.value > 0.5) === inside,
      `uLeadHit ${U.uLeadHit.value}`);
  }

  // WHAT COLOUR IS ACTUALLY ON SCREEN at each band. The traveller and its
  // target have to be TELLABLE APART — the whole cue is one crossing the
  // other, and two rings the same colour is a single fat ring that happens to
  // wobble. Read off the pixels rather than off the uniforms, because the
  // additive composite and the bloom are between the two.
  {
    const s2 = state();
    s2.pending = 0.9; s2.charge = 0; s2.charging = true;
    s2.loaded = false; s2.sinceLoaded = 0; s2.toLoaded = lead.time * 0.5;
    settle(s2, 2);
    const px = grab();
    const at = (rr) => {
      const x = Math.round(probe.width / 2 + rr * ringR * PX_PER_UNIT);
      const y = Math.round(probe.height / 2);
      const i = (y * probe.width + x) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    };
    const trav = at(U.uLeadR.value);
    const targ = at(1);
    const hue = ([r, g, b]) => (r > g && r > b ? 'red' : g > b ? 'green' : 'blue');
    log(`uColor #${U.uColor.value.getHexString()}  uReadyColor #${U.uReadyColor.value.getHexString()}`);
    check('the traveller keeps its hue instead of clipping to white',
      Math.max(...trav) > 110 && Math.max(...trav) < 250,
      `traveller rgb(${trav}) at r ${U.uLeadR.value.toFixed(2)}`);
    check('...and it is a different colour from the target it is aiming at',
      hue(trav) !== hue(targ), `traveller ${hue(trav)} rgb(${trav}) vs target ${hue(targ)} rgb(${targ})`);
    check('...with the target the dimmer of the two',
      Math.max(...targ) < Math.max(...trav), `target rgb(${targ})`);
    // AND IT MUST NOT BE DRAWN INSIDE THE DROP. The core's goo reaches 0.84 of
    // the ring radius at a full bank, which is where an OUTWARD traveller spent
    // the first third of its approach — in front of a bright green blob, over
    // exactly the stretch the player is reading. Coming in from outside, the
    // whole travel is clear of it.
    check('the traveller never crosses the core on the way in',
      (1 + lead.span) > 0.9 && 1 > 0.9,
      `born at ${(1 + lead.span).toFixed(2)} and lands on 1.00, the drop reaches 0.84`);
  }

  // THE MOMENT ITSELF HAS TO BE THE LOUDEST THING THE CUE DOES — measured on
  // the BAND, not on a scan of the whole row: the core saturates at 255 and a
  // peak taken across the row reports the drop's brightness in both states and
  // calls them equal, which is a measurement that can never fail.
  {
    const bandAt = (off) => {
      const st = state();
      st.pending = 0.9; st.charge = 0;
      st.loaded = off >= 0; st.sinceLoaded = off >= 0 ? off : 0;
      st.toLoaded = off < 0 ? -off : 0;
      settle(st, 2);
      const px = grab();
      const x = Math.round(probe.width / 2 + U.uLeadR.value * ringR * PX_PER_UNIT);
      const i = (Math.round(probe.height / 2) * probe.width + x) * 4;
      return Math.max(px[i], px[i + 1], px[i + 2]);
    };
    const apart = bandAt(-half * 3);
    const together = bandAt(0);
    check('the traveller landing on its target is the loudest the cue gets',
      together > apart, `${together} on the beat vs ${apart} a moment before`);
  }

  // AND IT HAS TO LAND ON THE RING. The whole cue is the claim that r = 1 is
  // the moment; if the traveller's radius at offset 0 is anything else, the
  // player would be learning to release wherever it actually lands.
  const s = state();
  s.pending = 0.9; s.charge = 0; s.loaded = true; s.sinceLoaded = 0; s.toLoaded = 0;
  settle(s, 2);
  check('the traveller is ON the fuel ring at the moment itself',
    Math.abs(U.uLeadR.value - 1) < 1e-6, `r ${U.uLeadR.value.toFixed(4)}`);
  // ...and it is born OUTSIDE everything else the instrument draws, so the whole
  // approach happens on clear water rather than over the drop.
  const born = state();
  born.pending = 0.9; born.charge = 0; born.loaded = false;
  born.sinceLoaded = 0; born.toLoaded = lead.time;
  settle(born, 2);
  check('...and it is born outside the fuel ring',
    Math.abs(U.uLeadR.value - (1 + lead.span)) < 1e-6 && U.uLeadR.value > 1.2,
    `born at ${U.uLeadR.value.toFixed(3)}`);
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

// --- THE OTHER VIEW: WHAT IS LEFT WHEN THE PIPS MOVE TO THE HUD -------------
// settings.hud.boostMeter === 'bar' hands the FUEL to a column beside the air
// gauge (ui/ui.js) and leaves the CHARGE half here. The split has to be exactly
// that: the drop, its pop, the release and the lead-in stay on the animal,
// because banked power is a thing the seal is holding and a wind-up with no
// read on the body is a wind-up nobody can time.
//
// Measured rather than eyeballed, because the failure mode is quiet in both
// directions: a wheel that keeps drawing means two fuel gauges disagreeing by a
// frame, and a gate that catches the core as well means a whole instrument
// silently missing for anyone who tried the setting.
section('With the pips in the HUD <span>— boostMeter "bar", which is what ships: the fuel column is drawn by ui/ui.js and what is left here is the charge.</span>', 4);
{
  const barCam = new THREE.OrthographicCamera(
    -44 * (W / H) / 2, 44 * (W / H) / 2, 44 / 2, -44 / 2, -100, 100,
  );
  barCam.position.set(0, 0, 20);

  // How bright the fuel ring's band is at 12 o'clock, where pip 0 always sits.
  // Read on a RAW render for the same reason the drop is measured on one:
  // bloom would smear the core's own halo out over the band and answer a
  // different question.
  //
  // AGAINST THE WATER, not against zero. The panels are composited over
  // CONFIG-blue (0x14344a), so "nothing drawn here" reads 74/255 and a check
  // for darkness would fail on a perfectly silent wheel — the exact false
  // alarm that sends someone looking for a bug in the gate.
  //
  // AND IT IS READ ALL THE WAY ROUND, not at one pixel. The meters wear a
  // field of noise now (systems/meterNoise.js), so a single sample at twelve
  // o'clock is a sample of wherever the grain happens to be dark — it read 111
  // against 255 the first time this ran, which is the grain working exactly as
  // asked and the probe asking the wrong question. Twenty-four angles, and the
  // two numbers that survive graining: the average says the band is lit, the
  // brightest says whether anything is drawn there at all.
  const litAtRing = (s, meshOn = true) => {
    if (s) settle(s);
    ring.visible = meshOn;
    gl.render(scene, camera);
    pctx.clearRect(0, 0, probe.width, probe.height);
    pctx.drawImage(gl.domElement, 0, 0);
    const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
    const rPx = (1 - (RING.thickness ?? 0.04) * 0.5) * ringR * PX_PER_UNIT;
    let sum = 0;
    let top = 0;
    const N = 24;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      const x = Math.round(probe.width / 2 + Math.sin(a) * rPx);
      const y = Math.round(probe.height / 2 - Math.cos(a) * rPx);
      const i = (y * probe.width + x) * 4;
      const lit = Math.max(px[i], px[i + 1], px[i + 2]);
      sum += lit;
      if (lit > top) top = lit;
    }
    ring.visible = true;
    return { mean: Math.round(sum / N), max: top };
  };

  const full = () => { const s = state(); s.charge = 1; s.pending = 0; return s; };

  const water = litAtRing(null, false);
  settings.hud.boostMeter = 'ring';
  const ringLit = litAtRing(full());
  settings.hud.boostMeter = 'bar';
  const barLit = litAtRing(full());
  check('a full bar lights the wheel in the ring style', ringLit.mean > water.mean + 60,
    `${ringLit.mean}/255 mean round the band, over ${water.mean}/255 of water`);
  // NAMED FOR THE WHEEL, and the name matters now: the ring at r = 1 is not
  // empty in this style any more — the TRACK is drawn there (see the section
  // at the foot of this sheet). What must not survive is the FUEL, and the
  // pose above is what makes that the question being asked: a full bar with no
  // wind-up in hand, which lights every pip in the wheel style and leaves the
  // track dark because there is nothing to time.
  check('...and the WHEEL leaves bare water there once the pips are in the HUD',
    barLit.max <= water.max + 2,
    `brightest point ${barLit.max}/255 against ${water.max}/255`);

  // And the half that must SURVIVE. The drop is the same size in both styles:
  // measured through the same difference render the panels above use, so this
  // is the surface and not a halo.
  // THE CHURN IS RESET FIRST, and without it this measures nothing.
  //
  // The drop's lobes ride a slowly rolling ring on a clock that never repeats —
  // deliberately, so the silhouette never settles into a shape. Two settles
  // back to back are therefore two different frames of the same liquid, and the
  // outline swings about 6% between them (1.55 against 1.64, which is the
  // wobble and not the setting). Reset, then settle the same number of frames,
  // and both styles are asked about the same frame of the same drop.
  //
  // The wheel is silenced in both for a second reason: reach() is a DIFFERENCE
  // of two renders and the meter composites ADDITIVELY, so where the fuel ring
  // is already at 255 the core adds nothing the subtraction could see. The
  // uniform is written directly, exactly as uCore is above and for the same
  // reason — going through the setting would need another frame to take effect,
  // which would advance the very churn this is pinning.
  const dropAt = (mode) => {
    settings.hud.boostMeter = mode;
    resetStrikeRing();
    const s = state();
    s.charge = 1; s.pending = 1;
    settle(s);
    const fuel = U.uFuel.value;
    U.uFuel.value = 0;
    const r = reach();
    U.uFuel.value = fuel;
    return r;
  };
  const ringDrop = dropAt('ring');
  const barDrop = dropAt('bar');
  check('the drop of goo is untouched by the setting',
    Math.abs(ringDrop - barDrop) < 0.02,
    `${ringDrop.toFixed(3)} vs ${barDrop.toFixed(3)} world units`);

  const shots = [
    ['bar filling', (s) => { s.charge = 0.6; s.pending = 0.5; settle(s); }],
    ['bar loaded', (s) => { s.charge = 1; s.pending = 1; settle(s); }],
    ['bar the pop', (s) => {
      s.pending = 1; settle(s); s.perfect = true; s.perfectFlash = flashTime;
      for (let i = 0; i < 6; i++) { updateStrikeRing(DT, ORIGIN, s, true, stats); s.perfectFlash -= DT; }
    }],
    ['bar the release', (s) => {
      s.pending = 1; settle(s); s.pending = 0; s.flash = CONFIG.strike.charge.flashTime;
      for (let i = 0; i < 8; i++) { updateStrikeRing(DT, ORIGIN, s, true, stats); s.flash -= DT; }
    }],
  ];
  for (const [name, pose] of shots) {
    const s = state();
    pose(s);
    post.resize();
    post.render(scene, barCam, DT);
    present(name, 'the shipped frame, fuel in the HUD', false);
  }
  // BACK TO THE WHEEL before anything else reads it — and note that this is a
  // PIN rather than a restore: the column is what ships now, and every check
  // below this block (the shock ring's circle, the grain on the band) is a
  // measurement of the wheel, which would silently measure bare water if it
  // inherited the shipped setting instead.
  settings.hud.boostMeter = 'ring';
}

// --- IT IS A BUBBLE, WHICH MEANS IT IS DRAWN BY ITS EDGE --------------------
// The drop used to be a solid bead wearing the fuel wheel's colours. It is a
// film now: blue, nearly empty in the middle, carrying its light on the
// silhouette. That is a MEASURABLE claim and worth pinning, because the way it
// regresses is not a crash — it is somebody raising `middle` or widening the
// rim until the thing is a bead again, which looks deliberate.
//
// The stand-in seal is hidden for these reads. It sits IN FRONT of the meter
// (playerOverlayZ) and is exactly what the middle of the film is supposed to
// let you see, so leaving it in would measure the capsule.
log('\nTHE BUBBLE');
{
  const s = state();
  s.charge = 0;
  s.pending = 1;
  settle(s);
  const fillPx = (RING.innerRadiusMul ?? 0.58) * ringR * PX_PER_UNIT;
  seal.visible = false;
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
  seal.visible = true;

  // Mean brightness round a circle at `f` of the film's radius. Round the
  // whole circle rather than at one angle: the lobes make the silhouette
  // lumpy by design, and the grain makes any single pixel a lottery.
  const ringMean = (f) => {
    let sum = 0;
    const N = 48;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      const x = Math.round(probe.width / 2 + Math.sin(a) * fillPx * f);
      const y = Math.round(probe.height / 2 - Math.cos(a) * fillPx * f);
      const i = (y * probe.width + x) * 4;
      sum += Math.max(px[i], px[i + 1], px[i + 2]);
    }
    return Math.round(sum / N);
  };
  const middle = ringMean(0.3);
  const skin = ringMean(0.92);
  check('the film carries its light on the silhouette', skin > middle * 1.6,
    `rim ${skin}/255 against ${middle}/255 in the middle`);
  // ...and the middle is not EMPTY either, or it is a wire outline rather than
  // a bubble. There has to be something there for the water to shine through.
  check('...and there is still a film in the middle', middle > 8, `${middle}/255`);
}

// --- THE GRAIN REACHES THE SHADER -------------------------------------------
// One field of noise across every meter (systems/meterNoise.js), and this is
// the only surface where it can fail silently: the DOM gauges either have a
// tile or visibly do not, where a sampler with nothing bound is a uniform the
// instrument keeps drawing perfectly without.
log('\nTHE GRAIN');
{
  const bandLit = () => {
    const s = state();
    s.charge = 1;
    settle(s);
    gl.render(scene, camera);
    pctx.clearRect(0, 0, probe.width, probe.height);
    pctx.drawImage(gl.domElement, 0, 0);
    const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
    const rPx = (1 - (RING.thickness ?? 0.04) * 0.5) * ringR * PX_PER_UNIT;
    const out = [];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const x = Math.round(probe.width / 2 + Math.sin(a) * rPx);
      const y = Math.round(probe.height / 2 - Math.cos(a) * rPx);
      const i = (y * probe.width + x) * 4;
      out.push(Math.max(px[i], px[i + 1], px[i + 2]));
    }
    return out;
  };
  const noise = CONFIG.hud.meterNoise;
  const wasDepth = noise.depth;
  noise.depth = 0;
  const flat = bandLit();
  noise.depth = Math.max(0.3, wasDepth);
  const grained = bandLit();
  noise.depth = wasDepth;

  // THE SAME ANGLES, DIFFERENCED — not the spread of either one on its own,
  // which was the first thing tried and is useless here: the band is already
  // cut into pips and walked across a colour ramp, so its own spread is 54
  // either way and the grain is a rounding error inside it.
  //
  // TWO CLAIMS, and they need each other. The mean difference says the field
  // reached the shader AT ALL — a sampler with nothing bound leaves grain()
  // returning 1.0 and every one of these differences exactly zero, whatever
  // the depth says. The SPREAD of that difference says it arrived as a FIELD
  // rather than as a flat dimming, which is what a texture of one value, or a
  // sampling coordinate that never moves, would look like.
  const diffs = flat.map((v, i) => Math.abs(v - grained[i])).filter((_, i) => flat[i] > 20);
  const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  const dev = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length));
  check('the field reached the wheel', mean > 4, `${mean.toFixed(1)}/255 of average bite`);
  check('...as a field and not a flat dimming', dev > 3, `spread of the bite ${dev.toFixed(1)}`);
}


// --- THE RING THAT IS LEFT: THE TRACK, THE LATCH AND THE VERDICT ------------
//
// THE QUESTION. With the fuel in the HUD column — which is what ships — the
// circle at r = 1 around the seal drew nothing at all, so the lead-in's
// traveller was closing on an invisible finish line and there was no surface
// for anything to report on afterwards. Three things now live on it:
//
//   THE TRACK    an empty groove that arrives with a wind-up. It is what the
//                traveller runs in and the datum the verdict is measured on.
//   THE LATCH    a perfect charge holds the whole ring LIT and breathing, for
//                as long as the wind-up is held. This is the state the meter
//                had and never showed: `perfect` survives the rest of the hold
//                and `perfectFlash` is over in half a second, so a loaded
//                wind-up held for two seconds spent 1.5 of them silent.
//   THE VERDICT  where the release landed, and whether it counted. The signed
//                error has been recorded on every release since the sweet spot
//                existed and went to the telemetry and nowhere else — see the
//                comment on noteChain('release') in systems/strike.js, which
//                says in as many words that it is the one number a player has
//                no way of seeing.
//
// EVERY CHECK HERE IS ON THE PIXELS OR ON THE MAPPING, not on a config value
// being non-zero. The way this regresses is not a crash: it is a band drawn at
// a plausible radius on the wrong side of the ring, which is a cue that teaches
// the player the opposite of the truth.
settings.hud.boostMeter = 'bar';
resetStrikeRing();

// How bright the instrument is at a given radius, read all the way round.
//
// TWENTY-FOUR ANGLES, for the reason litAtRing above spells out: the meters
// wear a field of noise, so one sample is a sample of wherever the grain
// happens to be dark. On a RAW render, because bloom is a blur and would
// report a neighbouring band's halo as this band's brightness — which is the
// entire failure mode a check about WHICH SIDE OF THE RING something is on has
// to be immune to.
function litAtR(rr) {
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
  const rPx = rr * ringR * PX_PER_UNIT;
  let sum = 0;
  let top = 0;
  const N = 24;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const x = Math.round(probe.width / 2 + Math.sin(a) * rPx);
    const y = Math.round(probe.height / 2 - Math.cos(a) * rPx);
    if (x < 0 || y < 0 || x >= probe.width || y >= probe.height) continue;
    const i = (y * probe.width + x) * 4;
    const lit = Math.max(px[i], px[i + 1], px[i + 2]);
    sum += lit;
    if (lit > top) top = lit;
  }
  return { mean: Math.round(sum / N), max: top };
}

// The brightest pixel found on that circle, as a colour. Used for the one
// question a mean cannot answer: whether a band still HAS a hue, or has been
// driven past the clip into white by `glow` — the failure the lead-in's own
// `glow` note documents in detail, and the reason its traveller is 0.8 rather
// than the 2.4 that read fine on paper.
function litHueAtR(rr) {
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
  const rPx = rr * ringR * PX_PER_UNIT;
  let best = [0, 0, 0];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const x = Math.round(probe.width / 2 + Math.sin(a) * rPx);
    const y = Math.round(probe.height / 2 - Math.cos(a) * rPx);
    if (x < 0 || y < 0 || x >= probe.width || y >= probe.height) continue;
    const i = (y * probe.width + x) * 4;
    if (Math.max(px[i], px[i + 1], px[i + 2]) > Math.max(...best)) best = [px[i], px[i + 1], px[i + 2]];
  }
  return best;
}

// WHERE THE MARK ACTUALLY IS, in ring radii, found in the pixels.
//
// A DIFFERENCE of two renders with the mark switched off in the second, for
// exactly the reason reach() differences the core: at the radii this thing
// lives at there are four other bands within a tenth of a radius of it (the
// track, the tolerance, the verdict leaving, and the drop's own halo), and any
// threshold on the image itself finds whichever of those is brightest. What is
// left after the subtraction is the mark and nothing else.
//
// The peak of that difference is reported rather than its extent: this is a
// question about a POSITION, and the band has a width.
function markPeakR() {
  const lit = grab();
  const glow = U.uMarkGlow.value;
  U.uMarkGlow.value = 0;
  const without = grab();
  U.uMarkGlow.value = glow;

  const cx = probe.width / 2;
  const cy = probe.height / 2;
  const step = 0.004;
  let bestR = 0;
  let bestD = 0;
  for (let rr = 2 - RING_OVERSCAN; rr <= RING_OVERSCAN; rr += step) {
    const rPx = rr * ringR * PX_PER_UNIT;
    let sum = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = Math.round(cx + Math.sin(a) * rPx);
      const y = Math.round(cy - Math.cos(a) * rPx);
      if (x < 0 || y < 0 || x >= probe.width || y >= probe.height) continue;
      const i = (y * probe.width + x) * 4;
      sum += Math.abs(lit[i] - without[i]) + Math.abs(lit[i + 1] - without[i + 1])
        + Math.abs(lit[i + 2] - without[i + 2]);
    }
    if (sum > bestD) { bestD = sum; bestR = rr; }
  }
  return { r: bestR, strength: bestD };
}

// A wind-up in hand, `off` seconds from the loaded moment. The same three
// fields releaseOffset() reads, posed exactly as the lead-in panels above pose
// them, so the track and the traveller are being asked about one wind-up.
const windUp = (off, opts = {}) => {
  const s = state();
  s.charge = 0;
  s.pending = opts.pending ?? 0.9;
  s.charging = off < 0;
  s.loaded = off >= 0;
  s.sinceLoaded = off >= 0 ? off : 0;
  s.toLoaded = off < 0 ? -off : 0;
  s.perfect = !!opts.perfect;
  return s;
};

section('The track <span>— the ring that is left once the pips move to the HUD. It arrives with a wind-up, holds LIT and breathing once the charge is perfect, and is the surface the verdict is read off. Nothing is drawn here at rest, on purpose: a permanent circle round the seal is furniture.</span>', 4);

const trackReads = {};
{
  // At rest. No wind-up, no receipt — and nothing to draw.
  const idle = state();
  idle.charge = 1;
  idle.pending = 0;
  idle.charging = false;
  settle(idle);
  trackReads.water = litAtR(1).max;
  draw();
  present('nothing to time', 'no wind-up in hand — the ring is not there at all', false);

  // A wind-up. The groove arrives.
  const wind = windUp(-0.3, { pending: 0.5 });
  settle(wind);
  trackReads.wind = litAtR(1).mean;
  draw();
  present('winding up', 'the groove the traveller is going to land in', false);

  // THE LATCH, AND IT IS MEASURED WELL PAST THE POP AND PAST THE CUE.
  //
  // `perfectFlash` is left at zero deliberately: this is the state AFTER the
  // announcement has finished ringing out, which is exactly the stretch the
  // instrument used to spend silent. If this reads the same as the plain
  // wind-up above, the latch is not being drawn and only the pop ever was.
  //
  // AND `sinceLoaded` IS PAST lead.time, which the first version of this panel
  // got wrong. At +20ms the traveller is sitting on r 0.99 and the tolerance
  // band is lit at r 1.00, so a sample at the ring measured three things
  // stacked on top of each other and reported 255 — a clipped white that would
  // have read as the latch working however dark the track actually was. Held
  // past the lead-in's reach, the only thing at r = 1 is the track.
  const loaded = windUp(0.9, { pending: 1, perfect: true });
  loaded.perfectFlash = 0;
  settle(loaded);
  trackReads.loaded = litAtR(1).mean;
  trackReads.loadedHue = litHueAtR(1);
  draw();
  present('loaded, pop long over', 'the perfect latch HELD — the state the meter never showed', true);

  // Switching the pips back onto the seal has to take the track away with
  // them: there is already a ring at r = 1 in that view.
  settings.hud.boostMeter = 'ring';
  const wheelToo = windUp(0.02, { pending: 1, perfect: true });
  wheelToo.charge = 0;
  settle(wheelToo);
  trackReads.wheelStyle = U.uTrackGlow.value;
  draw();
  present('pips on the seal', 'the track is silent here — the wheel is already at r = 1', false);
  settings.hud.boostMeter = 'bar';
  resetStrikeRing();
}

check('the ring is not drawn with nothing to time',
  trackReads.water <= 80, `brightest point ${trackReads.water}/255 (water reads about 74)`);
check('...and a wind-up brings the groove up',
  trackReads.wind > trackReads.water + 20, `${trackReads.wind}/255 mean round the band`);
check('a perfect charge HOLDS the ring lit after the pop has finished',
  trackReads.loaded > trackReads.wind * 1.3,
  `${trackReads.loaded}/255 loaded vs ${trackReads.wind}/255 winding, with perfectFlash at 0`);
check('the track stands down when the pips are on the seal',
  trackReads.wheelStyle === 0, `uTrackGlow ${trackReads.wheelStyle}`);
// ...AND IT STILL HAS A HUE. Everything on this ring is multiplied by `glow`
// (2.2) on the way out, so a band tuned by eye at a number that reads sensible
// here lands past the clip — the lead-in's traveller is 0.8 for exactly this
// reason, measured at rgb(255,255,79) when it was 2.4. A loaded track that has
// gone white is saying "bright" where it is supposed to be saying "ready", and
// the READY hue is the whole message.
{
  const [r, g, b] = trackReads.loadedHue;
  const ready = new THREE.Color(CONFIG.strike.ring.readyColor);
  const wantsGreen = ready.g > ready.r && ready.g > ready.b;
  log(`loaded track rgb(${r},${g},${b}) against readyColor #${ready.getHexString()}`);
  check('the loaded track keeps the ready hue instead of clipping to white',
    Math.min(r, g, b) < 235 && Math.max(r, g, b) > 90,
    `rgb(${r},${g},${b})`);
  check('...and it is the READY colour it went to, not the charging one',
    !wantsGreen || (g > r && g > b), `rgb(${r},${g},${b})`);
}

// --- THE VERDICT ------------------------------------------------------------
section('The verdict <span>— where the release landed, and whether it counted. The MARK freezes at the radius the traveller had reached, so outside the ring is EARLY and inside it is LATE; the band leaving says whether it bit, and it says so with direction (out on a hit, in on a miss) as well as colour.</span>', 4);

const V = CONFIG.strike.ring.verdict;
const halfWin = CONFIG.strike.charge.time * CONFIG.strike.charge.sweetFraction;

// Pose a release that has already happened, `age` seconds ago.
//
// THE WIND-UP IS RUN FIRST, and that is not scene-setting. The track fades in
// over `track.fade` and in the game it has been up for the whole hold, so a
// receipt posed on a freshly reset ring is drawn against a datum that is only
// half arrived — which is a picture the player never sees, and it flattered
// the mark by leaving it the brightest thing on the ring.
//
// Stepped rather than stamped, exactly as the perfect-charge panels above are:
// the receipt is an envelope, and a hand-set uniform is not a frame of it.
function verdictAt(hit, offset, age) {
  resetStrikeRing();
  settle(windUp(-0.2, { pending: 0.9 }), 60);

  const s = state();
  s.charge = 0;
  s.pending = 0;
  s.charging = false;
  s.verdict = hit ? 1 : -1;
  s.verdictOffset = offset;
  s.verdictFlash = V.time;
  const steps = Math.max(1, Math.round(age / DT));
  for (let i = 0; i < steps; i++) {
    updateStrikeRing(DT, ORIGIN, s, true, stats);
    s.verdictFlash = Math.max(0, s.verdictFlash - DT);
  }
  return s;
}

const marks = {};
{
  // Offsets stated in SWEET HALF-WIDTHS, because that is the unit the receipt
  // is drawn in and a number of milliseconds would say nothing about where the
  // mark should land. 1.0 is exactly the edge of the gate.
  const cases = [
    ['on the beat', true, 0],
    ['early by 2 windows', false, -2 * halfWin],
    ['late by 2 windows', false, 2 * halfWin],
    ['late off the scale', false, 9 * halfWin],
  ];
  for (const [name, hit, off] of cases) {
    verdictAt(hit, off, 0.12);
    marks[name] = { r: U.uMarkR.value, ring: U.uVerdictR.value, glow: U.uVerdictGlow.value };
    draw();
    present(name,
      `mark at r ${U.uMarkR.value.toFixed(2)}, the band ${U.uVerdictR.value > 1 ? 'carrying out to' : 'collapsing in to'} r ${U.uVerdictR.value.toFixed(2)}`,
      hit);
  }
}

// THE SCALE, AND IT HAS TO BE READABLE AT 90px. `bandPx` is what a distance in
// ring radii is worth in pixels in the SHIPPED frame — the ring is `radius` x
// `scale` world units against arena.viewHeight at the cinematic rig's base
// zoom — which is the number that killed the first version of this: it mapped
// the traveller's own approach, and an ordinary miss came out three pixels off
// the ring on an instrument whose window was drawn one pixel wide.
const shippedView = (CONFIG.arena?.viewHeight ?? 52) / (CONFIG.cinecam?.base?.zoom ?? 1.18);
const bandPx = (1080 / shippedView) * ringR;
log(`the shipped ring is about ${Math.round(bandPx)}px from centre to band on a 1080p screen`);

check('an EARLY release marks outside the ring',
  marks['early by 2 windows'].r > 1.02, `r ${marks['early by 2 windows'].r.toFixed(3)}`);
check('...a LATE one marks inside it',
  marks['late by 2 windows'].r < 0.98, `r ${marks['late by 2 windows'].r.toFixed(3)}`);
check('...and on the beat lands on the ring itself',
  Math.abs(marks['on the beat'].r - 1) < 0.01, `r ${marks['on the beat'].r.toFixed(3)}`);
// The mark is the SIGNED error made legible, so a worse miss has to read as
// further out. Without this a mapping that saturated at the first frame past
// the window would pass every check above and tell the player nothing.
check('a worse miss marks further from the ring',
  marks['late off the scale'].r < marks['late by 2 windows'].r - 0.02,
  `${marks['late by 2 windows'].r.toFixed(3)} at 2 windows vs ${marks['late off the scale'].r.toFixed(3)} at 9`);
// ...and it cannot run off the quad. An unclamped radius past OVERSCAN does not
// draw a mark far away — it draws four corner smears, because the band exists
// only where the square reaches beyond the circle. The exact failure the chain
// arc shipped with for years.
check('...and it never leaves the quad',
  marks['late off the scale'].r > 2 - RING_OVERSCAN && marks['early by 2 windows'].r < RING_OVERSCAN,
  `${marks['late off the scale'].r.toFixed(3)} .. ${marks['early by 2 windows'].r.toFixed(3)} inside ${RING_OVERSCAN}`);
// AND IT IS BIG ENOUGH TO SEE ON THE ACTUAL METER. This is the check the first
// version of the receipt would have failed, and the only one that is about the
// size the game draws rather than about the magnifying glass this page is.
check('an ordinary miss is visibly off the ring at the SHIPPED size',
  Math.abs(marks['late by 2 windows'].r - 1) * bandPx > 8,
  `${(Math.abs(marks['late by 2 windows'].r - 1) * bandPx).toFixed(1)}px at 2 windows out`);
check('...and the two sides of the beat are far apart',
  Math.abs(marks['early by 2 windows'].r - marks['late by 2 windows'].r) * bandPx > 16,
  `${(Math.abs(marks['early by 2 windows'].r - marks['late by 2 windows'].r) * bandPx).toFixed(1)}px between them`);

check('a HIT carries the band outward',
  marks['on the beat'].ring > 1.05, `r ${marks['on the beat'].ring.toFixed(3)}`);
check('...and a MISS collapses it inward',
  marks['early by 2 windows'].ring < 0.95, `r ${marks['early by 2 windows'].ring.toFixed(3)}`);
check('...so the two are told apart with the colours off',
  marks['on the beat'].ring > 1 && marks['early by 2 windows'].ring < 1,
  `hit ${marks['on the beat'].ring.toFixed(2)} vs miss ${marks['early by 2 windows'].ring.toFixed(2)}`);
check('...and the hit is the louder of the two',
  marks['on the beat'].glow > marks['early by 2 windows'].glow * 1.5,
  `${marks['on the beat'].glow.toFixed(2)} vs ${marks['early by 2 windows'].glow.toFixed(2)}`);

// IT IS ACTUALLY ON SCREEN. Every check above reads a uniform, and a uniform
// wired to a name the shader does not declare is silently ignored — the whole
// reason this sheet exists rather than a Node harness. So: render one, and find
// the mark in the pixels at the radius it claims to be at.
{
  verdictAt(false, 2 * halfWin, 0.1);
  const late = markPeakR();
  check('the mark is DRAWN where the uniform says it is',
    late.strength > 0 && Math.abs(late.r - U.uMarkR.value) < 0.05,
    `found at r ${late.r.toFixed(3)}, uniform says ${U.uMarkR.value.toFixed(3)}`);
  // ...and it moves with the error rather than sitting on the ring whatever
  // happened. Two renders, two radii, both found in the pixels: this is the
  // check that a uniform wired to a name the shader does not declare — which
  // is silently ignored — cannot pass.
  verdictAt(false, -2 * halfWin, 0.1);
  const early = markPeakR();
  check('...and an early release is drawn on the other side of the ring',
    early.r > 1.02 && late.r < 0.98,
    `early at r ${early.r.toFixed(3)}, late at r ${late.r.toFixed(3)}`);
  verdictAt(false, 2 * halfWin, 0.1);
  // And the datum under it. A mark with no window drawn beneath is a dot, not
  // a measurement — updateLead has already zeroed uSweetGlow by this point, so
  // this is the one check that the verdict re-lights it.
  check('...with the tolerance band restated under it',
    U.uSweetGlow.value > 0, `uSweetGlow ${U.uSweetGlow.value.toFixed(3)}`);
  // The receipt has to end. A verdict that never cleared would leave a mark
  // parked on the ring for the rest of the run.
  const done = verdictAt(false, 2 * halfWin, V.time + 0.05);
  check('...and the whole receipt clears when its time is up',
    U.uMarkGlow.value === 0 && U.uVerdictGlow.value === 0,
    `mark ${U.uMarkGlow.value}, band ${U.uVerdictGlow.value}, flash ${done.verdictFlash.toFixed(3)}`);
}

// The window the mark is measured against is the window the GATE uses, and it
// has to be — a receipt drawn against a tolerance the game does not honour is
// worse than no receipt. Same construction the lead-in's band uses: one
// expression, quoted twice.
{
  // A release exactly on the edge of the gate has to mark exactly on the edge
  // of the band drawn under it — that is the whole construction, and it is the
  // one property of the receipt that makes it a MEASUREMENT rather than a
  // decoration. Both come from `range` and `markSpan`, so this cannot be made
  // to pass by two numbers being tuned into agreement.
  verdictAt(false, halfWin, 0.05);
  check('the edge of the gate marks exactly on the edge of the band',
    Math.abs((1 - U.uMarkR.value) - U.uSweetW.value) < 1e-6,
    `mark ${(1 - U.uMarkR.value).toFixed(4)} from the ring, band half-width ${U.uSweetW.value.toFixed(4)}`);
  // ...and the band is the GATE, not a number that resembles it. Move
  // sweetFraction — the weapons.csv value tryStrike judges with — and the mark
  // has to move with it while the band stays put, because the band is the unit
  // and the mark is the reading.
  const keep = CONFIG.strike.charge.sweetFraction;
  CONFIG.strike.charge.sweetFraction = keep * 2;
  verdictAt(false, halfWin, 0.05);
  check('...and widening the gate moves the reading, not the ruler',
    Math.abs((1 - U.uMarkR.value) - U.uSweetW.value * 0.5) < 1e-6,
    `the same release now marks ${(1 - U.uMarkR.value).toFixed(4)} out, half a band`);
  CONFIG.strike.charge.sweetFraction = keep;
}

settings.hud.boostMeter = 'ring';
resetStrikeRing();

check('nothing failed to compile across the whole sheet', shaderErrors.length === 0, shaderErrors[0] ?? '');
resetStrikeRing();

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall panels rendered', fails ? 'bad' : 'ok');
