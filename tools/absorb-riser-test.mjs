#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:vacuum
//
// THE RISER UNDER A CHUNK BEING DRAWN IN — systems/absorbRiser.js, driven
// through the real absorb (systems/pickupAbsorb.js) and the real goo
// (systems/gooSuck.js).
//
// Every claim here is about a sound, which is exactly why it needs a test:
// nothing below is visible in a frame, and the failures are all the kind that
// sound like a deliberate choice.
//
//   AIMED AT THE FLIGHT   the sweep is scheduled across hold + ramp + travel,
//                         the numbers the goo is actually flying on. A riser
//                         with a typed decay in it peaks a quarter-second
//                         before or after the goo lands, which says the payout
//                         arrived when it has not.
//   THE PEAK IS THE SEAL  loudest at the arrival, and the FIRST PIECE moves it
//                         there — early or late. The estimate only decides how
//                         much of the climb is heard.
//   IT GETS OUT OF THE WAY  the settle runs across the stagger and the last
//                         piece takes it away, so the pip ladder resolves over
//                         a wash rather than through a riser still climbing.
//   IT ALWAYS ENDS        a burst nobody ever pays out of still resolves on
//                         its own schedule. These are LOOPING sources: a voice
//                         that is never told the bunch is over is not a glitch,
//                         it is a sound that never stops.
//   IT CANNOT EAT A HEAL  every path that silences the riser — the faders down,
//                         the switch off, a context that never woke up — still
//                         pays the payout, whole.
//
// The fake Web Audio API is the one tools/charge-sound-test.mjs and
// tools/sfx-bus-test.mjs use: ramps land instantly on their target, because
// scheduling is the browser's job and what this has to know is WHERE a param
// was told to go and WHEN.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const dt = 1 / 60;

