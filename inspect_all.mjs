globalThis.self=globalThis;
globalThis.window=globalThis;
globalThis.ProgressEvent=class{constructor(t,o={}){Object.assign(this,o);this.type=t;}};
globalThis.document={
  createElementNS:()=>({ style:{}, getContext:()=>null, addEventListener(){}, removeEventListener(){} }),
  createElement:()=>({ style:{}, getContext:()=>null, addEventListener(){}, removeEventListener(){} }),
};
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';

const files = [
  ['otter', '/mnt/user-data/uploads/model_96a_-_north_american_otter.glb'],
  ['tang', '/mnt/user-data/uploads/blue_powder_tang.glb'],
  ['mightyMeg', '/mnt/user-data/uploads/mighty_megalodon.glb'],
  ['megalodon', '/mnt/user-data/uploads/megalodon.glb'],
  ['greatWhite', '/mnt/user-data/uploads/great_white_shark.glb'],
  ['lowpolyFishPack', '/mnt/user-data/uploads/lowpoly_fish_pack.glb'],
  ['fish2', '/mnt/user-data/uploads/fish.glb'],
  ['tropicalSchool', '/mnt/user-data/uploads/animated_swimming_tropical_fish_school_loop.glb'],
  ['trout', '/tmp/unzip2/source/Trout.fbx'],
];

function stripTexturesGLB(buf) {
  let o=12,json=null,bin=null;
  while(o<buf.length){const len=buf.readUInt32LE(o),t=buf.toString('ascii',o+4,o+8);
    if(t==='JSON')json=JSON.parse(buf.toString('utf8',o+8,o+8+len));
    if(t.startsWith('BIN'))bin=buf.subarray(o+8,o+8+len); o+=8+len;}
  for(const m of json.materials||[]){
    for(const k of Object.keys(m)) if(/Texture$/.test(k)) delete m[k];
    if(m.pbrMetallicRoughness) for(const k of Object.keys(m.pbrMetallicRoughness)) if(/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
    if(m.extensions) for(const e of Object.values(m.extensions)) for(const k of Object.keys(e)) if(/Texture$/.test(k)) delete e[k];
  }
  delete json.textures; delete json.images; delete json.samplers;
  const js=Buffer.from(JSON.stringify(json),'utf8');
  const jsPad=Buffer.concat([js,Buffer.alloc((4-js.length%4)%4,0x20)]);
  const head=Buffer.alloc(12); head.write('glTF',0,'ascii'); head.writeUInt32LE(2,4);
  head.writeUInt32LE(12+8+jsPad.length+8+bin.length,8);
  const jh=Buffer.alloc(8); jh.writeUInt32LE(jsPad.length,0); jh.write('JSON',4,'ascii');
  const bh=Buffer.alloc(8); bh.writeUInt32LE(bin.length,0); bh.write('BIN\0',4,'ascii');
  return Buffer.concat([head,jh,jsPad,bh,bin]);
}

function skinVertex(mesh, i) {
  const g = mesh.geometry;
  const p = new THREE.Vector3().fromBufferAttribute(g.attributes.position, i);
  if (!mesh.isSkinnedMesh) return p;
  const base = p.clone().applyMatrix4(mesh.bindMatrix);
  const si = new THREE.Vector4().fromBufferAttribute(g.attributes.skinIndex, i);
  const sw = new THREE.Vector4().fromBufferAttribute(g.attributes.skinWeight, i);
  const out = new THREE.Vector3();
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(k); if (!w) continue;
    const b = si.getComponent(k);
    const m = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[b].matrixWorld, mesh.skeleton.boneInverses[b]);
    out.addScaledVector(base.clone().applyMatrix4(m), w);
  }
  return out.applyMatrix4(mesh.bindMatrixInverse);
}

for (const [name, path] of files) {
  try {
    const ext = path.split('.').pop().toLowerCase();
    const raw = fs.readFileSync(path);
    let root, anims;
    if (ext === 'fbx') {
      root = new FBXLoader().parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength), '');
      anims = root.animations ?? [];
    } else {
      const stripped = stripTexturesGLB(raw);
      const gltf = await new Promise((res,rej)=>new GLTFLoader().parse(stripped.buffer.slice(stripped.byteOffset,stripped.byteOffset+stripped.byteLength),'',res,rej));
      root = gltf.scene; anims = gltf.animations ?? [];
    }
    root.updateMatrixWorld(true);

    let meshes=0, skinned=0, tris=0, bones=0;
    const box = new THREE.Box3();
    root.traverse(o=>{
      if(o.isBone) bones++;
      if(o.isMesh){
        meshes++; if(o.isSkinnedMesh) skinned++;
        const g=o.geometry, idx=g.index;
        const n = idx?idx.count:g.attributes.position.count;
        tris += n/3;
        for(let i=0;i<n;i+=Math.max(1,Math.floor(n/200))){ // sample for speed on huge meshes
          const j = idx?idx.getX(i):i;
          box.expandByPoint(skinVertex(o,j).applyMatrix4(o.matrixWorld));
        }
      }
    });
    const size=new THREE.Vector3(), center=new THREE.Vector3();
    box.getSize(size); box.getCenter(center);

    console.log(`\n=== ${name} (${path.split('/').pop()}, ${(raw.length/1e6).toFixed(1)}MB, ${ext}) ===`);
    console.log(`  meshes ${meshes} (skinned ${skinned}) | bones ${bones} | tris ~${Math.round(tris)}`);
    console.log(`  size ${size.x.toFixed(2)}/${size.y.toFixed(2)}/${size.z.toFixed(2)}  center ${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)}`);
    console.log(`  animations: ${anims.length}`, anims.map(a=>`"${a.name}"(${a.duration.toFixed(1)}s)`).join(', '));
  } catch (err) {
    console.log(`\n=== ${name} === FAILED: ${err.message}`);
  }
}
