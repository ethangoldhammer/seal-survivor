import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { fireBossShot } from './bossPerks.js';
import { pinchReach, clawSetting } from './crabClaw.js';
import { isDazed } from './control.js';
import { activeBossPerk } from './bossPerks.js';
import { tryBossGrab, endBossGrab, playerGrabbed, grabbedBy } from './bossGrab.js';
import { bounds } from '../arena.js';
import { feedback } from './feedback.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing,
} from './organicRing.js';

// ===========================================================================
// THE KING CRAB ANSWERS BACK.
//
// The crab is the one boss with no reach. Every other archetype either swims
// at you (shark, orca), shoots at you (the boat), or refuses to leave a place
// you have to come to (the anglerfish). This one walks, and its whole threat
// is a pinch measured in arm lengths — so the counterplay to the marquee fight
// of an early run was "float up two body lengths and shoot down at it". A boss
// that cannot touch the player from where the player is standing is a boss the
// player ignores, and the fight was won by a decision made once at the start
// of it.
//
// So it fires. FOUR BOLTS, ONE FROM EACH HALF OF EACH CLAW — the two fingers
// of the left cheliped and the two of the right — and that is not decoration:
// four muzzles spread across eight units of body is what makes the volley read
// as coming out of the ANIMAL rather than out of a point in front of it, and
// it is why they converge on the player instead of arriving as one line.
//
// WHY A SYSTEM AND NOT A PERK. The same answer the boat's bombardment and the
// anglerfish's ambush give: perks are things a boss HAS (rolled, swappable,
// and a shark with a lunge is still a shark), and this is what the crab IS.
// Every king crab has it, including the one that opens a run with no perk at
// all — which is the fight this exists to fix. A rolled perk still lands on
// top, so two crab fights are still two fights.
//
// THE PINCH IS UNTOUCHED, and the two never contend for the same moment:
//
//   `minReach` is measured through the SAME pinchReach() the commit gate in
//   entities/enemies.js and the damage check in systems/combat.js use, so the
//   volley starts exactly where the claw stops being able to land. Inside that
//   band the crab pinches — as often as CONFIG.enemies.bossCrab.claw.cooldown
//   permits, which is nearly always — and outside it, it shoots. One animal,
//   two ranges, and no distance at which it is doing neither.
//
//   Nothing here writes `perkDrive`, `vx`/`vy` or the claw chains. The crab
//   keeps walking and keeps reaching while it fires; the bolts leave from
//   wherever the fingers have got to on that frame, which is what welds the
//   attack to the body.
//
// THE MUZZLES ARE BONES, not offsets. `userData.clawRig` already names every
// one of them for systems/crabClaw.js (`tip` is the fixed half of the claw,
// `jaw` the finger that swings), so this reads the same four names rather than
// guessing at a body-frame offset the way the perk GUNS table has to for eyes
// and fins it has no names for. A rig that stops resolving falls back to that
// guess and says so once — a crab firing from its middle is a bad look and a
// crab that silently stopped firing is a fight that quietly lost its answer to
// distance.
//
// ALL FOUR ARE AIMED WHERE THE PLAYER WAS when the volley started, and each
// from its own muzzle, so they converge. The aim is locked at the wind-up's
// end and never steered: the game's rule for every enemy shot that is not the
// boat's seeker, and the reason moving is a dodge.
// ===========================================================================

const cfgOf = (e) => e?.def?.clawVolley ?? null;

/** Does this creature carry a claw volley at all? Data, not a name check. */
export function isVolleyBoss(e) {
  return !!e && !!e.isBoss && !!cfgOf(e);
}

// EVERY BLOCK THIS FILE DRIVES. A creature carrying any one of them is a body
// this system has something to do with — and it is a list rather than one key
// so that switching a feature off in config takes that feature off the crab and
// nothing else with it. Gating the whole file on `clawVolley` meant deleting the
// gun silently deleted the haymaker and the pounce too, which is the kind of
// coupling an `enabled` flag acquires by accident and nothing ever reports.
const CRAB_BLOCKS = ['clawVolley', 'haymaker', 'jump', 'clawGrab'];

/** Is this a boss body with any of the king crab's fight on it? */
export function isCrabBoss(e) {
  return !!e && !!e.isBoss && CRAB_BLOCKS.some((k) => !!e.def?.[k]);
}

export const crabVolleyState = {
  crab: null,
  // 'ready' -> the cooldown running  |  'windup' -> the tell
  // 'firing' -> the four bolts leaving, one at a time
  stage: 'ready',
  timer: 0,
  // How many of the volley's shots have left, this volley.
  fired: 0,
  // The aim, locked when the wind-up ends.
  aimX: 1,
  aimY: 0,
  // What one bolt is worth in THIS fight, with damagePerDifficulty resolved.
  damage: 0,
  rings: [],
  // The four bones, or null once we know the rig will not give them up.
  muzzles: null,
  warned: false,
};

