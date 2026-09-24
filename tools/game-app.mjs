#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run sealitaire:app · npm run ball:app
//
// ONE BUTTON IN ~/Applications PER GAME — the table and the pitch,
// each without a terminal in front of it. The roster is tools/games.mjs; this
// file is only the things a Dock icon needs that a game does not.
//
// It was `sealitaire:app` and it knew one game. That was fine while Sealitaire
// was the only one with a door, and it stopped being fine the moment the
// workbench grew a card for all three: a generator that serves one of three
// equals is how the other two stay second-class.
//
// A real .app bundle rather than a .command file, because only a bundle can be
// dragged to the Dock, found by Spotlight, given an icon, and shown by Finder
// under a name with no extension on it. tools/mac-bundle.mjs writes the bundle
// and knows the four things that make a GUI-launched script work at all — read
// its header before changing how any of this is generated.
//
// ---------------------------------------------------------------------------
// WHY NONE OF THEM GO THROUGH TERMINAL.
//
// `Film Seal Survivor` has to: a take needs Screen Recording, that grant
// belongs to an app identity, and a fresh bundle has been granted nothing. A
// game needs no permission at all — it opens a window, or a browser tab — so
// the bundle runs it directly and you get one window instead of two.
//
// The cost of having no terminal is that nothing is watching stdout, and all
// three talk: the tune loop prints `[tune] saved N changed values` when you
// press SAVE, the rive watcher prints every rebuild, and vite prints its port.
// So each session is teed into that game's build/app.log, truncated per launch
// — the question is always "what happened just now" — and a non-zero exit
// raises a dialog rather than disappearing, because a bundle that bounces once
// in the Dock and leaves nothing behind is indistinguishable from one that is
// broken.
//
// ---------------------------------------------------------------------------
// WHY A VIEWER REFUSES TO OPEN A SECOND ONE.
//
// Sealitaire's viewer is a WRITER. Press SAVE and the tune
// tool writes those values into the project's tuning.luau, which the watcher
// then rebuilds from. Two viewers means two processes holding two snapshots of
// that file, and the second one to save wins — silently, over work that was
// never on screen in the window that lost.
//
// A Dock icon is exactly the thing that gets clicked twice, so something has
// to refuse the second one. That check is NOT here: it is in the game's own
// tune tool, which every way of starting it goes through — this bundle, the
// workbench button, a terminal — and which exits BUSY when it finds a viewer
// already open. Read sealitaire-tune.mjs's note for why the pattern it greps
// for is anchored, and what happens when it is not.
//
// What is here is the only part specific to a Dock icon: somebody who clicked
// one cannot read a message on a stream nobody is watching, so the busy exit
// becomes a dialog. One check, two ways of saying it.
//
// BLUBBERBALL HAS NO SUCH EXIT, and it is not an oversight — it has no viewer
// to be second. Its hazard is the same in kind (a second `vite` is a second
// writer of imported-tuning.json) and is handled a rung lower down, in
// tools/ball.mjs, which looks for a live dev server before it starts one. So
// the busy dialog below is generated only for a game that can report busy.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCH_RUN, NODE, PATH_LINE, ROOT, bundle } from './mac-bundle.mjs';
import { GAMES, gameBy, logPath } from './games.mjs';

// `<game> [--icon <png>]`, walked once rather than searched — `indexOf` on a
// bare word cannot tell the game from the argument of a flag, and the wrong
// answer here generates a perfectly good bundle for the wrong game.
const argv = process.argv.slice(2);
let key = '';
let iconArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--icon') { iconArg = argv[++i] ?? null; continue; }
  if (!argv[i].startsWith('--') && !key) key = argv[i];
}

const game = key ? gameBy(key) : null;
if (!game) {
  console.error(`\nusage: game-app.mjs <${GAMES.map((g) => g.key).join(' | ')}> [--icon <png>]\n`);
  process.exit(2);
}

const NAME = game.label;
const LOG = logPath(game);

// What the tune tool exits with when a viewer is already open. Read out of
// that file rather than typed here, so the two can never drift apart — and
// only for a game that has one.
const BUSY = game.tune
  ? Number(/const BUSY = (\d+)/.exec(readFileSync(join(ROOT, game.tune), 'utf8'))?.[1])
  : 0;
if (game.tune && !Number.isInteger(BUSY)) throw new Error(`no \`const BUSY = <n>\` in ${game.tune}`);

