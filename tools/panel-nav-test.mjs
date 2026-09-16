#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:panelnav
//
// THE CURSOR THE PLAIN DOM PANELS SHARE — ui/panelNav.js, and the four screens
// that had no pad and no arrow keys before it: the Seal sports list, the
// leaderboard, the tip jar's tier sheet and the main menu's accessory drawer.
//
// WHAT MAKES THIS WORTH A TEST. Every failure mode here is silent. A cursor
// that lands on a disabled button is a press that does nothing; one that lands
// on a hidden button is a press on something nobody can see; a panel that does
// not take the frame lets the screen UNDERNEATH answer the same stick push, and
// the visible result is the panel doing nothing while a run starts behind it.
// None of that throws, and none of it shows up in a screenshot.
//
//   THE STOPS      disabled and hidden controls are not stops. The sports list
//                  ships with two disabled rows in the MIDDLE of it.
//   THE ASKING     nothing is highlighted until the player asks — the same rule
//                  the cards and the score card follow.
//   THE TOP PANEL  a modal over another panel takes the frame whole.
//   THE KEYBOARD   arrows walk, Enter presses, Escape only where the panel
//                  asked for it (the tip sheet has its own, in capture).
//   THE DRAWER     a hat can be put on with a key and with a pad, and the strip
//                  is entered by pushing DOWN off the hexagons.
//   THE WIRING     ui.js registers the three panels and main.js gives them the
//                  frame before anything else — both source-level, because
//                  neither file runs headless.
//
// jsdom first, then the loader — see the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;

await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const nav = await import('../path/src/ui/panelNav.js');

/** A pad in navigator.getGamepads() shape — the same helper the team select's
 *  harness uses, for the same poll. */
