// Builds tools/looks/sealitaire-web.html — the "can Sealitaire run in the
// browser yet" probe. Read that page's header for what it answers.
//
// A BUILD, not a dev server, like every other look page: the game's dev server
// is the sole writer of imported-tuning.json and a second one flattens live
// tuning. See SERVERS.md.
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
    outDir: resolve(PROJECT, 'dist-sealitaire-web'),
    emptyOutDir: true,
    // The .riv is 19 MB; inlining it as a data URI would be absurd.
    assetsInlineLimit: 0,
    rollupOptions: { input: resolve(HERE, 'sealitaire-web.html') },
  },
});
