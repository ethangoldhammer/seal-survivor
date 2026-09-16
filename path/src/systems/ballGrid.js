// ============================================================================
// WHAT THE BALL DOES TO THE BACKDROP — the dents it springs into the hex
// lattice, and the ones it leaves behind it.
//
// The grid (systems/grid.js) already answers to three things: the ripples the
// feedback system fires, the wakes every body on the water pulls, and the
// fingers on the glass. All three are RADIAL — a point that pushes or pulls the
// nodes around it — and all three are the right shape for what they describe.
//
// None of them is the right shape for a ball. A ball is a thing with a LINE:
// what a player needs to read off the backdrop is where it went and how hard it
// was sent, and a symmetrical dent is the same picture whichever way it was
// travelling. So this is a fourth channel, and the three things it has that the
// others do not:
//
//   IT IS DRIVEN BY THE FLIGHT, AND THE FLIGHT ARRIVES LATE. The lattice is
//   dragged bodily along the way the ball is going — but along a LAGGED copy of
//   it, which chases the real heading at `headingLag` per second. So a ball that
//   turns leaves the water still being pulled the old way for a moment, and the
//   drag swings round to the new line over the next few dents rather than on the
//   frame of the touch. That swing IS the read: the chain shows you the shape of
//   the turn, not just its endpoint.
//
//   THE PUNCH WAS TRIED FIRST. ballLook.js sees both velocities at a contact, so
//   the impulse (v1 - v0) was there to be had, and a shot clipped upward would
//   have shoved the lattice UP while flying up-and-right. It is the more literal
//   description of what the seal did and it reads worse: the shove is over in
//   the frame it lands, the chain behind it is already pointing somewhere else,
//   and the one moment the backdrop is asked to explain — a ball changing
//   direction — is the moment it goes incoherent. The lag says the same thing
//   over half a second instead, in the only medium the backdrop has: a line.
//
//   IT SPRINGS. A dent that fades is water going flat; a dent that oscillates
//   back through its own centre is water. The envelope is solved HERE rather
//   than in the shader — one number per dent, not per vertex — which is what
//   makes the whole channel testable in Node and what stops the ages the
//   echoes are drawn at from ever disagreeing with the ages they are retired
//   on. See `springAt`.
//
//   IT ECHOES. A dent is dropped every `spacing` ball-radii of travel and then
//   left in the water to spring out on its own, so behind a moving ball is a
//   chain of them at every stage of settling. That chain IS the trail: the
//   grid is the only surface in this game that is EVERYWHERE, so a line drawn
//   through it is readable from across the pitch in a way the cloud trail
//   (systems/ballTrail.js, which is a different and closer-in thing) is not.
//
// AND IT IS AMPLIFIED ON CONTACT. Every contact the ball has — a seal, a wall,
// a post, a goal — already pushes the event channel in ballLook.js, scaled by
// how hard it was. This reads that same number rather than growing a second
// opinion about what counts as a hit, so a knob turned there moves this too and
// the two can never disagree about which touches were big ones.
//
// WHAT IT IS NOT. It does not draw. It does not decide possession, or colour.
// It publishes a list of dents and hands over the possession field ballLook.js
// built for the goo pass, so the dents are lit by the very same drop that is
// inside the ball (systems/possessionGlsl.js). The traffic is one way: nothing
// here can move the ball, and nothing here is read by anything that can.
// ============================================================================

import { CONFIG } from '../config.js';
import { ballLookState, ballTeams, ballContacts } from './ballLook.js';

// One more than the grid's band, deliberately not: MAX_BALL over there is the
// hard ceiling and this pool is sized to it, because a dent that has no slot is
// a dent nobody will ever see and there is no point ageing it.
const MAX_DENTS = 8;

const cfg = () => CONFIG.versus?.ball?.grid ?? {};

// The pool. Index 0 is the ball itself — re-stamped every frame it is on the
// pitch, so its spring never gets past its own first instant and it holds the
// dent open under the body. 1..n are the echoes, oldest last.
const dents = Array.from({ length: MAX_DENTS }, () => ({
  x: 0, y: 0, radius: 1, dirX: 1, dirY: 0,
  amp0: 0,   // the amplitude it was born with
  age: 0,    // ...and how long ago that was, in wall seconds
  live: false,
  amp: 0,    // the signed spring, solved in update()
  glow: 0,   // ...and its envelope, which never changes sign
}));