const _muzzle = new THREE.Vector3();
const _world = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// ---------------------------------------------------------------------------
// THE FOUR MUZZLES
// ---------------------------------------------------------------------------
// One entry per HALF of one claw, in the order they fire: left claw's finger,
// left claw's fixed half, then the right. Left-then-right rather than
// finger-then-finger, so the ripple crosses the body and the player can see
// which side is next.
function resolveMuzzles(e) {
  const rig = e?.visual?.userData?.clawRig;
  const out = [];
  for (const arm of rig?.arms ?? []) {
    // `jaw` first: it is the half that MOVES, so a player watching the claw
    // open sees the shot come out of the part that just moved.
    for (const name of [arm.jaw, arm.tip]) {
      if (!name) continue;
      const bone = e.visual.getObjectByName(name);
      if (bone) out.push(bone);
    }
  }
  return out.length ? out : null;
}

// Where shot `i` leaves the body, written into `out`.
//
// A BONE'S LIVE WORLD POSITION, flattened onto the play plane. The claws sit at
// their own depth — the crab is broadside to camera and its arms reach forward
// and back in z — and a projectile born even slightly off the plane sorts
// behind the water, which is the same rule every other emit point in the game
// follows.
//
// The fallback is the perk GUNS table's guess: out along the body's own side,
// in units of the boss's radius, so it moves with a crab that grew.
function muzzleAt(out, e, r, i) {
  const bones = crabVolleyState.muzzles;
  if (bones?.length) {
    const bone = bones[i % bones.length];
    bone.getWorldPosition(_world);
    out.set(_world.x, _world.y, e.mesh.position.z);
    return out;
  }
  const c = cfgOf(e) ?? {};
  const s = Math.hypot(e.vx ?? 0, e.vy ?? 0);
  if (s > 1e-3) _fwd.set(e.vx / s, e.vy / s, 0);
  else _fwd.set(Math.cos(e.heading ?? 0), Math.sin(e.heading ?? 0), 0);
  // FOUR DISTINCT POINTS, in the shape the bones have: two claws either side
  // of the axis, and the two halves of each claw a little apart along it.
  // Alternating a single sign would put four shots on two origins, which is
  // the fallback quietly telling a different story from the rig it stands in
  // for — a pair of double-barrels rather than four claw halves.
  const sign = i < 2 ? 1 : -1;
  const half = i % 2 === 0 ? 1 : -1;
  const side = (c.fallbackSide ?? 0.5) * r * sign;
  const fwd = ((c.fallbackForward ?? 0.55) + (c.fallbackHalfGap ?? 0.16) * half) * r;
  out.set(
    e.mesh.position.x + _fwd.x * fwd - _fwd.y * side,
    e.mesh.position.y + _fwd.y * fwd + _fwd.x * side,
    e.mesh.position.z,
  );
  return out;
}

// The gun, in the shape fireBossShot wants. Built per fight rather than held as
// a constant so the asset and the look are a config change — the numbers that
// decide what it HITS for stay in CONFIG.enemies.bossCrab.clawVolley beside the
// claw's own, where the rest of this creature's gameplay lives.
function gunOf(c) {
  return {
    asset: c.asset ?? 'crabBolt',
    attack: c.attack ?? 'kinetic',
    color: c.color ?? 0xbfe9ff,
    radius: c.hitRadius ?? 0.42,
    scale: c.scale ?? 1,
    orient: true,
    origins: 4,
  };
}

// ---------------------------------------------------------------------------
// THE TELL
// ---------------------------------------------------------------------------
// FOUR RINGS, ONE PER MUZZLE, and not one on the body. Where the shot is coming
// FROM is the information — the shooters' rule in systems/bossPerks.js, and it
// matters more here than it does there, because these four origins are spread
// across the widest silhouette in the roster and the player is being told which
// side of the crab to be on.
function makeRings(scene, c) {
  dropRings();
  for (let i = 0; i < 4; i++) {
    const ring = makeOrganicRing({
      type: c.attack ?? 'kinetic',
      thickness: 0.2,
      renderOrder: 6,
    });
    ring.visible = false;
    scene.add(ring);
    crabVolleyState.rings.push(ring);
  }
}

function dropRings() {
  for (const ring of crabVolleyState.rings) {
    // Its OWN parent, not a scene handed in: a boss can die on a path with no
    // scene to hand, and a ring removed from the wrong parent stays in the
    // water. The anglerfish's dropRing, for the anglerfish's reason.
    ring.parent?.remove(ring);
    disposeOrganicRing(ring);
  }
  crabVolleyState.rings.length = 0;
}

/**
 * Give this boss its claw volley, if it is a body that carries one.
 *
 * Called from spawnBoss beside attachBossBoat and attachAngler. The difficulty
 * is read ONCE, here, exactly as attachBossPerk resolves a perk's
 * damagePerDifficulty at attach: what a bolt is worth is a fact about this
 * fight, and a number re-derived per shot from a difficulty that moves during
 * the fight is a volley that gets stronger while it is in the air.
 */
