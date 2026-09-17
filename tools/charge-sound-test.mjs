#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chargesound
//
// THE THREE THINGS A STRIKE WIND-UP SAYS, and none of them is a one-shot fired
// at a moment you can screenshot:
//
//   THE HELD VOICE   CONFIG.strike.charge.bed, run by the jet's bed engine
//                    (systems/jetBed.js). One sound from the press to the
//                    let-go, CUT there rather than faded, and silent until the
//                    next press. What tail it has is the shared sfx bus's
//                    reverb, the same one the rest of the mix is in.
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
//   A TAIL OF ITS OWN       a private room per bed rings on after the gesture
//                           that made it has ended — over the dash the wind-up
//                           just became — and puts one sound in a different
//                           space from everything around it. There was one
//                           here; the checks that it is gone are what stop it
//                           coming back as a plausible-looking feature.
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
const note = (text) => console.log(`        ${text}`);
const check = (name, cond, detail = '') => (cond ? pass(`${name}${detail ? ' — ' + detail : ''}`)
  : fail(`${name}${detail ? ' — ' + detail : ''}`));

// --- the fake Web Audio API -------------------------------------------------
// The same shape tools/echo-test.mjs and tools/sfx-bus-test.mjs use: ramps land
// instantly on their target, because the scheduling is the browser's job and
// what this has to know is WHERE a gain was told to go. `rampEnd` is kept
// because the release tail's whole argument is about ORDER — the send climbing
// while the dry path falls — and that is a claim about times, not values.
class Param {
  constructor(v = 0) { this.value = v; this.ramps = []; this.targets = []; }
  setValueAtTime(v) { this.value = v; return this; }
  // RECORDED, not just applied. setTargetAtTime is the one automation with no
  // end time, and an outstanding one is what made a released bed impossible to
  // silence — so the harness has to be able to ask whether any were used, not
  // only where the value ended up. See "the release can actually reach zero".
  setTargetAtTime(v, t, tc) { this.value = v; this.targets.push([v, t, tc]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.rampEnd = t; this.ramps.push([v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.rampEnd = t; this.ramps.push([v, t]); return this; }
  cancelScheduledValues() { this.cancels = (this.cancels ?? 0) + 1; return this; }
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
  chargeEnvelope, chargeEnvelopeTop,
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
  // THE RUN'S PITCH IS A READING AND MUST NOT WOBBLE. Each blip is a rung on a
  // ladder the player is counting, and `pitchVary` on it would blur the one
  // thing it says — how far along the wind-up is — a tenth of a second either
  // side of a window that is a tenth of a second wide.
  if (burn && (burn.pitchVary ?? 0) !== 0) {
    fail(`strikeBurn has pitchVary ${burn.pitchVary} — the run is a ladder and a wobbly rung is not on it`);
  } else pass('the run has no random pitch — the ladder stays countable');
  // THE ARRIVAL IS NOT ASSERTED, and that is deliberate rather than an
  // oversight. It is ONE hit, not a rung: nothing is being counted off its
  // pitch, so a wobble on it varies the take instead of blurring a reading —
  // which is a taste decision and belongs to whoever is holding the F panel.
  // This check used to demand 0 here and started failing the moment somebody
  // tuned it, which is a test asserting authorship rather than behaviour.
  note(`the arrival's pitchVary is ${arrive?.pitchVary ?? 0} — taste, not asserted`);
}

console.log('\nTHE HELD VOICE — press to let-go, then nothing\n');

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
  else pass('...and reports itself open');

  jetBed.releaseJetBed(key);
  if (jetBed.jetBedPlaying(key)) fail('the bed survived its release — a sound that never stops');
  else pass('released on the let-go, and silent until the next press');
}

// --- 10. NO ROOM OF ITS OWN — the bus carries it ---------------------------
// There was a private convolver per bed, built to make a release "land
// somewhere". It did the opposite twice: it put one sound in a different space
// from the rest of the mix, and it rang for half a second after the gesture
// that made it had ended — over the dash the wind-up had just become. A driven
// bed has to be gone when its driver stops, and a private tail is the one
// thing that can outlive a hard cut.
//
// The tail a released bed has is the BUS's, which it is already in by virtue of
// landing on it like every other sound in the game.
{
  const bed = CONFIG.strike.charge.bed;
  check('the block asks for no room of its own', !bed.tail);

  const key = { test: 2 };
  now = 0;
  const before = new Set(live);
  jetBed.startJetBed(key, bed);
  const fresh = [...live].filter((n) => !before.has(n));

  check('...and none is built', !fresh.some((n) => n.kind === 'convolver'),
    `${fresh.filter((n) => n.kind === 'convolver').length} convolver(s)`);

  // THE ROUTE TO THE SHARED REVERB. The bus is `master`, and systems/audio.js
  // sends it through busFilter -> convolver -> wetGain alongside the dry path.
  // A bed that landed anywhere else would be dry while the rest of the mix was
  // not, which is a thing you would hear and never be able to name.
  const bus = audio.getSfxBus();
  const reaches = (node, target, seen = new Set()) => {
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    if (node === target) return true;
    return node.outputs.some((n) => reaches(n, target, seen));
  };
  const gateNode = fresh.find((n) => n.kind === 'gain' && n.outputs.includes(bus));
  check('the bed lands on the shared bus, so the bus reverb carries it',
    !!gateNode && reaches(gateNode, bus));
  const busConv = audio.__busNodes?.();
  check('...and that bus really has a reverb send on it', !!busConv?.wetGain);

  jetBed.releaseJetBed(key);
  check('nothing of it is left afterwards', !jetBed.jetBedPlaying(key));
}

console.log('\nTHE ENVELOPE — the meter IS the sound\n');

// --- 13. one curve, and it is the meter ------------------------------------
// The bed used to spool on a fixed ramp and then hold, which is the jet's
// shape and is wrong here: a wind-up is worth however much fuel there was. A
// hold begun on a half-full bar has to peter out where the fuel runs out, and
// a scheduled ramp cannot know that.
{
  check('an empty wind-up is not silent', chargeEnvelope(0) > 0, `${chargeEnvelope(0).toFixed(3)} at rest`);
  check('...because the PRESS is the event', chargeEnvelope(0) >= 0.15);
  check('a full one is the top of the curve', Math.abs(chargeEnvelope(1) - 1) < 1e-9, `${chargeEnvelope(1)}`);
  check('...and it only ever climbs', [0, 0.25, 0.5, 0.75, 1]
    .every((p, i, a) => i === 0 || chargeEnvelope(p) > chargeEnvelope(a[i - 1])));
  // NORMALISED, which is the whole reason this function exists rather than the
  // expression that was inline: something maps it onto a GAIN now, and the raw
  // curve tops out at 1.45 — a bed driven to 1.45x its own peak is 3dB over
  // the level it was tuned at, on every full charge.
  check('it is normalised, so a gain can read it', chargeEnvelope(1) <= 1 + 1e-9);
  // ...and the motor keeps the range it was tuned at.
  check('the rumble keeps its old range', Math.abs(chargeEnvelope(1) * chargeEnvelopeTop() - 1.45) < 1e-9,
    `${(chargeEnvelope(1) * chargeEnvelopeTop()).toFixed(3)} at full charge`);
  check('...which is above 1 on purpose', chargeEnvelopeTop() > 1);
  // Clamped, because `pending` is read off live state and a NaN or an
  // overshoot handed to a gain is a silent bed or a blown one.
  check('a junk reading cannot escape it',
    chargeEnvelope(NaN) >= 0 && chargeEnvelope(-5) >= 0 && chargeEnvelope(99) <= 1 + 1e-9,
    `NaN ${chargeEnvelope(NaN).toFixed(2)}, -5 ${chargeEnvelope(-5).toFixed(2)}, 99 ${chargeEnvelope(99).toFixed(2)}`);
}

// --- 14. the bed is driven, and the drive reaches it ------------------------
{
  const bed = CONFIG.strike.charge.bed;
  check('the charge bed asks to be driven', bed.envelope === true);

  const key = { test: 4 };
  now = 0;
  jetBed.startJetBed(key, bed);
  const st0 = jetBed.jetBedState(key);
  check('...and opens driven', st0?.driven === true);
  // A DRIVEN BED WITH NOBODY DRIVING IT IS SILENT, which looks exactly like one
  // that failed to open — hence the readout.
  check('...at nothing, until something drives it', st0?.level === 0, `level ${st0?.level}`);

  jetBed.driveJetBed(key, chargeEnvelope(0));
  const low = jetBed.jetBedState(key).level;
  jetBed.driveJetBed(key, chargeEnvelope(1));
  const high = jetBed.jetBedState(key).level;
  check('driving it moves it', high > low, `${low.toFixed(3)} -> ${high.toFixed(3)}`);
  check('...to the top of the curve at a full charge', Math.abs(high - 1) < 1e-9);

  // Out-of-range input is clamped rather than trusted: this number becomes a
  // gain and a cutoff, and both have a wrong side.
  jetBed.driveJetBed(key, 9);
  check('...and never past it', jetBed.jetBedState(key).level <= 1 + 1e-9);
  jetBed.driveJetBed(key, NaN);
  check('...nor anywhere at all on a junk reading', jetBed.jetBedState(key).level === 0);

  jetBed.releaseJetBed(key);
}

// --- 15. a spooled bed ignores the drive -----------------------------------
// Two authorities on one AudioParam is not a blend — the param does both,
// which sounds like the envelope being ignored for `ramp` seconds and then
// suddenly working. So the jet keeps its spool and refuses to be driven.
{
  const key = { test: 5 };
  now = 0;
  jetBed.startJetBed(key, CONFIG.bubbleJet.bed);
  check('the jet is NOT driven', jetBed.jetBedState(key)?.driven === false);
  check('...and refuses a drive', jetBed.driveJetBed(key, 1) === false);
  jetBed.releaseJetBed(key);
  check('driving a bed that is not open says so', jetBed.driveJetBed(key, 1) === false);
}

// --- 16. THE RELEASE CAN ACTUALLY REACH ZERO -------------------------------
// The bug this exists for: driveJetBed drove the gain with setTargetAtTime,
// which has no end time, and cancelScheduledValues only clears events at or
// after the cancel — so the per-frame automation outlived the release and went
// on pulling the gain back up underneath the ramp to 0. The ramp never
// arrived, and then source.stop() cut a still-sounding oscillator stack dead.
//
// A click at full amplitude, into a half-second synthetic-noise room, is a
// comb filter ringing. It was reported as two bugs — "the charge sound isn't
// cutting on release" and "it echoes with a lot of feedback under 100ms" —
// and it was this one thing.
//
// UNHEARABLE IN THIS HARNESS, because the fake ramps land instantly. What IS
// decidable here is the SHAPE of the automation, which is where the bug lived:
// nothing unbounded may be outstanding on a param that has to be able to reach
// a value and stay there.
{
  const bed = CONFIG.strike.charge.bed;
  const key = { test: 6 };
  now = 0;
  const before = new Set(live);
  jetBed.startJetBed(key, bed);
  const fresh = [...live].filter((n) => !before.has(n));

  // Drive it like a real wind-up: a second of frames climbing to full.
  for (let i = 0; i <= 60; i++) { now = i / 60; jetBed.driveJetBed(key, chargeEnvelope(i / 60)); }

  // The bed's own envelope gain — the node feeding the gate.
  const gateNode = fresh.find((n) => n.kind === 'gain' && n.outputs.includes(audio.getSfxBus()));
  const env = fresh.find((n) => n.kind === 'gain' && n.outputs.includes(gateNode));
  if (!env) { fail('could not find the bed\'s envelope gain — the graph changed'); }
  else {
    check('the drive leaves nothing unbounded on the level',
      env.gain.targets.length === 0,
      `${env.gain.targets.length} setTargetAtTime call(s)`);
    check('...and it did move it', env.gain.ramps.length > 0 && env.gain.value > 0,
      `${env.gain.ramps.length} ramp(s), at ${env.gain.value.toFixed(3)}`);
    // The filter is driven by the same call and had the same trap.
    const filters = fresh.filter((n) => n.kind === 'biquad');
    check('...nor on the cutoff', filters.every((f) => f.frequency.targets.length === 0),
      `${filters.reduce((n, f) => n + f.frequency.targets.length, 0)} across ${filters.length} pole(s)`);

    now = 2;
    jetBed.releaseJetBed(key);
    check('the release ramps the level to zero', env.gain.value === 0,
      `ends at ${env.gain.value}`);
    const last = env.gain.ramps[env.gain.ramps.length - 1];
    check('...and zero is the LAST thing scheduled on it', last && last[0] === 0,
      last ? `last ramp -> ${last[0]}` : 'no ramps');
    // The stop has to land after the fade, or the fade is decoration and the
    // click happens anyway.
    // THE CUT IS NOT `release`, and must not be. A driven bed is switched off
    // rather than faded out: the thing handing it a level has stopped, and on
    // the very next frame the dash launches. A wind-up still tapering across
    // its own release is the charge outliving the strike it became — which is
    // exactly how it was reported.
    const fadeLen = last ? last[1] - 2 : Infinity;
    check('the cut is immediate, not a release fade', fadeLen <= 0.02 + 1e-9,
      `${(fadeLen * 1000).toFixed(0)}ms`);
    check('...and far shorter than the block\'s own release', fadeLen < (bed.release ?? 0.12),
      `${(fadeLen * 1000).toFixed(0)}ms against a ${((bed.release ?? 0.12) * 1000).toFixed(0)}ms release`);
    // ...but long enough to declick. A saturated oscillator stack cut in one
    // sample is a pop, which is the one artefact worse than a tail.
    check('...but not a hard zero, which would pop', fadeLen > 0.004, `${(fadeLen * 1000).toFixed(0)}ms`);
  }
}

// --- 17. a spooled bed still fades ------------------------------------------
// The cut belongs to DRIVEN beds. The jet is a stream that ends, and tapering
// is the right shape for one — so this asserts the two do not share a rule.
{
  const jet = CONFIG.bubbleJet.bed;
  const key = { test: 7 };
  now = 0;
  const before = new Set(live);
  jetBed.startJetBed(key, jet);
  const fresh = [...live].filter((n) => !before.has(n));
  const gateNode = fresh.find((n) => n.kind === 'gain' && n.outputs.includes(audio.getSfxBus()));
  const env = fresh.find((n) => n.kind === 'gain' && n.outputs.includes(gateNode));
  now = 3;
  jetBed.releaseJetBed(key);
  const last = env?.gain.ramps[env.gain.ramps.length - 1];
  const fadeLen = last ? last[1] - 3 : 0;
  check('the jet still fades on its own release', Math.abs(fadeLen - (jet.release ?? 0.12)) < 1e-6,
    `${(fadeLen * 1000).toFixed(0)}ms, block says ${((jet.release ?? 0.12) * 1000).toFixed(0)}ms`);
  check('...which is longer than a driven cut', fadeLen > 0.02);
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
  // DRIVEN EVERY FRAME THE BED IS OPEN, not only while `charging`. The two part
  // company for the whole back half of a wind-up — charging goes false when the
  // tank runs dry and the button stays down through "STRIKE NOW!" — so a drive
  // inside the charging branch freezes the bed at whatever level it reached and
  // sits on it until the release.
  const drive = src.match(/if \(chargeBedOpen\) driveJetBed\(CHARGE_BED_KEY, ([^)]+)\);/);
  if (!drive) fail('main.js never hands the bed its level — a driven bed with nobody driving it is silent');
  else pass('the bed is driven off the envelope');
  const chargingBranch = src.indexOf('if (strikeState.charging) {');
  const driveAt = drive ? src.indexOf(drive[0]) : -1;
  if (driveAt >= 0 && chargingBranch >= 0 && driveAt > chargingBranch) {
    fail('the drive is inside the `charging` branch — it stops at the frame the tank runs dry, which is "STRIKE NOW!"');
  } else pass('...outside the `charging` branch, so it keeps moving through "STRIKE NOW!"');
  if (!/scale: chargeEnv \* chargeEnvelopeTop\(\)/.test(src)) {
    fail('the rumble no longer rides the range it was tuned at');
  } else pass('the rumble keeps its own range off the same curve');

  // ONE SOUND PER WIND-UP, MANY PULSES. The row carries both and they are on
  // different clocks; fired together, a riser assigned to it is started
  // fourteen times a second with every copy playing to its end.
  const interval = src.match(/chargeHapticTimer = CONFIG\.strike\.charge\.hapticInterval;[\s\S]{0,900}?\}\);/);
  if (!interval) fail('could not find the rumble interval in main.js');
  else if (!/sfxSkip: true/.test(interval[0])) {
    fail('the interval rumble fires the SOUND too — a riser on this row is started ~14x a second and every copy plays through');
  } else pass('the interval carries the rumble only');
  if (!/if \(chargeSoundOn && !chargeSoundWasOn\)/.test(src)) {
    fail('the wind-up sound is not fired once on the press');
  } else pass('the sound fires once, on the press');
  // ...AND IS CUT AT THE LET-GO. Without this it plays through the dash it was
  // building to, which is exactly how it was reported.
  if (!/chokeSfx\(voice\)/.test(src)) {
    fail('nothing chokes the wind-up sound — it plays through the strike it was building to');
  } else pass('...and is choked at the let-go');
  const chokes = (src.match(/chokeSfx\(voice\)/g) ?? []).length;
  if (chokes < 2) fail('the run reset does not choke it — a death mid-hold leaves a riser in the air');
  else pass(`...on the let-go and on a run reset (${chokes} sites)`);
}

