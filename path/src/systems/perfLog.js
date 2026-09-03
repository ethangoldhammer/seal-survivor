// ---------------------------------------------------------------------------
// Frame times, recorded rather than glanced at.
//
// The tuner's fps number is an average over one frame and it is useless for the
// thing it gets asked about most: hitching. A 200ms stall IS one frame — the
// readout blinks once and by the time you look it is gone, so "did that
// stutter?" comes down to trusting your thumbs, and two runs an hour apart
// cannot be compared at all.
//
// So this keeps the distribution. A histogram for the percentiles (bounded
// memory, so a twenty-minute run costs the same as a one-minute one) plus the
// worst handful of frames with the time they happened, which is the part that
// actually finds a cause — "142ms at 1:12" is a question you can go and answer,
// where "the game felt bad" is not.
//
// IT MUST BE FED THE UNCLAMPED DELTA. The game loop's own `rawDt` is
// `Math.min(elapsed, 0.05)`, because a tab returning from the background must
// not teleport the simulation through half a second of physics. That clamp is
// right for gameplay and fatal here: every frame worse than 50ms would record
// as exactly 50ms, which is to say every hitch this exists to catch would be
// flattened into the same value and the worst-frame column would read 50.0 all
// the way down. perfFrame takes the timestamp and does its own subtraction.
// ---------------------------------------------------------------------------

// 1ms buckets to 120ms, then everything above in the last one. Anything past
// 120ms is already a disaster and its exact size doesn't change what you do
// about it — the worst-frames list below carries the real number anyway.
const BUCKETS = 121;
const OVERFLOW = BUCKETS - 1;

// What counts as a hitch. 33ms is a dropped frame at 60Hz — the point at which
// motion visibly steps rather than moves.
const HITCH_MS = 33;
// And the one worth going to look at: a third of a second is long enough to be
// felt as the game stopping.
const SPIKE_MS = 100;

const WORST_KEPT = 8;

// The rolling window behind the live readout, as a ring of raw frame times.
// Two seconds at 60fps — long enough that the worst frame doesn't vanish
// before you can read it, short enough that it clears after you fix something.
const WINDOW = 120;

const histogram = new Uint32Array(BUCKETS);
const recent = new Float32Array(WINDOW);
let recentAt = 0;
let recentFilled = 0;

let frames = 0;
let totalMs = 0;
let worstMs = 0;
let hitches = 0;
let spikes = 0;
let runClock = 0; // seconds of wall time since the run started
let recording = false;
let lastStamp = 0;
// [{ ms, at, why }], worst first, capped at WORST_KEPT.
let worst = [];

// --- what a hitch WAS -------------------------------------------------------
//
// Counting hitches says the game stutters, which anybody playing it already
// knew. The useful question is which of the three one-off costs a stuttering
// frame was paying, because they have three different fixes and are otherwise
// indistinguishable after the fact:
//
//   a PROGRAM appeared   three linked a shader on this frame. A first draw the
//                        warm-up did not cover.
//   a TEXTURE appeared   three uploaded an image. Also a first draw, but the
//                        fix is different — an upload can be scheduled, a link
//                        mostly cannot.
//   NEITHER              not a first-draw cost at all: GC, a paging driver, or
//                        genuinely expensive work on that frame.
//
// three keeps both counts on renderer.info, so this is two integers a frame and
// the deltas across a hitch are the attribution.
let lastPrograms = 0;
let lastTextures = 0;
let hitchCompile = 0;
let hitchUpload = 0;
let hitchNeither = 0;
let programsAdded = 0;
let texturesAdded = 0;

// THE HIGH-WATER MARKS, which answer a different question from the two above
// and are the reason a memory kill was undiagnosable from this record.
//
// `texturesAdded` counts CREATIONS. It cannot tell a leak from a churn: a
// system that makes a texture and disposes it every second, and one that makes
// a texture every second and keeps them all, report the identical number and
// have completely different endings. The LIVE count separates them — flat
// while `added` climbs is churn, climbing with it is a leak.
//
// This matters more than it looks on iOS specifically, where the app is killed
// for memory (a JetsamEvent) and `performance.memory` does not exist, so
// heapPeakMB is 0 on every run WebKit ever files. These two are the only
// growth signal a Safari run carries at all.
let texturesPeak = 0;
let programsPeak = 0;

