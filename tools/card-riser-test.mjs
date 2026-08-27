#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:cardriser
//
// THE BUILDUP UNDER A FALLING CARD — systems/cardRiser.js, and its row in the
// F panel.
//
// It used to be `cardRiser` in CONFIG.sfx: a `boom` with a decay of 1.1s under
// a fall of 0.26s, with a comment saying the length was deliberately wrong
// because being cut early beats running out. As a continuous voice it can be
// told how long the fall takes, so the sweep is scheduled across exactly it.
//
// WHAT THIS COVERS, and every one of these fails silently — a riser that is
// mistimed, choked wrongly or not started at all sounds like a screen that is
// "a bit dead", which is the one bug report nobody can act on:
//
//   THE SWEEP IS THE FALL. The only claim the whole rewrite makes. Asserted as
//   the LAST SCHEDULED POINT on the real BiquadFilter param — not as the number
//   handed in, which would only prove the argument travelled — and then
//   asserted again after retuning `upgradeSlam.time`, because a riser that
//   agrees with the fall once and then hardcodes it is the exact regression
//   this replaced.
//
//   NO TONE ANYWHERE. Two detuned saws used to carry the weight and they are
//   gone: pitched material makes a riser read as a note that gets brighter,
//   because the ear locks onto the fundamental and hears the filter as timbre.
//   An oscillator creeping back in would sound "fuller" and be wrong, so this
//   asserts the bank builds NONE.
//
//   THE MIXER IS A MIXER. Level, swell, attack and the choke are shared, so a
//   fader changes the balance and never the shape. A per-band envelope would
//   make every fader a slightly different sound.
//
//   THE WOBBLE LANDS CLEAN. It is windowed to nothing at both ends on purpose:
//   a modulation still running at the impact leaves the bank somewhere other
//   than where it was aimed, which silently breaks the one claim above.
//
//   ui.js PASSES THE FALL, not a constant. The riser is started from a
//   setTimeout inside slamCards; a `time` that got dropped from that call reads
//   as a working riser at the default and a broken one at every other setting.
//
//   THE CHOKE IS PER CARD. With `stagger` under `time` two cards are in the air
//   together, and a landing that silenced every riser would cut the buildup out
//   from under the card behind it. That is inaudible at the shipped stagger of
//   0.58 and wrong the moment it is tightened.
//
//   THE RETIRED VOICE STAYS DEAD. `sfx` is a DATA_SUBTREE, so the general key
//   prune deliberately cannot drop a voice deleted from config.js — it comes
//   back out of every snapshot forever and shows up in the workbench's picker
//   as something assignable that will never play. RETIRED_SFX is the answer and
//   this drives it through the real merge.
//
//   IT HAS A ROW. The point of the change: it was the one sound on the level-up
//   screen with no surface anywhere. The row is synthetic (it is not a feedback
//   event), pinned into one section by name and matched on a bag of words, so
//   both the section title and the filter are load-bearing.
//
// Load order is the jsdom recipe: jsdom, then the loader, then game modules.
// Run WITHOUT --import for that reason.
//
//   node tools/card-riser-test.mjs
// ---------------------------------------------------------------------------

