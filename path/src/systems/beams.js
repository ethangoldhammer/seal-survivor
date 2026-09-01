import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { feedback, feedbackState } from './feedback.js';
import { emitCloud } from '../entities/particles.js';
import { sear, releaseBurn } from './burnGlow.js';

// BEAMS — a line that stays lit, and cuts whatever is standing in it.
//
// Everything else this game shoots is a PROJECTILE: it is born at a muzzle, it
// travels, and it is resolved when it arrives. A beam is the opposite object in
// every respect, which is why it could not be a shot with a long thin mesh:
//
//   IT HAS NO TRAVEL TIME.        The far end is lit on the same frame as the
//                                 near end. There is no dodging the flight,
//                                 only the line.
//   IT PERSISTS.                  A shot resolves once. A beam is a hazard for
//                                 as long as it burns, and the question it asks
//                                 the player is "are you still standing there".
//   IT SWEEPS.                    Anchored to a head that turns, the line moves
//                                 across the water — so it is not aimed at you,
//                                 it is aimed THROUGH where you are about to be.
//   IT HITS REPEATEDLY.           Which is the whole balance problem, and the
//                                 reason for the per-target cooldown below.
//
// ONE SYSTEM, TWO OWNERS. The boss's eyes (systems/bossPerks.js) and the
// player's (the Laser Eyes upgrade) are the same object pointed in opposite
// directions — same geometry, same sweep, same damage tick, same glow. Two
// implementations of this would have been two sets of the tick bug below.

const _v = new THREE.Vector3();

/** Every live beam. Read by the debug panel and the harness; owned here. */
export const beams = [];

function cfg() {
  return CONFIG.beams ?? {};
}

// ---------------------------------------------------------------------------
// The look
// ---------------------------------------------------------------------------
// Two nested planes rather than one shader: a hot CORE that is nearly white and
// a wider GLOW in the beam's own colour, both additive. Deliberately no custom
// GLSL — an injected shader that fails to compile renders NOTHING and cannot be
// caught from a Node harness, and this effect has to be verifiable without a
// GPU. Two quads and a scale are boring and provable.
//
// THE COLOUR IS PUSHED PAST 1.0 ON ITS PEAK CHANNEL, which is the only reason
// this blooms at all. The bright pass thresholds on LUMINANCE, where blue is
// worth 7% and green 72% — so a cyan beam authored at a perfectly sane 0.9
// never crosses the threshold and simply does not glow, however bright it looks
// in isolation. Normalising on the peak channel and then scaling means a red
// beam and a blue one at the same `overdrive` reach the bright pass equally.
// See CONFIG.bloom and npm run glow.
// Exported because the seal's eye orbs (systems/eyeLights.js) are the muzzle
// this beam comes out of, and a socket that reached the bright pass on
// different terms from the line leaving it would read as two light sources.
export function hdr(color, overdrive) {
  return hdrInto(new THREE.Color(), color, overdrive);
}

// The same rule, in place. Beams only ever ask at spawn, so allocating a Color
// per call costs nothing here — but systems/eyeLights.js re-derives its glow on
// the RENDER PATH every frame, and two Colors a frame is two Colors a frame
// forever. One implementation, two shapes: a second peak-channel normalise
// written out somewhere else is a second one to get wrong.
export function hdrInto(out, color, overdrive) {
  out.set(color);
  const peak = Math.max(out.r, out.g, out.b) || 1;
  return out.multiplyScalar(overdrive / peak);
}

// THE OTHER NORMALISATION, and the two are not interchangeable — they answer
// different questions and each is useless for the other's.
//
//   hdrInto   NOT CLIPPING at the composite. Peak channel, because clipping is
//             per channel: whichever is largest is the one that truncates.
//   lumInto   BLOOMING AT ALL. Rec.709 luminance, because that is literally
//             what brightFragmentShader thresholds — and peak-normalisation
//             does nothing for it. Every fully saturated hue has a peak of 1,
//             so dividing by the peak divides every hue by the same number
//             while their luminances still span 10x: green is worth 72% and
//             blue 7%. That is why a cyan beam authored at a sane 0.9 can
//             simply refuse to glow.
//
// The cost of asking for a luminance is that a dark hue needs a big
// multiplier — a saturated red reaching luminance 2.2 lands with a peak
// channel near 9.5, and the composite knee turns its core white while the
// halo stays red. That is the correct trade when the ask is "this colour must
// bloom as hard as that one": see CONFIG.eyes.bloomLum, where a green boost
// and a red damage flash are both required to be big.
//
// Weights are duplicated from brightFragmentShader deliberately — they are the
// same constant seen from the two sides of the same pass, and a shader uniform
// cannot be read back from JS.
const LUM = { r: 0.2126, g: 0.7152, b: 0.0722 };
export function lumInto(out, color, target) {
  out.set(color);
  const lum = out.r * LUM.r + out.g * LUM.g + out.b * LUM.b;
  if (!(lum > 1e-6)) return out.setRGB(0, 0, 0);
  return out.multiplyScalar(target / lum);
}

