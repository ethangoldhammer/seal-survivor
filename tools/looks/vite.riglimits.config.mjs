// Builds tools/looks/rig-limits.html into a scratch directory so it can be
// served as static files by tools/looks/serve.mjs. A BUILD, not a dev server:
// the game's dev server is the sole writer of imported-tuning.json, and a
// second one on another port will flatten whatever tuning is live.
// See SERVERS.md.
//
//   npm run looks:rig
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  // ROOT-ABSOLUTE, not './'. assetPath.js rewrites every '/models/...' in the
  // game against Vite's `base`, and serve.mjs mounts the real public/models at
  // '/models/' — so a relative base turns them into
  // '/tools/looks/models/...' (this page is nested two deep in the build) and
  // every model 404s. Nothing throws: assets.js leaves a hole, the page draws an
  // empty scene and every table on it reads zero, which looks like a rig with no
  // bones rather than like a build served wrong.
  base: '/',
  build: {
    // The page awaits preloadAssets at the top level.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-rig-look'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(HERE, 'rig-limits.html'),
    },
  },
});
