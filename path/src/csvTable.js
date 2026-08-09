// ============================================================================
// CSV TABLES — the shared half of every spreadsheet-backed table in the game.
//
// This file knows nothing about upgrades or creatures. It reads a CSV into
// { id -> row } and turns individual cells into values, and that is all; what
// a column MEANS belongs to upgradeTable.js / enemyTable.js beside the thing
// it configures.
//
// It exists because the second table wanted every line of the first one's
// reader. Two copies of a quote-aware CSV parser is two places for the Excel
// BOM handling to be got right, and only one of them would have been.
// ============================================================================

// A quote-aware CSV reader, because the cells are full of commas (an upgrade
// description like "Chain lightning: +area, +damage" or any spreadsheet's idea
// of a decimal) and a naive split on ',' would truncate half the table.
// Handles doubled quotes as an escaped quote and accepts LF or CRLF, which is
// what a spreadsheet export gives you.
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
// `label` is the tag every message is prefixed with, so a warning says which
// file it came from without the caller having to format one.
export function parseIdTable(text, label, file, warn = console.warn) {
  const rows = parseCsv(text);
  if (!rows.length) {
    warn(`[${label}] ${file} is empty — every row keeps its config.js defaults.`);
    return new Map();
  }

  const header = rows[0].map((h) => h.trim());
  const idCol = header.indexOf('id');
  if (idCol < 0) {
    warn(`[${label}] ${file} has no \`id\` column — the file is being ignored. First row was:`, header.join(','));
    return new Map();
  }

  const out = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const id = (cells[idCol] ?? '').trim();
    if (!id) {
      warn(`[${label}] ${file} row ${r + 1} has no id — skipped.`);
      continue;
    }
    if (out.has(id)) {
      warn(`[${label}] ${file} lists "${id}" more than once — row ${r + 1} wins.`);
    }
    const rec = {};
    header.forEach((key, c) => { if (key) rec[key] = cells[c] ?? ''; });
    out.set(id, rec);
  }
  return out;
}

// TRUE/FALSE as a spreadsheet writes it, plus the shapes people actually type.
// Anything unrecognised is treated as enabled and warned about, because the
// alternative — silently pulling a row out of the game over a typo — is the
// kind of bug you'd spend a play session chasing.
export function parseBool(raw, label, id, field, warn) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return true;
  if (['true', 'yes', 'y', '1', 'on'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(v)) return false;
  warn(`[${label}] "${id}" has ${field}="${raw}", which isn't a yes/no value — treating it as true.`);
  return true;
}

// A number, or one of two kinds of "no number", which the callers tell apart:
//   undefined  the cell was blank
//   null       the cell had something in it that isn't a number
// Blank is a legitimate value in these tables (it means "this row doesn't have
// this field"), whereas a typo must never be read as one — so they cannot
// collapse into the same answer here, however tempting.
export function parseNumber(raw, label, id, field, warn, { min = -Infinity, integer = false } = {}) {
  const v = String(raw ?? '').trim();
  if (v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    warn(`[${label}] "${id}" has ${field}="${raw}", which isn't a number${min > -Infinity ? ` ≥ ${min}` : ''} — the cell is being ignored.`);
    return null;
  }
  return integer ? Math.floor(n) : n;
}
