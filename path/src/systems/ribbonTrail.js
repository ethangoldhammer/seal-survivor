import * as THREE from 'three';
import { turbulenceAt, emit } from '../entities/particles.js';
import { retireMaterial } from './programPin.js';

// ============================================================================
// THE RIBBON TRAIL — a cloud of particles with a band threaded through it.
//
// This is the ENGINE, and it belongs to nobody. Two effects run on it:
//
//   systems/breachTrail.js  the seal's exhaust in the air and its filament in
//                           the water. Three channels split into an RGB fringe
//                           above the line, one white one below it.
//   systems/ballTrail.js    what the Blubberball drags behind it, in two
//                           colours that are fighting over the body.
//
// It was breachTrail's whole file until the ball needed the same thing, and the
// split is a MOVE rather than a rewrite: every note below was written about the
// seal and is still true of it. What stayed behind in breachTrail.js is the
// part that is about a seal — where the plumes come out of, when the gate is
// open, what a strike wind-up does to them. What is here is the part that is
// about a ribbon.
//
// HOW IT WORKS, in one paragraph. Every point on the spine is a PARTICLE: born
// at a source with an outward kick, pushed by the same divergence-free
// turbulence field the sprites ride (entities/particles.js), slowed by drag,
// carrying its own lifetime. A centripetal Catmull-Rom curve is fitted through
// them and the band is drawn along THAT, one quad per sample with the
// cross-section evaluated in the fragment shader. So the trail keeps living
// after its source has gone — it billows outward, frays, and dies raggedly a
// particle at a time instead of fading out as one object.
//
// WHY THE FIELD IS THE ONE FROM entities/particles.js. It is divergence-free by
// construction (see the long note there), which means it can only ever swirl
// the particles around — never pile them together or tear them apart. That is
// what keeps a ribbon threaded through the cloud a ribbon while it billows: a
// field with divergence would shear neighbours apart and the band drawn between
// them would tear.
//
// WHY NOT ACTUAL PARTICLES. entities/particles.js is one draw call for every
// burst in the game and its palette rule is deliberate — a burst's colour says
// what KIND of event it was. A trail is not an event; it is a continuous
// surface, and a surface is what a ribbon is for. systems/inkTrail.js is the
// case that went the other way, and the note at the top of it is why.
//
// N CHANNELS, ONE SPINE. Every ribbon in a plume reads the SAME curve at a
// different offset — sideways and along it — and they are drawn additively over
// each other. Where they agree they sum; where they don't they fringe. THE
// CHANNEL COUNT IS READ OFF `colors`: one entry is one ribbon straight down the
// spine with every term of the split evaluating to zero on its own, and no
// branch anywhere says so.
//
// AND WHO LEANS WHICH WAY IS OPTIONAL. By default the channels are spaced
// symmetrically about the spine, which is what an RGB split is. `channelLean`
// and `channelGain` let a caller place and weight them per frame instead —
// which is how the ball's two team colours describe a possession that is 80/20
// rather than an even fringe. Left unset, nothing changes.
//
// Geometry is allocated once and rewritten in place — this runs every frame of
// every breach, and a per-frame allocation here is a per-frame GC pause.
// ============================================================================

// The default channel count, for anything that has to guess before a colour
// list is in hand.
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
export const HARD_MAX_NODES = 400;
// Ribs drawn along the spline, independent of how many PARTICLES there are.
// The spine is resampled to this many points, which is what turns a polyline
// through scattered particles into a curve — see resampleSpine.
export const HARD_MAX_SAMPLES = 512;

/**
 * One RIG: a scene root, the plumes under it, and whether its gate was open
 * last frame. One per profile — the seal has two (air and water) and the ball
 * has two, and they are four independent clouds in all.
 *
 * SEPARATE SCENE ROOTS per rig, deliberately: a root is what `clear` removes,
 * and one shared root would mean tearing down the air trail also tore down the
 * water one.
 */
export function createRig(key, name) {
  return {
    key,
    name,      // its scene node's name — 'breachTrail' / 'swimTrail' / ...
    plumes: [],
    root: null,
    // Whether the gate was open last frame. Crossing it is what starts a new
    // STRAND (so two bursts are not joined by a stripe across the arena) and
    // what seals the old one.
    wasActive: false,
    // Drives the turbulence field's churn. PER RIG rather than module-level:
    // two effects advancing one shared clock would churn the field at twice
    // the tuned speed, and which speed you got would depend on how many
    // trails happened to be on screen.
    clock: 0,
  };
}
// Shared scratch for the resample — one plume is drawn at a time, so these are
// reused rather than duplicated per plume.
let sx = new Float32Array(HARD_MAX_SAMPLES);
let sy = new Float32Array(HARD_MAX_SAMPLES);
let sBright = new Float32Array(HARD_MAX_SAMPLES);
let sWidth = new Float32Array(HARD_MAX_SAMPLES);
let sCum = new Float32Array(HARD_MAX_SAMPLES);
let sCount = 0;
let nodeCum = new Float32Array(64); // arc length along the raw particle polyline

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

