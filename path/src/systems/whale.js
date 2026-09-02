import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { createVisual, morphControl } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { pickups, bitePickup } from '../entities/pickups.js';
import { createAnimationController } from './animation.js';
import { isBossDef } from './boss.js';

// ============================================================================
// THE BOWHEAD SWEEP — a whale that crosses the arena and takes the small stuff
// out of the water. See CONFIG.whale for the design and spawning.csv for the
// numbers.
//
// It is a PRESSURE VALVE, not an enemy and not an ability. A late run puts up
// to `spawn.maxAlive` (220) bodies on screen and the schools are most of them;
// past a certain density the fight stops being readable and the frame cost is
// going on creatures nobody can pick out. The sweep arrives, clears a corridor,
// and leaves.
//
// WHY IT IS NOT BUILT ON entities/enemies.js, which is the obvious home for
// something creature-shaped. Every enemy in that file is a body with hp that
// steers at the player and can be killed; this has none of those. It cannot be
// damaged, it never targets anything, it deals no damage, and it must be
// exempt from `spawn.maxAlive` — the whole point is that it shows up when the
// cap is the problem. Fitting it in would mean a special case in the spawn
// budget, in the damage path, in the steering table and in the kill path, to
// reuse a struct it would use none of. systems/seagull.js made the same call
// for the same reason and is the closest cousin in the codebase.
//
// WHAT IT EATS, AND WHAT THAT COSTS THE PLAYER. Enemies at or under
// `maxPreyRadius`, and uncollected xp orbs, both inside `mouthRadius` of the
// jaw. Neither pays anything: a swallowed creature drops no chum and a
// swallowed orb is gone. That is deliberate and it is the only tension the
// event has — hearing one coming is a reason to go and collect the seabed NOW.
// Crediting the player would make the sweep pure upside and there would be
// nothing to react to.
//
// It deliberately does NOT eat chum chunks (entities/pickups.js `chumChunks`).
// Those are the one-per-fight rescue and a run's only real heal; a housekeeping
// event that can delete the thing keeping you alive is a different, much
// crueller feature than the one asked for.
//
// THE CLOCK IS SPLIT OUT of the crossing, in `whaleClock`, with its RNG
// injected. Cadence is the part worth simulating over a whole run — "can two
// sweeps land inside ten seconds", "does a crowded screen actually pull the
// next one in" — and that is a question about minutes, which a test can only
// ask cheaply if it can run the clock without a scene. Same split, and the same
// reason, as systems/chumChunkSpawner.js.
// ============================================================================

const DEG = Math.PI / 180;

const whales = [];

// Scratch, so the per-frame work allocates nothing.
const _mouth = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _vert = new THREE.Vector3();
const _imp = new THREE.Vector3();

// ---------------------------------------------------------------------------
// THE SILHOUETTE
// ---------------------------------------------------------------------------
// A bowhead is a head, a barrel and a stalk with a flat fluke on the end, and
// the one shape it is NOT is a cylinder. The first version tested contact
// against a constant-radius capsule — half the smallest of the model's three
// extents, centred on the container — and it is wrong three ways, all of them
// measured off the shipped mesh (source units; x12 fit x 2.6 size to reach
// world):
//
//   TOO FAT ALONG THE LENGTH, and this is the one you feel. The capsule's
//   half-height is 31.3 for the whole animal, against a real half-height of
//   22.9 through the barrel, 6.1 at the tail stock and 0.9 at the fluke. So
//   the seal was being thrown by open water — a body's width of it either
//   side of a tail thirty times thinner than the tube drawn round it, over
//   the part of the animal it spends the crossing swimming past.
//
//   OFF-CENTRE. The whale's axis does not run through its container origin:
//   the barrel spans -29.9..16.0 about it, so a capsule symmetric about zero
//   sits about 7 units below the animal it is standing in for.
//
//   AND THE AXIS WAS PICKED BY LUCK. `min` of the three extents lands on the
//   height (62.6) only because it happens to be a hair under the lateral
//   width (64.3) — 3% apart on this export. Anything that widens the body or
//   narrows the pectorals silently swaps the hitbox onto the axis pointing
//   into the screen, which is the one nobody can see, with nothing failing.
//
// So the body is a PROFILE — a half-height sampled at intervals along the
// animal's own axis, measured off the mesh that ships. Everything that asks
// "is this point on the whale" goes through `bodyDistance` and gets the same
// answer, which is the same rule the shove and the ram already share.
//
// MEASURED FROM THE TRIANGLES, NOT THE VERTICES. This model is 2812 triangles
// over 180 source units, so binning vertex positions alone leaves whole bins
// EMPTY — three of twenty-four on the shipped mesh, straddling the widest part
// of the body, because a long triangle contributes nothing between its corners.
// An empty bin reads as zero half-height, i.e. a hole in the animal you can
// swim through, and it looks exactly like a correct taper. Each edge is walked
// at bin resolution instead, so every bin the surface crosses is filled.
const PROFILE_BINS = 24;

