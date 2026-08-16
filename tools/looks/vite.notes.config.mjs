// Builds tools/looks/note-storm.html into a scratch directory so it can be
// served as static files. A BUILD, not a dev server: the game's dev server is
// the sole writer of imported-tuning.json, and a second one on another port
// will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.notes.config.mjs --outDir <dir>
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  build: {
    // The page awaits preloadAssets and the glyph load at the top level. The
    // default target refuses top-level await outright.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-note-look'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'note-storm.html') },
  },
});
