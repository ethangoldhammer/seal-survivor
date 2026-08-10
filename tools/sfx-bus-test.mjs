#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bus
//
// The SFX bus's dynamics stage, against a fake Web Audio API.
//
// Every property here is one that fails SILENTLY in a browser. A soft-clip
// curve that is subtly wrong does not throw, does not warn, and does not look
// different — it just quietly recompresses the whole mix, or lets a peak
// through, and the only symptom is that the game sounds slightly off in a way
// nobody can point at. So they are asserted as arithmetic instead:
//
//   TRANSPARENCY  below the knee the curve is the identity, exactly. This is
//                 the property that separates a limiter from a fader: if the
//                 curve bends early, moving the ceiling changes the level of
//                 every sound in the game rather than just the peaks.
//   CEILING       no input, however absurd, can produce an output above the
//                 ceiling. This is what makes the +24dB gain sliders safe.
//   SHAPE         monotonic and odd-symmetric, so the curve cannot fold a loud
//                 sound back down (which is fuzz, not limiting) or add a DC
//                 offset (which is a thump on every hit).
//   ROUTING       the compressor is unpatched rather than neutralised when it
//                 is off, because the node adds latency even while idle.
//   LEVELS        dB <-> linear round-trips, since the tuner edits one and the
//                 engine stores the other.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- the fake graph --------------------------------------------------------

class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}

let nodeId = 0;
function baseNode(kind, extra = {}) {
  return {
    kind,
    id: ++nodeId,
    outputs: [],
    connect(dest) { this.outputs.push(dest); return dest; },
    disconnect() { this.outputs.length = 0; },
    ...extra,
  };
}

let fakeCtx = null;
// The audio clock, advanced by hand. The repetition section at the bottom is
// entirely about elapsed time between plays, and it has to run in zero wall
// time to be worth having in the suite.
let now = 0;
class FakeCtx {
  constructor() {
    fakeCtx = this;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = baseNode('destination');
  }
  get currentTime() { return now; }
  createGain() { return baseNode('gain', { gain: new Param(1) }); }
  createBiquadFilter() {
    return baseNode('biquad', { type: 'lowpass', frequency: new Param(20000), Q: new Param(1) });
  }
  createConvolver() { return baseNode('convolver', { buffer: null }); }
  createWaveShaper() { return baseNode('waveshaper', { curve: null, oversample: 'none' }); }
  createDynamicsCompressor() {
    return baseNode('compressor', {
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25), reduction: 0,
    });
  }
  createBuffer(ch, len) {
    return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    return baseNode('source', { buffer: null, playbackRate: new Param(1), loop: false, start() {}, stop() {} });
  }
  createOscillator() {
    return baseNode('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
  }
  async decodeAudioData() { return { duration: 1 }; }
  resume() { return Promise.resolve(); }
}

globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = () => 0;
globalThis.window.clearInterval = () => {};
globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');

CONFIG.audio.bus.comp = {
  enabled: true,
  threshold: -18, knee: 12, ratio: 3, attack: 0.005, release: 0.18,
  makeup: 1.6, ceiling: 0.95, ceilingKnee: 0.6, oversample: '2x',
};

audio.unlockAudio();

// Walk the graph from the bus input to the speakers.
function chainFrom(node, seen = new Set()) {
  if (!node || seen.has(node.id)) return [];
  seen.add(node.id);
  const out = [node.kind];
  for (const next of node.outputs) out.push(...chainFrom(next, seen));
  return out;
}

const bus = audio.getSfxBus();

section('The graph');
const chain = chainFrom(bus);
check('the bus input reaches the speakers', chain.includes('destination'), chain.join(' -> '));
check('through the shared filter', chain.includes('biquad'));
check('with a parallel reverb send', chain.includes('convolver'));
check('and the compressor in circuit', chain.includes('compressor'));
check('and the ceiling last', chain.indexOf('waveshaper') === chain.lastIndexOf('waveshaper')
  && chain.indexOf('waveshaper') < chain.indexOf('destination'));

section('Switching the compressor off unpatches it');
// Not neutralised: a DynamicsCompressorNode adds a few ms of lookahead delay
// whether or not it is compressing, and "off" has to mean off on a bus that
// fires on the same frame as the picture.
CONFIG.audio.bus.comp.enabled = false;
audio.applyAudioBusSettings();
const bypassed = chainFrom(bus);
check('the compressor is out of the chain', !bypassed.includes('compressor'), bypassed.join(' -> '));
check('but the ceiling is still in it', bypassed.includes('waveshaper'));
check('and it still reaches the speakers', bypassed.includes('destination'));
check('reduction reads flat while bypassed', audio.busReduction() === 0);

CONFIG.audio.bus.comp.enabled = true;
audio.applyAudioBusSettings();
check('and it comes back when switched on', chainFrom(bus).includes('compressor'));

