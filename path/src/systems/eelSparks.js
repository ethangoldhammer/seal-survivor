// ===========================================================================
// THE EEL'S ORBIT — charge circling the companion, on a strange attractor.
// ===========================================================================
// The Electric Eel Friend used to be a fish that did nothing at all until its
// cooldown came up, and then a bolt appeared beside it. Nothing on screen said
// the animal was carrying a charge between those moments, and nothing said the
// chain came OUT of it: the arc's first point was the eel's own centre, so the
// lightning started inside the body rather than leaving it.
//
// This is the charge, made visible. A handful of sparks fly a strange attractor
// wrapped around the eel's BODY — nose to tail, circling the long axis, with one
// travelling wave running down the lot of them — and when the chain fires it
// leaves from whichever spark is pointing at the first victim while its
// neighbours throw short arcs into that same point. The discharge is a thing you
// can see gather.
//
// WHY THE SAME THREE EQUATIONS AS THE BOSS STORMS AND THE BAIT BALL. Orbiting
// VFX are normally a sine — an angle advanced at a fixed rate, a radius, and a
// phase offset per particle — and a sine reads as machinery. Six sparks on a
// circle at even spacing are a gear, and the eye finds the loop in about two
// seconds. An attractor never closes: Aizawa's ring is fast at the rim and slow
// near the axis, its orbits drift in and out, and no two of them are the same
// lap twice. It is also the thing this game already uses whenever something has
// to move in a way that cannot be predicted — see systems/attractors.js, which
// is the equations and nothing else, and why they are shared.
//
// THE ORBIT IS STRETCHED ONTO THE BODY, and which coordinate goes where is the
// one decision in the file. Aizawa's x and y are a fast ring and its z is the
// slow axis that ring is stacked along, so:
//
//   x → ALONG the eel, nose to tail, at half the body length.
//   y → RADIAL, across it, at the tube's radius.
//   z → DEPTH, out of the screen, drawn as BRIGHTNESS and never as a position.
//       The whole game is planar — a spark "0.8 toward the camera" is a spark
//       somewhere the hit tests do not live — and dimming is how everything
//       else in this water reads depth anyway.
//
// So the ring becomes an ELLIPSE the length of the animal: a spark sweeps from
// nose to tail down one side and back up the other, and the whole lap is drawn
// rather than half of it. That last part is why the ring is not simply laid
// across the body instead, with z running the length: z is the SLOW axis, so
// the sparks bunch at the two ends and drift between them, and the fast
// coordinate ends up oscillating inside a span less than a unit wide. It reads
// as a buzz beside the animal rather than as anything going round it. Same
// three numbers, same equations, and the look is not close.
//
// Aizawa's own dive toward its axis is worth having rather than worth tuning
// away: it is the lap where a spark crosses the eel's spine, and no ellipse
// does it by itself.
//
// THE TRAIL IS KEPT IN THE EEL'S OWN FRAME, not the world's. A world-space tail
// smears behind a swimming eel, and at the speeds the seal moves that turns
// every spark into a straight streak pointing backwards — the orbit, which is
// the entire point, disappears whenever the player is going anywhere. Local
// samples drawn at the eel's current position give the attractor's path, which
// is the thing worth drawing.
//
// TWO DRAW CALLS FOR THE LOT. One merged ribbon for the cores and one for the
// haloes, each a single buffer with a fixed slice per spark, rewritten in place
// every frame. Nothing here allocates while the eel is alive; the pool is only
// rebuilt when the spark COUNT changes, which is a level-up or a slider.
// ===========================================================================

import * as THREE from 'three';
import { stepAttractor, attractorDeriv, attractorDefaults } from './attractors.js';
import { hdrInto } from './beams.js';

// How far a state may wander before the spark is written off and reseeded.
// Aizawa has a cubic term, so a state that leaves the basin does not drift, it
// diverges — and a diverged spark is at 1e30, where it fails every comparison
// and would sit in the pool as an invisible hole in the ring for the rest of
// the run. The storms kill a cube that does this; an ornament may not thin out
// over a run, so this reseeds instead. See reseed().
const DOMAIN = { thomas: 26, lorenz: 90, aizawa: 6 };

