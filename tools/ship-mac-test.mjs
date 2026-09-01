#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:shipmac
//
// THE MAC HALF OF THE ONE BUTTON — the parts of it that can be checked without
// spending a minute packaging an app.
//
// What is worth asserting here is narrow and specific, because the expensive
// part (electron-builder actually running) is not something a gate should do on
// every ship. Three things can be wrong in a way that produces a build rather
// than an error:
//
//   THE ARCH FLAG. electron-builder ignores a flag it does not recognise and
//   builds its configured default instead — which is both architectures, on a
//   command whose entire purpose was to build one and be quick about it.
//
//   WHERE THE .app LANDS. arm64 goes to `mac-arm64` and x64 to plain `mac`, an
//   asymmetry in electron-builder that nothing warns about. Guess it wrong and
//   the build succeeds while the "did it work" check reports a missing app.
//
//   THE ICON TARGET FILTER. `node tools/app-icon.mjs desktop` exists so the
//   desktop pack does not rewrite the iOS icon set and leave a dirty tree. A
//   typo'd target that silently wrote everything, or nothing, would be found
//   either by a confusing git status or by a Mac app wearing Electron's icon.
//
//   node tools/ship-mac-test.mjs
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { archFlag, appDir, appPath, ShipMacError } from './ship-mac.mjs';

const ROOT = resolve(import.meta.dirname, '..');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

console.log('\nSHIP:MAC — the one button\'s desktop third');

// ---------------------------------------------------------------------------
section('the architecture flag');
{
  check('arm64 asks for --arm64', archFlag('arm64') === '--arm64');
  check('x64 asks for --x64', archFlag('x64') === '--x64');
  let threw = null;
  try { archFlag('mips'); } catch (err) { threw = err; }
  check(
    'an arch with no Mac build throws rather than defaulting',
    threw instanceof ShipMacError,
    'an unrecognised flag would make electron-builder build BOTH arches instead',
  );
  check('and the error carries its fix', typeof threw?.hint === 'string' && threw.hint.length > 0);
}

// ---------------------------------------------------------------------------
section('where the app lands');
{
  check('arm64 goes to release/mac-arm64', basename(appDir('arm64')) === 'mac-arm64');
  check('x64 goes to release/mac', basename(appDir('x64')) === 'mac', "electron-builder's own asymmetry");
  check(
    'both sit under release/',
    appDir('arm64').startsWith(join(ROOT, 'release')) && appDir('x64').startsWith(join(ROOT, 'release')),
    "matching directories.output in electron-builder.yml",
  );
  check(
    'the app is named for productName',
    basename(appPath('arm64')) === 'Seal Survivor.app',
    'electron-builder names the bundle from electron-builder.yml, not package.json',
  );
}

// ---------------------------------------------------------------------------
section('the icon the build depends on');
{
  check(
    'the art all three platforms are cut from is present',
    existsSync(join(ROOT, 'design/app-icon.svg')),
    'ios icon set, web favicon and build/icon.png come from this one file',
  );
  check(
    'electron-builder has an icon to find',
    existsSync(join(ROOT, 'build/icon.png')),
    'without it the .app silently wears the default Electron icon',
  );
}

// ---------------------------------------------------------------------------
section('the icon generator only writes what it was asked for');
{
  const run = (...args) => spawnSync(process.execPath, ['tools/app-icon.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8',
  });

  const bogus = run('windows');
  check(
    'an unknown target is refused',
    bogus.status === 1,
    'silently writing all three, or none, is the failure this prevents',
  );
  check('and it names what it expected', /expected any of/.test(bogus.stderr), bogus.stderr.trim().slice(0, 60));

  const desktop = run('desktop');
  check('a desktop-only run succeeds', desktop.status === 0);
  check(
    'and writes only the Mac icon',
    desktop.stdout.includes('build/icon.png')
      && !desktop.stdout.includes('ios AppIcon')
      && !desktop.stdout.includes('apple-touch-icon')
      && !desktop.stdout.includes('Splash.imageset'),
    'a pack that rewrote ios/ would leave a dirty tree behind a Mac-only build',
  );
}

console.log(
  failures
    ? `\n${failures} failure${failures === 1 ? '' : 's'}.\n`
    : '\nThe Mac build knows its arch, its output path and its icon.\n',
);
process.exit(failures ? 1 : 0);