// --- WHICH texture, and whether anything still points at it -----------------
//
// `texturesPeak` says 970 were alive at once and stops there, which is the same
// gap `programsAdded` had before the cache key closed it: a number that names a
// problem without naming its owner. A phone run climbs 352 -> 970 across four
// minutes and nothing in the record says whose they are.
//
// three keeps no texture list — `info.memory.textures` is a bare count — so
// this walks the SCENE instead, every few seconds, and groups what it finds by
// where the image came from. Two numbers come out of that, and they answer
// different questions:
//
//   BY SOURCE      Which asset is multiplying. A texture cloned per instance
//                  shows up as one source with a rising count; a hundred
//                  distinct sources is a roster, not a leak.
//   THE ORPHANS    `live - reachable`. A texture the renderer still holds that
//                  nothing in the scene points at any more is retained by
//                  something that dropped its owner without disposing it —
//                  which is the shape of a leak rather than of churn, and is
//                  invisible to every other number here.
//
// Sampled rather than continuous, because a full scene walk is not a per-frame
// cost worth paying to answer a question about minutes. Every SAMPLE_EVERY
// seconds, and the peak of each group is what is kept.
const TEX_SAMPLE_EVERY = 5;      // seconds between scene walks
const TEX_GROUPS_KEPT = 8;       // reported, most numerous first
const TEX_KEYS_MAX = 300;        // bound on the map, like KEYS_KEPT below

const texBySource = new Map();   // source label -> most ever seen at once
let texReachablePeak = 0;
let texOrphanPeak = 0;
let texNextSample = 0;

// A readable name for where an image came from. `source.data` is the decoded
// image and carries the URL for anything fetched; a canvas texture has none, so
// it falls back to the texture's own name and then to its type — which is
// enough to tell "the seagull's albedo" from "somebody's CanvasTexture".
function texLabel(t) {
  const src = t?.source?.data;
  const url = src?.src ?? src?.currentSrc ?? null;
  if (typeof url === 'string' && url) return url.slice(url.lastIndexOf('/') + 1).slice(0, 48);
  if (t?.name) return `name:${String(t.name).slice(0, 40)}`;
  if (src && typeof src.width === 'number') return `canvas ${src.width}x${src.height}`;
  return t?.isCompressedTexture ? 'compressed (no source)' : 'no source';
}

const TEX_SLOTS = ['map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap',
  'metalnessMap', 'aoMap', 'bumpMap', 'lightMap', 'envMap', 'specularMap'];

/**
 * Walk the scene and fold this moment's textures in. Cheap enough at one call
 * every few seconds; deliberately not called per frame.
 *
 * Silent and free when the caller passes nothing, which is every Node harness:
 * there is no scene to walk there and no renderer to compare against.
 */
export function noteTextures(scene, liveCount = 0, clock = lastStamp / 1000) {
  // THE WALL CLOCK, and it has to be. The obvious argument to pass from the
  // game loop is `gameState.time`, which is the RUN clock: it stops while the
  // level-up cards are up, stops while the workbench is staging, and slows with
  // every hitstop and the kill shutter. A sampler on that clock stops sampling
  // exactly during the moments most worth a sample, and reports a tidy even
  // spread that skipped them. `lastStamp` is performance.now() as perfFrame
  // received it, so the default here is real seconds whatever the water is
  // doing — the caller can still pass one, which is what the suite does.
  if (!scene?.traverse || clock < texNextSample) return;
  texNextSample = clock + TEX_SAMPLE_EVERY;
  // Deduped by identity: one texture on four materials is one texture, and
  // counting it four times would invent a leak that is really sharing working.
  const seen = new Set();
  const here = new Map();
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const slot of TEX_SLOTS) {
        const t = m?.[slot];
        if (!t?.isTexture || seen.has(t)) continue;
        seen.add(t);
        const k = texLabel(t);
        here.set(k, (here.get(k) ?? 0) + 1);
      }
    }
  });
  for (const [k, n] of here) {
    const was = texBySource.get(k);
    if (was === undefined && texBySource.size >= TEX_KEYS_MAX) continue;
    if (was === undefined || n > was) texBySource.set(k, n);
  }
  if (seen.size > texReachablePeak) texReachablePeak = seen.size;
  const orphans = Math.max(0, liveCount - seen.size);
  if (orphans > texOrphanPeak) texOrphanPeak = orphans;
}

function topTextures() {
  return [...texBySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TEX_GROUPS_KEPT)
    .map(([source, peak]) => ({ peak, source }));
}

// --- WHICH shader, and whether it had been built before ---------------------
//
// `programsAdded` says forty programs were linked and stops there, which is the
// difference between two completely different bugs:
//
//   forty DISTINCT keys   the warm-up missed forty material configurations.
//                         Annoying, bounded, and paid once — the fortieth is
//                         the last one.
//   one key, forty times  something is releasing a program and rebuilding the
//                         identical shader. That is unbounded: it goes on for
//                         as long as the run does, and no amount of warming
//                         helps because the program WAS warm and got thrown
//                         away. This is the one worth chasing.
//
// three's own numbers cannot tell them apart. `info.programs.length` is the
// live set, so a release-and-rebuild leaves it unchanged; `programsAdded` (max
// id, see programsEverBuilt in main.js) counts both cases identically. The
// cache key is what separates them, and three hangs it on every program.
//
// Keyed by the cache key, counting builds. A key with a count above one is a
// rebuild — the same shader, linked again.
const programBuilds = new Map(); // cacheKey -> times built this run
let lastProgramId = -1;          // highest program id seen, so new ones are new
let programRebuilds = 0;         // builds of a key already built this run

