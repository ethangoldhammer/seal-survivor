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
// is not a bot anyone wants to play. The noise comes mostly OFF as it closes
// on the ball, though (setJitter): a misjudgement of a body length is a
// personality at fifty units and a shanked shot at eight.
//
// IT SHOOTS AT THE OPEN PART OF THE MOUTH. "The goal" used to mean the middle
// of it, which is exactly where a keeper stands. openShot samples the mouth
// and takes the widest daylight, and shotAlign reads how straight the line has
// to be off the GEOMETRY — the mouth subtends an angle at the ball, and a shot
// may be off by that and no more — so a tap-in and a drive from thirty units
// are no longer allowed the same forty-degree cone.
//
// AND IT DEFENDS, which it did not. chooseDefence hands out three jobs off the
// same pitch view every bot reads: COVER the mouth (the last one back, on the
// line the ball would take to it — blocking the shot's path is the same thing
// as standing there), CHECK the seal that has the ball (line up beside it and
// throw the ordinary dash through it, at the man rather than at the ball), and
// BLOCK (anybody else, further out on the same line). Whoever is nearest the
// ball still just goes and plays it: chasing is defending when the chase spot
// is goal-side of the ball, which it always is.
//
// A TEAMMATE PLAYS FOR ITS CAPTAIN. With more than one seal a side the script
// has a second question before "is the shot on": is somebody on my side better
// placed than I am? choosePlay answers it from the pitch view versus.js hands
// in — a receiver up the pitch or in the box with a clear lane gets the ball
// PASSED to it (the bot lines up behind the ball on the line to the receiver
// instead of the line to the goal, and lets go early), a ball out wide and
// deep is CROSSED to a mate in front of the mouth, and when a mate already
// has the ball the bot makes a run into the box rather than crowding it. A
// person on the side is favoured as the receiver, so the computer sets the
// player up instead of finishing for them. See CONFIG.versus.bot.team.
//
// AND IT BREATHES. Air is the one clock in a match that is not about the ball:
// the bar drains underwater and empty is a burst, so a bot that never looked at
// it conceded on a timer. breathe() is the trip up, and it sits OVER both
// brains beside the own-goal veto rather than inside either — see the note
// there.
//
// THE POLICY is used when CONFIG.versus.bot.brain asks for it and the JSON
// says it has been trained; otherwise the script plays, so the game never
// depends on a training run having happened. The script is the default —
// measured, see the note on that field. Its answer comes back in the
// mirrored frame every imitation row is written in (own goal on the left)
// and is flipped for player 2, who really defends the right.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { captainIsCpu, oxygenLive } from './versusFlag.js';
import { seatIsCpu, teamOfSeat } from './sealRoster.js';
import { bounds, midWater, arenaHoles } from '../arena.js';
import { mouthY, mouthHalfHeight } from './versusGoal.js';
// The distance at which a seal actually touches the ball — the contact's own
// answer, not a second copy of it. See ballShape.js.
import { ballContactReach } from './ballShape.js';

import { pickups, bubbleOrbs } from '../entities/pickups.js';
import { features, policyAction, policyUsable } from './imitation.js';
import policyJson from '../versusPolicy.json';

const cfg = () => CONFIG.versus?.bot ?? {};

// WHICH MOUTH A SEAT DEFENDS, as a sign: -1 the left wall, +1 the right. It
// was the constant OWN_SIDE = 1, and that is true of exactly one seat — the
// bot was always player 2, and player 2 defends the right. A CPU TEAMMATE
// defends the LEFT, and every rule the bot has about its own goal is the
// wrong way round for it until this is asked rather than assumed.
const ownSideOf = (seat) => (teamOfSeat(seat) === 0 ? -1 : 1);

let policy = policyJson;
/** Swap the policy in (the harness trains one and hands it over). */
export function setBotPolicy(model) { policy = model; }
export function botPolicy() { return policy; }

// ONE MEMORY PER SEAT. The bot's state was a module singleton because there
// was one bot; with a CPU teammate and CPU opponents on the pitch a shared
// jitter, a shared decision clock and a shared strike hold would make every
// bot the same seal in three places. `botState` is still the LIVE one — the
// last bot to run — because that is what the readout and the harness have
// always read, and updateBot swaps each seat's memory through it.
const brains = new Map();

function brainFor(seat) {
  let b = brains.get(seat);
  if (!b) {
    b = { ...botState, target: { x: 0, y: 0 }, aimAt: { x: 0, y: 0 }, chargeAt: { x: 0, y: 0 }, jx: 0, jy: 0 };
    brains.set(seat, b);
  }
  return b;
}

/** A fresh match: nobody remembers the last one. */
export function resetBotBrains() {
  brains.clear();
}

export const botState = {
  driving: false,     // the bot filled player 2's input this frame
  mode: 'scripted',   // what decided it: 'scripted' | 'policy'
  target: { x: 0, y: 0 },
  intent: 'idle',     // 'chase' | 'guard' | 'eat' | 'breathe' | 'strike' — the read, for the readout
  decideT: 0,         // seconds until the next decision
  holdT: 0,           // seconds the strike has been held
  armT: 0,            // ...of which the SHOT has been on, which is what `windUp` caps
  cooldown: 0,        // seconds until it may strike again
  heldPrev: false,
  jx: 0, jy: 0,       // the current jitter offset
  around: false,      // steering round the ball this frame rather than at the target
  aroundSide: 0,      // ...and on which side, kept while it lasts
  roundSide: 0,       // which way it is swimming ROUND the ball to get behind it, kept until it is (see decide)
  veto: false,        // the own-goal veto took the frame off it (see vetoOwnGoal)
  vetoes: 0,          // how many times this session, for the harness
  play: 'shoot',      // what the strike is FOR: 'shoot' | 'pass' | 'cross' | 'support' (see choosePlay)
  passTo: -1,         // the seat it is playing to, for a pass or a cross
  aimAt: { x: 0, y: 0 }, // the point the strike is lined up on — the goal, or the receiver
  want: 0.6,          // how much of the meter it means to bank before letting go
  role: 'attack',     // what it is doing for its side: 'attack' | 'cover' | 'block' | 'check'
  commit: false,      // the shot (or the check) is on: wind up and throw it

  markSeat: -1,       // the seat it is defending against, for a body check
  chargeAt: { x: 0, y: 0 }, // the thing the dash is thrown AT — the ball, or the seal being checked
  lane: 0,            // world units of daylight in the shooting lane it picked

  breathing: false,   // the trip to the surface is on, and it owns the stick (see breathe)
  sipping: false,     // ...or the breath is a BUBBLE, and the seal never leaves the water
  air: 1,             // share of the tank left, for the readout and the harness
  airLeft: 0,         // ...as seconds, against `airClimb` below
  airClimb: 0,        // seconds the climb from here would take, at the cruise it really makes
};

/** One seat's memory, for the readout and the harness. */
export function botBrain(seat) {
  return brains.get(seat) ?? null;
}

/** Whether the bot should be driving: on, off, or only when no pad is on P2. */
export function botWanted(padConnected, seat = 1) {
  const on = cfg().enabled ?? 'auto';
  if (on === true) return true;
  if (on === false) return false;
  // A seat past the two captains is only ever a person's if the team select
  // put one there — see seatIsCpu. Nothing guesses a pad for it.
  if (seat > 1) return seatIsCpu(seat);
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
  botState.armT = 0;
  botState.cooldown = 0;
  botState.heldPrev = false;
  botState.intent = 'idle';
  botState.role = 'attack';
  botState.breathing = false;
  botState.sipping = false;
  botState.air = 1;
  botState.airLeft = 0;
  botState.airClimb = 0;
  botState.commit = false;
  botState.markSeat = -1;
  botState.lane = 0;
  botState.veto = false;
  botState.vetoes = 0;
  botState.roundSide = 0;
}

const _feat = new Float32Array(14);
const _act = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, strike: 0 };

/**
 * Fill `out` (player 2's input) for this frame. `me` is player 2's body
 * ({ pos, vel, charge, pending, active }), `ball` the ball, `opp` player 1's
 * position and velocity.
 */
export function updateBot(dt, me, ball, opp, out, seat = 1, pitch = null) {
  // This seat's memory in, and back out at the end — see brainFor. `target` is
  // copied by VALUE rather than by reference, or every bot would be steering
  // for the same point through one shared object.
  const mem = brainFor(seat);
  Object.assign(botState, mem);
  botState.target.x = mem.target.x;
  botState.target.y = mem.target.y;
  botState.aimAt.x = mem.aimAt.x;
  botState.aimAt.y = mem.aimAt.y;
  botState.chargeAt.x = mem.chargeAt.x;
  botState.chargeAt.y = mem.chargeAt.y;
  botState.seat = seat;
  // Everyone on the pitch this frame — see pitchView in versus.js. Null in a
  // harness that drives the bot alone, and then it plays the 1v1 it always did.
  _pitch = pitch;
  const c = cfg();
  const brain = c.brain ?? 'scripted';
  const useModel = (brain === 'policy' || brain === 'auto') && policyUsable(policy);
  botState.mode = useModel ? 'policy' : 'scripted';
  botState.driving = true;
  botState.cooldown = Math.max(0, botState.cooldown - dt);
  let held;
  if (useModel) held = policyStep(dt, me, ball, opp, out);
  else held = scriptStep(dt, me, ball, opp, out);
  // AIR, OVER WHICHEVER BRAIN IT WAS, and before the veto — which still gets
  // the last word on the action, because the one thing the bot may never do it
  // may not do on the way up either. See breathe.
  held = breathe(me, ball, out, held);
  // AFTER THE BRAIN, WHICHEVER BRAIN IT WAS. See vetoOwnGoal: the one thing
  // the bot may never do is not a thing either brain is trusted to avoid.
  held = vetoOwnGoal(me, ball, out, held);
  out.strikeHeld = held;
  out.strikeRelease = botState.heldPrev && !held;
  botState.heldPrev = held;
  out.connected = false;
  Object.assign(mem, botState);
  mem.target = { x: botState.target.x, y: botState.target.y };
  mem.aimAt = { x: botState.aimAt.x, y: botState.aimAt.y };
  mem.chargeAt = { x: botState.chargeAt.x, y: botState.chargeAt.y };
  return out;
}

