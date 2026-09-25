// ============================================================================
// WETRIS, IN THE GAME — the stacker behind the Club seal panel.
//
// A STUB, and sealitaireTable.js's twin on purpose: rive/wetris is a second
// program in the same shape as rive/sealitaire (a fill-sized artboard, one
// ScriptedLayout that owns every pixel and key), so it mounts the same way —
// its own WebGL2 canvas over everything, Fit.Layout so the script is handed
// the window's size, a tabindex so its keys arrive, and a signed .riv fetched
// from public/ only when somebody presses the row. Read that file's header for
// why each of those is load-bearing; every reason holds here.
//
// enableGPUCanvas IS THE LINE THE WATER HANGS ON, exactly as it is for the
// card table: board.luau draws sealitaire's vortex, goo, foam and surface
// passes into GPU canvases, and without the flag `context:gpuCanvas()` throws,
// the board catches it and falls back to its flat draw — blocks on navy, a
// playable-looking game with no sea in it, and nothing in the console but one
// "drawing flat" line.
// ============================================================================
import { uiText } from '../uiTextTable.js';
import { assetUrl } from '../assetPath.js';

/** What the game needs wetris.riv to contain. */
export const WETRIS_ARTBOARD = 'Wetris';
export const WETRIS_MACHINE = 'State Machine 1';

/** Where `npm run wetris:ship` puts it. */
const RIV_URL = assetUrl('/wetris.riv');

let mounted = null;

/**
 * Is the board in this build? False until `npm run wetris:ship` has run, so
 * the menu row stays a greyed stub rather than a button onto a black screen.
 */
export async function wetrisAvailable() {
  try {
    const res = await fetch(RIV_URL, { method: 'HEAD' });
    // Pages' SPA fallback answers a missing asset with 200 and index.html.
    return res.ok && !String(res.headers.get('content-type') || '').includes('text/html');
  } catch {
    return false;
  }
}

/**
 * Put the board on screen. `onExit` is the back button and `onPause` is
 * Escape — where either goes is the menu's business, not this file's. Both
 * hooks are sealitaireTable.js's, for the reasons its own header gives.
 */
export async function showWetris({ parent, onExit, onPause } = {}) {
  if (mounted) return mounted;

  // Sealitaire's classes: the same full-screen opaque layer, the same
  // pointer-events rule, the same corner for Back.
  const wrap = document.createElement('div');
  wrap.className = 'sv-sealitaire sv-wetris';
  wrap.innerHTML = `
    <canvas class="sv-sealitaire-canvas"></canvas>
    <button class="sv-btn sv-sealitaire-back" type="button"></button>
    <div class="sv-sealitaire-loading"></div>
  `;
  const canvas = wrap.querySelector('canvas');
  const back = wrap.querySelector('button');
  const loading = wrap.querySelector('.sv-sealitaire-loading');
  back.textContent = uiText('wetrisBack');
  loading.textContent = uiText('wetrisLoading');
  (parent || document.body).appendChild(wrap);

  // Captured, as on the card table: the board takes the keyboard through its
  // FocusData, so a bubbling listener never sees Escape. Removed by exit
  // itself as well as by hideWetris, because Back can be pressed while the
  // file is still downloading — before there is a `mounted` to tear down.
  // Escape opens the pause menu, not the door — see sealitaireTable.js. It
  // still leaves outright when nobody is listening, which is the case while
  // the file is downloading and there is no board to pause yet.
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // A rebind prompt's cancel — see sealitaireTable.js.
    if (e.defaultPrevented) return;
    e.stopPropagation();
    e.preventDefault();
    if (mounted && typeof onPause === 'function') onPause();
    else exit();
  };
  const exit = () => {
    window.removeEventListener('keydown', onKey, true);
    wrap.remove();
    hideWetris();
    if (typeof onExit === 'function') onExit();
  };
  back.addEventListener('click', exit);
  window.addEventListener('keydown', onKey, true);

  const [{ Rive, Layout, Fit, Alignment }] = await Promise.all([
    import('@rive-app/webgl2'),
    import('./riveRuntimeGl.js'),
  ]);
  const res = await fetch(RIV_URL);
  if (!res.ok) throw new Error(`wetris.riv: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Closed while the file was in flight — nothing to mount into.
  if (!wrap.isConnected) return null;

  const rive = new Rive({
    buffer: bytes,
    canvas,
    artboard: WETRIS_ARTBOARD,
    stateMachine: WETRIS_MACHINE,
    autoplay: true,
    autoBind: true,
    // See the header.
    enableGPUCanvas: true,
    tabIndex: 0,
    layout: new Layout({ fit: Fit.Layout, alignment: Alignment.Center }),
    onLoad: () => {
      loading.remove();
      rive.resizeDrawingSurfaceToCanvas();
      canvas.focus();
    },
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());
  const onResize = () => rive.resizeDrawingSurfaceToCanvas();
  window.addEventListener('resize', onResize);

  mounted = { wrap, rive, onResize, onKey, canvas };
  return mounted;
}

/** Stop the board — see pauseSealitaire, which this is the twin of. */
export function pauseWetris() {
  if (!mounted) return;
  try { mounted.rive.pause(); } catch { /* already gone */ }
}

/** Start it again, and give the keyboard back to the artboard. */
export function resumeWetris() {
  if (!mounted) return;
  try { mounted.rive.play(); mounted.canvas.focus(); } catch { /* already gone */ }
}

/**
 * Clear the board and start again. The card table's `deal` counter, by the
 * same name and the same rule — a change is the request, so nothing has to
 * reset it. Returns false when board.luau has no such property yet, which is
 * every build until it does: wetris.riv is not shipped at all right now, so
 * this path is written and untested and the caller must handle the false.
 */
export function wetrisRestart() {
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

/** Take it down and give the GL context back — see hideSealitaire. */
export function hideWetris() {
  if (!mounted) return;
  const { wrap, rive, onResize, onKey } = mounted;
  mounted = null;
  window.removeEventListener('resize', onResize);
  window.removeEventListener('keydown', onKey, true);
  try { rive.cleanup(); } catch { /* already gone */ }
  wrap.remove();
}

/** Is the board up? */
export function wetrisOpen() {
  return !!mounted;
}
