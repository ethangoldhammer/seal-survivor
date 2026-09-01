// ============================================================================
// THE RUN LOG — a finished run as a line in userData, so `npm run perf` has
// something to read about the desktop build.
//
// ---------------------------------------------------------------------------
// WHY THE DESKTOP BUILD FILED NOTHING AT ALL.
//
// systems/playtest.js has three destinations for a finished run, and a packaged
// app could reach none of them:
//
//   localStorage          it does write here, and always did. But it is only
//                         readable by opening devtools on the running window,
//                         which is precisely the thing the recorder exists to
//                         avoid — "142ms at 1:12" is worth having the morning
//                         after, from a terminal, without having been sat in
//                         front of the machine when it happened.
//   playtest/runs.jsonl   written by a Vite middleware declared `apply: 'serve'`.
//                         There is no dev server behind a packaged app, so the
//                         POST to /__playtest resolves against app://seal and
//                         404s.
//   the collection worker keyed on VITE_PLAYTEST_URL, which is the DEPLOYED
//                         build's setting. Pointing the desktop build at it
//                         would file our own runs into the shared record of
//                         what other people played — the one thing that would
//                         make that aggregate untrustworthy, and the same
//                         reason dev runs are excluded from it.
//
// So a desktop run was recorded, aggregated, bucketed, and then dropped. The
// report could never contain a row for the .app, which left the question it
// exists to answer — is the desktop build hitching more than the browser, or
// the same amount — with no evidence on either side.
//
// ---------------------------------------------------------------------------
// A FILE, NEXT TO save.json, AND NOT IN THE CLOUD GLOB.
//
// userData because that is the one directory that survives a rebuild, a
// reinstall and a version bump. But this is developer telemetry, not player
// data: it must never be added to the Steam Cloud path glob that save.json
// belongs to, or every machine would download every other machine's frame
// times and `npm run perf` would stop describing any device that exists — the
// same confusion the `shell` field in the device profile was added to prevent.
//
// It is never transmitted anywhere. It is a local file, bounded below, that
// exists to be read by a person on this machine.
// ============================================================================

import { app, ipcMain } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The log is append-only and a run is a couple of KB, so left alone this grows
// forever on a player's disk. Bounded here rather than by pruning old lines on
// a schedule: the cap is the only thing that has to be right, and a size check
// before an append costs one stat.
//
// 8MB is roughly four thousand runs at the measured 2.2KB median. Nobody will
// reach it; the point is that it cannot run away.
export const MAX_BYTES = 8 * 1024 * 1024;
// What survives a trim. Well below the cap on purpose — trimming back to just
// under it would mean re-reading and rewriting the whole file every few runs
// forever, where this pays that cost once per quarter of the log.
export const KEEP_BYTES = 6 * 1024 * 1024;

// A single record, generously. Real ones sit under 19KB (the recorder folds
// everything into 30-second buckets), and the web path is capped harder still
// by fetch's 64KB keepalive limit. This is here so a future accumulator that
// started logging events instead of aggregating them fails loudly on the first
// run rather than filling the disk quietly.
export const MAX_RECORD_BYTES = 1024 * 1024;

export function playtestPath() {
  return join(app.getPath('userData'), 'playtest.jsonl');
}

/**
 * Drop the oldest runs if the log has outgrown its cap.
 *
 * Cuts on a LINE boundary, which is the whole reason this reads the file rather
 * than truncating it: a byte-offset cut lands mid-record and leaves a fragment
 * that `perf-runs.mjs` reports as "a malformed line" on every future run — a
 * permanent warning about a file that is actually fine.
 *
 * Written beside and renamed, like save.js, so an interrupted trim leaves the
 * old log rather than half of one.
 */
function trim(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return; // No file yet. Nothing to trim, and the append will create it.
  }
  if (size <= MAX_BYTES) return;

  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let kept = [];
  let bytes = 0;
  // From the newest backwards, so what survives is the recent history.
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += lines[i].length + 1;
    if (bytes > KEEP_BYTES) break;
    kept.push(lines[i]);
  }
  kept = kept.reverse();

  const tmp = `${file}.tmp`;
  writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  renameSync(tmp, file);
  console.log(`[playtest] trimmed the run log to the last ${kept.length} runs`);
}

/**
 * Append one finished run.
 *
 * TAKES THE JSON TEXT, NOT THE OBJECT. The renderer has already serialised the
 * record for its other two destinations, and sending the same string means the
 * bytes on disk are the bytes the collection worker would have received —
 * identical records, comparable reports. Sending the object instead would put a
 * structured clone in the path, which silently drops `undefined` and turns
 * Infinity into null: a record that differs from every other copy of itself in
 * ways nothing would ever surface.
 *
 * @returns true once the line is on disk. Never throws — a recorder that could
 *   take the game down would be worse than one that loses a run.
 */
export function fileRun(json) {
  if (typeof json !== 'string' || !json) return false;
  if (json.length > MAX_RECORD_BYTES) {
    console.warn(`[playtest] run of ${(json.length / 1024).toFixed(0)}KB is over the ${MAX_RECORD_BYTES / 1024}KB cap — not filed`);
    return false;
  }
  // Parsed only to VALIDATE, never to re-serialise. A line this file cannot
  // parse is a line perf-runs.mjs would warn about forever, so it is refused
  // here where the refusal is visible.
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  } catch {
    return false;
  }

  const file = playtestPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    trim(file);
    // JSON.stringify escapes every newline inside a string, so a record is
    // always exactly one line and JSONL stays parseable line by line.
    appendFileSync(file, `${json}\n`);
    return true;
  } catch (err) {
    console.warn(`[playtest] could not write ${file} — ${err?.message ?? err}`);
    return false;
  }
}

export function registerPlaytestIpc() {
  ipcMain.handle('seal-playtest:file', (_event, json) => fileRun(json));
}
