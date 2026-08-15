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
      start(when) { node.started = when ?? now; sources.push(node); },
      stop(when) { node.stopped = when ?? now; },
    });
    return node;
  }
  createOscillator() {
    return baseNode('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
  }
  async decodeAudioData(data) {
    const buffer = { duration: data?.seconds ?? 1, sampleRate: 48000 };
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
async function loadLoop(slot, seconds) {
  await music.loadTrackFromFile(slot, { name: `loop${slot}`, arrayBuffer: async () => ({ seconds }) });
}

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
check('the whole file loops, uncut', first.loop === true && !first.loopEnd,
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
check('nothing is clipped off the end', !longSrc.loopEnd,
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

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
