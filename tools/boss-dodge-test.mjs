#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:dodge
//
// GETTING OUT OF THE WAY — systems/dodge.js, and the one reward in the game
// paid for something NOT happening.
//
// That is what makes it worth a harness of its own. Every other payout in this
// codebase is triggered by an event: a kill, a mouthful, a pickup, a breach.
// This one fires on the ABSENCE of an event, at the end of a window, and the
// whole family of failures it can have are silent ones — it pays for passes
// that were never aimed at you, it pays twice for one pass, it pays for a hit
// you took, or (the one nobody would ever notice) it quietly stops paying at
// all and a boss fight is exactly as it was before.
//
// None of it can be seen by playing. The browser preview suspends
// requestAnimationFrame, and even running, "did the bar move because I dodged
// or because I ate something" is not a question an eye can answer.
//
//   IT PAYS FOR A DODGE       a boss's committed run ending in water the seal
//                             is not in fills the boost meter.
//
//   ...AND ONLY FOR A DODGE   a run that connected pays nothing, whether or
//                             not the player took damage from it. Phasing
//                             through a boss on strike i-frames is a fine
//                             thing to do and is not a dodge.
//
//   IT MUST HAVE BEEN AIMED   a pass that ended half an arena away was watched,
//                             not dodged. `nearRadii`/`nearPad` is the gate,
//                             measured on the closest approach across the whole
//                             run rather than at its end.
//
//   ONE PASS PAYS ONCE        the cooldown, and the reason it exists: a boss
//                             wearing the lunge perk is committed through TWO
//                             mechanisms at the same time.
//
//   EVERY ARCHETYPE           the two flags between them cover all five ways a
//                             boss commits — the shared lunge's `strike` stage
//                             and the `ramming` flag the perk, the kraken and
//                             the anglerfish all set. This is the check that
//                             the coverage is real rather than assumed.
//
//   AND NOT THE WILDLIFE      six sharks carry the same lunge block. If they
//                             paid, the meter would never be empty.
//
//   node --import ./tools/vite-loader.mjs tools/boss-dodge-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { updateBounds, bounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { enemies, spawnNamed, resetEnemies } from '../path/src/entities/enemies.js';
import { strikeState, resetStrike } from '../path/src/systems/strike.js';
import { updateDodge, resetDodge, dodgeState } from '../path/src/systems/dodge.js';

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]')
    || msg.startsWith('[feedback]'))) return;
  realWarn(msg, ...rest);
};

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (t) => console.log(`        ${t}`);

updateBounds(16 / 9);
initPlayer(scene);

const D = CONFIG.boss.dodge;
const MID = (bounds.bottom + bounds.surfaceY) / 2;

/** Empty water, an empty bar, and the seal parked in the middle of it. */
function clean() {
  resetEnemies(scene);
  resetPlayer();
  resetStrike();
  resetDodge();
  strikeState.charge = 0;
  player.mesh.position.set(0, MID, 0);
}

/**
 * A boss in the water at (x, y), out of its arrival invulnerability.
 *
 * `isBoss` is written here because spawnNamed does not write it — systems/boss
 * .js does, one line after the spawn, and importing that file into a harness
 * drags in the music, the camera rig and four archetype drivers to set a
 * boolean. Standing in for that one line is fine; STANDING IN FOR IT SILENTLY
 * is not, so the section below asserts the game still sets it.
 *
 * AND THE MEASURED HITBOX IS DROPPED. Every boss declares `hitShape: 'bones'`,
 * and that shape is fitted to the vertices of a GLB — which no Node harness
 * loads. What survives is a live shape with a `bound` of zero, so hitCreature
 * returns false for a boss sitting exactly on top of the seal and "did the
 * pass connect" answers no for every pass ever made. Nulling it falls the test
 * back to the circle, which is the shape every creature without a model uses
 * and is the honest one to measure a stand-in against. See the note in
 * tools/hit-shape-test.mjs, which is where the fitting itself is checked.
 */
function boss(key = 'bossHammerhead', x = 0, y = MID) {
  const e = spawnNamed(scene, key, 0, { x, y }, { ignoreCaps: true, overfill: true });
  if (e) {
    e.invuln = 0;
    e.isBoss = true;
    e.hitShape = null;
    e.mesh.position.set(x, y, e.mesh.position.z);
  }
  return e;
}

/**
 * ONE COMMITTED RUN, driven by hand.
 *
 * The flags are written directly rather than steered into: what is under test
 * is the LEDGER — what the module makes of a run that began, went somewhere and
 * ended — and driving a real lunge would make every assertion here a hostage to
 * the shark's turn rate. lungeChase itself is covered by tools/sailfish-lunge
 * -test.mjs, which is where the stages belong.
 *
 * @param commit  a function writing the committed flag, so both mechanisms can
 *                be exercised through the same body
 * @param path    positions the boss passes through during the run
 */
