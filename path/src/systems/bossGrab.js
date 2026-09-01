import { CONFIG } from '../config.js';
import { enemies } from '../entities/enemies.js';
import { player, snarePlayer, applyPlayerKnockback } from '../entities/player.js';
import { clampToArena } from '../arena.js';
import { feedback } from './feedback.js';

// ===========================================================================
// BOSS GRAB — the one attack in the game that takes the controls away.
// ===========================================================================
// A shark, an orca or a mosasaur lands a CLEAN bite, closes its jaws on the
// seal instead of just billing it, and swims off with the player in its mouth
// for a couple of seconds before spitting them clear.
//
// Read CONFIG.bossGrab first — it carries the design argument (why a hold is
// allowed to exist here at all, given that systems/control.js spends a page on
// why holds delete fights) and every number. This file is only the mechanism.
//
// ---------------------------------------------------------------------------
// WHERE IT SITS IN THE FRAME, WHICH IS THE WHOLE TRICK.
// ---------------------------------------------------------------------------
// The seal's position is written by updatePlayer: thrust, the dash, gravity,
// drag, the speed clamp, knockback and the arena clamp, in that order. Nothing
// in that chain has a seam a second owner could be threaded into without
// touching all of it — and a `heldBy` field checked in six places inside
// updatePlayer is six places to forget.
//
// So this runs AFTER updatePlayer and simply has the last word. The seal swims
// normally for the frame and is then placed in the mouth, which costs one
// vector write and needs updatePlayer to know nothing at all. The cost of
// that choice is that everything upstream still RAN — so the velocity has to be
// zeroed here too, or the frame the grip opens the seal launches off along
// whatever it had accumulated while pinned.
//
// The snare is belt and braces on top: `snarePlayer` cuts thrust and the speed
// ceiling to a fraction, which is what stops the seal building momentum it
// cannot spend, and — more importantly — is what the READOUTS already know how
// to show. A player who mashes the stick during a grab should see the seal
// straining, not see the input vanish.
//
// ---------------------------------------------------------------------------
// WHY THE MOUTH IS AN OFFSET AND NOT A BONE.
// ---------------------------------------------------------------------------
// Same reason onPlayerBite measures its damage gate from `mesh.position`, and
// it is a measured fact rather than an approximation: on every rig in this game
// that bites, the container's origin sits near the HEAD — the megalodon's snout
// is 3.9 units in front of it and its tail 21.9 behind, and the orca, the
// mosasaur and the hammerhead all measure the same way. tools/boss-bite-test.mjs
// holds that claim on the real bodies. So a modest step forward along the
// animal's own heading IS the jaw line, and needs no rig, no lookRig tip (the
// anglerfish ships none) and no first-frame zero vector.
// ===========================================================================

// One at a time, always. Two bosses are never in the water together, and a
// second grab arriving mid-grab is a bug rather than a case to handle.
let held = null;

// Scratch for the claw anchor, so a grab costs no allocation per frame.
const _anchor = { x: 0, y: 0, z: 0 };

// How long the seal's own swimming takes to come back once the jaws open.
// Short, and not zero: `snarePlayer`'s thaw is a ramp rather than a switch, and
// a hold that ended on one frame reads as the game hitching. A quarter second
// is long enough to feel the grip let go and short enough that the throw is
// still the player's to steer out of.
const RELEASE_THAW = 0.25;

/**
 * Wipe the state without touching the player. For a new run, and for the paths
 * that end a grab because its subject stopped existing.
 */
export function resetBossGrab() {
  if (held?.enemy) held.enemy.grabbing = false;
  held = null;
}

/**
 * Let go now, because the thing holding the seal says so.
 *
 * The claw grab's owner (systems/bossCrab.js) runs its own throw and knows when
 * it has finished; the shared clock above is only its backstop. `thrown` false
 * is the tear-up path — the crab died, the run ended — and spits nobody.
 */
export function endBossGrab(thrown = true) {
  release(thrown);
}

/** Is the seal in something's mouth right now? For the readouts and harnesses. */
export function playerGrabbed() {
  return !!held;
}

