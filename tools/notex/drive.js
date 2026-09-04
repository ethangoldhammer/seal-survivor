// ---------------------------------------------------------------------------
// THE DRIVER — an Electron main process that plays the built game twice, once
// as shipped and once under `?notex`, and prints what each cost.
//
// Run through tools/notex-ab.mjs, which builds first and reads the line this
// prints. See the header there for what the numbers mean.
//
// THE SAME TRICKS AS tools/layout/drive.js: a real hidden window with
// background throttling switched off at both the window and the process, or
// rAF drops to once a second and every number here describes a paused game.
// The build is served over the desktop shell's own app:// scheme
// (electron/serve.js), which is a read-only static server — no /__tuning, no
// dev server, nothing that can reach imported-tuning.json.
//
// HOW A RUN STARTS WITHOUT A HAND ON IT: `?tune&sandbox` is the dev path that
// skips the splash and the menu and calls startGame() straight from boot, with
// the stage bar open. The stage holds the world still, so the driver clicks
// its Close button and the run is an ordinary run from there — spawns, hunts,
// the seal auto-firing. The driver then holds an arrow key, changing direction
// every few seconds, and clicks the first upgrade card whenever one is up, so
// the level-up screen never parks the sim.
//
//   electron tools/notex/drive.js [--seconds 60] [--warm 12] [--show]
//                                 [--order base,notex] [--shots <dir>]
// ---------------------------------------------------------------------------
import { app, BrowserWindow } from 'electron';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ORIGIN, DIST, registerScheme, serve } from '../../electron/serve.js';

// A THROWAWAY PROFILE, set before whenReady — the app:// origin is the desktop
// build's own, and without this every run's localStorage (settings, the
// tuning seed, the run log) lands in the real desktop app's profile.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'seal-notex-')));

