#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hitguard
//
// A weapon walking the enemy list while emptying it — systems/hitShape.js.
//
// THE FREEZE THIS EXISTS FOR. Every weapon iterates the creatures backwards so
// it can kill as it goes, and counting down is safe against losing ONE per
// step. It is not safe against a blast, which takes everything in its radius
// out of the list at once: the index is then past the end, `enemiesList[j]` is
// undefined, and the hit test reads `.hitShape` off nothing.
//
// What makes that worth a test rather than a fix and a shrug is where it lands.
// The throw happens inside animate(), so the frame loop stops — the game
// freezes with the renderer still running, no error anywhere a player or a
// developer can see it, and the crash trail's last word is whatever screen
// happened to be up. It took four device sessions and a minified stack to find
// once. It must not be found twice.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { hitCreature, hitCreatureSegment } from '../path/src/systems/hitShape.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const survives = (fn) => {
  try { return { ok: true, value: fn() }; } catch (err) { return { ok: false, err }; }
};

const creature = (x, y, r = 1) => {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return { mesh, radius: r, hitShape: null };
};

section('A HOLE IN THE LIST IS NOT A HIT');
for (const [what, gone] of [['undefined', undefined], ['null', null]]) {
  const a = survives(() => hitCreature(gone, 0, 0, 1));
  check(`hitCreature(${what}) answers instead of throwing`, a.ok, a.err?.message);
  check(`...and the answer is "no hit"`, a.value === false);
  const b = survives(() => hitCreatureSegment(gone, 0, 0, 1, 1, 1));
  check(`hitCreatureSegment(${what}) answers instead of throwing`, b.ok, b.err?.message);
  check(`...and the answer is "no hit"`, b.value === false);
}
// A creature mid-teardown, which is the other shape this can arrive in.
check('a creature whose mesh has gone is not a hit',
  survives(() => hitCreature({ radius: 1 }, 0, 0, 1)).value === false);

section('AND A REAL CREATURE STILL IS ONE');
check('a body inside the reach hits', hitCreature(creature(0, 0), 0.5, 0, 1) === true);
check('...and one outside it does not', hitCreature(creature(50, 0), 0, 0, 1) === false);
check('a segment through a body hits', hitCreatureSegment(creature(0, 0), -5, 0, 5, 0, 0.5) === true);
check('...and one that misses does not', hitCreatureSegment(creature(0, 40), -5, 0, 5, 0, 0.5) === false);

section('A BLAST EMPTYING THE LIST MID-SWING');
// The club's loop, reduced to its shape: walk backwards, and on a hit remove a
// whole cluster rather than the single creature that was struck.
{
  const list = [];
  for (let i = 0; i < 12; i++) list.push(creature(i * 0.4, 0));
  let hits = 0;
  const run = survives(() => {
    for (let j = list.length - 1; j >= 0; j--) {
      const e = list[j];
      if (!e) continue;
      if (!hitCreature(e, 0, 0, 40)) continue;
      hits++;
      // The blast: everything within its radius leaves the list at once, which
      // is up to five entries below AND above the one being tested.
      list.splice(Math.max(0, j - 4), 5);
    }
  });
  check('the swing runs to the end of a list that keeps shrinking', run.ok, run.err?.message);
  check('...and it connected with something', hits > 0, `${hits} hit(s)`);
  check('...and emptied the water', list.length === 0, `${list.length} left`);
}

// The same loop WITHOUT the call-site guard, which is what the ten other
// weapons look like — this is the check that the backstop in hitShape.js is
// carrying them.
{
  const list = [];
  for (let i = 0; i < 12; i++) list.push(creature(i * 0.4, 0));
  const run = survives(() => {
    for (let j = list.length - 1; j >= 0; j--) {
      if (!hitCreature(list[j], 0, 0, 40)) continue;
      list.splice(Math.max(0, j - 4), 5);
    }
  });
  check('an unguarded loop survives it too — the backstop is doing the work',
    run.ok, run.err?.message);
}

console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
