#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:beat
//
// Checks systems/beatSync.js and everything wired into it, without a GL
// context or an audio context. Five parts, and the middle three are the ones
// that catch real bugs:
//
//   TABLE      that a division name maps to the beats it claims, that bars
//              follow beatsPerBar, and that an unknown name degrades to
//              'free' rather than to a divide-by-zero. Names are the wire
//              format — they land in imported-tuning.json — so a rename here
//              silently unsyncs every effect set to the old one.
//
//   CLOCK      the property the whole system rests on: a SYNCED phase is
//              derived absolutely from the transport, so it stays locked to
//              the grid however long the run goes; a FREE one is integrated,
//              so a rate change bends it from where it is. Getting those the
//              wrong way round produces an effect that looks fine for thirty
//              seconds and has drifted a beat by minute five, which is not
//              something anyone finds by eye.
//
//   PHASE      that a school's per-individual offsets are quantised onto
//              slots and are IDEMPOTENT. The second half is a regression:
//              the offset used to be recomputed from itself on every apply,
//              and apply runs on every spawn.
//
//   FITTED     that every division shipped in config.js really is the one
//              nearest the rate it replaced. This is the "nothing visibly
//              moved when it went on the grid" claim, and it was arithmetic
//              done by hand — exactly the kind that is wrong by one step.
//
//   WIRING     that every '…Sync' key reachable from the tuner names a real
//              division and appears in SYNCED_FX, so the Beat sync group's
//              inventory can't quietly go stale; and that the tuner's
//              readouts run without throwing on the real config.
//
// What it cannot tell you: whether a bar is the right figure for the grass.
// That is a judgement, and the tuner's pickers exist so it can be made by ear.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG, TUNER_SCHEMA } from '../path/src/config.js';
import {
  BEAT_DIVISIONS, divisionBeats, divisionSeconds, advanceCycles, phaseOffset,
  nearestDivision, updateBeatSync, beatsNow, beatsPerBar,
} from '../path/src/systems/beatSync.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const TWO_PI = Math.PI * 2;
const bpm = CONFIG.music.bpm;
const beat = 60 / bpm;

// --- table -----------------------------------------------------------------
section('TABLE');
console.log(`  (merged config: ${bpm} bpm, ${beatsPerBar()} beats/bar, beat ${beat.toFixed(3)}s)`);

check('free is a division and means "no grid"', BEAT_DIVISIONS[0] === 'free' && divisionBeats('free') === 0);
check('a quarter note is one beat', divisionBeats('1/4') === 1);
check('an eighth is half a beat', divisionBeats('1/8') === 0.5);
check('a bar follows beatsPerBar', divisionBeats('1 bar') === beatsPerBar());
check('4 bars is four of those', divisionBeats('4 bars') === beatsPerBar() * 4);
check('an unknown name degrades to free, not to a divide by zero',
  divisionBeats('1/7 of a fortnight') === 0);
check('the table is strictly ascending in cycle length',
  BEAT_DIVISIONS.slice(1).every((n, i) => divisionBeats(n) > divisionBeats(BEAT_DIVISIONS[i]) || i === 0),
  BEAT_DIVISIONS.join(' '));
check('divisionSeconds agrees with the tempo',
  Math.abs(divisionSeconds('1 bar') - beat * beatsPerBar()) < 1e-9,
  `1 bar = ${divisionSeconds('1 bar').toFixed(3)}s`);

// --- clock -----------------------------------------------------------------
section('CLOCK');

// Nothing is playing (no audio context in Node), so this is the FALLBACK
// transport — the one that keeps the start menu's creatures breathing before
// the player has clicked. It has to tick at the configured tempo.
const beatsBefore = beatsNow();
updateBeatSync(beat * 4); // exactly four beats of wall time
check('the fallback clock ticks at the configured tempo',
  Math.abs((beatsNow() - beatsBefore) - 4) < 1e-6,
  `${(beatsNow() - beatsBefore).toFixed(4)} beats in ${(beat * 4).toFixed(3)}s`);

// THE central property. A synced cycle ignores the dt it is handed and answers
// only to the transport, so two callers a frame apart — or a creature that
// spawned nine minutes in — land on the same phase.
{
  const a = advanceCycles(0, '1 bar', 999, 0.016, 1);
  const b = advanceCycles(0.7, '1 bar', 0.0001, 5.0, 1);
  check('a synced cycle ignores both its previous value and its free rate',
    Math.abs(a - b) < 1e-9, `${a.toFixed(6)} vs ${b.toFixed(6)}`);
  check('...and equals transport / beats-per-cycle',
    Math.abs(a - ((beatsNow() / divisionBeats('1 bar')) % 1)) < 1e-9);
}