/**
 * The silhouette of `object` as a cross-section profile along entity +Y.
 *
 * IN THE OBJECT'S OWN PARENT FRAME, whatever that frame is currently doing.
 * `createVisual` hands back a visual already turned so `forward` is entity +Y
 * and the model's up is entity ±X (see orientationQuaternion in assets.js), and
 * entity X is what the camera reads as the animal's height in both views — so
 * the profile has to be measured in the frame the visual SITS in, not in world
 * space. Taking world coordinates instead would work at spawn, where the
 * container has not been rotated yet, and would quietly return the profile of a
 * whale standing on its tail anywhere else: `npm run looks:whale` lays the body
 * along its heading before it draws anything.
 *
 * THE BIND POSE, and on purpose. A SkinnedMesh's position attribute is the rest
 * shape — the skinning that bends this animal into its stroke happens on the
 * GPU and never writes back — so this is the animal straight, whatever the wag
 * is doing when it is called. Which is what a hitbox should be: the fluke
 * sweeps 5.6 world units over a cycle, and a body you can be shoved by only on
 * the half of the stroke it happens to be on is a contact that fires at random.
 * The cost is that the far tail of the outline `npm run looks:whale` draws will
 * not sit on a mid-stroke fluke — visible on that page, and 0.16 world units of
 * half-height either way.
 *
 * THE BIND POSE, and on purpose. A SkinnedMesh's position attribute is the rest
 * shape — the skinning that bends this animal into its stroke happens on the GPU
 * and never writes back — so this is the animal straight, whatever the wag is
 * doing when it is called. Which is what a hitbox should be: the fluke sweeps
 * 5.6 world units over one cycle, and a body you can be shoved by only on the
 * half of the stroke it happens to be on is a contact that fires at random. The
 * cost is that the tail end of the outline `npm run looks:whale` draws does not
 * sit on a mid-stroke fluke — visible on that page, and 0.16 world units of
 * half-height either way.
 *
 * Exported so that page and `npm run test:whale` can run it over the real glb —
 * the Node harness gets a primitive stand-in from createVisual, so a profile
 * measured only there would be testing a cone.
 */
export function measureBodyProfile(object, bins = PROFILE_BINS) {
  const parent = object.parent ?? null;
  (parent ?? object).updateMatrixWorld(true);
  const toParent = parent ? new THREE.Matrix4().copy(parent.matrixWorld).invert() : null;

  // One transformed copy of every mesh, because the axis range has to be known
  // before anything can be binned along it and re-reading a skinned attribute
  // twice is the more expensive half of this.
  const parts = [];
  let minS = Infinity;
  let maxS = -Infinity;
  object.traverse((o) => {
    const pos = o.isMesh && o.geometry?.attributes?.position;
    if (!pos) return;
    const xs = new Float64Array(pos.count);
    const ys = new Float64Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      _vert.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (toParent) _vert.applyMatrix4(toParent);
      xs[i] = _vert.x;
      ys[i] = _vert.y;
      if (_vert.y < minS) minS = _vert.y;
      if (_vert.y > maxS) maxS = _vert.y;
    }
    parts.push({ xs, ys, idx: o.geometry.index });
  });

  const span = maxS - minS;
  if (!parts.length || !(span > 0) || bins < 2) return null;

  const n = bins | 0;
  const lo = new Float32Array(n).fill(Infinity);
  const hi = new Float32Array(n).fill(-Infinity);
  const invStep = n / span;

  const add = (s, a) => {
    let b = Math.floor((s - minS) * invStep);
    if (b < 0) b = 0; else if (b >= n) b = n - 1;
    if (a < lo[b]) lo[b] = a;
    if (a > hi[b]) hi[b] = a;
  };
  // Walk the segment at bin resolution. Capped, so a single degenerate triangle
  // spanning the whole animal costs a bounded number of samples rather than
  // however many its length asks for.
  const walk = (s0, a0, s1, a1) => {
    const steps = Math.min(64, Math.max(1, Math.ceil(Math.abs(s1 - s0) * invStep)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      add(s0 + (s1 - s0) * t, a0 + (a1 - a0) * t);
    }
  };

  for (const { xs, ys, idx } of parts) {
    const count = idx ? idx.count : xs.length;
    for (let i = 0; i + 2 < count; i += 3) {
      const a = idx ? idx.getX(i) : i;
      const b = idx ? idx.getX(i + 1) : i + 1;
      const c = idx ? idx.getX(i + 2) : i + 2;
      walk(ys[a], xs[a], ys[b], xs[b]);
      walk(ys[b], xs[b], ys[c], xs[c]);
      walk(ys[c], xs[c], ys[a], xs[a]);
    }
  }

  // A bin nothing reached at all is a hole, and a hole reads as a gap in the
  // animal rather than as an error. Bridged from its neighbours; if the whole
  // profile is empty there was no geometry and the caller falls back to the
  // plain capsule.
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) if (lo[i] <= hi[i]) { if (first < 0) first = i; last = i; }
  if (first < 0) return null;
  for (let i = 0; i < first; i++) { lo[i] = lo[first]; hi[i] = hi[first]; }
  for (let i = last + 1; i < n; i++) { lo[i] = lo[last]; hi[i] = hi[last]; }
  for (let i = first + 1; i < last; i++) {
    if (lo[i] <= hi[i]) continue;
    let j = i + 1;
    while (j < last && lo[j] > hi[j]) j++;
    for (let k = i; k < j; k++) {
      const t = (k - i + 1) / (j - i + 1);
      lo[k] = lo[i - 1] + (lo[j] - lo[i - 1]) * t;
      hi[k] = hi[i - 1] + (hi[j] - hi[i - 1]) * t;
    }
    i = j - 1;
  }

  let thickest = 0;
  for (let i = 0; i < n; i++) thickest = Math.max(thickest, (hi[i] - lo[i]) * 0.5);
  return { n, minS, maxS, step: span / n, lo, hi, thickest };
}

/**
 * The body's cross-section at `s` along the axis, as a centre and a half-height.
 *
 * Interpolated between bin CENTRES rather than read off the bin the point lands
 * in: a step function here is a hitbox that changes size in jumps as the animal
 * slides past, which at a 31-unit body is a shove that fires and stops firing
 * without the seal moving. Beyond the outermost centres it holds the end bin,
 * so the profile overstates the very tip by at most half a bin — the resolution
 * of the whole measurement, and on the safe side of it.
 */
