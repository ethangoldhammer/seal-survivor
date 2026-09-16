#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:scorecoral
//
// THE SCORE CORAL — systems/scoreBoost.js, and the second coral species in
// systems/coralOrb.js.
//
//   ROLL       one roll decides both numbers and they pull OPPOSITE ways, so
//              the two ends of the range are worth roughly the same. This is
//              the balance claim, and it is the one that cannot be checked by
//              looking: a 10x-for-25s and a 2x-for-25s render identically.
//   RARE       bigger is rarer. `bias` is a distribution, and a distribution
//              is only ever checked with a histogram.
//   WINDOW     it replaces upward, refreshes sideways, and ENDS. A multiplier
//              left behind on an expired clock is a run scoring triple forever
//              with nothing on screen saying so, and nothing would throw.
//   SIZE       what a coral in the water is worth is its size. The promise the
//              chum chunk's size makes, made again.
//   SPECIES    the two corals are grown from their OWN blocks. A helper still
//              reaching for the fire-rate coral's numbers would give the score
//              coral the wrong proportions, and it would look like a tuning
//              decision rather than a bug — forever.
//   WIRING     the asset row, the Look handle, the tuner group, the spawn
//              table. A pickup missing any one of these works fine and is
//              quietly unreachable from the tools built to shape it.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, TUNER_SCHEMA } from '../path/src/config.js';
import {
  rollScoreBoost, startScoreBoost, updateScoreBoost, scoreMul, scoreBoostState, resetScoreBoost,
} from '../path/src/systems/scoreBoost.js';
import { growCoral, coralParams, createCoralOrb } from '../path/src/systems/coralOrb.js';
import { spawnScoreOrb, scoreOrbs, resetPickups } from '../path/src/entities/pickups.js';
import { ASSETS, getAssetSizeMultiplier } from '../path/src/assets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

// Seeded, so a histogram that shifts is a change to the roll and not a bad
// afternoon. See the memory on seeded spawn harnesses.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const c = CONFIG.scorePickup;

// ---------------------------------------------------------------------------
section('ROLL — one roll, two numbers, pulling opposite ways');
{
  const lo = rollScoreBoost(() => 0, c);
  const hi = rollScoreBoost(() => 1, c);
  check('the bottom of the range is the smallest multiplier', lo.mult === Math.round(c.multMin),
    `x${lo.mult}`);
  check('...for the LONGEST window', Math.abs(lo.seconds - c.secondsMax) < 1e-6, `${lo.seconds}s`);
  check('the top of the range is the biggest multiplier', hi.mult === Math.round(c.multMax),
    `x${hi.mult}`);
  check('...for the BRIEFEST', Math.abs(hi.seconds - c.secondsMin) < 1e-6, `${hi.seconds}s`);
  // The whole point of tying them: neither end is the obvious one to want.
  // Multiplier x seconds is the crude proxy for what a window is worth, and
  // the claim is that the ends are within a factor of two of each other rather
  // than one being twelve times the other.
  const worthLo = lo.mult * lo.seconds;
  const worthHi = hi.mult * hi.seconds;
  const ratio = Math.max(worthLo, worthHi) / Math.min(worthLo, worthHi);
  check('...so the two ends are worth roughly the same', ratio < 2,
    `${worthLo.toFixed(0)} vs ${worthHi.toFixed(0)} (x-seconds), ${ratio.toFixed(2)}x apart`);
  // ...and everything between them is monotone, or the size of a coral in the
  // water stops meaning anything.
  const walk = Array.from({ length: 20 }, (_, i) => rollScoreBoost(() => i / 19, c));
  check('the multiplier only ever rises with the roll',
    walk.every((v, i) => i === 0 || v.mult >= walk[i - 1].mult));
  check('...and the window only ever shortens',
    walk.every((v, i) => i === 0 || v.seconds <= walk[i - 1].seconds));
  // A multiplier printed as `x7` on the HUD must BE 7 in the score.
  check('every multiplier is a whole number', walk.every((v) => Number.isInteger(v.mult)),
    `${[...new Set(walk.map((v) => v.mult))].join(', ')}`);
}

