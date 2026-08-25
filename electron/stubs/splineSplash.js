// ============================================================================
// A SPLINE SPLASH THAT CANNOT MOUNT — the desktop build's replacement for
// path/src/ui/splineSplash.js.
//
// ui/ui.js imports mountSplineSplash STATICALLY, so the specifier has to
// resolve to something even though the stubbed chooser beside this file can
// never select it. This is that something, and it exists only to keep the real
// module — and the unpkg URL in its module body — out of the desktop bundle.
//
// IT THROWS RATHER THAN FALLING BACK TO THE RIVE CARD. A quiet fallback here
// would mean that if the chooser ever did return 'spline' on desktop, the game
// would come up looking correct and the build would be silently carrying a
// contradiction — the exact shape of failure this whole port keeps running
// into. There is no way to reach this function that is not a bug in the build
// configuration, so it says so where it happens.
// ============================================================================

export function mountSplineSplash() {
  throw new Error(
    '[splineSplash] the desktop build has no Spline runtime — '
    + 'vite.desktop.config.js stubs the chooser to always pick the Rive card, '
    + 'so this should be unreachable. Something is selecting the Spline splash.',
  );
}
