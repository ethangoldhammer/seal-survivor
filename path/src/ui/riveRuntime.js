// Where Rive's WASM comes from.
//
// The runtime defaults to fetching a 2MB `rive.wasm` FROM UNPKG, at the moment
// the first Rive instance is constructed. That was survivable while the only
// Rive surface was the splash — it loads on a menu, before anything is at
// stake, and a slow CDN is a slow title screen. It stopped being survivable the
// moment a boss health bar was made of the same runtime: that one has to appear
// on the frame a boss arrives, five levels into a run, and "the HUD is waiting
// on a third-party CDN" is not a thing a fight can be built on. Offline, behind
// a corporate proxy, or on the deployed site with unpkg having a bad day, the
// bar simply would not exist.
//
// `?url` hands Vite the file out of node_modules and gets back a hashed path
// into our own bundle, so it ships with the game and comes off the same origin
// as everything else.
//
// A MODULE RATHER THAN A CALL EACH SURFACE MAKES. `setWasmUrl` is global to the
// runtime and only has any effect BEFORE the first instance is built, so it
// cannot belong to whichever surface happens to construct one first — the
// splash and the boss bar would then each be responsible for a setting that
// only one of them would ever actually apply. Importing this module is the
// whole contract: it runs once, at module load, ahead of any constructor.
import { RuntimeLoader } from '@rive-app/canvas';
import wasmUrl from '@rive-app/canvas/rive.wasm?url';

RuntimeLoader.setWasmUrl(wasmUrl);

/** The URL actually in force, so a harness can assert it is not unpkg. */
export function riveWasmUrl() {
  return wasmUrl;
}
