import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { player } from '../entities/player.js';
import { hitCreature } from './hitShape.js';
import { feedback } from './feedback.js';

// ---------------------------------------------------------------------------
// BEING THROWN INTO SOMETHING — the other half of the shove.
//
// entities/player.js owns the shove itself: a position offset, decaying, held
// apart from `velocity` so the seal's own top speed cannot clip it. That file
// is deliberately ignorant of everything else in the water and has to stay
// that way — entities/ does not import from systems/. What it cannot see is
// what the seal is being thrown AT, which is the whole of this file.
//
// THREE THINGS HAPPEN TO A SHOVE, and they are worth different amounts:
//
//   IT LANDS      A pass connected and the seal is moving without having asked
//                 to. That is worth something on its own, scaled by how fast
//                 it left — `damagePerSpeed`. A glancing shove is a nudge; a
//                 committed one is a hit.
//
//   IT ARRESTS    ...against a wall, or against another body. The travel the
//                 shove was going to spend over the next third of a second is
//                 spent in one frame instead, and THAT is the expensive one:
//                 `wallMul` and `bodyMul` are both well over 1 because there
//                 is nowhere for it to go. It is also the one the player can
//                 do something about, which is what makes it fair — the shove
//                 is not a choice, but where you were swimming when it landed
//                 was.
//
//   IT DOES NOT   Open water. The seal coasts, the decay eats it, nothing
//                 further is charged. Most shoves end this way and should.
//
// AND BEING PINNED. Held against a wall by a body that is still pressing. It
// is the one state in this game with no exit that isn't the player's own
// swimming, so it RAMPS: `pin.dps` at the start, climbing by `pin.ramp` for
// every second it lasts, to `pin.max`. A second of it is a tax; four seconds
// of it is the run.
//
// WHY A RAMP RATHER THAN A BIG FLAT NUMBER. A flat rate that hurts enough to
// matter also hurts on the quarter-second of wall contact every fight contains
// by accident, and one that doesn't is free to sit in. The ramp is nothing for
// the first `pin.grace` and unsurvivable by the fourth second, which is the
// shape of the thing being described: brushing a wall is not being pinned
// against one.
//
// NOTHING HERE IS A HOLD. The seal's thrust is untouched throughout, exactly
// as it is during the shove itself — see the note in applyPlayerKnockback, and
// systems/control.js for the argument. This makes being stuck EXPENSIVE; it
// never makes it involuntary, and the way out is the same one it has always
// been.
//
// EVERY POINT OF IT IS BILLED TO THE CREATURE THAT SHOVED YOU, under that
// creature's own type key. A death against a wall the hammerhead put you into
// is a death by hammerhead — the headstone, the threat table and the quip pool
// all agree about that already, and a source string invented here ('slam')
// would have landed in none of them (see deathCauses.js).
// ---------------------------------------------------------------------------

export const slamState = {
  // The shove that has landed but not yet been charged for. Queued rather than
  // charged at the call site because the shove arrives from inside
  // resolveCombat, and onPlayerHit calling itself from inside its own body is
  // a shape nobody should have to reason about.
  pendingSpeed: 0,
  pendingDir: { x: 0, y: 0 },
  // WHO threw you, kept after the shove is charged for. The arrest happens
  // some frames later, against a wall that did not throw anybody — so without
  // this the collision would have nobody to bill and would land on 'unknown'.
  lastSource: null,
  // Seconds of continuous pin, and the ramp reads it. See above.
  pinTime: 0,
  // Rising-edge latches. An arrest is ONE event; without these a seal parked
  // against a wall with a live shove is charged sixty times a second for the
  // same collision.
  wallTouch: false,
  bodyTouch: false,
  // Seconds before another arrest may be charged, so a body scraping down a
  // wall does not bill both surfaces every other frame.
  cooldown: 0,
};

const contact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

function cfg() {
  return CONFIG.playerKnockback?.slam ?? {};
}

/** A new run starts unbruised and unpinned. */
export function resetSlam() {
  slamState.pendingSpeed = 0;
  slamState.pendingDir.x = 0;
  slamState.pendingDir.y = 0;
  slamState.lastSource = null;
  slamState.pinTime = 0;
  slamState.wallTouch = false;
  slamState.bodyTouch = false;
  slamState.cooldown = 0;
}

/**
 * A SHOVE HAS LANDED. Called from the one place that spends
 * applyPlayerKnockback, with what that call actually imparted — the RETURN
 * value, not the row's number, so a shove trimmed by CONFIG.playerKnockback
 * .maxSpeed is charged for what the seal received rather than for what the
 * creature asked for.
 *
 * @param speed   world units/sec actually imparted
 * @param source  the shover's own type key, for the ledger and the headstone
 * @param dir     the shove direction, for the flinch
 */
