// ============================================================================
// THE BRIDGE — the only thing the game can see of the shell it is running in.
//
// CommonJS, and a .cjs extension specifically: package.json says
// "type": "module", so a plain .js here would be parsed as ESM, and a
// SANDBOXED preload must be CommonJS. The failure is not a clear one — the
// preload throws before it runs, the renderer loads perfectly, and the only
// symptom is that `window.sealDesktop` is undefined, which every caller in
// path/src is written to treat as "this is a browser". So the desktop build
// would run as a slightly wrong web build and never say so.
//
// Sandboxed with contextIsolation on, which means this file can require
// exactly two things from Electron and nothing from the app. That is the point:
// the renderer runs a third-party runtime (the Spline splash) inside itself,
// and the surface it can reach into the main process should be this small.
// ============================================================================

const { contextBridge } = require('electron');

// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT ON THIS OBJECT.
//
// Identity only, for now. path/src/platform.js reads `isDesktop` to answer
// isDesktopShell(), and — critically — reads a SEPARATE key per capability, so
// that a shell which has not implemented something yet answers "no" rather
// than "yes, and then nothing happens".
//
// That distinction is the entire lesson of systems/nativeShare.js: on iOS,
// canShareImages() returns true the moment a native shell is detected, which
// hides the save button on the grounds that the OS sheet covers it. A shell
// that claims a capability it does not have does not merely fail to do the
// thing — it removes the fallback that would have worked.
//
// So `saveImage` is deliberately ABSENT until the main process actually
// implements a save dialog. canSaveThroughOS() is false until then, and the
// score screen keeps its browser-side save path.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('sealDesktop', {
  isDesktop: true,
  // The OS, for the playtest ledger's device profile. A Steam build's runs
  // come from three quite different machines (Windows, macOS, and the Deck
  // reporting as linux) and averaging them together is how a Deck-only frame
  // rate problem stays invisible.
  os: process.platform,
  electron: process.versions.electron,
});
