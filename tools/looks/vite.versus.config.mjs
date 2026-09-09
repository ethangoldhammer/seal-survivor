// Builds tools/looks/versus-goal.html into a scratch directory so it can be
// served read-only by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json. See SERVERS.md.
//
//   npm run looks:versus
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-versus-look'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'versus-goal.html') },
  },
});
