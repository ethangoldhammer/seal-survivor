// Builds tools/looks/score-card.html into a scratch directory so it can be
// served as static files by tools/looks/serve.mjs. A BUILD, not a dev server:
// the game's dev server is the sole writer of imported-tuning.json, and a second
// one on another port will flatten whatever tuning is live. See SERVERS.md.
//
//   npx vite build --config tools/looks/vite.score.config.mjs --outDir dist-score-look
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../..');

export default defineConfig({
  root: PROJECT,
  base: './',
  // NO BACKEND. isGlobal() is false with this empty, so the card paints the
  // seeded local board and this page never touches the live leaderboard — and
  // the rows are the same rows every time it is opened, which is what makes a
  // layout page worth measuring against.
  define: { 'import.meta.env.VITE_LEADERBOARD_URL': '""' },
  build: {
    target: 'esnext',
    outDir: resolve(PROJECT, 'dist-score-look'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'score-card.html') },
  },
});
