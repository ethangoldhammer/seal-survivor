#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:reroll
//
// THROWING THE HAND BACK — the reroll button under the level-up cards, and the
// bank a boss pays into.
//
// Driven through the real ui.js under jsdom, against the real player state and
// the real CONFIG. Nothing here is a stand-in.
//
// EIGHT ways it breaks, and the thing they have in common is that every one of
// them leaves a screen that looks completely fine:
//
//   THE FREE REROLL      the spend and the deal are two statements, and a deal
//                        that does not depend on the spend hands out a look at
//                        the deck the run never paid for. The counter still
//                        goes down to 0 and then stops moving, so the button
//                        keeps working and the number keeps saying zero.
//
//   THE HAND THAT DID    a reroll is only worth a press if it can change
//   NOT CHANGE           something. Dealt from the full pool it may legally
//                        return the cards just refused — so the deal has to be
//                        asked to avoid them, and asked in a way that is
//                        provable rather than hopeful (this file narrows the
//                        pool to six cards and deals three, twice).
//
//   ...AND THE SHORT     the exclusion cannot be honoured on a pool worn down
//   HAND IT CAUSES       to three. Dropping it there is the correct answer and
//                        the wrong one — two cards on the table — is what a
//                        `pool.filter(...)` with no floor produces.
//
//   THE BUTTON THAT      the row is hidden on a run that has never beaten a
//   ALWAYS SHOWED        boss, which is most of the level-ups in the game. A
//                        dead control reading 0 for the first ten minutes of
//                        every run is worse than no control.
//
//   THE STALE NUMBER     the count is written on the deal. Bank a reroll
//                        between two level-ups and a button that is not rebuilt
//                        shows the old number — which is the number the player
//                        then makes a decision against.
//
//   THE MENU'S OWN LOCK  a hand is un-pickable while it is still arriving. A
//                        reroll that ignores that throws back a hand the player
//                        has not seen, off a fire button they were already
//                        holding when the level landed.
//
//   THE BANK THAT        resetPlayer opens a run at CONFIG.upgradeReroll.start,
//   OUTLIVED ITS RUN     and a crash-resumed run has to come back with what it
//                        had banked rather than what a fresh run gets — the
//                        snapshot carries it, and a dropped field is invisible
//                        until someone resumes a run mid-boss-ladder.
//
//   THE CAP THAT         grantRerolls answers with what the cap let through,
//   ANNOUNCED ITSELF     and main.js only puts a receipt up when that is
//                        non-zero. Return the request instead of the delta and
//                        a full bank prints "+1" for a reroll nobody got.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. See the jsdom-harness recipe — the other way round dies with an
// error about an encoding fallback that names nothing in this file.
//
// jsdom has no layout engine, so nothing here asserts where the button lands.
// `npm run layout` is the file that measures screens.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// Synchronous, for the reason the tooltip harness gives at length: the menu
// waits one frame before it measures and stays LOCKED until it has, and a
// document that never paints has no next frame to wait for. Deferring here
// would leave every hand in this file locked, and a locked menu refuses the
// exact button this file is about.
globalThis.requestAnimationFrame = (fn) => { fn(Date.now()); return 0; };
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

// BEFORE our own hooks below. registerHooks runs newest-first and the loader
// claims every `?raw`/`?url` import, so registering it after us would swallow
// the stubs. See the note in tools/vite-loader.mjs.
await import('./vite-loader.mjs');

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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

globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
// The arrival is off in here, same as every other harness that drives this
// screen: the hand is thrown into its cells and the menu stays locked until the
// last card lands, which a test that deals and acts in one tick can never get
// past. The one section that WANTS the lock turns it back on for itself.
CONFIG.upgradeSlam.enabled = false;
const { initFeedback } = await import('../path/src/systems/feedback.js');
const {
  player, grantRerolls, spendReroll, rerollsLeft, startingRerolls,
} = await import('../path/src/entities/player.js');
const { packRun } = await import('../path/src/systems/runSnapshot.js');
const { UI_TEXT } = await import('../path/src/uiTextTable.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onNameSubmit() {} });

const cards = () => [...document.getElementById('svCards').querySelectorAll('.sv-card')];
const handNames = () => cards().map((c) => c.querySelector('.sv-card-name')?.textContent ?? '');
const row = () => document.getElementById('svRerollRow');
const button = () => document.getElementById('svReroll');
const rowShown = () => !!row() && !row().classList.contains('sv-hidden');
const buttonCount = () => button()?.querySelector('.sv-reroll-n')?.textContent ?? null;
const clickReroll = () => button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

// Narrow the offer pool to exactly these ids, so a hand of three out of fifty
// becomes a hand of three out of six and can be asserted against.
const enabledWas = new Map(CONFIG.upgrades.map((u) => [u.id, u.enabled]));
function offerOnly(ids) {
  for (const u of CONFIG.upgrades) u.enabled = ids.includes(u.id);
}
const restoreOffer = () => {
  for (const u of CONFIG.upgrades) u.enabled = enabledWas.get(u.id);
};

// Cards with no `exclusive` group and no roll, so narrowing the pool to six of
// them cannot be quietly narrowed further by a rule this file is not testing.
const PLAIN = CONFIG.upgrades
  .filter((u) => u.enabled !== false && !u.exclusive && !u.roll && (u.weight ?? 1) > 0)
  .map((u) => u.id);

// A RUN THAT HAS JUST BEGUN, as far as this file's subject is concerned.
//
// NOT resetPlayer(): that reaches for `player.mesh` (it puts the seal back in
// mid-water) and there is no seal in a jsdom document. What this file needs
// from a fresh run is the bank at its opening value and no hand on the table,
// which is exactly these two lines — and startingRerolls() rather than 0, so
// the seed stays the one place the opening bank is decided.
const freshRun = () => {
  ui.hideAllMenus();
  player.rerolls = startingRerolls();
  player.rerollsEarned = 0;
};

// ---------------------------------------------------------------------------
section('The bank');
{
  freshRun();
  check('a run opens with what CONFIG says and nothing more',
    player.rerolls === startingRerolls(), `${player.rerolls} vs ${startingRerolls()}`);

  const capWas = CONFIG.upgradeReroll.max;
  CONFIG.upgradeReroll.max = 2;
  player.rerolls = 0;
  check('a payout is banked', grantRerolls(1) === 1 && rerollsLeft() === 1, `${rerollsLeft()}`);
  check('...and reports what the CAP let through, not what was asked for',
    grantRerolls(5) === 1 && rerollsLeft() === 2, `banked to ${rerollsLeft()}`);
  check('a payout against a full bank reports nothing banked',
    grantRerolls(1) === 0 && rerollsLeft() === 2, `${rerollsLeft()}`);
  CONFIG.upgradeReroll.max = capWas;

  player.rerolls = 1;
  check('a spend takes exactly one', spendReroll() === true && rerollsLeft() === 0);
  check('...and an empty bank refuses rather than going negative',
    spendReroll() === false && rerollsLeft() === 0, `${rerollsLeft()}`);

  const enabledWasCfg = CONFIG.upgradeReroll.enabled;
  CONFIG.upgradeReroll.enabled = false;
  player.rerolls = 5;
  check('switched off, the bank reads empty however much is in it',
    rerollsLeft() === 0 && spendReroll() === false && grantRerolls(1) === 0);
  CONFIG.upgradeReroll.enabled = enabledWasCfg;
}

// ---------------------------------------------------------------------------
section('The button appears only once a run has earned one');
{
  freshRun();
  offerOnly(PLAIN.slice(0, 6));
  ui.showLevelUp();
  check('a run with no rerolls shows no row at all', !rowShown());

  grantRerolls(1);
  ui.showLevelUp();
  check('...and one banked puts it up', rowShown());
  check('the count is printed', buttonCount() === '1', String(buttonCount()));
  check('the word is uiText.csv’s, not a literal in ui.js',
    button().textContent.includes(UI_TEXT.rerollButton), button().textContent);
  restoreOffer();
}

// ---------------------------------------------------------------------------
section('Pressing it spends one and deals again');
{
  freshRun();
  // SIX CARDS, DEAL THREE. The excluded hand is three of them, which leaves
  // exactly three to deal from — so if the exclusion works the second hand is
  // the other three, provably, rather than "probably different".
  offerOnly(PLAIN.slice(0, 6));
  grantRerolls(1);
  ui.showLevelUp();
  const first = handNames();
  check('a hand was dealt', first.length === CONFIG.upgradeChoices, `${first.length} cards`);

  clickReroll();
  const second = handNames();
  check('one reroll was spent', rerollsLeft() === 0, `${rerollsLeft()} left`);
  check('a full hand came back', second.length === CONFIG.upgradeChoices, `${second.length} cards`);
  check('...and it is a DIFFERENT hand, not a redraw that may repeat',
    second.every((n) => !first.includes(n)), `${first.join(', ')} → ${second.join(', ')}`);
  check('the button now reads empty rather than disappearing',
    rowShown() && button().disabled === true && buttonCount() === null,
    `shown=${rowShown()} disabled=${button()?.disabled} n=${buttonCount()}`);
  check('...and says so in uiText.csv’s words',
    button().textContent.includes(UI_TEXT.rerollNone), button().textContent);

  const before = handNames();
  clickReroll();
  check('a press against an empty bank changes nothing',
    handNames().join('|') === before.join('|') && rerollsLeft() === 0);

  // THE NEXT LEVEL-UP, on an empty bank. The row must still be there: it is
  // showing the answer to "why did the button stop working", and a control that
  // disappears reads as a bug rather than as a resource being spent. Off the
  // bank alone it would vanish here, which is the one case it exists for.
  ui.showLevelUp();
  check('a later hand still carries the spent button',
    rowShown() && button().disabled === true,
    `shown=${rowShown()} disabled=${button()?.disabled}`);
  restoreOffer();
}

// ---------------------------------------------------------------------------
section('A pool too thin to honour the exclusion still deals a full hand');
{
  freshRun();
  // EXACTLY THREE CARDS IN THE GAME. Every one of them is in the hand being
  // thrown back, so "deal around it" would leave nothing to deal.
  offerOnly(PLAIN.slice(0, 3));
  grantRerolls(1);
  ui.showLevelUp();
  const before = handNames();
  clickReroll();
  const after = handNames();
  check('the reroll still went through', rerollsLeft() === 0);
  check('a full hand, not a short one',
    after.length === CONFIG.upgradeChoices, `${after.length} cards`);
  check('...and it is the same three, which is the honest answer here',
    after.every((n) => before.includes(n)), after.join(', '));
  restoreOffer();
}

// ---------------------------------------------------------------------------
section('The count is re-read on every deal');
{
  freshRun();
  offerOnly(PLAIN.slice(0, 6));
  grantRerolls(1);
  ui.showLevelUp();
  check('one to start with', buttonCount() === '1', String(buttonCount()));
  // A boss goes down between two level-ups, which is the ordinary case.
  grantRerolls(1);
  ui.showLevelUp();
  check('the next hand shows the new total', buttonCount() === '2', String(buttonCount()));
  check('...and the row says it just grew', row().classList.contains('sv-reroll-new'));
  ui.showLevelUp();
  check('a hand dealt with no change does not re-announce it',
    !row().classList.contains('sv-reroll-new'));
  restoreOffer();
}

// ---------------------------------------------------------------------------
section('A half-arrived hand cannot be thrown back');
{
  freshRun();
  offerOnly(PLAIN.slice(0, 6));
  grantRerolls(1);
  // The slam back on for this one section only — the lock is the subject here
  // rather than the obstacle it is everywhere else in this file.
  CONFIG.upgradeSlam.enabled = true;
  ui.showLevelUp();
  const locked = document.getElementById('svLevelUpMenu').classList.contains('sv-menu-locked');
  const before = handNames();
  clickReroll();
  check('the menu really is locked mid-arrival', locked);
  check('...and the reroll was refused',
    rerollsLeft() === 1 && handNames().join('|') === before.join('|'),
    `${rerollsLeft()} left`);

  // THAT PRESS WENT TO THE ARRIVAL, so the arrival is over and the NEXT one is
  // a real press on a hand the player has now seen. Asserted because the two
  // halves are easy to get backwards: a guard strict enough to refuse the first
  // press can just as easily refuse every press after it, and a button that
  // works only on the second click reads as an unreliable button rather than as
  // one that would not take a press meant for something else.
  const stillThere = handNames();
  clickReroll();
  check('...but the next press, on a landed hand, goes through',
    rerollsLeft() === 0 && handNames().join('|') !== stillThere.join('|'),
    `${rerollsLeft()} left`);
  CONFIG.upgradeSlam.enabled = false;
  ui.hideAllMenus();
  restoreOffer();
}

// ---------------------------------------------------------------------------
section('The bank survives a crash');
{
  const snap = packRun({ version: 1, picks: [], level: 4, bosses: 2, rerolls: 2 });
  check('the snapshot carries it', snap.rerolls === 2, String(snap.rerolls));
  const old = packRun({ version: 1, picks: [], level: 4, bosses: 2 });
  check('...and a snapshot written before the field existed reads as none owed',
    old.rerolls === 0, String(old.rerolls));
  const silly = packRun({ version: 1, picks: [], level: 4, bosses: 2, rerolls: -3 });
  check('...and a negative one cannot come back', silly.rerolls === 0, String(silly.rerolls));
  const spent = packRun({ version: 1, picks: [], level: 4, bosses: 2, rerolls: 0, rerollsEarned: 3 });
  check('a run that earned three and spent three keeps the fact it earned them',
    spent.rerollsEarned === 3 && spent.rerolls === 0,
    `${spent.rerolls} left of ${spent.rerollsEarned}`);
}

// ---------------------------------------------------------------------------
section('Switched off, nothing about it is on screen');
{
  freshRun();
  offerOnly(PLAIN.slice(0, 6));
  const was = CONFIG.upgradeReroll.enabled;
  grantRerolls(1);
  CONFIG.upgradeReroll.enabled = false;
  ui.showLevelUp();
  check('no row on a build with the mechanic off', !rowShown());
  CONFIG.upgradeReroll.enabled = was;
  restoreOffer();
}

// ---------------------------------------------------------------------------
section('Nothing warned');
{
  const noisy = warnings.filter((w) => w.includes('[uiText]') || w.includes('[upgrades]'));
  check('no missing rows behind the button', noisy.length === 0, noisy.join(' | '));
}

restoreOffer();
console.log(`\n${failures ? `FAILED (${failures})` : 'All checks passed'}`);
process.exit(failures ? 1 : 0);