// ---------------------------------------------------------------------------
section('RARE — bigger is rarer, and that is a histogram');
{
  const rand = seeded(20260909);
  const rolls = Array.from({ length: 20000 }, () => rollScoreBoost(rand, c));
  const mults = rolls.map((r) => r.mult).sort((a, b) => a - b);
  const median = mults[Math.floor(mults.length / 2)];
  const top = mults.filter((m) => m >= c.multMax).length / mults.length;
  const bottomHalf = mults.filter((m) => m <= (c.multMin + c.multMax) / 2).length / mults.length;
  check('the median coral is nearer the small end than the big one',
    median < (c.multMin + c.multMax) / 2, `median x${median} of x${c.multMin}..x${c.multMax}`);
  check('most of them are in the bottom half of the range', bottomHalf > 0.6,
    `${(bottomHalf * 100).toFixed(0)}%`);
  check('the biggest is genuinely rare', top > 0 && top < 0.06,
    `${(top * 100).toFixed(1)}% roll the maximum`);
  // A bias of 1 has to be the flat roll, or the knob does not mean what the
  // table says it means.
  const flatRand = seeded(31);
  const flatRolls = Array.from({ length: 20000 }, () => rollScoreBoost(flatRand, { ...c, bias: 1 }));
  const flatTop = flatRolls.filter((r) => r.mult >= c.multMax).length / flatRolls.length;
  check('...and bias 1 is a flat roll', flatTop > top * 2,
    `${(flatTop * 100).toFixed(1)}% at bias 1 vs ${(top * 100).toFixed(1)}% at ${c.bias}`);
}

// ---------------------------------------------------------------------------
section('WINDOW — it replaces upward, refreshes sideways, and ENDS');
{
  resetScoreBoost();
  check('nothing running is a multiplier of 1', scoreMul() === 1);
  startScoreBoost(4, 10);
  check('a window multiplies', scoreMul() === 4);
  // Upward: the number AND its own clock.
  startScoreBoost(9, 6);
  check('a bigger one replaces it, clock and all', scoreMul() === 9 && scoreBoostState().left === 6,
    `x${scoreMul()} for ${scoreBoostState().left}s`);
  // Sideways/down: the clock, never the number — a pickup may not punish you
  // for collecting it.
  startScoreBoost(3, 20);
  check('a smaller one cannot cut the multiplier', scoreMul() === 9, `x${scoreMul()}`);
  check('...but it does buy time', scoreBoostState().left === 20, `${scoreBoostState().left}s`);
  // ...and only its OWN time. A 2x must not hand a live 9x another 25 seconds
  // on top of what it had.
  startScoreBoost(2, 4);
  check('...and only its own — a short one cannot extend a longer window',
    scoreBoostState().left === 20, `${scoreBoostState().left}s`);

  // AND IT ENDS. The one that would never throw.
  let t = 0;
  while (scoreBoostState().left > 0 && t < 60) { updateScoreBoost(1 / 60); t += 1 / 60; }
  check('the window runs out', scoreBoostState().left === 0, `after ${t.toFixed(1)}s`);
  check('...and the multiplier goes with it', scoreMul() === 1, `x${scoreMul()}`);
  check('...and the readout agrees', scoreBoostState().mult === 1 && scoreBoostState().frac === 0);

  startScoreBoost(7, 12);
  resetScoreBoost();
  check('a run ending clears it', scoreMul() === 1 && scoreBoostState().left === 0);
  // Nonsense in, nothing out — a coral that somehow rolled x1 must not open a
  // window that says x1 on the HUD for twenty seconds.
  check('a multiplier of 1 opens no window', startScoreBoost(1, 10) && scoreMul() === 1);
  check('...and neither does a zero-second one', startScoreBoost(5, 0) && scoreMul() === 1);
}

