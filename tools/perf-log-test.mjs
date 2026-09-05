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
  perfRunStart, perfFrame, perfSummary, perfWindow, perfStop, perfMark, perfPhase, perfFrameJs, noteTextures
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
section('Which shader, and whether it had been built before');

// The distinction the count above cannot make. Forty distinct keys is a
// warm-up gap and it ends; one key forty times is a rebuild loop and it does
// not. Both read as "40 programs" without the cache keys.
const prog = (id, key) => ({ id, cacheKey: key });

// Everything the warm-up built is already in the list when the run starts, and
// none of it may be counted against the run.
perfRunStart(0, 0, 0, 0, [prog(0, 'water'), prog(1, 'sky'), prog(2, 'seal')]);
t = 0;
const gl = (ms, list) => { t += ms; perfFrame(t, undefined, undefined, undefined, list); };

gl(16, [prog(0, 'water'), prog(1, 'sky'), prog(2, 'seal')]);
s = perfSummary();
check('the warm-up\'s programs are not the run\'s', s.programKeys === 0 && s.programRebuilds === 0,
  `${s.programKeys} keys, ${s.programRebuilds} rebuilt`);

// Four new material configurations appearing across a run: a warm-up gap.
gl(16, [prog(3, 'megalodon'), prog(4, 'crab')]);
gl(16, [prog(5, 'pearl'), prog(6, 'lantern')]);
s = perfSummary();
check('four first draws are four distinct keys', s.programKeys === 4, `${s.programKeys}`);
check('and none of them is a rebuild', s.programRebuilds === 0, `${s.programRebuilds}`);
check('so nothing is named as churn', s.topPrograms.length === 0,
  `${s.topPrograms.length} named`);

// The same shader, released and built again — new ids, key already seen.
gl(16, [prog(7, 'crab')]);
gl(16, [prog(8, 'crab')]);
gl(16, [prog(9, 'crab')]);
s = perfSummary();
check('a key built again is a rebuild', s.programRebuilds === 3, `${s.programRebuilds}`);
check('and the distinct-key count does not move', s.programKeys === 4, `${s.programKeys}`);
check('the offender is named with its count',
  s.topPrograms[0]?.key === 'crab' && s.topPrograms[0]?.builds === 4,
  `${s.topPrograms[0]?.key} x${s.topPrograms[0]?.builds}`);
check('and it is the only one named', s.topPrograms.length === 1, `${s.topPrograms.length}`);

// Ids only ever go up, and the list three hands over is the LIVE set — a
// released program is simply gone from it. Re-reading the same list on the
// next frame must not count anything twice.
const live = [prog(10, 'kelp')];
gl(16, live);
gl(16, live);
gl(16, live);
s = perfSummary();
check('re-reading the same live list counts one build', s.programKeys === 5 && s.programRebuilds === 3,
  `${s.programKeys} keys, ${s.programRebuilds} rebuilt`);

// A Node harness has no GL context and passes nothing. That must be silent
// rather than a crash or a phantom rebuild.
gl(16, null);
gl(16, []);
s = perfSummary();
check('no program list at all is harmless', s.programKeys === 5 && s.programRebuilds === 3,
  `${s.programKeys} keys, ${s.programRebuilds} rebuilt`);

// A frame long enough to be dropped as a background-tab gap still built its
// programs — the rebuild count must not be short by however often the player
// alt-tabbed.
const framesBefore = perfSummary().frames;
gl(5000, [prog(11, 'crab')]);
s = perfSummary();
check('a dropped frame still reports its build',
  s.frames === framesBefore && s.programRebuilds === 4,
  `${s.frames} frames, ${s.programRebuilds} rebuilt`);

