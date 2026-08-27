#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:rimvariant
//
// A LOOK IS THE BODY AND ITS EDGE. skins.csv rolls a creature's palette per
// individual; these columns roll its RIM with it, so a turtle draws one row
// rather than a pattern from one place and a border from another.
//
// The four things that go wrong here, and every one of them renders a
// plausible creature:
//
//   THE SHARED MATERIAL   outlines.js gives a whole species ONE outline
//                         material, and that sharing is load-bearing: it is
//                         what lets a tuner slider reach creatures already
//                         swimming. A per-instance clone would keep that
//                         property for nobody and would grow with the
//                         population. So the material is keyed per skin ROW —
//                         two turtles on the same row share one, two turtles
//                         on different rows do not, and the count is bounded
//                         by the table rather than by the water.
//   THE SWITCH            a CSV row must not be able to turn a rim ON for a
//                         species whose switch is false. The switch is the
//                         roster decision, the row is the look, and letting a
//                         row overrule the first is how a creature ends up
//                         rimmed that nobody chose to rim.
//   THE POOLED BODY       bodies are recycled. A turtle arriving from the pool
//                         still wears whatever it rolled last time, so the
//                         roll that returns NOTHING has to be able to undo the
//                         roll that returned something. `null` is not a no-op.
//   BLANK vs OFF          blank inherits the species' rim and `none` takes it
//                         off, and a colour column alone cannot say the
//                         second one. Same three-way shape as assets.csv's
//                         `skin` cell.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { buildSkins, rollSkin } from '../path/src/skinTable.js';
import { setOutlineVariant, applyCreatureOutlines } from '../path/src/systems/outlines.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// A stand-in body carrying one shell, which is the shape addOutlineShells
// leaves behind — a mesh flagged `__isOutline`, sharing its species' material.
const body = () => {
  const root = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  shell.userData.__isOutline = true;
  root.add(shell);
  return root;
};
const rimOf = (root) => root.children[0].material;

// ---------------------------------------------------------------------------
section('the columns — blank inherits, a hex paints, `none` removes');
// ---------------------------------------------------------------------------
const warns = [];
const table = buildSkins(new Map([
  ['plain', { preset: 'p', gate: 'day' }],
  ['tinted', { preset: 'p', gate: 'day', rim: '#22ddaa', rimGlow: '3', rimThickness: '0.2' }],
  ['bare', { preset: 'p', gate: 'day', rim: 'none' }],
  ['bad', { preset: 'p', gate: 'day', rim: 'notacolour' }],
]), { patterns: ['blotches'], presetIsNight: () => false }, (m) => warns.push(m));

const row = (id) => table.p.find((r) => r.id === id);
check('a row saying nothing about the rim carries none', row('plain').rim === null,
  'null is what tells outlines.js to leave the shared material alone');
check('a hex and its two numbers all land', JSON.stringify(row('tinted').rim)
  === JSON.stringify({ color: 0x22ddaa, glow: 3, thickness: 0.2 }));
check('`none` is a state, not a colour', row('bare').rim?.off === true);
check('an unreadable colour warns and inherits rather than painting black',
  row('bad').rim === null && warns.length === 1, warns[0]?.slice(0, 70));

// ---------------------------------------------------------------------------
section('the roll carries the rim with the palette');
// ---------------------------------------------------------------------------
const rolled = rollSkin({ p: [row('tinted')] }, 'p', () => 0.5);
check('__rim rides on the variant', rolled.__rim?.color === 0x22ddaa,
  'so a caller cannot roll a body and its edge apart');
check('...and names its row, which is what keys the material', rolled.__rim?.id === 'tinted');
check('a row with no rim rolls a variant with no __rim',
  rollSkin({ p: [row('plain')] }, 'p', () => 0.5).__rim === undefined);

// ---------------------------------------------------------------------------
section('the material is shared per ROW, not per creature');
// ---------------------------------------------------------------------------
const KEY = 'enemySeaTurtle';
const wasOn = CONFIG.creatureOutline.on[KEY];
CONFIG.creatureOutline.on[KEY] = true;

const plainBody = body();
const two = [body(), body()];
const other = body();
setOutlineVariant(plainBody, KEY, null);
for (const b of two) setOutlineVariant(b, KEY, { id: 'tinted', color: 0x22ddaa, glow: 3, thickness: 0.2 });
setOutlineVariant(other, KEY, { id: 'granite', color: 0x5d6b6f, glow: 1 });

check('two creatures on one row share a single material', rimOf(two[0]) === rimOf(two[1]),
  'bounded by the table, so the tuner still reaches everything wearing it');
check('a variant does not touch the species\' own material', rimOf(plainBody) !== rimOf(two[0]));
check('two different rows are two different materials', rimOf(two[0]) !== rimOf(other));
check('the row\'s colour is the one on screen', rimOf(two[0]).color.getHexString() !== rimOf(plainBody).color.getHexString(),
  `row #${rimOf(two[0]).color.getHexString()} vs species #${rimOf(plainBody).color.getHexString()}`);

// ---------------------------------------------------------------------------
section('what a row may not do');
// ---------------------------------------------------------------------------
const bareBody = body();
setOutlineVariant(bareBody, KEY, { id: 'bare', off: true });
check('`none` hides that row and nothing else', rimOf(bareBody).visible === false && rimOf(two[0]).visible === true);

CONFIG.creatureOutline.on[KEY] = false;
applyCreatureOutlines();
check('the species switch beats every row', rimOf(two[0]).visible === false,
  'a CSV row is a look, not a roster decision');
CONFIG.creatureOutline.on[KEY] = true;
applyCreatureOutlines();
check('...and flipping it back reaches creatures already built', rimOf(two[0]).visible === true);

check('an asset in neither switch list has nothing to vary',
  setOutlineVariant(body(), 'enemyClownFish', { id: 'x', color: 1 }) === 0);

// ---------------------------------------------------------------------------
section('the pooled body');
// ---------------------------------------------------------------------------
const recycled = two[0];
const wasVariant = rimOf(recycled);
setOutlineVariant(recycled, KEY, null);
check('a null roll puts a recycled body back on the species rim',
  rimOf(recycled) !== wasVariant && rimOf(recycled) === rimOf(plainBody),
  'the roll that returns nothing has to undo the roll that returned something');

CONFIG.creatureOutline.on[KEY] = wasOn;
console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASS — all checks\n');
process.exit(failures ? 1 : 0);
