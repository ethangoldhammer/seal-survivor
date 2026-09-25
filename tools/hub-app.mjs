#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run hub:app
//
// ONE BUTTON IN ~/Applications for the workbench — every tool in this repo,
// with no terminal in front of it. The games have had theirs for a while
// (`sealitaire:app`, `ball:app`, `wetris:app`); this is the button for the
// panel that lists them and the three hundred other scripts beside them.
//
// It is built on tools/mac-bundle.mjs like the game buttons — read that file's
// header before changing how any of this is generated, because four separate
// things make a GUI-launched script work at all and each fails silently.
//
// THE SHAPE IS NOT A GAME'S, and the difference is what the button is a button
// FOR. A game is a window: the bundle runs the viewer and stays in the Dock
// for as long as it is up. The workbench is a SERVER
// with a browser tab in front of it, so the bundle starts it detached, waits
// for the port, opens the tab and quits. An app that sat in the Dock holding
// the panel open would take the panel down with it when you quit the app,
// which is the tidier shape and is the wrong one: the point of the panel is
// that it is there all day.
//
// EVERY CLICK AFTER THE FIRST IS JUST `open`. The script checks the port
// before it starts anything, so pressing the icon again brings the tab up
// instead of failing to bind. That check is also what makes a second press
// during a slow first launch harmless.
//
// THE PORT IS READ OUT OF tools/hub.mjs rather than typed here. It is one
// number in one file and this is the second reader of it; a copy would be
// right until the day the panel moved, and then it would open a browser at a
// refused connection, which looks exactly like the tool being broken.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ARCH_RUN, NODE, PATH_LINE, ROOT, bundle } from './mac-bundle.mjs';

const NAME = 'Seal Survivor Tools';
const ID = 'com.ethangoldhammer.sealsurvivor.tools';
const SERVER = 'tools/hub.mjs';
const LOG_REL = 'tools/build/hub-app.log';
const LOG = join(ROOT, LOG_REL);

const argv = process.argv.slice(2);
let iconArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--icon') { iconArg = argv[++i] ?? null; continue; }
}

const hubSrc = readFileSync(join(ROOT, SERVER), 'utf8');
const PORT = Number(/process\.env\.PORT \|\| (\d+)/.exec(hubSrc)?.[1]);
if (!Number.isInteger(PORT)) throw new Error(`no default port in ${SERVER}`);

// ------------------------------------------------------------------- the icon

const ICON_SIZES = [16, 32, 128, 256, 512];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size, paint) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;                                  // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y);
      const at = row + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 8 bits per channel
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A PANEL OF BUTTONS, which is what the thing behind the icon is. Drawn per
// size rather than resampled from one big one, for the reason csv:app's is:
// the gaps between tiles are a pixel or two wide and a 512 downsampled to 16
// turns them into grey mush.
const BG = [24, 26, 33];
const TILE = [122, 162, 247];
const DIM = [70, 88, 122];
function drawPanel(size) {
  const pad = Math.max(2, Math.round(size * 0.16));
  const inner = size - pad * 2;
  const cols = 3, rows = 3;
  const gap = Math.max(1, Math.round(inner * 0.08));
  const cell = (inner - gap * (cols - 1)) / cols;
  return (x, y) => {
    const ix = x - pad, iy = y - pad;
    if (ix < 0 || iy < 0 || ix >= inner || iy >= inner) return [...BG, 255];
    const cx = Math.floor(ix / (cell + gap));
    const cy = Math.floor(iy / (cell + gap));
    if (cx >= cols || cy >= rows) return [...BG, 255];
    const inX = ix - cx * (cell + gap) < cell;
    const inY = iy - cy * (cell + gap) < cell;
    if (!inX || !inY) return [...BG, 255];
    // The top row reads brighter: the panel's first drawer is the one you
    // press, and a flat grid of nine identical squares is a waffle.
    return cy === 0 ? [...TILE, 255] : [...DIM, 255];
  };
}

