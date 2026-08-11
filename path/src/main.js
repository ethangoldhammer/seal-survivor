import * as THREE from 'three';
import { CONFIG, loadTuningFromStorage, saveTuningToStorage, xpForNextLevel } from './config.js';
import { preloadAssets, restoreUploadedModels, applySavedAssetLooks, assetBaseColor, setEmissiveMapsEnabled, applyNoiseSettings, applyGrassSettings, applyBiolumSkinSettings } from './assets.js';
import { updateGrassSway } from './systems/grassSway.js';
import { updateBiolumSkin } from './systems/biolumSkin.js';
import { updateBeatSync } from './systems/beatSync.js';
import { reseatDecor } from './systems/decor.js';
import { createWorld } from './world.js';
import { midWater, bounds } from './arena.js';
import { initInput, updateInput, clearPendingInput, input } from './input.js';
import { player, initPlayer, resetPlayer, updatePlayer, updateAimRig, recomputeStats, addUpgrade, applyRecoil, rebuildShipBody } from './entities/player.js';
import { projectileCount } from './stats.js';
import { aoe, targeting, abilityDamage } from './systems/scaling.js';
import { updateElements, onEnemyKilled as onElementalHostKilled, resetElements, clearStatuses, commitElement, updateElementSkin, elementHitEvent } from './systems/elements.js';
import { enemies, updateSpawning, updateEnemies, animateEnemiesIdle, resetEnemies, removeEnemy, spawnNamed, nightlifeWeight } from './entities/enemies.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from './entities/projectiles.js';
import { updatePickups, resetPickups, spawnXpOrb, spawnStrikeOrb, spawnBubbleOrb, spawnRapidFireOrb, gulpPickups, setChumDifficulty, flushPickupInstances } from './entities/pickups.js';
import { initParticles, updateParticles, resetParticles, updateParticleScale, particleCount } from './entities/particles.js';
import { resolveCombat } from './systems/combat.js';
import { resolvePredation } from './systems/predation.js';
import { initFeedback, feedback, updateFeedback, feedbackState, addSustainedShake } from './systems/feedback.js';
import { initAudio, unlockAudio, applyAudioBusSettings, updateBusDepth, resetRepetition } from './systems/audio.js';
import { initHaptics, stopHaptics } from './systems/haptics.js';
import { createPost } from './systems/post.js';
import { warmShaders, warmPipeline } from './systems/shaderWarmup.js';
import { showLoading } from './ui/loading.js';
import { createGarlicVisual, updateGarlic, resetGarlic } from './systems/garlic.js';
import { createShrimpRingVisual, updateShrimpRing, resetShrimpRing } from './systems/shrimpRing.js';
import { fireMusselBarrage } from './systems/musselVolley.js';
import { strikeState, tryStrike, restoreCharge, updateStrike, updateCharge, feedChum, resetStrike, comboSpeedMul, chainStrike, liveChain, strikeDirection } from './systems/strike.js';
import { stateForSpeed } from './systems/animation.js';
import { emitPoint, emitPointCount } from './systems/aimRig.js';
import { updateBubbles, resetBubbles } from './systems/bubbles.js';
import { updateDayCycle, resetDayCycle, advanceClock, dayState, setNightLock, nightLockedAt } from './systems/daylight.js';
import { updateWeather, resetWeather } from './systems/weather.js';
import { lightningStrikes } from './systems/lightning.js';
import { updateOxygenFx, resetOxygenFx } from './systems/oxygenFx.js';
import { playerDamageFx, updatePlayerDamageFx, resetPlayerDamageFx } from './systems/playerDamageFx.js';
import { updateProjectileTrails, clearProjectileTrails } from './systems/projectileTrails.js';
import { updateProjectileVoices, clearProjectileVoices, flightVoiceCount } from './systems/projectileVoices.js';
import { initImpactFlashes, updateImpactFlashes, clearImpactFlashes, spawnImpactFlash } from './systems/impactFlash.js';
import { createStrikeRing, updateStrikeRing } from './systems/strikeRing.js';
import { createAimIndicator, updateAimIndicator, resetAimIndicator } from './systems/aimIndicator.js';
import { play as playMusic, duckForUpgrade, sweepOpen, applyMusicSettings, setLevel as setMusicLevel, preloadDefaultTracks, updateDepth as updateMusicDepth } from './systems/music.js';
import { startAmbient, stopAmbient, preloadAmbient } from './systems/ambient.js';
import { computeKillPoints, comboMultiplierFor } from './systems/scoring.js';
import { updateCrabSpawner, resetCrabSpawner, summonDeathPile, updateDeathPile } from './systems/crabSpawner.js';
import { spawnSeagull, updateSeagulls, resetSeagulls } from './systems/seagull.js';
import { updateBoats, resetBoats, boats } from './systems/boats.js';
import { damageDebris } from './systems/boatDebris.js';
import { damageCrew, nearestFloatingCrew, eatCrew } from './systems/crew.js';
import { updateEel, resetEel, resetEelBolts, currentEelStats, createEelCompanion, resetEelCompanion, rebuildEelCompanion, spawnArcBolt } from './systems/eel.js';
import { createBelugaDrone, updateBeluga, resetBeluga, rebuildBelugaDrone } from './systems/beluga.js';
import { updateSealTeam, resetSealTeam, rebuildSealTeam } from './systems/sealTeam.js';
import { createBakalarBoat, updateBakalar, resetBakalar, rebuildBakalarBoat } from './systems/bakalar.js';
import { updateCalamari, resetCalamari } from './systems/calamari.js';
import { createDumboOcto, updateDumbo, resetDumbo, rebuildDumboOcto } from './systems/dumbo.js';
import { firePearl, burstPearl, updateOyster, resetOyster } from './systems/oyster.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab, rebuildOctoGrabber } from './systems/octoGrab.js';
import { updateOrcaPod, resetOrcaPod, rebuildOrcaPod } from './systems/orca.js';
import { applyPlayerOutline, updatePlayerOutline, flarePlayerOutline, resetPlayerOutlineCharge, initCreatureOutlines, applyCreatureOutlines } from './systems/outlines.js';
import { deathState, startDeathDive, updateDeathDive, resetDeathDive, beginRestartTransition } from './systems/deathDive.js';
import { levelUpState, startLevelUpTime, updateLevelUpTime, endLevelUpTime, resetLevelUpTime } from './systems/levelUpTime.js';
import { cineEvent, cineBreach, resetCineCamera } from './systems/cineCamera.js';
import { highScore } from './systems/leaderboard.js';
import { initUI, showStartMenu, hideAllMenus, showLevelUp, showGameOver, updateHUD, setHighScore, spawnScoreToast, spawnChainToast, updateToasts, clearToasts, updateMenuNav, hidePlayerBars, showHud, showRestartTransition, hideRestartTransition } from './ui/ui.js';
import { isTypingTarget } from './ui/typing.js';
import { initTuner, refreshTuner, setTunerMeta } from './ui/tuner.js';
import { initTexturePanel } from './ui/textures.js';
import { initTypography, applyTypography } from './ui/typography.js';
import { initGamepadDebug, updateGamepadDebug } from './ui/gamepadDebug.js';
import { initSfxDebug, updateSfxDebug } from './ui/sfxDebug.js';
import * as playtest from './systems/playtest.js';
import { initPlaytestOverlay, showPlaytestReport } from './ui/playtestOverlay.js';

// Restore any saved tuning BEFORE anything reads CONFIG — world/grid/camera
// creation below all pull from it immediately, not just once gameplay starts.
//
// The seeding save is for production only, where localStorage is the sole
// store and starts empty. In dev, imported-tuning.json IS the seed, so
// saving here would rewrite the file (and bump its timestamp) on every
// single page load — pure git churn, and it left the browser cache looking
// permanently "newer" than disk.
if (!loadTuningFromStorage() && !import.meta.env?.DEV) saveTuningToStorage();

// The authoring tools — the ` tuning panel, the T Look & Sound panel, the G
// gamepad readout, the B playtest overlay and the P/X/N debug keys — are for
// building the game, not for playing it. A production build leaves them out
// entirely, so a link handed to a player has no key that opens a wall of
// sliders over the ocean, and the panel code never runs.
//
// `?tune` puts them back on a deployed build. Tuning on a phone or against a
// shared build is a real workflow, and it only needs the URL, not a rebuild —
// but the plain link stays clean, which is the point.
const DEV_UI = !!import.meta.env?.DEV
  || new URLSearchParams(window.location.search).has('tune');

const container = document.getElementById('root') ?? document.body;
const world = createWorld(container);
const post = createPost(world.renderer);
initInput(world.renderer.domElement);
initParticles(world.scene);
initImpactFlashes(world.scene);
initFeedback(world.grid);
// What a flash sounds like and what a bolt does are gameplay; world.js only
// owns where and when one is drawn. See onLightning below.
world.setLightningHandler(onLightning);
initAudio();
initHaptics();

// These are created inside boot(), AFTER models are loaded — not here at
// module scope. Anything calling createVisual() before preloadAssets() has
// finished finds an empty model cache and silently falls back to its
// procedural shape, which is exactly why the eel companion and beluga drone
// only appeared once you nudged their size slider (that triggered a rebuild,
// by which point the models existed). Declared here, assigned in boot().
let garlicMesh = null;
let shrimpGroup = null;
let belugaDrone = null;
let eelCompanionMesh = null;
let strikeRing = null;
let aimIndicator = null;
let dumboOcto = null;
let octoGrabber = null;

const gameState = {
  running: false,
  paused: false,
  time: 0,
  difficulty: 0,
  kills: 0,
  score: 0,
  level: 1,
  xp: 0,
  xpToNext: CONFIG.xp.first,
};

let pendingLevels = 0;
let shootCooldown = 0;
let missileCooldown = 0;
let scallopCooldown = 0;
let oysterCooldown = 0;
let bounceCooldown = 0;
let rapidFireTimer = 0; // seconds remaining on an active rapid-fire pickup
let chargeHapticTimer = 0; // counts down between wind-up rumble pulses
let bubbleSpawnTimer = 0;
let rapidFireSpawnTimer = 0;
let starfishCooldown = 0;
let seagullCooldown = 0;
let simClock = 0; // free-running clock for the beluga drone's orbit
let muzzleCursor = 0; // which flipper the next ALTERNATING volley starts from (missiles)
const muzzlePoint = new THREE.Vector3(); // scratch — spawnProjectile copies it immediately
const impulseDir = new THREE.Vector3(); // scratch — hit direction handed to the bone spring
// Scratch for the per-frame "where would a strike go" prediction the lens
// corridor is drawn along. Read and copied inside updateCamera on the same
// frame it's written, so one object is enough.
const dashPrediction = { x: 0, y: 0 };

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

boot();

async function boot() {
  const loading = showLoading();
  // Assets are the first two thirds of the bar and the shader warm-up is the
  // last third. Not a measurement — the split is a judgement about which half
  // feels longer, and the warm-up's own share is smoothed inside that third.
  const ASSET_SHARE = 0.66;
  loading.setPhase('Filling the ocean');
  await preloadAssets((p) => loading.setProgress(p * ASSET_SHARE));
  // Uploaded models must be in place BEFORE initPlayer and the ability
  // singletons build their meshes below, or they'd start life holding the
  // built-in model and only pick up the upload when something rebuilt them.
  // Saved-model restore must never be able to stall boot: if storage is
  // blocked or slow, the game starts with the built-in models rather than
  // sitting on the loading screen. Bounded, and failures are swallowed.
  try {
    await Promise.race([
      restoreUploadedModels(),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  } catch (err) {
    console.warn('[boot] saved models could not be restored —', err?.message ?? err);
  }
  // Saved per-asset looks (size multiplier, tint, glow) must also be applied
  // BEFORE any mesh is built, for the same reason as the models above — a
  // saved size otherwise wouldn't reach the singletons until something
  // rebuilt them.
  applySavedAssetLooks();
  // The shader attaches with its own defaults at material-build time; this is
  // what pushes the real CONFIG (including anything restored from saved
  // tuning) onto the uniforms, so a tuned size applies on the first frame
  // rather than only after the slider is next touched.
  applyNoiseSettings();
  applyGrassSettings();
  applyBiolumSkinSettings();
  // Must come after the looks above (it reads the size multipliers to keep
  // rim width in world units) and before the first createVisual call below —
  // it hooks spawns, so anything built earlier would come up with no outline.
  initCreatureOutlines();

  garlicMesh = createGarlicVisual();
  world.scene.add(garlicMesh);
  shrimpGroup = createShrimpRingVisual();
  world.scene.add(shrimpGroup);
  belugaDrone = createBelugaDrone();
  world.scene.add(belugaDrone);
  eelCompanionMesh = createEelCompanion();
  world.scene.add(eelCompanionMesh);
  strikeRing = createStrikeRing();
  world.scene.add(strikeRing);
  aimIndicator = createAimIndicator();
  world.scene.add(aimIndicator);
  dumboOcto = createDumboOcto();
  world.scene.add(dumboOcto);
  octoGrabber = createOctoGrabber();
  world.scene.add(octoGrabber);
  // Adds itself to the scene (it owns two objects — the hull and the net).
  createBakalarBoat(world.scene);

  initPlayer(world.scene);
  player.mesh.position.set(0, midWater(), 0);

  // LAST, and deliberately after every singleton above is in the scene: this
  // spends seconds up front so the run doesn't spend them one stall at a time.
  // See systems/shaderWarmup.js — the seal, the abilities and the backdrop are
  // covered by the pipeline frame, and everything that spawns later by the
  // compile pass. Wrapped so a warm-up that cannot run never blocks boot: the
  // worst case is the hitching we had before it existed.
  loading.setPhase('Warming the glass');
  try {
    await warmShaders(
      post, world.scene, world.camera, world.renderer,
      (p) => loading.setProgress(ASSET_SHARE + p * (1 - ASSET_SHARE)),
    );
    warmPipeline(post, world.scene, world.camera);
  } catch (err) {
    console.warn('[boot] shader warm-up skipped —', err?.message ?? err);
  }
  loading.setProgress(1);
  loading.remove();

  initUI({ onStart: startGame, onRestart: restartRun, onLevelChoice: applyLevelChoice });
  initTypography();
  if (DEV_UI) initTuner(handleTunerChange);
  if (DEV_UI) initTexturePanel((key) => {
    // Some ability meshes are singletons created once at boot, not
    // repeatedly cloned like an enemy — a size change needs an explicit
    // rebuild to actually show up, rather than only affecting future spawns.
    if (key === 'ship') rebuildShipBody();
    else if (key === 'belugaDrone') rebuildBelugaDrone(world.scene);
    else if (key === 'sealTeam') rebuildSealTeam(world.scene);
    else if (key === 'eelCompanion') rebuildEelCompanion(world.scene);
    else if (key === 'shrimp') resetShrimpRing();
    else if (key === 'dumboOcto') rebuildDumboOcto(world.scene);
    else if (key === 'bakalarBoat') rebuildBakalarBoat(world.scene);
    else if (key === 'octoGrabber') rebuildOctoGrabber(world.scene);
    else if (key === 'orcaFriend') rebuildOrcaPod(world.scene);
  }, handleTunerChange);
  if (DEV_UI) bindGlobalKeys();
  if (DEV_UI) initGamepadDebug();
  if (DEV_UI) initSfxDebug();
  if (DEV_UI) initPlaytestOverlay();
  setHighScore(highScore());
  showStartMenu();
  world.renderer.setAnimationLoop(animate);
}


function bindGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'p' && !isTypingTarget(e.target)) {
      post.cyclePreset();
      refreshTuner();
    }
    // X: the hex-tile alignment overlay. Debug-only, nothing persisted.
    if (e.key.toLowerCase() === 'x' && !isTypingTarget(e.target) && !e.repeat) {
      world.hexTiles.toggle();
    }
    // N: line up one of every bioluminescent creature beside the seal, so the
    // glow presets can be compared against each other instead of waiting for
    // the spawner to offer them one at a time — the rarest is two per arena
    // behind a level gate, which is not a thing you can art-direct against.
    //
    // Caps and gates are bypassed on purpose (that IS the feature), but the
    // clock is still left strictly alone HERE: parking it through `paused` and
    // `scrubHour` writes those into the live config, and the next tuner edit
    // would save them to imported-tuning.json as though someone had chosen a
    // permanent midnight. Shift+N below is the way to get dark — it locks the
    // clock in a place the tuning snapshot cannot see, and only in dev.
    if (e.key.toLowerCase() === 'n' && !isTypingTarget(e.target) && !e.repeat) {
      // The DEV test is INSIDE the branch, not around the whole handler, and
      // it is what makes the night lock leave nothing behind: it is a
      // compile-time constant, so the production build folds this to `false`,
      // drops the call, and then tree-shakes setNightLock out of the bundle
      // entirely. DEV_UI is not a substitute — it is true in production under
      // `?tune`, which is exactly the door this must not be behind.
      if (e.shiftKey && import.meta.env?.DEV) {
        console.log(`[daylight] ${setNightLock(nightLockedAt() == null)}`);
      } else if (!e.shiftKey) {
        spawnGlowLineup();
      }
    }
  });
}

