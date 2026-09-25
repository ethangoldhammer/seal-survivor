// ============================================================================
// SEALITAIRE, IN THE GAME — the Klondike table behind the Club seal panel.
//
// A WHOLE SECOND PROGRAM, not a mode. Blubberball is this game with a flag on
// (systems/versus.js, the same run loop reading a second seal state); this is
// rive/sealitaire — 8,000 lines of Luau and ten WGSL passes — running in
// Rive's renderer on its own canvas over the top of everything. The only
// thing the game gives it is a rectangle and the keys back out.
//
// So this file is small on purpose. It mounts, it sizes, it unmounts. Every
// rule, every spring, every shader is on the other side of the .riv, and the
// authoring loop for all of it is `npm run sealitaire`.
//
// ---------------------------------------------------------------------------
// FOUR THINGS MAKE IT RUN ON THE WEB AT ALL, and every one of them is
// undocumented. None is defensive; drop any and the table is a black
// rectangle that still reports as loaded.
//
//   enableGPUCanvas: true   THE one that matters, and it is not in rive.d.ts
//                           or in any doc — the only trace of it anywhere is
//                           a warning string inside the minified runtime. It
//                           imports the file through a deferred session,
//                           which is what gives a script a RenderContext.
//                           Without it `context:canvas()` throws
//                           "requires a RenderContext — call
//                           setRenderContext() first", every shader pass is
//                           dead, and table.luau quietly falls back to the
//                           flat path it keeps for headless verify: cards on
//                           a plain background, no water, no seal. That is a
//                           playable-looking table, which is what makes it
//                           dangerous to lose.
//
//   Fit.Layout              The artboard is fill-sized and the script reads
//                           its own size in `resize`. Only Fit.Layout on this
//                           class calls it. Any other fit — or driving the
//                           advanced runtime by hand — lays the table out
//                           into a zero rect: it deals, it runs, it draws
//                           nothing.
//
//   the WEBGL2 package      Same reason statsCard.js uses it, and a harder
//                           one here: the Canvas2D build answers
//                           `context:gpuCanvas()` with "requires a
//                           RIVE_CANVAS + RIVE_ORE build". There is no
//                           Canvas2D version of this table.
//
//   a signed .riv           Scripts unsigned by `--publish` are rejected by
//                           the web runtimes and nothing local says so — the
//                           CLI viewer plays them happily. `npm run
//                           sealitaire:ship` publishes and copies; `npm run
//                           sealitaire` (watch, unsigned) does not, so never
//                           ship the watcher's build.
//
// And one on the .riv's side: rive/sealitaire/table-cards.rml must keep a
// name that sorts after scene.rml, or every script in the build dies. Its own
// header says why and `npm run test:rmlorder` guards it.
//
// ---------------------------------------------------------------------------
// FETCHED, NOT BUNDLED. It is 19 MB — bigger than the rest of the game put
// together — so it is a file in public/ pulled on demand, not an import. A
// player who never opens Club seal never pays for it, and the runtime wasm is
// a dynamic import for the same reason. The trade is a wait on first open,
// which `onProgress` is for.
// ============================================================================
import { uiText } from '../uiTextTable.js';
// Root-absolute, then rebased — itch.io serves the build from a subdirectory,
// where a bare 'sealitaire.riv' resolves against whatever page asked for it.
// See assetPath.js; every media path in the game goes through this.
import { assetUrl } from '../assetPath.js';

/** What the game needs sealitaire.riv to contain. */
export const SEALITAIRE_ARTBOARD = 'Sealitaire';
export const SEALITAIRE_MACHINE = 'State Machine 1';

/** Where `npm run sealitaire:ship` puts it. */
const RIV_URL = assetUrl('/sealitaire.riv');

let mounted = null;

// ---------------------------------------------------------------------------
// THE PIXEL RATIO IS CAPPED. The table is about eight full-screen shader passes
// a frame (water, surface, seal x2, mask, scene, CRT, plus the half-size goo and
// foam), every one of them sized in DEVICE pixels — table.luau's resize builds
// them at layout size x this ratio. A 3x phone is 2.25x the pixels of 2x for a
// difference nobody can see at arm's length, and a fullscreen 5K window is 14M
// pixels a pass. So: never more than 2, and never more than PIXEL_BUDGET device
// pixels, whichever is lower. An ordinary retina laptop sits under both and
// renders exactly as before.
const MAX_DPR = 2;
const PIXEL_BUDGET = 3840 * 2160;
function tableDpr(canvas) {
  const want = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const { width, height } = canvas.getBoundingClientRect();
  const area = width * height;
  if (!area) return want;
  return Math.max(1, Math.min(want, Math.sqrt(PIXEL_BUDGET / area)));
}