/** Rec.709 luminance of a colour, for readouts and assertions. */
export function luminance(color) {
  const c = _lumScratch.set(color);
  return c.r * LUM.r + c.g * LUM.g + c.b * LUM.b;
}
const _lumScratch = new THREE.Color();

// THE PROFILE — a taper along the beam and a soft falloff across it, drawn
// once into a texture and reused by every beam in the game.
//
// A TEXTURE RATHER THAN A SHADER, and the reason is verifiability rather than
// taste: an injected GLSL error renders NOTHING and cannot be caught from a
// Node harness, so a shader-based beam is a thing that either works or silently
// does not, discoverable only by looking. A canvas gradient is provable, costs
// one 64x64 upload for the whole run, and does the two things asked of it:
//
//   ACROSS (v)  bright hot line down the middle falling off to nothing at the
//               edges, which is what makes the glow read as blooming OUT of a
//               core rather than as a flat bar with a lighter stripe on it.
//   ALONG (u)   a taper: full at the muzzle, thinning toward the far end, so
//               the beam has a source and a direction rather than being a
//               rectangle that happens to be lit.
//
// Built lazily and cached — there is no scene at module load, and a run that
// never sees a laser should not pay for one.
let PROFILE = null;
function beamProfile() {
  if (PROFILE) return PROFILE;
  const W = 64, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const c = cfg();
  const taperTo = c.taper ?? 0.35;      // width at the far end, as a fraction
  const edge = c.edgeSoftness ?? 0.55;  // how much of the half-width is falloff
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    // -1..1 across the beam, 0 dead centre.
    const v = (y / (H - 1)) * 2 - 1;
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      // The taper narrows the usable half-width as u runs to the far end, so
      // the same falloff curve produces a wedge rather than a bar.
      const halfWidth = 1 - (1 - taperTo) * u;
      const d = Math.abs(v) / Math.max(0.001, halfWidth);
      // 1 in the core, easing to 0 at the edge. Squared so the centre stays
      // hot across most of the width and the falloff is quick at the rim —
      // a linear ramp reads as a smudge rather than as a beam.
      let a = d >= 1 ? 0 : 1 - Math.min(1, Math.max(0, (d - (1 - edge)) / edge));
      a = a * a;
      // BOTH ENDS, and the near one is the one that was actually wrong. The
      // far end already dissolved; the MUZZLE was left as a full-width vertical
      // cut, which is a hard edge sitting in open water at the exact point the
      // beam is supposed to be emerging from something. Rendered, it read as a
      // bar someone had sliced the end off — the single most "hard edged" thing
      // about the whole effect, and invisible in every headless check.
      //
      // Short, so the beam still clearly ORIGINATES rather than fading up out
      // of nothing: by 7% of its length it is at full strength.
      const head = Math.min(1, u / (c.muzzleFade ?? 0.07));
      const tail = 1 - Math.max(0, (u - 0.82) / 0.18);
      a *= Math.max(0, Math.min(1, tail)) * head;
      const i = (y * W + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Clamped: a repeating profile would tile the taper down a long beam and
  // produce a row of wedges instead of one.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  PROFILE = tex;
  return tex;
}

// THE ILLUMINATION — a soft radial sprite, not a light.
//
// A real PointLight was the obvious answer and is the wrong one HERE: this
// project's creatures are deliberately split between lit MeshStandardMaterial
// and unlit MeshBasicMaterial (`modelUnlit: true`, chosen per creature for a
// flat silhouette). A light would illuminate half the roster and do nothing at
// all to the other half — the seagull and the crab would sit in the middle of a
// laser looking exactly as they did a frame earlier.
//
// An additive sprite lights everything equally because it does not light
// anything: it is glow laid OVER the scene, which is what the bloom is doing
// already and what the eye reads as a bright thing spilling onto its
// surroundings. It also costs one quad instead of a forward-render light.
let GLOW_SPRITE = null;
// Shared with systems/eyeLights.js — same soft radial, and one 64x64 upload
// for the whole run rather than one per system that wants a glow.
export function glowSprite() {
  if (GLOW_SPRITE) return GLOW_SPRITE;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // Quartic-ish falloff: a linear radial gradient reads as a disc with an edge,
  // and the thing being faked here has no edge at all.
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  GLOW_SPRITE = tex;
  return tex;
}

// ---------------------------------------------------------------------------
// THE QUAD AND THE MATERIALS OUTLIVE THE BEAM.
//
// A MATERIAL PER BEAM is still right, and for the reason the old comment here
// gave: sharing one is what the primitive asset pool does, and it is exactly
// why fading one bubble faded every bubble. These fade on their own clocks and
// must not share an opacity.
//
// What was wrong was DISPOSING them. three.js refcounts a linked program by
// its materials, so the last dispose deletes the program and the next volley
// links the identical shader again from source. `npm run test:beamchurn`
// measures the gap that makes it happen: at six stacks, fifty volleys a minute
// each start from an EMPTY beam list, so nothing at all is holding the program
// between them — 600 materials built and thrown away per minute, and fifty
// compiles. On the phone that is 160ms inside `render`, six of the eight worst
// frames of a 4½-minute run.
//
// So retired materials go on a free list instead. They are never disposed
// during a run, which is the whole point: an idle pooled material keeps the
// program's refcount above zero, and a volley arriving after ten quiet seconds
// finds the shader already linked. The pool is bounded by the most beams ever
// alive at once, which is single digits.
//
// The GEOMETRY can go further and be shared outright, because nothing writes to
// it — a beam's length and width are `mesh.scale` (see updateBeams), never
// vertices, so one unit quad serves every beam that will ever burn.
let QUAD = null;
function quad() {
  QUAD ??= new THREE.PlaneGeometry(1, 1);
  return QUAD;
}

const matPool = { glow: [], core: [], spill: [] };

// A PRIVATE COPY OF THE PROFILE, per material.
//
// The trim draws a SUB-SEGMENT of the beam, and the profile's u axis is exactly
// where the muzzle fade and the far taper live — so a stub drawn with the whole
// 0..1 profile squeezes both of them into itself and comes out as a little
// lozenge sliding down the line instead of as a lit span with a hard cut edge
// where it is being eaten. Remapping u onto [tail, head] is what makes the cut
// edge a cut edge, and that remap is `offset`/`repeat`, which are per TEXTURE —
// so the one shared profile cannot carry it.
//
// clone() is the cheap half: it shares the Source, so every copy is the same
// single 64x64 upload and only the settings are per beam. They ride the pooled
// materials and are bounded by the most beams ever alive at once, the same as
// the materials are — and deliberately NOT marked needsUpdate, which would
// force a re-upload per copy and throw away the sharing that makes this free.
function profileClone() {
  return beamProfile().clone();
}

/**
 * A material for this role, reused if one is going spare.
 *
 * `reset` is not optional bookkeeping: a pooled material still carries the last
 * beam's colour and opacity, and a boss beam handed a player beam's red would
 * be a bug that only shows up on the second volley.
 */
function takeMat(role, make, reset) {
  const m = matPool[role].pop();
  if (!m) return make();
  reset(m);
  return m;
}

function giveMat(role, m) {
  if (m) matPool[role].push(m);
}

function buildMesh(scene, b) {
  const group = new THREE.Group();
  const glowColor = hdr(b.color, b.overdrive * (cfg().glowOverdriveMul ?? 0.55));
  const coreColor = hdr(b.coreColor ?? 0xffffff, b.overdrive);
  const glowMat = takeMat('glow', () => new THREE.MeshBasicMaterial({
    color: glowColor,
    map: profileClone(),
    transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  }), (m) => { m.color.copy(glowColor); m.opacity = 0.55; });
  const coreMat = takeMat('core', () => new THREE.MeshBasicMaterial({
    color: coreColor,
    map: profileClone(),
    transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  }), (m) => { m.color.copy(coreColor); m.opacity = 0.95; });
  const glow = new THREE.Mesh(quad(), glowMat);
  const core = new THREE.Mesh(quad(), coreMat);
  core.position.z = 0.01;
  // THE SPILL. Sits at the muzzle, in the beam's own colour, and is the whole
  // of "it illuminates its surroundings" — see glowSprite. Parented to the
  // group but positioned in world space each frame, because the group is
  // rotated to the beam's angle and a child at the muzzle would otherwise have
  // to be un-rotated to stay circular.
  const spillColor = hdr(b.color, b.overdrive * (cfg().spillOverdriveMul ?? 0.4));
  const spillMat = takeMat('spill', () => new THREE.MeshBasicMaterial({
    color: spillColor,
    map: glowSprite(),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  }), (m) => { m.color.copy(spillColor); m.opacity = 0; });
  const spill = new THREE.Mesh(quad(), spillMat);
  spill.position.z = -0.01;
  group.add(glow, core, spill);
  b.spill = spill;
  group.renderOrder = 5;
  scene.add(group);
  b.mesh = group;
  b.glow = glow;
  b.core = core;
}

/**
 * Light one up.
 *
 * `follow` is what makes it a sweep rather than a line drawn once: given a
 * function returning `{ x, y, dirX, dirY }`, the beam re-reads its own origin
 * and heading every frame, so it tracks the head it is coming out of. Without
 * one it stays exactly where it was fired, which is what a trap wants.
 */
export function spawnBeam(scene, opts = {}) {
  const c = cfg();
  const b = {
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    dirX: opts.dirX ?? 1,
    dirY: opts.dirY ?? 0,
    length: opts.length ?? 30,
    width: Math.max(0.05, opts.width ?? (c.width ?? 0.55)),
    life: opts.life ?? 1.2,
    age: 0,
    damage: opts.damage ?? 8,
    // SECONDS BETWEEN HITS ON THE SAME TARGET, and the single most important
    // number in this file. A beam touching a body every frame at 60Hz deals
    // sixty times its listed damage per second, so a value that looks modest
    // deletes the arena; no cooldown at all and the same beam is either
    // unusable or unkillable depending on the frame rate, which is worse. The
    // cooldown is per TARGET rather than global so sweeping a line across a
    // shoal pays once per fish rather than once per sweep.
    tickEvery: Math.max(0.02, opts.tickEvery ?? (c.tickEvery ?? 0.12)),
    color: opts.color ?? 0xff5a3c,
    coreColor: opts.coreColor,
    overdrive: opts.overdrive ?? (c.overdrive ?? 3.2),
    hitsPlayer: !!opts.hitsPlayer,
    hitsEnemies: !!opts.hitsEnemies,
    source: opts.source ?? 'beam',
    follow: opts.follow ?? null,
    fadeIn: opts.fadeIn ?? (c.fadeIn ?? 0.08),
    fadeOut: opts.fadeOut ?? (c.fadeOut ?? 0.18),
    // THE WIPE. Seconds for the lit span to run out to the tip, and seconds for
    // the near end to follow it out — see CONFIG.beams.trim, and trimSpan below
    // for what they mean geometrically. Per beam rather than read from the
    // config at draw time so a caller can opt one line out (0 restores the
    // fade) without turning it off for the boss's.
    trimIn: Math.max(0, opts.trimIn ?? (c.trim?.in ?? 0)),
    trimOut: Math.max(0, opts.trimOut ?? (c.trim?.out ?? 0)),
    // Where the two edges were LAST frame. The sparks are emitted along the run
    // between then and now rather than at a point, so these are the state that
    // makes a shower out of what is otherwise four clumps — see trimSparks.
    lastHead: 0,
    lastTail: 0,
    // Per-target cooldowns. A Map keyed on the creature itself, so a body that
    // dies and is recycled cannot inherit the last one's timer.
    cooldowns: new Map(),
    dead: false,
    mesh: null,
  };
  // THE WIPES ARE SCALED TO FIT THE BURN, not clamped into it.
  //
  // A beam shorter than its own two wipes is a real case rather than a
  // pathological one — the boss eye-beam perk floors its duration at 0.2s, and
  // that is barely longer than the pair. Clamped, the tail starts already ahead
  // of the head and trimSpan closes the span on frame one: the beam is removed
  // before it has drawn anything, which looks exactly like the weapon having
  // failed to fire. Scaled, a very short beam is the same launch-and-fly read
  // played fast, which is the honest answer and the one the entrance stagger
  // arrived at for the same reason.
  const wipes = b.trimIn + b.trimOut;
  if (wipes > b.life && wipes > 0) {
    const k = b.life / wipes;
    b.trimIn *= k;
    b.trimOut *= k;
  }
  buildMesh(scene, b);
  beams.push(b);
  return b;
}

// How PRESENT the beam is right now: up over `fadeIn`, held, down over
// `fadeOut`. A beam that appeared and vanished on single frames read as a
// rendering glitch rather than as something switching on.
//
// This is the beam's SHAPE — its width and its existence. How bright it is is a
// separate curve; see flare().
function envelope(b) {
  // THE WIPE OWNS ARRIVING AND LEAVING WHEN IT IS ON, and the two must never
  // both run: a beam that trimmed AND faded would come in as a growing span
  // that was also translucent and half its width, which reads as neither of
  // them. Full strength throughout, and trimSpan decides what exists.
  //
  // This is also what quietly retires `armAt` for a trimmed beam — the gate
  // below is on this value, so at a flat 1 it never closes, and the span is
  // what stops the beam cutting where it is not drawn. That is the stricter
  // rule: armAt could only say "the whole line is too dim to bite yet", where
  // the span says which PART of the line exists.
  if (b.trimIn > 0 || b.trimOut > 0) return 1;
  const inT = b.age / Math.max(0.001, b.fadeIn);
  const outT = (b.life - b.age) / Math.max(0.001, b.fadeOut);
  return Math.max(0, Math.min(1, Math.min(inT, outT)));
}

// THE IGNITION FLARE — bright, then tame.
//
// A beam that burned at one brightness for its whole life read as a bar that
// had been switched on, and the eye stops registering it almost immediately: a
// constant is not an event. Real light sources do the opposite — they overshoot
// hard at ignition and settle back — and that overshoot is where the whole
// sense of POWER lives, so it is worth spending most of the beam's visual
// budget on the first fraction of a second and then getting out of the way.
//
// Separate from `envelope` because the two want different shapes: the beam
// should reach full WIDTH quickly and stay there, while its BRIGHTNESS spikes
// and decays. Multiplying one curve for both gave a beam that got visibly
// thinner as it dimmed, which reads as retracting rather than as cooling.
//
// Exponential decay rather than linear: a light settling is a decay, and a
// straight ramp down from a big overshoot reads as a fade someone is dragging.
function flare(b) {
  const c = cfg();
  const peak = c.flarePeak ?? 2.6;
  const t = c.flareTime ?? 0.16;
  if (peak <= 1 || t <= 0) return 1;
  return 1 + (peak - 1) * Math.exp(-b.age / t);
}

// WHERE THE LIT SPAN STARTS AND ENDS, as fractions of the beam's length.
//
// Both edges travel the same way, socket to tip — see CONFIG.beams.trim for why
// that and not a symmetric grow-and-shrink. `head` runs out over `trimIn`;
// `tail` leaves late enough that it arrives exactly as the beam's life ends, so
// the last thing drawn is a short bright dash at the far end rather than a
// beam that vanishes at full length.
//
// Returns the whole beam when the trim is off, which is what keeps every
// untrimmed beam — and every assertion written against one — exactly as it was.
const FULL_SPAN = { tail: 0, head: 1 };
const _span = { tail: 0, head: 1 };
function trimSpan(b) {
  if (!(b.trimIn > 0) && !(b.trimOut > 0)) return FULL_SPAN;
  const head = b.trimIn > 0 ? Math.min(1, b.age / b.trimIn) : 1;
  const outAt = b.life - b.trimOut;
  const tail = b.trimOut > 0 && b.age > outAt
    ? Math.min(1, (b.age - outAt) / b.trimOut)
    : 0;
  // CLAMPED AGAINST THE HEAD rather than allowed to pass it. A beam whose trim
  // times overrun its own life — a very short burn, or a stack that shortened
  // one — would otherwise produce a segment of NEGATIVE length, which draws as
  // a quad turned inside out and hit-tests as a range that contains nothing.
  // Neither throws, and both look like the beam having simply failed to appear.
  _span.tail = Math.min(tail, head);
  _span.head = head;
  return _span;
}

// The profile's u axis, remapped onto the drawn span. See profileClone.
function setProfileSpan(m, tail, head) {
  const t = m?.map;
  if (!t) return;
  t.offset.x = tail;
  t.repeat.x = Math.max(1e-4, head - tail);
}

// --- sparks off the edge that moved ----------------------------------------
// Emitted along the run the edge crossed SINCE LAST FRAME, not at wherever it
// happens to be standing now — and that is not a refinement, it is the whole
// difference between a shower and a dotted line. The edge crosses a 26-unit
// beam in 70ms, which is four frames at 60Hz and seven world units of travel
// between them: a burst at the instantaneous position leaves four clumps with
// visible gaps down the line, and on a machine dropping frames it leaves two.
//
// emitCloud is exactly the right shape for that — one call per edge per frame
// with the whole swept run in it.
//
// IT TAKES ITS VELOCITIES AND COLOURS FROM THE CLOUD, not from the emitter, so
// `speed`, `cone` and `colors` on the `sparks` def are NOT applied for us the
// way they are on the emit() path. They are read here by hand instead of being
// re-typed, which is the only version where turning the sparks preset down in
// the tuner moves these too — two spark sources that looked identical and only
// one of which answered to the slider would be a genuinely nasty thing to chase.
const SPARK_CAP = 64;
const _sparks = {
  count: 0,
  x: new Float32Array(SPARK_CAP), y: new Float32Array(SPARK_CAP),
  vx: new Float32Array(SPARK_CAP), vy: new Float32Array(SPARK_CAP),
  r: new Float32Array(SPARK_CAP), g: new Float32Array(SPARK_CAP), b: new Float32Array(SPARK_CAP),
};
const _sparkCol = new THREE.Color();

function rangeRand(v, fallback) {
  if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0]);
  return v ?? fallback;
}

