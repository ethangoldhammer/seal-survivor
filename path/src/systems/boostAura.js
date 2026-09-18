import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { WISP_GLSL } from './wispGlsl.js';
import { playerOverlayZ } from '../entities/player.js';
import { pipRGB } from './strikeRing.js';
import { pipCount } from './strike.js';
import { emitCloud } from '../entities/particles.js';
import { feedback, onFeedback } from './feedback.js';

// ============================================================================
// THE BOOST, SEEN AS WATER — the shell of charged water a seal burning fuel
// pushes out ahead of itself.
//
// WHAT THE OTHER TWO CHANNELS ALREADY SAY, so this one does not repeat them:
//
//   systems/chargeSkin.js  lights the seal's own MARKINGS with the fuel level.
//                          Monochrome on purpose — hue on the body is Glow
//                          Up!'s alphabet, and a mint-green animal claims an
//                          element the run never took. That layer answers "how
//                          much is in the tank".
//   systems/outlines.js    throbs the RIM while power banks, accelerating with
//                          it. That channel answers "I am loading a strike".
//
// This one answers a third question neither can: "the fuel is leaving RIGHT
// NOW, and this is which of it". It lives entirely OUTSIDE the animal — the
// inner edge sits on the body's own bounding radius — so it is free to carry
// the hue the body may not, and it cannot be confused with either of the two
// glows painted on the hide.
//
// COLOURED BY THE PIP THAT IS BURNING. The fuel wheel is a colour ramp, orange
// through green with the last pip pinned to its own mint (see wheelColor in
// systems/strikeRing.js); this wears whichever segment the drain is currently
// eating. So a long hold is not one colour getting dimmer, it is the wheel
// walked backwards on the water around the seal, and a player who has learned
// the ring's colours already knows how much is left without looking at it.
//
// NORMALISED ON THE PEAK CHANNEL, never on luminance. The wheel's hues have
// wildly different luminances — blue counts for 7% — so equalising on
// brightness would hand the cold end a saturation boost and the warm end a
// wash-out. Peak-channel keeps the hue and the saturation EXACTLY as the pip
// wears them and only lifts the value, which is the whole of what "bright"
// means here. See npm run glow.
//
// IT IS GATED ON THE DRAIN, not on the button. `strikeState.charging` is false
// the moment the tank runs dry even with the finger still down — which is the
// wrong signal for the sounds and the mouth gate (see the long notes in
// main.js) and the RIGHT one here, because this is a picture of fuel leaving
// and there is no pip draining once there is none left. The whole life of the
// shell is the whole life of the burn.
//
// THE FIELD IS FIXED IN THE WORLD, the same decision systems/organicRing.js
// makes and for the same payoff: a shell that GROWS sweeps through the noise
// instead of carrying it, so it churns as it expands and reads as charged
// water being pushed outward rather than as a balloon with a pattern on it.
//
// WHY WISP_GLSL and not a fourth noise function. It is the repo's shared value
// noise — three octaves at a 1.7 lacunarity, Hermite-blended, no derivatives
// (they are unreachable from GLSL ES 1.00, see systems/graveBeam.js). What
// makes this turbulent rather than merely lumpy is the DOMAIN WARP below, and
// a warp needs a smooth field under it, not a special one.
// ============================================================================

