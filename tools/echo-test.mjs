#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:echo
//
// The celebration echo — CONFIG.audio.bus.echo, systems/audio.js, and the two
// lines in systems/celebrate.js that open and shut it.
//
// It is a send that is SILENT for the whole run and audible for about a
// second per boss kill, which makes every way of breaking it something you
// would never catch by playing:
//
//   STUCK OPEN     shut on the performance ending is one call in one function.
//                  Miss it and every sound for the rest of the run is echoed
//                  — which is not obviously a bug, it is just a game that
//                  sounds increasingly like a cave, and the run it started in
//                  is over before anyone thinks to blame the boss kill.
//   NEVER OPENS    the reverse costs nothing and shows nothing. The feature
//                  simply is not there, and a silent send looks exactly like a
//                  send you have not triggered yet.
//   RUNAWAY        feedback at or above 1 never decays. The bus climbs until
//                  it hits the limiter and stays there, which reads as "the
//                  game got louder", not as a delay line.
//   NOT IN THE     tapped straight to the destination instead of to `sum`, the
//   DYNAMICS       repeats bypass the compressor and swell every time the dry
//                  hit ducks. Same trap the reverb send has a comment about.
//
// So the graph is walked and the gain is read, against the same fake Web Audio
// API tools/sfx-bus-test.mjs uses.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`  ok    ${msg}`);

// --- the fake graph ---------------------------------------------------------
// Ramps land instantly on the target: the scheduling is the browser's job, and
// what this has to know is WHERE the gain was told to go.
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
  createOscillator() { return baseNode('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} }); }
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
const celebrate = await import('../path/src/systems/celebrate.js');

audio.unlockAudio();

// --- 1. it is wired, and wired into the dynamics stage ----------------------
// Walked from the delay rather than asserted by name, because "there is a
// DelayNode in the file" is not the claim — the claim is that its output
// reaches the same summing point the reverb does.
function reaches(node, kind, seen = new Set()) {
  if (!node || seen.has(node.id)) return false;
  seen.add(node.id);
  if (node.kind === kind) return true;
  return node.outputs.some((n) => reaches(n, kind, seen));
}
{
  const bus = audio.__busNodes?.();
  if (!bus?.echoDelay) fail('no delay node on the bus — the echo was never built');
  else {
    const wet = bus.echoDelay.outputs.find((n) => n === bus.echoWet);
    if (!wet) fail('the delay does not feed the wet gain');
    else if (!bus.echoWet.outputs.includes(bus.sumGain)) {
      fail('the echo lands somewhere other than the bus sum — it will bypass the compressor');
    } else pass('the echo sums with the dry and reverb paths, ahead of the dynamics stage');

    // The loop: delay -> tone -> feedback -> delay.
    if (!reaches(bus.echoDelay.outputs.find((n) => n.kind === 'biquad'), 'delay')) {
      fail('the feedback path does not return to the delay — there are no repeats');
    } else pass('the feedback path is damped and returns to the delay');
  }
}

// --- 2. shut during gameplay ------------------------------------------------
{
  const bus = audio.__busNodes?.();
  if (bus && bus.echoWet.gain.value !== 0) {
    fail(`the echo starts at ${bus.echoWet.gain.value}, not 0 — the whole run would be echoed`);
  } else pass('shut on boot');
}

// --- 3. opens on a celebration, shuts when it ends --------------------------
{
  const bus = audio.__busNodes?.();
  CONFIG.celebrate.enabled = true;
  const played = celebrate.playCelebration({ variant: celebrate.CELEBRATION_VARIANTS[0] });
  if (!played) fail('playCelebration refused a named variant — cannot test the hook');
  else if (!(bus.echoWet.gain.value > 0)) fail('a celebration started and the echo stayed shut');
  else {
    const wet = bus.echoWet.gain.value;
    if (Math.abs(wet - CONFIG.audio.bus.echo.wet) > 1e-6) {
      fail(`opened to ${wet}, not the configured ${CONFIG.audio.bus.echo.wet}`);
    } else pass(`opens to the configured wet level (${wet})`);

    // Run the performance out on its own clock, exactly as the game does.
    celebrate.updateCelebration(celebrate.celebrationState.duration + 0.01);
    if (celebrate.celebrationState.active) fail('the celebration did not end');
    else if (bus.echoWet.gain.value !== 0) {
      fail(`gameplay resumed with the echo at ${bus.echoWet.gain.value} — it is stuck open`);
    } else pass('shuts when the performance ends');
  }
}

// --- 4. a torn-down celebration shuts it too --------------------------------
// resetCelebration is called directly by entities/player.js when a run ends,
// without the clock ever reaching `duration`. That path has to close the send
// as well, or the echo follows the player into the menu.
{
  const bus = audio.__busNodes?.();
  celebrate.playCelebration({ variant: celebrate.CELEBRATION_VARIANTS[0] });
  celebrate.resetCelebration();
  if (bus.echoWet.gain.value !== 0) fail('a celebration cut short left the echo open');
  else pass('a run ending mid-celebration shuts it');
}

// --- 5. the fades are the configured ones -----------------------------------
{
  const bus = audio.__busNodes?.();
  const e = CONFIG.audio.bus.echo;
  now = 100;
  celebrate.playCelebration({ variant: celebrate.CELEBRATION_VARIANTS[0] });
  const inEnd = bus.echoWet.gain.rampEnd;
  celebrate.resetCelebration();
  const outEnd = bus.echoWet.gain.rampEnd;
  const ok = Math.abs(inEnd - (100 + e.fadeIn)) < 1e-6 && Math.abs(outEnd - (100 + e.fadeOut)) < 1e-6;
  if (!ok) fail(`fades ran to ${inEnd} / ${outEnd}, expected ${100 + e.fadeIn} / ${100 + e.fadeOut}`);
  else pass(`fades in over ${e.fadeIn}s and out over ${e.fadeOut}s, on the audio clock`);
}

// --- 6. the loop can decay --------------------------------------------------
{
  const bus = audio.__busNodes?.();
  CONFIG.audio.bus.echo.feedback = 5;
  audio.applyAudioBusSettings();
  const g = bus.echoFeedback.gain.value;
  if (!(g < 1)) fail(`feedback clamped to ${g} — at or above 1 the delay never decays`);
  else pass(`feedback is clamped below 1 (asked for 5, got ${g})`);
  CONFIG.audio.bus.echo.feedback = 0.42;
  audio.applyAudioBusSettings();
}

// --- 7. switching it off means off ------------------------------------------
{
  const bus = audio.__busNodes?.();
  CONFIG.audio.bus.echo.enabled = false;
  celebrate.playCelebration({ variant: celebrate.CELEBRATION_VARIANTS[0] });
  if (bus.echoWet.gain.value !== 0) fail('disabled in the config and it opened anyway');
  else pass('`enabled: false` keeps it shut through a celebration');
  celebrate.resetCelebration();
  CONFIG.audio.bus.echo.enabled = true;
}

console.log(failures ? `\n  ${failures} failure(s)\n` : '\n  celebration echo: all good\n');
process.exit(failures ? 1 : 0);
