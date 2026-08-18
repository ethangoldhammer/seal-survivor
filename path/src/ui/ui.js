import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
import { hexMaskSet, noiseMaskSet } from './dither.js';
import { drawUpgrades } from '../upgradeTable.js';
import { expandDesc, measure, phraseAll, sentenceCase } from '../upgradeText.js';
import { rollElementFor, elementCardName, elementCardDesc } from '../systems/elements.js';
import { rollRarity, rarityById, rarityRank } from '../systems/rarity.js';
import quipsCsv from '../quips.csv?raw';
import { parseQuipCsv, pickQuip } from '../quipTable.js';
import { availableUpgrades, player } from '../entities/player.js';
import { feedMouse, menuInput, resetMenuInput } from '../input.js';
import { touchPrimary } from '../devices.js';
import { mountRiveSplash } from './riveSplash.js';
import { titlePreviewRequested } from '../systems/titleSeal.js';
import { initBossBarRive, updateBossBarRive } from './bossBarRive.js';
import { bossShot, bossShots, shareBossShot, saveBossShot, shareRunSheet, saveRunSheet, warmShareCards, warmRunSheet, canShareImages } from '../systems/bossShot.js';
import { buildPrintPaper, initSnapshotPrints } from './snapshotPrint.js';
import { hidePauseMenu, initPauseMenu } from './pauseMenu.js';
import { initUpgradeHive, hiveTileRect, setTileVisible, slamAndRipple, flyTransform } from './upgradeHive.js';
import {
  fetchGlobalBoard,
  highScore,
  isGlobal,
  loadLeaderboard,
  submitScore,
} from '../systems/leaderboard.js';
// The name itself is not the leaderboard's any more — see the note where it
// used to live. The board is one consumer of it; the {player} token in
// callouts.csv, quips.csv and upgrades.csv is the rest.
import { MAX_NAME_LEN, loadPlayerName, sanitizeName, savePlayerName, expandPlayer } from '../systems/playerName.js';
import { feedback } from '../systems/feedback.js';
import { playSfx, unlockAudio } from '../systems/audio.js';
// The popups' arrival and departure curves, by name — the same shared table the
// boss bar's fill and the camera moves read from (path/src/ease.js).
import { ease, cssEase } from '../ease.js';

let callbacks = {};
const el = {};