// Bounded, because the map is keyed on strings three builds by concatenating
// every program parameter and they are not short. Past this the count for keys
// already in the map keeps rising — which is the number that matters, since a
// rebuild is by definition a key that has been seen — and genuinely new keys
// stop being added. A run that reaches this has already answered the question.
const KEYS_KEPT = 400;

// --- WHICH PROGRAMS THE WARM-UP MISSED --------------------------------------
//
// `programBuilds` above answers "was the same shader linked twice", which is a
// warm-up being THROWN AWAY and is a different bug with a different fix. The
// question it cannot answer is the common one: a run reports 345 programs built
// after boot, every one of them linked ONCE, and the report names none of them
// because `topPrograms` only lists keys with a count above one. Three hundred
// mid-run links, and nothing saying what they were.
//
// So the keys are credited to the FRAMES THEY LANDED ON. A program linked on a
// 16ms frame cost nothing anybody felt and warming it buys nothing; the same
// program linked on a 600ms frame is the worst frame of the run. Ranking by the
// time of the frames a key appeared on puts the warm-up's work list in order,
// which "345 programs" never could.
//
// Two maps rather than one, because a key can be both: linked once on a hitch
// (a warm-up miss) and linked again later (a rebuild). They are separate
// diagnoses and merging them loses which is which.
const hitchPrograms = new Map(); // cacheKey -> { builds, ms } over hitch frames
// Reused, so the common case — a frame that built nothing — allocates nothing.
const frameNewKeys = [];

/**
 * Fold this frame's program list in. Takes three's live array
 * (`renderer.info.programs`), and picks out the ones built since the last call
 * by id — ids come from a counter that only goes up, so anything above the
 * high-water mark is new.
 *
 * Silent and free when the caller passes nothing, which is every Node harness:
 * there is no GL context there and so no programs to read.
 */
function notePrograms(list) {
  frameNewKeys.length = 0;
  if (!list?.length) return;
  let highest = lastProgramId;
  for (const p of list) {
    if (p.id <= lastProgramId) continue;
    if (p.id > highest) highest = p.id;
    const key = p.cacheKey ?? '(no key)';
    // Every new key this frame, whatever its build count — the hitch
    // classifier below decides whether this frame is worth crediting it to.
    frameNewKeys.push(key);
    const seen = programBuilds.get(key);
    if (seen !== undefined) {
      programBuilds.set(key, seen + 1);
      programRebuilds++;
    } else if (programBuilds.size < KEYS_KEPT) {
      programBuilds.set(key, 1);
    }
  }
  lastProgramId = highest;
}

// The fourth answer, and the one the other three were hiding: the JS heap.
// A collection is the only thing that makes used heap go DOWN, so a stall on a
// frame where it dropped is the collector and a stall where it didn't is real
// work on that frame. Without this, both land in "neither" and look identical.
// Chrome only; 0 means the browser doesn't expose it and the split is skipped.
let lastHeap = 0;
let hitchGC = 0;
let heapFreed = 0;   // total bytes reclaimed across the run
let heapPeak = 0;

// --- WHAT THE FRAME WAS DOING ----------------------------------------------
//
// The three counters above answer "what one-off cost did this frame pay", and
// for four runs in five the answer is "none of them" — which is true, useless,
// and where the investigation has stopped every time. A frame that linked no
// shader, uploaded no texture and collected no garbage was simply BUSY, and
// nothing recorded says with what.
//
// Two things are needed to say it, and they are different questions:
//
//   a PHASE   how long a named span of the frame took. Mechanical, always on,
//             and it splits the one number everybody argues about (25ms) into
//             the four that decide what to do (enemies 1ms, combat 0.4ms,
//             particles 2ms, render 20ms -> stop optimising the simulation).
//   a MARK    what the game was DOING. A boss arriving, cards on screen, a
//             wave landing. Phases say where the time went inside the frame;
//             marks say which moments of a run the bad frames cluster in, and
//             no amount of phase timing can answer that.
//
// THE MARK RATE IS THE POINT, NOT THE COUNT. A mark that is hot for half the
// run collects half the hitches by doing nothing at all, so a raw tally
// re-discovers how common the mark is and calls it a cause. What identifies a
// culprit is hitches-per-frame WHILE HOT against the run's own baseline: a
// mark hot for 2% of frames and holding 30% of the hitches is a 15x lift and
// that is the number worth acting on.
//
// A mark LINGERS. The cost of a boss arriving does not all land on the frame
// that spawned it — the first draw is one frame later, the textures another —
// so a mark set once stays hot for a beat afterwards and catches the stall it
// caused rather than only the frame that announced it.
const MARK_LINGER = 0.4; // seconds a mark stays hot after it is set

