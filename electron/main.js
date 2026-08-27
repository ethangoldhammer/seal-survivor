// ============================================================================
// THE DESKTOP SHELL — the Electron main process, for the Steam build.
//
// The serving half lives in serve.js, which is where the reasoning about the
// custom scheme is written down. This file is the window and the process
// lifecycle, and nothing else.
// ============================================================================

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ORIGIN, registerScheme, serve } from './serve.js';
import { registerSaveIpc, flush } from './save.js';
import { registerSaveImageIpc } from './saveImage.js';
import { initSteam, registerSteamIpc, steamStatus } from './steam.js';

// Before whenReady, necessarily — see registerScheme's note.
registerScheme();

function createWindow() {
  const win = new BrowserWindow({
    // The Steam Deck's native resolution, as the default rather than as a
    // special case: it is the smallest screen this build has to look right on,
    // so it is the one worth being correct by default.
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    // Matches index.html's own background and capacitor.config.json's. Without
    // it the window paints white for a frame or two before the page's own
    // background lands, which on a game this dark reads as a flash of damage.
    backgroundColor: '#05060a',
    // Shown on ready-to-show rather than immediately, for the same reason: an
    // empty window that appears and then fills is worse than one that appears
    // already full.
    show: false,
    webPreferences: {
      preload: join(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(`${ORIGIN}/`);

  // EXTERNAL LINKS GO TO THE SYSTEM BROWSER, never into the game window.
  //
  // ui/tipJar.js opens https://ko-fi.com/hammeredgold, and the share text in
  // systems/bossShot.js carries a URL too. Left alone, a click on one of those
  // would navigate the game window itself to Ko-fi — with no address bar, no
  // back button and no way out short of quitting. Under Steam, where the
  // overlay browser does not hook this window either, that is a dead end.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN)) return;
    event.preventDefault();
    if (isWeb(url)) shell.openExternal(url);
  });

  return win;
}

// Only http(s) is handed to the OS. shell.openExternal will cheerfully open a
// file:// path or a registered custom scheme, so passing it an arbitrary string
// from the page would be a way to launch things — the check is what keeps this
// to "opens a link in a browser".
function isWeb(url) {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  serve();
  // Registered before the window, because the preload hydrates localStorage
  // through this the moment the page starts loading — a handler installed
  // after createWindow() is a race that would resolve differently on a fast
  // machine than on a slow one.
  registerSaveIpc();
  registerSaveImageIpc();
  registerSteamIpc();
  createWindow();

  // NOT AWAITED. Steamworks comes up in its own time and the game must not wait
  // for it — a player with no Steam client running would otherwise pay that
  // timeout on every launch, staring at nothing. Everything downstream already
  // treats "not available" as the normal case, so a late yes costs nothing and
  // a never costs nothing either.
  initSteam().then((ok) => console.log(`[steam] ${ok ? 'ready' : steamStatus()}`));

  // macOS keeps the process alive with no windows; clicking the dock icon is
  // expected to bring one back.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Flushed HERE as well as on before-quit. On macOS closing the last window
  // does not quit, so before-quit may not fire for a long time — or at all, if
  // the process is later killed — and the last thing the player did before
  // closing the window is exactly the thing they would expect to have been
  // saved.
  flush();
  if (process.platform !== 'darwin') app.quit();
});
