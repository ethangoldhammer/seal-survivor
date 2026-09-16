#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:titlebed
//
// systems/splashBed.js — the one loop under the splash — driven against a fake
// Web Audio API on a clock this script advances by hand. Same approach as
// tools/ambient-test.mjs and for the same reason: everything worth checking here
// is about WHAT WAS SCHEDULED, and a screenshot of a bed is a black rectangle.
//
// What it checks, in rough order of what would actually hurt:
//
//   SILENT BY DEFAULT   the shipped config has no clips in it, and that path
//                       must build nothing, unlock nothing and start nothing.
//                       A bed that quietly created an AudioContext on every
//                       cold load to then play silence is a resource nobody
//                       asked for on the one screen that has to boot fast.
//   THE SUSPENDED CLOCK the whole reason this can start at MOUNT rather than on
//                       a press. A suspended context's clock does not advance,
//                       so a fade scheduled against it must still be entirely
//                       in front of `currentTime` — if it were scheduled against
//                       wall time it would have silently expired by the time the
//                       player's first tap woke the context, and the bed would
//                       arrive at full level with no fade at all. Nothing in the
//                       browser warns about this; it just sounds like a cut.
//   IT CREEPS IN        the fade-in is convex (t²), not linear and not the
//                       equal-power curve the ambient bed crossfades on. A
//                       linear amplitude ramp is most of the way to full
//                       loudness in its first third, which is a bed you hear
//                       arrive — the one thing a bed must not do.
//   VOLUME SPLIT        the level and the fade live on different gains, so the
//                       Sound tab's slider can move while the fade-in is still
//                       running. Both on one node is a setTargetAtTime landing
//                       inside a scheduled value curve, which tears it.
//   STOP MID-FADE       leaving the splash two seconds into a 2.6s fade-in is
//                       the COMMON case, not a corner. cancelScheduledValues
//                       alone does not stop a running curve, so the fade-out
//                       would be measured from wherever that curve finished and
//                       the bed would jump up before going down.
//   NO ROTATION         this is the property that makes it a different system
//                       from systems/ambient.js. However long the card is up,
//                       one source is started and never replaced.
//   MISSING FILE        a clip that 404s is dropped with a warning and the
//                       splash carries on silent rather than throwing on the
//                       first screen of the game.
//
// What it cannot tell you: whether the bed sounds good, or whether 2.6 seconds
// is the right fade. Those are ears.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- the fake graph --------------------------------------------------------
// Records every automation rather than producing samples. `now` is moved by the
// test, so a fade costs no wall time.

let now = 0;

