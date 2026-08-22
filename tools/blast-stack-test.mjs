#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:blasts
//
// FOUR PAYLOADS THAT ARE ONLY VISIBLE AS NUMBERS, and every one of them can be
// broken without anything throwing, without a frame looking wrong, and without
// any other harness noticing.
//
//   1. THE MUSSEL'S BLAST. A barrage shell detonates now. `splashDamage` and
//      `splashRadius` are two fields on a spawnProjectile call — drop either
//      and the shells still fly, still home, still hit, and the whole payload
//      is silently gone. Nothing renders differently; the barrage just stops
//      being worth its charge.
//   2. THE SEAGULL'S. Same shape, and worse: the gull's numbers live in
//      weapons.csv, so a typo there is skipped with a warning nobody reads and
//      the config default stands. This asserts the LIVE values, after the
//      table has been applied, which is the only reading that means anything.
//   3. BAKALAR'S ARENA SPRAY. The bomb pays the whole catch out as chum, and
//      the new half of that payout is flung across the arena rather than at
//      the blast. It is a count and a loop; a zero is indistinguishable from
//      the feature not existing.
//   4. THE COMPANIONS' SHARE OF A PERFECT STRIKE. The one with a real trap in
//      it: the bonus is a SUM over bodies, so a late run with a maxed pod and
//      six escorts sums to several hundred against a strike worth sixty, and
//      an uncapped bonus stops being a bonus and becomes the weapon. The cap
//      is stated as a multiple of the strike (`maxMul`) rather than as a flat
//      number, and this asserts BOTH that it binds and that it would have been
//      blown through without it — a cap nobody can reach is not a cap, it is a
//      comment. See the note in memory about asserting the multiplier rather
//      than "more".
//
// No renderer and no models: every number here is a pure function of CONFIG and
// a stat block, which is exactly why they are testable at all.
//
//   node --import ./tools/vite-loader.mjs tools/blast-stack-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { projectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import { fireMusselBarrage, updateMusselVolley, pendingShells, resetMusselVolley } from '../path/src/systems/musselVolley.js';
import { createBakalarBoat, updateBakalar, resetBakalar } from '../path/src/systems/bakalar.js';
import { player } from '../path/src/entities/player.js';
import { barrageDamage, barrageSplash } from '../path/src/systems/musselVolley.js';
import {
  companionStrikeParts, companionStrikeBonus, companionStrikeCount,
} from '../path/src/systems/companionStrike.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// --------------------------------------------------------------- the mussel

section('THE MUSSEL BARRAGE — every shell goes off');
{
  const one = barrageSplash(1);
  const five = barrageSplash(5);
  check('a shell has a blast at all', one.damage > 0 && one.radius > 0,
    `${one.damage} in ${one.radius}u`);
  // The blast is the point of the weapon, not a garnish on the direct hit: a
  // homing shell nearly always finds a body, so the direct damage is the
  // reliable half and the blast is what makes a barrage worth a full charge.
  check('...worth more than the direct hit it rides on', one.damage > barrageDamage(1),
    `${one.damage} splash vs ${barrageDamage(1)} direct`);
  check('...and it grows with the card', five.damage > one.damage,
    `${one.damage} -> ${five.damage} at five stacks`);
  // Splash Zone widens blasts and never makes them hit harder — the one rule
  // aoe() has always carried, and barrageSplash is the newest place in the game
  // that had to choose. Driven through the real stat block rather than asserted
  // off the config, because the mistake this guards against is calling aoe() on
  // the wrong one of the two.
  player.stats = { aoeMul: 2, abilityDamageMul: 1 };
  const wide = barrageSplash(1);
  player.stats = { aoeMul: 1, abilityDamageMul: 1 };
  const plain = barrageSplash(1);
  check('Splash Zone widens the blast', Math.abs(wide.radius - plain.radius * 2) < 1e-6,
    `${plain.radius}u -> ${wide.radius}u at aoeMul 2`);
  check('...and does not make it hit harder', wide.damage === plain.damage,
    `${plain.damage} either way`);
}

// -------------------------------------------------------------- the seagull

section('THE SEAGULL BOMB — the run is the blast');
{
  const c = CONFIG.seagullBomb;
  // Read LIVE, after weapons.csv has been applied over the config default: a
  // row that fails to resolve is skipped with a warning, and the only way to
  // find out is to ask the value the game will actually use.
  check('the splash is a blast rather than a chip', c.splashDamage >= 90,
    `${c.splashDamage} to everything nearby`);
  // The whole approach — crossing the sky, picking the densest knot, committing
  // to a stoop — is a promise about a PILE. A blast narrower than the pile it
  // chose breaks that promise in the one frame the player was waiting for.
  check('...over the whole pile it dived on', c.splashRadius > c.clusterRadius,
    `${c.splashRadius}u blast vs a ${c.clusterRadius}u cluster`);
  check('...without swallowing the arena', c.splashRadius < 20, `${c.splashRadius}u`);
}

