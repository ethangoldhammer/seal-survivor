#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chargesound
//
// THE THREE THINGS A STRIKE WIND-UP SAYS, and none of them is a one-shot fired
// at a moment you can screenshot:
//
//   THE HELD VOICE   CONFIG.strike.charge.bed, run by the jet's bed engine
//                    (systems/jetBed.js). One sound from the press to the
//                    let-go, thrown into a short room on the way out, and
//                    silent until the next press.
//   THE BURN RUN     one blip per pip SPENT, climbing `burnSemitones` a pip.
//                    Raised from updateCharge through onStrikeBurnPip.
//   THE ARRIVAL      `strikePerfect` on the frame "STRIKE NOW!" goes up.
//
// WHY THIS NEEDS A TEST AT ALL. Every failure available here is silent or
// nearly so, and none of them is visible in a frame:
//
//   COUNTED ON THE BANK     `pending` and `charge` move together on an
//                           ordinary hold, so counting pips off the wrong one
//                           is correct until something fills the meter
//                           mid-wind-up (the sun's trickle). Then the bank
//                           tops out with fuel still burning, the run goes
//                           quiet a beat early, and it only ever happens in
//                           daylight.
//   GATED ON `charging`     which goes false on the frame the tank runs dry —
//                           and that frame IS "STRIKE NOW!". A bed hung off it
//                           cuts out at the exact moment the player is being
//                           asked to commit. It sounds like a deliberate
//                           choice.
//   THE RUN RESTARTS HIGH   `burnedPips` not cleared on a new hold: the second
//                           wind-up of a run starts where the first left off
//                           and every one after it is higher, which reads as
//                           the game getting more excited rather than as a
//                           counter nobody reset.
//   A LEAKED ROOM           the convolver on the release tail is per wind-up.
//                           Never disconnected, it is one live convolver per
//                           strike for the length of the run, and a run is
//                           hundreds of strikes. Nothing sounds wrong.
//   THE CPU'S WIND-UPS      a match runs updateCharge for every seal on the
//                           board. A hook that does not ask whose state it is
//                           blips in the player's ears for all of them.
//
// Expectations are computed from CONFIG, never typed in: saved tuning beats
// the config defaults (imported-tuning.json is merged at import), so a
// hardcoded 2 semitones here would be a test of the tuning file.
//
// What it cannot tell you: whether the run FEELS like a count-in. That is a
// controller in your hands.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import './dom-stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`  ok    ${msg}`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- the fake Web Audio API -------------------------------------------------
// The same shape tools/echo-test.mjs and tools/sfx-bus-test.mjs use: ramps land
// instantly on their target, because the scheduling is the browser's job and
// what this has to know is WHERE a gain was told to go. `rampEnd` is kept
// because the release tail's whole argument is about ORDER — the send climbing
// while the dry path falls — and that is a claim about times, not values.
class Param {
  constructor(v = 0) { this.value = v; this.ramps = []; }
  setValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.rampEnd = t; this.ramps.push([v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.rampEnd = t; this.ramps.push([v, t]); return this; }
  cancelScheduledValues() { return this; }
}
let nodeId = 0;
const live = new Set();          // every node built, so a leak is countable
const baseNode = (kind, extra = {}) => {
  const n = {
    kind, id: ++nodeId, outputs: [], disconnected: false,
    connect(dest) { this.outputs.push(dest); return dest; },
    disconnect() { this.outputs.length = 0; this.disconnected = true; },
    ...extra,
  };
  live.add(n);
  return n;
};
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
  createBuffer(ch, len) {
    return { numberOfChannels: ch, length: len, sampleRate: 48000, getChannelData: () => new Float32Array(len) };
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
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const jetBed = await import('../path/src/systems/jetBed.js');
const strike = await import('../path/src/systems/strike.js');

audio.unlockAudio();

const {
  updateCharge, onStrikeBurnPip, strikeState, resetStrike,
  pipCount, windUpTime, strikeLoaded, perfectCrossed, minFire,
} = strike;

// A stat block the real recomputeStats would produce, so nothing here depends
// on a card being picked. Only the fields the wind-up reads.
const baseStats = () => ({
  strikeChargeTime: CONFIG.strike.charge.time,
  strikeChumRefill: CONFIG.strike.charge.chumRefill,
  strikeExtraPips: 0,
  strikePipRegen: 0,
});

// Hold the button for `seconds`, in 60fps frames, collecting what the burn
// hook says. Returns the blips in order.
function holdFor(seconds, stats, { dt = 1 / 60, fill = null } = {}) {
  const blips = [];
  onStrikeBurnPip((burned, total) => blips.push({ burned, total }));
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    fill?.(i);
    updateCharge(dt, true, stats);
  }
  onStrikeBurnPip(null);
  return blips;
}

console.log('\nTHE BURN RUN — one blip per pip spent\n');

// --- 1. a full bar is exactly its own length in blips ------------------------
{
  resetStrike();
  const stats = baseStats();
  strikeState.charge = 1;
  const n = pipCount(stats);
  // Long enough to empty the tank with room to spare, so the count is the
  // bar's length and not the length of the test.
  const blips = holdFor(windUpTime(stats) * 1.5, stats);
  if (blips.length !== n) {
    fail(`a full bar burned ${blips.length} pips, and the bar is ${n} long`);
  } else pass(`a full bar is ${n} blips — one per pip, no more`);

  const counts = blips.map((b) => b.burned);
  const ascending = counts.every((v, i) => v === i + 1);
  if (!ascending) fail(`the run does not count 1..n — ${counts.join(',')}`);
  else pass('...counted 1..n within the hold, so the pitch has something to climb');

  if (blips.some((b) => b.total !== n)) fail('a blip reported a bar length that is not the bar');
  else pass(`...and every one of them knows the bar is ${n} long`);
}

// --- 2. evenly spaced, because the drain is what paces them ------------------
// The claim the design rests on: the blips are a CLOCK the player can hear the
// top of coming. Queued behind a pipGap floor (which is right for the fill)
// they would drift off the bar they describe.
{
  resetStrike();
  const stats = baseStats();
  strikeState.charge = 1;
  const dt = 1 / 240;   // finer than a frame, so the spacing is measurable
  const at = [];
  onStrikeBurnPip(() => at.push(t));
  let t = 0;
  const n = pipCount(stats);
  const total = windUpTime(stats);
  for (let i = 0; i < Math.round(total * 1.2 / dt); i++) { t += dt; updateCharge(dt, true, stats); }
  onStrikeBurnPip(null);

  const want = total / n;
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - want)));
  // One frame of the fine step, which is the quantisation and not a drift.
  if (!(worst <= dt * 1.5)) {
    fail(`the blips are uneven — worst gap is ${worst.toFixed(4)}s off the ${want.toFixed(4)}s the drain implies`);
  } else pass(`evenly spaced at ${want.toFixed(3)}s — the run is a clock (worst error ${(worst * 1000).toFixed(1)}ms)`);
}

