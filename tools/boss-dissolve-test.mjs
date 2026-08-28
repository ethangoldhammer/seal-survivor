#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:dissolve
//
// THE BODY COMING APART INTO ITS OWN COLOURS — systems/bossDissolve.js.
//
// On the frame systems/bossCorpse.js hands the visual back to the pool, the
// boss is replaced by a cloud of its own vertices. Every way this can be wrong
// draws a perfectly good cloud of particles:
//
//   THE BIND POSE       The mesh is skinned and has been folding since it died.
//                       Sampled without applyBoneTransform every boss dissolves
//                       in its T-pose, which on a fish is a straight rigid body
//                       and looks like a deliberate style.
//
//   A FRAME LATE        three only refreshes world matrices during a render, so
//                       a body sampled without updateWorldMatrix reports every
//                       vertex where it was one frame ago — or, worse, at the
//                       origin. This is the trap the skinning harnesses
//                       document and it fails identically here.
//
//   ONE LINE TOO LATE   The call sits BEFORE releaseVisual in burst(). One line
//                       after it, the body has gone back to the pool and been
//                       reset, and the cloud is a different animal's shape.
//
//   THE OUTLINE SHELL   A back-faced copy of the whole body in one flat rim
//                       colour. Sampled, it doubles every point and paints half
//                       the cloud the same near-black.
//
//   A FLAT SHOVE        `push` is per unit of DISTANCE from the middle, so the
//                       outer edge drifts and the centre stays. A flat speed
//                       slides the cloud outward as a shell of constant
//                       thickness — the stencil this exists to soften, bigger.
//
//   INVISIBLE POINTS    The colours are the animal's own and the roster is
//                       near-black hides; without the peak-channel floor a
//                       whole boss dissolves into particles nobody can see.
//
//   THINNED AWAY        CONFIG.fx.spriteDensity thins every sprite burst in the
//                       game. Applied here it punches holes in a silhouette
//                       rather than making a burst sparser, which is why
//                       emitCloud is exempt from it — asserted, because the
//                       exemption is one line and reads like an omission.
//
// THE TEXTURE SAMPLING IS NOT REACHABLE FROM HERE and that is stated rather
// than faked: it needs a 2D canvas and Node has none, so `sampleTexture`
// answers false and every point falls through to the palette. What that gates —
// the fallback existing at all, and the material colour still being applied —
// is reachable and is checked. The texels themselves are looked at on the
// sheet: npm run looks:boom has a dissolve panel per boss.
//
//   node --import ./tools/vite-loader.mjs tools/boss-dissolve-test.mjs
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import {
  spawnBossDissolve, bossDissolveCloud, bossDissolveCount, resetBossDissolve,
} from '../path/src/systems/bossDissolve.js';

const scene = new THREE.Scene();
initParticles(scene);
const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;

let failures = 0;
const section = (t) => console.log(`\n${t}`);
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const D = CONFIG.boss.dissolve;
const EM = CONFIG.emitters.bossDissolve;

// A body of plain meshes, sized by VERTEX count rather than by triangles —
// which is what the sampler walks, and the number every count assertion below
// is against. A grid of `segs` has (segs+1)^2 of them.
function slab(w, h, verts = 400, mat = null) {
  const segs = Math.max(1, Math.ceil(Math.sqrt(verts)) - 1);
  const g = new THREE.PlaneGeometry(w, h, segs, segs);
  return new THREE.Mesh(g, mat ?? new THREE.MeshStandardMaterial({ color: 0x884422 }));
}

// Comfortably more vertices than the cloud asks for, so the count assertions
// are about the target and not about a body too small to fill it.
const DENSE = Math.round((CONFIG.boss.dissolve.points ?? 1400) * 2);

function body(parts, extra = {}) {
  const root = new THREE.Group();
  for (const p of parts) root.add(p);
  root.updateMatrixWorld(true);
  return { visual: root, mesh: root, assetKey: '__none__', vx: 0, vy: 0, ...extra };
}

// A REAL SKINNED MESH, posed away from its bind pose. The one thing a plane
// cannot test, and the branch the whole effect turns on: without
// applyBoneTransform these vertices report their bind positions and the cloud
// is the shape of an animal that is not there.
function skinnedBody(shift = 8) {
  const g = new THREE.PlaneGeometry(4, 2, 8, 8);
  const n = g.attributes.position.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = 0; sw[i * 4] = 1; }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const bone = new THREE.Bone();
  const skeleton = new THREE.Skeleton([bone]);
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ color: 0x66aa88 }));
  mesh.add(bone);
  mesh.bind(skeleton);
  // The pose: the one bone walks sideways, so every vertex should follow it.
  bone.position.x = shift;
  const root = new THREE.Group();
  root.add(mesh);
  root.updateMatrixWorld(true);
  skeleton.update();
  return { visual: root, mesh: root, assetKey: '__none__', vx: 0, vy: 0 };
}