// EXPORTED as strings so tools/aura-shader-check.mjs compiles what SHIPS
// rather than a copy of it. A GLSL error here draws nothing and throws
// nothing; Node cannot see it, so the strings have to leave the module.
export const AURA_VERTEX_GLSL = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// One quad, drawn in a space where the shell's CURRENT outer reach sits at
// r = 1. Nothing here is in world units except the noise, which is sampled at
// the world position so the grain is a constant size as the shell grows.
export const AURA_FRAGMENT_GLSL = /* glsl */ `
  uniform vec2  uCenter;    // the seal, in world xy
  uniform float uOuter;     // what r = 1 is worth, in world units
  uniform float uInner;     // the body's edge, as a fraction of uOuter
  uniform vec3  uColor;     // the draining pip's hue, value-normalised
  uniform float uStrength;
  uniform float uFalloff;   // how fast the shell thins outward
  uniform float uSoft;      // how soft both edges are, in shell widths
  uniform float uWobble;    // how far the field tears the leading edge
  uniform float uGrain;     // noise features per world unit
  uniform float uWarp;      // domain warp — the turbulence itself
  uniform float uChurn;     // ...and how fast it boils
  uniform float uDepth;     // how much of the shell the field eats
  uniform float uContrast;
  uniform float uTime;
  uniform float uLife;      // 0..1, the fade in and out
  // HOW FAR THE FIELD HAS SLID, in world units, along the line the strike is
  // aimed down. Accumulated on the CPU so the ramp can be a rate rather than a
  // curve the shader would have to be told the age of. See the header.
  uniform vec2  uFlow;
  varying vec2 vUv;

${WISP_GLSL}

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    // OUTSIDE THE DISC IS NOTHING. The quad's corners reach r = 1.41 and the
    // shell does not, so this is most of the sprite's area on a cheap branch
    // rather than on the whole body of the shader below it.
    if (r > 1.0 || uLife <= 0.0) { gl_FragColor = vec4(0.0); return; }

    // WHERE THIS FRAGMENT IS IN THE WATER, not on the quad. See the header:
    // this is the line that makes a growing shell churn.
    //
    // MINUS THE FLOW, which is what sends the field DOWN THE LINE OF THE
    // STRIKE. Subtracting rather than adding is the whole of the direction: a
    // feature drawn at world point x is the field's value at x - uFlow, so as
    // uFlow travels along the aim the feature travels with it. Added, every
    // lump would stream backwards out of the seal's face.
    //
    // It is taken off the WORLD position, before the grain scales it, so the
    // three samples below — the two warp taps and the tap they steer — all
    // slide as one field rather than as three fields at three speeds.
    vec2 q = (uCenter + p * uOuter - uFlow) * uGrain;
    float t = uTime * uChurn;

    // THE DOMAIN WARP. Two cheap samples displace the third, which is what
    // turns three octaves of smooth value noise into something with filaments
    // and curl in it — the difference between "lumpy" and "turbulent", for the
    // cost of two extra taps.
    vec2 w = vec2(wisp(q + 17.3, t), wisp(q - 5.1, t * 0.83)) - 0.5;
    float n = wisp(q + w * uWarp, t);
    float f = clamp((n - 0.5) * uContrast + 0.5, 0.0, 1.0);

    // ACROSS THE SHELL'S OWN WIDTH, 0 at the animal's edge and 1 at the reach
    // it has pushed out to so far. Everything below is in this coordinate, so
    // the profile does not change shape as the shell grows — only its size.
    float span = max(1e-3, 1.0 - uInner);
    float x = (r - uInner) / span;

    // THE LEADING EDGE IS TORN BY THE FIELD rather than being a clean circle.
    // The displacement goes BOTH WAYS, so the boundary bulges and bites in the
    // way the organic ring's does; nothing promises damage out here, so there
    // is no reach to over-promise and the wobble can be generous.
    float edge = 1.0 - smoothstep(1.0 - uSoft, 1.0 + uSoft, x + (0.5 - f) * uWobble);
    // ...and the inner one is where the animal stops. Softened, not stepped: a
    // hard ring at the silhouette reads as a decal stuck to the seal.
    float skin = smoothstep(-uSoft, uSoft, x);
    // DENSE AGAINST THE BODY, thinning outward — this is water being pushed,
    // so it is thickest where it is being pushed from.
    float body = pow(max(0.0, 1.0 - x), uFalloff);

    float a = skin * edge * body * mix(1.0, f, uDepth) * uLife;
    // Overdriven past 1 on purpose, like every other additive quad the seal
    // wears: the bright pass is a HalfFloat target, so the excess blooms
    // outward instead of clipping to white in place.
    gl_FragColor = vec4(uColor * uStrength * a, a);
  }
`;

// A FRESH SET PER SHELL — every seal on a Blubberball pitch has its own quad
// and its own clock, and a shared uniform object would give them one colour
// and one radius between them.
function auraUniforms() {
  return {
    uCenter: { value: new THREE.Vector2(0, 0) },
    uOuter: { value: 1 },
    uInner: { value: 0.5 },
    uColor: { value: new THREE.Color(0xffffff) },
    uStrength: { value: 1 },
    uFalloff: { value: 1.6 },
    uSoft: { value: 0.18 },
    uWobble: { value: 0.5 },
    uGrain: { value: 0.5 },
    uWarp: { value: 1.4 },
    uChurn: { value: 1.6 },
    uDepth: { value: 0.8 },
    uContrast: { value: 1.7 },
    uTime: { value: 0 },
    uLife: { value: 0 },
    uFlow: { value: new THREE.Vector2(0, 0) },
  };
}

/**
 * EVERY UNIFORM THE CPU WRITES, for tools/aura-shader-check.mjs to prove the
 * shader declares and reads each one. Read off the set above rather than typed
 * out a second time: a hand-kept list is exactly the thing that goes stale and
 * then certifies a uniform nobody is uploading any more.
 */
export const AURA_UNIFORM_NAMES = Object.keys(auraUniforms());

const cfg = () => CONFIG.boostAura ?? {};

const _corner = new THREE.Vector3();

/**
 * THE CIRCLE THAT JUST CLEARS THE ANIMAL, in world units — the radius the
 * shell's inner edge starts at.
 *
 * Measured off the body's own box (entities/player.js measureBody, which
 * carries the size multiplier the T panel moves) rather than off `hitRadius`,
 * which is the gameplay circle and is a third of the seal. The circumscribing
 * radius in xy, so an elongated body turning cannot poke out through its own
 * aura — a z rotation leaves hypot(x, y) alone, and a roll can only shrink it.
 *
 * Falls back to the hit circle for a body nothing has measured, which is the
 * same fallback systems/deathDive.js reaches for and for the same reason.
 */
