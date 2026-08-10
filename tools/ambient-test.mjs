#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ambient
//
// Drives systems/ambient.js against a fake Web Audio API, on a clock this
// script advances by hand. There is no other way to check it: the whole system
// is a schedule, most of it measured in tens of seconds, and every property
// worth having is about WHAT WAS SCHEDULED rather than what a frame looked
// like. A screenshot of an ambient bed is a black rectangle.
//
// What it checks, in rough order of what would actually hurt:
//
//   EQUAL POWER    the crossfade's two curves sum to constant power. A linear
//                  pair sags ~3dB through the middle, which is a hole in the
//                  bed every single time it switches — the exact artefact the
//                  system exists to avoid, and the one you'd never spot by ear
//                  without knowing to listen for it.
//   NO COLLISION   a hold is always longer than two crossfades, so a switch
//                  can never begin while the previous one is still running.
//                  Two overlapping setValueCurveAtTime calls on one deck throw
//                  in a real browser and take the bed out for the rest of the
//                  run.
//   ROTATION       never the same clip twice running; shuffle covers the set;
//                  in-order mode is actually in order.
//   ONE CLIP       a single-clip bed never schedules a switch at all, so its
//                  seamless loop stays seamless.
//   VOLUME SPLIT   the volume control never touches a deck gain, which is what
//                  lets the slider move mid-crossfade without tearing it.
//   MISSING FILE   a clip that 404s is dropped and the bed plays on.
//
// What it cannot tell you: whether the bed sounds good, or whether 34 seconds
// is the right hold. Those are ears.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- the fake graph --------------------------------------------------------
// Records every automation rather than producing samples. `now` is moved by
// the test, so a 34-second hold costs no wall time.

let now = 0;
const timers = new Map();
let timerId = 1;

