import { defineConfig } from 'vite';
import { writeFile, mkdir, appendFile, readdir, stat, unlink } from 'node:fs/promises';
import { execSync } from 'node:child_process';
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

// THE SOUND LIBRARY — what is actually on disk, and removing what isn't used.
//
// The workbench needs to show every file in public/sfx, not just the ones some
// config entry happens to point at: a file nothing references is invisible
// from inside the game and ships anyway. The browser cannot read a directory,
// so the dev server has to say.
//
// Deleting is the reason this is written defensively. It only ever touches
// public/sfx, only names that survive safeName (no traversal, no directories),
// and only extensions the uploader would have accepted in the first place —
// the same gate uploads go through, pointed the other way.
function sfxLibrary() {
  const SFX_DIR = resolve(PUBLIC_DIR, 'sfx');

  return {
    name: 'seal-survivor-sfx-library',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use('/__sfx-list', async (req, res) => {
        try {
          const names = await readdir(SFX_DIR);
          const files = [];
          for (const name of names) {
            if (!UPLOAD_EXTS.has(extname(name).toLowerCase())) continue;
            const info = await stat(resolve(SFX_DIR, name));
            files.push({ file: name, src: `/sfx/${name}`, kb: Math.round(info.size / 1024) });
          }
          files.sort((a, b) => a.file.localeCompare(b.file));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ files }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err?.message ?? err), files: [] }));
        }
      });

      server.middlewares.use('/__sfx-delete', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy(); });
        req.on('end', async () => {
          const deleted = [];
          const refused = [];
          try {
            const { files } = JSON.parse(body || '{}');
            for (const raw of Array.isArray(files) ? files : []) {
              // Whatever the client sends, only a bare filename in public/sfx
              // can ever be reached. safeName strips directories outright, so
              // "../../path/src/config.js" becomes a filename that does not
              // exist rather than a path that does.
              const name = safeName(String(raw).split('/').pop());
              if (!name) { refused.push(raw); continue; }
              try {
                await unlink(resolve(SFX_DIR, name));
                deleted.push(name);
                server.config.logger.info(`[sfx] deleted public/sfx/${name}`);
              } catch {
                refused.push(name);
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ deleted, refused }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
      });
    },
  };
}

// HOLD RELOADS — a latch the game can throw to stop the page bouncing.
//
// Vite has no HMR handlers anywhere in this app, so any source change falls
// through to a full page reload. That is normally what you want. It is exactly
// what you don't want while a stage is set up: a run in progress, creatures
// cleared, sliders where you left them — all of it thrown away because
// something edited a file somewhere else in the tree. With more than one agent
// working in the repo at once that is not an occasional annoyance, it is every
// few seconds.
//
// So the panel latches this on while it is open, and every hot update is
// swallowed and counted instead of applied. Nothing is lost — the count comes
// back to the client so the bar can say the page is stale and offer a reload
// on your terms rather than on the file watcher's.
//
// Same mechanism the tuning writer above already uses for its own three files
// (return [] from handleHotUpdate and Vite sends nothing). This one is just
// pointed at everything, and only while asked.
//
// NOT done in the browser, though every guide suggests it: the usual trick is
// to throw inside a `vite:beforeFullReload` listener, and in this version of
// Vite the client awaits those listeners through Promise.allSettled — the
// throw is swallowed and the reload happens anyway. The only place that can
// actually stop it is the server, before the message is sent.
// Exported so tools/stage-test.mjs can drive the hooks directly. Booting a
// real dev server to test this is not an option: this repo's dev server writes
// imported-tuning.json, and a second one racing the live session would
// overwrite whatever was being tuned in it.
export function reloadHold() {
  let holding = false;
  const pending = new Set();

  const report = (server) => {
    server.ws.send('stage:pending', { holding, count: pending.size, files: [...pending].map((f) => basename(f)) });
  };

  return {
    name: 'seal-survivor-reload-hold',
    apply: 'serve',

    handleHotUpdate(ctx) {
      if (!holding) return;
      // The three the tuning writer above already swallows are not staleness —
      // they are this session's own housekeeping. imported-tuning.json is
      // rewritten on every slider drag, so counting it would have the bar
      // announcing that the page had gone stale several times a second while
      // you tuned, naming the file you were tuning.
      if (ctx.file === TUNING_FILE || ctx.file === PLAYTEST_FILE || ctx.file.startsWith(PUBLIC_DIR)) return [];
      pending.add(ctx.file);
      report(ctx.server);
      return [];
    },

    configureServer(server) {
      server.ws.on('stage:hold', (data, client) => {
        holding = !!data?.hold;
        if (!holding) pending.clear();
        // Straight back to the client that asked, so the bar can confirm the
        // latch actually landed rather than assuming it did.
        client.send('stage:pending', { holding, count: pending.size, files: [] });
      });

      // A page that reloads while the latch is on would otherwise leave the
      // server holding for a client that no longer exists — and every
      // subsequent edit would be swallowed with nothing on screen to say so,
      // which looks exactly like Vite having died. A fresh connection is
      // always a fresh page, so the latch resets with it.
      server.ws.on('connection', () => {
        holding = false;
        pending.clear();
      });
    },
  };
}

// The commit a build came from, stamped into every run record the game files
// (see the provenance note in systems/playtest.js). Without it a collection of
// runs is a single undifferentiated pile: runs from before and after a balance
// change average together into a number that was never true of either game.
//
// `--dirty` is not cosmetic here. A build with uncommitted changes is not the
// commit it claims to be, and runs from one must be distinguishable from runs
// from the real thing — otherwise a shipped build and a half-finished local
// one share a label and the aggregate quietly mixes them.
//
// Falls back rather than throwing: an export from a tarball with no .git still
// has to build, it just can't say which commit it is.
function buildId() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}

// The function form, only so `command` is available: NODE_ENV is not reliably
// set while the config is being evaluated, and a build that mislabelled itself
// `dev` would be worse than one with no label at all.
export default defineConfig(({ command }) => ({
  plugins: [tuningWriter(), sfxLibrary(), reloadHold()],
  define: {
    // A string literal, so it survives into the bundle as one — `define`
    // substitutes the text verbatim, and an unquoted sha would be pasted in
    // as an identifier and fail to parse.
    __BUILD_ID__: JSON.stringify(command === 'build' ? buildId() : 'dev'),
  },
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
}));
