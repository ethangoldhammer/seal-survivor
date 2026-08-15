// ---------------------------------------------------------------------------
// THE PAUSE MENU
//
// Built from systems/settings.js SCHEMA rather than hand-written row by row,
// so a setting added there appears here, is clamped on load and is covered by
// the round-trip test in one edit instead of three that could drift apart.
//
// Three input routes, all live at once, because all three are live everywhere
// else in this game:
//
//   MOUSE     real <input type="range"> and <button> elements. Nothing here is
//             a div pretending to be a control.
//   KEYBOARD  up/down moves the cursor, left/right adjusts, Enter activates.
//   GAMEPAD   the same, driven from menuInput — see updatePauseNav, called
//             from the frame loop the way the level-up screen's nav is.
//
// The cursor is a CLASS (.sv-pm-sel) rather than DOM focus, for the same
// reason the upgrade cards' selection is: a pad press is not a focus event,
// and :focus-visible is the browser's guess about whether to draw a ring.
// Focus is still moved along with it so the keyboard and screen readers agree,
// but the highlight does not depend on it.
//
// The reveal is injected rather than imported. ui.js owns the reveal system
// (one algorithm per surface, deliberately), and importing it back from here
// would make ui.js and this file a cycle for the sake of one function.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { feedback } from '../systems/feedback.js';
import { menuInput, resetMenuInput } from '../input.js';
import { isTextEntry } from './typing.js';
import { revealPile, releasePile } from './snapshotPrint.js';
import {
  ACTIONS,
  SCHEMA,
  bindKey,
  isBindable,
  keyLabel,
  normaliseKey,
  resetSettings,
  setSetting,
  settings,
} from '../systems/settings.js';

const STYLES = `
  /* The panel is a fixed-height scroller rather than a box that grows with its
     tab: the three tabs hold different numbers of rows, and a menu that
     changes size when you switch tabs makes the tab strip move out from under
     the cursor you are using to switch with. */
  .sv-pm { text-align: left; width: min(520px, 92vw); }
  .sv-pm-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .sv-pm-tabs { display: flex; gap: 6px; margin-bottom: 4px; }
  .sv-pm-tab { pointer-events: all; flex: 1; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 8px 4px;
    color: rgba(232,236,243,0.6); font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; cursor: pointer; transition: background 0.12s ease, color 0.12s ease; }
  .sv-pm-tab:hover { background: rgba(255,255,255,0.1); color: #e8ecf3; }
  .sv-pm-tab.sv-pm-on { background: rgba(122,215,255,0.16); border-color: rgba(122,215,255,0.5); color: #e8ecf3; }
  /* The cursor resting on the strip. The strip is one navigable row, so the
     highlight goes on the ACTIVE tab within it rather than around all three —
     otherwise "the cursor is here" and "this tab is showing" look identical. */
  .sv-pm-tabs.sv-pm-sel .sv-pm-on { box-shadow: 0 0 0 2px #7ad7ff; }

  /* Fixed height so the panel never resizes between tabs. Overflow scrolls
     rather than clipping — a long Controls tab on a short window has to stay
     reachable, and the pad cursor scrolls it into view (see selectRow). */
  .sv-pm-body { height: 268px; overflow-y: auto; overflow-x: hidden; padding: 4px 2px; margin: 0 -2px; }

  .sv-pm-row { display: flex; align-items: center; gap: 12px; padding: 9px 10px;
    border-radius: 8px; border: 1px solid transparent; }
  .sv-pm-row + .sv-pm-row { margin-top: 2px; }
  .sv-pm-row:hover { background: rgba(255,255,255,0.04); }
  .sv-pm-row.sv-pm-sel { background: rgba(122,215,255,0.12); border-color: rgba(122,215,255,0.45); }
  .sv-pm-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; }
  .sv-pm-hint { display: block; font-size: 10px; color: rgba(232,236,243,0.4);
    letter-spacing: 0.03em; margin-top: 2px; }
  /* tabular-nums so a value stepping 95% -> 100% doesn't shift the row's
     width, which reads as the whole panel twitching under the cursor. */
  .sv-pm-val { min-width: 58px; text-align: right; font-size: 12px; font-weight: 600;
    color: #7ad7ff; font-variant-numeric: tabular-nums; }

  .sv-pm-range { pointer-events: all; width: 148px; flex: none; accent-color: #7ad7ff;
    height: 4px; cursor: pointer; }
  .sv-pm-choice, .sv-pm-key { pointer-events: all; min-width: 108px; background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.18); border-radius: 7px; padding: 6px 10px;
    color: #e8ecf3; font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; }
  .sv-pm-choice:hover, .sv-pm-key:hover { background: rgba(255,255,255,0.12); }
  /* The binding prompt. Deliberately loud — it swallows the next keypress,
     so it has to be obvious that it is doing so. */
  .sv-pm-key.sv-pm-listening { background: rgba(122,215,255,0.2); border-color: #7ad7ff;
    color: #7ad7ff; letter-spacing: 0.06em; }

  .sv-pm-sub { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: rgba(232,236,243,0.35); font-weight: 600; margin: 12px 10px 4px; }
  .sv-pm-foot { display: flex; gap: 8px; margin-top: 16px; }
  .sv-pm-foot .sv-btn { flex: 1; }
  .sv-btn-ghost { background: rgba(255,255,255,0.07); color: #e8ecf3;
    border: 1px solid rgba(255,255,255,0.16); }
  .sv-btn-ghost:hover { background: rgba(255,255,255,0.14); }
  .sv-pm-note { font-size: 11px; color: rgba(232,236,243,0.35); margin-top: 12px;
    letter-spacing: 0.03em; text-align: center; }
`;

