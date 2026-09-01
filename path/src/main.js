import * as THREE from 'three';
import { CONFIG, loadTuningFromStorage, saveTuningToStorage, xpForNextLevel, chumHealRamp } from './config.js';
import { preloadAssets, initModelTranscoder, restoreUploadedModels, applySavedAssetLooks, assetBaseColor, setEmissiveMapsEnabled, applyNoiseSettings, applyToonSettings, applyGrassSettings, applyBiolumSkinSettings, applyBubbleShellSettings, applyChromeSettings, clearVisualPool, getAssetSizeMultiplier, assetShapeRadius, assetCensusItems, visualPoolCount } from './assets.js';
import { updateGrassSway } from './systems/grassSway.js';
import { updateBiolumSkin, setBiolumSkinVariant } from './systems/biolumSkin.js';
import { updateEmissivePulse } from './systems/emissivePulse.js';
import { pulseDemoFor, panDemoFor, resolvedGlow, describeGlow } from './systems/glowDebug.js';
import { updateBeatSync } from './systems/beatSync.js';
import { reseatDecor } from './systems/decor.js';
import { scatterSeabed, reseatSeabed } from './systems/seabedScatter.js';
import { markDeathSite, plantGraves, updateGravesites, reseatGraves, restyleGraves, restoreGraves, setGraveImpact } from './systems/gravesite.js';
import { createWorld } from './world.js';
import { midWater, bounds, seabedTopY } from './arena.js';
import {
  initInput, updateInput, clearPendingInput, inputDevice, inputTokens, input, menuInput,
} from './input.js';
import { player, initPlayer, resetPlayer, updatePlayer, updateAimRig, recomputeStats, addUpgrade, levelableUpgrades, applyRecoil, applyPlayerKnockback, rebuildShipBody, snarePlayer } from './entities/player.js';
import { projectileCount, orbiterCount, maneaterReadout } from './stats.js';
import { xpAllowance, spillStep } from './xpSpill.js';
import { aoe, targeting, abilityDamage } from './systems/scaling.js';
import { updateElements, onEnemyKilled as onElementalHostKilled, resetElements, clearStatuses, updateElementSkin, invalidateElementSkin, elementHitEvent, surgeElement, activeElement, elementColor, finElements } from './systems/elements.js';
import { FLIPPER_SIDES } from './flipperSide.js';
import { updateFinLights, resetFinLights, finLightColor } from './systems/finLights.js';
import { consumeDazes, resetControl } from './systems/control.js';
import { updateCelestialPass, resetCelestialPass } from './systems/celestialPass.js';
import { enemies, updateSpawning, updateEnemies, animateEnemiesIdle, resetEnemies, removeEnemy, spawnNamed, nightlifeWeight, setStrikeThreat, applyKnockback, spawnBaitBall, devBaitBallSpec, setSpawnLevel, spawnOpeningShoal } from './entities/enemies.js';
import { noteBaitLoss } from './systems/baitBall.js';
import { updateBoss, updateBossAbilities, resetBoss, bossBanner, bossEntering, bossState, capBossDamage } from './systems/boss.js';
import { updateAttractorStorm, resetAttractorStorm } from './systems/attractorStorm.js';
import { tryBossGrab, updateBossGrab, resetBossGrab } from './systems/bossGrab.js';
import { noteShove, updateSlam, resetSlam } from './systems/slam.js';
import { updateDodge, resetDodge } from './systems/dodge.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from './entities/projectiles.js';
import { isLaser, latticePayload } from './loadout.js';
import { LASER_ASSET, applyBoltLook, boltColor, updateBoltGlow, disposeFinLaser } from './systems/finLaser.js';
import { updatePickups, resetPickups, spawnXpOrb, spawnStrikeOrb, spawnBubbleOrb, spawnRapidFireOrb, spawnLevelOrb, spawnChumChunk, gulpPickups, setChumDifficulty, flushPickupInstances, nearestChum, nearestPickup, pickupTypeInWater, countFloorPickups, chumRadiusOf, pickupEntry, pickupEntryAlive, chumEntry, chumEntryAlive, nearestFloorPickup, bubbleBirthPoint, pickups, chumChunks, bubbleOrbs } from './entities/pickups.js';
import { stepBubbleSpawner, rollBubbleSpawnDelay } from './systems/oxygenBubble.js';
import { levelOrbColor } from './systems/levelOrb.js';
import { updateChumChunkSpawner, resetChumChunkSpawner } from './systems/chumChunkSpawner.js';
import { initParticles, updateParticles, resetParticles, updateParticleScale, particleCount, emit } from './entities/particles.js';
import { resolveCombat } from './systems/combat.js';
import { resolvePredation } from './systems/predation.js';
import { initFeedback, feedback, updateFeedback, feedbackState, addSustainedShake, bossVoice, setToastSink, onFeedback } from './systems/feedback.js';
import { initAudio, unlockAudio, prefetchSamples, applyAudioBusSettings, applyPlayerAudioSettings, updateBusDepth, resetRepetition, setSfxListener, audioBankBytes } from './systems/audio.js';
import { initHaptics, stopHaptics } from './systems/haptics.js';
import { createPost } from './systems/post.js';
import { loadNoteGlyphs } from './systems/noteStorm.js';
import { warmShaders, warmPipeline } from './systems/shaderWarmup.js';
import { installBossWarmup } from './systems/bossWarmup.js';
import {
  installLevelUpWarmup, beginLevelUpWarmup, tickLevelUpWarmup,
  cancelLevelUpWarmup, resetLevelUpWarmup,
} from './systems/levelUpWarmup.js';
import {
  perfFrame, perfRunStart, perfRunReport, perfWindow, perfSummary, perfPhase, perfMark,
  perfFrameJs,
} from './systems/perfLog.js';
import { showLoading } from './ui/loading.js';
import { createGarlicVisual, updateGarlic, resetGarlic } from './systems/garlic.js';
import { createShrimpRingVisual, updateShrimpRing, resetShrimpRing } from './systems/shrimpRing.js';
import { createClubVisual, updateClub, resetClub, fireClubThrow, clubHitFx, clubTrailMovers } from './systems/club.js';
import { fireMusselBarrage, updateMusselVolley, resetMusselVolley } from './systems/musselVolley.js';
import { companionStrikeBonus, companionStrikeCount } from './systems/companionStrike.js';
import { strikeState, tryStrike, restoreCharge, addCharge, updateStrike, updateCharge, feedChum, resetStrike, comboSpeedMul, chainStrike, chainXpMul, liveChain, isFeeding, strikeDirection, riderDamage, claimDashHit, powerDamageMul, strikeBurst, strikeReach, consumeStrikeLink, consumeChainLink, isInvulnerable, perfectCrossed, strikeLoaded, chainWindowLeft, pipCount, pipValue } from './systems/strike.js';
import { stateForSpeed } from './systems/animation.js';
import { emitPoint, emitPointCount } from './systems/aimRig.js';
import { updateBubbles, resetBubbles } from './systems/bubbles.js';
import { updateDayCycle, resetDayCycle, advanceClock, dayState, setNightLock, nightLockedAt } from './systems/daylight.js';
import { updateWeather, resetWeather } from './systems/weather.js';
import { lightningStrikes } from './systems/lightning.js';
import { updateOxygenFx, resetOxygenFx } from './systems/oxygenFx.js';
import { updateLowHealthFx, resetLowHealthFx } from './systems/lowHealthFx.js';
import { playerDamageFx, updatePlayerDamageFx, resetPlayerDamageFx } from './systems/playerDamageFx.js';
import { updateProjectileTrails, clearProjectileTrails } from './systems/projectileTrails.js';
import { updateAirborne, resetAirborne, airRamp, airDamageMul, airFireRateMul, canAirJump, spendAirJump, slamFor } from './systems/airborne.js';
import { fireReentrySplash, updateReentrySplash, resetReentrySplash } from './systems/reentrySplash.js';

// The seal's silhouette, in world units, for the ring of foam a landing throws
// (see systems/reentrySplash.js). Box3 rather than a hit shape because the
// player has none — hit shapes are an enemy thing — and rather than the def
// radius because that is one number for an animal that is three times longer
// than it is deep.
//
// setFromObject on a SKINNED body measures the bind pose, not the current one.
// That is the right answer here and worth saying so nobody "fixes" it: this
// wants how much water the animal displaces, which is a property of the
// animal, and a per-frame figure would make the same jump throw a different
// amount of water depending on where the swim cycle happened to be.
const _extentBox = new THREE.Box3();
const _extentSize = new THREE.Vector3();
function measurePlayerExtent(p) {
  if (!p?.mesh) return null;
  _extentBox.setFromObject(p.mesh);
  if (_extentBox.isEmpty()) return null;
  _extentBox.getSize(_extentSize);
  return { rx: _extentSize.x / 2, ry: _extentSize.y / 2 };
}
import { updateBreachTrail, clearBreachTrail } from './systems/breachTrail.js';
import { updateKrakenInk } from './systems/kraken.js';
import { updateProjectileVoices, clearProjectileVoices, flightVoiceCount } from './systems/projectileVoices.js';
import { initImpactFlashes, updateImpactFlashes, clearImpactFlashes, spawnImpactFlash } from './systems/impactFlash.js';
import { initMusselShells, updateMusselShells, clearMusselShells, spawnMusselShell } from './systems/musselShell.js';
import { initBossImpacts, updateBossImpacts, clearBossImpacts, spawnBossImpact } from './systems/bossImpact.js';
import { initBossHotSpots, updateBossHotSpots, resetBossHotSpots, liveHotSpots, hotSpotLit, hotSpotPoint, drainHotSpotChum, drainHotSpotShoves } from './systems/bossHotSpots.js';
import { initBossGibs, updateBossGibs, resetBossGibs, spawnBossGibs } from './systems/bossGibs.js';
import { initGore, updateGore, resetGore } from './systems/gore.js';
import { tickHitShapes, initHitShapeDebug, updateHitShapeDebug } from './systems/hitShape.js';
import { createStrikeRing, updateStrikeRing, resetStrikeRing } from './systems/strikeRing.js';
import { updateChargeSkin, chargeCrossed, resetChargeSkin, invalidateChargeSkin } from './systems/chargeSkin.js';
import { initMarks, updateMarks, resetMarks, markTarget } from './systems/marks.js';
import { createAimIndicator, updateAimIndicator, resetAimIndicator } from './systems/aimIndicator.js';
import { play as playMusic, duckForUpgrade, sweepOpen, applyMusicSettings, applyPlayerMusicSettings, setLevel as setMusicLevel, preloadDefaultTracks, updateDepth as updateMusicDepth, startMusicAtRest, releaseMusicIntoRun, musicAtRest, snapToBarGrid, musicBankBytes } from './systems/music.js';
import { shotDue, resetShotGrid, tickInterval, finSplit, dealTick } from './systems/shotGrid.js';
import { startAmbient, stopAmbient, preloadAmbient, ambientBankBytes } from './systems/ambient.js';
import { computeKillPoints, comboMultiplierFor } from './systems/scoring.js';
import { updateCrabSpawner, resetCrabSpawner, summonDeathPile, updateDeathPile } from './systems/crabSpawner.js';
import { spawnSeagull, updateSeagulls, resetSeagulls, kickGull } from './systems/seagull.js';
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
import { updateFlags } from './systems/flags.js';
import { updateCalamari, resetCalamari } from './systems/calamari.js';
import { createDumboOcto, updateDumbo, resetDumbo, rebuildDumboOcto } from './systems/dumbo.js';
import { createHarpVisual, updateHarp, resetHarp, rebuildHarp } from './systems/harp.js';
import { firePearl, burstPearl, updateOyster, resetOyster } from './systems/oyster.js';
import { razorClamVolley, razorClamRoll } from './systems/razorClam.js';
import { createOctoGrabber, updateOctoGrab, resetOctoGrab, rebuildOctoGrabber } from './systems/octoGrab.js';
import { updateOrcaPod, resetOrcaPod, rebuildOrcaPod } from './systems/orca.js';
import { applyPlayerOutline, updatePlayerOutline, flarePlayerOutline, resetPlayerOutlineCharge, initCreatureOutlines, applyCreatureOutlines, applyCompanionOutlines } from './systems/outlines.js';
import { deathState, startDeathDive, updateDeathDive, resetDeathDive, beginRestartTransition } from './systems/deathDive.js';
import { levelUpState, startLevelUpTime, updateLevelUpTime, endLevelUpTime, resetLevelUpTime, cardsArriveAt, saluteEnabled } from './systems/levelUpTime.js';
import { bossKillState, updateBossKill, resetBossKill, bossKillShotDue, setBossKillFraming } from './systems/bossKill.js';
import { holdBossCorpse, updateBossCorpses, resetBossCorpses, bossCorpseFocus } from './systems/bossCorpse.js';
import { fireBossBoom, updateBossBooms, resetBossBooms, initBossBooms } from './systems/bossBoom.js';
import { initBossLight, updateBossLight, resetBossLight } from './systems/bossLight.js';
import { resetBossDissolve } from './systems/bossDissolve.js';
import { showSnapshotPrint, resetSnapshotPrints } from './ui/snapshotPrint.js';
import { initCrashLog, mark as crumb, noteError } from './systems/crashLog.js';
import { guardFrame } from './systems/frameGuard.js';
import { censusReport, censusLine } from './systems/memoryCensus.js';
import { updateBeams, resetBeams } from './systems/beams.js';
import { updateLaserEyes, setLaserAim, resetLaserEyes } from './systems/laserEyes.js';
import { updateBubbleJet, updateJets, resetBubbleJet, setJetStats } from './systems/bubbleJet.js';
import { setJetBedsMuted } from './systems/jetBed.js';
import { updateBurnGlow, resetBurnGlow } from './systems/burnGlow.js';
import { createEyeLights, updateEyeLights, resetEyeLights, applyEyeLightColours, flareEyeLights } from './systems/eyeLights.js';
import { updateBossEyes, resetBossEyes } from './systems/bossEyes.js';
import { updateCelebration, playCelebration } from './systems/celebrate.js';
import { triggerClap, updateClap } from './systems/clap.js';
import { captureBossShot, resetBossShot, bossShot } from './systems/bossShot.js';
import { cineEvent, cineBreach, resetCineCamera } from './systems/cineCamera.js';
import { beginTitleSeal, endTitleSeal, resetTitleSeal, titleSealEngaged, updateTitleSeal } from './systems/titleSeal.js';
// The screen between the name card and the run — see systems/mainMenu.js. It
// is mounted from here rather than from ui.js because it lives IN THE ARENA:
// it poses the run's own seal and claims the run's own camera, neither of which
// the UI layer has ever known about.
import { mountMainMenu, mainMenu, mainMenuActive, mainMenuAim, mainMenuEngaged, mainMenuGrid } from './systems/mainMenu.js';
// The tip sheet, for the menu's fourth button. Parsed here the way pauseMenu,
// riveSplash and ui all parse it — one `?raw` import and one parse per screen
// that can open the panel, which is a few hundred bytes and no shared state
// between screens that are never up at the same time.
import { openTipSheet, tipSheetOpen, closeTipSheet } from './ui/tipJar.js';
import { parseTipCsv } from './tipTable.js';
import tipsCsv from './tips.csv?raw';

const TIP_TIERS = parseTipCsv(tipsCsv);
import { updateStage, parkStageCamera, holdStageSafe, isStaging, stageSimulates, resetStage, sandboxRequested } from './systems/stage.js';
import { initStagePanel, setStagePanelVisible } from './ui/stage.js';
import { initWorkbench, updateWorkbench } from './ui/workbench.js';
import { initUI, showStartMenu, showLeaderboard, hideLeaderboard, hideAllMenus, showLevelUp, showGameOver, updateHUD, updateBossBar, spawnScoreToast, spawnChainToast, spawnProcToast, updateToasts, chainBannerHasPrompt, clearToasts, updateMenuNav, hidePlayerBars, applyBarPlacement, applyBoostMeter, showHud, showRestartTransition, hideRestartTransition, uiRoot, screenToWorld, setPauseButtonVisible } from './ui/ui.js';
import { setHiveUpgrades, setHiveLayout, setHiveStyle, setHiveStack, toggleHive, hiveRect, slamAndRipple, setHiveTips } from './ui/upgradeHive.js';
import { showUpgradeTip, hideUpgradeTip, resetUpgradeTip } from './ui/upgradeTip.js';
import { starfishLevelStats, multishotLevelStats, missileLevelStats,
         scallopLevelStats, bounceLevelStats } from './levelStats.js';
import { startHiveReward, hiveRewardActive, updateHiveRewardNav, resetHiveReward, bossDividendStacks } from './ui/hiveReward.js';
import { updateCallouts, resetCallouts, checkCallouts, clearCallout, resolveCalloutText, CALLOUTS } from './systems/callouts.js';
import { updateTutorial, resetTutorialRun, noteTutorialEvent, COACH_IDS, tutorialState } from './systems/tutorial.js';
// THE HELLO at the top of a run, which is not a tip: it fires every run and
// its words are rolled rather than written into callouts.csv. See
// systems/greeting.js.
import { resetGreetingRun, updateGreeting, greetingState, greetingOnBand } from './systems/greeting.js';
import { noteDeath } from './systems/lastRun.js';
import { setTelegraph, updateTelegraph, clearTelegraph } from './systems/telegraph.js';
import { initCallouts, updateCalloutUi, clearCalloutUi } from './ui/callout.js';
import { initGraveLabel, updateGraveLabel, clearGraveLabel } from './ui/graveLabel.js';
import { initGraveBeam, updateGraveBeam, clearGraveBeam } from './systems/graveBeam.js';
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
import { causesOfDeath, primaryCause } from './deathCauses.js';
import { epitaphLead } from './systems/epitaphLead.js';
import { sourceFamily } from './systems/playtestAnalysis.js';
// The caption on the kill-shot polaroid. `playerName` and not the raw stored
// value — see the note where it is used.
import { playerName, savePlayerName } from './systems/playerName.js';
import { randomPlayerName } from './systems/randomName.js';
import { buryName, isNameBuried } from './systems/nameLedger.js';
// Imported for its side effect: the module installs window.__dead, the door
// that carries the ledger and the graveyard out to a tool on another origin.
// See its header — nothing in the game reads what it exports.
import './systems/nameExport.js';
import { initPlaytestOverlay, showPlaytestReport } from './ui/playtestOverlay.js';
import { claimCrash, armCrash, disarmCrash, crashBeat } from './systems/crashWatch.js';

// Restore any saved tuning BEFORE anything reads CONFIG — world/grid/camera
// creation below all pull from it immediately, not just once gameplay starts.
//
// The seeding save is for production only, where localStorage is the sole
// store and starts empty. In dev, imported-tuning.json IS the seed, so
// saving here would rewrite the file (and bump its timestamp) on every
// single page load — pure git churn, and it left the browser cache looking
// permanently "newer" than disk.
// `seed: true` because this write is a copy of the shipped file, not an edit
// the player made — see saveTuningToStorage. Without it the cache claims to be
// newer than the file it was copied from, and no later build's tuning can ever
// win again.
if (!loadTuningFromStorage() && !import.meta.env?.DEV) saveTuningToStorage({ seed: true });

// A beacon left in localStorage means the LAST session did not end a run, it
// was killed mid-run — on iOS that is WKWebView's content process being taken
// for memory, which reloads the page and looks to the player like a reset. The
// census it carries is the closest thing to a stack trace such a death leaves.
// Claimed once here (and cleared), then handed to the next run's record so it
// travels to the ledger through the pipeline that already exists.
const priorCrash = claimCrash();
if (priorCrash) {
  console.warn('[crash] previous run did not end — the page was reloaded under it.', priorCrash);
}

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
// No scene objects of its own: a boss's weak spots are painted by a shell bound
// to that boss's own skeleton (systems/bossHotSpots.js), so this only clears
// state. Kept as an init for symmetry with everything either side of it.
initBossHotSpots();
initBossGibs(world.scene);
// The shockwave is a scene object (systems/organicRing.js); the smoke is not.
// Without this the cloud still fires and the front silently never appears.
initBossBooms(world.scene);
initBossLight(world.scene);
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
// A CRIT ON A BOSS'S WEAK SPOT, watched rather than reported. The first-run tip
// about weak spots is answered by hitting one, and the only place that knows a
// hit landed on a spot is hotSpotDamage — three call sites deep inside combat,
// the strike and the club, none of which should learn about the tutorial to say
// so. `hotSpotHit` is already fired there for the goo and the sound, so the
// event IS the notification and this is one line rather than a fourth hook.
onFeedback((event) => {
  if (event === 'hotSpotHit') noteTutorialEvent('bossWeakSpot');
});
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
// --- THE BOSS DIVIDEND ------------------------------------------------------
// Stacks owed for bosses already killed, and how many kills have been paid for.
// Two counters rather than one because they answer different questions: the
// second is what stops the same kill being billed on every frame after it, and
// the first is what survives a wait — the payout is held until the kill shot has
// let go of the clock and any level the same kill earned has been spent, which
// can be several seconds after the boss actually died.
let pendingBossStacks = 0;
let bossesPaid = 0;
// XP HELD BACK from a single oversized mouthful, and the seconds left to pay it
// in over. See CONFIG.xp.spill and updateXpSpill.
let xpSpill = 0;
let xpSpillLeft = 0;
// The basic shot's clock lives in systems/shotGrid.js now — it is scheduled
// against the music's bar grid rather than counted down, and the countdown it
// falls back to when there is no transport is in there with it.
let missileCooldown = 0;
let scallopCooldown = 0;
let oysterCooldown = 0;
let razorClamCooldown = 0;
let bounceCooldown = 0;
let rapidFireTimer = 0; // seconds remaining on an active rapid-fire pickup
let chargeHapticTimer = 0; // counts down between wind-up rumble pulses
let bubbleSpawnTimer = 0;
let rapidFireSpawnTimer = 0;
let levelOrbSpawnTimer = 0;
// SECONDS SINCE THE LAST CARD WAS TAKEN, and Infinity until the first one is.
// The first-run tip that points out the hive is offered in the window after a
// pick and lapses out of it — see the `hiveStack` step in systems/tutorial.js
// for why that window exists rather than the tip simply sitting there until the
// twelve-second ceiling takes it.
let sinceUpgrade = Infinity;
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
// Which flipper the next BASIC shot leaves from, when CONFIG.weapon.alternateFins
// is on. Separate from muzzleCursor because the two weapons walk the fins on
// their own cadences — a missile volley that reset the pebbles' side would put
// two pebbles out of the same fin in a row and break the alternation the whole
// thing exists for.
let finCursor = 0;
const muzzlePoint = new THREE.Vector3(); // scratch — spawnProjectile copies it immediately
// THE JET'S OWN scratch, deliberately NOT muzzlePoint. That one is reused by
// every shot, missile, scallop and pearl in the frame, and the stream does not
// copy what it is handed — its follow callback holds this vector and re-reads
// it, so sharing the scratch would have the jet leaving a flipper the moment
// anything else fired. See systems/bubbleJet.js.
const jetMuzzle = new THREE.Vector3();
const impulseDir = new THREE.Vector3(); // scratch — hit direction handed to the bone spring
const faceDir = { x: 0, y: 1 }; // scratch — the seal's facing, read by the bubble vent
// Scratch for the per-frame "where would a strike go" prediction the lens
// corridor is drawn along. Read and copied inside updateCamera on the same
// frame it's written, so one object is enough.
const dashPrediction = { x: 0, y: 0 };

// When the crash trail last got a heartbeat — see the pulse in animate().
let lastCrumbAt = -1e9;
// And the byte census, which is a scene walk and so runs a quarter as often.
let lastMemAt = -1e9;
// Frames at the last heartbeat — the difference is what says the loop is alive.
let lastCrumbFrames = 0;
// Consecutive heartbeats found paused with no screen up — see the strand check
// in animate(). Zero on any tick that is honestly held.
let strandedBeats = 0;
// Every frame animate() completes. Nothing else counts them: perfLog works in
// times, not in frames, and a hang is a question about frames.
let frameCount = 0;

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

// FIRST, and before boot() is even called: a throw from the boot itself is the
// one crash with nothing else to report it. See systems/crashLog.js — this
// costs a localStorage read and tells the next launch what killed this one.
initCrashLog();

boot();

