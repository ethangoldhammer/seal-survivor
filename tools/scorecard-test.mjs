#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:scorecard
//
// THE SCORE CARD — the ledger a run ends on — driven through the real ui.js
// under jsdom against a real recorded run.
//
// It was a card with two faces and a turn between them. It is one readout now:
// the recap, the roll, what you dealt, what dealt it to you, where you stand
// and what you built, over a bar that does not scroll. What the turn used to
// hide, this has to lay out.
//
// Everything here fails silently. A score screen cannot throw — it is the only
// route back into the game — so the whole thing is written to degrade to a
// blank panel, and a blank panel is exactly what a legitimately empty run looks
// like. The ones that would ship unnoticed:
//
//   THE VANISHED CURSOR    the pad's list is rebuilt every frame from what is
//                          actually reachable, and two of its stops — the
//                          leaderboard's Global/Device buttons — are rebuilt by
//                          every render of the board. A handle taken when the
//                          screen opened points at a button the global board's
//                          arrival has already replaced, which is a stop that
//                          silently stops existing.
//   DAMAGE COUNTED TWICE   causesOfDeath returns SEVERAL causes per source on
//                          purpose (the megalodon is a shark AND a boss). A
//                          threats table built from it totals more damage than
//                          the player ever took, and every share is wrong by a
//                          plausible-looking amount.
//   THE WRONG KILLER       the thing that took the most health off you across
//                          ten minutes is very often not the thing that
//                          finished you. Reading "Killed by" off the top of
//                          the table gives a wrong fact about the run the
//                          player just played, and it will be right often
//                          enough to look correct.
//   THE SWAPPED BOARD      the local board used to be replaced by the global
//                          one the moment the network answered, same panel,
//                          different hundred names, with nothing to say it had
//                          happened. Both are kept now and the heading says
//                          which is up — and a player who has chosen one must
//                          not have it swapped out from under them.
//   A BAR THAT SCROLLS     the readout is the only part of the card allowed to
//                          scroll. If the bar joins it, Try again goes back
//                          below the fold, which is the whole reason for it.
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

// `url` set, or localStorage throws on the opaque origin the moment the
// leaderboard module touches it.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned — the plain assignment throws with a message
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

// Rich enough for the kill-shot composite as well as the reveal masks. The
// capture path is wrapped in a try/catch that reports a lost context as "no
// trophy this run" — so a stub missing one text method does not throw here, it
// silently produces a card with no trophy row, and the pad checks below would
// then pass for the wrong reason.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    canvas: this,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, strokeRect() {}, drawImage() {}, save() {}, restore() {},
    fillText() {}, measureText: (t) => ({ width: String(t).length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    // The bubble layer's own calls. Present so the turn runs its real loop
    // here; the drawing is npm run layout's and a browser's to judge.
    setTransform() {}, beginPath() {}, arc() {}, stroke() {}, fill() {},
    set lineWidth(v) { this._lw2 = v; }, get lineWidth() { return this._lw2; },
    set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    set font(v) { this._font = v; }, get font() { return this._font; },
    set letterSpacing(v) { this._ls = v; }, get letterSpacing() { return this._ls; },
    set textAlign(v) { this._ta = v; }, get textAlign() { return this._ta; },
    set textBaseline(v) { this._tb = v; }, get textBaseline() { return this._tb; },
    set strokeStyle(v) { this._ss = v; }, get strokeStyle() { return this._ss; },
    set lineWidth(v) { this._lw = v; }, get lineWidth() { return this._lw; },
  };
};
dom.window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb) {
  setTimeout(() => cb(new dom.window.Blob(['png'], { type: 'image/png' })), 0);
};
dom.window.URL.createObjectURL = () => 'blob:http://localhost/stub';
dom.window.URL.revokeObjectURL = () => {};
globalThis.URL = dom.window.URL;
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

