// ---------------------------------------------------------------------------
// THE BLUBBERBALL TEAM SELECT — a controller select the way a fighting game
// does it. Every controller in the room (and the keyboard) is a chip in the
// middle; push LEFT or RIGHT and your chip walks onto that side; A readies
// you, B walks you back; the first onto a side is its CAPTAIN and picks the
// team's colour off the wheel with UP and DOWN; Start starts it once both
// sides have a ready captain. A side nobody joins is the computer's.
//
// WHAT IT WRITES is versusSetup in systems/versusFlag.js — the sides, the
// devices, the colours — and nothing else: no CONFIG (the tuner would ship a
// pick as a default, see the note there) and no run. `onStart` is main.js's
// (`enterMode(true)`), which switches the mode and builds the match, and
// `onBack` reopens the Seal sports list.
//
// FOUR A SIDE IS THE SHAPE, ONE A SIDE IS THE GAME. Each column draws a
// captain's slot and three more under it, because a four-a-side match is
// where this is going and the screen should already be the right shape — but
// the three are locked: player 1 is `player` and player 2 is versus.js's one
// second body, and until there are four of each there is nothing for a third
// chip to drive. MAX_PER_SIDE is the number the lock will come off to. A
// second controller pushing onto a side that has a captain simply stays where
// it is.
//
// THE KEYBOARD IS LEFT-ONLY. input.js is player 1's, and player 1 is the
// left goal; the keyboard cannot be handed to the second body without
// input.js growing a second reader. So the keyboard chip refuses RIGHT, and
// the hint says nothing about it because it is the only device that does.
//
// PADS APPEAR WHEN TOUCHED. The browser does not expose a controller until a
// button on it is pressed, so the middle of the screen starts with only the
// keyboard chip and a line asking for a press (teamNoPads); each pad joins
// the pool on its first press and the press itself is spent on arriving.
//
// COPY: every word is a row of uiText.csv. The hint, the locked slots, the
// no-pads line and the prompt heading are lorem until Ethan writes them; the
// device names and the buttons are [DRAFT]; Blubberball and Rematch are his.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { uiText } from '../uiTextTable.js';
import { feedback } from '../systems/feedback.js';
import { versusSetup, resetVersusSetup, KEYBOARD, MAX_PER_SIDE } from '../systems/versusFlag.js';
import { pollPads } from './padPoll.js';

const POOL = -1;

let root = null;
let el = null;
let open = false;
let callbacks = { onStart: null, onBack: null };
// key → { key, kind: 'keyboard' | 'pad', index, side, ready }
const devices = new Map();
const padPrev = new Map();
// The wheel index each side has picked. Seeded from CONFIG.versus.teams by
// hue when the screen opens, so the shipped green/red is what you get by
// pressing nothing.
const picks = [0, 6];
let keyHandler = null;

const STYLE = `
.sv-teams { display: flex; flex-direction: column; align-items: center; gap: 14px; min-width: min(92vw, 720px); }
.sv-teams-hint { font-size: 12px; opacity: .6; letter-spacing: .04em; }
.sv-teams-board { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; width: 100%; align-items: start; }
.sv-teams-side { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 10px 14px; border-radius: 12px; border: 2px solid var(--team, rgba(255,255,255,.14)); background: rgba(255,255,255,.03); min-height: 220px; cursor: pointer; }
.sv-teams-side.sv-teams-cpu { border-style: dashed; }
.sv-teams-slots { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.sv-teams-slot { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 34px; border-radius: 8px; background: rgba(255,255,255,.05); font-size: 13px; }
.sv-teams-slot.sv-teams-captain { min-height: 44px; font-size: 15px; font-weight: 600; background: rgba(255,255,255,.09); }
.sv-teams-slot.sv-teams-locked { opacity: .35; font-size: 11px; letter-spacing: .06em; border: 1px dashed rgba(255,255,255,.18); background: transparent; }
.sv-teams-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,.12); border: 2px solid transparent; font-size: 13px; font-weight: 600; white-space: nowrap; }
.sv-teams-chip.sv-teams-ready { border-color: var(--team, #fff); }
.sv-teams-stamp { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--team, #fff); }
.sv-teams-pool { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-width: 150px; min-height: 220px; }
.sv-teams-nopads { font-size: 11px; opacity: .55; max-width: 150px; text-align: center; line-height: 1.4; }
.sv-teams-wheel { position: relative; width: 96px; height: 96px; margin-top: 4px; }
.sv-teams-swatch { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; transition: transform .12s; }
.sv-teams-swatch.sv-teams-picked { transform: scale(1.5); border-color: #fff; box-shadow: 0 0 10px currentColor; }
.sv-teams-swatch.sv-teams-taken { opacity: .25; cursor: default; }
.sv-teams-foot { display: flex; gap: 12px; margin-top: 4px; }
`;

