#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:net
//
// The spring net hanging off Bakalar's boat (systems/bakalarNet.js). Every
// failure mode here is silent in a screenshot and invisible in the browser
// preview, which suspends requestAnimationFrame and therefore never steps the
// sim at all — so this is the only place the twine is ever actually run.
//
// The four that matter, and why each one looks fine until you measure it:
//
//   THE WEAVE COMES APART. The drawn twine is the two diagonal families of the
//   node lattice, and a lattice sprung ONLY on its diagonals is two
//   independent checkerboards that share no constraint. They drift through
//   each other and the net becomes two meshes flickering past one another —
//   which at a glance is a busy net. Measured here as the spread of a row that
//   should stay a row.
//
//   THE MESH COLLAPSES. Stretch-only constraints plus gravity, with nothing
//   holding the net open, ends with every node in a heap at the bottom of the
//   perimeter. It happens over a few seconds, so the first frames look right.
//
//   THE TWINE STRETCHES. A solver with too few passes lets a heavy catch drag
//   nodes past their rest length and keep going. A net whose cells grow is a
//   net a fish can swim out of, and the picture stops matching the catch test.
//
//   THE POCKET GOES THE WRONG WAY. A load is supposed to push the mesh AWAY
//   from itself and hang it downward. Get the sign wrong on either half and
//   the net sucks onto the fish, which reads as a shrink-wrap rather than a
//   catch — and the total displacement, which is what a naive test measures,
//   is identical either way.
//
// No GL, no renderer: the sim is plain arithmetic over Float32Arrays, and the
// only three.js in the module is the LineSegments it uploads into.
//
//   node --import ./tools/vite-loader.mjs tools/bakalar-net-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  createBakalarNet, updateBakalarNet, setBakalarNetVisible, seatBakalarNet,
  kickBakalarNet, disposeBakalarNet, __netState, __netShader,
} from '../path/src/systems/bakalarNet.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function check(label, ok, detail = '') {
  if (!ok) failures++;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

// The frame the net hangs in. Roughly a level-3 net: 11 across, 12 deep.
const FRAME = { centerX: 0, top: 0, halfWidth: 5.5, depth: 12 };

function fresh() {
  disposeBakalarNet(scene);
  createBakalarNet(scene);
  setBakalarNetVisible(true);
  seatBakalarNet(FRAME.centerX, FRAME.top, FRAME.halfWidth, FRAME.depth);
  return __netState();
}

function step(seconds, loads = [], count = loads.length) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) updateBakalarNet(dt, FRAME, loads, count);
}

// The longest drawn strand in the mesh, as a multiple of what it should be.
// Reads the INDEX buffer rather than re-deriving the pairs, so a rebuild that
// changes the weave cannot leave this measuring strands that are not there.
function worstStretch(state) {
  const geo = scene.children.find((o) => o.isLineSegments)?.geometry;
  const index = geo.getIndex().array;
  const { cur } = state;
  const hx = (FRAME.halfWidth * 2) / (state.cols - 1);
  const hy = FRAME.depth / (state.rows - 1);
  const diag = Math.hypot(hx, hy);
  let worst = 0;
  for (let k = 0; k < index.length; k += 2) {
    const a = index[k], b = index[k + 1];
    const d = Math.hypot(cur[a * 2] - cur[b * 2], cur[a * 2 + 1] - cur[b * 2 + 1]);
    // A drawn strand is a diagonal, a horizontal rope or a vertical rope, and
    // the index buffer does not say which. Measured against whichever it is
    // CLOSEST to: a strand torn to twice its length would otherwise be scored
    // against the longest candidate and read as barely stretched.
    worst = Math.max(worst, d / nearestRest(d, hx, hy, diag));
  }
  return worst;
}
function nearestRest(d, hx, hy, diag) {
  let best = hx, err = Math.abs(d - hx);
  for (const cand of [hy, diag]) {
    const e = Math.abs(d - cand);
    if (e < err) { err = e; best = cand; }
  }
  return best;
}