const live = () => {
  let n = 0;
  for (let i = 0; i < attrs.aStart.count; i++) if (attrs.aStart.array[i] > -1e8) n++;
  return n;
};

console.log('\nthe body coming apart\n');

// --- IT FIRES ---------------------------------------------------------------
section('it fires');
{
  resetParticles();
  resetBossDissolve();
  const n = spawnBossDissolve(body([slab(20, 6, DENSE)]));
  check('a body becomes a cloud', n > 0, `${n} points`);
  check('...as many as asked for', n === Math.round(D.points ?? 1400),
    `${n} vs CONFIG.boss.dissolve.points ${D.points}`);
  check('...and they reached the buffer', live() >= n, `${live()} live particles`);
}
{
  check('nothing to sample is nothing fired', spawnBossDissolve({}) === 0);
  check('...and no creature at all', spawnBossDissolve(null) === 0);
}
{
  // A BODY WITH FAR FEWER VERTICES THAN THE TARGET, which the points are drawn
  // from TRIANGLES rather than from vertices makes a non-question: a four-vertex
  // body has as many distinct barycentric points in it as anyone wants. It is
  // still worth asserting, because the vertex build could not do this — it ran
  // off the end of the array and clamped, stacking eleven hundred particles on
  // one corner with the count exactly right and nothing thrown.
  resetParticles();
  resetBossDissolve();
  const n = spawnBossDissolve(body([slab(4, 2, 4)]));
  check('a low-poly body still fills the cloud', n === Math.round(D.points ?? 1400),
    `${n} points from a four-vertex body`);
  const c = bossDissolveCloud();
  const seen = new Map();
  let worst = 0;
  for (let i = 0; i < c.count; i++) {
    const k = `${c.x[i].toFixed(3)},${c.y[i].toFixed(3)}`;
    const hits = (seen.get(k) ?? 0) + 1;
    seen.set(k, hits);
    worst = Math.max(worst, hits);
  }
  check('...spread over its surface, not stacked on its corners', worst <= 2,
    `${worst} points share one position out of ${c.count}`);
}

{
  // IT HAS TO FILL THE BODY, and the build this replaced did not: walking the
  // vertex array with a regular stride sampled a structured list with a comb,
  // and a rigged fish's vertices are ordered in rings — so every eleventh one
  // traced a helix and the cloud came out as a neat strand winding down the
  // animal. It looked deliberate, which is the worst kind of wrong.
  //
  // Checked as OCCUPANCY over a grid across the body's own extent: a strand
  // fills a few percent of it and a surface fills most of it.
  resetParticles();
  resetBossDissolve();
  spawnBossDissolve(body([slab(24, 8, DENSE)]));
  const c = bossDissolveCloud();
  const G = 24;
  const cells = new Set();
  let lo = Infinity;
  let hi = -Infinity;
  let loY = Infinity;
  let hiY = -Infinity;
  for (let i = 0; i < c.count; i++) {
    lo = Math.min(lo, c.x[i]); hi = Math.max(hi, c.x[i]);
    loY = Math.min(loY, c.y[i]); hiY = Math.max(hiY, c.y[i]);
  }
  for (let i = 0; i < c.count; i++) {
    const gx = Math.min(G - 1, Math.floor(((c.x[i] - lo) / (hi - lo || 1)) * G));
    const gy = Math.min(G - 1, Math.floor(((c.y[i] - loY) / (hiY - loY || 1)) * G));
    cells.add(gy * G + gx);
  }
  const filled = cells.size / (G * G);
  check('the cloud fills the body rather than tracing a line', filled > 0.7,
    `${(filled * 100).toFixed(0)}% of the body's own bounding grid has a point in it — `
    + 'a stride over the vertex array gives about a tenth of this, in a helix');
}