// --- 3. COUNTED ON THE TANK, NOT ON THE BANK --------------------------------
// The sun's trickle (CONFIG.dayNight.pass.sun.charge) tops the BANK out with
// fuel still in the tank. `pending` then stops crossing boundaries while the
// burn is still burning — so a count taken off the bank goes quiet partway
// through, in daylight only.
{
  resetStrike();
  const stats = baseStats();
  strikeState.charge = 1;
  const n = pipCount(stats);
  // Bank full from the first frame, tank untouched: the exact state the sun
  // produces, arranged directly so the test does not depend on the day/night
  // pass being enabled.
  const blips = holdFor(windUpTime(stats) * 1.5, stats, {
    fill: () => { strikeState.pending = 1; },
  });
  if (blips.length !== n) {
    fail(`with the bank pinned full, the run was ${blips.length} blips instead of ${n} — it is counting the bank`);
  } else pass(`a bank pinned full still burns all ${n} pips — the count is on the fuel`);
}

// --- 4. a new hold starts the run over --------------------------------------
{
  resetStrike();
  const stats = baseStats();
  strikeState.charge = 1;
  holdFor(windUpTime(stats) * 0.5, stats);
  const mid = strikeState.burnedPips;
  if (!(mid > 0)) fail('half a wind-up burned no pips at all');

  // Let go for a frame, then hold again. The release frame arrives with `held`
  // already false, which is the shape input.js produces.
  updateCharge(1 / 60, false, stats);
  strikeState.charge = 1;
  const second = holdFor(windUpTime(stats) * 0.5, stats);
  if (!second.length) fail('the second hold burned nothing');
  else if (second[0].burned !== 1) {
    fail(`the second wind-up opened its run at ${second[0].burned}, not 1 — the counter carried over and every hold after the first is higher`);
  } else pass('a new hold opens its run at the bottom again');
}

