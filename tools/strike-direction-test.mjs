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
//   STICK WINS that a pushed stick IS the heading whatever the aim says, for
//              spreads all the way out to 180 degrees — including exactly
//              opposed, which is ordinary play (you swim away from the thing
//              you're shooting) and the case a vector sum returns NaN on.
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

import './dom-stub.mjs';
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { strikeDirection, strikeState, resetStrike, feedChum, chumRefillMul, pipCount, spawnShrapnel } from '../path/src/systems/strike.js';
import { enemies, spawnNamed, resetEnemies } from '../path/src/entities/enemies.js';
import { projectiles, resetProjectiles, updateProjectiles } from '../path/src/entities/projectiles.js';
import { resolveCombat } from '../path/src/systems/combat.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';

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

// The rule the game ships with: the stick wins when it is pushed, the aim
// decides otherwise. There is no blend to read off a tuning file any more.
section('CONFIG — no blend');
check('strike.aimBlend is gone', !('aimBlend' in CONFIG.strike),
  `got ${CONFIG.strike.aimBlend}`);

// --------------------------------------------------------------- stick wins

section('STICK WINS — a pushed stick is the heading, whatever the aim says');

// Spreads from a nudge to fully opposed, in both rotational directions, from a
// swim heading that isn't axis-aligned so a lucky symmetry can't carry it.
for (const swimDeg of [0, 37, 90, 175, -120]) {
  for (const spread of [10, 45, 90, 135, 179, 180]) {
    for (const sign of [1, -1]) {
      const aimDeg = swimDeg + sign * spread;
      const out = strikeDirection(dir(swimDeg), dir(aimDeg));
      check(`swim ${swimDeg}, aim ${aimDeg} -> ${swimDeg}`,
        close(angleOf(out), swimDeg, 1e-6), `got ${angleOf(out).toFixed(3)}`);
    }
  }
}

// -------------------------------------------------------------------- inputs

section('INPUTS — magnitude, missing sticks, unit output');

// input.move keeps analog magnitude (input.js only clamps it to <= 1), aim is
// normalized. The magnitude is the throttle, not a vote: a gently pushed
// stick launches exactly where a full one does.
{
  const full = strikeDirection({ x: 1, y: 0 }, dir(90));
  const half = strikeDirection({ x: 0.28, y: 0 }, dir(90));
  check('a half-pushed stick launches like a full one',
    close(angleOf(full), angleOf(half), 1e-9),
    `${angleOf(full).toFixed(3)} vs ${angleOf(half).toFixed(3)}`);
  check('and both land on the stick, 0', close(angleOf(full), 0, 1e-9));
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
  check('writes into the supplied scratch object', out === target && close(angleOf(target), 0));
}

// The blend used to be a slider. A tuning file that still carries it must not
// bring it back: nothing reads the key.
section('BLEND — gone, and a stale tuning value cannot revive it');
{
  CONFIG.strike.aimBlend = 0.5;
  try {
    check('aimBlend 0.5 in the tuning changes nothing',
      close(angleOf(strikeDirection(dir(20), dir(140))), 20));
  } finally {
    delete CONFIG.strike.aimBlend;
  }
  check('no slider for it', !/strike\.aimBlend/.test(fs.readFileSync(path.join(HERE, '../path/src/config.js'), 'utf8').replace(/\/\/[^\n]*/g, '')));
}

// -------------------------------------------------------------------- wiring

section('WIRING — both call sites go through the one function');

const main = fs.readFileSync(MAIN, 'utf8');
check('main.js imports strikeDirection', /import \{[^}]*\bstrikeDirection\b[^}]*\} from '\.\/systems\/strike\.js'/.test(main));
check('the launch calls it', /const dir = strikeDirection\(input\.move, input\.aim\)/.test(main));
// The prediction flies the whole dash (predictDash) — and predictDash launches
// through strikeDirection, so the corridor still starts on the same rule.
check('the lens prediction flies the dash', /dashDir: predictDash\(input\.move, input\.aim, strikeState\.pending, player\.stats, player\.comboSpeedMul, dashPrediction\)\.dir/.test(main));
{
  const strikeSrc = fs.readFileSync(path.join(HERE, '../path/src/systems/strike.js'), 'utf8');
  const forecast = strikeSrc.slice(strikeSrc.indexOf('export function predictDash('));
  check('...and the forecast launches through strikeDirection', /const launch = strikeDirection\(move, aim, out\.dir\)/.test(forecast));
}
// The old rule, in either place, means one of the two is out of step again.
check('the movement-first fallback is gone',
  !/input\.move\.lengthSq\(\) > 0\.001 \? input\.move/.test(main));

// ----------------------------------------------------------------- appetite

section('APPETITE — one chum is one pip, at every depth, always');

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

