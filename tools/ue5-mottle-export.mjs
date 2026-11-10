// Export the player seal's mottling for the UE5 material.
//
//   node --import ./tools/vite-loader.mjs tools/ue5-mottle-export.mjs [outdir]
//
// Writes build/ue5-mottle/ (default):
//   params.json     the shader's inputs, resolved from CONFIG.sealShader (saved tuning applied),
//                   colours given both as hex and as LINEAR floats (what UE wants)
//   reference.json  the noise value at the seal's landmark vertices, in the mesh's own (glTF) space.
//                   Use it to check the UE material against the three.js one: if the numbers
//                   disagree, the axis remap or the unit scale is wrong, not the noise.
//
// The shader itself is design/ue5/materials/SealMottle.hlsl; the maths it ports is
// path/src/systems/noiseGlsl.js (mottleGlsl, noiseFbm, perlin3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(root, 'build', 'ue5-mottle'));
fs.mkdirSync(out, { recursive: true });

// --- parameters --------------------------------------------------------------
const s = CONFIG.sealShader;
// three.js (r152+) converts hex colours sRGB -> linear on THREE.Color, so the shader's
// uniforms are linear. UE colour parameters are linear too: feed it these, not the hex.
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => v / 255);
const col = (hex) => ({ hex: '#' + (hex >>> 0).toString(16).padStart(6, '0'), linear: rgb(hex).map(lin) });

let shipMaterial = null;
try {
  shipMaterial = (await import('../path/src/assets.js')).ASSETS?.ship?.material ?? null;
} catch (err) {
  console.warn('[ue5-mottle] could not read ASSETS.ship.material:', err.message);
}

const params = {
  note: 'Player seal = base CONFIG.sealShader (no preset). Sizes are in the GLB mesh\'s own units, BEFORE ' +
    'the game\'s fit scale, because the shader samples the raw bind-pose vertex.',
  mottle: {
    size: s.size, strength: s.strength, contrast: s.contrast,
    color: col(s.color), baseColor: col(s.baseColor), paint: s.paint,
    seed: [0, 0, 0],
  },
  // Not ported yet: wet film (wet*), sky/ocean split (split*), glow layers. Values kept so the
  // next pass starts from the real numbers.
  deferred: Object.fromEntries(Object.entries(s).filter(([k]) =>
    /^(wet|split)/.test(k) && !['presets'].includes(k)).map(([k, v]) => [k, v])),
  material: shipMaterial && {
    roughness: shipMaterial.roughness, metalness: shipMaterial.metalness,
    emissive: col(shipMaterial.emissive), emissiveIntensity: shipMaterial.emissiveIntensity,
  },
};

// --- reference values --------------------------------------------------------
// Same maths as noiseGlsl.js, in double precision. GLSL/HLSL run it in float32 and
// `fract(sin(x) * 43758.5453)` is notoriously GPU-dependent, so expect the UE pattern to
// match this in character and phase but not freckle-for-freckle on every GPU. The
// reference is for catching a wrong axis or scale (large errors), not for pixel equality.
const fract = (x) => x - Math.floor(x);
const hash3 = ([x, y, z]) => {
  const p = [x * 127.1 + y * 311.7 + z * 74.7, x * 269.5 + y * 183.3 + z * 246.1, x * 113.5 + y * 271.9 + z * 124.6];
  return p.map((v) => -1 + 2 * fract(Math.sin(v) * 43758.5453123));
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a, b, t) => a + (b - a) * t;
function perlin3(p) {
  const i = p.map(Math.floor), f = p.map((v, k) => v - i[k]);
  const u = f.map((v) => v * v * (3 - 2 * v));
  const g = (dx, dy, dz) => dot(hash3([i[0] + dx, i[1] + dy, i[2] + dz]), [f[0] - dx, f[1] - dy, f[2] - dz]);
  return mix(
    mix(mix(g(0, 0, 0), g(1, 0, 0), u[0]), mix(g(0, 1, 0), g(1, 1, 0), u[0]), u[1]),
    mix(mix(g(0, 0, 1), g(1, 0, 1), u[0]), mix(g(0, 1, 1), g(1, 1, 1), u[0]), u[1]), u[2]);
}
function fbm(p) {
  let v = 0, a = 0.5, q = p;
  for (let k = 0; k < 3; k++) { v += a * perlin3(q); q = q.map((c) => c * 2.02); a *= 0.5; }
  return v;
}
const noiseN = (pos) => Math.min(1, Math.max(0,
  fbm(pos.map((c, k) => (c + params.mottle.seed[k]) / Math.max(0.0001, s.size))) * s.contrast * 0.5 + 0.5));