// No AudioContext is installed, so playSfx bails before it reaches the graph
// and every menu sound is a no-op. That is the point: this file is about the
// markup, and tools/menu-sound-test.mjs is the one that listens.
globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { initFeedback } = await import('../path/src/systems/feedback.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
const playtest = await import('../path/src/systems/playtest.js');
const shots = await import('../path/src/systems/bossShot.js');
const { menuInput } = await import('../path/src/input.js');
// Nothing on this card animates on a clock any more — the turn is gone — but
// the screen still does work in promises: warmShareCards renders every polaroid
// while the card is arriving, and the global board lands whenever it lands. A
// settle is a drain of the microtask queue plus a few macrotasks, not a wait on
// an angle.
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  return true;
};

ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onNameSubmit() {} });

const $ = (id) => document.getElementById(id);
const hidden = (node) => !node || node.classList.contains('sv-hidden');
const rows = (id) => [...$(id).querySelectorAll('.sv-brk-row')];
const names = (id) => rows(id).map((r) => r.querySelector('.sv-brk-name').textContent.trim());
const cellA = (id) => rows(id).map((r) => r.querySelector('.sv-brk-a').textContent.trim());
const cellB = (id) => rows(id).map((r) => r.querySelector('.sv-brk-b').textContent.trim());
const share = (id) => rows(id).map((r) => r.style.getPropertyValue('--sv-share'));
const footText = (id) => [...$(id).querySelectorAll('.sv-brk-foot span')].map((s) => s.textContent.trim());

// ---------------------------------------------------------------------------
// A RUN, recorded through the real ledger rather than hand-built.
//
// Written as damage EVENTS so the harness exercises the same path the game
// does — the analysis reads buckets, and a hand-made bucket would let a
// bucketing bug through. `tick` is what closes one, so the run has to be
// walked in time rather than assembled.
//
// The shape is deliberate:
//   * one dominant weapon and a tail, so the bars have something to be wrong
//     about;
//   * FOUR shark sources on the incoming side, three of them wildlife and one
//     a boss body, which is the double-count trap;
//   * a killing blow (the crab) that is NOT the biggest threat (the sharks).
// ---------------------------------------------------------------------------
function recordRun() {
  playtest.beginRun({});
  playtest.recordUpgrade('homingMissile');
  playtest.recordUpgrade('homingMissile');
  playtest.recordUpgrade('seaGarlic');
  playtest.recordUpgrade('clubIce');

  for (let t = 0; t < 12; t++) {
    const body = { hp: 10 };
    playtest.recordDamage('missile', 800, body);
    playtest.recordDamage('garlic', 300, body);
    playtest.recordDamage('gun', 120, body);
    playtest.recordKill(body);
    // Damageless by design — it must not read as a weapon doing nothing.
    playtest.recordControl('clubIce', 2);
    // The incoming side: four shark keys the player would call one animal.
    playtest.recordPlayerDamage(4, 'greatWhite');
    playtest.recordPlayerDamage(3, 'megalodon');
    playtest.recordPlayerDamage(2, 'abyssShark');
    playtest.recordPlayerDamage(2, 'bossShark');
    playtest.recordPlayerDamage(1, 'walkingCrab');
    playtest.tick(10, { hp: 60, maxHp: 100, alive: 12, level: 6 });
  }
  return playtest.endRun('death');
}

const run = recordRun();

// A KILL SHOT, so the trophy row actually exists. Without one showTrophy keeps
// the whole block hidden and the pad check below passes for the wrong reason —
// there would be no share buttons to wrongly stop on in the first place.
const shotCanvas = document.createElement('canvas');
shotCanvas.width = 640; shotCanvas.height = 360;
shots.resetBossShot();
// causeSource alongside the caption: the score screen's table tags the final
// blow by SOURCE KEY, because a weapon can be renamed mid-run and the print
// keeps whatever it was called at the moment of the kill. A shot carrying only
// the display name would silently stop tagging anything.
const kept = shots.captureBossShot(shotCanvas, {
  name: 'Grimtide', cause: 'Homing Missile', causeSource: 'missile',
  level: 6, score: 41200, time: 120,
});
check('a kill shot was kept, so the trophy row has something to hold', kept === true);
// Killed by the crab, which is nowhere near the top of the threat table.
const gameState = {
  score: 41200, kills: 12, level: 6, time: 120,
  deathCauses: new Set(['crab']), deathSource: 'walkingCrab',
};

// ---------------------------------------------------------------------------
section('THE LEDGER — one face, and everything on it');
// ---------------------------------------------------------------------------
ui.showGameOver(gameState);

