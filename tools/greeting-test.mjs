#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:greeting
//
// THE HELLO AT THE TOP OF A RUN — greetings.csv, greetingTable.js,
// systems/lastRun.js and systems/greeting.js.
//
// One rolled sentence on the band with the player's name in it, every run, and
// on a run that follows a death it can name what killed the last one. Every
// failure in here is SILENT — the line simply does not appear, or appears
// saying the wrong thing about a run that did not happen — so none of it shows
// up as an error and all of it would take a player to notice:
//
//   A LINE THAT CAN NEVER BE SAID. A row filed as `first` that names {cause}
//   is about a run that by definition did not happen. It is not a crash and it
//   is not a blank: it is a row that never comes up, which looks exactly like
//   a row that has not been rolled yet.
//
//   A BRACE ON THE BAND. `{cause}` unresolved is the one output that is worse
//   than silence — it is a bug report printed in the game's own voice, in the
//   sentence that says the player's name.
//
//   THE WRONG HALF OF THE FILE. "Welcome to the deep" on the fortieth run and
//   "Back again?" on the first are both perfectly formed sentences and both
//   are wrong, which is the whole reason the `when` column exists.
//
//   A DEATH REMEMBERED TOO LONG. The cause is cleared when the next run
//   starts, so a player who quits mid-fight is not told about a death from two
//   runs ago — the exact "the game is misremembering me" impression this
//   feature exists to be the opposite of.
//
//   THE HANDOVER TO THE COACH. The greeting takes the band first and the first
//   control tip has to WAIT rather than cut it off — and then actually arrive.
//   Get the priority wrong in either direction and one of the two lines is
//   silently never read.
//
// Load order is the jsdom recipe (see tools/callout-test.mjs): jsdom, then the
// vite loader, then the game modules. Run WITHOUT --import for that reason.
//
//   node tools/greeting-test.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// systems/lastRun.js reads the record lazily and systems/tutorial.js reads its
// ledger at module scope, so real storage has to be in place before the first
// import below.
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

// ui/callout.js reaches the Rive HUD through its imports, and an ES import of
// a missing export is a SyntaxError at LINK time — one unstubbed name would
// take the whole file down before a check runs. Same stub as
// tools/callout-test.mjs, and for the same reason.
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

const here = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(here, '../path/src/greetings.csv');

const { CONFIG } = await import('../path/src/config.js');
const {
  parseGreetingCsv, pickGreeting, expandCause, GREETING_WHENS,
} = await import('../path/src/greetingTable.js');
const { causesOfDeath, primaryCause, DEATH_CAUSES } = await import('../path/src/deathCauses.js');
const { lastRun, noteRunStart, noteDeath, clearRunHistory } = await import('../path/src/systems/lastRun.js');
const {
  GREETINGS, resetGreetingRun, updateGreeting, greetingState, greetingOnBand, greetingLine,
} = await import('../path/src/systems/greeting.js');
const {
  CALLOUTS, bandStates, resetCallouts, updateCallouts, activeCallout, pushCallout,
} = await import('../path/src/systems/callouts.js');
const { savePlayerName, clearPlayerName, DEFAULT_PLAYER_NAME } = await import('../path/src/systems/playerName.js');
const { initCallouts, updateCalloutUi, clearCalloutUi } = await import('../path/src/ui/callout.js');

let failures = 0;
const quiet = () => {};
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DT = 1 / 60;
// One run's worth of frames through the greeting and the band it sits on.
// `live` false is a menu or a dead seal, which is the one thing that takes the
// line off without it having been read.
function runFrames(seconds, live = true) {
  for (let t = 0; t < seconds; t += DT) {
    updateGreeting(DT, live);
    updateCallouts(DT, {}, live);
  }
}
// What the band is actually saying right now, tokens and all — the string a
// player would be reading.
const onBand = () => activeCallout('band')?.text ?? null;

// ---------------------------------------------------------------------------
section('The shipped file');
const shipped = parseGreetingCsv(readFileSync(CSV, 'utf8'));
check('parses to a table', shipped.length >= 6, `${shipped.length} lines`);
check('ids are unique', new Set(shipped.map((g) => g.id)).size === shipped.length);
check('every line has text', shipped.every((g) => g.text.trim().length > 0));
check('every line has a positive weight', shipped.every((g) => g.weight > 0));
// The whole point of the feature: it says the player's name. A greeting that
// doesn't is just another line of text at the top of a run.
check('every line spends {player}', shipped.every((g) => g.text.includes('{player}')),
  shipped.filter((g) => !g.text.includes('{player}')).map((g) => g.id).join(', '));
