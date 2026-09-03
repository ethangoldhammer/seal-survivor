#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tooltip
//
// The auto-generated effect tooltip on the level-up cards, driven through the
// real ui.js under jsdom.
//
// The box started as ONE measured sentence, for a roster whose descs were all
// hand-typed English that never said {effect}. Both halves of that have since
// moved: 49 of the 51 descs carry the token now, so the CARD quotes the
// measurement, and the tooltip is rows shared with the hive (ui/upgradeTip.js)
// carrying the two things a card's face cannot — the running total across the
// stacks held, and what the ability has done this run. The long note beside
// the first section has the whole story.
//
// SEVEN ways it can break, none of which is visible by looking at one card:
//
//   SAYS IT TWICE   nearly every desc now spells the effect out, because
//                   {effect} put it there. A tooltip repeating the line four
//                   pixels above it trains the player to stop reading the box
//                   on the cards where it is the only information there is.
//   EMPTY BOX       `overboost` multiplies a stat that sits at 0, so it
//                   measures no change at all. A bordered box with nothing in
//                   it looks like a bug and is one.
//   ORPHANED NODE   the tooltip lives inside #svCards, and showLevelUp clears
//                   that container with innerHTML = ''. Hold the reference
//                   across a re-deal and every tooltip from level 2 onwards is
//                   positioned inside an element no longer in the document.
//   MOUSE ONLY      on a pad the pointer never moves. Bind to pointerenter
//                   alone and a controller run never sees an effect at all.
//   A STUCK TOTAL   the running total is measureTotal(def, held), and `held`
//                   comes from the pick list. Read the wrong count and the box
//                   quotes a build the player is not in — asserted as a
//                   DIFFERENCE between one stack and two, because a row that
//                   never varies passes an equality check at both.
//   A SILENT LEDGER the run row reads systems/playtest.js MID-RUN, and the
//                   ledger only pushes a bucket every twenty seconds. Summed
//                   without the open bucket it is a confident zero for up to a
//                   whole bucket at a time, which reads as a broken tooltip.
//   VERBOSITY       three levels, and the two that hide things are the ones
//                   nobody looks at. Off must show nothing anywhere.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. The other way round breaks the CJS chain jsdom loads through and
// fails with an error about an encoding fallback. See the jsdom-harness recipe.
//
// jsdom has no layout engine, so getBoundingClientRect() is all zeroes here.
// This file tests WHICH text appears and WHEN — never where the box lands.
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
// SYNCHRONOUS, and that is a decision rather than a shortcut.
//
// The level-up menu measures the hand, waits ONE FRAME, and then tiles the comb
// against a page that has settled — the menu stays locked until it has. jsdom
// has no compositor and no frames: deferring here means every deal in this file
// returns a menu that is still locked, so every hover and every pick is refused
// and reads as this file's subject being broken. Running the callback now is
// what "the next frame" means in a document that never paints.
globalThis.requestAnimationFrame = (fn) => { fn(Date.now()); return 0; };
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// Not copying window.performance: jsdom's delegates to the global one and
// swapping it in recurses until the stack blows.

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

globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
// THE ARRIVAL IS OFF IN HERE. The level-up hand is thrown into its cells now
// and the menu stays locked until the last card lands — which is right on
// screen and wrong in a harness that deals a hand and acts on it in the same
// tick: every hover and every pick would be refused by the lock, and read as
// this file's subject being broken. The screen has a test of its own, npm run
// test:comb, and it is the only place that should be driving it.
CONFIG.upgradeSlam.enabled = false;
const { initFeedback } = await import('../path/src/systems/feedback.js');
const { measure, measureTotal, phraseAll, sentenceCase } = await import('../path/src/upgradeText.js');
const { player } = await import('../path/src/entities/player.js');
const { menuInput } = await import('../path/src/input.js');
const playtest = await import('../path/src/systems/playtest.js');
const { setSetting } = await import('../path/src/systems/settings.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
const picked = [];
ui.initUI({
  onStart() {}, onRestart() {}, onLevelChoice(c) { picked.push(c.id); }, onNameSubmit() {},
});

const cards = () => document.getElementById('svCards');
const fx = () => cards().querySelector('.sv-card-fx');
const shown = () => {
  const n = fx();
  return n && n.classList.contains('sv-fx-on') ? n.textContent : null;
};
const pointerEnter = (node) => node.dispatchEvent(new dom.window.Event('pointerenter', { bubbles: false }));
const pointerLeave = (node) => node.dispatchEvent(new dom.window.Event('pointerleave', { bubbles: false }));

// Deal a hand of exactly the upgrades named, by narrowing the offer pool. The
// real menu rolls three from forty-four, which cannot be asserted against.
const enabledWas = new Map(CONFIG.upgrades.map((u) => [u.id, u.enabled]));
const choicesWas = CONFIG.upgradeChoices;
function deal(...ids) {
  for (const u of CONFIG.upgrades) u.enabled = ids.includes(u.id);
  CONFIG.upgradeChoices = ids.length;
  ui.showLevelUp();
  return [...cards().querySelectorAll('.sv-card')];
}
const restore = () => {
  for (const u of CONFIG.upgrades) u.enabled = enabledWas.get(u.id);
  CONFIG.upgradeChoices = choicesWas;
};

const byId = new Map(CONFIG.upgrades.map((u) => [u.id, u]));
const effectOf = (id, stack = 1) => phraseAll(measure(byId.get(id), stack), stack);

// ---------------------------------------------------------------------------
// WHAT CHANGED UNDER THIS TEST, and why half of it is rewritten.
//
// TWO THINGS, and they arrived from opposite directions:
//
//   1. upgrades.csv learned {effect}. 49 of the 51 descs now carry the token,
//      so the card's own FACE quotes the measurement — which means the
//      dedupe in cardEffect() (a tooltip may not repeat the line above it,
//      word for word) now fires on almost every card in the game. The old
//      assertions here were all written before that landed and every one of
//      them asked for a box the dedupe is correctly refusing to show.
//
//   2. The tooltip stopped being one sentence. It is rows now, shared with
//      the three hive surfaces (ui/upgradeTip.js), and what it adds on this
//      screen is the two things a card's face cannot carry: where the stacks
//      you ALREADY hold have got you to, and what the ability has actually
//      done this run.
//
// So the questions are the same questions and the answers moved. Read as
// text-content the tooltip is now a run-on string with no separators, which is
// exactly the shape of assertion that passes while looking wrong — every check
// below reads a NAMED ROW instead.
const tipRow = (key) => fx()?.querySelector(`.sv-uptip-row[data-row="${key}"] .sv-uptip-text`)?.textContent ?? null;
const tipName = () => fx()?.querySelector('.sv-uptip-name')?.textContent ?? null;

// ---------------------------------------------------------------------------
section('A card whose face already measures itself adds no "next" row');
{
  // WHICH CARD IS NOT THE POINT — carrying `{effect}` is. This named
  // `bounceShot` outright, and when that desc was rewritten to flavour alone
  // the section failed for a reason that has nothing to do with the dedupe it
  // tests: a card is allowed to stop measuring itself on its face, and nine of
  // the fifty-five descs deliberately do.
  //
  // So it picks the first card that DOES carry the token. The behaviour under
  // test is unchanged: a face that already states the measurement leaves the
  // tooltip nothing to say about the stack being offered, and saying it anyway
  // is a box repeating the line four pixels above it, which teaches the player
  // to stop reading the box on the cards where it is the only information there
  // is.
  const measuring = CONFIG.upgrades.filter((u) => /\{effect\}/.test(u.desc ?? '')).map((u) => u.id);
  check('some card still measures itself on its face', measuring.length > 0,
    `${measuring.length} of ${CONFIG.upgrades.length} descs carry {effect}`);
  const [card] = deal(measuring[0]);
  // Case-insensitively: expandDesc sentence-cases the fragment when it lands
  // after a full stop, which is a difference in the CARD's typography and not
  // in what it says. The dedupe in cardEffect compares the same way.
  const face = card.querySelector('.sv-card-desc').textContent.toLowerCase();
  check(`${measuring[0]}: the desc really does carry the measurement`,
    face.includes(effectOf(measuring[0]).toLowerCase()), face);
  pointerEnter(card);
  check('...so a first pick shows no tooltip at all', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('...and a card that does NOT still gets it');
{
  // shrimpRing's desc is prose with no token in it, so the measurement is
  // still the only place a player can read what the pick actually hands over —
  // and it is measured, so it cannot drift from apply().
  const [card] = deal('shrimpRing');
  pointerEnter(card);
  check('shrimpRing shows a tooltip', !!shown(), shown() ?? 'nothing shown');
  check('...quoting what apply() actually does', tipRow('next') === sentenceCase(effectOf('shrimpRing')),
    `card desc says "${byId.get('shrimpRing').desc}", row says "${tipRow('next')}"`);
  // The card's title is a line above the box, so the box does not repeat it —
  // the hive surfaces keep the head, this one is the breakdown alone.
  check('...and NOT named, since the card face already is', tipName() === null,
    tipName() ?? 'no name');
  pointerLeave(card);
  check('leaving the card takes it away', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('A card whose apply() moves nothing gets no empty box');
{
  // overboost multiplies `recoil`, which the stat block seeds at 0 — so
  // `recoil *= 1.3` measures as no change and there is nothing to report. The
  // card's own desc claims "+30% recoil boost", which is a separate problem
  // and not one a tooltip should paper over by inventing a number.
  check('overboost really does measure nothing', effectOf('overboost') === '',
    `measured "${effectOf('overboost')}"`);
  const [card] = deal('overboost');
  pointerEnter(card);
  check('...so hovering it shows no tooltip', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('The two rows a card face cannot carry');
{
  // A card says what the NEXT stack does. It has never said where the stacks
  // already held have got you to, and it cannot say what the ability has done
  // this run — which on the level-up screen, mid-fight, is the question the
  // pick is actually being made on.
  playtest.beginRun({});
  // Real damage, under the tag ricochet books against — see SOURCE_UPGRADES.
  playtest.recordDamage('ricochet', 4200);
  playtest.recordKill({}, 'ricochet');
  player.upgrades.push({ ...byId.get('bounceShot') });

  const [card] = deal('bounceShot');
  pointerEnter(card);
  check('an owned card shows a tooltip even though its face measures itself',
    !!shown(), shown() ?? 'nothing shown');
  // CONDITIONAL ON THE FACE, because the dedupe is. This block needs
  // `bounceShot` specifically — it is the card whose damage books against the
  // `ricochet` tag — and that card's desc has since been rewritten to flavour
  // alone. With no `{effect}` on the face there is nothing to dedupe against,
  // so a "next" row is correct rather than a repeat. Asserted both ways so the
  // check still means something whichever way the desc is written.
  const faceMeasures = /\{effect\}/.test(byId.get('bounceShot')?.desc ?? '');
  if (faceMeasures) {
    check('...with no "next" row, which the face still carries',
      tipRow('next') === null, tipRow('next') ?? '');
  } else {
    check('...with a "next" row, because the face no longer measures itself',
      tipRow('next') !== null, tipRow('next') ?? 'no row');
  }
  check('...a running total for the one stack held',
    tipRow('total') === sentenceCase(phraseAll(measureTotal(byId.get('bounceShot'), 1), 1)),
    tipRow('total') ?? 'no row');
  const run = tipRow('run');
  check('...and what it has done this run', !!run, run ?? 'no row');
  check('...named by the LINE the ledger books it under, not by the card',
    run?.startsWith('Ricochet Rounds:') === true, run ?? '');
  check('...quoting the damage that was recorded', run?.includes('4.2k') === true, run ?? '');
  check('...and the kill', run?.includes('1 ') === true, run ?? '');

  player.upgrades.length = 0;
  playtest.endRun('quit');
}

// ---------------------------------------------------------------------------
section('An upgrade the ledger has nothing on says so');
{
  // A zero is a fact and it is said out loud. Dropping the row instead would
  // read as "this tooltip does not have that information", when what is true
  // is "you have been carrying this and it has done nothing" — which is the
  // single most useful thing the ledger knows.
  playtest.beginRun({});
  player.upgrades.push({ ...byId.get('bounceShot') });
  const [card] = deal('bounceShot');
  pointerEnter(card);
  const run = tipRow('run');
  check('the row is there', !!run, run ?? 'no row');
  check('...and it is not a damage figure', run?.includes('dealt') === false, run ?? '');
  player.upgrades.length = 0;
  playtest.endRun('quit');
}

// ---------------------------------------------------------------------------
section('The tooltip answers for the stack being held');
{
  // Every repeatable card is a different card the second time. The row that
  // moves is now the TOTAL — one stack of bounceShot and two are different
  // amounts of the same thing, and a tooltip stuck on one of them would be
  // quoting a build the player is not in.
  //
  // Asserted as a DIFFERENCE and not just against the measured string. Both
  // stacks matching would also be true if the row were suppressed at both and
  // every comparison were null against null — which is how a card that never
  // varies passes a stacking test without stacking.
  player.upgrades.push({ ...byId.get('bounceShot') });
  const [one] = deal('bounceShot');
  pointerEnter(one);
  const atOne = tipRow('total');

  player.upgrades.push({ ...byId.get('bounceShot') });
  const [two] = deal('bounceShot');
  pointerEnter(two);
  const atTwo = tipRow('total');
  player.upgrades.length = 0;

  check('one stack quotes one stack', atOne === sentenceCase(phraseAll(measureTotal(byId.get('bounceShot'), 1), 1)),
    `got "${atOne}"`);
  check('two stacks quote two', atTwo === sentenceCase(phraseAll(measureTotal(byId.get('bounceShot'), 2), 2)),
    `got "${atTwo}"`);
  check('...and the two really are different text', !!atOne && !!atTwo && atOne !== atTwo,
    `"${atOne}" vs "${atTwo}"`);
  // The FIRST stack is the one that unlocks the ability, so it is the only
  // total that names it — two stacks of it is a quantity of ricochet, not a
  // second ricochet. This is the check that catches a total quietly rebuilt
  // from stack 1 repeated, which would name the unlock at every depth.
  check('...with only the one-stack total naming the unlock',
    atOne?.includes('chaining ricochet shot') === true
    && atTwo?.includes('chaining ricochet shot') === false,
    `stack 2 says "${atTwo}"`);
}

// ---------------------------------------------------------------------------
section('The verbosity setting');
{
  // Off is off everywhere, and Short keeps the question at the moment of a pick
  // and drops the reading. See SCHEMA.hud.upgradeTips.
  //
  // DRIVEN WITH octoGrab, which has a LEVEL READOUT — so its tip is a table of
  // named quantities rather than a single measured line, and the three
  // verbosities are told apart by what that table carries:
  //
  //   off    nothing at all
  //   short  the deltas, no spans, no run row
  //   full   the deltas WITH spans, and the run row
  //
  // It is also a CONTROL ability (no damage, only events), which is the branch
  // of the run row nothing else here exercises.
  playtest.beginRun({});
  playtest.recordControl('octoGrab', 7);
  player.upgrades.push({ ...byId.get('octoGrab') });

  setSetting('hud.upgradeTips', 'off');
  const [a] = deal('octoGrab');
  pointerEnter(a);
  check('off shows nothing', shown() === null, shown() ?? '');

  const lvRows = () => [...(fx()?.querySelectorAll('.sv-uptip-row[data-row^="lv:"]') ?? [])]
    .map((r) => r.querySelector('.sv-uptip-text')?.textContent ?? '');

  setSetting('hud.upgradeTips', 'short');
  const [b] = deal('octoGrab');
  pointerEnter(b);
  check('short shows what the level buys', lvRows().length > 0, lvRows().join(' | '));
  check('...as deltas alone, with no span',
    lvRows().every((t) => !t.includes('\u2192')), lvRows().join(' | '));
  check('...and drops the run', tipRow('run') === null, tipRow('run') ?? '');

  setSetting('hud.upgradeTips', 'full');
  const [c] = deal('octoGrab');
  pointerEnter(c);
  check('full shows the same quantities', lvRows().length > 0, lvRows().join(' | '));
  check('...and adds where each one lands',
    lvRows().some((t) => t.includes('\u2192')), lvRows().join(' | '));
  // A damageless ability counts its output in EVENTS. A damage figure here
  // would be a zero, and a zero for a card that spent the run hauling fish off
  // reads as the card being useless rather than as the ledger measuring the
  // wrong thing.
  const run = tipRow('run');
  check('...and the control ability reports events, not damage',
    run?.includes('7 ') === true && run?.includes('dealt') === false, run ?? 'no row');

  player.upgrades.length = 0;
  playtest.endRun('quit');
}

// ---------------------------------------------------------------------------
section('A re-deal does not leave the tooltip in a detached container');
{
  // showLevelUp clears #svCards with innerHTML = '', which deletes the tooltip
  // node along with the cards. A held reference would still take text and
  // still report itself visible, while sitting in an element that is no longer
  // in the document — nothing throws and nothing is ever drawn.
  //
  // Driven with shrimpRing rather than bounceShot: this is about the NODE, and
  // it needs two cards that actually put a box up.
  const [a] = deal('shrimpRing');
  pointerEnter(a);
  check('first deal shows one', !!shown(), shown() ?? 'nothing shown');

  const [b] = deal('shrimpRing');
  pointerEnter(b);
  const node = fx();
  check('second deal shows one too', !!shown(), shown() ?? 'nothing shown');
  check('...and it is inside the live card row', !!node && node.parentElement === cards(),
    node ? `parent is ${node.parentElement?.id ?? 'detached'}` : 'no node');
  check('...with only one tooltip in the document',
    document.querySelectorAll('.sv-card-fx').length === 1,
    `${document.querySelectorAll('.sv-card-fx').length} found`);
}

// ---------------------------------------------------------------------------
section('The pad and the keyboard get it as well');
{
  deal('shrimpRing');
  check('nothing is shown before an input arrives', shown() === null, shown() ?? '');

  // updateMenuNav reads menuInput every frame, so poking a direction in is
  // exactly what a stick push looks like from the menu's side.
  menuInput.x = 1;
  ui.updateMenuNav?.();
  menuInput.x = 0;
  check('a pad move selects and shows the tooltip', tipRow('next') === sentenceCase(effectOf('shrimpRing')),
    tipRow('next') ?? 'nothing shown');
}

// ---------------------------------------------------------------------------
section('Choosing a card takes the tooltip with it');
{
  const [card] = deal('shrimpRing');
  pointerEnter(card);
  check('up before the pick', !!shown(), shown() ?? 'nothing shown');
  card.click();
  check('the card was taken', picked.includes('shrimpRing'), picked.join(', '));
  check('...and the tooltip went with it', shown() === null, shown() ?? '');
}

// ---------------------------------------------------------------------------
section('Nothing warned');
{
  const noisy = warnings.filter((w) => w.includes('[upgrades]'));
  check('no placeholder warnings from the cards', noisy.length === 0, noisy.join(' | '));
}

restore();
console.log(`\n${failures ? `FAILED (${failures})` : 'All checks passed'}`);
process.exit(failures ? 1 : 0);
