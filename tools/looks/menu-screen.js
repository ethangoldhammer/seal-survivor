// ---------------------------------------------------------------------------
// THE MAIN MENU AND THE SHOT OUT OF IT.
//
//   npm run looks:menu        then open http://localhost:4662/menu-screen.html
//
// systems/mainMenu.js is not a screen in front of the game any more, it is a
// shot OF it — the run's own seal, in the arena, under a claim on the run's own
// camera, all of it easing to nothing over the first second of a run (see the
// header of that file). That makes it impossible to look at in isolation: there
// is no menu scene to mount, only a world with a menu held over it.
//
// So this page builds the world. createWorld and initPlayer, exactly as main.js
// does at boot, and then the menu on top — and nothing else. No spawning, no
// combat, no HUD. `Play` here does what Play does in the game minus the run:
// it releases the menu, so the pull-out from the portrait to the arena's own
// framing can be watched, and reloaded, and watched again.
//
// IT WRITES NOTHING. A vite build behind a read-only static server — there is
// no /__tuning endpoint to reach, so nothing here can touch the live tuning.
// See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  preloadAssets, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import { createWorld } from '../../path/src/world.js';
import { createPost } from '../../path/src/systems/post.js';
import { initPlayer, player, resetPlayer, updateAimRig } from '../../path/src/entities/player.js';
import { stateForSpeed } from '../../path/src/systems/animation.js';
import { createEyeLights, updateEyeLights } from '../../path/src/systems/eyeLights.js';
import {
  mountMainMenu, mainMenu, mainMenuActive, mainMenuAim, mainMenuEngaged, mainMenuGrid,
} from '../../path/src/systems/mainMenu.js';
import { updateBiolumSkin } from '../../path/src/systems/biolumSkin.js';
import { initCreatureOutlines } from '../../path/src/systems/outlines.js';
import { initParticles, updateParticles, updateParticleScale } from '../../path/src/entities/particles.js';
import { updateBubbles } from '../../path/src/systems/bubbles.js';
import { bounds } from '../../path/src/arena.js';
import { initTypography } from '../../path/src/ui/typography.js';
import { input } from '../../path/src/input.js';

const stage = document.getElementById('stage');
const root = document.getElementById('root');
const pressedEl = document.getElementById('pressed');

await preloadAssets();
// THE SEAL'S OWN SURFACE, at the numbers the game actually runs.
//
// EVERY ONE OF THESE, IN MAIN.JS'S ORDER. Each shader attaches with its own
// build-time defaults when the material is made (during the preload above),
// and each of these is what pushes the real CONFIG — including everything
// restored from saved tuning — over the top. Without them this page is judging
// a different animal, and it does it silently: the seal renders, it is lit, it
// is the right shape, and its surface is whatever the constructors happened to
// seed rather than the one the run wears. `applyNoiseSettings` alone was here
// for a while, which left the toon terraces and the wet film on their
// defaults — a flat grey animal on a screen whose whole job is to show the
// shipped one.
applySavedAssetLooks();
applyNoiseSettings();
applyToonSettings();
applyBiolumSkinSettings();
// Hooks spawns, so it has to run before initPlayer builds the body below or
// the seal comes up with no rim for the bust crop to re-fit.
initCreatureOutlines();
// The game's type system, or the labels come up in the browser's default face:
// `blobButton` in textRoles.js is what styles them, compiled into a stylesheet
// here exactly as main.js does at boot.
initTypography();

// The arena, its camera and its renderer — the real one. The menu's whole
// framing is a ratio against `halfExtents(1)`, so a world built any other way
// would be composing against a frame the game never has.
const world = createWorld(stage.parentElement ?? document.body);
const post = createPost(world.renderer);
initParticles(world.scene);
initPlayer(world.scene);
world.scene.add(createEyeLights());
// Where the run would start it. mountMainMenu expects this to have happened —
// it measures its crop against where the animal stands.
resetPlayer();
stage.remove(); // createWorld makes its own canvas; the placeholder is spare