let _pitch = null;

// --- the one thing it may never do -------------------------------------------
//
// THE OWN-GOAL VETO. A seat defends one mouth — the right for team 1, the left
// for team 0 (ownSideOf) — and nothing it does may send the ball into it.
// This is a rule about the ACTION, not about either way
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

/**
 * How close the bot has to be to be PUSHING the ball rather than near it —
 * the same two shapes sealContact uses, through versus.js's own answer, so a
 * bot never steers to a distance the contact does not agree is a touch.
 */
function contactReach(ballOf) {
  return ballContactReach(ballOf, 0);
}

/**
 * WOULD A DASH FROM `me` AT (atX, atY) SEND THE BALL HOME? Clauses 1 and 2 of
 * the veto, on an arbitrary line — ONE answer, read by the two places that must
 * agree on it: the veto itself, and chooseDefence, which will not wind up a
 * body check the veto is then going to drop. Two copies of this would be two
 * copies that drift, and the drift shows as a defender that holds the wind-up
 * for ever and never lets go.
 *
 * A dash that cannot reach the ball at all is safe by both clauses, which is
 * why the miss is answered here rather than asked separately.
 */
function dashSendsItHome(me, ball, own, atX, atY) {
  const c = cfg();
  const ax = atX - me.pos.x;
  const ay = atY - me.pos.y;
  const al = Math.hypot(ax, ay) || 1;
  const sx = ax / al;
  const sy = ay / al;
  const bx = ball.x - me.pos.x;
  const by = ball.y - me.pos.y;
  const along = Math.max(0, Math.min(al, bx * sx + by * sy));
  const off = Math.hypot(bx - sx * along, by - sy * along);
  if (off > contactReach(ball) + (c.vetoMargin ?? 2)) return false;
  // 1. The shot: the line this dash would send it on.
  if (intoOwnGoal(ball, sx, sy, own)) return true;
  // 2. The deflection — ADDS to a ball already on its way in. See the note in
  //    vetoOwnGoal: a dash thrown INTO one turns it round, which is a block.
  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp <= (c.vetoBallSpeed ?? 4)) return false;
  return (sx * ball.vx + sy * ball.vy) / sp > (c.vetoAlong ?? 0.35)
    && intoOwnGoal(ball, ball.vx / sp, ball.vy / sp, own);
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
  const own = ownSideOf(botState.seat ?? 1);
  const onward = dx * own;
  // A BODY CHECK IS NOT A SHOT. A checker's dash goes at a SEAL (chooseDefence,
  // and scriptStep's chargeAt), and the first two clauses are both about what a
  // strike does to the BALL — so for a check they bind only if this dash could
  // actually reach it, and the line they test is the DASH'S, not the line to
  // the ball. Without this the deflection clause vetoes every body check made
  // near a ball rolling at one's own mouth, which is the exact moment a
  // defender is most entitled to go through the seal that put it there.
  const checking = botState.role === 'check';
  // 1 and 2, on the line this dash would really take: the line to the ball
  // everywhere but a body check, which is thrown at a SEAL (chooseDefence, and
  // scriptStep's chargeAt) and may be nowhere near the ball's line.
  let bad = checking
    ? dashSendsItHome(me, ball, own, botState.chargeAt.x, botState.chargeAt.y)
    : dashSendsItHome(me, ball, own, ball.x, ball.y);
  // 3. The dribble: touching it at all from the side that pushes it home. No
  //    ray — see the note. This is the clause that was scoring.
  //
  //    EXCEPT A PASS OR A CROSS IN THE OTHER HALF. A crosser stands on the
  //    goal side of the ball on purpose — the receiver is behind it — and a
  //    ball played back off the far wall's corner has half a pitch to cross
  //    before it is anywhere near my own mouth; clauses 1 and 2 still stop
  //    the ones that would get there. In my own half the clause binds as it
  //    always did: nothing is passed goalward from there.
  //
  //    AND IT IS THE STICK THAT DRIBBLES. The offence is a seal SWIMMING into
  //    the ball from the goalward side — the measured case had the bot pressing
  //    at it, stick on the ball and the ball's vx climbing. Standing goalward of
  //    it while pushing somewhere else is not that, and reading position alone
  //    made this clause fire on every body check: a checker cannot reach an
  //    attacker without coming inside a reach of the ball it is shielding, and
  //    a defender that may never come near the ball is not a defender.
  const playing = (botState.play === 'pass' || botState.play === 'cross') && ball.x * own < 0;
  const pressing = out.move.x * own > (c.vetoOnward ?? 0.15);
  if (!bad && !playing && pressing && bl <= contactReach(ball) + (c.vetoMargin ?? 2) && onward > (c.vetoOnward ?? 0.15)) bad = true;
  if (!bad) return held;
  botState.veto = true;
  botState.vetoes++;
  botState.intent = 'clear';
  // The wind-up is dropped rather than let go — see the note. heldPrev goes
  // with it so updateBot reads no release edge off this frame.
  botState.holdT = 0;
  botState.armT = 0;
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

// --- the one thing it must always do -----------------------------------------
//
// COMING UP FOR AIR. A seal in a match breathes on the run's own terms — the
// bar drains at CONFIG.oxygen.depleteRate underwater, refills above the
// waterline, and empty is a burst (versusOutOfAir) — and the bot had no idea it
// was holding its breath. It surfaced only by accident, chasing a ball that had
// flown, and the accidents were enough to keep it alive most of the time and
// not all of it: twice in three minutes of measured play it emptied the tank
// and burst, and was gone from the pitch for a second and a half each time.
// That is the control run at the bottom of tools/versus-bot-test.mjs, which is
// this rule switched off. A side that leaves the water on a timer is not an
// opponent.
//
// IT SITS BESIDE THE VETO AND NOT INSIDE EITHER BRAIN, for the same reason: a
// rule that lives in one brain is not a rule. The policy has no notion of air
// at all — there is no oxygen feature in an imitation row — so a trained seal
// would drown for ever and the training set would teach it to, since the
// script's trips are not labelled as anything a network could learn the
// trigger for.
//
// WHEN TO LEAVE IS A DISTANCE, NOT A NUMBER OF SECONDS. The same quarter-bar
// is a comfortable margin two body lengths under the waves and already too
// late on the seabed, so the test is the trip: seconds of air left against
// seconds the climb would take, plus `margin`. And the climb is measured
// against the speed the seal REALLY makes good (cruiseSpeed), which is not its
// speed ceiling — see the note there.
//
// WHAT IT DOES WITH THE STICK is push it straight up and keep it there — the
// stick itself, not a target handed to the script's steering, which would ease
// off as it arrived. Above the waterline the animal is ballistic (thrust 19
// against gravity 51.6 — it cannot hover, it hangs), and what buys the hang is
// the stick still being pushed on the way up and at the top. The wind-up is
// DROPPED rather than let go, exactly as the veto drops it — a release is what
// fires the dash, and a dash thrown at a ball the seal is swimming away from
// is a wasted meter — and `heldPrev` goes with it so no release edge is read
// off the frame the trip starts.
//
// AND IT LATCHES. Without the second threshold the test would flicker on the
// boundary — a seal that rises a body length is a seal with enough air again,
// for one frame — so once the trip is on it stays on until it has banked
// enough to dive on. Which is also what makes the ARC work: a breach that
// reached the air and turned straight round would bank a tenth of a tank.
//
// ---------------------------------------------------------------------------
// AND THEN THE TRIP ATE THE MATCH. All of the above is a bot that does not
// drown, and measured over three minutes of four- and six-a-side it was also a
// bot that spent between a fifth and a THIRD of every match with the stick
// pinned at (0, 1), thirty units from the ball. Two numbers make that
// inevitable and neither is the bot's: a tank is 132 points and the surface
// pays 52.5 a second, but a seal cannot HOVER up there — thrust 19 against
// gravity 51.6 — so one breach buys about half a second of air time and
// twenty-odd points. Refilling to nine tenths is therefore five or six
// breaches and ten to fifteen seconds, every twenty-five. The bot was not
// choosing air over the ball once; it was choosing it for a third of the
// match, over and over, and that is what it looks like from the couch.
//
// THREE THINGS COME BEFORE THE TRIP NOW, and the trip is what is left.
//
//   A BUBBLE IS A BREATH. A match keeps four to seven oxygen orbs in the water
//   (CONFIG.versus.bubbles) and one is worth 30 points — seven and a half
//   seconds — plus two pips of the meter, taken by swimming through it. Every
//   person who has played this game takes them; the bot was the only seal on
//   the pitch that did not know they existed. A bubble within reach is a
//   breath that costs a detour instead of a trip, and it is taken IN the water
//   where the game is. See sipBubble.
//
//   A SEAL ON THE BALL FINISHES THE PLAY. The trip used to open on a margin of
//   two and a half seconds whatever else was happening, so a bot lined up on
//   the ball with the shot on would turn round and swim away from it. The
//   margin collapses to `onBall` while it is actually on the ball and
//   committed — still a floor, so it cannot talk itself into drowning, but the
//   shot goes first.
//
//   AND IT COMES BACK AS SOON AS IT CAN PLAY. The latch used to hold until the
//   tank was `topUp` full, which is the five-breach trip above. It holds until
//   the tank buys `playFor` seconds now — one or two breaches — because the
//   question a bot has to answer is "can I go back and play", not "am I full".
//
// AND THE TRIP GOES TO WHOEVER IS NOT NEEDED. This is the one that fixes the
// complaint rather than trimming it. A trip budgeted purely against the air
// clock opens at the LAST possible moment, which is a guarantee that it opens
// in the middle of whatever the seal was doing — and a bot that only ever
// leaves late leaves while it is chasing, every time. A side has three or four
// seals in the water and one of them is contesting the ball; the other two are
// standing off, supporting, or swimming back. That is when a breath is free.
//
// So the trigger has two settings. The seal its side is NEAREST THE BALL waits
// until the last moment — it is the one playing, and the margin is all it gets.
// Everybody else goes at `spare`, seconds of air still in the tank, and fills
// up properly while it is up there (`playForSpare`). The whole side is then
// breathing in rotation, off the ball, and the seal that IS on the ball has a
// full tank and stays on it.
//
// FINALLY, THE CLIMB LEANS AT THE BALL. Straight up is the shortest way to the
// air and the longest way back into the match; the stick carries a share of
// itself sideways toward the ball while the seal is deep, and straightens as
// it nears the surface, where the arc is all that matters. The trip ends
// somewhere useful, and often the ball has come to it.
// ---------------------------------------------------------------------------

