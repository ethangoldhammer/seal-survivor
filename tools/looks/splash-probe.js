// WHAT IS ACTUALLY BEHIND THE TITLE CARD.
//
// The title screen holds the seal up against the lens and lets the player move
// it (systems/titleSeal.js). All of that is drawn on the GAME canvas, and the
// Rive splash sits on top of it — so the whole feature is visible only to the
// extent that the card is not painted over it. Two separate things can hide it,
// and they look identical on screen:
//
//   THE WRAPPER, which ui/riveSplash.js fills behind the artboard because the
//   artboard is fitted `Contain` and never covers a wide screen on its own.
//   That is ours, it is one number (CONFIG.titleSeal.scrim), and it is fixable
//   from the tuner.
//
//   THE ARTBOARD, if the designer put a full-bleed background rectangle on the
//   bottom layer of `Splash Screen`. That is a fact about seal_survivor.riv and
//   NO value in the game can reveal what is under it.
//
// This page mounts the real splash — the shipping module, the shipping .riv —
// with a transparent wrapper, over a magenta/cyan checker. Whatever is still
// checkered is where the seal can be seen. Whatever is not, cannot.
//
//   npm run looks:splash
//
// Re-run it after any Rive re-export: the artboard growing a background is a
// change nothing in the codebase can detect, and the symptom is a title screen
// that quietly loses its seal.
import { mountRiveSplash } from '../../path/src/ui/riveSplash.js';

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const lines = [];
const say = (s) => { lines.push(s); hud.textContent = lines.join('\n'); };

say(`viewport ${window.innerWidth}x${window.innerHeight}`);

mountRiveSplash({
  parent: stage,
  // The whole point of the page. `startFallback` stays off so a stray pointer
  // event while screenshotting does not tear the card down mid-look.
  background: 'transparent',
  onPointer: (x, y) => { hud.dataset.pointer = `${x},${y}`; },
  onReady: (info) => {
    say(`artboards: ${info.artboards.join(', ') || '(none)'}`);
    say(`state machines: ${info.stateMachines.join(', ') || '(none)'}`);
    say(`playing: ${info.playing}`);
    say('checkered = the seal would show through');
  },
  onError: (err) => say(`LOAD FAILED — ${err?.message ?? err}`),
  onDismiss: (why) => say(`dismissed (${why})`),
});
