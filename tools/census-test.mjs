#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:census
//
// THE MEMORY CENSUS IS THE ONLY INSTRUMENT that can say why the web view is
// being killed on the phone, and until now nothing tested it. That is the wrong
// way round: a number nobody checks is a number that can quietly start lying,
// and this one is read from a crash trail hours after the fact, by which point
// the run it described is gone and cannot be repeated.
//
// The split into three banks is what these checks are mostly about. A lump
// `aud` figure named a problem it could not attribute — 131MB of audio against
// about 70MB the music warm set and the sfx bank could account for between them
// — so `audioParts` exists to say WHICH bank holds the surplus. The failure
// that would waste another round trip is the split disagreeing with the total
// it is splitting, because then both numbers are suspect and neither can be
// acted on.
// ---------------------------------------------------------------------------
import { censusReport, censusLine } from '../path/src/systems/memoryCensus.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const MB = 1048576;

console.log('\nTHE AUDIO SPLIT');
{
  const parts = { sfx: 28 * MB, music: 40 * MB, ambient: 63 * MB };
  const r = censusReport({ items: [], audioBytes: 131 * MB, audioParts: parts, targetBytes: 14 * MB });
  const line = censusLine(r);

  check('the split is reported', /aud131\(sfx28 mus40 amb63\)/.test(line), line);
  // Anything already grepping the trail for the old shape keeps working.
  check('...and still contains a plain aud<n> to match on', /aud131/.test(line), line);
  check('the three parts sum to the whole they split',
    r.audioParts.sfxMB + r.audioParts.musicMB + r.audioParts.ambientMB === r.audioMB,
    `${r.audioParts.sfxMB}+${r.audioParts.musicMB}+${r.audioParts.ambientMB} vs ${r.audioMB}`);
  // Audio is one term of the total, not three plus itself.
  check('audio is counted once in the total', r.totalMB === 131 + 14, `${r.totalMB}MB`);
}

console.log('\nUSERDATA SHARED BETWEEN CLONES');
// cloneSafe does SHALLOW copies with references left as references, so eighty
// bodies cloned from one template share one `morphs` array. The census used to
// charge every holder the full weight of it — and because the holder count
// grows with bodies spawned, the lie had exactly the shape of the leak everyone
// was hunting. The phone's trail printed `Group:3932k[clips+rig+...]` twice,
// same bytes, same keys: one array, counted once each.
{
  const shared = { morphs: new Float32Array(256 * 1024) }; // 1MB, one copy
  const node = () => ({ traverse(fn) { fn(this); }, userData: { rig: shared } });

  const one = censusReport({ items: [node()] });
  const eighty = censusReport({ items: Array.from({ length: 80 }, node) });
  check('one holder is charged for it', one.udMB === 1, `${one.udMB}MB`);
  check('eighty holders are charged for it once between them',
    eighty.udMB === one.udMB, `${eighty.udMB}MB across 80 vs ${one.udMB}MB across 1`);

  // ...and the thing that makes the check above meaningful: userData that is
  // genuinely per body still scales, or the dedupe has simply gone blind.
  const own = () => ({
    traverse(fn) { fn(this); },
    userData: { rig: new Float32Array(256 * 1024) },
  });
  const four = censusReport({ items: Array.from({ length: 4 }, own) });
  check('userData nothing shares still costs what it costs',
    four.udMB === 4, `${four.udMB}MB`);
}

