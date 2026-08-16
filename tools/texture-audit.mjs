// ---------------------------------------------------------------------------
// What every model's textures actually cost — `npm run tex`.
//
// Two costs, and they have two different fixes, which is the whole reason this
// prints both columns instead of one number:
//
//   DISK is what the player downloads and the decoder unpacks. It is decided by
//     the compression: the same 1024-square map is 1.4MB as PNG and 200KB as
//     WebP. Fixing it is a re-encode and it changes nothing on screen.
//   VRAM is what the GPU holds. It is decided by the PIXEL DIMENSIONS and
//     nothing else — a WebP and a PNG of the same size are byte-identical once
//     uploaded, both RGBA8, both ×4/3 for the mip chain. Fixing it means fewer
//     pixels, which is a visible change and has to be judged per model.
//
// Reading one for the other is the trap. Four of these models are already WebP
// and sit near the bottom of the disk column while costing exactly as much VRAM
// as the PNG ones beside them.
//
// Why VRAM is worth watching at all: past the device's texture budget the
// driver does not fail, it PAGES — evicting and re-uploading under you for the
// rest of the session. That is continuous hitching rather than one stall, and
// it lands hardest on a phone. See the note in systems/shaderWarmup.js about
// why the warm-up deliberately does NOT make all of this resident at boot.
//
// Dimensions are read out of the file headers directly rather than by decoding
// anything, so this is fast and needs no image library.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public/models');

// --- header readers ---------------------------------------------------------

// IHDR is always the first chunk of a PNG, at a fixed offset.
const pngSize = (buf, o) => ({ w: buf.readUInt32BE(o + 16), h: buf.readUInt32BE(o + 20), fmt: 'png' });

// JPEG is a marker walk. The frame header (SOF0..SOF15, minus the three that
// aren't frames) carries the dimensions; everything before it is skipped by its
// own length field. Markers without a payload have to be stepped over by hand,
// and a desync means the offset was wrong — better to report nothing than to
// read two arbitrary bytes as a size.
function jpegSize(buf, o, end) {
  if (buf[o] !== 0xff || buf[o + 1] !== 0xd8) return null;
  let i = o + 2;
  while (i < end - 1) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }                                 // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }  // no payload
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), fmt: 'jpg' };
    }
    if (m === 0xda) return null;                                       // scan data, no frame header
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// WebP is a RIFF container with three payload flavours, each storing the size
// differently. VP8X is the extended form, VP8L lossless, VP8 lossy.
function webpSize(buf, o) {
  if (buf.toString('ascii', o, o + 4) !== 'RIFF' || buf.toString('ascii', o + 8, o + 12) !== 'WEBP') return null;
  switch (buf.toString('ascii', o + 12, o + 16)) {
    case 'VP8X': return { w: buf.readUIntLE(o + 24, 3) + 1, h: buf.readUIntLE(o + 27, 3) + 1, fmt: 'webp' };
    case 'VP8L': {
      const b = buf.readUInt32LE(o + 21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, fmt: 'webp' };
    }
    case 'VP8 ': return { w: buf.readUInt16LE(o + 26) & 0x3fff, h: buf.readUInt16LE(o + 28) & 0x3fff, fmt: 'webp' };
    default: return null;
  }
}

// --- the models -------------------------------------------------------------

// A GLB is a 12-byte header, a JSON chunk, then the binary chunk. Images are
// bufferViews into the second one, and `mimeType` says which reader to use —
// but the magic bytes are checked instead, because an exporter that writes
// image/png over a WebP payload is exactly the kind of thing this should
// survive rather than mis-report.
function glbImages(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const out = [];
  for (const img of json.images ?? []) {
    if (img.bufferView == null) continue; // an external URI; counted with the loose textures
    const view = json.bufferViews[img.bufferView];
    const o = binStart + (view.byteOffset ?? 0);
    const size = buf[o] === 0x89 ? pngSize(buf, o)
      : buf.toString('ascii', o, o + 4) === 'RIFF' ? webpSize(buf, o)
      : jpegSize(buf, o, o + view.byteLength);
    if (size) out.push({ ...size, bytes: view.byteLength });
    else out.push({ w: 0, h: 0, fmt: '?', bytes: view.byteLength });
  }
  return out;
}

