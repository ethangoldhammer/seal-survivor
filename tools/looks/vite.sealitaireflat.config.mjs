import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
export default defineConfig({
  root: PROJECT,
  base: './',
  build: { target: 'esnext', outDir: resolve(PROJECT, 'dist-sealitaire-flat'), emptyOutDir: true,
           assetsInlineLimit: 0, rollupOptions: { input: resolve(HERE, 'sealitaire-flat.html') } },
});
