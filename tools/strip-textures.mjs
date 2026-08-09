// Produce a texture-free copy of a GLB. Used to build the lightweight
// self-contained playtest page; the real project uses the full-quality files.
import fs from 'node:fs';
const [,, src, out] = process.argv;
const buf = fs.readFileSync(src);
let o = 12, json = null, bin = null;
while (o < buf.length) {
  const len = buf.readUInt32LE(o), t = buf.toString('ascii', o + 4, o + 8);
  if (t === 'JSON') json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
  if (t.startsWith('BIN')) bin = buf.subarray(o + 8, o + 8 + len);
  o += 8 + len;
}
// drop texture references, then drop the image bufferViews from the binary chunk
const dead = new Set();
for (const im of json.images || []) if (im.bufferView != null) dead.add(im.bufferView);
for (const m of json.materials || []) {
  for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
  if (m.pbrMetallicRoughness) for (const k of Object.keys(m.pbrMetallicRoughness)) if (/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
  if (m.extensions) for (const e of Object.values(m.extensions)) for (const k of Object.keys(e)) if (/Texture$/.test(k)) delete e[k];
}
delete json.textures; delete json.images; delete json.samplers;

// rebuild the buffer without the image bytes, remapping surviving bufferViews
const keep = json.bufferViews.map((bv, i) => ({ bv, i })).filter(({ i }) => !dead.has(i));
const parts = []; let offset = 0; const remap = new Map();
for (const { bv, i } of keep) {
  const start = bv.byteOffset || 0;
  const slice = bin.subarray(start, start + bv.byteLength);
  const pad = (4 - (slice.length % 4)) % 4;
  remap.set(i, parts.length);
  parts.push(Buffer.concat([slice, Buffer.alloc(pad)]));
  bv.byteOffset = offset;
  offset += slice.length + pad;
}
const newBin = Buffer.concat(parts);
json.bufferViews = keep.map(({ bv }) => bv);
for (const a of json.accessors) if (a.bufferView != null) a.bufferView = remap.get(a.bufferView);
json.buffers = [{ byteLength: newBin.length }];

const js = Buffer.from(JSON.stringify(json), 'utf8');
const jsPad = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + jsPad.length + 8 + newBin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsPad.length, 0); jh.write('JSON', 4, 'ascii');
const bh = Buffer.alloc(8); bh.writeUInt32LE(newBin.length, 0); bh.write('BIN\0', 4, 'ascii');
fs.writeFileSync(out, Buffer.concat([head, jh, jsPad, bh, newBin]));
console.log(`${src} ${(buf.length/1024).toFixed(0)}KB -> ${out} ${(fs.statSync(out).size/1024).toFixed(0)}KB`);
