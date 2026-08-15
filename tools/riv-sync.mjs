#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run riv              copy the latest Rive export into the game, once
// npm run riv -- --watch   ...and keep doing it, every time you re-export
// npm run riv -- --check   validate both copies, change nothing
//
// WHERE THE FILE LIVES, and why there are two of them.
//
//   ~/Documents/_DesignSystems/SealSurvivor/RIV/seal_survivor.riv   what Rive writes
//   path/src/ui/seal_survivor.riv                                  what the GAME reads
//
// The second one is the only copy that matters at runtime: ui/riveSplash.js and
// ui/bossBarRive.js import it `?url`, so Vite hashes it into the bundle and
// deploys it. Nothing in the build ever looks at Documents. Which means a
// re-export that isn't copied across is invisible — the game keeps shipping the
// old artwork, and the editor keeps showing the new, and both look right.
//
// That already happened twice in one evening, so: this.
//
// IT ALSO VALIDATES, and that is the more useful half. The game depends on
// three names inside a binary it does not author — an artboard for the splash,
// an artboard for the boss bar, and three data-binding properties. Rename any
// of them in the editor and nothing fails to compile; the splash comes up blank
// or the health bar never moves. Those names are declared once, in
// ui/riveContract.js, and this refuses to install an export that has stopped
// containing them.
//
// The check is a SCAN FOR NAME STRINGS, not a parse of the format. Rive stores
// artboard and property names as plain strings in the file, so this is exact
// about the failure it is built for (a rename, a missing binding, an export of
// the wrong file) and says nothing about anything else — it cannot tell you the
// artboard still LOOKS right. Full inspection needs the runtime and a canvas;
// npm run test:bossbar covers the wiring, and the browser is the only place the
// artwork itself can be judged.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_RIV = resolve(here, '../path/src/ui/seal_survivor.riv');
const DEFAULT_SRC = resolve(homedir(), 'Documents/_DesignSystems/SealSurvivor/RIV/seal_survivor.riv');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const WATCH = has('--watch');
const CHECK = has('--check');
const FORCE = has('--force');
const QUIET = has('--quiet');
// A path as the first bare argument, or RIV_SRC, or the usual place.
const SRC = resolve(argv.find((a) => !a.startsWith('-')) ?? process.env.RIV_SRC ?? DEFAULT_SRC);

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const say = (...a) => { if (!QUIET) console.log(...a); };

// The contract, read from the module the GAME reads, so the two cannot drift.
// Imported with a plain dynamic import — riveContract.js has no imports of its
// own precisely so this works with no loader, no config and no bundler.
const { riveRequirements } = await import('../path/src/ui/riveContract.js');

// The boss artboard can be overridden in config. Read if it is cheap to; the
// contract's default is what ships, and a tool that dragged in the whole config
// (and its CSVs, and its saved tuning) to learn one string would be a tool that
// breaks whenever the config does.
const REQUIRED = riveRequirements();

const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12);

/**
 * Which of the required names are actually in this file.
 *
 * Latin-1 rather than utf-8: the names are ASCII and the rest of the file is
 * arbitrary binary, which utf-8 decoding mangles into replacement characters —
 * and can mangle a byte that is part of a name it is looking for.
 */
function inspect(buf) {
  const text = buf.toString('latin1');
  const found = {};
  for (const name of [...REQUIRED.artboards, ...REQUIRED.bindings]) {
    found[name] = text.includes(name);
  }
  return found;
}

function report(found) {
  const missing = Object.entries(found).filter(([, ok]) => !ok).map(([n]) => n);
  for (const [name, ok] of Object.entries(found)) {
    const kind = REQUIRED.artboards.includes(name) ? 'artboard' : 'binding';
    say(`   ${ok ? C.ok('✓') : C.bad('✗')} ${kind.padEnd(8)} ${name}`);
  }
  return missing;
}

function describe(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const st = statSync(path);
  return { buf, hash: sha(buf), bytes: st.size, mtime: st.mtime };
}