// ---------------------------------------------------------------------------
// AND WHICH OF THEM ACTUALLY COST ANYTHING.
//
// Every check above is about REBUILDS, and a rebuild is the rarer of the two
// findings. The common one is a run that links three hundred distinct programs
// after boot — every one of them once, so `topPrograms` (which lists only keys
// built more than once) names none of them, and the report says "345 programs"
// and stops. That is the shape a real phone run came in with.
//
// So the keys are also credited to the frames they landed on, and ranked by the
// time of those frames: a link on a 16ms frame is a link nobody felt and
// warming it buys nothing, while the same link on a 600ms frame is the worst
// frame of the run. The ordering IS the warm-up's work list, and a ranking by
// count instead of by time would put the cheap one first.
perfRunStart(0, 0, 0, 0, [prog(0, 'water')]);
t = 0;
gl(16, [prog(0, 'water')]);
gl(16, [prog(1, 'cheap')]);        // linked on a frame nobody felt
gl(120, [prog(2, 'costly')]);      // linked on a stall
gl(60, [prog(3, 'middling')]);
s = perfSummary();
check('a link on a fast frame is not on the list',
  !s.missedPrograms.some((p) => p.key === 'cheap'),
  s.missedPrograms.map((p) => p.key).join(', ') || 'nothing named');
check('a link on a hitch is', s.missedPrograms.some((p) => p.key === 'costly'),
  s.missedPrograms.map((p) => p.key).join(', ') || 'nothing named');
check('and the worst frame is named first',
  s.missedPrograms[0]?.key === 'costly',
  `${s.missedPrograms[0]?.key} at ${s.missedPrograms[0]?.ms.toFixed(0)}ms`);
check('...by the TIME it cost, not by how many times it linked',
  s.missedPrograms[0]?.ms > s.missedPrograms[1]?.ms,
  `${s.missedPrograms[0]?.ms.toFixed(0)}ms vs ${s.missedPrograms[1]?.ms.toFixed(0)}ms`);
check('a rebuild loop is NOT reported as a warm-up gap',
  s.topPrograms.length === 0, `${s.topPrograms.length} named as churn`);

// The regression that broke the four counters. The credit above sits inside the
// hitch branch, and slipping it between two `else if`s rebinds the rest of the
// chain to it — so a frame that linked a program also ran the texture branch.
// It reads as an extra hitch appearing out of nowhere.
check('crediting a key did not disturb the attribution',
  s.hitchCompile + s.hitchUpload + s.hitchGC + s.hitchNeither === s.hitches,
  `${s.hitchCompile}+${s.hitchUpload}+${s.hitchGC}+${s.hitchNeither} vs ${s.hitches}`);

// A clean run — everything the warm-up was asked for, warmed — must print
// nothing. The block appearing at all is the signal, so it may not appear on a
// run with no misses.
perfRunStart(0, 0, 0, 0, [prog(0, 'water')]);
t = 0;
gl(16, [prog(0, 'water')]);
gl(120, [prog(0, 'water')]);        // a stall that linked nothing
s = perfSummary();
check('a stall that linked nothing names no programs', s.missedPrograms.length === 0,
  `${s.missedPrograms.length} named`);
check('...and a new run forgets the last run\'s misses', s.hitchProgramKeys === 0,
  `${s.hitchProgramKeys}`);

// ===========================================================================
section('Phases — where inside the frame the time went');

// The recorder is handed each frame's phases DURING that frame and folds them
// in when the next perfFrame lands, so a phase reported here belongs to the
// frame whose duration is reported alongside it.
{
  let t = 1000;
  perfRunStart(t);
  // Ten ordinary frames, then one hitch. The hitch is the only frame where
  // `render` is expensive — which is the whole thing the split has to be able
  // to say, and the thing a per-frame average alone cannot.
  for (let i = 0; i < 10; i++) {
    perfPhase('render', 4);
    perfPhase('enemies', 1);
    t += 16;
    perfFrame(t);
  }
  perfPhase('render', 180);
  perfPhase('enemies', 1);
  t += 200;
  perfFrame(t);

  s = perfSummary();
  const render = s.phases.find((p) => p.name === 'render');
  const enemies = s.phases.find((p) => p.name === 'enemies');
  check('phases are reported biggest first', s.phases[0].name === 'render',
    s.phases.map((p) => p.name).join(' > '));
  check('a phase averages over every frame',
    Math.abs(render.msPerFrame - (10 * 4 + 180) / 11) < 0.01,
    `${render.msPerFrame.toFixed(2)}ms/frame`);
  // THE COLUMN THAT DECIDES WHAT TO DO. Both phases cost the same on an
  // ordinary frame's scale; only one of them is what a hitch is made of.
  check('and separately over the HITCH frames', Math.abs(render.msPerHitch - 180) < 0.01,
    `${render.msPerHitch.toFixed(1)}ms per hitch`);
  check('a steady phase is not blamed for the hitch', Math.abs(enemies.msPerHitch - 1) < 0.01,
    `${enemies.msPerHitch.toFixed(1)}ms per hitch`);
  check('the worst frame carries its own split',
    s.worst[0].split?.[0]?.name === 'render' && Math.round(s.worst[0].split[0].ms) === 180,
    JSON.stringify(s.worst[0].split));
  // A phase must not leak across frames. If the per-frame accumulator were not
  // cleared, every frame would report the running total and the split would
  // climb through the run regardless of what happened.
  check('phase time does not leak into the next frame',
    Math.abs(enemies.msPerFrame - 1) < 0.01, `${enemies.msPerFrame.toFixed(2)}ms/frame`);
}

