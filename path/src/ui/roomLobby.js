// ---------------------------------------------------------------------------
// THE ROOM SCREEN — where two people on two machines meet at a five-letter
// code, before either of them sees a pitch.
//
// A SEPARATE SCREEN, NOT A MODE ON teamSelect.js, and that is the load-bearing
// decision in this file. The team select is 986 lines with no phase concept,
// and its entire input model is `pollPads` over LOCAL DEVICES — a chip per
// controller in the room, walked onto a side. A remote player is not a local
// device, and threading "this chip is four hundred milliseconds away and
// belongs to another browser" through that device map is how a file that is
// already long becomes one nobody can change. Leaving it alone also means its
// harness keeps passing unchanged, and `writeSetup()` stays the one clean exit
// point the online path reuses rather than reaches into.
//
// THE HOST PICKS FOR BOTH. Once the room is full and both have readied, the
// host goes to the ordinary team select and the guest waits here. That is the
// honest simplification for a first version: no distributed colour wheel, no
// ready-state race over the roster size, and one machine that unambiguously
// decides what the match IS. The guest's screen says so rather than spinning.
//
// WHERE IT SITS: Seal sports -> the online row -> here -> (host) the team
// select, or (guest) a wait, and both end up in `enterMode(true)` on the same
// match. See main.js's openSealSports.
//
// OFFLINE IS INVISIBLE, not broken. With no VITE_ROOM_URL this screen is never
// reachable — ui.js does not draw the row that opens it — so a build with no
// room server is exactly the game it was before any of this existed.
//
// COPY: every word is a row of uiText.csv, in the `room lobby` group, and all
// of it is lorem or [DRAFT] until Ethan writes it. `npm run test:copy` fails
// while that is true, which is the intent.
// ---------------------------------------------------------------------------

import { uiText } from '../uiTextTable.js';
import { feedback } from '../systems/feedback.js';
import { pollPads } from './padPoll.js';
import { installStyleBelowRoles } from './typography.js';
import {
  roomState, roomsAvailable, requestCode, joinRoom, leaveRoom, setReady, send, onRoomMessage, peer,
} from '../systems/online/room.js';
import { beginLobby, endSession, session } from '../systems/online/session.js';
// WHAT A CODE IS comes from the leaf the server reads it from too, so this
// screen and the room can never disagree about which letters exist.
import { normalizeCode } from '../systems/online/protocol.js';

// Which half of the screen is showing. Three, and they are genuinely different
// screens rather than states of one: `pick` has two buttons, `code` has a text
// field, `room` has two player rows. The team select gets away with one screen
// because everything on it is always true at once; none of these are.
const PICK = 'pick';
const CODE = 'code';
const ROOM = 'room';

const STYLE = `
.sv-room-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; min-width: min(420px, 86vw); }
.sv-room-status { font-size: 12px; letter-spacing: .04em; min-height: 1.2em; text-align: center; opacity: .75; }
.sv-room-error { font-size: 12px; line-height: 1.4; text-align: center; min-height: 1.2em; color: #ff9b9b; max-width: 34ch; }
.sv-room-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; }

/* THE CODE, as the thing the host reads out loud. Tabular figures and a wide
   letter-space because this is copied by eye across a room or down a phone —
   the same reason the alphabet has no O, I or L in it (see room-relay.js). */
.sv-room-code { font-size: clamp(28px, 7vmin, 44px); font-weight: 700; letter-spacing: .22em;
  font-variant-numeric: tabular-nums; padding-left: .22em; user-select: all; cursor: pointer; }
.sv-room-code-label { font-size: 12px; opacity: .8; text-align: center; max-width: 34ch; line-height: 1.4; }

/* THE ENTRY FIELD. Five characters and never more, upper-cased as you type so
   what is on screen is what will be sent. ch and not px: this is a column of
   glyphs, and px sizes here assume a font that may not have loaded. */
.sv-room-input { width: 7ch; font: inherit; font-size: clamp(22px, 6vmin, 34px); font-weight: 700;
  letter-spacing: .18em; text-align: center; text-transform: uppercase;
  padding: 8px 6px; border-radius: 10px; color: inherit;
  background: rgba(255,255,255,.08); border: 2px solid rgba(255,255,255,.18); }
.sv-room-input:focus { outline: none; border-color: #fff; }

/* THE TWO SEATS. One row each, the same height whether anybody is in it, so
   the panel does not jump the moment the other player arrives. */
.sv-room-seats { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.sv-room-seat { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px;
  border-radius: 10px; background: rgba(255,255,255,.06); font-size: 14px; }
.sv-room-seat.sv-room-empty { background: transparent; border: 1px dashed rgba(255,255,255,.18); opacity: .75; }
.sv-room-seat-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sv-room-you { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; }
.sv-room-tick { flex: none; width: 1.4em; text-align: center; opacity: .35; }
.sv-room-seat-ready .sv-room-tick { opacity: 1; color: #7ee08a; }
.sv-room-rtt { font-size: 10px; letter-spacing: .06em; opacity: .5; font-variant-numeric: tabular-nums; }
.sv-room-foot { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; }

/* (No backticks anywhere in this block, deliberately: it is inside a template
   literal and one would end the string, with the SyntaxError pointing at a
   comment several lines further on. The team select's stylesheet carries the
   same warning for the same reason.) */

/* Thumbs: the same rule the team select follows. The entry field and every
   button here are already 44 or over; this is the code itself, which is a
   tap target because tapping it copies. */
.sv-touch .sv-room-code { padding: 8px .22em 8px 0; }
`;

