#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE BLUBBERBALL TEAM SELECT, headless. ui/teamSelect.js is a DOM screen
// driven by every pad at once plus the keyboard, and what it writes is
// versusSetup — which input.js, p2Pad and the bot then read. All of that is
// measurable in jsdom with fake Gamepad lists handed to updateTeamSelect.
//
//   JOINING       push right on a pad and its chip is on the right; a second
//                 pad cannot take a side that has a captain.
//   THE KEYBOARD  is left-only, because input.js is player 1's.
//   COLOURS       the captains step round the wheel, and can never land on
//                 the same swatch.
//   START         only when every side with a person is ready; an empty side
//                 is the CPU; the setup written is what the match reads.
//   THE MATCH     p2Pad and player 1's pad pick follow the setup, not the
//                 by-index rule, and a CPU side is the bot.
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

await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const ts = await import('../path/src/ui/teamSelect.js');
const flag = await import('../path/src/systems/versusFlag.js');
const { p2Pad } = await import('../path/src/systems/versus.js');
const { botWanted } = await import('../path/src/systems/versusBot.js');
const { teamColor } = await import('../path/src/systems/ballLook.js');
const { pollPads } = await import('../path/src/ui/padPoll.js');

// A fake pad in navigator.getGamepads() shape. `press` names buttons held
// this frame; `x`/`y` the left stick.
function pad(index, { a = false, b = false, start = false, x = 0, y = 0, dpad = null } = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  if (a) buttons[0] = { pressed: true, value: 1 };
  if (b) buttons[1] = { pressed: true, value: 1 };
  if (start) buttons[9] = { pressed: true, value: 1 };
  if (dpad === 'left') buttons[14] = { pressed: true, value: 1 };
  if (dpad === 'right') buttons[15] = { pressed: true, value: 1 };
  if (dpad === 'up') buttons[12] = { pressed: true, value: 1 };
  if (dpad === 'down') buttons[13] = { pressed: true, value: 1 };
  return { index, connected: true, id: `pad ${index}`, mapping: 'standard', axes: [x, y, 0, 0], buttons };
}
// A press is a frame down and a frame up, so the next one is a fresh edge.
function tap(list) { ts.updateTeamSelect(list); ts.updateTeamSelect(list.map((p) => pad(p.index))); }
function key(k) { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }
const devs = () => ts.teamSelectState().devices;
const dev = (key) => devs().find((d) => d.key === key);

// ---------------------------------------------------------------------------
section('The poll turns held buttons into presses, once');
{
  const prev = new Map();
  let r = pollPads(prev, [pad(0, { a: true, x: 0.9 })]);
  check('a held A is a press on the first frame', r[0].press.a && r[0].press.right);
  r = pollPads(prev, [pad(0, { a: true, x: 0.9 })]);
  check('...and not on the second', !r[0].press.a && !r[0].press.right);
  r = pollPads(prev, [pad(0, { x: 0.45 })]);
  check('the stick eased back inside the band is still held, not re-pressed', !r[0].press.right);
  r = pollPads(prev, [pad(0, { x: 0.9 })]);
  check('...so pushing it again is not a new press either', !r[0].press.right);
  r = pollPads(prev, [pad(0)]);
  r = pollPads(prev, [pad(0, { x: 0.9 })]);
  check('but released and pushed is', r[0].press.right);
  pollPads(prev, []);
  check('a pad that has gone is dropped from the memory', prev.size === 0);
}

// ---------------------------------------------------------------------------
section('Opening: the keyboard is in the pool, the sides are the CPU\'s, Start is dead');
let started = null; let backs = 0;
const open = () => ts.showTeamSelect({ parent: document.body, onStart: (s) => { started = s; }, onBack: () => { backs++; } });
open();
const root = document.getElementById('svTeamSelect');
check('the screen is mounted and shown', !!root && !root.classList.contains('sv-hidden'));
check('the keyboard is the only device, in the pool', devs().length === 1 && dev('keyboard')?.side === -1);
check('both columns read as the CPU\'s', root.querySelectorAll('.sv-teams-side.sv-teams-cpu').length === 2);
check('Start is disabled with nobody on a side', root.querySelector('#svTeamStart').disabled);
check('each column draws four slots, three of them locked',
  [...root.querySelectorAll('.sv-teams-side')].every((n) => n.querySelectorAll('.sv-teams-slot').length === flag.MAX_PER_SIDE && n.querySelectorAll('.sv-teams-locked').length === flag.MAX_PER_SIDE - 1));
check('the two default picks differ', ts.teamSelectState().picks[0] !== ts.teamSelectState().picks[1]);
check('no id shows through as a label',
  ![...root.querySelectorAll('.sv-title, .sv-btn, .sv-teams-chip')].some((n) => /^(team|sport|sealSports)/.test(n.textContent.trim())));

// ---------------------------------------------------------------------------
section('A pad arrives on its first press, and that press is spent');
tap([pad(0, { dpad: 'right' })]);
check('pad 1 is now a device in the pool', dev('pad0')?.side === -1, JSON.stringify(dev('pad0')));
tap([pad(0, { dpad: 'right' })]);
check('the next push right walks it onto the right side', dev('pad0')?.side === 1);
check('the right column is no longer the CPU\'s', !root.querySelectorAll('.sv-teams-side')[1].classList.contains('sv-teams-cpu'));

// ---------------------------------------------------------------------------
section('One captain a side, and the keyboard stays left');
tap([pad(0), pad(1, { dpad: 'right' })]);           // pad 2 arrives
tap([pad(0), pad(1, { dpad: 'right' })]);           // and pushes right
check('a second pad cannot take a side with a captain', dev('pad1')?.side === -1);
key('ArrowRight');
check('the keyboard refuses the right side', dev('keyboard')?.side === -1);
key('ArrowLeft');
check('...and takes the left', dev('keyboard')?.side === 0);
tap([pad(0), pad(1, { dpad: 'left' })]);
check('so pad 2 cannot have the left either', dev('pad1')?.side === -1);
check('Start is still dead: nobody is ready', root.querySelector('#svTeamStart').disabled);

