// ---------------------------------------------------------------------------
// THE VERSUS BOT — player 2 when nobody is holding player 2's pad.
//
// Two ways of deciding, one way of acting. Either the SCRIPT below or the
// learned POLICY (systems/imitation.js, path/src/versusPolicy.json) fills the
// same input object player 2's pad would have filled — a stick, an aim, and
// whether the strike is held — and everything after that is the ordinary
// player-2 body in systems/versus.js. The bot cannot do anything a pad
// cannot; it does not touch the ball or its own velocity directly.
//
// THE SCRIPT is a positional game, the way a human plays it: get BEHIND the
// ball (on the far side of it from the goal you are attacking), and when the
// line from you through the ball points at that goal, wind up and strike.
// When the meter runs low it goes and eats. It re-decides every `reaction`
// seconds rather than every frame, and its target has `jitter` on it — a
// bot that reads the world sixty times a second and never misjudges a line
// is not a bot anyone wants to play.
//
// THE POLICY is used when CONFIG.versus.bot.brain asks for it and the JSON
// says it has been trained; otherwise the script plays, so the game never
// depends on a training run having happened. The script is the default —
// measured, see the note on that field. Its answer comes back in the
// mirrored frame every imitation row is written in (own goal on the left)
// and is flipped for player 2, who really defends the right.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { captainIsCpu } from './versusFlag.js';
import { bounds, midWater } from '../arena.js';
import { mouthY, mouthHalfHeight } from './versusGoal.js';

// The wall player 2 defends. +1 is the right; the bot is always the second
// seal, and the second seal's own goal is the right mouth (spawnPoint and
// kickoffSpot in systems/versus.js put it there, and goal() scores a ball in
// the LEFT mouth for it).
const OWN_SIDE = 1;
import { pickups } from '../entities/pickups.js';
import { features, policyAction, policyUsable } from './imitation.js';
import policyJson from '../versusPolicy.json';

const cfg = () => CONFIG.versus?.bot ?? {};

let policy = policyJson;
/** Swap the policy in (the harness trains one and hands it over). */
export function setBotPolicy(model) { policy = model; }
export function botPolicy() { return policy; }

export const botState = {
  driving: false,     // the bot filled player 2's input this frame
  mode: 'scripted',   // what decided it: 'scripted' | 'policy'
  target: { x: 0, y: 0 },
  intent: 'idle',     // 'chase' | 'guard' | 'eat' | 'strike' — the script's read, for the readout
  decideT: 0,         // seconds until the next decision
  holdT: 0,           // seconds the strike has been held
  cooldown: 0,        // seconds until it may strike again
  heldPrev: false,
  jx: 0, jy: 0,       // the current jitter offset
  around: false,      // steering round the ball this frame rather than at the target
  aroundSide: 0,      // ...and on which side, kept while it lasts
  veto: false,        // the own-goal veto took the frame off it (see vetoOwnGoal)
  vetoes: 0,          // how many times this session, for the harness
};

/** Whether the bot should be driving: on, off, or only when no pad is on P2. */
export function botWanted(padConnected) {
  const on = cfg().enabled ?? 'auto';
  if (on === true) return true;
  if (on === false) return false;
  // A side the team select gave to the computer is the bot whatever is
  // plugged in; a side it gave to a person is the bot only if their pad has
  // gone — the same "nobody on the stick" rule as a match with no setup.
  if (captainIsCpu(1)) return true;
  return !padConnected;
}

export function resetBot() {
  botState.driving = false;
  botState.decideT = 0;
  botState.holdT = 0;
  botState.cooldown = 0;
  botState.heldPrev = false;
  botState.intent = 'idle';
  botState.veto = false;
  botState.vetoes = 0;
}

const _feat = new Float32Array(14);
const _act = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, strike: 0 };

/**
 * Fill `out` (player 2's input) for this frame. `me` is player 2's body
 * ({ pos, vel, charge, pending, active }), `ball` the ball, `opp` player 1's
 * position and velocity.
 */