// HOW FAR EACH SYSTEM ACTUALLY REACHES, in its own units. `rim` is how far x
// and y get — the cross-section's radius — and `axis` is how far z gets.
//
// Both are needed, and they were one number until the orbit became a tube: the
// rim now becomes the tube's RADIUS and the axis becomes the eel's LENGTH, and
// those are nothing like the same distance. Measured over ten trajectories of
// thirty thousand steps each rather than guessed, because a scale derived from
// a wrong reach is a shape that fits its animal at one end and not the other —
// which looks like a tuning problem rather than an arithmetic one.
const REACH = {
  aizawa: { rim: 1.53, axis: 1.17 },
  lorenz: { rim: 30.6, axis: 21.6 },
  thomas: { rim: 4.5, axis: 4.09 },
};

// Integration substeps a frame. Three is generous for Aizawa — it is the two
// with a wing rim (Lorenz) that need more — and this runs on a dozen sparks
// rather than sixty cubes.
const SUBSTEPS = 3;

// Where a spark is born, and then how far it is flown before it is shown. Both
// halves matter. Aizawa's basin is at the MIDDLE — a state seeded far out is
// outside it and diverges on the first step — but a spark released at the
// middle spends its first second crawling outward, so a fresh pool would be a
// knot at the eel that slowly opens into a ring. The warm-up is a random number
// of steps up to rather more than one lap, which lands the pool already spread
// around the shape.
const WARM_STEP = 0.01;
const WARM_MIN = 40;
const WARM_SPAN = 400;

// ---------------------------------------------------------------------------
// THE WIGGLE — a loopable travelling wave, because the animal is an eel
// ---------------------------------------------------------------------------
// The sparks fly the attractor, and then this bends the whole cloud sideways in
// a wave that runs from the eel's nose to its tail. It is the difference
// between charge orbiting a fish and charge orbiting THIS fish: a moray swims
// by sending one wave down its body, and an ornament that ignores that reads as
// stuck to the animal rather than as part of it.
//
// A FOURIER SERIES WITH INTEGER FREQUENCIES, which is what makes it loopable in
// the strict sense: every term completes a whole number of cycles over one unit
// of `u`, so w(u) === w(u + 1) exactly — not approximately, not after a fade.
// That matters because the phase driving it is wrapped into 0..1 every frame.
// A float clock that ran forever would lose precision over a long session and,
// far worse, an un-loopable noise would have to be crossfaded with itself
// somewhere, and the seam always lands on the frame the player is watching.
//
// FOUR HARMONICS AT 1, 2, 3 AND 5, amplitudes falling off, with phases that are
// not multiples of anything. Two would read as a sine, and 1-2-4-8 share
// crossings and make a shape that repeats within its own period. This one has a
// long slow swing with smaller kinks riding on it, which is what a swimming eel
// does and what a plain sine does not.
const WIGGLE = [
  { f: 1, a: 1, p: 0 },
  { f: 2, a: 0.46, p: 0.37 },
  { f: 3, a: 0.27, p: 0.71 },
  { f: 5, a: 0.15, p: 0.19 },
];
const WIGGLE_NORM = WIGGLE.reduce((sum, h) => sum + h.a, 0);

/**
 * The wave at phase `u`, in -1..1. Exactly periodic with period 1.
 *
 * Exported for the test, which is the only place "it loops" can actually be
 * checked — on screen a seam a frame wide is invisible right up until it isn't.
 */
export function eelWiggle(u) {
  let v = 0;
  for (const h of WIGGLE) v += h.a * Math.sin(Math.PI * 2 * (h.f * u + h.p));
  return v / WIGGLE_NORM;
}

// The wave's own clock, kept as a phase in 0..1 rather than as seconds. See
// above: wrapping is free when every term has an integer frequency.
let wigglePhase = 0;

let group = null;
let coreMesh = null;
let glowMesh = null;
let colorAttr = null;      // shared by both ribbons — the fade profile is theirs alike
let corePos = null;
let glowPos = null;
let sparks = [];
let builtCount = 0;
let builtTrail = 0;
let builtShape = '';
let flare = 0;             // the discharge, decaying to 0

const _deriv = { x: 0, y: 0, z: 0 };
const _core = new THREE.Color();
const _glow = new THREE.Color();

