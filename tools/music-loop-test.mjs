#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:music
//
// The loop player's transport, against a fake Web Audio API with a hand-cranked
// clock. Everything here is a property you cannot see in a screenshot and cannot
// hear as a bug — only as "the music sounds a bit wrong when it changes" — which
// is exactly why it is asserted as arithmetic.
//
//   BOUNDARY    a track switch lands where the PLAYING FILE ends, not on a beat
//               count derived from the BPM. The two only agree if every file is
//               exactly `beatsPerLoop` long; an mp3 that is a tenth of a second
//               off pushes every switch a little further into the next loop
//               than the last one did, until they land mid-bar.
//   DILATION    that wait is counted in the TRACK's time, not the room's. A
//               loop dragged to half speed by the death dive takes twice as
//               long in the room and is still one loop, so a boundary predicted
//               in wall seconds cuts it in half.
//   PHASE       the beat grid is score time too, so a rate change stretches the
//               beat instead of rewriting how many have already gone by. The
//               old wall-clock phase jumped by ten beats on the frame the death
//               dive started, and everything marching to the music twitched.
//   RATE MODEL  the transport's idea of the rate has to match the AudioParam
//               actually driving the source through a glide, or the score clock
//               integrates a speed the loop is not playing at.
//   DEATH       dying does not stop the track. It drags down with the dive and
//               winds back up to pitch under the score card, still playing.
//   BOSS        a fight takes the transport on the next BAR — a boundary short
//               enough to land inside the arrival ceremony and musical enough
//               not to chop the run's loop mid-phrase. It gives it back under
//               the kill's silence, where a switch costs nothing, which is also
//               what makes the reverb tail out of boss music rather than out of
//               whatever replaced it.
//   PADDING     an mp3 decodes with silence on the front, so the first sample
//               of a buffer is not the downbeat. Left in, a switch quantised to
//               a bar still lands a flam late — and every file in the library
//               carries 20–36ms of it.
//
// Run: node --import ./tools/vite-loader.mjs tools/music-loop-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --- the fake graph --------------------------------------------------------
// The clock is manual: the whole point is to run minutes of music in no wall
// time at all.
let now = 0;

// A real-enough AudioParam. setTargetAtTime is modelled properly rather than
// snapped, because the thing under test is whether music.js's own copy of the
// rate matches what the audio thread is doing halfway through a drag — and a
// Param that jumps straight to its target would agree with any model at all.
class Param {
  constructor(v = 0) { this.base = v; this.events = []; }
  get value() { return this.at(now); }
  set value(v) { this.base = v; this.events.length = 0; }
  setValueAtTime(v, t) { this.events.push({ kind: 'set', v, t }); return this; }
  setTargetAtTime(v, t, tau) { this.events.push({ kind: 'target', v, t, tau }); return this; }
  exponentialRampToValueAtTime(v, t) { this.events.push({ kind: 'set', v, t }); return this; }
  // Modelled rather than snapped, like setTargetAtTime above and for the same
  // reason: the boss-kill hush IS a pair of linear ramps, and a Param that
  // jumped to the target would report the score already silent on the frame the
  // cut began — which is the one thing the cut must not be.
  linearRampToValueAtTime(v, t) { this.events.push({ kind: 'ramp', v, t }); return this; }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e.t < t); return this; }
  at(t) {
    const evs = [...this.events].sort((a, b) => a.t - b.t);
    let v = this.base;
    // Where the last event left the value, which is what a linear ramp
    // interpolates FROM.
    let prevT = evs.length ? evs[0].t : 0;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.kind === 'ramp') {
        if (t >= e.t) { v = e.v; prevT = e.t; continue; }
        const span = Math.max(1e-9, e.t - prevT);
        return v + (e.v - v) * Math.max(0, Math.min(1, (t - prevT) / span));
      }
      if (e.t > t) break;
      // A target curve runs until the next event or until `t`, whichever first.
      const end = Math.min(t, evs[i + 1] ? evs[i + 1].t : t);
      if (e.kind === 'set') v = e.v;
      else v = e.v + (v - e.v) * Math.exp(-(end - e.t) / Math.max(1e-6, e.tau));
      prevT = e.t;
    }
    return v;
  }
}

let nodeId = 0;
const baseNode = (kind, extra = {}) => ({
  kind,
  id: ++nodeId,
  outputs: [],
  connect(dest) { this.outputs.push(dest); return dest; },
  disconnect() { this.outputs.length = 0; },
  ...extra,
});

// Every source node started on the fake context, in order. The death section
// runs the real feedback system, which fires sound effects on the same context,
// so the boundary assertions read `loops()` — only the nodes playing a decoded
// music buffer.
const sources = [];
const decoded = new Set();
const loops = () => sources.filter((s) => decoded.has(s.buffer));
const lastLoop = () => loops()[loops().length - 1];

