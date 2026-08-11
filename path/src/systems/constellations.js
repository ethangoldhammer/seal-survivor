import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea } from '../arena.js';
import { skyLight } from './daylight.js';
import { advanceCycles, phaseOffset } from './beatSync.js';
import { touchSlots, TOUCH_SLOTS } from '../input.js';
import { starsIn, STAR_THRESHOLD } from './starField.js';
import { chainReachAt } from './constellationReach.js';

// THE NIGHT SKY, as the backdrop grid's opposite number.
//
// systems/grid.js is a lattice of lines that nothing simulates: JS pushes
// ripple origins into a uniform array and the vertex shader displaces every
// node it can reach, so the whole field springs off what the player is doing
// for the price of one draw call. This is the same machine pointed at the air
// instead of the water, and it differs from it in exactly three ways:
//
//   THE LATTICE IS NOT REGULAR, AND ITS NODES DO NOT MOVE. The nodes are stars
//   — the brightest of the field systems/sky.js is already painting (see
//   starField.js, which owns the placement for both). The edges are worked out
//   here rather than being a property of the grid: nearest-neighbour links
//   between stars, plus a recursive branch grown out of the brightest ones.
//   Constellations and fractals, from the same node set.
//
//   The grid displaces every node it can reach. Here the stars are FIXED and
//   only the lines between them are displaced, pinned at both ends so they bow
//   rather than come off their stars. That is not a simplification of the
//   grid's behaviour but the opposite of it, and it is the whole difference
//   between a sky and a net: a star is a landmark, and a landmark that slides
//   around when something explodes is no longer one. The constellations are
//   what the shockwave passes THROUGH.
//
//   IT BLOOMS ON THE BEAT. The grid's brightness is a function of how hard it
//   has been shoved. This one's is a function of WHERE IN THE BAR IT IS: every
//   star carries a phase offset quantised onto a beat slot (see phaseOffset in
//   beatSync.js), so a field of them lights in waves that land on the music
//   rather than shimmering at some rate picked by eye. The light then travels
//   along the links, and out through the fractal one generation per sixteenth,
//   so a branch unfolds in time instead of just sitting there being a branch.
//
//   IT IS ONLY THERE AT NIGHT. Gated on skyLight.night, the same 0..1 darkness
//   the sky shader fades its own stars in with and the glowing fish spawn
//   against. At full daylight the group is switched off, so it costs two
//   skipped draw calls rather than a shader that runs and outputs nothing.
//
// Everything else is deliberately the grid's: the same ring buffer of ripples
// with the same decay, the same fingers doing the same push-and-swirl, the
// same clip against the live wave. world.js tees every ripple into both, so a
// depth charge going off in the water rings the constellations overhead
// without anything having to fire a second event — it just rings the strings
// rather than the stars.

const MAX_RIPPLES = 16; // must match the shader's loop bound
const MAX_TOUCH = TOUCH_SLOTS;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// The warp. THE LINK SHADER IS THE ONLY THING THAT INCLUDES THIS — the stars
// are fixed points and never see it, which is what makes the field a field
// rather than a soup. Kept as its own chunk anyway: it is the grid's, almost
// line for line, and the two are worth being able to read side by side.
// ---------------------------------------------------------------------------
const WARP_GLSL = /* glsl */ `
  #define MAX_RIPPLES ${MAX_RIPPLES}
  #define MAX_TOUCH ${MAX_TOUCH}

  uniform float uTime;
  uniform vec3 uRipples[MAX_RIPPLES];      // xy = origin, z = start time
  uniform vec2 uRippleParams[MAX_RIPPLES]; // x = strength, y = radius
  uniform vec4 uTouch[MAX_TOUCH];          // xy = world pos, z = radius, w = level
  uniform vec4 uTouchWarp;                 // x = push, y = swirl, z = wave, w = spin
  uniform float uDecay;
  uniform float uFreq;
  uniform float uWavelength;
  uniform float uSquash;

  vec2 skyWarp(vec2 p) {
    vec2 disp = vec2(0.0);

    for (int i = 0; i < MAX_RIPPLES; i++) {
      // The one line that is not the grid's. A ripple is thrown where the
      // gameplay is, which is under the water and often thirty units below
      // the stars, and a falloff measured in true distance would mean the sky
      // never feels anything at all. Squashing the vertical component of the
      // measurement (not of the shove) lets a blast far below register
      // overhead as a broad swell that arrives mostly sideways -- which is
      // what a shockwave reaching something a long way off looks like.
      vec2 delta = p - uRipples[i].xy;
      float dist = length(vec2(delta.x, delta.y * uSquash)) + 0.0001;
      vec2 dir = delta / (length(delta) + 0.0001);

      float strength = uRippleParams[i].x;
      float radius = uRippleParams[i].y;
      float age = uTime - uRipples[i].z;

      float isLive = step(0.0001, strength) * step(0.0, age);
      float decay = exp(-age * uDecay);
      float wave = sin(dist * uWavelength - age * uFreq);
      float falloff = smoothstep(radius, 0.0, dist);

      disp += dir * wave * falloff * strength * decay * isLive;
    }

    // The fingers. Same two components as the grid: a radial shove that
    // pulses outward and a tangential shear, because the shove alone reads as
    // one more ripple and it is the shear that pulls the constellation out of
    // its own shape. A slot with level 0 contributes exactly nothing.
    for (int i = 0; i < MAX_TOUCH; i++) {
      float level = uTouch[i].w;
      vec2 delta = p - uTouch[i].xy;
      float dist = length(delta) + 0.0001;
      vec2 dir = delta / dist;
      float fall = smoothstep(uTouch[i].z, 0.0, dist);
      float pulse = sin(dist * uTouchWarp.z - uTime * uTouchWarp.w);
      disp += (dir * pulse * uTouchWarp.x + vec2(-dir.y, dir.x) * uTouchWarp.y)
              * fall * level;
    }

    return disp;
  }
`;

