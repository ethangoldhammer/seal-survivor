#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE WIND-UP'S LINE — one per seal, out of the head, along the dash a release
// right now would actually fly.
//
// WHAT THIS IS GUARDING. The line replaced a lens corridor that said the same
// thing by DARKENING everything that was not the answer, and the three ways
// the replacement can be quietly wrong all render something plausible:
//
//   - drawn from two points rather than from the forecast's own samples. That
//     looks identical TODAY, because the forecast is a straight line (see the
//     note in predictDash) — so the check here is that the samples are the
//     ones being drawn and that their uneven, drag-slowed SPACING survives.
//     The day the forecast gains a curve, a two-point line goes wrong and
//     nothing else would have noticed.
//   - drawn for ONE seal, which is the exact limitation the corridor had and
//     the reason it was replaced: a lens has one frame.
//   - left lit after the wind-up ends, which is a line pointing somewhere
//     nobody is going.
//
// None of the three throws.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n) => console.log(`\n${n}`);

const { predictDash } = await import('../path/src/systems/strike.js');
const sp = await import('../path/src/systems/strikePath.js');
const { player } = await import('../path/src/entities/player.js');

// ---------------------------------------------------------------------------
section('the forecast records its flight, not just where it ended');

const out = { dir: { x: 0, y: 0 }, reach: 0, x: 0, y: 0, path: [] };
const stats = player.stats ?? {};

// Stick and aim deliberately disagreeing — the case that LOOKS like it should
// bend the flight, and does not: strikeDirection takes the stick when it is
// pushed, and that same heading is what dashSteer is then told to steer toward.
predictDash({ x: 1, y: 0 }, { x: 0, y: 1 }, 1, stats, 1, out);
check('a dash with a stick on it has a reach', out.reach > 0.001, String(out.reach));
check('...and the path was recorded', out.path.length >= 4, `${out.path.length / 2} points`);
check('the path starts at the seal', out.path[0] === 0 && out.path[1] === 0);

// THE SAMPLES ARE ON THE LAUNCH LINE, and this is asserted rather than assumed
// because the first version of this file assumed the opposite. dashSteer is
// handed `launch` as its target and the flight starts on it, so there is
// nothing to turn toward — the forecast is straight, and a comment elsewhere
// about the real dash bending is about the real dash, which carries momentum
// this forecast does not model.
{
  const n = out.path.length / 2;
  const ex = out.path[(n - 1) * 2];
  const ey = out.path[(n - 1) * 2 + 1];
  const len = Math.hypot(ex, ey) || 1;
  let worst = 0;
  for (let i = 0; i < n; i += 1) {
    worst = Math.max(worst,
      Math.abs((out.path[i * 2] * ey - out.path[i * 2 + 1] * ex) / len));
  }
  check('every sample lands on the launch line', worst < 1e-6,
    `worst offset ${worst.toFixed(6)}`);
  check('...and the last one is the chord\u2019s end',
    Math.abs(Math.hypot(ex, ey) - out.reach) < 1e-6, `${Math.hypot(ex, ey)} vs ${out.reach}`);

  // THE SPACING IS THE REASON THE SAMPLES EXIST. The seal decelerates the
  // whole flight, so the gaps must SHRINK — a line drawn from two points and
  // divided evenly would put its taper and its fade in the wrong places, and
  // would be the wrong shape outright once the forecast can curve.
  const gap = (i) => Math.hypot(out.path[(i + 1) * 2] - out.path[i * 2],
                                out.path[(i + 1) * 2 + 1] - out.path[i * 2 + 1]);
  check('the samples are NOT evenly spaced — the dash is slowing down',
    gap(n - 2) < gap(0) * 0.95, `first ${gap(0).toFixed(3)} last ${gap(n - 2).toFixed(3)}`);
}

// A CALLER THAT DOES NOT WANT THE PATH PAYS NOTHING. The corridor reads two
// numbers 60 times a second and must not be made to fill an array for them.
{
  const lean = { dir: { x: 0, y: 0 }, reach: 0, x: 0, y: 0 };
  predictDash({ x: 1, y: 0 }, { x: 0, y: 1 }, 1, stats, 1, lean);
  check('a forecast with no path array still answers', lean.reach > 0.001);
  check('...and grew no array', lean.path === undefined);
}