// The lineup itself. Spread along a row in front of the seal at its own depth,
// far enough apart that two bodies don't overlap at the widest of them.
function spawnGlowLineup() {
  const keys = Object.keys(CONFIG.enemies).filter((k) => CONFIG.enemies[k].bioluminescent);
  if (!keys.length) {
    console.warn('[nightlife] nothing is tagged `bioluminescent` in enemies.csv — nothing to line up.');
    return;
  }
  const origin = player.mesh.position;
  const spacing = 4;
  keys.forEach((key, i) => {
    const at = { x: origin.x + (i - (keys.length - 1) / 2) * spacing, y: origin.y + 3 };
    const e = spawnNamed(world.scene, key, gameState.difficulty, at, { ignoreCaps: true });
    // `entering` suppresses the side walls for a creature walking on from off
    // screen; one placed deliberately inside the arena has already arrived.
    if (e) e.entering = false;
  });
  // `true` = the GLOWING curve. Called bare this returned the daylight one,
  // which is the opposite roster and made the hint below fire exactly backwards:
  // at midnight the daylight weight is 0.08, so pressing N in full dark printed
  // "the sun is up".
  const mul = nightlifeWeight(true);
  console.log(
    `[nightlife] ${keys.join(', ')} — ${dayState.hours.toFixed(1)}h (${dayState.phase}), spawn weight x${mul.toFixed(2)}`
    + (mul > 0.5 ? '' : '\n  The sun is up, so the glow is additive over almost nothing and these will read as dark fish.'
      + ' Shift+N locks the clock at full dark (dev only, never persisted); Shift+N again hands it back.')
  );
}

// Any tuner edit re-derives player stats, and rebuilds the backdrop, grid or
// camera when those are what changed.
function handleTunerChange(path) {
  recomputeStats();
  // world.resize() called directly, so it does NOT fire the window resize
  // event systems/decor.js listens on — anything standing on the seabed has
  // to be re-seated by hand here or it hangs at the old floor height.
  if (path === '*' || path.startsWith('arena') || path.startsWith('camera')) { world.resize(); reseatDecor(); }
  if (path === '*' || path.startsWith('grid')) world.grid.build();
  // The shore is geometry, not uniforms, so every knob on it needs a rebuild.
  if (path === '*' || path.startsWith('wallRocks')) world.wallRocks.build();
  // The night sky's geometry IS its tuning — where the stars are, what is
  // joined to what, how far the fractal grows — so most of that panel needs a
  // rebuild rather than a uniform write. `star density` lives in the Sky panel
  // but decides this field, so it has to come through here too.
  if (path === '*' || path.startsWith('constellations') || path.startsWith('dayNight.stars')) {
    world.constellations.build();
  }
  // colors/caustics/godrays update in place every frame already via
  // world.updateColors, called from world.updateSurface — nothing to do here.
  if (path === '*' || path.startsWith('fx.maxParticles')) initParticles(world.scene);
  if (path === '*' || path.startsWith('post')) post.applyPreset(CONFIG.post.preset);
  // Which glow source is live is a property of every loaded MATERIAL, not of
  // the frame, so flipping the config value alone changes nothing until the
  // materials are re-pointed. Covers '*' too: a tuning reset can turn this
  // off, and the masks have to come back off the materials with it.
  if (path === '*' || path.startsWith('glow')) setEmissiveMapsEnabled(CONFIG.glow?.emissiveMaps);
  // Pure uniform writes on already-compiled shaders — no rebuild, so this is
  // safe to fire from a slider's every input event.
  if (path === '*' || path.startsWith('sealShader')) applyNoiseSettings();
  if (path === '*' || path.startsWith('grass')) applyGrassSettings();
  // Including the pattern dropdown — the pattern is a uniform, not a compile
  // switch, so switching it repaints every fish already swimming.
  if (path === '*' || path.startsWith('biolumSkin')) applyBiolumSkinSettings();
  // Also a pure material/uniform write on shells that already exist, so every
  // input event can drive it — no rebuild, and the toggle just hides them.
  if (path === '*' || path.startsWith('playerOutline')) applyPlayerOutline();
  // Same — one shared material per species, so a toggle or a colour reaches
  // every creature already swimming without touching the scene graph.
  if (path === '*' || path.startsWith('creatureOutline')) applyCreatureOutlines();
  if (path === '*' || path.startsWith('typography')) applyTypography();
  if (path === '*' || path.startsWith('music')) applyMusicSettings();
  // Reset ('*') restores CONFIG.audio.bus wholesale, so the live nodes need
  // pushing back in step with it.
  if (path === '*' || path.startsWith('audio')) applyAudioBusSettings();
}

// "Try again" from the score screen. The next run does NOT begin on the click:
// the death left the clock dilated, the mix slowed and filtered and the lens
// pushed in on a corpse, and cutting straight from that into a fresh run
// snapped all four back on one frame. So the transition graphic goes up, the
// dive glides everything back to normal underneath it, and startGame runs on
// the far side.
function restartRun() {
  const seconds = CONFIG.death?.restart?.time ?? 0.9;
  showRestartTransition(seconds);
  // On this side of the click, while it's still a real user gesture: the
  // callback below lands the better part of a second later, and an
  // AudioContext first created outside a gesture comes up suspended and stays
  // silent for the whole run. A no-op when audio is already live, which after
  // a completed run it will be.
  unlockAudio();
  // Runs on the far side of the glide — or immediately, if there was nothing
  // dilated to come back from (the dive switched off, or a death that never
  // used it). Clears faster than it arrived: the far side of a transition is a
  // live run, and the first second of one shouldn't be played blind.
  beginRestartTransition(() => {
    showHud();
    startGame();
    hideRestartTransition(seconds * 0.6);
  });
}

function startGame() {
  // A run abandoned by restarting still has data worth keeping — file it
  // before the new one clears the recorder, or the only runs ever recorded
  // are the ones that ended in death.
  if (playtest.isRecording()) playtest.endRun('restart');

  unlockAudio(); // browsers need a gesture before any sound can play
  preloadDefaultTracks(); // fetches the built-in loops once; no-op after the first call
  preloadAmbient(); // same deal for the ambient bed's clips
  // A death is the busiest the mix ever gets, so the repetition ducking is at
  // its deepest right as the run ends. Cleared here or the first shots of the
  // next run come out quiet for no reason the player can see.
  resetRepetition();
  hideAllMenus();
  resetEnemies(world.scene);
  resetProjectiles(world.scene);
  clearProjectileTrails(world.scene);
  // Must follow resetProjectiles: the voices are keyed by projectile, and a
  // shell removed without its voice being released leaves that voice running
  // — a mussel you can still hear hunting through the whole next run.
  clearProjectileVoices();
  clearImpactFlashes();
  resetPickups(world.scene);
  resetParticles();
  // Before resetPlayer, which puts the seal back at midwater: this hands the
  // clock and the mix back to full speed, so a run started from the score
  // screen doesn't open in the last one's slow motion.
  resetDeathDive();
  // Same idea, for the other thing that bends the clock: a run can only be
  // started from a menu, but a level-up left half-dilated by a reload or a
  // restart would hand this one a world running at half speed.
  resetLevelUpTime();
  resetPlayer();
  // AFTER resetPlayer, not before: the rig places itself on the seal rather
  // than springing to it on its first frame, so it has to be reset once the
  // seal is back at midwater. Reset before, and a run opens with the frame
  // sailing across the arena from wherever the last body came to rest.
  resetCineCamera();
  resetGarlic();
  resetShrimpRing();
  resetStrike();
  // Drops the rolled element AND clears any status still ticking on a
  // creature carried into the new run — the statuses outlive the thing that
  // applied them, so a re-roll without this leaves fish poisoned by the
  // last run's numbers.
  resetElements(world.scene);
  clearStatuses(enemies);
  resetAimIndicator();
  // Must follow resetStrike: the input edge is what feeds tryStrike, so
  // clearing the charge state without clearing the pending press would just
  // hand the fresh charges straight back to a leftover keypress.
  clearPendingInput();
  // A fresh run shouldn't inherit the death rumble from the last one.
  stopHaptics();
  resetBubbles();
  // Same idea for the rim: a run that ended mid-flare shouldn't hand the next
  // one a seal that opens lit and fades down. Clears the damage flash too.
  resetPlayerOutlineCharge();
  // And the damage accumulator, or the sub-threshold nibbling the last run
  // died with would ride along and land on the first scratch of this one.
  resetPlayerDamageFx();
  // The first run of a session opens in the morning; after that the clock
  // keeps whatever time the last one ended at, unless dayNight.restartAtMorning
  // says otherwise. resetDayCycle knows which — see systems/daylight.js.
  resetDayCycle();
  // Weather does NOT carry over: a fresh run shouldn't open in the middle of
  // the downpour that the last one died in, and the schedule's `firstDelay`
  // exists precisely so a run gets a while of clear sky before its first
  // storm. Drops still falling from the old run go with it.
  resetWeather();
  world.rain.reset();
  // Bolts mid-flicker and any strike queued but not yet resolved. Without
  // this a strike that landed on the frame the last run ended would resolve
  // into the new one and kill whatever had just spawned.
  world.lightning.reset();
  resetOxygenFx();
  resetCrabSpawner();
  resetSeagulls(world.scene);
  resetBoats(world.scene);
  resetEel();
  resetEelBolts(world.scene);
  resetEelCompanion(player.mesh.position);
  resetBeluga(world.scene, player.mesh.position);
  resetSealTeam(world.scene);
  resetBakalar(world.scene);
  resetCalamari(world.scene);
  resetDumbo(player.mesh.position);
  resetOyster(world.scene);
  resetOctoGrab(world.scene, player.mesh.position);
  resetOrcaPod(world.scene, player.mesh.position);
  world.grid.reset();
  world.constellations.reset();
  refreshTuner();

  gameState.running = true;
  gameState.paused = false;
  gameState.time = 0;
  gameState.difficulty = 0;
  gameState.kills = 0;
  gameState.score = 0;
  gameState.level = 1;
  // Must come AFTER level is reset to 1 — playMusic picks its opening loop
  // from the level it's handed, so running it first started every new run on
  // whatever loop the PREVIOUS run had climbed to.
  playMusic(gameState.level);
  // Picks the rotation up where the last run's fade-out left it rather than
  // restarting on clip one, so back-to-back runs don't all open on the same
  // bed. See startAmbient.
  startAmbient();
  // The opening shot: wide and barely tracking, easing into the normal follow
  // over the state's blend-out. No-op with the cinematic camera off.
  cineEvent('roundStart');
  sweepOpen(); // in case the last run ended on the level-up screen's ducked filter
  gameState.xp = 0;
  gameState.xpToNext = CONFIG.xp.first;
  pendingLevels = 0;
  shootCooldown = 0;
  missileCooldown = 0;
  scallopCooldown = 0;
  oysterCooldown = 0;
  bounceCooldown = 0;
  rapidFireTimer = 0;
  bubbleSpawnTimer = randomBetween(CONFIG.oxygen.bubbleSpawnMin, CONFIG.oxygen.bubbleSpawnMax);
  rapidFireSpawnTimer = randomBetween(CONFIG.rapidFirePickup.spawnMin, CONFIG.rapidFirePickup.spawnMax);
  starfishCooldown = 0;
  seagullCooldown = 0;
  simClock = 0;
  feedbackState.shake = 0;
  feedbackState.hitstop = 0;
  clearToasts(); // don't carry the last run's numbers into this one

  // Records the knobs this run was played under alongside the run itself: a
  // balance verdict only means anything next to the numbers that produced it,
  // and these are exactly the ones the T-panel can change between runs.
  playtest.beginRun({
    difficultyPerSecond: CONFIG.spawn.difficultyPerSecond,
    ramp: { ...CONFIG.spawn.ramp },
    baseInterval: CONFIG.spawn.baseInterval,
    countPerDifficulty: CONFIG.spawn.countPerDifficulty,
    maxAlive: CONFIG.spawn.maxAlive,
    playerMaxHp: player.stats.maxHp,
    playerDamage: player.stats.damage,
    // The xp curve rides along too: how fast levels arrive is half of whether
    // a run's difficulty felt right, and a report that can't see the curve
    // can't tell "the ramp is too steep" from "you levelled too slowly".
    xp: { ...CONFIG.xp },
  });

  updateHUD(gameState, player, null, rapidFireTimer, world.camera);
}

