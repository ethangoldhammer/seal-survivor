#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run film:setup
//
// ONE BUTTON IN ~/Applications, so filming is a click rather than a command:
//
//   Film Seal Survivor    builds, launches locked to 1920x1080, records, and
//                         opens the folder with the new clip when you quit
//
// A real .app bundle rather than a .command file, because only a bundle can be
// dragged to the Dock, found by Spotlight, and given a name with a space in it
// that Finder shows without an extension.
//
// THERE IS NO SECOND BUTTON FOR THE FOLDER. It opens on its own when a take
// ends, which is when you want it, and `npm run film:open` is a button in the
// workbench for the times you want it otherwise. An app bundle whose whole job
// was `open` on a constant path was a Dock icon wrapped around a string.
//
// ---------------------------------------------------------------------------
// WHY EVERY PATH IN THE GENERATED SCRIPT IS ABSOLUTE.
//
// A GUI-launched app does not get your shell's environment. It gets a minimal
// PATH — no /usr/local/bin, no nvm, nothing a .zshrc set — so `npm` is simply
// not found, and the failure is a bundle that bounces once in the Dock and
// exits with nothing written anywhere. Every binary is therefore resolved HERE,
// where the shell that runs this script knows where they are, and baked in.
//
// That is also why re-running this after moving the repo or changing node is
// not optional: the paths are a snapshot, and a stale one fails silently in
// exactly the same way.
//
// ---------------------------------------------------------------------------
// AND WHY THE FILM BUTTON GOES THROUGH TERMINAL.
//
// Screen Recording permission is granted to an APP IDENTITY, and a new bundle
// is a new identity. Run `screencapture` from inside one and it exits 1 after
// 0.3 seconds having written nothing — no prompt, no message, no file:
//
//   [record] screencapture exited 1 after 0.3s — no output
//
// Everything up to that point works, so the window locks to 1920x1080, the
// recorder announces the take, and only the file is missing. Granting the
// bundle its own permission would mean a trip through System Settings and a
// prompt macOS does not reliably show for a child process.
//
// NOR DOES TERMINAL, unless you grant it. The grant that made this work during
// development belonged to the app whose shell was running the command, and it
// does not transfer. Electron itself reports `granted` either way, which is a
// red herring: `screencapture` is a separate process and macOS attributes it to
// the app that launched it, not to the one that asked.
//
// So the button asks Terminal to run the session — one identity to grant, one
// time, in System Settings — and the session PROBES for the permission before
// it builds anything, so a missing grant costs two seconds and a clear message
// instead of a build, a launch, and a take that quietly writes no file.
//
// A visible Terminal window costs nothing in the shot: the take is a rectangle
// over the game's own bounds and the game is raised above everything for the
// duration (see record.js).
//
// ---------------------------------------------------------------------------
// AND WHY IT PINS THE ARCHITECTURE.
//
// `/usr/local/bin/node` here is a UNIVERSAL binary — x86_64 and arm64 in one
// file. A terminal on this Mac runs the arm64 slice; LaunchServices started the
// x86_64 one from inside the bundle. Same path, same node, different `process.
// arch` — and the first thing that noticed was rollup, which looked for
// `@rollup/rollup-darwin-x64` when node_modules only has the arm64 native:
//
//   Error: Cannot find module @rollup/rollup-darwin-x64
//
// It reads as a broken install (its own message suggests reinstalling), and
// `npm run build:desktop` in a terminal works perfectly the whole time. So the
// slice is pinned to whatever THIS process is running, which is the one the
// repo's node_modules were built for.
// ---------------------------------------------------------------------------

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RECORDINGS } from '../electron/takeFile.js';

const ROOT = resolve(import.meta.dirname, '..');
const APPS = join(homedir(), 'Applications');
const NODE = process.execPath;
const NODE_DIR = dirname(NODE);
// See the note above. `arch` takes x86_64 rather than node's own spelling.
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64';

/**
 * A minimal double-clickable bundle whose executable is a shell script.
 * `extra` writes additional files into Contents/Resources.
 */
