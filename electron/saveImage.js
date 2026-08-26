// ============================================================================
// HANDING A PICTURE TO THE PLAYER — the desktop route out for a kill shot or a
// run sheet.
//
// ---------------------------------------------------------------------------
// THE THREE ROUTES, AND WHY DESKTOP NEEDS ITS OWN.
//
// systems/bossShot.js has two already: the iOS share sheet through Capacitor,
// and navigator.share in a browser. This shell has NEITHER — measured, not
// assumed: `npm run desktop:test:shell` asks the page directly and Electron
// reports navigator.share and navigator.canShare as undefined.
//
// So without this, every route falls through to download(), which mints a
// blob: URL and clicks an anchor. That does work here — Chromium writes it to
// the default download directory — but it produces a game where a button
// labelled Share silently saves a file somewhere the player did not choose,
// and the status line then says "Saved to your downloads". Not broken, exactly.
// Just quietly not what the button said.
//
// A REAL SAVE DIALOG IS THE DESKTOP-NATIVE ANSWER: the player picks the folder
// and the name, and the outcome is unambiguous — a path, or a cancel.
//
// THE CAPABILITY IS ADVERTISED SEPARATELY from the platform. platform.js reads
// `sealDesktop.saveImage` rather than `sealDesktop.isDesktop` to answer
// canSaveThroughOS(), so a shell that has not wired this up yet answers "no"
// and the browser download path stays. That is the lesson of canShareImages()
// on iOS: a shell that CLAIMS a capability it does not have does not merely
// fail, it removes the fallback that would have worked.
// ---------------------------------------------------------------------------

import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// A kill shot is ~1.5MB and the eight-frame sheet a few times that. This is far
// above either and still bounded, so a malformed call cannot ask the main
// process to buffer something absurd.
const MAX_BYTES = 64 * 1024 * 1024;

/** Strip any path the renderer sent; only a bare filename is ever used. */
function safeName(raw) {
  const name = basename(String(raw ?? '')).replace(/[^\w.-]+/g, '_');
  if (!name || name.startsWith('.')) return 'seal-survivor.png';
  return name.toLowerCase().endsWith('.png') ? name : `${name}.png`;
}

export function registerSaveImageIpc() {
  ipcMain.handle('seal-save:image', async (event, bytes, name) => {
    try {
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return 'unavailable';
      if (bytes.byteLength > MAX_BYTES) return 'unavailable';

      const win = BrowserWindow.fromWebContents(event.sender);
      const suggested = safeName(name);

      // Modal to the game window where there is one. A save dialog that can be
      // lost behind a fullscreen game is a game that looks frozen.
      const options = {
        defaultPath: join(app.getPath('pictures'), suggested),
        filters: [{ name: 'PNG', extensions: ['png'] }],
      };
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);

      // A cancel is NOT a failure and must be reported as its own outcome. The
      // callers treat anything falsy as "try the next route", so returning
      // nothing here would hand the player a second, unasked-for copy of the
      // picture through the browser download path — which is the exact bug the
      // AbortError check in bossShot.js exists to prevent on the web.
      if (canceled || !filePath) return 'cancelled';

      await writeFile(filePath, bytes);
      return 'saved';
    } catch (err) {
      console.warn('[saveImage] could not save —', err?.message ?? err);
      return null;
    }
  });
}
