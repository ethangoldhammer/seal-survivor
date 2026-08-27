#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:desktop
//
// THE DESKTOP SHELL SERVES THE GAME — electron/serve.js, driven through a real
// hidden Electron window by electron/smoke.js.
//
// Every failure this covers is one that would present as a blank window or as
// a wrong sound, with nothing in a log naming the cause:
//
//   THE LEADING SLASH. 207 asset paths in path/src start with one. Under
//   file:// that means the filesystem root and every one of them 404s; only a
//   scheme registered as `standard` gives the app an ORIGIN for a leading slash
//   to be relative to. Getting this wrong is a game with no models in it.
//
//   THE WASM CONTENT TYPE. instantiateStreaming refuses anything that is not
//   application/wasm. Two assets depend on it: the KTX2 transcoder, and Rive's
//   runtime — and Rive's failure is the quiet one, because @rive-app/canvas
//   falls back to fetching 2MB from unpkg, which works on the machine you are
//   testing on and is a blank HUD for a player with no network.
//
//   THE AUDIO CONTENT TYPE. A wrong type reaches decodeAudioData, and this game
//   does not go silent when a sample fails — systems/fetchAudio.js documents
//   the whole story — it falls back to the synth and plays the WRONG THING for
//   an entire run.
//
//   THE SPA FALLBACK. Returning index.html with a 200 for a missing asset is
//   what hides a broken path on the deployed Pages site today. The desktop
//   shell must 404 instead, so a missing file names itself.
//
//   TRAVERSAL. The renderer hosts a third-party runtime (the Spline splash),
//   and app://seal/%2e%2e/%2e%2e/etc/passwd is a string anything can build.
//
// Needs `npm run build` first — it probes what is actually in dist/.
//
//   node tools/desktop-shell-test.mjs
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ELECTRON = join(ROOT, 'node_modules/.bin/electron');
const SMOKE = join(ROOT, 'electron/smoke.js');
const DIST = join(ROOT, 'dist-desktop');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

console.log('\nDESKTOP SHELL — serving the built game over app://seal');