const card = $('svCard');

// ONE CARD, NO FACES. The two that used to be here are the specific thing this
// replaced, and a face reappearing is the flip coming back with it.
check('the card is a single face', card.classList.contains('sv-ledger')
  && card.querySelectorAll('.sv-face').length === 0);
check('...carrying the recap, the roll and the way out',
  card.contains($('svGameOverStats')) && card.contains($('svTrophy'))
  && card.contains($('svRestartBtn')));
// WHAT THE TURN USED TO HIDE. Both tables were on the back, behind a gesture
// nobody had to make.
check('...and the tables that used to be on the back',
  card.contains($('svPanelWeapons')) && card.contains($('svPanelThreats')));
// WHAT THE RUN BUILT IS THE HIVE ON THE RAIL, and only that. The text list of
// the picks that used to fill the readout's second column said again, less
// well, what the hexagons show and what the weapons table ranks.
check('...and the build, as the hive on the rail rather than a second list',
  card.contains($('svTrophy')) && document.getElementById('svPanelBuild') === null);

// THE BAR IS NOT IN THE SCROLL, which is the layout's whole claim. The readout
// scrolls under it; if Try again is inside .sv-ldg-body it is below the fold on
// a laptop again and the ledger has bought nothing.
const body = card.querySelector('.sv-ldg-body');
const bar = card.querySelector('.sv-ldg-bar');
check('the readout and the bar are siblings, not nested',
  body && bar && !body.contains(bar) && bar.parentElement === card);
check('...and the way out is in the bar', bar.contains($('svRestartBtn')));
check('...as is the name the run gets posted under', bar.contains($('svNameSubmit')));
check('...and the one for the next seal', bar.contains($('svNextRow')));
check('the two name fields are still separate questions',
  $('svNameInput') !== $('svNextInput') && !$('svNameRow').contains($('svNextInput')));

// THE WAY OUT SURVIVES EVERYTHING THAT HIDES THE NAME ROW.
//
// #svNameRow is hidden as a UNIT in two places — previewScreen, and
// submitPendingRun the moment a score is posted — so anything inside it goes
// away with it. Try again spent one build in there: posting your run removed
// the only route back into the water, on every device, and nothing said so.
// The card still rendered, the bar was still pinned, and npm run layout read
// 64/64 clean, because a control that is display:none has no box to overflow.
check('the way out is not inside the name row', !$('svNameRow').contains($('svRestartBtn')));
$('svNameRow').classList.add('sv-hidden');
check('...so hiding the name row does not take it with it',
  !$('svRestartBtn').closest('.sv-hidden'));
$('svNameRow').classList.remove('sv-hidden');

// THE CARD'S HEIGHT IS NOT CHECKED HERE and cannot be: jsdom reports 0 for
// every rectangle it is asked about. A harness that asserted a number would be
// asserting its own stub. `npm run layout` measures this one, in a browser, at
// eight viewport sizes — see the note in tools/layout-audit.mjs about why.
// What IS checked here is that sizing ran without throwing, which it must not
// do: it happens inside showGameOver, and this card is the only route back
// into the game.
check('sizing the card did not take the score screen down',
  !$('svGameOverMenu').classList.contains('sv-hidden'));

// ---------------------------------------------------------------------------
section('WEAPONS — the run\'s own ledger, named');
// ---------------------------------------------------------------------------
check('every weapon that dealt damage has a row', rows('svPanelWeapons').length === 3,
  `${rows('svPanelWeapons').length} row(s)`);
// The failure this catches is a table of source keys — 'missile', 'garlic' —
// which is what happens the moment a label is missing rather than an error.
check('...under the name on the card, not the source key',
  names('svPanelWeapons')[0].startsWith('Homing Missile'), names('svPanelWeapons').join(' | '));
check('...biggest first', cellA('svPanelWeapons').join(',') === '9.6k,3.6k,1.4k',
  cellA('svPanelWeapons').join(','));
