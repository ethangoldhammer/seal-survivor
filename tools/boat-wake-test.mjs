#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:wake
//
// THE WAKE EVERY HULL LEAVES — systems/boatWake.js, shared by the boats that
// sail past (systems/boats.js) and by both boat bosses (systems/bossBoat.js).
//
// This drives the real system against the real merged CONFIG and reads the
// answers back out of the real particle buffer, because every way this effect
// can be wrong is invisible from the code and silent at runtime:
//
//   BORN IN THE AIR    A churn bubble has to be born UNDER the water line. The
//                      surface clip and the pop that draws the foam are both
//                      gated on `y < surfaceHeightAt(x)` at emission time (see
//                      entities/particles.js), so a bubble a hair too high is
//                      not clipped, never pops, and sails up into the sky —
//                      with nothing thrown and nothing logged. The water line
//                      is a WAVE, so "under the surface" is a different number
//                      at every x and at every moment.
//   THE WRONG END      The churn belongs astern. A sign error puts the whole
//                      wake in front of the boat, which is a plausible-looking
//                      effect that reads as the hull sailing backwards.
//   THE STERN FLIPS    A boss parked in its deadzone has a velocity of a few
//                      hundredths. A heading read off THAT flips side to side
//                      every few frames — so the test holds a hull still and
//                      checks the wake stays on one side of it.
//   RATE               Ramped on speed with a floor at rest, scaled by hull
//                      size, and capped per frame. All four are load-bearing:
//                      no floor and a station-keeping boss sits on glass, no
//                      cap and one long frame dumps a second of wake into one
//                      spot.
//
// Everything expected is derived from CONFIG. imported-tuning.json is merged at
// import and wins over config.js, so a literal here would test the tuning file
// rather than the code.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, surfaceHeightAt, setWaveTime } from '../path/src/arena.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import { updateHullWake, resetHullWake } from '../path/src/systems/boatWake.js';

const scene = new THREE.Scene();
initParticles(scene);

const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;
const CAP = attrs.aStart.count;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Everything alive in the buffer right now, as {x, y, vx, vy, clip}. The system
// under test never sees this — it only calls emit() — so this is a read of what
// actually landed in the geometry, not of what the caller thought it asked for.
function live() {
  const out = [];
  for (let i = 0; i < CAP; i++) {
    if (attrs.aStart.array[i] < -1e8) continue;
    out.push({
      x: attrs.position.array[i * 3],
      y: attrs.position.array[i * 3 + 1],
      vx: attrs.aVelocity.array[i * 3],
      vy: attrs.aVelocity.array[i * 3 + 1],
      clip: attrs.aClip.array[i],
    });
  }
  return out;
}

/**
 * Run a hull for `seconds` of 60fps frames and hand back everything the WAKE
 * emitted — not everything in the buffer.
 *
 * The difference is the whole reason this is written the long way round. A
 * churn bubble that reaches the surface bursts into `bubbleBurst` droplets
 * (entities/particles.js fires them from inside updateParticles), and those
 * droplets are born AT the water line with no clip flag — which is exactly the
 * signature of a bow-wave drop. Reading the buffer at the end of a run
 * therefore hands you the foam mixed in with the spray, and every count and
 * every "is it above the line" is then measuring the wrong population. The
 * first version of this test did that and it read as four bugs in the system.
 *
 * So the buffer is swept TWICE a frame, keyed by (slot, spawn time) so a
 * ring-buffer recycle counts as a new particle rather than being missed:
 *
 *   after updateHullWake   collected — this is the wake, and nothing else can
 *                          have written to the buffer in between.
 *   after updateParticles  swept and DISCARDED. This is the sweep that matters:
 *                          the pops are emitted from inside updateParticles, so
 *                          without it they are still unseen at the top of the
 *                          next frame and get collected as though the hull had
 *                          just emitted them. That is not a hypothetical — it
 *                          is what this test did first, and it reported the
 *                          system throwing a bow wave off a hull standing
 *                          still, because a droplet born at the water line is
 *                          indistinguishable from one born just above it.
 */
