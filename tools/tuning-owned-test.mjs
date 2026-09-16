#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tuningowned
//
// SOME FIELDS BELONG TO config.js AND MUST NEVER LIVE IN A SAVED SNAPSHOT.
//
// `tuningSnapshot` writes whole CONFIG sections, and saved tuning beats
// config.js in the merge. So any field that has no control attached gets
// captured as an echo of whatever source held on the day of the save — and
// from then on that echo WINS. Editing the value in config.js does nothing,
// with no error and nothing in a diff to look at.
//
// It is not hypothetical and it is not rare. config.js documents seven of
// these, each found the same way: someone changed a number in source, the game
// went on using the old one, and the reason took a session to find.
// `render.adaptive.enabled` was the worst of them — config.js turned the
// adaptive resolution controller OFF, with the measurement that says why, and
// the snapshot's `true` kept it running for months. The picture stepped down
// mid-run on a machine the note says it cannot help.
//
// Nothing tested ANY of them, which is why. This does.
//
//   node tools/tuning-owned-test.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const tuning = JSON.parse(readFileSync(resolve(ROOT, 'path/src/imported-tuning.json'), 'utf8'));

const { CONFIG, withoutAdaptiveEnabled, withoutTableOwnedKeys } = await import(resolve(ROOT, 'path/src/config.js'));

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// Each of these is stripped on BOTH sides of the snapshot in config.js, and
// each has its own note there explaining what went wrong when it was not.
// A path with a `*` segment means "every entry of this map".
const CODE_OWNED = [
  'render.adaptive.enabled',
  'audio.maxConcurrent',
  'gravesite.stones',
  'pickups.sinkSpeed',
  'music.bossSrc',
  'music.versusSrc',
  'versus.replay.cams.shots',
  'versus.camera.reach',
  'versus.camera.mode',
  'feedback.*.emit',
  'feedback.*.toast',
  'emitters.*.colors',
];

/** Every place the path reaches, as a dotted trail. `*` matches any key. */
function hits(obj, path) {
  const found = [];
  const walk = (node, segments, trail) => {
    if (!segments.length) { found.push(trail.join('.')); return; }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const [next, ...rest] = segments;
    const keys = next === '*' ? Object.keys(node) : (next in node ? [next] : []);
    for (const k of keys) walk(node[k], rest, [...trail, k]);
  };
  walk(obj, path.split('.'), []);
  return found;
}

// A snapshot carrying every one of them, which is what a save from before the
// strips existed looks like. What matters is not whether today's file happens
// to be clean — it is whether a field that IS in a file can reach the live
// config. That is the mechanism, and it is what the load strip is for.
const dirty = {
  render: { pixelRatio: 3, adaptive: { enabled: true, floor: 0.4 } },
  audio: { maxConcurrent: 12, master: 0.8 },
  gravesite: { stones: ['a', 'b'], scale: 1 },
  pickups: { sinkSpeed: 1.2, magnet: 3 },
  music: { bossSrc: ['x.mp3'], versusSrc: ['y.mp3'], bpm: 170 },
  versus: { camera: { reach: 12, mode: 'A', zoomMin: 1 }, replay: { cams: { shots: [1, 2], hold: 2 } } },
  feedback: { clamDrop: { emit: 'pop', toast: 'words', sfx: 'clam' } },
  emitters: { muzzle: { colors: ['#fff'], rate: 4 } },
};

section('a saved field cannot outrank config.js');
const cleaned = withoutTableOwnedKeys(structuredClone(dirty));
for (const path of CODE_OWNED) {
  const found = hits(cleaned, path);
  check(path, found.length === 0, `survived the load strip as ${found.join(', ')}`);
}

section('and everything beside it survives');
// The strip must take the one field and nothing else — a section that came
// back empty would look identical in the test above and would throw away real
// tuning on the way in.
for (const [path, want] of [
  ['render.pixelRatio', 3], ['render.adaptive.floor', 0.4], ['audio.master', 0.8],
  ['gravesite.scale', 1], ['pickups.magnet', 3], ['music.bpm', 170],
  ['versus.camera.zoomMin', 1], ['versus.replay.cams.hold', 2],
  ['feedback.clamDrop.sfx', 'clam'], ['emitters.muzzle.rate', 4],
]) {
  check(path, hits(cleaned, path).length === 1 && path.split('.').reduce((o, k) => o?.[k], cleaned) === want);
}

section('the committed snapshot');
// Informational. A stale echo in the file is harmless once the strip is in
// front of it, and the next save rewrites the file without it — so this is a
// count, not a gate.
const stale = CODE_OWNED.flatMap((p) => hits(tuning, p));
console.log(`  ${stale.length} stale echo(es) still in imported-tuning.json, all neutralised on load`);

section('the detector itself');
// A matcher that silently stops matching turns every row above into a green
// light that means nothing — so it is checked against a value that IS there.
check('finds a key that is present', hits(tuning, 'render.adaptive.floor').length === 1);
check('finds nothing for a key that is not', hits(tuning, 'render.adaptive.nosuchkey').length === 0);
check('walks a * segment', hits({ a: { x: { v: 1 } }, b: { x: { v: 2 } } }, '*.x.v').length === 2);

section('withoutAdaptiveEnabled');

const live = { pixelRatio: 3, adaptive: { enabled: true, floor: 0.4, maxDrops: 6 } };
const out = withoutAdaptiveEnabled(live);
check('drops enabled', !('enabled' in out.adaptive));
check('keeps every other key', out.adaptive.floor === 0.4 && out.adaptive.maxDrops === 6);
check('keeps the rest of render', out.pixelRatio === 3);
// It runs against the LIVE CONFIG on the save path, so a mutation here would
// turn the controller off in the running game as a side effect of saving.
check('does not mutate its input', live.adaptive.enabled === true);
check('passes through a render with no adaptive block', withoutAdaptiveEnabled({ pixelRatio: 3 }).pixelRatio === 3);

section('and the decision it protects');

check('adaptive resolution is off after the merge', CONFIG.render.adaptive.enabled === false,
  `enabled = ${CONFIG.render.adaptive.enabled} — a snapshot is overriding config.js again`);
check('the rest of the block still merges', CONFIG.render.adaptive.floor === 0.4 && CONFIG.render.adaptive.maxDrops === 6,
  `floor ${CONFIG.render.adaptive.floor}, maxDrops ${CONFIG.render.adaptive.maxDrops}`);

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