// Injected rather than imported — see the header note.
let reveal = null;
let revealSeconds = null;
let callbacks = {};

let wrap = null; // the .sv-center overlay, what gets hidden
let box = null;  // the .sv-menu panel, what the reveal masks
let tabsEl = null;
let bodyEl = null;
let footEl = null;

let open = false;
let activeTab = 'audio';
// The navigable rows of the CURRENT tab, top to bottom: the tab strip, then
// that tab's settings, then the footer buttons. Rebuilt on every tab switch,
// which is also why the cursor index is clamped rather than preserved.
let rows = [];
let cursor = 0;
// Which action is waiting for a key, or null. While this is set the capture
// listener below eats every keydown, so the game never sees the key being
// bound — otherwise binding "swim up" to D would also steer the seal right on
// the frame you bound it.
let listeningFor = null;

/**
 * Build the menu into `root` (the .sv-ui layer). Called once, from initUI.
 *
 * @param reveal        ui.js's runReveal, so this surface dissolves like the
 *                      others instead of cutting in.
 * @param revealSeconds (name, 'in'|'out') -> duration, from the same place.
 */
export function initPauseMenu(opts) {
  ({ reveal, revealSeconds } = opts);
  callbacks = { onResume: opts.onResume, onRestart: opts.onRestart };

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  wrap = document.createElement('div');
  wrap.className = 'sv-center sv-hidden';
  wrap.id = 'svPauseMenu';
  wrap.innerHTML = `
    <div class="sv-menu sv-pm" id="svPauseBox">
      <div class="sv-pm-head">
        <div class="sv-title" style="margin:0;">Paused</div>
        <div class="sv-hint" style="margin:0;">Esc or Start to resume &nbsp;·&nbsp; pad: LB/RB switch tabs, B back</div>
      </div>
      <div class="sv-pm-tabs" id="svPauseTabs"></div>
      <div class="sv-pm-body" id="svPauseBody"></div>
      <div class="sv-pm-foot" id="svPauseFoot"></div>
      <div class="sv-pm-note">Settings are saved on this device and are separate from the run.</div>
    </div>
  `;
  (opts.root ?? document.body).appendChild(wrap);

  box = wrap.querySelector('#svPauseBox');
  tabsEl = wrap.querySelector('#svPauseTabs');
  bodyEl = wrap.querySelector('#svPauseBody');
  footEl = wrap.querySelector('#svPauseFoot');

  buildTabs();
  buildFooter();
  buildBody();

  // CAPTURE phase, on window: input.js's own keydown listener is on window in
  // the bubble phase, so stopping propagation here is what keeps a key being
  // bound from also reaching the game. Registered once for the life of the
  // page and inert unless the menu is open.
  window.addEventListener('keydown', onKeyDown, true);
}

// --- open / close -----------------------------------------------------------

export function isPauseOpen() {
  return open;
}