export function sectionAt(p, s, out = { mid: 0, half: 0 }) {
  const f = (s - p.minS) / p.step - 0.5;
  let i = Math.floor(f);
  let t = f - i;
  if (i < 0) { i = 0; t = 0; } else if (i >= p.n - 1) { i = p.n - 2; t = 1; }
  const lo = p.lo[i] + (p.lo[i + 1] - p.lo[i]) * t;
  const hi = p.hi[i] + (p.hi[i + 1] - p.hi[i]) * t;
  out.mid = (lo + hi) * 0.5;
  out.half = (hi - lo) * 0.5;
  return out;
}

const _section = { mid: 0, half: 0 };

/**
 * How far (x, y) is from that whale's body — 0 anywhere on it.
 *
 * THE ONE SHAPE. The shove, the ram and every "is there a whale near me"
 * question in the game come through here, so there is no way for the body you
 * can be pushed by to be a different body from the one you can push (see the
 * crab's claw, which had exactly that pair drift apart in silence).
 *
 * The point is taken into the animal's own frame first, so the profile answers
 * about the body as DRAWN — banked, and mirrored the way the side view mirrors
 * it. A world-axis-aligned test was close enough while the body was a cylinder
 * and stops being so the moment the shape has a top and a bottom that differ,
 * which this one does at both ends of the animal: through the barrel it stands
 * 29.6 above its own origin and hangs 15.8 below, and where the pectorals are
 * it hangs 32.4.
 */
export function bodyDistance(w, x, y) {
  const dx = x - w.container.position.x;
  const dy = y - w.container.position.y;
  const th = w.container.rotation.z;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const along = -sn * dx + cs * dy; // entity +Y — the direction of travel
  const across = (w.flip ? -1 : 1) * (cs * dx + sn * dy); // entity +X — its height on screen

  const p = w.profile;
  if (!p) {
    // No mesh to measure. The plain capsule, which is what this was before.
    const half = w.length * 0.5;
    const gap = Math.max(0, Math.abs(along) - half);
    return Math.hypot(gap, Math.max(0, Math.abs(across) - w.bodyRadius));
  }
  const s = Math.min(p.maxS, Math.max(p.minS, along));
  const sec = sectionAt(p, s, _section);
  return Math.hypot(Math.abs(along - s), Math.max(0, Math.abs(across - sec.mid) - sec.half));
}

export function whaleCount() {
  return whales.length;
}

/**
 * How far the closest whale's body is from (x, y), or Infinity when there is
 * none in the water.
 *
 * The distance and not a boolean, because the caller's threshold is not this
 * file's business — the one asking today is the first-run coach, which wants
 * "close enough that the player can SEE it" and owns that number in
 * CONFIG.tutorial.
 *
 * Measured to the BODY, not to the container's origin. A bowhead is tens of
 * units long and swims flat, so its centre can be most of a screen away while
 * its flank fills the frame — a plain centre distance would report "nothing
 * near you" about a whale the seal is currently swimming alongside.
 */
export function whaleDistance(x, y) {
  let best = Infinity;
  for (const w of whales) best = Math.min(best, bodyDistance(w, x, y));
  return best;
}

/**
 * The nearest whale to (x, y) as the whale itself, for something that wants to
 * hold onto it across frames — the first-run "some creatures should not be
 * attacked" tip stands beside one until it leaves.
 *
 * A REFERENCE AND NOT A POSITION, unlike whaleDistance above: a whale is a
 * hundred units long and takes the best part of a minute to cross the arena, so
 * a tip re-asking "the nearest one" every frame would hop between two of them
 * mid-sentence. Hollow while none is up, which is most of a run.
 */
