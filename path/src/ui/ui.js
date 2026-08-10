import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
import { hexMaskSet, noiseMaskSet } from './dither.js';
import { drawUpgrades } from '../upgradeTable.js';
import { availableUpgrades, player } from '../entities/player.js';
import { menuInput, resetMenuInput } from '../input.js';
import { mountRiveSplash } from './riveSplash.js';
import {
  fetchGlobalBoard,
  highScore,
  isGlobal,
  MAX_NAME_LEN,
  loadLeaderboard,
  loadPlayerName,
  sanitizeName,
  savePlayerName,
  submitScore,
} from '../systems/leaderboard.js';
import { feedback } from '../systems/feedback.js';

let callbacks = {};
const el = {};

// Menus answer back. Every clickable thing in the UI goes through here rather
// than binding its own sounds, so a control added later is silent only if
// somebody forgot this line — not because the two events drifted apart.
//
// `pointerenter` rather than `mouseenter`: the same binding then covers a
// stylus and a first touch, and a touch that turns into a tap gets the hover
// AND the click, which is the right pair for a menu you poked.
//
// Deliberately not `focus`. Focus moves for reasons the player did not cause —
// a menu opening puts focus on the first card — and a sound on that is the
// interface talking to itself. Keyboard and pad selection is voiced from
// selectCard instead, where a real change of selection can be told from the
// initial one.
function bindMenuSounds(node) {
  if (!node) return node;
  node.addEventListener('pointerenter', () => feedback('uiHover'));
  node.addEventListener('click', () => feedback('uiClick'));
  return node;
}
let root = null;
let splashPlayed = false;
// The run being scored on the game-over screen, held here because submitting
// happens on a click that can land seconds after the run ended. Cleared once
// submitted so a second click can't post the same run twice.
let pendingRun = null;
// Bumped every time the game-over screen opens, so a board fetch from a
// previous death can't paint itself over the current one when it finally
// lands — dying twice in quick succession is exactly when that happens.
let gameOverToken = 0;

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  .sv-ui * { box-sizing: border-box; font-family: 'Inter', system-ui, sans-serif; }
  .sv-ui { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
  .sv-hud { position: absolute; top: 14px; left: 14px; right: 14px; display: flex; justify-content: space-between; align-items: flex-start; color: #e8ecf3; }
  .sv-panel { background: rgba(12,14,22,0.72); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 10px 14px; backdrop-filter: blur(6px); }

  /* XP spans the full width at the very top — it's the run-long progress
     bar, so it reads as a frame around the screen rather than a widget. */
  .sv-xptop { position: absolute; top: 0; left: 0; right: 0; height: 6px;
    background: rgba(255,255,255,0.07); overflow: hidden; }
  .sv-xptop-fill { height: 100%; width: 0%; background: #7ad7ff;
    box-shadow: 0 0 10px rgba(122,215,255,0.75); transition: width 0.15s ease; }
  .sv-xptop-level { position: absolute; top: 9px; left: 14px; font-size: 10px;
    letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600;
    color: rgba(232,236,243,0.5); text-shadow: 0 1px 3px rgba(0,0,0,0.8); }

  /* Health and oxygen ride just above the seal, so the two things you have
     to react to fastest are where your eyes already are. Positioned in
     screen space each frame from the player's projected world position. */
  /* translateY(-100%) puts the whole stack ABOVE its anchor point — without
     it the bars hang down from the anchor and swallow the gap the world
     offset is there to create. */
  .sv-playerbars { position: absolute; width: 64px; margin-left: -32px;
    display: flex; flex-direction: column; gap: 3px; pointer-events: none;
    transform: translateY(-100%); transition: opacity 0.2s ease; }
  .sv-pbar-wrap { height: 4px; background: rgba(4,6,12,0.55); border-radius: 3px;
    overflow: hidden; box-shadow: 0 0 0 1px rgba(0,0,0,0.35); }
  .sv-pbar { height: 100%; width: 100%; border-radius: 3px; transition: width 0.12s linear; }
  .sv-pbar-hp { background: #4dd0a8; }
  .sv-pbar-o2 { background: #6fd3ff; }
  .sv-pbar-o2.sv-o2-low { background: #ff5566; }

  /* Score toasts: one per kill, floating up from where the fish died. */
  .sv-toast { position: absolute; font-size: 13px; font-weight: 700;
    color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7);
    font-variant-numeric: tabular-nums; pointer-events: none; white-space: nowrap;
    transform: translate(-50%, -50%); will-change: transform, opacity; }
  .sv-toast-combo { color: #ffe066; font-size: 15px; }
  .sv-toast-mult { font-size: 10px; opacity: 0.8; font-weight: 600; }
  /* FOOD CHAIN! — the chain-extension banner. Reuses the toast layer and the
     toast update loop, but it is an announcement rather than a number: it
     rises from the seal, only one is ever on screen (an extension re-uses the
     live node), and it runs hotter the deeper the chain goes — the colour is
     set inline from the link count, so it is not a fixed palette here. */
  .sv-chain { position: absolute; font-size: 21px; font-weight: 800;
    letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap;
    text-shadow: 0 2px 6px rgba(0,0,0,0.95), 0 0 16px currentColor;
    pointer-events: none; transform: translate(-50%, -50%);
    will-change: transform, opacity; }
  .sv-chain-x { font-size: 16px; margin-left: 7px; font-weight: 700;
    font-variant-numeric: tabular-nums; opacity: 0.9; }
  .sv-label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(232,236,243,0.55); font-weight: 500; }
  .sv-value { font-size: 15px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .sv-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: all; }
  .sv-menu { background: rgba(12,14,22,0.88); border: 1px solid rgba(255,255,255,0.14); border-radius: 14px; padding: 28px 32px; text-align: center; color: #e8ecf3; max-width: 90vw; }
  .sv-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .sv-sub { font-size: 13px; color: rgba(232,236,243,0.6); margin-bottom: 18px; line-height: 1.6; }
  .sv-btn { pointer-events: all; background: #7ad7ff; color: #0a0c12; border: none; border-radius: 8px; padding: 10px 22px; font-size: 14px; font-weight: 600; cursor: pointer; letter-spacing: 0.02em; }
  .sv-btn:hover { background: #9fe3ff; }
  .sv-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .sv-cards { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; max-width: min(760px, 92vw); }
  /* Cards are hexagons matching the background art exactly. The vertex
     percentages below were measured off the art itself (flat-top hex: points
     at 5.7%/93.9% horizontally, flat top/bottom edges spanning 27.1%-72.3%,
     vertical extent 12.7%-89.6%) so the clip lines up with the drawn edge
     instead of approximately near it. The card is square because the art is. */
  .sv-card { pointer-events: all; width: 210px; height: 210px; position: relative; overflow: hidden;
    background-color: rgba(255,255,255,0.04);
    -webkit-clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    cursor: pointer; transition: filter 0.15s ease, transform 0.15s ease; text-align: center; }
  .sv-card:hover { filter: brightness(1.25) saturate(1.15); transform: scale(1.04); }
  /* clip-path cuts off any outline, so focus is shown with an inner glow. */
  .sv-card:focus-visible { filter: brightness(1.3); box-shadow: inset 0 0 0 3px #7ad7ff; }
  /* Gamepad selection. Same look as focus above, but as a class: a pad press
     is not a focus event, and :focus-visible is the browser's guess about
     whether to show a ring at all. Written after :hover and at equal
     specificity so the highlight survives the mouse resting on another card. */
  .sv-card.sv-card-sel { filter: brightness(1.3) saturate(1.15); transform: scale(1.04);
    box-shadow: inset 0 0 0 3px #7ad7ff; }
  .sv-card-overlay { position: absolute; inset: 0; pointer-events: none; }
  /* Text is confined to the hex's inscribed box and centred both ways, so a
     long upgrade name can't spill past the angled edges. The inset matches
     the widest rectangle that fits inside the clip above (at 24%/76% height
     the hex spans 20.8%-79.2%), with a margin.
     Nothing here breaks words: --sv-fit shrinks the type until whole words
     fit instead (see fitCardText). */
  .sv-card-content { position: absolute; left: 23%; right: 23%; top: 24%; bottom: 24%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: calc(6px * var(--sv-fit, 1)); overflow: hidden; }
  .sv-card-name { font-size: calc(14px * var(--sv-fit, 1)); font-weight: 700; line-height: 1.15;
    text-shadow: 0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.6); }
  .sv-card-desc { font-size: calc(11px * var(--sv-fit, 1)); color: rgba(232,236,243,0.92); line-height: 1.3;
    text-shadow: 0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.6); }
  .sv-hint { font-size: 11px; color: rgba(232,236,243,0.35); margin-top: 14px; letter-spacing: 0.04em; }
  .sv-leaderboard { margin: 14px 0; max-height: 220px; overflow-y: auto; text-align: left; }
  .sv-lb-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px; font-size: 12px; }
  .sv-lb-row:nth-child(even) { background: rgba(255,255,255,0.03); }
  .sv-lb-row.sv-lb-mine { background: rgba(122,215,255,0.14); border: 1px solid rgba(122,215,255,0.4); }
  .sv-lb-rank { width: 18px; color: rgba(232,236,243,0.5); font-weight: 600; }
  .sv-lb-name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-lb-score { font-weight: 600; font-variant-numeric: tabular-nums; }
  .sv-lb-meta { color: rgba(232,236,243,0.5); font-size: 11px; min-width: 78px; text-align: right; }
  .sv-lb-empty { font-size: 12px; color: rgba(232,236,243,0.4); padding: 6px 8px; }

  /* Name entry. The row is a single control: text field plus its submit
     button, sized so the two read as one unit rather than a form. */
  .sv-name-row { display: flex; gap: 8px; justify-content: center; margin: 14px 0 4px; }
  .sv-name-input { pointer-events: all; flex: 1; min-width: 0; max-width: 200px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px; padding: 9px 12px; color: #e8ecf3; font-size: 14px;
    font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    text-align: center; -webkit-user-select: text; user-select: text; }
  .sv-name-input::placeholder { color: rgba(232,236,243,0.3); letter-spacing: 0.06em; font-weight: 500; }
  .sv-name-input:focus { outline: none; border-color: #7ad7ff; background: rgba(122,215,255,0.08); }
  .sv-btn-sm { padding: 9px 16px; font-size: 13px; }
  .sv-btn:disabled { opacity: 0.5; cursor: default; }
  .sv-status { font-size: 11px; color: rgba(232,236,243,0.5); min-height: 15px; margin-bottom: 8px; letter-spacing: 0.03em; }
  .sv-status-err { color: #ffab6f; }
  .sv-toast-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .sv-hidden { display: none !important; }

  /* The score card doesn't appear, it arrives — see showGameOver. Duration
     comes from CONFIG.death.fadeIn through the custom property, so it stays
     tunable with the rest of the sequence. An animation rather than a
     transition because the element goes display:none between runs, and
     there's nothing to transition FROM on the frame it comes back. */
  @keyframes sv-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .sv-fade-in { animation: sv-rise var(--sv-fade, 0.9s) ease-out both; }

  /* Covers the seam between "Try again" and the next run, while the clock,
     the mix and the lens glide back to normal (systems/deathDive.js). It is a
     plain wash of the background colour for now: THIS is the element the
     transition graphic goes in — give it a child and the timing around it
     doesn't need to change. Above the menus, below nothing. */
  .sv-transition { position: absolute; inset: 0; pointer-events: none; z-index: 5;
    background: #05060a; opacity: 0; transition: opacity var(--sv-trans, 0.9s) ease; }
  .sv-transition.sv-trans-in { opacity: 1; }

  /* While the upgrade cards are dithering in or out they're half-drawn, and a
     half-drawn card is not something you can be asked to have chosen. The
     descendant rule is the one that matters: .sv-center and .sv-card each set
     pointer-events themselves, so switching it off on the container alone
     would leave the cards live under a mask full of holes. */
  .sv-menu-locked, .sv-menu-locked * { pointer-events: none !important; }

  @media (prefers-reduced-motion: reduce) {
    .sv-ui * { transition: none !important; animation: none !important; }
  }
`;

export function initUI({ onStart, onRestart, onLevelChoice }) {
  callbacks = { onStart, onRestart, onLevelChoice };

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.className = 'sv-ui';
  root.innerHTML = `
    <div class="sv-toast-layer" id="svToastLayer"></div>

    <div class="sv-hud sv-hidden" id="svHud">
      <div class="sv-xptop"><div class="sv-xptop-fill" id="svXpBar"></div></div>
      <div class="sv-xptop-level">Level <span id="svLevel">1</span></div>
      <div class="sv-playerbars" id="svPlayerBars">
        <div class="sv-pbar-wrap"><div class="sv-pbar sv-pbar-hp" id="svHpBar"></div></div>
        <div class="sv-pbar-wrap"><div class="sv-pbar sv-pbar-o2" id="svO2Bar"></div></div>
      </div>
      <div class="sv-panel" style="margin-left:auto;">
        <div class="sv-label">Score</div>
        <div class="sv-value" id="svScore">0</div>
        <div class="sv-label" style="margin-top:8px;">Time</div>
        <div class="sv-value" id="svTime">0:00</div>
      </div>
      <div class="sv-panel" id="svRapidFirePanel" style="display:none;">
        <div class="sv-label">Rapid Fire</div>
        <div class="sv-value" id="svRapidFireTime">0s</div>
      </div>
      <!-- strike charges are drawn as a ring around the ship (systems/strikeRing.js) -->
    </div>

    <div class="sv-center" id="svStartMenu">
      <div class="sv-menu">
        <div class="sv-title">Seal Survivor</div>
        <div class="sv-sub">
          You are a seal. You want to eat all the fish. Sharks are your competition —
          take them out before they take your lunch.<br/>
          Your uneaten chum bits float to the sea floor. Swim down to collect them for XP and health.<br/>
          Watch out for crabs! They gather in large numbers to scavenge your leftovers, and they will pinch ya.<br/>
          And don't forget to breathe. Realistic mammal needs are in full effect.<br/><br/>
          You fire on your own — just point. Desktop: WASD to steer, mouse to aim, hold click or Space to charge a strike.<br/>
          Mobile: drag to aim, third finger to charge. &nbsp;·&nbsp; Gamepad: sticks to move/aim, any bumper or trigger to boost.
        </div>
        <div class="sv-label" id="svHighScoreLabel" style="margin-bottom:10px; display:none;">High score: <span id="svHighScore">0</span></div>
        <button class="sv-btn" id="svStartBtn">Start run</button>
        <div class="sv-hint">\` tuning &nbsp;·&nbsp; T textures &nbsp;·&nbsp; P screen filter &nbsp;·&nbsp; M mute &nbsp;·&nbsp; click / Space strike &nbsp;·&nbsp; hold G gamepad info</div>
      </div>
    </div>

    <div class="sv-center sv-hidden" id="svLevelUpMenu">
      <div class="sv-menu" id="svLevelUpBox">
        <div class="sv-title">Level up</div>
        <div class="sv-sub">Pick one</div>
        <div class="sv-cards" id="svCards"></div>
      </div>
    </div>

    <div class="sv-center sv-hidden" id="svGameOverMenu">
      <div class="sv-menu">
        <div class="sv-title">Run ended</div>
        <div class="sv-sub" id="svGameOverStats"></div>
        <div class="sv-name-row" id="svNameRow">
          <input class="sv-name-input" id="svNameInput" type="text" maxlength="${MAX_NAME_LEN}"
                 placeholder="Your name" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" aria-label="Name for the leaderboard" />
          <button class="sv-btn sv-btn-sm" id="svNameSubmit">Submit</button>
        </div>
        <div class="sv-status" id="svLbStatus"></div>
        <div class="sv-leaderboard" id="svLeaderboard"></div>
        <button class="sv-btn" id="svRestartBtn">Try again</button>
      </div>
    </div>

    <div class="sv-transition sv-hidden" id="svTransition"></div>
  `;
  document.body.appendChild(root);

  for (const id of [
    'svHud', 'svHpBar', 'svO2Bar', 'svXpBar', 'svLevel', 'svTime', 'svScore',
    'svStartMenu', 'svLevelUpMenu', 'svLevelUpBox', 'svGameOverMenu', 'svCards', 'svGameOverStats',
    'svLeaderboard', 'svPlayerBars', 'svToastLayer',
    'svHighScoreLabel', 'svHighScore', 'svRapidFirePanel', 'svRapidFireTime',
    'svNameRow', 'svNameInput', 'svNameSubmit', 'svLbStatus', 'svTransition',
  ]) {
    el[id] = document.getElementById(id);
  }

  // Every surface's tiles, built while the browser is otherwise idle — see
  // warmReveals. Nothing waits on it; a menu that somehow beats it just pays
  // the bake itself.
  warmReveals();

  // The start button is unreachable now that the splash goes straight into a
  // run, but it stays wired so the markup keeps working if it's ever shown
  // again while the Rive menus are being built.
  bindMenuSounds(document.getElementById('svStartBtn')).addEventListener('click', () => {
    showHud();
    callbacks.onStart();
  });
  bindMenuSounds(document.getElementById('svRestartBtn')).addEventListener('click', () => {
    // No showHud() here, unlike the start button: the next run doesn't begin
    // on this click any more, it begins on the far side of the transition (see
    // onRestart in main.js), and revealing the HUD now would leave the dead
    // run's numbers sitting over the corpse for the length of it.
    hideAllMenus();
    callbacks.onRestart();
  });

  bindMenuSounds(el.svNameSubmit).addEventListener('click', submitPendingRun);
  el.svNameInput.addEventListener('keydown', (e) => {
    // Enter submits, and stops there — without this the keypress also reaches
    // the splash/global handlers on window.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      submitPendingRun();
    }
  });
  // Typed characters are normalised on the way in rather than only on submit,
  // so the field can't show a name that the board won't accept.
  el.svNameInput.addEventListener('input', () => {
    const clean = sanitizeName(el.svNameInput.value);
    if (clean !== el.svNameInput.value) {
      const caret = el.svNameInput.selectionStart;
      el.svNameInput.value = clean;
      // Restoring the caret keeps editing mid-string from jumping to the end
      // every time a stripped character is typed.
      el.svNameInput.setSelectionRange?.(caret - 1, caret - 1);
    }
  });
}

export function setHighScore(score) {
  if (!el.svHighScore) return;
  el.svHighScoreLabel.style.display = score > 0 ? '' : 'none';
  el.svHighScore.textContent = Math.floor(score).toLocaleString();
}

// Boot entry point. The Rive title card is now the ONLY thing between load and
// play: dismissing it drops you straight into a run rather than into the old
// DOM start menu, which is being replaced by Rive artboards. The menu markup is
// still in the tree but nothing shows it — the remaining menus (level-up, game
// over) are untouched.
export function showStartMenu() {
  el.svHud.classList.add('sv-hidden');
  el.svLevelUpMenu.classList.add('sv-hidden');
  el.svGameOverMenu.classList.add('sv-hidden');
  el.svStartMenu.classList.add('sv-hidden');

  // Restarting a run goes straight through startGame, so this only ever fires
  // on boot, but the flag keeps that explicit rather than relying on nobody
  // calling showStartMenu() twice.
  if (!splashPlayed && !prefersReducedMotion()) {
    splashPlayed = true;
    mountRiveSplash({
      parent: root,
      // The title screen breaking up into cells and clearing, over a run that
      // has already started. See revealSplashOut.
      exit: revealSplashOut,
      // onDismiss also fires on a load failure, so a missing or corrupt .riv
      // starts the run anyway instead of stranding the player on a blank
      // screen with no way forward now that there's no menu to fall back to.
      onDismiss: beginRun,
    });
    return;
  }

  // No splash (reduced motion, or it already played) means no gesture to wait
  // for — go straight in. Audio comes up on the player's first input; see
  // unlockAudio.
  beginRun();
}

// Called SYNCHRONOUSLY from the splash's dismiss handler, not deferred to the
// next frame: startGame calls unlockAudio, and an AudioContext built outside the
// call stack of a real user gesture comes up suspended and stays silent. The
// press that dismissed the splash is that gesture, so it has to still be on the
// stack. startGame clears pending input edges itself, so the same keypress
// doesn't also spend a boost charge on frame one.
function beginRun() {
  showHud();
  callbacks.onStart();
}

// Revealing the HUD used to live inside the start/restart button handlers, so
// any route into a run that wasn't a button click began with no health, oxygen
// or score on screen. Exported as well as used here, because the restart route
// no longer starts its run on the click — it starts on the far side of the
// transition, and that's where the HUD belongs with it.
export function showHud() {
  el.svHud.classList.remove('sv-hidden');
}

// --- the restart transition -------------------------------------------------
// The cover over the gap between "Try again" and the next run, while the
// clock, the mix and the lens glide back to normal (systems/deathDive.js).
//
// Deliberately just a wash of the background colour: this is the slot for the
// transition graphic. Put the art inside #svTransition and the timing around
// it doesn't change — it fades up over `seconds`, the run starts underneath
// it, and it clears in a little over half that so the new run isn't played
// blind.
export function showRestartTransition(seconds = 0.9) {
  if (!el.svTransition) return;
  el.svTransition.style.setProperty('--sv-trans', `${seconds}s`);
  el.svTransition.classList.remove('sv-hidden');
  // Two frames, not one: the element was display:none a moment ago, and a
  // class added in the same frame it becomes visible has no starting value to
  // transition from, so it snaps to opaque instead of fading.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.svTransition?.classList.add('sv-trans-in');
  }));
}

export function hideRestartTransition(seconds = 0.5) {
  if (!el.svTransition) return;
  el.svTransition.style.setProperty('--sv-trans', `${seconds}s`);
  el.svTransition.classList.remove('sv-trans-in');
  // Hidden again once it's clear rather than left at opacity 0 — it covers the
  // whole screen, and a full-screen layer that stays in the tree for a whole
  // run is a compositing cost for nothing. Pointer-events are off throughout,
  // so even mid-fade it can't eat the first shot of the new run.
  window.setTimeout(() => {
    if (!el.svTransition?.classList.contains('sv-trans-in')) {
      el.svTransition?.classList.add('sv-hidden');
    }
  }, seconds * 1000 + 60);
}

// The splash is pure motion with no way to opt out mid-play, so honour the
// system setting by skipping it entirely. The CSS rule at the bottom of STYLES
// only disables transitions, which wouldn't touch a canvas animation.
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function hideAllMenus() {
  el.svStartMenu.classList.add('sv-hidden');
  cancelReveal('upgrades');
  clearMask(el.svLevelUpMenu, el.svLevelUpBox);
  setMenuLocked(false);
  el.svLevelUpMenu.classList.add('sv-hidden');
  el.svGameOverMenu.classList.add('sv-hidden');
  levelUpCards = [];
}

// ---------------------------------------------------------------------------
// Reveals
// ---------------------------------------------------------------------------
// Nothing in this UI cuts in or plain-fades any more. Menus dissolve, through
// a mask built from noise, and each surface gets its own algorithm so the
// transitions are recognisably different from each other rather than one
// effect used three times:
//
//   upgrades   BILLOW through a hexagonal lattice. Chunky and digital, made of
//              the same hexagons the cards are clipped to.
//   splash     WORLEY, smooth. The title screen breaks up into cells and
//              clears, and the run is already live underneath it.
//   scoreCard  RIDGED, smooth. The score card arrives in strands rather than
//              blobs, which is a slower, colder read for the end of a run.
//
// Two styles:
//
//   'hex'      an ordered dither on a hex lattice (the structure) masked by
//              the noise field (where it fills in). Needs TWO nested elements,
//              because masks multiply down the tree — that's how the two
//              layers compose without `mask-composite`, whose keywords and
//              layer order still differ between engines.
//   'smooth'   no lattice and no dithering at all: the field alone, with a
//              soft edge, on one element.
//
// The field is stretched over the element rather than tiled across it — see
// revealFieldSize. The tiles come from ./dither.js and are baked once.
//
// All of this runs on the WALL clock, on its own rAF, like every other
// transition in this file. It deliberately does NOT ride the level-up time
// dilation: the slow motion is the world, and the interface arriving over the
// top of it is not part of the world.

// One entry per running reveal, keyed by surface name, so the splash
// dissolving out and a menu coming in never cancel each other.
const revealRaf = new Map();
let menuLocked = false;

function supportsMask() {
  const s = document.documentElement.style;
  return 'maskImage' in s || 'webkitMaskImage' in s;
}

function applyMask(target, image, size, position = '0px 0px', repeat = 'repeat') {
  if (!target) return;
  const s = target.style;
  s.webkitMaskImage = image;
  s.maskImage = image;
  s.webkitMaskSize = size;
  s.maskSize = size;
  s.webkitMaskRepeat = repeat;
  s.maskRepeat = repeat;
  s.webkitMaskPosition = position;
  s.maskPosition = position;
  s.webkitMaskMode = 'alpha';
  s.maskMode = 'alpha';
}

// A masked layer costs compositing for as long as it's there, and once the
// reveal has landed the mask is a no-op anyway.
function clearMask(...targets) {
  for (const target of targets) {
    if (!target) continue;
    target.style.webkitMaskImage = '';
    target.style.maskImage = '';
  }
}

function cancelReveal(name) {
  const raf = revealRaf.get(name);
  if (raf) cancelAnimationFrame(raf);
  revealRaf.delete(name);
}

// Locking is a class rather than a flag alone because the cards are real DOM
// elements with their own hover and focus: mid-dissolve they're half-drawn and
// must not be clickable, or a held fire button picks whatever the pointer
// happens to be over before the menu has finished arriving.
function setMenuLocked(locked) {
  menuLocked = locked;
  el.svLevelUpMenu?.classList.toggle('sv-menu-locked', locked);
}

// A surface's settings: the shared field, then whatever that surface overrides.
function revealCfg(name) {
  const all = CONFIG.reveals ?? {};
  const f = all.field ?? {};
  const r = all[name] ?? {};
  const smooth = r.style !== 'hex';
  return {
    name,
    enabled: all.enabled !== false && r.enabled !== false,
    smooth,
    inTime: r.inTime ?? 0.5,
    outTime: r.outTime ?? 0.22,
    steps: Math.max(2, Math.round(r.steps ?? 14)),
    hexSize: Math.max(4, Math.round(r.hexSize ?? 24)),
    // Without the lattice there is nothing else to reveal through, so in
    // smooth style the field owns the whole reveal rather than sharing it.
    bias: smooth ? 1 : Math.max(0.02, Math.min(0.9, r.bias ?? 0.35)),
    // A hard edge is what the lattice wants under it — the hexes ARE the edge.
    // Smooth style is the opposite: the ramp is the whole effect.
    softness: smooth ? Math.max(0.02, r.softness ?? 0.35) : (r.softness ?? 0),
    // Gamma on the reveal's progress. The masks are measurably linear — mean
    // alpha tracks the level to within a couple of percent — but a soft mask
    // does not LOOK linear: a bright card at 20% alpha over a dark ocean
    // already reads as arrived, so an even ramp appears to finish half way
    // through and then dawdle. Above 1 holds the start back.
    curve: r.curve ?? (smooth ? 1.7 : 1),
    drift: r.drift ?? f.drift ?? 26,
    over: Math.max(0, r.over ?? f.over ?? 18),
    boilHz: Math.max(0, r.boilHz ?? f.boilHz ?? 12),
    field: {
      algo: r.algo ?? 'simplex',
      size: Math.max(16, Math.round(f.size ?? 128)),
      scale: Math.max(1, Math.round(r.scale ?? f.scale ?? 8)),
      octaves: Math.max(1, Math.round(f.octaves ?? 2)),
      levels: Math.max(2, Math.round(f.levels ?? 12)),
      phases: Math.max(1, Math.round(f.phases ?? 5)),
      softness: smooth ? Math.max(0.02, r.softness ?? 0.35) : (r.softness ?? 0),
    },
  };
}

// The field is STRETCHED over the surface, not tiled across it.
//
// Tiling was the original approach and it repeats: a tile big enough to cover
// a 760px menu costs a third of a second to bake (measured — 160px takes 55ms,
// 224px takes 380ms, and it is quadratic in the side). Stretching one small
// field over the whole element costs nothing, can never repeat, and the blur
// from the upscale is either invisible (the hex lattice supplies the hard
// edges) or the entire point (smooth style). It also frees the noise from
// having to be periodic in x and y, which is what lets simplex and worley be
// on the menu at all.
//
// Oversized by `over` percent so the drift has somewhere to move without
// pulling the field off the element. Anything past the edge of a no-repeat
// mask is transparent — which HIDES rather than reveals, so the failure
// direction is safe either way.
function revealFieldSize(c) {
  const pct = 100 + c.over;
  return `${pct}% ${pct}%`;
}

// One frame. `raw` is 0 (nothing showing) to 1 (everything).
function paintReveal(c, hex, noise, target, inner, raw, elapsed) {
  const t = Math.pow(raw, c.curve);
  if (hex) {
    // Exponents that add to 1, so the product of the two layers' coverage is t
    // itself — the share can be tuned without changing how long the reveal
    // takes or how it paces.
    applyMask(target, hex.masks[Math.round(Math.pow(t, 1 - c.bias) * c.steps)], hex.tile);
  } else {
    clearMask(target === inner ? null : target);
  }
  if (!noise) return;
  // The field slides into place as it opens, then settles — motion that stops
  // when the reveal does, rather than a pattern still sliding under a menu
  // that has finished arriving.
  const drift = (1 - t) * c.drift;
  const phase = Math.floor(elapsed * c.boilHz) % c.field.phases;
  applyMask(
    inner,
    noise.masks[phase][Math.round(Math.pow(t, c.bias) * c.field.levels)],
    revealFieldSize(c),
    `${-drift}px ${drift * 0.6}px`,
    'no-repeat',
  );
}

/**
 * Dissolve a surface in or out.
 *
 * @param name    which surface's settings to use (CONFIG.reveals.<name>)
 * @param target  the element the lattice masks. In smooth style this is only
 *                used when there's no separate `inner`.
 * @param inner   the element the field masks — a CHILD of target, so the two
 *                masks multiply. Hex style needs one; smooth style doesn't.
 * @returns false if it couldn't run (masks unsupported, reduced motion, tiles
 *          wouldn't build). `onDone` has already been called in that case, so
 *          the caller's finish-up still happens — a reveal that can't animate
 *          must still SHOW the thing.
 */
function runReveal(name, { target, inner, from, to, seconds, onDone }) {
  cancelReveal(name);
  const c = revealCfg(name);
  const box = inner ?? target;
  const finish = () => {
    revealRaf.delete(name);
    clearMask(target, box);
    onDone?.();
  };

  if (!c.enabled || seconds <= 0 || prefersReducedMotion() || !supportsMask()) {
    finish();
    return false;
  }

  let hex = null;
  let noise = null;
  try {
    if (!c.smooth && inner) hex = hexMaskSet(c.steps, c.hexSize);
    noise = noiseMaskSet(c.field);
  } catch {
    // Couldn't build the tiles at all — a canvas that won't give up pixels.
    // Show the thing rather than leaving it masked by something that doesn't
    // exist.
    finish();
    return false;
  }

  const start = performance.now();
  // Times itself off performance.now() rather than the timestamp rAF hands in.
  // The two agree in a browser, but only one of them is guaranteed to be the
  // same clock `start` was read from, and a reveal measured across two clocks
  // either finishes instantly or never finishes at all.
  const frame = () => {
    const elapsed = (performance.now() - start) / 1000;
    const t = Math.min(1, elapsed / seconds);
    paintReveal(c, hex, noise, target, box, from + (to - from) * t, elapsed);
    if (t >= 1) {
      finish();
      return;
    }
    revealRaf.set(name, requestAnimationFrame(frame));
  };
  // First frame painted synchronously, so the surface is never visible whole
  // for the frame between being un-hidden and the first rAF landing.
  frame();
  return true;
}

// Baking the tiles costs tens of milliseconds per surface — up to about 130
// for the cellular field, which is the dearest of the set. That's nothing at
// boot and very visible if it lands on the frame a menu opens, so every
// surface's tiles are built here instead, when the browser next has a moment.
//
// The splash is first because it's the first one needed, and by some margin.
export function warmReveals() {
  if (!supportsMask() || prefersReducedMotion()) return;
  const queue = ['splash', 'upgrades', 'scoreCard'];
  const build = () => {
    const name = queue.shift();
    if (!name) return;
    const c = revealCfg(name);
    try {
      if (c.enabled) {
        if (!c.smooth) hexMaskSet(c.steps, c.hexSize);
        noiseMaskSet(c.field);
      }
    } catch {
      // See runReveal: a surface that can't bake still shows, uncovered.
    }
    // One per idle slot rather than all three back to back, so a slow machine
    // spreads the work over several frames instead of dropping one.
    schedule(build);
  };
  schedule(build);
}

function schedule(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 4000 });
  else setTimeout(fn, 120);
}

// --- the surfaces -----------------------------------------------------------

// Upgrade cards in. Called once the menu's contents are built and laid out.
function revealUpgradesIn() {
  setMenuLocked(true);
  const landed = runReveal('upgrades', {
    target: el.svLevelUpMenu,
    inner: el.svLevelUpBox,
    from: 0,
    to: 1,
    seconds: revealCfg('upgrades').inTime,
    onDone: () => setMenuLocked(false),
  });
  // Nothing animated, so nothing is half-drawn and nothing needs locking.
  if (!landed) setMenuLocked(false);
}

// Upgrade cards out, on a pick. Deliberately does not block anything: the run
// is re-engaged on the same frame the card is clicked, and this dissolves over
// the top of a game that is already moving again.
function revealUpgradesOut() {
  const finish = () => {
    el.svLevelUpMenu.classList.add('sv-hidden');
    setMenuLocked(false);
  };
  // Stays locked for the dissolve, so the cards on their way out can't take a
  // second click. If another level is pending, showLevelUp cancels this and
  // starts a fresh reveal — which is why `finish` hides the menu rather than
  // anything on the way in doing it.
  setMenuLocked(true);
  runReveal('upgrades', {
    target: el.svLevelUpMenu,
    inner: el.svLevelUpBox,
    from: 1,
    to: 0,
    seconds: revealCfg('upgrades').outTime,
    onDone: finish,
  });
}

/**
 * The splash breaking up and clearing. Handed to mountRiveSplash, which calls
 * it instead of removing its own wrapper — see riveSplash.js.
 *
 * The run has already started by the time this runs, so what's dissolving is a
 * still of the title screen over a live game.
 */
function revealSplashOut(wrap, done) {
  runReveal('splash', {
    target: wrap,
    from: 1,
    to: 0,
    seconds: revealCfg('splash').outTime,
    onDone: done,
  });
}

// The score card arriving, in strands. Runs alongside the CSS rise — see
// showGameOver — rather than instead of it: the rise is the movement, this is
// the texture it arrives with.
//
// Nothing is locked out while it runs. The name field is focused immediately
// and typing into a card that is still resolving is fine; there is no wrong
// thing to click on this screen the way there is on the upgrade menu.
function revealScoreCardIn() {
  runReveal('scoreCard', {
    target: el.svGameOverMenu,
    from: 0,
    to: 1,
    seconds: revealCfg('scoreCard').inTime,
  });
}

// Which stack of `choice` this card would be — 1 for the first one taken.
function nextStack(choice) {
  return player.upgrades.filter((id) => id === choice.id).length + 1;
}

// An upgrade with `perLevelName` numbers its card: "Seal Team 1", "Seal Team
// 2". Everything else shows its name unchanged, so this stays opt-in per
// upgrade rather than turning every repeatable card into a counter. The base
// name is still whatever the Upgrades tab has it set to — renaming Seal Team
// there renames the numbered card too.
function cardName(choice) {
  return choice.perLevelName ? `${choice.name} ${nextStack(choice)}` : choice.name;
}

// `levelDescs` swaps the description at a specific stack, so a card that
// changes what it does at level N can say so on the card that grants it.
function cardDesc(choice) {
  return choice.levelDescs?.[nextStack(choice)] ?? choice.desc;
}

// The cards currently on screen, in visual order, and which one the pad has
// selected. Rebuilt every time the menu opens.
let levelUpCards = [];
let selectedIndex = -1;

export function showLevelUp() {
  const pool = availableUpgrades();
  const picks = drawUpgrades(pool, CONFIG.upgradeChoices);

  el.svCards.innerHTML = '';
  for (const choice of picks) {
    const card = document.createElement('div');
    card.className = 'sv-card';
    card.tabIndex = 0;

    // `cardArt` comes off the upgrade itself — the `cardArt` column of
    // upgrades.csv, validated against LEVELUP_IMAGE_KEYS when the file loads,
    // so anything non-null here is a key that exists.
    const image = choice.cardArt ? LEVELUP_IMAGES[choice.cardArt] : null;
    if (image) {
      card.style.backgroundImage = `url(${image.src})`;
      card.style.backgroundSize = '100% 100%'; // art and card are both square, so this aligns the drawn hex to the clip exactly
      card.style.backgroundPosition = 'center';
    }

    const overlay = document.createElement('div');
    overlay.className = 'sv-card-overlay';
    const oc = CONFIG.levelUpCards.overlayColor;
    const [r, g, b] = [(oc >> 16) & 255, (oc >> 8) & 255, oc & 255];
    overlay.style.background = image
      ? `rgba(${r},${g},${b},${CONFIG.levelUpCards.overlayOpacity})`
      : 'transparent';

    const content = document.createElement('div');
    content.className = 'sv-card-content';
    content.innerHTML = `<div class="sv-card-name"></div><div class="sv-card-desc"></div>`;
    content.querySelector('.sv-card-name').textContent = cardName(choice);
    content.querySelector('.sv-card-desc').textContent = cardDesc(choice);

    card.append(overlay, content);

    const pick = () => {
      // Half-drawn cards aren't a menu yet — see setMenuLocked. The class
      // stops the mouse; this stops the pad and the keyboard, which reach the
      // card without going through pointer-events at all.
      if (menuLocked) return;
      levelUpCards = [];
      // Dissolves out rather than vanishing, and the choice is filed on this
      // frame regardless: the run comes back to life behind the cards while
      // they're still on their way off, not after them.
      revealUpgradesOut();
      callbacks.onLevelChoice(choice);
    };
    // Bound before `pick`, so the click is heard on the frame the card is
    // chosen rather than after the dissolve has already started taking it away.
    bindMenuSounds(card);
    card.addEventListener('click', pick);
    // A card is a div, not a button, so Enter and Space do NOT get turned into
    // a click by the browser — this calls pick() directly and the click
    // listener above never runs. Hence the explicit sound here. The pad is a
    // different case again: updateMenuNav confirms by calling .click(), which
    // does dispatch, so it is already covered and must not be voiced twice.
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        feedback('uiClick');
        pick();
      }
    });
    el.svCards.appendChild(card);
  }
  // Reveal first: the cards have no layout while the menu is display:none, so
  // measuring before this point reads zeroes.
  el.svLevelUpMenu.classList.remove('sv-hidden');
  for (const card of el.svCards.children) fitCardText(card);

  // Gamepad navigation. The selection starts on the first card so there's
  // always something A can confirm, and the pad's buttons are re-baselined so
  // the fire button being held right now doesn't pick it instantly.
  levelUpCards = [...el.svCards.children];
  selectedIndex = -1;
  resetMenuInput();
  selectCard(0);

  // Last, once everything is built, laid out and selected: the reveal masks
  // the finished menu, and a card added after it started would appear whole
  // over a half-dithered one.
  revealUpgradesIn();
}

