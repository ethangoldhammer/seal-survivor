import { CONFIG } from '../config.js';

// ===========================================================================
// CROWD CONTROL — who may be held, and who simply may not.
// ===========================================================================
// Six systems in this game stop a creature moving: the beluga's bubbles, the
// octopus grab, the bakalar's net, the club's ice on saturation, the club's own
// contact hold, and the dumbo's charm. They all express it the same way —
// `trapTimer` for "held, inert, harmless" and `charmTimer` for "fighting for
// the other side" — which is exactly right, and is why this file is possible at
// all: one concept, one field, one place to ask permission.
//
// THE RULE: A BOSS IS NEVER HELD BY A BASIC ABILITY.
//
// Not because it would be too strong. Because it deletes the fight. A boss is
// the one creature the whole arena is arranged around — the water is emptied
// for it, the camera frames it, it has forty times the health of anything else
// — and every one of the abilities above is on a short enough cooldown that
// two of them together mean a three-tonne animal that never gets a turn. The
// player would win, every time, and would never find out what the fight was.
//
// It also breaks the perks outright. `lunge` is a wind-up and a committed dash
// the player is meant to read and sidestep; a bubble landing during the wind-up
// leaves a boss frozen mid-tell with its contact damage multiplied, and the
// tell it is holding is now a lie. `teleport` blinks a body that is supposed to
// be locked in place. Neither is a bug in those perks — they are what a fight
// looks like when the thing having it can be switched off.
//
// WHAT A BOSS IS STILL VULNERABLE TO, deliberately: damage of every kind,
// knockback, the chill SLOW, marks, elemental burn. A slow is a tax on its
// movement and the player still has to swim away from it; a hold is the
// movement not happening. That line — does the boss still get a turn? — is
// what this file is drawing, and it is why chillEnemy keeps stacking cold on a
// boss and only the freeze at saturation is refused.
//
// The gate is the CREATURE, not the ability, on purpose. A new hold added
// tomorrow routes through holdEnemy because that is how holds are written in
// this codebase, and it inherits the rule without knowing the rule exists. The
// alternative — an allow-list of abilities that may hold bosses — is a list
// somebody has to remember to add to, which is the same as no list at all.
//
// ===========================================================================
// THE DAZE — what a refused hold turns into instead of nothing.
// ===========================================================================
// A flat refusal was the right rule and the wrong feeling. Six abilities in
// the roster do their whole job through this file, and against the one fight
// the run is built around every one of them silently did NOTHING: the harp
// played a note that was only ever a small damage packet, the octopus pulsed
// at a creature it had already skipped, Cold Snap ramped a slow to saturation
// and then threw the saturation away. A card that reads "stops what it hits"
// and stops nothing in a boss fight is a card the player is right to feel
// cheated by.
//
// So a hold on a boss becomes a DAZE: a couple of seconds of heavy slow with
// its heading weaving off you, its next wind-up cancelled, and its contact
// damage still very much on. Every word of that is load-bearing —
//
//   IT STILL GETS A TURN. It moves, it steers (badly), it hurts you if you
//   swim into it. Nothing about the fight is switched off; the boss is having
//   a bad two seconds, which is the most a basic ability should be able to buy
//   against the thing the arena was emptied for.
//
//   IT CANNOT BE CHAINED. One timer, latched not summed, hard-capped by
//   `daze.max` — and when it ends the boss is immune for `daze.cooldown`. The
//   whole roster landing at once is worth exactly one daze, and a build that
//   stacks all six of them gets it no more often than a build with one. That
//   is the answer to "don't let it stack": there is one budget, and it is the
//   creature's, not the ability's.
//
//   IT INTERRUPTS TELLS, NOT COMMITMENTS. systems/bossPerks.js reads `isDazed`
//   and cancels a wind-up it has not committed to yet, then re-telegraphs
//   after the daze. It never stops a lunge already in flight — freezing a body
//   mid-tell is exactly the failure the rule at the top of this file exists to
//   prevent, and the tell would become a lie.
//
// Sources do not each get their own knob. A hold is converted by ONE rule
// (`daze.fraction` of whatever the ability asked for, clamped into
// [`daze.min`, `daze.max`]), so a longer-invested charm is worth a slightly
// longer daze and nothing can be worth more than a couple of seconds — and so
// a hold added tomorrow inherits all of it by routing through holdEnemy, the
// same way it inherits the refusal today.
// ===========================================================================

