#!/usr/bin/env node
// ============================================================================
// SHIP:MAC — the current build, as a Mac app you can launch, in one step.
//
//   npm run ship:mac                     # icon, desktop bundle, .app
//   npm run ship:all -- "what changed"   # ↑ plus the web deploy and the phone
//
// The desktop third of the one button. It is the local half in the same sense
// as tools/ship-ios.mjs: no notarization, no Steam upload, no distribution of
// any kind — electron-builder signs with the Apple Development identity already
// in the keychain and leaves a .app that runs on this machine.
//
// ---------------------------------------------------------------------------
// WHY THIS BUILDS ONE ARCHITECTURE AND `npm run pack:desktop` BUILDS TWO.
//
// electron-builder.yml declares x64 and arm64 for mac because a Steam depot has
// to carry both — the player's Mac is not this Mac. Every arch is a separate
// Electron download, a separate copy of 130MB of models, and a separate sign,
// so building both doubles a wait whose entire purpose here is to hand YOU an
// app to double-click. This one builds the host arch; pack:desktop stays the
// depot build and still builds both.
//
// THE ICON IS REGENERATED FIRST, every time, from design/app-icon.svg. It is
// one sharp call and it removes the only way this can silently regress: the
// Mac build shipped with the default Electron icon for as long as build/ did
// not exist, and electron-builder reports that as one dim line among thirty. A
// picture that is wrong is loud; a picture that is Electron's is not.
//
// THE WEB BUILD IS NOT REUSED. dist/ and dist-desktop/ differ — the desktop
// build aliases the Spline splash out of the import graph, see
// vite.desktop.config.js — so this builds its own. That is also why it cannot
// take a --skip-build the way the phone half can: there is nothing already on
// disk that is the right bytes.
// ============================================================================

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICON = join(ROOT, 'build/icon.png');

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (s = '') => console.log(s);

// A failure here is worth more than a stack trace: every one of them has a
// specific fix, and the fix is what gets printed.
export class ShipMacError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

// --- pure helpers (tools/ship-mac-test.mjs covers these) --------------------

/**
 * The electron-builder arch flag for a Node arch string.
 *
 * NAMED RATHER THAN PASSED THROUGH, because the two vocabularies only look the
 * same: Node says `arm64` and `x64`, electron-builder's flags are `--arm64` and
 * `--x64`, and its *config* spells the second one `x64` while Electron's own
 * download URLs use `x64` too. One mapping, in one place, so a future arch does
 * not turn into a flag electron-builder silently ignores — and an ignored arch
 * flag does not fail, it builds the default instead.
 */
export function archFlag(nodeArch) {
  if (nodeArch === 'arm64') return '--arm64';
  if (nodeArch === 'x64') return '--x64';
  throw new ShipMacError(`no Mac build for the ${nodeArch} architecture`,
    'electron-builder packages x64 and arm64; this machine reports neither.');
}

/**
 * Where electron-builder puts the .app, from electron-builder.yml's
 * `directories.output` and its own per-platform subdirectory convention.
 *
 * arm64 lands in `mac-arm64` and x64 in plain `mac` — an asymmetry in
 * electron-builder rather than a choice here, and the reason this is a function
 * with a test rather than a template string at the call site.
 */
export function appDir(nodeArch) {
  return join(ROOT, 'release', nodeArch === 'arm64' ? 'mac-arm64' : 'mac');
}

export const appPath = (nodeArch) => join(appDir(nodeArch), 'Seal Survivor.app');

// --- running things ---------------------------------------------------------

/**
 * Run a command, streaming nothing unless it fails. electron-builder is chatty
 * and almost none of it is worth reading while it works — but all of it is
 * worth reading when it doesn't, so the output is held and printed on failure.
 */
function run(label, cmd, args) {
  return new Promise((res, rej) => {
    const started = Date.now();
    process.stdout.write(`  ${label.padEnd(28)} `);
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('error', (err) => rej(new ShipMacError(`could not run ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        say(`${c.green}ok${c.off} ${c.dim}${((Date.now() - started) / 1000).toFixed(1)}s${c.off}`);
        res(buf);
        return;
      }
      say(`${c.red}FAIL${c.off}`);
      say(`\n${c.dim}${'─'.repeat(70)}${c.off}`);
      say(buf.split('\n').slice(-40).join('\n'));
      rej(new ShipMacError(`${label} failed (exit ${code})`));
    });
  });
}

/**
 * Build the Mac app.
 *
 * @param dry  preflight and print the plan; build nothing.
 * @returns the path to the .app.
 */
export async function shipMac(opts = {}) {
  const { dry = false } = opts;
  const arch = process.arch;

  say(`${c.bold}Mac${c.off}`);

  if (process.platform !== 'darwin') {
    throw new ShipMacError('a Mac build needs macOS',
      'electron-builder can cross-build the tree, but only macOS can sign it.');
  }
  if (!existsSync(join(ROOT, 'node_modules/.bin/electron-builder'))) {
    throw new ShipMacError('electron-builder is not installed', 'Run `npm i`.');
  }
  // Checked here rather than trusted, because a missing icon is the one failure
  // electron-builder treats as ordinary: it packages the default Electron icon,
  // prints one dim line, and exits 0.
  if (!existsSync(join(ROOT, 'design/app-icon.svg'))) {
    throw new ShipMacError('design/app-icon.svg is missing',
      'The icon for all three platforms is cut from it — see tools/app-icon.mjs.');
  }

  const flag = archFlag(arch);
  const out = appPath(arch);

  if (dry) {
    say(`  ${c.dim}would build ${flag.slice(2)} into ${out.replace(ROOT + '/', '')}${c.off}`);
    return out;
  }

  await run('icon', process.execPath, ['tools/app-icon.mjs', 'desktop']);
  await run('desktop bundle', 'npm', ['run', '--silent', 'build:desktop']);
  await run(`package (${arch})`, 'node_modules/.bin/electron-builder',
    ['--dir', '--mac', flag]);

  if (!existsSync(out)) {
    throw new ShipMacError(`electron-builder reported success but there is no app at ${out}`,
      'Check directories.output in electron-builder.yml against appDir() here.');
  }
  // Proof that the icon actually made it in, rather than that we asked for one.
  // electron-builder's default-icon fallback is silent enough that "we ran the
  // generator" is not evidence the .app has it.
  const icns = join(out, 'Contents/Resources/icon.icns');
  const iconOk = existsSync(icns) && statSync(icns).size > 0;

  say(`\n${c.green}✓ ${out.replace(ROOT + '/', '')}${c.off}`);
  if (!iconOk) {
    say(`  ${c.yellow}no icon.icns in the bundle — it is wearing the default Electron icon${c.off}`);
  }
  say(`  ${c.dim}open "${out}"${c.off}`);
  return out;
}

// --- CLI --------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  try {
    await shipMac({ dry: argv.includes('--dry') });
  } catch (err) {
    if (!(err instanceof ShipMacError)) throw err;
    say(`\n${c.red}✗ ${err.message}${c.off}`);
    if (err.hint) say(`${c.dim}  ${err.hint}${c.off}`);
    process.exit(1);
  }
}
