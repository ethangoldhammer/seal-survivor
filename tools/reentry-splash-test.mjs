#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:splash
//
// THE LANDING — systems/reentrySplash.js and the three emitters under it.
//
// The whole claim of this effect is a SHAPE IN TIME: water is driven down
// through the line, hangs at the bottom of the hole it made, and comes back up
// as the hole closes and throws a column out of itself. Every part of that is
// invisible from the code, because none of it is simulated — it is a stage
// table on one clock plus a closed-form ballistic solve on another, and each
// way it can be wrong still renders a perfectly reasonable-looking burst of
// particles at a water line:
//
//   NOTHING GOES DOWN     The cavity is the one burst in the game thrown at
//                         `dirY: -1`. Flip it, or let the seal's arrival speed
//                         through with the wrong sign, and the effect quietly
//                         becomes a slightly bigger version of the crown that
//                         was already there. The test solves where the blobs
//                         actually go rather than reading the emitter's cone.
//
//   NOTHING COMES BACK    The rebound is `gravity` being POSITIVE on the
//                         cavity, which reads as a typo and survives being
//                         "fixed" to match every other emitter in the table.
//                         With it negative the hole sinks and stays sunk: no
//                         throw, no error, half an effect.
//
//   THE JET MISTIMED      It has to leave while the hole is at its deepest.
//                         The depth is set by the cavity's own DRAG, so a
//                         retune of one silently invalidates the other — and
//                         a jet fired into an open hole or a closed one looks
//                         like a jet either way.
//
//   THE MASS SCALED WRONG A goo burst is grown by scaling size and speed by
//                         the same factor. Grow one alone and the cavity either
//                         welds into a slab or tears into loose dots, which is
//                         a look, not a crash.
//
//   FIRING FOREVER        The stage cursor is what stops a long frame — or a
//                         paused one — re-emitting a stage. Without it a
//                         landing throws a column every frame for as long as
//                         the record lives.
//
// Everything expected is derived from CONFIG, which has imported-tuning.json
// merged over it at import — a literal here would be testing the tuning file.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import {
  fireReentrySplash, updateReentrySplash, resetReentrySplash, reentrySplashCount,
} from '../path/src/systems/reentrySplash.js';

// EVERY BURST HERE IS THE SAME BURST. emit() rolls a speed, a size, a life, a
// drag and an angle per particle, so two landings compared against each other
// differed mostly by the dice — the size-against-speed ratio below moved by 6%
// between runs of identical code, which is most of the margin it is measuring.
// Seeded, so the only thing that changes between two measurements is the thing
// being compared. Installed before initParticles, which rolls nothing, but
// before anything else that might.
let seed = 0x5ea15eed;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0x5ea15eed; };

const scene = new THREE.Scene();
initParticles(scene);
const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SPLASH = CONFIG.reentrySplash;
const DT = 1 / 60;

// A landing that is neither the smallest nor the biggest, so a bug that only
// shows at one end of the scale range has somewhere to hide and the scale
// section below can go looking for it.
const LANDING = { x: 0, y: 0, vx: 6, vy: 24, scale: 1.4 };

// --- reading the buffer back ------------------------------------------------
// Nothing on the CPU knows where a particle is: the simulation is entirely in
// the vertex shader. So the harness carries its own copy of the same closed
// form, and every claim below about where the water GOES is this function
// rather than an assertion about a config value.
//
// Transcribed from vertexShaderFor in entities/particles.js. The line that
// matters is the second one: the velocity term is damped by drag and the
// gravity term is NOT, which is the entire mechanism by which a blob thrown
// downwards comes back up. Turbulence is left out — it is a wobble around this
// path with a mean of nothing, and including it would only add noise to a
// measurement of the path itself.
function solveY(p, age) {
  if (age < 0 || age > p.life) return null;
  const k = Math.max(p.drag, 0.0001);
  return p.y + p.vy * ((1 - Math.exp(-k * age)) / k) + 0.5 * p.gy * age * age;
}

// THE IMPACT FRAME FIRES TWO STAGES — the crown and the cavity — and the buffer
// records nothing about which emitter a particle came from. They are told apart
// by the SIGN OF THEIR GRAVITY, which is not a trick: the cavity is the only
// emitter in the game carrying positive (upward) gravity, and that is the exact
// property this whole file exists to defend. A run where these two came back
// indistinguishable would mean the rebound had been "fixed" away.
const cavityOf = (list) => list.filter((p) => p.gy > 0);
const crownOf = (list) => list.filter((p) => p.gy < 0);

