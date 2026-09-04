// ============================================================================
// THE CRASH NET — that what is written down is what comes back.
//
// systems/runSnapshot.js has one failure mode worth a suite, and it is not a
// crash: it is a field that is READ on the way in and never WRITTEN on the way
// out. That produces a resumed run missing a card, or holding the wrong gun, or
// re-fighting a boss it already beat — all of which look like ordinary game
// state and none of which throw. Nothing else in the game would notice, because
// the only witness is a player whose run was already interrupted once.
//
// So the centrepiece here is the JOIN, checked against main.js's own source:
// every `snap.x` applyRunSnapshot reads has to be a key packRun produces. The
// rest is the policy — the age, the level floor and the resume counter — which
// is pure and cheap to state directly.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// A localStorage that behaves, installed before the module is imported — the
// module reads globalThis at call time, but a test that set it afterwards would
// be relying on that and would start failing the day it stopped being true.
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}
installStorage();

const { packRun, resumable, saveRun, readRun, clearRun, noteResume } =
  await import('../path/src/systems/runSnapshot.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- the join ---------------------------------------------------------------
// Read out of main.js rather than duplicated here: a list of fields written
// down in the test is a third copy that drifts from both of the other two.
const main = readFileSync(join(root, 'path/src/main.js'), 'utf8');
const applyBody = main.slice(
  main.indexOf('function applyRunSnapshot(snap) {'),
  main.indexOf('\n}', main.indexOf('function applyRunSnapshot(snap) {')),
);
check('applyRunSnapshot was found in main.js', applyBody.length > 200,
  'the function was renamed or moved — this whole suite is blind until the slice above is fixed');

const packed = packRun({ picks: [{ id: 'x', rarity: 'rare' }] });
const read = [...new Set([...applyBody.matchAll(/\bsnap\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
check('applyRunSnapshot reads at least the run it is restoring', read.length >= 10,
  `only found ${read.join(', ')}`);
for (const key of read) {
  check(`packRun writes "${key}"`, key in packed,
    'the restore reads a field the snapshot never stores — the resumed run silently loses it');
}

// ...and the other direction, which is the cheaper mistake: a field captured at
// cost on every heartbeat that nothing ever puts back.
for (const key of Object.keys(packed)) {
  if (key === 'v' || key === 'at' || key === 'resumes') continue; // the envelope
  check(`applyRunSnapshot reads "${key}"`, read.includes(key),
    'stored on every beat and never restored — either apply it or stop paying for it');
}

// --- the picks --------------------------------------------------------------
const withElement = packRun({
  picks: [
    { id: 'flippersUp', rarity: 'epic', finElement: 'ember' },
    { id: 'multishot', rarity: null },
    { id: '', rarity: 'rare' },       // a pick with no id is not a pick
    null,
  ],
});
check('the fin element survives', withElement.picks[0].finElement === 'ember');
check('the tier survives', withElement.picks[0].rarity === 'epic');
check('a pick with no id is dropped', withElement.picks.length === 2,
  JSON.stringify(withElement.picks));

// --- the policy -------------------------------------------------------------
const now = 1_000_000_000;
const fresh = { ...packRun({ level: 9 }), at: now };
const rules = { now, maxAgeMs: 60_000, minLevel: 2, maxResumes: 2 };
check('a fresh run resumes', resumable(fresh, rules) === true);
check('a stale run does not', resumable({ ...fresh, at: now - 61_000 }, rules) === false);
check('a level-1 run does not', resumable({ ...fresh, level: 1 }, rules) === false);
check('a snapshot from another build does not', resumable({ ...fresh, v: 99 }, rules) === false);
check('the second resume is allowed', resumable({ ...fresh, resumes: 1 }, rules) === true);
check('the third is not', resumable({ ...fresh, resumes: 2 }, rules) === false,
  'the loop guard is the only thing standing between a fatal board and an unescapable relaunch');
check('nothing at all does not resume', resumable(null, rules) === false);

// --- storage ----------------------------------------------------------------
clearRun();
check('nothing stored reads as nothing', readRun() === null);
saveRun({ level: 7, kills: 40, picks: [{ id: 'a' }] });
check('a saved run reads back', readRun()?.level === 7);
const bumped = noteResume(readRun());
check('noteResume counts', bumped.resumes === 1);
check('...and writes it down before the run starts', readRun().resumes === 1,
  'a counter kept only in memory is one a fatal resume never gets to increment');
clearRun();
check('cleared is cleared', readRun() === null);

// A quota error must never be the thing that ends the run the net is holding.
globalThis.localStorage = {
  getItem: () => { throw new Error('nope'); },
  setItem: () => { throw new Error('nope'); },
  removeItem: () => { throw new Error('nope'); },
};
let threw = null;
try {
  saveRun({ level: 3 });
  readRun();
  clearRun();
  noteResume({ resumes: 0 });
} catch (err) {
  threw = err;
}
check('storage that throws is survived', threw === null, String(threw));

if (failures) {
  console.error(`\n[run-snapshot] ${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('[run-snapshot] the run that is written down is the run that comes back.');