// The bloom, also shared. A star's brightness is a position in the bar, not a
// sine of the clock: fract() puts every node somewhere in 0..1 of the current
// cycle and the exponential turns that into a spike with a hard attack and a
// long tail. A sine would have the field spending half of every bar getting
// brighter, which is a throb; this is a flash and a decay, which is a bloom.
const BLOOM_GLSL = /* glsl */ `
  uniform float uCycle;    // where in the bloom cycle we are, 0..1
  uniform vec4 uBloom;     // x = decay, y = floor, z = gain, w = swell
  uniform float uGenDelay; // cycles a fractal generation lags its parent by
  uniform float uTravel;   // cycles light takes to cross one link

  float bloomAt(float phase) {
    return exp(-fract(uCycle - phase) * uBloom.x);
  }
`;

// The surface, transcribed from arena.js exactly as the grid transcribes it —
// same constants, injected rather than retyped, so the sky is cut on the same
// curve the water is drawn with. Every literal carries a decimal point: GLSL
// ES will not coerce an int, so a WAVE value that happened to be whole would
// fail to compile.
const SURFACE_GLSL = /* glsl */ `
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;
  uniform float uHaze;

  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }

  // How much of this fragment survives the horizon. Not a cut but a ramp, over
  // uHaze world units above the wave: stars really do dim into the muck at the
  // horizon, the sky shader already fades its own field the same way, and a
  // hard edge here would put a row of half-stars along the water line every
  // time a swell came through.
  float aboveWater(vec2 p) {
    return smoothstep(surfaceAt(p.x), surfaceAt(p.x) + uHaze, p.y);
  }
`;

// ---------------------------------------------------------------------------
// The stars. One quad each, in WORLD units rather than gl_PointSize, so they
// grow with the frame when the death dive pushes in — a sky of fixed-pixel
// dots would visibly stay behind while everything else got closer.
//
// THE STARS DO NOT MOVE. This shader does not include WARP_GLSL at all, and
// that omission is the design: a star is a FIXED POINT that the sky is
// measured against. Only the lines strung between them are pushed around (see
// linkVertex, and the mask that pins their ends), so a ripple going through
// bows the constellation without dragging the constellation's own vertices
// off the field they were placed on.
//
// A star still swells and lights on the beat — that is size and brightness,
// about a centre that stays exactly where starField.js put it.
// ---------------------------------------------------------------------------
const starVertex = /* glsl */ `
  ${BLOOM_GLSL}

  attribute vec2 aCorner; // -1..1 across the quad
  attribute float aBright;
  attribute float aPhase;
  attribute float aScale;
  attribute float aGen;

  uniform float uSize;

  varying vec2 vCorner;
  varying float vBloom;
  varying float vBright;
  varying vec2 vPos;

  void main() {
    vec2 centre = position.xy;
    float b = bloomAt(aPhase + aGen * uGenDelay);
    float size = uSize * aScale * (1.0 + uBloom.w * b);

    vCorner = aCorner;
    vBloom = b;
    vBright = aBright;
    vPos = centre; // the centre, so the horizon fade takes the whole star at
                   // once rather than eating it from the bottom up

    gl_Position = projectionMatrix * modelViewMatrix
      * vec4(centre + aCorner * size, position.z, 1.0);
  }
`;

const starFragment = /* glsl */ `
  ${SURFACE_GLSL}

  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform float uOpacity;
  uniform float uNight;
  uniform vec4 uStar;   // x = core power, y = halo power, z = halo amount, w = spike width
  uniform float uSpike;
  uniform vec4 uBloom;  // x = decay, y = floor, z = gain, w = swell

  varying vec2 vCorner;
  varying float vBloom;
  varying float vBright;
  varying vec2 vPos;

  void main() {
    float lift = aboveWater(vPos);
    if (lift <= 0.0) discard;

    float d = length(vCorner);
    if (d >= 1.0) discard;
    float r = 1.0 - d;

    // Two lobes and a cross. The lobes are the same trick the sun's halo uses
    // (a tight core inside a wide bloom, because one power curve is either a
    // hard disc or a grey smudge); the cross is what makes it read as a STAR
    // rather than as a dot. min(|x|,|y|) is the distance to the nearer axis,
    // so it is 0 all the way along both arms and grows fastest on the
    // diagonals -- an exponential of it is a four-point flare, for one line.
    float core = pow(r, uStar.x);
    float halo = pow(r, uStar.y) * uStar.z;
    // Scaled by the star's own seed as well as the slider: the field is drawn
    // at one size with a per-star scale, so without this every star wears the
    // same flare and the big ones stop reading as brighter than the small.
    float spike = exp(-min(abs(vCorner.x), abs(vCorner.y)) * uStar.w) * r
      * uSpike * (0.4 + 0.6 * vBright);

    // The spikes ride the bloom harder than the body does. A star that only
    // got brighter would read as a fader being pushed; one that grows arms on
    // the beat reads as a star catching light.
    float amt = core + halo + spike * (0.25 + 0.75 * vBloom);
    float lit = uBloom.y + uBloom.z * vBloom;

    gl_FragColor = vec4(
      mix(uColor, uHotColor, vBloom) * lit,
      clamp(amt * lit * uOpacity * uNight * lift, 0.0, 1.0)
    );
  }
`;