/** Every particle emitted since `sinceStart`, as plain records. */
function snapshot(sinceStart = -Infinity) {
  const out = [];
  const n = attrs.aStart.array.length;
  for (let i = 0; i < n; i++) {
    const start = attrs.aStart.array[i];
    if (start < sinceStart || start < -1e8) continue;
    out.push({
      start,
      y: attrs.position.array[i * 3 + 1],
      x: attrs.position.array[i * 3],
      vx: attrs.aVelocity.array[i * 3],
      vy: attrs.aVelocity.array[i * 3 + 1],
      gy: attrs.aGravity.array[i * 2 + 1],
      life: attrs.aLife.array[i],
      drag: attrs.aDrag.array[i],
      size: attrs.aSize.array[i],
      goo: attrs.aGoo.array[i],
    });
  }
  return out;
}

/**
 * Run a whole landing and hand back every particle it emitted, grouped by the
 * stage that fired it — matched on the emission TIME, which is the only thing
 * the buffer records about where a particle came from.
 */
function landing(at = LANDING, frames = 90) {
  resetParticles();
  resetReentrySplash();
  // The clock is the module's own and does not rewind on reset, so the fence
  // has to be read after the reset rather than assumed to be zero.
  updateParticles(0);
  const t0 = attrs.aStart.array[0];
  const before = snapshot(-1e8).length;
  const fired = [];
  fireReentrySplash(at);
  fired.push({ t: 0, count: snapshot(-1e8).length - before });
  let t = 0;
  for (let i = 0; i < frames; i++) {
    updateReentrySplash(DT);
    updateParticles(DT);
    t += DT;
    const n = snapshot(-1e8).length;
    const added = n - before - fired.reduce((s, f) => s + f.count, 0);
    if (added > 0) fired.push({ t, count: added });
  }
  return { fired, all: snapshot(-1e8), t0 };
}

// A run's worth of clock, so aStart is a real float rather than an exact small
// integer — the same thing that once hid a rounding bug in the surface pops.
for (let i = 0; i < 600; i++) updateParticles(DT);

console.log('\nreentry splash — the stages');
{
  resetParticles();
  resetReentrySplash();
  const emitted = [];
  const mark = () => snapshot(-1e8).length;
  const base = mark();
  fireReentrySplash(LANDING);
  emitted.push([0, mark() - base]);
  let last = mark();
  let t = 0;
  for (let i = 0; i < 60; i++) {
    updateReentrySplash(DT);
    updateParticles(DT);
    t += DT;
    if (mark() !== last) { emitted.push([t, mark() - last]); last = mark(); }
  }

  const stageTimes = [...new Set(SPLASH.stages.map((s) => s.at ?? 0))].sort((a, b) => a - b);
  check('one emission moment per authored stage time',
    emitted.length === stageTimes.length,
    `${stageTimes.length} authored (${stageTimes.join(', ')}s), ${emitted.length} fired at ${emitted.map(([e]) => e.toFixed(3)).join(', ')}`);

  // Within one frame of the authored time, and never EARLY — an effect that
  // fires ahead of its own schedule is one that will fire on the impact frame
  // the moment a machine drops below 30fps.
  for (let i = 0; i < Math.min(emitted.length, stageTimes.length); i++) {
    const want = stageTimes[i];
    const got = emitted[i][0];
    check(`stage at ${want}s lands on time`, got >= want - 1e-6 && got < want + DT * 1.5,
      `fired at ${got.toFixed(4)}s`);
  }

  check('the impact stage is on the impact frame, not the next one',
    emitted[0][0] === 0, `fired at ${emitted[0][0]}`);

  check('the record retires once its last stage is out', reentrySplashCount() === 0);
}

