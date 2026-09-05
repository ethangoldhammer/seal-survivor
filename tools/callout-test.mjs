#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:callouts
//
// THE BAND AND THE FIRST-RUN COACH — systems/callouts.js and systems/tutorial.js.
//
// Both are pure state machines fed from the frame loop, which is the whole
// reason they are separate from the DOM that draws them: everything worth
// getting wrong here is a matter of WHEN, and none of it is visible in a
// screenshot. What this covers is the ways each one goes quietly wrong:
//
//   THE JOIN. Every warning the code can fire and every step the coach can
//   offer needs a row in callouts.csv, and every row needs somebody to fire it.
//   A mismatch is a callout that never appears, which looks exactly like a
//   condition that never came up.
//
//   ONE BAND, AND WHO GETS IT. A dropped warning is by design; a dropped one
//   that then never retries is a bug. And a coach line MUST outrank a warning,
//   because the tip is the answer to the warning on the only run they can
//   collide on.
//
//   THE REPEAT GAP vs THE CROSSING. Holding a condition should nag on the row's
//   own gap; leaving it and coming back must speak immediately rather than wait
//   out a timer belonging to the last scare. These are the same code path and
//   they must not share a clock.
//
//   A WARNING THAT LOST THE BAND HAS NOT SPOKEN. Starting its repeat gap from
//   a line nobody saw is silent, plausible, and would mean the second-loudest
//   thing in a bad moment is the one you never hear.
//
//   A TIP INTERRUPTED BY DYING IS NOT SPENT. Burning a step on a run that ended
//   mid-sentence means the player likeliest to need teaching is the one player
//   who never gets it.
//
//   THE LEDGER IS PER STEP, NOT PER RUN, and it survives a restart. That is the
//   entire design of the coach, and a single "seen" flag would pass every other
//   check in this file.
//
//   ...AND WHERE THE ARROW ENDS UP. Aiming is the one part of the drawing that
//   can be wrong rather than merely ugly: an arrow that points at the seabed
//   when it means "up" is worse than no arrow, and it is invisible in every
//   check above this line. Driven through jsdom against a real camera.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import for that reason.
//
//   node tools/callout-test.mjs
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// The real thing this time, not a Map stand-in: jsdom implements storage
// properly, and systems/tutorial.js reads the ledger at module scope — so this
// has to be in place before the first import below.
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) {
      return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      // Every name the game imports from rive, not only the ones this test
      // exercises: an ES import of a missing export is a SyntaxError at LINK
      // time, so one unstubbed name takes the whole file down before a single
      // check runs, with an error about a module nothing here uses.
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export class RiveFile { constructor(){} on(){} cleanup(){} } export const decodeImage = async () => ({ unref(){} }); export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');
globalThis.fetch = async () => ({ ok: false, status: 404 });

const store = localStorage;

const { CONFIG } = await import('../path/src/config.js');
const {
  CALLOUTS, WARN_IDS, FIRED_BY_MAIN, bandState, bandStates, resetCallouts, updateCallouts, activeCallout,
  pinCallout, calloutAge,
  pushCallout, clearCallout, holdFor, checkCalloutBindings,
} = await import('../path/src/systems/callouts.js');
const {
  telegraphPulse, telegraphMul, setTelegraph, updateTelegraph,
} = await import('../path/src/systems/telegraph.js');
const {
  applyTipDissolve, initTipDissolve, TIP_DISSOLVE_DEFAULTS,
} = await import('../path/src/ui/tipDissolve.js');
// A three.js Color is not needed to test the paint path and importing one would
// drag the renderer into a state-machine test. What the path actually uses is
// copy/clone/multiplyScalar, so that is what this has.
function makeColor(r, g, b) {
  return {
    r, g, b,
    clone() { return makeColor(this.r, this.g, this.b); },
    copy(o) { this.r = o.r; this.g = o.g; this.b = o.b; return this; },
    multiplyScalar(k) { this.r *= k; this.g *= k; this.b *= k; return this; },
  };
}
const { settings, bindKey } = await import('../path/src/systems/settings.js');
const {
  playerName, loadPlayerName, savePlayerName, clearPlayerName, expandPlayer,
  sanitizeName, DEFAULT_PLAYER_NAME, MAX_NAME_LEN,
} = await import('../path/src/systems/playerName.js');
const { DEVICES } = await import('../path/src/devices.js');
const {
  COACH_IDS, updateTutorial, resetTutorial, resetTutorialRun, noteTutorialEvent,
  tutorialState, tutorialDone, tutorialComplete, legibleFor,
} = await import('../path/src/systems/tutorial.js');
const {
  parseCalloutCsv, checkCalloutIds, calloutText, calloutOnDevice,
} = await import('../path/src/calloutTable.js');
const { initCallouts, updateCalloutUi, clearCalloutUi } = await import('../path/src/ui/callout.js');
const { popupPose, worldToScreen, screenToWorld } = await import('../path/src/ui/ui.js');
const { TEXT_ROLES } = await import('../path/src/textRoles.js');
const { chainCss } = await import('../path/src/systems/chainColor.js');
const { strikeState, resetStrike, liveChain } = await import('../path/src/systems/strike.js');
const THREE = await import('three');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DT = 1 / 60;
/** Run `seconds` of frames through the band with a fixed set of conditions. */
function runBand(seconds, conditions, live = true) {
  const seen = [];
  for (let t = 0; t < seconds; t += DT) {
    const before = bandState.row;
    const beforeAge = bandState.age;
    updateCallouts(DT, conditions, live);
    // A pop is a new row on the band, or the same row wound back to zero.
    if (bandState.row && (bandState.row !== before || bandState.age < beforeAge)) {
      seen.push({ id: bandState.row.id, t: +t.toFixed(3) });
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
section('callouts.csv joins to the code');
// ---------------------------------------------------------------------------
for (const id of WARN_IDS) {
  const row = CALLOUTS.get(id);
  check(`warn "${id}" has an enabled row`, !!row && row.kind === 'warn');
}
for (const id of COACH_IDS) {
  const row = CALLOUTS.get(id);
  check(`coach "${id}" has an enabled row`, !!row && row.kind === 'coach');
}
{
  // COACH IS NOT THE SAME SET AS TUTORIAL. Every coach row but one belongs to a
  // tutorial step; `resumed` is fired by main.js on a run that came back after
  // the page was killed under it. The list comes from systems/callouts.js
  // rather than being written out again here — see FIRED_BY_MAIN, which exists
  // because this check and main.js disagreeing about it is exactly how the row
  // was reported unreachable while the game was firing it correctly.
  const coachIds = [...COACH_IDS, ...FIRED_BY_MAIN];
  const stray = [...CALLOUTS.values()].filter(
    (r) => !(r.kind === 'warn' ? WARN_IDS : coachIds).includes(r.id),
  );
  check('no row in the file is unreachable', stray.length === 0, stray.map((r) => r.id).join(', '));
}
{
  // The four the player actually asked for, verbatim. Wording is a CSV edit and
  // is meant to change; that these four ids EXIST and say something is not.
  const texts = WARN_IDS.map((id) => CALLOUTS.get(id)?.text ?? '');
  check('every warning has words', texts.every((t) => t.length > 0), texts.join(' / '));
}
{
  // Priorities must be distinct within a kind, or which of two simultaneous
  // warnings you get is decided by the order of a Map iteration.
  const prio = (kind, ids) => ids.map((id) => CALLOUTS.get(id)?.priority);
  const w = prio('warn', WARN_IDS);
  const c = prio('coach', COACH_IDS);
  check('warn priorities are distinct', new Set(w).size === w.length, w.join(','));
  check('coach priorities are distinct', new Set(c).size === c.length, c.join(','));
}

// ---------------------------------------------------------------------------
section('the parser');
// ---------------------------------------------------------------------------
{
  const warns = [];
  const table = parseCalloutCsv(
    [
      'id,kind,text,enabled,priority,hold,repeat,subject',
      'good,warn,Fine,TRUE,10,2,3,surface',
      'off,warn,Hidden,FALSE,10,2,,',
      'nokind,sideways,Words,TRUE,10,2,,',
      'notext,warn,,TRUE,10,2,,',
      'badsubject,warn,Words,TRUE,10,2,,sideways',
      'blank,warn,Words,TRUE,,,,',
      // A coach row about a thing. Its anchor is DERIVED and must ignore the
      // column, which is the only way the two can never disagree.
      'lived,coach,Words,TRUE,10,2,,pickup',
      'banded,coach,Words,TRUE,10,2,,',
    ].join('\n'),
    (m) => warns.push(m),
  );
  check('an enabled row parses', table.get('good')?.text === 'Fine');
  check('...with its subject', table.get('good')?.subject === 'surface');
  check('enabled=FALSE drops the row', !table.has('off'));
  check('an unknown kind drops the row', !table.has('nokind'));
  check('a row with no text drops', !table.has('notext'));
  check('an unknown subject keeps the row, loses the subject',
    table.has('badsubject') && table.get('badsubject').subject === null);
  // THE DERIVED ANCHOR. A coach line about an object stands beside it, whatever
  // the anchor column says — the two cells cannot be allowed to disagree,
  // because the disagreement is a tip pinned to a bubble with its words in the
  // middle of the screen.
  check('a coach row with a subject is anchored to the world',
    table.get('lived')?.anchor === 'world', table.get('lived')?.anchor);
  check('...and one without a subject stays on the band',
    table.get('banded')?.anchor === 'band', table.get('banded')?.anchor);
  // ...and a WARNING is never moved off the band by a subject, or an emergency
  // could end up riding an orb somewhere off screen.
  check('a warning with a subject stays on the band',
    table.get('good')?.anchor === 'band', table.get('good')?.anchor);
  check('a blank priority is 0, not missing', table.get('blank')?.priority === 0);
  // The distinction the whole `repeat` column rests on.
  check('a blank repeat is null (never repeats)', table.get('blank')?.repeat === null);
  check('a blank hold falls back to CONFIG',
    holdFor(table.get('blank')) === CONFIG.callouts.hold, String(holdFor(table.get('blank'))));
  // Each REJECTION says which row it dropped. `enabled=FALSE` is deliberately
  // not in this list: taking a row out on purpose is not a mistake to report.
  for (const id of ['nokind', 'notext', 'badsubject']) {
    check(`"${id}" was warned about by name`, warns.some((m) => m.includes(`"${id}"`)),
      warns.join(' | '));
  }
  check('a deliberate enabled=FALSE is silent',
    !warns.some((m) => m.includes('"off"')), warns.join(' | '));
}
{
  // The join check itself has to catch both directions, or it is decorative.
  const warns = [];
  const table = parseCalloutCsv(
    ['id,kind,text,enabled,priority,hold,repeat,subject', 'ghost,warn,Boo,TRUE,10,2,,'].join('\n'),
    () => {},
  );
  checkCalloutIds(table, ['real'], [], (m) => warns.push(m));
  check('a row the code cannot fire is warned about',
    warns.some((m) => m.includes('ghost')), warns.join(' | '));
  check('a condition with no row is warned about',
    warns.some((m) => m.includes('real')), warns.join(' | '));
}

// ---------------------------------------------------------------------------
section('one band, and who gets it');
// ---------------------------------------------------------------------------
{
  resetCallouts();
  const boss = CALLOUTS.get('boss');
  // The quietest row ON THE BAND — `boost` is no longer one of them, it lives
  // on the seal (see the two-surfaces block below).
  const quiet = CALLOUTS.get('oxygen');
  pushCallout(quiet);
  check('an empty band takes whatever asks', bandState.row === quiet);
  pushCallout(boss);
  check('a louder warning takes the band off a quieter one', bandState.row === boss);
  pushCallout(quiet);
  check('...and the quieter one cannot take it back', bandState.row === boss);
}
{
  resetCallouts();
  const boss = CALLOUTS.get('boss');
  // A CONTROL TIP, because those are the only coach rows left on the band —
  // everything the ocean teaches now stands beside its own subject and cannot
  // collide with a warning at all. `strike` is the one every device gets.
  const tip = CALLOUTS.get('strike');
  pushCallout(boss);
  pushCallout(tip);
  check('a coach tip outranks the LOUDEST warning', bandState.row === tip,
    `boss priority ${boss.priority} vs tip ${tip.priority}`);
  pushCallout(boss);
  check('...and the warning cannot take it back', bandState.row === tip);
  // AND A WORLD TIP DOES NOT COMPETE AT ALL. It is not politeness — the two are
  // drawn in different places, so a tip about a bubble taking the band off
  // "Warning!" would be silencing an emergency to explain a power-up.
  resetCallouts();
  pushCallout(boss);
  pushCallout(CALLOUTS.get('bubbleOrb'));
  check('a world tip leaves the band alone', bandState.row === boss);
  check('...and is up at the same time', bandStates.world.row === CALLOUTS.get('bubbleOrb'));
}
{
  resetCallouts();
  const row = CALLOUTS.get('health');
  pushCallout(row);
  updateCallouts(0.5, {}, false);
  check('the band ages', bandState.age > 0.4);
  pushCallout(row);
  check('the same row asking again re-pops rather than being ignored', bandState.age === 0);
}
{
  resetCallouts();
  pushCallout(CALLOUTS.get('health'));
  clearCallout(CALLOUTS.get('boost'));
  check('clearing a row that is not showing is a no-op', bandState.row === CALLOUTS.get('health'));
  clearCallout(CALLOUTS.get('health'));
  check('clearing the live row empties the band', bandState.row === null);
}
{
  resetCallouts();
  pushCallout(CALLOUTS.get('boss'));
  const hold = holdFor(CALLOUTS.get('boss'));
  updateCallouts(hold - 0.05, {}, false);
  check('the band is still up just before its hold', bandState.row !== null);
  updateCallouts(0.1, {}, false);
  check('the band leaves at its hold', bandState.row === null, `hold ${hold}s`);
}

// ---------------------------------------------------------------------------
section('when a warning speaks');
// ---------------------------------------------------------------------------
{
  resetCallouts();
  const seen = runBand(3, { boss: true });
  check('a rising edge speaks at once', seen.length >= 1 && seen[0].id === 'boss' && seen[0].t < 0.02);
  check('a row with no repeat speaks exactly once while held', seen.length === 1,
    `${seen.length} pops`);
}
{
  resetCallouts();
  const repeat = CALLOUTS.get('oxygen').repeat;
  const seen = runBand(repeat * 2.5, { oxygen: true });
  check('a row WITH a repeat nags', seen.length >= 3, `${seen.length} pops in ${(repeat * 2.5).toFixed(1)}s`);
  const gap = seen[1].t - seen[0].t;
  check('...on its own gap', Math.abs(gap - repeat) < 0.1, `${gap.toFixed(2)}s vs ${repeat}s`);
}
{
  // The clock that must NOT be shared. Hold oxygen just long enough to speak
  // once, let it clear, then cross again well inside the repeat gap.
  resetCallouts();
  runBand(0.5, { oxygen: true });
  runBand(0.5, { oxygen: false });
  const again = runBand(0.2, { oxygen: true });
  check('a fresh crossing speaks immediately, not on the repeat gap',
    again.length === 1 && again[0].t < 0.02);
}
{
  // All four in trouble at once. Measured over the winner's hold, because
  // after it expires the next-loudest SHOULD take the band — that is the
  // retry behaviour two checks down, not a second simultaneous line.
  //
  // `boost` is deliberately NOT in this set: it lives on the seal, not the
  // band, and it is the next block's business.
  resetCallouts();
  const seen = runBand(holdFor(CALLOUTS.get('boss')) - 0.1,
    { boss: true, health: true, oxygen: true });
  check('three band conditions at once produce one line', new Set(seen.map((s) => s.id)).size === 1,
    seen.map((s) => s.id).join(','));
  check('...the loudest one', seen[0].id === 'boss');
}
{
  // A warning that loses the band must keep trying. Boss holds the band for its
  // whole hold; health is true the entire time and must appear the moment the
  // boss line is done rather than never.
  resetCallouts();
  const seen = runBand(holdFor(CALLOUTS.get('boss')) + 0.5, { boss: true, health: true });
  check('a warning that lost the band takes it when the louder one is done',
    seen.some((s) => s.id === 'health'), seen.map((s) => s.id).join(','));
}
{
  resetCallouts();
  const seen = runBand(3, { boss: true, health: true }, false);
  check('nothing fires while the run is not live', seen.length === 0);
}
{
  const was = CONFIG.callouts.enabled;
  CONFIG.callouts.enabled = false;
  resetCallouts();
  const seen = runBand(2, { boss: true });
  check('the enable switch is respected', seen.length === 0);
  CONFIG.callouts.enabled = was;
}

// ---------------------------------------------------------------------------
section('two surfaces: the band, and the line on the seal');
// ---------------------------------------------------------------------------
{
  check('the boost warning is anchored to the seal', CALLOUTS.get('boost').anchor === 'player');
  check('...and so is the line telling you to spend what you banked',
    CALLOUTS.get('strikeNow').anchor === 'player');
  const sealRows = [...CALLOUTS.values()].filter((r) => r.anchor === 'player');
  check('...and they are the only two on the seal', sealRows.length === 2,
    sealRows.map((r) => r.id).join(','));
  // THE THIRD SURFACE. Every tip about something in the water stands beside it;
  // what is left on the band is the three control tips, which are about a stick
  // and a button and have nowhere in the ocean to be.
  //
  // ...plus the rows that are not tips at all. `resumed` is a coach line about
  // the APP — the page was killed and the run came back — so there is nothing
  // in the ocean for it to stand beside and the band is the only place it can
  // go. Excluded by the same list main.js fires it from, not by name.
  const banded = [...CALLOUTS.values()].filter(
    (r) => r.kind === 'coach' && r.anchor === 'band' && !FIRED_BY_MAIN.includes(r.id));
  check('the only tips left on the band are the control ones',
    banded.every((r) => ['swim', 'aim', 'strike'].includes(r.id)),
    banded.map((r) => r.id).join(','));
  const world = [...CALLOUTS.values()].filter((r) => r.anchor === 'world');
  check('...and everything the ocean teaches is anchored to what it teaches',
    world.length >= 10 && world.every((r) => !!r.subject), world.map((r) => r.id).join(','));
}
{
  // THE TWO THINGS AN EMPTY METER MEANS. They share the seal's one slot, and
  // when both are somehow true the one with a strike in hand wins: "let go" is
  // actionable and "you have nothing" is not.
  resetCallouts();
  runBand(0.2, { boost: true, strikeNow: true });
  check('a banked strike outranks the empty meter on the seal',
    bandStates.player.row?.id === 'strikeNow', bandStates.player.row?.id ?? 'silent');
}
{
  // The empty-meter line is fired by a PRESS in main.js — one frame — so it
  // must not carry a repeat of its own. A row that nagged would keep shouting
  // for as long as the condition it is handed happened to stay true.
  check('the empty meter says it once per press', CALLOUTS.get('boost').repeat == null,
    String(CALLOUTS.get('boost').repeat));
  check('...and is quick about it', holdFor(CALLOUTS.get('boost')) <= 0.8,
    `${holdFor(CALLOUTS.get('boost'))}s`);
  // The other one is handed a HELD button, so it does repeat: the advice is
  // still true, and still not being taken.
  check('the strike-now line nags while the button stays down',
    CALLOUTS.get('strikeNow').repeat > 0, String(CALLOUTS.get('strikeNow').repeat));
}
{
  // THE WHOLE REASON THE ANCHOR EXISTS. The boost line is the quietest warning
  // in the game — under a single band it would be outranked by the boss, by
  // health and by air, which is to say it would never be seen in the fight
  // where running the meter dry is the thing that kills you.
  resetCallouts();
  runBand(0.2, { boss: true, health: true, oxygen: true, boost: true });
  check('the seal line speaks THROUGH the loudest band warning',
    bandStates.player.row?.id === 'boost', bandStates.player.row?.id ?? 'silent');
  check('...and the band is still the loudest one', bandStates.band.row?.id === 'boss',
    bandStates.band.row?.id ?? 'silent');
  check('...so both are readable at once',
    !!activeCallout('band') && !!activeCallout('player'));
}
{
  // ...and the two surfaces have their own clocks.
  resetCallouts();
  runBand(0.2, { boss: true, boost: true });
  const bandHold = holdFor(CALLOUTS.get('boss'));
  const sealHold = holdFor(CALLOUTS.get('boost'));
  check('the two holds really do differ', Math.abs(bandHold - sealHold) > 0.2,
    `${bandHold}s vs ${sealHold}s`);
  runBand(sealHold, {});
  check('the shorter line leaves on its own hold', bandStates.player.row === null);
  check('...without taking the longer one with it', bandStates.band.row !== null);
}
{
  // A coach tip outranks warnings — but only on its OWN surface. A tip must
  // never be able to silence the boost meter, which is on the seal.
  resetCallouts();
  pushCallout(CALLOUTS.get('boost'));
  pushCallout(CALLOUTS.get('strike'));
  check('a band tip does not clear the line on the seal',
    bandStates.player.row?.id === 'boost' && bandStates.band.row?.id === 'strike');
}
{
  // The role and motion block a line wears comes from the system, not the UI.
  resetCallouts();
  pushCallout(CALLOUTS.get('boost'));
  pushCallout(CALLOUTS.get('oxygen'));
  pushCallout(CALLOUTS.get('strike'));
  pushCallout(CALLOUTS.get('surface'));
  check('the seal line is on its own motion block',
    activeCallout('player').motion === 'boostWarn');
  check('a band tip is on the tip block', activeCallout('band').motion === 'coach');
  // The world tip shares the tip's role deliberately: same voice, same size,
  // different place. A surface of its own would have been a second look for the
  // same speaker.
  check('...and so is the one out in the water', activeCallout('world').motion === 'coach');
  resetCallouts();
  pushCallout(CALLOUTS.get('oxygen'));
  check('a band warning is on the warning block', activeCallout('band').motion === 'warn');
  for (const key of ['warn', 'coach', 'boostWarn']) {
    check(`${key} has a motion block to be on`, !!CONFIG.textMotion[key]);
    check(`...and a text role wearing it`, TEXT_ROLES.some((r) => r.motion === key));
  }
}

{
  // THE PIN. A world tip has no clock: it is up until the thing it is about is
  // gone. Without this a tip riding a bubble would expire at its `hold` while
  // the bubble was still there, unexplained, with the label that named it
  // simply missing.
  resetCallouts();
  const row = CALLOUTS.get('bubbleOrb');
  pushCallout(row);
  pinCallout(row, true);
  updateCallouts(holdFor(row) * 3, {}, true);
  check('a pinned line outlives its own hold',
    bandStates.world.row === row, `after ${(holdFor(row) * 3).toFixed(1)}s`);
  check('...and its age still ran', calloutAge(row) > holdFor(row));
  pinCallout(row, false);
  updateCallouts(0.05, {}, true);
  check('...and it leaves the moment it is unpinned', bandStates.world.row === null);
}
{
  // The pin belongs to the LINE, not to the surface. A pin left behind would be
  // a callout that can never expire, which is the one failure mode worse than
  // any of the timing ones above.
  resetCallouts();
  const row = CALLOUTS.get('bubbleOrb');
  pushCallout(row);
  pinCallout(row, true);
  clearCallout(row);
  pushCallout(CALLOUTS.get('chumChunk'));
  updateCallouts(holdFor(CALLOUTS.get('chumChunk')) + 0.1, {}, true);
  check('the next line does not inherit the last one\'s pin',
    bandStates.world.row === null);
}

// ---------------------------------------------------------------------------
section('bloom in, bloom out');
// ---------------------------------------------------------------------------
{
  const m = CONFIG.textMotion.boostWarn;
  const hold = holdFor(CALLOUTS.get('boost'));
  const at = (age) => popupPose('boostWarn', age, hold).bloom;
  check('it arrives blooming', at(0) > 1, `${at(0).toFixed(1)}px`);
  check('...settles to nothing in the middle', at(hold / 2) < 0.5, `${at(hold / 2).toFixed(1)}px`);
  check('...and blooms again as it leaves', at(hold - 0.01) > 1, `${at(hold - 0.01).toFixed(1)}px`);
  check('the peak is the value the panel asked for',
    Math.abs(at(0) - m.in.bloom) < 0.01 && Math.abs(at(hold - 0.001) - m.out.bloom) < 0.5,
    `${m.in.bloom} / ${m.out.bloom}`);
  // The reason bloom is its own additive term rather than a factor on the
  // role's glow: it has to work on text that does not glow at rest.
  check('bloom does not depend on the role having a glow',
    popupPose('boostWarn', 0, hold).bloom > 0);
  // ...and nothing that had no bloom row gained one.
  check('the score popup is unaffected', popupPose('score', 0).bloom === 0);
}

// ---------------------------------------------------------------------------
section('the first-run coach');
// ---------------------------------------------------------------------------

// Put one kind of pickup in the water, or take it out. A helper rather than an
// inline Set edit because a run script says "a bubble is floating there for
// eight seconds" far more often than it says anything else about the ctx.
function setWater(ctx, kind, on) {
  if (on) ctx.inWater.add(kind);
  else ctx.inWater.delete(kind);
}

// A whole first run, driven a frame at a time. `ctx` is the same shape main.js
// assembles; the script below is a player who does each thing in turn.
//
// `device` defaults to the keyboard because that is the run with the fewest
// steps in it — a touch run has the movement tip as well, and starting from the
// smaller set means a test that means to cover it has to say so.
// ---------------------------------------------------------------------------
// A WORLD FOR THE TIPS TO STAND IN
//
// Every tip about a thing now takes hold of that thing when it starts and lets
// go when it is gone (see takeSubject/subjectAt in main.js). The harness has to
// supply both, and it supplies them FROM THE SAME BOOLEANS the steps read —
// which is what main.js does too, one level down: a bubble is in the water for
// exactly as long as ctx.inWater says it is.
//
// The objects are real (an identity to compare, a position to move, a stand-in
// mesh to light up) because the things worth testing are all about identity:
// that the tip keeps hold of ONE bubble, that it lets go of that one when it is
// taken, and that it never quietly re-targets to the next.
function makeSubjects(ctx) {
  // One standing object per kind, created on demand and thrown away when its
  // kind leaves the water. A fresh object each time it comes back, so a test
  // can tell "the same bubble" from "another bubble".
  const livingn = new Map();
  const thing = (key, x, y) => {
    let o = livingn.get(key);
    if (!o) {
      o = { mesh: { name: key, position: { x, y } } };
      livingn.set(key, o);
    }
    return o;
  };
  const alive = (kind, id) => {
    if (kind === 'pickup') return ctx.inWater.has(id);
    if (kind === 'chum') return ctx.chumInWater;
    if (kind === 'creature') return ctx.unkillableNear;
    // A weak spot is a thing and can burst mid-sentence, exactly like an orb
    // being swallowed. The hive is a PLACE — it answers every frame while the
    // corner is on screen, which is what `hiveShown` stands in for here.
    if (kind === 'hotspot') return ctx.weakSpotInReach;
    if (kind === 'hive') return ctx.hiveShown;
    return true;
  };
  return {
    take(kind, id) {
      if (kind === 'surface' || kind === 'seabed') return { kind };
      if (!alive(kind, id)) return null;
      return { kind, id, entry: thing(`${kind}:${id ?? ''}`, ctx.subjectX ?? 4, ctx.subjectY ?? 3) };
    },
    at(handle) {
      if (!handle) return null;
      // The two places answer every frame and never die, exactly as the arena's
      // do — "straight up from the seal" cannot be collected.
      if (handle.kind === 'surface') return { x: ctx.playerX ?? 0, y: 20 };
      if (handle.kind === 'seabed') return { x: ctx.playerX ?? 0, y: -20 };
      if (!alive(handle.kind, handle.id)) {
        livingn.delete(`${handle.kind}:${handle.id ?? ''}`);
        return null;
      }
      const m = handle.entry.mesh;
      // The thing drifts, so a test can prove the tip is FOLLOWING rather than
      // having latched a position when it started.
      m.position.x = ctx.subjectX ?? m.position.x;
      m.position.y = ctx.subjectY ?? m.position.y;
      return { x: m.position.x, y: m.position.y, mesh: m };
    },
  };
}

// The same world, bolted onto a hand-rolled ctx. Several blocks below drive
// updateTutorial directly with three or four fields rather than through
// coachRun, and every one of them is about a tip that now has to have something
// to stand beside.
function withSubjects(ctx) {
  ctx.inWater ??= new Set();
  ctx.pickupInWater ??= (kind) => ctx.inWater.has(kind);
  const world = makeSubjects(ctx);
  ctx.takeSubject = (kind, id) => world.take(kind, id);
  ctx.subjectAt = (handle) => world.at(handle);
  return ctx;
}

function coachRun(script, { live = true, seconds = 40, device = 'kbm' } = {}) {
  const seen = [];
  const ctx = {
    runTime: 0,
    device,
    moving: false,
    aiming: false,
    charging: false,
    oxygenLow: false,
    aboveSurface: false,
    airTime: 0,
    nearSurface: false,
    chumInWater: false,
    // Which pickup types are in the water. A Set the script adds to, wrapped in
    // the same one-kind-at-a-time function main.js hands over — the whole point
    // of the split is that taking a bubble must not answer the blue orb's tip,
    // and a boolean here could not tell those apart.
    inWater: new Set(),
    pickupInWater: (kind) => ctx.inWater.has(kind),
    feeding: false,
    chumOnSeabed: false,
    unkillableNear: false,
    // The boss's weak spots and the upgrade corner. Both off by default, like
    // every other water condition: a script that means to cover them says so.
    weakSpotInReach: false,
    hiveShown: false,
    upgradesHeld: 0,
    sinceUpgrade: Infinity,
    // Where whatever the tip is about happens to be. Written by a script that
    // wants to watch the label follow it.
    subjectX: 4,
    subjectY: 3,
    playerX: 0,
  };
  const world = makeSubjects(ctx);
  ctx.takeSubject = (kind, id) => world.take(kind, id);
  ctx.subjectAt = (handle) => world.at(handle);
  for (let t = 0; t < seconds; t += DT) {
    ctx.runTime = t;
    script(ctx, t);
    const before = tutorialState.active;
    updateCallouts(DT, {}, live);
    updateTutorial(DT, ctx, live);
    if (tutorialState.active && tutorialState.active !== before) {
      seen.push({ id: tutorialState.active, t: +t.toFixed(2) });
    }
  }
  return seen;
}

{
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx, t) => {
    ctx.chumInWater = true;
    // Strike once the first tip has had a moment to appear.
    if (t > 4 && t < 4.05) noteTutorialEvent('strike');
    // Then eat.
    if (t > 8 && t < 8.05) noteTutorialEvent('chum');
    // Then run low on air, and surface.
    ctx.oxygenLow = t > 12 && t < 15;
    ctx.aboveSurface = t >= 15 && t < 16;
    ctx.nearSurface = t >= 15;
    // Then breach properly.
    ctx.airTime = t > 20 ? 0.5 : 0;
  });
  const order = seen.map((s) => s.id);
  check('the first tip waits out the opening delay',
    seen[0]?.t >= CONFIG.tutorial.openDelay, `first at ${seen[0]?.t}s`);
  check('strike is taught first', order[0] === 'strike', order.join(' → '));
  check('chum comes after striking', order[1] === 'chum', order.join(' → '));
  check('air comes when the air runs out', order[2] === 'surface', order.join(' → '));
  check('breaching comes last', order[3] === 'breach', order.join(' → '));
  check('every step ran', new Set(order).size === 4, order.join(' → '));
}

{
  // THE FOUR TIPS THE OCEAN TEACHES, in a run that puts each of their subjects
  // in the water in turn. The controls are answered up front so the water half
  // is what the rest of the run is about.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    // A kill: chum in the water, eaten a couple of seconds later.
    ctx.chumInWater = t > 5;
    if (t > 8 && t < 8.05) noteTutorialEvent('chum');
    // A combo window, and a link scored inside it.
    ctx.feeding = t > 10 && t < 14;
    if (t > 12 && t < 12.05) noteTutorialEvent('chainLink');
    // A bubble spawns, and is swum into.
    setWater(ctx, 'bubbleOrb', t > 16 && t < 24);
    if (t > 20 && t < 20.05) noteTutorialEvent('bubbleOrb');
    // Chum reaches the floor, and is cleared.
    ctx.chumOnSeabed = t > 26 && t < 34;
    // And a turtle drifts past.
    ctx.unkillableNear = t > 37 && t < 40;
  }, { seconds: 48 });
  const order = seen.map((s) => s.id);
  check('the food chain is taught after eating', order.indexOf('foodChain') > order.indexOf('chum'),
    order.join(' → '));
  check('the orb tip comes after chum', order.indexOf('bubbleOrb') > order.indexOf('chum'),
    order.join(' → '));
  check('the seabed tip fires when chum lands', order.includes('crab'), order.join(' → '));
  check('the unkillable tip fires when one swims past', order.includes('invincible'),
    order.join(' → '));
  check('every water tip the run offered ran', ['chum', 'foodChain', 'bubbleOrb', 'crab', 'invincible']
    .every((id) => order.includes(id)), order.join(' → '));
  check('...each exactly once', order.length === new Set(order).size, order.join(' → '));
  check('...and a pickup the water never held stayed unspent',
    !order.includes('strikeOrb') && !tutorialDone().has('strikeOrb'), order.join(' → '));
}