// ---------------------------------------------------------------------------
// The links, and the only thing in this system that moves.
//
// Straight runs cut into pieces so a ripple bends them into curves instead of
// kinking their endpoints — the grid's `subdivisions`, for the same reason and
// with the same failure mode if it is set to 1.
//
// THE MASK. The stars are fixed (see starVertex), so a link displaced along
// its whole length would pull its ends off the two stars it is supposed to
// join: at rest it is a constellation, and the moment anything rippled it
// would be a web of lines floating near some stars. sin(pi * run) is exactly
// zero at both ends and one in the middle, so every link stays welded to its
// stars and does all its moving in between them — a string pinned at both
// ends, which is the right physical picture for what this is.
//
// It also means `run` is doing two unrelated jobs. That is fine and worth
// stating: it is the parameter along the link, so it is what the light
// travels on AND what the bend is shaped by.
//
// AND THE BOW IS CAPPED AGAINST THE LINK'S OWN LENGTH. The ripple hands back a
// displacement in world units, which is the right thing for a lattice of
// equal spans and the wrong thing here: the fractal's deepest twigs are under
// a unit long, so a shove that bows a twelve-unit constellation line
// pleasantly throws a twig nearly twice its own length and the branch reads as
// noise rather than as motion. A string's swing is a fraction of the string,
// so aSpan (the link's rest length) is what the bow is measured against.
// ---------------------------------------------------------------------------
const linkVertex = /* glsl */ `
  ${WARP_GLSL}
  ${BLOOM_GLSL}

  attribute float aPhase;
  attribute float aRun;  // 0..1 along the link, from the brighter end
  attribute float aSpan; // the link's rest length, world units
  attribute float aRank; // which nearest-neighbour it was, 0 = closest
  attribute float aGen;

  uniform float uBend;
  uniform float uBendMax;
  uniform vec4 uChain; // x = reach, y = reach fade, z = links per star, w = glow

  varying float vBloom;
  varying float vWarp;
  varying vec2 vPos;
  varying float vGen;
  varying float vLive;

  // THE FOOD CHAIN, as a gate on the geometry that is already there.
  //
  // Every link of a chain widens the sky: the reach grows, and each star is
  // allowed to hold more neighbours. Both are uniforms, so a combo re-wires the
  // constellations without touching a buffer — the edges were all built at the
  // deepest chain's reach and most of them are simply waiting.
  //
  // Two gates, because they are two different claims. REACH is how far a star
  // can see, and it lets in the long links across empty sky. LINKS is how many
  // it will hold, and it lets in the extra neighbours of stars that were
  // already crowded. A chain that only grew the radius would do nothing at all
  // inside a dense cluster, which is exactly where the eye is.
  float chainLive() {
    float byReach = 1.0 - smoothstep(uChain.x - uChain.y, uChain.x, aSpan);
    // Fractional on purpose: the newest neighbour fades up as the chain
    // climbs rather than snapping in on a whole number.
    float byRank = clamp(uChain.z - aRank, 0.0, 1.0);
    // Generation 0 is a constellation link between two stars and the only
    // family the chain governs. The fractal is a property of its anchor star,
    // not of how well the seal is eating, so it stays put.
    return mix(1.0, byReach * byRank, step(vGen, 0.5));
  }

  void main() {
    vGen = aGen;
    vLive = chainLive();
    float anchored = sin(3.14159265 * clamp(aRun, 0.0, 1.0));

    vec2 raw = skyWarp(position.xy) * uBend;
    float mag = length(raw);
    // Clamped, not scaled: a long link keeps the ripple's own shape and
    // amplitude, and only the links too short to carry it get held back.
    float bow = min(mag, aSpan * uBendMax);
    vec2 disp = mag > 0.00001 ? (raw / mag) * bow * anchored : vec2(0.0);
    vec2 p = position.xy + disp;

    // aRun is what makes the light TRAVEL. Every vertex on the link asks about
    // a slightly later moment in the cycle than the one before it, so the
    // bloom that lit the star at one end arrives at the other uTravel cycles
    // later instead of the whole line flashing at once.
    vBloom = bloomAt(aPhase + aGen * uGenDelay + aRun * uTravel);
    vWarp = length(disp);
    vPos = p;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, position.z, 1.0);
  }
`;