function run(hull, o, seconds, dt = 1 / 60) {
  resetParticles();
  resetHullWake(hull);
  const seen = new Map();
  const emitted = [];
  let frame = 0;
  const sweep = (into) => {
    for (let i = 0; i < CAP; i++) {
      const start = attrs.aStart.array[i];
      if (start < -1e8 || seen.get(i) === start) continue;
      seen.set(i, start);
      if (!into) continue;
      into.push({
        x: attrs.position.array[i * 3],
        y: attrs.position.array[i * 3 + 1],
        vx: attrs.aVelocity.array[i * 3],
        vy: attrs.aVelocity.array[i * 3 + 1],
        clip: attrs.aClip.array[i],
        // WHICH LAYER IT IS DRAWN BY, and how big it draws. A goo particle
        // (aGoo > 0) is not a sprite: it is splatted into the density field at
        // `size x the group's radius`, which for the foam is nearly a unit
        // where a bubble is a fifth of one. Every overlap check below has to
        // use that, or it is measuring a point against a hull the particle is
        // painting a third of itself across.
        goo: attrs.aGoo.array[i],
        size: attrs.aSize.array[i],
        // Enough to re-solve the whole flight — see `solve`.
        drag: attrs.aDrag.array[i],
        life: attrs.aLife.array[i],
        gy: attrs.aGravity.array[i * 2 + 1],
        // Where the hull was when this one was born, so the path can be
        // measured against a boat that is itself moving.
        atFrame: frame,
        // The water line WHERE AND WHEN this one was born. Recorded now, not
        // recomputed at the end: the wave moves, so the surface a bubble was
        // legal against three seconds ago is not the surface today.
        surf: surfaceHeightAt(attrs.position.array[i * 3]),
      });
    }
  };
  const frames = Math.round(seconds / dt);
  for (let f = 0; f < frames; f++) {
    frame = f;
    setWaveTime(f * dt);
    updateHullWake(dt, hull, typeof o === 'function' ? o(f * dt) : o);
    sweep(emitted);
    updateParticles(dt);
    sweep(null);
  }
  return emitted;
}

// The closed form the vertex shader solves every particle's position with,
// transcribed. Same reasoning as the CPU twin of the turbulence field in
// entities/particles.js: a copy that drifts from the shader is a check that
// passes on a bubble the player can see going somewhere else.
function solve(p, age) {
  const k = Math.max(p.drag, 1e-4);
  const f = (1 - Math.exp(-k * age)) / k;
  return [p.x + p.vx * f, p.y + p.vy * f + 0.5 * p.gy * age * age];
}

// Half the width a particle actually DRAWS, in world units. A sprite is its own
// size; a goo lobe is that times its group's splat radius. Read off the
// particle rather than off the emitter, so a burst's size scatter is covered
// and not just its top end.
function drawnHalf(p) {
  if (!(p.goo > 0)) return p.size * 0.5;
  const goo = CONFIG.fx?.goo;
  const name = Object.keys(goo?.groups ?? {})[p.goo - 1];
  const radius = goo?.groups?.[name]?.radius ?? goo?.radius ?? 3;
  return p.size * radius * 0.5;
}

const c = CONFIG.boatWake;
// A rowboat and the boss yacht, as the two ends of the size range the effect
// has to cover. Both measured the way the game measures them — see hullExtents
// in systems/boats.js and the Box3 in attachBossBoat.
const ROWBOAT = 3;
const YACHT = 6.5;

console.log('\nboat wake — systems/boatWake.js');
console.log(`  (speedRef ${c.speedRef}, churn ${c.churnPerSecond}/s, idle share ${c.idleShare})\n`);

// --- 1. every churn bubble is born under the water line ---------------------
// The one failure that is completely silent. Checked against surfaceHeightAt at
// each bubble's OWN x, because the surface is a wave — a flat comparison
// against bounds.surfaceY would pass a bubble born in the crest of a swell.
{
  const hull = {};
  const parts = run(hull, { x: 0, halfLength: ROWBOAT, dir: 1, speed: 4, vx: 4 }, 2);
  // The two halves, told apart by the clip flag — which is not a label the
  // system chose but the consequence of where each one was born, and therefore
  // the thing actually worth asserting on.
  //
  // THE FOAM IS A THIRD THING and has to come out of `spray` explicitly. It is
  // born at the line and deliberately unflagged, so "unflagged" stopped meaning
  // "bow wave" the day it was added — and every bow-wave assertion below would
  // otherwise be testing lobes of foam sitting astern against rules written for
  // drops thrown off the stem.
  const churn = parts.filter((p) => p.clip === 1);
  const spray = parts.filter((p) => p.clip === 0 && !(p.goo > 0));
  check('churn was emitted at all', churn.length > 0, `${churn.length} emitted`);
  const above = churn.filter((p) => p.y >= p.surf);
  check('every churn bubble is born under the water line', above.length === 0,
    `${above.length} of ${churn.length} above it`);
  const deep = churn.map((p) => p.surf - p.y);
  const maxDepth = c.depth * (1 + c.depthVary);
  check('churn depth stays inside depth ± depthVary',
    deep.every((d) => d > 0 && d <= maxDepth + 1e-6),
    `range ${Math.min(...deep).toFixed(3)}..${Math.max(...deep).toFixed(3)}, max allowed ${maxDepth.toFixed(3)}`);

  // --- 2. the bow wave is the other way round -----------------------------
  // Born ABOVE the line on purpose, which is exactly what keeps it out of the
  // clip. A spray that got flagged would be deleted on its first frame.
  check('bow wave was emitted at cruise', spray.length > 0, `${spray.length} emitted`);
  check('every bow drop is born above the water line',
    spray.every((p) => p.y > p.surf));
}

