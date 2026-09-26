// Builds tools/looks/wetris-mount.html — the real wetrisTable.js mount on the
// web runtime. See that page's script header.
//
// base '/' like the GAME's build: this exercises assetUrl(), and public/ is
// copied in, so /wetris.riv is the file the site would serve.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: '/',
  build: { target: 'esnext', outDir: resolve(PROJECT, 'dist-wetris-mount'), emptyOutDir: true,
           assetsInlineLimit: 0, rollupOptions: { input: resolve(HERE, 'wetris-mount.html') } },
});
