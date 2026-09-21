// ============================================================================
// CAN SEALITAIRE RUN IN THE BROWSER YET? — the one-command answer.
//
//   npm run sealitaire:web
//
// Sealitaire is the fifth row of the Club seal panel (`sportSealitaire` in
// ui/ui.js), greyed out with "coming soon" under it. This page decides when
// that row can be wired up: it mounts the real sealitaire.riv the strongest
// way the web runtime allows and prints whether the scripts ran.
//
// AS OF 2026-09-20, WITH RUNTIME 2.42.2, THE ANSWER IS NO. The file loads and
// reports its artboards; every Luau script in it is dead, with
// `ScriptAsset doesn't have a generator function <name>` on the console, and
// the artboard draws its background fill and nothing else.
//
// IT TAKES TWO INGREDIENTS AND NEITHER IS ENOUGH ALONE. Bisected against a
// scratch copy of rive/sealitaire, one publish at a time:
//
//   1. a WGSL shader in the file — ANY shader, including a twelve-line one
//      that nothing references. Move the ten .wgsl files out and the script
//      runs.
//   2. cards.rml — the thirteen card-face artboards and their Corner/Plate.
//      Leave the shader in and drop that one markup file, and the script
//      runs.
//
// Remove either and it works; put both back and it dies. What in cards.rml
// does it is not yet known.
//
// THE WHOLE PROGRAM RUNS ON THE WEB ALREADY, which is the useful half of
// this. The real table.luau — all 4,346 lines, the eight modules, klondike's
// rules, layout.luau, all 24 artboards and cards.rml — loads and deals a hand
// in the browser as soon as the ten .wgsl files are out of the build:
// `sealitaire: deal seed …` on the console, no crash, nothing after it. The
// Luau half is not the obstacle and never was. Nothing is on screen because
// every pixel the table produces goes through crt.wgsl, which composites the
// water, the cards and the seal — with the shaders gone the program is alive
// with nothing to show for it.
//
// That pair IS the bug report: the real project with *.wgsl moved out runs,
// and the same project with one twelve-line unreferenced shader put back has
// every script in it dead.
//
// WHAT IT IS NOT. Each of these was ruled out by removing it and watching the
// failure survive, so do not re-run them:
//
//   * table.luau. Replaced with a thirty-line square-drawing Layout: same
//     failure. Its 4,346 lines are not the cause.
//   * the eight required modules, and tests.luau. Removed: same failure.
//   * all 89 audio assets, the seal/fish meshes and music.bin. Removed: same
//     failure.
//   * size. Down to 4 MB from 19 MB: same failure.
//   * the twenty <ScriptInputArtboard> children of the ScriptedLayout.
//     Removed: same failure.
//   * artboard COUNT. A scaffolded project with 26 artboards, a script and a
//     shader runs fine — so it is cards.rml's content, not how many.
//   * unsigned scripts. Real, documented, and not this: unsigned scripts ARE
//     rejected by the web runtimes and nothing local warns you (`rive docs
//     publishing`), but every file above was a `--publish` build. Necessary,
//     not sufficient. The npm script publishes, which is why it needs
//     `rive login`.
//   * the deferred session. A file holding "ore" (shader) content is meant to
//     be imported through a `makeDeferredSession()` attached to its renderer,
//     and the high-level `Rive` class never makes one — so this reads exactly
//     like the missing piece. This page does it properly and the scripts are
//     still dead. It is kept because it is the strongest configuration
//     available, and because a scaffolded project WITH a shader only runs
//     this way.
//
// THE MOUNT IS THE RIGHT SHAPE ALREADY, which is why this uses the advanced
// package: when the gate opens, ui/sealitaireTable.js is these four steps
// against the game's canvas.
//
//   1. session  = rive.makeDeferredSession()      -- feature-detect it
//   2. renderer = rive.makeRenderer(canvas)
//   3. renderer.attachSession(session)            -- BEFORE the load
//   4. file     = await rive.load(bytes, undefined, true, session)
//
// A session binds to one renderer for good and the file's mode is fixed at
// import, so a wrong order is not recoverable — re-import into a fresh
// session. Teardown is the exact reverse and is not optional: release the
// file, `detachSession()`, then `delete()` the session. Deleting an attached
// session leaves the renderer pointing at freed memory.
//
// TWO TRAPS IN THAT PATH, both of which read as the file being rejected:
// pass `undefined` and never `null` for load()'s assetLoader (a null is
// destructured into a CustomFileAssetLoader and throws "Cannot read
// properties of null (reading 'loadContents')"), and the WebGL2 renderer's
// frame is `clear()`/`flush()`, not the Canvas2D wrapper's `beginFrame()`.
//
// WHEN TO RE-RUN: after `npm i` bumps @rive-app/webgl2-advanced, or when Rive
// says this is fixed. Green here is the day `sportSealitaire` stops being a
// stub.
//
//   ?riv=/assets/other.riv&ab=Artboard    load some other file instead
// ============================================================================
import RiveWasm from '@rive-app/webgl2-advanced';
import wasmUrl from '@rive-app/webgl2-advanced/rive.wasm?url';
import rivUrl from '../../rive/sealitaire/build/sealitaire.riv?url';

