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
// THREE LOGS, AND THEY ARE NOT THE SAME MACHINE. `playtest/runs.jsonl` is what
// this machine played in a browser; `playtest/remote.jsonl` is what a deployed
// build filed from somebody's phone; and the desktop log in Electron's userData
// is what the packaged .app played. Reading only the first was the whole reason
// a phone run with 808 hitches never once appeared here: the numbers that
// matter come from four cores and a 3x display, and the numbers on disk came
// from ten cores and a desktop GPU. All three are read now and every run says
// which it is, because a median frame time averaged across them describes no
// device that exists.
//
// THE DESKTOP LOG IS NOT IN THE REPO, which is the one surprising thing here.
// It lives beside the desktop build's save file because that is where the shell
// can write on a player's machine, and electron/playtest.js explains why it
// must stay out of the Steam Cloud glob. Absent — because the .app has never
// been run — is the normal case and not an error.
//
// Usage:
//   npm run perf              the last 5 runs, any log
//   npm run perf -- 20        the last 20
//   npm run perf -- remote    only the runs phones filed
//   npm run perf -- local     only this machine's browser runs
//   npm run perf -- desktop   only the packaged .app's runs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the desktop shell's run log is, without importing Electron to ask.
 *
 * THE DIRECTORY NAME IS package.json's `name`, read rather than typed. Electron
 * derives userData from app.getName(), which is `productName` when package.json
 * declares one and `name` otherwise — this package declares only `name`, and
 * "Seal Survivor" lives in electron-builder.yml where app.getName() never sees
 * it. Reading the field means a rename moves both halves together instead of
 * leaving this tool pointed at a directory nothing writes to any more, which
 * would present as a desktop build that had simply stopped filing runs.
 */
function desktopLog() {
  const name = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')).name;
  const home = homedir();
  const dir = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', name)
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), name)
      : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), name);
  return join(dir, 'playtest.jsonl');
}

const SOURCES = [
  { tag: 'local',   file: resolve(HERE, '../playtest/runs.jsonl') },
  { tag: 'desktop', file: desktopLog() },
  { tag: 'remote',  file: resolve(HERE, '../playtest/remote.jsonl') },
];

const args = process.argv.slice(2);
const only = args.find((a) => SOURCES.some((s) => s.tag === a)) ?? null;
const want = Number(args.find((a) => Number(a) > 0)) || 5;
const wanted = SOURCES.filter((s) => !only || s.tag === only);

const present = wanted.filter((s) => existsSync(s.file));
if (!present.length) {
  console.error(`\nno runs on disk yet — ${wanted.map((s) => s.file).join('\n                       ')}`
    + `\nPlay a run with the dev server up; it files itself on death.`
    + `\nPhone runs arrive with \`npm run playtest:pull\`.\n`);
  process.exit(1);
}

const runs = present.flatMap(({ tag, file }) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try { return { ...JSON.parse(line), __src: tag }; }
      catch { console.warn(`  (skipped a malformed line ${i + 1} of ${tag})`); return null; }
    })
    .filter(Boolean));

// Chronological across both logs, so `the last 5` means the last five runs
// played rather than the last five lines of whichever file was read second.
//
// `startedAt` is not one type. Older records carry an ISO string and newer ones
// an epoch number, and comparing them AS STRINGS sorts every numeric stamp
// before every ISO one — "1787891185136" < "2026-…" on the first character —
// which silently buried the newest run in the middle of the report. Normalise
// to epoch ms and compare numbers.
const at = (r) => {
  const v = r.startedAt;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(v ?? '');
  return Number.isFinite(t) ? t : 0;
};
runs.sort((a, b) => at(a) - at(b));

const withPerf = runs.filter((r) => r.perf?.frames);
if (!withPerf.length) {
  console.log(`\n${runs.length} run(s) on disk, none carrying frame times yet.`);
  console.log('Frame times were added after these were recorded — play one more run and it will be here.\n');
  process.exit(0);
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'unknown');

const srcCount = (t) => withPerf.filter((r) => r.__src === t).length;
console.log(`\n${withPerf.length} run(s) with frame times, of ${runs.length} on disk`
  + ` — ${srcCount('local')} local, ${srcCount('desktop')} desktop, ${srcCount('remote')} from phones.`
  + ` Showing the last ${Math.min(want, withPerf.length)}.`);

