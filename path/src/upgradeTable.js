// ============================================================================
// UPGRADE TABLE — the editable half of every upgrade, kept in upgrades.csv.
//
// What an upgrade DOES is code: each entry in CONFIG.upgrades carries an
// apply() function, and that can't live in a spreadsheet. Everything else
// about it — what it's called, what the card says, how far it stacks, whether
// it's offered at all, how often, and which hex art sits behind it — is
// content, and content belongs in a table you can sort, fill down and diff.
//
// So upgrades.csv is the source of truth for those six fields. Open it in a
// spreadsheet, in a text editor, or with `npm run csv` (a grid with the
// columns typed — cardArt as a picker of the real images, enabled as a
// dropdown); edit, save; the dev server reloads the page and the new values
// are live. Nothing in the game writes back to it — the in-game Upgrades tab
// is a read-only view of what this file produced.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id         must match an id in CONFIG.upgrades. The join key.
//   name       card title. Blank keeps the built-in name.
//   desc       card body text. Blank keeps the built-in description.
//   maxStacks  how many times it can be taken. BLANK MEANS UNLIMITED — the
//              same thing the old tuner's empty "max stacks" box meant.
//   enabled    FALSE removes it from the offer pool. Blank means enabled.
//   weight     how likely this is to be offered, RELATIVE TO THE OTHER ROWS.
//              Blank means 1. A row at 2 comes up twice as often as a row at
//              1; a row at 0 is never offered, which is a softer `enabled`
//              FALSE — the upgrade still exists and still shows in the
//              Upgrades tab, it just stops being dealt. See below for why
//              this is a column rather than a slider.
//   cardArt    a key from LEVELUP_IMAGE_KEYS. Blank means the plain card.
//   sfx        a key from CONFIG.sfx, played when this card is TAKEN. Blank
//              means the card is voiced by the shared `levelUp` feedback like
//              every other one — which is the right answer for most of them.
//              Set it on the cards that deserve their own arrival.
//
// Fields deliberately NOT here: `perLevelName` and `levelDescs`, which are
// per-stack display rules on two upgrades and don't flatten into a row.
// They stay in config.js.
//
// Why `weight` belongs in the file and not on a tuner slider: rarity is only
// ever meaningful against the rest of the roster. "Is Baby Beluga too common"
// is a question about the other twenty-nine rows, and the answer is a column
// you can sort — not a number you drag on its own with nothing to compare it
// to. That is the same reasoning that put `maxStacks` here.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'upgrades';
const FILE = 'upgrades.csv';

export function parseUpgradeCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

function parseStacks(raw, id, warn) {
  const n = parseNumber(raw, LABEL, id, 'maxStacks', warn, { min: 1, integer: true });
  // Blank is unlimited, and so is a value that made no sense — the warning
  // has already gone out, and the safe reading of "I don't understand this
  // cap" is not to invent one.
  return n == null ? null : n;
}

function parseWeight(raw, id, warn) {
  const n = parseNumber(raw, LABEL, id, 'weight', warn, { min: 0 });
  // Blank and unreadable both mean "ordinary", i.e. the same 1 every row had
  // before this column existed. A typo must not silently make a card rare.
  return n == null ? 1 : n;
}

