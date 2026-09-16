#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:absorb
//
// A BIG PICKUP GOING DOWN IN PIECES — systems/pickupAbsorb.js on top of the
// payload half of systems/gooSuck.js.
//
// Every claim here is about an INVARIANT nobody can see. The screen shows goo
// arriving and a bar climbing; what it cannot show is whether the bar climbed
// by exactly what the chunk was worth. A drip that pays 0.98 of a heal, or
// 1.03, or that pays its last share twice when the seal dashes through the
// tail of its own burst, looks identical to a correct one and is a pickup
// quietly lying about its size.
//
//   WHOLE       the shares sum to exactly 1 and `pay` is called exactly once
//               per piece. The one that would be invisible forever.
//   NO LOSS     a piece whose goo melts unclaimed still pays. The seal ate the
//               chunk; the goo is how the payout is DRAWN, not a second chance
//               to lose it.
//   NO DOUBLE   a blob cannot pay on the way in and again on the way out.
//   FALLBACK    with the suck switched off the payout still lands, whole, in
//               one call — which is the behaviour this replaced, and the only
//               honest way to A/B the feature.
//   RESET       a run ending drops the payload unpaid. The one place a share
//               is allowed to go missing, because there is nothing left to pay
//               into.
//   LADDER      the pitch climbs, arrives at the top on the LAST piece, and a
//               one-piece bunch sounds like the start of a run rather than the
//               end of one.
//   STREAM      the stagger actually spreads the arrivals out. Without it
//               every piece lands inside a frame or two and the ladder is a
//               buzz — the numbers pass either way, so this measures the gap.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import {
  spawnSuckGoo, updateGooSuck, setGooSuckTarget, resetGooSuck, gooSuckBlobs,
} from '../path/src/systems/gooSuck.js';
import { absorbInPieces, absorbPitch } from '../path/src/systems/pickupAbsorb.js';
import { onFeedback } from '../path/src/systems/feedback.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);
const dt = 1 / 60;

const scene = new THREE.Scene();
initParticles(scene);
CONFIG.fx.gooSuck.enabled = true;

// What the seal heard. The absorb module fires one `chumMorsel` per piece and
// the pitch rides on sfxOpts, so this is the ladder as the mixer would get it.
const heard = [];
onFeedback((event, at) => {
  if (event === CONFIG.pickups.absorb.event) heard.push(at.sfxOpts?.pitch ?? 1);
});

// Run a whole absorption to completion and report what was paid.
function absorb(opts = {}) {
  resetGooSuck();
  resetParticles();
  heard.length = 0;
  setGooSuckTarget(0, 0);
  const paid = [];
  const order = [];
  let lastFlag = 0;
  absorbInPieces('chumChunkEaten',
    { x: opts.x ?? 9, y: opts.y ?? 0, scale: opts.scale ?? 1.5, pieces: opts.pieces, tune: opts.tune },
    (share, taken, count, x, y, last) => {
      paid.push(share);
      order.push(taken);
      if (last) lastFlag++;
      void count; void x; void y;
    });
  const pieces = gooSuckBlobs().length;
  // Frame numbers each piece was paid on, so the stream can be measured.
  const frames = [];
  let n = 0;
  for (let f = 0; f < 60 * 12 && gooSuckBlobs().length; f++) {
    const before = paid.length;
    updateGooSuck(dt);
    n = f;
    while (frames.length < paid.length) frames.push(f);
    void before;
  }
  return { paid, order, pieces, lastFlag, frames, frames_run: n };
}

// ---------------------------------------------------------------------------
section('WHOLE — the shares are the payout, exactly');
{
  const r = absorb();
  check('the chunk split into pieces', r.pieces > 4, `${r.pieces} pieces`);
  check('every piece paid', r.paid.length === r.pieces, `${r.paid.length} of ${r.pieces}`);
  const sum = r.paid.reduce((a, b) => a + b, 0);
  check('the shares sum to the whole payout', Math.abs(sum - 1) < 1e-9, `sum ${sum.toFixed(12)}`);
  check('...paid in order, one to n', r.order.every((v, i) => v === i + 1),
    `${r.order.slice(0, 4).join(',')}...${r.order.slice(-2).join(',')}`);
  check('exactly one piece is flagged last', r.lastFlag === 1, `${r.lastFlag} flagged`);
}