// The band is one line across the middle of the screen. The longest coach row
// in callouts.csv is about a hundred characters and is a sentence somebody has
// to act on; a hello is read in passing and should not be near that.
check('no line is long enough to wrap the band',
  shipped.every((g) => g.text.length <= 72),
  shipped.map((g) => g.text.length).sort((a, b) => b - a).slice(0, 1).join());
check('both halves of the file are populated',
  shipped.some((g) => g.when !== 'again') && shipped.some((g) => g.when !== 'first'));
check('a first run has something to be told',
  shipped.filter((g) => g.when !== 'again' && !g.needsCause && !g.causes).length >= 2);
check('a returning run with no death has something too',
  shipped.filter((g) => g.when !== 'first' && !g.needsCause && !g.causes).length >= 2);
check('at least one line comments on the last death with the chip',
  shipped.some((g) => g.needsCause));
check('at least one line is written for a specific cause',
  shipped.some((g) => g.causes?.length));
// The unsayable-row check, on the shipped file rather than only on a fixture.
check('no first-run line is about a last run',
  shipped.every((g) => g.when !== 'first' || (!g.needsCause && !g.causes)));
// Every tag joins to deathCauses.js — a typo is dropped at parse, so this is
// really a check that nobody tagged a whole row into oblivion.
const causeIds = new Set(DEATH_CAUSES.map((c) => c.id));
check('every cause tag names a real cause',
  shipped.every((g) => !g.causes || g.causes.every((c) => causeIds.has(c))));

section('Broken files degrade to silence, not to a crash');
for (const [label, csv] of [
  ['empty file', ''],
  ['header only', 'id,text,enabled,weight,when,causes'],
  ['no id column', 'text\nhello'],
  ['every row disabled', 'id,text,enabled\na,Hi,FALSE'],
  ['every row blank text', 'id,text\na,\nb,   '],
  ['garbage', 'not,a,table\n\n,,,'],
]) {
  const rows = parseGreetingCsv(csv, quiet);
  check(`${label} → no line`, pickGreeting(rows) === null);
}

section('Which half of the file gets rolled');
const table = parseGreetingCsv([
  'id,text,when,causes',
  'hello,"Hello {player}",first,',
  'welcome,"Welcome {player}",first,',
  'back,"Back again {player}",again,',
  'chip,"Last time it was {cause}, {player}",again,',
  'crabby,"Mind the crabs {player}",again,crab',
  'either,"Dive in {player}",,',
].join('\n'), quiet);

const drawn = (opts, n = 300) => {
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(pickGreeting(table, Math.random, opts)?.id);
  return out;
};

const first = drawn({ returning: false });
check('a first run draws only first-run lines',
  [...first].every((id) => ['hello', 'welcome', 'either'].includes(id)), [...first].join(' '));
check('a blank `when` is in play on a first run', first.has('either'));
check('a first run never draws a line about a last run',
  !first.has('chip') && !first.has('crabby') && !first.has('back'));

const again = drawn({ returning: true });
check('a returning run with no death draws only the general returning lines',
  [...again].every((id) => ['back', 'either'].includes(id)), [...again].join(' '));
check('...and never one that names {cause}', !again.has('chip'),
  'a run nobody died in has no cause to name');

const crab = drawn({ returning: true, causes: causesOfDeath('walkingCrab') });
check('a line written for how you died beats the general pool',
  crab.size === 1 && crab.has('crabby'), [...crab].join(' '));
const puffer = drawn({ returning: true, causes: causesOfDeath('puffer') });
check('a cause nobody wrote for falls back to the general lines',
  [...puffer].every((id) => ['back', 'chip', 'either'].includes(id)), [...puffer].join(' '));
check('...and the chip is in that fallback', puffer.has('chip'),
  '"last time it was a pufferfish" is exactly what an untagged {cause} line is for');
