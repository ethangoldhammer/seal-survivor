#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:flippers
//
// FLIPPERS UP! — the one card in the game whose effect is asymmetric, and
// therefore the one card where "it works" is not the same question as "it works
// on the right side".
//
// WHAT THIS COVERS THAT test:upgrades CANNOT. That harness replays every
// apply() against a SYNTHETIC block with every stat seeded at 100, which is
// what makes its snapshot independent of imported-tuning.json. It also makes
// `flippersUpStacks` start at 100, so `n >= flipperElementStack` is true on the
// very first stack and the size-only branch — the first two picks, the whole
// early read of the card — is never executed there. Everything below runs
// against the REAL baseStats() through computeStats, which is the only place
// that branch exists.
//
// AND THE SIDE IS CHECKED FROM BOTH ENDS. The fin a stack GROWS is decided by
// apply() in config.js; the fin its rolled ELEMENT lands on is decided by
// finElementsIn() in flipperSide.js. Two files, one rule, and a build where the
// size went left while the element went right would look completely correct
// from inside either one of them.
//
//   node --import ./tools/vite-loader.mjs tools/flippers-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';
import { computeStats } from '../path/src/entities/player.js';
import {
  FLIPPER_SIDES, flipperSideForStack, finElementsIn, otherSide,
} from '../path/src/flipperSide.js';
import { finTable } from '../path/src/systems/playtestAnalysis.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const card = CONFIG.upgrades.find((u) => u.id === 'flippersUp');
const CAP = card?.maxStacks ?? 0;
const ELEMENT_AT = CONFIG.weapon.flipperElementStack;
const stats = (n) => computeStats(Array.from({ length: n }, () => ({ id: 'flippersUp', rarity: null })), 1, 0, 0);
const radius = (s, side) => s[`${side}FinRadiusMul`];
const elLevel = (s, side) => s[`${side}FinElementLevel`];

console.log('\n' + '─'.repeat(72));
console.log(`FLIPPERS UP! — ${CAP} stacks, element from stack ${ELEMENT_AT}`);
console.log('─'.repeat(72));

// ---------------------------------------------------------------------------
section('the side is one rule, read from both ends');

// The load-bearing fact main.js relies on when it turns an emit-point INDEX
// into a side: origin 0 is the left flipper because the seal's fin defs are
// declared in that order. Nothing else ties the two together, and reversing the
// asset would silently mirror the whole card.
const sealFins = ASSETS?.ship?.aimRig?.fins?.map((f) => f.name) ?? [];
check('the seal\'s fins are declared in FLIPPER_SIDES order',
  sealFins.length === FLIPPER_SIDES.length && sealFins.every((n, i) => n === FLIPPER_SIDES[i]),
  `assets.js [${sealFins}] vs [${FLIPPER_SIDES}]`);

// apply() picks its fin off the counter's parity; flipperSideForStack is that
// parity written down. This is the check that keeps them from drifting.
let sideOk = true;
let sideDetail = '';
for (let n = 1; n <= CAP; n++) {
  const before = stats(n - 1);
  const after = stats(n);
  const grew = FLIPPER_SIDES.filter((side) => radius(after, side) > radius(before, side));
  if (grew.length !== 1 || grew[0] !== flipperSideForStack(n)) {
    sideOk = false;
    sideDetail = `stack ${n} grew [${grew}], flipperSideForStack says ${flipperSideForStack(n)}`;
    break;
  }
}
check('every stack grows exactly the fin flipperSideForStack names', sideOk,
  sideDetail || `stacks 1-${CAP} alternate ${FLIPPER_SIDES.join('/')}`);

check('...so the pair is even at every even stack',
  [2, 4, 6].filter((n) => n <= CAP).every((n) => radius(stats(n), 'left') === radius(stats(n), 'right')),
  'a card that fed one fin twice would show here');

// ---------------------------------------------------------------------------
section('the first picks are size and nothing else');

// The branch the all-100 synthetic block cannot reach. If this passes while
// test:upgrades is green, the card is a size card early and an element card
// late, which is what it says it is.
const beforeElements = Array.from({ length: ELEMENT_AT - 1 }, (_, i) => stats(i + 1));
check(`stacks 1-${ELEMENT_AT - 1} put no element on either fin`,
  beforeElements.every((s) => FLIPPER_SIDES.every((side) => elLevel(s, side) === 0)),
  beforeElements.map((s) => `L${elLevel(s, 'left')}/R${elLevel(s, 'right')}`).join(' '));

check('...and every one of them still grows a stone',
  beforeElements.every((s, i) => radius(s, flipperSideForStack(i + 1)) > 1),
  'a size card that granted no size would be a dead pick');

if (ELEMENT_AT <= CAP) {
  const lit = stats(ELEMENT_AT);
  check(`stack ${ELEMENT_AT} lights exactly one fin`,
    FLIPPER_SIDES.filter((side) => elLevel(lit, side) > 0).length === 1,
    `L${elLevel(lit, 'left')}/R${elLevel(lit, 'right')}`);
  check('...the same fin that stack grew',
    elLevel(lit, flipperSideForStack(ELEMENT_AT)) === 1,
    `expected ${flipperSideForStack(ELEMENT_AT)}`);
}

