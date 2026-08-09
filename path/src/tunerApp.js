// Standalone entry for tuner.html — the ` and T panels with no game behind
// them. main.js can only build these panels at the end of boot(), after the
// three.js world exists and every model has been preloaded, so tuning meant
// starting a run first. Nothing about the panels actually needs the game:
// every control writes to CONFIG and calls saveTuningToStorage(), which in dev
// POSTs to /__tuning and lands in path/src/imported-tuning.json. This page
// loads that same config module and mounts the same panels, so a value tuned
// here is the value the game boots with.
//
// What it can't do is show you the result. There's no scene, so a tint, glow,
// size or model change is stored and saved but not visible until the game
// runs. Sound and music are unaffected — they're WebAudio, not three.js, and
// preview normally.
//
// Dev-only by construction: the disk write is a Vite middleware (apply:
// 'serve'), and this page isn't in rollupOptions.input, so `vite build` never
// emits it.

import { CONFIG } from './config.js';
import { initTuner, setTunerMeta } from './ui/tuner.js';
import { initTexturePanel } from './ui/textures.js';
import { initAudio, applyAudioBusSettings } from './systems/audio.js';
import { applyMusicSettings } from './systems/music.js';

// The game's handleTunerChange re-derives player stats and rebuilds the world,
// grid, camera, particles and post chain. None of that exists here, and none
// of it affects what gets saved — the controls persist themselves. The only
// live wiring worth keeping is the audio graph, so the Sound and Music tabs
// preview with the settings you're editing rather than the ones loaded at
// page open.
function handleTunerChange(path) {
  if (path === '*' || path.startsWith('audio')) applyAudioBusSettings();
  if (path === '*' || path.startsWith('music')) applyMusicSettings();
}

initAudio();
initTuner(handleTunerChange);
// No meshes to rebuild on an asset change — the game rebuilds its singletons
// from CONFIG on its next boot.
initTexturePanel(() => {}, handleTunerChange);

setTunerMeta('standalone · no game running');

// Both panels open on load; in game they start hidden so they don't cover the
// run you're playing, but here they're the entire point of the page.
const texPanel = document.querySelector('.sv-tex');
const tunerPanel = document.querySelector('.sv-tuner');
const host = document.getElementById('svPanels');
const empty = host.querySelector('.sv-sa-empty');

for (const p of [texPanel, tunerPanel]) {
  if (!p) continue;
  p.classList.remove('sv-hidden');
  // They append themselves to <body>, which is the page's column layout —
  // move them into the row that splits the space under the header bar.
  host.appendChild(p);
}

// The panels own their ` / T key handlers, so toggling still works; this just
// keeps the page from looking broken when both are closed.
function syncEmpty() {
  const bothHidden = [texPanel, tunerPanel].every((p) => !p || p.classList.contains('sv-hidden'));
  empty.style.display = bothHidden ? 'flex' : 'none';
}
const observer = new MutationObserver(syncEmpty);
for (const p of [texPanel, tunerPanel]) {
  if (p) observer.observe(p, { attributes: true, attributeFilter: ['class'] });
}
syncEmpty();

// Handy when this page is open next to the game and you're wondering which
// copy of a value you're looking at.
console.log('[tuner] standalone panel ready —', Object.keys(CONFIG).length, 'config sections');
