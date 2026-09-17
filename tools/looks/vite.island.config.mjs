// TEMPORARY — scratch probe page for the safe-area work.
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const PROJECT = '/Users/ethangoldhammer/Projects/seal-survivor';
const SP = '/private/tmp/claude-501/-Users-ethangoldhammer-Projects-seal-survivor/20c4838b-e5c6-4007-9b60-b48cc9154eb1/scratchpad';
export default defineConfig({
  root: PROJECT,
  base: '/',
  build: {
    target: 'esnext',
    outDir: `${SP}/dist-island`,
    emptyOutDir: true,
    rollupOptions: { input: resolve(PROJECT, 'tools/looks/island-probe.html') },
  },
});