// --- THE POSE ---------------------------------------------------------------
section('the pose, not the bind');
{
  resetParticles();
  resetBossDissolve();
  const shift = 8;
  spawnBossDissolve(skinnedBody(shift));
  const c = bossDissolveCloud();
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < c.count; i++) { minX = Math.min(minX, c.x[i]); maxX = Math.max(maxX, c.x[i]); }
  // The plane is 4 across and its one bone has walked 8 to the right, so a
  // correctly skinned cloud sits around x = 8 and a bind-pose one sits around 0.
  const mid = (minX + maxX) / 2;
  check('the cloud follows the skeleton', Math.abs(mid - shift) < 1,
    `centred at ${mid.toFixed(2)}, expected about ${shift} — at 0 the vertices were read `
    + 'straight off the geometry and every boss dissolves in its T-pose');
}
{
  // ...and the mesh's own world matrix on top of it. A rig sitting at the
  // origin hides this completely: the two failures are only separable on a
  // body that has moved.
  resetParticles();
  resetBossDissolve();
  const e = body([slab(6, 3, 200)]);
  e.visual.position.set(-14, 5, 0);
  e.visual.updateMatrixWorld(true);
  spawnBossDissolve(e);
  const c = bossDissolveCloud();
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < c.count; i++) { sx += c.x[i]; sy += c.y[i]; }
  check('...and the body\'s own place in the world',
    Math.abs(sx / c.count + 14) < 0.5 && Math.abs(sy / c.count - 5) < 0.5,
    `centred at ${(sx / c.count).toFixed(2)}, ${(sy / c.count).toFixed(2)}`);
}

// --- THE OUTLINE ------------------------------------------------------------
section('the outline shell');
{
  const shellMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  shellMat.userData.__isOutline = true;
  resetParticles();
  resetBossDissolve();
  const e = body([slab(10, 4, 400), slab(10, 4, 400, shellMat)]);
  spawnBossDissolve(e);
  const c = bossDissolveCloud();
  let black = 0;
  for (let i = 0; i < c.count; i++) {
    if (c.r[i] < 0.05 && c.g[i] < 0.05 && c.b[i] < 0.05) black++;
  }
  check('the shell is not sampled', black === 0,
    `${black}/${c.count} points came off the rim copy — it is a back-faced duplicate of the `
    + 'whole body in one flat colour, so it doubles every point and paints half the cloud');
}

// --- THE MOTION -------------------------------------------------------------
section('a whisper, not a shove');
{
  resetParticles();
  resetBossDissolve();
  spawnBossDissolve(body([slab(30, 8, DENSE)]));
  const c = bossDissolveCloud();
  // Per unit of DISTANCE: the outer points move and the middle does not. A flat
  // speed gives every point the same magnitude, which is the shell that keeps
  // the stencil.
  let nearSpeed = 0;
  let nearN = 0;
  let farSpeed = 0;
  let farN = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < c.count; i++) { cx += c.x[i]; cy += c.y[i]; }
  cx /= c.count; cy /= c.count;
  for (let i = 0; i < c.count; i++) {
    const d = Math.hypot(c.x[i] - cx, c.y[i] - cy);
    const v = Math.hypot(c.vx[i], c.vy[i]);
    if (d < 3) { nearSpeed += v; nearN++; } else if (d > 12) { farSpeed += v; farN++; }
  }
  const near = nearN ? nearSpeed / nearN : 0;
  const far = farN ? farSpeed / farN : 0;
  check('the edge drifts and the middle stays', farN > 0 && nearN > 0 && far > near * 3,
    `${near.toFixed(2)} near the centre vs ${far.toFixed(2)} at the edge`);

  // AND IT IS SMALL, MEASURED AGAINST THE BODY. This is a body letting go, not
  // the explosion — which already happened half a second earlier and threw its
  // cloud a body and a half clear of the outline.
  //
  // AS DISPLACEMENT, NOT AS SPEED. The closed form under linear drag is total
  // travel = v / drag, and a speed on its own says nothing about a particle in
  // water: at the emitter's drag of 7.5 a launch speed that looks violent
  // beside the explosion's covers less than half the distance.
  //
  // And relative to the animal rather than to the other effect, because that is
  // the claim being made — the silhouette should LOOSEN, by enough to see and
  // nowhere near enough to stop being the animal's shape.
  const k = Array.isArray(EM.drag) ? EM.drag[0] : EM.drag;
  const travel = far / k;
  let reach = 0;
  for (let i = 0; i < c.count; i++) {
    reach = Math.max(reach, Math.hypot(c.x[i] - cx, c.y[i] - cy));
  }
  check('the silhouette opens', travel > reach * 0.08,
    `${travel.toFixed(2)} units of travel on a body reaching ${reach.toFixed(1)} — under a `
    + 'tenth it is a stencil that dims rather than a body letting go, which is what the '
    + 'first pass shipped as');
  check('...and is still the animal\'s shape', travel < reach * 0.4,
    `${travel.toFixed(2)} against ${reach.toFixed(1)} — past about a third the cloud has `
    + 'stopped being a silhouette and is a second explosion');
}
{
  // The drag has to actually stop them, or "tons of drag" is a comment. The
  // closed form is displacement = v/k, so the whole cloud's total travel is
  // bounded by the fastest point over the emitter's drag.
  const k = Array.isArray(EM.drag) ? EM.drag[0] : EM.drag;
  check('the drag stops them quickly', k >= 5,
    `drag ${k} — at the explosion's 2.0 the points are still visibly travelling when the `
    + 'cloud is meant to be hanging still');
  const life = Array.isArray(EM.life) ? EM.life[0] : EM.life;
  check('...and they take a few seconds to go', life >= 1.5,
    `life ${life}s — the vertex shader's own ramp is what shrinks them, so this IS the `
    + '"scales off over a few seconds"');
}