/**
 * Is this creature immune to being held?
 *
 * `CONFIG.boss.control.immune` can turn the rule off for a debug session; a
 * missing config block means immune, so the rule holds even against a tuning
 * snapshot that has never heard of it. (A saved tuning file outranks a config
 * default, so a rule that defaulted the other way would be one stale snapshot
 * away from being off in someone's live game.)
 */
export function controlImmune(e) {
  if (!e?.isBoss) return false;
  return CONFIG.boss?.control?.immune !== false;
}

/**
 * May this creature be held OUTRIGHT — bubbled, netted, frozen, charmed?
 *
 * Still false for every boss, and still the line this file is drawing. What
 * changed is that a `false` here is no longer the end of the story: see
 * canControl below, which is the question a targeting scan should be asking.
 */
export function canHold(e) {
  return !!e && !controlImmune(e);
}

function dazeCfg() {
  return CONFIG.boss?.control?.daze ?? {};
}

/** Is the daze switched on at all? Off means the old flat refusal, exactly. */
function dazeEnabled() {
  return dazeCfg().enabled !== false;
}

/**
 * Is this creature carrying a daze right now? Read by systems/bossPerks.js to
 * hold its tells, and by the integrator in entities/enemies.js for the slow
 * and the weave.
 */
export function isDazed(e) {
  return (e?.dazeTimer ?? 0) > 0;
}

/**
 * Would a daze land on this creature right now?
 *
 * Three ways it wouldn't: the boss is already dazed (one at a time), it is
 * inside the recovery window a previous daze left behind, or it is
 * invulnerable — which during a boss fight means the ENTRANCE, and a ceremony
 * that promises nothing is happening must not be interruptible either.
 */
export function dazeReady(e) {
  if (!e || !controlImmune(e) || !dazeEnabled()) return false;
  if (e.hp <= 0 || e.invuln > 0) return false;
  return (e.dazeTimer ?? 0) <= 0 && (e.dazeCooldown ?? 0) <= 0;
}

/**
 * THE TARGETING TEST. "Is there any point aiming a hold at this creature?"
 *
 * canHold answers it for everything that isn't a boss; for a boss it is the
 * daze that decides, and a boss already reeling (or still recovering) is worth
 * no more than one that cannot be held at all — the octopus should spend its
 * pulse on the shark beside it instead. Every scan that used to ask canHold
 * while CHOOSING should ask this; the ones asking for PERMISSION are already
 * covered, because holdEnemy and charmEnemy do the conversion themselves.
 */
export function canControl(e) {
  return canHold(e) || dazeReady(e);
}

/**
 * Convert a hold into the boss's version of it. Internal to this file's two
 * public verbs — nothing outside should be deciding on its own that something
 * deserves a daze, or the single-budget rule has as many holes as callers.
 *
 * `seconds` is what the ability ASKED for, and the conversion is deliberately
 * lossy in one direction only: a fraction of it, floored so even the shortest
 * freeze is a readable stagger, ceilinged so the longest charm in the game is
 * still only a couple of seconds.
 */
function dazeEnemy(e, seconds) {
  if (!dazeReady(e) || !(seconds > 0)) return false;
  const c = dazeCfg();
  const want = seconds * (c.fraction ?? 0.35);
  e.dazeTimer = Math.min(c.max ?? 1.6, Math.max(c.min ?? 0.5, want));
  // The recovery is armed NOW rather than when the daze expires, so it cannot
  // be dodged by a source that lands on the frame the timer hits zero. It is
  // counted down only once the daze itself is over — see tickDaze.
  e.dazeCooldown = Math.max(0, c.cooldown ?? 5);
  // A fresh weave each time, so two dazes in one fight don't trace the same
  // path. The sign is what decides which way it lists.
  e.dazePhase = Math.random() * Math.PI * 2;
  e.dazeSign = Math.random() < 0.5 ? -1 : 1;
  // Queued rather than announced from here. A daze can be thrown by six
  // different systems, several of them mid-iteration over the enemy list, and
  // this file has no business knowing what a camera shake is — so it records
  // that it happened and main.js drains the list once a frame. Same shape and
  // the same reason as elements.js's `pendingBursts`.
  fresh.push(e);
  return true;
}

// Bodies dazed since the last drain. At most one boss is ever alive, so this
// holds one entry in practice and is a list only so a drain that is skipped
// for a frame cannot lose an event.
const fresh = [];

/**
 * Take the frame's new dazes. Clears as it hands them over, so a caller that
 * forgets to drain cannot replay an old one — and so a system that never
 * drains at all (a harness) leaks nothing but a couple of references.
 */