class Param {
  constructor(value = 0) { this.value = value; this.calls = []; this.curves = []; }
  setValueAtTime(v, t) { this.calls.push(['setValueAtTime', v, t]); this.value = v; return this; }
  setTargetAtTime(v, t, c) { this.calls.push(['setTargetAtTime', v, t, c]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.calls.push(['linearRamp', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['expRamp', v, t]); this.value = v; return this; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
  // Models the part that matters: unlike cancelScheduledValues, this one stops
  // a curve that is already running. The test below checks the fade-out path
  // reaches for it.
  cancelAndHoldAtTime(t) {
    this.calls.push(['cancelAndHold', t]);
    this.curves = this.curves.filter((c) => c.end <= t);
    return this;
  }
  setValueCurveAtTime(curve, t, dur) {
    // The real API throws when a curve overlaps one already scheduled. Model
    // that, because "it threw" IS the bug this reproduces.
    for (const prev of this.curves) {
      if (t < prev.end && t + dur > prev.start) {
        throw new Error(`overlapping setValueCurveAtTime at ${t.toFixed(2)} (previous ${prev.start.toFixed(2)}..${prev.end.toFixed(2)})`);
      }
    }
    this.curves.push({ curve: Array.from(curve), start: t, end: t + dur, dur });
    this.calls.push(['curve', curve.length, t, dur]);
    this.value = curve[curve.length - 1];
    return this;
  }
}

const node = (extra = {}) => ({
  connect(dest) { this.dest = dest; return dest; },
  disconnect() { this.dest = null; },
  ...extra,
});

class FakeSource {
  constructor() {
    this.playbackRate = new Param(1);
    this.loop = false;
    this.buffer = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.onended = null;
  }
  connect(dest) { this.dest = dest; return dest; }
  disconnect() { this.dest = null; }
  start(t) { this.startedAt = t; started.push(this); }
  stop(t) {
    if (this.stoppedAt != null) throw new Error('stopped twice');
    this.stoppedAt = t;
  }
}
const started = [];

// Clip lengths the fake decoder reports, keyed by URL.
const DURATIONS = {};

let fakeCtx = null;
// Every gain the context ever handed out. The two decks are the only ones that
// ever receive a value CURVE; the bed gain and the SFX bus's gains never do,
// which is how the checks below tell them apart without reaching inside the
// module.
const ctxGains = () => fakeCtx?.gains ?? [];

class FakeCtx {
  constructor() {
    fakeCtx = this;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = node();
    this.gains = [];
  }
  get currentTime() { return now; }
  createGain() { const g = node({ gain: new Param(1) }); this.gains.push(g); return g; }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: new Param(20000), Q: new Param(1), detune: new Param(0) });
  }
  createConvolver() { return node({ buffer: null }); }
  // The bus's dynamics stage. Not exercised by anything in this file, but
  // unlockAudio builds the whole bus before the ambient system can attach to
  // it — and a missing factory here is swallowed by unlockAudio's try/catch,
  // which leaves audio silently locked and every check below failing for a
  // reason that has nothing to do with ambience.
  createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
  createDynamicsCompressor() {
    return node({
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25), reduction: 0,
    });
  }
  createBuffer(ch, len) {
    return { numberOfChannels: ch, length: len, duration: len / this.sampleRate, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() { return new FakeSource(); }
  // Tagged with the URL it came from, so a check can ask which clip a source
  // is actually playing rather than inferring it from timing. Durations are
  // per-file so the fade-clamping check has a genuinely short clip to work on.
  async decodeAudioData(bytes) {
    const src = bytes?.src ?? null;
    const duration = DURATIONS[src] ?? 6;
    return { duration: duration, length: duration * this.sampleRate, sampleRate: this.sampleRate, src: src };
  }
  resume() { return Promise.resolve(); }
}

globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = (fn, ms) => { const id = timerId++; timers.set(id, { fn, ms }); return id; };
globalThis.window.clearInterval = (id) => { timers.delete(id); };

// Which paths the fake network serves. Anything else 404s, which is the
// missing-file case at the bottom of this file. The body carries its own URL
// so decodeAudioData can tag the buffer with where it came from.
let servable = new Set();
globalThis.fetch = async (url) => {
  if (!servable.has(url)) return { ok: false, status: 404 };
  return { ok: true, status: 200, arrayBuffer: async () => ({ src: url, byteLength: 64 }) };
};

// unlockAudio also kicks off preloadSamples, which tries to fetch every sample
// in the real tuning file and warns on each 404. Collected rather than printed:
// the noise would bury the results, and one of the checks below is that a
// specific warning WAS produced.
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));

// Run every registered interval once — the poll is the only one, and it is
// idempotent with respect to time, so "tick" means "give it a chance to act".
const tick = () => { for (const t of [...timers.values()]) t.fn(); };
const advance = (seconds) => { now += seconds; tick(); };

const { CONFIG } = await import('../path/src/config.js');
const { unlockAudio } = await import('../path/src/systems/audio.js');
const ambient = await import('../path/src/systems/ambient.js');

// A fixed four-clip bed, so the rotation checks have something to rotate.
const CLIPS = ['/sfx/a.mp3', '/sfx/b.mp3', '/sfx/c.mp3', '/sfx/d.mp3'];
servable = new Set(CLIPS);
CONFIG.ambient = {
  enabled: true,
  volume: 0.4,
  srcs: [...CLIPS],
  slots: 6,
  holdSeconds: 30,
  holdVary: 0.25,
  crossfade: 6,
  pitchVary: 0.04,
  shuffle: true,
  fadeOut: 1.6,
};

unlockAudio();
await ambient.preloadAmbient();
ambient.startAmbient();

section('Loading');
check('every configured clip decoded', ambient.ambientState().loaded === 4, `${ambient.ambientState().loaded}/4`);
check('a clip is playing', !!ambient.ambientState().playing, ambient.ambientState().playing ?? 'none');
check('the first clip fades in rather than dropping in', started[0]?.startedAt >= 0 && started.length === 1);
check('it loops, so a 6s clip fills a 30s hold', started[0]?.loop === true);

