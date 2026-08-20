#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:scoreflip
//
// The score card's TURN — front is the run, back is what the recorder saw —
// driven through the real ui.js under jsdom against a real recorded run.
//
// Everything this pins down fails silently. A score screen cannot throw — it
// is the only route back into the game — so the whole feature is written to
// degrade to a blank panel, and a blank panel is exactly what a legitimately
// empty run looks like. The four that would ship unnoticed:
//
//   THE VANISHED CURSOR    every control lives on one face or the other now.
//                          `backface-visibility` hides the away face from the
//                          EYE and from nothing else — it is still in the
//                          layout, still focusable, and still passes the
//                          .sv-hidden test the pad cursor filters on. A
//                          controller player would walk onto buttons on the far
//                          side of the card and the highlight would vanish, on
//                          the one screen that has to get them back into a
//                          game. The class has to be applied for real.
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
//   A STICKY FACE          a card that reopens back-side-up has quietly decided
//                          the player does not want to see their photographs
//                          any more.
//   A CARD SIZED TO ONE     both faces are absolute, so the card has no height
//   FACE                    of its own. Sized to the front, the back's last
//                          control is clipped off the bottom by overflow with
//                          no other symptom at all.
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
// THE TURN TAKES TIME, and every check about which face is live has to wait for
// it. Polled rather than slept: the rate is a config number and a fixed sleep
// would start failing the day somebody tunes it.
const { cardFlipMoving } = await import('../path/src/ui/cardFlip.js');
const settle = async () => {
  for (let i = 0; i < 600 && cardFlipMoving(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return !cardFlipMoving();
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
section('THE CARD — which face is up when it opens');
// ---------------------------------------------------------------------------
ui.showGameOver(gameState);

const front = $('svFaceFront');
const back = $('svFaceBack');

check('the card opens front side up', !hidden(front) && hidden(back));
// The front is the screen the game has always ended on, and every control that
// gets a player OUT of it lives there.
check('...carrying the recap, the roll and the way out',
  front.contains($('svGameOverStats')) && front.contains($('svTrophy'))
  && front.contains($('svRestartBtn')));
check('...and the tables are on the other side',
  back.contains($('svPanelWeapons')) && back.contains($('svPanelThreats')));

// THE CARD'S HEIGHT IS NOT CHECKED HERE and cannot be: both faces are absolute,
// so the height comes from measuring them, and jsdom reports 0 for every
// rectangle it is asked about. A harness that asserted a number here would be
// asserting its own stub. `npm run layout` measures this one, in a browser, at
// eight viewport sizes — see the note in tools/layout-audit.mjs about why.
// What IS checked here is that sizing ran without throwing, which it must not
// do: it happens inside showGameOver, and this card is the only route back
// into the game.
check('sizing the card did not take the score screen down',
  !$('svGameOverMenu').classList.contains('sv-hidden'));

$('svTurnOver').click();
check('the turn takes time rather than cutting', cardFlipMoving());
await settle();
check('...and lands on the back', !hidden(back) && hidden(front));
$('svTurnBack').click();
await settle();
check('...and turning back returns to the front', !hidden(front) && hidden(back));

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
section('THE PAD — no stop on a control on the away face');
// ---------------------------------------------------------------------------
// Every control that gets a player out of this screen is on the FRONT. With
// the card turned over they are inside a .sv-hidden face and must leave the
// cursor's list, or the pad walks onto controls nobody can see. The list is
// rebuilt every frame, which is what makes this recoverable at all — but only
// if ui/cardFlip.js hides the away face the way gameOverControls looks for,
// which backface-visibility on its own does not.
const padStops = () => {
  const seen = [];
  // BOTH DIRECTIONS, and that is not thoroughness — the cursor index survives
  // between openings of this card, so a walk that only ever goes down starts
  // wherever the last one finished and reports the tail of the list as if it
  // were the whole of it. Up first, to the top, then down through everything.
  const walk = (dir) => {
    menuInput.y = dir;
    for (let i = 0; i < 16; i++) {
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

// Turned to the BACK, where every front control is inside a .sv-hidden face.
$('svTurnOver').click();
await settle();
const onBack = padStops();
check('the cursor never lands on a control on the away face',
  !onBack.some((id) => id.startsWith('svTrophy') || id.startsWith('svSheet')
    || id === 'svRestartBtn' || id === 'svNameSubmit'),
  onBack.join(' → '));
check('...and the way back is reachable', onBack.includes('svTurnBack'), onBack.join(' → '));

$('svTurnBack').click();
await settle();
const onFront = padStops();
check('the trophy row is really on this card', !hidden($('svTrophy')));
check('front side up, the share buttons are stops again',
  onFront.includes('svTrophyShare'), onFront.join(' → '));
check('...as is the way out', onFront.includes('svRestartBtn'), onFront.join(' → '));
check('...and the back\'s own control is not', !onFront.includes('svTurnBack'),
  onFront.join(' → '));

// ---------------------------------------------------------------------------
section('BETWEEN DEATHS');
// ---------------------------------------------------------------------------
$('svTurnOver').click();
await settle();
ui.showGameOver(gameState);
check('the next death opens front side up',
  !hidden($('svFaceFront')) && hidden($('svFaceBack')));

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
  !$('svGameOverMenu').classList.contains('sv-hidden') && !hidden($('svFaceFront')));
check('...with no table at all', rows('svPanelWeapons').length === 0,
  `${rows('svPanelWeapons').length} row(s)`);
check('...and a line saying so',
  /Nothing was damaged/.test($('svPanelWeapons').textContent),
  $('svPanelWeapons').textContent.trim());
check('...on both halves of the back', /Nothing laid a finger/.test($('svPanelThreats').textContent),
  $('svPanelThreats').textContent.trim());
check('...without a warning', warnings.length === before,
  warnings.slice(before).join(' | '));

// ---------------------------------------------------------------------------
section('THE TURN ITSELF');
// ---------------------------------------------------------------------------
{
  const { prefersReducedMotion } = await import('../path/src/devices.js');
  check('reduced motion is a shared reading, not a per-surface copy',
    typeof prefersReducedMotion === 'function');

  // THE EMULSION'S TWO INPUTS. Written by ui/cardFlip.js on every frame it
  // moves and read by the sheen gradient in the stylesheet; a card that never
  // gets them shows the resting-pose fallbacks, which is why they have any.
  const card = $('svCard');
  ui.showGameOver(gameState);
  const rest = card.style.getPropertyValue('--sv-grazing');
  check('the card is lit before it has ever moved', rest !== '', JSON.stringify(rest));
  check('...square to the viewer, so the sheen is at its flattest',
    parseFloat(rest) === 0, rest);

  // THE WORN EDGE. A mask that failed to bake must leave the face UNMASKED —
  // an empty mask hides the whole card, and with it the way back into the game.
  // jsdom's canvas cannot produce pixels, so this harness exercises exactly
  // that failure path, which is the one worth being sure about.
  const masked = $('svFaceFront').style.maskImage || $('svFaceFront').style.webkitMaskImage;
  check('a face whose border could not be baked is not left masked to nothing',
    masked === '' || masked === 'none' || masked.startsWith('url('),
    JSON.stringify(masked));

  const { STYLE_NAMES } = await import('../path/src/ui/wornEdge.js');
  const { CONFIG } = await import('../path/src/config.js');
  check('the configured wear style is one that exists',
    STYLE_NAMES.includes(CONFIG.death.flip.wear.style) || CONFIG.death.flip.wear.style === 'clean',
    CONFIG.death.flip.wear.style);

  // THE WEAR IS BAKED OFF THE LAYOUT BOX, NOT THE ROTATED ONE.
  //
  // sizeCard re-bakes the border mask whenever a face's content changes, and
  // the two things that change it — the trophy fan's prints and the global
  // board replacing the local one — both land SECONDS after the card opens,
  // which is exactly when a player is turning it over. Read through
  // getBoundingClientRect the card's width at that moment is its projection: a
  // few pixels at 88 degrees, nothing at 90. The mask baked into that width and
  // stretched back over the full face shredded the card into vertical strands
  // and took the leaderboard with it, and then STAYED that way, because nothing
  // re-bakes it once the turn has landed.
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
    Object.defineProperty(cardEl, 'offsetWidth', { value: 460, configurable: true });
    Object.defineProperty(cardEl, 'offsetHeight', { value: 700, configurable: true });

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

    // Mid-turn: the projection is narrow, the layout box is not.
    cardEl.getBoundingClientRect = () => ({
      width: 16, height: 700, top: 0, left: 0, right: 16, bottom: 700, x: 0, y: 0,
    });
    bakes = 0;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    check('...and bakes nothing new while the card is turned edge-on',
      bakes === 0, `${bakes} bake(s) at a projected width of 16px`);

    dom.window.HTMLCanvasElement.prototype.toDataURL = realToDataURL;
    delete cardEl.getBoundingClientRect;
  }
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
section('THE WATER AROUND THE CARD');
// ---------------------------------------------------------------------------
// "Turn it over" is a caption in the card's own type, not a button, and on a
// phone it is a 90x14 target for the one gesture that reveals half the screen.
// The rest of the menu turns the card too — and the two ways that goes wrong
// are both silent: a click on Try again bubbles up here and flips on its way
// out, or the preview sheet's own buttons do.
{
  ui.showGameOver(gameState);
  const card = $('svCard');
  const fire = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  fire($('svGameOverTitle'));
  check('a click on the card itself does not turn it', !cardFlipMoving());

  fire($('svGameOverMenu'));
  check('a click on the water around it does', cardFlipMoving());
  // THE PROMOTION IS A STATE. will-change: transform left on for the minutes
  // somebody sits here keeps a 580px slab holding a live canvas per kill shot
  // in a composited layer that is never re-rasterised, and what that renders as
  // is a card of empty rectangles. It goes on with the turn and off with it.
  check('...and the card is promoted while it moves',
    card.classList.contains('sv-flip-turning'), card.className);
  await settle();
  check('...and demoted the moment it lands',
    !card.classList.contains('sv-flip-turning'), card.className);
  // WAITED FOR SEPARATELY, and the difference is the point: settle() watches
  // the ANGLE, and the froth off the leading edge outlives it by a second. The
  // canvas is a full-menu layer — if it were left behind after a turn there
  // would be one of them for every turn the player took.
  for (let i = 0; i < 600 && document.querySelectorAll('.sv-flip-bubbles').length; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  check('...and the bubble layer goes once the froth has cleared',
    document.querySelectorAll('.sv-flip-bubbles').length === 0);

  $('svTurnBack').click();
  await settle();
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
  check('the fan has a print to open', slots.length > 0, `${slots.length} slot(s)`);

  slots[0].click();
  check('a tap on a print opens it', !hidden(view));
  // WHAT IT SHOWS IS THE FILE. The composite goes up first because it is
  // already decoded and in the fan; bossShotImage replaces it with exactly what
  // share and save hand to the OS. A preview of a different picture would be
  // believed, which is what makes it worse than none.
  check('...with a picture on it', !!$('svShotImg').getAttribute('src'));
  check('...and it picks that print, so the card\'s own row acts on it too',
    slots[0].classList.contains('sv-fan-sel'), slots[0].className);

  // THE SHEET OWNS THE PAD WHILE IT IS UP. Everything on the card is still in
  // the layout — this is drawn over it, not instead of it — so without the
  // routing the cursor walks onto buttons behind a backdrop and a confirm
  // presses one nobody can see.
  const stops = padStops();
  check('the cursor cannot reach the card behind it',
    !stops.some((id) => id === 'svRestartBtn' || id === 'svNameSubmit' || id === 'svTurnOver'),
    stops.join(' → '));
  check('...and can reach the way out of the sheet',
    stops.includes('svShotClose'), stops.join(' → '));

  // A press on Share is a click outside the card as far as the menu can tell.
  const before = cardFlipMoving();
  $('svShotShare').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('a press inside the sheet does not turn the card underneath',
    cardFlipMoving() === before);

  view.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('a tap on its backdrop puts the print down', hidden(view));
  check('...without turning the card on the way', !cardFlipMoving());

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
