// ---------------------------------------------------------------------------
// THE MATCH START — one message that turns two browsers into one match.
//
// The host picks everything: the roster size, the rules, the two colours, the
// cast and what each side is called. This is the shape those decisions take on
// the wire, and the two functions that write and read it.
//
// WHY A PAYLOAD AND NOT A SEED. Nearly all of this could be derived from a
// shared random seed, and that was the first design. It fails for a reason
// worth writing down: every draw here is made against state the two machines
// do not share. Team names roll against NAME_MEMORY, which remembers what the
// LAST few matches on that machine spent. Seal names roll against the names
// already in the roster, which start with the local player's own. An accessory
// is filtered through what that player has unlocked. A seed makes the DRAW
// reproducible, not its inputs — so two ends would diverge exactly as far as
// their two histories differ, silently, and the first evidence would be the
// goal card naming two different teams after somebody scored. Strings on the
// wire cannot drift.
//
// WHAT IS NOT HERE: anything either end can work out for itself from the flag
// and the seat. The arena is carved from the roster (setModeWorld), the camera
// frames itself off localSeat(), the kickoff spots come out of seatFormation.
// Sending those too would be a second source of truth for facts that are
// already functions of what IS sent.
//
// PADS ARE NEVER SENT, and that is the one field that has to be rewritten on
// arrival rather than copied. A member's `pad` is a LOCAL device — a Gamepad
// index or KEYBOARD — and the host's second controller is not a thing that
// exists on the guest's iPad. What crosses is the member's KIND; which machine
// drives which seat is then a fact each end knows about itself, and applying
// it is the whole of seatsFor() below.
// ---------------------------------------------------------------------------

import { versusSetup, KEYBOARD, MAX_PER_SIDE } from '../versusFlag.js';
import { REMOTE, GUEST_SEAT, netIsGuest } from './session.js';
import { rosterPerSide, setRosterSize } from '../sealRoster.js';
import {
  isTimed, setTimed, goalsToWin, setGoalsToWin, matchSeconds, setMatchSeconds,
} from '../matchRules.js';
import { rosterNames, rosterKit, applyRosterCast } from '../rosterCast.js';
import { teamNames, applyTeamNames } from '../teamNameCast.js';

/**
 * Bumped when the payload's SHAPE changes in a way an older reader would get
 * wrong. Separate from PROTOCOL_VERSION in protocol.js, which guards the
 * binary layouts: these two move for different reasons and at different rates,
 * and one number for both would force a snapshot-layout bump every time a
 * match setting was added.
 *
 * In practice the build check at the join (room.js's buildId) already refuses
 * two different builds, so this is the belt to that pair of braces — it costs
 * one integer and it is the difference between a confusing match and a clear
 * refusal if the build check is ever loosened.
 */
export const MATCH_START_VERSION = 1;

/**
 * THE HOST'S ANSWER, in the shape the guest reads.
 *
 * Called after the team select has written versusSetup — that screen is the
 * only thing that decides any of this, and reading it rather than being handed
 * it means there is no second copy of the roster to keep in step.
 */
export function captureMatch() {
  return {
    v: MATCH_START_VERSION,
    roster: rosterPerSide(),
    rules: {
      timed: isTimed(),
      goals: goalsToWin(),
      seconds: matchSeconds(),
    },
    // Colour and the KINDS on each side. `color` is a number or null, and null
    // is meaningful — it is "whatever CONFIG's default is", which both ends
    // resolve the same way through ballLook.teamColor. Sending a resolved
    // colour instead would bake one machine's tuning into the other's match.
    teams: versusSetup.teams.map((t) => ({
      color: typeof t.color === 'number' ? t.color : null,
      kinds: t.members.slice(0, MAX_PER_SIDE).map((m) => (m?.kind === 'human' ? 'human' : 'cpu')),
    })),
    cast: { names: rosterNames(), kit: rosterKit() },
    teamNames: teamNames(),
  };
}

