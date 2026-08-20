import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { burstInk, clearInkTrail, inkEncirclement, updateInkTrail } from './inkTrail.js';
import { activeBossPerk } from './bossPerks.js';

// ---------------------------------------------------------------------------
// THE KRAKEN — the boss that does not come to you.
//
// The shark chases. The orca chases faster. The boat shells you from above the
// water. This one holds mid-range, circles, and fills the arena with ink you
// cannot see through: the roster's ZONER, where the fight is not about
// out-swimming a body but about where you can still see.
//
// WHY IT IS A SYSTEM AND NOT A PERK, which is the same answer bossBoat.js gives.
// Perks are things a boss HAS — rolled from a table, interchangeable, and a
// shark with a lunge is still a shark. The ink is what this boss IS. It comes
// with a body built for it (ten spring-driven limbs), a standoff it will not
// leave, and a cadence you are meant to learn. It still rolls one ordinary perk
// on top, which is what keeps two kraken fights from being the same fight.
//
// WHAT IT REUSES, deliberately and entirely:
//   the circling   `behavior: 'orbit'` in CONFIG.enemies.bossSquid — the same
//                  steering any orbiting creature uses. Nothing here moves the
//                  animal; this file only decides when it inks.
//   the cloud      systems/inkTrail.js, which is the breach trail's machinery
//                  read through the opposite optics.
//   the telegraph  the `bark` one-shot, mapped to this model's `eyeballing`
//                  take. See the note on the burst below.
//
// THE TWO CLOCKS, and getting them the wrong way round is the bug this file is
// arranged to prevent:
//
//   updateKraken      GAME time, inside the run gate. The cadence is a fight
//                     mechanic and it has to stop when the fight does — a boss
//                     that went on inking behind the level-up cards would hand
//                     the player an arena they never had a chance to read.
//   updateKrakenInk   REAL time, OUTSIDE the run gate, called from main.js next
//                     to updateBreachTrail. The cloud is water. It has to go on
//                     churning and dissolving through a hit-stop, through the
//                     level-up freeze, and — most of all — after the boss dies,
//                     because ink that vanished on the kill frame would undo the
//                     one thing that makes it ink.
//
// That split is why the ink is not simply updated from inside the block below.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.kraken ?? {};
}

/** Is this creature the kraken? Read off the def so nothing has to be told. */
export function isKrakenBoss(e) {
  return !!e?.def?.inkBoss;
}

export const krakenState = {
  squid: null,
  // 'ready' -> counting down to the next burst
  // 'telegraph' -> the eyes have rolled, the burst is coming
  stage: 'ready',
  timer: 0,
  // Resolved once per arrival — see sourceFor.
  beakBones: null,
  mantleBone: null,
  // The last emission point and jet direction sourceFor computed, published for
  // the same reason bossState and boatState publish theirs: an effect driven off
  // a rig is otherwise unobservable, and "the ink looks slightly wrong" is not a
  // thing anyone can debug. tools/kraken-test.mjs asserts on these.
  beakX: 0,
  beakY: 0,
  jetX: 0,
  jetY: 1,
  // Health last seen, for the flinch burst. Held as a fraction rather than as
  // hit points so it survives the difficulty scaling that sets maxHp.
  lastHpFrac: 1,
  flinchCooldown: 0,
  bursts: 0,

  // --- the trap -------------------------------------------------------------
  // THE LATCH: true from the moment a crush commits until it finishes
  // recovering. See the note on PUNISH's guard for why it is not re-evaluated.
  committed: false,
  crushStage: 'rear',
  crushTimer: 0,
  crushDirX: 0,
  crushDirY: 0,
  crushCooldown: 0,
  crushes: 0,
  // The contact damage the body had before a crush multiplied it. Held here
  // rather than recomputed, for the same reason bossPerks.js holds its own.
  baseContact: 0,
  weaving: 0,
  // HOW LONG THE RING HAS BEEN CLOSED, and it is not a nicety. Coverage measured
  // on a single frame swings from 30% to 99% and back inside a tenth of a second
  // — not because the ring is changing, but because each weave burst's new
  // particles are born fat and close and briefly subtend an enormous angle
  // before they drift and thin. Thresholding that raw signal fires the crush on
  // a measurement spike rather than on a wall. Requiring the closure to PERSIST
  // is both the fix and the fairer mechanic: the ring the player is punished for
  // is one that was really there long enough to see.
  closedFor: 0,
  weaveCooldown: 0,
  weaveInkTimer: 0,
  // What the last tick saw and did — published for tools/kraken-test.mjs and for
  // anyone debugging a tree that did something surprising.
  coverage: 0,
  gapAngle: Math.PI * 2,
  gapDir: 0,
  branch: '',
};