const say = document.getElementById('say');
const note = (msg, cls) => {
  const p = document.createElement('p');
  p.textContent = msg;
  if (cls) p.className = cls;
  say.appendChild(p);
  return p;
};

// The runtime reports a dead script to the console and carries on, so the only
// way to know is to watch console.error — the file "loads" either way.
const scriptErrors = [];
const realError = console.error.bind(console);
console.error = (...a) => {
  const line = a.join(' ');
  if (line.includes('generator function')) scriptErrors.push(line);
  realError(...a);
};

const params = new URLSearchParams(location.search);
const src = params.get('riv') || rivUrl;
const wantArtboard = params.get('ab') || 'Sealitaire';
const canvas = document.getElementById('c');

note(`@rive-app/webgl2-advanced · artboard "${wantArtboard}"`);

const rive = await RiveWasm({ locateFile: () => wasmUrl });

// Feature-detected, because the doc says so: it is only present in builds with
// deferred rendering compiled in, and a build without it is exactly the case
// this page exists to detect.
const session = rive.makeDeferredSession?.();
if (!session) note('makeDeferredSession() is absent from this build.', 'bad');

const renderer = rive.makeRenderer(canvas);
const attached = session ? renderer.attachSession?.(session) : false;
note(`deferred session: ${session ? (attached ? 'attached' : 'CREATED BUT NOT ATTACHED') : 'none'}`,
     session && attached ? null : 'bad');

const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
// `undefined`, NOT `null`, for the asset loader: the runtime destructures it
// into a CustomFileAssetLoader, so a null there throws "Cannot read properties
// of null (reading 'loadContents')" from inside load() — which reads exactly
// like the file being rejected and is not.
const file = await rive.load(bytes, undefined, true, session ?? null);

note(`file: ${file ? 'loaded' : 'NULL'} · artboards ${file?.artboardCount?.()}`);
window.__riveModuleKeys = Object.keys(rive).filter((k) => /script|ore|vm|gpu|shader|defer/i.test(k));
note(`module hooks: ${window.__riveModuleKeys.join(', ') || '(none)'}`);
let artboard = null;
try { artboard = file.artboardByName(wantArtboard); } catch (e) { note(`artboardByName threw: ${e}`, 'bad'); }
if (!artboard) { try { artboard = file.defaultArtboard(); } catch (e) { note(`defaultArtboard threw: ${e}`, 'bad'); } }
if (!artboard) { note('NO ARTBOARD', 'bad'); throw new Error('no artboard'); }
const machine = new rive.StateMachineInstance(artboard.stateMachineByIndex(0), artboard);

// The artboard is fill-sized, so what it is laid out at IS the window: the
// script's `resize` turns that into every number in layout.luau. Sized in
// device pixels, not points, or a Retina display renders it at half
// resolution and leaves the runtime to upscale.
function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  artboard.width = canvas.width;
  artboard.height = canvas.height;
  renderer.resize?.(canvas.width, canvas.height);
}
fit();
window.addEventListener('resize', fit);

let last = 0;
let checked = false;
function frame(now) {
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  // The WebGL2 renderer's frame is clear/flush — `beginFrame` is the Canvas2D
  // wrapper's name for it and does not exist here.
  renderer.clear();
  // FIT.LAYOUT IS WHAT CALLS THE SCRIPT'S `resize`. The artboard is
  // fill-sized, so without a layout pass self.size stays (0,0) and the table
  // lays itself out into a zero rect — the scripts run, the deal happens, and
  // nothing is on screen. Setting artboard.width/height alone does not do it.
  renderer.save();
  renderer.align(
    rive.Fit.layout,
    rive.Alignment.center,
    { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height },
    { minX: 0, minY: 0, maxX: artboard.width, maxY: artboard.height },
    1,
  );
  machine.advance(dt);
  artboard.advance(dt);
  artboard.draw(renderer);
  renderer.restore();
  renderer.flush();
  if (!checked && now > 1200) {
    checked = true;
    if (scriptErrors.length) {
      note('SCRIPTS DID NOT RUN — the table cannot go on the menu yet.', 'bad');
      for (const line of new Set(scriptErrors)) note(line, 'bad');
    } else {
      note('SCRIPTS RAN. The table below is live.', 'good');
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Pointer, so the probe can actually be played rather than only looked at.
const at = (e) => {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
};
canvas.addEventListener('pointerdown', (e) => machine.pointerDown(...at(e)));
canvas.addEventListener('pointermove', (e) => machine.pointerMove(...at(e)));
canvas.addEventListener('pointerup', (e) => machine.pointerUp(...at(e)));

window.__seal = { rive, session, renderer, file, artboard, machine, scriptErrors };