// ---------------------------------------------------------------------------
section('SIZE — what it is worth is how big it is');
{
  const scene = new THREE.Scene();
  resetPickups(scene);
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const widthOf = (orb) => {
    box.setFromObject(orb.mesh);
    box.getSize(size);
    return Math.max(size.x, size.y);
  };
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const grown = steps.map((t) => spawnScoreOrb(scene, { x: 0, y: 0, z: 0 },
    { roll: rollScoreBoost(() => t, c) }));
  check('a coral in the water is one per spawn', scoreOrbs.length === steps.length);
  // A GROWN shape is a different silhouette every time, so the width of one
  // roll is not a clean multiple of another's — what has to hold is the trend
  // across the range, which is what the eye is actually comparing.
  const widths = grown.map(widthOf);
  check('a coral worth more is drawn bigger, end to end',
    widths[widths.length - 1] > widths[0] * 1.3,
    widths.map((w) => w.toFixed(2)).join(' -> '));
  check('...and its measured body grows with it, so the reach to take it does too',
    grown[grown.length - 1].bodyRadius > grown[0].bodyRadius,
    grown.map((o) => o.bodyRadius.toFixed(2)).join(' -> '));
  // multiplyScalar, not setScalar — the asset row must survive the roll, and
  // so must the roll survive the asset row. Read off getAssetSizeMultiplier
  // rather than assumed: an asset with no row spawns at 1, which is a pickup
  // silently a third of its intended size (see the memory on assets.csv).
  const row = getAssetSizeMultiplier('scoreOrb');
  check('the asset row from assets.csv reaches this pickup at all', row > 1, `${row}x`);
  check('...and survives the roll on top of it',
    widths[0] > (c.coral.fit ?? 0.72) * c.scaleMin * row * 0.8,
    `smallest coral is ${widths[0].toFixed(2)} wide, not the bare fit ${(c.coral.fit * c.scaleMin).toFixed(2)}`);
  // It carries the roll it was drawn at, or the collect handler pays out
  // something other than what the player was shown.
  check('each one carries the window it was drawn for',
    grown.every((o) => o.mult >= c.multMin && o.seconds > 0)
    && grown[grown.length - 1].mult > grown[0].mult,
    `x${grown[0].mult} .. x${grown[grown.length - 1].mult}`);
  resetPickups(scene);
  check('a reset takes them out of the water', scoreOrbs.length === 0);
}

// ---------------------------------------------------------------------------
section('SPECIES — the two corals are grown from their own numbers');
{
  check('each species resolves its own block',
    coralParams('rapidFire') === CONFIG.rapidFirePickup.coral
    && coralParams('score') === CONFIG.scorePickup.coral);
  check('...and an unknown one falls back to a real coral, not an empty object',
    coralParams('nonesuch') === CONFIG.rapidFirePickup.coral);

  // THE ONE THAT WOULD RENDER PERFECTLY AND BE WRONG. If any helper still
  // reached for the fire-rate coral's block, the two species would come out
  // with the same segment counts from the same seed.
  const segsOf = (species, seed) => {
    const g = growCoral(seeded(seed), coralParams(species));
    return g.attributes.position.count;
  };
  const same = [1, 2, 3, 4, 5].filter((seed) => segsOf('rapidFire', seed) === segsOf('score', seed));
  check('the same seed grows two different corals', same.length === 0,
    `${[1, 2, 3, 4, 5].map((s) => `${segsOf('rapidFire', s)}/${segsOf('score', s)}`).join(' ')}`);
  // ...and the score coral is the denser of the two, which is the silhouette
  // difference the design is relying on to tell them apart mid-fight.
  const mean = (species) => [1, 2, 3, 4, 5, 6, 7, 8]
    .reduce((a, s) => a + segsOf(species, s), 0) / 8;
  // Both species normalise to their own `fit`, so at equal size the vertex
  // count IS the branch density — which is what "dense head" versus "open fan"
  // means, and the reason the two are told apart mid-fight by silhouette and
  // not only by hue. The margin is deliberately not tight: this is a
  // proportion decision Ethan retunes on the bench (npm run looks:coral), and
  // a threshold that pinned it to today's number would fail on every
  // legitimate adjustment.
  check('the score coral is the denser head', mean('score') > mean('rapidFire') * 1.25,
    `${mean('score').toFixed(0)} vertices vs the fan's ${mean('rapidFire').toFixed(0)} at the same fitted size`);
  // Every coral normalises to its own `fit`, so a lucky roll is not three
  // times the size of an unlucky one.
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const longest = [1, 2, 3, 4, 5, 6].map((seed) => {
    const g = growCoral(seeded(seed), coralParams('score'));
    g.computeBoundingBox();
    g.boundingBox.getSize(size);
    return Math.max(size.x, size.y, size.z);
  });
  void box;
  check('every grown coral normalises to its own fit',
    longest.every((v) => Math.abs(v - c.coral.fit) < 1e-4),
    longest.map((v) => v.toFixed(3)).join(' '));

  // The per-frame update has to read the species it was grown as. A mesh with
  // no species on it would silently pulse on the wrong block.
  const mesh = createCoralOrb(seeded(9), { species: 'score', assetKey: 'scoreOrb' });
  check('a grown coral remembers which species it is', mesh.userData.coral?.species === 'score');
  check('...and answers to the asset key the tables use', mesh.name === 'scoreOrb');
}