/**
 * THE FIGHT IS OVER BUT THE WATER IS NOT. Drops the boss reference and stops
 * the cadence, and deliberately leaves the cloud alone.
 *
 * This is the one called when a boss dies or despawns, and the distinction from
 * resetKraken is the whole feature: ink that vanished on the kill frame would
 * undo the only thing that makes it ink. What is already in the water goes on
 * churning and dissolving on its own clock, for as long as its particles have
 * left to live.
 */
export function releaseKraken() {
  krakenState.squid = null;
  krakenState.beakBones = null;
  krakenState.mantleBone = null;
  krakenState.stage = 'ready';
  krakenState.timer = 0;
  krakenState.lastHpFrac = 1;
  krakenState.flinchCooldown = 0;
  krakenState.bursts = 0;
  krakenState.committed = false;
  krakenState.crushStage = 'rear';
  krakenState.crushTimer = 0;
  krakenState.crushCooldown = 0;
  krakenState.crushes = 0;
  krakenState.baseContact = 0;
  krakenState.weaving = 0;
  krakenState.closedFor = 0;
  krakenState.weaveCooldown = 0;
  krakenState.weaveInkTimer = 0;
  krakenState.coverage = 0;
  krakenState.gapAngle = Math.PI * 2;
  krakenState.gapDir = 0;
  krakenState.branch = '';
}

/**
 * Full teardown, cloud included. RUN RESET ONLY — a new run that opened with
 * the last one's ink still hanging in the water would start on an arena nobody
 * earned, and the strand id (see inkTrail.js) only stops the ribbon JOINING two
 * clouds, not the old one being there.
 */
export function resetKraken(scene) {
  releaseKraken();
  if (scene) clearInkTrail(scene);
}

export function attachKraken(scene, e) {
  resetKraken(scene);
  if (!isKrakenBoss(e)) return;
  krakenState.squid = e;
  krakenState.lastHpFrac = 1;
  // The bones the ink comes out of, found once. A body whose model failed to
  // load has none, and sourceFor falls back to the origin rather than throwing.
  const visual = e.visual ?? e.mesh;
  krakenState.beakBones = BEAK_BONES.map((n) => visual?.getObjectByName(n)).filter(Boolean);
  krakenState.mantleBone = visual?.getObjectByName(MANTLE_BONE) ?? null;
  if (!krakenState.beakBones.length) {
    console.warn('[kraken] no mouth bones on this body — ink will come from its centre');
  }
  // The first burst waits out the arrival and then some. A zoner that inked on
  // the frame the player got control would have covered the arena before anyone
  // had seen what the animal looks like — and the silhouette is the only thing
  // that explains what the ink is going to do.
  krakenState.timer = cfg().openingDelay ?? 3.4;
  krakenState.stage = 'ready';
}

// The eight bones of the mouth chain, and the mantle bone the jet is measured
// against. Resolved once per arrival rather than by name every frame — a
// getObjectByName walks the whole subtree, and this body is 97 bones and ten
// meshes.
const BEAK_BONES = [
  'mouthL002_14', 'mouthL001_13', 'mouthL_12', 'mouthR003_11',
  'mouthR002_10', 'mouthR001_9', 'mouthR_8', 'mouthL003_7',
];
const MANTLE_BONE = 'middlebone001_75';