mountMainMenu({
  world,
  seal: player,
  root,
  items: [
    { label: 'Play', onPress: () => { say('Play — releasing: watch the pull-out'); mainMenu()?.release(); } },
    // The shipped row: Play / Options / Leaderboard. The labels are what the
    // cell has to fit (see the shrink in hexMenu), so a stand-in with a
    // different word length composes a different screen.
    { label: 'Options', onPress: () => say('Options — the standalone Settings panel') },
    { label: 'Leaderboard', onPress: () => say('Leaderboard — the board on its own surface') },
  ],
});

function say(text) {
  pressedEl.textContent = text;
}

let last = performance.now();
function tick(now) {
  // Real elapsed time, clamped: the shimmed rAF in the page is a setTimeout,
  // and a pane that has been asleep hands back a delta of several seconds,
  // which would teleport the eased aim rather than sweep it.
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  // The pre-run half of main.js's frame, and only that half: the mixer and the
  // aim rig tick outside a run there too, for the same reason — a seal on a
  // menu that froze mid-pose would be a still.
  if (CONFIG.animation.enabled) {
    player.anim?.update(dt, stateForSpeed(0, player.aboveSurface), false);
  }
  updateAimRig(dt, mainMenuAim() ?? input.aim, mainMenuEngaged(), 0, false);
  // The seal's own breath, exactly as main.js fires it on this screen — the
  // menu is the arena punched in, and the emitters are the run's. Measured off
  // the position rather than `player.aboveSurface` for the reason main.js
  // gives: nothing here runs updatePlayer, so that flag is never written.
  if (mainMenuActive()) {
    updateBubbles(dt, player.aimRig, player.velocity, player.mesh.position.y > bounds.surfaceY);
  }
  updateEyeLights(dt, player.aimRig, { lit: 1, charge: 0 });
  // The self-lighting creatures' own clock, exactly as main.js ticks it. The
  // seal is not one of them, but the shader it shares with them reads the same
  // bus — and a page that never advances it is judging a frozen one.
  updateBiolumSkin(dt);

  if (mainMenuActive()) mainMenu()?.update(dt);

  world.updateSurface(dt);
  // The menu's claim on the ARENA's lattice, exactly as main.js hands it in:
  // that grid is underneath the menu's own and six times coarser, so it is
  // faded out while the screen is held, and the seal's run-tuned wake radius —
  // wider than this whole frame — is held off it.
  world.grid.update(dt, player.mesh.position, player.velocity, {
    camera: world.camera,
    ...mainMenuGrid(),
  });
  world.updateCamera(player.mesh.position, dt, {});
  updateParticles(dt);
  updateParticleScale(world.camera, world.renderer);
  post.render(world.scene, world.camera, dt);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/**
 * Post the current frame to the look server's drop box, so it can be read off
 * disk. The pane's own screenshot is the other way to see this page; this one
 * survives a pane that is 0x0 until something forces layout.
 */
function shoot(name) {
  world.renderer.domElement.toBlob(
    (blob) => fetch(`/shot/${name}.png`, { method: 'POST', body: blob }),
    'image/png',
  );
}
window.addEventListener('keydown', (e) => {
  if (e.key === 's') shoot(`menu-${Date.now()}`);
  // The release, from the keyboard, so the pull-out can be triggered without
  // finding a button — which is the only way to drive it from the agent's pane.
  if (e.key === 'p') { say('released'); mainMenu()?.release(); }
});

// Handles for poking at the page from a console — and from the agent's
// javascript_tool, which is the only way to steer a page in a pane that has no
// cursor to move.
// CONFIG among them, because this is a DESIGN page: every number the Main-menu
// groups in the tuner drive is re-read by the menu every frame (refreshFilm in
// systems/hexMenu.js), so setting one here moves the screen immediately and a
// value can be tried before it is typed into a slider. Writing a uniform
// directly would not survive a frame, which is the point.
window.mainMenuLook = { world, post, player, menu: () => mainMenu(), shoot, CONFIG };