console.log('\nreentry splash — nothing fires twice');
{
  resetParticles();
  resetReentrySplash();
  const base = snapshot(-1e8).length;
  fireReentrySplash(LANDING);
  // One enormous frame, longer than the whole sequence: a stage table walked
  // with a cursor emits each stage once; one re-tested every frame against a
  // window emits some of them never and others twice.
  updateReentrySplash(2);
  const oneBigFrame = snapshot(-1e8).length - base;

  resetParticles();
  resetReentrySplash();
  const base2 = snapshot(-1e8).length;
  fireReentrySplash(LANDING);
  for (let i = 0; i < 180; i++) updateReentrySplash(DT);
  const manySmall = snapshot(-1e8).length - base2;

  check('a 2s frame and 3s of 60fps frames emit the same particles',
    oneBigFrame === manySmall, `${oneBigFrame} vs ${manySmall}`);

  // And then keeps emitting nothing, forever.
  const settled = snapshot(-1e8).length;
  for (let i = 0; i < 300; i++) updateReentrySplash(DT);
  check('a finished landing emits nothing else', snapshot(-1e8).length === settled);
}

console.log('\nreentry splash — the hole goes down');
{
  resetParticles();
  resetReentrySplash();
  const base = snapshot(-1e8).length;
  fireReentrySplash(LANDING);
  const impact = snapshot(-1e8).slice(base);
  const cavity = cavityOf(impact);
  const crown = crownOf(impact);
  const CAV = CONFIG.emitters.reentryCavity;

  check('the impact frame fires the crown AND the hole',
    cavity.length > 0 && crown.length > 0,
    `${crown.length} crown lobes, ${cavity.length} cavity lobes`);

  // Emitted from a RING, so the count is not the emitter's figure: each of the
  // ring's points fires its share, and emit() floors every one of them at a
  // single lobe. Checked as a band rather than an equality for that reason —
  // the floor is what makes a small landing a ring of single lobes instead of
  // nothing, and it means the total can only ever come out at or above the
  // share arithmetic.
  const ring = SPLASH.ring;
  const gain = 1 + (LANDING.scale - 1) * SPLASH.countGain;
  const wantCav = Math.round(CAV.count * gain);
  check('the hole is the emitter\'s lobes, spread around the ring',
    cavity.length >= wantCav && cavity.length <= wantCav + ring.points,
    `${cavity.length} lobes, ${wantCav} authored across ${ring.points} points`);

  // THE HOLE IS DUG DOWNWARD, and this is now a claim about the SUM rather than
  // about every lobe. The ring is a full 360 of origins, so the points on top of
  // the animal genuinely do throw some water upward — that is what a body
  // punching through water does. What must never flip is the net.
  const meanVy = cavity.reduce((a, p) => a + p.vy, 0) / cavity.length;
  check('the hole is thrown downward on balance', meanVy < -2,
    `mean vy ${meanVy.toFixed(2)}`);

  check('the hole is foam, not sprites', cavity.every((p) => p.goo > 0));

  // How deep it actually gets, solved rather than assumed, and measured on the
  // half that was thrown DOWN — the top of the ring is the crown's business.
  const down = cavity.filter((p) => p.vy < 0);
  const depths = down.map((p) => {
    let min = p.y;
    for (let a = 0; a <= p.life; a += 0.01) {
      const y = solveY(p, a);
      if (y != null && y < min) min = y;
    }
    return min;
  }).sort((a, b) => a - b);
  const median = depths[depths.length >> 1];
  // Judged against the seal, which is about 2.6 units of animal: a hole
  // shallower than the thing that made it is not a hole.
  check('the hole is deeper than the animal that made it', -median > 2.6,
    `median downward lobe reaches ${median.toFixed(2)}, deepest ${depths[0].toFixed(2)}`);
}