// Parsed once at module load, not per death — the file can't change while the
// page is up (a dev-server edit reloads it), and parsing on the frame the
// player dies is work for nothing.
const QUIPS = parseQuipCsv(quipsCsv);

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
// The live splash, while one is up. See showStartMenu and updateMenuNav.
let splash = null;
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
  /* THE FONT IS NOT SET HERE. It used to be — 'Inter' on this very selector —
     and because a rule that matches an element directly beats anything it
     would have inherited, that one declaration overrode the family the tuner
     was writing onto .sv-ui for every element underneath it. The picker moved
     nothing. ui/typography.js owns family now, in a sheet appended after this
     one; the fallback lives on the variable (--sv-font) so there is still a
     font before that module has run. */
  .sv-ui * { box-sizing: border-box; }
  .sv-ui { position: fixed; inset: 0; pointer-events: none; z-index: 10;
    font-family: var(--sv-font, 'Inter', system-ui, sans-serif); }
  .sv-hud { position: absolute; top: 14px; left: 14px; right: 14px; display: flex; justify-content: space-between; align-items: flex-start; color: #e8ecf3; z-index: 2; }
  /* NO BOX. This was a 72%-opaque slab with a border, a 10px radius and a 6px
     backdrop blur behind the score and the clock. The numbers are read off the
     water directly now — over an ocean that is mostly dark, a panel is a hole
     cut in the picture to hold two figures that were already legible. */
  .sv-panel { padding: 0; }
  /* The gap the "Time" caption used to provide. Without it the score and the
     clock stack into one four-line block of digits. */
  .sv-hud-time { margin-top: 4px; opacity: 0.7; }
  /* The read-outs, as one movable block. margin-left:auto is what pushes the
     group to the right-hand end of the HUD row, and it is the same declaration
     the score panel carried before this wrapper existed — so on a desktop it
     sits exactly where it always has.

     Right-aligned because without the box there is no edge but the screen's:
     left-aligned text pinned to a right corner leaves a ragged edge facing in.

     THE LEGIBILITY IS A drop-shadow AND NOT A text-shadow, deliberately. The
     panel background was doing that job, and the two roles underneath it
     (.sv-label and .sv-value) are set to shadow: 0 — in the saved tuning as
     well as in the defaults, so raising it in textRoles.js would be a silent
     no-op. ui/typography.js owns text-shadow on those selectors outright and
     rewrites it whenever the Text panel moves, so a second writer here would be
     the bug where one of them never wins. drop-shadow is a different property
     nothing else touches, applied to the group: it shadows the glyphs as
     rendered, and the Text panel keeps full control of the type. */
  .sv-hud-corner { margin-left: auto; display: flex; align-items: flex-start;
    gap: 0; text-align: right;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)) drop-shadow(0 0 7px rgba(0,0,0,0.6)); }

  /* --- THE HEX HIVE ------------------------------------------------------
     One tile per upgrade held, packed into the corner. See ui/upgradeHive.js
     for the layouts and what each pulse means; this is only how a tile looks.

     OUTSIDE the corner's drop-shadow filter, and that is not cosmetic: a
     a 'filter' on an ancestor makes it the containing block for anything
     positioned 'fixed' inside it, and the corner already moves to fixed on a
     phone. The hive is its own block for the same reason the boss bar is.

     TILES ARE ABSOLUTE inside .sv-hive-host, whose size upgradeHive.js stamps
     from the layout it just computed — nothing here reads a layout property, so
     a fight that fires nine abilities a second costs nine class writes.

     A SIBLING of .sv-hud rather than a child, and fixed rather than in its flex
     row. Three reasons, all of which bit: that row is space-between and a fifth
     child re-proportions the other four; the corner group inside it goes
     'position: fixed' on a phone and would drag the hive with it into the score
     panel; and .sv-hud-corner carries a drop-shadow filter, which makes it the
     containing block for any fixed descendant and would pin the hive to the
     corner box instead of to the screen.

     BOTTOM LEFT by default. The score and clock take the bottom right on a
     phone, the boss bar owns the top band, and the hp/air bars float on the
     seal — the lower left is the one corner of this HUD with nothing in it. */
  /* UNDER EVERY MENU, and this is a layer number rather than a DOM-order
     accident. .sv-hive, .sv-center, .sv-toast-layer and the boss bar are all
     children of the same root, so they share one stacking context — and the
     hive is appended LAST (initUpgradeHive runs after the markup), so without
     an explicit ladder it paints over the level-up cards and the score card
     whatever order the source is in. It carried z-index 3 against menus with no
     z-index at all, which is exactly that bug: a corner of hexes sitting on top
     of the run's own menus.

     The ladder, lowest first: hive, HUD, boss bar, menus, toasts, transitions.
     A menu is a thing you are being asked to act on; the hive is a readout of
     what you already hold, and it has no business over the top of one. */
  .sv-hive { pointer-events: none; position: fixed; z-index: 1; }
  .sv-hive[data-corner="bl"] { left: 14px; bottom: 14px; }
  .sv-hive[data-corner="br"] { right: 14px; bottom: 14px; }
  .sv-hive[data-corner="tl"] { left: 14px; top: 34px; }
  .sv-hive[data-corner="tr"] { right: 14px; top: 34px; }
  .sv-hive-host { position: relative; }
  /* A SQUARE BOX, CLIPPED ON THE ART'S OWN VERTICES — the same polygon .sv-card
     uses, for the same reason. The hex art is drawn with a margin inside a
     square image (measured: 5.5%-94.1% across, 12.7%-89.8% down, including the
     dark border), so the box has to be square or background-size:100% 100%
     squashes the drawing, and the clip has to be on THOSE vertices or it cuts
     through the border instead of following it.
     upgradeHive.js packs on the visible hexagon, so neighbouring boxes overlap
     — which is why nothing here may paint outside the clip. */
  .sv-hive-tile { position: absolute;
    -webkit-clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    display: grid; place-items: center;
    /* The pulse animates this, and only this. Transform and opacity are the two
       properties that never cost a layout, which is the whole reason a tile can
       flash on the same frame the hit lands. */
    transform-origin: 50% 50%; }
  /* THE RIM IS A LAYER, NOT A BOX-SHADOW.
     An inset box-shadow paints the element's BORDER BOX — a rectangle — and a
     clip-path then keeps only the parts of that rectangle that fall inside the
     hexagon. What you get is rim along the flat top and bottom and a stub at
     each side vertex, with the four diagonal edges bare: a border that looks
     cut off, because it is. Nothing warns; the shadow is perfectly valid.
     So the rim is the TILE's own background, and the face is the same hexagon
     inset on top of it. Both are clipped, so the rim follows all six edges. */
  .sv-hive-face { position: absolute; inset: 2px;
    -webkit-clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%); }
  /* 55% of the BOX, which is as large as a square can be inside this hexagon:
     the widest centred square in a flat-top hexagon is 0.634 of its width, and
     the hexagon is 0.882 of the box. Sized off the box because that is what the
     percentage resolves against — the number already has the hexagon in it. */
  .sv-hive-icon { position: relative; width: 55%; height: 55%; object-fit: contain;
    /* Every render is lit by the same neutral studio, so the only separation
       between a white beluga and the water behind it is this. */
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.75)); }
  .sv-hive-mono { position: relative; font: 700 15px/1 system-ui, sans-serif;
    color: rgba(255,255,255,0.92); letter-spacing: 0.02em;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  /* Inside the hexagon, not the box. The box's bottom-right corner is empty
     space the clip throws away, so a badge placed there is simply not drawn —
     this sits above the flat bottom edge, where the shape is solid. */
  .sv-hive-pip { position: absolute; right: 26%; bottom: 14%;
    font: 700 11px/1 ui-monospace, monospace; color: #fff;
    text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.8); }

  /* ink — a dark face with the rarity as a rim. The default: it is the only one
     of the three that leaves the icon as the brightest thing on the tile. */
  .sv-hive[data-style="ink"] .sv-hive-tile { background: var(--sv-hive-rarity, #b8c2cc); }
  .sv-hive[data-style="ink"] .sv-hive-face {
    background: linear-gradient(160deg, rgba(28,74,99,0.92), rgba(9,26,36,0.94)); }
  /* rarity — the tier floods the face. Loudest, and the one that answers "what
     did this run actually roll" from across the room.
     THE RIM IS NOT DECORATION. Without it this style has no edge at its dark
     end: the gradient lands on the same near-black the water is, so a Common
     tile stops having a silhouette and its icon reads as floating loose in the
     corner. */
  .sv-hive[data-style="rarity"] .sv-hive-tile {
    background: color-mix(in srgb, var(--sv-hive-rarity, #b8c2cc) 55%, #0b1a24); }
  .sv-hive[data-style="rarity"] .sv-hive-face {
    background: linear-gradient(160deg, var(--sv-hive-rarity, #b8c2cc), rgba(9,26,36,0.96) 78%); }
  /* art — the biome hex the card was dealt on. It cannot identify an upgrade
     (a dozen cards share Beach_001), so it is texture, dimmed so the mark on
     top stays the subject.
     NO RIM AND NO INSET: this art is DRAWN with a dark outline, and that
     outline is the whole reason the tiles read as tiles. Insetting the face to
     make room for a synthetic rim crops the drawn one — and then the tile has
     two borders, one of them sliced. The art gets the full hexagon. */
  .sv-hive[data-style="art"] .sv-hive-face {
    inset: 0;
    background-image: var(--sv-hive-art, none);
    background-size: 100% 100%; background-position: center; }
  .sv-hive[data-style="art"] .sv-hive-face::after {
    content: ''; position: absolute; inset: 0; background: rgba(6,18,26,0.45); }

  /* --- THE CHOSEN CARD, ON ITS WAY TO THE CORNER --------------------------
     A clone of the card that was picked, flown from where it sat to where its
     tile will be and then swapped for that tile. See flyCardToHive.

     TRANSFORM AND OPACITY ONLY. Both are compositor properties, so the flight
     costs no layout on any frame — which matters because the run has already
     come back to life underneath it and is spawning, shooting and shaking at
     the same time. Animating left/top instead would put a full layout on every
     frame of it, on the exact frames the fight is busiest.

     transform-origin is the top-left because the flight is written as "put this
     corner there and shrink by this much" — with a centred origin the scale
     pulls the card away from the point being translated to and the landing
     misses by half the difference in size. */
  .sv-hive-flier { position: fixed; pointer-events: none; z-index: 7;
    transform-origin: 0 0; will-change: transform, opacity; }
  /* The words do not survive the trip: the tile has no room for them, and text
     scaled to 28% is a grey smear. Gone well before the landing so what arrives
     is already just the picture. */
  .sv-hive-flier .sv-card-content { opacity: 0; }
  /* The tooltip that follows a hovered card is not part of the flight. */
  .sv-hive-flier .sv-card-fx { display: none; }

  /* --- FIRING -------------------------------------------------------------
     One class, four animations, picked by the tile's family (data-pulse). They
     are all under 400ms on purpose: this fires as often as the ability does,
     and anything with a tail long enough to overlap its own next firing turns
     into a tile that is simply always lit. */
  .sv-hive-tile[data-pulse="pop"].sv-hive-firing { animation: sv-hive-pop 220ms ease-out; }
  .sv-hive-tile[data-pulse="flash"].sv-hive-firing { animation: sv-hive-flash 260ms ease-out; }
  .sv-hive-tile[data-pulse="swell"].sv-hive-firing { animation: sv-hive-swell 380ms ease-in-out; }
  .sv-hive-tile[data-pulse="lean"].sv-hive-firing { animation: sv-hive-lean 340ms ease-out; }
  .sv-hive-tile[data-pulse="glow"].sv-hive-firing { animation: sv-hive-glow 300ms ease-out; }

  /* The Balatro punch: overshoot, undershoot, settle. The undershoot is what
     makes it read as a POP rather than as a grow — a curve that only ever gets
     bigger reads as the tile inflating. */
  @keyframes sv-hive-pop {
    0%   { transform: scale(1); }
    35%  { transform: scale(1.28); filter: brightness(1.9); }
    65%  { transform: scale(0.94); }
    100% { transform: scale(1); }
  }
  @keyframes sv-hive-flash {
    0%   { transform: scale(1) rotate(0deg); filter: brightness(1); }
    18%  { transform: scale(1.34) rotate(-3deg); filter: brightness(3.2) saturate(0.4); }
    100% { transform: scale(1) rotate(0deg); filter: brightness(1); }
  }
  /* An aura has no moment of release, so this has no spike: it breathes out and
     back, which is what a field doing continuous work looks like. */
  @keyframes sv-hive-swell {
    0%   { transform: scale(1); filter: brightness(1); }
    50%  { transform: scale(1.12); filter: brightness(1.45); }
    100% { transform: scale(1); filter: brightness(1); }
  }
  /* A companion acts on its own schedule, so its tile leans the way an animal
     turns rather than pulsing on your beat. */
  @keyframes sv-hive-lean {
    0%   { transform: rotate(0deg) scale(1); }
    30%  { transform: rotate(-7deg) scale(1.1); }
    60%  { transform: rotate(5deg) scale(1.04); }
    100% { transform: rotate(0deg) scale(1); }
  }
  @keyframes sv-hive-glow {
    0%   { filter: brightness(1); }
    40%  { filter: brightness(1.7); }
    100% { filter: brightness(1); }
  }

  /* --- ARRIVING, AND THE CORNER FEELING IT -------------------------------
     Two beats with different jobs. The SLAM is the new tile landing under its
     own weight — it comes in oversized and squashes into place, which is what
     makes it read as having mass rather than as having faded in. The RIPPLE is
     every other tile registering the impact, fired in order of distance so it
     crosses the hive as a wave.

     Both are heavier than the firing pulses on purpose: a pulse happens many
     times a minute and has to stay quiet, while this happens once per pick and
     is allowed to be the loudest thing the corner ever does. */
  .sv-hive-tile.sv-hive-arriving { animation: sv-hive-slam 420ms cubic-bezier(0.2, 1.4, 0.35, 1); }
  .sv-hive-tile.sv-hive-rippling { animation: sv-hive-ripple 300ms ease-out; }

  @keyframes sv-hive-slam {
    0%   { transform: scale(1.55); filter: brightness(2.4); }
    /* The squash. A landing that only ever shrinks reads as a zoom-out; the
       overshoot below the target and the settle back are the impact. */
    55%  { transform: scale(0.9); filter: brightness(1.3); }
    78%  { transform: scale(1.04); }
    100% { transform: scale(1); filter: brightness(1); }
  }
  /* Small on purpose — twenty of these going off in sequence is a lot of
     movement, and each one only has to be visible, not dramatic. */
  @keyframes sv-hive-ripple {
    0%   { transform: scale(1); }
    40%  { transform: scale(1.11); filter: brightness(1.5); }
    100% { transform: scale(1); filter: brightness(1); }
  }

  /* A player who asked for less motion gets the state without the movement:
     the tile still says WHICH ability fired, it just says it by brightening. */
  @media (prefers-reduced-motion: reduce) {
    .sv-hive-tile.sv-hive-firing { animation: sv-hive-glow 300ms ease-out !important; }
  }

  /* XP spans the full width at the very top — it's the run-long progress
     bar, so it reads as a frame around the screen rather than a widget. */
  /* THE LEVEL NUMBER RIDES INSIDE THE TRACK, centred. It used to sit under the
     bar as its own line of text in the top-left corner, which is the corner the
     HUD is already using and a second thing to look at for a number that
     changes once a minute. Inside the bar it is attached to the thing it
     describes and costs no space of its own.
     THE BAR IS AS THICK AS THE TYPE IT CARRIES, min 14px, rather than a fixed
     6px with text laid over it: the Level role's size is tunable (Text panel),
     and a fixed track would clip it the moment anyone dragged that slider. */
  .sv-xptop { position: absolute; top: 0; left: 0; right: 0; min-height: 14px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.07); overflow: hidden; }
  /* SCALED, not sized. The fill is always the full track and is squashed along
     one axis by --sv-xp (written by updateHUD as a 0..1 fraction), which is what
     lets the responsive block below turn the same element on its side without
     the JS knowing. transform-origin is the end it grows FROM.
     Absolute now that the track is a flex box around the label — in flow it
     would be a sibling the label had to share the width with. */
  .sv-xptop-fill { position: absolute; inset: 0; background: #7ad7ff;
    transform: scaleX(var(--sv-xp, 0)); transform-origin: 0 50%;
    box-shadow: 0 0 10px rgba(122,215,255,0.75); transition: transform 0.15s ease; }
  /* Everything positional here is scoped under .sv-xptop, not hung on the role's
     own class: .sv-xptop-level is also rendered on its own in the Text panel's
     specimen strip (ui/textPanel.js), where it has to stay a plain run of text
     with no box around it.
     The two words are both in the markup and one is hidden per breakpoint —
     "Level" across the top of a desktop, "Lv" stacked over the number on a
     phone, where the strip is only as wide as its widest line. */
  /* THE DARK PLATE IS NOT DECORATION. The fill sweeps left to right under this
     label every level, and pale type at half alpha over #7ad7ff is not there —
     the first letters vanished as the bar passed them, which is exactly when a
     player is looking at it. A plate dark enough to keep the text on one
     background whichever side of the fill edge it is on. */
  .sv-xptop .sv-xptop-level { position: relative; z-index: 1; display: flex;
    align-items: center; justify-content: center; gap: 0.5em; line-height: 1;
    padding: 3px 8px; pointer-events: none;
    background: rgba(4,6,12,0.78); border-radius: 999px; }
  .sv-xptop-abbr { display: none; }
  /* Font, colour and shadow come from the Level role (textRoles.js); this is
     only what the label looks like in the frames before that sheet exists. */
  .sv-xptop-level { font-size: 8px; color: rgba(232,236,243,0.5); }

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

  /* THE BOSS BAR (systems/boss.js). Top centre, clear of the xp strip and of
     both HUD corners. It is deliberately NOT a bar over the creature's head:
     a boss this size spends half the fight partly off screen, and a floating
     bar would vanish exactly when you most want to know how the fight is
     going. Red and only red — nothing else in the HUD is, so the bar reads as
     "the thing trying to kill you" without needing a label saying so. */
  /* Width is written per boss from its max health (see bossBarWidth) — the
     value here is only what a bar that has not been updated yet falls back to. The
     max-width is the guard that keeps a hand-edited hp number from producing a
     bar wider than the window. */
  .sv-bossbar { z-index: 3; position: absolute; top: 26px; left: 50%; transform: translateX(-50%);
    width: min(560px, 62vw); max-width: 92vw; pointer-events: none; text-align: center;
    transition: width 0.45s cubic-bezier(0.22, 1, 0.36, 1); }
  .sv-boss-name { font-size: 13px; font-weight: 700; letter-spacing: 0.14em;
    text-transform: uppercase; color: #ffd7d7; margin-bottom: 5px;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 12px rgba(255,60,60,0.55); }
  .sv-boss-track { height: 9px; background: rgba(4,6,12,0.62); border-radius: 5px;
    overflow: hidden; box-shadow: 0 0 0 1px rgba(255,86,102,0.45), 0 0 18px rgba(255,40,60,0.22); }
  /* Width is set per frame from the boss's hp, so the transition is a smoothing
     pass over a value that is already correct — short enough that a burst of
     damage still reads as a hit. */
  .sv-boss-fill { height: 100%; width: 100%; border-radius: 5px;
    background: linear-gradient(90deg, #ff2f45, #ff6a5a);
    box-shadow: 0 0 12px rgba(255,60,70,0.8); transition: width 0.12s linear; }
  /* THE ARRIVAL. The bar is driven 0→1 across CONFIG.boss.arrival.seconds while
     the boss swims in, and the shape of that fill is decided in JS — see
     CONFIG.boss.arrival.ease and path/src/ease.js.
     NO TRANSITION HERE, deliberately. This used to carry a 0.4s eased one, and
     a transition that restarts every frame chasing a value that is itself
     moving never arrives: it lagged a fixed 0.4s behind for the whole ceremony
     and then covered the remainder in a snap. Two curves fighting over one
     number, and the visible result was the opposite of both. The width written
     each frame is already the eased answer, so the bar's job here is to draw it
     and nothing else. Colour only. */
  .sv-boss-fill-arriving { transition: none;
    background: linear-gradient(90deg, #ff5a3c, #ffb066);
    box-shadow: 0 0 22px rgba(255,140,80,0.95); }

  /* THE ROLL — every kill shot from the run, fanned out on the score screen
     (systems/bossShot.js keeps them, ui/snapshotPrint.js builds the paper).
     The prints overlap by a third, so eight of them still fit the card on a
     phone; picking one lifts it square out of the fan. */
  .sv-trophy { margin: 4px 0 12px; display: flex; flex-direction: column; gap: 9px; align-items: center; }
  .sv-fan { display: flex; justify-content: center; align-items: center; flex-wrap: nowrap;
    padding: 14px 0 10px; max-width: 100%; }
  .sv-fan-slot { position: relative; background: none; border: 0; padding: 0; margin: 0;
    cursor: pointer; pointer-events: all; transform-origin: 50% 60%;
    transform: rotate(var(--rot, 0deg));
    filter: drop-shadow(0 8px 20px rgba(0,0,0,0.5));
    transition: transform 0.18s cubic-bezier(0.2,0.9,0.3,1), filter 0.18s ease; }
  /* Lifted SQUARE to the frame, not merely raised: the fan's job is to show
     that there are several, and the pick's job is to show one properly. */
  .sv-fan-slot:hover, .sv-fan-slot:focus-visible {
    transform: rotate(0deg) translateY(-8px) scale(1.04); outline: none; }
  .sv-fan-sel, .sv-fan-sel:hover {
    transform: rotate(0deg) translateY(-11px) scale(1.08);
    filter: drop-shadow(0 12px 26px rgba(0,0,0,0.6)); }
  .sv-fan-sel .sv-print-paper { outline: 2px solid #7ad7ff; outline-offset: 0; }
  .sv-trophy-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
  /* The two whole-run buttons read as secondary to the two that act on the
     print the player just picked. */
  .sv-btn-ghost { background: rgba(122,215,255,0.12); color: #cfeeff;
    border: 1px solid rgba(122,215,255,0.35); }
  .sv-btn-ghost:hover { background: rgba(122,215,255,0.22); }

  /* THE SCORECARD. Five figures in a row rather than a sentence — the same
     five the shared image carries. */
  .sv-stat { display: inline-flex; flex-direction: column; align-items: center;
    min-width: 62px; padding: 0 6px; font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: rgba(232,236,243,0.45); }
  .sv-stat b { font-size: 19px; font-weight: 700; letter-spacing: 0.01em;
    color: #e8ecf3; text-transform: none; }

  /* TYPE IN THIS FILE IS THE FALLBACK LAYER, not the design. Every font-size,
     weight, colour and text-shadow from here down is re-stated by
     ui/typography.js from CONFIG.textStyles, in a sheet appended after this
     one — so these values are what the game looks like for the few frames
     before that module runs, and what it falls back to if it ever doesn't.
     The live numbers are in path/src/textRoles.js and the Text panel (Y).
     Everything else here — position, layout, the will-change hints — is real
     and is not duplicated anywhere. */

  /* Score toasts: one per kill, floating up from where the fish died. */
  .sv-toast { position: absolute; font-size: 13px; font-weight: 700;
    color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7);
    font-variant-numeric: tabular-nums; pointer-events: none; white-space: nowrap;
    transform: translate(-50%, -50%); will-change: transform, opacity; }
  .sv-toast-combo { color: #ffe066; font-size: 15px; }
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
  /* em, not px: the ×N is a part of the banner rather than a thing with its
     own size, so it tracks whatever the Chain banner role is set to. */
  .sv-chain-x { font-size: 0.76em; margin-left: 7px; font-weight: 700;
    font-variant-numeric: tabular-nums; opacity: 0.9; }
  /* AN UPGRADE PAYING OUT — "MANEATER +12%". Same layer and same loop as the
     numbers, and deliberately smaller and cooler than the chain banner: this
     is a receipt, not an announcement. One line per upgrade at a time; a
     second proc of the same card updates the one that is up (spawnProcToast). */
  .sv-proc { position: absolute; font-size: 13px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap;
    text-shadow: 0 2px 5px rgba(0,0,0,0.95), 0 0 10px currentColor;
    pointer-events: none; transform: translate(-50%, -50%);
    will-change: transform, opacity; }
  /* em, like the chain's count, and for the same reason — the value is part of
     the line rather than a thing with a size of its own. */
  .sv-proc-val { font-size: 1.08em; margin-left: 6px; font-weight: 800;
    font-variant-numeric: tabular-nums; }
  .sv-label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(232,236,243,0.55); font-weight: 500; }
  .sv-value { font-size: 15px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .sv-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: all; z-index: 4; }
  .sv-menu { background: rgba(12,14,22,0.88); border: 1px solid rgba(255,255,255,0.14); border-radius: 14px; padding: 28px 32px; text-align: center; color: #e8ecf3; max-width: 90vw; }
  .sv-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .sv-sub { font-size: 13px; color: rgba(232,236,243,0.6); margin-bottom: 18px; line-height: 1.6; }
  .sv-btn { pointer-events: all; background: #7ad7ff; color: #0a0c12; border: none; border-radius: 8px; padding: 10px 22px; font-size: 14px; font-weight: 600; cursor: pointer; letter-spacing: 0.02em; }
  .sv-btn:hover { background: #9fe3ff; }
  .sv-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  /* The pad's cursor on the score card. Same look as the focus ring, but as a
     class for the same reason the cards' selection is one: :focus-visible is
     the browser's guess about whether a focus deserves a ring, and it guesses
     "no" for the programmatic focus a stick push produces. */
  .sv-btn.sv-nav-sel { outline: 2px solid #fff; outline-offset: 2px; }
  /* position:relative so the effect tooltip has a coordinate frame that is the
     card row itself. It is absolutely positioned, so it takes no part in the
     flex layout and cannot push a card onto a second line. */
  .sv-cards { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; max-width: min(760px, 92vw); position: relative; }
  /* Cards are hexagons matching the background art exactly. The vertex
     percentages below were measured off the art itself (flat-top hex: points
     at 5.7%/93.9% horizontally, flat top/bottom edges spanning 27.1%-72.3%,
     vertical extent 12.7%-89.6%) so the clip lines up with the drawn edge
     instead of approximately near it. The card is square because the art is. */
  .sv-card { pointer-events: all; width: 210px; height: 210px; position: relative; overflow: hidden;
    background-color: rgba(255,255,255,0.04);
    -webkit-clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    cursor: pointer; transition: transform 0.15s ease; text-align: center;
    /* The face brightens on the same curve the bloom does, which is what gives
       the FLOOR tier an arrival at all: its glow column is 0, so it has no bloom to
       flare and this is the whole of its snap. */
    filter: brightness(calc(1 + 0.18 * var(--sv-k, 0))) saturate(calc(1 + 0.10 * var(--sv-k, 0)));
    transform: scale(calc(1 + 0.04 * var(--sv-hov, 0))); }
  /* THE RARITY SLOT. A card's rarity has to be drawn as a stroke and a bloom,
     and the card itself is a clip-path hexagon — which eats both. A clip-path
     removes an outer border outright, and CSS applies filter BEFORE clipping,
     so a drop-shadow on the card is clipped away with it.
     So the bloom lives out here, on an unclipped wrapper: the filter renders
     the clipped card first and then blooms the hex silhouette it produced.
     The stroke goes the other way and is drawn INSIDE the card as an inset
     shadow — the same trick the focus ring below has always used, for the same
     reason. Set inline per card from the tier's colour, because the ladder
     comes out of rarities.csv and a fixed class per tier could not survive a
     row being renamed or added. */
  /* THE IGNITION — see CONFIG.rarityCard.ignite and igniteCards().
     Two animated inputs, kept separate and ADDED rather than one variable both
     things write: a hover that starts while a card is still cooling has to
     compose with the flare, not replace it halfway down.
     Registered, because an unregistered custom property is a token stream to
     the animation system — it would jump between keyframes instead of
     interpolating, and the whole effect is the interpolation. */
  @property --sv-lit { syntax: '<number>'; inherits: true; initial-value: 0; }
  @property --sv-hov { syntax: '<number>'; inherits: true; initial-value: 0; }
  /* What everything downstream reads: the bloom on the slot and the face
     brightness on the card are the same number, so they can't drift apart. */
  .sv-card-slot { display: block; line-height: 0;
    --sv-k: calc(var(--sv-lit) + var(--sv-hov) * var(--sv-hov-amt, 0.8));
    transition: --sv-hov 0.15s ease-out;
    /* FOUR passes, and the last two are the important ones for legibility.
       The first pair is the tier's own colour, sized per card from
       rarities.csv (0px on the floor tier, which is why the second pair
       exists). The second pair is the SELECTION: white, the same size on every
       card, and driven by --sv-hov alone rather than by --sv-k, so pointing at
       a common card lights it exactly as hard as pointing at a legendary.
       Written here rather than inline per card because a filter set on the
       element would replace this whole list — see applyRarityStyle, which now
       hands in sizes instead of a finished filter. */
    filter:
      drop-shadow(0 0 calc(var(--sv-glow-tight, 0px) * var(--sv-k)) var(--sv-ring, transparent))
      drop-shadow(0 0 calc(var(--sv-glow-halo, 0px) * var(--sv-k)) var(--sv-ring, transparent))
      drop-shadow(0 0 calc(var(--sv-sel-tight, 0px) * var(--sv-hov)) rgba(255,255,255,var(--sv-sel-tight-a, 0.95)))
      drop-shadow(0 0 calc(var(--sv-sel-halo, 0px) * var(--sv-hov)) rgba(255,255,255,var(--sv-sel-halo-a, 0.6))); }
  /* Cards do NOT arrive lit. --sv-lit sits at 0 until this card's turn comes
     round, and the class both runs the flare and holds the resting value it
     falls to — so with animations off (reduced motion, below) the card still
     ends up at its idle glow instead of dark. */
  .sv-card-slot.sv-lit { --sv-lit: var(--sv-idle, 0.42);
    animation: sv-ignite var(--sv-ignite-time, 0.9s) both; }
  @keyframes sv-ignite {
    0%   { --sv-lit: 0; animation-timing-function: cubic-bezier(.2,.9,.3,1); }
    7%   { --sv-lit: var(--sv-peak, 2.3); animation-timing-function: cubic-bezier(.15,.6,.25,1); }
    100% { --sv-lit: var(--sv-idle, 0.42); }
  }
  /* Hover lands on the SLOT, not the card: the bloom is drawn out here (see
     below), and a custom property set on the card cannot reach its parent.
     :has is what makes that possible — without it the card would brighten and
     the halo around it would not. */
  .sv-card-slot:has(.sv-card:hover) { --sv-hov: 1; }
  /* Keyboard focus and pad selection get the same lift as the mouse. Neither
     can happen before the player has done something — the menu opens with
     nothing selected and nothing focused (see showLevelUp) — so this cannot
     light a card during the deal on its own. */
  .sv-card-slot:has(.sv-card:focus-visible),
  .sv-card-slot:has(.sv-card-sel) { --sv-hov: 1; }
  /* ...and the ring goes WHITE with them. The tier colour is what the card is
     worth and it owns the ring the rest of the time; while a card is the one
     you are pointing at, "which one" matters more than "how good", and white
     is the only colour on this menu that no tier can claim. Set on the slot so
     both the ring (inherited by the card) and the white bloom passes above are
     switched by one rule. */
  .sv-card-slot:has(.sv-card:hover),
  .sv-card-slot:has(.sv-card:focus-visible),
  .sv-card-slot:has(.sv-card-sel) { --sv-ring-now: #ffffff; }
  /* clip-path cuts off any outline, so the ring is drawn INSIDE the card as an
     inset shadow. ONE rule for every state now, driven by --sv-ring-now: the
     old pair (a tier ring, plus a cyan ring 4px further in for focus and pad
     selection) meant three different looks for the same idea, and the cyan one
     was the weakest of them on exactly the cards that needed help — a floor
     tier has no bloom to go with it.
     The second, wider shadow is the soft inner edge of the white state: it is
     transparent at rest and costs nothing then. */
  .sv-card {
    box-shadow: inset 0 0 0 var(--sv-ring-w, 0px) var(--sv-ring-now, var(--sv-ring, transparent)),
                inset 0 0 0 var(--sv-sel-w, 0px) var(--sv-sel-inner, transparent);
    transition: box-shadow 0.15s ease; }
  .sv-card-slot:has(.sv-card:hover),
  .sv-card-slot:has(.sv-card:focus-visible),
  .sv-card-slot:has(.sv-card-sel) {
    --sv-sel-w: calc(var(--sv-ring-w, 0px) + 4px);
    --sv-sel-inner: rgba(255,255,255,0.35); }
  /* The pad's selection is a CLASS, not focus: a pad press is not a focus event
     and :focus-visible is the browser's guess about whether a ring is wanted.
     It needs no rule of its own any more — .sv-card-sel is one of the three
     selectors in both blocks above, so the pad, the keyboard and the mouse all
     produce the identical white ring and white bloom. */
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
  /* THE EFFECT TOOLTIP — see showCardEffect(). What the card actually does to
     the stat block, measured from its own apply(), for the stack it is
     offering right now.
     ONE node for the whole hand, parked on the menu box and moved to whichever
     card is pointed at, rather than one per slot. The slot carries a four-pass
     drop-shadow filter, and a filter applies to descendants — a tooltip living
     inside it would be bloomed white along with the card the moment it was
     selected, which is illegible at 11px. Out here it inherits nothing.
     Positioned in script because the cards wrap: there is no static offset
     that is "under this card" for both rows. */
  .sv-card-fx { position: absolute; z-index: 5; pointer-events: none;
    max-width: 190px; padding: 6px 9px; border-radius: 7px;
    background: rgba(9,14,22,0.94); border: 1px solid rgba(122,215,255,0.35);
    color: #cfeaff; font-size: 11px; line-height: 1.35; text-align: center;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    opacity: 0; transition: opacity 0.12s ease-out; }
  .sv-card-fx.sv-fx-on { opacity: 1; }
  .sv-hint { font-size: 11px; color: rgba(232,236,243,0.35); margin-top: 14px; letter-spacing: 0.04em; }
  .sv-leaderboard { margin: 14px 0; max-height: 220px; overflow-y: auto; text-align: left; }
  .sv-lb-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px; font-size: 12px; }
  .sv-lb-row:nth-child(even) { background: rgba(255,255,255,0.03); }
  .sv-lb-row.sv-lb-mine { background: rgba(122,215,255,0.14); border: 1px solid rgba(122,215,255,0.4); }
  .sv-lb-rank { width: 18px; color: rgba(232,236,243,0.5); font-weight: 600; }
  /* min-width:0 is load-bearing: a flex item defaults to min-width:auto, which
     refuses to shrink below its content — so without it a long name pushes the
     score and time out of the row instead of ellipsing, which is exactly what
     a 24-character name does. */
  .sv-lb-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-lb-score { font-weight: 600; font-variant-numeric: tabular-nums; }
  .sv-lb-meta { color: rgba(232,236,243,0.5); font-size: 11px; min-width: 78px; text-align: right; }
  .sv-lb-empty { font-size: 12px; color: rgba(232,236,243,0.4); padding: 6px 8px; }

  /* Name entry. The row is a single control: text field plus its submit
     button, sized so the two read as one unit rather than a form. */
  .sv-name-row { display: flex; gap: 8px; justify-content: center; margin: 14px 0 4px; }
  /* Sized to hold a full-length name without the text scrolling inside the
     field — at 24 characters the old 200px/0.08em pairing ran out around
     character 15, so the tail of your own name was hidden while you typed it.
     The tracking comes down as the field gets longer: letter-spacing is there
     to make a SHORT arcade-style name look deliberate, and at this width it
     was only costing room. */
  .sv-name-input { pointer-events: all; flex: 1; min-width: 0; max-width: 300px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px; padding: 9px 12px; color: #e8ecf3; font-size: 14px;
    font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    text-align: center; -webkit-user-select: text; user-select: text; }
  .sv-name-input::placeholder { color: rgba(232,236,243,0.3); letter-spacing: 0.06em; font-weight: 500; }
  .sv-name-input:focus { outline: none; border-color: #7ad7ff; background: rgba(122,215,255,0.08); }
  .sv-btn-sm { padding: 9px 16px; font-size: 13px; }
  .sv-btn:disabled { opacity: 0.5; cursor: default; }
  .sv-status { font-size: 11px; color: rgba(232,236,243,0.5); min-height: 15px; margin-bottom: 8px; letter-spacing: 0.03em; }
  .sv-status-err { color: #ffab6f; }
  .sv-toast-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 6; }
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

  /* =========================================================================
     THE SMALL SCREEN.
     Everything above this line was written at desktop size, and a phone is not
     a small desktop — it is a different shape, held in a hand, with a thumb
     over part of it. What is here is the set of changes that shape needs, and
     nothing else: the desktop layout is not touched by any of it.

     KEYED ON THE VIEWPORT, deliberately, with one exception. A width and a
     height are facts about the screen the game is being drawn on, and they can
     be reproduced exactly — which is what lets "npm run layout" build every one
     of these surfaces at every size and measure whether it fits. The exception
     is tap-target size, which is a fact about the player's HAND and rides the
     .sv-touch class instead (see markTouch).

     Every rule below was written against a finding from that audit. The numbers
     in the comments are what it measured before the rule existed.
     ========================================================================= */

  /* --- THE LEVEL METER, UP THE LEFT EDGE ---------------------------------
     A run-long progress bar wants the longest edge it can have, and on a phone
     held upright that is the side, not the top: 667px of travel instead of
     375px, in the margin beside the thumb rather than across the water.
     It fills UPWARD (transform-origin at the bottom) because levelling is a
     climb, and because a meter that fills toward the sky next to a seal
     swimming down reads without a label.

     "position: fixed" is what gets it out of .sv-hud — that box is inset 14px
     and only as tall as the corner panels it holds, so a "bottom: 0" inside it
     would end an inch below the top of the screen. Neither .sv-ui nor .sv-hud
     carries a transform or a filter, so fixed here resolves against the
     viewport, which is the frame this bar is actually about. */
  @media (max-width: 700px) {
    .sv-xptop { position: fixed; top: 0; bottom: 0; left: 0; right: auto;
      width: auto; min-width: 8px; height: auto; min-height: 0; }
    .sv-xptop-fill { transform: scaleY(var(--sv-xp, 0)); transform-origin: 50% 100%; }
    /* A vertical bar takes a vertical label: "Lv" over the number, stacked, so
       the strip stays as narrow as one short word instead of as long as a line
       of text. The letters stay UPRIGHT — a rotated label is a thing to decode,
       and this one is read at a glance mid-fight or not at all.
       Centred on the long axis by the same flex rules as the desktop track, so
       it sits at the middle of the screen edge rather than at either end,
       clear of both the notch and the home indicator. */
    .sv-xptop .sv-xptop-level { flex-direction: column; gap: 0.3em; padding: 8px 2px; }
    .sv-xptop-word { display: none; }
    .sv-xptop-abbr { display: block; }
  }

  /* --- THE TOP BAND BELONGS TO THE BOSS ----------------------------------
     Score and time move to the BOTTOM right on a phone, and the boss bar takes
     the width they were using.
     The reason is that the top of a phone screen is the one place two things
     genuinely cannot share. The boss bar is centred and its name runs to forty
     characters ("Wicked Grimgullet the Chumbucket Rumbler"), so at 62vw it was
     wrapping to three lines under a bar squeezed into two thirds of a screen
     that is already only 375px — while a Score/Time panel sat in the corner
     showing two numbers that do not change fast enough to need the best real
     estate on the display. Downstairs they cost nothing, and the fight gets the
     whole band.
     fixed, not absolute: .sv-hud is anchored at the TOP (and its floating
     hp/air bars are positioned inside it per frame from the seal's projected
     position), so moving the row itself would drag those bars off the animal.
     Only this group moves. */
  @media (max-width: 700px) {
    /* Column rather than row: anything that joins the score and the clock later
       grows the block UPWARD into empty water, rather than sideways across a
       screen that has none to spare. */
    .sv-hud-corner { position: fixed; right: 14px; bottom: 14px; margin-left: 0;
      flex-direction: column; align-items: flex-end; gap: 8px; }

    /* Up to where the Rive bar already sits (bossBarRive mounts at top: 14px),
       so the coded fallback and the real one arrive in the same place. The
       WIDTH is not set here on purpose — updateBossBar writes it inline per
       boss, which beats any rule, so the phone widening lives in
       bossBarWidth() instead. */
    .sv-bossbar { top: 14px; }
  }

  /* --- THE UPGRADE CARDS, STACKED ----------------------------------------
     Three 210px hexes side by side need 630px and a phone has 375. They
     already wrapped, into a column three cards tall — 630px of cards in a
     667px screen with a title above them, which put 53px of the menu off the
     top AND the bottom at once, so the first card and the last were both
     unreachable.
     Sized off the HEIGHT instead, which is the axis that ran out: whatever is
     left after the menu's own chrome, split three ways. The card art is square
     and the text inside auto-fits (see fitCardText), so a smaller card is a
     smaller card rather than a broken one.
     Portrait only. A phone on its side has 852px of width and the row fits
     there already — the audit confirms it, and stacking would break it. */
  @media (max-width: 700px) and (orientation: portrait) {
    .sv-cards { flex-direction: column; flex-wrap: nowrap; align-items: center; gap: 6px; }
    .sv-card { width: min(210px, calc((100vh - 160px) / 3));
      height: min(210px, calc((100vh - 160px) / 3)); }
    .sv-menu { padding: 20px 18px; max-width: 94vw; }
  }

  /* --- MENUS ON A SHORT SCREEN -------------------------------------------
     A phone on its side is 393px tall. The score card — quip, stats, the roll
     of kill shots, the name row, the leaderboard and a button — ran 17px past
     the bottom of it, and the thing off the bottom was "Try again", which is
     the one control on that screen that has to work.
     A scroll rather than a squeeze: there is genuinely more here than fits, and
     the alternative to scrolling it is deciding which of those the player is
     not allowed to see. overscroll-behavior stops a flick at the end of the
     list turning into a pull on the page behind it. */
  @media (max-height: 560px) {
    .sv-menu { max-height: 92vh; overflow-y: auto; overscroll-behavior: contain;
      padding: 16px 20px; }
    .sv-leaderboard { max-height: 120px; }
  }

  /* --- TAP TARGETS -------------------------------------------------------
     Apple's own minimum is 44px and every button in this game was 34-36px
     tall: the four share buttons, the name submit, and "Try again". A thumb is
     about 10mm across and lands on a 36px control most of the time, which is
     the worst way for this to be wrong — it feels like the button is broken
     rather than like it was missed.
     Only where there is a thumb: a 44px button on a desktop is a different
     design, and this is not the place to make that choice for a mouse. */
  .sv-touch .sv-btn, .sv-touch .sv-name-input {
    min-height: 44px; padding-top: 11px; padding-bottom: 11px; }
  .sv-touch .sv-btn-sm { min-width: 44px; padding-left: 18px; padding-right: 18px; }
  /* A row of buttons that wraps needs the gap a thumb needs, not the gap an
     eye needs — two 44px targets 8px apart are one 96px target as far as a
     mis-tap is concerned. */
  .sv-touch .sv-trophy-row, .sv-touch .sv-name-row { gap: 12px; }
`;

export function initUI({ onStart, onRestart, onLevelChoice, onResume, onPauseRestart, onSplash }) {
  callbacks = { onStart, onRestart, onLevelChoice, onSplash };

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.className = 'sv-ui';
  markTouch(root);
  root.innerHTML = `
    <div class="sv-toast-layer" id="svToastLayer"></div>

    <div class="sv-hud sv-hidden" id="svHud">
      <div class="sv-xptop">
        <div class="sv-xptop-fill" id="svXpBar"></div>
        <div class="sv-xptop-level"><span class="sv-xptop-word">Level</span><span class="sv-xptop-abbr">Lv</span><span id="svLevel">1</span></div>
      </div>
      <div class="sv-playerbars" id="svPlayerBars">
        <div class="sv-pbar-wrap"><div class="sv-pbar sv-pbar-hp" id="svHpBar"></div></div>
        <div class="sv-pbar-wrap"><div class="sv-pbar sv-pbar-o2" id="svO2Bar"></div></div>
      </div>
      <!-- THE CORNER. Score, time and whatever else is currently true about the
           run, as ONE block rather than as loose panels in the HUD's flex row —
           because on a phone the whole group moves to the opposite corner of the
           screen (see .sv-hud-corner in the responsive block) and a group that
           moves has to be a thing that can be moved. On a desktop this changes
           nothing: the wrapper carries the same margin-left:auto the score panel
           used to, and lays its children out in the same row. -->
      <!-- THE RAPID FIRE READ-OUT IS GONE, on purpose. It was a second panel
           here counting a timer down, and it said nothing the fight was not
           already saying — rapid fire is visible in the firing itself. The
           timer is still tracked and still passed to updateHUD; what was
           removed is the box. -->
      <!-- NO LABELS. "Score" over a five-figure number and "Time" over 7:01
           are captions on two things that already say what they are: a running
           total counts up, a clock is punctuated like a clock. They cost two
           lines of the corner and a glance each to skip past.
           Both are .sv-value so the Text panel still owns them as one role
           (path/src/textRoles.js) — the clock is set back with opacity, which
           is a property typography.js does not write, rather than with a size
           or a colour it would overwrite on the next tuning change. -->
      <div class="sv-hud-corner" id="svCorner">
        <div class="sv-panel">
          <div class="sv-value" id="svScore">0</div>
          <div class="sv-value sv-hud-time" id="svTime">0:00</div>
        </div>
      </div>
      <!-- strike charges are drawn as a ring around the ship (systems/strikeRing.js) -->
    </div>

    <!-- Outside .sv-hud on purpose: that is a flex row of corner panels, and a
         centred full-width banner inside it would be a third item fighting the
         other two for space. -->
    <div class="sv-bossbar sv-hidden" id="svBossBar">
      <div class="sv-boss-name" id="svBossName"></div>
      <div class="sv-boss-track"><div class="sv-boss-fill" id="svBossFill"></div></div>
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
        <div class="sv-hint">Esc pause &amp; settings &nbsp;·&nbsp; \` tuning &nbsp;·&nbsp; T textures &nbsp;·&nbsp; P screen filter &nbsp;·&nbsp; M mute &nbsp;·&nbsp; click / Space strike &nbsp;·&nbsp; hold G gamepad info</div>
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
        <div class="sv-title" id="svGameOverTitle">You Died!</div>
        <div class="sv-sub" id="svGameOverStats"></div>
        <!-- THE ROLL. Every kill shot from the run, fanned out like prints
             dropped on a table — the same paper the player watched come out of
             the camera during the fight (ui/snapshotPrint.js builds both).
             Hidden unless a boss actually went down: an empty rack on the
             score screen of a run that never met one reads as a broken image.
             See systems/bossShot.js. -->
        <div class="sv-trophy sv-hidden" id="svTrophy">
          <div class="sv-fan" id="svFan"></div>
          <div class="sv-trophy-row">
            <button class="sv-btn sv-btn-sm" id="svTrophyShare">Share this one</button>
            <button class="sv-btn sv-btn-sm" id="svTrophySave">Save this one</button>
            <button class="sv-btn sv-btn-sm sv-btn-ghost" id="svSheetShare">Share all</button>
            <button class="sv-btn sv-btn-sm sv-btn-ghost" id="svSheetSave">Save all</button>
          </div>
          <div class="sv-status" id="svTrophyStatus"></div>
        </div>
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
    'svBossBar', 'svBossName', 'svBossFill',
    'svHighScoreLabel', 'svHighScore', 'svCorner',
    'svNameRow', 'svNameInput', 'svNameSubmit', 'svLbStatus', 'svTransition',
    'svFan', 'svSheetShare', 'svSheetSave',
    // Try again is the one control on the score card that has to work — it is
    // the way back into the game. It was reached only through its click
    // binding until the pad needed to find it by name.
    'svGameOverTitle', 'svRestartBtn',
    'svTrophy', 'svTrophyShare', 'svTrophySave', 'svTrophyStatus',
  ]) {
    el[id] = document.getElementById(id);
  }

  // Built into the same layer as everything else, and handed the reveal so it
  // dissolves like the other surfaces. AFTER the markup above is in the tree —
  // it appends its own overlay to `root`, and the order decides which sits on
  // top of which when two are somehow up at once.
  initPauseMenu({ root, reveal: runReveal, revealSeconds, onResume, onRestart: onPauseRestart });

  // The hive goes into `root` rather than into .sv-hud — see the CSS for the
  // three separate reasons that flex row cannot hold it. main.js drives what it
  // shows; this only puts it on the screen.
  initUpgradeHive(root);

  // The Rive boss bar starts loading NOW, on the title screen, rather than on
  // the frame a boss arrives — see initBossBarRive. Into `root` rather than
  // into .sv-hud for the same reason the div bar is: that is a flex row of
  // corner panels, and a centred banner would be a third item fighting the
  // other two for space. Nothing is drawn until a fight starts, and if it never
  // finishes loading the coded bar below carries the run.
  initBossBarRive(root);
  // And the polaroid's artboard, parsed once here rather than on the frame a
  // boss dies — see initSnapshotCards. It draws nothing until a kill.
  initSnapshotPrints();

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
  //
  // The tick is voiced from `input` rather than `keydown` because `input` is
  // the event that means a character actually landed: keydown also fires for
  // Shift, the arrow keys, Tab, and — the one that would sound broken — every
  // keypress once the field is full, where the browser refuses the character
  // but still reports the key. Backspace DOES tick, deliberately; deleting is
  // as much a keystroke as typing, and silence there reads as a dead key.
  el.svNameInput.addEventListener('input', () => {
    feedback('uiType');
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

// --- the one thing CSS cannot ask about itself -----------------------------
// `.sv-touch` on the UI root, whenever the primary pointer is a thumb.
//
// WHY A CLASS AND NOT A MEDIA QUERY. Everything else adaptive in this file keys
// off the VIEWPORT, which is the honest input for a question about layout and
// has the useful property that it can be reproduced exactly — an iframe 375px
// wide is a 375px viewport, which is what makes `npm run layout` able to check
// any of this. Tap-target size is the exception: it is a question about the
// player's HAND, not their screen, and `pointer: coarse` is unfakeable from
// outside — an iframe inherits it from the machine the browser is running on,
// so a rule written as a media query would be a rule the audit could never
// exercise and never verify. Routed through a class, the game sets it from the
// real query and the audit sets it from the device it is pretending to be.
//
// Re-evaluated on change, not only at boot: plugging a mouse into a tablet (or
// pulling a keyboard off one) flips this, and a UI sized for the wrong hand
// until the next reload is the kind of thing nobody reports.
function markTouch(node) {
  const apply = () => node.classList.toggle('sv-touch', touchPrimary());
  apply();
  window.matchMedia?.('(hover: none) and (pointer: coarse)')?.addEventListener?.('change', apply);
}

export function setHighScore(score) {
  if (!el.svHighScore) return;
  el.svHighScoreLabel.style.display = score > 0 ? '' : 'none';
  el.svHighScore.textContent = Math.floor(score).toLocaleString();
}

// The card's backdrop, as a CSS colour. `scrim` is 0..1 — 1 is the solid panel
// this always had, 0 is the bare ocean with only the artboard over it.
//
// Built here rather than stored as a colour string in CONFIG so it stays one
// number on one slider: the tint is the game's own background colour, and the
// only question worth a control is how much of the water it hides.
function splashBackground() {
  const scrim = CONFIG.titleSeal?.enabled ? (CONFIG.titleSeal.scrim ?? 1) : 1;
  return `rgba(5, 7, 13, ${Math.max(0, Math.min(1, scrim))})`;
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

  // `?title` — THE TITLE SHOT WITH NO CARD OVER IT, dev builds only.
  //
  // The splash artboard paints its own opaque background (see the probe page,
  // `npm run looks:splash`), so with the card up there is nothing to look at
  // underneath it. This is how the shot gets tuned in the meantime: the seal,
  // the ocean and the cursor, and the first press starts the run.
  //
  // Deliberately not a general "skip the splash" switch — it begins the shot,
  // which is the whole point of it. The dev gate lives inside
  // titlePreviewRequested; `?title` on the live site does nothing.
  if (titlePreviewRequested()) {
    splashPlayed = true;
    callbacks.onSplash?.();
    // pointerUP, not down, for the reason the splash itself gives: tearing
    // down on the press leaves the rest of the click to land on the run.
    const go = () => {
      window.removeEventListener('pointerup', go);
      window.removeEventListener('keydown', go);
      unlockAudio();
      beginRun();
    };
    window.addEventListener('pointerup', go);
    window.addEventListener('keydown', go);
    return;
  }

  // Restarting a run goes straight through startGame, so this only ever fires
  // on boot, but the flag keeps that explicit rather than relying on nobody
  // calling showStartMenu() twice.
  if (!splashPlayed && !prefersReducedMotion()) {
    splashPlayed = true;
    // The handle is kept now, where it used to be discarded: the splash listens
    // for a pointer and a key itself, but the Gamepad API has no events at all
    // — a pad is a thing you POLL. So updateMenuNav dismisses it from the game
    // loop, and this is what it dismisses.
    // The title shot begins BEFORE the card is mounted, so the push-in is
    // already a frame or two in by the time the artboard has parsed. See
    // systems/titleSeal.js — it is the seal being framed, and the card is what
    // goes on top of it.
    callbacks.onSplash?.();

    splash = mountRiveSplash({
      parent: root,
      // How much of the ocean behind the card the player can see. Solid is what
      // this shipped with; anything with alpha reveals the seal being held up
      // to the lens underneath. See CONFIG.titleSeal.scrim.
      background: splashBackground(),
      // The wrapper covers the canvas, so the game's own mouse listener is
      // getting nothing while the card is up. This is what keeps the seal
      // watching the cursor. See feedMouse in input.js.
      onPointer: feedMouse,
      // The title screen breaking up into cells and clearing, over a run that
      // has already started. See revealSplashOut.
      exit: revealSplashOut,
      // onDismiss also fires on a load failure, so a missing or corrupt .riv
      // starts the run anyway instead of stranding the player on a blank
      // screen with no way forward now that there's no menu to fall back to.
      onDismiss: beginRun,
      // AUDIO UNLOCKS ON THE PRESS, not on the dismiss, and that split is new.
      // The run now begins when the artboard fires `tStart`, which reaches us
      // from inside Rive's advance — a rAF, not a gesture — and an AudioContext
      // built there comes up suspended. The press that pushed Rive's button
      // arrives here a frame earlier and is a real gesture, so the context is
      // already awake by the time the trigger lands.
      onGesture: unlockAudio,
    });
    return;
  }

  // No splash (reduced motion, or it already played) means no gesture to wait
  // for — go straight in. Audio comes up on the player's first input; see
  // unlockAudio.
  beginRun();
}

// Called SYNCHRONOUSLY from the splash's dismiss handler, not deferred to the
// next frame. startGame clears pending input edges itself, so the same keypress
// doesn't also spend a boost charge on frame one.
//
// THE AUDIO HALF OF THAT REASONING HAS MOVED, and this is worth reading before
// anyone "simplifies" it back. This used to be the gesture: an AudioContext
// built outside a real user gesture comes up suspended and stays silent, and
// the press that dismissed the splash was on the stack right here. It is not
// any more — the run begins when the artboard fires `tStart`, which arrives
// from inside Rive's advance, one rAF removed from the press that caused it.
// So the unlock moved to `onGesture`, which fires on the press itself. This
// call site is still synchronous, but the reason is now only the input edges.
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

/**
 * The element every surface in the game is built inside. Handed to
 * ui/callout.js by main.js so the warning band can be appended ON TOP of the
 * menus — which is the one thing initUI cannot do for it, since that module
 * has to load after this one to read popupPose without an import cycle.
 */
export function uiRoot() {
  return root;
}

export function hideAllMenus() {
  el.svStartMenu.classList.add('sv-hidden');
  // Restarting from inside the pause menu is a real route (its own button), so
  // this has to take the menu down with everything else — otherwise the new
  // run opens with the settings panel still sitting over it.
  hidePauseMenu();
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
  const queue = ['splash', 'upgrades', 'scoreCard', 'pause'];
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

// --- lending the reveal out --------------------------------------------------
// The pause menu is a surface like any other and should dissolve like one, but
// it lives in its own module (ui/pauseMenu.js) because it is several hundred
// lines of settings rows that have nothing to do with anything else in here.
// Handed the two functions it needs rather than importing them back, which
// would make the two files a cycle for the sake of one call.
function revealSeconds(name, direction) {
  const c = revealCfg(name);
  return direction === 'out' ? c.outTime : c.inTime;
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
    onDone: () => { setMenuLocked(false); igniteCards(); },
  });
  // Nothing animated, so nothing is half-drawn and nothing needs locking.
  // igniteCards is deliberately NOT repeated here: every path that returns
  // false has already run onDone on its way out, and calling it twice would
  // pop the first card twice on any machine that can't mask.
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
  // Also covers the ways out that aren't a pick — the menu being closed from
  // under the deal shouldn't leave it counting to an empty screen.
  cancelIgnition();
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
  return player.upgrades.filter((p) => p.id === choice.id).length + 1;
}

// An upgrade with `perLevelName` numbers its card: "Seal Team 1", "Seal Team
// 2". Everything else shows its name unchanged, so this stays opt-in per
// upgrade rather than turning every repeatable card into a counter. The base
// name is still whatever the Upgrades tab has it set to — renaming Seal Team
// there renames the numbered card too.
function cardName(choice) {
  // A rolled card names the variant it is offering — "Glow Up! 1: Venom" — so
  // which element you are being handed is on the card BEFORE you commit to it.
  // A blind pick on a run-defining upgrade is a slot machine, not a choice.
  if (choice.rolledElement) {
    return elementCardName(choice.name, choice.rolledElement, nextStack(choice));
  }
  return choice.perLevelName ? `${choice.name} ${nextStack(choice)}` : choice.name;
}

// `levelDescs` swaps the description at a specific stack, so a card that
// changes what it does at level N can say so on the card that grants it.
//
// Whichever string wins, it goes through expandDesc last: {effect} and friends
// are written in upgrades.csv, in levelDescs and in the element descriptions
// alike, and a placeholder that worked on one card and not another would be
// the kind of inconsistency nobody could hold in their head. `owned` is what
// makes {effect} answer for THIS card rather than for the first one — the
// third Coiled Spring quotes the third stack's numbers.
function cardDesc(choice) {
  const owned = nextStack(choice) - 1;
  const raw = choice.rolledElement
    ? (elementCardDesc(choice.rolledElement, nextStack(choice)) ?? choice.desc)
    : (choice.levelDescs?.[nextStack(choice)] ?? choice.desc);
  return expandDesc(raw, choice, { owned, warn: console.warn });
}

// ---------------------------------------------------------------------------
// THE EFFECT TOOLTIP
//
// Every `desc` in upgrades.csv is hand-typed English, and forty-four of the
// forty-four never say {effect} — so the machinery that can measure a card by
// running its own apply() has, until now, described nothing the player ever
// sees. Meanwhile half the cards are flavour ("All balls, no pit.") and say
// nothing about what they do, and at least one (shrimpRing) promises a number
// that stopped being true.
//
// So the tooltip is not a second description to keep in sync — it is the
// measurement, generated for whichever stack the card is offering. Nothing is
// added to the CSV and nothing has to be maintained: a card written today gets
// one, and a card whose apply() is retuned tomorrow updates itself.
//
// The `stack` matters. The third Coiled Spring is not the first, and hovering
// it quotes the third stack's numbers — same rule cardDesc already follows.
// `desc` is handed in already expanded rather than re-derived here: cardDesc()
// runs expandDesc, which warns about unknown placeholders, and calling it a
// second time per card would print every one of those warnings twice.
function cardEffect(choice, desc) {
  const stack = nextStack(choice);
  const text = phraseAll(measure(choice, stack), stack);
  if (!text) return '';

  // Don't say it twice. Where a `desc` already spells the effect out — the
  // stat cards mostly do, "+25% fire rate" verbatim — a tooltip repeating it
  // word for word is a box that appears to tell you nothing, which trains the
  // player to stop reading it on the cards where it is the only information
  // there is. Compared loosely, because the desc wraps it in a sentence:
  // "Bullets pierce +1 enemy" contains "+1 enemy" and needs no tooltip.
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9%+.-]+/g, ' ').trim();
  if (flat(desc).includes(flat(text))) return '';
  // The box is a sentence of its own, so it opens like one — the same rule
  // expandDesc applies to a desc, applied here because the tooltip is measured
  // straight from phraseAll and never passes through it. The comparison above
  // is case-insensitive, so capitalising after it changes nothing it decided.
  return sentenceCase(text);
}

// The one tooltip node, moved between cards. Created on the first hover of the
// first run rather than at boot, so a session that never levels up never makes
// one.
let cardFx = null;

function showCardEffect(card, text) {
  if (!text) { hideCardEffect(); return; }
  if (!cardFx) {
    cardFx = document.createElement('div');
    cardFx.className = 'sv-card-fx';
    el.svCards.appendChild(cardFx);
  }
  cardFx.textContent = text;

  // Anchored to the hex's DRAWN edge, not the element's. The card is a
  // 210px box clipped to a hexagon whose bottom point sits at 89.6% of that
  // height (see the clip-path), so measuring the box would leave the tooltip
  // floating 22px below empty space.
  const row = el.svCards.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const drawnBottom = r.top + r.height * 0.896;
  const centre = r.left + r.width / 2 - row.left;

  // Measure before deciding which side: the box has to be laid out to know how
  // tall it is, and it is 30px on one line and 60 on three.
  cardFx.style.visibility = 'hidden';
  cardFx.style.left = '0px';
  cardFx.style.top = '0px';
  const h = cardFx.offsetHeight, w = cardFx.offsetWidth;

  // Below by default; above when below would run off the bottom of the window,
  // which is where the second row of a wrapped six-card hand ends up.
  const below = drawnBottom + 8 + h <= window.innerHeight - 8;
  const top = below ? drawnBottom + 8 - row.top
                    : r.top + r.height * 0.104 - 8 - h - row.top;

  // Clamped to the window, so a card on the end of the row doesn't push the
  // tooltip off the side of the screen.
  let left = centre - w / 2;
  const min = 8 - row.left, max = window.innerWidth - 8 - w - row.left;
  left = Math.max(min, Math.min(max, left));

  cardFx.style.left = `${Math.round(left)}px`;
  cardFx.style.top = `${Math.round(top)}px`;
  cardFx.style.visibility = '';
  cardFx.classList.add('sv-fx-on');
}

function hideCardEffect() {
  cardFx?.classList.remove('sv-fx-on');
}

// How far through the run the rarity odds have travelled, 0..1.
//
// Player level rather than elapsed time: the roll happens on the level-up
// screen, which is the one moment the player is being asked to care, and a run
// that levels slowly has earned its odds staying low. Time would hand a
// stalled run the same legendary chances as a thriving one.
function rarityProgress() {
  const cap = Math.max(2, CONFIG.rarityRampLevel ?? 20);
  return Math.min(1, Math.max(0, (player.level - 1) / (cap - 1)));
}

// Paint one card's tier: an inset stroke on the card, a bloom on its wrapper.
//
// Both inline, because the ladder is defined in rarities.csv — a class per tier
// would be a second copy of the table in the stylesheet, and it could not
// survive a row being renamed, recoloured or added, which is the whole point of
// the file being editable.
function applyRarityStyle(slot, card, rarityId) {
  const tier = rarityById(rarityId);
  if (!tier) return;
  const cfg = CONFIG.rarityCard ?? {};
  const hex = `#${(tier.color >>> 0).toString(16).padStart(6, '0')}`;

  // On BOTH, and not by accident. The card draws the ring, so it carries the
  // colour and width itself and stays self-describing. The slot needs the same
  // two values for the bloom it draws around the card and for the white
  // selection ring it switches on — and a custom property cannot be read
  // upwards from a child, so the parent has to hold its own copy.
  for (const node of [slot, card]) {
    node.style.setProperty('--sv-ring', hex);
    node.style.setProperty('--sv-ring-w', `${cfg.ringWidth ?? 3}px`);
  }

  // Two passes, not one. A single wide shadow reads as fog around the card; the
  // tight one gives the edge itself a hot line, and it is the pair that reads
  // as "this thing is lit" rather than "this thing is blurry".
  //
  // SIZES, not a finished filter. The slot's filter is a four-pass list in the
  // stylesheet — this tier's two passes and the white selection pair — and an
  // inline `filter` here would replace all four with two. So the tier hands in
  // how big its own blurs are and the sheet composes them; 0px on the floor
  // tier, which is exactly what "no bloom of its own" means.
  const glow = tier.glow ?? 0;
  slot.style.setProperty('--sv-glow-tight', `${(cfg.glowTight ?? 5) * glow}px`);
  slot.style.setProperty('--sv-glow-halo', `${(cfg.glowRadius ?? 16) * glow}px`);

  // For anything that wants to style or test against the tier without
  // re-deriving it — including the harness, which asserts the ring is actually
  // on the card rather than merely computed.
  slot.dataset.rarity = tier.id;
  card.dataset.rarity = tier.id;
  card.dataset.rarityRank = String(rarityRank(tier.id));
}

// The cards currently on screen, in visual order, and which one the pad has
// selected. Rebuilt every time the menu opens.
let levelUpCards = [];
let selectedIndex = -1;

// The pending steps of the deal — see igniteCards. Held so a card picked mid
// sequence can silence the rest of it: the menu is on its way out, and the
// tiers it was still going to announce are no longer being offered.
let igniteTimers = [];

function cancelIgnition() {
  for (const id of igniteTimers) clearTimeout(id);
  igniteTimers = [];
}

/**
 * Light the dealt cards one at a time, LOWEST TIER FIRST.
 *
 * Rank order rather than the order they happen to sit in: read left to right
 * the hand is arbitrary, but read floor-upwards it is a build, and the best
 * card on the table is always the last thing that happens. Nothing is lit
 * before its turn (see the .sv-lit class) — three cards blooming on the same
 * frame is a wash that says "something was dealt" and nothing about what.
 *
 * Each step is a sound as well as a flare: `cardPop` a step higher in pitch
 * every time, with that tier's own sting on top of it. The pop is the counting,
 * the sting is the answer, and the two together are why the sequence can be
 * followed without looking at it.
 *
 * Runs off setTimeout rather than the game loop on purpose — the run is paused
 * behind this menu, and the flare itself is a compositor animation, so nothing
 * here needs a frame.
 */
function igniteCards() {
  cancelIgnition();
  const cfg = CONFIG.rarityCard?.ignite ?? {};
  const step = Math.max(0, cfg.step ?? 0.13) * 1000;
  const pitchStep = cfg.popPitch ?? 1.06;

  // Ties keep their dealt order, so two cards of the same tier still read left
  // to right rather than swapping around between level-ups.
  const order = levelUpCards
    .map((card, i) => ({ card, i, rank: Number(card.dataset.rarityRank) || 0 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i));

  order.forEach(({ card }, n) => {
    const fire = () => {
      card.parentElement?.classList.add('sv-lit');
      // Pitched by POSITION IN THE SEQUENCE, not by tier: the climb has to be
      // even whatever hand was dealt, so three commons still count upwards.
      playSfx('cardPop', 1, { pitch: pitchStep ** n });
      const tier = rarityById(card.dataset.rarity);
      if (tier?.sfx) playSfx(tier.sfx);
    };
    // The first card lights on the frame the dither lands rather than a step
    // after it, so the sequence starts WITH the menu arriving.
    if (n === 0) fire();
    else igniteTimers.push(setTimeout(fire, n * step));
  });
}

// THE CHOSEN CARD FLIES TO ITS TILE.
//
// The card and the hive tile are the same shape at different sizes — both are a
// square box clipped on the hex art's own vertices (see .sv-card and
// .sv-hive-tile, which share the polygon) — so a straight scale from one to the
// other lands exactly, with no morph and no crossfade needed on the silhouette.
// That is the whole reason this reads as one object moving rather than as a card
// vanishing and a tile appearing.
//
// THE DESTINATION IS MEASURED, NOT PREDICTED. The pick is filed first, so the
// tile already exists and can be asked where it is; it is held invisible for the
// duration and revealed on arrival. Computing the lattice a second time here
// would be a second implementation of the packing that has to agree with the
// first forever, and when it drifted the card would land beside its tile.
//
// Nothing waits on this. The run resumed the moment the choice was filed, and
// the flight is a fixed-position clone on the compositor — if it is interrupted,
// cut short, or never finishes because the tab was hidden, the tile is revealed
// anyway by the timeout below and the only thing lost is the animation.
function flyCardToHive(id, card, from) {
  const fly = CONFIG.upgradeHive?.fly ?? {};
  const to = hiveTileRect(id);

  // No hive, no tile, no box to fly from, or a player who asked for less
  // motion: the tile is simply there. Every one of these is a normal state, not
  // a failure — the hive can be switched off entirely.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (!from || !to || !from.width || fly.enabled === false || reduced) return;

  const flier = card;                  // already a detached clone — see pick()
  flier.classList.add('sv-hive-flier');
  flier.classList.remove('sv-card');   // drop the menu's own hover/focus rules
  flier.style.width = `${from.width}px`;
  flier.style.height = `${from.height}px`;
  flier.style.left = `${from.left}px`;
  flier.style.top = `${from.top}px`;
  flier.style.transform = 'translate(0px, 0px) scale(1)';
  // uiRoot() is a FUNCTION that returns the element, not the element — see its
  // definition. Calling `uiRoot.appendChild` throws, and it throws AFTER the
  // pick has already been filed, so the upgrade still arrived and the menu still
  // closed: the only symptom was no animation, with the error buried in the
  // click handler.
  uiRoot().appendChild(flier);

  // Hidden rather than un-built, so the corner keeps its size and every other
  // tile stays where it was measured. A tile that vanished would reflow the
  // hive mid-flight and the destination would be stale on arrival.
  setTileVisible(id, false);

  const secs = fly.seconds ?? 0.34;
  const curve = cssEase(fly.ease ?? 'outCubic');
  const move = flyTransform(from, to);

  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    flier.remove();
    setTileVisible(id, true);
    // The arrival beat: the tile slams in and the rest of the corner ripples
    // outward from it. Fired here rather than when the pick was filed, because
    // the impact belongs to the moment the card BECOMES the tile — the hive has
    // already quietly shuffled to make room while the card was in the air.
    slamAndRipple(id);
  };

  // Two frames before the transition is armed. One is not enough: the element
  // was appended this frame, and setting the start and end transforms inside a
  // single frame lets the browser coalesce them into one style resolution — the
  // card then teleports to the corner with no animation at all, intermittently,
  // depending on what else happened that frame.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (done) return;
    flier.style.transition = `transform ${secs}s ${curve}, opacity ${secs}s ${curve}`;
    flier.style.transform = move.css;
    // Fades only at the very end, so the swap happens under a card that is still
    // solid — a flier that faded across the whole trip would read as the pick
    // dissolving rather than as it being filed.
    flier.style.opacity = String(fly.landOpacity ?? 0.85);
  }));

  flier.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'transform') land();
  });
  // The backstop. transitionend does not fire for a tab that was hidden mid
  // -flight, and a tile left invisible forever is an upgrade the player holds
  // and cannot see.
  setTimeout(land, Math.round(secs * 1000) + 220);
}

export function showLevelUp() {
  const pool = availableUpgrades();
  const picks = drawUpgrades(pool, CONFIG.upgradeChoices);

  // A level-up can land while the last one is still dealing itself out (two
  // levels in one wave). Whatever was still to be announced belongs to a hand
  // that no longer exists.
  cancelIgnition();
  el.svCards.innerHTML = '';
  // The tooltip lives inside that container, so the line above just deleted
  // it. Dropping the reference is what makes the next hover build a new one —
  // holding the orphaned node would leave every tooltip from level 2 onwards
  // positioned inside an element that is no longer in the document.
  cardFx = null;
  // The shape of the deal, handed to the CSS once rather than per card: the
  // keyframe and the bloom both read these, so a tuner slider moves the flare
  // on the NEXT menu without anything here recomputing a filter.
  const ig = CONFIG.rarityCard?.ignite ?? {};
  el.svCards.style.setProperty('--sv-ignite-time', `${ig.time ?? 0.9}s`);
  el.svCards.style.setProperty('--sv-peak', String(ig.peak ?? 2.3));
  el.svCards.style.setProperty('--sv-idle', String(ig.idle ?? 0.42));
  el.svCards.style.setProperty('--sv-hov-amt', String(ig.hover ?? 0.8));
  // The white "this one" bloom. On the container rather than per card because
  // it is the one part of a card's look that is deliberately the same on all of
  // them — see CONFIG.rarityCard.selectGlow.
  const sel = CONFIG.rarityCard?.selectGlow ?? {};
  el.svCards.style.setProperty('--sv-sel-tight', `${sel.tight ?? 7}px`);
  el.svCards.style.setProperty('--sv-sel-halo', `${sel.halo ?? 22}px`);
  el.svCards.style.setProperty('--sv-sel-tight-a', String(sel.tightAlpha ?? 0.95));
  el.svCards.style.setProperty('--sv-sel-halo-a', String(sel.haloAlpha ?? 0.6));
  for (const def of picks) {
    // An upgrade declaring `roll` picks its variant HERE, at draw time, so the
    // card can show what it is offering. Rolled onto a SHALLOW COPY rather than
    // onto the CONFIG entry itself: config.js is the shared definition, and
    // writing this frame's roll into it would leak the variant into the tuner's
    // Upgrades tab and into the next draw.
    // The tier is rolled here too, and onto the same copy, for the same reason:
    // it belongs to THIS DEAL of this card, not to the upgrade. The odds slide
    // from the early column to the late one across the run — see rollRarity.
    const rarity = rollRarity(rarityProgress());
    const choice = def.roll === 'biolumElement'
      ? { ...def, rolledElement: rollElementFor(), rarity }
      : { ...def, rarity };

    // An unclipped wrapper the bloom can hang off — see the CSS.
    const slot = document.createElement('div');
    slot.className = 'sv-card-slot';

    const card = document.createElement('div');
    card.className = 'sv-card';
    card.tabIndex = 0;
    // The tier it was actually dealt at goes onto the card as data, and that is
    // what the deal reads back later to know its order and its sting — not the
    // CONFIG.upgrades entry, whose roll belongs to no particular hand.
    applyRarityStyle(slot, card, rarity);

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
    const desc = cardDesc(choice);
    content.querySelector('.sv-card-name').textContent = cardName(choice);
    content.querySelector('.sv-card-desc').textContent = desc;

    card.append(overlay, content);

    // Measured once, at deal time, and parked on the card. The measurement
    // replays apply() against two probe stat blocks, and re-running that on
    // every pointerenter would do it again for a string that cannot have
    // changed while the menu is up — the run is paused behind it.
    //
    // On the element rather than in a closure so the pad's selection and the
    // harness can both read it without a second copy of cardEffect().
    card.dataset.effect = cardEffect(choice, desc);
    card.addEventListener('pointerenter', () => {
      if (menuLocked) return;
      showCardEffect(card, card.dataset.effect);
    });
    card.addEventListener('pointerleave', hideCardEffect);

    const pick = () => {
      // Half-drawn cards aren't a menu yet — see setMenuLocked. The class
      // stops the mouse; this stops the pad and the keyboard, which reach the
      // card without going through pointer-events at all.
      if (menuLocked) return;
      // The card's own voice, if its `sfx` column names one. On TOP of the
      // click rather than instead of it: the click is the button answering,
      // this is the upgrade arriving. Everything without a column entry stays
      // on the shared `levelUp` feedback that main.js fires, so this is opt-in
      // per card and silence here is the normal case.
      if (choice.sfx) playSfx(choice.sfx);
      // The tooltip is not part of the dissolve — it is a floating box with its
      // own background, and leaving it up over half-dithered cards reads as a
      // stuck element. Goes on the frame the card is chosen.
      hideCardEffect();
      levelUpCards = [];
      // WHERE THE CARD IS, read before anything is allowed to move it. The
      // dissolve below starts taking it off the screen and the next deal may
      // replace the whole row within the same frame, so this box has to be
      // taken now or the flight starts from a card that is already gone.
      const fromCard = card.cloneNode(true);
      const fromRect = card.getBoundingClientRect();
      fromCard.style.width = `${fromRect.width}px`;

      // The picked card does NOT dissolve — it flies. Hidden on this frame so
      // the clone is the only copy on screen; the other two still dither out,
      // which is what makes the chosen one read as chosen.
      card.style.visibility = 'hidden';

      // Dissolves out rather than vanishing, and the choice is filed on this
      // frame regardless: the run comes back to life behind the cards while
      // they're still on their way off, not after them.
      revealUpgradesOut();
      // FILED FIRST, FLOWN SECOND, and that order is the whole mechanism: the
      // pick has to be in player.upgrades before the hive can have a tile for
      // it, and the flight needs that tile to have somewhere to land.
      callbacks.onLevelChoice(choice);
      flyCardToHive(choice.id, fromCard, fromRect);
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
    slot.appendChild(card);
    el.svCards.appendChild(slot);
  }
  // Reveal first: the cards have no layout while the menu is display:none, so
  // measuring before this point reads zeroes.
  el.svLevelUpMenu.classList.remove('sv-hidden');
  for (const card of el.svCards.querySelectorAll('.sv-card')) fitCardText(card);

  // Gamepad navigation. The cards, not the slots — everything downstream
  // (selection class, focus, the arrow-key geometry) acts on the card itself.
  // The pad's buttons are re-baselined so the fire button being held right now
  // doesn't pick a card the moment one becomes selectable.
  levelUpCards = [...el.svCards.querySelectorAll('.sv-card')];
  // NOTHING IS SELECTED YET. The menu used to open with the first card
  // highlighted and focused so the pad always had something to confirm — but
  // on a mouse that highlight is a lie: it points at a card the player never
  // pointed at, and it sits there for the whole menu because the mouse has no
  // reason to move it. The selection is now something an INPUT creates, and
  // until one arrives the hand is just a hand. updateMenuNav puts it on the
  // first card the moment the pad says anything.
  selectedIndex = -1;
  resetMenuInput();

  // Last, once everything is built, laid out and selected: the reveal masks
  // the finished menu, and a card added after it started would appear whole
  // over a half-dithered one. The deal announces itself once the dither has
  // landed — see igniteCards, which revealUpgradesIn starts.
  revealUpgradesIn();
}

function selectCard(i) {
  if (!levelUpCards.length) return;
  const previous = selectedIndex;
  selectedIndex = Math.max(0, Math.min(levelUpCards.length - 1, i));
  // The pad and the keyboard get the same hover the mouse does — otherwise the
  // menu is silent for anyone not using a pointer, which is most of a run on a
  // controller. Every call here is now a player action (the menu no longer
  // seeds a selection of its own), so the only thing that stays silent is
  // stepping into the card you are already on, which is not a move.
  if (previous !== selectedIndex) feedback('uiHover');
  levelUpCards.forEach((card, n) => card.classList.toggle('sv-card-sel', n === selectedIndex));
  // The pad and the keyboard get the tooltip too, for the same reason they get
  // the hover glow: on a controller the pointer never moves, and an effect
  // readable only with a mouse is an effect half the run cannot see.
  const sel = levelUpCards[selectedIndex];
  if (sel) showCardEffect(sel, sel.dataset.effect);
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

// --- the score card on a pad -------------------------------------------------
// The level-up screen has driven off the pad for a long time; the screen you
// see when a run ENDS never did, which meant a controller player could reach
// the end of a run and have no way to start another one without a mouse.
//
// The controls are collected fresh every frame rather than cached on the way
// in. The trophy row only exists if a boss went down, Submit disables itself
// once a name is posted, and the board arrives from the network later — a list
// built once when the card opened would be wrong within a second in the normal
// case.
let overIndex = -1;

// Every control on the card, reachable or not. The clean-up below has to work
// from THIS list rather than the filtered one: once the card is hidden every
// button on it is inside a hidden block, so a highlight cleared through the
// filter would be a highlight never cleared at all.
function gameOverAll() {
  return [el.svTrophyShare, el.svTrophySave, el.svSheetShare, el.svSheetSave,
    el.svNameSubmit, el.svRestartBtn].filter(Boolean);
}

function gameOverControls() {
  // A disabled button and one inside a hidden block are both unreachable for a
  // mouse, so neither may be a stop for the pad either — a cursor that lands
  // on something invisible is a cursor that has vanished.
  return gameOverAll().filter((c) => !c.disabled && !c.closest('.sv-hidden'));
}

// The name FIELD is deliberately not in that list. A pad cannot type, so a
// cursor stop there would be a dead end with no way to see it was one — the
// field stays a keyboard and touch control, and Submit (which is in the list)
// posts whatever is in it.
function selectGameOver(i, controls) {
  const previous = overIndex;
  overIndex = Math.max(0, Math.min(controls.length - 1, i));
  if (previous !== overIndex) feedback('uiHover');
  for (const c of controls) c.classList.toggle('sv-nav-sel', c === controls[overIndex]);
  controls[overIndex].focus({ preventScroll: true });
}

/** True if the score card is up — in which case it owns the pad this frame. */
function updateGameOverNav() {
  if (el.svGameOverMenu.classList.contains('sv-hidden')) {
    // The highlight has to go with the card, not just the index behind it: a
    // class left on a button is a card that reopens with something already
    // chosen, which is the whole thing this cursor is written to avoid.
    if (overIndex >= 0) {
      for (const c of gameOverAll()) c.classList.remove('sv-nav-sel');
      overIndex = -1;
    }
    return false;
  }
  const controls = gameOverControls();
  if (!controls.length) return true;

  // Same rule as the cards: nothing is highlighted until the player asks, so
  // the card doesn't open with a button lit for a mouse user who will never
  // move it. Any menu direction or a confirm is the asking.
  if (overIndex < 0 || overIndex >= controls.length) {
    if (menuInput.x || menuInput.y || menuInput.confirm) selectGameOver(0, controls);
    return true;
  }

  // One flat list, stepped by either axis. The card is a column of one- and
  // two-button rows rather than a grid, so "down" and "right" mean the same
  // thing here and a player pushing whichever one they thought of is right.
  const step = (menuInput.y || menuInput.x);
  if (step) selectGameOver(overIndex + (step > 0 ? 1 : -1), controls);
  // Through the button's own click, so the pad takes the same path the mouse
  // does — including the sound bound to it.
  if (menuInput.confirm) controls[overIndex]?.click();
  return true;
}

// Called once per frame from the game loop. Drives every screen the pad can
// reach, in the order they can be on top of each other: the splash covers
// everything, the score card is the only thing up when a run has ended, and
// the cards are the only thing up mid-run.
export function updateMenuNav() {
  // A PAD STILL PRESSES ANYTHING TO START, and it is now the only input that
  // does. Keyboard and touch go through the artboard's own Start button (see
  // riveSplash.js) because they can type a name into it, and "any input starts
  // the run" would mean the first letter of that name did. A pad cannot type,
  // so there is nothing for it to interrupt — it gets whatever name is
  // remembered, or none.
  //
  // A poll rather than a listener because the Gamepad API has no events.
  if (splash) {
    if (splash.isDestroyed) splash = null;
    else {
      if (menuInput.anyPress) splash.destroy('gamepad');
      return;
    }
  }

  if (updateGameOverNav()) return;

  if (!levelUpCards.length || el.svLevelUpMenu.classList.contains('sv-hidden')) return;
  // Nothing to drive while the cards are still dissolving in — and in
  // particular no confirm, or a fire button held through the level-up picks
  // the first card before it has finished arriving.
  if (menuLocked) return;

  // Tab or a click can move focus without going through selectCard, so adopt
  // whatever the player is actually on before stepping off it.
  const focused = levelUpCards.indexOf(document.activeElement);
  if (focused >= 0 && focused !== selectedIndex) selectCard(focused);

  // The FIRST thing the pad says lands the selection rather than moving it:
  // there is nothing on screen to step away from until the player has asked
  // for a selection at all (see showLevelUp), and stepSelection measures from
  // the selected card, which does not exist yet.
  //
  // Confirm counts as asking. A held fire button can't reach here — the menu
  // is locked while the cards dissolve in and resetMenuInput has already
  // adopted whatever is down — so a press that arrives with nothing selected
  // is a deliberate one, and it puts the selection on the first card instead
  // of committing to a card the player was never shown as chosen.
  if (selectedIndex < 0) {
    if (menuInput.x || menuInput.y || menuInput.confirm) selectCard(0);
    return;
  }

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

/**
 * A world point in CSS pixels: { x, y }. The same projection the toasts and
 * the seal's floating bars use, exported so ui/callout.js can put an arrow on
 * a piece of chum without a second copy of this arithmetic drifting away from
 * this one. Writes into a caller-owned `out` — this runs a few times a frame.
 */
export function worldToScreen(camera, x, y, out = { x: 0, y: 0 }) {
  PROJECT_V.set(x, y, 0);
  return projectToScreen(camera, PROJECT_V, out);
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
  // A FRACTION, not a width. The level meter runs left-to-right across the top
  // of a desktop screen and bottom-to-top up the left edge of a phone (see the
  // responsive block in STYLES), and which axis it fills is a layout question
  // that CSS is allowed to answer differently at different sizes. Writing
  // `style.width` here took that answer away: an inline width beats any rule,
  // so the vertical bar would have sat at zero height with a full-width fill
  // inside it — visibly nothing, on the one meter that is up for the whole run.
  el.svXpBar.style.setProperty('--sv-xp', Math.max(0, Math.min(1, gameState.xp / gameState.xpToNext)));
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

  // `rapidFireTimer` is still taken and still true — it is simply not DRAWN any
  // more. The panel it used to fill said nothing the fight was not already
  // saying, so it was removed rather than hidden (a hidden panel is a panel
  // somebody has to keep laying out and testing). The parameter stays in the
  // signature because every caller passes it and the read-out may well come
  // back somewhere better; nothing here reads it today.
}

// --- the boss bar ---------------------------------------------------------
// Driven from the frame loop like the rest of the HUD. `banner` is
// systems/boss.js's own view of what is in the water ({ name, frac }), or null
// for "no boss" — which is also what the death and restart paths pass, so the
// bar can never outlive the fight it belongs to.
// HOW LONG THE BAR IS, from how much health the fight has.
//
// A later boss is not just harder, it is visibly WIDER across the top of the
// screen — the escalation made readable before the first hit lands, and the
// only reason the bar is sized at all rather than being one fixed rectangle.
//
// Mapped from hp on a SQUARE ROOT, not linearly. Boss health runs from 600 to
// several thousand across a long run, and a linear map either pins the first
// boss at a sliver or runs the sixth off both edges of the screen. The root
// compresses the top end, so every boss in the range is legibly different from
// its neighbours and none of them is unusable.
// THESE TRACK enemies.csv AND GO STALE SILENTLY. They were 600 and 4000, set
// when a boss had 600 base hp; boss health was then raised roughly fourfold and
// these were not, so every boss in the game — starting with the first — was
// already past the ceiling and every bar drew at full width. The feature did
// not break loudly, it just quietly stopped meaning anything: five fights, five
// identical bars.
//
// So they are set against what a run ACTUALLY MEETS (base hp, plus
// hpPerDifficulty, plus CONFIG.spawn.ramp, at the minute the fight happens) —
// about 10k for the first boss and about 150k deep into a long run — and
// tools/boss-test.mjs re-derives that curve from the CSV and fails when the
// spread collapses. That test is the thing that keeps this honest the next time
// boss health moves; the numbers here cannot do it themselves.
// Set BELOW the first boss rather than at it: the square root compresses the
// top of the range and stretches the bottom, so an endpoint sitting on the
// first fight pins that fight at zero width — the bar would start every run
// looking broken.
const BOSS_BAR_MIN_HP = 6000;    // under the first boss of a run — the short bar
const BOSS_BAR_MAX_HP = 190000;  // deep into a long run — the full-width bar
/** The two endpoints, so a test can drive the ends of the curve without
 *  hardcoding hp numbers that go stale the next time boss health moves —
 *  which is exactly how this pair got four times out of date. */
export const BOSS_BAR_HP_RANGE = [BOSS_BAR_MIN_HP, BOSS_BAR_MAX_HP];
// HOW BIG THIS FIGHT IS, 0..1. Split out from the width string because there
// are now two bars reading it — this one and the Rive artboard, which wants the
// same answer as a percentage of its own width — and a curve that lived in only
// one of them would eventually mean the two bars disagreed about which boss was
// the bigger one.
export function bossBarSpan(maxHp) {
  const t = (Math.sqrt(Math.max(BOSS_BAR_MIN_HP, maxHp ?? 0)) - Math.sqrt(BOSS_BAR_MIN_HP))
    / (Math.sqrt(BOSS_BAR_MAX_HP) - Math.sqrt(BOSS_BAR_MIN_HP));
  return Math.max(0, Math.min(1, t));
}
function bossBarWidth(maxHp) {
  const span = bossBarSpan(maxHp);
  // ON A PHONE THE TOP BAND IS THE BOSS'S ALONE — score and time move to the
  // bottom corner (see .sv-hud-corner) — so the bar is given it, over a much
  // higher floor. 44vw of a 375px screen is 165px, and a forty-character boss
  // name across 165px is three wrapped lines over a bar squeezed into two
  // thirds of an already narrow screen.
  //
  // The SPAN still reads, which is why this remaps the range rather than
  // pinning the bar to one width: a bigger boss still arrives with a visibly
  // longer bar, over a band that starts wide enough to carry its name.
  //
  // Done here rather than as a CSS override because the width is written
  // INLINE by updateBossBar, and an inline style beats any rule — a media query
  // would have been a declaration that silently never applied. The 700px is the
  // same breakpoint the responsive block in STYLES uses.
  if (narrowScreen()) return `${78 + span * 14}vw`;
  // Both ends are in vw so the bar keeps its proportion of the screen on every
  // display, and the ceiling is short of the full width because a bar running
  // edge to edge reads as a loading screen rather than as part of the HUD.
  return `${44 + span * 40}vw`;
}

/**
 * Is this a phone-shaped viewport? The JS half of the 700px breakpoint in
 * STYLES, for the handful of values CSS cannot own because they are written
 * inline per frame.
 *
 * Asked every time rather than latched at boot: a desktop window dragged narrow, or
 * a phone turned on its side, crosses this line without a reload.
 */
function narrowScreen() {
  return window.matchMedia?.('(max-width: 700px)').matches ?? false;
}

export function updateBossBar(banner) {
  // THE RIVE BAR FIRST, THE CODED ONE AS THE FALLBACK. Asked every frame rather
  // than decided once at boot, because "is the Rive bar drawing" genuinely can
  // change mid-run: the artboard loads asynchronously, and it can give up at
  // any point in that load (see bossBarRive.js). A run that starts before the
  // file has arrived draws the div bar and switches over when it lands, which
  // is the right way round — the fallback is the thing that is always ready.
  if (updateBossBarRive(banner, bossBarSpan(banner?.maxHp))) {
    // Both must never be up at once, and the div one is the one that would
    // otherwise be left showing: it is hidden by the same class it always was,
    // rather than by anything the Rive path knows about.
    el.svBossBar?.classList.add('sv-hidden');
    return;
  }
  if (!el.svBossBar) return;
  if (!banner) {
    el.svBossBar.classList.add('sv-hidden');
    return;
  }
  el.svBossBar.classList.remove('sv-hidden');
  // Guarded because this runs every frame and the name changes once per boss:
  // writing textContent unconditionally re-lays-out the line for nothing.
  if (el.svBossName.textContent !== banner.name) el.svBossName.textContent = banner.name;

  // Same guard, and it matters more here: the width is a layout property, and
  // rewriting it every frame would force a reflow of the whole HUD sixty times
  // a second for a value that changes once per boss.
  const width = bossBarWidth(banner.maxHp);
  if (el.svBossBar.style.width !== width) el.svBossBar.style.width = width;

  // THE ARRIVAL. While the boss is swimming in, `frac` is how far through the
  // ceremony it is rather than how much health it has left (see tickArrival in
  // systems/boss.js), and the fill is switched to a slower, eased transition
  // so it GROWS rather than snapping to each frame's value. The class is what
  // carries that difference — a transition duration written from here would
  // have to be unwritten again, and the frame it was missed on is the frame
  // the bar jumps.
  el.svBossFill.classList.toggle('sv-boss-fill-arriving', !!banner.arriving);
  el.svBossFill.style.width = `${Math.max(0, Math.min(1, banner.frac)) * 100}%`;
}

// --- score toasts ---------------------------------------------------------
// One small number per kill, rising from where the creature died. Driven by
// the game loop rather than CSS animation so they pause with the game and
// can't outlive a run — and, since this file owns the clock rather than the
// browser, so the whole shape of the thing is tunable. What each kind does on
// its way in and out is CONFIG.textMotion (the Text panel, Y); this is only
// the loop that plays it.

const toasts = [];

const lerp = (a, b, t) => a + (b - a) * t;

// The motion block for a kind, falling back to the score popup's — a config
// key renamed out from under this must not stop the numbers appearing.
function motionFor(kind) {
  const m = CONFIG.textMotion ?? {};
  return m[kind] ?? m.score ?? {};
}

export function spawnScoreToast(camera, worldX, worldY, points, multiplier = 1) {
  if (!el.svToastLayer || !camera) return;
  PROJECT_V.set(worldX, worldY, 0);
  projectToScreen(camera, PROJECT_V, screenPt);

  const node = document.createElement('div');
  const combo = multiplier > 1;
  node.className = combo ? 'sv-toast sv-toast-combo' : 'sv-toast';
  // THE PRODUCT, AND ONLY THE PRODUCT. `points` is already multiplied, so this
  // is what actually went into the score.
  //
  // The multiplier used to ride along as a "×2.4" tag. It was arithmetic
  // homework at the exact moment there is least time to do it — a chain is
  // half a dozen of these a second, and the two numbers side by side invited
  // reading the small one and multiplying it yourself against the big one that
  // had already had it applied. The combo still shows: `sv-toast-combo` is the
  // colour, and the FOOD CHAIN banner carries the depth.
  node.textContent = `+${points.toLocaleString()}`;
  el.svToastLayer.appendChild(node);
  pushToast(node, screenPt.x, screenPt.y, combo ? 'combo' : 'score');

  // Hard ceiling — a school wipe can kill a dozen creatures on one frame,
  // and unbounded DOM nodes would tank the frame rate.
  while (toasts.length > 40) removeToast(0);
}

// The travel half of a popup's motion, rolled once at birth: the speeds it
// carries for its whole life. The arrival and departure curves are NOT rolled
// here — they're read per frame, so dragging a slider re-shapes the numbers
// already in the air instead of only the next kill.
function rollTravel(t) {
  const m = motionFor(t.kind);
  // Slight horizontal scatter so simultaneous kills in a school don't
  // stack into one illegible clump.
  t.vx = (Math.random() - 0.5) * (m.scatter ?? 0);
  t.vy = -((m.rise ?? 0) + Math.random() * (m.riseVary ?? 0));
  return t;
}

function pushToast(node, x, y, kind) {
  const t = rollTravel({ node, kind, x, y, age: 0 });
  toasts.push(t);
  return t;
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
  chainToastAt(screenPt.x, screenPt.y, chain);
}

// Gold at the bottom, running to a hot orange as the chain deepens — the same
// "this is getting out of hand" ramp the combo speed and grid warp are already
// on, so all three read as one escalation. Both ends are tuned: the cold end is
// the Chain banner role's own colour, the hot end and the depth it is reached
// at are CONFIG.textMotion.chain.
//
// Written inline, per frame it changes, which is why textRoles.js marks this
// role `inlineColor` and typography.js emits no `color` for it — two writers
// on one property, where one of them silently never wins, is the bug that
// costs an afternoon.
function chainColor(chain) {
  const m = motionFor('chain');
  const cold = CONFIG.textStyles?.chain?.color ?? 0xffe066;
  const hot = m.colorHot ?? 0xff803a;
  const hotAt = Math.max(3, m.hotAt ?? 8);
  const t = Math.min(1, Math.max(0, (chain - 2) / (hotAt - 2)));
  const mix = (shift) => Math.round(lerp((cold >>> shift) & 255, (hot >>> shift) & 255, t));
  return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
}

function chainToastAt(x, y, chain) {
  const color = chainColor(chain);

  if (chainToast && toasts.includes(chainToast)) {
    chainToast.age = 0;
    chainToast.x = x;
    chainToast.y = y;
    chainToast.node.style.color = color;
    chainToast.count.textContent = `×${chain}`;
    return chainToast;
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

  chainToast = pushToast(node, x, y, 'chain');
  chainToast.count = count;
  return chainToast;
}

// --- an upgrade paying out -------------------------------------------------
// AN OTHERWISE INVISIBLE PROC, said out loud. Maneater's whole effect is a
// multiplier being rebuilt inside the stat block; without a line naming it, the
// card is a permanent upgrade that never once tells you it is working.
//
// ONE LINE PER UPGRADE, re-used, exactly as the chain banner is — and here the
// reasoning is stronger than it is there. A boat's crew is four or five bodies
// swallowed inside a couple of seconds, so a line per meal would be a stack of
// MANEATERs climbing the screen, each showing a number the one above it has
// already superseded. The card's bonus is a RUNNING TOTAL: there is exactly one
// true value at any moment, so there is exactly one line.
//
// A repeat therefore always updates the text, and only re-pops (replays the
// arrival) once `minGap` has passed — see the note on the `toast` channel in
// systems/feedback.js. That split is what lets a proc that fires every frame
// use this without turning into a strobe.
const procToasts = new Map();

export function spawnProcToast(camera, { key, label, value, x, y, minGap = 0 }) {
  if (!el.svToastLayer || !camera) return null;
  PROJECT_V.set(x, y, 0);
  projectToScreen(camera, PROJECT_V, screenPt);

  const live = procToasts.get(key);
  if (live && toasts.includes(live)) {
    // ALWAYS the newest total, whether or not the line is re-announced.
    live.val.textContent = value ?? '';
    // Old enough to be re-announced. Winding the age back replays the arrival
    // AND buys the line a fresh life, which is the point: the proc happened
    // again, so the receipt should be up for another full read. The anchor and
    // the travel are re-rolled with it, so the line comes off wherever the seal
    // is NOW — moving it without restarting the rise would drop a half-risen
    // line back to the water and read as a glitch rather than as an update.
    if (live.age >= minGap) {
      live.x = screenPt.x;
      live.y = screenPt.y;
      live.age = 0;
      rollTravel(live);
    }
    return live;
  }

  const node = document.createElement('div');
  node.className = 'sv-proc';
  node.textContent = label;
  const val = document.createElement('span');
  val.className = 'sv-proc-val';
  val.textContent = value ?? '';
  node.appendChild(val);
  el.svToastLayer.appendChild(node);

  const t = pushToast(node, screenPt.x, screenPt.y, 'proc');
  t.val = val;
  t.procKey = key;
  procToasts.set(key, t);
  return t;
}

function removeToast(i) {
  if (toasts[i] === chainToast) chainToast = null;
  // Dropped from the index as well as from the layer, or the next proc of this
  // upgrade would find a dead entry, see it is not in `toasts`, and build a
  // second node while the map still pointed at the first.
  if (toasts[i].procKey) procToasts.delete(toasts[i].procKey);
  toasts[i].node.remove();
  toasts.splice(i, 1);
}

export function updateToasts(dt) {
  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i];
    const m = motionFor(t.kind);
    // Read per frame rather than captured at birth, so a slider drag reshapes
    // the popups already in the air — which is the difference between tuning
    // this and guessing at it one kill at a time. It also means shortening the
    // life retires everything currently over that age on the next frame, which
    // is the behaviour you want from a control called "time on screen".
    const pose = popupPose(t.kind, t.age + dt);
    t.age += dt;
    if (t.age >= pose.life) { removeToast(i); continue; }

    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.vy += (m.gravity ?? 0) * dt; // ease the rise so it settles rather than flying off

    t.node.style.transform = `translate(-50%,-50%) scale(${pose.scale})`;
    t.node.style.left = `${t.x}px`;
    t.node.style.top = `${t.y + pose.lift}px`;
    t.node.style.opacity = `${pose.alpha}`;
  }
}

/**
 * WHERE A POPUP IS IN ITS ARRIVAL AND DEPARTURE, at `age` seconds old.
 *
 * THE TWO WINDOWS. The arrival runs from birth; the departure runs backwards
 * from the end of life. ease() clamps its input, so before the departure window
 * opens its progress is a hard 0 and its terms are identities — no branch
 * needed, and no frame where both are half-applied by accident rather than on
 * purpose.
 *
 * Exported because the Text panel's specimen plays the same curves on a loop:
 * the popups are the one part of the interface you cannot hold still and look
 * at, so the panel has to animate them to show what a motion row does. Two
 * copies of this arithmetic would drift the moment one of them was tuned, and
 * the whole point of the specimen is that it is not an approximation.
 */
export function popupPose(kind, age, lifeOverride = null) {
  const m = motionFor(kind);
  // `lifeOverride` is the callout band, whose time on screen is a column in
  // callouts.csv rather than a slider — a warning holds for as long as that row
  // says, and the motion block still owns the shape of the arrival and the
  // departure. Every other caller passes nothing and gets `life` from the
  // tuner, which is what the Text panel's specimen is drawing.
  const life = Math.max(0.05, lifeOverride ?? m.life ?? 0.85);
  const inM = m.in ?? {};
  const outM = m.out ?? {};
  const inTime = Math.max(0, inM.time ?? 0);
  const outTime = Math.max(0, outM.time ?? 0);
  const kIn = inTime > 0 ? ease(inM.ease, age / inTime) : 1;
  const kOut = outTime > 0 ? ease(outM.ease, (age - (life - outTime)) / outTime) : 0;

  // Multiplied for the two that are factors, added for the one that is an
  // offset — so a `life` shorter than the two windows put together blends
  // instead of fighting, and neither window can cancel the other out.
  return {
    life,
    scale: lerp(inM.scale ?? 1, 1, kIn) * lerp(1, outM.scale ?? 1, kOut),
    alpha: lerp(inM.fade ?? 1, 1, kIn) * lerp(1, outM.fade ?? 0, kOut),
    lift: lerp(inM.lift ?? 0, 0, kIn) + lerp(0, outM.lift ?? 0, kOut),
    // BLOOM, in px of halo ON TOP of whatever glow the text role already has.
    // Added like `lift` rather than multiplied like the other two, and that is
    // the reason it is its own field instead of a factor on the role's glow: a
    // role set to glow 0 has nothing to multiply, and "blooms as it arrives"
    // has to work on text that is not glowing the rest of the time. Both ends
    // ramp to zero at rest, so a line can flare in, sit clean, and flare out.
    bloom: lerp(inM.bloom ?? 0, 0, kIn) + lerp(0, outM.bloom ?? 0, kOut),
  };
}

// --- previewing a whole screen ---------------------------------------------
// WHICH SURFACE IS BEHIND THE TEXT PANEL. Dev only; the Text panel (Y) is the
// only caller.
//
// Type is judged in place or not at all — the card text has to be read inside
// the hex, the HUD label above a number, the quip over a score. But the screen
// you happen to be on when you open the panel is the screen you are stuck with,
// and on boot that is the start menu: the one surface you cannot get back to
// without reloading, sitting in front of everything you actually want to look
// at. So the panel can put any of them up, including none of them.
//
// This lives here rather than in the panel because what "show the score card"
// safely means is this module's business, not a tuning panel's — see the run
// that is deliberately made unpostable below.
export const PREVIEW_SCREENS = ['clear', 'start', 'HUD', 'cards', 'score card'];

export function previewScreen(name) {
  if (!el.svHud) return;
  // Everything down first, so each branch only has to say what it puts UP and
  // no two screens can end up on top of each other.
  hideAllMenus();
  el.svHud.classList.add('sv-hidden');

  if (name === 'start') {
    // The element, not showStartMenu() — that function's job is to run the
    // Rive splash and then START THE RUN, which is not what "let me look at
    // the start menu's type" should do.
    el.svStartMenu.classList.remove('sv-hidden');
  } else if (name === 'HUD') {
    showHud();
  } else if (name === 'cards') {
    // A real deal, the same one Shift+L gives: the tiers are rolled for the
    // level you are actually on, and picking a card grants it.
    showLevelUp();
  } else if (name === 'score card') {
    previewGameOver();
  }
  // 'clear' is the fall-through: nothing up, nothing but the sea behind the
  // panel. It is also the way back from a specimen popup burst.
}

// The score card, with an invented run on it.
//
// THE RUN IS MADE UNPOSTABLE BEFORE THIS RETURNS. showGameOver arms a real
// submission — that is its job — and a fabricated 184k with a name box under it
// is one click away from being on the global leaderboard forever. Nulling
// `pendingRun` is what actually disarms it (submitScore returns immediately
// without one); the name row is hidden as well so the click isn't offered in
// the first place.
function previewGameOver() {
  showGameOver({ score: 184200, kills: 212, level: 14, time: 421 });
  pendingRun = null;
  el.svNameRow?.classList.add('sv-hidden');
  setStatus('Preview — this run is invented and cannot be posted.');
}

// --- the specimen ----------------------------------------------------------
// Fire one of everything, where the panel can see it. Dev only — the Text panel
// (Y) calls this, and nothing in a run does.
//
// It exists because the popups are the one part of the interface you cannot
// hold still to look at: they last under a second, they only happen on a kill,
// and a chain deep enough to turn the banner orange is not something you can
// arrange while your other hand is on a slider.
export function previewToasts() {
  if (!el.svToastLayer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Left of centre and clear of the panel on the right, in the band the
  // gameplay actually happens in.
  const cx = w * 0.38;
  const cy = h * 0.55;

  for (let i = 0; i < 5; i++) {
    const node = document.createElement('div');
    const combo = i >= 3;
    node.className = combo ? 'sv-toast sv-toast-combo' : 'sv-toast';
    node.textContent = `+${((i + 1) * 210 * (combo ? 4 : 1)).toLocaleString()}`;
    el.svToastLayer.appendChild(node);
    const t = pushToast(node, cx + (i - 2) * 46, cy + (i % 2) * 18, combo ? 'combo' : 'score');
    // Staggered, so five popups on one frame read as a burst of kills rather
    // than as one wide number.
    t.age = -i * 0.09;
  }
  chainToastAt(cx, cy - 90, 6);

  // A proc line, so the Upgrade proc role can be judged next to the numbers it
  // shares a layer with. Built here rather than through spawnProcToast because
  // the specimen has no camera to project through — the position is already in
  // screen pixels, which is the one thing that function exists to work out.
  const proc = document.createElement('div');
  proc.className = 'sv-proc';
  proc.textContent = 'MANEATER';
  const procVal = document.createElement('span');
  procVal.className = 'sv-proc-val';
  procVal.textContent = '+12%';
  proc.appendChild(procVal);
  el.svToastLayer.appendChild(proc);
  pushToast(proc, cx, cy - 40, 'proc');
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

// --- the trophy ------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE ROLL — every kill shot from the run, on the score screen.
//
// The prints the player watched come out of the camera during the fight (see
// ui/snapshotPrint.js) are stacked in the corner while they play; here they
// are fanned out, and every one of them can be shared or saved on its own.
// "Share all" composes the run into a single image — the scorecard over a grid
// of the kills — because the share sheet takes one file at a time and nobody
// posts five things in a row.
//
// The paper is BUILT BY THE PRINT MODULE, not restated here. Two polaroids in
// two files drift apart the first time either is retuned, and the one that
// drifted would be the one the player is asked to share.
// ---------------------------------------------------------------------------

// Which print the two "this one" buttons act on. The most recent kill by
// default — it is the one the player just made, and on a run with one boss it
// is the only honest answer.
let selectedShot = 0;
// The recap the sheet is composed from, banked when the screen is shown.
let recapRun = null;

function fanTilt(i, total) {
  // A fan, not a stack: the spread is centred so the middle print is square to
  // the frame and the ends lean away from it. One print gets no tilt at all —
  // a lone photograph at an angle reads as a mistake rather than as a fan.
  if (total <= 1) return 0;
  const spread = Math.min(9, 26 / total);
  return (i - (total - 1) / 2) * spread;
}

function showTrophy() {
  const shots = bossShots();
  if (!el.svTrophy || !el.svFan) return;
  el.svFan.innerHTML = '';
  if (!shots.length) {
    // No boss died this run. Hidden, and the prints are dropped as well as the
    // element — a stale image left in the rack is a picture of the previous
    // run sitting one class away from being shown again.
    el.svTrophy.classList.add('sv-hidden');
    return;
  }

  selectedShot = shots.length - 1;
  // Narrower the more there are, so eight prints still fit the card on a
  // phone. The fan overlaps them by a third, so the rack is about half the
  // width the same prints would need in a row.
  const width = Math.max(96, Math.round(Math.min(190, 620 / Math.max(2, shots.length))));
  shots.forEach((shot, i) => {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'sv-fan-slot';
    slot.style.setProperty('--rot', `${fanTilt(i, shots.length).toFixed(2)}deg`);
    // Later kills sit on top of earlier ones, so the fan reads left to right
    // in the order the run happened.
    slot.style.zIndex = String(i + 1);
    if (i > 0) slot.style.marginLeft = `${-Math.round(width * 0.34)}px`;
    slot.setAttribute('aria-label', shot.name ? `Kill shot: ${shot.name}` : `Kill shot ${i + 1}`);
    slot.appendChild(buildPrintPaper(shot.url, shot, width));
    slot.addEventListener('click', () => selectShot(i));
    el.svFan.appendChild(slot);
  });
  selectShot(selectedShot);
  // Render every polaroid NOW, while the screen is arriving. Left until a
  // button is pressed, the render would spend the click's transient activation
  // and navigator.share would refuse the sheet — see warmShareCards.
  //
  // The whole-run sheet is warmed the same way and for the same reason, on the
  // far side of the cards: it is composed FROM them, so starting it first would
  // only make it wait. It is the more expensive of the two and the one whose
  // share button was failing, because a compose that runs inside the click
  // handler outlives the click's activation. See warmRunSheet.
  warmShareCards().then(() => warmRunSheet(recapRun ?? {}));
  el.svTrophyStatus.textContent = '';
  el.svTrophy.classList.remove('sv-hidden');
  wireTrophy();
}

function selectShot(i) {
  selectedShot = i;
  const slots = el.svFan?.children ?? [];
  for (let n = 0; n < slots.length; n++) {
    slots[n].classList.toggle('sv-fan-sel', n === i);
    // The lifted print has to be above its neighbours whatever order it is in,
    // and it has to go back to its place in the fan when another is picked.
    slots[n].style.zIndex = String(n === i ? slots.length + 1 : n + 1);
  }
}

// The buttons are wired once, on first show, and they must be wired to a real
// click — both the share sheet and, in some browsers, the download are gated
// on a user gesture, so neither can be fired from the frame loop or a timer.
let trophyWired = false;

function wireTrophy() {
  if (trophyWired) return;
  trophyWired = true;
  const say = (msg) => { if (el.svTrophyStatus) el.svTrophyStatus.textContent = msg; };
  // The result is reported back rather than assumed, because the routes this
  // can take are genuinely different outcomes to a player: the sheet opened, a
  // file landed in Downloads, or nothing happened because they closed the
  // sheet. Saying "shared!" for all three is how a download goes unnoticed.
  const told = (how) => say({
    shared: 'Shared',
    saved: 'Saved to your downloads',
    // On a phone this is the picture opening full screen, where saving it is a
    // long press. Worth saying, because it is a different gesture from the one
    // the button implied.
    opened: 'Opened — press and hold the picture to save it',
    cancelled: '',
    unavailable: 'Nothing to share',
  }[how] ?? '');

  // WHERE THE OS HAS A SHARE SHEET, THAT SHEET IS ALSO HOW YOU SAVE. iOS puts
  // "Save Image" in it, one tap from where the player already is — so a
  // separate save button there is a second control doing the first one's job,
  // and it is the one that cannot work properly: a phone browser has no
  // downloads folder to put a file in, which is why the save buttons appeared
  // dead on iOS rather than merely awkward (see download() in bossShot.js).
  //
  // Removed rather than hidden with a class, so nothing — the pad's menu
  // navigation especially, which walks this row by name — can land on a control
  // that isn't there. Desktop is untouched and keeps all four.
  if (canShareImages()) {
    el.svTrophySave?.remove();
    el.svSheetSave?.remove();
    el.svTrophySave = null;
    el.svSheetSave = null;
    // "Share" is now the only verb on the row, so it no longer needs to be
    // distinguished from saving — these say which PICTURE they act on.
    if (el.svTrophyShare) el.svTrophyShare.textContent = 'Share this print';
    if (el.svSheetShare) el.svSheetShare.textContent = 'Share the whole run';
  }

  el.svTrophyShare?.addEventListener('click', async () => {
    say('…');
    told(await shareBossShot(selectedShot));
  });
  el.svTrophySave?.addEventListener('click', async () => told(await saveBossShot(selectedShot)));
  el.svSheetShare?.addEventListener('click', async () => {
    // Composing eight frames into one image is the only thing on this screen
    // that takes long enough to notice, and a button that looks dead for a
    // moment gets pressed twice.
    say('Building your run…');
    told(await shareRunSheet(recapRun ?? {}));
  });
  el.svSheetSave?.addEventListener('click', async () => {
    say('Building your run…');
    told(await saveRunSheet(recapRun ?? {}));
  });
}

export function showGameOver(gameState, extra = {}) {
  el.svHud.classList.add('sv-hidden');
  // Rolled per death, not once per session — the line is the first thing read
  // on a screen the player sees dozens of times a sitting.
  // `deathCauses` is the Set killPlayer resolved at the moment of death. The
  // demo score screen (svDemo, below) passes a plain object with no such key,
  // and gets the whole table — which is what a preview of the screen wants.
  // expandPlayer LAST, after the draw: a quip may be written "Nice try,
  // {player}", and the token has to be spent on the row that actually won
  // rather than on the whole table. textContent, not innerHTML, so a typed
  // name is text no matter what is in it — sanitizeName strips the dangerous
  // characters on the way in as well, and neither guard is the only one.
  el.svGameOverTitle.textContent = expandPlayer(pickQuip(QUIPS, Math.random, gameState.deathCauses));
  const score = Math.floor(gameState.score ?? 0);
  // THE SCORECARD. The same five figures the shared image carries (see
  // drawScorecard in systems/bossShot.js), so a player looking at the picture
  // they posted and a player looking at this screen are reading the same run.
  const bosses = extra.bosses ?? bossShots().length;
  el.svGameOverStats.innerHTML = [
    ['Score', score.toLocaleString()],
    ['Time', formatTime(gameState.time)],
    ['Level', gameState.level],
    ['Kills', gameState.kills],
    ['Bosses', bosses],
  ].map(([k, v]) => `<span class="sv-stat"><b>${v}</b>${k}</span>`).join('');

  const token = ++gameOverToken;
  pendingRun = {
    score,
    kills: gameState.kills,
    level: gameState.level,
    time: gameState.time,
    date: Date.now(),
  };
  // What the shared image's scorecard is drawn from. Banked here rather than
  // read when a button is pressed: by then the next run may have started (the
  // score screen is live while the water carries on behind it), and a sheet
  // captioned with somebody else's score is worse than no sheet.
  recapRun = { ...pendingRun, bosses: extra.bosses ?? bossShots().length };

  el.svNameRow.classList.remove('sv-hidden');
  el.svNameSubmit.disabled = false;
  el.svNameInput.disabled = false;
  el.svNameInput.value = loadPlayerName();
  setStatus(isGlobal() ? 'Enter a name to post your score' : 'Enter a name to save your score');

  // Show the standing board right away from local data, then upgrade it to the
  // global one when that arrives. Waiting on the network first would leave the
  // panel blank for as long as the request takes.
  showTrophy();

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
  if (!touchPrimary()) {
    el.svNameInput.focus();
    el.svNameInput.select();
  }
}

async function submitPendingRun() {
  if (!pendingRun) return;

  const run = pendingRun;
  pendingRun = null; // claim it before any await — a double click must not post twice

  // 'ANON' and NOT DEFAULT_PLAYER_NAME, and the difference is deliberate. The
  // token's fallback is the game's VOICE — "Nice one, Seal" reads fine to
  // somebody who never typed a name. A board is a list of PEOPLE, and a public
  // top ten with four rows called Seal reads as four players with the same
  // name rather than as four who declined to give one.
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


function formatTime(t) {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