check('an unclassified death is a returning run with no cause',
  !drawn({ returning: true, causes: causesOfDeath('kelp') }).has('chip'));

section('Not the same hello twice');
const avoided = new Set();
for (let i = 0; i < 300; i++) avoided.add(pickGreeting(table, Math.random, { returning: false, avoid: 'hello' })?.id);
check('the line said last run is dropped from the pool', !avoided.has('hello'), [...avoided].join(' '));
const only = parseGreetingCsv('id,text,when\nsolo,"Hi {player}",first', quiet);
check('...unless it is the only line there is',
  pickGreeting(only, Math.random, { returning: false, avoid: 'solo' })?.id === 'solo');

section('Weights');
const weighted = parseGreetingCsv(
  'id,text,weight\ncommon,Common,9\nrare,Rare,1\nnever,Never,0', quiet,
);
const counts = { common: 0, rare: 0, never: 0 };
for (let i = 0; i < 4000; i++) counts[pickGreeting(weighted, Math.random).id]++;
check('a zero-weight line is never dealt', counts.never === 0, `${counts.never} of 4000`);
check('a 9:1 weight is respected',
  counts.common / 4000 > 0.85 && counts.common / 4000 < 0.95,
  `${((counts.common / 4000) * 100).toFixed(1)}% common`);
const allZero = parseGreetingCsv('id,text,weight\na,A,0\nb,B,0', quiet);
check('all-zero weights fall back to uniform rather than to silence',
  ['a', 'b'].includes(pickGreeting(allZero)?.id));

section('The warnings an author needs');
let warned = '';
parseGreetingCsv('id,text,when\noops,"Last time it was {cause}",first', (m) => { warned += m; });
check('a first-run line that names {cause} is called out', warned.includes('oops'), warned.slice(0, 80));
warned = '';
parseGreetingCsv('id,text,when,causes\noops,"Mind the crabs",first,crab', (m) => { warned += m; });
check('...and so is one tagged for a cause', warned.includes('oops'));
warned = '';
const typo = parseGreetingCsv('id,text,when,causes\na,"Hi {player}",again,crustacean', (m) => { warned += m; });
check('an unknown cause id is dropped', typo[0].causes === null);
check('and warns, naming it', warned.includes('crustacean'));
warned = '';
const whenTypo = parseGreetingCsv('id,text,when\na,"Hi {player}",returning', (m) => { warned += m; });
check('an unknown `when` falls back to "either" rather than vanishing',
  whenTypo[0].when === null && warned.includes('returning'));

section('The {cause} chip');
check('the chip becomes the cause as deathCauses.js words it',
  expandCause('Last time it was {cause}.', primaryCause('greatWhite')?.label) === 'Last time it was a shark.');
check('every chip in a line is spent, not just the first',
  expandCause('{cause} again. {cause}!', 'a crab') === 'a crab again. a crab!');
check('no label leaves the text alone rather than blanking it',
  expandCause('It was {cause}.', null).includes('{cause}'));
// The labels are what a player reads now, so they have to survive being
// dropped into the middle of a sentence — lowercase, article attached.
check('every cause has a label that reads mid-sentence',
  DEATH_CAUSES.every((c) => c.label && c.label === c.label.trimEnd() && /^[a-z]/.test(c.label)),
  DEATH_CAUSES.filter((c) => !/^[a-z]/.test(c.label)).map((c) => c.id).join(', '));

// ---------------------------------------------------------------------------
section('The memory of the run before');
clearRunHistory();
check('a player we have never seen has no runs', lastRun().runs === 0 && lastRun().source === null);
let before = noteRunStart('hello');
check('the first run start reports nothing before it', before.runs === 0);
check('...and counts the run', lastRun().runs === 1);
check('...and remembers what was said', lastRun().greeting === 'hello');
noteDeath('greatWhite');
check('a death is banked', lastRun().source === 'greatWhite');
before = noteRunStart('back');
check('the next run start reports the death before it', before.source === 'greatWhite');
check('...and clears it, so a run nobody dies in is not told about an old death',
  lastRun().source === null);