import { JSDOM, VirtualConsole } from 'jsdom';

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.error('JSDOM ERROR:', e.detail?.stack ?? e.stack ?? e.message));
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom's canvas is a stub; the reveal code only needs these to exist.
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
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) {
      return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export class RiveFile { constructor(){} on(){} cleanup(){} } export const decodeImage = async () => ({ unref(){} }); export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');
globalThis.fetch = async () => ({ ok: false, status: 404 });

// --- the fake graph --------------------------------------------------------
// Every scheduling call is RECORDED, because what this file is actually about
// is when things were scheduled for. A param that accepted the calls and threw
// them away would let a riser aimed at the wrong moment pass every check.
const params = [];
const fakeParam = (name) => {
  const p = {
    name, value: 0, calls: [],
    setValueAtTime(v, t) { this.calls.push(['set', v, t]); this.value = v; return this; },
    setTargetAtTime(v, t) { this.calls.push(['target', v, t]); return this; },
    linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); return this; },
    exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; },
    cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; },
  };
  params.push(p);
  return p;
};
const fakeNode = (extra = {}) => ({ connect(d) { return d; }, disconnect() {}, ...extra });
const filters = [];
const oscs = [];
const sources = [];
dom.window.AudioContext = class {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0; this.destination = fakeNode(); }
  createGain() { return fakeNode({ gain: fakeParam('gain') }); }
  createBiquadFilter() {
    const f = fakeNode({ type: '', frequency: fakeParam('cutoff'), Q: fakeParam('Q') });
    filters.push(f);
    return f;
  }
  createConvolver() { return fakeNode({ buffer: null }); }
  createDelay(max) { return fakeNode({ maxDelayTime: max, delayTime: fakeParam('delay') }); }
  createWaveShaper() { return fakeNode({ curve: null, oversample: '' }); }
  createDynamicsCompressor() { return fakeNode({ threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(), attack: fakeParam(), release: fakeParam(), reduction: 0 }); }
  createBuffer(c, l) { return { numberOfChannels: c, length: l, getChannelData: () => new Float32Array(l) }; }
  createBufferSource() {
    const b = fakeNode({ buffer: null, playbackRate: fakeParam(), loop: false, started: false, stopped: null, start() { this.started = true; }, stop(t) { if (this.stopped === null || t < this.stopped) this.stopped = t; } });
    sources.push(b);
    return b;
  }
  createOscillator() {
    const o = fakeNode({ type: '', frequency: fakeParam('hz'), detune: fakeParam('detune'), started: false, stopped: null, start() { this.started = true; }, stop(t) { this.stopped = t; } });
    oscs.push(o);
    return o;
  }
  async decodeAudioData() { return { duration: 0.2 }; }
  resume() { return Promise.resolve(); }
};
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const audio = await import('../path/src/systems/audio.js');
const { CONFIG, importTuning } = await import('../path/src/config.js');
const riser = await import('../path/src/systems/cardRiser.js');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const section = (t) => console.log(`\n${t}`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

audio.unlockAudio();

// Nodes are found BY SHAPE, never by index. The bus builds filters and gains of
// its own, a riser builds one of each per band, and every previous voice in
// this file has left its nodes in these arrays — so "the newest gain" has meant
// three different things across three revisions of this module, and each time
// it failed as a plausible number from the wrong node rather than as an error.
const lastSweep = () => [...filters].reverse().find((f) => f.type === 'bandpass')?.frequency;
// THE SHARED ENVELOPE is the only gain carrying TWO ramps — the attack and the
// swell. A band's fader is either a plain `.value` or, if it is held back, two
// held points and a single ramp in, which is why one ramp is not enough to
// identify it by.
const isEnvelope = (p) => p.name === 'gain' && p.calls.filter((c) => c[0] === 'lin').length >= 2;
const lastEnvelope = () => [...params].reverse().find(isEnvelope);

// ---------------------------------------------------------------------------
section('THE RETIRED VOICE');
// The on-disk snapshot still carries the old one-shot, so a plain boot already
// exercises the drop — but only for as long as that key happens to be in the
// file. Driven through the real merge instead, so the check keeps meaning the
// same thing after the next save.
check('gone after boot', !('cardRiser' in CONFIG.sfx),
  'cardRiser' in CONFIG.sfx ? 'still in CONFIG.sfx' : 'not in CONFIG.sfx');
importTuning({ sfx: { cardRiser: { src: null, type: 'boom', decay: 1.1, gain: 0.22 } } });
check('...and a snapshot cannot bring it back', !('cardRiser' in CONFIG.sfx));
check('...loudly', warnings.some((w) => w.includes('retired voice') && w.includes('cardRiser')));
// The prune must not be a blanket one. `sfx` holds the sound design and the
// workbench's duplicate button invents names config.js has never heard of.
importTuning({ sfx: { somebodysOwnVoice: { src: null, type: 'noise', decay: 0.1, gain: 0.2 } } });
check('a voice NOT retired survives it', 'somebodysOwnVoice' in CONFIG.sfx);
delete CONFIG.sfx.somebodysOwnVoice;

// ---------------------------------------------------------------------------
section('THE SWEEP IS THE FALL');
const R = CONFIG.upgradeSlam.riser;
// VARIATION OFF for everything that asserts an exact endpoint. It is rolled per
// trigger, so with it on "lands on its own ceiling" is a claim about a random
// number — and a check that has to allow for a random number is a check that
// would pass if the sweep were wrong. Its own section turns it back on and
// asserts the opposite property: that two throws DIFFER.
const VARY = { ...R.vary };
R.vary = { pitch: 0, spread: 0, level: 0, wobble: 0 };
// The sweep is scheduled as a curve of points now (see scheduleSweep — an
// accelerating wobble needs its phase integrated, which a ramped LFO cannot
// do), so "where it lands" is the LAST scheduled point rather than a single
// exponential ramp. Read that way deliberately: the shape in between is tuning,
// and the endpoint is the contract.
const endOf = (param) => param?.calls.filter((c) => c[0] === 'lin').at(-1);
const startOf = (param) => param?.calls.find((c) => c[0] === 'set');
const bandsOf = (n) => filters.slice(-n);

const a = {};
check('a riser starts', riser.startCardRiser(a, 0.26) === true);
check('...one voice', riser.cardRiserCount() === 1, `${riser.cardRiserCount()}`);
check('...one band per fader up', riser.cardRiserSpan(a)?.bands === R.bands.filter((b) => b.level > 0).length,
  `${riser.cardRiserSpan(a)?.bands} bands`);
{
  const built = bandsOf(riser.cardRiserSpan(a).bands);
  check('every band is a resonant bandpass', built.every((f) => f.type === 'bandpass'),
    built.map((f) => f.type).join(','));
  // THE CLAIM. Every band lands at now+dur — that is the entire difference
  // between this and the fixed decay it replaced.
  check('every band lands exactly on the fall',
    built.every((f) => near(endOf(f.frequency)?.[2] ?? -1, 0.26, 1e-9)),
    built.map((f) => endOf(f.frequency)?.[2]).join(', '));
  // ...and lands where it was AIMED. This is what the wobble's window buys: an
  // unwindowed modulation still running at the last point leaves each band at
  // some arbitrary offset, and nothing else here would notice.
  // ENDPOINTS AS THE LIVE `reverse` LEAVES THEM. The flag is a switch in the
  // sound workbench and it is ON today, which swaps every band's `from` and
  // `to` (see cardRiser.js). Reading the columns literally asserted that
  // nobody had ever thrown that switch, and reported a bank landing exactly
  // where it was aimed as three failures.
  const flipped = R.reverse === true;
  const aimed = (i) => (flipped ? R.bands[i].from : R.bands[i].to);
  const begun = (i) => (flipped ? R.bands[i].to : R.bands[i].from);
  built.forEach((f, i) => {
    const want = aimed(i);
    check(`band ${i + 1} lands on its own ceiling, wobble and all`,
      near(endOf(f.frequency)?.[1] ?? -1, want, want * 0.001),
      `${endOf(f.frequency)?.[1]} vs ${want}${flipped ? ' (reversed)' : ''}`);
  });
  built.forEach((f, i) => {
    check(`band ${i + 1} starts where it was told`, near(startOf(f.frequency)?.[1] ?? -1, begun(i)),
      `${startOf(f.frequency)?.[1]} vs ${begun(i)}${flipped ? ' (reversed)' : ''}`);
  });
  check('each band has its own width', new Set(built.map((f) => f.Q.value)).size === built.length,
    built.map((f) => f.Q.value).join(', '));
}
riser.stopCardRiser(a);
check('the landing cuts it', riser.cardRiserCount() === 0);

// NO TONE. The saws are gone rather than turned down — an oscillator creeping
// back in would sound "fuller" and would put a fundamental under a sound whose
// whole job is to have nothing for the ear to hold onto.
{
  const before = oscs.length;
  const k = {};
  riser.startCardRiser(k, 0.26);
  check('the bank builds no oscillator at all', oscs.length === before, `${oscs.length - before} built`);
  check('...only looping noise', bandsOf(riser.cardRiserSpan(k).bands).length === riser.cardRiserSpan(k).bands);
  riser.stopAllCardRisers();
}

// A DIFFERENT FALL, because agreeing once proves nothing about a constant.
const b = {};
riser.startCardRiser(b, 0.72);
check('a longer fall gets a longer sweep',
  bandsOf(riser.cardRiserSpan(b).bands).every((f) => near(endOf(f.frequency)?.[2] ?? -1, 0.72, 1e-9)));
check('...and reports it', near(riser.cardRiserSpan(b)?.dur ?? -1, 0.72));
riser.stopAllCardRisers();

// ---------------------------------------------------------------------------
section('THE BANK AND ITS FADERS');
// A fader at 0 is a band that is not built, not one that is built and silent —
// so the mixer can turn the bank into a single band and the code has to cope.
{
  const keep = R.bands.map((x) => ({ ...x }));
  R.bands[1].level = 0;
  const k = {};
  riser.startCardRiser(k, 0.3);
  check('a fader at 0 builds no band', riser.cardRiserSpan(k)?.bands === keep.length - 1,
    `${riser.cardRiserSpan(k)?.bands} of ${keep.length}`);
  riser.stopAllCardRisers();
  // ...and every fader down is a deliberate silence, not a broken riser.
  R.bands.forEach((x) => { x.level = 0; });
  check('every fader down is silence', riser.startCardRiser({}, 0.3) === false && riser.cardRiserCount() === 0);
  R.bands.length = 0;
  R.bands.push(...keep);
}
// THE MIXER IS A MIXER: the envelope is shared, so a fader changes the balance
// and never the shape. A per-band envelope would make every fader a slightly
// different sound and the mix impossible to judge.
{
  // Scoped to the gains THIS start built. Every earlier voice in this file has
  // left an envelope behind in `params`, so an unscoped count says four.
  const before = params.length;
  const k = {};
  riser.startCardRiser(k, 0.3);
  const mine = params.slice(before);
  check('one shared envelope, not one per band', mine.filter(isEnvelope).length === 1,
    `${mine.filter(isEnvelope).length} shaped gains across ${riser.cardRiserSpan(k).bands} bands`);
  riser.stopAllCardRisers();
}
// A band held back enters late rather than being faded in from the throw.
{
  const k = {};
  const held = R.bands.findIndex((x) => (x.at ?? 0) > 0);
  riser.startCardRiser(k, 0.4);
  if (held >= 0) {
    const gains = params.filter((p) => p.name === 'gain').slice(-riser.cardRiserSpan(k).bands);
    const late = gains.find((p) => p.calls.filter((c) => c[0] === 'set').length === 2);
    check('a held band waits, at zero', !!late, late ? `band ${held + 1}` : 'no band scheduled an entry');
    check('...for its share of the fall',
      !!late && near(late.calls.filter((c) => c[0] === 'set')[1][2], R.bands[held].at * 0.4, 1e-9),
      `${late?.calls.filter((c) => c[0] === 'set')[1][2]}s of 0.4s`);
  }
  riser.stopAllCardRisers();
}

// ---------------------------------------------------------------------------
section('MODULATION');
// The wobble is windowed to nothing at both ends. Without that the bank lands
// wherever the modulation happened to be, which breaks "lands on the fall"
// invisibly — the timing is still right and the pitch is not.
{
  const keep = { d: R.wobbleDepth, f: R.wobbleFrom, t: R.wobbleTo };
  Object.assign(R, { wobbleDepth: 5, wobbleFrom: 30, wobbleTo: 60 });
  const k = {};
  riser.startCardRiser(k, 0.3);
  const built = bandsOf(riser.cardRiserSpan(k).bands);
  // Aimed through the live `reverse` like the endpoint checks above — with the
  // switch on, a band's target is its `from`.
  const wobbleAim = (i) => (R.reverse === true ? R.bands[i].from : R.bands[i].to);
  check('a violent wobble still lands on target',
    built.every((f, i) => near(endOf(f.frequency)?.[1] ?? -1, wobbleAim(i), wobbleAim(i) * 0.001)),
    built.map((f) => Math.round(endOf(f.frequency)?.[1])).join(', '));
  // ...and it genuinely moved on the way. A window that killed the modulation
  // outright would pass the check above and do nothing at all.
  const mid = built[0].frequency.calls.filter((c) => c[0] === 'lin');
  const clean = (t) => R.bands[0].from * (R.bands[0].to / R.bands[0].from) ** (t ** (R.curve ?? 1));
  const strayed = mid.some((c, i) => Math.abs(c[1] / clean((i + 1) / mid.length) - 1) > 0.02);
  check('...having actually wobbled on the way', strayed);
  Object.assign(R, { wobbleDepth: keep.d, wobbleFrom: keep.f, wobbleTo: keep.t });
  riser.stopAllCardRisers();
}
// Resolution is resolution, not shape: more points must not move the endpoints.
{
  const keep = R.steps;
  const ends = [];
  for (const n of [12, 96]) {
    R.steps = n;
    const k = {};
    riser.startCardRiser(k, 0.3);
    const f = bandsOf(riser.cardRiserSpan(k).bands)[0];
    ends.push([f.frequency.calls.filter((c) => c[0] === 'lin').length, endOf(f.frequency)[1]]);
    riser.stopAllCardRisers();
  }
  check('more points is more points', ends[1][0] > ends[0][0], `${ends[0][0]} then ${ends[1][0]}`);
  check('...and the same destination', near(ends[0][1], ends[1][1], ends[0][1] * 0.001),
    `${Math.round(ends[0][1])} vs ${Math.round(ends[1][1])}`);
  R.steps = keep;
}

// ---------------------------------------------------------------------------
section('REVERSING IT');
// Climbing is arrival; falling is the floor going out from under the card. Same
// bank, opposite feeling — so the toggle has to flip the ENDPOINTS and change
// nothing else, or it is a second sound rather than the same one backwards.
{
  const k = {};
  riser.startCardRiser(k, 0.3);
  const up = bandsOf(riser.cardRiserSpan(k).bands).map((f) => [startOf(f.frequency)[1], endOf(f.frequency)[1]]);
  riser.stopAllCardRisers();

  // FLIPPED FROM WHATEVER IT IS, and put back to that — not to `false`. This
  // set the flag to true and restored it to false, which is a silent edit to
  // the shipped sound on a tree where the switch is on: every check after this
  // block was reading an un-reversed bank, and this one was comparing a
  // reversed run against another reversed run.
  const wasReversed = R.reverse === true;
  R.reverse = !wasReversed;
  const k2 = {};
  riser.startCardRiser(k2, 0.3);
  const down = bandsOf(riser.cardRiserSpan(k2).bands).map((f) => [startOf(f.frequency)[1], endOf(f.frequency)[1]]);
  riser.stopAllCardRisers();
  R.reverse = wasReversed;

  check('every band starts where it used to end',
    down.every(([from], i) => near(from, up[i][1], up[i][1] * 0.001)),
    down.map(([f]) => Math.round(f)).join(', '));
  check('...and ends where it used to start',
    down.every(([, to], i) => near(to, up[i][0], up[i][0] * 0.001)),
    down.map(([, t]) => Math.round(t)).join(', '));
  // Every band's DIRECTION inverted — stated as a relation rather than as "they
  // all fall", because the bands are tuning and one of them may already be
  // descending. A check written against the authored direction passes on the
  // shipped numbers and fails the moment a band is retuned past its partner.
  check('...so every band runs the other way now',
    down.every(([f, t], i) => Math.sign(t - f) === -Math.sign(up[i][1] - up[i][0])),
    down.map(([f, t], i) => `${up[i][0] < up[i][1] ? 'up' : 'down'}→${f < t ? 'up' : 'down'}`).join(' '));
  check('...and the bank is still the same size', down.length === up.length);
}
// A SINGLE band can fall while the others climb. There used to be a clamp
// forcing `to` above `from`, which made this impossible while the panel's own
// tooltip claimed you could have it — a lie that nothing could catch.
{
  // WRITTEN AGAINST THE BANK'S OWN DIRECTION, since `reverse` turns every
  // sentence here around: the switch is on today, so the shipped bands descend
  // and this band — authored 4000 down to 200, then swapped with the rest —
  // is the one that climbs. The claim is that ONE band can disagree with the
  // others, which is what the removed clamp made impossible, so it is stated
  // as a relation rather than as "down".
  const flip = R.reverse === true;
  const keep = { ...R.bands[0] };
  R.bands[0].from = 4000;
  R.bands[0].to = 200;
  const k = {};
  riser.startCardRiser(k, 0.3);
  const f = bandsOf(riser.cardRiserSpan(k).bands)[0];
  const dir = (x) => Math.sign(endOf(x.frequency)[1] - startOf(x.frequency)[1]);
  check('one band may run against the rest', dir(f) === (flip ? 1 : -1),
    `${Math.round(startOf(f.frequency)[1])} → ${Math.round(endOf(f.frequency)[1])}`);
  check('...and the others still go the bank\'s own way',
    bandsOf(riser.cardRiserSpan(k).bands).slice(1).every((x) => dir(x) === (flip ? -1 : 1)),
    bandsOf(riser.cardRiserSpan(k).bands).slice(1)
      .map((x) => (dir(x) > 0 ? 'up' : 'down')).join(' '));
  riser.stopAllCardRisers();
  Object.assign(R.bands[0], keep);
}

// ---------------------------------------------------------------------------
section('IT DOES NOT SOUND COPIED');
// Sixty of these a run. The property is not "it is random" — it is that two
// throws differ in REGISTER and WEIGHT while agreeing on everything the screen
// depends on, which is all of the timing.
const sweepOf = (k) => bandsOf(riser.cardRiserSpan(k).bands).map((f) => [startOf(f.frequency)[1], endOf(f.frequency)[1]]);
{
  R.vary = { ...VARY };
  const rolls = [];
  for (let i = 0; i < 6; i++) {
    const k = {};
    riser.startCardRiser(k, 0.3);
    rolls.push({ sweep: sweepOf(k), env: lastEnvelope().calls.filter((c) => c[0] === 'lin').map((c) => c[1]) });
    riser.stopAllCardRisers();
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('six throws, six different sweeps',
    new Set(rolls.map((x) => JSON.stringify(x.sweep))).size === 6);
  check('...and six different weights',
    new Set(rolls.map((x) => x.env[0])).size === 6);
  // THE BANDS MOVE TOGETHER. A bank whose members each wandered off
  // independently is a different, worse sound every throw rather than the same
  // sound in a different mood, and that is what the shared transpose buys.
  // With `spread` at 0 the ratio between bands is identical every time.
  R.vary = { ...VARY, spread: 0 };
  const ratios = [];
  for (let i = 0; i < 4; i++) {
    const k = {};
    riser.startCardRiser(k, 0.3);
    const sw = sweepOf(k);
    ratios.push(sw.map(([f]) => f / sw[0][0]).map((x) => x.toFixed(6)).join(','));
    riser.stopAllCardRisers();
  }
  check('the bank transposes as one', new Set(ratios).size === 1, ratios[0]);
  // ...and `spread` is what breaks that lockstep, so it has to actually do it.
  R.vary = { pitch: 0, spread: 0.2, level: 0, wobble: 0 };
  const spreadRatios = [];
  for (let i = 0; i < 4; i++) {
    const k = {};
    riser.startCardRiser(k, 0.3);
    const sw = sweepOf(k);
    spreadRatios.push(sw.map(([f]) => f / sw[0][0]).join(','));
    riser.stopAllCardRisers();
  }
  check('...and spread is what breaks the lockstep', new Set(spreadRatios).size === 4);

  // ALL OF IT AT ZERO IS THE SAME RISER EVERY TIME. Worth pinning: this is the
  // control that says what the variation is buying, and a `vary` block that
  // could not be turned off would make every other check here unfalsifiable.
  R.vary = { pitch: 0, spread: 0, level: 0, wobble: 0 };
  const flat = [];
  for (let i = 0; i < 3; i++) {
    const k = {};
    riser.startCardRiser(k, 0.3);
    flat.push(JSON.stringify(sweepOf(k)));
    riser.stopAllCardRisers();
  }
  check('all of it at 0 is identical every throw', new Set(flat).size === 1);

  // AND NONE OF IT TOUCHES THE TIMING. The one thing sixty different risers
  // must still agree on is when they land, because the pop and the sting are
  // already scheduled for that frame.
  R.vary = { pitch: 8, spread: 0.3, level: 0.4, wobble: 0.8 };
  const lands = [];
  for (let i = 0; i < 5; i++) {
    const k = {};
    riser.startCardRiser(k, 0.33);
    lands.push(...bandsOf(riser.cardRiserSpan(k).bands).map((f) => endOf(f.frequency)[2]));
    riser.stopAllCardRisers();
  }
  check('however wild, every throw still lands on the fall',
    lands.every((t) => near(t, 0.33, 1e-9)), `${new Set(lands.map((t) => t.toFixed(6))).size} distinct times`);
  R.vary = { pitch: 0, spread: 0, level: 0, wobble: 0 };
}

// ---------------------------------------------------------------------------
section('THE SHAPE SCALES WITH IT');
// `fadeIn` is a SHARE of the fall, not seconds — the one unit that differs from
// the boss riser's, and the reason is that a fixed attack right for a two-
// second arrival never reaches its own level inside a quarter-second one.
const shortFall = 0.2;
{
  const c = {};
  riser.startCardRiser(c, shortFall);
  const lins = lastEnvelope().calls.filter((l) => l[0] === 'lin');
  check('the attack is a share of the fall', lins.length >= 1 && near(lins[0][2], R.fadeIn * shortFall),
    `${lins[0]?.[2]}s of ${shortFall}s`);
  check('...and it keeps swelling to the impact', lins.length >= 2 && near(lins[1][2], shortFall),
    `${lins[1]?.[2]}s`);
  check('...to more than it started', lins.length >= 2 && lins[1][1] > lins[0][1],
    `${lins[0]?.[1]} → ${lins[1]?.[1]}`);
  riser.stopAllCardRisers();
}

// ---------------------------------------------------------------------------
section('THE LOOPING SOURCES ARE CAPPED');
// Every band is a looping buffer, so these are the nodes that never end on
// their own. A teardown that forgets one is silent, not loud — the shared gain
// has already closed — which is how it would survive to forty of them.
{
  const before = sources.length;
  const k = {};
  riser.startCardRiser(k, 0.3);
  const built = sources.slice(before).filter((x) => x.loop);
  check('one looping source per band', built.length === riser.cardRiserSpan(k).bands, `${built.length}`);
  check('...capped even if nothing stops them', built.every((x) => x.stopped !== null));
  const capped = built.map((x) => x.stopped);
  riser.stopCardRiser(k);
  check('...and the landing brings every one forward', built.every((x, i) => x.stopped < capped[i]));
}

// ---------------------------------------------------------------------------
section('THE CHOKE IS PER CARD');
const one = {}; const two = {};
riser.startCardRiser(one, 0.3);
riser.startCardRiser(two, 0.3);
check('two cards in the air, two risers', riser.cardRiserCount() === 2, `${riser.cardRiserCount()}`);
riser.stopCardRiser(one);
check('the first landing takes only its own', riser.cardRiserCount() === 1, `${riser.cardRiserCount()}`);
check('...and the survivor is the right one', !!riser.cardRiserSpan(two) && !riser.cardRiserSpan(one));
check('a key that never had one is a no-op', riser.stopCardRiser({}) === false);
check('cancel takes the lot', riser.stopAllCardRisers() === 1 && riser.cardRiserCount() === 0);

// Disabled means silent, not broken.
R.enabled = false;
check('the toggle silences it', riser.startCardRiser({}, 0.26) === false && riser.cardRiserCount() === 0);
R.enabled = true;

// ---------------------------------------------------------------------------
section('ui.js HANDS IT THE FALL');
// The whole point of doing this through the real menu: the riser is started
// from a setTimeout inside slamCards, and a `time` dropped from that call looks
// perfect at the default and is wrong everywhere else.
const { initFeedback, updateFeedback } = await import('../path/src/systems/feedback.js');
initFeedback(null);
const ui = await import('../path/src/ui/ui.js');
ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onNameSubmit() {} });