/**
 * Where ink comes out, measured off the ANIMAL rather than off its heading.
 *
 * THE BEAK, NOT THE ORIGIN. The first version offset the emission point
 * backwards along the direction of travel by a fraction of the body's radius —
 * a guess dressed up as a number. It tracked where the squid was GOING rather
 * than where its mouth was, so a squid mid-turn inked out of its own flank, and
 * an orbiting boss is turning all the time.
 *
 * The mouth chain's eight bones average to a point measured (see
 * tools/squid-beak-probe.mjs) at 13% of the body's length ahead of centre, dead
 * on the centreline, sitting among the roots of the arm crown — the underside of
 * the head, between the arms. Reading it off the bones means it follows the pose
 * for free: the spring chains and the clip move the head, and the ink goes with
 * it.
 *
 * THE JET runs mantle -> beak, which measures as (0, 0.97, -0.23) in entity
 * space — the animal's own +Y, i.e. straight out of the mouth. Taken from the
 * two bones rather than hardcoded as "forward" so it stays correct if the entry's
 * orientation is ever re-measured.
 *
 * Everything is flattened to XY. The game plays in that plane and the bones do
 * not: the beak sits over half a unit into the screen, and a jet carrying that
 * depth would send ink drifting toward the camera.
 */
const _source = { x: 0, y: 0, vx: 0, vy: 0, jx: 0, jy: 1 };
const _bp = new THREE.Vector3();
function sourceFor(e) {
  const bones = krakenState.beakBones;
  const mantle = krakenState.mantleBone;

  let bx = 0;
  let by = 0;
  let n = 0;
  if (bones?.length) {
    for (const b of bones) {
      b.getWorldPosition(_bp);
      bx += _bp.x;
      by += _bp.y;
      n += 1;
    }
  }

  if (n > 0) {
    _source.x = bx / n;
    _source.y = by / n;
  } else {
    // No rig — the model failed to load and the creature is wearing its fallback
    // cone. Emit from the body rather than not at all.
    _source.x = e.mesh.position.x;
    _source.y = e.mesh.position.y;
  }

  // The jet: mantle to beak, flattened. Falls back to the direction of travel,
  // and then to +Y, so a missing rig still squirts somewhere sensible instead of
  // handing inkTrail a zero-length direction it would silently treat as no jet
  // at all.
  let jx = 0;
  let jy = 0;
  if (n > 0 && mantle) {
    mantle.getWorldPosition(_bp);
    jx = _source.x - _bp.x;
    jy = _source.y - _bp.y;
  }
  if (Math.hypot(jx, jy) < 1e-4) {
    jx = e.vx ?? 0;
    jy = e.vy ?? 0;
  }
  const jl = Math.hypot(jx, jy);
  if (jl > 1e-4) {
    _source.jx = jx / jl;
    _source.jy = jy / jl;
  } else {
    _source.jx = 0;
    _source.jy = 1;
  }

  _source.vx = e.vx ?? 0;
  _source.vy = e.vy ?? 0;

  krakenState.beakX = _source.x;
  krakenState.beakY = _source.y;
  krakenState.jetX = _source.jx;
  krakenState.jetY = _source.jy;
  return _source;
}

// ===========================================================================
// THE BEHAVIOUR TREE
// ===========================================================================
// The fight is one idea: WALL THE PLAYER IN, THEN PUNISH THEM FOR BEING WALLED
// IN. Everything below is that sentence with the failure cases written down.
//
// WHY A TREE AND NOT ANOTHER TIMER. The cadence this replaced was a two-stage
// machine — count down, telegraph, bloom — and it could only ever express "how
// often". The trap is a goal with preconditions: it needs to know whether the
// ring is closed, where the hole in it is, whether the player is still inside,
// and what to do when any of those stops being true. Written as flags on one
// state variable that is four booleans and a switch nobody can read; written as
// a tree it is three branches in priority order, and the priority IS the design:
//
//   PUNISH  the ring is closed -> rear back and crush whatever is inside it
//   WEAVE   the ring is not closed -> go plug the widest hole in it
//   PROWL   no reachable player -> circle and ink on the old cadence
//
// The root is a SELECTOR — first branch that does not fail wins — re-evaluated
// every tick, so the boss reacts to the player escaping rather than finishing a
// plan that stopped making sense. The one exception is the latch on PUNISH,
// which is what stops a crush aborting mid-dash; see `committed`.
//
// WHAT DRIVES THE BODY. Same contract systems/bossPerks.js uses: raise
// `e.perkDrive` and write `e.vx/e.vy`, and updateEnemies steps it instead of the
// creature's own steering. This file runs AFTER updateBossPerks (see the call
// order in systems/boss.js), so it would silently win every tug-of-war over a
// perk mid-lunge — which is why the tree yields outright while a perk is
// driving rather than relying on running second.
// ---------------------------------------------------------------------------

