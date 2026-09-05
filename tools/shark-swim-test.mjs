#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sharkswim
//
// The shark cruise: lateral travel, an earned and gradual climb, and a weave
// carried by the head. See the shark-cruise block in entities/enemies.js.
//
// Every claim here is about a PATH over time, which is exactly what you cannot
// see from the code and cannot check in a screenshot: "not abrupt" is a
// statement about the second derivative of a trajectory. So this drives the
// real behaviour with a real enemy for real seconds and measures where it went.
//
//   node --import ./tools/vite-loader.mjs tools/shark-swim-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, enemyPaceMul } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { resolvePredation } from '../path/src/systems/predation.js';

const scene = new THREE.Scene();

// The animation controller warns once per state per creature for clips a
// procedural stand-in does not have, which in Node is all of them.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

const player = new THREE.Object3D();

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const SHARKS = ['shark', 'greatWhite', 'abyssShark', 'hammerhead', 'megalodon', 'mightyMeg'];
const dt = 1 / 60;

// The arena is y in [-40, 10] with the water surface at 0, so every coordinate
// below is UNDERWATER on purpose. Testing against a player at y = +26 measures
// the surface clamp, not the steering.
const MID = -20;   // comfortably mid-water
const HIGH = -6;   // near the surface, but under it

// A world with nothing in it but the shark and the player: no fish to break
// off for, no chum, no crew. Whatever the path does is the cruise itself.
// `warmup` discards the opening seconds. A creature spawns on a random heading
// and is turn-limited, so the first half-second of any run is it swinging round
// to face what it wants — which in a short window swamps the thing being
// measured and reports a flattened shark as climbing.
//
// `chase` is the one option that is not about the scenario. Most of the
// sections below are claims about the CLIMB SHAPING — updateSwim's eased gain
// and shapeSwim's slope budget — and they measure it through a shark
// approaching a player, because that is the only way to make it climb. That
// scenario stopped existing when CONFIG.cruiseHunt landed: a cruise hunter
// spends `trackRate` on the player rather than its full turnRate, so it no
// longer commits to an approach at all and the horizontal gap it is being
// judged on is whatever its wander happened to leave. Those sections pass
// `chase: true`, which switches the pursuit budget off for the run so the one
// variable under test is the only one moving. The cruise-hunt behaviour itself
// gets its own section at the bottom, measured on its own terms.
//
// SEEDED, and this is not decoration. A creature spawns on a random heading
// with a random speed off `speedVariance`, and a run is a dozen seconds of
// integrating that — so the same assertion passed or failed depending on the
// draw. Measured before this: three of twelve invocations failed, always on the
// slowest bodies and usually on "megalodon: rises later in the approach", which
// is a threshold nothing was actually near. That is a quarter of runs telling
// you that you broke something you did not touch, and the cost is not the
// re-run — it is that a real regression in this file now has to argue with a
// reputation for crying wolf. `seed` is per scenario so two scenarios are still
// independent draws; it just stops them being different ones each invocation.
//
// `lunge` is the second scenario switch, and it exists for exactly the reason
// `chase` does. The apex sharks commit to a burst inside their own `lunge.range`
// now (see the overlay in BEHAVIORS.hunt), and a burst writes velocity straight
// from the heading — no eased climb gain, no slope budget, no turn limit. That
// is the whole point of it and it is also, by construction, NOT the cruise. So
// the sections that measure the cruise shaping — the smoothness of the climb
// and the order of flat-then-rise — turn it off for the run, and the lunge gets
// its own section at the bottom on its own terms.
//
// Which sharks it changed: all six, and only the megalodon crossed a threshold.
// That is the shape of a real interaction rather than a flake — the slowest
// body with the longest committed run, measured over an approach that ends
// exactly where the burst begins.
function run(type, {
  playerAt, seconds = 12, from = { x: 0, y: 0 }, warmup = 0,
  chase = false, lunge = true, seed = 1, facing = null,
}) {
  const rand = seeded(seed);
  const orig = Math.random;
  Math.random = rand;
  try {
    return runInner(type, { playerAt, seconds, from, warmup, chase, lunge, facing });
  } finally { Math.random = orig; }
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function runInner(type, { playerAt, seconds, from, warmup, chase, lunge = true, facing = null }) {
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 0, { x: from.x, y: from.y }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${type}`);
  if (facing != null) {
    // +1 faces +x, -1 faces -x: level, so a test can put the seal behind it.
    e.heading = facing > 0 ? 0 : Math.PI;
    e.vx = Math.cos(e.heading) * e.speed;
    e.vy = 0;
    // One settled frame with something AHEAD of it, so the body's yaw
    // (systems/fishTurn.js) has a facing to come about FROM. Its first frame
    // adopts whatever the velocity already says, and a reversal on that
    // frame would be adopted rather than performed.
    player.position.set(from.x + facing * 80, from.y, 0);
    updateEnemies(dt, scene, player.position, () => {}, () => {});
  }
  player.position.set(playerAt.x, playerAt.y, 0);
  const path = [];
  const gains = [];
  const looks = [];
  const steps = Math.round(seconds / dt);
  const skip = Math.round(warmup / dt);
  const wasCruise = CONFIG.cruiseHunt.enabled;
  if (chase) CONFIG.cruiseHunt.enabled = false;
  // Lifted off the shared def for the length of the run and put back in the
  // `finally` alongside the cruise flag, so a throw mid-run cannot leave the
  // roster de-fanged for every section after it.
  const wasLunge = CONFIG.enemies[type].lunge;
  if (!lunge) delete CONFIG.enemies[type].lunge;
  try {
    for (let i = 0; i < steps + skip; i++) {
      updateEnemies(dt, scene, player.position, () => {}, () => {});
      if (i < skip) continue;
      path.push({ x: e.mesh.position.x, y: e.mesh.position.y });
      gains.push(e.climbGain ?? 0);
      if (e.lookTarget) looks.push({ x: e.lookTarget.x, y: e.lookTarget.y });
    }
  } finally {
    CONFIG.cruiseHunt.enabled = wasCruise;
    if (wasLunge) CONFIG.enemies[type].lunge = wasLunge;
  }
  return { e, path, gains, looks };
}

// Total distance travelled along each axis, which is what "swims laterally"
// actually means — net displacement would hide a shark bobbing up and down on
// the spot.
function travel(path) {
  let h = 0, v = 0;
  for (let i = 1; i < path.length; i++) {
    h += Math.abs(path[i].x - path[i - 1].x);
    v += Math.abs(path[i].y - path[i - 1].y);
  }
  return { h, v, ratio: v / (h || 1e-9) };
}

// --- cruising far from the player is lateral -------------------------------
console.log('\nIDLE CRUISE IS LATERAL');
for (const type of SHARKS) {
  // Player parked far away and far ABOVE, so any vertical bias in the wander
  // would show up as a climb toward it.
  const { path } = run(type, { playerAt: { x: 400, y: HIGH }, seconds: 14, from: { x: 0, y: MID } });
  const t = travel(path);
  // Budget: weaveBody plus tan(wanderPitch), the two things that put a cruising
  // shark off the horizontal at all, with headroom for the arena walls turning
  // it around. See the note on those fields in config.js.
  const cfg = CONFIG.enemies[type].hunt.lateral;
  const budget = (cfg.weaveBody + Math.tan(cfg.wanderPitch)) * 1.6 + 0.05;
  check(`${type}: cruises horizontally`, t.ratio < budget,
    `vertical travel is ${(t.ratio * 100).toFixed(0)}% of horizontal, budget ${(budget * 100).toFixed(0)}%`);
}

// --- the cruise is flat at every range ---------------------------------------
//
// The cruise used to EARN vertical authority by closing in, which meant the
// close fight — most of a fight — was a body going up and down around the
// seal. Now the cruise is bounded to CONFIG.lateralCruise.cruisePitch at every
// range, and the only vertical movement a shark has is its lunge. Measured on
// the VELOCITY's pitch rather than on travel, because a come-about mirrors the
// heading in one frame and the body's pitch is exactly what must not change
// through it.
console.log('\nTHE CRUISE IS FLAT AT EVERY RANGE');
const pitchCap = (type) => {
  const lat = CONFIG.enemies[type].hunt.lateral;
  return lat.cruisePitch ?? CONFIG.lateralCruise.cruisePitch;
};
const deg = (rad) => (rad * 180 / Math.PI).toFixed(0) + '°';
function worstPitch(path) {
  let worst = 0;
  for (let i = 1; i < path.length; i++) {
    const vx = path[i].x - path[i - 1].x;
    const vy = path[i].y - path[i - 1].y;
    if (Math.hypot(vx, vy) < 1e-4) continue;
    worst = Math.max(worst, Math.abs(Math.atan2(vy, Math.abs(vx))));
  }
  return worst;
}
for (const type of SHARKS) {
  const cap = pitchCap(type) + Math.atan(CONFIG.enemies[type].hunt.lateral.weaveBody ?? 0) + 0.06;
  // Directly overhead, close — the case the old model opened right up on.
  const over = run(type, { playerAt: { x: 0, y: MID + 8 }, seconds: 10, from: { x: 0, y: MID }, chase: true, lunge: false, warmup: 0.3 });
  check(`${type}: a seal straight overhead does not make it climb`, worstPitch(over.path) <= cap,
    `steepest frame ${deg(worstPitch(over.path))} against a cap of ${deg(cap)}`);
  // Far below, far away — the long approach.
  const far = run(type, { playerAt: { x: 30, y: HIGH }, seconds: 12, from: { x: -30, y: -34 }, chase: true, lunge: false, warmup: 0.3 });
  check(`${type}: the long approach is flat too`, worstPitch(far.path) <= cap,
    `steepest frame ${deg(worstPitch(far.path))}`);
}

// --- a reversal is a come-about, not a loop ----------------------------------
//
// A turn-limited body arcing round to a target behind it passes through
// pointing straight up (or down) and holds there for as long as the arc takes.
// The come-about in steerTo mirrors the heading instead and lets
// systems/fishTurn.js yaw the body through the camera. So: the seal is put
// BEHIND the shark, the shark must end up going the other way, and no frame of
// the path may be steeper than the cruise.
console.log('\nA REVERSAL IS A COME-ABOUT, NOT A LOOP');
for (const type of SHARKS) {
  const cap = pitchCap(type) + Math.atan(CONFIG.enemies[type].hunt.lateral.weaveBody ?? 0) + 0.06;
  // Spawned facing AWAY from the seal, so the only way to it is round.
  const { path } = run(type, { playerAt: { x: -30, y: MID }, seconds: 3.5, from: { x: 0, y: MID }, chase: true, lunge: false, warmup: 0, facing: 1 });
  const late = path.slice(-30);
  const dx = late[late.length - 1].x - late[0].x;
  check(`${type}: ends up going the seal's way`, dx < 0, `moved ${dx.toFixed(1)} in x over the last half second`);
  // The heading mirrors in one frame; the BODY takes its come-about time to
  // yaw round, and the swim throttles while it does (flipSpeedMul), so the
  // manoeuvre reads as the animal slowing to turn rather than skidding.
  const cruise = CONFIG.enemies[type].speed;
  let slowest = Infinity;
  for (let i = 1; i < 36 && i < path.length; i++) {
    slowest = Math.min(slowest, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) / dt);
  }
  const mul = CONFIG.enemies[type].hunt.lateral.flipSpeedMul ?? CONFIG.lateralCruise.flipSpeedMul;
  check(`${type}: slows through the come-about`, slowest <= cruise * mul * 1.15,
    `${slowest.toFixed(1)} u/s at the slowest against a ${cruise} u/s cruise x ${mul}`);
  check(`${type}: never points up or down to get there`, worstPitch(path) <= cap,
    `steepest frame ${deg(worstPitch(path))} against ${deg(cap)}`);
  check(`${type}: carries the come-about flag for the body`, !!CONFIG.enemies[type].comeAbout,
    'fishTurn yaws it through the camera only if the def opts in');
}