export function showPauseMenu() {
  if (open) return;
  open = true;
  listeningFor = null;
  // The run's kill shots come back for as long as the menu is up. A paused
  // player is looking at their run rather than through the corner of the
  // screen at the water, which is the one time the pile is worth the space.
  // Sticky, or it would drift away three seconds into a menu being read.
  revealPile(true);
  // Re-read every control from the live settings on the way in. The M key and
  // the P key change two of these from outside the menu, so a panel built once
  // and cached would open showing stale values.
  buildBody();
  wrap.classList.remove('sv-hidden');
  selectRow(0);
  // The pad's confirm button is also, on some layouts, the button that opened
  // this menu. Without re-baselining, the press that paused the game reads as
  // a fresh press on the first frame and activates whatever the cursor landed
  // on. Same reasoning as the level-up screen's — see resetMenuInput.
  resetMenuInput();
  reveal?.('pause', {
    target: wrap,
    inner: box,
    from: 0,
    to: 1,
    seconds: revealSeconds?.('pause', 'in') ?? 0,
  });
}

export function hidePauseMenu() {
  if (!open) return;
  open = false;
  listeningFor = null;
  // Back to the clock: the pile eases out again a few seconds into play.
  releasePile();
  reveal?.('pause', {
    target: wrap,
    inner: box,
    from: 1,
    to: 0,
    seconds: revealSeconds?.('pause', 'out') ?? 0,
    onDone: () => {
      // Guarded: reopening mid-dissolve cancels this reveal but the pending
      // onDone from the cancelled one can still land, and hiding the menu that
      // is currently coming back in would leave a paused game with no menu and
      // no way to resume it without knowing the key.
      if (!open) wrap.classList.add('sv-hidden');
    },
  });
}

// --- structure --------------------------------------------------------------

function buildTabs() {
  tabsEl.innerHTML = '';
  for (const [id, section] of Object.entries(SCHEMA)) {
    const btn = document.createElement('button');
    btn.className = 'sv-pm-tab';
    btn.type = 'button';
    btn.dataset.tab = id;
    btn.textContent = section.label;
    btn.addEventListener('pointerenter', () => feedback('uiHover'));
    btn.addEventListener('click', () => {
      feedback('uiClick');
      setTab(id);
    });
    tabsEl.appendChild(btn);
  }
  paintTabs();
}

function paintTabs() {
  for (const btn of tabsEl.children) {
    btn.classList.toggle('sv-pm-on', btn.dataset.tab === activeTab);
  }
}

function setTab(id) {
  if (!SCHEMA[id] || id === activeTab) return;
  activeTab = id;
  listeningFor = null;
  paintTabs();
  buildBody();
  // Back to the tab strip rather than into the new tab's rows: the strip is
  // where the player is, and dropping the cursor into a list they have not
  // looked at yet is the menu moving on its own.
  selectRow(0);
}

function buildFooter() {
  footEl.innerHTML = '';
  footEl.appendChild(button('Resume', 'sv-btn', () => callbacks.onResume?.()));
  footEl.appendChild(button('Restart run', 'sv-btn sv-btn-ghost', () => callbacks.onRestart?.()));
  footEl.appendChild(button('Defaults', 'sv-btn sv-btn-ghost', () => {
    // This tab only. A single button that wiped all three would be the one
    // misclick in here that costs someone their whole setup, and "reset the
    // thing I am looking at" is what the button appears to promise anyway.
    resetSettings(activeTab);
    buildBody();
    selectRow(cursor);
  }));
}

function button(label, className, onClick) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('pointerenter', () => feedback('uiHover'));
  btn.addEventListener('click', () => {
    feedback('uiClick');
    onClick();
  });
  return btn;
}

// One navigable row. `activate` is Enter/A, `nudge` is left/right — a row may
// have either, both, or (a heading) neither.
function row(el, { activate = null, nudge = null, focus = null } = {}) {
  return { el, activate, nudge, focus };
}

function buildBody() {
  bodyEl.innerHTML = '';
  rows = [row(tabsEl, { nudge: stepTab, focus: () => tabsEl.querySelector('.sv-pm-on') })];

  for (const item of SCHEMA[activeTab].items) {
    if (item.type === 'keys') rows.push(...buildKeyRows());
    else rows.push(buildSettingRow(activeTab, item));
  }

  for (const btn of footEl.children) {
    rows.push(row(btn, { activate: () => btn.click(), focus: () => btn }));
  }
  paintCursor();
}

function stepTab(dir) {
  const ids = Object.keys(SCHEMA);
  const at = ids.indexOf(activeTab);
  const next = ids[(at + dir + ids.length) % ids.length];
  setTab(next);
  // setTab rebuilt the rows and put the cursor back on the strip, which is
  // where it already was — so nothing else to restore.
}

// --- rows -------------------------------------------------------------------