// Where the last echo was dropped, so the next one is spaced by TRAVEL rather
// than by time — a ball at a dead roll should not lay a chain of dents on top
// of each other, and a ball at full speed should not leave gaps.
let lastX = 0;
let lastY = 0;
let haveLast = false;
// THE LAGGED HEADING — a unit vector chasing the ball's own, and the line every
// dent is dragged along. Kept here rather than derived per dent because it is a
// property of the FLIGHT, not of any one mark in the water: a dent is born with
// whatever this held at the moment it was dropped and then keeps it forever,
// which is what makes the chain a record of the path.
let hdgX = 1;
let hdgY = 0;
let haveHdg = false;

// The contact count this last acted on. An edge, not a window: a contact is an
// instant, and something counting frames in which some number is large counts
// one hit as hundreds.
//
// KEPT CURRENT EVEN WHILE THERE IS NO BALL, which is the whole reason it is not
// simply zeroed on reset. A kickoff is frames of no ball followed by one frame
// where a seal strikes it, and that frame is both the first this has ever seen
// the ball AND a contact — the hardest, most looked-at contact of the sequence.
// A counter that started from nothing there would read the backlog as a hit it
// had missed; one that started from -1 and refused the first frame on principle
// would throw away the kickoff strike, which is what it used to do.
let seenSeq = 0;
// The published spec, mutated in place — this is read every frame by the grid.
const spec = { dents: [], warp: {}, gain: {}, field: null };

export function resetBallGrid() {
  for (const d of dents) { d.live = false; d.amp0 = 0; d.amp = 0; d.glow = 0; d.age = 0; }
  haveLast = false;
  haveHdg = false;
  // Where the ledger's counter is NOW, not zero: see the note on seenSeq. A
  // reset is a kickoff, and the strike that ends it must still read as a hit.
  seenSeq = ballContacts();
  // ...and the published list with it. resetBallGrid is called from the match's
  // own teardown, which is exactly when nobody is about to call updateBallGrid
  // again — so a spec left holding the last frame would be published one more
  // time, across the kickoff it was reset for.
  publishInto(spec, null);
}

/**
 * THE SPRING, as one signed number. `exp(-age * damp) * cos(age * omega)`: full
 * shove at the instant it is made, through zero, out the other side, and dead.
 *
 * A cosine and not a sine, because a sine is zero at zero — a dent born with no
 * displacement, which is a hit you cannot see on the frame it lands. The
 * envelope is handed back separately: light a dent with the signed value and it
 * goes black every time the spring crosses its own centre, which reads as a
 * strobe rather than as water settling.
 */
export function springAt(age, omega, damp) {
  const env = Math.exp(-Math.max(0, age) * Math.max(0, damp));
  return { amp: env * Math.cos(Math.max(0, age) * omega), glow: env };
}

/**
 * ADVANCE THE CHAIN — `dt` is the WALL clock, the trail's, not the world's.
 *
 * The water the ball has been through is weather: it belongs to where it was
 * left rather than to the ball that left it, so it has to keep springing out
 * through a goal shutter, a kickoff freeze and a hit-stop, all of which stop
 * the ball dead. A dent frozen mid-oscillation with the camera punched all the
 * way in on it reads as the effect having broken, which is exactly the note
 * updateBallTrail carries a few lines away in versus.js.
 */
