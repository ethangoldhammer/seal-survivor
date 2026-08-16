#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:upgrades [-- options]
//
// Three checks over the upgrade system, none of which need a browser:
//
//   1. STAT MATH    replay every upgrade's apply() up to its stack cap and
//                   compare the result against a committed snapshot, so a
//                   changed multiplier is something you approve rather than
//                   something you discover in a run three days later.
//   2. TABLE        upgrades.csv against CONFIG.upgrades — orphan rows, ids
//                   with no row, bad card art, weights that never deal.
//   3. FEEDBACK     every feedback('x') fired anywhere in the source has an
//                   entry in CONFIG.feedback, and every entry actually does
//                   something. A missing key is a silent no-op at runtime.
//
//   --json          machine-readable dump instead of the report
//   --update        rewrite the stat snapshot from current code (review the
//                   diff — this is the approval step, not a formality)
//   --only <id>     restrict the stat-math section to one upgrade
//
// Run it with the loader that teaches Node about Vite's `?raw` and bare JSON
// imports; the npm script already does:
//
//   node --import ./tools/vite-loader.mjs tools/upgrade-test.mjs
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, LEVELUP_IMAGE_KEYS } from '../path/src/config.js';
import { baseStats } from '../path/src/stats.js';
import { parseUpgradeCsv, applyUpgradeTable } from '../path/src/upgradeTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../path/src');
const SNAPSHOT = resolve(HERE, 'upgrade-snapshot.json');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const AS_JSON = has('--json');
const UPDATE = has('--update');
const ONLY = valueOf('--only');

// How many stacks to replay for an upgrade with no cap. Unlimited upgrades are
// unlimited in the offer pool, not in practice — nobody takes Rapid Fire forty
// times in a run, and the point of the replay is to see the shape of the
// curve, not to find a float limit.
const UNCAPPED_REPLAY = 8;

const problems = [];
const notes = [];
const fail = (section, msg) => problems.push({ section, msg });
const note = (section, msg) => notes.push({ section, msg });

// ===========================================================================
// 1. STAT MATH
// ===========================================================================

// A stat block with every number set to the same fixed value, so the replay
// below is a test of the UPGRADE rather than of the tuning file.
//
// This matters more than it looks: config.js merges imported-tuning.json over
// its defaults, so a real stat block changes every time the ` tuner is
// touched. Snapshotting that would mean the snapshot broke on tuning edits and
// told you nothing about the code. Against a synthetic base, `*= 1.4` lands on
// 140 no matter what the seal's actual damage is today.
//
// Caveat, and it's a real one: a few apply() bodies read CONFIG directly
// rather than only touching `s` — bounceShot's `CONFIG.bounce.maxBouncesPerLevel`
// is the clearest. Those DO move when the matching slider moves, and the
// snapshot will flag it. The flagged diff is correct; it's telling you a
// tuning change altered an upgrade's per-stack math.
const SENTINEL = 100;

function syntheticBase() {
  const s = baseStats();
  for (const k of Object.keys(s)) {
    if (typeof s[k] === 'number') s[k] = SENTINEL;
  }
  return s;
}

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : n);

// Fields that must never reach zero or go negative, whatever stacks on them —
// each one divides, scales a duration, or gates whether the seal can act.
const MUST_STAY_POSITIVE = new Set([
  'maxHp', 'maxSpeed', 'fireRate', 'damage', 'speed', 'life', 'radius',
  'hitRadius', 'pickupRadius', 'maxOxygen', 'oxygenRefillRate',
  'strikeDamage', 'strikeDashSpeed', 'strikeDashDuration', 'strikeChargeTime',
]);

