// Where do the giant squid's arms actually land once an asset orientation is
// applied? Same question tools/check-octopus-orientation.mjs asks of the
// grabber, and asked the same way — by measuring — because a squid is the one
// body where paper reasoning is most likely to be wrong.
//
// The game is a side view in the entity XY plane (CONFIG.view === 'side'), so
// the arm crown has to splay ACROSS XY with little Z. An orientation that sends
// the crown into the screen gives a boss whose whole silhouette is a mantle
// with a smudge under it.
//
// THE SECOND QUESTION, which the octopus did not have to answer: which END
// LEADS. A squid jets mantle-first to flee and swims arms-first to hunt, and
// enemies.js drives a boss at the player — so the arms should lead, matching
// the reasoning already written into the enemySquid entry in assets.js.
//
//   node --import ./tools/vite-loader.mjs tools/check-squid-orientation.mjs
import './dom-stub.mjs';
// This body carries six 1024x1024 textures, which the octopus does not — and
// GLTFLoader's image path never settles in Node without this, so the parse
// hangs rather than failing. Nothing here looks at a pixel.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { orientationQuaternion } from '../path/src/assets.js';

const FILE = process.argv[2] ?? 'public/models/giantsquid.glb';
const buf = readFileSync(FILE);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);

// The last bone of each of the eight limb chains, read off the measured
// hierarchy rather than guessed: six arms and the two long feeding tentacles.
const ARM_TIPS = [
  'FrontTTC005_15', 'FrontsideTTCL005_21', 'FrontsideTTCR005_38',
  'BackTTC004_27', 'SideTTCL005_32', 'SideTTCR005_44',
  'nondeformL007_78', 'nondeformR007_87',
];
// The mantle. `middlebone001_75` carries 3,844 verts — the body — and
// `middlebone_68` is the tip beyond it.
const MANTLE_TIP = 'middlebone_68';
const EYES = ['EyeballL_57', 'EyeballR_58'];

const candidates = [
  { forward: '+Y', up: '+Z' },
  { forward: '-Y', up: '+Z' },
  { forward: '-Y', up: '-Z' },
  { forward: '+Z', up: '+Y' },  // what enemySquid uses
  { forward: '-Z', up: '-X' },  // what octoGrabber uses
  { forward: '-Y', up: '+X' },
];

const root = gltf.scene;
root.updateMatrixWorld(true);
const v = new THREE.Vector3();
const at = (name, q) => {
  const o = root.getObjectByName(name);
  if (!o) return null;
  o.getWorldPosition(v);
  return v.clone().applyQuaternion(q);
};

for (const def of candidates) {
  const q = orientationQuaternion(def);
  const pts = ARM_TIPS.map((n) => at(n, q)).filter(Boolean);
  const mantle = at(MANTLE_TIP, q);
  const eyes = EYES.map((n) => at(n, q)).filter(Boolean);
  if (pts.length < ARM_TIPS.length) console.log(`  (${ARM_TIPS.length - pts.length} arm tips missing)`);

  const spread = (axis) => Math.max(...pts.map((p) => p[axis])) - Math.min(...pts.map((p) => p[axis]));
  const sx = spread('x'), sy = spread('y'), sz = spread('z');
  const inPlane = (sx + sy) / 2;
  const verdict = sz < inPlane * 0.6 ? 'CROWN IN SCREEN PLANE' : 'crown reaches into the screen';

  // Entity +Y is the direction of travel. Arms-first means the crown's mean
  // sits ahead of the mantle on Y.
  const crownY = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const lead = crownY > mantle.y ? 'arms lead (hunting)' : 'MANTLE leads (fleeing)';
  // The eyes have to be on opposite sides of the SCREEN plane's depth axis, or
  // the animal is being viewed down its own axis of symmetry and only one eye
  // is ever visible.
  const eyeSplit = eyes.length === 2
    ? { x: Math.abs(eyes[0].x - eyes[1].x), y: Math.abs(eyes[0].y - eyes[1].y), z: Math.abs(eyes[0].z - eyes[1].z) }
    : null;

  console.log(`\nforward ${def.forward}  up ${def.up}`);
  console.log(`  arm-tip spread   X=${sx.toFixed(2)}  Y=${sy.toFixed(2)}  Z=${sz.toFixed(2)}   ${verdict}`);
  console.log(`  mantle tip       [${mantle.x.toFixed(2)}, ${mantle.y.toFixed(2)}, ${mantle.z.toFixed(2)}]   crown mean Y ${crownY.toFixed(2)}   ${lead}`);
  if (eyeSplit) {
    const onZ = eyeSplit.z > eyeSplit.x && eyeSplit.z > eyeSplit.y;
    console.log(`  eye separation   X=${eyeSplit.x.toFixed(2)}  Y=${eyeSplit.y.toFixed(2)}  Z=${eyeSplit.z.toFixed(2)}   ${onZ ? 'eyes stacked in DEPTH — only one is ever seen' : 'both eyes readable'}`);
  }
}