// --- 3. the churn is astern, the spray is at the bow ------------------------
// Run both headings. A sign error that puts the wake in front of the boat looks
// like a wake; it just belongs to a boat sailing the other way.
for (const dir of [1, -1]) {
  const hull = {};
  const parts = run(hull, { x: 0, halfLength: ROWBOAT, dir, speed: 4.5, vx: 4.5 * dir }, 2);
  const churn = parts.filter((p) => p.clip === 1);
  const spray = parts.filter((p) => p.clip === 0 && !(p.goo > 0));
  const foam = parts.filter((p) => p.goo > 0);
  // The foam belongs astern with the churn, so it gets the churn's rule rather
  // than the spray's — and it is measured from its trailing EDGE, since that is
  // the part that would be over the boat.
  const foamBack = foam.map((p) => (-dir * p.x - drawnHalf(p)) / ROWBOAT);
  check(`foam never gets ahead of the transom (dir ${dir > 0 ? '+x' : '-x'})`,
    foam.length > 0 && foamBack.every((b) => b > 1),
    `${foam.length} lobes, nearest edge ${Math.min(...foamBack).toFixed(2)} half-lengths aft`);
  // Measured in half-lengths back from the middle, which is the unit
  // churnFrom/churnTo are authored in.
  const back = churn.map((p) => (-dir * p.x) / ROWBOAT);
  check(`churn never gets ahead of amidships (dir ${dir > 0 ? '+x' : '-x'})`,
    back.every((b) => b > 0),
    `range ${Math.min(...back).toFixed(2)}..${Math.max(...back).toFixed(2)} half-lengths aft`);
  check(`churn is cast astern (dir ${dir > 0 ? '+x' : '-x'})`,
    churn.filter((p) => Math.sign(p.vx) === -dir).length > churn.length * 0.6);
  const fwd = spray.map((p) => (dir * p.x) / ROWBOAT);
  check(`bow wave is at the bow (dir ${dir > 0 ? '+x' : '-x'})`,
    spray.length > 0 && fwd.every((f) => f > 0.5));
}