{
  // TAKING ONE PICKUP MUST NOT SPEND THE OTHER FOUR. This is the whole reason
  // the tips and the events are per type: under a single shared `pickup` event
  // the first orb a player swam into would silently mark off the blue orb, the
  // bubble, the chunk and the attractor, and four of the five lines would never
  // be seen by anybody. It fails completely silently — every check above this
  // one passes with a single shared id.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // TAKEN ONE AT A TIME, and that is not scene-setting — it is the new
  // contract. A tip stands beside its orb until that orb is gone, so four orbs
  // left floating for the whole run is one tip up for the whole run and three
  // that correctly never get a turn. What this block is about is which EVENT
  // spends which tip, so each orb is swum into in its own window.
  const seen = coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    setWater(ctx, 'bubbleOrb', t < 8);
    setWater(ctx, 'strikeOrb', t >= 8 && t < 20);
    setWater(ctx, 'rapidFireOrb', t >= 20 && t < 32);
    setWater(ctx, 'chumChunk', t >= 32 && t < 44);
    if (t > 7.9 && t < 7.95) noteTutorialEvent('bubbleOrb');
  }, { seconds: 60 });
  const done = tutorialDone();
  check('taking a bubble spends the bubble tip', done.has('bubbleOrb'), [...done].join(','));
  check('...and the other three still each got their own line',
    ['strikeOrb', 'rapidFireOrb', 'chumChunk'].every((id) => seen.some((s) => s.id === id)),
    seen.map((s) => s.id).join(' → '));
  check('...in the priority order the csv asked for',
    seen.map((s) => s.id).filter((id) => id.endsWith('Orb') || id === 'chumChunk')
      .join(' → ') === 'bubbleOrb → strikeOrb → rapidFireOrb → chumChunk',
    seen.map((s) => s.id).join(' → '));
}

