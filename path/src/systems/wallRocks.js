import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';
import { CONFIG } from '../config.js';
import { ASSETS, getAssetSizeMultiplier } from '../assets.js';
import { bounds, seabedTopY, maxWaveExcursion, midWater } from '../arena.js';
import { versusActive } from './versusFlag.js';
import { goalColors } from './ballLook.js';
import { NOISE_FIELD_GLSL } from './noiseGlsl.js';

// The walls, made visible.
//
// clampToArena has always stopped the seal dead at bounds.left / bounds.right,
// and for as long as the arena was exactly the frame that was fine — you hit
// the edge of the screen, which is a boundary everyone already understands.
// `arena.widthScale` moved the walls out into open water, where a seal that
// stops swimming in the middle of nothing reads as a bug rather than a shore.
// So: a rock face at each wall, tall enough to be the thing you stop against.
//
// It is SCENERY, not collision. The wall is still clampToArena and this does
// not know the player exists — which is deliberate, because two sources of
// truth for where the world ends is exactly how a rock ends up somewhere the
// seal can swim through. The stack is instead built to land its inner face on
// the line the seal actually stops at, so the two agree by construction.
//
// Rebuilt on resize like the grid, and for the same reason: every number here
// comes off `bounds`, which moves when the window or the tuner does.

// One shared unit boulder, transformed per instance. Building a fresh
// IcosahedronGeometry per rock and displacing it individually would be the
// obvious way and costs an allocation and a noise walk for each — this walks
// the noise once per SHAPE and reuses it, which is what keeps a 60-boulder
// wall inside a rebuild the resize can afford.
const SHAPE_VARIANTS = 5;

/**
 * Deterministic RNG. The stack has to survive a rebuild unchanged: the
 * backdrop is torn down on every resize, and a wall that reshuffles its
 * boulders when you drag the window reads as the scenery glitching rather
 * than as the window resizing.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noise = new ImprovedNoise();

/**
 * A lumpy unit-radius boulder. The displacement is two octaves of 3D noise on
 * the vertex direction, so neighbouring faces move together and the result is
 * a worn rock rather than a sea urchin — one octave at this amplitude is a
 * smooth blob and three is visually indistinguishable from two.
 *
 * Non-indexed and flat-shaded on purpose: faceted rock catches the key light
 * in a way a smooth normal cannot, and the game's whole backdrop is flat.
 */
function boulderShape(seed, detail, roughness) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.noise(v.x * 1.6 + seed, v.y * 1.6 + seed, v.z * 1.6 + seed) * 0.7
            + noise.noise(v.x * 3.9 - seed, v.y * 3.9 - seed, v.z * 3.9 - seed) * 0.3;
    v.multiplyScalar(1 + n * roughness);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  // IcosahedronGeometry is already non-indexed in this three; calling
  // toNonIndexed() anyway only earns a console warning per boulder.
  return geo.index ? geo.toNonIndexed() : geo;
}

// How deep the drawn face is, in world units past the wall — at its THINNEST
// point, which is the only measurement the camera can safely spend. The
// cinematic rig is allowed to drift the frame a little past bounds.left /
// bounds.right so the edge of the ocean isn't a hard stop (see clampFocus in
// world.js), and what it may spend is exactly this: drift further than the
// face is deep and the frame shows open water OUTSIDE the shore at whichever
// height the stack happens to be meanest, which is the one thing the shore
// exists to prevent.
//
// Measured off the merged triangles rather than off the boulder radii,
// because the radii are pre-rotation: a boulder is scaled unequally on three
// axes and then spun, so its x-extent is not any of the numbers that built it.
//
// SCANLINES, NOT VERTICES. Bucketing vertices leaves an empty bucket wherever
// a triangle spans one without landing a corner in it, and an empty bucket
// reads as a hole in a face that has none — the first version of this
// reported zero cover on the shipped wall. Intersecting each triangle with
// the scanline IS the silhouette, and costs one pass over a geometry that was
// only just built. A quarter-unit step: measured against a sweep twenty times
// finer, the thinnest point of the shipped wall is a broad minimum rather than
// a spike, and both sweeps report the same 1.84.
const COVER_STEP = 0.25;

// THE PUBLISHED SHORE — what the rest of the game is allowed to know about a
// wall it cannot import. Published rather than pushed, the same arrangement
// cineLens uses: the geometry belongs to this file, the decisions taken off it
// belong to the caller, and neither should reach into the other.
//
// Two numbers, both MEASURED off the built stack (see measureShore), both zero
// until one exists — with no shore drawn there is nothing to hide behind, and
// every reader below correctly falls back to the behaviour it had before the
// wall was ever built.
export const shore = {
  // Units of drawn face past each wall, at the face's thinnest point.
  cover: 0,
  // Is there a stack at all? `hideZ` of zero is a legitimate measurement, so
  // the readers cannot use it as their own "no shore" sentinel.
  built: false,
  // The z a body has to sit BEHIND to be hidden by that face — the frontmost
  // rock surface at whichever height the stack reaches furthest toward the
  // camera, less a margin. The camera is orthographic, so a body moved in z
  // does not move, resize or shift on screen by so much as a pixel: all that
  // changes is what draws in front of what. That is the whole trick the
  // entrance is built on — a creature spawned back here is behind the cliff,
  // and easing forward into its swimming lane afterwards is invisible.
  hideZ: 0,
  // How far PAST the wall's line the drawn face sits, in world units — the
  // seal's nose past its hit circle (see `nose` in build). The wall the seal
  // stops at and the rock it stops against are two units apart on purpose,
  // and anything that has to touch the ROCK rather than the wall — the
  // versus ball off the goal's posts — wants this, not bounds.left.
  face: 0,
};

// How far past the wall the frame may drift, which is the smaller of what the
// tuner asks for and what the rock can actually cover. world.js's clampFocus
// spends it and the spawner reads it to know where "off screen" starts — one
// function rather than the same `Math.min` written in both files, because the
// two must not be able to disagree about where the edge of the picture is.
export function shoreOverscan() {
  return Math.max(0, Math.min(CONFIG.camera?.edgeDrift ?? 0, shore.cover));
}

