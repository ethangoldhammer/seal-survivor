#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:perf
//
// The frame-time recorder (systems/perfLog.js). Every number it reports is one
// nobody can check by eye — that is the entire reason it exists — so a bug in
// it is not a wrong answer, it is a confident wrong answer that gets acted on.
//
// The two that matter most:
//
//   THE CLAMP. The game loop feeds the simulation `Math.min(elapsed, 0.05)`.
//     Wire that into the recorder instead of the raw stamp and every hitch in
//     the game records as exactly 50ms — the worst-frame column reads 50.0
//     forever and the thing the tool was built to find becomes invisible. The
//     recorder takes stamps for this reason, and this file feeds it a 300ms
//     frame to prove the number survives.
//   THE GAPS. A backgrounded tab produces a frame delta of whole seconds, and
//     the first frame of a run spans the menu teardown. Neither is a hitch.
//     Counted, they would top the worst list for the rest of the run.
//
//   node --import ./tools/vite-loader.mjs tools/perf-log-test.mjs
// ---------------------------------------------------------------------------

import {
  perfRunStart, perfFrame, perfSummary, perfWindow, perfStop,
} from '../path/src/systems/perfLog.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// Feed a sequence of frame durations as if they were rAF stamps.
function play(durations, start = 1000) {
  let t = start;
  perfRunStart(t);
  for (const ms of durations) {
    t += ms;
    perfFrame(t);
  }
  return t;
}

// ===========================================================================
section('A steady 60fps');

play(new Array(600).fill(16.7));
let s = perfSummary();
check('every frame counted', s.frames === 600, `${s.frames}`);
check('the mean is the frame time', Math.abs(s.meanMs - 16.7) < 0.01, `${s.meanMs.toFixed(2)}ms`);
check('the median lands in the 16ms bucket', s.medianMs === 16, `${s.medianMs}ms`);
check('nothing is a hitch', s.hitches === 0 && s.spikes === 0, `${s.hitches} hitches`);
check('the run length is wall time', Math.abs(s.seconds - 10.02) < 0.05, `${s.seconds.toFixed(2)}s`);

// ===========================================================================
section('One 300ms stall in a good run');

// THE test. A recorder fed the game loop's clamped dt reports 50 here.
play([...new Array(300).fill(16.7), 300, ...new Array(300).fill(16.7)]);
s = perfSummary();
check('the stall is recorded at its real size', Math.abs(s.worstMs - 300) < 0.01,
  `worst ${s.worstMs.toFixed(1)}ms`);
check('and is counted once as a hitch and once as a spike',
  s.hitches === 1 && s.spikes === 1, `${s.hitches} hitches, ${s.spikes} spikes`);
check('the median is untouched by it', s.medianMs === 16, `${s.medianMs}ms`);
check('and it is named with the time it happened',
  s.worst[0] && Math.abs(s.worst[0].ms - 300) < 0.01 && Math.abs(s.worst[0].at - 5.31) < 0.1,
  s.worst[0] ? `${s.worst[0].ms.toFixed(0)}ms @ ${s.worst[0].at.toFixed(2)}s` : 'no worst frame');

// THE POINT OF THE WHOLE FILE, as one assertion. A stall long enough to stop
// the game dead moves the average by half a millisecond — which is why "what's
// the fps" cannot answer "why does it hitch", and why the report leads with
// worst and hitches instead.
//
// Note it is not p99 that catches this either, and that is arithmetic rather
// than a flaw: one bad frame in 601 is the 99.8th percentile, so p99 correctly
// reports 16ms. Percentiles find a RATE of bad frames; `worst` finds a single
// one. The report prints both because a run can have either problem.
check('the mean hides a stall that worst catches',
  s.meanMs < 17.2 && s.worstMs > 290,
  `mean ${s.meanMs.toFixed(2)}ms (16.7 with no stall) vs worst ${s.worstMs.toFixed(0)}ms`);

// ===========================================================================
section('Percentiles');

// 880 frames at 16ms, 90 at 25ms, 30 at 60ms. Nearest-rank, so p95 is the
// 950th frame (in the 25s) and p99 the 990th (in the 60s) — the bands are
// sized so neither lands on a boundary, where either answer would be
// defensible and the test would only be pinning a convention.
play([
  ...new Array(880).fill(16.4),
  ...new Array(90).fill(25.4),
  ...new Array(30).fill(60.4),
]);
s = perfSummary();
check('p50 is the body of the distribution', s.medianMs === 16, `${s.medianMs}ms`);
check('p95 finds the middle band', s.p95Ms === 25, `${s.p95Ms}ms`);
check('p99 finds the tail', s.p99Ms === 60, `${s.p99Ms}ms`);
check('hitches count everything over 33ms', s.hitches === 30, `${s.hitches}`);

// ===========================================================================
section('Frames past the top of the histogram');

play([16.7, 16.7, 450, 16.7]);
s = perfSummary();
check('a 450ms frame still reports its real worst', Math.abs(s.worstMs - 450) < 0.01,
  `${s.worstMs.toFixed(0)}ms`);
check('and p99 saturates at the overflow bucket rather than lying', s.p99Ms === 120,
  `${s.p99Ms}ms`);

// ===========================================================================
section('Gaps that are not hitches');