export function attachBossCrab(scene, e, difficulty = 0, level = 0) {
  releaseBossCrab();
  if (!isCrabBoss(e)) return;
  const c = cfgOf(e) ?? {};
  // THE MELEE ARMS FIRST, and independently of the gun. They are two features
  // sharing one file because they are one animal, not because one implies the
  // other — switching the volley off in config must not quietly take the
  // haymaker with it, which is exactly the kind of coupling an `enabled` flag
  // acquires by accident.
  armMelee(e, level);
  if (!cfgOf(e) || c.enabled === false) return;

  crabVolleyState.crab = e;
  crabVolleyState.stage = 'ready';
  // ARRIVES ON COOLDOWN rather than armed. A boss whose first volley leaves
  // while the player is still reading the banner spends the one wind-up that
  // teaches the tell on a player who is not looking at it.
  crabVolleyState.timer = Math.max(0, c.settle ?? (c.cooldown ?? 4.5));
  crabVolleyState.fired = 0;
  crabVolleyState.damage = Math.max(0,
    (c.damage ?? 8) + (c.damagePerDifficulty ?? 0) * Math.max(0, difficulty));
  crabVolleyState.muzzles = resolveMuzzles(e);
  if (!crabVolleyState.muzzles && !crabVolleyState.warned) {
    crabVolleyState.warned = true;
    console.warn('[bossCrab] the claw rig named no bones this body has — the volley '
      + 'will fire from a body-frame guess instead of from the claws. Check '
      + 'ASSETS.enemyBossCrab.clawRig against the model (npm run bones).');
  }
  makeRings(scene, c);
}

/**
 * The fight is over, or the body is leaving. Nothing here outlives it.
 *
 * Bolts already in the water fly on — they are ordinary enemy projectiles and
 * resetProjectiles owns them, which is the same split the barrels keep.
 */
export function releaseBossCrab() {
  dropRings();
  releaseMelee();
  crabVolleyState.crab = null;
  crabVolleyState.stage = 'ready';
  crabVolleyState.timer = 0;
  crabVolleyState.fired = 0;
  crabVolleyState.damage = 0;
  crabVolleyState.muzzles = null;
}

/** Put everything back on a run reset. */
export function resetBossCrab() {
  releaseBossCrab();
  crabVolleyState.warned = false;
}

/**
 * How close the player has to be before the pinch owns the range instead.
 *
 * MEASURED THROUGH THE CLAW, not typed in world units. `armReach` is what
 * systems/crabClaw.js measured off the posed skeleton, so this band moves with
 * a bigger crab, a re-rigged arm and a retuned commit gate — the third of
 * which has killed the pinch twice already by drifting away from a number
 * written down somewhere else (see pinchReach).
 */
export function volleyMinRange(e) {
  const c = cfgOf(e) ?? {};
  return pinchReach(e?.claw?.reach?.() ?? 0, CONFIG.player?.hitRadius ?? 1, c.minReach ?? 1.15);
}

/**
 * The cadence. Called from updateBossAbilities AFTER the perks, like the boat
 * and the ambush — a perk that moved the animal this frame moved the claws
 * with it, and a volley aimed from last frame's position is a volley that
 * misses by exactly one frame of a boss's stride.
 */