function pad(index, { a = false, b = false, start = false, dpad = null } = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  if (a) buttons[0] = { pressed: true, value: 1 };
  if (b) buttons[1] = { pressed: true, value: 1 };
  if (start) buttons[9] = { pressed: true, value: 1 };
  if (dpad === 'left') buttons[14] = { pressed: true, value: 1 };
  if (dpad === 'right') buttons[15] = { pressed: true, value: 1 };
  if (dpad === 'up') buttons[12] = { pressed: true, value: 1 };
  if (dpad === 'down') buttons[13] = { pressed: true, value: 1 };
  return { index, connected: true, id: `pad ${index}`, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
}

/**
 * One frame with the given press, then one with nothing held — so the next
 * frame is a fresh edge. The poll is edge-triggered (ui/padPoll.js), which is
 * what a press IS to the Gamepad API: there are no button events.
 */
function frame(press = {}, index = 0) {
  const took = nav.updatePanelNav([pad(index, press)]);
  nav.updatePanelNav([pad(index)]);
  return took;
}
const key = (k, target = document.body) => {
  const e = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const lit = () => [...document.querySelectorAll('.sv-nav-sel')].map((n) => n.id || n.className);

// A panel in the shape the real three are: a box of buttons that hides with
// .sv-hidden.
function makePanel(id, labels) {
  const wrap = document.createElement('div');
  wrap.className = 'sv-center sv-hidden';
  wrap.id = id;
  for (const label of labels) {
    const b = document.createElement('button');
    b.id = `${id}-${label.replace(/\W/g, '')}`;
    b.type = 'button';
    b.textContent = label;
    b.dataset.presses = '0';
    b.addEventListener('click', () => { b.dataset.presses = String(Number(b.dataset.presses) + 1); });
    wrap.appendChild(b);
  }
  document.body.appendChild(wrap);
  return {
    wrap,
    buttons: () => [...wrap.querySelectorAll('button')],
    open: () => wrap.classList.remove('sv-hidden'),
    close: () => wrap.classList.add('sv-hidden'),
    presses: (i) => Number(wrap.querySelectorAll('button')[i].dataset.presses),
  };
}

// ---------------------------------------------------------------------------
section('A closed panel owns nothing');
// ---------------------------------------------------------------------------
const list = makePanel('svTestList', ['One', 'Two', 'Three', 'Back']);
let backs = 0;
nav.registerPanelNav({
  id: 'testList',
  isOpen: () => !list.wrap.classList.contains('sv-hidden'),
  controls: () => list.buttons(),
  onBack: () => { backs++; },
  keyBack: true,
});
check('nothing open, nothing taken', frame({ dpad: 'down' }) === false);
check('...and no cursor anywhere', lit().length === 0);

// ---------------------------------------------------------------------------
section('Nothing is lit until the player asks');
// ---------------------------------------------------------------------------
list.open();
check('an open panel takes the frame', frame() === true);
// THE RULE THE CARDS AND THE SCORE CARD BOTH FOLLOW. A panel that opens with a
// button already lit tells a mouse player a click will do something it will
// not — and the player who opened it with a mouse is the common case here.
check('...but lights nothing on its own', lit().length === 0, lit().join(', '));
frame({ dpad: 'down' });
check('the first push lands on the first stop rather than stepping', nav.panelNavState().index === 0);
check('...and it is drawn', lit().length === 1 && lit()[0] === 'svTestList-One', lit().join(', '));

// ---------------------------------------------------------------------------
section('Stepping, on either axis, clamped at both ends');
// ---------------------------------------------------------------------------
frame({ dpad: 'down' });
check('down steps one', nav.panelNavState().index === 1);
// A COLUMN OF BUTTONS HAS NO SIDEWAYS, so right means the same as down — the
// same bargain the score card's cursor makes, and the reason a player pushing
// whichever they thought of is right.
frame({ dpad: 'right' });
check('...and so does right', nav.panelNavState().index === 2);
frame({ dpad: 'up' });
check('up steps back', nav.panelNavState().index === 1);
frame({ dpad: 'down' }); frame({ dpad: 'down' }); frame({ dpad: 'down' });
check('the end of the list holds rather than wrapping', nav.panelNavState().index === 3);
frame({ dpad: 'up' }); frame({ dpad: 'up' }); frame({ dpad: 'up' }); frame({ dpad: 'up' });
check('...and so does the top', nav.panelNavState().index === 0);

// ---------------------------------------------------------------------------
section('Confirm presses it, B leaves');
// ---------------------------------------------------------------------------
frame({ a: true });
check('confirm clicks the control itself', list.presses(0) === 1);
// Through the element's own click, so the pad cannot take a route the mouse
// does not — the sound bound to a button included.
frame({ b: true });
check('B is the way out from anywhere', backs === 1);
frame({ dpad: 'down' });
check('...and it does not also step the cursor on that frame', nav.panelNavState().index === 1);

// ---------------------------------------------------------------------------
section('Any controller in the room, and a held button is not a press');
// ---------------------------------------------------------------------------
// THE BUG THAT SENT THIS FILE BACK. `menuInput` is ONE pad — the one
// getGamepad() elects — and that election returns null for a single controller
// whenever a match is flagged on with no captain written (input.js). Every
// menuInput cursor in the game then goes dead with nothing on screen admitting
// it, which is what "the gamepad can't select from the Seal sports menu" was.
// These panels poll every pad themselves, so the election cannot reach them.
{
  nav.resetPanelNav();
  const before = nav.panelNavState().index;
  frame({ dpad: 'down' }, 3);
  check('pad 4 drives the list as well as pad 1', nav.panelNavState().index === 0, `was ${before}`);
}
// A BUTTON ALREADY DOWN WHEN A PANEL OPENS IS NOT A PRESS — the A that opened
// the panel is still held on the frame it appears, and read as an edge it would
// press the first row of the panel it just opened. padPoll is edge-triggered and
// the poll runs even while nothing is up, which is what keeps the baseline.
{
  nav.resetPanelNav();
  list.close();
  const held = [pad(0, { a: true })];
  nav.updatePanelNav(held);        // nothing up; the press is spent on arriving
  list.open();
  const was = list.presses(0);
  nav.updatePanelNav(held);        // panel up, A STILL held
  check('a held A does not press the row the panel opened on', list.presses(0) === was);
  nav.updatePanelNav([pad(0)]);
}

// ---------------------------------------------------------------------------
section('A disabled row and a hidden one are not stops');
// ---------------------------------------------------------------------------
// THE SPORTS LIST SHIPS WITH TWO OF THESE, IN THE MIDDLE. "Coming soon" is a
// real button, deliberately disabled — a cursor that can land on one is a press
// that does nothing, with no way for the player to tell it apart from a press
// that failed.
{
  nav.resetPanelNav();
  const b = list.buttons();
  b[1].disabled = true;
  frame({ dpad: 'down' });        // onto One
  frame({ dpad: 'down' });        // past the disabled Two
  const at = nav.panelNavState().index;
  const stops = list.buttons().filter((n) => !n.disabled);
  check('the disabled row is skipped', stops[at] === b[2], stops[at]?.textContent);
  b[1].disabled = false;
}

// ---------------------------------------------------------------------------
section('The panel nearest the player takes the frame whole');
// ---------------------------------------------------------------------------
// The tip sheet is a modal over whatever opened it, and every one of those
// screens is still in the layout underneath answering the same poll.
const modal = makePanel('svTestModal', ['Tier', 'Close']);
nav.registerPanelNav({
  id: 'testModal',
  priority: 10,
  isOpen: () => !modal.wrap.classList.contains('sv-hidden'),
  controls: () => modal.buttons(),
});
nav.resetPanelNav();
modal.open();
frame({ dpad: 'down' });
check('the modal has the cursor, not the panel under it', nav.panelNavState().id === 'testModal');
frame({ a: true });
check('...and confirm presses the modal', modal.presses(0) === 1 && list.presses(0) === 1);
modal.close();
frame({ dpad: 'down' });
check('closing it hands the cursor back', nav.panelNavState().id === 'testList');
check('...with nothing still lit on the panel that went', !lit().some((c) => c.startsWith('svTestModal')));

// ---------------------------------------------------------------------------
section('The keyboard drives the same cursor');
// ---------------------------------------------------------------------------
nav.resetPanelNav();
check('an arrow selects the first stop', (key('ArrowDown'), nav.panelNavState().index === 0));
key('ArrowDown');
check('...and the next one steps', nav.panelNavState().index === 1);
key('ArrowUp');
check('...and back', nav.panelNavState().index === 0);
{
  const before = list.presses(0);
  key('Enter');
  check('Enter presses what the cursor is on', list.presses(0) === before + 1);
}
{
  const was = backs;
  // A SECOND WINDOW LISTENER, exactly like main.js's pause key — which is bound
  // on the window in bubble, and which stopPropagation cannot reach because
  // that only stops an event moving to the next NODE. Escape on the sports list
  // closing the list AND toggling the pause behind it is one key press doing
  // two things, so this listener must not hear it.
  let alsoHeard = 0;
  const other = () => { alsoHeard++; };
  window.addEventListener('keydown', other);
  const e = key('Escape');
  check('Escape is Back on a panel that asked for it', backs === was + 1 && e.defaultPrevented);
  check('...and nothing else on the window hears it', alsoHeard === 0);
  window.removeEventListener('keydown', other);
}

// ---------------------------------------------------------------------------
section('Escape is left alone where the panel did not ask');
// ---------------------------------------------------------------------------
// The tip sheet has its own Escape, in capture, so it lands before the screen
// underneath reads it as "close the pause menu". Two handlers for one key is one
// press closing two things.
{
  nav.resetPanelNav();
  modal.open();
  const e = key('Escape');
  check('an un-asked Escape is not swallowed', !e.defaultPrevented);
  modal.close();
}

// ---------------------------------------------------------------------------
section('A text field keeps its arrow keys');
// ---------------------------------------------------------------------------
// isTextEntry, not isTypingTarget — see the note on both in ui/typing.js. The
// room lobby's code field is a real input on a screen a panel can be over.
{
  nav.resetPanelNav();
  const field = document.createElement('input');
  field.type = 'text';
  document.body.appendChild(field);
  const e = key('ArrowDown', field);
  check('an arrow inside a text field moves no cursor', nav.panelNavState().index < 0 && !e.defaultPrevented);
  field.remove();
}

nav.unregisterPanelNav('testList');
nav.unregisterPanelNav('testModal');
list.wrap.remove();
modal.wrap.remove();

// ---------------------------------------------------------------------------
section('The accessory drawer walks with a pad and with a key');
// ---------------------------------------------------------------------------
{
  const { setUnlockGate } = await import('../path/src/systems/unlocks.js');
  setUnlockGate(false);
  const { mountAccessoryDrawer } = await import('../path/src/ui/accessoryDrawer.js');
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const equipped = [];
  const drawer = mountAccessoryDrawer({
    parent, sealRect: () => ({ x: 0, y: 0, r: 1 }), onEquip: (k) => equipped.push(k),
  });
  const tiles = () => [...parent.querySelectorAll('.sv-acc-tile')].filter((t) => !t.classList.contains('sv-acc-ghost'));
  const at = () => tiles().findIndex((t) => t.classList.contains('sv-nav-sel'));

  check('the strip has tiles to walk', tiles().length >= 2, `${tiles().length}`);
  check('the cursor starts outside it', !drawer.padInside());
  // A TILE SAID role="button" TO A SCREEN READER AND WAS NOT ONE: no tabindex,
  // so Tab never reached it, and no key handler, so Enter did nothing when it
  // did. The only way to put a hat on was a pointer.
  check('every tile is reachable by Tab', tiles().every((t) => t.tabIndex === 0));

  // THE STRIP IS ENTERED ON THE HAT THE SEAL IS ALREADY WEARING, not on the
  // first tile: the row is a ring the player is stepping through, and landing
  // anywhere else means the first press walks away from where they are.
  CONFIG.accessories.equipped = '';
  check('padIn lands on what is worn', drawer.padIn() && drawer.padInside() && tiles()[at()].dataset.key === '');
  drawer.padStep(1);
  check('...and right walks the row', at() === 1);
  drawer.padStep(-1);
  check('...and left walks back', at() === 0);
  drawer.padStep(-1);
  check('...and holds at the end rather than wrapping', at() === 0);

  drawer.padStep(1);
  const key1 = tiles()[at()].dataset.key;
  drawer.padConfirm();
  check('confirm puts the hat on', CONFIG.accessories.equipped === key1 && equipped.at(-1) === key1, key1);
  check('...through the same path a click takes', tiles()[1].classList.contains('on'));

  drawer.padOut();
  check('up climbs back out', !drawer.padInside() && at() < 0);

  // The keyboard route on its own: Enter on a focused tile equips it.
  {
    const bare = tiles()[0];
    bare.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('Enter on a tile equips it', CONFIG.accessories.equipped === '');
  }

  // A REBUILT STRIP CANNOT KEEP A CURSOR. Every tile is thrown away, so an index
  // into the old row is an index into nothing — and the menu above would go on
  // believing the player was down here.
  drawer.padIn();
  drawer.rebuild();
  check('a rebuild drops the cursor', !drawer.padInside());
  drawer.destroy();
  parent.remove();
}

// ---------------------------------------------------------------------------
section('The menu hands the frame down to the strip');
// ---------------------------------------------------------------------------
{
  const src = await readFile(join(ROOT, 'path/src/systems/mainMenu.js'), 'utf8');
  // Neither of these files runs headless, so this catches deletion rather than
  // misplacement — the same weaker check the drawer's own mount test makes.
  check('a push down off the bottom button enters the drawer',
    /menuInput\.y > 0[\s\S]{0,80}drawer\.padIn\(\)/.test(src));
  check('...and while it is in there the hexagons do not move',
    /if \(drawer\.padInside\(\)\) \{/.test(src));
  check('...up climbs back onto a hexagon', /drawer\.padOut\(\)/.test(src));
  check('...and confirm goes to the strip', /drawer\.padConfirm\(\)/.test(src));
}

// ---------------------------------------------------------------------------
section('The three panels are registered, and they get the frame first');
// ---------------------------------------------------------------------------
{
  const ui = await readFile(join(ROOT, 'path/src/ui/ui.js'), 'utf8');
  for (const id of ['sealSports', 'leaderboard', 'tipSheet']) {
    check(`${id} registers a cursor`, new RegExp(`id: '${id}'`).test(ui));
  }
  // The sheet is a modal over whatever opened it — the splash, the pause panel,
  // the score card and the main menu are all screens it can appear over.
  check('the tip sheet outranks the panel under it', /id: 'tipSheet',\s*\n\s*priority: 10/.test(ui));

  const main = await readFile(join(ROOT, 'path/src/main.js'), 'utf8');
  // THE CASE THAT MADE THIS A BUG AND NOT A TIDINESS: the sheet opens over the
  // splash, and the splash branch of updateMenuNav starts the run on ANY pad
  // press. Without the gate a button pressed at a tier panel started the game
  // behind it.
  check('a panel stops the frame before the other cursors read it',
    /if \(!updatePanelNav\(\)\) \{[\s\S]{0,200}updateMenuNav\(\);[\s\S]{0,200}updatePauseNav\(\);/.test(main));
  check('...and the main menu\'s hexagons are off while one is up',
    /panelNavOpen\(\)/.test(main));

  // THE MATCH FLAG COMES OFF WITH THE MATCH, and this is the check that says so.
  //
  // enableVersus(true) is set by enterTeamSelectPitch and was cleared by exactly
  // two routes — backing out of the team select, and the next survivor run
  // through enterMode(false). Leaving a MATCH for the main menu was neither, so
  // versusActive() stayed true for as long as the player sat on that menu, and
  // getGamepad()'s versus branch resolves a SINGLE connected controller to null
  // rather than share it between two seals (input.js). Every menuInput cursor in
  // the game — the hexagons, the level-up hand, the pause menu — went dead after
  // one Blubberball match and stayed dead, on a screen with no match in sight.
  // It presents as "the controller stopped working", which is why it surfaced as
  // a report about one panel.
  //
  // BEFORE resetArena: the arena's width reads the flag when the walls are
  // measured, the same ordering enterMode already depends on.
  check('leaving a match for the menu turns the match off',
    /function returnToMenu\(\) \{[\s\S]{0,1600}setModeWorld\(false\);[\s\S]{0,600}resetArena\(\{ forMenu: true \}\)/.test(main));
  // ...AND THE PANELS DO NOT DEPEND ON THAT BEING RIGHT. They poll every pad
  // themselves, so no election upstream of them can take the frame away.
  const panelSrc = await readFile(join(ROOT, 'path/src/ui/panelNav.js'), 'utf8');
  // The IMPORT, not the word: the header of that file is largely about menuInput
  // and why this one does not use it, so a bare grep for the name fails on its
  // own explanation.
  check('...and the panels do not read the elected pad at all',
    /import \{ pollPads \}/.test(panelSrc) && !/^import[^\n]*menuInput/m.test(panelSrc));
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
