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

const { packRun, resumable, saveRun, readRun, clearRun, noteResume, resumeHeld } =
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

// --- the loop the resumed run opens on --------------------------------------
// The one part of a restore the player HEARS, and the one the join check above
// cannot see: `slotForLevel` picks a loop per CONFIG.music.levelsPerSlot levels,
// so a run resumed at fourteen opens four loops away from where it was. It used
// to open on the first one and correct itself by QUEUE — a queue waits for the
// playing file to finish, and on a phone that had just lost its process nothing
// was decoded yet, so it missed that boundary too and waited for the one after.
//
// Read out of the source rather than driven, because the bug is entirely which
// NUMBER buildRun hands the transport, and the transport is three systems away
// from anything this suite can stand up.
const buildBody = main.slice(
  main.indexOf('function buildRun(resume = null) {'),
  main.indexOf('\nfunction ', main.indexOf('function buildRun(resume = null) {') + 1),
);
check('buildRun was found in main.js', buildBody.length > 200,
  'the function was renamed or moved — the two checks below are blind until the slice is fixed');
const musicStart = buildBody.match(/(?:releaseMusicIntoRun|playMusic)\(([^)]*)\)/g) ?? [];
check('buildRun starts the music', musicStart.length === 2, musicStart.join(' / '));
check('...at the level the snapshot restores, not the one on the clock',
  musicStart.every((call) => !/gameState\.level/.test(call)),
  `${musicStart.join(' / ')} — gameState.level is 1 here on every route, including a resume:`
  + ' the snapshot is applied at the END of buildRun');

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

// --- the hold that hands a resume back --------------------------------------
// The counter counts FAILED resumes. A restore that walks back into the wall
// that killed it dies inside the loading screen; the kills on the phone's own
// crash trail are five to nine minutes apart. Everything below is about that
// gap being read the right way round — the release that counted every restore
// refused a third resume to a run the net had twice saved for six minutes.
const hold = { holdSeconds: 60 };
check('a restore that dies immediately has not held', resumeHeld(0, hold) === false);
check('...nor one that dies in the loading screen', resumeHeld(9, hold) === false);
check('...nor one a second short', resumeHeld(59.9, hold) === false);
check('a run that reaches the hold has held', resumeHeld(60, hold) === true);
check('...and so has one the length of a real session', resumeHeld(541, hold) === true,
  'the third kill on the 9/17 trail came 541s after the resume that preceded it');
check('a hold with no reading is not a hold', resumeHeld(undefined, hold) === false);
check('...and neither is a broken one', resumeHeld(NaN, hold) === false);
// The two ends joined: a run that held is offered the net again, where one that
// did not is still refused on its second failure.
check('a held resume is spendable again', resumable({ ...fresh, resumes: 0 }, rules) === true);
check('...where two failures in a row are not', resumable({ ...fresh, resumes: 2 }, rules) === false);

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
