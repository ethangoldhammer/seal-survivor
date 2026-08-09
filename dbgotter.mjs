globalThis.self=globalThis; globalThis.window=globalThis;
globalThis.ProgressEvent=class{constructor(t,o={}){Object.assign(this,o);this.type=t;}};
globalThis.document={createElementNS:()=>({style:{},getContext:()=>null,addEventListener(){},removeEventListener(){}}),
  createElement:()=>({style:{},getContext:()=>null,addEventListener(){},removeEventListener(){}})};
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import fs from 'node:fs';
const raw = fs.readFileSync('/mnt/user-data/uploads/model_96a_-_north_american_otter.glb');
let o=12,json=null,bin=null;
while(o<raw.length){const len=raw.readUInt32LE(o),t=raw.toString('ascii',o+4,o+8);
  if(t==='JSON')json=JSON.parse(raw.toString('utf8',o+8,o+8+len));
  if(t.startsWith('BIN'))bin=raw.subarray(o+8,o+8+len); o+=8+len;}
for(const m of json.materials||[]){for(const k of Object.keys(m))if(/Texture$/.test(k))delete m[k];
  if(m.pbrMetallicRoughness)for(const k of Object.keys(m.pbrMetallicRoughness))if(/Texture$/.test(k))delete m.pbrMetallicRoughness[k];
  delete m.extensions;}
delete json.textures; delete json.images; delete json.samplers; delete json.extensionsUsed; delete json.extensionsRequired;
const js=Buffer.from(JSON.stringify(json),'utf8'); const jsPad=Buffer.concat([js,Buffer.alloc((4-js.length%4)%4,0x20)]);
const head=Buffer.alloc(12); head.write('glTF',0,'ascii'); head.writeUInt32LE(2,4); head.writeUInt32LE(12+8+jsPad.length+8+bin.length,8);
const jh=Buffer.alloc(8); jh.writeUInt32LE(jsPad.length,0); jh.write('JSON',4,'ascii');
const bh=Buffer.alloc(8); bh.writeUInt32LE(bin.length,0); bh.write('BIN\0',4,'ascii');
const glb=Buffer.concat([head,jh,jsPad,bh,bin]);
const gltf = await new Promise((res,rej)=>new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'',res,rej));
gltf.scene.updateMatrixWorld(true);
gltf.scene.traverse(m=>{
  if(!m.isMesh) return;
  const naive = new THREE.Box3().setFromObject(m);
  const s=new THREE.Vector3(); naive.getSize(s);
  console.log(m.name, 'isSkinned', m.isSkinnedMesh, 'verts', m.geometry.attributes.position.count, 'naive bbox size', s.toArray().map(v=>v.toFixed(2)).join('/'));
  if (m.isSkinnedMesh) {
    console.log('  skeleton bones:', m.skeleton.bones.length, '| bindMatrix det:', new THREE.Matrix4().copy(m.bindMatrix).determinant().toFixed(4));
  }
});