// ---------------------------------------------------------------------------
section('the boss weak spot, the hive and the level blob');
// ---------------------------------------------------------------------------
{
  // THE WEAK-SPOT TIP IS ABOUT REACH, NOT ABOUT THE BOSS. A spot the seal
  // cannot get to is a light on the far flank of a twenty-unit animal, and a
  // sentence telling you to strike it is an instruction you cannot follow.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx, t) => {
    if (t > 2 && t < 2.05) noteTutorialEvent('strike');
    // A boss is in the water for the whole run; the spot only comes within
    // reach for a window in the middle of it.
    ctx.weakSpotInReach = t > 12 && t < 22;
  }, { seconds: 30 });
  const first = seen.find((x) => x.id === 'bossWeakSpot');
  check('the weak-spot tip waits for the spot to be in reach', !!first && first.t >= 12,
    seen.map((x) => `${x.id}@${x.t}`).join(' → '));
  check('...and is spent by the run that showed it', tutorialDone().has('bossWeakSpot'));
}
{
  // ...AND IT IS GATED ON THE STRIKE. Nothing is served by telling a player to
  // strike a weak spot before they have been told what a strike is — so even
  // with a spot in reach from the first frame, the strike tip goes first.
  //
  // The ORDER and not "it never fires": the strike step is spent by its own
  // clock whether or not anybody presses anything, so a run long enough to
  // check anything at all is a run where the gate has already opened.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx) => { ctx.weakSpotInReach = true; }, { seconds: 20 });
  const order = seen.map((x) => x.id);
  check('the strike is taught before the weak spot',
    order.indexOf('strike') >= 0 && order.indexOf('bossWeakSpot') > order.indexOf('strike'),
    order.join(' → '));
}
{
  // A CRIT ANSWERS IT, and the tip comes off without waiting for the spot to
  // burst. Any weapon's crit — the lesson is what the patch IS, not how to
  // reach it.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // `charging` answers the strike tip on the frame it appears, which is how
  // every other block here gets past it — the weak-spot step is gated on it.
  const ctx = withSubjects({
    runTime: 99, device: 'kbm', charging: true, weakSpotInReach: true,
  });
  const step = () => { updateCallouts(DT, {}, true); updateTutorial(DT, ctx, true); };
  for (let t = 0; t < 30 && !tutorialDone().has('strike'); t += DT) step();
  for (let t = 0; t < 30 && tutorialState.active !== 'bossWeakSpot'; t += DT) step();
  check('the weak-spot tip is up', tutorialState.active === 'bossWeakSpot', `${tutorialState.active}`);
  noteTutorialEvent('bossWeakSpot');
  // The spot is deliberately LEFT LIT: this is about the crit ending the tip,
  // not about the subject going.
  for (let t = 0; t < 30 && tutorialState.active === 'bossWeakSpot'; t += DT) step();
  check('...and a crit takes it off', tutorialDone().has('bossWeakSpot'));
}
{
  // THE HIVE TIP NEEDS SOMETHING IN THE CORNER. Before the first pick the
  // corner is empty, and a label pointing at nothing is worse than no label.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx, t) => {
    // A card taken at t=10 and nothing before it.
    ctx.hiveShown = t > 10;
    ctx.upgradesHeld = t > 10 ? 1 : 0;
    ctx.sinceUpgrade = t > 10 ? t - 10 : Infinity;
  }, { seconds: 40 });
  const hive = seen.find((x) => x.id === 'hiveStack');
  check('the hive tip waits for the first pick', !!hive && hive.t >= 10,
    seen.map((x) => `${x.id}@${x.t}`).join(' → '));
  check('...and is spent once it has been shown', tutorialDone().has('hiveStack'));
}
{
  // ...AND IT ENDS WITH ITS MOMENT. The tip has no answer at all, so what takes
  // it off is the window after the pick lapsing — well before the twelve-second
  // ceiling, which is the only other thing that could ever end it.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({
    runTime: 99, device: 'kbm', hiveShown: true, upgradesHeld: 1, sinceUpgrade: 0,
  });
  let t = 0;
  for (; t < 30 && tutorialState.active !== 'hiveStack'; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    ctx.sinceUpgrade += DT;
  }
  check('the hive tip is up', tutorialState.active === 'hiveStack', `${tutorialState.active}`);
  const upAt = t;
  for (; t < 60 && tutorialState.active === 'hiveStack'; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    ctx.sinceUpgrade += DT;
  }
  const lasted = t - upAt;
  check('...and the window ends it, not the ceiling',
    lasted < (CONFIG.tutorial.maxShow ?? 12) - 0.5, `${lasted.toFixed(2)}s`);
  check('...but never before it can be read',
    lasted >= legibleFor(CALLOUTS.get('hiveStack'), 'kbm') - 0.05, `${lasted.toFixed(2)}s`);
}
{
  // THE LEVEL BLOB IS A PICKUP LIKE THE OTHER FOUR, spent by swimming into its
  // own kind and by nothing else.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx, t) => {
    if (t > 2 && t < 2.05) noteTutorialEvent('strike');
    setWater(ctx, 'levelOrb', t > 6 && t < 20);
    if (t > 14 && t < 14.05) noteTutorialEvent('levelOrb');
  }, { seconds: 30 });
  check('the level blob has a tip of its own', seen.some((x) => x.id === 'levelOrb'),
    seen.map((x) => x.id).join(' → '));
  check('...taking one spends it', tutorialDone().has('levelOrb'));
  check('...and it spent nothing else',
    !['bubbleOrb', 'strikeOrb', 'rapidFireOrb', 'chumChunk'].some((id) => tutorialDone().has(id)),
    [...tutorialDone()].join(','));
}

{
  // THE ATTRACTOR IS NOT SWUM INTO. It is a field a trawler drops — it rises
  // and drags the seabed to you — so there is no event that can answer its tip,
  // and what ends it is the field itself going.
  //
  // THIS USED TO BE THE ROW'S `hold`, and the change is the point of the whole
  // feature: the label stands on the thing for as long as the thing is there.
  // A tip that expired first would leave a glowing object in the water with the
  // sentence that explained it already gone.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  let upWhileThere = false;
  coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    setWater(ctx, 'attractorOrb', t > 6 && t < 12);
    // Sampled well past the row's own hold — which is what makes this a test of
    // the pin rather than of the clock — and inside CONFIG.tutorial.maxShow,
    // which is the other end of the same window. The field goes at 12s, before
    // the ceiling can be what ends the tip; the block below is where the
    // ceiling itself is measured.
    if (t > 10 && t < 10.05 && tutorialState.active === 'attractorOrb') upWhileThere = true;
  }, { seconds: 20 });
  check('the attractor tip is still up long past its hold',
    upWhileThere, `hold ${holdFor(CALLOUTS.get('attractorOrb'))}s`);
  check('...and is spent when the field goes',
    tutorialDone().has('attractorOrb'), [...tutorialDone()].join(','));
}

{
  // THE CEILING — CONFIG.tutorial.maxShow.
  //
  // A world tip has no clock: it stands beside its subject until the subject is
  // gone. That is exactly right for a bubble and it has no answer at all for a
  // field that runs for half a minute, a turtle that parks next to the seal, or
  // a pile of chum nobody dives for — and those tips simply sat there, long
  // past being read, until the water changed its mind.
  //
  // MEASURED ON A SUBJECT THAT NEVER LEAVES, because that is the only case the
  // ceiling exists for: every other ending has already fired by then.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ceiling = CONFIG.tutorial.maxShow;
  let upAt = null;
  let goneAt = null;
  coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    // In the water for the whole run, and never taken.
    setWater(ctx, 'attractorOrb', t > 6);
    if (tutorialState.active === 'attractorOrb') {
      if (upAt === null) upAt = t;
      goneAt = null;
    } else if (upAt !== null && goneAt === null) {
      goneAt = t;
    }
  }, { seconds: ceiling * 3 });
  check('a tip nothing can answer still comes off', goneAt !== null,
    `up at ${upAt?.toFixed(1)}s, still up at ${(ceiling * 3).toFixed(1)}s`);
  // The ceiling is time ON SCREEN, so it is measured from when the line
  // appeared and not from the top of the run. A frame of slack each way: the
  // step runs at DT and the row ages by DT.
  const shown = goneAt === null ? Infinity : goneAt - upAt;
  check('...at the ceiling, not at its own hold',
    shown > holdFor(CALLOUTS.get('attractorOrb')) && shown <= ceiling + DT * 3,
    `${shown.toFixed(2)}s on screen, ceiling ${ceiling}s`);
  check('...and is marked done, so it does not come back next run',
    tutorialDone().has('attractorOrb'), [...tutorialDone()].join(','));
}

{
  // A TIP WITH NO ANSWER STILL ENDS, AND STILL COUNTS. `invincible` is the one
  // step in the file whose `done` never returns true — there is nothing to do
  // about a turtle — so the only thing that can take it off the band is its own
  // `hold`. If that path ever stopped marking it done, the tip would come back
  // every single run forever, and nothing else in this file would notice.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({ runTime: 10, device: 'kbm', charging: true, unkillableNear: true });
  let stillTalking = false;
  // Sampled at twice the row's own hold — a tip still up there is a pinned one
  // — and short of CONFIG.tutorial.maxShow, which is measured on its own a few
  // blocks up. Both edges matter and they are different claims.
  const window = holdFor(CALLOUTS.get('invincible')) * 2;
  for (let t = 0; t < window; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (t > window - DT * 2) stillTalking = tutorialState.active === 'invincible';
  }
  check('a tip with nothing to obey stays while the animal is there', stillTalking,
    `active: ${tutorialState.active}`);
  ctx.unkillableNear = false;
  for (let t = 0; t < 3; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
  }
  check('...comes off when it swims away', tutorialState.active !== 'invincible',
    `active: ${tutorialState.active}`);
  check('...and is marked done, so it never returns', tutorialDone().has('invincible'));
}