// A fall unlike the default, and a stagger MUCH wider than it on purpose: this
// section is about the number arriving, and one card must be alone in the air
// for the count to mean anything. The overlap case has its own section above.
Object.assign(CONFIG.upgradeSlam, { first: 0.02, stagger: 1.2, time: 0.44 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
riser.stopAllCardRisers();
ui.showLevelUp();
// After the first card is thrown and well before it lands.
await sleep((CONFIG.upgradeSlam.first + CONFIG.upgradeSlam.time * 0.4) * 1000);
check('a riser is climbing under the first card', riser.cardRiserCount() === 1, `${riser.cardRiserCount()}`);
check('...swept across the tuned fall, not the default',
  near(endOf(lastSweep())?.[2] ?? -1, CONFIG.upgradeSlam.time, 1e-9),
  `${endOf(lastSweep())?.[2]}s vs ${CONFIG.upgradeSlam.time}s`);
// ...and the landing takes it away, well before the next card is thrown.
await sleep(CONFIG.upgradeSlam.time * 0.8 * 1000);
check('the landing cuts it', riser.cardRiserCount() === 0, `${riser.cardRiserCount()}`);

// A hand abandoned mid-fall must not leave one climbing over a game that has
// moved on — the failure the old choke existed for, in the one path that does
// not know which card it is stopping.
ui.showLevelUp();
await sleep((CONFIG.upgradeSlam.first + CONFIG.upgradeSlam.time * 0.4) * 1000);
check('...still climbing', riser.cardRiserCount() >= 1);
ui.showLevelUp();
await sleep(10);
check('re-dealing does not leave the old ones running', riser.cardRiserCount() <= 1, `${riser.cardRiserCount()}`);

// THE MENU HAS TO BE GONE BEFORE THE PANEL SECTION, and this is the trap that
// cost the most time writing this file. While a hand is arriving, ui.js holds a
// `click` listener on window IN CAPTURE that stops the event dead and skips the
// slam instead (see bindSlamSkip) — so a click on a workbench row never reaches
// the row, the panel silently keeps showing whatever was up, and nothing throws.
// The failure reads exactly like "the new row does not work".
//
// Closed the way the game closes it, then given the deal's own length to
// unwind, because hideAllMenus does not itself cancel the pending slam.
ui.hideAllMenus();
await sleep((CONFIG.upgradeSlam.first + CONFIG.upgradeSlam.time
  + (CONFIG.upgradeChoices ?? 3) * CONFIG.upgradeSlam.stagger) * 1000 + 120);
riser.stopAllCardRisers();

// ---------------------------------------------------------------------------
// The panel is rendered against the AUTHORED variation, not the zeroed one the
// checks above needed.
R.vary = { ...VARY };

// ---------------------------------------------------------------------------
section('IT HAS A ROW IN THE F PANEL');
const { initWorkbench, setWorkbenchVisible } = await import('../path/src/ui/workbench.js');
initWorkbench();
setWorkbenchVisible(true);
const panel = document.querySelector('.sv-wb');
const rail = () => [...document.querySelectorAll('.sv-wb-ev')];
const rowNamed = (t) => rail().find((r) => r.textContent.includes(t));
const LABEL = 'The riser under a card';

check('the panel mounted', !!panel);
const row = rowNamed(LABEL);
check('the riser has a row', !!row);
if (row) {
  let prevSec = null;
  for (const el of [...panel.querySelectorAll('.sv-wb-sec, .sv-wb-ev')]) {
    if (el.classList.contains('sv-wb-sec')) prevSec = el.textContent;
    if (el === row) break;
  }
  check('...under The level-up screen', prevSec === 'The level-up screen', `under "${prevSec}"`);
}

const search = document.querySelector('.sv-wb-search');
const typeFilter = (v) => { search.value = v; search.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
for (const term of ['riser', 'sweep', 'buildup', 'fall']) {
  typeFilter(term);
  check(`"${term}" finds it`, !!rowNamed(LABEL));
}
typeFilter('garlic');
check('"garlic" does not', !rowNamed(LABEL));
typeFilter('');

rowNamed(LABEL).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const titles = [...document.querySelectorAll('.sv-wb-card h3')].map((h) => h.textContent);
for (const t of ['What drives it', 'The mixer', 'Band 1', 'Modulation', 'Variation per throw', 'Its shape in time']) {
  check(`card: ${t}`, titles.includes(t), titles.join(' · '));
}

// THE FALL IS NOT DUPLICATED HERE. Two sliders for one length is how a riser
// drifts off the thing it is scoring — the view reads `upgradeSlam.time` and
// shows it.
const labels = [...document.querySelectorAll('.sv-wb-card .sv-wb-f label')].map((l) => l.textContent);
check('the fall is shown, not re-tuned', labels.includes('sweeps across'), labels.join(' · '));
check('...as a readout with no handle',
  !![...document.querySelectorAll('.sv-wb-f')].find((r) => r.textContent.includes('sweeps across') && !r.querySelector('input')));

// The one that matters: a handle that moves and changes nothing.
const sliders = [...document.querySelectorAll('.sv-wb-card input[type=range]')];
check('every control drew', sliders.length >= 14, `${sliders.length} sliders`);
// One fader per band, named by position, and the per-band shaping below them.
for (let i = 0; i < CONFIG.upgradeSlam.riser.bands.length; i++) {
  check(`band ${i + 1} has a fader`, labels.includes(`band ${i + 1}`), labels.join(' · '));
}
for (const l of ['width (Q)', 'climbs from (Hz)', '...to (Hz)', 'enters at (of the fall)']) {
  check(`a band is shaped: ${l}`, labels.includes(l));
}
for (const l of ['sweep skew', 'wobble (semitones)', '...at (cycles/s)', '...rising to', 'resolution (points)']) {
  check(`modulation: ${l}`, labels.includes(l));
}
check('the sweep can be reversed from the panel', labels.includes('reverse the sweep'));
for (const l of ['register (semitones)', 'spread', 'weight', 'wobble speed']) {
  check(`variation: ${l}`, labels.includes(l));
}
const snapshot = () => JSON.stringify(CONFIG.upgradeSlam.riser);
const deaf = [];
for (const s of sliders) {
  const label = s.previousElementSibling?.textContent ?? '?';
  const before = snapshot();
  const lo = Number(s.min); const hi = Number(s.max); const now = Number(s.value);
  s.value = String(Math.abs(now - lo) > Math.abs(hi - now) ? lo : hi);
  s.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  if (snapshot() === before) deaf.push(label);
}
check('no slider is deaf', deaf.length === 0, deaf.length ? deaf.join(', ') : `${sliders.length} checked`);

// THE BANK IS ANY LENGTH, and the panel is where that is explored — a size
// fixed by config.js cannot be tried by ear, which is the whole point of the
// workbench.
{
  const R2 = CONFIG.upgradeSlam.riser;
  const was = R2.bands.length;
  const add = [...document.querySelectorAll('.sv-wb-btn')].find((x) => x.textContent.includes('+ band'));
  const drop = [...document.querySelectorAll('.sv-wb-btn')].find((x) => x.textContent.includes('\u2212 band'));
  check('the mixer can add a band', !!add);
  add?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  check('...and it lands in the bank', R2.bands.length === was + 1, `${R2.bands.length}`);
  // A COPY of the last, not a fresh default: a new band at some midpoint is one
  // you then have to find by ear before you can tune it.
  check('...as a copy of the last, already audible',
    R2.bands.at(-1).to === R2.bands.at(-2).to && R2.bands.at(-1).level === R2.bands.at(-2).level);
  check('...and the mixer grew a fader for it',
    [...document.querySelectorAll('.sv-wb-card .sv-wb-f label')].map((l) => l.textContent).includes(`band ${was + 1}`));
  const drop2 = [...document.querySelectorAll('.sv-wb-btn')].find((x) => x.textContent.includes('\u2212 band'));
  drop2?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  check('...and take it away again', R2.bands.length === was, `${R2.bands.length}`);
  check('the last band cannot be removed', !!drop && R2.bands.length >= 1);
}

// ...and the audition fires a REAL riser, including the choke, which is half
// the sound.
Object.assign(CONFIG.upgradeSlam, { time: 0.12 });
CONFIG.upgradeSlam.riser.enabled = true;
riser.stopAllCardRisers();
rowNamed(LABEL).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const btn = [...document.querySelectorAll('.sv-wb-btn')].find((b) => b.textContent.includes('One card falling'));
check('the audition button is there', !!btn);
// VARIATION CANNOT BE JUDGED ONE AT A TIME — a single audition of a riser with
// variation on sounds exactly like one without. The whole question is whether
// three in a row sound copied.
const handBtn = [...document.querySelectorAll('.sv-wb-btn')].find((x) => x.textContent.includes('The whole hand'));
check('...and so is the whole hand', !!handBtn);
btn?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
check('...and it sounds', riser.cardRiserCount() === 1, `${riser.cardRiserCount()}`);
await sleep(CONFIG.upgradeSlam.time * 1000 + 60);
check('...and cuts itself on the landing', riser.cardRiserCount() === 0, `${riser.cardRiserCount()}`);

console.warn = realWarn;
console.log(`\n${fails ? `${fails} FAILED` : 'all good'}`);
process.exit(fails ? 1 : 0);