export function updateBossCrab(dt, scene, playerPos, hooks = {}) {
  // THE MELEE CHAIN FIRST, off its OWN state — it owns the body, a swing half
  // way through its wind-up has to keep being ticked whatever the gun is doing,
  // and the two are independent features (the volley can be switched off in
  // config and the crab still swings). Hanging this off the volley's record was
  // a bug for exactly that last reason. See the section at the foot of the file.
  // THE SUBJECT HAS TO STILL BE IN THE WATER. `hp <= 0` and a missing mesh, the
  // same two questions updateBossPerks asks and for the same reason: nothing
  // here owns the creature's lifetime, and a boss killed mid-swing has to hand
  // the seal and the body back rather than keep driving a corpse.
  const m = crabMeleeState.crab;
  if (m && (!m.mesh || m.hp <= 0)) releaseMelee();
  else if (m) {
    updateMelee(dt, m, playerPos, hooks, Math.hypot(
      (playerPos?.x ?? 0) - m.mesh.position.x,
      (playerPos?.y ?? 0) - m.mesh.position.y,
    ) || 0.0001);
  }

  const e = crabVolleyState.crab;
  if (!e || !e.mesh || e.hp <= 0 || !isVolleyBoss(e)) return;
  const c = cfgOf(e);
  const r = e.radius ?? 1;

  const dist0 = Math.hypot(
    (playerPos?.x ?? 0) - e.mesh.position.x,
    (playerPos?.y ?? 0) - e.mesh.position.y,
  ) || 0.0001;

  // THE GUN GOES QUIET WHILE THE ARMS ARE BUSY. A crab that fired four
  // bolts out of the middle of a haymaker would be spending two attacks on one
  // moment, and the second one would be invisible underneath the first. The
  // wind-up, the lunge, the hold and the throw are all one gesture as far as
  // this is concerned.
  if (crabMeleeState.crab === e && crabMeleeState.stage !== 'ready') {
    hideRings(dt);
    if (crabVolleyState.stage === 'windup') {
      crabVolleyState.stage = 'ready';
      crabVolleyState.timer = Math.max(0.5, (c.cooldown ?? 4.5) * 0.4);
    }
    return;
  }

  // A BOSS STILL MAKING ITS ENTRANCE IS NOT DOING ANYTHING YET. The ceremony is
  // a promise that nothing is happening, and a volley out of it would be the
  // one attack in the run the player genuinely could not have played around.
  // The same `invuln` gate the perks take, and anything half-built is dropped
  // rather than resumed: a tell nobody could see is not a tell.
  if ((e.invuln ?? 0) > 0) {
    hideRings(dt);
    if (crabVolleyState.stage !== 'ready') {
      crabVolleyState.stage = 'ready';
      crabVolleyState.timer = Math.max(0, c.settle ?? (c.cooldown ?? 4.5));
    }
    return;
  }

  // DAZED. The tell it was building is cancelled and no new one starts while it
  // is reeling — but a volley already leaving runs to the end. The perks' split,
  // for the perks' reason: a wind-up is a promise the boss has not kept yet, and
  // shots already in the water are one it has.
  if (isDazed(e) && crabVolleyState.stage !== 'firing') {
    hideRings(dt);
    if (crabVolleyState.stage === 'windup') {
      crabVolleyState.stage = 'ready';
      // A short timer rather than a full cooldown: the player bought a window,
      // not a denial, so it re-telegraphs a beat after the daze lets go.
      crabVolleyState.timer = Math.max(0.5, (c.cooldown ?? 4.5) * 0.4);
    }
    return;
  }

  const dx = (playerPos?.x ?? 0) - e.mesh.position.x;
  const dy = (playerPos?.y ?? 0) - e.mesh.position.y;
  const dist = dist0;

  if (crabVolleyState.stage === 'ready') {
    hideRings(dt);
    crabVolleyState.timer -= dt;
    if (crabVolleyState.timer > 0) return;
    // THE COOLDOWN RUNS WHEREVER YOU ARE, the wind-up only starts inside the
    // band. Otherwise kiting out banks a volley that arrives the instant the
    // player comes back, and `range` would be teaching them a lie about when
    // it is safe to approach — the shooters' rule, next door.
    if (dist > (c.range ?? 46)) return;
    // ...and NOT while the pinch can reach: inside that band the claw is the
    // attack, and it lands often enough (see the cooldown note in
    // CONFIG.enemies.bossCrab.claw) that a volley on top of it would be the
    // crab spending its whole threat budget in the one place the player is
    // already being punished.
    if (dist < volleyMinRange(e)) return;
    crabVolleyState.stage = 'windup';
    crabVolleyState.timer = Math.max(0.05, c.windup ?? 0.7);
    return;
  }

  if (crabVolleyState.stage === 'windup') {
    const total = Math.max(0.05, c.windup ?? 0.7);
    const t = 1 - Math.max(0, crabVolleyState.timer) / total;
    showRings(dt, e, r, t);
    crabVolleyState.timer -= dt;
    if (crabVolleyState.timer > 0) return;
    // THE AIM IS TAKEN HERE, once, and every bolt of the volley uses it. Each
    // still leaves from its own muzzle, so four origins pointed at one place
    // converge — which is what makes a spread-out animal's volley read as one
    // attack rather than four.
    crabVolleyState.aimX = dx / dist;
    crabVolleyState.aimY = dy / dist;
    crabVolleyState.stage = 'firing';
    crabVolleyState.fired = 0;
    crabVolleyState.timer = 0;
    return;
  }

  // Firing. One bolt per `stagger`, so the four cross the body left to right
  // instead of arriving as a wall — the same four shots, but with a shape the
  // player can move through.
  showRings(dt, e, r, 1);
  crabVolleyState.timer -= dt;
  while (crabVolleyState.fired < 4 && crabVolleyState.timer <= 0) {
    fireOne(scene, e, r, c, crabVolleyState.fired);
    crabVolleyState.fired += 1;
    crabVolleyState.timer += Math.max(0, c.stagger ?? 0.09);
  }
  if (crabVolleyState.fired >= 4) {
    crabVolleyState.stage = 'ready';
    crabVolleyState.timer = Math.max(0.5, c.cooldown ?? 4.5);
  }
}

function fireOne(scene, e, r, c, i) {
  const gun = gunOf(c);
  muzzleAt(_muzzle, e, r, i);
  fireBossShot(scene, {
    gun,
    origin: _muzzle,
    dirX: crabVolleyState.aimX,
    dirY: crabVolleyState.aimY,
    damage: crabVolleyState.damage,
    speed: c.speed ?? 24,
    life: c.life ?? 3.2,
    // Filed against the ATTACK and not the species, so the playtest ledger can
    // say the claw volley killed you rather than "a bossCrab did" — the same
    // reason every perk files under `boss:<perk>`.
    source: 'boss:clawVolley',
  });
}

function showRings(dt, e, r, t) {
  const rings = crabVolleyState.rings;
  const radius = Math.max(0.35, r * 0.22);
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    ring.visible = true;
    muzzleAt(_muzzle, e, r, i);
    // PLACED EVERY FRAME rather than parented to the claw: the ring is a flat
    // world-space disc and a parent that rotates would cant it out of the play
    // plane. The anglerfish's tell, for the anglerfish's reason.
    placeOrganicRing(ring, _muzzle.x, _muzzle.y, radius, e.mesh.position.z + 0.02);
    updateOrganicRing(ring, dt, { opacity: 0.3 + 0.7 * t, sweepIn: t, charge: t });
  }
}

function hideRings(dt) {
  for (const ring of crabVolleyState.rings) {
    if (!ring.visible) continue;
    ring.visible = false;
    updateOrganicRing(ring, dt, { opacity: 0 });
  }
}