// ---------------------------------------------------------------------------
section('THE LATTICE');
{
  const s = fresh();
  check('the net is built with the configured column count',
    s.cols === Math.round(CONFIG.bakalar.net.cols), `${s.cols} x ${s.rows}`);

  // ROWS FOLLOW DEPTH. Levelling buys depth and not width, so a fixed row
  // count stretches the diamonds taller with every stack — and past about 2:1
  // the diagonal springs run near-vertical, nothing resists a sideways fold,
  // and the net pinches to an hourglass at its waist. It renders as a physics
  // blow-up, which is the kind of thing you retune the SPRINGS to chase.
  const cellW = (FRAME.halfWidth * 2) / (s.cols - 1);
  const cellH = FRAME.depth / (s.rows - 1);
  check('the cells come out roughly square at this depth',
    cellH / cellW < 1.6, `${cellW.toFixed(2)} across by ${cellH.toFixed(2)} down`);

  // TIGHTER THAN THE BACKDROP is the whole brief, and it is a relationship
  // between two configs rather than a number either one owns. A tuner move
  // that quietly makes the net coarser than the arena it hangs in is exactly
  // the regression a screenshot would not catch.
  const cell = (FRAME.halfWidth * 2) / (s.cols - 1);
  check('the weave is tighter than the backdrop grid', cell < CONFIG.grid.spacing,
    `${cell.toFixed(2)} per cell vs the arena's ${CONFIG.grid.spacing}`);

  check('the headline is pinned and nothing else is',
    [...s.pinned].filter(Boolean).length === s.cols,
    `${[...s.pinned].filter(Boolean).length} pinned of ${s.cols * s.rows}`);

  // Every node has to be reachable from the pinned row through some chain of
  // springs, or a corner of the net falls off on its own and keeps falling.
  const adj = new Map();
  for (let i = 0; i < s.springs.length; i += 3) {
    const a = s.springs[i], b = s.springs[i + 1];
    (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)).push(a);
  }
  const seen = new Set();
  const queue = [];
  for (let n = 0; n < s.cols * s.rows; n++) if (s.pinned[n]) { queue.push(n); seen.add(n); }
  while (queue.length) for (const nb of adj.get(queue.pop()) ?? []) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  check('every node is sprung back to the hull, directly or through the mesh',
    seen.size === s.cols * s.rows, `${seen.size} of ${s.cols * s.rows} reachable`);
}

// ---------------------------------------------------------------------------
section('A DEEP NET');
{
  // The full-stack shape: the same 8-unit mouth, three times the reach. This
  // is the one the fixed row count broke, and it broke in a way every check in
  // HANGING EMPTY below still passed — the net spanned its width, hung under
  // its headline and stayed finite while its middle folded through itself.
  const deep = { centerX: 0, top: 0, halfWidth: 4.14, depth: 34.8 };
  disposeBakalarNet(scene);
  createBakalarNet(scene);
  setBakalarNetVisible(true);
  seatBakalarNet(deep.centerX, deep.top, deep.halfWidth, deep.depth);
  const s = __netState();
  for (let i = 0; i < 60 * 4; i++) updateBakalarNet(dt, deep, [], 0);

  const cellW = (deep.halfWidth * 2) / (s.cols - 1);
  const cellH = deep.depth / (s.rows - 1);
  check('a full-stack net still weaves in roughly square cells',
    cellH / cellW < 1.6, `${s.cols}x${s.rows}, ${cellW.toFixed(2)} by ${cellH.toFixed(2)}`);

  // THE WAIST. A pinch is the two sides of one row meeting in the middle, so
  // it shows as a row far narrower than the mouth. Measured on the widest and
  // narrowest rows rather than on the bounding box, which a pinched net fills
  // exactly as well as a good one.
  let narrowest = Infinity;
  for (let j = 1; j < s.rows; j++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < s.cols; i++) {
      const x = s.cur[(j * s.cols + i) * 2];
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    narrowest = Math.min(narrowest, hi - lo);
  }
  check('...and does not pinch shut at its waist',
    narrowest > deep.halfWidth * 2 * 0.6,
    `narrowest row ${narrowest.toFixed(2)} of a ${(deep.halfWidth * 2).toFixed(2)} mouth`);
}