{
  // THE SEABED TIP IS OBEYED BY CLEARING THE FLOOR, which is the one water tip
  // with a real action — and it must not be answered by the pile merely being
  // there. A `done` that read the wrong way round would clear on the frame it
  // appeared and read as a flicker.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // The strike tip outranks this one and is ready on any run past the opening
  // delay, so it is answered and waited out first — otherwise what this block
  // measures is the control half of the coach, not the seabed tip.
  const ctx = withSubjects({ runTime: 10, device: 'kbm', charging: true, chumOnSeabed: true });
  while (!tutorialDone().has('strike')) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
  }
  let sawIt = false;
  for (let t = 0; t < 3; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (tutorialState.active === 'crab') sawIt = true;
  }
  check('the seabed tip stays up while chum is still down there', sawIt && tutorialState.active === 'crab',
    `active: ${tutorialState.active}`);
  ctx.chumOnSeabed = false;
  for (let t = 0; t < 3; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
  }
  check('...and clears once the floor is', tutorialState.active !== 'crab' && tutorialDone().has('crab'),
    `active: ${tutorialState.active}`);
}

{
  // ...AND ONE MOUTHFUL OFF THE FLOOR IS ENOUGH.
  //
  // This used to wait for the pile to be EMPTY, which is a fair description of
  // the lesson and the wrong test for the tip: a trawler dumps thirty orbs down
  // there, clearing them takes most of a minute, and for that whole minute the
  // player who read the sentence, dived immediately and started eating was
  // still being told to. The tip is spent the first time it is acted on.
  //
  // THE PILE IS STILL THERE THROUGHOUT, which is the whole point of the check —
  // under the old `done` this passes for the wrong reason the moment the floor
  // happens to clear, so `chumOnSeabed` is never allowed to go false.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({ runTime: 10, device: 'kbm', charging: true, chumOnSeabed: true });
  const step = () => { updateCallouts(DT, {}, true); updateTutorial(DT, ctx, true); };
  while (!tutorialDone().has('strike')) step();
  for (let t = 0; t < 3 && tutorialState.active !== 'crab'; t += DT) step();
  check('the seabed tip is up with a pile on the floor', tutorialState.active === 'crab',
    `active: ${tutorialState.active}`);
  // Long enough to have been read — the legibility floor still applies, and a
  // tip taken away on the frame it was obeyed would be a flicker.
  for (let t = 0; t < legibleFor(CALLOUTS.get('crab'), 'kbm') + DT; t += DT) step();
  noteTutorialEvent('floorChum');
  step();
  check('...and one mouthful off the seabed answers it',
    tutorialState.active !== 'crab' && tutorialDone().has('crab'),
    `active: ${tutorialState.active}`);
  check('...with the pile still down there', ctx.chumOnSeabed);
}
// ---------------------------------------------------------------------------
section('the words follow the device');
// ---------------------------------------------------------------------------
{
  // The three wordings of the strike tip. This is the whole reason the column
  // exists: "hold to charge" is the same sentence on all three and useless on
  // all three, because what a first-run tip has to name is the THING to hold.
  const row = CALLOUTS.get('strike');
  const said = Object.fromEntries(DEVICES.map((d) => [d, calloutText(row, d)]));
  check('every device gets a strike line', DEVICES.every((d) => !!said[d]));
  check('...and no two of them say the same thing',
    new Set(Object.values(said)).size === DEVICES.length,
    Object.values(said).join(' / '));
  check('the touch line does not name a key',
    !/space|click|trigger/i.test(said.touch), said.touch);
  check('the pad line does not either',
    !/space|click|tap/i.test(said.pad), said.pad);

  // A line with nothing device-specific to say falls back rather than going
  // blank — the ordinary row, and the one a blank cell has to be safe for.
  const air = CALLOUTS.get('surface');
  check('a row with no variants says the same thing everywhere',
    DEVICES.every((d) => calloutText(air, d) === air.text), air.text);
}
{
  // The key token, which is what keeps the keyboard line true after a rebind.
  // A hand-typed "Space" would be wrong the moment somebody moves it, in the
  // one sentence whose whole job is to say which button to press.
  resetCallouts();
  pushCallout(CALLOUTS.get('strike'));
  const before = settings.controls.keys.strike;

  check('the token resolves to the current binding',
    activeCallout('band', 'kbm').text.includes('Space'),
    activeCallout('band', 'kbm').text);
  check('...and nothing is left holding a brace',
    !activeCallout('band', 'kbm').text.includes('{'),
    activeCallout('band', 'kbm').text);

  bindKey('strike', 'f');
  check('a rebind changes the words', activeCallout('band', 'kbm').text.includes('F'),
    activeCallout('band', 'kbm').text);
  check('...without touching the devices that have no keys',
    !activeCallout('band', 'pad').text.includes('F'),
    activeCallout('band', 'pad').text);

  bindKey('strike', before);
  check('the binding is back where it was', settings.controls.keys.strike === before);
  resetCallouts();
}
{
  // The hardware token. The pad line asks for the shoulder buttons BY NAME, and
  // what they are called depends on the controller — so the words come from the
  // frame loop, which is the only layer that has seen the pad.
  resetCallouts();
  pushCallout(CALLOUTS.get('strike'));
  const said = (tokens) => activeCallout('band', 'pad', tokens).text;

  check('the pad line takes the name it is handed',
    said({ bumper: 'L1 or R1' }).startsWith('L1 or R1'), said({ bumper: 'L1 or R1' }));
  check('...a different pad, a different name',
    said({ bumper: 'LB or RB' }).startsWith('LB or RB'), said({ bumper: 'LB or RB' }));
  check('...and no pad at all still reads as English rather than as a brace',
    !said(undefined).includes('{'), said(undefined));
  check('...saying the true generic thing', said(undefined).includes('shoulder'),
    said(undefined));
  resetCallouts();
}
{
  // Which wording the BAND is carrying, end to end — the parse, the device and
  // the token all the way to the element the player reads.
  const warns = [];
  const table = parseCalloutCsv(
    [
      'id,kind,text,textTouch,textPad,devices,enabled,priority,hold',
      'a,coach,Press {strike},Tap it,Squeeze it,,TRUE,10,2',
      'b,coach,Phone only,,,touch,TRUE,10,2',
      'c,coach,Not on a phone,,,kbm pad,TRUE,10,2',
      'd,coach,Typo,,,mouse,TRUE,10,2',
      'e,coach,Half a typo,,,pad keyboard,TRUE,10,2',
    ].join('\n'),
    (m) => warns.push(m),
  );
  check('the variants parse', calloutText(table.get('a'), 'touch') === 'Tap it');
  check('...and the pad one too', calloutText(table.get('a'), 'pad') === 'Squeeze it');
  check('...and kbm falls through to text', calloutText(table.get('a'), 'kbm') === 'Press {strike}');

  check('a one-device row exists there', calloutOnDevice(table.get('b'), 'touch'));
  check('...and nowhere else', !calloutOnDevice(table.get('b'), 'kbm')
    && !calloutOnDevice(table.get('b'), 'pad'));
  check('a two-device row exists on both', calloutOnDevice(table.get('c'), 'kbm')
    && calloutOnDevice(table.get('c'), 'pad'));
  check('...and not on the third', !calloutOnDevice(table.get('c'), 'touch'));
  check('a row with no list is on all of them',
    DEVICES.every((d) => calloutOnDevice(table.get('a'), d)));

  check('an unknown device name warns', warns.some((w) => w.includes('"mouse"')),
    warns.join(' | '));
  check('...and a row that was ONLY typos still appears rather than vanishing',
    DEVICES.every((d) => calloutOnDevice(table.get('d'), d)));
  check('a typo alongside a real name drops only the typo',
    calloutOnDevice(table.get('e'), 'pad') && !calloutOnDevice(table.get('e'), 'kbm')
      && !calloutOnDevice(table.get('e'), 'touch'));
}
{
  // The trap this guard exists for: a key token on a row that a phone can also
  // see. It reads fine on the laptop it was written on and tells a phone player
  // to press a key they do not have.
  const warns = [];
  const table = parseCalloutCsv(
    [
      'id,kind,text,textPad,devices,enabled,priority,hold',
      'loud,coach,Press {strike},,,TRUE,10,2',
      'fine,coach,Press {strike},Squeeze it,kbm pad,TRUE,10,2',
      'quiet,coach,No token here,,,TRUE,10,2',
      // NOT A KEY, and this is what the check has to be able to tell apart. A
      // name reads identically in every pair of hands, so demanding a `textPad`
      // for it would be a warning with no action behind it — and a developer
      // who learns this check cries wolf is a developer who stops reading it on
      // the row that really is about to tell a phone to press Space.
      'named,coach,Nice one {player},,,TRUE,10,2',
      // Nor is the hardware token: `{bumper}` answers itself on all three.
      'hw,coach,Squeeze {bumper},,,TRUE,10,2',
      // ...but a key token is still a key token when it shares a row with one.
      'mixed,coach,{player} press {strike},,,TRUE,10,2',
    ].join('\n'),
    () => {},
  );
  checkCalloutBindings(table, (m) => warns.push(m));
  check('a naked key token warns about touch', warns.some((w) => w.includes('"loud"') && w.includes('touch')),
    warns.join(' | '));
  check('...and about the pad', warns.some((w) => w.includes('"loud"') && w.includes('pad')),
    warns.join(' | '));
  check('a row that covers the devices it reaches is quiet',
    !warns.some((w) => w.includes('"fine"')));
  check('a row with no token is quiet', !warns.some((w) => w.includes('"quiet"')));
  check('a {player} row is not mistaken for a key binding',
    !warns.some((w) => w.includes('"named"')), warns.join(' | '));
  check('...nor is {bumper}, which answers itself everywhere',
    !warns.some((w) => w.includes('"hw"')), warns.join(' | '));
  check('...but a real key on the same row still warns',
    warns.some((w) => w.includes('"mixed"')), warns.join(' | '));

  // And the file we actually ship, which is the point of the guard.
  const live = [];
  checkCalloutBindings(CALLOUTS, (m) => live.push(m));
  check('the shipping table is quiet too', live.length === 0, live.join(' | '));
}
// ---------------------------------------------------------------------------
section('{player} — one name, every text table');
// ---------------------------------------------------------------------------
{
  // THE POINT OF THE TOKEN IS THAT ALL THREE SURFACES AGREE. Each of the three
  // reaches the name a different way — the band resolves it beside the key
  // bindings, a card resolves it beside its measured {effect}, a quip has no
  // token machinery of its own — so "they all say the same thing" is a claim
  // about three separate code paths and is exactly what a second copy of the
  // name would quietly break.
  const table = parseCalloutCsv(
    ['id,kind,text,enabled,priority,hold', 'hi,coach,Nice one {player},TRUE,10,4'].join('\n'),
    () => {},
  );

  clearPlayerName();
  check('a player who never typed one is called something',
    playerName() === DEFAULT_PLAYER_NAME, playerName());
  check('...but the input field still comes up blank', loadPlayerName() === '',
    JSON.stringify(loadPlayerName()));

  resetCallouts();
  pushCallout(table.get('hi'));
  const before = activeCallout('band', 'kbm', {})?.text;
  check('the band spends the token on the default', before === `Nice one ${DEFAULT_PLAYER_NAME}`, before);
  check('...and the quip surface agrees', expandPlayer('Nice one {player}') === before, expandPlayer('Nice one {player}'));

  savePlayerName('  Ethan  ');
  const after = activeCallout('band', 'kbm', {})?.text;
  check('a name typed mid-session reaches a line already on the band',
    after === 'Nice one Ethan', after);
  // THE FIELD AND THE SENTENCE WANT OPPOSITE THINGS about a trailing space,
  // which is why there are two accessors. The box keeps it (eating it fights a
  // typist mid-word); a line reading "Ethan , watch out!" is just broken.
  check('...the field keeps the trailing space for the typist',
    loadPlayerName() === 'Ethan ', JSON.stringify(loadPlayerName()));
  check('...and the token never spends it',
    expandPlayer('{player}, watch out') === 'Ethan, watch out',
    expandPlayer('{player}, watch out'));
  check('...with every surface moved together',
    expandPlayer('{player}') === 'Ethan', expandPlayer('{player}'));

  // The sanitiser is the server's rule, and these strings reach innerHTML on
  // the board. A name that could carry markup through the token would carry it
  // onto three more screens than the board.
  savePlayerName('<img src=x>Bob & "friends"');
  check('markup and quotes are stripped before the token can spend them',
    !/[<>&"']/.test(playerName()), playerName());
  check('...and the length is the board\'s, not the field\'s',
    savePlayerName('x'.repeat(80)).length === MAX_NAME_LEN, String(playerName().length));

  // Blank must not FORGET a name — every caller today is a field that can be
  // empty for reasons other than intent.
  savePlayerName('Ethan');
  savePlayerName('');
  check('an empty submit does not erase the name', playerName() === 'Ethan', playerName());
  clearPlayerName();
  check('...and clearing really does', playerName() === DEFAULT_PLAYER_NAME, playerName());
}
{
  // The token has to survive being the ONLY thing in a line, and a line with
  // no token at all must not pay for the machinery.
  savePlayerName('Ann');
  check('a bare token is the whole line', expandPlayer('{player}') === 'Ann', expandPlayer('{player}'));
  check('twice in one line, both times', expandPlayer('{player} vs {player}') === 'Ann vs Ann',
    expandPlayer('{player} vs {player}'));
  check('a line with no braces comes back identical',
    expandPlayer('nothing here') === 'nothing here');
  check('an unknown token is left standing, not eaten',
    expandPlayer('hi {whoops}') === 'hi {whoops}', expandPlayer('hi {whoops}'));
  clearPlayerName();
}
{
  // THE CONTROLS, ONE INPUT AT A TIME. The whole shape of the touch and pad
  // tutorial: three lines, each waiting for the one before it to be answered,
  // so the screen never holds two instructions at once.
  for (const device of ['touch', 'pad']) {
    store.clear();
    resetTutorial();
    resetCallouts();
    resetTutorialRun();
    const seen = coachRun((ctx, t) => {
      // A player who takes their time: each input arrives well after the last.
      ctx.moving = t > 5;
      ctx.aiming = t > 10;
      ctx.charging = t > 15;
    }, { seconds: 20, device });
    const order = seen.map((s) => s.id);
    check(`${device}: swimming is taught first`, order[0] === 'swim', order.join(' → '));
    check(`${device}: ...then aiming`, order[1] === 'aim', order.join(' → '));
    check(`${device}: ...then the strike`, order[2] === 'strike', order.join(' → '));
    check(`${device}: each one waits for the last to be answered`,
      seen[1]?.t >= 5 && seen[2]?.t >= 10, seen.map((s) => `${s.id}@${s.t}`).join(' '));
    check(`${device}: and all three are spent`,
      ['swim', 'aim', 'strike'].every((id) => tutorialDone().has(id)),
      [...tutorialDone()].join(','));
  }

  // Never two at once. The band holds one line by construction, but the steps
  // could still be offered on top of each other — which would show as a tip
  // being replaced a frame after it appeared rather than as two lines.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx, t) => {
    ctx.moving = t > 4;
    ctx.aiming = t > 4;   // both inputs arrive together...
    ctx.charging = t > 4; // ...and so does the third
  }, { seconds: 20, device: 'touch' });
  const gaps = seen.slice(1).map((s, i) => +(s.t - seen[i].t).toFixed(2));
  check('three inputs arriving at once still produce three separate lines',
    seen.length === 3, seen.map((s) => `${s.id}@${s.t}`).join(' '));
  check('...spaced by the legibility floor rather than stacked',
    gaps.every((g) => g >= CONFIG.tutorial.minShow - 0.05), gaps.join(', '));
}
{
  // THE LEGIBILITY FLOOR. The case it exists for is a player who answers the
  // line on the frame it appears — with the controls handed out one per input,
  // that is what playing WELL looks like, and without a floor it is what turns
  // the tutorial into three flickers.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx) => {
    ctx.moving = true; // already swimming before the first tip is due
  }, { seconds: 8, device: 'touch' });
  check('a player already swimming is still shown the line',
    seen[0]?.id === 'swim', seen.map((s) => s.id).join(' → '));

  // How long it was actually up. Measured off the band rather than off the
  // step, because the band is what the player is reading.
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  let onScreen = 0;
  const ctx = {
    runTime: 0, device: 'touch', moving: true, aiming: false, charging: false,
    oxygenLow: false, aboveSurface: false, airTime: 0, nearSurface: false, chumInWater: false,
  };
  for (let t = 0; t < 8; t += DT) {
    ctx.runTime = t;
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (bandState.row?.id === 'swim') onScreen += DT;
  }
  check('...and it stays up long enough to read',
    onScreen >= CONFIG.tutorial.minShow - 0.05, `${onScreen.toFixed(2)}s of ${CONFIG.tutorial.minShow}s`);
  check('...but not for its whole hold — answering still ends it early',
    onScreen < holdFor(CALLOUTS.get('swim')) - 0.1,
    `${onScreen.toFixed(2)}s vs a ${holdFor(CALLOUTS.get('swim'))}s hold`);
  check('...and the step is spent', tutorialDone().has('swim'));
}
{
  // The floor is a floor, not a delay: a tip nobody answers still runs its full
  // hold. Otherwise minShow would quietly become the new hold for every line.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const hold = holdFor(CALLOUTS.get('swim'));
  const fade = CONFIG.tutorial.dissipate.seconds;
  let reading = 0;   // up and whole
  let leaving = 0;   // up and dissolving
  const ctx = withSubjects({
    runTime: 0, device: 'touch', moving: false, aiming: false, charging: false,
    oxygenLow: false, aboveSurface: false, airTime: 0, nearSurface: false, chumInWater: false,
  });
  for (let t = 0; t < CONFIG.tutorial.openDelay + hold + fade + 1; t += DT) {
    ctx.runTime = t;
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (bandState.row?.id !== 'swim') continue;
    if (tutorialState.active === 'swim') reading += DT;
    else leaving += DT;
  }
  check('an unanswered tip still runs its full hold',
    Math.abs(reading - hold) < 0.1, `${reading.toFixed(2)}s of ${hold}s`);
  // ...AND IS STILL THERE WHILE IT DISSOLVES. The row has to outlive the step
  // by the length of the fade, or there is nothing on the surface for the
  // dissolve to erode — which on screen is a tip that does not dissipate, it
  // just vanishes. That was the first version of this feature.
  check('...and stays on the band for the dissolve after it',
    Math.abs(leaving - fade) < 0.1, `${leaving.toFixed(2)}s of ${fade}s`);
}
{
  // A keyboard gets neither of the two stick tips, and is not left waiting for
  // them either — `strike` chains off `aim`, so a naive `done.has('aim')` would
  // mean the one control tip a keyboard DOES get never fires at all.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const kbm = coachRun((ctx, t) => {
    ctx.moving = t > 5;
    ctx.aiming = t > 5;
    if (t > 8 && t < 8.05) noteTutorialEvent('strike');
  }, { seconds: 12, device: 'kbm' });
  const order = kbm.map((s) => s.id);
  check('a keyboard is never told about sticks or thumbs',
    !order.includes('swim') && !order.includes('aim'), order.join(' → '));
  check('...and is taught the strike anyway', order[0] === 'strike', order.join(' → '));
}
{
  // The step a device never sees must not hold the coach open forever. Without
  // this, every keyboard player is permanently one step from done — which is
  // not one missing tip, it is the whole system never going quiet.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  coachRun((ctx, t) => {
    ctx.chumInWater = true;
    ctx.moving = t > 3;
    if (t > 4 && t < 4.05) noteTutorialEvent('strike');
    if (t > 8 && t < 8.05) noteTutorialEvent('chum');
    ctx.oxygenLow = t > 12 && t < 15;
    ctx.aboveSurface = t >= 15 && t < 16;
    ctx.nearSurface = t >= 15;
    ctx.airTime = t > 20 ? 0.5 : 0;
    // The water half, each subject arriving and then being dealt with. Every
    // pickup type gets its own window, because the ledger is per type and a run
    // that only ever showed one orb would leave the coach four steps short.
    ctx.feeding = t > 22 && t < 26;
    if (t > 24 && t < 24.05) noteTutorialEvent('chainLink');
    let at = 28;
    for (const kind of ['bubbleOrb', 'strikeOrb', 'rapidFireOrb', 'chumChunk', 'attractorOrb']) {
      setWater(ctx, kind, t > at && t < at + 8);
      if (t > at + 4 && t < at + 4.05) noteTutorialEvent(kind);
      at += 9;
    }
    ctx.chumOnSeabed = t > 74 && t < 82;
    // ...and the turtle SWIMS AWAY again. It has to: nothing can answer this
    // tip, so the animal leaving is now the only thing that ends it, and a run
    // that fades out with one still on screen leaves the last step unspent.
    ctx.unkillableNear = t > 84 && t < 90;
    // The level blob, which is the fifth pickup and is deliberately out of the
    // loop above: it cannot exist until the player is holding a card, so a run
    // meets it after the first level-up rather than alongside the other four.
    setWater(ctx, 'levelOrb', t > 92 && t < 100);
    if (t > 96 && t < 96.05) noteTutorialEvent('levelOrb');
    // A CARD TAKEN, which is what puts anything in the corner at all. The
    // window is short by design — see CONFIG.tutorial.hiveWindow — so this is
    // a pick and then the moment passing, not a flag left on.
    ctx.hiveShown = t > 102;
    ctx.upgradesHeld = t > 102 ? 1 : 0;
    ctx.sinceUpgrade = t > 102 ? t - 102 : Infinity;
    // A boss, with a weak spot inside striking distance, and a crit landing on
    // it. Then the spot ruptures — which is what ends the tip for a player who
    // never hits one.
    ctx.weakSpotInReach = t > 116 && t < 124;
    if (t > 120 && t < 120.05) noteTutorialEvent('bossWeakSpot');
  }, { device: 'kbm', seconds: 130 });
  check('a keyboard player finishes without the two stick steps',
    tutorialComplete('kbm'), [...tutorialDone()].join(','));
  check('...and the same ledger is NOT finished on a phone',
    !tutorialComplete('touch'), [...tutorialDone()].join(','));
  check('...so picking up a phone later still teaches the sticks', (() => {
    resetCallouts();
    resetTutorialRun();
    const seen = coachRun((ctx) => { ctx.moving = false; }, { seconds: 8, device: 'touch' });
    return seen[0]?.id === 'swim';
  })());
}
{
  // The air tip preempts. A chum tip is live when the seal runs out of breath,
  // and the arrow it carries points away from the only thing that matters.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // The air tip has to arrive while the chum tip is genuinely up, so the strike
  // is answered early and given time to be read and to clear — the two are on
  // DIFFERENT surfaces now (the band and the water), and a strike tip still
  // being read would not be preempted by the air tip at all. It would simply be
  // beside it, which is correct and is not what this block is measuring.
  const seen = coachRun((ctx, t) => {
    ctx.chumInWater = true;
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    ctx.oxygenLow = t > 12 && t < 15;
    ctx.aboveSurface = t >= 14 && t < 15;
  }, { seconds: 18 });
  const order = seen.map((s) => s.id);
  check('the chum tip is up first', order.indexOf('chum') >= 0
    && order.indexOf('chum') < order.indexOf('surface'), order.join(' → '));
  check('running out of air takes the surface off whatever was talking',
    order.includes('surface'), order.join(' → '));
  check('...and does it as the air runs out',
    seen.find((s) => s.id === 'surface')?.t < 12.3,
    `${seen.find((s) => s.id === 'surface')?.t}s — ${order.join(' → ')}`);
  check('...and the tip it interrupted is NOT spent',
    !tutorialDone().has('chum') || order.lastIndexOf('chum') > order.indexOf('surface'),
    [...tutorialDone()].join(','));
}
{
  // The ledger. A step done in one run must not be offered in the next; a step
  // that never got its chance must be.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // LONG ENOUGH FOR THE TIP TO FINISH BEING READ. This was 6 seconds, which
  // was comfortably past the old fixed 1.6s floor and is not past the strike
  // line's own: the minimum is derived from the sentence's LENGTH now, so a
  // fifty-character tip is held four seconds even by a player who answers it
  // at once. A run that ends mid-tip leaves the step unspent — correctly — and
  // this block is about the ledger, not about the clock.
  coachRun((ctx, t) => {
    if (t > 4 && t < 4.05) noteTutorialEvent('strike');
  }, { seconds: 14 });
  const afterFirst = tutorialDone();
  check('the step the player answered is done', afterFirst.has('strike'));
  check('...and it was written to storage',
    (localStorage.getItem('sealSurvivor.tips.v1') ?? '').includes('strike'));
  check('the steps that never came up are not', !afterFirst.has('chum') && !afterFirst.has('breach'));

  resetCallouts();
  resetTutorialRun();
  const second = coachRun((ctx, t) => { ctx.chumInWater = true; }, { seconds: 8 });
  check('a new run does not re-teach a finished step',
    !second.some((s) => s.id === 'strike'), second.map((s) => s.id).join(' → '));
  check('...and picks up where it left off',
    second.some((s) => s.id === 'chum'), second.map((s) => s.id).join(' → '));
}
// ---------------------------------------------------------------------------
section('the pace — how long a tip stays, and the quiet after it');
// ---------------------------------------------------------------------------
{
  // A LONG LINE IS HELD LONGER THAN A SHORT ONE. The whole point of deriving
  // the floor from the sentence: a fixed one is either too short to read the
  // food-chain tip or far too long for "Swim up for air", and the table now
  // holds both.
  const short = CALLOUTS.get('surface');
  const long = CALLOUTS.get('foodChain');
  const sMin = legibleFor(short, 'kbm');
  const lMin = legibleFor(long, 'kbm');
  check('a long tip is held longer than a short one', lMin > sMin,
    `${short.id} ${sMin.toFixed(2)}s vs ${long.id} ${lMin.toFixed(2)}s`);
  check('...the short one still gets the floor', sMin >= CONFIG.tutorial.minShow - 1e-9,
    `${sMin.toFixed(2)}s vs floor ${CONFIG.tutorial.minShow}s`);
  check('...and neither outlasts its own hold, or its timer could not end it',
    sMin <= holdFor(short) + 1e-9 && lMin <= holdFor(long) + 1e-9,
    `${lMin.toFixed(2)}s vs hold ${holdFor(long)}s`);
  // The wording is per device, so the timing has to be too — a phone reading
  // the keyboard line's length would hurry its own, longer one.
  const strike = CALLOUTS.get('strike');
  check('the min follows the wording this device is shown',
    legibleFor(strike, 'kbm') !== legibleFor(strike, 'touch'),
    `kbm ${legibleFor(strike, 'kbm').toFixed(2)}s vs touch ${legibleFor(strike, 'touch').toFixed(2)}s`);
}
{
  // ANSWERED ON THE FRAME IT APPEARS, and it still has to be readable. This is
  // the case the floor exists for and the one a confident player hits every
  // time: the tip asks for a thing they are already doing.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({ runTime: 99, device: 'kbm', charging: true });
  let shown = 0;
  for (let t = 0; t < 12 && !tutorialDone().has('strike'); t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (tutorialState.active === 'strike') shown += DT;
  }
  const want = legibleFor(CALLOUTS.get('strike'), 'kbm');
  check('a tip answered instantly is still held for its minimum',
    shown >= want - DT * 2, `${shown.toFixed(2)}s of ${want.toFixed(2)}s`);
  check('...and not for its whole hold, since it was obeyed',
    shown < holdFor(CALLOUTS.get('strike')), `${shown.toFixed(2)}s vs hold ${holdFor(CALLOUTS.get('strike'))}s`);
}
{
  // THE QUIET BETWEEN TIPS. Five pickup tips arriving back to back is one wall
  // of text rather than five things learnt — this is the check that they are
  // spaced. Every collectable in the water at once, all answered, so nothing
  // but the gap decides the timing.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // Each orb has its own window and is swum into inside it — a tip holds its
  // place until its own subject is gone, so four orbs left floating would be
  // one tip up for the whole run rather than four spaced out. The spacing this
  // block measures is the QUIET AFTER a tip ends, which is unchanged.
  const seen = coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    let at = 12;
    for (const k of ['bubbleOrb', 'strikeOrb', 'rapidFireOrb', 'chumChunk']) {
      setWater(ctx, k, t > at && t < at + 8);
      if (t > at + 6 && t < at + 6.05) noteTutorialEvent(k);
      at += 9;
    }
  }, { seconds: 90 });
  const gaps = [];
  for (let i = 1; i < seen.length; i++) gaps.push(seen[i].t - seen[i - 1].t);
  check('every pickup tip still fires', ['bubbleOrb', 'strikeOrb', 'rapidFireOrb', 'chumChunk']
    .every((id) => seen.some((s) => s.id === id)), seen.map((s) => s.id).join(' → '));
  // Against the GAP alone, not gap + the last tip's time on screen: what is
  // being checked is that a line does not land on the frame the last one left,
  // and asserting the whole spacing would be re-deriving the table's holds.
  check('...with real silence between them, not one wall of text',
    gaps.every((g) => g >= CONFIG.tutorial.gap), gaps.map((g) => g.toFixed(2)).join(', '));
}
{
  // ...BUT AN ESCALATION IGNORES IT. Running out of air must not queue behind
  // an explanation of the yellow orb. The gap blocks a step at or below the
  // priority of the one that just spoke, and nothing else.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  // Driven by hand rather than through coachRun, because the moment being
  // tested is one frame wide: the air has to run out AFTER the bubble tip has
  // left the band, so that the quiet it armed is the only thing in the way.
  // Scripted on the clock instead, the air went low while the STRIKE tip was
  // still up, preempted it, and the check passed without ever reaching the gap.
  const ctx = withSubjects({
    runTime: 99, device: 'kbm', charging: true,
    inWater: new Set(['bubbleOrb']),
    oxygenLow: false, aboveSurface: false,
  });
  const step = () => { updateCallouts(DT, {}, true); updateTutorial(DT, ctx, true); };

  // Past the strike tip, then the bubble tip, answered.
  for (let t = 0; t < 30 && !tutorialDone().has('strike'); t += DT) step();
  for (let t = 0; t < 30 && tutorialState.active !== 'bubbleOrb'; t += DT) step();
  check('the bubble tip is up', tutorialState.active === 'bubbleOrb', `${tutorialState.active}`);
  // Swum into, AND out of the water — the two halves of collecting one, and
  // the tip needs both: the event answers it, and the orb being gone is what
  // releases the pin holding it beside the place the orb used to be.
  noteTutorialEvent('bubbleOrb');
  ctx.inWater.delete('bubbleOrb');
  for (let t = 0; t < 30 && tutorialState.active === 'bubbleOrb'; t += DT) step();
  check('...and ends', tutorialDone().has('bubbleOrb'));

  // The band is now free and the quiet is running. Air goes.
  ctx.oxygenLow = true;
  let waited = 0;
  for (; waited < 10 && tutorialState.active !== 'surface'; waited += DT) step();
  check('the air tip arrives during the quiet a lesser tip bought',
    tutorialState.active === 'surface', `${tutorialState.active}`);
  check('...without waiting it out', waited < CONFIG.tutorial.gap,
    `${waited.toFixed(2)}s of a ${CONFIG.tutorial.gap}s gap`);
}
{
  // Dying mid-sentence must not spend the step.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({ runTime: 99, device: 'kbm', chumInWater: true, oxygenLow: false, aboveSurface: false, airTime: 0, nearSurface: false });
  updateCallouts(DT, {}, true);
  updateTutorial(DT, ctx, true);
  check('a tip is talking', tutorialState.active === 'strike');
  updateTutorial(DT, ctx, false); // the seal died
  check('death takes the tip down', tutorialState.active === null);
  check('...without spending it', !tutorialDone().has('strike'));

  // THE SAME PATH THE MENUS USE. main.js hands the coach `live` false whenever
  // the game is paused — the level-up cards and the pause menu are one flag —
  // because the callout layer draws ABOVE the menus by design, and a first-run
  // sentence lying across the three upgrade cards is a line the player has to
  // read past to make a choice.
  //
  // What makes that safe is the half checked below rather than the half above:
  // a tip yanked off by a level-up has to COME BACK, or a player whose first
  // orb arrives one kill before a card is never taught about it at all.
  let back = 0;
  for (; back < 10 && tutorialState.active !== 'strike'; back += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
  }
  check('...and is offered again once the menu closes', tutorialState.active === 'strike',
    `after ${back.toFixed(2)}s — ${tutorialState.active}`);
}
{
  // The clock half of the contract: a tip nobody obeys still ends, and ends
  // DONE — one shot is the whole design.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const hold = holdFor(CALLOUTS.get('strike'));
  const seen = coachRun(() => {}, { seconds: CONFIG.tutorial.openDelay + hold + 1 });
  check('an ignored tip appears', seen.length === 1 && seen[0].id === 'strike');
  check('...times out', tutorialState.active === null);
  check('...and is not offered again', tutorialDone().has('strike'));
}
{
  // Silence forever, once the set is done. The property that makes this safe to
  // ship: after one player's first evening the whole system is inert.
  store.clear();
  resetTutorial();
  // Walk each step to done the cheap way: a full run per step is slow and
  // proves nothing this file has not already proved. The two air steps ask for
  // OPPOSITE conditions — one wants the seal short of breath, the other wants
  // it comfortable — so the context follows the ledger rather than being fixed.
  //
  // On TOUCH, because that is the device every step exists on: the strict
  // tutorialComplete() below asks about all of them, including the two stick
  // tips a keyboard is never offered.
  //
  // Each step is run until it actually leaves the band rather than for a fixed
  // couple of frames: answering a tip no longer clears it on the same frame,
  // and a loop that assumed it did would simply never finish.
  for (let i = 0; i < COACH_IDS.length * 2 && !tutorialComplete(); i++) {
    resetCallouts();
    resetTutorialRun();
    const done = tutorialDone();
    const ctx = withSubjects({
      runTime: 99, device: 'touch',
      moving: false, aiming: false, charging: false,
      chumInWater: true, oxygenLow: !done.has('surface'),
      aboveSurface: false, airTime: 0, nearSurface: true,
      // The water half. Like the air pair above, these follow the ledger: the
      // seabed tip is READY on a floor with chum on it and DONE on one without,
      // so a fixed value would either never offer it or never let it finish.
      inWater: new Set(COACH_IDS), feeding: true,
      chumOnSeabed: !done.has('crab'), unkillableNear: true,
      // The same "follow the ledger" trick the two air steps and the seabed one
      // use, and for the same reason: the weak-spot tip is READY while a spot
      // is in reach, and the hive tip is READY inside the window after a pick.
      // Both are ended by their subject going rather than only by an event, so
      // a fixed `true` here would leave the loop spinning against a tip that is
      // behaving exactly as designed.
      weakSpotInReach: !done.has('bossWeakSpot'),
      hiveShown: true,
      upgradesHeld: 1,
      sinceUpgrade: done.has('hiveStack') ? Infinity : 0,
    });
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (!tutorialState.active) continue;
    // Answer everything at once — whichever step is up, one of these is what it
    // asked for — then hold until it has had its legible moment and gone. The
    // unkillable tip is the exception and needs nothing here: it has no answer,
    // and the inner loop below runs long enough for its own hold to end it,
    // which is exactly how it ends in the game.
    noteTutorialEvent('strike');
    noteTutorialEvent('chum');
    noteTutorialEvent('chainLink');
    // Every pickup type, since each is spent only by its own kind now. Read off
    // the step list rather than typed out, so a sixth pickup added to
    // PICKUP_TIPS cannot leave this loop spinning against a step it has no way
    // to answer — which would show up as a timeout, not as a useful failure.
    for (const id of COACH_IDS) noteTutorialEvent(id);
    ctx.moving = true;
    ctx.aiming = true;
    ctx.charging = true;
    ctx.aboveSurface = true;
    ctx.oxygenLow = false;
    ctx.airTime = 1;
    ctx.chumOnSeabed = false;
    // ...AND THE WATER EMPTIES. Answering is no longer enough for every step:
    // two of them (the attractor field, the turtle) have nothing to answer at
    // all, and what ends those is the thing itself leaving. A loop that only
    // fired events would spin here forever against a tip that is behaving
    // exactly as designed.
    ctx.inWater.clear();
    ctx.chumInWater = false;
    ctx.unkillableNear = false;
    // ...and the boss's spot bursts, and the pick stops being recent. The two
    // tips that have no answer at all (the hive's is a fact, like the turtle's)
    // end on exactly this.
    ctx.weakSpotInReach = false;
    ctx.sinceUpgrade = Infinity;
    for (let f = 0; f < 600 && tutorialState.active; f++) {
      updateCallouts(DT, {}, true);
      updateTutorial(DT, ctx, true);
    }
  }
  check('every step can be completed', tutorialComplete(), [...tutorialDone()].join(','));

  resetCallouts();
  resetTutorialRun();
  const seen = coachRun((ctx) => {
    ctx.chumInWater = true;
    ctx.oxygenLow = true;
    ctx.nearSurface = true;
  }, { seconds: 20, device: 'touch' });
  check('a finished coach never speaks again', seen.length === 0, seen.map((s) => s.id).join(','));
  check('...and leaves the band free for warnings', bandState.row === null);
}
{
  // A stale ledger entry for a step that no longer exists must not be able to
  // suppress anything — this is what makes adding a sixth tip later safe.
  store.clear();
  localStorage.setItem('sealSurvivor.tips.v1', JSON.stringify(['strike', 'a-step-we-deleted']));
  resetCallouts();
  const mod = await import(`../path/src/systems/tutorial.js?reload=${Date.now()}`);
  check('an unknown id in storage is dropped', !mod.tutorialDone().has('a-step-we-deleted'),
    [...mod.tutorialDone()].join(','));
  check('...and the real ones survive', mod.tutorialDone().has('strike'));
}

