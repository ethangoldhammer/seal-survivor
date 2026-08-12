#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:strike
//
// Two things in systems/strike.js that are pure arithmetic, and therefore the
// two things in it that can be checked without a frame: where a dash GOES, and
// what a mouthful of chum is WORTH.
//
// The dash heading — strikeDirection() — is the one rule shared by the impulse
// the release applies and the corridor the lens paints during the wind-up.
// That sharing is the whole point of the function, so this checks the maths
// AND checks that both call sites really do go through it.
//
// Four things worth failing over:
//
//   HALFWAY    that the heading actually lands between the swim and the aim,
//              at the ANGULAR midpoint, for spreads all the way out to 180
//              degrees. Normalising (move + aim) passes most of these and then
//              returns NaN on the opposed case — which is ordinary play, you
//              swim away from the thing you're shooting — so the wrap is
//              tested explicitly rather than assumed.
//
//   INPUTS     that a half-pushed stick steers exactly as hard as a full one
//              (input.move carries analog magnitude, input.aim does not), that
//              a missing input hands the whole heading to the other, and that
//              the result is always a unit vector for anything that fires.
//
//   WIRING     that main.js reads the function for both the launch and the
//              prediction, and no longer carries the old movement-first rule
//              in either place. Source-level, because the alternative is a GL
//              context and a real frame.
//
//   APPETITE   that each successive FOOD CHAIN link genuinely takes more chum
//              to earn than the one before it, and that the floor keeps a deep
//              chain payable. This is the gate on the whole combo, and it is a
//              compounding curve with a clamp on it — exactly the shape that
//              looks fine and is quietly off by a link.
//
// What it cannot tell you: whether splitting the difference FEELS right, or
// whether the ramp bites at the right depth. Those are a controller in your
// hands.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { strikeDirection, strikeState, resetStrike, feedChum, chumRefillMul } from '../path/src/systems/strike.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '../path/src/main.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DEG = 180 / Math.PI;
const dir = (deg) => ({ x: Math.cos(deg / DEG), y: Math.sin(deg / DEG) });
const angleOf = (v) => Math.atan2(v.y, v.x) * DEG;
// Signed difference in degrees, wrapped to (-180, 180].
const delta = (a, b) => {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};
const close = (a, b, eps = 1e-6) => Math.abs(delta(a, b)) <= eps;

// The blend the game ships with. Everything below assumes halfway, so say so
// out loud rather than silently testing whatever a tuning file left behind.
section('CONFIG — the shipped blend');
check('strike.aimBlend is the halfway point', CONFIG.strike.aimBlend === 0.5,
  `got ${CONFIG.strike.aimBlend}`);

// ------------------------------------------------------------------- halfway

section('HALFWAY — the heading sits between the swim and the aim');

// Spreads from a nudge to fully opposed, in both rotational directions, from a
// swim heading that isn't axis-aligned so a lucky symmetry can't carry it.
for (const swimDeg of [0, 37, 90, 175, -120]) {
  for (const spread of [10, 45, 90, 135, 179]) {
    for (const sign of [1, -1]) {
      const aimDeg = swimDeg + sign * spread;
      const out = strikeDirection(dir(swimDeg), dir(aimDeg));
      const want = swimDeg + sign * spread / 2;
      check(`swim ${swimDeg}, aim ${aimDeg} -> ${want}`,
        close(angleOf(out), want, 1e-6), `got ${angleOf(out).toFixed(3)}`);
    }
  }
}

// The case that kills the naive normalize(move + aim): exactly opposed inputs
// sum to the zero vector. A heading is still owed here, it must be finite, and
// it must be perpendicular — the honest halfway between two opposite ways to
// go.
section('HALFWAY — exactly opposed inputs (the normalize(move+aim) trap)');
for (const swimDeg of [0, 90, -37, 180]) {
  const out = strikeDirection(dir(swimDeg), dir(swimDeg + 180));
  const finite = Number.isFinite(out.x) && Number.isFinite(out.y);
  check(`swim ${swimDeg}, aim reversed: finite`, finite, JSON.stringify(out));
  check(`swim ${swimDeg}, aim reversed: 90 deg off the swim`,
    finite && Math.abs(Math.abs(delta(angleOf(out), swimDeg)) - 90) < 1e-6,
    finite ? `${delta(angleOf(out), swimDeg).toFixed(3)} deg` : 'NaN');
}

// -------------------------------------------------------------------- inputs

section('INPUTS — magnitude, missing sticks, unit output');

// input.move keeps analog magnitude (input.js only clamps it to <= 1), aim is
// normalized. A halfway that leaned on magnitude would make a gently pushed
// stick steer less, which is not what a direction blend means.
{
  const full = strikeDirection({ x: 1, y: 0 }, dir(90));
  const half = strikeDirection({ x: 0.28, y: 0 }, dir(90));
  check('a half-pushed stick steers like a full one',
    close(angleOf(full), angleOf(half), 1e-9),
    `${angleOf(full).toFixed(3)} vs ${angleOf(half).toFixed(3)}`);
  check('and both land on 45', close(angleOf(full), 45, 1e-9));
}

{
  // Standstill: the whole heading is the aim, so a strike from rest still goes
  // at the cursor.
  const out = strikeDirection({ x: 0, y: 0 }, dir(123));
  check('no movement -> pure aim', close(angleOf(out), 123, 1e-9), `${angleOf(out).toFixed(3)}`);
}
{
  // No aim (never happens with a mouse, does happen before a pad's right stick
  // is touched): the swim owns it.
  const out = strikeDirection(dir(-66), { x: 0, y: 0 });
  check('no aim -> pure swim', close(angleOf(out), -66, 1e-9), `${angleOf(out).toFixed(3)}`);
}
{
  const out = strikeDirection({ x: 0, y: 0 }, { x: 0, y: 0 });
  check('both idle -> zero vector, so main.js does not fire',
    out.x === 0 && out.y === 0, JSON.stringify(out));
}
{
  const out = strikeDirection(null, undefined);
  check('missing inputs do not throw and return zero',
    out.x === 0 && out.y === 0, JSON.stringify(out));
}