section('Compressor settings reach the node');
const comp = (function find(node, seen = new Set()) {
  if (!node || seen.has(node.id)) return null;
  seen.add(node.id);
  if (node.kind === 'compressor') return node;
  for (const n of node.outputs) { const hit = find(n, seen); if (hit) return hit; }
  return null;
}(bus));
check('threshold', comp?.threshold.value === -18, `${comp?.threshold.value} dB`);
check('ratio', comp?.ratio.value === 3, `${comp?.ratio.value}:1`);
check('attack', Math.abs(comp?.attack.value - 0.005) < 1e-9);
check('release', Math.abs(comp?.release.value - 0.18) < 1e-9);

section('The ceiling curve');
const shaper = (function find(node, seen = new Set()) {
  if (!node || seen.has(node.id)) return null;
  seen.add(node.id);
  if (node.kind === 'waveshaper') return node;
  for (const n of node.outputs) { const hit = find(n, seen); if (hit) return hit; }
  return null;
}(bus));
const curve = shaper?.curve;
check('a curve was built', !!curve && curve.length > 512, `${curve?.length} points`);
check('oversampling is on', shaper?.oversample === '2x', shaper?.oversample);

const CEIL = 0.95;
const KNEE = 0.6 * CEIL; // 0.57
const xAt = (i) => (i / (curve.length - 1)) * 2 - 1;

// Transparency: below the knee the curve must be the identity, not merely
// close to it.
let worstBelowKnee = 0;
for (let i = 0; i < curve.length; i++) {
  const x = xAt(i);
  if (Math.abs(x) > KNEE) continue;
  worstBelowKnee = Math.max(worstBelowKnee, Math.abs(curve[i] - x));
}
check('everything below the knee passes through untouched', worstBelowKnee < 1e-6,
  `worst deviation ${worstBelowKnee.toExponential(1)}`);

// For contrast: the naive `c * tanh(x / c)` curve everyone reaches for first.
const naiveAtHalf = CEIL * Math.tanh(0.5 / CEIL);
const naiveDb = Math.abs(20 * Math.log10(naiveAtHalf / 0.5));
check('(a plain tanh curve would not have)', naiveDb > 0.5,
  `it is ${naiveDb.toFixed(2)} dB down at half scale, on every sound in the game`);

let maxOut = 0;
for (let i = 0; i < curve.length; i++) maxOut = Math.max(maxOut, Math.abs(curve[i]));
check('nothing can exceed the ceiling', maxOut <= CEIL + 1e-9, `peak ${maxOut.toFixed(4)} of ${CEIL}`);
check('and the top of the range gets close to it', maxOut > KNEE, `${maxOut.toFixed(4)}`);

let monotonic = true;
for (let i = 1; i < curve.length; i++) if (curve[i] < curve[i - 1] - 1e-9) monotonic = false;
check('the curve is monotonic, so loud never folds back to quiet', monotonic);

let worstAsymmetry = 0;
for (let i = 0; i < curve.length; i++) {
  worstAsymmetry = Math.max(worstAsymmetry, Math.abs(curve[i] + curve[curve.length - 1 - i]));
}
check('and odd-symmetric, so it adds no DC thump', worstAsymmetry < 1e-6,
  `worst ${worstAsymmetry.toExponential(1)}`);

section('A hot bus is bounded, not clipped');
// What the +24dB gain sliders actually mean: a sound driven to the top of its
// track, times the loudest feedback scale, times the sample's own peak.
// Interpolated between table entries, which is what a WaveShaper actually
// does. Nearest-entry lookup would put half a step of quantisation on every
// reading — enough to fail the transparency check below on the test's own
// arithmetic rather than on anything the curve got wrong.
const shapeAt = (x) => {
  const clamped = Math.max(-1, Math.min(1, x));
  const pos = ((clamped + 1) / 2) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(pos));
  const frac = pos - i;
  return curve[i] * (1 - frac) + curve[i + 1] * frac;
};
for (const drive of [1.2, 4, 16, 64]) {
  const out = shapeAt(drive);
  check(`an input of ${drive}x full scale lands at ${out.toFixed(3)}`, out <= CEIL + 1e-9);
}
check('a quiet sound is not touched by any of that', Math.abs(shapeAt(0.25) - 0.25) < 1e-6);

section('Moving the ceiling only rebuilds when it changes');
const before = shaper.curve;
audio.applyAudioBusSettings();
check('re-applying identical settings keeps the curve', shaper.curve === before);
CONFIG.audio.bus.comp.ceiling = 0.7;
audio.applyAudioBusSettings();
check('changing the ceiling rebuilds it', shaper.curve !== before);
let newMax = 0;
for (let i = 0; i < shaper.curve.length; i++) newMax = Math.max(newMax, Math.abs(shaper.curve[i]));
check('and the new ceiling is respected', newMax <= 0.7 + 1e-9, `peak ${newMax.toFixed(4)}`);
CONFIG.audio.bus.comp.ceiling = 0.95;