/**
 * Which member record seat-of-side `nth` on `side` gets on THIS machine.
 *
 * The captain of each side is a person, and which of the two is at this
 * keyboard is the only thing the two ends disagree about:
 *
 *   side 0's captain is the HOST      — local here on the host, REMOTE on the guest
 *   side 1's captain is the GUEST     — REMOTE on the host, local here on the guest
 *
 * REMOTE rather than a pad index, because a real index on a seat somebody else
 * is driving means the local device silently wins every frame — two people on
 * one seal. That sentinel is also what versusHumanCount reads to keep a remote
 * captain out of the local-multiplayer camera, and what seatPad refuses to
 * hand back as a device.
 *
 * KEYBOARD for our own captain and never a pad index: this is the seat
 * input.js drives, which on a phone is touch and on a desktop is the keys, and
 * the team select's own device map does not survive the trip to another
 * machine anyway.
 */
function memberFor(side, nth, kind) {
  if (nth > 0 || kind !== 'human') return { kind: 'cpu', pad: null };
  const mine = netIsGuest() ? GUEST_SEAT : 0;
  return { kind: 'human', pad: side === mine ? KEYBOARD : REMOTE };
}

/**
 * THE GUEST'S SIDE OF IT — build the host's match here.
 *
 * Order matters in one place and it is worth stating: the roster size is set
 * FIRST, because rosterNames() and rosterKit() clip to it and applyRosterCast
 * writes a list that syncRosterCast will later fill up to exactly that size.
 * Setting it after the cast would leave the cast clipped to whatever the
 * previous match's roster happened to be.
 *
 * @returns true when a payload was understood and applied.
 */
export function applyMatch(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.v !== MATCH_START_VERSION) return false;

  setRosterSize(Number(payload.roster) || 1);

  const rules = payload.rules ?? {};
  // Each through its own setter, so every clamp in matchRules.js still applies
  // to a number that arrived over a wire. A payload written by a peer is not
  // hostile, but it is also not checked by the screen that normally produces
  // these, and MIN/MAX live in one place for a reason.
  setTimed(!!rules.timed);
  setGoalsToWin(Number(rules.goals) || goalsToWin());
  setMatchSeconds(Number(rules.seconds) || matchSeconds());

  const teams = Array.isArray(payload.teams) ? payload.teams : [];
  for (let side = 0; side < versusSetup.teams.length; side += 1) {
    const from = teams[side] ?? {};
    const t = versusSetup.teams[side];
    t.color = typeof from.color === 'number' ? from.color : null;
    t.members.length = 0;
    const kinds = Array.isArray(from.kinds) ? from.kinds : [];
    for (let nth = 0; nth < Math.min(kinds.length, MAX_PER_SIDE); nth += 1) {
      t.members.push(memberFor(side, nth, kinds[nth]));
    }
  }

  applyRosterCast(payload.cast ?? {});
  applyTeamNames(payload.teamNames ?? []);
  return true;
}

/**
 * The host's own roster, rewritten so seat 1 belongs to the person on the
 * other machine.
 *
 * THE TEAM SELECT CANNOT KNOW THIS. It is a screen about local devices — a
 * chip per controller in the room, walked onto a side — so whatever it put on
 * the right-hand side is a device at the HOST's keyboard, and in an online
 * match that side is somebody else's. Left alone, the host would drive both
 * seals and the guest's input would arrive at a seat already being written.
 *
 * Applied on the host only, immediately before the match is captured, so the
 * payload the guest receives already describes the arrangement both ends will
 * actually run.
 */
export function claimRemoteSeat() {
  const side = GUEST_SEAT;
  const t = versusSetup.teams[side];
  if (!t) return false;
  // A side the host left empty still gets its captain: an online match has two
  // people in it by definition, and a guest that arrived at an empty side
  // would be handed to the bot by seatIsCpu.
  if (!t.members.length) t.members.push({ kind: 'human', pad: REMOTE });
  else t.members[0] = { kind: 'human', pad: REMOTE };
  return true;
}
