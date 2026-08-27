// ============================================================================
// THE BRIDGE — the only thing the game can see of the shell it is running in.
//
// CommonJS, and a .cjs extension specifically: package.json says
// "type": "module", so a plain .js here would be parsed as ESM, and a
// SANDBOXED preload must be CommonJS. The failure is not a clear one — the
// preload throws before it runs, the renderer loads perfectly, and the only
// symptom is that `window.sealDesktop` is undefined, which every caller in
// path/src is written to treat as "this is a browser". So the desktop build
// would run as a slightly wrong web build and never say so.
//
// Sandboxed with contextIsolation on, which means this file can require
// exactly two things from Electron and nothing from the app. That is the point:
// the renderer runs a third-party runtime (the Spline splash) inside itself,
// and the surface it can reach into the main process should be this small.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// THE SAVE, HYDRATED BEFORE ANY PAGE SCRIPT RUNS.
//
// electron/save.js explains why the durable copy is a file. This is the half
// that makes the game none the wiser: localStorage is filled from that file
// here, in the preload, which runs before the document's own scripts.
//
// WHY THIS WORKS ACROSS contextIsolation, which is the part that looks wrong.
// Isolated worlds get separate JAVASCRIPT contexts — a prototype patched here
// is invisible to the page, which is why the snapshot below polls instead of
// hooking setItem. But localStorage is not JavaScript state, it is a per-ORIGIN
// storage area belonging to the frame, and both worlds read and write the same
// one. So a setItem here is a value the page's own localStorage.getItem finds.
// (`npm run desktop:test:save` asserts exactly this, because it is the kind of
// assumption that is either completely true or silently false.)
//
// TIMING IS THE WHOLE REASON IT IS HERE rather than in a module in path/src.
// systems/playerName.js caches the name on its first read, config.js reads
// tuning at import time, and main.js reads several more before the first frame.
// Anything that hydrated from inside the module graph would be racing modules
// that have already read an empty store — and losing that race looks like a
// player who has been renamed to Seal rather than like a bug.
// ---------------------------------------------------------------------------
try {
  // Synchronous on purpose — see the note on the handler in electron/save.js.
  const saved = ipcRenderer.sendSync('seal-save:read') ?? {};
  for (const [key, value] of Object.entries(saved)) {
    // The FILE WINS over whatever is already in this profile's localStorage.
    // That is what makes a Steam Cloud save from another machine take effect:
    // the local store is a cache of the last session on THIS machine, and the
    // file is the copy Cloud has just had the chance to replace.
    //
    // Keys absent from the file are left alone rather than cleared, so the
    // first launch after this shipped migrates an existing profile instead of
    // wiping it. The cost is that a key deleted on another machine comes back
    // here; worth revisiting if anything ever needs a real delete to sync.
    window.localStorage.setItem(key, value);
  }
} catch (err) {
  // A save that cannot be read must not stop the game booting.
  console.warn('[save] could not hydrate —', err?.message ?? err);
}

// ---------------------------------------------------------------------------
// AND SNAPSHOTTED BACK OUT.
//
// Polled rather than hooked, because of the context split above: the page's
// setItem cannot be intercepted from here. Polling is cheap enough that it does
// not matter — the seven keys are a name, some flags and a hundred-row board,
// and only a CHANGED snapshot is sent, so a quiet minute costs seven getItem
// calls a second and no IPC at all.
//
// The interval is 1s but the write is not: the main process coalesces and
// drains every 4s, so a run that ends and writes four keys at once is still one
// file write.
// ---------------------------------------------------------------------------
const SAVED_KEYS = [
  'seal-survivor-player-name',
  'sealsurvivor.settings.v1',
  'sealSurvivor.tips.v1',
  'sealSurvivor.lastRun.v1',
  'seal-survivor-buried',
  'seal-survivor-graveyard',
  'seal-survivor-leaderboard-v1',
];

let lastSent = null;

function snapshot() {
  try {
    const data = {};
    for (const key of SAVED_KEYS) {
      const value = window.localStorage.getItem(key);
      if (typeof value === 'string') data[key] = value;
    }
    const json = JSON.stringify(data);
    if (json === lastSent) return;
    lastSent = json;
    ipcRenderer.send('seal-save:write', data);
  } catch {
    // A storage area that throws is not something this can fix.
  }
}

setInterval(snapshot, 1000);
// The last word before the window goes. pagehide rather than beforeunload —
// beforeunload is unreliable and pagehide is what actually fires on a close.
window.addEventListener('pagehide', snapshot);

// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT ON THIS OBJECT.
//
// Identity only, for now. path/src/platform.js reads `isDesktop` to answer
// isDesktopShell(), and — critically — reads a SEPARATE key per capability, so
// that a shell which has not implemented something yet answers "no" rather
// than "yes, and then nothing happens".
//
// That distinction is the entire lesson of systems/nativeShare.js: on iOS,
// canShareImages() returns true the moment a native shell is detected, which
// hides the save button on the grounds that the OS sheet covers it. A shell
// that claims a capability it does not have does not merely fail to do the
// thing — it removes the fallback that would have worked.
//
// So every capability below is its OWN key, and each is present only while the
// main process really implements it. `saveImage` is here because
// electron/saveImage.js registers a handler for it; delete that handler and this
// key should go too, which is how canSaveThroughOS() would correctly go back to
// false and the score screen would keep its browser-side save path.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('sealDesktop', {
  isDesktop: true,

  /**
   * Put a PNG in front of a real save dialog. Resolves to 'saved', 'cancelled',
   * 'unavailable', or null if the main process could not do it.
   *
   * Takes bytes rather than a Blob: structured clone carries a Uint8Array over
   * the bridge intact, while a Blob would arrive as an empty object — the kind
   * of failure that writes a zero-byte file rather than throwing.
   *
   * ITS PRESENCE IS THE CAPABILITY FLAG. platform.js's canSaveThroughOS() tests
   * for this function, so deleting it is how the shell would correctly go back
   * to claiming it cannot save — see the note above about claiming capabilities
   * that do not exist.
   */
  saveImage: (bytes, name) => ipcRenderer.invoke('seal-save:image', bytes, name),

  /**
   * Steamworks, when there is any. `status()` resolves to
   * { available, status } and NEVER rejects — see electron/steam.js for why
   * "not available" is the normal case rather than an error state.
   *
   * `achieve(name)` unlocks by Steamworks API name and resolves false for
   * every kind of no. There is no achievement roster in this codebase yet:
   * the names and their conditions are Ethan's to write.
   */
  steam: {
    status: () => ipcRenderer.invoke('seal-steam:status'),
    achieve: (name) => ipcRenderer.invoke('seal-steam:achieve', name),
  },

  // The OS, for the playtest ledger's device profile. A Steam build's runs
  // come from three quite different machines (Windows, macOS, and the Deck
  // reporting as linux) and averaging them together is how a Deck-only frame
  // rate problem stays invisible.
  os: process.platform,
  electron: process.versions.electron,
});