// ONE CHUM IS ONE PIP, AT EVERY DEPTH, ALWAYS. The bar used to grow a pip per
// link as a cost escalation; both the job and the field are gone — a link is a
// single mouthful now and is not bought with the bar at all. It also could not
// have survived per-pip links: the count would have been a function of how
// much had been eaten while eating was the thing filling it, so a six-pip bar
// silently took seven chum. See pipCount in systems/strike.js.
//
// The depth-by-depth arithmetic lives in npm run test:meter; what is checked
// here is the shape the rest of the game depends on — a fill cost that nothing
// in a run can move.
const base = Math.round(1 / CONFIG.strike.charge.chumRefill);
const costs = [0, 1, 2, 3, 4, 5].map(chumToFill);
check(`a bar costs the base ${base} chum`, costs[0] === base, `costs [${costs}]`);
check('and every chain depth costs exactly the same',
  costs.every((c) => c === base), `costs [${costs}]`);
// The one that would actually have bitten: a chain deep enough to have hit the
// old ceiling still fills in a base bar.
check('even a chain sixty deep', chumToFill(60) === base,
  `${chumToFill(60)} chum at depth 60`);
// The cap still binds a count DERIVED from an extreme refill, which is the job
// it has left — a card stack could reach past what the ring can draw legibly.
check('the pip ceiling still binds a derived count',
  pipCount({ strikeChumRefill: 0.001 }) === CONFIG.strike.charge.maxPips);

resetStrike();
check('and one chum is worth one pip whatever the chain is doing', chumRefillMul() === 1);
resetStrike();

// ---------------------------------------------------------------------------
section('THE BONE ZONE — a fragment has to survive the body it came out of');
// ---------------------------------------------------------------------------
//
// THE BUG THIS EXISTS FOR IS AN INVISIBLE ONE, twice over.
//
// The burst spawns at the point the dash connected, which is ON the rammed
// animal, and a fragment carries `pierce: 0` — so the combat pass later in the
// SAME FRAME found that body, spent the fragment on it and despawned it before
// anything was ever drawn. Measured before the fix: five of five fragments
// gone on frame one, 0.37 units from the burst, against a minnow and against a
// megalodon alike. That is a fifth of the bone's own length, out of a 0.55s
// fuse and twelve units of flight.
//
// Nothing failed. The card still paid out — into the creature it burst from,
// which is the one body the ram had already committed to — so the ledger saw
// damage and the player saw nothing at all. A card called The Bone Zone had
// never once put a bone on screen.
//
// THE ASSERTION IS FLIGHT TIME, NOT A FLAG. Checking that `ignore` is set
// would pass on the day it is written and keep passing when the burst is moved
// or the hit test is retuned; the thing that matters is that the bones are in
// the water long enough to be seen, and the only way to know that is to fly
// them through the real hit shapes. This is also why the burst lives in
// strike.js and is imported here rather than retyped — a harness that rebuilds
// the spawn call is a harness that passes while the game drops an argument,
// which is exactly the failure being fixed.
{
  const scene = new THREE.Scene();
  initPlayer(scene);
  resetPlayer();
  const hooks = new Proxy({}, { get: () => () => {} });
  const dt = 1 / 60;
  const c = CONFIG.strike.shrapnel;

  // A lone body, so the only thing a fragment can possibly hit is its source.
  // The seal is parked far away for the same reason.
  const flight = (species) => {
    resetEnemies(scene);
    resetProjectiles(scene);
    player.mesh.position.set(-400, -400, 0);
    const e = spawnNamed(scene, species, 0, 0);
    e.hp = 1e7;
    e.invuln = 0;
    const at = { x: e.mesh.position.x, y: e.mesh.position.y };
    const born = spawnShrapnel(scene, at, 100, e, { shrapnelCount: 1 });
    let frames = 0;
    while (projectiles.length && frames < 400) {
      frames++;
      updateProjectiles(dt, scene, () => {}, hooks);
      resolveCombat(dt, scene, hooks);
    }
    return { born, frames, alive: projectiles.length };
  };

  const fuseFrames = Math.floor(c.life * 60);
  for (const species of ['fish', 'shark', 'megalodon']) {
    const r = flight(species);
    check(`a burst off a ${species} is still in the water a frame later`,
      r.frames > 1, `${r.born} fragments, all gone after ${r.frames} frame(s)`);
    // The real bar: a fragment that clears the body should burn its whole fuse,
    // because there is nothing else in the water to stop it.
    check(`...and flies its full ${(c.life * 1000).toFixed(0)}ms fuse off a ${species}`,
      r.frames >= fuseFrames, `${r.frames} frames against a ${fuseFrames}-frame fuse`);
  }

  // The level gate, which is the one branch above that has nothing to do with
  // flight: no stack, no burst. Checked here because `stats` moved from a
  // module-level `player` to an argument when the burst did.
  resetEnemies(scene);
  resetProjectiles(scene);
  check('and no stack bursts nothing at all',
    spawnShrapnel(scene, { x: 0, y: 0 }, 100, null, { shrapnelCount: 0 }) === 0
      && projectiles.length === 0);
  resetProjectiles(scene);
  resetEnemies(scene);
}

console.log(failures === 0 ? '\nAll strike checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
