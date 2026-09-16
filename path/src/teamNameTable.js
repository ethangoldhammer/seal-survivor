// ============================================================================
// TEAM NAME TABLE — what a Blubberball side is CALLED, built out of the two
// things a side already has by the time the whistle is due: the colour its
// captain picked off the wheel, and the seals sitting in its seats.
//
// The same shape as sealNames.csv and bossNames.csv, and for the same reason:
// the cheapest content in the game is a table of parts. A dozen colour words
// against a dozen nouns is a hundred and forty teams rather than twenty-four
// rows — and because one half of every name is the KIT, a team called after
// the colour it is wearing is a team you can identify from the strip.
//
// THE COLOUR IS A BAND, NOT A HEX. CONFIG.versus.wheel is twelve colours today
// and is explicitly replaceable (see the note there — "the count is the only
// thing the code has an opinion about"), so a table keyed to those twelve hexes
// would go wrong the first time one of them was nudged. Each colour row names a
// HUE instead, in degrees, and a match takes the band whose hue is nearest to
// what the captain picked. Edit a wheel swatch from 0xff4d4d to 0xf03a3a and it
// is still the red band's words; add a thirteenth swatch and it lands in
// whichever band it is closest to rather than in none.
//
// A COLOUR WITH NO HUE IS `neutral` — the wheel's white, and any grey, black or
// near-white that ever joins it. Hue is meaningless below a certain saturation
// (every grey reads as hue 0, which is red), so a saturation floor decides
// which question is even asked. Without it the white swatch would be named in
// the red band's words, and nothing about the file would look wrong.
//
// THE SEALS ARE THE OTHER HALF, and this is the part a colour table alone
// cannot do. A shape may borrow a member's NICKNAME or its ADJECTIVE — the
// halves a seal name is built from (sealNameTable.js) — so a side with Phat
// Tony in it can be Tony's Terrors or the Phat Terrors. That is a team named
// after its players, which is what a team name mostly is.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id       a short handle for the row. Must be unique; never shown.
//   slot     which PART this is. One of:
//              colour     a word for a kit colour — needs a `hue`
//              noun       what the side is called collectively, plural
//              shape      the GRAMMAR: a template of tokens, see below
//              full       a WHOLE team name, written out
//   text     the part itself, with exactly the capitalisation typed here.
//   review   the copy backlog's column — see CLAUDE.md. Blank is Ethan's.
//   hue      `colour` rows only: where on the hue circle this band sits, in
//            degrees 0-360 (0 red, 120 green, 240 blue). Several rows may
//            share a hue — that is a band with more than one word in it, which
//            is how a colour stops always producing the same team. Blank, or
//            the word `neutral`, is the band for anything unsaturated.
//   enabled  FALSE takes the part out of rotation. Blank means enabled.
//   weight   likelihood RELATIVE TO THE OTHER ROWS IN ITS POOL — the rows in
//            the same band, the other nouns, the other shapes. Blank is 1, 0
//            is never used. Weights do not cross pools.
//   notes    free text; nothing reads it. Where a draft row's brief goes.
//
// THE SHAPE IS THE GRAMMAR AND IT IS A ROW, not a string in this file, for the
// same reason statText.csv's `template` is: "{colour} {noun}" is one English
// idea of what a team is called and there are several others, and each of them
// should be a line somebody can add rather than a branch somebody has to write.
// The tokens are:
//
//   {colour}     the band's word              → "Tangerine"
//   {noun}       the collective noun          → "Terrors"
//   {seal}       one member's whole name      → "Phat Tony"
//   {nickname}   ...its back half             → "Tony"
//   {adjective}  ...its front half            → "Phat"
//
// EVERY MEMBER TOKEN IN ONE SHAPE IS THE SAME SEAL. "{adjective} {nickname}"
// draws one member and takes both halves off it, rather than stitching two
// seals into one creature that is on the team twice.
//
// A SHAPE THAT CANNOT BE FILLED IS NOT DRAWN. A side whose seals all have
// one-word names has no `{adjective}` to lend, so the shapes that want one are
// out of the pool for that match — rather than rendering with a hole in them.
// That is also what makes `full` safe next to them.
//
// FULL IS THE WAY OUT OF THE MACHINE, exactly as it is in sealNames.csv: parts
// are wonderful for volume and useless for a joke. A full name competes with
// the built ones at `fullChance` rather than replacing them.
//
// NOTHING HERE IS ROLLED UNTIL THE MATCH STARTS — see systems/teamNameCast.js
// for when, and why it is not the team select.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
import { withoutRecent, rememberPick, rememberName, wasJustRolled } from './namePool.js';

