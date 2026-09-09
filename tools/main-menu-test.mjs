#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:menu
//
// THE ROUTE FROM BOOT TO A RUN, driven through the real ui/ui.js in jsdom:
//
//   the Rive card  →  the 3D menu  →  the run
//
// The card is the NAME SCREEN now (systems/playerName.js is what it fills in),
// and everything here is about the two ways that hand-over can quietly go
// wrong. Both would look like a working game to anyone who only ever plays one
// run per page load:
//
//   THE CARD STARTING A RUN     dismissing the splash used to BE "start the
//                               run", and the change is one callback. Wire it
//                               back by accident and the 3D menu is code that
//                               is never reached — with nothing in the console
//                               and a game that still plays.
//   THE CARD COMING BACK        the name is asked for once per page load. A
//                               second route through showStartMenu that
//                               remounts the card would put a text field in
//                               front of somebody who has already typed one —
//                               and, since the field comes up BLANK on purpose
//                               (see loadPlayerName), reads as the game having
//                               forgotten them.
//
// The menu screen itself is 3D and cannot run here: it wants a GL context, the
// loaded seal and a post stack. What is testable headless is the wiring — who
// gets called, in what order, and how many times — which is exactly where the
// two failures above live.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. The other way round breaks the CJS chain jsdom loads through and
// fails with an error about an encoding fallback that has nothing to do with
// anything. See the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// `url` set, or localStorage throws on the opaque origin the moment anything
// touches it — and the name the splash banks on the way out is a localStorage
// write.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned — a plain assignment throws with a message
// about "an Object which has only a getter" that says nothing about jsdom.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom's canvas is a stub. The reveal code only needs these to exist.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    // ui/riveRuntime.js imports the runtime's WASM by url, to keep it off unpkg.
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} resizeDrawingSurfaceToCanvas(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

const ui = await import('../path/src/ui/ui.js');
const { menuInput } = await import('../path/src/input.js');

const calls = { start: 0, menu: 0 };
const wired = {
  onStart: () => { calls.start++; },
  onRestart() {},
  onLevelChoice() {},
  onResume() {},
  onPauseRestart() {},
  onSplash() {},
  onMenu: () => { calls.menu++; },
};

const cards = () => document.querySelectorAll('.sv-riv').length;

// ---------------------------------------------------------------------------
section('The name card goes up, and nothing has begun');
ui.initUI(wired);
ui.showStartMenu();
check('the card is mounted', cards() === 1, `${cards()} on screen`);
check('no run has started', calls.start === 0);
check('the menu has not been reached past it', calls.menu === 0);

// ---------------------------------------------------------------------------
section('Dismissing it lands on the menu, not in a run');
// The pad's route out, which is the one path a harness can drive: a keyboard
// and a touch go through the artboard's own Start button (see riveSplash.js),
// and the artboard is a stub here.
menuInput.anyPress = true;
ui.updateMenuNav();
menuInput.anyPress = false;
check('the menu was asked for', calls.menu === 1, `menu x${calls.menu}`);
// THE REGRESSION THIS FILE EXISTS FOR. onStart here means the card is starting
// runs again and the menu is unreachable code.
check('no run was started by the card', calls.start === 0, `start x${calls.start}`);

// ---------------------------------------------------------------------------
section('The name is never asked for twice');
const before = cards();
ui.showStartMenu();
check('no second card was mounted', cards() === before, `${cards()} vs ${before}`);
check('it went straight to the menu', calls.menu === 2, `menu x${calls.menu}`);
check('and still did not start a run', calls.start === 0, `start x${calls.start}`);

// ---------------------------------------------------------------------------
section('Without a menu wired, the old behaviour is intact');
// A build with no 3D menu — and every harness in this repo that boots ui.js
// with four callbacks — must still be startable rather than stranded on a
// screen with nothing behind it. See leaveSplash.
const bare = { ...wired, onMenu: undefined };
ui.initUI(bare);
ui.showStartMenu();
check('the run starts instead', calls.start === 1, `start x${calls.start}`);
check('the menu was not called', calls.menu === 2, `menu x${calls.menu}`);

// ---------------------------------------------------------------------------
section('The old DOM start menu is gone, not hidden');
// It was the boot screen, then a wall of instructions behind a button; the
// tutorial teaches all of it in the water now. Markup left in the tree would
// come back the first time something called hideAllMenus or a preview screen,
// and it holds a "Start run" button — so a dead panel here is a route into a
// run sitting behind the menu.
check('no #svStartMenu in the document', !document.getElementById('svStartMenu'));
check('...and no Start run button with it', !document.getElementById('svStartBtn'));
check('the how-to-play route is gone from the module',
  ui.showHowToPlay === undefined && ui.hideHowToPlay === undefined);
check('...and so is the screen it was previewed on',
  !ui.PREVIEW_SCREENS.includes('start'), ui.PREVIEW_SCREENS.join(', '));
// hideAllMenus reaches for every surface by name; one left pointing at deleted
// markup throws, and it is on the path into every run.
ui.hideAllMenus();
check('hideAllMenus still runs with it gone', true);

// ---------------------------------------------------------------------------
section('A panel the menu opens is drawn OVER the menu');
// The hex buttons' labels are DOM (the type system lives there), so the words
// "Play" and "Leaderboard" and a panel one of them opens are two siblings of
// the same .sv-ui layer and z-index is the only thing separating them. It was
// 6 against 4 for a while, which put the button text over the Settings panel it
// had just asked for — and it is invisible from either file alone, which is why
// the rule is checked here rather than in one of them.
//
// Read out of the source: mounting the real menu needs a GL context, the loaded
// seal and a post stack, none of which exist in jsdom.
const { readFileSync } = await import('node:fs');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const uiSrc = src('../path/src/ui/ui.js');
const menuSrc = src('../path/src/systems/mainMenu.js');
const centreZ = Number(/\.sv-center \{[^}]*z-index:\s*(\d+)/.exec(uiSrc)?.[1]);
const labelZ = Number(/sv-menu-labels[\s\S]{0,900}?z-index:(\d+)/.exec(menuSrc)?.[1]);
check('both z-indexes were found', Number.isFinite(centreZ) && Number.isFinite(labelZ),
  `labels ${labelZ}, .sv-center ${centreZ}`);
check('the labels sit UNDER every .sv-center panel', labelZ < centreZ,
  `labels ${labelZ} vs .sv-center ${centreZ}`);

// ---------------------------------------------------------------------------
section('Options from the menu claims nothing untrue');
const pause = await import('../path/src/ui/pauseMenu.js');
// The LAST of each, because initUI ran twice above (the back-compat section) and
// left the first build's markup in the document. The module drives the one it
// built most recently; a bare querySelector finds the abandoned one and reports
// whatever it was born with, which is a test that passes on a broken flag and
// fails on a working one.
const head = () => [...document.querySelectorAll('.sv-pm-head .sv-title')].at(-1);
const foot = () => [...document.querySelectorAll('#svPauseFoot')].at(-1)
  .querySelectorAll('button');
const footText = () => [...foot()].map((b) => b.textContent);
pause.showPauseMenu({ standalone: true });
check('it is headed Settings, not Paused', head().textContent === 'Settings', head().textContent);
check('there is no run to restart', !footText().includes('Restart run'), footText().join(' / '));
check('and the way out says Back', footText().includes('Back'), footText().join(' / '));
// ...and nothing else. The footer is where "How to play" was bolted on; it went
// with the panel it opened, and a stray button here would be one that opens
// markup that no longer exists.
check('...and offers no route to a deleted panel',
  !footText().some((t) => /how to play/i.test(t)), footText().join(' / '));
pause.hidePauseMenu();

// The run's own route must be untouched by all of the above — the flag is
// per-open, and a `standalone` left latched would put a paused player in front
// of a panel with no Resume.
pause.showPauseMenu();
check('a paused run still says Paused', head().textContent === 'Paused', head().textContent);
check('...and can still be resumed', footText().includes('Resume'), footText().join(' / '));
check('...and restarted', footText().includes('Restart run'), footText().join(' / '));
pause.hidePauseMenu();

// ---------------------------------------------------------------------------
// THE ROUTE BACK, READ OUT OF main.js.
//
// Read as SOURCE rather than imported, which is how every check in this repo
// that has to say something about main.js works: it opens a GL context, loads
// the roster and starts a frame loop, and none of that can happen in jsdom.
// A text check is weaker than a behavioural one and worth having anyway,
// because what it guards is a SHAPE — one teardown, reached by two routes —
// and the failure it catches is the one that is silent.
//
// The silent failure is a second copy. Emptying the water is two hundred reset
// calls in a load-bearing order, several of which say so in their own comments.
// Anyone writing "go back to the menu" from scratch writes a shorter list, and
// a shorter list is a menu with the last run's sharks still swimming through
// the bust's crop, or a boss corpse raining onto it, or a warning band from a
// run that ended. None of that throws. It just looks wrong, once, to somebody
// who is not looking for it.
// ---------------------------------------------------------------------------
section('Leaving a run for the menu, as main.js wires it');
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  const body = (name) => {
    const at = main.indexOf(`function ${name}(`);
    if (at < 0) return '';
    let depth = 0;
    for (let i = main.indexOf('{', at); i < main.length; i++) {
      if (main[i] === '{') depth++;
      else if (main[i] === '}' && --depth === 0) return main.slice(at, i + 1);
    }
    return '';
  };

  const menu = body('returnToMenu');
  check('there is a returnToMenu at all', menu.length > 0);
  // THE SHARED TEARDOWN, not a hand-written list. This is the check the whole
  // section exists for.
  check('...and it empties the water through the same function a restart does',
    /resetArena\(\s*\{[^}]*forMenu:\s*true/.test(menu), 'resetArena({ forMenu: true })');
  check('...and stops the run rather than leaving it ticking under the menu',
    /gameState\.running\s*=\s*false/.test(menu) && /gameState\.paused\s*=\s*false/.test(menu));
  // The HUD is the run's own furniture and no menu hides it — the score card
  // is what normally takes it down, and this route never shows one.
  check('...takes the HUD down, which nothing else on this route would',
    /hideHud\(\)/.test(menu));
  check('...and ends on the menu', /showMainMenu\(\)/.test(menu));

  // ONE TEARDOWN, TWO ROUTES. If startGame stopped going through resetArena the
  // two would drift, and the one that drifts is always the one nobody is
  // looking at.
  const start = body('startGame');
  check('a run starts through that same teardown',
    /resetArena\(/.test(start), start.split('\n').length + ' line(s)');
  check('...and startGame is now the two halves and nothing else',
    /buildRun\(/.test(start));

  // Both buttons have to reach it, and the pause one has to unpause first —
  // returnToMenu clears `paused` only after the teardown, so a panel left
  // latched would hand the menu a game that thinks it is mid-pause.
  check('the pause panel\'s button is wired to it',
    /onPauseMainMenu:\s*\(\)\s*=>\s*\{[^}]*setPaused\(false\)[^}]*returnToMenu\(\)/.test(main));
  // The score card's route goes under the same cover Try again uses: the death
  // left the clock dilated and the lens pushed in on a corpse, and cutting
  // straight to a menu from there snaps all of it back on one frame.
  const at = main.indexOf('onMainMenu:');
  const route = at < 0 ? '' : main.slice(at, at + 700);
  check('the score card\'s goes through the death transition, as Try again does',
    /showRestartTransition\(/.test(route) && /beginRestartTransition\(/.test(route)
    && /returnToMenu\(\)/.test(route));
}

// ---------------------------------------------------------------------------
section('Seal sports is a panel of one working game and two promises');
// The fifth hex opens a list (showSealSports). The ball game's button does
// whatever main.js hands it — switching the versus flag and building the run
// is main.js's job and not the panel's — and the two stubs are disabled with
// "coming soon" under them, so a player can see the list's shape without
// being able to press a button that goes nowhere.
{
  let pressed = 0;
  ui.showSealSports({ onBall: () => { pressed++; } });
  const panel = document.getElementById('svSportsPanel');
  check('the panel is mounted and shown', !!panel && !panel.classList.contains('sv-hidden'));
  const buttons = [...(panel?.querySelectorAll('.sv-sport') ?? [])];
  check('it lists three sports', buttons.length === 3, String(buttons.length));
  const ball = buttons.find((b) => b.dataset.sport === 'sportBall');
  check('the ball game is the one that can be pressed', !!ball && !ball.disabled);
  ball?.click();
  check('...and pressing it calls what main.js handed over', pressed === 1, `x${pressed}`);
  const stubs = buttons.filter((b) => b !== ball);
  check('the other two are disabled', stubs.length === 2 && stubs.every((b) => b.disabled));
  check('...and each says it is coming', stubs.every((b) => b.querySelector('.sv-sport-soon')?.textContent.length > 0));
  check('every word on it comes from the table (no id showing through)',
    ![...panel.querySelectorAll('button, .sv-title')].some((n) => /^(sport|sealSports)/.test(n.textContent.trim())),
    [...panel.querySelectorAll('button, .sv-title')].map((n) => n.textContent.trim()).join(' / '));
  // Back closes it, and so does the sweep every run makes on its way in — the
  // panel is a DOM overlay a canvas button can be pressed behind, exactly the
  // case hideAllMenus lists the Leaderboard for.
  panel.querySelector('#svSportsBack').click();
  check('Back hides it', panel.classList.contains('sv-hidden'));
  ui.showSealSports({ onBall: () => {} });
  ui.hideAllMenus();
  check('hideAllMenus takes it down too', panel.classList.contains('sv-hidden'));
  // The main menu wires the ball game to a mode switch, and the switch has to
  // rebuild the arena when the flag changes — the walls are measured off it.
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  check('main.js switches the flag and rebuilds the arena before the run',
    /function enterMode\(versus\)[\s\S]{0,600}enableVersus\([\s\S]{0,200}world\.resize\(\)[\s\S]{0,400}startGame\(\)/.test(main));
  check('...and the menu no longer reads a ?versus URL flag', !/has\('versus'\)/.test(main));
  check('closeMainMenu hides the sports panel with the board', /function closeMainMenu[\s\S]{0,300}hideSealSports\(\)/.test(main));
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