function sweepSparks(b, from, to, t) {
  const run = (to - from) * b.length;
  if (!(run > 1e-3)) return;
  const def = CONFIG.emitters?.sparks;
  if (!def) return;
  const cap = Math.min(SPARK_CAP, Math.max(1, Math.floor(t.sparkCap ?? 24)));
  const n = Math.min(cap, Math.max(1, Math.ceil(run * (t.sparkPerUnit ?? 0.35))));
  const colors = def.colors ?? [0xffffff];
  const speedMul = t.sparkSpeed ?? 0.55;
  // 1 leaves the cut edge square-on, which is what a thing being severed
  // throws; 0 is isotropic and stops the edge reading as an edge at all.
  const across = Math.max(0, Math.min(1, t.sparkSpread ?? 0.8));
  const px = -b.dirY;
  const py = b.dirX;
  for (let i = 0; i < n; i++) {
    // Jittered along the run rather than evenly spaced: n is small, and n
    // evenly spaced points moving at a constant rate is a visible marching
    // comb rather than a spray.
    const at = (from + (to - from) * Math.random()) * b.length;
    _sparks.x[i] = b.x + b.dirX * at;
    _sparks.y[i] = b.y + b.dirY * at;
    // A direction anywhere in the plane, with its ALONG-THE-BEAM component
    // squashed by `across`. Decomposing and scaling rather than picking an
    // angle inside a cone keeps the distribution even instead of piling up at
    // the cone's edges, and `across` of 0 falls out as the untouched circle.
    const ang = Math.random() * Math.PI * 2;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const al = ux * b.dirX + uy * b.dirY;
    const speed = rangeRand(def.speed, 10) * speedMul;
    _sparks.vx[i] = (px * (ux * px + uy * py) + b.dirX * al * (1 - across)) * speed;
    _sparks.vy[i] = (py * (ux * px + uy * py) + b.dirY * al * (1 - across)) * speed;
    _sparkCol.set(colors[(Math.random() * colors.length) | 0]);
    _sparks.r[i] = _sparkCol.r;
    _sparks.g[i] = _sparkCol.g;
    _sparks.b[i] = _sparkCol.b;
  }
  _sparks.count = n;
  emitCloud('sparks', _sparks);
}