// ===========================================================================
section('JS total vs the leaf phases — is the loop even running?');

// The split that decides the direction of an investigation. Whatever the leaf
// phases do not account for is EITHER code nothing wraps yet OR the tab not
// executing at all, and against the leaves alone those look identical.
{
  // A frame that is 30ms long but only runs 5ms of JS is BLOCKED, not busy.
  let t = 1000;
  perfRunStart(t);
  for (let i = 0; i < 60; i++) {
    perfPhase('render', 3);
    perfFrameJs(5);
    t += 30;
    perfFrame(t);
  }
  s = perfSummary();
  check('the JS total is kept apart from the leaf phases',
    !s.phases.some((p) => p.name === 'js') && s.jsMsPerFrame === 5,
    `${s.phases.length} leaves, js ${s.jsMsPerFrame}ms`);
  check('a blocked frame shows almost all its time outside the loop',
    Math.abs((s.meanMs - s.jsMsPerFrame) - 25) < 0.01,
    `${(s.meanMs - s.jsMsPerFrame).toFixed(1)}ms not running`);
  check('and very little untimed JS',
    Math.abs((s.jsMsPerFrame - 3) - 2) < 0.01, `${(s.jsMsPerFrame - 3).toFixed(1)}ms untimed`);

  // The opposite case: a frame that really is busy, in code no phase wraps.
  t = 5000;
  perfRunStart(t);
  for (let i = 0; i < 60; i++) {
    perfPhase('render', 3);
    perfFrameJs(29);   // 29ms of JS, only 3 of it accounted for
    t += 30;
    perfFrame(t);
  }
  s = perfSummary();
  check('a busy frame shows the time as untimed JS instead',
    Math.abs(s.jsMsPerFrame - 3 - 26) < 0.01, `${(s.jsMsPerFrame - 3).toFixed(1)}ms untimed`);
  check('and almost nothing outside the loop',
    Math.abs((s.meanMs - s.jsMsPerFrame) - 1) < 0.01,
    `${(s.meanMs - s.jsMsPerFrame).toFixed(1)}ms not running`);

  // Per-hitch, which is the column that actually decides it: a run can idle on
  // its good frames and be JS-bound on its bad ones, and the average blends
  // the two into something that describes neither.
  t = 9000;
  perfRunStart(t);
  for (let i = 0; i < 40; i++) { perfPhase('render', 3); perfFrameJs(4); t += 16; perfFrame(t); }
  perfPhase('render', 4); perfFrameJs(200); t += 210; perfFrame(t);
  s = perfSummary();
  check('the hitch column is not diluted by the quiet frames',
    Math.abs(s.jsMsPerHitch - 200) < 0.01, `${s.jsMsPerHitch.toFixed(0)}ms of JS on the hitch`);

  // And it must not leak between frames, exactly as the leaf phases must not.
  t = 12000;
  perfRunStart(t);
  for (let i = 0; i < 10; i++) { perfFrameJs(5); t += 16; perfFrame(t); }
  s = perfSummary();
  check('the JS total does not accumulate across frames',
    Math.abs(s.jsMsPerFrame - 5) < 0.01, `${s.jsMsPerFrame.toFixed(2)}ms/frame`);
}