// ===========================================================================
// THE HAYMAKER, THE POUNCE AND THE CLAW GRAB
// ===========================================================================
// Everything above is the crab answering a player who stands off. This half is
// what happens when they come close, and it is one state machine because the
// three are one attack chain:
//
//   REAR    both claws hauled up and back over a second — the ordinary pinch's
//           own gesture on CONFIG.crabClaw.big's longer clock. The tell.
//   LUNGE   the body commits down a line locked at the end of the rear-up and
//           never steered afterwards. `ramming` goes up here, which is what
//           makes getting out of the way pay (systems/dodge.js polls that flag
//           and refills the boost meter for a committed run that missed — this
//           file did not have to be told, and a future move that sets the same
//           flag inherits it).
//   GRAB    if the claw shut on the seal, it keeps hold: the player is pinned
//           to the CLAW BONE for half a second while the crab decides what to
//           do with them.
//   THROW   the arm performs it. A slam drives the claw into the seabed with
//           the seal in it; a hurl swings up and out along a rolled direction
//           and lets go at the top. Either way the IK target is what moves and
//           the seal follows the claw — see `clawAim` in entities/enemies.js.
//
// ...and the POUNCE, which is a delivery rather than an attack: a leap off the
// sand at a seal hugging the seabed, for the crab bosses of a late run. It is
// ballistic and not a swim — crawlers already fall (CONFIG.crabPhysics.gravity)
// and are already capped at `crawl.groundHeight` off the bed, so a jump is one
// upward impulse and the physics that were there all along.
//
// ---------------------------------------------------------------------------
// ONLY THE HAYMAKER GRABS, and that is a balance decision worth stating.
// ---------------------------------------------------------------------------
// The king crab's ordinary pinch lands twenty times in twenty seconds
// (tools/crab-claw-test.mjs measures exactly that) — it is a jab, and a grab on
// each one would be a fight the player never drives again. The grab hangs off
// the one swing that is rare, telegraphed for a second, and dodgeable, and it
// carries its own cooldown on top of the haymaker's.
//
// ---------------------------------------------------------------------------
// HOW IT MOVES THE BODY. Through `perkDrive`, the same door systems/bossPerks.js
// uses: raised, it makes updateEnemies skip the creature's own steering for the
// frame and leaves the velocity to whoever raised it. Gravity is NOT skipped —
// it is applied to every crawler outside that branch — which is exactly what
// the pounce needs and what the lunge is written around.
//
// AND IT YIELDS TO A PERK. A rolled perk mid-lunge or mid-teleport owns the
// body, and this file runs after updateBossPerks; without the yield the two
// would write the same velocity every frame and the perk would lose. The
// anglerfish's rule, for the anglerfish's reason.
// ===========================================================================

const meleeCfg = (e, key) => e?.def?.[key] ?? null;

export const crabMeleeState = {
  crab: null,
  // 'ready' | 'rear' | 'lunge' | 'held' | 'throw' | 'air'
  stage: 'ready',
  timer: 0,
  // Cooldowns run independently of the stage, so a fight is not a queue.
  swingCd: 0,
  jumpCd: 0,
  grabCd: 0,
  // The line the lunge locked, and how long it has left to run.
  dirX: 1,
  dirY: 0,
  // The throw in progress: 'slam' or 'hurl', where the claw is being driven,
  // and where it started.
  throwKind: null,
  throwT: 0,
  // The record handed to systems/bossGrab.js for the length of one grab, and
  // the channel the throw is handed back through. Null the rest of the time.
  clawRecord: null,
  fromX: 0,
  fromY: 0,
  toX: 0,
  toY: 0,
  // The player's level at the arrival, which is what decides whether this body
  // is allowed to leave the ground. Read once: a boss does not get new moves
  // half way through its own fight.
  level: 0,
  // Counters, for the harness and for anything that later wants to say so.
  swings: 0,
  jumps: 0,
  grabs: 0,
  slams: 0,
  hurls: 0,
};

const _tip = new THREE.Vector3();
const _aim = { x: 0, y: 0 };

function armMelee(e, level) {
  const s = crabMeleeState;
  s.crab = e;
  s.stage = 'ready';
  s.timer = 0;
  s.level = level ?? 0;
  // Both arrive on their own settle, for the volley's reason: the opening of a
  // fight is the ordinary crab, and the big swings are what it escalates into.
  s.swingCd = Math.max(0, meleeCfg(e, 'haymaker')?.settle ?? 4.5);
  s.jumpCd = Math.max(0, meleeCfg(e, 'jump')?.settle ?? 6);
  s.grabCd = 0;
  s.throwKind = null;
  s.clawRecord = null;
}

function releaseMelee() {
  const s = crabMeleeState;
  const e = s.crab;
  if (e) {
    // Everything this file wrote ONTO THE CREATURE, put back. A `perkDrive`
    // left raised is an animal that never steers again, and a `clawAim` left
    // set is an arm reaching at a point in the water for the rest of the run —
    // both outlive the body through the pool, and neither says anything when
    // it happens. Same contract releaseBoss() keeps next door.
    e.perkDrive = false;
    e.ramming = false;
    e.clawAim = null;
    e.claw?.hold(false);
  }
  // ...and the seal is put down. Not spat: this path is the fight ENDING (the
  // boss died, the run reset, the toggle went off), and there is nobody left to
  // throw it.
  if (e && playerGrabbed() && grabbedBy() === e) endBossGrab(false);
  s.crab = null;
  s.stage = 'ready';
  s.timer = 0;
  s.throwKind = null;
  s.clawRecord = null;
}