function selectCard(i) {
  if (!levelUpCards.length) return;
  const previous = selectedIndex;
  selectedIndex = Math.max(0, Math.min(levelUpCards.length - 1, i));
  // The pad and the keyboard get the same hover the mouse does — otherwise the
  // menu is silent for anyone not using a pointer, which is most of a run on a
  // controller. Only on a real MOVE: showLevelUp calls selectCard(0) to put the
  // selection somewhere before the cards have finished arriving, and a blip on
  // that is the menu announcing itself rather than answering the player.
  // Stepping into the card you are already on is not a move either.
  if (previous >= 0 && previous !== selectedIndex) feedback('uiHover');
  levelUpCards.forEach((card, n) => card.classList.toggle('sv-card-sel', n === selectedIndex));
  // Move real focus along with it, so Enter/Space keep working on whatever the
  // pad is pointing at and the two input methods can't disagree about which
  // card is live. preventScroll because the menu is centred already and a
  // scroll here would only jostle it.
  levelUpCards[selectedIndex].focus({ preventScroll: true });
}

// Cards wrap onto a second row on a narrow screen, so a step goes to the
// nearest card in the direction pushed rather than to the next one in DOM
// order — which on a wrapped layout would send "right" off to the row below.
function stepSelection(dx, dy) {
  const centres = levelUpCards.map((card) => {
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const from = centres[selectedIndex];
  let best = -1;
  let bestScore = Infinity;

  for (let i = 0; i < centres.length; i++) {
    if (i === selectedIndex) continue;
    const ox = centres[i].x - from.x;
    const oy = centres[i].y - from.y;
    const along = ox * dx + oy * dy; // how far it lies in the pushed direction
    if (along <= 1) continue; // beside or behind — not a candidate for this press
    // Sideways drift counts double, so a card straight ahead beats a nearer
    // one off to the side.
    const score = along + Math.abs(ox * dy - oy * dx) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }

  // Nothing that way. Horizontally that means an end of the row, which wraps —
  // three cards should cycle rather than dead-end. Vertically it stays put, so
  // a stick nudge while reading can't throw the selection somewhere unrelated.
  if (best < 0 && dx) best = dx > 0 ? 0 : levelUpCards.length - 1;
  return best < 0 ? selectedIndex : best;
}

// Called once per frame from the game loop. No-op unless the level-up menu is
// actually up — it's the only screen the pad drives.
export function updateMenuNav() {
  if (!levelUpCards.length || el.svLevelUpMenu.classList.contains('sv-hidden')) return;
  // Nothing to drive while the cards are still dissolving in — and in
  // particular no confirm, or a fire button held through the level-up picks
  // the first card before it has finished arriving.
  if (menuLocked) return;

  // Tab or a click can move focus without going through selectCard, so adopt
  // whatever the player is actually on before stepping off it.
  const focused = levelUpCards.indexOf(document.activeElement);
  if (focused >= 0 && focused !== selectedIndex) selectCard(focused);

  if (menuInput.x || menuInput.y) selectCard(stepSelection(menuInput.x, menuInput.y));
  // Routed through the card's own click handler rather than a second copy of
  // pick(), so the pad can never take a path the mouse doesn't.
  if (menuInput.confirm) levelUpCards[selectedIndex]?.click();
}

// The hex leaves a narrow box for text, so a long name like "Starfish
// Shuriken" won't fit at full size. Rather than breaking the word across
// lines, step the type down until every line holds whole words and the whole
// block clears the box vertically. Both sizes shrink together (one --sv-fit
// per card) so the name/description hierarchy survives the scaling.
const FIT_MIN = 0.5;
const FIT_STEP = 0.04;

function fitCardText(card) {
  const content = card.querySelector('.sv-card-content');
  const lines = [...content.children];
  let fit = 1;
  card.style.setProperty('--sv-fit', '1');
  while (fit > FIT_MIN && overflowsBox(content, lines)) {
    fit = Math.max(FIT_MIN, fit - FIT_STEP);
    card.style.setProperty('--sv-fit', fit.toFixed(2));
  }
}

// A word wider than its box overflows it, which shows up as scrollWidth
// exceeding clientWidth — that's the mid-word break we're avoiding, since
// nothing in the CSS is allowed to split the word instead.
function overflowsBox(content, lines) {
  if (content.scrollHeight > content.clientHeight + 1) return true;
  return lines.some((line) => line.scrollWidth > line.clientWidth + 1);
}

// Projects a world position to CSS pixels. The renderer canvas fills the
// viewport, so NDC maps straight onto window dimensions.
function projectToScreen(camera, worldPos, out) {
  PROJECT_V.copy(worldPos).project(camera);
  out.x = (PROJECT_V.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-PROJECT_V.y * 0.5 + 0.5) * window.innerHeight;
  return out;
}

const PROJECT_V = new THREE.Vector3();
const screenPt = { x: 0, y: 0 };

export function updateHUD(gameState, player, strikeState = null, rapidFireTimer = 0, camera = null) {
  el.svHpBar.style.width = `${Math.max(0, (player.hp / player.stats.maxHp) * 100)}%`;
  el.svXpBar.style.width = `${Math.max(0, Math.min(1, gameState.xp / gameState.xpToNext)) * 100}%`;
  el.svLevel.textContent = gameState.level;
  el.svScore.textContent = Math.floor(gameState.score ?? 0).toLocaleString();
  el.svTime.textContent = formatTime(gameState.time);

  const o2Frac = Math.max(0, player.oxygen / Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen.max));
  el.svO2Bar.style.width = `${o2Frac * 100}%`;
  el.svO2Bar.classList.toggle('sv-o2-low', o2Frac < 0.25);

  if (camera && el.svPlayerBars) {
    // Offset in WORLD units, not pixels — a pixel gap would drift as the
    // arena rescales, where this keeps a constant distance from the seal.
    PROJECT_V.set(player.mesh.position.x, player.mesh.position.y + CONFIG.hud.playerBarOffset, player.mesh.position.z);
    projectToScreen(camera, PROJECT_V, screenPt);
    el.svPlayerBars.style.left = `${screenPt.x}px`;
    el.svPlayerBars.style.top = `${screenPt.y}px`;
    // At full health AND full oxygen there's nothing to watch, so the bars
    // fade back rather than permanently tagging the seal.
    const idle = player.hp >= player.stats.maxHp && o2Frac > 0.995;
    el.svPlayerBars.style.opacity = idle ? '0.25' : '1';
  }

  if (rapidFireTimer > 0) {
    el.svRapidFirePanel.style.display = '';
    el.svRapidFireTime.textContent = `${rapidFireTimer.toFixed(1)}s`;
  } else if (el.svRapidFirePanel) {
    el.svRapidFirePanel.style.display = 'none';
  }
}

// --- score toasts ---------------------------------------------------------
// One small number per kill, rising from where the creature died. Driven by
// the game loop rather than CSS animation so they pause with the game and
// can't outlive a run.

const toasts = [];

export function spawnScoreToast(camera, worldX, worldY, points, multiplier = 1) {
  if (!el.svToastLayer || !camera) return;
  PROJECT_V.set(worldX, worldY, 0);
  projectToScreen(camera, PROJECT_V, screenPt);

  const node = document.createElement('div');
  const combo = multiplier > 1;
  node.className = combo ? 'sv-toast sv-toast-combo' : 'sv-toast';
  // The number shown is always what was actually banked. When a combo is
  // live, the multiplier is appended as context — so the big figure is the
  // real one and you never have to do the arithmetic yourself.
  node.textContent = `+${points.toLocaleString()}`;
  if (combo) {
    const tag = document.createElement('span');
    tag.className = 'sv-toast-mult';
    tag.textContent = ` ×${multiplier.toFixed(1)}`;
    node.appendChild(tag);
  }
  el.svToastLayer.appendChild(node);

  toasts.push({
    node,
    x: screenPt.x,
    y: screenPt.y,
    // Slight horizontal scatter so simultaneous kills in a school don't
    // stack into one illegible clump.
    vx: (Math.random() - 0.5) * 26,
    vy: -46 - Math.random() * 18,
    life: combo ? 1.1 : 0.85,
    age: 0,
  });

  // Hard ceiling — a school wipe can kill a dozen creatures on one frame,
  // and unbounded DOM nodes would tank the frame rate.
  while (toasts.length > 40) removeToast(0);
}

// The FOOD CHAIN! banner. Announces that the strike chain EXTENDED, with the
// link count alongside it.
//
// Only ever one on screen. A chain extends faster than a toast can finish
// rising — six links inside two seconds is an ordinary run — so stacking one
// banner per link would leave a column of overlapping FOOD CHAIN!s climbing
// the screen and no readable number anywhere in it. Instead an extension
// re-uses the live node: new count, new colour, age wound back to zero, so it
// re-pops in place. That re-pop IS the feedback for the link.
let chainToast = null;

export function spawnChainToast(camera, worldX, worldY, chain) {
  if (!el.svToastLayer || !camera) return;
  PROJECT_V.set(worldX, worldY, 0);
  projectToScreen(camera, PROJECT_V, screenPt);

  // Gold at the bottom, running to a hot orange as the chain deepens — the
  // same "this is getting out of hand" ramp the combo speed and grid warp are
  // already on, so all three read as one escalation.
  const t = Math.min(1, Math.max(0, (chain - 2) / 6));
  const color = `rgb(255, ${Math.round(224 - 96 * t)}, ${Math.round(102 - 44 * t)})`;

  if (chainToast && toasts.includes(chainToast)) {
    chainToast.age = 0;
    chainToast.x = screenPt.x;
    chainToast.y = screenPt.y;
    chainToast.node.style.color = color;
    chainToast.count.textContent = `×${chain}`;
    return;
  }

  const node = document.createElement('div');
  node.className = 'sv-chain';
  node.style.color = color;
  node.textContent = 'FOOD CHAIN!';
  const count = document.createElement('span');
  count.className = 'sv-chain-x';
  count.textContent = `×${chain}`;
  node.appendChild(count);
  el.svToastLayer.appendChild(node);

  chainToast = {
    node,
    count,
    x: screenPt.x,
    y: screenPt.y,
    // No horizontal scatter and a slower rise than a score toast: there's
    // only one of these, so it has nothing to avoid, and it wants to sit
    // still long enough to be read.
    vx: 0,
    vy: -30,
    life: 1.3,
    age: 0,
    pop: 0.55,
  };
  toasts.push(chainToast);
}

function removeToast(i) {
  if (toasts[i] === chainToast) chainToast = null;
  toasts[i].node.remove();
  toasts.splice(i, 1);
}

export function updateToasts(dt) {
  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i];
    t.age += dt;
    if (t.age >= t.life) { removeToast(i); continue; }
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.vy += 42 * dt; // ease the rise so it settles rather than flying off
    const k = t.age / t.life;
    t.node.style.transform = `translate(-50%,-50%) scale(${1 + (1 - k) * (t.pop ?? 0.25)})`;
    t.node.style.left = `${t.x}px`;
    t.node.style.top = `${t.y}px`;
    t.node.style.opacity = `${1 - k * k}`;
  }
}

