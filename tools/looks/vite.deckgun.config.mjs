// Builds tools/looks/deck-gun.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second one
// on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.deckgun.config.mjs --outDir <dir>
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  // ROOT-ABSOLUTE, unlike most of the look configs. systems/assetPath.js turns
  // every '/models/...' in the game into BASE + the path, so a relative base on
  // a page served at /tools/looks/deck-gun.html asks for
  // /tools/looks/models/fish.glb — every model 404s, every asset falls back to
  // its procedural stand-in, and the page renders a contact sheet of coloured
  // boxes that looks like a deliberate abstraction rather than a broken mount.
  base: '/',
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-deck-gun'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'deck-gun.html') },
  },
});