/** Reach at which the big swing is worth starting, in world units. */
export function haymakerRange(e) {
  const c = meleeCfg(e, 'haymaker') ?? {};
  return pinchReach(e?.claw?.reach?.() ?? 0, CONFIG.player?.hitRadius ?? 1, c.reachMul ?? 2.6);
}

/** May this body leave the ground at all? A fact about the run, not the frame. */
export function canPounce(e, level = crabMeleeState.level) {
  const j = meleeCfg(e, 'jump');
  if (!j || j.enabled === false) return false;
  return (level ?? 0) >= (j.minLevel ?? 0);
}

// How long the rear-up lasts on this creature — the shared pinch's wind-up
// times the haymaker profile's multiplier. Read from the same config the claw
// driver reads rather than restated, so the body and the arm can never disagree
// about when the slam is coming; that disagreement is the crab bug this project
// has now had three times (see pinchReach).
function rearTime(e) {
  const base = clawSetting(e.def, 'windup') ?? 0.42;
  return Math.max(0.05, base * (CONFIG.crabClaw?.big?.windupMul ?? 1));
}

function onGround(e) {
  return e.mesh.position.y <= bounds.bottom + (e.radius ?? 1) * 1.15;
}

/**
 * The melee chain. Called from updateBossCrab, ahead of the volley, so a swing
 * that has taken the body cannot be interrupted by the gun and the gun goes
 * quiet for as long as the arms are busy.
 */
function updateMelee(dt, e, playerPos, hooks, dist) {
  const s = crabMeleeState;
  const hc = meleeCfg(e, 'haymaker') ?? {};
  const gc = meleeCfg(e, 'clawGrab') ?? {};
  const jc = meleeCfg(e, 'jump') ?? {};

  s.swingCd = Math.max(0, s.swingCd - dt);
  s.jumpCd = Math.max(0, s.jumpCd - dt);
  s.grabCd = Math.max(0, s.grabCd - dt);

  // --- carrying the seal ----------------------------------------------------
  // Above everything else, because a crab holding the player is not deciding
  // whether to do anything else.
  if (s.stage === 'held' || s.stage === 'throw') {
    driveGrab(dt, e, gc, hooks);
    return;
  }

  // A perk owns the body — see the yield note above. Anything half-built is
  // dropped rather than resumed: the perk has moved the animal somewhere else,
  // and a lunge that carried on afterwards would run a line it never aimed.
  const perk = activeBossPerk();
  if (perk && perk.stage && perk.stage !== 'ready' && perk.enemy === e) {
    if (s.stage !== 'ready') standDown(e);
    return;
  }

  // --- the committed run ----------------------------------------------------
  if (s.stage === 'lunge') {
    s.timer -= dt;
    e.perkDrive = true;
    e.ramming = true;
    e.vx = s.dirX * (hc.lungeSpeed ?? 26);
    e.vy = s.dirY * (hc.lungeSpeed ?? 26);
    // THE CLAW LANDED — combat.js billed it on the frame the claws met, which
    // was last frame from here (see the field's note). Take hold if the grab is
    // off cooldown; if it is not, the pinch simply cost the player health, and
    // that is the attack working rather than a missed opportunity.
    if (e.clawLanded) tryTakeHold(e, gc, hooks);
    if (s.timer > 0) return;
    standDown(e);
    return;
  }

  if (s.stage === 'rear') {
    s.timer -= dt;
    // Braced. The animal does not walk while its arms are over its head — a
    // crab that kept crawling through its own wind-up would arrive before the
    // gesture did and the tell would be about a place the player has left.
    e.perkDrive = true;
    e.vx *= 0.86;
    e.vy *= 0.86;
    // Interrupted: a daze takes the swing, exactly as it takes a perk's tell.
    // The arm is left to finish its own recover — the claw driver owns that.
    if (isDazed(e)) { standDown(e); s.swingCd = Math.max(s.swingCd, 1); return; }
    if (s.timer > 0) return;
    // COMMIT. The line is locked here and never steered afterwards.
    const dx = playerPos.x - e.mesh.position.x;
    const dy = playerPos.y - e.mesh.position.y;
    const len = Math.hypot(dx, dy) || 1;
    s.dirX = dx / len;
    s.dirY = dy / len;
    s.stage = 'lunge';
    s.timer = Math.max(0.05, hc.lungeTime ?? 0.5);
    // COMMITTED FROM THIS FRAME, not from the next one. systems/dodge.js opens
    // its record on the first frame the flag is up and closes it on the first
    // frame it is down, so a run whose flag arrives a frame late is a run
    // measured from a frame after it started — and on a lunge that lasts half a
    // second, the frame it launched is the one that decides whether it was ever
    // aimed at the seal.
    e.ramming = true;
    e.vx = s.dirX * (hc.lungeSpeed ?? 26);
    e.vy = s.dirY * (hc.lungeSpeed ?? 26);
    return;
  }

  // --- in the air -----------------------------------------------------------
  if (s.stage === 'air') {
    s.timer -= dt;
    e.perkDrive = true;
    e.ramming = true;
    // Nothing writes the velocity here: the launch impulse and gravity are the
    // whole arc, which is what makes it a jump rather than a fast walk through
    // the sky. Ended by LANDING, with the timer as the guard rail for a leap
    // that somehow never does (shoved onto another body, a support appearing
    // underneath it).
    if (s.timer > 0 && !(e.vy <= 0 && onGround(e))) return;
    standDown(e);
    s.jumpCd = jc.cooldown ?? 9;
    feedback('crabLand', {
      x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.2,
    });
    return;
  }

  // --- ready: which of the two, if either -----------------------------------
  if (isDazed(e) || (e.invuln ?? 0) > 0 || e.trapTimer > 0 || e.charmTimer > 0) return;

  // THE SWING FIRST. It is the closer of the two answers, and a crab that
  // jumped when it could have swung would leap over the player it is standing
  // next to.
  if (hc.enabled !== false && s.swingCd <= 0 && dist <= haymakerRange(e)
      && !e.claw?.isStriking()) {
    if (e.claw?.strike({ big: true })) {
      s.stage = 'rear';
      s.timer = rearTime(e);
      s.swingCd = hc.cooldown ?? 7;
      s.swings++;
      // The jab's own clock is pushed out with it, so the ordinary pinch does
      // not fire the instant this recovers — one big swing and then a beat, not
      // one big swing and a jab riding out of its recovery.
      e.pinchTimer = Math.max(e.pinchTimer ?? 0, (clawSetting(e.def, 'cooldown') ?? 2.6) + s.timer);
      feedback('crabRear', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.1 });
    }
    return;
  }

  // THE POUNCE. Only at a seal hugging the bed, only from the bed, only from a
  // gap worth crossing, and only on a body deep enough into a run to have
  // earned it.
  if (s.jumpCd <= 0 && canPounce(e) && onGround(e)
      && playerPos.y < bounds.bottom + (jc.nearFloor ?? 12)
      && dist > (jc.minRange ?? 12) && dist < (jc.maxRange ?? 34)) {
    const dx = playerPos.x - e.mesh.position.x;
    s.stage = 'air';
    s.timer = jc.maxAir ?? 2.2;
    s.jumps++;
    e.perkDrive = true;
    e.ramming = true;
    e.vy = jc.lift ?? 24;
    e.vx = Math.sign(dx || 1) * (jc.speed ?? 20);
    feedback('crabJump', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.2 });
  }
}