// The kills land on Fin Pebbles rather than on the missile, and that is the
// ledger being honest rather than a bug: a kill is credited to whatever
// touched the creature LAST, which here is the pebble fired after the missile.
// Asserted where they actually are, because a table that quietly moved them to
// the biggest damage dealer would be inventing a fact about the run.
check('...with the kills beside the weapon that landed them',
  cellB('svPanelWeapons')[2] === '12' && cellB('svPanelWeapons')[0] === '0',
  cellB('svPanelWeapons').join(','));
check('...and the picks that paid for them',
  names('svPanelWeapons')[0].includes('×2'), names('svPanelWeapons')[0]);

// THE BAR IS RELATIVE TO THE TOP ROW, not to the total. Against the total, a
// build where one ability does 70% draws one long bar and a row of slivers,
// which is a chart that only ever says the same thing.
check('the leading bar fills the row', share('svPanelWeapons')[0] === '100%',
  share('svPanelWeapons').join(' '));
check('...and the rest are drawn against it, not against the total',
  parseFloat(share('svPanelWeapons')[1]) > 30 && parseFloat(share('svPanelWeapons')[1]) < 45,
  share('svPanelWeapons')[1]);

// Cold Snap deals nothing by design. A zero in a column headed Damage reads as
// a broken upgrade, which is the misreading the ledger's `control` flag exists
// to prevent — so it is counted, on its own line, and never in the table.
check('a damageless ability is not a row in the damage table',
  !names('svPanelWeapons').some((n) => n.includes('Cold Snap')), names('svPanelWeapons').join(' | '));
check('...but its work is still counted',
  footText('svPanelWeapons').some((t) => /Caught, held or frozen\s*24/.test(t)),
  footText('svPanelWeapons').join(' | '));
// THE BUILD REACHES THE TABLE. The rows are named by weaponName.js and not by
// the ledger's own label, so a run that cloned its pebbles says so here as well
// as on the polaroid — one answer in both places. Driven through the real
// player object, because its `upgrades` array is what the game actually passes.
{
  const { player } = await import('../path/src/entities/player.js');
  check('the table says Fin Pebbles on an unmodified run',
    names('svPanelWeapons').includes('Fin Pebbles×1'), names('svPanelWeapons').join(' | '));
  player.upgrades.push({ id: 'multishot', rarity: 'common' });
  ui.showGameOver(gameState);
  check('...and renames it once the run has modified it',
    names('svPanelWeapons').some((n) => n.startsWith('Cloned Pebbles')),
    names('svPanelWeapons').join(' | '));
  player.upgrades.length = 0;
  ui.showGameOver(gameState);
}

check('...and the total is the run\'s, not the visible rows\'',
  footText('svPanelWeapons').some((t) => /Total dealt\s*14\.6k/.test(t)),
  footText('svPanelWeapons').join(' | '));

// ---------------------------------------------------------------------------
section('THREATS — grouped once, counted once');
// ---------------------------------------------------------------------------
// FOUR shark sources went in. One row comes out, and the boss shark is in it
// rather than in a second row of its own — a player who spent a run being
// eaten by sharks did not lose it to four things.
check('four shark sources are one row', rows('svPanelThreats').length === 2,
  `${rows('svPanelThreats').length} row(s): ${names('svPanelThreats').join(' | ')}`);
check('...under a word a player would use', names('svPanelThreats')[0] === 'Sharks',
  names('svPanelThreats').join(' | '));

// THE DOUBLE COUNT. 132 points went in (11 per tick × 12). The boss shark
// belongs to two causes and must be added to exactly one of them.
// 144 went in: 12 points a tick for twelve ticks. Matched against the causes
// the way the QUIPS match, the boss shark's 24 would be counted twice and this
// would read 168.
check('the total is what was actually taken, not what was matched',
  footText('svPanelThreats').some((t) => /Total taken\s*144$/.test(t)),
  footText('svPanelThreats').join(' | '));
check('...so the shares add up to 100', cellB('svPanelThreats').join(',') === '92%,8%',
  cellB('svPanelThreats').join(','));

// The crab did 12 of 144 and finished the run. Reading the killer off the top
// of the table would name the sharks.
check('the killer is the thing that finished you, not the biggest total',
  footText('svPanelThreats').some((t) => /Killed by\s*Crabs$/.test(t)),
  footText('svPanelThreats').join(' | '));