/** The spark block, with every default filled in. */
function sparkCfg(eel) {
  return eel?.sparks ?? {};
}

/**
 * How many sparks a stack of `level` carries.
 *
 * Exported because it is the one number in here a terminal can check, and
 * because it is the shape of the ramp rather than a look: the orbit is how the
 * ability says how big it has got, the same job the bolt's crackle ramp does.
 */
export function eelSparkCount(s, level) {
  if (!s || s.enabled === false || level <= 0) return 0;
  const base = Math.max(0, s.count ?? 0);
  const per = Math.max(0, s.countPerLevel ?? 0);
  const max = Math.max(1, s.countMax ?? 24);
  return Math.max(1, Math.min(max, Math.round(base + per * Math.max(0, level - 1))));
}

// A fresh state at the middle of the basin, flown forward onto the shape.
function reseed(sp, shape, params) {
  sp.state.x = (Math.random() * 2 - 1) * 0.1;
  sp.state.y = (Math.random() * 2 - 1) * 0.1;
  sp.state.z = (Math.random() * 2 - 1) * 0.2;
  const steps = WARM_MIN + Math.floor(Math.random() * WARM_SPAN);
  for (let i = 0; i < steps; i++) {
    if (!stepAttractor(shape, sp.state, WARM_STEP, params)) { sp.state.x = 0.05; sp.state.y = 0; sp.state.z = 0; break; }
  }
  sp.seeded = false;
}

