// ---------------------------------------------------------------------------
// UNLOCKS — what the player has EARNED, across every run they have ever played,
// and the one switch that decides whether earning is required at all.
//
// THE SWITCH. `GATE_DEFAULT` below is the whole public/private difference.
// On — the default now — a thing with a row in unlocks.csv is withheld until
// that row's stat reaches its count. Off, every card is dealt and every
// accessory is in the drawer, which is what a dev session asks for with
// `?gate=0`. Nothing else in the game reads the switch: it goes through
// unlockGranted(), so the two places that ask — the offer pool and the
// accessory slot — cannot disagree about what "locked" means.
//
// `?gate` on the URL turns it on for one page load and `?gate=0` turns it off,
// so a build can be checked either way without a rebuild — the same shape
// `?tune` has for the panels. A harness calls setUnlockGate().
//
// `?unlocks=reset` WIPES THE LEDGER, once, at import — before the menu builds
// the drawer, which is the only moment early enough for the reset to be what
// that drawer is built from. It does not stick: the next load with a bare URL
// keeps the fresh ledger and starts counting again. The console door
// (`svUnlocks.reset()`) does the same wipe but mid-session, when the menu has
// already been built off the old ledger — which is why it reloads the page.
//
// THE LEDGER. A flat map of stat name → count, kept in localStorage under its
// own key, well away from the tuning cache (which is a SNAPSHOT OF CONFIG and
// must never hold a player's progress — see the note on CONFIG.accessories
// .items[*].unlocked, which is the older stub this sits on top of). Every
// increment goes through recordUnlockStat, and every name that is ever
// incremented is listed in STATS so a row in the CSV can be checked against
// something. Adding a stat is a line there and a call somewhere in main.js.
//
// EARNED IS NOT YET GRANTED. Crossing a gate's count mid-run POPS it — the
// call that crossed it returns the gate's id, and that is the toast's cue —
// but the thing itself stays withheld until the run is over. The gate sits in
// `pending` until commitUnlocks() moves it to `unlocked`, which main.js does
// at the end of a run and at the start of the next; a page closed mid-run has
// its pending promoted on the next load, because the run that earned them is
// over by then too. So a hat pops on the 50th hull and is in the drawer when
// the seal is back at the menu, and Laser Eyes pops on the boss and is first
// dealt in the run after — a reward is announced now and collected at the
// door, never mid-fight.
//
// STICKY. Once in `unlocked` a gate never relocks — not when the CSV's count
// is raised later, not when the stat is renamed. A player who earned a hat
// keeps the hat; the threshold is a promise made when they crossed it. That
// set is the one thing here that is stored rather than derived from the
// counts, and that is the reason: "did this person cross the line" is a fact
// about a person and a moment, and the line can move.
//
// THE SURFACE. ui/unlockToast.js shows the pop; the requirement/celebration
// line it prints is the row's `label`. A locked accessory simply falls out of
// the drawer's roster and a locked card is simply not dealt — nothing greyed,
// nothing explained, yet. unlockProgress() hands back have/need/label for
// whatever eventually does.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { versusActive } from './versusFlag.js';
import unlocksCsv from '../unlocks.csv?raw';
import { parseUnlockCsv, buildUnlocks } from '../unlockTable.js';

// THE TOGGLE. True is the public build: a thing with a row in unlocks.csv has
// to be earned. Flipped on when the upgrade gates arrived — until then the
// table was written but nothing read it, which meant a gate could be wrong for
// months without anything noticing.
//
// A DEV SESSION TURNS IT OFF WITH `?gate=0`, one page load at a time, and that
// is deliberately the harder of the two directions now. The old default made
// every local run the unlocked game, so the gated build was the one nobody
// ever actually played.
export const GATE_DEFAULT = true;

