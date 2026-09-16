// ============================================================================
// WHERE THE ASSETS ACTUALLY ARE.
//
// Every media path in this game is written root-absolute — '/models/seal.glb',
// '/sfx/bite.mp3', '/basis/' — 243 of them across assets.js, config.js,
// seabedProps.js, audio.js, celestial.js and noteStorm.js. That is correct for
// the two hosts this game was built against: Cloudflare Pages serves the build
// from the root of seal-survivor.pages.dev, and the Capacitor shell serves it
// from the root of capacitor://localhost. In both, '/models/...' is the file.
//
// itch.io is the third host and it is NOT root. An uploaded HTML5 build is
// served from a per-project subdirectory:
//
//     https://html-classic.itch.zone/html/<project id>/index.html
//
// so '/models/seal.glb' resolves to html-classic.itch.zone/models/seal.glb and
// 404s — every model, every sound, the basis transcoder, the lot. The game does
// not crash, which is the dangerous part: a missing sample falls back to the
// synth (see preloadSamples in systems/audio.js) and a missing model leaves a
// hole, so a broken build looks like a badly made game rather than a broken
// upload.
//
// THE FIX IS ONE FUNCTION, NOT 243 EDITS. Vite knows the prefix — it is
// `base`, which `npm run build` leaves at '/' and `npm run build:itch` sets to
// './' — and publishes it as import.meta.env.BASE_URL. So the absolute paths
// stay exactly as written, readable and greppable, and get rewritten on the way
// out to the network.
//
// On the default build BASE_URL is '/' and assetUrl is the identity function,
// which is why there is no itch-specific branch anywhere in the game: one code
// path, and only the build command differs.
//
// A relative base means the URL is resolved against the document, so './' plus
// 'models/seal.glb' is correct from any subdirectory depth without this file
// needing to know what the depth is.
// ============================================================================

import * as THREE from 'three';

// Vite guarantees a trailing slash on base. The fallback is for Node: the
// harnesses run the real modules with no bundler, so import.meta.env does not
// exist there — same shape as the VITE_LEADERBOARD_URL read in
// systems/leaderboard.js. Node must resolve to '/' and keep reading
// public/models directly.
const BASE = (() => {
  const raw = import.meta.env?.BASE_URL ?? '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
})();

/**
 * A path as written in the game, turned into a URL this host can fetch.
 *
 * Only root-absolute strings are touched. Anything else — a blob: or data: URL
 * from an in-game upload, a Vite-hashed import, an already-resolved './foo',
 * a remote https: — is returned untouched, which also makes this idempotent:
 * calling it twice cannot produce './/models' or './models-ktx2' twice over.
 */
export function assetUrl(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return p;
  return BASE + p.slice(1);
}

/** True when this build is served from somewhere other than the host root. */
export function isRebased() {
  return BASE !== '/';
}

// The blanket catch, installed as a side effect of importing this module.
//
// Every loader in the game is constructed bare — `new GLTFLoader()`,
// `new TextureLoader()`, `new KTX2Loader()`, in assets.js, celestial.js and
// noteStorm.js — and a bare three.js loader uses DefaultLoadingManager. One URL
// modifier on it therefore covers every model, every texture, every sidecar a
// glTF pulls in, and the transcoder's own .js/.wasm, including the ones
// resolveModelUrl swaps to '/models-ktx2/' after the call site has handed the
// path over.
//
// It does NOT cover plain fetch() — systems/fetchAudio.js calls assetUrl
// itself — nor the separate fbxManager in assets.js, which gets the same
// modifier where it is built.
//
// Installed here rather than in main.js so it cannot be missed by a look page
// or a harness that loads models without going through main: importing assetUrl
// at all is enough to have it in place.
THREE.DefaultLoadingManager.setURLModifier(assetUrl);
