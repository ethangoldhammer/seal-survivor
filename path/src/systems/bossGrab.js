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
export function tryBossGrab(e, hooks = {}) {
  const c = CONFIG.bossGrab;
  if (c?.enabled === false) return false;
  if (held) return false;
  if (!e?.def?.grab) return false;
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
  };
  e.grabbing = true;
  e.grabCooldown = c?.cooldown ?? 9;

  // Held BEFORE the feedback, because the feedback carries a hitstop and the
  // hitstop is what makes "you are not driving any more" land before the player
  // has had time to push the stick and find out. Same reasoning the anglerfish's
  // snare is written under, one notch louder.
  //
  // FOR THE HOLD AND NOT A MOMENT LONGER. The release ends it explicitly (see
  // `release`), because a snare that outlived the grip would leave the seal
  // limp for the one second it most needs to swim — thrown clear, at speed,
  // through water a boss is still in.
  snarePlayer(c?.hold ?? 2, c?.snareMul ?? 0.06, RELEASE_THAW);

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
function release(thrown = true) {
  if (!held) return;
  const c = CONFIG.bossGrab ?? {};
  const e = held.enemy;
  const p = player.mesh.position;
  held = null;
  if (e) e.grabbing = false;

  if (!thrown) return;

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
  if (held.t >= (c.hold ?? 2)) {
    release(true);
    return;
  }

  // --- carried ---------------------------------------------------------------
  const pos = player.mesh.position;
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
  snarePlayer(Math.max(RELEASE_THAW, (c.hold ?? 2) - held.t), c.snareMul ?? 0.06, RELEASE_THAW);

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
