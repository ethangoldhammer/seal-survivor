import * as THREE from 'three';
import { CONFIG, loadTuningFromStorage, saveTuningToStorage, xpForNextLevel } from './config.js';
import { preloadAssets, restoreUploadedModels, applySavedAssetLooks, assetBaseColor, setEmissiveMapsEnabled, applyNoiseSettings, applyToonSettings, applyGrassSettings, applyBiolumSkinSettings, applyBubbleShellSettings, clearVisualPool } from './assets.js';
import { updateGrassSway } from './systems/grassSway.js';
import { updateBiolumSkin, setBiolumSkinVariant } from './systems/biolumSkin.js';
import { updateEmissivePulse } from './systems/emissivePulse.js';
import { pulseDemoFor, panDemoFor, resolvedGlow, describeGlow } from './systems/glowDebug.js';
import { updateBeatSync } from './systems/beatSync.js';
import { reseatDecor } from './systems/decor.js';
import { createWorld } from './world.js';
import { midWater, bounds, seabedTopY } from './arena.js';
import {
  initInput, updateInput, clearPendingInput, inputDevice, inputTokens, input, menuInput,
} from './input.js';
import { player, initPlayer, resetPlayer, updatePlayer, updateAimRig, recomputeStats, addUpgrade, applyRecoil, applyPlayerKnockback, rebuildShipBody } from './entities/player.js';
import { projectileCount, maneaterReadout } from './stats.js';
import { xpAllowance, spillStep } from './xpSpill.js';
import { aoe, targeting, abilityDamage } from './systems/scaling.js';
import { updateElements, onEnemyKilled as onElementalHostKilled, resetElements, clearStatuses, commitElement, updateElementSkin, invalidateElementSkin, elementHitEvent, surgeElement, activeElement, elementColor } from './systems/elements.js';
import { consumeDazes, resetControl } from './systems/control.js';
import { updateCelestialPass, resetCelestialPass } from './systems/celestialPass.js';
import { enemies, updateSpawning, updateEnemies, animateEnemiesIdle, resetEnemies, removeEnemy, spawnNamed, nightlifeWeight, setStrikeThreat, applyKnockback } from './entities/enemies.js';
import { updateBoss, updateBossAbilities, resetBoss, bossBanner, bossState, capBossDamage } from './systems/boss.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from './entities/projectiles.js';
import { updatePickups, resetPickups, spawnXpOrb, spawnStrikeOrb, spawnBubbleOrb, spawnRapidFireOrb, spawnChumChunk, gulpPickups, setChumDifficulty, flushPickupInstances, nearestChum, nearestPickup, pickupTypeInWater, countFloorPickups, chumRadiusOf, pickupEntry, pickupEntryAlive, chumEntry, chumEntryAlive, nearestFloorPickup, pickups, chumChunks } from './entities/pickups.js';
import { updateChumChunkSpawner, resetChumChunkSpawner } from './systems/chumChunkSpawner.js';
import { initParticles, updateParticles, resetParticles, updateParticleScale, particleCount } from './entities/particles.js';
import { resolveCombat } from './systems/combat.js';
import { resolvePredation } from './systems/predation.js';
import { initFeedback, feedback, updateFeedback, feedbackState, addSustainedShake, bossVoice, setToastSink } from './systems/feedback.js';
import { initAudio, unlockAudio, prefetchSamples, applyAudioBusSettings, applyPlayerAudioSettings, updateBusDepth, resetRepetition, setSfxListener } from './systems/audio.js';
import { initHaptics, stopHaptics } from './systems/haptics.js';
import { createPost } from './systems/post.js';
import { loadNoteGlyphs } from './systems/noteStorm.js';
import { warmShaders, warmPipeline } from './systems/shaderWarmup.js';
import { installBossWarmup } from './systems/bossWarmup.js';
import { perfFrame, perfRunStart, perfRunReport, perfWindow, perfSummary } from './systems/perfLog.js';
import { showLoading } from './ui/loading.js';
import { createGarlicVisual, updateGarlic, resetGarlic } from './systems/garlic.js';
import { createShrimpRingVisual, updateShrimpRing, resetShrimpRing } from './systems/shrimpRing.js';
import { createClubVisual, updateClub, resetClub, fireClubThrow } from './systems/club.js';
import { fireMusselBarrage, updateMusselVolley, resetMusselVolley } from './systems/musselVolley.js';
import { strikeState, tryStrike, restoreCharge, addCharge, updateStrike, updateCharge, feedChum, resetStrike, comboSpeedMul, chainStrike, chainXpMul, liveChain, isFeeding, strikeDirection, riderDamage, claimDashHit, powerDamageMul, strikeBurst, consumeStrikeLink, consumeChainLink, isInvulnerable, perfectCrossed, strikeLoaded } from './systems/strike.js';
import { stateForSpeed } from './systems/animation.js';
import { emitPoint, emitPointCount } from './systems/aimRig.js';
import { updateBubbles, resetBubbles } from './systems/bubbles.js';
import { updateDayCycle, resetDayCycle, advanceClock, dayState, setNightLock, nightLockedAt } from './systems/daylight.js';
import { updateWeather, resetWeather } from './systems/weather.js';
import { lightningStrikes } from './systems/lightning.js';
import { updateOxygenFx, resetOxygenFx } from './systems/oxygenFx.js';
import { playerDamageFx, updatePlayerDamageFx, resetPlayerDamageFx } from './systems/playerDamageFx.js';
import { updateProjectileTrails, clearProjectileTrails } from './systems/projectileTrails.js';
import { updateAirborne, resetAirborne, airRamp, airDamageMul, airFireRateMul, canAirJump, spendAirJump, slamFor } from './systems/airborne.js';
import { updateBreachTrail, clearBreachTrail } from './systems/breachTrail.js';
import { updateKrakenInk } from './systems/kraken.js';
import { updateProjectileVoices, clearProjectileVoices, flightVoiceCount } from './systems/projectileVoices.js';
import { initImpactFlashes, updateImpactFlashes, clearImpactFlashes, spawnImpactFlash } from './systems/impactFlash.js';
import { initBossImpacts, updateBossImpacts, clearBossImpacts, spawnBossImpact } from './systems/bossImpact.js';
import { initBossGibs, updateBossGibs, resetBossGibs, spawnBossGibs } from './systems/bossGibs.js';
import { initGore, updateGore, resetGore } from './systems/gore.js';
import { tickHitShapes, initHitShapeDebug, updateHitShapeDebug } from './systems/hitShape.js';
import { createStrikeRing, updateStrikeRing, resetStrikeRing } from './systems/strikeRing.js';
import { updateChargeSkin, chargeCrossed, resetChargeSkin, invalidateChargeSkin } from './systems/chargeSkin.js';
import { initMarks, updateMarks, resetMarks, markTarget } from './systems/marks.js';
import { createAimIndicator, updateAimIndicator, resetAimIndicator } from './systems/aimIndicator.js';
import { play as playMusic, duckForUpgrade, sweepOpen, applyMusicSettings, applyPlayerMusicSettings, setLevel as setMusicLevel, preloadDefaultTracks, updateDepth as updateMusicDepth } from './systems/music.js';
import { startAmbient, stopAmbient, preloadAmbient } from './systems/ambient.js';
import { computeKillPoints, comboMultiplierFor } from './systems/scoring.js';
import { updateCrabSpawner, resetCrabSpawner, summonDeathPile, updateDeathPile } from './systems/crabSpawner.js';
import { spawnSeagull, updateSeagulls, resetSeagulls } from './systems/seagull.js';
import { spawnWhale, updateWhales, resetWhales, resetWhaleClock, updateWhaleClock, whaleDistance, nearestWhale, whaleAlive } from './systems/whale.js';
import { updateBoats, resetBoats, boats, attractorOrbs, hitsBoat, damageBoat, jostleBoat, impactBoat } from './systems/boats.js';
import { setWakeGrid } from './systems/boatWake.js';
import { stepBodies } from './systems/rigidBody.js';
import { damageDebris } from './systems/boatDebris.js';
import { damageCrew, nearestFloatingCrew, eatCrew } from './systems/crew.js';
import { updateEel, resetEel, resetEelBolts, currentEelStats, createEelCompanion, resetEelCompanion, rebuildEelCompanion, spawnArcBolt } from './systems/eel.js';
import { createBelugaDrone, updateBeluga, resetBeluga, rebuildBelugaDrone } from './systems/beluga.js';
import { updateSealTeam, resetSealTeam, rebuildSealTeam } from './systems/sealTeam.js';
import { createBakalarBoat, updateBakalar, resetBakalar, rebuildBakalarBoat } from './systems/bakalar.js';
import { updateCalamari, resetCalamari } from './systems/calamari.js';
import { createDumboOcto, updateDumbo, resetDumbo, rebuildDumboOcto } from './systems/dumbo.js';
import { createHarpVisual, updateHarp, resetHarp, rebuildHarp } from './systems/harp.js';
import { firePearl, burstPearl, updateOyster, resetOyster } from './systems/oyster.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab, rebuildOctoGrabber } from './systems/octoGrab.js';
import { updateOrcaPod, resetOrcaPod, rebuildOrcaPod } from './systems/orca.js';
import { applyPlayerOutline, updatePlayerOutline, flarePlayerOutline, resetPlayerOutlineCharge, initCreatureOutlines, applyCreatureOutlines, applyCompanionOutlines } from './systems/outlines.js';
import { deathState, startDeathDive, updateDeathDive, resetDeathDive, beginRestartTransition } from './systems/deathDive.js';
import { levelUpState, startLevelUpTime, updateLevelUpTime, endLevelUpTime, resetLevelUpTime, cardsArriveAt, saluteEnabled } from './systems/levelUpTime.js';
import { bossKillState, updateBossKill, resetBossKill, bossKillShotDue, setBossKillFraming } from './systems/bossKill.js';
import { holdBossCorpse, updateBossCorpses, resetBossCorpses, bossCorpseFocus } from './systems/bossCorpse.js';
import { fireBossBoom, updateBossBooms, resetBossBooms } from './systems/bossBoom.js';
import { showSnapshotPrint, resetSnapshotPrints } from './ui/snapshotPrint.js';
import { updateBeams, resetBeams } from './systems/beams.js';
import { updateLaserEyes, setLaserAim, resetLaserEyes } from './systems/laserEyes.js';
import { createEyeLights, updateEyeLights, resetEyeLights, applyEyeLightColours, flareEyeLights } from './systems/eyeLights.js';
import { updateBossEyes, resetBossEyes } from './systems/bossEyes.js';
import { updateCelebration, playCelebration } from './systems/celebrate.js';
import { captureBossShot, resetBossShot, bossShot } from './systems/bossShot.js';
import { cineEvent, cineBreach, resetCineCamera } from './systems/cineCamera.js';
import { beginTitleSeal, endTitleSeal, resetTitleSeal, titleSealEngaged, updateTitleSeal } from './systems/titleSeal.js';
// The screen between the name card and the run — see systems/mainMenu.js. It
// is mounted from here rather than from ui.js because it lives IN THE ARENA:
// it poses the run's own seal and claims the run's own camera, neither of which
// the UI layer has ever known about.
import { mountMainMenu, mainMenu, mainMenuActive, mainMenuAim, mainMenuEngaged } from './systems/mainMenu.js';
import { updateStage, parkStageCamera, holdStageSafe, isStaging, stageSimulates, resetStage, sandboxRequested } from './systems/stage.js';
import { initStagePanel, setStagePanelVisible } from './ui/stage.js';
import { initWorkbench, updateWorkbench } from './ui/workbench.js';
import { highScore } from './systems/leaderboard.js';
import { initUI, showStartMenu, showHowToPlay, hideHowToPlay, showLeaderboard, hideLeaderboard, hideAllMenus, showLevelUp, showGameOver, updateHUD, updateBossBar, setHighScore, spawnScoreToast, spawnChainToast, spawnProcToast, updateToasts, clearToasts, updateMenuNav, hidePlayerBars, showHud, showRestartTransition, hideRestartTransition, uiRoot } from './ui/ui.js';
import { setHiveUpgrades, setHiveLayout, setHiveStyle, setHiveStack, toggleHive } from './ui/upgradeHive.js';
import { updateCallouts, resetCallouts, checkCallouts, clearCallout, CALLOUTS } from './systems/callouts.js';
import { updateTutorial, resetTutorialRun, noteTutorialEvent, COACH_IDS, tutorialState } from './systems/tutorial.js';
import { setTelegraph, updateTelegraph, clearTelegraph } from './systems/telegraph.js';
import { initCallouts, updateCalloutUi, clearCalloutUi } from './ui/callout.js';
import { initChainDebug, updateChainDebug, toggleChainDebug, dumpChainTrace } from './ui/chainDebug.js';
import { hidePauseMenu, isPauseOpen, showPauseMenu, updatePauseNav } from './ui/pauseMenu.js';
import { actionForKey, onSettingsChanged, shakeScale } from './systems/settings.js';
import { isTextEntry, isTypingTarget } from './ui/typing.js';
import { initTuner, refreshTuner, setTunerMeta } from './ui/tuner.js';
import { initTexturePanel } from './ui/textures.js';
import { initTypography, applyTypography } from './ui/typography.js';
import { initTextPanel, refreshTextSpecimen } from './ui/textPanel.js';
import { initGamepadDebug, updateGamepadDebug } from './ui/gamepadDebug.js';
import { initSfxDebug, updateSfxDebug } from './ui/sfxDebug.js';
import { initUpgradeDebug } from './ui/upgradeDebug.js';
import { initAnimDebug } from './ui/animDebug.js';
import * as playtest from './systems/playtest.js';
import { causesOfDeath } from './deathCauses.js';
// The caption on the kill-shot polaroid. `playerName` and not the raw stored
// value — see the note where it is used.
import { playerName } from './systems/playerName.js';
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
initBossImpacts(world.scene);
initBossGibs(world.scene);
// The shape pool itself is built lazily on the first meal, not here: the bone
// models it draws from may still be loading, and one of them may be an upload
// that has not happened yet. See ensurePool in systems/gore.js.
initGore(world.scene);
initHitShapeDebug(world.scene);
initMarks(world.scene);
initFeedback(world.grid);
// WHERE A `toast` CHANNEL LANDS. feedback() describes the line — its label, its
// value, where in the world it happened — and knows nothing about the screen;
// this is the one place that turns it into a node. Wired here rather than
// imported inside systems/feedback.js so that module stays DOM-free and every
// Node harness that fires an event keeps working (the channel is simply inert
// with no sink, which is the right behaviour headless).
setToastSink((t) => spawnProcToast(world.camera, t));
// The hulls warp the same lattice the seal does — see the note in
// systems/boatWake.js for why the grid is handed over rather than threaded
// through systems/boats.js and systems/bossBoat.js.
setWakeGrid(world.grid);
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
let clubGroup = null;
let belugaDrone = null;
let eelCompanionMesh = null;
let strikeRing = null;
let aimIndicator = null;
let eyeLights = null;
let dumboOcto = null;
let harpGroup = null;
let octoGrabber = null;
// Reused by the daze drain below, so the one-entry-a-fight announcement costs
// no allocation on the frames it fires and none at all on the ones it doesn't.
const dazedThisFrame = [];

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
// XP HELD BACK from a single oversized mouthful, and the seconds left to pay it
// in over. See CONFIG.xp.spill and updateXpSpill.
let xpSpill = 0;
let xpSpillLeft = 0;
let shootCooldown = 0;
let missileCooldown = 0;
let scallopCooldown = 0;
let oysterCooldown = 0;
let bounceCooldown = 0;
let rapidFireTimer = 0; // seconds remaining on an active rapid-fire pickup
let chargeHapticTimer = 0; // counts down between wind-up rumble pulses
let bubbleSpawnTimer = 0;
let rapidFireSpawnTimer = 0;
// Chum chunks keep their clocks in systems/chumChunkSpawner.js rather than in
// three loose timers here — see the note at the top of that file for why the
// ambient timer, the boss budget and the pity chunk have to be readable in one
// place.
let starfishCooldown = 0;
let seagullCooldown = 0;
// Rate limit on the crumb trail coming off chum being hoovered by a whale. One
// counter for the whole sweep rather than one per orb: the emitter is tiny by
// design and the point is a trickle, so a whole chum pile streaming in should
// still shed crumbs at the rate one orb would.
let whaleCrumbTimer = 0;
let simClock = 0; // free-running clock for the beluga drone's orbit
let muzzleCursor = 0; // which flipper the next ALTERNATING volley starts from (missiles)
const muzzlePoint = new THREE.Vector3(); // scratch — spawnProjectile copies it immediately
const impulseDir = new THREE.Vector3(); // scratch — hit direction handed to the bone spring
const faceDir = { x: 0, y: 1 }; // scratch — the seal's facing, read by the bubble vent
// Scratch for the per-frame "where would a strike go" prediction the lens
// corridor is drawn along. Read and copied inside updateCamera on the same
// frame it's written, so one object is enough.
const dashPrediction = { x: 0, y: 0 };

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

// How many shader programs three has EVER built, not how many it is holding.
//
// `renderer.info.programs.length` is the live set, and it misses the case that
// matters most: a recompile releases the old program and creates a new one, so
// the length is unchanged and the delta reads zero. A run that rebuilds the
// same shader two hundred times would report "no compiles" — which is exactly
// the kind of silence that sent the last two investigations down the wrong
// road. Program ids are handed out from a counter that only ever goes up, so
// the highest one in the live set is the true total.
function programsEverBuilt() {
  const programs = world.renderer.info.programs;
  if (!programs?.length) return 0;
  let max = 0;
  for (const p of programs) if (p.id > max) max = p.id;
  return max + 1;
}

// Chrome only, and absent everywhere else — which is fine, because it is a
// diagnostic and the code that reads it treats 0 as "don't know". A collection
// is the one thing that makes this number go DOWN, so a stall on a frame where
// the heap dropped is the collector, and a stall where it didn't is real work.
// That is the distinction the "neither" bucket has been hiding.
function heapUsed() {
  return performance.memory?.usedJSHeapSize ?? 0;
}

boot();