export function bodyReach(box, fallback = 1) {
  if (!box) return fallback;
  let far = 0;
  for (let i = 0; i < 4; i++) {
    _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, 0);
    const d = Math.hypot(_corner.x, _corner.y);
    if (d > far) far = d;
  }
  return far > 0 ? far : fallback;
}

/**
 * WHICH PIP THE DRAIN IS EATING, 0-based, or -1 on an empty bar.
 *
 * Ceil-minus-one against the same 1e-6 the burn counter in systems/strike.js
 * uses, so a bar sitting exactly on a pip boundary names the pip BELOW it —
 * the one about to go — rather than the empty one above, and the two cannot
 * disagree about a float a hair either side.
 */
export function drainingPip(charge, pips) {
  const n = Math.max(1, pips | 0);
  const fuel = Math.max(0, Math.min(1, charge));
  if (fuel <= 0) return -1;
  return Math.max(0, Math.min(n - 1, Math.ceil(fuel * n - 1e-6) - 1));
}

/**
 * HOW FAST THE FIELD IS SLIDING, in world units per second, `held` seconds
 * into a burn.
 *
 * A RATE THAT CLIMBS, not a curve: `flow` is where it starts, `flowRamp` is
 * what a second of holding adds, and `flowMax` is the ceiling. The same shape
 * `push`/`reach` above use for the radius, on purpose — the two things that
 * grow with the length of a hold should grow by the same kind of arithmetic,
 * or tuning one tells you nothing about the other.
 *
 * Exported because the harness and the look sheet both check the ramp against
 * the numbers rather than against a curve I would have had to copy.
 */
export function flowSpeed(held, a = cfg()) {
  return Math.min(a.flowMax ?? 10, (a.flow ?? 2) + (a.flowRamp ?? 6) * Math.max(0, held));
}

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * The pip's colour with its VALUE lifted to the top and its hue and saturation
 * untouched — see the header on why this is peak-channel and not luminance.
 * Writes into `out` and returns it.
 */
export function auraColor(out, i, pips) {
  out.set(pipRGB(i, pips));
  out.getHSL(_hsl);
  // A pip that is genuinely grey stays grey: dividing by its peak would only
  // scale it, and there is no hue in it to protect.
  const peak = Math.max(out.r, out.g, out.b);
  if (peak > 1e-4) out.multiplyScalar(1 / peak);
  return out;
}

// ---------------------------------------------------------------------------
// THE SHELL SHATTERING — what the LET-GO does to the water it has been pushing
// out.
//
// A wind-up the player ends does not get to fade. The fade is for a wind-up
// that was ABANDONED — a death, a pause, a run ending — where nothing happened
// and water that is no longer being pushed simply settles. A release is a
// decision, and it ends the shell the way a decision should: all at once.
//
// AND HARDER INSIDE THE WINDOW. A release that lands in the sweet spot throws
// more of it, faster, and churning more — the three channels turned up on ONE
// picture rather than a second effect bolted on, so the player learns the
// shatter once and then reads its intensity. The gate is inSweetSpot(), asked
// by the caller on the release frame: the same function tryStrike judges the
// strike with, so the debris cannot celebrate a release the game scored as a
// miss.
//
// SCATTERED ACROSS THE SHELL'S BAND, not resampled from the shader's field.
// Doing it properly would mean a CPU copy of the domain-warped wisp, which is
// a second source of truth for a picture that lasts a fifth of a second and is
// made of specks — the drift would be invisible right up until it wasn't. What
// IS shared is the profile: the radius is drawn through the same
// `(1 - x)^falloff` the shader shades with, so the specks are dense where the
// shell is dense and thin where it is thin, off the one number that says so.
//
// ONE BUFFER FOR EVERY SEAL. A burst is consumed inside emitCloud before this
// function returns, so a Blubberball pitch where two seals let go on the same
// frame fills it twice rather than needing two of it. Sized for the sweet
// release, which is the multiplied count — an ordinary one uses a fraction.
const BURST_CAP = 256;
const _burst = {
  count: 0,
  x: new Float32Array(BURST_CAP), y: new Float32Array(BURST_CAP),
  vx: new Float32Array(BURST_CAP), vy: new Float32Array(BURST_CAP),
  r: new Float32Array(BURST_CAP), g: new Float32Array(BURST_CAP), b: new Float32Array(BURST_CAP),
};

/** A range from the emitter table, or a plain number, or the fallback. */
function span(v, fallback) {
  if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0]);
  return v ?? fallback;
}

/**
 * HOW MANY SPECKS THE LAST SHATTER DREW. Read straight back by
 * burstBoostAura's caller and by the harness, because the drawing happens
 * inside a feedback listener and a listener cannot return anything.
 */
let lastBurst = 0;

