#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ballspit
//
// WHAT THE BLUBBERBALL SPITS WHEN IT IS HIT — systems/ballSpit.js, the cloud
// that comes out of the contact patch on the frame of a touch.
//
// THE POINT OF THE EFFECT IS THAT IT CARRIES INFORMATION, and every way that
// can stop being true is silent — the bubbles still come out, they are still
// bubbles, and no frame of it looks broken:
//
//   THE JET STOPS FOLLOWING THE IMPULSE. The contact normal and the line the
//   ball leaves on are two different directions (the strike's `grip` swings one
//   off the other toward the dash), and the normal is the one sitting right
//   there in the arguments. Defaulting to it — which is correct for a wall and
//   is what everything but the strike passes — is indistinguishable from
//   IGNORING the line that was passed in. A burst thrown along the normal on a
//   glancing smash points somewhere the ball never went.
//
//   THE WASH STOPS POINTING BACK. It is the only thing on screen aimed at
//   whoever hit the ball. Flip its sign and it merges into the jet: still a
//   cloud, still the right size, now saying nothing about the source.
//
//   IT COMES OUT OF THE MIDDLE. The whole reason this is not the wake
//   (systems/ballTrail.js, which sheds astern) is that an impact happens at a
//   BEARING on the body. Born at the ball's centre it is the wake again with
//   extra steps.
//
//   THE CHURN GOES FLAT. The noise is structured: several puffs across the
//   patch, each bent by where it sits and jittered off that. Drop the fan and
//   the wander and you get one clean expanding cone, which is a burst and not a
//   boil — and it is still a burst of exactly the right count, so nothing
//   counts wrong.
//
//   IT SPENDS THE WHOLE SCREEN. This fires on every touch, and a scramble is a
//   handful inside a second. `maxParticles` is the only thing between a tuned-up
//   ramp and a frame that is all foam.
//
// Read off the REAL buffer rather than off the call: entities/particles.js is
// initialised into a plain Scene (it needs no GL to build its geometry), so
// every check below is a read of what actually landed in the attributes. A test
// against ballSpitStats alone would pass with the directions wrong.
//
// Everything expected is derived from CONFIG. imported-tuning.json is merged at
// import and wins over config.js, so a literal here would test the tuning file.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds, surfaceHeightAt } from '../path/src/arena.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import { spitBallBubbles, ballSpitStats, resetBallSpit } from '../path/src/systems/ballSpit.js';

// SEEDED, and not as a nicety. Every number in this burst is a roll — the
// angle inside the cone, the speed inside the band, the per-puff wander, the
// per-particle drag scatter — and the checks below are means over a few dozen
// particles. Unseeded, the direction checks pass on most runs and fail on the
// occasional one, which is the worst possible state for a test to be in: it
// gets "fixed" by loosening the threshold until it stops catching anything.
let _seed = 0x5ea15ea1 >>> 0;
Math.random = () => {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};

const scene = new THREE.Scene();
updateBounds(16 / 9);
initParticles(scene);

const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;
const CAP = attrs.aStart.count;

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const S = CONFIG.versus.ball.spit;
const JET = CONFIG.emitters[S.jetEmitter];
const WASH = CONFIG.emitters[S.washEmitter];
// Well under the line, and clear of it: `killAtSurface` flags anything born
// below, and a contact within a wave height of the surface is a different test.
const DEEP = bounds.surfaceY - 30;

/** Everything alive in the buffer, as the geometry actually holds it. */
function live() {
  const out = [];
  for (let i = 0; i < CAP; i++) {
    if (attrs.aStart.array[i] < -1e8) continue;
    out.push({
      x: attrs.position.array[i * 3],
      y: attrs.position.array[i * 3 + 1],
      vx: attrs.aVelocity.array[i * 3],
      vy: attrs.aVelocity.array[i * 3 + 1],
      r: attrs.aColor.array[i * 3],
      g: attrs.aColor.array[i * 3 + 1],
      b: attrs.aColor.array[i * 3 + 2],
      size: attrs.aSize.array[i],
      life: attrs.aLife.array[i],
      turb: attrs.aTurb.array[i],
      clip: attrs.aClip.array[i],
    });
  }
  return out;
}

/** One impact, from an empty buffer, handing back what it put in there. */
function fire(o) {
  resetParticles();
  resetBallSpit();
  const asked = spitBallBubbles(o);
  return { asked, p: live() };
}

/**
 * ONE FAN AT A TIME. The two overlap in every attribute they carry — size,
 * life and drag bands all cross — so they cannot be told apart in the buffer
 * after the fact. Pointing the other fan's emitter at a name that does not
 * exist is how one is isolated: `fan` in ballSpit.js returns nothing for an
 * emitter it cannot resolve, which is the same path a typo would take.
 */
