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
// THE POLICY is used when CONFIG.versus.bot.mode asks for it and the JSON
// says it has been trained; otherwise the script plays, so the game never
// depends on a training run having happened. Its answer comes back in the
// mirrored frame every imitation row is written in (own goal on the left)
// and is flipped for player 2, who really defends the right.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { captainIsCpu } from './versusFlag.js';
import { bounds, midWater } from '../arena.js';
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
  const useModel = (c.mode === 'policy' || c.mode === 'auto') && policyUsable(policy);
  botState.mode = useModel ? 'policy' : 'scripted';
  botState.driving = true;
  botState.cooldown = Math.max(0, botState.cooldown - dt);
  let held;
  if (useModel) held = policyStep(dt, me, ball, opp, out);
  else held = scriptStep(dt, me, ball, opp, out);
  out.strikeHeld = held;
  out.strikeRelease = botState.heldPrev && !held;
  botState.heldPrev = held;
  out.connected = false;
  return out;
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
  if (out.move.lengthSq() > 1) out.move.normalize();
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