// THE GOAL MOUTHS — a versus match cuts a hole in each wall. The band is
// read off the same two numbers systems/versusGoal.js publishes (goal.halfHeight
// about midwater); it is not imported from there because that module reads
// shoreOverscan() from this one, and the shore is built before a match starts.
// Null in every other mode, so nothing below changes for the ordinary game.
function goalMouth() {
  if (!versusActive()) return null;
  const g = CONFIG.versus?.goal ?? {};
  if (g.holes === false) return null;
  const h = g.halfHeight ?? 7;
  const gy = midWater();
  return {
    lo: gy - h, hi: gy + h, tunnel: Math.max(1, g.tunnel ?? 14),
    glow: Math.max(0, g.glow ?? 3), spill: Math.max(0, g.spill ?? 6), feather: Math.max(0.05, Math.min(1, g.feather ?? 0.55)),
    noise: g.noise ?? {},
    swim: g.swim ?? {},
    scored: g.scored ?? {},
    colors: goalColors(),
    // THE CORRIDOR IS OPEN — see the tunnel block in build(). The band runs
    // clear from the face to the back with nothing across it, and what closes
    // it off is LIGHT rather than rock: `backShade` of the colour as a solid
    // plane so the scene background can never show through, and the glow on
    // top of it.
    open: (g.openBack ?? true) !== false,
    backShade: Math.max(0, g.backShade ?? 0.22),
    // HOW FAR PAST THE TUNNEL'S BACK the light and its slab keep going — one
    // camera reach, so the far end where they finally fade is beyond the
    // furthest frame edge a match (or a replay) can put out there. See
    // goalQuad. Read off CONFIG rather than versusGoal.cameraReach() because
    // that module imports this one.
    reach: Math.max(0, CONFIG.versus?.camera?.reach ?? 12),
  };
}

/**
 * THE LIGHT'S RECTANGLE for one mouth — shared by the glow quad and the slab
 * behind it, so the two can never end in different places and show a seam
 * where one stops.
 *
 * It runs from `spill` in front of the drawn face to a whole camera reach past
 * the tunnel's BACK, and `spill` past each lip. Every one of those four rims
 * is where the falloff (goalFalloff in the shader) has already reached zero,
 * so the quad has no edge anywhere — including the far end, which is off the
 * frame besides.
 */
function goalQuad(mouth, faceX, side) {
  const midY = (mouth.lo + mouth.hi) * 0.5;
  const halfH = (mouth.hi - mouth.lo) * 0.5;
  const inner = faceX - side * mouth.spill;
  const end = faceX + side * (mouth.tunnel + mouth.reach + mouth.spill);
  return {
    w: Math.abs(end - inner),
    h: (halfH + mouth.spill) * 2,
    cx: (inner + end) * 0.5,
    cy: midY,
    faceX, endX: end, midY, halfH,
  };
}

/** goalQuad's numbers onto a light's or a slab's uniforms. */
function applyGoalShape(u, q, side, mouth) {
  u.uSide.value = side;
  u.uFaceX.value = q.faceX;
  u.uEndX.value = q.endX;
  u.uMidY.value = q.midY;
  u.uHalfH.value = q.halfH;
  u.uSpill.value = Math.max(1e-3, mouth.spill);
  u.uFeather.value = mouth.feather;
}

/** Resize a quad in place to the span goalQuad describes. */
function fitGoalQuad(mesh, q) {
  if (mesh.geometry.parameters.width !== q.w || mesh.geometry.parameters.height !== q.h) {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(q.w, q.h);
  }
  mesh.position.x = q.cx;
  mesh.position.y = q.cy;
}

function measureShore(geo, mouth = null) {
  // The band that has to stay hidden: from the top of the seabed (below it the
  // floor strip is opaque and overscans the arena on its own) up to the
  // highest the water ever reaches. Above that line there is nothing behind
  // the wall but sky, which is the same sky either side of it.
  const stormAmp = CONFIG.arena.waveAmplitude * Math.max(1, CONFIG.weather?.sea?.amp ?? 1);
  const lo = seabedTopY();
  const hi = bounds.surfaceY + maxWaveExcursion(stormAmp, 1);
  const n = Math.max(2, Math.ceil((hi - lo) / COVER_STEP) + 1);
  const right = new Float64Array(n).fill(-Infinity);
  const left = new Float64Array(n).fill(-Infinity);
  // The frontmost rock surface at each height, per wall — the other half of
  // the sweep, and the one the entrance is measured from.
  const rightZ = new Float64Array(n).fill(-Infinity);
  const leftZ = new Float64Array(n).fill(-Infinity);

  const pos = geo.attributes.position;
  const ax = [0, 0, 0];
  const ay = [0, 0, 0];
  for (let t = 0; t + 2 < pos.count; t += 3) {
    let yLo = Infinity, yHi = -Infinity;
    // The triangle's own frontmost corner, used for the whole triangle. It
    // OVERSTATES how far forward the surface reaches at any given scanline,
    // which is the safe direction to be wrong in: the answer is a depth
    // something has to get behind, so overstating the face only ever buries
    // the hider deeper than it strictly needed to go.
    let zHi = -Infinity;
    for (let k = 0; k < 3; k++) {
      ax[k] = pos.getX(t + k);
      ay[k] = pos.getY(t + k);
      const z = pos.getZ(t + k);
      if (ay[k] < yLo) yLo = ay[k];
      if (ay[k] > yHi) yHi = ay[k];
      if (z > zHi) zHi = z;
    }
    // Which wall this triangle belongs to. The two stacks never meet, so one
    // corner's sign decides it.
    const outward = ax[0] > 0 ? right : left;
    const front = ax[0] > 0 ? rightZ : leftZ;
    const i0 = Math.max(0, Math.ceil((yLo - lo) / COVER_STEP));
    const i1 = Math.min(n - 1, Math.floor((yHi - lo) / COVER_STEP));
    for (let i = i0; i <= i1; i++) {
      const y = lo + i * COVER_STEP;
      let far = -Infinity;
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        const y0 = ay[k], y1 = ay[j];
        if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
          const f = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
          const x = ax[k] + (ax[j] - ax[k]) * f;
          // Outward is +x on the right wall and -x on the left, so both sides
          // are reduced to "units past the wall" before they are compared.
          const d = outward === right ? x - bounds.right : bounds.left - x;
          if (d > far) far = d;
        }
      }
      if (far > outward[i]) outward[i] = far;
      // Only from triangles that are actually ON the face. A boulder's back
      // half spans the same scanlines and reaches nowhere near the wall, and
      // letting it into this figure would be measuring the depth of rock the
      // camera never sees.
      if (far > 0 && zHi > front[i]) front[i] = zHi;
    }
  }

  let worst = Infinity;
  // The mouth's scanlines are a hole ON PURPOSE, and they are left out of both
  // figures below: folded in, `cover` would read zero and the camera would
  // stop dead on the wall in a match — the one mode where a frame that can
  // drift into the hole is the whole point of there being a hole.
  const skipLo = mouth ? Math.max(0, Math.ceil((mouth.lo - lo) / COVER_STEP)) : 1;
  const skipHi = mouth ? Math.min(n - 1, Math.floor((mouth.hi - lo) / COVER_STEP)) : 0;
  // The SHALLOWEST covering face over the whole band. A body behind this one
  // number is behind the rock at every height, so the entrance needs a single
  // depth rather than a lookup — and the height a creature enters at is rolled
  // long before anything asks how deep the wall is there.
  let front = Infinity;
  for (let i = 0; i < n; i++) {
    if (i >= skipLo && i <= skipHi) continue;
    worst = Math.min(worst, Math.max(0, right[i] === -Infinity ? 0 : right[i]));
    worst = Math.min(worst, Math.max(0, left[i] === -Infinity ? 0 : left[i]));
    // A scanline with no face on it is a hole, and `worst` has already gone to
    // zero for it. Skipped rather than folded in as -Infinity, which would
    // otherwise put the hiding depth at negative infinity off one gap.
    if (rightZ[i] > -Infinity) front = Math.min(front, rightZ[i]);
    if (leftZ[i] > -Infinity) front = Math.min(front, leftZ[i]);
  }
  return {
    cover: Number.isFinite(worst) ? worst : 0,
    front: Number.isFinite(front) ? front : 0,
  };
}