// Hand the body back. Every field this file wrote, and nothing else — the claw
// is left holding whatever it has, because a swing that connected is a grab and
// a swing that missed is already recovering under the driver's own clock.
function standDown(e) {
  const s = crabMeleeState;
  e.perkDrive = false;
  e.ramming = false;
  s.stage = 'ready';
  s.timer = 0;
}

// ---------------------------------------------------------------------------
// THE GRAB
// ---------------------------------------------------------------------------
// The seal is pinned to the CLAW BONE, not to a point in front of the body —
// systems/bossGrab.js takes an anchor for exactly this, and the anchor is read
// off the posed skeleton rather than from the aim point, because the IK has a
// weight ramp and a reach clamp on it and the arm does not necessarily get
// where it was asked to go. A seal placed at the request floats beside a claw
// that never closed on it.
function clawAnchor(out) {
  const e = crabMeleeState.crab;
  const at = e?.claw?.tip?.(_tip, 0);
  if (!at) return null;
  out.x = at.x;
  out.y = at.y;
  // DEPTH TOO. Every other emit point in this file is flattened onto the play
  // plane, and this is the one that must not be: the seal is being held by a
  // bone on an animal fifteen units deep, and a hold that ignored z would pin
  // it two units behind the claw with the crab's own body drawn over the top.
  // See the note in systems/bossGrab.js.
  out.z = at.z;
  return out;
}

function tryTakeHold(e, gc, hooks) {
  const s = crabMeleeState;
  if (gc.enabled === false || s.grabCd > 0 || playerGrabbed()) return false;
  e.claw?.hold(true);
  // THE RECORD IS SHARED WITH THE GRAB, not copied into it: this file fills in
  // `throwWith` at the end of the throw and systems/bossGrab.js reads it on the
  // same object, so there is one description of where the seal is going rather
  // than two that have to agree.
  s.clawRecord = {
    anchor: clawAnchor,
    hold: gc.hold ?? 0.5,
    cooldown: gc.cooldown ?? 11,
    // The backstop on the shared clock, which has to outlast the throw this
    // file is about to run — see the note in updateBossGrab.
    throwMax: Math.max(gc.slamTime ?? 0.26, gc.hurlTime ?? 0.3) + 0.4,
    throwWith: null,
  };
  const took = tryBossGrab(e, hooks, s.clawRecord);
  if (!took) {
    s.clawRecord = null;
    e.claw?.hold(false);
    return false;
  }
  s.grabCd = gc.cooldown ?? 11;
  s.grabs++;
  s.stage = 'held';
  s.timer = gc.hold ?? 0.5;
  // The lunge is over the moment the claw shuts on something: the body stops
  // being a committed run and becomes an animal standing still with the player
  // in its hand.
  e.perkDrive = true;
  e.ramming = false;
  e.vx = 0;
  e.vy = 0;
  return true;
}

