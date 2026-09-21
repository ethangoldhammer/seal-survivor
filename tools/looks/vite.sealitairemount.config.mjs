import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
export default defineConfig({
  root: PROJECT,
  // base '/' like the GAME's build, not './' like the other look pages: this
  // harness exercises assetUrl(), and './' from a nested page is exactly the
  // itch.io case, which would resolve the .riv next to this file.
  base: '/',
  build: { target: 'esnext', outDir: resolve(PROJECT, 'dist-sealitaire-mount'), emptyOutDir: true,
           assetsInlineLimit: 0, rollupOptions: { input: resolve(HERE, 'sealitaire-mount.html') } },
});