function run(e, commit, release, path, frames = 6) {
  for (const at of path) {
    commit(e);
    e.mesh.position.set(at.x, at.y, e.mesh.position.z);
    for (let i = 0; i < frames; i++) updateDodge(dt, enemies);
  }
  release(e);
  updateDodge(dt, enemies);
}

const lungeIn = (e) => { e.lungeStage = 'strike'; };
const lungeOut = (e) => { e.lungeStage = 'rest'; };
const ramIn = (e) => { e.ramming = true; };
const ramOut = (e) => { e.ramming = false; };

// ---------------------------------------------------------------------------
section('IT PAYS FOR A DODGE');
// ---------------------------------------------------------------------------
{
  clean();
  const e = boss();
  check('a boss actually spawned and knows it is one', !!e && e.isBoss === true,
    e ? `${e.type}, radius ${e.radius.toFixed(2)}` : 'nothing spawned');

  const near = e.radius * D.nearRadii + D.nearPad;
  // A pass that comes right past the seal and ends beyond it — which is the
  // shape of every lunge in the game, since the strike stage exits on a clock
  // and carries its own overshoot.
  run(e, lungeIn, lungeOut, [
    { x: -near * 2.2, y: MID },
    { x: -near * 0.5, y: MID + 1.2 },
    { x: near * 2.2, y: MID },
  ]);
  check('a clean pass fills the boost meter', strikeState.charge >= D.refill - 1e-6,
    `charge ${strikeState.charge.toFixed(3)} after one dodge`);
  check('...and is counted as one dodge', dodgeState.dodges === 1, `${dodgeState.dodges}`);
  note(`the hammerhead's pass has to come inside ${near.toFixed(1)} units `
    + `(${D.nearRadii} x its ${e.radius.toFixed(2)} radius + ${D.nearPad}) to have been aimed at you`);
}

// ---------------------------------------------------------------------------
section('...AND ONLY FOR A DODGE');
// ---------------------------------------------------------------------------
{
  // THROUGH the seal rather than past it. No damage is dealt here at all —
  // resolveCombat is not running — which is the point: the test is the
  // OVERLAP, so a player phasing a boss on strike i-frames is not paid for it.
  clean();
  const e = boss();
  run(e, lungeIn, lungeOut, [
    { x: -20, y: MID },
    { x: 0, y: MID },       // dead on the seal
    { x: 20, y: MID },
  ]);
  check('a pass that connected pays nothing', strikeState.charge === 0,
    `charge ${strikeState.charge.toFixed(3)}`);
  check('...and is not counted', dodgeState.dodges === 0, `${dodgeState.dodges}`);

  // A run that never got near. The boss committed, ran its clock out and
  // finished; the player was elsewhere and did nothing.
  clean();
  const e2 = boss();
  const far = (e2.radius * D.nearRadii + D.nearPad) * 3;
  run(e2, lungeIn, lungeOut, [
    { x: far, y: MID + far },
    { x: far * 1.4, y: MID + far },
  ]);
  check('a pass that was never aimed at you pays nothing', strikeState.charge === 0,
    `closest approach about ${Math.hypot(far, far).toFixed(0)} units`);
}

// ---------------------------------------------------------------------------
section('ONE PASS PAYS ONCE');
// ---------------------------------------------------------------------------
// The cooldown, and the case it was written for: the lunge perk sets `ramming`
// on a boss that ALSO has a lunge block, so the same physical pass can begin
// and end under two different flags. Two payouts for one dodge is the bug.
{
  clean();
  const e = boss();
  const near = e.radius * D.nearRadii + D.nearPad;
  const past = [{ x: -near, y: MID }, { x: near, y: MID }];

  run(e, lungeIn, lungeOut, past);
  const first = strikeState.charge;
  strikeState.charge = 0;
  run(e, ramIn, ramOut, past);
  check('the same boss cannot pay twice inside the cooldown',
    first > 0 && strikeState.charge === 0,
    `first ${first.toFixed(2)}, second ${strikeState.charge.toFixed(3)} (cooldown ${D.cooldown}s)`);

  // ...and it does reopen. A cooldown that never expired would be one payout
  // per boss per fight, which is a different (and much quieter) bug.
  for (let i = 0; i < Math.ceil(D.cooldown / dt) + 2; i++) updateDodge(dt, enemies);
  run(e, lungeIn, lungeOut, past);
  check('...but it reopens afterwards', strikeState.charge > 0,
    `charge ${strikeState.charge.toFixed(2)} on the next pass`);
}