// ===========================================================================
section('Marks — which moments the bad frames land in');

// A mark that is hot for most of the run collects most of the hitches by doing
// nothing at all, so the tally is not the answer and `lift` is: the hitch rate
// while hot, against the run's own rate.
{
  let t = 1000;
  perfRunStart(t);
  // 200 quiet frames with `calm` hot throughout, then 60 frames with `storm`
  // hot of which a third stutter. `calm` holds no hitches; `storm` holds all
  // of them while being a small minority of the run.
  for (let i = 0; i < 200; i++) {
    perfMark('calm');
    t += 16;
    perfFrame(t);
  }
  for (let i = 0; i < 60; i++) {
    perfMark('storm');
    t += (i % 3 === 0) ? 50 : 16;
    perfFrame(t);
  }
  s = perfSummary();
  const storm = s.marks.find((m) => m.name === 'storm');
  const calm = s.marks.find((m) => m.name === 'calm');
  check('every hitch is inside the mark that caused it', storm.hitches === s.hitches,
    `${storm.hitches} of ${s.hitches}`);
  check('and the mark is a small share of the run', storm.shareOfRun < 0.3,
    `${(storm.shareOfRun * 100).toFixed(0)}% of frames`);
  check('so it lifts well above the run rate', storm.lift > 3,
    `${storm.lift.toFixed(1)}x`);
  check('a quiet mark reads BELOW the run rate, which is also an answer',
    calm.lift < 0.5, `${calm.lift.toFixed(2)}x`);
  check('marks are sorted worst first', s.marks[0].name === 'storm',
    s.marks.map((m) => m.name).join(' > '));

  // THE LINGER. A cost does not all land on the frame that announced it — the
  // first draw is a frame later, its textures another. A mark set once has to
  // still be hot when the stall it caused arrives.
  // Observed through the WORST-FRAME record rather than the mark table: one
  // fire is deliberately under MARK_MIN_FRAMES (see the note there), so the
  // table would not carry it — but the frame's own tag list is what a reader
  // actually looks at when they want to know what a 300ms frame was.
  perfRunStart(2000);
  let u = 2000;
  perfMark('arrive');           // fired once, on the frame the boss appears...
  for (let i = 0; i < 5; i++) { u += 16; perfFrame(u); }   // 80ms of quiet
  u += 300; perfFrame(u);       // ...and the stall lands at 0.38s, inside 0.4
  s = perfSummary();
  check('a mark set once is still hot when the stall it caused arrives',
    s.worst[0].ms === 300 && s.worst[0].marks?.includes('arrive'),
    `${s.worst[0].ms}ms tagged {${(s.worst[0].marks ?? []).join(',')}}`);

  // And it goes cold afterwards, or every mark in a run would be hot forever
  // and the tags would name the whole roster on every frame.
  perfRunStart(3000);
  let v = 3000;
  perfMark('stale');
  for (let i = 0; i < 40; i++) { v += 16; perfFrame(v); }  // 640ms — past 0.4
  v += 300; perfFrame(v);
  s = perfSummary();
  check('and cold again well after it, so a tag means something',
    !(s.worst[0].marks ?? []).includes('stale'),
    `tagged {${(s.worst[0].marks ?? []).join(',') || 'nothing'}}`);
}

// ===========================================================================
section('A new run forgets the last one');

{
  perfRunStart(1000);
  let t = 1000;
  // Set every frame, as main.js sets them and as MARK_MIN_FRAMES requires —
  // a mark fired once is hot for less than the reporting floor.
  for (let i = 0; i < 50; i++) { perfMark('ghost'); perfPhase('ghost-phase', 5); t += 16; perfFrame(t); }
  check('the first run has them', perfSummary().marks.some((m) => m.name === 'ghost'),
    perfSummary().marks.map((m) => m.name).join(',') || 'none');

  perfRunStart(5000);
  t = 5000;
  for (let i = 0; i < 50; i++) { t += 16; perfFrame(t); }
  s = perfSummary();
  // A mark or a phase carried into the next run would attribute one run's
  // stalls to another run's moments, which is worse than not recording it.
  check('a new run carries neither mark nor phase over',
    s.marks.length === 0 && s.phases.length === 0,
    `${s.marks.length} marks, ${s.phases.length} phases`);
}

