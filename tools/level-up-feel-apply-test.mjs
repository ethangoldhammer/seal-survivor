#!/usr/bin/env node
// npm run test:feelapply — the feel preset reaches config.js, in the right
// blocks, and the snapshot lets go of the same paths. On COPIES.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFeel, locateBlock } from './apply-level-up-feel.mjs';
import { maskCode } from './apply-shaders.mjs';

let failures = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) failures++; };
const dir = await mkdtemp(join(tmpdir(), 'feel-'));
const cfgPath = join(dir, 'config.js');
const tunPath = join(dir, 'tuning.json');
const src = await readFile('path/src/config.js', 'utf8');
await writeFile(cfgPath, src);
await writeFile(tunPath, JSON.stringify({ levelUpSeal: { motion: { blendTime: 0.2, blendRate: 9 }, freeHeight: 0.3 }, other: 1 }, null, 2));

const masked = maskCode(src);
check('locates a nested block', !!locateBlock(masked, ['levelUpSeal', 'motion'], src.length));
check('locates an array element', !!locateBlock(masked, ['cardTip', 'cards', '1'], src.length));
check('...and refuses a missing one', locateBlock(masked, ['cardTip', 'cards', '7'], src.length) === null);

// THE PRESET IS BUILT TO MOVE. Two of these used to be typed as literals that
// happened to differ from config.js on the day this was written — and stopped
// differing the moment they were tuned to the same number. `freeHeight` is
// 0.37 in the file and the preset asked for 0.37; `cardTip.gap` is 8 and the
// preset asked for 8. Neither has anywhere to go, so applyFeel correctly
// reported three moves against a hardcoded four, and the suite failed for a
// tuning change rather than for anything about applying.
//
// Read out of the source and perturbed, so every entry has somewhere to move by
// construction and the count cannot go stale again.
// SCOPED, because a bare key is not a path. `gap:` appears at least five times
// in config.js and the first one is 0.06 in an unrelated block — reading that
// and adding 1 produced a "current" value of 1.06 for a field that is 8. The
// assertion still passed, which is exactly why it is worth not doing: a helper
// that finds the wrong line quietly makes the test about nothing.
const leaf = (key, after = '') => {
  const from = after ? src.indexOf(after) : 0;
  if (from < 0) return null;
  const m = new RegExp(`\\b${key}:\\s*([-\\d.]+)`).exec(src.slice(from));
  return m ? Number(m[1]) : null;
};
const bump = (key, fallback, after = '') => {
  const v = leaf(key, after);
  return v == null ? fallback : Number((v + 0.11).toFixed(4));
};
const preset = {
  'motion.blendTime': bump('blendTime', 0.68),
  'levelUpSeal.freeHeight': bump('freeHeight', 0.48),
  'cardTip.cards.1.x': 50,
  'cardTip.cards.1.side': 'left',
  'cardTip.gap': (leaf('gap', 'cardTip: {') ?? 8) + 1,
  'nonsense.x': 1,
};
const dry = await applyFeel(preset, { dry: true, configPath: cfgPath, tuningPath: tunPath, guard: false });
check('a dry run writes nothing', !dry.wrote && (await readFile(cfgPath, 'utf8')) === src);
// Five real paths, every one of them somewhere it is not, plus `nonsense.x`
// which has to be refused rather than invented.
check('...but reports every move', dry.changes.length === 5, dry.changes.join(' | '));
check('...and refuses the path that does not exist',
  !dry.changes.some((c) => String(c).includes('nonsense')), dry.changes.join(' | '));
check('...and the unknown path', dry.notes.some((n) => n.includes('nonsense')));
const r = await applyFeel(preset, { dry: false, configPath: cfgPath, tuningPath: tunPath, guard: false });
const out = await readFile(cfgPath, 'utf8');
check('the run writes', r.wrote);
const motion = out.slice(...locateBlock(maskCode(out), ['levelUpSeal', 'motion'], out.length));
// Against the preset, not a literal — the value is computed from the file now,
// so a second copy of it here would go stale the first time config.js moved.
check('blendTime landed in levelUpSeal.motion',
  new RegExp(`blendTime:\\s*${preset['motion.blendTime']}\\b`).test(motion),
  `wanted ${preset['motion.blendTime']}`);
const card1 = out.slice(...locateBlock(maskCode(out), ['cardTip', 'cards', '1'], out.length));
check('cards[1].x and side landed in that element', /x:\s*50/.test(card1) && /side:\s*'left'/.test(card1), card1.replace(/\s+/g, ' '));
const card0 = out.slice(...locateBlock(maskCode(out), ['cardTip', 'cards', '0'], out.length));
check('...and not in its neighbour', /x:\s*0\b/.test(card0));
check('the file is still a module', (() => { try { new Function('return 1'); return out.includes('cardTip: {') && out.length > src.length - 20; } catch { return false; } })());
const tun = JSON.parse(await readFile(tunPath, 'utf8'));
check('the snapshot let go of the written paths', tun.levelUpSeal.motion.blendTime === undefined && tun.levelUpSeal.freeHeight === undefined, JSON.stringify(tun.levelUpSeal));
check('...and kept everything else', tun.levelUpSeal.motion.blendRate === 9 && tun.other === 1);
const again = await applyFeel(preset, { dry: true, configPath: cfgPath, tuningPath: tunPath, guard: false });
check('a second run has nothing to do', again.changes.length === 0, again.changes.join(' | '));
console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
