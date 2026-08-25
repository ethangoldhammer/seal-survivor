// THE SPLINE NAME SCREEN, ON ITS OWN PAGE.
//
//   npm run looks:splinesplash    then open http://localhost:4658/spline-splash.html
//
// The audition's other half. `?splash=spline` puts this screen up inside the
// game, which is where the decision gets made — but the game's dev server is
// the sole writer of imported-tuning.json, so a second one on another port
// flattens whatever tuning is live (SERVERS.md). This is a static build behind
// a read-only server: it runs the SHIPPING module against the SHIPPING scene
// URL and can touch nothing.
//
// WHAT IT ANSWERS that the game does not:
//
//   IS THE SCENE OPAQUE?     the checker underneath. Whatever shows through is
//                            a hole the game's own title seal could live in
//                            (systems/titleSeal.js). The .riv is fully opaque,
//                            which is why that feature is switched off today.
//   DID THE PANEL GET TAMED? the scene's HTML content is a workbench and the
//                            code export carries it — see THE PANEL in
//                            ui/splineSplash.js. The readout says whether it
//                            arrived, whether its chrome was hidden and whether
//                            it still takes the pointer, because a panel that
//                            takes the pointer is a game that cannot be started
//                            and it looks like nothing at all on a screenshot.
//   CAN THE 3D CARD FOLLOW?  whether the export has a variable the player's
//                            name can be written into. It does not today, and
//                            the console says so at load.
//
//   ?splinePanel   leave the workbench up, which is how the current, the cloth
//                  and the plant scatter get tuned against this framing rather
//                  than against Spline's.
//   ?src=<url>     a different export, for comparing two.
import { mountSplineSplash } from '../../path/src/ui/splineSplash.js';
import { CONFIG } from '../../path/src/config.js';

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const lines = [];
const say = (s) => { lines.push(s); hud.textContent = lines.join('\n'); };

const q = new URLSearchParams(location.search);
const src = q.get('src') || CONFIG.splineSplash?.src || '';

say(`viewport ${window.innerWidth}x${window.innerHeight}`);
say(src ? `scene ${src.replace(/^https:\/\//, '')}` : 'NO SCENE — CONFIG.splineSplash.src is empty');

const handle = mountSplineSplash({
  parent: stage,
  src,
  keepPanel: q.has('splinePanel'),
  nameObject: q.get('nameObject') ?? CONFIG.splineSplash?.nameObject ?? '',
  // The whole point of the checker. In the game this is `splashBackground()`,
  // which is opaque today.
  background: 'transparent',
  onPointer: (x, y) => { hud.dataset.pointer = `${x},${y}`; },
  onReady: (info) => {
    say(`route: ${info.route}`);
    say('checkered = the title seal would show through');

    // HOW MANY OBJECTS THE SCENE GREW. The panel's script scatters the plants
    // at runtime, so the count moving is the proof that hiding its chrome did
    // not also stop its work — the failure this is watching for is a scene that
    // renders a bare seal on an empty bed and looks merely disappointing.
    const count = () => (info.app?.getAllObjects?.() ?? []).length;
    say(`objects at load: ${count()}`);
    setTimeout(() => say(`objects after 8s: ${count()} (the panel's scatter)`), 8000);

    // THE PANEL, reported rather than assumed. Every one of these is a silent
    // failure in the game: a frame still taking the pointer is a name field
    // nobody can reach, and a frame that was never found is a workbench about
    // to be painted over the run.
    // ANYWHERE IN THE DOCUMENT, not `body > iframe`: the runtime appends the
    // frame to the canvas's parent, which is inside the screen's own wrapper.
    // Looking for it on body finds nothing and reads as "no panel", which is
    // the reassuring answer and the wrong one.
    // AFTER THE TAME, not at onReady. The chrome is hidden on the frame's own
    // `load`, which is a beat later than this callback — reading it here always
    // says VISIBLE and always looks like a failure.
    setTimeout(reportPanel, 1200);
  },
  onError: (err) => say(`LOAD FAILED — ${err?.message ?? err}`),
  onDismiss: (why) => say(`dismissed (${why})`),
});

function reportPanel() {
    const frames = [...document.querySelectorAll('iframe')];
    if (!frames.length) {
      say('panel: none in this export');
    } else {
      for (const f of frames) {
        const pe = getComputedStyle(f).pointerEvents;
        // THE MARKER, not `display:none` — the panel's own CSS uses that for
        // its inactive tab, so testing for it reports every untamed frame as
        // tamed. That false positive is exactly how the first version of this
        // page certified a workbench sitting over the game.
        const hidden = (f.srcdoc ?? '').includes('sv-panel-tamed');
        say(`panel: pointer-events ${pe}${pe === 'none' ? ' (tamed)' : ' — TAKES THE POINTER, the run cannot start'}`);
        say(`       chrome ${hidden ? 'hidden' : 'VISIBLE'}`);
      }
    }

}

// THE HANDLE, on the window — `__splash.randomize()` rolls a name, and
// `__splash.spline` is the Application, for emitEvent / setVariable from the
// console. That last one is how a variable added in Spline gets checked before
// anything in the game is changed to use it.
window.__splash = handle;
