// Builds tools/looks/tip-dissolve.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second one
// on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.tip.config.mjs --outDir <dir>
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  build: {
    // No top-level await here, but every other look page builds at this target
    // and a page that differs only in its output format is a difference nobody
    // wants to debug later.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-tip-look'),
    emptyOutDir: true,
    // TWO PAGES, ONE BUILD. The contact sheet is for choosing between the four
    // dissolves side by side; the scene is for seeing the one you chose do its
    // job beside an object that is moving. Neither answers the other's
    // question, and building them together means they can never be looking at
    // different versions of ui/tipDissolve.js.
    rollupOptions: {
      input: [resolve(HERE, 'tip-dissolve.html'), resolve(HERE, 'tip-scene.html')],
    },
  },
});