// A RESIZE REBUILDS EVERY GPU CANVAS in table.luau, so a window drag or a phone
// rotation must not fire one per event. Until it settles the browser stretches
// the last frame to the new box, which is clean — the layout and the canvases
// stay in step, just at the old size for a moment.
const RESIZE_SETTLE_MS = 150;

/**
 * Is the table available in this build? False when the .riv was never
 * shipped — a dev tree that has not run `npm run sealitaire:ship`. The menu
 * row reads this so it can stay a stub rather than offer a button that opens
 * a black screen, the same way the online Blubberball row waits on
 * `roomsAvailable()`.
 */
export async function sealitaireAvailable() {
  try {
    const res = await fetch(RIV_URL, { method: 'HEAD' });
    // Pages' SPA fallback answers a missing asset with 200 and index.html, so
    // the status is not the check — the content type is.
    return res.ok && !String(res.headers.get('content-type') || '').includes('text/html');
  } catch {
    return false;
  }
}

/**
 * Put the table on screen. Resolves once it is drawing.
 *
 * `onExit` is what the back button does — closing is the game's business, not
 * the table's, because what it goes back TO is the menu's state and this file
 * knows nothing about that. `onPause` is Escape, and it is a separate hook for
 * exactly the same reason: the pause menu is the game's panel (ui/pauseMenu.js)
 * and what its three buttons mean is main.js's to decide.
 */
export async function showSealitaire({ parent, onExit, onPause, onProgress } = {}) {
  if (mounted) return mounted;

  const wrap = document.createElement('div');
  wrap.className = 'sv-sealitaire';
  wrap.innerHTML = `
    <canvas class="sv-sealitaire-canvas"></canvas>
    <button class="sv-btn sv-sealitaire-back" type="button"></button>
    <div class="sv-sealitaire-loading"></div>
  `;
  const canvas = wrap.querySelector('.sv-sealitaire-canvas');
  const back = wrap.querySelector('.sv-sealitaire-back');
  const loading = wrap.querySelector('.sv-sealitaire-loading');
  back.textContent = uiText('sealitaireBack');
  loading.textContent = uiText('sealitaireLoading');
  (parent || document.body).appendChild(wrap);

  const exit = () => { hideSealitaire(); if (typeof onExit === 'function') onExit(); };
  back.addEventListener('click', exit);
  // ESCAPE IS THE TABLE'S OWN, and it has to be captured: table.luau takes
  // the keyboard for its own shortcuts (N deals, T opens its tuner) through
  // the artboard's FocusData, so a bubbling listener never sees the key.
  //
  // IT OPENS THE PAUSE MENU NOW rather than leaving outright. main.js's own
  // Escape handler cannot do this job — it runs through togglePause(), which
  // is gated on canPause(), which is false while the game is parked behind
  // the table. So the key has to be answered here and handed out.
  //
  // The back button is untouched and still leaves in one press, to the Seal
  // sports list it came from. The menu's way out goes to the MAIN menu, which
  // is a different place: two routes, each landing where its own word says.
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    if (typeof onPause === 'function') onPause();
    else exit();
  };
  window.addEventListener('keydown', onKey, true);

  // The runtime and the file in parallel — the wasm is ~2 MB and the .riv
  // ~19 MB, so the wasm is never the long pole and there is no reason to
  // wait on one before starting the other.
  const [{ Rive, Layout, Fit, Alignment }] = await Promise.all([
    import('@rive-app/webgl2'),
    import('./riveRuntimeGl.js'),
  ]);

  const bytes = await fetchRiv(onProgress);

  const rive = new Rive({
    buffer: bytes,
    canvas,
    artboard: SEALITAIRE_ARTBOARD,
    stateMachine: SEALITAIRE_MACHINE,
    autoplay: true,
    autoBind: true,
    // See the header. This is the line the whole table hangs on.
    enableGPUCanvas: true,
    // THE TABLE'S OWN KEYBOARD. Its shortcuts go through the artboard's
    // FocusData, and a canvas with no tabindex can never be focused — so
    // without this every one of them is dead in the browser and only in the
    // browser: T (the tuner, which is where the volume sliders are), N, M, W,
    // R and J/K/L all work in the CLI viewer and silently do nothing here.
    // The runtime polls focus itself once the element can hold it.
    tabIndex: 0,
    layout: new Layout({ fit: Fit.Layout, alignment: Alignment.Center }),
    onLoad: () => {
      loading.remove();
      rive.resizeDrawingSurfaceToCanvas(tableDpr(canvas));
      // Focused on arrival, so the shortcuts work without a click first, and
      // refocused on every press: clicking a card must not hand focus back to
      // whatever the menu left it on.
      canvas.focus();
    },
  });

  canvas.addEventListener('pointerdown', () => canvas.focus());

  let settle = 0;
  const onResize = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (mounted?.rive === rive) rive.resizeDrawingSurfaceToCanvas(tableDpr(canvas));
    }, RESIZE_SETTLE_MS);
  };
  window.addEventListener('resize', onResize);

  mounted = { wrap, rive, onResize, onKey, canvas, cancelSettle: () => clearTimeout(settle) };
  return mounted;
}

