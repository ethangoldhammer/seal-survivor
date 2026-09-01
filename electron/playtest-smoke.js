// ============================================================================
// THE RUN-LOG SMOKE ENTRY — proves a run handed over by the page arrives in
// userData as a line `npm run perf` can read.
//
// Driven by tools/desktop-playtest-test.mjs, which holds the assertions. This
// half only gathers facts, the same split as electron/smoke.js and
// electron/save-smoke.js.
//
// A REAL WINDOW AND A REAL PRELOAD, because the assumption worth checking is
// not that appendFileSync works. It is that `window.sealDesktop.filePlaytest`
// is REACHABLE FROM THE PAGE'S OWN WORLD — the world systems/playtest.js runs
// in. contextBridge exposes into the main world from a sandboxed preload over
// an isolated-world boundary, and a capability that is missing there is not an
// error: platform.js reads it as "this is a browser", persist() falls through
// to a POST that 404s, and the run is silently dropped. Which is exactly the
// bug this whole file exists to have fixed.
//
// A THROWAWAY userData DIRECTORY, set before app.whenReady, or this test would
// append to — and trim! — the real run log belonging to whoever ran it.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ORIGIN, DIST, registerScheme, serve } from './serve.js';

registerScheme();

const bail = (why) => {
  process.stdout.write(`\nSEAL_PLAYTEST ${JSON.stringify({ error: why })}\n`);
  app.exit(1);
};

// Before whenReady, or app.getPath('userData') has already been resolved and
// playtestPath() would be pointing at the real one.
const SANDBOX = mkdtempSync(join(tmpdir(), 'seal-playtest-'));
app.setPath('userData', SANDBOX);

const { registerPlaytestIpc, fileRun, playtestPath, MAX_BYTES, MAX_RECORD_BYTES }
  = await import('./playtest.js');

// A record shaped like the real thing — `perf` is the part perf-runs.mjs reads,
// and `startedAt` is what it sorts on. Small on purpose; the size behaviour is
// exercised separately below.
const record = (n) => ({
  startedAt: 1780000000000 + n,
  level: n,
  endReason: 'death',
  meta: { build: 'smoke', client: 'c-smoke', device: { cores: 10, dpr: 2, w: 1280, h: 800, shell: 'desktop' } },
  perf: { frames: 1000 + n, seconds: 60, meanMs: 11, medianMs: 8, p95Ms: 17, p99Ms: 25, worstMs: 210, hitches: n, spikes: 1 },
});

const lines = () => (existsSync(playtestPath())
  ? readFileSync(playtestPath(), 'utf8').split('\n').filter(Boolean)
  : []);

app.whenReady().then(() => {
  if (!existsSync(join(DIST, 'index.html'))) {
    bail(`no index.html at ${DIST} — run npm run build:desktop first`);
    return;
  }

  serve();
  registerPlaytestIpc();

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
      // THE CAPABILITY, AS THE GAME SEES IT. platform.js keys on this exact
      // expression, so this is the check that a missing bridge would fail.
      const caps = await win.webContents.executeJavaScript(`({
        filePlaytest: typeof window.sealDesktop?.filePlaytest === 'function',
        isDesktop: window.sealDesktop?.isDesktop === true,
      })`);

      // FILED FROM THE PAGE, over the real bridge, exactly as persist() does:
      // the JSON text the recorder already produced, not the object.
      const call = (json) => win.webContents.executeJavaScript(
        `window.sealDesktop.filePlaytest(${JSON.stringify(json)})`,
      );

      const first = JSON.stringify(record(1));
      const second = JSON.stringify(record(2));
      const filedFirst = await call(first);
      const filedSecond = await call(second);
      const afterTwo = lines();

      // WHAT A BAD RECORD DOES. Each of these must be refused AND must not
      // leave anything behind: a half-written line is the one failure that
      // makes every future report warn about a malformed file.
      const refusedNotJson = await call('not json at all');
      const refusedArray = await call('[1,2,3]');
      const refusedEmpty = await call('');
      const refusedNull = await call('null');
      const afterRefusals = lines();

      // Over the per-record cap. Built as a real record with a long string in
      // it, so it is valid JSON and only its SIZE is wrong.
      const huge = JSON.stringify({ ...record(3), padding: 'x'.repeat(MAX_RECORD_BYTES) });
      const refusedHuge = await call(huge);

      // A newline inside a string value must not become a second line. Cheap to
      // get wrong the moment anything stops going through JSON.stringify.
      const filedNewline = await call(JSON.stringify({ ...record(4), endReason: 'death\nlevel 9\nfake' }));
      const afterNewline = lines();

      // ---------------------------------------------------------------------
      // THE TRIM, at the real threshold rather than a lowered one.
      //
      // Called through fileRun rather than the page: this is about the file, and
      // pushing 8MB over the bridge would be measuring IPC. Every line here is a
      // valid record, so a trim that cut mid-line shows up as a parse failure
      // rather than as a smaller file that looks fine.
      // ---------------------------------------------------------------------
      const filler = JSON.stringify({ ...record(0), padding: 'y'.repeat(8000) });
      const fillerCount = Math.ceil(MAX_BYTES / (filler.length + 1)) + 5;
      writeFileSync(playtestPath(), `${Array.from({ length: fillerCount }, () => filler).join('\n')}\n`
        + `${JSON.stringify({ ...record(99), marker: 'newest-before-trim' })}\n`);
      const beforeTrim = { bytes: statSync(playtestPath()).size, lines: lines().length };
      const filedAfterTrim = fileRun(JSON.stringify({ ...record(100), marker: 'after-trim' }));
      const trimmed = lines();
      const afterTrim = {
        bytes: statSync(playtestPath()).size,
        lines: trimmed.length,
        // Every surviving line still parses — the line-boundary claim.
        allParse: trimmed.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
        // The newest survived and is still last; the oldest went.
        lastMarker: JSON.parse(trimmed[trimmed.length - 1] ?? '{}').marker ?? null,
        keptMarkerBefore: trimmed.some((l) => l.includes('newest-before-trim')),
      };

      process.stdout.write(`\nSEAL_PLAYTEST ${JSON.stringify({
        sandbox: SANDBOX,
        logPath: playtestPath(),
        caps,
        filedFirst,
        filedSecond,
        // The bytes on disk against the bytes the page sent — the claim that a
        // desktop record and a posted record are the same record.
        afterTwo,
        expected: [first, second],
        refused: {
          notJson: refusedNotJson,
          array: refusedArray,
          empty: refusedEmpty,
          null: refusedNull,
          huge: refusedHuge,
          linesAfter: afterRefusals.length,
        },
        newline: { filed: filedNewline, lines: afterNewline.length },
        beforeTrim,
        filedAfterTrim,
        afterTrim,
        maxBytes: MAX_BYTES,
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