export function noteShove(speed, source, dir) {
  if (!(speed > 0)) return;
  slamState.lastSource = source ?? slamState.lastSource;
  // The BIGGEST shove in the frame wins rather than the last one. Two bodies
  // hitting on the same frame is one event to the player, and summing them
  // would charge twice for a single flinch.
  if (speed <= slamState.pendingSpeed) return;
  slamState.pendingSpeed = speed;
  slamState.pendingDir.x = dir?.x ?? 0;
  slamState.pendingDir.y = dir?.y ?? 0;
}

/** Whether a creature is a body that occupies space, rather than a fish. */
function isBody(e) {
  // `separates` is the roster's own flag for it — hunters and large animals —
  // and it is exactly the right membership here: being thrown through a school
  // of sardines is not an impact, and charging for one would turn every shove
  // in a busy arena into a wall slam. A boss qualifies whatever its row says,
  // because a boss is never not a body.
  if (!e.isBoss && !e.def?.separates) return false;
  return !(e.invuln > 0) && !e.leaving;
}

/**
 * Which wall the seal is against, or null. `push` is true to also require the
 * knock to be spending itself on that wall — an ARREST — and false to ask the
 * weaker question the pin needs, which is only where the seal is.
 *
 * `wallSlack` rather than an exact equality: clampToArena parks the body on
 * the line, but the seal is also rising, falling and swimming, so a test that
 * demanded the exact value would miss the arrest about as often as it caught
 * it.
 */
function wallContact(push) {
  const r = player.stats.hitRadius;
  const slack = cfg().wallSlack ?? 0.05;
  const p = player.mesh.position;
  if (p.x <= bounds.left + r + slack && (!push || player.knockX < 0)) {
    return { nx: 1, ny: 0, speed: -player.knockX };
  }
  if (p.x >= bounds.right - r - slack && (!push || player.knockX > 0)) {
    return { nx: -1, ny: 0, speed: player.knockX };
  }
  if (p.y <= bounds.bottom + r + slack && (!push || player.knockY < 0)) {
    return { nx: 0, ny: 1, speed: -player.knockY };
  }
  // The ceiling is a real surface too — clampToArena stops a breach dead at it.
  if (p.y >= bounds.top - r - slack && (!push || player.knockY > 0)) {
    return { nx: 0, ny: -1, speed: player.knockY };
  }
  return null;
}

/**
 * The body the seal is being driven INTO, or null. `push` as above: an arrest
 * wants the knock aimed at the animal, the pin only wants the animal there.
 */
function bodyContact(enemyList, push) {
  const p = player.mesh.position;
  const r = player.stats.hitRadius;
  for (const e of enemyList) {
    if (!isBody(e)) continue;
    const dx = e.mesh.position.x - p.x;
    const dy = e.mesh.position.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    // Into it, not merely near it. A shove that carries the seal ALONG a flank
    // is the shove doing what it does; only the component driving into the
    // body is an impact.
    const into = player.knockX * (dx / d) + player.knockY * (dy / d);
    if (push && into <= 0) continue;
    // THE SAME SHAPE THAT DECIDES WHETHER YOU CAN HIT IT, the way combat.js
    // puts it — a slam that used a circle would fire off a body-width of empty
    // water on every long animal in the roster.
    if (!hitCreature(e, p.x, p.y, r, contact)) continue;
    return { e, speed: Math.max(0, into) };
  }
  return null;
}