// ---------------------------------------------------------------------------
section('THE PAD — every stop, including the ones that get rebuilt');
// ---------------------------------------------------------------------------
// The list is rebuilt every frame from what is actually reachable, which is
// what makes this recoverable at all. Two of its stops are not stable
// elements: the leaderboard's Global/Device buttons are written by innerHTML
// on every render of the board, and the global board arriving IS a render — so
// a cursor built from handles taken when the screen opened walks onto buttons
// that are no longer in the document.
const padStops = () => {
  const seen = [];
  // BOTH DIRECTIONS, and that is not thoroughness — the cursor index survives
  // between openings of this card, so a walk that only ever goes down starts
  // wherever the last one finished and reports the tail of the list as if it
  // were the whole of it. Up first, to the top, then down through everything.
  const walk = (dir) => {
    menuInput.y = dir;
    for (let i = 0; i < 20; i++) {
      ui.updateMenuNav();
      const sel = document.querySelector('#svGameOverMenu .sv-nav-sel');
      if (sel && !seen.includes(sel.id)) seen.push(sel.id);
    }
    menuInput.y = 0;
    ui.updateMenuNav();
  };
  walk(-1);
  walk(1);
  return seen;
};

const stops = padStops();
check('the roll is really on this card', !hidden($('svTrophy')));
check('the share buttons are stops', stops.includes('svTrophyShare'), stops.join(' → '));
check('...as is the way out', stops.includes('svRestartBtn'), stops.join(' → '));
// AND AFTER A POST, when the name row is hidden and everything in it leaves
// the cursor's list. The way out must not leave with them — see the note in
// the first section about the build that put it inside that row.
$('svNameRow').classList.add('sv-hidden');
const posted = padStops();
check('...including once the score has been posted and the name row is gone',
  posted.includes('svRestartBtn') && !posted.includes('svNameSubmit'),
  posted.join(' → '));
$('svNameRow').classList.remove('sv-hidden');
check('...and the board it is posted to', stops.includes('svNameSubmit'), stops.join(' → '));
// THE BOARD'S OWN CONTROL. Only Device is live here — the global board never
// answers in this harness, so Global is disabled and must not be a stop.
check('the board heading is reachable', stops.includes('svBoardDevice'), stops.join(' → '));
check('...and a board that has not arrived is not',
  !stops.includes('svBoardGlobal'), stops.join(' → '));
// EVERY STOP IS NAMED. A cursor stop with no id is a blank in this trace, which
// is indistinguishable from a control that was never reachable.
check('nothing walks onto an unnamed control', stops.every(Boolean) && !stops.includes(''),
  stops.join(' → '));

// AND NOTHING IS LEFT LIT. The card is opened dozens of times a sitting and the
// highlight has to go with it, or the next death opens with a button already
// chosen for a mouse player who never asked.
ui.showGameOver(gameState);
check('a reopened card starts with nothing highlighted',
  document.querySelectorAll('#svGameOverMenu .sv-nav-sel').length === 0);

// ---------------------------------------------------------------------------
section('BETWEEN DEATHS');
// ---------------------------------------------------------------------------
ui.showGameOver(gameState);
check('the next death opens on the same readout',
  $('svCard').classList.contains('sv-ledger') && !hidden($('svTrophy')));

// A RUN WITH NOTHING IN IT. The demo score screen behind the Text panel shows
// this card without a fight behind it, and so does a run that ended before
// anything was hit. It must not throw — this card is the only route back into
// the game — and it must say there is nothing rather than draw an empty table
// with a total of zero, which reads as the feature being broken.
//
// A real empty run rather than a missing one: `lastFinishedRun` keeps the
// previous run until another finishes, so "no run" is a state this screen
// almost never actually sees, and the empty run is the case that ships.
playtest.beginRun({});
playtest.endRun('death');
const before = warnings.length;
ui.showGameOver({ score: 1, kills: 0, level: 1, time: 1 });
check('a card shown with an empty run still opens',
  !$('svGameOverMenu').classList.contains('sv-hidden'));
check('...with no table at all', rows('svPanelWeapons').length === 0,
  `${rows('svPanelWeapons').length} row(s)`);
