#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:menusound
//
// The menu's hover and click sounds, driven through the real ui.js under jsdom.
//
// Every check here is about something firing the WRONG number of times, which
// is the only way this can break and the one thing you cannot hear reliably:
// one blip and two blips a millisecond apart sound nearly identical, and a
// missing one just sounds like the menu is a bit dead.
//
// The three real hazards, all of which this pins down:
//
//   SILENT KEYBOARD  a card is a <div>, so Enter and Space are NOT turned into
//                    a click by the browser. Bind the sound to 'click' alone
//                    and the entire keyboard path is mute.
//   DOUBLE CONFIRM   the pad confirms by calling .click(), which DOES dispatch.
//                    Voice that path by hand as well and every pad confirm
//                    plays twice.
//   TALKING TO ITSELF  showLevelUp calls selectCard(0) before the player has
//                    done anything. A hover there is the menu announcing
//                    itself, and it lands under the level-up fanfare.
//
// NOTE the load order below: jsdom FIRST, then the vite loader hooks, then the
// game modules. The other way round breaks the CJS chain jsdom loads through
// and fails with an error about an encoding fallback that has nothing to do
// with anything. See the jsdom-harness recipe.
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
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// Deliberately NOT copying window.performance onto globalThis: jsdom's
// delegates to the global one and swapping it in recurses until the stack
// blows.

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

// Rive's browser bundle has no readable named exports under Node, and the
// `?url` asset import is a Vite-ism. Both are stubbed at resolve time.
const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    // ui/riveRuntime.js imports the runtime's WASM by url, to keep it off unpkg.
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

// --- count the sounds ------------------------------------------------------
// Tapped at the audio layer rather than at feedback(), so what is counted is
// what would actually have reached the speakers.

const audio = await import('../path/src/systems/audio.js');
const { CONFIG } = await import('../path/src/config.js');
// THE ARRIVAL, ON A HARNESS CLOCK. The deal is the slam's now: each card's pop
// and sting fire as that card lands in its cell, so this file cannot hear the
// sequence at all without letting the slam run. Shortened rather than switched
// off — turning it off would test a path the game no longer takes, and the
// order and the count of what is heard are the same at any speed.
Object.assign(CONFIG.upgradeSlam, { first: 0.08, stagger: 0.1, time: 0.02 });
const { initFeedback, updateFeedback } = await import('../path/src/systems/feedback.js');

// Only what REACHED the speakers. The tap reports every outcome including the
// ones that were thrown away, and counting a throttled hover as a hover is the
// exact mistake that would make the throttle look broken when it is working.
const heard = [];
const dropped = [];
audio.watchSfx((name, outcome) => {
  if (outcome === 'sample' || outcome === 'synth') heard.push(name);
  else dropped.push(`${name}:${outcome}`);
});
// playSfx bails before the tap unless audio is live, so the graph is faked to
// the minimum that lets a sound reach its outcome.
// `linearRampToValueAtTime` is here because the card riser fades and swells on
// one — a param missing a method the game calls does not read as a stub gap, it
// throws from inside a setTimeout and takes the whole deal down with it.
const fakeParam = () => ({ value: 0, setValueAtTime() { return this; }, setTargetAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; } });
const fakeNode = (extra = {}) => ({ connect(d) { return d; }, disconnect() {}, ...extra });
dom.window.AudioContext = class {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0; this.destination = fakeNode(); }
  createGain() { return fakeNode({ gain: fakeParam() }); }
  createBiquadFilter() { return fakeNode({ type: '', frequency: fakeParam(), Q: fakeParam() }); }
  createConvolver() { return fakeNode({ buffer: null }); }
  // The bus builds a feedback delay for the celebration echo. Missing here it
  // does not throw anything this test can see — unlockAudio catches, warns to
  // a console nobody is reading, and leaves HALF A BUS wired, which fails as
  // "the bus input never reaches the speakers".
  createDelay(max) { return fakeNode({ maxDelayTime: max, delayTime: fakeParam() }); }
  createWaveShaper() { return fakeNode({ curve: null, oversample: '' }); }
  createDynamicsCompressor() { return fakeNode({ threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(), attack: fakeParam(), release: fakeParam(), reduction: 0 }); }
  createBuffer(c, l) { return { numberOfChannels: c, length: l, getChannelData: () => new Float32Array(l) }; }
  createBufferSource() { return fakeNode({ buffer: null, playbackRate: fakeParam(), loop: false, start() {}, stop() {} }); }
  createOscillator() { return fakeNode({ type: '', frequency: fakeParam(), detune: fakeParam(), start() {}, stop() {} }); }
  async decodeAudioData() { return { duration: 0.2 }; }
  resume() { return Promise.resolve(); }
};
globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