// ---------------------------------------------------------------------------
section('NO LOSS — goo that never arrives still pays');
{
  // The seal is nowhere near, and the target never moves. Every blob melts on
  // its own clock without ever being swallowed.
  resetGooSuck();
  resetParticles();
  setGooSuckTarget(4000, 4000);
  const paid = [];
  absorbInPieces('chumChunkEaten', { x: 0, y: 0, scale: 1.5 }, (share) => paid.push(share));
  const pieces = gooSuckBlobs().length;
  for (let f = 0; f < 60 * 30 && gooSuckBlobs().length; f++) updateGooSuck(dt);
  check('the goo melted unclaimed', gooSuckBlobs().length === 0);
  check('...and the whole payout still landed', paid.length === pieces
    && Math.abs(paid.reduce((a, b) => a + b, 0) - 1) < 1e-9,
  `${paid.length} of ${pieces}, sum ${paid.reduce((a, b) => a + b, 0).toFixed(12)}`);
}

// ---------------------------------------------------------------------------
section('NO DOUBLE — a share cannot be paid twice');
{
  // Swallow half the burst, then strand the rest so they melt. If the swallow
  // path and the melt path both settled the same blob, the count would exceed
  // the pieces and the sum would exceed 1.
  resetGooSuck();
  resetParticles();
  setGooSuckTarget(0, 0);
  const paid = [];
  absorbInPieces('chumChunkEaten', { x: 6, y: 0, scale: 1.5 }, (share) => paid.push(share));
  const pieces = gooSuckBlobs().length;
  for (let f = 0; f < 60 * 3 && paid.length < Math.ceil(pieces / 2); f++) updateGooSuck(dt);
  setGooSuckTarget(4000, 4000);
  for (let f = 0; f < 60 * 30 && gooSuckBlobs().length; f++) updateGooSuck(dt);
  check('some arrived and the rest melted', paid.length === pieces, `${paid.length} of ${pieces}`);
  check('...and nothing was paid twice',
    Math.abs(paid.reduce((a, b) => a + b, 0) - 1) < 1e-9,
    `sum ${paid.reduce((a, b) => a + b, 0).toFixed(12)}`);
}

// ---------------------------------------------------------------------------
section('FALLBACK — the payout survives the feature being off');
{
  CONFIG.fx.gooSuck.enabled = false;
  resetGooSuck();
  resetParticles();
  const paid = [];
  let counts = null;
  absorbInPieces('chumChunkEaten', { x: 0, y: 0, scale: 1.5 }, (share, taken, count, x, y, last) => {
    paid.push(share);
    counts = { taken, count, last };
  });
  check('the suck could not run, so the goo went ballistic', gooSuckBlobs().length === 0);
  check('...and the payout landed whole, in one call',
    paid.length === 1 && paid[0] === 1 && counts.count === 1 && counts.last === true);
  CONFIG.fx.gooSuck.enabled = true;

  // ...and the module's own switch does the same, without touching the goo.
  CONFIG.pickups.absorb.enabled = false;
  const paid2 = [];
  absorbInPieces('chumChunkEaten', { x: 0, y: 0, scale: 1.5 }, (share) => paid2.push(share));
  check('absorb off pays the lot in one call too', paid2.length === 1 && paid2[0] === 1);
  check('...and never claimed a driven slot', gooSuckBlobs().length === 0);
  CONFIG.pickups.absorb.enabled = true;
}

// ---------------------------------------------------------------------------
section('RESET — a run ending drops what it owed');
{
  resetGooSuck();
  resetParticles();
  setGooSuckTarget(0, 0);
  const paid = [];
  absorbInPieces('chumChunkEaten', { x: 9, y: 0, scale: 1.5 }, (share) => paid.push(share));
  const pieces = gooSuckBlobs().length;
  for (let f = 0; f < 12; f++) updateGooSuck(dt);
  const before = paid.length;
  resetGooSuck();
  check('the reset took the burst with it', gooSuckBlobs().length === 0, `${pieces} pieces dropped`);
  check('...and paid nothing on the way out', paid.length === before, `${paid.length} paid, unchanged`);
}

