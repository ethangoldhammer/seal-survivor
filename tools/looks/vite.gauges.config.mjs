// Builds tools/looks/hp-gauges.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second one
// on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.gauges.config.mjs --outDir <dir>
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  build: {
    // Every other look page builds at this target, and a page that differs only
    // in its output format is a difference nobody wants to debug later.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-gauge-look'),
    emptyOutDir: true,
    rollupOptions: { input: [resolve(HERE, 'hp-gauges.html')] },
  },
});
