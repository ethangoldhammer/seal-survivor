// ============================================================================
// HANDING A PICTURE TO iOS from inside the native shell.
//
// The web build's route out is navigator.share, and the long note above
// handOver() in systems/bossShot.js is the record of how carefully that had to
// be built. None of it transfers: this app is a WKWebView on a capacitor://
// origin, where the Web Share API is at best inconsistently present and, when
// it is, has a history of refusing files. A share button that silently does
// nothing is the exact failure that note was written about, so the native build
// does not gamble on it — it goes through the bridge, which is the same
// UIActivityViewController Safari would have opened anyway.
//
// WHY A FILE ON DISK. The Share plugin takes URIs, not Blobs — the sheet is a
// native view controller and it needs something the OS can read. So the PNG is
// written to the Cache directory first and shared from there. Cache and not
// Documents on purpose: iOS may reclaim it, which is correct for a picture
// whose only job is to survive until the sheet closes, and it keeps kill shots
// out of the user's file listing.
//
// The base64 hop is unavoidable — the bridge marshals strings, so a binary
// write has to be encoded. A kill shot is ~1.5MB, so ~2MB of base64 across the
// bridge, which is slow enough to be worth doing only on the actual tap.
// ============================================================================

let api = null;
let loading = null;
let failed = false;

/** A native shell, as opposed to any browser. False in the deployed web build. */
export function nativeShareAvailable() {
  return !!globalThis.window?.Capacitor?.isNativePlatform?.();
}

function load() {
  if (api || failed) return loading;
  loading ??= Promise.all([import('@capacitor/share'), import('@capacitor/filesystem')])
    .then(([share, fs]) => {
      api = { Share: share.Share, Filesystem: fs.Filesystem, Directory: fs.Directory };
    })
    .catch((err) => {
      failed = true;
      console.warn('[nativeShare] bridge unavailable —', err?.message ?? err);
    });
  return loading;
}

// Warmed at module load so the first tap pays for the encode and nothing else.
// The sheet does NOT need transient activation the way navigator.share does —
// it is a native presentation, not a web API — so unlike the web path there is
// no deadline here, only a delay the player would feel.
if (nativeShareAvailable()) load();

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image'));
    // readAsDataURL gives "data:image/png;base64,AAAA..." and the plugin wants
    // only the payload. Split on the first comma rather than a fixed offset:
    // the prefix varies with the blob's type, and slicing past it by count is
    // how you get a file that is valid base64 and not a PNG.
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

/**
 * Put `blob` in front of the iOS share sheet.
 *
 * @returns 'shared' once the sheet has been dealt with, or null if this is not
 *          a native build or the bridge could not be reached — in which case
 *          the caller should fall through to its own web route rather than
 *          telling the player anything happened.
 */
export async function nativeShareImage(blob, name, title, text) {
  if (!blob || !nativeShareAvailable()) return null;
  await load();
  if (!api) return null;

  try {
    const data = await toBase64(blob);
    if (!data) return null;
    const { uri } = await api.Filesystem.writeFile({
      path: name,
      data,
      directory: api.Directory.Cache,
    });
    await api.Share.share({ title, text, files: [uri] });
    return 'shared';
  } catch (err) {
    // The plugin reports a dismissed sheet as an error, and a player closing
    // the sheet is not a failure — it must not fall through to a second
    // attempt at handing them the same picture. Matched on the message because
    // the bridge does not give it a name the way an AbortError has one.
    const message = err?.message ?? String(err);
    if (/cancel/i.test(message)) return 'cancelled';
    console.warn(`[nativeShare] sheet failed — ${message}`);
    return null;
  }
}