section('The crossfade is equal-power');
// Roll the clock forward until a second source has been started — that is the
// switch. The hold varies, so this waits rather than assuming a number.
let guard = 0;
while (started.length < 2 && guard++ < 400) advance(1);
check('a switch happened inside two holds', started.length >= 2, `${guard}s in`);

const incoming = started[1];
const inCurve = incoming.dest.gain.curves.at(-1);
// The outgoing deck is the other one: the only gain node carrying a falling
// curve that starts at the same time.
const outCurve = ctxGains()
  .map((g) => g.gain.curves.at(-1))
  .find((c) => c && c !== inCurve && Math.abs(c.start - inCurve.start) < 1e-6);

check('both decks got a curve, starting together', !!outCurve && !!inCurve);
check('and both run for the configured crossfade', !!inCurve && Math.abs(inCurve.dur - 6) < 1e-6, `${inCurve?.dur}s`);

if (inCurve && outCurve) {
  let worstDb = 0;
  for (let i = 0; i < inCurve.curve.length; i++) {
    const power = inCurve.curve[i] ** 2 + outCurve.curve[i] ** 2;
    worstDb = Math.max(worstDb, Math.abs(10 * Math.log10(power)));
  }
  check('summed power stays flat across the fade', worstDb < 0.05, `worst deviation ${worstDb.toFixed(4)} dB`);
  check('the incoming curve rises from silence', inCurve.curve[0] < 1e-6 && inCurve.curve.at(-1) > 0.999);
  check('the outgoing curve falls to silence', outCurve.curve[0] > 0.999 && outCurve.curve.at(-1) < 1e-6);
  // A linear pair is what this would be if nobody had thought about it. Shown
  // as the contrast, so the number above means something.
  const linearWorst = Math.abs(10 * Math.log10(0.5 ** 2 + 0.5 ** 2));
  check('(for contrast, a linear fade would sag)', linearWorst > 2.9, `${linearWorst.toFixed(2)} dB hole at the midpoint`);
}

check('the outgoing source is stopped after its fade, not during', outCurve
  ? started.find((s) => s.dest?.gain?.curves?.at(-1) === outCurve)?.stoppedAt >= outCurve.end
  : false);

section('Holds can never collide with a fade');
// nextHold() is the whole guarantee: a hold shorter than two crossfades would
// schedule the next curve into the previous one's window, which the fake Param
// above throws on exactly like a browser does.
let shortest = Infinity;
for (let i = 0; i < 2000; i++) shortest = Math.min(shortest, ambient.nextHold());
check('every hold clears two crossfades', shortest >= 6 * 2 + 1, `shortest of 2000 rolls: ${shortest.toFixed(2)}s`);

CONFIG.ambient.holdSeconds = 2; // deliberately shorter than the crossfade
let shortestClamped = Infinity;
for (let i = 0; i < 2000; i++) shortestClamped = Math.min(shortestClamped, ambient.nextHold());
check('a hold configured shorter than the fade is clamped up', shortestClamped >= 13, `${shortestClamped.toFixed(2)}s`);
CONFIG.ambient.holdSeconds = 30;

section('Rotation');
// Run a long session and watch which clip is in front after each switch.
const seen = [];
let last = ambient.ambientState().playing;
for (let i = 0; i < 4000; i++) {
  advance(1);
  const p = ambient.ambientState().playing;
  if (p !== last) { seen.push(p); last = p; }
  if (seen.length >= 60) break;
}
check('the bed kept switching over a long session', seen.length >= 30, `${seen.length} switches`);
let repeats = 0;
for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) repeats++;
check('never the same clip twice running', repeats === 0, `${repeats} repeats`);
check('shuffle reaches every clip', new Set(seen).size === CLIPS.length, `${new Set(seen).size}/${CLIPS.length} used`);

