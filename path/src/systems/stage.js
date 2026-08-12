import { CONFIG } from '../config.js';
import { feedback } from './feedback.js';

// THE STAGE — the game, parked, so an effect can be judged against the seal.
//
// Every juice control in the game is a number you set and then go looking for.
// A kill's burst is tuned by starting a run, finding a shark, killing it while
// the camera is moving, and deciding in the third of a second it lasts whether
// the particles were too big. The answer to "too big compared to WHAT" is the
// seal, and the seal is usually somewhere else on screen at the time.
//
// So: park the camera on the seal, stop the arena filling up, and fire the
// event on demand — as many times as you like, as slowly as you like. Nothing
// here is a preview. It is the real feedback() call, the real emitters, the
// real bloom, at the real scale, in the real scene.
//
// A SEPARATE PREVIEW SCENE WOULD HAVE BEEN EASIER AND WRONG. A second renderer
// gets its own camera, its own zoom, its own bloom threshold and its own idea
// of how big a world unit is, and every one of those is a way for it to
// disagree with the game about the only question being asked. The bug this
// tool exists to catch — a burst that reads fine alone and swamps the seal in
// play — is exactly the bug a preview scene cannot show you.
//
// Deliberately NOT in CONFIG. Zoom, time scale and repeat are where the knobs
// happen to be sitting while you work, not authored values, and everything in
// CONFIG gets written into imported-tuning.json and travels with the repo. A
// staging session should leave no trace.

export const stageState = {
  active: false,
  // Which CONFIG.feedback event Fire sends. Validated at fire time rather than
  // here, so a panel can hold a name that a config reload has since removed.
  event: 'kill',
  // Gameplay time scale while staging. 0.15 is roughly hit-stop speed, which
  // is the only way to actually watch a 70ms freeze happen.
  timeScale: 1,
  zoom: 1.4,
  // Seconds between automatic re-fires. 0 is off. This is what makes crowding
  // visible: a burst judged alone and a burst judged while three of them
  // overlap are different bursts.
  repeat: 0,
  // The per-instance multiplier gameplay passes for bigger enemies.
  scale: 1,
  // World units to the right of the seal to fire at. Zero puts the event on
  // top of it, which is where most of them happen.
  distance: 0,
  // Hold the seal's health and oxygen full while staging — see holdStageSafe.
  // On by default, because the alternative is drowning halfway through tuning
  // a burst. Off is for staging an event against a seal that is genuinely
  // hurt, which is the only way to judge playerHit at low health.
  safe: true,
  // Whether the simulation runs at all. See stageSimulates.
  //
  // OFF by default, because opening the workbench is not playing. The run
  // carried on underneath the panel — the seal auto-firing, creatures hunting,
  // the arena filling — so every reading you took was against a world that had
  // moved on by the time you looked up. Turn it back on from the bar when you
  // want to judge an effect in traffic; that is a deliberate act, and the
  // default should be the still world you came to look at.
  sim: false,
  fired: 0,
};

// Where the seal was this frame. Recorded by parkStageCamera rather than
// imported, because entities/ is not this module's business and a stale
// position is worse than none — an event fired at where the seal was two
// seconds ago is a bug that looks like a tuning problem.
const anchor = { x: 0, y: 0, known: false };

let repeatClock = 0;

// Anyone who needs to follow the switch. There is exactly one subscriber (the
// panel) and it exists because the stage can be closed by something that is
// not the panel: starting a run calls resetStage, and without a notification
// the bar would sit on screen over a game that had already un-parked itself.
// A caller polling `isStaging()` would work too, but this panel has no update
// loop and should not grow one just to watch a boolean.
const listeners = new Set();

function announce() {
  for (const cb of listeners) cb(stageState.active);
}