const READY_TICK = '✓';

let root = null;
let el = null;
let open = false;
let screen = PICK;
let keyHandler = null;
let unsubscribe = null;
let busy = false;
let lastSignature = '';
// A NOTICE IS NOT AN ERROR, and they cannot share a field. An error is the
// server refusing something and stays until the player does something else; a
// notice is a thing that HAPPENED — the other tab closed — which the next
// `room` message undoes by itself when they come back. Written into the same
// element, held apart here, because a peerGone stored as an error was
// unsettable by anything except another error.
let notice = '';
// THE HOST HAS GONE TO PICK THE TEAMS, and the guest has nothing to press for
// as long as that takes. Told at the moment Start is pressed rather than at the
// match start, because the gap between those two is the whole minute somebody
// spends on the colour wheel — and a screen that said nothing for a minute is
// the one a player closes.
let waiting = false;
let callbacks = { onBack: null, onHosting: null, onGuestStart: null };
const padPrev = new Map();

function build(parent) {
  installStyleBelowRoles('svRoomLobbyStyle', STYLE);
  root = document.createElement('div');
  root.className = 'sv-center sv-hidden';
  root.id = 'svRoomLobby';
  root.innerHTML = `
    <div class="sv-menu sv-room">
      <div class="sv-title"></div>
      <div class="sv-room-wrap">
        <div class="sv-room-status"></div>
        <div class="sv-room-error"></div>

        <div class="sv-room-pick sv-room-row">
          <button class="sv-btn sv-room-host" type="button"></button>
          <button class="sv-btn sv-room-join" type="button"></button>
        </div>

        <div class="sv-room-entry">
          <div class="sv-room-code-label sv-room-prompt"></div>
          <div class="sv-room-row">
            <input class="sv-room-input" type="text" maxlength="5" autocomplete="off"
                   autocapitalize="characters" spellcheck="false" inputmode="latin" />
            <button class="sv-btn sv-room-go" type="button"></button>
          </div>
        </div>

        <div class="sv-room-live">
          <div class="sv-room-code-label sv-room-codelabel"></div>
          <div class="sv-room-code"></div>
          <div class="sv-room-seats"></div>
          <div class="sv-room-rtt"></div>
        </div>
      </div>
      <div class="sv-room-foot">
        <button class="sv-btn sv-room-back" type="button"></button>
        <button class="sv-btn sv-room-ready" type="button"></button>
        <button class="sv-btn sv-room-start" type="button"></button>
      </div>
    </div>`;
  parent.appendChild(root);

  el = {
    title: root.querySelector('.sv-title'),
    status: root.querySelector('.sv-room-status'),
    error: root.querySelector('.sv-room-error'),
    pick: root.querySelector('.sv-room-pick'),
    host: root.querySelector('.sv-room-host'),
    join: root.querySelector('.sv-room-join'),
    entry: root.querySelector('.sv-room-entry'),
    prompt: root.querySelector('.sv-room-prompt'),
    input: root.querySelector('.sv-room-input'),
    go: root.querySelector('.sv-room-go'),
    live: root.querySelector('.sv-room-live'),
    codeLabel: root.querySelector('.sv-room-codelabel'),
    code: root.querySelector('.sv-room-code'),
    seats: root.querySelector('.sv-room-seats'),
    rtt: root.querySelector('.sv-room-rtt'),
    back: root.querySelector('.sv-room-back'),
    ready: root.querySelector('.sv-room-ready'),
    start: root.querySelector('.sv-room-start'),
  };

  el.title.textContent = uiText('roomTitle');
  el.host.textContent = uiText('roomHost');
  el.join.textContent = uiText('roomJoin');
  el.prompt.textContent = uiText('roomCodePrompt');
  el.go.textContent = uiText('roomCodeGo');
  el.codeLabel.textContent = uiText('roomCodeLabel');
  el.back.textContent = uiText('sealSportsBack');
  el.start.textContent = uiText('roomStart');

  el.host.addEventListener('click', () => host());
  el.join.addEventListener('click', () => { screen = CODE; render(); el.input.focus(); });
  el.go.addEventListener('click', () => joinTyped());
  el.back.addEventListener('click', () => back());
  el.ready.addEventListener('click', () => toggleReady());
  el.start.addEventListener('click', () => startMatch());

  // Upper-cased as you type, so what is on screen is what gets sent — and the
  // normaliser on the server forgives case anyway, which makes a field that
  // showed lower case a field that lied about what it was doing.
  el.input.addEventListener('input', () => {
    const at = el.input.selectionStart;
    el.input.value = el.input.value.toUpperCase();
    el.input.setSelectionRange?.(at, at);
    clearError();
  });
  el.input.addEventListener('keydown', (e) => {
    // Stopped here rather than let through: the screen's own key handler reads
    // Escape and Enter, and a code with an E in it must not leave the field.
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); joinTyped(); }
    else if (e.key === 'Escape') { e.preventDefault(); screen = PICK; render(); }
  });

  // The code is the thing the host passes on, so pressing it copies it. Best
  // effort: clipboard access is refused in plenty of contexts and a failure
  // here must not read as the room being broken.
  el.code.addEventListener('click', () => {
    navigator.clipboard?.writeText?.(roomState.code).then(() => feedback('uiClick'), () => {});
  });
}