// Every stat recordUnlockStat is ever called with. A name ending in `.` is a
// PREFIX: `boss.` is followed by an archetype id (boss.bossCrab) and `perk.` by
// a perk id (perk.eyebeam), so a row can wait on a particular boss or on a
// particular perk without this list having to know the roster.
export const STATS = [
  // --- TALLIES. recordUnlockStat adds to these; they only ever go up. -------
  'boatsDestroyed',     // any hull the player sinks, incl. the boss boats
  'trawlersDestroyed',  // the trawler subset of the above
  'bossesDefeated',     // every boss kill
  'boss.',              // + `boss.<archetype id>` — see bosses.csv
  'perk.',              // + `perk.<perk id>` — see bossPerks.csv
  'bossArchetypes',     // DISTINCT archetypes beaten — 9 is the whole roster
  'humansEaten',        // crew swallowed, the maneater counter
  'creaturesEaten',     // every creature the player kills, of any kind
  'sharksDefeated',     // the `shark` spawn group subset of the above
  'chumEaten',          // MOUTHFULS, not kills — see onChumSwallowed
  'bubblesPopped',      // ambient seabed bubbles the seal took a breath from
  'baitBallsWiped',     // balls the player emptied to the last fish
  'airTimeSeconds',     // whole seconds spent out of the water
  'levelsGained',       // levels taken across every run, summed
  'runsPlayed',         // runs that reached a death
  'gravesVisited',      // distinct gravestones read, one per stone per run
  'perfectDodges',      // committed boss runs that ended in empty water
  'upgradesMaxed',      // cards taken to their maxStacks
  'flawlessBosses',     // bosses beaten without the seal taking a hit

  // --- HIGH-WATER MARKS. recordUnlockBest keeps the largest ever seen, so
  // these answer "in one run" rather than "ever". Listed in BEST below too —
  // that list is what stops a per-run peak being quietly summed by the tally
  // path, which would turn "reached level 20" into "gained 20 levels".
  'runMinutes',         // longest single run, in whole minutes
  'levelReached',       // highest level reached in one run
  'foodChainLength',    // deepest food chain in one run
  'boostPips',          // most boost pips the meter has ever been cut into
  'maxHpAdded',         // most max health added over the run's starting pool
  'maxO2Added',         // the same for the oxygen pool
  'burstDamage',        // most damage dealt inside one 10-second window
];

// The subset of STATS that are PEAKS rather than totals. recordUnlockBest
// refuses a stat that is not here and recordUnlockStat refuses one that is:
// a stat has one meaning, and the two writers cannot disagree about it
// without the ledger becoming a number nobody can read.
export const BEST = [
  'runMinutes', 'levelReached', 'foodChainLength',
  'boostPips', 'maxHpAdded', 'maxO2Added', 'burstDamage',
];

const KEY = 'sealSurvivor.unlocks';
const VERSION = 1;

// The URL wins at import, so the very first question — the menu building the
// drawer, before any ledger read — already has the right answer.
let gated = gateFromUrl() ?? GATE_DEFAULT;
let gates = null;
let ledger = blankLedger();
let loaded = false;

function blankLedger() {
  return { stats: {}, unlocked: {}, pending: {} };
}

function rosters() {
  return {
    accessory: Object.keys(CONFIG.accessories?.items ?? {}),
    upgrade: (CONFIG.upgrades ?? []).map((u) => u.id),
  };
}

// The gate list is built on first use rather than at import: the rosters it
// validates against are CONFIG.upgrades and CONFIG.accessories.items, and a
// harness that edits either before asking should be asking about what it
// edited.
function gateList() {
  if (!gates) gates = buildUnlocks(parseUnlockCsv(unlocksCsv), rosters(), console.warn, STATS);
  return gates;
}

/** Every gate the table declares, built. Read-only to callers. */
export function unlockGates() {
  return gateList();
}

/** Throw the built list away so the next ask re-reads the table. Harnesses. */
export function rebuildUnlockGates(rows = null) {
  gates = rows ? buildUnlocks(rows, rosters(), console.warn, STATS) : null;
}

// --- the switch --------------------------------------------------------------

function gateFromUrl() {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    if (!q.has('gate')) return null;
    const v = q.get('gate');
    return !(v === '0' || v === 'false' || v === 'off');
  } catch {
    return null;
  }
}

/**
 * `?unlocks=reset` on the URL — a dev override for a ledger that is otherwise
 * permanent. It runs at import, ONCE, so the wipe lands before anything asks
 * what has been earned.
 *
 * A value is required (`?unlocks` alone does nothing) because this throws away
 * everything the player has ever earned, and a bare flag is too easy to leave
 * on the end of a URL you are pasting around.
 */
function resetFromUrl() {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    return q.get('unlocks') === 'reset';
  } catch {
    return false;
  }
}

export function unlockGateOn() {
  return gated;
}

export function setUnlockGate(on) {
  gated = !!on;
}

// --- the ledger --------------------------------------------------------------

function ensureLoaded() {
  if (!loaded) loadUnlocks();
}

/**
 * Read the ledger back. Every path lands on a fully-shaped ledger: storage
 * blocked (a private window, a sandboxed frame) is a fresh one and silent,
 * unreadable JSON is a fresh one and a warning, because that case threw away
 * something the player earned.
 *
 * Anything left pending by the last session is promoted here: the run that
 * earned it is over, whichever way it ended.
 */
