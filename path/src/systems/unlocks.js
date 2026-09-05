// ---------------------------------------------------------------------------
// UNLOCKS — what the player has EARNED, across every run they have ever played,
// and the one switch that decides whether earning is required at all.
//
// THE SWITCH. `GATE_DEFAULT` below is the whole public/private difference.
// Off, every card is dealt and every accessory is in the drawer, which is the
// game as it has always been and the game every dev session wants. On, a thing
// with a row in unlocks.csv is withheld until that row's stat reaches its
// count. Nothing else in the game reads the switch: it goes through
// unlockGranted(), so the two places that ask — the offer pool and the
// accessory slot — cannot disagree about what "locked" means.
//
// `?gate` on the URL turns it on for one page load and `?gate=0` turns it off,
// so a build can be checked either way without a rebuild — the same shape
// `?tune` has for the panels. A harness calls setUnlockGate().
//
// THE LEDGER. A flat map of stat name → count, kept in localStorage under its
// own key, well away from the tuning cache (which is a SNAPSHOT OF CONFIG and
// must never hold a player's progress — see the note on CONFIG.accessories
// .items[*].unlocked, which is the older stub this sits on top of). Every
// increment goes through recordUnlockStat, and every name that is ever
// incremented is listed in STATS so a row in the CSV can be checked against
// something. Adding a stat is a line there and a call somewhere in main.js.
//
// STICKY. The moment a gate's count is reached its id is written to the
// ledger's `unlocked` set and it never relocks — not when the CSV's count is
// raised later, not when the stat is renamed. A player who earned a hat keeps
// the hat; the threshold is a promise made when they crossed it. The set is
// the only thing here that is stored rather than derived, and that is the
// reason: "did this person cross the line" is a fact about a person and a
// moment, and the line can move.
//
// WHAT IS NOT HERE, yet: any surface. A locked accessory simply falls out of
// the drawer's roster and a locked card is simply not dealt. The label in the
// CSV is the requirement line for whatever eventually shows them —
// unlockProgress() hands back `have / need / label` for it — and
// recordUnlockStat returns the gates a call just opened, which is what an
// unlock toast will want. Neither exists today.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import unlocksCsv from '../unlocks.csv?raw';
import { parseUnlockCsv, buildUnlocks } from '../unlockTable.js';

// THE TOGGLE. False is the private build: everything unlocked. Flip to true
// for the public build.
export const GATE_DEFAULT = false;

// Every stat recordUnlockStat is ever called with. A name ending in `.` is a
// PREFIX: `boss.` is followed by an archetype id (boss.bossCrab) and `perk.` by
// a perk id (perk.eyebeam), so a row can wait on a particular boss or on a
// particular perk without this list having to know the roster.
export const STATS = [
  'boatsDestroyed',     // any hull the player sinks, incl. the boss boats
  'trawlersDestroyed',  // the trawler subset of the above
  'bossesDefeated',     // every boss kill
  'boss.',              // + `boss.<archetype id>` — see bosses.csv
  'perk.',              // + `perk.<perk id>` — see bossPerks.csv
];

const KEY = 'sealSurvivor.unlocks';
const VERSION = 1;

let gated = GATE_DEFAULT;
let gates = null;
let ledger = blankLedger();
let loaded = false;

function blankLedger() {
  return { stats: {}, unlocked: {} };
}

// The gate list is built on first use rather than at import: the rosters it
// validates against are CONFIG.upgrades and CONFIG.accessories.items, and a
// harness that edits either before asking should be asking about what it
// edited.
function gateList() {
  if (!gates) {
    gates = buildUnlocks(parseUnlockCsv(unlocksCsv), {
      accessory: Object.keys(CONFIG.accessories?.items ?? {}),
      upgrade: (CONFIG.upgrades ?? []).map((u) => u.id),
    }, console.warn, STATS);
  }
  return gates;
}

/** Every gate the table declares, built. Read-only to callers. */
export function unlockGates() {
  return gateList();
}