const markIndex = new Map(); // name -> slot
const markName = [];
const markHotUntil = [];  // runClock at which this mark goes cold
const markFrames = [];    // frames recorded while hot
const markHitches = [];   // of those, frames over HITCH_MS
const markHits = [];      // times perfMark was called

// Phases, in the order they were first named. Flat, not a stack: a phase
// opened inside another double-counts, which is visible in the report (the
// parts sum to more than the frame) rather than silently wrong.
// The WHOLE frame's JS, recorded apart from the leaf phases above rather than
// as one of them — it contains them, and a total sitting in the same list as
// its own parts makes every share in the report add up to nonsense.
//
// It exists to split the one number the leaf phases cannot: a frame is
// stamp-to-stamp, so whatever the parts do not account for is EITHER untimed
// JS in a system nothing wraps OR the tab not running at all — waiting on
// vsync, or blocked in the driver on a GPU that is behind. Those are opposite
// diagnoses with opposite fixes, and against the leaf phases alone they look
// identical. With this, `frameMs - js` is the time the loop was not executing
// and `js - sum(leaves)` is the code nothing measures yet.
let jsFrameMs = 0;
let jsTotalMs = 0;
let jsHitchMs = 0;

const phaseIndex = new Map();
const phaseName = [];
const phaseFrameMs = [];  // this frame's accumulation, zeroed every frame
const phaseTotalMs = [];  // across the run
const phaseHitchMs = [];  // across hitch frames only

/**
 * Name what the game is doing. Cheap enough to call every frame from a system
 * that is merely ACTIVE (`perfMark('cards')` while the level-up screen is up)
 * as well as once from a system that just DID something
 * (`perfMark('boss-arrive')`), and the linger above is what makes those two
 * usages behave the same way.
 *
 * Silent before a run starts, so a mark fired by the menu costs nothing and
 * lands nowhere.
 */
export function perfMark(name) {
  if (!recording) return;
  let i = markIndex.get(name);
  if (i === undefined) {
    i = markName.length;
    markIndex.set(name, i);
    markName.push(name);
    markHotUntil.push(0);
    markFrames.push(0);
    markHitches.push(0);
    markHits.push(0);
  }
  markHotUntil[i] = runClock + MARK_LINGER;
  markHits[i]++;
}

/**
 * Add `ms` to a named span of THIS frame. The caller keeps its own start
 * stamp, which is what makes this nest-safe and free of any open/close state
 * that a thrown exception could leave dangling:
 *
 *   const t0 = performance.now();
 *   updateEnemies(...);
 *   perfPhase('enemies', performance.now() - t0);
 */
export function perfPhase(name, ms) {
  if (!recording) return;
  let i = phaseIndex.get(name);
  if (i === undefined) {
    i = phaseName.length;
    phaseIndex.set(name, i);
    phaseName.push(name);
    phaseFrameMs.push(0);
    phaseTotalMs.push(0);
    phaseHitchMs.push(0);
  }
  phaseFrameMs[i] += ms;
}

/**
 * The whole of this frame's JS, from the top of the game loop to the bottom.
 * One call a frame, and it must WRAP every leaf phase rather than sit beside
 * them — see the note above jsFrameMs for the split it exists to make.
 */
export function perfFrameJs(ms) {
  if (!recording) return;
  jsFrameMs += ms;
}

/** The marks hot right now, for the worst-frames list. */
function hotMarks() {
  const out = [];
  for (let i = 0; i < markName.length; i++) {
    if (markHotUntil[i] > runClock) out.push(markName[i]);
  }
  return out;
}

/** This frame's phase split, biggest first, for the worst-frames list. */
function frameSplit() {
  const out = [];
  for (let i = 0; i < phaseName.length; i++) {
    if (phaseFrameMs[i] >= 1) out.push({ name: phaseName[i], ms: phaseFrameMs[i] });
  }
  out.sort((a, b) => b.ms - a.ms);
  return out.slice(0, 4);
}

/**
 * Fold this frame's phases and marks into the run, then clear the per-frame
 * accumulators. Called from perfFrame once the frame's duration and hitch
 * status are known, because both aggregations need them.
 */
function noteFrameContext(ms, isHitch) {
  jsTotalMs += jsFrameMs;
  if (isHitch) jsHitchMs += jsFrameMs;
  jsFrameMs = 0;
  for (let i = 0; i < phaseName.length; i++) {
    phaseTotalMs[i] += phaseFrameMs[i];
    if (isHitch) phaseHitchMs[i] += phaseFrameMs[i];
    phaseFrameMs[i] = 0;
  }
  for (let i = 0; i < markName.length; i++) {
    if (markHotUntil[i] <= runClock) continue;
    markFrames[i]++;
    if (isHitch) markHitches[i]++;
  }
}

