#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Works out the assets.js entry a split orca would need, by MEASURING the rig
// rather than reading its bone names, and checks every chain it proposes.
//
// This is the same method assets.js used on the orca that ships — its fin
// chains are called `Thigh_F01_L` and `Foot_F02_L` because the rig was built
// for a quadruped, and the only way anybody found the flippers was to look at
// where the driven vertices actually went. The new rig has honest names, which
// is precisely why they still have to be checked: `Fin_L1..L4` and `Fin_L5..L8`
// are the LEFT and RIGHT flippers, both labelled L, and taking the names at
// face value would put both spring chains on the same side of the animal.
//
// Every chain is verified before it is printed:
//   - every bone exists
//   - each bone is the parent of the next (a spring solver walks root to tip
//     and a gap in the chain silently solves the wrong thing)
//   - the chain actually goes somewhere, measured on the flesh it drives
//
//   node --import ./tools/vite-loader.mjs tools/orca-rig-propose.mjs <orca.glb>
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const PATH = process.argv[2];
if (!PATH) { console.error('usage: orca-rig-propose.mjs <orca.glb>'); process.exit(1); }

const buf = readFileSync(PATH);
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
gltf.scene.updateMatrixWorld(true);

let mesh = null;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) mesh ??= o; });
const bones = mesh.skeleton.bones;
const byName = new Map(bones.map((b) => [b.name, b]));

// Where each bone's flesh sits, in the model's own space. The long axis of this
// file is Z (head +Z, fluke -Z) and up is +Y — which is what the existing
// `forward: '+Z', up: '+Y'` in assets.js already says, so it carries over.
const si = mesh.geometry.attributes.skinIndex;
const sw = mesh.geometry.attributes.skinWeight;
const pos = mesh.geometry.attributes.position;
const count = new Array(bones.length).fill(0);
const centre = Array.from({ length: bones.length }, () => new THREE.Vector3());
for (let v = 0; v < pos.count; v++) {
  let best = -1, bw = 0;
  const w = [sw.getX(v), sw.getY(v), sw.getZ(v), sw.getW(v)];
  const b = [si.getX(v), si.getY(v), si.getZ(v), si.getW(v)];
  for (let k = 0; k < 4; k++) if (w[k] > bw) { bw = w[k]; best = b[k]; }
  if (best < 0) continue;
  count[best] += 1;
  centre[best].add(new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)));
}
const at = new Map();
for (let i = 0; i < bones.length; i++) {
  if (count[i] > 0) at.set(bones[i].name, centre[i].clone().divideScalar(count[i]));
}

let bad = 0;
function verify(role, names, expect) {
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length) { console.log(`  FAIL ${role}: no such bone — ${missing.join(', ')}`); bad++; return; }
  for (let i = 1; i < names.length; i++) {
    if (byName.get(names[i]).parent !== byName.get(names[i - 1])) {
      console.log(`  FAIL ${role}: "${names[i]}" is not a child of "${names[i - 1]}" — the chain is broken`);
      bad++; return;
    }
  }
  const a = at.get(names[0]);
  const b = at.get(names[names.length - 1]);
  const detail = a && b ? `root (${a.x.toFixed(0)}, ${a.y.toFixed(0)}, ${a.z.toFixed(0)}) -> tip (${b.x.toFixed(0)}, ${b.y.toFixed(0)}, ${b.z.toFixed(0)})` : 'no flesh on the tip bone';
  const ok = !expect || expect(a, b);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${role}: ${names.length} bones, ${detail}`);
  if (!ok) bad++;
}

console.log(`\n${PATH}\nCHAINS — each one measured, not read\n`);

const tail = ['Spine8', 'Spine9', 'Spine10', 'Tail_01', 'Tail_02'];
verify('tail', tail, (a, b) => b.z < a.z - 50);

const dorsal = ['Dorsal_Fin1', 'Dorsal_Fin2', 'Dorsal_Fin3', 'Dorsal_Fin4', 'Dorsal_Fin5'];
verify('dorsal (must rise on the centreline)', dorsal,
  (a, b) => b.y > a.y + 50 && Math.abs(b.x) < 5);

const pecL = ['Shoulder_L', 'Fin_L1', 'Fin_L2', 'Fin_L3'];
verify('pectoral +X', pecL, (a, b) => b.x > 50);

const pecR = ['Shoulder_L1', 'Fin_L5', 'Fin_L6', 'Fin_L7'];
verify('pectoral -X  (named L, and on the other side)', pecR, (a, b) => b.x < -50);

const flukeL = ['Tail_Fin_L1', 'Tail_Fin_L2', 'Tail_Fin_L3'];
verify('fluke lobe +X', flukeL, (a, b) => b.x > 50);
const flukeR = ['Tail_Fin_L5', 'Tail_Fin_L6', 'Tail_Fin_L7'];
verify('fluke lobe -X  (also named L)', flukeR, (a, b) => b.x < -50);

const look = ['Neck', 'Head'];
verify('head look', look, (a, b) => b.z > a.z);

const jaw = ['Jaw_Rotate', 'Jaw_Bone'];
verify('jaw', jaw, null);

console.log(`\nWHAT THE JAW IS WORTH: ${count[bones.findIndex((b) => b.name === 'Jaw_Bone')] ?? 0} vertices are driven by Jaw_Bone.`);
console.log('The shipped rig has a single `mouth_015` bone and systems/jaw.js has nothing to grab.');

console.log(`\nANIMATED BY THE CLIP: ${[...new Set(gltf.animations[0]?.tracks.map((t) => t.name.split('.')[0]) ?? [])].join(', ')}`);
console.log('Note what is NOT in that list: the fins, the dorsal and the flukes are unanimated,');
console.log('which is exactly what the spring chains want — nothing to fight.');

console.log(`
--- the assets.js entry, if this is the one -------------------------------
  enemyOrca: {
    model: '/models/orca.glb',
    fit: 5.2,
    pivot: 0.15,
    forward: '+Z', up: '+Y',      // unchanged — measured, head at +Z, dorsal at +Y
    // ONE CLIP, and that is not a gap. systems/animation.js reuses a lone clip
    // for every state at a different playback rate (see its header, rule 2), so
    // idle / swim / boost come out of this one cycle. No mapping is given here
    // BECAUSE naming one would opt out of that behaviour.
    rig: {
      springChains: [
        { role: 'tail', bones: ${JSON.stringify(tail)} },
        { role: 'fin', bones: ${JSON.stringify(dorsal)} },
        { role: 'fin', bones: ${JSON.stringify(pecL)} },
        { role: 'fin', bones: ${JSON.stringify(pecR)} },
      ],
    },
    lookRig: {
      head: { bones: ${JSON.stringify(look)}, tipAxis: '+Y', tipLength: 0.4 },
    },
  },
---------------------------------------------------------------------------`);

console.log(`\n${bad ? `${bad} chain(s) FAILED` : 'every proposed chain verified'}\n`);
process.exit(bad ? 1 : 0);