/**
 * DRAW ONE SHATTER from its description — the only place specks are emitted,
 * whether the release is happening now or being replayed a minute later.
 *
 * `at` is what burstBoostAura put on the event: where the shell was, how wide
 * its band was, what colour it was wearing, which way it was flowing and
 * whether the release landed in the window. Everything is a primitive, because
 * the replay's recorder keeps a shallow copy and a live object reference in
 * there would describe whatever the shell is doing NOW rather than what it was
 * doing then.
 *
 * TUNING IS READ HERE, NOT CARRIED ON THE EVENT: count, speed and the sweet
 * multipliers come off CONFIG at draw time. So dragging a slider changes a
 * replay of a shot thrown before the drag, which is what a look knob should do
 * — the recorded thing is the MOMENT, not the settings it was drawn with. The
 * geometry and the colour are on the event for the opposite reason: those were
 * facts about that wind-up and cannot be re-derived once it is over.
 */
function drawBurst(at) {
  const a = cfg();
  const b = a.burst ?? {};
  if (b.enabled === false) return 0;
  const def = CONFIG.emitters?.boostAuraBurst;
  if (!def) return 0;

  const inner = at.inner ?? 0;
  const outer = at.outer ?? 0;
  const span0 = Math.max(1e-4, outer - inner);
  // The shader's own shading profile, as a distribution. For a density of
  // (1 - x)^f across the band, the inverse CDF is 1 - (1 - u)^(1/(f + 1)) —
  // so the specks pile up against the animal exactly where the shell does,
  // off the one number that decides it rather than off a second guess.
  const shape = 1 / ((a.falloff ?? 0.85) + 1);
  // HITTING THE WINDOW IS LOUDER, in the three channels that say "more of it,
  // thrown harder, and churning": count, speed and turbulence. Not a different
  // effect and not a different emitter — the same water coming apart, with the
  // dial turned up, so the player learns one picture and reads its intensity
  // rather than learning two.
  const sw = b.sweet ?? {};
  const hit = (at.sweet ?? 0) > 0.5;
  const countMul = hit ? Math.max(0, sw.count ?? 2.2) : 1;
  const n = Math.min(BURST_CAP, Math.max(1, Math.round((b.count ?? 110) * countMul)));
  // HOW MUCH OF THE FLOW THE DEBRIS KEEPS. The field was already streaming
  // down the launch line; specks thrown off it with no memory of that is a
  // symmetrical puff, which says nothing about where the strike is pointed. At
  // 1 the whole burst leans downrange and stops reading as the shell coming
  // apart, so this is a bias and not a direction.
  const aim = Math.max(0, b.aim ?? 0.5);
  const speedMul = Math.max(0, b.speedMul ?? 1);
  const dirX = at.dirX ?? 0;
  const dirY = at.dirY ?? 0;
  const cx = at.x ?? 0;
  const cy = at.y ?? 0;

  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const spot = inner + span0 * (1 - Math.pow(1 - Math.random(), shape));
    _burst.x[i] = cx + ux * spot;
    _burst.y[i] = cy + uy * spot;
    // `speed` is read off the EMITTER by hand rather than duplicated in
    // CONFIG.boostAura — emitCloud takes velocities from the cloud and never
    // looks at the def, so leaving it to be applied automatically would make
    // the emitter's own slider move nothing. Same arrangement, and the same
    // reason, as the beam sparks in systems/beams.js.
    const v = span(def.speed, 9) * speedMul * (hit ? Math.max(0, sw.speed ?? 1.8) : 1);
    _burst.vx[i] = (ux + dirX * aim) * v;
    _burst.vy[i] = (uy + dirY * aim) * v;
    // THE SHELL'S OWN COLOUR, which is already the burning pip's hue
    // normalised on its peak. Not sampled from a palette: these specks ARE the
    // shell, and a palette here would be the burst quietly disagreeing with
    // the thing it came out of about what colour the fuel was.
    _burst.r[i] = at.r ?? 1;
    _burst.g[i] = at.g ?? 1;
    _burst.b[i] = at.b ?? 1;
  }
  _burst.count = n;
  return emitCloud('boostAuraBurst', _burst, {
    // The third channel. emitCloud multiplies this onto the emitter's own
    // figure, so the global turbulence switch and the workbench's slider both
    // still bind — see the note on turbMul there.
    turbMul: hit ? Math.max(0, sw.turbulence ?? 2.2) : 1,
  });
}

// ONE LISTENER FOR EVERY SHELL IN THE GAME, attached at module load rather
// than per instance: the event carries the whole description, so nothing here
// needs to know which seal threw it — and eight seals on a pitch would
// otherwise mean eight listeners each drawing every other seal's shatter.
//
// It draws a REPLAYED event exactly as it draws a live one. That is the point:
// the replay is not a second code path that has to be kept in step, it is the
// same function reading the same numbers off a clock that is running late.
onFeedback((name, at) => {
  if (name !== 'boostShatter') return;
  lastBurst = drawBurst(at ?? {});
});

