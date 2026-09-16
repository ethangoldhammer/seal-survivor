#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run gates
//
// THE PANEL'S LEDGER, RUN OFFLINE — every lunging archetype against a seal that
// actually swims, seeded, with the share of each fight that every gate held
// things up for.
//
// The V panel answers "why did THAT boss not commit" while you are dodging it.
// This answers the other shape of the same question: "which gate is holding up
// the WHOLE ROSTER", which is a question about ten fights at once and therefore
// one no panel can be read fast enough to answer. It is the same recorder —
// systems/attackTrace.js — pointed at a batch instead of at a frame.
//
// Read the `commit` column first. It is runs per minute of fight, and it is the
// number the report "it never commits" is actually about; everything to the
// right of it is why.
//
//   npm run gates             every archetype
//   npm run gates bossShark   one of them, with its log
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import {
  setAttackTrace, attackTraceReport, resetAttackTrace, tickAttackTrace, GATES,
} from '../path/src/systems/attackTrace.js';

const scene = new THREE.Scene();
const realWarn = console.warn;
console.warn = (m, ...r) => {
  if (typeof m === 'string' && /^\[(animation|assets|feedback)\]/.test(m)) return;
  realWarn(m, ...r);
};

const argv = process.argv.slice(2);
// Flag values are skipped rather than treated as the body name — `--escorts 5`
// otherwise filtered the roster down to a creature called "5" and printed an
// empty table, which reads exactly like the tool being broken.
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const only = positional[0] ?? null;
// HOW MANY OTHER APEX BODIES ARE IN THE WATER, which is the one condition an
// empty-arena run cannot see. The `crowd` gate is the feeding ring refusing a
// body its turn (systems/apexCrowd.js) and it can only ever close when there is
// a ring — so a solo fight reports it at 0% however broken it is.
//
//   npm run gates -- --escorts 5
const escortsFlag = argv.indexOf('--escorts');
const ESCORTS = escortsFlag > -1 ? Number(argv[escortsFlag + 1] ?? 4) : 0;
const dt = 1 / 60;
const MID = -20;
const SECONDS = 90;
const SEEDS = [1, 2, 3, 4, 5, 6];

const LUNGERS = Object.entries(CONFIG.enemies)
  .filter(([, d]) => d.lunge)
  .map(([k]) => k)
  .filter((k) => !only || k === only);

// THE SEAL'S REAL SPEED, measured rather than guessed: updatePlayer on a full
// stick settles at 15 u/s (CONFIG.player.maxSpeed is 34, which is the dash
// ceiling, not the cruise). Both audits in this directory used to drive it at
// 7-9, which is HALF a real player — and every figure they produced was
// therefore measured against a target moving at half speed, in the direction
// that flatters the boss. A boss's committed run is 20-24 u/s, so the closing
// speed against a real seal is four units a second rather than fifteen.
const SEAL_SPEED = 15;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// A SEAL THAT MOVES, and this matters more than anything else in the file: a
// stationary target is the one case a stale aim still looks correct on, which
// is most of why the aim bug was invisible for as long as it was. This is a
// lazy circuit at roughly the seal's own cruise, seeded per run so two
// archetypes are compared against the same swim.
function swimmer(seed) {
  const rnd = seeded(seed + 7777);
  const speed = SEAL_SPEED * (0.85 + rnd() * 0.3);
  const r = 10 + rnd() * 8;
  const phase = rnd() * Math.PI * 2;
  return (t) => ({
    x: Math.cos(phase + (t * speed) / r) * r,
    y: MID + Math.sin(phase * 1.7 + (t * speed) / (r * 1.4)) * (r * 0.45),
  });
}