const linkFragment = /* glsl */ `
  ${SURFACE_GLSL}

  uniform vec3 uLinkColor;
  uniform vec3 uHotColor;
  uniform vec3 uFractalColor;
  uniform float uLinkOpacity;
  uniform float uNight;
  uniform float uWarpGain;
  uniform vec4 uBloom;
  uniform vec4 uChain; // w = the extra brightness a live chain lends

  varying float vBloom;
  varying float vWarp;
  varying vec2 vPos;
  varying float vGen;
  varying float vLive;

  void main() {
    // A link the food chain has not reached yet is not drawn at all. Discarded
    // rather than left to add zero, because most of this geometry is waiting
    // most of the time and additive blending would still have it walked.
    if (vLive <= 0.001) discard;
    float lift = aboveWater(vPos);
    if (lift <= 0.0) discard;

    // A shove lights the line it went through, exactly as it does in the
    // grid. This is the whole reason the sky is on the ripple bus: without it
    // a ripple would move the constellations silently and the effect would be
    // a wobble nobody notices.
    float heat = clamp(vBloom + vWarp * uWarpGain, 0.0, 1.0);
    // Generation 0 is a constellation link between two real stars; anything
    // above it is fractal, and gets its own colour so the two families read as
    // different kinds of line rather than as one messy web.
    vec3 base = mix(uLinkColor, uFractalColor, step(0.5, vGen));

    // The chain's own glow rides on top. A deep combo doesn't only wire more
    // of the sky together, it burns what is already wired a little hotter —
    // otherwise the newest, longest, faintest links are the only evidence and
    // they arrive at the edge of the frame.
    float lit = (uBloom.y + uBloom.z * heat) * (1.0 + uChain.w);

    gl_FragColor = vec4(
      mix(base, uHotColor, heat),
      clamp(lit * uLinkOpacity * uNight * lift * vLive, 0.0, 1.0)
    );
  }
`;

// ---------------------------------------------------------------------------
// Generation — all of it deterministic, all of it at build time.
// ---------------------------------------------------------------------------

// A scrambler for the fractal's own choices. Seeded off the anchor star, so a
// tree is a property of the star it grows from: the same star grows the same
// tree after a resize, after a tuner edit, and in the Node harness.
function scrambler(seed) {
  let n = seed * 1e4;
  return () => {
    n += 1;
    const v = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
}

/**
 * Nearest-neighbour links over the promoted stars.
 *
 * Each star reaches for its `per` closest neighbours inside `radius`, and the
 * pairs are de-duplicated by endpoint — the same edge comes up twice (once
 * from each end) and drawing it twice would double its brightness under
 * additive blending, which is the same seam the hex grid de-duplicates for.
 *
 * The kept edge is oriented BRIGHT END FIRST, so the travelling bloom always
 * runs downhill from the more prominent star. That is the difference between
 * a network firing in some order and a network firing in an order that looks
 * like it means something.
 */
function linkStars(stars, radius, per) {
  const edges = [];
  if (per <= 0 || radius <= 0) return edges;
  const byKey = new Map();
  const near = [];

  for (let i = 0; i < stars.length; i++) {
    const a = stars[i];
    near.length = 0;
    for (let j = 0; j < stars.length; j++) {
      if (j === i) continue;
      const b = stars[j];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d <= radius) near.push({ j, d });
    }
    near.sort((p, q) => p.d - q.d);

    for (let k = 0; k < Math.min(per, near.length); k++) {
      const j = near[k].j;
      const key = i < j ? `${i}|${j}` : `${j}|${i}`;
      // The rank kept for a shared edge is the LOWER of the two ends'. An edge
      // that is one star's fourth-nearest and another's first is a first-order
      // link: whichever end was sure of it would have drawn it at rest.
      const already = byKey.get(key);
      if (already) {
        already.rank = Math.min(already.rank, k);
        continue;
      }
      const b = stars[j];
      const [from, to] = a.seed >= b.seed ? [a, b] : [b, a];
      const edge = {
        x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        seed: from.seed, phase: from.phase, gen: 0, rank: k,
      };
      byKey.set(key, edge);
      edges.push(edge);
    }
  }
  return edges;
}


/**
 * The fractal. A branch grown out of an anchor star: `branches` children fanned
 * across `spread` radians, each shorter than its parent by `shrink`, recursing
 * `depth` times. Self-similar by construction, so it keeps looking like itself
 * at every scale — which is the only reason a shape this cheap reads as
 * deliberate rather than as scribble.
 *
 * Every tip becomes a star in its own right, at `tipScale` of its parent's
 * size, so the fractal is not a decoration hung off the field: it is more
 * field, and it blooms and springs with the rest of it.
 *
 * A branch that would leave the sky is dropped along with everything under it.
 * The fragment shader would clip it at the water anyway, but the recursion
 * below it is pure cost for geometry nobody can see.
 */