console.log('\nreentry splash — ...and comes back up');
{
  resetParticles();
  resetReentrySplash();
  const base = snapshot(-1e8).length;
  fireReentrySplash(LANDING);
  const cavity = cavityOf(snapshot(-1e8).slice(base));

  check('the cavity carries UPWARD gravity — this is the rebound',
    cavity.length > 0 && cavity.every((p) => p.gy > 0),
    `gravity.y ${cavity[0]?.gy}`);

  // The claim, measured: each lobe reaches a low point and then finishes its
  // life higher than that. This is the whole effect, and it is the one thing
  // that no amount of reading the emitter table can confirm.
  // TWO SEPARATE CLAIMS, and they fail for different reasons. The first is the
  // mechanism: is the lobe still on its way down when it dies, or has the
  // parabola taken it back? That must hold for every single one, because a lobe
  // that never turns is a lobe whose whole life was the descent — the hole with
  // no rebound, which is exactly the half-effect this file exists to catch.
  //
  // The second is whether the rebound is big enough to SEE, which is a taste
  // call and is measured on the median: some of the water genuinely does not
  // make it back inside its own lifetime, and asserting otherwise would just
  // pin the shortest life in the emitter's range to its longest.
  let turned = 0;
  let crossed = 0;
  const rises = [];
  for (const p of cavity) {
    let min = p.y;
    for (let a = 0; a <= p.life; a += 0.005) {
      const y = solveY(p, a);
      if (y != null && y < min) min = y;
    }
    const end = solveY(p, p.life);
    // Rising at the moment it dies: the derivative of the same closed form.
    const vEnd = p.vy * Math.exp(-p.drag * p.life) + p.gy * p.life;
    if (vEnd > 0) turned += 1;
    if (end > LANDING.y) crossed += 1;
    rises.push(end - min);
  }
  rises.sort((a, b) => a - b);
  const medianRise = rises[rises.length >> 1];
  // Every one of them, and the ring does not weaken this: a lobe thrown UP off
  // the top of the ring is rising to begin with and never stops. What the claim
  // rules out is a cavity that sinks and stays sunk, which is what a "fixed"
  // gravity sign produces and which nothing else in this file would catch.
  check('every cavity lobe is rising by the end of its life',
    turned === cavity.length, `${turned} of ${cavity.length}`);
  check('the rebound is a throw, not a drift',
    medianRise > 1.5, `median lobe rises ${medianRise.toFixed(2)} off the bottom`);
  check('most of the hole surfaces before it dies',
    crossed >= cavity.length * 0.5,
    `${crossed} of ${cavity.length} cross back over the line`);
}

console.log('\nreentry splash — the column is thrown out of the closing hole');
{
  const { all, fired } = landing();
  const jetStage = SPLASH.stages.find((s) => s.emit === 'reentryJet');
  check('there is a column stage at all', !!jetStage);

  // WHEN THE HOLE IS DEEPEST, solved from the cavity itself rather than read
  // off a config value — that is what makes this assertion bind the two
  // emitters together. Retune the cavity's drag and this moves.
  resetParticles();
  resetReentrySplash();
  const base = snapshot(-1e8).length;
  fireReentrySplash(LANDING);
  const cavity = cavityOf(snapshot(-1e8).slice(base)).filter((p) => p.vy < 0);
  const bottoms = cavity.map((p) => {
    let min = Infinity;
    let tMin = 0;
    for (let a = 0; a <= p.life; a += 0.005) {
      const y = solveY(p, a);
      if (y != null && y < min) { min = y; tMin = a; }
    }
    return tMin;
  }).sort((a, b) => a - b);
  const deepestAt = bottoms[bottoms.length >> 1];

  const at = jetStage.at ?? 0;
  // A generous window on purpose. The claim is not "0.2 is the right number",
  // it is "the column leaves while the hole is open and near its deepest" —
  // anything inside half the descent either side of the bottom reads that way,
  // and outside it the jet is climbing out of a hole that is still opening or
  // out of one that has already surfaced.
  const ok = at > deepestAt * 0.45 && at < deepestAt * 1.7;
  check('the column leaves while the hole is at its deepest', ok,
    `hole bottoms out at ${deepestAt.toFixed(3)}s, column fires at ${at}s`);
  if (process.env.SPLASH_VERBOSE) {
    console.log(`        hole bottoms out at ${deepestAt.toFixed(3)}s, column fires at ${at}s`);
  }

  // The column itself.
  const jets = all.filter((p) => p.gy < 0 && p.vy > 0);
  check('the column is thrown upward', jets.length > 0, `${jets.length} lobes`);
  check('...and falls back — gravity is down on it', jets.every((p) => p.gy < 0));

  const JET = CONFIG.emitters.reentryJet;
  // It has to out-climb the crown or it is not a column, it is more crown. The
  // crown is `reentryFoam`, thrown at up to `speed[1]` into drag `drag`, and
  // the peak of a drag-limited throw against gravity is what each of these
  // reaches at best.
  const peak = (def) => {
    const v = def.speed[1];
    const k = def.drag;
    const g = Math.abs(def.gravity[1]);
    let best = 0;
    for (let a = 0; a <= def.life[1]; a += 0.005) {
      best = Math.max(best, v * ((1 - Math.exp(-k * a)) / k) - 0.5 * g * a * a);
    }
    return best;
  };
  const crownPeak = peak(CONFIG.emitters.reentryFoam);
  const jetPeak = peak(JET);
  check('the column stands up past the crown', jetPeak > crownPeak * 1.15,
    `crown reaches ${crownPeak.toFixed(2)}, column ${jetPeak.toFixed(2)}`);

  // A jet is a column. The narrow cone is what makes it one, and it is the
  // first thing a tuner session widens.
  check('the column is narrow enough to read as one', JET.cone <= 0.5,
    `cone ${JET.cone}`);

  check('every stage names an emitter that exists',
    SPLASH.stages.every((s) => !!CONFIG.emitters[s.emit]),
    SPLASH.stages.map((s) => s.emit).filter((e) => !CONFIG.emitters[e]).join(', '));

  check('the sequence ends with water coming apart, not with more foam',
    (SPLASH.stages[SPLASH.stages.length - 1].at ?? 0) > at,
    `last stage at ${SPLASH.stages[SPLASH.stages.length - 1].at}s`);
  check('the landing fires four stages of water', fired.length >= 3,
    `${fired.length} emission moments`);
}

