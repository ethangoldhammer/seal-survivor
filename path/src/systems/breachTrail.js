import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { turbulenceAt, emit } from '../entities/particles.js';

// ============================================================================
// THE BREACH TRAIL — the RGB-split exhaust the seal drags through the air.
//
// ...and the SWIM TRAIL, the plain white ribbon it draws underwater. They are
// one effect with two settings blocks rather than two systems; see "TWO TRAILS,
// ONE ALGORITHM" below the constants. Everything in this header describes both,
// except the RGB split, which is the air trail's alone.
//
// Three ribbons, one per colour channel, drawn additively over each other. Each
// reads the SAME spine at a different offset, so where they agree they sum back
// to white and where they don't they fringe. That is what makes the split read
// as a bright thing photographed badly rather than as a rainbow: it is three
// samples of one exhaust, a hair apart, not three coloured ribbons.
//
// THE SPINE IS NOT A PATH. It used to be — a ring of the seal's recent
// positions, rebuilt every frame, so the ribbon was rigidly welded to where the
// body had been and the only thing it could do at the end of an arc was dim.
// Now every point on it is a PARTICLE: born at the seal with an outward kick,
// pushed by the same divergence-free turbulence field the sprites ride, slowed
// by drag, and carrying its own lifetime. The ribbon is drawn THROUGH them. So
// the trail keeps living after the seal has gone — it billows outward, frays,
// and dies raggedly a particle at a time instead of fading out as one object.
//
// WHY THE FIELD IS THE ONE FROM entities/particles.js. It is divergence-free by
// construction (see the long note there), which means it can only ever swirl
// the particles around — never pile them together or tear them apart. That is
// the whole difference between a plume shearing and a plume shattering. A
// particle cloud driven by independent per-particle noise comes apart into
// confetti; driven by a coherent field, neighbours move like neighbours and the
// ribbon through them stays a ribbon while it billows.
//
// WHY NOT ACTUAL PARTICLES. entities/particles.js is one draw call for every
// particle in the game and it has a hard rule — a burst's colour is its
// emitter's and nobody else's, because a burst's colour is how you know what
// KIND of event it was. Three per-channel palettes fighting that rule is
// exactly the rainbow the rule exists to prevent. It is also a GPU system with
// no per-frame CPU position, and a ribbon has to be threaded through points
// somebody knows the coordinates of.
//
// Geometry is allocated once and rewritten in place — this runs every frame of
// every breach and for a second or two after each one.
// ============================================================================

// ============================================================================
// TWO TRAILS, ONE ALGORITHM — the profiles.
//
// The seal drags a ribbon in the air and a ribbon through the water, and they
// are the same effect photographed under different conditions:
//
//   air    three channels, pure R/G/B, split apart by `channelTrail` and
//          `channelSpread` and summing back to white where they overlap. A
//          blown-out highlight. This is the original, and nothing about it has
//          changed.
//   water  ONE channel, white. Water does not blow a sensor out; there is no
//          aberration to photograph, so the split would be a rainbow drawn on
//          purpose — exactly what CONFIG.emitters' palette rule exists to
//          prevent. What is left is the thing underneath the split: the core
//          and the halo, which is the glowing line.
//
// Everything else — the particle cloud, the turbulence, the centripetal spline,
// the fold guard, the cross-section shader, the fin anchors, the strand
// boundaries, the taper — is shared, because all of it is about how a ribbon
// through a drifting cloud is drawn and none of it is about which medium the
// cloud is in. A profile is a SETTINGS BLOCK, not a second implementation:
// CONFIG.breachTrail.water names only what differs and inherits the rest, so a
// fix to the ribbon is a fix to both and there is no second copy to drift.
//
// THE CHANNEL COUNT IS THEREFORE READ OFF THE COLOURS, not a constant. One
// colour is one ribbon, and the split arithmetic collapses to zero offset on
// its own — `(ch - (n-1)/2)` is 0 when n is 1 — so the white trail needs no
// special case anywhere in the draw loop.
//
// SEPARATE SCENE ROOTS, one per profile, and that is deliberate rather than
// tidy: the two clouds have different lifetimes and different gates, and
// anything asking "what is the breach trail doing" (the harness, perf logging)
// must not be handed a swim trail in the same answer.
// ============================================================================
function makeProfile(key, name) {
  return {
    key,
    name,      // its scene node's name — 'breachTrail' / 'swimTrail'
    plumes: [],
    root: null,
    // Whether the gate was open last frame. Crossing it is what starts a new
    // STRAND (so two bursts are not joined by a stripe across the arena) and
    // what seals the old one.
    wasActive: false,
  };
}

const profiles = {
  air: makeProfile('air', 'breachTrail'),
  water: makeProfile('water', 'swimTrail'),
};
const PROFILE_LIST = [profiles.air, profiles.water];

// The air profile's channel count, and the default for anything that has to
// guess before a colour list is in hand.
const CHANNELS = 3;
// TWO vertices per rib, and the cross-section lives in the FRAGMENT SHADER.
//
// The previous version put it in geometry — three vertices, bright middle,
// dark edges — and that is what made the trail look like cut paper. A vertex
// colour ramp is linear between the vertices you have, so the band had a hard
// triangular profile and, worse, a hard polygon SILHOUETTE where the outer
// vertex stopped. No amount of extra vertices fixes the silhouette; it just
// moves it. One varying that runs -1..1 across the quad and a smooth curve in
// the shader gives a band with no edge at all, at a third of the geometry.
const VERTS_PER_RIB = 2;
// A ceiling on the geometry, whatever the tuner asks for. Emission rate times
// lifetime is what actually decides the count, and both are sliders.
const HARD_MAX_NODES = 400;
// Ribs drawn along the spline, independent of how many PARTICLES there are.
// The spine is resampled to this many points, which is what turns a polyline
// through scattered particles into a curve — see resampleSpine.
const HARD_MAX_SAMPLES = 512;

// ONE PLUME PER TAIL FIN.
//
// The trail used to come out of the seal's origin, which is inside its ribcage
// — so the brightest thing on screen was welded to the middle of the animal and
// the two surfaces actually doing the work were unlit. A breaching seal drives
// with its hind flippers, and those are the tips a wake should shed from
// (systems/bubbles.js already sheds its own off exactly the same two anchors).
//
// Two emission points means two INDEPENDENT clouds, not one cloud fed from two
// places. That distinction is forced: the spine is a polyline through particles
// in birth order, so interleaving two emitters into one list makes every
// consecutive pair jump from one flipper to the other, and the ribbon threaded
// through it is a zigzag between the fins rather than two trails. Each plume
// therefore owns its particles, its geometry and its own strand counter.
//
// ...and one set of plumes PER PROFILE on top of that, so the air trail and the
// water trail are four independent clouds in all. See the profiles above.

// Shared scratch for the resample — one plume is drawn at a time, so these are
// reused rather than duplicated per plume.
let sx = new Float32Array(HARD_MAX_SAMPLES);
let sy = new Float32Array(HARD_MAX_SAMPLES);
let sBright = new Float32Array(HARD_MAX_SAMPLES);
let sWidth = new Float32Array(HARD_MAX_SAMPLES);
let sCum = new Float32Array(HARD_MAX_SAMPLES);
let sCount = 0;
let nodeCum = new Float32Array(64); // arc length along the raw particle polyline

let clock = 0;          // drives the turbulence field's churn

/**
 * One plume: its own particles, its own geometry, its own history.
 *
 * `sealed` and the two fields under it are the RE-ENTRY ERASE. A trail whose
 * seal has gone back under the water is finished being written, and rather than
 * simply waiting out each particle's lifetime it is consumed — a front travels
 * along it, killing particles and throwing sparks off the point where it eats.
 * `sealCount` is the population at the moment of sealing, because the wipe is
 * expressed as a fraction of the trail that existed then; measured against the
 * live count it would chase its own tail and never finish.
 */