// --- doing things ---------------------------------------------------------

function clearError() {
  if (!el) return;
  roomState.error = '';
  notice = '';
  el.error.textContent = '';
}

/** The server's error code, as the line a player reads. */
function errorText(code) {
  switch (code) {
    case 'no_room': return uiText('roomErrNoRoom');
    case 'full': return uiText('roomErrFull');
    case 'bad_code': return uiText('roomErrBadCode');
    case 'build_mismatch': return uiText('roomErrBuild');
    case 'offline': return uiText('roomErrOffline');
    default: return uiText('roomErrLost');
  }
}

async function host() {
  if (busy) return;
  busy = true;
  clearError();
  el.status.textContent = uiText('roomConnecting');
  feedback('uiClick');
  const code = await requestCode();
  busy = false;
  if (!open) return;                       // left while the request was out
  if (!code) { fail('offline'); return; }
  beginLobby('host');
  if (!joinRoom({ code, role: 'host', name: playerLabel() })) { endSession(); fail('offline'); return; }
  screen = ROOM;
  render();
}

function joinTyped() {
  if (busy) return;
  const typed = (el.input.value || '').trim().toUpperCase();
  // Checked here as well as on the server, because a code that is obviously
  // not one should say so without a round trip — and because the server's
  // answer for a malformed code is a 400 that the socket reports as a plain
  // close with nothing in it to render. Same function the server runs, so the
  // two cannot drift.
  const code = normalizeCode(typed);
  if (!code) { fail('bad_code'); return; }
  clearError();
  feedback('uiClick');
  beginLobby('guest');
  if (!joinRoom({ code, role: 'guest', name: playerLabel() })) { endSession(); fail('offline'); return; }
  screen = ROOM;
  render();
}

function fail(code) {
  roomState.error = code;
  if (el) el.error.textContent = errorText(code);
  render();
}

function toggleReady() {
  const me = mine();
  setReady(!(me?.ready));
  feedback('uiClick');
}

function startMatch() {
  if (!canStart()) return;
  feedback('uiClick');
  // Sent BEFORE the route is handed over: once onHosting fires this screen is
  // hidden, and a message posted after that is one nobody is left to send it.
  send({ t: 'lobbyPreview', picking: true });
  // PHASE 3 WIRES THIS UP. The host resolves the cast, the rules and the setup
  // and sends them, and both machines enter the same match. Today it hands
  // back to main.js, which opens the ordinary team select for the host.
  callbacks.onHosting?.();
}

function back() {
  feedback('uiClick');
  if (screen === CODE) { screen = PICK; clearError(); render(); return; }
  leaveRoom();
  endSession();
  hideRoomLobby();
  callbacks.onBack?.();
}