function growFractal(anchor, cfg, rect, out) {
  const depth = Math.max(0, Math.round(cfg.depth ?? 0));
  const branches = Math.max(1, Math.round(cfg.branches ?? 2));
  const spread = cfg.spread ?? 1.2;
  const shrink = Math.max(0.05, Math.min(0.98, cfg.shrink ?? 0.68));
  const wobble = cfg.wobble ?? 0.35;
  const tipScale = Math.max(0.05, cfg.tipScale ?? 0.6);
  if (depth <= 0) return;

  const rnd = scrambler(anchor.seed);

  const grow = (x, y, angle, len, gen, scale) => {
    if (gen > depth) return;
    for (let b = 0; b < branches; b++) {
      // -0.5..0.5 across the fan, so an odd branch count keeps one child
      // running straight on and an even one splits cleanly around the parent.
      const t = branches === 1 ? 0 : b / (branches - 1) - 0.5;
      const a = angle + t * spread + (rnd() - 0.5) * wobble;
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      if (nx < rect.left || nx > rect.right || ny < rect.bottom || ny > rect.top) continue;

      out.edges.push({
        x1: x, y1: y, x2: nx, y2: ny,
        seed: anchor.seed, phase: anchor.phase, gen,
      });
      out.stars.push({
        x: nx, y: ny, seed: anchor.seed, bright: anchor.bright, phase: anchor.phase,
        scale: scale * tipScale, gen,
      });
      grow(nx, ny, a, len * shrink, gen + 1, scale * tipScale);
    }
  };

  // The root angle is the anchor's own seed, so each tree points somewhere
  // different and the sky doesn't grow a field of identical shrubs.
  grow(anchor.x, anchor.y, anchor.seed * TAU, Math.max(0.1, cfg.length ?? 4), 1, 1);
}

// Every line goes through here, so both families get the same subdivision —
// see the grid's pushRun, which this is.
function pushRun(out, edge, sub) {
  const { x1, y1, x2, y2 } = edge;
  // Carried per vertex rather than worked out in the shader, because the
  // shader only ever sees one end of the line at a time — there is no way to
  // ask "how long am I" from inside it.
  const span = Math.hypot(x2 - x1, y2 - y1);
  for (let s = 0; s < sub; s++) {
    const t0 = s / sub;
    const t1 = (s + 1) / sub;
    out.pos.push(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0, 0);
    out.pos.push(x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, 0);
    out.phase.push(edge.phase, edge.phase);
    out.run.push(t0, t1);
    out.span.push(span, span);
    out.rank.push(edge.rank ?? 0, edge.rank ?? 0);
    out.gen.push(edge.gen, edge.gen);
  }
}

const QUAD = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];

/**
 * The whole field, from CONFIG and the current bounds. Pure — it allocates no
 * GPU resources and reads no clock, which is what makes it testable in Node.
 */
export function buildConstellationField(cfg = CONFIG.constellations ?? {}, view = bounds) {
  const margin = Math.max(0, cfg.margin ?? 4);
  const rect = {
    left: view.left - margin,
    right: view.right + margin,
    // Down to the still water line: the fragment shader hazes anything below
    // the wave away, and a star sitting in the trough of a swell is a star
    // that should be visible when the crest passes.
    bottom: view.surfaceY,
    top: view.top + margin,
  };

  // The sky's own field, at the sky's own density. `brightest` is a fraction
  // of THAT field promoted to geometry rather than a count, so the two can
  // never disagree about how many stars there are to promote.
  const density = CONFIG.dayNight?.stars?.density ?? 0.55;
  const keep = Math.max(0, Math.min(1, cfg.brightest ?? 0.5));
  const threshold = 1 - (1 - STAR_THRESHOLD) * keep;
  const field = starsIn(rect, density, STAR_THRESHOLD);
  const spread = cfg.phaseSpread ?? 1;
  const steps = Math.max(0, Math.round(cfg.phaseSteps ?? 0));

  const stars = [];
  for (const s of field) {
    if (s.seed <= threshold) continue;
    stars.push({
      x: s.x, y: s.y,
      // The raw hash. Identity, the order links run in, and the seed the
      // fractal's own scrambler is built from — never a brightness.
      seed: s.seed,
      // THE RANK, 0..1 across the promoted band. `seed` cannot do this job: a
      // star is here BECAUSE its hash was high, so the seeds that survive are
      // all crammed into the top few percent and sizing anything off them
      // gives a field of identical stars. Stretching the surviving band back
      // over 0..1 is what puts a real spread of sizes in the sky.
      bright: Math.max(0, Math.min(1, (s.seed - threshold) / Math.max(1e-6, 1 - threshold))),
      // Quantised onto beat slots, which is the point of doing it here rather
      // than with a plain random: a field offset by a continuous fraction of a
      // cycle is a field where nothing lands on a beat. Off `spin` — the
      // independent hash — for the same reason `bright` exists, and this one
      // is worse if it is got wrong: a phase quantised from `seed` puts every
      // star in the same slot, which is a sky that flashes as one piece and
      // looks like a working effect until you count the flashes.
      phase: phaseOffset(s.spin, spread, steps),
      gen: 0,
    });
  }
  for (const s of stars) s.scale = 0.55 + 0.45 * s.bright;

  // Built at the reach the DEEPEST chain would ask for, not the resting one.
  // Every edge past the resting reach is dark until the food chain gets there
  // (see the chain gate in linkVertex), which is what lets a combo widen the
  // sky for the price of a uniform write instead of a rebuild mid-fight.
  const most = chainReachAt(Infinity, cfg);
  const edges = linkStars(stars, most.radius, Math.round(most.links));

  // The fractals grow from the brightest of the promoted stars, so the trees
  // hang off the anchors of the constellations rather than off some second,
  // unrelated set of points.
  const out = { edges: [], stars: [] };
  const fcfg = cfg.fractal ?? {};
  if (fcfg.enabled !== false) {
    const want = Math.max(0, Math.min(1, fcfg.anchors ?? 0.25));
    const sorted = [...stars].sort((a, b) => b.seed - a.seed);
    for (const anchor of sorted.slice(0, Math.round(sorted.length * want))) {
      growFractal(anchor, fcfg, rect, out);
    }
  }

  return {
    rect,
    stars: [...stars, ...out.stars],
    edges: [...edges, ...out.edges],
    counts: {
      field: field.length,
      stars: stars.length,
      tips: out.stars.length,
      links: edges.length, // every one BUILT — most are dark at rest
      resting: countLive(edges, 0, cfg), // and this is what is drawn with no chain
      branches: out.edges.length,
    },
  };
}

