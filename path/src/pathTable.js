// ---------------------------------------------------------------------------
// PATH TABLES — the balance numbers, kept in CSVs and edited with `npm run csv`.
//
// A path table is keyed by a DOTTED PATH into CONFIG rather than by a creature
// or upgrade id, which is what lets one file own settings from several config
// blocks at once. `spawning.csv` was the first; `weapons.csv` and
// `behaviour.csv` are the same machinery pointed at different roots.
//
// WHY THESE LEFT THE TUNER. A slider is for something you judge by eye while
// it happens — how bright a glow is, how hard a claw snaps. These are judged
// over MINUTES and AGAINST EACH OTHER: "is the XP curve right" is a question
// about eight numbers at once, and a panel that shows you one at a time is the
// wrong instrument. Roughly 95 of the game's ~1,700 tunables are like that;
// the rest genuinely belong on sliders and are deliberately left there.
//
// THREE PROPERTIES MAKE A TABLE AUTHORITATIVE RATHER THAN ADVISORY, and all
// three are the difference between "the file is the truth" and "the file is a
// suggestion the game may ignore":
//
//   1. THE TYPE COMES FROM config.js. Every value is coerced to whatever the
//      built-in at that path already is — a number stays a number, a boolean
//      reads 1/0. A typo can never change a field's TYPE and take the boot
//      down, and the CSV never needs a `type` column that could disagree with
//      the code.
//   2. THE PATHS ARE STRIPPED FROM THE SNAPSHOT, on the way in AND on the way
//      out. These were tuner sliders, so every imported-tuning.json still
//      carries them, and a saved value beats a config.js default. Strip only
//      on load and every save quietly re-accumulates them.
//   3. A PATH THAT MATCHES NOTHING IS REPORTED AND SKIPPED. Silently creating
//      CONFIG.spwan.baseInterval would leave the real setting on its default
//      with the table apparently set, which is the worst of both.
// ---------------------------------------------------------------------------

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

function readPath(obj, path) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

function writePath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') return false;
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return true;
}

/**
 * Build one table from a CSV's text.
 *
 * @param label  tag on every warning, so a message says which file it came from
 * @param file   the filename, for those same messages
 * @param roots  which CONFIG top-level keys this table may write. A guard, not
 *               a convenience: `id` is free text typed into a spreadsheet, and
 *               without this a stray row could reach any part of the config.
 * @param forbid optional extra veto, for paths inside an allowed root that
 *               another table already owns. See TABLES below — this is what
 *               stops `behaviour.csv` growing a second home for a column
 *               `enemies.csv` owns, which is the exact bug the 50 dead
 *               spawnRateMul sliders were.
 */
export function createPathTable({ label, file, roots, forbid = null, text }, warn = console.warn) {
  const rows = parseIdTable(text, label, file, warn);

  const allowed = (id) => {
    if (!roots.includes(id.split('.')[0])) {
      warn(`[${label}] "${id}" is not under ${roots.join(' or ')} — skipped. `
        + `${file} only owns those blocks.`);
      return false;
    }
    const why = forbid?.(id);
    if (why) {
      warn(`[${label}] "${id}" is skipped: ${why}`);
      return false;
    }
    return true;
  };

  return {
    label,
    file,
    rows,
    ids: () => [...rows.keys()],

    // What config.js declares, captured BEFORE any snapshot merge — it has to
    // hold what the source says, not what a snapshot last set. Also what a row
    // DELETED from the CSV falls back to.
    captureBase(config) {
      const base = new Map();
      for (const id of rows.keys()) base.set(id, readPath(config, id));
      return base;
    },

    apply(config, base) {
      for (const [id, row] of rows) {
        if (!allowed(id)) continue;
        const built = base.has(id) ? base.get(id) : readPath(config, id);
        if (built === undefined) {
          warn(`[${label}] "${id}" matches nothing in config.js — skipped. Check the spelling; `
            + 'a path that does not exist would otherwise read as set while doing nothing.');
          continue;
        }

        const raw = String(row.value ?? '').trim();
        // Blank means "leave the built-in alone", the same as everywhere else
        // in these tables — NOT zero, which would switch a system off.
        if (raw === '') { writePath(config, id, built); continue; }

        if (typeof built === 'boolean') {
          writePath(config, id, parseBool(raw, label, id, 'value', warn));
        } else {
          const n = parseNumber(raw, label, id, 'value', warn);
          if (n != null) writePath(config, id, n);
        }
      }
    },

    // Take every path this table owns back out of a snapshot. Returns a new
    // object; the input may be the LIVE CONFIG and must not be mutated.
    strip(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      const out = JSON.parse(JSON.stringify(snapshot));
      for (const id of rows.keys()) {
        const keys = id.split('.');
        let cur = out;
        const chain = [out];
        let ok = true;
        for (let i = 0; i < keys.length - 1; i++) {
          cur = cur?.[keys[i]];
          if (cur == null || typeof cur !== 'object') { ok = false; break; }
          chain.push(cur);
        }
        if (!ok) continue;
        delete cur[keys[keys.length - 1]];
        // Prune parents this emptied, so a snapshot does not accumulate a tree
        // of hollow objects for settings nothing writes any more.
        for (let i = chain.length - 1; i > 0; i--) {
          if (Object.keys(chain[i]).length === 0) delete chain[i - 1][keys[i - 1]];
          else break;
        }
      }
      return out;
    },
  };
}

// Run a snapshot through every table's strip, in order.
export function stripAllTables(snapshot, tables) {
  return tables.reduce((acc, t) => t.strip(acc), snapshot);
}
