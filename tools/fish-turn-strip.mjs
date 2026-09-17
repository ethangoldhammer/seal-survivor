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
//
//   npm run looks:fishturn -- seaTurtle turtle-turn.svg
//
// THE TURTLE IS THE ONE THAT NEEDS ALL THREE OF THE ODDITIES BELOW, and each
// of them would quietly draw a wrong picture rather than fail:
//
//   IT HAS ITS OWN STAND-IN. The paper fish is a fair likeness of a spindle
//   and a libel on a body that is 95% as wide as it is long. Drawn as a fish
//   the turtle would look like it lost nothing to the old roll, which is the
//   opposite of the truth.
//   IT IS STEERED, NOT CHASED. It drifts and does not know the seal is there,
//   so moving the seal cannot ask it for a reversal. Its velocity is scripted
//   and `turnFish` driven directly — the same call updateEnemies makes.
//   ITS PITCH IS NOT ON THE MESH. It has a rigid body, and that body owns
//   `rotation.z`; the come-about writes the pitch to `restAngle` instead. Read
//   off the mesh, every frame here would be drawn dead level.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { turnFish } from '../path/src/systems/fishTurn.js';
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

// THE TURTLE IS A DIFFERENT SOLID AND HAS TO BE DRAWN AS ONE. A paper fish in
// the XY plane is a fair stand-in for a spindle — flat side to side is what a
// fish IS — and it is the wrong answer here twice over: it would hide the beam
// that makes the yaw cheap on this body, and it would hide the edge that made
// the roll so expensive. So the shell is a plate in the fore-aft x across
// plane (Y x Z, with the dorsal at -X, see above) at the proportions the model
// measures — 1.49 long, 1.42 across, 0.55 tall — and the dome is its side
// profile in Y x X. Between them the two polygons go broad when the animal is
// beam-on and thin when it is edge-on, which is the read the whole strip is
// about.
const ELL = (ry, rz, x, n = 16) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return [x, ry * Math.cos(a), rz * Math.sin(a)];
});
// THREE RINGS, NOT ONE. A single flat ellipse is a plate, and a plate seen
// edge-on from this camera projects to a LINE whatever its yaw — which draws
// the beam-on turtle as a hairline and makes the yaw look like the flip it
// replaced. The shell has 0.55 of crown on it; contouring it is what puts that
// crown on screen at every angle, the way a real dome keeps its height when it
// turns.
const SHELL = [ELL(0.72, 0.62, 0.02), ELL(0.56, 0.48, -0.16), ELL(0.34, 0.29, -0.27)];
const DOME = [
  [-0.27, 0.15, 0], [-0.24, 0.45, 0], [-0.1, 0.66, 0], [0.04, 0.72, 0],
  [0.06, -0.55, 0], [-0.08, -0.7, 0], [-0.22, -0.5, 0], [-0.27, -0.15, 0],
];
const HEAD = [[-0.04, 0.72, 0.1], [-0.1, 1.0, 0.09], [0.02, 1.02, 0], [0.04, 0.72, -0.1], [-0.1, 1.0, -0.09]];
const FLIPPER = (y0, y1, z, sign) => [
  [-0.04, y0, z * 0.55], [-0.06, y1 + sign * 0.16, z * 1.05],
  [-0.02, y1 - sign * 0.06, z * 1.02], [0, y0 - sign * 0.18, z * 0.5],
];

// A part is a polygon plus the normal its shading is read off — the flank for
// a fish, the shell's own face for a turtle, so each solid dims when IT goes
// edge-on rather than when a fish would have.
const FLANK = [0, 0, 1];
const SHELLFACE = [-1, 0, 0];
const STANDINS = {
  default: [{ pts: BODY, n: FLANK }, { pts: SAIL, n: FLANK }],
  seaTurtle: [
    { pts: DOME, n: FLANK },
    { pts: FLIPPER(0.34, 0.86, 1, 1), n: SHELLFACE },
    { pts: FLIPPER(0.34, 0.86, -1, 1), n: SHELLFACE },
    { pts: FLIPPER(-0.34, -0.78, 1, -1), n: SHELLFACE },
    { pts: FLIPPER(-0.34, -0.78, -1, -1), n: SHELLFACE },
    { pts: HEAD, n: SHELLFACE },
    ...SHELL.map((pts) => ({ pts, n: SHELLFACE })),
  ],
};

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

