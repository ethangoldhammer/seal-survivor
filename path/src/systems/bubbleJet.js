import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { feedback, feedbackState } from './feedback.js';
import { hdr, glowSprite } from './beams.js';
import { emit } from '../entities/particles.js';
import { startJetBed, releaseJetBed, releaseAllJetBeds } from './jetBed.js';
import { bubbleJetLevelStats } from '../levelStats.js';
import { sear, releaseBurn } from './burnGlow.js';

// ---------------------------------------------------------------------------
// THE BUBBLE JET — a stream that snakes.
// ---------------------------------------------------------------------------
// systems/beams.js opens with what makes a beam not a projectile. This one is
// not a beam either, and the differences are the whole design:
//
//   IT IS NOT STRAIGHT.     A beam is a segment and its mesh is one quad
//                           scaled. This is a POLYLINE — a chain of nodes that
//                           lags behind the aim and carries a travelling wave —
//                           so it needs real vertices, rewritten every frame.
//   IT LAGS.                A beam sweeps rigidly: turn the seal and the whole
//                           line is instantly at the new angle. This one WHIPS.
//                           Each node chases the one before it, so a hard turn
//                           throws an S down the length of the stream and the
//                           tip arrives last. That lag is the entire feel.
//   IT IS HELD, NOT FIRED.  A beam has a life in seconds set when it is lit.
//                           This spools up, holds for as long as it is being
//                           held, and vents. Which is why it has a sound bed
//                           (systems/jetBed.js) instead of a one-shot: nothing
//                           in CONFIG.sfx can be told "keep going".
//
// SO WHY NOT EXTEND beams.js. Because every one of those three is load-bearing
// there in the opposite direction. Its geometry is deliberately ONE shared unit
// quad for every beam in the game — "a beam's length and width are mesh.scale,
// never vertices" — and its material pool exists because that quad never
// changes. A snaking ribbon is per-instance geometry with a per-frame vertex
// write, which is the exact thing that file is built around not doing. Bolting
// it in would have cost that pool and given the boss's eyebeams a code path
// they never take.
//
// WHAT IS SHARED IS THE PART THAT SHOULD BE: `hdr` and `glowSprite`. The
// peak-channel normalise is the only reason anything in this game blooms at a
// predictable strength (see the long note on hdr() in beams.js), and a second
// copy of that rule would be a second one to get wrong. The muzzle spill is
// literally the same 64x64 upload.
//
// DAMAGE FOLLOWS THE WIGGLE. The obvious shortcut is to draw the snake and
// resolve the damage against the straight axis, which is what most shooters do
// and what nobody notices — until the amplitude is turned up in the panel and
// the stream visibly misses things it kills. Both the mesh and the hit test
// read the SAME node array, `jet.path`, so there is no version of this that can
// drift.

/** Every live jet. Read by the panel and the harness; owned here. */
export const jets = [];

// The scene the last frame drew into. See the note at the top of updateJets.
let _scene = null;

function cfg() {
  return CONFIG.bubbleJet ?? {};
}

function look() {
  return CONFIG.bubbleJet?.look ?? {};
}

