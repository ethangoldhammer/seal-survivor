// ============================================================================
// SERVING THE BUILT GAME TO THE DESKTOP SHELL.
//
// ---------------------------------------------------------------------------
// WHY A CUSTOM SCHEME RATHER THAN file://
//
// 207 asset references in path/src are absolute — '/models/furseal.glb',
// '/sfx/*.mp3', '/music/*.mp3', '/textures/*' — plus two that a grep for
// quoted paths misses: setTranscoderPath('/basis/') in assets.js and the
// '/models-ktx2/' swap beside it. There is no assetUrl() helper, so making
// them relative means editing all 207 and living with the regression risk
// forever.
//
// Under file:// a leading slash means the FILESYSTEM ROOT, so every one of
// those would resolve to /models/... on the player's disk and 404. Under a
// custom scheme with an origin — app://seal — a leading slash means the root
// of that origin, exactly as it does on the deployed site. So nothing in
// path/src has to change.
//
// This is the same trick the iOS build already relies on: Capacitor serves the
// app from capacitor://localhost, which is why those absolute paths work there
// today and why nobody has had to think about them.
// ---------------------------------------------------------------------------
//
// IN ITS OWN FILE so tools/desktop-shell-test.mjs can drive it without booting
// the real window — the same reason vite.config.js exports reloadHold(). The
// four things worth asserting about this file (an asset resolves, a missing one
// 404s, a traversal is refused, and the content type is right) are all
// answerable without a game on screen.
// ============================================================================

import { app, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';

export const SCHEME = 'app';

// The origin the game is served from. Worth treating as permanent: localStorage
// is partitioned BY ORIGIN, so changing this string in a later release silently
// wipes every player's name, tutorial progress, graveyard and local leaderboard
// — with no error and no way to get them back. (The move to file-backed saves
// in userData is what eventually makes this safe to change; until then, don't.)
export const ORIGIN = `${SCHEME}://seal`;

// Where the built game lives. Unpackaged this is dist-desktop/ — the output of
// vite.desktop.config.js, NOT the dist/ that `npm run deploy` publishes. The
// two differ (the desktop build has the Spline splash aliased out), and pointing
// the shell at dist/ would mean testing the web build and believing it was the
// desktop one. Packaged, it is whatever electron-builder was told to copy in.
//
// NO TRAILING SEPARATOR, which is load-bearing rather than tidiness. The
// obvious spelling — fileURLToPath(new URL('../dist/', import.meta.url)) —
// keeps the trailing slash a directory URL must have, and then the containment
// check below compares against `dist` + sep and gets `dist//`, which nothing
// starts with. Every request 403s, including index.html's own assets. It fails
// closed, which is the right direction to fail in, and it looks exactly like a
// scheme that was never registered.
export const DIST = app.isPackaged
  ? join(process.resourcesPath, 'dist')
  : join(fileURLToPath(new URL('../', import.meta.url)), 'dist-desktop');

// Content types we serve. Explicit rather than inferred, because three of these
// are load-bearing and guessing wrong on any of them fails in a way that does
// not name itself:
//
//   .glb / .ktx2   three.js parses the body regardless, so a wrong type here
//                  costs nothing — until a future loader starts checking.
//   .wasm          MUST be application/wasm or instantiateStreaming refuses
//                  the module outright. Both the KTX2 transcoder and Rive's
//                  runtime are wasm, and ui/riveRuntime.js deliberately points
//                  Rive at OUR copy rather than unpkg — so this is the header
//                  that decides whether that vendoring actually worked.
//   .mp3 / .m4a    the type reaches decodeAudioData, and the failure mode is
//                  the one systems/fetchAudio.js was written about: the game
//                  falls back to the synth and plays the WRONG THING rather
//                  than going silent, so nobody notices for a whole run.
export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.riv': 'application/octet-stream',
  '.splinecode': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Must be called BEFORE app.whenReady(). Electron bakes a scheme's privileges
 * in when the renderer's process model is set up, and a call after ready is
 * accepted and then does nothing — which presents as a page where fetch()
 * mysteriously refuses every asset.
 *
 *   standard          gives the scheme an ORIGIN, which is what makes a
 *                     leading slash mean anything at all. Without it every one
 *                     of those 207 paths is still broken.
 *   secure            marks it a secure context: Web Audio, crypto.randomUUID
 *                     and localStorage partitioning all want one.
 *   supportFetchAPI   systems/fetchAudio.js fetches every mp3 through fetch().
 *   stream            makes Range requests work, so a 13MB music loop can start
 *                     before it has finished arriving.
 */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Resolve a request path to a real file inside DIST, or null if it escapes.
 *
 * The traversal guard is not theatre even though every request originates from
 * our own bundle: a custom scheme is reachable from any script running in the
 * renderer, the game loads a third-party runtime into that renderer (the Spline
 * splash), and `app://seal/../../../../etc/passwd` is a string anything can
 * construct. Normalising and then checking the prefix is the whole defence, and
 * it has to compare against root + separator — a bare startsWith(DIST) would
 * also accept a sibling directory called `dist-evil`.
 *
 * Exported for the harness: this is the one piece worth asserting directly
 * rather than through a request.
 */
export function resolveInDist(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed %-escape. Not a path we can reason about, so not one we serve.
    return null;
  }
  // A NUL byte truncates a path in some syscalls, so a name containing one can
  // mean two different files to two different layers. Refuse rather than guess.
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(DIST, rel);
  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  return full;
}

/** Wire the scheme up. Call once, after app.whenReady(). */
export function serve() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);

    // The root, and ONLY the root, gets index.html.
    //
    // NO SPA FALLBACK, deliberately — a missing asset must 404 rather than
    // quietly returning the HTML page with a 200. That fallback is exactly
    // what hides a broken asset path on the deployed Pages site today: the
    // request succeeds, the loader gets a document where it expected a .glb,
    // and the error surfaces somewhere else entirely as a parse failure. A
    // real 404 names the file that is missing, at the moment it is missing.
    const target = pathname === '/' || pathname === ''
      ? join(DIST, 'index.html')
      : resolveInDist(pathname);

    if (!target) return new Response('forbidden', { status: 403 });

    // net.fetch over a file:// URL rather than reading the bytes ourselves: it
    // streams rather than buffering the whole file, which matters when the
    // largest asset is a 46MB model directory and the longest is a music loop.
    let res;
    try {
      res = await net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (!res.ok) return new Response('not found', { status: 404 });

    const type = TYPES[extname(target).toLowerCase()];
    if (!type) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Type', type);
    return new Response(res.body, { status: res.status, headers });
  });
}
