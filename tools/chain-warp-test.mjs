#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:warp
//
// WHAT A FOOD-CHAIN LINK DOES TO THE BACKDROP, AT EVERY DEPTH THE GAME REACHES.
//
// The grid ripple is the one chain effect with no natural ceiling on it: the
// banner is text, the camera punch clamps inside world.js, and the two feedback
// ripples carry fixed radii. This one was `8 + chain * 2` with no cap, and the
// run logs have a 313-link chain in them — a ripple 634 units across an arena
// 80 units wide, which is every vertex in the field inside one ripple.
//
// So the assertion is not "the number is smaller now", it is that the effect
// stays LOCAL at any depth, including depths nobody has reached yet.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';

// The same curve main.js uses. Duplicated deliberately and checked against the
// shipped values below — this file exists to police that call site, and
// importing main.js to get at it would boot the whole game.
const softCap = (v, cap) => (cap > 0 ? cap * (1 - Math.exp(-Math.max(0, v) / cap)) : 0);

const g = CONFIG.strike;
const warpOf = (chain) => softCap(chain * g.comboGridWarp, g.comboGridWarpMax);
const radiusOf = (chain) => g.comboGridRadiusBase
  + softCap(chain * g.comboGridRadius, Math.max(0, g.comboGridRadiusMax - g.comboGridRadiusBase));

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

console.log(`\narena ${bounds.width} units wide, cap ${g.comboGridRadiusMax}\n`);
console.log('chain   strength   radius   % of arena');
// 313 is the deepest chain in playtest/runs.jsonl; 5000 is there because a cap
// that only holds for depths someone has already reached is not a cap.
for (const c of [1, 2, 3, 5, 10, 20, 40, 80, 160, 313, 1000, 5000]) {
  const r = radiusOf(c);
  console.log(
    String(c).padStart(5),
    warpOf(c).toFixed(2).padStart(10),
    r.toFixed(2).padStart(8),
    `${((r / bounds.width) * 100).toFixed(0)}%`.padStart(12),
  );
}
console.log('');

check('the ripple never spans the arena, at any depth',
  radiusOf(1e6) < bounds.width / 2,
  `${radiusOf(1e6).toFixed(1)} vs a ${bounds.width / 2} half-width`);
check('...including the deepest chain actually recorded',
  radiusOf(313) < bounds.width / 2, `chain 313 -> ${radiusOf(313).toFixed(1)}`);
// THE SHALLOW END MUST NOT HAVE BEEN QUIETLY NERFED. The old curve was linear
// and everything was tuned against it there, so the first few links have to
// come out essentially where they were.
check('a first link is within 10% of what it always was',
  Math.abs(radiusOf(1) - (8 + 1 * 2)) / (8 + 2) < 0.1,
  `${radiusOf(1).toFixed(2)} vs the old ${8 + 2}`);
check('...and its strength too',
  Math.abs(warpOf(1) - 1 * g.comboGridWarp) / (g.comboGridWarp) < 0.2,
  `${warpOf(1).toFixed(2)} vs the old ${(1 * g.comboGridWarp).toFixed(2)}`);
// THE DEPTHS THAT MATTER STAY DISTINGUISHABLE, which is the whole reason this
// is a feather and not a clamp — under Math.min every chain past 5 shoved the
// grid identically. Asserted over the range players actually live in: an
// exponential saturates to the last representable double eventually, and a
// check demanding strict growth at chain 313 would be asserting arithmetic
// rather than design.
check('every link up to chain 40 is a bigger shove than the one before',
  [...Array(40).keys()].every((i) => radiusOf(i + 2) > radiusOf(i + 1)
    && warpOf(i + 2) > warpOf(i + 1)),
  `chain 1 -> ${radiusOf(1).toFixed(2)}, chain 40 -> ${radiusOf(40).toFixed(2)}`);
check('...where the clamp this replaced flatlined at chain 5',
  Math.min(g.comboGridWarpMax, 20 * g.comboGridWarp) === Math.min(g.comboGridWarpMax, 40 * g.comboGridWarp),
  'old: chain 20 and chain 40 were the same number');
// IT STAYS A LOCAL EFFECT — measured against the ARENA, which is the thing
// that actually matters and the only one in reach that does not move.
//
// This check used to compare the cap against CONFIG.feedback.foodChain's own
// ripple radius, and that was the wrong anchor twice over: it is a tuned value,
// so the assertion was validating one machine's tuner session rather than the
// design, and it duly broke when that radius was retuned from 14 to 3 by work
// that had nothing to do with the grid. A guard on a runaway has to be pinned
// to something the runaway is measured against.
check('the shove stays local rather than arena-scale',
  radiusOf(1e6) <= bounds.width * 0.3,
  `cap ${g.comboGridRadiusMax} is ${((radiusOf(1e6) / bounds.width) * 100).toFixed(0)}% of the arena`);

console.log(fails ? `\n${fails} FAILED\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
