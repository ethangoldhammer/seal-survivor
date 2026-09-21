#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:roomlobby
//
// The Blubberball room screen (ui/roomLobby.js): hosting, typing a code,
// what the two seats say, and who is allowed to press Start. Every one of
// these is a case that goes wrong QUIETLY — a lobby that never repaints a
// dropped connection, a guest handed a Start button that cannot start
// anything, a keydown listener left on the window after the screen closes and
// eating Escape for the rest of the session.
//
// It drives the REAL client with a fake WebSocket and a fake fetch rather than
// with an injected seam, so what runs here is the code that ships: the socket
// opens, the server's messages arrive as messages, and the screen reacts to
// them the way it will in a browser.
//
// jsdom first, then the loader — see the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

// ---------------------------------------------------------------------------
// THE FAKE WIRE. jsdom ships no WebSocket, so the global is ours to define and
// the client's own open/close/message path runs unmodified against it.
// ---------------------------------------------------------------------------
const sockets = [];
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.binaryType = '';
    sockets.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({}); }
  // What the server would do.
  accept() { this.readyState = 1; this.onopen?.({}); }
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeSocket;

let nextCode = 'ABCDE';
let fetchFails = false;
globalThis.fetch = async (url, opts) => {
  if (fetchFails) throw new Error('offline');
  if (String(url).endsWith('/new') && opts?.method === 'POST') {
    return { ok: true, json: async () => ({ code: nextCode }) };
  }
  return { ok: false, json: async () => ({}) };
};

await import('./vite-loader.mjs');
const room = await import('../path/src/systems/online/room.js');
const session = await import('../path/src/systems/online/session.js');
const lobby = await import('../path/src/ui/roomLobby.js');
const { uiText } = await import('../path/src/uiTextTable.js');
const { ALPHABET } = await import('../path/src/systems/online/protocol.js');

// A harness has no Vite and so no import.meta.env — this is the same door a
// developer uses to point a build at `npx wrangler dev`.
room.setRoomUrl('https://rooms.example.test');

const q = (sel) => document.querySelector(sel);
const st = () => lobby.roomLobbyState();
const live = () => sockets.at(-1);
const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const settle = () => new Promise((r) => setTimeout(r, 0));