export function updateBot(dt, me, ball, opp, out) {
  const c = cfg();
  const brain = c.brain ?? 'scripted';
  const useModel = (brain === 'policy' || brain === 'auto') && policyUsable(policy);
  botState.mode = useModel ? 'policy' : 'scripted';
  botState.driving = true;
  botState.cooldown = Math.max(0, botState.cooldown - dt);
  let held;
  if (useModel) held = policyStep(dt, me, ball, opp, out);
  else held = scriptStep(dt, me, ball, opp, out);
  // AFTER THE BRAIN, WHICHEVER BRAIN IT WAS. See vetoOwnGoal: the one thing
  // the bot may never do is not a thing either brain is trusted to avoid.
  held = vetoOwnGoal(me, ball, out, held);
  out.strikeHeld = held;
  out.strikeRelease = botState.heldPrev && !held;
  botState.heldPrev = held;
  out.connected = false;
  return out;
}

// --- the one thing it may never do -------------------------------------------
//
// THE OWN-GOAL VETO. Player 2 defends the RIGHT mouth, and nothing it does may
// send the ball into it. This is a rule about the ACTION, not about either way
// of choosing one, so it sits in updateBot after both of them: the script's
// alignment test is a test on the frame it decides, and a wind-up started on a
// good line is released some tenths of a second later on whatever line the ball
// has drifted to; the policy has no notion of a goal at all, and a policy
// trained tomorrow will have a different one again. A guarantee that lives in
// one brain is not a guarantee.
//
// THREE WAYS TO PUT IT IN YOUR OWN NET, and the veto has to know all three,
// because the one that actually happens in a match is not the one you would
// design a guard against:
//
//   THE SHOT      the seal's line through the ball is a ray at its own mouth.
//                 A strike drives the ball along roughly that line.
//   THE DEFLECTION the ball is ALREADY travelling at that mouth, and the bot
//                 adds to it instead of blocking it.
//   THE DRIBBLE   the one that was scoring. A seal out-swimming a slow ball
//                 holds its ground and pushes it (the contest in versus.js),
//                 so a bot sitting on the attacking side of the ball at
//                 contact range walks it home a few units a second, for
//                 seconds at a time, without ever striking. Measured: the
//                 seal-to-ball distance pinned at contact reach while the
//                 ball's vx climbed +14, +22, +54 — and no ray test sees it,
//                 because the line the bot is standing on is nowhere near the
//                 line the ball ends up on. So the third clause is not a ray
//                 at all: TOUCHING THE BALL FROM THE WRONG SIDE IS THE
//                 OFFENCE. A defender belongs goal-side of the ball; the bot
//                 may not lean on it from the other one.
//
// WHAT HAPPENS THEN: the wind-up is DROPPED, not released. A release is what
// fires the dash, so it must not happen; the banked charge is kept for a shot
// worth taking. And the stick goes ACROSS that line rather than along it, on
// the side it is already leaning, so the bot swings round the ball instead of
// leaning on it — which is the other half of the same mistake, because a seal
// out-swimming a slow ball pushes it (the contest in versus.js) and a bot
// parked on the goalward side dribbles it home without ever striking.
//
// It only binds within `vetoRange` of the ball. Further out there is nothing
// to push and nothing to launch, and a bot crabbing sideways from fifty units
// away because of a line it cannot reach would be its own bug.

/** Is a ball at `ball` sent along the unit (dx, dy) on target for the right mouth? */
export function intoOwnGoal(ball, dx, dy, ownSide = 1) {
  const c = cfg();
  // Meaningfully toward the wall it defends, not merely not-away from it: a
  // lateral clearance with a degree or two of own-ward lean is a fine ball.
  const toward = dx * ownSide;
  if (toward < (c.vetoOnward ?? 0.15)) return false;
  const wallX = ownSide < 0 ? bounds.left : bounds.right;
  const t = (wallX - ball.x) / (dx || 1e-6);
  if (!(t > 0)) return false;
  const y = ball.y + dy * t;
  const half = mouthHalfHeight() + (ball.r ?? 2.8) + (c.vetoMargin ?? 2);
  return Math.abs(y - mouthY()) <= half;
}

