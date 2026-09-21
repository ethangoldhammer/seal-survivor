// ---------------------------------------------------------------------------
// THE FRAME ITSELF — the host's match, made into bytes, and posed at the other
// end.
//
// THE GUEST POSES, IT DOES NOT SIMULATE. updateVersus already had exactly this
// shape before any of this existed, for replays:
//
//     if (replayState.active) { poseReplay(...); ...; return; }
//
// A replay is a recording being posed over a world that is not being stepped,
// which is precisely what a guest is — the recording just happens to be
// arriving over a wire a hundred milliseconds old instead of out of a buffer.
// So the guest's gate sits beside that one, in the same function, taking the
// same early return. Nothing downstream of it needs a second opinion about who
// is authoritative, which is the whole reason the rule in session.js is
// "one writer, one guard".
//
// WHAT IS POSED AND WHAT IS INFERRED. Position, orientation and the two meters
// come off the wire; everything that is a BYPRODUCT of a pose is left to run
// locally — the swim cycle, the water, the trail, the bubbles' pop. That split
// is the same one protocol.js's RELAYED set draws for events, and for the same
// reason: a thing the guest can work out from what it has been given costs
// nothing, and sending it costs a byte every frame forever.
//
// THE RIM IS RESAMPLED, NOT COPIED, and that is not defensive padding. The
// ball's rim is `Math.max(6, Math.round(CONFIG.versus.ball.soft.points ?? 24))`
// samples long (versus.js, resetBall), which is a TUNED number Ethan can move
// with a slider, while the wire carries a fixed 24 because a variable-length
// block in a fixed-layout snapshot is a different protocol. Copying index for
// index works perfectly until the day that slider moves, and then it silently
// dents the wrong part of the ball on one machine only. Resampling by angle
// costs a multiply and cannot be wrong.
// ---------------------------------------------------------------------------

import {
  encodeSnapshot, decodeSnapshot, RIM_POINTS,
} from './protocol.js';
import { versusState, ball, matchSeals, seatOf, sealAt } from '../versus.js';
import { strikeState } from '../strike.js';
import { player } from '../../entities/player.js';
import { CONFIG } from '../../config.js';

/**
 * The tank's size, so oxygen can ride as a 0..1 fraction of it.
 *
 * A FRACTION AND NOT THE RAW NUMBER, because maxOxygen is a RUN stat — it
 * grows with upgrades — and the two machines need not have the same one. A
 * fraction means each end fills its own bar to the same proportion, which is
 * what the bar is actually showing; a raw value would draw the host's 140 into
 * the guest's 100 and peg it full.
 */
function maxOxygen() {
  return Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen?.max ?? 100);
}

/**
 * The last snapshot that arrived, decoded. Held rather than queued: a guest
 * that is a frame behind wants the NEWEST pose, not the oldest unread one —
 * see sendBinary's note in room.js, which drops for the same reason.
 */
let latest = null;
/**
 * The frame BEFORE `latest`, and when each arrived.
 *
 * TWO FRAMES IS THE WHOLE FIX FOR "CHOPPY". Snapshots land 20 times a second
 * and the guest draws 60 — so posing `latest` directly showed each position
 * for three frames and then jumped, which is a slideshow no amount of smooth
 * input can hide. The seals' INPUT was always fine (it goes the other way at
 * 30 Hz and the host renders it live, which is why it looked perfect on the
 * host and wrong on the guest — the same evidence that says the wire is
 * healthy also says the problem is entirely on the drawing side).
 *
 * So the guest draws the match ONE SNAPSHOT IN THE PAST, between the two
 * frames it already holds, and never has to guess at a position it has not
 * been told. That is a fixed ~50 ms of extra latency on what you SEE, which is
 * the trade every game of this shape makes: 50 ms late and smooth beats live
 * and juddering, and it costs the guest nothing in responsiveness because the
 * guest's own input is not simulated here at all — it is already on its way to
 * the host by then.
 *
 * EXTRAPOLATION WAS THE ALTERNATIVE and is the wrong one here. Running ahead
 * of the last known position means inventing one, and every invention has to
 * be walked back when the truth arrives — which on a ball that reverses off a
 * seal is a visible snap at exactly the moment the player is watching hardest.
 */