// ---------------------------------------------------------------------------
section('EVERY WAY A BOSS COMMITS');
// ---------------------------------------------------------------------------
// Five systems commit a boss to a run — lungeChase (the four chasing
// archetypes), the lunge perk, the kraken's crush and the anglerfish's strike
// — through exactly two flags. Both are exercised here on a real body, because
// "it reads e.ramming" is a claim about a field name and this is a claim about
// the mechanism.
{
  for (const [label, commit, release] of [
    ['the shared lunge\'s strike stage', lungeIn, lungeOut],
    ['the `ramming` flag (perk, kraken, anglerfish)', ramIn, ramOut],
  ]) {
    clean();
    const e = boss();
    const near = e.radius * D.nearRadii + D.nearPad;
    run(e, commit, release, [{ x: -near, y: MID }, { x: near, y: MID }]);
    check(`${label} pays`, strikeState.charge > 0, `charge ${strikeState.charge.toFixed(2)}`);
  }

  // AND THE FLAGS ARE STILL THE ONES THE GAME SETS. If `ramming` were renamed
  // or the lunge's committed stage relabelled, every check above would keep
  // passing on a field this harness invented and the feature would be dead.
  const src = [
    'path/src/systems/bossPerks.js', 'path/src/systems/kraken.js', 'path/src/systems/bossAngler.js',
  ];
  const fs = await import('node:fs');
  const setters = src.filter((f) => /\be\.ramming\s*=\s*true/.test(fs.readFileSync(f, 'utf8')));
  check('the three systems that ram still set the flag this reads',
    setters.length === src.length, `${setters.length} of ${src.length}: ${setters.join(', ')}`);
  const lunge = fs.readFileSync('path/src/entities/enemies.js', 'utf8');
  check('...and the lunge\'s committed stage is still called `strike`',
    /e\.lungeStage\s*===\s*'strike'/.test(lunge) && /e\.lungeStage\s*=\s*'strike'/.test(lunge));
  // ...and the flag the whole gate hangs on. `boss()` above writes it by hand,
  // which is exactly why this has to be checked against the source: a rename
  // in systems/boss.js would leave every check in this file green and the
  // reward unreachable in the actual game.
  const bossSrc = fs.readFileSync('path/src/systems/boss.js', 'utf8');
  check('...and systems/boss.js still marks its body `isBoss`',
    /e\.isBoss\s*=\s*true/.test(bossSrc));
}

// ---------------------------------------------------------------------------
section('THE WILDLIFE DOES NOT PAY');
// ---------------------------------------------------------------------------
// The six apex sharks carry the same `lunge` block the bosses do (see
// `shark.lunge` in the roster) and make passes constantly. If they paid, the
// bar would never be empty and the boss reward would mean nothing.
{
  clean();
  const wild = spawnNamed(scene, 'hammerhead', 0, { x: -8, y: MID }, { ignoreCaps: true });
  wild.invuln = 0;
  check('the wildlife hammerhead is not flagged a boss', wild.isBoss !== true, `${wild.isBoss}`);
  run(wild, lungeIn, lungeOut, [{ x: -6, y: MID }, { x: 6, y: MID }]);
  check('a wild shark\'s dodged pass pays nothing', strikeState.charge === 0,
    `charge ${strikeState.charge.toFixed(3)}`);

  // How many of them are out there, for scale.
  const lungers = Object.entries(CONFIG.enemies)
    .filter(([, d]) => d?.lunge && !String(d.group ?? '').includes('boss'))
    .length;
  note(`${lungers} rows in the roster carry a lunge block; the gate is e.isBoss, not the block`);
}

// ---------------------------------------------------------------------------
section('A NEW RUN STARTS EVEN');
// ---------------------------------------------------------------------------
{
  clean();
  const e = boss();
  const near = e.radius * D.nearRadii + D.nearPad;
  run(e, lungeIn, lungeOut, [{ x: -near, y: MID }, { x: near, y: MID }]);
  const had = dodgeState.dodges;
  resetDodge();
  check('the last run\'s dodges do not carry over', had > 0 && dodgeState.dodges === 0,
    `${had} -> ${dodgeState.dodges}`);

  // A boss that was mid-lunge when the run ended must not pay the new run's
  // first frame for a pass nobody was there for. The WeakMap is keyed on the
  // body, and the body is gone.
  clean();
  const e2 = boss();
  lungeIn(e2);
  updateDodge(dt, enemies);
  resetEnemies(scene);
  strikeState.charge = 0;
  for (let i = 0; i < 10; i++) updateDodge(dt, enemies);
  check('a boss removed mid-lunge pays nothing on the way out', strikeState.charge === 0,
    `charge ${strikeState.charge.toFixed(3)}`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