/** How close the bot has to be to be PUSHING the ball rather than near it. */
function contactReach(ball) {
  return (ball.r ?? 2.8) + (CONFIG.versus?.ball?.contactRadius ?? 2.2);
}

/**
 * The veto, on the input the brain just filled. Returns the strike-held flag
 * it is allowed to keep. See the note above.
 */
function vetoOwnGoal(me, ball, out, held) {
  const c = cfg();
  botState.veto = false;
  if (c.ownGoalVeto === false) return held;
  const bx = ball.x - me.pos.x;
  const by = ball.y - me.pos.y;
  const bl = Math.hypot(bx, by);
  if (!(bl > 1e-6) || bl > (c.vetoRange ?? 14)) return held;
  const dx = bx / bl;
  const dy = by / bl;
  const onward = dx * OWN_SIDE;
  // 1. The shot: the line a strike would send it on.
  let bad = intoOwnGoal(ball, dx, dy);
  // 2. The deflection: where the ball is already going, if it is going
  //    anywhere — a direction read off a ball at rest means nothing.
  if (!bad) {
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > (c.vetoBallSpeed ?? 4) && intoOwnGoal(ball, ball.vx / sp, ball.vy / sp)) bad = true;
  }
  // 3. The dribble: touching it at all from the side that pushes it home. No
  //    ray — see the note. This is the clause that was scoring.
  if (!bad && bl <= contactReach(ball) + (c.vetoMargin ?? 2) && onward > (c.vetoOnward ?? 0.15)) bad = true;
  if (!bad) return held;
  botState.veto = true;
  botState.vetoes++;
  botState.intent = 'clear';
  // The wind-up is dropped rather than let go — see the note. heldPrev goes
  // with it so updateBot reads no release edge off this frame.
  botState.holdT = 0;
  botState.heldPrev = false;
  botState.cooldown = Math.max(botState.cooldown, c.vetoCooldown ?? 0.25);
  // Across the line, the way it was already leaning. A dash already in flight
  // is steered by the same stick (updatePlayer's dashSteer), so this is also
  // what breaks a bad one that is already running.
  const lean = out.move.x * -dy + out.move.y * dx;
  const s = lean >= 0 ? 1 : -1;
  out.move.set(-dy * s, dx * s);
  botState.around = false;
  botState.aroundSide = 0;
  return false;
}

// --- the script -------------------------------------------------------------