function buildSettingRow(section, item) {
  const el = document.createElement('div');
  el.className = 'sv-pm-row';
  const name = document.createElement('div');
  name.className = 'sv-pm-name';
  name.innerHTML = `${item.label}${item.hint ? `<span class="sv-pm-hint">${item.hint}</span>` : ''}`;
  el.appendChild(name);

  const path = `${section}.${item.key}`;
  const built = item.type === 'range'
    ? buildRange(el, path, item)
    : buildChoice(el, path, item);

  bodyEl.appendChild(el);
  el.addEventListener('pointerenter', () => {
    feedback('uiHover');
    selectRow(rows.findIndex((r) => r.el === el));
  });
  return row(el, built);
}

function buildRange(el, path, item) {
  const [section, key] = path.split('.');
  const value = document.createElement('div');
  value.className = 'sv-pm-val';
  const slider = document.createElement('input');
  slider.className = 'sv-pm-range';
  slider.type = 'range';
  slider.min = String(item.min);
  slider.max = String(item.max);
  slider.step = String(item.step);
  slider.value = String(settings[section][key]);
  slider.setAttribute('aria-label', item.label);

  const paint = () => {
    const v = settings[section][key];
    value.textContent = item.format ? item.format(v) : `${Math.round(v * 100)}%`;
    slider.value = String(v);
  };
  const write = (v) => {
    setSetting(path, v);
    paint();
  };

  slider.addEventListener('input', () => write(Number(slider.value)));
  el.appendChild(slider);
  el.appendChild(value);
  paint();

  return {
    focus: () => slider,
    // Rounded onto the step grid rather than added blindly: the stored value
    // can be off-grid (an older default, a clamp), and stepping from there
    // would keep it off-grid forever so the slider never reached its own max.
    nudge: (dir) => {
      const v = settings[section][key];
      const steps = Math.round(v / item.step) + dir;
      write(Math.min(item.max, Math.max(item.min, steps * item.step)));
    },
  };
}

// Both tri-state settings (screen filter, bloom) and plain booleans, since a
// boolean is a two-option cycle and giving it its own widget would mean two
// code paths that could disagree about what "default" means.
function optionsFor(item) {
  if (item.type === 'bool') return [{ value: false, label: 'Off' }, { value: true, label: 'On' }];
  if (item.type === 'boolOrNull') {
    return [
      { value: null, label: `Default (${authoredLabel(item) ? 'On' : 'Off'})` },
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ];
  }
  return [
    { value: null, label: `Default (${authoredLabel(item)})` },
    ...item.options.map((o) => ({ value: o, label: o === 'off' ? 'Off' : o.toUpperCase() })),
  ];
}

// What the BUILD ships, so "Default" says what it actually resolves to rather
// than leaving the player to guess. Read live: the ` panel can change either
// of these mid-session, and a label baked at boot would then be a lie.
function authoredLabel(item) {
  if (item.key === 'filter') return CONFIG.post?.preset ?? 'off';
  if (item.key === 'bloom') return CONFIG.bloom?.enabled !== false;
  return '';
}

function buildChoice(el, path, item) {
  const [section, key] = path.split('.');
  const btn = document.createElement('button');
  btn.className = 'sv-pm-choice';
  btn.type = 'button';

  const paint = () => {
    const opts = optionsFor(item);
    const at = opts.findIndex((o) => o.value === settings[section][key]);
    btn.textContent = opts[at >= 0 ? at : 0].label;
  };
  const step = (dir) => {
    const opts = optionsFor(item);
    const at = Math.max(0, opts.findIndex((o) => o.value === settings[section][key]));
    setSetting(path, opts[(at + dir + opts.length) % opts.length].value);
    paint();
  };

  btn.addEventListener('click', () => {
    feedback('uiClick');
    step(1);
  });
  el.appendChild(btn);
  paint();

  return { focus: () => btn, activate: () => step(1), nudge: step };
}