/**
 * What this player is called in the other person's lobby.
 *
 * Deliberately NOT systems/playerName.js's name: that is the name on the seal,
 * it is cast into the match by rosterCast, and sending it twice would let the
 * lobby and the pitch disagree about it. Phase 3 sends the whole cast in one
 * message; until then a member is identified by role and this is empty.
 */
function playerLabel() {
  return '';
}

// --- what is true right now -----------------------------------------------

function mine() {
  return roomState.members.find((m) => m.role === roomState.role) ?? null;
}

/**
 * The host may start when the room is full and both have readied.
 *
 * `present` and not merely "in the list": a member whose socket has gone is
 * still holding their seat for the grace window, and starting a match into an
 * empty seat would hand it straight to the bot.
 */
export function canStart() {
  if (roomState.role !== 'host') return false;
  if (roomState.members.length < 2) return false;
  return roomState.members.every((m) => m.present && m.ready);
}

// --- rendering ------------------------------------------------------------

function seatRow(member, empty) {
  const row = document.createElement('div');
  row.className = 'sv-room-seat' + (empty ? ' sv-room-empty' : '') + (member?.ready ? ' sv-room-seat-ready' : '');

  const tick = document.createElement('span');
  tick.className = 'sv-room-tick';
  tick.textContent = empty ? '' : READY_TICK;
  row.appendChild(tick);

  const name = document.createElement('span');
  name.className = 'sv-room-seat-name';
  // A member with no name is not nameless on screen — Phase 3 sends the cast
  // and this becomes the seal's name. Until then the empty seat's line does
  // the talking and a present member shows nothing rather than a placeholder.
  name.textContent = empty ? uiText('roomSeatEmpty') : (member.name || '');
  row.appendChild(name);

  if (!empty && member.role === roomState.role) {
    const you = document.createElement('span');
    you.className = 'sv-room-you';
    you.textContent = uiText('roomYou');
    row.appendChild(you);
  }
  return row;
}

function render() {
  if (!el) return;

  el.pick.hidden = screen !== PICK;
  el.entry.hidden = screen !== CODE;
  el.live.hidden = screen !== ROOM;

  // THE STATUS LINE, and only ever one of them. 'off' while picking is not a
  // status, it is the absence of one — a line saying "not connected" on a
  // screen with a Host button is noise.
  const s = roomState.status;
  // WAITING BEATS CONNECTING. Once the host is on the team select, what this
  // player wants to know is why nothing is happening — not that the socket,
  // which is fine, is fine.
  el.status.textContent = screen !== ROOM
    ? (busy ? uiText('roomConnecting') : '')
    : waiting ? uiText('roomWaitingHost')
    : s === 'opening' ? uiText('roomConnecting')
    : s === 'retrying' ? uiText('roomRetrying')
    : '';
  el.error.textContent = roomState.error ? errorText(roomState.error) : notice;

  if (screen === ROOM) {
    el.code.textContent = roomState.code;
    el.seats.textContent = '';
    // Always two rows, in a fixed order — me first — so the panel does not
    // jump or reorder itself the instant the other player arrives.
    const me = mine();
    const them = peer();
    el.seats.appendChild(seatRow(me, !me));
    el.seats.appendChild(seatRow(them, !them?.present));
    el.rtt.textContent = roomState.rtt ? `${roomState.rtt} ms` : '';
  }

  const me = mine();
  el.ready.hidden = screen !== ROOM || waiting;
  el.ready.textContent = me?.ready ? uiText('roomUnready') : uiText('roomReady');
  // THE GUEST NEVER SEES START — the host picks the teams for both, so a
  // second Start would be a button that could not do anything.
  el.start.hidden = screen !== ROOM || roomState.role !== 'host';
  el.start.disabled = !canStart();
}

// --- input ----------------------------------------------------------------

function onKey(e) {
  if (!open) return;
  // The code field handles its own keys and stops them; anything reaching here
  // is the screen's.
  switch (e.key) {
    case 'Escape': case 'Backspace': e.preventDefault(); back(); return;
    case 'Enter': case ' ':
      if (screen === PICK) { e.preventDefault(); host(); }
      else if (screen === ROOM && canStart()) { e.preventDefault(); startMatch(); }
      return;
    default:
  }
}

/**
 * Once a frame while the screen is up, beside the other menu polls.
 *
 * `list` is passed IN rather than read from navigator here — the same contract
 * updateTeamSelect has, and the reason the harness can drive this with a plain
 * array instead of patching a global.
 */