// RGBA8 plus the mip chain, which is the +1/3 — the renderer builds mips for
// everything here, so leaving them out understates every row by a quarter.
const vramOf = (i) => (i.w * i.h * 4 * 4) / 3;
const MB = 1048576;

// --- which asset keys use each model ---------------------------------------
//
// Scanned out of assets.js rather than imported: config.js pulls in a JSON
// module, which plain Node refuses to load without a shim, and this only needs
// two shapes of line.
function keysByModel() {
  const src = fs.readFileSync(path.join(ROOT, 'path/src/assets.js'), 'utf8').split('\n');
  const map = new Map();
  let key = null;
  for (const line of src) {
    const open = line.match(/^ {2}(\w+):\s*\{/);
    if (open) key = open[1];
    const model = line.match(/model:\s*'\/models\/([^']+)'/);
    if (model && key) {
      if (!map.has(model[1])) map.set(model[1], []);
      map.get(model[1]).push(key);
    }
  }
  return map;
}

// --- report -----------------------------------------------------------------

const users = keysByModel();
const rows = [];

for (const file of fs.readdirSync(MODELS)) {
  if (!file.endsWith('.glb')) continue; // FBX embeds nothing; see the loose-texture note below
  const buf = fs.readFileSync(path.join(MODELS, file));
  const imgs = glbImages(buf);
  if (!imgs.length) continue;
  rows.push({
    file,
    disk: buf.length,
    imgs,
    vram: imgs.reduce((s, i) => s + vramOf(i), 0),
    keys: users.get(file) ?? [],
  });
}

rows.sort((a, b) => b.vram - a.vram);

console.log('  VRAM     disk   model                       maps                         used by');
console.log('  ' + '-'.repeat(100));

let vramTotal = 0;
let diskTotal = 0;
for (const r of rows) {
  vramTotal += r.vram;
  diskTotal += r.disk;
  // Collapsed: six identical 1024s read as "6x 1024²png", which is the shape of
  // the problem, where six repetitions of the same string is just noise.
  const counts = new Map();
  for (const i of r.imgs) {
    const label = `${i.w}²${i.fmt}`.replace(/^(\d+)²/, (m, w) => (i.w === i.h ? `${w}²` : `${i.w}x${i.h}`));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const maps = [...counts].map(([l, n]) => (n > 1 ? `${n}x ${l}` : l)).join(' ');
  const who = r.keys.length ? r.keys.slice(0, 3).join(',') + (r.keys.length > 3 ? `+${r.keys.length - 3}` : '') : '— unused —';
  console.log(
    `${(r.vram / MB).toFixed(1).padStart(6)}MB ${(r.disk / MB).toFixed(2).padStart(6)}MB   ${r.file.padEnd(24)} ${maps.padEnd(28)} ${who}`,
  );
}

console.log('  ' + '-'.repeat(100));
console.log(`${(vramTotal / MB).toFixed(0).padStart(6)}MB ${(diskTotal / MB).toFixed(1).padStart(6)}MB   ${rows.length} models\n`);

// The two fix lists, kept separate on purpose — see the header. A model can be
// on both, and the work is unrelated in each case.
const png = rows
  .flatMap((r) => r.imgs.filter((i) => i.fmt === 'png').map((i) => ({ r, i })))
  .reduce((m, { r, i }) => m.set(r, (m.get(r) ?? 0) + i.bytes), new Map());

if (png.size) {
  const byBytes = [...png].sort((a, b) => b[1] - a[1]);
  const total = byBytes.reduce((s, [, b]) => s + b, 0);
  console.log(`DOWNLOAD — ${(total / MB).toFixed(1)}MB of PNG that WebP would cut by roughly 80%, no visible change:`);
  for (const [r, bytes] of byBytes.slice(0, 8)) {
    console.log(`  ${(bytes / MB).toFixed(2).padStart(6)}MB  ${r.file}`);
  }
  console.log();
}

const big = rows.filter((r) => r.vram > 15 * MB);
if (big.length) {
  console.log('VRAM — models over 15MB. Halving a map quarters its cost, so 1024 -> 512 is the lever:');
  for (const r of big) {
    console.log(`  ${(r.vram / MB).toFixed(1).padStart(6)}MB  ${r.file.padEnd(24)} ${(r.vram / 4 / MB).toFixed(1)}MB at half size`);
  }
}