async function boot() {
  const loading = showLoading();
  // Assets are the first two thirds of the bar and the shader warm-up is the
  // last third. Not a measurement — the split is a judgement about which half
  // feels longer, and the warm-up's own share is smoothed inside that third.
  const ASSET_SHARE = 0.66;
  await preloadAssets((p) => loading.setProgress(p * ASSET_SHARE));
  // The harp's note glyphs. NOT an ASSETS entry, so preloadAssets never sees
  // them: systems/noteStorm.js wants the raw geometries to instance, and the
  // asset pipeline's job is to hand back a built Mesh with a material shared
  // across every copy — which is the one thing per-note colour cannot have.
  // Awaited rather than fired and forgotten so the first charm of a run has
  // notes; failing is not fatal, the field simply draws nothing.
  await loadNoteGlyphs().catch((e) => console.warn('[notes] glyphs failed to load', e));
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
  applyToonSettings();
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
  // The clubs live in a world-space group rather than being parented to the
  // fin bones. The aim rig already publishes those tips in world space every
  // frame (systems/aimRig.js), and hanging a mesh off a skinned bone would
  // inherit the bone's own scale along with its transform.
  clubGroup = createClubVisual();
  world.scene.add(clubGroup);
  belugaDrone = createBelugaDrone();
  world.scene.add(belugaDrone);
  eelCompanionMesh = createEelCompanion();
  world.scene.add(eelCompanionMesh);
  strikeRing = createStrikeRing();
  world.scene.add(strikeRing);
  aimIndicator = createAimIndicator();
  world.scene.add(aimIndicator);
  // The seal's lit eyes. World space rather than parented to the eye bones,
  // for the reason the clubs above are: a mesh hung off a skinned bone
  // inherits that bone's scale. The aim rig publishes both sockets in world
  // space every frame anyway — see systems/eyeLights.js.
  eyeLights = createEyeLights();
  world.scene.add(eyeLights);
  dumboOcto = createDumboOcto();
  world.scene.add(dumboOcto);
  // One group for the harp AND the note rings its charms leave on other
  // bodies. The rings are drawn in world space, so the group stays at the
  // origin — see systems/harp.js.
  harpGroup = createHarpVisual();
  world.scene.add(harpGroup);
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
  try {
    await warmShaders(
      post, world.scene, world.camera,
      (p) => loading.setProgress(ASSET_SHARE + p * (1 - ASSET_SHARE)),
    );
    warmPipeline(post, world.scene, world.camera);
  } catch (err) {
    console.warn('[boot] shader warm-up skipped —', err?.message ?? err);
  }
  // The SECOND warm-up, and it runs mid-game rather than here: the boot pass
  // above cannot cover a boss arrival, because the part of an arrival that
  // costs the most is the texture upload the pass above deliberately refuses
  // to do for the whole roster (see the note in shaderWarmup.js). This hands
  // systems/bossWarmup.js the same three things post.warm needs, so it can pay
  // for ONE boss during the three-second hush in front of it instead.
  //
  // Outside the try above on purpose: this only stores three references and
  // cannot fail, and a warm-up that was skipped because compileAsync threw is
  // exactly the run that most wants the boss one working.
  installBossWarmup({ post, scene: world.scene, camera: world.camera });
  loading.setProgress(1);
  loading.remove();

  // The sample bank starts downloading HERE — not on the gesture that starts
  // the run, which is where it used to start and which is why a strike in the
  // first second of a deployed run came out as its synth. Fetching needs no
  // AudioContext and so needs no gesture; only decoding does. Started after
  // the loading screen rather than alongside it so it isn't competing with the
  // models for the bar the player is actually watching, and fired and
  // forgotten because the splash and the menu are all the head start it needs.
  prefetchSamples();

  initUI({
    // The Rive card is going up. The seal is framed BEFORE it, so the push-in
    // is already under way while the artboard parses — see systems/titleSeal.js.
    onSplash: beginTitleSeal,
    // ...and where the card lets out. The name screen hands over to the 3D menu
    // now rather than straight into a run — see leaveSplash in ui/ui.js.
    onMenu: showMainMenu,
    onStart: startGame,
    onRestart: restartRun,
    onLevelChoice: applyLevelChoice,
    onResume: () => setPaused(false),
    // Restarting from the pause menu goes straight into a new run rather than
    // through the death transition restartRun uses: nothing is dilated,
    // filtered or pushed in here — there is nothing to glide back FROM, and a
    // second of black over a game that was merely paused is a second of
    // nothing.
    onPauseRestart: () => {
      setPaused(false);
      startGame();
    },
  });
  // After initUI, which is what builds the root it appends to — and appended
  // last so the band sits over the menus (see ui/callout.js).
  initCallouts(uiRoot());
  // The food chain's diagnostic. Always built, never shown until C — the
  // mechanic it describes is four conditions across three files and a tenth of
  // a second, and every one of its failures looks identical from the seat.
  if (DEV_UI) initChainDebug(uiRoot());
  // The join between callouts.csv and the code that fires each row, checked
  // once, out loud. A mis-typed id is otherwise a callout that simply never
  // happens, which is indistinguishable from one whose condition never came up.
  checkCallouts(COACH_IDS);
  bindPauseKey();
  bindFullscreenKey();
  onSettingsChanged(handleSettingsChange);
  initTypography();
  if (DEV_UI) initTuner(handleTunerChange);
  // The Text panel (Y) — the third tuning surface, alongside ` and T. Same
  // change handler as the tuner: a text row is an ordinary schema row, and the
  // routing below turns any textStyles/textMotion path into a restyle.
  if (DEV_UI) initTextPanel(handleTunerChange);
  if (DEV_UI) initTexturePanel((key) => {
    // Recycled creature bodies were built from the asset as it WAS. A model
    // upload or a look change rebuilds the template, and a pooled body handed
    // out afterwards would come back wearing the old one — so the pool is
    // emptied and the next spawn of every species clones fresh.
    clearVisualPool();
    // Some ability meshes are singletons created once at boot, not
    // repeatedly cloned like an enemy — a size change needs an explicit
    // rebuild to actually show up, rather than only affecting future spawns.
    if (key === 'ship') rebuildShipBody();
    else if (key === 'belugaDrone') rebuildBelugaDrone(world.scene);
    else if (key === 'sealTeam') rebuildSealTeam(world.scene);
    else if (key === 'eelCompanion') rebuildEelCompanion(world.scene);
    else if (key === 'shrimp') resetShrimpRing();
    else if (key === 'club') resetClub();
    else if (key === 'dumboOcto') rebuildDumboOcto(world.scene);
    // Both of the harp's keys go through the same rebuild: the note pool is
    // clones of `musicNote`, so re-uploading either one has to empty it.
    else if (key === 'harp' || key === 'musicNote') rebuildHarp();
    else if (key === 'bakalarBoat') rebuildBakalarBoat(world.scene);
    else if (key === 'octoGrabber') rebuildOctoGrabber(world.scene);
    // Any of the three pod bodies — the family is three different animals
    // now (see systems/orca.js), and a swap on any one of them rebuilds the pod.
    else if (key.startsWith('orcaFriend')) rebuildOrcaPod(world.scene);
  }, handleTunerChange);
  if (DEV_UI) bindGlobalKeys();
  if (DEV_UI) initGamepadDebug();
  if (DEV_UI) initSfxDebug();
  // Same shape as the sound feed above: dev-only, keyed, and handed a getter
  // rather than the world, because the world does not exist yet at this point
  // in boot.
  if (DEV_UI) initStagePanel(() => world.scene);
  // AFTER the stage panel: the workbench subscribes to the stage's open/close
  // so one key drives both, and the subscription has to exist before anything
  // can open it.
  if (DEV_UI) initWorkbench();
  // The run clock is handed over rather than imported: `gameState` is a local
  // in here, and the panel only wants it to timestamp the playtest record.
  // The second getter is for the panel's boss spawner — it needs somewhere to
  // put the creature and the run's level to spawn it against. Same reasoning as
  // the clock: both are locals here, and handing over accessors keeps the panel
  // from importing the game loop's state.
  if (DEV_UI) initUpgradeDebug(() => gameState.time, () => ({ scene: world.scene, gameState }));
  if (DEV_UI) initPlaytestOverlay();
  // Reads the animation state machine out; poses nothing. See ui/animDebug.js.
  if (DEV_UI) initAnimDebug();
  setHighScore(highScore());

  // `?sandbox` boots past the splash straight into a staged run — an ocean
  // with a seal in it and nothing trying to end you. This is the route back
  // after a reload: the stage bar writes the param while it is open, so
  // reloading to pick up someone else's code change returns you to the setup
  // you were reloading in order to keep, instead of to a fresh run.
  //
  // ONE THING IS WORSE THIS WAY, and it is not fixable from here: startGame
  // normally runs inside the call stack of the gesture that dismissed the
  // splash, and an AudioContext built outside a real user gesture comes up
  // suspended. There is no gesture on this path, so a sandbox starts SILENT
  // until your first click or keypress, which unlockAudio is already wired to.
  // Worth knowing before concluding that a sound is broken.
  if (DEV_UI && sandboxRequested()) {
    showHud();
    startGame();
    setStagePanelVisible(true);
  } else {
    showStartMenu();
  }
  world.renderer.setAnimationLoop(animate);
}


// --- pausing -----------------------------------------------------------------
// The pause menu reuses `gameState.paused`, which the level-up screen already
// owns: it is the flag the whole frame loop is written around, and a second
// one would mean auditing every `!gameState.paused` in this file to decide
// which of the two it meant.
//
// What it does NOT reuse is the level-up screen's time dilation. That is a
// held beat inside a run — the world slows and the animals keep breathing.
// This is the player leaving the room. The fight stops where it stands; the
// water, the sky and the weather carry on, because those run on the wall clock
// by design and freezing them would stop the sun as well.

/** True when the run can be interrupted right now. */
function canPause() {
  // Not during the level-up screen: that is already a menu, already paused,
  // and putting a second one over it would leave two things wanting the same
  // confirm button. Not during the death dive either — the run is over, the
  // clock belongs to the dive, and there is nothing left to pause.
  return gameState.running && !levelUpState.active && !deathState.active;
}

function setPaused(paused) {
  if (paused === isPauseOpen()) return;
  if (paused) {
    if (!canPause()) return;
    gameState.paused = true;
    showPauseMenu();
    return;
  }
  hidePauseMenu();
  gameState.paused = false;
  // The keypress or click that closed the menu is still physically down, and
  // every strike route reads a RELEASE as "launch". Without this, resuming
  // with the space bar spends a full charge on the first frame back — the
  // same reason startGame calls it.
  clearPendingInput();
}

function togglePause() {
  setPaused(!isPauseOpen());
}

// Shift+F: fullscreen. Not behind DEV_UI — this is a player feature, and it is
// the only fullscreen the game has. The browser's own F11 / Ctrl+Cmd+F still
// works alongside it; this exists because plain `f` is already the dev stage
// panel (ui/stage.js) and because the request has to come from a real key
// event, which is why it lives in a handler rather than a menu-only button.
//
// documentElement, NOT the renderer's container: the HUD, the pause menu and
// the callout band are all appended to document.body (see ui/ui.js), so
// fullscreening #root alone would show the canvas with every overlay clipped
// away. world.js already listens for `resize`, which fires on the way in and
// out, so the camera and the drawing buffer need nothing from here.
function toggleFullscreen() {
  const el = document.documentElement;
  // Safari is still prefix-only for all three of these, and the element getter
  // is the one that decides which branch we take — a missed prefix there reads
  // as "not fullscreen" and every press would re-request instead of exiting.
  const current = document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  if (current) {
    (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
    return;
  }
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  // Rejects when the gesture isn't trusted or the embed disallows it. Nothing
  // to recover — the run carries on windowed — but swallowing it silently would
  // make an iframe that blocks fullscreen look like a dead key.
  request?.call(el)?.catch?.((err) => console.warn('[fullscreen]', err?.message ?? err));
}

function bindFullscreenKey() {
  window.addEventListener('keydown', (e) => {
    if (!e.shiftKey || e.repeat || e.key.toLowerCase() !== 'f') return;
    // isTextEntry rather than isTypingTarget, for the same reason as the pause
    // key above: a focused slider must not swallow this. See ui/typing.js.
    if (isTextEntry(e.target)) return;
    e.preventDefault();
    toggleFullscreen();
  });
}

// Escape, plus whatever the Controls tab has `pause` bound to. Not behind
// DEV_UI, unlike bindGlobalKeys below — this is the only way off the menu for
// a keyboard player.
function bindPauseKey() {
  window.addEventListener('keydown', (e) => {
    // isTextEntry rather than isTypingTarget: the pause menu's own sliders are
    // range inputs and the cursor focuses them, so the broader test would go
    // true the moment the player selected a volume row — and Escape, the way
    // out of the menu, would stop working exactly there. See ui/typing.js.
    if (e.repeat || isTextEntry(e.target)) return;
    // Escape is accepted whatever the binding says. A player who has bound
    // `pause` to some key they then forget still has a way out, and it is the
    // key every browser user already tries.
    const key = e.key.toLowerCase();
    if (key !== 'escape' && actionForKey(key) !== 'pause') return;
    e.preventDefault();
    togglePause();
  });
}

// A player setting changed. Most of them are read live at the point of use and
// need nothing here; these three are stamped onto something that persists.
function handleSettingsChange(path) {
  const all = path === '*';
  // A gain node holds the last value written to it, so a volume slider that
  // did not re-stamp it would not be heard until the next unrelated bus edit.
  //
  // BOTH buses, every time. The music chain runs to ctx.destination on its own
  // gain — it is not downstream of the SFX master — so master volume and mute
  // have to be stamped onto it separately or the score plays straight through
  // a mute at full authored volume.
  if (all || path.startsWith('audio.')) {
    applyPlayerAudioSettings();
    applyPlayerMusicSettings();
  }
  // Reallocates the drawing buffer, and post.js picks the new size up on its
  // next resize() — same path the tuner's render-scale slider takes.
  if (all || path === 'video.resolution') world.applyRenderScale();
  // The filter and the bloom toggle are resolved inside post.render every
  // frame, and the shake scale is read at the point the camera is offset, so
  // neither needs anything here.
  if (DEV_UI && (all || path.startsWith('video.'))) refreshTuner();
}

function bindGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'p' && !isTypingTarget(e.target)) {
      post.cyclePreset();
      refreshTuner();
    }
    // C / Shift+C: the FOOD CHAIN readout, and a dump of its log.
    //
    // A key rather than a tuner panel for the same reason the hive cycle is
    // one: the question is "why did THAT strike not chain", and it is only
    // answerable while the water is moving. Anything you have to pause to read
    // is a description of a frame, and the thing being diagnosed is a tenth of
    // a second inside a fight.
    if (e.key.toLowerCase() === 'c' && !isTypingTarget(e.target) && !e.repeat) {
      if (e.shiftKey) dumpChainTrace();
      else toggleChainDebug();
    }
    // H / Shift+H / Alt+H / Ctrl+H: the upgrade hive — on, layout, style, stacks.
    //
    // Three keys rather than a tuner panel because the whole point is to judge
    // it WHILE the water is moving: the question "does the cluster read better
    // than the rows" is answered in a fight with nine tiles firing, and any
    // answer arrived at with the game paused behind a menu is an answer about a
    // still image. Cycling writes CONFIG, so a layout settled on can then be
    // saved with the rest of the tuning like anything else.
    if (e.key.toLowerCase() === 'h' && !isTypingTarget(e.target) && !e.repeat) {
      const hive = CONFIG.upgradeHive;
      if (e.shiftKey) {
        const modes = ['cluster', 'rows', 'arc'];
        const next = modes[(modes.indexOf(hive.layout) + 1) % modes.length];
        setHiveLayout(next);
        console.log(`[hive] layout ${next}`);
      } else if (e.altKey) {
        const styles = ['ink', 'rarity', 'art'];
        const next = styles[(styles.indexOf(hive.style) + 1) % styles.length];
        setHiveStyle(next);
        console.log(`[hive] style ${next}`);
      } else if (e.ctrlKey || e.metaKey) {
        // How a stack of the same card is drawn. Judged in a fight for the same
        // reason the layout is: a pile that reads on an isolated tile can turn
        // a packed corner to mush, and only a real build shows that.
        const modes = ['pip', 'slab', 'deck', 'riser'];
        const cur = hive.stack?.mode ?? 'slab';
        const next = modes[(modes.indexOf(cur) + 1) % modes.length];
        setHiveStack(next);
        console.log(`[hive] stacks ${next}`);
      } else {
        console.log(`[hive] ${toggleHive() ? 'on' : 'off'}`);
      }
    }
    // Shift+L: deal a level-up NOW, without earning one.
    //
    // The cards announce themselves in a sequence that takes well under a
    // second and is different for every hand (see CONFIG.rarityCard.ignite),
    // and the only way to see it was to play up to a level and hope the roll
    // gave you something above the floor tier. This deals a fresh hand on
    // demand so the arrival can be watched — and re-watched — while its
    // numbers are being tuned.
    //
    // A REAL deal, not a preview: the tiers are rolled the way they would be
    // at this level and picking one grants it, the same as the upgrade debug
    // panel's grant buttons. Dev only, so nothing here reaches a player.
    if (DEV_UI && e.shiftKey && e.key.toLowerCase() === 'l'
        && !isTypingTarget(e.target) && !e.repeat) {
      showLevelUp();
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
      // Alt is tested before the bare Shift so Alt+Shift+N reaches the pan
      // demo instead of toggling the night lock on the way past.
      if (e.altKey) {
        // Both demos drop `strength` per instance, which is the half that
        // matters: at the shipped brightness the pattern's top three quarters
        // are one flat white shape, so neither the breath nor the pan has
        // anything to show. What they differ in is honesty about RATE.
        //
        //   Alt+N        brightness only. The breath and the drift you see are
        //                the real ones, at their real speeds.
        //   Alt+Shift+N  drift exaggerated ~8x, brightness held still. Answers
        //                "is the pan wired up on this creature" in a few
        //                seconds rather than the minute the real rate takes.
        spawnGlowLineup(e.shiftKey ? { forcePan: true } : { forcePulse: true });
      } else if (e.shiftKey && import.meta.env?.DEV) {
        // The DEV test is INSIDE the branch, not around the whole handler, and
        // it is what makes the night lock leave nothing behind: it is a
        // compile-time constant, so the production build folds this to `false`,
        // drops the call, and then tree-shakes setNightLock out of the bundle
        // entirely. DEV_UI is not a substitute — it is true in production under
        // `?tune`, which is exactly the door this must not be behind.
        console.log(`[daylight] ${setNightLock(nightLockedAt() == null)}`);
      } else if (!e.shiftKey) {
        spawnGlowLineup();
      }
    }
  });
}