function replay(upgrade) {
  const cap = upgrade.maxStacks == null ? UNCAPPED_REPLAY : upgrade.maxStacks;
  const stacks = Math.min(cap, 99);
  const s = syntheticBase();
  const perStack = [];
  let threw = null;

  for (let i = 1; i <= stacks; i++) {
    const before = { ...s };
    try {
      upgrade.apply(s);
    } catch (err) {
      threw = `stack ${i}: ${err.message}`;
      break;
    }

    const changed = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(s)])) {
      if (before[k] !== s[k]) changed[k] = round(s[k]);
    }
    perStack.push(changed);

    for (const [k, v] of Object.entries(changed)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        fail('stat math', `${upgrade.id} stack ${i}: "${k}" became ${v} — not a finite number.`);
      } else if (MUST_STAY_POSITIVE.has(k) && v <= 0) {
        fail('stat math', `${upgrade.id} stack ${i}: "${k}" fell to ${v}, which must stay above zero.`);
      }
    }
  }

  if (threw) fail('stat math', `${upgrade.id} threw — ${threw}`);
  if (!threw && perStack.length && !Object.keys(perStack[0]).length) {
    fail('stat math', `${upgrade.id}: apply() changed no stat at all. The card can be taken and does nothing.`);
  }

  // An upgrade that moves a field one way on one stack and the other way on
  // the next is nearly always a bug (a `??` seeding from CONFIG that only
  // fires once is the usual cause). Reported rather than failed, since a
  // deliberate trade-off upgrade would look the same.
  const directions = {};
  let prev = syntheticBase();
  const walk = syntheticBase();
  for (let i = 0; i < perStack.length; i++) {
    for (const [k, v] of Object.entries(perStack[i])) {
      const dir = Math.sign(v - (prev[k] ?? 0));
      if (dir && directions[k] != null && directions[k] !== dir) {
        note('stat math', `${upgrade.id}: "${k}" reverses direction at stack ${i + 1} — check the ?? seeding.`);
      }
      if (dir) directions[k] = dir;
      walk[k] = v;
    }
    prev = { ...walk };
  }

  return { id: upgrade.id, stacks, cap: upgrade.maxStacks ?? null, perStack, threw };
}

const replays = CONFIG.upgrades
  .filter((u) => !ONLY || u.id === ONLY)
  .map(replay);

if (ONLY && !replays.length) fail('stat math', `--only "${ONLY}" matched no upgrade id.`);

// --- snapshot compare ------------------------------------------------------

const snapshotNow = Object.fromEntries(
  replays.map((r) => [r.id, { cap: r.cap, perStack: r.perStack }]),
);

let snapshotStatus = 'skipped';
let snapshotDiffs = [];

if (!ONLY) {
  let previous = null;
  try {
    previous = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  } catch {
    previous = null;
  }

  if (UPDATE || !previous) {
    await writeFile(SNAPSHOT, JSON.stringify(snapshotNow, null, 2) + '\n');
    snapshotStatus = previous ? 'updated' : 'created';
    if (!previous && !UPDATE) {
      note('stat math', `No snapshot existed, so one was written from current code. Commit ${relative(process.cwd(), SNAPSHOT)} — the next run compares against it.`);
    }
  } else {
    snapshotStatus = 'compared';
    for (const id of new Set([...Object.keys(previous), ...Object.keys(snapshotNow)])) {
      const a = previous[id];
      const b = snapshotNow[id];
      if (!a) { snapshotDiffs.push({ id, kind: 'added' }); continue; }
      if (!b) { snapshotDiffs.push({ id, kind: 'removed' }); continue; }
      if (a.cap !== b.cap) snapshotDiffs.push({ id, kind: 'cap', from: a.cap, to: b.cap });

      const n = Math.max(a.perStack.length, b.perStack.length);
      for (let i = 0; i < n; i++) {
        const x = a.perStack[i] ?? {};
        const y = b.perStack[i] ?? {};
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
          if (x[k] !== y[k]) {
            snapshotDiffs.push({ id, kind: 'value', stack: i + 1, field: k, from: x[k], to: y[k] });
          }
        }
      }
    }
    for (const d of snapshotDiffs) {
      const where = d.kind === 'value' ? `${d.id} stack ${d.stack} "${d.field}"` : d.id;
      const what = d.kind === 'added' ? 'is new since the snapshot'
        : d.kind === 'removed' ? 'is gone since the snapshot'
        : d.kind === 'cap' ? `stack cap went ${d.from} → ${d.to}`
        : `${d.from} → ${d.to}`;
      fail('stat math', `${where}: ${what}`);
    }
    if (snapshotDiffs.length) {
      note('stat math', 'If these changes are what you meant, re-run with --update to accept them.');
    }
  }
}

