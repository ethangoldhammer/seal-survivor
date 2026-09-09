#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sealbubbles
//
// Bubbles off the seal under the cards (systems/levelUpBubbles.js), on the
// real furseal.glb with no renderer.
//
// WHAT IT GUARDS:
//   THE SPOTS      every burst is born on the animal — the mouth, a flipper
//                  tip, the tail — never at its centre or in space.
//   THE CADENCE    a still seal barely breathes; moving trails a wake and
//                  pointing opens the mouth, each well above the idle rate.
//   THE RING       recycles rather than grows, and the dead are parked.
//   OFF IS OFF     nothing while the seal is off screen or the switch is off.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createLevelUpPuppet } from '../path/src/systems/levelUpSeal.js';
import { createLevelUpBubbles } from '../path/src/systems/levelUpBubbles.js';
import { setMotionData } from '../path/src/systems/levelUpSealMotion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');
const DT = 1 / 60;
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
if (!existsSync(MODEL)) { console.error(`missing ${MODEL}`); process.exit(1); }
const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
installModel('ship', gltf.scene, gltf.animations);

// Seeded, so the breath timer's draws are the same every run.
let seed = 12345;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const FRAME = { w: 1280, h: 720, crownLine: 480, centreX: 640, idle: { x: 640, y: 320 },
  cards: [{ x: 400, y: 300 }, { x: 640, y: 300 }, { x: 880, y: 300 }], cursor: null, portrait: false };
const T = (anchor, x = 0, y = 0, s = 1, key = 'w') => ({ anchor, x, y, [key]: s });
const L = (anchor, x, y, heading = 0, look = T('card', 0, 0, 1, 'out'), left = T('none'), right = T('none')) => ({
  land: { anchor, x, y }, heading, roll: 0, look, fins: { left, right },
});
setMotionData({ version: 3, states: {
  idle: L('row', 0, 0.1, 0, T('none', 0, 0, 0, 'out')),
  card1: L('card', -0.15, 0.25, 0.2, T('card', 0, 0, 1, 'out'), T('none'), T('card', 0, 0, 1)),
  card2: L('card', 0, 0.3, 0), card3: L('card', 0.15, 0.25, -0.2),
} });
const CFG = CONFIG.levelUpSeal;
CFG.enabled = true; CFG.free = true; CFG.freeHeight = 0.28; CFG.pull = { enabled: false };
CFG.bubbles = JSON.parse(JSON.stringify(CFG.bubbles));

const p = createLevelUpPuppet(createVisual('ship'), { eyes: false, dress: false });
p.setFrame(FRAME);
const b = createLevelUpBubbles({ capacity: 300 });
b.reset();
const pos = b.points.geometry.getAttribute('position');
const starts = b.points.geometry.getAttribute('aStart');

// Every burst since `from` (a ring cursor), and the nearest spot to each.
function spots() {
  const r = p.rig;
  const out = [];
  if (r.anchors?.mouth) out.push(['mouth', r.anchors.mouth]);
  if (r.anchors?.finL) out.push(['finL', r.anchors.finL]);
  if (r.anchors?.finR) out.push(['finR', r.anchors.finR]);
  for (const m of r.muzzles ?? []) out.push(['muzzle', m]);
  if (r.anchors?.tail) out.push(['tail', r.anchors.tail]);
  return out;
}
function run(sec, onFrame) {
  const before = b.emitted;
  for (let t = 0; t < sec - 1e-9; t += DT) { p.update(DT); b.update(DT, p, 1); onFrame?.(); }
  return b.emitted - before;
}

