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
const { LEVEL_STATS } = await import('../path/src/levelStats.js');
const { player, availableUpgrades, levelableUpgrades } = await import('../path/src/entities/player.js');
const { menuInput } = await import('../path/src/input.js');
const playtest = await import('../path/src/systems/playtest.js');
const { setSetting } = await import('../path/src/systems/settings.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
const hoverPoint = await import('../path/src/ui/hoverPoint.js');
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
  //
  // AND NOT ONE WITH A LEVEL READOUT. A card registered in LEVEL_STATS gets a
  // TABLE instead of a measured line (see upgradeTip.js), and that table is not
  // what the dedupe governs — it is a different set of rows, correctly shown
  // whether or not the face states the effect. bubbleJet happens to be the
  // first {effect} card in the roster and has one, so a plain "take the first"
  // asserted the absence of a box that is supposed to be there.
  // AND THE PRECONDITION IS FOUND, NOT ASSUMED. `{effect}` in the CSV does not
  // guarantee the rendered face contains the measurement verbatim: clubPower's
  // token expands to a three-stat phrase its sentence then reads around, so
  // the dedupe correctly does NOT fire on it. Taking a fixed index and then
  // ASSERTING the precondition made this section fail whenever the roster
  // reshuffled under it — twice now — for reasons that have nothing to do with
  // the dedupe. So it searches for the first card that genuinely satisfies it
  // and tests the behaviour there, and the only thing asserted outright is
  // that such a card still exists at all.
  //
  // Case-insensitively: expandDesc sentence-cases the fragment when it lands
  // after a full stop, which is a difference in the CARD's typography and not
  // in what it says. The dedupe in cardEffect compares the same way.
  const measuring = CONFIG.upgrades
    .filter((u) => /\{effect\}/.test(u.desc ?? '') && !LEVEL_STATS[u.id])
    .map((u) => u.id);
  let stated = null;
  let card = null;
  for (const id of measuring) {
    const [c] = deal(id);
    const face = c?.querySelector('.sv-card-desc')?.textContent.toLowerCase() ?? '';
    const said = effectOf(id).toLowerCase();
    if (said && face.includes(said)) { stated = id; card = c; break; }
  }
  check('some card still states its measurement on its face, with no level table',
    !!stated, `${measuring.length} of ${CONFIG.upgrades.length} descs carry {effect}`);
  if (card) {
    pointerEnter(card);
    check(`${stated}: so a first pick shows no tooltip at all`, shown() === null, shown() ?? '');
  }
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
section('A card the run already holds is never dealt again');
{
  // THE OWNED-CARD TOOLTIP HAS NO HOME ON THIS SCREEN ANY MORE. It used to:
  // the level-up menu could deal a card the run was already holding, and the
  // two rows a card's face cannot carry — where the stacks already held have
  // got you to, and what the ability has done this run — were the reason the
  // box existed there.
  //
  // availableUpgrades() no longer offers a held card at all (see
  // entities/player.js). Depth is bought on the hive ceremony and the level
  // blob, which draw from levelableUpgrades() instead, and the `total` and
  // `run` rows are asserted against the shared builder in
  // tools/upgrade-tip-test.mjs, where the surfaces that CAN show them live.
  //
  // What is left to check here is the rule itself, from the menu's own side:
  // deal() switches every other card off, so a run holding the one survivor
  // must get an empty hand rather than its own card back.
  playtest.beginRun({});
  playtest.recordDamage('ricochet', 4200);
  playtest.recordKill({}, 'ricochet');

  // TWO CARDS ENABLED, NOT ONE. With bounceShot the only row in the deck,
  // taking it empties the offer entirely and the deepening fallback below
  // correctly deals it straight back — which is the soft-lock guard doing its
  // job, not the rule failing. Leaving shrimpRing on keeps something new in
  // the pool, which is the state this check is about.
  const fresh = deal('bounceShot', 'shrimpRing').map((c) => c.querySelector('.sv-card-name').textContent);
  check('a card the run does not hold is dealt', fresh.length === 2, fresh.join(', '));

  player.upgrades.push({ ...byId.get('bounceShot') });
  const again = deal('bounceShot', 'shrimpRing').map((c) => c.querySelector('.sv-card-name').textContent);
  check('...and the same card is not dealt once it is held',
    !again.includes(byId.get('bounceShot').name), again.join(', ') || 'nothing');
  check('...but it is still levelable, which is where depth comes from',
    levelableUpgrades().some((u) => u.id === 'bounceShot'));

  player.upgrades.length = 0;
  playtest.endRun('quit');
}

// ---------------------------------------------------------------------------
section('...but a run holding the whole deck still gets a hand');
{
  // THE SOFT-LOCK THE RULE ABOVE MAKES REACHABLE. The pool used to be
  // unemptiable — a held card stayed in it until it capped — and now it is
  // not, so a run long enough to collect everything would arrive at a paused
  // game behind a menu with no cards on it and no way out. drawUpgrades has a
  // comment about exactly this state; this is the check that it cannot happen.
  //
  // Every card the deck can offer is taken, one each, and the screen is asked
  // for a hand. The floor under it is the deepening pool (see deepenable in
  // ui/ui.js), so what comes back is stacks — the one place on this screen
  // where a held card is dealt, and only because there is nothing else left.
  restore();
  playtest.beginRun({});
  const everything = availableUpgrades().map((u) => u.id);
  check('the deck is bigger than a hand', everything.length > CONFIG.upgradeChoices,
    `${everything.length} cards`);
  for (const id of everything) player.upgrades.push({ id, rarity: 'common' });
  check('...and taking all of it empties the offer', availableUpgrades().length === 0,
    `${availableUpgrades().length} left`);

  ui.showLevelUp();
  const hand = [...cards().querySelectorAll('.sv-card')];
  check('the screen still deals rather than opening empty',
    hand.length === CONFIG.upgradeChoices, `${hand.length} card(s)`);
  check('...from the deepening pool, so every card is one the run can stack',
    hand.length > 0 && hand.every((c) => levelableUpgrades().length > 0));

  player.upgrades.length = 0;
  playtest.endRun('quit');
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
  // DEALT UNHELD, because that is the only way this screen deals anything now:
  // a card the run holds is out of the pool (see availableUpgrades), so `owned`
  // here is always 0 and the two rows that need a stack in hand — the running
  // total and what the ability has done this run — cannot appear on this
  // surface at all. They are asserted against the shared builder and against
  // the hive, which CAN show them, in tools/upgrade-tip-test.mjs.
  playtest.beginRun({});

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

  setSetting('hud.upgradeTips', 'full');
  const [c] = deal('octoGrab');
  pointerEnter(c);
  check('full shows the same quantities', lvRows().length > 0, lvRows().join(' | '));
  // AND NO ARROW ON EITHER, which is the readout being right rather than the
  // setting being broken. Every row of a first pick is an `unlock` — there is
  // no before to arrow from, so the value prints alone at both verbosities
  // (see upgradeTip.js). The span that only Full carries needs a card the run
  // already holds, and this screen no longer deals one; it is asserted at
  // owned > 0 in tools/upgrade-tip-test.mjs.
  check('...with no span on either, because a first pick has no before',
    lvRows().every((t) => !t.includes('\u2192')), lvRows().join(' | '));
  // ...and no history rows on either, because a card this screen offers is one
  // the run has never held. This is the assertion that would catch the rows
  // creeping back in as zeroes — "0 dealt" under a card you have never taken
  // is a number about the card rather than about the run.
  check('...and neither verbosity invents a history for a card never taken',
    tipRow('run') === null && tipRow('total') === null,
    `${tipRow('run') ?? '-'} / ${tipRow('total') ?? '-'}`);

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
section('The hand unlocks under a pointer that never moved');
// `.sv-menu-locked` is `pointer-events: none` on the whole menu while the hand
// slams in, so the cards receive nothing for the two thirds of a second that
// takes. Turning the pointer back on does NOT hand a stationary cursor a
// `pointerenter` — the pointer did not enter anything, the card arrived under
// it — and the hand deals into the middle of the screen, which on a mouse is
// where the pointer already is, because it is the aim. So the tip did not
// appear until the player moved off a card and back, and whether that happened
// was down to where they had last been aiming: the tooltip worked or did not
// work at random, twenty times a run.
//
// NO POINTER EVENT IS DISPATCHED BELOW, and that is the whole assertion. The
// tip has to come up off the unlock alone.
//
// jsdom has no layout and therefore no `document.elementFromPoint`, so the hit
// test is stubbed to answer with the first card — which is what a real one
// would return for a pointer sitting on it. What is under test is whether the
// unlock ASKS, not whether the browser can answer.
{
  const realFromPoint = document.elementFromPoint;
  document.elementFromPoint = () => cards()?.querySelector('.sv-card') ?? null;

  // ONE CARD IN THE HAND, so "the card under the pointer" has one answer. The
  // menu does not deal in the order it is handed, so a two-card hand makes the
  // stub's choice a coin flip and the assertion below untrue half the time for
  // a reason that is not the thing under test.
  hoverPoint.setPointerPosForTest(400, 300);
  const [first] = deal('shrimpRing');
  check('a card was dealt to be under it', !!first, 'no cards dealt');
  check('the tip is up with no hover event at all', !!shown(), shown() ?? 'nothing shown');
  check('...and it is the card the pointer is on',
    tipRow('next') === sentenceCase(effectOf('shrimpRing')), tipRow('next') ?? 'nothing');

  // AND NOT WHEN THERE IS NO POINTER. A touch clears the position (a finger's
  // last spot is not a hover) and so does leaving the window — a hand dealt
  // with the mouse off the side of the screen must come up with nothing on it.
  hoverPoint.setPointerPosForTest(null, null);
  deal('shrimpRing');
  check('no pointer, no tip', shown() === null, shown() ?? '');

  document.elementFromPoint = realFromPoint;
}

// ---------------------------------------------------------------------------
section('A card that has landed can be read while the rest are still arriving');
// The menu is `pointer-events: none` from the first card being thrown to the
// last one landing, and at the tuned stagger that is 2.1 SECONDS. A player who
// moved onto the hand and started reading it got two seconds of hovers that did
// nothing — the tooltip looked like it needed several tries to register, when
// what it needed was for two other cards to finish landing.
//
// The fix hangs on two facts, and jsdom can check both: the slot is marked on
// the frame its card lands, and the stylesheet gives a marked card the pointer
// back. It cannot check the third — whether a real browser then delivers the
// hover — because it has no layout and no hit testing.
{
  const [card] = deal('shrimpRing');
  check('a landed card carries the mark the CSS keys on',
    !!card.parentElement?.classList.contains('sv-lit'),
    card.parentElement?.className ?? 'no slot');

  const css = [...document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
  check('the whole menu refuses the pointer while locked',
    css.includes('.sv-menu-locked, .sv-menu-locked * { pointer-events: none !important; }'),
    'the lock rule is gone');
  check('...and a landed card is given it back',
    /\.sv-menu-locked \.sv-card-slot\.sv-lit > \.sv-card \{ pointer-events: auto/.test(css),
    'a landed card would stay unhoverable for the whole arrival');
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
