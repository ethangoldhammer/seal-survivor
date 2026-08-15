// Builds tools/looks/cash-ordnance.html into a scratch directory so it can be
// served as static files by tools/looks/serve.mjs. A BUILD, not a dev server:
// the game's dev server is the sole writer of imported-tuning.json, and a
// second one on another port will flatten whatever tuning is live. See
// SERVERS.md.
//
//   npx vite build --config tools/looks/vite.cash.config.mjs --outDir <dir>
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  build: {
    // The page awaits preloadAssets at the top level. The default target is
    // old enough to refuse that outright, and this only ever runs in the one
    // browser sitting next to it.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-cash-look'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'cash-ordnance.html') },
  },
});
