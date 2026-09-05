// ============================================================================
// UNLOCK TABLE — what has to be done before a thing is offered, in unlocks.csv.
//
// One row per GATE. A gate stands in front of exactly one thing — a card in
// the level-up hand or an accessory in the drawer — and names the lifetime
// stat that opens it and how much of that stat it takes. The stats themselves
// are counted by systems/unlocks.js, which is also where the vocabulary of
// stat names lives; this file only reads the rows.
//
// Columns:
//   id       the gate's own name. Joins to nothing in code — the progress
//            store keys on it, so RENAMING one forgets who has earned it.
//   kind     `accessory` or `upgrade`. Which roster `target` is looked up in.
//   target   the thing being gated: a key of CONFIG.accessories.items, or an
//            id in CONFIG.upgrades. A target nothing declares is a gate on a
//            door that does not exist, and is dropped with a warning rather
//            than kept — it would gate nothing and look like it gated something.
//   stat     the counter that opens it. See STATS in systems/unlocks.js for
//            every name that is ever incremented; a stat nobody increments is
//            a gate that never opens, and buildUnlocks warns when it is handed
//            the list and cannot find one.
//   count    how much of `stat`. Blank is 1 — "do it once".
//   label    what the player reads as the requirement. Copy, so it is Ethan's:
//            a row arrives as lorem and npm run test:copy holds the ship until
//            the line is written.
//   enabled  FALSE switches the gate off — the thing is offered as if the row
//            were not there. Blank means enabled.
//
// A thing with NO row is never gated. That is the default on purpose: the
// table lists what is EARNED, and everything else is in the game from the
// first run. It also means the gate switch (systems/unlocks.js) can go on for
// a public build while most of the roster is untouched.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'unlocks';
const FILE = 'unlocks.csv';

export const GATE_KINDS = ['accessory', 'upgrade'];

export function parseUnlockCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

/**
 * Rows to gates.
 *
 * @param rows        the Map parseUnlockCsv returns.
 * @param targets     `{ accessory: [...keys], upgrade: [...ids] }` — what may be
 *                    gated. A gate on a target not in its list is dropped.
 * @param stats       every stat name the game increments. Optional: a gate on
 *                    an unknown stat is KEPT, but warned about, because the
 *                    honest reading of "count boats on a stat nobody counts"
 *                    is a locked door — which is at least visible — rather than
 *                    a door quietly opened by dropping the row.
 */
export function buildUnlocks(rows, targets = {}, warn = console.warn, stats = null) {
  const out = [];
  for (const [id, row] of rows) {
    if ('enabled' in row && parseBool(row.enabled, LABEL, id, 'enabled', warn) === false) continue;

    const kind = String(row.kind ?? '').trim();
    if (!GATE_KINDS.includes(kind)) {
      warn(`[${LABEL}] "${id}" has kind="${row.kind}", which is not one of ${GATE_KINDS.join('/')} — skipped.`);
      continue;
    }

    const target = String(row.target ?? '').trim();
    if (!target) {
      warn(`[${LABEL}] "${id}" names no target — skipped.`);
      continue;
    }
    const known = targets[kind];
    if (Array.isArray(known) && !known.includes(target)) {
      warn(`[${LABEL}] "${id}" gates ${kind} "${target}", which does not exist — skipped.`);
      continue;
    }

    const stat = String(row.stat ?? '').trim();
    if (!stat) {
      warn(`[${LABEL}] "${id}" names no stat, so nothing could ever open it — skipped.`);
      continue;
    }
    if (Array.isArray(stats) && !stats.includes(stat) && !stats.some((s) => s.endsWith('.') && stat.startsWith(s))) {
      warn(`[${LABEL}] "${id}" waits on stat "${stat}", which nothing in the game counts — it will never open.`);
    }

    let count = parseNumber(row.count, LABEL, id, 'count', warn, { min: 1, integer: true });
    // Blank is "once"; a value that made no sense has already been warned
    // about, and "once" is the safe reading of a threshold nobody could read.
    if (count == null) count = 1;

    out.push({ id, kind, target, stat, count, label: String(row.label ?? '').trim() });
  }
  return out;
}