// Dying stops the RUN, not the frame. The seal goes limp and sinks, time and
// sound dilate around it (systems/deathDive.js), and the score screen only
// arrives once the body has settled on the seabed — so the name box never
// takes the keyboard while there's still something to watch.
function killPlayer() {
  player.anim?.trigger('death'); // clamps on its last frame, never hands back
  gameState.running = false;
  // updateHUD stops here, and the seal's floating bars are anchored by it —
  // see hidePlayerBars. The rest of the HUD is screen-anchored and can stay.
  hidePlayerBars();
  // Filed here rather than from showGameOver: the run ends at the moment of
  // death, and the dive plus the name-entry screen after it can sit open for
  // minutes.
  // The run is still recorded either way — only the console report and the B
  // overlay are authoring surfaces, and printing "press B" on a build with no
  // B key is just noise in a player's console.
  if (DEV_UI) showPlaytestReport(playtest.endRun('death'));
  else playtest.endRun('death');
  feedback('playerDeath', { x: player.mesh.position.x, y: player.mesh.position.y, scale: 1.6 });

  // The score isn't posted here — showGameOver takes the name first and
  // submits on confirm, then refreshes the high score itself.
  const toScoreScreen = () => {
    // The music deliberately does NOT stop here. It rides the dive down like a
    // tape stop, then winds back up to pitch under the score card and keeps
    // looping through the name box and the high scores — dying ends the run,
    // not the soundtrack. The rate hand-off is deathDive's releaseMusic.
    // Fades rather than cuts, and over its own longer `fadeOut` — the water
    // should still be there for a moment after the score is on screen.
    stopAmbient();
    showGameOver(gameState);
  };

  if (CONFIG.death?.enabled === false) {
    toScoreScreen();
    return;
  }
  // The seabed notices. Crabs already down there switch to the corpse on their
  // own (the `corpse` branch in the crawl behavior); this calls in the rest,
  // who walk on from the wings and are drained by updateDeathPile in the death
  // branch of the frame loop. Armed AFTER the no-dive early return above,
  // because that path cuts straight to the score screen and would leave a wave
  // queued with nothing left running to spawn it.
  summonDeathPile();
  startDeathDive(toScoreScreen);
}

function gainXP(amount) {
  gameState.xp += amount;
  while (gameState.xp >= gameState.xpToNext) {
    gameState.xp -= gameState.xpToNext;
    gameState.level += 1;
    // Mirror onto the player so recomputeStats can apply per-level weapon
    // growth, then re-derive immediately so the new level takes effect now
    // rather than on the next unrelated stat change.
    player.level = gameState.level;
    recomputeStats();
    // Advances to the next uploaded loop when this level crosses a slot
    // boundary, and opens the filter a step further.
    setMusicLevel(gameState.level);
    gameState.xpToNext = xpForNextLevel(gameState.level, gameState.xpToNext);
    pendingLevels += 1;
    feedback('levelUp', { x: player.mesh.position.x, y: player.mesh.position.y });
  }
  // `running` as well as `paused`: death is filed mid-frame, from inside
  // resolveCombat, and the abilities that run after it in the same tick can
  // still land a kill worth a level. Without this the upgrade card opens over
  // the death dive and sits there for the whole descent.
  if (pendingLevels > 0 && !gameState.paused && gameState.running) openLevelUp();
}

function openLevelUp() {
  // A second card from the same batch of levels: the world is already dilated
  // and the mix already ducked, so only the cards come back — re-ramping
  // between two picks would be a dip to nowhere and a second wait.
  if (levelUpState.active) {
    showLevelUp();
    return;
  }
  // Freezes the run on this frame: no steering, no attacks, no spawning, no
  // combat — every body stops where it stands. What keeps moving is the world
  // (systems/levelUpTime.js owns the clock it moves on) and the idle mixers,
  // which are ticked below in animate.
  gameState.paused = true;
  // Muffle the mix and queue the upgrade loop — it takes over at the next
  // loop boundary rather than cutting the current one off mid-phrase.
  duckForUpgrade();
  // The cards arrive at the BOTTOM of the ramp, not on the frame the XP bar
  // filled — the level is worth watching land, and a menu over the top of it
  // is a screenshot of the fight you were in the middle of.
  startLevelUpTime(showLevelUp);
}

function applyLevelChoice(choice) {
  // A rolled card locks its variant in on the pick, not on the draw — the
  // other two cards on screen may also have been offering Glow Up! rolls,
  // and only the one actually taken should decide the run's element.
  if (choice.rolledElement) commitElement(choice.rolledElement);
  // The tier the card was DEALT at rides along with the pick — see
  // recomputeStats, which replays every held upgrade at the rarity it arrived
  // with rather than at whatever the ladder says today.
  addUpgrade(choice.id, choice.rarity);
  // Timestamped, so the report can charge an ability only for the time it was
  // actually held — a pick taken at minute nine hasn't had a run to prove
  // itself and shouldn't be ranked as if it had.
  playtest.recordUpgrade(choice.id, gameState.time);
  pendingLevels -= 1;
  if (pendingLevels > 0) {
    openLevelUp();
  } else {
    gameState.paused = false;
    sweepOpen(); // filter opens back up, main loop returns on the next boundary
    // The run is live again from this frame, in slow motion, and the world
    // accelerates back to full speed underneath it. Handing control back only
    // once the ramp finished would mean half a second where the game looks
    // playable and isn't.
    endLevelUpTime();
  }
}

// Splash hits (currently just the seagull bomb) are recorded here instead
// of applied immediately — onEnemyDamagedFeedback fires from deep inside
// combat.js's own enemies-array iteration, and mutating that array from
// within it (removing OTHER enemies at arbitrary indices) risks skipping or
// double-hitting something as the array shifts underneath the running loop.
// Processed once, safely, right after resolveCombat() returns for the frame.
const pendingSplashes = [];

// Pearls waiting to crack open, for exactly the same reason as the splashes
// above: the burst spawns bomblets and a bomblet can remove enemies, and
// onEnemyDamagedFeedback runs from inside combat.js's own iteration.
const pendingBursts = [];

// A mussel going off on whatever it hit: the particle burst, shake and crack
// from the `missileImpact` feedback event, plus a real sheet of light on top.
//
// The FLASH takes the target's colour — the mussel is a black shell with an
// orange trail, and a hit lighting up in the colour of the thing it hit is
// readable in a fight where you're tracking five shells at once. That is one
// sheet of light for a sixth of a second, which is a different thing from
// forty particles: the colour used to be handed to the burst as well, and
// forty magenta chips flying out of an orange trail is how the roster's hues
// ended up all over the screen. The particles are the emitter's palette now.
//
// Returns true when it fired, which is the caller's cue to skip the generic
// bullet-hit feedback for this one.
function missileImpactFeedback(assetKey, x, y, dmg, projectile, targetRadius = 0) {
  if (projectile?.mesh?.name !== 'missile') return false;
  const cfg = CONFIG.missile.impact ?? {};
  const color = assetBaseColor(assetKey) ?? cfg.fallbackColor ?? 0xffb347;
  // Same shape as the kill feedback's scale, so a mussel landing on a
  // megalodon and a megalodon dying agree about how big a deal it is.
  const scale = Math.min(2.2, 0.7 + targetRadius + dmg / 60);

  feedback('missileImpact', { x, y, scale });

  if (cfg.flash !== false) {
    spawnImpactFlash(x, y, {
      color,
      // Off the target's own size, so it's big relative to the thing that just
      // took it — a fixed world radius came out smaller than the mussel.
      // Splash Zone widens the detonation. The flash IS the missile's area
      // effect — there is no separate blast test, the shell's own damage is
      // the hit — so this is the one number that makes the card visible on
      // the homing mussels.
      radius: aoe(Math.max(cfg.minRadius ?? 2.2, targetRadius * (cfg.radiusScale ?? 3.2))),
      life: cfg.life ?? 0.17,
      glow: cfg.glow ?? 3.2,
    });
  }
  return cfg.replacesBulletHit !== false;
}

// Wraps the shared feedback hook with the name of the ability behind the hit,
// which is the one thing the hook itself can't work out: by the time damage
// lands, a garlic tick and a missile look identical to it. Every system's
// onEnemyDamaged goes through here, so the playtest report can say what share
// of a run's damage each upgrade actually produced.
function damageFrom(source) {
  return (e, dmg, x, y, dir, projectile) => {
    playtest.recordDamage(source, dmg, e);
    onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile);
  };
}

// Shared by every damage source (bullets, missiles, garlic, shrimp ring,
// strikes, the eel) so a hit feels the same regardless of what caused it.
function onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile) {
  // Shove the skeleton along the bullet's travel. For a creature with no
  // authored flinch clip (shark.glb ships no animation at all) this IS the
  // hit reaction — the spring that gives it its swim lag absorbs the kick and
  // carries it down the body. Damage-scaled and capped so a chip of splash
  // twitches it and a big hit visibly buckles it.
  if (dir && e.anim?.hasSpring) {
    const spring = CONFIG.animation.spring;
    const strength = Math.min(spring.impulseMax, dmg * spring.impulsePerDamage);
    impulseDir.set(dir.x, dir.y, 0);
    if (impulseDir.lengthSq() > 1e-8) e.anim.impulse(impulseDir.normalize(), strength);
  }

  // A mussel arriving is a detonation, not a pellet landing. It gets its own
  // event and, by default, takes the place of the generic one rather than
  // playing over it — two impact sounds on the same frame is a smear, and the
  // small spark burst underneath a big flash just muddies it.
  // e.radius, not e.def.radius — the live one folds in the spawn scale, so a
  // big specimen of a small species gets the bigger blast.
  const impact = missileImpactFeedback(e.def?.asset, x ?? e.mesh.position.x, y ?? e.mesh.position.y, dmg, projectile, e.radius);

  if (!impact) {
    feedback('bulletHit', {
      x: x ?? e.mesh.position.x,
      y: y ?? e.mesh.position.y,
      dirX: -(dir?.x ?? 0),
      dirY: -(dir?.y ?? 0),
      scale: Math.min(1.8, 0.6 + dmg / 30),
    });
  }

  // A pearl cracks open where it lands. Deferred through the same pending
  // queue the splash uses rather than bursting inline: this runs from inside a
  // loop over `enemies`, and spawning bomblets that immediately remove other
  // entries would shift the array under the running loop.
  if (projectile?.burst) {
    pendingBursts.push({ x: x ?? e.mesh.position.x, y: y ?? e.mesh.position.y, burst: projectile.burst });
  }

  if (projectile?.splashDamage > 0) {
    pendingSplashes.push({
      x: x ?? e.mesh.position.x,
      y: y ?? e.mesh.position.y,
      damage: projectile.splashDamage,
      radius: projectile.splashRadius,
      exclude: e,
      source: projectile.source ?? 'splash',
    });
  }
}

function processPendingSplashes() {
  if (pendingSplashes.length === 0) return;
  for (const s of pendingSplashes) {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const other = enemies[i];
      if (other === s.exclude) continue;
      const dx = other.mesh.position.x - s.x;
      const dy = other.mesh.position.y - s.y;
      if (dx * dx + dy * dy > s.radius * s.radius) continue;

      // `lethal` is not "a very large number" — a splash that has to kill
      // whatever it touches asks for exactly the health that is left, so the
      // playtest report still records an honest damage figure instead of an
      // Infinity that poisons every average downstream of it.
      const dealt = s.lethal ? Math.max(0, other.hp) : s.damage;
      other.hp -= dealt;
      other.flash = CONFIG.fx.hitFlash;
      other.hitThisFrame = true;
      playtest.recordDamage(s.source ?? 'splash', dealt, other);
      onEnemyDamagedFeedback(other, dealt, other.mesh.position.x, other.mesh.position.y);
      if (other.hp <= 0) {
        onEnemyKilledFeedback(other);
        removeEnemy(world.scene, i);
      }
    }
    // Anything going off in the water also breaks up the wreckage floating in
    // it — a mussel landing in a debris field should clear it — and takes
    // anybody standing in the blast off their boat.
    damageDebris(world.scene, s.x, s.y, s.radius, s.damage, {
      onDebrisBroken: (x, y) => feedback('debrisBreak', { x, y }),
    });
    damageCrew(world.scene, s.x, s.y, s.radius);
    // Opt-out, for blasts that bring their own. A lightning strike already
    // fired `lightningStrike` the moment the bolt was drawn; stacking bigKill
    // on top of it doubles the shake and adds the hit-stop that entry
    // deliberately does not have.
    if (s.feedback !== false) feedback('bigKill', { x: s.x, y: s.y, scale: 1.3 });
  }
  pendingSplashes.length = 0;

  for (const b of pendingBursts) burstPearl(world.scene, b.x, b.y, b.burst);
  pendingBursts.length = 0;
}

/**
 * Everything a creature leaving the arena is worth: the pearl-bomb blast, the
 * XP orb, the score, the toast, and the death feedback.
 *
 * @param e
 * Returns what the kill turned out to be worth — specifically whether it
 * emptied a school, which the strike's kill hook needs in order to award the
 * school-wipe chain link. Computed here already; returning it beats making
 * the caller re-derive it, which it couldn't anyway (the creature is out of
 * `enemies` by the time the hook returns).
 *
 * @param e
 * @param killEvent  overrides the `kill`/`bigKill` event with a named one, for
 *   deaths that aren't kills. Bakalar's net is the case that needs it — a fish
 *   dragged off in a net scores exactly like a kill and must keep all the
 *   bookkeeping above, but it did not explode, and firing the haul event
 *   ALONGSIDE this one just played two sounds for one departure.
 */
function onEnemyKilledFeedback(e, killEvent = null) {
  gameState.kills += 1;
  // An infected host bursting. Queued inside elements.js rather than acted
  // on here, because this runs from inside combat.js's own loop over
  // `enemies` — the same reason `pendingSplashes` exists a few lines below.
  onElementalHostKilled(e);
  // Credited to whatever last damaged this creature — the recorder tracks
  // that itself. A net haul does no damage at all, so it names itself.
  playtest.recordKill(e, killEvent === 'bakalarHaul' ? 'bakalar' : null);

  // Pearl bomb: an oyster's death detonates. Queued rather than applied here
  // for the same reason splash damage is — this fires from inside combat.js's
  // own iteration over `enemies`, so removing OTHER entries right now would
  // shift the array underneath the running loop.
  const blast = e.def.deathBlast;
  if (blast) {
    pendingSplashes.push({
      x: e.mesh.position.x,
      y: e.mesh.position.y,
      damage: blast.damage,
      radius: blast.radius,
      exclude: e,
      source: 'deathBlast', // the arena's own damage, not any upgrade's
    });
  }
  // XP comes only from collecting the dropped orb, not from the kill itself.
  // e.xp, not e.def.xp — the value is per-instance, so a fish that drifted in
  // during a lull between waves drops the quarter-value chum it was born with
  // (see CONFIG.spawn.waves.lull). The orb itself is identical either way:
  // same size, same heal, same charge refill, only the xp is scaled.
  spawnXpOrb(world.scene, e.mesh.position, e.xp ?? e.def.xp, e.def.radius);

  const combo = comboMultiplierFor(strikeState);
  const { points, schoolWipe } = computeKillPoints(e, enemies, combo);
  gameState.score += points;
  // `points` is already multiplied, so the toast shows what actually got
  // banked. The factor is still passed, but only to colour the toast as a
  // combo kill — it is no longer printed alongside the number.
  spawnScoreToast(world.camera, e.mesh.position.x, e.mesh.position.y, points, combo);

  const big = e.def.radius >= 1 || schoolWipe;
  // Bigger/tougher creatures drop in pitch and ring out longer, so a
  // megalodon dying doesn't sound identical to a minnow. Radius drives it
  // (it tracks size directly); hp folds in so a tanky small enemy still
  // lands heavier than a fragile one.
  const heft = Math.min(3, e.def.radius + (e.def.hp ?? 10) / 120);
  feedback(killEvent ?? (big ? 'bigKill' : 'kill'), {
    sfxOpts: { pitch: 1 / (0.75 + heft * 0.35), decayMul: 1 + heft * 0.35 },
    x: e.mesh.position.x,
    y: e.mesh.position.y,
    vx: e.vx,
    vy: e.vy,
    scale: Math.min(2.2, 0.7 + e.def.radius + (schoolWipe ? 0.6 : 0)),
    // No `color` here, deliberately. This used to pass the dying creature's own
    // emissive through, so a kill burst came out lime for a trout, magenta for
    // a reeffish, purple for a barracuda — a different hue every second or two
    // across a wave. `kill` and `bigKill` own one colour each now, and what
    // says which creature died is the size of the burst and the pitch of the
    // sound (see `heft` and `scale` above), which is the same information
    // without a rainbow on the screen. The tinted flash on a mussel hit is a
    // light, not particles, and is untouched.
  });

  return { points, schoolWipe };
}

