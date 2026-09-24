#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run ball
//
// BLUBBERBALL'S DOOR — the third one, and the odd one out.
//
// `npm run sealitaire` opens a window. Blubberball
// has no window: it is a screen inside Seal Survivor, four presses down from
// the menu. So this opens a BROWSER, on the game server, at `/?ball` — the
// route path/src/main.js reads once on the way through the menu and then drops
// from the address bar (see takeOpeningRoute there).
//
// ---------------------------------------------------------------------------
// IT FINDS THE SERVER BEFORE IT STARTS ONE, and that is the whole reason this
// is a script rather than a link.
//
// `npm run dev` is `vite` with no strictPort, so a second one does not fail —
// it quietly takes the next port and runs. Two dev servers are two writers of
// path/src/imported-tuning.json, and the tuning that loses is the one you were
// in the middle of. The servers panel calls an older one `stomp` for exactly
// this reason.
//
// So: survey first. If a dev server this repo started is already listening,
// this opens a tab on it and exits, having started nothing. Only when there is
// none does it start one — and then it STAYS in the foreground holding it, so
// closing this is closing the server, the same bargain the other two doors
// make with their viewer.
//
//   node tools/ball.mjs              find or start, then open the pitch
//   node tools/ball.mjs --no-open    ...without the browser (the Dock bundle
//                                    opens its own, after this prints)
// ---------------------------------------------------------------------------

import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { survey } from './servers.mjs';
import { gameBy } from './games.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BALL = gameBy('blubberball');
const args = process.argv.slice(2);
const wantsBrowser = !args.includes('--no-open');

/** The origin of the dev server this repo is using, or '' if there is none. */
function devOrigin() {
  const found = survey().filter((p) => p.role === 'dev');
  // The same rule the servers panel uses: newest wins, because the one you
  // most recently started is the one you are actually looking at. `keep` is
  // that verdict already computed, so prefer it and fall back to any dev
  // server at all rather than starting a second one over the top of a third.
  const one = found.find((p) => p.verdict === 'keep') ?? found[0];
  return one ? `http://localhost:${one.ports[0]}` : '';
}

const openTab = (url) => {
  if (!wantsBrowser) return;
  try {
    execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
  } catch {
    // No `open` (not macOS), or no browser. The address is on stdout either
    // way, which is the part that matters.
  }
};

const here = devOrigin();
if (here) {
  const url = here + BALL.url;
  console.log(`\n  the game server is already up — ${url}\n`);
  openTab(url);
  process.exit(0);
}

// Nothing listening. Start one, and hold it.
//
// THIS node against node_modules/.bin/vite, which is the EXACT command line
// `npm run dev` produces — and the path matters, because the survey above
// recognises a dev server by its command line and nothing else.
//
// node_modules/vite/bin/vite.js is the same program by a different name, and
// starting it that way is a dev server the survey calls `other`. Which means
// the check at the top of this file finds nothing, and the second press of a
// Dock button starts a SECOND vite — the one thing this file exists to stop.
// It did exactly that, once, on the way to being written.
//
// Not `npm run dev`: a Dock bundle gets a minimal PATH and the architecture
// its generator pinned (see tools/mac-bundle.mjs), and `process.execPath` is
// both of those already. Going through a package manager would put a shell and
// a resolver between the bundle and the thing it is holding open.
console.log('\n  no game server — starting one.\n');
const child = spawn(process.execPath, [join(ROOT, 'node_modules/.bin/vite')],
  { cwd: ROOT, stdio: ['inherit', 'pipe', 'inherit'] });

// Vite prints its address once, on a line that has moved between versions.
// Match the URL itself rather than the label around it, and only take the
// first — `--host` prints a Network line as well and a tab on the LAN address
// is a tab that stops working when the Wi-Fi does.
let opened = false;
let buf = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (opened) return;
  buf += chunk.toString();
  const at = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?/.exec(buf);
  if (!at) return;
  opened = true;
  const url = `http://localhost:${at[1]}${BALL.url}`;
  console.log(`\n  the pitch — ${url}\n`);
  openTab(url);
});

child.on('exit', (code) => process.exit(code ?? 0));