function driveGrab(dt, e, gc, hooks) {
  const s = crabMeleeState;

  // The seal got away, the boss lost hold, or something else in the frame ended
  // the grab. Nothing to carry and nothing to throw.
  if (!playerGrabbed() || grabbedBy() !== e) {
    s.clawRecord = null;
    e.claw?.hold(false);
    e.clawAim = null;
    standDown(e);
    return;
  }

  // Held still while it decides. The crab keeps its own body out of the
  // steering's hands for the whole gesture, so the throw happens where the
  // catch did.
  e.perkDrive = true;
  e.vx = 0;
  e.vy = 0;
  s.timer -= dt;

  if (s.stage === 'held') {
    if (s.timer > 0) return;
    beginThrow(e, gc);
    return;
  }

  // --- the throw ------------------------------------------------------------
  // The IK TARGET is what moves. The claw follows it (`clawAim` in
  // entities/enemies.js), the seal follows the claw (the anchor above), and so
  // the thing the player watches carry them is the arm rather than a curve
  // applied to their own position.
  const total = Math.max(0.05,
    s.throwKind === 'slam' ? (gc.slamTime ?? 0.26) : (gc.hurlTime ?? 0.3));
  s.throwT = Math.min(1, s.throwT + dt / total);
  // Eased in: the arm accelerates through the swing rather than starting at
  // full speed, which is what makes a slam read as being driven down rather
  // than as a position change.
  const u = s.throwT * s.throwT;
  _aim.x = s.fromX + (s.toX - s.fromX) * u;
  _aim.y = s.fromY + (s.toY - s.fromY) * u;
  e.clawAim = _aim;

  if (s.throwT < 1) return;
  finishThrow(e, gc, hooks);
}

function beginThrow(e, gc) {
  const s = crabMeleeState;
  const at = clawAnchor(_aim) ?? { x: e.mesh.position.x, y: e.mesh.position.y };
  s.fromX = at.x;
  s.fromY = at.y;
  s.throwT = 0;
  s.stage = 'throw';

  const reach = e.claw?.reach?.() ?? (e.radius ?? 1) * 2;
  // ROLLED, not alternated: a throw whose kind can be worked out from the last
  // one is a throw the player answers before it happens.
  if (Math.random() < (gc.slamChance ?? 0.55)) {
    s.throwKind = 'slam';
    s.slams++;
    // Straight down, onto the sand in front of the animal — the seal's own
    // radius above the floor so the claw drives it INTO the bed rather than
    // through it.
    s.toX = e.mesh.position.x + Math.sign(s.fromX - e.mesh.position.x || 1) * reach * 0.45;
    s.toY = bounds.bottom + (CONFIG.player?.hitRadius ?? 1);
  } else {
    s.throwKind = 'hurl';
    s.hurls++;
    // Up and out, in a cone either side of straight up — see `hurlSpread`. Away
    // from the crab, so the arm opens rather than folding back over the body.
    const away = Math.sign(s.fromX - e.mesh.position.x) || (Math.random() < 0.5 ? -1 : 1);
    const a = Math.PI / 2 - away * Math.random() * (gc.hurlSpread ?? 1.1);
    s.toX = s.fromX + Math.cos(a) * reach * 0.9;
    s.toY = s.fromY + Math.sin(a) * reach * 0.9;
  }
  feedback(s.throwKind === 'slam' ? 'crabSlam' : 'crabHurl', {
    x: s.fromX, y: s.fromY, scale: 1.2,
  });
}

function finishThrow(e, gc, hooks) {
  const s = crabMeleeState;
  const dx = s.toX - s.fromX;
  const dy = s.toY - s.fromY;
  const len = Math.hypot(dx, dy) || 1;

  // WHAT THE THROW IS WORTH, handed to the grab so the release travels along
  // the arm's own swing rather than along the body's heading — which on an
  // animal that walks sideways points somewhere the attack never went.
  const speed = s.throwKind === 'slam' ? (gc.slamSpeed ?? 26) : (gc.hurlSpeed ?? 38);
  if (s.clawRecord && grabbedBy() === e) {
    s.clawRecord.throwWith = { x: dx / len, y: dy / len, speed };
  }

  // THE SLAM COSTS SOMETHING; THE HURL DOES NOT. Being thrown is its own
  // punishment — the seal ends the moment travelling fast somewhere it did not
  // choose with a boss between it and where it wanted to be — and charging for
  // both would make the roll at the top of the throw a coin flip for damage,
  // which is not a thing the player can play around.
  //
  // Through hooks.onPlayerHit, main.js's, so this goes through the i-frame
  // window, the boss damage ceilings and the playtest ledger like every other
  // point a boss deals. A system that subtracted hp itself would be invisible
  // to all three.
  if (s.throwKind === 'slam') {
    const base = e.contactDamage ?? e.def.contactDamage ?? 0;
    const dmg = base * (gc.slamDamage ?? 1.7);
    if (dmg > 0) hooks.onPlayerHit?.(dmg, { x: 0, y: -1 }, `${e.type}:slam`, 'strike');
  }

  endBossGrab(true);
  s.clawRecord = null;
  e.claw?.hold(false);
  e.clawAim = null;
  s.throwKind = null;
  standDown(e);
}