section('In-order mode');
CONFIG.ambient.shuffle = false;
ambient.resetAmbient();
await ambient.reloadAmbient();
now += 20; // clear the reset's fade-out before restarting
ambient.startAmbient();
const order = [ambient.ambientState().playing];
for (let i = 0; i < 2000 && order.length < 9; i++) {
  advance(1);
  const p = ambient.ambientState().playing;
  if (p !== order.at(-1)) order.push(p);
}
let inOrder = true;
for (let i = 1; i < order.length; i++) {
  const expected = CLIPS[(CLIPS.indexOf(order[i - 1]) + 1) % CLIPS.length];
  if (order[i] !== expected) inOrder = false;
}
check('clips advance round-robin', inOrder, order.map((c) => c.slice(5, 6)).join(' → '));
CONFIG.ambient.shuffle = true;

section('A single clip never switches');
ambient.resetAmbient();
CONFIG.ambient.srcs = ['/sfx/a.mp3', null, null];
await ambient.reloadAmbient();
now += 20;
const beforeCount = started.length;
ambient.startAmbient();
for (let i = 0; i < 600; i++) advance(1);
check('exactly one source was started in ten minutes', started.length - beforeCount === 1, `${started.length - beforeCount} started`);
check('so the loop has no seam in it', started.at(-1).loop === true);

section('Volume is on its own node');
CONFIG.ambient.srcs = [...CLIPS];
ambient.resetAmbient();
await ambient.reloadAmbient();
now += 20;
ambient.startAmbient();
const deckGains = ctxGains().filter((g) => g.gain.curves.length > 0);
const deckCallsBefore = deckGains.map((g) => g.gain.calls.length);
CONFIG.ambient.volume = 0.9;
ambient.applyAmbientSettings();
const deckCallsAfter = deckGains.map((g) => g.gain.calls.length);
check('changing volume writes nothing to either deck', deckCallsBefore.every((n, i) => n === deckCallsAfter[i]));
const bed = ctxGains().find((g) => g.gain.calls.some((c) => c[0] === 'setTargetAtTime' && c[1] === 0.9));
check('it goes to the bed gain instead', !!bed);

section('A clip that will not load');
ambient.resetAmbient();
CONFIG.ambient.srcs = ['/sfx/a.mp3', '/sfx/missing.mp3', '/sfx/c.mp3'];
servable = new Set(['/sfx/a.mp3', '/sfx/c.mp3']);
await ambient.reloadAmbient();
now += 20;
const beforeMissing = started.length;
ambient.startAmbient();
for (let i = 0; i < 300; i++) advance(1);
check('the bed still plays', started.length > beforeMissing);
const playedMissing = started.slice(beforeMissing).some((s) => s.buffer?.src === '/sfx/missing.mp3');
check('and the missing clip is never in the rotation', !playedMissing);
check('the state reports only what decoded', ambient.ambientState().loaded === 2, `${ambient.ambientState().loaded}/3`);
check('the failure was reported rather than swallowed',
  warnings.some((w) => w.includes('[ambient]') && w.includes('missing.mp3')));

// ---------------------------------------------------------------------------
// SPORADIC MODE. `gapSeconds` above zero switches the whole system over: a clip
// fades up, plays ONCE, fades away, and nothing sounds until the next one. The
// properties worth holding onto are different from the crossfading bed's, and
// two of them are the opposite of it -- it must not loop, and there must be
// real silence in the middle.
// ---------------------------------------------------------------------------

// A fresh set of URLs, because the module caches decoded buffers by path and
// the four above are already held at the default length. These carry real
// lengths, including one clip deliberately too short to fit two full fades.
const SPOT = ['/sfx/s1.mp3', '/sfx/s2.mp3', '/sfx/s3.mp3', '/sfx/s4.mp3'];
DURATIONS[SPOT[0]] = 8;
DURATIONS[SPOT[1]] = 12;
DURATIONS[SPOT[2]] = 4;
DURATIONS[SPOT[3]] = 0.6;

section('Sporadic mode');
ambient.resetAmbient();
servable = new Set(SPOT);
CONFIG.ambient.srcs = [...SPOT];
CONFIG.ambient.gapSeconds = 20;
CONFIG.ambient.gapVary = 0.5;
CONFIG.ambient.fadeSeconds = 1.8;
CONFIG.ambient.pitchVary = 0; // so a clip's audible length is its real length
await ambient.reloadAmbient();
now += 30;

