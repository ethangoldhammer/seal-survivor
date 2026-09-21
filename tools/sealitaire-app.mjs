#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run sealitaire:app
//
// ONE BUTTON IN ~/Applications that opens the Sealitaire table — the live
// viewer window and the tuning save loop, the same thing `npm run sealitaire`
// starts, without a terminal in front of it.
//
// A real .app bundle rather than a .command file, because only a bundle can be
// dragged to the Dock, found by Spotlight, given an icon, and shown by Finder
// under a name with no extension on it. tools/mac-bundle.mjs writes the bundle
// and knows the three things that make a GUI-launched script work at all —
// read its header before changing how any of this is generated.
//
// ---------------------------------------------------------------------------
// WHY THIS ONE DOES NOT GO THROUGH TERMINAL.
//
// `Film Seal Survivor` has to: a take needs Screen Recording, that grant
// belongs to an app identity, and a fresh bundle has been granted nothing. The
// table needs no permission at all — it opens a window and draws — so the
// bundle runs it directly and you get one window instead of two.
//
// The cost of having no terminal is that nothing is watching stdout, and the
// tune loop talks: it prints `[tune] saved N changed values` when you press
// SAVE in the panel, and the rive watcher prints every rebuild. So the session
// is teed into rive/sealitaire/build/app.log, truncated per launch — the
// question is always "what happened just now" — and a non-zero exit raises a
// dialog rather than disappearing, because a bundle that bounces once in the
// Dock and leaves nothing behind is indistinguishable from one that is broken.
//
// ---------------------------------------------------------------------------
// WHY IT REFUSES TO OPEN A SECOND ONE.
//
// The viewer is a WRITER. Press SAVE and tools/sealitaire-tune.mjs writes
// those values into rive/sealitaire/tuning.luau, which the watcher then
// rebuilds from. Two viewers means two processes holding two snapshots of that
// file, and the second one to save wins — silently, over work that was never
// on screen in the window that lost.
//
// A Dock icon is exactly the thing that gets clicked twice, so something has
// to refuse the second one. That check is NOT here: it is in
// tools/sealitaire-tune.mjs, which every way of starting the table goes
// through — this bundle, the workbench button, a terminal — and which exits 3
// when it finds a viewer already open. Read its note for why the pattern it
// greps for is anchored, and what happens when it is not.
//
// What is here is the only part specific to a Dock icon: somebody who clicked
// one cannot read a message on a stream nobody is watching, so exit 3 becomes
// a dialog. One check, two ways of saying it.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS, ARCH_RUN, NODE, PATH_LINE, ROOT, bundle } from './mac-bundle.mjs';

const NAME = 'Sealitaire';
const PROJECT = join(ROOT, 'rive/sealitaire');
const LOG = join(PROJECT, 'build/app.log');
// What sealitaire-tune.mjs exits with when a viewer is already open. Read out
// of that file rather than typed here, so the two can never drift apart.
const BUSY = Number(/const BUSY = (\d+)/.exec(
  readFileSync(join(ROOT, 'tools/sealitaire-tune.mjs'), 'utf8'),
)?.[1]);
if (!Number.isInteger(BUSY)) throw new Error('no `const BUSY = <n>` in tools/sealitaire-tune.mjs');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

// ---------------------------------------------------------------------- icon
//
// A screenshot of the table, centre-cropped square. `sealitaire:shot` writes
// one; if it has never been run there is simply no icon, which is a bundle
// with a generic page on it rather than a generator that fails.
//
// macOS wants an .icns, and the only supported way to make one is an .iconset
// directory of exact sizes fed to iconutil. Both tools ship with the OS.
const ICON_SIZES = [16, 32, 128, 256, 512];

function makeIcon(source) {
  if (!existsSync(source)) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-icon-'));
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

const script = `#!/bin/sh
# Generated by tools/sealitaire-app.mjs — re-run \`npm run sealitaire:app\`
# after moving the repo or changing node. Do not edit; it will be overwritten.
${PATH_LINE}
cd "${ROOT}" || exit 1
LOG="${LOG}"
/bin/mkdir -p "$(/usr/bin/dirname "$LOG")"

{
  echo "--- $(/bin/date) ---"
  ${ARCH_RUN} "${NODE}" "${ROOT}/tools/sealitaire-tune.mjs" run
} >"$LOG" 2>&1
status=$?

# ONE AT A TIME — the tool found a viewer already open and started nothing.
# Not an error, so this exits 0: a click that correctly did nothing should not
# leave an app looking like it crashed.
if [ $status -eq ${BUSY} ]; then
  ${dialog('The table is already open. Close that window before opening another \u2014 a second viewer would overwrite the first one\u2019s tuning when you press SAVE.', ['OK'], 'note')} >/dev/null 2>&1
  exit 0
fi

# A bundle that exits with nothing on screen looks exactly like one that never
# started. Say what happened and offer the log.
if [ $status -ne 0 ]; then
  ANSWER=$(${dialog(`The table closed with an error. rive/sealitaire/build/app.log has what it printed.`, ['Show Log', 'OK'], 'stop')} 2>/dev/null)
  case "$ANSWER" in *"Show Log"*) /usr/bin/open -R "$LOG" ;; esac
fi
exit $status
`;

// ----------------------------------------------------------------------- run

const source = flag('icon') ?? join(PROJECT, 'build/shot.png');
const icon = makeIcon(source);
const app = bundle(NAME, 'com.hammeredgold.sealsurvivor.sealitaire', script, {}, icon?.icns ?? null);
if (icon) rmSync(icon.tmp, { recursive: true, force: true });

console.log(`\n  ${app}\n`);
console.log('  Drag it to the Dock. Spotlight finds it by name.');
console.log(icon
  ? `  Icon from ${source.replace(ROOT + '/', '')}. Pass --icon <png> for another.`
  : `  No icon: ${source.replace(ROOT + '/', '')} is not there. Run \`npm run sealitaire:shot\`, then this again.`);
console.log(`  What the session prints: ${LOG.replace(ROOT + '/', '')}`);
console.log('  Re-run this after moving the repo or changing node — the paths are baked in.\n');