function cssColor(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

function palette() {
  const p = CONFIG.versus?.palette;
  return Array.isArray(p) && p.length >= 2 ? p : [0x3ddc63, 0xff4d4d];
}

/** Hue in degrees of a 0xRRGGBB colour, for matching a default to the wheel. */
function hueOf(n) {
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (d < 1e-6) return -1;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** The wheel index nearest a colour by hue; greys go to the last swatch. */
export function nearestSwatch(color, wheel = palette()) {
  const h = hueOf(color);
  if (h < 0) return wheel.length - 1;
  let best = 0; let bestD = Infinity;
  wheel.forEach((c, i) => {
    const hc = hueOf(c);
    if (hc < 0) return;
    const d = Math.min(Math.abs(hc - h), 360 - Math.abs(hc - h));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function build(parent) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.className = 'sv-center sv-hidden';
  root.id = 'svTeamSelect';
  root.innerHTML = `
    <div class="sv-menu sv-teams">
      <div class="sv-title"></div>
      <div class="sv-teams-hint"></div>
      <div class="sv-teams-board">
        <div class="sv-teams-side" data-side="0"></div>
        <div class="sv-teams-pool"></div>
        <div class="sv-teams-side" data-side="1"></div>
      </div>
      <div class="sv-teams-foot">
        <button class="sv-btn" id="svTeamBack" type="button"></button>
        <button class="sv-btn" id="svTeamStart" type="button"></button>
      </div>
    </div>`;
  parent.appendChild(root);
  el = {
    title: root.querySelector('.sv-title'),
    hint: root.querySelector('.sv-teams-hint'),
    sides: [...root.querySelectorAll('.sv-teams-side')],
    pool: root.querySelector('.sv-teams-pool'),
    back: root.querySelector('#svTeamBack'),
    start: root.querySelector('#svTeamStart'),
  };
  el.title.textContent = uiText('sportBall');
  el.hint.textContent = uiText('teamSelectHint');
  el.back.textContent = uiText('sealSportsBack');
  el.start.textContent = uiText('teamStart');
  el.back.addEventListener('click', () => leave());
  el.start.addEventListener('click', () => tryStart());
  // A click on a column is the keyboard-and-mouse player joining it — the
  // one device with no d-pad. It walks the keyboard chip there (left only,
  // see the header), or readies it if it is already there.
  el.sides.forEach((node, side) => node.addEventListener('click', (e) => {
    if (e.target.closest('.sv-teams-swatch')) return;
    const kb = devices.get(KEYBOARD);
    if (!kb) return;
    if (kb.side === side) toggleReady(kb);
    else move(kb, side);
  }));
}

// --- the model ------------------------------------------------------------

function captain(side) {
  for (const d of devices.values()) if (d.side === side) return d;
  return null;
}

function label(d) {
  return d.kind === 'keyboard' ? uiText('teamKeyboard') : `${uiText('teamPad')} ${d.index + 1}`;
}

function move(d, side) {
  if (d.ready) return;
  if (side !== POOL && captain(side) && captain(side) !== d) return;
  if (side === 1 && d.kind === 'keyboard') return;
  if (d.side === side) return;
  d.side = side;
  feedback('uiHover');
  render();
}

function toggleReady(d) {
  if (d.side === POOL) return;
  d.ready = !d.ready;
  feedback('uiClick');
  render();
}

/** Step side `side`'s colour round the wheel, skipping the other side's. */
function stepColor(side, dir) {
  const n = palette().length;
  let i = picks[side];
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (i !== picks[1 - side]) break;
  }
  picks[side] = i;
  feedback('uiHover');
  render();
}

function setColor(side, i) {
  if (i === picks[1 - side]) return;
  picks[side] = i;
  feedback('uiClick');
  render();
}

/** Both sides have a captain who is ready, or are empty (the CPU's), and at least one is a person. */
export function canStart() {
  const c = [captain(0), captain(1)];
  if (!c[0] && !c[1]) return false;
  return c.every((d) => !d || d.ready);
}

function leave() {
  if (!open) return;
  hideTeamSelect();
  feedback('uiClick');
  callbacks.onBack?.();
}

function tryStart() {
  if (!open || !canStart()) return;
  writeSetup();
  hideTeamSelect();
  feedback('uiClick');
  callbacks.onStart?.(versusSetup);
}

/** The screen's answer, in the shape the match reads. */
export function writeSetup() {
  const wheel = palette();
  resetVersusSetup();
  for (let side = 0; side < 2; side++) {
    const t = versusSetup.teams[side];
    const c = captain(side);
    t.color = wheel[picks[side]] ?? null;
    t.members.push(c
      ? { kind: 'human', pad: c.kind === 'keyboard' ? KEYBOARD : c.index }
      : { kind: 'cpu', pad: null });
  }
  return versusSetup;
}

// --- input ----------------------------------------------------------------

function act(d, press) {
  if (press.left) move(d, d.side === POOL ? 0 : d.side === 1 ? POOL : 0);
  else if (press.right) move(d, d.side === POOL ? 1 : d.side === 0 ? POOL : 1);
  else if (press.up && d.side !== POOL && !d.ready) stepColor(d.side, -1);
  else if (press.down && d.side !== POOL && !d.ready) stepColor(d.side, 1);
  else if (press.a) { if (d.side === POOL) move(d, d.kind === 'keyboard' ? 0 : (captain(0) ? 1 : 0)); else toggleReady(d); }
  else if (press.b) { if (d.ready) toggleReady(d); else if (d.side !== POOL) move(d, POOL); else leave(); }
  else if (press.start) tryStart();
}

/**
 * Once a frame while the screen is up (main.js calls it beside the other
 * menu polls). Registers any pad it has not seen, drops any that has gone,
 * and hands each pad's presses to its chip.
 */
export function updateTeamSelect(list = null) {
  if (!open) return;
  const pads = pollPads(padPrev, list);
  const seen = new Set([KEYBOARD]);
  let changed = false;
  for (const p of pads) {
    const key = `pad${p.index}`;
    seen.add(key);
    let d = devices.get(key);
    if (!d) {
      d = { key, kind: 'pad', index: p.index, side: POOL, ready: false };
      devices.set(key, d);
      changed = true;
      // The press that made the browser show this pad is spent on arriving.
      continue;
    }
    act(d, p.press);
  }
  for (const [key, d] of devices) {
    if (!seen.has(key)) { devices.delete(key); changed = true; }
    void d;
  }
  if (changed) render();
}

function onKey(e) {
  if (!open) return;
  const kb = devices.get(KEYBOARD);
  if (!kb) return;
  const press = { left: false, right: false, up: false, down: false, a: false, b: false, start: false };
  switch (e.key) {
    case 'ArrowLeft': case 'a': press.left = true; break;
    case 'ArrowRight': case 'd': press.right = true; break;
    case 'ArrowUp': case 'w': press.up = true; break;
    case 'ArrowDown': case 's': press.down = true; break;
    case 'Enter': case ' ': press.a = true; break;
    case 'Escape': case 'Backspace': press.b = true; break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
  act(kb, press);
}

// --- rendering --------------------------------------------------------------

function render() {
  if (!el) return;
  const wheel = palette();
  for (let side = 0; side < 2; side++) {
    const node = el.sides[side];
    const c = captain(side);
    const color = cssColor(wheel[picks[side]] ?? 0xffffff);
    node.style.setProperty('--team', color);
    node.classList.toggle('sv-teams-cpu', !c);
    node.textContent = '';
    const slots = document.createElement('div');
    slots.className = 'sv-teams-slots';
    const cap = document.createElement('div');
    cap.className = 'sv-teams-slot sv-teams-captain';
    const chip = document.createElement('span');
    chip.className = 'sv-teams-chip' + (c?.ready ? ' sv-teams-ready' : '');
    chip.textContent = c ? label(c) : uiText('teamCpu');
    cap.appendChild(chip);
    if (c?.ready) {
      const stamp = document.createElement('span');
      stamp.className = 'sv-teams-stamp';
      stamp.textContent = uiText('teamReady');
      cap.appendChild(stamp);
    }
    slots.appendChild(cap);
    for (let i = 1; i < MAX_PER_SIDE; i++) {
      const s = document.createElement('div');
      s.className = 'sv-teams-slot sv-teams-locked';
      s.textContent = uiText('teamLocked');
      slots.appendChild(s);
    }
    node.appendChild(slots);
    // The wheel: every swatch on a circle, the pick swollen, the other side's
    // pick dimmed and dead to the pointer.
    const w = document.createElement('div');
    w.className = 'sv-teams-wheel';
    wheel.forEach((n, i) => {
      const sw = document.createElement('i');
      const a = (i / wheel.length) * Math.PI * 2 - Math.PI / 2;
      sw.className = 'sv-teams-swatch' + (i === picks[side] ? ' sv-teams-picked' : '') + (i === picks[1 - side] ? ' sv-teams-taken' : '');
      sw.style.background = cssColor(n);
      sw.style.color = cssColor(n);
      sw.style.transform = `translate(${Math.cos(a) * 40}px, ${Math.sin(a) * 40}px)` + (i === picks[side] ? ' scale(1.5)' : '');
      sw.dataset.i = String(i);
      sw.addEventListener('click', (e) => { e.stopPropagation(); setColor(side, i); });
      w.appendChild(sw);
    });
    node.appendChild(w);
  }
  // The pool: whoever has not chosen a side, and the no-pads line while the
  // keyboard is the only device.
  el.pool.textContent = '';
  const waiting = [...devices.values()].filter((d) => d.side === POOL);
  for (const d of waiting) {
    const chip = document.createElement('span');
    chip.className = 'sv-teams-chip';
    chip.textContent = label(d);
    el.pool.appendChild(chip);
  }
  if (![...devices.values()].some((d) => d.kind === 'pad')) {
    const line = document.createElement('div');
    line.className = 'sv-teams-nopads';
    line.textContent = uiText('teamNoPads');
    el.pool.appendChild(line);
  }
  el.start.disabled = !canStart();
}

// --- lifecycle ----------------------------------------------------------------

/**
 * Open the screen over `parent` (the UI root). `onStart(setup)` fires with
 * versusSetup written; `onBack()` when the player leaves without starting.
 */
export function showTeamSelect({ parent = document.body, onStart, onBack } = {}) {
  if (!root) build(parent);
  callbacks = { onStart, onBack };
  devices.clear();
  padPrev.clear();
  devices.set(KEYBOARD, { key: KEYBOARD, kind: 'keyboard', index: -1, side: POOL, ready: false });
  const teams = CONFIG.versus?.teams ?? [];
  picks[0] = nearestSwatch(teams[0]?.color ?? 0x3ddc63);
  picks[1] = nearestSwatch(teams[1]?.color ?? 0xff4d4d);
  if (picks[1] === picks[0]) picks[1] = (picks[0] + 1) % palette().length;
  open = true;
  root.classList.remove('sv-hidden');
  if (!keyHandler) {
    keyHandler = onKey;
    window.addEventListener('keydown', keyHandler, true);
  }
  render();
}

export function hideTeamSelect() {
  open = false;
  root?.classList.add('sv-hidden');
  if (keyHandler) {
    window.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
}

export function teamSelectOpen() { return open; }

/** For tests: the chips as the screen sees them. */
export function teamSelectState() {
  return { picks: [...picks], devices: [...devices.values()].map((d) => ({ ...d })) };
}
