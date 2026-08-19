import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const buf = readFileSync('public/models/furseal.glb');
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const scene = new THREE.Scene();
scene.add(gltf.scene);
scene.updateMatrixWorld(true);

let mesh = null;
gltf.scene.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
const sk = mesh.skeleton;
const idx = new Map(sk.bones.map((b, i) => [b.name, i]));
const pos = mesh.geometry.attributes.position;
const si = mesh.geometry.attributes.skinIndex;
const sw = mesh.geometry.attributes.skinWeight;

// bind space -> a chosen bone's local space
const HEAD = 'head_07';
const hi = idx.get(HEAD);
const toHead = (p) => p.clone().applyMatrix4(mesh.bindMatrix).applyMatrix4(sk.boneInverses[hi]);

function ownedBy(name) {
  const want = idx.get(name);
  const out = [];
  for (let v = 0; v < pos.count; v++) {
    let best = -1, bw = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w > bw) { bw = w; best = si.getComponent(v, k); }
    }
    if (best === want) out.push(v);
  }
  return out;
}

const p = new THREE.Vector3();
for (const [eye, label] of [['eye_L_09', 'eyeL'], ['eye_R_010', 'eyeR']]) {
  const verts = ownedBy(eye);
  const c = new THREE.Vector3();
  for (const v of verts) { p.fromBufferAttribute(pos, v); c.add(p); }
  c.divideScalar(verts.length);

  // the disc's own facing: the eye bone's local +Z at BIND, into head space
  const ei = idx.get(eye);
  const bindEye = new THREE.Matrix4().copy(sk.boneInverses[ei]).invert();
  const nWorldish = new THREE.Vector3(0, 0, 1).transformDirection(bindEye);
  // ...and the lift out of the socket, along that facing, matching the 0.006
  // the eye-bone anchor used.
  const lifted = c.clone().addScaledVector(nWorldish, 0.006);

  const localC = toHead(lifted);
  // direction: transform through the same chain, as a DIRECTION
  const headBind = new THREE.Matrix4().copy(sk.boneInverses[hi]).invert();
  const nLocal = nWorldish.clone().transformDirection(new THREE.Matrix4().copy(headBind).invert()).normalize();

  console.log(`${label}: ${verts.length} eyeball verts`);
  console.log(`  centroid (bind)      ${c.toArray().map((v) => v.toFixed(4)).join(', ')}`);
  console.log(`  offset on ${HEAD}   [${localC.toArray().map((v) => v.toFixed(4)).join(', ')}]`);
  console.log(`  normal on ${HEAD}   [${nLocal.toArray().map((v) => v.toFixed(4)).join(', ')}]`);

  // THE CHECK. Place a point by the OLD anchor (on the eye bone) and by the
  // NEW one (on the head), and compare where they land in the world at rest.
  // Same socket, two parents — if the arithmetic is right they are the same
  // point, and if it is not the eyes move to somewhere plausible and wrong.
  const oldW = new THREE.Vector3(0, 0.0245, 0.006).applyMatrix4(sk.bones[ei].matrixWorld);
  const newW = localC.clone().applyMatrix4(sk.bones[hi].matrixWorld);
  const nOldW = new THREE.Vector3(0, 0, 1).transformDirection(sk.bones[ei].matrixWorld);
  const nNewW = nLocal.clone().transformDirection(sk.bones[hi].matrixWorld);
  console.log(`  same point?          ${oldW.distanceTo(newW).toFixed(6)} apart`
    + `   (old ${oldW.toArray().map((v) => v.toFixed(3)).join(', ')})`);
  console.log(`  same facing?         ${(1 - nOldW.dot(nNewW)).toFixed(6)} off parallel`);
}
