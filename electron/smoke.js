// ============================================================================
// THE SMOKE ENTRY — an Electron main process that loads the game, probes the
// custom scheme, prints one line of JSON and quits.
//
// Driven by tools/desktop-shell-test.mjs, which is where the assertions and the
// reasoning about them live. This half only gathers facts.
//
// A REAL WINDOW, because there is no other way to ask these questions. The
// scheme's privileges (standard/secure/supportFetchAPI/stream) only take effect
// in a renderer's process model, so a check that did not involve a renderer
// would be checking nothing. It is hidden rather than shown so that running the
// test does not take focus off whatever Ethan is doing.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import { readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, DIST, registerScheme, serve, resolveInDist } from './serve.js';

registerScheme();

// Anything that goes wrong before the probe runs must still produce output the
// harness can read, or a failure presents as a silent hang.
const bail = (why) => {
  process.stdout.write(`\nSEAL_SMOKE ${JSON.stringify({ error: why })}\n`);
  app.exit(1);
};

/** The first file with this extension in dist/<dir>, as a request path. */
function pick(dir, ext) {
  const full = join(DIST, dir);
  if (!existsSync(full)) return null;
  const name = readdirSync(full).find((f) => extname(f).toLowerCase() === ext);
  return name ? `/${dir}/${name}` : null;
}

app.whenReady().then(() => {
  if (!existsSync(join(DIST, 'index.html'))) {
    bail(`no dist/index.html at ${DIST} — run npm run build first`);
    return;
  }

  serve();

  // One representative of each kind of asset the game loads over the scheme.
  // Chosen from what is actually on disk rather than hardcoded, so the test
  // does not start failing because a model was renamed.
  const probes = [
    { path: '/', expect: 200, type: 'text/html' },
    { path: pick('models', '.glb'), expect: 200, type: 'model/gltf-binary' },
    { path: pick('models-ktx2', '.glb'), expect: 200, type: 'model/gltf-binary' },
    { path: pick('sfx', '.mp3'), expect: 200, type: 'audio/mpeg' },
    { path: pick('music', '.mp3'), expect: 200, type: 'audio/mpeg' },
    { path: pick('textures', '.png') ?? pick('textures', '.webp'), expect: 200 },
    // The KTX2 transcoder, which assets.js reaches for by the absolute path
    // '/basis/' — the one asset whose URL is built inside a three.js loader
    // rather than written in our own code.
    { path: pick('basis', '.wasm'), expect: 200, type: 'application/wasm' },
    // Rive's runtime, vendored by ui/riveRuntime.js. If this is not
    // application/wasm the runtime silently falls back to unpkg, which is the
    // whole thing that module exists to prevent.
    { path: pick('assets', '.wasm'), expect: 200, type: 'application/wasm' },
    // NO SPA FALLBACK: a missing asset must 404 rather than returning the HTML
    // page with a 200.
    { path: '/models/definitely-not-a-real-model.glb', expect: 404 },
    // Traversal over the wire. Either answer is a pass: Chromium normalises a
    // STANDARD scheme's path before the handler is called, so `%2e%2e` usually
    // arrives already collapsed and resolves to a file inside dist/ that does
    // not exist (404) rather than to something outside it (403). What matters
    // is that it is never 200. The guard itself is tested directly below,
    // where the URL parser cannot do the work for us and hide a regression.
    { path: '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', expect: [403, 404] },
  ].filter((p) => p.path);

  // THE GUARD, called directly rather than through a request.
  //
  // Going through fetch() tests the URL parser as much as it tests us, and the
  // parser is doing most of the work — which means a regression in
  // resolveInDist would still show green. These are the strings as the handler
  // would see them if anything ever reached it un-normalised.
  const guard = [
    '/../../../../etc/passwd',
    '/..%2f..%2f..%2fetc/passwd',
    '/models/../../../../etc/passwd',
    '/\\..\\..\\windows\\win.ini',
    '/models/x\0.glb',
    '/%ZZ',
  ].map((input) => {
    let out;
    try {
      out = resolveInDist(input);
    } catch (err) {
      out = `THREW ${err?.message ?? err}`;
    }
    return {
      input,
      // null is a refusal. Anything else must still be inside dist/.
      refused: out === null,
      escaped: typeof out === 'string' && !out.startsWith(DIST),
      threw: typeof out === 'string' && out.startsWith('THREW'),
    };
  });

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

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message.slice(0, 300));
  });

  // A hard deadline. Without it a scheme that never answers leaves the process
  // alive with no window on screen and nothing on stdout.
  const deadline = setTimeout(() => bail('timed out after 60s'), 60_000);

  win.webContents.once('did-finish-load', async () => {
    try {
      const probed = await win.webContents.executeJavaScript(`(async () => {
        const out = [];
        for (const p of ${JSON.stringify(probes)}) {
          try {
            const res = await fetch(p.path);
            out.push({
              path: p.path,
              expect: p.expect,
              status: res.status,
              type: (res.headers.get('content-type') || '').split(';')[0],
              wantType: p.type || null,
              bytes: (await res.arrayBuffer()).byteLength,
            });
          } catch (err) {
            out.push({ path: p.path, expect: p.expect, status: 0, error: String(err) });
          }
        }
        return {
          bridge: globalThis.sealDesktop ?? null,
          title: document.title,
          origin: location.origin,
          secureContext: isSecureContext,
          probes: out,
        };
      })()`);

      clearTimeout(deadline);
      process.stdout.write(`\nSEAL_SMOKE ${JSON.stringify({ ...probed, guard, consoleErrors })}\n`);
      app.exit(0);
    } catch (err) {
      clearTimeout(deadline);
      bail(`probe threw — ${err?.message ?? err}`);
    }
  });

  win.webContents.once('did-fail-load', (_e, code, desc) => {
    clearTimeout(deadline);
    bail(`the window could not load ${ORIGIN}/ — ${desc} (${code})`);
  });

  win.loadURL(`${ORIGIN}/`);
});