console.log('\nreentry splash — a harder landing is the same splash, bigger');
{
  // Measured on a landing with NO arrival speed. The inherited velocity is a
  // constant added to every lobe in the burst and does not scale with the size
  // gain, so leaving it in dilutes the speed ratio by however fast the seal
  // happened to be going — the measurement would report the two gains
  // disagreeing on a landing where they are identical. It is also common-mode:
  // it translates the whole cloud and changes nothing about how far neighbours
  // separate from each other, which is the only thing fusion depends on.
  const measure = (scale) => {
    reseed();
    resetParticles();
    resetReentrySplash();
    const base = snapshot(-1e8).length;
    fireReentrySplash({ ...LANDING, vx: 0, vy: 0, scale });
    const cavity = snapshot(-1e8).slice(base);
    let deepest = 0;
    for (const p of cavity) {
      for (let a = 0; a <= p.life; a += 0.01) deepest = Math.min(deepest, solveY(p, a));
    }
    return {
      n: cavity.length,
      deepest,
    };
  };

  const small = measure(SPLASH.minScale);
  const big = measure(2.2);

  check('a harder landing throws more water', big.n > small.n, `${small.n} -> ${big.n} lobes`);
  check('...and digs deeper', big.deepest < small.deepest - 0.5,
    `${small.deepest.toFixed(2)} -> ${big.deepest.toFixed(2)}`);

  // THE RULE: a goo mass is grown by scaling the lobes AND how far they are
  // thrown by the SAME factor, because fusion depends on how far neighbours
  // have separated relative to their own radius. Asserted as the RATIO of the
  // two ratios, not as "both went up" — a size gain of 2 against a speed gain
  // of 1.05 satisfies "both grew" and welds the cavity into a featureless slab.
  // MEASURED ON THE COLUMN, not on the hole, and the reason is the ring. A ring
  // stage fires once per point with a fractional share of the lobes, and emit()
  // rounds and floors each of those independently — so two landings at different
  // scales do not roll the same dice in the same order and there is no honest
  // index pairing across them. The column is a single point burst, so lobe n of
  // a small landing and lobe n of a big one came off the same numbers and the
  // ratio is exact. Both stages carry the same gains off the same record, so
  // measuring one measures both.
  const column = (scale) => {
    reseed();
    resetParticles();
    resetReentrySplash();
    fireReentrySplash({ ...LANDING, vx: 0, vy: 0, scale });
    const before = snapshot(-1e8).length;
    // RESEEDED HERE, not at the top. The two impact stages fire different
    // NUMBERS of lobes at different scales and every lobe consumes seven draws,
    // so by the time the column goes out the two runs are at different places
    // in the generator and lobe n of one is not lobe n of the other. Reseeding
    // immediately before puts both columns back on the same dice — the column
    // is the first stage this call fires, so nothing gets in between.
    reseed();
    // Straight to the column's stage, in one frame — nothing here is measuring
    // timing and the cursor fires every stage whose moment has passed.
    updateReentrySplash(0.3);
    const fired = snapshot(-1e8).slice(before);
    // The goo column, not the sprite droplets fired alongside it.
    const jet = fired.filter((p) => p.goo > 0);
    return {
      speeds: jet.map((p) => Math.hypot(p.vx, p.vy)),
      sizes: jet.map((p) => p.size),
    };
  };
  const smallJet = column(SPLASH.minScale);
  const bigJet = column(2.2);
  const paired = Math.min(smallJet.sizes.length, bigJet.sizes.length);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sizeRatio = mean(bigJet.sizes.slice(0, paired)) / mean(smallJet.sizes.slice(0, paired));
  const speedRatio = mean(bigJet.speeds.slice(0, paired)) / mean(smallJet.speeds.slice(0, paired));
  check('size and speed grow by the same factor',
    paired > 0 && Math.abs(sizeRatio / speedRatio - 1) < 0.02,
    `over ${paired} index-matched lobes: size x${sizeRatio.toFixed(4)}, speed x${speedRatio.toFixed(4)}`);

  // The floor, so the smallest landing in the game is a small splash rather
  // than an absent one.
  resetParticles();
  resetReentrySplash();
  const b = snapshot(-1e8).length;
  fireReentrySplash({ ...LANDING, scale: 0 });
  check('even a scale-0 landing still puts water in the air',
    snapshot(-1e8).length > b, 'nothing emitted');
}

