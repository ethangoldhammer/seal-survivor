// Measure a club model: how big it is, which way it lies, and — the part that
// decides everything downstream — WHERE ITS ORIGIN SITS along the shaft.
//
// A club is swung from its base. If the file's origin is the middle of the
// shaft (which is what an exporter does by default) then hanging it off a fin
// tip puts the fin's grip halfway up the weapon, and every swing pivots around
// the club's waist. That is invisible in a render and obvious in motion, so it
// is measured here rather than eyeballed.
import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node --import ./tools/vite-loader.mjs tools/inspect-club.mjs <file.glb>');
  process.exit(1);
}

const buf = readFileSync(FILE);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
const root = gltf.scene;
root.updateMatrixWorld(true);

console.log(`\n${FILE}`);

const box = new THREE.Box3().setFromObject(root);
const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
const axes = ['x', 'y', 'z'];
const longest = axes.reduce((a, b) => (size[a] >= size[b] ? a : b));

console.log(`\nSIZE      ${size.x.toFixed(3)} x  ${size.y.toFixed(3)} y  ${size.z.toFixed(3)} z`);
console.log(`LONGEST   ${longest} (${size[longest].toFixed(3)}) — the shaft lies along this axis`);
console.log(`BOX       min ${box.min.toArray().map((v) => v.toFixed(3)).join(', ')}`);
console.log(`          max ${box.max.toArray().map((v) => v.toFixed(3)).join(', ')}`);
console.log(`CENTRE    ${centre.toArray().map((v) => v.toFixed(3)).join(', ')}`);

// WHERE THE ORIGIN SITS along the long axis, as a fraction: 0 = at one end
// (a model built to be gripped), 0.5 = dead centre (needs an offset to swing
// from its base).
const lo = box.min[longest];
const hi = box.max[longest];
const frac = (0 - lo) / (hi - lo);
console.log(`\nORIGIN    at ${(frac * 100).toFixed(1)}% along ${longest} (0% = one end, 50% = centre)`);
if (Math.abs(frac - 0.5) < 0.12) console.log('          -> CENTRED. Needs a half-length offset to hang from its base.');
else if (frac < 0.2 || frac > 0.8) console.log('          -> AT AN END. Can hang straight off the grip.');
else console.log('          -> off-centre; offset by hand.');

// Which end is the HEAD? A club is heavier at one end — compare how much
// geometry sits in the outer quarter at each end of the long axis.
let loMass = 0;
let hiMass = 0;
const v = new THREE.Vector3();
root.traverse((o) => {
  if (!o.isMesh || !o.geometry?.attributes?.position) return;
  const pos = o.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    o.localToWorld(v);
    const t = (v[longest] - lo) / (hi - lo);
    if (t < 0.25) loMass++;
    else if (t > 0.75) hiMass++;
  }
});
console.log(`\nMASS      ${loMass} verts in the low quarter, ${hiMass} in the high quarter`);
console.log(`          -> the HEAD (fat end) is at ${hiMass > loMass ? 'HIGH' : 'LOW'} ${longest}`);

const meshes = [];
root.traverse((o) => { if (o.isMesh) meshes.push(o); });
console.log(`\nMESHES (${meshes.length})`);
let verts = 0;
for (const m of meshes) {
  const n = m.geometry.attributes.position.count;
  verts += n;
  const mat = Array.isArray(m.material) ? m.material[0] : m.material;
  const maps = ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap']
    .filter((k) => mat?.[k]).join(', ') || 'none';
  console.log(`  ${m.name || '(unnamed)'}  verts=${n}  mat=${mat?.type}  maps=${maps}`);
}
console.log(`\nTOTAL     ${verts} verts, ${gltf.animations.length} clip(s)`);
for (const c of gltf.animations) console.log(`  clip "${c.name}" ${c.duration.toFixed(2)}s`);
console.log('');
