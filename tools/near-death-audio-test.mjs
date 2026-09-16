#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:dyingsound
//
// THE SOUND OF NEARLY BEING DEAD — CONFIG.audio.bus.nearDeath, setNearDeathBus
// in systems/audio.js, and the one line in systems/lowHealthFx.js that drives
// it off the same strain the bloody frame is drawn from.
//
// Every way this breaks is a way you would never catch by playing, because it
// only runs in the last sliver of a health bar and the run it is wrong in is
// usually over within seconds:
//
//   STUCK OPEN       the bypass is a single early return that has to fire on
//                    the frame the strain reaches zero, not on the frames
//                    after it. Miss it and every sound for the rest of the run
//                    is warbled and drowned in reverb — which does not read as
//                    a bug, it reads as a game that has always sounded like
//                    that, on a run the player has already survived.
//   NEVER OPENS      costs nothing, shows nothing, and a silent effect looks
//                    exactly like one you have not triggered yet.
//   THE CHORUS       the warbled path summed WITH a clean one instead of
//                    replacing it. It still sounds like something — a pleasant
//                    thickening — so it passes every ear test and is the wrong
//                    effect entirely.
//   THE CLAMP        an LFO deeper than the delay's base length drives the
//                    delay time negative, where an AudioParam clamps at 0. A
//                    clamped sine is a half-wave: a rasp, not a warble.
//   THE STOMP        two writers on one crossfade. applyAudioBusSettings pushes
//                    the Sound tab's reverb mix and this pushes the strain, and
//                    whichever ran last wins — so touching any bus slider while
//                    dying would snap the reverb dry for a frame.
//   THE DRY CUT      a bus already tuned wetter than `wet` must not be DRIED
//                    by a dying seal, which is what a plain lerp would do.
//
// Same fake Web Audio API as tools/echo-test.mjs and tools/sfx-bus-test.mjs:
// ramps land instantly on their target, because what has to be asserted is
// where a parameter was told to go, not the browser's scheduling of it.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`  ok    ${msg}`);
const check = (ok, msg) => (ok ? pass(msg) : fail(msg));