// Nothing to fire is not a zero-length line, it is no line.
{
  const none = { dir: { x: 0, y: 0 }, reach: 0, x: 0, y: 0, path: [] };
  predictDash({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, stats, 1, none);
  check('idle hands forecast nothing', none.reach === 0);
}

// ---------------------------------------------------------------------------
section('the line itself');

const scene = new THREE.Scene();
sp.initStrikePaths(scene);

predictDash({ x: 1, y: 0 }, { x: 0, y: 1 }, 1, stats, 1, out);

// EVERY SEAT, NOT ONE. This is the limitation that made the lens corridor the
// wrong instrument for a match: it had one frame, so three seals winding up at
// once drew the framed one and left the rest of the pitch silent.
sp.drawStrikePath(0, 10, 5, out.path, 1, 0x3366ff);
sp.drawStrikePath(1, -20, -3, out.path, 0.6, 0xff8833);
sp.drawStrikePath(2, 0, 0, out.path, 0.4, 0x66ff99);
check('three seals winding up at once draw three lines', sp.litStrikePaths() === 3,
  String(sp.litStrikePaths()));

// THE LINE STARTS AT THE HEAD IT WAS GIVEN. A line drawn from the body's
// centre starts inside the animal and reads as a skewer.
{
  const pts = sp.strikePathPoints(0);
  check('the line starts at the head it was handed',
    Math.abs(pts[0] - 10) < 1e-3 && Math.abs(pts[1] - 5) < 1e-3, `${pts[0]}, ${pts[1]}`);
  // ...and the far end is the forecast's landing point, in world units.
  const n = pts.length / 2;
  check('...and ends where the dash lands',
    Math.abs(pts[(n - 1) * 2] - (10 + out.x)) < 0.2
    && Math.abs(pts[(n - 1) * 2 + 1] - (5 + out.y)) < 0.2,
    `${pts[(n - 1) * 2]},${pts[(n - 1) * 2 + 1]} vs ${10 + out.x},${5 + out.y}`);

  // THE DRAWN LINE CARRIES THE FORECAST'S OWN SAMPLES, spacing and all. A
  // geometry built from two points and subdivided evenly would pass every
  // check above; this is the one that says the samples themselves are what is
  // on screen.
  check('the drawn line has a vertex per forecast sample', n === out.path.length / 2,
    `${n} drawn vs ${out.path.length / 2} forecast`);
  const dGap = (i) => Math.hypot(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
  check('...including the deceleration in its spacing', dGap(n - 2) < dGap(0) * 0.95,
    `first ${dGap(0).toFixed(3)} last ${dGap(n - 2).toFixed(3)}`);
}

// A wind-up that ends takes its line with it.
sp.hideStrikePath(1);
check('a seal that stops charging loses its line', sp.litStrikePaths() === 2,
  String(sp.litStrikePaths()));
sp.resetStrikePaths();
check('a kickoff clears them all', sp.litStrikePaths() === 0);

// NO CHARGE IS NO LINE, not a line at zero alpha: an invisible mesh still
// costs an upload every frame somebody is holding nothing.
sp.drawStrikePath(0, 0, 0, out.path, 0, 0xffffff);
check('a wind-up with no power draws nothing', sp.litStrikePaths() === 0);

// A path too short to have a direction is refused rather than drawn as a
// degenerate ribbon, which renders as nothing but still uploads.
sp.drawStrikePath(0, 0, 0, [0, 0], 1, 0xffffff);
check('a one-point path is refused', sp.litStrikePaths() === 0);

// ---------------------------------------------------------------------------
section('the lens corridor is off, and cannot be switched back on by stale tuning');

// THE RENAME IS THE POINT. imported-tuning.json holds `path.enabled: true`,
// and a saved value outranks a config default — so re-defaulting the old key
// would have changed nothing, on Ethan's machine only, in a way that looks
// exactly like the code not working. The corridor is gated on `lensLane`,
// which nothing has ever saved.
const lens = CONFIG.cinecam?.lens?.path ?? {};
check('the corridor is gated on lensLane', lens.lensLane === false, String(lens.lensLane));
check('...and its geometry is kept, so it can be turned back on',
  typeof lens.width === 'number' && typeof lens.vignette === 'number',
  JSON.stringify({ width: lens.width, vignette: lens.vignette }));

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