export function updateBallGrid(dt) {
  const c = cfg();
  if (c.enabled === false) { resetBallGrid(); return; }
  const look = ballLookState();
  const field = ballTeams();
  const seq = ballContacts();
  const live = !!field && (look.br ?? 0) > 0;
  // A CONTACT, counted on the EDGE of the ledger's count — and counted whether
  // there is a ball on the pitch or not. While there is none the edge is only
  // swallowed, so that the frame a ball first appears with a contact already on
  // it (which is every kickoff strike) is not read as a backlog of hits.
  const hit = live && seq !== seenSeq;
  seenSeq = seq;

  const omega = Math.max(0, c.springHz ?? 2.6) * Math.PI * 2;
  const damp = Math.max(0.01, c.damp ?? 2.2);
  const life = Math.max(0.05, c.life ?? 1.6);

  // Age everything first, the head included — it is about to be re-stamped to
  // zero if the ball is still on the pitch, and if it is not it has to settle
  // like any other dent rather than hanging there at full shove.
  for (const d of dents) {
    if (!d.live) continue;
    d.age += dt;
    if (d.age >= life) { d.live = false; d.amp = 0; d.glow = 0; continue; }
    const s = springAt(d.age, omega, damp);
    d.amp = d.amp0 * s.amp;
    d.glow = Math.abs(d.amp0) * s.glow;
  }

  if (!live) { haveLast = false; publishInto(spec, null); return; }

  const r = look.br;
  const speed = look.speed ?? 0;

  // THE LINE THE LATTICE IS DRAGGED ALONG — the flight, arriving late.
  //
  // A ball at a dead stop has no heading, so the last one is HELD rather than
  // chased toward nothing: the dent under a ball trapped against a wall keeps
  // pointing the way it arrived, which is the only thing it could honestly say.
  if (speed > 1e-3) {
    const tx = (look.vx ?? 0) / speed;
    const ty = (look.vy ?? 0) / speed;
    if (!haveHdg) {
      // A ball appearing out of nothing has nothing to lag BEHIND. The first
      // frame takes the flight whole; every frame after it is a chase.
      hdgX = tx;
      hdgY = ty;
      haveHdg = true;
    } else {
      // TURNED, NOT LERPED — the chase runs on the ANGLE between the two.
      //
      // The obvious version lerps the vectors and renormalises, and it is wrong
      // twice. Lerping two unit vectors gives a SHORT one (the chord, not the
      // arc), so a heading halfway through a turn would drag the lattice less
      // hard than one going straight and the effect would sag at exactly the
      // moment it is being looked at. Renormalising fixes that and introduces
      // the worse bug: on a DEAD-ON REVERSAL — a wall bounce straight back, the
      // commonest turn in the game — the lerp only ever shortens the old vector
      // along its own line, and the renormalise puts it straight back to full
      // length pointing the wrong way. The heading never turns at all. It looks
      // completely correct in a still frame and the ball drags its water
      // backwards for the rest of the match.
      //
      // An angle has neither problem: it is always a unit vector, the swing is
      // the swing you asked for, and a 180 turns one consistent way round
      // instead of having no way round at all.
      const cur = Math.atan2(hdgY, hdgX);
      let delta = Math.atan2(ty, tx) - cur;
      // The short way round, in (-pi, pi] — so a turn across the ±pi seam goes
      // the few degrees it actually is rather than the long way back.
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      // Exponential, so the lag is the same lag at 60 and at 120.
      const a = cur + delta * (1 - Math.exp(-Math.max(0, c.headingLag ?? 4) * dt));
      hdgX = Math.cos(a);
      hdgY = Math.sin(a);
    }
  }
  const dirX = hdgX;
  const dirY = hdgY;

  // HOW HARD. A floor that rises with the flight, plus the event channel's own
  // kick — which is what makes a contact bigger than the speed it left behind,
  // and makes a goal bigger than a wall tap without this file being told what
  // either of them is. See ballEvent in systems/ballLook.js.
  const maxSpeed = Math.max(1, CONFIG.versus?.ball?.maxSpeed ?? 64);
  const speed01 = Math.min(1, speed / maxSpeed);
  // A SPIKE IS THE ONE SHOT THE BACKDROP SHOULD SHOUT ABOUT, and the pulse
  // channel alone cannot say so. `pulse` is how hard, which a spike raises only
  // through its speed — and speed is already the `bySpeed` term above, so a
  // spike would have read as "a fast shot" and nothing more. This is the shape
  // it adds instead: the dent is driven harder, it reaches further, and the
  // echoes are dropped closer together, which is what turns the chain from a
  // string of marks into a gouge.
  //
  // Off the look's decaying `spike` rather than the ball's latched one, for the
  // same reason the trail is: what the water should show is the MOMENT, ringing
  // down over the next few tenths, not a flag held up for the whole flight.
  const sk = c.spike ?? {};
  const spike = sk.enabled === false ? 0 : Math.min(look.spike ?? 0, sk.max ?? 2.2);
  const spikeAmp = 1 + spike * ((sk.amount ?? 1.9) - 1);
  const amp = (c.amount ?? 0.9) * spikeAmp
    * ((c.base ?? 0.35) + (c.bySpeed ?? 0.65) * speed01
       + (c.byPulse ?? 0.8) * Math.max(0, look.pulse ?? 0));

  // THE HEAD, pinned to the ball. Re-stamped rather than moved: its age going
  // back to zero every frame is what holds its spring at full shove, so the
  // lattice stays pushed open under the body instead of settling under it.
  const head = dents[0];
  head.x = look.bx;
  head.y = look.by;
  head.radius = r * Math.max(0.05, c.reach ?? 2.6) * (1 + spike * ((sk.reach ?? 1.5) - 1));
  head.dirX = dirX;
  head.dirY = dirY;
  head.amp0 = amp;
  head.age = 0;
  head.live = true;
  head.amp = amp;
  head.glow = Math.abs(amp);

  // AN ECHO, dropped by travel and by contact. Both, because they answer
  // different questions: travel is what lays the trail down evenly at any
  // speed, and a contact has to leave a mark on the water where it happened
  // even if the ball has barely moved since the last drop (a save, a post, a
  // ball trapped against a wall).
  const spacing = Math.max(0.05, c.spacing ?? 0.9) * r
    / (1 + spike * ((sk.density ?? 2.1) - 1));
  // No last drop means the ball has only just appeared — and the mark goes down
  // immediately rather than a spacing's travel later, because the moment a ball
  // appears is the moment somebody hit it.
  const moved = haveLast ? Math.hypot(look.bx - lastX, look.by - lastY) : Infinity;
  if (moved >= spacing || hit) {
    dropEcho(look.bx, look.by, dirX, dirY,
      amp * (hit ? (c.hitScale ?? 1.6) : 1),
      r * Math.max(0.05, c.echoReach ?? 2.0) * (1 + spike * ((sk.reach ?? 1.5) - 1)));
    lastX = look.bx;
    lastY = look.by;
    haveLast = true;
  }

  publishInto(spec, field);
}