console.log('\nreentry splash — the ring around the animal');
{
  const measured = { rx: 1.55, ry: 0.35 }; // roughly the seal, long and shallow
  const ringOf = (body) => {
    reseed();
    resetParticles();
    resetReentrySplash();
    const base = snapshot(-1e8).length;
    fireReentrySplash({ ...LANDING, body });
    return cavityOf(snapshot(-1e8).slice(base));
  };

  const lobes = ringOf(measured);
  const ring = SPLASH.ring;
  const rx = measured.rx + ring.pad;
  const ry = measured.ry + ring.pad;

  // 360 OF IT. Measured as coverage of the ring rather than as a spread: a
  // burst that put every origin in one quadrant would still have a wide spread
  // of angles. Binned into eighths, and every eighth has to have water in it.
  const octants = new Set();
  for (const p of lobes) {
    octants.add(Math.floor(((Math.atan2(p.y - LANDING.y, p.x - LANDING.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)));
  }
  check('water leaves the animal all the way round it', octants.size === 8,
    `${octants.size} of 8 octants have an emission point in them`);

  // FITTED TO THE BODY, not to a number typed in this file. The seal is long
  // and shallow, so the ring has to be too — a circular ring on a body three
  // times longer than it is deep throws foam off empty water above and below
  // the animal and none off its nose.
  const spanX = Math.max(...lobes.map((p) => p.x)) - Math.min(...lobes.map((p) => p.x));
  const spanY = Math.max(...lobes.map((p) => p.y)) - Math.min(...lobes.map((p) => p.y));
  check('the ring is the shape of the animal', spanX / spanY > (rx / ry) * 0.6,
    `${spanX.toFixed(2)} wide x ${spanY.toFixed(2)} tall, body ratio ${(rx / ry).toFixed(2)}`);

  // ...AND IT GROWS WITH IT. A ring that ignored the measurement would pass
  // every check above on the fallback radius alone.
  const wide = ringOf({ rx: measured.rx * 3, ry: measured.ry });
  const wideSpan = Math.max(...wide.map((p) => p.x)) - Math.min(...wide.map((p) => p.x));
  check('a bigger animal throws a wider ring', wideSpan > spanX * 1.8,
    `${spanX.toFixed(2)} -> ${wideSpan.toFixed(2)} across`);

  // NO BODY AT ALL still splashes. main.js measures a Box3 and an empty one is
  // reachable — the visual can be mid-swap.
  const bare = ringOf(undefined);
  check('a caller with nothing to measure still gets a ring', bare.length > 0,
    `${bare.length} lobes on the fallback radius`);

  // THE SPACING, which is the check that would have saved a render pass. Foam
  // only fuses where neighbours OVERLAP, so the gap between adjacent points on
  // the ring has to be inside a lobe's own radius — otherwise the landing is a
  // dotted line of separate puffs arranged in a circle, which looks exactly
  // like a broken metaball pass and is really just arithmetic. Ramanujan's
  // ellipse perimeter, because the seal is nowhere near circular.
  const h = ((rx - ry) ** 2) / ((rx + ry) ** 2);
  const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const gap = perimeter / ring.points;
  const foam = CONFIG.fx.goo.groups.foam;
  const gooRadius = foam.radius ?? CONFIG.fx.goo.radius;
  // The SMALLEST lobe the emitter can roll — the ring has to close for all of
  // them, not on average.
  const lobeRadius = (CONFIG.emitters.reentryCavity.size[0] * gooRadius) / 2;
  check('the ring is dense enough to close', gap < lobeRadius * 1.6,
    `${ring.points} points, ${gap.toFixed(2)} apart, smallest lobe radius ${lobeRadius.toFixed(2)}`);
}

console.log('\nreentry splash — whitewater');
{
  const foam = CONFIG.fx.goo.groups.foam;
  const w = foam.whitewater ?? {};
  const iso = foam.iso ?? CONFIG.fx.goo.iso;

  check('the splash foam is whitewater', (w.strength ?? 0) > 0, `strength ${w.strength}`);

  // THE ONE INVARIANT, and it is the whole model. A single splat peaks at a
  // density of exactly 1.0 by construction, so a lone isolated lobe sits at
  // (1 - iso) above the isoline. If `packedAt` is at or below that figure, one
  // lobe on its own already reads as fully aerated — opaque, white, outlined —
  // and a burst renders as a scatter of golf balls instead of as foam. Air
  // packs where water is CHURNED, which in this field means where lobes
  // overlap, so the threshold has to sit above what one lobe can reach alone.
  const lone = 1 - iso;
  check('a lone lobe is a veil, not packed foam', (w.packedAt ?? 0) > lone * 1.5,
    `packedAt ${w.packedAt}, a lone lobe reaches ${lone.toFixed(2)} above the isoline`);

  // ...and it has to be reachable. Set too high, nothing in the game ever
  // whitens and the whole surface is the additive glow it replaced. Three
  // overlapping lobes is what the middle of a landing looks like.
  check('...and a churned one does pack', (w.packedAt ?? 0) < 3 - iso,
    `packedAt ${w.packedAt}, three overlapping lobes reach ${(3 - iso).toFixed(2)}`);

  check('the trapped air rises', (w.airRise ?? 0) > 0, `airRise ${w.airRise}`);
  // Authored light: the composite writes linear straight to the framebuffer
  // with no sRGB conversion, so every colour lands about a stop and a half
  // darker than its hex. Foam that is not near-white in the file is grey.
  const c = w.color ?? 0xffffff;
  const peak = Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255) / 255;
  check('the foam colour is authored light', peak > 0.9, `peak channel ${peak.toFixed(2)}`);

  const med = foam.medium ?? {};
  check('the foam sits in the ocean', (med.murk ?? 0) > 0, `murk ${med.murk}`);
  check('...and in the air', (med.fog ?? 0) > 0, `fog ${med.fog}`);
  // The murk has to ramp over the SPLASH's depth, not the arena's. Normalised
  // against the seabed it was a tenth of a per cent per lobe and the control
  // did nothing at any value.
  check('the murk reaches over the splash, not the arena',
    (med.murkReach ?? 0) > 0 && (med.murkReach ?? 0) < 20,
    `murkReach ${med.murkReach} world units`);
}

console.log('\nreentry splash — the switch and the reset');
{
  const was = SPLASH.enabled;
  SPLASH.enabled = false;
  resetParticles();
  resetReentrySplash();
  const base = snapshot(-1e8).length;
  fireReentrySplash(LANDING);
  updateReentrySplash(1);
  check('switched off, it emits nothing and schedules nothing',
    snapshot(-1e8).length === base && reentrySplashCount() === 0);
  SPLASH.enabled = was;

  resetReentrySplash();
  fireReentrySplash(LANDING);
  check('a landing mid-sequence is held', reentrySplashCount() === 1);
  resetReentrySplash();
  check('...and dropped by the run reset', reentrySplashCount() === 0);
  const base2 = snapshot(-1e8).length;
  updateReentrySplash(1);
  check('a dropped landing never fires its column',
    snapshot(-1e8).length === base2);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
