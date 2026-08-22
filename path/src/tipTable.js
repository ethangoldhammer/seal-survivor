// ============================================================================
// TIP TABLE — what a tip buys, kept in tips.csv.
//
// The tip jar used to be one link to Ko-fi and nothing else: an ask with no
// answer to "what for". These are the answers, and they are all the same
// answer in different sizes — a name, in the water, with everybody else's.
//
// A TABLE BECAUSE THE PRICES WILL MOVE. Every one of these is a guess about
// what a joke is worth, and the whole point of a row is that changing the guess
// is an edit to a spreadsheet rather than to a menu, a stylesheet and a string.
//
// Like quips.csv, the `id` here joins to nothing in code — it is a handle for
// diffs and warnings, so a tier can be repriced or reworded without the row
// losing its identity in a pull request.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   price    whole dollars. The number the player is agreeing to.
//   label    the name of the tier, as a thing you buy: "Name a boss".
//   desc     one line on what actually happens. Written as a promise the
//            player can check later, because they will.
//   tag      the word the player is asked to start their Ko-fi message with,
//            so the submissions arrive sorted. SEAL or BOSS today; anything
//            else is passed through, because a new kind of name should not
//            need a code change to be askable for.
//   enabled  FALSE takes the tier off the panel. Blank means enabled — so a
//            tier can be pulled for a month without deleting what it said.
//   order    where it sits in the list, low first. Blank sorts last, and ties
//            keep file order. NOT the price: the cheapest tier is not always
//            the one to lead with, and sorting by price would take that
//            decision away from whoever writes the row.
//
// WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: a payment link per tier. There
// is one Ko-fi page (TIP_JAR_URL in ui/tipJar.js) and the player types the
// amount there. A per-tier checkout URL would be four more things to keep
// alive, and Ko-fi's own page is the only place the number is ever actually
// agreed to — the panel quotes a price, it does not charge one.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'tips';
const FILE = 'tips.csv';

/**
 * tips.csv into the rows the panel renders.
 *
 * A row missing a price or a label is DROPPED WITH A WARNING rather than shown
 * with a blank in it: this is the one screen in the game that quotes a number
 * at somebody, and a tier that says "$" or an empty button is worse than a
 * tier that isn't there.
 */
export function parseTipCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const label = String(row.label ?? '').trim();
    if (!label) {
      warn(`[${LABEL}] "${id}" has no label — the row is being ignored.`);
      continue;
    }

    // min: 1 rather than 0. A free tier is not a tip, and a $0 row on this
    // panel reads as a bug in the panel rather than as a gift.
    const price = parseNumber(row.price, LABEL, id, 'price', warn, { min: 1, integer: true });
    if (price == null) {
      warn(`[${LABEL}] "${id}" has no usable price — the row is being ignored.`);
      continue;
    }

    const order = parseNumber(row.order, LABEL, id, 'order', warn, { min: 0 });
    out.push({
      id,
      price,
      label,
      desc: String(row.desc ?? '').trim(),
      // Upper-cased here rather than in the panel, because it is a token the
      // player is asked to type EXACTLY and the file should not be able to
      // disagree with the screen about its shape.
      tag: String(row.tag ?? '').trim().toUpperCase(),
      // Blank sorts last: Infinity, not 0, or an un-numbered row would jump
      // the queue instead of joining the back of it.
      order: order == null ? Infinity : order,
    });
  }

  // A stable sort, so ties keep the order they were written in.
  out.sort((a, b) => a.order - b.order);

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable tiers — the tip jar will link straight to Ko-fi.`);
  }
  return out;
}