section('THE SPOTS');
{
  check('the rig has the run\'s spots', p.rig.anchors?.mouth && p.rig.anchors?.finL && p.rig.anchors?.finR && p.rig.tail && (p.rig.muzzles?.length ?? 0) >= 2,
    Object.keys(p.rig.anchors ?? {}).join(' '));
  p.enter();
  // Check births as they happen: a new particle's position against this
  // frame's anchors, before the animal moves on.
  let born = 0; let onBody = 0; let farthest = 0; let lastCursor = 0;
  const seen = new Set();
  run(2.5, () => {
    for (let i = 0; i < 300; i++) {
      const st = starts.getX(i);
      if (Math.abs(st - b.clock) > 1e-4) continue; // float32 in the buffer
      const key = `${i}:${st}`;
      if (seen.has(key)) continue;
      seen.add(key);
      born++;
      const x = pos.getX(i); const y = pos.getY(i);
      let best = Infinity;
      for (const [, a] of spots()) best = Math.min(best, Math.hypot(a.x - x, a.y - y));
      // ...or down the tail chain, which is between the tail anchor and the ankle.
      const len = p.swimLen * p.state.scale;
      if (best < len * 0.12) onBody++;
      farthest = Math.max(farthest, best / len);
    }
  });
  check('the swim up trails bubbles', born > 20, `${born} born over the entry`);
  check('every one is born on a spot of the animal', onBody === born, `${onBody} of ${born} within 12% of a length of a spot; farthest ${farthest.toFixed(2)} lengths`);
}

section('THE CADENCE');
{
  let n = 0; while (p.phase !== 'held' && n++ < 600) { p.update(DT); b.update(DT, p, 1); }
  run(3); // settle
  const still = run(6) / 6;
  p.look({ x: 400, y: 300, cx: 400, cy: 300, option: 0 });
  run(2); // swim over
  const pointing = run(6) / 6;
  CFG.bubbles.breath.enabled = false;
  p.look(null);
  run(2);
  const noBreath = run(4) / 4;
  CFG.bubbles.breath.enabled = true;
  check('a still seal only breathes', noBreath === 0 && still > 0, `${still.toFixed(1)} particles/s still, ${noBreath.toFixed(1)} with the breath off`);
  check('pointing opens the mouth', pointing > still * 2, `${pointing.toFixed(1)} vs ${still.toFixed(1)} particles/s`);
  // Moving: a long swim back and forth.
  let moving = 0; let secs = 0;
  for (let k = 0; k < 4; k++) {
    p.look(k % 2 ? { x: 400, y: 300, cx: 400, cy: 300, option: 0 } : { x: 880, y: 300, cx: 880, cy: 300, option: 2 });
    moving += run(1.2); secs += 1.2;
  }
  moving /= secs;
  check('moving trails a wake, above pointing', moving > pointing * 1.3, `${moving.toFixed(1)} vs ${pointing.toFixed(1)} particles/s`);
  CFG.bubbles.wake.enabled = false;
  let noWake = 0; secs = 0;
  for (let k = 0; k < 4; k++) {
    p.look(k % 2 ? { x: 400, y: 300, cx: 400, cy: 300, option: 0 } : { x: 880, y: 300, cx: 880, cy: 300, option: 2 });
    noWake += run(1.2); secs += 1.2;
  }
  noWake /= secs;
  check('...and it is the wake', noWake < moving * 0.6, `${noWake.toFixed(1)} particles/s with the wake off`);
  CFG.bubbles.wake.enabled = true;
}

section('THE RING, AND OFF');
{
  check('the ring recycles', b.alive() <= 300 && b.emitted > 300, `${b.alive()} alive of ${b.emitted} emitted`);
  p.leave();
  let n = 0; while (p.phase !== 'none' && n++ < 600) { p.update(DT); b.update(DT, p, 1); }
  const after = run(2);
  check('nothing while the seal is off screen', after === 0, `${after} emitted`);
  for (let t = 0; t < 3; t += DT) b.update(DT, p, 1);
  check('...and what it left behind has risen and died', b.alive() === 0, `${b.alive()} alive`);
  CFG.bubbles.enabled = false;
  p.enter();
  const off = run(2);
  check('the switch is a switch', off === 0, `${off} emitted with bubbles off`);
  CFG.bubbles.enabled = true;
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