/** The direction to flinch along, pointing back off the body just hit. */
function awayFrom(e) {
  const p = player.mesh.position;
  const dx = p.x - e.mesh.position.x;
  const dy = p.y - e.mesh.position.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

/**
 * ONE FRAME OF EVERYTHING THAT HAPPENS TO A THROWN SEAL.
 *
 * Runs immediately after updatePlayer, which is the only moment the knock has
 * been integrated and the arena clamp applied — so an arrest reads as "on the
 * line, still pushing" and has not yet been bled by another frame of decay.
 *
 * @param enemyList the live creatures, for the bodies
 * @param hooks     { onPlayerHit(dmg, dir, source, channel) }
 */
export function updateSlam(dt, enemyList, hooks) {
  const c = cfg();
  if (c.enabled === false) { resetSlam(); return; }
  if (slamState.cooldown > 0) slamState.cooldown = Math.max(0, slamState.cooldown - dt);

  const minSpeed = c.minSpeed ?? 25;
  const perSpeed = c.damagePerSpeed ?? 0.12;
  const maxDamage = c.maxDamage ?? 30;
  const who = slamState.lastSource ?? 'unknown';

  // ---------------------------------------------------------------------------
  // EVERY HIT BELOW IS ON THE 'attack' CHANNEL, and it is the one decision in
  // this file that is not obvious.
  //
  // 'strike' is the channel for a whole number arriving on one frame, which is
  // what all three of these are — so it looks like the right answer, and it is
  // the wrong one. That channel buys the i-frame window (CONFIG.player
  // .hitIFrames, 0.4s), and the arrest lands ONE FRAME after the shove that
  // caused it. On 'strike' the shove would take the window and the arrest would
  // be silently refused by it — which is precisely the half the arrest exists
  // to add, deleted, with nothing on screen to say so.
  //
  // The window is there to stop a swarm of crabs billing nine pinches in one
  // frame. Nothing here can pile up like that: the shove is queued once per
  // frame and takes the biggest, and both arrests answer to `cooldown` below.
  // The rate limit these need, they already have.
  // ---------------------------------------------------------------------------

  // --- THE SHOVE ITSELF -----------------------------------------------------
  // Charged once, on the frame after it landed, for what it imparted.
  if (slamState.pendingSpeed > 0) {
    const speed = slamState.pendingSpeed;
    slamState.pendingSpeed = 0;
    if (speed >= minSpeed) {
      const dmg = Math.min(maxDamage, speed * perSpeed);
      if (dmg > 0) {
        hooks.onPlayerHit?.(dmg, { ...slamState.pendingDir }, who, 'attack');
      }
    }
  }

  // Everything below is about a shove IN FLIGHT. With nothing pushing there is
  // no impact to have — a seal resting against a wall under its own steam is
  // just a seal at a wall.
  const flying = Math.hypot(player.knockX, player.knockY) >= minSpeed;

  // --- ARRESTED AGAINST A WALL ---------------------------------------------
  const wall = flying ? wallContact(true) : null;
  if (wall && !slamState.wallTouch && slamState.cooldown <= 0 && wall.speed >= minSpeed) {
    const dmg = Math.min(maxDamage, wall.speed * perSpeed * (c.wallMul ?? 2.4));
    if (dmg > 0) {
      hooks.onPlayerHit?.(dmg, { x: wall.nx, y: wall.ny }, who, 'attack');
      // Scaled by how hard it landed, the way the boats' hull impacts are — a
      // graze off a wall and a full pass into one are the same event at two
      // very different volumes.
      feedback('playerSlam', {
        x: player.mesh.position.x, y: player.mesh.position.y,
        scale: Math.min(1.6, 0.5 + wall.speed / (c.loudAt ?? 60)),
      });
      slamState.cooldown = c.cooldown ?? 0.25;
    }
  }
  slamState.wallTouch = !!wall;

  // --- ARRESTED AGAINST A BODY ---------------------------------------------
  const body = flying ? bodyContact(enemyList, true) : null;
  if (body && !slamState.bodyTouch && slamState.cooldown <= 0 && body.speed >= minSpeed) {
    const dmg = Math.min(maxDamage, body.speed * perSpeed * (c.bodyMul ?? 2.8));
    if (dmg > 0) {
      // Billed to the SHOVER, not to the body that happened to be in the way.
      // Being thrown into a passing shark is the hammerhead's doing, and a
      // creature that was only swimming past should not appear on the threat
      // table for it.
      hooks.onPlayerHit?.(dmg, awayFrom(body.e), who, 'attack');
      feedback('playerSlam', {
        x: player.mesh.position.x, y: player.mesh.position.y,
        scale: Math.min(1.6, 0.5 + body.speed / (c.loudAt ?? 60)),
      });
      slamState.cooldown = c.cooldown ?? 0.25;
    }
  }
  slamState.bodyTouch = !!body;

  // --- PINNED ---------------------------------------------------------------
  // A wall at your back and a body on your front. BOTH halves are required:
  // the wall alone is a place to be, and a body alone is something to swim
  // away from. Together there is nowhere to go that is not through one of
  // them, and that is the state this ramp is for.
  //
  // Tested WITHOUT the knock gate the two arrests use, deliberately. A pin
  // outlives the shove that started it — the shove is spent in a third of a
  // second and the animal leaning on you is not — so requiring a live knock
  // would reset the ramp every time it started to bite.
  const pin = c.pin ?? {};
  const back = pin.enabled === false ? null : wallContact(false);
  const front = back ? bodyContact(enemyList, false) : null;
  if (front) {
    slamState.pinTime += dt;
    const over = slamState.pinTime - (pin.grace ?? 0.4);
    if (over > 0) {
      const dps = Math.min(pin.max ?? 48, (pin.dps ?? 14) + (pin.ramp ?? 18) * over);
      // The PRESSING creature is the source here and not the shover: this one
      // is not a consequence of a shove that has long since decayed, it is the
      // animal that is on you right now.
      hooks.onPlayerHit?.(dps * dt, { x: back.nx, y: back.ny }, front.e.type, 'attack');
      feedback('playerPinned', {
        x: player.mesh.position.x, y: player.mesh.position.y,
        scale: Math.min(1.4, 0.4 + over / (pin.fullAt ?? 2)),
      });
    }
  } else {
    slamState.pinTime = 0;
  }
}