/**
 * THE SPEED THE SEAL REALLY SWIMS AT, which is not `maxSpeed`. The water's drag
 * is linear (`friction`, a per-frame multiplier at 60fps), so a swimming seal
 * settles where thrust and friction balance: about 15.8 u/s at the shipped
 * tuning, against a 34 u/s ceiling the clamp therefore never gets to enforce.
 * Derived from the same two stats the seal swims on, so a retune of either
 * moves the estimate with it — a hardcoded number here would be a bot whose
 * sense of how far away the surface is went stale the first time anybody
 * touched thrust.
 */
function cruiseSpeed(stats) {
  const thrust = stats?.thrust ?? CONFIG.player?.thrust ?? 19;
  const fr = stats?.friction ?? CONFIG.player?.friction ?? 0.98;
  const perSec = Math.max(1e-3, (1 - fr) * 60);
  return Math.max(1e-3, Math.min(stats?.maxSpeed ?? CONFIG.player?.maxSpeed ?? 34, thrust / perSec));
}

/**
 * The air clock for a body: seconds left, seconds the climb needs, and how full
 * the tank is. `null` when there is nothing to say — oxygen is off, the rule is
 * off, or this body carries no bar at all, which is every scenario the geometry
 * harness drives (a stub seal is a position and a meter). A body with no bar
 * has no trip to make, and reading one off `undefined` would be a bot that
 * breathes at NaN.
 */
function airClock(me) {
  // ...and null while Blubberball's lungs are stubbed (CONFIG.versus.oxygen),
  // which is what takes the surface trip AND the bubble detour off the bot in
  // one place: both hang off this clock, and a bot that cannot drown has no
  // reason to leave the match for either. It keeps taking bubbles it swims
  // through — that is eatBubbles' business, not this one.
  if (!oxygenLive()) return null;
  const a = cfg().air ?? {};
  if (a.enabled === false) return null;
  const o2 = me?.oxygen;
  if (typeof o2 !== 'number' || !(o2 >= 0)) return null;
  const max = Math.max(1, me.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
  const rate = Math.max(0.01, CONFIG.oxygen?.depleteRate ?? 4);
  const depth = Math.max(0, bounds.surfaceY - me.pos.y);
  const climb = depth / (cruiseSpeed(me.stats) * Math.max(0.05, a.climbFrac ?? 0.7));
  return { left: o2 / rate, climb, frac: Math.min(1, o2 / max) };
}

/**
 * IS THIS SEAL THE ONE ITS SIDE HAS ON THE BALL — nearest of everyone still in
 * the water on its team. True when there is nobody to compare it with, which is
 * a 1v1 and every harness that drives the bot alone: the only seal on a side is
 * always the one on the ball, and the rule below then reads exactly as it did
 * before there were sides.
 */
function nearestOnSide(me, ball) {
  if (!_pitch) return true;
  const seat = botState.seat ?? 1;
  const myTeam = teamOfSeat(seat);
  const mine = Math.hypot(ball.x - me.pos.x, ball.y - me.pos.y);
  for (const v of _pitch) {
    if (v.dead || v.seat === seat || v.team !== myTeam) continue;
    if (Math.hypot(ball.x - v.x, ball.y - v.y) < mine) return false;
  }
  return true;
}

/**
 * THE NEAREST BUBBLE WORTH SWIMMING AT, or null. "Worth" is the air clock's
 * question and not a distance on its own: the detour has to be affordable out
 * of what is left in the tank, at the speed the seal really makes good, with
 * the same `margin` of slack the trip is budgeted with. A bubble twelve units
 * away is a breath; the same bubble with three seconds of air left is a seal
 * drowning on the way to it.
 *
 * It rises (CONFIG.oxygen.bubbleRiseSpeed), so where it will BE is where the
 * seal is aiming — the same lead every other target in this file carries.
 */
function nearestBubble(me, clock, pressing, needed = true) {
  const a = cfg().air ?? {};
  if (a.bubbles === false) return null;
  const reach = a.bubbleReach ?? 34;
  const speed = cruiseSpeed(me.stats) * Math.max(0.05, a.climbFrac ?? 0.7);
  // HOW FAR OFF ITS OWN LINE IT WILL GO FOR ONE. A bubble is only cheap while
  // it is ON THE WAY: `detour` is the extra swim it will accept, measured
  // against the spot the brain just decided on rather than against the seal —
  // a bubble ten units away and straight behind it costs twenty. Once the trip
  // is due anyway the allowance goes, because the thing it is being compared
  // with is a ten-second climb out of the match.
  const allow = pressing ? Infinity
    : (a.bubbleDetour ?? 26) * (needed ? (a.detourOnBall ?? 0.25) : 1);
  const tx = botState.target.x;
  const ty = botState.target.y;
  const direct = Math.hypot(tx - me.pos.x, ty - me.pos.y);
  let best = null;
  let bestD = 0;
  let bestCost = Infinity;
  for (const orb of bubbleOrbs) {
    const at = orb?.mesh?.position;
    if (!at) continue;
    const dx = at.x - me.pos.x;
    const dy = at.y - me.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > reach) continue;
    // Affordable: the swim there, plus the beat spent turning round, out of
    // what is left. Otherwise it is the surface or nothing.
    if (d / speed > clock.left - (a.margin ?? 2.5)) continue;
    const cost = d + Math.hypot(tx - at.x, ty - at.y) - direct;
    if (cost > allow || cost >= bestCost) continue;
    bestCost = cost;
    bestD = d;
    best = orb;
  }
  if (!best) return null;
  const rise = (CONFIG.oxygen?.bubbleRiseSpeed ?? 1.6) * (bestD / speed);
  _sip.x = best.mesh.position.x;
  _sip.y = Math.min(bounds.surfaceY - 1, best.mesh.position.y + rise);
  _sip.d = bestD;
  return _sip;
}
const _sip = { x: 0, y: 0, d: 0 };

/**
 * The trip, on the input whichever brain just filled. Returns the strike-held
 * flag it is allowed to keep — false for the whole climb. See the note above.
 */