/** Zero everything the marks and phases hold. */
function resetContext() {
  jsFrameMs = 0;
  jsTotalMs = 0;
  jsHitchMs = 0;
  markIndex.clear();
  markName.length = 0;
  markHotUntil.length = 0;
  markFrames.length = 0;
  markHitches.length = 0;
  markHits.length = 0;
  phaseIndex.clear();
  phaseName.length = 0;
  phaseFrameMs.length = 0;
  phaseTotalMs.length = 0;
  phaseHitchMs.length = 0;
}

/**
 * Begin recording. Called when a run starts, not at boot — boot is a loading
 * screen and a shader warm-up, and folding those into a run's distribution
 * would put a 3000ms frame at the top of every report forever.
 */
export function perfRunStart(stamp = performance.now(), programs = 0, textures = 0, heap = 0, programList = null) {
  histogram.fill(0);
  recent.fill(0);
  recentAt = 0;
  recentFilled = 0;
  frames = 0;
  totalMs = 0;
  worstMs = 0;
  hitches = 0;
  spikes = 0;
  runClock = 0;
  worst = [];
  lastStamp = stamp;
  lastPrograms = programs;
  lastTextures = textures;
  hitchCompile = 0;
  hitchUpload = 0;
  hitchNeither = 0;
  programsAdded = 0;
  texturesAdded = 0;
  texturesPeak = textures;
  texBySource.clear();
  texReachablePeak = 0;
  texOrphanPeak = 0;
  texNextSample = 0;
  programsPeak = programs;
  // Seeded from the live set rather than from -1: everything the warm-up built
  // is already there, and counting it as "built during the run" would put the
  // whole boot compile at the top of every report. Same reasoning as the
  // `programs` seed above.
  programBuilds.clear();
  programRebuilds = 0;
  hitchPrograms.clear();
  frameNewKeys.length = 0;
  lastProgramId = -1;
  for (const p of programList ?? []) if (p.id > lastProgramId) lastProgramId = p.id;
  lastHeap = heap;
  hitchGC = 0;
  heapFreed = 0;
  heapPeak = heap;
  resetContext();
  recording = true;
}

export function perfStop() {
  recording = false;
}

/**
 * One frame. Takes the rAF timestamp and does its own subtraction — see the
 * note at the top about why it cannot take the loop's dt.
 */