if (!existsSync(ELECTRON)) {
  console.log('\n  FAIL electron is not installed — npm install --save-dev electron\n');
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.log('\n  FAIL no dist-desktop/ — run `npm run build:desktop` first\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// NO SPLINE IN THE DESKTOP BUILD — checked on the bundle, before the shell is
// even started, because this is a fact about what was compiled rather than
// about what runs.
//
// The Spline splash fetched its runtime from unpkg and its scene from
// prod.spline.design at mount time, which is a blank title screen for an
// offline player. vite.desktop.config.js aliases the chooser and the module
// out; this is the assertion that the aliasing actually took. Checked by the
// absence of the RUNTIME rather than of every spline-shaped string:
// CONFIG.splineSplash.src still names a scene URL in config.js, and that is
// inert data once there is no runtime in the bundle that could fetch it.
section('the Spline splash is not in this build');
{
  const bundles = readdirSync(join(DIST, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(DIST, 'assets', f), 'utf8'));
  const has = (needle) => bundles.some((b) => b.includes(needle));

  check('no @splinetool runtime', !has('splinetool'));
  check('no unpkg fetch for it', !has('unpkg.com/@splinetool'));

  // AND THE RIVE CARD IS STILL HERE, which is the half that a check for absence
  // alone would let through. Stubbing the chooser wrong in the other direction
  // — aliasing away both splashes — would pass every assertion above and ship a
  // game with no title screen at all.
  //
  // Rive's own inlined package.json is the marker: it is what the runtime reads
  // its version out of, so it is present whenever the runtime is.
  check('the Rive splash is still in the build', has('@rive-app/canvas'));
  check(
    'its wasm shipped as a local asset',
    readdirSync(join(DIST, 'assets')).some((f) => f.startsWith('rive-') && f.endsWith('.wasm')),
    'otherwise the runtime falls back to fetching 2MB from unpkg',
  );

  // The stub is deliberately NOT asserted present. With the chooser inlined to
  // a constant, Rollup folds `splashChoice() === 'spline'` to false and drops
  // the unreachable branch — so the stub disappearing is the alias working
  // perfectly, not failing. The absence of `splinetool` above is what proves
  // the real module was the one removed.
}

// ---------------------------------------------------------------------------
// Run the smoke entry and read its one line of JSON back.
//
// stdout is filtered rather than parsed whole: Electron writes its own noise
// there (GPU process warnings, and on Linux a stack of dbus complaints), so a
// bare JSON.parse of the stream would fail for reasons that have nothing to do
// with the game.
// ---------------------------------------------------------------------------
const result = await new Promise((done) => {
  const child = spawn(ELECTRON, [SMOKE], {
    cwd: ROOT,
    // ELECTRON_ENABLE_LOGGING would put renderer console output on our stdout,
    // which is useful when this fails and noise when it passes. Left off; the
    // smoke entry collects console errors itself and returns them as data.
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    const line = out.split('\n').find((l) => l.startsWith('SEAL_SMOKE '));
    if (!line) {
      done({ error: `no result from the shell (exit ${code})`, stderr: err.slice(-800) });
      return;
    }
    try {
      done(JSON.parse(line.slice('SEAL_SMOKE '.length)));
    } catch (e) {
      done({ error: `unreadable result — ${e.message}` });
    }
  });
});

if (result.error) {
  console.log(`\n  FAIL ${result.error}`);
  if (result.stderr) console.log(`\n${result.stderr}`);
  console.log('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('the window');
check('loaded the game over the custom scheme', result.origin === 'app://seal', result.origin);
check('served index.html at the root', result.title === 'Seal Survivor', result.title);
check(
  'is a secure context',
  result.secureContext === true,
  'Web Audio and crypto.randomUUID both want one',
);

// ---------------------------------------------------------------------------
section('the bridge');
check('the preload reached the page', !!result.bridge, result.bridge ? '' : 'window.sealDesktop is undefined');
check('claims to be desktop', result.bridge?.isDesktop === true);
check('reports an OS for the playtest ledger', typeof result.bridge?.os === 'string', result.bridge?.os ?? '');
// The save dialog IS implemented now, so the bridge should advertise it — and
// the assertion flips rather than being deleted. What it is really guarding is
// that the capability flag and the implementation agree in whichever direction
// they happen to point: a bridge that claims saveImage without a handler behind
// it would hide the browser download path that still works, which is the iOS
// canShareImages() failure exactly. systems/desktopSave.js reads this same key.
check(
  'advertises the save dialog it actually implements',
  result.bridge?.saveImage === true,
  'platform.js reads this key to answer canSaveThroughOS()',
);

// ---------------------------------------------------------------------------
section('assets over app://seal');
for (const p of result.probes) {
  const want = Array.isArray(p.expect) ? p.expect : [p.expect];
  const statusOk = want.includes(p.status);
  const label = want.includes(200) && want.length === 1
    ? p.path
    : `${p.path} → ${want.join(' or ')}`;
  check(
    label,
    statusOk,
    statusOk ? '' : `got ${p.status}${p.error ? ` (${p.error})` : ''}`,
  );
  if (!statusOk || p.status !== 200) continue;

  if (p.wantType) {
    check(`  ${p.wantType}`, p.type === p.wantType, p.type || '(none)');
  }
  // A zero-length 200 is the shape a broken stream takes — the request
  // succeeds and the body never arrives, which decodeAudioData reports as an
  // EncodingError about a file that is perfectly fine on disk.
  check('  has a body', p.bytes > 0, `${p.bytes} bytes`);
}

// ---------------------------------------------------------------------------
// The guard, called directly. Over the wire Chromium normalises most of these
// away before the handler runs, which means a fetch-based check would pass even
// if resolveInDist stopped guarding entirely.
section('the containment guard, called directly');
for (const g of result.guard ?? []) {
  check(
    g.input,
    !g.escaped && !g.threw,
    g.threw ? 'threw' : g.escaped ? 'RESOLVED OUTSIDE dist/' : g.refused ? 'refused' : 'contained',
  );
}

// ---------------------------------------------------------------------------
// Console errors are REPORTED, not asserted on. A hidden window is not a fair
// place to run this game — there is no compositor driving rAF and WebGL may
// have no surface — so a boot error here is a lead rather than a verdict.
if (result.consoleErrors?.length) {
  section('renderer console (informational — a hidden window is not a fair test)');
  for (const line of result.consoleErrors.slice(0, 8)) console.log(`  ··   ${line}`);
}

console.log(
  failures
    ? `\n${failures} failure${failures === 1 ? '' : 's'}\n`
    : '\nThe desktop shell serves the game.\n',
);
process.exit(failures ? 1 : 0);