audio.unlockAudio();
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
// The floor tier's id, asked of the ladder rather than hardcoded — rarities.csv
// decides how many rungs there are and what the bottom one is called.
const { baseRarity: rarityFloor } = await import('../path/src/systems/rarity.js');
// The pad, written directly. updateMenuNav reads this object every frame, so
// poking a direction into it is exactly what a stick push looks like from the
// menu's side — and it needs no gamepad in jsdom.
const { menuInput } = await import('../path/src/input.js');

const drain = () => { const out = heard.slice(); heard.length = 0; return out; };
const drainDropped = () => { const out = dropped.slice(); dropped.length = 0; return out; };

// One frame of the game loop. `sfxMinGap` is counted down by updateFeedback,
// so without this the very first hover arms the throttle and every later one
// in the whole file is eaten — which looks exactly like the binding being
// broken.
const settle = () => { updateFeedback(1); drain(); drainDropped(); };
const only = (list, name) => list.filter((n) => n === name).length;

// A pointer event jsdom will actually dispatch as a PointerEvent-alike.
function pointerEnter(node) {
  node.dispatchEvent(new dom.window.Event('pointerenter', { bubbles: false }));
}
function key(node, k) {
  node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

ui.initUI({
  onStart() {}, onRestart() {}, onLevelChoice() {}, onNameSubmit() {},
});
drain(); // initUI itself must not have made any noise

// The deal lights and voices one card at a time on real timers, so anything
// that opens the menu has to let it finish before it can trust what it hears
// next. Everything below the first section does that through `finishDeal`.
//
// The clock is the SLAM's: a card's moment is the frame it lands, so the hand
// is done one stagger after the last one hits rather than one ignite step.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLAM = CONFIG.upgradeSlam;
const FIRST_MS = (SLAM.first + SLAM.time) * 1000;
const DEAL_MS = FIRST_MS + ((CONFIG.upgradeChoices ?? 3) - 1) * SLAM.stagger * 1000 + 140;
const finishDeal = async () => { await sleep(DEAL_MS); drain(); drainDropped(); };

section('Opening the level-up menu');
ui.showLevelUp();
let sounds = drain();
// THE MENU OPENS SILENT. It used to open with the first step of the deal on it,
// and that moved when the arrival took the sequence over: a card's pop and its
// tier's sting are that card LANDING, and on the opening frame nothing has
// landed — the comb is still coming on around three empty cells. Announcing the
// lowest tier before anything has hit would be telling the player the answer
// before the screen has given it.
//
// The rule this has always really been testing is underneath: selectCard(0)
// must not voice a selection the player did not make. A stray uiHover here
// would land under the deal and be inaudible, which is exactly why it needs a
// test rather than an ear.
check('opening plays no pop yet', only(sounds, 'cardPop') === 0, `x${only(sounds, 'cardPop')}`);
check('...and no sting', sounds.filter((n) => n.startsWith('rarity')).length === 0,
  sounds.filter((n) => n.startsWith('rarity')).join(', '));
check('...and the menu says nothing at all', sounds.length === 0,
  sounds.length ? `heard ${sounds.join(', ')} — something is talking to itself` : '');

section('The deal');
{
  // Which cards are lit RIGHT NOW, in dealt order. The whole point of the
  // sequence is that this is never all-of-them-at-once on the opening frame:
  // three cards blooming together says something was dealt and nothing about
  // what.
  const litNow = () => [...document.getElementById('svCards').querySelectorAll('.sv-card-slot')]
    .map((s) => s.classList.contains('sv-lit'));
  check('nothing is lit while the cards are still in the air',
    litNow().every((b) => !b), litNow().map((b) => (b ? 'lit' : '-')).join(' '));

  const ranks = [...document.getElementById('svCards').querySelectorAll('.sv-card')]
    .map((c) => Number(c.dataset.rarityRank));

  // One card has landed. Exactly one is lit — three blooming together says
  // something was dealt and nothing about what.
  await sleep(FIRST_MS + (SLAM.stagger * 1000) / 2);
  const openLit = litNow();
  check('one card is lit when the first one lands', openLit.filter(Boolean).length === 1,
    openLit.map((b) => (b ? 'lit' : '-')).join(' '));

  // ...and it is the WORST one. Lowest tier first is the whole shape of the
  // sequence — read floor-upwards the hand is a build, and the best card on the
  // table is the last thing that lands.
  const firstLit = openLit.indexOf(true);
  check('and it is the lowest tier dealt', ranks[firstLit] === Math.min(...ranks),
    `lit rank ${ranks[firstLit]} of [${ranks.join(', ')}]`);

  await sleep(DEAL_MS);
  const rest = drain();
  drainDropped();
  check('every card ends up lit', litNow().every(Boolean), litNow().join(' '));
  // One pop per card across the whole deal — the opening one plus the rest.
  check('one pop per card', only(rest, 'cardPop') === ranks.length,
    `${only(rest, 'cardPop')} pops for ${ranks.length} cards`);
  // The stings climb, because the cards do. A tier with no `sfx` column entry
  // is skipped rather than pushing the order around, so this compares the
  // ranks of what was heard rather than counting.
  const { rarityById, rarityRank } = await import('../path/src/systems/rarity.js');
  const heardRanks = [...sounds, ...rest].filter((n) => n.startsWith('rarity'))
    .map((n) => CONFIG.rarities.find((r) => rarityById(r.id)?.sfx === n))
    .filter(Boolean).map((r) => rarityRank(r.id));
  const climbing = heardRanks.every((r, i) => i === 0 || r >= heardRanks[i - 1]);
  if (!climbing) console.log('    DEBUG heard:', JSON.stringify([...sounds, ...rest]));
  check('the stings climb, lowest tier first', climbing, heardRanks.join(' -> '));
}

// The cards, not their slots. Each card is wrapped in a .sv-card-slot so its
// rarity bloom has an unclipped element to hang off (see ui.js) — the click
// and hover listeners are still on the card itself, and dispatching at the
// slot would reach none of them.
const cards = [...document.getElementById('svCards').querySelectorAll('.sv-card')];
check('cards were built', cards.length >= 2, `${cards.length} cards`);

section('Rarity on the card');
// The ring and the bloom are the whole visible half of rarity, and both are
// applied as inline style from rarities.csv — so "the tier was rolled" and "the
// tier is on screen" are two different claims and only the second one matters.
// A clip-path eats an outer border AND a drop-shadow on the same element, so
// the ring is an inset stroke on the card and the bloom is a filter on its
// unclipped wrapper; this checks each landed where it has to.
{
  const slots = [...document.getElementById('svCards').querySelectorAll('.sv-card-slot')];
  check('every card has a slot to bloom from', slots.length === cards.length,
    `${slots.length} slots, ${cards.length} cards`);

  const tagged = cards.filter((c) => c.dataset.rarity);
  check('every card was dealt a tier', tagged.length === cards.length,
    cards.map((c) => c.dataset.rarity || '?').join(', '));

  const ringed = cards.filter((c) => {
    const col = c.style.getPropertyValue('--sv-ring');
    const w = c.style.getPropertyValue('--sv-ring-w');
    return /^#[0-9a-f]{6}$/i.test(col) && parseFloat(w) > 0;
  });
  check('every card carries a coloured ring', ringed.length === cards.length,
    cards.map((c) => c.style.getPropertyValue('--sv-ring') || 'none').join(' '));

  // The TIER's bloom is the one thing that must NOT be uniform: the floor tier
  // is a ring and nothing else, which is what lets a green one read as an
  // event. Sizes rather than a finished filter — the slot's filter is composed
  // in the stylesheet from four passes (this tier's two, plus the white
  // selection pair), so what a card contributes is how big its own blurs are.
  const floorId = rarityFloor();
  for (const c of cards) {
    const slot = c.parentElement;
    const tight = parseFloat(slot.style.getPropertyValue('--sv-glow-tight'));
    const halo = parseFloat(slot.style.getPropertyValue('--sv-glow-halo'));
    const sizes = `${tight}px / ${halo}px`;
    if (c.dataset.rarity === floorId) {
      check(`the floor tier (${floorId}) has a ring and no bloom of its own`,
        tight === 0 && halo === 0, sizes);
    } else {
      check(`${c.dataset.rarity} blooms`, tight > 0 && halo > 0, sizes);
    }
  }

  // ...and the SELECTION bloom is the one thing that must be. It is white and
  // the same size on every card, so "which one am I on" never depends on which
  // tier was dealt — the floor tier used to have nothing but a 4% scale to say
  // it, because the only bloom on the menu was scaled by a `glow` that is 0 for
  // exactly that tier.
  const host = document.getElementById('svCards');
  const selTight = parseFloat(host.style.getPropertyValue('--sv-sel-tight'));
  const selHalo = parseFloat(host.style.getPropertyValue('--sv-sel-halo'));
  check('the white selection bloom is set for the whole hand', selTight > 0 && selHalo > 0,
    `${selTight}px / ${selHalo}px`);
  check('...on the container, so no card can be dealt without one',
    cards.every((c) => c.parentElement.parentElement === host));

  // Rank has to be on the element too, or nothing downstream can order tiers
  // without re-deriving the ladder.
  check('rank rides along for anything that needs to order them',
    cards.every((c) => Number.isFinite(Number(c.dataset.rarityRank))),
    cards.map((c) => c.dataset.rarityRank).join(', '));
}

section('Nothing is selected until you ask for it');
// The menu used to open with the first card highlighted AND focused, so the
// pad always had something to confirm. On a mouse that highlight never moves —
// it points at a card the player never pointed at and sits there for the whole
// menu. So the selection is now something an input CREATES.
{
  check('no card is highlighted on open',
    cards.every((c) => !c.classList.contains('sv-card-sel')),
    cards.map((c) => c.className).join(' | '));
  check('...and none of them has been handed focus either',
    !cards.includes(document.activeElement),
    document.activeElement?.className || 'body');

  // The first thing the pad says LANDS the selection rather than moving it.
  // stepSelection measures from the selected card, so without this the first
  // press reads centres[-1] and throws.
  settle();
  menuInput.x = 1;
  ui.updateMenuNav();
  menuInput.x = 0;
  check('the first pad press puts the selection on the first card',
    cards[0].classList.contains('sv-card-sel'),
    cards.findIndex((c) => c.classList.contains('sv-card-sel')) + ' is selected');
  check('...and it is heard, because the player asked for it',
    only(drain(), 'uiHover') === 1);

  // ...and from there it steps normally. stepSelection picks the nearest card
  // in the direction pushed, which needs boxes to measure — jsdom lays nothing
  // out and hands back all-zero rects, so every card would sit on top of every
  // other and the step would fall through to the row wrap. One row, 210px
  // apart, which is what the CSS actually produces.
  cards.forEach((c, i) => {
    c.getBoundingClientRect = () => ({ left: i * 214, top: 0, width: 210, height: 210,
      right: i * 214 + 210, bottom: 210, x: i * 214, y: 0 });
  });
  settle();
  menuInput.x = 1;
  ui.updateMenuNav();
  menuInput.x = 0;
  check('the next press steps off it', cards[1].classList.contains('sv-card-sel'),
    cards.findIndex((c) => c.classList.contains('sv-card-sel')) + ' is selected');
}

section('Hovering');
settle();
pointerEnter(cards[0]);
sounds = drain();
check('the mouse entering a card is heard once', only(sounds, 'uiHover') === 1, `x${only(sounds, 'uiHover')}`);
check('and it is a hover, not a click', only(sounds, 'uiClick') === 0);

// The throttle exists for a cursor sitting on a boundary, which can chatter
// between two cards for as long as the hand is still.
pointerEnter(cards[1]);
pointerEnter(cards[0]);
pointerEnter(cards[1]);
const eaten = drainDropped().filter((d) => d.startsWith('uiHover:gap')).length;
const heardFromChatter = only(drain(), 'uiHover');
check('a cursor chattering across a boundary is throttled', heardFromChatter <= 1,
  `${heardFromChatter} played, ${eaten} eaten, from 3 crossings inside one frame`);

section('Keyboard confirm');
settle();
// A card is a div. Enter is NOT turned into a click by the browser, so a
// binding on 'click' alone leaves the whole keyboard path mute.
ui.showLevelUp();
// Let the deal finish and go quiet, so what follows is the only thing heard.
await finishDeal();
const fresh = [...document.getElementById('svCards').querySelectorAll('.sv-card')];
key(fresh[0], 'Enter');
sounds = drain();
check('Enter on a card is heard', only(sounds, 'uiClick') === 1, `x${only(sounds, 'uiClick')}`);
check('exactly once, not twice', only(sounds, 'uiClick') === 1);

ui.showLevelUp();
// Let the deal finish and go quiet, so what follows is the only thing heard.
await finishDeal();
const spaceCards = [...document.getElementById('svCards').querySelectorAll('.sv-card')];
key(spaceCards[0], ' ');
sounds = drain();
check('Space too', only(sounds, 'uiClick') === 1, `x${only(sounds, 'uiClick')}`);

section('Mouse confirm');
settle();
ui.showLevelUp();
// Let the deal finish and go quiet, so what follows is the only thing heard.
await finishDeal();
const clickCards = [...document.getElementById('svCards').querySelectorAll('.sv-card')];
clickCards[0].click();
sounds = drain();
check('clicking a card is heard once', only(sounds, 'uiClick') === 1, `x${only(sounds, 'uiClick')}`);

section('The buttons');
settle();
const restart = document.getElementById('svRestartBtn');
pointerEnter(restart);
check('hovering Try again is heard', only(drain(), 'uiHover') === 1);
restart.click();
check('and clicking it', only(drain(), 'uiClick') === 1);

settle();
const submit = document.getElementById('svNameSubmit');
pointerEnter(submit);
check('the name submit hovers', only(drain(), 'uiHover') === 1);

section('The score card on a pad');
// A controller player could reach the end of a run and have no way to start
// another one: the pad drove the level-up cards and nothing else. Same rules as
// the cards — nothing is highlighted until the player asks, and confirm goes
// through the button's own click so the pad can't take a path the mouse can't.
{
  const padPress = (field) => {
    menuInput[field] = field === 'x' || field === 'y' ? 1 : true;
    ui.updateMenuNav();
    menuInput[field] = field === 'x' || field === 'y' ? 0 : false;
  };
  const lit = () => [...document.querySelectorAll('#svGameOverMenu .sv-nav-sel')];

  ui.showGameOver({ score: 4210, kills: 37, level: 6, time: 128 });
  settle();
  check('the card opens with nothing highlighted', lit().length === 0,
    lit().map((c) => c.id).join(', '));

  // Whatever is actually reachable, in DOM order — the roll only exists if a
  // boss went down this run, so the first stop is not a fixed button. One face
  // now: the card is a ledger and there is no half of it turned away, so this
  // is every stop on it. The board's two heading buttons are in the list and
  // are rebuilt on every render, which is why they are named rather than held.
  const reachable = ['svTrophyShare', 'svTrophySave', 'svSheetShare', 'svSheetSave',
    'svBoardGlobal', 'svBoardDevice',
    'svNameSubmit', 'svRestartBtn', 'svNextRoll']
    .map((id) => document.getElementById(id))
    .filter((c) => c && !c.disabled && !c.closest('.sv-hidden'));
  check('the card has controls to reach', reachable.length >= 2,
    reachable.map((c) => c.id).join(', '));

  padPress('y');
  check('the first pad press lands on the first control',
    lit().length === 1 && lit()[0] === reachable[0],
    lit()[0]?.id || 'nothing');
  check('...and is heard', only(drain(), 'uiHover') === 1);

  settle();
  padPress('y');
  check('the next press steps down the card',
    lit().length === 1 && lit()[0] === reachable[1], lit()[0]?.id || 'nothing');

  // Either axis. The card is a column of one- and two-button rows, not a grid,
  // so a player pushing whichever direction they thought of gets the same move.
  settle();
  padPress('x');
  check('right steps too, on a card that has no grid to speak of',
    lit()[0] === reachable[2] || lit()[0] === reachable[reachable.length - 1],
    lit()[0]?.id || 'nothing');

  // Confirm reaches the real handler — checked by the sound the button's own
  // click binding makes, not by a spy on something this test wired up.
  settle();
  const target = lit()[0];
  padPress('confirm');
  check(`confirm clicks ${target.id}`, only(drain(), 'uiClick') === 1);

  // And the whole thing is inert once the card is gone: updateMenuNav runs on
  // every frame of the game, not just while a menu is up.
  ui.hideAllMenus();
  settle();
  padPress('y');
  padPress('confirm');
  check('a hidden card ignores the pad', lit().length === 0 && drain().length === 0);
}

section('Nothing is bound twice');
settle();
// Every clickable control goes through one helper. If a control ever gets both
// the helper and a hand-rolled binding, this is where it shows up.
let doubled = 0;
for (const node of [restart, submit]) {
  settle();
  node.click();
  if (only(drain(), 'uiClick') > 1) doubled++;
}
check('no control plays its click more than once', doubled === 0, `${doubled} doubled`);

section('Typing the name');
// The tick hangs off `input`, not `keydown`, and the difference is the whole
// test: keydown also fires for modifiers and arrows, and — the one that would
// sound broken — for every rejected keypress once the field is full.
const nameInput = document.getElementById('svNameInput');

// A voice slot is released on a real setTimeout of (decay + 0.1)s, so a
// synchronous burst of keystrokes exhausts CONFIG.audio.maxConcurrent and
// every tick after the first is dropped as 'voices' — in the HARNESS, where
// no time passes. Real typing is nowhere near it (a keystroke holds a slot for
// 140ms, so even a fast typist keeps about two alive out of twelve). Hence the
// real wait: this is a test that has to let the clock run to mean anything.
const RELEASE_MS = (CONFIG.sfx.uiType.decay + 0.1) * 1000 + 20;
const typeChar = async (ch) => {
  key(nameInput, ch);
  nameInput.value += ch;
  nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  updateFeedback(0.2);
  await new Promise((r) => setTimeout(r, RELEASE_MS));
};

settle();
nameInput.value = '';
await typeChar('A');
let typed = drain();
check('a character is heard', only(typed, 'uiType') === 1, `x${only(typed, 'uiType')}`);

settle();
nameInput.value = '';
for (const ch of 'SEAL') await typeChar(ch);
typed = drain();
const typeEaten = drainDropped().filter((d) => d.startsWith('uiType')).length;
// A shortfall here means the tick is being swallowed rather than never asked
// for, so the dropped count is reported alongside — the two failures look
// identical from the heard count alone.
check('four characters give four ticks', only(typed, 'uiType') === 4,
  `x${only(typed, 'uiType')}${typeEaten ? `, ${typeEaten} dropped` : ''}`);

settle();
for (const k of ['Shift', 'ArrowLeft', 'ArrowRight', 'Control', 'Tab']) key(nameInput, k);
check('modifiers and arrows are silent', only(drain(), 'uiType') === 0);

settle();
key(nameInput, 'x'); // keydown with no `input` — what a full field looks like
check('a rejected keypress is silent', only(drain(), 'uiType') === 0);

settle();
nameInput.value = 'SEA'; // one character shorter — a backspace
nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
check('backspace ticks too', only(drain(), 'uiType') === 1);

section('The sounds exist');
check('uiHover has takes', (CONFIG.sfx.uiHover?.srcs ?? []).length >= 2,
  `${(CONFIG.sfx.uiHover?.srcs ?? []).length} takes`);
check('uiClick has takes', (CONFIG.sfx.uiClick?.srcs ?? []).length >= 1);
check('the hover sits below the click', CONFIG.sfx.uiHover.gain < CONFIG.sfx.uiClick.gain,
  `${CONFIG.sfx.uiHover.gain} vs ${CONFIG.sfx.uiClick.gain}`);
check('uiType exists', Boolean(CONFIG.sfx.uiType));
// Typing is the most frequent sound in the UI by a wide margin, so it has to
// sit under the two that are meant to be noticed.
check('typing sits below the hover', CONFIG.sfx.uiType.gain < CONFIG.sfx.uiHover.gain,
  `${CONFIG.sfx.uiType.gain} vs ${CONFIG.sfx.uiHover.gain}`);
check('typing varies its pitch', CONFIG.sfx.uiType.pitchVary > 0.1,
  `${CONFIG.sfx.uiType.pitchVary} — a repeated identical take is a machine gun`);
check('typing is short', CONFIG.sfx.uiType.decay <= 0.06, `${CONFIG.sfx.uiType.decay}s`);
check('typing does not buzz the phone', !CONFIG.feedback.uiType.haptic);
check('neither throws particles into the world', !CONFIG.feedback.uiHover.emit && !CONFIG.feedback.uiClick.emit);
check('nor does typing', !CONFIG.feedback.uiType.emit);
check('nor shakes the camera for a menu', !CONFIG.feedback.uiHover.shake && !CONFIG.feedback.uiClick.shake);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