// --- 18. sfxSkip is honoured, and is not `replay` ---------------------------
// The flag exists so one row can run two clocks. It must silence the SOUND and
// nothing else — `replay`, which lives next to it in systems/feedback.js and
// looks like it would do, silences the haptics as well, and the haptics are
// precisely what the rumble is.
{
  const fbSrc = fs.readFileSync(path.join(ROOT, 'path', 'src', 'systems', 'feedback.js'), 'utf8');
  if (!/if \(def\.sfx && !replay && !at\.sfxSkip\)/.test(fbSrc)) {
    fail('feedback.js does not honour sfxSkip — the flag is passed and ignored, which is silent');
  } else pass('feedback.js skips only the sound');
  // The haptic must NOT be gated on it, or the rumble goes with the sound.
  const hap = fbSrc.match(/if \(def\.haptic && [^)]*\)/);
  if (hap && /sfxSkip/.test(hap[0])) {
    fail('the haptic is gated on sfxSkip too — the rumble dies with the sound');
  } else pass('...and leaves the rumble alone');
}

// --- 19. the wind-up is findable in the F panel -----------------------------
// An event with no row in the rail still WORKS — it falls into the "Everything
// else" catch-all at the bottom — which is exactly why this is worth a check.
// Nothing is broken, nothing warns, and the three voices of one gesture are
// filed apart from each other and from the strike they belong to. The whole
// point of that panel is to put a moment's channels side by side; a row in the
// junk drawer is a sound you tune by remembering it exists.
{
  const wbSrc = fs.readFileSync(path.join(ROOT, 'path', 'src', 'ui', 'workbench.js'), 'utf8');
  const sec = wbSrc.match(/\['Strike & food chain', \[([\s\S]*?)\]\]/);
  if (!sec) fail('no Strike section in the workbench rail');
  else {
    const ids = [...sec[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const id of ['strikeCharging', 'strikeBurn', 'strikePerfect']) {
      if (!ids.includes(id)) fail(`${id} is not filed in the Strike section — it lands in "Everything else"`);
      else pass(`${id} is filed with the strike`);
    }
    // ...and the three are ADJACENT, because they are one gesture.
    const at = ['strikeCharging', 'strikeBurn', 'strikePerfect'].map((id) => ids.indexOf(id));
    const adjacent = at.every((v, i) => i === 0 || v === at[i - 1] + 1);
    check('...and the three sit together, in the order they happen', adjacent && at[0] >= 0,
      at.join(','));
  }
}

const label = failures ? `${failures} FAILED` : 'All charge-sound checks passed.';
console.log(`\n${label}\n`);
process.exit(failures ? 1 : 0);