const beforeSporadic = started.length;
ambient.startAmbient();
check('the mode is reported as sporadic', ambient.ambientState().mode === 'sporadic');
for (let i = 0; i < 1200; i++) advance(0.5);
const appearances = started.slice(beforeSporadic);
check('it kept appearing over ten minutes', appearances.length >= 12, `${appearances.length} appearances`);
check('no appearance loops', appearances.every((s) => s.loop === false));
check('every appearance is stopped', appearances.every((s) => s.stoppedAt != null));

// Real silence: each appearance must start after the previous one has stopped.
let overlaps = 0;
let shortestSilence = Infinity;
for (let i = 1; i < appearances.length; i++) {
  const gap = appearances[i].startedAt - appearances[i - 1].stoppedAt;
  if (gap < 0) overlaps++;
  shortestSilence = Math.min(shortestSilence, gap);
}
check('the water is genuinely quiet between them', overlaps === 0, `${overlaps} overlaps`);
check('and quiet for at least half the configured gap',
  shortestSilence >= 20 * 0.5 - 1, `shortest silence ${shortestSilence.toFixed(1)}s`);

// The gap has to actually vary or the ear finds the pattern.
const silences = [];
for (let i = 1; i < appearances.length; i++) silences.push(appearances[i].startedAt - appearances[i - 1].stoppedAt);
const spread = Math.max(...silences) - Math.min(...silences);
check('the silence varies rather than ticking', spread > 4, `${spread.toFixed(1)}s spread`);

// Fades: two curves per appearance, inside the clip, not touching.
let badFades = 0, clampedShort = 0;
for (const s of appearances) {
  const curves = s.dest.gain.curves.filter(function (c) {
    return c.start >= s.startedAt - 1e-6 && c.end <= (s.stoppedAt ?? Infinity) + 1e-6;
  });
  if (curves.length !== 2) { badFades++; continue; }
  const rising = curves[0], falling = curves[1];
  if (rising.curve[0] > 1e-6 || rising.curve[rising.curve.length - 1] < 0.999) badFades++;
  if (falling.curve[0] < 0.999 || falling.curve[falling.curve.length - 1] > 1e-6) badFades++;
  if (rising.end > falling.start + 1e-9) badFades++;
  if (falling.dur < 1.79) clampedShort++;
}
check('each appearance fades up and back down', badFades === 0, `${badFades} malformed`);
check('a clip too short for two full fades gets them clamped, not overlapped',
  clampedShort > 0, `${clampedShort} of ${appearances.length} appearances were clamped`);

section('Sporadic mode with a single clip');
// The opposite of the continuous case: one clip SHOULD keep reappearing, since
// what repeats is the silence, not a seam in a loop.
ambient.resetAmbient();
CONFIG.ambient.srcs = [SPOT[0], null, null];
await ambient.reloadAmbient();
now += 60;
const beforeSolo = started.length;
ambient.startAmbient();
for (let i = 0; i < 600; i++) advance(0.5);
check('one clip still reappears', started.length - beforeSolo >= 5, `${started.length - beforeSolo} appearances`);

section('Ending a run mid-fade');
CONFIG.ambient.srcs = [...SPOT];
await ambient.reloadAmbient();
now += 60;
ambient.startAmbient();
advance(0.5); // an appearance is now in flight with a fade-out already scheduled
const sounding = started[started.length - 1];
ambient.stopAmbient();
const holds = sounding.dest.gain.calls.filter(function (c) { return c[0] === 'cancelAndHold'; });
check('the fade-out cancels the in-flight curve rather than queueing behind it', holds.length > 0);
check('and ramps to silence', sounding.dest.gain.calls.some(function (c) { return c[0] === 'linearRamp' && c[1] === 0; }));

section('Back to continuous');
CONFIG.ambient.gapSeconds = 0;
check('mode flips back with the one setting', ambient.ambientState().mode === 'continuous');

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
