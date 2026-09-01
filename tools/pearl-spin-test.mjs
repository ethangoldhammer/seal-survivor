// THE PEARL'S SPIN — the axis, and the water taking it back.
//
// This exists because the failure it guards is invisible on screen in the
// exact way a bug should never be allowed to be. The pearl shipped with
// `spin: 3` for months and did not turn at all: `spin` writes rotation.z,
// z is the axis the camera looks down, and a sphere's silhouette is a circle
// about every axis. Three radians a second of nothing, and no frame of the
// game could tell you so.
//
// So the assertions here are about the AXIS and the CURVE rather than about
// "does it rotate". Both are propositions a screenshot cannot answer:
//
//   1. the turn lands on y, not z — the one that made the old spin a no-op
//   2. it decays, and by the stated exponential rather than "less than before"
//   3. that decay is frame-rate independent, which the obvious `spin -= k*dt`
//      is not — a machine dropping frames would spin its pearls differently
//   4. the surface has UVs fine enough to carry a texture, since the spin has
//      nothing to show without one
//
//   node --import ./tools/vite-loader.mjs tools/pearl-spin-test.mjs

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSETS, createVisual } from '../path/src/assets.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from '../path/src/entities/projectiles.js';
import { firePearl } from '../path/src/systems/oyster.js';
import { applyNoiseSettings } from '../path/src/systems/noiseShader.js';

let failures = 0;
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const c = CONFIG.oyster;
const scene = new THREE.Scene();
const shoot = () => {
  resetProjectiles(scene);
  firePearl(scene, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 1);
  return projectiles[0];
};
// Long life so nothing despawns underneath a measurement, and no enemies, so
// updateProjectiles is only ever integrating flight.
const fly = (p, total, step) => {
  for (let t = 0; t < total - 1e-9; t += step) { p.life = 999; updateProjectiles(step, scene, [], () => {}); }
};

console.log('\n1. the body');
{
  const def = ASSETS.pearl;
  ok(def.shape === 'sphere', 'the pearl is a sphere', `shape is ${def.shape}`);
  // The whole reason the segment count is not the shape's default of 8.
  ok((def.segments ?? 8) >= 16,
    'fine enough to carry a texture without shearing',
    `segments ${def.segments ?? 8} — an 8x8 lattice shears a print as it turns`);
  const geo = createVisual('pearl').geometry;
  ok(!!geo?.attributes?.uv, 'and it has UVs, so `map` can be spun with the body');
}

console.log('\n2. the axis');
{
  const p = shoot();
  fly(p, 0.25, 1 / 60);
  ok(Math.abs(p.mesh.rotation.y) > 0.1,
    'the turn lands on y', `rotation.y is ${p.mesh.rotation.y.toFixed(4)}`);
  // The bug this file was written for. z is the view axis: a sphere turned
  // about it is pixel-for-pixel identical to one that never moved.
  ok(p.mesh.rotation.z === 0,
    'and NOT on z, which the camera looks down',
    `rotation.z is ${p.mesh.rotation.z.toFixed(4)} — a spin nobody can see`);
  ok(near(p.mesh.rotation.x, c.pearlTilt, 1e-9),
    'canted, so the surface goes over the top as well as around',
    `rotation.x is ${p.mesh.rotation.x.toFixed(4)}, want ${c.pearlTilt}`);
}

console.log('\n3. the water taking it back');
{
  const p = shoot();
  ok(near(p.spin, c.pearlSpin, 1e-9), 'leaves the shell at the launch rate',
    `${p.spin} vs ${c.pearlSpin}`);
  fly(p, 1, 1 / 60);
  const want1 = c.pearlSpin * Math.exp(-c.pearlSpinDrag * 1);
  ok(near(p.spin, want1, want1 * 0.01), 'and decays by the stated exponential after 1s',
    `${p.spin.toFixed(4)} vs e^(-${c.pearlSpinDrag}) x ${c.pearlSpin} = ${want1.toFixed(4)}`);

  // Over a full flight it should be visibly loafing rather than merely slower.
  const q = shoot();
  fly(q, c.life, 1 / 60);
  ok(q.spin < c.pearlSpin * 0.35,
    'and is well down by the time the pearl lands',
    `${(q.spin / c.pearlSpin * 100).toFixed(0)}% of launch after ${c.life}s`);
  // Never zero: a pearl that STOPPED mid-water would read as having hit something.
  ok(q.spin > 0, 'but never actually stops', `${q.spin}`);
}