// ---------------------------------------------------------------------------
section('WIRING — the tables that make it reachable');
{
  check('the asset exists, so assets.csv is allowed a row', !!ASSETS.scoreOrb);
  const csv = fs.readFileSync(path.join(HERE, '../path/src/assets.csv'), 'utf8');
  check('...and has one, so it does not spawn at 1', /^scoreOrb,/m.test(csv));
  const spawning = fs.readFileSync(path.join(HERE, '../path/src/spawning.csv'), 'utf8');
  for (const key of ['enabled', 'spawnMin', 'spawnMax', 'lifetime', 'multMin', 'multMax',
    'secondsMin', 'secondsMax', 'bias']) {
    check(`spawning.csv owns scorePickup.${key}`,
      new RegExp(`^scorePickup\\.${key},`, 'm').test(spawning));
  }
  check('the Look panel can tint it',
    fs.readFileSync(path.join(HERE, '../path/src/ui/textures.js'), 'utf8').includes("'scoreOrb'"));
  const group = TUNER_SCHEMA.find((g) => g.group === 'Score coral pickup');
  check('the tuner has a group for its look', !!group && group.items.length > 10,
    `${group?.items.length ?? 0} rows`);
  // What must NOT be in the tuner: the gameplay half. See the memory on
  // gameplay numbers belonging in a CSV.
  const paths = (group?.items ?? []).map((i) => i.path);
  check('...and none of the gameplay numbers are sliders',
    !paths.some((p) => /\.(multMin|multMax|secondsMin|secondsMax|bias|spawnMin|spawnMax|lifetime|enabled)$/.test(p)),
    paths.filter((p) => /mult|seconds|bias|spawn/.test(p)).join(', ') || 'none');
  check('a strike dash pops it like every other floating pickup',
    CONFIG.strike.pickupBlast?.kinds?.scoreOrb > 0);
  check('the swallow has an event', !!CONFIG.feedback.scoreCoralTaken);
  const main = fs.readFileSync(path.join(HERE, '../path/src/main.js'), 'utf8');
  check('main.js banks the multiplier on a kill', /computeKillPoints[\s\S]{0,400}?scoreMul\(\)/.test(main));
  check('...and on a boat', /CONFIG\.boats\.xp[\s\S]{0,200}?scoreMul\(\)/.test(main));
  // The toast has to print what is RUNNING, not what was on the coral — see
  // startScoreBoost.
  check('...and the toast reports the live window, not the pickup\'s roll',
    /const live = startScoreBoost\([\s\S]{0,1600}?toastValue: `x\$\{live\.mult\}/.test(main));
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
