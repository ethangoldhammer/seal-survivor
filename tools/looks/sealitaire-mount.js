// AN AUDIO TAP, so the harness can answer "is the music playing" without ears.
// Rive's runtime builds its own AudioContext and routes through it; patching
// connect() BEFORE the wasm loads means every node that reaches a destination
// also reaches an analyser on the same context. Read the RMS over a few
// seconds and a 61-second track is unmistakable against silence: sfx are
// transient spikes between long zeros, a track is a continuous floor.
const taps = [];
const realConnect = AudioNode.prototype.connect;
const SOUND = new URLSearchParams(location.search).get('sound') === '1';
const mutes = new Map();
function muteFor(ctx) {
  let m = mutes.get(ctx);
  if (!m) {
    m = ctx.createGain();
    m.gain.value = 0;
    realConnect.call(m, ctx.destination);
    mutes.set(ctx, m);
  }
  return m;
}
AudioNode.prototype.connect = function (dest, ...rest) {
  try {
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      let tap = taps.find((t) => t.ctx === ctx);
      if (!tap) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        tap = { ctx, analyser, buf: new Float32Array(analyser.fftSize) };
        taps.push(tap);
      }
      realConnect.call(this, tap.analyser);
      // MUTED UNLESS ASKED (?sound=1): the tap above still hears everything —
      // it is fed before the speakers — but a harness in the Browser pane has
      // no business playing through them while someone is working.
      if (!SOUND) return realConnect.call(this, muteFor(ctx), ...rest);
    }
  } catch { /* never let the tap break the graph */ }
  return realConnect.call(this, dest, ...rest);
};

// A suspended context is silence that looks exactly like a dead decoder, so
// the tap resumes every context it finds and says whether it had to.
window.__audio = () => taps.map((t) => {
  t.analyser.getFloatTimeDomainData(t.buf);
  let sum = 0, peak = 0;
  for (const v of t.buf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  return { state: t.ctx.state, rms: Math.sqrt(sum / t.buf.length), peak };
});
window.__resume = () => Promise.all(taps.map((t) => t.ctx.resume().catch(() => {})));

// Mounts the REAL ui/sealitaireTable.js — the module the Club seal row calls —
// so the game's own mount is exercised without the menu, which the Browser
// pane cannot render. Checks the module, the uiText rows and the .riv
// together; the menu wiring above it is ui.js's business.
import { showSealitaire, sealitaireAvailable } from '../../path/src/ui/sealitaireTable.js';

// ?riv=/other.riv swaps the file WITHOUT touching the module: sealitaireTable
// addresses its own url through assetUrl, so the harness redirects the fetch
// instead. That keeps the A/B honest — same mount, same options, one asset.
const swap = new URLSearchParams(location.search).get('riv');
if (swap) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    return realFetch(url.endsWith('sealitaire.riv') ? swap : input, init);
  };
}

const say = document.getElementById('say');
const note = (m) => { const p = document.createElement('div'); p.textContent = m; say.appendChild(p); };

note(`available: ${await sealitaireAvailable()}`);
await showSealitaire({
  parent: document.getElementById('uiroot'),
  onExit: () => note('onExit fired'),
  onProgress: (f) => { say.firstChild.textContent = `loading ${(f * 100).toFixed(0)}%`; },
});
note('mounted');