function scriptStep(dt, me, ball, opp, out) {
  const c = cfg();
  const reaction = c.reaction ?? 0.12;
  const goalOppX = bounds.left;            // player 2 attacks the LEFT goal
  const goalY = midWater();

  botState.decideT -= dt;
  if (botState.decideT <= 0) {
    botState.decideT = reaction;
    decide(me, ball, opp, goalOppX, goalY);
  }

  // Swim at the target; ease off inside a body length so it does not orbit.
  const tx = botState.target.x + botState.jx;
  const ty = botState.target.y + botState.jy;
  const dx = tx - me.pos.x;
  const dy = ty - me.pos.y;
  const dist = Math.hypot(dx, dy);
  const gain = Math.min(1, dist / (c.slowWithin ?? 3));
  const bx = ball.x - me.pos.x;
  const by = ball.y - me.pos.y;
  const bl = Math.hypot(bx, by) || 1;
  // A DASH IN FLIGHT IS STEERED — player 2 runs player 1's dash now
  // (updatePlayer's dashSteer: the heading chases the stick and the aim
  // every frame, and a stick shoved against the line breaks the dash). So
  // for as long as the dash lasts the stick stays ON THE BALL, the way a
  // player's does: a bot that went back to steering for its standoff spot
  // the frame after the release would bend every strike away from the thing
  // it was thrown at, or cancel it outright.
  if (me.active) {
    out.move.set(bx / bl, by / bl);
    out.aim.set(bx / bl, by / bl);
    botState.holdT = 0;
    botState.around = false;
    return false;
  }
  if (dist > 0.2) {
    let ux = dx / dist;
    let uy = dy / dist;
    // AROUND THE BALL, NOT THROUGH IT. A seal out-swimming a slow ball holds
    // its ground and pushes it (versus.js, the contest), so a bot swimming
    // at a spot on the far side of the ball would dribble the ball ahead of
    // it the whole way — and "behind the ball" is goalward of it, which is
    // its own net. When the ball sits on the line to the target inside the
    // seal's reach of it, pass it on the side it is not, unless the shot is
    // on and going through it is the point.
    if (botState.intent !== 'strike') {
      const along = bx * ux + by * uy;
      const across = bx * uy - by * ux; // > 0: the ball lies to the right of the line
      const clear = (ball.r ?? 2.8) + (CONFIG.versus?.ball?.contactRadius ?? 2.2) + 0.5;
      // Ahead of me by more than half a reach (beside it, the way past is
      // straight on) and by less than a few — a ball far down the line is
      // not in the way yet, and a bot that sidestepped it from fifty units
      // out would crab across the pitch for as long as the line held —
      // clearly short of the target, and on the line. The side is chosen
      // ONCE and kept until the ball is off the line: a ball dead ahead
      // would otherwise flip the side every frame, and the chatter's
      // forward component is a seal nudging the ball along.
      if (along > clear * 0.5 && along < clear * 2.5 && along < dist - 2 && Math.abs(across) < clear) {
        if (!botState.aroundSide) botState.aroundSide = across >= 0 ? -1 : 1; // pass on the left when the ball is right, and vice versa
        const s = botState.aroundSide;
        const px = -uy * s;
        const py = ux * s;
        const sx = ux * 0.4 + px;
        const sy = uy * 0.4 + py;
        const sl = Math.hypot(sx, sy) || 1;
        ux = sx / sl; uy = sy / sl;
        botState.around = true;
      } else { botState.around = false; botState.aroundSide = 0; }
    }
    out.move.set(ux * gain, uy * gain);
  } else out.move.set(0, 0);
  // Aim at the ball, always — the strike goes where the stick points if it
  // is pushed, and the aim otherwise.
  out.aim.set(bx / bl, by / bl);

  // The strike: wind up while the shot is on, let go when it is banked.
  const shotOn = botState.intent === 'strike' && botState.cooldown <= 0 && me.charge > 0.02;
  if (shotOn || (botState.holdT > 0 && me.pending > 0)) {
    botState.holdT += dt;
    const ready = me.pending >= (c.releaseAt ?? 0.6) || botState.holdT >= (c.windUp ?? 0.55) || me.charge <= 0;
    if (ready && botState.holdT > 0.05) {
      botState.holdT = 0;
      botState.cooldown = c.cooldown ?? 0.5;
      // On the release frame the stick points at the ball, so the dash does.
      out.move.set(bx / bl, by / bl);
      return false;
    }
    return true;
  }
  botState.holdT = 0;
  return false;
}