export function loadUnlocks() {
  loaded = true;
  ledger = blankLedger();
  let parsed = null;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn('[unlocks] saved progress was unreadable, starting fresh —', err.message);
    }
  }
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed.stats ?? {})) {
      if (Number.isFinite(v) && v > 0) ledger.stats[k] = Math.floor(v);
    }
    for (const [k, v] of Object.entries(parsed.unlocked ?? {})) {
      if (v === true) ledger.unlocked[k] = true;
    }
    for (const [k, v] of Object.entries(parsed.pending ?? {})) {
      if (v === true) ledger.unlocked[k] = true;
    }
  }
  return ledger;
}

// THROTTLED, because the counters are no longer rare. `boatsDestroyed` fired
// a handful of times a run and a synchronous localStorage write per hull cost
// nothing; `creaturesEaten` fires on every kill, and a magnet sweep books six
// inside one frame. So an ordinary write marks the ledger dirty and schedules
// a flush, and only the calls that MATTER go straight through: a gate popping,
// and commitUnlocks collecting one. Nothing between two flushes can be lost
// that the next flush does not also carry — the ledger in memory is the truth
// and the write is a copy of all of it, not a delta.
const SAVE_DELAY = 1500;
let saveTimer = null;
let dirty = false;

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ v: VERSION, ...ledger }));
  } catch (err) {
    console.warn('[unlocks] could not save —', err?.message ?? err);
  }
}

/** Write now. For a page going away, and for a harness that wants determinism. */
export function flushUnlocks() {
  flush();
}

function save(now = false) {
  dirty = true;
  if (now) { flush(); return; }
  if (saveTimer == null) saveTimer = setTimeout(flush, SAVE_DELAY);
}

/** Forget everything earned. Dev only — nothing in the game calls this. */
export function resetUnlocks() {
  ledger = blankLedger();
  loaded = true;
  airCarry = 0;
  // The scheduled write is dropped rather than allowed to land: it holds the
  // ledger that was just thrown away, and would put it back a second later.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  dirty = false;
  try { globalThis.localStorage?.removeItem(KEY); } catch { /* storage blocked */ }
}

/** A copy of the counts, for a debug view or a harness. */
export function unlockStats() {
  ensureLoaded();
  return { ...ledger.stats };
}

/** The gates popped this run and not yet collected — what a score screen lists. */
export function pendingUnlocks() {
  ensureLoaded();
  return Object.keys(ledger.pending);
}

/**
 * Collect everything popped: pending becomes unlocked. Called by main.js at
 * the end of a run and at the start of the next, and a no-op between.
 *
 * @returns the ids that just became granted.
 */
export function commitUnlocks() {
  ensureLoaded();
  const ids = Object.keys(ledger.pending);
  if (!ids.length) return ids;
  for (const id of ids) ledger.unlocked[id] = true;
  ledger.pending = {};
  save(true);
  return ids;
}

/**
 * Count one more of `stat` (or `n` more), and POP any gate that reached its
 * count on this call — into `pending`, not `unlocked`; see the header.
 *
 * @returns the ids of the gates that just popped — empty on nearly every call,
 *   which is what the toast keys on. Recorded whether or not the gate is on:
 *   the ledger is the player's history and a dev build should be building the
 *   same history a public one would.
 */
export function recordUnlockStat(stat, n = 1) {
  // A versus match earns nothing: no unlocks, no toasts, no hive.
  if (versusActive()) return [];
  ensureLoaded();
  if (!stat || !(n > 0)) return [];
  // A peak is not a tally. Refused rather than added, because adding would be
  // silently wrong in a way nothing downstream could detect — see BEST.
  if (BEST.includes(stat)) {
    console.warn(`[unlocks] "${stat}" is a high-water mark; use recordUnlockBest.`);
    return [];
  }
  ledger.stats[stat] = (ledger.stats[stat] ?? 0) + n;
  const opened = popGates(stat);
  save(opened.length > 0);
  return opened;
}

/**
 * Set `stat` to `value` IF it is the biggest yet, and pop what that crosses.
 *
 * The other half of recordUnlockStat, for the gates that ask about one run
 * rather than about a lifetime — "reached level 20" is a fact about the best
 * run there has ever been, and summing it would make it a fact about
 * persistence instead. A call with a value at or below what is stored is a
 * no-op, so this can be called every frame with a running peak.
 *
 * @returns the ids of the gates that just popped, same as recordUnlockStat.
 */