// macOS wants an .icns, made from an .iconset of exact sizes fed to iconutil.
function makeIcon(source) {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-app-icon-'));
  const set = join(tmp, 'icon.iconset');
  mkdirSync(set);

  if (source) {
    if (!existsSync(source)) { rmSync(tmp, { recursive: true, force: true }); return null; }
    const side = Math.min(...['pixelHeight', 'pixelWidth'].map((k) => Number(
      execFileSync('/usr/bin/sips', ['-g', k, source], { encoding: 'utf8' }).trim().split(/\s+/).pop(),
    )));
    const square = join(tmp, 'square.png');
    execFileSync('/usr/bin/sips', ['-c', String(side), String(side), source, '--out', square], { stdio: 'ignore' });
    for (const n of ICON_SIZES) {
      for (const [px, suffix] of [[n, ''], [n * 2, '@2x']]) {
        execFileSync('/usr/bin/sips', ['-z', String(px), String(px), square,
          '--out', join(set, `icon_${n}x${n}${suffix}.png`)], { stdio: 'ignore' });
      }
    }
  } else {
    for (const n of ICON_SIZES) {
      for (const [px, suffix] of [[n, ''], [n * 2, '@2x']]) {
        writeFileSync(join(set, `icon_${n}x${n}${suffix}.png`), png(px, drawPanel(px)));
      }
    }
  }

  const icns = join(tmp, 'icon.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', icns], { stdio: 'ignore' });
  return { icns, tmp };
}

// ----------------------------------------------------------------- the script

const dialog = (body, buttons, icon) =>
  `/usr/bin/osascript -e 'display dialog ${JSON.stringify(body)} `
  + `buttons {${buttons.map((b) => `"${b}"`).join(', ')}} default button "${buttons.at(-1)}" `
  + `with icon ${icon} with title "${NAME}"'`;

const script = `#!/bin/sh
# Generated by tools/hub-app.mjs — re-run \`npm run hub:app\`
# after moving the repo or changing node. Do not edit; it will be overwritten.
${PATH_LINE}
cd "${ROOT}" || exit 1
LOG="${LOG}"
/bin/mkdir -p "$(/usr/bin/dirname "$LOG")"

# ALREADY UP? Then the click means "show me the panel", and there is nothing to
# start. This is the common case for every press after the first, and it is
# also what makes a second press during a slow first launch harmless.
if /usr/bin/nc -z 127.0.0.1 ${PORT} 2>/dev/null; then
  /usr/bin/open "http://localhost:${PORT}"
  exit 0
fi

# nohup, so the panel survives this script exiting — which it is about to do,
# because an app that stays running is an app that takes the panel down with it
# when you quit it. The log is truncated here and only here: a real launch.
{
  echo "--- $(/bin/date) ---"
} >"$LOG" 2>&1
/usr/bin/nohup ${ARCH_RUN} "${NODE}" "${join(ROOT, SERVER)}" >>"$LOG" 2>&1 &
server=$!

# WAIT FOR THE PORT, do not sleep at it. The panel stats every tool file it
# lists before it listens, which is fast on a warm disk and not on a cold one,
# and a fixed sleep that is occasionally too short opens a browser at a refused
# connection — which looks exactly like the tool being broken.
i=0
while [ $i -lt 100 ]; do
  if /usr/bin/nc -z 127.0.0.1 ${PORT} 2>/dev/null; then break; fi
  /bin/kill -0 $server 2>/dev/null || break
  /bin/sleep 0.1
  i=$((i + 1))
done

if /usr/bin/nc -z 127.0.0.1 ${PORT} 2>/dev/null; then
  /usr/bin/open "http://localhost:${PORT}"
  exit 0
fi

# Not listening, so it fell over — with one exception that is fine. Two clicks
# inside the same second can both get past the check above; the loser dies on
# EADDRINUSE, and by then the winner is serving, so the port answers and the
# tab opens. Only a port that is STILL closed is a real failure.
wait $server
ANSWER=$(${dialog(`${NAME} could not start. ${LOG_REL} has what it printed.`, ['Show Log', 'OK'], 'stop')} 2>/dev/null)
case "$ANSWER" in *"Show Log"*) /usr/bin/open -R "$LOG" ;; esac
exit 1
`;

// ----------------------------------------------------------------------- run

const icon = makeIcon(iconArg);
const app = bundle(NAME, ID, script, {}, icon?.icns ?? null);
if (icon) rmSync(icon.tmp, { recursive: true, force: true });

console.log(`\n  ${app}\n`);
console.log('  Drag it to the Dock, then right-click it and Options > Keep in Dock.');
console.log('  Spotlight finds it by name.');
console.log(`  Every click opens http://localhost:${PORT}. The first one starts the panel;`);
console.log('  the rest just bring the tab up. It keeps running after the app quits.');
console.log(icon && iconArg
  ? `  Icon from ${iconArg}.`
  : '  Icon drawn by this tool. Pass --icon <png> for your own.');
console.log(`  What the session prints: ${LOG_REL}`);
console.log('  Re-run this after moving the repo or changing node — the paths are baked in.\n');