function buildKeyRows() {
  const out = [];
  const heading = document.createElement('div');
  heading.className = 'sv-pm-sub';
  heading.textContent = 'Keyboard';
  bodyEl.appendChild(heading);

  for (const action of ACTIONS) {
    const el = document.createElement('div');
    el.className = 'sv-pm-row';
    const name = document.createElement('div');
    name.className = 'sv-pm-name';
    name.innerHTML = `${action.label}<span class="sv-pm-hint">also ${action.alt}</span>`;
    el.appendChild(name);

    const btn = document.createElement('button');
    btn.className = 'sv-pm-key';
    btn.type = 'button';
    btn.dataset.action = action.id;
    const paint = () => {
      const listening = listeningFor === action.id;
      btn.classList.toggle('sv-pm-listening', listening);
      btn.textContent = listening ? 'Press a key' : keyLabel(settings.controls.keys[action.id]);
    };
    const listen = () => {
      listeningFor = action.id;
      repaintKeys();
    };
    btn.addEventListener('click', () => {
      feedback('uiClick');
      listen();
    });
    btn._paint = paint;
    paint();

    el.appendChild(btn);
    bodyEl.appendChild(el);
    el.addEventListener('pointerenter', () => {
      feedback('uiHover');
      selectRow(rows.findIndex((r) => r.el === el));
    });
    out.push(row(el, { activate: listen, focus: () => btn }));
  }
  return out;
}

function repaintKeys() {
  for (const btn of bodyEl.querySelectorAll('.sv-pm-key')) btn._paint?.();
}

// --- cursor -----------------------------------------------------------------

function selectRow(index) {
  if (!rows.length) return;
  cursor = Math.max(0, Math.min(rows.length - 1, index));
  paintCursor();
  // Focus follows the cursor so the keyboard and assistive tech agree with the
  // highlight — but `preventScroll`, because the browser's own scroll-into-view
  // jumps the panel to put a control at the edge of the scroller, and the
  // deliberate one below centres it instead.
  const target = rows[cursor].focus?.();
  target?.focus?.({ preventScroll: true });
  rows[cursor].el?.scrollIntoView?.({ block: 'nearest' });
}

function paintCursor() {
  rows.forEach((r, i) => r.el?.classList?.toggle('sv-pm-sel', i === cursor));
}

function step(dir) {
  selectRow((cursor + dir + rows.length) % rows.length);
  feedback('uiHover');
}

// --- input ------------------------------------------------------------------

function onKeyDown(e) {
  if (!open) return;

  // Binding capture comes first and eats everything: while the prompt is up
  // there is no such thing as a menu key, only the key being bound.
  if (listeningFor) {
    e.preventDefault();
    e.stopPropagation();
    const key = normaliseKey(e.key);
    if (key === 'escape') {
      listeningFor = null;
    } else if (isBindable(key)) {
      bindKey(listeningFor, key);
      listeningFor = null;
      feedback('uiClick');
    }
    // A reserved key (Tab, Enter, F11) falls through with the prompt still up,
    // which is the honest answer: nothing was bound and it is still asking.
    repaintKeys();
    return;
  }

  // isTextEntry, NOT isTypingTarget — see the note on both in ui/typing.js.
  // The cursor focuses this menu's own sliders, which are <input type="range">
  // and so are "typing targets" by that broader test; guarded with it, the
  // arrow keys would stop working on exactly the rows that need them.
  if (isTextEntry(e.target)) return;

  const key = normaliseKey(e.key);
  let handled = true;
  switch (key) {
    case 'arrowup': step(-1); break;
    case 'arrowdown': step(1); break;
    case 'arrowleft': rows[cursor]?.nudge?.(-1); break;
    case 'arrowright': rows[cursor]?.nudge?.(1); break;
    case 'enter':
    case ' ':
      rows[cursor]?.activate?.();
      break;
    default:
      handled = false;
  }
  // Only what was actually used. Escape in particular has to reach main.js's
  // handler, which is what closes the menu; swallowing every key here would
  // trap the player inside it.
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * The gamepad's turn, called once a frame from the main loop — the pad is
 * polled there, and reading it from an event handler would need a second
 * snapshot that could disagree with the one gameplay used.
 *
 * No-op unless the menu is open.
 */
export function updatePauseNav() {
  if (!open || listeningFor) return;
  // The bumpers change TAB from anywhere in the list. The strip is also the
  // top row and can be nudged left/right like any other, but that means
  // walking the cursor up to it and back down again for what is, on every
  // console menu ever made, LB and RB. Before the row handling below, because
  // stepTab rebuilds every row underneath it.
  if (menuInput.tabPrev) stepTab(-1);
  if (menuInput.tabNext) stepTab(1);
  if (menuInput.y) step(menuInput.y > 0 ? 1 : -1);
  if (menuInput.x) rows[cursor]?.nudge?.(menuInput.x > 0 ? 1 : -1);
  if (menuInput.confirm) rows[cursor]?.activate?.();
  // B closes it, the way it closes a menu on any console. Start already
  // toggles the pause from main.js; this is the button a pad player tries
  // first, and without it the only way out was to find Start again.
  if (menuInput.back) callbacks.onResume?.();
}