/**
 * Push a new echo in at index 1 and slide the rest down, dropping the oldest
 * off the end. An array shuffle of seven objects once every spacing-worth of
 * travel, so the ORDER is the age — which is what lets the grid's band be
 * filled newest-first and the ones that fall off it be the ones nobody would
 * have been able to see anyway.
 */
function dropEcho(x, y, dirX, dirY, amp0, radius) {
  for (let i = MAX_DENTS - 1; i > 1; i--) {
    const from = dents[i - 1];
    const to = dents[i];
    to.x = from.x; to.y = from.y; to.radius = from.radius;
    to.dirX = from.dirX; to.dirY = from.dirY;
    to.amp0 = from.amp0; to.age = from.age; to.live = from.live;
    to.amp = from.amp; to.glow = from.glow;
  }
  const d = dents[1];
  d.x = x; d.y = y; d.radius = radius;
  d.dirX = dirX; d.dirY = dirY;
  d.amp0 = amp0; d.age = 0; d.live = true;
  d.amp = amp0; d.glow = Math.abs(amp0);
}

function publishInto(out, field) {
  const c = cfg();
  out.dents.length = 0;
  if (field) for (const d of dents) { if (d.live) out.dents.push(d); }
  out.warp.radial = c.radial ?? 0.9;
  out.warp.drive = c.drive ?? 1.6;
  out.warp.swirl = c.swirl ?? 0.55;
  out.warp.stretch = Math.max(0.01, c.stretch ?? 2.2);
  out.gain.color = c.gain ?? 1.1;
  out.gain.alpha = c.alpha ?? 0.55;
  out.field = field;
}

/**
 * Hand this frame's dents to the lattice. Separate from the advance above
 * because the two happen in different places: the chain is advanced on the
 * wall clock inside the match loop (versus.js), and the grid is published to
 * from the frame loop that owns it (main.js), beside every other body denting
 * the water. Called every frame whether a match is on or not — publishing
 * nothing is how the channel is switched off.
 */
export function publishBallGrid(grid) {
  if (!grid?.ballWarp) return;
  grid.ballWarp(spec.field && spec.dents.length ? spec : null);
}

/** For the harness and the labs — the chain as it stands. */
export function ballGridState() {
  return {
    dents: dents.map((d) => ({ ...d })),
    live: dents.filter((d) => d.live).length,
    // The lagged heading, which is the one number in here that is neither drawn
    // nor published: it is the line every dent is BORN with, and the only way
    // to see it trailing a turn is to read it.
    heading: { x: hdgX, y: hdgY, have: haveHdg },
    spec: { dents: spec.dents.length, field: !!spec.field, ...spec.warp, ...spec.gain },
  };
}
