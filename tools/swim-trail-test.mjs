#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:swimtrail
//
// THE SWIM TRAIL — the white ribbon the seal draws underwater, which is
// systems/breachTrail.js's `water` profile: the SAME code as the breach trail,
// with CONFIG.breachTrail.water laid over the air numbers.
//
// That sharing is exactly what makes this worth testing, because the two ways
// it can be wrong are both invisible:
//
//   THE PROFILES BLEED. The air and water trails share every function in the
//   file, and anything that was module-level state when there was one trail is
//   now a thing two trails can fight over. The particle cap was one (whichever
//   profile ran last set it for both); the "was the gate open last frame" flag
//   was another. A leak of that kind does not throw — it truncates the breach
//   cloud mid-arc, or joins two swim bursts with a ribbon drawn straight across
//   the arena, and both read as art problems.
//
//   THE OVERRIDE STOPS OVERRIDING. `water` names only what differs and inherits
//   the rest. A key that stops being read, or a spread that goes the wrong way
//   round, silently gives the water trail the AIR trail's numbers — which is a
//   three-channel RGB split underwater, i.e. the rainbow the whole design
//   avoids, at breach brightness.
//
// Everything expected is read from CONFIG. imported-tuning.json is merged at
// import and wins over config.js, so a literal here would test the tuning file.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import {
  updateBreachTrail, clearBreachTrail, breachTrailCount, breachTrailNodes,
} from '../path/src/systems/breachTrail.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

updateBounds(16 / 9);

const W = CONFIG.breachTrail.water;
const AIR = CONFIG.breachTrail;

// A seal with two fin anchors, the way systems/aimRig.js publishes them. The
// harness builds its own rather than booting the player because the trail reads
// exactly three things off it — the mesh position, the velocity, and the rig's
// finL/finR — and a hand-built one makes all three controllable.
const finL = new THREE.Vector3();
const finR = new THREE.Vector3();
const seal = {
  mesh: new THREE.Object3D(),
  velocity: new THREE.Vector2(0, 0),
  aimRig: { anchors: { finL, finR }, muzzles: [] },
};

const DEPTH = bounds.surfaceY - 8;

/** Swim horizontally at `speed` for `frames`, underwater unless told otherwise. */
function swim(speed, frames, { y = DEPTH, charge = 0 } = {}) {
  for (let i = 0; i < frames; i++) {
    const x = seal.mesh.position.x + speed * dt;
    seal.mesh.position.set(x, y, 0);
    finL.set(x - 1, y + 0.5, 0);
    finR.set(x - 1, y - 0.5, 0);
    seal.velocity.set(speed, 0);
    updateBreachTrail(dt, scene, seal, 0, true, charge);
  }
}

/** Hold still — the gate shuts, and the cloud is left to drift and die. */
function coast(frames, { y = DEPTH, charge = 0 } = {}) {
  for (let i = 0; i < frames; i++) {
    seal.velocity.set(0, 0);
    seal.mesh.position.y = y;
    updateBreachTrail(dt, scene, seal, 0, true, charge);
  }
}

function reset() {
  clearBreachTrail(scene);
  seal.mesh.position.set(0, DEPTH, 0);
  seal.velocity.set(0, 0);
}

const swimRoot = () => scene.getObjectByName('swimTrail');
const airRoot = () => scene.getObjectByName('breachTrail');