// ===========================================================================
section('Not recording');

perfStop();
const before = perfSummary().frames;
perfFrame(999999);
check('a stopped recorder ignores frames', perfSummary().frames === before,
  `${perfSummary().frames} vs ${before}`);

// Marks fire from the menu and the loading screen too. Before a run starts
// they must cost nothing and land nowhere, or the first run of a session
// inherits whatever the menu was doing.
const marksBefore = perfSummary().marks.length;
perfMark('menu');
perfPhase('menu-phase', 10);
perfFrameJs(999);
check('and ignores marks and phases', perfSummary().marks.length === marksBefore,
  `${perfSummary().marks.length} vs ${marksBefore}`);

section('WHOSE TEXTURES — the census, and the orphan gap');
{
  // A scene with three images: one shared by two materials, one on its own,
  // and one canvas texture with no URL at all. Deduped by identity, so the
  // shared one is ONE texture and not two — counting it twice would invent a
  // leak out of sharing working correctly.
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const tex = (label) => {
    const t = new THREE.Texture();
    t.source = { data: { src: `/models/${label}` } };
    return t;
  };
  const shared = tex('seagull_albedo.png');
  const solo = tex('crab_albedo.png');
  // A real canvas-shaped source, so the labeller's kind-detection is exercised
  // rather than its fallback: `getContext` is what tells a 2D canvas from an
  // ImageBitmap decoded out of a GLB, and conflating those two sent the first
  // reading of this census after five innocent call sites.
  const canvas = new THREE.Texture();
  canvas.source = { data: { width: 64, height: 64, getContext: () => null } };

  const mesh = (map) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    m.material.map = map;
    return m;
  };
  scene.add(mesh(shared), mesh(shared), mesh(solo), mesh(canvas));

  perfRunStart(0, 0, 0, 0);
  // liveCount deliberately above what the scene holds: three reachable here,
  // ten alive in the renderer, so seven are held by something that dropped its
  // owner without disposing them.
  noteTextures(scene, 10, 0);
  const t = perfSummary();

  check('the census reads the scene', t.texturesReachablePeak === 3,
    `${t.texturesReachablePeak} reachable`);
  check('...and a texture on two materials is counted once',
    (t.topTextures.find((x) => x.source === 'seagull_albedo.png') ?? {}).peak === 1,
    JSON.stringify(t.topTextures.map((x) => `${x.source} x${x.peak}`)));
  check('...naming each by the file its image came from',
    t.topTextures.some((x) => x.source === 'crab_albedo.png'),
    JSON.stringify(t.topTextures.map((x) => x.source)));
  check('...and a canvas texture by its kind and size, since it has no file',
    t.topTextures.some((x) => x.source === 'canvas 64x64'),
    JSON.stringify(t.topTextures.map((x) => x.source)));
  check('the orphan gap is what the renderer holds and the scene does not',
    t.texturesOrphanPeak === 7, `${t.texturesOrphanPeak}`);

  // THE RATE LIMIT, which is the whole reason this is affordable: a second
  // call inside the sampling window must not walk the scene again.
  scene.add(mesh(tex('never_seen.png')));
  noteTextures(scene, 10, 1);
  check('a second call inside the window does nothing',
    !perfSummary().topTextures.some((x) => x.source === 'never_seen.png'),
    'sampled, not per frame');
  noteTextures(scene, 10, 99);
  check('...and the next sample after it picks the new one up',
    perfSummary().topTextures.some((x) => x.source === 'never_seen.png'));

  // THE DISTINCTION THAT MATTERS. An ImageBitmap is what a GLB's texture
  // decodes to — width, height, no src, no 2D context — and reading it as a
  // canvas is how the first report came back naming the wrong suspect.
  const bmp = new THREE.Texture();
  class ImageBitmap { constructor() { this.width = 512; this.height = 512; } }
  bmp.source = { data: new ImageBitmap() };
  scene.add(mesh(bmp));
  noteTextures(scene, 10, 200);
  check('...and a decoded model image is NOT called a canvas',
    perfSummary().topTextures.some((x) => x.source === 'bitmap 512x512'),
    JSON.stringify(perfSummary().topTextures.map((x) => x.source)));

  // A run reset has to clear it, or one run's roster is reported against the
  // next one's — the same rule every other counter here follows.
  perfRunStart(0, 0, 0, 0);
  check('a fresh run starts with an empty census',
    perfSummary().topTextures.length === 0 && perfSummary().texturesOrphanPeak === 0);
}