/** The creature holding the seal, or null. */
export function grabbedBy() {
  return held?.enemy ?? null;
}

/**
 * A boss's jaws have just closed on the seal at the front of the animal.
 *
 * Called from the bite hook in main.js, on the frame `biteDamage` is billed and
 * from inside the same reach test — which is the entire gate. That test is the
 * narrow one (CONFIG.bite.mouthReach, the head and nothing else), NOT the wide
 * one that starts the mouth opening from a body length out, so a boss cannot
 * take hold of you with its flank and cannot take hold of you at the end of a
 * lunge you sidestepped.
 *
 * @returns true if the grab took, which the caller uses to decide whether the
 *   ordinary bite feedback still plays — a grab is its own moment and should
 *   not arrive underneath a chomp.
 */
export function tryBossGrab(e, hooks = {}, claw = null) {
  const c = CONFIG.bossGrab;
  if (c?.enabled === false) return false;
  if (held) return false;
  // TWO WAYS TO BE CAUGHT, and the gate is different for each.
  //
  //   JAWS — `def.grab`, the sharks and their relatives, taken through the bite
  //   hook in main.js which has already tested the narrow mouth reach.
  //
  //   A CLAW — the king crab's haymaker, which is not a bite and has no mouth.
  //   Its caller (systems/bossCrab.js) owns the gate: it has run a committed
  //   attack, the claw has shut, and combat.js has billed the hit. Passing a
  //   `claw` record IS that authorization, which is why it is not also asked
  //   for `def.grab` — a crab has no jaws and never will.
  //
  // Everything BELOW this point is shared on purpose. One owner of "the seal is
  // held" is what keeps the snare, the release, the i-frames, the readouts
  // (playerGrabbed) and combat.js's suppression true for both — two systems
  // both writing the player's position after updatePlayer is a bug with no
  // symptom until the frame they disagree.
  if (!claw && !e?.def?.grab) return false;
  // A creature on its way out of the world, held, charmed or still arriving is
  // not biting anybody — the same four gates every other attack in the game
  // asks about, and `invuln` is the arrival ceremony (see tickArrival).
  if (e.invuln > 0 || e.trapTimer > 0 || e.charmTimer > 0) return false;
  if ((e.grabCooldown ?? 0) > 0) return false;

  held = {
    enemy: e,
    t: 0,
    crush: 0,
    // The seal is REELED to the mouth rather than snapped there, so the reel
    // needs somewhere to start from and the first frame must not jump. See
    // `reelRate` in the config.
    thrash: 0,
    // THE CLAW'S RECORD, when there is one. `anchor(out)` is asked every frame
    // for the world point to hold the seal at — the posed claw, not a position
    // this file could work out — and `hold` is how long it lasts. `throwWith`
    // is filled in by the crab as it lets go, so the release throws along the
    // arm's own swing rather than along the body's heading.
    claw,
  };
  e.grabbing = true;
  e.grabCooldown = claw?.cooldown ?? c?.cooldown ?? 9;

  // Held BEFORE the feedback, because the feedback carries a hitstop and the
  // hitstop is what makes "you are not driving any more" land before the player
  // has had time to push the stick and find out. Same reasoning the anglerfish's
  // snare is written under, one notch louder.
  //
  // FOR THE HOLD AND NOT A MOMENT LONGER. The release ends it explicitly (see
  // `release`), because a snare that outlived the grip would leave the seal
  // limp for the one second it most needs to swim — thrown clear, at speed,
  // through water a boss is still in.
  snarePlayer(holdTime(), c?.snareMul ?? 0.06, RELEASE_THAW);

  const p = player.mesh.position;
  feedback('bossGrab', { x: p.x, y: p.y, vx: e.vx, vy: e.vy, scale: 1.4 });
  hooks.onBossGrab?.(e);
  return true;
}

/**
 * Let go, for whatever reason.
 *
 * @param thrown  false when the grab is being torn up rather than finished —
 *   the boss died, the run ended, the player did. There is nothing to spit and
 *   nobody to throw.
 */
