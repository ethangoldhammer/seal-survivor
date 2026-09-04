// Builds tools/looks/clap-lab.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second
// one on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npm run looks:claplab        then open http://localhost:4713/clap-lab.html
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  build: {
    // The page awaits preloadAssets at the top level.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-clap-lab'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'clap-lab.html') },
  },
});