function fight(type, seed) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    resetEnemies(scene);
    setAttackTrace(false);
    setAttackTrace(true);
    const at = swimmer(seed);
    const e = spawnNamed(scene, type, 6, { x: -22, y: MID }, { ignoreCaps: true });
    if (!e) return null;
    // `isBoss` IS WRITTEN BY HAND, the way tools/boss-dodge-test.mjs does it,
    // and it is not cosmetic: the feeding ring seats a boss ahead of the crowd
    // on that flag (see assignFeedingSlots), so a harness that spawned the body
    // without it would measure a boss queueing behind its own escorts and
    // report a fix as having done nothing. Which is exactly what happened once.
    //
    // spawnNamed is the right door — forceBoss runs the whole arrival ceremony,
    // which is three seconds of hush and a riser per fight — but the flag is
    // part of what being a boss means and has to be set either way.
    if (type.startsWith('boss')) e.isBoss = true;
    // Plain sharks, spread around the seal, so the ring is a real ring rather
    // than a pile. They carry lunge blocks of their own and will report gates
    // too — the ledger is per-fight, not per-creature, which is exactly right
    // for the question "what is holding this fight up".
    for (let k = 0; k < ESCORTS; k++) {
      const a = (k / Math.max(1, ESCORTS)) * Math.PI * 2;
      spawnNamed(scene, 'shark', 6,
        { x: Math.cos(a) * 12, y: MID + Math.sin(a) * 6 }, { ignoreCaps: true });
    }
    const pos = new THREE.Vector3();
    for (let i = 0; i < Math.round(SECONDS / dt); i++) {
      const p = at(i * dt);
      pos.set(p.x, p.y, 0);
      tickAttackTrace(dt);
      updateEnemies(dt, scene, pos, () => {}, () => {});
      if (!enemies.includes(e)) break;
    }
    // FOCUSED ON THE BODY BEING STUDIED. With escorts in the water the ledger
    // is six creatures reporting into one table and the escorts outnumber the
    // subject five to one — the crowd share would be theirs, read as the
    // boss's. See attackTraceReport.
    return attackTraceReport(e);
  } finally {
    Math.random = orig;
    setAttackTrace(false);
  }
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

console.log(`\n${SECONDS}s per fight, ${SEEDS.length} seeds, against a seal that swims`
  + `${ESCORTS ? `, with ${ESCORTS} other apex bodies in the water` : ', alone in the arena'}.\n`);
console.log(`${pad('body', 17)}${rpad('runs/min', 9)}${rpad('closest', 9)}  ${GATES.map((g) => rpad(g.slice(0, 8), 9)).join('')}`);
console.log('-'.repeat(17 + 18 + GATES.length * 9));

const rows = [];
for (const type of LUNGERS) {
  const share = new Map();
  let commits = 0;
  let winds = 0;
  let seconds = 0;
  const closest = [];
  for (const seed of SEEDS) {
    const rep = fight(type, seed);
    if (!rep) continue;
    commits += rep.tally.commits;
    winds += rep.tally.winds;
    seconds += rep.clock;
    for (const g of rep.gates) share.set(g.gate, (share.get(g.gate) ?? 0) + g.seconds);
    // This body's runs, not every run in the water — `rep.events` is the whole
    // fight's log and with escorts up most of it is theirs.
    for (const d of rep.closest ?? []) closest.push(d);
    if (only) {
      for (const ev of rep.events.slice(0, 60)) {
        console.log(`    ${ev.t.toFixed(1)}s  ${ev.text}`);
      }
      console.log('    ---');
    }
  }
  const total = [...share.values()].reduce((a, b) => a + b, 0) || 1;
  closest.sort((a, b) => a - b);
  const median = closest.length ? closest[Math.floor(closest.length / 2)] : NaN;
  rows.push({ type, perMin: (commits / seconds) * 60, winds, commits, median, share, total });
  console.log(
    pad(type, 17)
    + rpad(((commits / seconds) * 60).toFixed(1), 9)
    + rpad(Number.isFinite(median) ? `${median.toFixed(1)}u` : '—', 9)
    + '  '
    + GATES.map((g) => rpad(`${Math.round(((share.get(g) ?? 0) / total) * 100)}%`, 9)).join(''),
  );
}

console.log('\nruns/min is committed strikes per minute of fight. closest is the median '
  + 'closest approach a run got to the seal.');
console.log('A gate at a high share is the one holding that body up — see the note on each '
  + 'in path/src/ui/attackDebug.js.\n');