section('Levels');
check('unity is 0 dB', Math.abs(audio.gainToDb(1)) < 1e-9);
check('half is -6 dB', Math.abs(audio.gainToDb(0.5) + 6.0206) < 1e-3, audio.gainToDb(0.5).toFixed(3));
check('the top of the tuner track is ~15.8x', Math.abs(audio.dbToGain(24) - 15.849) < 1e-2, audio.dbToGain(24).toFixed(3));
check('which is 4x the old ceiling of 4', audio.dbToGain(24) / 4 > 3.9);
let worstRoundTrip = 0;
for (let db = audio.DB_FLOOR + 0.5; db <= 24; db += 0.5) {
  worstRoundTrip = Math.max(worstRoundTrip, Math.abs(audio.gainToDb(audio.dbToGain(db)) - db));
}
check('dB -> gain -> dB round-trips across the whole track', worstRoundTrip < 1e-9,
  `worst ${worstRoundTrip.toExponential(1)}`);
check('the bottom of the track is silence, not a very quiet sound', audio.dbToGain(audio.DB_FLOOR) === 0);
check('and a zero gain reports as the floor', audio.gainToDb(0) === audio.DB_FLOOR);

// ---------------------------------------------------------------------------
// REPETITION. The fix for a sound that turns to static when it repeats fast.
// Everything here is about the SHAPE of the ducking, and every property is one
// that would be inaudible as a bug and obvious as a symptom: too aggressive and
// the second hit of every pair vanishes, too slow to recover and a sound stays
// ducked long after the fight, no floor and a firefight goes silent.
// ---------------------------------------------------------------------------

section('Repetition');
CONFIG.audio.repetition = { enabled: true, recovery: 0.5, strength: 0.35, floor: 0.25 };

// Levels are read off the debug tap, which reports the gain that was actually
// applied — so this measures what reached the graph, not a re-implementation
// of the formula.
const levels = [];
audio.watchSfx((name, outcome, detail) => {
  if (detail && detail.gain != null) levels.push({ name, gain: detail.gain, rep: detail.rep });
});
CONFIG.sfx.repTest = { src: null, type: 'blip', wave: 'sine', freq: [400, 200], decay: 0.02, gain: 1 };
CONFIG.audio.maxConcurrent = 10000; // the voice cap is a different mechanism

const fire = (times, spacing) => {
  levels.length = 0;
  for (let i = 0; i < times; i++) { audio.playSfx('repTest', 1); now += spacing; }
  return levels.map((l) => l.rep);
};

audio.resetRepetition();
const burst = fire(12, 0.05); // 20 a second, the old bulletHit ceiling
check('the first hit of a burst is untouched', Math.abs(burst[0] - 1) < 1e-9, `x${burst[0].toFixed(3)}`);
check('the second is already quieter', burst[1] < 0.95, `x${burst[1].toFixed(3)}`);
let monotonicDuck = true;
for (let i = 1; i < burst.length; i++) if (burst[i] > burst[i - 1] + 1e-9) monotonicDuck = false;
check('and each one after that is quieter still', monotonicDuck);
check('it settles rather than fading away', burst[burst.length - 1] >= 0.25 - 1e-9,
  `x${burst[burst.length - 1].toFixed(3)} after 12 hits`);
const settledDb = 20 * Math.log10(burst[burst.length - 1]);
check('a sustained wall sits well down but stays audible', settledDb < -6 && settledDb > -18,
  `${settledDb.toFixed(1)} dB`);

audio.resetRepetition();
const slow = fire(8, 1.0); // once a second, e.g. the oxygen warning
const worstSlow = Math.min(...slow);
check('a sound fired once a second is left alone', worstSlow > 0.9, `x${worstSlow.toFixed(3)} at worst`);

audio.resetRepetition();
fire(20, 0.05);
now += 2.5; // stop firing
levels.length = 0;
audio.playSfx('repTest', 1);
check('it recovers once the firing stops', levels[0].rep > 0.95,
  `x${levels[0].rep.toFixed(3)} two and a half seconds later`);

// Keyed by sound, not by event: two events sharing one voice is exactly the
// case where the copies pile up, and separate sounds must not duck each other.
audio.resetRepetition();
CONFIG.sfx.repOther = { ...CONFIG.sfx.repTest };
levels.length = 0;
for (let i = 0; i < 8; i++) { audio.playSfx('repTest', 1); now += 0.05; }
const otherBefore = levels.length;
audio.playSfx('repOther', 1);
check('a different sound is not ducked by its neighbour',
  Math.abs(levels[otherBefore].rep - 1) < 1e-9, `x${levels[otherBefore].rep.toFixed(3)}`);

audio.resetRepetition();
CONFIG.audio.repetition.floor = 0.25;
const deep = fire(60, 0.02); // 50 a second, absurd on purpose
check('the floor holds under any rate', Math.min(...deep) >= 0.25 - 1e-9,
  `x${Math.min(...deep).toFixed(3)} at 50 a second`);

CONFIG.audio.repetition.enabled = false;
audio.resetRepetition();
const off = fire(10, 0.02);
check('switching it off restores every copy to full', off.every((r) => Math.abs(r - 1) < 1e-9));
CONFIG.audio.repetition.enabled = true;

audio.watchSfx(null);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