console.log('\nTHE COUNT, AGAINST THE RENDERER\'S OWN');
// The leak the byte census is blind to, and the reason this block exists. A
// bone texture is about four kilobytes: a thousand of them move
// renderer.info.memory.textures by a thousand and `tex` by four. The phone's
// trail read a flat tex105MB through three sessions while the renderer's tally
// went 306 -> 704 inside one run, and nothing in the line said the two numbers
// were about the same thing.
{
  // A scene of one skinned body: a material map, and a skeleton that has been
  // drawn and therefore owns a bone texture.
  const map = { isTexture: true, source: { uuid: 'map-1' }, image: { width: 4, height: 4 } };
  const skel = {
    uuid: 'sk-1',
    boneMatrices: { byteLength: 1024 },
    boneTexture: { image: { data: { byteLength: 1024 } } },
  };
  const body = {
    traverse(fn) { fn(this); },
    userData: {},
    material: { map },
    skeleton: skel,
  };

  const r = censusReport({ items: [body], glTextures: 2 });
  check('the map is counted as one texture', r.texCount === 1, `${r.texCount}`);
  check('the bone texture is counted apart from it', r.boneTexCount === 1, `${r.boneTexCount}`);
  check('reachable is the two together', r.reachableTextures === 2, `${r.reachableTextures}`);
  check('a renderer holding exactly what the scene holds has no orphans',
    r.orphanTextures === 0, `${r.orphanTextures}`);
  check('...and the line says so without an orphan term',
    / gl2=1map\+1bone(?! )/.test(censusLine(r)) && !/orphan/.test(censusLine(r)), censusLine(r));

  // THE CASE THE WHOLE THING IS FOR: bodies dropped from the scene without
  // skeleton.dispose(). The renderer still holds their uploads; the walk cannot
  // reach them; the megabytes do not move.
  const leaking = censusReport({ items: [body], glTextures: 704 });
  check('textures the scene cannot reach are named as orphans',
    leaking.orphanTextures === 702, `${leaking.orphanTextures}`);
  check('...and the line carries the whole subtraction',
    /gl704=1map\+1bone\+702orphan/.test(censusLine(leaking)), censusLine(leaking));
  check('...while the byte figure stays exactly as flat as it was on the phone',
    leaking.texMB === r.texMB, `${leaking.texMB} vs ${r.texMB}`);

  // A skeleton that has not been DRAWN has no texture yet: three builds it
  // lazily inside the first render. Counting it would report an upload that
  // has not happened and drag the orphan term negative.
  const undrawn = censusReport({
    items: [{ traverse(fn) { fn(this); }, userData: {}, skeleton: { uuid: 'sk-2', boneMatrices: { byteLength: 1024 } } }],
    glTextures: 0,
  });
  check('an undrawn skeleton is not counted as an upload',
    undrawn.boneTexCount === 0, `${undrawn.boneTexCount}`);
  check('...and the orphan count never runs backwards',
    censusReport({ items: [body], glTextures: 0 }).orphanTextures === 0);
}

console.log('\nA CALLER WITH NO RENDERER TO ASK');
{
  const r = censusReport({ items: [], audioBytes: 4 * 1048576 });
  check('omits the tally rather than inventing one', r.glTextures === null);
  check('...and says nothing about orphans it cannot know about',
    r.orphanTextures === null, `${r.orphanTextures}`);
  check('...and the line leaves the whole term out',
    !/gl\d/.test(censusLine(r)), censusLine(r));
}

console.log('\nA CALLER THAT CANNOT REACH THE BANKS');
{
  const r = censusReport({ items: [], audioBytes: 131 * MB, targetBytes: 14 * MB });
  // Absent, not zeroed: `sfx0 mus0 amb0` would read as three empty banks, which
  // is a finding rather than a missing measurement.
  check('omits the split rather than inventing zeroes', r.audioParts === null);
  check('...and the line falls back to the plain form',
    /aud131 rt14/.test(censusLine(r)), censusLine(r));
  check('the total is unaffected', r.totalMB === 145, `${r.totalMB}MB`);
}

console.log('\nTHE LINE STAYS PARSEABLE');
{
  const r = censusReport({ items: [], audioBytes: 0, targetBytes: 0 });
  const line = censusLine(r);
  for (const key of ['geo', 'tex', 'bone', 'ud', 'aud', 'rt']) {
    check(`\`${key}\` is present with a number`, new RegExp(`${key}\\d`).test(line), line);
  }
  check('a zero census still totals zero', r.totalMB === 0, `${r.totalMB}MB`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\ncensus: all good\n');
process.exit(failures ? 1 : 0);