// ---------------------------------------------------------------------------
// THE FOOD CHAIN
//
// Every link, whatever caused it, lands here. The strike system owns the
// counter (systems/strike.js); this owns what a link looks, sounds and feels
// like — so a chain extended by grabbing an orb reads as the same event as one
// extended by a dash connecting, which is the entire point of calling it a
// chain rather than a combo counter.
// ---------------------------------------------------------------------------

/** @param {string} source one of CONFIG.strike.chainOn — only 'strike' is a dash hit. */
function onChainHit(chain, source) {
  const x = player.mesh.position.x;
  const y = player.mesh.position.y;

  // FIRST, before the impact events below, and deliberately so: hit-stop is
  // rate-limited globally (see feedback.js) and whichever event asks first
  // claims the window. The extension is the bigger of the two things
  // happening, so it gets to be the one that stops the frame.
  if (chain >= (CONFIG.strike.foodChain?.minChain ?? 2)) {
    const fc = CONFIG.strike.foodChain ?? {};
    feedback('foodChain', {
      x, y,
      scale: Math.min(1.8, 0.8 + chain * 0.12),
      // Climbs a fixed step per link, like `strikeChain` does — the pitch is
      // how deep the chain is, readable without looking at the banner.
      sfxOpts: { pitch: 1 + (chain - 2) * 0.07 },
    });
    spawnChainToast(world.camera, x, y, chain);
    world.punchCamera((fc.punch ?? 0.045) + (fc.punchPerChain ?? 0.012) * (chain - 2));
    // The punch above is the fixed camera's version of this and stays exactly
    // as it was — both fire, and on the cinematic rig the punch rides on top
    // of the state's push-in the same way it rides on top of a death.
    cineEvent('foodChain');
  }

  // The dash's own impact. Only for links that ARE a dash hit — an orb
  // collected or a surface breached did not explode anything, and firing a
  // kill burst for one would put a corpse's worth of debris in the water for
  // a pickup.
  if (source === 'strike') {
    feedback(chain >= 3 ? 'bigKill' : 'kill', {
      x, y, scale: Math.min(2, 0.8 + chain * 0.3),
    });
  }

  // The per-link tick. A non-dash source STARTING a chain stays silent here:
  // chum arrives constantly, and a spark burst and a grid ripple on top of
  // every orb collected is noise on the game's most repeated event. Once the
  // chain is actually a chain, every link is worth hearing regardless of what
  // fed it.
  if (source === 'strike' || chain >= 2) {
    // Chain sound climbs in pitch with the combo, so a long run is
    // audible as an ascending run rather than the same blip repeated.
    // Through feedback() now, so the rumble climbs with it — `scale`
    // rides the same combo the pitch does.
    feedback('strikeChain', {
      x, y,
      scale: Math.min(1.6, 0.7 + chain * 0.25),
      sfxOpts: { pitch: 1 + (chain - 1) * 0.12 },
    });
    // And the grid itself gets shoved harder the deeper the chain goes.
    const warp = Math.min(CONFIG.strike.comboGridWarpMax, chain * CONFIG.strike.comboGridWarp);
    world.grid.ripple(x, y, warp, 8 + chain * 2);
  }
}

// Extend the chain from a non-dash source, and play the link if it landed.
// `chainStrike` returns 0 when the source is switched off or still inside its
// cooldown, which is what keeps a magnet sweep or an aura tick from firing a
// banner per frame.
//
// One call per event even when `links` > 1 (Porpoising stacks): the count
// jumps by three, but three copies of the same fanfare on one frame is a
// smear, not three times the feedback.
function chainFrom(source, links = 1) {
  const chain = chainStrike(source, links);
  if (chain) onChainHit(chain, source);
}

// A chum orb swallowed. Inside a live combo it goes into the charge meter, and
// the mouthful that tops the meter off scores a FOOD CHAIN link — the cycle
// the whole strike system is built around: charge, strike, eat, strike again.
//
// The meter is its own rate limit, which is why `chumFull` needs no cooldown
// the way the other chain sources do: it takes a whole meter's worth of orbs
// to earn each link, and that throttle scales with how much food is actually
// in the water rather than with a timer.
function onChumSwallowed(x, y) {
  if (!feedChum(player.stats)) return;
  // Fired at the ORB, not the seal, unlike every other chain source — the
  // point of feedback here is to teach that the thing you just ate is what
  // refilled the meter, and a burst on the seal doesn't say that.
  feedback('chumFull', { x, y });
  chainFrom('chumFull');
}

// One chum orb going down, wherever it came from: swum over, or hoovered up by
// the release gulp. A named function rather than the inline callback it used to
// be because the gulp has to take exactly this path — the gate stops the meter
// refilling for the length of a wind-up, and anything the gulp did differently
// would be a resource that gate had quietly deleted.
function collectChum(value, x, y, healMul = 1) {
  gainXP(value);
  // Eating moves the sun. A tiny push per orb — worth a fraction of a second
  // of ordinary passage (see CONFIG.dayNight.chumSeconds) — so a run that
  // hunts hard sees the light change noticeably faster than one that doesn't,
  // without any single mouthful being visible as a jump. Placed here rather
  // than in the pickup callback so the release gulp's hoovered orbs pay out
  // exactly like swum-over ones, which is the whole reason this function
  // exists.
  advanceClock(CONFIG.dayNight?.chumSeconds ?? 0);
  const heal = player.stats.maxHp * CONFIG.pickups.healFraction * healMul;
  player.hp = Math.min(player.stats.maxHp, player.hp + heal);
  // Pitch rises a full octave across the level-up bar: 0% progress =
  // base pitch, 100% = double (one octave up). Read AFTER gainXP so a
  // pickup that levels you up resets to the bottom of the next octave
  // rather than sounding the top of the old one. Clamped so a big
  // overflow can't shriek past the octave.
  const progress = Math.max(0, Math.min(1, gameState.xp / gameState.xpToNext));
  feedback('pickup', { x, y, sfxOpts: { pitch: 1 + progress } });
  // THE LOOP. Chum swallowed inside a live combo goes back into the
  // charge meter, and the swallow that fills it is what scores the FOOD
  // CHAIN link — so eating is both the reward for the last strike and
  // the ammunition for the next one. Outside a combo feedChum is a
  // no-op and this is just XP, exactly as it always was.
  onChumSwallowed(x, y);
}

// Shapes the basic shot's sound from the firing interval alone.
//
// `interval` is the seconds-between-shots this volley actually used, so both
// permanent Rapid Fire upgrades and the temporary pickup feed in here and are
// audible. Pellet count is not a parameter and must not become one — see
// CONFIG.weapon.shotSfx.
// A flash, of either kind. Fired from the weather's own clock, so it lands on
// menus and through a death as well as during a run — the storm is the
// world's, not the run's, and a sky that only thundered while you were alive
// would give the game away.
function onLightning(kind, x, y) {
  if (kind === 'strike') feedback('lightningStrike', { x, y });
  else feedback('thunder', { x, y });
}

// What a bolt reaching the water does. The creatures go through the same
// radius-AoE queue as a pearl bomb or a seagull's dive — same kill path, same
// orbs, same score, same food-chain link — with `lethal` set, so a shark with
// most of its health left dies exactly like a minnow does.
function resolveLightningStrike(strike) {
  const cfg = CONFIG.weather.lightning;
  pendingSplashes.push({
    x: strike.x,
    y: strike.y,
    radius: cfg.killRadius,
    damage: 0,
    lethal: true,
    exclude: null,
    source: 'lightning',
    feedback: false, // `lightningStrike` already fired when the bolt was drawn
  });

  // The seal. Off by default (see CONFIG.weather.lightning.playerDamage): an
  // instant death out of an offscreen event nobody could read is the least
  // fair thing in the game. Turned up, the surface becomes real danger in a
  // storm — and the counterplay already exists, because the bolt only ever
  // reaches what is near the top of the water.
  const dmg = cfg.playerDamage ?? 0;
  if (dmg > 0) {
    const dx = player.mesh.position.x - strike.x;
    const dy = player.mesh.position.y - strike.y;
    if (dx * dx + dy * dy <= cfg.killRadius * cfg.killRadius) {
      player.hp -= dmg;
      playtest.recordPlayerDamage(dmg, 'lightning');
      // Through the same door as everything else that hurts, so a bolt reads
      // at its true size instead of at the flat scale 1 it used to fire at —
      // this is one of the biggest single hits in the game and it should look
      // like one.
      playerDamageFx(dmg, player.stats.maxHp, player.mesh.position);
      if (player.hp <= 0 && !deathState.active) killPlayer();
    }
  }
}

function shotSfxOpts(interval) {
  const cfg = CONFIG.weapon.shotSfx ?? {};
  if (cfg.enabled === false) return undefined;
  const base = Math.max(0.001, CONFIG.weapon.fireRate);
  const maxRatio = Math.max(1.01, cfg.maxRateRatio ?? 3);
  // Clamped at 1 on the low side: a gun SLOWER than the starting one (nothing
  // grants that today, but a tuner slider can) drops back to the base voice
  // rather than pitching down below it.
  const ratio = Math.max(1, Math.min(maxRatio, base / Math.max(0.001, interval)));
  const t = (ratio - 1) / (maxRatio - 1);
  const opts = { pitch: 1 + t * (cfg.pitchRise ?? 0.3) };
  if (cfg.fitDecay !== false) {
    const decay = CONFIG.sfx.shoot?.decay ?? 0.2;
    opts.decayMul = Math.min(1, (interval * (cfg.decayHeadroom ?? 0.85)) / decay);
  }
  return opts;
}

function fire() {
  const s = player.stats;
  const rapid = rapidFireTimer > 0;
  const fireRate = rapid ? s.fireRate / CONFIG.rapidFirePickup.fireRateMul : s.fireRate;
  // Clone Warz first, THEN the pickup's multiplier — so the temporary powerup
  // multiplies the gun you actually have rather than the one you started with.
  const pellets = projectileCount(s.multishot, s);
  const shotCount = rapid ? Math.round(pellets * CONFIG.rapidFirePickup.multishotMul) : pellets;
  shootCooldown = fireRate;

  const dir = input.aim.clone().normalize();
  // The basic shot fires from EVERY emit point at once, not one at a time:
  // with the default 'fins' routing that's one bullet out of each flipper, so
  // the seal shoots with both hands. `multishot` is therefore pellets PER
  // POINT — each extra point adds one more bullet to each fin, fanned by the
  // deliberately tiny `finSpread` so they read as a burst from one flipper
  // rather than a shotgun.
  //
  // A model with no rig (or the emit points switched off) fires the same
  // TOTAL number of bullets from the body, fanned by the old `spread`, so
  // turning this off is a visual change and not a damage change.
  const rig = player.aimRig;
  const source = CONFIG.emitPoints.bullet;
  const points = emitPointCount(rig, source);
  const origins = Math.max(1, points);
  // How many limbs this model would naturally split a volley across. Read
  // from the rig's geometry rather than from the routing, so switching the
  // emit points off (or routing the shot to the mouth) changes where the
  // bullets come from without changing how many there are.
  const total = shotCount * (rig?.muzzles.length || 1);
  const perOrigin = Math.max(1, Math.round(total / origins));
  // Pellets sharing one limb get the tiny per-fin offset; pellets that are
  // already separated by coming out of different limbs don't need it, and a
  // single-point volley falls back to the normal spread so it still fans.
  const fan = origins > 1 ? CONFIG.weapon.finSpread : s.spread;

  for (let o = 0; o < origins; o++) {
    for (let i = 0; i < perOrigin; i++) {
      const offset = (i - (perOrigin - 1) / 2) * fan;
      const cos = Math.cos(offset);
      const sin = Math.sin(offset);
      spawnProjectile(world.scene, {
        origin: emitPoint(rig, source, o, dir, player.mesh.position, muzzlePoint),
        dir: new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos),
        faction: 'player',
        damage: s.damage,
        speed: s.speed,
        life: s.life,
        radius: s.radius,
        pierce: s.pierce,
        asset: 'bullet',
        source: 'gun',
      });
    }
  }

  const px = player.mesh.position.x;
  const py = player.mesh.position.y;

  // Muzzle flash belongs at the muzzle. `muzzlePoint` holds the last shot's
  // emit point; without one it's the original one-unit nudge off the body.
  // ONE shot sound per volley, not one per pellet — `shotCount` is used above
  // to spawn bullets and is deliberately absent from everything below.
  feedback('shoot', {
    x: points > 0 ? muzzlePoint.x : px + dir.x,
    y: points > 0 ? muzzlePoint.y : py + dir.y,
    dirX: dir.x,
    dirY: dir.y,
    sfxOpts: shotSfxOpts(fireRate),
  });

  applyRecoil(dir);
  if (CONFIG.weapon.recoilEnabled && s.recoil > 0) {
    // Exhaust plume out the back, which is also what moves the ship.
    feedback('boost', {
      x: px - dir.x * 0.9,
      y: py - dir.y * 0.9,
      dirX: -dir.x,
      dirY: -dir.y,
      scale: Math.min(2, s.recoil / 9),
    });
  }
}