// One colour, one ribbon. The whole difference between the split trail and the
// white one is the length of this list — see the profile note at the top.
function channelCount(c) {
  const n = (c.colors ?? []).length;
  return n > 0 ? n : CHANNELS;
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
    retireMaterial(r.mesh.material);
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
function driftNodes(plume, dt, c, clock) {
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
 * ONE RIG'S FRAME: its plumes, its gate, its cloud, its ribbons.
 *
 * Everything drifts and dies whatever the gate says — that is the point of the
 * particle spine — so this is safe to call outside a pause gate, and both
 * callers do.
 *
 * @param profile a rig from createRig — owns the scene root and the plume list
 * @param dt      real seconds. A hit-stop must not stall a cloud mid-billow.
 * @param sources where the particles come out of, as objects with x/y. ONE
 *                PLUME EACH, and they are independent clouds rather than one
 *                cloud fed from several places: the spine is a polyline through
 *                particles in birth order, so interleaving two emitters into
 *                one list makes every consecutive pair jump from one source to
 *                the other, and the ribbon threaded through it is a zigzag
 *                between them rather than two trails.
 * @param c       the rig's resolved settings — one flat block, see the callers'
 *                cfg(). Read live every frame, so a tuner slider reshapes a
 *                trail already in the water.
 * @param o       { active, emitting, rate, nodeRamp, vx, vy }
 *                active   is the gate open. Crossing it in either direction is
 *                         a strand boundary: opening starts a new strand,
 *                         closing seals the old one.
 *                emitting whether new particles may be laid down at all. A
 *                         frozen source is not moving, so a second's worth of
 *                         emission would all be born at the same coordinates
 *                         and stack into one bright blob.
 *                rate     multiplier on `emitPerSecond`, 0..1.
 *                nodeRamp what gets stamped on each particle as its intensity.
 *                vx, vy   the source's velocity, for the birth kick's inherit
 *                         term and for the fallback tangent when it is still.
 */
export function runRibbon(profile, dt, scene, sources, c, o) {
  // The field's churn is the rig's own — see `clock` in createRig.
  profile.clock += dt;
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

  // One plume per source, created and torn down to match. The count only
  // changes when the thing shedding them does — a model swap in the workbench,
  // the very first frame before a rig has posed itself, or a ball that has just
  // been told to shed from one point instead of two.
  while (plumes.length < sources.length) plumes.push(makePlume());
  while (plumes.length > sources.length) disposePlume(profile, plumes.pop());

  for (let i = 0; i < plumes.length; i++) {
    const plume = plumes[i];
    const tip = sources[i];
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
    driftNodes(plume, dt, c, profile.clock);
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
 * Resample one plume's cloud into a curve and write its ribbons — one per
 * colour. The channel arithmetic below is written against `channels` rather
 * than a constant, and at one channel every term of the split evaluates to
 * zero on its own: the offset is `(0 - 0) * spread`, so a single ribbon is
 * drawn straight down the spine with no branch anywhere saying so.
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

  // WHERE EACH CHANNEL SITS ON THE SPLIT AXIS, and how bright it is.
  //
  // Unset — which is every static split, the seal's RGB one included — the
  // channels are spaced symmetrically about the spine at equal weight, and the
  // two lines below are the whole of it. A caller that wants to say something
  // with the split instead passes `channelLean` and `channelGain`, one entry
  // per colour, and gets to place and weight them per frame: see the ball's
  // possession trail, where a colour that owns four fifths of the body sits on
  // the spine and the other one is a thin fringe thrown clear of it.
  //
  // The units are the SAME ones the symmetric default uses — a lean of ±0.5 is
  // where a two-channel split would put its two halves — so an override is
  // comparable to the thing it replaces rather than a separate scale.
  const lean = c.channelLean;
  const gains = c.channelGain;

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
    const slot = lean?.[ch] ?? (ch - (channels - 1) / 2);
    const gain = gains?.[ch] ?? 1;
    const offset = slot * spread;
    const back = slot * trail;
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
      const endRoom = Math.max(1e-4, Math.abs(back));
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

      const bright = i >= sCount ? 0 : sBright[idx] * gain;
      col.setXYZ(v, _col.r * bright, _col.g * bright, _col.b * bright);
      col.setXYZ(v + 1, _col.r * bright, _col.g * bright, _col.b * bright);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}

/**
 * Tear one rig down — its plumes, its geometry, its scene node.
 *
 * The clock goes back to zero with them: a rig rebuilt after a run is a new
 * cloud, and inheriting the old one's phase means the turbulence field starts
 * mid-churn at whatever the last session left it at, which is a different
 * (and unreproducible) first second of trail every time.
 */
export function clearRig(profile, scene) {
  for (const p of profile.plumes) disposePlume(profile, p);
  profile.plumes.length = 0;
  if (profile.root) {
    scene.remove(profile.root);
    profile.root = null;
  }
  profile.wasActive = false;
  profile.clock = 0;
}

/**
 * The cloud's state as a few numbers, for the harnesses and for perf logging.
 *
 * `meanSpeed` is here rather than being inferred from positions because the
 * particles DIE — a caller diffing spine coordinates between two frames is
 * silently comparing different particles the moment one in the middle expires,
 * and the resulting nonsense looks exactly like drag running backwards. The
 * velocity is the thing being asked about, so it is the thing reported.
 */
export function rigStats(profile) {
  const plumes = profile.plumes;
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
