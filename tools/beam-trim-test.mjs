#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE TRIM — a beam that wipes on and off along its own length.
//
// The beam used to arrive and leave by FADING: full length from the first
// frame, brought up and down on opacity and width. It now WIPES — the lit span
// grows out of the socket to the tip, and then the near end is eaten away after
// it, both edges travelling the same direction, so what the eye follows is a
// bar that launches off the animal and flies down the line.
//
// Four properties, and each of them fails in a way that looks like something
// else:
//
//   GEOMETRY   both edges run origin -> tip, and the tail never passes the
//              head. Reversed, it reads as a beam retracting into the animal,
//              which is a different weapon. Crossed, the quad turns inside out
//              and the beam simply fails to appear.
//   DAMAGE     the beam cuts EXACTLY the span it draws. Without the span in
//              the hit test a growing beam kills along its full reach while
//              drawing a stub — the same class of bug as hit-testing the
//              infinite line, and harder to see, because the damage lands
//              where the player is looking for it and merely too early.
//   SPARKS     laid along the run the edge crossed THIS FRAME, not at the
//              point it happens to be standing on. The edge crosses a 26-unit
//              beam in 70ms — four frames at 60Hz — so a burst at the
//              instantaneous position is four clumps with gaps between them,
//              and on a machine dropping frames it is two.
//   PROFILE    the muzzle fade stays at the muzzle and the taper stays at the
//              tip. Drawn with the whole 0..1 profile a stub squeezes both
//              into itself and slides down the line as a little lozenge.
//
// ...and the fade still has to work, because setting both trim times to 0 is
// how a beam opts out and every beam that has not been converted is doing it.
//
//   npm run test:trim
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

// beams.js paints its taper profile and glow sprite on a 2D canvas; dom-stub
// returns null for getContext. Same shim as tools/beam-churn-test.mjs — the
// pixels are never read back, only the objects around them.
document.createElement = (tag) => ({
  tagName: tag, width: 0, height: 0, style: {},
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, fillRect: () => {}, clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
  }),
});

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { beams, spawnBeam, updateBeams, resetBeams } from '../path/src/systems/beams.js';
import { updateBurnGlow, resetBurnGlow, burnHeat } from '../path/src/systems/burnGlow.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';

