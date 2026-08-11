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
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {};' };
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
const fakeParam = () => ({ value: 0, setValueAtTime() { return this; }, setTargetAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; } });
const fakeNode = (extra = {}) => ({ connect(d) { return d; }, disconnect() {}, ...extra });
dom.window.AudioContext = class {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0; this.destination = fakeNode(); }
  createGain() { return fakeNode({ gain: fakeParam() }); }
  createBiquadFilter() { return fakeNode({ type: '', frequency: fakeParam(), Q: fakeParam() }); }
  createConvolver() { return fakeNode({ buffer: null }); }
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

section('Opening the level-up menu');
ui.showLevelUp();
let sounds = drain();
// The menu opens with EXACTLY ONE sound: the rarity sting for the best tier on
// the table. It used to open silent, and the rule that mattered was that
// selectCard(0) must not voice a selection the player did not make — that rule
// still holds, and is what the second check below is really testing.
//
// One sting rather than three: they would smear, and the two quieter ones would
// be inaudible under the loudest anyway.
const stings = sounds.filter((n) => n.startsWith('rarity'));
check('opening announces the best tier on the table, once', stings.length === 1,
  stings.length ? stings.join(', ') : 'nothing played — bestRarity() found no tier on the dealt cards');
check('...and the menu says nothing else', sounds.length === stings.length,
  sounds.length > stings.length ? `also heard ${sounds.filter((n) => !n.startsWith('rarity')).join(', ')} — selectCard(0) is talking to itself` : '');

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

  // The bloom is the one thing that must NOT be uniform: the floor tier is a
  // ring and nothing else, which is what lets a green one read as an event.
  const floorId = rarityFloor();
  for (const c of cards) {
    const slot = c.parentElement;
    const hasGlow = (slot.style.filter || '').includes('drop-shadow');
    if (c.dataset.rarity === floorId) {
      check(`the floor tier (${floorId}) has a ring and no bloom`, !hasGlow, slot.style.filter || 'no filter');
    } else {
      check(`${c.dataset.rarity} blooms`, hasGlow, slot.style.filter || 'no filter');
    }
  }

  // Rank has to be on the element too, or nothing downstream can order tiers
  // without re-deriving the ladder.
  check('rank rides along for anything that needs to order them',
    cards.every((c) => Number.isFinite(Number(c.dataset.rarityRank))),
    cards.map((c) => c.dataset.rarityRank).join(', '));
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
drain();
const fresh = [...document.getElementById('svCards').querySelectorAll('.sv-card')];
key(fresh[0], 'Enter');
sounds = drain();
check('Enter on a card is heard', only(sounds, 'uiClick') === 1, `x${only(sounds, 'uiClick')}`);
check('exactly once, not twice', only(sounds, 'uiClick') === 1);

ui.showLevelUp();
drain();
const spaceCards = [...document.getElementById('svCards').querySelectorAll('.sv-card')];
key(spaceCards[0], ' ');
sounds = drain();
check('Space too', only(sounds, 'uiClick') === 1, `x${only(sounds, 'uiClick')}`);

section('Mouse confirm');
settle();
ui.showLevelUp();
drain();
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

section('Nothing is bound twice');
settle();
// Every clickable control goes through one helper. If a control ever gets both
// the helper and a hand-rolled binding, this is where it shows up.
let doubled = 0;
for (const node of [restart, submit, document.getElementById('svStartBtn')]) {
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