// ---------------------------------------------------------------------------
// THE SHELL, FOR A REPLAY.
//
// The shatter above rides the event track, which is how a MOMENT gets into a
// replay. The shell is not a moment — it is a continuous look worn for the
// whole wind-up, and a goal replay opens `replay.lead` seconds BEFORE the touch
// that scored, so the wind-up is inside the footage. Posed from transforms
// alone the striker swims through its own shot wearing nothing.
//
// So it is RECORDED PER FRAME and posed back, exactly as the ball's colour and
// its spin strokes are (recordBallLook / poseBallLook in systems/ballLook.js).
// Re-deriving it instead — replaying the strike state and running the state
// machine on the replay's clock — was the other option and is worse for a
// reason worth writing down: this layer integrates `held` and the flow offset
// over dt, and a replay runs at 0.45 speed on a wall clock with its own frame
// pacing, so the re-derived shell would be a different shell that happened to
// start in the same place.
//
// EIGHT NUMBERS. The radius pair, the fade, the flow offset and the colour —
// everything the shader is handed that is not a tuning knob. The knobs are
// deliberately NOT recorded: a replay of a shot thrown before somebody dragged
// `grain` should be drawn with the grain that is set now, because the look is
// not what happened, the moment is.
export const AURA_REC = 8;
const A_LIFE = 0, A_INNER = 1, A_OUTER = 2, A_FLOWX = 3, A_FLOWY = 4, A_R = 5, A_G = 6, A_B = 7;