function breathe(me, ball, out, held) {
  const a = cfg().air ?? {};
  const c = cfg();
  const clock = airClock(me);
  if (!clock) { botState.breathing = false; botState.sipping = false; botState.air = 1; return held; }
  botState.air = clock.frac;
  botState.airLeft = clock.left;
  botState.airClimb = clock.climb;

  // WHO IS NEEDED. The seal its side has nearest the ball is the one playing;
  // everybody else is standing off, and a breath taken now is a breath that
  // costs the side nothing. See the note above — this is what stops the whole
  // trip from always landing in the middle of a chase.
  const needed = nearestOnSide(me, ball);

  // ON THE BALL AND COMMITTED: the shot goes first. The margin collapses to a
  // floor rather than vanishing — this is allowed to make the trip late, never
  // to skip it — and only while the ball is genuinely at the seal's nose, which
  // is the same reach the contact itself answers with.
  const onBall = (botState.commit || botState.holdT > 0)
    && Math.hypot(ball.x - me.pos.x, ball.y - me.pos.y)
       <= contactReach(ball) + (c.strikeSlack ?? 1.5);
  const margin = onBall
    ? Math.min(a.margin ?? 2.5, a.onBall ?? 0.9)
    : (a.margin ?? 2.5);
  // The last moment for the seal on the ball; early, and off its own clock,
  // for everyone else.
  const trigger = needed ? clock.climb + margin : Math.max(clock.climb + margin, a.spare ?? 15);
  const fill = needed ? (a.playFor ?? 14) : (a.playForSpare ?? 26);

  // A BUBBLE IS A BREATH, and the only one that does not leave the water. It is
  // offered on exactly the threshold the trip LATCHES on — while the tank does
  // not buy a dive worth making, which is the same sentence in both places
  // rather than a second band with its own number. One bubble is 30 points and
  // clears it, so a seal takes one and goes back to the game; a band of its own
  // was a seal living inside it, sipping for a third of the match.
  const pressing = clock.left <= clock.climb + margin;
  const sip = clock.left < (a.playFor ?? 14) ? nearestBubble(me, clock, pressing, needed) : null;
  if (sip) {
    // Not a trip: the seal swims at it like any other target, and everything
    // else about the frame — the wind-up, the aim, the veto — is left alone.
    // It is on the way to the ball as often as not, and it pays the meter too.
    botState.sipping = true;
    botState.breathing = false;
    botState.intent = 'sip';
    botState.target.x = sip.x;
    botState.target.y = sip.y;
    const dx = sip.x - me.pos.x;
    const dy = sip.y - me.pos.y;
    const l = Math.hypot(dx, dy) || 1;
    out.move.set(dx / l, dy / l);
    return held;
  }
  botState.sipping = false;

  if (botState.breathing) {
    // Back to the match as soon as the tank buys a dive worth making. Not a
    // full tank: that is five breaches, and five breaches is a bot nobody is
    // playing against. See the note above. A seal that left EARLY fills up
    // further, because the time it is spending is time nobody wanted.
    if (clock.left >= fill || clock.frac >= 0.995) botState.breathing = false;
  } else if (clock.left <= trigger) {
    botState.breathing = true;
  }
  if (!botState.breathing) return held;

  botState.intent = 'breathe';
  botState.commit = false;
  // The point it is going to, for the readout and the harness. The stick below
  // does not read it — see the note.
  botState.target.x = me.pos.x;
  botState.target.y = bounds.surfaceY + (a.hang ?? 6);

  // STRAIGHT UP, with two things in the way of that — and both were found by
  // letting a match run rather than by reading the code.
  let ux = 0;
  let uy = 1;
  // 1. INSIDE A GOAL MOUTH THERE IS NO UP. The mouth is a tunnel cut mid-water
  //    and its lips hold a seal the way the walls do (the hole probe in
  //    arena.js, installed by systems/versusGoal.js), so a keeper that decides
  //    to breathe from inside its own net pushes the stick at a rock ceiling
  //    eleven units under the waves and drowns against it — measured, at a dead
  //    stop on the top lip for two and a half seconds with the stick pinned at
  //    (0, 1). The way out of a tunnel is ALONG it, so the trip leaves the
  //    mouth first, on the side the probe itself says the pitch is.
  const hole = arenaHoles.probe?.(me.pos.x, me.pos.y, me.stats?.hitRadius ?? 1);
  if (hole && hole.yMax < bounds.surfaceY) {
    const outward = hole.xMax === Infinity ? 1 : -1; // the left mouth opens right, and the right mouth left
    const l = Math.hypot(1, 0.5);
    ux = outward / l;
    uy = 0.5 / l;
  } else {
    // 2. THE BALL. A seal out-swimming a slow ball holds its ground and pushes
    //    it (the contest in versus.js), so climbing through the ball would
    //    carry it to the surface as well — the one way of taking a breath that
    //    also hands over possession. Past it on the side it is not, then.
    const bx = ball.x - me.pos.x;
    const by = ball.y - me.pos.y;
    const reach = contactReach(ball);
    if (by > 0 && by < reach * Math.max(0, a.clearBall ?? 2.5) && Math.abs(bx) < reach) {
      const side = bx >= 0 ? -1 : 1;
      const l = Math.hypot(0.6, 1);
      ux = side / l;
      uy = 0.6 / l;
    } else {
      // 3. AND OTHERWISE IT LEANS AT THE BALL. Straight up is the shortest way
      //    to the air and the longest way back into the match: the seal
      //    surfaces thirty units from the game and swims all the way back.
      //    The sideways share is spent while the seal is DEEP and straightens
      //    as it nears the surface — what buys the hang is the stick fully
      //    pushed at the top (see the note), and the lean must not cost that.
      const lean = Math.max(0, a.lean ?? 0.55);
      const deep = Math.min(1, Math.max(0, bounds.surfaceY - me.pos.y) / Math.max(1, a.leanDepth ?? 14));
      const want = (ball.x - me.pos.x);
      const s = Math.sign(want) * Math.min(1, Math.abs(want) / Math.max(1, reach * 2));
      const l = Math.hypot(lean * deep * s, 1);
      ux = (lean * deep * s) / l;
      uy = 1 / l;
    }
  }
  out.move.set(ux, uy);
  out.aim.set(ux, uy);
  // The wind-up is dropped rather than let go, and heldPrev with it — see the
  // note. A dash already in flight is steered by this same stick, so the climb
  // takes it over instead of waiting it out.
  botState.holdT = 0;
  botState.armT = 0;
  botState.heldPrev = false;
  botState.around = false;
  botState.aroundSide = 0;
  return false;
}

// --- the script -------------------------------------------------------------