export function recordUnlockBest(stat, value) {
  // A versus match earns nothing: no unlocks, no toasts, no hive.
  if (versusActive()) return [];
  ensureLoaded();
  if (!stat || !Number.isFinite(value)) return [];
  if (!BEST.includes(stat)) {
    console.warn(`[unlocks] "${stat}" is a tally; use recordUnlockStat.`);
    return [];
  }
  // Floored to match the ledger, which stores integers — loadUnlocks floors
  // everything on the way back in, so storing 4.9 here would silently become
  // 4 on the next page load and un-cross a gate the player had crossed.
  const v = Math.floor(value);
  if (!(v > (ledger.stats[stat] ?? 0))) return [];
  ledger.stats[stat] = v;
  const opened = popGates(stat);
  save(opened.length > 0);
  return opened;
}

// Every gate waiting on `stat` that has just been reached, moved into pending.
// Shared by the two writers so they cannot come to different conclusions about
// what a threshold means.
function popGates(stat) {
  const opened = [];
  for (const g of gateList()) {
    if (ledger.unlocked[g.id] || ledger.pending[g.id] || g.stat !== stat) continue;
    if ((ledger.stats[stat] ?? 0) >= g.count) {
      ledger.pending[g.id] = true;
      opened.push(g.id);
    }
  }
  return opened;
}

// THE EVENTS, each stating its stat names HERE rather than at the call site so
// STATS above stays the one list. main.js calls these; it never names a stat.
// A recorder returns the gate ids that popped, which is what announceUnlocks
// is handed — so a new one is a function here plus one line at the event.

/** A hull went up. `boat` is the boats.js entry; only `isTrawler` is read. */
export function recordBoatDestroyed(boat) {
  const opened = recordUnlockStat('boatsDestroyed');
  if (boat?.isTrawler) opened.push(...recordUnlockStat('trawlersDestroyed'));
  return opened;
}

/**
 * A boss died. `archetype` is its bosses.csv id, `perkId` its bossPerks.csv id
 * or null, `flawless` true when the seal took no damage during the fight.
 *
 * `bossArchetypes` is booked from the EDGE rather than counted separately: the
 * per-archetype count going 0 → 1 is exactly "a kind of boss beaten for the
 * first time", so the roster-completion gate is arithmetic on a counter that
 * already existed rather than a second thing to remember to increment.
 */
export function recordBossDefeated(archetype, perkId, flawless = false) {
  ensureLoaded();
  const first = archetype ? !(ledger.stats[`boss.${archetype}`] > 0) : false;
  const opened = recordUnlockStat('bossesDefeated');
  if (archetype) opened.push(...recordUnlockStat(`boss.${archetype}`));
  if (first) opened.push(...recordUnlockStat('bossArchetypes'));
  if (perkId) opened.push(...recordUnlockStat(`perk.${perkId}`));
  if (flawless) opened.push(...recordUnlockStat('flawlessBosses'));
  return opened;
}

/**
 * A creature died to the player. `def` is its enemies.csv row — read only for
 * its spawn groups, so the shark tally is the same question the spawner asks
 * rather than a second list of ids that would drift from it.
 *
 * The hottest recorder in the game: this runs on every kill, which is why
 * save() is throttled. See the note there before adding another.
 */
export function recordCreatureEaten(def, inSpawnGroup = null) {
  // A versus match earns nothing: no unlocks, no toasts, no hive.
  if (versusActive()) return [];
  const opened = recordUnlockStat('creaturesEaten');
  if (def && inSpawnGroup?.(def, 'shark')) opened.push(...recordUnlockStat('sharksDefeated'));
  return opened;
}

/** A crew member swallowed. See player.humansEaten, which is the run's copy. */
export function recordHumanEaten() {
  return recordUnlockStat('humansEaten');
}

/**
 * A seabed bubble taken as a breath.
 *
 * The AMBIENT bubble only — the one that seeps out of the sand and rises. The
 * beluga's trap bubbles are also breathed (see onBreath in main.js) and are
 * deliberately NOT counted here: the card those bubbles come from is the card
 * this stat gates, and a gate a thing opens for itself is not a gate.
 */
export function recordBubblePopped() {
  return recordUnlockStat('bubblesPopped');
}

/** A chum orb swallowed. MOUTHFULS — the seal eats far less than it kills. */
export function recordChumEaten() {
  return recordUnlockStat('chumEaten');
}

/** A bait ball emptied to the last fish, by the player. */
export function recordBaitBallWiped() {
  return recordUnlockStat('baitBallsWiped');
}

/** A gravestone read. The caller is responsible for once-per-stone-per-run. */
export function recordGraveVisited() {
  return recordUnlockStat('gravesVisited');
}