registerScheme();

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const SECONDS = +flag('--seconds', 60);
const WARM = +flag('--warm', 12);
const SHOW = args.includes('--show');
const ORDER = flag('--order', 'base,notex').split(',');
const SHOTS = flag('--shots', null);
const SETTINGS = flag('--settings', null); // JSON, e.g. '{"performance":{"godRays":false}}'
const PASSES = args.includes('--passes');

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const emit = (obj) => process.stdout.write(`\nNOTEX_AB ${JSON.stringify(obj)}\n`);
const say = (m) => process.stdout.write(`  ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bail = (why) => {
  emit({ error: why });
  app.exit(1);
};

function processMetrics(pid) {
  const out = { rendererMB: null, gpuMB: null, all: [] };
  for (const p of app.getAppMetrics()) {
    const mb = +((p.memory?.workingSetSize ?? 0) / 1024).toFixed(0);
    out.all.push(`${p.type}:${p.pid}:${mb}`);
    if (p.pid === pid || (p.type === 'Tab' && out.rendererMB == null)) out.rendererMB = mb;
    if (p.type === 'GPU') out.gpuMB = mb;
  }
  return out;
}

// Up between every sideways leg: the seal drowns otherwise. Near the surface
// it breathes, breaches, and is still hunted.
const ARROWS = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowUp'];

async function runVariant(variant) {
  const notex = variant === 'notex';
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: SHOW,
    webPreferences: {
      preload: join(HERE, 'instrument.cjs'),
      backgroundThrottling: false,
      // The meter has to share the page's world to wrap its rAF and its GL.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const pid = win.webContents.getOSProcessId();
  const before = processMetrics(pid);

  const consoleLines = [];
  const errors = [];
  let deadAt = null;
  win.webContents.on('console-message', (e, level, message) => {
    const text = typeof e === 'object' && 'message' in e ? e.message : message;
    const lvl = typeof e === 'object' && 'level' in e ? e.level : level;
    if (/\[assets\] \?notex|\[perf\]|hitch|^run /.test(text)) consoleLines.push(text.slice(0, 400));
    // DEV_UI prints the run's frame-time report at death, and nowhere else.
    if (/^\[perf\] run/.test(text) && deadAt == null) deadAt = Date.now();
    if (lvl === 'error' || (typeof lvl === 'number' && lvl >= 3)) errors.push(text.slice(0, 300));
  });

  const url = `${ORIGIN}/?tune&sandbox${notex ? '&notex' : ''}${SETTINGS ? `&abset=${encodeURIComponent(SETTINGS)}` : ''}${PASSES ? '&abpasses=1' : ''}`;
  say(`${variant}: loading ${url}`);
  const t0 = Date.now();
  await win.loadURL(url);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // Wait for the stage bar, which is the sign the run has started.
  let up = false;
  for (let i = 0; i < 240; i++) {
    if (await js(`!!document.querySelector('.sv-stage-on')`)) { up = true; break; }
    await sleep(500);
  }
  if (!up) { win.destroy(); return { variant, error: 'the run never started (no stage bar after 120s)' }; }
  const bootMs = Date.now() - t0;
  say(`${variant}: run up after ${(bootMs / 1000).toFixed(1)}s`);

  await js(`[...document.querySelectorAll('.sv-stage-btn')].find((b) => b.textContent === 'Close')?.click()`);

  // Steer and keep the level-up screen from parking the sim.
  let dir = 0;
  const steer = async () => {
    const prev = ARROWS[dir % 4];
    dir++;
    const next = ARROWS[dir % 4];
    // An IIFE: executeJavaScript runs in the page's global scope, where a
    // second `const` of the same name is a SyntaxError that kills the whole
    // script — the seal stood still for a run before this was one.
    await js(`(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: '${prev}', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '${next}', bubbles: true }));
      const card = document.querySelector('.sv-card');
      if (card) {
        window.__ab.cards++;
        card.click();
        setTimeout(() => document.querySelector('.sv-card')?.click(), 400);
      }
    })()`).catch((err) => say(`${variant}: steer failed — ${err?.message ?? err}`));
  };
  await steer();
  const steerTimer = setInterval(steer, 2500);

  await sleep(WARM * 1000);
  const started = await js(`window.__ab.start()`);
  say(`${variant}: recording ${SECONDS}s (timer queries ${started.ext ? 'on' : 'OFF'}, canvas ${started.canvas?.join('x')})`);
  // Stops early at death: a score card is not the run, and 20 seconds of it
  // read as a 274fps miracle the first time this was written.
  const recStart = Date.now();
  while (Date.now() - recStart < SECONDS * 1000 && deadAt == null) await sleep(500);
  const stats = await js(`window.__ab.stop()`);
  clearInterval(steerTimer);
  const recorded = +(((deadAt ?? Date.now()) - recStart) / 1000).toFixed(1);
  if (deadAt != null) say(`${variant}: the seal died ${recorded}s into the recording`);

  const after = processMetrics(pid);
  if (SHOTS) {
    try {
      const img = await win.capturePage();
      if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, `${variant}.png`), img.toPNG());
    } catch (err) {
      say(`${variant}: screenshot failed — ${err?.message ?? err}`);
    }
  }
  win.destroy();
  return {
    variant, url, bootMs, recorded, died: deadAt != null,
    ...stats,
    memory: { before, after, gpuDeltaMB: after.gpuMB != null && before.gpuMB != null ? after.gpuMB - before.gpuMB : null },
    console: consoleLines.slice(0, 12),
    errors: errors.slice(0, 8),
  };
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  if (!existsSync(join(DIST, 'index.html'))) return bail(`no build at ${DIST} — run npm run build:desktop`);
  serve();
  const results = {};
  for (const v of ORDER) {
    try {
      results[v] = await runVariant(v);
    } catch (err) {
      results[v] = { variant: v, error: String(err?.stack ?? err) };
    }
  }
  emit({ seconds: SECONDS, warm: WARM, results });
  app.exit(0);
}).catch((err) => bail(String(err?.stack ?? err)));