class FakeCtx {
  constructor() {
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
    const node = baseNode('source', {
      buffer: null,
      playbackRate: new Param(1),
      loop: false,
      started: null,
      stopped: null,
      start(when, offset = 0) { node.started = when ?? now; node.offset = offset; sources.push(node); },
      stop(when) { node.stopped = when ?? now; },
    });
    return node;
  }
  createOscillator() {
    return baseNode('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
  }
  // REAL SAMPLES, not just a duration. music.js measures where a file's audio
  // actually starts and rounds its length to a whole number of bars (see
  // measureTrack), and a buffer that is only a number cannot exercise any of
  // that — the bar-quantised boss switch would be asserted against a
  // measurement that never ran. `lead` is the encoder padding every mp3 in the
  // library carries; `silent` is the mocked-context case, where there is
  // nothing to read and the file has to fall back to its own length.
  async decodeAudioData(data) {
    const seconds = data?.seconds ?? 1;
    const rate = 48000;
    const length = Math.round(seconds * rate);
    const buffer = { duration: seconds, sampleRate: rate, length, numberOfChannels: 1, tag: data?.tag };
    if (!data?.silent) {
      const lead = Math.round((data?.lead ?? 0) * rate);
      const tail = Math.round((data?.tail ?? 0) * rate);
      const pcm = new Float32Array(length);
      // Phase-offset so the very first sample is ALREADY loud. A sine started
      // at zero crosses the silence floor for one sample, and music.js would
      // correctly read that single sample as encoder padding — a lead-in of
      // 1/48000s, which is not what any of these cases mean to set up.
      for (let i = lead; i < length - tail; i++) pcm[i] = Math.sin(i * 0.05 + 1) * 0.5;
      buffer.getChannelData = () => pcm;
    }
    decoded.add(buffer);
    return buffer;
  }
  resume() { return Promise.resolve(); }
}

// The 40ms poll, driven by hand instead of by a timer.
let poll = null;
globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = (fn) => { poll = fn; return 1; };
globalThis.window.clearInterval = () => { poll = null; };
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const music = await import('../path/src/systems/music.js');

audio.unlockAudio();

// Wall seconds forward, running the poll on the same 40ms cadence the browser
// timer does. `onStep` is where a test bends the rate mid-flight.
function run(seconds, onStep = null) {
  const step = 0.04;
  const end = now + seconds;
  while (now < end - 1e-9) {
    now = Math.min(end, now + step);
    onStep?.(now);
    poll?.();
  }
}

// A loop of an exact length, decoded straight in — no file, no mp3.
// `opts.lead`/`opts.tail` are seconds of silence on either end (what an mp3
// decodes with); `opts.silent` produces a buffer with no readable samples at
// all, which is what a mocked decoder gives you.
async function loadLoop(slot, seconds, opts = {}) {
  await music.loadTrackFromFile(slot, {
    name: `loop${slot}`,
    arrayBuffer: async () => ({ seconds, tag: slot, ...opts }),
  });
}

// Which track a playing source node is — the buffer carries the slot name it
// was decoded under, so a rotation can be read back as a list of names rather
// than as a list of anonymous nodes.
const playing = () => lastLoop()?.buffer?.tag ?? null;
const playedOrder = () => loops().map((s) => s.buffer?.tag ?? '?');

function reset() {
  music.stop();
  sources.length = 0;
  now += 1;
}

// The two lengths that matter: one that is NOT a whole number of grid loops
// (which is every mp3 anyone actually uploads) and one that is longer than the
// grid loop entirely.
const SHORT = 9.072; // the real 747 Cocktails short loop
const LONG = 27.168; // and the long one — 1.7 grid loops at 120bpm/32
CONFIG.music.enabled = true;
CONFIG.music.bpm = 120;
CONFIG.music.beatsPerLoop = 32; // grid loop = 16s, on purpose out of step with both
CONFIG.music.playbackRate = 1;
CONFIG.music.levelsPerSlot = 1;
CONFIG.music.slots = 4;
await loadLoop('1', SHORT);
await loadLoop('2', LONG);

// ---------------------------------------------------------------------------
section('A switch waits for the file, not the beat count');
reset();
music.play(1);
const first = loops()[0];
check('the first loop starts', !!first, `at t=${first?.started.toFixed(3)}`);
// Uncut means NOT CROPPED TO THE BPM GRID, which is what it used to be. Loop
// points are allowed — they are how the encoder's silence gets skipped — but
// they may never end the loop before the file does.
check('the whole file loops, uncut', first.loop === true && (!first.loopEnd || near(first.loopEnd, SHORT, 1e-6)),
  `loopEnd ${first.loopEnd ?? 'unset'} vs a ${CONFIG.music.beatsPerLoop}-beat grid of ${music.loopDuration()}s`);

const t0 = first.started;
run(1);
music.setLevel(2); // levelsPerSlot 1, so this queues slot '2'
run(40);
const second = loops()[1];
check('the next loop starts exactly one file later', second && near(second.started - t0, SHORT, 0.005),
  `+${(second.started - t0).toFixed(3)}s, file is ${SHORT}s`);
check('and NOT on the bpm grid', !near(second.started - t0, music.loopDuration(), 0.02),
  `the grid would have cut it at +${music.loopDuration()}s, ${(music.loopDuration() - SHORT).toFixed(3)}s into the next loop`);
check('the outgoing loop plays right up to it, with no gap', near(first.stopped, second.started, 1e-9),
  `it stops at ${first.stopped.toFixed(3)}, the next starts at ${second.started.toFixed(3)}`);

// ---------------------------------------------------------------------------
section('A file longer than the grid loop plays all of it');
reset();
CONFIG.music.levelsPerSlot = 1;
music.play(2); // slot '2' — 27.168s, longer than the 16s grid
const longSrc = loops()[0];
check('nothing is clipped off the end', !longSrc.loopEnd || near(longSrc.loopEnd, LONG, 1e-6),
  'it used to be cropped to beatsPerLoop, which turned twelve bars into eight and a cut');
const t1 = longSrc.started;
run(0.5);
music.setLevel(1);
run(60);
check('and a switch waits for all of it', loops()[1] && near(loops()[1].started - t1, LONG, 0.01),
  `+${(loops()[1].started - t1).toFixed(3)}s of a ${LONG}s file`);

// ---------------------------------------------------------------------------
section('The wait is in the track\'s time, not the room\'s');
reset();
music.play(1); // the 9.072s loop
const t2 = loops()[0].started;
run(2);
music.setMusicRateScale(0.5, 0); // the death dive, instantly at half speed
music.setLevel(2);
run(60);
const halved = loops()[1];
// 2s of the file played at pitch, the remaining 7.072s at half speed.
const expected = t2 + 2 + (SHORT - 2) / 0.5;
check('a loop at half speed gets twice as long to finish', halved && near(halved.started, expected, 0.06),
  `switched at +${(halved.started - t2).toFixed(2)}s, expected +${(expected - t2).toFixed(2)}s`);
check('rather than being cut where the wall clock said', !near(halved.started - t2, SHORT, 0.5),
  `wall-clock math would have cut it at +${SHORT}s, with ${(((SHORT - 2) / 0.5 - (SHORT - 2)) / ((SHORT) / 0.5) * 100).toFixed(0)}% of the loop unplayed`);
music.setMusicRateScale(1, 0);

// ---------------------------------------------------------------------------
section('The transport follows a glide, not its destination');
reset();
music.play(1);
run(1);
const beforeDrag = music.currentBpm();
music.setMusicRateScale(0.3, 0.25); // as the death dive does it
let worstRateError = 0;
run(2, () => {
  const modelled = music.currentBpm() / CONFIG.music.bpm;
  const actual = lastLoop().playbackRate.value;
  worstRateError = Math.max(worstRateError, Math.abs(modelled - actual));
});
check('it tracks the AudioParam through the whole drag', worstRateError < 0.01,
  `worst disagreement ${worstRateError.toExponential(1)} of a rate`);
check('the tempo drops as the tape does', music.currentBpm() < beforeDrag * 0.4,
  `${beforeDrag.toFixed(1)}bpm -> ${music.currentBpm().toFixed(1)}bpm`);
music.setMusicRateScale(1, 0);

// ---------------------------------------------------------------------------
section('The beat grid stretches instead of jumping');
reset();
music.play(1);
run(10);
const phaseBefore = music.beatPhase();
music.setMusicRateScale(0.5, 0);
const phaseAfter = music.beatPhase();
check('halving the rate does not rewrite the beats already played',
  near(phaseAfter, phaseBefore, 0.05),
  `${phaseBefore.toFixed(2)} -> ${phaseAfter.toFixed(2)} beats (wall-clock phase jumped to ${(phaseBefore / 2).toFixed(2)})`);
let monotonic = true;
let last = phaseAfter;
run(4, () => {
  const p = music.beatPhase();
  if (p < last - 1e-9) monotonic = false;
  last = p;
});
check('and it keeps moving forward, slower', monotonic && last > phaseAfter);
const beatsIn4s = last - phaseAfter;
check('at half speed, half the beats', near(beatsIn4s, 4 / (60 / CONFIG.music.bpm) * 0.5, 0.2),
  `${beatsIn4s.toFixed(2)} beats in 4s`);
music.setMusicRateScale(1, 0);

// ---------------------------------------------------------------------------
section('Repeated level-ups inside one loop collapse to one switch');
reset();
CONFIG.music.levelsPerSlot = 1;
music.play(1);
const t3 = loops()[0].started;
run(0.5);
music.setLevel(2);
run(0.5);
music.setLevel(1); // back to the playing track: cancels nothing, queues nothing new
run(0.5);
music.setLevel(2);
run(20);
const switches = loops().length - 1;
check('one loop end, one switch', switches === 1, `${switches} switch(es)`);
check('and it still landed on the file end', near(loops()[1].started - t3, SHORT, 0.01));

// ---------------------------------------------------------------------------
section('Dying does not stop the music');
const { player } = await import('../path/src/entities/player.js');
const THREE = await import('three');
const { bounds } = await import('../path/src/arena.js');
const dive = await import('../path/src/systems/deathDive.js');

player.mesh = new THREE.Object3D();
player.body = new THREE.Object3D();
player.mesh.position.set(0, bounds.top - 2, 0);
player.stats = { hitRadius: 1, maxSpeed: 30 };
player.velocity.set(4, 0);
player.aimRig = null;

reset();
music.play(1);
run(1);
const beforeDeath = loops().length;
let scoreScreen = false;
dive.startDeathDive(() => { scoreScreen = true; });
// The dive, on the wall clock, until the score card goes up.
let guard = 0;
while (!scoreScreen && guard++ < 4000) {
  now += 1 / 60;
  dive.updateDeathDive(1 / 60);
  if (guard % 2 === 0) poll?.();
}
check('the score screen arrives', scoreScreen, `after ${(guard / 60).toFixed(1)}s`);
check('the music is still on the same source', loops().length === beforeDeath && !lastLoop().stopped,
  'nothing called stop()');
const draggedBpm = music.currentBpm();
check('and it was dragged down by the dive', draggedBpm < CONFIG.music.bpm * 0.9,
  `${draggedBpm.toFixed(1)}bpm`);

// Winding back up under the card, while the picture stays dilated.
run(CONFIG.death.audio.restoreTime + 0.5);
check('then winds back up to pitch under the score card',
  near(music.currentBpm(), CONFIG.music.bpm, CONFIG.music.bpm * 0.06),
  `${music.currentBpm().toFixed(1)} of ${CONFIG.music.bpm}bpm`);
check('the loop is still running under it', music.beatPhase() > 0 && !lastLoop().stopped);

// And the restart ramp must not grab it back and yank it down again.
const pitchBeforeRestart = music.currentBpm();
dive.beginRestartTransition(() => {});
let lowest = Infinity;
for (let i = 0; i < 90; i++) {
  now += 1 / 60;
  dive.updateDeathDive(1 / 60);
  lowest = Math.min(lowest, music.currentBpm());
}
check('the way back out leaves it alone', lowest > pitchBeforeRestart * 0.95,
  `dipped to ${lowest.toFixed(1)}bpm from ${pitchBeforeRestart.toFixed(1)}`);

// ---------------------------------------------------------------------------
// The music chain runs to ctx.destination on its OWN gain — it is not
// downstream of the SFX master — so nothing about the Audio tab reaches it
// unless music.js is told. It was not: the score played straight through a
// mute at full authored volume, which is the loudest thing in the mix and so
// read as the whole menu doing nothing.
//
// Asserted on the gain node the graph actually ends on, found by walking the
// live source's outputs, rather than on a value music.js reports about itself.
section("The player's Audio tab reaches the score");
const settings = await import('../path/src/systems/settings.js');
const { applyPlayerMusicSettings } = music;

// source -> filter -> band gain -> musicGain -> destination
function musicGainNode() {
  const seen = new Set();
  const walk = (node) => {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    for (const out of node.outputs ?? []) {
      if (out.kind === 'destination') return node;
      const found = walk(out);
      if (found) return found;
    }
    return null;
  };
  return walk(lastLoop());
}

reset();
CONFIG.music.enabled = true;
CONFIG.music.volume = 0.8;
settings.resetSettings('audio');
music.play(1);
run(0.5);
const gainNode = musicGainNode();
check('the music gain is the node feeding the destination', !!gainNode && gainNode.kind === 'gain');
const level = () => gainNode.gain.value;
// Restamped rather than read straight off `play`: the chain in this module was
// built by an earlier section, before CONFIG.music.volume was moved here, and
// in the game an authored change arrives through the tuner's applyMusicSettings
// exactly like this.
applyPlayerMusicSettings();
check('at defaults it is the authored volume', near(level(), 0.8, 1e-6), String(level()));

settings.setSetting('audio.music', 0.5);
applyPlayerMusicSettings();
check('the music slider scales it', near(level(), 0.8 * 0.5, 1e-6), String(level()));

settings.setSetting('audio.master', 0.5);
applyPlayerMusicSettings();
check('master multiplies on top', near(level(), 0.8 * 0.5 * 0.5, 1e-6), String(level()));

settings.setSetting('audio.muted', true);
applyPlayerMusicSettings();
check('mute silences the score outright', level() === 0, String(level()));

settings.setSetting('audio.muted', false);
applyPlayerMusicSettings();
check('and unmute restores the same level', near(level(), 0.8 * 0.25, 1e-6), String(level()));

// The other bus, for the comparison: everything synthesised or sampled sits on
// getSfxBus(), and that one was already wired up. Asserted here so a later
// change that breaks ONE of the two buses is still a failing test.
const sfxBus = audio.getSfxBus();
settings.setSetting('audio.sfx', 0.5);
audio.applyPlayerAudioSettings();
check('the effects slider scales the SFX bus',
  near(sfxBus.gain.value, CONFIG.audio.masterVolume * 0.5 * 0.5, 1e-6), String(sfxBus.gain.value));
settings.setSetting('audio.muted', true);
audio.applyPlayerAudioSettings();
check('and mute silences it', sfxBus.gain.value === 0, String(sfxBus.gain.value));

// The chain is built when music STARTS, which is long after loadSettings() —
// so a player who muted last session has to be muted on the OPENING BAR, not
// from their first slider move afterwards. A second copy of the module is the
// only way to watch the chain get built: the first one's is already up, and
// this shares the same settings, audio context and CONFIG.
settings.setSetting('audio.muted', true);
music.stop();
sources.length = 0;
now += 1;
const fresh = await import('../path/src/systems/music.js?rebuild');
await fresh.loadTrackFromFile('1', { name: 'loop1', arrayBuffer: async () => ({ seconds: SHORT }) });
fresh.play(1);
run(0.5);
check('a chain built while muted comes up silent', musicGainNode()?.gain.value === 0,
  `${musicGainNode()?.gain.value} — the opening bar used to play at the authored ${CONFIG.music.volume}`);
fresh.stop();

settings.resetSettings('audio');
CONFIG.music.volume = 0.8;
applyPlayerMusicSettings();

// ---------------------------------------------------------------------------
// THE HUSH — what a boss dying sounds like.
//
// The score is cut almost dead on the killing blow and the last fraction of a
// second of it is thrown into a long reverb that rings out over the held
// close-up (systems/bossKill.js). Three ways that goes silently wrong, and
// every one of them is only audible as "the music stopped working":
//
//   THE TAIL IS MUTED TOO   the send routed through the music gain instead of
//                           around it, so the very cut it exists to survive
//                           silences it. What the player gets is a hole.
//   THE MUSIC NEVER RETURNS a hush left up by a restart, a death, or a run
//                           started mid-beat. The transport is still playing,
//                           into a gain ramped to zero — silent for the rest
//                           of the session, with nothing failing anywhere.
//   NOTHING IS FED          the send opened after the mute rather than before
//                           it. The convolver only outputs what it has been
//                           given, so a room fed silence rings out silence.
section('A boss dies: the score cuts out and the room rings on');
reset();
CONFIG.music.enabled = true;
music.play(1);
run(1);

const dryGain = musicGainNode();
const filterNode = lastLoop().outputs[0];
const sendNode = filterNode.outputs.find((n) => n.outputs?.[0]?.kind === 'convolver');
const verbNode = sendNode?.outputs[0];
const tailGain = verbNode?.outputs[0];

check('the music has a reverb send off the depth filter', !!sendNode && !!verbNode);
check('...and it reaches the speakers AROUND the mute, not through it',
  !!tailGain && tailGain.outputs.some((n) => n.kind === 'destination')
  && !tailGain.outputs.includes(dryGain),
  tailGain ? tailGain.outputs.map((n) => n.kind).join(',') : 'no tail gain');
check('it is silent until a boss dies', sendNode.gain.value === 0 && tailGain.gain.value === 0,
  `send ${sendNode.gain.value}, tail ${tailGain.gain.value}`);

const authored = CONFIG.music.volume;
check('the score is playing at its own level before the kill', near(dryGain.gain.value, authored, 1e-6),
  String(dryGain.gain.value));

const lit = music.hushMusic({ cut: 0.2, feed: 0.3, seconds: 4, decay: 2, level: 1.3 });
check('the kill lights the tail', lit === true && music.musicHushed() === true);
check('the room is hit with the loop at full level, not with the cut',
  near(sendNode.gain.value, 1, 1e-6), String(sendNode.gain.value));
check('...and the impulse is as long as it was asked for',
  verbNode.buffer?.length === Math.floor(48000 * 4), `${verbNode.buffer?.length} samples`);
check('the cut has not already happened on the frame of the blow',
  dryGain.gain.value > authored * 0.9, String(dryGain.gain.value));

run(0.1);
check('...but it is well under way a tenth of a second later',
  dryGain.gain.value < authored * 0.6, String(dryGain.gain.value));
run(0.25);
check('the score is gone', dryGain.gain.value < 1e-6, String(dryGain.gain.value));
check('...the room has stopped being fed', sendNode.gain.value < 1e-6, String(sendNode.gain.value));
check('...and the tail is the only thing left playing', tailGain.gain.value > 0,
  `${tailGain.gain.value.toFixed(3)} against a score at ${dryGain.gain.value}`);

// A slider dragged during the silence must not punch a frame of music through
// it — the gain is mid-automation, and a plain assignment either loses or wins
// for exactly one frame.
applyPlayerMusicSettings();
check('a volume change during the beat does not break the silence',
  dryGain.gain.value < 1e-6, String(dryGain.gain.value));

music.releaseMusicHush(0.3);
run(0.35);
check('the music comes back up with the water', near(dryGain.gain.value, authored, 1e-3),
  String(dryGain.gain.value));
check('...and the room bows out under it rather than ringing over the top',
  tailGain.gain.value < 0.5 * authored * 1.3, String(tailGain.gain.value));
check('...and the hush lets go of the level', music.musicHushed() === false);

// THE ONE THAT SILENCES A SESSION. A run restarted while the beat is still up
// — the score screen is reachable from inside one — has to open with music.
music.hushMusic({ cut: 0.2, feed: 0.3 });
run(0.3);
check('a run restarted mid-beat', dryGain.gain.value < 1e-6);
music.play(1);
run(0.05);
check('...opens with its music, not into the last run\'s silence',
  near(musicGainNode().gain.value, authored, 1e-6), String(musicGainNode().gain.value));
check('...with nothing left ringing from a fight this player never had',
  sendNode.gain.value === 0 && tailGain.gain.value === 0);

// And with nothing playing there is nothing to hush — the caller is told so
// rather than being left waiting on a tail that was never lit.
music.stop();
check('a hush with the transport stopped does nothing', music.hushMusic({}) === false);
music.play(1);
run(0.05);
settings.setSetting('audio.muted', true);
check('...and neither does one with the music muted', music.hushMusic({}) === false);
settings.resetSettings('audio');
music.stop();

// ---------------------------------------------------------------------------
// THE BOSS BANK
// ---------------------------------------------------------------------------
// A second set of loops that takes the transport for the length of a fight.
// Everything below is a property you can only hear as "the music went a bit
// wrong when the boss turned up", which is why it is arithmetic here.
//
// The bank is loaded by hand under the names music.js builds internally
// ('boss' + index) rather than through preloadDefaultTracks, whose fetch 404s
// in this harness — which also pins the naming contract down: a track named
// 'boss0' must never be reachable by slotForLevel, or an ordinary level-up
// would draw a fight loop.
const BAR = 2.265;
CONFIG.music.barSeconds = BAR;
CONFIG.music.bossIntro = true;
// Real lengths, from the real files: a four-bar intro, then eight, five and
// seven bars. Uneven on purpose — the rotation must switch on each file's OWN
// end, and a bank of equal loops would pass either way.
CONFIG.music.bossSrc = ['b0', 'b1', 'b2', 'b3'];
// A third run loop, so that "the level reached during the fight" below picks a
// DIFFERENT slot from the one the fight interrupted. With only two loaded,
// slotForLevel clamps to the last one and the assertion would pass on a version
// that ignored the level entirely.
await loadLoop('3', BAR * 4);
await loadLoop('boss0', BAR * 4);
await loadLoop('boss1', BAR * 8);
await loadLoop('boss2', BAR * 5);
await loadLoop('boss3', BAR * 7);

section('A boss arrives: the switch lands on a bar line, not on the frame');
reset();
CONFIG.music.levelsPerSlot = 1;
music.play(1);
run(0.05);
const runLoopAt = lastLoop().started;
// Deliberately NOT on a bar: a third of the way into one, which is where a
// player crossing a level threshold actually is.
run(BAR * 2 + BAR / 3);
const beforeArrival = loops().length;
check('the run\'s own loop is playing when the boss lands', playing() === '1', String(playing()));
music.startBossMusic();
check('the score does not change on the arrival frame', loops().length === beforeArrival,
  'a cut here would chop the run loop mid-phrase');
run(BAR); // one bar is the most it may ever wait
check('...it has changed a bar later', playing() === 'boss0', String(playing()));
const bossAt = lastLoop().started;
const barsWaited = (bossAt - runLoopAt) / BAR;
check('...and it landed exactly on a bar line',
  near(barsWaited, Math.round(barsWaited), 1e-6), `${barsWaited.toFixed(4)} bars after the run loop began`);
check('...at most one bar after the arrival', barsWaited - (BAR * 2 + BAR / 3) / BAR <= 1 + 1e-9,
  `waited ${(bossAt - (runLoopAt + BAR * 2 + BAR / 3)).toFixed(3)}s`);

section('The intro plays once; the cycle wraps to the body, not to the intro');
// Long enough for the intro plus a full pass of the other three and back round.
run(BAR * 4 + BAR * 8 + BAR * 5 + BAR * 7 + BAR * 8 + 0.5);
const order = playedOrder().slice(playedOrder().indexOf('boss0'));
check('the intro is first', order[0] === 'boss0', order.join(' → '));
check('...and it never comes back', order.slice(1).every((n) => n !== 'boss0'), order.join(' → '));
check('...the body cycles in file order and wraps to the second entry',
  order.slice(0, 5).join(',') === 'boss0,boss1,boss2,boss3,boss1', order.join(' → '));

section('Each boss loop plays all of itself');
const starts = [];
for (const s of loops()) if (String(s.buffer?.tag).startsWith('boss')) starts.push([s.buffer.tag, s.started]);
let gapsOk = true;
let gapDetail = '';
for (let i = 1; i < Math.min(5, starts.length); i++) {
  const expected = { boss0: BAR * 4, boss1: BAR * 8, boss2: BAR * 5, boss3: BAR * 7 }[starts[i - 1][0]];
  const actual = starts[i][1] - starts[i - 1][1];
  if (!near(actual, expected, 1e-6)) { gapsOk = false; gapDetail += `${starts[i - 1][0]} ran ${actual.toFixed(3)}s not ${expected.toFixed(3)}s; `; }
}
check('every loop runs its own full length before the next', gapsOk, gapDetail || 'four uneven loops, none cut');

section('Levelling up inside a fight does not end the fight\'s music');
const duringFight = playing();
music.setLevel(3); // slot '3' would be due — and must not arrive
run(BAR * 8 + 0.5);
check('the run\'s loop is not queued underneath the boss',
  String(playing()).startsWith('boss'), String(playing()));
check('...the fight is still on the boss bank', music.bossMusicActive() === true);

section('The kill: the tail is made of boss music, the return is not');
const bossSource = lastLoop();
check('a boss loop is what the hush will feed the room', String(bossSource.buffer.tag).startsWith('boss'));
const bossLit = music.hushMusic({ cut: 0.2, feed: 0.3, seconds: 4, decay: 2, level: 1.3 });
check("the kill lights the tail", bossLit === true);
run(0.3);
check('the score is cut', near(musicGainNode().gain.value, 0, 1e-6), String(musicGainNode().gain.value));
check('...and the boss loop is still the source that was feeding it',
  lastLoop() === bossSource, 'the tail must be built from the fight, not from what replaces it');
// The handover, in the order systems/bossKill.js does it: the transport first,
// while the gain is still at zero, and only then the release.
music.endBossMusic();
check('the fight\'s music ends', music.bossMusicActive() === false);
check('...and the run\'s own loop is back, chosen for the level reached IN the fight',
  playing() === '3', `${playing()} — setLevel(3) was held for the whole fight`);
check('...the swap happened in silence', near(musicGainNode().gain.value, 0, 1e-6),
  String(musicGainNode().gain.value));
check('...from the top of the loop, not part-way in', near(lastLoop().offset ?? 0, 0, 1e-6));
music.releaseMusicHush(0.35);
run(0.4);
check('...and what fades back up is the run\'s music', playing() === '3', String(playing()));

section('One rotation per run: the next boss picks up where the last left off');
reset();
music.play(1);
run(0.05);
// One fight, `bars` bars long, returning the loops actually heard in it. The
// tags are read BEFORE the kill, so the run loop the handover starts is not
// counted as part of the fight.
function fight(bars) {
  const from = loops().length;
  music.startBossMusic();
  run(BAR * bars + 0.1);
  const heard = loops().slice(from).map((s) => s.buffer?.tag);
  music.endBossMusic();
  run(0.2);
  return heard;
}
// boss0 is 4 bars, boss1 is 8, boss2 is 5, boss3 is 7.
const fight1 = fight(5); // the intro, then into the next
const fight2 = fight(5);
const fight3 = fight(9);
check('the run\'s first boss opens on the intro', fight1[0] === 'boss0', fight1.join(' → '));
check('...and moves on from it inside the fight', fight1[1] === 'boss1', fight1.join(' → '));
check('the second boss resumes on the loop the first had queued when it died',
  fight2[0] === 'boss2', `fight 1 heard ${fight1.join(' → ')}, fight 2 opened on ${fight2[0]}`);
check('the third carries on from the second', fight3[0] === 'boss3', fight3.join(' → '));
check('...and wraps past the intro, not back to it', fight3[1] === 'boss1', fight3.join(' → '));
check('the intro is never heard twice in a run',
  [...fight2, ...fight3].every((n) => n !== 'boss0'), [...fight2, ...fight3].join(' → '));
check('...and no loop is skipped across the gap between fights',
  [...fight1, ...fight2, ...fight3].join(',') === 'boss0,boss1,boss2,boss3,boss1',
  [...fight1, ...fight2, ...fight3].join(' → '));

// The shortest fight there is: killed before the arrival's switch has even
// landed, so the intro was queued and never sounded. It is still spent — the
// alternative is the one fight that skips the announcement handing it to the
// next boss, and the run hearing it twice.
reset();
music.play(1);
run(0.05);
music.startBossMusic();
music.endBossMusic(); // dead inside the first bar
run(0.2);
const after = loops().length;
music.startBossMusic();
run(BAR + 0.1);
check('a boss killed before the intro sounded still spends it',
  loops().slice(after).map((s) => s.buffer?.tag)[0] === 'boss1',
  loops().slice(after).map((s) => s.buffer?.tag).join(' → '));

// ...and a NEW run gets its own intro back.
music.play(1);
run(0.05);
const freshRun = loops().length;
music.startBossMusic();
run(BAR + 0.1);
check('a fresh run announces its first boss again',
  loops().slice(freshRun).map((s) => s.buffer?.tag)[0] === 'boss0',
  loops().slice(freshRun).map((s) => s.buffer?.tag).join(' → '));
music.endBossMusic();

section('Two bosses at once: the first kill does not take the music');
reset();
music.play(1);
run(0.05);
music.startBossMusic();
run(BAR);
music.startBossMusic(); // a second boss joins
check('the second arrival does not restart the rotation from the intro',
  playing() === 'boss0', String(playing()));
music.endBossMusic();
check('one kill with a boss still in the water leaves the fight music up',
  music.bossMusicActive() === true);
run(0.1);
check('...still on the boss bank', String(playing()).startsWith('boss'), String(playing()));
music.endBossMusic();
check('the last kill hands it back', music.bossMusicActive() === false);
check('...to the run\'s own loop', playing() === '1', String(playing()));

section('A run restarted mid-fight opens on the run\'s music');
reset();
music.play(1);
run(0.05);
music.startBossMusic();
run(BAR + 0.1);
check('the fight is up', music.bossMusicActive() === true);
music.play(1); // the player died and started again
run(0.05);
check('the new run is not in a fight', music.bossMusicActive() === false);
check('...and opens on its first loop', playing() === '1', String(playing()));
run(BAR * 2);
check('...which the dead fight never takes back', playing() === '1', String(playing()));

section('Encoder padding is skipped, not played as a gap');
reset();
// 36ms of leading silence, which is what an mp3 in this library decodes with.
await loadLoop('4', BAR * 4, { lead: 0.036 });
CONFIG.music.levelsPerSlot = 1;
music.play(4);
run(0.05);
const padded = lastLoop();
check('the loop starts at the downbeat, not at sample zero',
  near(padded.offset ?? 0, 0.036, 0.0005), `offset ${(padded.offset ?? 0).toFixed(4)}s`);
check('...and wraps back to the downbeat rather than to the silence',
  near(padded.loopStart ?? 0, 0.036, 0.0005), `loopStart ${(padded.loopStart ?? 0).toFixed(4)}s`);
check('...with nothing taken off the end', near(padded.loopEnd ?? 0, BAR * 4, 1e-6),
  'a bar may legitimately end quiet — the back of the file is never trimmed');

section('A boss bank that never loaded costs the fight its score, not the game its sound');
reset();
// Every boss file 404s — the public/music path is wrong, the deploy dropped
// them, the player is offline. The run's own music must simply carry on: this
// is the failure that would otherwise be SILENT, an ocean that goes quiet on
// the one arrival the whole run builds to.
const savedBank = CONFIG.music.bossSrc;
CONFIG.music.bossSrc = [];
music.play(1);
run(0.05);
check('the arrival reports that it could not take the transport', music.startBossMusic() === false);
check('...and does not think a fight is scored', music.bossMusicActive() === false);
run(BAR * 2);
check('...the run\'s own music is still playing', playing() === '1', String(playing()));
// And the kill's handover has to be safe with a fight that never started, or
// every boss death with a missing bank would swap the track for no reason.
music.endBossMusic();
check('an unmatched kill does not disturb the music', playing() === '1', String(playing()));
CONFIG.music.bossSrc = savedBank;

section('The arrival: the run\'s music rings out over the gap the boss lands in');
reset();
CONFIG.music.levelsPerSlot = 1;
music.play(1);
run(0.05);
const fadeFrom = musicGainNode().gain.value;
check('the score is up before the boss is announced', fadeFrom > 0, String(fadeFrom));
// Deliberately off the grid, like a real level threshold — the whole point of
// this path is that it no longer waits for one.
run(BAR + BAR / 3);
// THE SHIPPED BAG, not a hand-written one. boss.js hands this block straight
// to fadeMusicForBoss, and the room's three numbers are spelled
// `tailSeconds`/`tailDecay`/`tailLevel` there to match the kill's — a rename on
// either side falls through to hushMusic's defaults, which is the kill's room
// at the arrival and looks exactly like the settings working.
const arrivalRoom = CONFIG.boss.arrival.music;
check('the arrival has a room of its own', !!arrivalRoom && arrivalRoom.tailSeconds > 0,
  JSON.stringify(arrivalRoom));
check('...a bigger one than the kill gets, and a slower way in',
  arrivalRoom.tailSeconds > CONFIG.boss.kill.music.tailSeconds
    && arrivalRoom.cut > CONFIG.boss.kill.music.cut,
  `${arrivalRoom.tailSeconds}s room over a ${arrivalRoom.cut}s cut,`
  + ` against the kill's ${CONFIG.boss.kill.music.tailSeconds}s and ${CONFIG.boss.kill.music.cut}s`);
const dry = musicGainNode();
const filt = lastLoop().outputs[0];
const send = filt.outputs.find((n) => n.outputs?.[0]?.kind === 'convolver');
const verb = send?.outputs[0];
const tail = verb?.outputs[0];
const beforeFade = loops().length;
check('the room is dark before the arrival', send.gain.value === 0 && tail.gain.value === 0,
  `send ${send.gain.value}, tail ${tail.gain.value}`);
check('the handover takes', music.fadeMusicForBoss(arrivalRoom) === true);

// THE ROOM IS FED THE MUSIC, not the mute. The send taps upstream of the dry
// gain, so what the convolver is given is the loop at full level for as long as
// the window is open — feed it after the cut and the room rings out silence,
// which is a bug with no symptom but "the gap sounds empty".
check('the room is hit with the loop at full level', near(send.gain.value, 1, 1e-6),
  String(send.gain.value));
check('...and the transport has not gone yet', dry.gain.value > fadeFrom * 0.9,
  String(dry.gain.value));
check('...into a bigger room than the kill gets',
  verb.buffer?.length === Math.floor(48000 * arrivalRoom.tailSeconds),
  `${verb.buffer?.length} samples`);
check('...with the loop still the thing playing into it',
  loops().length === beforeFade && playing() === '1', String(playing()));

run(0.5);
check('the window into the room shuts once it has its note',
  near(send.gain.value, 0, 1e-6), String(send.gain.value));
const half = dry.gain.at(now - 0.05);
check('...while the transport is on its way out', half > 0 && half < fadeFrom,
  `${half.toFixed(3)} of ${fadeFrom.toFixed(3)}`);
run(0.5);
check('...and then the music has stopped', near(dry.gain.value, 0, 1e-6), String(dry.gain.value));

// THE GAP. The rest of the ceremony is the riser over a stopped score — and the
// room the score was playing in, still ringing. That tail is the whole point of
// the send: a plain fade leaves silence here, and silence with a riser in it
// reads as the music having dropped out rather than handed over.
const quietFrom = now;
run(0.6);
check('the transport is silent across the gap',
  near(dry.gain.at(quietFrom + 0.3), 0, 1e-6) && near(dry.gain.value, 0, 1e-6),
  `${dry.gain.value} across ${((now - quietFrom) * 1000).toFixed(0)}ms`);
check('...but the room is not',
  tail.gain.value > 0 && near(tail.gain.value, fadeFrom * arrivalRoom.tailLevel, 1e-6),
  `tail at ${tail.gain.value.toFixed(3)}, music was ${fadeFrom.toFixed(3)}`);
check('...and it is louder than the loop it replaced',
  tail.gain.value > fadeFrom, `${tail.gain.value.toFixed(3)} vs ${fadeFrom.toFixed(3)}`);

// THE SWITCH, ON THE CEREMONY'S OWN FRAME. With nothing sounding there is no
// phrase to cut, so the bar line the switch used to wait for buys nothing and
// costs up to 2.265s of silence after the bar has filled — a boss whose music
// arrives at a different moment every fight.
const atArrival = now;
music.startBossMusic();
run(0.1);
check('the boss music starts on the arrival frame, not a bar later',
  playing() === 'boss0', String(playing()));
const bossStart = lastLoop().started;
check('...within a frame of it', bossStart - atArrival < 0.05,
  `${((bossStart - atArrival) * 1000).toFixed(0)}ms after the ceremony landed`);

// AND THE SCORE COMES BACK ON THAT SAMPLE. Read off the gain param's own
// schedule rather than by stepping the clock, because the question is whether
// the ramp is anchored to the switch — a return scheduled from `now` would
// answer this correctly at the end and be audibly early in the middle.
const gain = musicGainNode().gain;
check('the score is still silent a frame before the boss loop',
  near(gain.at(bossStart - 0.02), 0, 1e-6), String(gain.at(bossStart - 0.02)));
check('...and back up a fraction after it',
  near(gain.at(bossStart + 0.2), fadeFrom, 1e-6),
  `${gain.at(bossStart + 0.2).toFixed(3)} of ${fadeFrom.toFixed(3)}`);
check('...having not crept back across the silence before it',
  gain.at(quietFrom + 0.3) < fadeFrom * 1e-6 && gain.at(bossStart - 0.1) < fadeFrom * 1e-6,
  `${gain.at(quietFrom + 0.3)} mid-gap, ${gain.at(bossStart - 0.1)} just before`);

// The rotation still chains. This switch bypasses the queue, and pollQueue is
// what normally lines up the successor — a fight that played its intro and then
// fell silent is the exact bug that omission makes.
run(BAR * 4 + 0.2);
check('...and the rotation still moves on by itself', playing() === 'boss1', String(playing()));
music.endBossMusic();

section('A fight that ends during its own entrance still gives the music back');
// The failure this catches costs a run its score for the REST OF THE RUN, and
// it is silent in the most literal way: the fade went down, the boss loop never
// started, and nothing else in the game ever puts the gain back.
reset();
music.play(1);
run(0.05);
const owed = musicGainNode().gain.value;
music.fadeMusicForBoss(arrivalRoom);
run(1.4);
check('the score is faded out', near(musicGainNode().gain.value, 0, 1e-6));
music.endBossMusic(); // the boss died, or the fight was switched off, mid-ceremony
run(0.3);
check('...and the run gets it back', near(musicGainNode().gain.value, owed, 1e-6),
  String(musicGainNode().gain.value));
check('...still on its own loop', playing() === '1', String(playing()));

// The same for a bank that never loaded: the fade is a HANDOVER, and with
// nothing to hand over to it has to be undone rather than left standing.
reset();
const bankForFade = CONFIG.music.bossSrc;
CONFIG.music.bossSrc = [];
music.play(1);
run(0.05);
music.fadeMusicForBoss(arrivalRoom);
run(1.4);
check('a missing bank leaves the score faded out for a moment',
  near(musicGainNode().gain.value, 0, 1e-6));
check('...the arrival still reports it could not take the transport',
  music.startBossMusic() === false);
run(0.3);
check('...and the run\'s music comes straight back rather than never',
  near(musicGainNode().gain.value, owed, 1e-6) && playing() === '1',
  `${musicGainNode().gain.value} on ${playing()}`);
CONFIG.music.bossSrc = bankForFade;

// THE SWITCH LANDING ON A CUT STILL IN FLIGHT. boss.js clamps the cut inside
// the ceremony so this should not happen, but a tuner drag and a shortened
// entrance are one slider apart — and the failure is a step down to silence on
// the quietest moment of the fight, which is a click exactly where nothing else
// is playing to hide it.
reset();
music.play(1);
run(0.05);
music.fadeMusicForBoss(arrivalRoom);
run(0.4); // less than half way out
const midCut = musicGainNode().gain.value;
check('the transport is still on its way out', midCut > owed * 0.4 && midCut < owed,
  `${midCut.toFixed(3)} of ${owed.toFixed(3)}`);
music.startBossMusic();
const cutIn = lastLoop().started;
const g = musicGainNode().gain;
check('...and it finishes into the switch rather than snapping to it',
  g.at(cutIn - 0.01) < midCut && g.at(cutIn - 0.01) >= 0,
  `${g.at(cutIn - 0.01).toFixed(4)} a hair before, from ${midCut.toFixed(3)}`);
check('...arriving at silence exactly when the boss loop starts',
  near(g.at(cutIn), 0, 1e-6), String(g.at(cutIn)));
run(0.3);
check('...and then back up', near(musicGainNode().gain.value, owed, 1e-6),
  String(musicGainNode().gain.value));
music.endBossMusic();

// A run restarted mid-ceremony must not open muted.
reset();
music.play(1);
run(0.05);
music.fadeMusicForBoss(arrivalRoom);
run(0.6);
music.play(1); // the player died and started again
run(0.1);
check('a run restarted mid-fade opens at full level',
  near(musicGainNode().gain.value, owed, 1e-6), String(musicGainNode().gain.value));

// ...and switching the handover OFF is the old behaviour exactly: no room, no
// silence, no latch, and the switch goes back to waiting for a bar line with
// the run's music playing straight through the entrance.
reset();
music.play(1);
run(0.05);
check('a disabled handover does nothing at all',
  music.fadeMusicForBoss({ ...arrivalRoom, enabled: false }) === false);
run(BAR / 3);
check('...the score is untouched', near(musicGainNode().gain.value, owed, 1e-6));
const beforeQuantised = loops().length;
music.startBossMusic();
check('...and the switch waits for a bar again', loops().length === beforeQuantised);
run(BAR);
check('...arriving on the bar line', playing() === 'boss0', String(playing()));
music.endBossMusic();

section('The bar grid measures the files, and says which one is wrong');
const report = Object.fromEntries(music.trackReport().map((r) => [r.name, r]));
check('a four-bar loop measures as four bars', report.boss0?.bars === 4, `${report.boss0?.bars} bars`);
check('a seven-bar loop measures as seven', report.boss3?.bars === 7, `${report.boss3?.bars} bars`);
check('an on-grid file reports no drift', near(report.boss1?.drift ?? 1, 0, 1e-6),
  `${((report.boss1?.drift ?? 0) * 1000).toFixed(1)}ms`);
// The real SealSurvivor_Boss_Loop01.mp3, to the millisecond: 192ms short of the
// eight bars it is written as. No loop point can repair that — the samples do
// not exist — so the one thing the code owes it is to SAY so.
await loadLoop('boss4', 17.928);
const short = music.trackReport().find((r) => r.name === 'boss4');
check('a file short of its bar count is still read as that many bars', short?.bars === 8, `${short?.bars} bars`);
check('...and the shortfall is reported rather than hidden',
  near(short?.drift ?? 0, -0.192, 0.001), `${((short?.drift ?? 0) * 1000).toFixed(0)}ms short of eight bars`);
music.stop();

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