// ---------------------------------------------------------------------------
// THE PROFILE — falloff ACROSS the stream only.
// ---------------------------------------------------------------------------
// beams.js bakes the length taper into its texture because its geometry is a
// rectangle and the taper is the only thing that gives it a direction. Here the
// taper is in the VERTICES — every node has its own half-width — so baking it
// into the texture as well would apply it twice and pinch the tip to nothing.
//
// A texture rather than a shader, for the reason beams.js gives and which is
// worth repeating because it is the one that keeps this file testable: an
// injected GLSL error renders NOTHING, throws nothing, and cannot be seen from
// a Node harness. A canvas gradient either exists or does not.
let PROFILE = null;
function jetProfile() {
  if (PROFILE) return PROFILE;
  const W = 4, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const edge = look().edgeSoftness ?? 0.6;
  for (let y = 0; y < H; y++) {
    const v = (y / (H - 1)) * 2 - 1;      // -1..1 across
    const d = Math.abs(v);
    let a = 1 - Math.min(1, Math.max(0, (d - (1 - edge)) / Math.max(0.001, edge)));
    a = a * a;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  PROFILE = tex;
  return tex;
}

// ---------------------------------------------------------------------------
// THE RIBBON
// ---------------------------------------------------------------------------
// Two vertices per node, two triangles per span. Built once at the node count
// the jet was born with and then only ever WRITTEN to — allocating a
// BufferGeometry per frame is the version of this that drops frames.
//
// THE INDEX AND THE UVS ARE SET ONCE AND NEVER TOUCHED AGAIN. Only `position`
// is dynamic, and it is the only attribute that gets `needsUpdate`. Marking the
// whole geometry dirty every frame re-uploads the index buffer too, which for a
// 48-node ribbon is three times the traffic for no change.
function buildRibbon(nodes) {
  const geo = new THREE.BufferGeometry();
  const verts = nodes * 2;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  const uv = new Float32Array(verts * 2);
  for (let i = 0; i < nodes; i++) {
    const u = i / (nodes - 1);
    uv[i * 4 + 0] = u; uv[i * 4 + 1] = 0;
    uv[i * 4 + 2] = u; uv[i * 4 + 3] = 1;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const idx = new Uint16Array((nodes - 1) * 6);
  for (let i = 0; i < nodes - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.set([a, b, c, b, d, c], i * 6);
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // A ribbon that whips is nowhere near where three.js thinks it is, and a
  // wrong bounding sphere means the frustum cull hides the stream the moment
  // the muzzle leaves the screen — which is exactly when a long one matters.
  // Infinite, so it is never culled; there is one of these on screen at a time.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

function buildMesh(scene, j) {
  const group = new THREE.Group();
  const l = look();
  const glowColor = hdr(j.color, j.overdrive * (l.glowOverdriveMul ?? 0.5));
  const coreColor = hdr(j.coreColor ?? 0xffffff, j.overdrive);

  // TWO RIBBONS, NOT ONE WITH A WIDE TEXTURE. They are written from the same
  // node array with different half-widths, which is what makes a hot line sit
  // inside a soft halo instead of a single band with a lighter stripe painted
  // down it. Same reasoning as the core/glow pair in beams.js — and the same
  // constraint sets the widths: CONFIG.bloom.divisor is 6, so anything under
  // about 1.5 bloom pixels contributes nothing to the bright pass however
  // brightly it is authored.
  const glowMat = new THREE.MeshBasicMaterial({
    color: glowColor, map: jetProfile(),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: coreColor, map: jetProfile(),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(buildRibbon(j.nodes), glowMat);
  const core = new THREE.Mesh(buildRibbon(j.nodes), coreMat);
  core.position.z = 0.01;

  // The muzzle spill — the same additive sprite the beams use, and a sprite
  // rather than a PointLight for the reason beams.js sets out: half this game's
  // creatures are unlit MeshBasicMaterial and a real light would simply not
  // reach them.
  const spillColor = hdr(j.color, j.overdrive * (l.spillOverdriveMul ?? 0.4));
  const spillMat = new THREE.MeshBasicMaterial({
    color: spillColor, map: glowSprite(),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  });
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), spillMat);
  spill.position.z = -0.01;

  group.add(glow, core, spill);
  group.renderOrder = 5;
  scene.add(group);
  j.mesh = group;
  j.glow = glow;
  j.core = core;
  j.spill = spill;
}

// ---------------------------------------------------------------------------
// Life
// ---------------------------------------------------------------------------

/**
 * Open a stream, and leave it open.
 *
 * There is no `life`. A jet burns until `releaseJet` — which is the difference
 * between this and every other weapon in the game, and the reason the driver
 * below owns a duty cycle rather than a cooldown.
 *
 * `follow` is read every frame for the muzzle and the heading, exactly as
 * beams.js reads its own: a stream that took its origin once would hang in the
 * water where the seal used to be, and a boosting seal clears its own length in
 * a fraction of the hold.
 */
export function spawnJet(scene, opts = {}) {
  const c = cfg();
  const l = look();
  const nodes = Math.max(3, Math.round(opts.nodes ?? l.points ?? 72));
  const j = {
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    dirX: opts.dirX ?? 1,
    dirY: opts.dirY ?? 0,
    length: opts.length ?? 26,
    width: Math.max(0.05, opts.width ?? (l.width ?? 1.1)),
    damage: opts.damage ?? 9,
    // Seconds between hits ON THE SAME TARGET — the most load-bearing number
    // in any sustained weapon, and the reason beams.js repeats itself about it.
    // A stream touching a body every frame at 60Hz deals sixty times its listed
    // damage per second.
    tickEvery: Math.max(0.02, opts.tickEvery ?? (c.tickEvery ?? 0.1)),
    color: opts.color ?? (l.color ?? 0x62f2ff),
    coreColor: opts.coreColor,
    overdrive: opts.overdrive ?? (l.overdrive ?? 3.2),
    hitsEnemies: opts.hitsEnemies !== false,
    source: opts.source ?? 'bubbleJet',
    follow: opts.follow ?? null,
    // The three phases. `spool` and `vent` are seconds; the hold is however
    // long nobody has let go.
    spool: Math.max(0.001, opts.spool ?? (c.spool ?? 0.35)),
    vent: Math.max(0.001, opts.vent ?? (c.vent ?? 0.22)),
    holding: true,
    venting: 0,
    age: 0,
    nodes,
    // THE AXIS and THE PATH are two arrays on purpose. The axis is the column
    // as it would be if nothing had moved — a straight line along the current
    // aim — and the path is where the energy actually is. Keeping both means
    // "how far off straight is it right now" is a subtraction rather than a
    // reconstruction, which is what `sway` scales and what the harness asserts
    // is ZERO for a stream that is not moving.
    axis: new Float32Array(nodes * 2),
    path: new Float32Array(nodes * 2),
    // WHERE EACH NODE ACTUALLY IS relative to the axis, as a damped follower of
    // where history says it should be. This is the drag: the column does not
    // snap to its target shape, it eases toward it, so a sharp change in the
    // seal's course arrives as a swell rather than as a crease. Persistent
    // across frames — that persistence IS the smoothing.
    offset: new Float32Array(nodes * 2),
    // Per-node drag multiplier. See stirTurbulence: neighbouring nodes lag by
    // slightly different amounts, which is what turns a smooth bend into
    // something that folds and flows.
    drag: new Float32Array(nodes),
    // The unit normal at each node, computed ONCE a frame with continuity
    // enforced along the length — see layNormals. Both ribbons read it, which
    // is half the reason it exists; the other half is that a per-ribbon
    // recompute could disagree at a fold and split the core off the halo.
    norm: new Float32Array(nodes * 2),
    // Fixed at spawn so the turbulence pattern differs between streams without
    // differing between frames of one. Never Date.now().
    seed: Math.random() * 1000,
    // WHERE THE MUZZLE HAS BEEN, and which way it was pointing. See layColumn:
    // the whole shape is a read back through this. Five floats a sample —
    // t, x, y, dirX, dirY — in a ring.
    hist: new Float32Array(HIST_CAP * 5),
    histN: 0,
    histHead: 0,
    // The stream's own clock. Accumulated from dt rather than read off a wall
    // clock, so a harness stepping at a fixed rate and a browser stepping at a
    // variable one describe the same beam — and so nothing here can be one of
    // the Date.now() calls that make a run unreproducible.
    clock: 0,
    pulse: Math.random() * Math.PI * 2,
    // The turbulence's own clock. See stirTurbulence.
    stir: Math.random() * 100,
    bubbleClock: 0,
    cooldowns: new Map(),
    dead: false,
    mesh: null,
  };
  // ONE SAMPLE BEFORE ANYTHING READS THE HISTORY. A stream whose buffer is
  // empty on its first frame has nothing to interpolate between, and the tip
  // would read whatever a zeroed Float32Array says — the origin of the world.
  // It opens straight, which is also what it should look like.
  pushSample(j);
  layColumn(j, 1 / 60);
  buildMesh(scene, j);
  jets.push(j);
  // The bed is keyed on the jet itself, so two streams cannot silence each
  // other's sound — and so a stream that is torn down without being released
  // still has something to release in resetJets.
  startJetBed(j);
  return j;
}

/** Let go. The stream vents over `vent` seconds and then dies. */
export function releaseJet(j) {
  if (!j || !j.holding) return false;
  j.holding = false;
  releaseJetBed(j);
  return true;
}

/** Every stream out. A run reset, the seal dying mid-burn. */
export function resetJets(scene) {
  for (let i = jets.length - 1; i >= 0; i--) removeJet(scene, i);
  // Belt and braces: the beds are keyed on jet objects that are now gone, and a
  // LEAKED LOOPING VOICE is not a glitch, it is a sound that never stops.
  releaseAllJetBeds(0.05);
}

function removeJet(scene, i) {
  const j = jets[i];
  releaseJetBed(j, 0.05);
  if (j.mesh) {
    scene.remove(j.mesh);
    // DISPOSED, not pooled — the opposite of beams.js, and for the opposite
    // reason. Its geometry is one shared unit quad that nothing writes to, so
    // pooling its materials is what keeps a program linked between volleys.
    // Each of these owns a per-instance Float32Array of vertices that would
    // simply leak; and there is at most one jet alive, opened a handful of
    // times a run, so there is no churn here to pool against.
    j.core.geometry.dispose();
    j.glow.geometry.dispose();
    j.spill.geometry.dispose();
    j.core.material.dispose();
    j.glow.material.dispose();
    j.spill.material.dispose();
  }
  j.cooldowns.clear();
  jets.splice(i, 1);
}

// How PRESENT the stream is: up over the spool, held at 1, down over the vent.
function envelope(j) {
  const up = Math.min(1, j.age / j.spool);
  if (j.holding) return up;
  const down = 1 - j.venting / j.vent;
  return Math.max(0, Math.min(up, down));
}

// ---------------------------------------------------------------------------
// THE SHAPE — a solid column, bent by where the seal has BEEN
// ---------------------------------------------------------------------------
// THIS IS NOT A ROPE, and the first version of it was, which is exactly what
// was wrong with it. A chain of nodes chasing each other with a spacing
// constraint, carrying a free-running sine, wiggles WHILE NOTHING IS HAPPENING
// — and a beam that squirms on its own reads as slack, as something limp
// hanging off the animal. The shmup beam it is meant to be is the opposite
// object: a hard, solid column that points exactly where you are pointing, and
// whose only motion is SECONDARY — a consequence of the ship having moved.
// Stand still and it is a straight bar. Strafe and it leans. Stop strafing and
// the lean travels off the end and it is a straight bar again.
//
// So the shape is not simulated at all. It is READ BACK OUT OF HISTORY:
//
//     the energy sitting at distance `u * length` right now
//     is the energy that left the muzzle `u * travel` seconds ago,
//     and it has been going in the direction it was fired ever since.
//
//   node(u) = muzzleAt(now - u*travel) + dirAt(now - u*travel) * (u * length)
//
// One line, and every behaviour asked for falls out of it rather than being
// tuned in:
//
//   NOTHING MOVES     every sample is identical, so every node lands on the
//                     straight line. Not approximately straight — exactly, and
//                     the harness asserts exactly.
//   STEADY STRAFE     the samples walk backwards at a constant rate, so the
//                     column is straight and LEANS. Which is right: a constant
//                     velocity is not secondary motion, and a beam that
//                     wobbled under one would be back to being a rope.
//   START OR STOP     the rate of that walk changes, so the lean is different
//                     at different points up the column. THAT is the S, and it
//                     is a second derivative — it exists only while the
//                     movement is changing, which is what "secondary motion"
//                     means and why it cannot be faked with a sine.
//   TURNING           `dirAt` varies, so the column fans.
//   SETTLING          costs nothing: the history flushes on its own over
//                     `travel` seconds and the column is straight again.
//
// It is also frame-rate independent for free — history is indexed by TIME and
// interpolated, so a 30fps frame and a 144fps frame read the same beam out of
// it. The rope needed a fixed-step accumulator to get that; this needs nothing,
// and `stepHz` is gone with it.
//
// `sway` is the one dishonest number and it earns its place: 1 is the physical
// answer above, and the look wants more than physics gives at these speeds.

// How many samples of muzzle history one stream keeps. At 240fps this is a
// little over a second, which is well past any `travel` the panel allows — and
// at low frame rates it is far more than needed, which costs nothing. A ring,
// so a long burn does not grow anything.
const HIST_CAP = 256;

/** Remember where the muzzle is, and which way it points, right now. */
function pushSample(j) {
  const i = j.histHead * 5;
  j.hist[i] = j.clock;
  j.hist[i + 1] = j.x;
  j.hist[i + 2] = j.y;
  j.hist[i + 3] = j.dirX;
  j.hist[i + 4] = j.dirY;
  j.histHead = (j.histHead + 1) % HIST_CAP;
  if (j.histN < HIST_CAP) j.histN++;
}

// The sample `age` seconds ago, interpolated between the two that bracket it.
//
// INTERPOLATED, NOT NEAREST. Nearest-sample lookup quantises the column to the
// frame rate: at 30fps the nodes snap between a dozen distinct positions and
// the beam visibly stair-steps along its length while it bends. It is the
// difference between a curve and a staircase, and it is one lerp.
//
// Runs off the end of the buffer on a stream younger than `travel` — which is
// the common case for the first fraction of every burn — and clamps to the
// oldest sample there. That is correct rather than a fallback: the energy at
// the tip has not been emitted yet, so the straightest thing the stream can be
// is what it was when it opened.
const _sample = { x: 0, y: 0, dx: 1, dy: 0 };
function sampleAt(j, age) {
  const want = j.clock - age;
  const n = j.histN;
  // Newest first: k = 0 is the most recent sample, k = n-1 the oldest.
  const at = (k) => ((j.histHead - 1 - k) % HIST_CAP + HIST_CAP) % HIST_CAP;
  let prev = at(0);
  if (n === 0 || j.hist[prev * 5] <= want) {
    const i = prev * 5;
    _sample.x = j.hist[i + 1]; _sample.y = j.hist[i + 2];
    _sample.dx = j.hist[i + 3]; _sample.dy = j.hist[i + 4];
    return _sample;
  }
  for (let k = 1; k < n; k++) {
    const cur = at(k);
    const tc = j.hist[cur * 5];
    if (tc <= want) {
      const tp = j.hist[prev * 5];
      const span = tp - tc;
      const f = span > 1e-9 ? (want - tc) / span : 0;
      const a = cur * 5;
      const b = prev * 5;
      _sample.x = j.hist[a + 1] + (j.hist[b + 1] - j.hist[a + 1]) * f;
      _sample.y = j.hist[a + 2] + (j.hist[b + 2] - j.hist[a + 2]) * f;
      _sample.dx = j.hist[a + 3] + (j.hist[b + 3] - j.hist[a + 3]) * f;
      _sample.dy = j.hist[a + 4] + (j.hist[b + 4] - j.hist[a + 4]) * f;
      return _sample;
    }
    prev = cur;
  }
  const i = prev * 5;
  _sample.x = j.hist[i + 1]; _sample.y = j.hist[i + 2];
  _sample.dx = j.hist[i + 3]; _sample.dy = j.hist[i + 4];
  return _sample;
}

/**
 * Lay the column out: the straight axis into `axis`, and where the energy
 * actually is into `path`.
 *
 * `sway` scales the DIFFERENCE between the two rather than the historical
 * position itself, which is what makes 0 a rigid laser and 1 the physical
 * answer with nothing in between behaving strangely.
 *
 * `swayMax` is not a taste control. The muzzle is read live off a rig that can
 * be replaced mid-burn (the workbench swaps the seal's model), and a run reset
 * moves it to the middle of the arena — either of which puts a metre of
 * displacement into the history in one frame and would fling the column across
 * the screen. Clamped in world units, per node.
 */
// THE PER-NODE DRAG, and the reason turbulence can live here and nowhere else.
//
// A ribbon in water does not lag uniformly. Different parts of it sit in
// different water, so a bend arrives at one point before its neighbour and the
// whole thing folds rather than sweeping. That is what this is: the drag
// coefficient varies along the length and drifts over time, so no two nodes
// settle at quite the same rate.
//
// PUTTING THE TURBULENCE ON THE DRAG RATHER THAN ON THE POSITION IS THE WHOLE
// TRICK, and it is worth being explicit about why, because the obvious version
// — jitter the node positions — is the rope this file was rewritten to stop
// being. Drag decides how fast a node reaches its target. It has no say in
// WHERE the target is. So when the seal is still and every target offset is
// zero, every node still settles to exactly zero however wildly the turbulence
// is swinging: the column is dead straight and the turbulence is invisible,
// which is exactly right. It only has anything to say while the stream is
// already moving, which is the definition of secondary motion.
//
// Two sines at different spatial and temporal frequencies rather than one, for
// the reason a single sine is always wrong: one is a standing wave and reads as
// a mechanism. Cheap enough to run per node per frame — this is a couple of
// dozen sines on one object.
function stirTurbulence(j, dt) {
  const l = look();
  const amount = Math.max(0, l.dragTurbulence ?? 0.55);
  const base = Math.max(0.1, l.drag ?? 7);
  const n = j.nodes;
  if (amount <= 0) {
    for (let i = 0; i < n; i++) j.drag[i] = base;
    return;
  }
  j.stir += dt * (l.turbulenceRate ?? 1.1);
  const k1 = l.turbulenceScale ?? 0.7;
  const k2 = k1 * 2.7;
  for (let i = 0; i < n; i++) {
    const a = Math.sin(j.stir + i * k1 + j.seed);
    const b = Math.sin(j.stir * 0.61 - i * k2 + j.seed * 1.7);
    // Clamped ABOVE ZERO rather than allowed to go negative. A negative drag
    // is not "less drag" — it is a follower that runs away from its target,
    // which diverges inside a second and throws the column off the screen. The
    // floor is a fraction of the base rather than an absolute, so turning the
    // drag down does not quietly turn the turbulence into the dominant term.
    j.drag[i] = Math.max(base * 0.15, base * (1 + amount * (a * 0.65 + b * 0.35)));
  }
}

function layColumn(j, dt) {
  const l = look();
  const n = j.nodes;
  const travel = Math.max(0, l.travel ?? 0.22);
  const sway = l.sway ?? 1.35;
  const cap = Math.max(0, l.swayMax ?? 6);

  stirTurbulence(j, dt);

  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const ax = j.x + j.dirX * (u * j.length);
    const ay = j.y + j.dirY * (u * j.length);
    j.axis[i * 2] = ax;
    j.axis[i * 2 + 1] = ay;

    const s = sampleAt(j, u * travel);
    // Where that energy went after it was fired. The direction is interpolated
    // and so is no longer unit length; renormalised, or a fanned column would
    // be visibly SHORTER through the bend than along the straight.
    let dx = s.dx;
    let dy = s.dy;
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-6) { dx /= dl; dy /= dl; } else { dx = j.dirX; dy = j.dirY; }
    const hx = s.x + dx * (u * j.length);
    const hy = s.y + dy * (u * j.length);

    // THE TARGET. Clamped here rather than after the drag, so the ceiling is a
    // statement about where the column may be asked to go and not about how
    // fast it may get there — clamping the smoothed value instead would flatten
    // the top of every large swing into a plateau.
    let tx = (hx - ax) * sway;
    let ty = (hy - ay) * sway;
    const tl2 = Math.hypot(tx, ty);
    if (tl2 > cap && tl2 > 1e-9) { tx = (tx / tl2) * cap; ty = (ty / tl2) * cap; }

    // ...and the drag. `1 - exp(-rate*dt)` rather than a constant factor, so
    // the same tuning is the same curve at 30fps and at 144 — see the note in
    // the header. The per-node rate is what makes it a ribbon rather than a
    // uniformly soft version of the same shape.
    const k = 1 - Math.exp(-j.drag[i] * dt);
    const ox = j.offset[i * 2] + (tx - j.offset[i * 2]) * k;
    const oy = j.offset[i * 2 + 1] + (ty - j.offset[i * 2 + 1]) * k;
    j.offset[i * 2] = ox;
    j.offset[i * 2 + 1] = oy;

    j.path[i * 2] = ax + ox;
    j.path[i * 2 + 1] = ay + oy;
  }
  layNormals(j);
}

// ---------------------------------------------------------------------------
// THE NORMALS — computed once, and they may not break
// ---------------------------------------------------------------------------
// The ribbon is two vertices per node, offset either side of the local normal.
// Getting that normal wrong does not throw and does not look like a maths bug:
// it looks like the beam TEARING. Three ways it happens, and all three are
// handled here rather than in the two callers that used to each do their own:
//
//   COINCIDENT NEIGHBOURS   Under heavy drag adjacent nodes can land on top of
//                           each other, and the difference between them
//                           normalises to nothing. The old code fell back to
//                           the seal's AIM at that node, which is a hard
//                           discontinuity in the middle of a smooth curve — a
//                           visible pinch. Inheriting the previous node's
//                           tangent is continuous by construction.
//   A FLIPPED NORMAL        At a tight fold the neighbour difference can point
//                           back the way it came, and one node's ribbon
//                           vertices cross over its neighbour's. That is a
//                           bowtie, and on an additive material it reads as a
//                           bright X burnt into the beam. Locked by sign
//                           against the previous node.
//   A CREASE                Even a correct normal turns sharply at a fold, and
//                           a sharp turn in the normal is a visible seam. The
//                           smoothing pass below spreads it over a few nodes.
//
// Central differences, not forward: a forward difference biases every normal
// half a segment along the curve, which on a tight bend is a ribbon that
// visibly leans.
function layNormals(j) {
  const l = look();
  const n = j.nodes;
  const p = j.path;
  const out = j.norm;
  let px = j.dirX;
  let py = j.dirY;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = p[b * 2] - p[a * 2];
    let ty = p[b * 2 + 1] - p[a * 2 + 1];
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-6) {
      tx /= tl;
      ty /= tl;
      // Sign-locked to the node before it. Without this a fold flips the
      // tangent and the ribbon crosses itself.
      if (tx * px + ty * py < 0) { tx = -tx; ty = -ty; }
    } else {
      // Degenerate: inherit rather than reach for the aim. Continuous.
      tx = px;
      ty = py;
    }
    px = tx;
    py = ty;
    out[i * 2] = -ty;
    out[i * 2 + 1] = tx;
  }

  // THE SMOOTHING PASS. A box blur along the ribbon, renormalised — this is
  // what takes the crease out of a fold, and it is the cheapest part of "make
  // it smoother" by a distance.
  //
  // NOT APPLIED TO THE ENDS. Node 0's normal is what welds the ribbon to the
  // seal's mouth and the last node's is the tip; blurring either drags it
  // toward its inboard neighbour and the beam visibly detaches at the muzzle.
  const passes = Math.max(0, Math.round(l.normalSmooth ?? 2));
  for (let s = 0; s < passes; s++) {
    let prevX = out[0];
    let prevY = out[1];
    for (let i = 1; i < n - 1; i++) {
      const cx = out[i * 2];
      const cy = out[i * 2 + 1];
      let nx = prevX + cx * 2 + out[(i + 1) * 2];
      let ny = prevY + cy * 2 + out[(i + 1) * 2 + 1];
      const nl = Math.hypot(nx, ny);
      // A blur can cancel to nothing where two normals are opposed. Keep the
      // node's own rather than writing a zero-length normal, which would
      // collapse the ribbon to a line at exactly the fold this pass exists to
      // tidy up.
      if (nl > 1e-6) { nx /= nl; ny /= nl; } else { nx = cx; ny = cy; }
      prevX = cx;
      prevY = cy;
      out[i * 2] = nx;
      out[i * 2 + 1] = ny;
    }
  }
}