// --- THE THREE PLACES THE WALK USED TO BE BLIND -----------------------------
//
// Each of these was reported as an ORPHAN before the walk learned to look —
// which is how a phone run came back saying 2 textures reachable against 345
// alive, i.e. "99% of this game's textures are leaked". They are not, and an
// instrument that says so with a straight face is worse than none: the number
// was specific, it was stable across runs, and it sent a whole afternoon after
// the wrong thing.
//
// The assertion in each case is the same: a texture bound THIS way is counted
// as reachable, and therefore does NOT show up in the orphan gap.
{
  section('WHOSE TEXTURES — the three bindings a slot list cannot see');
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const named = (n) => {
    const t = new THREE.Texture();
    t.source = { data: { src: `http://x/${n}` } };
    return t;
  };

  // 1. A MAP BOUND THROUGH AN INJECTED SHADER. Half the materials in this game
  //    are stock three materials with onBeforeCompile adding uniforms — the
  //    caustics, the goo field, the threat rings — and none of those maps is in
  //    a named slot.
  const injected = new THREE.MeshBasicMaterial();
  injected.uniforms = {
    uCaustics: { value: named('caustics.png') },
    uLayers: { value: [named('layerA.png'), named('layerB.png')] },
    uStrength: { value: 0.5 },   // not a texture, and must not throw
  };
  const lit = new THREE.Mesh(new THREE.BufferGeometry(), injected);

  // 2. A BONE TEXTURE. One per Skeleton, allocated inside the first render, and
  //    the pool holds hundreds — comfortably the biggest group in a real run.
  const skinned = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const boneTex = new THREE.Texture();
  skinned.skeleton = { boneTexture: boneTex };
  //    ...and a second mesh SHARING that skeleton, which is how a rigged animal
  //    modelled in several parts arrives. Counting per mesh would multiply the
  //    largest group by however many pieces the artist used.
  const skinnedPart = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  skinnedPart.skeleton = skinned.skeleton;

  scene.add(lit, skinned, skinnedPart);
  // 3. THE SCENE'S OWN. Not visited by traverse() at all.
  scene.background = named('sky.png');
  scene.environment = named('env.png');

  perfRunStart(0, 0, 0, 0);
  // Five distinct: caustics, layerA, layerB, the bone texture, sky, env = 6.
  noteTextures(scene, 6, 0);
  const t = perfSummary();
  const groups = t.topTextures.map((x) => `${x.source} x${x.peak}`);

  check('an injected uniform map is reachable',
    t.topTextures.some((x) => x.source === 'caustics.png'), JSON.stringify(groups));
  check('...including an array of them',
    t.topTextures.some((x) => x.source === 'layerA.png')
    && t.topTextures.some((x) => x.source === 'layerB.png'), JSON.stringify(groups));
  check('a bone texture is counted, and named as one',
    (t.topTextures.find((x) => x.source === 'bone texture') ?? {}).peak === 1,
    `two meshes share one skeleton — ${JSON.stringify(groups)}`);
  check('the scene background and environment are counted',
    t.topTextures.some((x) => x.source === 'sky.png')
    && t.topTextures.some((x) => x.source === 'env.png'), JSON.stringify(groups));
  check('all six are reachable', t.texturesReachablePeak === 6,
    `${t.texturesReachablePeak} of 6`);
  check('...so none of them is booked as a leak', t.texturesOrphanPeak === 0,
    `${t.texturesOrphanPeak} orphans, which is the bug this section exists for`);
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
