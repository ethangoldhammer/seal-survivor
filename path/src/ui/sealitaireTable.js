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
 * `onExit` is what Escape and the back button do — closing is the game's
 * business, not the table's, because what it goes back TO is the menu's
 * state and this file knows nothing about that.
 */
export async function showSealitaire({ parent, onExit, onProgress } = {}) {
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
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); exit(); } };
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
      rive.resizeDrawingSurfaceToCanvas();
      // Focused on arrival, so the shortcuts work without a click first, and
      // refocused on every press: clicking a card must not hand focus back to
      // whatever the menu left it on.
      canvas.focus();
    },
  });

  canvas.addEventListener('pointerdown', () => canvas.focus());

  const onResize = () => rive.resizeDrawingSurfaceToCanvas();
  window.addEventListener('resize', onResize);

  mounted = { wrap, rive, onResize, onKey };
  return mounted;
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
  const { wrap, rive, onResize, onKey } = mounted;
  mounted = null;
  window.removeEventListener('resize', onResize);
  window.removeEventListener('keydown', onKey, true);
  try { rive.cleanup(); } catch { /* already gone */ }
  wrap.remove();
}

/** Is the table up? The menu asks before deciding what Back means. */
export function sealitaireOpen() {
  return !!mounted;
}