// ---------------------------------------------------------------------------
section('HANGING EMPTY');
{
  const s = fresh();
  step(4);

  // THE COLLAPSE. Compared against the seated rectangle, because "it moved a
  // bit" is correct and "it fell into a heap" is not, and only the second one
  // has the net's own footprint shrinking.
  const xs = [], ys = [];
  for (let n = 0; n < s.cols * s.rows; n++) { xs.push(s.cur[n * 2]); ys.push(s.cur[n * 2 + 1]); }
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  check('an empty net still spans its own width after 4 seconds',
    width > FRAME.halfWidth * 2 * 0.85, `${width.toFixed(2)} of ${(FRAME.halfWidth * 2).toFixed(2)}`);
  // ...and does not BALLOON either. The side ropes belly outward with the
  // slack, which is correct, but the catch test in bakalar.js is the nominal
  // rectangle — twine drawn far outside it visibly holds fish the boat is not
  // catching, which is the one way this mesh can lie about the gameplay.
  check('...without ballooning past the volume it actually catches in',
    width < FRAME.halfWidth * 2 * 1.25, `${width.toFixed(2)} of ${(FRAME.halfWidth * 2).toFixed(2)}`);
  check('...and its own depth', height > FRAME.depth * 0.8,
    `${height.toFixed(2)} of ${FRAME.depth}`);

  // THE WEAVE COMING APART. Row 4 was seated at one y; if the two diagonal
  // sub-lattices have decoupled, its even and odd nodes are at two different
  // ones and the spread is large while every other measure here still passes.
  const row = 4;
  let evenY = 0, oddY = 0, evenN = 0, oddN = 0;
  for (let i = 0; i < s.cols; i++) {
    const y = s.cur[(row * s.cols + i) * 2 + 1];
    if (i % 2) { oddY += y; oddN++; } else { evenY += y; evenN++; }
  }
  const split = Math.abs(evenY / evenN - oddY / oddN);
  const cellDown = FRAME.depth / (s.rows - 1);
  check('the two diagonal weaves have not drifted apart', split < cellDown * 0.5,
    `${split.toFixed(3)} between them, one cell is ${cellDown.toFixed(2)}`);

  check('the net does not hang above its own headline',
    Math.max(...ys) <= FRAME.top + 1e-4, `top node at ${Math.max(...ys).toFixed(4)}`);

  check('no node has gone non-finite', ys.every(Number.isFinite) && xs.every(Number.isFinite));

  // THE RIGID-SHELL REGRESSION, and the only check here that catches it.
  //
  // Constraints are stretch-limited, so a strand already AT its limit cannot
  // give any further — and an empty net whose strands are all taut is a net
  // nothing can deform, however hard the catch pushes. That is exactly what a
  // symmetric spring lattice produces: it inflates itself to full extension
  // and parks there. Every other measure in this file still passes when it
  // happens (the net spans its width, the weaves are together, it hangs below
  // the headline), and the pocket quietly shrinks to a tenth of a unit.
  const hx = (FRAME.halfWidth * 2) / (s.cols - 1);
  const hy = FRAME.depth / (s.rows - 1);
  const diag = Math.hypot(hx, hy);
  const geo = scene.children.find((o) => o.isLineSegments).geometry;
  const index = geo.getIndex().array;
  let taut = 0, strands = 0;
  for (let k = 0; k < index.length; k += 2) {
    const a = index[k], b = index[k + 1];
    const d = Math.hypot(s.cur[a * 2] - s.cur[b * 2], s.cur[a * 2 + 1] - s.cur[b * 2 + 1]);
    const want = nearestRest(d, hx, hy, diag) * CONFIG.bakalar.net.slack;
    strands++;
    if (d > want * 0.995) taut++;
  }
  check('an empty net keeps slack in hand, or nothing can deform it later',
    taut / strands < 0.5, `${taut} of ${strands} strands already taut at rest`);
}