const RUNNING = 'running';
const SUCCESS = 'success';
const FAILURE = 'failure';

/** Children in order; stops at the first that is not SUCCESS. */
function sequence(name, children) {
  return { name, tick: (bb) => {
    for (const child of children) {
      const r = child.tick(bb);
      if (r !== SUCCESS) return (bb.trace.push(`${name}/${child.name}:${r}`), r);
    }
    return (bb.trace.push(`${name}:success`), SUCCESS);
  } };
}

/** Children in order; stops at the first that is not FAILURE. */
function selector(name, children) {
  return { name, tick: (bb) => {
    for (const child of children) {
      const r = child.tick(bb);
      if (r !== FAILURE) return (bb.trace.push(`${name}/${child.name}:${r}`), r);
    }
    return (bb.trace.push(`${name}:failure`), FAILURE);
  } };
}

/** A test. SUCCESS or FAILURE, never RUNNING. */
function condition(name, fn) {
  return { name, tick: (bb) => (fn(bb) ? SUCCESS : FAILURE) };
}

/** A leaf that does something and says whether it is finished. */
function action(name, fn) {
  return { name, tick: fn };
}

// --- the shared helpers the leaves are written in --------------------------

/**
 * IS THE RING CLOSED? — asked in exactly one place, because two branches need
 * the answer and two copies of a threshold is how they drift apart.
 *
 * Reads `closedFor`, which updateKraken accumulates, rather than this frame's
 * coverage. See the note on that field: the instantaneous measurement is far too
 * noisy to threshold directly.
 */
function ringIsClosed(bb) {
  return krakenState.closedFor >= (bb.c.trap?.holdFor ?? 0.35);
}

/** Take the wheel: same contract as a perk, so updateEnemies steps this. */
function drive(e, dirX, dirY, speed) {
  e.perkDrive = true;
  e.vx = dirX * speed;
  e.vy = dirY * speed;
}

/**
 * Ink hard while weaving, on a cadence of its own.
 *
 * `burstInk` rather than a raised emission rate, because the burst path already
 * spreads its particles over the following few frames along the path the animal
 * actually swims (see the note in inkTrail.js) — which is exactly what laying a
 * WALL along an arc needs. A raised rate would pile the extra particles at
 * whatever single coordinate the squid occupied on the frame the rate changed.
 */
function weaveInk(bb, dt) {
  krakenState.weaveInkTimer -= dt;
  if (krakenState.weaveInkTimer > 0) return;
  burstInk(bb.c.trap?.weaveStrength ?? 0.5);
  krakenState.weaveInkTimer = bb.c.trap?.weaveInkEvery ?? 0.34;
}

// --- the tree ---------------------------------------------------------------