function scriptStep(dt, me, ball, opp, out) {
  const c = cfg();
  const reaction = c.reaction ?? 0.12;
  // The mouth this seat is shooting at: the one it does NOT defend.
  const own = ownSideOf(botState.seat ?? 1);
  const goalOppX = own < 0 ? bounds.right : bounds.left;
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
  // WHAT THE DASH IS THROWN AT. The ball, every time but one: a BODY CHECK is
  // the same wind-up and the same dash aimed at a SEAL (see chooseDefence), so
  // from here down the aim, the steering of a dash in flight and the release
  // frame all read this point rather than the ball's. The ball is still the
  // ball everywhere it is the ball — the way round it below, and the veto.
  const checking = botState.role === 'check';
  const hx = (checking ? botState.chargeAt.x : ball.x) - me.pos.x;
  const hy = (checking ? botState.chargeAt.y : ball.y) - me.pos.y;
  const hl = Math.hypot(hx, hy) || 1;
  // A DASH IN FLIGHT IS STEERED — player 2 runs player 1's dash now
  // (updatePlayer's dashSteer: the heading chases the stick and the aim
  // every frame, and a stick shoved against the line breaks the dash). So
  // for as long as the dash lasts the stick stays ON THE BALL, the way a
  // player's does: a bot that went back to steering for its standoff spot
  // the frame after the release would bend every strike away from the thing
  // it was thrown at, or cancel it outright.
  if (me.active) {
    out.move.set(hx / hl, hy / hl);
    out.aim.set(hx / hl, hy / hl);
    botState.holdT = 0;
    botState.armT = 0;
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
    // NOT WHILE IT IS SWIMMING ROUND THE BALL. The target is already offset to
    // clear it (see `roundSide` in decide) and the path is already a curve; a
    // second sidestep on top of that is two answers to one question — and it
    // fired in exactly the band the final approach lives in, the ball four to
    // twenty units ahead, so it kicked the bot square across the ball at the
    // last moment every time. What is left for it is the roles that steer at a
    // spot with no opinion about the ball: the cover, the block, the run into
    // the box, and a chaser already behind the ball.
    if (!botState.commit && !botState.roundSide) {
      const along = bx * ux + by * uy;
      const across = bx * uy - by * ux; // > 0: the ball lies to the right of the line
      const clear = ballContactReach(ball, 0) + 0.5;
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
  // Aim at what the dash is for — the strike goes where the stick points if it
  // is pushed, and the aim otherwise.
  out.aim.set(hx / hl, hy / hl);

  // --- the strike -------------------------------------------------------------
  //
  // IT WINDS UP ON THE WAY IN NOW, which is the thing a person does and the bot
  // did not. The wind-up used to be gated on `commit` — the shot already being
  // on — so the sequence was: line up, THEN start charging, then wait half a
  // second for the bar to bank while the ball rolled out from under it. The
  // measurement: a bot inside strike range 7-12% of a match, letting go
  // between once and twice a MINUTE, sitting on eight tenths of a full bar the
  // whole time. It was not short of meter and it was not short of chances; it
  // was starting the wind-up at the one moment it had no time for one.
  //
  // So the hold starts while it is CLOSING — anywhere inside `windUpSlack` of
  // the thing the dash is for, whether that is the ball or the seal it is
  // checking — and the release still waits for the line. The bar is banked by
  // the time the shot comes on, so the frame the line comes good is the frame
  // it goes, instead of half a second later at whatever the line has become.
  //
  // TWO CLOCKS, because they answer different questions. `holdT` is how long
  // the stick has been down, and the release needs it non-zero. `armT` is how
  // long the SHOT has been on, and it is what `windUp` caps — a cap on the
  // total hold would fire the moment a bot that had been charging on the
  // approach committed, at whatever angle it happened to be on.
  //
  // AND A WIND-UP WITH NOTHING TO HIT IS DROPPED, not let go: out of range with
  // no shot on, the stick comes off and `heldPrev` with it, exactly as the veto
  // and the trip to the surface do. The banked power is kept for the next one.
  //
  // THE RELEASE SPENDS `pending`, NOT THE BAR, and that took a measurement to
  // see: `shotOn` used to ask for fuel still in the tank, which was always true
  // back when the hold began at the commit. Charging on the approach empties
  // the tank INTO the bank, so the same test went false exactly when the bot
  // was ready — it held a full wind-up it could no longer let go of, and the
  // release rate HALVED. A strike is the power it banked.
  //
  // AND IT STOPS HOLDING WITH NOTHING LEFT TO BANK. A held stick seals the
  // mouth (`chumSealed` in versus.js), so a bot that holds a full bank for ever
  // is a bot that never eats again. Full bank or empty tank drops the stick,
  // the power stays banked, and the shot below picks it straight back up.
  const windUpAt = (checking ? 0 : contactReach(ball)) + (c.windUpSlack ?? 14);
  const shotOn = botState.commit && botState.cooldown <= 0 && (me.charge > 0.02 || me.pending > 0);
  // NOT ON A PASS OR A CROSS, which are struck from a standstill (see the note
  // below): the wind-up for one of those belongs in the spot, not on the way to
  // it. Measured — a crosser winding up out of the corner arrives goalward of
  // the ball with a full bank and the dribble clause of the veto kicks it
  // across its own line, over and over, and the cross never comes.
  const setUp = botState.play === 'pass' || botState.play === 'cross';
  const closing = botState.cooldown <= 0 && hl < windUpAt && !(setUp && !checking)
    && botState.role !== 'cover' && botState.role !== 'block'
    && me.charge > 0.02 && me.pending < 1 - 1e-3;
  if (shotOn || closing) {
    botState.holdT += dt;
    botState.armT = shotOn ? botState.armT + dt : 0;
    // NOT YET. The line is not on, so there is nothing to let go at — bank it
    // and give the release the frame it comes good on.
    if (!shotOn) return true;
    // A PASS IS STRUCK FROM A STANDSTILL. The strike puts the seal's own
    // sideways speed into the ball as spin and squirt (strikeBall), so a bot
    // still swimming up to its spot as it lets go bends every pass off the
    // receiver. For a pass or a cross the stick comes off during the wind-up
    // and the release waits for the drift across the line to die down —
    // never longer than the wind-up itself, so a seal in a current still plays.
    const setting = !checking && (botState.play === 'pass' || botState.play === 'cross');
    let settled = true;
    if (setting) {
      out.move.set(0, 0);
      const across = Math.abs(me.vel.x * (by / bl) - me.vel.y * (bx / bl));
      settled = across <= (c.team?.settle ?? 3);
    }
    // A pass lets go with less banked than a shot — see choosePlay's `want`.
    const ready = ((me.pending >= (botState.want ?? c.releaseAt ?? 0.6) && settled) || botState.armT >= (c.windUp ?? 0.55) || me.charge <= 0);
    if (ready && botState.holdT > 0.05) {
      botState.holdT = 0;
      botState.armT = 0;
      botState.cooldown = checking ? (c.defend?.checkCooldown ?? 0.6) : (c.cooldown ?? 0.5);
      // On the release frame the stick points at what the dash is for, so the
      // dash does.
      out.move.set(hx / hl, hy / hl);
      return false;
    }
    return true;
  }
  // Nothing to hit: drop the wind-up rather than throw it away on a release.
  if (botState.holdT > 0) botState.heldPrev = false;
  botState.holdT = 0;
  botState.armT = 0;
  return false;
}

function decide(me, ball, opp, goalOppX, goalY) {
  const c = cfg();
  const lead = c.lead ?? 0.35;
  // Just inside the distance at which a touch lands — see CONFIG.versus.bot.standAt.
  const standoff = ballContactReach(ball, 0) * (c.standAt ?? 0.9);
  // THE MISJUDGEMENT, rolled ONCE per decision and scaled after the fact —
  // see setJitter. Re-rolling it when the scale changes would make the noise
  // a lottery the bot could re-enter, and two draws where the seeded harness
  // expects one.
  _jx = Math.random() * 2 - 1;
  _jy = Math.random() * 2 - 1;
  setJitter(1);
  botState.role = 'attack';
  botState.commit = false;
  botState.markSeat = -1;
  // Everyone else in the water, once, for every question below.
  const { mates, opps } = sides(me, opp);

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

  // DEFENDING COMES FIRST, because it is the answer to a question the
  // attacking half never asks: not "where do I put this" but "what is coming
  // at my mouth". See chooseDefence — it answers 'attack' whenever there is
  // nothing to defend, and then everything below runs as it always did.
  const own = ownSideOf(botState.seat ?? 1);
  const def = chooseDefence(me, ball, mates, opps, own);
  botState.role = def.role;
  botState.markSeat = def.mark;
  if (def.role !== 'attack') {
    botState.play = 'shoot';
    botState.passTo = -1;
    botState.target.x = def.x;
    botState.target.y = def.y;
    if (def.role === 'check') {
      // A body check is a strike at a seal: the same wind-up, the same dash,
      // thrown at the man rather than at the ball. chargeAt is what scriptStep
      // aims and steers at; the intent only goes to 'check' once it is close
      // enough and pointing the right way to throw it, exactly as a shot does.
      botState.chargeAt.x = def.hitX;
      botState.chargeAt.y = def.hitY;
      botState.want = c.defend?.checkWant ?? 0.55;
      const ml = Math.hypot(def.hitX - me.pos.x, def.hitY - me.pos.y) || 1;
      // Close enough to reach them, and on a line the veto will let go —
      // dashHitsBall is the SAME question vetoOwnGoal asks a few lines later,
      // so a check is never wound up only to be dropped.
      if (ml < (c.defend?.checkStrike ?? 13) && !dashSendsItHome(me, ball, own, def.hitX, def.hitY)) {
        botState.intent = 'check';
        botState.commit = true;
        setJitter(c.shot?.lineUpJitter ?? 0.3);
        return;
      }
    }
    // 'mark' is the way TO a body check and 'check' is the check itself —
    // two intents for one role on purpose, because scriptStep throws the dash
    // on the second one and a seal still swimming up must not be throwing it.
    botState.intent = def.role === 'check' ? 'mark' : def.role;
    return;
  }

  // WHAT THE STRIKE IS FOR. The goal, unless somebody on my side is better
  // placed — then the receiver, and everything below lines up on that point
  // instead. A support run is not a strike at all: go and stand there.
  const plan = choosePlay(me, ball, goalOppX, goalY, mates, opps);
  botState.play = plan.play;
  botState.passTo = plan.to;
  botState.aimAt.x = plan.x;
  botState.aimAt.y = plan.y;
  botState.want = plan.want;
  if (plan.play === 'support') {
    botState.target.x = plan.x;
    botState.target.y = plan.y;
    botState.intent = 'support';
    return;
  }
  const aimX = plan.x;
  const aimY = plan.y;

  // Where the ball will be, and the line from the aim point through it.
  const px = ball.x + ball.vx * lead;
  const py = ball.y + ball.vy * lead;
  let gx = px - aimX;
  let gy = py - aimY;
  const gl = Math.hypot(gx, gy) || 1;
  gx /= gl; gy /= gl;
  // Behind the ball: the far side of it from the aim point — and in the
  // water. A ball near the surface being played across the pitch puts that
  // spot in the air, and a seal cannot stand there.
  let bx = px + gx * standoff;
  let by = py + gy * standoff;

  // --- SWIMMING ROUND TO THE SIDE IT MEANS TO HIT FROM ----------------------
  //
  // The spot above is the right answer and the bot could not get to it.
  // Measured over four matches: it stood ON its own standoff spot for about
  // ONE PER CENT of the match, and its alignment at contact range — the cosine
  // between "where the ball is" and "where I want to send it" — averaged
  // somewhere between -0.17 and 0.33. Zero is the ball beside you. It was
  // arriving at the ball square on, over and over, from wherever it happened
  // to be.
  //
  // The reason is that the straight line to a spot BEHIND the ball goes
  // through the ball, and a seal out-swimming a slow ball holds its ground and
  // pushes it (the contest in versus.js). So it reached the ball first, shoved
  // it, the ball moved, the spot moved with it, and it shepherded the thing
  // sideways across the pitch without ever getting behind it. The old answer
  // was a sidestep inside a narrow band of ranges, which is a nudge and not a
  // way round.
  //
  // THE FIX IS A CARROT, not a waypoint. The target is pushed sideways off the
  // standoff spot by enough to clear the ball, and the push DIES as the seal
  // comes round — so the path is a curve that ends on the spot itself rather
  // than a detour to a second point it then has to leave. Far out it bends the
  // heading by a few degrees; at contact range it is most of the target, which
  // is exactly the shape a person swims.
  //
  // AND THE SIDE IS PICKED ONCE. Chosen fresh each decision it would flip
  // whenever the seal drifted across the line, which is the dithering in front
  // of the ball this is meant to stop — see `roundSide`. It is let go the
  // moment the seal is genuinely behind the ball, so the next approach is free
  // to choose again.
  const mx = me.pos.x - px;
  const my = me.pos.y - py;
  const r = Math.hypot(mx, my) || 1e-4;
  // How nearly the seal is already on the side it wants: 1 is dead behind the
  // ball on the line to the aim point, -1 is the wrong side entirely.
  const onSide = (mx * gx + my * gy) / r;
  const roundAt = c.roundAt ?? 0.75;
  if (onSide >= roundAt) botState.roundSide = 0;
  else if (!botState.roundSide) {
    // The short way round, and it is the cross product's sign — the same
    // "whichever way is nearer" the sidestep used, kept once it is chosen.
    botState.roundSide = (mx * -gy + my * gx) >= 0 ? 1 : -1;
  }
  if (botState.roundSide) {
    // 0 at `roundAt`, 1 on the far side. Squared so the bend comes on gently
    // while the seal is merely off the line and hard when it is in front of
    // the ball, which is the only place a straight line is actually blocked.
    const f = Math.min(1, (roundAt - onSide) / (roundAt + 1)) ** 2;
    const wide = (ballContactReach(ball, 0) + (c.roundClear ?? 2)) * (c.roundWide ?? 1.8);
    bx += -gy * botState.roundSide * wide * f;
    by += gx * botState.roundSide * wide * f;
  }
  botState.target.x = bx;
  botState.target.y = Math.max(bounds.bottom + 3, Math.min(bounds.surfaceY - 3, by));

  // Shot on? Close enough, and the line from me through the ball points at
  // the goal.
  const dBall = Math.hypot(ball.x - me.pos.x, ball.y - me.pos.y);
  const ax = ball.x - me.pos.x;
  const ay = ball.y - me.pos.y;
  const al = Math.hypot(ax, ay) || 1;
  const tgx = aimX - me.pos.x;
  const tgy = aimY - me.pos.y;
  const tl = Math.hypot(tgx, tgy) || 1;
  const align = (ax * tgx + ay * tgy) / (al * tl);
  // Inside the reach plus its slack — see CONFIG.versus.bot.strikeSlack.
  const strikeAt = ballContactReach(ball, Math.atan2(-ay, -ax)) + (c.strikeSlack ?? 1.5);
  // THE JITTER COMES OFF THE AIM, not off the bot. A misjudgement of a body
  // length is a personality at fifty units and a shanked shot at eight. It
  // comes off while the bot is CLOSING, not once it has decided to strike:
  // the spot it lines up on is the jittered one and the alignment below is
  // measured from where the seal really is, so noise left on during the
  // approach is noise that keeps the shot from ever being on.
  if (dBall < strikeAt * 2) setJitter(c.shot?.lineUpJitter ?? 0.3);
  if (dBall < strikeAt && align > plan.align) {
    botState.intent = 'strike';
    botState.commit = true;
  } else {
    botState.intent = 'chase';
  }
}

// The decision's roll, before it is scaled. See setJitter.
let _jx = 0;
let _jy = 0;

/** The decision's misjudgement, at `scale` of CONFIG.versus.bot.jitter. */
function setJitter(scale) {
  const j = (cfg().jitter ?? 1.2) * scale;
  botState.jx = _jx * j;
  botState.jy = _jy * j;
}

// --- who else is in the water -------------------------------------------------
//
// EVERY QUESTION BELOW IS ABOUT SOMEBODY ELSE — is the lane clear, who has the
// ball, am I the last one back. `_pitch` is versus.js's per-frame roster
// (pitchView) and it is the answer whenever there is one.
//
// A HARNESS THAT DRIVES THE BOT ALONE passes no pitch, and the single `opp` it
// does pass is then the whole opposition: one entry rather than none, because
// every loop below would otherwise run zero times and the bot would play as if
// the pitch were empty — which is not "the 1v1 it always did", it is a bot
// that cannot see the only other seal in the water.
const _mates = [];
const _opps = [];
const _lone = { seat: -1, team: 0, x: 0, y: 0, vx: 0, vy: 0, human: true, dead: false, charge: 0 };

function sides(me, opp) {
  _mates.length = 0;
  _opps.length = 0;
  const seat = botState.seat ?? 1;
  const myTeam = teamOfSeat(seat);
  if (_pitch) {
    for (const v of _pitch) {
      if (v.dead || v.seat === seat) continue;
      (v.team === myTeam ? _mates : _opps).push(v);
    }
  } else if (opp) {
    _lone.team = 1 - myTeam;
    _lone.x = opp.x; _lone.y = opp.y;
    _lone.vx = opp.vx ?? 0; _lone.vy = opp.vy ?? 0;
    _opps.push(_lone);
  }
  return { mates: _mates, opps: _opps };
}

// --- the open shot ------------------------------------------------------------
//
// WHERE IN THE MOUTH. The bot used to aim at the middle of it, which is where
// a keeper stands: a shot down the centre line of a defended goal is the one
// shot that is always blocked, and the bot took it over and over because the
// middle was the only point it could name.
//
// So the mouth is SAMPLED — a handful of points between the posts, each one
// asked the same question a player asks by eye: is there daylight between the
// ball and this bit of the net. A seal in the way is measured off the LANE,
// not off the goal, so a defender standing on the goal line blocks the part of
// the mouth behind it and nothing else; and each one is led by a fraction of a
// second of its own velocity, because the gap that matters is the gap when the
// ball gets there. The widest daylight wins, ties going to the middle.
//
// `clear` comes back in world units and is what "the shot is on" means: under
// `laneClear` there is a body in the way and the bot looks for a pass instead
// of firing into it.

const _shot = { x: 0, y: 0, clear: 0, open: false };

/** The most open point of the mouth at `goalX`, and how much daylight it has. */
function openShot(ball, goalX, goalY, opps) {
  const s = cfg().shot ?? {};
  // Inside the posts by the ball's own width — a shot aimed AT a post is a
  // shot off the post — and by a hair more than that.
  const half = Math.max(0, mouthHalfHeight() - (ball.r ?? 2.8) - (s.postMargin ?? 0.5));
  const n = Math.max(1, Math.round(s.samples ?? 7));
  const lead = s.blockLead ?? 0.25;
  const body = s.blockRadius ?? 3.5;
  const cap = s.clearCap ?? 12;
  const bias = s.centreBias ?? 0.4;
  let bestY = goalY;
  let bestClear = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    const y = goalY + f * half;
    const dx = goalX - ball.x;
    const dy = y - ball.y;
    const d = Math.hypot(dx, dy) || 1;
    let clear = cap;
    for (const o of opps) {
      const ox = o.x + o.vx * lead - ball.x;
      const oy = o.y + o.vy * lead - ball.y;
      const along = (ox * dx + oy * dy) / d;
      // Behind the ball or behind the goal line: not in this lane.
      if (along <= 0 || along >= d) continue;
      const off = Math.abs(ox * dy - oy * dx) / d - body;
      clear = Math.min(clear, Math.max(0, off));
    }
    const score = clear - Math.abs(f) * bias;
    if (score > bestScore) { bestScore = score; bestY = y; bestClear = clear; }
  }
  _shot.x = goalX;
  _shot.y = bestY;
  _shot.clear = bestClear;
  _shot.open = bestClear >= (s.laneClear ?? 2);
  return _shot;
}

/**
 * HOW STRAIGHT A SHOT HAS TO BE LINED UP, from the geometry rather than from a
 * constant. `strikeAlign` is one number for every shot on the pitch, and the
 * angle it allows — some forty degrees — is a tap-in from two body lengths out
 * and a shot into the rock from thirty. The mouth subtends an angle at the
 * ball; a shot may be off by that and no more, so the requirement TIGHTENS
 * with the range and never loosens below the old constant.
 */
function shotAlign(ball, aim) {
  const c = cfg();
  const s = c.shot ?? {};
  const floor = c.strikeAlign ?? 0.75;
  const half = Math.max(0.5, mouthHalfHeight() - (ball.r ?? 2.8));
  const d = Math.hypot(aim.x - ball.x, aim.y - ball.y);
  if (!(d > 1)) return floor;
  const need = Math.cos(Math.atan2(half, d));
  // Capped, because a bot that asks itself for an alignment its own jitter
  // cannot deliver never shoots at all.
  return Math.min(s.alignCap ?? 0.985, Math.max(floor, need));
}

// --- the defending side -------------------------------------------------------
//
// The script was an attacking game with one defensive reflex in it (the
// own-goal veto, which is a rule about an action and not a plan). A bot whose
// only idea is "get behind the ball and hit it at their goal" does not defend:
// it chases the ball wherever it is, and a side that all chases the ball is a
// side with an open mouth behind it.
//
// THREE JOBS, and the pitch decides who has which — every bot answering for
// itself off the same roster, with distance to its own mouth and then the seat
// number breaking every tie, so two seals never both decide they are the last
// one back and never both leave.
//
//   COVER   the last one back. It stands on the line from the ball to its own
//           mouth, a short way out from the wall — which is the same thing as
//           standing in front of whatever the ball is about to do, and is why
//           blocking the shot's path is not a separate job. A ball already
//           travelling at the mouth (intoOwnGoal, the same test the veto uses)
//           pulls it onto the ball's own line instead of the one it would
//           take from where it sits.
//   CHECK   the one nearest the seal that has the ball, of those not covering.
//           It lines up GOAL-SIDE of its man and throws the dash through it —
//           the ordinary strike, the ordinary wind-up, thrown at a seal
//           instead of at the ball (see scriptStep's chargeAt). Goal-side on
//           purpose: the shove then goes up the pitch, and a checker standing
//           between its man and the mouth is a checker that is also blocking.
//   BLOCK   anybody else back. Further out on the same ball→mouth line, so the
//           lane is cut early rather than at the line.
//
// NOTHING TO DEFEND is the common answer, and then this returns 'attack' and
// the rest of the script runs exactly as it did. A loose ball in my own half
// with nobody on it is not a threat — it is a ball to go and win, which the
// attacking half already does better than a defensive shape would.

const _def = { role: 'attack', x: 0, y: 0, mark: -1, hitX: 0, hitY: 0 };
// The side, in the order it is picked in — reused, because this runs several
// times a second per bot and has no business allocating.
const _line = [];
const _self = { seat: 0, x: 0, y: 0, vx: 0, vy: 0 };

function chooseDefence(me, ball, mates, opps, own) {
  const c = cfg();
  const d = c.defend ?? {};
  const seat = botState.seat ?? 1;
  _def.role = 'attack';
  _def.mark = -1;
  if (d.enabled === false) return _def;
  const ownX = own < 0 ? bounds.left : bounds.right;
  const gy = mouthY();
  const lead = d.lead ?? 0.3;

  // IS THERE ANYTHING TO DEFEND.
  const sp = Math.hypot(ball.vx, ball.vy);
  const inbound = sp > (d.inboundSpeed ?? 6) && intoOwnGoal(ball, ball.vx / sp, ball.vy / sp, own);
  const myHalf = (ball.x - (d.halfLine ?? 0)) * own > 0;
  let carrier = null;
  let carrierD = Infinity;
  for (const o of opps) {
    const dd = Math.hypot(ball.x - o.x, ball.y - o.y);
    if (dd < carrierD) { carrierD = dd; carrier = o; }
  }
  // ...AND ONLY IF IT IS NOT MINE TO PLAY. Whoever is nearest the ball goes and
  // plays it, and if that is me then chasing IS my defending: the spot the
  // attacking half sends a chaser to is the far side of the ball FROM the goal
  // it attacks, which is the goal-side of it here — a seal on its way to that
  // spot is already between the ball and its own mouth. Positioning instead
  // would be turning down a clearance to go and stand somewhere.
  const myD = Math.hypot(ball.x - me.pos.x, ball.y - me.pos.y);
  if (!(carrierD < myD)) return _def;
  const held = !!carrier && carrierD < (d.carryWithin ?? 14);
  // THE SHAPE IS A HOME-HALF THING; THE BODY CHECK IS NOT. Cover and block are
  // answers to "what is coming at my mouth", so they belong to a ball in my own
  // half or one already on its way in. A CHECK is not that — it is a dash
  // thrown at the seal carrying the ball, and a seal carrying the ball is worth
  // hitting wherever it is standing. Gating it on the shape meant the other
  // side could walk the ball the length of its OWN half unopposed, and the
  // measurement bears it out: the intent fired on 0-2% of frames.
  const shape = inbound || myHalf;
  if (!shape && !(held && d.checkAnywhere !== false)) return _def;

  // WHO DOES WHAT. My side, nearest to my own mouth first.
  _self.seat = seat;
  _self.x = me.pos.x; _self.y = me.pos.y;
  _self.vx = me.vel.x; _self.vy = me.vel.y;
  _line.length = 0;
  _line.push(_self);
  for (const m of mates) _line.push(m);
  const toGoal = (v) => Math.hypot(ownX - v.x, gy - v.y);
  _line.sort((a, b) => (toGoal(a) - toGoal(b)) || (a.seat - b.seat));

  // The last one back covers. Alone, it only stays home for a ball already on
  // its way in: a lone defender that sits on its line while the other seal
  // walks the ball up to it has defended nothing.
  const keeper = _line[0];
  if (shape && keeper.seat === seat && (_line.length > 1 || !held)) {
    coverPoint(ball, own, inbound, lead, d.coverDepth ?? 10, d.coverBand ?? 4);
    _def.role = 'cover';
    return _def;
  }

  // The nearest of the rest to the seal on the ball goes through it.
  if (held) {
    const cd = Math.hypot(carrier.x - me.pos.x, carrier.y - me.pos.y);
    let mine = true;
    for (const v of _line) {
      if (v.seat === seat || v === keeper) continue;
      const vd = Math.hypot(carrier.x - v.x, carrier.y - v.y);
      if (vd < cd || (vd === cd && v.seat < seat)) mine = false;
    }
    if (mine) {
      const cx = carrier.x + carrier.vx * lead;
      const cy = carrier.y + carrier.vy * lead;
      _def.role = 'check';
      _def.mark = carrier.seat;
      _def.hitX = cx;
      _def.hitY = cy;
      // BESIDE THE MAN, NOT BEHIND THE BALL. The obvious line — straight at
      // them — is the one line the ball is usually on: an attacker running at
      // my mouth keeps the ball in front of it, which is between us. A dash
      // down that line drives the ball the way the attacker was already
      // taking it, and the veto drops it, so the checker winds up for ever
      // and never lets go. So the approach is PERPENDICULAR to the man's own
      // line to the ball, on the side I am already nearer: the shove comes in
      // square, knocks them off their line, and leaves the ball alone.
      let lx = ball.x - cx;
      let ly = ball.y - cy;
      let ll = Math.hypot(lx, ly);
      if (!(ll > 1e-3)) { lx = carrier.vx; ly = carrier.vy; ll = Math.hypot(lx, ly) || 1; }
      lx /= ll; ly /= ll;
      const side = ((me.pos.x - cx) * -ly + (me.pos.y - cy) * lx) >= 0 ? 1 : -1;
      const stand = d.checkStand ?? 6;
      _def.x = cx + (-ly * side) * stand;
      _def.y = cy + (lx * side) * stand;
      _def.y = Math.max(bounds.bottom + 3, Math.min(bounds.surfaceY - 3, _def.y));
      return _def;
    }
  }

  // Up the pitch there is no shape to hold — only the seal on the ball, and
  // somebody else is already going through it. Everybody else attacks.
  if (!shape) return _def;
  // Everybody else back: the same line, further out.
  coverPoint(ball, own, inbound, lead, 0, d.coverBand ?? 4, d.blockAt ?? 0.45);
  _def.role = 'block';
  return _def;
}

/**
 * A POINT ON THE LINE THE BALL WOULD TAKE TO MY MOUTH — `depth` world units out
 * from the wall, or `frac` of the way along it when depth is 0. When the ball
 * is already on its way in the line is the BALL'S OWN, not the one from where
 * it sits: a ball crossing the box has a heading, and standing on the line to
 * where it currently is means standing behind it.
 */
function coverPoint(ball, own, inbound, lead, depth, band, frac = 1) {
  const ownX = own < 0 ? bounds.left : bounds.right;
  const gy = mouthY();
  const bx = ball.x + ball.vx * lead;
  const by = ball.y + ball.vy * lead;
  // Where the line meets my wall: the mouth's centre, or where the ball is
  // actually headed.
  let atX = ownX;
  let atY = gy;
  if (inbound) {
    const t = (ownX - ball.x) / (ball.vx || 1e-6);
    if (t > 0) atY = ball.y + ball.vy * t;
  }
  let dx = bx - atX;
  let dy = by - atY;
  const dist = Math.hypot(dx, dy) || 1;
  // How far out from the wall to stand: the depth asked for, but never on the
  // far side of the ball — a cover spot beyond the thing it is covering is a
  // defender the ball goes round.
  let f = depth > 0 ? Math.min(1, depth / dist) : frac;
  f = Math.max(0, Math.min(f, Math.max(0, (dist - 2) / dist)));
  _def.x = atX + dx * f;
  _def.y = atY + dy * f;
  const half = mouthHalfHeight() + band;
  _def.y = Math.max(gy - half, Math.min(gy + half, _def.y));
  _def.y = Math.max(bounds.bottom + 3, Math.min(bounds.surfaceY - 3, _def.y));
  return _def;
}

// --- the team ---------------------------------------------------------------
//
// WHO THE BALL IS FOR. A bot with nobody on its side shoots, as it always did.
// With a side, it asks, in this order:
//
//   A MATE HAS IT   the nearest of my side to the ball is not me and is on
//                   it: I make a run into the box, on the far side of the
//                   mouth from the mate, and stay off the ball. Two seals
//                   chasing one ball is the thing a side is FOR not doing.
//   MY SHOT         the ball is already in front of the mouth and close: I
//                   take it. Passing out of a scoring position is not setting
//                   anybody up.
//   A RECEIVER      a mate up the pitch of the ball (or in the box, however
//                   far) with a clear lane from the ball to it and nobody on
//                   its back: the strike is lined up on the mate, not the
//                   goal. A person on my side is favoured, so the computer
//                   plays the player in rather than finishing itself. Out
//                   wide and deep, to a mate in the box, that is a CROSS;
//                   otherwise a pass, let go with less of the meter so it
//                   arrives as something a seal can meet rather than a shot.
//   ELSE            the goal.
//
// Everything here is a decision about where the strike is AIMED; the veto
// still runs on the input after it, so a pass that would have gone in my own
// net is dropped like any other.

const _plan = { play: 'shoot', x: 0, y: 0, to: -1, align: 0.75, want: 0.6 };

/**
 * THE CLEARANCE, and it is the play the script did not have.
 *
 * Every plan in choosePlay ends in a strike AT A POINT — the open part of the
 * mouth, or a receiver — and each is judged by how straight the seal is lined
 * up on that point. A shot deserves that: shotAlign reads the angle the mouth
 * subtends at the ball, so from sixty units out the bot needs to be inside ten
 * degrees. Measured, that is a bot standing ON the ball for a tenth of every
 * match at a mean alignment of 0.39, letting go between once and twice a
 * MINUTE, because the only strike it knew how to want was a goal.
 *
 * A CLEARANCE IS NOT A SHOT. It is not trying to beat a keeper; it is trying
 * to be forty units further up the pitch, and the only thing it must not be is
 * an own goal — which vetoOwnGoal already guarantees on the action itself,
 * after every brain and every plan. So the aim point is not the mouth, it is
 * simply UP THE PITCH, and the alignment it asks of itself is the loose floor
 * rather than the shot's. That is the difference between a bot that strikes
 * when it can score and a bot that strikes when it has the ball.
 *
 * It leans toward mid-water on the way, because the arena's ceiling and its
 * sand are both walls and a ball driven into either stops.
 */
function drivePlan(ball, goalOppX, goalY) {
  const d = cfg().drive ?? {};
  if (d.enabled === false) return _plan; // ...the shot's own plan, as it was
  const fwd = goalOppX > ball.x ? 1 : -1;
  _plan.play = 'drive';
  _plan.to = -1;
  _plan.x = ball.x + fwd * Math.max(1, d.reach ?? 60);
  _plan.y = ball.y + (goalY - ball.y) * Math.max(0, Math.min(1, d.centre ?? 0.35));
  _plan.align = d.align ?? 0.45;
  _plan.want = d.want ?? 0.5;
  return _plan;
}

function choosePlay(me, ball, goalOppX, goalY, mates, opps) {
  const c = cfg();
  const t = c.team ?? {};
  const s = c.shot ?? {};
  // THE SHOT, BEFORE ANY OF THIS: which part of the mouth is open, and by how
  // much. Every plan that ends in a strike at goal is lined up on that point
  // rather than on the middle of the net, and `clear` is what the two clauses
  // below mean by "the shot is on".
  const open = openShot(ball, goalOppX, goalY, opps);
  botState.lane = open.clear;
  _plan.play = 'shoot';
  _plan.x = open.x;
  _plan.y = open.y;
  _plan.to = -1;
  _plan.align = shotAlign(ball, open);
  _plan.want = c.releaseAt ?? 0.6;
  // A LONE BOT HAS NO PASS, but it still has the two strikes: the shot when the
  // net is open and in range, and the clearance the rest of the time. It used
  // to line up for the shot from anywhere on the pitch and therefore never let
  // go — see drivePlan.
  const onGoal = open.open && Math.abs(goalOppX - ball.x) < (s.range ?? 70);
  if (t.enabled === false || !_pitch || !mates.length) {
    return onGoal ? _plan : drivePlan(ball, goalOppX, goalY);
  }
  const seat = botState.seat ?? 1;
  const fwd = goalOppX > ball.x ? 1 : -1; // toward the mouth I attack

  const boxDepth = t.boxDepth ?? 26;
  const boxHalf = t.boxHalf ?? 12;
  const inBox = (x, y) => Math.abs(goalOppX - x) < boxDepth && Math.abs(y - goalY) < boxHalf;

  // A MATE HAS IT.
  const myD = Math.hypot(ball.x - me.pos.x, ball.y - me.pos.y);
  let holder = null;
  let holderD = myD;
  for (const m of mates) {
    const d = Math.hypot(ball.x - m.x, ball.y - m.y);
    if (d < holderD) { holderD = d; holder = m; }
  }
  if (holder && holderD < (t.holderWithin ?? 12)) {
    const side = holder.y >= goalY ? -1 : 1;
    _plan.play = 'support';
    _plan.to = holder.seat;
    _plan.x = goalOppX - fwd * (t.supportDepth ?? 16);
    _plan.y = Math.max(bounds.bottom + 4, Math.min(bounds.surfaceY - 4, goalY + side * (t.supportLane ?? 8)));
    return _plan;
  }

  // MY SHOT — in front of the mouth and close, as it always was, and ALSO
  // wherever the net is simply open. A clear lane from range is a shot, and a
  // bot that passed out of one was passing up the thing the pass is for.
  const toGoal = Math.abs(goalOppX - ball.x);
  if (toGoal < (t.selfShot ?? 24) && Math.abs(ball.y - goalY) < boxHalf) return _plan;
  // OUT WIDE AND DEEP the ball goes ACROSS, not at the near post — decided
  // here rather than at the receiver search below, because it is a fact about
  // where the ball is and it has to be known before the open-lane clause: a
  // shot from the corner is very often technically open and almost always
  // worth less than a ball laid across the mouth.
  const wide = Math.abs(ball.y - goalY) > (t.crossWide ?? 10) && toGoal < (t.crossDeep ?? 34);
  if (onGoal && !wide) return _plan;

  // A RECEIVER.
  const lead = t.passLead ?? 0.45;
  const passMin = t.passMin ?? 10;
  const passMax = t.passMax ?? 70;
  const laneWidth = t.laneWidth ?? 5;
  const markDist = t.markDist ?? 7;
  let best = null;
  let bestScore = -Infinity;
  for (const m of mates) {
    const rx = m.x + m.vx * lead;
    const ry = m.y + m.vy * lead;
    const dx = rx - ball.x;
    const dy = ry - ball.y;
    const d = Math.hypot(dx, dy);
    if (d < passMin || d > passMax) continue;
    const gain = dx * fwd;
    const box = inBox(rx, ry);
    if (gain < (t.passForward ?? 6) && !box) continue;
    let blocked = false;
    let marked = false;
    for (const o of opps) {
      const ox = o.x - ball.x;
      const oy = o.y - ball.y;
      const along = (ox * dx + oy * dy) / d;
      if (along > 2 && along < d - 2 && Math.abs(ox * dy - oy * dx) / d < laneWidth) { blocked = true; break; }
      if (Math.hypot(o.x - rx, o.y - ry) < markDist) marked = true;
    }
    if (blocked) continue;
    const score = gain / passMax
      + (box ? (t.boxBonus ?? 0.6) : 0)
      + (m.human ? (t.favourHuman ?? 0.6) : 0)
      - (marked ? (t.markedPenalty ?? 0.5) : 0);
    if (score > bestScore) { bestScore = score; best = { m, rx, ry, d, box }; }
  }
  // NOBODY TO PLAY IT TO, and no shot on either: hit it up the pitch. This was
  // a fall-through to the shot's own plan, which is why a bot with the ball in
  // its own half and no lane simply stood over it.
  if (!best) return drivePlan(ball, goalOppX, goalY);
  _plan.play = wide && best.box ? 'cross' : 'pass';
  _plan.to = best.m.seat;
  _plan.x = best.rx;
  _plan.y = best.ry;
  _plan.align = t.passAlign ?? 0.9;
  // Firm enough to get there, and no firmer: the share of the meter grows
  // with the distance, from `passPower` at passMin up to what a SHOT lets go
  // at (releaseAt) by `passRange`, and never past it — a pass driven like a
  // shot is a shot at a teammate. A cross is always driven.
  const shot = c.releaseAt ?? 0.6;
  const pw = Math.min(shot, t.passPower ?? 0.3);
  const frac = Math.max(0, Math.min(1, (best.d - passMin) / Math.max(1, (t.passRange ?? 60) - passMin)));
  _plan.want = _plan.play === 'cross' ? shot : pw + (shot - pw) * frac;
  return _plan;
}

// --- the policy ---------------------------------------------------------------

function policyStep(dt, me, ball, opp, out) {
  const c = cfg();
  // THE POLICY HAS NO PLAN, only an output — no role, nothing it has committed
  // to, and above all no seal it is throwing a dash at. Said here rather than
  // left to the seat's memory, which is where the SCRIPT's last answer is
  // still sitting: a policy that inherited a stale 'check' would have the veto
  // reading its strikes against a line drawn for somebody else's body check.
  botState.role = 'attack';
  botState.commit = false;
  const pitch = { left: bounds.left, right: bounds.right, bottom: bounds.bottom, surface: bounds.surfaceY };
  features(
    { x: me.pos.x, y: me.pos.y, vx: me.vel.x, vy: me.vel.y },
    { x: opp.x, y: opp.y, vx: opp.vx, vy: opp.vy },
    ball,
    { charge: me.charge, pending: me.pending, dashing: me.active },
    // MIRRORED PER SEAT. Every imitation row was logged with the seal's own
    // goal on the LEFT, which is player 1's frame — so a seat that really
    // defends the right is mirrored into it and one that defends the left is
    // already in it. It was a hardcoded `true` because the only bot was
    // player 2.
    ownSideOf(botState.seat ?? 1) > 0,
    pitch, CONFIG.versus?.ball?.maxSpeed ?? 64, CONFIG.player?.maxSpeed ?? 34, _feat,
  );
  policyAction(policy, _feat, _act);
  // Back out of the mirror — the same flip that went in, or a seat that was
  // never mirrored comes out swimming the wrong way.
  const mir = ownSideOf(botState.seat ?? 1) > 0 ? -1 : 1;
  out.move.set(mir * _act.moveX, _act.moveY);
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
  const ax = mir * _act.aimX;
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
