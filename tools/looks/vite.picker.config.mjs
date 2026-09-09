// Builds the atlas-render picker pages so they can import the GAME'S OWN
// modules — biolumSkin.js above all, which pulls in config.js and a `?raw` CSV
// and therefore cannot be loaded by the plain file server that has served these
// pages until now (see the /src/ mount note in tools/atlas-render/server.mjs).
//
// A BUILD, not a dev server, for the reason every look config here says so: the
// game's dev server is the sole writer of imported-tuning.json and a second one
// on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.picker.config.mjs --outDir <dir>
//
// THE `/src/` ALIAS IS THE WHOLE TRICK. The pages were written against the file
// server's mount table, where `/src/systems/noiseGlsl.js` is a URL. Rewriting
// those imports to relative paths would work here and break the pages for the
// raw server, so instead the same string is taught to vite as an alias. One
// spelling, both worlds, and no edit to the pages for the sake of the build.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');
const RENDER = resolve(PROJECT, 'tools/atlas-render');

export default defineConfig({
  root: PROJECT,
  base: './',
  resolve: {
    alias: [
      { find: /^\/src\//, replacement: `${resolve(PROJECT, 'path/src')}/` },
      { find: /^three\/addons\//, replacement: `${resolve(PROJECT, 'node_modules/three/examples/jsm')}/` },
    ],
  },
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-picker'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        picker: resolve(RENDER, 'picker.html'),
        render: resolve(RENDER, 'render.html'),
        audition: resolve(RENDER, 'audition.html'),
      },
    },
  },
});