function makeAura() {
  let mesh = null;
  // SECONDS OF BURN SO FAR, which is the only clock the shell has: it grows by
  // `push` world units per second of it. Reset on the rising edge of a drain
  // rather than on the button, so a hold begun on a part-full bar starts its
  // shell at the animal like every other one.
  let held = 0;
  let life = 0;
  let churn = 0;
  let wasDraining = false;
  // WHERE THE FIELD HAS SLID TO, in world units, and the line it is sliding
  // down. Two vectors rather than one angle: the offset is what the shader
  // wants, and integrating a rate along a LATCHED direction is what lets the
  // player swing the aim mid-hold without the whole field snapping to the new
  // line — the trail already laid stays where it was laid, and only what is
  // added from here on goes the new way.
  const flowAt = new THREE.Vector2(0, 0);
  const flowDir = new THREE.Vector2(0, 0);

  function createBoostAura() {
    const material = new THREE.ShaderMaterial({
      vertexShader: AURA_VERTEX_GLSL,
      fragmentShader: AURA_FRAGMENT_GLSL,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: auraUniforms(),
    });
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    // Behind the whole animal, on the same plane the meter's arcs sit on —
    // the shell is outside the silhouette, so all this decides is that it can
    // never be sliced by a flipper crossing it.
    mesh.position.z = playerOverlayZ();
    mesh.frustumCulled = false;
    resetBoostAura();
    return mesh;
  }

  function resetBoostAura() {
    held = 0;
    life = 0;
    churn = 0;
    wasDraining = false;
    // The direction is NOT cleared with the offset: a seal that opens a second
    // burn on the same frame it let go of the first has no new aim yet, and a
    // field starting from a zeroed heading would sit still for that frame.
    flowAt.set(0, 0);
    if (mesh) {
      mesh.visible = false;
      mesh.material.uniforms.uLife.value = 0;
      mesh.material.uniforms.uFlow.value.set(0, 0);
    }
  }

  /**
   * @param rawDt    UNSCALED seconds, like every other glow the seal wears:
   *                 the water around it does not hold still because a hit
   *                 froze the game for 60ms.
   * @param pos      the seal, in world space
   * @param st       that seal's strike state
   * @param running  false outside a live run, which hides it outright
   * @param box      that seal's measured body box (player.bodyBox)
   * @param o.box    that seal's measured body box (player.bodyBox)
   * @param o.stats  whose pip count to cut the bar into
   * @param o.aim    the line the strike is aimed down — strikeDirection(move,
   *                 aim) from systems/strike.js, which is the SAME function
   *                 the wind-up's corridor is drawn from and the release fires
   *                 along. Not `input.aim` on its own: the launch goes between
   *                 the swim and the cursor, and a field flowing down the
   *                 cursor alone would point somewhere the strike is not
   *                 going. A zero vector (both sticks idle) is not an
   *                 instruction to stop — see the latch below.
   * @param o.held   the BUTTON, not `st.charging`. The two part company for
   *                 the whole back half of a wind-up: `charging` goes false the
   *                 frame the tank runs dry and the player keeps holding
   *                 through "STRIKE NOW!" — which is the half the sweet spot
   *                 lives in. The shell is what comes apart at the let-go, so
   *                 it has to still be there at the let-go.
   *
   * AN OPTIONS OBJECT, and this took four positional arguments before it took
   * five. The façade at the bottom of this file forwarded the first six of
   * seven by name and silently dropped the seventh, so the flow worked in every
   * harness and did nothing in a run. Named arguments cannot be dropped by
   * being forgotten.
   */
  function updateBoostAura(rawDt, pos, st, running, o = {}) {
    const box = o.box ?? null;
    const stats = o.stats ?? null;
    const aim = o.aim ?? null;
    const button = o.held ?? false;
    if (!mesh) return;
    const a = cfg();
    if (!running || a.enabled === false || !CONFIG.strike.enabled) {
      if (life !== 0 || mesh.visible) resetBoostAura();
      return;
    }

    const pips = pipCount(stats);
    const pip = drainingPip(st?.charge ?? 0, pips);
    // THE DRAIN, not the button — see the header. `charging` is already "held
    // AND there is fuel left to burn"; the pip test is the other half of the
    // same sentence and costs nothing, and it is what keeps the shell from
    // living for a frame on a bar that emptied on this one.
    const draining = !!st?.charging && pip >= 0;

    if (draining && !wasDraining) { held = 0; churn = 0; }
    wasDraining = draining;

    // THE LINE, LATCHED. strikeDirection returns the zero vector only when BOTH
    // sticks are idle — which is a player holding a wind-up and not yet saying
    // where, not a player asking the water to stop. Keeping the last heading
    // means the field carries on down the line it was already going until it is
    // told a new one; zeroing it would make the flow stall every time a thumb
    // came to rest, which reads as a hitch rather than as a decision.
    const aLen = Math.hypot(aim?.x ?? 0, aim?.y ?? 0);
    if (aLen > 1e-4) flowDir.set(aim.x / aLen, aim.y / aLen);

    // THE BUTTON HOLDS IT UP; the drain is only what GROWS it. A wind-up spends
    // its last stretch with the tank dry and the finger still down — that is
    // where "STRIKE NOW!" is, where the sweet spot is, and where the release
    // the player is aiming for happens. A shell that faded out when the fuel
    // did would be gone by the moment it is supposed to shatter at, which is
    // the moment the whole loop is built around.
    //
    // It stops GROWING there, though, and that is the read: a shell that has
    // stopped pushing outward and is simply sitting on the animal is "the tank
    // is empty, go now".
    // THE BUTTON PROLONGS A SHELL; IT CANNOT START ONE. `life > 0` is the whole
    // of that distinction and it is load-bearing: a wind-up held on an empty
    // bar burns nothing, so there is no draining pip, no colour to wear and
    // nothing to shatter — and without this test the button alone lit a shell
    // out of an empty tank, which is the layer claiming fuel the run does not
    // have. The seal opening a run dark is the same rule one step earlier.
    if (draining || (button && life > 0)) {
      if (draining) held += rawDt;
      life = Math.min(1, life + rawDt / Math.max(1e-3, a.rise ?? 0.06));
    } else {
      // THE SHELL KEEPS GOING when the hold ends rather than snapping back.
      // It is a mass of water that was pushed; nothing un-pushes it, and a
      // radius that collapsed would read as the effect being switched off
      // rather than as the boost ending. This is the path for a wind-up that
      // is ABANDONED — a death, a pause, a run ending. A release the player
      // actually made goes out through burstBoostAura instead.
      held += rawDt;
      life = Math.max(0, life - rawDt / Math.max(1e-3, a.fade ?? 0.18));
    }

    // GONE MEANS GONE, in every channel. Returning here without clearing the
    // uniform left uLife parked at whatever it faded to — invisible, because
    // the mesh is hidden, and a lie the moment anything reads the material
    // instead of the flag. A fade that does not land on zero is also how a
    // shell ends up hanging over the animal for the rest of a run the first
    // time somebody makes the quad visible for another reason.
    if (life <= 0) { resetBoostAura(); return; }
    mesh.visible = true;

    churn += rawDt;
    // ...AND THE FIELD SLIDES DOWN THAT LINE, faster the longer the button has
    // been down. INTEGRATED rather than computed from `held`, because the
    // direction can change mid-hold: offset = speed x held would rewrite the
    // whole trail onto the newest heading every time the aim moved, and the
    // shell would snap sideways. Adding this frame's travel to where it had
    // already got to leaves what has been laid down where it was laid.
    //
    // It keeps accumulating through the FADE, on the same argument the radius
    // does: the water was pushed and nothing un-pushes it.
    const speed = flowSpeed(held, a);
    flowAt.x += flowDir.x * speed * rawDt;
    flowAt.y += flowDir.y * speed * rawDt;

    const inner = bodyReach(box, stats?.hitRadius ?? CONFIG.player.hitRadius)
      + (a.gap ?? 0.12);
    const outer = inner + Math.min(a.reach ?? 2.6, (a.push ?? 3.2) * held);

    mesh.position.x = pos.x;
    mesh.position.y = pos.y;
    mesh.position.z = playerOverlayZ();
    mesh.scale.setScalar(outer);

    const u = mesh.material.uniforms;
    u.uCenter.value.set(pos.x, pos.y);
    u.uOuter.value = outer;
    u.uInner.value = inner / outer;
    // HELD THROUGH THE FADE. The pip index goes to -1 the moment the tank is
    // empty, and re-colouring the dying shell white on that frame would be a
    // change of hue nobody asked for on the frame the player let go.
    if (pip >= 0) auraColor(u.uColor.value, pip, pips);
    u.uStrength.value = a.strength ?? 1.9;
    u.uFalloff.value = a.falloff ?? 1.6;
    u.uSoft.value = a.soft ?? 0.18;
    u.uWobble.value = a.wobble ?? 0.55;
    u.uGrain.value = a.grain ?? 0.55;
    u.uWarp.value = a.warp ?? 1.4;
    u.uChurn.value = a.churn ?? 1.7;
    u.uDepth.value = a.depth ?? 0.8;
    u.uContrast.value = a.contrast ?? 1.7;
    u.uTime.value = churn;
    u.uFlow.value.copy(flowAt);
    u.uLife.value = life;
  }

  /**
   * BLOW THE SHELL APART — the let-go. Returns how many specks went out, which
   * is 0 when there was no shell to blow apart.
   *
   * ON THE RELEASE, which is the frame the player did something. Everything
   * else that ends a wind-up — a death, a pause, a run ending — leaves through
   * the fade in update() above, because nothing happened there and water that
   * is not being pushed any more simply settles.
   *
   * The shell is CONSUMED. "Explodes into" is the whole read — water that has
   * been torn into specks is not also still there as a haze, and a shell left
   * fading underneath its own debris reads as two effects that happened to
   * coincide.
   *
   * @param sweet  did this release land in the sweet spot? The caller asks
   *               inSweetSpot() — the SAME function tryStrike judges the
   *               release with, on the same frame, on the same state — rather
   *               than re-deriving the window here. Two spellings of one gate
   *               is how the burst ends up celebrating a strike the game
   *               scored as a miss, and it would only ever disagree on the
   *               frames that matter.
   */
  function burstBoostAura(pos, sweet = false) {
    const a = cfg();
    const b = a.burst ?? {};
    // NOTHING TO SHATTER is not a failure. A release can land on a hold whose
    // shell never lit — the layer is off, the run is not live, or the wind-up
    // was so short the fade-in had not begun.
    if (!mesh || !mesh.visible || life <= 0 || b.enabled === false) return 0;
    if (!CONFIG.emitters?.boostAuraBurst) return 0;

    const u = mesh.material.uniforms;
    const col = u.uColor.value;
    // THROUGH feedback(), NOT STRAIGHT TO THE PARTICLES — which is what puts
    // this in a replay. A Blubberball goal replay re-poses the world from
    // recorded transforms and re-fires the EVENT TRACK (systems/versus.js):
    // every positioned feedback() the match made, on the replay's own clock.
    // Anything that talked to the particle buffer directly fired live, once,
    // seconds before the camera cut back, and is simply missing from the shot —
    // which is the exact failure the track was built for.
    //
    // So the shell does not draw its own debris. It DESCRIBES it, in numbers
    // that survive a shallow copy into the track, and drawBurst below draws it
    // — live and replayed down one path, so a replay cannot quietly diverge.
    // Every field is a primitive for that reason: the recorder keeps `{ ...at }`
    // and a THREE.Color in there would be a live reference to a colour that has
    // moved on by the time the replay reads it.
    // Zeroed before the event, not after: feedback() warns and returns without
    // touching its listeners on an unknown name, and a stale count from the
    // last shatter would then be reported as this one's.
    lastBurst = 0;
    feedback('boostShatter', {
      x: pos.x,
      y: pos.y,
      inner: u.uInner.value * u.uOuter.value,
      outer: u.uOuter.value,
      // The shell's own colour, in the renderer's working space, split into
      // three numbers rather than a hex — going out through sRGB and back
      // would move the hue this layer takes such care to keep exact.
      r: col.r, g: col.g, b: col.b,
      dirX: flowDir.x, dirY: flowDir.y,
      sweet: sweet ? 1 : 0,
    });
    // ...and the shell is gone. See the header on this function. Done here
    // rather than in the listener, because a REPLAYED shatter has no shell of
    // its own to consume — it is a picture of one that came apart a minute ago.
    resetBoostAura();
    return lastBurst;
  }

  /**
   * Write this shell's frame into `out` at `o`. A dark shell writes a zero
   * life, which is all poseBoostAura needs to hide it — there is no separate
   * "was there one" flag to fall out of step with the value.
   */
  function recordBoostAura(out, o = 0) {
    if (!out || out.length < o + AURA_REC) return out;
    const live = mesh && mesh.visible ? life : 0;
    out[o + A_LIFE] = live;
    if (live <= 0) {
      // Zeroed rather than left holding the last burn's radius: two recorded
      // frames are LERPED, so a dark frame carrying a stale 8-unit outer would
      // drag the frame beside it halfway out to it.
      for (let k = 1; k < AURA_REC; k++) out[o + k] = 0;
      return out;
    }
    const u = mesh.material.uniforms;
    out[o + A_INNER] = u.uInner.value * u.uOuter.value;
    out[o + A_OUTER] = u.uOuter.value;
    out[o + A_FLOWX] = u.uFlow.value.x;
    out[o + A_FLOWY] = u.uFlow.value.y;
    out[o + A_R] = u.uColor.value.r;
    out[o + A_G] = u.uColor.value.g;
    out[o + A_B] = u.uColor.value.b;
    return out;
  }

  /**
   * Put a recorded shell back on this seal, between two frames. `pos` is where
   * the replay has just posed the body — the record stores the shell's SIZE,
   * not its place, so a shot re-framed by a different camera still wears it on
   * the animal rather than at the coordinates the match happened at.
   *
   * Returns true if anything was drawn.
   */
  function poseBoostAura(a, b, u, pos, o = 0) {
    if (!mesh) return false;
    if (!a || !b || a.length < o + AURA_REC || b.length < o + AURA_REC) return false;
    const k = Math.max(0, Math.min(1, u));
    // THE NEARER FRAME DECIDES WHETHER THERE IS A SHELL AT ALL. Lerping across
    // the frame it went out on would fade it through a half-lit shell that was
    // never on screen — the shatter is instant, and a dissolve into it is the
    // one thing the let-go must not look like.
    const near = k < 0.5 ? a : b;
    if (near[o + A_LIFE] <= 0) {
      mesh.visible = false;
      mesh.material.uniforms.uLife.value = 0;
      return false;
    }
    const mix = (i) => a[o + i] + (b[o + i] - a[o + i]) * k;
    const inner = mix(A_INNER);
    const outer = Math.max(inner + 1e-4, mix(A_OUTER));
    const uni = mesh.material.uniforms;
    mesh.visible = true;
    mesh.position.x = pos.x;
    mesh.position.y = pos.y;
    mesh.position.z = playerOverlayZ();
    mesh.scale.setScalar(outer);
    uni.uCenter.value.set(pos.x, pos.y);
    uni.uOuter.value = outer;
    uni.uInner.value = inner / outer;
    uni.uFlow.value.set(mix(A_FLOWX), mix(A_FLOWY));
    uni.uColor.value.setRGB(mix(A_R), mix(A_G), mix(A_B));
    uni.uLife.value = near[o + A_LIFE];
    // THE KNOBS ARE READ LIVE, not restored — see the note on AURA_REC. The
    // field's own clock is not recorded either: the grain boils on a replay at
    // the replay's pace, which is the same call the water and the animation
    // make and the alternative is a frozen pattern sitting on a moving shot.
    const cf = cfg();
    uni.uStrength.value = cf.strength ?? 1.9;
    uni.uFalloff.value = cf.falloff ?? 1.6;
    uni.uSoft.value = cf.soft ?? 0.18;
    uni.uWobble.value = cf.wobble ?? 0.55;
    uni.uGrain.value = cf.grain ?? 0.55;
    uni.uWarp.value = cf.warp ?? 1.4;
    uni.uChurn.value = cf.churn ?? 1.7;
    uni.uDepth.value = cf.depth ?? 0.8;
    uni.uContrast.value = cf.contrast ?? 1.7;
    uni.uTime.value = churn;
    return true;
  }

  /** Advance the field's boil alone, for a replay that is posing rather than
   *  simulating. Wall seconds at the replay's own speed. */
  function churnBoostAura(dt) {
    churn += Math.max(0, dt);
  }

  return {
    get mesh() { return mesh; },
    createBoostAura, updateBoostAura, resetBoostAura, burstBoostAura,
    recordBoostAura, poseBoostAura, churnBoostAura,
  };
}