// ---------------------------------------------------------------------------
section('Captains pick colours, and never the same one');
{
  const before = ts.teamSelectState().picks;
  tap([pad(0, { dpad: 'down' }), pad(1)]);
  const after = ts.teamSelectState().picks;
  check('down steps the right captain\'s colour', after[1] !== before[1] && after[0] === before[0], `${before} -> ${after}`);
  // Walk the left captain all the way round: it must skip the right's pick.
  const n = CONFIG.versus.palette.length;
  const landed = new Set();
  for (let i = 0; i < n + 1; i++) { key('ArrowUp'); landed.add(ts.teamSelectState().picks[0]); }
  check('the left captain visits every swatch but the right\'s', landed.size === n - 1 && !landed.has(ts.teamSelectState().picks[1]), `${[...landed].sort((p, q) => p - q)}`);
  const takenSwatch = root.querySelectorAll('.sv-teams-side')[0].querySelector('.sv-teams-swatch.sv-teams-taken');
  check('the other side\'s pick is drawn dimmed on this wheel', !!takenSwatch && Number(takenSwatch.dataset.i) === ts.teamSelectState().picks[1]);
}

// ---------------------------------------------------------------------------
section('Ready, then Start');
key('Enter');
check('Enter readies the keyboard captain', dev('keyboard')?.ready === true);
check('...stamped on the chip', !!root.querySelector('.sv-teams-side[data-side="0"] .sv-teams-stamp'));
key('ArrowUp');
const pickHeld = ts.teamSelectState().picks[0];
key('ArrowUp');
check('a ready captain cannot change colour', ts.teamSelectState().picks[0] === pickHeld);
check('Start is dead while the right captain is not ready', root.querySelector('#svTeamStart').disabled);
tap([pad(0, { start: true }), pad(1)]);
check('...and Start on a pad does nothing then', started === null);
tap([pad(0, { a: true }), pad(1)]);
check('A readies the right captain', dev('pad0')?.ready === true);
check('now Start is live', !root.querySelector('#svTeamStart').disabled);
tap([pad(0), pad(1, { start: true })]);
check('Start on ANY pad starts it', !!started);
check('the screen closed itself', root.classList.contains('sv-hidden'));

// ---------------------------------------------------------------------------
section('What was written is what the match reads');
{
  const t = flag.versusSetup.teams;
  check('left is the keyboard, human', t[0].members[0]?.kind === 'human' && t[0].members[0]?.pad === flag.KEYBOARD);
  check('right is pad 1 (index 0), human', t[1].members[0]?.kind === 'human' && t[1].members[0]?.pad === 0);
  check('the colours are the picks, off the wheel', t[0].color === CONFIG.versus.palette[ts.teamSelectState().picks[0]] && t[1].color === CONFIG.versus.palette[ts.teamSelectState().picks[1]]);
  check('teamColor reads the pick over CONFIG', teamColor(0) === t[0].color && teamColor(1) === t[1].color && teamColor(0) !== CONFIG.versus.teams[0].color);
  check('captainPad: left is the keyboard (no pad), right is pad 0', flag.captainPad(0) === null && flag.captainPad(1) === 0);
  // p2Pad follows the setup, NOT "second by index": with pads 0 and 3
  // connected the old rule would hand player 2 pad 3.
  const list = [pad(0), null, null, pad(3)];
  check('p2Pad is the right captain\'s pad, whatever the index order', p2Pad(list)?.index === 0);
  check('...and nothing if that pad has gone', p2Pad([pad(3)]) === null);
  check('a human on the right is not the bot', botWanted(true) === false);
}

// ---------------------------------------------------------------------------
section('An empty side is the CPU, and one person is enough');
started = null;
open();
key('ArrowLeft');
key('Enter');
check('keyboard on the left, ready, nobody on the right: Start is live', !root.querySelector('#svTeamStart').disabled);
root.querySelector('#svTeamStart').click();
check('Start starts it', !!started);
check('the right captain is the CPU', flag.captainIsCpu(1) && flag.captainPad(1) === null);
check('...so the bot wants the side, pad or no pad', botWanted(true) === true && botWanted(false) === true);
check('and p2Pad hands it no pad even with two plugged in', p2Pad([pad(0), pad(1)]) === null);

// ---------------------------------------------------------------------------
section('Back, B and unplugging');
open();
tap([pad(0, { dpad: 'right' })]);
tap([pad(0, { dpad: 'right' })]);
tap([pad(0, { a: true })]);
check('pad 1 is ready on the right', dev('pad0')?.side === 1 && dev('pad0')?.ready);
tap([pad(0, { b: true })]);
check('B un-readies', dev('pad0')?.ready === false && dev('pad0')?.side === 1);
tap([pad(0, { b: true })]);
check('B again walks back to the pool', dev('pad0')?.side === -1);
ts.updateTeamSelect([]);
check('an unplugged pad leaves the screen', !dev('pad0'));
key('Escape');
check('Escape from the pool is Back', backs === 1 && root.classList.contains('sv-hidden'));
check('...and nothing was started by it', flag.versusSetup.teams[0].members.length === 1); // still the last write
ts.hideTeamSelect();
check('a closed screen ignores the keyboard', (key('ArrowLeft'), true));
flag.resetVersusSetup();
check('resetVersusSetup empties both sides', flag.versusSetup.teams.every((t) => t.members.length === 0 && t.color === null) && flag.captainPad(0) === undefined);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
