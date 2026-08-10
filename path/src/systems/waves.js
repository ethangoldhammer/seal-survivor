import { CONFIG } from '../config.js';

// The run's breathing.
//
// The spawner used to be a tap: one interval, one count budget, both a smooth
// function of difficulty and nothing else. That produces a run with no shape —
// the water is equally full at every moment, so there is never a swell to
// brace for and never a moment of quiet to notice you survived one. Pressure
// you cannot feel arriving is just a background level.
//
// This is the clock that gives it a shape. The run alternates between a SURGE
// (the assault: full roster, spawn rate swelling to a crest and falling away)
// and a CALM (the respite: little fish only, arriving slowly, carrying almost
// no chum). One number carries it — `pressure`, 0..1 — and the spawner reads
// it through waveSpawn() below.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO:
//
//   1. It never removes anything. A calm is made of the spawner going quiet,
//      not of creatures being deleted — whatever survived the surge is still
//      in the water and is the player's to clear. Despawning on a clock would
//      take a fight out from under someone mid-swing, which is the same reason
//      the nightlife gate only ever touches NEW spawns (see CONFIG.spawn).
//
//   2. It has no hard edges. Pressure ramps into a surge and ramps back out of
//      it, so the roster hands over gradually: the shoal arrives first, the
//      predators follow it in, and as the wave breaks the big things stop
//      coming while the minnows drift back. A phase flag flipped on a timer
//      would put a megalodon in the water on the same frame the calm ended.
//
//   3. It does not, on its own, make the run harder. Across one full cycle the
//      average spawn rate lands close to what the flat tap produced — see the
//      throughput note on CONFIG.spawn.waves. The pressure is redistributed,
//      not added.
//
// The clock is ticked from updateSpawning rather than from main.js's frame
// loop, on that function's own dt. That is on purpose: the wave clock and the
// spawn timer it paces then advance in lockstep and cannot drift, and anything
// that stops spawning (the level-up pause, the death dive, the score screen)
// stops the wave too — a run should not come back from a level-up card to find
// it has slept through its own respite.