function bundle(name, identifier, script, extra = {}) {
  const app = join(APPS, `${name}.app`);
  // Removed rather than overwritten: a bundle that kept an old executable
  // beside a new Info.plist is the kind of half-state that runs the previous
  // version and looks like the change did not take.
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });

  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSArchitecturePriority</key><array><string>${ARCH === 'arm64' ? 'arm64' : 'x86_64'}</string></array>
</dict>
</plist>
`);

  for (const [file, body] of Object.entries(extra)) {
    const at = join(app, 'Contents', 'Resources', file);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
    chmodSync(at, 0o755);
  }

  const exe = join(app, 'Contents', 'MacOS', 'run');
  writeFileSync(exe, script);
  chmodSync(exe, 0o755);
  return app;
}

const LOG = join(RECORDINGS, 'last-session.log');

// The session itself. Run by Terminal — see the note at the top — and teed to
// a file as well, because "what did it say when I started it an hour ago" is a
// question the scrollback stops answering the moment you close the window.
// Truncated per launch: the question is always "what happened just now".
const SESSION = join(APPS, 'Film Seal Survivor.app', 'Contents', 'Resources', 'film.command');

const session = `#!/bin/sh
# Generated by tools/make-launchers.mjs — re-run \`npm run film:setup\` after
# moving the repo or changing node. Do not edit; it will be overwritten.
export PATH="${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "${RECORDINGS}"
cd "${ROOT}" || exit 1

# THE PERMISSION, BEFORE ANYTHING ELSE. A two-pixel still is the cheapest way to
# ask: it needs the same Screen Recording grant a take does, and the first
# attempt is what makes macOS show the dialog. Without this the session builds
# for five seconds, opens the game, starts a take, and writes nothing — and the
# only sign is one line in a log nobody is reading.
PROBE="$(/usr/bin/mktemp -t sealperm).png"
if ! /usr/sbin/screencapture -x -R 0,0,2,2 "$PROBE" 2>/dev/null || [ ! -s "$PROBE" ]; then
  /bin/rm -f "$PROBE"
  echo ""
  echo "  Screen Recording is not granted to Terminal, so a take would write no file."
  echo ""
  echo "  System Settings is opening at the right pane. Switch Terminal on, quit"
  echo "  Terminal completely (Cmd+Q), then click the button again."
  echo ""
  /usr/bin/open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  exit 1
fi
/bin/rm -f "$PROBE"

{
  echo "--- $(date) ---"
  /usr/bin/arch -${ARCH} "${NODE}" "${ROOT}/node_modules/vite/bin/vite.js" build --config "${ROOT}/vite.desktop.config.js" \
    && /usr/bin/arch -${ARCH} "${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "${ROOT}/electron/main.js" --capture --record --audio
  # The game has quit. Anything it filmed larger than 1080p and did not get to
  # scale on its way out is finished here — see tools/finish-takes.mjs.
  /usr/bin/arch -${ARCH} "${NODE}" "${ROOT}/tools/finish-takes.mjs"
  # ...and put the clip in front of you. The take is the point of the session,
  # so ending one without showing it means a trip through Finder every time.
  /usr/bin/arch -${ARCH} "${NODE}" "${ROOT}/tools/open-takes.mjs"
} 2>&1 | tee "${LOG}"
`;

const film = `#!/bin/sh
# Generated by tools/make-launchers.mjs. Terminal runs the session because the
# Screen Recording grant belongs to it and not to this bundle — see the header
# of tools/make-launchers.mjs.
exec /usr/bin/open -a Terminal "${SESSION}"
`;

const a = bundle('Film Seal Survivor', 'com.hammeredgold.sealsurvivor.film', film,
  { 'film.command': session });
// An old build of this made a second bundle for the folder. Removed rather
// than left behind, or it sits in the Dock doing something the session now
// does on its own.
rmSync(join(APPS, 'Seal Recordings.app'), { recursive: true, force: true });

console.log(`\n  ${a}\n`);
console.log('  Drag it to the Dock. Spotlight finds it by name.');
console.log('  The clips folder opens on its own when you quit the game;');
console.log('  `npm run film:open` is the button for it in the workbench.');
console.log(`  What the session printed: ${LOG}\n`);