function makePlume() {
  return {
    nodes: [],
    group: null,
    ribbons: [],
    capacity: 0,
    emitDebt: 0,
    emitIndex: 0,
    strand: 0,
    lastX: 0,
    lastY: 0,
    sealed: false,
    eraseT: 0,
    sealCount: 0,
    burnDebt: 0,
    // How many PARTICLES this plume may hold — rate x lifetime, and per-plume
    // rather than shared because the two profiles emit at different rates. It
    // was a module-level variable when there was one trail; leaving it there
    // would have let whichever profile updated last set the cap for both, so a
    // slow water trail would silently truncate the breach cloud mid-arc.
    nodeCap: 64,
  };
}

// Scratch, so a frame of trail allocates nothing.
const _side = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();

// The water profile's numbers, rebuilt in place each frame. It is the air block
// with `breachTrail.water` laid over it, so the water trail inherits every knob
// it does not name — which is what makes this two settings blocks rather than
// two effects. Assembled fresh rather than cached because every value in it is
// a live tuner slider, and a cache would freeze the water trail at whatever the
// air one happened to be at load.
const _water = {};

function cfg(key = 'air') {
  const base = CONFIG.breachTrail ?? {};
  if (key !== 'water') return base;
  return Object.assign(_water, base, base.water ?? {});
}

