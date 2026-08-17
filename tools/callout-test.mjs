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
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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
  CALLOUTS, WARN_IDS, bandState, bandStates, resetCallouts, updateCallouts, activeCallout,
  pushCallout, clearCallout, holdFor, checkCalloutBindings,
} = await import('../path/src/systems/callouts.js');
const { settings, bindKey } = await import('../path/src/systems/settings.js');
const {
  playerName, loadPlayerName, savePlayerName, clearPlayerName, expandPlayer,
  sanitizeName, DEFAULT_PLAYER_NAME, MAX_NAME_LEN,
} = await import('../path/src/systems/playerName.js');
const { DEVICES } = await import('../path/src/devices.js');
const {
  COACH_IDS, updateTutorial, resetTutorial, resetTutorialRun, noteTutorialEvent,
  tutorialState, tutorialDone, tutorialComplete,
} = await import('../path/src/systems/tutorial.js');
const {
  parseCalloutCsv, checkCalloutIds, calloutText, calloutOnDevice,
} = await import('../path/src/calloutTable.js');
const { initCallouts, updateCalloutUi, clearCalloutUi } = await import('../path/src/ui/callout.js');
const { popupPose } = await import('../path/src/ui/ui.js');
const { TEXT_ROLES } = await import('../path/src/textRoles.js');
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
  const stray = [...CALLOUTS.values()].filter(
    (r) => !(r.kind === 'warn' ? WARN_IDS : COACH_IDS).includes(r.id),
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
      'id,kind,text,enabled,priority,hold,repeat,arrow',
      'good,warn,Fine,TRUE,10,2,3,surface',
      'off,warn,Hidden,FALSE,10,2,,',
      'nokind,sideways,Words,TRUE,10,2,,',
      'notext,warn,,TRUE,10,2,,',
      'badarrow,warn,Words,TRUE,10,2,,sideways',
      'blank,warn,Words,TRUE,,,,',
    ].join('\n'),
    (m) => warns.push(m),
  );
  check('an enabled row parses', table.get('good')?.text === 'Fine');
  check('...with its arrow', table.get('good')?.arrow === 'surface');
  check('enabled=FALSE drops the row', !table.has('off'));
  check('an unknown kind drops the row', !table.has('nokind'));
  check('a row with no text drops', !table.has('notext'));
  check('an unknown arrow keeps the row, loses the arrow',
    table.has('badarrow') && table.get('badarrow').arrow === null);
  check('a blank priority is 0, not missing', table.get('blank')?.priority === 0);
  // The distinction the whole `repeat` column rests on.
  check('a blank repeat is null (never repeats)', table.get('blank')?.repeat === null);
  check('a blank hold falls back to CONFIG',
    holdFor(table.get('blank')) === CONFIG.callouts.hold, String(holdFor(table.get('blank'))));
  // Each REJECTION says which row it dropped. `enabled=FALSE` is deliberately
  // not in this list: taking a row out on purpose is not a mistake to report.
  for (const id of ['nokind', 'notext', 'badarrow']) {
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
    ['id,kind,text,enabled,priority,hold,repeat,arrow', 'ghost,warn,Boo,TRUE,10,2,,'].join('\n'),
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
  const surface = CALLOUTS.get('surface');
  pushCallout(boss);
  pushCallout(surface);
  check('a coach tip outranks the LOUDEST warning', bandState.row === surface,
    `boss priority ${boss.priority} vs tip ${surface.priority}`);
  pushCallout(boss);
  check('...and the warning cannot take it back', bandState.row === surface);
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
  check('...and they are the only two off the band', sealRows.length === 2,
    sealRows.map((r) => r.id).join(','));
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
  pushCallout(CALLOUTS.get('surface'));
  check('a band tip does not clear the line on the seal',
    bandStates.player.row?.id === 'boost' && bandStates.band.row?.id === 'surface');
}
{
  // The role and motion block a line wears comes from the system, not the UI.
  resetCallouts();
  pushCallout(CALLOUTS.get('boost'));
  pushCallout(CALLOUTS.get('oxygen'));
  pushCallout(CALLOUTS.get('surface'));
  check('the seal line is on its own motion block',
    activeCallout('player').motion === 'boostWarn');
  check('a band tip is on the tip block', activeCallout('band').motion === 'coach');
  resetCallouts();
  pushCallout(CALLOUTS.get('oxygen'));
  check('a band warning is on the warning block', activeCallout('band').motion === 'warn');
  for (const key of ['warn', 'coach', 'boostWarn']) {
    check(`${key} has a motion block to be on`, !!CONFIG.textMotion[key]);
    check(`...and a text role wearing it`, TEXT_ROLES.some((r) => r.motion === key));
  }
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
  };
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
  const seen = coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    // All four collectable kinds in the water at once, and ONE of them taken.
    setWater(ctx, 'bubbleOrb', true);
    setWater(ctx, 'strikeOrb', true);
    setWater(ctx, 'rapidFireOrb', true);
    setWater(ctx, 'chumChunk', true);
    if (t > 8 && t < 8.05) noteTutorialEvent('bubbleOrb');
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