function only(which, o) {
  const key = which === 'jet' ? 'washEmitter' : 'jetEmitter';
  const keep = S[key];
  S[key] = '__none__';
  try { return fire(o); } finally { S[key] = keep; }
}

const bearing = (p) => Math.atan2(p.vy, p.vx);
/** Mean bearing of a population, the only way that works on a circle. */
function meanBearing(list) {
  let sx = 0; let sy = 0;
  for (const p of list) { const a = bearing(p); sx += Math.cos(a); sy += Math.sin(a); }
  return Math.atan2(sy, sx);
}
/** Signed shortest angle from a to b. */
function delta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function spread(list, about) {
  let worst = 0;
  for (const p of list) worst = Math.max(worst, Math.abs(delta(about, bearing(p))));
  return worst;
}

// The strike's own arrangement, and it is the case the whole feature exists
// for: the ball is struck on its LEFT side (the normal points +x, the way it is
// driven) and the dash was running up and across, so `grip` has swung the line
// the ball leaves on well off the normal. Anything that quietly uses the normal
// where it should use the impulse reads as a pass here and only here.
const NORMAL = { nx: 1, ny: 0 };
const IMP = { impX: Math.cos(0.9), impY: Math.sin(0.9) };
const HIT = {
  x: -2.6, y: DEEP, ...NORMAL, ...IMP,
  force: 1, vx: 0, vy: 0, r: 2.6, color: 0x00ff00,
};

// ---------------------------------------------------------------------------
section('IT COMES OUT AT ALL, AND OUT OF THE PATCH');
{
  const { asked, p } = fire(HIT);
  check('a full-force hit spits a cloud', p.length > 20,
    `${p.length} bubbles for ${asked} asked`);
  // SMALL, and the number that matters is against the WAKE — these are the
  // same ball's bubbles and they are on screen together, so "small" only means
  // anything relative to the ones that are already there.
  const wake = CONFIG.emitters[CONFIG.versus.ball.trail.water.bubbles.emitter];
  const wakeBig = wake.size[1] * (CONFIG.versus.ball.trail.water.bubbles.sizeMul ?? 1);
  // Half, give or take. There is a floor as well as a ceiling on "small" and
  // it is not written as a check because it is a judgement about zoom rather
  // than about code: under about a third of the wake these stop reading as
  // water at match distance. See the note on the emitter.
  check('...small ones, next to the wake\'s',
    Math.max(...p.map((q) => q.size)) < wakeBig * 0.7,
    `biggest ${Math.max(...p.map((q) => q.size)).toFixed(3)}u against the wake's ${wakeBig.toFixed(3)}u`);
  check('...and short-lived', p.every((q) => q.life <= Math.max(JET.life[1], WASH.life[1]) * 1.01),
    `longest ${Math.max(...p.map((q) => q.life)).toFixed(2)}s`);

  // OUT OF THE CONTACT, NOT OUT OF THE MIDDLE. The ball's centre is `r` along
  // the normal from the contact point, which is the position the wake would
  // have used and the one thing this must not be doing.
  const cx = HIT.x + NORMAL.nx * HIT.r;
  const cy = HIT.y + NORMAL.ny * HIT.r;
  const toContact = p.map((q) => Math.hypot(q.x - HIT.x, q.y - HIT.y));
  const toCentre = p.map((q) => Math.hypot(q.x - cx, q.y - cy));
  const mean = (l) => l.reduce((a, b) => a + b, 0) / l.length;
  check('it is born on the contact patch rather than at the ball\'s middle',
    mean(toContact) < mean(toCentre) * 0.5,
    `${mean(toContact).toFixed(2)}u from the contact against ${mean(toCentre).toFixed(2)}u from the centre`);

  // The patch is a SPREAD, not a point: this is the half of the churn that is
  // about where the puffs sit rather than where they are thrown.
  const across = p.map((q) => (q.x - HIT.x) * -NORMAL.ny + (q.y - HIT.y) * NORMAL.nx);
  const width = Math.max(...across) - Math.min(...across);
  check('...spread across the patch rather than fired from one point',
    width > HIT.r * S.patch * 0.5,
    `${width.toFixed(2)}u wide on a ${(HIT.r * S.patch).toFixed(2)}u patch`);
}

