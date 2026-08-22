#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:stage
//
// The Stage — the parked-camera mode the juice panel fires events from.
//
// Everything here is the BOOKKEEPING, not the picture: what the time scale
// comes out as, when the repeat timer fires, where the event lands relative to
// the seal, and what closing the panel hands back. All of that is invisible in
// a screenshot and all of it is what breaks.
//
// Why a Node harness and not the browser: the game loop is driven by
// requestAnimationFrame, which is suspended in a headless pane, so a "test"
// there would screenshot a frozen frame and prove nothing. Driving updateStage
// with a synthetic clock tests the thing that actually has logic in it.
// ---------------------------------------------------------------------------

// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules — see the jsdom-harness recipe. The other way round breaks the CJS
// chain jsdom loads through and fails with an error about an encoding fallback
// that has nothing to do with anything.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

await import('./vite-loader.mjs');

const { CONFIG } = await import('../path/src/config.js');
const {
  stageState, isStaging, openStage, closeStage, toggleStage, resetStage,
  updateStage, parkStageCamera, fireStagedEvent, stageEvents,
} = await import('../path/src/systems/stage.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// fireStagedEvent calls the real feedback(), which is the whole point of the
// design — so the harness calls it for real too. Headless that is safe and
// deliberately so: playSfx returns at its `unlocked` check, emit() no-ops
// without an initialised pool, and the grid ripple is skipped because
// initFeedback was never handed a grid. What survives is the bookkeeping,
// which is exactly what is under test.
console.log('\nSTAGE\n');

// --- the switch -------------------------------------------------------------
resetStage();
check('starts closed', !isStaging());
check('opening sets active', (openStage(), isStaging()));
check('toggle closes', (toggleStage(), !isStaging()));
check('toggle reopens', (toggleStage(), isStaging()));

// --- the clock --------------------------------------------------------------
closeStage();
check('closed returns a live clock', near(updateStage(0.016), 1));

openStage();
stageState.timeScale = 0.15;
check('open returns the staged scale', near(updateStage(0.016), 0.15));

stageState.timeScale = 0;
check('a zero time scale is floored, never frozen solid',
  updateStage(0.016) >= 0.02,
  `got ${updateStage(0.016)}`);

stageState.timeScale = 4;
check('an over-1 time scale is clamped', near(updateStage(0.016), 1));

// Closing must hand back a live clock — but through `active`, not by wiping
// the knobs. Wiping them desyncs the panel's sliders from the state behind
// them, so re-opening does nothing until every one has been nudged.
stageState.timeScale = 0.3;
stageState.repeat = 0.5;
closeStage();
check('a closed stage runs at full speed whatever the slider says',
  near(updateStage(0.016), 1));
check('closing keeps the time slider where you left it', near(stageState.timeScale, 0.3));
check('closing keeps the repeat where you left it', near(stageState.repeat, 0.5));
stageState.fired = 0;
updateStage(5);
check('and a closed stage fires no repeats', stageState.fired === 0);

// --- the repeat timer -------------------------------------------------------
// The one that matters: the repeat runs on the RAW clock, so slowing the
// picture down must not slow the firing rate down with it. A repeat measured
// in gameplay time would fire 6.7x less often at timeScale 0.15, which is
// exactly the case this tool is for.
resetStage();
openStage();
stageState.event = 'kill';
stageState.repeat = 0.5;
stageState.timeScale = 0.15;
stageState.fired = 0;

let t = 0;
while (t < 2) { updateStage(0.016); t += 0.016; }
check('repeat fires on the wall clock, not the dilated one',
  stageState.fired === 4, `2s at 0.5s intervals fired ${stageState.fired}, expected 4`);

// A repeat shorter than a frame must not drift — the `while` in updateStage.
stageState.repeat = 0.01;
stageState.fired = 0;
updateStage(0.1);
check('a sub-frame repeat catches up within one frame',
  stageState.fired === 10, `expected 10, got ${stageState.fired}`);

stageState.repeat = 0;
stageState.fired = 0;
updateStage(1);
check('repeat 0 fires nothing', stageState.fired === 0);

// --- where the event lands --------------------------------------------------
// The anchor is recorded by the camera park, so an event fires ON the seal
// rather than at the world origin. Getting this wrong is invisible until the
// burst appears in the wrong half of the arena.
const focusCalls = [];
const fakeWorld = { focusCamera: (pos, zoom, weight) => focusCalls.push({ x: pos.x, y: pos.y, zoom, weight }) };

resetStage();
openStage();
stageState.zoom = 2.5;
parkStageCamera(fakeWorld, { x: 12, y: -7 });
check('parking claims the camera at the staged zoom',
  focusCalls.length === 1 && near(focusCalls[0].zoom, 2.5));
check('parking claims the shot outright (weight 1)',
  focusCalls.length === 1 && near(focusCalls[0].weight, 1));
check('parking frames the seal', near(focusCalls[0].x, 12) && near(focusCalls[0].y, -7));

closeStage();
focusCalls.length = 0;
parkStageCamera(fakeWorld, { x: 3, y: 3 });
check('a closed stage makes no camera claim', focusCalls.length === 0);

// ...but it still tracks the seal while closed, so the first event fired after
// re-opening lands where the seal is NOW, not where it was when the panel was
// last up. That is why parkStageCamera records the anchor before its
// early-out rather than after.
openStage();
stageState.event = 'kill';
stageState.distance = 0;
parkStageCamera(fakeWorld, { x: 20, y: -4 });
check('the anchor follows the seal even across a closed spell',
  fireStagedEvent() === true);

// --- distance and validity --------------------------------------------------
resetStage();
openStage();
stageState.event = 'definitelyNotAnEvent';
check('an unknown event reports failure rather than throwing',
  fireStagedEvent() === false);
check('a failed fire is not counted', stageState.fired === 0);

stageState.event = 'kill';
check('a real event fires', fireStagedEvent() === true);
check('a successful fire is counted', stageState.fired === 1);

// --- the roster -------------------------------------------------------------
const events = stageEvents();
check('every feedback event is offerable',
  events.length === Object.keys(CONFIG.feedback).length,
  `${events.length} vs ${Object.keys(CONFIG.feedback).length}`);
resetStage();
check('the event it opens on is a real one', !!CONFIG.feedback[stageState.event],
  `default is "${stageState.event}"`);

// --- reset ------------------------------------------------------------------
openStage();
stageState.timeScale = 0.2;
stageState.repeat = 0.4;
stageState.fired = 9;
resetStage();
check('reset closes the stage', !isStaging());
check('reset zeroes the fire count', stageState.fired === 0);
check('a reset stage returns a live clock', near(updateStage(0.016), 1));

// --- the sandbox ------------------------------------------------------------
// There is no idle state to tune in — the splash goes straight into a live
// run — so a long session has to survive drowning and being eaten.
const { holdStageSafe } = await import('../path/src/systems/stage.js');
const seal = { hp: 3, oxygen: 2, stats: { maxHp: 100, maxOxygen: 60 } };

resetStage();
holdStageSafe(seal);
check('a closed stage does not touch the seal', seal.hp === 3 && seal.oxygen === 2);

openStage();
stageState.safe = true;
holdStageSafe(seal);
check('staging refills health', seal.hp === 100);
check('staging refills oxygen', seal.oxygen === 60);

seal.hp = 3; seal.oxygen = 2;
stageState.safe = false;
holdStageSafe(seal);
check('Safe off leaves the seal mortal', seal.hp === 3 && seal.oxygen === 2,
  'the only way to judge playerHit at low health');

stageState.safe = true;
holdStageSafe({ hp: 0 });
check('a seal with no stats block is survived, not thrown on', true);

// A run with oxygen switched off entirely must not have a bar conjured for it.
const noAir = { hp: 5, oxygen: 0, stats: { maxHp: 50, maxOxygen: 0 } };
holdStageSafe(noAir);
check('no oxygen stat means no oxygen refill', noAir.oxygen === 0 && noAir.hp === 50);

resetStage();

// --- world only -------------------------------------------------------------
// The workbench does not need a run. Every system an event touches is built at
// module scope before boot(), and everything that draws the result sits
// outside the run gate — so this switch is about what you want to judge
// against, not about what is possible.
const { stageSimulates } = await import('../path/src/systems/stage.js');

resetStage();
check('with no stage open the game simulates normally', stageSimulates() === true,
  'this gates the main loop — a false here would freeze the whole game');

openStage();
stageState.sim = true;
check('a live staged run still simulates', stageSimulates() === true);
stageState.sim = false;
check('world-only holds the simulation', stageSimulates() === false);

closeStage();
check('closing the stage always hands the simulation back',
  stageSimulates() === true,
  'a stage closed while held would freeze the game with no panel to unfreeze it');

// Firing does not depend on the simulation — that is the whole claim.
openStage();
stageState.sim = false;
stageState.event = 'kill';
stageState.fired = 0;
check('events still fire with the world held', fireStagedEvent() === true);
check('and are still counted', stageState.fired === 1);
resetStage();

// --- the bare freeze (K) ----------------------------------------------------
// The same still world without the panel, for looking at a creature rather than
// firing events at it. It rides stageSimulates() rather than getting a gate of
// its own — see the note there — so the checks that matter are that it works
// with nothing open, that it does not become a second way to write
// stageState.sim, and above all that it cannot outlive a run.
{
  const { isWorldFrozen, setWorldFrozen, onFreezeChanged } = await import('../path/src/systems/stage.js');

  // The badge subscribes to this and to nothing else, so every claim below
  // about "the badge clears" is really a claim about this list being called.
  const seen = [];
  const off = onFreezeChanged((on) => seen.push(on));

  check('nothing is frozen to begin with', isWorldFrozen() === false);
  setWorldFrozen(true);
  check('freezing holds the simulation with no stage open',
    stageSimulates() === false && isStaging() === false,
    'this is the whole feature — a still world with no menu over it');
  check('...without flipping the bar\'s own switch behind your back',
    stageState.sim === false && isWorldFrozen() === true);

  // THE ONE THAT MATTERS. A freeze is invisible except that the water stops, so
  // a run starting frozen reads as the game having hung on its first frame —
  // and the key that would clear it is the one thing you would not think to
  // press. resetStage runs at every run start.
  // resetStage runs at every run start, and the stage is SHUT here on purpose:
  // that is the case the badge got wrong first. closeStage's own notification
  // is guarded to fire only when the stage was open, so hanging the badge off
  // it cleared the state silently and left the badge over a thawed world.
  seen.length = 0;
  resetStage();
  check('starting a run thaws the world', isWorldFrozen() === false && stageSimulates() === true,
    'a freeze that survived a reset would look exactly like a hang');
  check('...and says so, with the stage bar shut', seen.length === 1 && seen[0] === false,
    `notified ${JSON.stringify(seen)} — the badge has no other way to hear it`);

  // ...and does not natter on every subsequent run start, which is what an
  // unguarded setter would do.
  seen.length = 0;
  resetStage();
  resetStage();
  check('an already-thawed reset stays quiet', seen.length === 0, `${seen.length} notifications`);

  // Frozen and staged together must not leave the world held when only one of
  // them is lifted — they are separate flags and either one alone holds it.
  setWorldFrozen(true);
  openStage();
  stageState.sim = true;
  check('a staged sim does not override a freeze', stageSimulates() === false);
  setWorldFrozen(false);
  check('...and lifting the freeze hands it back', stageSimulates() === true);
  off();
  resetStage();
}

// --- the sandbox entry ------------------------------------------------------
// `?sandbox` is what makes a reload survivable: it boots past the splash into
// a staged run, so reloading to pick up someone else's change returns you to
// the setup you reloaded in order to keep.
const { sandboxRequested, setSandboxUrl } = await import('../path/src/systems/stage.js');

check('a plain URL is not a sandbox', sandboxRequested() === false);

setSandboxUrl(true);
check('latching writes the param', window.location.search.includes('sandbox'));
check('and the next boot would see it', sandboxRequested() === true);
check('without pushing a history entry', window.history.length <= 2,
  'replaceState, so Back still means what it meant');

setSandboxUrl(false);
check('releasing clears the param', !window.location.search.includes('sandbox'));
check('and the next boot is an ordinary run', sandboxRequested() === false);

setSandboxUrl(false);
check('clearing twice is harmless', sandboxRequested() === false);

// --- the panel --------------------------------------------------------------
// Built for real in jsdom. The hazards here are the ones that look like
// nothing: a key guard that swallows its own toggle, and a slider that paints
// a number without writing it.
console.log('\nSTAGE PANEL\n');

const { initStagePanel, setStagePanelVisible } = await import('../path/src/ui/stage.js');

let cleared = 0;
initStagePanel(() => { cleared++; return null; });

const panel = document.querySelector('.sv-stage');
check('the panel is built', !!panel);
check('it starts hidden', !panel.classList.contains('sv-stage-on'));

const press = (key, target = document.body) => {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
};

resetStage();
press('f');
check('F opens the stage', isStaging() && panel.classList.contains('sv-stage-on'));
press('f');
check('F closes it again', !isStaging() && !panel.classList.contains('sv-stage-on'));

// The guard that actually bit before: isTypingTarget counts a focused range
// input as typing, so using any slider on this panel would have stopped F
// working until you clicked away. isTextEntry is the one that doesn't.
press('f');
const slider = panel.querySelector('input[type=range]');
check('there are sliders to focus', !!slider);
press('f', slider);
check('F still closes while a slider has focus', !isStaging(),
  'isTypingTarget would have swallowed this');

// Typing into a real text field must NOT toggle.
setStagePanelVisible(true);
const text = document.createElement('input');
text.type = 'text';
document.body.appendChild(text);
press('f', text);
check('typing an f in a text field does not close the stage', isStaging());

// Enter fires, but only while open.
stageState.event = 'kill';
stageState.fired = 0;
press('Enter');
check('Enter fires the staged event while open', stageState.fired === 1);
setStagePanelVisible(false);
press('Enter');
check('Enter does nothing while closed', stageState.fired === 1);

// The select offers every event and writing it lands on stageState.
setStagePanelVisible(true);
const select = panel.querySelector('select');
check('the picker lists every event', select.options.length === Object.keys(CONFIG.feedback).length);
select.value = 'bigKill';
select.dispatchEvent(new dom.window.Event('change'));
check('picking an event writes it through', stageState.event === 'bigKill');

// Sliders write, not just paint.
const timeSlider = panel.querySelectorAll('input[type=range]')[0];
timeSlider.value = '0.15';
timeSlider.dispatchEvent(new dom.window.Event('input'));
check('the time slider writes through', near(stageState.timeScale, 0.15));
check('and the loop reads it back', near(updateStage(0.016), 0.15));

const fireBtn = panel.querySelector('.sv-stage-fire');
stageState.fired = 0;
fireBtn.click();
check('the Fire button fires', stageState.fired === 1);

const clearBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Clear creatures');
clearBtn.click();
check('Clear asks the caller for the live scene', cleared === 1);

setStagePanelVisible(false);
check('closing through the API closes the system too', !isStaging());
check('and hides the panel', !panel.classList.contains('sv-stage-on'));

// The desync that the notify exists for: a run starting closes the stage from
// outside the panel, and the bar has to go with it. Without the subscription
// this leaves a control bar sitting over a game that is no longer parked.
setStagePanelVisible(true);
check('open before the run starts', isStaging() && panel.classList.contains('sv-stage-on'));
check('opening the bar arms the sandbox for the next reload',
  sandboxRequested() === true,
  'a reload would otherwise drop you into an ordinary run');

resetStage();
check('starting a run closes the stage', !isStaging());
check('and the bar goes with it', !panel.classList.contains('sv-stage-on'),
  'panel would have been left on screen over an un-parked game');
check('and the sandbox is disarmed with it', sandboxRequested() === false,
  'a stale ?sandbox would silently re-enter the stage on the next reload');

// --- holding the page still -------------------------------------------------
// The dev-server latch that stops a background edit throwing away a staged
// run. Driven through its hooks rather than through a real server on purpose:
// this repo's dev server writes imported-tuning.json, so standing a second one
// up beside a live session would race it and overwrite whatever was being
// tuned there.
console.log('\nRELOAD HOLD\n');

const { reloadHold } = await import('../vite.config.js');
const hold = reloadHold();

const sent = [];
const fakeServer = { ws: { send: (event, data) => sent.push({ event, data }), on: () => {} } };
const handlers = {};
const captureServer = {
  ws: {
    send: (event, data) => sent.push({ event, data }),
    on: (event, cb) => { handlers[event] = cb; },
  },
};
hold.configureServer(captureServer);

check('the plugin only runs while serving', hold.apply === 'serve',
  'a deployed build has no watcher and no panel to ask');

// Not holding: the hook must return undefined so Vite does its normal thing.
// Returning [] here would silently disable HMR for the whole project.
check('an un-held update is passed straight through',
  hold.handleHotUpdate({ file: '/src/a.js', server: fakeServer }) === undefined);

const client = { send: (event, data) => sent.push({ event, data, direct: true }) };
handlers['stage:hold']({ hold: true }, client);
check('latching on answers the client that asked',
  sent.at(-1).direct === true && sent.at(-1).data.holding === true);

sent.length = 0;
check('a held update is swallowed',
  Array.isArray(hold.handleHotUpdate({ file: '/src/a.js', server: fakeServer })),
  'returning [] is what stops Vite sending full-reload');
check('and the client is told the page went stale',
  sent.at(-1)?.event === 'stage:pending' && sent.at(-1).data.count === 1);

hold.handleHotUpdate({ file: '/src/b.js', server: fakeServer });
check('a second file counts as two', sent.at(-1).data.count === 2);
hold.handleHotUpdate({ file: '/src/a.js', server: fakeServer });
check('the same file twice still counts as one', sent.at(-1).data.count === 2,
  'saving on a timer must not inflate the number');
check('the client is told WHICH files, by basename',
  sent.at(-1).data.files.includes('a.js') && sent.at(-1).data.files.includes('b.js'));

// The tuning file is rewritten on every slider drag. Counting it would have
// the bar announcing the page was stale several times a second, naming the
// file being tuned — so the three the tuning writer already suppresses are
// held but never counted.
const { resolve: resolvePath } = await import('node:path');
const tuningFile = resolvePath(process.cwd(), 'path/src/imported-tuning.json');
const before = sent.at(-1).data.count;
const tuningResult = hold.handleHotUpdate({ file: tuningFile, server: fakeServer });
check('a tuning write is still swallowed', Array.isArray(tuningResult));
check('but never counts as the page going stale', sent.at(-1).data.count === before,
  'otherwise every slider drag reports staleness');
const assetResult = hold.handleHotUpdate({ file: resolvePath(process.cwd(), 'public/sfx/x.mp3'), server: fakeServer });
check('nor does an uploaded asset',
  Array.isArray(assetResult) && sent.at(-1).data.count === before);

// Releasing does not un-swallow anything. Those updates were dropped and are
// never coming back, so the page is STILL stale the moment the latch lifts —
// and this is the report the badge lives on now that a run holds the latch
// with the bar shut. Answering 0 here would have the notice going dark over a
// page running code nobody had edited in ten minutes.
handlers['stage:hold']({ hold: false }, client);
check('releasing still reports what was swallowed', sent.at(-1).data.count === 2,
  'the page does not become fresh by stopping holding it still');
check('and names those files, so the notice can say which',
  sent.at(-1).data.files.includes('a.js') && sent.at(-1).data.files.includes('b.js'));
check('and updates flow again',
  hold.handleHotUpdate({ file: '/src/a.js', server: fakeServer }) === undefined);

// The failure mode that looks exactly like Vite having died: the page reloads
// while the latch is on, so the server holds for a client that is gone and
// every later edit vanishes with nothing on screen to explain it.
handlers['stage:hold']({ hold: true }, client);
check('but the backlog itself was cleared, so the next hold starts fresh',
  sent.at(-1).data.count === 0,
  'otherwise a run inherits the staleness of the one before it, forever');
hold.handleHotUpdate({ file: '/src/c.js', server: fakeServer });
handlers.connection();
check('a fresh page connection drops the latch',
  hold.handleHotUpdate({ file: '/src/c.js', server: fakeServer }) === undefined,
  'otherwise edits are swallowed forever with no panel to release it');

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