// --- THE COLOURS ------------------------------------------------------------
section('the colours');
{
  resetParticles();
  resetBossDissolve();
  spawnBossDissolve(body([slab(10, 4, 600,
    new THREE.MeshStandardMaterial({ color: 0x0d1016 }))]));
  const c = bossDissolveCloud();
  let dark = 0;
  for (let i = 0; i < c.count; i++) {
    if (Math.max(c.r[i], c.g[i], c.b[i]) < (D.minPeak ?? 0.22) - 1e-6) dark++;
  }
  check('no point is too dark to see', dark === 0,
    `${dark}/${c.count} under the peak floor of ${D.minPeak} — the roster is near-black hides `
    + 'and the composite drops them a stop and a half further');
  // ...and the lift KEEPS THE HUE. Scaling toward white instead would give
  // every boss the same grey cloud, which is what sampling per vertex exists to
  // avoid.
  const hue = new THREE.Color(0x0d1016);
  const h0 = {};
  hue.getHSL(h0, THREE.SRGBColorSpace);
  const lifted = new THREE.Color(c.r[0], c.g[0], c.b[0]);
  const h1 = {};
  lifted.getHSL(h1, THREE.SRGBColorSpace);
  check('...and the lift keeps its hue', Math.abs(h1.h - h0.h) < 0.02,
    `${h0.h.toFixed(3)} -> ${h1.h.toFixed(3)}`);
}
{
  // A body with two materials gives a cloud with two colours, in proportion to
  // how many vertices wear each. One tint for the whole animal is the thing
  // this replaces.
  resetParticles();
  resetBossDissolve();
  spawnBossDissolve(body([
    slab(10, 4, 800, new THREE.MeshStandardMaterial({ color: 0xcc4422 })),
    slab(10, 4, 800, new THREE.MeshStandardMaterial({ color: 0x2244cc })),
  ]));
  const c = bossDissolveCloud();
  let warm = 0;
  let cool = 0;
  for (let i = 0; i < c.count; i++) { if (c.r[i] > c.b[i]) warm++; else cool++; }
  check('a two-tone body gives a two-tone cloud', warm > 50 && cool > 50,
    `${warm} warm, ${cool} cool`);
}

// --- THE BUDGET -------------------------------------------------------------
section('the budget');
{
  // NOT THINNED. CONFIG.fx.spriteDensity thins every sprite burst in the game;
  // applied to a cloud whose points are a body's vertices it punches holes in
  // the silhouette rather than making the burst sparser. The exemption is one
  // line in emitCloud and reads exactly like an omission.
  const was = CONFIG.fx.spriteDensity;
  CONFIG.fx.spriteDensity = 0.25;
  resetParticles();
  resetBossDissolve();
  const n = spawnBossDissolve(body([slab(20, 6, DENSE)]));
  CONFIG.fx.spriteDensity = was;
  check('the cloud is not thinned with the sprite bursts',
    n === Math.round(D.points ?? 1400),
    `${n} at spriteDensity 0.25 — thinning a silhouette is holes, not sparseness`);
}
{
  check('it fits in the pool', (D.points ?? 1400) < (CONFIG.fx.maxParticles ?? 8000) / 2,
    `${D.points} of ${CONFIG.fx.maxParticles} — past about half, one boss death evicts `
    + 'every other effect in the water');
}
{
  // NOT GOO. The goo pass thresholds its group into one fused body with one
  // blended colour, which would take a thousand points each carrying the colour
  // of the skin it came off and average them into a single silhouette.
  check('the points are sprites, not goo', EM.goo == null,
    `goo "${EM.goo}" — the placement is the whole effect and goo would weld it into one mass`);
}

// --- IT ENDS ----------------------------------------------------------------
section('it ends');
{
  resetParticles();
  resetBossDissolve();
  spawnBossDissolve(body([slab(10, 4, 600)]));
  const before = live();
  const life = (Array.isArray(EM.life) ? EM.life[1] : EM.life) + 0.5;
  for (let t = 0; t < life; t += 1 / 60) updateParticles(1 / 60);
  check('the cloud is a one-time burst', before > 0 && bossDissolveCount() > 0,
    'nothing re-emits — this fires once, from burst()');
  resetBossDissolve();
  check('a reset drops the bookkeeping', bossDissolveCount() === 0);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
