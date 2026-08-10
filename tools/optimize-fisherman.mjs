// Turns the raw fisherman download into something worth shipping.
//
//   node tools/optimize-fisherman.mjs [source.glb] [out.glb]
//
// The source is 6.70MB, of which about 2.5MB is data this game provably never
// reads. Measured breakdown of the original:
//
//     3.45MB  51%   three 1024x1024 24-bit PNGs
//     0.97MB  15%   animation keyframes
//     1.94MB  29%   mesh (23,689 verts / 43,164 tris)
//     0.17MB   2%   json
//
// What this drops, and why each one is safe:
//
//   1. THE NORMAL AND METALLIC-ROUGHNESS MAPS (2.02MB). The asset entry marks
//      him `modelUnlit`, which prepareModel turns into a MeshBasicMaterial
//      carrying nothing but the colour map. Those two textures were being
//      downloaded, decoded and thrown away every single load.
//   2. TANGENT (0.36MB). Tangents exist to orient a normal map. There is no
//      normal map any more, and there was no lighting to use it.
//   3. TEXCOORD_1 and TEXCOORD_2 (0.24MB). Two extra UV sets nothing samples.
//   4. THE COLOUR MAP, RE-ENCODED to WebP. PNG is lossless and meant for line
//      art; this is a painted texture. three.js reads WebP in a glb through
//      EXT_texture_webp, which it has supported for years.
//   5. WEIGHTS_0 QUANTIZED to normalized uint8 and JOINTS_0 to uint8 (0.45MB).
//      A skin weight is a number between 0 and 1 that is about to be summed
//      with three others — float32 is four bytes of precision nobody can see.
//      97 joints fit in a byte with room to spare.
//   6. THE IDLE RESAMPLED. It ships baked at ~28 keys per second per channel
//      — 48,228 keyframes for 15.2 seconds of a man standing still. Resampled
//      to `IDLE_HZ` by dropping keys, which for a slow idle is invisible.
//      The walk cycle is left ALONE: it is 1.08s and already lean, and it is
//      the clip where a dropped key would show.
//
// Result: 6.70MB -> 1.23MB, with nothing visibly different in game.
//
// What this deliberately does NOT do: decimate the mesh, or quantize POSITION.
// 43k triangles is a lot for a man who renders about as tall as a bullet, but
// decimating a skinned mesh means rebuilding its weights, and quantizing
// positions means carrying a scale on the node — and the ragdoll's bone map is
// measured against this geometry as it stands (see systems/humanoidRig.js).
// Between them they are most of what is left; neither is worth the risk to a
// rig that is already bound and verified.
//
// The source art is never written to. This reads from _DesignSystems and
// writes only to public/models, so re-running it after a new export is the
// whole update process.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2]
  ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor/fisherman.glb';
const OUT = process.argv[3]
  ?? path.join(process.cwd(), 'public/models/fisherman.glb');

const WEBP_QUALITY = 82;
const IDLE_HZ = 10; // keys per second to keep in the long idle
const DROP_ATTRIBUTES = ['TANGENT', 'TEXCOORD_1', 'TEXCOORD_2'];
// How far a keyframe has to stray from the track's first value before the
// track counts as animating at all.
const STATIC_EPSILON = 1e-4;

// ---------------------------------------------------------------- glb reading

function readGLB(file) {
  const buf = fs.readFileSync(file);
  let o = 12;
  let json = null;
  let bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
    if (type.startsWith('BIN')) bin = buf.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  return { json, bin, bytes: buf.length };
}