check('...and keeps counting', lastRun().runs === 2);
check('lastRun() hands out a copy', (() => {
  const rec = lastRun();
  rec.runs = 999;
  return lastRun().runs === 2;
})());
// A hand-edited or half-written key must not become a comparison that is false
// in both directions — `runs: "lots"` is neither greater than zero nor not.
// clearRunHistory drops the cache, so the write below is what the next read
// actually sees.
clearRunHistory();
localStorage.setItem('sealSurvivor.lastRun.v1', '{"runs":"lots","source":42,"greeting":7}');
const rubbish = lastRun();
check('a nonsense stored record reads as a new player',
  rubbish.runs === 0 && rubbish.source === null && rubbish.greeting === null,
  JSON.stringify(rubbish));
clearRunHistory();
localStorage.setItem('sealSurvivor.lastRun.v1', 'not json at all');
check('...and so does one that is not JSON', (clearRunHistory(), lastRun().runs === 0));

// ---------------------------------------------------------------------------
section('A run, frame by frame');
clearRunHistory();
clearPlayerName();
resetCallouts();
resetGreetingRun(() => 0);
runFrames((CONFIG.greeting.delay ?? 0.8) - 0.2);
check('nothing is said during the opening camera move', onBand() === null);
runFrames(0.4);
check('the hello arrives', greetingOnBand() && !!onBand(), onBand() ?? '');
check('...in the coach\'s voice, not a warning\'s', activeCallout('band')?.kind === 'coach');
check('...naming a player who never typed one', onBand()?.includes(DEFAULT_PLAYER_NAME), onBand() ?? '');
check('...and with no brace left in it', !onBand()?.includes('{'), onBand() ?? '');
check('nothing is dissolving yet', greetingState.fade === 0);
// Its own hold, read off the line that is up rather than guessed at: the stay
// is stretched for a longer sentence at the coach's reading speed, so a fixed
// number here would be a test of one row's length.
runFrames((activeCallout('band')?.hold ?? 3) + 0.1);
check('it starts leaving once it has been read', greetingState.fade > 0, `${greetingState.fade.toFixed(2)}`);
runFrames((CONFIG.tutorial.dissipate.seconds ?? 0.7) + 0.2);
check('...and is gone', onBand() === null && greetingState.fade === 0);

section('The name is spent on the way to the screen');
savePlayerName('Ethan');
resetCallouts();
resetGreetingRun(() => 0);
runFrames((CONFIG.greeting.delay ?? 0.8) + 0.1);
check('a typed name is what the band says', onBand()?.includes('Ethan'), onBand() ?? '');
clearPlayerName();

section('A menu takes it off, and spends it');
resetCallouts();
resetGreetingRun(() => 0);
runFrames((CONFIG.greeting.delay ?? 0.8) + 0.3);
check('up', greetingOnBand());
runFrames(0.2, false);
check('a pause takes the line off immediately', onBand() === null);
runFrames(3);
check('...and it does not come back mid-run', onBand() === null,
  'a hello delivered two minutes into a fight is not a hello');

section('The handover to the coach');
resetCallouts();
resetGreetingRun(() => 0);
runFrames((CONFIG.greeting.delay ?? 0.8) + 0.2);
// The loudest coach row that shares the BAND. `surface` is louder still and is
// not a competitor at all — it has a subject, so it is anchored in the water
// beside the thing it names and takes a different slot entirely.
const swim = CALLOUTS.get('swim');
check('the loudest tip cannot take the band off the hello', !pushCallout(swim),
  'a refused step is not spent — it simply waits');
check('the hello is still the line up', greetingOnBand());
runFrames((CONFIG.greeting.maxHold ?? 5) + (CONFIG.tutorial.dissipate.seconds ?? 0.7) + 0.3);
check('once it has gone, the tip gets the band', pushCallout(swim));
resetCallouts();

