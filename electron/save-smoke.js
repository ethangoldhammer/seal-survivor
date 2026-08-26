// ============================================================================
// THE SAVE SMOKE ENTRY — proves the file in userData and the page's
// localStorage are actually the same save.
//
// Driven by tools/desktop-save-test.mjs, which holds the assertions. This half
// only gathers facts, the same split as electron/smoke.js.
//
// A REAL WINDOW AND A REAL PRELOAD, because the one assumption this whole
// design rests on cannot be checked any other way: that a localStorage write
// made in the preload's ISOLATED WORLD is readable by the page's own scripts.
// Isolated worlds have separate JavaScript contexts, so the instinct is that
// they would have separate storage too — they do not, because localStorage
// belongs to the frame's origin rather than to a JS context. That is either
// completely true or silently false, and "silently false" looks exactly like a
// player whose save never loads.
//
// A THROWAWAY userData DIRECTORY, set before app.whenReady. Without it this
// test would read, rewrite and eventually corrupt the real save file belonging
// to whoever ran it.
// ============================================================================

import { app, BrowserWindow, dialog } from 'electron';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ORIGIN, DIST, registerScheme, serve } from './serve.js';

registerScheme();

const bail = (why) => {
  process.stdout.write(`\nSEAL_SAVE ${JSON.stringify({ error: why })}\n`);
  app.exit(1);
};

// Before whenReady, or app.getPath('userData') has already been resolved and
// electron/save.js would be writing to the real one.
const SANDBOX = mkdtempSync(join(tmpdir(), 'seal-save-'));
app.setPath('userData', SANDBOX);

const { registerSaveIpc, readSave, writeSave, savePath, flush } = await import('./save.js');
const { registerSaveImageIpc } = await import('./saveImage.js');

// ---------------------------------------------------------------------------
// THE SAVE DIALOG, STUBBED — everything except the OS widget itself.
//
// showSaveDialog opens a modal the test cannot click, so it is replaced here
// with something that answers the way a player would. What that leaves under
// test is all of the part we wrote: the name sanitiser, the byte guards, the
// write, and — the one most likely to be got wrong — that a CANCEL is reported
// as its own outcome rather than as a failure. A cancel treated as failure
// falls through to the browser download path and hands the player a second copy
// of the picture they just declined.
//
// `answer` is swapped between calls from the assertions below.
// ---------------------------------------------------------------------------
const IMAGE_TARGET = join(SANDBOX, 'shot.png');
let answer = { canceled: false, filePath: IMAGE_TARGET };
dialog.showSaveDialog = async () => answer;

// The save this run starts from. Two of these keys are the point of the test:
//
//   seal-survivor-player-name   a normal save key, must reach the page.
//   seal-survivor-smuggled      NOT on the allowlist, and written into the file
//                               by hand. If readSave's inbound filter ever
//                               stops filtering, the page receives a key it was
//                               never meant to be given.
//
// THE SMUGGLED KEY IS A NAME THE GAME NEVER WRITES, which took a wrong turn to
// learn: this used to be 'deep-run-tuning-v2', chosen because that key is the
// most important one to keep OUT of a cloud save. But main.js seeds exactly
// that key into localStorage on a production build, so the check read the
// game's own 167KB tuning snapshot and reported the filter as broken when it
// was working perfectly. A negative test has to use a name nothing else can
// supply, or it measures the wrong thing and does it convincingly.
const SEEDED_NAME = 'Barnacle Pete';
const SMUGGLED = 'seal-survivor-smuggled';
writeFileSync(savePath(), JSON.stringify({
  version: 1,
  data: {
    'seal-survivor-player-name': SEEDED_NAME,
    'sealSurvivor.tips.v1': '["intro"]',
    [SMUGGLED]: 'should never reach the page',
  },
}));