// One colour, one ribbon. The whole difference between the split trail and the
// white one is the length of this list — see the profile note at the top.
function channelCount(c) {
  const n = (c.colors ?? []).length;
  return n > 0 ? n : CHANNELS;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// THE WIND-UP, and it is a TELEGRAPH before it is an effect.
//
// A charging strike is the one moment the player has committed to something the
// water around them has not been told about yet, and the trail is the loudest
// thing they own — so it is what should say it. The longer the hold, the more
// of it: the plume reaches further, swells, and burns brighter, all off the
// same banked power the strike itself is priced on.
//
// A THIRD SETTINGS LAYER, applied over whichever profile is drawing. Not a
// profile of its own: a wind-up in the air and a wind-up underwater are the
// same tell, and the trail it is boosting is already the right one for where
// the seal is. So this multiplies rather than replaces, and the air trail's
// wind-up is still an RGB split while the water one is still white.
//
// It ends by simply stopping. On release `wind` drops to zero and every number
// here goes back to 1 for the NEXT particle — but the long, bright, wide ones
// already laid down keep the life and the ramp stamped on them at birth, so the
// telegraph does not vanish on the release frame. It blooms outward and dies on
// its own clock while the dash is happening, which is the release read.
//
// Written into a copy, never onto CONFIG. `c` for the air profile IS
// CONFIG.breachTrail, and multiplying its `life` in place would ratchet the
// stored value up every frame of every hold until the tuning file was ruined.
const _boosted = { air: {}, water: {} };

function withCharge(c, key, wind) {
  const b = CONFIG.breachTrail?.charge ?? {};
  if (!(wind > 0) || b.enabled === false) return c;
  const o = Object.assign(_boosted[key], c);

  // The two that make it "more trail": more particles a second, each living
  // longer. Rate is what makes it denser, life is what makes it REACH — the
  // cloud's length is its lifetime, not a number of points (see `life` in
  // CONFIG.breachTrail), so this is the one that extends the plume out behind
  // the animal.
  const rateMul = lerp(1, b.rate ?? 1.9, wind);
  const lifeMul = lerp(1, b.life ?? 2.2, wind);
  o.emitPerSecond = (c.emitPerSecond ?? 60) * rateMul;
  o.life = (c.life ?? 1) * lifeMul;

  // BRIGHTNESS HAS TO COME THROUGH `glow` AND NOT THROUGH THE RAMP. The ramp
  // is clamped to 1 where intensity is worked out in resampleSpine, so pushing
  // it harder does nothing at all once a hold is past its first fraction —
  // which would look exactly like the boost not being wired up.
  o.glow = (c.glow ?? 1) * lerp(1, b.glow ?? 1.8, wind);
  o.width = (c.width ?? 1) * lerp(1, b.width ?? 1.3, wind);
  o.blowOut = (c.blowOut ?? 0) * lerp(1, b.blowOut ?? 1.5, wind);

  // THE CEILING HAS TO MOVE WITH THEM, and this is the line the whole effect
  // fails silently without. `wantNodeCap` is rate x life clamped by `maxNodes`,
  // and both multipliers are already at their ceiling on the shipped numbers —
  // so a boost that raised the rate and the life but not the cap would emit
  // every extra particle and immediately pop it off the end of the list. The
  // trail would be no longer, only churnier, and nothing would say why.
  o.maxNodes = Math.min(HARD_MAX_NODES,
    Math.ceil((c.maxNodes ?? 100) * rateMul * lifeMul));

  // `samples` is deliberately NOT boosted. It is the geometry's rib count, and
  // changing it rebuilds the plume — see the rebuild test in runProfile. Charge
  // climbs continuously through a hold, so scaling it here would dispose and
  // reallocate two BufferGeometries every frame the player is winding up.
  return o;
}

// TWO SEPARATE COUNTS, and conflating them is the easy mistake now that the
// ribbon is drawn along a resampled curve rather than straight through the
// particles.
//
//   nodeCap    how many PARTICLES the simulation may hold — rate x lifetime.
//   capacity   how many RIBS the geometry has, i.e. how finely the curve
//              through those particles is sampled. This is what decides
//              smoothness, and it is deliberately much larger.
function wantNodeCap(c) {
  const rate = Math.max(1, c.emitPerSecond ?? 60);
  const life = Math.max(0.05, c.life ?? 1) * (1 + Math.max(0, c.lifeVary ?? 0));
  return Math.max(4, Math.min(c.maxNodes ?? HARD_MAX_NODES, Math.ceil(rate * life) + 4));
}

function wantSamples(c) {
  return Math.max(8, Math.min(HARD_MAX_SAMPLES, Math.round(c.samples ?? 180)));
}

// ---------------------------------------------------------------------------
// THE CROSS-SECTION, in the fragment shader.
//
// `vEdge` runs -1 at one lip of the band to +1 at the other, and everything
// about how the trail READS is this curve. Two terms, because a glowing line
// is two things at once and one falloff cannot be both:
//
//   THE CORE   a tight, near-solid centre. This is the "line" your eye tracks.
//   THE HALO   a wide, soft exponential skirt that never quite reaches an edge.
//              This is what bloom grabs, and what makes the thing look emitted
//              rather than drawn.
//
// A single linear ramp — which is what vertex colours across a 3-vertex rib can
// express — gives neither. It has a visible outer edge (the polygon's) and a
// visible crease down the middle, which is exactly the cut-paper look.
//
// The alpha channel is deliberately 1.0 with everything carried in RGB:
// THREE's AdditiveBlending is (SrcAlpha, One), so writing the profile into rgb
// and leaving alpha alone means the shape is added exactly as computed, with no
// second, invisible multiply hiding in the blend equation.
// ---------------------------------------------------------------------------
const trailVertexShader = /* glsl */ `
  attribute float aEdge;
  attribute vec3 aColor;
  varying float vEdge;
  varying vec3 vColor;
  void main() {
    vEdge = aEdge;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const trailFragmentShader = /* glsl */ `
  uniform float uCore;      // half-width of the solid centre, as a fraction
  uniform float uCoreGain;
  uniform float uHaloGain;
  uniform float uSoft;      // higher = the skirt hugs the core more tightly
  varying float vEdge;
  varying vec3 vColor;

  void main() {
    float d = abs(vEdge);
    // smoothstep rather than a step: the core needs its own soft shoulder, or
    // it reintroduces a hard edge in the middle of a soft band.
    float core = 1.0 - smoothstep(0.0, max(uCore, 0.001), d);
    // Generalised gaussian. At d = 1 this is e^-4, i.e. about 2% — so the band
    // has faded to nothing by the time it reaches the geometry's own edge and
    // the silhouette never shows.
    float halo = exp(-pow(d, uSoft) * 4.0);
    gl_FragColor = vec4(vColor * (core * uCoreGain + halo * uHaloGain), 1.0);
  }
`;

function buildPlume(profile, plume, pts, channels) {
  disposePlume(profile, plume);
  plume.capacity = pts;
  plume.group = new THREE.Group();
  plume.group.frustumCulled = false;

  // One quad per segment now — the cross-section is shaded, not tessellated.
  const indices = [];
  for (let i = 0; i < pts - 1; i++) {
    const a = i * VERTS_PER_RIB;
    const n = a + VERTS_PER_RIB;
    indices.push(a, n, a + 1, a + 1, n, n + 1);
  }

  const edges = new Float32Array(pts * VERTS_PER_RIB);
  for (let i = 0; i < pts; i++) {
    edges[i * VERTS_PER_RIB] = -1;
    edges[i * VERTS_PER_RIB + 1] = 1;
  }

  for (let c = 0; c < channels; c++) {
    const geo = new THREE.BufferGeometry();
    const verts = pts * VERTS_PER_RIB;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    // Constant for the life of the geometry — the band's parameterisation never
    // changes, only where it is and how bright.
    geo.setAttribute('aEdge', new THREE.BufferAttribute(edges.slice(), 1));
    geo.setIndex(indices.slice());
    const mat = new THREE.ShaderMaterial({
      vertexShader: trailVertexShader,
      fragmentShader: trailFragmentShader,
      uniforms: {
        uCore: { value: 0.16 },
        uCoreGain: { value: 1 },
        uHaloGain: { value: 0.6 },
        uSoft: { value: 2.2 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    // One order for all of them: they are the same surface split into channels,
    // and letting the renderer sort them against each other would make which
    // fringe sits on top depend on the camera rather than on the art. Additive
    // blending is commutative, so a fixed order costs nothing.
    mesh.renderOrder = 9;
    plume.group.add(mesh);
    plume.ribbons.push({ mesh, geo });
  }
  profile.root.add(plume.group);
}

function disposePlume(profile, plume) {
  for (const r of plume.ribbons) {
    r.geo.dispose();
    r.mesh.material.dispose();
  }
  plume.ribbons = [];
  if (plume.group) {
    profile?.root?.remove(plume.group);
    plume.group = null;
  }
  plume.capacity = 0;
}

function setVisible(plume, v) {
  if (plume.group) plume.group.visible = v;
}

// ---------------------------------------------------------------------------
// CENTRIPETAL CATMULL-ROM, and the "centripetal" is the whole reason this is
// eleven lines instead of four.
//
// The textbook uniform Catmull-Rom — the one that reads
// `0.5 * (2p1 + (-p0+p2)t + ...)` — assumes the control points are evenly
// spaced. These are anything but: they are particles that have been blown
// apart by turbulence, so neighbours can be a hair apart in one place and a
// world unit apart in the next. Fed uneven points, uniform CR OVERSHOOTS, and
// the overshoot shows up as a cusp — the curve doubles back on itself inside a
// segment. Measured on the shipped cloud that was a 178-degree reversal between
// adjacent drawn segments: a spike of ribbon folded flat against itself, which
// is precisely the hard-edged shape this rewrite exists to remove. Smoothing
// the SHADER would never have fixed it, because the geometry itself was folded.
//
// Centripetal parameterisation (the exponent below is 0.5) is the standard
// result here: it is provably free of cusps and self-intersections within a
// segment, for any arrangement of control points at all. Evaluated with the
// Barry-Goldman recursion, which is the form that takes the knot spacing
// directly rather than assuming it away.
// ---------------------------------------------------------------------------
const ALPHA = 0.5;

function knot(t, ax, ay, bx, by) {
  // Guarded: coincident particles would give a zero-length knot interval and
  // divide the recursion by zero. They happen — two emitted on the same frame
  // from a standing seal are the same point.
  return t + Math.max(1e-4, Math.hypot(bx - ax, by - ay) ** ALPHA);
}

// Returns the curve point between p1 and p2 into the scratch pair below.
const _sp = [0, 0];
function crPoint(p0, p1, p2, p3, t) {
  const t0 = 0;
  const t1 = knot(t0, p0.x, p0.y, p1.x, p1.y);
  const t2 = knot(t1, p1.x, p1.y, p2.x, p2.y);
  const t3 = knot(t2, p2.x, p2.y, p3.x, p3.y);
  const tt = t1 + (t2 - t1) * t;

  const a1 = (t1 - tt) / (t1 - t0);
  const a2 = (tt - t0) / (t1 - t0);
  const b1 = (t2 - tt) / (t2 - t1);
  const b2 = (tt - t1) / (t2 - t1);
  const c1 = (t3 - tt) / (t3 - t2);
  const c2 = (tt - t2) / (t3 - t2);

  const A1x = a1 * p0.x + a2 * p1.x;
  const A1y = a1 * p0.y + a2 * p1.y;
  const A2x = b1 * p1.x + b2 * p2.x;
  const A2y = b1 * p1.y + b2 * p2.y;
  const A3x = c1 * p2.x + c2 * p3.x;
  const A3y = c1 * p2.y + c2 * p3.y;

  const d1 = (t2 - tt) / (t2 - t0);
  const d2 = (tt - t0) / (t2 - t0);
  const e1 = (t3 - tt) / (t3 - t1);
  const e2 = (tt - t1) / (t3 - t1);

  const B1x = d1 * A1x + d2 * A2x;
  const B1y = d1 * A1y + d2 * A2y;
  const B2x = e1 * A2x + e2 * A3x;
  const B2y = e1 * A2y + e2 * A3y;

  _sp[0] = b1 * B1x + b2 * B2x;
  _sp[1] = b1 * B1y + b2 * B2y;
  return _sp;
}

/**
 * Resample the particle cloud into a smooth, evenly-parameterised spine.
 *
 * THIS IS THE OTHER HALF OF "NOT JAGGED". The particles have deliberately blown
 * apart, so the polyline through them zigzags — and a ribbon threaded straight
 * onto that polyline inherits every corner, pinching and flaring where the
 * direction snaps. Worse, the side vector reverses across a sharp corner, which
 * folds the band back over itself into a bowtie. Those bowties are most of what
 * reads as "hard-edged shapes".
 *
 * A Catmull-Rom curve through the same particles has continuous tangents by
 * construction, so the band can't fold; sampling it far more densely than the
 * particles themselves means each drawn segment turns by a tiny angle and the
 * result is a curve rather than a chain of facets.
 *
 * Brightness and width are carried along and interpolated with it, so a
 * particle dying fades its stretch of ribbon rather than deleting a corner
 * from it.
 */
function resampleSpine(plume, c, samples) {
  const nodes = plume.nodes;
  const n = nodes.length;
  const floor = c.minIntensity ?? 0.3;
  const glow = c.glow ?? 3;
  const fade = c.fade ?? 1.35;
  const width = c.width ?? 0.55;
  const growth = c.growth ?? 2;

  sCount = 0;
  if (n < 2) return;

  const segs = n - 1;
  const total = Math.max(2, Math.min(samples, HARD_MAX_SAMPLES));

  // SAMPLED BY ARC LENGTH, not by particle index.
  //
  // Uniform-in-index puts the same number of samples into every gap between
  // two particles, however long or short that gap is — and the gaps are wildly
  // uneven, because the cloud has been pulled apart by turbulence. So the long
  // stretches, which are exactly the ones that need resolution, got the same
  // handful of samples as a pair of particles sitting on top of each other. The
  // result is visible facets on the open stretches while a hundred samples pile
  // up somewhere you cannot see them. Spacing the samples evenly along the
  // polyline instead means every drawn segment is about the same length, so
  // every one of them turns by about the same small angle.
  if (nodeCum.length < n) nodeCum = new Float32Array(n * 2);
  nodeCum[0] = 0;
  for (let j = 1; j < n; j++) {
    nodeCum[j] = nodeCum[j - 1] + Math.hypot(nodes[j].x - nodes[j - 1].x, nodes[j].y - nodes[j - 1].y);
  }
  const span = nodeCum[n - 1];
  let seek = 0;

  for (let s = 0; s < total; s++) {
    let i;
    let t;
    if (span > 1e-6) {
      const want = (s / (total - 1)) * span;
      while (seek < segs - 1 && nodeCum[seek + 1] < want) seek++;
      i = seek;
      const len = nodeCum[i + 1] - nodeCum[i];
      t = len > 1e-6 ? Math.min(1, (want - nodeCum[i]) / len) : 0;
    } else {
      // Every particle in the same place — a standing seal. Fall back to index
      // spacing rather than dividing by a zero span.
      const u = (s / (total - 1)) * segs;
      i = Math.min(segs - 1, Math.floor(u));
      t = u - i;
    }

    const p1 = nodes[i];
    const p2 = nodes[i + 1];
    const p0 = nodes[Math.max(0, i - 1)];
    const p3 = nodes[Math.min(n - 1, i + 2)];

    const pt = crPoint(p0, p1, p2, p3, t);
    sx[s] = pt[0];
    sy[s] = pt[1];

    // Age and birth-ramp lerped across the segment. Linear rather than splined
    // on purpose: overshooting a brightness past 1 or below 0 is a flicker, and
    // Catmull-Rom overshoots by design.
    const a1 = Math.min(1, p1.age / p1.life);
    const a2 = Math.min(1, p2.age / p2.life);
    const a01 = a1 + (a2 - a1) * t;
    const ramp = p1.ramp + (p2.ramp - p1.ramp) * t;

    // A STRAND BREAK blanks its whole neighbourhood. Blanking one sample would
    // leave the quads either side of it lit at one end, which draws as a
    // gradient stretching across the gap between two arcs — a bright stripe
    // across the arena on every second jump.
    const broken = p1.strand !== p2.strand;
    const intensity = floor + (1 - floor) * Math.min(1, ramp);
    sBright[s] = broken ? 0 : glow * intensity * (1 - a01) ** fade;
    sWidth[s] = width * 0.5 * (1 + growth * a01);
  }

  // --- THE FOLD GUARD -------------------------------------------------------
  // A band of half-width w drawn along a curve of radius R turns itself inside
  // out on the inner side as soon as w > R. The lip crosses the spine, the quad
  // flips, and with additive blending that shows up as a bright hard-edged
  // wedge — one of the worst-looking artefacts this effect can produce, and one
  // that a smoother spine does not fix, because the spine is fine and it is the
  // OFFSET of the spine that folds.
  //
  // It is not a corner case here: the band grows to several times its birth
  // width as a particle ages, while the turbulence is busy folding the curve
  // into radii far tighter than that. So the width is clamped against the local
  // radius of curvature, measured as the circumradius of each three consecutive
  // samples. Where the curve is straight the radius is enormous and this does
  // nothing at all; where it kinks, the band pinches instead of inverting —
  // which reads as a plume narrowing through a tight turn, i.e. as the right
  // thing.
  const safety = c.foldSafety ?? 0.85;
  for (let s = 1; s < total - 1; s++) {
    const ax = sx[s - 1];
    const ay = sy[s - 1];
    const bx = sx[s];
    const by = sy[s];
    const cx2 = sx[s + 1];
    const cy2 = sy[s + 1];
    const la = Math.hypot(bx - ax, by - ay);
    const lb = Math.hypot(cx2 - bx, cy2 - by);
    const lc = Math.hypot(cx2 - ax, cy2 - ay);
    // Twice the triangle's area, via the cross product. Zero for three
    // collinear samples, which is a straight line and an infinite radius.
    const cross = Math.abs((bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax));
    if (cross < 1e-9) continue;
    const radius = (la * lb * lc) / (2 * cross);
    const cap = radius * safety;
    if (sWidth[s] > cap) sWidth[s] = cap;
  }
  // The ends have no three-sample neighbourhood of their own; borrow their
  // neighbour's, or a clamped interior next to an unclamped end would put the
  // fold back exactly where it was removed.
  if (total > 2) {
    sWidth[0] = Math.min(sWidth[0], sWidth[1]);
    sWidth[total - 1] = Math.min(sWidth[total - 1], sWidth[total - 2]);
  }

  // ...AND THEN SMOOTH IT, which is not optional.
  //
  // The curvature above is estimated from three consecutive samples, and that
  // estimate is noisy — a hair of jitter in the positions swings the computed
  // radius a long way. Applied raw, the clamp therefore pinches one sample and
  // not its neighbour, and the band's outline SCALLOPS: a row of little
  // perpendicular spikes down the trail, each one a rib sticking out past the
  // two either side of it. Worse, every pinch narrows the band to less than the
  // channel offset, so the three colours pull apart exactly there — which is
  // why the artefact showed up as a COMB OF RAINBOW SPIKES rather than as a
  // width wobble, and why it was so easy to misread as a problem with the
  // split.
  //
  // Three box passes. The clamp only ever lowers width, and smoothing can only
  // raise a pinched sample back toward its neighbours, so `safety` is set below
  // 1 to leave room for exactly that.
  for (let pass = 0; pass < 3; pass++) {
    let prev = sWidth[0];
    for (let s = 1; s < total - 1; s++) {
      const cur = sWidth[s];
      sWidth[s] = (prev + cur + sWidth[s + 1]) / 3;
      prev = cur;
    }
  }

  // BRIGHTNESS GETS THE SAME TREATMENT, and for a reason the width's note does
  // not cover. Age is interpolated LINEARLY between particles while position
  // follows a spline, so the brightness curve is only C0 — it has a slope
  // change at every particle. Under additive blending a slope change in a
  // bright value reads as a faint line across the band, so the particles print
  // themselves onto the ribbon as evenly spaced ticks. Two passes is enough to
  // put the corner below the noise floor without flattening the fade.
  for (let pass = 0; pass < 2; pass++) {
    let prev = sBright[0];
    for (let s = 1; s < total - 1; s++) {
      const cur = sBright[s];
      // A strand break is a deliberate hard zero and must survive smoothing, or
      // the blanking bleeds back open and the two arcs reconnect.
      if (cur === 0 || prev === 0 || sBright[s + 1] === 0) { prev = cur; continue; }
      sBright[s] = (prev + cur + sBright[s + 1]) / 3;
      prev = cur;
    }
  }

  // --- SMOOTH THE DRAWN CURVE ------------------------------------------------
  // Applied to the resampled curve, NOT to the particles: the simulation keeps
  // every bit of its billow, this only takes the highest frequencies out of the
  // line drawn through it.
  //
  // WHAT IT FIXES: a row of bright perpendicular ticks running the whole length
  // of the band, plainly visible at any close crop and the single ugliest thing
  // left in the effect.
  //
  // They were isolated by elimination rather than reasoned out, and the first
  // reasoned answer was wrong — worth recording, because the wrong one is the
  // more plausible story. Switching the blow-out off removed every tick, which
  // said the cause was the spine's high-frequency lateral wiggle. The obvious
  // culprit was then the ALONG-PATH offset: it makes each channel read the
  // curve at a different distance, so on a wiggly curve the three sample
  // different phases and their cores cross, and a crossing draws as a tick.
  // But a panel with the along-path offset removed entirely still ticked. The
  // wiggle alone is enough — the band's own outline follows it, and under
  // additive blending that reads as hatching whatever the split is doing.
  //
  // So the fix is upstream of the split: take the top end of the frequency
  // range out of the drawn line and every version of the artefact goes with it.
  // Three passes is where the ticks stop being visible while the cloud still
  // billows; eight is smoother and starts costing the plume its texture.
  const curveSmooth = Math.max(0, Math.round(c.curveSmooth ?? 0));
  for (let pass = 0; pass < curveSmooth; pass++) {
    let px0 = sx[0];
    let py0 = sy[0];
    for (let s = 1; s < total - 1; s++) {
      const cxs = sx[s];
      const cys = sy[s];
      sx[s] = (px0 + cxs + sx[s + 1]) / 3;
      sy[s] = (py0 + cys + sy[s + 1]) / 3;
      px0 = cxs;
      py0 = cys;
    }
  }

  // Arc length along the RESAMPLED curve, which is what the channel offset is
  // measured in. Taken here rather than on the raw particles because this is
  // the curve actually drawn, and the two differ by however much the spline
  // rounds off the corners.
  sCum[0] = 0;
  for (let s = 1; s < total; s++) {
    sCum[s] = sCum[s - 1] + Math.hypot(sx[s] - sx[s - 1], sy[s] - sy[s - 1]);
  }
  // --- THE TWO ENDS ---------------------------------------------------------
  // Both ends of the band are cut square otherwise, and a glowing line that
  // stops dead reads as a clipped sprite rather than as something emitted. The
  // HEAD is the newest particle, sitting at the fin; the TAIL is the oldest.
  // Tapering the width (not the brightness — the head is the brightest part and
  // should stay so) brings each end to a point.
  //
  // The head taper opens up once the arc is SEALED, which is the "taper the end"
  // half of re-entry: while the seal is flying, the head is being written and
  // wants only enough of a point to look emitted; once it has gone under, the
  // stub left hanging in the air is the thing being looked at, and it should
  // close properly.
  const span2 = Math.max(1e-6, sCum[total - 1]);
  const headT = Math.max(0, (c.headTaper ?? 0.05)) * (plume.sealed ? (c.sealTaperMul ?? 4) : 1);
  const tailT = Math.max(0, c.tailTaper ?? 0.12);
  if (headT > 0 || tailT > 0) {
    for (let s = 0; s < total; s++) {
      const fh = sCum[s] / span2;
      const ft = 1 - fh;
      let m = 1;
      if (headT > 0) m *= smoothstep(fh / headT);
      if (tailT > 0) m *= smoothstep(ft / tailT);
      sWidth[s] *= m;
    }
  }

  sCount = total;
}

// ---------------------------------------------------------------------------
// COHERENT 1D NOISE, in the emission counter. Smooth, cheap, deterministic,
// roughly -1..1. Three incommensurate sines, so it never visibly repeats.
//
// EVERYTHING PER-PARTICLE THAT VARIES HAS TO COME THROUGH HERE, and that is the
// hard-won lesson of this file. The first version used Math.random() per
// particle for the outward kick's sign and for the lifetime, which sounds like
// the obvious way to make a cloud look natural and is catastrophic for a RIBBON
// threaded through it: independent randomness means particle N goes left and
// particle N+1 goes right, so the spine is a SAWTOOTH. A spline through a
// sawtooth is a faithful, beautifully smooth sawtooth — the jaggedness was
// never in the interpolation, it was in the data. Random lifetimes did the same
// thing to the band's width, making it lumpy along its length.
//
// Sampled in the emission counter, neighbours get near-identical values and the
// ribbon undulates in long lobes instead. That is what makes it read as flowing
// paint rather than as a zigzag.
// ---------------------------------------------------------------------------
function smoothstep(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

function wave(u) {
  return Math.sin(u) * 0.6
    + Math.sin(u * 0.37 + 1.7) * 0.3
    + Math.sin(u * 0.19 + 4.1) * 0.1;
}

/**
 * Lay down one particle at (x, y).
 *
 * The outward kick is along the local NORMAL, signed and scaled by the wave
 * above rather than by a coin flip — so a run of particles peels off to one
 * side together, holds, and then swings back. Neighbours stay neighbours, which
 * is the only way a ribbon drawn through them can stay a ribbon.
 */
function emitNode(plume, x, y, dirX, dirY, vx, vy, ramp, c, age0 = 0) {
  const u = plume.emitIndex * (c.blowWave ?? 0.12);
  plume.emitIndex++;

  const kick = (c.blowOut ?? 0) * wave(u);
  // Normal to travel, in 2D: rotate the tangent a quarter turn.
  const nx = -dirY;
  const ny = dirX;
  const inherit = c.inherit ?? 0;

  const node = {
    x,
    y,
    vx: nx * kick + vx * inherit,
    vy: ny * kick + vy * inherit,
    // BORN PART-WAY THROUGH THE FRAME, not all at zero.
    //
    // Emission is batched — at the shipped rate the frame owes 1.58 particles,
    // so batches alternate 1, 2, 1, 2 — and every member of a batch used to be
    // born with age exactly 0. Age against distance was therefore an uneven
    // STAIRCASE, and since both the band's width and its brightness are derived
    // from age, every tread showed up as a crease across the ribbon: a row of
    // regular perpendicular ticks down the whole trail, which at a tight crop is
    // the most obvious thing on screen. Spreading the batch's ages the same way
    // its positions are spread makes age a smooth function of arc length again,
    // which is what it always claimed to be.
    age: age0,
    // Varied so the tail frays and dies a bit at a time rather than all on one
    // frame — but varied SMOOTHLY, on its own phase of the same wave. Random
    // lifetimes would make the band's width and brightness jitter from one
    // particle to the next, which is the same lumpiness the kick used to cause,
    // just in a different channel.
    life: Math.max(0.05, (c.life ?? 1)
      * (1 - (c.lifeVary ?? 0) * (0.5 + 0.5 * wave(u * 0.7 + 11)))),
    ramp,
    strand: plume.strand,
  };
  plume.nodes.unshift(node);
  while (plume.nodes.length > plume.nodeCap) plume.nodes.pop();
}

/**
 * Integrate every particle and drop the dead ones.
 *
 * Runs whatever the seal is doing — that is the point of the rewrite. The trail
 * belongs to the air it was left in, not to the animal that left it, so it goes
 * on billowing and dying after re-entry, through the game-over screen, and
 * while the seal is already climbing for its next jump.
 */
function driftNodes(plume, dt, c) {
  const nodes = plume.nodes;
  const drag = Math.exp(-Math.max(0, c.drag ?? 1) * dt);
  const turb = c.turbulence ?? 0;
  const freq = c.turbFreq ?? 0.4;
  const t = clock * (c.turbSpeed ?? 1);

  let write = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.age += dt;
    if (n.age >= n.life) continue; // dead — simply not copied forward

    if (turb > 0) {
      // An ACCELERATION, not a displacement. The old implementation added the
      // field straight onto each vertex's position, which meant the ribbon
      // snapped back the instant the field moved on and nothing accumulated.
      // Pushed into the velocity instead, a particle keeps whatever the field
      // gave it and drag is what eventually takes it away — so the cloud has
      // momentum and history rather than wobbling in place.
      const [tx, ty] = turbulenceAt(n.x * freq, n.y * freq, t);
      n.vx += tx * turb * dt;
      n.vy += ty * turb * dt;
    }

    n.vx *= drag;
    n.vy *= drag;
    n.x += n.vx * dt;
    n.y += n.vy * dt;

    nodes[write++] = n;
  }
  nodes.length = write;
}

/**
 * THE RE-ENTRY ERASE — the trail eating itself once the seal has gone under.
 *
 * Left alone, a sealed trail just waits out each particle's lifetime and thins
 * quietly, which is a fine thing for a cloud to do and a weak ending for the
 * loudest move in the game. Instead a FRONT travels along it, killing particles
 * as it passes and throwing a burst off the point where it eats — so the trail
 * is consumed rather than merely fading, and the consumption is a visible event
 * with a position.
 *
 * The direction is a real choice, not a detail:
 *
 *   'tail'  the front starts at the OLDEST end and runs forward toward the
 *           water. The trail is drawn in after the seal, like something being
 *           inhaled — the burst chases the splash-down and arrives with it.
 *   'head'  the front starts where the seal went in and runs BACKWARD. The
 *           trail retreats from the water, which reads as the arc being undone.
 *
 * The wipe is measured against `sealCount`, the population when the arc closed.
 * Measured against the LIVE count it would be chasing a number it is itself
 * reducing, and would asymptote instead of finishing.
 */
function eraseNodes(plume, dt, c) {
  const e = c.erase ?? {};
  if (!plume.sealed || e.enabled === false) return;

  plume.eraseT += dt / Math.max(0.05, e.time ?? 0.5);
  const keep = Math.max(0, Math.ceil(plume.sealCount * (1 - Math.min(1, plume.eraseT))));
  const nodes = plume.nodes;
  if (nodes.length <= keep) return;

  const fromHead = (e.from ?? 'tail') === 'head';
  // Where the front is right now — the particle about to be eaten. Read BEFORE
  // the cull, or the burst fires from wherever the survivor happens to be.
  const front = fromHead ? nodes[0] : nodes[nodes.length - 1];
  const burned = nodes.length - keep;

  if (fromHead) nodes.splice(0, burned);
  else nodes.length = keep;

  // THE SPARKS. Rate-limited rather than one burst per particle eaten: the wipe
  // can consume dozens in a frame on a long trail, and forty simultaneous
  // bursts at forty adjacent points is not forty times as good as one, it is a
  // solid wall of white that costs the whole particle budget.
  if (!front || !e.burst) return;
  plume.burnDebt += (e.burstPerSecond ?? 0) * dt;
  const n = Math.floor(plume.burnDebt);
  if (n <= 0) return;
  plume.burnDebt -= n;
  for (let i = 0; i < Math.min(n, 4); i++) {
    emit(e.burst, front.x, front.y, {
      // Thrown along whatever the particle was already doing, so the sparks
      // leave the trail rather than appearing beside it.
      vx: front.vx,
      vy: front.vy,
      scale: e.burstScale ?? 1,
    });
  }
}

/**
 * Rebuild both trails for this frame.
 *
 * @param dt      real seconds — the cloud is weather, and a hit-stop must not
 *                stall it mid-billow.
 * @param scene
 * @param player  read for position, velocity and height only
 * @param ramp    the live air ramp (systems/airborne.js) — stamped onto each
 *                particle at birth, which is what makes a long hang leave a
 *                visibly hotter trail than a skim. The AIR trail's; the water
 *                trail stamps its own speed ramp, see below.
 * @param emitting whether the seal is actually swimming or flying right now, as
 *                opposed to merely being somewhere. Drifting and dying happen
 *                regardless — that is the point of running outside the pause
 *                gate — but laying down new particles must not. A seal frozen
 *                mid-arc behind the level-up cards is not moving, so eighty-five
 *                particles a second would all be born at the same coordinates
 *                and stack into one bright blob; the same goes for a corpse on
 *                its way down through the death dive.
 * @param charge  banked strike power, 0..1, or 0 when no strike is being wound
 *                up. THE TELEGRAPH — see withCharge. Defaulted, so every caller
 *                that predates it (the harnesses, tools/looks) behaves as it did.
 */
export function updateBreachTrail(dt, scene, player, ramp = 0, emitting = true, charge = 0) {
  const base = CONFIG.breachTrail ?? {};
  if (!base.enabled) {
    if (profiles.air.root || profiles.water.root) clearBreachTrail(scene);
    return;
  }

  clock += dt;

  // Measured off the POSITION rather than read off `player.aboveSurface`, and
  // that is not a stylistic preference: the flag is written by updatePlayer,
  // and updatePlayer stops running the moment the seal dies. A run that ended
  // mid-breach would leave the flag stuck true, and this function — which
  // deliberately runs outside the pause and run gates so the cloud can finish
  // dying — would keep emitting from a body that is now sinking through the
  // death dive. The position cannot lie about where the seal is.
  const airborne = player.mesh.position.y > bounds.surfaceY;
  const vx = player.velocity?.x ?? 0;
  const vy = player.velocity?.y ?? 0;
  const speed = Math.hypot(vx, vy);

  // Shared scratch, and both profiles read it in this frame before anything can
  // change it — so it is fetched once rather than per profile.
  const tips = tipsFor(player);

  // The wind-up, 0..1. See withCharge for what it does to a profile.
  const boost = base.charge ?? {};
  const wind = boost.enabled === false ? 0 : Math.min(1, Math.max(0, charge || 0));
  // What the hold asserts as a floor under the drive, independent of speed —
  // see the water gate below for why a wind-up needs one at all.
  const windDrive = wind * (boost.rampFloor ?? 1);

  // --- THE AIR TRAIL ---------------------------------------------------------
  // Exactly as it was: it exists for as long as the seal is above the line, at
  // a flat rate, carrying the air ramp — plus the wind-up on top, because a
  // strike charged mid-arc is the same tell as one charged in the water.
  runProfile(profiles.air, dt, scene, tips, withCharge(cfg('air'), 'air', wind), {
    active: airborne,
    emitting,
    rate: 1,
    nodeRamp: Math.max(ramp, windDrive),
    vx,
    vy,
  });

  // --- THE WATER TRAIL -------------------------------------------------------
  // SPEED-GATED AND RAMPED, exactly the way the tail-fin bubble wake is
  // (systems/bubbles.js) and for the same reason: below `minSpeed` the flippers
  // are not working hard enough to leave anything, and switching on at full
  // strength at the threshold would pop rather than fade.
  //
  // The ramp does two jobs at once. It scales the EMISSION RATE, so a faster
  // seal lays a denser cloud; and it is stamped on each particle in place of
  // the air ramp, so it also scales BRIGHTNESS through the same `intensity`
  // term the air trail uses for hang time. One number, and the trail gets
  // thicker and hotter together the way a wake does.
  const w = cfg('water');
  const minSpeed = Math.max(0, w.minSpeed ?? 8);
  const full = Math.max(minSpeed + 0.01, w.fullSpeed ?? CONFIG.player?.maxSpeed ?? 34);
  const wRamp = Math.min(1, Math.max(0, (speed - minSpeed) / (full - minSpeed)));

  // THE WIND-UP HAS TO OPEN THE GATE, and this is the whole reason the boost is
  // not simply a multiplier on what was already being drawn.
  //
  // A strike wind-up is a BRAKE TO A STANDSTILL — holding seals the mouth, so
  // you stop and commit — which is precisely the state this gate exists to shut.
  // Left speed-gated, the telegraph would be silent for every wind-up taken the
  // way wind-ups are actually taken, and would only ever show on the rare one
  // charged mid-swim. systems/bubbles.js has the identical problem with the
  // identical answer: see the vent there, which gives the charge its own path
  // for exactly this reason rather than scaling the wake.
  //
  // So the charge SUBSTITUTES for speed. It opens the gate, and it drives the
  // trail at whatever a hold of that depth is worth — a seal that has stopped
  // dead and banked a full charge draws the same intensity as one at top speed,
  // which is the right claim to make about it.
  const openedByWind = windDrive > 0 && (boost.openGate ?? true);
  const drive = Math.max(wRamp, openedByWind ? windDrive : 0);
  runProfile(profiles.water, dt, scene, tips, withCharge(w, 'water', wind), {
    // NOT `!airborne` alone. A seal drifting to a stop underwater has to close
    // its strand, or the next burst of speed is joined to this one by a ribbon
    // drawn straight across everything in between.
    active: w.enabled !== false && !airborne && (speed >= minSpeed || openedByWind),
    emitting,
    rate: drive,
    nodeRamp: drive,
    vx,
    vy,
  });
}

/**
 * One profile's frame: its plumes, its gate, its cloud, its ribbons.
 *
 * @param profile one of `profiles` — owns the scene root and the plume list
 * @param c       that profile's resolved settings (see cfg)
 * @param o       { active, emitting, rate, nodeRamp, vx, vy }
 *                active   is the gate open — airborne for the air trail, fast
 *                         enough and submerged for the water one. Crossing it
 *                         in either direction is a strand boundary.
 *                rate     multiplier on `emitPerSecond`, 0..1. The air trail
 *                         passes 1; the water trail passes its speed ramp.
 *                nodeRamp what gets stamped on each particle as its intensity.
 */
function runProfile(profile, dt, scene, tips, c, o) {
  if (!profile.root) {
    profile.root = new THREE.Group();
    profile.root.name = profile.name;
    profile.root.frustumCulled = false;
    scene.add(profile.root);
  }

  const plumes = profile.plumes;
  const nodeCap = wantNodeCap(c);
  const want = wantSamples(c);
  const channels = channelCount(c);
  const { active, vx, vy } = o;

  // One plume per tip, created and torn down to match. The count only changes
  // when the seal's rig does — a model swap in the workbench, or the very first
  // frame before the rig has posed itself.
  while (plumes.length < tips.length) plumes.push(makePlume());
  while (plumes.length > tips.length) disposePlume(profile, plumes.pop());

  for (let i = 0; i < plumes.length; i++) {
    const plume = plumes[i];
    const tip = tips[i];
    const px = tip.x;
    const py = tip.y;
    plume.nodeCap = nodeCap;

    // Rebuilt when the sample count changes and ALSO when the channel count
    // does — dragging the colour list from three entries to one has to throw
    // away the two ribbons that no longer have a colour, or they keep drawing
    // whatever they held last frame forever.
    if (!plume.group || plume.capacity !== want || plume.ribbons.length !== channels) {
      buildPlume(profile, plume, want, channels);
    }

    // A NEW breach starts a new STRAND rather than clearing the cloud. Clearing
    // was right when the spine was a path and the old one was worthless the
    // moment it stopped being drawn; now the previous arc's particles are still
    // alive and still worth looking at, and deleting them would make a second
    // jump erase the first one's plume in front of the player. The strand id is
    // what stops the ribbon connecting the two — see the boundary blanking in
    // resampleSpine, which is what would otherwise be a bright stripe straight
    // across the arena.
    if (active && !profile.wasActive) {
      plume.strand++;
      plume.emitDebt = 0;
      plume.lastX = px;
      plume.lastY = py;
      // A fresh arc cancels the previous one's wipe. Without this a second jump
      // taken while the first trail is still being eaten inherits its progress
      // and the new trail is consumed the instant it is drawn.
      plume.sealed = false;
      plume.eraseT = 0;
      plume.burnDebt = 0;
    }
    // ...and the gate closing seals it, which is what starts the erase. For the
    // air trail that is re-entry; for the water trail it is the seal slowing
    // below `minSpeed` or leaving the water. The water profile turns the erase
    // itself off (see CONFIG.breachTrail.water) — a wipe with sparks every time
    // you ease off the stick would be an event announcing nothing — so all this
    // does there is open the head taper and let the cloud die on its own.
    if (!active && profile.wasActive) {
      plume.sealed = true;
      plume.eraseT = 0;
      plume.sealCount = plume.nodes.length;
      plume.burnDebt = 0;
    }

    // Particles drift and die whatever the seal is doing.
    driftNodes(plume, dt, c);
    eraseNodes(plume, dt, c);

    if (active && o.emitting) {
      const rate = Math.max(0, c.emitPerSecond ?? 60) * Math.max(0, o.rate ?? 1);
      plume.emitDebt += rate * dt;
      let n = Math.floor(plume.emitDebt);
      if (n > 0) {
        plume.emitDebt -= n;
        // One long frame shouldn't dump a whole second of plume in one place.
        n = Math.min(n, 12);
        let tx = px - plume.lastX;
        let ty = py - plume.lastY;
        const len = Math.hypot(tx, ty);
        if (len < 1e-6) {
          // Standing still — fall back to the velocity, then to +Y. A zero
          // tangent would make the outward normal zero too, and the whole burst
          // would be laid down with no kick at all.
          const vlen = Math.hypot(vx, vy);
          if (vlen > 1e-6) { tx = vx / vlen; ty = vy / vlen; } else { tx = 0; ty = 1; }
        } else {
          tx /= len;
          ty /= len;
        }
        // Spread the batch back along the segment just travelled rather than
        // stacking it at the current position. At dash speed the seal covers
        // most of a world unit per frame, and particles born in clumps of four
        // read as a dotted line rather than as a plume.
        //
        // REARMOST FIRST, and the order is not cosmetic. `emitNode` unshifts, so
        // the LAST one emitted ends up at nodes[0] — the head of the spine. Emit
        // front-to-back and the head of the spine is the rearmost particle of the
        // batch while nodes[1] is the foremost, which reverses the polyline by
        // nearly 180 degrees at the head. At the shipped rate roughly two frames
        // in five emit more than one particle, so two spine reversals in five
        // frames, every frame of every breach: this was the single largest source
        // of the hard-edged kinks, and no amount of spline smoothing could help
        // because the interpolation was faithfully following data that doubled
        // back on itself.
        for (let k = 0; k < n; k++) {
          const t = n > 1 ? (n - 1 - k) / n : 0;
          emitNode(
            plume,
            plume.lastX + (px - plume.lastX) * (1 - t),
            plume.lastY + (py - plume.lastY) * (1 - t),
            tx, ty, vx, vy, o.nodeRamp ?? 0, c,
            // The rearmost of the batch was laid down earliest in the frame, so
            // it is the oldest — by the same fraction of dt that it sits back
            // along the segment. See the note on `age` in emitNode.
            t * dt,
          );
        }
      }
    }

    // Outside the emit gate, so a pause can't leave this stale. The seal keeps
    // moving behind a menu that only froze the SIMULATION (and a corpse keeps
    // falling), and a `last` position left at wherever emission stopped would
    // make the first batch afterwards spread itself across the whole gap as one
    // long streak.
    if (active) {
      plume.lastX = px;
      plume.lastY = py;
    }

    drawPlume(plume, c);
  }

  profile.wasActive = active;
}

/**
 * WHERE THE TRAIL COMES OUT OF: the hind flipper tips, which on a seal are the
 * tail fins and the surfaces actually driving the breach.
 *
 * `anchors.finL/finR` are published by systems/aimRig.js from the outermost
 * skinned vertex of each hind flipper, just past the trailing edge of the
 * webbing — the same two points systems/bubbles.js sheds its wake from, so the
 * two effects agree about where the animal ends.
 *
 * Degrades in the order fins -> the tail anchor -> the body origin, so a model
 * with no rig at all (and any caller passing a hand-built player, which the
 * harness does) still gets a single plume rather than nothing.
 */
const _tips = [];
function tipsFor(player) {
  _tips.length = 0;
  const rig = player.aimRig;
  if (rig?.anchors?.finL) _tips.push(rig.anchors.finL);
  if (rig?.anchors?.finR) _tips.push(rig.anchors.finR);
  if (!_tips.length && rig?.anchors?.tail) _tips.push(rig.anchors.tail);
  if (!_tips.length) _tips.push(player.mesh.position);
  return _tips;
}

/**
 * Resample one plume's cloud into a curve and write its ribbons — three of
 * them for the air profile, one for the water profile. The channel arithmetic
 * below is written against `channels` rather than a constant, and at one
 * channel every term of the split evaluates to zero on its own: the offset is
 * `(0 - 0) * spread`, so a single white ribbon is drawn straight down the spine
 * with no branch anywhere saying so.
 */
function drawPlume(plume, c) {
  if (plume.nodes.length < 2) {
    setVisible(plume, false);
    return;
  }

  // The cloud becomes a CURVE here, and everything below draws that curve
  // rather than the particles.
  resampleSpine(plume, c, Math.round(c.samples ?? 180));
  if (sCount < 2) {
    setVisible(plume, false);
    return;
  }
  setVisible(plume, true);
  plume.group.position.z = c.z ?? -0.06;

  const width = c.width ?? 0.55;
  // Both offsets are fractions of the band's WIDTH, which is what keeps the
  // split a fringe: an offset smaller than the band is wide lands inside it and
  // colours its edges, and one larger than the band slides the channels off
  // each other entirely.
  const trail = (c.channelTrail ?? 0) * width;
  const spread = (c.channelSpread ?? 0) * width;
  const colors = c.colors ?? [0xff0000, 0x00ff00, 0x0000ff];
  const channels = plume.ribbons.length;

  for (let ch = 0; ch < channels; ch++) {
    const r = plume.ribbons[ch];
    const pos = r.geo.attributes.position;
    const col = r.geo.attributes.aColor;
    const u = r.mesh.material.uniforms;
    // Live, so dragging the profile sliders reshapes a trail already in the
    // air rather than only the next one.
    u.uCore.value = c.coreWidth ?? 0.16;
    u.uCoreGain.value = c.coreGain ?? 1;
    u.uHaloGain.value = c.haloGain ?? 0.6;
    u.uSoft.value = c.softness ?? 2.2;

    _col.set(colors[ch] ?? 0xffffff);
    // Middle channel sits on the spine; the outer two straddle it, sideways and
    // along it. Along-path alone splits the trail only where it CURVES, so a
    // straight launch would come out white — the sideways term is what keeps a
    // fringe on the straights too.
    const offset = (ch - (channels - 1) / 2) * spread;
    const back = (ch - (channels - 1) / 2) * trail;
    // Marching read head. Target distances are monotonic in `i`, so this walks
    // forward once per channel rather than searching.
    let k = 0;

    for (let i = 0; i < plume.capacity; i++) {
      // Past the resampled count, park the surplus ribs on the last sample.
      // They draw nothing (brightness is zeroed below), but they must not be
      // left holding last frame's coordinates.
      const idx = Math.min(i, sCount - 1);

      // THE SPLIT FADES OUT AT BOTH ENDS OF THE CURVE, and this is not a
      // nicety — it is the fix for a specific artefact.
      //
      // The along-path offset reads the curve at `cum + back`. Within `back` of
      // either end that lands off the curve, so it used to be CLAMPED — and a
      // clamp means every sample in that stretch reads the same point. One
      // channel therefore piled all its head samples onto the tip while the
      // other two fanned out normally, and the ribs between them splayed into a
      // comb of coloured hairs at the head of every trail. Fading the offset to
      // zero instead means the three channels simply converge as they approach
      // the tip, which is both artefact-free and the right look: the split
      // closes up where the trail is youngest.
      const endRoom = Math.max(1e-4, Math.abs(trail));
      const fromHead = sCum[idx];
      const fromTail = sCum[sCount - 1] - sCum[idx];
      const endFade = Math.max(0, Math.min(1, fromHead / endRoom, fromTail / endRoom));
      const targetD = Math.max(0, Math.min(sCum[sCount - 1], sCum[idx] + back * endFade));
      while (k < sCount - 2 && sCum[k + 1] < targetD) k++;
      const seg = sCum[k + 1] - sCum[k];
      const t = seg > 1e-6 ? Math.max(0, Math.min(1, (targetD - sCum[k]) / seg)) : 0;
      const cx0 = sx[k] + (sx[k + 1] - sx[k]) * t;
      const cy0 = sy[k] + (sy[k + 1] - sy[k]) * t;

      // Tangent straight off the resampled curve. No smoothing needed any more
      // and none applied: Catmull-Rom is already tangent-continuous, so the
      // side vector turns gradually instead of snapping, which is what stops
      // the band folding back on itself into a bowtie.
      const a = Math.max(0, idx - 1);
      const b = Math.min(sCount - 1, idx + 1);
      _dir.set(sx[b] - sx[a], sy[b] - sy[a], 0);
      if (_dir.lengthSq() < 1e-12) _dir.set(1, 0, 0);
      _dir.normalize();
      _side.crossVectors(_dir, _up).normalize();

      // THE SPLIT IS SCALED BY HOW WIDE THE BAND ACTUALLY IS HERE.
      //
      // The offsets are authored as a fraction of the band's FULL width, but the
      // band is only that wide once a particle has aged into it — at the head it
      // is a fraction of that, and at a fold-guard pinch it is narrower still.
      // Applied flat, the offset then exceeds the local half-width and the three
      // channels come apart into separate coloured slivers exactly where the
      // ribbon is thinnest: a row of little rainbow spikes at the head of every
      // trail. Scaling with the local width keeps the fringe a fringe all the
      // way along, and fades the split out to nothing at the tip rather than
      // fraying it.
      const w = sWidth[idx];
      const grip = Math.min(1, w / Math.max(1e-4, width * 0.5)) * endFade;
      const cx = cx0 + _side.x * offset * grip;
      const cy = cy0 + _side.y * offset * grip;

      // TWO vertices. The band between them is shaded, not tessellated — see
      // the fragment shader at the top of the file for why that is the whole
      // difference between a glowing line and a strip of cut paper.
      const v = i * VERTS_PER_RIB;
      pos.setXYZ(v, cx + _side.x * w, cy + _side.y * w, 0);
      pos.setXYZ(v + 1, cx - _side.x * w, cy - _side.y * w, 0);

      const bright = i >= sCount ? 0 : sBright[idx];
      col.setXYZ(v, _col.r * bright, _col.g * bright, _col.b * bright);
      col.setXYZ(v + 1, _col.r * bright, _col.g * bright, _col.b * bright);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}

/** Tear both trails down — run start, and whenever the effect is switched off. */
export function clearBreachTrail(scene) {
  for (const profile of PROFILE_LIST) {
    for (const p of profile.plumes) disposePlume(profile, p);
    profile.plumes.length = 0;
    if (profile.root) {
      scene.remove(profile.root);
      profile.root = null;
    }
    profile.wasActive = false;
  }
  clock = 0;
}

// THE READOUTS BELOW DEFAULT TO THE AIR TRAIL, and that is the contract rather
// than a convenience. Everything that asks these questions — the harness, perf
// logging — is asking about the breach, and folding a swim trail into the same
// number would make "the cloud is gone" quietly mean "the cloud is gone unless
// the seal happens to be moving". Pass 'water' to ask about the other one.
function plumesOf(key) {
  return (profiles[key] ?? profiles.air).plumes;
}

/** How many particles are alive. For the harness, and for perf logging. */
export function breachTrailCount(key = 'air') {
  let n = 0;
  for (const p of plumesOf(key)) n += p.nodes.length;
  return n;
}

/**
 * Every live particle's position, newest first, as flat [x, y] pairs.
 *
 * For the harness only. It exists because the drawn geometry is NO LONGER the
 * particles — it is a Catmull-Rom curve resampled far more densely than they
 * are — so reading vertex positions to find out where the cloud is measures the
 * spline's opinion rather than the simulation's. Anything asking "did the
 * particles move" has to ask the particles.
 */
export function breachTrailNodes(key = 'air') {
  const out = [];
  for (const p of plumesOf(key)) for (const n of p.nodes) out.push([n.x, n.y]);
  return out;
}

/**
 * The cloud's state as three numbers, for the harness and for perf logging.
 *
 * `meanSpeed` is here rather than being inferred from positions because the
 * particles DIE — a caller diffing spine coordinates between two frames is
 * silently comparing different particles the moment one in the middle expires,
 * and the resulting nonsense looks exactly like drag running backwards. The
 * velocity is the thing being asked about, so it is the thing reported.
 */
export function breachTrailStats(key = 'air') {
  const plumes = plumesOf(key);
  let speed = 0;
  let age = 0;
  let count = 0;
  for (const p of plumes) {
    for (const n of p.nodes) {
      speed += Math.hypot(n.vx, n.vy);
      age += n.age;
      count++;
    }
  }
  const d = count || 1;
  return {
    count,
    plumes: plumes.length,
    meanSpeed: speed / d,
    meanAge: age / d,
    erasing: plumes.some((p) => p.sealed && p.eraseT < 1),
  };
}