export function updateRoomLobby(list = null) {
  if (!open) return;
  for (const p of pollPads(padPrev, list)) {
    const press = p.press;
    if (press.b) { back(); return; }
    if (press.a) {
      if (screen === PICK) host();
      else if (screen === ROOM) toggleReady();
      return;
    }
    if (press.start && canStart()) { startMatch(); return; }
  }
  // REPAINTED ON THE FRAME, not only when a message lands. Half of what this
  // screen shows never arrives as a message at all: `status` goes to 'retrying'
  // from the socket's own onclose, and the round trip moves on the wire's
  // clock. Rendering only on receipt left both of them frozen at whatever they
  // were when the last frame came in — which is exactly the moment a player is
  // staring at the screen wondering what is happening.
  //
  // Compared rather than rendered blindly: the seat rows are rebuilt each time,
  // and doing that sixty times a second would throw away the text selection on
  // the code every frame.
  const sig = signature();
  if (sig !== lastSignature) { lastSignature = sig; render(); }
  if (screen === ROOM && el) el.rtt.textContent = roomState.rtt ? `${roomState.rtt} ms` : '';
}

/** Everything this screen draws, as one string to compare against last frame. */
function signature() {
  return [
    screen, busy, waiting, notice, roomState.status, roomState.code, roomState.role, roomState.error,
    roomState.members.map((m) => `${m.role}:${m.name}:${m.ready ? 1 : 0}:${m.present ? 1 : 0}`).join('|'),
  ].join('~');
}

// --- lifecycle ------------------------------------------------------------

/**
 * Open the screen over `parent`.
 *
 * WHETHER ONLINE PLAY EXISTS IS THE ROUTE'S QUESTION, not this screen's — the
 * Seal sports list does not draw the row that leads here without a room server
 * (see roomsAvailable in ui.js), and a screen that refused to open would be a
 * second place for that rule to live and drift.
 */
export function showRoomLobby({ parent = document.body, onBack, onHosting, onGuestStart } = {}) {
  if (!root) build(parent);
  callbacks = { onBack, onHosting, onGuestStart };
  screen = PICK;
  busy = false;
  waiting = false;
  lastSignature = '';
  padPrev.clear();
  clearError();
  open = true;
  root.classList.remove('sv-hidden');

  if (!keyHandler) {
    keyHandler = onKey;
    window.addEventListener('keydown', keyHandler, true);
  }
  if (!unsubscribe) unsubscribe = onRoomMessage(onMessage);
  render();
}

function onMessage(msg, binary) {
  if (binary || !open) return;
  switch (msg.t) {
    case 'room':
      // They came back: the notice about them leaving is over. Cleared here
      // rather than on a timer, because the thing it described has ended.
      if (roomState.members.length >= 2 && roomState.members.every((m) => m.present)) notice = '';
      render();
      break;
    case 'error':
      fail(msg.code);
      break;
    case 'peerGone':
      // Not an error — in a lobby the other tab closing is a thing that gets
      // undone by them opening it again, and the room is still ours.
      notice = uiText('roomPeerLeft');
      render();
      break;
    case 'lobbyPreview':
      waiting = !!msg.picking;
      render();
      break;
    case 'start':
      // The host has started. Phase 3 applies the payload; today this is what
      // takes the guest out of the lobby.
      callbacks.onGuestStart?.(msg.match);
      break;
    default:
      render();
  }
}

export function hideRoomLobby() {
  open = false;
  root?.classList.add('sv-hidden');
  if (keyHandler) {
    window.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

export function roomLobbyOpen() { return open; }

/**
 * Jump straight to the in-room half of the screen.
 *
 * For the layout audit, which measures a surface in its FULLEST state and has
 * no server to join: the pick screen is two buttons and could never overflow
 * anything, so what wants measuring is the room — two player rows, the code at
 * its largest, and the round trip. It renders whatever is in `roomState`,
 * which is the same object a real room fills in.
 */
export function showRoomLobbyRoom() {
  screen = ROOM;
  lastSignature = '';
  render();
}

/** For tests: what the screen believes, without reaching into the DOM. */
export function roomLobbyState() {
  return {
    screen,
    open,
    status: roomState.status,
    code: roomState.code,
    role: roomState.role,
    error: roomState.error,
    waiting,
    members: roomState.members.map((m) => ({ ...m })),
    canStart: canStart(),
    sessionPhase: session.phase,
  };
}