export function onStageChanged(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isStaging() {
  return stageState.active;
}

export function openStage() {
  if (stageState.active) return;
  stageState.active = true;
  repeatClock = 0;
  announce();
}

export function closeStage() {
  // Guarded, so resetStage on every run start doesn't fire a change nobody
  // asked for.
  const was = stageState.active;
  stageState.active = false;
  // Only the phase of the repeat is dropped, so re-opening doesn't fire
  // instantly on a timer that has been counting in the dark.
  //
  // The KNOBS are deliberately left alone. Zeroing timeScale and repeat here
  // was the obvious-looking safety and it was both unnecessary and harmful:
  // unnecessary because updateStage returns a flat 1 the moment this is false,
  // so nothing dilated can survive the close; harmful because the panel's
  // sliders would go on showing 0.15 and 0.5s while the state behind them read
  // 1 and 0, and re-opening would quietly do nothing until every slider had
  // been nudged. A tuning tool should reopen where you left it.
  repeatClock = 0;
  if (was) announce();
}

export function toggleStage() {
  stageState.active ? closeStage() : openStage();
  return stageState.active;
}

/** Called from startGame, so a new run never opens already parked. */
export function resetStage() {
  closeStage();
  stageState.fired = 0;
  anchor.known = false;
}

/**
 * @param rawDt UNSCALED seconds. Same contract as the death dive and the
 *              level-up ramp: this decides the clock everything else runs on,
 *              so it cannot run on its own output.
 *
 *              The repeat timer runs on this raw clock too, and that is the
 *              point rather than an oversight — at a time scale of 0.15 a
 *              repeat measured in gameplay time would fire every six and a
 *              half wall-clock seconds, and "every half second" has to mean
 *              every half second however slowly the picture is moving.
 * @returns the time scale for the rest of the frame. 1 when not staging.
 */
export function updateStage(rawDt) {
  if (!stageState.active) return 1;

  if (stageState.repeat > 0) {
    repeatClock += rawDt;
    // `while`, not `if`: a repeat shorter than a frame at a big dt would
    // otherwise drift instead of firing at the rate asked for.
    while (repeatClock >= stageState.repeat) {
      repeatClock -= stageState.repeat;
      fireStagedEvent();
    }
  }

  return Math.max(0.02, Math.min(1, stageState.timeScale));
}

/**
 * Park the camera on the seal and record where it is.
 *
 * Called from the camera site in main.js rather than from updateStage, because
 * `focus` in world.js is a one-frame claim consumed by updateCamera — set it
 * at the top of the frame and it is gone before the camera reads it. Weight 1
 * means the stage owns the shot outright: no follow lag, no cinematic rig
 * drift, so the effect stays exactly where you put it.
 */
export function parkStageCamera(world, pos) {
  if (!pos) return;
  anchor.x = pos.x;
  anchor.y = pos.y;
  anchor.known = true;
  if (!stageState.active) return;
  world.focusCamera(pos, stageState.zoom, 1);
}

/**
 * Fire the staged event for real.
 *
 * feedback(), not playSfx() and not emit() — the whole point is that every
 * channel lands together, since what an event feels like is the sum of them
 * and no channel can be judged with the others missing.
 *
 * @returns false if the event name no longer exists, so a panel can say so
 *          rather than looking like it did nothing.
 */
export function fireStagedEvent() {
  const name = stageState.event;
  if (!CONFIG.feedback[name]) return false;
  feedback(name, {
    // Falls back to the origin before the first frame has run, which is where
    // the seal starts anyway.
    x: (anchor.known ? anchor.x : 0) + stageState.distance,
    y: anchor.known ? anchor.y : 0,
    scale: stageState.scale,
  });
  stageState.fired += 1;
  return true;
}

/**
 * Whether gameplay should simulate this frame.
 *
 * Nothing about editing or testing juice needs a run. Every system an event
 * touches — the particle pool, feedback's grid, audio, haptics — is built at
 * module scope in main.js before boot() is even called, and everything that
 * DRAWS the result (updateFeedback, updateParticles, the camera and its shake,
 * post.render) sits outside the run gate. The gate wraps the simulation and
 * nothing else, so with it shut an event still throws particles, still shakes
 * the frame, still ripples the grid and still plays.
 *
 * What the run gives you is the seal actually swimming and shooting, which is
 * worth having when you want to judge an effect in traffic — and worth losing
 * when you want to judge it against a still model with nothing else moving.
 * Hence a switch rather than a decision made for you.
 *
 * Off is not a pause. `gameState.paused` belongs to the menus and the whole
 * frame loop is written around it; borrowing it here would mean auditing every
 * `!gameState.paused` in main.js to decide which sense was meant.
 */
export function stageSimulates() {
  return !stageState.active || stageState.sim;
}

/**
 * Keep the seal alive and breathing while the stage is open.
 *
 * There is no "not playing" state to tune in. The DOM start menu is dead code
 * — showStartMenu mounts the Rive splash and dismissing it calls beginRun — so
 * from the first gesture onwards the game is always a live run, and tuning a
 * burst for twenty minutes means twenty minutes of drowning, starving and
 * being eaten by whatever was already in the water when you pressed F.
 *
 * Topped up rather than flagged, which is the same trick config.js uses for
 * the one creature nothing can kill: "unkillable by construction rather than
 * by a special case". Every damage source goes on working exactly as it does
 * in a run — bullets land, the crab still bites, the oxygen still drains and
 * still triggers its warning — and the pools simply refill behind them. No
 * invulnerability flag threaded through combat, no branch in the damage path
 * that could rot, and nothing to leak into a real run: close the panel and the
 * seal is mortal again on the very next frame.
 *
 * Called every frame from the loop, AFTER damage has resolved.
 */
export function holdStageSafe(player) {
  if (!stageState.active || !stageState.safe || !player?.stats) return;
  player.hp = player.stats.maxHp;
  if (player.stats.maxOxygen > 0) player.oxygen = player.stats.maxOxygen;
}

// --- the sandbox ------------------------------------------------------------
// Getting INTO a staged session, and staying in one across a reload.
//
// There is no menu to enter from — the splash drops straight into a live run —
// so the sandbox is not a second mode next to the game. It is the stage, plus
// a way to arrive in it: `?sandbox` on the URL boots past the splash into a
// staged run with the bar already up.
//
// The URL rather than localStorage, and this is the whole point rather than a
// preference. The reason you reload at all is that something in the tree
// changed under you, and a reload that dumps you back into an ordinary run —
// spawning, levelling, taking damage — has thrown away the setup you were
// reloading in order to keep. A query param survives the reload for free, is
// visible, and is switched off by editing the address bar if it ever wedges.
// localStorage would do the same job while being invisible and sticky across
// every tab.

const SANDBOX_PARAM = 'sandbox';

/** Did this page load ask for a sandbox? */
export function sandboxRequested() {
  try {
    return new URLSearchParams(window.location.search).has(SANDBOX_PARAM);
  } catch {
    // No location at all (the harness). Not a sandbox.
    return false;
  }
}

/**
 * Keep the URL in step with the stage, WITHOUT navigating — replaceState, so
 * no history entry is pushed and Back still means what it meant before. Called
 * on every open and close, so the address bar is always the truth about what a
 * reload would give you.
 */
export function setSandboxUrl(on) {
  try {
    const url = new URL(window.location.href);
    if (on) url.searchParams.set(SANDBOX_PARAM, '1');
    else url.searchParams.delete(SANDBOX_PARAM);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  } catch {
    /* no history API — the sandbox just won't survive a reload */
  }
}

/** Every event the stage can fire, in config order. */
export function stageEvents() {
  return Object.keys(CONFIG.feedback);
}