function fireMissiles() {
  const s = player.stats;
  missileCooldown = CONFIG.missile.fireRate;
  const dir = input.aim.clone().normalize();
  const rig = player.aimRig;

  const shells = projectileCount(s.missileCount, s);
  for (let i = 0; i < shells; i++) {
    // Fan them out at launch so a volley doesn't look like one fat missile,
    // PLUS per-missile random jitter on top so repeated volleys don't all
    // trace the same fixed fan. Homing pulls each back onto the target from
    // wherever it started, so the paths differ but the outcome doesn't.
    const fan = (i - (shells - 1) / 2) * 0.3;
    const jitter = (Math.random() * 2 - 1) * CONFIG.missile.launchSpread;
    const spread = fan + jitter;
    const cos = Math.cos(spread);
    const sin = Math.sin(spread);
    const speedJitter = 1 + (Math.random() * 2 - 1) * CONFIG.missile.launchSpeedJitter;
    // Unlike the basic shot, a missile volley WALKS across the emit points
    // rather than firing from all of them at once — they leave one at a time
    // anyway, so alternating flippers reads as the seal lobbing them hand
    // over hand.
    const origin = emitPoint(rig, CONFIG.emitPoints.missile, muzzleCursor + i, dir, player.mesh.position, muzzlePoint);
    const launchDir = new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos);

    // The launch is an event in its own right, not just the moment a
    // projectile appears: a heavy flash off the flipper that actually threw
    // this shell, for every shell in the volley. Only the first shell gets
    // the full event — the rest use the flash-only variant, because five
    // overlapping thumps and five stacked screen shakes is mud, not weight.
    feedback(i === 0 ? 'missileLaunch' : 'missileLaunchExtra', {
      x: origin.x,
      y: origin.y,
      dirX: launchDir.x,
      dirY: launchDir.y,
      vx: launchDir.x * CONFIG.missile.speed,
      vy: launchDir.y * CONFIG.missile.speed,
      scale: CONFIG.missile.launchFlashScale,
    });

    spawnProjectile(world.scene, {
      origin,
      dir: launchDir,
      faction: 'player',
      damage: abilityDamage(CONFIG.missile.damage),
      speed: CONFIG.missile.speed * speedJitter,
      life: CONFIG.missile.life,
      radius: CONFIG.missile.radius,
      pierce: 0,
      asset: 'missile',
      source: 'missile',
      orient: true,
      homing: true,
      homingDelay: CONFIG.missile.homingDelay,
      turnRate: CONFIG.missile.turnRate,
      acquireRadius: targeting(CONFIG.missile.acquireRadius),
    });
  }
  // Rotate which flipper the NEXT volley starts from, so an odd missile count
  // doesn't leave one side doing all the throwing forever.
  if (CONFIG.fins.alternate) muzzleCursor++;
}

// The MUSSEL BARRAGE's launch points and its noise. The fan itself, the
// threshold and the shells all live in systems/musselVolley.js; what stays
// here is the two things only main.js can answer — where on the seal's rig a
// shell leaves from, and what that sounds like.
function launchMusselBarrage(power) {
  const rig = player.aimRig;
  const dir = strikeState.dashDir;
  return fireMusselBarrage(
    world.scene, power, player.stats.musselVolleyLevel, dir,
    (i) => emitPoint(rig, CONFIG.emitPoints.missile, i, dir, player.mesh.position, muzzlePoint),
    {
      // One full event for the barrage and flash-only for the rest, same
      // reason the missile volley does it: eight stacked thumps and eight
      // stacked shakes is mud, and this fires on a frame that is already loud
      // with the strike itself.
      onLaunch: (i, x, y, dirX, dirY, speed) => {
        feedback(i === 0 ? 'musselBarrage' : 'missileLaunchExtra', {
          x, y, dirX, dirY,
          vx: dirX * speed,
          vy: dirY * speed,
          scale: CONFIG.musselVolley.launchFlashScale,
        });
      },
    },
  );
}

// Scallop Squirter — spits the whole flight at once, each shell on its own
// random heading. No fan and no aim inheritance beyond the first frame: the
// scallop's jet takes over immediately (see projectiles.js updateJet), so
// spreading them carefully at launch would be effort the very first clap
// throws away.
// A hull going down, whoever sank it. Named rather than inline because the
// orca pod sinks boats too, and a pod kill has to score and sound exactly like
// a player kill — two copies of this would have drifted the first time one of
// them was tuned. The chum itself is spawned inside damageBoat; this is only
// the score and the noise.
function onBoatDestroyed(boat, chum) {
  gameState.score += Math.round(CONFIG.boats.xp * CONFIG.points.predatorMultiplier * (boat.isTrawler ? 2 : 1));
  // Its own event rather than `bigKill`: a hull going up throws the crew, the
  // wreckage and the catch all at once, and it should land heavier than the
  // biggest creature in the game dying.
  feedback('boatExplosion', {
    x: boat.mesh.position.x, y: boat.mesh.position.y,
    scale: boat.isTrawler ? 2.4 : 1.7,
    sfxOpts: { pitch: boat.isTrawler ? 0.7 : 0.85, decayMul: 1.6 },
  });
  // A trawler going down is a bigger moment than a rowboat.
  if (boat.isTrawler) world.grid.ripple(boat.mesh.position.x, boat.mesh.position.y, 6, 20);
}

function fireScallops() {
  const s = player.stats;
  const c = CONFIG.scallop;
  scallopCooldown = c.fireRate;
  const dir = input.aim.clone().normalize();
  const rig = player.aimRig;

  const shells = projectileCount(s.scallopCount, s);
  for (let i = 0; i < shells; i++) {
    const origin = emitPoint(rig, CONFIG.emitPoints.scallop, i, dir, player.mesh.position, muzzlePoint);
    // A full random heading rather than a cone around the aim. The card
    // promises a shell that goes wherever it likes, and biasing the launch
    // toward the crosshair would make the first second of its life look
    // aimed — which is the one thing this weapon is not.
    const angle = Math.random() * Math.PI * 2;
    const launchDir = new THREE.Vector2(Math.cos(angle), Math.sin(angle));

    spawnProjectile(world.scene, {
      origin,
      dir: launchDir,
      faction: 'player',
      damage: abilityDamage(c.damage),
      speed: c.speed,
      life: c.life,
      radius: c.radius,
      asset: 'scallopShell',
      source: 'scallop',
      spin: c.spin,
      jet: true,
      jetInterval: c.pulseInterval,
      jetSpeed: c.pulseSpeed,
      jetTurn: c.turnRange,
      jetDrag: c.drag,
      bounce: true,
      maxBounces: c.maxBounces,
      restitution: c.restitution,
    });
  }

  feedback('scallopLaunch', {
    x: player.mesh.position.x,
    y: player.mesh.position.y,
    scale: Math.min(1.6, 0.7 + shells * 0.12),
  });
}

// Oyster Blaster — one heavy pearl per shot. The burst it carries is described
// at launch (see systems/oyster.js) rather than looked up on impact, because
// by the time it lands the stat block may have moved under it.
function firePearlShot() {
  const s = player.stats;
  oysterCooldown = Math.max(
    CONFIG.oyster.fireRateFloor,
    CONFIG.oyster.fireRate - CONFIG.oyster.fireRatePerLevel * (s.oysterLevel - 1),
  );
  const dir = input.aim.clone().normalize();
  const origin = emitPoint(player.aimRig, CONFIG.emitPoints.oyster, muzzleCursor, dir, player.mesh.position, muzzlePoint);

  firePearl(world.scene, origin, dir, s.oysterLevel);
  feedback('pearlShot', { x: origin.x, y: origin.y, dirX: dir.x, dirY: dir.y });
}

function fireBounce() {
  const s = player.stats;
  bounceCooldown = s.bounceFireRate;
  const dir = input.aim.clone().normalize();
  spawnProjectile(world.scene, {
    origin: emitPoint(player.aimRig, CONFIG.emitPoints.bounce, 0, dir, player.mesh.position, muzzlePoint),
    dir,
    faction: 'player',
    damage: abilityDamage(CONFIG.bounce.damage),
    speed: CONFIG.bounce.speed,
    life: s.bounceLife,
    radius: CONFIG.bounce.radius,
    pierce: 0,
    asset: 'bounceShot',
    source: 'ricochet',
    orient: true,
    bounce: true,
    maxBounces: s.bounceMaxBounces,
    restitution: CONFIG.bounce.restitution,
    chain: true,
    chainRange: CONFIG.bounce.chainRange,
    chainLock: CONFIG.bounce.chainLock,
    chainSpeedGain: CONFIG.bounce.chainSpeedGain,
  });
}

// Bone Shrapnel: every enemy the strike dash connects with bursts a ring of
// fragments outward from ITS OWN position, not the seal's — the fish coming
// apart is the source, so a dash through a school leaves overlapping bursts
// rather than one puff at the player. Damage is a fraction of the strike hit
// that spawned it, which is what carries the chain multiplier through.
const shrapnelOrigin = new THREE.Vector3();
const shrapnelDir = new THREE.Vector2();

function spawnShrapnel(atPos, strikeDamage) {
  const level = player.stats.shrapnelCount;
  if (level <= 0) return;
  const c = CONFIG.strike.shrapnel;
  // The base count is guaranteed positive here (level > 0 above), so the Clone
  // Warz gate is already satisfied — routed through projectileCount anyway so
  // there is exactly one place the bonus is spelled out.
  const n = projectileCount(c.count + c.countPerLevel * (level - 1), player.stats);
  // A random offset for the WHOLE ring rather than per-fragment: the fragments
  // stay evenly spaced (so there are no bald patches to slip through) while
  // consecutive bursts don't land in an identical star pattern.
  const base = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = base + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * c.spread;
    shrapnelOrigin.set(atPos.x, atPos.y, 0);
    shrapnelDir.set(Math.cos(a), Math.sin(a));
    spawnProjectile(world.scene, {
      origin: shrapnelOrigin,
      dir: shrapnelDir,
      faction: 'player',
      damage: strikeDamage * c.damageFrac,
      speed: c.speed,
      life: c.life,
      radius: c.radius,
      pierce: c.pierce,
      asset: 'shrapnel',
      source: 'shrapnel',
      spin: c.spin,
    });
  }
}

// Every ricochet in a chain is louder, brighter and sprayier than the last, and
// the bink climbs a fraction of a semitone each time — so a shot pinballing
// through a crowd reads as one rising run instead of the same click ten times.
function bounceComboFx(p) {
  const c = CONFIG.bounce;
  const n = p?.bounceCombo ?? 0;
  const semitones = Math.min(c.comboPitchMax, n * c.comboPitchStep);
  return {
    scale: Math.min(c.comboScaleMax, 1 + n * c.comboScaleStep),
    sfxOpts: { pitch: Math.pow(2, semitones / 12) },
  };
}

function currentStarfishStats(level) {
  return {
    fireRate: CONFIG.starfish.baseFireRate * Math.pow(CONFIG.starfish.fireRatePerLevel, level - 1),
    scale: (CONFIG.starfish.baseRadius + CONFIG.starfish.radiusPerLevel * (level - 1)) / CONFIG.starfish.baseRadius,
  };
}

function fireStarfish() {
  const stats = currentStarfishStats(player.stats.starfishLevel);
  starfishCooldown = stats.fireRate;
  const dir = input.aim.clone().normalize();
  const origin = emitPoint(player.aimRig, CONFIG.emitPoints.starfish, 0, dir, player.mesh.position, muzzlePoint);
  spawnProjectile(world.scene, {
    origin,
    dir,
    faction: 'player',
    damage: abilityDamage(CONFIG.starfish.damage),
    speed: CONFIG.starfish.speed,
    life: CONFIG.starfish.life,
    radius: CONFIG.starfish.baseRadius * stats.scale,
    pierce: 0,
    asset: 'starfish',
    source: 'starfish',
    spin: CONFIG.starfish.spinSpeed,
    scale: stats.scale,
  });
  feedback('shoot', { x: origin.x, y: origin.y, dirX: dir.x, dirY: dir.y, scale: 0.7 });
}

function currentSeagullFireRate(level) {
  return CONFIG.seagullBomb.baseFireRate * Math.pow(CONFIG.seagullBomb.fireRatePerLevel, level - 1);
}

// Launch an attack run. The gull enters from off the side of the arena and
// flies itself in (systems/seagull.js) — nothing is fired from the seal, so
// this doesn't need an aim direction or a muzzle. spawnSeagull returns null
// when there are no crabs worth the trip; the cooldown is only consumed on a
// run that actually launched, so the next tick tries again immediately and a
// gull shows up shortly after the crabs do.
function fireSeagull() {
  const launched = spawnSeagull(world.scene, enemies);
  seagullCooldown = launched
    ? currentSeagullFireRate(player.stats.seagullLevel)
    : CONFIG.seagullBomb.retargetInterval;
}

function randomArenaPoint() {
  return new THREE.Vector3(
    bounds.left + Math.random() * bounds.width,
    bounds.bottom + Math.random() * (bounds.surfaceY - bounds.bottom),
    0
  );
}

// Bubbles rise, so spawning them low gives them somewhere to rise TO —
// spawning uniformly across the whole column would put half of them right
// at the ceiling already.
function randomLowArenaPoint() {
  const span = bounds.surfaceY - bounds.bottom;
  return new THREE.Vector3(
    bounds.left + Math.random() * bounds.width,
    bounds.bottom + Math.random() * span * 0.4,
    0
  );
}

let lastTime = performance.now();