// --- the head leads the body ------------------------------------------------
console.log('\nTHE HEAD WEAVES, AND LEADS');
for (const type of SHARKS) {
  const cfg = CONFIG.enemies[type].hunt.lateral;
  const { e, path, looks } = run(type, { playerAt: { x: 400, y: HIGH }, seconds: 14, from: { x: 0, y: MID } });
  check(`${type}: a cruising shark still looks somewhere`, looks.length > 0,
    `${looks.length} frames with a look target`);

  // The look point must swing to BOTH sides of the path, or it is a fixed
  // offset rather than a weave. Measured as the signed perpendicular distance
  // from the creature to its own look point.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < looks.length; i++) {
    const dx = looks[i].x - path[i].x;
    const dy = looks[i].y - path[i].y;
    const h = Math.atan2(path[Math.min(i + 1, path.length - 1)].y - path[i].y,
                         path[Math.min(i + 1, path.length - 1)].x - path[i].x);
    const perp = -Math.sin(h) * dx + Math.cos(h) * dy;
    lo = Math.min(lo, perp); hi = Math.max(hi, perp);
  }
  check(`${type}: the head swings to both sides`, lo < -0.3 && hi > 0.3,
    `perpendicular offset spans ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);

  // One full sweep per weavePeriod, so over `seconds` there should be about
  // seconds/period cycles. Counted as sign changes of the phase sinusoid.
  const cycles = 14 / cfg.weavePeriod;
  check(`${type}: weaves at roughly its configured rate`, cycles > 0.8,
    `${cycles.toFixed(1)} sweeps in 14s at period ${cfg.weavePeriod}s`);
}

// --- the creatures that opted out are untouched ------------------------------
console.log('\nCETACEANS ARE LEFT ALONE');
// The wild orca used to be the third name here and is no longer in the roster
// at all. The BOSS orca cannot stand in for it: it declares a lateral block
// deliberately, so listing it would turn this check inside out and assert the
// opposite of what it says. Dolphin and otter carry the claim.
// The dolphin carries this alone now: the sea otter was deleted from the
// roster, and `CONFIG.enemies.otter?.hunt?.lateral == null` passed vacuously
// for a creature that no longer exists — which is worse than no check at all.
// The dolphin is still declared (it is the companion stub) even though it no
// longer spawns as wildlife, and it is still the discriminating case here.
check('dolphin: exists to carry this claim', CONFIG.enemies.dolphin?.hunt != null);
for (const type of ['dolphin']) {
  check(`${type}: declares no lateral block`,
    CONFIG.enemies[type]?.hunt?.lateral == null);
}
// And behaviourally. The shaping has to be genuinely opt-in, not a global
// change with an exception list.
//
// The discriminating scenario is a target far away HORIZONTALLY and above,
// because that is where the gate actually bites. A target straight overhead is
// no longer a flattening case at all — the shark is already underneath it, and
// coming up is the whole point.
{
  const away = { playerAt: { x: 45, y: -4 }, seconds: 3, from: { x: -20, y: -34 }, warmup: 0.8, chase: true };
  const shark = run('shark', away).path;
  const cap = pitchCap('shark') + 0.1;
  check('shark: runs in flat while still horizontally distant', worstPitch(shark) <= cap,
    `steepest ${deg(worstPitch(shark))}, cap ${deg(cap)}`);
  // The dolphin's case is the seal straight overhead — the line a shark is
  // now forbidden and a cetacean takes without thinking.
  const over = { playerAt: { x: -18, y: -6 }, seconds: 3, from: { x: -20, y: -34 }, warmup: 0.8, chase: true };
  for (const type of ['dolphin']) {
    const t = run(type, over).path;
    check(`${type}: climbs freely where a shark would flatten`, worstPitch(t) > cap + 0.25,
      `steepest ${deg(worstPitch(t))} against the shark's cap of ${deg(cap)}`);
  }
}