const LABEL = 'teamNames';
const FILE = 'teamNames.csv';

/** Every slot a row may declare. The parser reads this one. */
export const TEAM_NAME_SLOTS = ['colour', 'noun', 'shape', 'full'];

/** The band a colour row lands in when it has no hue, and what an unsaturated
 *  kit colour is matched against. A string on purpose: it is not a point on the
 *  circle, it is the absence of one, and a number would be a hue that some
 *  other band could be "nearer" to. */
export const NEUTRAL_BAND = 'neutral';

/**
 * HOW MUCH COLOUR A KIT NEEDS before its hue is worth asking about. Below this
 * it is matched to the neutral band instead.
 *
 * 0.18 of HSV saturation. The wheel's own white is 0.00 and its weakest colour
 * is the violet at 0.64, so the floor sits in open space between them and
 * nothing on the shipped ring is near it — which is the point: this is a guard
 * against a grey being called red, not a dial for tuning which words a purple
 * gets.
 */
export const NEUTRAL_SAT = 0.18;

/**
 * How often a hand-written whole name wins over a built one, when the table has
 * any. Under half for the reason sealNames.csv's is: the written names are the
 * seasoning, and a roll that mostly returned them would waste the vocabulary
 * that makes the next match different from this one.
 */
export const DEFAULT_FULL_CHANCE = 0.2;

/**
 * The longest a team name may be. A `full` row over it is refused at parse
 * (nothing can rescue it later); a BUILT name over it is redrawn, and only if
 * every redraw is too long does the long one go through — one wide label is a
 * better failure than no name at all.
 *
 * 34 characters, which is the widest string the goal card's name line holds at
 * its `nowrap` without leaving the card — the same constraint a seal name is
 * already cut to (MAX_NAME_LEN is 32) plus the room a two-word colour buys.
 */
export const MAX_TEAM_NAME_LEN = 34;

/** Every token a shape may spend. Exported so the test and the editor's help
 *  cannot drift from what a shape is actually filled with. */
export const TEAM_TOKENS = ['colour', 'noun', 'seal', 'nickname', 'adjective'];

/** ...and the ones that come off a SEAL rather than off the table. All of them
 *  in one shape are filled from the same member — see the header. */
export const MEMBER_TOKENS = ['seal', 'nickname', 'adjective'];

const TOKEN_RE = /\{(\w+)\}/g;

/** Tries at a name short enough for the card. See MAX_TEAM_NAME_LEN. */
const LENGTH_TRIES = 8;

// ---------------------------------------------------------------------------
// PARSING
// ---------------------------------------------------------------------------

/**
 * Parse the table into { colour: [...], noun: [...], shape: [...], full: [...] }.
 * Every slot is always present, possibly empty. A `colour` row carries `band`:
 * a number of degrees, or NEUTRAL_BAND.
 */