function cell(m, x, y, tint, parts) {
  const v = new THREE.Vector3();
  const drawn = parts.map(({ pts, n }) => {
    // How side-on this solid is, for a hint of shading: how much of its own
    // normal still points at the camera is how much of it there is to see.
    const face = Math.abs(v.set(n[0], n[1], n[2]).applyMatrix4(m).z);
    return poly(project(pts, m), `rgba(${tint}, ${(0.13 + 0.45 * face).toFixed(2)})`, `rgb(${tint})`);
  });
  return `<g transform="translate(${x},${y})">${drawn.join('')}</g>`;
}

// ---------------------------------------------------------------------------
// Drive the real creature until it has reversed, and keep the window around it.
const scene = new THREE.Scene();
const def = CONFIG.enemies[id];
if (!def) throw new Error(`no such creature: ${id}`);
const parts = STANDINS[id] ?? STANDINS.default;
// Which way round this one goes — the far pose, as systems/fishTurn.js reads
// it. Everything below that has to know where "mid-turn" is asks this rather
// than assuming the [-PI, 0] interval, because the sea turtle's is [0, PI].
const FAR = (typeof def.comeAbout === 'object' ? def.comeAbout.through : null)
  ?? CONFIG.fishTurn?.through ?? 'camera';
const far = FAR === 'back' ? Math.PI : -Math.PI;

// A CHASER IS FILMED BY MOVING THE SEAL; A DRIFTER HAS TO BE STEERED. The
// barracuda reverses because the thing it wants moved, which is the honest way
// to film it. The sea turtle does not know the seal exists — its wander picks
// headings at random and cannot be asked for a reversal — so its velocity is
// scripted and `turnFish` is driven directly, which is the same code path the
// game calls one frame later. The pitch is read back from wherever this
// creature keeps it: a body owns `rotation.z` (see writeBack), so on the
// turtle the come-about's pitch lives in `body.restAngle`.
const steered = def.behavior === 'drift';
const orig = Math.random;
Math.random = seeded(4);
resetEnemies(scene);
const e = spawnNamed(scene, id, 0, { x: -10, y: MID }, { ignoreCaps: true });
if (!e) throw new Error(`could not spawn ${id}`);
const player = new THREE.Vector3(20, MID, 0);
const trace = [];
for (let i = 0; i < 60 * 12; i++) {
  const t = i * dt;
  if (steered) {
    // Cruising right, then hard left at the three-second mark: the same one
    // clean reversal the seal's move asks a chaser for.
    e.vx = (t < 3 ? 1 : -1) * (def.speed ?? 1.6);
    e.vy = Math.sin(t * 0.7) * 0.4;
    turnFish(e, dt, false);
  } else {
    // Park the seal on the right until the fish is committed to it, then move it
    // to the left: one clean, unambiguous reversal to film.
    if (i === 60 * 3) player.set(-20, MID, 0);
    updateEnemies(dt, scene, player, () => {}, () => {});
    if (!enemies.includes(e)) break;
  }
  trace.push({
    t,
    yaw: e.mesh.rotation.y,
    pitch: e.body ? e.body.restAngle : e.mesh.rotation.z,
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
const moving = (f) => (far < 0
  ? (f.yaw < -1e-3 && f.yaw > far + 1e-3)
  : (f.yaw > 1e-3 && f.yaw < far - 1e-3));
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

const through = far < 0 ? 'through the camera' : 'round the back';
rows.push(label(PAD + 12, `${id} — now: the nose comes ${through}`, '90, 190, 235'));
picks.forEach((f, i) => {
  const m = compose('YXZ', 0, f.yaw, f.pitch, f.bank);
  rows.push(cell(m, PAD + FRAME * i + FRAME / 2, PAD + 22 + FRAME / 2, '90, 190, 235', parts));
});

rows.push(label(PAD + FRAME + 46, `${id} — before: it loops nose-up and barrel-rolls`, '235, 140, 110'));
picks.forEach((f, i) => {
  const j = trace.indexOf(f);
  const l = legacy[j];
  const m = compose('XYZ', 0, 0, l.heading, l.roll);
  rows.push(cell(m, PAD + FRAME * i + FRAME / 2, PAD + FRAME + 56 + FRAME / 2, '235, 140, 110', parts));
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  + `<rect width="${W}" height="${H}" fill="#0d1519"/>`
  + rows.join('')
  + '</svg>';

writeFileSync(out, svg);
console.log(`${out} — ${N} frames of ${(picks[N - 1].t - picks[0].t).toFixed(2)}s, ${id}`);