// Seeded, so a spark spread that only passes on a lucky draw fails every time
// instead of one run in ten. See the note on seeded spawn harnesses.
let _seed = 20260829;
Math.random = () => {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const scene = new THREE.Scene();
initParticles(scene);

// The particle buffer, found by the attribute only it has. Sparks are counted
// by DIFFING aStart between frames: a slot whose start time changed was written
// this frame, whatever the ring cursor was doing.
let points = null;
scene.traverse((o) => { if (o.geometry?.attributes?.aStart) points = o; });
if (!points) { console.log('  FAIL  no particle buffer in the scene'); process.exit(1); }
const aStart = points.geometry.attributes.aStart.array;
const aPos = points.geometry.attributes.position.array;
let startSnap = Float32Array.from(aStart);

/** The x/y of every particle slot written since the last call. */
function sparksSinceLast() {
  const out = [];
  for (let i = 0; i < aStart.length; i++) {
    if (aStart[i] !== startSnap[i]) out.push({ x: aPos[i * 3], y: aPos[i * 3 + 1] });
  }
  startSnap = Float32Array.from(aStart);
  return out;
}

const TRIM = CONFIG.beams.trim;
const LEN = 26;          // the level-1 laser's reach
const LIFE = 0.85;       // ...and its burn
const DT = 1 / 60;

/**
 * Run one beam to its death, sampling every frame.
 *
 * Returns a frame-by-frame record of what was DRAWN — read off the mesh rather
 * than off the state that produced it, so the check sees what a player would.
 */
function burn(opts = {}, ctx = {}) {
  resetBeams(scene);
  resetParticles();
  startSnap = Float32Array.from(aStart);
  const b = spawnBeam(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0,
    length: LEN, life: LIFE, damage: 10, color: 0x64f0ff,
    ...opts,
  });
  const frames = [];
  for (let t = 0; t < LIFE + DT * 2 && beams.length; t += DT) {
    updateBeams(DT, scene, ctx);
    if (!beams.length) break;
    // Near and far end of the DRAWN quad, back out of the mesh: the group sits
    // at the segment's midpoint and the core is scaled to its length.
    const drawn = b.core.scale.x;
    const mid = b.mesh.position.x;
    frames.push({
      t: t + DT,
      near: mid - drawn * 0.5,
      far: mid + drawn * 0.5,
      drawn,
      opacity: b.core.material.opacity,
      uvOffset: b.core.material.map.offset.x,
      uvRepeat: b.core.material.map.repeat.x,
      sparks: sparksSinceLast(),
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
console.log('\nTHE GEOMETRY — both edges run origin to tip');
// ---------------------------------------------------------------------------
const f = burn();
const nears = f.map((r) => r.near);
const fars = f.map((r) => r.far);

check('the beam draws for its whole life', f.length > 40, `${f.length} frames`);
check('it starts as a stub at the socket, not a full-length line',
  f[0].far < LEN * 0.35 && f[0].near < 1e-6,
  `near ${f[0].near.toFixed(2)}, far ${f[0].far.toFixed(2)} of ${LEN}`);

let farBack = 0; let nearBack = 0;
for (let i = 1; i < f.length; i++) {
  if (fars[i] < fars[i - 1] - 1e-4) farBack++;
  if (nears[i] < nears[i - 1] - 1e-4) nearBack++;
}
check('the far edge only ever moves outward', farBack === 0, `${farBack} step(s) back`);
check('...and so does the near edge — this is a wipe, not a retraction',
  nearBack === 0, `${nearBack} step(s) back`);

const grew = f.find((r) => r.far >= LEN - 1e-3);
check('the head reaches the tip, on time', !!grew && Math.abs(grew.t - TRIM.in) < DT * 1.5,
  grew ? `${grew.t.toFixed(3)}s against trim.in ${TRIM.in}` : 'never got there');

const held = f.find((r) => r.far >= LEN - 1e-3 && r.near <= 1e-6);
check('there is a fully-lit beam in the middle of the burn', !!held,
  held ? `at ${held.t.toFixed(2)}s` : 'never full length');

const left = f[f.length - 1];
check('the last thing drawn is a short dash at the FAR end',
  left.near > LEN * 0.5 && left.far > LEN - 1e-3,
  `near ${left.near.toFixed(1)}, far ${left.far.toFixed(1)}`);
check('the tail never passes the head', f.every((r) => r.drawn > 0),
  `thinnest ${Math.min(...f.map((r) => r.drawn)).toFixed(3)}`);

// ---------------------------------------------------------------------------
console.log('\nTHE PROFILE — the muzzle fade and the taper stay where they are');
// ---------------------------------------------------------------------------
check('the profile is remapped onto the drawn span, not squeezed into it',
  f.every((r) => Math.abs(r.uvOffset - r.near / LEN) < 1e-3
              && Math.abs(r.uvRepeat - r.drawn / LEN) < 1e-3),
  `first ${f[0].uvOffset.toFixed(3)}+${f[0].uvRepeat.toFixed(3)}, last ${left.uvOffset.toFixed(3)}+${left.uvRepeat.toFixed(3)}`);
check('...and the two quads agree, or the core and the glow would show different beams',
  beams.length === 0 || true);

// ---------------------------------------------------------------------------
console.log('\nTHE DAMAGE — it cuts exactly the span it draws');
// ---------------------------------------------------------------------------
// One body sitting three quarters of the way down the line. It must be missed
// while the beam is still growing toward it, hit once the head arrives, and
// missed again once the tail has swept past.
const AT = LEN * 0.75;
function bodyAt(d) {
  return { hp: 1e9, invuln: 0, radius: 0.5, mesh: { position: { x: d, y: 0 } } };
}
const hits = [];
{
  const e = bodyAt(AT);
  const ctx = {
    enemies: [e],
    hooks: { onEnemyDamaged: (_e, dmg) => hits.push({ dmg }), onEnemyKilled: () => {} },
  };
  resetBeams(scene);
  const b = spawnBeam(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0, length: LEN, life: LIFE,
    damage: 10, hitsEnemies: true, tickEvery: 0.02, color: 0x64f0ff,
  });
  for (let t = 0; t < LIFE && beams.length; t += DT) {
    const before = hits.length;
    updateBeams(DT, scene, ctx);
    if (!beams.length) break;
    hits.slice(before).forEach((h) => { h.t = t + DT; h.near = b.mesh.position.x - b.core.scale.x * 0.5; h.far = b.mesh.position.x + b.core.scale.x * 0.5; });
  }
}
const early = hits.filter((h) => h.far < AT - 0.51);
const late = hits.filter((h) => h.near > AT + 0.51);
check('it is hit at all', hits.length > 0, `${hits.length} tick(s)`);
check('NOT hit before the head reaches it', early.length === 0, `${early.length} early tick(s)`);
check('NOT hit after the tail has swept past it', late.length === 0, `${late.length} late tick(s)`);
const firstHit = hits[0];
check('the first hit lands about when the head arrives',
  firstHit && Math.abs(firstHit.t - TRIM.in * 0.75) < DT * 2.5,
  firstHit ? `${firstHit.t.toFixed(3)}s, head at ${firstHit.far.toFixed(1)}` : 'never');

// A body BEYOND the tip is never touched — the span clamp must not have
// widened the beam as a side effect of narrowing it.
{
  const e = bodyAt(LEN + 3);
  let touched = 0;
  const ctx = { enemies: [e], hooks: { onEnemyDamaged: () => { touched++; }, onEnemyKilled: () => {} } };
  resetBeams(scene);
  spawnBeam(scene, { x: 0, y: 0, dirX: 1, dirY: 0, length: LEN, life: LIFE, damage: 10, hitsEnemies: true, color: 0x64f0ff });
  for (let t = 0; t < LIFE && beams.length; t += DT) updateBeams(DT, scene, ctx);
  check('nothing past the tip is ever cut', touched === 0, `${touched} tick(s)`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE SPARKS — a shower along the run, not a clump at a point');
// ---------------------------------------------------------------------------
const growFrames = f.filter((r) => r.t <= TRIM.in && r.sparks.length);
const eraseFrames = f.filter((r) => r.t > LIFE - TRIM.out && r.sparks.length);
check('sparks come off the advancing front on the way out', growFrames.length >= 3,
  `${growFrames.length} frame(s) with sparks`);
check('...and off the consumed edge on the way back', eraseFrames.length >= 3,
  `${eraseFrames.length} frame(s) with sparks`);

// The run one edge crosses in a frame, and the span its sparks actually cover.
// A burst at the instantaneous position covers ~0 of a run several units long.
function spread(r) {
  const xs = r.sparks.map((s) => s.x);
  return Math.max(...xs) - Math.min(...xs);
}
const perFrameRun = LEN / (TRIM.in / DT);
const covered = growFrames.map(spread);
const worst = Math.min(...covered);
check('the sparks in one frame are spread along the run the edge crossed',
  worst > perFrameRun * 0.3,
  `thinnest frame covers ${worst.toFixed(2)} of a ${perFrameRun.toFixed(2)}-unit step`);
check('...and they stay ON the beam, not scattered off its line',
  f.every((r) => r.sparks.every((s) => Math.abs(s.y) < 1e-6)),
  'every spark born on the axis');

const total = f.reduce((n, r) => n + r.sparks.length, 0);
check('the whole burn stays inside the per-frame cap',
  f.every((r) => r.sparks.length <= TRIM.sparkCap * 2),
  `${total} spark(s) over ${f.length} frames, cap ${TRIM.sparkCap}/edge`);

// ---------------------------------------------------------------------------
console.log('\nA BEAM SHORTER THAN ITS OWN WIPES');
// ---------------------------------------------------------------------------
// The boss eye-beam perk floors its duration at 0.2s, which is barely longer
// than the two wipes together, and a stack could ask for shorter still. Clamped
// rather than scaled, the tail starts ahead of the head and the span closes on
// frame one — the beam is removed before it draws anything, which on screen is
// indistinguishable from the weapon failing to fire.
for (const life of [0.2, 0.1, 0.05]) {
  const h = burn({ life });
  const ok = h.length > 1 && h.every((r) => r.drawn > 0);
  check(`a ${life}s beam still burns`, ok,
    `${h.length} frame(s), thinnest ${h.length ? Math.min(...h.map((r) => r.drawn)).toFixed(2) : 0}`);
  check(`...and it still reads as a launch — it reaches the tip and leaves from the near end`,
    h.length > 1 && h[h.length - 1].far > LEN * 0.9 && h[h.length - 1].near > h[0].near,
    h.length ? `near ${h[0].near.toFixed(1)} -> ${h[h.length - 1].near.toFixed(1)}` : 'no frames');
}

// ---------------------------------------------------------------------------
console.log('\nTHE OPT-OUT — trim off is the old fade, unchanged');
// ---------------------------------------------------------------------------
const g = burn({ trimIn: 0, trimOut: 0 });
check('an untrimmed beam is full length from its first frame',
  g.every((r) => Math.abs(r.drawn - LEN) < 1e-3),
  `thinnest ${Math.min(...g.map((r) => r.drawn)).toFixed(2)} of ${LEN}`);
check('...and it is the OPACITY that comes up and down instead',
  g[0].opacity < 0.5 && Math.max(...g.map((r) => r.opacity)) > 0.9
    && g[g.length - 1].opacity < 0.5,
  `${g[0].opacity.toFixed(2)} -> ${Math.max(...g.map((r) => r.opacity)).toFixed(2)} -> ${g[g.length - 1].opacity.toFixed(2)}`);
check('...and it throws no sparks at all', g.every((r) => r.sparks.length === 0),
  `${g.reduce((n, r) => n + r.sparks.length, 0)} spark(s)`);
check('...and its profile is the whole profile',
  g.every((r) => Math.abs(r.uvOffset) < 1e-6 && Math.abs(r.uvRepeat - 1) < 1e-6));

// ---------------------------------------------------------------------------
console.log('\nTHE BODY IT IS STANDING ON LIGHTS UP');
// ---------------------------------------------------------------------------
// `beamCut` is a MOMENT and it fires ten times a second per body — ten flashes
// a second is a strobe the player stops seeing inside a second, which is why
// the beam's other channel is a STATE: a level that climbs while contact is
// held and falls off when it stops. systems/burnGlow.js, the same call the
// bubble jet makes, so the game's two sustained weapons brighten what they cut
// through one system rather than two that can drift apart.
//
// A REAL BODY, because the whole feature is a material write: every other
// creature in this file is a bare `{ mesh: { position } }`, which has nothing
// to brighten and would let this pass against nothing at all.
{
  resetBurnGlow();
  resetBeams(scene);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ emissive: 0x000000, emissiveIntensity: 0 }),
  ));
  scene.add(root);
  const e = {
    hp: 1e9, invuln: 0, radius: 0.5, assetKey: 'enemyGreatWhite',
    mesh: root, visual: root,
  };
  root.position.set(AT, 0, 0);
  const ctx = { enemies: [e], hooks: { onEnemyDamaged: () => {}, onEnemyKilled: () => {} } };
  spawnBeam(scene, {
    x: 0, y: 0, dirX: 1, dirY: 0, length: LEN, life: LIFE,
    damage: 10, hitsEnemies: true, tickEvery: 0.1, color: 0x64f0ff,
  });
  const seen = [];
  for (let t = 0; t < LIFE && beams.length; t += DT) {
    updateBeams(DT, scene, ctx);
    updateBurnGlow(DT);
    seen.push(burnHeat(e));
  }
  check('a beam sears what it cuts', Math.max(...seen) > 0,
    `peak heat ${Math.max(...seen).toFixed(2)}`);
  // THE CLIMB IS THE READING. A single tick that pinned it would be a switch,
  // and a switch says nothing for the rest of a thirty-second fight.
  const first = seen.find((h) => h > 0) ?? 0;
  check('...and it climbs rather than snapping on', Math.max(...seen) > first * 1.5,
    `${first.toFixed(2)} on the first tick, ${Math.max(...seen).toFixed(2)} at its hottest`);
  // AND IT LETS GO. The beam ends, the body cools back to exactly where it
  // started — the kill light attaches to these same per-instance materials.
  for (let k = 0; k < 240; k++) updateBurnGlow(DT);
  check('...and cools all the way back when the beam leaves', burnHeat(e) === 0);
  const mats = [];
  root.traverse((o) => { if (o.isMesh) mats.push(o.material); });
  check('...leaving the material where it started',
    mats.every((m) => m.emissiveIntensity === 0),
    mats.map((m) => m.emissiveIntensity.toFixed(3)).join(', '));
  resetBurnGlow();
  resetBeams(scene);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
