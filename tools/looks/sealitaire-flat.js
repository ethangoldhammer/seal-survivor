// SEALITAIRE'S LUAU HALF, RUNNING IN A BROWSER. Scratch harness, not a
// shipped page: it loads a build of rive/sealitaire with the ten .wgsl files
// removed and `self.gpu` forced false, which pins draw() to the flat-table
// fallback it already carries for headless verify. Real rules, real layout,
// real card artboards; no water, no goo, no CRT, no seal.
//
// The high-level `Rive` class on purpose: Fit.Layout is what resizes a
// fill-sized artboard and calls the script's `resize`, and nothing in the
// advanced API does that for you — drive the advanced path by hand and the
// table lays itself out into a zero rect, the deal still happens, and the
// screen stays empty. The advanced path is only needed for a file WITH
// shaders, and this build has none.
import { Rive, Layout, Fit, Alignment } from '@rive-app/webgl2';
import '../../path/src/ui/riveRuntimeGl.js';

const canvas = document.getElementById('c');
const src = new URLSearchParams(location.search).get('riv') || '/assets/seal-flat.riv';

const r = new Rive({
  src,
  canvas,
  artboard: 'Sealitaire',
  stateMachine: 'State Machine 1',
  autoplay: true,
  autoBind: true,
  // THE SWITCH. Undocumented in the .d.ts and found in a warning string:
  // it makes RiveFile import through a deferred session, which is what gives
  // a script a RenderContext. Without it context:canvas() throws and buildGpu
  // fails, so every shader pass is dead and the table falls back to flat.
  enableGPUCanvas: true,
  layout: new Layout({ fit: Fit.Layout, alignment: Alignment.Center }),
  onLoad: () => { r.resizeDrawingSurfaceToCanvas(); },
});
window.addEventListener('resize', () => r.resizeDrawingSurfaceToCanvas());
window.__rive = r;