const TREE = selector('kraken', [
  // -------------------------------------------------------------------------
  sequence('PUNISH', [
    // THE LATCH. Once the crush is committed it runs to its end, even if the
    // player swims out of the ring on the next frame. A reactive guard here
    // would abort the dash halfway and leave three tonnes of animal stopped
    // dead in the water mid-lunge, which reads as a bug rather than as an
    // escape — and it would also mean the counterplay to the whole mechanic is
    // "keep moving", which is what the player is doing anyway.
    condition('the ring is closed', (bb) => {
      if (krakenState.committed) return true;
      if (!bb.player) return false;
      if (krakenState.crushCooldown > 0) return false;
      return ringIsClosed(bb);
    }),
    action('crush', (bb) => {
      const k = bb.c.crush ?? {};
      const e = bb.e;
      if (!krakenState.committed) {
        krakenState.committed = true;
        krakenState.crushStage = 'rear';
        krakenState.crushTimer = k.windup ?? 0.9;
        // The tell. Same `bark` one-shot the old burst telegraph used — see the
        // note there for why this reuses the shared vocabulary rather than
        // inventing a state only one boss can reach.
        e.anim?.trigger('bark');
      }
      krakenState.crushTimer -= bb.dt;

      if (krakenState.crushStage === 'rear') {
        // Held, but creeping toward the player — `faceMotion` reads the
        // direction of travel, so a boss with zero velocity keeps whatever
        // heading it had and the tell would not say WHERE. Same reasoning as
        // the lunge perk's wind-up.
        drive(e, bb.toPlayerX, bb.toPlayerY, k.aimCreep ?? 0.8);
        if (krakenState.crushTimer <= 0) {
          krakenState.crushStage = 'dash';
          krakenState.crushTimer = k.duration ?? 0.8;
          krakenState.crushDirX = bb.toPlayerX;
          krakenState.crushDirY = bb.toPlayerY;
          // Read off the def rather than off the live value, so a crush that
          // somehow re-entered cannot compound its own multiplier.
          krakenState.baseContact = e.def?.contactDamage ?? e.contactDamage ?? 0;
          e.contactDamage = krakenState.baseContact * (k.damage ?? 3.2);
          // The body IS the attack for the length of the dash, so the touch is
          // billed against the fight's budget rather than against the chip
          // ceiling overlap is held to — see `ramming` in entities/enemies.js.
          // Without this the x3.2 is clipped straight back down to the same
          // quarter-bar-per-second as brushing an arm, and the one attack this
          // archetype has stops existing.
          e.ramming = true;
          e.anim?.trigger('strike');
        }
        return RUNNING;
      }

      if (krakenState.crushStage === 'dash') {
        // Committed to a HEADING, not homing. An unavoidable attack on a body
        // with this much health is a damage race, not a fight — the player has
        // to be able to beat it by moving, which means it has to be able to
        // miss.
        drive(e, krakenState.crushDirX, krakenState.crushDirY, k.speed ?? 30);
        if (krakenState.crushTimer <= 0) {
          krakenState.crushStage = 'recover';
          krakenState.crushTimer = k.recover ?? 1.5;
          if (krakenState.baseContact > 0) e.contactDamage = krakenState.baseContact;
          e.ramming = false;
        }
        return RUNNING;
      }

      // recover — the window the whole trap paid for. It is the only time this
      // boss is neither circling out of reach nor mid-dash.
      e.perkDrive = false;
      if (krakenState.crushTimer > 0) return RUNNING;
      krakenState.committed = false;
      krakenState.crushes += 1;
      krakenState.crushCooldown = k.cooldown ?? 4;
      return SUCCESS;
    }),
  ]),

  // -------------------------------------------------------------------------
  sequence('WEAVE', [
    condition('a player to wall in', (bb) => !!bb.player),
    condition('close enough to work', (bb) => bb.distToPlayer <= (bb.c.trap?.engageRange ?? 34)),
    action('run the gap', (bb) => {
      const t = bb.c.trap ?? {};
      const e = bb.e;
      krakenState.weaving += bb.dt;

      // GIVE UP AND RE-PROWL. A squid that could weave forever would pin a
      // player who is simply outrunning the ring, and the fight would have no
      // rhythm at all — the cloud has a lifetime, so a ring that has not closed
      // in this long is one whose earliest wall is already dissolving.
      if (krakenState.weaving > (t.giveUp ?? 9)) {
        krakenState.weaving = 0;
        krakenState.weaveCooldown = t.regroup ?? 3;
        return FAILURE;
      }

      // WHERE THE HOLE IS. The measurement hands back the bearing of the widest
      // opening in the ring; the squid's job is to be standing in it, at the
      // ring's own radius from the player, laying wall as it crosses.
      const ring = t.radius ?? 9;
      const tx = bb.player.x + Math.cos(bb.ring.gapDir) * ring;
      const ty = bb.player.y + Math.sin(bb.ring.gapDir) * ring;
      let dx = tx - e.mesh.position.x;
      let dy = ty - e.mesh.position.y;
      const d = Math.hypot(dx, dy) || 1;
      drive(e, dx / d, dy / d, t.weaveSpeed ?? 13);
      weaveInk(bb, bb.dt);

      // Closed. The sequence returning SUCCESS here does not fire the crush on
      // this tick — the root re-evaluates next frame and PUNISH's condition
      // picks it up, which keeps "is it closed" in exactly one place.
      if (ringIsClosed(bb)) {
        krakenState.weaving = 0;
        return SUCCESS;
      }
      return RUNNING;
    }),
  ]),

  // -------------------------------------------------------------------------
  // The fallback, and the fight's resting state: circle on the creature's own
  // `orbit` steering (nothing here touches velocity) and ink on the original
  // cadence. This is also what runs while the trap is on cooldown, so the
  // player gets stretches of the old, readable fight between attempts.
  action('PROWL', (bb) => {
    const c = bb.c;
    krakenState.timer -= bb.dt;
    if (krakenState.timer > 0) return RUNNING;

    if (krakenState.stage === 'ready') {
      bb.e.anim?.trigger('bark');
      krakenState.stage = 'telegraph';
      krakenState.timer = c.windup ?? 0.7;
      return RUNNING;
    }
    burstInk(1);
    krakenState.bursts += 1;
    krakenState.stage = 'ready';
    const every = c.burstEvery ?? 7;
    const floorGap = c.burstEveryMin ?? 3.4;
    const step = c.burstRampPerBurst ?? 0.45;
    krakenState.timer = Math.max(floorGap, every - step * krakenState.bursts);
    return RUNNING;
  }),
]);