// ---------------------------------------------------------------------------
section('a tip that stands beside its subject');
// ---------------------------------------------------------------------------
{
  // ONE BUBBLE, HELD. The failure this is about is silent and would look
  // perfectly reasonable on screen: a tip that re-asked "the nearest bubble"
  // every frame would slide from orb to orb as the seal swam, and would never
  // end, because there is always a nearest one.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({
    runTime: 99, device: 'kbm', charging: true,
    inWater: new Set(['bubbleOrb']), subjectX: 4, subjectY: 3,
  });
  const step = () => { updateCallouts(DT, {}, true); updateTutorial(DT, ctx, true); };
  for (let t = 0; t < 30 && !tutorialDone().has('strike'); t += DT) step();
  for (let t = 0; t < 30 && tutorialState.active !== 'bubbleOrb'; t += DT) step();
  check('the bubble tip is up', tutorialState.active === 'bubbleOrb', `${tutorialState.active}`);

  const first = tutorialState.subjectMesh;
  check('...holding an actual object, not a copy of a position', !!first);
  check('...and standing where it is',
    tutorialState.anchor?.x === 4 && tutorialState.anchor?.y === 3,
    JSON.stringify(tutorialState.anchor));

  // THE THING MOVES — a bubble rises — and the words go with it.
  ctx.subjectX = 9;
  ctx.subjectY = 11;
  step();
  check('...and follows it as it drifts',
    tutorialState.anchor?.x === 9 && tutorialState.anchor?.y === 11,
    JSON.stringify(tutorialState.anchor));
  check('...still the same object', tutorialState.subjectMesh === first);

  // WELL PAST THE ROW'S OWN HOLD, and short of the ceiling. This is the pin
  // doing its job, and it is the whole feature: the sentence is still there
  // because the bubble is.
  //
  // THE WINDOW HAS TWO EDGES NOW. CONFIG.tutorial.maxShow ends any tip whose
  // subject never goes, so "long past its hold" has to be measured somewhere
  // between the two rather than at an arbitrary multiple — and it is measured
  // off the row's real age rather than off a frame count, because the tip was
  // already a few frames old when this block took hold of it.
  const hold = holdFor(CALLOUTS.get('bubbleOrb'));
  const ceiling = CONFIG.tutorial.maxShow;
  const row = CALLOUTS.get('bubbleOrb');
  const past = (hold + ceiling) / 2;
  for (let guard = 0; calloutAge(row) < past && guard < 4000; guard++) step();
  check('a tip outlives its hold while its subject is there',
    tutorialState.active === 'bubbleOrb', `after ${past.toFixed(1)}s of a ${hold}s hold`);

  // AND THE BUBBLE IS POPPED. The words hold the place it was in — they have to
  // be readable — and the object is dropped on the same frame, because
  // something is lighting it up.
  const where = { ...tutorialState.anchor };
  noteTutorialEvent('bubbleOrb');
  ctx.inWater.delete('bubbleOrb');
  step();
  check('...the light goes out the moment the thing is taken',
    tutorialState.subjectMesh === null);
  check('...but the words stay exactly where it was',
    tutorialState.anchor?.x === where.x && tutorialState.anchor?.y === where.y,
    JSON.stringify(tutorialState.anchor));
  for (let t = 0; t < 12 && tutorialState.active === 'bubbleOrb'; t += DT) step();
  check('...and then the tip is done', tutorialDone().has('bubbleOrb'));
}
{
  // THE DISSOLVE IS PART OF THE LINE, not something that happens after it. The
  // row stays on its surface for the whole of it — a tip that vanished on the
  // frame it was answered would have no exit at all, and the mask would be
  // drawn over an empty element.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({
    runTime: 99, device: 'kbm', charging: true, inWater: new Set(['bubbleOrb']),
  });
  const step = () => { updateCallouts(DT, {}, true); updateTutorial(DT, ctx, true); };
  for (let t = 0; t < 60 && tutorialState.active !== 'bubbleOrb'; t += DT) step();
  check('the bubble tip is up again', tutorialState.active === 'bubbleOrb');
  check('...and is not dissolving while it stands there', tutorialState.fade === 0);

  noteTutorialEvent('bubbleOrb');
  ctx.inWater.delete('bubbleOrb');
  for (let t = 0; t < 12 && tutorialState.active; t += DT) step();
  const row = CALLOUTS.get('bubbleOrb');
  check('the step ends before the picture of it does', tutorialState.active === null);
  check('...with the words still on their surface', bandStates.world.row === row);
  check('...and the dissolve just started', tutorialState.fade < 0.2,
    String(tutorialState.fade.toFixed(2)));

  const seconds = CONFIG.tutorial.dissipate.seconds;
  for (let t = 0; t < seconds * 0.5; t += DT) step();
  check('...running while the line is still there',
    tutorialState.fade > 0.2 && bandStates.world.row === row,
    `${tutorialState.fade.toFixed(2)} / ${bandStates.world.row?.id}`);
  for (let t = 0; t < seconds; t += DT) step();
  check('...and the line goes when it finishes', bandStates.world.row === null);
  check('...leaving nothing behind to draw', tutorialState.fade === 0);
}
{
  // DYING CUTS IT OFF RATHER THAN DISSOLVING IT. A sentence eroding gently
  // through the game-over card is the wrong thing happening at the wrong
  // moment — and the step must not be spent either, which is the older rule
  // this one has to keep.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = withSubjects({
    runTime: 99, device: 'kbm', charging: true, inWater: new Set(['bubbleOrb']),
  });
  for (let t = 0; t < 60 && tutorialState.active !== 'bubbleOrb'; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
  }
  check('a tip is up before the seal dies', tutorialState.active === 'bubbleOrb');
  updateTutorial(DT, ctx, false);
  check('death takes it down at once', tutorialState.active === null
    && bandStates.world.row === null);
  check('...with no dissolve left running', tutorialState.fade === 0);
  check('...and without spending it', !tutorialDone().has('bubbleOrb'));
}