let prev = null;
let prevAt = 0;
let latestAt = 0;

/** The gap a 20 Hz snapshot stream leaves, in seconds. See netTick. */
const DEFAULT_SPAN = 1 / 20;

/**
 * How far behind the newest frame the guest draws, as a multiple of the gap
 * between frames. One means "draw the frame we are interpolating INTO as it
 * arrives", which is the least delay that still never extrapolates.
 */
const DELAY_SPANS = 1;

let seq = 0;

function now() {
  return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Shortest-arc quaternion blend, normalised.
 *
 * THE DOT-SIGN FLIP IS NOT OPTIONAL. q and -q are the same orientation, so two
 * consecutive snapshots can carry opposite signs for a seal that has not moved
 * — and blending those two takes the long way round the sphere. The symptom is
 * a seal that spins through a full rotation between two frames, roughly once
 * every few seconds, which reads as the model glitching rather than as maths.
 *
 * nlerp rather than a true slerp: at 20 Hz the arc between two frames of the
 * same animal is small, where the two agree to well under what the wire's
 * 16-bit quantisation already costs.
 */
function blendQuat(out, a, b, t) {
  let bx = b.qx, by = b.qy, bz = b.qz, bw = b.qw;
  if (a.qx * bx + a.qy * by + a.qz * bz + a.qw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const x = lerp(a.qx, bx, t), y = lerp(a.qy, by, t);
  const z = lerp(a.qz, bz, t), w = lerp(a.qw, bw, t);
  const len = Math.hypot(x, y, z, w) || 1;
  out.set(x / len, y / len, z / len, w / len);
}

/** How many snapshots have been posed. For the harness, and for a stall check. */
let posed = 0;

/** Forget everything. A match ending, or a harness wanting a clean run. */
export function resetNetSnapshot() {
  latest = null;
  prev = null;
  prevAt = 0;
  latestAt = 0;
  seq = 0;
  posed = 0;
}

/**
 * Where between the two held frames the guest should be drawing, 0..1.
 *
 * CLAMPED AT BOTH ENDS, and the top clamp is what happens when snapshots stop
 * coming: alpha pins at 1 and the world holds the last frame it was actually
 * told about rather than sailing on through the wall. A stall should look like
 * a pause, which is honest, and not like a match still being played.
 */
function alpha() {
  const span = Math.max(1e-3, latestAt - prevAt);
  const at = now() - DELAY_SPANS * span;
  return Math.max(0, Math.min(1, (at - prevAt) / span));
}

/** How far between frames the last pose was drawn. For the harness. */
export function poseAlpha() {
  return latest && prev ? alpha() : 1;
}

/** The decoded snapshot the guest is currently posing, or null. */
export function latestSnapshot() {
  return latest;
}

/** How many frames have been posed from the wire this match. */
export function posedFrames() {
  return posed;
}

/**
 * Read `rim` — whatever length it is — at `n` evenly spaced angles.
 *
 * Nearest-sample rather than interpolated: a dent is a soft shape a couple of
 * samples wide and the wire quantises it to an eighth of a unit anyway, so the
 * error from rounding an index is well under the error already in the byte.
 */
function resample(rim, n) {
  const out = new Float32Array(n);
  const len = rim?.length ?? 0;
  if (!len) return out;
  for (let i = 0; i < n; i += 1) out[i] = rim[Math.round((i * len) / n) % len] ?? 0;
  return out;
}

/**
 * THE HOST'S FRAME, as bytes. Null when there is nothing to send.
 *
 * `visible` is read off the mesh rather than off versusState.dead, because a
 * seal is also hidden while it is bursting and during the goal shutter, and
 * the guest wants the seal to disappear at the moment it disappears here — not
 * at the moment a timer somewhere says it should have.
 */
export function captureSnapshot() {
  if (!versusState.active) return null;
  const seals = [];
  for (const seal of matchSeals()) {
    const p = seal.mesh?.position;
    const q = seal.mesh?.quaternion;
    if (!p || !q) continue;
    const seat = seatOf(seal);
    seals.push({
      x: p.x, y: p.y,
      rz: seal.mesh.rotation?.z ?? 0,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      visible: seal.mesh.visible !== false,
      dead: (versusState.dead?.[seat] ?? 0) > 0,
    });
  }

  const meters = [];
  const maxO2 = maxOxygen();
  for (let i = 0; i < 2; i += 1) {
    const seal = sealAt(i);
    meters.push({
      pending: seal?.strike?.pending ?? 0,
      // THE LIVE TANK, off the seal. NOT versusState.fillAir, which is what
      // this used to send and which is not a meter at all: captureTanks writes
      // it ONCE PER KICKOFF as the value the countdown's refill blends FROM.
      // Between whistles it is a frozen number from the last kickoff, so the
      // guest's oxygen bar sat still all match and then jumped.
      oxygen01: (seal?.oxygen ?? maxO2) / maxO2,
      charging: !!seal?.strike?.charging,
      // ...AND THE STOCKED BOOST, which lives in two places depending on the
      // seat: seat 0's is strikeState (that seal is the run's player and its
      // charge is the run's), every other seat keeps its own on seal.strike.
      // The same split paintTanks makes.
      charge: i === 0 ? (strikeState.charge ?? 1) : (seal?.strike?.charge ?? 1),
    });
  }

  return encodeSnapshot({
    seq: (seq = (seq + 1) & 0xffff),
    clock: versusState.clock,
    ball: {
      x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy,
      angle: ball.angle, spin: ball.spin,
      rim: resample(ball.rim, RIM_POINTS),
    },
    seals,
    meters,
    match: {
      phase: versusState.phase,
      scores: versusState.scores,
      count: versusState.count,
      phaseT: versusState.phaseT,
      timeScale: versusState.timeScale,
      winner: versusState.winner,
      draw: versusState.draw,
    },
  });
}

/**
 * A binary frame arrived on the guest. Kept, not applied — the pose happens on
 * the frame, inside updateVersus, so that it lands in the same place in the
 * order that stepping it would have.
 *
 * NO REORDER CHECK, and that is a decision rather than an omission. WebSocket
 * delivery over one socket is ordered by the transport, so the newest frame to
 * arrive IS the newest frame — and the obvious guard, comparing `seq`, would
 * be actively wrong across a reconnect, where the host's counter restarts and
 * every genuinely-new frame looks older than what is held. Last one wins.
 */
export function receiveSnapshot(buf) {
  const snap = decodeSnapshot(buf);
  if (!snap) return false;
  prev = latest;
  prevAt = latestAt;
  latest = snap;
  latestAt = now();
  // The first frame of a match has nothing to come from, so it is its own
  // previous: alpha is then always 1 and the pose is simply that frame.
  if (!prev) { prev = latest; prevAt = latestAt - DEFAULT_SPAN; }
  return true;
}

/**
 * POSE THE WORLD from the last snapshot. The guest's whole frame.
 *
 * @returns true when a pose happened; false when nothing has arrived yet,
 *          which the caller reads as "hold the last frame" rather than as an
 *          error — the first snapshot is always a few frames after kickoff.
 */
export function poseSnapshot() {
  const b = latest;
  const a = prev ?? latest;
  if (!b) return false;
  const t = alpha();

  ball.x = lerp(a.ball.x, b.ball.x, t);
  ball.y = lerp(a.ball.y, b.ball.y, t);
  ball.vx = lerp(a.ball.vx, b.ball.vx, t);
  ball.vy = lerp(a.ball.vy, b.ball.vy, t);
  // THE ANGLE GOES THE SHORT WAY. A plain lerp across the -pi/pi seam spins
  // the ball backwards through a whole turn, and a ball is the one thing on
  // the pitch whose spin a player is actually watching.
  ball.angle = lerp(a.ball.angle, a.ball.angle + wrapPi(b.ball.angle - a.ball.angle), t);
  ball.spin = lerp(a.ball.spin, b.ball.spin, t);
  // Into the array that is already there, at ITS length — never replaced. The
  // buffers in `ball` are handed to geometry that holds a reference to them,
  // so assigning a new Float32Array here would leave the mesh drawing the old
  // one forever, with no error anywhere.
  if (ball.rim?.length) {
    for (let i = 0; i < ball.rim.length; i += 1) {
      const k = Math.round((i * RIM_POINTS) / ball.rim.length) % RIM_POINTS;
      ball.rim[i] = lerp(a.ball.rim[k] ?? 0, b.ball.rim[k] ?? 0, t);
    }
  }

  const seals = matchSeals();
  for (let i = 0; i < seals.length && i < b.seals.length; i += 1) {
    const seal = seals[i];
    const to = b.seals[i];
    const from = a.seals[i] ?? to;
    if (!seal.mesh) continue;
    seal.mesh.position.x = lerp(from.x, to.x, t);
    seal.mesh.position.y = lerp(from.y, to.y, t);
    blendQuat(seal.mesh.quaternion, from, to, t);
    // VISIBILITY AND DEATH DO NOT BLEND. Half-visible is not a state a seal
    // has; these take the frame being drawn INTO, so a seal that bursts
    // disappears on the frame the snapshot says it did rather than fading
    // through a value that means nothing.
    seal.mesh.visible = to.visible;
    const seat = seatOf(seal);
    if (versusState.dead) versusState.dead[seat] = to.dead ? 1 : 0;
  }

  const maxO2 = maxOxygen();
  for (let i = 0; i < b.meters.length; i += 1) {
    const seal = sealAt(i);
    const m = b.meters[i];
    const was = a.meters[i] ?? m;
    if (!seal) continue;
    if (seal.strike) {
      seal.strike.pending = lerp(was.pending, m.pending, t);
      // A FLAG, NOT A LEVEL — same rule as `visible`.
      seal.strike.charging = m.charging;
    }
    // Back onto the seal, and back through the same seat split it was read
    // through — the HUD reads strikeState for seat 0 and the seal for the
    // rest, so writing only one of them leaves whichever bar this machine is
    // actually looking at untouched.
    seal.oxygen = lerp(was.oxygen01, m.oxygen01, t) * maxO2;
    const charge = lerp(was.charge, m.charge, t);
    if (i === 0) strikeState.charge = charge;
    else if (seal.strike) seal.strike.charge = charge;
  }

  // THE MATCH'S OWN FACTS ARE NOT INTERPOLATED. A score of 2.4 is not a score,
  // and a phase halfway between 'play' and 'scored' is not a phase. They take
  // the frame being drawn into, which means the goal number lands at most one
  // snapshot after the host called it.
  versusState.phase = b.match.phase;
  versusState.scores[0] = b.match.scores[0];
  versusState.scores[1] = b.match.scores[1];
  versusState.count = b.match.count;
  versusState.phaseT = lerp(a.match.phaseT, b.match.phaseT, t);
  versusState.timeScale = b.match.timeScale;
  versusState.winner = b.match.winner;
  versusState.draw = b.match.draw;
  versusState.clock = lerp(a.clock, b.clock, t);

  posed += 1;
  return true;
}

/** An angle folded into -pi..pi, for the short way round. */
function wrapPi(d) {
  let x = d;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