// ---------------------------------------------------------------------------
section('THE OVERRIDE — one settings block laid over another, not a second effect');
{
  // The mechanism, asserted where it lives. The channel count is the LENGTH of
  // the colour list, which is why one white entry is the whole of "no split".
  check('the water profile declares exactly one channel',
    Array.isArray(W.colors) && W.colors.length === 1,
    `${W.colors?.length} colour(s)`);
  check('...and the air profile still declares three',
    AIR.colors.length === 3, `${AIR.colors.length} channels`);
  check('the one colour is white', W.colors[0] === 0xffffff,
    '#' + W.colors[0].toString(16).padStart(6, '0'));

  // INHERITANCE, both directions. A key the water block does not name must come
  // from the air block, and a key it does name must win. If the spread were
  // written the wrong way round the second of these would fail while the first
  // still passed, which is why both are here.
  const inherited = ['fade', 'softness', 'blowWave', 'foldSafety', 'headTaper', 'tailTaper', 'curveSmooth'];
  const missing = inherited.filter((k) => k in W);
  check('the water block names only what differs', missing.length === 0,
    missing.length ? `also names ${missing.join(', ')}` : `${inherited.length} knobs inherited`);

  check('the erase is off underwater', W.erase?.enabled === false,
    'a wipe several times a second is an event announcing nothing');
  check('...and still on in the air', AIR.erase.enabled === true);

  // The swim trail must stay the QUIETER of the two. This is the one balance
  // the whole effect depends on: the breach is the loudest move in the game and
  // its trail has to stay the loudest thing on the water.
  check('the swim trail is thinner than the breach trail', W.width < AIR.width,
    `${W.width} vs ${AIR.width}`);
  check('...dimmer', W.glow < AIR.glow, `${W.glow} vs ${AIR.glow}`);
  check('...shorter-lived', W.life < AIR.life, `${W.life}s vs ${AIR.life}s`);
  check('...and thrown about less', W.blowOut < AIR.blowOut && W.turbulence < AIR.turbulence,
    `kick ${W.blowOut} vs ${AIR.blowOut}, turbulence ${W.turbulence} vs ${AIR.turbulence}`);
}

// ---------------------------------------------------------------------------
section('THE GATE — speed, and only underwater');
{
  reset();
  // Below minSpeed: nothing. A trail laid down by a drifting seal is permanent
  // screen furniture, and brightest exactly when the player is reading the
  // water for what is about to hit them.
  swim(Math.max(0, W.minSpeed - 2), 40);
  check('a slow swim draws nothing', breachTrailCount('water') === 0,
    `${breachTrailCount('water')} particles below ${W.minSpeed} u/s`);

  reset();
  swim(W.fullSpeed, 40);
  const fast = breachTrailCount('water');
  check('a fast swim draws a trail', fast > 20, `${fast} particles`);
  check('...and the AIR trail stays empty', breachTrailCount('air') === 0,
    'the seal never left the water');

  // RAMPED, not switched. Half-way up the ramp must lay down visibly less than
  // the top of it — that is the difference between fading in and popping on.
  const mid = W.minSpeed + (W.fullSpeed - W.minSpeed) * 0.5;
  reset();
  swim(mid, 40);
  const half = breachTrailCount('water');
  check('the rate ramps with speed rather than switching on',
    half > 0 && half < fast * 0.75,
    `${half} at ${mid.toFixed(1)} u/s against ${fast} at ${W.fullSpeed}`);

  // ...and the ramp is stamped on the particle, so a faster seal draws a
  // BRIGHTER trail too, through the same term the air trail uses for hang time.
  const litAt = (speed) => {
    reset();
    swim(speed, 40);
    const g = swimRoot().children[0].children[0];
    const col = g.geometry.attributes.aColor;
    let peak = 0;
    for (let i = 0; i < col.count; i++) peak = Math.max(peak, col.getX(i));
    return peak;
  };
  const slowLit = litAt(mid);
  const fastLit = litAt(W.fullSpeed);
  check('a faster swim draws a brighter trail', fastLit > slowLit * 1.05,
    `${slowLit.toFixed(2)} at half speed vs ${fastLit.toFixed(2)} at full`);

  // ABOVE THE LINE IT IS THE OTHER TRAIL'S JOB. A seal flying at full tilt is
  // airborne, and both trails firing at once would double every breach.
  reset();
  swim(W.fullSpeed, 40, { y: bounds.surfaceY + 6 });
  check('a fast seal in the AIR draws no swim trail', breachTrailCount('water') === 0,
    `${breachTrailCount('water')} particles above the line`);
  check('...it draws the breach trail instead', breachTrailCount('air') > 20,
    `${breachTrailCount('air')} particles`);
}

