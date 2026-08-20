import { CONFIG } from '../config.js';
import { activeBossPerk } from './bossPerks.js';
import { attachEmissiveCues, resetEmissiveCues } from './emissivePulse.js';

// ---------------------------------------------------------------------------
// THE ANGLERFISH — the boss that waits.
//
// The shark chases. The orca chases faster. The kraken holds mid-range and
// blinds you. Every one of them decides when the fight happens. This one does
// not: it holds station with its lure lit and makes the PLAYER choose, which
// is the verb the roster did not have.
//
// WHY IT IS A SYSTEM AND NOT A PERK — the kraken's answer, and the same one.
// Perks are things a boss HAS: rolled from a table, interchangeable, and a
// shark with a lunge is still a shark. Waiting is what this one IS. It comes
// with a body built for it (an 8s ambush take with the jaw cranked past its
// rest gape), a light that says what it is about to do, and a cadence you are
// meant to learn. It still rolls one ordinary perk on top, which is what keeps
// two anglerfish fights from being the same fight.
//
// ---------------------------------------------------------------------------
// THE CADENCE, and what each stage is telling you
// ---------------------------------------------------------------------------
//
//   lurk      Station-keeping, `idle` -> the `trap` take, lure throbbing low.
//             It will sit here indefinitely if you stay out of `triggerRange`.
//             That is the whole proposition: the fight starts when you say so.
//   windup    You came inside the range. It turns to face you, fires the `bark`
//             one-shot (`swim_start`, the file's own gather-yourself take), and
//             the lure ramps to its peak over exactly `windup` seconds.
//   lunge     It commits along the line locked at the END of the wind-up, at
//             `boost` (`swim2`, 2.4x the cruise), hitting far harder on
//             contact. The light is held bright for exactly as long as the body
//             is dangerous.
//   snap      The `bite` one-shot at the end of the run, whether or not it
//             connected. This is a predator closing its mouth, not a hit
//             confirm — selling the miss is most of what makes the dodge feel
//             like a dodge.
//   recover   It coasts, `swim` -> `swim1`, and the lure goes OUT. This is the
//             punishable window and the two are deliberately the same event: a
//             dark anglerfish is a safe one, which is a rule a player can learn
//             in a single fight without being told it.
//
// THE LINE IS LOCKED AT THE END OF THE WIND-UP, not steered during the lunge —
// the lunge perk's rule, for the lunge perk's reason. A homing ambush is not a
// fight, it is a damage race with extra steps. The counterplay has to be real:
// read the light, move sideways, watch it commit to where you were.
//
// THE TELL IS ON THE ANIMAL. Every other boss telegraphs with a threat ring
// drawn on the water, because its body has nothing to say with. This one
// arrived with an emissive atlas that already paints the esca and two rows of
// photophores down its flank, so the light lives on the creature. See
// CONFIG.emissiveCues for the envelopes and systems/emissivePulse.js for why
// the materials have to be per-instance.
//
// ---------------------------------------------------------------------------
// TWO THINGS THIS FILE DOES NOT DO
// ---------------------------------------------------------------------------
//
//   IT DOES NOT MOVE THE ANIMAL BETWEEN AMBUSHES. `behavior: 'hunt'` in
//   CONFIG.enemies.bossAnglerfish steers the reposition, exactly as it steers
//   every other swimmer. This file takes the wheel through `perkDrive` only
//   for the hold and the lunge — the same handoff bossPerks.js uses — and
//   hands it straight back.
//
//   IT DOES NOT DECIDE WHAT ANIMATION MEANS. Which clip a state resolves to is
//   ASSETS.enemyBossAnglerfish.animations, in assets.js with the rest of the
//   data. This file names STATES; a re-export that renames a take is one line
//   there and nothing here.
// ---------------------------------------------------------------------------

export function isAnglerBoss(e) {
  return !!e?.def?.ambushBoss;
}