async function boot() {
  const loading = showLoading();
  // Assets are the first two thirds of the bar and the shader warm-up is the
  // last third. Not a measurement — the split is a judgement about which half
  // feels longer, and the warm-up's own share is smoothed inside that third.
  const ASSET_SHARE = 0.66;
  // BEFORE the models are fetched, and it has to be: this is what decides
  // whether each one is loaded from public/models or its GPU-compressed twin,
  // and it cannot answer until it has a GL context to ask which compressed
  // formats exist. See initModelTranscoder in assets.js.
  initModelTranscoder(world.renderer);
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

  // The open shells a mussel detonation swaps to. HERE and not up beside
  // initImpactFlashes, for the reason written at the top of this block: the
  // pool is built out of createVisual, so it has to come after the models are
  // loaded or every shell in it is a fallback sphere.
  initMusselShells(world.scene);

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

  // The seabed plant bed. HERE for the reason the mussel shells above are:
  // it is built out of createVisual, so before preloadAssets every plant in it
  // would be a fallback cone — and silently, since that path does not throw.
  // world.scene rather than the backdrop group, which is disposed and rebuilt
  // on every resize and would take the bed's geometry with it.
  scatterSeabed(world.scene);
  // The beam injects itself into the grave stones' MATERIALS, which only exist
  // once their models are loaded — so this belongs here, after the same await
  // the bed above depends on. Called earlier it finds nothing to attach to and
  // quietly succeeds, which would leave a beam that never appears and never
  // says why. See initGraveBeam.
  initGraveBeam();
  // The stones from previous sessions. AFTER the world is built, because a
  // grave's position is stored as a fraction of the arena's half-width and
  // resolving it needs the live bounds — called earlier, every stone comes back
  // at a fraction of a stale width. They are planted by the plantGraves call at
  // the top of the first run, already settled. See systems/graveyardStore.js.
  restoreGraves();
  // WHAT A LANDING STONE DOES TO THE WATER. Wired here rather than inside
  // systems/gravesite.js because it needs the live enemy list, applyKnockback
  // and removeEnemy — the gameplay half of the game — and that module's job is
  // standing a stone on the floor. See setGraveImpact.
  setGraveImpact(graveImpact);

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
  // The THIRD warm-up, and it spends the other hush the game already has: the
  // seconds a level-up menu is open. See systems/levelUpWarmup.js — a companion
  // card builds its body on the first live frame after the pick, which is the
  // one frame the player is waiting on.
  installLevelUpWarmup({ post, scene: world.scene, camera: world.camera });
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
    // The phone's only way in. A keyboard has Escape and a pad has Start; a
    // thumb had neither, which meant Options, Resume and Restart were all
    // unreachable from a run on mobile. Routed through setPaused rather than
    // showPauseMenu so it takes the same path the key does — canPause(), the
    // clock, and clearPendingInput on the way back out.
    onPause: () => setPaused(true),
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
  initGraveLabel(uiRoot());
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
  // Handed the tuner's change handler for one row: the goo field's
  // resolution, which is sized with the post chain rather than read per
  // frame. Everything else the workbench writes is live.
  if (DEV_UI) initWorkbench(handleTunerChange);
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

// THE CORNER ANSWERS QUESTIONS WHILE THE RUN IS STOPPED.
//
// The hive is a readout all fight and a thing you can interrogate the moment
// the game is not moving — which is the only moment worth binding it to, since
// the mouse is the aim and the hive sits in a corner the pointer crosses
// constantly while shooting. See setHiveTips for the two things that have to
// change for a hexagon to be hoverable at all.
//
// The stack count is left to the tip, which reads the run's own ledger — this
// hands over the id and the element and nothing else.
function bindHiveTips(on) {
  setHiveTips(on, {
    // The count comes off the TILE, which was built from the fold — see the
    // note on dataset.stacks. Nothing here has to know the pick list.
    onShow: (id, tile) => showUpgradeTip(id, tile, { owned: Number(tile.dataset.stacks) || 0 }),
    onHide: hideUpgradeTip,
  });
  if (!on) hideUpgradeTip();
}

function setPaused(paused) {
  if (paused === isPauseOpen()) return;
  if (paused) {
    if (!canPause()) return;
    gameState.paused = true;
    showPauseMenu();
    bindHiveTips(true);
    return;
  }
  hidePauseMenu();
  bindHiveTips(false);
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
  // THE FIELD OF VIEW IS A REBUILD, not just a new frustum. It moves
  // bounds.frameTop, and the sky plane's gradient is normalised against exactly
  // that (skyPlaneMetrics) — so the full world.resize() rather than the cheap
  // window path, or the sky keeps the ramp it was built with and the horizon
  // sits at the wrong height for as long as the setting is held.
  //
  // Nothing about the ARENA moves here: the walls, the floor and every spawn
  // are where they were. Only the window onto them changes. See updateBounds.
  if (all || path === 'video.fov') world.resize();
  // The filter and the bloom toggle are resolved inside post.render every
  // frame, and the shake scale is read at the point the camera is offset, so
  // neither needs anything here.
  if (DEV_UI && (all || path.startsWith('video.'))) refreshTuner();
  // The gauges move the INSTANT the row is nudged, from inside the pause menu.
  // updateHUD applies the placement too, and on its own that would be enough —
  // but only on a frame it runs, and it does not run while the game is paused.
  // Without this the player toggles the setting and the menu appears to have
  // done nothing until they resume.
  if (all || path === 'hud.barPlacement') applyBarPlacement();
  // Same reasoning for the fuel: the row is nudged from a paused menu, on a
  // frame updateHUD is not running. The RING half needs nothing here — it
  // reads the setting itself, every frame it draws.
  if (all || path === 'hud.boostMeter') applyBoostMeter();
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
    // Shift+B: put a bait ball in the water right now, and Alt+Shift+B put a
    // shark on it as well.
    //
    // The real thing needs a level, a boss, and an arena that happens to be
    // near-empty — three conditions that line up minutes apart, which is not a
    // loop anybody can tune a swirl in. Every gate is bypassed on purpose (that
    // IS the feature) and the ball arrives ON STATION rather than swimming in
    // from past the wall, because the five-second entrance is right in a run
    // and pure dead time when you are pressing the key for the ninth time.
    //
    // Alt adds the other half of the tug of war. A ball with nothing eating it
    // is only half the mechanic, and waiting for a shark to wander into one is
    // the same waiting this key exists to remove — so it drops a hunter beside
    // the ball, already inside its own `preyRadius`, and it starts feeding.
    //
    // Dev only, like the glow lineup below it. The ledger line prints when the
    // ball ends (CONFIG.baitBall.log), which is where the exchange is legible.
    if (DEV_UI && e.shiftKey && e.key.toLowerCase() === 'b'
        && !isTypingTarget(e.target) && !e.repeat) {
      e.preventDefault();
      spawnBaitBallNow(e.altKey);
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

// Shift+B's ball. See the key handler for why it bypasses everything.
function spawnBaitBallNow(withPredator = false) {
  const spec = devBaitBallSpec();
  const ball = spawnBaitBall(world.scene, gameState.difficulty, gameState.level ?? 1, spec);
  if (!ball) {
    console.warn('[bait] nothing spawned — either the arena is at spawn.maxAlive, or nothing in '
      + 'enemies.csv currently qualifies as small fry at this difficulty and level '
      + '(prey, under spawn.waves.lull.maxRadius).');
    return;
  }
  // Already there. openBaitBall opens every ball `arriving`, which is right for
  // one that spawned past the wall and wrong for one placed on its station —
  // left set, the anchor would spend its first frames swimming to a point it is
  // already standing on.
  ball.arriving = false;
  // The fish were placed around the anchor INSIDE the arena, so none of them is
  // coming in through a wall. `entering` suppresses the side clamp for a body
  // still outside the picture; on these it would let the whole ball drift out
  // through the edge it was never behind. Same fix the glow lineup needs.
  for (const en of enemies) if (en.schoolId === ball.id) en.entering = false;

  let hunter = null;
  if (withPredator) {
    // Whichever hunter the table currently offers, biggest preyRadius first —
    // the one most likely to actually commit to the ball rather than wander
    // past it. Named off the table rather than hardcoded to 'shark' so a roster
    // change cannot leave this key pointing at a creature that no longer exists.
    // `weight > 0` is what excludes the bosses: every boss row ships weight 0
    // and spawnRateMul 0 because the pool must never draw one, and that is a
    // more honest test than a name prefix — a boss dropped here would arrive
    // with no health bar, no entrance and no fight around it.
    const [key] = Object.entries(CONFIG.enemies)
      .filter(([, d]) => d.hunt && (d.weight ?? 0) > 0 && (d.hunt.preyRadius ?? 0) > 0)
      .sort((a, b) => (b[1].hunt.preyRadius ?? 0) - (a[1].hunt.preyRadius ?? 0))[0] ?? [];
    if (key) {
      hunter = spawnNamed(world.scene, key, gameState.difficulty,
        { x: ball.x + 6, y: ball.y }, { ignoreCaps: true });
      if (hunter) hunter.entering = false;
    }
  }

  console.log(`[bait] ${ball.opened} ${enemies.find((en) => en.schoolId === ball.id)?.type ?? '?'} `
    + `at ${ball.x.toFixed(0)},${ball.y.toFixed(0)} — shell ${ball.shell.toFixed(1)}, `
    + `spin ${ball.spin > 0 ? 'CCW' : 'CW'}, ${ball.life.toFixed(0)}s to live`
    + (hunter ? `, with a ${hunter.type} on it` : '')
    + '.\n  Alt+Shift+B drops a hunter on the next one. Tune every number with `npm run csv` '
    + '→ spawning.csv → the baitBall.* rows.');
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
  if (path === '*' || path.startsWith('arena') || path.startsWith('camera')) { world.resize(); reseatDecor(); reseatSeabed(world.scene); reseatGraves(); }
  // Size, the stones in rotation, the lean and every number the inscription is
  // cut with are all spent when a stone is PLANTED, so a slider that only wrote
  // CONFIG would move nothing that is already standing in the water — which
  // reads as the panel being broken. `label` is the exception: it is read every
  // frame the caption is up, so rebuilding the yard for it would be six stones
  // and six canvases rebuilt per slider drag.
  if (path === '*' || (path.startsWith('gravesite') && !path.startsWith('gravesite.label'))) restyleGraves();
  // Every knob on the bed is a REBUILD — the sampler decides positions, so
  // there is no uniform to write. Seeded, so a bed rebuilt by a slider you did
  // not touch comes back identical rather than reshuffling.
  if (path === '*' || path.startsWith('seabed')) scatterSeabed(world.scene);
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
  // The goo's density field is sized inside post.resize, not read per frame,
  // so its divisor is the one control on the F panel's goo view that does
  // nothing at all until this runs. setSize early-outs on an unchanged size,
  // so dragging the handle costs nothing on the frames it does not move.
  if (path === '*' || path.startsWith('fx.goo.divisor')) post.resize();
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
  if (path === '*' || path.startsWith('bubbleShell') || path.startsWith('oxygenBubbleShell')) applyBubbleShellSettings();
  if (path === '*' || path.startsWith('chromeBlade')) applyChromeSettings();
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
  // THE SCORE STARTS HERE, not at Play. It comes up under a ~500Hz lid — see
  // CONFIG.music.menuHz — so the menu has the groove and none of the top end,
  // and pressing Play opens the filter rather than starting a track.
  //
  // Both calls are no-ops the second time round: the context is already awake
  // by now on the normal route (the press that dismissed the name card unlocks
  // it — see `onGesture` in ui.js), and this covers the reduced-motion route,
  // where there was no gesture and unlockAudio arms its own first-input resume.
  // preloadDefaultTracks latches, and startMusicAtRest parks the level in
  // `pendingLevel` if the first loop has not decoded yet, so the music arrives
  // on its own the moment it lands.
  unlockAudio();
  preloadDefaultTracks();
  startMusicAtRest();
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
        // THE PRIMARY BUTTON, said out loud rather than inferred from being
        // first: bigger, with a heavier stroke on the glyphs, and a louder
        // halo and a hotter tile under the pointer. See `label` in
        // CONFIG.splashBust.menu for what each of those is worth.
        lead: true,
      },
      // THE SETTINGS PANEL, on its own rather than behind a pause. Same surface
      // the pause menu is — one panel, one set of controls, one place they are
      // saved — opened `standalone`, which heads it "Settings", drops "Restart
      // run" and calls the way out "Back". See ui/pauseMenu.js.
      //
      // NOT setPaused(true): that route is for a run, it is gated on canPause()
      // and it would head the panel "Paused" over a menu with nothing to pause.
      //
      // This slot used to be "How to play" — the old DOM start panel, a wall of
      // instructions on a button. It is deleted: the tutorial teaches all of it
      // in the water, at the moment each thing matters, which is the only place
      // anybody ever read it.
      { label: 'Options', onPress: () => showPauseMenu({ standalone: true }) },
      // The board on its own surface, rather than only as a panel inside the
      // score card — until now the only way to look at it was to die. See
      // showLeaderboard.
      //
      // BROKEN OVER TWO LINES, and it is the same word — `lines` is a place to
      // break, not different copy, and `label` is still the whole string for
      // everything that is not the type. The shipped face is a pixel monospace
      // at one em per glyph, so eleven characters on one line forced every
      // other label on the screen down to fit beside it; six is nearly twice
      // the type size for free. Move the break by moving it here.
      { label: 'Leaderboard', lines: ['Leader', 'board'], onPress: showLeaderboard },
      // THE JAR, at last on the screen people actually stop on. It was already
      // on the name card, in the pause panel and under the score — three
      // places you reach by either not having started or having died. This is
      // the fourth, and it is the one that closes the diamond: the arrangement
      // has a cell under the two side buttons whether anything is in it or not
      // (see `diamondCells`), so the fourth button costs the composition
      // nothing.
      //
      // The SHEET, not the link. `tipJarLink` is an anchor that navigates, and
      // a hex button is not an anchor — the tiers panel is what the other
      // three call sites open anyway, and it is what quotes what a tip buys.
      // Stacked at its own space, for the same reason as the line above.
      { label: 'Tip jar', lines: ['Tip', 'jar'], onPress: () => openTipSheet({ tiers: TIP_TIERS }) },
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
  hideLeaderboard();
  hidePauseMenu();
  // ...and the tip sheet, which is the fourth button's panel and the third
  // thing on this list for the same reason as the other two: it is a DOM
  // surface with its own Escape handler, and nothing about a run starting
  // takes it down.
  closeTipSheet();
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
  crumb('run:start');
  // Back to the resolution the player asked for. A run that ended on a machine
  // mid-struggle must not hand the next one a cut it never earned — and the
  // next run may be a different window size, a different scene, or simply the
  // player having closed whatever else was eating the GPU.
  world.resetAdaptiveScale();
  // The menu is gone, and with it the scene it was drawing: the particle system
  // goes back to the arena here, the seal's rim comes off the bust. FIRST in
  // this function, because everything below is the run being built and the
  // resets that follow (resetParticles in particular) have to land on buffers
  // that already belong to world.scene again.
  closeMainMenu();
  // NO RUN IS EVER PLAYED BY A SEAL THAT IS ALREADY BURIED. Every surface that
  // sets a name checks the ledger on its own — the score card's next-seal row,
  // the splash's field, the dice behind both — and this is the backstop under
  // all of them, at the one place a run actually begins.
  //
  // Worth having even though those checks are correct today: they are three
  // separate surfaces and there will be a fourth, and the failure they let
  // through is not visible. A run played under a buried name looks completely
  // normal until it ends, at which point the graveyard grows a second stone for
  // a seal it already has one for — and the only evidence is two headstones
  // with the same name on them, several minutes after the mistake.
  if (isNameBuried(playerName())) savePlayerName(randomPlayerName(playerName()));
  // The graveyard comes back with the arena. A no-op in the ordinary case —
  // the group lives on world.scene and is never taken off it by a restart, and
  // plantGraves skips anything already standing — so this is here for the two
  // cases that are not ordinary: a stone whose model had not finished loading
  // when its run ended (createVisual before preloadAssets resolves is a silent
  // fallback shape, so gravesite declines to plant one at all), and the group
  // being detached by anything that rebuilds the scene. Cheap, idempotent, and
  // the alternative is a death that leaves no marker and never says so.
  plantGraves(world.scene);
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
  disarmCrash();
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
  armCrash();

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
  // The grab holds a reference to a creature resetEnemies has just deleted, and
  // a run that ended in a boss's mouth must not start in one. Torn up rather
  // than released — there is nothing left to be thrown by.
  resetBossGrab();
  updateBossBar(null);
  resetProjectiles(world.scene);
  // A staged attractor storm is a dev thing and does not survive a run — its
  // scaffold is a line mesh in the scene, and a new run starting inside the
  // last one's telegraph would be the panel lying about what is in the water.
  resetAttractorStorm(world.scene);
  clearProjectileTrails(world.scene);
  // The bolt materials, forgotten rather than disposed — see the cache note in
  // systems/finLaser.js. Beside the trails because it is the same argument
  // about the same kind of object: a shared material released between runs is
  // a shader linked from source again on the first shot of the next one.
  disposeFinLaser();
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
  // ...and the open shells under them, for the same reason: a shell is on its
  // own quarter-second clock, so one caught mid-pop by a reset would keep
  // tumbling through the first frames of the next run.
  clearMusselShells();
  // Every mark riding a body, dropped with the bodies. A wound outlives its
  // animal by design (it fades on its own clock, not the creature's), so a run
  // reset is the one moment they have to be taken off the board by hand.
  clearBossImpacts();
  // ...and every weak spot, for the same reason: a spot's light fades on its
  // own clock rather than the creature's, so the one moment they have to be
  // put out by hand is the moment the creature list is thrown away.
  resetBossHotSpots();
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
  resetBossLight();
  // Only the bookkeeping — the points themselves belong to the particle system
  // from the moment they are emitted, and resetParticles() is what clears those.
  resetBossDissolve();
  resetPickups(world.scene);
  // ...and any landing still owed a jet, before the buffer it would fire
  // into is cleared — a column arriving over the menu is the whole reason a
  // scheduled effect needs a reset at all.
  resetReentrySplash();
  resetParticles();
  // Before resetPlayer, which puts the seal back at midwater: this hands the
  // clock and the mix back to full speed, so a run started from the score
  // screen doesn't open in the last one's slow motion.
  resetDeathDive();
  // Same idea, for the other thing that bends the clock: a run can only be
  // started from a menu, but a level-up left half-dilated by a reload or a
  // restart would hand this one a world running at half speed.
  resetLevelUpTime();
  // The warm-up's ledger with it. Nothing is re-uploaded by this — the
  // templates and their GPU residency outlive a restart — it is only the record
  // of what this run has paid for starting out honest.
  resetLevelUpWarmup();
  // And for the third: a boss kill shot interrupted by a restart (the score
  // screen is reachable from inside one, since gameplay stays live through it)
  // would hand the new run a dilated clock and a frame still clamped to where
  // the last seal was standing.
  resetBossKill();
  resetBeams(world.scene);
  resetLaserEyes();
  resetBubbleJet(world.scene);
  resetBurnGlow();
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
  // A run that ended pinned must not open the next one still ramping, and a
  // boss mid-lunge when the last run ended must not pay the new run's first
  // frame for a dodge nobody made.
  resetSlam();
  resetDodge();
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
  resetFinLights(world.scene);
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
  resetLowHealthFx();
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
  // The tip box lives on document.body, so nothing else tears it down — a menu
  // closing takes its own subtree and leaves this floating. Dropped rather than
  // hidden: it is describing the LAST run's stacks and the last run's ledger,
  // and a box carrying those over the new run's first level-up is a screen
  // stating things that are no longer true.
  resetUpgradeTip();
  bindHiveTips(false);
  gameState.time = 0;
  gameState.difficulty = 0;
  // THE OPENING SHOAL. A few harmless fish already in the water, scattered
  // around the seal, so the run's first seconds have something to eat in them
  // and the boost meter — which opens dead, and which only chum fills — can be
  // loaded before the spawner's first tick lands. See CONFIG.spawn.opening.
  //
  // HERE, and the position in this function is the whole of what makes it
  // work: after resetEnemies, which throws away the list this would otherwise
  // be added to; after resetPlayer, because the scatter is centred on the seal
  // and a shoal placed before it would be arranged around wherever the LAST
  // run ended; and beside the difficulty reset, because it spawns at
  // difficulty 0 and this is the line that makes that true.
  spawnOpeningShoal(world.scene);
  // Cleared with the rest of the run, or a seal that swims into a new run and
  // dies to something unclassified would be handed the LAST run's punchline.
  lastDamageSource = null;
  lastDamageBoss = null;
  gameState.deathCauses = null;
  gameState.deathSource = null;
  gameState.kills = 0;
  gameState.score = 0;
  gameState.level = 1;
  // Must come AFTER level is reset to 1 — playMusic picks its opening loop
  // from the level it's handed, so running it first started every new run on
  // whatever loop the PREVIOUS run had climbed to.
  //
  // ...unless the score is AT REST, which it is on both screens a run can
  // start from — the main menu before the first one, and the score card after
  // every one. Then the run takes the transport over rather than starting it:
  // the release lifts the resting lid and the resting half speed over the
  // camera's opening move, and restarts the loop underneath only if what is
  // playing is not what this run opens on (see releaseMusicIntoRun — dying to
  // a boss leaves the fight's rotation up, where the menu never does).
  if (!releaseMusicIntoRun(gameState.level)) playMusic(gameState.level);
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
  // The dividend goes with it. `bossesPaid` in particular: without the reset the
  // next run's first boss is compared against the last run's count and pays
  // nothing at all.
  pendingBossStacks = 0;
  bossesPaid = 0;
  resetHiveReward();
  // Held xp belongs to the run that earned it and to nothing else.
  xpSpill = 0;
  xpSpillLeft = 0;
  resetShotGrid();
  finCursor = 0;
  missileCooldown = 0;
  scallopCooldown = 0;
  oysterCooldown = 0;
  razorClamCooldown = 0;
  bounceCooldown = 0;
  rapidFireTimer = 0;
  bubbleSpawnTimer = rollBubbleSpawnDelay();
  rapidFireSpawnTimer = randomBetween(CONFIG.rapidFirePickup.spawnMin, CONFIG.rapidFirePickup.spawnMax);
  levelOrbSpawnTimer = randomBetween(CONFIG.levelPickup.spawnMin, CONFIG.levelPickup.spawnMax);
  sinceUpgrade = Infinity;
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
  // ...and this run's hello is rolled HERE, at the start, rather than when it
  // is spoken a second later: rolling it is also what banks this run as one
  // that happened, so a player who quits during the opening camera move is
  // still greeted as a returning player next time. See resetGreetingRun.
  resetGreetingRun();
  clearCalloutUi();
  // Same for the grave caption. Cut rather than faded: this is the run being
  // built, and a caption fading out over the opening frames is the last run
  // leaking into this one.
  clearGraveLabel();
  clearGraveBeam();
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
    // The census from a run that was KILLED rather than lost, if the last
    // session ended that way. Rides in on `config` because beginRun stores it
    // wholesale on the record, so this reaches the collector through the
    // pipeline that already exists rather than needing an endpoint of its own.
    // Read it as "the run BEFORE this one died at these counters".
    ...(priorCrash ? { priorCrash } : {}),
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
// The boss's own rolled name, when a boss is what did it — "Grimjaw the
// Famish'd" rather than "a boss". Kept beside the source rather than folded
// into it: deathCauses.js classifies a SOURCE, and a name is not one. See
// systems/boss.js for where the name comes from.
let lastDamageBoss = null;

/**
 * A gravestone hits the seabed, and everything standing there finds out.
 *
 * TWO RADII, because "knocked away" and "destroyed" are different distances.
 * Inside `killRadius` the stone lands ON you and there is nothing to discuss;
 * out to `radius` it is a shockwave through the water and you are thrown clear
 * of it. The falloff between them is what makes the edge of the blast read as
 * an edge rather than as a circle things stop happening in.
 *
 * IT SCORES NOTHING, and that is the one rule here that is not about feel. The
 * run is already over — killPlayer has banked the causes, the recorder has
 * filed the run, and the score card is a couple of seconds away — so anything
 * this kills that went through onEnemyKilledFeedback would add kills to a run
 * that had finished, put XP orbs in the water for a seal that is dead, and
 * change the number on a card the player is about to read. The creature is
 * removed and torn up; nothing is credited.
 *
 * applyKnockback rather than a nudge to vx/vy: a turn-limited hunter assigns
 * its own velocity outright every frame (see steerTo), so anything written
 * there is erased before it can move a shark an inch. That function adds the
 * impulse at the integrator instead, where it lands identically on a drifting
 * fish, a flocking school and a shark.
 */
function graveImpact(x, y) {
  const c = CONFIG.gravesite?.impact ?? {};
  if (c.enabled === false) return;
  const shove = Math.max(0, c.radius ?? 22);
  const kill = Math.max(0, c.killRadius ?? 7);
  if (shove <= 0) return;

  // Backwards, because the kill branch removes entries as it goes.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e?.mesh) continue;
    const dx = e.mesh.position.x - x;
    const dy = e.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > shove * shove) continue;
    const d = Math.sqrt(d2) || 1e-4;

    // A BOSS IS SHOVED, NEVER DESTROYED. A stone landing on the thing that
    // just killed you and deleting it would be the game settling the score on
    // the player's behalf, seconds after it refused to. It gets thrown around
    // like everything else.
    const spared = e.isBoss || e.invincible;

    if (!spared && d2 <= kill * kill) {
      // `kill` is the same event every other creature death in the game fires,
      // so one crushed under a headstone pops exactly like one crushed by
      // anything else. Deliberately NOT onEnemyKilledFeedback, which is the
      // SCORING path — see the note above about crediting a finished run.
      feedback('kill', { x: e.mesh.position.x, y: e.mesh.position.y, scale: 1.1 });
      removeEnemy(world.scene, i);
      continue;
    }

    // Linear in DISTANCE, not in distance squared. Squared falls off so fast
    // that everything past a third of the radius is barely touched, which
    // reads as a small blast with a large and mysterious outer edge.
    const falloff = 1 - (d - kill) / Math.max(1e-4, shove - kill);
    applyKnockback(e, dx / d, dy / d, (c.power ?? 1) * Math.min(1, Math.max(0, falloff)));
  }

  // One event for the whole thing, at the point of contact. `waterBlast` is
  // the shake-and-boom the splash system already uses, so a stone landing
  // sounds like the other large things that happen in this water rather than
  // introducing a vocabulary of its own — it is `bigKill` in every channel
  // except the particles. This fired `bigKill` itself until it was noticed
  // that the event carries `killGoo`: a rock hitting the seabed was throwing
  // out a cloud of blood, from nothing.
  if (c.feedback !== false) feedback('waterBlast', { x, y, scale: c.shake ?? 1.6 });
}

function killPlayer() {
  crumb('run:death');
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
  // Banked with it, and for exactly the same reason: the run ended HERE, and
  // nothing between this line and the score card is going to remember which
  // boss it was.
  gameState.deathBoss = lastDamageBoss;
  // Banked for the NEXT run's hello, which can name what killed this one —
  // "Last time it was a crab, {player}". The raw source rather than the causes,
  // because the greeting needs both readings of it and deathCauses.js is where
  // that split lives. See systems/lastRun.js.
  // ...and WHO it happened to, for the next run's hello to mourn by name. Read
  // here, at the moment of death, and not when the greeting spends it: by then
  // the score card has named a new seal and playerName() is somebody else.
  noteDeath(lastDamageSource, playerName());
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
      draws: drawsLastFrame,
      mpix: +((world.renderer.domElement.width * world.renderer.domElement.height) / 1e6).toFixed(2),
      scale: +world.renderer.getPixelRatio().toFixed(2),
      // What the adaptive controller settled on. A run that spent its life at
      // 0.6 is a machine that could not hold the frame rate at any point, and
      // that is a different reading of the same frame times than a run that
      // never dropped at all.
      autoScale: +world.adaptiveScale().toFixed(2),
      enemies: enemies.length,
    },
  };
  disarmCrash();
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

  // The gravesite goes in between. `toScoreScreen` is handed to the dive and is
  // called on the far side of it — after the seabed hit and the settle pause —
  // so by the time this runs the body is lying still on the floor and its
  // position IS the death site. That is why the marker is filed here and not
  // from killPlayer: killPlayer fires the instant the health runs out, with the
  // seal still up in the water where it was bitten, and several seconds of
  // sinking between there and the floor.
  //
  // The name is read NOW, before the score card offers a re-roll: the stone has
  // to keep the name that actually played the run.
  //
  // markDeathSite always calls back, including when it can do nothing at all —
  // see its header. Nothing else puts the card up.
  const markThenScore = () => {
    // THIS SEAL IS DEAD AND ITS NAME GOES WITH IT. Before the score card, so
    // the "next seal" row it puts up is already rolling against a ledger that
    // knows about the seal that just died — otherwise the very first name
    // offered after a death could be the name that death belonged to.
    buryName(playerName());
    markDeathSite(world.scene, {
      x: player.mesh.position.x,
      // NO z. The body's x is the death site; its depth is not a fact about the
      // death, it is a decision about what stands in front of the name — so
      // gravesite.js makes it. The stone that is about to be read drops clear
      // of the plant bed and settles among it in later sessions; see the depth
      // block there. Passing one here would pin every stone at one depth again.
      // playerName() and not loadPlayerName(): a headstone is a sentence about
      // somebody, so it wants the trimmed, never-blank reading. See its note.
      name: playerName(),
      // THE BOSS'S OWN NAME BEATS THE CAUSE, and this is the one place the
      // stone says something deathCauses.js cannot. That file groups sources
      // into causes a writer can joke about, and every boss attack collapses
      // into "a boss" — correct for a quip pool and a waste of the best line on
      // the stone. A player who was killed by Grimjaw the Famish'd wants
      // Grimjaw on the headstone, not the category Grimjaw belongs to.
      //
      // The bosses with their OWN cause row keep it: the orca and the mosasaur
      // read as "the orca" in every other surface, and a stone is not the place
      // to start disagreeing with them... except that it is exactly the place,
      // because the stone is about ONE death rather than about a species. So
      // the name wins whenever there is one.
      cause: gameState.deathBoss || primaryCause(gameState.deathSource)?.label || '',
      // THE LEAD IS ROLLED HERE AND SPENT ONCE. A stone is carved and then it is
      // carved — a connector that re-rolled every time the player swam past
      // would be the one thing on the seabed that changes its mind.
      //
      // Rolled against the ARCHETYPE'S cause even for a boss, which is why this
      // reads primaryCause and not deathBoss: the thing that killed you is a
      // shark, and "chomped by / Grimjaw the Famish'd" is the sentence. See
      // path/src/epitaphTable.js.
      lead: epitaphLead(primaryCause(gameState.deathSource)?.id ?? null),
    }, toScoreScreen);
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
  startDeathDive(markThenScore);
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
    // The level also widens the health bar (CONFIG.player.hpPerLevel), and the
    // new room is HANDED OVER exactly as addUpgrade hands over a +max-health
    // card's: recomputeStats only clamps hp to the maximum, so without this a
    // level-up would move the denominator and nothing else — the fill would
    // shrink at the moment the bar grew, which reads as being hurt by
    // levelling up.
    const beforeHp = player.stats.maxHp;
    recomputeStats();
    player.hp = Math.min(player.stats.maxHp, player.hp + Math.max(0, player.stats.maxHp - beforeHp));
    // Advances to the next uploaded loop when this level crosses a slot
    // boundary, and opens the filter a step further.
    setMusicLevel(gameState.level);
    gameState.xpToNext = xpForNextLevel(gameState.level, gameState.xpToNext);
    pendingLevels += 1;
    feedback('levelUp', { x: player.mesh.position.x, y: player.mesh.position.y });
  }
  // Asked rather than opened — see tryOpenLevelUp, which owns every rule about
  // whether the cards are allowed on screen yet. Still called from here so a
  // level that is clear to open does so on the frame the xp landed rather than
  // waiting for the next one.
  tryOpenLevelUp();
}