// The floating hp/air bars are pinned to the seal by projecting its world
// position inside updateHUD — which stops being called the moment the run
// ends. Left alone through the death dive they'd hang wherever the seal
// happened to die while the camera pushes in past them and the body sinks out
// from under them. Faded rather than hidden, so the next run's first updateHUD
// puts them back with no state to remember.
export function hidePlayerBars() {
  if (el.svPlayerBars) el.svPlayerBars.style.opacity = '0';
}

export function clearToasts() {
  while (toasts.length) removeToast(0);
}

// The run is NOT posted to the board here — the player names it first, and
// nothing is submitted until they confirm. What shows immediately is the run's
// own stats plus the board as it currently stands, so there's something to aim
// at while typing rather than an empty panel.
export function showGameOver(gameState) {
  el.svHud.classList.add('sv-hidden');
  const score = Math.floor(gameState.score ?? 0);
  el.svGameOverStats.innerHTML =
    `Score: ${score.toLocaleString()}<br/>Survived ${formatTime(gameState.time)} — Kills: ${gameState.kills} — Level ${gameState.level}`;

  const token = ++gameOverToken;
  pendingRun = {
    score,
    kills: gameState.kills,
    level: gameState.level,
    time: gameState.time,
    date: Date.now(),
  };

  el.svNameRow.classList.remove('sv-hidden');
  el.svNameSubmit.disabled = false;
  el.svNameInput.disabled = false;
  el.svNameInput.value = loadPlayerName();
  setStatus(isGlobal() ? 'Enter a name to post your score' : 'Enter a name to save your score');

  // Show the standing board right away from local data, then upgrade it to the
  // global one when that arrives. Waiting on the network first would leave the
  // panel blank for as long as the request takes.
  renderBoard(loadLeaderboard(), { global: false });
  if (isGlobal()) {
    fetchGlobalBoard().then((list) => {
      // Drop it if this screen has been replaced, or if the player already
      // submitted — the board that came back from submitting is newer.
      if (list && token === gameOverToken && pendingRun) renderBoard(list, { global: true });
    });
  }

  // Arrives rather than cutting in. The dive spends its last couple of seconds
  // on a body lying still on the seabed, and a card that hard-cuts over that
  // shot throws the pacing away in one frame.
  //
  // Two things at once: the card rises and fades (the CSS animation, restarted
  // by hand each time — an animation on an element that was display:none
  // doesn't replay on its own, so a second run would show it already at full
  // opacity), and it dissolves in through the ridged field, which comes in as
  // strands rather than blobs. The rise is the motion; the reveal is the
  // texture.
  el.svGameOverMenu.classList.remove('sv-fade-in');
  el.svGameOverMenu.style.setProperty('--sv-fade', `${CONFIG.death?.fadeIn ?? 0.9}s`);
  el.svGameOverMenu.classList.remove('sv-hidden');
  void el.svGameOverMenu.offsetWidth; // reflow — this is what re-arms the animation
  el.svGameOverMenu.classList.add('sv-fade-in');
  revealScoreCardIn();

  // Focus lands on the field so a name can be typed without clicking first,
  // but only with a real keyboard — on touch, focusing would throw up the
  // on-screen keyboard over the board before the player has asked for it.
  if (!isTouchPrimary()) {
    el.svNameInput.focus();
    el.svNameInput.select();
  }
}