// ---------------------------------------------------------------------------
section('LADDER — every arrival a little higher than the last');
{
  const c = CONFIG.pickups.absorb;
  const n = 16;
  const rungs = Array.from({ length: n }, (_, i) => absorbPitch(i + 1, n, c));
  check('it starts at the bottom of the ladder', Math.abs(rungs[0] - c.pitchFrom) < 1e-9,
    `${rungs[0].toFixed(3)}`);
  check('...and ARRIVES at the top on the last piece', Math.abs(rungs[n - 1] - c.pitchTo) < 1e-9,
    `${rungs[n - 1].toFixed(3)}`);
  check('...climbing the whole way', rungs.every((v, i) => i === 0 || v > rungs[i - 1]));
  // A one-piece bunch is a chunk that never split, not a chunk that finished.
  check('one piece sounds like the start, not the end',
    absorbPitch(1, 1, c) === c.pitchFrom);
  // Out of range cannot walk off either end — this is fed a live counter.
  check('the ladder is clamped at both ends',
    absorbPitch(0, n, c) === rungs[0] && absorbPitch(n + 5, n, c) === rungs[n - 1]);

  const r = absorb();
  check('one blip per piece actually fired', heard.length === r.pieces,
    `${heard.length} of ${r.pieces}`);
  check('...and what was heard is the ladder',
    heard.length > 1 && heard.every((v, i) => i === 0 || v > heard[i - 1])
    && Math.abs(heard[heard.length - 1] - c.pitchTo) < 1e-9,
    `${heard[0]?.toFixed(2)} -> ${heard[heard.length - 1]?.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('STREAM — the pieces arrive one after another, not in a heap');
{
  const c = CONFIG.pickups.absorb;
  const r = absorb();
  const span = (r.frames[r.frames.length - 1] - r.frames[0]) * dt;
  check('the arrivals are spread across a readable window', span > c.stagger * 0.5,
    `${span.toFixed(2)}s across ${r.pieces} pieces (stagger ${c.stagger}s)`);
  // THE CLAIM IS NOT "THE SPAN IS WIDE" — the flock scatters the arrivals on
  // its own, so a burst with no stagger at all already lands over a third of a
  // second. What a buzz actually is, is PIECES SHARING A FRAME: two blips on
  // one frame are one blip at the wrong pitch, and no span measurement can see
  // that. So the claim is that the arrivals are SEPARATE.
  const perFrame = (rr) => {
    const seen = new Map();
    for (const f of rr.frames) seen.set(f, (seen.get(f) ?? 0) + 1);
    return Math.max(...seen.values());
  };
  // TWO CLAIMS, because there are two mechanisms and they answer different
  // questions. Both are averaged over a sample: the flock's scatter is random,
  // and a single draw against a single draw is a coin flip that used to fail
  // this gate about two runs in five.
  //
  // THE FIRST IS ABSOLUTE. No two pieces may land on one frame, because two
  // blips at once reads as one blip at the wrong pitch. That is no longer the
  // stagger's doing — the stagger spreads the STARTS, and each blob then flies
  // its own angle, speed and z-lane, which re-bunched the ARRIVALS (13.9% of
  // arrival frames carried more than one piece, minimum gap 0). updateGooSuck
  // now holds a capture that would share a frame with its payload's last
  // arrival, so this is asserted as the guarantee it has become.
  //
  // THE SECOND IS WHAT THE STAGGER IS ACTUALLY FOR: how far apart the arrivals
  // sit. Under the gate alone the pieces land on near-consecutive frames,
  // which is a buzz; the stagger is what opens that into a stream.
  const RUNS = 15;
  const sample = () => {
    let busiest = 0, gapSum = 0, gapN = 0;
    for (let i = 0; i < RUNS; i++) {
      const rr = absorb();
      busiest = Math.max(busiest, perFrame(rr));
      for (let k = 1; k < rr.frames.length; k++) { gapSum += rr.frames[k] - rr.frames[k - 1]; gapN++; }
    }
    return { busiest, gap: gapN ? gapSum / gapN : 0 };
  };
  const on = sample();
  const was = c.stagger;
  c.stagger = 0;
  const off = sample();
  c.stagger = was;
  check('...and no two ever land on the same frame',
    on.busiest === 1 && off.busiest === 1,
    `worst frame carried ${on.busiest} piece over ${RUNS} runs (${off.busiest} with no stagger)`);
  check('...and the stagger is what spaces them out',
    on.gap > off.gap * 1.25,
    `${on.gap.toFixed(2)} frames apart vs ${off.gap.toFixed(2)} with no stagger`);
  check('the last piece still lands well inside the melt clock',
    r.frames[r.frames.length - 1] * dt < CONFIG.fx.gooSuck.life + c.stagger,
    `${(r.frames[r.frames.length - 1] * dt).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
section('THE CHUNK ASKS FOR IT — the wiring, not the module');
{
  check('the swallow has goo for the payout to ride home on',
    CONFIG.feedback.chumChunkEaten?.goo === 'pickupGoo');
  check('...so does the boost piece off a weak spot',
    CONFIG.feedback.hotSpotChumTaken?.goo === 'pickupGoo');
  // The blue orb rides the same path — one piece per dark pip. Without goo on
  // its event the suck never spawns, absorbInPieces falls back to paying the
  // lot in one call, and the orb silently goes back to filling the bar on the
  // frame it was touched with nothing to show it.
  check('...and so does the blue orb, which is all of them at once',
    CONFIG.feedback.strikeOrbTaken?.goo === 'pickupGoo');
  check('the per-piece event exists', !!CONFIG.feedback[CONFIG.pickups.absorb.event]);
  // A throttle here would collapse the ladder into one blip and the feature
  // would be gone with nothing failing.
  check('...and is NOT throttled',
    !CONFIG.feedback[CONFIG.pickups.absorb.event]?.sfxMinGap);
  check('...and has a sound to make', !!CONFIG.sfx[CONFIG.feedback[CONFIG.pickups.absorb.event]?.sfx]);
  // The clamp is what keeps the ladder a ladder — see the note on
  // CONFIG.pickups.absorb.pieces. A tuner drag on the look multiplier must not
  // be able to turn a chunk into forty blips.
  const [lo, hi] = CONFIG.pickups.absorb.pieces;
  const wide = CONFIG.fx.gooSuck.countMul;
  CONFIG.fx.gooSuck.countMul = 40;
  const big = absorb({ scale: 3 });
  CONFIG.fx.gooSuck.countMul = 0.01;
  const small = absorb({ scale: 0.2 });
  CONFIG.fx.gooSuck.countMul = wide;
  check('a huge look multiplier still lands inside the clamp', big.pieces === hi, `${big.pieces} pieces, cap ${hi}`);
  check('...and a tiny one still splits into enough to hear', small.pieces === lo, `${small.pieces} pieces, floor ${lo}`);
}

// ---------------------------------------------------------------------------
section('ONE PIECE PER UNIT — a countable payout names its own piece count');
{
  // The blue orb is absorbed one piece per DARK PIP (see the strike orb in
  // main.js), so the count is the payout rather than a look choice — and it
  // has to escape the clamp in BOTH directions or the bar and the blips stop
  // agreeing. A five-pip bar is under the floor of [6,15]; a twelve-pip one
  // with Booster Pack is nowhere near the cap, and the cap is what a look
  // multiplier drag would otherwise push it into.
  const [lo, hi] = CONFIG.pickups.absorb.pieces;
  const five = absorb({ pieces: 5 });
  check('five pips ask for five pieces, under the clamp\'s floor',
    five.pieces === 5, `${five.pieces} pieces, floor ${lo}`);
  check('...and the shares still sum to the whole payout',
    Math.abs(five.paid.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  check('...with the ladder arriving on the last of them',
    heard.length === 5 && heard[heard.length - 1] === CONFIG.pickups.absorb.pitchTo,
    `${heard.length} blips, top ${heard[heard.length - 1]}`);
  // The look multiplier is what the clamp exists to contain, and it must not
  // reach a count that IS the payout — a tuner drag that turned a five-pip
  // orb into fifteen blips would be the bar and the ear disagreeing.
  const wide = CONFIG.fx.gooSuck.countMul;
  CONFIG.fx.gooSuck.countMul = 40;
  const loud = absorb({ pieces: 5, scale: 3 });
  CONFIG.fx.gooSuck.countMul = 0.01;
  const quiet = absorb({ pieces: 5, scale: 0.2 });
  CONFIG.fx.gooSuck.countMul = wide;
  check('a huge look multiplier cannot add pieces to it',
    loud.pieces === 5, `${loud.pieces} pieces, cap ${hi}`);
  check('...and a tiny one cannot take any away', quiet.pieces === 5, `${quiet.pieces} pieces`);
  // A full bar is missing nothing, and main.js still asks for one piece: the
  // seal swallowed the thing and it must still make the sound of it.
  const one = absorb({ pieces: 1 });
  check('a one-piece swallow is still a swallow', one.pieces === 1 && one.paid.length === 1);
  check('...sounding like the start of a run, not the end of one',
    heard.length === 1 && heard[0] === CONFIG.pickups.absorb.pitchFrom, `${heard[0]}`);
  // And with no count named, the clamp owns it exactly as before.
  const open = absorb({});
  check('a payout that does not name a count is still the tuner\'s',
    open.pieces >= lo && open.pieces <= hi, `${open.pieces} in [${lo},${hi}]`);
}

// ---------------------------------------------------------------------------
section('THE ORB\'S OWN CLOCK — one machine, two sentences');
{
  // The chunk is a BREAK and the orb is a RE-ARM, and they are absorbed by the
  // same code. The overlay is what keeps that from meaning they have to feel
  // alike — and the failure it guards against is silent in both directions: an
  // overlay that stops being read puts the orb back on the chunk's second-long
  // swallow, and one that leaks puts the chunk on the orb's.
  const orb = CONFIG.pickups.absorb.orb;
  check('the orb names its own timing', orb && orb.hold != null && orb.ramp != null && orb.stagger != null);
  check('...and nothing else — the ladder is the shared one',
    !('pitchFrom' in orb) && !('pitchTo' in orb) && !('curve' in orb) && !('event' in orb),
    Object.keys(orb).join(','));
  check('...and it IS quicker than the chunk\'s', orb.stagger < CONFIG.pickups.absorb.stagger,
    `${orb.stagger}s vs ${CONFIG.pickups.absorb.stagger}s`);

  // Measured, not asserted off the config: the hold and the ramp are two
  // numbers in two different files and only the arrival time says whether
  // they add up. `frames` is the frame each piece was paid on.
  // Both swallowed AT the seal, which is where a pickup is taken — the helper's
  // default 9 units is the chunk's own geometry and would put a second of
  // flight into a measurement that is about the hold and the ramp.
  const slow = absorb({ pieces: 5, x: 1 });
  const quick = absorb({ pieces: 5, x: 1, tune: orb });
  const last = (r) => r.frames[r.frames.length - 1] / 60;
  check('the orb\'s bar fills inside half a second',
    last(quick) < 0.5, `${last(quick).toFixed(2)}s across 5 pips`);
  check('...well ahead of the chunk on the same five pieces',
    last(quick) < last(slow) * 0.7, `${last(quick).toFixed(2)}s vs ${last(slow).toFixed(2)}s`);
  check('...with the first pip landing promptly', quick.frames[0] / 60 < 0.3,
    `${(quick.frames[0] / 60).toFixed(2)}s`);
  // Still a STREAM. A vacuum quick enough to land two pips on one frame is a
  // chord, and the bar would then climb faster than the ear can count it.
  const perFrame = new Map();
  for (const f of quick.frames) perFrame.set(f, (perFrame.get(f) ?? 0) + 1);
  check('...and no two pips landing on the same frame',
    Math.max(...perFrame.values()) === 1, `worst frame carried ${Math.max(...perFrame.values())}`);
  // The overlay must not reach the pickup that did not ask for one.
  check('the chunk is untouched by it', last(slow) > 0.6, `${last(slow).toFixed(2)}s`);
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
