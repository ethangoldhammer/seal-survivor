#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sfxdebug
//
// The sound feed overlay (0), driven through the real playSfx against a fake
// Web Audio API.
//
// The half worth testing is not the panel, it is the CLASSIFICATION. Every
// reason a sound can fail to play looks identical from the outside — silence —
// and the whole point of the overlay is that it tells them apart. If it says
// "throttled" when the real answer is "no such sound", it is worse than not
// being there, because it sends you to the wrong file.
//
// Also checked: the performance contract. The tap lives inside playSfx, which
// fires dozens of times a second, so it must be genuinely uninstalled while the
// panel is hidden rather than merely ignored.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- a DOM just rich enough for one panel ----------------------------------

function makeEl() {
  const node = {
    style: {},
    children: [],
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); if (v === '') this.children.length = 0; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    addEventListener() {},
    removeEventListener() {},
  };
  return node;
}
globalThis.document = { createElement: makeEl, createElementNS: makeEl, body: makeEl() };

// Captured so the test can press 0 the way a player would.
const keyHandlers = [];
globalThis.window.addEventListener = (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); };
globalThis.window.removeEventListener = () => {};
const pressKey = (key) => { for (const fn of keyHandlers) fn({ key, target: null, repeat: false }); };

// --- the fake graph --------------------------------------------------------

class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
const node = (extra = {}) => ({ connect(d) { return d; }, disconnect() {}, ...extra });

let now = 0;
class FakeCtx {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = node(); }
  get currentTime() { return now; }
  createGain() { return node({ gain: new Param(1) }); }
  createBiquadFilter() { return node({ type: 'lowpass', frequency: new Param(1), Q: new Param(1) }); }
  createConvolver() { return node({ buffer: null }); }
  createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
  createDynamicsCompressor() {
    return node({
      threshold: new Param(0), knee: new Param(0), ratio: new Param(1),
      attack: new Param(0), release: new Param(0), reduction: 0,
    });
  }
  createBuffer(ch, len) { return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { return node({ buffer: null, playbackRate: new Param(1), loop: false, start() {}, stop() {} }); }
  createOscillator() { return node({ type: 'sine', frequency: new Param(1), detune: new Param(0), start() {}, stop() {} }); }
  async decodeAudioData(bytes) { return { duration: 1, src: bytes?.src ?? null }; }
  resume() { return Promise.resolve(); }
}
globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = () => 0;
globalThis.window.clearInterval = () => {};
globalThis.window.setTimeout = (fn, ms) => { pendingTimers.push({ fn, at: wall + (ms ?? 0) }); return 0; };
const pendingTimers = [];
let wall = 0;
// The voice-slot release in playSfx runs on a real timer. Advancing it by hand
// is what lets the concurrency check below be deterministic.
const advanceWall = (ms) => {
  wall += ms;
  for (let i = pendingTimers.length - 1; i >= 0; i--) {
    if (pendingTimers[i].at <= wall) { pendingTimers[i].fn(); pendingTimers.splice(i, 1); }
  }
};

// The overlay ages rows off performance.now(), so the test owns that clock too.
let perf = 0;
globalThis.performance = { now: () => perf };

const SERVED = new Set(['/sfx/a.mp3', '/sfx/b.mp3']);
globalThis.fetch = async (url) => (SERVED.has(url)
  ? { ok: true, status: 200, arrayBuffer: async () => ({ src: url }) }
  : { ok: false, status: 404 });

const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const { feedback, initFeedback, updateFeedback } = await import('../path/src/systems/feedback.js');
const dbg = await import('../path/src/ui/sfxDebug.js');

// A tiny bank: one sampled sound with two takes, one synth-only.
CONFIG.sfx.dbgSample = { srcs: ['/sfx/a.mp3', '/sfx/b.mp3'], type: 'blip', wave: 'sine', freq: [400, 200], decay: 0.05, gain: 1 };
CONFIG.sfx.dbgSynth = { src: null, type: 'blip', wave: 'sine', freq: [400, 200], decay: 0.05, gain: 0.5 };
CONFIG.feedback.dbgThrottled = { emit: null, shake: 0, sfx: 'dbgSynth', sfxMinGap: 0.5 };

// initAudio is what registers the mute key; unlockAudio only builds the graph.
audio.initAudio();
audio.unlockAudio();
await audio.preloadSamples();
dbg.initSfxDebug();
initFeedback(null);

// playSfx holds a voice slot for the length of each sound and releases it on a
// timer. Nothing here advances that timer on its own, so without draining
// between sections the concurrency cap fills up and every later check gets
// "no voice" instead of whatever it was actually testing. Reset takes the
// panel down and back up, which now clears the tally too.
function freshPanel() {
  advanceWall(5000);
  dbg.setSfxDebugVisible(false);
  dbg.setSfxDebugVisible(true);
}

section('The tap is not installed while the panel is hidden');
check('starts hidden', dbg.sfxDebugState().visible === false);
audio.playSfx('dbgSynth', 1);
audio.playSfx('dbgSynth', 1);
check('nothing is recorded', dbg.sfxDebugState().rows.length === 0 && dbg.sfxDebugState().played === 0);

section('0 toggles it');
pressKey('0');
check('the panel is up', dbg.sfxDebugState().visible === true);
pressKey('0');
check('and 0 again puts it away', dbg.sfxDebugState().visible === false);
pressKey('0');