/** Throw the built list away so the next ask re-reads the table. Harnesses. */
export function rebuildUnlockGates(rows = null) {
  gates = rows
    ? buildUnlocks(rows, {
      accessory: Object.keys(CONFIG.accessories?.items ?? {}),
      upgrade: (CONFIG.upgrades ?? []).map((u) => u.id),
    }, console.warn, STATS)
    : null;
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
  }
  const url = gateFromUrl();
  if (url != null) gated = url;
  return ledger;
}

function save() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ v: VERSION, ...ledger }));
  } catch (err) {
    console.warn('[unlocks] could not save —', err?.message ?? err);
  }
}

/** Forget everything earned. Dev only — nothing in the game calls this. */
export function resetUnlocks() {
  ledger = blankLedger();
  loaded = true;
  try { globalThis.localStorage?.removeItem(KEY); } catch { /* storage blocked */ }
}

/** A copy of the counts, for a debug view or a harness. */
export function unlockStats() {
  ensureLoaded();
  return { ...ledger.stats };
}

/**
 * Count one more of `stat` (or `n` more), and open any gate that reached its
 * count on this call.
 *
 * @returns the ids of the gates that JUST opened — empty on nearly every call,
 *   which is what a toast should key on. Recorded whether or not the gate is
 *   on: the ledger is the player's history and a dev build should be building
 *   the same history a public one would.
 */
export function recordUnlockStat(stat, n = 1) {
  ensureLoaded();
  if (!stat || !(n > 0)) return [];
  ledger.stats[stat] = (ledger.stats[stat] ?? 0) + n;
  const opened = [];
  for (const g of gateList()) {
    if (ledger.unlocked[g.id] || g.stat !== stat) continue;
    if (ledger.stats[stat] >= g.count) {
      ledger.unlocked[g.id] = true;
      opened.push(g.id);
    }
  }
  save();
  return opened;
}

// The two events the example gates wait on, each stating its stat names here
// rather than at the call site so STATS above stays the one list.

/** A hull went up. `boat` is the boats.js entry; only `isTrawler` is read. */
export function recordBoatDestroyed(boat) {
  const opened = recordUnlockStat('boatsDestroyed');
  if (boat?.isTrawler) opened.push(...recordUnlockStat('trawlersDestroyed'));
  return opened;
}

/** A boss died. `archetype` is its bosses.csv id, `perkId` its bossPerks.csv id or null. */
export function recordBossDefeated(archetype, perkId) {
  const opened = recordUnlockStat('bossesDefeated');
  if (archetype) opened.push(...recordUnlockStat(`boss.${archetype}`));
  if (perkId) opened.push(...recordUnlockStat(`perk.${perkId}`));
  return opened;
}

// --- the question ------------------------------------------------------------

function gateFor(kind, target) {
  return gateList().find((g) => g.kind === kind && g.target === target) ?? null;
}

/**
 * May this be offered? THE one rule, asked by the offer pool and the accessory
 * slot. True when the gate is off, when nothing gates the target, or when the
 * target's gate has been earned.
 */
export function unlockGranted(kind, target) {
  if (!gated) return true;
  const g = gateFor(kind, target);
  if (!g) return true;
  ensureLoaded();
  return ledger.unlocked[g.id] === true || (ledger.stats[g.stat] ?? 0) >= g.count;
}

/**
 * Where the player stands against one gate, for whatever shows it.
 *
 * @returns null when no gate has that id; otherwise `{ id, kind, target,
 *   label, have, need, done }`. `done` is the same answer unlockGranted gives
 *   with the gate ON — it does not read the switch, because a screen showing
 *   progress toward a hat in a dev build should show the real progress.
 */
export function unlockProgress(gateId) {
  const g = gateList().find((x) => x.id === gateId);
  if (!g) return null;
  ensureLoaded();
  const have = ledger.stats[g.stat] ?? 0;
  return {
    id: g.id, kind: g.kind, target: g.target, label: g.label,
    have, need: g.count,
    done: ledger.unlocked[g.id] === true || have >= g.count,
  };
}