/**
 * How many links are lit at a given depth of chain. The shader's gate, in JS —
 * the tuner prints it and the harness asserts on it, and neither of them can
 * see a uniform.
 */
export function countLive(edges, level, cfg = CONFIG.constellations ?? {}) {
  const { radius, links } = chainReachAt(level, cfg);
  return edges.filter((e) => {
    if (e.gen > 0) return true; // the fractal is not the chain's business
    const span = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    return span <= radius && (e.rank ?? 0) < links;
  }).length;
}

// ---------------------------------------------------------------------------

export function createConstellations(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  let starMesh = null;
  let linkMesh = null;
  let counts = { field: 0, stars: 0, tips: 0, links: 0, branches: 0 };
  let clock = 0;
  let cursor = 0;
  let bloomCycle = 0;
  let waveT = 0;
  // The food chain, as the sky sees it. `chainTarget` is what the strike
  // system currently says (whole links, pushed in by main.js); `chainLevel` is
  // what the sky has actually got to, eased toward it. The gap between them is
  // the effect: a chain landing pulls the constellations open over a few
  // frames instead of teleporting a new web into the sky, and a chain lapsing
  // lets them close slowly rather than snapping shut on the same frame the
  // window expires.
  let chainTarget = 0;
  let chainLevel = 0;

  const ripples = new Array(MAX_RIPPLES).fill(0).map(() => new THREE.Vector3());
  const rippleParams = new Array(MAX_RIPPLES).fill(0).map(() => new THREE.Vector2());
  const touch = new Array(MAX_TOUCH).fill(0).map(() => new THREE.Vector4(0, 0, 1, 0));
  const touchOwner = new Array(MAX_TOUCH).fill(null);
  const touchPoint = new THREE.Vector3();

  // ONE uniform record, two materials. three is happy to share uniform objects
  // between programs (it walks each PROGRAM's active uniforms and looks them up
  // by name, so an entry only one of them declares costs nothing), and sharing
  // them here is what guarantees a star and the line leaving it are on the same
  // beat, in the same night, cut at the same wave — the alternative is two sets
  // of writes that agree until the day one of them is edited.
  const uniforms = {
    uTime: { value: 0 },
    uRipples: { value: ripples },
    uRippleParams: { value: rippleParams },
    uTouch: { value: touch },
    uTouchWarp: { value: new THREE.Vector4(0, 0, 1, 0) },
    uDecay: { value: 2.6 },
    uFreq: { value: 9 },
    uWavelength: { value: 1.4 },
    uSquash: { value: 0.25 },
    uCycle: { value: 0 },
    uBloom: { value: new THREE.Vector4(5, 0.3, 1, 0.8) },
    uGenDelay: { value: 0.0625 },
    uTravel: { value: 0.05 },
    uSurfaceY: { value: bounds.surfaceY },
    uWaveT: { value: 0 },
    uWaveAmp: { value: CONFIG.arena.waveAmplitude },
    uChop: { value: 0 },
    uHaze: { value: 3 },
    uNight: { value: 0 },
    uHotColor: { value: new THREE.Color(0xfff2cc) },
    // stars only
    uSize: { value: 0.3 },
    uColor: { value: new THREE.Color(0xbcd8ff) },
    uOpacity: { value: 0.9 },
    uStar: { value: new THREE.Vector4(1.6, 0.5, 0.35, 5) },
    uSpike: { value: 0.7 },
    // links only
    uLinkColor: { value: new THREE.Color(0x2f5f96) },
    uFractalColor: { value: new THREE.Color(0x6f4fb0) },
    uLinkOpacity: { value: 0.5 },
    uWarpGain: { value: 1.5 },
    uBend: { value: 1 },
    uBendMax: { value: 0.3 },
    uChain: { value: new THREE.Vector4(10, 2.5, 2, 0) },
  };

  function dispose() {
    for (const mesh of [starMesh, linkMesh]) {
      if (!mesh) continue;
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    starMesh = null;
    linkMesh = null;
  }

  function build() {
    dispose();
    const cfg = CONFIG.constellations;
    if (!cfg?.enabled) return;

    const field = buildConstellationField(cfg, bounds);
    counts = field.counts;
    group.position.z = cfg.depth ?? -5.7;

    // --- the stars ----------------------------------------------------------
    if (field.stars.length) {
      const n = field.stars.length;
      const pos = new Float32Array(n * 18);
      const corner = new Float32Array(n * 12);
      const bright = new Float32Array(n * 6);
      const phase = new Float32Array(n * 6);
      const scale = new Float32Array(n * 6);
      const gen = new Float32Array(n * 6);

      for (let i = 0; i < n; i++) {
        const s = field.stars[i];
        for (let v = 0; v < 6; v++) {
          const o = i * 6 + v;
          pos[o * 3] = s.x;
          pos[o * 3 + 1] = s.y;
          pos[o * 3 + 2] = 0;
          corner[o * 2] = QUAD[v][0];
          corner[o * 2 + 1] = QUAD[v][1];
          bright[o] = s.bright;
          phase[o] = s.phase;
          scale[o] = s.scale;
          gen[o] = s.gen;
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
      geo.setAttribute('aGen', new THREE.BufferAttribute(gen, 1));

      starMesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        vertexShader: starVertex,
        fragmentShader: starFragment,
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      // Below the sun and moon's halo at -12, which is itself below every
      // other transparent thing in the game. renderOrder is compared before
      // depth in the transparent sort, so this is what keeps the sky behind
      // the moon rather than sprinkled over it.
      starMesh.renderOrder = -13;
      starMesh.frustumCulled = false;
      group.add(starMesh);
    }

    // --- the links ----------------------------------------------------------
    const sub = Math.max(1, Math.floor(cfg.subdivisions ?? 4));
    const runs = { pos: [], phase: [], run: [], span: [], rank: [], gen: [] };
    for (const edge of field.edges) pushRun(runs, edge, sub);

    if (runs.pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(runs.pos, 3));
      geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(runs.phase, 1));
      geo.setAttribute('aRun', new THREE.Float32BufferAttribute(runs.run, 1));
      geo.setAttribute('aSpan', new THREE.Float32BufferAttribute(runs.span, 1));
      geo.setAttribute('aRank', new THREE.Float32BufferAttribute(runs.rank, 1));
      geo.setAttribute('aGen', new THREE.Float32BufferAttribute(runs.gen, 1));

      linkMesh = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
        vertexShader: linkVertex,
        fragmentShader: linkFragment,
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      linkMesh.renderOrder = -14; // under its own stars
      linkMesh.frustumCulled = false;
      group.add(linkMesh);
    }
  }

  // The surface owns the wave clock; this only borrows it to know where the
  // haze starts. Pushed in by world.updateSurface, exactly as the grid's is.
  function setWaveTime(t) {
    waveT = t;
    uniforms.uWaveT.value = t;
  }

  // Punch the sky. Same signature as grid.ripple and fed from the same call
  // sites — see world.js, which tees every ripple into both backdrops.
  function ripple(x, y, strength, radius) {
    if (!starMesh && !linkMesh) return;
    const cfg = CONFIG.constellations;
    const gain = cfg?.rippleGain ?? 0;
    if (!strength || !gain) return;
    const slot = cursor % MAX_RIPPLES;
    cursor += 1;
    ripples[slot].set(x, y, clock);
    rippleParams[slot].set(
      strength * gain,
      Math.max(0.1, radius * (cfg.rippleReach ?? 1)),
    );
  }

  // The fingers, resolved through the camera every frame for the reason
  // grid.js spells out at length: the camera follows the player, so a thumb
  // held still is over a different piece of sky each frame and a world
  // position cached at touchdown slides out from under it. Simpler than the
  // grid's, deliberately — the sky has one palette and no charge meter, so
  // what is left is a position, a reach and an eased level.
  function updateTouch(dt, view) {
    const cfg = CONFIG.constellations.touch ?? {};
    const camera = view?.camera;
    const on = cfg.enabled !== false && !!camera;
    uniforms.uTouchWarp.value.set(
      cfg.push ?? 0, cfg.swirl ?? 0, cfg.wave ?? 1, cfg.spin ?? 0,
    );

    for (let i = 0; i < MAX_TOUCH; i++) {
      const slot = touchSlots[i];
      const live = on && slot.id !== null;
      const u = touch[i];

      if (live && slot.id !== touchOwner[i]) {
        u.w = 0; // a new finger in this slot starts from nothing
        touchOwner[i] = slot.id;
      }
      if (!live) touchOwner[i] = null;

      if (live || u.w > 0.001) {
        touchPoint.set(slot.x, slot.y, 0).unproject(camera);
        u.x = touchPoint.x;
        u.y = touchPoint.y;
        u.z = Math.max(0.001, cfg.radius ?? 8);
      }

      const rate = live ? (cfg.attack ?? 14) : (cfg.release ?? 4);
      u.w += ((live ? 1 : 0) - u.w) * (1 - Math.exp(-Math.max(0, rate) * dt));
      if (!live && u.w < 0.001) u.w = 0;
    }
  }

  /**
   * @param rawDt real seconds. Raw, like every other beat-synced effect: the
   *   sky has no business stopping because the game froze for 60ms on a hit.
   * @param view  { camera } — handed in rather than imported, as the grid's is.
   */
  function update(rawDt, view = {}) {
    clock += rawDt;
    const cfg = CONFIG.constellations;
    if (!cfg?.enabled || (!starMesh && !linkMesh)) {
      group.visible = false;
      return;
    }

    // THE NIGHT GATE. skyLight.night is 0 whenever the day/night cycle is off,
    // so "only at night" needs no second switch: with the cycle disabled this
    // system simply never appears. Ramped over two thresholds like the
    // nocturnal spawns are, so the field arrives with the dark rather than
    // switching on at some exact elevation.
    const dusk = cfg.dusk ?? 0.15;
    const dark = Math.max(dusk + 0.01, cfg.dark ?? 0.6);
    const night = Math.max(0, Math.min(1, (skyLight.night - dusk) / (dark - dusk)));
    // Eased, so dusk is a fade-in rather than a ramp that is already half up
    // while the sun is still above the water. Written BEFORE the early return
    // — an invisible group isn't drawn either way, but a uniform left at last
    // night's value is a lie to anything that reads it, the tuner included.
    uniforms.uNight.value = night * night * (3 - 2 * night);
    group.visible = night > 0.002;
    if (!group.visible) return;

    bloomCycle = advanceCycles(
      bloomCycle, cfg.bloomSync, Math.max(0, cfg.bloomRate ?? 0.5), rawDt, 1,
    );

    const u = uniforms;
    u.uTime.value = clock;
    u.uCycle.value = bloomCycle;
    u.uBloom.value.set(
      Math.max(0.01, cfg.bloomDecay ?? 5),
      cfg.base ?? 0.3,
      cfg.gain ?? 1,
      cfg.swell ?? 0.8,
    );
    u.uGenDelay.value = cfg.genDelay ?? 0.0625;
    u.uTravel.value = cfg.travel ?? 0.05;
    u.uSize.value = Math.max(0.001, cfg.size ?? 0.3);
    u.uStar.value.set(
      Math.max(0.1, cfg.core ?? 1.6),
      Math.max(0.1, cfg.halo ?? 0.5),
      cfg.haloAmount ?? 0.35,
      Math.max(0.1, cfg.spikeWidth ?? 5),
    );
    u.uSpike.value = cfg.spike ?? 0.7;
    u.uOpacity.value = cfg.opacity ?? 0.9;
    u.uLinkOpacity.value = cfg.linkOpacity ?? 0.5;
    u.uWarpGain.value = cfg.warpGain ?? 1.5;
    u.uBend.value = cfg.bend ?? 1;
    u.uBendMax.value = Math.max(0, cfg.bendMax ?? 0.3);

    // THE FOOD CHAIN. Eased rather than stepped, and asymmetrically: the sky
    // opens faster than it closes, because the opening is the reward and the
    // closing is the absence of one.
    const chain = cfg.chain ?? {};
    const max = Math.max(1, chainReachAt(Infinity, cfg).depth);
    // Clamped BEFORE the ease, not after. A twelve-deep chain against a
    // maxLevel of eight would otherwise ease up to twelve, sit clamped at
    // eight while it drained back down through the four levels the sky cannot
    // use, and read as a reach that stayed open long after the combo died.
    const target = Math.min(chainTarget, max);
    const rate = target > chainLevel ? (chain.attack ?? 6) : (chain.release ?? 1.8);
    chainLevel += (target - chainLevel) * (1 - Math.exp(-Math.max(0, rate) * rawDt));
    if (target === 0 && chainLevel < 0.002) chainLevel = 0;

    const reach = chainReachAt(chainLevel, cfg);
    u.uChain.value.set(
      reach.radius,
      Math.max(0.01, chain.fade ?? 2.5),
      reach.links,
      (chain.glow ?? 0) * Math.min(1, reach.depth / max),
    );
    u.uColor.value.set(cfg.color ?? 0xbcd8ff);
    u.uHotColor.value.set(cfg.hotColor ?? 0xfff2cc);
    u.uLinkColor.value.set(cfg.linkColor ?? 0x2f5f96);
    u.uFractalColor.value.set(cfg.fractalColor ?? 0x6f4fb0);
    u.uDecay.value = cfg.rippleDecay ?? 2.6;
    u.uFreq.value = cfg.rippleFreq ?? 9;
    u.uWavelength.value = cfg.rippleWavelength ?? 1.4;
    u.uSquash.value = Math.max(0.01, cfg.rippleSquash ?? 0.25);
    u.uHaze.value = Math.max(0.01, cfg.haze ?? 3);

    // The live sea state, on the same terms as the grid and the water fill:
    // the sky is cut on whatever the wave is doing this frame, not on the
    // amplitude the config was authored with.
    u.uSurfaceY.value = bounds.surfaceY;
    u.uWaveAmp.value = sea.amp;
    u.uChop.value = sea.chop;

    updateTouch(rawDt, view);
  }

  /**
   * How deep the food chain is right now, in whole links.
   *
   * Pushed in by main.js rather than read off strikeState here, for the reason
   * grid.js gives about the same numbers: systems/strike.js pulls the whole
   * enemy graph in behind it, and a backdrop wants one number, not a
   * dependency on combat.
   *
   * Set EVERY FRAME from the live chain, not fired once per link. That is what
   * makes the reach retract exactly when the chain window expires, rather than
   * on a second timer here that would drift from the real one the first time
   * anyone tuned `chainWindow`.
   */
  function setChain(depth) {
    chainTarget = Number.isFinite(depth) ? Math.max(0, depth) : 0;
  }

  function reset() {
    for (let i = 0; i < MAX_RIPPLES; i++) rippleParams[i].set(0, 1);
    cursor = 0;
    chainTarget = 0;
    chainLevel = 0;
    for (let i = 0; i < MAX_TOUCH; i++) {
      touch[i].set(0, 0, 1, 0);
      touchOwner[i] = null;
    }
  }

  build();
  reset();

  return {
    build,
    dispose,
    ripple,
    update,
    reset,
    setWaveTime,
    setChain,
    group,
    stats: () => ({ ...counts, chain: chainLevel }),
  };
}
