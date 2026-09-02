#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run looks:fishturn [-- <id> <out.svg>]
//
// A FILMSTRIP OF A FISH COMING ABOUT, side by side with the turn it replaced.
// See systems/fishTurn.js.
//
// CONFIG.fishTurn has ten knobs and until this existed there was no way to
// look at any of them: the Browser pane suspends rAF, so the game cannot be
// filmed there, and the thing being tuned is a second of motion rather than a
// frame. tools/fish-turn-test.mjs asserts that the turn goes through the lens;
// this says what going through the lens LOOKS like, which is the other half of
// the question and the half a number cannot answer.
//
// NO GL AND NO MODEL. A real creature is driven through a real reversal in the
// headless harness and its composed orientation is read off every frame, then a
// stand-in body — a lozenge with a dorsal fin and a tail, in the model's own
// axes — is transformed by that matrix and projected orthographically down -Z.
// So the SHAPE is a cartoon and the MOTION is the shipped one, which is the
// right way round: the whole point is what the body does over a second, and no
// amount of barracuda geometry would make a wrong path look right.
//
// The old row is drawn from the same velocity trace through the legacy
// composition (mesh.rotation.z = heading, visual.rotation.y eased 0 -> PI), so
// the two rows are the same fish making the same decision.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { ease } from '../path/src/ease.js';

const [id = 'barracuda', out = 'fish-turn.svg'] = process.argv.slice(2);

const realWarn = console.warn;
console.warn = (m, ...r) => {
  if (typeof m === 'string' && (m.startsWith('[animation]') || m.startsWith('[assets]'))) return;
  realWarn(m, ...r);
};

const dt = 1 / 60;
const MID = -20;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// THE STAND-IN, in the model's own axes: +Y is the nose, -X is the back, +Z is
// the flank the camera sees at rest (see orientationQuaternion in assets.js).
// A flat outline on purpose — a paper fish goes to a sliver when it points at
// the lens, which is exactly the read being checked.
const BODY = [
  [0, 1.0, 0], [-0.16, 0.55, 0], [-0.2, 0, 0], [-0.15, -0.55, 0],
  [-0.34, -1.0, 0], [0, -0.78, 0], [0.34, -1.0, 0], [0.15, -0.55, 0],
  [0.2, 0, 0], [0.16, 0.55, 0],
];
const SAIL = [[-0.18, 0.35, 0], [-0.5, 0.1, 0], [-0.46, -0.3, 0], [-0.17, -0.3, 0]];

const FRAME = 78;      // px per cell
const SCALE = 30;      // px per model unit
const PAD = 14;

function project(pts, m) {
  const v = new THREE.Vector3();
  return pts.map(([x, y, z]) => {
    v.set(x, y, z).applyMatrix4(m);
    // Orthographic down -Z, screen y up. The z is kept only to shade by depth.
    return [v.x * SCALE, -v.y * SCALE, v.z];
  });
}

function poly(pts, fill, stroke) {
  const d = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return `<polygon points="${d}" fill="${fill}" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"/>`;
}

function cell(m, x, y, tint) {
  const body = project(BODY, m);
  const sail = project(SAIL, m);
  // How side-on the fish is, for a hint of shading: the flank normal is local
  // +Z, and how much of it still points at the camera is how much of the body
  // there is to see.
  const n = new THREE.Vector3(0, 0, 1).applyMatrix4(m).z;
  const face = Math.abs(n);
  const fill = `rgba(${tint}, ${(0.16 + 0.5 * face).toFixed(2)})`;
  return `<g transform="translate(${x},${y})">`
    + poly(body, fill, `rgb(${tint})`)
    + poly(sail, `rgba(${tint}, ${(0.1 + 0.35 * face).toFixed(2)})`, `rgb(${tint})`)
    + '</g>';
}

// ---------------------------------------------------------------------------
// Drive the real creature until it has reversed, and keep the window around it.
const scene = new THREE.Scene();
const orig = Math.random;
Math.random = seeded(4);
resetEnemies(scene);
const e = spawnNamed(scene, id, 0, { x: -10, y: MID }, { ignoreCaps: true });
if (!e) throw new Error(`could not spawn ${id}`);
const player = new THREE.Vector3(20, MID, 0);
const trace = [];
for (let i = 0; i < 60 * 12; i++) {
  // Park the seal on the right until the fish is committed to it, then move it
  // to the left: one clean, unambiguous reversal to film.
  if (i === 60 * 3) player.set(-20, MID, 0);
  updateEnemies(dt, scene, player, () => {}, () => {});
  if (!enemies.includes(e)) break;
  trace.push({
    t: i * dt,
    yaw: e.mesh.rotation.y,
    pitch: e.mesh.rotation.z,
    bank: e.visual.rotation.y,
    vx: e.vx,
    vy: e.vy,
    stage: e.lungeStage,
  });
}
Math.random = orig;