const cfg = () => CONFIG.boss?.angler ?? {};

// HOW AN AMBUSHER AIMS WITHOUT MOVING.
//
// `faceMotion` in entities/enemies.js only writes `mesh.rotation.z` when the
// body is travelling faster than 0.05 u/s — below that it declines, and the
// heading simply stays where it was. For every other creature that is correct:
// a drifting fish has no opinion about which way it points. For this one it is
// the whole problem, because the animal spends most of the fight at a dead
// stop and must still be looking at you — an anglerfish aiming its lure
// somewhere else is not a trap, it is scenery.
//
// The first version of this file solved it by creeping toward the player fast
// enough to clear that 0.05 gate. That works, and it is why the boss slowly
// swam at you for the whole fight and never actually held station.
//
// So the ambush writes the heading itself, and the 0.05 gate becomes the
// HANDOFF rather than an obstacle: below it this function owns the facing,
// above it (the lunge, the reposition) enemies.js does, and the two can never
// both be writing on the same frame. Eased at `turnRate` rather than snapped,
// so the turn onto you is a thing you can watch happen — which is half the
// tell.
function faceToward(e, dx, dy, dt, turnRate) {
  if (!e.mesh) return;
  // The same expression enemies.js uses for faceMotion, so a body that crosses
  // the speed gate mid-turn does not jump: both writers agree on what "facing
  // (dx, dy)" means for this rig.
  const want = Math.atan2(dy, dx) - Math.PI / 2;
  const cur = e.mesh.rotation.z;
  let d = want - cur;
  // Shortest way round. Without this a turn across the -PI/PI seam takes the
  // long way and the fish spins most of a full circle to look 2 degrees left.
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const step = Math.max(0.01, turnRate) * dt;
  e.mesh.rotation.z = cur + Math.max(-step, Math.min(step, d));
}

export const anglerState = {
  fish: null,
  // 'lurk' -> waiting  |  'windup' -> the tell  |  'lunge' -> committed
  // 'snap' -> the bite  |  'recover' -> dark and punishable
  stage: 'lurk',
  timer: 0,
  // The line, locked when the wind-up ends. Published for the same reason
  // bossState and krakenState publish theirs: a decision taken inside one
  // frame is otherwise unobservable, and "the lunge went the wrong way" is not
  // something anyone can debug from the outside. tools/boss-angler-test.mjs
  // asserts on these.
  dirX: 0,
  dirY: 0,
  // The handle from attachEmissiveCues — per instance, so this boss's tell
  // does not light every anglerfish in the water.
  cues: null,
  // Restored when the lunge ends. Read off the saved base rather than
  // compounding, so an ambush interrupted by a perk and re-entered cannot
  // stack the multiplier.
  baseContact: 0,
  // How many full cycles this arrival has completed, for the harness.
  cycles: 0,
  // Where it is drifting to during the recovery, picked once per cycle.
  station: null,
  // Health FRACTION last frame, for the hurt flash. A fraction and not hit
  // points, for the kraken's reason: hp scales with difficulty, so a threshold
  // in points would fire on every scratch at level 30 and never at level 20.
  lastHpFrac: 1,
};

export function releaseAngler() {
  const e = anglerState.fish;
  // Put back anything this file borrowed from the body. A boss that dies
  // mid-lunge would otherwise leave its contact damage multiplied on a def
  // object the NEXT arrival reads, and leave `animState` pinned so the corpse
  // holds a lunge pose.
  if (e) {
    if (anglerState.baseContact > 0) e.contactDamage = anglerState.baseContact;
    e.ramming = false;
    e.animState = null;
    e.perkDrive = false;
  }
  anglerState.cues?.release();
  anglerState.cues = null;
  anglerState.fish = null;
  anglerState.stage = 'lurk';
  anglerState.timer = 0;
  anglerState.baseContact = 0;
  anglerState.cycles = 0;
  anglerState.lastHpFrac = 1;
  anglerState.station = null;
}

