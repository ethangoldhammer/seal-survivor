// THE RIVE RENDERER'S WASM, off unpkg and into the bundle — the WebGL2 twin of
// riveRuntime.js, and a separate module for the same reason that one exists:
// `setWasmUrl` is global to ITS package, and `@rive-app/webgl2` is a different
// package with its own loader, so pointing the canvas package at a local file
// does nothing for this one.
//
// WHY THE SPLASH USES THIS PACKAGE AND THE OTHERS DO NOT (yet). Feathers — the
// soft shadows under the wordmark and the buttons — are a Rive Renderer
// feature. The Canvas2D renderer in `@rive-app/canvas` draws a feathered fill
// as a hard-edged offset copy, measured side by side at the same runtime
// version, so the splash's design only reads through WebGL2. The boss bar and
// the polaroid still ride the canvas package: the bar would hold a second GL
// context alive through every fight, and the card is read back with drawImage
// for the share image, and neither cost has been weighed yet. Two runtimes
// means two WASMs in the bundle for now; see the README when the others move.
import { RuntimeLoader } from '@rive-app/webgl2';
import wasmUrl from '@rive-app/webgl2/rive.wasm?url';

RuntimeLoader.setWasmUrl(wasmUrl);

/** The URL actually in force, so a harness can assert it is not unpkg. */
export function riveGlWasmUrl() {
  return wasmUrl;
}
