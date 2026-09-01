#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:platform
//
// WHICH SHELL THE GAME THINKS IT IS IN — path/src/platform.js.
//
// Every failure this covers is silent, and two of them remove a working
// fallback rather than merely taking a wrong branch:
//
//   THE THREE-VALUED QUESTION. Capacitor.isNativePlatform() is a boolean, and
//   "native" used to mean iOS because iOS was the only shell. If a desktop
//   build ever reports itself as a Capacitor native platform — which is what
//   @capacitor-community/electron does — then systems/nativeShare.js starts
//   writing to Directory.Cache and handing file:// URIs to a
//   UIActivityViewController that does not exist on a PC, and systems/taptic.js
//   starts addressing a Taptic Engine. isIOSShell() has to stay false there,
//   which is why the desktop test short-circuits it.
//
//   A CAPABILITY IS NOT AN IDENTITY. canShareImages() in systems/bossShot.js
//   returns true the instant it sees a native shell, and the score screen HIDES
//   THE SAVE BUTTON on the strength of it — the OS sheet is how you save on a
//   phone, so a second button would be redundant. A shell that claims a
//   capability it has not implemented therefore does not just fail to save, it
//   deletes the path that would have worked. So canSaveThroughOS() must key on
//   the capability being present, never on being on the desktop.
//
// No jsdom: platform.js imports nothing and reads globalThis.window at CALL
// time rather than at module load, precisely so it can be driven like this.
//
//   node tools/platform-test.mjs
// ---------------------------------------------------------------------------

const {
  isDesktopShell, isIOSShell, isBrowser, platformName, canSaveThroughOS, canFilePlaytest,
} = await import('../path/src/platform.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

/** Replace the global window for one scenario. `null` means no window at all. */
function setWindow(win) {
  if (win === null) {
    delete globalThis.window;
    return;
  }
  globalThis.window = win;
}

console.log('\nPLATFORM — which shell the game thinks it is in');

// ---------------------------------------------------------------------------
section('a plain browser tab');
setWindow({});
check('not desktop', isDesktopShell() === false);
check('not iOS', isIOSShell() === false);
check('is a browser', isBrowser() === true);
check('names itself web', platformName() === 'web', platformName());
check('cannot save through the OS', canSaveThroughOS() === false);
check('cannot file a run', canFilePlaytest() === false);

// ---------------------------------------------------------------------------
section('a Node harness, with no window at all');
setWindow(null);
check('not desktop', isDesktopShell() === false);
check('not iOS', isIOSShell() === false);
check('names itself web', platformName() === 'web', platformName());
check('does not throw on a missing window', true);

// ---------------------------------------------------------------------------
section('the iOS app');
setWindow({ Capacitor: { isNativePlatform: () => true } });
check('not desktop', isDesktopShell() === false);
check('is iOS', isIOSShell() === true);
check('not a browser', isBrowser() === false);
check('names itself ios', platformName() === 'ios', platformName());

// ---------------------------------------------------------------------------
section('the Electron desktop build');
setWindow({ sealDesktop: { isDesktop: true, os: 'darwin' } });
check('is desktop', isDesktopShell() === true);
check('not iOS', isIOSShell() === false);
check('not a browser', isBrowser() === false);
check('names itself desktop', platformName() === 'desktop', platformName());
check(
  'cannot save through the OS until the bridge implements it',
  canSaveThroughOS() === false,
  'the save button must stay on its browser path',
);
check(
  'cannot file a run until the bridge implements it',
  canFilePlaytest() === false,
  'systems/playtest.js stops at a true here — a false must fall through, not drop the run',
);

// ---------------------------------------------------------------------------
section('THE TRAP — a desktop shell that also reports as Capacitor native');
setWindow({
  sealDesktop: { isDesktop: true, os: 'win32' },
  Capacitor: { isNativePlatform: () => true },
});
check('is desktop', isDesktopShell() === true);
check(
  'is NOT iOS',
  isIOSShell() === false,
  'otherwise nativeShare.js hands a file:// URI to a UIActivityViewController on a PC',
);
check('names itself desktop', platformName() === 'desktop', platformName());

// ---------------------------------------------------------------------------
section('a desktop shell that HAS implemented saving');
setWindow({ sealDesktop: { isDesktop: true, os: 'linux', saveImage: () => {} } });
check('is desktop', isDesktopShell() === true);
check('can save through the OS', canSaveThroughOS() === true);
check(
  'and still cannot file a run',
  canFilePlaytest() === false,
  'each capability is its own key — one implemented does not vouch for the next',
);

// ---------------------------------------------------------------------------
section('a desktop shell that HAS implemented the run log');
setWindow({ sealDesktop: { isDesktop: true, os: 'darwin', filePlaytest: () => {} } });
check('can file a run', canFilePlaytest() === true);
check('and still cannot save through the OS', canSaveThroughOS() === false);

// ---------------------------------------------------------------------------
section('a half-built bridge — the object is there but the flag is not');
setWindow({ sealDesktop: {} });
check(
  'not desktop',
  isDesktopShell() === false,
  'an empty bridge is not a desktop shell, it is a bug — fall back to the web paths',
);
check('names itself web', platformName() === 'web', platformName());

// ---------------------------------------------------------------------------
console.log(
  failures
    ? `\n${failures} failure${failures === 1 ? '' : 's'}\n`
    : '\nAll platform checks passed.\n',
);
process.exit(failures ? 1 : 0);
