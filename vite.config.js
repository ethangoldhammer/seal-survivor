import { defineConfig } from 'vite';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, extname, basename, dirname } from 'node:path';

const TUNING_FILE = resolve(import.meta.dirname, 'path/src/imported-tuning.json');
const PUBLIC_DIR = resolve(import.meta.dirname, 'public');
const PLAYTEST_FILE = resolve(import.meta.dirname, 'playtest/runs.jsonl');
const ENDPOINT = '/__tuning';
const UPLOAD_ENDPOINT = '/__upload';
const PLAYTEST_ENDPOINT = '/__playtest';

// Only these subfolders of public/ can be written to, and only with these
// extensions. The endpoint exists to let the in-game panels save an upload
// permanently — not to be a general write primitive into the source tree.
const UPLOAD_DIRS = new Set(['sfx', 'music', 'models', 'textures']);
const UPLOAD_EXTS = new Set([
  '.mp3', '.wav', '.ogg', '.m4a', '.flac',
  '.glb', '.gltf', '.fbx',
  '.png', '.jpg', '.jpeg', '.webp',
]);

// Strip any path structure and keep a plain filename — no traversal, no
// nested directories, whatever the client sends.
function safeName(raw) {
  const name = basename(String(raw ?? '')).replace(/[^\w.-]+/g, '_');
  const ext = extname(name).toLowerCase();
  if (!name || name.startsWith('.') || !UPLOAD_EXTS.has(ext)) return null;
  return name;
}

// Tuning is a PERMANENT edit to the game's mechanics, not a per-browser
// preference — so the tuner writes it to path/src/imported-tuning.json, the
// same file config.js merges at startup. That means tuning survives clearing
// site data, moves with the repo, and shows up in git diffs like any other
// change to the game.
//
// A browser page can't write to disk on its own, so this dev-only endpoint
// does it for them. `apply: 'serve'` keeps it out of production builds — a
// deployed page has no way to write to the developer's source tree, and
// shouldn't.
function tuningWriter() {
  return {
    name: 'seal-survivor-tuning-writer',
    apply: 'serve',

    // Saving must NOT bounce the page. imported-tuning.json is in the module
    // graph, so writing it would normally trigger an HMR reload — mid-drag,
    // every few hundred milliseconds. The file is only read at startup, so
    // suppressing its hot update costs nothing: the new values are already
    // live in CONFIG, and disk is just the durable copy.
    handleHotUpdate({ file }) {
      if (file === TUNING_FILE) return [];
      // Uploaded assets land in public/, which Vite watches — without this a
      // save would full-reload the page and throw away the run you were
      // tuning against. The new file is fetched on the next boot anyway.
      if (file.startsWith(PUBLIC_DIR)) return [];
      // A run being filed must not bounce the page — the next run would be
      // recorded against a fresh reload every time, which is the one thing a
      // playtesting session can't tolerate.
      if (file === PLAYTEST_FILE) return [];
    },

    configureServer(server) {
      server.middlewares.use(ENDPOINT, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          // A tuning snapshot is a few hundred KB at most; anything beyond
          // this is not something we should be writing to source.
          if (body.length > 8_000_000) req.destroy();
        });
        req.on('end', async () => {
          try {
            // Parse before writing so a malformed body can never truncate a
            // good tuning file into invalid JSON.
            const parsed = JSON.parse(body);
            await writeFile(TUNING_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
            res.statusCode = 204;
            res.end();
          } catch (err) {
            server.config.logger.warn(`[tuning] rejected a bad save — ${err?.message ?? err}`);
            res.statusCode = 400;
            res.end('invalid JSON');
          }
        });
      });

      // Appends a finished run to playtest/runs.jsonl — one JSON object per
      // line, so a session's runs accumulate across reloads, across branches
      // and across days without any of them being able to corrupt the others.
      // JSONL specifically: a truncated write costs the last line, not the
      // file, and `npm run playtest` can read it with a split.
      //
      // Same dev-only reasoning as the tuning endpoint: a deployed page has no
      // business writing to anyone's source tree.
      server.middlewares.use(PLAYTEST_ENDPOINT, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          // A recorded run is bucketed aggregates, a few KB at most. Anything
          // this size is not a run.
          if (body.length > 4_000_000) req.destroy();
        });
        req.on('end', async () => {
          try {
            // Parsed and re-stringified so a malformed body can never put a
            // broken line into the log, and so every line is guaranteed to be
            // exactly one run.
            const parsed = JSON.parse(body);
            await mkdir(dirname(PLAYTEST_FILE), { recursive: true });
            await appendFile(PLAYTEST_FILE, `${JSON.stringify(parsed)}\n`);
            res.statusCode = 204;
            res.end();
          } catch (err) {
            server.config.logger.warn(`[playtest] rejected a bad run — ${err?.message ?? err}`);
            res.statusCode = 400;
            res.end('invalid JSON');
          }
        });
      });

      // Saves an uploaded asset into public/, so an upload made in the T-menu
      // becomes a real file the game loads on every future boot instead of an
      // in-memory buffer that dies with the tab. The caller then points the
      // matching config entry at the returned URL, which is what makes the
      // choice persist through the normal tuning file.
      server.middlewares.use(UPLOAD_ENDPOINT, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const url = new URL(req.url, 'http://localhost');
        const dir = url.searchParams.get('dir');
        const name = safeName(url.searchParams.get('name'));
        if (!UPLOAD_DIRS.has(dir) || !name) {
          res.statusCode = 400;
          res.end('bad dir or filename');
          return;
        }

        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          // Generous enough for a model, bounded so a runaway request can't
          // fill the disk.
          if (size > 64_000_000) { req.destroy(); return; }
          chunks.push(c);
        });
        req.on('end', async () => {
          try {
            const target = resolve(PUBLIC_DIR, dir);
            await mkdir(target, { recursive: true });
            await writeFile(resolve(target, name), Buffer.concat(chunks));
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({ src: `/${dir}/${name}` }));
            server.config.logger.info(`[upload] saved public/${dir}/${name}`);
          } catch (err) {
            server.config.logger.warn(`[upload] failed — ${err?.message ?? err}`);
            res.statusCode = 500;
            res.end('write failed');
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [tuningWriter()],
  server: {
    // Vite has no built-in PORT support — without this it always takes 5173
    // (then walks upward when that's busy), which means a harness that hands
    // a server its port has no way to say so, and no way to know where the
    // server actually landed. Honouring PORT lets a launch config use
    // "autoPort" instead of hardcoding a --port flag that collides the moment
    // a second session runs the same config. Left undefined when PORT isn't
    // set, so a plain `npm run dev` behaves exactly as it always has.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
});
