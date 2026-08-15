#!/usr/bin/env node
// npm run bones -- <model.glb> [filter]
//
// Every node name in a .glb, without three.js, a DOM or a GPU.
//
// A GLB is a 12-byte header and then chunks; the FIRST chunk is the glTF JSON,
// in plain UTF-8. So the node list — which is the bone list, since a skinned
// glTF's joints are nodes — can be read with nothing but fs. The loader-based
// route hangs in this project's headless stub, and it was never needed for a
// question this simple.
//
// What this CANNOT tell you is where a bone actually pulls the mesh: names and
// hierarchy lie, and a leaf called "eye" is routinely somewhere else entirely.
// It is a list to choose FROM, not an answer.
import { readFileSync } from 'node:fs';

const [file, filter] = process.argv.slice(2);
if (!file) { console.error('usage: npm run bones -- <model.glb> [filter]'); process.exit(1); }

const buf = readFileSync(file);
if (buf.toString('utf8', 0, 4) !== 'glTF') { console.error(`${file} is not a .glb`); process.exit(1); }
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));

const nodes = gltf.nodes ?? [];
// Joints are the nodes named by a skin — everything else is a mesh or a pivot.
const joints = new Set();
for (const skin of gltf.skins ?? []) for (const j of skin.joints ?? []) joints.add(j);

const rx = filter ? new RegExp(filter, 'i') : null;
let shown = 0;
console.log(`\n${file}\n  ${nodes.length} nodes, ${joints.size} joints, ${(gltf.animations ?? []).length} clips`);
nodes.forEach((n, i) => {
  const name = n.name ?? `(node ${i})`;
  if (rx && !rx.test(name)) return;
  const t = n.translation;
  console.log(
    `   ${joints.has(i) ? 'bone' : '    '} ${String(i).padStart(3)} ${name.padEnd(30)}`
    + (t ? ` t=[${t.map((v) => v.toFixed(2)).join(', ')}]` : ''),
  );
  shown++;
});
if (rx && !shown) console.log(`   nothing matching /${filter}/i`);
