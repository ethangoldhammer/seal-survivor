// Saves an uploaded file into public/ through the dev server, so a choice
// made in the T-menu becomes a real file the game loads on every future boot.
//
// Before this, uploads only ever became an in-memory AudioBuffer / model —
// they worked for the rest of the session and were gone on reload, which is
// why uploads "didn't stick". Writing the file and then pointing the matching
// config entry at the returned URL makes the choice persist through the normal
// tuning file, exactly like any other tuned value.
//
// Only works with the dev server running (see vite.config.js). A production
// build has nowhere to write, so callers fall back to the in-memory path and
// the upload stays session-only — same graceful degradation as tuning.

let uploadUnavailable = false;

/**
 * @param {'sfx'|'music'|'models'|'textures'} dir  subfolder of public/
 * @param {File} file
 * @returns {Promise<string|null>} public URL (e.g. '/sfx/kill.mp3'), or null
 *   if there's no dev server to write through.
 */
export async function uploadAsset(dir, file) {
  if (uploadUnavailable) return null;
  try {
    const res = await fetch(
      `/__upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { src } = await res.json();
    return src ?? null;
  } catch (err) {
    // Expected when running a build rather than `npm run dev`. Warn once —
    // the caller still has a working in-memory upload for this session.
    uploadUnavailable = true;
    console.warn(
      `[upload] no dev server to save "${file.name}" to disk — it will work for this session only.`,
      err?.message ?? err,
    );
    return null;
  }
}