check('the element half is reachable at all', ELEMENT_AT <= CAP,
  `stack ${ELEMENT_AT} against a cap of ${CAP} — above the cap the card promises an element it can never deal`);

// ---------------------------------------------------------------------------
section('the roll');

// rollFinElement is not exported (it is an implementation detail of addUpgrade),
// so this exercises the two properties that matter through the door the game
// uses: the scan that reads the roll back, and the pool it is drawn from.
const ELEMENTS = Object.keys(CONFIG.biolum?.elements ?? {});
check('there are enough elements that two fins can always differ', ELEMENTS.length >= 2,
  `${ELEMENTS.length}: ${ELEMENTS.join(', ')}`);

// A pick list with the sides deliberately crossed: if finElementsIn read the
// stamp rather than the position, this would come back the wrong way round.
const crossed = [
  { id: 'flippersUp' }, { id: 'flippersUp' },
  { id: 'flippersUp', finElement: 'shock' },
  { id: 'flippersUp', finElement: 'venom' },
];
const read = finElementsIn(crossed);
check('the 3rd stack\'s element is read onto the 3rd stack\'s fin',
  read[flipperSideForStack(3)] === 'shock', JSON.stringify(read));
check('...and the 4th onto the other one',
  read[flipperSideForStack(4)] === 'venom' && read[otherSide(flipperSideForStack(4))] === 'shock',
  JSON.stringify(read));

check('a pick with no stamp contributes nothing',
  Object.values(finElementsIn([{ id: 'flippersUp' }, { id: 'flippersUp' }])).every((v) => v === null),
  'a fin given an element nobody rolled is worse than a fin with none');

check('other cards in the list are ignored',
  finElementsIn([
    { id: 'multishot' }, { id: 'flippersUp' }, { id: 'heavyRounds' },
    { id: 'flippersUp' }, { id: 'flippersUp', finElement: 'chill' },
  ])[flipperSideForStack(3)] === 'chill',
  'the counter must advance on flippersUp picks only');

// ---------------------------------------------------------------------------
section('rarity cannot bend the side');

// `flippersUpStacks` is a count whose PARITY steers the card. A tier that
// scaled it to 1.25 would not merely be a fractional level — the next stack
// would land on the wrong fin, and so would the element rolled for it.
const rare = computeStats(
  Array.from({ length: CAP }, () => ({ id: 'flippersUp', rarity: 'legendary' })), 1, 0, 0,
);
check('the stack counter stays a whole number at the top tier',
  Number.isInteger(rare.flippersUpStacks) && rare.flippersUpStacks === CAP,
  `${rare.flippersUpStacks}`);
check('...and so do both element levels',
  FLIPPER_SIDES.every((side) => Number.isInteger(elLevel(rare, side))),
  FLIPPER_SIDES.map((side) => `${side} ${elLevel(rare, side)}`).join(', '));
check('the SIZE half still scales with the tier',
  radius(rare, 'left') > radius(stats(CAP), 'left'),
  `${radius(rare, 'left').toFixed(3)} vs ${radius(stats(CAP), 'left').toFixed(3)}`);

// ---------------------------------------------------------------------------
section('the run summary splits the two fins');

// The ledger's fin keys are built by finKey() in main.js and read back by
// finTable() here. main.js cannot be imported in Node (it opens a renderer), so
// the KEY SHAPE is the seam between the two — this pins it from the reading end,
// and the shapes below are exactly what finKey emits.
const split = finTable({
  finDamage: {
    left: 400,              // a fin throwing plain stones
    'left:shock': 1200,     // ...and the same fin after it was lit
    'right:venom': 900,
  },
});
check('one row per flipper, not one per key', split.rows.length === 2,
  split.rows.map((r) => r.side).join(', '));
check('a fin\'s plain and lit damage add up under it',
  split.rows.find((r) => r.side === 'left')?.damage === 1600, 'left 400 + 1200');
check('the busier fin sorts first', split.rows[0].side === 'left',
  `${split.rows[0].side} ${split.rows[0].damage} vs ${split.rows[1].side} ${split.rows[1].damage}`);
check('shares are against the gun\'s own total, not the run\'s',
  Math.abs(split.rows[0].share - 1600 / 2500) < 1e-9,
  `${(split.rows[0].share * 100).toFixed(1)}%`);
check('each fin lists what it was throwing',
  split.rows.find((r) => r.side === 'right')?.types[0].element === 'venom'
  && split.rows.find((r) => r.side === 'left')?.types[0].element === 'shock',
  'the biggest type first, so a fin lit late still reads as its element');
check('an unlit fin reports a type of null, not a made-up one',
  split.rows.find((r) => r.side === 'left')?.types.some((t) => t.element === null),
  'the UI prints no note for it rather than inventing a word');

// A run that never took the card must produce NOTHING rather than a 50/50 row:
// the gun leaves both fins from the first second and telling them apart is
// exactly what the card buys.
const none = finTable({ finDamage: {} });
check('a run without the card has no split to show', none.rows.length === 0,
  `${none.rows.length} rows, ${none.total} damage`);

console.log('\n' + '─'.repeat(72));
console.log(failures ? `FAIL — ${failures} problem(s)` : 'PASS — all checks');
console.log('─'.repeat(72) + '\n');
process.exit(failures ? 1 : 0);
