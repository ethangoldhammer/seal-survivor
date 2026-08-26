// ============================================================================
// HANDING A PICTURE TO THE DESKTOP — the third route out, beside
// systems/nativeShare.js (iOS) and navigator.share (a browser).
//
// THIS SHELL HAS NO SHARE SHEET AT ALL. Measured rather than assumed: the
// desktop smoke test asks the page directly and Electron reports both
// navigator.share and navigator.canShare as undefined. So every route in
// bossShot.js currently falls through to download(), which mints a blob: URL
// and clicks an anchor — that works here, but it puts the file wherever
// Chromium's default download directory happens to be, without asking, under a
// button that said Share.
//
// A save dialog is the desktop-native shape of this: the player picks the place
// and the name, and the answer is either a file or a cancel.
//
// ---------------------------------------------------------------------------
// IT ASKS FOR THE FUNCTION, NOT FOR THE PLATFORM.
//
// available() tests canSaveThroughOS(), which tests for the bridge function
// itself — not for isDesktopShell(). The difference is the whole lesson of
// canShareImages() on iOS: that function returns true the moment a native shell
// is detected, which HIDES the save button on the grounds that the OS sheet
// covers it. A shell that claims a capability it does not have does not merely
// fail to do the thing, it removes the fallback that would have worked.
//
// So a desktop build whose main process has not wired up the handler answers
// "no" here and keeps the browser download path, rather than answering "yes"
// and doing nothing.
// ---------------------------------------------------------------------------

import { canSaveThroughOS } from '../platform.js';

/** Can this shell put a file where the player chooses? */
export function desktopSaveAvailable() {
  return canSaveThroughOS();
}

/**
 * Put `blob` in front of a real save dialog.
 *
 * @returns 'saved' once a file has been written, 'cancelled' if the player
 *          closed the dialog, or null if this is not a desktop shell or the
 *          bridge could not be reached — in which case the caller should fall
 *          through to its own route rather than telling the player anything
 *          happened.
 */
export async function desktopSaveImage(blob, name) {
  if (!blob || !desktopSaveAvailable()) return null;
  try {
    // BYTES, NOT THE BLOB. The context bridge structured-clones its arguments,
    // and a Blob does not survive that — it arrives in the main process as an
    // empty object, which writes a zero-byte PNG rather than throwing. A
    // Uint8Array crosses intact.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await window.sealDesktop.saveImage(bytes, name);
    // 'unavailable' and null both mean "this route did nothing", so they fall
    // through. 'cancelled' does NOT — the player closed the dialog on purpose,
    // and falling through would hand them a second copy of the picture through
    // the download path they were declining.
    if (result === 'saved' || result === 'cancelled') return result;
    return null;
  } catch (err) {
    console.warn('[desktopSave] could not save —', err?.message ?? err);
    return null;
  }
}