function animate(now) {
  const stamp = now ?? performance.now();
  const rawDt = Math.min((stamp - lastTime) / 1000, 0.05);
  lastTime = stamp;

  // The death dive is the one thing that runs on the WALL clock, because it's
  // what decides the clock everything else runs on: it returns the time scale
  // for the whole frame (1 while nobody is dying) and drives the ragdoll on
  // its own dilated copy of it. Folded into `realDt` here rather than into the
  // gameplay `dt` below on purpose — the particles, the water, the mixer and
  // the camera all read realDt, and dilating only gameplay would leave the
  // seal sinking through spray still moving at full speed.
  // The level-up pause dilates the same way and for the same reason — see
  // systems/levelUpTime.js. Multiplied with the dive's scale rather than
  // picked between: the two very nearly never overlap (the run is frozen while
  // the cards are up, so nothing can kill you there), but a death during the
  // half-second ramp back OUT is reachable, and stacking is the right answer
  // for it — the dive takes over a world that hasn't finished speeding up yet,
  // rather than one or the other being thrown away mid-ramp.
  //
  // FIRST, so the dive below gets the last word on the playback rates in that
  // overlap: both systems push the mix around every frame, and the one whose
  // sequence is longer and louder should win the tie.
  const levelScale = updateLevelUpTime(rawDt);
  const deathScale = updateDeathDive(rawDt);
  const realDt = rawDt * deathScale * levelScale;

  // Shake and hit-stop run on real time; gameplay runs on scaled time. Fed the
  // RAW delta, not the dilated one: a hit-stop is measured in wall-clock
  // milliseconds by definition, and the death dive's own dilation would
  // otherwise stretch the kill's 70ms freeze into most of a second.
  const timeScale = updateFeedback(rawDt);
  // The gap between two hits being SHOWN, on the same raw clock and for the
  // same reason: this system is what fires the 60ms hit-stop, so a gap
  // measured in scaled time would be stretched by the freeze it caused.
  updatePlayerDamageFx(rawDt);
  // The dive owns the clock outright while it runs. The killing blow fires
  // `bigKill`, which carries a 70ms hit-stop — laid on top of a dilation
  // that's easing IN, that's a hole punched in the first tenth of the ramp:
  // the ocean froze solid for a beat while the seal, which reads its own
  // clock, carried on moving. A freeze inside a slow motion isn't a freeze,
  // it's a stutter. The level-up ramp owns it for the same reason: the kill
  // that granted the level lands its hit-stop on the exact frame the ramp
  // starts, and the last thing that ramp needs is a hole in its first tenth.
  const dt = deathState.active || levelUpState.active ? realDt : realDt * timeScale;

  updateInput(world.camera, player.mesh.position);
  // Reads the pad snapshot updateInput just took, so it must follow it. No-op
  // unless G is held.
  updateGamepadDebug();
  // No-op unless the sound feed is up (0). Sits here rather than inside the
  // pause gate so the ambient bed can still be watched from a menu.
  updateSfxDebug();
  // Same ordering requirement. Outside the pause gate on purpose: the level-up
  // menu is only ever open WHILE paused, so gating this on !paused would mean
  // the pad could never drive it. No-op when no menu is up.
  updateMenuNav();

  if (gameState.running && !gameState.paused) {
    gameState.time += dt;
    gameState.difficulty = gameState.time * CONFIG.spawn.difficultyPerSecond;
    // What a dropped orb is worth right now — see CONFIG.xp.dropRamp.
    setChumDifficulty(gameState.difficulty);
    shootCooldown -= dt;
    missileCooldown -= dt;
    scallopCooldown -= dt;
    oysterCooldown -= dt;
    bounceCooldown -= dt;
    starfishCooldown -= dt;
    seagullCooldown -= dt;
    simClock += dt;
    if (rapidFireTimer > 0) rapidFireTimer -= dt;

    // Every live chain link makes the seal faster — thrust, top speed, the
    // dash itself and the dash's turn rate all read this. Pushed in as a plain
    // field for the same reason as dashTimer: entities/ doesn't import from
    // systems/. Must be set BEFORE updatePlayer consumes it.
    player.comboSpeedMul = comboSpeedMul();

    updatePlayer(dt, input);

    // Porpoising: leaving the water extends the food chain. Upward crossings
    // only — coming back down is the same surface a second time, and counting
    // it would make every jump worth two links for no extra skill. The
    // cooldown in CONFIG.strike.chainOn is what stops a seal skimming the
    // water line from farming it; the ceiling is meant to be how often you can
    // get properly out of the water.
    if (player.breachDir > 0 && player.stats.breachChainLevel > 0) {
      chainFrom('breach', CONFIG.strike.breachChain.linksPerLevel * player.stats.breachChainLevel);
    }

    // Water on the glass, on the way OUT of the sea only. Outside the
    // Porpoising gate above on purpose: the lens gets wet whether or not the
    // player has taken the upgrade that makes a breach worth points. Scaled by
    // how hard the seal came out, so skimming the surface leaves a few beads
    // and a full jump soaks it.
    if (player.breachDir > 0) {
      cineBreach(Math.min(1.5, 0.35 + Math.abs(player.velocity.y) / 26));
    }

    // Water muffles the mix: the low-pass tracks how deep the player is,
    // opening up as they breach. Inside the pause gate on purpose — while
    // the upgrade screen has it ducked, depth must not sweep it back open.
    updateMusicDepth(player.mesh.position.y);
    // Same idea for the SFX bus, on its own narrower range — see
    // CONFIG.audio.bus.depth. No-op while depth tracking is switched off.
    updateBusDepth(player.mesh.position.y);

    // Breath and wake bubbles, fired from the mouth and tail-tip anchors
    // updatePlayer just refreshed. Gameplay dt, not real dt: a hit-stop
    // should freeze the seal's exhale along with everything else.
    //
    // The last argument opens BOTH emitters wide for a strike wind-up, scaled
    // by the power banked so far. It follows the BUTTON rather than
    // strikeState.charging, for the same reason `chumSealed` below does:
    // charging goes false the instant the bar runs dry, and the venting must
    // not cut out halfway through a hold the player is still committing to —
    // it plateaus at whatever was banked instead. `pending` here is one frame
    // old (updateCharge runs further down), which at 60fps is invisible and
    // costs nothing to leave alone.
    updateBubbles(
      dt, player.aimRig, player.velocity, player.aboveSurface,
      CONFIG.strike.enabled && input.strikeHeld ? strikeState.pending : 0,
    );

    // Oxygen hitting zero drains health instead of an instant death — the
    // deplete/refill itself already happened inside updatePlayer, alongside
    // the surface-breach check it already tracks.
    if (CONFIG.oxygen.enabled && player.oxygen <= 0) {
      player.hp -= CONFIG.oxygen.drainDamagePerSec * dt;
      // Filed as a threat like any creature — a run lost to the surface being
      // too far away is a different balance problem from one lost to sharks,
      // and the report should be able to tell them apart.
      playtest.recordPlayerDamage(CONFIG.oxygen.drainDamagePerSec * dt, 'drowning');
      // And it can finish the job. The death check used to live only in
      // combat's onPlayerHit, so drowning drained you to zero and then waited
      // for something to touch you — you could sit at 0 HP with no air and no
      // creature nearby and simply not die.
      if (player.hp <= 0 && !deathState.active) killPlayer();
    }

    // Ambient bubble and rapid-fire orb spawns, each on their own timer.
    bubbleSpawnTimer -= dt;
    if (bubbleSpawnTimer <= 0) {
      bubbleSpawnTimer = randomBetween(CONFIG.oxygen.bubbleSpawnMin, CONFIG.oxygen.bubbleSpawnMax);
      spawnBubbleOrb(world.scene, randomLowArenaPoint());
    }
    rapidFireSpawnTimer -= dt;
    if (rapidFireSpawnTimer <= 0 && CONFIG.rapidFirePickup.enabled) {
      rapidFireSpawnTimer = randomBetween(CONFIG.rapidFirePickup.spawnMin, CONFIG.rapidFirePickup.spawnMax);
      spawnRapidFireOrb(world.scene, randomArenaPoint());
    }

    updateCrabSpawner(dt, world.scene, gameState.difficulty);
    updateSeagulls(dt, world.scene, enemies, {
      onEnemyDamaged: (e, dmg, x, y) => damageFrom('seagull')(e, dmg, x, y),
      onEnemyKilled: onEnemyKilledFeedback,
      onSplash: (x, y) => feedback('breach', { x, y, scale: 0.9 }),
      // The stoop committing, up in the sky. Gives the bomb a tell before it
      // arrives instead of the first sign being the explosion.
      onDive: (x, y) => feedback('seagullDive', { x, y }),
      // Same deferred path the seagull's splash already used as a projectile:
      // this fires from inside a loop over `enemies`, so removing OTHER
      // entries right now would shift the array under the running loop.
      onImpact: (x, y, damage, radius) => {
        pendingSplashes.push({ x, y, damage, radius, exclude: null, source: 'seagull' });
        feedback('bigKill', { x, y, scale: 1.1 });
      },
    });
    updateBoats(dt, world.scene, gameState.difficulty, player.mesh.position, {
      onBoatDestroyed,
    });

    // No trigger to pull any more — autofire is the whole answer. Kept as a
    // named flag rather than inlined because it still gates which weapons run,
    // and because turning it off in the tuner should silence all of them.
    const wantsToFire = CONFIG.weapon.autofire;
    if (wantsToFire && shootCooldown <= 0 && input.aim.lengthSq() > 0.001) fire();
    if (wantsToFire && player.stats.missileCount > 0 && missileCooldown <= 0 && input.aim.lengthSq() > 0.001) fireMissiles();
    // Neither of these needs `wantsToFire`. The scallop is spat and forgotten
    // and the pearl is slow and heavy — both are meant to be in the water
    // whether or not you're holding the trigger, the same way the shrimp ring
    // and the starfish are. Aim still matters for the pearl, which is why it
    // keeps the aim check the scallop doesn't need.
    if (player.stats.scallopCount > 0 && scallopCooldown <= 0) fireScallops();
    if (player.stats.oysterLevel > 0 && oysterCooldown <= 0 && input.aim.lengthSq() > 0.001) firePearlShot();
    if (wantsToFire && player.stats.bounceLevel > 0 && bounceCooldown <= 0 && input.aim.lengthSq() > 0.001) fireBounce();
    // Starfish and seagull bombs are passive abilities, like garlic/eel/beluga
    // below — they fire on their own timer once taken, independent of input.
    if (player.stats.starfishLevel > 0 && starfishCooldown <= 0 && input.aim.lengthSq() > 0.001) fireStarfish();
    if (player.stats.seagullLevel > 0 && seagullCooldown <= 0) fireSeagull();

    // Strike: hold to burn fuel into power, RELEASE to launch. Runs before the
    // release check below, so a press and release inside one frame still banks
    // that frame's charge.
    updateCharge(dt, input.strikeHeld, player.stats);

    // Winding one up is felt as well as seen: a tremble that grows with the
    // power banked so far, and a rumble re-triggered on an interval because a
    // motor can only be handed discrete pulses. Both ride `pending`, not the
    // bar — what's building is the strike, and on a half-empty bar the wind-up
    // should peter out exactly as the fuel does rather than keep shaking.
    player.chargePose = strikeState.charging ? strikeState.pending : 0;
    // Mouth sealed for as long as the button is DOWN — the whole wind-up, not
    // just the part of it with fuel left to burn.
    //
    // `strikeState.charging` looks like the right signal and is not: it goes
    // false the moment the bar empties, one second into a hold at defaults.
    // After that the gate came off, and since a still-held button burns each
    // swallowed chum's refill straight back out again, the gate spent most of a
    // long hold open and the pile went down regardless. The button being down
    // is what the player means by "charging"; the fuel level is bookkeeping.
    //
    // Nothing can starve behind this. Letting go reopens the mouth on the same
    // frame, and everything that magnetised in during the hold is swallowed by
    // the ordinary collect path immediately after — even on a release too weak
    // to fire, which gulps nothing.
    player.chumSealed = CONFIG.strike.enabled
      && input.strikeHeld
      && CONFIG.strike.charge.gulp?.blockEating !== false;
    if (strikeState.charging) {
      addSustainedShake(CONFIG.strike.charge.shake * strikeState.pending);
      chargeHapticTimer -= dt;
      if (chargeHapticTimer <= 0) {
        chargeHapticTimer = CONFIG.strike.charge.hapticInterval;
        feedback('strikeCharging', {
          x: player.mesh.position.x, y: player.mesh.position.y,
          scale: 0.35 + strikeState.pending * 1.1,
        });
      }
    } else {
      // Re-armed the moment holding stops, so the next wind-up thumps on its
      // first frame instead of waiting out the remainder of a stale interval.
      chargeHapticTimer = 0;
    }

    // The let-go is what launches, and it spends however much power the hold
    // managed to bank. No input buffer: power is only ever banked while the
    // button is held, so a release under the threshold can't become fireable
    // by waiting, and there is nothing for a buffer to retry. Keeping the
    // button down covers what it used to — hold through an empty bar and the
    // wind-up resumes by itself the moment food refills it.
    if (input.strikeRelease) {
      // Strike launches BETWEEN the swim and the aim — the angular halfway
      // point by default, so the left stick and the cursor each get half a
      // say. Movement alone ignored where you were pointing; aim alone fought
      // the momentum you'd committed to. One shared function with the corridor
      // the lens drew during the wind-up, so the release goes exactly where
      // the player was just shown it would. Returns the zero vector only when
      // BOTH inputs are idle, which is the one case that shouldn't fire.
      const dir = strikeDirection(input.move, input.aim);
      const fired = (dir.x !== 0 || dir.y !== 0) && tryStrike(dir, player.stats);
      if (fired) {
        // Combo-scaled, same multiplier the speed ceiling in updatePlayer
        // uses — a dash fired deep in a chain launches harder, and the ceiling
        // is already raised to let it.
        const dashSpeed = player.stats.strikeDashSpeed * player.comboSpeedMul;
        player.velocity.x = strikeState.dashDir.x * dashSpeed;
        player.velocity.y = strikeState.dashDir.y * dashSpeed;
        // Lets updatePlayer raise the velocity ceiling for the length of the
        // dash — without it the clamp there eats the impulse before it moves
        // anything. See the note by that clamp. Reads the dash's ACTUAL
        // duration, not the base stat: a full-charge dash runs more than twice
        // as long, and the raised ceiling has to last exactly as long as it
        // does or the tail of the biggest strike gets clamped back to walking
        // speed halfway through.
        player.dashTimer = strikeState.dashDuration;

        // The full-charge payoff. Reads `power` — the banked amount this dash
        // was actually bought with — rather than the meter, which tryStrike
        // has already zeroed by now.
        launchMusselBarrage(strikeState.power);

        // Barrel roll. Whole turns only — a roll that stops three-quarters of
        // the way round leaves the seal belly-up for the rest of the dash —
        // and bought with banked power, so a full commitment is visibly a
        // bigger manoeuvre than a flick. Spread over the dash, which grows
        // with power too, so the angular speed stays roughly constant instead
        // of making big strikes spin frantically.
        const rollCfg = CONFIG.strike.roll;
        const turns = rollCfg?.enabled ? Math.round((rollCfg.turnsAtFull ?? 0) * strikeState.power) : 0;
        if (turns > 0) {
          const TURN = Math.PI * 2;
          // Continue from wherever the previous roll had got to rather than
          // restarting at upright. Striking again mid-roll is the NORMAL case
          // once the eat-and-strike loop is running, and snapping back to zero
          // to begin the next one was the most visible jump in the whole
          // manoeuvre. Rounding the destination out to the next whole turn
          // keeps the guarantee that it finishes flush with the mirror.
          const from = player.rollAngle;
          const sign = player.mirrorAngle ? -1 : 1; // roll the way it's facing
          const completed = sign > 0 ? Math.ceil(from / TURN) : Math.floor(from / TURN);
          player.rollFrom = from;
          player.rollTo = (completed + sign * turns) * TURN;
          player.rollDuration = strikeState.dashDuration * (rollCfg.durationMul ?? 1);
          player.rollElapsed = 0;
        }
        // One event instead of `boost` + a bare playSfx: the dash is the most
        // physical thing the player does and it had no haptic of its own,
        // because a loose playSfx call can't carry one.
        //
        // Scaled and pitched by how hard it was charged, so a tap and a full
        // commitment don't sound or feel identical — this is the moment the
        // charge pays off, and it's the only place the player finds out how
        // much they actually banked.
        feedback('strike', {
          x: player.mesh.position.x, y: player.mesh.position.y,
          dirX: strikeState.dashDir.x, dirY: strikeState.dashDir.y,
          scale: 0.7 + strikeState.power * 0.8,
          sfxOpts: { pitch: 1.18 - strikeState.power * 0.3 },
        });
        player.anim?.trigger('strike'); // roll clip, auto-returns to locomotion
        // The rim blows off the body as the banked power leaves it — the top of
        // the pulse that has been building for the whole wind-up. Scaled by the
        // power actually spent, so a fizzle pops and a full commitment
        // detonates. See CONFIG.strike.charge.outline.
        flarePlayerOutline(strikeState.power);

        // THE GULP. The wind-up held the mouth shut while chum gathered around
        // the seal; this is the swallow. Runs after the strike's own feedback
        // so the dash leads and the mouthful follows it, which is the order the
        // two happened in.
        //
        // Only on a release that FIRED — the mouthful is the strike's payoff,
        // not the hold's — and only if the gate was on: with `blockEating`
        // switched off nothing was ever held back, and hoovering the arena on
        // every release as well would be a second mechanic, not the off switch.
        if (CONFIG.strike.charge.gulp?.blockEating !== false) {
          gulpPickups(
            world.scene, player.mesh.position.x, player.mesh.position.y,
            player.stats.chumGulpRadius, collectChum,
          );
        }
      }
    }

    updateProjectiles(
      dt, world.scene, enemies,
      (x, y, p) => feedback('bounce', { x, y, ...bounceComboFx(p) }),
      (p) => feedback('scallopJet', { x: p.mesh.position.x, y: p.mesh.position.y, dirX: -p.dir.x, dirY: -p.dir.y }),
      // A pearl that times out in open water still cracks. Queued rather than
      // burst inline for the same array-mutation reason as everything else in
      // pendingBursts — this runs inside the projectile loop.
      (p) => { if (p.burst) pendingBursts.push({ x: p.mesh.position.x, y: p.mesh.position.y, burst: p.burst }); },
    );
    updateSpawning(dt, gameState, world.scene);
    updateEnemies(dt, world.scene, player.mesh.position, (x, y) => {
      feedback('chumEaten', { x, y, scale: 0.8 });
    }, (x, y, e) => {
      // Crumbs pulled off an orb on its way into a mouth. Thrown back along
      // the eater's own motion so they stream off the food rather than puffing
      // out of it — a shark hoovering on the pass leaves a wake of scraps.
      feedback('chumHoover', { x, y, vx: -e.vx, vy: -e.vy, scale: 0.7 });
    });

    resolveCombat(dt, world.scene, {
      // Bullets, mussels, ricochets, starfish and shrapnel all land here; the
      // projectile carries the tag that tells them apart.
      onEnemyDamaged: (e, dmg, x, y, dir, projectile) => {
        playtest.recordDamage(projectile?.source ?? 'gun', dmg, e);
        onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile);
      },
      onProjectileChained: (p, x, y) => feedback('bounce', { x, y, ...bounceComboFx(p) }),
      onPlayerHit: (dmg, dir, source = 'unknown') => {
        playtest.recordPlayerDamage(dmg, source);
        player.hp -= dmg;
        // Damage in, hit on screen out — see systems/playerDamageFx.js. It
        // banks contact damage (which arrives as a per-frame slice of a rate,
        // never as a number big enough to be worth showing on its own) and
        // hands back the size of the hit on the frames it decides to show one.
        // The gate used to live here as `dmg > 1`, which no contact rate in
        // the game can clear at any framerate it runs at — so a shark eating
        // you made no sound at all.
        const shown = playerDamageFx(dmg, player.stats.maxHp, player.mesh.position);
        if (shown > 0) {
          player.hitThisFrame = true;
          player.anim?.trigger('hit');
          // Same shove the enemies get, on the one chain of the seal that's
          // spring-driven rather than IK-driven. Sized by the whole banked hit
          // rather than by this frame's slice of it, so a body chewing on you
          // flicks the tail once and properly instead of never.
          if (dir) {
            const spring = CONFIG.animation.spring;
            impulseDir.set(dir.x, dir.y, 0);
            if (impulseDir.lengthSq() > 1e-8) {
              player.aimRig?.tailImpulse(
                impulseDir.normalize(),
                Math.min(spring.impulseMax, shown * spring.impulsePerDamage),
              );
            }
          }
        }
        if (player.hp <= 0 && !deathState.active) killPlayer();
      },
      onEnemyKilled: onEnemyKilledFeedback,
      onBoatHit: (boat, dmg, x, y, projectile) => {
        playtest.recordDamage(projectile?.source ?? 'gun', dmg, boat);
        // Hulls aren't in the `enemies` array, so they need the same mussel
        // branch spelled out here — `boat.mesh.name` is the asset key ('boat'
        // or 'trawler'), which is what the colour is read from.
        // Hulls are long boxes, so their enclosing radius overstates them —
        // halved, or a mussel on a trawler blooms across half the screen.
        if (missileImpactFeedback(boat.mesh?.name, x, y, dmg, projectile, boat.radius * 0.5)) return;
        feedback('bulletHit', { x, y, scale: 1.1 });
      },
      // Wreckage shot at. A chunk taking a hit reads like any other bullet
      // landing; one coming apart gets its own, heavier crack.
      onDebrisHit: (x, y) => feedback('bulletHit', { x, y, scale: 0.8 }),
      onDebrisBroken: (x, y) => feedback('debrisBreak', { x, y }),
      // Somebody knocked off a deck.
      onCrewHit: (x, y) => feedback('crewHit', { x, y }),
      // --- Glow Up! ---------------------------------------------------------
      // The elemental half of a pellet landing. One event PER element — the
      // burst's colour is the emitter's, so the four elements are four
      // emitters and therefore four entries. `kind` is the element id, which
      // is what builds the key.
      onElementHit: (x, y, kind) => feedback(elementHitEvent(kind), { x, y }),
      onArc: (fromX, fromY, toX, toY) => {
        spawnArcBolt(world.scene, fromX, fromY, toX, toY);
        feedback('elementArc', { x: toX, y: toY });
      },
      onFreeze: (x, y) => feedback('elementFreeze', { x, y }),
    });
    processPendingSplashes(); // safe now that resolveCombat's own loop has finished

    // Elemental statuses — venom and infection ticking, chill thawing, the
    // contagion creeping to neighbours, and the bursts queued by any infected
    // host that died during combat above. Placed here for exactly the reason
    // the splash queue is drained here: this both damages and REMOVES enemies,
    // and doing that inside resolveCombat's own loop would shift the array
    // under it.
    // The seal wears the element it rolled — see updateElementSkin. Cheap: it
    // returns immediately unless the level or the time of day has moved.
    updateElementSkin(player.body);
    updateElements(dt, world.scene, enemies, {
      onEnemyDamaged: damageFrom('bioluminescence'),
      onEnemyKilled: onEnemyKilledFeedback,
      onBurst: (x, y, radius) => feedback('infectionBurst', { x, y, scale: Math.min(2, radius / 4) }),
      onSpread: (fx, fy, tx, ty) => feedback('infectionSpread', { x: tx, y: ty, dirX: tx - fx, dirY: ty - fy }),
    });

    // Sea garlic and the shrimp ring damage independently of gunfire.
    updateGarlic(dt, world.scene, player.mesh.position, player.stats.garlicLevel, enemies, {
      onEnemyDamaged: damageFrom('garlic'),
      onEnemyKilled: onEnemyKilledFeedback,
      // Scaled by how many the tick caught, so grinding a whole school reads
      // heavier than nicking one crab — but clamped low, because this is the
      // most frequently fired event in the game and it must stay under the
      // fight rather than competing with it.
      onTick: (x, y, count) => feedback('garlicTick', { x, y, scale: Math.min(1.4, 0.6 + count * 0.12) }),
    });
    updateShrimpRing(dt, world.scene, player.mesh.position, projectileCount(player.stats.shrimpCount, player.stats), enemies, {
      onEnemyDamaged: damageFrom('shrimp'),
      onEnemyKilled: onEnemyKilledFeedback,
      onContact: (x, y) => feedback('shrimpHit', { x, y }),
    });
    updateEel(dt, world.scene, player.mesh.position, player.stats.eelLevel, enemies, {
      onEnemyDamaged: damageFrom('eel'),
      onEnemyKilled: onEnemyKilledFeedback,
      onBolt: (x, y) => feedback('eelBolt', { x, y }),
      // Pitch climbs per link, the same trick the strike chain uses — a bolt
      // that reached six creatures is an ascending run of ticks, so how far
      // it travelled is audible even when the arc is off-screen. Volume
      // FALLS as it goes, because each hop is further away and the tail of a
      // long chain shouldn't be the loudest part of it.
      onChainLink: (x, y, i) => feedback('eelChain', {
        x, y,
        scale: Math.max(0.45, 1 - i * 0.11),
        sfxOpts: { pitch: 1 + i * 0.09 },
      }),
    });
    updateBeluga(dt, world.scene, player.mesh.position, player.stats.belugaLevel, enemies, simClock, {
      onTrap: (e) => {
        // No damage, so it can only be measured in what it takes off the
        // board — the report ranks the control abilities on these events.
        playtest.recordControl('beluga');
        feedback('belugaTrap', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.1 });
      },
    });
    updateSealTeam(dt, world.scene, player.mesh.position, player.stats.sealTeamLevel, enemies, {
      onEnemyDamaged: damageFrom('sealTeam'),
      onEnemyKilled: onEnemyKilledFeedback,
      onLunge: (x, y) => feedback('sealLunge', { x, y }),
      onRam: (x, y) => feedback('sealRam', { x, y }),
      onSquadFire: (x, y, dirX, dirY) => feedback('sealShot', { x, y, dirX, dirY }),
    });
    updateCalamari(dt, world.scene, player.mesh.position, player.stats.calamariLevel, enemies, {
      onEnemyDamaged: damageFrom('calamari'),
      onEnemyKilled: onEnemyKilledFeedback,
      onWave: (x, y) => {
        // Was borrowing `boost` — the dash's particles, no sound of its own,
        // and none of the weight a shockwave leaving the seal should carry.
        feedback('calamariPulse', { x, y });
        world.grid.ripple(x, y, 3, 10);
      },
    });
    updateDumbo(dt, player.mesh.position, player.stats.dumboLevel, enemies, simClock, {
      onCharm: (e) => {
        playtest.recordControl('dumbo');
        feedback('dumboCharm', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.1 });
      },
    });
    updateOyster(dt, world.scene, enemies, {
      onEnemyDamaged: damageFrom('oyster'),
      onEnemyKilled: onEnemyKilledFeedback,
      onBlast: (x, y, r) => feedback('pearlBurst', { x, y, scale: Math.min(1.6, r / 2.4) }),
    });
    updateOrcaPod(dt, world.scene, player.mesh.position, player.stats.orcaLevel, enemies, {
      onEnemyDamaged: damageFrom('orca'),
      onEnemyKilled: onEnemyKilledFeedback,
      onStrike: (x, y) => feedback('orcaStrike', { x, y }),
      onBoatHit: (boat, dmg, x, y) => feedback('orcaStrike', { x, y, scale: 1.3 }),
      onCrewEaten: (x, y) => feedback('crewEaten', { x, y, scale: 0.9 }),
      onBoatDestroyed,
    });
    // Must follow updateEnemies for the same reason Bakalar's net does: a held
    // fish's position is written directly, and enemies.js has already
    // integrated velocity for the frame — running this first would let every
    // grabbed fish snap straight back out of the arm.
    updateOctoGrab(dt, world.scene, player.mesh.position, player.stats.octoGrabLevel, enemies, {
      onGrab: (e) => feedback('octoGrab', { x: e.mesh.position.x, y: e.mesh.position.y }),
      onPop: (e, x, y) => {
        playtest.recordControl('octoGrab');
        feedback('octoPop', { x, y, scale: 1.1 });
        // Paid as chum rather than as a kill: the arm did the work, and chum
        // feeds the strike meter, so the octopus converts incoming pressure
        // into strike uptime instead of into raw XP.
        for (let n = 0; n < CONFIG.octoGrab.chumPerPop; n++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * CONFIG.octoGrab.chumSpread;
          spawnXpOrb(world.scene, { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, z: 0 }, CONFIG.octoGrab.chumXp, e.radius);
        }
      },
    });
    // Must follow updateEnemies: the net writes caught positions directly, and
    // enemies.js integrates position for the frame — running this first would
    // just have every catch snap back out of the net.
    updateBakalar(dt, world.scene, player.stats.bakalarLevel, enemies, {
      // A haul is a kill as far as the rest of the game is concerned: same
      // score, same XP orb. It just didn't involve any damage — so it keeps
      // all of that and swaps only the death event, rather than exploding a
      // fish that was quietly dragged off in a net.
      onHauled: (e) => {
        playtest.recordControl('bakalar');
        onEnemyKilledFeedback(e, 'bakalarHaul');
      },
      onBombDrop: (x, y) => feedback('bakalarBombDrop', { x, y }),
      onBombBlast: (x, y, r) => {
        feedback('bakalarBombBlast', { x, y, scale: Math.min(2.4, r / 6) });
        world.grid.ripple(x, y, 5, r);
      },
      onEnemyDamaged: damageFrom('bakalarBomb'),
      onEnemyKilled: onEnemyKilledFeedback,
      // The bomb pays in chum, not XP — see the note on CONFIG.bakalar.bomb.
      // The haul above already pays XP, and having both halves of one ability
      // compete to collect the same fish is what would make the boat the only
      // upgrade worth taking.
      onChum: (x, y) => spawnXpOrb(world.scene, { x, y, z: 0 }, CONFIG.bakalar.bomb.chumXp, 0.8),
    });

    // Strike system: chain-hit damage, charge recharge, and the orb timer.
    const { spawnOrb } = updateStrike(dt, world.scene, player.mesh.position, player.stats, enemies, {
      onEnemyDamaged: (e, dmg) => {
        playtest.recordDamage('strike', dmg, e);
        onEnemyDamagedFeedback(e, dmg);
        // Shrapnel rides the `dmg` the strike just dealt, so it inherits the
        // chain multiplier for free — a fragment burst off the fifth link of a
        // chain is worth more than one off the first.
        spawnShrapnel(e.mesh.position, dmg);
      },
      // A school emptied by the dash is a chain link of its own, on top of the
      // link the killing hit already scored. Fired from the STRIKE's kill hook
      // rather than from onEnemyKilledFeedback itself, which is what makes it
      // "in one strike": this hook only ever fires for creatures the dash
      // itself killed, so a school finished off by a stray bullet or a net a
      // second later can't claim it.
      onEnemyKilled: (e) => {
        const { schoolWipe } = onEnemyKilledFeedback(e);
        if (schoolWipe) chainFrom('schoolWipe');
      },
      onChainHit: (chain) => onChainHit(chain, 'strike'),
    });
    if (spawnOrb) spawnStrikeOrb(world.scene, randomArenaPoint());

    // A dash goes THROUGH floating wreckage. Driven from here rather than from
    // inside updateStrike so the strike system keeps knowing only about
    // creatures; the dash's own per-creature "once per dash" bookkeeping isn't
    // needed, because a chunk shrugs off further hits for a moment after each
    // one lands (see CONFIG.boats.debris.hitInvuln).
    if (strikeState.active) {
      damageDebris(
        world.scene, player.mesh.position.x, player.mesh.position.y,
        player.stats.hitRadius + 0.3,
        player.stats.strikeDamage * (CONFIG.boats.debris?.strikeMul ?? 1),
        { onDebrisBroken: (x, y) => feedback('debrisBreak', { x, y }) },
      );
    }

    // A BODY IN THE WATER. The seal eats one on contact, and it pays out
    // through the same collectChum every orb goes through — so the xp, the
    // heal, the charge meter and the food chain all land exactly as they do
    // for chum, because it IS chum, just a large piece of it.
    {
      const meal = nearestFloatingCrew(
        player.mesh.position.x, player.mesh.position.y, player.stats.hitRadius);
      if (meal) {
        const at = eatCrew(world.scene, meal);
        if (at) {
          collectChum(at.xp, at.x, at.y, at.healMul);
          feedback('crewEaten', { x: at.x, y: at.y });
        }
      }
    }

    // THE SEAL HIMSELF. Swimming or breaching through a boat's deck takes its
    // crew off it — checked every frame rather than only mid-dash, because a
    // seal arriving at speed is the same event to a man standing on a plank
    // whether or not the strike button was involved.
    damageCrew(
      world.scene, player.mesh.position.x, player.mesh.position.y, player.stats.hitRadius,
      {
        dirX: player.velocity.x,
        dirY: player.velocity.y,
        onCrewHit: (x, y) => feedback('crewHit', { x, y }),
      },
    );

    // Sharks feed on fish whether or not the player is involved.
    resolvePredation(dt, world.scene, {
      onFishEaten: (fish, pred) => {
        feedback('bite', { x: fish.mesh.position.x, y: fish.mesh.position.y, vx: pred.vx, vy: pred.vy });
      },
      // A hunter taking a body out of the water. The player gets nothing for
      // it — that was their meal and something else had it.
      onCrewEaten: (x, y) => feedback('crewEaten', { x, y, scale: 0.9 }),
    });

    updatePickups(
      dt, world.scene, player, collectChum,
      (x, y) => {
        // The blue orb skips the wind-up entirely: a full meter, instantly.
        // If that fill lands inside a combo it reaches the chain the same way
        // chum does — through the meter, which is the only route orbs have.
        const filled = restoreCharge();
        feedback('levelUp', { x, y, scale: 0.6 });
        if (filled) chainFrom('chumFull');
      },
      (x, y) => {
        // Pitched by how badly it was needed — a bubble grabbed while
        // suffocating pops low and fat, one grabbed on a full bar is a thin
        // little tick. Read BEFORE the refill, or every pop reports the bar
        // it just topped up rather than the emergency it answered.
        const maxO2 = Math.max(1, player.stats.maxOxygen);
        const need = 1 - Math.max(0, Math.min(1, player.oxygen / maxO2));
        player.oxygen = Math.min(maxO2, player.oxygen + CONFIG.oxygen.bubbleRefillAmount);
        // Bubbles and rapid-fire orbs deliberately DON'T feed the meter: they
        // already carry their own reward, and letting every floating thing in
        // the water sustain a combo would make the food chain about hoovering
        // rather than about hunting.
        feedback('bubblePop', { x, y, scale: 0.8 + 0.6 * need, sfxOpts: { pitch: 1.25 - 0.45 * need } });
      },
      (x, y) => {
        rapidFireTimer = CONFIG.rapidFirePickup.duration;
        feedback('levelUp', { x, y, scale: 1.1 });
      }
    );
    // Last thing in the gameplay tick, so the sample sees the frame as the
    // player experienced it: damage already applied, corpses already removed.
    // Gameplay dt, not real dt — a hit-stop shouldn't count as a second of
    // survival, and every rate in the report is per gameplay-second.
    playtest.tick(dt, {
      time: gameState.time,
      hp: player.hp,
      maxHp: player.stats.maxHp,
      level: gameState.level,
      score: gameState.score,
      alive: enemies.length,
    });

    updateHUD(gameState, player, strikeState, rapidFireTimer, world.camera);
  } else if (deathState.active) {
    // The run is over, but the ocean isn't. Just enough of the sim to keep the
    // water populated while the body goes down: creatures keep swimming (and
    // keep hunting each other), and shots already in the air finish their
    // flight. Deliberately no combat, no spawning, no pickups and no abilities
    // — nothing the seal does or that is done to it, since it's dead. Same
    // dilated `dt` as everything else, so the whole scene sinks together.
    updateEnemies(dt, world.scene, player.mesh.position, (x, y) => {
      feedback('chumEaten', { x, y, scale: 0.8 });
    }, (x, y, e) => {
      feedback('chumHoover', { x, y, vx: -e.vx, vy: -e.vy, scale: 0.7 });
    });
    // The one thing that still SPAWNS after the run is over. Same dilated dt as
    // the rest of the descent, so the arrivals slow with it instead of marching
    // in at full speed under a slow-motion corpse.
    updateDeathPile(dt, world.scene, gameState.difficulty, player.mesh.position);
    updateProjectiles(dt, world.scene, enemies);
    // The mix goes down with the body. This normally rides the player's depth
    // inside the run block above, so without it here the muffling froze at
    // whatever depth the seal happened to die at — the descent is the one
    // moment in the game where you should hear the water closing over you.
    // The sweep back open is the first thing the restart transition does —
    // and this has to get out of its way, or the two are competing claims on
    // one cutoff and the per-frame one wins every time.
    if (deathState.phase !== 'restart') updateBusDepth(player.mesh.position.y);
    resolvePredation(dt, world.scene, {
      onFishEaten: (fish, pred) => {
        feedback('bite', { x: fish.mesh.position.x, y: fish.mesh.position.y, vx: pred.vx, vy: pred.vy });
      },
      // A hunter taking a body out of the water. The player gets nothing for
      // it — that was their meal and something else had it.
      onCrewEaten: (x, y) => feedback('crewEaten', { x, y, scale: 0.9 }),
    });
  } else if (gameState.paused && levelUpState.active) {
    // The level-up freeze. Nothing above ran, so no creature steers, hunts,
    // bites, spawns or scavenges and no shot travels — the fight is stopped
    // dead where it stands, which is the whole point of the beat.
    //
    // What still moves is the pose: the mixers tick on the dilated clock so
    // the ocean is full of animals breathing on the spot rather than a
    // freeze-frame. The seal gets the same treatment a few lines down, in the
    // block that idles it behind every other menu.
    animateEnemiesIdle(realDt);
  }

  // Toasts run on REAL time, outside the pause gate, so the numbers from the
  // kills that triggered a level-up finish rising instead of hanging frozen
  // behind the upgrade screen.
  updateToasts(realDt);

  // Suffocation — the beep, the surface gasps, and the pixelate/band-pass
  // blackout. Outside the pause gate on purpose, and told whether the run is
  // live rather than gated on it: on death, on a menu, and behind the upgrade
  // screen it has to keep ticking so the effect EASES back out. Gated, the
  // screen would simply freeze mid-pixelation on the game-over card. Real
  // time for the same reason toasts use it — a hit-stop shouldn't stall a
  // warning beep.
  updateOxygenFx(realDt, player, gameState.running && !gameState.paused);

  // Animation runs EVERY frame, not just during an active run. updatePlayer
  // (which drives the player's controller) only runs while the game is
  // running and unpaused, so on the start menu, the level-up screen and the
  // game-over screen the seal used to freeze mid-pose — and any ability mesh
  // with it. Ticking here means a state is always live from the first frame,
  // rather than appearing dead until something else happens to rebuild it.
  if (!gameState.running || gameState.paused) {
    if (CONFIG.animation.enabled) {
      const idleState = stateForSpeed(0, player.aboveSurface);
      player.anim?.update(realDt, idleState, false);
    }
    // The aim rig has to keep ticking here too, for the same reason: it runs
    // inside updatePlayer during a run, so without this the flippers and head
    // freeze mid-aim behind a menu and the bubble anchors go stale where they
    // stand. Never `engaged` — nobody is shooting on a menu.
    //
    // A dead seal gets NO aim at all, and that is half the ragdoll: with
    // nothing to point at, the fin and head chains ease their weights to zero
    // and hand the bones back, so the flippers stop tracking the cursor and go
    // slack. The other half is the `limp` flag — see updateAimRig — which
    // keeps the tail's spring live through the death clip so it trails and
    // flops off the body's own tumble.
    updateAimRig(realDt, deathState.active ? null : input.aim, false, 0, deathState.active);
  }

  updateStrikeRing(realDt, player.mesh.position, strikeState, gameState.running);
  // The seal's own rim, throbbing through a wind-up and flaring on the release.
  // Outside the pause gate alongside the ring, and on real time for the same
  // reason: the pulse is a readout of a button being held, and a hit-stop
  // freezing it mid-throb would read as the charge having stalled. The wind-up
  // argument goes to 0 the moment a run isn't live, which eases the rim back to
  // its tuned look on the game-over screen instead of leaving it lit.
  updatePlayerOutline(
    realDt,
    gameState.running && !gameState.paused && CONFIG.strike.enabled && input.strikeHeld
      ? strikeState.pending
      : 0,
  );
  // Real time, like the ring above: the indicator is a readout of where you
  // are pointing RIGHT NOW, and a hit-stop must not freeze it a frame behind
  // the cursor. The guns run themselves, so this reads autofire rather than a
  // trigger — otherwise the beam would sit at idle opacity for a whole run.
  updateAimIndicator(
    realDt, player.mesh.position, input.aim,
    CONFIG.weapon.autofire,
    gameState.running && !gameState.paused,
  );
  updateProjectileTrails(realDt, world.scene, projectiles);
  // Real time, like the trails and the particles above: a hit-stop shouldn't
  // stall a shell that's still in the air, and the flash it triggered has to
  // keep easing out rather than freezing mid-bloom on the frame it landed.
  // The seal is the listener rather than the camera, since the camera lags
  // behind it and a lagging listener smears the pan.
  updateProjectileVoices(realDt, projectiles, player.mesh.position, gameState.running && !gameState.paused);
  updateImpactFlashes(realDt);
  // The sky and the weather run on the WALL clock, outside the pause gate and
  // untouched by the death dive's dilation: they belong to the world, not to
  // the run. A sunset that stalls behind the upgrade screen, or a storm that
  // crawls because the seal is dying, reads as a bug rather than as drama.
  // Both must land before world.updateSurface, which paints what they decided.
  updateDayCycle(rawDt);
  updateWeather(rawDt);
  // The musical clock every beat-synced shader reads, carried to now BEFORE
  // any of them run. Once a frame rather than once per material: the transport
  // position is the same answer for all of them, and a school of forty fish
  // asking separately is forty trips through the audio clock for one number.
  // See systems/beatSync.js. Raw dt, like the shaders that read it.
  updateBeatSync(rawDt);
  // How deep the food chain is, for the night sky to reach by — every link
  // strings the constellations further across the sky and lets each star hold
  // more neighbours (see systems/constellations.js). Handed in rather than
  // imported there, for the reason grid.js gives about the charge meter: a
  // backdrop wants one number, not a dependency on combat. Pushed EVERY frame
  // from the live chain rather than fired once per link, so the reach retracts
  // exactly when the chain window expires instead of on a second timer that
  // would drift from the real one the first time anyone tuned `chainWindow`.
  // Above world.updateSurface, which is what paints it.
  world.constellations.setChain(liveChain());
  // Same wall clock, same reasoning: the current is a property of the ocean,
  // not of the run. One uniform write per material — the bend itself is all
  // vertex shader, so this does not scale with how much grass is on screen.
  updateGrassSway(rawDt);
  // And the same again for the creatures that light themselves. Raw dt on
  // purpose: a lanternfish's own glow has no business stopping because the
  // game froze for 60ms on a hit.
  updateBiolumSkin(rawDt);

  // Surface first: it advances the wave, and bubbles bursting at the water line
  // are solved against wherever the wave ended up this frame, not last frame's.
  world.updateSurface(realDt);
  // Immediately after, because updateSurface is what spawns them. Drained
  // unconditionally and only ACTED on during a live run: queued strikes that
  // sat through a menu would otherwise all resolve on the frame it closed.
  if (lightningStrikes.length) {
    if (gameState.running && !gameState.paused && !deathState.active) {
      for (const strike of lightningStrikes) resolveLightningStrike(strike);
      // Safe to run here: the requirement is only that resolveCombat's loop
      // over `enemies` has already finished, and it finished well above.
      processPendingSplashes();
    }
    lightningStrikes.length = 0;
  }
  updateParticles(realDt);
  // The camera is what turns a finger on the glass into a point in the water,
  // and the strike meter is what makes a charging finger grow — see updateTouch
  // in systems/grid.js. Both are handed in rather than imported there.
  world.grid.update(realDt, player.mesh.position, player.velocity, {
    camera: world.camera,
    charging: strikeState.charging,
    charge: strikeState.pending,
  });
  world.hexTiles.update(player.mesh.position);
  // The death shot: the frame closes in on the body and rides it down. Claimed
  // per frame, immediately before the camera update that consumes it — the
  // dive owns the timing, world.js owns the framing maths (and the clamp that
  // keeps the view inside the ocean).
  if (deathState.active) {
    world.focusCamera(player.mesh.position, deathState.camZoom, deathState.camWeight);
  }
  // The signals the cinematic rig picks its state from, and the motion it
  // frames off. Ignored entirely by the fixed camera — see world.updateCamera,
  // which doesn't read them unless CONFIG.cinecam.enabled.
  world.updateCamera(player.mesh.position, realDt, {
    velocity: player.velocity,
    aim: input.aim,
    // Where a strike released THIS frame would actually go — literally the
    // same function the release calls, not a copy of the rule, so the corridor
    // and the dash cannot drift apart. Written into a reused object because
    // this runs every frame.
    dashDir: strikeDirection(input.move, input.aim, dashPrediction),
    chargePower: strikeState.pending,
    // The button, for the lens; the fuel-gated flag, for everything that a
    // dry meter really should stop. See the note in cineCamera.js.
    //
    // Gated on the run being live, which strikeState.charging got for free by
    // being written inside the pause block and this does not: input is read
    // every frame regardless, so a strike button still held as the level-up
    // screen opens would otherwise punch the lens in behind the menu and hold
    // it there for as long as the card was being chosen.
    strikeHeld: input.strikeHeld && gameState.running && !gameState.paused,
    charging: strikeState.charging,
    // The dash window plus the raised-ceiling window it runs inside; either on
    // its own leaves a frame or two at the ends where the seal is visibly
    // still boosting and the camera has already let go.
    boosting: strikeState.active || player.dashTimer > 0,
    deathPhase: deathState.active ? deathState.phase : 'none',
    deathElapsed: deathState.elapsed,
  });

  // Impulse shake plus whatever is trembling continuously this frame (the
  // strike wind-up). Summed rather than max'd: a hit landing while you're
  // winding up should still register on top of the tremble.
  const shake = feedbackState.shake + feedbackState.sustainShake;
  if (shake > 0) {
    world.camera.position.x += (Math.random() - 0.5) * shake;
    world.camera.position.y += (Math.random() - 0.5) * shake;
  }

  // Chum is drawn from an instance buffer, and nothing in it is drawn until
  // the frame's transforms are copied across. Here rather than at the end of
  // updatePickups, and OUTSIDE the pause gate, because half a dozen systems can
  // still move an orb after that call returns — a crab chewing one, a shark
  // hoovering one, the gulp on a strike release — and a menu opening must not
  // leave the seabed frozen a frame behind where the orbs actually are.
  flushPickupInstances();

  updateParticleScale(world.camera, world.renderer);
  post.resize();

  setTunerMeta(
    `${Math.round(1 / Math.max(realDt, 0.0001))} fps · ${enemies.length} enemies · ${projectiles.length} shots · ${particleCount()} bits · ${flightVoiceCount()} voices`
  );
  post.render(world.scene, world.camera, realDt);
}