// --- 3b. NOTHING IS EVER DRAWN ON THE BOAT ----------------------------------
//
// THE ONE THAT MATTERS, and the one the effect shipped wrong.
//
// Particles draw with depth testing off and a high render order, so they are
// always in front of the hull whatever their z — a bubble inside the hull's box
// is not "behind the boat", it is painted over it. And it is not enough to
// check where a bubble is BORN: one born legally under the keel rises, and
// rising into the hull is the same overlap arriving a fifth of a second late.
//
// So every bubble's whole flight is re-solved with the same closed form the
// vertex shader uses, against a hull that is itself moving, and the box is
// tested at every step. This is the assertion the "no runtime collision"
// paragraph in systems/boatWake.js is promising.
for (const [name, halfLength, speed] of [
  ['rowboat at cruise', ROWBOAT, 4],
  ['trawler, slowest', ROWBOAT * 1.5, CONFIG.boats.speed],
  ['yacht at boss track speed', YACHT, CONFIG.bossBoat.trackSpeed ?? 4.5],
  ['yacht holding station', YACHT, 0],
  // A hull that has been punted or caught a blast. Speed is what decides how
  // fast a boat overtakes its own bow wave, so the fastest case is the one that
  // catches it — and nothing clamps a shoved hull to its sailing speed.
  ['rowboat blasted, way over cruise', ROWBOAT, 12],
]) {
  // A hull sitting in the water the way the real ones do: the box straddles the
  // line, so the keel is well under it and the deck is above.
  const halfHeight = halfLength * 0.42;
  const centreY = () => bounds.surfaceY - halfHeight * 0.45;
  const hull = {};
  const startX = 0;
  const at = (t) => ({
    x: startX + speed * t,
    halfLength,
    keelY: centreY() - halfHeight,
    dir: 1,
    speed,
    vx: speed,
  });
  const parts = run(hull, at, 3);

  let worst = 0;
  let inside = 0;
  for (const p of parts) {
    // The hull grows by however wide this particle draws, which is the same
    // test as shrinking the particle to a point and is easier to read. For a
    // bubble it is a couple of centimetres and changes nothing; for a foam lobe
    // it is most of a unit and is the entire point of the check.
    const half = drawnHalf(p);
    // Walked rather than sampled at a few points: the entry can be brief, and a
    // check that steps over it is a check that always passes.
    const steps = 40;
    for (let s = 0; s <= steps; s++) {
      const age = (p.life * s) / steps;
      const [x, y] = solve(p, age);
      // Where the hull is at that moment — birth frame plus the particle's age.
      const hx = startX + speed * (p.atFrame / 60 + age);
      const dx = Math.abs(x - hx);
      const dy = Math.abs(y - centreY());
      if (dx < halfLength + half && dy < halfHeight + half) {
        inside += 1;
        // How far in, so a failure says whether it is a hair or a howler.
        worst = Math.max(worst, Math.min(halfLength + half - dx, halfHeight + half - dy));
        break;
      }
    }
  }
  check(`nothing is ever drawn on the hull — ${name}`, inside === 0,
    `${inside} of ${parts.length} particles entered the box, worst ${worst.toFixed(2)}u in`);

  // ...and the foam is the reason that check now measures a WIDTH. Its lobes
  // are the only things in the wake big enough for the difference to matter, so
  // if none were emitted the assertion above is back to being about bubbles.
  const foam = parts.filter((p) => p.goo > 0);
  check(`  ...with foam lobes in the sample — ${name}`, foam.length > 0,
    `${foam.length} of ${parts.length}, widest ${(Math.max(0, ...foam.map(drawnHalf)) * 2).toFixed(2)}u across`);

  // ...and the check must not be passing because nothing was in the risky zone
  // to begin with. A keel bubble is the only one born below the hull, so it is
  // its own witness — and on a moving hull there has to be one.
  const underKeel = parts.filter((p) => p.y < centreY() - halfHeight).length;
  if (speed > 0) {
    check(`  ...with the keel zone actually firing — ${name}`, underKeel > 0,
      `${underKeel} of ${parts.length} bubbles were born under the hull`);
  } else {
    // A hull holding station flushes nothing out from under itself, so the span
    // collapses to zero by design and the whole wake goes astern.
    check(`  ...and a stopped hull uses no keel zone — ${name}`, underKeel === 0,
      `${underKeel} bubbles under a hull that cannot clear them`);
  }
}

// --- 4. a hull holding station still bubbles, and on ONE side --------------
// The boss's whole fight is spent parked. `speed: 0` with a heading of +1 is
// exactly the state a stern read off velocity cannot survive.
{
  const hull = {};
  const parts = run(hull, { x: 0, halfLength: YACHT, dir: 1, speed: 0, vx: 0 }, 3);
  check('a stopped hull still churns (idleShare)', parts.length > 0, `${parts.length} emitted`);
  // Bubbles are flagged for the surface clip; the bow wave is born in the air
  // and is not. The foam is the third thing in the buffer now — born AT the
  // line and deliberately unflagged (see `hullFoam`) — so it is excluded by
  // name rather than by clip, or "no bow wave" would read every lobe of foam as
  // a drop of spray.
  check('a stopped hull throws no bow wave',
    parts.every((p) => p.clip === 1 || p.goo > 0));
  check('a stopped hull keeps its wake on one side',
    parts.every((p) => p.x <= 1e-6),
    `${parts.filter((p) => p.x > 0).length} ended up forward of the middle`);
}

