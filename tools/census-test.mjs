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