export function resetAngler() {
  releaseAngler();
  resetEmissiveCues();
}

export function attachAngler(scene, e) {
  releaseAngler();
  if (!isAnglerBoss(e)) return;
  anglerState.fish = e;
  anglerState.baseContact = e.contactDamage ?? 0;
  // The visual, not the enemy record — the materials hang off the model.
  anglerState.cues = attachEmissiveCues(e.mesh ?? e.visual ?? null);
  anglerState.stage = 'lurk';
  // Settled, not armed. A boss that arrives already able to strike gets its
  // wind-up over with while the player is still reading the banner, so the
  // first ambush of the fight — the one that teaches the tell — is the one
  // they never see.
  anglerState.timer = cfg().settle ?? 0.6;
  anglerState.cues?.hold('lurk');
}

/**
 * The cadence. GAME time and inside the run gate, like the kraken's — an
 * ambush is a fight mechanic and it has to stop when the fight does. A boss
 * that went on winding up behind the level-up cards would launch at a player
 * who never saw the tell.
 *
 * Runs AFTER updateBossPerks (see updateBossAbilities), which is what makes
 * the yield below correct rather than merely polite.
 */
export function updateBossAngler(dt, scene, playerPos, hooks = {}) {
  const e = anglerState.fish;
  if (!e || e.dead || !isAnglerBoss(e)) return;
  // The stage machine fires cues; the envelope is advanced once afterwards, so
  // anything fired this frame is on the material this frame. See the hurt note.
  stageMachine(dt, e, playerPos, hooks);
  anglerState.cues?.update(dt);
}