/**
 * The flinch, then one tick of the tree. GAME time, inside the run gate.
 *
 * Called from systems/boss.js alongside the perks, and like them it runs before
 * updateEnemies so anything it writes is stepped on the same frame rather than
 * one late.
 */
export function updateKraken(dt, scene, playerPos, hooks = {}) {
  const e = krakenState.squid;
  if (!e || e.dead || !isKrakenBoss(e)) return;
  const c = cfg();

  krakenState.flinchCooldown = Math.max(0, krakenState.flinchCooldown - dt);
  krakenState.crushCooldown = Math.max(0, krakenState.crushCooldown - dt);
  krakenState.weaveCooldown = Math.max(0, krakenState.weaveCooldown - dt);

  // --- THE FLINCH -----------------------------------------------------------
  // A real squid inks when something hurts it, and a boss whose only ink was on
  // a timer would read as a sprinkler. This is the half the player CAUSES: land
  // a big hit and the animal blooms a partial cloud, which means a strike into
  // the kraken is a trade — damage now for a screen you cannot read a moment
  // later. It also feeds the trap, which is the trade getting sharper: the ink
  // you knocked out of it is ink that is walling you in.
  //
  // Measured as a drop in health FRACTION over one frame, not in hit points,
  // because hit points scale with difficulty and a threshold in them would fire
  // on every scratch at level 30 and never at all at level 20.
  const frac = e.maxHp > 0 ? Math.max(0, (e.hp ?? 0) / e.maxHp) : 1;
  const lost = krakenState.lastHpFrac - frac;
  krakenState.lastHpFrac = frac;
  if (lost >= (c.flinchDamage ?? 0.045) && krakenState.flinchCooldown <= 0) {
    burstInk(c.flinchStrength ?? 0.55);
    krakenState.flinchCooldown = c.flinchCooldown ?? 2.2;
  }

  // --- YIELD TO A PERK ------------------------------------------------------
  // A perk mid-lunge or mid-teleport owns the body. This file runs after
  // updateBossPerks, so without this it would quietly overwrite that velocity
  // every frame and the perk would never move the animal at all — the kind of
  // bug that presents as "the lunge perk does nothing on this one boss".
  const perk = activeBossPerk();
  if (perk && perk.stage && perk.stage !== 'ready') {
    // Anything the tree had committed to is abandoned rather than resumed: the
    // perk has moved the animal somewhere else, and a crush that carried on
    // afterwards would dash from a position it never aimed from.
    if (krakenState.committed && krakenState.baseContact > 0) {
      e.contactDamage = krakenState.baseContact;
      e.ramming = false;
    }
    krakenState.committed = false;
    krakenState.crushStage = 'rear';
    return;
  }

  // --- THE BLACKBOARD -------------------------------------------------------
  // Built once per tick and handed down, so no leaf recomputes the encirclement
  // — it walks every particle in the cloud, and three branches asking the same
  // question three times is three sweeps of a few hundred nodes per frame.
  const px = playerPos?.x;
  const py = playerPos?.y;
  const hasPlayer = Number.isFinite(px) && Number.isFinite(py);
  const t = c.trap ?? {};
  const ring = hasPlayer
    ? inkEncirclement(px, py, { rMin: t.bandMin ?? 2.5, rMax: t.bandMax ?? 20 })
    : { coverage: 0, gapAngle: Math.PI * 2, gapDir: 0, counted: 0 };

  let toX = 0;
  let toY = 1;
  let dist = Infinity;
  if (hasPlayer) {
    const dx = px - e.mesh.position.x;
    const dy = py - e.mesh.position.y;
    dist = Math.hypot(dx, dy);
    if (dist > 1e-4) { toX = dx / dist; toY = dy / dist; }
  }

  // THE DWELL. Accumulated here rather than in a leaf so it runs on every tick
  // whichever branch wins — a counter that only advanced while WEAVE was
  // selected would reset itself the moment the tree switched, which is the one
  // frame it most needs to remember.
  const closedNow = ring.coverage >= (t.closeAt ?? 0.82)
    && ring.gapAngle <= (t.gapClosed ?? 0.9);
  krakenState.closedFor = closedNow ? krakenState.closedFor + dt : 0;

  // `perkDrive` is lowered at the TOP of every tick and re-raised by whichever
  // leaf actually wants the wheel. Leaving it up is how a boss ends a fight
  // frozen: the flag outlives the behaviour that set it, and the creature's own
  // steering never runs again.
  e.perkDrive = false;

  const bb = {
    e, dt, c,
    player: hasPlayer ? { x: px, y: py } : null,
    ring,
    toPlayerX: toX,
    toPlayerY: toY,
    distToPlayer: dist,
    hooks,
    trace: [],
  };

  // The weave is skipped entirely while regrouping, which is what gives the
  // fight its rhythm — a stretch of ordinary circling after every failed trap.
  if (krakenState.weaveCooldown > 0) krakenState.weaving = 0;

  TREE.tick(bb);

  // Published for the harness and for anything that wants to draw the fight's
  // state. The trace is the branch that ran, which is the single most useful
  // thing to have when a tree does something surprising.
  krakenState.coverage = ring.coverage;
  krakenState.gapAngle = ring.gapAngle;
  krakenState.gapDir = ring.gapDir;
  krakenState.branch = bb.trace[bb.trace.length - 1] ?? '';
}

/**
 * Drive the cloud. REAL time, outside the run gate — see the header.
 *
 * @param dt       real seconds
 * @param scene
 * @param player   read for position only, and only to keep the porthole on it
 * @param emitting whether new ink may be laid down. Drifting happens whatever
 *                 this says; emission is gated on the run being live, or a
 *                 paused boss stacks a whole second of cloud at one coordinate.
 */
export function updateKrakenInk(dt, scene, player, emitting = true) {
  const e = krakenState.squid;
  // A dead or despawned boss stops being a SOURCE but does not clear the cloud.
  // That is the point: what it already put in the water is still there, and it
  // goes on churning and dissolving on its own clock afterwards.
  const live = e && !e.dead && e.mesh?.parent ? sourceFor(e) : null;
  const focus = player?.mesh?.position
    ? { x: player.mesh.position.x, y: player.mesh.position.y }
    : null;
  updateInkTrail(dt, scene, live, focus, emitting);
}
