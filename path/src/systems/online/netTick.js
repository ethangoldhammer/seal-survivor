// ---------------------------------------------------------------------------
// THE PUMP — the one line main.js runs per frame to keep a match on the wire,
// and the routing that decides what an arriving binary frame IS.
//
// A SEPARATE FILE FROM BOTH ENDS IT DRIVES, because what it owns is neither
// the snapshot nor the input: it owns the CLOCK they go out on, and that is a
// different decision from either payload's layout. netSnapshot.js knows how to
// make a frame; this knows that twenty of them a second is enough.
//
// TWO RATES, NOT ONE, AND THE SLOWER ONE IS THE BIG MESSAGE. A snapshot is 94
// bytes for a 1v1 and goes at 20 Hz; an input is 12 bytes and goes at 30 Hz.
// That looks backwards until you price it: incoming messages bill at 20:1 on
// Cloudflare (see server/room/README.md), so it is the GUEST's little packet
// that costs, and the host's big one that is nearly free. The rates are also
// right on their own terms — a pose interpolates between frames and survives
// being coarse, while a button press that misses its frame is a dash that
// never happened.
//
// SEND RATE IS NOT FRAME RATE. Both are accumulators over real dt rather than
// "every third frame", so a 120 Hz display does not put six times the traffic
// on the wire as a 30 Hz one, and a phone that drops to 40 fps still sends its
// hands at 30 Hz.
// ---------------------------------------------------------------------------

import { onRoomMessage, sendBinary } from './room.js';
import { session, netIsGuest, onlineActive } from './session.js';
import { MSG_INPUT, MSG_SNAPSHOT } from './protocol.js';
import { captureSnapshot, receiveSnapshot, resetNetSnapshot } from './netSnapshot.js';
import { captureInput, receiveInput, resetNetInput } from './netInput.js';

const SNAPSHOT_HZ = 20;
const INPUT_HZ = 30;

let sinceSend = 0;
let unsubscribe = null;

/**
 * Start routing binary frames to the right decoder, and clear both ends.
 *
 * ROUTED ON THE FIRST BYTE rather than on which role we are, and the
 * difference matters exactly once: during a reconnect, when a frame from the
 * old session can land after the role has been rewritten. A router that
 * trusted the role would hand a snapshot to the input decoder, which would
 * reject it — quietly, because decodeInput returns null rather than throwing —
 * and the symptom would be a match that went still for no reason. The message
 * type is in the byte; ask the byte.
 */
export function startNetPump() {
  stopNetPump();
  resetNetSnapshot();
  resetNetInput();
  sinceSend = 0;
  unsubscribe = onRoomMessage((msg, binary) => {
    if (!binary) return;
    const tag = new Uint8Array(msg, 0, 1)[0];
    if (tag === MSG_SNAPSHOT) receiveSnapshot(msg);
    else if (tag === MSG_INPUT) receiveInput(msg);
  });
}

/** Stop routing. The end of a match, or of a session. */
export function stopNetPump() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

/**
 * ONE FRAME'S WORTH OF WIRE. Called from the run loop right after the match
 * has been stepped (or posed), so a snapshot describes the frame the host is
 * actually looking at rather than the one before it.
 *
 * GATED ON 'playing' AND NOT MERELY ON BEING IN A ROOM: the lobby, the team
 * select and the wreckage of a finished match are all sessions with a live
 * socket and no match to describe, and captureSnapshot would be building
 * frames out of a versusState nobody is stepping.
 *
 * @param dt     real seconds since the last frame — NOT the dilated match dt,
 *               because a send rate that slowed down inside the goal shutter
 *               would stop feeding the guest at the exact moment it has the
 *               most to show.
 * @param input  this machine's live input, for a guest to send. Ignored on the
 *               host, which reads its own seats directly.
 */
export function netTick(dt, input = null) {
  if (!onlineActive() || session.phase !== 'playing') return false;
  const period = 1 / (netIsGuest() ? INPUT_HZ : SNAPSHOT_HZ);
  sinceSend += dt;
  if (sinceSend < period) return false;
  // Set rather than decremented: a tab that was backgrounded comes back with
  // seconds of dt in hand, and draining that as a backlog would fire a burst
  // of frames describing a match that has already moved past all of them.
  sinceSend = 0;
  const buf = netIsGuest() ? captureInput(input) : captureSnapshot();
  if (!buf) return false;
  return sendBinary(buf);
}