// ---------------------------------------------------------------------------
// THE RUN'S OWN SEAL is the first instance, so main.js reads the way it reads
// for the ring next door. createBoostAuraInstance() makes another, with its
// own clock and its own quad, for every other seal on a Blubberball pitch —
// bots included, which is the one place this parts company with the ring. The
// ring is an INSTRUMENT and a bot's instrument is a circle nobody is reading;
// this is something the WATER is doing, and water does it around whoever is
// burning fuel.
// ---------------------------------------------------------------------------
const aura0 = makeAura();
export function createBoostAura() { return aura0.createBoostAura(); }
export function resetBoostAura() { return aura0.resetBoostAura(); }
// SPREAD, NOT RE-TYPED. These wrappers used to name each parameter, and adding
// `aim` to the instance's signature left the run's OWN seal — the only caller
// that goes through this façade — silently dropping it: the flow worked in
// every harness and on every Blubberball seat, and did nothing at all in a run,
// because the harnesses drive an instance directly. Nothing here may know how
// many arguments there are.
export function updateBoostAura(...args) { return aura0.updateBoostAura(...args); }
export function burstBoostAura(...args) { return aura0.burstBoostAura(...args); }
export function recordBoostAura(...args) { return aura0.recordBoostAura(...args); }
export function poseBoostAura(...args) { return aura0.poseBoostAura(...args); }
export function churnBoostAura(...args) { return aura0.churnBoostAura(...args); }

/**
 * One shell of its own for another seal: { mesh, update, reset, burst, record,
 * pose, churnField, dispose }.
 */
export function createBoostAuraInstance() {
  const a = makeAura();
  const mesh = a.createBoostAura();
  return {
    mesh,
    update: a.updateBoostAura,
    reset: a.resetBoostAura,
    burst: a.burstBoostAura,
    record: a.recordBoostAura,
    pose: a.poseBoostAura,
    churnField: a.churnBoostAura,
    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
  };
}
