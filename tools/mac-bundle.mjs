// ---------------------------------------------------------------------------
// A DOUBLE-CLICKABLE .app AROUND A SHELL SCRIPT.
//
// Shared by every "one button in ~/Applications" generator in this repo:
// `film:setup` (tools/make-launchers.mjs) and `sealitaire:app`
// (tools/sealitaire-app.mjs). It is a module rather than a copied function
// because what it knows is not the bundle layout — that is twenty lines of
// plist — but the three things below, each of which was learned once, the
// hard way, and fails silently when a second copy of this forgets it.
//
// ---------------------------------------------------------------------------
// ONE: EVERY PATH IN A GENERATED SCRIPT IS ABSOLUTE.
//
// A GUI-launched app does not get your shell's environment. It gets a minimal
// PATH — no /usr/local/bin, no nvm, nothing a .zshrc set — so `npm` is simply
// not found, and the failure is a bundle that bounces once in the Dock and
// exits with nothing written anywhere. Every binary is therefore resolved
// HERE, where the shell that ran the generator knows where they are, and baked
// into the script.
//
// That is also why re-running a generator after moving the repo or changing
// node is not optional: the paths are a snapshot, and a stale one fails
// silently in exactly the same way.
//
// ---------------------------------------------------------------------------
// TWO: IT PINS THE ARCHITECTURE.
//
// `/usr/local/bin/node` on this Mac is a UNIVERSAL binary — x86_64 and arm64
// in one file. A terminal runs the arm64 slice; LaunchServices started the
// x86_64 one from inside the bundle. Same path, same node, different
// `process.arch` — and the first thing that noticed was rollup, which looked
// for `@rollup/rollup-darwin-x64` when node_modules only has the arm64 native:
//
//   Error: Cannot find module @rollup/rollup-darwin-x64
//
// It reads as a broken install (its own message suggests reinstalling), and
// the same command in a terminal works perfectly the whole time. So the slice
// is pinned to whatever the GENERATOR is running, which is the one the repo's
// node_modules were built for. Use ARCH_RUN as the prefix for anything the
// bundle executes out of node_modules.
//
// ---------------------------------------------------------------------------
// THREE: THE BUNDLE IS REPLACED, NEVER PATCHED.
//
// A bundle that kept an old executable beside a new Info.plist is the kind of
// half-state that runs the previous version and looks like the change did not
// take. `bundle()` removes the whole .app first, every time.
//
// A bundle is also an IDENTITY as far as macOS privacy is concerned, and a
// fresh one has been granted nothing. Anything needing Screen Recording,
// Accessibility or the microphone has to go through an app that already has
// the grant — see the Terminal note in tools/make-launchers.mjs.
//
// ---------------------------------------------------------------------------
// FOUR: IT MUST BE SIGNED, EVEN IF ONLY AD HOC.
//
// THE WORST FAILURE IN THIS FILE, because it does not look like a failure at
// all. On this macOS an unsigned bundle whose main executable is a shell
// script will not launch through LaunchServices — and `open` still exits 0.
// Nothing runs, nothing is logged, no dialog appears, the Dock icon does not
// bounce; `open -W` returns instantly as though the app had opened and quit.
// The script itself is fine the whole time: run `Contents/MacOS/run` straight
// from a shell and it works perfectly, which is exactly the evidence that
// sends you looking at the wrong thing.
//
// `codesign --force --sign -` is an AD-HOC signature — no certificate, no
// developer account, no notarisation. It is enough, and it is what was missing
// from `Film Seal Survivor.app`, which had been sitting in ~/Applications
// doing nothing when clicked.
//
// It has to be the LAST thing done to the bundle. A signature covers the
// contents, so writing one more file into it afterwards invalidates it and
// puts you straight back to the silent failure.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const ROOT = resolve(import.meta.dirname, '..');
export const APPS = join(homedir(), 'Applications');
export const NODE = process.execPath;
export const NODE_DIR = dirname(NODE);

// See note TWO. `arch` takes x86_64 rather than node's own spelling.
export const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64';
export const ARCH_RUN = `/usr/bin/arch -${ARCH}`;

/** The PATH line a generated script opens with, so `npm` and friends resolve. */
export const PATH_LINE = `export PATH="${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin"`;

/**
 * Write a minimal bundle whose executable is a shell script, and return its
 * path. `extra` writes additional files into Contents/Resources; `icon` is a
 * path to an .icns already on disk, copied in as the bundle's icon.
 */
export function bundle(name, identifier, script, extra = {}, icon = null) {
  const app = join(APPS, `${name}.app`);
  rmSync(app, { recursive: true, force: true });   // see note THREE
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
${icon ? '  <key>CFBundleIconFile</key><string>icon</string>\n' : ''}  <key>NSHighResolutionCapable</key><true/>
  <key>LSArchitecturePriority</key><array><string>${ARCH}</string></array>
</dict>
</plist>
`);

  for (const [file, body] of Object.entries(extra)) {
    const at = join(app, 'Contents', 'Resources', file);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
    chmodSync(at, 0o755);
  }

  if (icon) {
    const at = join(app, 'Contents', 'Resources', 'icon.icns');
    mkdirSync(dirname(at), { recursive: true });
    copyFileSync(icon, at);
  }

  const exe = join(app, 'Contents', 'MacOS', 'run');
  writeFileSync(exe, script);
  chmodSync(exe, 0o755);

  // LAST, and see note FOUR — everything above is inside what this covers.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
  return app;
}
