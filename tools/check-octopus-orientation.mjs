// Where do the six arm tips actually land once the asset orientation is
// applied? The game is a side view in the entity XY plane, so the arms have to
// splay across XY with very little Z, or they reach into and out of the screen
// and the grab reads as arms poking at nothing.
//
// Derived on paper first (forward '-Z', up '-X' should send the model's Y —
// the normal of the arm disc — toward the camera), but bone rigs lie and paper
// does too, so this measures it.
import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { orientationQuaternion } from '../path/src/assets.js';

const FILE = process.argv[2] ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/octopus_rig.glb';
const buf = readFileSync(FILE);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);

const ARM_TIPS = [
  'Bone018_end_0119', 'Bone036_end_0120', 'Bone054_end_0121',
  'Bone072_end_0122', 'Bone090_end_0123', 'Bone108_end_0124',
];
const HEAD_TIP = 'Bone111_end_0118';

const candidates = [
  { forward: '-Z', up: '-X' },
  { forward: '-Z', up: '+X' },
  { forward: '-Z', up: '+Y' },
  { forward: '+Y', up: '+Z' }, // what dumboOcto uses
  { forward: '+Z', up: '+Y' },
];

const root = gltf.scene;
const v = new THREE.Vector3();

for (const def of candidates) {
  const q = orientationQuaternion(def);
  root.updateMatrixWorld(true);

  const pts = [];
  for (const name of ARM_TIPS) {
    const b = root.getObjectByName(name);
    if (!b) { console.log(`  MISSING ${name}`); continue; }
    b.getWorldPosition(v).applyQuaternion(q);
    pts.push(v.clone());
  }
  const head = root.getObjectByName(HEAD_TIP);
  head.getWorldPosition(v).applyQuaternion(q);
  const headP = v.clone();

  // Spread along each entity axis. Screen-plane splay wants big X and Y and
  // small Z; a big Z means the arms are reaching toward and away from camera.
  const spread = (axis) => Math.max(...pts.map((p) => p[axis])) - Math.min(...pts.map((p) => p[axis]));
  const sx = spread('x');
  const sy = spread('y');
  const sz = spread('z');
  const inPlane = (sx + sy) / 2;
  const verdict = sz < inPlane * 0.6 ? 'ARMS IN SCREEN PLANE' : 'arms reach into the screen';

  console.log(`\nforward ${def.forward}  up ${def.up}`);
  console.log(`  arm-tip spread   X=${sx.toFixed(2)}  Y=${sy.toFixed(2)}  Z=${sz.toFixed(2)}   ${verdict}`);
  console.log(`  head tip         [${headP.x.toFixed(2)}, ${headP.y.toFixed(2)}, ${headP.z.toFixed(2)}]`);
  // Entity +Y is the direction of travel. The mantle should lead, so the head
  // tip wants a clearly positive Y.
  console.log(`  head leads +Y?   ${headP.y > 0.3 ? 'yes' : 'NO — mantle is not forward'}`);
}