// The lineup itself. Spread along a row in front of the seal at its own depth,
// far enough apart that two bodies don't overlap at the widest of them.
function spawnGlowLineup({ forcePulse = false, forcePan = false } = {}) {
  const keys = Object.keys(CONFIG.enemies).filter((k) => CONFIG.enemies[k].bioluminescent);
  if (!keys.length) {
    console.warn('[nightlife] nothing is tagged `bioluminescent` in enemies.csv — nothing to line up.');
    return;
  }
  const origin = player.mesh.position;
  const spacing = 4;
  const report = [];
  keys.forEach((key, i) => {
    const at = { x: origin.x + (i - (keys.length - 1) / 2) * spacing, y: origin.y + 3 };
    const e = spawnNamed(world.scene, key, gameState.difficulty, at, { ignoreCaps: true });
    // `entering` suppresses the side walls for a creature walking on from off
    // screen; one placed deliberately inside the arena has already arrived.
    if (e) e.entering = false;
    if (!e) return;
    // Sized against THIS creature's resolved palette and `glow`, not a shared
    // constant — see strengthForCeiling. resolvedGlow reads the material, so
    // this has to come after the body exists.
    const live = resolvedGlow(e.mesh);
    if (forcePan) setBiolumSkinVariant(e.mesh, panDemoFor(live));
    else if (forcePulse) setBiolumSkinVariant(e.mesh, pulseDemoFor(live));
    // Described AFTER the stamp, so the readout is of what is actually on
    // screen. Printing the shipped numbers next to a forced body would make
    // the demo look like proof of the shipped settings, which is the one
    // wrong conclusion available here.
    report.push(`  ${key}:\n${describeGlow(e.mesh)}`);
  });
  const banner = forcePan
    ? 'FORCED PAN — drift is exaggerated ~8x, so this shows THAT it pans, not how fast. '
    : (forcePulse ? 'FORCED PULSE — brightness dropped so the real breath is visible; rates unchanged. ' : '');
  console.log(`[nightlife] ${banner}what is driving each one:\n${report.join('\n')}`);
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
  // Render scale, on its own line rather than folded into the arena branch
  // above: this changes the size of the drawing buffer and NOTHING about the
  // world. A full world.resize() here would rebuild the backdrop, the grid,
  // the constellations and the shore on every step of the slider, which is
  // both wasteful and misleading — the frame rate you are sweeping for would
  // be measured against a rebuild that never happens in a real run.
  if (path === '*' || path.startsWith('render')) world.applyRenderScale();
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
  if (path === '*' || path.startsWith('toonShade')) applyToonSettings();
  if (path === '*' || path.startsWith('grass')) applyGrassSettings();
  // Same again for the trap bubble's film. Its material is built on the first
  // spawn and cached forever after, so this is the only thing that moves those
  // uniforms once one has been in the water.
  if (path === '*' || path.startsWith('bubbleShell')) applyBubbleShellSettings();
  // Including the pattern dropdown — the pattern is a uniform, not a compile
  // switch, so switching it repaints every fish already swimming.
  if (path === '*' || path.startsWith('biolumSkin')) applyBiolumSkinSettings();
  // The seal's own glow is stamped only when the element, the level or the sky
  // moves — none of which a slider does. Without this the Glow Up! sliders read
  // as dead until the next sunset.
  if (path === '*' || path.startsWith('biolum.skin')) invalidateElementSkin();
  // Same for the meter's own layer: it restamps on a BUCKETED fuel level, so a
  // slider moved while the bar is parked would otherwise do nothing visible
  // until the next mouthful.
  if (path === '*' || path.startsWith('sealCharge')) invalidateChargeSkin();
  // The eye orbs bake their colour through hdr() into two materials at build
  // time (peak-channel push, so cyan actually crosses the bright pass), so a
  // colour slider reads as dead until this re-stamps it. Sizes and opacities
  // are read every frame and need nothing.
  if (path === '*' || path.startsWith('eyeLights')) applyEyeLightColours();
  // Also a pure material/uniform write on shells that already exist, so every
  // input event can drive it — no rebuild, and the toggle just hides them.
  if (path === '*' || path.startsWith('playerOutline')) applyPlayerOutline();
  // Same — one shared material per species, so a toggle or a colour reaches
  // every creature already swimming without touching the scene graph.
  if (path === '*' || path.startsWith('creatureOutline')) applyCreatureOutlines();
  // The allies' rim, same deal on its own config block.
  if (path === '*' || path.startsWith('companionOutline')) applyCompanionOutlines();
  // Type. One call rebuilds the whole role stylesheet, so all three prefixes
  // land in the same place — a role's colour and the global ink are the same
  // rule in the end. textMotion is in the list because a Reset ('*') has to
  // repaint the panel's specimen even though motion writes no CSS.
  if (path === '*' || path.startsWith('typography') || path.startsWith('textStyles')
      || path.startsWith('textMotion')) {
    applyTypography();
    // A row moved in the Text panel repaints that panel's specimen on its own.
    // What it can't see is a change made BEHIND it — Reset, or an imported
    // file — which arrives here as '*' and has already repainted every row via
    // refreshTuner, leaving only the specimen out of date.
    if (DEV_UI && path === '*') refreshTextSpecimen();
  }
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
// ---------------------------------------------------------------------------
// THE MAIN MENU — the screen between the name card and the run.
//
// Mounted here rather than in ui.js because it is not a screen in front of the
// game, it is a shot OF it: the seal it poses is the run's seal, standing where
// the run will start it, and the framing is a claim on the run's own camera.
// ui.js only says WHEN — it calls `onMenu` when the Rive card is dismissed, and
// it never shows that card twice, so this is where every later route back would
// land.
//
// Nothing about the frame loop changes while it is up. The world ticks, the
// water moves, the light runs; the menu adds a pose, a claim and a row of
// buttons on top, and Play eases all three to nothing over the first second of
// the run. See systems/mainMenu.js.
function showMainMenu() {
  if (mainMenuActive()) return;
  // WHERE THE RUN WILL START IT, before anything is measured against it. The
  // menu composes its crop on where the animal stands, and startGame calls
  // this again on the way into the run — so the two agree and the glide has
  // nothing to correct for. Without it the seal sits whereever initPlayer left
  // it and the camera would slide sideways the moment Play was pressed.
  resetPlayer();
  // The title card's own push-in is over: this screen makes its own claim, and
  // two shots claiming the camera is the last writer winning at random. Dropped
  // rather than released, because the splash is still dissolving over the top
  // of it and there is nothing to glide back to.
  resetTitleSeal();
  mountMainMenu({
    world,
    seal: player,
    root: uiRoot(),
    // WHAT THE BUTTONS DO lives here; how they feel lives in the menu. Three,
    // because three is what the row was composed and tuned for
    // (CONFIG.splashBust.menu) and a fourth would re-cut the frame.
    items: [
      {
        label: 'Play',
        // The run starts NOW and the menu gets out of the way over the next
        // second — see the release. Both, in this order: startGame clears the
        // pending input edges, so the click that pressed this button cannot
        // also spend a strike on frame one.
        onPress: () => {
          showHud();
          startGame();
        },
      },
      // The old DOM start menu, which holds every instruction the game has and
      // which nothing has been able to reach since the splash started going
      // straight into a run. Its own "Start run" still works — startGame
      // releases this menu on every route into a run, not just the button above.
      { label: 'How to play', onPress: showHowToPlay },
      // The board on its own surface, rather than only as a panel inside the
      // score card — until now the only way to look at it was to die. See
      // showLeaderboard.
      { label: 'Leaderboard', onPress: showLeaderboard },
    ],
  });
}

/**
 * Hand the frame back to the run. Called from startGame, so it covers every
 * route in — the Play button, the start panel's own button, a restart,
 * `?sandbox` — rather than only the one that was thought of.
 *
 * A RELEASE, not a teardown: the menu keeps running over the opening second of
 * the run, easing its camera claim and the seal's pose out. The DOM panels it
 * may have opened go immediately, because those are the only parts of it that
 * would be sitting in front of a live game.
 */
function closeMainMenu() {
  if (!mainMenuActive()) return;
  hideHowToPlay();
  hideLeaderboard();
  hidePauseMenu();
  mainMenu()?.release();
}

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
  // The menu is gone, and with it the scene it was drawing: the particle system
  // goes back to the arena here, the seal's rim comes off the bust. FIRST in
  // this function, because everything below is the run being built and the
  // resets that follow (resetParticles in particular) have to land on buffers
  // that already belong to world.scene again.
  closeMainMenu();
  // The title card is gone. Releases the hero framing rather than dropping it,
  // so the frame glides back to the run's over the first fraction of a second
  // instead of cutting on the exact frame the player pressed Start. A no-op on
  // every route into a run that never showed the card — a restart, `?sandbox`,
  // or reduced motion.
  endTitleSeal();
  // A run abandoned by restarting still has data worth keeping — file it
  // before the new one clears the recorder, or the only runs ever recorded
  // are the ones that ended in death.
  if (playtest.isRecording()) playtest.endRun('restart');
  // Frame times are per RUN, and the recorder is cleared here rather than at
  // boot on purpose: boot is a loading screen and a shader warm-up, and the
  // multi-second frames those produce would sit at the top of the worst-frames
  // list for the rest of the session.
  // Seeded with the counts as they stand NOW, so the run's totals are what it
  // pulled in itself rather than everything the page has ever compiled — which
  // includes the whole warm-up, and would make every first run look like a
  // disaster and every later one look free.
  perfRunStart(
    performance.now(),
    programsEverBuilt(),
    world.renderer.info.memory.textures,
    heapUsed(),
    world.renderer.info.programs,
  );

  unlockAudio(); // browsers need a gesture before any sound can play
  preloadDefaultTracks(); // fetches the built-in loops once; no-op after the first call
  preloadAmbient(); // same deal for the ambient bed's clips
  // A death is the busiest the mix ever gets, so the repetition ducking is at
  // its deepest right as the run ends. Cleared here or the first shots of the
  // next run come out quiet for no reason the player can see.
  resetRepetition();
  hideAllMenus();
  resetEnemies(world.scene);
  // After resetEnemies, which is what actually clears the last run's boss out
  // of the water: this only drops the reference to it and rolls the level the
  // next one arrives at.
  resetBoss(world.scene);
  updateBossBar(null);
  resetProjectiles(world.scene);
  clearProjectileTrails(world.scene);
  // The breach trail's ribbons and the air ramp they read. Both are per-run:
  // a trail left recording from the last run would draw a stripe from wherever
  // that seal died to wherever this one starts, and a stale ramp would hand
  // the first shot of the run a bonus nobody earned.
  clearBreachTrail(world.scene);
  resetAirborne();
  // Must follow resetProjectiles: the voices are keyed by projectile, and a
  // shell removed without its voice being released leaves that voice running
  // — a mussel you can still hear hunting through the whole next run.
  clearProjectileVoices();
  clearImpactFlashes();
  // Every mark riding a body, dropped with the bodies. A wound outlives its
  // animal by design (it fades on its own clock, not the creature's), so a run
  // reset is the one moment they have to be taken off the board by hand.
  clearBossImpacts();
  // And the wreckage of the last boss, which outlives its animal by design
  // (it sinks on its own clock, not the creature's) and would otherwise be
  // raining down through the opening seconds of the next run.
  resetBossGibs();
  // Same for what is left of the crew — bones sink for five and a half seconds
  // and would otherwise still be arriving on the seabed of the next run.
  resetGore();
  // ...and any body still being held for a photograph. Released rather than
  // burst: this is a restart, and a boss exploding over the opening frame of
  // the next run is worse than one that simply isn't there.
  resetBossCorpses();
  resetBossBooms();
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
  // And for the third: a boss kill shot interrupted by a restart (the score
  // screen is reachable from inside one, since gameplay stays live through it)
  // would hand the new run a dilated clock and a frame still clamped to where
  // the last seal was standing.
  resetBossKill();
  resetBeams(world.scene);
  resetLaserEyes();
  resetEyeLights();
  resetBossEyes();
  // The last run's trophy goes with it, or the death screen would offer this
  // run's player a picture of somebody else's boss.
  resetBossShot();
  // The pile in the corner goes with it. Those prints are this run's kills,
  // and a new run that opens with the last one's trophies already on screen
  // reads as a HUD that never clears rather than as a record.
  resetSnapshotPrints();
  // And for the fourth: the stage bends the clock too, and a run started with
  // it still open would begin parked, in slow motion, with nothing spawning.
  resetStage();
  resetPlayer();
  // The corner empties with the rest of the run. resetPlayer has just cleared
  // the pick list, so this reads an empty array and drops every tile — without
  // it the new run opens holding the dead run's build.
  setHiveUpgrades(player.upgrades);
  // AFTER resetPlayer, not before: the rig places itself on the seal rather
  // than springing to it on its first frame, so it has to be reset once the
  // seal is back at midwater. Reset before, and a run opens with the frame
  // sailing across the arena from wherever the last body came to rest.
  //
  // ...AND NOT AT ALL WHEN A MENU IS GLIDING OUT OF THE WAY. The rig is
  // mid-blend from the menu's framing into this run's opening shot — that IS
  // the transition — and a reset here would place the camera on `roundStart`
  // on the frame Play was pressed, which is exactly the cut the menu exists to
  // remove. Every other route in (a restart, `?sandbox`) still resets.
  if (!mainMenuActive()) resetCineCamera();
  resetGarlic();
  resetShrimpRing();
  resetClub();
  resetStrike();
  // The chain fanfare's floor, on the run clock — which restarts at 0, so a
  // stale stamp from a long previous run would swallow the first link of this
  // one. -Infinity rather than 0: the very first link of a run has nothing to
  // be too soon after.
  lastChainCeremony = -Infinity;
  // Shells the last run's final dash queued but never got to throw. Without
  // this they arrive in the opening seconds of the new run, from a seal that
  // has not struck yet.
  resetMusselVolley();
  // The meter's display state, both halves. The springs would otherwise open
  // the new run mid-flight from wherever the last one ended, and the skin's
  // bucket cache would think it had already stamped a body that has since been
  // rebuilt.
  resetStrikeRing();
  resetChargeSkin();
  // Everything the last run's strikes painted. Marks hold a reference to the
  // body they're on, so a run that ended with three sharks lit up would carry
  // both the reticles and the references into the next one.
  resetMarks();
  // Drops the rolled element AND clears any status still ticking on a
  // creature carried into the new run — the statuses outlive the thing that
  // applied them, so a re-roll without this leaves fish poisoned by the
  // last run's numbers.
  resetElements(world.scene);
  clearStatuses(enemies);
  // ...and the boss-side half of the same thing: an announcement queued on the
  // frame the run ended would otherwise go off over the new one.
  resetControl();
  // Disarms both trigger zones and puts the sun and moon back to a cold glow —
  // a run that ended mid-flare would otherwise open on a flickering sky, and
  // the cooldown from the last run's pass would still be running down.
  resetCelestialPass();
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
  resetWhales(world.scene);
  resetWhaleClock();
  resetBoats(world.scene);
  resetEel();
  resetEelBolts(world.scene);
  resetEelCompanion(player.mesh.position);
  resetBeluga(world.scene, player.mesh.position);
  resetSealTeam(world.scene);
  resetBakalar(world.scene);
  resetCalamari(world.scene);
  resetDumbo(player.mesh.position);
  // Only the meshes. The rings themselves live on the CREATURES, and every
  // enemy record is built fresh per spawn with `harpAura: 0` seeded — nothing
  // carrying one can survive into the next run.
  resetHarp();
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
  // Cleared with the rest of the run, or a seal that swims into a new run and
  // dies to something unclassified would be handed the LAST run's punchline.
  lastDamageSource = null;
  gameState.deathCauses = null;
  gameState.deathSource = null;
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
  // Held xp belongs to the run that earned it and to nothing else.
  xpSpill = 0;
  xpSpillLeft = 0;
  shootCooldown = 0;
  missileCooldown = 0;
  scallopCooldown = 0;
  oysterCooldown = 0;
  bounceCooldown = 0;
  rapidFireTimer = 0;
  bubbleSpawnTimer = randomBetween(CONFIG.oxygen.bubbleSpawnMin, CONFIG.oxygen.bubbleSpawnMax);
  rapidFireSpawnTimer = randomBetween(CONFIG.rapidFirePickup.spawnMin, CONFIG.rapidFirePickup.spawnMax);
  resetChumChunkSpawner();
  starfishCooldown = 0;
  seagullCooldown = 0;
  whaleCrumbTimer = 0;
  simClock = 0;
  feedbackState.shake = 0;
  feedbackState.hitstop = 0;
  clearToasts(); // don't carry the last run's numbers into this one
  // The band is per-run for the same reason: a warning from the run that just
  // ended is not news. The TIP LEDGER is not reset here — which tips this
  // browser has been shown outlives every run on it, and is the whole point of
  // systems/tutorial.js. Only the tip currently talking is dropped.
  resetCallouts();
  resetTutorialRun();
  clearCalloutUi();
  // ...and nothing left lit from the last run's tip. The subject is usually
  // gone with the arena anyway; what this is really for is the material a
  // 'paint' highlight swapped in, which belongs back on its object before
  // anything else can be spawned wearing it.
  clearTelegraph();

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

  // Zero dt: this is the reset, not a frame. The seal's gauges are smoothed
  // (see resetPlayerBars) and the reset has just seeded them at full — letting
  // time pass here would start them chasing before the run has begun.
  updateHUD(gameState, player, null, rapidFireTimer, world.camera, 0);
}

// Dying stops the RUN, not the frame. The seal goes limp and sinks, time and
// sound dilate around it (systems/deathDive.js), and the score screen only
// arrives once the body has settled on the seabed — so the name box never
// takes the keyboard while there's still something to watch.
// What last took health off the seal. Written by the three places that can —
// onPlayerHit, the lightning bolt and the drowning tick — and read once, by
// killPlayer, to decide which game-over line the player gets.
//
// The LAST source rather than the biggest one, deliberately: a seal worn down
// by a megalodon and finished off by running out of air died of drowning, and
// that is the joke to make. It is also the only reading that needs no history.
let lastDamageSource = null;

function killPlayer() {
  player.anim?.trigger('death'); // clamps on its last frame, never hands back
  gameState.running = false;
  // Resolved here rather than inside showGameOver, which can be minutes away
  // down the other end of the death dive — by then nothing else has touched
  // `lastDamageSource`, but the run ended HERE and this is a fact about it.
  gameState.deathCauses = causesOfDeath(lastDamageSource);
  // The raw source alongside the causes, for the score screen's Threats tab.
  // The Set above is every cause a QUIP may fire on — several, on purpose —
  // and a recap that has to name one thing cannot pick from it. Banked at the
  // same moment and for the same reason: nothing else touches
  // `lastDamageSource` between here and the card, and this is still a fact
  // about the run that ended HERE.
  gameState.deathSource = lastDamageSource;
  // updateHUD stops here, and the seal's floating bars are anchored by it —
  // see hidePlayerBars. The rest of the HUD is screen-anchored and can stay.
  hidePlayerBars();
  // The boss bar goes with them, and for a stronger reason: it is driven from
  // the running branch of the loop, so left up it would hang there frozen at
  // whatever the last frame of the fight said for the whole descent.
  updateBossBar(null);
  // Filed here rather than from showGameOver: the run ends at the moment of
  // death, and the dive plus the name-entry screen after it can sit open for
  // minutes.
  // The run is still recorded either way — only the console report and the B
  // overlay are authoring surfaces, and printing "press B" on a build with no
  // B key is just noise in a player's console.
  // The frame-time record rides along with the run, so it lands in
  // playtest/runs.jsonl on disk rather than only in a console someone has to
  // be sitting in front of. A hitch is a property of a RUN — of what was in
  // the water and how big the window was — and reading it next to the kills
  // and the level is what turns "it stuttered" into "it stuttered while the
  // trawler was breaking up".
  const perfRecord = {
    perf: perfSummary(),
    render: {
      draws: world.renderer.info.render.calls,
      mpix: +((world.renderer.domElement.width * world.renderer.domElement.height) / 1e6).toFixed(2),
      scale: +world.renderer.getPixelRatio().toFixed(2),
      enemies: enemies.length,
    },
  };
  if (DEV_UI) showPlaytestReport(playtest.endRun('death', perfRecord));
  else playtest.endRun('death', perfRecord);
  // Frame times for the run just ended, alongside it. Printed at DEATH rather
  // than from showGameOver for the same reason the playtest report is: the
  // dive and the name box can sit open for minutes, and the recorder keeps
  // running through both — a report taken later would fold a paused menu's
  // easy frames into a fight's distribution and flatter every number in it.
  //
  // The context line matters as much as the percentiles: a run is slow either
  // because of what was in the frame (draws) or because of how big the window
  // was (Mpix), and a report without both can't tell those apart a week later.
  if (DEV_UI) {
    const px = (world.renderer.domElement.width * world.renderer.domElement.height) / 1e6;
    perfRunReport(
      `run ${gameState.level ?? 1}`,
      `${world.renderer.info.render.calls} draws · ${px.toFixed(1)} Mpix · scale ${world.renderer.getPixelRatio().toFixed(2)}`,
    );
  }
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
    // The boss count is handed over rather than read off the roll of
    // photographs: `bossState.defeated` is what the run actually did, and the
    // photographs are a feature that can be switched off, capped, or fail on a
    // tainted canvas. A scorecard that said "0 bosses" over four pictures of
    // dead bosses would be the tell that it was counting the wrong thing.
    showGameOver(gameState, { bosses: bossState.defeated });
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

/**
 * @param {number} amount
 * @param {boolean} spilled  true when this is the reserve paying itself in, and
 *                           the only caller allowed past the clamp below — a
 *                           payment that re-spilled would push the window out
 *                           every frame and the reserve would never empty.
 */
function gainXP(amount, spilled = false) {
  // No progression while staging. Not tidiness: an orb drifting into the seal
  // mid-session opens the upgrade cards, which pause the run, dilate the clock
  // and put a menu over the effect you were looking at — and then change the
  // build underneath the numbers you were judging. A staged session has to
  // hold still, which means the seal you are tuning against at the end is the
  // one you started with.
  if (isStaging()) return;
  // ONE MOUTHFUL, ONE CARD. A boss orb is worth several early levels on its own
  // and the whole `while` below used to fire on the frame it was swallowed, so
  // the run stopped for five upgrade screens back to back with no water between
  // them. Anything past the allowance is held and paid in by updateXpSpill —
  // nothing is lost, it just stops arriving all at once. See CONFIG.xp.spill.
  const spill = CONFIG.xp?.spill;
  if (!spilled && spill?.enabled !== false && amount > 0) {
    const room = xpAllowance(gameState, spill?.maxLevels ?? 1);
    if (amount > room) {
      xpSpill += amount - room;
      // The FULL window again rather than whatever was left of the last one: a
      // second boss orb landing mid-spill is a bigger reserve, and paying it
      // over the tail of an old window would be the same lump this exists to
      // stop.
      xpSpillLeft = Math.max(0.001, spill?.seconds ?? 10);
      amount = room;
    }
  }
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

/**
 * The held-back xp paying itself into the bar, linearly across what is left of
 * its window. See CONFIG.xp.spill.
 *
 * Called from inside the gameplay tick, which is what gates it correctly for
 * free: the reserve stops while the upgrade cards are up (they pause the run)
 * and stops on death, so the levels it owes arrive with the player swimming and
 * the bar on screen rather than over a menu or a descent.
 *
 * `dt` is gameplay seconds, so the window is dilated by the level-up slowdown
 * exactly like everything else the player is watching.
 */
function updateXpSpill(dt) {
  if (!(xpSpill > 0)) return;
  const step = spillStep(xpSpill, xpSpillLeft, dt);
  xpSpill = step.reserve;
  xpSpillLeft = step.secondsLeft;
  // Past the clamp on purpose — see the `spilled` parameter on gainXP.
  gainXP(step.pay, true);
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
  startSalute();
}

/**
 * THE SALUTE — the seal reacting to its own level, in the half second the
 * cards are held back for (CONFIG.levelUp.salute).
 *
 * Three parts, and this function owns only the third. The BEAT and the SNAP
 * ZOOM belong to systems/levelUpTime.js, which is already the module that
 * decides when the menu is allowed to arrive; the POSE is fired from here
 * because the two systems have no business importing each other — one runs a
 * clock, the other runs an IK solver — and main.js is where every other
 * cross-system moment in this file is assembled.
 *
 * WHY IT IS TIMED OFF cardsArriveAt() RATHER THAN OFF ITS OWN NUMBERS: the
 * pose has to be at full extension as the menu lands and not a beat after it,
 * and the menu's arrival is a sum of three tunable times. Hand-typing a peak
 * next to them means the first person to drag `beat` leaves the seal saluting
 * into a screen that is already covered. `poseLead` is how far ahead of the
 * cards full extension is reached, which is the thing actually worth tuning.
 *
 * Nothing here is on the dilated clock — see the header of celebrate.js. The
 * world is easing to half speed underneath the seal, which is most of why the
 * pose reads: the animal moves at its own pace against a slowed ocean.
 */
function startSalute() {
  if (!saluteEnabled()) return;
  const s = CONFIG.levelUp?.salute ?? {};
  const peak = Math.max(0.05, cardsArriveAt() - (s.poseLead ?? 0.12));
  playCelebration({
    weights: s.poses ?? {},
    peakAt: peak,
    hold: s.poseHold ?? 0.22,
    release: s.poseRelease ?? 0.4,
    // The squad is frozen for all of this — see the note in sealTeam.js.
    escorts: false,
  });
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
  // The corner picks the new tile up here rather than on a timer. setHiveUpgrades
  // no-ops when the folded set has not changed, so calling it on every pick is
  // the cheap path, not a rebuild per level.
  setHiveUpgrades(player.upgrades);
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
// WHAT IS DOING THE DAMAGE, as a colour.
//
// The mark left on a boss's skin (systems/bossImpact.js) is the only readout in
// the game of what is actually landing on it, so it is tinted by the source
// rather than by a fixed palette — a venom build and an ice build should not
// leave the same coloured hits on the same animal.
//
// Resolved in order of how SPECIFIC each answer is:
//
//   the ordnance itself   a mussel is a mussel whatever element is riding it;
//                         its own body colour is what the player watched fly in
//   the run's element     every ordinary pellet carries it, and it is the thing
//                         the player chose
//   the impact's own      no element, no special ordnance: a plain shot
//
// Returns undefined rather than a default, so the caller's own fallback stays
// the single place the plain-shot colour is written down.
function damageSourceColor(projectile) {
  if (projectile?.mesh?.name === 'missile') {
    const key = projectile.assetKey ?? projectile.mesh?.userData?.assetKey;
    const own = key ? assetBaseColor(key) : null;
    if (own != null) return own;
  }
  const el = activeElement();
  return el ? elementColor(el) : undefined;
}

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
  return (e, dmg, x, y, dir, projectile, at) => {
    playtest.recordDamage(source, dmg, e);
    onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile, at);
  };
}

// Shared by every damage source (bullets, missiles, garlic, shrimp ring,
// strikes, the eel) so a hit feels the same regardless of what caused it.
//
// `at` is the contact from systems/hitShape.js when the hit came through a
// measured body: where on the skin it landed, which way that surface faces,
// and which sphere it was. Absent for everything else, and everything below
// still works without it — a creature with a circle for a hitbox has no
// surface to have landed on and gets exactly the feedback it always got.
function onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile, at = null) {
  // THE LAST BLOW THIS CREATURE TOOK, which for one of them turns out to be the
  // one that killed it. Recorded here because this is the only place in the
  // game that sees every source of damage — a bullet, a mussel, the garlic aura,
  // a strike, the eel — and because a frame later, when systems/bossCorpse.js
  // takes the body, the thing that did it is unknowable.
  //
  // Only the direction and the landing point, as loose numbers: nothing here
  // may hold a reference to a projectile that is about to be despawned.
  //
  // The direction falls back to the line from the seal to the animal, which is
  // right for every source that has no travel of its own to report (an aura
  // does not come from anywhere) and is the only sensible reading of "who did
  // this" in a game with one attacker.
  if (dmg > 0) {
    let bx = dir?.x ?? 0;
    let by = dir?.y ?? 0;
    if (bx * bx + by * by < 1e-8) {
      bx = e.mesh.position.x - player.mesh.position.x;
      by = e.mesh.position.y - player.mesh.position.y;
    }
    e.lastBlow = { dx: bx, dy: by, hx: x ?? e.mesh.position.x, hy: y ?? e.mesh.position.y };
  }

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
  // `e.assetKey`, not `e.def.asset` — a def may list several bodies and the
  // flash takes its colour from the one this individual actually wears.
  const impact = missileImpactFeedback(e.assetKey ?? e.def?.asset, x ?? e.mesh.position.x, y ?? e.mesh.position.y, dmg, projectile, e.radius);

  if (!impact) {
    feedback('bulletHit', {
      x: x ?? e.mesh.position.x,
      y: y ?? e.mesh.position.y,
      dirX: -(dir?.x ?? 0),
      dirY: -(dir?.y ?? 0),
      scale: Math.min(1.8, 0.6 + dmg / 30),
    });
  }

  // AND, on a body big enough to have been measured, the break and the wound.
  // Gated on the shape rather than on "is this the boss", which is the same
  // gate the hitbox itself uses: the effect exists because there is a surface
  // to put it on, and any creature that grows one gets it with no code here
  // learning about it.
  //
  // ON TOP OF the generic hit rather than instead of it. The two are doing
  // different jobs — `bulletHit` is the weapon's own report and is the same on
  // every target, and this is the target's, drawn on its actual skin — and a
  // boss that swallowed the ordinary hit feedback would feel LESS responsive
  // to shoot than a reef fish.
  // What it is made of, going in. Gated on being a boss rather than on having a
  // measured shape (the impact below), because the two answer different
  // questions: the mark needs a surface to sit on, and the voice only needs the
  // fight to be a boss fight. Throttled per class in CONFIG.feedback, or
  // multishot turns it into a rattle.
  if (e.isBoss) {
    bossVoice('hit', e.assetKey ?? e.def?.asset, {
      x: x ?? e.mesh.position.x,
      y: y ?? e.mesh.position.y,
      scale: Math.min(1.6, 0.7 + dmg / 40),
    });
  }

  if (at?.sphere && e.hitShape) {
    spawnBossImpact(at, {
      shape: e.hitShape,
      color: damageSourceColor(projectile),
      // Against the animal's own health, not against a fixed number: the same
      // pellet should read as a chip on a fresh boss and the effect should
      // grow as the fight does. Square-rooted so the range is usable — a hit
      // for a fiftieth of a bar and one for a fifth are 0.14 and 0.45 rather
      // than 0.02 and 0.2, which is the difference between a scale that varies
      // and one that is off until it is suddenly on.
      scale: 0.55 + 2.2 * Math.sqrt(Math.min(1, dmg / Math.max(1, e.maxHp))),
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

      // Scenery is not something a bolt "kills for 0" — it is not a target at
      // all, so the splash skips it rather than playing a hit on it. Without
      // this arm a lethal splash asks an invincible creature for its health,
      // books that as damage against the hazard, and flashes a turtle that
      // was never in danger. This is the arm that used to file a BILLION
      // damage per turtle, back when "cannot be killed" was spelled as hp 1e9.
      if (other.invincible) continue;

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
        const { schoolWipe } = onEnemyKilledFeedback(other);
        // A SCHOOL EMPTIED BY THE STRIKE still scores its FOOD CHAIN link.
        // That link used to be claimed by the dash's own kill hook, which no
        // longer fires for anything: the ram deals no damage, so the strike's
        // kills all happen here, in its release burst. Without this the
        // rebalance would have quietly deleted one of the three remaining
        // ways to keep a chain alive. Gated on the source so a seagull bomb
        // clearing a school doesn't claim a link the strike system owns.
        if (schoolWipe && s.source === 'strike') chainFrom('schoolWipe');
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
/**
 * EVERY WAY THE PLAYER LOSES HEALTH, in one place.
 *
 * A named function rather than the inline hook it used to be, because there is
 * now a second caller: the boss's electric aura (systems/bossPerks.js) is
 * damage that does not come out of resolveCombat, and giving it its own
 * subtraction would have been a second, quieter way to lose hp — one that
 * skipped the playtest accounting, the hit flash, the tail impulse and the
 * death check. Anything that hurts the seal should come through here.
 */
function onPlayerHit(dmg, dir, source = 'unknown') {
  // THE ONE PLACE EVERY POINT OF DAMAGE ARRIVES — contact, shots, perks,
  // blasts — which is why the boss's ceilings are applied here rather than at
  // the sources. See capBossDamage: it trims a boss down to what it is allowed
  // to take in one hit and in one second, and returns everything else exactly
  // as it came. Ordinary wildlife is untouched.
  //
  // Before recordPlayerDamage, so the playtest ledger records what the player
  // actually took. Filing the uncapped figure would leave every incoming-damage
  // reading in the report describing a game nobody played.
  dmg = capBossDamage(dmg, source, player.stats.maxHp, gameState.time);
  if (!(dmg > 0)) return;
  playtest.recordPlayerDamage(dmg, source);
  lastDamageSource = source;
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
      // AND THE SEAL ITSELF, for the creatures that declare a shove — today
      // just the hammerhead boss. Same direction the tail flick uses (it points
      // away from whatever hit you, from its CENTRE rather than from the
      // contact point — see the note in combat.js) and the same gate: `shown`,
      // the banked hit. That gate is what makes this a shove rather than a
      // shove per frame. Contact damage arrives as `contactDamage * dt`, sixty
      // slices a second, and firing an impulse on each would be a wall of force
      // the player could never swim out of; playerDamageFx banks those slices
      // and returns a size only when it decides a hit is worth showing, at most
      // about six times a second. So the shove lands on the same frame as the
      // flinch, the grunt and the screen shake, which is what makes it read as
      // one event.
      //
      // `source` is the creature's own type key (combat.js passes `e.type`), so
      // the strength is looked up on the row rather than plumbed through three
      // call sites. A source that is not a creature — a shot, a blast, 'unknown'
      // — misses the lookup and shoves nobody, which is correct.
      const shove = CONFIG.enemies?.[source]?.playerKnockback;
      if (shove > 0) applyPlayerKnockback(dir.x, dir.y, shove);
    }
  }
  if (player.hp <= 0 && !deathState.active) killPlayer();
}

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
  //
  // chumRadiusOf, not e.def.radius: for one creature in the roster the hitbox
  // is not a statement about size, and everything the drop reads keys on the
  // radius passed here. See the note on it in entities/pickups.js.
  spawnXpOrb(world.scene, e.mesh.position, e.xp ?? e.def.xp, chumRadiusOf(e.def));

  const combo = comboMultiplierFor(strikeState);
  const { points, schoolWipe } = computeKillPoints(e, enemies, combo);
  gameState.score += points;
  // `points` is already multiplied, so the toast shows what actually got
  // banked. The factor is still passed, but only to colour the toast as a
  // combo kill — it is no longer printed alongside the number.
  spawnScoreToast(world.camera, e.mesh.position.x, e.mesh.position.y, points, combo);

  // A BOSS COMES APART. Here rather than in systems/boss.js, which is where
  // every other part of the aftermath lives: that module finds out a boss died
  // the frame AFTERWARDS, by noticing the creature has left the enemy list, and
  // by then the body has gone back to the visual pool and its bones are posing
  // somebody else. The chunks are sampled from the posed hitbox (see
  // systems/bossGibs.js), so they have to be thrown while there is still a pose
  // to sample. The camera can afford the extra frame; the body cannot.
  //
  // ...a beat later, though, not now. systems/bossCorpse.js takes the body off
  // this frame and keeps it whole until the kill shot has taken its picture,
  // then throws the burst itself off the same pose. It returns false if the
  // hold is switched off, and the old behaviour — burst on the killing frame —
  // is what happens then.
  if (e.isBoss && !holdBossCorpse(e, world.scene)) {
    spawnBossGibs(e);
    // The explosion normally rides the corpse's own countdown, a third of a
    // second before the shutter (see systems/bossCorpse.js). With the hold
    // switched off there is no countdown and no body to wait for, so it goes
    // here, on the killing frame, off the pose that is about to be released.
    fireBossBoom(e);
  }

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
    // A DEATH IS THE CREATURE'S OWN COLOUR, always. A trout comes apart lime,
    // a barracuda purple, a reeffish magenta — that hue is what says which
    // thing just died, and it carries that on its own without the player
    // reading the size of the burst or hearing the pitch of the sound (which
    // still vary too, see `heft` and `scale` above).
    //
    // assetBaseColor, not assetSignatureColor: the signature returns null for
    // any creature with no tuned look, and null falls through to the emitter's
    // generic palette — which is exactly the outcome this rule exists to
    // prevent. The base colour answers for every creature, tuned emissive
    // first and the asset's own authored colour behind it.
    //
    // e.assetKey, not e.def.asset: `asset` may be an `assets` LIST, and this
    // individual rolled one of them at spawn (see spawnOne in enemies.js).
    // Reading the def here would tint the burst off a sibling variant's
    // colour, or off undefined for any def that only lists `assets`.
    color: assetBaseColor(e.assetKey ?? e.def.asset) ?? undefined,
  });

  // ...and what it was MADE OF, under that. Bosses only: this is a fight
  // ending, and firing a material voice for every minnow would put a second
  // sound under the most frequent event in the game.
  if (e.isBoss) {
    bossVoice('die', e.assetKey ?? e.def.asset, {
      x: e.mesh.position.x,
      y: e.mesh.position.y,
    });
  }

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
// When the last full chain ceremony fired, on the RUN clock — which freezes
// with the game, so a link scored on the frame a level-up lands does not have
// its fanfare eaten by the seconds spent on the card screen.
let lastChainCeremony = -Infinity;