/**
 * The goal's light: an unlit additive quad in `color` times `glow`, shaped by
 * goalFalloff below — flat across the whole mouth and all the way down the
 * corridor, fading to nothing only over the `spill` past the face and past the
 * lips. `glow` is the overdrive: the composite's bloom thresholds on
 * luminance, and the light has to clear it comfortably to bloom the way a goal
 * should, so this is meant to sit well above 1. toneMapped off, because the
 * overdrive IS the look and tone mapping would fold it back toward 1.
 *
 * It used to be one ELLIPSE over the quad, which meant the light's shape was
 * the quad's shape: it could not be lengthened without changing how it looked,
 * and pushed into the goal the camera saw the ellipse's own far rim. The
 * falloff is measured off the MOUTH now — the face, the two lips — so the quad
 * can run a camera reach past the tunnel's back and take its far end off the
 * frame entirely.
 */
// The live glow quads, for the F panel: a slider on CONFIG.versus.goal moves
// these in place (refreshGoalGlow) rather than waiting for the next resize
// to rebuild the shore.
const goalGlows = [];
// ...and the slab behind each of them, which the same sliders size. It is the
// same rectangle as the light and carries the same falloff, so it is solid
// wherever the corridor would otherwise be a window onto the backdrop and has
// faded out wherever the light has — the two cannot end in different places
// and leave a step in the water. It used to be an OPAQUE rectangle stopping
// dead at the drawn face, and that hard vertical edge was the seam you saw
// looking into the goal.
const goalBacks = [];

// THE SCORE'S COLOUR — see CONFIG.versus.goal.scored. `side` is the mouth the
// ball went into, `team` the index whose colour it takes for a beat; `t` is
// wall seconds since the goal, running rise → hold → fall. team -1 is nobody,
// which is what every mouth is in ordinary play.
const scoredFlash = { side: 0, team: -1, t: 0 };

/**
 * A goal went in on `side` (-1 the left mouth, +1 the right) and `team` put it
 * there: that mouth takes the scorer's colour and blazes, then hands it back.
 * versus.js's goal() calls this. Idempotent — a second goal restarts the
 * envelope rather than stacking on it.
 */
export function flashGoalScored(side, team) {
  scoredFlash.side = side < 0 ? -1 : 1;
  scoredFlash.team = team === 1 ? 1 : 0;
  scoredFlash.t = 0;
  paintGoalColors();
  return scoredFlash;
}

/** No mouth is anybody's but its own again — a kickoff, a reset, a match ending. */
export function clearGoalScored() {
  scoredFlash.team = -1;
  scoredFlash.t = 0;
  paintGoalColors();
}

/**
 * How far the flash has taken `side`, 0..1 — the envelope, not a colour. Zero
 * for the mouth that was not scored in and for every mouth once it has run.
 */
function scoredMix(mouth, side) {
  if (scoredFlash.team < 0 || side !== scoredFlash.side) return 0;
  const s = mouth.scored ?? {};
  if (s.enabled === false) return 0;
  const rise = Math.max(0, s.rise ?? 0.08);
  const hold = Math.max(0, s.hold ?? 1.7);
  const fall = Math.max(0, s.fall ?? 1.2);
  const t = scoredFlash.t;
  if (t <= rise) return rise > 0 ? t / rise : 1;
  if (t <= rise + hold) return 1;
  if (fall <= 0) return 0;
  return Math.max(0, 1 - (t - rise - hold) / fall);
}

const _flashColor = new THREE.Color();

/**
 * Every light's colour and overdrive, from the mouth's own team plus whatever
 * the flash is doing to it. Called by refreshGoalGlow (a slider moved) and by
 * tickGoalGlow (the envelope moved), so the two can never disagree about what
 * colour a mouth is — which is what a flash written in only one of them would
 * have arranged the first time the F panel was touched during a goal.
 */
function paintGoalColors(mouth = goalMouth()) {
  if (!mouth) return 0;
  const s = mouth.scored ?? {};
  let painted = 0;
  for (const { mesh, side } of goalBacks) {
    const k = scoredMix(mouth, side);
    const own = mouth.colors[side < 0 ? 0 : 1];
    _flashColor.set(k > 0 ? mouth.colors[scoredFlash.team] : own);
    mesh.material.uniforms.uColor.value.set(own).lerp(_flashColor, k)
      .multiplyScalar(mouth.backShade * (1 + k * ((s.backShade ?? 1.5) - 1)));
  }
  for (const { mesh, side } of goalGlows) {
    const k = scoredMix(mouth, side);
    const own = mouth.colors[side < 0 ? 0 : 1];
    _flashColor.set(k > 0 ? mouth.colors[scoredFlash.team] : own);
    mesh.material.uniforms.uColor.value.set(own).lerp(_flashColor, k);
    mesh.material.uniforms.uGlow.value = mouth.glow * (1 + k * ((s.glow ?? 1.9) - 1));
    painted++;
  }
  return painted;
}

