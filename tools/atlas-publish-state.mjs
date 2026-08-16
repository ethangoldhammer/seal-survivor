#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Has the atlas been published in its current form?
//
//   node tools/atlas-publish-state.mjs --check   -> prints STALE or CURRENT
//   node tools/atlas-publish-state.mjs --mark    -> records the current file as published
//
// WHY THIS EXISTS. The refresh routine republishes the atlas to a fixed
// artifact URL. Its first version only republished when the pull returned new
// runs, which is right on a quiet day and WRONG the day after anything goes
// wrong: if a republish fails — a permission prompt the run stalled on, a
// network blip, a session that ended early — the page on the URL is now behind
// the file on disk, and no later run notices. The next quiet day skips, and the
// drift is permanent and silent. That is exactly what happened on 2026-08-16:
// the runs were pulled and the page regenerated at 19:45, and the URL went on
// serving a snapshot from hours earlier.
//
// So the condition to republish is NOT "did new runs arrive". It is "does the
// published page differ from the file on disk", which is true after new runs,
// after a failed publish, after a generator change, and after a hand
// regeneration — and false otherwise. One check covers all four, and the
// routine becomes self-healing rather than fire-and-forget.
//
// HASHING THE PAGE, NOT THE INPUTS. The rendered HTML is what actually gets
// published, so it is the honest thing to compare. That only works because the
// generator is deterministic: the atlas has no build timestamp baked into it —
// the date in the header is computed by the page's own script at VIEW time
// (see `#stamp-date`), not written in at generation. If a generated-at stamp is
// ever added to the markup, this file starts reporting STALE on every run and
// the routine republishes daily for no reason; hash the source logs instead if
// that day comes.
//
// The marker is only written AFTER a publish is confirmed, which is the whole
// mechanism: a failed publish leaves it stale, so the next run retries by
// itself. Writing it any earlier — say, alongside the regenerate — would record
// an intention rather than a fact and would reintroduce exactly the silent
// drift this exists to end.
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS = resolve(ROOT, 'playtest/atlas.html');
// Alongside playtest/remote.jsonl.state.json, and gitignored with the rest of
// /playtest/ — this is local bookkeeping about one machine's publishes, not
// something another clone could ever be right about.
const MARKER = resolve(ROOT, 'playtest/atlas.html.published.json');

async function hashAtlas() {
  const buf = await readFile(ATLAS);
  return { hash: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

async function readMarker() {
  try {
    return JSON.parse(await readFile(MARKER, 'utf8'));
  } catch {
    return null;
  }
}

const mode = process.argv.includes('--mark') ? 'mark'
  : process.argv.includes('--check') ? 'check'
  : null;

if (!mode) {
  console.error('usage: atlas-publish-state.mjs --check | --mark');
  process.exit(2);
}

let atlas;
try {
  atlas = await hashAtlas();
} catch (err) {
  if (err.code === 'ENOENT') {
    // No page at all. Not an error worth a non-zero exit — the routine runs
    // the generator before this, so the honest reading is "nothing to publish".
    console.log('MISSING  playtest/atlas.html does not exist — run `npm run playtest:atlas -- --local` first.');
    process.exit(0);
  }
  throw err;
}

if (mode === 'mark') {
  await writeFile(MARKER, `${JSON.stringify({
    hash: atlas.hash,
    bytes: atlas.bytes,
    publishedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  console.log(`MARKED   ${atlas.bytes.toLocaleString()} bytes recorded as published.`);
  process.exit(0);
}

const marker = await readMarker();
if (!marker) {
  console.log(`STALE    never published from this machine (${atlas.bytes.toLocaleString()} bytes).`);
} else if (marker.hash !== atlas.hash) {
  const delta = atlas.bytes - (marker.bytes ?? 0);
  const sign = delta >= 0 ? '+' : '';
  console.log(`STALE    page changed since the last publish (${sign}${delta.toLocaleString()} bytes, last published ${marker.publishedAt ?? 'unknown'}).`);
} else {
  console.log(`CURRENT  published page matches the file on disk (${atlas.bytes.toLocaleString()} bytes, ${marker.publishedAt}).`);
}