{
  // THE PAN CANNOT SLIDE THE FIELD OUT OF THE FILTER.
  //
  // This is the bug that made the whole feature look like it was hiding the
  // text rather than dissolving it. The flow is an feOffset applied to a
  // turbulence result, and that result only exists inside the filter's region —
  // so an offset past the region's padding drags empty space over the type, the
  // alpha stencil comes out transparent everywhere, and `feComposite in`
  // renders NOTHING. Every number on the element still says it is fine:
  // opacity 1, a live filter, a sensible mask.
  //
  // Two things stop it: the caller hands in the dissolve's OWN elapsed time
  // (a second at most), and the clamp below survives a `flow` slider wound to
  // the top on top of that.
  initTipDissolve(document.body);
  const node = document.createElement('span');
  document.body.appendChild(node);
  const dyOf = (id) => parseFloat(document.querySelector(`#${id} feOffset`).getAttribute('dy'));
  applyTipDissolve(node, 'warp', 0.5, 1000, { ...TIP_DISSOLVE_DEFAULTS, flow: 80 });
  // jsdom gives every element a zero box, so panFor falls back to its own floor
  // of 24px of line height — which is what the bound is measured against here.
  check('an absurd clock cannot pan the field out of the filter',
    dyOf('sv-tip-warp') >= -24 * 0.8 - 1e-6, `dy ${dyOf('sv-tip-warp')}`);
  applyTipDissolve(node, 'ink', 0.5, 1000, { ...TIP_DISSOLVE_DEFAULTS, flow: 80 });
  check('...on the style that does not cut, either', dyOf('sv-tip-ink') >= -24 * 0.8 - 1e-6,
    `dy ${dyOf('sv-tip-ink')}`);
  // ...and it still MOVES at ordinary settings, or the clamp has quietly turned
  // the flow off and the noise is a static texture being faded.
  applyTipDissolve(node, 'warp', 0.5, 0.35, TIP_DISSOLVE_DEFAULTS);
  const moved = dyOf('sv-tip-warp');
  check('...but it does still flow at the shipped numbers', moved < -1 && moved > -19,
    `dy ${moved}`);
  node.remove();
}