for (const r of withPerf.slice(-want)) {
  const p = r.perf;
  const g = r.render ?? {};
  const fps = p.meanMs ? 1000 / p.meanMs : 0;
  const d = r.meta?.device ?? {};
  // WHICH MACHINE. Without this the report reads as one device's history and
  // a 4-core phone's p99 sits in the same column as a desktop's, inviting a
  // comparison that is not a comparison.
  // The SOURCE and the DEVICE are different facts and conflating them was a
  // bug in the first cut of this: a run can be filed to the remote log from a
  // desktop, and calling every remote run a phone put a 10-core Mac under a
  // heading that said otherwise.
  // THE SOURCE AND THE SHELL ARE DIFFERENT FACTS. `__src` is which log the line
  // came out of; `shell` is what the game was running inside when it played.
  // They usually agree and the case where they do not is the interesting one —
  // a desktop build could file to the remote collection, and a browser run
  // pulled from a phone is not a desktop run whatever log it landed in. Older
  // records carry no `shell` at all, so `native` stays as the fallback rather
  // than being replaced by it.
  const shell = d.shell && d.shell !== 'web' ? ` · ${d.shell} shell`
    : d.native ? ' · native shell' : '';
  const rig = d.w
    ? `${r.__src} · ${d.w}×${d.h}@${d.dpr ?? 1}x · ${d.cores ?? '?'} cores`
      + `${d.touch ? ' · touch' : ''}${shell}`
    : r.__src;
  console.log(`\n─── ${when(r.startedAt)} · level ${r.level ?? '?'} · ${r.endReason ?? '?'} ─────────────────`);
  console.log(`  ${rig}`);
  console.log(`  ${clock(p.seconds)}, ${p.frames.toLocaleString()} frames, ${fps.toFixed(1)} fps mean`
    + (g.draws ? `  ·  ${g.draws} draws · ${g.mpix} Mpix · scale ${g.scale} · ${g.enemies} enemies` : ''));
  console.log(`  median ${p.medianMs}ms · p95 ${p.p95Ms}ms · p99 ${p.p99Ms}ms · worst ${p.worstMs.toFixed(0)}ms`);
  console.log(`  hitches >33ms: ${p.hitches} (${(p.hitches / p.frames * 100).toFixed(1)}% of frames) · spikes >100ms: ${p.spikes}`);
  if (p.hitchCompile != null) {
    console.log(`  attributed: ${p.hitchCompile} shader link · ${p.hitchUpload} texture upload`
      + `${p.hitchGC != null ? ` · ${p.hitchGC} collection` : ''} · ${p.hitchNeither} none of those`);
    console.log(`  built this run: ${p.programsAdded} programs, ${p.texturesAdded} textures`
      + (p.heapPeakMB ? `  ·  heap peak ${p.heapPeakMB.toFixed(0)}MB, ${p.heapFreedMB.toFixed(0)}MB collected` : ''));
    // WHICH ONES, and it is a different list from the churn below. `rebuilt`
    // is a program being thrown away and relinked, which no warm-up can fix;
    // this is a program that was never warmed at all and linked on a frame the
    // player felt. Ranked by the time of those frames — one link on a 600ms
    // frame is the thing to go and warm, and forty on 34ms frames are not.
    //
    // Absent on runs recorded before the recorder collected it, which is every
    // run on disk today; the block simply does not print rather than claiming
    // a clean warm-up.
    if (p.missedPrograms?.length) {
      console.log(`  the warm-up missed these — linked ON A HITCH `
        + `(${p.hitchProgramKeys} distinct, worst first):`);
      for (const q of p.missedPrograms) {
        console.log(`     ${q.ms.toFixed(0)}ms over ${q.builds} frame(s)  ${q.key}`);
      }
    }
    if (p.topPrograms?.length) {
      for (const q of p.topPrograms) console.log(`  rebuilt ${q.builds}x: ${q.key}`);
    }
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

  // DOES THE DRAW COUNT GROW WITH THE CROWD, OR WITH THE BUILD?
  //
  // On the phone it was the build, and that took a long time to see because
  // every number that could have said so was a single reading taken at death.
  // Draws per frame climbed from ~100 at level 1 to a sustained 3184 at level
  // 16 with sixty-one enemies in the water, while the frame rate fell from 57
  // to 22 — and enemies alive over the same stretch went UP and DOWN with no
  // relation to any of it. multishot, rapidFire and projectileAmount all
  // multiply the number of things in the air, so the cost is a function of
  // what the player picked rather than of what the ocean sent.
  //
  // Printed as a curve rather than a total for exactly that reason: the shape
  // over a run is the finding, and a mean across it hides the shape completely.
  // `shots` and `ribbons` are HOW MANY, and `scene` is what they cost — they
  // stopped being the same number once the pellets went into an instance
  // buffer (entities/projectiles.js) and the ribbons were merged into one mesh
  // per length (systems/projectileTrails.js). `batched` is how many of the
  // scene's children are one of those. A run where shots and ribbons climb and
  // `scene` does not is the batching holding.
  const withDraws = (r.buckets ?? []).filter((b) => b.samples > 0 && b.drawSum > 0);
  if (withDraws.length > 1 && withDraws.some((b) => b.shotSum != null)) {
    console.log('  draws per frame, over the run:');
    console.log('       t   lvl  alive  draws   shots  ribbons  scene    batched');
    for (const b of withDraws) {
      const per = (sum) => (sum == null ? '—' : (sum / b.samples).toFixed(0));
      console.log(`    ${String(b.t).padStart(4)}  ${String(b.level).padStart(3)}`
        + `  ${per(b.aliveSum).padStart(5)}  ${per(b.drawSum).padStart(5)}`
        + `  ${per(b.shotSum).padStart(6)}  ${per(b.ribbonSum).padStart(7)}`
        + `  ${per(b.sceneSum).padStart(5)}  ${per(b.instancedSum).padStart(9)}`);
    }
    // The reading, said in words, because the two columns to compare are not
    // adjacent and the wrong pair is the natural one to look at.
    const first = withDraws[0];
    const last = withDraws[withDraws.length - 1];
    const growth = (a, b_, key) => (a[key] && a.samples && b_.samples
      ? (b_[key] / b_.samples) / (a[key] / a.samples) : 0);
    const draws = growth(first, last, 'drawSum');
    const alive = growth(first, last, 'aliveSum');
    if (draws > 1.5 && draws > alive * 1.5) {
      console.log(`  -> draws grew ${draws.toFixed(1)}x across the run while the crowd grew`
        + ` ${alive.toFixed(1)}x.`);
      console.log('     That is the BUILD buying draw calls, not the ocean. Look at the shots');
      console.log('     and ribbons columns before touching resolution or spawn caps.');
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
        console.log(p.missedPrograms?.length
          ? `     The keys are listed above — warm those and this block goes away.`
          : `     This run predates the key list; play one more and it will name them.`);
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