class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.rampEnd = t; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
let nodeId = 0;
const baseNode = (kind, extra = {}) => ({
  kind, id: ++nodeId, outputs: [],
  connect(dest) { this.outputs.push(dest); return dest; },
  disconnect() { this.outputs.length = 0; },
  ...extra,
});
let now = 0;
class FakeCtx {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = baseNode('destination'); }
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
  createBuffer(ch, len) { return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { return baseNode('source', { buffer: null, playbackRate: new Param(1), loop: false, start() {}, stop() {} }); }
  createOscillator() { return baseNode('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() { this.started = true; }, stop() {} }); }
  async decodeAudioData() { return { duration: 1 }; }
  resume() { return Promise.resolve(); }
}
globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = () => 0;
globalThis.window.clearInterval = () => {};
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const lowHealth = await import('../path/src/systems/lowHealthFx.js');

audio.unlockAudio();
const N = audio.__busNodes();
const cfg = CONFIG.audio.bus.nearDeath;

// ---------------------------------------------------------------------------
console.log('\nTHE SPLICE');
// Walked from `master` rather than asserted by name. The claim is not "there is
// a DelayNode in the file" — it is that the whole bus goes THROUGH it, because
// a warble hung off the side of the bus is a chorus and a warble after the
// reverb split leaves the tail holding its pitch while the dry signal bends.
const reaches = (from, to, seen = new Set()) => {
  if (from === to) return true;
  if (!from || seen.has(from)) return false;
  seen.add(from);
  return (from.outputs ?? []).some((o) => reaches(o, to, seen));
};
check(reaches(N.master, N.warbleIn), 'the whole bus runs into the warble stage');
check(N.warbleIn.outputs.includes(N.warbleDry) && N.warbleIn.outputs.includes(N.warbleDelay),
  'which splits into a clean path and a delayed one');
check(reaches(N.warbleOut, N.busFilter) && reaches(N.warbleOut, N.dryGain) && reaches(N.warbleOut, N.wetGain),
  '...and both halves rejoin AHEAD of the filter and the reverb send');
check(N.warbleLfo.started && N.warbleLfo.outputs.includes(N.warbleDepth)
  && N.warbleDepth.outputs.includes(N.warbleDelay.delayTime),
  'the LFO runs from boot into the delay TIME, not into its signal');

// ---------------------------------------------------------------------------
console.log('\nBYPASSED FOR MOST OF EVERY RUN');
check(N.warbleWet.gain.value === 0 && N.warbleDry.gain.value === 1,
  'on boot the warble is an exact bypass — clean path at unity, delayed at silence');
check(N.warbleDepth.gain.value === 0, '...with the LFO at zero depth, so it contributes nothing');

const baseMix = CONFIG.audio.bus.reverbMix ?? 0;
const dryAt = (mix) => Math.cos(mix * Math.PI * 0.5);
const wetAt = (mix) => Math.sin(mix * Math.PI * 0.5);
check(Math.abs(N.wetGain.gain.value - wetAt(baseMix)) < 1e-9,
  `and the reverb sits at the Sound tab's own mix (${baseMix})`);

// ---------------------------------------------------------------------------
console.log('\nTHE WASH');
audio.setNearDeathBus(1);
check(Math.abs(N.wetGain.gain.value - wetAt(cfg.wet)) < 1e-9,
  `an empty bar lands the mix at ${cfg.wet} wet — ${N.wetGain.gain.value.toFixed(3)}`);
// THE HALF THAT MAKES IT A WASH. Wet coming up alone is a bigger room; the dry
// path coming DOWN is what leaves the tail of an already-finished sound as the
// loudest thing in the mix.
check(N.dryGain.gain.value < dryAt(baseMix) - 0.1,
  `...and takes the dry path down with it — ${dryAt(baseMix).toFixed(3)} → ${N.dryGain.gain.value.toFixed(3)}`);

check(N.warbleWet.gain.value === cfg.warbleMix && N.warbleDry.gain.value === 1 - cfg.warbleMix,
  'the clean path backs off exactly as far as the warbled one comes up');
// THE CHORUS TRAP, stated as the thing it rules out rather than as a number.
check(N.warbleDry.gain.value + N.warbleWet.gain.value <= 1 + 1e-9,
  '...so the two are a crossfade, never a doubling');
check(Math.abs(N.warbleDepth.gain.value - cfg.warbleDepthMs / 1000) < 1e-9,
  `the LFO is ${cfg.warbleDepthMs}ms deep — ${(N.warbleDepth.gain.value * 1000).toFixed(2)}ms`);
check(N.warbleLfo.frequency.value === cfg.warbleHz, `at ${cfg.warbleHz}Hz`);

// THE CLAMP. The delay's base length has to exceed the LFO's swing or the
// modulation is driven negative, where an AudioParam clamps at 0 — a half-wave,
// which rasps instead of warbling. Silent in every other way.
check(N.warbleDelay.delayTime.value > N.warbleDepth.gain.value,
  `the delay's base length outruns the swing — ${(N.warbleDelay.delayTime.value * 1000).toFixed(1)}ms base`
  + ` vs ±${(N.warbleDepth.gain.value * 1000).toFixed(1)}ms`);

// ---------------------------------------------------------------------------
console.log('\nIT ONLY EVER ADDS');
// A bus tuned wetter than the target must not be dried out by a dying seal,
// which is exactly what a plain lerp toward `wet` would do.
const wasMix = CONFIG.audio.bus.reverbMix;
CONFIG.audio.bus.reverbMix = 0.95;
audio.setNearDeathBus(1);
check(N.wetGain.gain.value >= wetAt(0.95) - 1e-9,
  `a bus already at 0.95 wet is left alone, not pulled back to ${cfg.wet}`);
CONFIG.audio.bus.reverbMix = wasMix;

// THE STOMP. Two writers on one crossfade; the Sound tab must not snap the
// reverb dry under a dying seal every time another slider moves.
audio.setNearDeathBus(1);
audio.applyAudioBusSettings();
check(Math.abs(N.wetGain.gain.value - wetAt(cfg.wet)) < 1e-9,
  'pushing the bus settings mid-wash leaves the wash where it was');

// ---------------------------------------------------------------------------
console.log('\nIT LETS GO');
audio.setNearDeathBus(0);
check(N.warbleWet.gain.value === 0 && N.warbleDry.gain.value === 1,
  'a recovered seal gets an exact bypass back');
check(N.warbleDepth.gain.value === 0, '...with the LFO back at zero depth');
check(Math.abs(N.wetGain.gain.value - wetAt(baseMix)) < 1e-9,
  `...and the reverb back at the Sound tab's mix — ${N.wetGain.gain.value.toFixed(3)}`);

// The early return is on BOTH values, so the frame the strain reaches zero
// still writes the bypass. Gated on `amount` alone it would never run at all
// and the bus would stay warbled for the rest of the run.
N.warbleWet.gain.value = 0.5; // a sentinel nothing in the code would write
audio.setNearDeathBus(0);
check(N.warbleWet.gain.value === 0.5,
  'a bypass already at rest costs nothing — the second zero writes nothing at all');
N.warbleWet.gain.value = 0; // put the sentinel back, or the next section reads it

// ---------------------------------------------------------------------------
console.log('\nTHE OFF SWITCH');
const wasEnabled = cfg.enabled;
cfg.enabled = false;
audio.setNearDeathBus(1);
check(N.warbleWet.gain.value === 0 && Math.abs(N.wetGain.gain.value - wetAt(baseMix)) < 1e-9,
  'enabled: false is silent at an empty bar');

// ...and switching it off WHILE it is open has to shut it, rather than freezing
// the bus wherever the last live frame left it. That is the shape the early
// return is most likely to get wrong, since the amount is zero either way.
cfg.enabled = true;
audio.setNearDeathBus(1);
cfg.enabled = false;
audio.setNearDeathBus(1);
check(N.warbleWet.gain.value === 0 && Math.abs(N.wetGain.gain.value - wetAt(baseMix)) < 1e-9,
  '...and switching it off mid-wash shuts the wash, not freezes it');
cfg.enabled = wasEnabled;
audio.setNearDeathBus(0);

// ---------------------------------------------------------------------------
console.log('\nDRIVEN BY THE SAME STRAIN AS THE PICTURE');
// Same strain, LATER curve — `mixCurve` sits above `rampCurve` because sound is
// the more intrusive of the two. Asserted as an ordering rather than a number,
// so tuning either curve cannot break it while the relationship holds.
{
  lowHealth.resetLowHealthFx();
  const seal20 = { hp: 0.2 * 100, stats: { maxHp: 100 } };
  for (let t = 0; t < 6; t += 1 / 60) lowHealth.updateLowHealthFx(1 / 60, seal20, true);
  const heard = audio.sfxNearDeath();
  const seen = lowHealth.lowHealthVignette();
  check(heard > 0 && heard < seen,
    `at 20% health the room is opening up behind the picture — mix ${heard.toFixed(3)} vs frame ${seen.toFixed(3)}`);
}

// The wiring, not the curve — tools/low-health-test.mjs owns the curve. What
// matters here is that nothing else has to remember to call it: the bus is
// pushed from inside the frame update the vignette already rides.
const seal = (frac) => ({ hp: frac * 100, stats: { maxHp: 100 } });
lowHealth.resetLowHealthFx();
for (let t = 0; t < 6; t += 1 / 60) lowHealth.updateLowHealthFx(1 / 60, seal(0), true);
check(audio.sfxNearDeath() > 0.99 && N.warbleWet.gain.value > 0.9,
  `an empty bar opens the wash without anything else calling it — ${audio.sfxNearDeath().toFixed(3)}`);

// ...and it walks back out on the score card, where `active` is false. A wash
// frozen open would play the game-over card under a warbled mix.
for (let t = 0; t < 6; t += 1 / 60) lowHealth.updateLowHealthFx(1 / 60, seal(0), false);
check(audio.sfxNearDeath() === 0 && N.warbleWet.gain.value === 0,
  'and lets go on the score card, with the seal still on 0hp');

// A restart clears it on the frame, rather than leaving the next run's first
// second to ease it out.
lowHealth.updateLowHealthFx(1 / 60, seal(0), true);
lowHealth.resetLowHealthFx();
check(audio.sfxNearDeath() === 0, 'a restart drops the wash on the frame, not over the next second');

console.log(`\n${failures === 0 ? 'near-death mix: all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