export function perfFrame(stamp, programs = lastPrograms, textures = lastTextures, heap = lastHeap, programList = null) {
  if (!recording) return;
  const ms = stamp - lastStamp;
  lastStamp = stamp;

  // Before the early return below, deliberately. A program built on the frame a
  // backgrounded tab came back is still a program that got built, and dropping
  // it would leave the rebuild count quietly short by however many times the
  // player alt-tabbed.
  notePrograms(programList);

  // Deltas first, and consumed whether or not this frame turns out to be a
  // hitch — otherwise a compile on a fast frame would still be sitting in the
  // delta when the next slow frame came along, and get blamed for it.
  const newPrograms = Math.max(0, programs - lastPrograms);
  const newTextures = Math.max(0, textures - lastTextures);
  lastPrograms = programs;
  lastTextures = textures;
  programsAdded += newPrograms;
  texturesAdded += newTextures;
  // The LEVEL, not the delta — see the note above texturesPeak.
  if (textures > texturesPeak) texturesPeak = textures;
  if (programs > programsPeak) programsPeak = programs;

  // Only a collection returns memory. Anything above the noise floor is one —
  // a megabyte, so a shrinking retained set doesn't read as a collection.
  const collected = heap > 0 && lastHeap - heap > 1048576;
  if (collected) heapFreed += lastHeap - heap;
  if (heap > heapPeak) heapPeak = heap;
  lastHeap = heap;

  // The first frame of a run measures from perfRunStart to here, which spans
  // the menu teardown and every reset in startGame — real work, but not a
  // frame anybody rendered. Same for a tab that was in the background: the gap
  // is the time it spent not being asked to draw at all. Neither is a hitch,
  // and both would sit at the top of the report for the rest of the run.
  if (ms <= 0 || ms > 1000) return;

  frames++;
  totalMs += ms;
  runClock += ms / 1000;

  const bucket = ms >= OVERFLOW ? OVERFLOW : (ms | 0);
  histogram[bucket]++;

  recent[recentAt] = ms;
  recentAt = (recentAt + 1) % WINDOW;
  if (recentFilled < WINDOW) recentFilled++;

  let why = '';
  if (ms >= HITCH_MS) {
    hitches++;
    // Compile wins the tie when both landed on one frame: a link is the more
    // expensive of the two by a wide margin, and a first draw usually pulls its
    // textures in on the same frame it compiles its program.
    if (newPrograms > 0) { hitchCompile++; why = 'compile'; }
    else if (newTextures > 0) { hitchUpload++; why = 'upload'; }
    // Ranked below the two first-draw costs: a compile allocates, so a frame
    // that did both is still best described by the compile.
    else if (collected) { hitchGC++; why = 'gc'; }
    else { hitchNeither++; why = 'other'; }

    // AFTER THE CHAIN, not inside it. Slipped between two `else if`s this
    // rebinds the rest of them to itself, so a frame that linked a program also
    // ran the texture branch — the four counters stopped summing to the hitch
    // count, which is exactly what tools/perf-log-test.mjs asserts.
    //
    // Credited here rather than in notePrograms because whether this frame is a
    // hitch is not known until now. Bounded by the same cap the build map uses:
    // a run that has linked four hundred distinct programs on slow frames has
    // answered the question several times over.
    if (frameNewKeys.length && hitchPrograms.size < KEYS_KEPT) {
      for (const key of frameNewKeys) {
        const seen = hitchPrograms.get(key);
        if (seen) { seen.builds++; seen.ms += ms; }
        else hitchPrograms.set(key, { builds: 1, ms });
      }
    }
  }
  if (ms >= SPIKE_MS) spikes++;

  // The split and the hot marks BEFORE noteFrameContext, which zeroes the
  // per-frame accumulators it has just folded into the run. Only computed for
  // a frame that could make the list, so the sort and the allocation are paid
  // on the rare frames that qualify rather than sixty times a second.
  const contended = worst.length < WORST_KEPT || ms > worst[worst.length - 1].ms;
  const split = contended ? frameSplit() : null;
  const marks = contended ? hotMarks() : null;

  // After the hitch decision (it needs `why`) and before the worst-frames push.
  noteFrameContext(ms, ms >= HITCH_MS);

  if (ms > worstMs) worstMs = ms;
  // Kept sorted and short, so this is a handful of comparisons on the rare
  // frames that qualify and a single one on every other.
  if (contended) {
    worst.push({ ms, at: runClock, why, split, marks });
    worst.sort((a, b) => b.ms - a.ms);
    if (worst.length > WORST_KEPT) worst.length = WORST_KEPT;
  }
}

// The pth percentile in ms, read off the histogram. Bucket resolution is 1ms,
// which is finer than the difference anyone acts on.
function percentile(p) {
  if (!frames) return 0;
  const want = p * frames;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += histogram[i];
    if (seen >= want) return i;
  }
  return OVERFLOW;
}

/** What the live readout shows: the last couple of seconds, not the run. */
export function perfWindow() {
  let hi = 0;
  let over = 0;
  for (let i = 0; i < recentFilled; i++) {
    const ms = recent[i];
    if (ms > hi) hi = ms;
    if (ms >= HITCH_MS) over++;
  }
  return { worstMs: hi, hitches: over };
}

/** The whole run so far. */
export function perfSummary() {
  return {
    frames,
    seconds: runClock,
    meanMs: frames ? totalMs / frames : 0,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    worstMs,
    hitches,
    spikes,
    // What the hitches WERE. These three sum to `hitches`.
    hitchCompile,
    hitchUpload,
    hitchGC,
    hitchNeither,
    heapFreedMB: heapFreed / 1048576,
    heapPeakMB: heapPeak / 1048576,
    // And the totals, for context: 40 programs linked across a run is a
    // warm-up that missed 40 programs, however they were distributed.
    programsAdded,
    texturesAdded,
    // ...against how many were ALIVE at once at the worst moment. Read as a
    // pair: added far above peak is churn, the two rising together is a leak.
    texturesPeak,
    // See noteTextures: which images the scene is holding, and how many the
    // renderer still has that nothing in the scene points at any more.
    texturesReachablePeak: texReachablePeak,
    texturesOrphanPeak: texOrphanPeak,
    topTextures: topTextures(),
    programsPeak,
    // And the split that says which kind of problem those programs are. See
    // the note above programBuilds: `programRebuilds` above zero is a shader
    // being thrown away and rebuilt, which no warm-up can fix.
    programRebuilds,
    programKeys: programBuilds.size,
    topPrograms: topPrograms(),
    // What to warm next, in order. See missedPrograms.
    missedPrograms: missedPrograms(),
    hitchProgramKeys: hitchPrograms.size,
    // Where the frame time went, and which moments the bad frames landed in.
    // See the note above MARK_LINGER for why `lift` is the column to read and
    // `hitches` on its own is not.
    phases: phaseSplit(),
    // The frame's JS as a whole. See jsFrameMs: with this, the time the loop
    // did not run at all is separable from the code no phase wraps yet.
    jsMsPerFrame: frames ? jsTotalMs / frames : 0,
    jsMsPerHitch: hitches ? jsHitchMs / hitches : 0,
    marks: markLift(),
    worst: worst.slice(),
  };
}