// ---------------------------------------------------------------------------
section('ONE RIBBON, NO SPLIT');
{
  reset();
  swim(W.fullSpeed, 40);
  const plume0 = swimRoot()?.children?.[0];
  check('one plume per fin', swimRoot()?.children.length === 2,
    `${swimRoot()?.children.length} plumes`);
  check('one ribbon per plume, not three', plume0?.children.length === 1,
    `${plume0?.children.length} ribbon(s) — three would be the RGB split underwater`);

  // Every lit vertex is neutral. A channel that leaked in would show as one of
  // r/g/b running ahead of the others.
  const col = plume0.children[0].geometry.attributes.aColor;
  let worst = 0;
  for (let i = 0; i < col.count; i++) {
    const r = col.getX(i);
    const g = col.getY(i);
    const b = col.getZ(i);
    if (Math.max(r, g, b) < 1e-4) continue;
    worst = Math.max(worst, Math.abs(r - g), Math.abs(g - b));
  }
  check('the ribbon is neutral all the way along', worst < 1e-4,
    `worst channel imbalance ${worst.toExponential(1)}`);
}

// ---------------------------------------------------------------------------
section('THE TAIL FINS — the same two anchors the bubble wake sheds from');
{
  reset();
  swim(W.fullSpeed, 40);
  const pts = breachTrailNodes('water');
  const onBody = pts.filter(([, y]) => Math.abs(y - DEPTH) < 0.2).length;
  const onFins = pts.filter(([, y]) =>
    Math.abs(y - (DEPTH + 0.5)) < 0.9 || Math.abs(y - (DEPTH - 0.5)) < 0.9).length;
  check('particles are born at the flipper tips', onFins > pts.length * 0.8,
    `${onFins} of ${pts.length}`);
  check('...and not out of the body centre', onBody < pts.length * 0.15,
    `${onBody} of ${pts.length}`);
}