// ---------------------------------------------------------------------------
section('lighting up what the tip is about');
// ---------------------------------------------------------------------------
{
  // The pulse. It starts and ends at the object's OWN brightness rather than at
  // the peak: a highlight that flashed on the frame it appeared would be
  // speaking the language the game already uses for damage.
  const rest = telegraphPulse(0);
  check('the pulse starts at the colour the thing already has', Math.abs(rest - 1) < 1e-9,
    String(rest));
  const hz = CONFIG.tutorial.telegraph.hz;
  const peak = telegraphPulse(0.5 / hz);
  check('...and swells to the boost', Math.abs(peak - CONFIG.tutorial.telegraph.boost) < 1e-6,
    `${peak.toFixed(2)} vs ${CONFIG.tutorial.telegraph.boost}`);
  check('...and comes back down', Math.abs(telegraphPulse(1 / hz) - 1) < 1e-6);
  let below = false;
  for (let i = 0; i <= 64; i++) if (telegraphPulse(i / 32 / hz) < 1 - 1e-9) below = true;
  check('...never dimmer than it was', !below);
}
{
  // ONE THING AT A TIME, and everything else untouched. The multiplier is read
  // from inside the pickup loops, so a version that answered for the wrong mesh
  // would light the whole arena.
  const orb = { name: 'orb', position: { x: 0, y: 0 } };
  const other = { name: 'other', position: { x: 0, y: 0 } };
  setTelegraph(orb, 'ask');
  updateTelegraph(0.5 / CONFIG.tutorial.telegraph.hz);
  check('the subject is pushed', telegraphMul(orb) > 1.5, String(telegraphMul(orb)));
  check('...and nothing else is', telegraphMul(other) === 1 && telegraphMul(null) === 1);
  setTelegraph(null);
  check('...and nothing at all once the tip is done', telegraphMul(orb) === 1);
}
{
  // THE PAINT PATH, which is the one that can do damage: the three floating
  // orbs share one material with every other orb of their kind, so the pulse
  // has to be written to a CLONE and the shared one put back afterwards.
  // Getting this wrong lights every bubble in the arena and then leaves them
  // all lit.
  const shared = { color: makeColor(0.2, 0.4, 0.6), userData: {}, clone() {
    return { color: this.color.clone(), userData: {}, disposed: false,
      dispose() { this.disposed = true; } };
  } };
  const mesh = { material: shared, userData: {} };
  setTelegraph(mesh, 'paint');
  const clone = mesh.material;
  check('a shared material is not written to', clone !== shared);
  updateTelegraph(0.5 / CONFIG.tutorial.telegraph.hz);
  check('...the clone is', mesh.material.color.r > 0.2 * 1.5,
    String(mesh.material.color.r));
  check('...and the shared one is exactly as it was',
    Math.abs(shared.color.r - 0.2) < 1e-9, String(shared.color.r));
  setTelegraph(null);
  check('the object gets its own material back', mesh.material === shared);
  // ...and the copy is actually let go of. A clone per tip is four materials a
  // run and would never be noticed; the reason to check is that the same line
  // is what proves `release` ran at all rather than merely dropping the
  // reference.
  check('...and the clone is disposed of', clone.disposed === true);
}
{
  // A MATERIAL WITH AN INJECTED SHADER IS LEFT ALONE. A clone drops
  // onBeforeCompile outright, so a bubble's fresnel shell would render as a
  // flat blob for exactly as long as the tip explaining it was up — which is
  // the worst possible moment for it.
  const shell = { color: makeColor(1, 1, 1), userData: {}, clone() { return this; } };
  shell.onBeforeCompile = () => {};
  const mesh = { material: shell, userData: {} };
  setTelegraph(mesh, 'paint');
  updateTelegraph(0.5 / CONFIG.tutorial.telegraph.hz);
  check('a material with an injected shader is not cloned or painted',
    mesh.material === shell && Math.abs(shell.color.r - 1) < 1e-9, String(shell.color.r));
  setTelegraph(null);
}
{
  // The switch. It is in the Text panel with everything else about how a tip
  // looks, and it has to actually reach the pulse.
  const was = CONFIG.tutorial.telegraph.enabled;
  CONFIG.tutorial.telegraph.enabled = false;
  const orb = { name: 'orb' };
  setTelegraph(orb, 'ask');
  updateTelegraph(0.5 / CONFIG.tutorial.telegraph.hz);
  check('the highlight can be switched off', telegraphMul(orb) === 1);
  CONFIG.tutorial.telegraph.enabled = was;
  setTelegraph(null);
}

// ---------------------------------------------------------------------------
section('what the UI is handed');
// ---------------------------------------------------------------------------
{
  resetCallouts();
  check('nothing to draw when the band is empty', activeCallout() === null);
  // Read off the WORLD surface, which is where a tip about a place or a thing
  // now lives. Asking the band for it is how this block failed the first time
  // the anchors moved, and that is the failure being kept: activeCallout is
  // per surface, and a caller looking at the wrong one gets a confident null.
  pushCallout(CALLOUTS.get('surface'));
  updateCallouts(0.2, {}, false);
  const c = activeCallout('world');
  check('a live callout reports its words', c?.text === CALLOUTS.get('surface').text);
  check('...its kind, so the tip can be coloured apart from an alarm', c.kind === 'coach');
  check('...what it is about', c.subject === 'surface');
  check('...its age and the hold that age is measured against',
    c.age > 0.15 && c.hold === holdFor(CALLOUTS.get('surface')));
  check('...and the band is untouched by any of it', activeCallout('band') === null);
}

