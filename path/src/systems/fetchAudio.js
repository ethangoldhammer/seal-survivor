// ============================================================================
// FETCHING A SOUND FILE, including from inside the iOS shell.
//
// THE BUG THIS EXISTS FOR. Every mp3 in the game — 164 sample files and all 22
// music loops — failed to load in the native build, and the game did exactly
// what it is designed to do when a sample is missing: fell back to the synth.
// So it was not silent, it was quietly playing the wrong thing, on every sound,
// for the whole run.
//
// The cause is in Capacitor's own asset handler (WebViewAssetHandler.swift):
//
//     if isMediaExtension(pathExtension: url.pathExtension) {
//         urlSchemeTask.didReceive(urlResponse)    // a plain URLResponse
//     } else {
//         urlSchemeTask.didReceive(httpResponse!)  // an HTTPURLResponse, 200
//     }
//
// For anything it considers media — mp3, wav, m4a, mp4 and a long list more —
// it answers with a bare `URLResponse` instead of an `HTTPURLResponse`, on
// purpose: that is what routes the bytes through WebKit's streaming media
// pipeline so an <audio> element can seek in them. A plain URLResponse has no
// status line, so `fetch()` surfaces `status: 0` and `ok: false` — while
// delivering the body perfectly intact.
//
// `if (!res.ok) throw` is the correct thing to write against a web server and
// the wrong thing here: it throws away a good buffer over a status code that
// was never sent. Hence this.
//
// WHY ACCEPTING 0 DOES NOT HIDE A MISSING FILE. On the capacitor:// scheme a
// file that is not there fails the task outright (`didFailWithError`), so the
// fetch REJECTS rather than resolving with a zero. And over http, a status of 0
// means an opaque cross-origin response, whose body is always empty — which the
// length check below turns back into an error. Compare the opposite trap in
// [[pages-spa-fallback-hides-404s]]: there a 200 was the lie, here a 0 is.
// ============================================================================

/**
 * The bytes of an audio file, or a throw naming what went wrong.
 *
 * @param src   the URL, as it appears in CONFIG
 * @param label the caller's tag for the warning it will log ('audio', 'music')
 */
export async function fetchAudioBytes(src) {
  const res = await fetch(src);
  // status 0 is the native shell's media path — see above. Anything else that
  // is not ok is a real failure and still throws.
  if (!res.ok && res.status !== 0) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  // The one way a status of 0 IS a failure: an opaque response, which resolves
  // with an empty body. Caught here rather than at the decode, where it arrives
  // as an unhelpful EncodingError about a file that is perfectly fine on disk.
  if (!bytes.byteLength) throw new Error(`empty response (HTTP ${res.status})`);
  return bytes;
}