function onChainHit(chain, source) {
  const x = player.mesh.position.x;
  const y = player.mesh.position.y;

  // The first-run "strike then keep eating" tip, answered by the loop it
  // described actually closing. Here rather than in chainFrom because this is
  // the funnel every source of a link comes through — a strike paid for in
  // food, a school emptied, a breach with Porpoising — and the tip is about
  // the chain rather than about any one way of extending it.
  noteTutorialEvent('chainLink');

  // FIRST, before the impact events below, and deliberately so: hit-stop is
  // rate-limited globally (see feedback.js) and whichever event asks first
  // claims the window. The extension is the bigger of the two things
  // happening, so it gets to be the one that stops the frame.
  const bannerFrom = CONFIG.strike.foodChain?.bannerFrom ?? 1;
  if (chain >= bannerFrom) {
    const fc = CONFIG.strike.foodChain ?? {};
    // THE NUMBER ALWAYS UPDATES; THE FANFARE HAS A FLOOR. A link is one
    // mouthful, and a magnet sweep swallows six inside a frame — so the banner
    // below re-pops with the new count and the new colour every time, and the
    // camera work fires at most every `ceremonyGap`. Re-triggering a 1.1s
    // cinematic hold ten times a second never lets the lens settle, which
    // reads as the game struggling rather than as the player doing very well.
    // Same rule as the proc toast's `toastMinGap`: a repeat is never dropped,
    // it just does not replay its own arrival.
    const ceremony = gameState.time - lastChainCeremony >= (fc.ceremonyGap ?? 0);
    // DEPTH PAST THE FIRST BANNER, which is what the pitch and the punch are
    // really about: how much deeper this is than the quietest one the player
    // is shown. Measured off `minChain` rather than off a literal 2, because
    // that threshold is now 1 and the old subtraction went NEGATIVE on the
    // first link — a pitch below the base and a punch that pulled the camera
    // the wrong way, on the one link a new player is most likely to see.
    const depth = Math.max(0, chain - bannerFrom);
    feedback('foodChain', {
      x, y,
      // WHAT EXTENDED THE CHAIN. Passed for observers rather than for anything
      // in the table: chainStrike() refuses inside a source's cooldown (see
      // CONFIG.strike.chainOn.cooldowns), so this event is the only place that
      // knows a breach ASKED for links and actually got them — which is what
      // Porpoising's hive tile flashes on. A seal skimming the water line asks
      // on every crossing and is paid on few of them, and the tile has to
      // follow the payout, not the request.
      source,
      scale: Math.min(1.8, 0.8 + chain * 0.12),
      // Climbs a fixed step per link, like `strikeChain` does — the pitch is
      // how deep the chain is, readable without looking at the banner.
      sfxOpts: { pitch: 1 + depth * 0.07 },
    });
    spawnChainToast(world.camera, x, y, chain);
    if (ceremony) {
      lastChainCeremony = gameState.time;
      world.punchCamera((fc.punch ?? 0.045) + (fc.punchPerChain ?? 0.012) * depth);
      // The punch above is the fixed camera's version of this and stays exactly
      // as it was — both fire, and on the cinematic rig the punch rides on top
      // of the state's push-in the same way it rides on top of a death.
      cineEvent('foodChain');
    }
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
  // `strikeRelease` is included from its FIRST link, unlike the ambient
  // sources: a release that scored is a deliberate thing the player set up and
  // executed — refill the bar, spend it again before the window shut — and the
  // silence that used to cover link 1 is most of why the chain was invisible.
  // The ambient sources still stay quiet until the chain is actually a chain,
  // because chum arrives constantly.
  if (source === 'strike' || source === 'strikeRelease' || chain >= 2) {
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
// Is there a pickup of `kind` in the water? The first-run coach's cue, one tip
// per type — see PICKUP_TIPS in systems/tutorial.js.
//
// It lives here rather than in entities/pickups.js because of the attractor
// alone: that one belongs to systems/boats.js, since a trawler drops it, and it
// is the only pickup the pickups module has never owned. This is the one place
// that already imports both.
function pickupInWater(kind) {
  if (kind === 'attractorOrb') return attractorOrbs.length > 0;
  return pickupTypeInWater(kind);
}

// ---------------------------------------------------------------------------
// WHAT A FIRST-RUN TIP IS STANDING NEXT TO
//
// The coach asks for a subject when a tip starts and then asks where it is on
// every frame until it is gone (see systems/tutorial.js). Both halves live here
// because this is the only file that has all five places a subject can come
// from — the pickup arrays, the boats' attractor, the enemy list, the whale,
// and the arena's own surface and floor.
//
// THE HANDLE IS OPAQUE TO THE COACH and is read back only through subjectAt.
// That is what lets "the bubble the tip is about" be a different question from
// "the nearest bubble": the tip holds THIS one, and when this one is swallowed
// the tip ends, even if three more are drifting past.
//
// A PLACE IS A SUBJECT TOO. `surface` and `seabed` are answered fresh from the
// arena every frame rather than being frozen at a point, because both of them
// mean "straight up/down from the seal" — a tip about air that stayed pinned to
// the patch of waterline the seal happened to be under when it fired would
// drift a screen's width away while the player swam to it.
// ---------------------------------------------------------------------------

function takeSubject(kind, id) {
  const x = player.mesh.position.x;
  const y = player.mesh.position.y;
  if (kind === 'surface' || kind === 'seabed') return { kind };
  if (kind === 'chum') {
    const handle = chumEntry(x, y);
    return handle ? { kind, handle } : null;
  }
  if (kind === 'pickup') {
    // The row's own id names the type — one string end to end, see the note on
    // PICKUP_TIPS. The attractor is the one that lives somewhere else.
    if (id === 'attractorOrb') {
      const orb = attractorOrbs[0] ?? null;
      return orb ? { kind, id, entry: orb, list: attractorOrbs } : null;
    }
    const entry = pickupEntry(id, x, y);
    return entry ? { kind, id, entry } : null;
  }
  if (kind === 'creature') {
    // Whichever unkillable thing is nearest, and the two are not the same kind
    // of object at all — one is an enemy with a flag, the other was never an
    // enemy. The tip says the same sentence about both, which is the whole
    // reason there is one step and not two.
    const range = CONFIG.tutorial?.showRange ?? 22;
    let best = null;
    let bestD = range;
    for (const e of enemies) {
      if (!e.invincible && !e.def?.invincible) continue;
      const d = Math.hypot(e.mesh.position.x - x, e.mesh.position.y - y) - (e.radius ?? 0);
      if (d < bestD) { bestD = d; best = { kind, enemy: e }; }
    }
    if (best) return best;
    const w = whaleDistance(x, y) <= range ? nearestWhale(x, y) : null;
    return w ? { kind, whale: w } : null;
  }
  return null;
}

// Where the subject is now, plus the mesh to light up — or null, which is the
// coach's cue that the thing it was talking about is gone.
// WHICH KIND OF HIGHLIGHT this step's subject can take. Keyed on the step id
// because that is what says which array the object came from, and the two modes
// are about who already writes the object's colour — see systems/telegraph.js.
//
// Everything not named here is 'ask', which is the harmless one: it multiplies
// nothing unless the object's own owner asks for the multiplier.
const PAINTED_SUBJECTS = new Set(['bubbleOrb', 'strikeOrb', 'rapidFireOrb', 'attractorOrb']);
function telegraphModeFor(stepId) {
  return PAINTED_SUBJECTS.has(stepId) ? 'paint' : 'ask';
}

function subjectAt(handle) {
  if (!handle) return null;
  const x = player.mesh.position.x;
  const y = player.mesh.position.y;
  if (handle.kind === 'surface') return { x, y: bounds.surfaceY };
  if (handle.kind === 'seabed') {
    // The pile, if there is one on the floor, and otherwise the floor itself
    // under the seal. Both are right for the tip this serves ("loose chum sinks
    // — out come the crabs"): while there is chum down there the sentence
    // belongs beside it, and the step ends the moment the floor is clear
    // anyway, so the fallback is only ever the frame in between.
    const pile = nearestFloorPickup(x, y, Infinity);
    if (pile) return { x: pile.mesh.position.x, y: pile.mesh.position.y, mesh: pile.mesh };
    return { x, y: seabedTopY() };
  }
  if (handle.kind === 'chum') {
    if (!chumEntryAlive(handle.handle)) return null;
    const m = handle.handle.entry.mesh;
    return { x: m.position.x, y: m.position.y, mesh: m };
  }
  if (handle.kind === 'pickup') {
    const alive = handle.list
      ? handle.list.indexOf(handle.entry) !== -1
      : pickupEntryAlive(handle.id, handle.entry);
    if (!alive) return null;
    const m = handle.entry.mesh;
    return { x: m.position.x, y: m.position.y, mesh: m };
  }
  if (handle.kind === 'creature') {
    if (handle.enemy) {
      if (enemies.indexOf(handle.enemy) === -1) return null;
      const m = handle.enemy.mesh;
      // NO MESH HANDED BACK for a creature, deliberately: an animal wears a
      // skin, an outline and often an injected shader, and the highlight system
      // would either refuse it or break it (see paintable in
      // systems/telegraph.js). The label beside it is the whole tell.
      return { x: m.position.x, y: m.position.y };
    }
    if (!whaleAlive(handle.whale)) return null;
    const c = handle.whale.container;
    return { x: c.position.x, y: c.position.y };
  }
  return null;
}

function chainFrom(source, links = 1) {
  const chain = chainStrike(source, links);
  if (chain) onChainHit(chain, source);
}

// ---------------------------------------------------------------------------
// THE SEAL WENT THROUGH THE SUN.
//
// Fired once per pass by systems/celestialPass.js, which owns the geometry and
// the arming; this owns what it is WORTH. It lives in main.js rather than in
// the sky because everything it pays into is somewhere else — the strike meter,
// the element, the chum in the water, the food chain — and a backdrop system
// that reached into those four would be the widest import in the file.
//
// THE SYNERGIES ARE ALL READ, NEVER BRANCHED ON A CARD ID. Each one is an
// existing stat doing what it already does everywhere else:
//
//   Splash Zone / rarity  the sun's blast goes through aoe() and abilityDamage()
//                         like every other explosion, so the cards that widen
//                         your blasts widen this one without knowing it exists.
//   Big Willy Style       a pass extends the FOOD CHAIN, because you had to
//                         breach to get up here and that is exactly the card
//                         that says a breach is worth something.
//   Glow Up!              the moon wakes the element up for a few seconds at
//                         full dark-hour power, at any time of day. Worth
//                         nothing without the card, and surgeElement says so
//                         itself rather than being asked about the stat here.
//   Attractor             the moon's pull rides the same gulp radius the strike
//                         release's own mouthful does.
//
// Nothing here is gated on the pass being "earned" beyond getting there. The
// cooldown in CONFIG.dayNight.pass is the whole rate limit — see the note in
// systems/celestialPass.js for why it is a long one.
// ---------------------------------------------------------------------------
function onCelestialPass(which, at) {
  const cfg = CONFIG.dayNight?.pass ?? {};
  const body = cfg[which] ?? {};
  const stats = player.stats;

  // The juice first, so it lands on the same frame as the flare the pass
  // system has already raised on the body itself. Two call sites rather than
  // one with the name picked by a ternary: `npm run test:upgrades` checks every
  // feedback key fired anywhere in the source against CONFIG.feedback by
  // reading the literal at the call site, and a name assembled in an expression
  // is a key that check cannot follow.
  const fx = { x: at.x, y: at.y, scale: at.scale };
  if (which === 'sun') feedback('sunPass', fx);
  else feedback('moonPass', fx);

  // A FOOD CHAIN link, gated on Porpoising. Before the payouts below so the
  // chain toast reads as the reason for them rather than as an afterthought.
  const links = (body.chainPerBreachLevel ?? 0) * (stats.breachChainLevel ?? 0);
  if (links > 0) chainFrom('breach', links);

  if (which === 'sun') {
    // The flare goes off where the SEAL is, not at the centre of the sun: up
    // here that is the difference between catching the gulls and the boat crew
    // in the blast and going off in empty sky a few units above them.
    if (body.blast?.damage > 0) {
      pendingSplashes.push({
        x: at.x,
        y: at.y,
        damage: abilityDamage(body.blast.damage) * at.scale,
        radius: aoe(body.blast.radius ?? 0),
        exclude: null,
        source: 'sunPass',
      });
    }
    // ...and the meter. Landing out of a pass with a strike banked is the whole
    // feeling — the sun hands back the thing you spent getting to it. A pass
    // that TOPS the meter off mid-combo earns its link like any other refill.
    if (body.charge > 0 && addCharge(body.charge, stats)) chainFrom('chumFull');
    return;
  }

  // The moon pays in time instead, and it needs no announcement of its own:
  // a woken element lights the SEAL UP — updateElementSkin reads the same
  // elementPower() the surge raises — so the feedback is the animal glowing in
  // broad daylight for the length of it. `surgeElement` returns false in a run
  // that never took Glow Up!, which is the synergy being honest about itself.
  surgeElement(body.surge ?? 0);
  // The tide, on the seal rather than on the moon: this is chum being pulled to
  // you, and it has to be reachable from where you land.
  if (body.gulp > 0) {
    gulpPickups(
      world.scene, player.mesh.position.x, player.mesh.position.y,
      body.gulp + (stats.chumGulpRadius ?? 0),
      // collectChum already ends in onChumSwallowed — that is the whole reason
      // it exists as a named function (see the note on its last line). Calling
      // it again here fed every orb the tide hoovered into the meter TWICE,
      // and now that a mouthful is a FOOD CHAIN link it would score two of
      // them per orb: a moon pass silently paying double, which is exactly the
      // sort of thing that makes the chain read as random.
      collectChum,
    );
  }
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
  // The denominator for every chain rate in the report — links per strike means
  // nothing without knowing whether there was any food to be had.
  playtest.recordChum();
  const filled = feedChum(player.stats);

  // THE FOOD CHAIN, SCORED HERE. A strike released in the sweet spot ARMS the
  // chain; this mouthful is what makes it one, and every mouthful after it
  // ticks the number up. Read before the `filled` branch below and outside it,
  // because a link no longer has anything to do with the bar reaching full —
  // that is a separate, rarer event that happens to share this funnel.
  const chain = consumeChainLink();
  if (chain) {
    playtest.recordChainLink(chain);
    onChainHit(chain, 'chumEaten');
  }

  if (!filled) return;
  // The bar just crossed to full — the seal flashes head to tail. Fired here
  // rather than inside chargeSkin's own update because "crossed" is an EVENT
  // and the skin only ever sees a level; a per-frame threshold test there
  // would refire the wave every frame the bar sat at full.
  chargeCrossed();
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
  // The first-run "eat chum" tip is answered here rather than at any of the
  // three call sites above it, because this is the one funnel every route into
  // eating goes through — swum over, hoovered by a gulp, or handed over by the
  // attractor orb. A tip cleared by only one of those would stay on screen
  // through a player doing exactly what it asked.
  noteTutorialEvent('chum');
  // A LIVE FOOD CHAIN IS WORTH LEVELS, not just points. Read BEFORE
  // onChumSwallowed below feeds this same mouthful into the meter: the
  // multiplier a swallow earns is the depth the chain was at when the seal
  // reached it, and paying it the depth its own pip created would let a chain
  // pay itself. See CONFIG.xp.chain.
  gainXP(value * chainXpMul(player.stats));
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
      lastDamageSource = 'lightning';
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

// The spawn options that turn a basic pellet into a seeker, or null for a run
// that never took Sonar Teeth.
//
// Returned as an object to spread rather than as individual arguments so the
// no-card case adds NOTHING to the spawn — see the call site. `acquireRadius`
// is the one number here that goes through scaling: it is an acquisition
// radius like every other one in the game, so Splash Zone widens it (gently —
// see systems/scaling.js on why reach and acquisition are split).
function homingShotOpts(level) {
  const c = CONFIG.homingShot ?? {};
  if (!c.enabled || !(level > 0)) return null;
  const extra = level - 1;
  return {
    homing: true,
    orient: true,
    turnRate: (c.turnRate ?? 0) + (c.turnRatePerLevel ?? 0) * extra,
    acquireRadius: targeting((c.acquireRadius ?? 0) + (c.acquireRadiusPerLevel ?? 0) * extra),
    homingDelay: c.homingDelay ?? 0,
    sizeBias: (c.sizeBias ?? 0) + (c.sizeBiasPerLevel ?? 0) * extra,
    sizeRefRadius: c.refRadius ?? 1,
  };
}

function fire() {
  const s = player.stats;
  const rapid = rapidFireTimer > 0;
  // `fireRate` is an INTERVAL, so both multipliers divide it — the same
  // direction the rapid-fire pickup already went. Air time is folded in here
  // rather than into the stat block because the ramp changes every frame and
  // the block is only rebuilt on level-up; see the note at the top of
  // systems/airborne.js. It is 1 for a seal in the water.
  const fireRate = (rapid ? s.fireRate / CONFIG.rapidFirePickup.fireRateMul : s.fireRate)
    / airFireRateMul();
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

  // Sonar Teeth. Resolved once per volley rather than per pellet — every
  // pellet in a volley is the same gun, and the object is spread into each
  // spawn below. `null` for a run without the card, which is the only reason
  // the spread is safe: nothing is added to the spawn options at all, so an
  // un-upgraded bullet is byte-for-byte the projectile it always was.
  const seek = homingShotOpts(s.homingShotLevel);

  for (let o = 0; o < origins; o++) {
    for (let i = 0; i < perOrigin; i++) {
      const offset = (i - (perOrigin - 1) / 2) * fan;
      const cos = Math.cos(offset);
      const sin = Math.sin(offset);
      spawnProjectile(world.scene, {
        origin: emitPoint(rig, source, o, dir, player.mesh.position, muzzlePoint),
        dir: new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos),
        faction: 'player',
        // Air time rides the damage the same way it rides the cadence above.
        // A seal shooting on the way down is a gun platform, and this is what
        // makes that read as a decision rather than as a detour.
        damage: s.damage * airDamageMul(),
        speed: s.speed,
        life: s.life,
        radius: s.radius,
        pierce: s.pierce,
        asset: 'bullet',
        source: 'gun',
        // Points the shot at things instead of along the aim. `orient` comes
        // with it so a curving bullet visibly faces where it is going — a
        // seeker drawn on its launch heading reads as a rendering bug.
        ...seek,
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
    // WHICH WEAPON FIRED. `shoot` is shared with the starfish below, and
    // nothing in the payload used to tell the two apart — so an observer had to
    // treat every shot as the main gun's. The hive routes the whole pebble
    // volley off this (see EVENT_UPGRADE in ui/upgradeHive.js); the same string
    // the projectiles carry, so there is one vocabulary for "who fired".
    source: 'gun',
    // THE SEAL IS MOVING AND SO IS THE WATER IT JUST DISTURBED. `muzzle` has
    // always carried an `inherit` (see CONFIG.emitters) and nothing ever passed
    // it a velocity, so every flash was a burst thrown out of a stationary
    // point — a perfectly symmetrical puff left hanging exactly where the fin
    // was, which at swim speed is a body-length behind the fin a moment later.
    // With the velocity in, the puff smears along the seal's travel and gets
    // left behind, which is what says the shot was fired ON THE MOVE.
    vx: player.velocity?.x ?? 0,
    vy: player.velocity?.y ?? 0,
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
      // Same reason as the muzzle above: the exhaust is left in the water, not
      // carried along with the animal that let it go.
      vx: player.velocity?.x ?? 0,
      vy: player.velocity?.y ?? 0,
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

// THE THROWN CLUB's launch points and its noise — the same division of labour
// the barrage above uses. The count, the velocity read and the seeker all live
// in systems/club.js; main.js answers only where on the rig a club leaves from
// and what that sounds like.
//
// Fired from the FINS, which is the one emit point that means something here:
// these are the clubs off the flippers, and they leave from where they were
// being held.
function launchClubThrow(power) {
  const rig = player.aimRig;
  const dir = strikeState.dashDir;
  return fireClubThrow(
    world.scene, power, player.stats.clubThrowLevel, player.stats.clubLevel,
    player.velocity,
    (i) => emitPoint(rig, 'fins', i, dir, player.mesh.position, muzzlePoint),
    {
      // One full event for the throw and flash-only for the rest — the same
      // reason the missile volley and the barrage do it. This lands on a frame
      // that is already carrying the strike's own bark, and four stacked
      // whooshes on top of that is mud.
      onThrow: (i, x, y, dirX, dirY, speed, emptied) => {
        feedback(i === 0 ? 'clubThrow' : 'missileLaunchExtra', {
          x, y, dirX, dirY,
          vx: dirX * speed,
          vy: dirY * speed,
          // Louder when both fins actually gave up a club — that is the moment
          // the seal is left empty-handed, and it should be the moment you
          // hear, rather than every throw sounding the same whether it cost
          // anything or not.
          scale: emptied > 1 ? 1.25 : 1,
        });
      },
    },
    { boom: player.stats.clubBoomLevel, ice: player.stats.clubIceLevel },
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
  // The hull's own death under the blast — the deepest voice in the bank, and
  // the thing that makes a boat going up sound like a boat going up rather than
  // like a large fish dying. Pitched down for a trawler on the same rule the
  // blast above uses.
  bossVoice('die', boat.assetKey ?? boat.mesh?.name, {
    x: boat.mesh.position.x, y: boat.mesh.position.y,
    sfxOpts: { pitch: boat.isTrawler ? 0.82 : 1, decayMul: boat.isTrawler ? 1.3 : 1 },
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
  feedback('shoot', {
    x: origin.x, y: origin.y, dirX: dir.x, dirY: dir.y, scale: 0.7,
    source: 'starfish',   // not the gun — see the note on the volley's shoot
    vx: player.velocity?.x ?? 0,
    vy: player.velocity?.y ?? 0,
  });
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

// ---------------------------------------------------------------------------
// CHUM CHUNKS — see CONFIG.chumChunk for the design and the numbers.
//
// Three sources, one place, because the interesting property is the one you can
// only see with all three in front of you: a chunk is the biggest single swing
// in the run's economy, and it must not be possible for two of these to hand
// out four of them inside ten seconds. The ambient timer is slow, the boss
// budget is finite and per-fight, and the pity chunk is once per fight — and
// they are legible as a set only while they stay together.
// ---------------------------------------------------------------------------

// Put one in the water and announce it. `t` is a roll from rollChunkT; the
// flash scales with it, so the arrival is as loud as the chunk is big.
function dropChumChunk(pos, t, vel = null) {
  const chunk = spawnChumChunk(world.scene, pos, { t, vel });
  const flash = CONFIG.chumChunk.flash ?? {};
  if (flash.enabled !== false) {
    feedback('chumChunkSpawn', {
      x: chunk.mesh.position.x,
      y: chunk.mesh.position.y,
      // 1 at the smallest chunk up to `bigMul` at the largest.
      scale: 1 + ((flash.bigMul ?? 1) - 1) * chunk.t,
    });
  }
  return chunk;
}

function updateChumChunkSpawns(dt) {
  updateChumChunkSpawner(dt, {
    // A boss is only a boss for this purpose once it is actually fightable —
    // `arriving` is the entrance, where the creature is untouchable and the
    // health bar is still filling, and kicking a chunk out of it there would
    // have the fight paying out before it had started.
    boss: (bossState.enemy && !bossState.arriving) ? bossState.enemy : null,
    hpFrac: player.hp / Math.max(1, player.stats.maxHp),
    onAmbient: (t) => dropChumChunk(randomArenaPoint(), t),
    onBoss: (t) => {
      // Thrown, not dropped. A chunk placed on the boss's own position sits
      // inside the one hitbox in the game you cannot swim into, so the heal
      // would be visible and unreachable. The angle is a full circle — the
      // toss physics already keeps it out of the sky and out of the seabed.
      const at = bossState.enemy.mesh.position;
      const a = Math.random() * Math.PI * 2;
      const speed = CONFIG.chumChunk.boss?.tossSpeed ?? 0;
      dropChumChunk({ x: at.x, y: at.y, z: 0 }, t,
        { x: Math.cos(a) * speed, y: Math.sin(a) * speed });
    },
  });
}

let lastTime = performance.now();

function animate(now) {
  const stamp = now ?? performance.now();
  // LAST frame's totals, read before anything resets them. renderer.info has
  // autoReset off (see world.js), so these have accumulated across every pass
  // post.js made — the scene, the bright pass, the blur ping-pong and the
  // composite — rather than reporting only the last one.
  const drawsLastFrame = world.renderer.info.render.calls;
  world.renderer.info.reset();

  // Handed the STAMP, not rawDt, and deliberately before the clamp below —
  // see systems/perfLog.js. `Math.min(..., 0.05)` is correct for the
  // simulation and would record every hitch in the game as exactly 50ms.
  //
  // The two counters are what let a spike be ATTRIBUTED rather than guessed at.
  // A program appearing means three linked a shader on this frame; a texture
  // appearing means it uploaded an image. Both are one-off costs paid the first
  // time something is drawn, and both are invisible in a profile taken after
  // the fact — but a 400ms frame that coincides with a new program is a
  // different bug from a 400ms frame that coincides with neither.
  // The program LIST as well as the count. The count says how many linked; the
  // list carries each one's cache key, which is what separates "the warm-up
  // missed this material" from "this shader is being rebuilt over and over".
  // See the programBuilds note in systems/perfLog.js.
  perfFrame(
    stamp,
    programsEverBuilt(),
    world.renderer.info.memory.textures,
    heapUsed(),
    world.renderer.info.programs,
  );
  const rawDt = Math.min((stamp - lastTime) / 1000, 0.05);
  lastTime = stamp;

  // A new frame, so every measured hitbox is stale again. Combat asks a boss's
  // shape where it is once per projectile in range and this is what makes all
  // but the first of those a stamp comparison — see systems/hitShape.js.
  tickHitShapes();

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
  // ORDER IS THE TIE-BREAK, and the only thing it decides. Every one of these
  // pushes the playback rates around on every frame it is live, so the LAST
  // one called owns the mix wherever two overlap — and the one whose sequence
  // is longer and louder should win that. Hence: the boss kill shot (a second
  // and a half, and the only one gameplay stays live through) first, the
  // level-up (open for as long as a card is being read) next, the death dive
  // (the end of the run) last.
  //
  // The SCALES stack regardless of order — they are multiplied below — so this
  // is purely about who is writing the rate on a frame where two are.
  // What the kill shot is looking at, handed over before it works out its
  // framing: the seal, the body it just killed (systems/bossCorpse.js keeps
  // one in the water for exactly this), and how big the frame is in world
  // units. This is the only place that knows all three — the shot owns the
  // maths and world.js owns the frustum, and neither can see the other.
  //
  // Only while a shot is up — `player.mesh` is null until the first run is
  // built, and this line runs on every frame the page has drawn since boot.
  if (bossKillState.active && player.mesh) {
    setBossKillFraming(player.mesh.position, bossCorpseFocus(), world.halfExtents(1));
  }
  const killScale = updateBossKill(rawDt);
  const levelScale = updateLevelUpTime(rawDt);
  const deathScale = updateDeathDive(rawDt);
  // The stage's slow motion, multiplied in alongside the other two rather than
  // replacing them — it is a dev tool and has no business arbitrating with a
  // death dive it should never be open during. Its repeat timer ticks inside
  // this call, on the raw clock, so "every half second" stays half a second
  // however far down the time slider is.
  const stageScale = updateStage(rawDt);
  // All four multiplied together. The kill shot is the one gameplay stays LIVE
  // through — the seal can still swim, and the water it is swimming in is what
  // is being dilated — so it has to reach realDt like the rest rather than the
  // gameplay delta below, or the shot would be a slow-motion ocean with a
  // full-speed seal in the middle of it.
  const realDt = rawDt * deathScale * levelScale * stageScale * killScale;

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
  // The kill shot owns the clock for the same reason both of those do, and it
  // is the case that most needs it: the blow that ends a boss is the biggest
  // hit in the game and carries the longest hit-stop, landing on the exact
  // frame this ramp begins. A freeze inside a slow motion is not a freeze, it
  // is a hole in the first tenth of the shot.
  const dt = deathState.active || levelUpState.active || bossKillState.active ? realDt : realDt * timeScale;

  updateInput(world.camera, player.mesh.position);
  // Reads the pad snapshot updateInput just took, so it must follow it. No-op
  // unless G is held.
  updateGamepadDebug();
  // No-op unless the sound feed is up (0). Sits here rather than inside the
  // pause gate so the ambient bed can still be watched from a menu.
  updateSfxDebug();
  // Same deal for the workbench's docked feed — one boolean test per frame
  // while it's shut, and it must keep ticking with the world held.
  updateWorkbench();
  // Start on the pad. BEFORE the two nav calls below: opening the menu
  // re-baselines the menu input, so the same press cannot both pause the game
  // and activate whatever row the cursor opened onto. `canPause` is what keeps
  // Start on the level-up screen doing what it has always done — confirm.
  if (menuInput.pause && (isPauseOpen() || canPause())) togglePause();

  // Same ordering requirement. Outside the pause gate on purpose: the level-up
  // menu is only ever open WHILE paused, so gating this on !paused would mean
  // the pad could never drive it. No-op when no menu is up.
  updateMenuNav();
  // The pause menu's own cursor, on the same poll and for the same reason.
  updatePauseNav();

  // Refill the seal before anything can hurt it, not after. `player.hp <= 0`
  // is tested inline at three points INSIDE this block — the damage handler,
  // the drowning tick and the contact check — each calling killPlayer on the
  // spot, so a top-up at the end of the frame would arrive after the run had
  // already ended. Starting every staged frame from a full pool means the
  // drowning tick and every ordinary hit land on a seal that can absorb them.
  holdStageSafe(player);

  // `stageSimulates()` is the stage's "world only" switch, and it is in the
  // gate rather than being a pause of its own: gameState.paused belongs to the
  // menus, and every branch below is written around what IT means. Nothing
  // that draws an effect lives in here — updateFeedback ran above, and the
  // particles, the camera, the shake and the render are all below — so with
  // this shut the workbench still fires events at a seal that simply isn't
  // swimming.
  if (gameState.running && !gameState.paused && stageSimulates()) {
    // The run clock stops while staging. Not cosmetic: `difficulty` is derived
    // from it, so twenty minutes spent tuning a burst would otherwise bank
    // twenty minutes of difficulty and dump a late-game wave on the seal the
    // moment the panel closed — and the survival time in the playtest record
    // would count time nobody was playing.
    if (!isStaging()) {
      gameState.time += dt;
      gameState.difficulty = gameState.time * CONFIG.spawn.difficultyPerSecond;
    }
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

    // AIR TIME. updatePlayer has just integrated the arc and set breachDir, so
    // this is the first moment the ramp can be current — and it must be current
    // before ANYTHING below reads a multiplier off it: the guns fire further
    // down this same block, and a ramp one frame stale would pay the bonus for
    // an arc the seal has already landed from. See systems/airborne.js.
    updateAirborne(player);

    // ...AND WHAT IT BOUGHT, cashed on the way back through the water line.
    //
    // Deliberately before the Porpoising check below rather than folded into
    // it: the two are different rewards for different halves of the same jump.
    // Porpoising pays for LEAVING (upward crossings, gated on a card); this
    // pays for what you did once you were up there, it is base-game, and it
    // lands on the way DOWN.
    // The event fires on EVERY downward crossing; only the blast underneath it
    // is conditional. Splitting those two was the point — player.js used to
    // fire one `breach` in both directions, so the seal leaving the water and
    // the seal arriving back through it were literally the same event, and the
    // most athletic thing in the game had no landing. It now owns the upward
    // half and this owns the downward one.
    if (player.breachDir < 0) {
      // Downward speed at the water line, as a positive number. Read here
      // rather than inside slamFor so the system stays free of the velocity
      // vector — it is handed numbers, like the rest of it.
      const impact = Math.max(0, -player.velocity.y);
      const slam = slamFor(player, impact);
      const sx = player.mesh.position.x;
      const sy = bounds.surfaceY;

      if (slam && slam.damage > 0 && slam.radius > 0) {
        // Through the same queue every blast in the game uses, so the slam
        // breaks wreckage and takes crew off decks exactly like a pearl or a
        // seagull bomb — and so the damage lands after the loops currently
        // iterating `enemies` (see processPendingSplashes).
        pendingSplashes.push({
          x: sx,
          y: sy,
          damage: slam.damage,
          radius: slam.radius,
          exclude: null,
          source: 'reentry',
        });
      }

      // A crossing under `slam.minRamp` still lands — it just lands as water
      // rather than as an event. Falling back to a speed-only scale rather
      // than skipping the feedback: a seal that dips a flipper through the
      // surface must still make a noise, or the mechanic reads as the splash
      // being broken on small jumps.
      const power = slam ? slam.power : 0;
      // Pitched DOWN by how much air was banked, the same trick the kill
      // sounds use to say how big the thing that died was: a full arc lands
      // audibly heavier than a skim rather than merely louder.
      feedback('reentry', {
        x: sx,
        y: sy,
        dirX: 0,
        dirY: 1,
        vx: player.velocity.x,
        vy: Math.abs(player.velocity.y),
        scale: slam ? slam.scale : Math.min(1, 0.3 + impact / 30),
        sfxOpts: { pitch: 1 / (0.85 + power * 0.4), decayMul: 1 + power * 0.5 },
      });
    }

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

    // ...and where that jump can get you. Real dt, not the gameplay one: the
    // pass fires a hit-stop of its own, and a cooldown that froze along with
    // the frame would be extended by its own feedback. Ungated by the breach
    // above on purpose — the zone is a place, not a move, and a sun sitting on
    // the water line at dawn is reachable by swimming into it.
    //
    // The zone it tests against is one frame old: the sky is drawn from
    // world.updateSurface, at the bottom of this function. That is the same
    // frame of lag the sky's own drift and the grid's already run at, and at a
    // body that moves a fraction of a unit per second it is not a thing that
    // can be measured, let alone felt.
    updateCelestialPass(realDt, {
      x: player.mesh.position.x,
      y: player.mesh.position.y,
      speed: player.velocity.length(),
    }, { onPass: onCelestialPass });

    // Water muffles the mix: the low-pass tracks how deep the player is,
    // opening up as they breach. Inside the pause gate on purpose — while
    // the upgrade screen has it ducked, depth must not sweep it back open.
    updateMusicDepth(player.mesh.position.y);
    // Same idea for the SFX bus, on its own narrower range — see
    // CONFIG.audio.bus.depth. No-op while depth tracking is switched off.
    updateBusDepth(player.mesh.position.y);
    // Where the ear is, for the voice budget to rank sounds by how close they
    // happened. The seal rather than the camera, for the reason the mussel's
    // pan gives below: the camera lags behind it, and a lagging listener would
    // hand the arena's near half a slightly stale idea of where "near" is.
    setSfxListener(player.mesh.position.x, player.mesh.position.y);

    // Breath and wake bubbles, fired from the mouth anchor and off the hind
    // flipper tips and tail that updatePlayer just refreshed. Gameplay dt, not
    // real dt: a hit-stop
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
    //
    // The last argument is where the seal is POINTING, which is the only thing
    // the wind-up vent uses it for: exhaust leaves the back of the animal, and
    // a wind-up is usually a standstill with no travel left to reverse. The
    // art's forward is +Y, hence the quarter turn — same convention as the
    // facing block in updatePlayer.
    const faceAngle = player.mesh.rotation.z + Math.PI / 2;
    faceDir.x = Math.cos(faceAngle);
    faceDir.y = Math.sin(faceAngle);
    updateBubbles(
      dt, player.aimRig, player.velocity, player.aboveSurface,
      CONFIG.strike.enabled && input.strikeHeld ? strikeState.pending : 0,
      faceDir,
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
      lastDamageSource = 'drowning';
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
    updateChumChunkSpawns(dt);

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

    // THE BOWHEAD SWEEP. The clock is fed the live population because the whale
    // is a pressure valve rather than a timer — see systems/whale.js.
    if (updateWhaleClock(dt, enemies.length)) {
      const w = spawnWhale(world.scene);
      // Announced from the edge it entered at, not from the middle of the
      // screen: the whole value of the call is telling you which way it is
      // coming from while there is still time to swim the other way.
      feedback('whaleArrive', { x: w.container.position.x, y: w.container.position.y });
    }
    updateWhales(dt, world.scene, enemies, {
      // The same radius every enemy contact check uses (see the contact pass in
      // entities/enemies.js), not a number of the whale's own — a body you can
      // be shoved by has to be a body you touch at the size you touch
      // everything else at.
      player: { position: player.mesh.position, radius: player.stats?.hitRadius ?? CONFIG.player.hitRadius },
      // THE DASH, so the same contact that shoves the seal can move the whale
      // a little the other way — see CONFIG.whale.ram. Injected rather than
      // imported into whale.js for the reason that file gives about its clock:
      // state the sweep does not own comes in through the hooks, so the whole
      // of it stays drivable from a harness with no strike, no player and no
      // frame.
      ram: {
        dashing: strikeState.active,
        dirX: strikeState.dashDir.x,
        dirY: strikeState.dashDir.y,
        power: strikeState.power,
      },
      // Deliberately NOT onEnemyKilledFeedback. Nothing here is a kill: it
      // does not count toward `gameState.kills`, it earns no combo, it drops no
      // chum and it is not attributed to any ability in the playtest ledger.
      // Same call systems/predation.js makes when a shark eats a fish — that
      // was your meal and something else had it.
      onGulp: (x, y, n) => feedback('whaleGulp', { x, y, scale: Math.min(1.6, 0.8 + n * 0.08) }),
      onOrbsEaten: (x, y, n) => feedback('whaleRobbed', { x, y, scale: Math.min(1.4, 0.8 + n * 0.06) }),
      // Crumbs off an orb WHILE it is being dragged in, the same trickle a
      // feeding crab leaves. Rate-limited here rather than in whale.js because
      // the emitter is tiny by design and a burst per orb per frame across a
      // whole chum pile is a haze, not a trail.
      onOrbHoover: (x, y) => {
        whaleCrumbTimer -= dt;
        if (whaleCrumbTimer > 0) return;
        whaleCrumbTimer = 1 / Math.max(0.1, CONFIG.whale.crumbRate ?? 6);
        feedback('whaleCrumbs', { x, y });
      },
      onSpout: (x, y) => feedback('whaleSpout', { x, y: bounds.surfaceY, scale: 1.1 }),
      onShove: (nx, ny, force, x, y) => {
        applyPlayerKnockback(nx, ny, force);
        feedback('whaleShove', { x, y });
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

    // THE PERFECT CHARGE LANDING — the wind-up fully banked. An edge, consumed
    // once, exactly like chargeCrossed above it: `strikeState.perfect` is a
    // latch that stays true for the rest of the hold, and firing the sound off
    // the latch would play it every frame until the release.
    //
    // The meter is already drawing this (the core pops, see
    // systems/strikeRing.js); what the event adds is the half of it that
    // reaches a player looking at what they are about to hit rather than at
    // their own animal.
    if (perfectCrossed()) {
      feedback('strikePerfect', { x: player.mesh.position.x, y: player.mesh.position.y });
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
      // How fast the seal was ACTUALLY travelling as the button came up. Read
      // before tryStrike, because the impulse below overwrites the velocity with
      // the dash's — and the release burst inherits this one on purpose: it is
      // the water the wind-up was held in being let go of, so it drifts with
      // whatever drift there was. Inheriting the launch instead would fire the
      // whole shell out the front as a single streak.
      const releaseVx = player.velocity.x;
      const releaseVy = player.velocity.y;
      const fired = (dir.x !== 0 || dir.y !== 0) && tryStrike(dir, player.stats);
      if (fired) {
        // The first-run "hold to charge, release to strike" tip, answered. On
        // `fired` and not on the release: a release that had no direction or no
        // meter behind it did not teach anything, and clearing the tip on one
        // would leave a player who mashed the button once having been shown the
        // sentence and never the thing.
        noteTutorialEvent('strike');
        // "STRIKE NOW!", obeyed. Taken off the ring on the frame the dash
        // launches rather than left to age out: every other callout describes a
        // STATE and can sensibly linger a moment after it clears, but this one
        // is an instruction, and an instruction still on screen after it has
        // been followed reads as the game not having noticed.
        clearCallout(CALLOUTS.get('strikeNow'));
        // THE FOOD CHAIN LINK, if this release earned one — a bar refilled
        // since the last strike, spent again before the window shut. Scored
        // inside tryStrike (the strike system owns the counter) and reported
        // here, first, so the banner and the hit-stop land on the same frame as
        // the dash rather than trailing it. Ahead of the impulse for the same
        // reason onChainHit fires before the kill events: hit-stop is rate
        // limited globally and the extension is the bigger of the two things
        // happening.
        const rel = consumeStrikeLink();
        // Filed whether or not it scored, WITH which condition failed. A log of
        // links alone cannot tell "never strikes" from "strikes constantly and
        // never links", and the first time this was asked about there was no
        // chain data in the run log at all.
        playtest.recordStrike(rel.depth, rel.hadFood, rel.hadWindow, rel.sweet);
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

        // THE POP. The strike's damage, all of it, at the point the button
        // came up — see strikeBurst() and CONFIG.strike.burst for why it lives
        // here rather than on whatever the dash clips.
        //
        // Queued through the same splash path every blast in the game uses, so
        // it breaks wreckage and takes people off decks exactly like a pearl
        // or a seagull bomb does, and so the damage lands after the loops that
        // are mid-iteration over `enemies` (see processPendingSplashes).
        //
        // Taken at the seal's position as it is RIGHT NOW. The dash impulse
        // above has set the velocity but nothing has integrated it yet
        // (updatePlayer runs later in the frame), so this is still the point
        // the player released at rather than somewhere the dash has already
        // carried them — which is the whole promise of the mechanic.
        {
          const burst = strikeBurst(player.stats);
          if (burst.damage > 0 && burst.radius > 0) {
            const bx = player.mesh.position.x;
            const by = player.mesh.position.y;
            pendingSplashes.push({
              x: bx, y: by,
              // Air time on the strike's own damage, like the gun's. Damage
              // only, not radius: reach is what the player is aiming with, and
              // a blast that silently grew every time they were high up would
              // make the one number they aim by unpredictable.
              damage: burst.damage * airDamageMul(),
              radius: burst.radius,
              exclude: null,
              source: 'strike',
              // Its own event, not the splash queue's `bigKill`: this fires on
              // EVERY strike, and bigKill is a heavy, hit-stopping bang meant
              // for something dying.
              feedback: false,
            });
            feedback('strikeBurst', {
              x: bx, y: by,
              scale: 0.6 + strikeState.power * 0.9,
            });
            // Bodies caught in it are thrown OUTWARD, which is the difference
            // between a detonation and damage happening in a circle. Separate
            // from the ram's shove, which runs along the dash instead.
            const knock = (CONFIG.strike.burst.knock ?? 0) * strikeState.power;
            if (knock > 0) {
              for (const e of enemies) {
                const dx = e.mesh.position.x - bx;
                const dy = e.mesh.position.y - by;
                const d2 = dx * dx + dy * dy;
                if (d2 > burst.radius * burst.radius) continue;
                // Falling off toward the rim, or a body at the edge of the
                // blast leaves as fast as one standing on top of it and the
                // whole thing reads as a circle of wind rather than a bang.
                const falloff = 1 - Math.sqrt(d2) / burst.radius;
                applyKnockback(e, dx, dy, knock * falloff);
              }
            }
          }
        }

        // The full-charge payoff. Reads `power` — the banked amount this dash
        // was actually bought with — rather than the meter, which tryStrike
        // has already zeroed by now.
        launchMusselBarrage(strikeState.power);
        // Same beat, same reading of `power`. Placed after the burst above so
        // the clubs leave into an arena the blast has already shoved apart,
        // and after the MARK the ram just painted — the seeker prefers a
        // painted target, so a dash that rams a shark then throws at it is one
        // gesture rather than two.
        launchClubThrow(strikeState.power);

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
        // ...and the vent letting go, on the same frame. The wind-up has been
        // pouring bubbles out the back of the seal for as long as the button was
        // down; this is the pressure behind them leaving all at once, as a shell
        // in every direction that is gone in a third of a second. Silent and
        // shakeless — `strike` above owns those channels for this frame (see
        // CONFIG.feedback.strikeVent).
        //
        // Scaled by the power actually spent, so a flick puffs and a full
        // commitment bursts, and dragged along by the velocity the seal had
        // BEFORE the impulse above.
        feedback('strikeVent', {
          x: player.mesh.position.x, y: player.mesh.position.y,
          vx: releaseVx, vy: releaseVy,
          scale: 0.5 + strikeState.power * 0.9,
        });
        player.anim?.trigger('strike'); // roll clip, auto-returns to locomotion
        // The rim blows off the body as the banked power leaves it — the top of
        // the pulse that has been building for the whole wind-up. Scaled by the
        // power actually spent, so a fizzle pops and a full commitment
        // detonates. See CONFIG.strike.charge.outline.
        flarePlayerOutline(strikeState.power);
        // ...and the eyes, from the same frame and scaled by the same power.
        // Deliberately here rather than at the end of the dash: the wind-up is
        // what has been building, so the pop belongs where the building stops.
        flareEyeLights(strikeState.power);

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
      } else if (canAirJump(player)) {
        // THE MID-AIR RELAUNCH — the double jump, on the release that would
        // otherwise have done nothing at all.
        //
        // This branch is reachable exactly when the seal is airborne and the
        // strike DIDN'T fire, which is almost always "not enough banked to
        // reach minFire". That is the whole design: there is no second button
        // and there should not be one, because the strike already IS the
        // seal's launch and a second verb for the same idea is one more thing
        // to learn for nothing. Spending an air jump here turns a fumbled
        // release in the air into the most useful thing you can do with one.
        //
        // It costs no charge, on purpose. The bar is the food chain's economy
        // (see systems/strike.js) and taking from it would mean every jump was
        // a link you didn't score; the air jump has its own budget, refilled
        // by re-entry, and `airJumps` is a scaling property in its own right.
        const jump = spendAirJump(player, dir);
        if (jump) {
          player.velocity.x = jump.vx;
          player.velocity.y = jump.vy;
          // The dash's own ceiling for a moment, for exactly the reason the
          // strike impulse needs it: updatePlayer clamps to maxSpeed before
          // the position ever integrates, so without this the launch is cut
          // back to swimming speed on the very next frame and the jump goes
          // nowhere. Short — this is an impulse, not a dash.
          player.dashTimer = Math.max(player.dashTimer, 0.12);
          if (jump.invuln > 0) player.invuln = Math.max(player.invuln, jump.invuln);
          // Rolled like a strike, and for the same reason: a body launching
          // itself should look like it committed to it. Half the turns, since
          // this is the cheaper move.
          player.anim?.trigger('strike');
          feedback('airJump', {
            x: player.mesh.position.x,
            y: player.mesh.position.y,
            dirX: -jump.vx,
            dirY: -jump.vy,
            // Later jumps in the same breach are worth more (they stack into
            // the ramp), so they read louder — the sound is the readout of a
            // resource being spent down.
            scale: 0.7 + player.airJumps * 0.25,
            sfxOpts: { pitch: 1.15 + player.airJumps * 0.12 },
          });
        }
      }
    }

    updateProjectiles(
      dt, world.scene, enemies,
      // `source` because this callback fires for ANY projectile with bounces
      // left, not just Ricochet Rounds — scallop shells carom off walls too.
      // Without it the hive credited every scallop bounce to Ricochet Rounds.
      (x, y, p) => feedback('bounce', { x, y, source: p.source, ...bounceComboFx(p) }),
      (p) => feedback('scallopJet', { x: p.mesh.position.x, y: p.mesh.position.y, dirX: -p.dir.x, dirY: -p.dir.y }),
      // A pearl that times out in open water still cracks. Queued rather than
      // burst inline for the same array-mutation reason as everything else in
      // pendingBursts — this runs inside the projectile loop.
      (p) => { if (p.burst) pendingBursts.push({ x: p.mesh.position.x, y: p.mesh.position.y, burst: p.burst }); },
    );
    // Nothing new arrives while the stage is open. Creatures already in the
    // water keep swimming and breathing — freezing them would take the scene's
    // life away with its traffic, and the seal is what an effect is being
    // judged against, not an empty tank. Clear on the panel empties it.
    if (!isStaging()) updateSpawning(dt, gameState, world.scene);
    // Right after the ordinary spawner, and on the same terms: it is a spawn
    // trigger, it only fires while the run is actually running, and it stops
    // with everything else when the level-up cards are up.
    updateBoss(dt, gameState, world.scene);
    // ...and then whatever that boss's perk does. Must sit between updateBoss
    // and updateEnemies: a perk writes the velocity the integrator inside
    // updateEnemies will step, so running it afterwards would land a frame
    // late and be overwritten by the boss's own steering before it moved
    // anything. See systems/bossPerks.js.
    //
    // Handed the same onPlayerHit resolveCombat gets, so an electric aura goes
    // through the same i-frames, the same shove and the same playtest
    // accounting as a bite rather than being a second, quieter way to lose hp.
    // The seal's own eyes, BEFORE updateBeams so a beam lit this frame is
    // resolved on the frame it was asked for rather than the next one.
    setLaserAim(input.aim);
    // The rig goes in so the beams leave the eye sockets the orbs are sitting
    // in rather than a point near the middle of the body — see the origin note
    // in systems/laserEyes.js. Null on a model with no eye bones, which puts
    // that file back on its old body-relative offset.
    updateLaserEyes(
      dt, world.scene, player.mesh.position, player.stats.laserEyesLevel, input.aim,
      player.aimRig,
    );
    // The beams the perks above just lit — and, once the seal owns a pair, its
    // own. AFTER the perk update so a beam ignited this frame is placed, drawn
    // and resolved on the same frame it was asked for: a frame of lag here is a
    // line that visibly trails the head it comes out of.
    updateBeams(dt, world.scene, {
      enemies,
      playerPos: player.mesh.position,
      // The same radius resolveCombat measures a bite against, not a number
      // typed here — the seal's hitbox grows with upgrades and a beam that used
      // a constant would drift out of agreement with every other contact test.
      playerRadius: player.stats.hitRadius,
      hooks: {
        onEnemyDamaged: damageFrom('beam'),
        onEnemyKilled: onEnemyKilledFeedback,
        // Through the same i-frames every other source of player damage goes
        // through, for the reason the perk hook below says: a beam should not
        // be the one attack in the game that ignores the seal's only defensive
        // window.
        onPlayerHit: (dmg, dir, source) => { if (!isInvulnerable()) onPlayerHit(dmg, dir, source); },
      },
    });
    updateBossAbilities(dt, world.scene, player.mesh.position, {
      // The i-frame check is here rather than inside the perk, for the same
      // reason resolveCombat does it at each of its own damage sites: a dash
      // through an aura should be a dash through an aura, not the one attack
      // in the game that ignores the seal's only defensive window.
      onPlayerHit: (dmg, dir, source) => { if (!isInvulnerable()) onPlayerHit(dmg, dir, source); },
    });

    // WHAT THE SCHOOLS SEE COMING. Small fish break away from a strike — the
    // wind-up scatters them in proportion to how much is banked, the dash
    // itself at full strength — so a shoal has to be led rather than swum at.
    // See the fright term in the swarm behaviour.
    //
    // Written every frame rather than imported by enemies.js, which would wire
    // a cycle: systems/strike.js already imports removeEnemy from there. The
    // heading is the SAME strikeDirection() the release and the lens corridor
    // use, so the fish flee the line the dash would actually take.
    {
      const winding = CONFIG.strike.enabled && input.strikeHeld && strikeState.pending > 0;
      const aim = strikeState.active
        ? strikeState.dashDir
        : strikeDirection(input.move, input.aim, dashPrediction);
      setStrikeThreat({
        active: strikeState.active || winding,
        x: player.mesh.position.x,
        y: player.mesh.position.y,
        dirX: aim.x,
        dirY: aim.y,
        power: strikeState.active ? strikeState.power : strikeState.pending,
        dashing: strikeState.active,
      });
    }

    updateEnemies(dt, world.scene, player.mesh.position, (x, y) => {
      feedback('chumEaten', { x, y, scale: 0.8 });
    }, (x, y, e) => {
      // Crumbs pulled off an orb on its way into a mouth. Thrown back along
      // the eater's own motion so they stream off the food rather than puffing
      // out of it — a shark hoovering on the pass leaves a wake of scraps.
      feedback('chumHoover', { x, y, vx: -e.vx, vy: -e.vy, scale: 0.7 });
    }, (x, y, e) => {
      // THE CHOMP, and the only place it is fired: a set of jaws closing on the
      // seal. Ambient feeding is `preyEaten` and is silent — see the note on
      // CONFIG.feedback.bite.
      feedback('bite', { x, y, vx: e.vx, vy: e.vy });
    });

    // THE PHYSICS FRAME. Everything that owns a body (the boats above, the sea
    // turtle in the pass just now) has already moved itself, so this is where
    // the shove on top of that motion is integrated, where two bodies find out
    // they are in the same place, and where the result reaches the meshes.
    // Last on purpose — running it earlier would resolve collisions against
    // positions the owners then overwrite.
    stepBodies(dt, {
      // A hull taking a real hit from a real body: the punted turtle arriving,
      // or the hull that turtle just shoved arriving at the next one. The
      // solver has already bounced them both; this is the damage and the
      // noise. Two hulls means BOTH take it, which is the chain paying out.
      onImpact: (hit) => {
        let dealt = 0;
        if (hit.a.kind === 'boat') dealt += impactBoat(world.scene, hit.a, hit, { onBoatDestroyed });
        if (hit.b.kind === 'boat') dealt += impactBoat(world.scene, hit.b, hit, { onBoatDestroyed });
        if (dealt > 0) playtest.recordDamage('impact', dealt, null);
        // Scaled by how hard it landed, so a turtle nudging a hull at drift
        // speed is a knock and one arriving off a full-charge punt is an
        // event. Capped, or a chain reaction stacks four screen shakes.
        feedback('bodyImpact', { x: hit.x, y: hit.y, scale: Math.min(1.6, 0.5 + hit.speed / 24) });
      },
    });

    resolveCombat(dt, world.scene, {
      // Bullets, mussels, ricochets, starfish and shrapnel all land here; the
      // projectile carries the tag that tells them apart.
      onEnemyDamaged: (e, dmg, x, y, dir, projectile, at) => {
        playtest.recordDamage(projectile?.source ?? 'gun', dmg, e);
        onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile, at);
      },
      onProjectileChained: (p, x, y) => feedback('bounce', { x, y, ...bounceComboFx(p) }),
      onPlayerHit,
      onEnemyKilled: onEnemyKilledFeedback,
      onBoatHit: (boat, dmg, x, y, projectile) => {
        playtest.recordDamage(projectile?.source ?? 'gun', dmg, boat);
        // Hulls aren't in the `enemies` array, so they need the same mussel
        // branch spelled out here — `boat.mesh.name` is the asset key ('boat'
        // or 'trawler'), which is what the colour is read from.
        // Hulls are long boxes, so their enclosing radius overstates them —
        // halved, or a mussel on a trawler blooms across half the screen.
        // STEEL, under whichever impact plays. A hull is the one target in the
        // game that rings when it is hit, and it is the only readout the player
        // gets that a boat is a different KIND of thing from a tough fish —
        // every boat, not only the boss, because they are all the same steel.
        bossVoice('hit', boat.assetKey ?? boat.mesh?.name, { x, y, scale: 1.1 });
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
      // --- harp seal --------------------------------------------------------
      // A note landing and its charm taking. Fired from here rather than from
      // systems/harp.js because the charm happens where the NOTE lands, and by
      // then the harp has swung several metres round its ring. Only fires when
      // the charm actually took — a note that hit a boss did damage and nothing
      // else. Counted as control alongside the beluga and the dumbo.
      onCharmed: (e, x, y) => {
        playtest.recordControl('harp');
        // The sting is the CHARM's, and a note that landed on a boss did not
        // charm anything — it dazed it, and the daze has its own louder event
        // fired from the drain below. Two of them on the same frame is the
        // mud the whole one-event-per-moment rule exists to avoid. The control
        // record above still goes to the harp either way: the note is what
        // bought the moment, whichever shape it took.
        if (e.charmTimer > 0) feedback('harpCharm', { x, y, scale: 1.2 });
      },
    });
    processPendingSplashes(); // safe now that resolveCombat's own loop has finished

    // Elemental statuses — venom and infection ticking, chill thawing, the
    // contagion creeping to neighbours, and the bursts queued by any infected
    // host that died during combat above. Placed here for exactly the reason
    // the splash queue is drained here: this both damages and REMOVES enemies,
    // and doing that inside resolveCombat's own loop would shift the array
    // under it.
    // The seal wears the element it rolled — see updateElementSkin. Cheap: one
    // uniform write for the breath, and the rest only when the level or the
    // time of day has moved. Raw dt, like every other glow: the seal's own
    // light doesn't hold its breath because a hit froze the game for 60ms.
    updateElementSkin(player.body, rawDt);
    // ...and the meter, on the same markings through a second, independent
    // glow layer. Two layers rather than one because the element's early-outs
    // at level 0, and the charge read has to exist on every run — see the note
    // on setNoiseChargeGlow in systems/noiseShader.js.
    updateChargeSkin(player.body, strikeState.charge, rawDt);
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
      // A bubble giving out — either a bomblet going off or a held shell
      // letting its creature go. Its own event so the burst and its sound can
      // be tuned against the catch rather than being welded to it.
      onPop: (x, y) => feedback('belugaPop', { x, y }),
      // The lobbed cluster coming apart into bomblets. Scaled up, because
      // `trapPop` is authored for one small bubble failing and this is the big
      // one that carried them all.
      onSplit: (x, y) => feedback('belugaSplit', { x, y, scale: 1.4 }),
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
        // Same split the harp's charm makes below: a pulse that landed on a
        // boss dazed it rather than charming it, and the daze fires its own
        // event from the drain further down. The pulse stays credited here
        // either way.
        if (e.charmTimer > 0) {
          feedback('dumboCharm', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.1 });
        }
      },
    });
    updateHarp(dt, world.scene, player.mesh.position, player.stats.harpLevel, enemies, {
      onPluck: (x, y, dirX, dirY) => feedback('harpPluck', { x, y, dirX, dirY }),
      // The note ring. Its own source tag rather than folding into 'harp', so
      // the playtest report can answer the question the card actually raises —
      // is the charm carrying this, or is it just a slow homing shot?
      onEnemyDamaged: damageFrom('harpAura'),
      onEnemyKilled: onEnemyKilledFeedback,
      // Louder the more the ring caught, capped — a grinder parked in a school
      // should read bigger than one clipping a straggler, but not six times
      // bigger.
      onAuraTick: (x, y, count) => feedback('harpAura', { x, y, scale: Math.min(1.8, 0.7 + count * 0.2) }),
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
      // The moment one of them leaves the line, which is the read the card is
      // selling and was completely silent — the pod's only voice was the hit,
      // two seconds and half an arena later. Same event the escort seals use
      // for the same beat (see onLunge above): a wind-up at the animal that
      // broke formation, not at whatever it is going after.
      onBreakOff: (x, y) => feedback('sealLunge', { x, y, scale: 1.4 }),
      onBoatHit: (boat, dmg, x, y) => feedback('orcaStrike', { x, y, scale: 1.3 }),
      onCrewEaten: (x, y) => feedback('crewEaten', { x, y, scale: 0.9 }),
      onBoatDestroyed,
    });
    // Same ordering rule as the grabber below — a thrown body's position is
    // written directly, so this has to come after enemies.js has integrated
    // the frame. It also has to come after the aim rig has posed the flippers
    // (that happens in updatePlayer), since the fin tips are where the clubs
    // hang and a stale tip swings the weapon from where the fin USED to be.
    updateClub(dt, world.scene, player.mesh.position, {
      club: player.stats.clubLevel,
      boom: player.stats.clubBoomLevel,
      ice: player.stats.clubIceLevel,
      // Passed for the LOOK, not for any behaviour of the swing: it decides
      // whether a fin is holding a Hurler club. The throw itself is fired from
      // the strike release, not from here.
      throw: player.stats.clubThrowLevel,
    }, enemies, {
      rig: player.aimRig,
      // The VELOCITY, not the speed: the clubs stream out behind the direction
      // of travel, so the heading is half the input.
      velocity: player.velocity,
      dashing: strikeState.active,
    }, {
      onEnemyDamaged: damageFrom('club'),
      onEnemyKilled: onEnemyKilledFeedback,
      onWhack: (x, y, rate) => feedback('clubWhack', {
        x, y,
        // A club turning at speed hits harder-sounding than one drifting round
        // at the idle rate. Same swing, same damage — this is the weapon
        // telling you that moving is what powers it.
        scale: Math.min(1.5, 0.7 + rate * 0.05),
        sfxOpts: { pitch: Math.min(1.35, 0.9 + rate * 0.03) },
      }),
      // Pitch climbs per link and volume falls, the same shape the eel's chain
      // uses: a long carom is an ascending run of clacks receding into the
      // crowd, so how far the body travelled is audible off-screen.
      onRicochet: (x, y, i) => feedback('clubRicochet', {
        x, y,
        scale: Math.max(0.5, 1 - i * 0.12),
        sfxOpts: { pitch: 1 + i * 0.08 },
      }),
      // Powder Keg. Scaled by how many the blast actually caught, so a keg
      // that went off in a crowd reads heavier than one that popped on a lone
      // crab — and throttled, because with two clubs swinging this can fire
      // several times a second.
      onBlast: (x, y, radius, caught) => {
        feedback('clubBoom', { x, y, scale: Math.min(1.6, 0.7 + caught * 0.15) });
        world.grid.ripple(x, y, 2, radius * 2);
      },
      // Cold Snap, but only the moment a body actually LOCKS. The per-hit
      // chill has no event of its own on purpose: it lands on every club hit
      // and would be a second sound under the whack that already played.
      onFreeze: (x, y) => feedback('clubFreeze', { x, y }),
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

    // EVERY STATUS THAT LANDED ON A BOSS THIS FRAME, announced in one place.
    // Drained here, after every ability that can throw one has run, because the
    // whole point of the daze is that it is ONE event whichever of the six
    // threw it — a harp note, an octopus pulse and a saturating freeze all buy
    // the same two seconds, and they must not each teach the player a different
    // picture of it. The abilities themselves stay silent about it: none of
    // them knows the conversion happened. See systems/control.js.
    for (const e of consumeDazes(dazedThisFrame)) {
      feedback('bossDaze', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.3 });
      // Its own callout rather than the ability's, for the same reason: the
      // sentence the player needs is about the boss, not about which card did
      // it.
      world.grid.ripple(e.mesh.position.x, e.mesh.position.y, 4, e.radius * 3);
    }

    // Strike system: chain-hit damage, charge recharge, and the orb timer.
    const { spawnOrb } = updateStrike(dt, world.scene, player.mesh.position, player.stats, enemies, {
      onEnemyDamaged: (e, dmg) => {
        playtest.recordDamage('strike', dmg, e);
        onEnemyDamagedFeedback(e, dmg);
        // Shrapnel rides the NOMINAL strike rather than the `dmg` the ram
        // actually dealt — see riderDamage() in systems/strike.js. A base ram
        // is a chip, and fragments scaled to a chip would make Bone Shrapnel a
        // card that does nothing until four other cards have been taken.
        spawnShrapnel(e.mesh.position, riderDamage(dmg, player.stats));
      },
      // THE SHOVE LANDING. Its own event because the ram is no longer a
      // damage-shaped thing: the hit feedback above is sized by damage, and a
      // five-point chip that visibly throws a shark across the screen needs to
      // sound like the throw, not like the chip.
      // `at` is where the dash actually connected: on a measured body that is
      // the point on its skin, and on everything else it is the point on the
      // circle nearest the seal. Either is better than the creature's origin,
      // which is what this used before — a ram into a megalodon's tail used to
      // flash six units away, in the middle of an animal that is sixteen long.
      onRam: (e, power, at) => {
        feedback('strikeRam', {
          x: at?.x ?? e.mesh.position.x,
          y: at?.y ?? e.mesh.position.y,
          scale: 0.7 + power * 0.7,
        });
      },
      onMarked: (e) => {
        feedback('strikeMark', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 0.8 });
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
      // ONE PIP OF THE METER FILLING. Drained from a queue inside the strike
      // system on its own floor (see notePips), not fired per orb — a magnet
      // sweep swallows six inside one frame, and this arrives as a rising run
      // rather than as a chord.
      //
      // The pitch IS the reading: it climbs across the bar, so where you are
      // relative to full is audible without looking, and the pip that closes
      // the ring is the top of the run.
      onPip: (index, total) => {
        feedback('strikePip', {
          x: player.mesh.position.x,
          y: player.mesh.position.y,
          sfxOpts: { pitch: 1 + (index - 1) * (0.9 / Math.max(1, total)) },
        });
      },
    });
    if (spawnOrb) spawnStrikeOrb(world.scene, randomArenaPoint());

    // The barrage's remaining shells, thrown a few frames apart from wherever
    // the seal has got to. Immediately after updateStrike so the queue drains
    // on the same clock the dash advances on — the whole point of the stagger
    // is that the two are the same gesture.
    updateMusselVolley(dt);

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

      // AND INTO THE HULLS. A seal arriving at a boat at dash speed knocks it
      // around — the hull jumps, rolls and settles, without going over: a boat
      // capsizes when it SINKS and not before (see the roll clamp in
      // systems/boats.js). The damage is a token; what the ram is really for
      // is the MARK it leaves, which is what turns a boat the seal can barely
      // scratch into the thing the pod and the mussels go for.
      //
      // Here rather than in updateStrike for the same reason the wreckage pass
      // is: the strike system knows about creatures. The "once per dash" guard
      // is the strike's own (claimDashHit), because unlike a debris chunk a
      // hull has no invulnerability window and would otherwise take a hit on
      // every frame the seal spent inside it.
      for (let i = boats.length - 1; i >= 0; i--) {
        const boat = boats[i];
        if (!hitsBoat(boat, player.mesh.position.x, player.mesh.position.y, player.stats.hitRadius)) continue;
        if (!claimDashHit(boat)) continue;

        const at = { x: player.mesh.position.x, y: player.mesh.position.y };
        jostleBoat(boat, strikeState.dashDir.x, strikeState.dashDir.y, strikeState.power, at);
        feedback('strikeRam', { x: at.x, y: at.y, scale: 1 + strikeState.power * 0.5 });
        if (markTarget(boat, { isBoat: true, radius: boat.halfLength })) {
          feedback('strikeMark', { x: boat.mesh.position.x, y: boat.mesh.position.y, scale: 1.2 });
        }

        const dmg = player.stats.strikeDamage
          * powerDamageMul()
          * (CONFIG.boats.hitReaction.strike?.damageMul ?? 0.6);
        if (dmg > 0) {
          playtest.recordDamage('strike', dmg, boat);
          damageBoat(world.scene, i, dmg, { onBoatDestroyed }, strikeState.dashDir, at);
        }
      }
    }

    // A BODY IN THE WATER. The seal eats one on contact, and it pays out
    // through the same collectChum every orb goes through — so the xp, the
    // heal, the charge meter and the food chain all land exactly as they do
    // for chum, because it IS chum, just a large piece of it.
    {
      const meal = nearestFloatingCrew(
        player.mesh.position.x, player.mesh.position.y, player.stats.hitRadius);
      if (meal) {
        const at = eatCrew(world.scene, meal, {
          vx: player.velocity.x, vy: player.velocity.y,
        });
        if (at) {
          collectChum(at.xp, at.x, at.y, at.healMul);
          feedback('crewEaten', { x: at.x, y: at.y });
          // MANEATER. Counted on every meal whether or not the card is held —
          // the total is what the card is worth the moment it IS taken, and a
          // count that only started on the pick would make an early Maneater
          // strictly better than a late one for reasons the player can't see.
          //
          // The recompute is the whole mechanic: the bonus lives in the stat
          // block (see applyDamageScaling in stats.js), so the block has to be
          // rebuilt for a meal to be worth anything. Gated on the card because
          // this is the only place in the game that would rebuild it during
          // play rather than on a level-up, and a run without Maneater has no
          // reason to pay for that.
          player.humansEaten += 1;
          if (player.stats.maneaterLevel > 0) {
            recomputeStats();
            // The readout is MEASURED off the same function the damage
            // multiplier comes out of (stats.js), not recomputed here — the
            // line on screen and the number in the stat block cannot disagree.
            feedback('maneaterProc', { x: at.x, y: at.y, toastValue: maneaterReadout(player.stats, player.humansEaten) });
          }
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
      // Silent — see CONFIG.feedback.preyEaten. A shark eating a fish is
      // something to look at, not something to hear over your own fight.
      onFishEaten: (fish, pred) => {
        feedback('preyEaten', { x: fish.mesh.position.x, y: fish.mesh.position.y, vx: pred.vx, vy: pred.vy });
      },
      // A hunter taking a body out of the water. The player gets nothing for
      // it — that was their meal and something else had it.
      onCrewEaten: (x, y) => feedback('crewEaten', { x, y, scale: 0.9 }),
    });

    updatePickups(
      dt, world.scene, player, collectChum,
      (x, y) => {
        // The first-run tip for THIS orb, answered here and nowhere else.
        // There is one tip per pickup type and each is spent by taking its own
        // kind — a shared event would mean the first orb a player swam into
        // silently marked off the other four.
        noteTutorialEvent('strikeOrb');
        // The blue orb skips the wind-up entirely: a full meter, instantly.
        // If that fill lands inside a combo it reaches the chain the same way
        // chum does — through the meter, which is the only route orbs have.
        const filled = restoreCharge(player.stats);
        feedback('levelUp', { x, y, scale: 0.6 });
        // One pickup, one mouthful — so it links exactly like a chum orb does
        // inside an armed chain. Without this the one pickup that hands over a
        // whole bar would be the one that could not extend the chain.
        const orbChain = consumeChainLink();
        if (orbChain) {
          playtest.recordChainLink(orbChain);
          onChainHit(orbChain, 'chumEaten');
        }
        if (filled) chainFrom('chumFull');
        // An orb fills the bar outright, so it crosses to full unless it
        // already was — same flash as the mouthful that tops it off.
        if (filled) chargeCrossed();
      },
      (x, y) => {
        noteTutorialEvent('bubbleOrb');
        // ...AND IT FEEDS THE METER. Every orb in the water now pays into the
        // strike bar, not just the blue one: the meter is the game's second
        // currency and a pickup that ignored it read as a pickup for a
        // different game. The blue orb fills it outright (that is its whole
        // identity); the other two pay a FRACTION, so they are a top-up rather
        // than a substitute for eating. See CONFIG.strike.orbPipRefill.
        if (addCharge(CONFIG.strike.orbPipRefill?.bubble ?? 0.25, player.stats)) chargeCrossed();
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
        noteTutorialEvent('rapidFireOrb');
        rapidFireTimer = CONFIG.rapidFirePickup.duration;
        // Same top-up as the bubble — see the note there. Slightly bigger,
        // because this orb is rarer.
        if (addCharge(CONFIG.strike.orbPipRefill?.rapidFire ?? 0.35, player.stats)) chargeCrossed();
        feedback('levelUp', { x, y, scale: 1.1 });
      },
      // A CHUNK GOING DOWN. Health only, and this is the one pickup in the game
      // that pays no xp and no charge: it is already the largest single thing
      // the water can hand you, and letting it also level you and fill the
      // strike bar would make the rest of the economy something you wait out.
      // It is a break, not a jackpot.
      (chunk) => {
        noteTutorialEvent('chumChunk');
        const x = chunk.mesh.position.x;
        const y = chunk.mesh.position.y;
        player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.maxHp * chunk.healFrac);
        feedback('chumChunkEaten', {
          x, y,
          scale: 0.7 + 1.3 * chunk.t,
          // Bigger chunks land lower. Same reading the bubble uses, and it is
          // the size of the piece rather than the size of the need: what a
          // chunk sounds like is a property of the chunk, and the player has
          // already been told which one this is by looking at it.
          sfxOpts: { pitch: 1.2 - 0.4 * chunk.t },
        });
      }
    );
    // Straight after the orbs, because it is the same currency arriving a beat
    // late: whatever the last mouthful was too big to pay at once.
    updateXpSpill(dt);
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

    // rawDt, not dt: the hp/air gauges are the player's read-out and must not
    // be dilated along with the water. See the note on updateHUD.
    updateHUD(gameState, player, strikeState, rapidFireTimer, world.camera, rawDt);
    // Null while there is no boss, which is most of a run — the bar hides
    // itself rather than the loop having to know it exists.
    updateBossBar(bossBanner());
  } else if (deathState.active) {
    // The run is over, but the ocean isn't. Just enough of the sim to keep the
    // water populated while the body goes down: creatures keep swimming (and
    // keep hunting each other), and shots already in the air finish their
    // flight. Deliberately no combat, no spawning, no pickups and no abilities
    // — nothing the seal does or that is done to it, since it's dead. Same
    // dilated `dt` as everything else, so the whole scene sinks together.
    //
    // Nothing to be afraid of any more. Cleared explicitly because the block
    // that writes it is in the branch above: without this the schools would
    // spend the whole descent fleeing the last strike a dead seal wound up.
    setStrikeThreat(null);
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
    // The ear follows the body down too, for the same reason: the death pile is
    // still spawning and eating around it, and those sounds should rank against
    // where the seal actually is rather than where it was when it died.
    setSfxListener(player.mesh.position.x, player.mesh.position.y);
    resolvePredation(dt, world.scene, {
      // Silent — see CONFIG.feedback.preyEaten. A shark eating a fish is
      // something to look at, not something to hear over your own fight.
      onFishEaten: (fish, pred) => {
        feedback('preyEaten', { x: fish.mesh.position.x, y: fish.mesh.position.y, vx: pred.vx, vy: pred.vy });
      },
      // A hunter taking a body out of the water. The player gets nothing for
      // it — that was their meal and something else had it.
      onCrewEaten: (x, y) => feedback('crewEaten', { x, y, scale: 0.9 }),
    });
  } else if (gameState.paused && (levelUpState.active || isPauseOpen())) {
    // The level-up freeze. Nothing above ran, so no creature steers, hunts,
    // bites, spawns or scavenges and no shot travels — the fight is stopped
    // dead where it stands, which is the whole point of the beat.
    //
    // What still moves is the pose: the mixers tick on the dilated clock so
    // the ocean is full of animals breathing on the spot rather than a
    // freeze-frame. The seal gets the same treatment a few lines down, in the
    // block that idles it behind every other menu.
    //
    // The pause menu is in here for consistency rather than for drama. Three
    // things are visibly still moving behind it whatever this line says — the
    // water, the sky and the seal's own idle, all of which run on the wall
    // clock by design — so a roster frozen solid in the middle of them reads
    // as the animals having crashed, not as the game being paused.
    animateEnemiesIdle(realDt);
  } else if (!stageSimulates()) {
    // The world held still: the stage with its simulation switched off, or the
    // bare freeze (K) that is the same thing without the panel. Same treatment
    // and for exactly the same reason as the level-up freeze above: the water,
    // the sky and the seal's own idle all keep moving on the wall clock
    // regardless, so a roster frozen solid among them reads as a crash rather
    // than as a held world. Anything left in the arena goes on breathing where
    // it stands while you fire events at it — or look at it.
    //
    // The `isStaging()` test that used to be here is gone rather than widened:
    // stageSimulates() is false in exactly these two cases and true whenever
    // the run is over, so asking it alone is asking the real question.
    animateEnemiesIdle(realDt);
  }

  // Toasts run on REAL time, outside the pause gate, so the numbers from the
  // kills that triggered a level-up finish rising instead of hanging frozen
  // behind the upgrade screen.
  updateToasts(realDt);

  // ---------------------------------------------------------------------------
  // THE WARNING BAND AND THE FIRST-RUN TIPS — systems/callouts.js.
  // ---------------------------------------------------------------------------
  // REAL TIME AND OUTSIDE THE PAUSE GATE, for the same reason the toasts are:
  // a warning that fired on the frame a level-up landed has to finish rather
  // than freeze behind the cards, and the one tip that fires ON the card
  // screen has to be able to move at all.
  //
  // Two different notions of "live", and they are not the same gate:
  //
  //   WARNINGS need a running, unpaused seal. There is no such thing as being
  //   low on air on the score card, and a band over a menu is an alarm about a
  //   fight nobody is in.
  //
  //   TIPS need a running seal and nothing else. The level-up screen sets
  //   `paused`, and "pick an upgrade" is precisely the tip that fires there —
  //   gating it the same way would retire the one step that has a menu of its
  //   own to talk about.
  const bandLive = gameState.running && !deathState.active;
  const calloutCfg = CONFIG.callouts ?? {};
  const o2Frac = player.oxygen / Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen.max);
  const hpFrac = player.hp / Math.max(1, player.stats.maxHp);
  const oxygenLow = !!CONFIG.oxygen.enabled && o2Frac < (calloutCfg.oxygenLow ?? 0.25);
  // The charge meter, read once, for the DENIED press below. Its sibling —
  // "STRIKE NOW!" — reads strikeLoaded() instead and no longer re-derives the
  // same reading here; see the note by it.
  //
  // `strikeBanked` is minFire and not "anything at all", because a release
  // under that threshold fires nothing (tryStrike) and KEEPS the pending power
  // — so a fumbled release leaves the seal holding a sliver it cannot spend,
  // and calling that a denied press would be scolding a player mid-wind-up.
  const chargeEmpty = strikeState.charge <= (calloutCfg.boostEmpty ?? 0.02);
  const strikeBanked = strikeState.pending >= (CONFIG.strike.charge.minFire ?? 0.2);
  // A press against a dead meter. One frame by construction, so it cannot hold
  // its own callout up — the row's `hold` is what keeps it on screen.
  const boostDenied = CONFIG.strike.enabled && input.strike && chargeEmpty && !strikeBanked;
  // The sound is fired here rather than from the callout system, which has no
  // audio in it on purpose (it is driven by a headless harness). Gated on the
  // same liveness as the line it accompanies, or an empty-meter press on the
  // score card would blip at a player who is not in a fight.
  if (boostDenied && bandLive && !gameState.paused) {
    feedback('boostEmpty', { x: player.mesh.position.x, y: player.mesh.position.y });
  }
  updateCallouts(realDt, {
    // The held breath before a boss and the ceremony after it are one
    // continuous stretch (boss.js hands off between them inside a single
    // frame), so this is one crossing and therefore one "Warning!".
    boss: bossState.hushing || bossState.arriving,
    health: hpFrac < (calloutCfg.healthLow ?? 0.3),
    oxygen: oxygenLow,
    // TWO DIFFERENT THINGS AN EMPTY METER CAN MEAN, and they want opposite
    // sentences. Both live on the seal (callouts.csv, `anchor`), so neither is
    // competing with the band above for the eye.
    //
    //   STRIKE NOW!  the wind-up has nothing left to bank and a fireable
    //                strike already in hand. Nothing is wrong: the meter is
    //                empty because it has all become power, and every extra
    //                frame of holding is doing nothing at all. What the player
    //                needs is not "you are out of boost" — which reads as a
    //                scolding for playing correctly — it is LET GO.
    //
    //                AND IT IS THE SWEET SPOT'S OWN MOMENT. strikeLoaded() is
    //                what tryStrike times the release against, so this is not
    //                advice about the mechanic, it IS the mechanic's clock
    //                drawn on the ring. Spelling the test out here instead —
    //                which is what this line used to do — left the two free to
    //                disagree, and the window is a tenth of a second wide.
    //   Boost Empty! there is nothing banked and nothing to bank. Fires on the
    //                PRESS (`input.strike`, one frame) rather than on the hold,
    //                because that is the moment the fact is news: they asked
    //                for a strike and the game gave them nothing. Held down, it
    //                would nag for as long as a finger stayed on a button that
    //                was never going to answer.
    strikeNow: strikeLoaded() && input.strikeHeld,
    boost: boostDenied,
  }, bandLive && !gameState.paused);

  updateTutorial(realDt, {
    runTime: gameState.time,
    // Which steps this player gets at all — the movement tip only exists on a
    // touchscreen. Same call as the one the drawing makes, one frame apart at
    // most, so a step can never be offered under one device and worded for
    // another.
    device: inputDevice(),
    // The three control tips, one per input, in the order a player acquires
    // them. All three read the ASSEMBLED input rather than the hardware, which
    // is what lets one step cover a thumb, a stick and a key at once.
    moving: input.move.lengthSq() > 0.01,
    aiming: input.aiming,
    // The button being down, not a strike landing: the tip asks them to CHARGE
    // one, and holding it is the whole of what it asked for.
    charging: input.strikeHeld,
    oxygenLow,
    aboveSurface: player.aboveSurface,
    airTime: player.airTime ?? 0,
    // Distance below the waterline, so "near the surface" is one comparison
    // whatever the arena has been resized to.
    nearSurface: (bounds.surfaceY - player.mesh.position.y) <= (CONFIG.tutorial?.nearSurface ?? 12),
    chumInWater: pickups.length > 0 || chumChunks.length > 0,

    // THE LAST THREE ARE GETTERS, and that is the whole of why they cost
    // nothing. Each one walks an array — up to 140 pickups, up to 220 creatures
    // — and this object is built on every frame of every run for the rest of
    // the game's life, where the questions are only ever asked on a first run:
    // updateTutorial returns before touching the ctx once the set is finished,
    // so a getter is simply never called after that. As plain fields they would
    // be three array scans a frame, forever, to answer nobody.
    //
    // Written as getters rather than as functions because the STEPS should read
    // like the ones above them — a step asks what is true, and whether the
    // answer took a scan to find is this file's problem and not the coach's.

    // WHICH PICKUP, not whether there is one — there is a tip per type and
    // they do five unrelated things. A function rather than five getters
    // because the coach asks about one kind at a time and the steps that ask
    // are themselves generated from a table (see PICKUP_TIPS in tutorial.js);
    // five fields here would be that table written out a second time. Passed
    // by reference, like nearestChum below, rather than written inline — this
    // object is rebuilt every frame of every run and a closure literal here
    // would be an allocation per frame forever.
    pickupInWater,
    // Is a combo window open? The one moment "strike then keep eating" is an
    // instruction rather than a description.
    feeding: isFeeding(),
    // Chum that has reached the floor — the same count the crab spawner reads,
    // and deliberately the same one: the tip is a warning about exactly the
    // condition that summons a wave, so a second definition of "on the seabed"
    // here would be a tip that fires when no crab is coming, or doesn't when
    // one is.
    get chumOnSeabed() { return countFloorPickups() > 0; },
    // A turtle, or the whale, close enough to be looked at. The two live in
    // completely different systems — one is an enemy with a flag, the other is
    // its own thing that was never an enemy at all — and the player has no idea
    // there is a difference, which is why one tip covers both.
    get unkillableNear() {
      const range = CONFIG.tutorial?.showRange ?? 22;
      if (whaleDistance(player.mesh.position.x, player.mesh.position.y) <= range) return true;
      const r2 = range * range;
      for (const e of enemies) {
        if (!e.invincible && !e.def?.invincible) continue;
        const dx = e.mesh.position.x - player.mesh.position.x;
        const dy = e.mesh.position.y - player.mesh.position.y;
        // Its own body counts as reach, so a big shell is "near" from further
        // out than a small one — the same reasoning whaleDistance uses.
        const reach = range + (e.radius ?? 0);
        if (dx * dx + dy * dy <= Math.max(r2, reach * reach)) return true;
      }
      return false;
    },
    // How a tip finds the thing it is about, and how it keeps hold of it. Both
    // by reference — see takeSubject above.
    takeSubject,
    subjectAt,
  }, bandLive);

  // WHATEVER THE TIP IS ABOUT, LIT. Driven from the coach's own subject every
  // frame rather than from the five places a tip can start, so there is exactly
  // one answer to "what is being explained right now" and nothing can be left
  // glowing after the sentence that lit it has gone.
  //
  // 'paint' is the mode for the floating power-ups, which have no brightness
  // writer of their own; the chum orbs and the chunks are on 'ask' and multiply
  // it into the glow they already write. See systems/telegraph.js.
  setTelegraph(tutorialState.subjectMesh, telegraphModeFor(tutorialState.active));
  updateTelegraph(realDt);

  // REAL time, like the callouts and for the same reason: a diagnostic that
  // froze behind the upgrade cards would be blank at exactly the moment you
  // want to read what just happened.
  updateChainDebug(player.stats);
  updateCalloutUi(realDt, {
    camera: world.camera,
    playerX: player.mesh.position.x,
    playerY: player.mesh.position.y,
    // Handed over as the function, and called only on the frames an arrow is
    // actually pointing at chum. Re-asked every one of those frames rather than
    // latched when the tip started: the nearest bite changes as the seal swims
    // and as crabs carry pieces off, and an arrow still pointing at an orb that
    // has been eaten is worse than no arrow.
    nearestChum,
    // Same deal, and the same reason it is the function and not a position —
    // except this one is asked WHICH KIND, because the row that wants the arrow
    // is one of five and each points at its own orb. See arrowTarget.
    nearestPickup,
    surfaceY: bounds.surfaceY,
    // The top of the seabed rather than bounds.bottom: the floor plane hangs a
    // skirt below that line to cover the death dive's camera overshoot, so
    // bounds.bottom is under the sand and an arrow aimed there points past the
    // place the tip is talking about.
    seabedY: seabedTopY(),
    // Which wording a line with more than one is read in. Asked for here, at
    // the point of drawing, rather than latched at the start of the run: a pad
    // picked up mid-run should change the words on the very next frame.
    device: inputDevice(),
    // And what to call the buttons on it, for a line that names one.
    tokens: inputTokens(),
    // WHERE A WORLD-ANCHORED TIP IS SPOKEN, and how far through leaving it is.
    // Both are the coach's, read straight off its state rather than recomputed
    // here: the drawing must be looking at the same subject the coach is
    // holding, or a tip could dissolve beside one bubble while ending because a
    // different one was collected.
    tipAnchor: tutorialState.anchor,
    tipFade: tutorialState.fade,
  });

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
    // `engaged` is normally false here — nobody is shooting on a menu — with
    // the one exception of the title card, where the whole shot IS the aim: at
    // `idleWeight` the flippers keep most of the swim clip and only gesture at
    // the cursor, which reads as the seal ignoring you. See systems/titleSeal.js.
    updateAimRig(
      realDt,
      // The MENU'S aim when it has one, which is the cursor remapped through
      // the bust's own spread — a seal stood upright has its neck cone pointing
      // at the sky, and handed the raw `input.aim` it tracks a wedge above its
      // own head and stares blankly through the rest of the screen. See
      // bustAim in systems/splashBust.js.
      deathState.active ? null : (mainMenuAim() ?? input.aim),
      titleSealEngaged() || mainMenuEngaged(),
      0,
      deathState.active,
    );
  }

  // THE VICTORY LAP, and it goes here for two reasons.
  //
  // LAST, because it is the last word on the pose: the mixer and the aim rig
  // both write an absolute pose every frame, so anything posing on top of them
  // has to run after both or it is simply overwritten (same ordering rule as
  // systems/crabClaw.js). Outside the pause gate too, alongside the strike
  // ring, since the seal keeps celebrating over a level-up card.
  //
  // On rawDt, because the kill shot it is posing for drops the world to 0.12x:
  // on the dilated clock the pose would advance about a tenth of a second by
  // the time the trophy frame is grabbed and would never once be caught in a
  // picture. The camera push in systems/bossKill.js is on the wall clock for
  // exactly the same reason.
  updateCelebration(rawDt);
  player.celebrate?.update(rawDt);

  // `player.stats` so the ring knows how many pips the bar is cut into —
  // Coiled Spring changes that mid-run, and a ring reading the CONFIG default
  // would keep drawing five segments on a bar that now fills in three.
  updateStrikeRing(realDt, player.mesh.position, strikeState, gameState.running, player.stats);
  // The seal's own rim, throbbing through a wind-up and flaring on the release.
  // Outside the pause gate alongside the ring, and on real time for the same
  // reason: the pulse is a readout of a button being held, and a hit-stop
  // freezing it mid-throb would read as the charge having stalled. The wind-up
  // argument goes to 0 the moment a run isn't live, which eases the rim back to
  // its tuned look on the game-over screen instead of leaving it lit.
  // THE WIND-UP, computed once and handed to both readouts that show it. It
  // follows the BUTTON rather than `strikeState.charging`, which goes false
  // the instant the bar runs dry — the tell must not cut out halfway through a
  // hold the player is still committing to, it plateaus at whatever was
  // banked. It goes to 0 the moment a run isn't live, which eases the rim and
  // the eyes back to rest on the game-over screen instead of leaving them lit.
  //
  // One local rather than two copies of the expression: the rim and the eyes
  // are two readings of ONE thing, and they drifted apart the moment they were
  // written twice.
  const windUp = gameState.running && !gameState.paused && CONFIG.strike.enabled && input.strikeHeld
    ? strikeState.pending
    : 0;
  updatePlayerOutline(realDt, windUp);
  // Real time, like the ring above: the indicator is a readout of where you
  // are pointing RIGHT NOW, and a hit-stop must not freeze it a frame behind
  // the cursor. The guns run themselves, so this reads autofire rather than a
  // trigger — otherwise the beam would sit at idle opacity for a whole run.
  updateAimIndicator(
    realDt, player.mesh.position, input.aim,
    CONFIG.weapon.autofire,
    gameState.running && !gameState.paused,
  );
  // The eyes. Real time and outside the pause gate, like the ring and the
  // indicator above: they are a readout of a head that is still pointing
  // somewhere, and a hit-stop that froze them would read as the seal having
  // blinked. The sockets themselves only move when the rig solves, so a paused
  // seal simply keeps its stare.
  //
  // The gate is being ALIVE rather than the run being live — the orbs stay lit
  // through the level-up cards and the pause menu, and go out over a beat when
  // the seal dies rather than switching off on the frame of the bite.
  updateEyeLights(realDt, player.aimRig, { lit: deathState.active ? 0 : 1, charge: windUp });
  // ...and the same system on whatever is hunting it. Real time and outside
  // the run gate for the same reasons as the seal's, and fed the live enemy
  // list rather than a list this file keeps: a boss can die, be removed and
  // have its visual recycled between two frames, and a tracked list would
  // hold the corpse. See systems/bossEyes.js.
  updateBossEyes(realDt, world.scene, enemies.filter((e) => e.isBoss));
  updateProjectileTrails(realDt, world.scene, projectiles);
  // The RGB smear the seal drags through the air. Real time, like the trails
  // above and for the same reason: the cloud is weather, and a hit-stop that
  // froze it mid-billow would leave a kink in the paint. Outside the run gate
  // entirely — the particles have to go on drifting and dying through the
  // game-over screen rather than vanishing on the frame the seal dies mid-arc.
  //
  // The ramp is recomputed here rather than read off the singleton: this runs
  // outside the pause gate, where the singleton is whatever the last live frame
  // left in it, and a paused seal hanging in the air would otherwise stamp full
  // brightness onto everything laid down behind the menu.
  //
  // The last argument is the emit gate, and it is the one thing here that DOES
  // respect the run: drifting and dying belong to the air, but laying down new
  // particles belongs to the seal, and a seal frozen behind the level-up cards
  // isn't moving. Without it, eighty-five particles a second would all be born
  // at the same coordinates and stack into one bright blob — and a corpse would
  // go on painting its way down through the death dive.
  //
  // ONE CALL, BOTH TRAILS. The same system also draws the white swim ribbon
  // underwater — see the profiles at the top of systems/breachTrail.js. Which
  // one is being written is decided in there from the seal's height and speed;
  // everything passed from here means the same thing to both.
  //
  // The last argument is the strike WIND-UP, which stretches and brightens
  // whichever trail is drawing for as long as the hold lasts — the telegraph.
  // It is the same expression the bubble vent uses (see updateBubbles above),
  // deliberately: it follows the BUTTON rather than `strikeState.charging`,
  // because charging goes false the instant the bar runs dry and the tell must
  // not cut out halfway through a hold the player is still committing to. It
  // plateaus at whatever was banked instead.
  updateBreachTrail(
    realDt, world.scene, player, airRamp(player),
    gameState.running && !gameState.paused,
    CONFIG.strike.enabled && input.strikeHeld ? strikeState.pending : 0,
  );
  // The ink the kraken leaves in the water — the breach trail's mirror, and it
  // sits here for exactly the same reasons. Real time, because the cloud is
  // water and a hit-stop that froze it mid-billow would leave a kink in it.
  // Outside the run gate, because ink has to go on churning and dissolving
  // after the boss dies and through the game-over screen; a cloud that vanished
  // on the kill frame would undo the one thing that makes it ink.
  //
  // The last argument is the emit gate, and it is the one thing here that DOES
  // respect the run: drifting belongs to the water, laying down new ink belongs
  // to the animal, and a boss frozen behind the level-up cards is not moving.
  // Without it a whole second of cloud stacks at one coordinate.
  //
  // The player is passed only so the ink can keep a readable bubble around the
  // seal — see CONFIG.inkTrail.clearRadius, without which a boss whose entire
  // job is filling the arena eventually makes the game unplayable rather than
  // hard.
  updateKrakenInk(
    realDt, world.scene, player,
    gameState.running && !gameState.paused,
  );
  // Real time, like the trails and the particles above: a hit-stop shouldn't
  // stall a shell that's still in the air, and the flash it triggered has to
  // keep easing out rather than freezing mid-bloom on the frame it landed.
  // The seal is the listener rather than the camera, since the camera lags
  // behind it and a lagging listener smears the pan.
  updateProjectileVoices(realDt, projectiles, player.mesh.position, gameState.running && !gameState.paused);
  updateImpactFlashes(realDt);
  // Real time, for the same reason as the flashes: an impact effect that
  // freezes during its own hit-stop is the one thing guaranteed to be on
  // screen while everything else is held, and holding it too reads as a stall.
  // This is also what drags each wound along with the bone it is stuck to.
  updateBossImpacts(realDt);
  // The wreckage of the last boss, and the one effect here that runs on the
  // GAMEPLAY clock rather than the wall one: it is part of the world the kill
  // shot is slowing down, and chunks hanging almost still in the dilated water
  // while the frame holds on the seal is most of what the held beat has in it.
  // Outside the run gate so a wreck still settles over a death — a player who
  // dies in the same breath they win should not have the debris vanish — but
  // frozen behind a menu like everything else the player can look at.
  updateBossGibs(gameState.paused ? 0 : dt);
  // The same clock and the same gate, for the same reasons: pieces of a man
  // sink on their own schedule rather than the eater's, so they keep settling
  // over a death, and they hold still behind a menu.
  updateGore(gameState.paused ? 0 : dt);
  // And the body the wreckage is still inside. Two clocks, both of them
  // needed: the countdown to the burst is racing a shutter and so runs on the
  // WALL clock, while the drift, the sink and the roll are the world's and run
  // on the dilated one. Paused, the body holds — it is something the player
  // can look at, like everything else above.
  updateBossCorpses(rawDt, gameState.paused ? 0 : dt);
  // The cloud a boss goes up in. The WALL clock, and it is the whole design:
  // the rings are born already at their radius so the bloom can happen across
  // an ocean the kill shot has frozen at a tenth speed — on the dilated clock
  // the last ring would arrive several seconds after the photograph it exists
  // to be in. Not gated on the pause: a menu opened inside the third of a
  // second this takes would otherwise leave a half-finished explosion parked
  // over the frame until it closed.
  updateBossBooms(rawDt);
  updateHitShapeDebug();
  // The lock-on reticles. Real time, like the flashes above: a mark is a
  // countdown the player is reading off the screen, and a hit-stop that froze
  // the pulse would make it look like the lock had dropped. The level-up
  // freeze DOES stop it, though — a lock quietly expiring behind the card
  // screen would be the menu taking something off the player.
  updateMarks(gameState.paused ? 0 : realDt);
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
  // And the objects that do, which is a different mechanism for a different
  // problem: a creature's glow is a pattern generated across its body, this is
  // an asset's own texture pushed into its emissive slot and scaled on the beat
  // (the yacht's rolls of cash). Same clock, same raw dt, and after
  // updateBeatSync for the same reason everything above it is.
  updateEmissivePulse(rawDt);

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
  // The death shot: the frame closes in on the body and rides it down. Claimed
  // per frame, immediately before the camera update that consumes it — the
  // dive owns the timing, world.js owns the framing maths (and the clamp that
  // keeps the view inside the ocean).
  // The kill shot's push-in, claimed the same way and on the same frame terms.
  // BELOW the death dive's claim so a death that lands inside a victory takes
  // the frame off it — a claim is last-writer-wins, and of the two shots only
  // one has a run riding on it.
  // The level-up salute's snap zoom, claimed on the same terms and FIRST of
  // the three, because a claim is last-writer-wins and both of the others
  // outrank it: a boss dying grants levels, so the two genuinely overlap, and
  // the shot of the thing you just killed is the one worth keeping.
  if (levelUpState.camWeight > 0) {
    world.focusCamera(player.mesh.position, levelUpState.camZoom, levelUpState.camWeight);
  }
  if (bossKillState.active) {
    // NOT the seal's position: the kill shot frames the seal AND the body it
    // just killed, and publishes the point between them it settled on. See
    // applyFraming in systems/bossKill.js. The seal is the fallback for the
    // one frame a shot exists without having been framed yet — a boss dies
    // below this line, so the frame it dies on has last shot's point in it.
    world.focusCamera(
      bossKillState.framed ? bossKillState.cam : player.mesh.position,
      bossKillState.camZoom,
      bossKillState.camWeight,
    );
  }
  if (deathState.active) {
    world.focusCamera(player.mesh.position, deathState.camZoom, deathState.camWeight);
  }
  // The title card's push-in, claimed the same way and by the same rules. It
  // can never overlap either of the two above — there is no run to die in while
  // the card is up — and it goes last of the three anyway, because its own
  // release deliberately runs on over the first second of a run.
  //
  // This call also poses the seal's body toward the cursor. That happens here,
  // one step after the aim rig solved further up the frame, so the neck and
  // flippers are solving against the body orientation this wrote last frame —
  // a lag the crane already accepts by design (see poseBody in
  // entities/player.js) and the alternative to posing the body twice.
  updateTitleSeal(realDt, world);
  // ...and the menu's, which is the same kind of claim and lives at the same
  // point in the frame for the same reason: it poses the body on top of a rig
  // that has already solved, and it claims the camera before updateCamera
  // consumes it.
  //
  // THIS RUNS THROUGH THE OPENING SECOND OF A RUN. It is not gated on there
  // being no run — that IS the transition, and cutting it off at startGame
  // would put the cut back exactly where it was taken out.
  //
  // `pad` is off while the settings panel is in front of the menu: updatePauseNav
  // is already spending the pad's confirm on that frame, and one press must not
  // also squash the hexagon behind the row being read.
  if (mainMenuActive()) mainMenu()?.update(realDt, { pad: !isPauseOpen() });
  // The stage parks the shot on the seal, and records where it is so a staged
  // event fires ON the seal rather than at wherever the world origin happens
  // to be. Unconditional — the position has to be current the moment the panel
  // opens, and a claim is only made while it is actually staging. AFTER the
  // dive's claim so it wins the frame if both are somehow live, and before
  // updateCamera, which consumes the claim and clears it.
  parkStageCamera(world, player.mesh.position);
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
  // Scaled by the player's Screen shake setting LAST, at the point the camera
  // actually moves, rather than where each event's shake is accumulated. The
  // events feed a decaying pool that several systems add to and one (the
  // strike wind-up) claims as a level — scaling on the way in would mean the
  // setting changed how that pool decays as well as how far the camera goes,
  // and turning shake off would quietly change the tremble's timing.
  const shake = (feedbackState.shake + feedbackState.sustainShake) * shakeScale();
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

  // Draws and pixels, alongside the gameplay counts. Read BEFORE post.render,
  // so these are last frame's totals — a frame behind, which at 60fps is
  // invisible and is the only way to report the number without splitting the
  // render in two.
  //
  // `draws` is the one number that says whether a crowded frame is expensive
  // because of what is IN it; `Mpix` is the one that says it is expensive
  // because of how big the window is. They move independently, and telling
  // them apart by eye is otherwise guesswork: resizing the window changes the
  // second and not the first.
  const info = world.renderer.info.render;
  const mpix = (world.renderer.domElement.width * world.renderer.domElement.height) / 1e6;
  // The worst frame of the last two seconds, and how many of those were
  // dropped ones. The instantaneous fps to its left cannot show either: a
  // hitch IS one frame, so by the time the eye reaches the number the frame
  // that caused it has already been averaged away. This is the pair to watch
  // while sweeping a slider — `fps` says whether it is fast, `worst` says
  // whether it is smooth, and they move independently.
  const pw = perfWindow();
  setTunerMeta(
    `${Math.round(1 / Math.max(realDt, 0.0001))} fps · worst ${pw.worstMs.toFixed(0)}ms · ${pw.hitches} drops · ${info.calls} draws · ${mpix.toFixed(1)} Mpix · ${enemies.length} enemies · ${projectiles.length} shots · ${particleCount()} bits · ${flightVoiceCount()} voices`
  );
  post.render(world.scene, world.camera, realDt);

  // THE TROPHY, and it has to be here — on the line after the draw, inside the
  // same frame. The renderer runs without `preserveDrawingBuffer` (see
  // world.js), so the colour buffer is the browser's to throw away the moment
  // this task yields: a grab from a timer, a promise or the next frame comes
  // back blank. One frame per boss killed, and only while the kill shot is
  // holding — see systems/bossShot.js.
  if (bossKillShotDue()) {
    const meta = {
      name: bossState.name,
      // What finished it, already resolved to a weapon's own name — see
      // bossState.killedBy, which is written on the frame the boss died and is
      // the only record of it by the time this runs.
      cause: bossState.killedBy,
      // Whose run this is, read once here rather than when a card is drawn.
      // playerName() and not loadPlayerName(): this is a caption, so it wants
      // the trimmed, never-blank reading — a print titled with an empty string
      // is a print with a hole in it, and 'Seal' is the game's own voice for a
      // player who never typed one.
      player: playerName(),
      level: gameState.level,
      score: gameState.score,
      time: gameState.time,
    };
    // And out it comes. Only on a grab that actually produced an image — a
    // tainted canvas or a lost context returns false, and a print of nothing
    // popping into the middle of the screen is a worse failure than the
    // missing trophy it is trying to announce. The kill shot has already
    // bought the slow motion this plays over (see printPhaseSeconds), so the
    // ocean is held until the print reaches the corner.
    if (captureBossShot(world.renderer.domElement, meta)) {
      // The kept shot rather than `meta`, because it carries the SQUARE crop
      // as well as the numbers — and that is what decides which polaroid the
      // player sees: with it, the Rive artboard draws the print; without it,
      // the coded paper does. Everything else on it is the same run.
      const kept = bossShot();
      showSnapshotPrint(kept?.url, kept ?? meta);
    }
  }
}
