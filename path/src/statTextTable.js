// ============================================================================
// STAT TEXT TABLE — every word {effect} can say, kept in statText.csv.
//
// {effect} is half measurement and half English. The measurement has to stay
// in code: it replays the upgrade's own apply() and reports what actually
// moved, which is the whole reason a card can no longer promise a number that
// config.js stopped delivering. The ENGLISH has no business being in code, and
// used to be: "+25% fire rate" is `fireRate: { label: 'fire rate' }` in a
// 60-entry object, so renaming a stat on a card meant editing a .js file.
//
// So the numbers are still measured and the words are now a spreadsheet.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       the stat key in the block, e.g. `fireRate`. Not shown to anyone;
//            it is the join to what apply() moves. A row whose id matches no
//            stat is dead weight and `npm run test:text` says so.
//   group    which section of the sheet the row belongs to. Cosmetic — it
//            keeps the file readable and orders the editor's rows.
//   kind     what the measured number MEANS, which is what decides its
//            phrasing. One of:
//              percent  a multiplier, shown as +N%
//              flat     an additive number shown as-is, "+30 max HP"
//              count    an additive whole number of things, pluralised
//              level    an ability's level; 0 -> 1 names the thing instead
//            An unrecognised kind falls back to `flat` with a warning, so a
//            typo is a plain-looking card and a console line, never a crash.
//   label    what the stat is CALLED on a card. The one column every row has.
//   plural   the plural of `label`, when adding an "s" is wrong ("orbiting
//            shrimp", "enemies"). Blank means label + "s".
//   unlock   for `level` stats only: what the FIRST stack reads as, in place
//            of "+1 level". "chain lightning", "a damaging aura". This is the
//            line that tells a player what they just bought.
//   template the whole phrase, when the standard shape is wrong. Blank means
//            the shape for its `kind`. See TEMPLATE TOKENS below.
//   unit     appended straight after the number on a `flat` stat: "s" gives
//            "+0.5s ricochet lifespan".
//   lower    TRUE where DOWN is the improvement — fireRate is a cooldown, so a
//            measured *= 0.75 has to read "+25% fire rate", not "-25%".
//   bare     TRUE where `label` is already a whole phrase and no noun should
//            be appended ("+2 of everything you fire").
//   percentOfOne  TRUE for a stat that is a fraction of a meter, so +0.15
//            reads as "+15%" of the thing it fills.
//   notes    free text. Nothing reads it.
//   review   whether the wording still wants Ethan's eye. Nothing reads it.
//
// TEMPLATE TOKENS — everything the standard shapes are built from, so an
// override never has to give up the measured number:
//   {n}      the measured amount, already formatted ("25", "1", "0.5")
//   {n%}     the same as a signed percentage ("+25%"), honouring `lower`
//   {+n}     the amount with an explicit sign ("+1", "-2")
//   {label}  the `label` column
//   {noun}   `label` or `plural`, chosen by the measured amount
//   {unit}   the `unit` column
//   {from} {to}  the measured endpoints, for a before/after phrasing
//
//   template: "{+n} more {noun}"     ->  "+2 more orbiting shrimp"
//   template: "{label} up {n%}"      ->  "fire rate up +25%"
//
// A template that renders empty is IGNORED and the standard shape is used
// instead — a mistyped override should read as the old wording, not as a card
// with a blank where its effect goes.
// ============================================================================

import { parseIdTable, parseBool } from './csvTable.js';
import statTextCsv from './statText.csv?raw';

const LABEL = 'statText';
const FILE = 'statText.csv';

export const KINDS = ['percent', 'flat', 'count', 'level'];

export function parseStatTextCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = {};

  for (const [id, row] of rows) {
    const label = (row.label ?? '').trim();
    // A row with no label is the one thing that cannot be defaulted: the
    // fallback is the raw stat key, which is what this table exists to stop
    // appearing on a card. Warn and skip, so the stat falls through to the
    // same fallback it would have had with no row at all.
    if (!label) {
      warn(`[${LABEL}] "${id}" has no label — the card would show the raw stat name. Row ignored.`);
      continue;
    }

    let kind = (row.kind ?? '').trim().toLowerCase() || 'flat';
    if (!KINDS.includes(kind)) {
      warn(`[${LABEL}] "${id}" has kind="${row.kind}", which isn't one of ${KINDS.join(', ')} — reading it as flat.`);
      kind = 'flat';
    }

    const entry = { label, kind };
    const plural = (row.plural ?? '').trim();
    const unlock = (row.unlock ?? '').trim();
    const template = (row.template ?? '').trim();
    const unit = (row.unit ?? '').trim();
    if (plural) entry.plural = plural;
    if (unlock) entry.unlock = unlock;
    if (template) entry.template = template;
    if (unit) entry.unit = unit;

    // parseBool treats a blank as TRUE, which is right for an `enabled`
    // column and exactly wrong for these three: blank has to mean "no, this
    // stat is ordinary". So a blank is read as false without going near it.
    const flag = (v, field) => (String(v ?? '').trim() === '' ? false : parseBool(v, LABEL, id, field, warn));
    if (flag(row.lower, 'lower')) entry.lower = true;
    if (flag(row.bare, 'bare')) entry.bare = true;
    if (flag(row.percentOfOne, 'percentOfOne')) entry.percentOfOne = true;

    out[id] = entry;
  }

  return out;
}

export const STAT_TEXT = parseStatTextCsv(statTextCsv);