async function submitPendingRun() {
  if (!pendingRun) return;

  const run = pendingRun;
  pendingRun = null; // claim it before any await — a double click must not post twice

  const name = savePlayerName(el.svNameInput.value) || 'ANON';
  el.svNameSubmit.disabled = true;
  el.svNameInput.disabled = true;
  setStatus(isGlobal() ? 'Posting…' : 'Saving…');

  const result = await submitScore({ ...run, name });

  // The local board is what the start menu's high score reads from, and
  // submitScore always writes there — so this is right either way.
  setHighScore(highScore());

  el.svNameRow.classList.add('sv-hidden');
  renderBoard(result.list, { global: result.global, result });

  if (result.error) {
    setStatus(`Couldn't reach the global board — saved on this device as ${name}`, true);
  } else if (result.madeList) {
    setStatus(`#${result.rank} as ${name}`);
  } else {
    setStatus(`Saved as ${name} — didn't make the top 10`);
  }
}

function setStatus(text, isError = false) {
  el.svLbStatus.textContent = text;
  el.svLbStatus.classList.toggle('sv-status-err', isError);
}

// `result` is only passed after a submit — that's the one case where a row can
// be identified as this player's, since rank comes back with the write.
function renderBoard(list, { global, result = null } = {}) {
  const heading = global ? 'Global leaderboard' : 'Leaderboard (this device)';

  if (!list?.length) {
    el.svLeaderboard.innerHTML =
      `<div class="sv-label" style="margin-bottom:6px;">${heading}</div>` +
      `<div class="sv-lb-empty">No scores yet — be the first.</div>`;
    return;
  }

  const rows = list
    .map((e, i) => {
      const mine = result?.madeList && i === result.rank - 1;
      return `<div class="sv-lb-row${mine ? ' sv-lb-mine' : ''}">
        <span class="sv-lb-rank">${i + 1}</span>
        <span class="sv-lb-name">${escapeHtml(e.name ?? 'ANON')}</span>
        <span class="sv-lb-score">${Number(e.score ?? 0).toLocaleString()}</span>
        <span class="sv-lb-meta">Lv${e.level} · ${formatTime(e.time)}</span>
      </div>`;
    })
    .join('');

  el.svLeaderboard.innerHTML =
    `<div class="sv-label" style="margin-bottom:6px;">${heading}</div>${rows}`;
}

// Names come back from a server anyone can POST to, so they're escaped at the
// point of display as well as being stripped on the way in. Belt and braces:
// this is the only place a remote string reaches innerHTML.
function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function isTouchPrimary() {
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
}

function formatTime(t) {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