console.log('\n4. the same on any machine');
{
  // `spin -= drag * dt` passes every check above and fails this one, which is
  // the entire reason it is here.
  const coarse = shoot(); fly(coarse, 1, 1 / 20);
  const fine = shoot(); fly(fine, 1, 1 / 240);
  ok(near(coarse.spin, fine.spin, 1e-6),
    'a 20fps second and a 240fps second land on the same rate',
    `${coarse.spin.toFixed(6)} vs ${fine.spin.toFixed(6)}`);
}

console.log('\n5. nothing else moved');
{
  // Every other spinner in the game predates spinAxis/spinDrag. Spawned the
  // way they are spawned — `spin` alone — a shot must still cartwheel in the
  // screen plane at a constant rate, which is what the defaults are for.
  resetProjectiles(scene);
  spawnProjectile(scene, {
    origin: new THREE.Vector3(0, 0, 0), dir: new THREE.Vector3(1, 0, 0),
    faction: 'player', damage: 1, speed: 10, life: 999, radius: 0.3,
    asset: 'starfish', spin: 5,
  });
  const s = projectiles[0];
  fly(s, 1, 1 / 60);
  ok(near(s.spin, 5, 1e-9), 'a plain spinner keeps its rate', `${s.spin}`);
  ok(Math.abs(s.mesh.rotation.z) > 1 && s.mesh.rotation.y === 0,
    'and still turns on z', `z ${s.mesh.rotation.z.toFixed(3)}, y ${s.mesh.rotation.y}`);

  const p = shoot();
  ok(p.spinAxis === 'y' && p.spinDrag === c.pearlSpinDrag,
    'only the pearl opts out', `${p.spinAxis}, drag ${p.spinDrag}`);
}

console.log('\n6. the surface');
{
  // THE FENCE THAT MAKES THIS SECTION NECESSARY. The wet film reads
  // geometryNormal/geometryViewDir, declared only by <lights_fragment_begin>,
  // so it is compiled behind `#ifdef STANDARD`. On a MeshBasicMaterial the
  // layer is not dim, it is ABSENT — and absent silently, because the fence is
  // exactly what stops it being a compile error. Every slider in the shader
  // lab's WET panel would move a uniform nothing reads.
  const def = ASSETS.pearl;
  ok(def.unlit === false, 'the pearl is lit, or the wet film cannot compile at all',
    `unlit is ${def.unlit}`);
  ok(def.noiseShader === 'pearl', 'and wears its own preset', `${def.noiseShader}`);

  const mat = createVisual('pearl').material;
  ok(mat.isMeshStandardMaterial === true, 'the built material is STANDARD',
    mat.type);
  ok(!!mat.userData.__noiseUniforms, 'and the surface actually attached to it',
    'a primitive could not take this layer before — only the model path attached');

  // The emissive is a brightness, not a second opinion about the colour: at
  // body strength it renders a flat white disc with no film on it at all (see
  // the asset note). A tenth is the check that stops that coming back.
  const e = new THREE.Color(def.emissive);
  const c = new THREE.Color(def.color);
  const lum = (x) => 0.2126 * x.r + 0.7152 * x.g + 0.0722 * x.b;
  ok(lum(e) < lum(c) * 0.25,
    'and its emissive is a fraction of the body, not the body',
    `emissive luma ${lum(e).toFixed(3)} vs body ${lum(c).toFixed(3)}`);

  // The preset has to REACH the uniforms. A block under CONFIG that nothing
  // spreads onto a material is the same as no block.
  applyNoiseSettings();
  const u = mat.userData.__noiseUniforms;
  const P = CONFIG.sealShader.presets.pearl;
  ok(u.uWetAmount.value === P.wet, 'the preset reaches the live uniforms',
    `uWetAmount ${u.uWetAmount.value} vs preset ${P.wet}`);
  ok(u.uWetTight.value === P.wetTight && u.uWetRim.value === P.wetRim,
    'including the two that make it a pearl rather than a beach ball',
    `tight ${u.uWetTight.value}, rim ${u.uWetRim.value}`);
  // The mussel's trap, the other way up: `size` is world units and this is the
  // smallest body wearing the layer.
  ok(u.uNoiseSize.value < 0.2,
    'and the mottling is scaled to a 0.8-unit ball, not to a 2.6-unit seal',
    `size ${u.uNoiseSize.value} — the family default of 0.4 is half a patch on this body`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