// ---------------------------------------------------------------------- icon
//
// A screenshot of the game, centre-cropped square. `<game>:shot` writes one;
// if it has never been run there is simply no icon, which is a bundle with a
// generic page on it rather than a generator that fails. Blubberball has no
// shot script and so has no icon until one is passed with --icon.
//
// macOS wants an .icns, and the only supported way to make one is an .iconset
// directory of exact sizes fed to iconutil. Both tools ship with the OS.
const ICON_SIZES = [16, 32, 128, 256, 512];

function makeIcon(source) {
  if (!source || !existsSync(source)) return null;
  const tmp = mkdtempSync(join(tmpdir(), `${game.key}-icon-`));
  const set = join(tmp, 'icon.iconset');
  mkdirSync(set);

  // sips -c takes HEIGHT then WIDTH and crops from the CENTRE, so the square
  // is the middle of the frame rather than its top-left corner.
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

  const icns = join(tmp, 'icon.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', icns], { stdio: 'ignore' });
  return { icns, tmp };
}

// -------------------------------------------------------------------- script

// A dialog, as one osascript line. `display dialog` returns the button on
// stdout, which is how the log button below knows it was pressed.
const dialog = (body, buttons, icon) =>
  `/usr/bin/osascript -e 'display dialog ${JSON.stringify(body)} `
  + `buttons {${buttons.map((b) => `"${b}"`).join(', ')}} default button "${buttons.at(-1)}" `
  + `with icon ${icon} with title "${NAME}"'`;

// What the bundle actually runs. A viewer game runs its tune tool; the route
// game runs tools/ball.mjs, which finds or starts the server and opens the tab
// itself — the browser is the window in that case, so there is nothing for the
// bundle to hold up but the process behind it.
const command = game.tune
  ? `${ARCH_RUN} "${NODE}" "${join(ROOT, game.tune)}" run`
  : `${ARCH_RUN} "${NODE}" "${join(ROOT, 'tools/ball.mjs')}"`;

// ONE AT A TIME — the tool found a viewer already open and started nothing.
// Not an error, so this exits 0: a click that correctly did nothing should not
// leave an app looking like it crashed.
const busyBlock = game.tune ? `
if [ $status -eq ${BUSY} ]; then
  ${dialog(`${game.door.replace(/^the /, 'The ')} is already open. Close that window before opening another — a second viewer would overwrite the first one’s tuning when you press SAVE.`, ['OK'], 'note')} >/dev/null 2>&1
  exit 0
fi
` : '';

const script = `#!/bin/sh
# Generated by tools/game-app.mjs — re-run \`npm run ${game.app}\`
# after moving the repo or changing node. Do not edit; it will be overwritten.
${PATH_LINE}
cd "${ROOT}" || exit 1
LOG="${LOG}"
/bin/mkdir -p "$(/usr/bin/dirname "$LOG")"

{
  echo "--- $(/bin/date) ---"
  ${command}
} >"$LOG" 2>&1
status=$?
${busyBlock}
# A bundle that exits with nothing on screen looks exactly like one that never
# started. Say what happened and offer the log.
if [ $status -ne 0 ]; then
  ANSWER=$(${dialog(`${NAME} closed with an error. ${LOG.replace(ROOT + '/', '')} has what it printed.`, ['Show Log', 'OK'], 'stop')} 2>/dev/null)
  case "$ANSWER" in *"Show Log"*) /usr/bin/open -R "$LOG" ;; esac
fi
exit $status
`;

// ----------------------------------------------------------------------- run

const source = iconArg ?? (game.project ? join(ROOT, game.project, 'build/shot.png') : '');
const icon = makeIcon(source);
const app = bundle(NAME, `com.hammeredgold.sealsurvivor.${game.key}`, script, {}, icon?.icns ?? null);
if (icon) rmSync(icon.tmp, { recursive: true, force: true });

console.log(`\n  ${app}\n`);
console.log('  Drag it to the Dock. Spotlight finds it by name.');
console.log(icon
  ? `  Icon from ${source.replace(ROOT + '/', '')}. Pass --icon <png> for another.`
  : source
    ? `  No icon: ${source.replace(ROOT + '/', '')} is not there. Run \`npm run ${game.shot}\`, then this again.`
    : '  No icon: this game has no screenshot script. Pass --icon <png> for one.');
console.log(`  What the session prints: ${LOG.replace(ROOT + '/', '')}`);
console.log('  Re-run this after moving the repo or changing node — the paths are baked in.\n');