/**
 * OPEN THE CARDS IF NOTHING ELSE OWNS THE SCREEN — the one place that decides.
 *
 * `pendingLevels` is a queue, not a flag: it is raised by gainXP and spent by
 * applyLevelChoice, and it can sit at one or more for as long as it takes for
 * the screen to come free. Called from gainXP (so a clear level opens on its
 * own frame) and once per frame from animate (so a held one opens the moment
 * whatever was holding it lets go).
 *
 * THE QUEUE, in order of who owns the screen — the same order updateBossDividend
 * waits in, and for the same reason.
 *
 * `bossKillState.active` IS THE ONE THIS EXISTS FOR. The boss dies, its death
 * pays out enough xp to level, and the level-up cards used to open on that
 * frame — over the top of the kill shot, with the polaroid still crossing the
 * screen behind them. The whole ceremony (the held water, the shutter, the
 * print flying to the corner) is a thing to be watched, so the cards wait for
 * it to finish and the run gets the two moments in order rather than stacked.
 *
 * `running` as well as `paused`: death is filed mid-frame, from inside
 * resolveCombat, and the abilities that run after it in the same tick can still
 * land a kill worth a level. Without that the upgrade card opens over the death
 * dive and sits there for the whole descent.
 *
 * `levelUpState.active` is deliberately NOT in here. openLevelUp already knows
 * what to do with a second card from the same batch, and the state stays true
 * through the restore ramp after the last pick — a level earned on those live
 * frames must bring the cards straight back, not queue behind them.
 */
function tryOpenLevelUp() {
  if (pendingLevels <= 0) return;
  if (!gameState.running || gameState.paused) return;
  if (bossKillState.active || hiveRewardActive()) return;
  openLevelUp();
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
  // START PAYING FOR THE PICK NOW. Every companion card builds its body on the
  // first live frame after the choice, because the systems that size those
  // rings live inside the gate the line above just shut — so the clone, the
  // upload and the compile all land on the frame the game is supposed to come
  // back. The menu is a hush of exactly the shape systems/bossWarmup.js already
  // spends before an arrival; this spends it, one step per frame, and is a
  // no-op from the second level-up on.
  beginLevelUpWarmup();
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
  // The tier the card was DEALT at rides along with the pick — see
  // recomputeStats, which replays every held upgrade at the rarity it arrived
  // with rather than at whatever the ladder says today.
  addUpgrade(choice.id, choice.rarity);
  // The corner picks the new tile up here rather than on a timer. setHiveUpgrades
  // no-ops when the folded set has not changed, so calling it on every pick is
  // the cheap path, not a rebuild per level.
  setHiveUpgrades(player.upgrades);
  // The window the hive tip is offered in opens here — see `sinceUpgrade`. On
  // every pick and not only the first, because the tip is spent the first time
  // it is shown anyway and a ledger check here would be this file keeping a
  // second copy of the coach's.
  sinceUpgrade = 0;
  // Timestamped, so the report can charge an ability only for the time it was
  // actually held — a pick taken at minute nine hasn't had a run to prove
  // itself and shouldn't be ranked as if it had.
  playtest.recordUpgrade(choice.id, gameState.time);
  pendingLevels -= 1;
  if (pendingLevels > 0) {
    openLevelUp();
  } else {
    // WHATEVER IS LEFT IN THE QUEUE IS ABANDONED, on the frame the run comes
    // back. A warm-up exists to keep work off the live frames, so it must never
    // be the thing adding a step to one — a menu closed before the queue
    // drained picks with what it got, and the next level-up finishes the rest.
    cancelLevelUpWarmup();
    gameState.paused = false;
    sweepOpen(); // filter opens back up, main loop returns on the next boundary
    // The run is live again from this frame, in slow motion, and the world
    // accelerates back to full speed underneath it. Handing control back only
    // once the ramp finished would mean half a second where the game looks
    // playable and isn't.
    endLevelUpTime();
  }
}

// ---------------------------------------------------------------------------
// THE BOSS DIVIDEND — the hive comes to the middle and the player deepens it.
//
// A boss used to pay in punctuation only: the kill shot, the print, and then the
// water coming back. The fight that a whole five-level cycle is built around
// handed over nothing the build could feel. This is the payout, and it is
// deliberately a payout of DEPTH rather than of breadth — a new card is a
// decision and belongs on the level-up screen; a boss says yes, harder, to
// decisions already made.
//
// ONE STACK FOR THE FIRST BOSS, TWO FOR THE SECOND, and up from there. See
// CONFIG.boss.dividend for why it ramps rather than paying flat.
//
// WHEN IT OPENS is most of the work here. Four things have to be out of the way
// and each of them is several seconds long: the kill shot owns the clock and the
// camera, the level the kill probably granted owns the screen, the run has to
// still be alive, and nothing else may already be holding the water still. So
// the payout is BANKED on the frame the boss dies and spent on the first frame
// the run is clear — which on a normal kill is about three seconds later, with
// the cards already taken.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE AUTOMATIC HALF OF THE BOSS PAYOUT — a pellet, every time, no menu.
//
// The dividend below is a ceremony: it stops the water, flies the hive in and
// asks the player which card to deepen. This is deliberately the opposite kind
// of reward — nothing opens, nothing is chosen, the gun is simply wider on the
// next volley. See applyBossGrowth in stats.js for why the run wants both.
//
// A MIRROR, NOT A TALLY. `bossState.defeated` stays the only place a boss kill
// is counted; this copies it onto the player and re-derives. Comparing the two
// numbers is the edge detector — there is no second "paid" counter to fall out
// of step, and a reset that puts `defeated` back to 0 is picked up by the same
// branch rather than needing its own line.
//
// OUTSIDE updateBossDividend on purpose, though both are billed by the same
// kill: that function returns early when the ceremony is switched off, and the
// pellet is not the ceremony's to withhold. It also does not wait for the kill
// shot or the cards the way the stacks do — there is no screen to queue for,
// and a payout with no ceremony has nothing to be interrupted by.
// ---------------------------------------------------------------------------
function updateBossShot() {
  if (player.bossesDefeated === bossState.defeated) return;
  const gained = bossState.defeated > player.bossesDefeated;
  player.bossesDefeated = bossState.defeated;
  if (gained) crumb('boss:defeated', bossState.defeated);
  recomputeStats();
  // ONLY ON THE WAY UP. The comparison above is a mirror and so is true in
  // both directions — a restart puts `defeated` back to 0 and comes through
  // here to re-derive the block, which is correct and is emphatically not a
  // payout to announce.
  //
  // The line follows the seal and ripples in and out; both are on the event
  // (CONFIG.feedback.bossPellet), not asked for here. Positioned off the mesh
  // rather than off a cached x/y for the reason enemies have none: the
  // position IS the mesh.
  if (gained && player.mesh) {
    feedback('bossPellet', { x: player.mesh.position.x, y: player.mesh.position.y });
  }
}

function updateBossDividend() {
  if (CONFIG.boss?.dividend?.enabled === false) return;
  // BILLED ONCE PER KILL, by comparing against a count rather than by listening
  // for an event: systems/boss.js publishes `defeated` and knows nothing about
  // the hive, which is the right way round — a boss should not have to import a
  // menu. `bossesPaid` is what stops this branch from being true on every frame
  // for the rest of the run.
  if (bossState.defeated > bossesPaid) {
    bossesPaid = bossState.defeated;
    // The ramp lives with the ceremony rather than here, so it can be checked
    // with real numbers instead of by beating four bosses — see
    // bossDividendStacks.
    pendingBossStacks += bossDividendStacks(bossesPaid);
  }
  if (!pendingBossStacks) return;
  // The queue, in order of who owns the screen. `levelUpState.active` covers
  // both the level-up cards AND this menu — the dividend rides the same ramp —
  // so `hiveRewardActive` is not redundant with it: the ramp ends the moment the
  // last stack is taken, while the hive is still flying home.
  if (!gameState.running || gameState.paused) return;
  if (bossKillState.active || levelUpState.active || hiveRewardActive()) return;
  if (pendingLevels > 0) return;
  const stacks = pendingBossStacks;
  pendingBossStacks = 0;
  openBossDividend(stacks);
}

function openBossDividend(stacks) {
  crumb('dividend', stacks);
  // THE SAME RAMP THE LEVEL-UP SCREEN RIDES, and for the same three reasons: it
  // is what drops the ocean into slow motion behind the menu, it is what
  // `canPause` reads to keep a second menu off the top of this one, and it is
  // what hands the world back on its own curve afterwards. What is NOT reused is
  // the salute — the seal has just finished a kill shot, and a level-up pose on
  // top of that is two celebrations for one event.
  gameState.paused = true;
  duckForUpgrade();
  startLevelUpTime(() => {
    const opened = startHiveReward({
      stacks,
      // ASKED FRESH ON EVERY TILE, EVERY TIME. levelableUpgrades() is where the
      // caps, the disabled rows and the best tier a card was taken at all live
      // (entities/player.js), and a stack taken during the ceremony can push its
      // own card to its cap — so the answer changes underneath the menu.
      canStack: (id) => levelableUpgrades().some((u) => u.id === id),
      onStack: (id) => {
        const entry = levelableUpgrades().find((u) => u.id === id);
        // Raced with its own cap, which the ceremony re-asks about but a click
        // arriving on the same frame as a rebuild could still slip past.
        if (!entry) return false;
        // At the BEST TIER this card has already been taken at, exactly as the
        // level blob pays — see the note in levelableUpgrades. A stack dealt at
        // the floor would quietly dilute a Legendary.
        addUpgrade(entry.id, entry.rarity);
        setHiveUpgrades(player.upgrades);
        // Timestamped like a card pick, so the balance report charges the
        // ability for the time it actually held rather than treating a boss
        // stack as free depth it never had to earn.
        playtest.recordUpgrade(entry.id, gameState.time);
        return true;
      },
      onDone: () => {
        gameState.paused = false;
        sweepOpen();
        endLevelUpTime();
      },
    });
    // Nothing to spend it on — every card held is capped, or the hive is
    // switched off. The run must come straight back rather than sit paused
    // behind a menu that never opened.
    if (!opened) {
      gameState.paused = false;
      sweepOpen();
      endLevelUpTime();
    }
  });
}

// ---------------------------------------------------------------------------
// THE LEVEL BLOB PAYING OUT — one more stack of something already held.
//
// WHY IT IS A STACK AND NOT A CARD. A new upgrade is a DECISION, and a decision
// belongs on the level-up screen with three of them side by side and the world
// stopped. Handing one over mid-fight, at random, at a moment the player was
// looking somewhere else, would be the only thing in the game that changes a
// build without being chosen. Deepening something the player already chose is
// not that: it says yes to a decision they already made.
//
// WHICH ONE IS UNIFORM over what CAN be deepened — see levelableUpgrades in
// entities/player.js, which is where the cap, the disabled rows and the tier
// are decided. Not weighted toward the shallow end, deliberately: a bias toward
// whatever is on one stack would quietly turn the blob into a card-spreader,
// which is the same "the game chose for you" problem one step removed.
//
// It pays nothing at all when there is nothing to deepen. That is reachable —
// the spawn gate is checked at spawn and the blob then floats for `lifetime`,
// during which the last levelable card can hit its cap — and the honest answer
// is a silent no-op rather than a consolation prize the player did not ask for.
// Returns what it levelled, or null, so the caller can stay quiet.
function applyLevelOrb() {
  const pool = levelableUpgrades();
  if (!pool.length) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  // At the best tier this card has already been taken at, not at the floor —
  // see the note in levelableUpgrades.
  addUpgrade(pick.id, pick.rarity);
  setHiveUpgrades(player.upgrades);
  // The same arrival beat a card flying into the corner ends on (see
  // flyCardToHive in ui/ui.js): the tile slams and the rest of the hive ripples
  // out from it. Fired here rather than left to the pulse a firing ability
  // makes, because this is the corner GAINING something and it should read the
  // way the other way of gaining something reads.
  slamAndRipple(pick.id);
  return { id: pick.id, level: pick.count + 1 };
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
  // ...and the shell itself, opening inside its own flash. The flash is light
  // and the emitter is debris; this is the only part of a detonation that is
  // the object the player was actually tracking. See systems/musselShell.js.
  //
  // Handed the heading rather than the projectile: the shell only needs the
  // direction it arrived on, and passing the whole projectile would tempt the
  // system into reading a size off it that its own asset row already owns.
  spawnMusselShell(x, y, { dirX: projectile.dir?.x, dirY: projectile.dir?.y });
  return cfg.replacesBulletHit !== false;
}

