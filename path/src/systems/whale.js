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

export function whaleCount() {
  return whales.length;
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
  const length = Math.max(_size.x, _size.y, _size.z);
  const girth = Math.min(_size.x, _size.y, _size.z);
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
    // Half the smallest extent is the body's radius about its own axis. Used
    // for the shove capsule, so the seal is pushed by the whale's actual bulk
    // rather than by a number somebody typed.
    bodyRadius: girth * 0.5,
    noseAhead,
    baseY,
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
    w.container.position.x += w.dir * (c.speed ?? 0) * dt;
    w.prevY = w.container.position.y;
    w.container.position.y = w.baseY
      + Math.sin(w.driftPhase + w.clock * (c.driftSpeed ?? 0) * Math.PI * 2) * (c.driftAmplitude ?? 0);
    w.vy = dt > 0 ? (w.container.position.y - w.prevY) / dt : 0;

    // Lean into the climb. The target is the drift's own slope expressed as an
    // angle, capped at `bank`, and chased rather than snapped — a body this
    // long changing attitude in one frame reads as a glitch, not as a turn.
    const targetBank = Math.max(-1, Math.min(1, w.vy / Math.max(0.001, c.speed ?? 1)))
      * (c.bank ?? 0) * DEG;
    w.bank += (targetBank - w.bank) * Math.min(1, (c.bankSmooth ?? 0) * dt);
    w.container.rotation.z = headingFor(w.dir, w.bank);
    if (CONFIG.view === 'side') w.visual.rotation.y = w.dir < 0 ? Math.PI : 0;

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
        // Only counts as eaten once bitePickup says the orb is finished — it
        // takes `intakeEatTime` of being held at the lips to go down, which is
        // what makes a swallow a visible event rather than a disappearance.
        if (bitePickup(scene, p, eat, suck)) orbs++;
        else if (t > 0.15) hooks.onOrbHoover?.(p.mesh.position.x, p.mesh.position.y);
      }
    }
    if (orbs) {
      w.orbs += orbs;
      hooks.onOrbsEaten?.(_mouth.x, _mouth.y, orbs);
    }

    // --- the shove ---------------------------------------------------------
    // The body is a CAPSULE, not a circle. A 31-unit animal tested as a sphere
    // at its own centre either misses the seal entirely along most of its
    // length (radius small) or shoves from half a screen away (radius large);
    // neither is the shape on screen. This is the distance from the seal to the
    // body's axis segment, which is what the silhouette actually is.
    const p = hooks.player;
    if (p && (c.shoveForce ?? 0) > 0) {
      const half = w.length * 0.5;
      const ax = w.container.position.x - w.dir * half;
      const bx = w.container.position.x + w.dir * half;
      const t = Math.max(0, Math.min(1, (p.position.x - ax) / (bx - ax || 1)));
      const cx = ax + (bx - ax) * t;
      const cy = w.container.position.y;
      const dx = p.position.x - cx;
      const dy = p.position.y - cy;
      const hit = w.bodyRadius + (p.radius ?? 0);
      if (dx * dx + dy * dy <= hit * hit) {
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
