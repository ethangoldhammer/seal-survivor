// Builds tools/looks/shader-lab.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second one
// on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npm run looks:shaderlab
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  // ROOT-ABSOLUTE, not './' — the same trap vite.versus.config.mjs documents,
  // and on THIS page it is the whole point of the page. Every media path in the
  // game is written '/models/…' and assetPath.js rewrites it through
  // import.meta.env.BASE_URL, so a base of './' resolves it against THE
  // DOCUMENT — which here is /tools/looks/shader-lab.html. All 100 models then
  // 404 at /tools/looks/models/… and createVisual falls back to the primitive
  // stand-in, silently: a missing model is a console warning and a shape, never
  // an error. So the lab was painting its shaders onto cones and boxes for
  // every subject in the roster, which looks like a lab that works.
  //
  // serve.mjs mounts the build at '/' and public/models, /textures, /sprites
  // and /flags beside it, so '/' is the truth for this server.
  base: '/',
  build: {
    // The page awaits preloadAssets at the top level.
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-shaderlab'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(HERE, 'shader-lab.html'),
    },
  },
});