// --- WHAT THE CLUB WAS MADE OF ----------------------------------------------
//
// The accent burst behind every club event, and there is one helper rather
// than six inline feedback() calls so that a club event cannot ship without
// its substance — which is exactly what happened to the whack, the carom, the
// shockwave and the freeze, all of which threw the same generic spray whatever
// was swinging.
//
// systems/club.js fills a shared record the instant before it calls a hook and
// `clubHitFx()` reads it back. That is what let all six of these arrive
// without touching a single hook signature — including `onFreeze`, whose call
// comes back out of systems/elements.js and could never have carried a club
// argument without teaching the element system what a club is.
//
// `event` overrides the club's own substance, for the two events that are not
// about the club at all: a keg goes off in embers whichever club set it off,
// and a body locking solid is frost whichever club iced it.
//
// The three multipliers are the CALLER's accent on top of the club's own — how
// much of the event this particular one is, like the falling scale on a carom
// chain — and are never the growth itself. That lives in CONFIG.club.fx.
function clubAccent(x, y, { event = null, amount = 1, size = 1, speed = 1 } = {}) {
  const f = CONFIG.club.fx ?? {};
  if (f.enabled === false) return;
  const fx = clubHitFx();
  const name = event ?? f.accent?.[fx.asset];
  if (!name) return;
  feedback(name, {
    x,
    y,
    dirX: fx.dirX,
    dirY: fx.dirY,
    scale: fx.amount * amount,
    sizeMul: fx.size * size,
    speedMul: fx.speed * speed,
  });
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

  // A THROWN CLUB LANDING. The one club attack whose impact does NOT come
  // through systems/club.js — it is an ordinary projectile by the time it
  // arrives, and combat.js resolves it — so it was the one club attack still
  // landing as a generic spark. Its debris on top of that spark rather than
  // instead of it, the same relationship the Glow Up! bursts have with the
  // pellet.
  //
  // KEYED ON THE ASSET through the same table every other club accent uses, so
  // a club type that learns to be thrown is a row in config and nothing here.
  // `trailScale` is what the shot carries out of fireClubThrow — how much the
  // Hurler's stacks bought — and its wake and its debris read the one number
  // rather than growing apart.
  const clubShed = CONFIG.club.fx?.enabled !== false
    && CONFIG.club.fx?.accent?.[projectile?.mesh?.name];
  if (clubShed) {
    const grow = projectile.trailScale ?? 1;
    feedback(clubShed, {
      x: x ?? e.mesh.position.x,
      y: y ?? e.mesh.position.y,
      dirX: projectile.dir?.x ?? 0,
      dirY: projectile.dir?.y ?? 0,
      // The club's own travel, so the chips carry on rather than hanging where
      // it stopped — `clubChips` inherits a quarter of it.
      vx: (projectile.dir?.x ?? 0) * (projectile.speed ?? 0),
      vy: (projectile.dir?.y ?? 0) * (projectile.speed ?? 0),
      scale: grow,
      sizeMul: grow,
      speedMul: grow,
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
      // The shot's own bang, if it brought one. Everything that doesn't falls
      // through to `bigKill` in processPendingSplashes, which is where every
      // splash in the game used to land whether or not anything died.
      feedback: projectile.splashFx ?? undefined,
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
    //
    // A STRING NAMES ITS OWN EVENT instead, which is the middle case the
    // false/undefined pair never had: a mussel going off is neither silent nor
    // a creature dying, and borrowing `bigKill` told the player eight things
    // had died every time a barrage landed. See the note on `splashFx` in
    // entities/projectiles.js.
    //
    // The name is hoisted rather than written inline, and that is not style:
    // the feedback audit in tools/upgrade-test.mjs finds every event the source
    // fires by scanning for a literal inside a feedback() call, and a ternary
    // in the argument slot hands it whichever string it saw first.
    if (s.feedback !== false) {
      const blastFx = typeof s.feedback === 'string' ? s.feedback : 'bigKill';
      feedback(blastFx, { x: s.x, y: s.y, scale: s.feedbackScale ?? 1.3 });
    }
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
 *
 * `iFrames` lets a source ask for a longer window than the standard one. It is
 * folded in with Math.max, so it can only ever lengthen — see the block below.
 *
 * RETURNS WHAT IT ACTUALLY BILLED — 0 for a blow the i-frame window refused or
 * a boss ceiling trimmed to nothing, and the trimmed figure otherwise. Almost
 * every caller ignores it, and should: a source that fired is done, and asking
 * whether it landed is how a system starts second-guessing the funnel.
 *
 * The exception is a source that has to SPEND SOMETHING to swing. A barracuda's
 * bite clock (see `contactBite` in systems/combat.js) is reset by the bite, and
 * resetting it on a bite that was refused is what put a whole pack into
 * lockstep: five fish whose clocks expired on the same frame all paid for the
 * one bite that landed, and then all reset together, forever — five animals
 * billing exactly what one of them did. They have to keep asking until one of
 * them is the one that gets through.
 */
function onPlayerHit(dmg, dir, source = 'unknown', channel = 'attack', iFrames = 0) {
  // ---------------------------------------------------------------------------
  // THE I-FRAME WINDOW, and the one place it is spent. See
  // CONFIG.player.hitIFrames for the argument; the short version is that this
  // game has two kinds of damage and only one of them can pile up.
  //
  // A per-second DRAIN — a body you are overlapping, an electric aura, a beam
  // burning through you — is already bounded by being a rate, and refusing it
  // in bursts would read as the damage flickering rather than as the player
  // being safe. Those keep the channels they have always had.
  //
  // A 'strike' is a whole number arriving on one frame: a crab's pinch, a
  // trap's snap, a shell landing. Nothing stopped six of those landing
  // together, and after the crab layer moved its entire damage budget into the
  // pinch (see CONFIG.crabClaw.contactMul) a swarm shutting its claws inside a
  // few frames of each other could take half the bar with one flash to show
  // for it. One is paid; the rest of the swarm still swings and still gets its
  // turn as soon as the window is up.
  //
  // BEFORE capBossDamage, deliberately. A refused blow must not spend from the
  // boss's rolling per-second budget on the player's behalf — that would let a
  // crab's pinch quietly eat the ceiling the boss's own attacks are measured
  // against.
  //
  // Callers opt IN by naming the channel, so a damage source added tomorrow
  // gets the old behaviour rather than a silent i-frame it did not ask for.
  if (channel === 'strike') {
    if (player.invuln > 0) return 0;
    // `iFrames` is a source asking for a LONGER window than the standard one —
    // a contact bite does, because the pack it comes from gives no tell (see
    // CONFIG.player.biteIFrames). Inside the same Math.max as everything else,
    // which is the whole safety property: a caller can lengthen the seal's only
    // defence and can never shorten it, whatever it passes.
    player.invuln = Math.max(
      CONFIG.player.hitIFrames ?? 0, player.stats?.invulnAfterHit ?? 0, iFrames ?? 0,
    );
  }
  // THE ONE PLACE EVERY POINT OF DAMAGE ARRIVES — contact, shots, perks,
  // blasts — which is why the boss's ceilings are applied here rather than at
  // the sources. See capBossDamage: it trims a boss down to what it is allowed
  // to take in one hit and in one second, and returns everything else exactly
  // as it came. Ordinary wildlife is untouched.
  //
  // `channel` separates the two kinds of damage a boss deals, because they
  // want different ceilings and the shared one let the wrong one win. 'contact'
  // is the per-frame drain from overlapping the body; everything else is
  // something the animal aimed. Only the boss cap reads it — the ledger, the
  // hit flash and the shove are all channel-blind, since they describe what
  // the player felt rather than where it came from.
  //
  // Before recordPlayerDamage, so the playtest ledger records what the player
  // actually took. Filing the uncapped figure would leave every incoming-damage
  // reading in the report describing a game nobody played.
  dmg = capBossDamage(dmg, source, player.stats.maxHp, gameState.time, channel);
  if (!(dmg > 0)) return 0;
  playtest.recordPlayerDamage(dmg, source);
  lastDamageSource = source;
  // AND WHO IT WAS, if it was a boss. Every boss source is either the
  // archetype key ('bossOrca') or one of its attacks ('boss:boatSalvo'), so the
  // prefix is the whole test.
  //
  // Read HERE and not at death, which is minutes and possibly two more bosses
  // away: bossState.name is the boss currently in the water, and the one that
  // took this hit may be long dead by the time the seal is. Banked per hit for
  // the same reason `lastDamageSource` is — the last thing to touch you is what
  // the headstone gets to name.
  lastDamageBoss = source.startsWith('boss') ? (bossState.name || null) : null;
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
      if (shove > 0) {
        // WHAT IT ACTUALLY IMPARTED, not what the row asked for:
        // applyPlayerKnockback trims to CONFIG.playerKnockback.maxSpeed and
        // returns the trimmed figure, and systems/slam.js prices the shove off
        // its speed. Billing the row's number would charge for a shove the
        // seal never received the moment anyone retunes past the cap.
        const got = applyPlayerKnockback(dir.x, dir.y, shove);
        // QUEUED, not charged here. This is inside onPlayerHit; charging the
        // impact now would be onPlayerHit calling itself from inside its own
        // body, past its own i-frame gate. updateSlam spends it on the next
        // frame, which is also the first frame the shove has moved anybody.
        noteShove(got, source, dir);
      }
    }
  }
  if (player.hp <= 0 && !deathState.active) killPlayer();
  return dmg;
}

/**
 * A SET OF JAWS ACTUALLY CLOSING ON THE SEAL.
 *
 * Fired from the bite hook in entities/enemies.js, on the one frame the snap
 * commits — already rate-limited to the species' own eat cooldown, already
 * gated on the player being inside reach, and already the frame the mouth
 * moves on screen. All of which is why this is the right place for the damage
 * and the old inline `feedback('bite')` was not enough on its own.
 *
 * IT USED TO BE FREE. The chomp was a sound, a puff and a pose, and the
 * roster's four chasing bosses — the shark, the orca, the mosasaur, the
 * hammerhead — had no attack of any kind: every point of health they took off
 * you came from the per-second drain of overlapping their body. So the
 * megalodon's authored 1.30s bite and the mosasaur's 62 degrees of gape were
 * theatre played over a number that did not care where the animal's head was.
 *
 * IT IS NO LONGER ONLY THE BOSSES. `biteDamage` used to be blank for every
 * wildlife row, and the note here used to say it would stay that way — a shark
 * eating you was a contact drain and the chomp over the top was theatre. That
 * was the honest description of an animal with nothing to dodge: a cruise
 * hunter drifting at you at seven units a second, costing health for being in
 * the same place as you, with no moment in it that could miss. The six apex
 * sharks now commit to a readable pass (see `shark.lunge`) and fill this cell
 * in, so the pass ARRIVING is worth something and the pass MISSING costs the
 * shark its turn. Contact damage stayed exactly where it was; this is a second
 * channel, gated on the head, not a replacement for the first.
 *
 * AND IT LANDS AT THE FRONT OF THE ANIMAL, which is a second gate and not the
 * one that fired the snap. `playerBiteReach` is deliberately enormous — it is
 * multiplied by CONFIG.bite.lead, so on a boss the jaws start opening from
 * about twenty-five units away, a whole body length, because the anticipation
 * is most of what sells a bite on something that size. Billing damage on that
 * gate would mean a megalodon biting you with its tail, which is the exact
 * complaint this whole change is answering, one channel along.
 *
 * IT IS MEASURED FROM `mesh.position`, and that is a fact about these bodies
 * rather than an approximation anybody should assume about the next one. On
 * every rig that bites, the container's origin sits near the HEAD and not at
 * the middle of the animal — the megalodon's snout is 3.9 units in front of it
 * and its tail 21.9 behind, and the orca, the mosasaur, the hammerhead and the
 * anglerfish all measure the same way. So a modest sphere around the origin IS
 * the head, and it needs no rig to find.
 *
 * WHICH IS WHY IT IS NOT THE HEAD CHAIN'S TIP, which was the obvious answer and
 * is worse in three ways: enemyBossAnglerfish ships no lookRig at all, so one
 * of the five would have had no snout to measure from; the tip is only written
 * on frames the chain actually solves, so it holds the zero vector on the first
 * frame of a fight, which reads as a mouth at the world origin; and on the
 * hammerhead it solves to 0.4 units from the container anyway. Measured, the
 * simpler thing is also the more accurate one. tools/boss-bite-test.mjs is what
 * holds that claim, on the real bodies, so a new boss whose model is built
 * around its middle fails there instead of biting with its tail.
 */
function onPlayerBite(e) {
  const dmg = e.biteDamage ?? 0;
  if (!(dmg > 0) || isInvulnerable()) return;

  const reach = (e.radius ?? 1) * (CONFIG.bite?.mouthReach ?? 0.55)
    + (player.stats?.hitRadius ?? 0.5);
  const mx = e.mesh.position.x - player.mesh.position.x;
  const my = e.mesh.position.y - player.mesh.position.y;
  if (mx * mx + my * my > reach * reach) return;

  // A CLEAN BITE FROM A BOSS THAT HOLDS. Inside this gate and nowhere else,
  // which is the whole contract of systems/bossGrab.js: the grab is earned by
  // the same test the damage is, so a boss cannot take hold of you with its
  // flank and cannot take hold of you at the end of a pass you sidestepped.
  // Everything else about it — which archetypes may, how often, for how long —
  // lives in that file and in CONFIG.bossGrab.
  //
  // Fired BEFORE the damage, so the grab's own hitstop and its snare land on
  // the frame the jaws shut rather than a frame behind the number.
  tryBossGrab(e);

  // Shoved away from the head rather than from wherever the body's mass is,
  // which is the one place in the game that distinction is worth making: the
  // whole point of a bite is that it happened at a particular end of an animal.
  //
  // 'strike' rather than 'attack': a set of jaws closing is the definitive
  // discrete blow, and it belongs in the same window as the pinch and the trap
  // — see the i-frame block at the top of onPlayerHit. It is also what keeps a
  // shiver of six sharks from billing six clean bites inside one frame now
  // that every one of them carries a `biteDamage`.
  onPlayerHit(dmg, { x: -mx, y: -my }, e.type, 'strike');
}

function onEnemyKilledFeedback(e, killEvent = null) {
  gameState.kills += 1;
  // ONE FOR YOUR SIDE, if it came off a bait ball. This funnel is every way a
  // creature dies to the player — shot, strike, element, companion, net — so
  // it is the one place the player's half of the exchange can be counted
  // without threading a flag through six ability systems. The predator's half
  // is booked in systems/predation.js; see baitBallLedger for what the two
  // become. A no-op on anything that was not in a ball.
  if (e.baitBall) noteBaitLoss(e.schoolId, 'player');
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

/**
 * A SOFT CEILING — approaches `cap` and never reaches it.
 *
 * `cap * (1 - e^(-v/cap))`, which is the one curve that does both things this
 * needs at once: its slope at 0 is exactly 1, so small values pass through
 * essentially unchanged and nothing is quietly taken away from the shallow end
 * everything was tuned at; and it saturates, so no input however large can put
 * more than `cap` out the other side.
 *
 * WHY NOT Math.min. A clamp keeps the value legal and throws the SIGNAL away:
 * everything past the threshold maps to the same number, so a chain of 5 and a
 * chain of 300 shove the grid identically, and the effect stops tracking the
 * thing it exists to describe at the exact depth that thing gets interesting.
 * A feathered ceiling keeps every step distinguishable — smaller and smaller,
 * which is honest, rather than absent.
 */
function softCap(v, cap) {
  if (!(cap > 0)) return 0;
  return cap * (1 - Math.exp(-Math.max(0, v) / cap));
}

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
    // NO POSITION. The banner is pinned above the seal (ui/ui.js) and holds
    // for as long as the chain window does, so the point the mouthful was
    // swallowed at — which is what `x, y` used to place it at — is not where
    // the announcement goes. The two coordinates are still what the JUICE
    // above is fired at, which is a different question: the ripple and the
    // burst belong to the food, the banner belongs to the animal.
    spawnChainToast(chain);
    if (ceremony) {
      lastChainCeremony = gameState.time;
      world.punchCamera((fc.punch ?? 0.045) + (fc.punchPerChain ?? 0.012) * depth);
      // THE PUNCH IS THE WHOLE CAMERA RESPONSE. There used to be a cinecam
      // state here too — a 1.62 push-in held for over a second — and a chain
      // ceremony fires often enough that the rig spent most of a good run
      // travelling between that and base, which read as constant popping. A
      // moment that repeats this often cannot own the frame; it gets the kick
      // and the banner, and the lens stays where the player left it.
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
    // AND THE GRID ITSELF GETS SHOVED HARDER THE DEEPER THE CHAIN GOES —
    // FEATHERED TOWARD A CEILING RATHER THAN RUNNING AT ONE.
    //
    // Both numbers used to be linear in `chain`, and the RADIUS was not capped
    // at all: `8 + chain * 2`. That is fine for the chain depths this was
    // written against and absurd for the ones the game actually reaches — a
    // 313-link chain asked for a ripple 634 units across, against an arena 80
    // units wide (arena.js `bounds.width`). Every node in the field was inside
    // one ripple, so a link stopped being a shove AT THE SEAL and became the
    // whole backdrop lurching, which reads as the renderer breaking rather than
    // as the player doing something extraordinary.
    //
    // The strength had the opposite failure and it is the same mistake: it was
    // linear into a hard `Math.min`, so it hit its ceiling at chain 5 and every
    // link past that was identical. A clamp is not a ceiling you can feel, it
    // is a wall the effect slams into and then stops saying anything.
    //
    // So both are softened toward their cap instead (see softCap): linear while
    // the chain is shallow, where the growth is the thing being communicated,
    // and asymptotic afterwards, where it is not. The min() below stays as a
    // backstop — softCap cannot exceed its cap, and a guard that can never fire
    // is the right kind of guard on a value that reaches the vertex shader.
    const g = CONFIG.strike;
    const warp = softCap(chain * (g.comboGridWarp ?? 1.6), g.comboGridWarpMax ?? 8);
    // ONLY THE GROWTH IS FEATHERED, NOT THE BASE. Softening the whole
    // `base + chain * per` pulls the shallow end down with it — a first link
    // came out at 7.87 where it has always been 10, which is a fifth taken off
    // the most common link in the game to solve a problem that only exists at
    // the other end. The base passes through untouched and the cap is what the
    // TOTAL approaches.
    const base = g.comboGridRadiusBase ?? 8;
    const radius = base + softCap(
      chain * (g.comboGridRadius ?? 2),
      Math.max(0, (g.comboGridRadiusMax ?? 20) - base),
    );
    world.grid.ripple(x, y, warp, radius);
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
  // `!taken` on purpose: a clam already swallowed is riding the seal and there
  // is nothing left to swim into, so a tip that fired for one would be telling
  // the player to go and get something they are wearing.
  if (kind === 'attractorOrb') return attractorOrbs.some((o) => !o.taken);
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
  // A PLACE ON THE GLASS rather than one in the water — the only subject in the
  // table that is not somewhere the seal could swim. It answers every frame
  // while the corner has anything in it, so like the two above it there is
  // nothing here to go stale.
  if (kind === 'hive') return hiveRect() ? { kind } : null;
  if (kind === 'hotspot') {
    // ONE SPECIFIC SPOT, held by reference like every other subject: a weak
    // spot ruptures and another opens somewhere else on the animal seconds
    // later, and re-asking for "the nearest one" every frame would walk the
    // label round the boss without anything having happened.
    //
    // The nearest one IN STRIKE RANGE, which is the same test the step's own
    // `ready` uses one level up. Two answers to "which spot is this tip about"
    // is how a label ends up standing on a different hole from the one the
    // sentence was offered for.
    const boss = bossState.enemy;
    if (!boss) return null;
    const reach = strikeReach(player.stats);
    let best = null;
    let bestD = reach;
    for (const spot of liveHotSpots(boss)) {
      const at = hotSpotPoint(spot);
      // Its own radius counts as reach: a big spot is strikeable from further
      // out than a small one, the same reasoning the unkillable tip uses.
      const d = Math.hypot(at.x - x, at.y - y) - (at.r ?? 0);
      if (d < bestD) { bestD = d; best = { kind, enemy: boss, spot }; }
    }
    return best;
  }
  if (kind === 'chum') {
    const handle = chumEntry(x, y);
    return handle ? { kind, handle } : null;
  }
  if (kind === 'pickup') {
    // The row's own id names the type — one string end to end, see the note on
    // PICKUP_TIPS. The attractor is the one that lives somewhere else.
    if (id === 'attractorOrb') {
      // The one still in the water, for the same reason pickupInWater skips a
      // taken one — the arrow has to point at something the player can reach.
      const orb = attractorOrbs.find((o) => !o.taken) ?? null;
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
// The clam and the coral are NOT here any more. Both are composed objects whose
// own systems write their colours every frame (systems/attractiveClam.js,
// systems/coralOrb.js), which is exactly the case 'paint' must not take: a
// claimed material would be overwritten by its owner on the next line and the
// highlight would silently do nothing. They answer 'ask' and multiply the pulse
// in themselves, which is the mode that exists for objects with a writer.
//
// The bubble stays listed and is REFUSED by telegraph's own guard, on purpose:
// it wears a fresnel film now (an injected shader), and a clone of that
// material would drop the injection and render the bubble as a flat white ball
// for as long as the coach was explaining it. It falls back to no push — the
// tip still stands beside it and the arrow still finds it. See paintable().
const PAINTED_SUBJECTS = new Set(['bubbleOrb', 'strikeOrb']);
function telegraphModeFor(stepId) {
  return PAINTED_SUBJECTS.has(stepId) ? 'paint' : 'ask';
}

function subjectAt(handle) {
  if (!handle) return null;
  const x = player.mesh.position.x;
  const y = player.mesh.position.y;
  if (handle.kind === 'surface') return { x, y: bounds.surfaceY };
  if (handle.kind === 'hive') {
    const r = hiveRect();
    if (!r) return null;
    // THE TOP EDGE, in world units. The label is drawn a fixed gap ABOVE
    // whatever world point it is given (see drawWorld in ui/callout.js), so
    // anchoring on the middle of the block would put the sentence across the
    // tiles it is pointing at. Converted rather than special-cased: the callout
    // layer positions everything from a world point, and a second code path for
    // "a tip about a piece of chrome" would be a whole surface's worth of
    // clamping and dissolve logic written twice. See screenToWorld.
    //
    // NO MESH, deliberately — there is nothing in the scene to light up, and
    // the tile the coach would want to pulse is a div. The hive does its own
    // announcing on a pick (see slamAndRipple).
    return screenToWorld(world.camera, r.left + r.width / 2, r.top);
  }
  if (handle.kind === 'hotspot') {
    // Gone the moment it ruptures, which is what ends the tip: the light goes
    // out and the crit zone with it, and a label left standing on unlit flesh
    // would be pointing at a place that no longer does anything.
    if (!hotSpotLit(handle.enemy, handle.spot)) return null;
    const at = hotSpotPoint(handle.spot);
    // No mesh handed back, for the same reason a creature's is not: the boss
    // wears a skin, an outline and a shell of its own (systems/bossHotSpots.js
    // paints the spot INTO the animal's geometry), and the highlight system
    // would either refuse it or break it. The spot is already the brightest
    // thing on the animal — it does not need the coach's help to be found.
    return { x: at.x, y: at.y };
  }
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
function collectChum(value, x, y, healMul = 1, fromFloor = false) {
  // The first-run "eat chum" tip is answered here rather than at any of the
  // three call sites above it, because this is the one funnel every route into
  // eating goes through — swum over, hoovered by a gulp, or handed over by the
  // attractor orb. A tip cleared by only one of those would stay on screen
  // through a player doing exactly what it asked.
  noteTutorialEvent('chum');
  // ...AND THE SEABED TIP IS ANSWERED BY THE SAME MOUTHFUL, when the orb is one
  // that had settled on the floor. `fromFloor` is the orb's own latch rather
  // than a test on `y` here: the magnet lifts a settled orb most of the way up
  // the arena before the mouth reaches it, so where it was when it was
  // swallowed is not where the player had to go to get it. See the latch in
  // entities/pickups.js. A crew body eaten mid-water calls this with four
  // arguments and so is never one.
  if (fromFloor) noteTutorialEvent('floorChum');
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
  // Thinner the fuller the water is — see CONFIG.pickups.healRamp. Read off
  // the run clock HERE, at the mouth, rather than off the orb: what a mouthful
  // is worth as health is a fact about how much food is around when you eat it,
  // not about the creature it fell out of. A chunk (spawnChumChunk) takes a
  // different path and is deliberately untouched.
  const heal = player.stats.maxHp * CONFIG.pickups.healFraction * healMul
    * chumHealRamp(gameState.difficulty);
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

// `gap` is the seconds until the NEXT shot sound, which is the volley interval
// only while both fins fire together — with alternating fins the sounds are
// twice as close as the volleys are, and a decay fitted to the volley would
// have each flipper's shot still ringing when the other one fires. The pitch
// still rides `interval`, because that is the gun's rate and it has not
// changed: pitching the base gun up to the Rapid Fire voice for a cadence
// nobody bought would spend the whole rise before the first card.
function shotSfxOpts(interval, gap = interval) {
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
    opts.decayMul = Math.min(1, (gap * (cfg.decayHeadroom ?? 0.85)) / decay);
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

// Seconds between basic shots, right now — every multiplier folded in and the
// result put on the bar grid.
//
// Split out of fire() because the SCHEDULER needs it too: shotGrid.js is asked
// every frame whether a shot is due, and the answer depends on the interval,
// so a number computed inside fire() would only exist on the frames it already
// fired. Every multiplier here is a power of two on purpose — see
// CONFIG.weapon.beatLock — and snapToBarGrid is what catches the air ramp,
// which is continuous and cannot be.
function shotInterval() {
  const s = player.stats;
  const rapid = rapidFireTimer > 0;
  // `fireRate` is an INTERVAL, so both multipliers divide it — the same
  // direction the rapid-fire pickup already went. Air time is folded in here
  // rather than into the stat block because the ramp changes every frame and
  // the block is only rebuilt on level-up; see the note at the top of
  // systems/airborne.js. It is 1 for a seal in the water.
  const raw = (rapid ? s.fireRate / CONFIG.rapidFirePickup.fireRateMul : s.fireRate)
    / airFireRateMul();
  return snapToBarGrid(raw, CONFIG.weapon.beatLock?.maxDivision ?? 64);
}

// WHICH FLIPPER A PELLET CAME OFF, as the run summary's ledger key.
//
// '<side>' for a plain stone and '<side>:<element>' for a lit one, so one key
// answers both halves of the same question — a run with Flippers Up! four times
// has a left fin throwing one element and a right fin throwing another, and two
// separate tallies could say which fin dealt more and which element dealt more
// without ever saying that the venom was the right one.
//
// Null for everything that did not leave a flipper: the mussels, the scallops,
// the escorts' fire, the strike, and the basic shot itself on a model with no
// fin rig. `recordDamage` skips the split entirely on a null, so nothing that
// has no side is filed under one.
//
// The ELEMENT is read off the pellet rather than looked up now, deliberately.
// It is what that fin was carrying when the shot was FIRED — a stone thrown
// before the card was taken should not be credited to the element it arrived
// too early for, and a pellet is in the water long enough for that to happen.
function finKey(projectile) {
  const side = projectile?.finSide;
  if (!side) return null;
  return projectile.finElement ? `${side}:${projectile.finElement}` : side;
}

// HOW MANY STONES ONE VOLLEY IS, across every flipper. The whole volley and
// not one fin's share — see CONFIG.weapon.multishot.
//
// Split out of fire() because the SCHEDULER needs the same number: the volley
// is dealt one stone per tick, so the pellet count is what sets how many ticks
// an interval holds, and shotDue is asked every frame whether or not fire()
// runs. Two copies of this arithmetic drifting apart would be a gun ticking on
// a cycle length its own volley disagreed with.
//
// Clone Warz first, THEN the pickup's multiplier — so the temporary powerup
// multiplies the gun you actually have rather than the one you started with.
function volleyShots() {
  const s = player.stats;
  const pellets = projectileCount(s.multishot, s);
  return rapidFireTimer > 0
    ? Math.round(pellets * CONFIG.rapidFirePickup.multishotMul)
    : pellets;
}

function fire() {
  const s = player.stats;
  const fireRate = shotInterval();
  const shotCount = volleyShots();
  // WHICH GUN THIS RUN ROLLED. Read once for the volley — every pellet in it is
  // the same weapon — and it forks exactly four things: the body, the flight,
  // the fan and the payload. Everything else below is untouched, which is the
  // point: the cadence, the flipper alternation, the per-fin size and element,
  // the recoil, the muzzle flash and the ledger are all the GUN, and a loadout
  // that had its own copy of any of them would be a second gun to keep in step.
  const laser = isLaser(s.loadout);
  const lc = CONFIG.finLaser ?? {};

  const dir = input.aim.clone().normalize();
  // `shotCount` is the volley's WHOLE pellet count, across every flipper — not
  // a per-fin one. See CONFIG.weapon.multishot: the change is what Pocket Full
  // of Stones buys, and it is why a stone bought there is a rhythm rather than
  // a wider fan.
  //
  // A model with no rig (or the emit points switched off) fires the same
  // TOTAL number of bullets from the body, fanned by the old `spread`, so
  // turning this off is a visual change and not a damage change.
  const rig = player.aimRig;
  const source = CONFIG.emitPoints.bullet;
  const points = emitPointCount(rig, source);
  const origins = Math.max(1, points);
  // Pellets sharing one tick get the tiny per-fin offset; pellets on ticks of
  // their own are already separated in TIME and need none, and a volley with
  // no limbs to walk falls back to the normal spread so it still fans.
  // ...times whatever the alternating card has bought. `finSpreadMul` is 1 on
  // every pebble run and on a laser run that has taken no even-numbered stack
  // of André 3000, so this is the fan it has always been until something buys
  // it. It multiplies BOTH branches deliberately: a rig with fins fans by the
  // small per-fin angle and one without fans by the volley spread, and a card
  // that widened only one of them would do nothing on half the models.
  const fan = (origins > 1 ? CONFIG.weapon.finSpread : s.spread) * (s.finSpreadMul ?? 1);

  // FLIPPERS UP! — how big the pebble out of origin `o` is. The fin defs in
  // assets.js are ordered ['left', 'right'] and `rig.muzzles` is built by
  // mapping over them, so origin 0 IS the left flipper; that ordering is the
  // only thing tying the stat's name to the side the player sees, which is why
  // it is stated here rather than assumed.
  //
  // A model with no fin rig fires everything from the body centre, and there is
  // no side to be on — so it gets the MEAN of the two, and the card is worth the
  // same per second as it would be on the seal. Splitting the difference is the
  // one answer that neither pays the card twice nor quietly voids it.
  const meanFinMul = ((s.leftFinRadiusMul ?? 1) + (s.rightFinRadiusMul ?? 1)) / 2;
  const finRadiusMul = (o) => {
    if (source !== 'fins' || origins < 2) return meanFinMul;
    return o === 0 ? (s.leftFinRadiusMul ?? 1) : (s.rightFinRadiusMul ?? 1);
  };
  // ...AND THE PEBBLE HAS TO LOOK BIGGER, WHICH IS A SECOND NUMBER. `radius`
  // on a projectile is its HIT circle and nothing else — spawnProjectile puts
  // it straight into the collision test and never near the mesh, whose size is
  // the separate `scale`. A card that moved only the radius would widen the
  // hitbox invisibly, which is the worst of both: it plays stronger and reads
  // as nothing.
  //
  // `scale` REPLACES the root scale rather than multiplying it (the
  // `if (scale !== 1)` in spawnProjectile is a setScalar), and that root is
  // where the asset's own size multiplier lives — 1.2 for the pebble, out of
  // assets.csv. So the multiplier is folded in here, read from the asset rather
  // than typed, and an un-upgraded pellet passes exactly the 1.2 createVisual
  // already gave it.
  const bulletSizeMul = getAssetSizeMultiplier('bullet');
  // ...AND WHAT THE HIT CIRCLE IS MEASURED AGAINST. The pebble's shape is
  // authored at this radius in assets.js, so `hitRadius / this` is the factor
  // that draws a stone exactly as big as it hits. It used to be `s.radius`,
  // which normalised the ratio to 1 on an un-upgraded gun and therefore pinned
  // the picture to the asset no matter what CONFIG.weapon.radius said — so a
  // retune of the gun's size moved the hitbox and nothing else, which is the
  // invisible buff the note above calls the worst of both. Falls back to
  // `s.radius` so a pebble built from an uploaded model (no authored radius)
  // keeps exactly the behaviour it had.
  const bulletShapeRadius = assetShapeRadius('bullet') ?? (s.radius || 1);

  // WHICH FLIPPER ORIGIN `o` IS, and what it is carrying. The fin defs in
  // assets.js are ordered ['left', 'right'] and FLIPPER_SIDES is that same
  // order, so the index IS the side — stated in one place rather than compared
  // by eye in three.
  //
  // A body-centre volley (no rig) has no side to be on, so it carries nothing:
  // the mean multiplier above already pays the SIZE half of the card there, and
  // an element is an identity rather than an amount — there is no average of
  // voltaic and venom, and picking one of them would be inventing a fact.
  const fins = finElements();
  const finSideFor = (o) => (source === 'fins' && origins >= 2 ? FLIPPER_SIDES[o % FLIPPER_SIDES.length] : null);
  const finElementFor = (o) => { const side = finSideFor(o); return side ? fins[side] : null; };

  // ONE STONE PER TICK, trading flippers, instead of the whole volley on one
  // frame. The scheduler is already running at interval / ticks (see the
  // shotDue call in the update loop, which asks shotGrid for the same number),
  // so a full cycle puts exactly the pellets in the water that one simultaneous
  // volley did: the volley is split in TIME, not thinned.
  const ticks = finSplit(origins, fireRate, shotCount);
  // WHICH LIMB THIS TICK LEAVES FROM AND HOW MANY STONES ARE ON IT — dealt in
  // systems/shotGrid.js, where the property that matters (a cycle of ticks is
  // one whole volley, split evenly across both flippers, at every pellet count
  // the run can reach) is asserted rather than assumed.
  //
  // The cursor is free-running and deliberately not reset per volley: a cycle
  // whose tick count is not a multiple of the limb count walks the fins around
  // it, so three ticks on two flippers is L R L / R L R — a 3-against-2 that
  // swaps which side carries the odd stone every volley, rather than a limp
  // with the same fin doubled forever.
  const dealt = dealTick(shotCount, ticks, origins, finCursor);
  const salvo = dealt.salvo;
  finCursor = dealt.cursor;
  const firedThisShot = salvo.reduce((n, f) => n + f.n, 0);
  // The fraction of a volley this tick is. 1 when the whole volley fires at
  // once, and it is what keeps the recoil impulse and the exhaust plume per
  // SECOND the same however the volley is dealt — a third of a volley that
  // shoved like a whole one would triple the gun's push on the seal the moment
  // a card was taken.
  const share = shotCount > 0 ? firedThisShot / shotCount : 1;

  // Sonar Teeth. Resolved once per volley rather than per pellet — every
  // pellet in a volley is the same gun, and the object is spread into each
  // spawn below. `null` for a run without the card, which is the only reason
  // the spread is safe: nothing is added to the spawn options at all, so an
  // un-upgraded bullet is byte-for-byte the projectile it always was.
  const seek = homingShotOpts(s.homingShotLevel);

  // WHAT A PELLET IS WORTH AT THIS MANY STACKS OF MULTISHOT. `multishotLevel`
  // and not `multishot`: levelling hands out pellets on its own cadence, and
  // the card's curve is only for the pellets the card bought. Read once per
  // volley — every pellet in it is the same gun.
  const pellet = multishotLevelStats(s.multishotLevel, s);

  // WHERE EACH FLIPPER FIRED FROM. `muzzlePoint` is one shared vector that the
  // loop below overwrites per origin, so by the time the flash is fired it holds
  // the LAST fin only — which was fine while there was one flash for the whole
  // volley, and is not once each fin's flash is a different size and colour.
  const flashes = [];
  for (const shot of salvo) {
    // A limb with nothing to throw gets no flash either. Only reachable on the
    // undealt fallback with fewer stones than limbs — a one-pebble gun routed
    // to a two-flipper rig — and a puff off an empty flipper reads as a shot
    // that failed to spawn.
    if (shot.n <= 0) continue;
    const o = shot.o;
    for (let i = 0; i < shot.n; i++) {
      const offset = (i - (shot.n - 1) / 2) * fan;
      const cos = Math.cos(offset);
      const sin = Math.sin(offset);
      const bolt = spawnProjectile(world.scene, {
        origin: emitPoint(rig, source, o, dir, player.mesh.position, muzzlePoint),
        dir: new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos),
        faction: 'player',
        // Air time rides the damage the same way it rides the cadence above.
        // A seal shooting on the way down is a gun platform, and this is what
        // makes that read as a decision rather than as a detour.
        damage: pellet.multishotDamage * airDamageMul() * (laser ? (lc.damageMul ?? 1) : 1),
        // FAST AND SHORT, and the product of the two is the range — see
        // systems/finLaser.js. `s.life` already carries the reach ramp by the
        // time it gets here (applyLaserReach writes it into the stat block), so
        // this is only the loadout's own reshaping and the two compose rather
        // than fighting: a run that has earned three steps is firing a bolt at
        // 0.42 x 1.45 of the pebble's flight time.
        speed: s.speed * (laser ? (lc.speedMul ?? 1) : 1),
        life: s.life * (laser ? (lc.lifeMul ?? 1) : 1),
        radius: pellet.multishotSize * finRadiusMul(o),
        // The drawn stone, kept in step with the hit circle above. Both terms
        // are ratios against the base pebble, so a run with neither card is
        // byte-for-byte the shot it always was.
        scale: bulletSizeMul * (pellet.multishotSize / bulletShapeRadius) * finRadiusMul(o),
        pierce: s.pierce,
        asset: laser ? LASER_ASSET : 'bullet',
        // STILL THE GUN, on either loadout. Everything downstream is keyed on
        // this string — the ledger's damage attribution, weaponName.js, the
        // hive's routing of the volley, and the `b.source === 'gun'` gate in
        // combat.js that is the only thing letting an element ride the shot at
        // all. A loadout that booked its damage under its own name would lose
        // every one of them at once, silently.
        source: 'gun',
        // WHAT IT SHATTERS INTO. Null on every pebble run, which keeps a stone
        // byte-for-byte the projectile it has always been.
        lattice: laser ? latticePayload(s) : null,
        // What THIS fin is carrying, which is why it rides the pellet rather
        // than being looked up where it lands: two pellets in the same volley
        // can disagree about it. Null on every un-upgraded shot. See combat.js.
        finElement: finElementFor(o),
        // The fin itself, for the run summary's left/right split. Set even when
        // that fin is carrying nothing: an unlit flipper still threw the stone.
        finSide: finSideFor(o),
        // Points the shot at things instead of along the aim. `orient` comes
        // with it so a curving bullet visibly faces where it is going — a
        // seeker drawn on its launch heading reads as a rendering bug.
        ...seek,
        // A BOLT FACES WHERE IT IS GOING; a stone tumbles. The pebble asset is
        // `shape: 'rock'` and gets its own random spin from assets.js, and
        // pointing one along its heading would throw that away — so this is on
        // the laser only rather than on both.
        //
        // 'axis' AND NOT `true`, and on this shape it is the difference between
        // a bolt and a bug. The plain form composes a Ry(PI) mirror after the
        // heading to keep an asymmetric body's belly down, and that mirror is
        // 90 degrees out at leftward DIAGONALS — see the note in
        // projectiles.js. A mussel or a gull is round enough that nobody has
        // ever seen it; a 2.6:1 bolt fired up-left flies visibly SIDEWAYS. The
        // oval has no belly to protect, so it opts out, exactly as the razor
        // clam's blade does.
        //
        // AFTER the seeker spread rather than before it: homingShotOpts sets
        // its own `orient: true`, so a laser run that also took Sonar Teeth
        // would otherwise have the mirror handed straight back to it.
        orient: laser ? 'axis' : (seek?.orient ?? false),
        // LIGHT DOES NOT FALL. Above the surface there is nothing holding a
        // shot up, so a stone thrown out of the water noses over and drops on
        // the same curve the seal does — which is the whole read of a thrown
        // stone and exactly wrong for a bolt. A laser fired on the way up
        // sagged visibly over its flight, and because the fall goes out through
        // `dir` (see updateProjectiles) the bolt also TURNED to follow it: a
        // beam of light bending downward on its way across the sky.
        //
        // Underwater nothing changes — the sea carries every shot, and this
        // branch was never reached down there.
        gravityScale: laser ? 0 : 1,
      });
      // The colour, the proportion and the halo — after the spawn rather than
      // inside it, because the asset table has no idea what element this run is
      // carrying and must not learn. The FIN's element, not the run's: two
      // bolts in one volley can disagree about it, which is the whole reason it
      // rides the pellet. See applyBoltLook.
      if (laser && bolt) applyBoltLook(bolt, finElementFor(o));
    }
    if (points > 0) flashes.push({ o, x: muzzlePoint.x, y: muzzlePoint.y });
  }

  const px = player.mesh.position.x;
  const py = player.mesh.position.y;

  // Muzzle flash belongs at the muzzle. `muzzlePoint` holds the last shot's
  // emit point; without one it's the original one-unit nudge off the body.
  // ONE shot sound per volley, not one per pellet — `shotCount` is used above
  // to spawn bullets and is deliberately absent from everything below.
  // HOW BIG AND WHAT COLOUR ONE FIN'S FLASH IS.
  //
  // Size is the fin's own pebble multiplier — the flash grows exactly as the
  // stone does, because it is the stone leaving. `sizeMul` and not `scale`:
  // `scale` multiplies the particle COUNT and, in feedback(), the shake, the
  // glow and the ripple as well, so a maxed gun firing on the beat would pin the
  // camera at full rattle for a reason that is meant to be a look.
  //
  // Colour is the fin's element if it rolled one, and otherwise the run's — the
  // pellet and its ribbon are already tinted by the run's element in flight
  // (elementFlightParticles), and a muzzle that stayed the stock blue while the
  // shot leaving it was green was the one point in the chain that disagreed.
  // Undefined, not white, when there is no element anywhere: `emit` reads a
  // missing `color` as "keep the emitter's own palette", and 0xffffff is a
  // colour rather than the absence of one.
  const flashSize = (o) => finRadiusMul(o);
  const flashColor = (o) => {
    // The LAMP's colour first, so the burst leaving a flipper matches the light
    // sitting on it — including the noise wander between a fin's element and the
    // run's, which is what makes consecutive flashes off one fin drift between
    // the two rather than all landing on their average.
    const side = finSideFor(o);
    const lamp = side ? finLightColor(side) : null;
    if (lamp != null) return lamp;
    const id = finElementFor(o) ?? activeElement();
    return id ? elementColor(id) : undefined;
  };

  // The volley's ONE gunshot — sound, shake, glow, ripple — fired at the fin
  // that shot last, which is what this has always done. In the shipped
  // alternating mode that is the only fin firing this tick, so its flash is
  // already per-flipper; the loop below is what covers the simultaneous mode,
  // where the other fins need a flash of their own and emphatically do not need
  // a second gunshot on the same frame.
  const lead = flashes.length ? flashes[flashes.length - 1] : null;
  for (const f of flashes) {
    if (f === lead) continue;
    emit('muzzle', f.x, f.y, {
      dirX: dir.x, dirY: dir.y,
      vx: player.velocity?.x ?? 0, vy: player.velocity?.y ?? 0,
      sizeMul: flashSize(f.o), color: flashColor(f.o),
    });
  }

  // WHICH GUN JUST WENT OFF. Two events rather than one with a swapped voice —
  // see CONFIG.feedback.shootLaser for why. Everything in the payload below is
  // identical either way: the volley leaving a fin is the same event whatever
  // the fin threw.
  feedback(laser ? 'shootLaser' : 'shoot', {
    x: points > 0 ? muzzlePoint.x : px + dir.x,
    y: points > 0 ? muzzlePoint.y : py + dir.y,
    dirX: dir.x,
    dirY: dir.y,
    // Read off the fin that fired, or — with no rig to have fins — off the mean
    // the size half of the card already uses for a body-centre volley.
    sizeMul: lead ? flashSize(lead.o) : meanFinMul,
    color: lead ? flashColor(lead.o) : (activeElement() ? elementColor(activeElement()) : undefined),
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
    sfxOpts: shotSfxOpts(fireRate, fireRate * share),
  });

  applyRecoil(dir, share);
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
      scale: Math.min(2, s.recoil / 9) * share,
    });
  }
}

function fireMissiles() {
  const s = player.stats;
  missileCooldown = CONFIG.missile.fireRate;
  const dir = input.aim.clone().normalize();
  const rig = player.aimRig;

  const shells = projectileCount(s.missileCount, s);
  // WHAT A MUSSEL IS WORTH AT THIS STACK. Read once for the volley — every
  // shell in it is the same weapon, and `missileCount` is the stack number
  // because nothing but this card's apply() writes to it.
  const shell = missileLevelStats(s.missileCount, s);
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
      // Both from levelStats, which already spends abilityDamageMul — so the
      // shell the tip describes and the shell in the water are one number.
      damage: shell.missileDamage,
      speed: CONFIG.missile.speed * speedJitter,
      life: CONFIG.missile.life,
      radius: shell.missileSize,
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
          // Louder when both fins actually gave up a club, which is the
          // heaviest this ability gets, rather than every throw sounding the
          // same whether it cost anything or not.
          //
          // `emptied` can now be 0 — the basic club never leaves its socket
          // (CONFIG.clubThrow.neverThrown), so a run whose flippers hold
          // nothing but driftwood throws without spending anything. That still
          // gets the full event: the clubs left, the player did the thing, and
          // a silent throw would read as the ability having failed.
          scale: emptied > 1 ? 1.25 : 1,
        });
      },
    },
    { boom: player.stats.clubBoomLevel, ice: player.stats.clubIceLevel, zap: player.stats.clubZapLevel },
    // A PERFECT CHARGE HURLS THE RING AS WELL. `perfectStrike` and not
    // `perfect` — the latch is cleared by the release, and what a payoff has
    // to read is the dash IN FLIGHT, which is exactly the distinction the note
    // on strikeState.perfect draws. See disarmClubs in systems/club.js for why
    // the orbiters are the perfect release's to spend and nobody else's.
    { perfect: strikeState.perfectStrike },
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
  // The explosion and the hull's death voice are NOT here: they moved into
  // damageBoat, so a boat sunk by an orca or by another boat goes up exactly as
  // loudly as one the player shot. What is left is what only main knows — the
  // score, and the grid.
  //
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
  // As with the mussel above: `scallopCount` is written only by this card's
  // apply(), so it IS the stack number, and Clone Warz's extra shells ride the
  // same per-stack damage as the ones the card bought.
  const shot = scallopLevelStats(s.scallopCount, s);
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
      damage: shot.scallopDamage,
      speed: c.speed,
      life: c.life,
      radius: shot.scallopSize,
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

// Razor Clams — one volley of piercing chrome blades. The fan's width and its
// blade count both move with the level (see systems/razorClam.js), so from here
// this is only: ask for the volley, throw it, make one noise.
//
// ONE feedback event for the whole volley rather than one per blade. Ten blades
// leave on the same frame from two flipper tips, and ten muzzle flashes stacked
// on one point is a white disc with a horn section behind it; the event is
// scaled by how many went out instead, which is what makes the ring land harder
// than the spray without making it louder ten times over.
function fireRazorClams() {
  const s = player.stats;
  const dir = input.aim.clone().normalize();
  const volley = razorClamVolley(s.razorClamLevel, Math.atan2(dir.y, dir.x), s);
  razorClamCooldown = volley.fireRate;

  const damage = abilityDamage(volley.damage);
  const c = CONFIG.razorClam;

  for (let i = 0; i < volley.headings.length; i++) {
    const a = volley.headings[i];
    const bladeDir = new THREE.Vector2(Math.cos(a), Math.sin(a));
    // The emit point is asked for with THIS BLADE'S heading rather than the
    // aim, so a ring leaves the flipper that is actually pointing that way
    // instead of every shell in the circle erupting out of one shoulder.
    const origin = emitPoint(player.aimRig, CONFIG.emitPoints.razorClam, i, bladeDir, player.mesh.position, muzzlePoint);
    spawnProjectile(world.scene, {
      origin,
      dir: bladeDir,
      faction: 'player',
      damage,
      speed: c.speed * (1 + (Math.random() * 2 - 1) * (c.speedJitter ?? 0)),
      life: c.life,
      // Sized off the shell that is actually drawn rather than off the config
      // number alone — see razorClamRadius. The blades are a couple of world
      // units long now and a quarter-unit reach on one would have fish
      // swimming straight through the picture.
      radius: volley.radius,
      pierce: volley.pierce,
      asset: 'razorBlade',
      // Its own source tag. The playtest ledger has to be able to say whether
      // the razor clam earned its picks, and a tag shared with anything else
      // would credit one card's damage to another — see the note on the mussel
      // barrage, which is the same weapon class and deliberately not 'missile'.
      source: 'razorClam',
      // Lies along its own heading. The blade is built long on +Y (art forward
      // everywhere in assets.js), so without this a razor clam flies broadside
      // and reads as a floating tile.
      //
      // 'axis' RATHER THAN true, and the difference is only visible on a weapon
      // that fires in every direction at once. Plain `orient` mirrors a
      // leftward shot so a model with a belly does not roll over, and that
      // mirror is 90 degrees out at leftward DIAGONALS — which on a ring of ten
      // blades is four of them flying sideways. A blade has no belly, so it
      // simply declines the mirror. See updateProjectiles.
      orient: 'axis',
      // THE WHIP. Not `spin` — that writes rotation.z, the same angle `orient`
      // owns, and the second one to run wins. This turns the shell about the
      // axis it is FLYING along, so it still goes nose-first and pierces down
      // its own length while its faces sweep through the chrome's fake sky.
      // Signed per blade, so a fan is a handful of thrown shells rather than
      // one rigid object being turned. See razorClamRoll.
      //
      // The seven baked twists are still doing their half of the work: they
      // are why a rolling blade shows a moving highlight instead of one flat
      // face flipping over. See getBladeGeometry.
      roll: razorClamRoll(),
      // The ribbon grows with the shell. `trailScale` multiplies the width and
      // the shed rate (systems/projectileTrails.js), so a blade drawn two and
      // a half times its authored size drags a wake to match instead of a
      // hairline that reads as a scratch on the lens.
      trailScale: volley.size,
    });
  }

  feedback('razorClamLaunch', {
    x: player.mesh.position.x,
    y: player.mesh.position.y,
    dirX: dir.x,
    dirY: dir.y,
    scale: Math.min(1.7, 0.75 + volley.headings.length * 0.09),
    source: 'razorClam',
  });
}

function fireBounce() {
  const s = player.stats;
  bounceCooldown = s.bounceFireRate;
  // The two numbers this card's apply() can't reach. The fire rate, lifespan
  // and bounce budget are on the stat block already; damage and size are
  // derived from the stack, so they come from levelStats like every other
  // levelled ability. See bounceLevelStats for why they are not on the block.
  const shot = bounceLevelStats(s.bounceLevel, s);
  const dir = input.aim.clone().normalize();
  spawnProjectile(world.scene, {
    origin: emitPoint(player.aimRig, CONFIG.emitPoints.bounce, 0, dir, player.mesh.position, muzzlePoint),
    dir,
    faction: 'player',
    damage: shot.bounceDamage,
    speed: CONFIG.bounce.speed,
    life: s.bounceLife,
    radius: shot.bounceSize,
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
    chainSpeedMax: CONFIG.bounce.chainSpeedMax,
    // The ramp the whole card is built around: every carom this shot spends
    // makes the next hit harder. Only this weapon asks for it — a scallop and a
    // thrown club bounce at the damage they were thrown with.
    comboDamageStep: CONFIG.bounce.comboDamageStep,
    comboDamageMax: CONFIG.bounce.comboDamageMax,
    // ...and the swell that draws it. The pellet pops a little fatter on every
    // carom — hitbox with it — so the climbing damage is something the player
    // can see rather than something the tooltip claims.
    comboSizeStep: CONFIG.bounce.comboSizeStep,
    comboSizeMax: CONFIG.bounce.comboSizeMax,
    comboSpring: CONFIG.bounce.comboSpring,
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
      // NOSE-FIRST, WITH A ROLL — not the end-over-end spin this had before the
      // fragment became a bone (assets.js `shrapnel`). A tumbling shot has no
      // back, and the back is where its ribbon comes from: CONFIG.trails
      // .shrapnel anchors at `tailOffset: 1`, which is a meaningless anchor on
      // a body whose long axis points somewhere new every frame.
      //
      // 'axis' rather than plain `true`, and this is the one that would have
      // been a bug. The leftward mirror in updateProjectile is a Ry(PI) applied
      // AFTER the heading, so it lands correctly only when the heading is on an
      // axis and is 90 degrees out at a leftward DIAGONAL — and a shrapnel
      // burst is a full ring, which means it fires at every one of those
      // headings every time. The razor blade opts out for the same reason: a
      // bone is symmetric end to end and has no belly to keep downward.
      orient: 'axis',
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
  // THE CURVE MOVED OUT, to levelStats.js. It was the only ability on the
  // roster whose level maths lived beside the frame loop rather than in a
  // system, which meant nothing outside main.js could ask what a starfish pick
  // was worth — including the hover tip, which is why it moved. The floor on
  // the pierce and the `pierceMax` cap moved with it: a readout without them
  // would promise a body the shuriken never cuts.
  const c = CONFIG.starfish;
  const st = starfishLevelStats(level, player.stats);
  return {
    fireRate: st.starfishGap,
    // A MULTIPLE of the authored radius, which is what the spawner wants; the
    // readout carries the radius itself, which is what a tip can print.
    scale: st.starfishSize / c.baseRadius,
    damage: st.starfishDamage,
    pierce: st.starfishPierce,
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
    damage: abilityDamage(stats.damage),
    speed: CONFIG.starfish.speed,
    life: CONFIG.starfish.life,
    radius: CONFIG.starfish.baseRadius * stats.scale,
    pierce: stats.pierce,
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
// only when the water is empty (crabs first, anything else second — see
// pickTarget there); the cooldown is only consumed on a run that actually
// launched, so the next tick tries again immediately and a gull shows up
// shortly after anything does.
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

// ---------------------------------------------------------------------------
// AND THE MEAT A WEAK SPOT KICKS LOOSE — see CONFIG.hotSpots.chum and the
// header of systems/bossHotSpots.js.
//
// The other end of the same pickup, and deliberately NOT the same payout: a
// chunk on a timer above is health the fight hands you, and this is fuel the
// fight sold you for aiming. It rides the chunk entity because in the water it
// IS one — a lump of the animal, thrown, sinking, magnetised by the food reach
// — and it is told apart from an ambient chunk by being bigger, redder and
// visibly lit rather than by wearing a different currency\'s colour. It used to
// wear the boost yellow; see CONFIG.hotSpots.chum.tint for why that lost.
// ---------------------------------------------------------------------------
function spillHotSpotChum() {
  const m = CONFIG.hotSpots?.chum ?? {};
  if (m.enabled === false) return;
  const queued = drainHotSpotChum();
  if (!queued.length) return;
  // THE CEILING COUNTS EVERY CHUNK, health ones included. Three spots being
  // worked by a fast weapon can carpet the arena otherwise, and the moment the
  // water is thick with them a pickup stops being a reward for aiming and
  // becomes something you collect by existing.
  const cap = Math.max(1, Math.round(m.maxAlive ?? 7));
  // How much of the BAR one piece is, which is what its size has to say. The
  // pip count is the run's (Coiled Spring moves it), so a two-pip piece on a
  // three-pip bar is visibly a bigger deal than the same piece on a five-pip
  // one — which is exactly what it is.
  const pips = Math.max(1, pipCount(player.stats));
  for (const q of queued) {
    if (chumChunks.length >= cap) break;
    const t = Math.max(0, Math.min(1, q.pips / pips));
    const chunk = spawnChumChunk(world.scene, { x: q.x, y: q.y, z: 0 }, {
      t,
      pips: q.pips,
      tint: m.tint ?? 0xff2a14,
      // The two that make a RED piece read at all: red carries a third of a
      // yellow's luminance, so the shared chunk glow leaves it under the bright
      // pass, and the size is what says this one came out of something rather
      // than off the ambient timer. Both in CONFIG.hotSpots.chum.
      glowMul: m.glowMul,
      sizeMul: m.sizeMul,
      lifetime: m.lifetime,
      flashMul: m.flashMul,
      // Off limits to the food magnet until it has slowed to this — otherwise
      // the throw is cancelled on its first frame whenever the seal is near,
      // which for meat off the boss they are shooting is nearly always. See
      // CONFIG.hotSpots.chum.settleSpeed.
      settleSpeed: m.settleSpeed,
      vel: { x: q.vx, y: q.vy },
    });
    // AND IT ARRIVES LIT. Forty-odd overdriven particles thrown down the same
    // line the piece is, a bloom swell and a ring — see
    // CONFIG.feedback.hotSpotChum. The emission is at the POINT rather than in
    // the screen's glow channel, and almost nothing is spent on shake or
    // hit-stop: the crit or the rupture that shook this loose fired on the same
    // frame and already owns the punch. What it does NOT do is say "here is
    // something to swim into", which is this event's whole job.
    //
    // The DIRECTION is the throw rather than the skin's normal, which is the
    // same line to within the spread and is the one that is right when it is
    // not: the spray goes where the meat is going, so the eye that follows it
    // lands on the chunk rather than on the wound it left.
    const speed = Math.hypot(q.vx, q.vy) || 1;
    feedback('hotSpotChum', {
      x: chunk.mesh.position.x,
      y: chunk.mesh.position.y,
      dirX: q.vx / speed,
      dirY: q.vy / speed,
      vx: q.vx,
      vy: q.vy,
      // Bigger pieces arrive louder, on the same 0..1 reading the chunk's own
      // size is drawn from — `scale` reaches the burst's COUNT, the shake, the
      // glow and the ripple through the one field.
      scale: 0.8 + 0.7 * t,
      // NO `color` HERE, deliberately. Passing one flattens the emitter's whole
      // palette to a single hue with a brightness scatter — that channel exists
      // for DEATHS, where which creature died is the information. This burst's
      // palette is already the fuel family and it carries a white core, which
      // is most of what makes it read as hot; a flat fill would take that out
      // in exchange for saying something the chunk lying there already says.
    });
  }
}

// The streak the piece leaves on the way out. One blob every `trail.every`
// seconds at wherever it has got to, for as long as it is still travelling —
// see CONFIG.hotSpots.chum.trail and the emitter it names.
//
// HERE RATHER THAN IN updateChunk, which is where it would be if the pickup
// module owned it. It does not: entities/pickups.js has no emitter and no
// feedback table, and giving it one so a single pickup can paint itself would
// put the game's whole FX layer behind an import in the file that owns every
// orb in the water. This walk is the price, and it is over a list that holds
// single digits of chunks.
//
// READ OFF THE THROW (`vx`/`vy`) and not off how far the chunk moved. The food
// magnet cancels the throw and moves a claimed chunk by hand, so displacement
// says "travelling" for the whole reel-in — which would paint a second trail
// from wherever the player caught it to their mouth, a line that says the meat
// is being fired at the seal.
function trailHotSpotChum(dt) {
  const tr = CONFIG.hotSpots?.chum?.trail ?? {};
  if (tr.enabled === false || !chumChunks.length) return;
  const every = Math.max(0.005, tr.every ?? 0.035);
  // The same threshold that decides whether the magnet may claim it — a piece
  // trails for exactly as long as it is in flight, and that is one fact rather
  // than two numbers that can drift apart.
  const minSpeed = CONFIG.hotSpots?.chum?.settleSpeed ?? 7;
  for (const c of chumChunks) {
    if (!(c.pips > 0)) continue;
    const speed = Math.hypot(c.vx, c.vy);
    if (speed < minSpeed) continue;
    c.trailIn = (c.trailIn ?? 0) - dt;
    if (c.trailIn > 0) continue;
    c.trailIn = every;
    feedback('hotSpotChumTrail', {
      x: c.mesh.position.x,
      y: c.mesh.position.y,
      dirX: c.vx / speed,
      dirY: c.vy / speed,
      vx: c.vx,
      vy: c.vy,
    });
  }
}

function updateChumChunkSpawns(dt) {
  updateChumChunkSpawner(dt, {
    // A boss is only a boss for this purpose once it is actually fightable.
    // `bossEntering` covers both beats of the arrival — the swim in from
    // behind the rock and the ceremony after it — where the creature is
    // untouchable and the health bar is still filling. Kicking a chunk out of
    // it there would have the fight paying out before it had started.
    boss: (bossState.enemy && !bossEntering()) ? bossState.enemy : null,
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

// WHEN THE WATER COUNTS AS FULL, and when the screen counts as busy. Both are
// set at roughly the point the recorded runs start losing frame rate rather
// than at a round number: `spawn.maxAlive` is 220 and the per-bucket curve is
// flat to about 80 alive and falling by 100, so a mark that only lit at 200
// would sit cold through most of the decline it exists to catch.
const CROWD_MARK = 100;
const SWARM_MARK = 60;

// The whole of last frame's draw calls, summed across every pass post.js
// made. Read at the top of the frame before anything resets it.
let drawsLastFrame = 0;

let lastTime = performance.now();

// WHAT THE LOOP ACTUALLY RUNS.
//
// three reschedules the next frame after the callback RETURNS, so anything
// thrown out of runFrame stops the game where it stands — renderer holding its
// last picture, music still playing off its own clock, no reset and nothing in
// a console the player has. Every lock-up this game has had looked like that,
// whatever the underlying bug was. The guard makes a throw cost one frame.
//
// The announcement is the other half of it, and the more important half: an
// error nobody hears is worse than the freeze it replaced, because the freeze
// at least got reported. First sighting of a signature goes to the console
// with the real error object — a live stack for whoever has devtools open —
// and to the crash trail as one crumb, which is what a phone can be read
// through later with `npm run crash`.
//
// A repeat is counted, not repeated. `frame:stuck` is the verdict that the
// loop is not coming back, and only THAT is written as the session's error:
// a hitch the guard absorbed and played on from did not end the run, and
// calling it the ending would put an 'error' verdict on every session that
// survived one.
// A DECLARATION, not `const animate = guardFrame(...)`, and that is not style.
// boot() is called while this module is still evaluating and hands `animate`
// to setAnimationLoop; it only gets there after an await, so a const happens
// to be initialised in time — today. It would stop being initialised in time
// the moment anything made the path to the loop synchronous, and the failure
// is a TDZ throw during boot with no game at all. The old `animate` was
// hoisted and every caller was written against that, so it stays hoisted.
function animate(now) {
  return guarded(now);
}

const guarded = guardFrame(runFrame, {
  report({ signature, err, count, consecutive, stuck, first }) {
    if (first) {
      console.error('[frame] the frame threw and was survived —', err);
      crumb('frame:throw', signature);
    }
    if (stuck) {
      console.error(`[frame] ${consecutive} frames in a row have thrown — the loop is not recovering.`);
      crumb('frame:stuck', `${signature} x${count}`);
      noteError(err, 'frame');
    }
  },
});

// THE FRAME ITSELF. Never handed to setAnimationLoop directly — `animate`
// below is the guarded one, and it is the only caller. See systems/frameGuard.js
// for why a throw out of here used to be the end of the game.
function runFrame(now) {
  const stamp = now ?? performance.now();
  frameCount++;
  // A PULSE IN THE CRASH TRAIL — see systems/crashLog.js. A WebContent process
  // that is killed mid-run leaves nothing but the breadcrumbs already written,
  // and 'run:start, ninety seconds ago' says nothing about what the frame was
  // carrying when it went. Five seconds apart, one short string, so a cut
  // reads as a load curve rather than as a single word.
  if (stamp - lastCrumbAt > 5000) {
    lastCrumbAt = stamp;
    // THE BYTE CENSUS, four ticks apart — a walk of the scene and the asset
    // caches, which is worth a millisecond every twenty seconds and is the
    // only reading that says WHERE the phone's 1.8GB is. See
    // systems/memoryCensus.js.
    if (stamp - lastMemAt > 20000) {
      lastMemAt = stamp;
      try {
        const pool = visualPoolCount();
        crumb('mem', `${censusLine(censusReport({
          items: [world.scene, assetCensusItems()],
          audioBytes: audioBankBytes() + musicBankBytes() + ambientBankBytes(),
          targetBytes: post.targetBytes?.() ?? 0,
        }))} pool${pool.bodies}/${pool.keys}`);
      } catch (err) {
        crumb('mem', `census failed: ${err?.message ?? err}`);
      }
    }
    const mem = world.renderer.info.memory;
    // FRAMES AND THE RUN CLOCK, because the counters beside them cannot tell a
    // frozen GAME from a frozen LOOP. A trail of ticks whose enemy count,
    // geometry count and level are identical for a minute reads as a hang —
    // and it reads exactly the same whether the frame loop stopped (in which
    // case these ticks would not be here at all), the world is paused behind a
    // menu nobody can dismiss, or the clock stopped advancing under a running
    // renderer. `f` is frames since the last tick and `t` is the run's own
    // clock: at 60fps five seconds is ~300 frames, so a two-digit `f` is a
    // stalled renderer and `f300 t0.0` is a stalled world.
    const frames = frameCount - lastCrumbFrames;
    lastCrumbFrames = frameCount;
    // WHO HAS THE SCREEN. A freeze is nearly always something holding the run
    // — the cards, the dividend, the kill shot, the death dive — so the state
    // that gates updatePlayer is worth more than any counter here.
    const held = [
      gameState.running ? null : 'stopped',
      gameState.paused ? 'paused' : null,
      levelUpState.active ? 'cards' : null,
      hiveRewardActive() ? 'hive' : null,
      bossKillState.active ? 'killshot' : null,
      deathState.active ? 'death' : null,
    ].filter(Boolean).join('+');
    // PAUSED WITH NOTHING HOLDING IT — the other way this game locks up, and
    // the one the frame guard cannot help with. Every `paused = true` in this
    // file is a surface going up (the pause menu, the cards, the dividend),
    // and every one of them is answerable: if the run is frozen and not one of
    // them says it did it, then a menu failed to open, or opened and lost its
    // way of being dismissed. The player sees a frozen game with the music
    // still playing — the same symptom as a dead loop, and a completely
    // different bug.
    //
    // The `held` line below already carries this: a tick reading `paused` with
    // no `cards`/`hive` beside it IS the strand. That only helps somebody who
    // pulls the trail and reads a minute of ticks, so the condition says so
    // itself, once, at the moment it starts.
    //
    // TWO HEARTBEATS, not one, and not because a single sighting is ambiguous
    // — every surface is raised on the same frame as the flag, so there is no
    // window where an honest pause looks like this. It is that a diagnostic
    // which cries wolf gets ignored, and five seconds of proof costs nothing
    // against a freeze nobody can dismiss anyway.
    const holder = levelUpState.active || hiveRewardActive() || bossKillState.active
      || deathState.active || isPauseOpen();
    strandedBeats = gameState.running && gameState.paused && !holder ? strandedBeats + 1 : 0;
    if (strandedBeats === 2) {
      console.error('[frame] the run is paused and no screen is holding it — nothing can dismiss this.');
      crumb('run:stranded', `L${gameState.level} t${gameState.time.toFixed(1)}`);
    }
    crumb('tick', `L${gameState.level} ${enemies.length}e ${particleCount()}p`
      + ` g${mem.geometries} t${mem.textures} pr${programsEverBuilt()}`
      + ` c${document.getElementsByTagName('canvas').length}${bossState.enemy ? ' BOSS' : ''}`
      + ` f${frames} t${gameState.time.toFixed(1)}${held ? ' ' + held : ''}`);
  }
  // LAST frame's totals, read before anything resets them. renderer.info has
  // autoReset off (see world.js), so these have accumulated across every pass
  // post.js made — the scene, the bright pass, the blur ping-pong and the
  // composite — rather than reporting only the last one.
  // Module-scoped rather than local, because it was a local and therefore
  // dead: nothing read it, and the run record built its `draws` field from
  // `info.render.calls` at DEATH instead — which is mid-frame, after post.js
  // has already zeroed and re-filled the counter for one of its dozen passes.
  // Every run on disk recorded `draws: 1`, the composite's single fullscreen
  // triangle, and `npm run perf` printed it as fact. See the autoReset note in
  // world.js; this is exactly the trap it warns about.
  drawsLastFrame = world.renderer.info.render.calls;
  world.renderer.info.reset();

  // THE TOUCH PAUSE BUTTON, and it lives at the TOP of the frame rather than
  // down beside updateHUD, because down there it is inside
  // `if (running && !paused && stageSimulates())` — a block that by definition
  // stops running the moment the thing this button asks for has happened. The
  // button would have shown itself on the first frame of a run and then never
  // been told to go away, sitting live over the pause menu it had just opened.
  //
  // canPause() is already the single source of truth for whether the Escape key
  // does anything, so this asks it the same question rather than tracking the
  // four screens (level-up, death dive, score card, menu) separately.
  setPauseButtonVisible(canPause() && !isPauseOpen());

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
  // The same three counters, mirrored OUT of the process into localStorage.
  //
  // Everything perfFrame accumulates lives in memory, so a WebContent kill
  // takes the whole record with it and the run that mattered most — the one
  // that died — is the only one that reports nothing. This is the copy that
  // survives, and it is deliberately the counters rather than the timings:
  // textures, programs and geometries are what this game grows without bound,
  // and heapUsed() reads 0 on iOS because Safari has no performance.memory.
  // Throttled to once every couple of seconds inside crashBeat.
  crashBeat({
    elapsed: Math.round(gameState.time ?? 0),
    level: gameState.level ?? 0,
    textures: world.renderer.info.memory.textures,
    geometries: world.renderer.info.memory.geometries,
    programs: world.renderer.info.programs?.length ?? 0,
    programsEver: programsEverBuilt(),
    draws: drawsLastFrame,
    pixelRatio: world.renderer.getPixelRatio(),
    heapMB: Math.round((heapUsed() || 0) / 1048576),
  });
  // WHAT THE GAME IS DOING, for the frame that just ended. Four runs in five
  // report most of their hitches as "none of those" — not a shader link, not a
  // texture upload, not a collection — which says the frame was busy and
  // nothing more. These name the moment so the report can say which moments
  // the bad frames cluster in; see the note above MARK_LINGER in perfLog.js
  // for why the number that matters is the RATE while a mark is hot and not
  // the tally.
  //
  // Read as state every frame rather than fired as events from inside each
  // system: a mark is meant to describe a stretch of the run ("a boss was on
  // screen"), the linger already covers the one-shot case, and one block here
  // is far easier to keep honest than eight call sites scattered through
  // systems that have nothing else to do with performance.
  //
  // `crowd` and `swarm` are the two hypotheses worth testing directly. The
  // recorded runs say frame rate falls with population and with upgrade
  // stacks TOGETHER — more than either alone — and these are what turn that
  // correlation across runs into an attribution within one.
  if (gameState.running) {
    if (levelUpState.active) perfMark('cards');
    if (deathState.active) perfMark('dying');
    if (bossState.arriving) perfMark('boss-arrive');
    else if (bossState.enemy) perfMark('boss');
    if (enemies.length >= CROWD_MARK) perfMark('crowd');
    if (projectiles.length >= SWARM_MARK) perfMark('swarm');
  }

  // GIVE PIXELS BACK IF THIS MACHINE IS DROWNING IN THEM. Fed the unclamped
  // wall time, same as the recorder, and gated on the run actually being live:
  // a menu, a loading screen or a tab returning from the background all
  // produce frames the GPU had nothing to do with, and reading those as the
  // machine struggling would cut the resolution of a game that is running
  // perfectly well. See tickAdaptiveScale in world.js.
  world.tickAdaptiveScale(stamp - lastTime, gameState.running && !gameState.paused);

  // THE WHOLE FRAME'S JS, wrapping every phase below rather than sitting
  // beside them. The leaf phases cannot tell untimed work from the tab not
  // running at all — see the note above jsFrameMs in perfLog.js — and those
  // two have opposite fixes.
  const _tframe = performance.now();

  const rawDt = Math.min((stamp - lastTime) / 1000, 0.05);
  lastTime = stamp;

  // A new frame, so every measured hitbox is stale again. Combat asks a boss's
  // shape where it is once per projectile in range and this is what makes all
  // but the first of those a stamp comparison — see systems/hitShape.js.
  const _tpre = performance.now();
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
  // A LEVEL HELD BACK BY THE SHOT, released the frame it ends. Immediately
  // after updateBossKill because that is the call that clears `active`, and a
  // drain anywhere else in the frame is a menu one frame behind the fact it is
  // reading. Outside the gameplay block on purpose: that block is also shut by
  // the workbench's world-only switch, and a queued level must not be able to
  // strand itself behind a dev panel.
  tryOpenLevelUp();
  const levelScale = updateLevelUpTime(rawDt);
  // ONE UNIT OF THE PICK'S COST, and only on a frame the run is frozen for.
  // Both halves of that gate are load-bearing: `levelUpState.active` alone
  // stays true through the restore ramp, which is live gameplay and the exact
  // frames this file exists to keep work off; `gameState.paused` alone is also
  // the pause menu, which is not a hush anybody asked to spend. See
  // systems/levelUpWarmup.js — a no-op once the queue has drained, which after
  // the first level-up of a run is every frame.
  if (gameState.paused && levelUpState.active) tickLevelUpWarmup();
  const deathScale = updateDeathDive(rawDt);
  // The graveyard, on `rawDt` and NOT on `realDt` below — this is the whole
  // reason the argument is named the way it is. Every one of the four scales
  // above is at its deepest during exactly the sequence the stone is falling
  // through, so a gravestone advanced on the gameplay delta drops in slow
  // motion for the better part of a minute while the score card waits on it.
  // Same trade the boss kill shutter takes: 1.02 seconds of wall clock inside
  // 0.175 of the water's.
  //
  // Above the `running` gate on purpose. The stone falls while the run is
  // OVER, which is the one state most of the loop below is switched off in.
  updateGravesites(rawDt);
  // The beam that crosses a stone as its caption arrives. Wall clock like the
  // stones, and for a second reason of its own: a level-up card can open in the
  // middle of a sweep, and a sweep frozen at half brightness for as long as
  // somebody takes to choose an upgrade is not a beam, it is a stripe painted
  // on a headstone.
  updateGraveBeam(rawDt);
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
  // THE DIVIDEND FIRST, and it returns true whenever it is up, so the level-up
  // row never sees the same frame's input. Both are menus driven off the same
  // poll and both would answer a confirm — the boss reward is the one that is
  // actually on screen, since the ramp it rides on locks a level-up out.
  if (!updateHiveRewardNav()) updateMenuNav();
  // The pause menu's own cursor, on the same poll and for the same reason.
  updatePauseNav();

  // Refill the seal before anything can hurt it, not after. `player.hp <= 0`
  // is tested inline at three points INSIDE this block — the damage handler,
  // the drowning tick and the contact check — each calling killPlayer on the
  // spot, so a top-up at the end of the frame would arrive after the run had
  // already ended. Starting every staged frame from a full pool means the
  // drowning tick and every ordinary hit land on a seal that can absorb them.
  holdStageSafe(player);
  perfPhase('pre', performance.now() - _tpre);

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
    const _tworld = performance.now();
    setChumDifficulty(gameState.difficulty);
    // ...and how strong the seal has got, for CONFIG.spawn.lateGame. Next to
    // the line above because it is the same kind of statement — a run fact the
    // spawner needs and cannot reach — and it has to be pushed here rather than
    // inside updateSpawning: the boss escorts, the death pile and every direct
    // spawnNamed bypass that function entirely.
    setSpawnLevel(gameState.level ?? 1);
    missileCooldown -= dt;
    scallopCooldown -= dt;
    oysterCooldown -= dt;
    razorClamCooldown -= dt;
    bounceCooldown -= dt;
    starfishCooldown -= dt;
    seagullCooldown -= dt;
    simClock += dt;
    if (rapidFireTimer > 0) rapidFireTimer -= dt;
    // How long ago the last card was taken. Left at Infinity until the first
    // one, and never reset by anything else — the hive tip's window is about a
    // PICK, not about a level or a menu opening.
    if (Number.isFinite(sinceUpgrade)) sinceUpgrade += dt;

    // Every live chain link makes the seal faster — thrust, top speed, the
    // dash itself and the dash's turn rate all read this. Pushed in as a plain
    // field for the same reason as dashTimer: entities/ doesn't import from
    // systems/. Must be set BEFORE updatePlayer consumes it.
    player.comboSpeedMul = comboSpeedMul();

    updatePlayer(dt, input);

    // A BOSS WITH THE SEAL IN ITS MOUTH — see systems/bossGrab.js, and the note
    // at the top of that file for why it is here rather than inside
    // updatePlayer. It is the LAST word on the seal's position: everything
    // above has already integrated the frame, and this places the body in the
    // jaws over the top of the result. Before updateAirborne on purpose, so a
    // player carried up through the surface in a boss's mouth banks the arc
    // from where they actually are rather than from where they swam to.
    updateBossGrab(dt, { onPlayerHit });

    // BEING THROWN INTO SOMETHING — see systems/slam.js. Here, and not lower
    // down with the rest of the combat, because this is the one moment the
    // knock has been integrated and the arena clamp applied: an arrest reads
    // as "on the wall, still pushing" for exactly this frame and has been bled
    // by another step of decay by the next one. After updateBossGrab for the
    // same reason that is after updatePlayer — the jaws are the last word on
    // where the seal is, and a slam measured before them would be measured
    // against a position the frame went on to overwrite.
    updateSlam(dt, enemies, { onPlayerHit });

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
          // NOT the default `bigKill`. A blast queued with no `feedback` fires
          // that one (see processPendingSplashes), and it is the KILL event —
          // it carries `killGoo`, so every landing left a cloud of blood in
          // clean water. `waterBlast` is the same weight and the same sound
          // with whitewater in place of the gore.
          feedback: 'waterBlast',
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

      // ...AND THE REST OF THE SPLASH. `feedback` above is the impact frame —
      // the spray and the crown of foam, both thrown upward. This is the hole
      // punched under them and the column the hole throws back out of itself a
      // fifth of a second later, which is the half of a splash the game has
      // never had. Same numbers, deliberately: it is the same event, and the
      // one thing worse than a landing with no jet is a landing whose jet
      // disagrees with its own crown about how hard it was.
      //
      // Fired here rather than from a `stages` key on the feedback entry
      // because it is the only effect in the game that is not instantaneous,
      // and the feedback table has no clock — see systems/reentrySplash.js.
      fireReentrySplash({
        x: sx,
        y: sy,
        vx: player.velocity.x,
        vy: Math.abs(player.velocity.y),
        scale: slam ? slam.scale : Math.min(1, 0.3 + impact / 30),
        // THE SHAPE THE WATER LEAVES FROM. A world-space box, so the seal's
        // aim rotation is already in it — a body entering nose-down measures
        // tall and narrow, one belly-flopping measures wide and flat, and the
        // ring of foam is the right shape in both without this having to know
        // which. Measured here rather than inside the system so that module
        // keeps importing CONFIG and emit and nothing else.
        body: measurePlayerExtent(player),
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

    // AMBIENT BUBBLES ARE A HEADCOUNT, not a timer — the arena holds one or
    // two of them and the spawner's job is to keep it that way. The rule and
    // the reason are stepBubbleSpawner in systems/oxygenBubble.js; all that
    // is here is the count it reads (every bubble in the water, including the
    // ones a boat's hull shook loose) and the seabed it comes out of.
    {
      const step = stepBubbleSpawner(dt, bubbleSpawnTimer, bubbleOrbs.length);
      bubbleSpawnTimer = step.timer;
      // OUT OF THE SEABED, not out of mid-water. Air comes from somewhere.
      // See bubbleBirthPoint in systems/oxygenBubble.js.
      if (step.spawn) spawnBubbleOrb(world.scene, bubbleBirthPoint());
    }
    // The rapid-fire orb keeps its own plain interval.
    rapidFireSpawnTimer -= dt;
    if (rapidFireSpawnTimer <= 0 && CONFIG.rapidFirePickup.enabled) {
      rapidFireSpawnTimer = randomBetween(CONFIG.rapidFirePickup.spawnMin, CONFIG.rapidFirePickup.spawnMax);
      spawnRapidFireOrb(world.scene, randomArenaPoint());
    }
    // THE LEVEL BLOB. Its timer runs from the start of the run like the others,
    // but the spawn itself waits for there to be something to level: the whole
    // payload is "one of the cards you are holding", and the first minute of a
    // run holds none. The timer is NOT re-rolled when the gate refuses — that
    // would push the first blob out by a full interval past the first pick,
    // which on a slow opening is most of a run — so the blob arrives on the
    // next frame after the player takes anything.
    levelOrbSpawnTimer -= dt;
    if (levelOrbSpawnTimer <= 0 && CONFIG.levelPickup.enabled && levelableUpgrades().length) {
      levelOrbSpawnTimer = randomBetween(CONFIG.levelPickup.spawnMin, CONFIG.levelPickup.spawnMax);
      spawnLevelOrb(world.scene, randomArenaPoint());
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
        // `feedback: false` on the splash and the event fired here instead, so
        // one arrival is announced ONCE. It used to be announced twice — a
        // `bigKill` from this hook and a second `bigKill` from the splash queue
        // resolving the same blast a few lines later — which doubled the shake
        // and stacked two hit-stops on the same frame.
        pendingSplashes.push({ x, y, damage, radius, exclude: null, source: 'seagull', feedback: false });
        // Sized off the blast it actually made, so a run under Splash Zone
        // reads as big as it hits.
        feedback('seagullBlast', { x, y, scale: Math.min(2.2, 0.8 + radius / 10) });
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
    // The flags on the mastheads — Bakalar's and the boat boss's. One clock for
    // every flag in the water, so this is one write rather than one per boat,
    // and it is the water's dilated dt: a flag that kept flying at full speed
    // through a hitstop would be the only thing on screen that did.
    updateFlags(dt);
    updateBoats(dt, world.scene, gameState.difficulty, player.mesh.position, {
      onBoatDestroyed,
      // The clam being swallowed. It answers the coach's `attractorOrb` tip the
      // same way swimming into any other pickup answers its own — that tip used
      // to have no answer at all, because the clam could not be collected.
      onAttractorTaken: () => noteTutorialEvent('attractorOrb'),
      // For the attractive clam's beat-synced waves only — everything else in
      // there runs on the water's dilated clock. See updateAttractiveClam.
      rawDt,
    });

    // No trigger to pull any more — autofire is the whole answer. Kept as a
    // named flag rather than inlined because it still gates which weapons run,
    // and because turning it off in the tuner should silence all of them.
    const wantsToFire = CONFIG.weapon.autofire;
    // Asked every frame, firing or not: the idle path is what holds the lock on
    // the grid, so the shot after a recentred stick lands on a slot instead of
    // wherever the aim came back. See systems/shotGrid.js.
    // The scheduler ticks per PELLET, not per volley: with the stagger on, a
    // bar/4 gun with the starting pair ticks eighth notes and each tick is one
    // stone off one flipper. Derived here rather than inside fire() for the
    // reason shotInterval() is split out at all — shotDue is asked every frame,
    // firing or not.
    //
    // THE PELLET COUNT HAS TO BE THE ONE fire() WILL USE, or the two disagree
    // about how long a cycle is and the gun drifts off its own grid: same
    // projectileCount, same Rapid Fire multiplier, in the same order.
    if (shotDue(tickInterval(shotInterval(), emitPointCount(player.aimRig, CONFIG.emitPoints.bullet),
      volleyShots()), wantsToFire && input.aim.lengthSq() > 0.001, dt)) fire();
    if (wantsToFire && player.stats.missileCount > 0 && missileCooldown <= 0 && input.aim.lengthSq() > 0.001) fireMissiles();
    // Neither of these needs `wantsToFire`. The scallop is spat and forgotten
    // and the pearl is slow and heavy — both are meant to be in the water
    // whether or not you're holding the trigger, the same way the shrimp ring
    // and the starfish are. Aim still matters for the pearl, which is why it
    // keeps the aim check the scallop doesn't need.
    if (player.stats.scallopCount > 0 && scallopCooldown <= 0) fireScallops();
    if (player.stats.oysterLevel > 0 && oysterCooldown <= 0 && input.aim.lengthSq() > 0.001) firePearlShot();
    // Aim-gated even at the levels where the fan has closed into a ring and the
    // heading no longer changes what gets hit. Consistency is worth more than
    // the edge case: a weapon that needed a crosshair for seven picks and then
    // silently stopped needing one reads as a bug in the aim, not as a perk.
    if (player.stats.razorClamLevel > 0 && razorClamCooldown <= 0 && input.aim.lengthSq() > 0.001) fireRazorClams();
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
        playtest.recordStrike(rel.depth, rel.hadFood, rel.hadWindow, rel.arms);
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
          // THE ENTOURAGE, ON A PERFECT RELEASE ONLY. Folded into the burst
          // rather than spawned as separate hits at each companion, because the
          // companions are scattered across the arena and six numbers in six
          // places is not a read — see systems/companionStrike.js. Zero on any
          // release that wasn't perfect, and zero for a run with no companions,
          // so the ordinary strike is untouched.
          //
          // Measured against `burst.damage` for its ceiling and added AFTER, so
          // the cap is on the bonus and the strike's own damage is never capped
          // by a rule about its friends.
          //
          // Asked INSIDE the gate, not before it: strikeBurst() returns zero
          // damage for a release off the beat, and a companion share measured
          // against a zero strike has no ceiling to be capped by. The
          // companions join a strike that BIT; they do not carry one that
          // missed.
          if (burst.damage > 0 && burst.radius > 0) {
            const lent = companionStrikeBonus(player.stats, strikeState.perfectStrike, burst.damage);
            const bx = player.mesh.position.x;
            const by = player.mesh.position.y;
            pendingSplashes.push({
              x: bx, y: by,
              // Air time on the strike's own damage, like the gun's. Damage
              // only, not radius: reach is what the player is aiming with, and
              // a blast that silently grew every time they were high up would
              // make the one number they aim by unpredictable.
              //
              // The companions' share rides it too: they hit on the same frame
              // and through the same blast, and a bonus that ignored air time
              // would make a breach strike quietly worse the more friends you
              // had.
              damage: (burst.damage + lent) * airDamageMul(),
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
              // Bigger when the entourage came in, and sized off what they
              // actually lent rather than off how many there are: a blast that
              // hits three times as hard has to LOOK like it, and a run with
              // one escort should not get the same flash as a run with nine
              // bodies behind it.
              scale: (0.6 + strikeState.power * 0.9) * (1 + Math.min(1, lent / Math.max(1, burst.damage)) * 0.5),
            });
            // AND IT SAYS SO. An invisible passive is an invisible passive —
            // the companions' damage arrives inside a number the player never
            // sees, so without this the card is a strictly better strike with
            // nothing on screen to explain why. See CONFIG.feedback for the
            // toast channel.
            if (lent > 0) {
              feedback('companionStrike', {
                x: bx, y: by,
                toastValue: companionStrikeCount(player.stats),
              });
            }
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

          // ...AND THE BIRD, if the relaunch went through one. The gull is the
          // seal's own ability crossing the sky at exactly the altitude a
          // breach reaches, and the two used to pass through each other with
          // nothing happening at all. See CONFIG.seagullBomb.kick.
          //
          // Read at the player's position rather than at the launch vector's
          // far end: the intercept already happened — this jump is the seal
          // leaving a bird it is currently inside — and aiming the test down
          // the new velocity would ask about a place it has not reached yet.
          //
          // AFTER the launch and after `airJump`'s burst, so the order on the
          // frame is the order of events: the seal shoved off, and the thing it
          // shoved off came apart. The jump is spent either way — the bird pays
          // the meter, it does not pay the jump back.
          const gull = kickGull(
            player.mesh.position.x, player.mesh.position.y,
            player.stats.hitRadius,
          );
          if (gull) {
            const kick = CONFIG.seagullBomb.kick ?? {};
            // Through addCharge like the bubble and the coral rather than
            // feedChum: this is FUEL, not a mouthful, and booking it as food
            // would let a bird open a chain the seal has not eaten anything to
            // earn. The link below is its own claim, made on its own terms.
            if (addCharge(kick.refill ?? 1, player.stats)) chargeCrossed();
            // Unconditional, unlike the orbs above, which score only when they
            // are the fill that TOPS the bar off. A gull that happened to be
            // kicked on a full meter would otherwise be worth nothing at all —
            // and "the meter was already full" is the state a player who is
            // doing well is in, so the hole would open exactly where the
            // mechanic is meant to pay.
            chainFrom('gullKick');
            // `vx`/`vy` rather than `dirX`/`dirY`: the burst's cone is 0, so it
            // throws feathers in every direction and has no base angle to aim
            // — a direction here would be read by nothing. What DOES read the
            // pair is `inherit`, which drags the loose feathers a fraction of
            // the way after the seal that knocked them off.
            feedback('gullKick', {
              x: gull.x, y: gull.y,
              vx: jump.vx, vy: jump.vy,
            });
          }
        }
      }
    }
    perfPhase('world', performance.now() - _tworld);

    const _tshots = performance.now();
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
      //
      // AND EVERY SHOT THAT RUNS OUT COMES APART, cracker or not. A projectile
      // used to be deleted from the scene on the frame its life hit zero, which
      // in the water reads as a rendering fault rather than as a thing running
      // out of momentum — and it got worse with André 3000, whose whole promise
      // is that shots stay out longer, i.e. that you watch more of them end.
      //
      // Scaled by the shot's own radius against the basic pebble's, so a razor
      // blade comes apart bigger than a bullet does without thirteen call sites
      // each picking a number. Off the LIVE stat rather than CONFIG.weapon so a
      // run that upgraded its bullet size keeps the two in step.
      //
      // The burst above still fires as well where there is one: a pearl cracks
      // AND leaves bubbles, which is one object ending, not two events.
      (p) => {
        if (p.burst) pendingBursts.push({ x: p.mesh.position.x, y: p.mesh.position.y, burst: p.burst });
        feedback('projectileFizzle', {
          x: p.mesh.position.x,
          y: p.mesh.position.y,
          scale: Math.min(3, Math.max(0.6, (p.radius ?? 0.18) / (player.stats?.radius || CONFIG.weapon.radius))),
        });
      },
    );
    // A BOLT'S HALO CHARGES OVER ITS FLIGHT. After the step rather than before
    // it, so the brightness is read off the life this frame actually spent —
    // ahead of it every bolt is one frame behind its own position, which on the
    // shortest lattice shards is a visible share of the whole arc.
    //
    // Out here rather than inside updateProjectiles because it is one loadout's
    // look and that function is the shared spawn for every shot in the game.
    updateBoltGlow(projectiles);
    // Nothing new arrives while the stage is open. Creatures already in the
    // water keep swimming and breathing — freezing them would take the scene's
    // life away with its traffic, and the seal is what an effect is being
    // judged against, not an empty tank. Clear on the panel empties it.
    if (!isStaging()) updateSpawning(dt, gameState, world.scene);
    // Right after the ordinary spawner, and on the same terms: it is a spawn
    // trigger, it only fires while the run is actually running, and it stops
    // with everything else when the level-up cards are up.
    updateBoss(dt, gameState, world.scene);
    // WHAT THAT KILL PAYS — the pellet now, the stacks once the shot is over.
    // Both immediately after updateBoss because that is the call that files a
    // death, and anywhere else in the frame is a payout one frame behind the
    // fact it is reading.
    updateBossShot();
    updateBossDividend();
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
    // THE BUBBLE JET, next to the laser because they are the same shape of
    // weapon — a line the seal points — and the two want to be read together
    // when either is retuned.
    //
    // The stat block goes in rather than being imported, so the system can be
    // driven by a harness without dragging the entity graph in; the MOUTH is
    // the muzzle, because a stream leaving the middle of the animal reads as
    // coming out of its chest. emitPoint returns the fallback object itself
    // when the model has no mouth anchor, which is how the null below tells the
    // two cases apart — every workbench-swapped model takes that branch.
    setJetStats(player.stats);
    updateBubbleJet(
      dt, world.scene, player.mesh.position, player.stats.bubbleJetLevel, input.aim,
      emitPointCount(player.aimRig, 'mouth')
        ? emitPoint(player.aimRig, 'mouth', 0, input.aim, player.mesh.position, jetMuzzle)
        : null,
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
        // THE BEAM'S OWN SOURCE, not a name typed here. Two different upgrades
        // light beams — the seal's Laser Eyes and the boss's eyebeam perk — and
        // a hardcoded tag filed both under `beam`, which no upgrade in
        // SOURCE_UPGRADES claims. That means zero stack-minutes, which means a
        // return of 0.00x that no amount of over- or under-tuning could ever
        // move: 30k damage across 13 logged runs, invisible to the balance
        // report the whole time. Same failure the harp's aura had.
        onEnemyDamaged: (e, dmg, x, y, dir, projectile, at, source) => (
          damageFrom(source ?? 'beam')(e, dmg, x, y, dir, projectile, at)
        ),
        onEnemyKilled: onEnemyKilledFeedback,
        // Through the same i-frames every other source of player damage goes
        // through, for the reason the perk hook below says: a beam should not
        // be the one attack in the game that ignores the seal's only defensive
        // window.
        onPlayerHit: (dmg, dir, source, channel, iFrames) => (isInvulnerable() ? 0 : onPlayerHit(dmg, dir, source, channel, iFrames)),
      },
    });
    // The stream, on the same hooks and for the same reason: a jet hit has to
    // go through damageFrom(source) or it lands in the ledger as an untagged
    // blow, which is worth zero stack-minutes and reports a return of 0.00x
    // that no tuning can move. See the note in the beam hook above — this is
    // the same failure, and the only reason it is not a shared helper is that
    // the two take different ctx.
    updateJets(dt, world.scene, {
      enemies,
      hooks: {
        onEnemyDamaged: (e, dmg, x, y, dir, projectile, at, source) => (
          damageFrom(source ?? 'bubbleJet')(e, dmg, x, y, dir, projectile, at)
        ),
        onEnemyKilled: onEnemyKilledFeedback,
      },
    });
    updateBossAbilities(dt, world.scene, player.mesh.position, {
      // The i-frame check is here rather than inside the perk, for the same
      // reason resolveCombat does it at each of its own damage sites: a dash
      // through an aura should be a dash through an aura, not the one attack
      // in the game that ignores the seal's only defensive window.
      onPlayerHit: (dmg, dir, source, channel, iFrames) => (isInvulnerable() ? 0 : onPlayerHit(dmg, dir, source, channel, iFrames)),
      // THE ANGLERFISH'S RADIAL GETTING HOLD OF THE SEAL — systems/bossAngler.js.
      //
      // NOT behind the i-frame check above, and that is the one difference
      // between this hook and that one. Invulnerability is a promise about
      // DAMAGE; a snare deals none, and refusing it during a dash would mean
      // the one moment a player is most likely to be crossing the circle is the
      // one moment the circle does nothing. The dash still carries them out of
      // it, which is the counterplay working rather than being skipped.
      onPlayerSnare: (seconds, mul, thaw) => snarePlayer(seconds, mul, thaw),
      // The look's drive is the one thing in there that is not gameplay, so it
      // takes the unscaled clock — see updateBossLook.
    }, rawDt);

    // A STAGED ATTRACTOR STORM, if the U panel has put one in the water. Beside
    // the boss's own abilities because that is what it is standing in for, and
    // after them so a storm anchored to a boss reads the position that boss's
    // perk has just moved it to rather than the one it had last frame.
    //
    // It does no damage of its own: its cubes are ordinary enemy projectiles
    // and land through combat.js like every other shot a boss fires.
    updateAttractorStorm(dt, world.scene, player.mesh.position);

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

    perfPhase('shots', performance.now() - _tshots);
    const _tenemies = performance.now();
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
      onPlayerBite(e);
    });
    perfPhase('enemies', performance.now() - _tenemies);

    // THE PHYSICS FRAME. Everything that owns a body (the boats above, the sea
    // turtle in the pass just now) has already moved itself, so this is where
    // the shove on top of that motion is integrated, where two bodies find out
    // they are in the same place, and where the result reaches the meshes.
    // Last on purpose — running it earlier would resolve collisions against
    // positions the owners then overwrite.
    const _tbodies = performance.now();
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
    perfPhase('bodies', performance.now() - _tbodies);

    const _tcombat = performance.now();
    resolveCombat(dt, world.scene, {
      // Bullets, mussels, ricochets, starfish and shrapnel all land here; the
      // projectile carries the tag that tells them apart.
      // An explicit source beats the projectile's — a Glow Up! shock arc has no
      // projectile behind it and was landing on `gun` by default. See the note
      // in elements.js's applyShock.
      onEnemyDamaged: (e, dmg, x, y, dir, projectile, at, source) => {
        playtest.recordDamage(source ?? projectile?.source ?? 'gun', dmg, e, finKey(projectile));
        onEnemyDamagedFeedback(e, dmg, x, y, dir, projectile, at);
      },
      // The elemental half of a pellet. RECORDING ONLY — the pellet's own
      // feedback has already played, and this is the same damage event.
      onElementDamage: (e, dmg) => playtest.recordDamage('bioluminescence', dmg, e),
      onProjectileChained: (p, x, y) => feedback('bounce', { x, y, ...bounceComboFx(p) }),
      onPlayerHit,
      onEnemyKilled: onEnemyKilledFeedback,
      onBoatHit: (boat, dmg, x, y, projectile) => {
        playtest.recordDamage(projectile?.source ?? 'gun', dmg, boat, finKey(projectile));
        // Hulls aren't in the `enemies` array, so they need the same mussel
        // branch spelled out here — `boat.mesh.name` is the asset key ('boat'
        // or 'trawler'), which is what the colour is read from.
        // Hulls are long boxes, so their enclosing radius overstates them —
        // halved, or a mussel on a trawler blooms across half the screen.
        // The hull's own ring is NOT fired here any more — damageBoat owns it,
        // so the ram and the orca get it too. This is the WEAPON's report only.
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
      // One hop of a Voltaic chain. `strength` is what this hop is worth as a
      // share of the packet that started the chain, and it drives BOTH halves
      // of the moment — a thinner bolt and a smaller, quieter crack — so the
      // far end of a long chain looks and sounds like the tail of something
      // rather than like six identical strikes.
      // `source` is which chain this hop belongs to. Both reach here: Voltaic
      // rides the pellet, and a THROWN zap club carries its chain as a payload
      // (see systems/combat.js). Same bolt, different event under it — the
      // club's is the quieter one, for the reasons on `clubZap` in
      // CONFIG.feedback.
      onArc: (fromX, fromY, toX, toY, strength = 1, source = null) => {
        spawnArcBolt(world.scene, fromX, fromY, toX, toY, strength);
        const club = source === 'clubZap';
        feedback(club ? 'clubZap' : 'elementArc', {
          x: toX, y: toY,
          scale: (club ? 0.5 : 0.55) + (club ? 0.5 : 0.45) * strength,
        });
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
      // --- fin lasers -------------------------------------------------------
      // A bolt coming apart. Fired from here for the same reason the charm is:
      // the split happens where the bolt LANDED, and systems/finLaser.js is
      // handed a contact point rather than a place in the world it could
      // announce from.
      //
      // The colour is the bolt's own, so a Voltaic run's shatter is the colour
      // of the shot that made it rather than the stock spark — the same rule
      // the muzzle flash follows, and the reason both read as one weapon.
      //
      // It lands ON TOP of `bulletHit`, which combat.js has already fired for
      // this impact: the shot did hit something, and that is still the event.
      // `latticeSplit` carries no shake and no hitstop for exactly that reason
      // — see its row in CONFIG.feedback.
      onLatticeSplit: (b, x, y) => {
        feedback('latticeSplit', {
          x, y, dirX: b.dir.x, dirY: b.dir.y, color: boltColor(b.finElement),
        });
      },
    });
    perfPhase('combat', performance.now() - _tcombat);

    // WHAT THE BODIES THE LASERS ARE TOUCHING LOOK LIKE — systems/burnGlow.js.
    //
    // AFTER ALL THREE OF THEM, which is the whole reason it sits here rather
    // than up beside the weapon that first needed it. The bubble jet and the
    // beams stoke it from their own updates above; a fin-laser BOLT stokes it
    // from inside resolveCombat, and with this call above that line every bolt
    // flash was first written on the frame AFTER the hit — one frame out of
    // step with the impact sprite and the sound, on an effect that is only
    // eight frames long.
    //
    // It runs whether or not anything was hit, because the fall is most of the
    // effect: a level that only moved on a hit would snap to cold the instant
    // the beam left, which reads as a light being switched off rather than as
    // something cooling.
    //
    // Still well before updateBossLight, which takes the same per-instance
    // materials over on the frame a boss dies.
    updateBurnGlow(dt);

    // A BOSS'S COMMITTED RUN ENDING IN WATER THE SEAL IS NOT IN — see
    // systems/dodge.js. After resolveCombat rather than before it, because the
    // question the whole thing turns on is whether the pass CONNECTED, and
    // this frame's contact has not been resolved until the line above returns.
    //
    // THE CAMERA KICK RIDES THE HOOK, NOT THE FEEDBACK TABLE. Everything else
    // the dodge does — the burst, the sound, the buzz, the PERFECT DODGE! line
    // — is authored in CONFIG.feedback.bossDodge and fired from inside
    // systems/dodge.js, which is where it belongs. The punch cannot be: it is a
    // call on the world's camera rig, and that module is imported by half a
    // dozen Node harnesses with no renderer. `onDodge` already exists for the
    // ledger, so this is the one channel that has to reach out here anyway.
    updateDodge(dt, enemies, {
      onDodge: () => world.punchCamera(CONFIG.boss?.dodge?.punch ?? 0.09),
    });

    const _tabilities = performance.now();
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
    // ...and each FLIPPER wears whatever Flippers Up! lit it with, which the
    // body-wide wash above cannot say: the two fins can be holding different
    // elements, and which one is about to throw what is the whole read of that
    // card. See systems/finLights.js.
    updateFinLights(world.scene, player.aimRig, rawDt);
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
    // The shots in the air. Only the contagion reads them — its motes orbit
    // the pellet and are handed to the fish on impact — so every other element
    // pays one compare for this.
    }, projectiles);

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
    // BOTH CARDS REACH THE SHRIMP, and that is a fact about the shrimp rather
    // than a mistake: a ring of them is a thing you fire AND a thing that
    // circles you, so Clone Warz and Entourage both have a claim on it. The
    // gate inside each is what keeps a run that took neither at its own count.
    updateShrimpRing(dt, world.scene, player.mesh.position,
      orbiterCount(projectileCount(player.stats.shrimpCount, player.stats), player.stats),
      player.stats.shrimpLevel, player.stats, enemies, {
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
      // A BUBBLE THE SEAL SWIMS INTO IS A BREATH. Same currency, same read and
      // the same pitch ramp as the ambient oxygen bubble above — a lungful
      // taken while suffocating pops low and fat, one taken on a full tank is
      // a thin little tick. `need` is read BEFORE the refill or every pop
      // reports the tank it just topped up. No charge and no xp: the air IS
      // the payment, and the bubble was the player's own to spend.
      onBreath: (x, y, air) => {
        const maxO2 = Math.max(1, player.stats.maxOxygen);
        const need = 1 - Math.max(0, Math.min(1, player.oxygen / maxO2));
        // A FULL SEAL SWIMS THROUGH IT. Refusing leaves the bubble in the
        // water (see the hook), so a run that is going well never has its own
        // crowd control deleted by the seal happening to be in the way.
        if (need <= 0.001) return false;
        player.oxygen = Math.min(maxO2, player.oxygen + air);
        feedback('bubblePop', {
          x, y,
          scale: 0.7 + 0.5 * need,
          color: assetBaseColor('trapBubble'),
          sfxOpts: { pitch: 1.3 - 0.45 * need },
        });
        return true;
      },
    });
    updateSealTeam(dt, world.scene, player.mesh.position, player.stats.sealTeamLevel, enemies, {
      onEnemyDamaged: damageFrom('sealTeam'),
      onEnemyKilled: onEnemyKilledFeedback,
      onLunge: (x, y) => feedback('sealLunge', { x, y }),
      onRam: (x, y) => feedback('sealRam', { x, y }),
      onSquadFire: (x, y, dirX, dirY) => feedback('sealShot', { x, y, dirX, dirY }),
      // Entourage's escorts, passed apart from the level for the reason
      // updateSealTeam spells out: `level` also buys damage and decides the
      // EVOLVE, and neither is what this card is selling.
    }, player.stats.orbiterBonus ?? 0);
    updateCalamari(dt, world.scene, player.mesh.position, player.stats.calamariLevel, enemies, {
      onEnemyDamaged: damageFrom('calamari'),
      onEnemyKilled: onEnemyKilledFeedback,
      onWave: (x, y) => {
        // Was borrowing `boost` — the dash's particles, no sound of its own,
        // and none of the weight a shockwave leaving the seal should carry.
        feedback('calamariPulse', { x, y });
        world.grid.ripple(x, y, 3, 10);
      },
      // Per body the front crosses, at the point on the RING rather than on
      // the body — same call the shrimp ring makes above.
      onContact: (x, y) => feedback('calamariHit', { x, y }),
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
      // How many instruments are on the ring. Through orbiterCount, so a run
      // that never took Harp Seal is not handed one by a card about counts.
    }, orbiterCount(player.stats.harpLevel > 0 ? 1 : 0, player.stats));
    updateOyster(dt, world.scene, enemies, {
      onEnemyDamaged: damageFrom('oyster'),
      onEnemyKilled: onEnemyKilledFeedback,
      // Sized off the blast it actually made. The divisor is the world radius
      // the emitter is authored at (CONFIG.oyster.blastFxUnit), not the base
      // blast radius — those were the same number once, and hardcoding it meant
      // that raising the radius grew the damage and left the flash behind.
      //
      // ALL THREE MULTIPLIERS, off the one ratio. `scale` buys more of the
      // burst (emit() applies it to COUNT and nothing else), and sizeMul and
      // speedMul are what make it BIGGER — which the cloud added under this
      // event needs and `scale` alone cannot give it: a goo mass fuses on how
      // far neighbouring lobes have separated RELATIVE TO THEIR OWN RADIUS, so
      // bigger blobs alone weld into a featureless slab and faster ones alone
      // tear into dots. Never one without the other. Same pair the Bakalar
      // bomb passes a few hundred lines up, for the same reason.
      //
      // It reaches the FLASH as well as the cloud — feedback() hands one `at`
      // to both bursts — and that is deliberate rather than tolerated. The
      // spray was a fixed size at every radius, so a maxed stack under Splash
      // Zone threw exactly the same specks as a first pick; the sparks off a
      // bigger blast should be bigger.
      onBlast: (x, y, r) => {
        const boom = Math.min(CONFIG.oyster.blastFxMax ?? 3.2, r / (CONFIG.oyster.blastFxUnit ?? 2.4));
        feedback('pearlBurst', { x, y, scale: boom, sizeMul: boom, speedMul: boom });
      },
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
      zap: player.stats.clubZapLevel,
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
      // The club's own tag unless the hit names one — Boom Boom Club's blast does.
      // See the note in club.js's detonate(): three cards deal damage through
      // one hook here, and a fixed tag credited all of it to the base club.
      onEnemyDamaged: (e, dmg, x, y, dir, projectile, at, source) => (
        damageFrom(source ?? 'club')(e, dmg, x, y, dir, projectile, at)
      ),
      onEnemyKilled: onEnemyKilledFeedback,
      onWhack: (x, y, rate) => {
        feedback('clubWhack', {
          x, y,
          // A club turning at speed hits harder-sounding than one drifting round
          // at the idle rate. Same swing, same damage — this is the weapon
          // telling you that moving is what powers it.
          scale: Math.min(1.5, 0.7 + rate * 0.05),
          sfxOpts: { pitch: Math.min(1.35, 0.9 + rate * 0.03) },
        });
        // ...and what the wood itself threw off. `clubWhack` is the blow — the
        // thud, the shake, the ripple — and is the same whichever club landed
        // it; this is the only channel that says WHICH one, which matters most
        // in the run this weapon is built for, where four kinds of club are
        // swinging and orbiting at once.
        clubAccent(x, y);
      },
      // Pitch climbs per link and volume falls, the same shape the eel's chain
      // uses: a long carom is an ascending run of clacks receding into the
      // crowd, so how far the body travelled is audible off-screen.
      onRicochet: (x, y, i) => {
        feedback('clubRicochet', {
          x, y,
          scale: Math.max(0.5, 1 - i * 0.12),
          sfxOpts: { pitch: 1 + i * 0.08 },
        });
        // The debris of the club that STARTED the chain, carried down it and
        // thinning per link the same way the sound does — a break shot sheds
        // its heaviest shower on the first body and a wisp on the fifth.
        clubAccent(x, y, { amount: Math.max(0.4, 1 - i * 0.15) });
      },
      // Boom Boom Club. Scaled by how many the blast actually caught, so a keg
      // that went off in a crowd reads heavier than one that popped on a lone
      // crab — and throttled, because with two clubs swinging this can fire
      // several times a second.
      onBlast: (x, y, radius, caught) => {
        feedback('clubBoom', { x, y, scale: Math.min(1.6, 0.7 + caught * 0.15) });
        // EMBERS WHATEVER SWUNG. The one club accent that overrides the club's
        // own substance, because this is the keg going off and not the stick
        // landing — a Cold Snap club carrying Boom Boom Club still detonates in
        // fire. Sized off the RADIUS, which is the one thing Splash Zone and
        // the card's own stacks both move: the blast is the only club effect
        // whose growth is a distance the player can see.
        clubAccent(x, y, {
          event: 'clubEmbers',
          amount: Math.min(2, 0.7 + caught * 0.15),
          size: Math.min(1.8, radius / Math.max(0.5, CONFIG.clubBoom.radius)),
        });
        world.grid.ripple(x, y, 2, radius * 2);
      },
      // The setup paying off — a club landing on something the run had already
      // stopped. Scaled by the swing like the whack it rides on.
      onTeed: (x, y, rate) => feedback('clubTeed', {
        x, y,
        scale: Math.min(1.4, 0.8 + rate * 0.04),
        sfxOpts: { pitch: Math.min(1.3, 0.95 + rate * 0.02) },
      }),
      // THE SHOCKWAVE, at the peak of a swing. Scaled by the RADIUS the wave
      // actually came out at rather than by how many it caught — unlike the
      // keg below, this one fires whether or not there was anything there,
      // and a wave in empty water still has to look like the thing the player
      // just earned. The grid ripple is the effect: it is the only channel in
      // the game that draws a circle travelling outward, which is what a
      // pressure wave is.
      onShock: (x, y, radius, caught) => {
        feedback('clubShock', {
          x, y,
          scale: Math.min(1.5, 0.75 + radius * 0.12),
          // The wave is water and its specks grow with the club that cracked
          // it — a bigger stick displaces more of it.
          sizeMul: clubHitFx().size,
        });
        // AND THE WOOD. The wave is what the water did; this is what came off
        // the head doing it, thrown along the head's own travel (systems/club.js
        // points the scratch there for exactly this call). Held under the
        // whack's shower — a crack in open water should not read as a bigger
        // event than actually connecting with something.
        clubAccent(x, y, { amount: 0.7 });
        world.grid.ripple(x, y, 2.6 + Math.min(2, caught * 0.35), radius * 2.4);
      },
      // ONE HOP of a Zappy Club chain. The same bolt Voltaic draws — it is the
      // one channel in the game that puts a LINE between two bodies, and a
      // chain that came off a stick rather than a pellet is still the same
      // thing happening to the water — with the club's own quieter event under
      // it. `strength` is the hop's share of the packet, so both halves thin
      // together and the far end of a long chain reads as a tail.
      //
      // NOT `elementArc`: that one shakes the camera, and this fires from
      // inside the crowd the seal is swimming through, several hops at a time,
      // on a weapon that already lands several times a second.
      onArc: (fromX, fromY, toX, toY, strength = 1) => {
        spawnArcBolt(world.scene, fromX, fromY, toX, toY, strength);
        feedback('clubZap', { x: toX, y: toY, scale: 0.5 + 0.5 * strength });
      },
      // Cold Snap, but only the moment a body actually LOCKS. The per-hit
      // chill has no event of its own on purpose: it lands on every club hit
      // and would be a second sound under the whack that already played.
      onFreeze: (x, y) => {
        feedback('clubFreeze', { x, y });
        // FROST WHATEVER SWUNG, the mirror of the keg above: Cold Snap rides
        // every club in the run, so a body locking solid under a Boom Boom
        // Club still shatters into ice. Bigger than the other accents because
        // this fires only on SATURATION — it is the payoff the card is bought
        // for, not a per-hit tick.
        clubAccent(x, y, { event: 'clubFrost', amount: 1.4, size: 1.15 });
      },
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
        // THE SMOKE IS SIZED OFF THE BLAST. `bakalarBombBlast` carries
        // `goo: 'clubBoomGoo'` — the same mass every other explosion in the
        // game leaves behind — and that emitter was authored for a club swing,
        // which is a fraction of this radius. sizeMul and speedMul together,
        // never one alone: a goo mass fuses on how far neighbouring lobes have
        // separated RELATIVE TO THEIR OWN RADIUS, so bigger blobs alone weld
        // into a featureless slab and faster ones alone tear into dots. Same
        // pair systems/bossBoom.js passes for the same reason.
        //
        // CLAMPED, like `scale` beside it. The blast radius keeps growing with
        // the stack and with Splash Zone, and an unclamped multiplier at eight
        // stacks throws 1.5-unit lobes at a hundred units a second.
        //
        // It reaches the SPRAY as well as the goo — feedback() hands one `at`
        // to both bursts. That is deliberate rather than tolerated: the debris
        // from a bigger bomb should be bigger, the spray was previously a
        // fixed size at every radius, and systems/bossBoom.js sizes its own
        // burst off its subject the same way.
        const boom = Math.min(2.2, r / 6);
        feedback('bakalarBombBlast', {
          x, y, scale: Math.min(2.4, boom), sizeMul: boom, speedMul: boom,
        });
        world.grid.ripple(x, y, 5, r);
        // The net it went off inside is punched by systems/bakalar.js, which
        // owns the twine. Not from here: the kick has to be queued against the
        // same frame the sim steps.
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
      onEnemyDamaged: (e, dmg, x, y, dir, projectile, at, source) => {
        // `source` for the same reason the combat hook takes one: a dash's
        // sweet spot carries the run's element, and a Glow Up! arc off it has
        // no strike behind it. Everything else through here is the ram.
        playtest.recordDamage(source ?? 'strike', dmg, e);
        onEnemyDamagedFeedback(e, dmg);
      },
      // The elemental share a dash carries (CONFIG.biolum.strikeFraction).
      // Recording only, same as the combat hook's — the ram's own feedback has
      // already played and this is the same contact.
      onElementDamage: (e, dmg) => playtest.recordDamage('bioluminescence', dmg, e),
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
        // BONE SHRAPNEL BURSTS HERE, off the ram — not off the damage hook.
        //
        // It used to hang off onEnemyDamaged, which the strike guards with
        // `if (dmg > 0)`. `CONFIG.strike.contactShare` ships at 0 — the ram
        // deals no damage by design — so the ONLY contact that ever reached
        // that hook was one the prey cull had already killed outright: a body
        // under radius 0.65. Bone Shrapnel burst on minnows the dash was
        // eating anyway and on nothing else. Not one fragment ever came off a
        // shark, a tuna, a predator or a boss, which is every creature the
        // card exists to be used against. The ledger read it at 0.04x return,
        // last but one in the game.
        //
        // Measured: three shark-sized bodies rammed on the beat fired the old
        // hook 0 times and this one 3.
        //
        // onRam is the right home for exactly the reason the note above it
        // gives: it is the ram announcing itself, "sized by COMMITMENT rather
        // than by damage precisely because there usually isn't any". The
        // fragments are the ram's payload, not the chip's.
        //
        // Shrapnel rides the NOMINAL strike rather than what the ram dealt —
        // see riderDamage() in systems/strike.js, which also returns 0 off the
        // beat, so a mistimed dash still bursts nothing.
        const rider = riderDamage(0, player.stats);
        if (rider > 0) spawnShrapnel(at ?? e.mesh.position, rider);
      },
      // THE DASH FOUND THE MARK. Fires on the same frame as `strikeRam` and
      // `hotSpotHit` and on top of both — see CONFIG.feedback.strikeWeakSpot.
      //
      // `scale` is the only place the perfect charge has ever been able to
      // reach the moment it pays out, so both halves of what the player did
      // ride it: the charge they banked, and whether they released clean.
      onWeakSpotRam: (e, at, power, perfect) => {
        feedback('strikeWeakSpot', {
          x: at?.x ?? e.mesh.position.x,
          y: at?.y ?? e.mesh.position.y,
          dirX: strikeState.dashDir.x,
          dirY: strikeState.dashDir.y,
          scale: (perfect ? 1.5 : 1) * (0.8 + power * 0.6),
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
      onFishEaten: (fish, pred, meal) => {
        feedback('preyEaten', { x: fish.mesh.position.x, y: fish.mesh.position.y, vx: pred.vx, vy: pred.vy });
        // A MOUTHFUL OF BAIT BALL, and the health it actually put back. This
        // is the only feeding in the game that is addressed to the player: the
        // ball is chum they were on their way to collect, and every fish the
        // boss gets is a slice of bar they have to chew through again. Fired
        // on the EATER rather than on the fish so the burst lands on the thing
        // that got stronger — see CONFIG.feedback.baitFed.
        //
        // Gated on `healed` rather than on `bait`: a predator already at full
        // health gained nothing, and a burst there would be announcing an
        // exchange that did not happen.
        if (meal?.bait && meal.healed > 0) {
          feedback('baitFed', {
            x: pred.mesh.position.x,
            y: pred.mesh.position.y,
            vx: pred.vx,
            vy: pred.vy,
            // A boss's is bigger because a boss's body is bigger — a burst
            // sized for a shark is lost inside a megalodon.
            scale: pred.isBoss ? 1.35 : 0.85,
          });
        }
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
        // The orb's OWN colour, read off the asset so the burst follows the
        // Look panel rather than carrying a second copy of the tint that goes
        // stale the first time anyone re-skins it.
        feedback('strikeOrbTaken', { x, y, scale: 0.85, color: assetBaseColor('strikeOrb') });
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
        feedback('bubblePop', {
          x, y,
          scale: 0.8 + 0.6 * need,
          color: assetBaseColor('bubbleOrb'),
          sfxOpts: { pitch: 1.25 - 0.45 * need },
        });
      },
      (x, y) => {
        noteTutorialEvent('rapidFireOrb');
        rapidFireTimer = CONFIG.rapidFirePickup.duration;
        // Same top-up as the bubble — see the note there. Slightly bigger,
        // because this orb is rarer.
        if (addCharge(CONFIG.strike.orbPipRefill?.rapidFire ?? 0.35, player.stats)) chargeCrossed();
        feedback('coralTaken', { x, y, scale: 1.1, color: assetBaseColor('rapidFireOrb') });
      },
      // A CHUNK GOING DOWN. Health only, and this is the one pickup in the game
      // that pays no xp and no charge: it is already the largest single thing
      // the water can hand you, and letting it also level you and fill the
      // strike bar would make the rest of the economy something you wait out.
      // It is a break, not a jackpot.
      (chunk) => {
        const x = chunk.mesh.position.x;
        const y = chunk.mesh.position.y;
        // A PIECE OFF A WEAK SPOT IS FUEL, NOT FOOD. Same entity in the water,
        // different currency: this one pays BOOST PIPS into the strike meter
        // and heals nothing, which is what the boost colour on it is promising
        // (CONFIG.hotSpots.chum). Branched here rather than in the pickup so
        // the chunk stays a thing that is collected and this stays the one
        // place that decides what collecting it is worth.
        if (chunk.pips > 0) {
          // Through addCharge like the bubble and the coral, NOT feedChum: it
          // fills the bar without booking mouthfuls. A piece worth three pips
          // routed through the food path would score three FOOD CHAIN links
          // for one pickup, which would make shooting the light the fastest way
          // to a deep chain and the eating beside the point.
          if (addCharge(chunk.pips * pipValue(player.stats), player.stats)) chargeCrossed();
          // The swallow family's event, not the meat's: this is the blue orb's
          // promise at a smaller size, and giving it the health chunk's wet
          // gulp would say "health" over a pickup that pays none. Scaled by
          // what the piece was worth.
          //
          // The colour is the one it is WEARING — the fuel tint, which
          // assetBaseColor cannot answer for because the asset is the meat.
          // Same reading the level blob's swallow takes, and the pickup goo is
          // one shared emitter precisely so the colour is what separates them.
          feedback('hotSpotChumTaken', {
            x, y,
            scale: 0.85 + 0.5 * chunk.t,
            color: chunk.base,
          });
          return;
        }
        // The tip is the HEALTH chunk's ("a real deal seal meal") and is spent
        // by eating one, so a piece of fuel must not mark it off.
        noteTutorialEvent('chumChunk');
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
      },
      {
        // WHAT THE BUBBLES ARE ALLOWED TO BUMP INTO. The live enemy list, so a
        // shark barging through a rising breath shoves it aside and a bubble
        // caught between two bodies bursts. Passed in rather than imported by
        // the pickups module on purpose: it keeps the enemy list a thing the
        // game loop hands out, and it is what lets every existing harness call
        // updatePickups with no world at all.
        bodies: enemies,
        // For the coral's beat-synced light. Everything else in there runs on
        // the water's dilated clock.
        rawDt,
        // THE LEVEL BLOB GOING DOWN. In `opts` rather than as a ninth
        // positional argument: the four above it are already at the edge of
        // what a call site can be read at a glance, and every harness that
        // calls updatePickups with four handlers keeps working untouched.
        onLevelOrb: (x, y, orb) => {
          noteTutorialEvent('levelOrb');
          const got = applyLevelOrb();
          feedback('levelOrbTaken', {
            x, y,
            // The colour it was actually wearing on this frame. There is no
            // assetBaseColor answer for a thing that changes colour four times
            // a bar, and a burst in a fixed tint would be the one part of the
            // effect that was off the beat.
            color: levelOrbColor(orb?.mesh),
            // The card it levelled, named through the same lookup every other
            // toast uses — so this line reads whatever upgrades.csv calls it.
            // Absent when there was nothing left to deepen, which falls back to
            // the event's own wording rather than naming a card that did not
            // change.
            toastUpgrade: got?.id,
            toastValue: got ? `Lv ${got.level}` : null,
          });
          // Same top-up as the bubble and the coral. Small: this pickup's
          // payout is the stack, and paying the meter as well would make the
          // rarest thing in the water also the best boost refill in it.
          if (addCharge(CONFIG.strike.orbPipRefill?.rapidFire ?? 0.35, player.stats)) chargeCrossed();
        },
        // A BREATH DESTROYED. Pays nothing — that is the risk the bubble now
        // carries, and the reason it is worth swimming for one early rather
        // than letting it come to you.
        onBubblePop: (x, y, t) => {
          feedback('bubbleBurst', {
            x, y,
            // Scaled by how far it had swelled: one burst a moment after
            // leaving the sand is a puff, a full one is an event.
            scale: 0.45 + 0.95 * t,
            sfxOpts: { pitch: 0.72, gain: 0.7 },
          });
        },
      },
    );
    perfPhase('abilities', performance.now() - _tabilities);
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
      // Alongside `alive`, because the question the buckets exist to answer is
      // whether the cost grows with the CROWD — and a draw count sampled only
      // at death cannot be plotted against anything.
      draws: drawsLastFrame,
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
    const _tenemies = performance.now();
    updateEnemies(dt, world.scene, player.mesh.position, (x, y) => {
      feedback('chumEaten', { x, y, scale: 0.8 });
    }, (x, y, e) => {
      feedback('chumHoover', { x, y, vx: -e.vx, vy: -e.vy, scale: 0.7 });
    });
    perfPhase('enemies', performance.now() - _tenemies);
    // The one thing that still SPAWNS after the run is over. Same dilated dt as
    // the rest of the descent, so the arrivals slow with it instead of marching
    // in at full speed under a slow-motion corpse.
    updateDeathPile(dt, world.scene, gameState.difficulty, player.mesh.position);
    updateProjectiles(dt, world.scene, enemies);
    // The bolts already in the water go on charging and burning out while the
    // seal sinks. Left out, the last volley of a run would freeze at whatever
    // brightness it happened to be holding on the frame the player died — and
    // the descent is the one part of the game you are looking straight at.
    updateBoltGlow(projectiles);
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
  // The FOOD CHAIN! banner rides the seal and draws the chain window draining,
  // so the layer is handed the camera and the two facts it needs. Null the
  // moment the run is not live: pinning a banner to a dead seal would hold it
  // wherever the body went down, and the strip would keep reporting time on a
  // chain that ended with the run. `chainWindowLeft()` is the same expression
  // the arc outside the boost ring quotes.
  //
  // ---- THE STRIKE PROMPT, AND WHICH SURFACE SAYS IT ------------------------
  //
  // "STRIKE NOW!" has two homes and must never be in both at once. The banner
  // is pinned directly above the slot the ring's own line rides, so mid-chain
  // the player was reading two stacked sentences, one of them the reason the
  // other exists.
  //
  // THE MOMENT IS DECIDED HERE, ONCE, and handed to both. strikeLoaded() is
  // what tryStrike times the release against, so this is not advice about the
  // mechanic — it is the mechanic's clock. Spelling the test out twice would
  // let the two surfaces disagree about a window a tenth of a second wide, and
  // "disagree" here means both lines up together or neither.
  //
  // The WORDS come from callouts.csv through the same resolver the band uses,
  // so the prompt is one row and rewording it is still a text edit.
  const strikeMoment = strikeLoaded() && input.strikeHeld;
  const chainPin = gameState.running && !deathState.active
    ? {
      x: player.mesh.position.x,
      y: player.mesh.position.y,
      left: chainWindowLeft(),
      prompt: strikeMoment,
      promptText: resolveCalloutText(CALLOUTS.get('strikeNow'), inputDevice(), inputTokens()),
    }
    : null;
  const _tfx = performance.now();
  updateToasts(realDt, world.camera, chainPin);
  // WHETHER IT TOOK IT. Asked rather than assumed: the banner only carries the
  // line while it is actually on screen, and "is there a chain running" is not
  // the same question — a window opened by a release has no banner until the
  // first link lands, and that is the moment the ring's line matters most.
  const promptOnBanner = chainBannerHasPrompt();

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
    // The held breath before a boss, the swim in, and the ceremony after it
    // are one continuous stretch (boss.js hands off between them inside a
    // single frame), so this is one crossing and therefore one "Warning!".
    // Miss the middle beat and the line blinks off and back on again in the
    // gap, which reads as two warnings for one boss.
    boss: bossState.hushing || bossEntering(),
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
    //                AND THE BANNER TAKES IT WHILE ONE IS UP. The FOOD CHAIN!
    //                plate is pinned to this very slot during a chain, so the
    //                two would otherwise stack. Same reading of the same
    //                moment, one surface at a time — see `strikeMoment` above.
    strikeNow: strikeMoment && !promptOnBanner,
    boost: boostDenied,
  }, bandLive && !gameState.paused);

  // THE HELLO, before the coach and on the same liveness gate. It takes the
  // band first (CONFIG.greeting.priority is above every coach row), and the
  // first tip below then finds the band busy — which does NOT spend the step,
  // so the tip arrives the moment the greeting has finished leaving. See the
  // note in systems/greeting.js about why that handover is a priority rather
  // than a delay in two places.
  updateGreeting(realDt, bandLive && !gameState.paused);

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
    // A WEAK SPOT THE SEAL COULD ACTUALLY HIT FROM HERE. A getter for the same
    // reason the three above are: it walks a boss's spot list, and the question
    // is only ever asked on a first run.
    //
    // "In strike distance" is the longest dash this stat block can buy — see
    // strikeReach. Not the reach the meter holds right now, which would put the
    // tip on screen and take it off again as the bar filled underneath it.
    get weakSpotInReach() {
      const boss = bossState.enemy;
      if (!boss || bossEntering()) return false;
      const reach = strikeReach(player.stats);
      for (const spot of liveHotSpots(boss)) {
        const at = hotSpotPoint(spot);
        const d = Math.hypot(at.x - player.mesh.position.x, at.y - player.mesh.position.y);
        if (d - (at.r ?? 0) <= reach) return true;
      }
      return false;
    },
    // THE HIVE, and the moment it is worth explaining. Two facts rather than
    // one: the corner has to be on screen with something in it, and the pick
    // that put it there has to be recent — see the `hiveStack` step for why the
    // window is what ends the tip.
    upgradesHeld: player.upgrades.length,
    sinceUpgrade,
    get hiveShown() { return !!hiveRect(); },
    // How a tip finds the thing it is about, and how it keeps hold of it. Both
    // by reference — see takeSubject above.
    takeSubject,
    subjectAt,
    // A TIP IS NOT SHOWN OVER A MENU. The callout layer sits above everything
    // on purpose — a warning that a card could cover would finish behind it —
    // and that is exactly wrong for the coach: `gameState.paused` is the
    // level-up cards and the pause menu both, and a first-run sentence lying
    // across the three upgrade cards is a line the player has to read past to
    // make a choice, printed on top of the thing they are choosing between.
    //
    // The same gate the warnings band already runs under, one call up.
    //
    // Passed as `live` false rather than as a step condition, which takes the
    // tip off NOW and without the dissolve — a sentence eroding gently over the
    // cards is the thing being avoided — and crucially does NOT mark it done.
    // A tip interrupted by a level-up was never given its chance, so it comes
    // back and is taught properly once the water is on screen again.
  }, bandLive && !gameState.paused);

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
  // The caption over whichever grave the seal is swimming across. `realDt` and
  // not `rawDt`, unlike the stones themselves: the drop is a cutscene beat that
  // has to stay out of the death dive's slow motion, but this rides a seal that
  // is being played, so a hit-stop that freezes the seal freezes its caption
  // too. `live` is what takes it down for a menu or a death — as a fade, since
  // the upgrade cards open on top of a frame that is still being drawn.
  updateGraveLabel(realDt, {
    camera: world.camera,
    x: player.mesh.position.x,
    y: player.mesh.position.y,
    live: gameState.running,
  });
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
    // WHICH DISSOLVE THE BAND IS ON, and it is a separate question from the
    // one above because two systems can be leaving at once: the greeting owns
    // the band at the top of a run while the coach's own fade is still whatever
    // the last world tip left it at. Asked as "who is holding the band" rather
    // than as a max() of the two — a max would apply the hello's dissolve to a
    // world tip that started while it was going, and draw a brand new sentence
    // already half eaten away.
    bandFade: greetingOnBand() ? greetingState.fade : tutorialState.fade,
  });

  // Suffocation — the beep, the surface gasps, and the CRT/band-pass
  // blackout. Outside the pause gate on purpose, and told whether the run is
  // live rather than gated on it: on death, on a menu, and behind the upgrade
  // screen it has to keep ticking so the effect EASES back out. Gated, the
  // screen would simply freeze mid-breakup on the game-over card. Real
  // time for the same reason toasts use it — a hit-stop shouldn't stall a
  // warning beep.
  updateOxygenFx(realDt, player, gameState.running && !gameState.paused);

  // Near death — the frame closing in and going bloody under 15% of the bar.
  // See systems/lowHealthFx.js for why this is a second channel rather than
  // more of what playerDamageFx already does.
  //
  // Same three properties as the line above, for the same three reasons.
  // OUTSIDE THE PAUSE GATE so it can ease back OUT on the score card instead
  // of freezing the last frame of the fight red behind it. TOLD whether the
  // run is live rather than gated on it, so death and the upgrade screen walk
  // the effect down rather than stopping the clock that would. REAL time,
  // because the hit that put the seal here fires a hit-stop, and an ease
  // measured in game seconds would be stretched by the freeze it caused.
  updateLowHealthFx(realDt, player, gameState.running && !gameState.paused);

  // Animation runs EVERY frame, not just during an active run. updatePlayer
  // (which drives the player's controller) only runs while the game is
  // running and unpaused, so on the start menu, the level-up screen and the
  // game-over screen the seal used to freeze mid-pose — and any ability mesh
  // with it. Ticking here means a state is always live from the first frame,
  // rather than appearing dead until something else happens to rebuild it.
  if (!gameState.running || gameState.paused) {
    // NOT DURING THE DEATH DIVE, which drives the controller itself. Once the
    // seal is dead its skeleton is a ragdoll on a clock that is neither this
    // one nor the water's but a mix of the two (CONFIG.death.flop.clock), and
    // advancing the springs here as well would integrate every one of them
    // twice a frame — a corpse that flops at double speed and settles at half
    // the damping it was tuned with. See updateRagdoll in systems/deathDive.js.
    if (CONFIG.animation.enabled && !deathState.active) {
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

    // THE SEAL BREATHES ON THE MENU. Same emitters, same anchors, same buffer
    // the run pours into — this screen is the arena at fifteen times the zoom
    // (see systems/mainMenu.js), and an animal held in the water that is not
    // exhaling is the one thing on it that reads as a still.
    //
    // Only the breath actually fires: the wake is gated on `wake.minSpeed` and
    // a menu seal is not swimming, which is the right answer rather than a
    // limitation. The mouth anchor comes from the aim rig immediately above,
    // and it is the BUST'S pose the puff leaves from, so the bubbles come off
    // the mouth of an animal standing upright.
    //
    // `aboveSurface` is measured off the POSITION rather than read off the
    // flag: the flag is written by updatePlayer, which does not run on a menu,
    // so the last run's value is what would be sitting in it. Same rule, for
    // the same reason, as systems/breachTrail.js.
    if (mainMenuActive()) {
      updateBubbles(
        realDt, player.aimRig, player.velocity,
        player.mesh.position.y > bounds.surfaceY,
      );
    }
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
  // THE CLAP, and it goes immediately before the victory lap for the same
  // ordering reason the lap itself is here: the mixer and the aim rig both
  // write an absolute pose every frame, so a hand-posed gesture has to run
  // after both or it is simply overwritten. Before the celebration rather than
  // after, because the celebration is the one thing allowed to overrule a clap
  // (systems/clap.js stands down the moment one starts) and the last writer
  // wins.
  //
  // Outside the pause gate, alongside the lap, so the flippers finish a clap
  // that was in flight when a level-up card came up rather than freezing
  // half-closed behind it. The PRESS is gated below; the release is not.
  //
  // On rawDt: the whole point of this button is that it can be played to
  // music, and music does not slow down for a hit-stop. See systems/clap.js.
  if (input.clap && gameState.running && !gameState.paused && !deathState.active) {
    // WHERE THE HANDS ARE, rather than where the animal is. The two muzzles
    // are the measured skin at the end of each flipper (systems/aimRig.js), so
    // their midpoint is within a few tenths of the point the clap is about to
    // happen at — and it travels with the aim, which the body centre does not.
    // A seal with no rig falls back to its own position, which is also what
    // every other event on the animal uses.
    const m = player.aimRig?.muzzles;
    const at = (m && m.length >= 2)
      ? { x: (m[0].x + m[1].x) / 2, y: (m[0].y + m[1].y) / 2 }
      : { x: player.mesh.position.x, y: player.mesh.position.y };
    triggerClap(at);
  }
  updateClap(rawDt);
  player.clap?.update(rawDt);

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
  updateBossEyes(realDt, world.scene, enemies.filter((e) => e.isBoss), player.mesh.position);
  // The shots, and the clubs on the ring — which are not projectiles and get
  // the same ribbon anyway. See clubTrailMovers.
  updateProjectileTrails(realDt, world.scene, projectiles, clubTrailMovers());
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
  // THE JET'S BED, on the same terms and directly under it because it is the
  // same problem: a held, looping voice whose own update lives INSIDE the
  // pause gate, so a stream held when the level-up cards arrived went on
  // droning under the menu until the player picked something. Muted where it
  // stands rather than released — the stream survives the menu and comes back
  // when the water does. See setJetBedsMuted.
  //
  // Called every frame rather than on the pause transitions, so a bed opened
  // WHILE a menu is up arrives gated too.
  //
  // A MENU OVER A LIVE RUN — both terms, and the second one is load-bearing.
  // This read `!(running && !paused)` and therefore muted whenever there was
  // no run at all, which is exactly when the workbench stages a jet to listen
  // to it: opening the F panel to tune the bed silenced the bed. The `▶`
  // audition plays a file straight to the destination and never touches this
  // graph, so it kept working and the layers looked broken.
  //
  // No run means nothing to interrupt, so nothing to mute.
  setJetBedsMuted(gameState.running && gameState.paused);
  updateImpactFlashes(realDt);
  // Real time too, and for a sharper version of the flashes' reason: the shell
  // is the thing the hit-stop is being taken FOR. A mussel landing sets 45ms of
  // hitstop (CONFIG.feedback.missileImpact), which is a fifth of this effect's
  // whole life — on the fight clock the shell would open in slow motion and
  // then snap, which reads as a dropped frame rather than as impact.
  updateMusselShells(realDt);
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
  // And the light it goes up in front of. The WALL clock again, and for the
  // same reason: the key has to be at full while the water is held at a tenth
  // speed, and a rise on the world's clock would be at a tenth brightness in
  // the one frame that gets kept. Handed the seal rather than reaching for it,
  // exactly as systems/bossKill.js is handed its framing — `player.body` is the
  // visual with materials on it, where `player.mesh` is the container that
  // carries the position.
  updateBossLight(rawDt, player.mesh?.position, player.body);
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
  //
  // The seal's position rides along for the second force in that shader: plants
  // shoved aside as it swims through them, springing back once it has gone.
  // The mesh's position rather than any cached pair, because that is where a
  // body in this game actually is — and unconditionally, so the corpse still
  // parts the weeds it sinks through.
  updateGrassSway(rawDt, player.mesh?.position ?? null);
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
  // The boss's weak spots, and they are HERE rather than up with the impact
  // effects for one reason: their throb is on the musical grid, so they are one
  // of the beat-synced things the comment on updateBeatSync above is about.
  // Run before it they would read a transport a frame stale — nothing anyone
  // could see on a half-bar pulse, but the contract in this block is that the
  // clock is carried to now first and there is no reason to be the exception.
  //
  // BOTH CLOCKS. The relight wait belongs to the fight and slows down with it;
  // the hit flash does not, for the same reason the impacts take real time — a
  // flash that freezes during its own hit-stop is the one thing on screen while
  // everything else is held. (The pulse reads neither: it is on the transport.)
  updateBossHotSpots(dt, realDt);
  // ...and whatever the hits on those spots shook loose. Drained HERE rather
  // than where the damage landed: hotSpotDamage is called from three systems
  // deep inside combat, none of which has a scene, and the queue is what keeps
  // the payout testable without one. See spillHotSpotChum.
  spillHotSpotChum();
  // ...and the shove each burst put through the animal. Same queue-and-drain
  // as the meat above and for the same reason — this is the only file that
  // holds both bossHotSpots and applyKnockback, and reaching for one from the
  // other would close an import cycle through projectiles.js.
  //
  // Through applyKnockback rather than by writing knockX/knockY here: a shove
  // is a rule about being shoved (the mass curve, the boss branch, the decay,
  // the skeleton flinch), and the day someone retunes any of those it has to
  // move this too. See CONFIG.hotSpots.burstKnock.
  for (const shove of drainHotSpotShoves()) {
    // Full power, and the burst's own strength on top: a rupture has no
    // charge to bank the way a strike does — it is either happening or it is
    // not — so the variable half is the one number the CSV owns.
    applyKnockback(shove.e, shove.dirX, shove.dirY, 1, { gain: shove.strength });
  }
  // ...and the streak behind whatever is already in flight. After the spill so
  // a piece born this frame lays its first blob at its birth point rather than
  // one frame downrange, which is the frame the burst is covering anyway.
  trailHotSpotChum(dt);

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
  perfPhase('fx', performance.now() - _tfx);
  // The rest of the landing. On `realDt` and immediately before the particles
  // it fires, because the two are one clock: the stage table schedules bursts
  // against how far the cavity's own arc has run, and the cavity is solved on
  // this one. See systems/reentrySplash.js.
  updateReentrySplash(realDt);
  const _tparticles = performance.now();
  updateParticles(realDt);
  perfPhase('particles', performance.now() - _tparticles);
  // The camera is what turns a finger on the glass into a point in the water,
  // and the strike meter is what makes a charging finger grow — see updateTouch
  // in systems/grid.js. Both are handed in rather than imported there.
  const _tcamera = performance.now();
  world.grid.update(realDt, player.mesh.position, player.velocity, {
    camera: world.camera,
    charging: strikeState.charging,
    charge: strikeState.pending,
    // WHAT THE MENU ASKS OF THIS LATTICE — the arena's, not the menu's own —
    // while it is up: `{ wake, fade }`, and nothing at all on every frame there
    // is no menu, which leaves CONFIG in charge. The screen punches in to
    // fifteen times this framing, where one cell of this grid is wider than the
    // whole picture and the seal's wake radius covers it. Handed in rather than
    // read over there, like the camera and the meter above it.
    ...mainMenuGrid(),
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
  // The pad is off while ANY panel this menu opened is in front of it — the
  // settings panel and now the tip sheet. Both take the one confirm button, so
  // leaving the pad on presses the hexagon behind whatever the player is
  // actually looking at.
  if (mainMenuActive()) mainMenu()?.update(realDt, { pad: !isPauseOpen() && !tipSheetOpen() });
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
  perfPhase('camera', performance.now() - _tcamera);
  setTunerMeta(
    `${Math.round(1 / Math.max(realDt, 0.0001))} fps · worst ${pw.worstMs.toFixed(0)}ms · ${pw.hitches} drops · ${info.calls} draws · ${mpix.toFixed(1)} Mpix${world.adaptiveScale() < 1 ? ` (auto ${world.adaptiveScale().toFixed(1)}x)` : ''} · ${enemies.length} enemies · ${projectiles.length} shots · ${particleCount()} bits · ${flightVoiceCount()} voices`
  );
  const _trender = performance.now();
  post.render(world.scene, world.camera, realDt);
  perfPhase('render', performance.now() - _trender);

  // THE TROPHY, and it has to be here — on the line after the draw, inside the
  // same frame. The renderer runs without `preserveDrawingBuffer` (see
  // world.js), so the colour buffer is the browser's to throw away the moment
  // this task yields: a grab from a timer, a promise or the next frame comes
  // back blank. One frame per boss killed, and only while the kill shot is
  // holding — see systems/bossShot.js.
  if (bossKillShotDue()) {
    crumb('shot:capture');
    const meta = {
      name: bossState.name,
      // What finished it, already resolved to a weapon's own name — see
      // bossState.killedBy, which is written on the frame the boss died and is
      // the only record of it by the time this runs.
      cause: bossState.killedBy,
      causeSource: bossState.killedBySource,
      // CLUBBED BY. The one caption in the game that is not rolled from
      // kickers.csv, and it earns the exception: a boss beaten down with wood
      // has a verb of its own, and "cause of death: Boom Boom Club" throws away
      // the fact that the fight was a mugging. damageCreditFor has already
      // decided the club LINE out-damaged everything else and named the
      // loudest club in it, so this is only putting the right word in front of
      // an answer that is already correct.
      //
      // Left undefined for everything else, which is what makes bossShot.js
      // roll the table as it always has — see the `?? pickKicker` there.
      kicker: sourceFamily(bossState.killedBySource) === 'club' ? 'clubbed by ' : undefined,
      // Whose run this is, read once here rather than when a card is drawn.
      // playerName() and not loadPlayerName(): this is a caption, so it wants
      // the trimmed, never-blank reading — a print titled with an empty string
      // is a print with a hole in it, and 'Seal' is the game's own voice for a
      // player who never typed one.
      player: playerName(),
      level: gameState.level,
      score: gameState.score,
      time: gameState.time,
      // WHAT THE PRINT IS NOT ALLOWED TO CUT OFF. The polaroid keeps a square
      // out of the middle of this frame, so "on screen" and "in the picture"
      // are two different questions — see squareCrop in systems/bossShot.js,
      // which pans its window to hold these.
      //
      // Measured HERE and nowhere else, on the frame that was just drawn, with
      // the camera that drew it: this is the one place that can answer where
      // the two animals actually ended up, after the push-in was clamped
      // against the arena wall and the shake moved it again. Every reading
      // taken from the framing the shot ASKED for is a reading of a camera
      // position that may never have happened.
      focus: snapshotFocus(),
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
      crumb('shot:kept');
      showSnapshotPrint(kept?.url, kept ?? meta);
      crumb('print:shown');
    }
  }
  perfFrameJs(performance.now() - _tframe);
}

// WHERE THE TWO ANIMALS LANDED, in the frame that has just been drawn.
//
// The polaroid's picture is a square cut out of a widescreen frame, so being on
// screen is not the same as being in the photograph — see squareCrop in
// systems/bossShot.js, which slides its window to hold whatever this returns.
//
// PROJECTED, not derived. systems/bossKill.js works out a framing and hands it
// to world.focusCamera, but what arrives on screen is that framing eased by a
// weight, clamped to the arena, and then shaken; a print cropped from the
// REQUEST would be right in open water and wrong in exactly the fights that
// end against a wall. Running the same camera the renderer just used is the
// only reading that cannot disagree with the picture.
//
// Normalised to the frame rather than measured in pixels, because the crop's
// source is the drawing buffer — whose size is the window times the device
// ratio times the adaptive render scale, and can change between two frames.
const SHOT_V = new THREE.Vector3();

function snapshotFocus() {
  const cam = world.camera;
  const half = world.halfExtents(cam.zoom);
  if (!(half.w > 0 && half.h > 0)) return null;
  const pts = [];
  const add = (x, y, r) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    SHOT_V.set(x, y, 0).project(cam);
    pts.push({
      u: SHOT_V.x * 0.5 + 0.5,
      // NDC counts up and a bitmap counts down. The one flip in here, and the
      // one that would be invisible on a centred crop and wrong on every
      // biased one.
      v: -SHOT_V.y * 0.5 + 0.5,
      ru: Math.max(0, r) / (2 * half.w),
      rv: Math.max(0, r) / (2 * half.h),
    });
  };
  // The seal at its hit radius rather than as a point: the print should hold
  // the animal, not its origin.
  if (player.mesh) add(player.mesh.position.x, player.mesh.position.y, player.stats?.hitRadius ?? 0);
  // And the body it just killed, at the radius the shot framed it by — null
  // once the corpse has burst, which is the case where the picture is of a
  // seal in an empty ocean and there is nothing else to hold.
  const body = bossCorpseFocus();
  if (body) add(body.x, body.y, body.r ?? 0);
  return pts.length ? pts : null;
}
