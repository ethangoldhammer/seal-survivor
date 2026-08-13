#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run perf
//
// Frame times for the runs on disk. The recorder (systems/perfLog.js) files its
// distribution alongside every run in playtest/runs.jsonl, so this reads them
// from a terminal — no browser console, no being sat in front of the machine
// when the hitch happened.
//
// The shape of the answer is in WHERE the worst frames land:
//
//   spread evenly through a run   memory paging or GC — something is being
//                                 allocated or evicted continuously
//   clustered in the first 20s    shader programs still compiling on first
//                                 draw, which the warm-up was meant to cover
//   a few, at repeatable moments  one event is expensive (a hull breaking up,
//                                 a boss arriving) — go and look at that system
//
// Usage:
//   npm run perf          the last 5 runs
//   npm run perf -- 20    the last 20
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '../playtest/runs.jsonl');
const want = Number(process.argv[2]) || 5;

if (!existsSync(FILE)) {
  console.error(`\nno runs on disk yet — ${FILE}\nPlay a run with the dev server up; it files itself on death.\n`);
  process.exit(1);
}

const runs = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, i) => {
    try { return JSON.parse(line); } catch { console.warn(`  (skipped a malformed line ${i + 1})`); return null; }
  })
  .filter(Boolean);

const withPerf = runs.filter((r) => r.perf?.frames);
if (!withPerf.length) {
  console.log(`\n${runs.length} run(s) on disk, none carrying frame times yet.`);
  console.log('Frame times were added after these were recorded — play one more run and it will be here.\n');
  process.exit(0);
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'unknown');

console.log(`\n${withPerf.length} run(s) with frame times, of ${runs.length} on disk. Showing the last ${Math.min(want, withPerf.length)}.`);

for (const r of withPerf.slice(-want)) {
  const p = r.perf;
  const g = r.render ?? {};
  const fps = p.meanMs ? 1000 / p.meanMs : 0;
  console.log(`\n─── ${when(r.startedAt)} · level ${r.level ?? '?'} · ${r.endReason ?? '?'} ─────────────────`);
  console.log(`  ${clock(p.seconds)}, ${p.frames.toLocaleString()} frames, ${fps.toFixed(1)} fps mean`
    + (g.draws ? `  ·  ${g.draws} draws · ${g.mpix} Mpix · scale ${g.scale} · ${g.enemies} enemies` : ''));
  console.log(`  median ${p.medianMs}ms · p95 ${p.p95Ms}ms · p99 ${p.p99Ms}ms · worst ${p.worstMs.toFixed(0)}ms`);
  console.log(`  hitches >33ms: ${p.hitches} (${(p.hitches / p.frames * 100).toFixed(1)}% of frames) · spikes >100ms: ${p.spikes}`);
  if (p.hitchCompile != null) {
    console.log(`  attributed: ${p.hitchCompile} shader link · ${p.hitchUpload} texture upload`
      + `${p.hitchGC != null ? ` · ${p.hitchGC} collection` : ''} · ${p.hitchNeither} none of those`);
    console.log(`  built this run: ${p.programsAdded} programs, ${p.texturesAdded} textures`
      + (p.heapPeakMB ? `  ·  heap peak ${p.heapPeakMB.toFixed(0)}MB, ${p.heapFreedMB.toFixed(0)}MB collected` : ''));
  }

  if (p.worst?.length) {
    console.log(`  worst frames: ${p.worst.map((w) => `${w.ms.toFixed(0)}ms @ ${clock(w.at)}${w.why ? ` (${w.why})` : ''}`).join(' · ')}`);

    // Where in the run they fell, which is the diagnosis. Early-and-clustered
    // is a different bug from spread-out, and the eye is bad at telling a list
    // of timestamps apart from a distribution.
    // Attribution beats inference. The old version of this guessed from WHERE
    // the spikes landed, which was the best available before the counters
    // existed and is now just a worse way of asking the same question.
    if (p.hitchCompile != null && p.hitches > 0) {
      const firstDraw = p.hitchCompile + p.hitchUpload;
      if (firstDraw / p.hitches >= 0.5) {
        console.log(`  -> ${firstDraw} of ${p.hitches} hitches are FIRST-DRAW costs: ${p.programsAdded} shader programs and`);
        console.log(`     ${p.texturesAdded} textures arrived during play. The warm-up is meant to have paid for`);
        console.log(`     those before the run started, so whatever it is compiling, it is not this.`);
      } else if ((p.hitchGC ?? 0) / p.hitches >= 0.5) {
        console.log(`  -> ${p.hitchGC} of ${p.hitches} hitches are the COLLECTOR — the heap dropped on those`);
        console.log(`     frames. ${p.heapFreedMB?.toFixed(0) ?? '?'}MB was reclaimed across the run against a ${p.heapPeakMB?.toFixed(0) ?? '?'}MB peak.`);
        console.log(`     Find what allocates per frame; the pauses follow the garbage.`);
      } else if (p.hitchNeither / p.hitches >= 0.5) {
        console.log(`  -> ${p.hitchNeither} of ${p.hitches} hitches are none of the four: not a link, not an`);
        console.log(`     upload, and the heap did not drop. That is real work on those frames —`);
        console.log(`     a profile is the next tool, not another counter.`);
      } else {
        console.log(`  -> mixed: ${firstDraw} first-draw, ${p.hitchNeither} other. Both are worth a look.`);
      }
    } else if (p.seconds > 45) {
      console.log(`  -> recorded before spike attribution existed; play another run for the breakdown.`);
    }
  }
}
console.log();