// ---------------------------------------------------------------------------
// THE DRAWING. Everything above is the state machine, which is where the
// behaviour lives — but a line the band is holding and the screen is not
// showing is the same bug as a line that never fired, and nothing above this
// point would notice. jsdom, the real ui/callout.js, one frame at a time.
section('On the screen');
{
  const root = document.createElement('div');
  document.body.appendChild(root);
  initCallouts(root);
  const bandEl = root.querySelector('.sv-callout');
  const bandInk = root.querySelector('.sv-callout > .sv-callout-ink');

  clearRunHistory();
  clearPlayerName();
  resetCallouts();
  resetGreetingRun(() => 0);
  runFrames((CONFIG.greeting.delay ?? 0.8) + 0.2);
  updateCalloutUi(DT, { bandFade: greetingState.fade, tipFade: 0 });
  check('the hello is drawn', !bandEl.classList.contains('sv-hidden'));
  check('...saying the line, with the name in it',
    bandInk.textContent.includes(DEFAULT_PLAYER_NAME), bandInk.textContent);
  // The voice, and it is the reason the row is `kind: coach` rather than a
  // warning: the hello is the tip's colour and type, not the alarm's.
  check('...in the coach\'s type', bandEl.className.includes('sv-callout-coach'), bandEl.className);
  check('...and not eroded while it is being read', !bandInk.style.opacity || bandInk.style.opacity === '1');

  // AND IT LEAVES BY DISSOLVING, which is the whole reason main.js hands the
  // band a fade of its own: the greeting's dissolve is not the coach's, and
  // before `bandFade` existed the band could only ever read the coach's.
  runFrames((activeCallout('band')?.hold ?? 3) + 0.2);
  const fade = greetingState.fade;
  check('it is dissolving on the way out', fade > 0 && fade < 1, `${fade.toFixed(2)}`);
  // The wiring itself, and the only way to see it: draw the SAME frame twice,
  // once with the coach's fade (which is 0 — the coach is not talking) and once
  // with the greeting's. Before `bandFade` existed the band could only read the
  // first of those, so these two renders were identical and the hello left by
  // simply blinking out.
  updateCalloutUi(DT, { bandFade: 0, tipFade: 0 });
  const whole = bandInk.style.cssText;
  updateCalloutUi(DT, { bandFade: fade, tipFade: 0 });
  check('...and the band is drawn with THAT fade rather than the coach\'s',
    bandInk.style.cssText !== whole,
    bandInk.style.cssText.slice(0, 60));

  clearCalloutUi();
  root.remove();
}

// ---------------------------------------------------------------------------
section('Run to run');
clearRunHistory();
resetCallouts();
// Run one: nobody has played before.
resetGreetingRun(() => 0);
const firstLine = greetingLine();
// `{player}` is still a token here on purpose — the name is spent on the way
// to the screen, every frame, so that typing one mid-run changes the line. It
// is `{cause}` that must already be gone, because the cause cannot change.
check('the first run ever is welcomed', !!firstLine && !firstLine.includes('{cause}'), firstLine ?? '');
const firstId = lastRun().greeting;
check('...and the line is banked for next time', !!firstId);

// ...and dies to a shark.
noteDeath('greatWhite');
resetCallouts();
resetGreetingRun(() => 0);
const second = greetingLine();
check('the next run is greeted as a return, about the shark',
  !!second && /shark/i.test(second), second ?? '');
check('the chip is already spent when the line is rolled', !second.includes('{cause}'));

// ...then quits without dying.
resetCallouts();
resetGreetingRun(() => 0);
const third = greetingLine();
check('a run that follows an abandoned one says nothing about a death',
  !!third && !/shark/i.test(third), third ?? '');

// EVERY CAUSE, END TO END. The chip has to resolve for all of them — this is
// the check that a creature added to enemies.csv and classified in
// deathCauses.js can never put a brace on the band.
let braces = 0;
let mentions = 0;
for (const cause of DEATH_CAUSES) {
  const source = cause.sources[0] ?? cause.prefix;
  for (let i = 0; i < 40; i++) {
    noteDeath(source);
    resetGreetingRun();
    const line = greetingLine();
    if (line?.includes('{cause}')) braces++;
    if (line && cause.label && line.includes(cause.label)) mentions++;
  }
}
check('no death in the game can leave a brace on the band', braces === 0, `${braces}`);
check('and the chip does get spent across the roster', mentions > 0, `${mentions} lines named the cause`);

section('Turned off');
CONFIG.greeting.enabled = false;
resetCallouts();
clearRunHistory();
resetGreetingRun(() => 0);
runFrames(4);
check('nothing is said at all', onBand() === null && greetingLine() === null);
check('...but the run is still counted, so the NEXT hello is right',
  lastRun().runs === 1);
CONFIG.greeting.enabled = true;

clearRunHistory();
clearPlayerName();
console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