function syncOnce({ announceNoop = true } = {}) {
  const src = describe(SRC);
  if (!src) {
    console.error(C.bad(`\n  No Rive export at:\n    ${SRC}\n`));
    console.error(C.dim('  Pass a path, or set RIV_SRC, if you export somewhere else:'));
    console.error(C.dim('    npm run riv -- /path/to/seal_survivor.riv\n'));
    return { ok: false, changed: false };
  }
  const dst = describe(REPO_RIV);

  if (dst && dst.hash === src.hash) {
    if (announceNoop) {
      say(`\n  ${C.ok('Already up to date')} ${C.dim(`— ${src.hash}, ${(src.bytes / 1024).toFixed(0)}KB`)}`);
      const missing = report(inspect(src.buf));
      if (missing.length) say(`\n  ${C.warn('...but the shipped copy is missing:')} ${missing.join(', ')}\n`);
      else say('');
    }
    return { ok: true, changed: false };
  }

  say(`\n  ${C.b('New export')} ${C.dim(src.mtime.toLocaleString())}`);
  say(`   ${C.dim('from')} ${SRC}`);
  say(`   ${C.dim('into')} ${REPO_RIV}`);
  say(`   ${C.dim(`${dst ? `${dst.hash} → ` : ''}${src.hash}   ${(src.bytes / 1024).toFixed(0)}KB`)}\n`);

  const found = inspect(src.buf);
  const missing = report(found);

  if (missing.length && !FORCE) {
    console.error(`\n  ${C.bad('NOT COPIED.')} This export is missing ${missing.length} name(s) the game needs:`);
    console.error(`    ${missing.join(', ')}`);
    console.error(C.dim('\n  Most likely an artboard or a binding was renamed in the editor, or this'));
    console.error(C.dim('  is an export of a different file. The game would fall back to the coded'));
    console.error(C.dim('  health bar and a blank splash rather than crash, which is exactly the'));
    console.error(C.dim('  kind of failure nobody notices for a week.'));
    console.error(C.dim('\n  Fix the names in Rive and re-export, or --force to install it anyway.\n'));
    return { ok: false, changed: false };
  }

  if (CHECK) {
    say(`  ${C.warn('--check: not copied.')} The export is valid and would install cleanly.\n`);
    return { ok: true, changed: false };
  }

  copyFileSync(SRC, REPO_RIV);
  // What the export gained or lost, by name, against the copy being replaced.
  // A new artboard or a dropped binding is the single most useful thing to know
  // about a re-export, and the only one visible without opening it.
  if (dst) {
    const was = inspect(dst.buf);
    const gained = Object.keys(found).filter((n) => found[n] && !was[n]);
    const lost = Object.keys(found).filter((n) => !found[n] && was[n]);
    if (gained.length) say(`\n  ${C.ok('gained')} ${gained.join(', ')}`);
    if (lost.length) say(`  ${C.warn('lost')} ${lost.join(', ')}`);
  }
  say(`\n  ${C.ok('Copied.')} ${C.dim('A running dev server picks it up on its own; a built bundle needs npm run build.')}\n`);
  return { ok: true, changed: true };
}

if (!WATCH) {
  const { ok } = syncOnce();
  process.exit(ok ? 0 : 1);
}

// --- watch -----------------------------------------------------------------
// POLLED, not fs.watch. Rive writes an export by replacing the file, and every
// editor and OS does that differently — some write in place, some write a temp
// file and rename, and a rename fires events fs.watch reports against a path
// that no longer refers to the same inode. Polling a hash is slower to notice
// and impossible to get wrong, and half a second of latency does not matter for
// something a human triggers by hand.
say(`\n  ${C.b('Watching for re-exports')} ${C.dim('— ctrl-C to stop')}`);
say(`   ${C.dim(SRC)}\n`);
syncOnce({ announceNoop: false });
let last = describe(SRC)?.hash ?? null;
setInterval(() => {
  const now = describe(SRC);
  if (!now || now.hash === last) return;
  last = now.hash;
  syncOnce({ announceNoop: false });
}, 500);
