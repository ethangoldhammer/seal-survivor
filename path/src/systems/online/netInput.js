// ---------------------------------------------------------------------------
// THE GUEST'S HANDS — twelve bytes up the wire, thirty times a second, and the
// seat they end up driving on the host.
//
// EDGES ARE DERIVED, NOT SENT, which is protocol.js's decision and this is the
// half of it that does the deriving. The wire carries `strikeHeld` — a LEVEL,
// true for as long as the button is down — and never `strike` or
// `strikeRelease`, which are the frames it went down and came up. That looks
// like it is throwing information away and it is doing the opposite: an edge is
// true for exactly one frame, so a dropped packet loses the dash outright,
// whereas a level that arrives a frame late is a dash that starts a frame late.
// One of those is a button that did nothing and the other is sixteen
// milliseconds nobody can feel.
//
// So the host re-makes the edges here, out of what the level did between two
// frames, exactly as readP2Input makes them out of a gamepad button. The
// `heldPrev` this compares against is the HOST's memory of the guest's button,
// which is the only place the comparison can honestly live: the guest's own
// heldPrev is on the other side of a wire that may have dropped the frame in
// between.
//
// NOT AN INPUT QUEUE. There is no rollback here and no replay of held inputs:
// the newest packet is the guest's hands, and an older one that turns up late
// is worth nothing. See sendBinary in room.js, which drops rather than queues
// for the same reason.
// ---------------------------------------------------------------------------

import { encodeInput, decodeInput } from './protocol.js';

/** The last input to arrive from the guest, decoded. Null before the first. */
let latest = null;

/**
 * The host's memory of the guest's strike button on the previous frame it
 * READ — not the previous frame that arrived. Those differ whenever the wire
 * is slower than the frame rate, and stepping the edge off arrival would fire
 * two dashes from one press on a fast connection and none on a slow one.
 */
let heldPrev = false;

let seq = 0;
let received = 0;

export function resetNetInput() {
  latest = null;
  heldPrev = false;
  seq = 0;
  received = 0;
}

/** How many input packets the host has taken from the guest this match. */
export function receivedInputs() {
  return received;
}

/** The last decoded input, for the harness. */
export function latestInput() {
  return latest;
}

/**
 * THE GUEST'S SIDE — this machine's live input, as bytes to send.
 *
 * `clientMs` rides along and is not used by anything yet. It is two bytes and
 * it is the only way a later version can measure one-way delay rather than the
 * round trip the ping gives, which is the number that actually decides how far
 * ahead a prediction would have to run.
 */
export function captureInput(input, clientMs = 0) {
  if (!input) return null;
  return encodeInput({
    seq: (seq = (seq + 1) & 0xffff),
    clientMs: Math.round(clientMs) & 0xffff,
    move: input.move ?? { x: 0, y: 0 },
    aim: input.aim ?? { x: 0, y: 0 },
    aimLive: !!input.aimLive,
    aimMoved: !!input.aimMoved,
    strikeHeld: !!input.strikeHeld,
    connected: input.connected !== false,
  });
}

/** A binary frame arrived on the host. @returns whether it was an input. */
export function receiveInput(buf) {
  const msg = decodeInput(buf);
  if (!msg) return false;
  latest = msg;
  received += 1;
  return true;
}

/**
 * THE HOST'S SIDE — fill `out` with the guest's hands, in the shape every
 * other seat's input has.
 *
 * NOTHING ARRIVED YET IS `connected: false` AND NOT A ZEROED STICK, and the
 * difference decides who drives the seal: botWanted reads `connected`, so a
 * seat reporting a connected device holding nothing is a seal standing still
 * in the water, while one reporting no device is handed to the bot. Before the
 * first packet, and after the guest's wire goes away, the bot is the right
 * answer — it is what the seat did before there was a guest at all.
 */
export function readRemoteInput(out) {
  if (!out) return out;
  const msg = latest;
  if (!msg || !msg.connected) {
    out.connected = false;
    out.move?.set?.(0, 0);
    out.strike = false;
    out.strikeRelease = heldPrev;
    out.strikeHeld = false;
    heldPrev = false;
    return out;
  }
  out.connected = true;
  out.move?.set?.(msg.move.x, msg.move.y);
  if (out.move?.lengthSq?.() > 1) out.move.normalize();
  if (msg.aim.x || msg.aim.y) out.aim?.set?.(msg.aim.x, msg.aim.y).normalize();
  out.aimLive = msg.aimLive;
  out.aimMoved = msg.aimMoved;
  const held = msg.strikeHeld;
  out.strikeHeld = held;
  out.strike = held && !heldPrev;
  out.strikeRelease = heldPrev && !held;
  heldPrev = held;
  return out;
}