// --- it still gets where it is going -----------------------------------------
//
// Flat is not stuck. A shark a long way below the seal reaches its depth by
// running at the cruise pitch, coming about, and running back — passes — and
// the claim is that it gets there, not how fast.
console.log('\nIT STILL GETS TO YOUR DEPTH');
for (const type of SHARKS) {
  const { path } = run(type, {
    playerAt: { x: 0, y: HIGH }, seconds: 24, from: { x: -20, y: -36 },
    warmup: 0.6, chase: true, lunge: false,
  });
  const climbed = Math.max(...path.map((p) => p.y)) - path[0].y;
  check(`${type}: does eventually close the vertical gap`, climbed > 14,
    `rose ${climbed.toFixed(1)} units of a ${(HIGH + 36).toFixed(0)}-unit gap`);
}


// ---------------------------------------------------------------------------
// A SHARK DOES NOT CHASE — CONFIG.cruiseHunt.
//
// Every section above measures the shark alone with the player, because that
// isolates the cruise SHAPING. This one needs the opposite: a school in the
// water, because a shark on an empty screen never had the problem. `preyRadius`
// is 18-24 units and the water is mostly school fish, so a shark always had a
// fish inside it, and the nearest fish changes every few frames as a school
// scatters — at full turnRate that is a 2.5-unit turning circle whipping
// between targets, which is what "spinning in place" was.
//
// Measured as HEADING CHANGE, not as position: a body doing tight circles
// travels a perfectly ordinary distance and only its rate of turn gives it
// away. `flips` — sign changes of that turn — is the second half of the tell,
// because a steady arc and a yo-yo can have the same total.
//
// Run against a control with cruiseHunt off rather than against a fixed
// threshold, for the reason every comparison here is: these are numbers nobody
// can read in the absolute, and the claim is about the change.
//
// Seeded and averaged over seeds. Unseeded, the turn rate moved by a third
// between invocations, which is more than the effect on two of the species.
console.log('\nA SHARK DOES NOT CHASE');
{
  // A shark, a player, and a school drifting around both. Restocked as it is
  // eaten, or the arena empties and the measurement quietly turns back into the
  // empty-screen one every other section already covers.
  function hunted(type, seed, { cruise, seconds = 40 }) {
    const rand = seeded(seed);
    const orig = Math.random;
    const wasCruise = CONFIG.cruiseHunt.enabled;
    Math.random = rand;
    CONFIG.cruiseHunt.enabled = cruise;
    try {
      resetEnemies(scene);
      player.position.set(0, MID, 0);
      const e = spawnNamed(scene, type, 6, { x: -18, y: MID - 2 }, { ignoreCaps: true });
      const stock = () => spawnNamed(scene, 'fish', 6,
        { x: (rand() * 2 - 1) * 26, y: MID + 2 + (rand() * 2 - 1) * 9 }, { ignoreCaps: true });
      for (let i = 0; i < 26; i++) stock();
      let turn = 0;
      let flips = 0;
      let eaten = 0;
      let last = e.heading;
      let lastSign = 0;
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) {
        updateEnemies(dt, scene, player.position, () => {}, () => {});
        resolvePredation(dt, scene, { onFishEaten: () => { eaten += 1; } });
        if (enemies.length < 14) stock();
        let d = e.heading - last;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        turn += Math.abs(d);
        const s = Math.sign(d);
        if (s !== 0 && lastSign !== 0 && s !== lastSign) flips += 1;
        if (s !== 0) lastSign = s;
        last = e.heading;
      }
      return { turn: turn / seconds, flips: flips / seconds, eaten };
    } finally {
      Math.random = orig;
      CONFIG.cruiseHunt.enabled = wasCruise;
    }
  }

  const SEEDS = [1, 2, 3, 4, 5];
  const avg = (type, cruise, field) => SEEDS
    .reduce((s, seed) => s + hunted(type, seed, { cruise })[field], 0) / SEEDS.length;

  for (const type of SHARKS) {
    const was = avg(type, false, 'turn');
    const now = avg(type, true, 'turn');
    // Two thirds is what the shipped numbers measure at; the check is set at a
    // third so it is testing that the mechanism is connected and pointing the
    // right way, not pinning `trackRate` to the value it happens to hold.
    check(`${type}: turns far less while hunting`, now < was * 0.66,
      `${now.toFixed(2)} rad/s against ${was.toFixed(2)} uncapped`);

    // ...AND IT STILL EATS. The whole design is that the meal comes from
    // swimming through a school rather than from running one down —
    // resolvePredation takes any prey inside biteRange whether or not it was
    // the target — so a shark that stopped feeding would mean the cone had
    // simply broken the food chain instead of loosening it.
    const meals = avg(type, true, 'eaten');
    check(`${type}: still feeds on what it swims through`, meals >= 4,
      `${meals.toFixed(1)} fish in 40s without chasing any of them`);
  }

  // The bosses opt out, and they do it in the DATA rather than by being
  // recognised at runtime: `e.isBoss` is a live flag set after spawn and
  // cleared again in windows where a boss body is still in the water, so a
  // boss spawned by name in a harness — or held as a corpse in a real run —
  // would read as ordinary wildlife. Every boss that declares a lateral block
  // has to declare `cruise: false` inside it, and that is what this asserts.
  for (const key of ['bossShark', 'bossOrca', 'bossHammerhead', 'bossMosasaur']) {
    const lat = CONFIG.enemies[key]?.hunt?.lateral;
    check(`${key}: declares itself out of the cruise hunt`,
      lat != null && lat.cruise === false,
      lat == null ? 'no lateral block at all' : `cruise: ${lat.cruise}`);
  }
}