function pad(index, { a = false, b = false, start = false } = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  if (a) buttons[0] = { pressed: true, value: 1 };
  if (b) buttons[1] = { pressed: true, value: 1 };
  if (start) buttons[9] = { pressed: true, value: 1 };
  return { index, connected: true, id: `pad ${index}`, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
}
// A press is a frame down and a frame up, so the next one is a fresh edge.
const tap = (list) => { lobby.updateRoomLobby(list); lobby.updateRoomLobby(list.map((p) => pad(p.index))); };

/** Open the screen fresh, with the callbacks counted. */
function fresh() {
  const calls = { back: 0, hosting: 0, guestStart: 0, bothHere: 0 };
  room.leaveRoom();
  session.endSession();
  sockets.length = 0;
  lobby.showRoomLobby({
    parent: document.body,
    onBack: () => { calls.back += 1; },
    onHosting: () => { calls.hosting += 1; },
    onGuestStart: () => { calls.guestStart += 1; },
    onBothHere: () => { calls.bothHere += 1; },
  });
  return calls;
}

// ---------------------------------------------------------------------------
section('opening — the screen a player lands on');

{
  fresh();
  check('it opens on the pick screen', st().screen === 'pick' && st().open === true, st().screen);
  check('the pick row is showing, the others are not',
    q('.sv-room-pick').hidden === false && q('.sv-room-entry').hidden === true && q('.sv-room-live').hidden === true);
  check('nothing is claimed about a session yet', st().sessionPhase === 'off', st().sessionPhase);
  // The screen is built once and only hidden, so a second open must not stack.
  lobby.hideRoomLobby();
  fresh();
  check('opening twice builds one screen', document.querySelectorAll('#svRoomLobby').length === 1);
}

// ---------------------------------------------------------------------------
section('typing a code');

{
  fresh();
  q('.sv-room-join').click();
  check('Join shows the code field', st().screen === 'code' && q('.sv-room-entry').hidden === false);

  // The same normaliser the server runs, so the two cannot disagree about
  // which letters exist — see normalizeCode in online/protocol.js.
  q('.sv-room-input').value = 'ab-cd';           // four letters, separated
  q('.sv-room-go').click();
  check('too short is refused without a socket', st().error === 'bad_code' && sockets.length === 0, st().error);
  check('...and the field is not cleared out from under them',
    q('.sv-room-input').value === 'ab-cd', q('.sv-room-input').value);

  q('.sv-room-input').value = 'abode';           // contains an O
  q('.sv-room-go').click();
  check('a letter a code never contains is refused', st().error === 'bad_code' && sockets.length === 0);
  check('and O really is not in the alphabet', !ALPHABET.includes('O') && !ALPHABET.includes('I') && !ALPHABET.includes('L'));

  q('.sv-room-input').value = ' ab-cde ';        // lower case, spaced, hyphenated
  q('.sv-room-go').click();
  check('a code read out loud is forgiven its punctuation',
    st().screen === 'room' && st().code === 'ABCDE', `${st().screen} / ${st().code}`);
  check('the socket asked for the guest role', /role=guest/.test(live()?.url ?? ''), live()?.url);
  check('...and carried a build to be matched against', /build=/.test(live()?.url ?? ''));
  check('the session knows which end it is', st().sessionPhase === 'lobby' && session.netIsGuest() === true);
}

// ---------------------------------------------------------------------------
section('hosting');

{
  const calls = fresh();
  nextCode = 'QRSTV';
  q('.sv-room-host').click();
  await settle();
  check('hosting asks the server for a code and shows it', st().code === 'QRSTV' && st().screen === 'room', st().code);
  check('the code is on screen for reading out', q('.sv-room-code').textContent === 'QRSTV');
  check('the socket asked for the host role', /role=host/.test(live()?.url ?? ''));
  check('this end is the host', session.netIsHost() === true && session.netIsGuest() === false);

  // Nobody has joined: one real row and one empty one, always both, so the
  // panel does not jump the moment the other player arrives.
  live().accept();
  live().deliver({ t: 'room', code: 'QRSTV', you: 'host', members: [{ role: 'host', name: '', ready: false, present: true }] });
  const seats = [...document.querySelectorAll('.sv-room-seat')];
  check('there are always two seat rows', seats.length === 2, String(seats.length));
  check('the second one reads as empty', seats[1].classList.contains('sv-room-empty'));
  check('...and says so in Ethan’s words', seats[1].textContent.includes(uiText('roomSeatEmpty')));
  // A PRESENT MEMBER IS NEVER A BLANK STRIP. This is the shape of a real bug:
  // playerLabel() returned '' for both members, so an occupied seat rendered
  // with no text at all and was indistinguishable from the open one below it —
  // two identical blank rows, on the one screen whose entire job is to answer
  // whether the other person has arrived. Both people concluded, reasonably,
  // that the room had failed. The row is allowed to be wrong about the name;
  // it is not allowed to be empty.
  check('an occupied seat is not blank', seats[0].textContent.trim().length > 0, JSON.stringify(seats[0].textContent));
  check('...and does not read as the open seat', !seats[0].textContent.includes(uiText('roomSeatEmpty')));
  check('the host cannot start alone', st().canStart === false);
  // NEITHER BUTTON IS ON THIS SCREEN ANY MORE. Readying up and starting both
  // moved to the team select, which already did them for any number of people
  // — this screen was reimplementing a worse copy one room-code later. What is
  // left here is the code and the two seats, and nothing you can press to
  // commit to a match you have not been shown yet.
  check('no Start on the room screen', q('.sv-room-start').hidden === true);
  check('no Ready either', q('.sv-room-ready').hidden === true);
  check('onHosting has not fired', calls.hosting === 0);
}

// ---------------------------------------------------------------------------
section('a full room, and who may start it');

function fullRoom({ you = 'host', hostReady = true, guestReady = true, guestPresent = true } = {}) {
  const calls = fresh();
  nextCode = 'MNPQR';
  if (you === 'host') q('.sv-room-host').click();
  else { q('.sv-room-join').click(); q('.sv-room-input').value = 'MNPQR'; q('.sv-room-go').click(); }
  return { calls, ready: async () => {
    await settle();
    live().accept();
    live().deliver({ t: 'room', code: 'MNPQR', you, members: [
      { role: 'host', name: 'Ethan', ready: hostReady, present: true },
      { role: 'guest', name: 'Pal', ready: guestReady, present: guestPresent },
    ] });
  } };
}

{
  const { calls, ready } = fullRoom();
  await ready();
  check('both seats are drawn', document.querySelectorAll('.sv-room-seat').length === 2);
  check('neither is empty', document.querySelectorAll('.sv-room-seat.sv-room-empty').length === 0);
  check('a ready member is marked ready', document.querySelectorAll('.sv-room-seat-ready').length === 2);
  // The names that came down the wire are the names on screen — the check that
  // would have caught the blank-strip bug at the other end, where the name is
  // present rather than missing.
  const named = [...document.querySelectorAll('.sv-room-seat-name')].map((n) => n.textContent);
  check('each seat shows the name the room sent', named.includes('Ethan') && named.includes('Pal'), named.join(' / '));
  check('the room still knows both are ready', st().canStart === true);
  // A FULL ROOM LEAVES THIS SCREEN BY ITSELF, on both ends at once, with
  // nobody pressing anything — that is the handover the merge is built on.
  check('a full room hands over to the team select', calls.bothHere >= 1,
    String(calls.bothHere));
}

{
  // A seat whose socket has gone is still HELD for the grace window, and
  // starting into it would hand the seal straight to the bot.
  const { ready } = fullRoom({ guestPresent: false });
  await ready();
  check('a member holding a seat but not present blocks Start', st().canStart === false);
  check('and their row draws as empty', document.querySelectorAll('.sv-room-seat.sv-room-empty').length === 1);
}

{
  const { ready } = fullRoom({ guestReady: false });
  await ready();
  check('one player not ready blocks Start', st().canStart === false);
}

{
  // The host picks the teams for both, so a Start on the guest could not do
  // anything — it must not be there to press.
  const { calls, ready } = fullRoom({ you: 'guest' });
  await ready();
  check('the guest is never shown Start', q('.sv-room-start').hidden === true);
  check('...and canStart refuses it even so', st().canStart === false);
  key('Enter');
  check('nor can the guest start with the keyboard', calls.hosting === 0);
  tap([pad(0, { start: true })]);
  check('nor with a pad', calls.hosting === 0);
}

// ---------------------------------------------------------------------------
section('what the server says');

{
  const { ready } = fullRoom({ you: 'guest' });
  await ready();

  live().deliver({ t: 'peerGone', role: 'host', graceMs: 0 });
  check('a peer leaving says so', q('.sv-room-error').textContent === uiText('roomPeerLeft'));

  live().deliver({ t: 'error', code: 'no_room' });
  check('no_room renders its own line', q('.sv-room-error').textContent === uiText('roomErrNoRoom'));
  live().deliver({ t: 'error', code: 'full' });
  check('full renders its own line', q('.sv-room-error').textContent === uiText('roomErrFull'));
  live().deliver({ t: 'error', code: 'build_mismatch' });
  check('a stale build renders its own line', q('.sv-room-error').textContent === uiText('roomErrBuild'));
  // An unknown code must still say SOMETHING — a blank row reads as nothing
  // being wrong, on a screen where something is.
  live().deliver({ t: 'error', code: 'something-new' });
  check('an unknown error still renders a line', q('.sv-room-error').textContent === uiText('roomErrLost'));
}

{
  // The host presses Start and then spends a minute on the colour wheel. The
  // gap between those two is the whole reason this message exists.
  const { calls, ready } = fullRoom({ you: 'guest' });
  await ready();
  live().deliver({ t: 'lobbyPreview', picking: true });
  check('the guest is told the host has gone to pick', st().waiting === true);
  check('...in Ethan’s words, over the connection status',
    q('.sv-room-status').textContent === uiText('roomWaitingHost'), q('.sv-room-status').textContent);
  check('and Ready is taken away, since it can no longer mean anything',
    q('.sv-room-ready').hidden === true,
    `hidden=${q('.sv-room-ready').hidden}`);

  live().deliver({ t: 'start', match: { seed: 1 } });
  check('the guest is taken out of the lobby by the start', calls.guestStart === 1);
}

{
  // THE HANDOVER IS SYMMETRIC. It fires off the `room` message on whichever
  // end sees the second member arrive — so a GUEST leaves this screen by the
  // same route the host does, with nobody pressing anything. That symmetry is
  // the merge: there is one screen left that both people are on at once.
  const { calls, ready } = fullRoom({ you: 'guest' });
  await ready();
  check('a guest is handed over by a full room too, not by a button',
    calls.bothHere >= 1, String(calls.bothHere));
}

{
  // Half of what this screen shows never arrives as a message: `status` is set
  // by the socket's own onclose. Rendering only on receipt froze it.
  const { ready } = fullRoom();
  await ready();
  live().close();
  lobby.updateRoomLobby();
  check('a dropped wire repaints the status line',
    q('.sv-room-status').textContent === uiText('roomRetrying'), JSON.stringify(q('.sv-room-status').textContent));
}

// ---------------------------------------------------------------------------
section('no backend, and going back');

{
  const calls = fresh();
  fetchFails = true;
  q('.sv-room-host').click();
  await settle();
  fetchFails = false;
  check('a room server that cannot be reached says so, on the pick screen',
    st().error === 'offline' && st().screen === 'pick', `${st().error} / ${st().screen}`);
  check('...and no session is left claimed', st().sessionPhase === 'off');
  check('the line is Ethan’s', q('.sv-room-error').textContent === uiText('roomErrOffline'));
  check('nothing was opened', sockets.length === 0);
  void calls;
}

{
  const calls = fresh();
  q('.sv-room-join').click();
  key('Escape');
  check('Escape from the code field goes back one screen, not out', st().screen === 'pick' && calls.back === 0);
  key('Escape');
  check('Escape from the pick screen leaves', calls.back === 1 && st().open === false);
  check('and the session is given up with it', st().sessionPhase === 'off');
}

{
  const calls = fresh();
  tap([pad(0, { b: true })]);
  check('a pad’s B leaves too', calls.back === 1);
}

{
  const calls = fresh();
  tap([pad(0, { a: true })]);
  await settle();
  check('a pad’s A hosts', st().screen === 'room' && sockets.length === 1);
  void calls;
}

// ---------------------------------------------------------------------------
section('closing up');

{
  const calls = fresh();
  lobby.hideRoomLobby();
  check('the screen reports closed', lobby.roomLobbyOpen() === false);
  // A listener left on the window eats Escape for the rest of the session —
  // the same trap isTypingTarget hit on the slider rows.
  key('Escape');
  check('the keydown listener came off the window with it', calls.back === 0);
  lobby.updateRoomLobby([pad(0, { a: true })]);
  check('and the frame poll is a no-op while closed', sockets.length === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
