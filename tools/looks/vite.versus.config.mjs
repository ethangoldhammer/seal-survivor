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
  // ROOT-ABSOLUTE, not './'. Every media path in the game is written '/models/…'
  // and assetPath.js rewrites it through import.meta.env.BASE_URL — so a base of
  // './' turns it into a path relative to THE DOCUMENT, and this page's document
  // lives at /tools/looks/versus-goal.html. Every model then 404s at
  // /tools/looks/models/… and loads its built-in stand-in instead: the seals in
  // the last section came out as blue triangles and nothing said why, because a
  // missing model is a warning and a shape, never an error.
  //
  // serve.mjs mounts the build at '/' and public/models, /textures, /sprites
  // and /flags beside it, so '/' is the truth for this server.
  base: '/',
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-versus-look'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'versus-goal.html') },
  },
});
