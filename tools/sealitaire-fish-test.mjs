#!/usr/bin/env node
// The tank pack's contract with table.luau and fish.wgsl, checked on the
// file actually on disk: the v3 header, the strides, every joint inside its
// species' palette, every vertex's weights summing to one (unorm8 rounding
// shrinks a body otherwise), every palette finite, and — the one that
// matters — a species with a clip really MOVES: skinned on the CPU the way
// the shader does it, its frames differ from its rest pose and stay the size
// of the creature. A baker that quietly wrote identity palettes, or a
// relative-palette bug that blew the body up, both fail here rather than
// rendering something plausible.
//
// TNK3 added the rig (rigs.csv): every bone's parent and rest head, and the
// chains a contact may shove. What is checked of it is what a solver would
// trip over — a parent that is not a real slot or is not ABOVE its child (a
// cycle would hang the solve), a chain naming a slot outside the palette, a
// chain of fewer than two bones (nothing to bend), and a rest head that is
// not finite or sits outside the body it belongs to.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const buf = readFileSync(join(ROOT, 'rive/sealitaire/fish.mesh'));
assert.equal(buf.toString('latin1', 0, 4), 'TNK3', 'fish.mesh is a v3 pack (run npm run sealitaire:fish)');
const nspecies = buf.readUInt32LE(4), vcount = buf.readUInt32LE(8), icount = buf.readUInt32LE(12), pfloats = buf.readUInt32LE(16);
const bcount = buf.readUInt32LE(20), cwords = buf.readUInt32LE(24);
const HEAD = 32, REC = 80, VSTRIDE = 32, BREC = 16;
const vStart = HEAD + nspecies * REC, iStart = vStart + vcount * VSTRIDE;
const bStart = iStart + icount * 4, cStart = bStart + bcount * BREC, pStart = cStart + cwords * 4;
assert.equal(buf.length, pStart + pfloats * 4, 'the file is exactly header + records + vertices + indices + bones + chains + palette');

let checks = 3, clipped = 0;
const species = [];
for (let k = 0; k < nspecies; k++) {
  const r = HEAD + k * REC;
  const name = buf.toString('latin1', r, r + 24).replace(/\0.*$/, '');
  const s = {
    name, vo: buf.readUInt32LE(r + 24), vc: buf.readUInt32LE(r + 28), io: buf.readUInt32LE(r + 32), ic: buf.readUInt32LE(r + 36),
    bones: buf.readUInt32LE(r + 48), frames: buf.readUInt32LE(r + 52), duration: buf.readFloatLE(r + 56), po: buf.readUInt32LE(r + 60),
    bo: buf.readUInt32LE(r + 64), chains: buf.readUInt32LE(r + 68), co: buf.readUInt32LE(r + 72),
  };
  species.push(s);
  assert.ok(s.bones >= 1 && s.frames >= 1, `${name}: at least one bone and one frame`);
  assert.ok(s.po + s.bones * s.frames * 12 <= pfloats, `${name}: palette inside the block`);
  if (s.frames > 1) assert.ok(s.duration > 0, `${name}: a clip has a duration`);
  checks += 2;
}
assert.equal(species[0].name, 'bubble', 'the bubble is species 0');

// --- the rig ---------------------------------------------------------------
let rigged = 0, sprung = 0;
for (const s of species) {
  assert.ok(s.bo + s.bones <= bcount, `${s.name}: bones inside the block`);
  const head = (sl) => {
    const o = bStart + (s.bo + sl) * BREC;
    return { parent: buf.readUInt32LE(o), h: [buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)] };
  };
  for (let sl = 0; sl < s.bones; sl++) {
    const b = head(sl);
    for (const v of b.h) assert.ok(Number.isFinite(v), `${s.name}: bone ${sl} head is finite`);
    if (b.parent !== 0xFFFFFFFF) {
      assert.ok(b.parent < s.bones, `${s.name}: bone ${sl} parent ${b.parent} is a real slot`);
      // ABOVE it, always: the solver walks root to tip, and a parent at or
      // below its child is a cycle waiting to hang the composition.
      assert.ok(b.parent < sl, `${s.name}: bone ${sl} parent ${b.parent} is above it`);
    }
    checks += 2;
  }
  if (s.chains === 0) continue;
  rigged++;
  // The body's own box, from its vertices: a bone head outside it is a
  // canonicalisation that missed the rig, which would put every bend in the
  // wrong place and still render a perfectly good creature.
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < s.vc; v++) {
    const o = vStart + (s.vo + v) * VSTRIDE;
    for (let c = 0; c < 3; c++) { const q = buf.readFloatLE(o + c * 4); mn[c] = Math.min(mn[c], q); mx[c] = Math.max(mx[c], q); }
  }
  let w = cStart + s.co * 4;
  for (let c = 0; c < s.chains; c++) {
    const role = buf.readUInt32LE(w), n = buf.readUInt32LE(w + 4);
    w += 8;
    assert.ok(role === 0 || role === 1, `${s.name}: chain ${c} role ${role} is tail or fin`);
    assert.ok(n >= 2, `${s.name}: chain ${c} has ${n} bones; a chain of one cannot bend`);
    for (let i = 0; i < n; i++) {
      const sl = buf.readUInt32LE(w); w += 4;
      assert.ok(sl > 0 && sl < s.bones, `${s.name}: chain ${c} bone ${i} is slot ${sl}, outside its ${s.bones}`);
      const b = head(sl);
      for (let ax = 0; ax < 3; ax++) {
        assert.ok(b.h[ax] >= mn[ax] - 0.1 && b.h[ax] <= mx[ax] + 0.1, `${s.name}: chain ${c} bone ${i} head ${b.h[ax].toFixed(3)} is off the body on axis ${ax} (${mn[ax].toFixed(2)}..${mx[ax].toFixed(2)})`);
      }
      sprung++;
      checks += 2;
    }
    assert.ok(w <= cStart + cwords * 4, `${s.name}: chain ${c} inside the block`);
    checks += 2;
  }
}
// EVERY RIG THAT THE SHIP BAKE COULD CARRY, derived rather than counted.
//
// This read `rigged >= 7` — a number, under a message claiming a relationship
// it never checked. rigs.csv rigs seven species, but `npm run sealitaire:fish`
// bakes tanks.csv ALONE (pool.csv needs --pool), and `dolphin` is a pool
// species: it appears in tanks.csv only inside a notes cell. So the ship pack
// has six rigs and always will, and the seventh went red the day the dolphin
// moved to the pool rather than the day a rig broke.
//
// What the message says is the useful check, so that is what runs now: every
// species rigs.csv names AND tanks.csv actually places must come out of the
// pack rigged. A rig for a species no tank holds is an unused rig, not a
// failure — and a rig that silently failed to bake is still caught, which is
// the whole point.
const csvCol = (text, col) => {
  const lines = text.trim().split('\n');
  const at = lines[0].split(',').indexOf(col);
  return at < 0 ? [] : lines.slice(1).map((l) => l.split(',')[at]?.trim()).filter(Boolean);
};
const rigNames = new Set(csvCol(readFileSync(join(ROOT, 'rive/sealitaire/rigs.csv'), 'utf8'), 'species'));
const tankNames = new Set(csvCol(readFileSync(join(ROOT, 'rive/sealitaire/tanks.csv'), 'utf8'), 'model'));
const wanted = [...rigNames].filter((n) => tankNames.has(n)).sort();
const got = species.filter((s) => s.chains > 0).map((s) => s.name).sort();
const missed = wanted.filter((n) => !got.includes(n));
assert.ok(missed.length === 0,
  `every rigged species tanks.csv places reached the pack — missing ${missed.join(', ')} of ${wanted.join(', ')}`);