export function consumeDazes(out = []) {
  out.length = 0;
  for (const e of fresh) out.push(e);
  fresh.length = 0;
  return out;
}

/**
 * Hold a creature still for `seconds`. Returns whether it took, so a caller
 * can decide not to spend a charge, play a sound, or count a control event.
 *
 * A boss takes the daze instead, and the return is TRUE when it does — the
 * caller spent something and got something, and the two callers that read this
 * return to decide whether to spend their charge (chillEnemy's saturation,
 * the beluga's bubble) are both right to treat a daze as payment.
 *
 * Latching (max, not assign) is the shared contract: two bubbles on one fish
 * is the longer of the two holds, never the second one cutting the first short.
 */
export function holdEnemy(e, seconds) {
  if (!(seconds > 0)) return false;
  if (!canHold(e)) return dazeEnemy(e, seconds);
  e.trapTimer = Math.max(e.trapTimer ?? 0, seconds);
  return true;
}

/**
 * Turn a creature against its own side for `seconds`. Same rule and the same
 * return. A boss is never turned — it takes the daze, which is the difference
 * between a boss fighting for you and a boss briefly losing the thread.
 */
export function charmEnemy(e, seconds) {
  if (!(seconds > 0)) return false;
  if (!canHold(e)) return dazeEnemy(e, seconds);
  e.charmTimer = Math.max(e.charmTimer ?? 0, seconds);
  return true;
}

/**
 * Age one creature's daze. Called from the enemy integrator, beside the
 * charm/trap timers it sits alongside — the daze is a status on a body like
 * any other, and a separate pass over the enemy list to tick one number would
 * be a second walk for nothing.
 *
 * The cooldown only starts running once the daze itself is over, which is what
 * makes `daze.cooldown` mean "seconds of immunity after it wears off" rather
 * than "seconds between dazes" — the second reading would let a long daze be
 * followed instantly by another.
 */
export function tickDaze(e, dt) {
  if ((e.dazeTimer ?? 0) > 0) {
    e.dazeTimer = Math.max(0, e.dazeTimer - dt);
    e.dazePhase = (e.dazePhase ?? 0) + dt * (dazeCfg().veerRate ?? 2.2);
    return;
  }
  if ((e.dazeCooldown ?? 0) > 0) e.dazeCooldown = Math.max(0, e.dazeCooldown - dt);
}

/**
 * How much of its own swimming a dazed body keeps, 0..1.
 *
 * 1 for anything not dazed, so the integrator can multiply unconditionally.
 * NOT applied while a perk is driving the body: `perkDrive` means the velocity
 * this frame belongs to a committed lunge, and slowing that is the same thing
 * as interrupting it — which is the one thing the daze must never do.
 */
export function dazeSpeedMul(e) {
  if (!isDazed(e) || e.perkDrive) return 1;
  return Math.max(0, 1 - (dazeCfg().slow ?? 0.55));
}

/**
 * The wander, in RADIANS PER SECOND, to turn a dazed body's heading by.
 *
 * A rate rather than an offset, and applied to the velocity rather than to the
 * step, so the animal's FACING weaves with it — facing is read off the
 * direction of travel (see systems/facing.js), and a body sliding sideways
 * while still pointed dead at you reads as a physics bug rather than as a
 * creature that has lost its line.
 *
 * A swing that crosses back through zero rather than a constant lean: a fixed
 * offset just looks like a boss that has decided to swim somewhere else. The
 * creature's own steering fights this every frame, which is exactly the
 * picture — it is trying to hold the line and not managing it. 0 whenever the
 * daze isn't steering; see dazeSpeedMul.
 */
export function dazeVeer(e) {
  if (!isDazed(e) || e.perkDrive) return 0;
  const c = dazeCfg();
  return (e.dazeSign ?? 1) * (c.veer ?? 0.9) * Math.sin(e.dazePhase ?? 0);
}

/**
 * Take a daze off a body outright. For the run reset and the boss clear-out —
 * a creature carried between fights must not arrive still reeling, and a body
 * recycled out of the pool must not inherit a recovery window.
 */
export function clearDaze(e) {
  e.dazeTimer = 0;
  e.dazeCooldown = 0;
  // ...including an announcement it queued and nothing has drained yet: the
  // run that would have heard it is over.
  const i = fresh.indexOf(e);
  if (i >= 0) fresh.splice(i, 1);
}

/** Drop every pending announcement. For the run reset. */
export function resetControl() {
  fresh.length = 0;
}