/** A boss's committed run ended in water the seal was not in. */
export function recordPerfectDodge() {
  return recordUnlockStat('perfectDodges');
}

/** A card just took its upgrade to its maxStacks. */
export function recordUpgradeMaxed() {
  return recordUnlockStat('upgradesMaxed');
}

/**
 * A level was taken. Both halves of the same event, and they are different
 * questions: `levelsGained` is how many have ever been taken and `levelReached`
 * is how deep one run got. A player who dies at level 5 forty times has 200 of
 * the first and 5 of the second.
 */
export function recordLevelUp(level) {
  const opened = recordUnlockStat('levelsGained');
  opened.push(...recordUnlockBest('levelReached', level));
  return opened;
}

/** A run ended. `seconds` is its length on the run clock. */
export function recordRunEnded(seconds = 0) {
  // A versus match earns nothing: no unlocks, no toasts, no hive.
  if (versusActive()) return [];
  const opened = recordUnlockStat('runsPlayed');
  opened.push(...recordUnlockBest('runMinutes', (seconds ?? 0) / 60));
  return opened;
}

/** The food chain reached `length` links. A peak, not a tally. */
export function recordFoodChain(length) {
  return recordUnlockBest('foodChainLength', length);
}

/**
 * The run's peaks, handed over as they move. Every field optional; a missing
 * one is simply not asked about. Safe to call every frame — recordUnlockBest
 * is a no-op below the stored mark.
 */
export function recordRunPeaks({ pips, hpAdded, o2Added, burst } = {}) {
  const opened = [];
  if (pips != null) opened.push(...recordUnlockBest('boostPips', pips));
  if (hpAdded != null) opened.push(...recordUnlockBest('maxHpAdded', hpAdded));
  if (o2Added != null) opened.push(...recordUnlockBest('maxO2Added', o2Added));
  if (burst != null) opened.push(...recordUnlockBest('burstDamage', burst));
  return opened;
}

// WHOLE SECONDS ONLY, with the remainder carried. The ledger stores integers
// (loadUnlocks floors on the way in), so booking 0.016 of a second per frame
// would round to nothing forever and the gate would never open no matter how
// long the seal spent in the air. The carry lives here rather than at the call
// site because it is a fact about how this stat is stored.
let airCarry = 0;

/** `seconds` more spent out of the water. Called with a frame's dt. */
export function recordAirTime(seconds) {
  if (!(seconds > 0)) return [];
  airCarry += seconds;
  const whole = Math.floor(airCarry);
  if (whole < 1) return [];
  airCarry -= whole;
  return recordUnlockStat('airTimeSeconds', whole);
}

// --- the question ------------------------------------------------------------

function gateFor(kind, target) {
  return gateList().find((g) => g.kind === kind && g.target === target) ?? null;
}

/**
 * May this be offered? THE one rule, asked by the offer pool and the accessory
 * slot. True when the gate is off, when nothing gates the target, or when the
 * target's gate has been COLLECTED — a gate popped this run is still a no.
 */
export function unlockGranted(kind, target) {
  if (!gated) return true;
  const g = gateFor(kind, target);
  if (!g) return true;
  ensureLoaded();
  return ledger.unlocked[g.id] === true;
}

/**
 * Where the player stands against one gate, for whatever shows it.
 *
 * @returns null when no gate has that id; otherwise `{ id, kind, target,
 *   label, have, need, popped, done }`. `popped` is "earned this run, not yet
 *   collected"; `done` is collected — the same answer unlockGranted gives with
 *   the gate ON. Neither reads the switch, because a screen showing progress
 *   toward a hat in a dev build should show the real progress.
 */
export function unlockProgress(gateId) {
  const g = gateList().find((x) => x.id === gateId);
  if (!g) return null;
  ensureLoaded();
  return {
    id: g.id, kind: g.kind, target: g.target, label: g.label,
    have: ledger.stats[g.stat] ?? 0, need: g.count,
    popped: ledger.pending[g.id] === true,
    done: ledger.unlocked[g.id] === true,
  };
}

// RUN LAST, not beside resetFromUrl above. resetUnlocks() clears `airCarry`,
// which is a `let` declared two thirds of the way down this file — calling it
// from up there is inside that binding's temporal dead zone and throws a
// ReferenceError at import, in the browser only, on the one URL nobody runs in
// a harness. At the bottom every declaration this touches already exists.
if (resetFromUrl()) {
  resetUnlocks();
  console.warn('[unlocks] ?unlocks=reset — the ledger was wiped. Remove the param to keep counting.');
}
