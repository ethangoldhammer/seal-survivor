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
  createWindow();

  // macOS keeps the process alive with no windows; clicking the dock icon is
  // expected to bring one back.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