// --- 5. the pitch, as main.js computes it -----------------------------------
// The mapping itself, held against the config rather than against a number,
// and checked at the one place it has to stop climbing.
{
  const c = CONFIG.strike.charge;
  const per = c.burnSemitones ?? 2;
  const max = c.burnSemitonesMax ?? 14;
  const semis = (burned) => Math.min(max, (burned - 1) * per);
  const pitch = (burned) => Math.pow(2, semis(burned) / 12);

  if (!near(pitch(1), 1)) fail(`the first blip is pitched ${pitch(1)}, not 1 — the run does not start where the voice is authored`);
  else pass('the first blip of a hold is the voice at its written pitch');

  if (!(pitch(2) > pitch(1))) fail('the run does not climb');
  else pass(`it climbs ${per} semitone(s) a pip — the strike getting bigger, not the bar getting emptier`);

  const capAt = Math.floor(max / per) + 1;
  if (!near(semis(capAt + 5), max)) fail(`the climb does not stop at ${max} semitones — a long bar ends in whistle territory`);
  else pass(`...and flattens at ${max} semitones, so a 12-pip bar stays in register`);
}

// --- 6. a match's other seals stay out of the player's ears -----------------
{
  resetStrike();
  const stats = baseStats();
  // A second state, the way systems/versus.js keeps one per seal.
  const other = JSON.parse(JSON.stringify(strikeState));
  other.charge = 1;
  other.charging = false;
  let heard = 0;
  onStrikeBurnPip(() => heard++);
  for (let i = 0; i < Math.round(windUpTime(stats) * 1.5 * 60); i++) updateCharge(1 / 60, true, stats, other);
  onStrikeBurnPip(null);
  if (heard !== 0) fail(`a CPU seal's wind-up fired ${heard} blips in the player's ears`);
  else pass("another seal's wind-up is silent to this one");
  if (!(other.burnedPips > 0)) fail('...but it did not count its own pips either, so the state is not being updated');
  else pass(`...while still counting its own (${other.burnedPips})`);
}

console.log('\nTHE ARRIVAL — "STRIKE NOW!"\n');

// --- 7. one edge, on the loaded frame, once ---------------------------------
{
  resetStrike();
  const stats = baseStats();
  strikeState.charge = 1;
  let edges = 0, atLoaded = false;
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(windUpTime(stats) * 2 / dt); i++) {
    updateCharge(dt, true, stats);
    if (perfectCrossed()) { edges++; atLoaded = strikeLoaded(); }
  }
  if (edges !== 1) fail(`the arrival fired ${edges} times across one hold — it must be an edge`);
  else pass('fires exactly once per wind-up');
  if (!atLoaded) fail('...but not on the frame "STRIKE NOW!" went up — the sound and the prompt have drifted apart');
  else pass('...on the same frame the prompt goes up and the sweet spot opens');
}