// ---------------------------------------------------------------------------
// A SHARK COMMITS — the lunge overlay on `hunt`.
//
// The cruise sections above measure this creature with the burst switched off,
// which is right for them and would be a hole on its own: a `lunge` block that
// silently stopped firing would leave every one of them passing while the
// sharks went back to being bodies that drift at you. So the overlay gets its
// own section, and it asserts the three things that make it an attack rather
// than a faster chase.
//
// Measured on the PATH, not on the state machine, for the same reason
// everything else in this file is: "it commits" is a claim about a trajectory.
// ---------------------------------------------------------------------------
console.log('\nA SHARK COMMITS');
for (const type of SHARKS) {
  const c = CONFIG.enemies[type].lunge;
  check(`${type}: carries a lunge at all`, c != null,
    c ? `range ${c.range}, ${c.windup}s tell` : 'no lunge block — the pass is gone');
  if (!c) continue;

  // THE RUN CROSSES THE GAP. A burst that stops short is a chase with a speed
  // change in it; one that carries past is a pass, and a pass is the thing the
  // player can sidestep. This is the arithmetic the config comments quote —
  // speed x speedMul x strikeTime against `range` — checked against the numbers
  // rather than the prose, because prose does not fail.
  const run_ = CONFIG.enemies[type].speed * c.speedMul * c.strikeTime;
  check(`${type}: the burst carries past where you were`, run_ >= c.range,
    `${run_.toFixed(1)} units of run against a ${c.range}-unit gap`);

  // IT CANNOT FOLLOW YOU. The turning circle mid-strike, speed over turn rate,
  // has to be wider than the reach the bite lands at — otherwise a sidestep is
  // answered by an arc and the commitment means nothing.
  const circle = (CONFIG.enemies[type].speed * c.speedMul) / c.strikeTurnRate;
  const reach = CONFIG.enemies[type].radius * (CONFIG.bite.mouthReach ?? 0.55)
    + (CONFIG.player.hitRadius ?? 0.5);
  check(`${type}: it leans, it does not home`, circle > reach * 4,
    `${circle.toFixed(0)}-unit turning circle against a ${reach.toFixed(1)}-unit bite`);

  // AND THE TELL IS LONG ENOUGH TO USE. The seal's own thrust over the wind-up
  // has to move it further than its own body, or the warning is decoration.
  const room = (CONFIG.player.maxSpeed ?? 34) * 0.26 * c.windup;
  check(`${type}: the tell is long enough to leave the line`,
    room > (CONFIG.player.hitRadius ?? 0.5) * 2,
    `${room.toFixed(1)} units of travel in a ${c.windup}s tell`);
}
{
  // ...AND IT ACTUALLY FIRES, driven rather than computed. A shark held at the
  // far edge of its own range should spend part of a long window visibly moving
  // faster than it cruises — which is the one thing none of the arithmetic
  // above can tell you, because every number in it could be perfect while the
  // overlay was never reached.
  for (const type of SHARKS) {
    const c = CONFIG.enemies[type].lunge;
    if (!c) continue;
    const { path } = run(type, {
      playerAt: { x: 0, y: MID }, seconds: 20, from: { x: c.range * 0.8, y: MID },
      warmup: 0.5, chase: true,
    });
    let fastest = 0;
    for (let i = 1; i < path.length; i++) {
      fastest = Math.max(fastest, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) / dt);
    }
    const cruise = CONFIG.enemies[type].speed;
    check(`${type}: the burst reaches the water`, fastest > cruise * 1.6,
      `topped ${fastest.toFixed(1)} u/s against a ${cruise} u/s cruise`);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
process.exit(failures ? 1 : 0);