/** How long this hold lasts — the claw's own, or the shared bite's. */
function holdTime() {
  const c = CONFIG.bossGrab ?? {};
  return held?.claw?.hold ?? c.hold ?? 2;
}

function release(thrown = true) {
  if (!held) return;
  const c = CONFIG.bossGrab ?? {};
  const e = held.enemy;
  const p = player.mesh.position;
  const claw = held.claw;
  held = null;
  if (e) e.grabbing = false;

  // BACK ON THE PLAY PLANE. Only the claw grab ever takes the seal off it (see
  // the depth note in the carry above), and it has to be put back on EVERY exit
  // — thrown, torn up, boss died — or the run continues with a player sorting
  // in front of the water it is swimming in. Snapped rather than eased: the
  // camera is orthographic, so this changes draw order and nothing else, and
  // the frame it happens on is the frame the seal is being thrown anyway.
  if (claw) p.z = 0;

  if (!thrown) return;

  // THROWN BY THE ARM. A claw grab ends wherever the crab's own throw was
  // going: systems/bossCrab.js has spent the last fraction of a second moving
  // the IK target through a slam or a hurl, and it hands the direction and the
  // speed over here so the seal leaves along the gesture the player just
  // watched. Falling back to the spit below would throw the seal off the
  // BODY's heading — which on a crab, an animal that walks sideways, points
  // somewhere the attack never went.
  if (claw?.throwWith) {
    const t = claw.throwWith;
    applyPlayerKnockback(t.x, t.y, t.speed ?? c.throwSpeed ?? 30);
    player.snareTimer = Math.min(player.snareTimer, RELEASE_THAW);
    player.snareThaw = RELEASE_THAW;
    player.invuln = Math.max(player.invuln ?? 0, c.releaseGrace ?? 0.9);
    feedback('bossRelease', { x: p.x, y: p.y, dirX: t.x, dirY: t.y, scale: 1.3 });
    return;
  }

  // SPAT FORWARD AND ASIDE. Along the animal's own heading, rotated off it by
  // `throwSpread`, so the seal ends the moment travelling fast in a direction
  // it did not choose and has to spend that speed before it can do anything
  // else. Dropping it on the spot would leave the player exactly where the boss
  // wanted them, which is the opposite of a release.
  //
  // The side is the side the seal is already on, so the throw carries it OUT of
  // the body rather than through it.
  const head = e ? (e.heading ?? Math.atan2(e.vy ?? 0, e.vx ?? 1)) : 0;
  const side = e ? Math.sign(Math.sin(head) * (p.x - e.mesh.position.x)
    - Math.cos(head) * (p.y - e.mesh.position.y)) || 1 : 1;
  const a = head + side * (c.throwSpread ?? 0.9);
  applyPlayerKnockback(Math.cos(a), Math.sin(a), c.throwSpeed ?? 30);

  // AND THE HOLD ENDS HERE, explicitly. `snarePlayer` takes the strongest and
  // longest of what it is asked for and cannot be talked down (see its note),
  // which is right for a hold arriving and wrong for one being let go of — so
  // the timer is cut to the thaw directly. Cut rather than cleared: the ramp
  // back to full control is what stops the release reading as a hitch.
  player.snareTimer = Math.min(player.snareTimer, RELEASE_THAW);
  player.snareThaw = RELEASE_THAW;

  // I-frames on the way out, and longer than an ordinary hit's. The seal is
  // being thrown through water a boss is still swimming through, and a grab
  // that ended by handing the player straight back to its body would be the
  // pile-on the i-frame window exists to remove.
  player.invuln = Math.max(player.invuln ?? 0, c.releaseGrace ?? 0.9);

  feedback('bossRelease', { x: p.x, y: p.y, dirX: Math.cos(a), dirY: Math.sin(a), scale: 1.3 });
}