// Per-phase totals as a share of the run, plus the share of HITCH time each
// phase accounts for. The two together are the whole point: a phase at 4% of
// the run and 70% of the hitch time is a spiky phase, and a phase at 60% of
// both is simply the expensive one. They are different problems.
function phaseSplit() {
  const out = [];
  for (let i = 0; i < phaseName.length; i++) {
    out.push({
      name: phaseName[i],
      msPerFrame: frames ? phaseTotalMs[i] / frames : 0,
      shareOfRun: totalMs ? phaseTotalMs[i] / totalMs : 0,
      msPerHitch: hitches ? phaseHitchMs[i] / hitches : 0,
    });
  }
  return out.sort((a, b) => b.msPerFrame - a.msPerFrame);
}

// A mark's hitch rate against the run's own. `lift` above 1 means bad frames
// are over-represented while this mark is hot; below 1 means the mark is
// SAFER than the run average, which is just as much an answer.
//
// Marks that were never hot for enough frames to mean anything are dropped —
// one hitch in three frames is a 20x lift and complete noise.
//
// WHICH SETS THE CONTRACT FOR perfMark: call it every frame for as long as the
// thing it names is true. The linger is 0.4s, so a mark fired exactly once is
// hot for about 24 frames at 60Hz and 12 at 30Hz — under this floor either
// way, and it would silently never be reported. Fire-once is supported (the
// linger exists precisely so a one-shot still catches the stall it caused),
// but it is not enough on its own to clear the reporting bar, and a moment
// worth attributing lasts longer than one frame anyway. main.js reads all of
// its marks off game state once a frame for this reason.
const MARK_MIN_FRAMES = 30;

function markLift() {
  const baseline = frames ? hitches / frames : 0;
  const out = [];
  for (let i = 0; i < markName.length; i++) {
    if (markFrames[i] < MARK_MIN_FRAMES) continue;
    const rate = markHitches[i] / markFrames[i];
    out.push({
      name: markName[i],
      hits: markHits[i],
      frames: markFrames[i],
      hitches: markHitches[i],
      shareOfRun: frames ? markFrames[i] / frames : 0,
      lift: baseline > 0 ? rate / baseline : 0,
    });
  }
  return out.sort((a, b) => b.lift - a.lift);
}

// The keys built most often, worst first. Trimmed hard: a three cache key runs
// to hundreds of characters of parameter soup, and the part that identifies the
// shader — the material type and whatever customProgramCacheKey pinned — is at
// the front of it. The whole string in a run record would dwarf the run.
// A TRUNCATED KEY THAT HIDES THE DIFFERENCE IS WORSE THAN NO KEY. At 90 chars
// the four MeshBasicMaterial variants in a phone run all rendered as the same
// string — `basic,highp,srgb-linear,false,,false,false,…` — and reading that
// report produced a confident diagnosis of ONE program relinking eight times
// when it was four distinct programs relinking nineteen times between them.
// three concatenates the cheap flags first and the distinguishing ones later,
// so the prefix is exactly the part that does not identify anything.
//
// `programRebuilds` was right throughout: it counts on the FULL key, before
// this slice. Only the human-readable list was lying.
const KEY_CHARS = 220;
const TOP_KEPT = 6;

// The warm-up's work list: keys that linked on a frame the player felt, worst
// first. Ranked on the TIME of those frames rather than on the count, because
// one link on a 600ms frame is the thing to fix and forty on 34ms frames are
// not. A run whose warm-up covered everything prints nothing here.
function missedPrograms() {
  return [...hitchPrograms.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, TOP_KEPT)
    .map(([key, v]) => ({ builds: v.builds, ms: v.ms, key: key.slice(0, KEY_CHARS) }));
}