// ------------------------------------------------------------- the trawler

section("BAKALAR'S BOMB — the catch is flung across the arena");
{
  const b = CONFIG.bakalar.bomb;
  check('there is an arena-wide payout at all', b.arenaChum > 0,
    `${b.arenaChum} bits on every blast`);
  check('...that grows with the catch', b.arenaChumPerKill > 0,
    `+${b.arenaChumPerKill} per fish finished`);
  // The point of the wide spray is that it pays somewhere you are NOT — chum by
  // the blast is chum you were already swimming toward. If the local scatter
  // were the bigger of the two, the feature would be doing nothing the old one
  // did not already do.
  check('...and it is the bigger half of the payout', b.arenaChum > b.chumScatter,
    `${b.arenaChum} arena-wide vs ${b.chumScatter} at the blast`);
}

// ------------------------------------------------- the shells in the water

// The two above are the NUMBERS. This is the wiring: a blast that is computed
// correctly and then not attached to the projectile is exactly as dead as one
// that was never computed, and neither the config nor barrageSplash() can see
// the difference. Fire a real barrage and read what came out.
section('THE WIRING — a shell carries its blast into the water');
{
  const scene = new THREE.Scene();
  resetProjectiles(scene);
  resetMusselVolley();
  player.stats = { aoeMul: 1, abilityDamageMul: 1, projectileBonus: 0 };
  const origin = new THREE.Vector3(0, -5, 0);
  const fired = fireMusselBarrage(scene, 1, 1, { x: 1, y: 0 }, () => origin, {});
  check('the barrage fired at a full charge', fired > 0, `${fired} shell(s)`);
  // Drained, because the flight is STAGGERED: only the first shell leaves on
  // the release frame, and checking the water right then would inspect one
  // shell and certify thirteen.
  for (let i = 0; i < 600 && pendingShells() > 0; i++) updateMusselVolley(1 / 60);
  const shells = projectiles.filter((p) => p.source === 'musselVolley');
  check('...and every one of them left', shells.length === fired,
    `${shells.length} of ${fired} in the water`);
  const armed = shells.filter((p) => p.splashDamage > 0 && p.splashRadius > 0);
  check('every shell is carrying a blast', armed.length === shells.length,
    `${armed.length} of ${shells.length}`);
  check('...and its own bang rather than the death event',
    shells.every((p) => p.splashFx === 'musselBlast'),
    shells[0]?.splashFx ?? 'none');
  resetProjectiles(scene);
  resetMusselVolley();
}

// ------------------------------------------------- the trawler, in the water

section("BAKALAR'S BOMB — the spray reaches the far wall");
{
  const scene = new THREE.Scene();
  player.stats = { aoeMul: 1, abilityDamageMul: 1, companionDamageMul: 1 };
  createBakalarBoat(scene);
  resetBakalar(scene);

  // One fish in the net, so a bomb is worth dropping (`minCatch`), then the
  // boat is run until a bomb has fallen, armed, burned its fuse and gone off.
  // The chum is collected by where it LANDED, which is the only reading that
  // can tell the wide spray from the blast's own.
  const mesh = new THREE.Object3D();
  mesh.position.set(0, -3, 0);
  const fish = { mesh, radius: 0.5, hp: 1e6, vx: 0, vy: 0, flash: 0, trapTimer: 0,
    hitThisFrame: false, def: { radius: 0.5 } };
  const enemies = [fish];
  const chum = [];
  const dt = 1 / 60;
  let blasts = 0;
  for (let i = 0; i < 60 * 40 && blasts === 0; i++) {
    // Parked under the boat's track, and re-parked every frame: the net hauls
    // whatever it catches toward the hull, and a fish that reached it is gone.
    mesh.position.set(0, -3, 0);
    updateBakalar(dt, scene, 1, enemies, {
      onChum: (x, y) => chum.push({ x, y }),
      onBombBlast: () => { blasts++; },
    });
  }
  check('a bomb went off at all', blasts > 0, `${blasts} blast(s)`);
  check('...and paid out chum', chum.length > 0, `${chum.length} bits`);

  const b = CONFIG.bakalar.bomb;
  const far = chum.filter((p) => Math.hypot(p.x, p.y + 3) > b.chumSpread * 1.5);
  check('most of it lands well outside the blast', far.length >= b.arenaChum * 0.5,
    `${far.length} of ${chum.length} bits beyond ${(b.chumSpread * 1.5).toFixed(1)}u`);
  const inside = chum.every((p) => p.x >= bounds.left && p.x <= bounds.right
    && p.y >= bounds.bottom && p.y <= bounds.surfaceY);
  // Placed with the arena's own bounds rather than by flinging further from the
  // blast, because "further" from a bomb dropped at a wall is mostly offscreen.
  check('...and every bit of it is somewhere reachable', inside,
    `x ${bounds.left}..${bounds.right}, y ${bounds.bottom}..${bounds.surfaceY}`);
  const spread = Math.max(...chum.map((p) => p.x)) - Math.min(...chum.map((p) => p.x));
  check('the spray crosses a real part of the arena',
    spread > (bounds.right - bounds.left) * 0.4,
    `${spread.toFixed(0)}u of ${(bounds.right - bounds.left).toFixed(0)}u wide`);
  resetBakalar(scene);
}