{
  // THE ATTRACTOR IS NOT SWUM INTO. It is a field a trawler drops — it rises
  // and drags the seabed to you — so its tip is the second in the file with no
  // answer, and the only thing that can end it is its own hold. A `done` copied
  // from the four orbs beside it would leave this line on the band until
  // something louder took it, every run, forever.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  coachRun((ctx, t) => {
    if (t > 3 && t < 3.05) noteTutorialEvent('strike');
    setWater(ctx, 'attractorOrb', t > 6);
  }, { seconds: 40 });
  check('the attractor tip ends on its own clock with nothing to collect',
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
  const ctx = { runTime: 10, device: 'kbm', charging: true, unkillableNear: true };
  for (let t = 0; t < 20; t += DT) {
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
  }
  check('a tip with nothing to obey comes off the band on its own clock',
    tutorialState.active !== 'invincible', `active: ${tutorialState.active}`);
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
  const ctx = { runTime: 10, device: 'kbm', charging: true, chumOnSeabed: true };
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
  let onScreen = 0;
  const ctx = {
    runTime: 0, device: 'touch', moving: false, aiming: false, charging: false,
    oxygenLow: false, aboveSurface: false, airTime: 0, nearSurface: false, chumInWater: false,
  };
  for (let t = 0; t < CONFIG.tutorial.openDelay + hold + 1; t += DT) {
    ctx.runTime = t;
    updateCallouts(DT, {}, true);
    updateTutorial(DT, ctx, true);
    if (bandState.row?.id === 'swim') onScreen += DT;
  }
  check('an unanswered tip still runs its full hold',
    Math.abs(onScreen - hold) < 0.1, `${onScreen.toFixed(2)}s of ${hold}s`);
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
    ctx.unkillableNear = t > 84;
  }, { device: 'kbm', seconds: 95 });
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
  const seen = coachRun((ctx, t) => {
    ctx.chumInWater = true;
    if (t > 4 && t < 4.05) noteTutorialEvent('strike');
    ctx.oxygenLow = t > 6 && t < 8;
    ctx.aboveSurface = t >= 7.5 && t < 8;
  }, { seconds: 12 });
  const order = seen.map((s) => s.id);
  check('running out of air takes the band off whatever was talking',
    order.includes('surface'), order.join(' → '));
  check('...and does it as the air runs out',
    seen.find((s) => s.id === 'surface')?.t < 6.2, order.join(' → '));
}
{
  // The ledger. A step done in one run must not be offered in the next; a step
  // that never got its chance must be.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  coachRun((ctx, t) => {
    if (t > 4 && t < 4.05) noteTutorialEvent('strike');
  }, { seconds: 6 });
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
{
  // Dying mid-sentence must not spend the step.
  store.clear();
  resetTutorial();
  resetCallouts();
  resetTutorialRun();
  const ctx = { runTime: 99, device: 'kbm', chumInWater: true, oxygenLow: false, aboveSurface: false, airTime: 0, nearSurface: false };
  updateCallouts(DT, {}, true);
  updateTutorial(DT, ctx, true);
  check('a tip is talking', tutorialState.active === 'strike');
  updateTutorial(DT, ctx, false); // the seal died
  check('death takes the tip down', tutorialState.active === null);
  check('...without spending it', !tutorialDone().has('strike'));
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
    const ctx = {
      runTime: 99, device: 'touch',
      moving: false, aiming: false, charging: false,
      chumInWater: true, oxygenLow: !done.has('surface'),
      aboveSurface: false, airTime: 0, nearSurface: true,
      // The water half. Like the air pair above, these follow the ledger: the
      // seabed tip is READY on a floor with chum on it and DONE on one without,
      // so a fixed value would either never offer it or never let it finish.
      pickupInWater: () => true, feeding: true,
      chumOnSeabed: !done.has('crab'), unkillableNear: true,
    };
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
section('what the UI is handed');
// ---------------------------------------------------------------------------
{
  resetCallouts();
  check('nothing to draw when the band is empty', activeCallout() === null);
  pushCallout(CALLOUTS.get('surface'));
  updateCallouts(0.2, {}, false);
  const c = activeCallout();
  check('a live callout reports its words', c?.text === CALLOUTS.get('surface').text);
  check('...its kind, so the tip can be coloured apart from an alarm', c.kind === 'coach');
  check('...its arrow', c.arrow === 'surface');
  check('...its age and the hold that age is measured against',
    c.age > 0.15 && c.hold === holdFor(CALLOUTS.get('surface')));
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
  const arrow = root.querySelector('.sv-callout-arrow');
  check('the band, the seal line and the arrow are built once',
    !!band && !!boost && !!arrow);
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

  // --- a tip: the second class, and an arrow that means UP ---
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('surface'));
  // The seal at the origin and the waterline above it, so the seal projects to
  // the middle of the screen and "up" is unambiguous. (In the game the surface
  // is the fixed one and the seal is below it; the arrow only ever sees the
  // difference between the two, so this is the same geometry with less
  // arithmetic in the assertions.)
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, surfaceY: 10 });
  check('a tip wears both classes, so its own rule can win',
    band.className.includes('sv-callout') && band.className.includes('sv-callout-coach'),
    band.className);
  check('the surface arrow is drawn', !arrow.className.includes('sv-hidden'));
  {
    // The whole point of that arrow. The seal projects to the middle of the
    // screen; "up" in the world is a SMALLER screen y, so the arrow has to sit
    // above the seal's own screen position — and be roughly on its vertical.
    const sealY = window.innerHeight / 2;
    const sealX = window.innerWidth / 2;
    const size = CONFIG.callouts.arrow.size;
    const ax = at(arrow, 'left') + size / 2;
    const ay = at(arrow, 'top') + size / 2;
    check('...above the seal, not below it', ay < sealY - 20, `arrow y ${ay.toFixed(0)} vs seal ${sealY}`);
    check('...and straight up, not off to one side', Math.abs(ax - sealX) < 6,
      `arrow x ${ax.toFixed(0)} vs seal ${sealX}`);
    // CLEAR OF THE SEAL'S FURNITURE, derived the way the code derives it rather
    // than compared to a pixel literal — the whole point of the change is that
    // moving the bars or the ring moves the arrow with them, and a hardcoded
    // number here would pass while the arrow sat on top of the bars.
    {
      const ring = CONFIG.strike.ring;
      const furniture = Math.max(CONFIG.hud.playerBarOffset, ring.radius * (ring.scale ?? 1));
      const perWorldUnit = window.innerHeight / 40; // the camera above spans 40 units
      const wantPx = (furniture + CONFIG.callouts.arrow.gap) * perWorldUnit;
      check('...clear of the bars AND the ring, whatever they are set to',
        Math.abs((sealY - ay) - wantPx) < CONFIG.callouts.arrow.bobDistance,
        `${(sealY - ay).toFixed(0)}px vs ${wantPx.toFixed(0)}px (furniture ${furniture})`);
      check('...which is genuinely past the further of the two',
        (sealY - ay) > furniture * perWorldUnit,
        `${(sealY - ay).toFixed(0)}px vs bars/ring at ${(furniture * perWorldUnit).toFixed(0)}px`);
    }
  }

  // --- the chum arrow follows the chum ---
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('chum'));
  const sealX = window.innerWidth / 2;
  updateCalloutUi(0.016, {
    camera, playerX: 0, playerY: 0, nearestChum: () => ({ x: 10, y: 0 }),
  });
  const chumArrowX = at(arrow, 'left') + CONFIG.callouts.arrow.size / 2;
  check('the chum arrow points at the chum', chumArrowX > sealX + 40, `x ${chumArrowX.toFixed(0)}`);
  {
    // Re-targeting has to be a SWING, not a jump: one frame of a 180° change
    // must not land the arrow on the far side.
    const before = at(arrow, 'left');
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, nearestChum: () => ({ x: -10, y: 0 }),
    });
    const after = at(arrow, 'left');
    check('a new target is swung toward, not snapped to',
      after < before && after > sealX, `${before.toFixed(0)} -> ${after.toFixed(0)}`);
  }
  {
    // The orb was eaten mid-tip. The arrow must go, and the sentence must stay.
    updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, nearestChum: () => null });
    check('the arrow goes when its target does', arrow.className.includes('sv-hidden'));
    check('...and the line explaining it stays', !band.className.includes('sv-hidden'));
  }

  // --- the power-up arrow reads its OWN target, not the chum one ---
  // The failure this catches is a one-word slip in arrowTarget: with a hundred
  // chum orbs in the water to one power-up, an arrow that fell through to
  // nearestChum would look right in almost every screenshot and point at the
  // wrong thing under a line about power-ups nearly every time it mattered.
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('bubbleOrb'));
  updateCalloutUi(0.016, {
    camera, playerX: 0, playerY: 0,
    nearestChum: () => ({ x: -10, y: 0 }),
    nearestPickup: () => ({ x: 10, y: 0 }),
  });
  {
    const ax = at(arrow, 'left') + CONFIG.callouts.arrow.size / 2;
    check('the power-up arrow points at the orb, not at the chum', ax > sealX + 40,
      `x ${ax.toFixed(0)} vs seal ${sealX}`);
  }
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, nearestPickup: () => null });
  check('...and goes when the orb expires mid-tip', arrow.className.includes('sv-hidden'));

  // --- ...AND IT ASKS FOR THE RIGHT KIND OF ORB ---
  // Five rows share `arrow: pickup`, and which orb each means is the ROW'S OWN
  // ID. Nothing else in this file would notice if that argument were dropped:
  // every check above passes with an arrow that points at whichever pickup
  // happens to be nearest, and the bug on screen is a line about doubling your
  // fire rate with an arrow on a bubble.
  for (const id of ['bubbleOrb', 'strikeOrb', 'rapidFireOrb', 'chumChunk']) {
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get(id));
    let asked = null;
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0,
      nearestPickup: (x, y, kind) => { asked = kind; return { x: 10, y: 0 }; },
    });
    check(`the ${id} arrow asks for ${id}`, asked === id, `asked for ${asked}`);
  }
  {
    // And the attractor deliberately has none: it drags the chum to you, so
    // there is nowhere to send the player.
    resetCallouts();
    clearCalloutUi();
    pushCallout(CALLOUTS.get('attractorOrb'));
    updateCalloutUi(0.016, {
      camera, playerX: 0, playerY: 0, nearestPickup: () => ({ x: 10, y: 0 }),
    });
    check('the attractor tip draws no arrow', arrow.className.includes('sv-hidden'));
  }

  // --- the seabed arrow means DOWN ---
  resetCallouts();
  clearCalloutUi();
  pushCallout(CALLOUTS.get('crab'));
  updateCalloutUi(0.016, { camera, playerX: 0, playerY: 0, seabedY: -10 });
  {
    // The mirror of the surface check above, and worth its own: the two are one
    // line apart in arrowTarget, and a seabed arrow pointing at the sky is the
    // exact bug that would survive every other check in this file.
    const sealScreenY = window.innerHeight / 2;
    const size = CONFIG.callouts.arrow.size;
    const ax = at(arrow, 'left') + size / 2;
    const ay = at(arrow, 'top') + size / 2;
    check('the seabed arrow is drawn', !arrow.className.includes('sv-hidden'));
    check('...below the seal, not above it', ay > sealScreenY + 20,
      `arrow y ${ay.toFixed(0)} vs seal ${sealScreenY}`);
    check('...and straight down, not off to one side', Math.abs(ax - sealX) < 6,
      `arrow x ${ax.toFixed(0)} vs seal ${sealX}`);
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