// ---------------------------------------------------------------------------
section('drawing it, and where the arrow points');
// ---------------------------------------------------------------------------
{
  const root = document.createElement('div');
  root.className = 'sv-ui';
  document.body.appendChild(root);
  initCallouts(root);

  const band = root.querySelector('.sv-callout');
  const boost = root.querySelector('.sv-callout-boost');
  const world = root.querySelector('.sv-callout-world');
  // SCOPED TO THE WORLD TIP. Both surfaces have an ink node now — the band's
  // control tips dissolve too — so a bare '.sv-callout-ink' finds the band's,
  // and every check below would be reading the wrong line's words.
  const worldInk = root.querySelector('.sv-callout-world .sv-callout-ink');
  const bandInk = root.querySelector('.sv-callout > .sv-callout-ink');
  const arrow = root.querySelector('.sv-callout-arrow');
  check('the band, the seal line, the world tip and the arrow are built once',
    !!band && !!boost && !!world && !!worldInk && !!arrow);
  check('...and sit above the menus in the layer order',
    root.lastChild.className === 'sv-callout-layer');

  // A real camera, because the aim is a projection and a fake one would be
  // testing this harness's arithmetic rather than the game's. Orthographic and
  // square onto the arena, so a world point above the seal is a screen point
  // above it and nothing else is in play.
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const at = (el, prop) => parseFloat(el.style[prop]);

  // --- THE HIVE TIP'S ANCHOR: a rectangle on the glass, said in world units ---
  //
  // Every callout is positioned FROM a world point (see drawWorld), so the one
  // tip about a piece of UI has to convert its corner into one. That conversion
  // is the whole of the feature and it is arithmetic: if it is wrong the label
  // stands somewhere else on the screen entirely, which is invisible to every
  // other check in this file and looks like a tip about nothing.
  //
  // A ROUND TRIP, because that is the claim — screenToWorld is the inverse of
  // the projection the layer already uses, on the z = 0 plane the game is
  // played on. Asserting a hand-computed world coordinate instead would be
  // re-deriving the camera's own arithmetic and would agree with a wrong
  // implementation that made the same mistake.
  {
    const back = { x: 0, y: 0 };
    const fwd = { x: 0, y: 0 };
    let worst = 0;
    for (const [px, py] of [[0, 0], [640, 360], [1280, 720], [17, 703], [1263, 9]]) {
      screenToWorld(camera, px, py, back);
      worldToScreen(camera, back.x, back.y, fwd);
      worst = Math.max(worst, Math.abs(fwd.x - px), Math.abs(fwd.y - py));
    }
    check('a point on the glass converts to the water and back', worst < 0.01,
      `worst round trip ${worst.toFixed(4)}px`);
    // ...AND IT IS NOT THE IDENTITY. A screenToWorld that returned its input
    // would pass the round trip against a worldToScreen that also did nothing,
    // and the hive tip would sit in the middle of the ocean.
    screenToWorld(camera, 0, 0, back);
    check('...and the two are really different spaces',
      Math.abs(back.x) > 1 && Math.abs(back.y) > 1, `${back.x.toFixed(2)}, ${back.y.toFixed(2)}`);
  }

  // --- a warning: words, colour class, no arrow ---
  resetCallouts();
  pushCallout(CALLOUTS.get('oxygen'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: -5, surfaceY: 0 });
  check('the band carries the row\'s words', band.textContent === CALLOUTS.get('oxygen').text,
    band.textContent);
  check('a warning is not wearing the tip class', !band.className.includes('sv-callout-coach'),
    band.className);
  check('...and is on screen', !band.className.includes('sv-hidden'));
  check('the band sits where the config says',
    Math.abs(at(band, 'top') - CONFIG.callouts.y * window.innerHeight) < 25,
    `${band.style.top} of ${window.innerHeight}px`);
  check('a row with no arrow draws no arrow', arrow.className.includes('sv-hidden'));

  // --- the device reaches the element the player actually reads ---
  // Everything above this is the resolution in the abstract; this is the wire
  // from `ctx.device` all the way to the text node, which is the only part the
  // player sees and the part a wrong argument name would silently break.
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('strike'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, device: 'touch' });
  const touchLine = band.textContent;
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, device: 'pad' });
  const padLine = band.textContent;
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, device: 'kbm' });
  check('the band is worded for the device it was handed',
    touchLine === CALLOUTS.get('strike').deviceText.touch, touchLine);
  check('...and re-words when the device changes mid-line', padLine !== touchLine, padLine);
  check('...with the keyboard line naming the real binding',
    band.textContent.includes('Space'), band.textContent);
  check('a caller that says nothing about devices still gets words', (() => {
    updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
    return band.textContent === calloutText(CALLOUTS.get('strike'), undefined)
      .replace('{strike}', 'Space');
  })(), band.textContent);

  // --- A TIP BESIDE THE THING IT IS ABOUT ---
  // The feature, drawn: the words are not on the band at all any more, they are
  // in the water next to their subject. `tipAnchor` is the world position the
  // coach is holding — see tutorialState.anchor.
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('bubbleOrb'));
  const sealX = window.innerWidth / 2;
  const sealY = window.innerHeight / 2;
  // The camera above spans 40 world units, so this is the scale every position
  // check below is written against rather than in pixels.
  const perUnitX = window.innerWidth / 40;
  const perUnitY = window.innerHeight / 40;
  updateCalloutUi(0.016, {
    camera, playerX: 0, playerY: 0, tipAnchor: { x: 6, y: 0 }, tipFade: 0,
  });
  check('a world tip is drawn out in the water',
    !world.className.includes('sv-hidden') && worldInk.textContent === CALLOUTS.get('bubbleOrb').text,
    worldInk.textContent);
  check('...and the band is left empty for the warnings',
    band.className.includes('sv-hidden'), band.className);
  {
    // ON the thing horizontally, ABOVE it vertically. The horizontal check is
    // the one that matters most: a label a hundred pixels to the side of four
    // similar orbs is a label about none of them.
    const boxW = world.offsetWidth || 0;
    const cx = at(world, 'left') + boxW / 2;
    const wantX = sealX + 6 * perUnitX;
    check('...centred on its subject', Math.abs(cx - wantX) < 8,
      `${cx.toFixed(0)}px vs ${wantX.toFixed(0)}px`);
    check('...and above it, not on top of it', at(world, 'top') < sealY - 10,
      `top ${at(world, 'top').toFixed(0)} vs subject ${sealY}`);
  }
  {
    // A SUBJECT NEAR THE TOP OF THE SCREEN. Bubbles rise, so this is the common
    // case rather than an edge one: there is no room above, and a label clamped
    // to the ceiling would be sitting on the very thing it is pointing out.
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 0, y: 19 }, tipFade: 0,
    });
    const subjectY = sealY - 19 * perUnitY;
    check('a tip whose subject is at the top of the frame flips below it',
      at(world, 'top') > subjectY, `top ${at(world, 'top').toFixed(0)} vs subject ${subjectY.toFixed(0)}`);
  }
  {
    // THE ARROW HUGS THE THING. Not a pointer from the seal any more: it stands
    // a couple of dozen pixels off the subject with its nose in it, on the side
    // the words are on, so the sentence, the mark and the object are one look.
    //
    // The distance is asserted against the config rather than against a pixel
    // literal, because the whole claim is "close to the thing" and a hardcoded
    // number would keep passing after somebody tuned the gap out to arm's
    // length.
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 4, y: 2 }, tipFade: 0,
    });
    const size = CONFIG.callouts.arrow.size;
    const ax = at(arrow, 'left') + size / 2;
    const ay = at(arrow, 'top') + size / 2;
    const tx = sealX + 4 * perUnitX;
    const ty = sealY - 2 * perUnitY;
    check('a subject in plain sight is marked', !arrow.className.includes('sv-hidden'),
      arrow.className);
    const off = Math.hypot(ax - tx, ay - ty);
    check('...by an arrow hugging it', Math.abs(off - CONFIG.callouts.arrow.hug)
      <= CONFIG.callouts.arrow.bobDistance, `${off.toFixed(0)}px off the subject`);
    // ON THE SIDE THE WORDS ARE ON, which is what makes the pair read as one
    // object. The tip stands above its subject here, so the arrow is above it
    // too — between the two, not on the far side pointing back through it.
    check('...on the words\' side of it', ay < ty, `arrow ${ay.toFixed(0)} vs subject ${ty.toFixed(0)}`);
    check('...and standing off it, not on it', off > size / 4, `${off.toFixed(0)}px`);
  }
  {
    // OFF THE EDGE. THE WORDS HOLD THE POSITION THEY LAST STOOD IN. They used
    // to be clamped to the frame, which meant a player swimming away dragged
    // the sentence to the border and it lived out its stay pinned there — the
    // tip stopped being a label in the water and became a piece of HUD stuck to
    // the edge of the screen.
    //
    // Two claims, and the second is the one that keeps this honest: it does not
    // MOVE, and it does not DISAPPEAR. Either alone is satisfiable by a bug.
    const wasLeft = at(world, 'left');
    const wasTop = at(world, 'top');
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 60, y: 0 }, tipFade: 0,
    });
    check('a subject off the edge leaves its words exactly where they were',
      Math.abs(at(world, 'left') - wasLeft) < 0.5 && Math.abs(at(world, 'top') - wasTop) < 0.5,
      `${at(world, 'left').toFixed(0)},${at(world, 'top').toFixed(0)} `
      + `vs ${wasLeft.toFixed(0)},${wasTop.toFixed(0)}`);
    check('...and still on screen', !world.className.includes('sv-hidden'), world.className);
    // ...AND IT DOES NOT SLIDE ALONG THE BORDER EITHER. A second frame with the
    // subject further out is the shape the old clamp had: it kept re-solving
    // against the anchor every frame, so the box crept while the player swam.
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 400, y: -90 }, tipFade: 0,
    });
    check('...and does not creep as the subject gets further away',
      Math.abs(at(world, 'left') - wasLeft) < 0.5 && Math.abs(at(world, 'top') - wasTop) < 0.5,
      `${at(world, 'left').toFixed(0)},${at(world, 'top').toFixed(0)}`);
    // NO ARROW OUT THERE. An arrow at the border pointing at water the player
    // cannot see is the long-range pointer this stopped being.
    check('...and grows no arrow for a subject nobody can see',
      arrow.className.includes('sv-hidden'), arrow.className);
  }
  {
    // AND IT PICKS ITS SUBJECT BACK UP. Parking is for the frames the thing is
    // gone from; swimming back has to hand the label to it again, or the tip
    // spends the rest of its stay beside nothing.
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: -8, y: 3 }, tipFade: 0,
    });
    const boxW = world.offsetWidth || 0;
    const cx = at(world, 'left') + boxW / 2;
    const wantX = sealX - 8 * perUnitX;
    check('a subject back on screen takes its words back',
      Math.abs(cx - wantX) < 8, `${cx.toFixed(0)}px vs ${wantX.toFixed(0)}px`);
  }
  {
    // THE MARK FOLLOWS THE WORDS ROUND THE SUBJECT, and this is the one part of
    // the aiming that can be wrong rather than merely ugly. A tip whose subject
    // is near the top of the frame flips BELOW it — there is no room above — and
    // the arrow has to flip with it. An arrow left on the old side is drawn
    // through the object it is marking, from the far side, pointing away from
    // the sentence that sent it.
    //
    // A waterline near the top of the screen rather than far above it: the
    // surface tip is the case this path was written for, and now the arrow only
    // exists while the thing is on the glass.
    //
    // clearCalloutUi first so the bearing SNAPS rather than easing round from
    // whatever the last block left it at — the ease is a look, and testing it
    // here would be testing turnRate instead of the side.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('surface'));
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 0, y: 19 }, tipFade: 0,
    });
    const size = CONFIG.callouts.arrow.size;
    const ax = at(arrow, 'left') + size / 2;
    const ay = at(arrow, 'top') + size / 2;
    const ty = sealY - 19 * perUnitY;
    check('the surface arrow is drawn', !arrow.className.includes('sv-hidden'));
    check('...under its subject, the side the words flipped to', ay > ty,
      `arrow y ${ay.toFixed(0)} vs subject ${ty.toFixed(0)}`);
    check('...still hugging it', Math.abs(Math.hypot(ax - sealX, ay - ty)
      - CONFIG.callouts.arrow.hug) <= CONFIG.callouts.arrow.bobDistance,
      `${Math.hypot(ax - sealX, ay - ty).toFixed(0)}px off the waterline`);
    // AND ITS NOSE IS IN THE THING. The glyph points up at rest, so the aim is
    // the rotation less a quarter turn; from below its subject that is upward,
    // which in screen space is an angle of about -π/2.
    const rot = parseFloat(/rotate\(([-0-9.]+)rad\)/.exec(arrow.style.transform)?.[1] ?? 'NaN');
    const aim = rot - Math.PI / 2;
    check('...and points at it, not away from it', Math.abs(Math.sin(aim) + 1) < 0.2,
      `aim ${aim.toFixed(2)}rad`);
  }
  {
    // ...AND THERE IS NO MARK AT ALL FOR A SUBJECT OFF THE SCREEN. The seabed
    // is the case that used to draw a long pointer down past the seal. The
    // words about it still stand where they were (checked above); an arrow at
    // the border aimed at floor nobody can see is a direction, and direction is
    // the one thing a label standing on its subject does not need to give.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('crab'));
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 0, y: -60 }, tipFade: 0,
    });
    check('a subject below the floor of the frame is not marked',
      arrow.className.includes('sv-hidden'), arrow.className);
    check('...but its words are still up', !world.className.includes('sv-hidden'),
      world.className);
  }
  {
    // A TIP WITH NOWHERE TO STAND DRAWS NOTHING. The anchor going null means the
    // coach has no subject for a world row, which is a bug in the coach — and
    // falling back to the middle of the screen would hide it behind something
    // that looks deliberate.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('bubbleOrb'));
    updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, tipAnchor: null });
    check('a world tip with no anchor is not drawn', world.className.includes('sv-hidden'));
    check('...and does not fall back onto the band', band.className.includes('sv-hidden'));
  }
  {
    // THE TIP IS VISIBLE WHILE IT DISSOLVES, and this is the check that pays
    // for itself. Every coach line is pinned, so its age runs past its own
    // hold — and the motion block's departure window is measured BACKWARDS
    // FROM THE END OF LIFE, so with the row's hold passed as that life the out
    // curve opened while the tip was still meant to be read and took the alpha
    // to zero. The tip went invisible at its hold and the dissolve then played
    // out, correctly and completely, on something nobody could see: on screen
    // the text did not dissipate at all, it was simply hidden.
    //
    // Sampled well past the hold, which is where the old code returned 0.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('bubbleOrb'));
    pinCallout(CALLOUTS.get('bubbleOrb'), true);
    const hold = holdFor(CALLOUTS.get('bubbleOrb'));
    for (let t = 0; t < hold * 2; t += DT) updateCallouts(DT, {}, true);
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 4, y: 0 }, tipFade: 0,
    });
    check('a pinned tip is still visible long past its hold',
      parseFloat(world.style.opacity) > 0.9,
      `opacity ${world.style.opacity} after ${(hold * 2).toFixed(1)}s of a ${hold}s hold`);
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 4, y: 0 }, tipFade: 0.4,
    });
    check('...and while it is being eaten', parseFloat(world.style.opacity) > 0.9,
      `opacity ${world.style.opacity}`);
    // The same trap on the band, where the control tips live.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('strike'));
    pinCallout(CALLOUTS.get('strike'), true);
    for (let t = 0; t < holdFor(CALLOUTS.get('strike')) * 2; t += DT) updateCallouts(DT, {}, true);
    updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, tipFade: 0.4 });
    check('a band tip is visible past its hold too',
      parseFloat(band.style.opacity) > 0.9, `opacity ${band.style.opacity}`);
    check('...and dissolves rather than fading', !!bandInk.style.filter || !!bandInk.style.maskImage,
      `${bandInk.style.filter} / ${bandInk.style.maskImage}`);
    // A WARNING IS NOT A TIP. It keeps its clock and its departure curve — an
    // alarm eroding into the water reads the room exactly backwards, and it
    // must not pick up a dissolve from the shared node either.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('boss'));
    updateCallouts(holdFor(CALLOUTS.get('boss')) * 0.98, {}, true);
    updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, tipFade: 0.5 });
    check('a warning still fades out on its own clock',
      parseFloat(band.style.opacity) < 0.5, `opacity ${band.style.opacity}`);
    check('...and is never dissolved', !bandInk.style.filter && !bandInk.style.maskImage,
      `${bandInk.style.filter} / ${bandInk.style.maskImage}`);
  }
  {
    // THE DISSOLVE. What is asserted is the WIRING — that progress reaches the
    // inner node and that zero leaves plain text behind — not what the water
    // looks like, which is what `npm run looks:tip` is for.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('bubbleOrb'));
    const draw = (fade) => updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, tipAnchor: { x: 4, y: 0 }, tipFade: fade,
    });
    draw(0);
    check('a tip standing there is plain text',
      !worldInk.style.filter && !worldInk.style.maskImage,
      `${worldInk.style.filter} / ${worldInk.style.maskImage}`);
    draw(0.5);
    check('...and half way out it is being eaten',
      !!worldInk.style.filter || !!worldInk.style.maskImage,
      `${worldInk.style.filter} / ${worldInk.style.maskImage}`);
    // THE INNER NODE, NOT THE OUTER ONE. They are separate so that the arrival
    // curve and the dissolve are not two writers on one transform — and the
    // symptom of getting that wrong is a tip that snaps to full size on the
    // frame it starts to leave.
    check('...on the inner node, leaving the pose alone',
      world.style.transform.includes('scale'), world.style.transform);
    draw(0);
    check('...and it goes back to plain text when it is not leaving',
      !worldInk.style.filter && !worldInk.style.maskImage,
      `${worldInk.style.filter} / ${worldInk.style.maskImage}`);
  }

  // --- the line on the seal ---
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('boost'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, surfaceY: 10 });
  check('the seal line carries its words', boost.textContent === CALLOUTS.get('boost').text,
    boost.textContent);
  check('...on screen', !boost.className.includes('sv-hidden'));
  check('...and the band stayed empty', band.className.includes('sv-hidden'));
  {
    // ABOVE THE RING, not on the seal. The ring's outer edge is
    // strike.ring.radius * scale in world units; the line has to clear it by
    // callouts.ringGap, and the whole box hangs UPWARD off that anchor.
    const ring = CONFIG.strike.ring;
    const sealScreenY = window.innerHeight / 2;
    const top = parseFloat(boost.style.top);
    check('the seal line hangs upward off its anchor',
      boost.style.transform.includes('-100%'), boost.style.transform);
    check('...clear of the boost ring, not on it', top < sealScreenY - 10,
      `top ${top.toFixed(0)} vs seal ${sealScreenY}`);
    // Derived from the ring rather than compared to a literal, so moving the
    // ring moves this expectation with it — which is the point of measuring
    // off the ring in the first place.
    const wantWorld = ring.radius * (ring.scale ?? 1) + CONFIG.callouts.ringGap;
    const perWorldUnit = window.innerHeight / 40; // the camera below spans 40 units
    check('...by the gap the panel asked for',
      Math.abs((sealScreenY - top) - wantWorld * perWorldUnit) < 8,
      `${(sealScreenY - top).toFixed(0)}px vs ${(wantWorld * perWorldUnit).toFixed(0)}px`);
  }
  {
    // The bloom really reaches the element, and really goes away.
    const hot = boost.style.filter;
    check('it arrives wearing a bloom', hot.includes('drop-shadow'), hot || 'none');
    updateCallouts(holdFor(CALLOUTS.get('boost')) / 2, {}, false);
    updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
    check('...and sheds it once it has been noticed', boost.style.filter === 'none',
      boost.style.filter);
  }

  // --- the OTHER line on the ring, which is not the same kind of line ---
  //
  // "STRIKE NOW!" shares this slot with "Boost Empty!" and is a completely
  // different message: the gauge is reporting a fact you can act on whenever,
  // and this is the FOOD CHAIN asking for an input inside a tenth of a second
  // (CONFIG.strike.charge.sweetFraction). Dressed as the chain, therefore —
  // and the thing worth pinning is that it is dressed DIFFERENTLY, because
  // the failure is silent: two urgent lines in one place in one typeface, and
  // the player learns neither.
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('strikeNow'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
  check('the strike prompt takes the ring slot',
    boost.textContent === CALLOUTS.get('strikeNow').text, boost.textContent);
  check('...wearing both classes, so its own rule can win',
    boost.className.includes('sv-callout-boost') && boost.className.includes('sv-callout-strike'),
    boost.className);
  check('...and a colour written inline, off the live chain',
    boost.style.color === chainCss(liveChain()), `${boost.style.color} vs ${chainCss(liveChain())}`);
  // The wheel really is live: three links in, the prompt has moved with it.
  strikeState.chainCount = 3;
  strikeState.chainTimer = CONFIG.strike.chainWindow;
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
  check('...which moves as the chain deepens',
    boost.style.color === chainCss(3) && chainCss(3) !== chainCss(0),
    `${boost.style.color} vs ${chainCss(3)}`);
  resetStrike();

  // ...and the gauge's line does NOT inherit it, or "Boost Empty!" would come
  // up wearing whatever hue the last chain happened to die on and the role's
  // own gold would never be seen.
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('boost'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
  check('the gauge line is not dressed as the chain',
    !boost.className.includes('sv-callout-strike'), boost.className);
  check('...and carries no inline colour of its own', boost.style.color === '',
    boost.style.color || '(empty)');

  // --- both surfaces at once ---
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('boss'));
  pushCallout(CALLOUTS.get('boost'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
  check('both lines can be on screen together',
    !band.className.includes('sv-hidden') && !boost.className.includes('sv-hidden'));
  check('...saying different things', band.textContent !== boost.textContent,
    `${band.textContent} / ${boost.textContent}`);

  // --- nothing anywhere, nothing on screen ---
  resetCallouts();
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0 });
  check('an empty band draws nothing', band.className.includes('sv-hidden')
    && boost.className.includes('sv-hidden') && arrow.className.includes('sv-hidden'));
}

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}`);
process.exit(failures ? 1 : 0);