// ---------------------------------------------------------------------------
section('THE STRAND — two bursts of speed are not one ribbon');
{
  reset();
  // Swim, ease off, jump a long way, and go again. Without a strand boundary
  // the ribbon is threaded straight from the end of the first burst to the
  // start of the second — a bright stripe across the arena.
  //
  // THE TIMING IS THE HARD PART OF THIS TEST, not the assertion. A water
  // particle lives well under a second, so a leisurely coast plus a leisurely
  // second burst outlives the FIRST one entirely — leaving one strand on
  // screen, no gap, and a check that passes while proving nothing. That is what
  // this test did first. Both windows are therefore kept comfortably inside
  // `life`, and the two clusters are asserted to exist before anything is
  // measured between them.
  swim(W.fullSpeed, 20);
  coast(4);
  seal.mesh.position.x += 40;
  swim(W.fullSpeed, 10);

  // Split the particles at their biggest x gap: that IS the boundary, found
  // from the data rather than from arithmetic on where the bursts were meant
  // to be.
  const xs = breachTrailNodes('water').map(([x]) => x).sort((a, b) => a - b);
  let gapAt = 0;
  let gap = 0;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; gapAt = i; }
  }
  const older = xs.slice(0, gapAt);
  const newer = xs.slice(gapAt);
  check('both bursts are still on screen', gap > 20 && older.length > 3 && newer.length > 3,
    `${older.length} + ${newer.length} particles either side of a ${gap.toFixed(1)}u gap`);

  // Anything LIT strictly inside that gap is a ribbon spanning it. The margin
  // keeps the two bursts' own tapered ends out of the window.
  const lo = older[older.length - 1] + gap * 0.15;
  const hi = newer[0] - gap * 0.15;
  let spanning = 0;
  for (const plume of swimRoot().children) {
    const pos = plume.children[0].geometry.attributes.position;
    const col = plume.children[0].geometry.attributes.aColor;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (x > lo && x < hi && col.getX(i) > 1e-3) spanning++;
    }
  }
  check('nothing is drawn across the gap between two bursts', spanning === 0,
    `${spanning} lit vertices between x ${lo.toFixed(1)} and ${hi.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('THE WIND-UP — the trail telegraphs a charging strike');
{
  const B = CONFIG.breachTrail.charge;

  // THE ONE THAT MATTERS. Holding brakes the seal to a standstill, which is
  // exactly the state the speed gate exists to shut — so a telegraph that only
  // scaled an existing trail would be silent for nearly every wind-up actually
  // taken. The charge has to OPEN the gate.
  reset();
  coast(30, { charge: 1 });
  const stopped = breachTrailCount('water');
  check('a full hold draws a trail from a dead stop', stopped > 20,
    `${stopped} particles at zero speed — the state a wind-up usually IS`);

  reset();
  coast(30, { charge: 0 });
  check('...and a dead stop with no hold still draws nothing',
    breachTrailCount('water') === 0, `${breachTrailCount('water')} particles`);

  // MORE HOLD, MORE TRAIL. Measured as particle count, which is rate x life —
  // the two knobs that between them make the plume reach further and read solid
  // at that length.
  const held = (wind) => { reset(); coast(30, { charge: wind }); return breachTrailCount('water'); };
  const quarter = held(0.25);
  const half = held(0.5);
  const full = held(1);
  check('the longer the hold, the more trail', quarter < half && half < full,
    `${quarter} -> ${half} -> ${full} particles at 25% / 50% / 100% charge`);

  // ...AND BRIGHTER. Through `glow` rather than the ramp — the ramp is clamped
  // to 1 in resampleSpine, so a boost routed through it would do nothing once a
  // hold was past its first fraction and would look exactly like a dead wire.
  const litAtCharge = (wind) => {
    reset();
    swim(W.fullSpeed, 30, { charge: wind });
    const col = swimRoot().children[0].children[0].geometry.attributes.aColor;
    let peak = 0;
    for (let i = 0; i < col.count; i++) peak = Math.max(peak, col.getX(i));
    return peak;
  };
  const plain = litAtCharge(0);
  const wound = litAtCharge(1);
  check('a full hold burns brighter than the same swim without one',
    wound > plain * 1.2,
    `${plain.toFixed(2)} -> ${wound.toFixed(2)} peak — at the SAME speed, so it is the charge`);

  // THE CEILING MOVES WITH IT. rate x life is the population and `maxNodes` is
  // the clamp on it; a boost that raised both and not the cap would emit every
  // extra particle and pop it straight off the end of the list. The trail would
  // be churnier and no longer, with nothing to say why.
  //
  // Driven deliberately past the unboosted ceiling rather than trusting the
  // shipped multipliers to get there. They are tuned by eye and currently land
  // just UNDER it — so a check written against them would be passing on a
  // coincidence today and would go quiet, still green, the first time somebody
  // eased them off. What is being tested is that the cap scales at all.
  const wasLife = B.life;
  const wasRate = B.rate;
  B.life = 4;
  B.rate = 4;
  reset();
  coast(220, { charge: 1 });
  const perPlume = breachTrailCount('water') / Math.max(1, swimRoot().children.length);
  B.life = wasLife;
  B.rate = wasRate;
  check('a wound-up trail is allowed past the unboosted ceiling',
    perPlume > W.maxNodes,
    `${perPlume.toFixed(0)} per plume at 4x against an unboosted ceiling of ${W.maxNodes}`);

  // GEOMETRY MUST NOT THRASH. Charge climbs continuously through a hold, and
  // anything boosted that feeds `samples` would dispose and rebuild both
  // BufferGeometries every frame of it.
  reset();
  coast(2, { charge: 0.1 });
  const geoBefore = swimRoot().children[0].children[0].geometry;
  for (let i = 1; i <= 30; i++) coast(1, { charge: i / 30 });
  check('a climbing charge does not rebuild the geometry every frame',
    swimRoot().children[0].children[0].geometry === geoBefore,
    'same BufferGeometry after a full ramp-up');

  // RELEASE. The boost stops applying to NEW particles at once, but the long
  // bright ones already laid keep what was stamped on them at birth — so the
  // tell blooms and dies during the dash instead of blinking off.
  reset();
  coast(30, { charge: 1 });
  const atRelease = breachTrailCount('water');
  coast(6, { charge: 0 });
  const justAfter = breachTrailCount('water');
  check('the cloud survives the release frame', justAfter > atRelease * 0.5,
    `${atRelease} -> ${justAfter} particles a tenth of a second after letting go`);
  coast(90, { charge: 0 });
  check('...and is gone once it has run its own clock out',
    breachTrailCount('water') === 0, `${breachTrailCount('water')} left`);

  // NOTHING IS WRITTEN BACK ONTO CONFIG. `c` for the air profile IS
  // CONFIG.breachTrail, so a boost applied in place would ratchet the stored
  // value up every frame of every hold and end up in the tuning file.
  const before = { life: W.life, glow: W.glow, width: W.width, airLife: AIR.life, airGlow: AIR.glow };
  reset();
  coast(60, { charge: 1 });
  swim(W.fullSpeed, 30, { y: bounds.surfaceY + 6, charge: 1 });
  check('a hold leaves CONFIG untouched',
    W.life === before.life && W.glow === before.glow && W.width === before.width
    && AIR.life === before.airLife && AIR.glow === before.airGlow,
    `water life ${before.life} -> ${W.life}, air glow ${before.airGlow} -> ${AIR.glow}`);

  // Switched off means switched off.
  reset();
  B.enabled = false;
  coast(30, { charge: 1 });
  check('charge.enabled = false restores the plain speed gate',
    breachTrailCount('water') === 0, `${breachTrailCount('water')} particles`);
  B.enabled = true;
}

// ---------------------------------------------------------------------------
section('THE TWO PROFILES DO NOT BLEED');
{
  // THE PARTICLE CAP. It was module-level state when there was one trail, so
  // whichever profile ran last set the ceiling for BOTH — and the water profile
  // has a much smaller one. A leak here truncates the breach cloud mid-arc,
  // which reads as the trail being too short rather than as a bug.
  reset();
  // Lay a full breach cloud, then a swim burst, then check the air cloud was
  // not trimmed to the water profile's ceiling on the way past.
  for (let i = 0; i < 90; i++) {
    const x = i * 0.5;
    seal.mesh.position.set(x, bounds.surfaceY + 6, 0);
    finL.set(x - 1, bounds.surfaceY + 6.5, 0);
    finR.set(x - 1, bounds.surfaceY + 5.5, 0);
    seal.velocity.set(30, 0);
    updateBreachTrail(dt, scene, seal, 1, true);
  }
  const airborneCount = breachTrailCount('air');
  check('the breach cloud is bigger than the swim profile would allow',
    airborneCount > W.maxNodes,
    `${airborneCount} particles, water ceiling is ${W.maxNodes} per plume`);

  // ...and the reverse: the swim cloud must obey ITS ceiling rather than
  // inheriting the air trail's roomier one.
  reset();
  swim(W.fullSpeed, 400);
  const perPlume = breachTrailCount('water') / Math.max(1, swimRoot().children.length);
  check('the swim cloud obeys its own ceiling', perPlume <= W.maxNodes + 1,
    `${perPlume.toFixed(0)} per plume against ${W.maxNodes}`);

  // SEPARATE SCENE ROOTS. Anything asking what the breach trail is doing must
  // not be handed a swim trail in the same answer.
  check('the two trails are separate scene nodes',
    !!swimRoot() && !!airRoot() && swimRoot() !== airRoot());
  check('...and clearing takes both', (() => {
    clearBreachTrail(scene);
    return !swimRoot() && !airRoot();
  })());
}

// ---------------------------------------------------------------------------
section('SWITCHED OFF');
{
  reset();
  W.enabled = false;
  swim(W.fullSpeed, 40);
  check('water.enabled = false draws nothing', breachTrailCount('water') === 0,
    `${breachTrailCount('water')} particles`);
  W.enabled = true;

  reset();
  CONFIG.breachTrail.enabled = false;
  swim(W.fullSpeed, 40);
  check('the master switch kills both', breachTrailCount('water') === 0 && !swimRoot());
  CONFIG.breachTrail.enabled = true;
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
