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
  const fits = new Map();
  let key = null;
  for (const line of src) {
    const open = line.match(/^ {2}(\w+):\s*\{/);
    if (open) key = open[1];
    if (!key) continue;
    const fit = line.match(/^\s*fit:\s*([\d.]+)/);
    if (fit) fits.set(key, parseFloat(fit[1]));
    const model = line.match(/model:\s*'\/models\/([^']+)'/);
    if (model) {
      if (!map.has(model[1])) map.set(model[1], []);
      map.get(model[1]).push(key);
    }
  }
  return { map, fits };
}

// --- how big is it actually on screen ---------------------------------------
//
// The number that decides whether a map is the right size, and the one that is
// impossible to eyeball: a creature's texture budget is set by the pixels it
// covers, and NOTHING here covers many.
//
// The camera is orthographic and frames CONFIG.arena.viewHeight world units top
// to bottom whatever the window is, so pixels-per-world-unit is just the canvas
// height over that. A model's world size is `fit` (its longest axis, in world
// units) times the size multiplier from assets.csv — see the note in that file
// about why the multiplier is not optional reading.
const VIEW_HEIGHT = 52; // CONFIG.arena.viewHeight

function sizesByKey() {
  const csv = fs.readFileSync(path.join(ROOT, 'path/src/assets.csv'), 'utf8').split('\n');
  const out = new Map();
  for (const line of csv.slice(1)) {
    const m = line.match(/^([\w]+),([\d.]+)/);
    if (m) out.set(m[1], parseFloat(m[2]));
  }
  return out;
}

// Rounded up to a power of two, which is the only thing worth shipping: a
// non-power-of-two map costs the same VRAM as the next one up and loses the mip
// chain on some drivers.
const pot = (n) => 2 ** Math.max(5, Math.ceil(Math.log2(Math.max(1, n))));

// --- report -----------------------------------------------------------------

const { map: users, fits } = keysByModel();
const sizes = sizesByKey();

// Two windows, because the answer has to hold for both and they are a factor of
// four apart. The first is what the playtest logs actually record
// (render.mpix 0.54 at pixelRatio 0.65); the second is a full-screen 4K panel at
// device pixel ratio 1, which is as many pixels as this game will ever be asked
// to cover.
const WINDOWS = [
  { label: 'logged window', px: 581 },
  { label: '4K full screen', px: 2160 },
];

// And the frame is not always the resting one. The cinematic rig pushes in to
// cinecam.base.zoomMax, and it does it for the kill shot — the single most
// looked-at moment in a run, held on a stopped clock. A map sized for the
// resting frame is a map that goes soft exactly there, which is the worst
// possible place to save memory. Everything in frame scales, not just the
// subject, so this multiplies every row.
const ZOOM_MAX = 3.15; // CONFIG.cinecam.base.zoomMax

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

// --- what size the map should actually be -----------------------------------
//
// Not a rule of thumb: the widest this model ever gets on screen, in pixels,
// against the map it carries. A map bigger than that is texels the rasteriser
// averages away and the GPU pays to hold — and the mip chain means it does not
// even look sharper, it looks identical.
console.log('SIZE — the map each model can justify, from how many pixels it covers:\n');
console.log('  model                     on screen (px)      biggest map   justified   saved');
console.log('  ' + '-'.repeat(80));

let vramNow = 0;
let vramRight = 0;

for (const r of rows) {
  // The biggest key using this model, since one map serves them all.
  let world = 0;
  let via = null;
  for (const k of r.keys) {
    const w = (fits.get(k) ?? 0) * (sizes.get(k) ?? 1);
    if (w > world) { world = w; via = k; }
  }
  if (!world) continue;

  const spans = WINDOWS.map((w) => world * (w.px / VIEW_HEIGHT));
  const widest = Math.max(...spans) * ZOOM_MAX;
  const biggest = Math.max(...r.imgs.map((i) => Math.max(i.w, i.h)));
  // One texel per pixel at the largest the model ever gets, rounded up. No
  // headroom multiplier: the mip chain already means a map sampled below 1:1
  // costs nothing in sharpness, and the 4K row above is already the ceiling.
  const want = Math.min(biggest, pot(widest));

  const now = r.vram;
  const then = r.imgs.reduce((s, i) => s + vramOf({
    w: Math.min(i.w, want), h: Math.min(i.h, want),
  }), 0);
  vramNow += now;
  vramRight += then;

  if (want >= biggest) continue; // already the right size or smaller
  console.log(
    `  ${r.file.padEnd(24)} ${spans.map((s) => s.toFixed(0).padStart(5)).join(' /')}      `
    + `${String(biggest).padStart(6)}²   ${String(want).padStart(6)}²   `
    + `${((now - then) / MB).toFixed(1).padStart(5)}MB   (${via})`,
  );
}

console.log('  ' + '-'.repeat(80));
console.log(`  ${(vramNow / MB).toFixed(0)}MB -> ${(vramRight / MB).toFixed(0)}MB across the roster`);
console.log(`  on-screen px are ${WINDOWS.map((w) => w.label).join(' / ')}, at rest`);
console.log(`  the justified column already carries the ${ZOOM_MAX}x cinematic push\n`);
console.log('  A CEILING, NOT A TARGET. This assumes the map is spread evenly over the');
console.log('  model, and a UV layout that gives the face its own big island wants more');
console.log('  than the average says. Step down one power of two, look at it, step again.\n');
