// ============================================================================
// THE SAVE FILE — player data as a real file in userData, for Steam Cloud.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, given localStorage already persists in Electron.
//
// It does persist — in the Chromium profile, as a LevelDB directory. Two things
// are wrong with leaving it there:
//
//   STEAM CLOUD CANNOT SYNC IT. Cloud syncs files matched by a path glob and
//   copies them between machines. Handing it a live LevelDB that Chromium has
//   open, with its own log and manifest files, is how you get a corrupt profile
//   on the machine that receives it rather than a synced save.
//
//   IT IS KEYED TO THE ORIGIN. localStorage is partitioned by origin, and the
//   game is served from app://seal. Change that string in any later release —
//   a rename, a scheme collision, a decision to serve from a different host —
//   and every player's name, graveyard, settings and progress is gone, with no
//   error and no way back. A file in userData does not care what the page was
//   served from.
//
// SO THE FILE IS THE DURABLE COPY and localStorage is the working copy. The
// game keeps using localStorage exactly as it does in a browser — synchronous,
// already wrapped in try/catch at every call site — and nothing in path/src
// knows this file exists. That is the point: no save-path branch to get wrong,
// and the web build stays the reference implementation.
// ---------------------------------------------------------------------------

import { app, ipcMain } from 'electron';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// WHAT IS A SAVE AND WHAT IS NOT.
//
// An allowlist, never a blanket copy of localStorage. Three of the keys the
// game writes would actively cause harm in a synced file:
//
//   deep-run-tuning-v2            the tuning snapshot. Hundreds of KB, it is
//                                 authoring state rather than play state, and
//                                 CONFIG already merges it from disk in dev.
//   seal-survivor-playtest-client the machine's analytics identity. Syncing it
//                                 would fuse two machines' runs into one
//                                 client, which is the exact confusion the
//                                 `native` field in the device profile exists
//                                 to prevent.
//   seal-survivor-crash-beacon    a "did the last boot survive" flag. It is a
//                                 fact about THIS machine's last launch; a
//                                 beacon arriving from another one would have
//                                 the game reporting a crash that never
//                                 happened here.
//
// The rest are dev-panel UI state (which tuner groups were open, whether the
// text specimen was showing, the splash audition switch) and simply do not
// belong in a player's cloud save.
//
// Adding a key here is the whole job of making something survive a reinstall.
// ---------------------------------------------------------------------------
export const SAVED_KEYS = [
  'seal-survivor-player-name',      // systems/playerName.js
  'sealsurvivor.settings.v1',       // systems/settings.js — volume, binds, quality
  'sealSurvivor.tips.v1',           // systems/tutorial.js — which tips are done
  'sealSurvivor.lastRun.v1',        // systems/lastRun.js
  'seal-survivor-buried',           // systems/nameLedger.js — death is permanent
  'seal-survivor-graveyard',        // systems/graveyardStore.js
  'seal-survivor-leaderboard-v1',   // systems/leaderboard.js — the local board
];

// A version on the file rather than in the filename. A future migration needs
// to READ the old shape to convert it, which a bumped filename makes harder
// rather than easier — and Steam Cloud would then be syncing two files, one of
// them dead.
const VERSION = 1;

export function savePath() {
  return join(app.getPath('userData'), 'save.json');
}

/**
 * The saved state, or an empty object if there is nothing readable.
 *
 * NEVER THROWS. A corrupt save must cost the player their progress at worst,
 * not the ability to launch the game — and a JSON parse error on a file Steam
 * Cloud was mid-way through replacing is a real thing that happens.
 */
export function readSave() {
  const file = savePath();
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const data = parsed.data;
    if (!data || typeof data !== 'object') return {};
    // Filtered on the way IN as well as on the way out. A file that has been
    // hand-edited, or written by a future version with more keys in it, must
    // not be able to inject arbitrary localStorage entries into the page.
    const out = {};
    for (const key of SAVED_KEYS) {
      if (typeof data[key] === 'string') out[key] = data[key];
    }
    return out;
  } catch (err) {
    console.warn(`[save] could not read ${file} — ${err?.message ?? err}`);
    return {};
  }
}

/**
 * Write the save, atomically.
 *
 * THE TEMP-FILE DANCE IS NOT OPTIONAL. This file holds a graveyard that the
 * game treats as permanent — systems/nameLedger.js will not let a buried seal
 * come back — so a half-written file is not a lost preference, it is a player's
 * history replaced by a syntax error. Writing beside it and renaming means the
 * old save survives every failure mode except a disk that is already gone;
 * rename is atomic on both APFS and NTFS.
 */
export function writeSave(data) {
  const file = savePath();
  const tmp = `${file}.tmp`;
  const clean = {};
  for (const key of SAVED_KEYS) {
    if (typeof data?.[key] === 'string') clean[key] = data[key];
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ version: VERSION, data: clean }, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[save] could not write ${file} — ${err?.message ?? err}`);
    return false;
  }
}

// The last snapshot the renderer sent, kept so a quit can flush it without
// having to ask a window that may already be closing.
let pending = null;

/** Write whatever the renderer last reported, if it has not been written yet. */
export function flush() {
  if (!pending) return false;
  const data = pending;
  pending = null;
  return writeSave(data);
}

export function registerSaveIpc() {
  // SYNCHRONOUS, deliberately. The preload hydrates localStorage from this
  // before any page script runs, and an async answer would arrive after the
  // game had already read an empty store and cached the result — playerName.js
  // caches on first read, so the player would be called Seal for the rest of
  // the session while the file on disk said otherwise.
  ipcMain.on('seal-save:read', (event) => {
    event.returnValue = readSave();
  });

  ipcMain.on('seal-save:write', (_event, data) => {
    // Held rather than written immediately: the renderer only sends when
    // something actually changed, but a run end can change four keys in the
    // same tick. Coalescing here means one file write instead of four.
    pending = data;
  });

  // A steady drain, so a crash loses at most this much rather than the session.
  setInterval(flush, 4000).unref();

  app.on('before-quit', flush);
}
