#!/usr/bin/env node
// ============================================================================
// THE VERTEX LAYOUT FITS A BROWSER, and the shader and the pipeline agree
// about what it is.
//
//   npm run test:sealitaireattrs
//
// WHY THIS EXISTS. fish.wgsl grew a seventeenth vertex attribute with the
// tank rig, and seventeen is one more than WebGL2 guarantees: the spec's
// MAX_VERTEX_ATTRIBS floor is 16, and WebKit ships exactly the floor. So
// `@location(16)` failed to compile in every browser —
//
//   Ore GL shader compile error: 'location' : Attribute location out of range
//   skip make bindGroup (unresolved dep) / pipeline dropped pass draws
//
// — which is no fish in any tank on the live site, and dropped frames on a
// play. Nothing in this repo could see it: the native viewer has far more
// slots, so `sealitaire:shot` rendered all 52 cards perfectly, and the
// runtime that did fail said only "unresolved dep, churn" until the web
// runtime was bumped past 2.42.0. A whole feature was dead in public while
// every check here was green.
//
// So the ceiling is asserted here rather than discovered there. It is a
// static read of two files — no GL, no browser, milliseconds — because the
// only place this is observable is the one place the tests cannot go.
//
// THE SECOND CHECK IS THE ONE THAT WOULD HAVE CAUGHT THE FIX GOING WRONG.
// The shader declares the attributes; table.luau's `vertexLayout` declares
// the buffers they come from. They are two lists in two files that have to
// say the same thing, and when they disagree nothing errors — the stage just
// reads whatever is at that offset, which is a plausible number and a wrong
// picture. Packing the bend row out of its own attribute meant editing both,
// and this is what says they still match.
// ============================================================================
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = join(ROOT, 'rive/sealitaire');

// WebGL2's guaranteed minimum, which WebKit ships exactly. Not a budget to
// spend up to on this machine's driver: the number that has to hold on a
// phone none of us is holding.
const MAX_VERTEX_ATTRIBS = 16;

const code = (line) => line.split('//')[0];

/** The @location list of one WGSL struct, comments ignored. */
function locations(src, struct) {
  const body = new RegExp(`struct ${struct} \\{([\\s\\S]*?)\\n\\};`).exec(src);
  assert.ok(body, `fish.wgsl has a ${struct} struct`);
  const out = [];
  for (const line of body[1].split('\n')) {
    const m = /@location\((\d+)\)/.exec(code(line));
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

const wgsl = readFileSync(join(P, 'fish.wgsl'), 'utf8');
const vsIn = locations(wgsl, 'VSIn');

let checks = 0;
assert.ok(vsIn.length > 0, 'VSIn declares attributes');
assert.ok(vsIn.length <= MAX_VERTEX_ATTRIBS,
  `fish.wgsl declares ${vsIn.length} vertex attributes; WebGL2 guarantees ${MAX_VERTEX_ATTRIBS}, so this compiles nowhere in a browser and everywhere in the native viewer`);
assert.equal(vsIn[vsIn.length - 1], vsIn.length - 1,
  `vertex attribute locations must run 0..${vsIn.length - 1} with no gap; got ${vsIn.join(', ')}`);
checks += 3;

// The pipeline's own list, from the two shared layout constants in
// table.luau. Read as text on purpose: importing Luau is not on the table,
// and the point is to compare what each FILE says.
const table = readFileSync(join(P, 'table.luau'), 'utf8');
const layoutSlots = [];
for (const name of ['VERTEX_LAYOUT', 'INSTANCE_LAYOUT']) {
  const block = new RegExp(`local ${name}[^\\n]*=([\\s\\S]*?)\\n    \\} \\}`).exec(table);
  assert.ok(block, `table.luau declares ${name}`);
  for (const m of block[1].matchAll(/slot = (\d+)/g)) layoutSlots.push(Number(m[1]));
  checks++;
}
layoutSlots.sort((a, b) => a - b);

assert.deepEqual(layoutSlots, vsIn,
  `the pipeline's vertex layout and fish.wgsl's VSIn must name the same locations.\n  shader:   ${vsIn.join(', ')}\n  pipeline: ${layoutSlots.join(', ')}`);
checks++;

// Every instance attribute has to sit inside the record baitball writes, or
// the last one reads past the end of a body and into the next.
const bait = readFileSync(join(P, 'baitball.luau'), 'utf8');
const stride = Number(/local STRIDE = (\d+)/.exec(bait)?.[1]);
assert.ok(Number.isFinite(stride), 'baitball.luau declares a STRIDE');
const inst = /local INSTANCE_LAYOUT[^\n]*=([\s\S]*?)\n    \} \}/.exec(table)[1];
const offsets = [...inst.matchAll(/offset = (\d+)/g)].map((m) => Number(m[1]));
const past = offsets.filter((o) => o + 16 > stride);
assert.equal(past.length, 0,
  `an instance attribute at offset ${past.join(', ')} runs past baitball's ${stride}-byte record`);
checks += 2;

console.log(`sealitaire attrs: ${checks} checks passed — ${vsIn.length}/${MAX_VERTEX_ATTRIBS} vertex attributes, layout agrees, instance record ${stride} bytes`);
