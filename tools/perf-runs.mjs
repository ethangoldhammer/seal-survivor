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

  // WHERE THE FRAME TIME WENT. Two columns and they answer different
  // questions: `per frame` is the steady cost (a phase at 60% of the run is
  // simply the expensive one, and the place to spend an optimisation), while
  // `per hitch` is what that phase cost on the frames that stuttered (a phase
  // at 4% of the run and 15ms per hitch is SPIKY, which is a different bug and
  // a different fix).
  if (p.phases?.length) {
    const named = p.phases.reduce((a, q) => a + q.msPerFrame, 0);
    const frameMs = p.meanMs ?? 0;
    // THE THREE-WAY SPLIT, and the reason `jsMsPerFrame` is recorded apart
    // from the leaf phases rather than as one of them: what the leaves do not
    // account for is either code nothing wraps yet, or the loop not executing
    // at all — waiting on vsync, or blocked in the driver behind the GPU.
    // Opposite diagnoses, opposite fixes, and indistinguishable without this.
    const js = p.jsMsPerFrame ?? 0;
    console.log(`  per frame: ${p.phases.map((q) => `${q.name} ${q.msPerFrame.toFixed(2)}ms`).join(' · ')}`
      + (js ? ` · untimed JS ${Math.max(0, js - named).toFixed(2)}ms · not running ${Math.max(0, frameMs - js).toFixed(2)}ms`
        : ` · unmeasured ${Math.max(0, frameMs - named).toFixed(2)}ms`));
    if (p.hitches > 0) {
      const namedH = p.phases.reduce((a, q) => a + q.msPerHitch, 0);
      const jsH = p.jsMsPerHitch ?? 0;
      console.log(`  per hitch: ${p.phases.map((q) => `${q.name} ${q.msPerHitch.toFixed(1)}ms`).join(' · ')}`
        + (jsH ? ` · untimed JS ${Math.max(0, jsH - namedH).toFixed(1)}ms` : ''));
    }
    if (js && p.seconds > 45) {
      // Which of the two it is, said in words. The per-HITCH column is the one
      // that decides it: a run can idle happily on its good frames and still
      // be JS-bound on the bad ones, and the per-frame average blends those.
      const namedH = p.phases.reduce((a, q) => a + q.msPerHitch, 0);
      const jsH = p.jsMsPerHitch ?? 0;
      const untimedH = Math.max(0, jsH - namedH);
      if (jsH > 0 && untimedH > namedH) {
        console.log(`  -> on a hitch frame, ${untimedH.toFixed(0)}ms of JS is in code no phase wraps,`);
        console.log(`     against ${namedH.toFixed(0)}ms in the ones that do. Bisect the loop further —`);
        console.log(`     the work is real and it is not where the phases are looking.`);
      } else if (jsH > 0 && jsH < 8) {
        console.log(`  -> a hitch frame runs only ${jsH.toFixed(0)}ms of JS, so the stall is NOT this loop:`);
        console.log(`     the tab is blocked outside it — vsync, the compositor, or a GPU behind.`);
        console.log(`     No amount of cutting JS work will move it.`);
      }
    }
  }

  // WHICH MOMENTS THE BAD FRAMES LAND IN. `lift` is hitches-per-frame while
  // the mark was hot against the run's own rate — a mark hot for most of the
  // run collects most of the hitches by doing nothing, so the tally on its own
  // says only how common the mark is.
  if (p.marks?.length) {
    const skewed = p.marks.filter((m) => m.lift >= 1.5 || m.lift <= 0.67);
    for (const m of skewed) {
      console.log(`  while "${m.name}" (${(m.shareOfRun * 100).toFixed(0)}% of frames):`
        + ` ${m.hitches} of ${p.hitches} hitches — ${m.lift.toFixed(1)}x the run's rate`);
    }
    if (!skewed.length) {
      console.log(`  marks: ${p.marks.map((m) => `${m.name} ${m.lift.toFixed(1)}x`).join(' · ')}`
        + ` — none of them skews, so the hitches are not tied to any of these moments.`);
    }
  }

  if (p.worst?.length) {
    console.log(`  worst frames: ${p.worst.map((w) => {
      const parts = w.split?.length ? ` [${w.split.map((q) => `${q.name} ${q.ms.toFixed(0)}`).join(' ')}]` : '';
      const tags = w.marks?.length ? ` {${w.marks.join(',')}}` : '';
      return `${w.ms.toFixed(0)}ms @ ${clock(w.at)}${w.why ? ` (${w.why})` : ''}${parts}${tags}`;
    }).join(' · ')}`);

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
        console.log(`     read the per-hitch phase split and the mark lifts above, which say`);
        console.log(`     which part of the frame and which moment of the run that work was in.`);
      } else {
        console.log(`  -> mixed: ${firstDraw} first-draw, ${p.hitchNeither} other. Both are worth a look.`);
      }
    } else if (p.seconds > 45) {
      console.log(`  -> recorded before spike attribution existed; play another run for the breakdown.`);
    }
  }
}
console.log();
