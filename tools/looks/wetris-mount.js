// Mounts the REAL ui/wetrisTable.js — the module the Club seal row calls — so
// the game's own mount runs on the web runtime without the 3-D menu, which the
// Browser pane cannot render. The twin of sealitaire-mount.js.
//
//   npm run looks:wetris        build + serve on :4757
//   ?riv=/other.riv             swap the file, same mount (the fetch is redirected)
//   ?sound=1                    let it make noise (muted otherwise)
//   ?raf=timer                  drive frames from a 16ms timer — the Browser
//                               pane runs ~2 rAF a second, so anything that
//                               waits on the board's next frames (backing
//                               out stops the music that way) needs this
//
// window.__log holds every console line, so a harness can read what the
// runtime said (a dead script, a shader that did not compile) without eyes.
import { showWetris, hideWetris, wetrisAvailable } from '../../path/src/ui/wetrisTable.js';

if (new URLSearchParams(location.search).get('raf') === 'timer') {
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}

// MUTED UNLESS ASKED (?sound=1). This page is a test harness, loaded in the
// Browser pane while someone is working, and the loop and every lock were
// coming out of their speakers. Everything bound for the speakers goes
// through one zero-gain node per context instead — the graph still runs, so a
// dead decoder is still a dead decoder; only the output is silent. Patched
// before the runtime loads (wetrisTable imports it dynamically).
if (new URLSearchParams(location.search).get('sound') !== '1') {
  const mutes = new Map();
  const realConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      let mute = mutes.get(dest.context);
      if (!mute) {
        mute = dest.context.createGain();
        mute.gain.value = 0;
        realConnect.call(mute, dest);
        mutes.set(dest.context, mute);
      }
      return realConnect.call(this, mute, ...rest);
    }
    return realConnect.call(this, dest, ...rest);
  };
}

// AN AUDIO TAP, patched AFTER the mute above so it wraps it: it sees the speakers first, so the harness can answer "is it
// still playing" without anyone hearing it: window.__audio() is each
// context's state and level. window.__hide() backs out the way the game does.
const taps = [];
{
  const realConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      let tap = taps.find((t) => t.ctx === dest.context);
      if (!tap) {
        const analyser = dest.context.createAnalyser();
        analyser.fftSize = 2048;
        tap = { ctx: dest.context, analyser, buf: new Float32Array(2048) };
        taps.push(tap);
      }
      realConnect.call(this, tap.analyser);
    }
    return realConnect.call(this, dest, ...rest);
  };
}
window.__audio = () => taps.map((t) => {
  t.analyser.getFloatTimeDomainData(t.buf);
  let sum = 0;
  for (const v of t.buf) sum += v * v;
  return { state: t.ctx.state, rms: +Math.sqrt(sum / t.buf.length).toFixed(4) };
});
window.__hide = () => hideWetris();
// And back in, the way the Club seal row does — a second mount on the same
// page, sharing the first one's audio engine.
window.__show = () => showWetris({ parent: document.getElementById('uiroot'), onExit: () => {} });

window.__log = [];
for (const k of ['log', 'warn', 'error']) {
  const real = console[k].bind(console);
  console[k] = (...a) => { window.__log.push(`${k}: ${a.map(String).join(' ')}`); real(...a); };
}
window.addEventListener('error', (e) => window.__log.push(`uncaught: ${e.message}`));

const swap = new URLSearchParams(location.search).get('riv');
if (swap) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    return realFetch(url.endsWith('wetris.riv') ? swap : input, init);
  };
}

const say = document.getElementById('say');
const note = (m) => { const p = document.createElement('div'); p.textContent = m; say.appendChild(p); window.__log.push(`note: ${m}`); };

note(`available: ${await wetrisAvailable()}`);
try {
  await showWetris({ parent: document.getElementById('uiroot'), onExit: () => note('onExit fired') });
  note('mounted');
} catch (err) {
  note(`mount failed: ${err?.message ?? err}`);
}