// ----------------------------------------------------------- the entourage

section('A PERFECT STRIKE — the companions hit with you');
{
  const STRIKE = 60; // a representative release burst, for the ceiling

  check('a run with no companions is untouched',
    companionStrikeBonus({ strikeDamage: STRIKE }, true, STRIKE) === 0);

  const squad = { sealTeamLevel: 1, orcaLevel: 1, harpLevel: 1, bakalarLevel: 1 };
  const parts = companionStrikeParts(squad);
  check('every companion that has a hit lends it', parts.length === 4,
    parts.map((p) => `${p.id} x${p.count} @${p.damage.toFixed(0)}`).join(', '));
  // BODIES, NOT CARDS. Three orcas and one escort is four animals hitting with
  // you, and four is the number the moment is about — a count of the picks
  // would say two.
  check('...counted as bodies rather than as picks', companionStrikeCount(squad) === 6,
    `${companionStrikeCount(squad)} bodies from 4 cards`);

  // THE CONTROL COMPANIONS LEND NOTHING, and that is the honest answer rather
  // than an oversight: the beluga traps, the dumbo charms, the grabber holds,
  // and none of the three deals a point of damage.
  const control = { belugaLevel: 6, dumboLevel: 6, octoGrabLevel: 6 };
  check('a run of pure control companions lends nothing',
    companionStrikeBonus(control, true, STRIKE) === 0, 'beluga + dumbo + grabber');

  check('an imperfect release lends nothing',
    companionStrikeBonus(squad, false, STRIKE) === 0);
  const lent = companionStrikeBonus(squad, true, STRIKE);
  check('a perfect release lends real damage', lent > 0,
    `+${lent.toFixed(1)} on a ${STRIKE}-damage strike`);

  // THE CEILING, asserted from both sides. That it binds is half the check;
  // that the uncapped sum would have gone straight through it is the other
  // half, and without that second reading a cap set far too high passes.
  const maxed = {
    sealTeamLevel: 6, orcaLevel: 6, harpLevel: 8, bakalarLevel: 8, orbiterBonus: 3,
  };
  const cap = STRIKE * CONFIG.strike.companionStack.maxMul;
  const raw = companionStrikeParts(maxed).reduce((a, p) => a + p.count * p.damage, 0)
    * CONFIG.strike.companionStack.share;
  const capped = companionStrikeBonus(maxed, true, STRIKE);
  check('a maxed companion build is capped', capped <= cap + 1e-6,
    `${capped.toFixed(0)} against a cap of ${cap.toFixed(0)}`);
  check('...and would have blown through it uncapped', raw > cap,
    `${raw.toFixed(0)} uncapped, ${(raw / STRIKE).toFixed(1)}x the strike itself`);
  check('the bonus rises with the build before the cap binds',
    companionStrikeBonus({ sealTeamLevel: 1 }, true, STRIKE)
      < companionStrikeBonus({ sealTeamLevel: 4 }, true, STRIKE),
    'one escort vs four');

  // The switch. A feature this large has to be removable from the CSV without
  // an edit to code — see strike.companionStack.enabled in weapons.csv.
  const saved = CONFIG.strike.companionStack.enabled;
  CONFIG.strike.companionStack.enabled = false;
  check('the CSV switch turns the whole thing off',
    companionStrikeBonus(squad, true, STRIKE) === 0);
  CONFIG.strike.companionStack.enabled = saved;
}

console.log(failures ? `\n${failures} FAILED` : '\nPASS — 0 failure(s)');
process.exit(failures ? 1 : 0);
