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
  constructor(v = 0) { this.value = v; this.ramps = []; }
  setValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  // Recorded, so the steal test can prove a cut voice is FADED rather than
  // hard-stopped — an instant cut is a click, which is the one outcome worse
  // than the sound it made room for.
  exponentialRampToValueAtTime(v, t) { this.ramps.push({ v, t }); return this; }
  cancelScheduledValues() { return this; }
}
const node = (extra = {}) => ({ connect(d) { return d; }, disconnect() {}, ...extra });

let now = 0;
// Every stop() the graph is given, so a steal is visible as a source being
// stopped early rather than at the end of its own envelope — and every gain,
// so the fade that precedes it is visible too.
const stops = [];
const gains = [];
class FakeCtx {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = node(); }
  get currentTime() { return now; }
  createGain() { const g = node({ gain: new Param(1) }); gains.push(g); return g; }
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
  createBufferSource() { return node({ buffer: null, playbackRate: new Param(1), loop: false, start() {}, stop(t) { stops.push(t); } }); }
  createOscillator() { return node({ type: 'sine', frequency: new Param(1), detune: new Param(0), start() {}, stop(t) { stops.push(t); } }); }
  // A sampled take is a full second long here — deliberately much longer than
  // dbgSynth's 0.05s decay, so the two paths cannot be confused for each other
  // when the voice budget is being measured in real lengths.
  async decodeAudioData(bytes) { return { duration: 1, src: bytes?.src ?? null }; }
  resume() { return Promise.resolve(); }
}
globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = () => 0;
globalThis.window.clearInterval = () => {};
globalThis.window.setTimeout = (fn, ms) => { pendingTimers.push({ fn, at: wall + (ms ?? 0) }); return 0; };
const pendingTimers = [];
let wall = 0;
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

// playSfx holds a voice slot for as long as each sound really sounds, retiring
// it against ctx.currentTime. Nothing here moves that clock on its own, so
// without winding it between sections the budget fills up and every later check
// measures a stolen voice instead of whatever it was actually testing. Five
// seconds clears everything: the longest voice in this bank is a one-second
// sample. Reset takes the panel down and back up, which clears the tally too.
function freshPanel() {
  now += 5;
  advanceWall(5000);
  stops.length = 0;
  gains.length = 0;
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

section('The voice cap steals rather than refusing');
// Past the cap the NEW sound plays and an old one is faded out under it. The
// other way round — which is what this did for a long time — silently drops
// the hit you just caused in favour of a tail that is already spent, and it is
// why a wave clear used to take every other sound in the game down with it.
freshPanel();
const capWas = CONFIG.audio.maxConcurrent;
CONFIG.audio.maxConcurrent = 3;
for (let i = 0; i < 8; i++) audio.playSfx('dbgSynth', 1);
st = dbg.sfxDebugState();
check('every shot still plays', st.played === 8, `${st.played} of 8`);
check('and none is counted as dropped', st.dropped === 0, `${st.dropped} dropped`);
const stolenRow = st.rows.find((r) => r.outcome === 'stolen');
check('the cut voices are reported', !!stolenRow);
check('one per shot past the cap', stolenRow?.count === 5, `x${stolenRow?.count} of 8 fired`);
check('named for the voice that LOST, not the one that played',
  stolenRow?.name === 'dbgSynth', stolenRow?.name);
check('and the budget is left full, not overdrawn',
  st.voices.active === 3 && st.voices.cap === 3, `${st.voices.active}/${st.voices.cap}`);

// A steal has to be a FADE, or it is a click — and a click is more noticeable
// than the sound it made room for. dbgSynth's own envelope ends at now + 0.05
// and its nodes stop at now + 0.10; a stolen voice ramps to silence at
// now + STEAL_FADE (0.03) and stops at now + 0.04. Both timings are checked,
// because the ramp alone would still click if the node kept running and the
// stop alone would click without it.
const faded = gains.filter((g) => g.gain.ramps.some(
  (r) => r.v <= 0.0001 && Math.abs(r.t - (now + 0.03)) < 1e-9,
));
check('a stolen voice is ramped to silence first', faded.length === 5, `${faded.length} faded`);
const early = stops.filter((t) => Math.abs(t - (now + 0.04)) < 1e-9);
check('then stopped, once the fade has landed', early.length === 5, `${early.length} early stops`);
CONFIG.audio.maxConcurrent = capWas;

section('A cap of zero is still a real off switch');
// The one case where refusing is right: with no budget at all there is nothing
// to steal, and the sound has to be reported as dropped rather than played.
freshPanel();
CONFIG.audio.maxConcurrent = 0;
audio.playSfx('dbgSynth', 1);
st = dbg.sfxDebugState();
check('nothing plays', st.played === 0);
check('and it reads as no voice', st.rows[0]?.outcome === 'voices', st.rows[0]?.outcome);
check('counted as dropped', st.dropped === 1);
CONFIG.audio.maxConcurrent = capWas;

section('The budget is spent in real lengths, not config decays');
// The bug this replaced: the slot was held for `def.decay`, the SYNTH
// fallback's envelope, even when a file was playing. dbgSample's take is a full
// second; its decay says 0.05. Holding it for 0.15s would let seven of these
// share one slot's worth of budget while all seven were audible — and holding
// the 0.05s synth for a second would spend the budget on silence.
freshPanel();
audio.playSfx('dbgSample', 1);
now += 0.15; // well past its 0.05 decay, the number the old code would have used
check('a sampled voice is still held long after its config decay',
  audio.sfxVoiceLoad().active === 1);
now += 0.75; // 0.9 in — still inside the take
check('and for as long as the take really runs', audio.sfxVoiceLoad().active === 1);
now += 0.2; // past the sample's real 1.0s length
check('released once the sample has really finished', audio.sfxVoiceLoad().active === 0);

freshPanel();
audio.playSfx('dbgSynth', 1);
check('a synth voice is held while it rings', audio.sfxVoiceLoad().active === 1);
now += 0.11; // past decay (0.05) + the tail its nodes are scheduled to stop on
check('and released when its envelope is done', audio.sfxVoiceLoad().active === 0);

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