/**
 * STOP THE TABLE. `rive.pause()` drops the runtime's own rAF, so the artboard
 * stops advancing entirely — the clock stops, the water stops, the seal stops
 * — and the last frame stays on the canvas under the menu. Nothing here has to
 * reach into the Luau for it: not advancing IS the pause.
 */
export function pauseSealitaire() {
  if (!mounted) return;
  try { mounted.rive.pause(); } catch { /* already gone */ }
}

/** Start it again, and give the keyboard back to the artboard's FocusData. */
export function resumeSealitaire() {
  if (!mounted) return;
  try {
    mounted.rive.play();
    // Or the table's own shortcuts (N, T, M, W, R, J/K/L) are dead on the far
    // side of a pause: the menu took focus to a DOM button on the way in.
    mounted.canvas.focus();
  } catch { /* already gone */ }
}

/**
 * Deal a fresh game.
 *
 * A COUNTER ON THE VIEW MODEL, bumped — scene.rml's `deal` property, watched
 * by table.luau's advance. Not a flag, so nothing has to set it back; see the
 * property's own note. Returns false when the binding is not there, which is
 * a .riv older than the property: the caller resumes rather than leaving the
 * player on a menu whose middle button did nothing.
 *
 * PLAY FIRST. A paused artboard does not advance, and a counter nobody reads
 * is not a deal — so the caller resumes and the very next frame sees it.
 */
export function sealitaireRedeal() {
  if (!mounted) return false;
  try {
    const deal = mounted.rive.viewModelInstance?.number('deal');
    if (!deal) return false;
    deal.value += 1;
    return true;
  } catch {
    return false;
  }
}

/**
 * The .riv as bytes, reporting progress. Fetched rather than handed to Rive
 * as a url so there is something to report: 19 MB on a phone is a wait, and a
 * blank screen for ten seconds reads as broken.
 */
async function fetchRiv(onProgress) {
  const res = await fetch(RIV_URL);
  if (!res.ok) throw new Error(`sealitaire.riv: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || typeof onProgress !== 'function') {
    return new Uint8Array(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got / total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Take it down and give the GL context back.
 *
 * `cleanup()` is not optional and not a nicety: this holds a second WebGL2
 * context alive for as long as it is up — the reason the boss bar and the
 * polaroid have never moved off the Canvas2D runtime — and the deferred
 * session holds GPU resources the artboard's own teardown does not know
 * about.
 */
export function hideSealitaire() {
  if (!mounted) return;
  const { wrap, rive, onResize, onKey, cancelSettle } = mounted;
  mounted = null;
  cancelSettle();
  window.removeEventListener('resize', onResize);
  window.removeEventListener('keydown', onKey, true);
  try { rive.cleanup(); } catch { /* already gone */ }
  wrap.remove();
}

/** Is the table up? The menu asks before deciding what Back means. */
export function sealitaireOpen() {
  return !!mounted;
}
