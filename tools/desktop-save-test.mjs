#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run desktop:test:save
//
// THE SAVE FILE — that the game's localStorage and the JSON file Steam Cloud
// will sync are actually the same save, in both directions.
//
// Every failure here is silent, and three of them cost the player something
// they cannot get back:
//
//   HYDRATION ACROSS THE CONTEXT SPLIT. The preload fills localStorage from the
//   file, in an ISOLATED WORLD with its own JavaScript context. The whole
//   design rests on that write being visible to the page's own scripts — true,
//   because localStorage belongs to the frame's origin rather than to a JS
//   context, but true in a way that no type system and no lint rule checks. If
//   it were ever false, every launch would look like a brand new install.
//
//   THE ALLOWLIST, BOTH WAYS. Three keys must never travel: the tuning
//   snapshot (authoring state, hundreds of KB), the playtest client id (syncing
//   it fuses two machines' analytics into one), and the crash beacon (a fact
//   about THIS machine's last boot). Outbound leaks put them in the cloud;
//   inbound leaks let a hand-edited file inject arbitrary localStorage.
//
//   A CORRUPT FILE MUST NOT BE FATAL. Steam Cloud replaces this file under a
//   running game. Catching a half-written one and starting fresh costs a save;
//   throwing on it costs the ability to launch.
//
//   THE GRAVEYARD. systems/nameLedger.js treats burial as permanent, so this
//   file is a record the game will not let the player rebuild. That is why
//   writeSave renames into place rather than writing over the live file.
//
// Runs the real Electron shell against dist-desktop with a THROWAWAY userData
// directory — see electron/save-smoke.js.
//
//   node tools/desktop-save-test.mjs
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ELECTRON = join(ROOT, 'node_modules/.bin/electron');
const SMOKE = join(ROOT, 'electron/save-smoke.js');
const DIST = join(ROOT, 'dist-desktop');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

console.log('\nDESKTOP SAVE — userData/save.json and the page agree');

if (!existsSync(ELECTRON)) {
  console.log('\n  FAIL electron is not installed — run `npm i`\n');
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.log('\n  FAIL no dist-desktop/ — run `npm run build:desktop` first\n');
  process.exit(1);
}

const out = await new Promise((done) => {
  const child = spawn(ELECTRON, [SMOKE], {
    cwd: ROOT,
    // ELECTRON_DISABLE_SECURITY_WARNINGS keeps the harness output readable; the
    // warnings are about loading over a custom scheme, which is the point.
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  child.on('close', () => done(buf));
});

const line = out.split('\n').find((l) => l.startsWith('SEAL_SAVE '));
if (!line) {
  console.log('\n  FAIL the shell produced no result\n');
  console.log(out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}

const r = JSON.parse(line.slice('SEAL_SAVE '.length));
if (r.error) {
  console.log(`\n  FAIL ${r.error}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('the file reaches the page');
{
  check(
    'a saved name is in the page\'s localStorage',
    r.hydrated.name === r.seededName,
    `${r.hydrated.name} (isolated-world write, main-world read)`,
  );
  check('and so is a second key', r.hydrated.tips === '["intro"]', r.hydrated.tips);
  check(
    'a key not on the allowlist is refused on the way IN',
    r.hydrated.smuggled === null,
    'a hand-edited file must not be able to inject localStorage',
  );
  // Not an assertion — the standing evidence for the allowlist. The game seeds
  // its tuning snapshot into localStorage on a production build, and this is
  // how much would ride along in every cloud save if the filter were a blanket
  // copy instead.
  console.log(
    `  ··   the tuning snapshot the game seeds is ${(r.hydrated.tuningBytes / 1024).toFixed(0)}KB`
    + ' — excluded, and this is why',
  );
}

// ---------------------------------------------------------------------------
section('the page reaches the file');
{
  const data = r.onDisk?.data ?? {};
  check('the file is versioned', r.onDisk?.version === 1, String(r.onDisk?.version));
  check(
    'a key written by the page is saved',
    data['seal-survivor-buried'] === '["Doomed Squish"]',
    data['seal-survivor-buried'],
  );
  check(
    'an overwritten key takes the new value',
    data['seal-survivor-player-name'] === 'Chonker',
    data['seal-survivor-player-name'],
  );
  check(
    'the playtest client id is NOT saved',
    !('seal-survivor-playtest-client' in data),
    'syncing it would fuse two machines into one analytics client',
  );
  check(
    'nothing outside the allowlist is in the file',
    Object.keys(data).every((k) => k.startsWith('seal') || k.startsWith('sealSurvivor')),
    Object.keys(data).join(', '),
  );
}

// ---------------------------------------------------------------------------
section('what the next launch would read');
{
  check('the name survives a round trip', r.reread['seal-survivor-player-name'] === 'Chonker');
  check('so does the graveyard', r.reread['seal-survivor-buried'] === '["Doomed Squish"]');
}

// ---------------------------------------------------------------------------
section('handing a picture to the player');
{
  const i = r.image;
  check('the shell advertises a save dialog', i.caps.saveImage === true);
  // The two that decide the SHAPE of the score row. canShareImages() in
  // bossShot.js returns false when both are absent, which is what keeps the
  // Save buttons on screen — and wireTrophy then drops Share, because a Share
  // button here would fall through to a silent download.
  check(
    'and has no Web Share API to pretend with',
    i.caps.share === false && i.caps.canShare === false,
    'navigator.share and navigator.canShare are both undefined in Electron',
  );

  check('a save writes the file', i.savedResult === 'saved', String(i.savedResult));
  check(
    'with the bytes intact across the bridge',
    JSON.stringify(i.savedBytes) === JSON.stringify(i.expectedBytes),
    'a Blob would have arrived as an empty object and written 0 bytes',
  );
  check(
    'a cancel is its own outcome',
    i.cancelledResult === 'cancelled',
    'anything falsy would fall through and hand them a second copy',
  );
  check('empty bytes are refused', i.emptyResult === 'unavailable', String(i.emptyResult));
}

// ---------------------------------------------------------------------------
section('a corrupt save');
{
  check(
    'reading it does not throw',
    r.fromCorrupt && typeof r.fromCorrupt === 'object',
    'it returns an empty save instead',
  );
  check('and yields nothing', Object.keys(r.fromCorrupt).length === 0);
  check('a write repairs the file', r.rewrote === true);
  check(
    'and the repaired file reads back',
    r.repaired['seal-survivor-player-name'] === 'After Corruption',
    r.repaired['seal-survivor-player-name'],
  );
}

// The sandbox userData directory, which exists only for this run.
try {
  if (r.sandbox?.includes('seal-save-')) rmSync(r.sandbox, { recursive: true, force: true });
} catch { /* a temp directory that outlives the test is not a failure */ }

console.log(
  failures
    ? `\n${failures} failure${failures === 1 ? '' : 's'}.\n`
    : '\nThe save survives a restart, and only the right keys travel.\n',
);
process.exit(failures ? 1 : 0);