// --- the fake Web Audio API -------------------------------------------------
class Param {
  constructor(v = 0) { this.value = v; this.ramps = []; this.sets = []; }
  setValueAtTime(v, t) { this.value = v; this.sets.push([v, t]); return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.ramps.push([v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.ramps.push([v, t]); return this; }
  cancelScheduledValues() { this.cancels = (this.cancels ?? 0) + 1; return this; }
}
let nodeId = 0;
const built = [];
const baseNode = (kind, extra = {}) => {
  const n = {
    kind, id: ++nodeId, outputs: [],
    connect(dest) { this.outputs.push(dest); return dest; },
    disconnect() { this.outputs.length = 0; },
    ...extra,
  };
  built.push(n);
  return n;
};
let now = 0;
class FakeCtx {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = baseNode('destination'); }
  // MONOTONIC, ALWAYS. Voices retire against ctx.currentTime, and a clock that
  // rewinds between cases fakes a graph that has already finished.
  get currentTime() { return now; }
  createGain() { return baseNode('gain', { gain: new Param(1) }); }
  createDelay(max) { return baseNode('delay', { maxDelayTime: max, delayTime: new Param(0) }); }
  createBiquadFilter() { return baseNode('biquad', { type: 'lowpass', frequency: new Param(20000), Q: new Param(1) }); }
  createConvolver() { return baseNode('convolver', { buffer: null }); }
  createWaveShaper() { return baseNode('waveshaper', { curve: null, oversample: 'none' }); }
  createDynamicsCompressor() {
    return baseNode('compressor', {
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25), reduction: 0,
    });
  }
  createBuffer(ch, len) {
    return {
      numberOfChannels: ch, length: len, sampleRate: 48000,
      getChannelData: () => new Float32Array(len),
    };
  }
  createBufferSource() {
    return baseNode('source', {
      buffer: null, playbackRate: new Param(1), loop: false,
      startedAt: null, stops: [],
      start(t) { this.startedAt = t; },
      // RECORDED, and every call kept. The spec says the last stop() wins, and
      // the arrival moving the peak has to move the backstop with it — a source
      // still cut off at the estimate would silence the settle and leave the
      // ladder running over nothing.
      stop(t) { this.stops.push(t); },
    });
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
console.warn = () => {};

const THREE = await import('three');
const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const { initParticles, resetParticles } = await import('../path/src/entities/particles.js');
const {
  updateGooSuck, setGooSuckTarget, resetGooSuck, gooSuckBlobs,
} = await import('../path/src/systems/gooSuck.js');
const { absorbInPieces, absorbApproach } = await import('../path/src/systems/pickupAbsorb.js');
const riser = await import('../path/src/systems/absorbRiser.js');

audio.unlockAudio();
initParticles(new THREE.Scene());
CONFIG.fx.gooSuck.enabled = true;

const R = () => CONFIG.pickups.absorb.riser;
const A = () => CONFIG.pickups.absorb;
// The bank's own nodes, told apart from the rest of the mix by being the only
// looping buffer sources in the graph.
const sourcesOf = () => built.filter((n) => n.kind === 'source' && n.loop);
const bandsOf = () => built.filter((n) => n.kind === 'biquad' && n.type === 'bandpass');
const clear = () => { built.length = 0; };
// THE BANK'S SHARED ENVELOPE, found by walking the graph rather than by
// grabbing the last gain built: the swallow's own one-shot is built in the same
// breath and is also a gain, and a test that picks the wrong node reads a
// perfectly flat envelope and calls it a failure of the riser.
//   source -> bandpass -> fader -> ENVELOPE -> the bus
const envelopeOf = () => sourcesOf()[0]?.outputs[0]?.outputs[0]?.outputs[0];

/** Start an absorption and hand back the pieces, the payments and the key. */
function startAbsorb(opts = {}) {
  resetGooSuck();
  resetParticles();
  riser.resetAbsorbRisers();
  setGooSuckTarget(0, 0);
  clear();
  const paid = [];
  const frames = [];
  let f = 0;
  absorbInPieces('chumChunkEaten',
    { x: opts.x ?? 9, y: opts.y ?? 0, scale: opts.scale ?? 1.5, pieces: opts.pieces, tune: opts.tune },
    (share) => { paid.push(share); frames.push(f); });
  return {
    paid, frames,
    pieces: gooSuckBlobs().length,
    // The live key, read off the module rather than guessed: the bunch id is
    // private and this is a test of the sound, not of the counter.
    run(limitFrames = 60 * 12) {
      for (; f < limitFrames && gooSuckBlobs().length; f++) { now += dt; updateGooSuck(dt); }
      return this;
    },
  };
}

// The only live voice's span. Every case here raises one at a time, and asking
// the module rather than tracking the key is what keeps the bunch id private.
function liveSpan() {
  for (let k = 1; k < 4000; k++) {
    const s = riser.absorbRiserSpan(k);
    if (s) return { key: k, ...s };
  }
  return null;
}

// ---------------------------------------------------------------------------
section('A CHUNK RAISES A VACUUM');
{
  const r = startAbsorb();
  const v = liveSpan();
  check('a riser is sounding under the haul', riser.absorbRiserCount() === 1, `${riser.absorbRiserCount()}`);
  check('...one band per fader up', v?.bands === R().bands.filter((b) => (b.level ?? 0) > 0).length,
    `${v?.bands} bands`);
  check('...all of them resonant bandpasses', bandsOf().length === v?.bands
    && bandsOf().every((b) => b.Q.value > 0), `${bandsOf().length}`);
  // NO TONE. The ladder this settles under is pitched; a riser with a
  // fundamental in it is a second melody underneath a run trying to resolve.
  //
  // Asserted on what feeds the BANDS rather than on the graph as a whole: the
  // swallow's own one-shot is a synth blip built in the same breath, and it is
  // supposed to be pitched.
  check('...fed by looping noise and nothing else',
    sourcesOf().length === v?.bands
    && sourcesOf().every((s) => s.outputs.some((o) => o.type === 'bandpass')),
    `${sourcesOf().length} looping sources`);
  check('...with no oscillator anywhere in the bank',
    built.filter((n) => n.kind === 'osc' && n.outputs.some((o) => o.type === 'bandpass')).length === 0);
  check('the goo it is scoring is really in the water', r.pieces > 4, `${r.pieces} pieces`);
}

// ---------------------------------------------------------------------------
section('AIMED AT THE FLIGHT, not at a typed decay');
{
  const v = liveSpan();
  const c = A();
  const want = absorbApproach(c);
  check('the sweep spans the flight', near(v?.dur ?? -1, want, 1e-9),
    `${v?.dur.toFixed(3)}s vs hold+ramp+travel ${want.toFixed(3)}s`);
  check('...which is those three numbers and nothing else',
    near(want, (CONFIG.fx.gooSuck.holdAt) + (CONFIG.fx.gooSuck.rampTime) + R().travel, 1e-9),
    `${CONFIG.fx.gooSuck.holdAt} + ${CONFIG.fx.gooSuck.rampTime} + ${R().travel}`);
  check('...and the settle spans the stagger', near(v?.span ?? -1, c.stagger, 1e-9),
    `${v?.span}s vs ${c.stagger}s`);
  // The one that would be invisible: retune the pull and a riser reading a
  // constant would keep peaking at the old moment.
  const wasHold = CONFIG.fx.gooSuck.holdAt;
  CONFIG.fx.gooSuck.holdAt = wasHold + 0.5;
  startAbsorb();
  check('...so a slower pull gets a longer riser', near(liveSpan()?.dur ?? -1, want + 0.5, 1e-9),
    `${liveSpan()?.dur.toFixed(3)}s`);
  CONFIG.fx.gooSuck.holdAt = wasHold;
}

// ---------------------------------------------------------------------------
section('THE PEAK IS THE SEAL');
{
  startAbsorb();
  const v = liveSpan();
  // The envelope is scheduled up front, so its shape can be read off the ramps
  // the shared gain was given: attack, arrival, settle, gone.
  const env = envelopeOf()?.gain;
  const ramps = env?.ramps ?? [];
  check('the envelope is a shape and not a level', ramps.length >= 4, `${ramps.length} points`);
  const loudest = ramps.reduce((a, b) => (b[0] > a[0] ? b : a), ramps[0] ?? [0, 0]);
  check('...whose loudest moment is the arrival', near(loudest[1] - v.startedAt, v.dur, 1e-6),
    `peak at ${(loudest[1] - v.startedAt).toFixed(3)}s of a ${v.dur.toFixed(3)}s flight`);
  check('...and that peak is the swell over the attack',
    near(loudest[0], v.top, 1e-9) && v.top > 0, `${loudest[0].toFixed(4)}`);
  const settle = ramps.find(([, t]) => near(t - v.startedAt, v.dur + v.span, 1e-6));
  check('...then it settles under the ladder', !!settle && settle[0] < loudest[0],
    settle ? `${(settle[0] / loudest[0] * 100).toFixed(0)}% of the peak` : 'no settle scheduled');
  check('...to the wash the tuner asked for', near(settle?.[0] ?? -1, v.top * v.tail, 1e-9),
    `tail ${v.tail}`);
}

// ---------------------------------------------------------------------------
section('THE FIRST PIECE MOVES IT — the estimate is only a guess');
{
  // LATE. The flight really takes longer than hold + ramp + travel, which is
  // the common case the moment the seal swims away from its own splat.
  startAbsorb();
  const v = liveSpan();
  const env = envelopeOf();
  const before = env.gain.ramps.length;
  const srcs = sourcesOf();
  const lastStop = Math.max(...srcs.map((s) => s.stops[s.stops.length - 1]));
  now += v.dur + 0.4; // the goo is late
  riser.arriveAbsorbRiser(v.key, A().stagger);
  const after = liveSpan();
  check('a late arrival still peaks at the seal', after?.arrivedAt != null
    && near(after.arrivedAt, now, 1e-9), `${after?.arrivedAt?.toFixed(3)} vs ${now.toFixed(3)}`);
  const fresh = env.gain.ramps.slice(before);
  check('...by re-aiming the envelope from where it had got to',
    env.gain.cancels > 0 && fresh.length >= 3 && near(fresh[0][0], v.top, 1e-9),
    `${fresh.length} new points`);
  check('...climbing rather than jumping', near(fresh[0][1] - now, R().snap ?? 0.035, 1e-9),
    `over ${(fresh[0][1] - now).toFixed(3)}s`);
  const moved = Math.max(...sourcesOf().map((s) => s.stops[s.stops.length - 1]));
  check('...and the sources are held past it', moved > lastStop + 0.3,
    `stop moved ${(moved - lastStop).toFixed(2)}s`);
  // ONCE. Every piece after the first lands inside the settle, and re-peaking
  // on each of them would pump the wash in time with the ladder.
  const points = env.gain.ramps.length;
  check('a second piece does not re-peak it', riser.arriveAbsorbRiser(v.key, 0.5) === false
    && env.gain.ramps.length === points);
}
{
  // EARLY. The guess was long and the goo is already home.
  startAbsorb();
  const v = liveSpan();
  const env = envelopeOf();
  now += v.dur * 0.3;
  const live = env.gain.value;
  riser.arriveAbsorbRiser(v.key, A().stagger);
  const held = env.gain.sets[env.gain.sets.length - 1];
  check('an early arrival takes the peak with it', near(liveSpan()?.arrivedAt ?? -1, now, 1e-9),
    `${(now - v.startedAt).toFixed(3)}s into a ${v.dur.toFixed(3)}s guess`);
  check('...starting from what is actually sounding', near(held?.[0] ?? -1, live, 1e-9),
    `held ${held?.[0]}`);
}

// ---------------------------------------------------------------------------
section('DRIVEN BY THE REAL GOO');
{
  const r = startAbsorb().run();
  check('every piece was paid', r.paid.length === r.pieces, `${r.paid.length} of ${r.pieces}`);
  check('...and the whole payout landed', near(r.paid.reduce((a, b) => a + b, 0), 1, 1e-9));
  check('the last piece takes the vacuum away', riser.absorbRiserCount() === 0,
    `${riser.absorbRiserCount()} still sounding`);
}

// ---------------------------------------------------------------------------
section('IT ALWAYS ENDS — a burst nobody pays out of still resolves');
{
  // The seal is nowhere near and never comes: every blob melts unclaimed. The
  // payload is still paid (that is systems/gooSuck.js's promise), but nothing
  // ever calls the arrival — so the riser has to resolve on the schedule it was
  // given, and its LOOPING sources have to be stopped by it.
  resetGooSuck();
  resetParticles();
  riser.resetAbsorbRisers();
  clear();
  setGooSuckTarget(4000, 4000);
  const paid = [];
  absorbInPieces('chumChunkEaten', { x: 0, y: 0, scale: 1.5 }, (share) => paid.push(share));
  const v = liveSpan();
  const env = envelopeOf();
  const last = env.gain.ramps[env.gain.ramps.length - 1];
  check('the envelope reaches silence on its own', near(last?.[0] ?? -1, 0),
    `ends at ${last?.[0]}`);
  check('...on the schedule it was given',
    near(last?.[1] - v.startedAt, v.dur + v.span + (R().fadeOut ?? 0.14), 1e-9),
    `${(last?.[1] - v.startedAt).toFixed(3)}s`);
  check('...and every looping source is stopped with it',
    sourcesOf().length > 0 && sourcesOf().every((s) => s.stops.length && s.stops[0] > last[1]),
    `${sourcesOf().length} sources`);
  for (let f = 0; f < 60 * 30 && gooSuckBlobs().length; f++) { now += dt; updateGooSuck(dt); }
  check('...and the payout still landed, whole',
    paid.length > 0 && near(paid.reduce((a, b) => a + b, 0), 1, 1e-9),
    `${paid.length} pieces`);
}

// ---------------------------------------------------------------------------
section('TWO CHUNKS AT ONCE ARE TWO VACUUMS');
{
  resetGooSuck();
  resetParticles();
  riser.resetAbsorbRisers();
  setGooSuckTarget(0, 0);
  absorbInPieces('chumChunkEaten', { x: 9, y: 0, scale: 1.5 }, () => {});
  const first = liveSpan();
  absorbInPieces('chumChunkEaten', { x: -9, y: 0, scale: 1.5 }, () => {});
  check('both are sounding', riser.absorbRiserCount() === 2, `${riser.absorbRiserCount()}`);
  riser.stopAbsorbRiser(first.key);
  check('...and the first one ending leaves the second alone',
    riser.absorbRiserCount() === 1 && !riser.absorbRiserSpan(first.key));
  // A run ending drops the goo's payloads unpaid (resetGooSuck), so nothing
  // will ever report the bunch over. This is the only thing that ends it.
  riser.resetAbsorbRisers();
  check('a run reset takes every one of them down', riser.absorbRiserCount() === 0);
}

// ---------------------------------------------------------------------------
section('THE ORB DOES NOT GET ONE');
{
  // A quarter-second re-arm has no flight to hear closing: attack, arrival and
  // settle inside it is a blur across the pips it should be getting out of the
  // way of.
  check('the orb overlay says so', A().orb?.riser?.enabled === false);
  const r = startAbsorb({ pieces: 5, tune: A().orb });
  check('...so nothing is raised over it', riser.absorbRiserCount() === 0,
    `${riser.absorbRiserCount()}`);
  r.run();
  check('...and its pips still land, whole',
    near(r.paid.reduce((a, b) => a + b, 0), 1, 1e-9), `${r.paid.length} pips`);

  // AND AN OVERLAY IS KEY BY KEY, like the block around it. A pickup that says
  // only `{ gain: … }` keeps the bank, the sweep and the envelope — the outer
  // spread replaces the riser wholesale, and a bank that came back empty is a
  // silence that looks like a level.
  startAbsorb({ tune: { ...A().orb, riser: { gain: 0.02 } } });
  const part = liveSpan();
  check('a partial riser overlay keeps the bank',
    part?.bands === R().bands.filter((b) => (b.level ?? 0) > 0).length,
    `${part?.bands} bands`);
  check('...and only moves what it named',
    part != null && part.top < 0.06 && near(part.tail, R().tail, 1e-9),
    `peak ${part?.top?.toFixed(4)}, tail ${part?.tail}`);
  // ...including the flight it is scheduled across, which lives outside the
  // riser block: the orb's own hold and ramp still decide it.
  check('...on the orb\'s own flight, not the chunk\'s',
    near(part?.dur ?? -1, absorbApproach({ ...A(), ...A().orb, riser: { ...R(), gain: 0.02 } }), 1e-9),
    `${part?.dur?.toFixed(3)}s`);
}

// ---------------------------------------------------------------------------
section('IT CANNOT EAT A HEAL');
{
  const wasEnabled = R().enabled;
  R().enabled = false;
  const off = startAbsorb().run();
  check('switched off, nothing sounds', riser.absorbRiserCount() === 0);
  check('...and the chunk still pays', near(off.paid.reduce((a, b) => a + b, 0), 1, 1e-9),
    `${off.paid.length} pieces`);
  R().enabled = wasEnabled;

  const wasBands = R().bands;
  R().bands = wasBands.map((b) => ({ ...b, level: 0 }));
  const quiet = startAbsorb().run();
  check('every fader down is a deliberate silence', riser.absorbRiserCount() === 0);
  check('...and it is still a silence that pays',
    near(quiet.paid.reduce((a, b) => a + b, 0), 1, 1e-9), `${quiet.paid.length} pieces`);
  R().bands = wasBands;

  const on = startAbsorb().run();
  check('and it comes back when the faders do',
    near(on.paid.reduce((a, b) => a + b, 0), 1, 1e-9) && on.paid.length > 4);
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
