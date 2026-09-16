// Builds tools/looks/coil-lab.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second
// one on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npm run looks:coillab        then open http://localhost:4737/coil-lab.html
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  // ROOT-ABSOLUTE, not './'. This page was serving a seal-shaped hole: the
  // built page sits at /tools/looks/coil-lab.html, assetPath.js rewrites every
  // '/models/...' against Vite's `base`, and a relative base therefore asks for
  // '/tools/looks/models/furseal.glb' — which serve.mjs, mounting the real
  // public/models at '/models/', answers with a 404. Nothing throws on the
  // 404 itself: assets.js falls back to the built-in shape, which has no aim
  // rig, so the page dies one frame later on a null rig and reads as a bug in
  // the clap. Same fix and the same note as vite.riglimits.config.mjs.
  base: '/',
  build: {
    // The page awaits preloadAssets at the top level.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-coil-lab'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'coil-lab.html') },
  },
});