check('...and a line saying so',
  /Nothing was damaged/.test($('svPanelWeapons').textContent),
  $('svPanelWeapons').textContent.trim());
check('...on the incoming side too', /Nothing laid a finger/.test($('svPanelThreats').textContent),
  $('svPanelThreats').textContent.trim());
check('...without a warning', warnings.length === before,
  warnings.slice(before).join(' | '));

// ---------------------------------------------------------------------------
section('THE CARD\'S OWN EDGE');
// ---------------------------------------------------------------------------
{
  const { prefersReducedMotion } = await import('../path/src/devices.js');
  check('reduced motion is a shared reading, not a per-surface copy',
    typeof prefersReducedMotion === 'function');

  ui.showGameOver(gameState);

  // THE WORN EDGE. A mask that failed to bake must leave the card UNMASKED —
  // an empty mask hides the whole card, and with it the way back into the game.
  // jsdom's canvas cannot produce pixels, so this harness exercises exactly
  // that failure path, which is the one worth being sure about.
  const masked = $('svCard').style.maskImage || $('svCard').style.webkitMaskImage;
  check('a card whose border could not be baked is not left masked to nothing',
    masked === '' || masked === 'none' || masked.startsWith('url('),
    JSON.stringify(masked));

  const { STYLE_NAMES } = await import('../path/src/ui/wornEdge.js');
  const { CONFIG } = await import('../path/src/config.js');
  check('the configured wear style is one that exists',
    STYLE_NAMES.includes(CONFIG.death.flip.wear.style) || CONFIG.death.flip.wear.style === 'clean',
    CONFIG.death.flip.wear.style);

  // THE WEAR IS BAKED OFF THE LAYOUT BOX, NOT A MEASURED RECT.
  //
  // sizeCard re-bakes the border mask whenever the readout's content changes,
  // and the two things that change it — the roll's prints and the global board
  // arriving — both land SECONDS after the card opens. The card no longer
  // rotates, but it still arrives through a reveal that scales it, so a rect
  // read at the wrong moment is a fraction of the real width; the mask baked
  // into that and stretched back over the card shreds it into vertical strands
  // and then STAYS that way, because nothing re-bakes it afterwards.
  // offsetWidth and offsetHeight are the border box and ignore transforms.
  //
  // COUNTED IN BAKES rather than compared as mask strings: this harness's
  // toDataURL is a constant, so a mask baked at the wrong width is the same
  // string as one baked at the right width. What separates them is that the
  // right width is a cache hit and the wrong one is not.
  {
    const cardEl = $('svCard');
    // jsdom has no layout, so the layout box has to be supplied. That is the
    // point of the check: these are the numbers the fix reads, and they are the
    // ones a transform cannot move.
    Object.defineProperty(cardEl, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(cardEl, 'offsetHeight', { value: 900, configurable: true });

    let bakes = 0;
    const realToDataURL = dom.window.HTMLCanvasElement.prototype.toDataURL;
    dom.window.HTMLCanvasElement.prototype.toDataURL = function counted() {
      bakes++;
      return realToDataURL.call(this);
    };

    // A window resize is what watchCardSize listens for, and it runs sizeCard
    // synchronously — the same function the mutation observer reaches.
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    check('a card with a layout box bakes its wear at all', bakes > 0, `${bakes} bake(s)`);

    // A rect that disagrees with the layout box must change nothing.
    cardEl.getBoundingClientRect = () => ({
      width: 16, height: 900, top: 0, left: 0, right: 16, bottom: 900, x: 0, y: 0,
    });
    bakes = 0;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    check('...and bakes nothing new for a rect that is not the layout box',
      bakes === 0, `${bakes} bake(s) at a measured width of 16px`);

    dom.window.HTMLCanvasElement.prototype.toDataURL = realToDataURL;
    delete cardEl.getBoundingClientRect;
  }

  // NO HEIGHT IS WRITTEN. The card was two absolute faces and had to be told
  // how tall it was; it is a flex column with a 92vh cap now, and an inline
  // height would fight the cap and unpin the bar.
  check('nothing writes an inline height onto the card',
    $('svCard').style.height === '', JSON.stringify($('svCard').style.height));
}

// ---------------------------------------------------------------------------
section('THE BOARD IS A HUNDRED DEEP');
// ---------------------------------------------------------------------------
// The depth is not a display choice — it decides whether a run is ON the
// leaderboard at all, and the failure it guards against is quiet: a board
// trimmed to ten still renders, still scrolls, and still says "didn't make
// it" to a player who came 40th.
//
// jsdom answers nothing about LAYOUT, so what is checked here is the data and
// the markup — how a hundred rows and a three-digit rank actually sit in the
// box is npm run layout's question, and a browser's.
{
  const lb = await import('../path/src/systems/leaderboard.js');
  const nameMod = await import('../path/src/systems/playerName.js');

  check('the board keeps a hundred', lb.BOARD_SIZE === 100, String(lb.BOARD_SIZE));

  // Deeper than the cap on purpose, so the trim is exercised rather than
  // assumed, and with the run under test landing well down the list — the
  // rank the old board could not hold.
  const seeded = [];
  for (let i = 0; i < 140; i++) {
    seeded.push({ name: `Player ${i}`, score: 200_000 - i * 1000, kills: 100, level: 9, time: 300, date: 0 });
  }
  localStorage.setItem('seal-survivor-leaderboard-v1', JSON.stringify(seeded));

  const mid = { name: 'MIDFIELD', score: 138_500, kills: 100, level: 9, time: 300, date: 0 };
  const res = lb.submitScoreLocal(mid);
  check('a run 63rd best is on it', res.madeList && res.rank === 63, `rank ${res.rank}`);
  check('...and the board is trimmed to a hundred, best first',
    res.list.length === 100 && res.list[0].score === 200_000 && res.list[99].score === 102_000,
    `${res.list.length}: ${res.list[0].score} … ${res.list[99].score}`);
  check('...which is what was stored', lb.loadLeaderboard()[62]?.name === 'MIDFIELD',
    lb.loadLeaderboard()[62]?.name);

  ui.showGameOver({ score: 138_500, kills: 100, level: 9, time: 300 });
  const lbRows = [...$('svLeaderboard').querySelectorAll('.sv-lb-row')];
  check('the card draws all hundred', lbRows.length === 100, String(lbRows.length));
  check('...down to a rank of 100',
    lbRows.at(-1)?.querySelector('.sv-lb-rank')?.textContent === '100',
    lbRows.at(-1)?.querySelector('.sv-lb-rank')?.textContent);

  // The field and the board agree about how long a name may be — the whole
  // point of MAX_NAME_LEN living in one module.
  check('the field accepts a full-length name',
    $('svNameInput').getAttribute('maxlength') === String(nameMod.MAX_NAME_LEN),
    `${$('svNameInput').getAttribute('maxlength')} vs ${nameMod.MAX_NAME_LEN}`);

  // THE FIT MUST NOT FIRE WHERE NOTHING HAS A WIDTH. Every box in jsdom is
  // zero wide, and a fit that believed that would size every name to the floor
  // and stack the row on a screen that has all the room in the world.
  $('svNameInput').value = 'X'.repeat(nameMod.MAX_NAME_LEN);
  $('svNameInput').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('a full-length name types without throwing',
    $('svNameInput').value.length === nameMod.MAX_NAME_LEN, String($('svNameInput').value.length));
  check('...and nothing is resized where nothing has a width',
    $('svNameInput').style.fontSize === '' && !$('svNameRow').classList.contains('sv-name-stacked'),
    `"${$('svNameInput').style.fontSize}" ${$('svNameRow').className}`);
}

// ---------------------------------------------------------------------------
section('THE TWO BOARDS');
// ---------------------------------------------------------------------------
// The local board used to be replaced by the global one the moment the network
// answered: same panel, same shape, a different hundred names, and nothing to
// say it had happened. A player who saw their own name at the top and looked
// back to find it gone was reading two boards and was never told there were
// two. Both are kept now, and the heading says which is up.
{
  const board = $('svLeaderboard');
  const heading = () => board.querySelector('.sv-ldg-sec')?.textContent ?? '';
  const on = () => board.querySelector('.sv-lb-sw-on')?.dataset.board ?? '';
  const names = () => [...board.querySelectorAll('.sv-lb-name')].map((n) => n.textContent);

  // A DEVICE BOARD WITH SOMETHING ON IT. The harness has no network, so the
  // global side is written by hand — what is under test is the switch and the
  // standing line, not the fetch.
  // Written straight to storage, the way the hundred-deep section above does:
  // what is under test is the switch and the standing line, not the write path.
  // The run under test scores 41,200, which sits between these two.
  localStorage.setItem('seal-survivor-leaderboard-v1', JSON.stringify([
    { name: 'HAULOUT HANK', score: 90000, kills: 200, level: 9, time: 300, date: 0 },
    { name: 'PUPPY', score: 1000, kills: 4, level: 2, time: 40, date: 0 },
  ]));
  ui.showGameOver(gameState);
  await settle();

  check('the board says which board it is', /Leaderboard/.test(heading()), heading().trim());
  check('...and it opens on the one that is actually there', on() === 'device', on());
  check('...with the device board in it', names().includes('HAULOUT HANK'), names().join(', '));
  // The global button is DIMMED rather than absent until the board answers: a
  // control that appears late moves the heading under the player's cursor.
  check('the global side is offered but not live yet',
    $('svBoardGlobal') !== null && $('svBoardGlobal').disabled === true);

  // WHERE THE RUN STANDS, said before it has been posted — and said as the
  // conditional it is. A flat "2nd" would be the card claiming a place the
  // player has not taken.
  const rank = () => $('svLdgRank')?.textContent ?? '';
  check('the score carries its standing, not just its figure',
    /\d/.test(rank()) && /would be/i.test(rank()), rank());

  // 41,200 sits between the two saved scores, so the run would come 2nd.
  check('...and the standing is the right one', /2nd of 2/.test(rank()), rank());
}

// ---------------------------------------------------------------------------
section('THE PRINT, HELD UP');
// ---------------------------------------------------------------------------
// A photograph in the fan is 120px of paper. Tapping one holds it up at nearly
// the size of the screen so the choice to share it is made while looking at it.
{
  ui.showGameOver(gameState);
  const view = $('svShotView');
  const slots = [...$('svFan').children];
  check('the roll has a print to open', slots.length > 0, `${slots.length} slot(s)`);

  slots[0].click();
  check('a tap on a print opens it', !hidden(view));
  // WHAT IT SHOWS IS THE FILE. The composite goes up first because it is
  // already decoded and in the fan; bossShotImage replaces it with exactly what
  // share and save hand to the OS. A preview of a different picture would be
  // believed, which is what makes it worse than none.
  check('...with a picture on it', !!$('svShotImg').getAttribute('src'));
  check('...and it picks that print, so the heading\'s own row acts on it too',
    slots[0].classList.contains('sv-fan-sel'), slots[0].className);

  // THE SHEET OWNS THE PAD WHILE IT IS UP. Everything on the card is still in
  // the layout — this is drawn over it, not instead of it — so without the
  // routing the cursor walks onto buttons behind a backdrop and a confirm
  // presses one nobody can see.
  const held = padStops();
  check('the cursor cannot reach the card behind it',
    !held.some((id) => id === 'svRestartBtn' || id === 'svNameSubmit'
      || id === 'svBoardDevice' || id === 'svBoardGlobal'),
    held.join(' → '));
  check('...and can reach the way out of the sheet',
    held.includes('svShotClose'), held.join(' → '));

  // A PRESS INSIDE THE SHEET IS A CLICK OUTSIDE THE CARD as far as anything
  // above it can tell. Nothing under this listens for one any more — the menu's
  // turn-the-card-over handler went with the flip — so what is checked is that
  // the stop is still doing its job: the sheet stays up and the card behind it
  // is untouched.
  $('svShotShare').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('a press inside the sheet does not put the print down', !hidden(view));

  view.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('a tap on its backdrop puts the print down', hidden(view));

  slots[0].click();
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape puts it down as well', hidden(view));
  // Held open across a restart it would keep a 1600x2000 bitmap alive and keep
  // the pad routed into a sheet over the next run.
  slots[0].click();
  ui.hideAllMenus();
  check('...and so does starting another run', hidden(view));
}

console.warn = realWarn;
console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