function writeGLB(file, json, bin) {
  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonText.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonText, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.write('JSON', 16, 'ascii');
  jsonChunk.copy(out, 20);
  const binAt = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, binAt);
  out.write('BIN\0', binAt + 4, 'ascii');
  binChunk.copy(out, binAt + 8);
  fs.writeFileSync(file, out);
  return total;
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// Every accessor is read out into a plain array of numbers and written back
// contiguously. The source interleaves several attributes into one bufferView
// with a byteStride; rebuilding rather than slicing is what lets attributes be
// dropped and retyped individually without unpicking that packing by hand.
function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const n = NUM_COMPONENTS[acc.type];
  const out = new Array(acc.count * n).fill(0);
  if (acc.bufferView == null) return out;
  const view = json.bufferViews[acc.bufferView];
  const bytes = COMPONENT_BYTES[acc.componentType];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride || n * bytes;
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    for (let c = 0; c < n; c++) {
      const b = at + c * bytes;
      switch (acc.componentType) {
        case 5126: out[i * n + c] = bin.readFloatLE(b); break;
        case 5125: out[i * n + c] = bin.readUInt32LE(b); break;
        case 5123: out[i * n + c] = bin.readUInt16LE(b); break;
        case 5122: out[i * n + c] = bin.readInt16LE(b); break;
        case 5121: out[i * n + c] = bin.readUInt8(b); break;
        case 5120: out[i * n + c] = bin.readInt8(b); break;
        default: throw new Error(`componentType ${acc.componentType}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- rebuilding

const src = readGLB(SRC);
const json = src.json;

const out = {
  asset: { ...json.asset, generator: 'seal-survivor tools/optimize-fisherman.mjs' },
  scene: json.scene,
  scenes: json.scenes,
  nodes: json.nodes,
  skins: json.skins,
  meshes: json.meshes,
  materials: json.materials,
  animations: json.animations,
  samplers: json.samplers,
  extensionsUsed: [],
  accessors: [],
  bufferViews: [],
  images: [],
  textures: [],
  buffers: [],
};

const chunks = [];
let offset = 0;

function pushView(buffer, extra = {}) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  chunks.push(buffer);
  const index = out.bufferViews.length;
  out.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length, ...extra });
  offset += buffer.length;
  return index;
}

const WRITERS = {
  5120: (buf, at, v) => buf.writeInt8(v, at),
  5126: (buf, at, v) => buf.writeFloatLE(v, at),
  5125: (buf, at, v) => buf.writeUInt32LE(v, at),
  5123: (buf, at, v) => buf.writeUInt16LE(v, at),
  5121: (buf, at, v) => buf.writeUInt8(v, at),
};

function pushAccessor(values, type, componentType, { normalized = false, target, bounds = false } = {}) {
  const n = NUM_COMPONENTS[type];
  const bytes = COMPONENT_BYTES[componentType];
  const buf = Buffer.alloc(values.length * bytes);
  const write = WRITERS[componentType];
  for (let i = 0; i < values.length; i++) write(buf, i * bytes, values[i]);
  const view = pushView(buf, target ? { target } : {});
  const count = values.length / n;
  const acc = { bufferView: view, componentType, count, type };
  if (normalized) acc.normalized = true;
  // min/max only where the spec asks for it — POSITION, and the time track of
  // an animation sampler. Emitting it everywhere else put 621 pairs of arrays
  // in the json for no reader's benefit, and the json is a real slice of a
  // file this small.
  if (bounds) {
    const min = new Array(n).fill(Infinity);
    const max = new Array(n).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < n; c++) {
        const v = values[i * n + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    acc.min = min;
    acc.max = max;
  }
  out.accessors.push(acc);
  return out.accessors.length - 1;
}

// --- the colour map ----------------------------------------------------------

const baseColorIndex = json.materials[0]?.pbrMetallicRoughness?.baseColorTexture?.index;
if (baseColorIndex == null) throw new Error('no base colour texture to keep');
const baseImage = json.images[json.textures[baseColorIndex].source];
const baseView = json.bufferViews[baseImage.bufferView];
const pngBytes = src.bin.subarray(baseView.byteOffset ?? 0, (baseView.byteOffset ?? 0) + baseView.byteLength);
const webp = await sharp(pngBytes).webp({ quality: WEBP_QUALITY }).toBuffer();

const imageView = pushView(webp);
out.images.push({ mimeType: 'image/webp', bufferView: imageView });
// Declared as an EXTENSION with no plain `source` fallback, so it also has to
// be listed as required: a loader without WebP support should fail loudly
// rather than silently render an untextured man.
out.extensionsUsed.push('EXT_texture_webp');
out.extensionsRequired = ['EXT_texture_webp'];
out.textures.push({ extensions: { EXT_texture_webp: { source: 0 } }, sampler: json.textures[baseColorIndex].sampler });
out.materials = [{
  name: json.materials[0].name,
  doubleSided: json.materials[0].doubleSided,
  pbrMetallicRoughness: {
    baseColorTexture: { index: 0 },
    // No metalness/roughness map any more, so state the constants the model
    // should be read at instead of leaving glTF's metallic default of 1.
    metallicFactor: 0,
    roughnessFactor: 1,
  },
}];

// --- the mesh ----------------------------------------------------------------

let keptVerts = 0;
let keptTris = 0;
let quantized = false;
for (const mesh of out.meshes) {
  for (const prim of mesh.primitives) {
    const attributes = {};
    for (const [name, index] of Object.entries(prim.attributes)) {
      if (DROP_ATTRIBUTES.includes(name)) continue;
      const acc = json.accessors[index];
      const values = readAccessor(json, src.bin, index);
      if (name === 'POSITION') keptVerts += acc.count;

      if (name === 'WEIGHTS_0') {
        // Renormalized as it is quantized: four bytes that must still sum to
        // 255, or the skinning shader scales the whole vertex.
        const bytes8 = new Array(values.length);
        for (let i = 0; i < acc.count; i++) {
          const at = i * 4;
          const sum = values[at] + values[at + 1] + values[at + 2] + values[at + 3] || 1;
          let rounded = 0;
          let biggest = 0;
          let biggestAt = 0;
          for (let c = 0; c < 4; c++) {
            const q = Math.round((values[at + c] / sum) * 255);
            bytes8[at + c] = q;
            rounded += q;
            if (q > biggest) { biggest = q; biggestAt = c; }
          }
          bytes8[at + biggestAt] += 255 - rounded; // put the rounding error on the dominant bone
        }
        attributes[name] = pushAccessor(bytes8, 'VEC4', 5121, { normalized: true });
        continue;
      }
      if (name === 'JOINTS_0') {
        attributes[name] = pushAccessor(values, 'VEC4', 5121);
        continue;
      }
      // Quantized where the precision is provably spare. A normal is a unit
      // vector — a signed byte resolves it to under half a degree, which is
      // finer than the outline shell (the only thing that reads normals here)
      // can show. A UV on this model lives in 0..1, where 16 bits is a
      // sixteen-thousandth of a texel. POSITION is deliberately left alone:
      // quantizing it means carrying a scale on the node, and this rig has
      // already been measured and bound against the geometry as it stands.
      if (name === 'NORMAL') {
        quantized = true;
        attributes[name] = pushAccessor(
          values.map((v) => Math.max(-127, Math.min(127, Math.round(v * 127)))),
          'VEC3', 5120, { normalized: true, target: 34962 },
        );
        continue;
      }
      if (name === 'TEXCOORD_0') {
        quantized = true;
        attributes[name] = pushAccessor(
          values.map((v) => Math.max(0, Math.min(65535, Math.round(v * 65535)))),
          'VEC2', 5123, { normalized: true, target: 34962 },
        );
        continue;
      }
      attributes[name] = pushAccessor(values, acc.type, acc.componentType, {
        target: 34962,
        bounds: name === 'POSITION',
      });
    }
    prim.attributes = attributes;
    if (prim.indices != null) {
      const acc = json.accessors[prim.indices];
      keptTris += acc.count / 3;
      const indices = readAccessor(json, src.bin, prim.indices);
      // 23,689 vertices fit in 16 bits with room to spare, and this is the
      // single biggest buffer in the file once the textures are dealt with.
      const wide = keptVerts > 65535;
      prim.indices = pushAccessor(indices, 'SCALAR', wide ? 5125 : 5123, { target: 34963 });
    }
    delete prim.material;
    prim.material = 0;
  }
}

// --- the skeleton ------------------------------------------------------------

for (const skin of out.skins) {
  if (skin.inverseBindMatrices == null) continue;
  skin.inverseBindMatrices = pushAccessor(readAccessor(json, src.bin, skin.inverseBindMatrices), 'MAT4', 5126);
}

// --- the animations ----------------------------------------------------------

let keysBefore = 0;
let keysAfter = 0;
let channelsBefore = 0;
let channelsAfter = 0;
for (const clip of out.animations) {
  // Only the long idle is thinned. See the note at the top.
  const long = clip.name.includes('idol');
  channelsBefore += clip.channels.length;
  const rebuilt = [];
  const remap = new Map();
  const keptChannels = [];

  for (const channel of clip.channels) {
    const sampler = clip.samplers[channel.sampler];
    const times = readAccessor(json, src.bin, sampler.input);
    const outAcc = json.accessors[sampler.output];
    const values = readAccessor(json, src.bin, sampler.output);
    const n = NUM_COMPONENTS[outAcc.type];
    keysBefore += times.length;

    // A TRACK THAT NEVER MOVES IS NOT A TRACK. This rig animates all 97 bones
    // in both clips, including a coat and a peg leg that hold perfectly still
    // for the whole idle. Dropping those channels leaves the bone in its rest
    // pose, which is exactly what the constant track was putting it in — and
    // it takes the keys, the accessors AND their json with it.
    let moves = false;
    for (let i = 1; i < times.length && !moves; i++) {
      for (let c = 0; c < n; c++) {
        if (Math.abs(values[i * n + c] - values[c]) > STATIC_EPSILON) { moves = true; break; }
      }
    }
    if (!moves) continue;

    let keepTimes = times;
    let keepValues = values;
    if (long && times.length > 2) {
      const span = times[times.length - 1] - times[0];
      const want = Math.max(2, Math.round(span * IDLE_HZ));
      const step = (times.length - 1) / (want - 1);
      keepTimes = [];
      keepValues = [];
      let last = -1;
      for (let k = 0; k < want; k++) {
        const i = Math.min(times.length - 1, Math.round(k * step));
        if (i === last) continue; // never emit the same key twice
        last = i;
        keepTimes.push(times[i]);
        for (let c = 0; c < n; c++) keepValues.push(values[i * n + c]);
      }
    }
    keysAfter += keepTimes.length;
    channelsAfter++;

    // Samplers are shared between channels in the source; rebuild each one
    // once and point every channel that used it at the copy.
    let index = remap.get(channel.sampler);
    if (index == null) {
      index = rebuilt.length;
      rebuilt.push({
        interpolation: sampler.interpolation ?? 'LINEAR',
        input: pushAccessor(keepTimes, 'SCALAR', 5126, { bounds: true }),
        output: pushAccessor(keepValues, outAcc.type, 5126),
      });
      remap.set(channel.sampler, index);
    }
    keptChannels.push({ ...channel, sampler: index });
  }

  clip.channels = keptChannels;
  clip.samplers = rebuilt;
}

// --- write -------------------------------------------------------------------

if (quantized) {
  // A loader that can't read quantized attributes must say so rather than
  // draw a folded-up man: this is REQUIRED, not merely used.
  out.extensionsUsed.push('KHR_mesh_quantization');
  out.extensionsRequired.push('KHR_mesh_quantization');
}

const bin = Buffer.concat(chunks);
out.buffers = [{ byteLength: bin.length }];
const total = writeGLB(OUT, out, bin);

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`${path.basename(SRC)}  ${(src.bytes / 1048576).toFixed(2)}MB`);
console.log(`${path.basename(OUT)}  ${(total / 1048576).toFixed(2)}MB   ${(src.bytes / total).toFixed(1)}x smaller`);
console.log(`  texture   ${(webp.length / 1024).toFixed(0)}KB webp q${WEBP_QUALITY}  ${pct(webp.length)}`);
console.log(`  mesh      ${keptVerts} verts / ${keptTris} tris, dropped ${DROP_ATTRIBUTES.join(', ')}`);
console.log(`  animation ${channelsBefore} channels -> ${channelsAfter}, ${keysBefore} keys -> ${keysAfter}`);