// --- 8. it is a hit, not one more note of the run ---------------------------
// The design claim, asserted where it lives: the run and the arrival must not
// be the same instrument, or the arrival is the last blip rather than the
// thing the blips were counting toward.
{
  const burn = CONFIG.sfx.strikeBurn;
  const arrive = CONFIG.sfx.strikePerfect;
  if (!burn) fail('CONFIG.sfx.strikeBurn is missing — the run has no voice');
  else pass('the burn has a voice of its own');
  // THE ARRIVAL MUST NOT BE MORE OF THE RUN. A run of triangle blips that
  // resolves onto one more triangle blip is its own last note, not the thing
  // it was counting toward — so this asks that the two are different material.
  //
  // A SAMPLE SATISFIES IT OUTRIGHT, and today that is how it is satisfied: the
  // takes on this voice are assigned in imported-tuning.json, which replaces
  // the synth below it entirely. Asserted against `srcs` as well as `src`
  // because the tuning file writes the take LIST, and a check that only knew
  // about `src` would report a voice with eleven takes on it as silent.
  const takes = (def) => (def?.srcs?.length ?? 0) + (def?.src ? 1 : 0);
  if (!arrive) fail('CONFIG.sfx.strikePerfect is missing');
  else if (takes(arrive) > 0) {
    pass(`the arrival is ${takes(arrive)} assigned take(s), against the run's '${burn?.type}' synth`);
  } else if (arrive.type === burn?.type && arrive.wave === burn?.wave) {
    fail('the arrival fell back to the same synth as the run — with no takes on it, it resolves onto more of itself');
  } else pass(`the arrival is a '${arrive.type}' against the run's '${burn?.type}'`);
  // pitchVary on either would blur a window a tenth of a second wide.
  for (const [name, def] of [['strikeBurn', burn], ['strikePerfect', arrive]]) {
    if (def && (def.pitchVary ?? 0) !== 0) fail(`${name} has pitchVary ${def.pitchVary} — the pitch is a reading and must not wobble`);
    else pass(`${name} has no random pitch — the reading stays readable`);
  }
}

console.log('\nTHE HELD VOICE — press to let-go, then the room\n');

// --- 9. it holds, and re-asking does not re-trigger it ----------------------
{
  const bed = CONFIG.strike.charge.bed;
  if (!bed) fail('CONFIG.strike.charge.bed is missing — the wind-up has no held voice');

  const key = { test: true };
  now = 0;
  const started = jetBed.startJetBed(key, bed);
  if (!started) fail('the bed refused to open');
  else pass('opens on the press');

  const again = jetBed.startJetBed(key, bed);
  if (jetBed.jetBedCount() !== 1) fail(`re-asking opened a second voice — ${jetBed.jetBedCount()} are running`);
  else pass('...and asking again every frame is a no-op, not sixty attacks a second');
  if (again !== true) fail('re-asking reported failure on a bed that is running');

  const st = jetBed.jetBedState(key);
  if (!st) fail('no state for an open bed');
  else if (!st.tail) fail('the bed opened WITHOUT its room — the release will just stop');
  else pass('...with a room to be cut into');

  jetBed.releaseJetBed(key);
  if (jetBed.jetBedPlaying(key)) fail('the bed survived its release — a sound that never stops');
  else pass('released on the let-go, and silent until the next press');
}