// --- 5. the rate ------------------------------------------------------------
// Counted as BURSTS rather than particles, so a change to the emitter's own
// `count` doesn't move the expectation.
{
  const per = CONFIG.emitters.hullWake.count;
  function bursts(o, seconds) {
    return run({}, o, seconds).filter((p) => p.clip === 1).length / per / seconds;
  }
  const cruise = bursts({ x: 0, halfLength: ROWBOAT, dir: 1, speed: c.speedRef, vx: c.speedRef }, 4);
  const stopped = bursts({ x: 0, halfLength: ROWBOAT, dir: 1, speed: 0, vx: 0 }, 4);
  // Counted at emission, so this is the rate itself rather than a population,
  // and the tolerance is only the carry left over at the end of the window.
  const want = c.churnPerSecond;
  check('a hull at speedRef churns at about churnPerSecond',
    Math.abs(cruise - want) < 1,
    `${cruise.toFixed(1)}/s, rate is ${want}`);
  check('a stopped hull churns at exactly idleShare of that',
    Math.abs(stopped - want * c.idleShare) < 1,
    `${stopped.toFixed(1)}/s, expected ${(want * c.idleShare).toFixed(1)}`);

  const small = bursts({ x: 0, halfLength: ROWBOAT, dir: 1, speed: 4, vx: 4 }, 4);
  const big = bursts({ x: 0, halfLength: YACHT, dir: 1, speed: 4, vx: 4 }, 4);
  check('a bigger hull sheds a busier wake', big > small * 1.15,
    `${big.toFixed(1)} against ${small.toFixed(1)}`);
}

// --- 6. one long frame must not dump a second of wake -----------------------
// The hitch guard. Without it a frame after a stall emits the whole backlog at
// one x, which is a bright blob rather than a wake.
{
  const hull = {};
  resetParticles();
  resetHullWake(hull);
  setWaveTime(0);
  updateHullWake(1.0, hull, { x: 0, halfLength: YACHT, dir: 1, speed: 8, vx: 8 });
  const n = live().length;
  const cap = c.maxPerFrame * (CONFIG.emitters.hullWake.count
    + CONFIG.emitters.hullSpray.count + CONFIG.emitters.hullFoam.count);
  check('a one-second frame is capped', n <= cap, `${n} particles, cap is ${cap}`);
}

// --- 6b. COMING ABOUT -------------------------------------------------------
{
  // The splash goes through feedback(), which reaches sound and the grid as
  // well as the particles — so it is driven here and read back out of the same
  // buffer everything else in this file is measured in.
  const { hullTurnSplash } = await import('../path/src/systems/boatWake.js');
  resetParticles();
  setWaveTime(0);
  hullTurnSplash({ x: 0, halfLength: ROWBOAT, dir: 1 });
  const parts = live();
  check('a turn throws a splash', parts.length > 0, `${parts.length} particles`);
  // BOTH ENDS. One splash reads as the boat being hit; two read as it turning,
  // and that is the entire reason this is not a single burst at the centre.
  const bow = parts.filter((p) => p.x > ROWBOAT * 0.5).length;
  const stern = parts.filter((p) => p.x < -ROWBOAT * 0.5).length;
  check('...at both ends of the hull', bow > 0 && stern > 0,
    `${bow} forward, ${stern} aft`);
  check('...and nothing in the middle, where a hit would splash',
    parts.every((p) => Math.abs(p.x) > ROWBOAT * 0.5));

  const was = CONFIG.boatWake.turnSplash;
  CONFIG.boatWake.turnSplash = false;
  resetParticles();
  hullTurnSplash({ x: 0, halfLength: ROWBOAT, dir: 1 });
  check('turnSplash = false is silent', live().length === 0);
  CONFIG.boatWake.turnSplash = was;
}

// --- 6c. a hull coming about does not go quiet ------------------------------
// `ramp` is read off travel, and a boat coming about has almost none — so
// without the turn drive the churn dies away through the one manoeuvre the
// whole fight is watching.
{
  const still = run({}, { x: 0, halfLength: YACHT, dir: 1, speed: 0, vx: 0 }, 2).length;
  const turning = run({}, { x: 0, halfLength: YACHT, dir: 1, speed: 0, vx: 0, turning: 1 }, 2).length;
  check('a turning hull churns far harder than a parked one', turning > still * 3,
    `${turning} against ${still} particles at the same (zero) speed`);
}

// --- 7. switched off means switched off ------------------------------------
{
  const was = CONFIG.boatWake.enabled;
  CONFIG.boatWake.enabled = false;
  const hull = {};
  const parts = run(hull, { x: 0, halfLength: ROWBOAT, dir: 1, speed: 5, vx: 5 }, 1);
  CONFIG.boatWake.enabled = was;
  check('boatWake.enabled = false emits nothing', parts.length === 0, `${parts.length} alive`);
}

console.log(failures === 0 ? '\nboat wake: all checks passed\n' : `\nboat wake: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