// ---------------------------------------------------------------------------
section('A FISH IN IT');
{
  const s = fresh();
  const load = { x: 0, y: FRAME.top - FRAME.depth * 0.5, mass: 1.6 };
  // A control run of the SAME length with nothing in the net, because the net
  // drapes on its own and a displacement measured from the seated rectangle
  // would count the drape as the pocket. See the same trap in the shove tests.
  step(2.5);
  const drape = [...s.cur];

  const t = fresh();
  step(2.5, [load]);

  // THE POCKET, and its DIRECTION. Nodes near the fish must end up further
  // from it than the empty net left them — the sign check the total
  // displacement cannot make.
  let pushedOut = 0, pulledIn = 0, near = 0;
  for (let n = 0; n < t.cols * t.rows; n++) {
    const d0 = Math.hypot(drape[n * 2] - load.x, drape[n * 2 + 1] - load.y);
    if (d0 > load.mass * CONFIG.bakalar.net.catchReach) continue;
    near++;
    const d1 = Math.hypot(t.cur[n * 2] - load.x, t.cur[n * 2 + 1] - load.y);
    if (d1 > d0 + 1e-4) pushedOut++; else if (d1 < d0 - 1e-4) pulledIn++;
  }
  check('the catch pushes the mesh away from itself, not onto it',
    near > 0 && pushedOut > pulledIn, `${pushedOut} out vs ${pulledIn} in, of ${near} nearby`);

  // THE HANG. The pocket has to sit UNDER the fish, or the net reads as a
  // halo. Measured on the mesh directly below it.
  const col = Math.floor(t.cols / 2);
  let sagged = 0;
  for (let j = 1; j < t.rows - 1; j++) {
    const n = j * t.cols + col;
    if (t.cur[n * 2 + 1] < drape[n * 2 + 1] - 1e-3) sagged++;
  }
  check('...and hangs the column below it lower than an empty net does',
    sagged >= (t.rows - 2) * 0.5, `${sagged} of ${t.rows - 2} nodes lower`);

  // THE STRETCH. Slack is a multiplier on the rest length and the solver is
  // allowed to leave a little error; anything past a third over is a cell a
  // fish swims through.
  const stretch = worstStretch(t);
  check('no strand is stretched past a third over its rest length',
    stretch < 1.34, `worst strand ${stretch.toFixed(2)}x`);

  // AND IT HAS TO BE BIG ENOUGH TO SEE. "Deeper than the empty net" is true of
  // a pocket one hundredth of a unit deep, and that is the shape every failure
  // in this system takes — the sim runs, the signs are right, and the mesh
  // moves by less than a line width. Measured against the CELL, because a
  // pocket has to be visible relative to the weave it is deforming.
  let deepest = 0;
  for (let n = 0; n < t.cols * t.rows; n++) {
    deepest = Math.max(deepest, Math.hypot(t.cur[n * 2] - drape[n * 2], t.cur[n * 2 + 1] - drape[n * 2 + 1]));
  }
  const cellDown = FRAME.depth / (t.rows - 1);
  check('...and the pocket is at least half a cell deep', deepest > cellDown * 0.5,
    `${deepest.toFixed(2)} against a ${cellDown.toFixed(2)} cell`);
}

// ---------------------------------------------------------------------------
section('THE BOMB GOING OFF IN IT');
{
  const t = fresh();
  step(1.5);
  const before = [...t.cur];

  const bx = 0, by = FRAME.top - FRAME.depth * 0.5;
  kickBakalarNet(bx, by, CONFIG.bakalar.net.blastKick, 5);

  // THE PEAK, tracked across the punch rather than sampled at one frame.
  //
  // This read the displacement two frames in, which is not when a punch is
  // biggest: the kick is a velocity impulse and the constraint solver spreads
  // it outward a few cells per substep, so the mesh is still opening for a
  // sixth of a second. Worse, the frame it peaks on MOVES — the row count
  // follows the net's depth now, so a deeper net has coarser cells and a
  // slower wave, and a fixed sample frame quietly measures a different part of
  // the curve at every stack.
  let punched = 0;
  let moved = 0;
  for (let f = 0; f < 16; f++) {
    step(1 / 60);
    let n0 = 0;
    for (let n = 0; n < t.cols * t.rows; n++) {
      const d = Math.hypot(t.cur[n * 2] - before[n * 2], t.cur[n * 2 + 1] - before[n * 2 + 1]);
      punched = Math.max(punched, d);
      if (d > 1e-3) n0++;
    }
    moved = Math.max(moved, n0);
  }
  check('the blast punches a hole in the twine', moved > 0, `${moved} nodes moved`);

  // ...BY A VISIBLE AMOUNT. Same trap as the pocket: a kick that gets eaten by
  // the solver still moves every node by a rounding error and passes the count
  // above. Half a cell is the floor for something that is meant to read as a
  // bomb going off inside the net.
  const cell = FRAME.depth / (t.rows - 1);
  check('...by at least half a cell', punched > cell * 0.5,
    `${punched.toFixed(2)} against a ${cell.toFixed(2)} cell`);

  // ...AND IT SPRINGS BACK. A kick that leaves the net permanently deformed is
  // a net that ends the sailing as a rag, and it takes several blasts before
  // anyone notices it never recovered.
  //
  // Measured against the DRAPE the net was hanging in before the kick, not
  // against the seated rectangle. An empty net rests a full unit off its rest
  // positions by design, which is larger than the punch: read from `rest` this
  // check compares a recovery to a drape and fails a net that recovered
  // perfectly.
  step(3);
  const settled = Math.max(...Array.from({ length: t.cols * t.rows }, (_, n) =>
    Math.hypot(t.cur[n * 2] - before[n * 2], t.cur[n * 2 + 1] - before[n * 2 + 1])));
  check('...and the mesh springs back afterwards', settled < punched * 0.35,
    `${punched.toFixed(3)} at the punch, ${settled.toFixed(3)} three seconds on`);
}