// Distance from a point to the beam's SEGMENT — not to its infinite line. The
// difference is everything a length means: an infinite line would let a beam
// aimed away from the arena still cut something behind the emitter.
// `n0`/`n1` are the LIT SPAN in world units along the line, which under the
// trim is a moving window rather than the whole beam. Passing them is not
// optional dressing: without it a growing beam cuts along its full reach while
// drawing a stub, which is the same class of bug as hit-testing the infinite
// line and is harder to see, because the damage happens exactly where the
// player is looking for it to and merely too early.
function distanceToBeam(b, px, py, n0 = 0, n1 = b.length) {
  const dx = px - b.x;
  const dy = py - b.y;
  const t = Math.max(n0, Math.min(n1, dx * b.dirX + dy * b.dirY));
  const cx = b.x + b.dirX * t;
  const cy = b.y + b.dirY * t;
  return Math.hypot(px - cx, py - cy);
}

/**
 * One frame of every live beam.
 *
 * @param ctx { enemies, playerPos, playerRadius, hooks }
 *        hooks: { onEnemyDamaged(e, dmg, x, y, dir, projectile, at, source),
 *                 onEnemyKilled(e), onPlayerHit(dmg, dir, source), onCut(x, y) }
 */
export function updateBeams(dt, scene, ctx = {}) {
  if (!beams.length) return;
  const hooks = ctx.hooks ?? {};
  let lit = 0;

  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i];
    b.age += dt;
    if (b.age >= b.life || b.dead) {
      removeBeam(scene, i);
      continue;
    }

    // THE SWEEP. Re-read before anything is measured against the line, so the
    // damage pass and the mesh describe the same beam — reading it after would
    // hit along last frame's line and draw this frame's, which on a fast turn
    // is a beam that visibly misses what it kills.
    if (b.follow) {
      const at = b.follow(b);
      if (at) {
        b.x = at.x ?? b.x;
        b.y = at.y ?? b.y;
        b.dirX = at.dirX ?? b.dirX;
        b.dirY = at.dirY ?? b.dirY;
      }
    }
    const len = Math.hypot(b.dirX, b.dirY) || 1;
    b.dirX /= len;
    b.dirY /= len;

    // THE SPAN, and it is worked out AFTER the sweep above for the same reason
    // the damage pass is: the sparks are laid down along the beam's current
    // line, and on a hard turn last frame's is several degrees away.
    const span = trimSpan(b);
    const n0 = span.tail * b.length;   // near end, world units along the line
    const n1 = span.head * b.length;   // far end
    const drawn = n1 - n0;
    // The tail has caught the head — nothing to draw and nothing to cut. Only
    // reachable when the trim times overrun the beam's life (see trimSpan), and
    // the honest answer then is that the beam is over.
    if (!(drawn > 1e-4)) {
      removeBeam(scene, i);
      continue;
    }

    // Sparks off whichever edge moved, along the run it crossed this frame.
    // Both are checked because both CAN move at once on a burn short enough
    // for the two wipes to overlap.
    if (b.trimIn > 0 || b.trimOut > 0) {
      const t = cfg().trim ?? {};
      sweepSparks(b, b.lastHead, span.head, t);
      sweepSparks(b, b.lastTail, span.tail, t);
    }
    b.lastHead = span.head;
    b.lastTail = span.tail;

    const env = envelope(b);
    const hot = flare(b);
    // The bloom floor takes the flare at full strength — this is the "blooms
    // really hard and then tames back down" the beam is asked for, and it is
    // the pulse rather than the material that the eye actually reads as heat.
    // Scaled by HOW MUCH OF THE BEAM IS LIT, which under the trim is the only
    // thing that still falls off — the envelope is flat at 1, so without this
    // the screen's bloom floor would hold full strength until the frame the
    // last inch of beam disappeared and then drop out in one step.
    lit = Math.max(lit, env * hot * (drawn / Math.max(1e-4, b.length)));

    // --- draw ------------------------------------------------------------
    // Centred on the DRAWN span rather than on the beam, which is what makes
    // the quad a sub-segment: an untrimmed beam has n0 = 0 and drawn = length,
    // so this is the old midpoint arithmetic with the span folded in.
    const midX = b.x + b.dirX * (n0 + drawn * 0.5);
    const midY = b.y + b.dirY * (n0 + drawn * 0.5);
    b.mesh.position.set(midX, midY, 0);
    b.mesh.rotation.z = Math.atan2(b.dirY, b.dirX);
    // The core is thin and the glow is wide, and BOTH breathe with the
    // envelope — a beam that only faded its opacity kept its full width to the
    // last frame and read as being switched off rather than as dying down.
    // (Under the trim the envelope is a flat 1 and this is the beam's own
    // width throughout; the span is doing that job instead.)
    const w = b.width * (0.35 + 0.65 * env);
    b.core.scale.set(drawn, w * (cfg().coreWidthMul ?? 0.38), 1);
    b.glow.scale.set(drawn, w * (cfg().glowWidthMul ?? 2.6), 1);
    // ...and the profile follows the span, so the muzzle fade stays at the
    // muzzle and the taper stays at the tip instead of both being squeezed into
    // whatever is currently lit. See profileClone.
    setProfileSpan(b.core.material, span.tail, span.head);
    setProfileSpan(b.glow.material, span.tail, span.head);
    // Clamped at 1: additive blending means anything past full opacity is not
    // brighter, it is just the same pixel — the flare's headroom above that is
    // spent on the bloom floor above and on the spill below, both of which CAN
    // go past 1 and be seen doing it.
    b.core.material.opacity = Math.min(1, 0.95 * env * hot);
    b.glow.material.opacity = Math.min(1, 0.55 * env * hot);

    // The spill sits at the MUZZLE in world space, and is counter-rotated so it
    // stays a circle whatever angle the beam is at — a radial gradient on a
    // rotated quad is still a circle, but a NON-square one would shear, and
    // this is the one piece here that is deliberately square for that reason.
    //
    // IT RIDES THE NEAR END OF THE SPAN, not the socket. While the beam is
    // growing those are the same point and this is unchanged; once the tail
    // leaves on the way out, the muzzle is no longer where the light is coming
    // from — the animal has let go of the beam, and the bright thing in the
    // water is the cut edge travelling away. Following the tail puts the spill
    // and the spark shower on the same point, which is what makes the two read
    // as one event rather than as a glow and some sparks that happen to agree.
    const spillSize = b.width * (cfg().spillSize ?? 9);
    const nearX = b.x + b.dirX * n0;
    const nearY = b.y + b.dirY * n0;
    b.spill.position.set(
      (nearX - midX) * Math.cos(-b.mesh.rotation.z) - (nearY - midY) * Math.sin(-b.mesh.rotation.z),
      (nearX - midX) * Math.sin(-b.mesh.rotation.z) + (nearY - midY) * Math.cos(-b.mesh.rotation.z),
      -0.01,
    );
    b.spill.rotation.z = -b.mesh.rotation.z;
    b.spill.scale.set(spillSize, spillSize, 1);
    // The spill is where the flare is most visible, because it has the most
    // room to grow into: it blows out to several times its resting size at
    // ignition and shrinks back as the beam settles.
    b.spill.material.opacity = Math.min(1, (cfg().spillStrength ?? 0.7) * env * hot);
    const flareSize = spillSize * (1 + (hot - 1) * (cfg().spillFlareGrowth ?? 0.8));
    b.spill.scale.set(flareSize, flareSize, 1);

    // --- cut ---------------------------------------------------------------
    // Only at full strength. A beam that damaged through its own fade-in would
    // hit before it was visible, which is the one thing a telegraphed attack
    // must never do.
    if (env < (cfg().armAt ?? 0.9)) continue;

    for (const [target, left] of b.cooldowns) {
      const next = left - dt;
      if (next <= 0) b.cooldowns.delete(target);
      else b.cooldowns.set(target, next);
    }

    if (b.hitsEnemies && ctx.enemies) {
      for (const e of ctx.enemies) {
        if (!e || e.hp <= 0 || e.invuln > 0 || b.cooldowns.has(e)) continue;
        if (distanceToBeam(b, e.mesh.position.x, e.mesh.position.y, n0, n1) > b.width * 0.5 + (e.radius ?? 0.5)) continue;
        b.cooldowns.set(e, b.tickEvery);
        e.hp -= b.damage;
        // THE SAME SHAPE EVERY OTHER DAMAGE HOOK IN THE GAME HAS —
        // (enemy, damage, x, y, dir) — with the beam's own source LAST rather
        // than third. It used to be third, which is the slot main.js reads as
        // the hit's x coordinate: every laser hit was placing its impact flash
        // at x = 'laserEyes' and recording that string as the creature's last
        // blow. Nothing threw, because a string is a perfectly good thing to
        // put in a Vector3 field nobody validates.
        hooks.onEnemyDamaged?.(
          e, b.damage, e.mesh.position.x, e.mesh.position.y,
          { x: b.dirX, y: b.dirY }, null, null, b.source,
        );
        // THE BODY LIGHTS UP WHILE THE BEAM IS ON IT, and it is not the same
        // thing as `beamCut` above. That is a MOMENT, fired ten times a second
        // per body, and ten flashes a second is a strobe the player stops
        // seeing inside a second. This is a STATE that climbs while contact is
        // held, breathes while it lasts and falls off when the beam leaves —
        // the only vocabulary damage-over-time has. systems/burnGlow.js, and
        // the same call bubbleJet.js makes for the same reason.
        sear(e);
        cut(e.mesh.position.x, e.mesh.position.y, hooks);
        // LET THE BODY GO ON THE FRAME IT DIES, not on the next sweep.
        // systems/bossLight.js attaches its kill light to the same root and
        // gets the SAME per-instance materials back, so one frame of overlap
        // is two systems writing one material with last-write-wins deciding
        // which is visible — a flicker on the first frame of every boss death,
        // which is the single most looked-at frame in the game.
        if (e.hp <= 0) { releaseBurn(e); hooks.onEnemyKilled?.(e); }
      }
    }

    if (b.hitsPlayer && ctx.playerPos && !b.cooldowns.has(PLAYER)) {
      const d = distanceToBeam(b, ctx.playerPos.x, ctx.playerPos.y, n0, n1);
      if (d <= b.width * 0.5 + (ctx.playerRadius ?? 0.6)) {
        b.cooldowns.set(PLAYER, b.tickEvery);
        hooks.onPlayerHit?.(b.damage, { x: b.dirX, y: b.dirY }, b.source);
        cut(ctx.playerPos.x, ctx.playerPos.y, hooks);
      }
    }
  }

  // WHILE ANY BEAM IS BURNING the whole frame runs hotter. A floor under the
  // bloom pulse rather than a set: the per-cut spikes below have to still be
  // able to punch above it, and an assignment would flatten every one of them
  // into the sustain. See feedbackState.glowPulse.
  if (lit > 0) {
    const floor = lit * (cfg().sustainGlow ?? 0.5);
    if (feedbackState.glowPulse < floor) feedbackState.glowPulse = floor;
  }
}