// ===========================================================================
// 2. CSV ↔ CONFIG INTEGRITY
// ===========================================================================

const csvText = await readFile(join(SRC, 'upgrades.csv'), 'utf8');
const tableWarnings = [];
const rows = parseUpgradeCsv(csvText, (m) => tableWarnings.push(m));

// Re-apply onto a throwaway copy with a collecting `warn`, so the CSV's own
// complaints (unknown id, bad card art, unparseable weight) become failures
// here instead of scrolling past in a browser console nobody has open.
const copies = CONFIG.upgrades.map((u) => ({ ...u }));
const base = new Map(copies.map((u) => [u.id, { ...u }]));
applyUpgradeTable(copies, base, rows, LEVELUP_IMAGE_KEYS, (m) => tableWarnings.push(m));

for (const w of tableWarnings) fail('table', w);

const configIds = new Set(CONFIG.upgrades.map((u) => u.id));
for (const id of configIds) {
  if (!rows.has(id)) {
    note('table', `"${id}" has no row in upgrades.csv — it falls back to the name and description in config.js.`);
  }
}

for (const u of copies) {
  const enabled = u.enabled !== false;
  if (enabled && u.weight === 0) {
    note('table', `"${u.id}" is enabled but weight 0 — it shows in the Upgrades tab and is never dealt.`);
  }
  if (enabled && !String(u.desc ?? '').trim()) {
    fail('table', `"${u.id}" is enabled with an empty description — the card body is blank.`);
  }
  if (enabled && !String(u.name ?? '').trim()) {
    fail('table', `"${u.id}" is enabled with an empty name.`);
  }
}

const dealable = copies.filter((u) => u.enabled !== false && u.weight > 0);
if (dealable.length < CONFIG.upgradeChoices) {
  fail('table', `Only ${dealable.length} upgrades can be dealt, but a level-up offers ${CONFIG.upgradeChoices}.`);
}

// ===========================================================================
// 3. FEEDBACK COVERAGE
// ===========================================================================

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (entry.endsWith('.js')) yield full;
  }
}

// Comments have to go before scanning, or config.js's own "call feedback('name',
// ...) to use it" note registers as an event named `name`.
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// The event name is not always a bare literal at the call site. Three of the
// loudest events in the game are chosen by a ternary —
//
//   feedback(killEvent ?? (big ? 'bigKill' : 'kill'), …)
//
// — and `bakalarHaul` only ever arrives as an argument passed in from a call
// two functions away. A regex anchored to `feedback('name'` reported all four
// as dead entries, which is exactly the kind of confident wrong answer that
// makes a check worth ignoring. So: take the whole first argument and pull
// every string literal out of it.
function firstArgOf(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    } else if (c === ',' && depth === 1) return text.slice(openIdx + 1, i);
  }
  return '';
}

const fired = new Map(); // event -> [files]
// Every quoted string in the codebase, as the fallback for a name that only
// ever travels as a variable. Weaker evidence than a call site, and treated
// that way: it downgrades "dead entry" to silence, it never proves a wiring.
const quotedAnywhere = new Set();