// A free cycle is the opposite: it integrates, so changing the rate bends the
// phase from where it is rather than teleporting it.
{
  const c1 = advanceCycles(0.25, 'free', 1, 0.5, 1);
  check('a free cycle integrates from its previous value',
    Math.abs(c1 - 0.75) < 1e-9, `${c1.toFixed(4)}`);
  const c2 = advanceCycles(0.75, 'free', 1, 0.5, 1);
  check('...and wraps rather than growing without bound',
    Math.abs(c2 - 0.25) < 1e-9, `${c2.toFixed(4)}`);
}

// wrap 2 exists for biolumSkin, whose shader reads both `cycle` and
// `cycle * 0.5`. At wrap 1 the half-rate term would jump from 0.5 to 0 every
// cycle and the hue would visibly snap.
{
  const w = advanceCycles(1.9, 'free', 1, 0.2, 2);
  check('wrap 2 keeps a half-rate term continuous',
    Math.abs(w - 0.1) < 1e-9 && w >= 0 && w < 2, `${w.toFixed(4)}`);
}

// The master switch has to reach every effect, not just the ones that
// remembered to check it.
{
  CONFIG.beatSync.enabled = false;
  const off = advanceCycles(0.25, '1 bar', 1, 0.5, 1);
  check('the master switch sends a synced cycle back to its free rate',
    Math.abs(off - 0.75) < 1e-9, `${off.toFixed(4)}`);
  CONFIG.beatSync.enabled = true;
}

// --- phase -----------------------------------------------------------------
section('PHASE');

check('spread 0 collapses everyone onto the same phase',
  [0.1, 0.5, 0.9].every((s) => phaseOffset(s, 0, 4) === 0));
check('spread 1 with no steps is the raw seed',
  Math.abs(phaseOffset(0.37, 1, 0) - 0.37) < 1e-9);
check('steps snap the offset onto slots',
  [0.05, 0.3, 0.6, 0.95].every((s) => {
    const o = phaseOffset(s, 1, 4);
    return Math.abs(o * 4 - Math.round(o * 4)) < 1e-9;
  }));
check('and a snapped offset never reaches a full cycle',
  [0.999, 1.0].every((s) => phaseOffset(s, 1, 4) < 1));
// The regression the old code had: the offset was stored where it was also
// read, so every apply() multiplied it by the spread again.
check('phaseOffset is idempotent in the seed',
  phaseOffset(0.62, 0.5, 4) === phaseOffset(0.62, 0.5, 4),
  'apply runs on every spawn — a compounding offset collapses a school');
check('spread scales the slots rather than the seed',
  phaseOffset(0.99, 0.5, 4) <= 0.5,
  `${phaseOffset(0.99, 0.5, 4)}`);

// --- fitted ----------------------------------------------------------------
section('FITTED — every shipped division is the nearest to the rate it replaced');

// Radians/sec -> the period of one cycle. Anything authored as a rate went
// through this conversion when it was fitted to the grid, and getting the 2π
// wrong is a factor-of-six error that still LOOKS plausible in the config.
const fromRadians = (r) => TWO_PI / r;
const fromPerSecond = (r) => 1 / r;

const bio = CONFIG.biolumSkin;
const resolve = (name) => ({ ...bio.base, ...(bio.presets[name] ?? {}) });

// An effect whose amplitude is zero has no cycle to be out of time with, so
// it is not fitted and pinning a division on it would be a value that looks
// meaningful and isn't. `abyssHunter` is the live case: it is deliberately
// steady, so its flicker inherits base's division rather than declaring one.
const FITTED = [
  ['biolum base breath', bio.base.pulseSync, fromRadians(bio.base.pulseSpeed)],
  ['biolum base flicker', bio.base.flickerSync, fromPerSecond(bio.base.flickerRate)],
  ...Object.keys(bio.presets).flatMap((n) => {
    const p = resolve(n);
    return [
      ...(p.pulseAmp > 0 ? [[`${n} breath`, p.pulseSync, fromRadians(p.pulseSpeed)]] : []),
      ...(p.flickerAmp > 0 ? [[`${n} flicker`, p.flickerSync, fromPerSecond(p.flickerRate)]] : []),
    ];
  }),
  ['octopus shimmer', CONFIG.octoGrab.glow.shimmerSync, fromRadians(CONFIG.octoGrab.glow.shimmerSpeed)],
  ['grass sway', CONFIG.grass.sway.speedSync, fromRadians(CONFIG.grass.sway.speed)],
  ['grass flutter', CONFIG.grass.sway.flutterSync, fromRadians(CONFIG.grass.sway.flutterSpeed)],
  // bandSpeed is already in cycles/sec: the shader multiplies the whole term
  // by 2π, so this one takes the other conversion.
  ['bakalar bands', CONFIG.bakalar.beam.bandSync, fromPerSecond(CONFIG.bakalar.beam.bandSpeed)],
];

for (const [label, division, freeSeconds] of FITTED) {
  const want = nearestDivision(freeSeconds);
  check(`${label}: ${division}`, division === want,
    `free cycle ${freeSeconds.toFixed(2)}s, nearest ${want} (${divisionSeconds(want).toFixed(2)}s)`);
}