// A sentinel key for the player's own cooldown slot, so one Map can hold both
// sides without the player being confused for a creature.
const PLAYER = Symbol('player');

// THE MOMENT IT BITES. One feedback event carries the whole hit — the extra
// bloom, the shake and the haptic — because they are one event to the player
// and firing them from three places is how they drift apart. See
// CONFIG.feedback.beamCut.
function cut(x, y, hooks) {
  feedback('beamCut', { x, y });
  hooks.onCut?.(x, y);
}

function removeBeam(scene, i) {
  const b = beams[i];
  if (b.mesh) {
    scene.remove(b.mesh);
    // RETIRED, NOT DISPOSED — see the pool note above buildMesh. The geometry
    // is the shared unit quad and is never anyone's to dispose; the three
    // materials go back on the free list, which is what keeps their program
    // linked through a quiet stretch with no beam alive.
    giveMat('core', b.core.material);
    giveMat('glow', b.glow.material);
    giveMat('spill', b.spill?.material);
  }
  b.cooldowns.clear();
  beams.splice(i, 1);
}

/** Put every beam out — a run reset, or the emitter dying mid-burn. */
export function resetBeams(scene) {
  for (let i = beams.length - 1; i >= 0; i--) removeBeam(scene, i);
}

/** Douse only the beams a particular emitter lit. */
export function clearBeamsFrom(scene, source) {
  for (let i = beams.length - 1; i >= 0; i--) {
    if (beams[i].source === source) removeBeam(scene, i);
  }
}