// A backgrounded tab: one enormous delta, then normal frames.
play([16.7, 16.7, 4000, 16.7, 16.7]);
s = perfSummary();
check('a multi-second gap is dropped, not recorded', s.frames === 4, `${s.frames} frames`);
check('and leaves no hitch behind', s.hitches === 0 && s.worstMs < 20,
  `worst ${s.worstMs.toFixed(1)}ms`);

// The first frame of a run spans startGame's resets. perfRunStart stamps the
// clock, and the gap to the first real frame is menu teardown, not a frame.
perfRunStart(0);
perfFrame(2500); // the reset took 2.5s
perfFrame(2516.7);
s = perfSummary();
check("the run's first frame doesn't inherit the menu teardown",
  s.frames === 1 && s.worstMs < 20, `${s.frames} frame, worst ${s.worstMs.toFixed(1)}ms`);

// ===========================================================================
section('The rolling window');

// The live readout must forget: a hitch two minutes ago is not a reason for
// the number on screen to still be red while you sweep a slider.
play([...new Array(10).fill(16.7), 200, ...new Array(20).fill(16.7)]);
let w = perfWindow();
check('a recent stall is in the window', Math.abs(w.worstMs - 200) < 0.01,
  `${w.worstMs.toFixed(0)}ms`);
check('and is counted as a drop', w.hitches === 1, `${w.hitches}`);

// 120 frames is the window; run well past it and it should have cleared.
play([...new Array(10).fill(16.7), 200, ...new Array(200).fill(16.7)]);
w = perfWindow();
check('an old stall has fallen out of it', w.worstMs < 20, `${w.worstMs.toFixed(1)}ms`);
check('and so has its drop', w.hitches === 0, `${w.hitches}`);
// ...while the run summary still remembers it. The two answer different
// questions and must not be the same number.
check('but the run still remembers it', perfSummary().worstMs > 190,
  `${perfSummary().worstMs.toFixed(0)}ms`);

// ===========================================================================
section('A stall is attributed, not just counted');

// The whole point: "224 hitches" says the game stutters, which the player
// already knew. Which of the four costs it was paying is what has a fix.
const MB = 1048576;
perfRunStart(0, 100, 50, 500 * MB);
let t = 0;
const tick = (ms, { programs = 100, textures = 50, heap = 500 * MB } = {}) => {
  t += ms;
  perfFrame(t, programs, textures, heap);
};

tick(16);
tick(200, { programs: 101 });                 // a shader linked
tick(16, { programs: 101 });
tick(200, { programs: 101, textures: 51 });   // a texture uploaded
tick(16, { programs: 101, textures: 51 });
// A collection: the heap is the only one of the four that goes DOWN.
tick(200, { programs: 101, textures: 51, heap: 400 * MB });
tick(16, { programs: 101, textures: 51, heap: 400 * MB });
// And a stall that is none of them — real work on that frame.
tick(200, { programs: 101, textures: 51, heap: 400 * MB });

s = perfSummary();
check('a link is blamed on the link', s.hitchCompile === 1, `${s.hitchCompile}`);
check('an upload on the upload', s.hitchUpload === 1, `${s.hitchUpload}`);
check('a heap that fell on the collector', s.hitchGC === 1, `${s.hitchGC}`);
check('and one that is none of the four stays unattributed', s.hitchNeither === 1, `${s.hitchNeither}`);
check('the four sum to the hitch count',
  s.hitchCompile + s.hitchUpload + s.hitchGC + s.hitchNeither === s.hitches,
  `${s.hitchCompile}+${s.hitchUpload}+${s.hitchGC}+${s.hitchNeither} vs ${s.hitches}`);
check('and the reclaimed total is reported', Math.round(s.heapFreedMB) === 100,
  `${s.heapFreedMB.toFixed(0)}MB`);

// The blind spot that hid a recompile storm for two rounds of investigation:
// a RECOMPILE releases the old program and creates a new one, so the live
// count is unchanged. main.js feeds the highest program id ever issued instead
// of the array length, and the recorder must count that rise as a compile.
perfRunStart(0, 100, 50, 0);
t = 0;
tick(16, { programs: 100, textures: 50, heap: 0 });
tick(200, { programs: 140, textures: 50, heap: 0 }); // 40 rebuilt, net length 0
s = perfSummary();
check('forty programs rebuilt in a frame reads as a compile', s.hitchCompile === 1,
  `compile ${s.hitchCompile}, other ${s.hitchNeither}`);
check('and all forty are counted', s.programsAdded === 40, `${s.programsAdded}`);

// No heap reading at all (Safari, iOS) must not turn every stall into a
// collection — the split is skipped, not guessed.
perfRunStart(0, 0, 0, 0);
t = 0;
tick(16);
tick(200, { programs: 0, textures: 0, heap: 0 });
s = perfSummary();
check('a browser with no heap API attributes nothing to GC', s.hitchGC === 0,
  `${s.hitchGC} — falls to "none of those" instead`);

// ===========================================================================
section('Not recording');

perfStop();
const before = perfSummary().frames;
perfFrame(999999);
check('a stopped recorder ignores frames', perfSummary().frames === before,
  `${perfSummary().frames} vs ${before}`);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