// Write the table's fields onto the live CONFIG.upgrades entries, in place.
//
// Idempotent and reversible: every field is reset to the built-in captured in
// `base` before the row is applied, so an id that drops out of the CSV goes
// back to its config.js values instead of keeping whichever edit was last
// applied. That reversibility is the whole reason `base` is captured at boot
// rather than read back off the objects being mutated.
export function applyUpgradeTable(upgrades, base, rows, imageKeys, warn = console.warn, sfxKeys = []) {
  const seen = new Set();

  for (const u of upgrades) {
    const b = base.get(u.id);
    if (b) {
      u.name = b.name;
      u.desc = b.desc;
      u.maxStacks = b.maxStacks;
      u.enabled = b.enabled;
      u.weight = b.weight;
      u.cardArt = b.cardArt;
      u.sfx = b.sfx;
      u.weaponName = b.weaponName;
      u.weaponNameLaser = b.weaponNameLaser;
    }

    const row = rows.get(u.id);
    if (!row) continue;
    seen.add(u.id);

    const name = (row.name ?? '').trim();
    const desc = (row.desc ?? '').trim();
    if (name) u.name = name;
    if (desc) u.desc = desc;
    // WHAT THE WEAPON IS CALLED once this upgrade is held — see weaponName.js.
    // A whole name and not an adjective, so a row can say anything rather than
    // being stuck with "<word> Pebbles"; blank is the overwhelming majority of
    // rows and means the upgrade does not rename anything. Not validated
    // against a weapon here: this table has no idea which weapons exist, and
    // the join is checked by npm run test:weaponnames instead.
    if ('weaponName' in row) u.weaponName = String(row.weaponName ?? '').trim() || null;
    // ...AND WHAT IT IS CALLED ON A LASER RUN, which is a second column rather
    // than a token inside the first. "Cloned Pebbles" cannot be pattern-matched
    // into the laser's equivalent — the word that changes is not always the
    // noun, and a rule that swapped "Pebbles" for something would be inventing
    // half of every name. Blank falls back to `weaponName`, which is the right
    // default for a row nobody has written the second one for yet: the run is
    // captioned with a name that is at least a name.
    if ('weaponNameLaser' in row) {
      u.weaponNameLaser = String(row.weaponNameLaser ?? '').trim() || null;
    }
    if ('maxStacks' in row) u.maxStacks = parseStacks(row.maxStacks, u.id, warn);
    if ('enabled' in row) u.enabled = parseBool(row.enabled, LABEL, u.id, 'enabled', warn);
    if ('weight' in row) u.weight = parseWeight(row.weight, u.id, warn);

    if ('cardArt' in row) {
      const art = String(row.cardArt ?? '').trim();
      if (!art) u.cardArt = null;
      else if (imageKeys.includes(art)) u.cardArt = art;
      else {
        u.cardArt = null;
        warn(`[${LABEL}] "${u.id}" asks for card art "${art}", which isn't one of the level-up images — the card will use the plain background. Valid keys: ${imageKeys.join(', ')}`);
      }
    }

    // Same contract as cardArt: an unknown key falls back to the shared
    // level-up sound rather than to silence. A card that made no noise when
    // taken would read as a broken pick, and the warning is what tells you it
    // was a typo rather than a design choice.
    if ('sfx' in row) {
      const key = String(row.sfx ?? '').trim();
      if (!key) u.sfx = null;
      else if (!sfxKeys.length || sfxKeys.includes(key)) u.sfx = key;
      else {
        u.sfx = null;
        warn(`[${LABEL}] "${u.id}" asks for sound "${key}", which isn't a key in CONFIG.sfx — the card will use the standard level-up sound.`);
      }
    }
  }

  // THE OTHER HALF OF THAT JOIN, and the reason three cards carry no built-in
  // name at all any more.
  //
  // A card whose words live entirely in upgrades.csv should not ALSO carry a
  // copy of them in config.js. Two strings for one line is a pair that drifts:
  // the table is what renders, so the config.js copy is never read, never
  // reviewed, and wrong the moment the row is edited — and the only way to
  // discover that is to delete the row, which nobody does on purpose.
  //
  // So those entries state no name, and a missing row surfaces as the id
  // rather than as a blank card. Same contract as uiText's — see
  // uiTextTable.js — and for the same reason: a join that fails quietly is
  // indistinguishable from one that worked. An id on a card is ugly, which is
  // the point; `undefined` is ugly AND says nothing about which row went
  // missing.
  for (const u of upgrades) {
    const missing = [];
    if (!String(u.name ?? '').trim()) { u.name = u.id; missing.push('name'); }
    if (!String(u.desc ?? '').trim()) { u.desc = u.id; missing.push('desc'); }
    if (missing.length) {
      warn(`[${LABEL}] "${u.id}" has no ${missing.join(' or ')} — config.js states none and ${FILE} has no row supplying one. The card is showing its id.`);
    }
  }

  // A row nobody claimed is almost always a typo'd id or an upgrade that was
  // renamed in code, and it does nothing at all — so it has to be loud.
  for (const id of rows.keys()) {
    if (!seen.has(id)) {
      warn(`[${LABEL}] ${FILE} has a row for "${id}", but no upgrade with that id exists — the row is being ignored.`);
    }
  }
}

// Deal `n` distinct upgrades out of `pool`, each row's chance proportional to
// its `weight` column. This replaced a plain shuffle, under which every
// enabled upgrade was equally likely at every level — so Baby Beluga and
// Rapid Fire competed on identical terms on the very first card.
//
// Without replacement, so the three cards are always three different
// upgrades. The total is recomputed after each draw rather than sampled once,
// which is what keeps the remaining rows in their correct proportion to each
// other after one has been taken out.
//
// A weight of 0 means "never dealt" — a softer `enabled` FALSE, since the
// upgrade still exists and still shows in the Upgrades tab. If that leaves
// fewer than `n` rows with any weight, the level-up offers fewer cards. The
// one case that must not happen is offering NONE, so a pool with no positive
// weight anywhere falls back to dealing uniformly: that's a misconfigured
// file rather than an intention, and an empty level-up screen is a soft-lock.
//
// `random` is injectable so the distribution can be tested without running
// the game — it is Math.random everywhere in the real build.
export function drawUpgrades(pool, n, random = Math.random) {
  const remaining = [...pool];
  const weightOf = (u) => (typeof u.weight === 'number' && u.weight > 0 ? u.weight : 0);
  if (!remaining.some(weightOf)) {
    return remaining.sort(() => random() - 0.5).slice(0, n);
  }

  const picks = [];
  while (picks.length < n && remaining.length) {
    let total = 0;
    for (const u of remaining) total += weightOf(u);
    if (total <= 0) break; // nothing left that's willing to be offered

    // Zero-weight rows are SKIPPED rather than merely contributing nothing:
    // a random() of exactly 0 leaves `roll` at 0 from the start, and a
    // "subtract then test <= 0" walk would hand the draw to whichever row
    // came first — including one asking never to be dealt.
    let roll = random() * total;
    let idx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const w = weightOf(remaining[i]);
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) { idx = i; break; }
      idx = i; // last positive row seen, in case float drift eats the total
    }
    picks.push(remaining.splice(idx, 1)[0]);
  }
  return picks;
}