// How far off the straight axis the column is, at its worst. Reported to the F
// panel so the sway can be judged against a number rather than by eye alone,
// and asserted by the harness — "it is straight when nothing is happening" is
// the whole brief and is otherwise unfalsifiable.
export function jetBend(j) {
  let worst = 0;
  for (let i = 0; i < j.nodes; i++) {
    worst = Math.max(worst, Math.hypot(
      j.path[i * 2] - j.axis[i * 2],
      j.path[i * 2 + 1] - j.axis[i * 2 + 1],
    ));
  }
  return worst;
}

// The half-width at `u` along the stream.
//
// A COLUMN, NOT A CONE. It holds its full width down almost the whole length
// and only rounds off at the very end. A long taper is what a spray does, and a
// sprayed beam reads as weak however bright it is — the thing that makes a
// shmup beam look like it would cut a hole in something is that it is the SAME
// THICKNESS at the far end as at the muzzle. `columnFrom` and `columnTip`
// rather than the old `tipFrom`/`tipWidth`: renamed because a saved tuning
// value outranks a config default, so re-defaulting the old pair would have
// left the cone in place in anyone's snapshot. Same reason `muzzleNudge`
// replaced `muzzleOffset` in aimRig.js.
//
// THE PULSE IS THE ONLY THING THAT MOVES ON ITS OWN, and it moves the WIDTH,
// never the position. That distinction is the whole correction: a travelling
// swell reads as energy flowing up a solid bar, and the identical amount of
// travelling SIDEWAYS motion reads as a rope. Small by default — it is texture,
// not shape.
function halfWidthAt(j, u, env) {
  const l = look();
  const head = Math.min(1, u / Math.max(0.001, l.muzzleFade ?? 0.04));
  const from = l.columnFrom ?? 0.88;
  const tipW = l.columnTip ?? 0.62;
  const tip = 1 - Math.max(0, (u - from) / Math.max(0.001, 1 - from)) * (1 - tipW);
  const pulse = 1 + (l.pulseAmount ?? 0.12)
    * Math.sin(j.pulse - u * (l.pulseLength ?? 5.5));
  return j.width * 0.5 * head * Math.max(0, tip) * pulse * (0.35 + 0.65 * env);
}

