// Builds tools/layout/layout-audit.html into a scratch directory so it can be
// served as static files by tools/layout-audit.mjs. A BUILD, not a dev server:
// the game's dev server is the sole writer of imported-tuning.json, and a
// second one on another port will flatten whatever tuning is live. See
// SERVERS.md and tools/looks/vite.cash.config.mjs, which does this for the
// look pages for the same reason.
//
//   npx vite build --config tools/layout/vite.layout.config.mjs
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  // The audit page loads itself in an iframe, so the entry has to survive being
  // fetched at a query string it did not have when it was built. A relative
  // base is what makes ./layout-audit.html?frame=1 resolve.
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-layout-audit'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'layout-audit.html') },
  },
  logLevel: 'warn',
});