/**
 * One frame of being carried.
 *
 * MUST RUN AFTER updatePlayer — see the note at the top of the file. It is the
 * last thing to touch the seal's position, and everything it overwrites has
 * already been integrated for the frame.
 *
 * @param hooks  `onPlayerHit(dmg, dir, source, channel)`, main.js's, so every
 *   point of this goes through the same ledger, the same shove and the same
 *   CONFIG.boss.damageCap ceilings as a bite. The grab does not open a budget
 *   of its own; it spends from the fight's.
 */
export function updateBossGrab(dt, hooks = {}) {
  if (!held) return;
  const c = CONFIG.bossGrab ?? {};
  const e = held.enemy;

  // THE SUBJECT HAS TO STILL BE IN THE WATER. Checked by membership rather than
  // by a flag, because `removeEnemy` is the one funnel every death, despawn and
  // clear-out goes through and it sets no flag this file could read. A boss
  // killed with the seal in its mouth lets go on the frame it dies.
  if (!e || enemies.indexOf(e) < 0) {
    release(false);
    return;
  }

  held.t += dt;
  // The claw grab is ENDED BY ITS OWNER, not by this clock: the crab decides
  // when the throw has finished travelling and calls releaseBossGrab itself.
  // The timeout is still here as a guard — a crab that dies mid-throw, or a
  // state machine that somehow never finishes, must not leave the seal welded
  // to a claw for the rest of the run.
  const limit = held.claw ? holdTime() + (held.claw.throwMax ?? 1.5) : holdTime();
  if (held.t >= limit) {
    release(true);
    return;
  }

  // --- carried ---------------------------------------------------------------
  const pos = player.mesh.position;

  // IN THE CLAW. The anchor is the posed bone, asked for every frame, so the
  // seal goes wherever the arm goes — through the hold, through the swing, and
  // into the seabed if that is where the crab is putting it. Everything below
  // (the mouth offset, the thrash, the heading) is about an animal that
  // carries things in FRONT of itself, and none of it applies.
  //
  // ONE FRAME BEHIND, and knowingly: the claw is posed in updateEnemies, which
  // runs after this. The reel below is what absorbs it — at 60fps the seal
  // trails the claw by a sixtieth of its swing, which is smaller than the reel
  // is already smoothing out.
  if (held.claw) {
    const at = held.claw.anchor?.(_anchor);
    if (at) {
      const k = 1 - Math.exp(-(held.claw.reelRate ?? c.reelRate ?? 14) * dt);
      pos.x += (at.x - pos.x) * k;
      pos.y += (at.y - pos.y) * k;
      // ...AND IN DEPTH, which no other grab needs and this one cannot do
      // without. The seal lives at z 0 and nothing in the game has ever moved
      // it; the king crab does not. It is broadside to an orthographic camera
      // and 15 units deep — measured, its body spans z -7.2 to +8.4 around an
      // origin on the play plane — and its arm solves to about z +2 at full
      // extension, because a CCD chain with joint limits converges near its
      // target rather than on it. So a seal held at z 0 is held two units
      // BEHIND the claw and inside the animal, where the crab's own near half
      // draws over it: the grab happens and the player cannot see it.
      //
      // Following the claw in z puts the seal in front of the body, which is
      // both the truth and the only version of this that reads. Restored on
      // release — see below — and only the HUD's own bar reads the seal's z,
      // which projects it correctly wherever it is.
      pos.z += ((at.z ?? 0) - pos.z) * k;
    }
    player.velocity.set(0, 0);
    clampToArena(pos, player.velocity, player.stats.hitRadius, 0);
    snarePlayer(Math.max(RELEASE_THAW, limit - held.t), c.snareMul ?? 0.06, RELEASE_THAW);
    // NO CHEWING. A shark's two seconds are spent eating you; a crab's half
    // second is a wind-up for the throw, and what it costs is on the other end
    // of that. Billing a crush here as well would be the same attack collecting
    // twice — see the slam's own damage in systems/bossCrab.js.
    return;
  }

  const bp = e.mesh.position;
  const head = e.heading ?? Math.atan2(e.vy ?? 0, e.vx ?? 1);
  const fx = Math.cos(head);
  const fy = Math.sin(head);
  const r = e.radius ?? 2;

  // THE SHAKE. Swung across the animal's own heading rather than along it: a
  // side-to-side worry is what a predator does with something in its jaws, and
  // a fore-and-aft one would just read as the seal sliding in and out of the
  // mouth. Amplitude is a fraction of the boss's radius so it scales with the
  // body, and this is the difference between being carried and being welded on
  // — a passenger held perfectly still relative to a moving animal looks like a
  // parenting bug, however good the animation under it is.
  held.thrash += dt * (c.thrashRate ?? 11);
  const swing = Math.sin(held.thrash) * r * (c.thrashAmp ?? 0.4);

  const mx = bp.x + fx * r * (c.mouthOffset ?? 0.5) - fy * swing;
  const my = bp.y + fy * r * (c.mouthOffset ?? 0.5) + fx * swing;

  // REELED, NOT SNAPPED. An exponential approach on the remaining gap, so the
  // first frame moves the seal a little way toward the jaws and the rest of the
  // grab holds it there. Teleporting the player is the one thing this must not
  // do: the transition from swimming to held IS the read, and a body that
  // arrives instantly in the mouth reads as a rendering fault rather than as
  // having been caught.
  const k = 1 - Math.exp(-(c.reelRate ?? 14) * dt);
  pos.x += (mx - pos.x) * k;
  pos.y += (my - pos.y) * k;

  // Everything upstream still ran this frame (see the note at the top), so the
  // velocity it accumulated has to go or the release launches the seal along a
  // second's worth of thrust it never got to spend. The knockback offset is
  // left alone deliberately — a shove is integrated outside the snare on
  // purpose (see snarePlayer), and a boss that takes hold of you mid-throw
  // should still be dragging a seal that is visibly still moving.
  player.velocity.set(0, 0);

  // The seal is placed by an animal that is itself arena-clamped, so this is
  // very nearly a no-op — but `mouthOffset` and the swing both push OUTWARD
  // from the body, and a boss pressed against the wall would otherwise post the
  // player through it.
  clampToArena(pos, player.velocity, player.stats.hitRadius, 0);

  // Kept topped up rather than set once, because `snarePlayer` takes the
  // STRONGEST and LONGEST of what is asked (see its note) and a grab must not
  // be shortened by an earlier, weaker hold expiring underneath it — or by its
  // own thaw, which would otherwise hand the seal a fraction of its swimming
  // back for the last quarter second of being carried.
  snarePlayer(Math.max(RELEASE_THAW, holdTime() - held.t), c.snareMul ?? 0.06, RELEASE_THAW);

  // --- chewing ---------------------------------------------------------------
  // Discrete crunches rather than a per-second drain, and that is a
  // presentation decision with teeth: playerDamageFx banks per-frame slices and
  // decides when they are worth showing, so two seconds of drain would surface
  // as two or three anonymous flashes with no sound between them. A crunch is
  // the animal chewing — it has a moment, a burst and a voice.
  //
  // The rate is a fraction of the boss's own `biteDamage`, so it rides the same
  // enemies.csv number and the same per-instance difficulty ramp its bite does,
  // and a boss retuned in the table never needs this re-derived.
  held.crush += dt;
  const every = Math.max(0.05, c.crushEvery ?? 0.4);
  while (held.crush >= every) {
    held.crush -= every;
    const dmg = (e.biteDamage ?? 0) * (c.crushPerSecond ?? 0.5) * every;
    if (dmg > 0) {
      // NOT the 'strike' channel. A crunch is the grab continuing rather than a
      // new blow, and routing it through the i-frame window would mean a grab
      // that landed a fraction of a second after a crab's pinch did nothing at
      // all for its first tick — which reads as the boss's signature attack
      // being broken. It is bounded by its own `crushEvery` and by
      // CONFIG.boss.damageCap, which are the two ceilings that matter here.
      hooks.onPlayerHit?.(dmg, { x: -fx, y: -fy }, 'boss:grab', 'attack');
    }
    feedback('bossThrash', {
      x: pos.x, y: pos.y, vx: e.vx, vy: e.vy, scale: 0.9,
    });
  }
}