// POSITION accessor of the seal mesh, straight out of the GLB (this is `transformed` in three.js).
const glb = fs.readFileSync(path.join(root, 'public', 'models', 'furseal.glb'));
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
const bin = glb.subarray(20 + jsonLen + 8);
const prim = gltf.meshes[0].primitives[0];
const acc = gltf.accessors[prim.attributes.POSITION];
const bv = gltf.bufferViews[acc.bufferView];
const stride = bv.byteStride ?? 12;
const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
const verts = Array.from({ length: acc.count }, (_, i) => [0, 4, 8].map((o) => bin.readFloatLE(base + i * stride + o)));

const extreme = (axis, sign) => verts.reduce((best, v) => (sign * v[axis] > sign * best[axis] ? v : best));
// GLB accessor space -> UE local space (cm), for a skeletal mesh built by tools/ue5-seal-export.py.
// Step 1, MEASURED (Blender glTF import, 1374 of 1374 vertices, max error 4e-7):
//   blender = (acc.x, -(acc.z + 0.2081), acc.y - 0.1347)      // Y-up -> Z-up, plus a 0.13/0.21 shift
// Step 2: tools/ue5-seal-export.py yaws the seal +90 deg about Z (head to +X, CONFIRMED in UE 5.9 by the
//   Windows session) and scales x100. UE's importer also mirrors Y for handedness (CONFIRMED: hand_L_014 at Y -50 cm in UE), so a
//   correctly imported seal has its LEFT flipper on UE -Y. That gives (b = blender coords above):
//     ue = 100 * (-b.y, -b.x, b.z)
const accToUe = ([ax, ay, az]) => {
  const b = [ax, -(az + 0.2081), ay - 0.1347];
  return [-b[1] * 100, -b[0] * 100, b[2] * 100];
};
const landmarks = {
  'nose (+Z, forward)': extreme(2, 1), 'tail (-Z)': extreme(2, -1),
  'back (+Y, up)': extreme(1, 1), 'belly (-Y)': extreme(1, -1),
  'side +X': extreme(0, 1), 'side -X': extreme(0, -1),
};
const reference = {
  note: 'positions are the GLB accessor values (glTF: +Y up, +Z forward, right-handed). n is noiseN at the shipped size/contrast, seed 0.',
  vertexCount: verts.length,
  // What the HLSL does: acc = ( -P.y*0.01, P.z*0.01 + 0.1347, P.x*0.01 - 0.2081 ) for P = Pre-Skinned Local Position in cm.
  ueToAccessor: { x: '-P.y * 0.01', y: 'P.z * 0.01 + 0.1347', z: 'P.x * 0.01 - 0.2081' },
  bounds: { min: [0, 1, 2].map((a) => Math.min(...verts.map((v) => v[a]))), max: [0, 1, 2].map((a) => Math.max(...verts.map((v) => v[a]))) },
  landmarks: Object.fromEntries(Object.entries(landmarks).map(([k, v]) => [k, { position: v, ueLocalCm: accToUe(v).map((c) => +c.toFixed(2)), n: noiseN(v) }])),
};

fs.writeFileSync(path.join(out, 'params.json'), JSON.stringify(params, null, 2));
fs.writeFileSync(path.join(out, 'reference.json'), JSON.stringify(reference, null, 2));
console.log(`[ue5-mottle] size ${s.size}, strength ${s.strength}, contrast ${s.contrast}, ${verts.length} verts -> ${out}`);
for (const [k, v] of Object.entries(reference.landmarks)) {
  console.log(`  ${k.padEnd(20)} acc ${v.position.map((c) => c.toFixed(3)).join(', ').padEnd(22)} UE cm ${v.ueLocalCm.join(', ').padEnd(22)} n=${v.n.toFixed(4)}`);
}