// Everything that fires must be unit length: main.js multiplies this straight
// by dashSpeed, so a short vector is a slow dash and a long one overshoots.
{
  let worst = 0;
  for (let s = -180; s < 180; s += 7) {
    for (let a = -180; a < 180; a += 11) {
      const out = strikeDirection(dir(s), dir(a));
      worst = Math.max(worst, Math.abs(Math.hypot(out.x, out.y) - 1));
    }
  }
  check('unit length across the whole input sweep', worst < 1e-9, `worst error ${worst.toExponential(2)}`);
}

// The out param exists so the per-frame prediction allocates nothing.
{
  const target = { x: 9, y: 9 };
  const out = strikeDirection(dir(0), dir(90), target);
  check('writes into the supplied scratch object', out === target && close(angleOf(target), 45));
}

// The blend is a slider, so the ends have to mean what the label says.
section('BLEND — the slider ends');
const shipped = CONFIG.strike.aimBlend;
try {
  CONFIG.strike.aimBlend = 0;
  check('0 = straight along the swim', close(angleOf(strikeDirection(dir(20), dir(140))), 20));
  CONFIG.strike.aimBlend = 1;
  check('1 = straight at the aim', close(angleOf(strikeDirection(dir(20), dir(140))), 140));
  CONFIG.strike.aimBlend = 5; // a tuning file with nonsense in it
  check('out-of-range clamps instead of overshooting',
    close(angleOf(strikeDirection(dir(20), dir(140))), 140));
  CONFIG.strike.aimBlend = undefined; // a null in imported-tuning.json wins over the default
  check('a missing blend falls back to halfway',
    close(angleOf(strikeDirection(dir(20), dir(140))), 80));
} finally {
  CONFIG.strike.aimBlend = shipped;
}

// -------------------------------------------------------------------- wiring

section('WIRING — both call sites go through the one function');

const main = fs.readFileSync(MAIN, 'utf8');
check('main.js imports strikeDirection', /import \{[^}]*\bstrikeDirection\b[^}]*\} from '\.\/systems\/strike\.js'/.test(main));
check('the launch calls it', /const dir = strikeDirection\(input\.move, input\.aim\)/.test(main));
check('the lens prediction calls it', /dashDir: strikeDirection\(input\.move, input\.aim, dashPrediction\)/.test(main));
// The old rule, in either place, means one of the two is out of step again.
check('the movement-first fallback is gone',
  !/input\.move\.lengthSq\(\) > 0\.001 \? input\.move/.test(main));

// ----------------------------------------------------------------- appetite

section('APPETITE — each chain link costs more chum than the last');

const chumStats = { strikeChumRefill: CONFIG.strike.charge.chumRefill };

// Mouthfuls to take an empty bar to full at a given chain depth. The chain
// state is written directly rather than built up through chainStrike: the
// sources are individually rate-limited, so earning six real links here would
// be testing the throttles instead of the price.
function chumToFill(depth) {
  resetStrike();
  strikeState.charge = 0;
  strikeState.active = true; // a live combo, which is what gates the LINK
  strikeState.chainCount = depth;
  strikeState.chainTimer = depth > 0 ? CONFIG.strike.chainWindow : 0;

  let n = 0;
  while (strikeState.charge < 1 && n < 1000) { feedChum(chumStats); n++; }
  return n;
}

// The appetite is PIPS now, not a compounding discount — one chum is always
// exactly one pip, and a link adds a pip rather than shrinking the mouthful.
// The depth-by-depth arithmetic lives in npm run test:meter; what is checked
// here is the shape the rest of the game depends on.
const costs = [0, 1, 2, 3, 4, 5].map(chumToFill);
check(`the first link costs the base ${Math.round(1 / CONFIG.strike.charge.chumRefill)} chum`,
  costs[0] === Math.round(1 / CONFIG.strike.charge.chumRefill), `costs [${costs}]`);
check('no link is ever cheaper than the one before it',
  costs.every((c, i) => i === 0 || c >= costs[i - 1]), `costs [${costs}]`);
// The failure this is really guarding: an escalation so gentle that rounding
// eats it and the "ramp" is five identical numbers.
check('and it is a real ramp, not a rounding wobble',
  costs[3] > costs[0] && costs[5] > costs[3], `costs [${costs}]`);
// One pip per link, exactly — the ramp is now a straight line by construction,
// which is the readability the compounding version could not offer.
check('each link costs exactly one chum more than the last',
  costs.every((c, i) => i === 0 || c === costs[i - 1] + 1), `costs [${costs}]`);

// The cap doing what chainRefillFloor used to: without one a deep chain
// reaches a bar that cannot practically be filled and the combo dies to
// arithmetic rather than to anything the player did.
const cap = CONFIG.strike.charge.maxPips;
check('the cap stops a deep chain running away',
  chumToFill(60) === cap, `${chumToFill(60)} chum at depth 60, capped at ${cap}`);

// The counter is left standing until the window expires, so the price has to
// read the TIMER as well or the next combo opens paying the last one's bill.
resetStrike();
strikeState.chainCount = 6;
strikeState.chainTimer = 0;
check('an expired chain is back to base price', chumRefillMul() === 1);
resetStrike();

console.log(failures === 0 ? '\nAll strike checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