export const waveState = {
  phase: 'surge', // 'surge' | 'calm'
  index: 1, // which surge this is, 1-based — for anything that wants to count
  t: 0, // seconds into the current phase
  duration: 0, // how long this phase will run for, fixed when it began
  pressure: 1, // 0..1, the only thing the spawner actually reads
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (v) => v * v * (3 - 2 * v);

// How long a phase of this kind lasts, at this point in the run.
//
// Expressed per DIFFICULTY POINT rather than per second, like the roster's own
// minDifficulty gates and the chum holdback: retuning spawn.difficultyPerSecond
// then moves the wave pacing along with everything else it paces, instead of
// leaving it stranded at a wall-clock duration the rest of the run no longer
// agrees with.
//
// Floored at 1s regardless of what the config says. A zero-length phase would
// be stepped over by the catch-up loop in updateWaves forever.
function phaseDuration(phase, difficulty) {
  const cfg = CONFIG.spawn.waves?.[phase];
  if (!cfg) return 20;
  const raw = (cfg.seconds ?? 20) + (cfg.perDifficulty ?? 0) * difficulty;
  return Math.max(cfg.min ?? 1, Math.min(cfg.max ?? Infinity, Math.max(1, raw)));
}

// The swell. Zero through a calm; through a surge it climbs across `attack`,
// holds at the crest, and falls away across `release`.
//
// Smoothstepped rather than left as the raw triangle, because a linear ramp in
// spawn rate reads as a dial being turned. The eased one reads as water
// arriving: slow to start, quick through the middle, easing off at the top.
function pressureFor(difficulty) {
  if (waveState.phase === 'calm') return 0;
  const cfg = CONFIG.spawn.waves;
  // Clamped and normalised so a config with attack + release > 1 produces a
  // shorter peak rather than a curve that crosses itself.
  let attack = Math.max(1e-3, cfg?.attack ?? 0.3);
  let release = Math.max(1e-3, cfg?.release ?? 0.25);
  const span = attack + release;
  if (span > 1) { attack /= span; release /= span; }

  const u = clamp01(waveState.t / Math.max(1e-6, waveState.duration));
  let p = 1;
  if (u < attack) p = u / attack;
  else if (u > 1 - release) p = (1 - u) / release;
  return smoothstep(clamp01(p));
}

export function resetWaves(difficulty = 0) {
  // A run opens at the bottom of a surge's attack ramp rather than in a calm:
  // the first seconds should have something in them, just not much, and the
  // ramp gives the opening a build instead of a wall of fish on frame one.
  waveState.phase = 'surge';
  waveState.index = 1;
  waveState.t = 0;
  waveState.duration = phaseDuration('surge', difficulty);
  waveState.pressure = pressureFor(difficulty);
}

export function updateWaves(dt, difficulty) {
  const cfg = CONFIG.spawn.waves;
  if (!cfg?.enabled) {
    // Switched off: one permanent surge at full pressure. Every multiplier in
    // waveSpawn() then reads 1 and the spawner behaves exactly as it did
    // before any of this existed.
    waveState.phase = 'surge';
    waveState.pressure = 1;
    return;
  }

  if (waveState.duration <= 0) resetWaves(difficulty);

  waveState.t += dt;
  // A loop rather than a single check: a long frame (a tab regaining focus, a
  // level-up card dismissed after a stall) can carry more than one phase's
  // worth of dt. Guarded so a pathological config can't hang the frame.
  let guard = 8;
  while (waveState.t >= waveState.duration && guard-- > 0) {
    waveState.t -= waveState.duration;
    if (waveState.phase === 'surge') {
      waveState.phase = 'calm';
    } else {
      waveState.phase = 'surge';
      waveState.index += 1;
    }
    waveState.duration = phaseDuration(waveState.phase, difficulty);
  }

  waveState.pressure = pressureFor(difficulty);
}

// Everything the spawner needs for this tick, as one object worked out once:
//
//   rateMul   multiplies the spawn rate — both the interval between ticks and
//             the creature budget each tick spends.
//   lull      is this a quiet stretch? True through a whole calm AND across
//             the low ends of a surge's ramps, which is what makes the roster
//             hand over gradually instead of on a frame.
//   groupMul  school sizes during a lull. Without this a single pick of a
//             schooling species would put fourteen fish in the water and undo
//             the respite in one tick — the budget is spent in creatures, but
//             a school spawns whole regardless of what is left of it.
//   xpMul     what a lull creature's chum is worth. See the note on
//             CONFIG.spawn.waves.lull for why this is not 1.
export function waveSpawn() {
  const cfg = CONFIG.spawn.waves;
  if (!cfg?.enabled) return { rateMul: 1, lull: false, groupMul: 1, xpMul: 1 };

  const p = waveState.pressure;
  const calmRate = cfg.calmRate ?? 0.3;
  const rateMul = calmRate + (( cfg.peakRate ?? 1.6) - calmRate) * p;
  const lull = p <= (cfg.lullBelow ?? 0.35);

  return {
    rateMul,
    lull,
    groupMul: lull ? (cfg.lull?.groupMul ?? 1) : 1,
    xpMul: lull ? (cfg.lull?.xpMul ?? 1) : 1,
  };
}

// Is this species one of the small fry a lull is allowed to send?
//
// Rule-based rather than a list of species names, so the roster keeps its
// promise that adding a key to CONFIG.enemies is all it takes to put a
// creature in the game. `prey` is the existing marker for "small enough that
// a shark eats it", which is exactly the set wanted here; the radius cap is a
// second gate so a future large prey animal can't quietly join the respite.
export function lullEligible(def) {
  if (!def) return false;
  if (!def.prey) return false;
  const max = CONFIG.spawn.waves?.lull?.maxRadius ?? Infinity;
  return (def.radius ?? 0) <= max;
}