export function nearestWhale(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const w of whales) {
    const d = Math.hypot(w.container.position.x - x, w.container.position.y - y);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

/** Is that exact whale still in the water? */
export function whaleAlive(w) {
  return !!w && whales.indexOf(w) !== -1;
}

// ---------------------------------------------------------------------------
// THE CLOCK
// ---------------------------------------------------------------------------

export const whaleClock = {
  timer: 0, // seconds until the next sweep may be called
  elapsed: 0, // seconds of run so far, against CONFIG.whale.firstAt
  sweeps: 0, // how many have been called this run
};

function between(rand, lo, hi) {
  return lo + rand() * (hi - lo);
}

/** Start of a run. */
export function resetWhaleClock(rand = Math.random) {
  const c = CONFIG.whale ?? {};
  whaleClock.elapsed = 0;
  whaleClock.sweeps = 0;
  // The first gap is rolled like any other, and `firstAt` gates on top of it
  // rather than replacing it — so the opening sweep is not pinned to the same
  // second of every run.
  whaleClock.timer = between(rand, c.intervalMin ?? 60, c.intervalMax ?? 90);
}

/**
 * Advance the cadence and say whether a sweep should be called now.
 *
 * @param dt         seconds
 * @param population live enemy count, for the crowd rush
 * @param rand       injected for the tests
 * @returns true exactly on the frames a sweep starts
 */
export function updateWhaleClock(dt, population = 0, rand = Math.random) {
  const c = CONFIG.whale ?? {};
  if (!c.enabled) return false;
  whaleClock.elapsed += dt;

  // ALREADY BUSY. Held at zero rather than counted down, exactly like the
  // opening gate below, so a sweep in progress cannot bank credit and send a
  // second animal the instant the first leaves.
  //
  // This is load-bearing rather than tidy. One crossing is 231 world units at
  // `speed` — the full arena plus both margins — which at the shipped 8 u/s is
  // most of half a minute, and the crowded interval is shorter than that. With
  // no cap a busy screen simply fills with whales, which is the opposite of a
  // spawn-pressure valve.
  if (whales.length >= (c.maxAlive ?? 1)) {
    whaleClock.timer = Math.max(whaleClock.timer, 0);
    return false;
  }

  // A CROWDED SCREEN SPENDS THE CLOCK FASTER, rather than shortening the gap
  // that was already rolled. Rewriting `timer` on the frame the population
  // crosses the threshold would make the sweep arrive at a time that depends on
  // when in its own countdown the crowd happened to form; burning the clock at
  // a multiple is continuous, so a screen that is busy for half the interval
  // gets half the discount and one that is busy throughout gets all of it.
  const crowded = population > (c.crowdThreshold ?? Infinity);
  const rate = crowded ? 1 / Math.max(0.01, c.crowdRush ?? 1) : 1;
  whaleClock.timer -= dt * rate;

  if (whaleClock.timer > 0) return false;
  // Under the opening gate the clock is HELD at zero rather than left to run
  // negative, or a run would bank credit through the whole early game and fire
  // a sweep the instant it became legal — every time, at exactly `firstAt`.
  if (whaleClock.elapsed < (c.firstAt ?? 0)) {
    whaleClock.timer = 0;
    return false;
  }
  whaleClock.timer = between(rand, c.intervalMin ?? 60, c.intervalMax ?? 90);
  whaleClock.sweeps += 1;
  return true;
}

// ---------------------------------------------------------------------------
// THE CROSSING
// ---------------------------------------------------------------------------

export function resetWhales(scene) {
  for (const w of whales) scene.remove(w.container);
  whales.length = 0;
}

/** World Y for a 0..1 depth through the water column. */
function depthToY(t) {
  return bounds.surfaceY - (bounds.surfaceY - bounds.bottom) * t;
}

export function spawnWhale(scene, rand = Math.random) {
  const c = CONFIG.whale ?? {};

  const container = new THREE.Group();
  const visual = createVisual('whale');
  container.add(visual);

  // MEASURE the body, do not derive it. `fit` scales a grandchild of what
  // createVisual hands back and the size multiplier scales the root, so no
  // single number in the asset entry is the animal's world length — see the
  // note on createVisual's root scale. Everything below (the shove capsule, the
  // mouth offset, the despawn margin) is a fraction of what the box says.
  _box.setFromObject(visual);
  _box.getSize(_size);
  // ALONG THE DIRECTION OF TRAVEL, not the largest of the three. Entity +Y IS
  // the crossing — createVisual has already turned the model onto it — so a
  // `max` here is a body axis chosen by whichever number happened to be biggest,
  // which agrees with the heading only by luck.
  const length = _size.y;
  // The silhouette, and the fallback if there is nothing to measure it from.
  const profile = measureBodyProfile(visual);
  // WHERE THE NOSE IS, measured rather than assumed. createVisual orients every
  // creature so its `forward` points at world +Y, and the container has not been
  // rotated or moved yet — so in this frame the box's +Y face IS the nose, and
  // its distance from the origin is exactly how far forward of the pivot the
  // animal's front end sits. `ASSETS.whale.pivot` decides that distance and a
  // hand-written fraction would go stale the moment it is retuned.
  const noseAhead = _box.max.y;

  const fromLeft = rand() < 0.5;
  const dir = fromLeft ? 1 : -1;
  const margin = Math.max(c.offscreenMargin ?? 0, length * 0.75);
  const depth = between(rand, c.depthMin ?? 0.3, c.depthMax ?? 0.7);
  const baseY = depthToY(depth);

  container.position.set(fromLeft ? bounds.left - margin : bounds.right + margin, baseY, 0);
  scene.add(container);

  const anim = (visual.userData?.clips?.length || visual.userData?.rig)
    ? createAnimationController(visual)
    : null;

  const w = {
    container,
    visual,
    anim,
    morphs: morphControl(visual),
    dir,
    margin,
    length,
    // The measured silhouette (see measureBodyProfile), and the one number that
    // stands in for it where a single radius is all a caller can use: the
    // THICKEST section, which is the widest the animal ever gets on screen.
    // Off entity X specifically — the axis the camera reads as height in both
    // views — rather than off whichever of the three extents is smallest.
    profile,
    bodyRadius: profile ? profile.thickest : _size.x * 0.5,
    // Which way the side view has the body mirrored. `bodyDistance` needs it to
    // read the profile the right way up — the flank a whale swimming left shows
    // is the other one, and this animal's shape is not symmetric about its axis.
    flip: CONFIG.view === 'side' && dir < 0,
    noseAhead,
    baseY,
    // The crossing, held apart from where the body is drawn — see the note in
    // updateWhales. `lineX` is the sweep; `nudge*` is how far off it the last
    // ram put the animal, and it always comes back to zero.
    lineX: container.position.x,
    nudgeX: 0,
    nudgeY: 0,
    nudgeVX: 0,
    nudgeVY: 0,
    // Whether the seal was inside the body LAST frame with a dash in flight.
    // The nudge is edge-triggered off this: contact is tested every frame, and
    // a dash that lasts a quarter of a second would otherwise hand the same
    // ram over fifteen times.
    ramTouch: false,
    // Phase the drift per sweep, so two whales in one run do not trace the
    // same line even at the same depth.
    driftPhase: rand() * Math.PI * 2,
    clock: 0,
    prevY: baseY,
    vy: 0,
    bank: 0,
    gape: 0, // 0..1 toward feedGape, on top of the cruise gape
    gapeHold: 0, // seconds the jaw is still committed to staying open
    spout: 0,
    ate: 0, // creatures swallowed this crossing
    orbs: 0, // xp orbs swallowed this crossing
  };
  whales.push(w);
  return w;
}

/**
 * How far forward of the pivot to centre the gulp, given where the nose is.
 *
 * Pulled back from the nose by half the reach, so the sphere's FRONT face lands
 * on the tip rather than its centre — otherwise half the gulp volume is open
 * water in front of the animal and the whale eats things it has visibly not
 * reached yet. Rendered against the body by `npm run looks:whale`, which is
 * where the first version's half-a-body-length overshoot was obvious and its
 * arithmetic was not.
 *
 * Exported so the look page places its marker with this function rather than
 * with a copy of it: the drawn reach and the billed reach are exactly the kind
 * of pair that drifts apart silently.
 */
export function mouthAheadOf(noseAhead, reach = (CONFIG.whale?.mouthRadius ?? 0)) {
  return Math.max(0, noseAhead - reach * 0.5);
}

/**
 * The container rotation that lays the whale along its heading.
 *
 * THE -PI/2 IS THE WHOLE FUNCTION, and leaving it out is what stood the animal
 * on its tail. `createVisual` orients every creature so its `forward` points at
 * world **+Y**, not +X — so a container at rotation.z = 0 is a whale pointing
 * straight up, swimming sideways across the arena. The first version wrote
 * `dir < 0 ? PI : 0`, which is the right expression for a model whose forward
 * is +X and is 90 degrees wrong for every model in this project. Every other
 * heading in the codebase carries the same term: see systems/seagull.js and the
 * faceMotion branch of entities/enemies.js, both of which are
 * `Math.atan2(vy, vx) - Math.PI / 2`.
 *
 * `bank` is added in the animal's own sense, so a nose-up lean is nose-up
 * whichever way it is swimming — the side-view mirror on the visual (rotation.y
 * = PI) reverses the apparent sign, which is why it is multiplied by `dir`.
 *
 * Exported so `npm run looks:whale` renders the real heading for both
 * directions rather than a preview-only rotation that can agree with nothing.
 */
/**
 * How far the suction reaches, in world units.
 *
 * Stated as a MULTIPLE of the swallowing radius rather than as its own length,
 * so the two cannot drift apart. `mouthRadius` is the dial for how much a sweep
 * takes out of the water; this is the dial for how visible the taking is. An
 * absolute here would let somebody retune the reach and silently leave the
 * field either inside the mouth (no visible pull at all) or so far outside it
 * that fish stream in from off screen.
 */
export function intakeRadius(c = CONFIG.whale ?? {}) {
  return (c.mouthRadius ?? 0) * (c.intakeReach ?? 1);
}

export function headingFor(dir, bank = 0) {
  return Math.atan2(0, dir) - Math.PI / 2 + bank * dir;
}

/**
 * Where the jaw is, in world space — the point the gulp is measured from.
 *
 * Rotated with the body, so a banking whale's mouth is where the geometry says
 * it is rather than on the flat.
 */
function mouthPoint(w, out) {
  const ahead = mouthAheadOf(w.noseAhead);
  out.set(
    w.container.position.x + w.dir * ahead * Math.cos(w.bank),
    w.container.position.y + ahead * Math.sin(w.bank) * w.dir,
    0,
  );
  return out;
}

/**
 * Can the whale swallow this creature?
 *
 * The size test is the design's whole statement of what the sweep is for, and
 * the two exclusions above it are there because size alone gets one case badly
 * wrong. `isBossDef` is checked as well as the live `isBoss` flag because that
 * flag has windows where a boss body is in `enemies` without it — and the boss
 * it matters for is `bossCrab`, whose radius is 0.5, smaller than a puffer,
 * because the king crab carries its size in its sizeMul instead. A radius test
 * on its own puts a boss on the menu.
 */
export function isPrey(e, c = CONFIG.whale ?? {}) {
  if (e.isBoss || isBossDef(e.def)) return false;
  if (e.invincible || e.def?.invincible) return false;
  // `radius` is the SPAWNED radius — after the run's scale ramp and the
  // creature's own variance — not the CSV value. A late-run fish is a bigger
  // fish and stops being a mouthful at the same size anything else does.
  return e.radius <= (c.maxPreyRadius ?? 0);
}

export function updateWhales(dt, scene, enemiesList, hooks = {}) {
  const c = CONFIG.whale ?? {};

  for (let i = whales.length - 1; i >= 0; i--) {
    const w = whales[i];
    w.clock += dt;

    // --- the line it swims -------------------------------------------------
    // THE LINE IS KEPT SEPARATELY from where the body is drawn, because the
    // body can be shoved off it (see the nudge below) and the crossing must
    // not be. Integrating a ram into `container.position.x` directly would
    // make every shove permanent — the whale would arrive at the far wall
    // however many units of seal it had absorbed — and a whale that can be
    // walked off its own sweep is a pressure valve the player can defeat.
    w.lineX += w.dir * (c.speed ?? 0) * dt;
    const lineY = w.baseY
      + Math.sin(w.driftPhase + w.clock * (c.driftSpeed ?? 0) * Math.PI * 2) * (c.driftAmplitude ?? 0);
    // Read off the LINE and not off the drawn position, so the bank answers to
    // the drift it was written for. Through the nudge, a 0.6-unit give inside
    // one frame is 36 units/sec of apparent climb against a cruise of 8 — the
    // clamp would peg the lean at full bank and the animal would roll every
    // time the seal touched it.
    w.vy = dt > 0 ? (lineY - w.prevY) / dt : 0;
    w.prevY = lineY;

    // THE GIVE. A spring back to the line rather than a decaying velocity: a
    // shove that only decays leaves the body displaced by speed/decay forever,
    // which is a whale that has been KNOCKED. This one gives, settles and is
    // back on its line about a second later, which is the whole difference
    // between nudging thirty tonnes and moving it. Clamped as well, so a seal
    // that rams the same flank six times gets six nudges and never a tow.
    const r = c.ram ?? {};
    if (w.nudgeX || w.nudgeY || w.nudgeVX || w.nudgeVY) {
      const stiff = r.stiffness ?? 36;
      const damp = r.damping ?? 8.4;
      w.nudgeVX += (-stiff * w.nudgeX - damp * w.nudgeVX) * dt;
      w.nudgeVY += (-stiff * w.nudgeY - damp * w.nudgeVY) * dt;
      w.nudgeX += w.nudgeVX * dt;
      w.nudgeY += w.nudgeVY * dt;
      const cap = r.maxOffset ?? 1.5;
      const off = Math.hypot(w.nudgeX, w.nudgeY);
      if (off > cap) {
        w.nudgeX *= cap / off;
        w.nudgeY *= cap / off;
      }
      // Settled. Zeroed outright rather than left ringing at the fourth
      // decimal, so the branch above costs nothing for the rest of the sweep.
      if (off < 0.002 && Math.hypot(w.nudgeVX, w.nudgeVY) < 0.01) {
        w.nudgeX = 0; w.nudgeY = 0; w.nudgeVX = 0; w.nudgeVY = 0;
      }
    }

    w.container.position.x = w.lineX + w.nudgeX;
    w.container.position.y = lineY + w.nudgeY;

    // Lean into the climb. The target is the drift's own slope expressed as an
    // angle, capped at `bank`, and chased rather than snapped — a body this
    // long changing attitude in one frame reads as a glitch, not as a turn.
    const targetBank = Math.max(-1, Math.min(1, w.vy / Math.max(0.001, c.speed ?? 1)))
      * (c.bank ?? 0) * DEG;
    w.bank += (targetBank - w.bank) * Math.min(1, (c.bankSmooth ?? 0) * dt);
    w.container.rotation.z = headingFor(w.dir, w.bank);
    // The side-view mirror, and the flag `bodyDistance` reads it back off.
    // Written together so the hitbox cannot be the right way up about a body
    // that is drawn the other way — the profile has a back and a belly.
    w.flip = CONFIG.view === 'side' && w.dir < 0;
    if (CONFIG.view === 'side') w.visual.rotation.y = w.flip ? Math.PI : 0;

    mouthPoint(w, _mouth);

    // --- the gape ----------------------------------------------------------
    // Widen on what is AHEAD, and on the whole INTAKE field rather than on the
    // swallowing radius. The mouth has to already be open by the time the
    // suction starts pulling — a whale hauling a school toward a closed jaw is
    // the wrong way round, and it is the order you get if the gape keys off
    // `mouthRadius` while the field reaches three times further.
    const reach = c.mouthRadius ?? 0;
    const field = intakeRadius(c);
    const lead = field * (c.gapeLead ?? 1);
    // Only what is in FRONT of the jaw counts — a school the whale has already
    // passed is behind it and is not a reason to open.
    const worthOpeningFor = (pos) => {
      const dx = pos.x - _mouth.x;
      const dy = pos.y - _mouth.y;
      if (dx * w.dir < -reach) return false;
      return dx * dx + dy * dy <= lead * lead;
    };
    let wants = false;
    for (const e of enemiesList) {
      if (!isPrey(e, c)) continue;
      if (worthOpeningFor(e.mesh.position)) { wants = true; break; }
    }
    // CHUM OPENS IT TOO. Keying the jaw on creatures alone meant a whale could
    // swim straight through a chum pile with its mouth shut and take none of
    // it — the intake is scaled by the gape, so no gape is no suction. That is
    // wrong twice over: a seabed of uncollected orbs is exactly the situation
    // the sweep is supposed to threaten, and a pile is often the only thing in
    // the water when one arrives.
    if (!wants) {
      for (const p of pickups) {
        if (worthOpeningFor(p.mesh.position)) { wants = true; break; }
      }
    }
    // THE JAW STAYS OPEN AFTER THE FOOD HAS GONE.
    //
    // Without this the gape tracks the search exactly, and the search is a
    // radius test that flickers: a school is a scatter of individuals, so as the
    // whale swims through one the "is anything in reach" answer goes true, false,
    // true, false several times a second, and the mouth chatters open and shut
    // with it. That reads as a malfunction rather than as feeding — and it is
    // wrong about the animal too. A baleen whale opens its mouth and holds it
    // open through the whole mouthful; the jaw is not a bite.
    //
    // `gapeHold` is a floor on how long an opening lasts, refreshed every frame
    // prey is seen. Closing only begins once it has run out, so the shut is a
    // single slow movement at the end of a pass instead of a series of snaps.
    if (wants) w.gapeHold = c.gapeHold ?? 0;
    else w.gapeHold = Math.max(0, w.gapeHold - dt);
    const holding = wants || w.gapeHold > 0;
    const rate = holding ? 1 / Math.max(0.01, c.gapeOpen ?? 1) : -1 / Math.max(0.01, c.gapeClose ?? 1);
    w.gape = Math.max(0, Math.min(1, w.gape + rate * dt));

    if (w.morphs.available) {
      w.morphs.set('mouthNarrow', c.cruiseGape ?? 0);
      w.morphs.set('mouthWide', w.gape * (c.feedGape ?? 1));
    }

    // --- THE INTAKE ---------------------------------------------------------
    //
    // Everything eligible inside `intakeRadius` is DRAGGED toward the jaw, and
    // swallowed only once it arrives. The version before this deleted whatever
    // crossed `mouthRadius`, which is the same bug the crabs' chum-eating had
    // before it grew a hoover: a fish blinking out of existence near a whale is
    // indistinguishable from a fish despawning on its own, and nothing on
    // screen said the whale did it. The pull IS the mechanic being read.
    //
    // Scaled by the gape, so suction and mouth are one movement — nothing is
    // drawn in toward a closed jaw, and the field fades out as it shuts rather
    // than releasing everything on one frame.
    //
    // WHY POSITION AND NOT VELOCITY. updateWhales runs BEFORE updateEnemies
    // (see main.js), and updateEnemies rewrites e.vx/e.vy from each creature's
    // own heading every frame — so a force added here would be discarded before
    // it ever moved anything. Writing position works with that ordering rather
    // than against it: the fish is displaced now and still swims its own step
    // afterwards, which is what lets a fast one visibly struggle at the rim.
    const suction = w.gape;
    let eaten = 0;
    let pulled = 0;
    if (suction > 0.02 && field > 0) {
      const f2 = field * field;
      const r2 = reach * reach;
      // Backwards, like every other loop here that splices as it goes.
      // removeEnemy takes an INDEX — handing it the creature is a silent no-op
      // that would leave the whale swimming through a school it appeared to be
      // eating.
      for (let k = enemiesList.length - 1; k >= 0; k--) {
        const e = enemiesList[k];
        if (!isPrey(e, c)) continue;
        const dx = _mouth.x - e.mesh.position.x;
        const dy = _mouth.y - e.mesh.position.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > f2) continue;
        // Behind the head is behind the mouth. Without this the field is a
        // sphere centred on the jaw and half of it is inside the animal, so a
        // school the whale has already swum past gets hauled back up its own
        // body — which looks like the fish are being sucked through it.
        if (-dx * w.dir < -reach) continue;

        if (d2 <= r2) {
          hooks.onSwallowed?.(e, _mouth.x, _mouth.y);
          removeEnemy(scene, k);
          eaten++;
          continue;
        }

        // Stronger the closer it gets, so the rim is a drift a fast fish can
        // still swim out of and the last body-length is not escapable by
        // anything on the menu. `intakeFalloff` is the shape of that ramp —
        // 1 is a straight line, higher keeps the outer field gentle and puts
        // all the grip near the lips.
        const d = Math.sqrt(d2);
        const t = 1 - d / field;
        const pull = (c.intakePull ?? 0) * Math.pow(t, c.intakeFalloff ?? 1) * suction;
        const kk = 1 - Math.exp(-pull * dt);
        e.mesh.position.x += dx * kk;
        e.mesh.position.y += dy * kk;
        pulled++;
      }
    }
    if (eaten) {
      w.ate += eaten;
      hooks.onGulp?.(_mouth.x, _mouth.y, eaten);
    }
    w.pulling = pulled;

    // THE ORBS GO THE SAME WAY, through the same hoover every other animal in
    // the game eats chum with — bitePickup's `suck`, which drags the orb in,
    // shrinks it as it goes and matches its Z to the eater's so the last of it
    // is occluded by the body instead of hanging outside the mouth.
    //
    // `gulpPickups` used to do this in one line and it was the wrong line: it
    // deletes on contact, so a whale passing over a chum pile made the pile
    // vanish with no travel at all.
    //
    // The player is paid NOTHING, which is now expressed by there being no
    // collect callback anywhere in this block rather than by an empty one.
    let orbs = 0;
    if (suction > 0.02 && field > 0) {
      const f2 = field * field;
      for (let k = pickups.length - 1; k >= 0; k--) {
        const p = pickups[k];
        const dx = _mouth.x - p.mesh.position.x;
        const dy = _mouth.y - p.mesh.position.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > f2) continue;
        if (-dx * w.dir < -reach) continue;
        const d = Math.sqrt(d2);
        const t = 1 - d / field;
        const pull = (c.intakePull ?? 0) * Math.pow(t, c.intakeFalloff ?? 1) * suction;
        const eat = dt / Math.max(0.02, c.intakeEatTime ?? 0.4);
        const suck = { x: _mouth.x, y: _mouth.y, z: w.container.position.z, rate: pull, dt };
        // CHEWED AT THE LIPS, PULLED EVERYWHERE ELSE — the same two-part shape
        // the prey loop above has, and for the same reason. `eat` used to be
        // spent anywhere inside the field, so an orb sitting at the rim of a
        // twenty-unit bubble went down in `intakeEatTime` without ever being
        // drawn in: the whale swallowed a pile from most of a screen away, the
        // hoover hook never fired once across a whole pass, and the effect
        // this exists to give — an orb visibly dragged to the mouth and
        // shrinking as it goes — was reachable only by accident. Outside
        // `reach` the amount is 0, which leaves bitePickup doing the suction
        // and nothing else.
        //
        // Nothing is lost by the whale: the orbs it sweeps are on its own
        // line, so the mouth arrives at them whether or not the suction got
        // there first.
        const atLips = d2 <= reach * reach;
        if (bitePickup(scene, p, atLips ? eat : 0, suck)) orbs++;
        else if (t > 0.15) hooks.onOrbHoover?.(p.mesh.position.x, p.mesh.position.y);
      }
    }
    if (orbs) {
      w.orbs += orbs;
      hooks.onOrbsEaten?.(_mouth.x, _mouth.y, orbs);
    }

    // --- the shove ---------------------------------------------------------
    // The body is the SILHOUETTE, not a circle and no longer a plain capsule
    // either — see measureBodyProfile at the top of this file for what a
    // constant radius got wrong at each end of a bowhead.
    //
    // ONE CONTACT TEST, BOTH DIRECTIONS. The whale shoves the seal aside, and a
    // seal that arrived at ramming speed moves the whale a little in return —
    // the same touch, read from each end. A second shape for the ram would be
    // a body you can be pushed by at one size and push at another, which is
    // the sort of pair that drifts apart the first time either is retuned (see
    // the crab's claw for how that goes).
    const p = hooks.player;
    const ram = hooks.ram;
    let ramming = false;
    if (p && ((c.shoveForce ?? 0) > 0 || ram?.dashing)) {
      const touching = bodyDistance(w, p.position.x, p.position.y) <= (p.radius ?? 0);

      // THE NUDGE, on the frame the ram ARRIVES. Along the dash, like every
      // other thing the strike shoves (see applyKnockback) — the seal is a
      // battering ram travelling in one direction, and pushing a whale
      // radially would have a clip along the flank lift it.
      //
      // Deliberately NOT divided by size the way a creature's knock is: at
      // thirty tonnes that arithmetic rounds to nothing, and the whale is the
      // one body in the game whose reaction is authored as a flat give rather
      // than derived from its mass.
      ramming = touching && !!ram?.dashing;
      const rc = c.ram ?? {};
      if (ramming && !w.ramTouch && rc.enabled !== false) {
        const k = CONFIG.strike?.knockback ?? {};
        // The same charge ramp the rest of the ram runs on, so a flick and a
        // full-commitment strike do not move it alike.
        const pw = Math.min(1, Math.max(0, ram.power ?? 0));
        const scale = (k.powerMin ?? 0.45) + ((k.powerMax ?? 1.3) - (k.powerMin ?? 0.45)) * pw;
        const dLen = Math.hypot(ram.dirX ?? 0, ram.dirY ?? 0) || 1;
        const speed = (rc.speed ?? 5) * scale;
        w.nudgeVX += ((ram.dirX ?? 0) / dLen) * speed;
        w.nudgeVY += ((ram.dirY ?? 0) / dLen) * speed;

        // AND THE SKELETON, on the same contact and along the same dash.
        //
        // The nudge above moves the whole animal as one piece, which on a body
        // this long reads as the CAMERA drifting rather than as a hit: every
        // part of it goes the same way by the same amount, so there is nothing
        // for the eye to compare against. The spine springs are what carry a
        // hit on every other creature in the game (systems/boneSpring.js — the
        // whale has no flinch clip, and no clips at all), and shoving them here
        // gives the sweep the thing thirty tonnes still owes you: the body
        // buckles a little where it was hit and the fluke finishes the flinch
        // half a second later, down the same travelling wave that gives this
        // animal its swim.
        //
        // Small on purpose, and separate from `speed` rather than derived from
        // it: one is how far the animal moves and the other is how much of it
        // bends, and they are not the same feeling at the same number.
        const fl = rc.flinch ?? {};
        const kick = (fl.strength ?? 0) * scale;
        if (kick > 0 && w.anim && CONFIG.animation?.enabled) {
          _imp.set((ram.dirX ?? 0) / dLen, (ram.dirY ?? 0) / dLen, 0);
          w.anim.impulse(_imp, kick, fl.tipBias);
        }
        hooks.onNudge?.(p.position.x, p.position.y, speed);
      }

      if (touching && (c.shoveForce ?? 0) > 0) {
        // OUT OF THE CORRIDOR, NOT ALONG IT.
        //
        // The obvious normal — from the nearest point on the axis to the seal —
        // is wrong at the one place it matters most. The first contact of a
        // crossing is almost always the NOSE, where that normal points straight
        // down the whale's own direction of travel, so the shove launches the
        // seal ahead of the animal and the animal then swims after it. Measured,
        // that pins the seal in front of the jaw for the rest of the crossing:
        // a non-damaging body that cannot be escaped is worse than a damaging
        // one that can.
        //
        // So the push is PERPENDICULAR to the body axis, which is also what a
        // body this size actually does to the water it displaces. Vertical
        // dominates; `dy` only picks which way, and the sign is taken from the
        // whale's own centre rather than from the capsule point so that a nose
        // hit still throws the seal clear instead of splitting the difference.
        const away = p.position.y - w.container.position.y;
        const ny = away >= 0 ? 1 : -1;
        // A small backward component so a head-on hit also loses ground to the
        // whale rather than being purely lifted. Clamped to never be positive
        // along `dir` — the seal may be pushed back past the animal, never
        // forward in front of it.
        const nx = -w.dir * 0.35;
        const len = Math.hypot(nx, ny);
        hooks.onShove?.(nx / len, ny / len, c.shoveForce, p.position.x, p.position.y);
      }
    }
    // Outside the branch above, so a dash that ENDS while the seal is still
    // against the flank clears the latch and the next one lands — and so a
    // whale the player never touches settles it to false every frame.
    w.ramTouch = ramming;

    // --- the spout ---------------------------------------------------------
    if (c.spoutEnabled && w.morphs.has('blowhole')) {
      const span = Math.max(0.001, bounds.surfaceY - bounds.bottom);
      const depthNow = (bounds.surfaceY - w.container.position.y) / span;
      const up = depthNow <= (c.spoutDepth ?? 0);
      const srate = up ? 1 / Math.max(0.01, c.spoutRise ?? 1) : -1 / Math.max(0.01, c.spoutFall ?? 1);
      const was = w.spout;
      w.spout = Math.max(0, Math.min(1, w.spout + srate * dt));
      w.morphs.set('blowhole', w.spout);
      // Edge-triggered, at the top of the pop, so the plume fires once per
      // surfacing rather than every frame the animal is shallow.
      if (was < 1 && w.spout >= 1) hooks.onSpout?.(w.container.position.x, w.container.position.y);
    }

    // --- gone ---------------------------------------------------------------
    // Only when it is heading FURTHER out. A whale spawns legitimately
    // offscreen, so testing position alone would cull it on frame one.
    const past = w.dir > 0
      ? w.container.position.x > bounds.right + w.margin
      : w.container.position.x < bounds.left - w.margin;
    if (past) {
      hooks.onLeft?.(w);
      scene.remove(w.container);
      whales.splice(i, 1);
      continue;
    }

    // The wag. `wagState` rather than stateForSpeed(): the whale is travelling
    // at 15 u/s, which that helper reads as a full sprint, and a bowhead
    // sprinting is a bowhead having a seizure. Its stroke is slow and long, so
    // it takes the state whose wagSpeed/wagAmplitude say so.
    if (CONFIG.animation.enabled && w.anim) w.anim.update(dt, c.wagState ?? 'idle', false);
  }
}
