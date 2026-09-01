// ============================================================================
// WHICH SHELL THE GAME IS RUNNING IN — a browser, the iOS app, or the desktop
// build.
//
// A file of its own with no imports, for the same reason devices.js is one:
// the layers that need this answer (share, haptics, storage, the playtest
// ledger) must not depend on each other, and a copy of the test in each is a
// copy that drifts.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL, given Capacitor.isNativePlatform() was already here.
//
// That call is a TWO-VALUED answer to a question that now has three answers.
// Every branch keyed on it was written when "native" could only mean iOS, and
// each one encodes iOS-specific knowledge that is simply false of a desktop:
//
//   systems/nativeShare.js   writes to Directory.Cache and hands a file:// URI
//                            to UIActivityViewController.
//   systems/taptic.js        maps magnitude onto the Taptic Engine's
//                            three-weight vocabulary.
//   systems/fetchAudio.js    tolerates `status: 0` because of a quirk in
//                            Capacitor's own WebViewAssetHandler.swift.
//
// So the danger is not that isNativePlatform() would return a wrong answer on
// desktop. It is that it would be answering a question it cannot express, and
// every FUTURE `if (isNativePlatform())` — written by someone who reasonably
// reads it as "am I on the phone" — would be wrong on desktop with no compiler
// and no test to catch it.
//
// Hence isIOSShell() below, which asks what those three files actually mean,
// and which stays correct even if a desktop shell ever starts reporting itself
// as a Capacitor native platform.
// ---------------------------------------------------------------------------
// ============================================================================

/**
 * The Electron desktop build (the Steam one).
 *
 * Read off a flag the preload script sets, NOT off the user-agent string.
 * Two reasons, and the second is the one that bites: a UA is editable by
 * anything on the page, and desktop shells routinely strip the word "Electron"
 * out of theirs so that sites do not treat them as a bot — so the UA is both
 * untrustworthy and, in the configuration we are most likely to ship, absent.
 * `sealDesktop` is a fact our own shell asserts about itself over the context
 * bridge, and nothing else can forge it.
 */
export function isDesktopShell() {
  return !!globalThis.window?.sealDesktop?.isDesktop;
}

/**
 * The iOS app specifically — which is what every existing `isNativePlatform()`
 * branch in this codebase was actually asking about.
 *
 * The desktop test comes FIRST and short-circuits. That ordering is the whole
 * point of the file: it means that if a desktop shell is ever built on
 * something that reports itself as a Capacitor native platform, the iOS-only
 * paths stay switched off rather than quietly running their WKWebView logic on
 * a machine that has never had a Taptic Engine in it.
 */
export function isIOSShell() {
  if (isDesktopShell()) return false;
  return !!globalThis.window?.Capacitor?.isNativePlatform?.();
}

/** A plain browser tab — the deployed web build. */
export function isBrowser() {
  return !isDesktopShell() && !isIOSShell();
}

/**
 * The single word for this platform, for anything that records or reports
 * rather than branches — the playtest ledger's device profile above all.
 *
 * A string rather than a boolean because that field's whole job is telling
 * three populations apart after the fact, and `runs.jsonl` is append-only: a
 * run filed under the wrong platform cannot be corrected later.
 */
export function platformName() {
  if (isDesktopShell()) return 'desktop';
  if (isIOSShell()) return 'ios';
  return 'web';
}

/**
 * Can this shell put a file somewhere the player will find it, through a real
 * OS save dialog?
 *
 * Asked separately from platformName() because it is the question the score
 * screen actually needs, and because the answer is a capability rather than an
 * identity — a desktop build with the bridge missing must answer no and fall
 * through to the browser's own download path rather than hiding the button
 * that still works.
 */
export function canSaveThroughOS() {
  return !!globalThis.window?.sealDesktop?.saveImage;
}

/**
 * Can this shell write a finished run somewhere a terminal can read it?
 *
 * A capability rather than an identity, for the same reason as the one above
 * and with a sharper edge: systems/playtest.js treats a true here as "this run
 * is filed, stop", so a shell that claimed it and did nothing would not merely
 * fail to write the run — it would suppress the destinations that still worked
 * and lose the record entirely. Keyed on the bridge function, which exists only
 * while electron/playtest.js really registers its handler.
 */
export function canFilePlaytest() {
  return !!globalThis.window?.sealDesktop?.filePlaytest;
}
