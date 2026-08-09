// ============================================================================
// UPGRADE TABLE — the editable half of every upgrade, kept in upgrades.csv.
//
// What an upgrade DOES is code: each entry in CONFIG.upgrades carries an
// apply() function, and that can't live in a spreadsheet. Everything else
// about it — what it's called, what the card says, how far it stacks, whether
// it's offered at all, and which hex art sits behind it — is content, and
// content belongs in a table you can sort, fill down and diff.
//
// So upgrades.csv is the source of truth for those five fields. Open it in a
// spreadsheet, edit, save; the dev server reloads the page and the new values
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
//   cardArt    a key from LEVELUP_IMAGE_KEYS. Blank means the plain card.
//
// Fields deliberately NOT here: `perLevelName` and `levelDescs`, which are
// per-stack display rules on two upgrades and don't flatten into a row.
// They stay in config.js.
// ============================================================================

// A quote-aware CSV reader, because the descriptions are full of commas
// ("Chain lightning: +area, +damage, +max chain") and a naive split on ','
// would truncate half the table. Handles doubled quotes as an escaped quote
// and accepts LF or CRLF, which is what a spreadsheet export gives you.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false; // distinguishes an empty last field from end-of-row

  const endField = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  // Strip a UTF-8 BOM — Excel writes one, and it would otherwise become part
  // of the first header name, so the `id` column would never be found.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !started) { quoted = true; started = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRow(); continue; }
    field += c;
    started = true;
  }
  // A trailing newline leaves nothing pending; anything else is a final row.
  if (field !== '' || row.length) endRow();

  // Drop blank lines — a spreadsheet loves to leave a few at the bottom.
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Turn the raw grid into { id -> row object }, keyed by the header names.
export function parseUpgradeCsv(text, warn = console.warn) {
  const rows = parseCsv(text);
  if (!rows.length) {
    warn('[upgrades] upgrades.csv is empty — every upgrade keeps its config.js defaults.');
    return new Map();
  }

  const header = rows[0].map((h) => h.trim());
  const idCol = header.indexOf('id');
  if (idCol < 0) {
    warn('[upgrades] upgrades.csv has no `id` column — the file is being ignored. First row was:', header.join(','));
    return new Map();
  }

  const out = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const id = (cells[idCol] ?? '').trim();
    if (!id) {
      warn(`[upgrades] upgrades.csv row ${r + 1} has no id — skipped.`);
      continue;
    }
    if (out.has(id)) {
      warn(`[upgrades] upgrades.csv lists "${id}" more than once — row ${r + 1} wins.`);
    }
    const rec = {};
    header.forEach((key, c) => { if (key) rec[key] = cells[c] ?? ''; });
    out.set(id, rec);
  }
  return out;
}

// TRUE/FALSE as a spreadsheet writes it, plus the shapes people actually type.
// Anything unrecognised is treated as enabled and warned about, because the
// alternative — silently pulling an upgrade out of the pool over a typo — is
// the kind of bug you'd spend a play session chasing.
function parseBool(raw, id, warn) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return true;
  if (['true', 'yes', 'y', '1', 'on'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(v)) return false;
  warn(`[upgrades] "${id}" has enabled="${raw}", which isn't a yes/no value — treating it as enabled.`);
  return true;
}

function parseStacks(raw, id, warn) {
  const v = String(raw ?? '').trim();
  if (v === '') return null; // unlimited
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    warn(`[upgrades] "${id}" has maxStacks="${raw}", which isn't a number ≥ 1 — treating it as unlimited.`);
    return null;
  }
  return Math.floor(n);
}

// Write the table's fields onto the live CONFIG.upgrades entries, in place.
//
// Idempotent and reversible: every field is reset to the built-in captured in
// `base` before the row is applied, so an id that drops out of the CSV goes
// back to its config.js values instead of keeping whichever edit was last
// applied. That reversibility is the whole reason `base` is captured at boot
// rather than read back off the objects being mutated.
export function applyUpgradeTable(upgrades, base, rows, imageKeys, warn = console.warn) {
  const seen = new Set();

  for (const u of upgrades) {
    const b = base.get(u.id);
    if (b) {
      u.name = b.name;
      u.desc = b.desc;
      u.maxStacks = b.maxStacks;
      u.enabled = b.enabled;
      u.cardArt = b.cardArt;
    }

    const row = rows.get(u.id);
    if (!row) continue;
    seen.add(u.id);

    const name = (row.name ?? '').trim();
    const desc = (row.desc ?? '').trim();
    if (name) u.name = name;
    if (desc) u.desc = desc;
    if ('maxStacks' in row) u.maxStacks = parseStacks(row.maxStacks, u.id, warn);
    if ('enabled' in row) u.enabled = parseBool(row.enabled, u.id, warn);

    if ('cardArt' in row) {
      const art = String(row.cardArt ?? '').trim();
      if (!art) u.cardArt = null;
      else if (imageKeys.includes(art)) u.cardArt = art;
      else {
        u.cardArt = null;
        warn(`[upgrades] "${u.id}" asks for card art "${art}", which isn't one of the level-up images — the card will use the plain background. Valid keys: ${imageKeys.join(', ')}`);
      }
    }
  }

  // A row nobody claimed is almost always a typo'd id or an upgrade that was
  // renamed in code, and it does nothing at all — so it has to be loud.
  for (const id of rows.keys()) {
    if (!seen.has(id)) {
      warn(`[upgrades] upgrades.csv has a row for "${id}", but no upgrade with that id exists — the row is being ignored.`);
    }
  }
}