export function parseTeamNameCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = {};
  for (const slot of TEAM_NAME_SLOTS) out[slot] = [];

  for (const [id, row] of rows) {
    const slot = String(row.slot ?? '').trim().toLowerCase();
    if (!TEAM_NAME_SLOTS.includes(slot)) {
      warn(`[${LABEL}] "${id}" has slot "${row.slot ?? ''}", which is not one of ${TEAM_NAME_SLOTS.join(', ')} — the row is being ignored.`);
      continue;
    }

    const partText = String(row.text ?? '').trim();
    if (!partText) {
      warn(`[${LABEL}] "${id}" has no text — the row is being ignored.`);
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    // A SHAPE IS CHECKED FOR TOKENS IT CANNOT SPEND. A typo'd token is not a
    // shape with a small mistake in it — it is a shape that renders "{nikname}"
    // onto a card, which is exactly the kind of thing that survives a playtest
    // because nobody reads a team name twice.
    if (slot === 'shape') {
      const bad = [...partText.matchAll(TOKEN_RE)].map((m) => m[1]).filter((t) => !TEAM_TOKENS.includes(t));
      if (bad.length) {
        warn(`[${LABEL}] "${id}" uses {${bad.join('}, {')}}, which ${bad.length > 1 ? 'are not tokens' : 'is not a token'} — the row is being ignored. The tokens are {${TEAM_TOKENS.join('}, {')}}.`);
        continue;
      }
      // A shape of nothing but one token is legal ("{nickname}"); a shape with
      // no token at all is a fixed string that would name every side the same
      // thing, which is what the `full` slot is for.
      if (!bad.length && ![...partText.matchAll(TOKEN_RE)].length) {
        warn(`[${LABEL}] "${id}" is a shape with no tokens in it, so every side it drew would be called "${partText}" — write it as a \`full\` row instead. The row is being ignored.`);
        continue;
      }
    }

    // A FULL NAME THAT CANNOT FIT IS A FILE ERROR, not a roll-time problem: a
    // built name can be redrawn and this one cannot, so the only choices later
    // would be showing it cut or quietly showing something else.
    if (slot === 'full' && partText.length > MAX_TEAM_NAME_LEN) {
      warn(`[${LABEL}] "${id}" is ${partText.length} characters and a team name has room for ${MAX_TEAM_NAME_LEN} — the row is being ignored.`);
      continue;
    }

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    const part = { id, text: partText, weight: w == null ? 1 : w };

    if (slot === 'colour') {
      part.band = parseBand(row.hue, id, warn);
    } else if (String(row.hue ?? '').trim()) {
      warn(`[${LABEL}] "${id}" is a ${slot} row with hue="${row.hue}" — hue only means anything on a colour row, and this one is being ignored.`);
    }

    out[slot].push(part);
  }

  reportDuplicates(out, warn);

  if (!out.colour.length && !out.full.length) {
    warn(`[${LABEL}] ${FILE} has no colour rows and no full names — every side will go unnamed.`);
  } else if (!out.shape.length && !out.full.length) {
    warn(`[${LABEL}] ${FILE} has words in it but no shape rows — there is nothing saying how to put them together, so every side will go unnamed.`);
  }

  return out;
}

/**
 * A `hue` cell into a band: a number of degrees wrapped into 0-360, or
 * NEUTRAL_BAND for a blank cell or the word itself.
 */
function parseBand(raw, id, warn) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v || v === NEUTRAL_BAND) return NEUTRAL_BAND;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    warn(`[${LABEL}] "${id}" has hue="${raw}", which is neither a number of degrees nor "${NEUTRAL_BAND}" — the row is being read as ${NEUTRAL_BAND}.`);
    return NEUTRAL_BAND;
  }
  return ((n % 360) + 360) % 360;
}

/**
 * TWO ROWS SAYING THE SAME WORD, which the id check cannot see. A duplicate id
 * loses a row loudly; a duplicate TEXT under two ids is silent and all it does
 * is make that word twice as likely as the file makes it look.
 *
 * ...and the same word in TWO BANDS, which is the failure this table has that
 * the seal names do not: a colour word that is in both the red band and the
 * pink one is a word that no longer tells you what the side is wearing.
 */
function reportDuplicates(out, warn) {
  for (const slot of TEAM_NAME_SLOTS) {
    const seen = new Map();
    for (const part of out[slot]) {
      const key = part.text.toLowerCase();
      const first = seen.get(key);
      if (!first) { seen.set(key, part); continue; }
      if (slot === 'colour' && first.band !== part.band) {
        warn(`[${LABEL}] "${part.id}" and "${first.id}" are both the word "${part.text}" in different bands (${bandLabel(first.band)} and ${bandLabel(part.band)}) — one word cannot name two colours. Keep it in one band.`);
      } else {
        warn(`[${LABEL}] "${part.id}" and "${first.id}" are both ${slot} "${part.text}" — the word is twice as likely as one row makes it look. Delete one, or say so with \`weight\`.`);
      }
    }
  }
}

const bandLabel = (band) => (band === NEUTRAL_BAND ? NEUTRAL_BAND : `${Math.round(band)}°`);

// ---------------------------------------------------------------------------
// MATCHING A KIT COLOUR TO A BAND
// ---------------------------------------------------------------------------

/**
 * The hue and saturation of a 0xRRGGBB colour. HSV saturation (d / max), not
 * HSL's, because the question being asked is "is there a colour here at all"
 * and HSL's answer for a dark, vivid navy is a high number for a colour the eye
 * can barely place.
 */