function decide(me, ball, opp, goalOppX, goalY) {
  const c = cfg();
  const lead = c.lead ?? 0.35;
  const standoff = c.standoff ?? 4.5;
  const jitter = c.jitter ?? 1.2;
  botState.jx = (Math.random() * 2 - 1) * jitter;
  botState.jy = (Math.random() * 2 - 1) * jitter;

  // Hungry: the nearest chum, if there is any.
  if (me.charge < (c.chumBelow ?? 0.35)) {
    let best = null;
    let bestD = Infinity;
    for (const p of pickups) {
      const d = Math.hypot(p.mesh.position.x - me.pos.x, p.mesh.position.y - me.pos.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD < (c.chumReach ?? 40)) {
      botState.target.x = best.mesh.position.x;
      botState.target.y = best.mesh.position.y;
      botState.intent = 'eat';
      return;
    }
  }

  // Where the ball will be, and the line from the goal through it.
  const px = ball.x + ball.vx * lead;
  const py = ball.y + ball.vy * lead;
  let gx = px - goalOppX;
  let gy = py - goalY;
  const gl = Math.hypot(gx, gy) || 1;
  gx /= gl; gy /= gl;
  // Behind the ball: the far side of it from the goal it is attacking.
  const bx = px + gx * standoff;
  const by = py + gy * standoff;

  // Am I on the wrong side (between the ball and that goal)? Then swing
  // round it rather than pushing it into my own net.
  const mx = me.pos.x - px;
  const my = me.pos.y - py;
  const side = mx * gx + my * gy; // > 0 = behind it already
  if (side < 0 && Math.hypot(mx, my) < standoff * 1.5) {
    // Perpendicular to the goal line, whichever way is shorter.
    const s = (mx * -gy + my * gx) >= 0 ? 1 : -1;
    botState.target.x = px + (-gy * s) * standoff * 1.6;
    botState.target.y = py + (gx * s) * standoff * 1.6;
    botState.intent = 'guard';
    return;
  }
  botState.target.x = bx;
  botState.target.y = by;

  // Shot on? Close enough, and the line from me through the ball points at
  // the goal.
  const dBall = Math.hypot(ball.x - me.pos.x, ball.y - me.pos.y);
  const ax = ball.x - me.pos.x;
  const ay = ball.y - me.pos.y;
  const al = Math.hypot(ax, ay) || 1;
  const tgx = goalOppX - me.pos.x;
  const tgy = goalY - me.pos.y;
  const tl = Math.hypot(tgx, tgy) || 1;
  const align = (ax * tgx + ay * tgy) / (al * tl);
  if (dBall < (c.strikeRange ?? 7) && align > (c.strikeAlign ?? 0.75)) {
    botState.intent = 'strike';
  } else {
    botState.intent = 'chase';
  }
}

// --- the policy ---------------------------------------------------------------

function policyStep(dt, me, ball, opp, out) {
  const c = cfg();
  const pitch = { left: bounds.left, right: bounds.right, bottom: bounds.bottom, surface: bounds.surfaceY };
  features(
    { x: me.pos.x, y: me.pos.y, vx: me.vel.x, vy: me.vel.y },
    { x: opp.x, y: opp.y, vx: opp.vx, vy: opp.vy },
    ball,
    { charge: me.charge, pending: me.pending, dashing: me.active },
    true, // player 2 is mirrored: its goal is really on the right
    pitch, CONFIG.versus?.ball?.maxSpeed ?? 64, CONFIG.player?.maxSpeed ?? 34, _feat,
  );
  policyAction(policy, _feat, _act);
  // Back out of the mirror.
  out.move.set(-_act.moveX, _act.moveY);
  // A DIRECTION, NOT A MAGNITUDE. The player this learned from pushes the
  // stick all the way or not at all (every decile of his moving rows is
  // 1.00), and a network fitted by squared error to that answers a state it
  // is unsure of with the AVERAGE of the pushes it saw there — a half stick,
  // then a quarter, then a seal drifting to a stop with the ball upfield.
  // So the answer is read as the human's: past `policyStickAt` it is the
  // full push in that direction, under it it is standing still.
  const ml = out.move.length();
  if (ml >= (c.policyStickAt ?? 0.3)) out.move.divideScalar(ml);
  else out.move.set(0, 0);
  const ax = -_act.aimX;
  const ay = _act.aimY;
  const al = Math.hypot(ax, ay);
  if (al > 0.2) out.aim.set(ax / al, ay / al);
  botState.intent = _act.strike > 0.5 ? 'strike' : 'chase';
  // A held strike is a probability; hold while it stays over the line, and
  // never longer than a full wind-up, so a policy stuck at 0.6 still fires.
  const held = _act.strike > (c.policyStrikeAt ?? 0.5) && botState.holdT < (c.windUp ?? 0.55) * 1.5 && me.charge > 0.02;
  botState.holdT = held ? botState.holdT + dt : (botState.heldPrev ? 0 : Math.max(0, botState.holdT - dt));
  return held;
}