// Both ribbons, from the SAME normals — see layNormals. They used to each
// derive their own from the path, which was two copies of the same fragile
// arithmetic and one more place for the core and the halo to disagree about
// where a fold is.
function writeRibbon(mesh, j, env, widthMul) {
  const pos = mesh.geometry.attributes.position;
  const arr = pos.array;
  const n = j.nodes;
  const p = j.path;
  for (let i = 0; i < n; i++) {
    const w = halfWidthAt(j, i / (n - 1), env) * widthMul;
    const nx = j.norm[i * 2] * w;
    const ny = j.norm[i * 2 + 1] * w;
    const o = i * 6;
    arr[o] = p[i * 2] + nx;      arr[o + 1] = p[i * 2 + 1] + ny;      arr[o + 2] = 0;
    arr[o + 3] = p[i * 2] - nx;  arr[o + 4] = p[i * 2 + 1] - ny;      arr[o + 5] = 0;
  }
  pos.needsUpdate = true;
}

// Distance from a point to the POLYLINE — every span, not the straight axis.
// See the note at the top: the wiggle is in here or the stream lies about what
// it cuts.
function distanceToJet(j, px, py) {
  const n = j.nodes;
  const p = j.path;
  let best = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = p[i * 2], ay = p[i * 2 + 1];
    const bx = p[(i + 1) * 2], by = p[(i + 1) * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t, cy = ay + dy * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

// The bubbles. Emitted ALONG the stream at random positions rather than at the
// muzzle, which is the difference between "a jet of bubbles" and "a beam with a
// puff at one end". Thrown sideways off the local perpendicular so they peel
// away from the stream instead of racing it.
function spitBubbles(j, dt, env) {
  const l = look();
  const name = l.bubbleEmitter ?? 'blastBubbles';
  const rate = (l.bubblesPerSecond ?? 26) * env;
  if (!(rate > 0) || !CONFIG.emitters?.[name]) return;
  j.bubbleClock += dt * rate;
  let n = Math.floor(j.bubbleClock);
  if (n <= 0) return;
  // A hard ceiling per frame. A long stall — a tab coming back, a model
  // loading — hands this a `dt` of several seconds, and without the clamp that
  // is one frame emitting a thousand particles, which is a visible hitch caused
  // entirely by the recovery from a different hitch.
  n = Math.min(n, l.bubblesPerFrameMax ?? 6);
  j.bubbleClock -= n;
  const nodes = j.nodes;
  for (let i = 0; i < n; i++) {
    const idx = Math.min(nodes - 2, Math.floor(Math.random() * (nodes - 1)));
    const x = j.path[idx * 2];
    const y = j.path[idx * 2 + 1];
    let tx = j.path[(idx + 1) * 2] - x;
    let ty = j.path[(idx + 1) * 2 + 1] - y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const side = Math.random() < 0.5 ? 1 : -1;
    emit(name, x, y, {
      dirX: -ty * side, dirY: tx * side,
      scale: l.bubbleScale ?? 0.25,
      speedMul: l.bubbleSpeed ?? 0.7,
    });
  }
}

/**
 * One frame of every live stream.
 *
 * @param ctx { enemies, hooks } — the same hook shape beams.js takes, so a jet
 *        hit goes through the same impact flash, ledger and death accounting as
 *        every other source of damage rather than being a second, quieter one.
 */
export function updateJets(dt, scene, ctx = {}) {
  // Recorded ABOVE the empty guard, and that ordering is the whole reason this
  // line exists. The F panel's Hold button needs a scene to open a stream into
  // and this is the only place one is ever handed in — behind the guard it
  // would only ever be set while a stream was ALREADY burning, so the panel
  // could open one exactly when it did not need to.
  if (scene) _scene = scene;
  if (!jets.length) return;
  const hooks = ctx.hooks ?? {};
  const l = look();
  let lit = 0;

  for (let i = jets.length - 1; i >= 0; i--) {
    const j = jets[i];
    j.age += dt;
    if (!j.holding) j.venting += dt;
    if (j.dead || (!j.holding && j.venting >= j.vent)) {
      removeJet(scene, i);
      continue;
    }

    // Re-read BEFORE anything is measured or drawn, for the reason beams.js
    // gives: reading it after would cut along last frame's stream and draw this
    // frame's, which on a fast turn visibly misses what it kills.
    if (j.follow) {
      const at = j.follow(j);
      if (at) {
        j.x = at.x ?? j.x;
        j.y = at.y ?? j.y;
        j.dirX = at.dirX ?? j.dirX;
        j.dirY = at.dirY ?? j.dirY;
        if (at.length != null) j.length = at.length;
        if (at.damage != null) j.damage = at.damage;
        if (at.width != null) j.width = Math.max(0.05, at.width);
      }
    }
    const dl = Math.hypot(j.dirX, j.dirY) || 1;
    j.dirX /= dl;
    j.dirY /= dl;

    const env = envelope(j);
    // THE COLUMN IS READ, NOT STEPPED. See the header above layColumn: the
    // shape is a lookup back through the muzzle's own history, indexed by TIME
    // and interpolated, so a 30fps frame and a 144fps frame describe the same
    // beam with no fixed-step accumulator anywhere. The rope this replaced
    // needed one; that whole mechanism is gone.
    //
    // Sampled BEFORE the column is laid, so the node at u=0 reads this frame's
    // muzzle rather than last frame's — the stream must stay welded to the seal
    // on the frame it moves, not the frame after.
    j.clock += dt;
    j.pulse += dt * (l.pulseRate ?? 9);
    pushSample(j);
    layColumn(j, dt);
    lit = Math.max(lit, env);

    // --- draw --------------------------------------------------------------
    writeRibbon(j.core, j, env, l.coreWidthMul ?? 0.34);
    writeRibbon(j.glow, j, env, l.glowWidthMul ?? 1);
    j.core.material.opacity = Math.min(1, (l.coreOpacity ?? 0.95) * env);
    j.glow.material.opacity = Math.min(1, (l.glowOpacity ?? 0.5) * env);

    // The spill sits at the muzzle in WORLD space. The group is never rotated
    // here — unlike a beam's, whose whole mesh is turned to the beam's angle —
    // so this is a plain position and needs no counter-rotation.
    const spillSize = j.width * (l.spillSize ?? 5) * (0.5 + 0.5 * env);
    j.spill.position.set(j.x, j.y, -0.01);
    j.spill.scale.set(spillSize, spillSize, 1);
    j.spill.material.opacity = Math.min(1, (l.spillStrength ?? 0.75) * env);

    spitBubbles(j, dt, env);

    // --- cut ---------------------------------------------------------------
    // Only once it is up. A stream that damaged through its own spool would hit
    // before it was visible — the one thing a telegraphed weapon must not do,
    // and the reason the spool is a real windup rather than a fade.
    if (env < (cfg().armAt ?? 0.85)) continue;

    for (const [target, left] of j.cooldowns) {
      const next = left - dt;
      if (next <= 0) j.cooldowns.delete(target);
      else j.cooldowns.set(target, next);
    }

    if (j.hitsEnemies && ctx.enemies) {
      for (const e of ctx.enemies) {
        if (!e || e.hp <= 0 || e.invuln > 0 || j.cooldowns.has(e)) continue;
        // Enemies have no x/y of their own — position is e.mesh.position, and
        // reading e.x here would compare against undefined and quietly never
        // hit anything.
        const ex = e.mesh.position.x;
        const ey = e.mesh.position.y;
        if (distanceToJet(j, ex, ey) > j.width * 0.5 + (e.radius ?? 0.5)) continue;
        j.cooldowns.set(e, j.tickEvery);
        e.hp -= j.damage;
        // The source goes LAST, which is the shape every other damage hook in
        // the game has. It was third in an early version of beams.js and the
        // slot main.js reads as the hit's x coordinate, so every laser hit
        // placed its flash at x = 'laserEyes'. Nothing throws.
        hooks.onEnemyDamaged?.(
          e, j.damage, ex, ey, { x: j.dirX, y: j.dirY }, null, null, j.source,
        );
        // THE BODY LIGHTS UP WHILE IT IS BEING CUT. Not the same thing as the
        // hit's feedback event above and not replaceable by it: `jetCut` is a
        // moment, fired ten times a second per body, and ten flashes a second
        // is a strobe the player stops seeing inside a second. The burn is a
        // STATE that climbs while contact is held and falls off when it stops,
        // which is the only vocabulary damage-over-time has. See
        // systems/burnGlow.js.
        sear(e);
        feedback('jetCut', { x: ex, y: ey });
        hooks.onCut?.(ex, ey);
        // LET THE BODY GO ON THE FRAME IT DIES, not on the next sweep.
        // systems/bossLight.js attaches its kill light to the same root and
        // gets the SAME per-instance materials back, so one frame of overlap is
        // two systems writing one material with last-write-wins deciding which
        // is visible — a flicker on the first frame of every boss death, which
        // is the single most looked-at frame in the game.
        if (e.hp <= 0) { releaseBurn(e); hooks.onEnemyKilled?.(e); }
      }
    }
  }

  // A FLOOR under the bloom pulse rather than a set, exactly as beams.js does
  // it: the per-cut spikes have to still punch above the sustain, and an
  // assignment would flatten every one of them into it.
  if (lit > 0) {
    const floor = lit * (cfg().sustainGlow ?? 0.45);
    if (feedbackState.glowPulse < floor) feedbackState.glowPulse = floor;
  }
}

// ---------------------------------------------------------------------------
// THE PLAYER'S OWN, and its duty cycle
// ---------------------------------------------------------------------------
// The upgrade is not "hold a button" — this game has no fire button, every
// weapon is automatic, and a stream you could hold forever is a damage aura
// with a shape. So the seal runs a cycle: SPOOL, HOLD for `holdTime`, VENT,
// COOL for `coolTime`. Levelling lengthens the hold and shortens the cool,
// which is the lever that makes a high stack feel like the thing is barely off
// rather than like it fires more often.

const state = {
  cooldown: 0,
  held: 0,
  jet: null,
};

/** Everything level `n` is worth, in one place so the card and the water agree. */
export function jetStats(level = 0) {
  const L = bubbleJetLevelStats(level, playerStats());
  return {
    damage: L.jetDamage,
    reach: L.jetReach,
    hold: L.jetHold,
    cool: L.jetCool,
    width: L.jetWidth,
  };
}

// The stat block, injected rather than imported. entities/player.js is not this
// module's business and importing it would drag the whole entity graph into
// any harness that wants to test the shape of a ribbon.
let statsRef = null;
export function setJetStats(s) { statsRef = s ?? null; }
function playerStats() { return statsRef ?? {}; }

/**
 * One frame of the seal's own jet.
 *
 * @param aim normalised direction the seal is looking. May be zero-length.
 * @param rig the aim rig, for the mouth anchor. Null on a model without one,
 *            which falls back to a forward offset from the body centre.
 */
export function updateBubbleJet(dt, scene, playerPos, level, aim, muzzle = null) {
  if (!(level > 0)) {
    // The card can be lost between runs, and a stream still burning when the
    // level goes to zero would burn forever.
    if (state.jet) { releaseJet(state.jet); state.jet = null; }
    return;
  }
  const s = jetStats(level);

  // The live aim, kept module-level so the follow closure below reads a
  // function rather than capturing a Vector main.js is free to recycle.
  const ax = aim?.x ?? 0;
  const ay = aim?.y ?? 0;
  const al = Math.hypot(ax, ay);
  if (al > 1e-4) { _aim.x = ax / al; _aim.y = ay / al; }
  _muzzle = muzzle;
  _pos = playerPos;

  if (state.jet) {
    state.held += dt;
    if (state.held >= s.hold) {
      releaseJet(state.jet);
      state.jet = null;
      state.cooldown = s.cool;
    }
    return;
  }

  state.cooldown -= dt;
  if (state.cooldown > 0) return;
  state.held = 0;
  const o = originNow();
  state.jet = spawnJet(scene, {
    x: o.x, y: o.y, dirX: _aim.x, dirY: _aim.y,
    length: s.reach,
    width: s.width,
    damage: s.damage,
    source: 'bubbleJet',
    // Re-read every frame: the muzzle, the heading, AND the level's numbers.
    // The last of those matters because a stream can be open across a level-up
    // — the run clock does not stop for the cards on every path — and a stream
    // still promising the old damage for the rest of its hold is a card that
    // visibly does nothing until the next cycle.
    follow: () => {
      const p = originNow();
      const live = jetStats(statLevel());
      return {
        x: p.x, y: p.y, dirX: _aim.x, dirY: _aim.y,
        length: live.reach, damage: live.damage, width: live.width,
      };
    },
  });
  feedback('jetSpool', { x: o.x, y: o.y });
}

const _aim = { x: 1, y: 0 };
let _muzzle = null;
let _pos = null;

function statLevel() {
  return playerStats().bubbleJetLevel ?? 0;
}

// WHERE THE STREAM LEAVES THE SEAL. The mouth anchor if the model has one —
// this is a jet out of the animal's face, and a stream starting at the body
// centre reads as coming out of its chest. The forward offset is the fallback
// for a model with no rig, which is every model swapped in through the
// workbench.
const _origin = { x: 0, y: 0 };
function originNow() {
  const c = cfg();
  if (_muzzle) {
    _origin.x = _muzzle.x;
    _origin.y = _muzzle.y;
  } else {
    const fwd = c.muzzleForward ?? 0.9;
    _origin.x = (_pos?.x ?? 0) + _aim.x * fwd;
    _origin.y = (_pos?.y ?? 0) + _aim.y * fwd;
  }
  return _origin;
}

/** A new run starts with the jet cold. */
export function resetBubbleJet(scene) {
  state.cooldown = 0;
  state.held = 0;
  state.jet = null;
  _muzzle = null;
  _pos = null;
  if (scene) resetJets(scene);
}

/** What the driver is doing. For the harness and the F panel's readout. */
export function bubbleJetState() {
  return {
    open: !!state.jet,
    held: state.held,
    cooldown: state.cooldown,
    jets: jets.length,
  };
}

// ---------------------------------------------------------------------------
// THE STAGED STREAM — the F panel's own
// ---------------------------------------------------------------------------
// Held open by hand, at the seal, so the wave and the bed can be judged for as
// long as it takes rather than in the second the duty cycle allows. NOT a
// preview: it is the same spawnJet, the same ribbon, the same bed and the same
// bloom, which is the whole argument systems/stage.js makes for why a separate
// preview scene would be easier and wrong.
//
// It does no damage. `hitsEnemies: false` because the panel is open over a
// parked arena and a stream quietly killing the thing you are judging it
// against is a tuning session that changes what it is measuring.
let staged = null;

/** Is the panel holding one open? */
export function stagedJetOpen() {
  return !!staged && jets.includes(staged);
}

/**
 * Open one at `at`, pointed along `dir`. Re-calling while one is open is a
 * no-op rather than a restart — the same rule startJetBed follows, and for the
 * same reason: re-triggering a held thing is not holding it.
 */
export function stageJet(at, dir) {
  if (stagedJetOpen()) return staged;
  if (!_scene) return null;
  staged = null;
  const level = Math.max(1, statLevel());
  const s = jetStats(level);
  const ax = dir?.x ?? 1;
  const ay = dir?.y ?? 0;
  const l = Math.hypot(ax, ay) || 1;
  staged = spawnJet(_scene, {
    x: at?.x ?? 0, y: at?.y ?? 0, dirX: ax / l, dirY: ay / l,
    length: s.reach, width: s.width, damage: 0,
    hitsEnemies: false,
    source: 'bubbleJetStaged',
  });
  return staged;
}

/** Let the panel's stream go. */
export function stopStagedJet() {
  if (!staged) return false;
  const ok = releaseJet(staged);
  staged = null;
  return ok;
}