class Param {
  constructor(value = 0) { this.value = value; this.calls = []; this.curves = []; }
  setValueAtTime(v, t) { this.calls.push(['setValueAtTime', v, t]); this.value = v; return this; }
  setTargetAtTime(v, t, c) { this.calls.push(['setTargetAtTime', v, t, c]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.calls.push(['linearRamp', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['expRamp', v, t]); this.value = v; return this; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
  // Modelled because the difference is the bug: unlike cancelScheduledValues,
  // this one stops a curve that is already RUNNING.
  cancelAndHoldAtTime(t) {
    this.calls.push(['cancelAndHold', t]);
    this.curves = this.curves.filter((c) => c.end <= t);
    return this;
  }
  setValueCurveAtTime(curve, t, dur) {
    // The real API throws when a curve overlaps one already scheduled.
    for (const prev of this.curves) {
      if (t < prev.end && t + dur > prev.start) {
        throw new Error(`overlapping setValueCurveAtTime at ${t.toFixed(2)}`);
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

const started = [];

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

let fakeCtx = null;
const ctxGains = () => fakeCtx?.gains ?? [];

class FakeCtx {
  constructor() {
    fakeCtx = this;
    this.sampleRate = 48000;
    // SUSPENDED, which is what a real browser hands back on a page nobody has
    // pressed anything on — i.e. the splash. Flipped to 'running' near the
    // bottom of this file to check the state readout follows it.
    this.state = 'suspended';
    this.destination = node();
    this.gains = [];
  }
  get currentTime() { return now; }
  createGain() { const g = node({ gain: new Param(1) }); this.gains.push(g); return g; }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: new Param(20000), Q: new Param(1), detune: new Param(0) });
  }
  createConvolver() { return node({ buffer: null }); }
  // The bus builds all of these before anything can attach to it, and
  // unlockAudio swallows a throw — a missing factory here leaves audio silently
  // locked and every check below failing for a reason unrelated to the bed.
  createDelay(max) { return node({ maxDelayTime: max, delayTime: new Param(0) }); }
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
  // The bus's celebration echo and the synth voices. A missing factory here is
  // swallowed by unlockAudio's try/catch and leaves `unlocked` false with HALF A
  // BUS wired — so every later unlockAudio() builds ANOTHER context, and the
  // gains this file is inspecting end up on one instance while the module under
  // test holds a different one. Nothing says so; the checks simply find no
  // curves anywhere. Cost an hour once.
  createOscillator() { return node({ type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} }); }
  createStereoPanner() { return node({ pan: new Param(0) }); }
  createPanner() { return node({ positionX: new Param(0), positionY: new Param(0), positionZ: new Param(0) }); }
  // Tagged with the URL it came from, so a check can ask which clip a source is
  // playing rather than inferring it.
  async decodeAudioData(bytes) {
    const src = bytes?.src ?? null;
    return { duration: 8, length: 8 * this.sampleRate, sampleRate: this.sampleRate, src };
  }
  resume() { return Promise.resolve(); }
}

globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = () => 1;
globalThis.window.clearInterval = () => {};

let servable = new Set();
globalThis.fetch = async (url) => {
  if (!servable.has(url)) return { ok: false, status: 404 };
  return { ok: true, status: 200, arrayBuffer: async () => ({ src: url, byteLength: 64 }) };
};

// unlockAudio also kicks off preloadSamples, which tries to fetch every sample
// in the real tuning file and warns on each 404. Collected rather than printed:
// the noise would bury the results, and one check below is that a SPECIFIC
// warning was produced.
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
const bed = await import('../path/src/systems/splashBed.js');

// ---------------------------------------------------------------------------
section('The shipped state: no clips');
{
  // Exactly what config.js ships, read off it rather than retyped — the point
  // of this section is that the DEFAULT does nothing, so inventing a default
  // here would test the wrong object.
  const shipped = (CONFIG.splashBed?.srcs ?? []).filter(Boolean);
  check('config.js ships the bed empty', shipped.length === 0, `${shipped.length} clips`);

  bed.startSplashBed();
  check('no context was built', fakeCtx === null);
  check('nothing is playing', started.length === 0);
  check('and the state says so', bed.splashBedState().started === false);
  // Called on every route out of the splash, including the ones that never
  // started a bed.
  bed.stopSplashBed();
  check('stopping an unstarted bed is harmless', true);
}

// ---------------------------------------------------------------------------
section('One clip, on a suspended context');

const CLIP = '/sfx/title-bed.mp3';
servable = new Set([CLIP]);
CONFIG.splashBed = {
  enabled: true,
  volume: 0.3,
  srcs: [CLIP, null, null, null],
  slots: 4,
  fadeIn: 2.6,
  fadeOut: 0.9,
  pitchVary: 0,
};

bed.startSplashBed();
await bed.preloadSplashBed();

let state = bed.splashBedState();
check('the clip decoded', state.loaded === 1, `${state.loaded}/1`);
check('a source is playing', !!state.playing, state.playing ?? 'none');
check('it loops, so it fills however long the card is up', started[0]?.loop === true);
check('exactly one source was started', started.length === 1, `${started.length}`);

// THE SUSPENDED-CLOCK PROPERTY. On a context nobody has woken, currentTime is
// frozen — so everything scheduled must still be in front of it. If the fade
// were scheduled against wall time it would have run out before the player's
// first tap and the bed would arrive at full level.
check('the context is suspended, as it is on a real splash', state.suspended === true);
const fade = ctxGains().map((g) => g.gain.curves.at(-1)).find(Boolean);
check('the fade-in is still entirely ahead of the frozen clock',
  !!fade && fade.start >= now && fade.end > now, fade ? `${fade.start}..${fade.end} vs now ${now}` : 'no curve');
check('and the source starts at or after it', started[0]?.startedAt >= now, `${started[0]?.startedAt}`);

// ---------------------------------------------------------------------------
section('It creeps in rather than arriving');
{
  check('the fade runs for the configured time', !!fade && Math.abs(fade.dur - 2.6) < 1e-6, `${fade?.dur}s`);
  check('from silence to full', !!fade && fade.curve[0] === 0 && Math.abs(fade.curve.at(-1) - 1) < 1e-6);
  // The shape, stated as the thing it has to beat. A LINEAR ramp is 0.5 at the
  // halfway point and a cos/sin equal-power one is 0.707 — both are audibly
  // "there" a third of the way in. t² is 0.25.
  const mid = fade ? fade.curve[Math.floor(fade.curve.length / 2)] : null;
  check('half way through the fade it is well under half level',
    mid != null && mid < 0.35, mid == null ? 'no curve' : `${mid.toFixed(3)} (linear would be 0.500)`);
  // Convex all the way, not just at the midpoint: every step is at least as big
  // as the one before it. A curve that is steep early and flat late would pass
  // the midpoint check and still announce itself.
  let convex = true;
  if (fade) {
    for (let i = 2; i < fade.curve.length; i++) {
      if (fade.curve[i] - fade.curve[i - 1] < fade.curve[i - 1] - fade.curve[i - 2] - 1e-9) convex = false;
    }
  }
  check('and it never slows down on the way up', convex);
}

// ---------------------------------------------------------------------------
section('The level and the fade are separate nodes');
{
  // The fade gain is the only one carrying a value CURVE; the volume gain is
  // the only one that was ever written the configured level. That is how this
  // asks the question without reaching inside the module.
  const curved = ctxGains().filter((g) => g.gain.curves.length);
  check('exactly one gain carries the fade', curved.length === 1, `${curved.length}`);

  const levelled = ctxGains().filter((g) => g.gain.calls.some(
    ([kind, v]) => kind === 'setTargetAtTime' && Math.abs(v - 0.3) < 1e-9,
  ));
  check('exactly one gain carries the volume', levelled.length === 1, `${levelled.length}`);
  check('and they are not the same node', curved[0] !== levelled[0]);

  // The slider mid-fade, which is the whole reason for the split. A throw here
  // is the failure — the fake Param models the overlap rule the real API has.
  CONFIG.splashBed.volume = 0.55;
  let threw = null;
  try { bed.applySplashBedSettings(); } catch (err) { threw = err; }
  check('the volume can be dragged while the fade is running', !threw, threw?.message ?? '');
  CONFIG.splashBed.volume = 0.3;
  bed.applySplashBedSettings();
}

// ---------------------------------------------------------------------------
section('No rotation, however long the card is up');
{
  // A minute is several times any hold in the ambient bed's config, and many
  // times the life of a real splash. Nothing may swap under it.
  now += 60;
  check('still one source after a minute', started.length === 1, `${started.length}`);
  check('and still the same clip', bed.splashBedState().playing === CLIP);

  // Starting again is what the Sound tab's Play button and a second mount would
  // do. It must not stack a second loop on the first.
  bed.startSplashBed();
  check('starting an already-running bed stacks nothing', started.length === 1, `${started.length}`);
}

// ---------------------------------------------------------------------------
section('Leaving the splash mid-fade');
{
  // Rewound to two seconds into the 2.6s fade-in, which is what pressing Start
  // straight away actually does. The curve is still running at this point.
  now = 2;
  const fadeGain = ctxGains().find((g) => g.gain.curves.length);
  const before = fadeGain.gain.calls.length;
  bed.stopSplashBed();
  const after = fadeGain.gain.calls.slice(before);

  check('the running fade-in is stopped dead, not just cancelled ahead',
    after.some(([kind]) => kind === 'cancelAndHold'),
    after.map(([k]) => k).join(', '));
  const ramp = after.find(([kind]) => kind === 'linearRamp');
  check('it ramps to silence', !!ramp && ramp[1] === 0);
  check('over the configured fade out', !!ramp && Math.abs(ramp[2] - (now + 0.9)) < 1e-6, `${ramp?.[2]} vs ${now + 0.9}`);
  check('and the source is stopped after the ramp lands, not on it',
    started[0].stoppedAt > now + 0.9, `${started[0].stoppedAt} vs ${now + 0.9}`);
  check('the state reports it stopped', bed.splashBedState().started === false);
  // Still audible until the ramp finishes — what `sounding` is for, and what
  // tells "faded out" apart from "torn down".
  check('but it is still sounding while the fade runs', bed.splashBedState().sounding === true);
  now += 1.2;
  check('and silent once it has landed', bed.splashBedState().sounding === false);
}

// ---------------------------------------------------------------------------
section('The context waking up');
{
  fakeCtx.state = 'running';
  check('the state readout follows it', bed.splashBedState().suspended === false);
}

// ---------------------------------------------------------------------------
section('A clip that is not there');
{
  const MISSING = '/sfx/gone.mp3';
  bed.resetSplashBed();
  bed.clearSplashBedClip(CLIP);
  CONFIG.splashBed.srcs = [MISSING, null, null, null];
  warnings.length = 0;
  await bed.reloadSplashBed();

  check('it is not in the bank', bed.hasSplashBedClip(MISSING) === false);
  check('and it said so', warnings.some((w) => w.includes('[splashBed]') && w.includes(MISSING)),
    warnings.filter((w) => w.includes('[splashBed]')).join(' | ') || 'no warning');

  const wasStarted = started.length;
  let threw = null;
  try { bed.startSplashBed(); } catch (err) { threw = err; }
  check('starting does not throw on the first screen of the game', !threw, threw?.message ?? '');
  check('and nothing new was played', started.length === wasStarted, `${started.length - wasStarted} new`);
}

// ---------------------------------------------------------------------------
section('Switched off');
{
  bed.resetSplashBed();
  CONFIG.splashBed.srcs = [CLIP, null, null, null];
  await bed.reloadSplashBed();
  CONFIG.splashBed.enabled = false;
  const wasStarted = started.length;
  bed.startSplashBed();
  check('enabled:false starts nothing', started.length === wasStarted, `${started.length - wasStarted} new`);
  CONFIG.splashBed.enabled = true;
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