section('What played');
freshPanel();
audio.playSfx('dbgSample', 1);
let st = dbg.sfxDebugState();
let row = st.rows[0];
check('a sampled sound reports as a sample', row?.outcome === 'sample', row?.outcome);
check('and names which take of how many', row?.detail?.takes === 2 && row.detail.take >= 1 && row.detail.take <= 2,
  `take ${row?.detail?.take}/${row?.detail?.takes}`);
check('and carries its gain, so the level is readable live', row?.detail?.gain === 1);

audio.playSfx('dbgSynth', 1);
st = dbg.sfxDebugState();
check('a sound with no files reports as synth', st.rows[0]?.outcome === 'synth', st.rows[0]?.outcome);
check('both are counted as played', st.played === 2, `${st.played}`);
check('and nothing is counted as dropped', st.dropped === 0);

section('Repeats collapse instead of scrolling');
freshPanel();
// This section is about the LIST, not the voice cap — and 14 sounds inside one
// frame would otherwise hit the default cap of 12 and turn two of them into
// "no voice" rows, which is a true result to a different question.
const collapseCap = CONFIG.audio.maxConcurrent;
CONFIG.audio.maxConcurrent = 100;
audio.playSfx('dbgSample', 1);
audio.playSfx('dbgSynth', 1);
// The basic shot fires several times a second. A raw log of that is a blur of
// one word; a counter is readable, and the count is the information.
for (let i = 0; i < 12; i++) audio.playSfx('dbgSample', 1);
st = dbg.sfxDebugState();
const sampleRows = st.rows.filter((r) => r.name === 'dbgSample' && r.outcome === 'sample');
check('twelve more shots are one row', sampleRows.length === 1, `${sampleRows.length} rows`);
check('with the count on it', sampleRows[0].count === 13, `x${sampleRows[0].count}`);
check('the other sound still has its own row', st.rows.some((r) => r.name === 'dbgSynth'));
CONFIG.audio.maxConcurrent = collapseCap;

section('A sound that did NOT play');
freshPanel();
audio.playSfx('noSuchSound', 1);
st = dbg.sfxDebugState();
check('an unknown name is called out, not swallowed', st.rows[0]?.outcome === 'unknown', st.rows[0]?.outcome);
check('and counted as dropped', st.dropped === 1);

// The throttle. Two calls inside one gap: the first plays, the second is eaten.
freshPanel();
feedback('dbgThrottled', {});
feedback('dbgThrottled', {});
feedback('dbgThrottled', {});
st = dbg.sfxDebugState();
const gapRow = st.rows.find((r) => r.outcome === 'gap');
check('a throttled sound says so', !!gapRow);
check('twice, since two were eaten', gapRow?.count === 2, `x${gapRow?.count}`);
check('and names the EVENT, not just the sound', gapRow?.detail?.text === 'dbgThrottled', gapRow?.detail?.text);
check('the one that got through is a separate row', st.rows.some((r) => r.outcome === 'synth'));
check('dropped counts the throttled pair', st.dropped === 2, `${st.dropped}`);
updateFeedback(1); // clear the throttle for anything after this

// The voice cap. maxConcurrent is a hard early return with no warning at all.
freshPanel();
const capWas = CONFIG.audio.maxConcurrent;
CONFIG.audio.maxConcurrent = 3;
for (let i = 0; i < 8; i++) audio.playSfx('dbgSynth', 1);
st = dbg.sfxDebugState();
const voiceRow = st.rows.find((r) => r.outcome === 'voices');
check('running out of voices is reported', !!voiceRow);
check('for every shot that was refused', voiceRow?.count === 5, `x${voiceRow?.count} of 8 fired`);
CONFIG.audio.maxConcurrent = capWas;
advanceWall(2000); // let the held voice slots expire

section('Muting');
freshPanel();
for (const fn of keyHandlers) fn({ key: 'm', target: null, repeat: false });
audio.playSfx('dbgSynth', 1);
st = dbg.sfxDebugState();
check('a muted sound reads as muted rather than as playing', st.rows[0]?.outcome === 'muted', st.rows[0]?.outcome);
check('and is not counted as played', st.played === 0);
for (const fn of keyHandlers) fn({ key: 'm', target: null, repeat: false });

section('Rows age out');
freshPanel();
perf = 1000;
audio.playSfx('dbgSynth', 1);
dbg.updateSfxDebug();
check('a fresh row is listed', dbg.sfxDebugState().rows.length === 1);
perf = 1000 + 2000;
dbg.updateSfxDebug();
check('still there after two seconds', dbg.sfxDebugState().rows.length === 1);
perf = 1000 + 4000;
dbg.updateSfxDebug();
check('gone after four', dbg.sfxDebugState().rows.length === 0,
  'the list reads as what is happening, not what happened');

section('The rate readout');
freshPanel();
perf = 10000;
for (let i = 0; i < 6; i++) audio.playSfx('dbgSynth', 1);
dbg.updateSfxDebug();
check('counts what fired in the last second', dbg.sfxDebugState().rate === 6, `${dbg.sfxDebugState().rate}/s`);
perf = 11500;
dbg.updateSfxDebug();
check('and forgets it a second later', dbg.sfxDebugState().rate === 0);

section('Hiding uninstalls the tap again');
dbg.setSfxDebugVisible(false);
audio.playSfx('dbgSynth', 1);
audio.playSfx('dbgSample', 1);
check('nothing accumulates while hidden', dbg.sfxDebugState().rows.length === 0
  && dbg.sfxDebugState().played === 0);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