// ---------------------------------------------------------------------------
section('UNDER TOW');
{
  const t = fresh();
  // The boat sails: the headline moves and the mesh has to follow it without
  // either tearing off or snapping rigidly into place.
  const moving = { ...FRAME };
  for (let i = 0; i < 180; i++) {
    moving.centerX += 7 * dt;
    updateBakalarNet(dt, moving, [], 0);
  }
  const bottomRow = t.rows - 1;
  let lag = 0;
  for (let i = 0; i < t.cols; i++) {
    const n = bottomRow * t.cols + i;
    lag += t.rest[n * 2] - t.cur[n * 2];
  }
  lag /= t.cols;
  // A real trail, not a rounding error: leaving this to drag alone bought 0.016
  // units on an 11-unit net, which is a net that hangs off a rail rather than
  // one being towed through water. See CONFIG.bakalar.net.flow.
  check('the foot of the net streams behind the hull under tow',
    lag > FRAME.halfWidth * 0.08, `${lag.toFixed(2)} behind, on a ${FRAME.halfWidth * 2}-wide net`);
  check('...but stays attached to it', Math.abs(lag) < FRAME.depth,
    `${lag.toFixed(2)} against a ${FRAME.depth}-unit net`);

  const stretch = worstStretch(t);
  check('nothing has torn open at speed', stretch < 1.34, `worst strand ${stretch.toFixed(2)}x`);
}

// ---------------------------------------------------------------------------
section('THE SHADER PAIR');
{
  // Same contract as the beam's in ability-smoke: nothing in Node compiles
  // GLSL, so a uniform renamed on one side and not the other is a silently
  // black net that no headless test can see except by comparing the two
  // halves by name.
  const geo = scene.children.find((o) => o.isLineSegments);
  const declared = Object.keys(geo.material.uniforms);
  const src = __netShader.NET_VERT + __netShader.NET_FRAG;
  const unread = declared.filter((u) => !src.includes(u));
  check('every uniform the material declares is read by the shader',
    unread.length === 0, unread.length ? unread.join(', ') : `${declared.length} uniforms`);

  const used = [...__netShader.NET_FRAG.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]);
  const unsupplied = used.filter((u) => !declared.includes(u));
  check('...and every uniform the shader reads is supplied',
    unsupplied.length === 0, unsupplied.join(', '));

  // The warp attribute is the whole reason this looks like the arena's grid
  // rather than a wireframe, and it is the one wiring that fails by rendering
  // a perfectly good flat-coloured net.
  check('the warp attribute the vertex shader reads exists on the geometry',
    __netShader.NET_VERT.includes('aWarp') && !!geo.geometry.getAttribute('aWarp'));

  check('the twine is additive so the catch inside stays legible',
    geo.material.blending === THREE.AdditiveBlending && geo.material.depthWrite === false);
}

console.log(failures === 0
  ? '\n\x1b[32mnet: all checks passed\x1b[0m'
  : `\n\x1b[31mnet: ${failures} check(s) failed\x1b[0m`);
process.exit(failures ? 1 : 0);
