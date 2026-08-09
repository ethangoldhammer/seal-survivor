import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
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

let callbacks = {};
const el = {};
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
          Desktop: WASD to steer, mouse to aim, hold click to fire. Space to strike.<br/>
          Mobile: drag to aim and fire. &nbsp;·&nbsp; Gamepad: sticks to move/aim, A to fire, any bumper or trigger to boost.
        </div>
        <div class="sv-label" id="svHighScoreLabel" style="margin-bottom:10px; display:none;">High score: <span id="svHighScore">0</span></div>
        <button class="sv-btn" id="svStartBtn">Start run</button>
        <div class="sv-hint">\` tuning &nbsp;·&nbsp; T textures &nbsp;·&nbsp; P screen filter &nbsp;·&nbsp; M mute &nbsp;·&nbsp; Space strike &nbsp;·&nbsp; hold G gamepad info</div>
      </div>
    </div>

    <div class="sv-center sv-hidden" id="svLevelUpMenu">
      <div class="sv-menu">
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
    'svStartMenu', 'svLevelUpMenu', 'svGameOverMenu', 'svCards', 'svGameOverStats',
    'svLeaderboard', 'svPlayerBars', 'svToastLayer',
    'svHighScoreLabel', 'svHighScore', 'svRapidFirePanel', 'svRapidFireTime',
    'svNameRow', 'svNameInput', 'svNameSubmit', 'svLbStatus', 'svTransition',
  ]) {
    el[id] = document.getElementById(id);
  }

  // The start button is unreachable now that the splash goes straight into a
  // run, but it stays wired so the markup keeps working if it's ever shown
  // again while the Rive menus are being built.
  document.getElementById('svStartBtn').addEventListener('click', () => {
    showHud();
    callbacks.onStart();
  });
  document.getElementById('svRestartBtn').addEventListener('click', () => {
    // No showHud() here, unlike the start button: the next run doesn't begin
    // on this click any more, it begins on the far side of the transition (see
    // onRestart in main.js), and revealing the HUD now would leave the dead
    // run's numbers sitting over the corpse for the length of it.
    hideAllMenus();
    callbacks.onRestart();
  });

  el.svNameSubmit.addEventListener('click', submitPendingRun);
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
  el.svLevelUpMenu.classList.add('sv-hidden');
  el.svGameOverMenu.classList.add('sv-hidden');
  levelUpCards = [];
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
  const picks = [...pool].sort(() => Math.random() - 0.5).slice(0, CONFIG.upgradeChoices);

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
      el.svLevelUpMenu.classList.add('sv-hidden');
      levelUpCards = [];
      callbacks.onLevelChoice(choice);
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
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
}

function selectCard(i) {
  if (!levelUpCards.length) return;
  selectedIndex = Math.max(0, Math.min(levelUpCards.length - 1, i));
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

  // Fades up rather than cutting in. The dive spends its last couple of
  // seconds on a body lying still on the seabed, and a card that hard-cuts
  // over that shot throws the pacing away in one frame. Restarted by hand each
  // time — an animation on an element that was display:none doesn't replay on
  // its own, so a second run would show the card already at full opacity.
  el.svGameOverMenu.classList.remove('sv-fade-in');
  el.svGameOverMenu.style.setProperty('--sv-fade', `${CONFIG.death?.fadeIn ?? 0.9}s`);
  el.svGameOverMenu.classList.remove('sv-hidden');
  void el.svGameOverMenu.offsetWidth; // reflow — this is what re-arms the animation
  el.svGameOverMenu.classList.add('sv-fade-in');

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