app.whenReady().then(() => {
  if (!existsSync(join(DIST, 'index.html'))) {
    bail(`no index.html at ${DIST} — run npm run build:desktop first`);
    return;
  }

  serve();
  registerSaveIpc();
  registerSaveImageIpc();

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const deadline = setTimeout(() => bail('timed out after 60s'), 60_000);

  win.webContents.once('did-finish-load', async () => {
    try {
      // READ FROM THE PAGE'S OWN WORLD. executeJavaScript runs in the main
      // world, which is the world the game's modules run in — so this is the
      // real question, not a restatement of what the preload just did.
      const hydrated = await win.webContents.executeJavaScript(`({
        name: localStorage.getItem('seal-survivor-player-name'),
        tips: localStorage.getItem('sealSurvivor.tips.v1'),
        smuggled: localStorage.getItem(${JSON.stringify(SMUGGLED)}),
        // The size of the tuning snapshot the game seeds into localStorage by
        // itself. Reported rather than asserted, as the standing evidence for
        // why that key is off the allowlist: this much authoring state would
        // otherwise ride along in every cloud save.
        tuningBytes: (localStorage.getItem('deep-run-tuning-v2') ?? '').length,
      })`);

      // Now write from the page, the way the game does, and let the preload's
      // poll notice. One allowlisted key and one that must never be saved.
      await win.webContents.executeJavaScript(`(() => {
        localStorage.setItem('seal-survivor-buried', '["Doomed Squish"]');
        localStorage.setItem('seal-survivor-player-name', 'Chonker');
        localStorage.setItem('seal-survivor-playtest-client', 'this-machine-only');
        return true;
      })()`);

      // The preload polls at 1s; give it two turns, then drain the main-side
      // coalescing buffer rather than waiting out its 4s timer.
      await new Promise((r) => setTimeout(r, 2200));
      flush();

      // --- handing a picture to the player --------------------------------
      // Driven through window.sealDesktop.saveImage from the PAGE, so the whole
      // chain is exercised: structured clone of the bytes across the bridge,
      // the handler, and the write.
      const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];
      const callSave = (name, len = PNG.length) => win.webContents.executeJavaScript(`
        window.sealDesktop.saveImage(
          new Uint8Array(${JSON.stringify(PNG.slice(0, len))}), ${JSON.stringify(name)})
      `);

      const savedResult = await callSave('kill shot!!.png');
      const savedBytes = existsSync(IMAGE_TARGET) ? [...readFileSync(IMAGE_TARGET)] : null;

      // A cancel must be its own answer, not a failure.
      answer = { canceled: true, filePath: undefined };
      const cancelledResult = await callSave('shot.png');

      // Empty bytes are refused before any dialog opens.
      answer = { canceled: false, filePath: IMAGE_TARGET };
      const emptyResult = await callSave('shot.png', 0);

      // And the capability the game reads to decide the shape of the score row.
      const caps = await win.webContents.executeJavaScript(`({
        saveImage: typeof window.sealDesktop?.saveImage === 'function',
        share: typeof navigator.share === 'function',
        canShare: typeof navigator.canShare === 'function',
      })`);

      const onDisk = JSON.parse(readFileSync(savePath(), 'utf8'));

      // And the round trip back through readSave, which is what the next launch
      // would actually get.
      const reread = readSave();

      // A corrupt file must not throw and must not take the game down. Written
      // last so it cannot disturb the assertions above.
      writeFileSync(savePath(), '{ this is not json');
      const fromCorrupt = readSave();
      // And a write must still be able to repair it.
      const rewrote = writeSave({ 'seal-survivor-player-name': 'After Corruption' });
      const repaired = readSave();

      process.stdout.write(`\nSEAL_SAVE ${JSON.stringify({
        sandbox: SANDBOX,
        savePath: savePath(),
        seededName: SEEDED_NAME,
        hydrated,
        image: {
          savedResult,
          savedBytes,
          expectedBytes: PNG,
          cancelledResult,
          emptyResult,
          caps,
        },
        onDisk,
        reread,
        fromCorrupt,
        rewrote,
        repaired,
      })}\n`);
      clearTimeout(deadline);
      app.exit(0);
    } catch (err) {
      clearTimeout(deadline);
      bail(String(err?.message ?? err));
    }
  });

  win.webContents.once('did-fail-load', (_e, code, desc) => bail(`did-fail-load ${code} ${desc}`));
  win.loadURL(`${ORIGIN}/`);
});