export function refreshGoalGlow() {
  const mouth = goalMouth();
  if (!mouth) return 0;
  for (const { mesh, side } of goalBacks) {
    const q = goalQuad(mouth, mesh.userData.faceX, side);
    applyGoalShape(mesh.material.uniforms, q, side, mouth);
    fitGoalQuad(mesh, q);
  }
  for (const { mesh, side } of goalGlows) {
    const u = mesh.material.uniforms;
    const q = goalQuad(mouth, mesh.userData.faceX, side);
    applyGoalShape(u, q, side, mouth);
    fitGoalQuad(mesh, q);
    applyGlowNoise(u, mouth.noise);
    applyGlowSwim(u, mouth.swim);
  }
  paintGoalColors(mouth);
  return goalGlows.length;
}

/** The noise block of CONFIG.versus.goal onto a light's uniforms. */
function applyGlowNoise(u, n = {}) {
  u.uNoiseOn.value = n.enabled === false ? 0 : 1;
  u.uNoiseAmount.value = Math.max(0, Math.min(1, n.amount ?? 0.55));
  u.uNoiseScale.value = Math.max(0.1, n.scale ?? 6);
  u.uNoiseSpeed.value = n.speed ?? 0.35;
  u.uNoiseDrift.value.set(n.driftX ?? 0.6, n.driftY ?? 0.25);
  u.uNoiseContrast.value = Math.max(0.05, n.contrast ?? 1.4);
}

/** ...and the seals' block — how hard a swimmer and a burst may stir it. */
function applyGlowSwim(u, s = {}) {
  u.uSwimOn.value = s.enabled === false ? 0 : 1;
  u.uSwimPush.value = s.push ?? 3.4;
  u.uSwimSwirl.value = s.swirl ?? 1.2;
  u.uSwimDrag.value = s.drag ?? 0.05;
  u.uSwimChurn.value = s.churn ?? 1.8;
  u.uPulseSpeed.value = Math.max(0, s.ringSpeed ?? 30);
  u.uPulseLife.value = Math.max(1e-3, s.ringLife ?? 1.2);
  u.uPulseWidth.value = Math.max(0.1, s.ringWidth ?? 5);
  u.uPulsePush.value = s.ringPush ?? 5;
  u.uPulseLight.value = s.ringLight ?? 0.5;
}

// ---------------------------------------------------------------------------
// THE SEALS IN THE FIELD — see CONFIG.versus.goal.swim.
//
// Two swimmers and four rings, held here as plain numbers and written onto
// every light's uniforms once a frame by tickGoalGlow. versus.js is what
// knows where the seals are and hands them over (setGoalSwimmers); nothing in
// this module reaches for the player, which is what keeps the shore a leaf.
//
// A ring carries its BIRTH TIME rather than its age, so the shader ages it
// off the same uTime the noise churns on and a frame that skips the tick
// cannot leave one hanging. Strength 0 is a dead slot.
// ---------------------------------------------------------------------------

const SWIMMERS = 2;
const PULSES = 4;
const swimmers = Array.from({ length: SWIMMERS }, () => ({ x: 0, y: 0, vx: 0, vy: 0, reach: 0, speed: 0 }));
const pulses = Array.from({ length: PULSES }, () => ({ x: 0, y: 0, t0: -1e9, strength: 0 }));
let pulseNext = 0;

/**
 * Where the seals are this frame — an array of up to two { x, y, vx, vy }, or
 * an empty one for none. `reach` per swimmer comes off the tuning; a null or
 * missing entry parks that slot at reach 0, which the shader skips.
 */
export function setGoalSwimmers(list = []) {
  const s = CONFIG.versus?.goal?.swim ?? {};
  const reach = s.enabled === false ? 0 : Math.max(0, s.reach ?? 28);
  for (let i = 0; i < SWIMMERS; i++) {
    const src = list[i];
    const w = swimmers[i];
    if (!src) { w.reach = 0; w.speed = 0; continue; }
    w.x = src.x ?? 0; w.y = src.y ?? 0;
    w.vx = src.vx ?? 0; w.vy = src.vy ?? 0;
    w.reach = reach;
    // Normalised on the burst threshold and capped at 1, so `churn` is a
    // number in the field's own units rather than one that has to be retuned
    // every time a seal's top speed moves.
    w.speed = Math.min(1, Math.hypot(w.vx, w.vy) / Math.max(1, s.burst ?? 46));
  }
  return swimmers;
}

/**
 * Throw a ring into the field at (x, y). `strength` scales how hard it shoves
 * and how brightly it passes. Round-robin over four slots: a fifth ring takes
 * the oldest one's place rather than being dropped, so the newest burst is
 * always the one you can see.
 */
export function goalGlowImpulse(x, y, strength = 1) {
  const p = pulses[pulseNext];
  pulseNext = (pulseNext + 1) % PULSES;
  p.x = x; p.y = y; p.t0 = glowClock; p.strength = Math.max(0, strength);
  return p;
}

/** The live stir, for the harnesses and the F panel's readouts. */
export const goalGlowState = { swimmers, pulses, scored: scoredFlash, get clock() { return glowClock; } };

/** Everything the seals put in the field, gone — a match starting or ending. */
export function resetGoalStir() {
  for (const w of swimmers) { w.reach = 0; w.speed = 0; }
  for (const p of pulses) { p.strength = 0; p.t0 = -1e9; }
  pulseNext = 0;
  scoredFlash.team = -1;
  scoredFlash.t = 0;
}

// THE LIGHT'S CLOCK — wall seconds, advanced by whoever owns the wall clock
// (systems/versus.js's updateVersusClock), so the noise keeps churning
// through the goal's freeze and the replay rather than stopping with the
// water. One clock for both lights; the two are offset in the shader by side.
let glowClock = 0;
export function tickGoalGlow(dt) {
  if (!(dt > 0)) return glowClock;
  glowClock += dt;
  if (scoredFlash.team >= 0) scoredFlash.t += dt;
  for (const { mesh } of goalGlows) {
    const u = mesh.material.uniforms;
    u.uTime.value = glowClock;
    for (let i = 0; i < SWIMMERS; i++) {
      const w = swimmers[i];
      u.uSwim.value[i].set(w.x, w.y, w.reach, w.speed);
      u.uSwimVel.value[i].set(w.vx, w.vy);
    }
    for (let i = 0; i < PULSES; i++) {
      const p = pulses[i];
      u.uPulse.value[i].set(p.x, p.y, p.t0, p.strength);
    }
  }
  // The flash is a colour and an overdrive, and both move every frame it is
  // running — one repaint while it is, none at all when it is not.
  if (scoredFlash.team >= 0) {
    const mouth = goalMouth();
    paintGoalColors(mouth);
    // Run out: hand the mouth back before the next frame asks, so nothing
    // downstream has to know the envelope's shape to know whose light it is.
    if (mouth && scoredMix(mouth, scoredFlash.side) <= 0
        && scoredFlash.t > (mouth.scored?.rise ?? 0.08)) scoredFlash.team = -1;
  }
  return glowClock;
}

