#!/usr/bin/env node
// ============================================================================
// WETRIS'S LIVE TUNING LOOP — sealitaire-tune.mjs's loop, for rive/wetris.
//
// A Rive script cannot write a file, so the loop is closed from outside
// through the one channel a script has, the console:
//
//   rive/wetris/tuning.luau    the rows — key, range, value. Source of truth.
//        │  npm run wetris
//        ▼
//   the live window            T (or click the score) opens the panel; drag
//                              knobs, the board applies them next frame
//        │  press SAVE → the script prints one line:
//        │    TUNING-SAVE key=value key=value ...
//        ▼
//   this tool                  owns the `rive` watcher, reads its output and
//                              writes each value back into tuning.luau's
//                              `value =`, touching nothing else in the file;
//                              the watcher sees the change and rebuilds, so
//                              the next launch starts where you left it.
//
//   node tools/wetris-tune.mjs             the viewer with the save loop
//   node tools/wetris-tune.mjs save k=v …  the same write, for a line copied
//                                          out of a headless run's console
//
// ONE VIEWER AT A TIME, for sealitaire's reason: the viewer is a WRITER, and
// two of them are two snapshots of tuning.luau where the second SAVE wins.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'rive/wetris');
const TUNING = join(PROJECT, 'tuning.luau');
const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');

/** Write key=value pairs into tuning.luau's rows; returns how many moved. */
export function save(pairs) {
  const before = readFileSync(TUNING, 'utf8');
  let src = before;
  let changed = 0;
  for (const [key, value] of pairs) {
    const re = new RegExp(`(\\{\\s*key\\s*=\\s*'${key}'\\s*,[^}]*?value\\s*=\\s*)([-\\d.eE]+)`);
    src = src.replace(re, (all, head, old) => {
      if (+old !== +value) changed++;
      return head + value;
    });
  }
  // A write is a rebuild, and a rebuild restarts the game under you: only
  // when a value actually moved.
  if (src !== before) writeFileSync(TUNING, src);
  return changed;
}

// THE EXIT CODE A SECOND VIEWER LEAVES WITH, named because two files read it:
// this one raises it, and tools/game-app.mjs turns it into a dialog rather
// than a Dock icon that bounces once and vanishes. Same value and same meaning
// as sealitaire's, since it is the same refusal.
export const BUSY = 3;

/** The pid of a viewer already open on this project, or 0. Anchored, so a
 *  grep or an editor that merely mentions the path does not count. */
export function boardOpen() {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', `^${RIVE} ${PROJECT}`], { encoding: 'utf8' });
    return Number(out.trim().split('\n')[0]) || 0;
  } catch {
    return 0;
  }
}

function run() {
  if (boardOpen()) {
    process.stderr.write('\n[tune] a viewer is already open on rive/wetris.\n'
      + '       Close that window first — a second one would overwrite its\n'
      + '       tuning the next time you press SAVE.\n\n');
    process.exit(BUSY);
  }
  const child = spawn(RIVE, [PROJECT], { stdio: ['inherit', 'pipe', 'pipe'] });
  let buf = '';
  const onChunk = (chunk, stream) => {
    stream.write(chunk);
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const at = line.indexOf('TUNING-SAVE ');
      if (at < 0) continue;
      // The CLI echoes every print a second time as a `console` line; one
      // save, one write.
      if (/\bconsole\s+\S+:\d+/.test(line.slice(0, at))) continue;
      const pairs = line.slice(at + 'TUNING-SAVE '.length).trim().split(/\s+/)
        .map((kv) => kv.split('='))
        .filter((kv) => kv.length === 2 && kv[0] && Number.isFinite(+kv[1]));
      const changed = save(pairs);
      process.stderr.write(changed > 0
        ? `\n[tune] saved ${changed} changed value${changed === 1 ? '' : 's'} to rive/wetris/tuning.luau; the watcher rebuilds\n`
        : '\n[tune] nothing changed since the last save\n');
    }
  };
  child.stdout.on('data', (c) => onChunk(c, process.stdout));
  child.stderr.on('data', (c) => onChunk(c, process.stderr));
  child.on('exit', (code) => process.exit(code ?? 0));
}

const cmd = process.argv[1] === fileURLToPath(import.meta.url) ? (process.argv[2] ?? 'run') : null;
if (cmd === null) { /* imported */ }
else if (cmd === 'run') run();
else if (cmd === 'save') {
  const pairs = process.argv.slice(3).map((kv) => kv.split('=')).filter((kv) => kv.length === 2);
  console.log(`saved ${pairs.length} values (${save(pairs)} changed)`);
} else {
  console.error('usage: wetris-tune.mjs [run] | save key=value ...');
  process.exit(2);
}
