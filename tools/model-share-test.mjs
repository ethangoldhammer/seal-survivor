// Proves the four rules instantiateParsedModel exists to hold, on real files.
//
// preloadAssets now parses each model URL once however many ASSETS entries
// name it, and hands every entry its own instance. That is only safe if the
// instances are independent in the three ways prepareModel and the tuner
// actually write to them — and only WORTH doing if the texture image is still
// shared underneath. Each assertion below is a bug that shipped silently if it
// flips: none of them throw, they just quietly render the wrong thing on
// whichever creature loaded second.
//
//   node --import ./tools/vite-loader.mjs tools/model-share-test.mjs
import './dom-stub.mjs';
// A textured GLB embeds its images and GLTFLoader decodes them through
// createImageBitmap; without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateParsedModel } from '../path/src/assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function parse(name) {
  const buf = readFileSync(resolve(HERE, '../public/models', name));
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  return gltf.scene;
}

const meshesOf = (root) => {
  const out = [];
  root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) out.push(o); });
  return out;
};
const firstMaterial = (mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);

// fish.glb is the sharpest case in the roster: enemyFish and enemyLanternfish
// both load it, and only lanternfish is bioluminescent — so it is exactly the
// pair where leaked geometry would put biolum attributes on a plain fish.
console.log('\nfish.glb (enemyFish + enemyLanternfish, 2 embedded textures)');
{
  const master = await parse('fish.glb');
  const a = instantiateParsedModel(master);
  const b = instantiateParsedModel(master);
  const [ma] = meshesOf(a);
  const [mb] = meshesOf(b);

  check('instances are distinct objects', a !== b && ma !== mb);

  // 1. GEOMETRY — attachBiolumSkin writes aBioPos/aBioAxis onto it.
  check('geometry is per-instance', ma.geometry !== mb.geometry);
  ma.geometry.setAttribute('aBioPos', new THREE.BufferAttribute(new Float32Array(3), 3));
  check(
    'biolum attribute does not leak to the other instance',
    !mb.geometry.getAttribute('aBioPos'),
    'lanternfish would have glowed the plain fish',
  );

  // 2. MATERIAL — prepareModel clones again on top of this, but the slots it
  //    reads (and the tuner's reset stash) have to start out ours.
  const fa = firstMaterial(ma);
  const fb = firstMaterial(mb);
  check('material is per-instance', fa !== fb);

  // 3. TEXTURE OBJECT vs SOURCE — the whole point of the design. Different
  //    Texture, same Source: independent sampler settings, one GPU upload.
  check('texture object is per-instance', fa.map !== fb.map);
  check(
    'texture SOURCE is shared (this is the VRAM saving)',
    fa.map.source === fb.map.source,
    `source uuid ${fa.map.source.uuid.slice(0, 8)}`,
  );
  check('shared source means one decoded image', fa.map.image === fb.map.image);

  // 4. setAssetRepeat writes wrap/repeat on one asset key's materials. Compare
  //    against what the OTHER instance held a moment ago rather than against an
  //    assumed default — a glTF sampler already arrives as RepeatWrapping, so
  //    "is not RepeatWrapping" would fail on a texture nobody had touched.
  const beforeWrap = fb.map.wrapS;
  const beforeRepeat = fb.map.repeat.clone();
  fa.map.wrapS = THREE.ClampToEdgeWrapping;
  fa.map.repeat.set(3, 3);
  check(
    'setAssetRepeat on one asset does not move the other',
    fb.map.wrapS === beforeWrap && fb.map.repeat.equals(beforeRepeat),
    `other still ${fb.map.repeat.x}x${fb.map.repeat.y}, wrap ${fb.map.wrapS}`,
  );
  // Diverging sampler settings are what SHOULD cost a second upload, and only
  // for the asset that diverged — the shared image underneath is untouched.
  check('diverging settings still share the image', fa.map.source === fb.map.source);

  // The master must survive being instanced twice, or entry order decides
  // what the second creature looks like.
  const [mm] = meshesOf(master);
  check(
    'master parse left pristine',
    !mm.geometry.getAttribute('aBioPos')
      && mm.geometry !== ma.geometry
      && firstMaterial(mm).map.repeat.x === 1,
  );
}

// The skinned path is a different clone function (SkeletonUtils), and a shared
// skeleton would have every crab in the game posing as one animal.
console.log('\ncrabpincer.glb (enemyWalkingCrab + enemyEmberCrab, skinned)');
{
  const master = await parse('crabpincer.glb');
  const a = instantiateParsedModel(master);
  const b = instantiateParsedModel(master);
  const sa = meshesOf(a).find((m) => m.isSkinnedMesh);
  const sb = meshesOf(b).find((m) => m.isSkinnedMesh);

  check('skinned mesh survived the clone', !!sa && !!sb);
  check('skeleton is per-instance', sa.skeleton !== sb.skeleton);
  check(
    'bones are per-instance',
    sa.skeleton.bones[0] !== sb.skeleton.bones[0]
      && sa.skeleton.bones.length === sb.skeleton.bones.length,
    `${sa.skeleton.bones.length} bones each`,
  );
  // A SkinnedMesh whose bones were cloned but whose skeleton still points at
  // the master's bones renders in bind pose forever — cheap to assert, and
  // invisible until someone animates it.
  const ownBones = new Set();
  a.traverse((o) => { if (o.isBone) ownBones.add(o); });
  check(
    'skeleton points at this instance\'s own bones',
    sa.skeleton.bones.every((bone) => ownBones.has(bone)),
  );
}

console.log(
  failures === 0
    ? '\nAll model-sharing rules hold.\n'
    : `\n${failures} model-sharing rule(s) BROKEN.\n`,
);
process.exit(failures === 0 ? 0 : 1);