function stageMachine(dt, e, playerPos, hooks) {
  const c = cfg();

  // --- THE HURT FLASH -------------------------------------------------------
  // Read off the health here rather than from a damage callback, the way the
  // kraken reads its flinch: every path that hurts a boss already writes `hp`,
  // and hooking one of them would light the lure for that path only.
  //
  // BEFORE the envelope is advanced, not after. A cue fired below a completed
  // update() does not reach the material until the NEXT frame — one frame of
  // lag on a 30ms flash, which is a third of the whole thing and reads as the
  // hit not registering. Every cue this function fires is subject to the same
  // rule, which is why the stage machine below runs before the update too.
  const frac = e.maxHp > 0 ? Math.max(0, (e.hp ?? 0) / e.maxHp) : 1;
  if (anglerState.lastHpFrac - frac >= (c.hurtDamage ?? 0.02)) anglerHurt();
  anglerState.lastHpFrac = frac;

  // --- YIELD TO A PERK ------------------------------------------------------
  // A perk mid-lunge or mid-teleport owns the body. This file runs after
  // updateBossPerks, so without this it would overwrite that velocity every
  // frame and the perk would never move the animal — the bug that presents as
  // "the lunge perk does nothing on this one boss". Anything committed is
  // abandoned rather than resumed: the perk has moved the animal somewhere
  // else, and an ambush that carried on afterwards would launch from a
  // position it never aimed from.
  const perk = activeBossPerk();
  if (perk && perk.stage && perk.stage !== 'ready') {
    if (anglerState.baseContact > 0) e.contactDamage = anglerState.baseContact;
    e.ramming = false;
    e.animState = null;
    anglerState.stage = 'lurk';
    anglerState.timer = c.settle ?? 0.6;
    anglerState.cues?.hold('lurk');
    anglerState.cues?.clearFire();
    return;
  }

  const px = playerPos?.x;
  const py = playerPos?.y;
  const hasPlayer = Number.isFinite(px) && Number.isFinite(py);
  let dx = 0; let dy = 0; let dist = Infinity;
  if (hasPlayer) {
    // `e.mesh.position`, NOT `e.x` — an enemy record has no x/y at all, and
    // reading them gives undefined, which turns dx/dy into NaN, makes the
    // trigger comparison permanently false, and writes NaN into the velocity
    // the integrator steps. The boss then has no position and simply is not on
    // screen: no error, no warning, an invisible boss. Every other system that
    // needs a boss's position goes through the mesh — see bossPerks.js and
    // kraken.js — because the mesh IS where a creature is.
    dx = px - e.mesh.position.x;
    dy = py - e.mesh.position.y;
    dist = Math.hypot(dx, dy) || 1;
    dx /= dist; dy /= dist;
  }

  anglerState.timer -= dt;

  // --- LURK -----------------------------------------------------------------
  if (anglerState.stage === 'lurk') {
    e.animState = 'idle';
    // A DEAD STOP. It holds its station and turns its head — see faceToward for
    // why the facing is written here rather than left to `faceMotion`.
    e.perkDrive = true;
    e.vx = 0;
    e.vy = 0;
    if (hasPlayer) faceToward(e, dx, dy, dt, c.lurkTurnRate ?? 0.9);
    anglerState.cues?.hold('lurk');

    // It only strikes at something inside its reach AND only after it has
    // settled — otherwise a player who walks in during the recovery gets an
    // instant second lunge with no readable gap between them.
    if (anglerState.timer <= 0 && hasPlayer && dist <= (c.triggerRange ?? 11)) {
      anglerState.stage = 'windup';
      anglerState.timer = c.windup ?? 0.85;
      anglerState.cues?.fire('windup');
      // THE TELL, fired once at the top of the wind-up rather than every
      // frame. `bark` is the one-shot slot the kraken already telegraphs
      // through; here it resolves to `swim_start`, the file's own take of the
      // animal gathering itself to move.
      e.anim?.trigger('bark');
      hooks.onAnglerWindup?.(e);
    }
    return;
  }

  // --- WINDUP ---------------------------------------------------------------
  if (anglerState.stage === 'windup') {
    // Deliberately still `idle` (the `trap` take) underneath: `bark` is a
    // one-shot playing OVER the locomotion, and systems/animation.js hands
    // control back to whatever locomotion state is current when it finishes.
    // Setting `swim` here would mean the tell ends by dropping the animal into
    // a cruise for the last few frames before it launches.
    e.animState = 'idle';
    e.perkDrive = true;
    e.vx = 0;
    e.vy = 0;
    // Turning HARDER than it lurks — the body visibly snapping onto you is the
    // half of the telegraph that says WHERE, as against WHEN. It is still a
    // rate rather than a snap, so a player who moves during the tell can watch
    // it fail to fully correct, which is what makes circling it work.
    if (hasPlayer) faceToward(e, dx, dy, dt, c.windupTurnRate ?? 2.4);

    if (anglerState.timer <= 0) {
      anglerState.stage = 'lunge';
      anglerState.timer = c.lungeTime ?? 0.75;
      // Set here rather than left to next frame's branch. The transition frame
      // already carries the doubled contact damage, and a body that is
      // dangerous while still playing its wind-up pose is one frame of the
      // animal lying about what it is doing.
      e.animState = 'boost';
      // LOCKED HERE, at the end of the tell — see the note at the top.
      anglerState.dirX = dx;
      anglerState.dirY = dy;
      e.contactDamage = anglerState.baseContact * (c.lungeDamage ?? 2);
      // The committed run is an ATTACK, not overlap — see `ramming` in
      // entities/enemies.js for which of the boss ceilings each is held to.
      e.ramming = true;
      anglerState.cues?.fire('commit');
      anglerState.cues?.hold('travel');
      hooks.onAnglerLunge?.(e);
    }
    return;
  }

  // --- LUNGE ----------------------------------------------------------------
  if (anglerState.stage === 'lunge') {
    e.animState = 'boost';
    e.perkDrive = true;
    e.vx = anglerState.dirX * (c.lungeSpeed ?? 26);
    e.vy = anglerState.dirY * (c.lungeSpeed ?? 26);

    if (anglerState.timer <= 0) {
      anglerState.stage = 'snap';
      anglerState.timer = c.snapTime ?? 0.45;
      e.contactDamage = anglerState.baseContact;
      e.ramming = false;
      // The jaws close whether or not anything was in them. See the cadence
      // note: selling the miss is most of what makes the dodge land.
      e.anim?.trigger('bite');
      // A HOLD, not a fire — the light going out is a level the animal settles
      // at, and a descending fire would be swallowed by the travel hold it is
      // meant to replace. See the note in systems/emissivePulse.js.
      anglerState.cues?.hold('recover');
      hooks.onAnglerSnap?.(e);
    }
    return;
  }

  // --- SNAP -----------------------------------------------------------------
  // The bite one-shot is playing over the top; underneath, the body is already
  // coasting to a stop so the recovery has somewhere to decelerate FROM.
  if (anglerState.stage === 'snap') {
    e.animState = 'swim';
    e.perkDrive = true;
    const decay = Math.max(0, 1 - dt * (c.snapDrag ?? 4));
    e.vx *= decay;
    e.vy *= decay;
    if (anglerState.timer <= 0) {
      anglerState.stage = 'recover';
      anglerState.timer = c.recoverTime ?? 1.6;
    }
    return;
  }

  // --- RECOVER --------------------------------------------------------------
  // It relocates. NOT by handing the wheel to `behavior: 'hunt'`, which is what
  // this used to do and which made the boss chase you between ambushes — an
  // ambusher that chases is just a slow chaser, and it throws away the reason
  // the fight exists. Instead it drifts, at its own cruise speed, to a station
  // it picked when the recovery began.
  //
  // Relocating at all rather than sitting where it landed: a trap in a known
  // spot stops being a trap after the first one, and the player should have to
  // find it again each cycle. `faceMotion` owns the heading through this stage
  // — the drift is well above the 0.05 gate — which is correct, because here
  // the animal genuinely is going somewhere and should point that way.
  e.animState = 'swim';
  e.perkDrive = true;
  if (!anglerState.station && hasPlayer) {
    // A point at `stationRange` from the player, offset from the line it just
    // came down so it does not simply back up along its own lunge. The sign
    // alternates by cycle rather than being rolled, so the animal works its
    // way around the player over a fight instead of sometimes going nowhere.
    const side = (anglerState.cycles % 2) ? 1 : -1;
    const a = Math.atan2(-dy, -dx) + side * (c.stationSwing ?? 0.9);
    const r = c.stationRange ?? 13;
    anglerState.station = { x: px + Math.cos(a) * r, y: py + Math.sin(a) * r };
  }
  const st = anglerState.station;
  if (st) {
    const sx = st.x - e.mesh.position.x;
    const sy = st.y - e.mesh.position.y;
    const sd = Math.hypot(sx, sy);
    if (sd > 0.4) {
      const sp = c.repositionSpeed ?? (e.def.speed ?? 4.2);
      e.vx = (sx / sd) * sp;
      e.vy = (sy / sd) * sp;
    } else {
      e.vx = 0; e.vy = 0;
      if (hasPlayer) faceToward(e, dx, dy, dt, c.lurkTurnRate ?? 0.9);
    }
  }
  if (anglerState.timer <= 0) {
    anglerState.stage = 'lurk';
    anglerState.timer = c.settle ?? 0.6;
    anglerState.cycles++;
    anglerState.station = null;
    anglerState.cues?.hold('lurk');
  }
}

/** A hit landed: bite the lure bright for a moment. Never changes the stage. */
export function anglerHurt() {
  anglerState.cues?.fire('hurt');
}

/** What the fight is doing right now — for the harness and the debug panel. */
export function anglerStage() {
  return {
    stage: anglerState.stage,
    timer: anglerState.timer,
    cycles: anglerState.cycles,
    emissive: anglerState.cues?.level ?? 1,
    cue: anglerState.cues?.stage() ?? null,
  };
}