function topPrograms() {
  return [...programBuilds.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_KEPT)
    .map(([key, builds]) => ({ builds, key: key.slice(0, KEY_CHARS) }));
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Print the run. Called once when a run ends, so two runs can be compared by
 * reading two blocks rather than by remembering how the first one felt.
 *
 * `extra` is whatever the caller wants on the context line — draws and
 * megapixels, in practice, because a report without them cannot tell a run
 * that was slow from a window that was large.
 */
export function perfRunReport(label = 'run', extra = '') {
  const s = perfSummary();
  if (!s.frames) return s;

  const fps = s.meanMs ? 1000 / s.meanMs : 0;
  const lines = [
    `[perf] ${label} — ${clock(s.seconds)}, ${s.frames.toLocaleString()} frames, ${fps.toFixed(1)} fps mean${extra ? ` · ${extra}` : ''}`,
    `       median ${s.medianMs}ms · p95 ${s.p95Ms}ms · p99 ${s.p99Ms}ms · worst ${s.worstMs.toFixed(0)}ms`,
    `       hitches (>${HITCH_MS}ms): ${s.hitches}  ·  spikes (>${SPIKE_MS}ms): ${s.spikes}`,
    `       of those: ${s.hitchCompile} shader link · ${s.hitchUpload} texture upload · ${s.hitchGC} collection · ${s.hitchNeither} none of those`,
    `       built this run: ${s.programsAdded} programs (${s.programKeys} distinct, ${s.programRebuilds} rebuilt), ${s.texturesAdded} textures`
    + `\n       alive at peak: ${s.programsPeak} programs, ${s.texturesPeak} textures`
    + (s.texturesReachablePeak
      ? ` (${s.texturesReachablePeak} reachable from the scene`
        + `${s.texturesOrphanPeak ? `, ${s.texturesOrphanPeak} held by nothing` : ''})`
      : '')
      + (s.heapPeakMB > 0 ? `  ·  heap peak ${s.heapPeakMB.toFixed(0)}MB, ${s.heapFreedMB.toFixed(0)}MB collected` : ''),
  ];
  // Only when something actually rebuilt. A clean run should print nothing
  // here, so the block appearing at all is the signal.
  if (s.topTextures?.length) {
    console.log('       textures, by where the image came from:');
    for (const t of s.topTextures) console.log(`         x${String(t.peak).padStart(3)}  ${t.source}`);
  }
  for (const p of s.topPrograms) {
    lines.push(`       rebuilt ${p.builds}x: ${p.key}`);
  }
  // The warm-up's work list. Printed after the rebuilds because a rebuild is
  // the worse of the two findings — no warm-up can fix a program that is being
  // released and relinked — and printed at all only when a link actually landed
  // on a frame somebody felt.
  if (s.missedPrograms.length) {
    lines.push(`       linked ON A HITCH — the warm-up missed these `
      + `(${s.hitchProgramKeys} distinct, worst first):`);
    for (const p of s.missedPrograms) {
      lines.push(`         ${p.ms.toFixed(0)}ms over ${p.builds} frame(s): ${p.key}`);
    }
  }
  // The frame's own breakdown. Prints whenever anything was timed, because a
  // phase table with `render` at 80% is the answer to "should I optimise the
  // simulation" and that question gets asked on every run, not only bad ones.
  if (s.phases.length) {
    const leaf = s.phases.reduce((a, p) => a + p.msPerFrame, 0);
    lines.push(`       per frame: ${s.phases.map((p) => `${p.name} ${p.msPerFrame.toFixed(2)}ms`).join(' · ')}`
      + (s.jsMsPerFrame ? ` · untimed JS ${Math.max(0, s.jsMsPerFrame - leaf).toFixed(2)}ms`
        + ` · not running ${Math.max(0, s.meanMs - s.jsMsPerFrame).toFixed(2)}ms` : ''));
    if (s.hitches) {
      const leafH = s.phases.reduce((a, p) => a + p.msPerHitch, 0);
      lines.push(`       per hitch: ${s.phases.map((p) => `${p.name} ${p.msPerHitch.toFixed(1)}ms`).join(' · ')}`
        + (s.jsMsPerHitch ? ` · untimed JS ${Math.max(0, s.jsMsPerHitch - leafH).toFixed(1)}ms` : ''));
    }
  }
  for (const m of s.marks) {
    // Only the marks that actually skew. A lift near 1 is a mark that happens
    // to be hot sometimes and tells you nothing, and printing all of them
    // would bury the one that does.
    if (m.lift < 1.5 && m.lift > 0.67) continue;
    lines.push(`       while "${m.name}" (${(m.shareOfRun * 100).toFixed(0)}% of frames, ${m.hits} fired):`
      + ` ${m.hitches} hitches — ${m.lift.toFixed(1)}x the run's rate`);
  }
  if (s.worst.length) {
    lines.push(`       worst frames: ${s.worst.map((w) => {
      const parts = w.split?.length ? ` [${w.split.map((p) => `${p.name} ${p.ms.toFixed(0)}`).join(' ')}]` : '';
      const tags = w.marks?.length ? ` {${w.marks.join(',')}}` : '';
      return `${w.ms.toFixed(0)}ms @ ${clock(w.at)}${w.why ? ` (${w.why})` : ''}${parts}${tags}`;
    }).join(' · ')}`);
  }
  // p99 is the number to watch across a change, not the mean: a fix that
  // removes stalls barely moves the average and halves this.
  console.log(lines.join('\n'));
  return s;
}