export function hueSat(hex) {
  const n = (hex >>> 0) & 0xffffff;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const sat = max <= 0 ? 0 : d / max;
  if (d < 1e-6) return { hue: 0, sat: 0 };
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { hue: h, sat };
}

/** How far apart two hues are on the circle, in degrees. Never over 180. */
export function hueGap(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * WHICH BAND a kit colour belongs to — a degree value that some colour row
 * declares, or NEUTRAL_BAND. Null when the table has no colour rows at all.
 *
 * An unsaturated colour takes the neutral band if there is one and nothing at
 * all if there is not: a grey named in the red band's words is worse than a
 * grey with no colour word, because it reads as the table being wrong about
 * every red.
 */
export function bandOfColor(parts, hex) {
  const rows = parts?.colour ?? [];
  if (!rows.length) return null;
  const { hue, sat } = hueSat(hex);
  const hasNeutral = rows.some((r) => r.band === NEUTRAL_BAND);
  if (sat < NEUTRAL_SAT) return hasNeutral ? NEUTRAL_BAND : null;
  let best = null;
  let bestGap = Infinity;
  for (const row of rows) {
    if (row.band === NEUTRAL_BAND) continue;
    const gap = hueGap(hue, row.band);
    if (gap < bestGap) { bestGap = gap; best = row.band; }
  }
  return best == null ? (hasNeutral ? NEUTRAL_BAND : null) : best;
}

/** Every colour word available to a kit colour — the rows of its band. */
export function colourWords(parts, hex) {
  const band = bandOfColor(parts, hex);
  if (band == null) return [];
  return (parts.colour ?? []).filter((r) => r.band === band);
}

// ---------------------------------------------------------------------------
// ROLLING
// ---------------------------------------------------------------------------

// `memory`/`slot` narrow the pool to what has not been drawn lately -- see
// namePool.js. Both optional, so every existing caller is unchanged.
function pick(rows, random, memory = null, slot = '', keep = undefined) {
  rows = memory ? withoutRecent(rows, memory, slot, keep) : rows;
  if (!rows?.length) return null;
  let total = 0;
  for (const r of rows) total += r.weight > 0 ? r.weight : 0;
  if (total <= 0) return rows[Math.floor(random() * rows.length)];
  let roll = random() * total;
  let last = rows[0];
  for (const r of rows) {
    if (r.weight <= 0) continue;
    last = r;
    roll -= r.weight;
    if (roll <= 0) return r;
  }
  return last;
}

/**
 * A seal name into its halves, with NO table behind it: the last word is the
 * nickname and everything before it is the adjective.
 *
 * The default only. sealNameTable.js can split a name against the very rows it
 * was built from, which is the right answer for "The One and Only Osbourne" and
 * is a dependency this module has no business taking on — so the caller passes
 * that in as `split` and this is what a test, or anything holding a name from
 * somewhere else, gets for free.
 */
export function splitLastWord(name) {
  const whole = String(name ?? '').trim().replace(/\s+/g, ' ');
  const at = whole.lastIndexOf(' ');
  if (at < 0) return { adjective: '', nickname: whole };
  return { adjective: whole.slice(0, at), nickname: whole.slice(at + 1) };
}

const tokensIn = (shape) => [...String(shape).matchAll(TOKEN_RE)].map((m) => m[1]);

/**
 * ROLL A TEAM NAME.
 *
 * @param parts             parseTeamNameCsv's output
 * @param opts.color        the side's kit colour, 0xRRGGBB
 * @param opts.members      the seals on the side, as names
 * @param opts.avoid        a name to redraw once away from — the other side's
 * @param opts.fullChance   how often a written name wins; DEFAULT_FULL_CHANCE
 * @param opts.split        name → { adjective, nickname }; splitLastWord
 * @param random            () => [0,1)
 * @returns the name, or '' when the table can build nothing
 */

// MEMORY IS THE CALLER'S, never a module-level default. The same reasoning as
// bossState.bag in bossTable.js: a roll that quietly reads hidden state is no
// longer a function of its arguments, so two seeded loops in one harness stop
// being reproducible -- which is exactly how this arrived, as tools/boss-test
// failing an exclusivity check that had nothing to do with cooldowns.
export function rollTeamName(parts, opts = {}, random = Math.random) {
  const avoid = String(opts.avoid ?? '').trim();
  const mem = opts.memory ?? null;
  const keep = opts.keepRecent;
  // AVOID OUTRANKS THE COOLDOWN -- same reasoning as rollSealName, and the
  // same failure if they are weighed equally: two usable names and a cooldown
  // that alternates them hands back the avoided one half the time.
  let name = drawTeamName(parts, opts, random);
  if ((avoid && name === avoid) || wasJustRolled(mem, name, keep)) {
    let firstAllowed = (avoid && name === avoid) ? null : name;
    for (let i = 0; i < 4; i++) {
      const next = drawTeamName(parts, opts, random);
      const avoided = avoid && next === avoid;
      if (!avoided && firstAllowed == null) firstAllowed = next;
      if (!avoided && !wasJustRolled(mem, next, keep)) { firstAllowed = next; break; }
      name = next;
    }
    if (firstAllowed != null) name = firstAllowed;
  }
  rememberName(mem, name, keep);
  return name;
}

function drawTeamName(parts, opts, random) {
  let last = '';
  for (let i = 0; i < LENGTH_TRIES; i += 1) {
    const name = drawOnce(parts, opts, random);
    if (!name) return '';
    if (name.length <= MAX_TEAM_NAME_LEN) return name;
    last = name;
  }
  // Every draw was too long for the card. Handed back anyway: a wide label is
  // a cosmetic problem and a nameless side is a hole in the screen.
  return last;
}

function drawOnce(parts, opts, random) {
  const chance = opts.fullChance ?? DEFAULT_FULL_CHANCE;
  const mem = opts.memory ?? null;
  const keep = opts.keepRecent;
  const full = parts?.full ?? [];
  if (full.length && chance > 0 && random() < chance) {
    const written = pick(full, random, mem, 'full', keep);
    if (written) return written.text;
  }

  const split = typeof opts.split === 'function' ? opts.split : splitLastWord;
  const members = (opts.members ?? []).map((n) => String(n ?? '').trim()).filter(Boolean);
  const halves = members.map((n) => ({ seal: n, ...split(n) }));

  // WHAT THIS MATCH CAN ACTUALLY SAY. A band with no words in it, a side whose
  // seals are all one-word — each takes the shapes that need it out of the
  // pool, rather than letting one render with a hole in it.
  const words = colourWords(parts, opts.color ?? 0);
  const have = {
    colour: words.length > 0,
    noun: (parts?.noun ?? []).length > 0,
  };
  // A SHAPE'S MEMBER TOKENS ARE ASKED OF ONE SEAL, so the question is not "is
  // there an adjective on this side and a nickname on this side" — it is "is
  // there a seal with both", which is a different question the moment a side
  // holds one two-word name and one one-word name. Asked here, once, and spent
  // again below to draw the seal itself.
  const lenders = (shape) => {
    const needs = tokensIn(shape).filter((t) => MEMBER_TOKENS.includes(t));
    if (!needs.length) return halves.length ? halves : [];
    return halves.filter((h) => needs.every((t) => h[t]));
  };
  const shapes = (parts?.shape ?? []).filter((s) => {
    const tokens = tokensIn(s.text);
    if (!tokens.every((t) => (t in have ? have[t] : true))) return false;
    return !tokens.some((t) => MEMBER_TOKENS.includes(t)) || lenders(s.text).length > 0;
  });
  if (!shapes.length) {
    // Nothing can be built. A written name is the last resort rather than the
    // seasoning — which is also what makes a table of nothing but `full` rows
    // a legal way to use this file.
    const written = pick(full, random, mem, 'full', keep);
    return written ? written.text : '';
  }

  const shape = pick(shapes, random, mem, 'shape', keep);
  // ONE SEAL LENDS EVERY MEMBER TOKEN IN A NAME — see the header. Drawn from
  // the members that have all the halves this shape asks for, which is the
  // same set the shape was kept in the pool for.
  const usable = lenders(shape.text);
  const who = usable.length ? usable[Math.floor(random() * usable.length)] : null;
  const colour = pick(words, random, mem, 'colour', keep);
  const noun = pick(parts?.noun ?? [], random, mem, 'noun', keep);

  const value = {
    colour: colour?.text ?? '',
    noun: noun?.text ?? '',
    seal: who?.seal ?? '',
    nickname: who?.nickname ?? '',
    adjective: who?.adjective ?? '',
  };
  const built = shape.text.replace(TOKEN_RE, (m, t) => (t in value ? value[t] : m));
  return built.replace(/\s+/g, ' ').trim();
}