for (const file of sourceFiles(SRC)) {
  const text = stripComments(await readFile(file, 'utf8'));
  const rel = relative(SRC, file);

  for (const m of text.matchAll(/\bfeedback\s*\(/g)) {
    const arg = firstArgOf(text, m.index + m[0].length - 1);
    for (const lit of arg.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) {
      if (!fired.has(lit[1])) fired.set(lit[1], []);
      if (!fired.get(lit[1]).includes(rel)) fired.get(lit[1]).push(rel);
    }
  }

  for (const lit of text.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) quotedAnywhere.add(lit[1]);
}

const configured = new Set(Object.keys(CONFIG.feedback));

for (const [event, files] of fired) {
  if (!configured.has(event)) {
    fail('feedback', `feedback('${event}') is fired in ${files.join(', ')} but has no entry in CONFIG.feedback — it warns and does nothing.`);
  }
}

for (const event of configured) {
  if (!fired.has(event) && !quotedAnywhere.has(event)) {
    note('feedback', `CONFIG.feedback.${event} is configured, and its name appears nowhere in the source — nothing can fire it.`);
  }
}

// An entry that survived the tuning merge with every channel empty is the
// failure mode that looks like working code: the call site is there, the key
// is there, and nothing happens. Saved nulls in imported-tuning.json beat the
// defaults in config.js, which is exactly how an entry ends up inert.
const CHANNELS = ['emit', 'shake', 'hitstop', 'glow', 'ripple', 'sfx', 'haptic', 'toast'];
for (const [event, def] of Object.entries(CONFIG.feedback)) {
  if (def == null) {
    fail('feedback', `CONFIG.feedback.${event} is null in the merged config — every call to it is a no-op. Check imported-tuning.json.`);
    continue;
  }
  const live = CHANNELS.filter((c) => {
    const v = def[c];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== 0 && v !== false;
  });
  if (!live.length) {
    fail('feedback', `CONFIG.feedback.${event} has no live channel — no particles, shake, glow, ripple, sound, haptic or toast.`);
  }
}

// ===========================================================================
// REPORT
// ===========================================================================

if (AS_JSON) {
  console.log(JSON.stringify({
    upgrades: replays.length,
    snapshot: { status: snapshotStatus, diffs: snapshotDiffs },
    problems,
    notes,
    feedback: {
      fired: Object.fromEntries(fired),
      configured: [...configured],
    },
  }, null, 2));
} else {
  const bar = '─'.repeat(72);
  console.log(`\n${bar}\nUPGRADE CHECK — ${replays.length} upgrades, ${rows.size} CSV rows, ${configured.size} feedback events\n${bar}`);

  console.log(`\n1. STAT MATH  (snapshot ${snapshotStatus})`);
  for (const r of replays.slice(0, ONLY ? 99 : 0)) {
    console.log(`\n   ${r.id}  (cap ${r.cap ?? 'unlimited'})`);
    r.perStack.forEach((changed, i) => {
      const fields = Object.entries(changed).map(([k, v]) => `${k}=${v}`).join('  ');
      console.log(`     stack ${i + 1}: ${fields || '(no change)'}`);
    });
  }
  if (!ONLY) {
    const bad = problems.filter((p) => p.section === 'stat math').length;
    console.log(bad ? `   ${bad} difference(s) from the snapshot.` : '   ✓ every upgrade matches the snapshot.');
    console.log('   (--only <id> prints an upgrade\'s per-stack numbers)');
  }

  const section = (n, label) => {
    const errs = problems.filter((p) => p.section === label);
    const ns = notes.filter((p) => p.section === label);
    console.log(`\n${n}. ${label.toUpperCase()}`);
    if (!errs.length) console.log('   ✓ no problems.');
    for (const e of errs) console.log(`   ✗ ${e.msg}`);
    for (const x of ns) console.log(`   · ${x.msg}`);
  };
  section(2, 'table');
  section(3, 'feedback');

  const statNotes = notes.filter((p) => p.section === 'stat math');
  if (statNotes.length) {
    console.log('\n   stat math notes');
    for (const x of statNotes) console.log(`   · ${x.msg}`);
  }

  console.log(`\n${bar}`);
  console.log(problems.length ? `FAIL — ${problems.length} problem(s), ${notes.length} note(s)\n` : `PASS — ${notes.length} note(s)\n`);
}

process.exit(problems.length ? 1 : 0);