// ...and the rigs that are only in the pool are named, not silently dropped:
// a rig nothing places is dead weight worth seeing.
const poolOnly = [...rigNames].filter((n) => !tankNames.has(n)).sort();
if (poolOnly.length) console.log(`  --   rigged but not in any tank (pool only): ${poolOnly.join(', ')}`);
checks++;

const palette = (s, f, j) => {
  const o = pStart + (s.po + (f * s.bones + j) * 12) * 4;
  const m = [];
  for (let i = 0; i < 12; i++) { const v = buf.readFloatLE(o + i * 4); assert.ok(Number.isFinite(v), `${s.name}: palette finite`); m.push(v); }
  return m; // rows r0 r1 r2 of a 3x4
};
const apply = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];

for (const s of species) {
  let maxJoint = 0;
  for (let v = 0; v < s.vc; v++) {
    const o = vStart + (s.vo + v) * VSTRIDE;
    const w = buf[o + 28] + buf[o + 29] + buf[o + 30] + buf[o + 31];
    assert.equal(w, 255, `${s.name}: vertex ${v} weights sum to 255`);
    for (let c = 0; c < 4; c++) if (buf[o + 28 + c] > 0) maxJoint = Math.max(maxJoint, buf[o + 24 + c]);
  }
  assert.ok(maxJoint < s.bones, `${s.name}: joints (max ${maxJoint}) inside its ${s.bones} bones`);
  for (let i = 0; i < s.ic; i++) {
    const idx = buf.readUInt32LE(iStart + (s.io + i) * 4);
    assert.ok(idx >= s.vo && idx < s.vo + s.vc, `${s.name}: index ${i} inside its vertices`);
  }
  checks += 2;
  if (s.frames > 1) {
    // Skin every vertex at rest (frame 0) and a frame half way through; the
    // body must move, and its long axis must stay near 1 (the rest length).
    clipped++;
    let moved = 0, ext = [Infinity, -Infinity];
    const mid = Math.floor(s.frames / 2);
    const cache = new Map();
    const bone = (f, j) => { const key = f * 4096 + j; if (!cache.has(key)) cache.set(key, palette(s, f, j)); return cache.get(key); };
    for (let v = 0; v < s.vc; v++) {
      const o = vStart + (s.vo + v) * VSTRIDE;
      const x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
      const skin = (f) => {
        const p = [0, 0, 0];
        for (let c = 0; c < 4; c++) {
          const w = buf[o + 28 + c] / 255; if (!w) continue;
          const q = apply(bone(f, buf[o + 24 + c]), x, y, z);
          for (let d = 0; d < 3; d++) p[d] += q[d] * w;
        }
        return p;
      };
      const a = skin(0), b = skin(mid);
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-3) moved++;
      ext[0] = Math.min(ext[0], b[2]); ext[1] = Math.max(ext[1], b[2]);
    }
    assert.ok(moved > s.vc * 0.05, `${s.name}: the clip moves the body (${moved}/${s.vc} vertices differ between frame 0 and ${mid})`);
    const len = ext[1] - ext[0];
    assert.ok(len > 0.5 && len < 1.8, `${s.name}: a posed frame stays the creature's size (long axis ${len.toFixed(2)}, rest 1)`);
    checks += 2;
  }
}
console.log(`sealitaire fish: ${checks} checks passed over ${nspecies} species, ${clipped} with a clip, ${rigged} rigged (${sprung} sprung bones)`);