// ---------------------------------------------------------------------------
section('THE JET IS THE DIRECTION OF THE IMPULSE');
{
  const { p } = only('jet', HIT);
  const aim = Math.atan2(IMP.impY, IMP.impX);
  const norm = Math.atan2(NORMAL.ny, NORMAL.nx);
  const got = meanBearing(p);
  check('the jet is thrown on the line the ball leaves on',
    Math.abs(delta(aim, got)) < 0.25,
    `${got.toFixed(2)} rad against the impulse at ${aim.toFixed(2)}`);
  // The trap, stated as its own check: the normal is right there in the same
  // call and is what every other caller passes.
  check('...and not along the contact normal it was also handed',
    Math.abs(delta(aim, got)) < Math.abs(delta(norm, got)),
    `${Math.abs(delta(aim, got)).toFixed(2)} off the impulse, ${Math.abs(delta(norm, got)).toFixed(2)} off the normal`);

  // ...AND THE DEFAULT IS THE NORMAL, which is what a wall passes and is exact
  // there: the rock's impulse IS its inward normal.
  const wall = only('jet', { ...HIT, impX: null, impY: null, color: null });
  check('a caller with no line of its own gets the normal',
    Math.abs(delta(norm, meanBearing(wall.p))) < 0.25,
    `${meanBearing(wall.p).toFixed(2)} rad against a normal at ${norm.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('THE WASH IS THE SOURCE');
{
  const { p } = only('wash', HIT);
  const back = Math.atan2(-NORMAL.ny, -NORMAL.nx);
  const got = meanBearing(p);
  check('the wash is thrown back out of the pinch, toward the striker',
    Math.abs(delta(back, got)) < 0.3,
    `${got.toFixed(2)} rad against ${back.toFixed(2)}`);
  // The two fans have to be on OPPOSITE sides of the patch or the wash has
  // merged into the jet and the source is no longer being said.
  const jet = only('jet', HIT);
  check('...on the far side of the patch from the jet',
    Math.abs(delta(meanBearing(jet.p), got)) > Math.PI / 2,
    `${Math.abs(delta(meanBearing(jet.p), got)).toFixed(2)} rad apart`);
  check('...and slower than it', 
    p.reduce((a, q) => a + Math.hypot(q.vx, q.vy), 0) / p.length
      < jet.p.reduce((a, q) => a + Math.hypot(q.vx, q.vy), 0) / jet.p.length,
    'water that stayed behind against water that left with the ball');
}

// ---------------------------------------------------------------------------
section('THE NOISE IS STRUCTURED, NOT ROLLED');
{
  const { p } = only('jet', HIT);
  const got = meanBearing(p);
  const wide = spread(p, got);
  // The emitter's own cone is all a single clean puff could ever give. Wider
  // than that is the puffs themselves being bent and jittered apart, which is
  // the whole of the churn at impact scale.
  check('the cloud is wider than one cone of the emitter\'s',
    wide > JET.cone * 1.2,
    `${wide.toFixed(2)} rad against a cone of ${JET.cone}`);
  check('...and the current is switched on for every bubble in it',
    p.every((q) => q.turb > 0),
    `turbulence ${JET.turbulence} x CONFIG.fx.turbulence`);
  // Two identical impacts must not draw the same cloud — the wander and the
  // per-puff speed scatter are the only things stopping a volley being the same
  // frame played back four times.
  const a = only('jet', HIT).p.map(bearing).sort();
  const b = only('jet', HIT).p.map(bearing).sort();
  check('...and no two impacts fold the same way',
    a.some((v, i) => Math.abs(v - (b[i] ?? 0)) > 1e-6));
}

// ---------------------------------------------------------------------------
section('HOW HARD IT WAS HIT');
{
  const hard = fire(HIT).p.length;
  const soft = fire({ ...HIT, force: 0.15 }).p.length;
  check('a hard hit spits more than a soft one', soft > 0 && soft < hard,
    `${soft} at 0.15 force against ${hard} at full`);
  // THE RAMP IS CONCAVE, and it is the reason an ordinary pass is visible at
  // all: force is impulse over the hardest strike there is, so most touches in
  // a normal possession land down around a fifth.
  check('...but a fifth-force touch is not a fifth of the cloud',
    soft > hard * 0.15,
    `${soft} against the ${(hard * 0.15).toFixed(0)} a linear ramp would give`);
  check('a touch under the floor spits nothing',
    fire({ ...HIT, force: S.minForce * 0.5 }).p.length === 0);
  // The ceiling, which is the only thing between a tuned-up ramp and a frame
  // that is all foam.
  check('one impact never goes past its ceiling',
    fire({ ...HIT, force: 1 }).asked <= S.maxParticles,
    `${fire({ ...HIT, force: 1 }).asked} of ${S.maxParticles}`);
}

// ---------------------------------------------------------------------------
section('THERE IS NOTHING TO BOIL IN THE AIR');
{
  const dry = fire({ ...HIT, y: bounds.surfaceY + 6 });
  check('a touch above the water line spits nothing', dry.p.length === 0,
    'a lob volleyed in the air still gets its splash, goo and sound');
  // Measured against the WAVING surface, not the flat line: the ball spends
  // half a match within a wave height of it, and that is exactly where the two
  // disagree.
  check('...measured against the wave rather than the flat line',
    fire({ ...HIT, y: surfaceHeightAt(HIT.x) - 0.5 }).p.length > 0,
    `surface at ${surfaceHeightAt(HIT.x).toFixed(2)} against a flat ${bounds.surfaceY.toFixed(2)}`);
  check('...and a caller that knows better is believed',
    fire({ ...HIT, y: bounds.surfaceY + 6, underwater: true }).p.length > 0);
}

// ---------------------------------------------------------------------------
section('WHOSE HIT IT WAS');
{
  const green = fire({ ...HIT, color: 0x00ff00 }).p;
  const plain = fire({ ...HIT, color: null }).p;
  const meanG = (l) => l.reduce((a, q) => a + q.g / Math.max(1e-6, q.r + q.g + q.b), 0) / l.length;
  check('a seal\'s touch carries its team into the water',
    meanG(green) > meanG(plain) + 0.02,
    `${meanG(green).toFixed(3)} green against ${meanG(plain).toFixed(3)}`);
  check('a wall\'s does not — a wall is nobody\'s',
    Math.abs(meanG(plain) - 1 / 3) < 0.05,
    `${meanG(plain).toFixed(3)}, which is water`);
  // A MIX AND NEVER A REPLACEMENT. At 1 these stop being bubbles and become a
  // coloured puff, which reads as an ability firing rather than as the sea
  // being displaced.
  check('...and it is a mix rather than a repaint',
    green.every((q) => q.r > 1e-3 && q.b > 1e-3),
    `tint ${S.tint}`);
}

// ---------------------------------------------------------------------------
section('WHERE ON THE BODY');
{
  // The same ball, struck on the nose and on the shoulder. If the bearing of
  // the contact is not reaching the cloud, these land in the same place — which
  // is the failure mode the whole file is about, written as one check.
  const nose = fire({ ...HIT, nx: 1, ny: 0, impX: 1, impY: 0 }).p;
  const over = fire({ ...HIT, nx: 0, ny: 1, impX: 0, impY: 1 }).p;
  const mid = (l, k) => l.reduce((a, q) => a + q[k], 0) / l.length;
  check('a hit on the shoulder does not draw the hit on the nose',
    Math.hypot(mid(nose, 'x') - mid(over, 'x'), mid(nose, 'y') - mid(over, 'y')) > 0.2
      || Math.abs(delta(meanBearing(nose), meanBearing(over))) > 0.5,
    `${Math.abs(delta(meanBearing(nose), meanBearing(over))).toFixed(2)} rad apart`);
}

// ---------------------------------------------------------------------------
section('THE BALL\'S NEW VELOCITY GOES WITH IT');
{
  // The jet is the ball's own water leaving WITH it, so it keeps the new
  // velocity; a burst that ignored it would hang in the water while the ball
  // pulled away from it.
  //
  // AVERAGED OVER MANY IMPACTS. One burst is a few dozen particles whose own
  // throw is tens of units wide, so the mean of a single burst carries an error
  // bigger than the whole inherit term — a check on one burst reads as noise
  // whichever way the code is written.
  const meanVx = (which, vx, runs = 30) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < runs; i++) {
      for (const q of only(which, { ...HIT, vx, vy: 0 }).p) { sum += q.vx; n++; }
    }
    return sum / Math.max(1, n);
  };
  const jetStill = meanVx('jet', 0);
  const jetFast = meanVx('jet', 40);
  const want = 40 * (S.jetInherit ?? 1) * (JET.inherit ?? 0);
  check('a fast ball drags its jet along with it',
    jetFast - jetStill > want * 0.6,
    `${(jetFast - jetStill).toFixed(1)} u/s of the ${want.toFixed(1)} it should carry`);
  const washStill = meanVx('wash', 0);
  const washFast = meanVx('wash', 40);
  check('...and the wash barely does — it is the water that stayed behind',
    washFast - washStill < (jetFast - jetStill) * 0.5,
    `${(washFast - washStill).toFixed(1)} against the jet's ${(jetFast - jetStill).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('SWITCHED OFF');
{
  const keep = S.enabled;
  S.enabled = false;
  check('the master switch spits nothing', fire(HIT).p.length === 0);
  S.enabled = keep;
  check('...and it comes back', fire(HIT).p.length > 0);
  check('the stats count the asks', ballSpitStats().bursts === 1
    && ballSpitStats().particles > 0,
    `${ballSpitStats().bursts} burst, ${ballSpitStats().particles} particles`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