// ---------------------------------------------------------------------------
// THE POOL
// ---------------------------------------------------------------------------
// Rebuilt only when the count, the tail length or the shape changes. Everything
// else — position, width, colour, the flare — is written into buffers that
// already exist.
function buildPool(scene, count, trail, shape, params) {
  // THE ORBIT SURVIVES THE REBUILD. A level-up adds a spark or two, and a pool
  // that reseeded wholesale would have every spark on screen jump to a new place
  // on the ring the instant the card is taken — the ability's own upgrade making
  // it look like it restarted. Only the NEW sparks are seeded; the ones already
  // flying carry their state across. (Their tails are dropped with the buffer,
  // which is a frame nobody sees.)
  // Never across a SHAPE change: a Lorenz state handed to Aizawa is a hundred
  // units outside its basin, which the domain check would catch a frame later —
  // but a frame later is a frame of the whole ring drawn somewhere it cannot be.
  const carried = shape === builtShape ? sparks.map((sp) => sp.state) : [];
  disposePool(scene);
  builtCount = count;
  builtTrail = trail;
  builtShape = shape;
  if (count <= 0) return;

  const P = trail + 1;                 // the live head, then the samples
  const verts = count * P * 2;
  corePos = new Float32Array(verts * 3);
  glowPos = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const index = [];
  for (let s = 0; s < count; s++) {
    const b = s * P * 2;
    for (let i = 0; i < P - 1; i++) {
      const a = b + i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  // THE TAIL FADE IS WRITTEN ONCE AND NEVER REWRITTEN. It is the same profile
  // for every spark on every frame; only the two brightness terms that ride on
  // top of it — this spark's depth and the discharge flare — move, and they are
  // folded into the same array in updateEelSparks.
  colorAttr = new THREE.BufferAttribute(colors, 3);

  const geo = (pos) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', colorAttr);
    g.setIndex(index);
    return g;
  };
  const mat = (opacity) => new THREE.MeshBasicMaterial({
    transparent: true,
    opacity,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  group = new THREE.Group();
  // Behind the bolt (0.12) and in front of the companion (0.05): the chain has
  // to read over the top of the charge it left from.
  group.position.z = 0.08;
  glowMesh = new THREE.Mesh(geo(glowPos), mat(1));
  coreMesh = new THREE.Mesh(geo(corePos), mat(1));
  group.add(glowMesh, coreMesh);
  scene.add(group);

  sparks = [];
  for (let i = 0; i < count; i++) {
    const sp = {
      state: { x: 0, y: 0, z: 0 },
      samples: new Float32Array(trail * 2),
      head: 0,
      sampleIn: 0,
      depth: 1,
      x: 0,
      y: 0,
      // This spark's offset into the wave. Small (it is multiplied by `jitter`)
      // and deliberately so: the wave is the ANIMAL'S, so the cloud has to
      // undulate together or it stops reading as one body's motion and starts
      // reading as a dozen unrelated squiggles. The jitter only stops it being
      // a rigid sheet.
      phase: Math.random(),
      seeded: false,
    };
    const was = carried[i];
    if (was && Number.isFinite(was.x)) {
      sp.state.x = was.x; sp.state.y = was.y; sp.state.z = was.z;
    } else {
      reseed(sp, shape, params);
    }
    sparks.push(sp);
  }
}

function disposePool(scene) {
  if (!group) return;
  scene.remove(group);
  for (const m of [coreMesh, glowMesh]) {
    m?.geometry?.dispose();
    m?.material?.dispose();
  }
  group = null;
  coreMesh = null;
  glowMesh = null;
  colorAttr = null;
  corePos = null;
  glowPos = null;
  sparks = [];
  builtCount = 0;
  builtTrail = 0;
  builtShape = '';
}

// Lay one spark's polyline into both position arrays as a tapering ribbon.
//
// Written by hand rather than through the bolt's ribbonFromPoints because that
// one builds a geometry per call — which is the right shape for a thing that
// lives for a third of a second and the wrong one for a thing that is rewritten
// sixty times a second forever.
function writeSpark(s, pts, n, coreW, glowW) {
  const P = builtTrail + 1;
  let o = s * P * 2 * 3;
  for (let i = 0; i < P; i++) {
    // Clamped rather than wrapped: a pool whose trail has not filled yet repeats
    // its oldest sample, which collapses those segments to zero area instead of
    // drawing a line back to the head.
    const idx = Math.min(i, n - 1);
    const px = pts[idx * 2];
    const py = pts[idx * 2 + 1];
    const pv = Math.max(0, idx - 1);
    const nx2 = Math.min(n - 1, idx + 1);
    let dx = pts[nx2 * 2] - pts[pv * 2];
    let dy = pts[nx2 * 2 + 1] - pts[pv * 2 + 1];
    const m = Math.hypot(dx, dy);
    if (m < 1e-6) { dx = 1; dy = 0; } else { dx /= m; dy /= m; }
    // HEAD-WEIGHTED, NOT SYMMETRIC. A bolt tapers at both ends because it is
    // pinned to two bodies; a spark is a head with a tail behind it, so the
    // width falls from full at the live position to nothing at the oldest
    // sample. The exponent keeps some body in the middle of the streak rather
    // than pinching it off immediately.
    const t = P > 1 ? i / (P - 1) : 0;
    const taper = Math.pow(1 - t, 0.75);
    const cw = coreW * 0.5 * taper;
    const gw = glowW * 0.5 * taper;
    // side = dir x up, with up out of the screen.
    const sx = dy;
    const sy = -dx;
    corePos[o] = px + sx * cw; corePos[o + 1] = py + sy * cw; corePos[o + 2] = 0;
    glowPos[o] = px + sx * gw; glowPos[o + 1] = py + sy * gw; glowPos[o + 2] = 0;
    corePos[o + 3] = px - sx * cw; corePos[o + 4] = py - sy * cw; corePos[o + 5] = 0;
    glowPos[o + 3] = px - sx * gw; glowPos[o + 4] = py - sy * gw; glowPos[o + 5] = 0;
    o += 6;
  }
}

// Scratch for the polyline handed to writeSpark. Sized on demand, reused.
let _pts = new Float32Array(64);

/**
 * Fly the orbit one frame.
 *
 * `cfg` is the eel's STORM SNAPSHOT (eelCfg()), not CONFIG.eel — so the sparks
 * take the same colour and the same weather the bolt does, from the same
 * snapshot, and a storm cannot be sampled at two different intensities inside
 * one frame's worth of one ability.
 */
export function updateEelSparks(dt, scene, x, y, angle, level, cfg) {
  const s = sparkCfg(cfg);
  const want = eelSparkCount(s, level);
  const trail = Math.max(2, Math.round(s.trail ?? 9));
  const shape = s.shape ?? 'aizawa';
  const params = attractorDefaults(shape);

  if (want !== builtCount || trail !== builtTrail || shape !== builtShape) {
    buildPool(scene, want, trail, shape, params);
  }
  if (!group || want <= 0) return;

  // THE DISCHARGE, decaying. Read as a multiplier on brightness and on how fast
  // the orbit runs: the charge visibly leaves when the chain fires and the ring
  // whips as it goes, which is the only frame in which the sparks and the bolt
  // are one event rather than two things happening at once.
  if (flare > 0) flare = Math.max(0, flare - dt / Math.max(0.001, s.flareDecay ?? 0.18));

  // ---- THE BODY FRAME -----------------------------------------------------
  // The orbit is a TUBE AROUND THE EEL'S LONG AXIS, not a ring about a point.
  // It used to hang off the companion's origin, which put the whole effect in a
  // disc beside the animal's head — charge sitting next to an eel rather than
  // charge running through one. Three world directions, and the attractor's
  // three coordinates go one to each:
  //
  //   z → ALONG the body. Nose to tail, so a spark travels the animal's length.
  //   x → RADIAL, in the screen plane. The visible half of going round.
  //   y → DEPTH, out of the screen. Drawn as brightness rather than as a
  //       position, because collision and everything else here is planar: a
  //       spark at "z 0.8 toward the camera" is a spark somewhere the rest of
  //       the game does not have.
  //
  // So a spark genuinely circles the body — half of that circle is seen as a
  // sideways excursion and the other half as it dimming and coming back.
  const reach = REACH[shape] ?? REACH.aizawa;
  const halfLen = Math.max(0.01, (s.length ?? 3.4) * 0.5);
  // Both from `rim`, because both are the RING — the ellipse is that ring with
  // its two axes scaled differently. `axis` is the reach of the slow third
  // coordinate and belongs to the depth cue alone.
  const kAlong = halfLen / reach.rim;
  const kRadial = Math.max(0.01, s.radius ?? 0.85) / reach.rim;
  const ax = Math.cos(angle ?? 0);
  const ay = Math.sin(angle ?? 0);
  const px = -ay;
  const py = ax;
  // WHERE THE MIDDLE OF THE ORBIT SITS, and it is not the companion's origin.
  // A swimmer's origin is at `pivot` along its body (assets.js) — the moray's
  // is 0.15, fifteen percent back from the nose, so that it turns by leading
  // with its head. Centring the orbit on the origin therefore wraps it around
  // the eel's HEAD and leaves two thirds of the animal bare, which looks like a
  // scale problem and is not one.
  const mid = s.offset ?? -1.26;

  const rate = Math.max(0, s.rate ?? 2.5) * (1 + (Math.max(1, s.flareRate ?? 1) - 1) * flare);
  const cap = Math.max(0.1, s.speedCap ?? 11);
  // The clamp, exactly the storms': `speedCap` is world units a second, so
  // dividing by the world-per-attractor-unit factor gives attractor units a
  // second and dividing by the substep count gives each substep its share.
  // Applied by shortening the STEP rather than the move, which is the only
  // version that keeps the path. The LARGER of the two factors, because the
  // tube stretches the axes differently and the cap has to hold on both.
  const capPerSub = (cap / Math.max(kAlong, kRadial)) * dt / SUBSTEPS;
  const h = (rate * dt) / SUBSTEPS;
  const domain = DOMAIN[shape] ?? 30;
  const depthDim = Math.max(0, Math.min(1, s.depth ?? 0.45));
  const every = Math.max(1e-4, (s.trailSeconds ?? 0.13) / trail);

  // ---- THE WAVE -----------------------------------------------------------
  // Advanced as a wrapped phase, so the clock itself loops with the wiggle.
  const w = s.wiggle ?? {};
  const wigAmp = Math.max(0, w.amp ?? 0.22);
  const wigWaves = w.waves ?? 1.3;
  const wigJitter = Math.max(0, Math.min(1, w.jitter ?? 0.15));
  const wigPeriod = Math.max(0.05, w.period ?? 1.1);
  wigglePhase = (wigglePhase + dt / wigPeriod) % 1;
  // The wave at a point, given how far along the body it sits. The MINUS is
  // what makes it travel nose-to-tail rather than standing still: the phase a
  // point sees lags the one behind it.
  const waveAt = (along, phase) =>
    wigAmp * eelWiggle(wigglePhase - (along / (halfLen * 2)) * wigWaves + phase);

  const need = (trail + 1) * 2;
  if (_pts.length < need) _pts = new Float32Array(need);

  // WIDTH AS A SHARE OF THE BOLT'S OWN, not a pair of numbers of its own. The
  // charge and the discharge are the same electricity, and the bolt's widths
  // are a slider Ethan actually moves — the shipped tuning is nearly twice the
  // core this file was first written against. Absolute numbers here would mean
  // the orbit silently stops matching the arc the next time that slider moves,
  // which is the sort of drift nobody sees because the sparks still render. It
  // also means a storm, which widens the bolt, widens the orbit for free.
  const coreW = Math.max(0, (cfg?.coreWidth ?? 0.16) * (s.coreMul ?? 0.3));
  const glowW = Math.max(0, (cfg?.glowWidth ?? 0.85) * (s.haloMul ?? 0.55));

  for (let i = 0; i < sparks.length; i++) {
    const sp = sparks[i];
    let alive = true;
    for (let k = 0; k < SUBSTEPS; k++) {
      attractorDeriv(shape, sp.state.x, sp.state.y, sp.state.z, params, _deriv);
      const m = Math.hypot(_deriv.x, _deriv.y, _deriv.z);
      // A zero derivative is a fixed point; a spark may sit on one and dividing
      // by it is the one thing here that would put a NaN in the buffer.
      const hEff = m > 1e-6 ? Math.min(h, capPerSub / m) : h;
      if (!stepAttractor(shape, sp.state, hEff, params)) { alive = false; break; }
    }
    if (!alive || Math.hypot(sp.state.x, sp.state.y, sp.state.z) > domain) {
      reseed(sp, shape, params);
    }

    const along = sp.state.x * kAlong;
    const radial = sp.state.y * kRadial;
    const depthN = Math.max(-1, Math.min(1, sp.state.z / reach.axis));
    sp.depth = 1 - depthDim * (0.5 - 0.5 * depthN);

    // THE TAIL IS STORED IN BODY COORDINATES — (along, radial), undisplaced.
    //
    // Body and not world for the reason it was local before: a world tail
    // smears into a straight streak behind a swimming eel. Body and not the
    // old axis-aligned local, because the eel TURNS, and a tail kept in
    // world-aligned offsets would stay pointing the way the animal used to be
    // facing while its body swung away from it.
    //
    // UNDISPLACED, so the wave is applied at DRAW time from each sample's own
    // position along the body. That is what makes the whole streak ripple as
    // one thing rather than carrying a frozen snapshot of the wave it was born
    // in — the difference between a wiggly line and a line that is wiggling.
    if (!sp.seeded) {
      for (let j = 0; j < trail; j++) { sp.samples[j * 2] = along; sp.samples[j * 2 + 1] = radial; }
      sp.head = 0;
      sp.sampleIn = every;
      sp.seeded = true;
    } else {
      sp.sampleIn -= dt;
      if (sp.sampleIn <= 0) {
        sp.head = (sp.head + 1) % trail;
        sp.samples[sp.head * 2] = along;
        sp.samples[sp.head * 2 + 1] = radial;
        sp.sampleIn += every;
        // A long frame must not walk the whole ring backwards in one go.
        if (sp.sampleIn < 0) sp.sampleIn = every;
      }
    }

    // Newest first: the live position, then the samples backwards from the
    // head, each carried into the world through the body frame and the wave.
    const jit = sp.phase * wigJitter;
    for (let j = 0; j <= trail; j++) {
      // j 0 is the live position; the rest walk back from the head.
      let al = along;
      let ra = radial;
      if (j > 0) {
        const idx = (sp.head - (j - 1) + trail) % trail;
        al = sp.samples[idx * 2];
        ra = sp.samples[idx * 2 + 1];
      }
      // The wave is read at the point's place in the ORBIT, before the offset:
      // the offset moves the whole thing down the body and must not slide the
      // wave through it.
      const r = ra + waveAt(al, jit);
      _pts[j * 2] = x + ax * (al + mid) + px * r;
      _pts[j * 2 + 1] = y + ay * (al + mid) + py * r;
    }
    sp.x = _pts[0];
    sp.y = _pts[1];
    writeSpark(i, _pts, trail + 1, coreW, glowW);

    // The brightness this spark's vertices carry: the fade along the tail, this
    // spark's depth, and the discharge. All three are the same grayscale term,
    // so the two materials' own colours stay the only place a hue is decided.
    const bright = sp.depth * (1 + (Math.max(1, s.flare ?? 1) - 1) * flare);
    const P = builtTrail + 1;
    const arr = colorAttr.array;
    let o = i * P * 2 * 3;
    for (let p = 0; p < P; p++) {
      const t = P > 1 ? p / (P - 1) : 0;
      const v = bright * Math.pow(1 - t, 1.4);
      arr[o] = v; arr[o + 1] = v; arr[o + 2] = v;
      arr[o + 3] = v; arr[o + 4] = v; arr[o + 5] = v;
      o += 6;
    }
  }

  coreMesh.geometry.attributes.position.needsUpdate = true;
  glowMesh.geometry.attributes.position.needsUpdate = true;
  colorAttr.needsUpdate = true;
  coreMesh.geometry.computeBoundingSphere();
  glowMesh.geometry.computeBoundingSphere();

  // PEAK-CHANNEL NORMALISED, like the bolt's. The bright pass thresholds on
  // luminance, so the same number on a cold colour and a warm one would not
  // bloom alike — and this colour is a slider. See hdrInto and npm run glow.
  const base = new THREE.Color(cfg?.boltColor ?? 0x9fe8ff);
  const glowBase = (cfg?.boltGlow ?? 3) * Math.max(0, s.glow ?? 1);
  hdrInto(_core, base, glowBase);
  hdrInto(_glow, base, glowBase * Math.max(0, s.haloGlow ?? 0.4));
  coreMesh.material.color.copy(_core);
  glowMesh.material.color.copy(_glow);
  // The bolt's own halo opacity, for the same reason as the widths: one slider.
  glowMesh.material.opacity = Math.max(0, Math.min(1, cfg?.glowOpacity ?? 0.5));
}

/** Every live spark's world position, newest state. For the chain and tests. */
export function eelSparkPoints() {
  return sparks.map((sp) => ({ x: sp.x, y: sp.y, depth: sp.depth }));
}

/**
 * The spark the chain should leave from: the one furthest along the line toward
 * what is about to be hit.
 *
 * NEAREST THE TARGET AND NOT A ROLL. A random spark puts the bolt's first hop
 * through the eel's own body as often as not, and a chain that starts on the
 * far side of the animal from the fish it is hitting reads as a mistake. The
 * ring is small enough that "nearest" is always a spark on the right side.
 *
 * Returns null when there are no sparks — the caller falls back to the eel
 * itself, which is what the chain always did.
 */
export function sparkLaunchPoint(towardX, towardY) {
  let best = null;
  let bestD = Infinity;
  for (const sp of sparks) {
    const d = Math.hypot(sp.x - towardX, sp.y - towardY);
    if (d < bestD) { bestD = d; best = sp; }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * The `n` sparks nearest a point, excluding any sitting on top of it.
 *
 * These are the feeders: short arcs thrown into the chain's first point at the
 * instant it fires, so the bolt reads as the whole orbit emptying into one
 * place rather than as one spark having been the charge all along.
 */
export function sparkFeeders(x, y, n) {
  const want = Math.max(0, Math.round(n || 0));
  if (want <= 0) return [];
  return sparks
    .map((sp) => ({ x: sp.x, y: sp.y, d: Math.hypot(sp.x - x, sp.y - y) }))
    .filter((sp) => sp.d > 1e-4)
    .sort((a, b) => a.d - b.d)
    .slice(0, want)
    .map((sp) => ({ x: sp.x, y: sp.y }));
}

/** The chain just fired: brighten the orbit and whip it round. */
export function flareEelSparks() {
  flare = 1;
}

/** For tests and the lab — how far through the discharge the orbit is. */
export function eelSparkFlare() {
  return flare;
}

export function resetEelSparks(scene) {
  disposePool(scene);
  flare = 0;
}