// The fit is only meaningful if it is actually close. A "nearest" that is 3x
// out is a retimed effect being reported as an unchanged one.
for (const [label, division, freeSeconds] of FITTED) {
  const secs = divisionSeconds(division);
  const ratio = secs > 0 ? Math.max(secs / freeSeconds, freeSeconds / secs) : Infinity;
  check(`${label} kept its pace`, ratio < 1.45,
    `${freeSeconds.toFixed(2)}s -> ${secs.toFixed(2)}s (${ratio.toFixed(2)}x)`);
}

// --- wiring ----------------------------------------------------------------
section('WIRING');

// Every sync setting reachable from the tuner, found by shape rather than by a
// list — a new one added without a picker is exactly the drift this catches.
const syncRows = [];
for (const group of TUNER_SCHEMA) {
  for (const item of group.items ?? []) {
    if (item.path?.endsWith('Sync')) syncRows.push([group.group, item]);
  }
}
check('the tuner exposes sync pickers', syncRows.length >= 12, `${syncRows.length} rows`);
check('every sync row is a button picker, not a slider',
  syncRows.every(([, i]) => i.type === 'choice'),
  syncRows.filter(([, i]) => i.type !== 'choice').map(([, i]) => i.path).join(', ') || 'all choice');
check('every sync picker offers exactly the real divisions',
  syncRows.every(([, i]) => i.options?.length === BEAT_DIVISIONS.length
    && i.options.every((o) => BEAT_DIVISIONS.includes(o))),
  `${BEAT_DIVISIONS.length} divisions`);

// A division name that isn't in the table reads as 'free', so a typo is a
// setting that looks applied and does nothing.
const badNames = [];
for (const [, item] of syncRows) {
  const v = item.path.split('.').reduce((o, k) => o?.[k], CONFIG);
  // Absent is legitimate — a preset that inherits base's division.
  if (v !== undefined && !BEAT_DIVISIONS.includes(v)) badNames.push(`${item.path}=${v}`);
}
check('every configured division names a real one', badNames.length === 0, badNames.join(', ') || 'all valid');

// The Beat sync group prints an inventory of what is on the grid. It is a
// hand-maintained list, so it is exactly the thing that goes stale.
const inventory = TUNER_SCHEMA
  .find((g) => g.group === 'Beat sync')?.items
  .find((i) => i.type === 'readout')?.lines() ?? [];
check('the Beat sync group prints an inventory', inventory.length > 3, `${inventory.length} lines`);
{
  const printed = inventory.join('\n');
  // The inventory is hand-maintained (SYNCED_FX in config.js), so what it
  // misses is a NEW effect nobody added a line for. Every distinct config
  // object that owns a sync key needs a row — except biolumSkin.base, which is
  // what the four species presets inherit rather than an effect of its own.
  const owners = new Set(syncRows.map(([, i]) => i.path.split('.').slice(0, -1).join('.')));
  owners.delete('biolumSkin.base');
  const fxLines = inventory.length - 2; // two header lines: tempo, then the grid
  check('the inventory has a row per synced effect', fxLines === owners.size,
    `${fxLines} rows for ${owners.size} owners: ${[...owners].join(', ')}`);
  // ...and the rows report the LIVE divisions, not a stale transcription.
  check('the inventory reports the live divisions',
    printed.includes(`grass: ${CONFIG.grass.sway.speedSync} / ${CONFIG.grass.sway.flutterSync}`)
    && printed.includes(`bakalar beam: ${CONFIG.bakalar.beam.bandSync}`)
    && printed.includes(`lanternfish: ${resolve('lantern').pulseSync} / ${resolve('lantern').flickerSync}`),
    printed.split('\n').slice(2).join(' | '));
}

// Every readout in the schema, run against the real config. These are called
// on every slider move, so one that throws takes the panel down mid-drag.
{
  let ran = 0;
  let threw = null;
  for (const group of TUNER_SCHEMA) {
    for (const item of group.items ?? []) {
      if (item.type !== 'readout') continue;
      ran++;
      try {
        const lines = item.lines();
        if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) {
          threw ??= `${group.group}/${item.label}: returned ${typeof lines}`;
        }
      } catch (err) {
        threw ??= `${group.group}/${item.label}: ${err?.message ?? err}`;
      }
    }
  }
  check('every readout returns lines without throwing', ran > 0 && !threw, threw ?? `${ran} readouts`);
}

// --- what the tuner will actually print ------------------------------------
section('SAMPLE OUTPUT');
for (const line of inventory) console.log(`  | ${line}`);
{
  const lanternGroup = TUNER_SCHEMA.find((g) => g.group?.includes('lanternfish'));
  for (const item of lanternGroup?.items ?? []) {
    if (item.type !== 'readout') continue;
    console.log(`  | [${item.label}]`);
    for (const line of item.lines()) console.log(`  |   ${line}`);
  }
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