// The window: the LONGEST run of frames where the yaw is between its two
// resting values. Longest and not first — a fish nudged off a resting yaw and
// straight back (the wind-up's own shimmy will do it) is a three-frame span
// that reads as a filmstrip of a fish doing nothing.
const moving = (f) => f.yaw < -1e-3 && f.yaw > -Math.PI + 1e-3;
let best = null;
let open = -1;
for (let i = 0; i <= trace.length; i++) {
  const on = i < trace.length && moving(trace[i]);
  if (on && open < 0) open = i;
  if (!on && open >= 0) {
    if (!best || i - open > best.end - best.start) best = { start: open, end: i - 1 };
    open = -1;
  }
}
if (!best) throw new Error('the fish never turned round — nothing to draw');
const air = 6;
const start = Math.max(0, best.start - air);
const end = Math.min(trace.length - 1, best.end + air);

const N = 11;
const picks = Array.from({ length: N }, (_, i) => trace[start + Math.round((end - start) * i / (N - 1))]);

// The legacy composition, from the same velocity trace. `faceSide` eases the
// roll over CONFIG.facing.time on its own clock, which is the other half of
// what made the old turn read badly — it is reproduced here rather than
// approximated, so the comparison is fair.
const fTime = CONFIG.facing?.time ?? 0.4;
const fCurve = CONFIG.facing?.curve ?? 'inOutCubic';
let roll = { from: 0, to: 0, at: 0, t: 1 };
const legacy = [];
for (let i = 0; i <= end; i++) {
  const f = trace[i];
  const want = f.vx < -0.05 ? Math.PI : (f.vx > 0.05 ? 0 : roll.to);
  if (want !== roll.to) { roll = { from: roll.at, to: want, at: roll.at, t: 0 }; }
  if (roll.t < 1) {
    roll.t = Math.min(1, roll.t + dt / fTime);
    roll.at = roll.from + (roll.to - roll.from) * ease(fCurve, roll.t);
  }
  legacy[i] = { heading: Math.atan2(f.vy, f.vx) - Math.PI / 2, roll: roll.at };
}

const mesh = new THREE.Object3D();
const visual = new THREE.Object3D();
function compose(order, mx, my, mz, vy) {
  mesh.rotation.order = order;
  mesh.rotation.set(mx, my, mz);
  visual.rotation.set(0, vy, 0);
  return new THREE.Matrix4()
    .makeRotationFromEuler(mesh.rotation)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(visual.rotation));
}

const W = PAD * 2 + FRAME * N;
const H = PAD * 2 + FRAME * 2 + 54;
const rows = [];
const label = (y, text, tint) =>
  `<text x="${PAD}" y="${y}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" fill="rgb(${tint})">${text}</text>`;

rows.push(label(PAD + 12, `${id} — now: the nose comes round through the camera`, '90, 190, 235'));
picks.forEach((f, i) => {
  const m = compose('YXZ', 0, f.yaw, f.pitch, f.bank);
  rows.push(cell(m, PAD + FRAME * i + FRAME / 2, PAD + 22 + FRAME / 2, '90, 190, 235'));
});

rows.push(label(PAD + FRAME + 46, `${id} — before: it loops nose-up and barrel-rolls`, '235, 140, 110'));
picks.forEach((f, i) => {
  const j = trace.indexOf(f);
  const l = legacy[j];
  const m = compose('XYZ', 0, 0, l.heading, l.roll);
  rows.push(cell(m, PAD + FRAME * i + FRAME / 2, PAD + FRAME + 56 + FRAME / 2, '235, 140, 110'));
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  + `<rect width="${W}" height="${H}" fill="#0d1519"/>`
  + rows.join('')
  + '</svg>';

writeFileSync(out, svg);
console.log(`${out} — ${N} frames of ${(picks[N - 1].t - picks[0].t).toFixed(2)}s, ${id}`);