// --- 10. THE ROOM IS FED THROUGHOUT AND THROWN ON THE RELEASE ---------------
// The trap systems/audio.js documents from the other side: gate the INPUT and
// the line is empty at the moment you open it, so the tail carries everything
// except the sound that just ended.
{
  const bed = CONFIG.strike.charge.bed;
  const key = { test: 2 };
  now = 0;
  const before = new Set(live);
  jetBed.startJetBed(key, bed);

  // Find the convolver this bed built, and the gain feeding it.
  const fresh = [...live].filter((n) => !before.has(n));
  const verb = fresh.find((n) => n.kind === 'convolver');
  const send = fresh.find((n) => n.kind === 'gain' && n.outputs.includes(verb));
  if (!verb) fail('no convolver was built for the tail');
  else if (!send) fail('the convolver is fed by nothing — the room is silent');
  else {
    if (!(send.gain.value > 0)) {
      fail(`the send sits at ${send.gain.value} during the hold — the line is empty when the release opens it`);
    } else pass(`fed for the whole hold at ${send.gain.value} — the room has the sound in it before the cut`);

    // The gate, not the envelope: a bed muted by the menu must take its room
    // with it, or the reverb keeps ringing under an open pause menu.
    const feeder = fresh.find((n) => n.outputs.includes(send));
    const master = audio.getSfxBus();
    if (!feeder || !feeder.outputs.includes(master)) {
      fail('the send hangs off a node that does not also reach the bus — it is not on the gate');
    } else pass('...hung off the menu gate, so a paused wind-up takes its room down too');

    const held = send.gain.value;
    now = 5;
    jetBed.releaseJetBed(key);
    const peak = Math.max(...send.gain.ramps.map(([v]) => v));
    if (!(peak > held)) {
      fail(`the send was never pushed past its held level on release (${peak} vs ${held}) — nothing is thrown anywhere`);
    } else pass(`thrown on the release — send pushed to ${peak.toFixed(3)} from ${held}`);

    const last = send.gain.ramps[send.gain.ramps.length - 1];
    if (!last || last[0] !== 0) fail('the send never shuts — the room re-triggers on the end of the fade');
    else pass('...and then shut, so the tail rings out of a send that is no longer feeding it');
  }
}

// --- 11. the room does not leak ---------------------------------------------
// One convolver per wind-up, and a run is hundreds of them. Nothing sounds
// wrong; the tab just gets heavier.
{
  const bed = CONFIG.strike.charge.bed;
  const key = { test: 3 };
  now = 0;
  const before = new Set(live);
  jetBed.startJetBed(key, bed);
  const fresh = [...live].filter((n) => !before.has(n));
  const verb = fresh.find((n) => n.kind === 'convolver');
  now = 1;
  jetBed.releaseJetBed(key);

  // The disconnect is scheduled for after the ring, so this has to wait it out.
  const t = bed.tail ?? {};
  const waitMs = ((bed.release ?? 0.12) + (t.seconds ?? 0.6) * 2) * 1000 + 300;
  await new Promise((r) => setTimeout(r, waitMs));
  if (verb && !verb.disconnected) {
    fail('the convolver is still connected after its tail — one live room per strike, for the whole run');
  } else pass('the room is torn off once it has finished ringing');
}

console.log('\nWIRING — main.js\n');

// --- 12. the bed follows the BUTTON, not `charging` -------------------------
// Source-read rather than simulated, the way tools/charge-fx-test.mjs reads its
// wiring: the failure is one identifier, it is invisible in every frame before
// the tank runs dry, and the frame it shows up on is the one that matters most.
{
  const src = fs.readFileSync(path.join(ROOT, 'path', 'src', 'main.js'), 'utf8');
  const m = src.match(/const wantChargeBed = ([^\n;]+);/);
  if (!m) fail('main.js does not decide whether to hold the charge bed — it is not wired');
  else {
    const expr = m[1];
    if (/strikeState\.charging/.test(expr)) {
      fail('the bed is gated on `strikeState.charging`, which goes false on the frame the tank runs dry — it cuts out exactly at "STRIKE NOW!"');
    } else if (!/input\.strikeHeld/.test(expr)) {
      fail(`the bed is not gated on the button — \`${expr.trim()}\``);
    } else pass('held for as long as the button is down, past the frame the fuel runs out');
  }
  if (!/releaseJetBed\(CHARGE_BED_KEY, 0\.05\)/.test(src)) {
    fail('nothing releases the charge bed on a run reset — a run ended mid-hold leaves it sounding forever');
  } else pass('released on a run reset, so a death mid-hold cannot leave it open');
  if (!/onStrikeBurnPip\(/.test(src)) fail('main.js never listens for burn pips — the run is silent');
  else pass('the burn run is listened for');
}

const label = failures ? `${failures} FAILED` : 'All charge-sound checks passed.';
console.log(`\n${label}\n`);
process.exit(failures ? 1 : 0);
