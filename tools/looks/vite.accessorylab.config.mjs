// Builds tools/looks/accessory-lab.html into a scratch directory so it can be served
// as static files by tools/looks/serve.mjs. A BUILD, not a dev server: the
// game's dev server is the sole writer of imported-tuning.json, and a second one
// on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.accessorylab.config.mjs --outDir <dir>
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  // ABSOLUTE, NOT './'. The lab lives at /tools/looks/accessory-lab.html, two
  // directories deep, and every media path in the game is root-absolute —
  // assetPath.js rewrites '/models/fedorahat.glb' to BASE + the rest, so a
  // relative base resolved it against the DOCUMENT and asked for
  // /tools/looks/models/fedorahat.glb. Which 404s, and a 404 model is a console
  // warning and a built-in stand-in, never an error: every hat in the roster
  // came out as the fallback cone. A lab drawing cones looks like a lab.
  //
  // serve.mjs mounts the build at '/' with public/models, /textures, /sprites
  // and /flags beside it, so '/' is the truth for this server. Same fix, same
  // reason, as vite.shaderlab.config.mjs and vite.versus.config.mjs.
  base: '/',
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-accessory-lab'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'accessory-lab.html') },
  },
});
