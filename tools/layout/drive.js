// ---------------------------------------------------------------------------
// THE DRIVER — an Electron main process that opens the audit page and holds it
// open until the sweep has reported.
//
// WHY THIS EXISTS. tools/layout-audit.mjs used to print a URL and block on
// `waiting for the page to report…` forever, because the measuring happens in a
// layout engine and there is no layout engine in Node. That is still true and
// is not the part that was wrong. What was wrong is that the waiting had no
// other end: with nobody at the keyboard to open the URL, `npm run layout` sat
// silent with an empty output file until it was killed, and every check in this
// repo that a person has to finish by hand is a check that does not run. So the
// browser is opened by the tool now, and `--manual` is what asks for the old
// behaviour when the page is wanted in the Browser pane instead.
//
// A REAL WINDOW, hidden. Every tile boots the real UI, which brings up Rive and
// a WebGL context per frame, so the renderer has to be a genuine one — offscreen
// rendering would change the thing being measured. It is hidden so that running
// the audit does not steal focus, and shown when the sweep is meant to be looked
// at (see --show, which is the default of `npm run layout` without --once).
//
// BACKGROUND THROTTLING IS THE TRAP. A hidden Chromium window clamps setTimeout
// to once a second and stops painting, and every settle in layout-audit.js is a
// timer — so the default hidden window turns a two-minute sweep into a
// forty-minute one that looks exactly like the hang this was written to fix.
// backgroundThrottling:false, plus the two command-line switches, is what keeps
// a hidden window running at full speed.
//
//   electron tools/layout/drive.js <url> [--show]
// ---------------------------------------------------------------------------

import { app, BrowserWindow } from 'electron';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http'));
const SHOW = args.includes('--show');

// Both of these are the process-wide half of backgroundThrottling:false. The
// webPreferences flag alone is not enough on every platform, and the failure it
// leaves behind is a sweep that runs at one tile a second with nothing to say
// why.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!url) {
  process.stderr.write('layout drive: no url\n');
  app.exit(2);
}

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: SHOW,
    webPreferences: {
      backgroundThrottling: false,
      // The page is our own static build on localhost and mounts itself in
      // iframes; nothing here needs node, and the frames must be ordinary web
      // documents or they are not measuring what a browser would.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // The renderer's console, forwarded with a prefix the parent filters on.
  // Without this a surface that throws on the way up is invisible from the
  // terminal — the page reports it as a finding, but a page-level failure
  // (a bad import, a syntax error in the bundle) has no finding to be, and
  // presented as the same silent wait as having no browser at all.
  // BOTH SIGNATURES. Electron replaced the positional (event, level, message)
  // form with an event object, and level went from a number to a string in the
  // same change — so a handler written for either one alone goes quiet, rather
  // than failing, on the other. Quiet is the one outcome this listener exists
  // to prevent.
  win.webContents.on('console-message', (e, level, message) => {
    const text = typeof e === 'object' && 'message' in e ? e.message : message;
    const lvl = typeof e === 'object' && 'level' in e ? e.level : level;
    const loud = lvl === 'error' || lvl === 'warning' || (typeof lvl === 'number' && lvl >= 2);
    if (loud && text) process.stdout.write(`SEAL_LAYOUT_CONSOLE ${String(text).split('\n')[0]}\n`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    process.stdout.write(`SEAL_LAYOUT_GONE ${details.reason}\n`);
    app.exit(3);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    process.stdout.write(`SEAL_LAYOUT_GONE could not load the page — ${desc} (${code})\n`);
    app.exit(4);
  });

  win.loadURL(url);
  process.stdout.write('SEAL_LAYOUT_READY\n');
});