// THE MOUTH'S SHAPE, in world units — shared verbatim by the light and the
// slab behind it so the two fade out together and there is no step where one
// of them stops. Every distance is measured off the mouth (the drawn face, the
// two lips) and none off the quad, which is what lets the quad be as long as
// it likes: lengthening it moves only `uEndX`, a whole camera reach past the
// tunnel's back and therefore off the frame.
//
// Flat at 1 across the whole mouth and the whole corridor, then `uSpill` units
// of falloff on each side — `uFeather` of that spill is the fade and the rest
// holds. The three edges are: out into the water in front of the face, up and
// down past the lips into the rock, and the far end down the corridor.
const GOAL_FALLOFF_GLSL = `
  uniform float uFeather;
  uniform float uSide;
  uniform float uFaceX;
  uniform float uEndX;
  uniform float uMidY;
  uniform float uHalfH;
  uniform float uSpill;
  float goalFalloff(vec2 world) {
    float hold = uSpill * (1.0 - uFeather);
    float inward = max(0.0, (uFaceX - world.x) * uSide);
    float pastLip = max(0.0, abs(world.y - uMidY) - uHalfH);
    float toEnd = max(0.0, (uEndX - world.x) * uSide);
    float a = 1.0 - smoothstep(hold, uSpill, inward);
    a *= 1.0 - smoothstep(hold, uSpill, pastLip);
    a *= smoothstep(0.0, uSpill, toEnd);
    return a;
  }
`;

/** The uniforms GOAL_FALLOFF_GLSL declares, at their defaults. */
function goalShapeUniforms(side) {
  return {
    uFeather: { value: 0.55 },
    uSide: { value: side },
    uFaceX: { value: 0 },
    uEndX: { value: 0 },
    uMidY: { value: 0 },
    uHalfH: { value: 1 },
    uSpill: { value: 6 },
  };
}

/**
 * THE CORRIDOR'S FAR END, and the only thing in the mouth that is not
 * additive: the team's colour at `backShade`, drawn over the same rectangle as
 * the light and with the same falloff. Solid through the band and down the
 * corridor, so the open corridor is never a window onto the backdrop; faded to
 * nothing by the time it reaches the water in front of the face, so it is not
 * a dark rectangle standing in the open either. Not squared, unlike the light:
 * it has to hold its opacity right out to the lips.
 */
export function goalBackMaterial(color, shade, side = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color).multiplyScalar(shade) },
      ...goalShapeUniforms(side),
    },
    vertexShader: `
      varying vec2 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec2 vWorld;
      ${GOAL_FALLOFF_GLSL}
      void main() {
        float a = goalFalloff(vWorld);
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
}

export function goalGlowMaterial(color, glow, feather, noise = {}, side = 1, swim = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uGlow: { value: glow },
      uTime: { value: 0 },
      ...goalShapeUniforms(side),
      uNoiseOn: { value: 1 },
      uNoiseAmount: { value: 0.55 },
      uNoiseScale: { value: 6 },
      uNoiseSpeed: { value: 0.35 },
      uNoiseDrift: { value: new THREE.Vector2(0.6, 0.25) },
      uNoiseContrast: { value: 1.4 },
      // THE SEALS — see setGoalSwimmers. xy is where the seal is in world
      // units, z its reach (0 parks the slot), w its speed over the burst
      // threshold. Fresh vectors per material: two lights sharing one array
      // would be one light, and a uniform array is not cloned.
      uSwimOn: { value: 1 },
      uSwim: { value: Array.from({ length: SWIMMERS }, () => new THREE.Vector4()) },
      uSwimVel: { value: Array.from({ length: SWIMMERS }, () => new THREE.Vector2()) },
      uSwimPush: { value: 3.4 },
      uSwimSwirl: { value: 1.2 },
      uSwimDrag: { value: 0.05 },
      uSwimChurn: { value: 1.8 },
      // ...and their bursts: xy where the ring was thrown, z the wall second
      // it was thrown on, w its strength (0 is a dead slot).
      uPulse: { value: Array.from({ length: PULSES }, () => new THREE.Vector4(0, 0, -1e9, 0)) },
      uPulseSpeed: { value: 30 },
      uPulseLife: { value: 1.2 },
      uPulseWidth: { value: 5 },
      uPulsePush: { value: 5 },
      uPulseLight: { value: 0.5 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec2 vWorld;
      void main() {
        vUv = uv;
        // World XY, so the noise is in world units and the same size on a
        // wide light and a narrow one (the quad's own UV would stretch it).
        vWorld = (modelMatrix * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uGlow;
      uniform float uTime;
      uniform float uNoiseOn;
      uniform float uNoiseAmount;
      uniform float uNoiseScale;
      uniform float uNoiseSpeed;
      uniform vec2 uNoiseDrift;
      uniform float uNoiseContrast;
      uniform float uSwimOn;
      uniform vec4 uSwim[${SWIMMERS}];
      uniform vec2 uSwimVel[${SWIMMERS}];
      uniform float uSwimPush;
      uniform float uSwimSwirl;
      uniform float uSwimDrag;
      uniform float uSwimChurn;
      uniform vec4 uPulse[${PULSES}];
      uniform float uPulseSpeed;
      uniform float uPulseLife;
      uniform float uPulseWidth;
      uniform float uPulsePush;
      uniform float uPulseLight;
      varying vec2 vUv;
      varying vec2 vWorld;
      ${GOAL_FALLOFF_GLSL}
      ${NOISE_FIELD_GLSL}
      void main() {
        // See GOAL_FALLOFF_GLSL: 1 across the mouth and the corridor, falling
        // to 0 over the spill in front of the face and past the lips. Squared,
        // so the tail that bleeds into the water is the softer half of it.
        float a = goalFalloff(vWorld);
        a *= a;
        // THE NOISE — see CONFIG.versus.goal.noise. Three octaves over world
        // units, sliding by the drift and churning along the third axis by
        // the speed, each side on its own patch of the field. Brought to
        // 0..1, given its contrast about the middle, and mixed in by amount:
        // a trough at amount 1 is dark, a crest is the smooth light.
        if (uNoiseOn > 0.5) {
          // THE SEALS AND THEIR BURSTS — see CONFIG.versus.goal.swim. Three
          // things come out of this block and each goes somewhere different:
          // warp displaces where the field is sampled (the distortion),
          // stir slides the sample along the field's third axis so the
          // pattern under a swimmer boils while the rest of it holds, and
          // lift adds light where a ring is passing.
          //
          // stir is an OFFSET, never a multiplier on uTime: a churn scaled
          // by the clock would grow its own spatial gradient without bound
          // and, an hour into a match, alias the field into hash next to a
          // seal. An offset that rides with the swimmer churns because the
          // swimmer moves, which is the thing being described anyway.
          vec2 warp = vec2(0.0);
          float stir = 0.0;
          float lift = 0.0;
          if (uSwimOn > 0.5) {
            for (int i = 0; i < ${SWIMMERS}; i++) {
              float reach = uSwim[i].z;
              if (reach <= 0.0) continue;
              vec2 d = vWorld - uSwim[i].xy;
              float r = length(d);
              float f = 1.0 - smoothstep(0.0, reach, r);
              if (f <= 0.0) continue;
              f *= f;
              vec2 dir = r > 1e-4 ? d / r : vec2(1.0, 0.0);
              // The shove is TURNED as it goes: straight out is a bulge, and
              // a seal leaves a curl behind it rather than a bubble.
              float ang = uSwimSwirl * f;
              float cs = cos(ang); float sn = sin(ang);
              warp += vec2(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs) * uSwimPush * f;
              warp -= uSwimVel[i] * uSwimDrag * f;
              stir += uSwimChurn * f * uSwim[i].w;
            }
            for (int i = 0; i < ${PULSES}; i++) {
              if (uPulse[i].w <= 0.0) continue;
              float age = uTime - uPulse[i].z;
              if (age < 0.0 || age > uPulseLife) continue;
              vec2 d = vWorld - uPulse[i].xy;
              float r = length(d);
              // A gaussian band at the ring's radius, thinning out over its
              // life: the front is where the field is shoved and lit.
              float band = (r - age * uPulseSpeed) / uPulseWidth;
              float k = exp(-band * band) * uPulse[i].w * (1.0 - age / uPulseLife);
              warp += (r > 1e-4 ? d / r : vec2(1.0, 0.0)) * uPulsePush * k;
              lift += uPulseLight * k;
            }
          }
          vec2 q = (vWorld + warp + uNoiseDrift * uTime) / uNoiseScale;
          float n = noiseFbm(vec3(q, uTime * uNoiseSpeed + stir + uSide * 17.3));
          n = clamp(n * 0.5 + 0.5, 0.0, 1.0);
          n = clamp(0.5 + (n - 0.5) * uNoiseContrast, 0.0, 1.0);
          n = clamp(n + lift, 0.0, 1.0);
          a *= mix(1.0, n, uNoiseAmount);
        }
        gl_FragColor = vec4(uColor * uGlow * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  applyGlowNoise(mat.uniforms, noise);
  applyGlowSwim(mat.uniforms, swim);
  mat.uniforms.uFeather.value = feather;
  mat.uniforms.uTime.value = glowClock;
  return mat;
}

export function createWallRocks(scene) {
  const group = new THREE.Group();
  scene.add(group);

  let mesh = null;
  let material = null;
  // The dark of each goal mouth — a plane behind the hole, so the tunnel reads
  // as a cave into the cliff rather than a window onto the scene background.
  const holes = [];
  // Units of face past each wall that the frame may safely drift into. Zero
  // until the stack is built, and zero again the moment it is disposed or
  // turned off — with no shore drawn there is nothing to hide behind, so the
  // camera goes back to stopping dead on the wall.
  let cover = 0;

  function dispose() {
    cover = 0;
    shore.cover = 0;
    shore.hideZ = 0;
    shore.face = 0;
    shore.built = false;
    for (const h of holes) { group.remove(h); h.geometry.dispose(); h.material.dispose(); }
    holes.length = 0;
    goalGlows.length = 0;
    goalBacks.length = 0;
    if (!mesh) return;
    group.remove(mesh);
    mesh.geometry.dispose();
    mesh = null;
  }

  function build() {
    dispose();
    const cfg = CONFIG.wallRocks ?? {};
    if (cfg.enabled === false) return;

    const rand = mulberry32(cfg.seed ?? 1337);
    const detail = Math.max(0, Math.min(3, Math.round(cfg.detail ?? 1)));
    const roughness = cfg.roughness ?? 0.32;
    const shapes = [];
    for (let i = 0; i < SHAPE_VARIANTS; i++) shapes.push(boulderShape(rand() * 100, detail, roughness));

    // The stack runs from below the seabed — buried, so no boulder ever shows
    // a floating underside where it meets the floor — up to `aboveWater` units
    // past the surface, which is what makes it read as a shore rather than as
    // a reef that happens to stop.
    const footY = seabedTopY() - (cfg.bury ?? 2.5);
    const headY = bounds.surfaceY + (cfg.aboveWater ?? 5);
    const span = Math.max(1, headY - footY);
    const count = Math.max(1, Math.round(cfg.count ?? 26));
    // A [smallest, largest] range — the spread is what stops the face reading
    // as one boulder repeated. config.js owns the shape of this (healTunedShapes
    // repairs a saved snapshot that holds a bare number); the guard is only so
    // that scenery can never again take the whole boot down before first frame.
    const [rMin, rMax] = Array.isArray(cfg.size) ? cfg.size : [1.6, 4.4];

    const parts = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const scl = new THREE.Vector3();
    const at = new THREE.Vector3();

    // How far a boulder may bite past the seal's NOSE, and how far it may hang
    // back from it. Hang back and the seal bounces off open water short of the
    // rock; bite deep and the animal disappears into the cliff. Both are small,
    // and the spread between them is what keeps the face from being a drawn
    // straight line. Clamped against the live hitRadius rather than a written
    // constant.
    const reach = Math.min(0.7, (CONFIG.player?.hitRadius ?? 1) * 0.7);
    // WHERE THE SEAL ACTUALLY STOPS, which is not where it stops.
    //
    // clampToArena holds the seal's CENTRE at bounds.right - hitRadius, and
    // this file used to put the face on bounds.right — correct if hitRadius
    // were the animal's half-length. It is not, and not by a little: the hit
    // circle is 1.0 and the drawn seal is `fit` 2.6 world units at a size
    // multiplier of 2.36, so it reaches 3.07 units from its own centre. The
    // face therefore landed two units INSIDE the body, and a seal swum
    // nose-first into a wall buried two thirds of its head in the rock — which
    // is what "the player gets stuck in the wall" looks like from outside.
    //
    // Measured off the asset rather than written down, for the reason
    // SEAL_REAR_EXTENT_PER_SIZE exists in entities/player.js: `fit` and the
    // assets.csv size column are both live numbers, and a constant here would
    // be a wall in the wrong place the next time either moves. The worst case
    // is the one that matters — the long axis, pointed at the wall, which is
    // exactly the pose a player swimming into it is in.
    const seal = ASSETS.ship;
    const sealReach = ((seal?.fit ?? 0) * (getAssetSizeMultiplier('ship') || 1)) / 2;
    // ...and never INSIDE the old line: an asset table that has lost its fit
    // would otherwise pull the whole shore in on top of the seal, which is a
    // worse failure than the one this fixes.
    const faceInset = Math.max(0, sealReach - (CONFIG.player?.hitRadius ?? 1));
    const nose = bounds.right + faceInset;
    const mouth = goalMouth();

    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        // Stratified up the wall rather than uniformly random, so the face has
        // no holes — pure random over 26 boulders reliably leaves a gap you
        // can see the background through, which is the one thing this exists
        // to prevent.
        const t = (i + rand() * 0.85) / count;
        const r = rMin + rand() * (rMax - rMin);
        // Boulders get smaller toward the top: a cliff tapers, and an even
        // column reads as a wall of identical bubbles.
        const taper = 1 - (cfg.taper ?? 0.35) * t;
        const rad = r * taper;

        e.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
        q.setFromEuler(e);
        // Squashed on y so they read as bedded, weathered rock rather than as
        // dropped spheres.
        scl.set(rad, rad * (0.62 + rand() * 0.4), rad * (0.8 + rand() * 0.4));

        const y = footY + t * span + (rand() - 0.5) * (span / count);
        const z = (cfg.z ?? -2.2) + (rand() - 0.5) * 1.6;

        const g = shapes[(i + (side > 0 ? 1 : 0)) % shapes.length].clone();
        // Placed at x = 0 first, then MEASURED and slid into position. The
        // inner face has to land on the wall, and where that face falls is a
        // function of a random rotation applied to three unequal scales on a
        // lumpy shape — there is no closed form for it worth trusting, and
        // guessing it with a fraction of the radius is what put the last
        // version four units inside the water the seal can swim in.
        at.set(0, y, z);
        m.compose(at, q, scl);
        g.applyMatrix4(m);
        g.computeBoundingBox();

        // Where this boulder's face should sit: on the seal's nose, give or take.
        const faceX = nose - rand() * reach;
        const bb = g.boundingBox;
        g.translate(side > 0 ? faceX - bb.min.x : -faceX - bb.max.x, 0, 0);
        // THE MOUTH. A boulder that would sit across the goal's band is slid
        // OUT of it — up if its centre is above the mouth, down if below — so
        // its face lands on the lip the same way its inner face landed on
        // the wall: measured off the box, not guessed off the radius. Slid
        // rather than dropped, because the boulders above the lip are what
        // the top of the hole is made of, and a stack with a gap in it is a
        // stack you can see the sky through. The lip is then exact, and the
        // ball's collider (systems/versusGoal.js) is the same line.
        if (mouth && bb.max.y > mouth.lo && bb.min.y < mouth.hi) {
          const above = y >= (mouth.lo + mouth.hi) * 0.5;
          g.translate(0, above ? mouth.hi - bb.min.y : mouth.lo - bb.max.y, 0);
        }
        parts.push(g);
      }
    }

    // THE TUNNEL, in a match: the shore is one boulder deep, and a camera
    // that may look `camera.reach` into the goal (versusGoal.cameraReach)
    // would otherwise see the mouth open onto bare background. So each mouth
    // gets a BLOCK of rock past the face — a grid of boulders from the face
    // to `tunnel` deep plus a back wall, floor to head — with the band cut
    // out of it exactly as the face has it cut: a boulder that would sit in
    // the band is slid out of it onto a lip, and one that would sit in the
    // corridor at the back is slid back onto the back wall. The lips are
    // then exact along the whole tunnel, the same lines the ball's collider
    // (systems/versusGoal.js) and the seals' hole read.
    if (mouth) {
      const backW = rMax;                        // one boulder of back wall
      const step = Math.max(1.5, rMax * 0.8);    // spacing, so the grid has no gaps
      const depth = mouth.tunnel + backW;
      const cols = Math.ceil(depth / step) + 1;
      const rows = Math.ceil(span / step) + 1;
      const backX = nose + mouth.tunnel;         // the back wall's inner face, past the wall
      for (const side of [-1, 1]) {
        for (let ci = 0; ci < cols; ci++) {
          for (let ri = 0; ri < rows; ri++) {
            const r = (rMin + rMax) * 0.5 + rand() * (rMax - rMin) * 0.5;
            const rad = r * (1 - (cfg.taper ?? 0.35) * (ri / rows) * 0.5);
            e.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
            q.setFromEuler(e);
            scl.set(rad, rad * (0.62 + rand() * 0.4), rad * (0.8 + rand() * 0.4));
            const x = nose + (ci + 0.5) * step + (rand() - 0.5) * step * 0.4;
            const y = footY + (ri + 0.5) * step + (rand() - 0.5) * step * 0.4;
            const z = (cfg.z ?? -2.2) + (rand() - 0.5) * 1.6;
            const g = shapes[(ci * 7 + ri * 3 + (side > 0 ? 1 : 0)) % shapes.length].clone();
            at.set(0, y, z);
            m.compose(at, q, scl);
            g.applyMatrix4(m);
            g.computeBoundingBox();
            const bb = g.boundingBox;
            // Into place past the wall, by the box, like the face's boulders.
            const cx = (bb.min.x + bb.max.x) * 0.5;
            g.translate(side * x - cx, 0, 0);
            g.computeBoundingBox();
            const inBand = bb.max.y > mouth.lo && bb.min.y < mouth.hi;
            // Inside the corridor: out of the band onto a lip. NOT closed off
            // at the back — a boulder slid to the tunnel's end used to cap the
            // corridor with rock, which from the front is a goal that dead-ends
            // in the cliff and from a replay's angle is the light hidden behind
            // a wall. The corridor runs clear now and the light plane below is
            // what fills its far end. `openBack: false` puts the cap back.
            const inCorridor = side > 0 ? bb.min.x < backX : bb.max.x > -backX;
            if (inBand && (inCorridor || mouth.open)) {
              const nearBack = side > 0 ? bb.max.x > backX - step : bb.min.x < -backX + step;
              if (nearBack && !mouth.open) {
                g.translate(side > 0 ? backX - bb.min.x : -backX - bb.max.x, 0, 0);
              } else {
                const above = y >= (mouth.lo + mouth.hi) * 0.5;
                g.translate(0, above ? mouth.hi - bb.min.y : mouth.lo - bb.max.y, 0);
              }
            }
            // Never in front of the face: the tunnel starts where the shore's
            // own boulders end, and a block boulder poking into the water
            // would be a wall in the wrong place.
            g.computeBoundingBox();
            if (side > 0 ? bb.min.x < nose : bb.max.x > -nose) {
              g.translate(side > 0 ? nose - bb.min.x : -nose - bb.max.x, 0, 0);
            }
            parts.push(g);
          }
        }
      }
    }

    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    for (const g of shapes) g.dispose();
    if (!merged) return;
    merged.computeVertexNormals();

    if (!material) {
      material = new THREE.MeshLambertMaterial({
        color: cfg.color ?? 0x0d2230,
        flatShading: true,
      });
    }
    material.color.set(cfg.color ?? 0x0d2230);

    const measured = measureShore(merged, mouth);
    cover = measured.cover;
    shore.cover = measured.cover;
    // A margin past the frontmost face, so a body whose own thickness carries
    // it a little toward the camera is still behind the rock rather than
    // shaving it. Small, because everything back here has to stay in FRONT of
    // the backdrop planes (the surface line sits at -3, the fog at -3.2): a
    // hider pushed past those would be occluded by the sky instead, and would
    // then pop into existence the moment it eased forward again.
    shore.hideZ = measured.front - (cfg.hideMargin ?? 0.6);
    shore.face = faceInset;
    shore.built = true;

    mesh = new THREE.Mesh(merged, material);
    // Behind the swimming plane, in front of the seabed backdrop at -4.4, so
    // creatures pass in front of the cliff and the cliff in front of the floor.
    mesh.renderOrder = -1;
    group.add(mesh);

    // The inside of each mouth GLOWS in its team's colour (left is team 0's
    // goal, right team 1's — see CONFIG.versus.goal): a LIGHT, not a slab.
    // One rectangle per mouth (goalQuad), running from `spill` in front of the
    // drawn face to a whole camera reach past the tunnel's back and `spill`
    // past each lip, drawn additive with the falloff in GOAL_FALLOFF_GLSL so
    // it has no edge anywhere — the rock in front of it is what gives the hole
    // its shape — and overdriven past 1 so the bloom takes it. Behind the
    // boulders (their z jitter reaches -3), in front of the seabed plane at
    // -4; the boulders occlude it above and below the lips, and where it
    // spills past the face into the water there is nothing in front of it,
    // which is the point.
    //
    // THE FAR END IS OFF THE FRAME. The light used to stop `spill` past the
    // tunnel's back, which is inside the reach a match camera has — so pushed
    // into the goal the picture showed the light run out, and the slab behind
    // it ended at the face in a hard vertical line. Both run past the reach
    // now, and both fade over the same spill, so neither has an edge a camera
    // can be pointed at.
    if (mouth) {
      for (const side of [-1, 1]) {
        const color = mouth.colors[side < 0 ? 0 : 1];
        const faceX = side > 0 ? nose : -nose;
        const q = goalQuad(mouth, faceX, side);
        // THE CORRIDOR'S FAR END, and the only thing in the mouth that is not
        // additive. With the band left open (goalMouth().open) there is no
        // rock across it any more, so without this the goal is a window onto
        // the seabed plane and the sky. The team's colour at `backShade` over
        // the light's own rectangle and with the light's own falloff: solid
        // through the band and down the corridor, gone by the time it reaches
        // the water in front of the face. Behind the light, in front of the
        // seabed backdrop at -4.4.
        if (mouth.open && mouth.backShade > 0) {
          const back = new THREE.Mesh(
            new THREE.PlaneGeometry(q.w, q.h),
            goalBackMaterial(color, mouth.backShade, side),
          );
          applyGoalShape(back.material.uniforms, q, side, mouth);
          back.position.set(q.cx, q.cy, (cfg.z ?? -2.2) - 1.6);
          back.userData.faceX = faceX;
          back.userData.goalPart = 'back';
          // With the light, not before it: it is transparent now, and in
          // three's transparent list renderOrder beats depth — ahead of the
          // water fill it would be painted over exactly as the light was.
          back.renderOrder = 0;
          group.add(back);
          holes.push(back);
          goalBacks.push({ mesh: back, side });
        }
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(q.w, q.h),
          goalGlowMaterial(color, mouth.glow, mouth.feather, mouth.noise, side, mouth.swim),
        );
        applyGoalShape(plane.material.uniforms, q, side, mouth);
        plane.position.set(q.cx, q.cy, (cfg.z ?? -2.2) - 1.3);
        plane.userData.faceX = faceX;
        plane.userData.goalPart = 'light';
        // NOT behind the water. Both are in three's transparent list, which
        // sorts by renderOrder BEFORE depth — so at -2 this drew first and
        // the water fill (renderOrder 0, alpha 1 below the wave) painted
        // straight over it: no light anywhere water was, which was
        // everywhere. Ordered with the water, the depth sort puts the fill
        // (-5.4) under the light (-3.5); the boulders are opaque and wrote
        // depth already, so they still occlude it above and below the lips.
        plane.renderOrder = 0;
        group.add(plane);
        holes.push(plane);
        goalGlows.push({ mesh: plane, side });
      }
    }
  }

  function stats() {
    return {
      verts: mesh?.geometry.attributes.position.count ?? 0,
      draws: mesh ? 1 : 0,
    };
  }

  return {
    build, dispose, stats,
    get mesh() { return mesh; },
    // See measureCover: how far past the wall the camera may look and still be
    // looking at rock.
    get cover() { return cover; },
  };
}
