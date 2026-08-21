import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
import { hexMaskSet, noiseMaskSet } from './dither.js';
import { wornEdgeMask } from './wornEdge.js';
import { mountCardFlip, releaseCardFlip, cardFlipMoving } from './cardFlip.js';
import { drawUpgrades } from '../upgradeTable.js';
import { expandDesc, measure, phraseAll, sentenceCase } from '../upgradeText.js';
import { rollElementFor, elementCardName, elementCardDesc } from '../systems/elements.js';
import { rollRarity, rarityById, rarityRank } from '../systems/rarity.js';
import quipsCsv from '../quips.csv?raw';
import { parseQuipCsv, pickQuip } from '../quipTable.js';
import { availableUpgrades, player } from '../entities/player.js';
import { feedMouse, menuInput, resetMenuInput } from '../input.js';
// The splash and the score card's turn are pure motion with no way to opt out
// mid-play, so both honour the system setting by skipping entirely. The CSS
// rule at the bottom of STYLES only disables transitions, which would not touch
// a canvas animation or a rAF loop.
import { touchPrimary, prefersReducedMotion } from '../devices.js';
// One setting, read live rather than pushed in: where the health and air
// gauges are drawn. settings.js imports nothing from here, so this is a leaf
// dependency and not half of a cycle.
import { barPlacement, boostMeter } from '../systems/settings.js';
// THE BOOST COLUMN'S MODEL, borrowed rather than rebuilt. systems/strikeRing.js
// owns the pip springs, the stagger queue and the pops whichever view is on
// screen; this file only draws them. Neither module imports the other's data —
// pipAnim() is a read — and neither imports back into here, so this is a leaf
// dependency like the setting above it.
import { pipAnim } from '../systems/strikeRing.js';
import { pipCount } from '../systems/strike.js';
// THE GRAIN IN THE GAUGES. One field for every meter on screen, shared with
// the fuel wheel around the seal — see systems/meterNoise.js. The HUD is what
// advances its clock, because updateHUD is the once-per-live-frame call and
// two things advancing it would run the drift at double speed.
import { advanceMeterNoise, meterNoiseFrame, resetMeterNoise } from '../systems/meterNoise.js';
import { mountRiveSplash } from './riveSplash.js';
import { tipJarLink } from './tipJar.js';
import { titlePreviewRequested } from '../systems/titleSeal.js';
import { initBossBarRive, updateBossBarRive } from './bossBarRive.js';
import { bossShot, bossShots, bossShotImage, shareBossShot, saveBossShot, shareRunSheet, saveRunSheet, warmShareCards, warmRunSheet, canShareImages } from '../systems/bossShot.js';
import { buildPrintPaper, initSnapshotPrints, resyncPrintCards } from './snapshotPrint.js';
import { hidePauseMenu, initPauseMenu } from './pauseMenu.js';
import { initUpgradeHive, hiveTileRect, setTileVisible, slamAndRipple, flyTransform } from './upgradeHive.js';
import {
  BOARD_SIZE,
  fetchGlobalBoard,
  isGlobal,
  loadLeaderboard,
  submitScore,
} from '../systems/leaderboard.js';
// The name itself is not the leaderboard's any more — see the note where it
// used to live. The board is one consumer of it; the {player} token in
// callouts.csv, quips.csv and upgrades.csv is the rest.
import { MAX_NAME_LEN, loadPlayerName, sanitizeName, savePlayerName, expandPlayer } from '../systems/playerName.js';
import { feedback } from '../systems/feedback.js';
// THE RECAP'S NUMBERS. The recorder runs on every run, not only on a dev
// build, so the Weapons and Threats tabs are reading the same ledger the
// balance report does rather than a second set of counters kept for the
// score screen — the two cannot disagree about what a run was.
import { lastFinishedRun } from '../systems/playtest.js';
import { analyzeRun, sourceLabel } from '../systems/playtestAnalysis.js';
// Creatures have no names anywhere in the data — enemies.csv is balance
// columns keyed by id. The cause table is where a player-facing word for a
// creature exists, and grouping the incoming damage the way the quips group it
// is also the reading that makes sense: four species of shark are one thing
// that killed you. See `threat` in deathCauses.js.
import { primaryCause, threatLabel } from '../deathCauses.js';
import { weaponName } from '../weaponName.js';
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

  /* --- THE PILE UNDER A STACKED TILE --------------------------------------
     Extra picks of the same upgrade are drawn as layers BEHIND the tile, offset
     down, so the hexagon appears to grow in height out of its cell. See
     buildShims in upgradeHive.js for why they are siblings and not children:
     the tile is clipped to its own hexagon, so anything drawn below its flat
     bottom edge from inside it is not dimmed, it is not painted at all.
     Z-INDEX, NOT DOM ORDER. Piles overlap their NEIGHBOURS as well as their own
     tile, and a layer belonging to a tile late in the tree would otherwise
     paint over the face of a tile early in it. Every layer is under every tile;
     which tile wins against which is then the paint order rebuild() sets. */
  /* NO z-index ON ANY OF THESE. A tile, its pile and the shade it casts are one
     object standing in one place, and rebuild() appends the whole hive in
     painter's order — furthest cell first, nearest last. Layering them by
     z-index instead lifts every pile in the hive above every shade in it, which
     is how a tower ends up casting its own shadow onto its own pile. */
  .sv-hive-shim { position: absolute; pointer-events: none;
    -webkit-clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    /* THE STROKE STACKS TOO. A layer is built exactly like the tile above it —
       the tier colour IS the element's background and the dark fill is a
       smaller hexagon inset on top, so the rim follows all six edges. Drawn as
       flat silhouettes instead, a deep pile is one dark wedge: you can see that
       the tile got taller and not how many picks made it so. Only a few px of
       each layer ever show, and this is what makes those px an EDGE. */
    background: color-mix(in srgb, var(--sv-hive-rarity, #b8c2cc) var(--sv-shim-mix, 40%), #05121a); }
  .sv-hive-shim-face { position: absolute; inset: 2px;
    -webkit-clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    clip-path: polygon(5.7% 51%, 27.1% 12.7%, 72.3% 12.7%, 93.9% 51%, 72.3% 89.6%, 27.1% 89.6%);
    /* Darker than the tile's own face, and by more the deeper it sits: the pile
       is in the tile's shadow, and a layer painted at the face's brightness
       reads as a second tile slipping out from under the first. */
    background: linear-gradient(160deg, rgba(16,46,63,0.92), rgba(6,18,26,0.96)); }
  /* 'riser' is ONE body with an inline px polygon — the hexagon's own vertices
     with the bottom half dropped by the depth. It carries no clip of its own
     here: a percentage clip on a box that is taller than it is wide would
     squash the top face out of register with the tile sitting on it. Its face
     is a second prism, one rim narrower, so the tower has an outline down its
     whole height rather than only around the hexagon on top. */
  /* THE STROKE IS SOLID DOWN THE WHOLE BODY, and the shading lives on the fill
     inside it. It was the other way round — the tier colour ramping off toward
     the base — and on a prism that is the same mistake as a pile whose deepest
     plate has no outline: the tower's silhouette dissolves into the water at
     exactly the end that is standing on it, so a tall riser reads as a short
     one that has been smudged. Rim first, light second. */
  .sv-hive-shim[data-mode="riser"] {
    background: color-mix(in srgb, var(--sv-hive-rarity, #b8c2cc) var(--sv-shim-mix, 100%), #05121a); }
  .sv-hive-shim[data-mode="riser"] .sv-hive-shim-face {
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--sv-hive-rarity, #b8c2cc) var(--sv-shim-top, 58%), #071a26),
      color-mix(in srgb, var(--sv-hive-rarity, #b8c2cc) var(--sv-shim-base, 20%), #04101a)); }

  /* THE CONTACT SHADOW UNDER A TOWER — see buildShade.
     A RADIAL GRADIENT, NOT A BLURRED BOX. 'filter' is applied before
     'clip-path', so a blurred element that is also clipped comes back with a
     hard hexagonal edge: a soft shadow cut into a sharp shape. This needs
     neither, composites for free, and cannot be clipped by anything.
     IT FALLS ON WHAT IS BEHIND IT AND ON NOTHING OF ITS OWN. Appended first of
     the three, so the pile and the tile it belongs to are painted over the top
     of it — a tower that shades its own stack looks like the pile is made of
     something dirtier than the tile, which is the exact opposite of the read. */
  .sv-hive-shade { position: absolute; pointer-events: none;
    background: radial-gradient(ellipse at 50% 52%,
      rgba(2,8,13,var(--sv-shade-alpha, 0.4)) 0 38%,
      rgba(2,8,13,calc(var(--sv-shade-alpha, 0.4) * 0.55)) 62%,
      rgba(2,8,13,0) 78%); }

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

  /* Health and oxygen ride BESIDE the seal, so the two things you have to
     react to fastest are where your eyes already are. Positioned in screen
     space each frame from the player's projected world position.
     VERTICAL, and to the LEFT. Two tall columns draining downwards read as
     gauges emptying — a thing running out — where the old pair of 4px
     horizontal slivers above the head read as decoration and were routinely
     missed. Left rather than right because the seal faces right for most of a
     run and the water it is swimming INTO is the half of the screen that has
     to stay clear.
     translate(-100%, -50%) hangs the stack off the LEFT of its anchor and
     centres it on the seal's own height: the anchor is already pushed
     CONFIG.hud.playerBarOffset world units to the left, and without the
     -100% the bars would start there and grow back over the animal. */
  .sv-playerbars { position: absolute; display: flex; flex-direction: row-reverse;
    gap: 5px; pointer-events: none;
    transform: translate(-100%, -50%); transition: opacity 0.2s ease; }
  /* row-reverse, so health — the one you die from — is the column nearest the
     seal and oxygen sits outboard of it. DOM order stays health-then-oxygen
     because that is the order they matter in. */
  /* THE PULSE lives on the track rather than on the fill: low on health or
     air, the whole column brightens and dims so the bar keeps MOVING after
     the value has stopped, which is what pulls an eye that is busy elsewhere.
     --sv-alarm is written per frame already oscillating (updateHUD owns the
     wave), so there is no CSS animation to keep in step with anything and the
     alarm can fade in gradually instead of switching on at a threshold. */
  /* --- THE GLOW ----------------------------------------------------------
     --sv-glow (0..1, written per frame) is "look at this gauge NOW": critical
     on the way down, a real refill on the way up. See PBAR_SMOOTH.

     IT LIVES ON THE TRACK, NOT ON THE FILL, and that is not a preference.
     The fill is a full-height element squashed by scaleY(--sv-fill), and a
     transform takes the element's shadow with it — a box-shadow there would
     be flattened to a seventh of its height at exactly the moment the glow
     matters most, which is a critical gauge with almost nothing left in it.
     On the track it is the same halo whatever the bar is reading. A track's
     own box-shadow is also drawn OUTSIDE its border box, so overflow:hidden
     (which clips the fill and the trail) does not touch it.

     THIS IS NOT THE RENDERER'S BLOOM and cannot be: the HUD is DOM sitting on
     top of the canvas, and systems/post.js's bright pass never sees it. What
     it is instead is the same shape bloom makes — a tight core and a wide soft
     falloff, two shadows rather than one — plus a brightness lift on the fill
     so the colour drives up into the halo instead of sitting flat inside it.

     --sv-glow-rgb is the gauge's own colour, set per class below, so red and
     amber halo in their own hue rather than in one shared white. */
  /* THE HALO IS A VARIABLE, not two shadows typed into a rule, and that is
     load-bearing rather than tidy. box-shadow is a single property: any rule
     that restates it REPLACES the whole list, so the corner placement's own
     rim (further down) silently deleted the glow the first time this was
     written inline — in the placement that ships by default, which is the one
     nobody would have thought to re-check. Both rules now end in
     var(--sv-halo), so a placement can restate its rim without being able to
     drop the glow. */
  .sv-pbar-wrap {
    --sv-halo:
      0 0 calc(9px * var(--sv-glow, 0)) rgba(var(--sv-glow-rgb, 255,255,255), calc(0.95 * var(--sv-glow, 0))),
      0 0 calc(26px * var(--sv-glow, 0)) rgba(var(--sv-glow-rgb, 255,255,255), calc(0.55 * var(--sv-glow, 0)));
    position: relative; width: 9px; height: 58px;
    background: rgba(4,6,12,0.66); border-radius: 5px;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 6px rgba(0,0,0,0.55), var(--sv-halo);
    filter: brightness(calc(1 + 0.6 * var(--sv-alarm, 0) + 0.5 * var(--sv-glow, 0)))
      saturate(calc(1 + 0.35 * var(--sv-glow, 0))); }
  /* SCALED, not sized, and for the same reason as the xp strip above: the fill
     is always the full track, squashed along Y by --sv-fill (a 0..1 fraction
     written every frame by updateHUD). transform-origin is the bottom, so the
     column drains downwards.
     NO TRANSITION HERE, deliberately. The smoothing is done in JS — see
     PBAR_SMOOTH in updateHUD — and a CSS transition chasing a value that is
     itself already moving never arrives: it would lag a fixed interval behind
     for the whole run and then snap, which is the exact fault this change was
     asked to fix. One curve, in one place. */
  .sv-pbar, .sv-pbar-ghost { position: absolute; inset: 0; border-radius: 5px;
    transform: scaleY(var(--sv-fill, 1)); transform-origin: 50% 100%; }
  /* THE TRAIL. A second fill behind the real one that snaps up on a gain and
     falls slowly on a loss, so the pale band left standing above the fill IS
     the damage you just took, held on screen long enough to read. Without it a
     smoothed bar is honest but quiet — you see the new level, never the size
     of the bite. */
  .sv-pbar-ghost { background: rgba(255,240,245,0.55); }
  /* RED, not green. Health is the bar you are being asked to panic about, and
     a green one sat in the same read as the ocean's own biolum greens — the
     one colour in this HUD that must never be mistaken for scenery.
     The gradient is SQUASHED with the fill rather than clipped by it — the
     column is scaled, not cropped — so the bright end stays at the top of
     whatever is left and even a sliver of health still reads as a lit cap
     instead of a dark smear at the bottom of the track. */
  .sv-pbar-hp { background: linear-gradient(180deg, #ff6a5a, #e01023);
    box-shadow: 0 0 10px rgba(255,45,60,0.75); }
  /* The halo hue, declared on the TRACK that holds each fill rather than on
     the fill itself — the shadow reading it is the track's. */
  #svHpWrap { --sv-glow-rgb: 255,70,80; }
  #svO2Wrap { --sv-glow-rgb: 120,210,255; }
  /* Air past the quarter mark is amber, so its halo goes amber with it, or a
     drowning seal would be rimmed in the blue that means "fine". */
  #svO2Wrap.sv-o2-low { --sv-glow-rgb: 255,170,60; }
  .sv-pbar-o2 { background: linear-gradient(180deg, #9fe4ff, #2f9fdd);
    box-shadow: 0 0 10px rgba(110,210,255,0.6); }
  /* AMBER, not red — and this is the reason the two gauges can sit side by
     side at all. Health is red now, so an air bar that also went red left the
     player with two identical red columns and no way to tell, at a glance in a
     fight, which of the two things about to kill them was which. Amber is the
     one warning colour this HUD was not already using. */
  .sv-pbar-o2.sv-o2-low { background: linear-gradient(180deg, #ffd166, #ff8a00);
    box-shadow: 0 0 12px rgba(255,160,40,0.9); }

  /* --- THE GRAIN, ON ALL THREE GAUGES ------------------------------------
     One field of noise, tiled over every track. The field itself, why it is
     shared with the fuel wheel around the seal, and what each knob does are
     all in systems/meterNoise.js; this is only how it lands on a bar.

     MULTIPLY, not an overlay of its own colour. What is wanted is the fill
     being EATEN — the same red, unevenly lit — and multiply is the one blend
     that can only ever take away, so no setting of it can invent a hue the
     gauge is not already wearing. It also leaves the empty track alone almost
     entirely: multiplying a near-black background by anything is still
     near-black, which is why the container survives at full depth.

     IT IS NOT ON THE FILL. The fill is a full-height element squashed by
     scaleY(--sv-fill), and a background on it would be squashed with it: the
     grain would stretch as the bar drained and be four times finer at the
     bottom of a bite than at the top — a texture that reports the value it is
     supposed to be decorating. On the track it is the same grain whatever the
     gauge reads, which is the same reasoning that keeps the glow off the fill.

     ONE SET OF VARIABLES, written to .sv-playerbars once a frame and inherited
     by all three overlays: three gauges wearing one field is the entire point,
     and three separate writes are three chances for them to disagree. */
  .sv-meter-grain { position: absolute; inset: 0; pointer-events: none;
    border-radius: inherit;
    background-image: var(--sv-grain-img, none);
    background-size: var(--sv-grain-size, 54px) var(--sv-grain-size, 54px);
    background-position: var(--sv-grain-x, 0px) var(--sv-grain-y, 0px);
    mix-blend-mode: multiply;
    /* 0 until there is a field to draw — a missing tile has to read as a
       plain bar, never as a black one. */
    opacity: var(--sv-grain-depth, 0); }

  /* --- THE BOOST FUEL, AS A COLUMN --------------------------------------
     settings.hud.boostMeter === 'bar'. The same pips the ring around the seal
     draws (systems/strikeRing.js), stood on end beside the air gauge — one
     model, one set of springs, one stagger queue, and only ever one of the two
     pictures on screen at a time. See pipAnim().

     WHAT DOES NOT MOVE WITH THEM: the drop of goo. Banked power is the thing
     the seal is holding and it grows out of the animal in both styles, which
     is why this column is the FUEL only and has no core, no lead-in and no
     tolerance band. Two quantities, and the one that answers "can I strike at
     all" is the one that reads fine in a corner.

     Hidden rather than not built — and it is the SHIPPED view now, so what is
     hidden by default is the other one. The wrap is a sibling of the two
     gauges so it inherits their placement, their track and their halo for
     free; a display toggle on a modifier class is the whole difference
     between the two settings, where building it on demand would mean the
     column arriving mid-run with no layout and no baseline. */
  /* Mint, the READY colour — the halo this column raises is "you can strike",
     which is a different sentence from health's red and air's blue. */
  .sv-boost-wrap { display: none; --sv-glow-rgb: 157,255,208; }
  .sv-playerbars-boost .sv-boost-wrap { display: block; }
  /* column-reverse so pip 0 is at the BOTTOM and the fuel climbs, which is the
     direction the other two gauges drain in read backwards. The 2px inset is
     the track's own rim showing round the pips, so a column with one pip lit
     still reads as a container that could hold more. */
  .sv-boost-pips { position: absolute; inset: 2px; display: flex;
    flex-direction: column-reverse; gap: 2px; }
  /* THE POP IS A SWELL AND A LIFT, exactly as it is on the ring: a pip landing
     widens and brightens rather than only brightening, because on a 9px cell
     brightness alone is a twinkle. --sv-pop is written per frame per cell from
     the same decaying array the shader reads. */
  .sv-boost-pip { position: relative; flex: 1 1 0; border-radius: 3px;
    background: rgba(255,255,255,0.07); overflow: hidden;
    transform: scaleX(calc(1 + 0.2 * var(--sv-pop, 0)));
    filter: brightness(calc(1 + 1.6 * var(--sv-pop, 0))); }
  /* SCALED, not sized, like every other fill in this HUD — and for the same
     reason there is no transition on it: the spring is already the animation
     (updatePips in systems/strikeRing.js), and a CSS curve chasing a moving
     value never arrives. --sv-pip-col is the pip's own place on the wheel's
     colour ramp, stamped when the count or the tuned colours change. */
  .sv-boost-fill { position: absolute; inset: 0; border-radius: 3px;
    background: var(--sv-pip-col, #7ad7ff);
    box-shadow: 0 0 7px var(--sv-pip-col, #7ad7ff);
    transform: scaleY(var(--sv-pip, 0)); transform-origin: 50% 100%; }
  /* THE SPEND FLASH. The bar blowing out white as it becomes a strike, which
     in the ring style is drawn on the wheel itself — the fuel has to be seen
     being spent wherever the fuel is. Over the pips rather than tinting them,
     so it whitens a half-full column and an empty one identically. */
  .sv-boost-spend { position: absolute; inset: 0; border-radius: inherit;
    background: #fff; opacity: var(--sv-spend, 0); pointer-events: none; }

  /* --- THE OTHER PLACEMENT: PINNED TO THE CORNER -------------------------
     settings.hud.barPlacement === 'corner'. The same two columns, the same
     fills and the same trail — only the anchor changes, which is the whole
     reason this is a modifier class and not a second widget. Two widgets
     drawing one quantity is how they end up disagreeing.

     FIXED, not absolute. .sv-hud is anchored at the top of the screen and is
     14px in from each edge, so an absolute child could never reach the bottom
     of the viewport. This works only because nothing above it in the tree
     carries a CSS filter or a transform — either would make that ancestor the
     containing block and quietly re-anchor these to it. .sv-hud-corner has
     exactly such a filter, which is why these bars are its SIBLING and not
     something tucked inside it.

     env() on both axes: on a phone held sideways the home indicator and the
     rounded corner both eat into precisely this corner, and 14px from the
     glass edge is behind them. The fallback in each calc is what a browser
     with no safe-area support (and every desktop) gets. */
  .sv-playerbars-corner { position: fixed; left: auto; top: auto;
    right: calc(14px + env(safe-area-inset-right, 0px));
    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
    transform: none; align-items: flex-end; gap: 7px; }
  /* THE COLUMN ORDER IS INHERITED, not restated. row-reverse puts health
     against the screen's right edge here and against the seal there, which is
     the same rule read twice — health is the one nearest whatever the gauges
     are attached to. A player who switches placements mid-session finds the
     two columns in the order they already learned.
     align-items: flex-end aligns their BOTTOMS, which matters as soon as the
     two have different lengths: they grow from one shared floor rather than
     floating at different heights. */

  /* HOW LONG THE COLUMNS ARE, and the one thing this placement does that the
     seal-side one cannot: the track GROWS.
     --sv-track is the base length, a quarter of the viewport's height. --sv-hp-
     grow and --sv-o2-grow are that gauge's maximum as a multiple of the
     maximum a run STARTS with, written per frame by updateHUD — so a seal that
     has doubled its health has a column twice as tall, climbing the side of
     the screen, and the upgrade is legible without a number anywhere.
     min() is the ceiling, in CSS rather than in JS on purpose: the limit is
     "how much screen is there", which is a question the stylesheet is already
     holding the answer to and JS would have to re-measure on every resize.
     72vh leaves the top of the screen to the boss bar even at full growth. */
  .sv-playerbars-corner { --sv-track: 25vh; --sv-track-max: 72vh; }
  /* THE EMPTY TRACK HAS TO BE VISIBLE HERE, which it does not beside the seal.
     Growing the column is only legible if the CEILING can be seen: a track
     that disappears into the water leaves a longer bar and a shorter one
     looking identical at the same fraction, and the upgrade this placement
     exists to show goes back to being invisible. A pale rim and a slightly
     lifted ground, both weak enough to stay out of the way of the fill. */
  .sv-playerbars-corner .sv-pbar-wrap { width: 13px; border-radius: 7px;
    background: rgba(8,13,24,0.5);
    /* ...ending in the halo, or restating the rim here deletes the glow. */
    box-shadow: 0 0 0 1px rgba(210,226,245,0.22), inset 0 0 8px rgba(0,0,0,0.6), var(--sv-halo); }
  .sv-playerbars-corner #svHpWrap {
    height: min(calc(var(--sv-track) * var(--sv-hp-grow, 1)), var(--sv-track-max)); }
  .sv-playerbars-corner #svO2Wrap {
    height: min(calc(var(--sv-track) * var(--sv-o2-grow, 1)), var(--sv-track-max)); }
  /* AND THE FUEL GROWS TOO, on its own quantity: the number of PIPS, not a
     maximum. A link cuts the bar into more segments (Coiled Spring, and every
     chain link after the first), and against a fixed-length column that shows
     up as thinner pips — the same instrument saying nothing about the fact
     that a strike now costs more to load. Growing the track keeps a pip the
     same size and makes the extra one visible as extra. */
  .sv-playerbars-corner #svBoostWrap {
    height: min(calc(var(--sv-track) * var(--sv-boost-grow, 1)), var(--sv-track-max)); }
  .sv-playerbars-corner .sv-pbar,
  .sv-playerbars-corner .sv-pbar-ghost { border-radius: 7px; }

  /* A SHORT SCREEN IS THE CASE THAT BREAKS THIS. A phone on its side is 393px
     tall, where a quarter of the viewport is 98px and a doubled health bar is
     already most of the way up the glass. The base shrinks and the ceiling
     comes down with it, so growth still reads as growth and still stops short
     of the boss bar. */
  @media (max-height: 560px) {
    .sv-playerbars-corner { --sv-track: 22vh; --sv-track-max: 58vh; }
  }

  /* THE COLLISION, and it is a real one. On a phone the score and the clock
     move to fixed bottom-right (see the responsive block below) — the exact
     corner these bars are asking for. Rather than moving the gauges somewhere
     they were not asked to be, the numbers step inboard by the width of the
     stack: two 13px columns and a 7px gap, plus the same 14px breathing room
     the corner already keeps from the edge. Applied to .sv-hud rather than to
     the bars, because the thing that moves is the other block. */
  .sv-hud-barcorner .sv-hud-corner { --sv-bars-w: 47px; }
  /* ...and 20px wider again with the fuel column standing beside them. */
  .sv-hud-barcorner.sv-hud-boostbar .sv-hud-corner { --sv-bars-w: 67px; }
  @media (max-width: 700px) {
    .sv-hud-barcorner .sv-hud-corner {
      right: calc(14px + var(--sv-bars-w, 0px) + env(safe-area-inset-right, 0px)); }
  }

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
  /* RELATIVE so the grain layer inside it has something to be inset:0 against.
     Without it the overlay would resolve against .sv-bossbar (which is
     positioned) and stretch the field across the boss's NAME as well — and
     since the track clips its own children, the fault would present as the
     grain simply being missing from the bar. */
  .sv-boss-track { position: relative; height: 9px; background: rgba(4,6,12,0.62); border-radius: 5px;
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

  /* --- THE PRINT, HELD UP ---------------------------------------------------
     A photograph in a fan is a thumbnail: at 120px on a phone there is no
     reading the boss's name off the chin, let alone deciding whether this is
     the one worth posting. Tapping one holds it up to the light — the FILE, at
     nearly the size of the screen, with the two things you would do with it
     underneath.

     OUTSIDE THE CARD, not inside a face. The faces are overflow:hidden on a
     slab that spends half a second rotated in 3D, so a viewer mounted in one
     would be clipped to the card and would turn over with it. This is a sheet
     over the whole menu, and the card carries on existing behind it.

     A SCRIM AND NOT A BACKDROP-FILTER. A blur here would look better for about
     one frame and then cost a full-screen filter pass on every frame the water
     behind this menu paints — on the one screen this change set exists to take
     work OFF. The card behind does not need to be legible; it needs to be
     clearly not the thing you are looking at, and a dark sheet says that. */
  .sv-shot-view { position: absolute; inset: 0; z-index: 8; display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    padding: 3vh 4vw; pointer-events: all;
    background: rgba(3,6,10,0.93); }
  /* The picture is the whole point, so it takes whatever the screen has left
     after the two rows and keeps its own shape. min-height:0 because a flex
     item will not shrink below its content otherwise and a 2000px-tall polaroid
     would push the buttons off the bottom of a phone. */
  .sv-shot-img { max-width: 100%; min-height: 0; flex: 0 1 auto;
    max-height: calc(100% - 96px); width: auto; height: auto; object-fit: contain;
    border-radius: 6px; box-shadow: 0 26px 60px rgba(0,0,0,0.7); }
  .sv-shot-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
  /* Top-right rather than in the row: the row is for the two things you came
     here to do, and a Close sitting beside Share is a third thing to read
     before either of them. */
  .sv-shot-close { position: absolute; top: 12px; right: 14px;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
    color: #e8ecf3; font: inherit; font-size: 15px; line-height: 1;
    width: 34px; height: 34px; border-radius: 50%; cursor: pointer; pointer-events: all; }
  .sv-shot-close:hover { background: rgba(255,255,255,0.16); }
  .sv-shot-close:focus-visible, .sv-shot-close.sv-nav-sel { outline: 2px solid #fff; outline-offset: 2px; }
  .sv-touch .sv-shot-close { width: 44px; height: 44px; }

  /* THE SCORECARD. The same five figures the shared image carries (see
     drawScorecard in systems/bossShot.js), but not as five equal chips any
     more.

     SCORE IS THE HEADLINE and the other four are the supporting read. Laid out
     flat, the five wrapped 3 + 2 on the card's own width — score, time and
     level on one line, kills and bosses orphaned under them — which reads as a
     row that broke rather than as a hierarchy. It also gave the number a player
     actually cares about exactly as much room as "Bosses: 0".
     So score gets its own line at display size, and the remaining four sit
     under it as ONE four-column grid: an explicit grid rather than a flex row,
     because equal columns are the whole point and four items sharing a line by
     luck is the layout that just broke.
     tabular-nums on every figure — these are numbers in columns, and a run
     that scores 111,111 must not be narrower than one that scores 100,000. */
  .sv-scorecard { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .sv-score-hero { display: flex; flex-direction: column; align-items: center; gap: 1px; }
  .sv-score-hero b { font-size: 40px; line-height: 1; font-weight: 700;
    letter-spacing: 0.01em; color: #e8ecf3; font-variant-numeric: tabular-nums; }
  .sv-score-hero span { font-size: 10px; letter-spacing: 0.16em;
    text-transform: uppercase; color: rgba(232,236,243,0.45); }
  /* Full width so the four columns are quarters of the card rather than
     quarters of whatever the four labels happened to measure. */
  .sv-stat-row { display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 4px; width: 100%; }
  .sv-stat { display: flex; flex-direction: column; align-items: center;
    min-width: 0; padding: 0 4px; font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: rgba(232,236,243,0.45); }
  .sv-stat b { font-size: 19px; font-weight: 700; letter-spacing: 0.01em;
    color: #e8ecf3; text-transform: none; font-variant-numeric: tabular-nums; }

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
     toast update loop, but it is an announcement rather than a number: it is
     pinned above the seal, only one is ever on screen (an extension re-uses
     the live node), and it holds for as long as the chain window does.
     ONE COLOUR, written inline from CONFIG.strike.foodChain.color, because the
     chain wheel it used to walk took the type through two unreadable stretches
     a lap over open water. Depth is the count, not the hue. That inline write
     is why textRoles.js marks this role inlineColor and typography.js emits no
     colour for it: two writers on one property, where one silently never wins,
     is a bug that costs an afternoon.
     min-width so the plate is ONE SIZE. The words are swapped for the STRIKE
     NOW! prompt mid-chain and back again, and a shrink-to-fit box would jump
     between two widths every time — on a plate the eye is using as a bar. */
  .sv-chain { position: absolute; font-size: 21px; font-weight: 800;
    letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap;
    text-align: center; min-width: 9.2em;
    text-shadow: 0 2px 6px rgba(0,0,0,0.95), 0 0 16px currentColor;
    pointer-events: none; transform: translate(-50%, -50%);
    will-change: transform, opacity; }
  /* em, not px: the ×N is a part of the banner rather than a thing with its
     own size, so it tracks whatever the Chain banner role is set to. */
  .sv-chain-x { font-size: 0.76em; margin-left: 7px; font-weight: 700;
    font-variant-numeric: tabular-nums; opacity: 0.9; }
  /* THE PROMPT WEARING THE BANNER. Same node, same plate, different sentence —
     and the flash is what separates an instruction from the announcement it is
     interrupting. --sv-chain-now is written per frame by updateToasts from the
     game's own clock, not a CSS animation, for the same reason every other
     motion here is: it has to stop when the game does.
     The words do NOT change colour. The edge does (see the strip), and giving
     the type its own hue as well would be the same word said twice — what says
     NOW here is the box lighting up around a line that has changed. */
  .sv-chain-now .sv-chain-word {
    filter: drop-shadow(0 0 calc(3px + 9px * var(--sv-chain-now, 0)) currentColor); }
  /* THE WINDOW, AS A STRIP UNDER THE WORDS.
     The chain lapses on a clock (CONFIG.strike.chainWindow, 2.2s) and the only
     thing that ever drew that clock was a thin arc outside the boost ring —
     on the seal, at the other end of the player's attention from the banner
     announcing the thing it is counting down. The banner says a chain is
     running; this says how long you have to keep it.
     A SLAB, not an outline: it doubles as the plate the type is read off, which
     is why the track is dark rather than a tinted version of the fill. Over
     bright water the words used to be carried entirely by their own shadow.
     em on every axis so the strip is sized by the Chain banner role, exactly
     like the ×N above it — the Text panel can double the type and the plate
     follows.
     z-index -1 puts it behind the words inside the banner's own stacking
     context. The banner carries a transform, so it already IS a stacking
     context and the negative index cannot escape it onto the layer below.
     No backticks anywhere in this block: the whole stylesheet is one template
     literal and a single one would end it. */
  .sv-chain-strip { position: absolute; left: -0.5em; right: -0.5em;
    top: -0.26em; bottom: -0.26em; z-index: -1; border-radius: 3px;
    background: rgba(6,10,16,0.62); overflow: hidden;
    /* THE PLATE DOES NOT FADE WITH THE FILL, and the version that did is worth
       writing down: tying its opacity to --sv-chain-left made the whole
       indicator dimmest at the moment it was most urgent, so a chain about to
       lapse showed almost nothing. The plate is the ground the type is read
       off and the ground does not move. What leaves is the BANNER, on the
       toast layer's own departure curve. */
    /* THREE SHADOWS, ONE PROPERTY, and they have to be stacked rather than
       written by three owners: the two glows and the edge are separate facts
       (a chain nearly out, a release due, and the plate having a rim at all)
       and CSS gives them one slot each in a single list.
         1  the rim. Always there, faintly, so the plate is a box.
         2  the neon rim, alpha driven by --sv-chain-now, in the prompt's own
            colour — --sv-chain-neon is an R,G,B triple written once when the
            banner is built, which is what lets rgba() take a calc alpha.
         3  the outer halo: the almost-empty blink in the banner's own colour,
            and the prompt's neon on top of it. Both can be lit at once — a
            chain can be about to lapse AND have a release due — and that
            reads correctly, as two urgencies rather than one overriding. */
    box-shadow:
      inset 0 0 0 1px rgba(255,255,255,0.12),
      inset 0 0 0 calc(1px + 2px * var(--sv-chain-now, 0)) rgba(var(--sv-chain-neon, 125,252,255), calc(0.95 * var(--sv-chain-now, 0))),
      inset 0 0 calc(10px * var(--sv-chain-now, 0)) rgba(var(--sv-chain-neon, 125,252,255), calc(0.5 * var(--sv-chain-now, 0))),
      0 0 calc(3px + 16px * var(--sv-chain-flash, 0)) currentColor,
      0 0 calc(var(--sv-chain-glow, 22px) * var(--sv-chain-now, 0)) rgba(var(--sv-chain-neon, 125,252,255), 0.95),
      0 0 calc(0.35 * var(--sv-chain-glow, 22px) * var(--sv-chain-now, 0)) rgba(255,255,255,calc(0.5 * var(--sv-chain-now, 0))); }
  /* THE FILL. transform, not width: a width animation relayouts the banner's
     box every frame and the type inside it reflows by a subpixel, which at this
     size reads as the words shimmering. transform-origin left, so it drains the
     way a timer does — the empty part is the time already spent.
     --sv-chain-left is written per frame by updateToasts. */
  .sv-chain-fill { position: absolute; inset: 0; transform-origin: left center;
    transform: scaleX(var(--sv-chain-left, 1));
    /* 0.32 AND NOT 0.5, and this is the number the whole banner's legibility
       turns on. The type is the same green as the fill, so a bold fill puts
       light green on mid green — and the state it ruins is a FULL window,
       which is most of every chain. Measured over the plate: 0.5 gives the
       words a contrast ratio of about 2.9 against the bar they sit on, and
       0.32 about 4.0. The drain still reads because what the eye is following
       is the EDGE between filled and empty, and an edge does not need a loud
       fill behind it. */
    background: currentColor; opacity: 0.32; }
  /* NEARLY OUT, and it washes the WHOLE plate rather than the remaining fill.
     That is the entire point of it: at a tenth of the window left there is a
     sliver of fill three pixels wide, and blinking three pixels is not a
     warning. The wash is full width, so the thing that flashes is the same size
     however little time is on it.
     A pseudo-element rather than a third node — --sv-chain-flash is a custom
     property and inherits, so it reaches here from the one place per frame that
     writes it, and nothing has to remember to keep a fourth element in step.
     It is driven from the game's own clock rather than a CSS animation, for the
     same reason the popups' motion is: it has to stop when the game does. */
  /* 0.26 AND NOT MORE, and the number was found by looking. At 0.42 the wash
     put the banner's own green behind the banner's own green type and the words
     went soft at exactly the moment they were being shouted — a warning that
     costs legibility is the opposite of this banner's whole job. The urgency it
     lost is paid back on the halo outside the plate, which is over water rather
     than over type and can be as loud as it likes. */
  .sv-chain-strip::after { content: ''; position: absolute; inset: 0;
    background: currentColor; opacity: calc(0.26 * var(--sv-chain-flash, 0)); }
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

  /* --- THE TURN ------------------------------------------------------------
     The card is a slab of glossy black emulsion with a face on each side: the
     run in front, what the recorder saw behind. See ui/cardFlip.js, which owns
     the angle and writes --sv-flip, --sv-grazing and --sv-sheen while it moves.

     A TAB WOULD HAVE BEEN CHEAPER and this is not that. The score screen is
     already a set of photographs dropped on a table; turning one over to read
     the numbers on the back is the same object rather than a second interface
     bolted to it.

     BOTH FACES ARE ABSOLUTE, so the card has no height of its own — showGameOver
     measures the taller of the two and writes it inline. Without that the card
     takes the front's height and overflow:hidden silently clips the last
     control off the bottom of the back, with no other symptom.

     No backticks anywhere in this stylesheet: it is a template literal, and one
     in a comment ends the string a hundred lines early. */
  .sv-flip-stage { perspective: 1500px; position: relative; }
  /* NOT .sv-card — that is the upgrade menu's hexagon, three hundred lines up,
     and a second rule under the same name set every one of them 460px wide and
     handed them a rotateY that beat their own hover scale. npm run layout found
     it as three pixels of overflow on one viewport, which is the whole argument
     for running it: a cascade collision does not announce itself, it just makes
     an unrelated screen slightly wrong. */
  .sv-flip-card {
    position: relative; transform-style: preserve-3d;
    transform: rotateY(var(--sv-flip, 0deg));
    max-height: 92vh; max-width: 90vw; width: 580px;
  }
  /* WILL-CHANGE ONLY WHILE IT IS TURNING, and this is a fix rather than a
     micro-optimisation. will-change:transform promotes the card to a
     composited layer and KEEPS it there, and the card is not a strip of text —
     it is a 580x940 slab holding the whole leaderboard and one live canvas per
     kill shot. Left promoted for the minutes somebody sits on this screen, that
     layer's rasterisation goes stale and comes back blank: the polaroids and
     the card itself render as empty rectangles after a few turns, with the box
     still there. Added by ui/cardFlip.js when a turn starts and taken off when
     it lands, which also forces the browser to re-rasterise the card at its
     resting size on the frame it stops moving. */
  .sv-flip-turning { will-change: transform; }
  /* The container box. .sv-menu's own look moved out here, because the thing
     that is a panel now is the FACE and not the card.

     NO backface-visibility HERE, and its absence is load-bearing. It was
     doing nothing the away face's own .sv-hidden was not already doing —
     ui/cardFlip.js applies that class for real at the halfway point of the
     turn (the pad's cursor depends on it, see gameOverControls) and
     .sv-hidden is display:none, so the far face is not rendered at all
     rather than merely turned away. What it DID do was force each face onto a
     permanent render surface of its own, every kill-shot canvas rasterised
     inside it, which is half of why this card went blank after a few turns.
     See .sv-flip-turning above for the other half. */
  .sv-face {
    position: absolute; inset: 0; overflow: hidden;
    background: var(--sv-emulsion, #07090d);
    border: 1px solid rgba(255,255,255,0.14); border-radius: 14px;
    color: #e8ecf3; text-align: center;
    box-shadow: 0 24px 50px rgba(0,0,0,0.62), 0 2px 0 rgba(255,255,255,0.05) inset;
  }
  .sv-face-back { transform: rotateY(180deg); }
  /* The scroll lives INSIDE the face, not on the card: a phone on its side
     cannot show either face whole, and a scroll on the card would move the
     rotation's own transform origin. */
  .sv-face-inner { height: 100%; overflow-y: auto; overscroll-behavior: contain; padding: 28px 32px; }
  /* THE EMULSION. One broad specular sweep, positioned from the flip angle and
     strongest when the card is tipped — a slab of gloss catches the light when
     it is edge-on and goes flat when it is square to you. Both custom
     properties come from ui/cardFlip.js; the fallbacks are the resting pose, so
     a card that never flips is still lit. */
  .sv-face::after {
    content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 3;
    background: linear-gradient(105deg,
      transparent calc(var(--sv-sheen, 94%) - 34%),
      rgba(255,255,255,0.015) calc(var(--sv-sheen, 94%) - 16%),
      rgba(190,230,255,0.16) var(--sv-sheen, 94%),
      rgba(255,255,255,0.02) calc(var(--sv-sheen, 94%) + 16%),
      transparent calc(var(--sv-sheen, 94%) + 34%));
    opacity: calc(0.45 + 0.55 * var(--sv-grazing, 0));
  }
  /* The bubbles off the leading edge, on ui/cardFlip.js's own canvas. Above the
     card rather than behind it: they are coming off the edge nearest the
     viewer. Alive only during a turn — the element is removed after it lands. */
  .sv-flip-bubbles { position: absolute; inset: 0; pointer-events: none; z-index: 6; }

  /* The control that turns it. Deliberately not a .sv-btn: it is a label on the
     card, in the way a caption is, rather than a fifth button competing with
     Try again. */
  .sv-turn {
    pointer-events: all; background: none; border: 0; cursor: pointer; font: inherit;
    color: #7ad7ff; font-size: 11px; font-weight: 600; letter-spacing: 0.13em;
    text-transform: uppercase; padding: 10px 6px;
    display: inline-flex; align-items: center; gap: 7px;
  }
  .sv-turn:hover { color: #cfeeff; }
  .sv-turn:focus-visible, .sv-turn.sv-nav-sel { outline: 2px solid #fff; outline-offset: 1px; border-radius: 4px; }
  .sv-turn svg { flex: none; }

  .sv-back-title {
    font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
    color: rgba(232,236,243,0.45); margin-bottom: 12px;
  }

  /* --- THE BREAKDOWN ROWS ---------------------------------------------------
     Weapons and threats are the same grid deliberately: they are the same
     question asked in both directions, and two layouts would read as two
     unrelated tables rather than as a ledger with two sides.

     THE SHARE IS THE ROW'S OWN BACKGROUND rather than a column of its own. The
     card is 580px at most and every column added to this grid comes out of the
     name, which is the part a player is actually reading — so the bar is drawn
     behind the row, width set inline from the share, and it costs nothing.
     The children need position: relative or the bar paints over them. */
  .sv-brk { display: flex; flex-direction: column; gap: 1px; }
  .sv-brk-head { display: grid; grid-template-columns: 1fr 58px 34px; gap: 8px;
    padding: 0 8px 6px; font-size: 9.5px; letter-spacing: 0.14em;
    text-transform: uppercase; color: rgba(232,236,243,0.35); }
  .sv-brk-head span + span { text-align: right; }
  .sv-brk-row { position: relative; display: grid; grid-template-columns: 1fr 58px 34px;
    gap: 8px; align-items: center; padding: 5px 8px; border-radius: 6px; font-size: 12px; }
  .sv-brk-row:nth-child(even) { background: rgba(255,255,255,0.03); }
  .sv-brk-row::before { content: ""; position: absolute; inset: 0; border-radius: 6px;
    width: var(--sv-share, 0%);
    background: linear-gradient(90deg, rgba(122,215,255,0.30), rgba(122,215,255,0.06)); }
  /* The incoming side runs in the kicker's red — the same red the polaroid
     says "defeated" in, which is the colour this game uses for damage that
     was done TO something. */
  .sv-brk-row.sv-brk-in::before {
    background: linear-gradient(90deg, rgba(255,120,120,0.28), rgba(255,120,120,0.05)); }
  .sv-brk-row > * { position: relative; }
  /* min-width:0 is load-bearing here for the same reason it is on a
     leaderboard row: without it a long name refuses to shrink and pushes the
     two number columns off the end instead of ellipsing. */
  .sv-brk-name { min-width: 0; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .sv-brk-picks { font-size: 10px; font-weight: 500; margin-left: 6px;
    color: rgba(232,236,243,0.40); }
  .sv-brk-a { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
  .sv-brk-b { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums;
    color: rgba(232,236,243,0.45); }
  .sv-brk-tag { display: inline-block; margin-left: 6px; padding: 0 4px;
    border: 1px solid rgba(255,120,120,0.4); border-radius: 3px;
    color: #ff7878; font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; vertical-align: 1px; }
  .sv-brk-foot { margin-top: 10px; padding-top: 9px; display: flex; gap: 12px;
    justify-content: space-between; font-size: 11px;
    border-top: 1px solid rgba(255,255,255,0.08); color: rgba(232,236,243,0.45); }
  .sv-brk-foot b { color: #e8ecf3; font-variant-numeric: tabular-nums; }
  .sv-brk-empty { font-size: 12px; color: rgba(232,236,243,0.4); padding: 10px 8px; }

  .sv-leaderboard { margin: 14px 0; max-height: 220px; overflow-y: auto; text-align: left; }
  /* ONE GRID FOR THE HEADER AND THE ROWS, so the columns are the same columns
     on both. A flex row plus a flex header is two independent layouts that
     agree only while nobody touches either of them. */
  .sv-lb-row, .sv-lb-head {
    display: grid; grid-template-columns: 3ch minmax(0, 1fr) auto 3ch 4ch;
    align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px; font-size: 12px; }
  /* Striped from inside the rows' own wrapper rather than off .sv-leaderboard,
     which also holds the caption and the header — a positional stripe counted
     from there flips every row the moment a line is added above them. */
  .sv-lb-rows .sv-lb-row:nth-child(even) { background: rgba(255,255,255,0.03); }
  .sv-lb-row.sv-lb-mine { background: rgba(122,215,255,0.14); border: 1px solid rgba(122,215,255,0.4); }
  /* THE COLUMNS ARE NAMED ONCE, at the top, instead of on every row. "Lv15"
     was a label repeated a hundred times to explain a number that is the same
     number in every row — and on a card this wide it was two of the characters
     the name column could not spare. Sticky, so the fifteenth row is still
     reading against its own headings.
     Its background is the face's, not a translucent tint: rows scroll UNDER
     it, and anything less than opaque shows them through it. */
  .sv-lb-head { position: sticky; top: 0; z-index: 1;
    padding-top: 2px; padding-bottom: 4px; font-size: 9.5px; letter-spacing: 0.14em;
    text-transform: uppercase; color: rgba(232,236,243,0.35);
    background: var(--sv-lb-head-bg, #07090d); }
  /* Score, Lv and Time head right-aligned columns, so their headings are too.
     By position rather than by re-using the cells' own classes: those carry a
     weight, a colour and a size of their own, and a header wearing them would
     be five different treatments in one line. */
  .sv-lb-head span:nth-child(n+3) { text-align: right; }
  /* The same board on the main menu's own surface, whose panel is not the
     card's black emulsion — the sticky heading has to be opaque against
     whatever it is actually sitting on, and .sv-menu is its own colour. */
  #svBoardList { --sv-lb-head-bg: #0d1018; }
  /* THREE DIGITS, IN CH AND NOT PIXELS. The board goes to 100 now, and 18px
     held "100" in Inter and in nothing else — the font picker can put 'Press
     Start 2P' in this column, a full em per glyph, where three digits want
     36px and the rank would have been clipped into a two-digit one. The ch
     unit is the width of a zero in whatever family is live, and it is the only
     one that means "three digits" rather than "however wide three digits
     happen to be in the font I had open". tabular-nums so 100 and 111 measure
     the same. (No backtick around the unit: this block is a template literal,
     and one would end the stylesheet mid-sentence.) */
  .sv-lb-rank { width: 3ch; color: rgba(232,236,243,0.5); font-weight: 600;
    font-variant-numeric: tabular-nums; }
  /* min-width:0 is load-bearing: a flex item defaults to min-width:auto, which
     refuses to shrink below its content — so without it a long name pushes the
     score and time out of the row instead of ellipsing, which is exactly what
     a 24-character name does. */
  .sv-lb-name { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-lb-score { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  /* Level and time as two columns of their own rather than one "Lv15 · 4:15"
     string right-aligned as a block: as one string the level's digits push the
     clock about, and the middle dot was doing the job the header now does. In
     ch, for the reason the rank is — the font picker decides how wide a digit
     is here (see the .sv-lb-rank note). */
  .sv-lb-lv, .sv-lb-time { color: rgba(232,236,243,0.5); font-size: 11px;
    font-variant-numeric: tabular-nums; text-align: right; }
  .sv-lb-empty { font-size: 12px; color: rgba(232,236,243,0.4); padding: 6px 8px; }

  /* Name entry. The row is a single control: text field plus its submit
     button, sized so the two read as one unit rather than a form. */
  .sv-name-row { display: flex; gap: 8px; justify-content: center; margin: 14px 0 4px; }
  /* THE FIELD TAKES THE WHOLE LINE when what is in it cannot be shown beside
     the button at a size worth reading — fitNameField puts this class on, and
     only then. The row is a field plus its Submit, and they read as one
     control while they fit on one line; a full-length name in a pixel font
     does not, and the choice at that point is between a name in 7px type and
     a button on its own line. The button is fine on its own line.
     Not a media query: this is a question about the LENGTH of what has been
     typed in whatever family is live, which no viewport knows the answer to. */
  .sv-name-row.sv-name-stacked { flex-direction: column; align-items: stretch; }
  .sv-name-row.sv-name-stacked .sv-name-input { max-width: none; }
  /* THE WIDTH IS NOT WHAT MAKES A FULL NAME VISIBLE — fitNameField is. This
     was sized in pixels against 24 characters of Inter, which held right up
     until the font picker existed: 'Press Start 2P' is a full em per glyph and
     ran out of room around character 20, with the tail of your own name
     scrolled out of the box while you typed it. There is no px width that is
     correct for every family the picker can land on, so the field measures
     what is in it and steps its type size down until the whole name fits (see
     fitNameField). This rule is the RESTING look: the size a short name is
     shown at.
     max-width caps it at the card's own content width — the row is the field
     plus its Submit button, and past this the button is what gets pushed. */
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

  /* THE SCORE CARD SCROLLS SOONER THAN THE REST, because it is taller than the
     rest and it keeps growing. The block above is 560px — a phone held
     sideways — and at 667px (an iPhone SE, upright) every other menu in the
     game has room to spare while this one does not: title, three tabs, a
     panel, a rack of prints with four buttons under it, a name row, a status
     line, a leaderboard and "Try again". Adding the tip jar under that button
     put it 9px past the bottom of that screen, measured by npm run layout.

     Scoped to this surface and to overflow only — no padding change, so the
     card looks the same as it always did on the screens where it already fit.
     A scroll rather than a squeeze, for the reason the block above gives: the
     alternative is deciding which part of their own run the player on the
     smallest phone is not allowed to see. */
  /* The scroll lives on .sv-face-inner at every size now, because the card is
     two absolutely-positioned faces and the taller of them decides the height —
     see the .sv-card block. What is left here is the CAP: below this the card
     is allowed to be shorter than its content and let the face scroll. */
  @media (max-height: 720px) {
    #svGameOverMenu .sv-flip-card { max-height: 92vh; }
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
  /* The turn control is not a .sv-btn — it is a label on the card rather than a
     fifth button — so it inherits none of the rule above and came out under the
     minimum, which npm run layout reports. Worth stating because it is the one
     control on this card that a player has to find twice. */
  .sv-touch .sv-turn { min-height: 44px; padding-top: 14px; padding-bottom: 14px; }
  /* A row of buttons that wraps needs the gap a thumb needs, not the gap an
     eye needs — two 44px targets 8px apart are one 96px target as far as a
     mis-tap is concerned. */
  .sv-touch .sv-trophy-row, .sv-touch .sv-name-row { gap: 12px; }
`;

export function initUI({ onStart, onRestart, onLevelChoice, onResume, onPauseRestart, onSplash, onMenu }) {
  callbacks = { onStart, onRestart, onLevelChoice, onSplash, onMenu };

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
        <!-- The grain, before the label: every meter in this HUD wears the same
             field, and the one thing it must not eat into is type. -->
        <i class="sv-meter-grain"></i>
        <div class="sv-xptop-level"><span class="sv-xptop-word">Level</span><span class="sv-xptop-abbr">Lv</span><span id="svLevel">1</span></div>
      </div>
      <!-- The ghost comes FIRST in each track and the fill second: both are
           inset:0 absolute, so paint order is DOM order and the trail has to
           be behind the value it is trailing. -->
      <div class="sv-playerbars" id="svPlayerBars">
        <!-- THE GRAIN IS THE LAST CHILD OF EACH TRACK, and has to be: it blends
             with what is painted UNDER it, so anything added below would be
             drawn over the grain instead of through it. -->
        <div class="sv-pbar-wrap" id="svHpWrap">
          <div class="sv-pbar-ghost" id="svHpGhost"></div>
          <div class="sv-pbar sv-pbar-hp" id="svHpBar"></div>
          <i class="sv-meter-grain"></i>
        </div>
        <div class="sv-pbar-wrap" id="svO2Wrap">
          <div class="sv-pbar-ghost" id="svO2Ghost"></div>
          <div class="sv-pbar sv-pbar-o2" id="svO2Bar"></div>
          <i class="sv-meter-grain"></i>
        </div>
        <!-- THE BOOST FUEL, when the player has asked for it as a column
             (settings.hud.boostMeter === 'bar'). Outboard of the air, so the
             three gauges read health-air-fuel outward from whatever they are
             attached to. Empty in the markup: the pips are built from the
             count, which moves mid-run as links land. -->
        <div class="sv-pbar-wrap sv-boost-wrap" id="svBoostWrap">
          <div class="sv-boost-pips" id="svBoostPips"></div>
          <i class="sv-meter-grain"></i>
          <div class="sv-boost-spend" id="svBoostSpend"></div>
        </div>
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
      <div class="sv-boss-track"><div class="sv-boss-fill" id="svBossFill"></div><i class="sv-meter-grain"></i></div>
    </div>

    <div class="sv-center sv-hidden" id="svLevelUpMenu">
      <div class="sv-menu" id="svLevelUpBox">
        <div class="sv-title">Level up</div>
        <div class="sv-sub">Pick one</div>
        <div class="sv-cards" id="svCards"></div>
      </div>
    </div>

    <div class="sv-center sv-hidden" id="svGameOverMenu">
      <div class="sv-flip-stage" id="svFlipStage">
        <div class="sv-flip-card" id="svCard">

          <!-- THE FRONT. The screen the game has always ended on. -->
          <div class="sv-face sv-face-front" id="svFaceFront">
            <div class="sv-face-inner">
              <div class="sv-title" id="svGameOverTitle">You Died!</div>
              <div class="sv-sub" id="svGameOverStats"></div>
              <!-- THE ROLL. Every kill shot from the run, fanned out like prints
                   dropped on a table — the same paper the player watched come out
                   of the camera during the fight (ui/snapshotPrint.js builds
                   both). Hidden unless a boss actually went down: an empty rack
                   on the score screen of a run that never met one reads as a
                   broken image. See systems/bossShot.js. -->
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
              <button class="sv-turn" id="svTurnOver">
                Turn it over
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1 5h8M6 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="sv-name-row" id="svNameRow">
                <input class="sv-name-input" id="svNameInput" type="text" maxlength="${MAX_NAME_LEN}"
                       placeholder="Your name" autocomplete="off" autocapitalize="characters"
                       spellcheck="false" aria-label="Name for the leaderboard" />
                <button class="sv-btn sv-btn-sm" id="svNameSubmit">Submit</button>
              </div>
              <div class="sv-status" id="svLbStatus"></div>
              <div class="sv-leaderboard" id="svLeaderboard"></div>
              <button class="sv-btn" id="svRestartBtn">Try again</button>
              <div class="sv-tip-row" id="svTipRow"></div>
            </div>
          </div>

          <!-- THE BACK. What the playtest recorder saw, filled per death by
               renderRunDetail. Starts hidden with .sv-hidden and not merely
               rotated away: backface-visibility hides a face from the eye and
               from nothing else, and the pad's cursor filters on that class —
               see ui/cardFlip.js. -->
          <div class="sv-face sv-face-back sv-hidden" id="svFaceBack">
            <div class="sv-face-inner">
              <div class="sv-back-title" id="svBackTitle">The run</div>
              <div id="svPanelWeapons"></div>
              <div id="svPanelThreats" style="padding-top:14px"></div>
              <button class="sv-turn" id="svTurnBack">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M9 5H1M4 2L1 5l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Turn back
              </button>
            </div>
          </div>

        </div>
      </div>

      <!-- THE PRINT HELD UP TO THE LIGHT. A sheet over the whole menu rather
           than anything inside the card: the faces clip their contents and turn
           over, and this must do neither. Empty until a photograph in the fan
           is tapped — see openShotView. -->
      <div class="sv-shot-view sv-hidden" id="svShotView">
        <img class="sv-shot-img" id="svShotImg" alt="" />
        <div class="sv-shot-row">
          <button class="sv-btn sv-btn-sm" id="svShotShare">Share this one</button>
          <button class="sv-btn sv-btn-sm" id="svShotSave">Save this one</button>
        </div>
        <div class="sv-status" id="svShotStatus"></div>
        <button class="sv-shot-close" id="svShotClose" aria-label="Close the preview">&#10005;</button>
      </div>
    </div>

    <div class="sv-transition sv-hidden" id="svTransition"></div>
  `;
  document.body.appendChild(root);

  for (const id of [
    'svHud', 'svHpBar', 'svO2Bar', 'svXpBar', 'svLevel', 'svTime', 'svScore',
    'svHpGhost', 'svO2Ghost', 'svHpWrap', 'svO2Wrap', 'svBoostWrap', 'svBoostPips', 'svBoostSpend',
    'svLevelUpMenu', 'svLevelUpBox', 'svGameOverMenu', 'svCards', 'svGameOverStats',
    'svLeaderboard', 'svPlayerBars', 'svToastLayer',
    'svBossBar', 'svBossName', 'svBossFill',
    'svCorner',
    'svNameRow', 'svNameInput', 'svNameSubmit', 'svLbStatus', 'svTransition',
    'svFan', 'svSheetShare', 'svSheetSave',
    'svFlipStage', 'svCard', 'svFaceFront', 'svFaceBack',
    'svTurnOver', 'svTurnBack', 'svBackTitle',
    'svPanelWeapons', 'svPanelThreats',
    // Try again is the one control on the score card that has to work — it is
    // the way back into the game. It was reached only through its click
    // binding until the pad needed to find it by name.
    'svGameOverTitle', 'svRestartBtn',
    'svTrophy', 'svTrophyShare', 'svTrophySave', 'svTrophyStatus',
    'svShotView', 'svShotImg', 'svShotShare', 'svShotSave', 'svShotStatus', 'svShotClose',
    'svTipRow',
  ]) {
    el[id] = document.getElementById(id);
  }

  // The score card's tip jar, built rather than written into the markup above
  // so the link, its look and where it points live in one file — see
  // ui/tipJar.js. Held on `el` because the pad has to be able to reach it:
  // gameOverAll() is a list of elements, not a query.
  el.svTipJar = tipJarLink({
    id: 'svTipJar',
    onHover: () => feedback('uiHover'),
    onClick: () => feedback('uiClick'),
  });
  el.svTipRow.appendChild(el.svTipJar);

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

  // The two turn controls. Bound here rather than from showGameOver: they are
  // part of the card's markup and never change, unlike the trophy row, which
  // only exists on a run that met a boss.
  bindTurn();
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
    // After the sanitiser, so the size is measured against what is actually in
    // the box rather than against a character that is about to be dropped.
    fitNameField();
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

// Boot entry point, and the ONLY caller of the Rive card.
//
// The card is the NAME SCREEN. It used to be the whole front end — dismissing
// it started a run — and it now hands over to the 3D menu instead (see
// leaveSplash below, and systems/mainMenu.js). That split is the point: a name
// is asked for once per page load, and the menu is where you come back to.
//
// The DOM start menu that used to live here is GONE. It was the boot screen
// once, and then a wall of instructions on a button nobody pressed; everything
// it explained is taught in the water now, at the moment it matters, by
// systems/tutorial.js. The menu's three hexes are Play, Options and
// Leaderboard, and there is no fourth screen behind any of them.
export function showStartMenu() {
  el.svHud.classList.add('sv-hidden');
  el.svLevelUpMenu.classList.add('sv-hidden');
  el.svGameOverMenu.classList.add('sv-hidden');

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
      // still moves the player on instead of stranding them on a blank screen
      // with no way forward. It lands on the MENU now rather than in a run —
      // see leaveSplash, and the note above showStartMenu.
      onDismiss: leaveSplash,
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
  // for — go straight through to the menu. Audio comes up on the player's first
  // input; see unlockAudio.
  //
  // REDUCED MOTION LOSES THE NAME SCREEN, not the name: playerName() answers
  // "Seal" for anybody who has never typed one, and the field is reachable
  // again from the score card at the end of a run.
  leaveSplash();
}

/**
 * WHERE THE NAME SCREEN LETS OUT. The Rive card is the name entry and nothing
 * more now — dismissing it used to begin a run, and it hands over to the 3D
 * menu instead (systems/mainMenu.js, mounted by main.js because it needs the
 * renderer).
 *
 * `onMenu` is optional and the fall-through is the old behaviour, which is what
 * keeps every harness that boots this module with four callbacks working, and
 * what keeps a build with no menu wired startable rather than stranded.
 *
 * THE SPLASH IS NOT PART OF THE LOOP. `splashPlayed` latches on the first
 * mount, so anything that comes back through showStartMenu later in the same
 * page lands here directly and the player is never asked for their name twice.
 * Only a reload puts the card back up.
 */
function leaveSplash() {
  if (callbacks.onMenu) {
    callbacks.onMenu();
    return;
  }
  beginRun();
}

// ---------------------------------------------------------------------------
// THE LEADERBOARD, BEFORE A RUN RATHER THAN AFTER ONE.
//
// The board has only ever existed as a panel inside the score card, which means
// it could only be looked at by dying — the one moment a player is least
// interested in a table. The main menu asks for it as a destination, so this is
// the same board on its own surface.
//
// SAME RENDERER, deliberately: renderBoard paints whichever element it is
// handed (see its note). A second implementation would drift from the one that
// actually receives a posted score, and the two would disagree about the
// spelling of somebody's name or the shape of a row.
//
// LOCAL FIRST, THEN GLOBAL. `loadLeaderboard()` is on this device and answers
// instantly; the global board is a network round trip that may never come back.
// Painting the local one first means the panel is never blank, and the global
// one replaces it in place when it lands — the same order showGameOver uses.
//
// A TOKEN GUARDS THE LATE ARRIVAL. Closing the panel and re-opening it starts a
// second fetch, and the first one landing afterwards would paint a board that
// was already replaced.
let boardPanel = null;
let boardList = null;
let boardToken = 0;

function buildLeaderboardPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'sv-center sv-hidden';
  wrap.id = 'svBoardPanel';
  wrap.innerHTML = `
    <div class="sv-menu">
      <div class="sv-title">Leaderboard</div>
      <div class="sv-leaderboard" id="svBoardList"></div>
      <button class="sv-btn" id="svBoardBack" type="button">Back</button>
    </div>
  `;
  root.appendChild(wrap);
  boardList = wrap.querySelector('#svBoardList');
  bindMenuSounds(wrap.querySelector('#svBoardBack'))
    .addEventListener('click', hideLeaderboard);
  return wrap;
}

export function showLeaderboard() {
  if (!root) return;
  if (!boardPanel) boardPanel = buildLeaderboardPanel();
  boardPanel.classList.remove('sv-hidden');

  const token = ++boardToken;
  renderBoard(loadLeaderboard(), { global: false }, boardList);
  if (isGlobal()) {
    fetchGlobalBoard()
      .then((list) => {
        if (list && token === boardToken) renderBoard(list, { global: true }, boardList);
      })
      // Silent on purpose: the local board is already on screen and correct.
      // An error banner over a working table would describe a failure the
      // player has no way to act on.
      .catch(() => {});
  }
}

export function hideLeaderboard() {
  // The token moves on, so a fetch still in flight cannot paint a closed panel
  // and then have its rows appear on the next open.
  boardToken++;
  boardPanel?.classList.add('sv-hidden');
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
  // The seal's gauges are smoothed now, and smoothing carries state across the
  // gap between runs — see resetPlayerBars. This is the one place every route
  // into a run passes through.
  resetPlayerBars();
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
  // Restarting from inside the pause menu is a real route (its own button), so
  // this has to take the menu down with everything else — otherwise the new
  // run opens with the settings panel still sitting over it.
  hidePauseMenu();
  // Same for the board: the main menu's Play button is reachable behind it (it
  // is a 3D button on the canvas, and this panel is a DOM overlay), so a run
  // can begin with the table still up.
  hideLeaderboard();
  cancelReveal('upgrades');
  clearMask(el.svLevelUpMenu, el.svLevelUpBox);
  setMenuLocked(false);
  el.svLevelUpMenu.classList.add('sv-hidden');
  el.svGameOverMenu.classList.add('sv-hidden');
  // The turn goes with the card. Its loop keeps running while there are
  // bubbles left, and a run that restarts mid-flip would otherwise leave a
  // canvas and a rAF alive over the new run — see releaseCardFlip.
  releaseCardFlip();
  // And the print that was being held up. It is a sheet over the MENU rather
  // than a child of the card, so hiding the menu takes it off screen — but it
  // would still be holding a decoded 1600x2000 bitmap and would still be the
  // thing the pad's cursor was routed to, into the next run.
  closeShotView();
  unwatchCardSize();
  flip = null;
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
  // BOTH FACES, in reading order, because the card can be either way up and
  // the filter below is what decides which half is live. Every control on the
  // face that is currently away sits inside a .sv-hidden face — applied for
  // real by ui/cardFlip.js at the halfway point of the turn, and not merely
  // rotated out of sight, precisely so this filter keeps working.
  //
  // gameOverAll() is a list of elements, not a query.
  return [el.svTrophyShare, el.svTrophySave, el.svSheetShare, el.svSheetSave,
    el.svTurnOver, el.svNameSubmit, el.svRestartBtn, el.svTipJar,
    el.svTurnBack,
    // The preview sheet's own three. In this list rather than beside it so the
    // highlight is cleaned up with everything else when the card goes away —
    // see the note above about working from the unfiltered list.
    el.svShotShare, el.svShotSave, el.svShotClose].filter(Boolean);
}

function gameOverControls() {
  // A disabled button and one inside a hidden block are both unreachable for a
  // mouse, so neither may be a stop for the pad either — a cursor that lands
  // on something invisible is a cursor that has vanished.
  const live = gameOverAll().filter((c) => !c.disabled && !c.closest('.sv-hidden'));
  // WHILE A PRINT IS HELD UP, THE SHEET OWNS THE PAD. Everything on the card is
  // still in the layout and still passes the filter above — the sheet is drawn
  // over it rather than replacing it — so without this the cursor walks onto
  // buttons behind a backdrop, and a confirm presses one nobody can see.
  if (shotViewOpen()) return live.filter((c) => el.svShotView.contains(c));
  return live;
}

// The name FIELD is deliberately not in that list. A pad cannot type, so a
// cursor stop there would be a dead end with no way to see it was one — the
// field stays a keyboard and touch control, and Submit (which is in the list)
// posts whatever is in it.
function selectGameOver(i, controls) {
  const previous = overIndex;
  overIndex = Math.max(0, Math.min(controls.length - 1, i));
  if (previous !== overIndex) feedback('uiHover');
  // CLEARED ACROSS EVERY CONTROL ON THE CARD, not just the ones in this list.
  // The list SHRINKS — the far face's controls leave it on a turn, and all of
  // them leave it while a print is held up — and a highlight cleared only
  // within the new list is a button still lit behind a backdrop, which is also
  // the first thing `#svGameOverMenu .sv-nav-sel` finds.
  for (const c of gameOverAll()) c.classList.toggle('sv-nav-sel', c === controls[overIndex]);
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
  // THE CARD OWNS THE PAD WHILE IT IS TURNING. Half of the controls are
  // rotating out of view and the other half have not arrived, so a cursor step
  // lands somewhere that is about to be somewhere else and a confirm presses a
  // button the player can no longer see. It is a quarter of a second, and
  // returning true keeps the score screen owning the pad through it rather
  // than handing it to whatever is under this one.
  if (cardFlipMoving()) return true;

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

/**
 * The inverse: a point in CSS pixels back to the world, on the z = 0 plane the
 * whole game is played on.
 *
 * EXACT rather than approximate, and only because the camera is orthographic
 * and unrotated (see createWorld) — unprojecting an NDC point gives a ray, and
 * with no perspective and no tilt every point on that ray shares the x and y
 * this returns. A rotated or perspective camera would need the ray intersected
 * with the plane; there is deliberately no such code here, because there is no
 * such camera.
 *
 * It exists for the one tip that stands beside a piece of UI rather than beside
 * something in the water — the hive in the corner. Everything the callout layer
 * draws is positioned FROM a world point (see drawWorld in ui/callout.js), so
 * the honest way to point at a rectangle on the glass is to say where in the
 * water that rectangle is, rather than to give the tip a second code path.
 */
export function screenToWorld(camera, px, py, out = { x: 0, y: 0 }) {
  PROJECT_V.set(
    (px / window.innerWidth) * 2 - 1,
    -((py / window.innerHeight) * 2 - 1),
    0,
  );
  PROJECT_V.unproject(camera);
  out.x = PROJECT_V.x;
  out.y = PROJECT_V.y;
  return out;
}

const PROJECT_V = new THREE.Vector3();
const screenPt = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// THE SEAL'S TWO GAUGES — how they MOVE.
//
// Health and air used to be written straight to the bar every frame, so both
// jumped: a bite arrived as an instant step down and there was nothing on
// screen to say how big it had been. Every value the player reads here is now
// chased rather than assigned, and the chase lives in JS because the target is
// itself moving every frame — a CSS transition over a moving value never
// arrives (see the note on .sv-pbar, and the same lesson in the boss bar's
// arrival). One curve, in one place.
//
// Rates are PER SECOND and applied as `1 - exp(-rate * dt)`, not as a fixed
// fraction per frame: the same lerp written per-frame runs twice as fast on a
// 120Hz screen as on a 60Hz one, which would make the bar's whole character a
// property of the player's monitor.
const PBAR_SMOOTH = {
  // The fill. Slow enough to be a MOVEMENT rather than a step — a big bite
  // takes about four tenths of a second to finish draining, and no single
  // frame of it moves the bar more than a few percent — and fast enough that
  // the bar is honest again well before the next hit lands.
  fall: 7,
  // Gains are chased harder than losses. Picking up a heal should feel like it
  // landed the moment you touched it; only the LOSS needs time on screen.
  rise: 16,
  // The trail: the pale band left standing above the fill, which is the size
  // of the bite you just took. Slow on purpose — this is the number that
  // decides how long "you were just hit for THAT much" stays legible.
  ghostFall: 2.0,
  // ...but the trail never lags a GAIN, or a heal would show as a pale band
  // that looks like damage until it caught up.
  ghostRise: 26,
  // Where the alarm starts fading in, as a fraction of the bar, and how fast
  // it breathes once it is there.
  alarmAt: 0.34,
  alarmHz: 2.1,

  // --- THE GLOW, which is a SECOND stage and not a louder first one --------
  //
  // `alarmAt` is "getting low": the column breathes, and a player who is busy
  // is allowed to keep being busy. The glow below is the other end of the same
  // sentence, and it says two different things depending on which way the
  // needle is moving:
  //
  //   CRITICAL   under `criticalAt` of the bar, the gauge burns. This is
  //              deliberately well below the breathing alarm — a warning that
  //              starts at a third of the bar and a warning that starts at a
  //              seventh cannot be the same warning, and running them at one
  //              threshold means the loud one is on for most of a bad fight
  //              and stops meaning anything.
  //   SURGE      it is FILLING, by enough to be worth looking at. Air coming
  //              back from a bubble or a breach, or a heal big enough to
  //              change what you would do next.
  //
  // ONE channel out of the two (`--sv-glow` is their max), because they never
  // want to be told apart: both mean "look at this gauge NOW", and a critical
  // bar that is being refilled is exactly when the player most wants the glow,
  // not a moment when two effects should be fighting over the same pixels.
  criticalAt: 0.15,

  // WHAT COUNTS AS A SURGE, and the two gauges are asked different questions
  // because they ARE different questions.
  //
  //   hp  a chunk of at least `surgeAt` of the bar still on its way. Not a
  //       running total of gains: health can also trickle back from a passive,
  //       and any accumulator large enough to catch a real heal eventually
  //       adds a 2%-a-second drip up to the same number and flashes for it.
  //       The gap between where the bar IS and where it is HEADED is the
  //       honest measure of "how big is the heal being lerped right now" —
  //       a chunk opens the gap wide in one frame, and a drip never opens it
  //       at all because the chase keeps up with it.
  //   o2  any rise at all. Air comes back exactly two ways, a bubble and a
  //       breach, and both are worth showing — so the test is simply whether
  //       the tank is filling. Phrased as the direction rather than as a small
  //       threshold on purpose: a breach refills at a rate the chase very
  //       nearly keeps up with, leaving a gap of about 0.02 of the bar, so any
  //       threshold low enough to catch a breach today is one retune of
  //       `oxygenRefillRate` away from silently missing it.
  surgeAt: { hp: 0.15 },
  // Once the gain stops. Slow enough that a bubble popped in a scrap is still
  // glowing when the eye gets there — a surge that lasted only while the value
  // was literally moving would be a two-frame flicker for an instant pickup.
  surgeFall: 2.4,
};

// Displayed values, which are NOT the game's values — see above. Seeded on the
// first frame of a run by resetPlayerBars so a new seal doesn't have to lerp up
// from the last one's dying health. `clock` is the wave's own phase, and the
// only thing here that just accumulates.
const pbar = {
  hp: 1, hpGhost: 1, o2: 1, o2Ghost: 1, clock: 0,
  // Last frame's displayed value, so a gain can be measured at all; the running
  // total of the gain in progress; and the glow it earned.
  // Last frame's TRUE fraction, so a rise can be spotted at all, and the glow
  // each gauge has earned.
  hpPrev: 1, o2Prev: 1,
  hpSurge: 0, o2Surge: 0,
};

/** Frame-rate-independent chase toward `target`, `rate` in units per second. */
function chase(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * One gauge: chase the value, chase the trail behind it, then write what each
 * of the three elements draws from — --sv-fill on the fill and on the trail,
 * --sv-alarm on the track around them. Returns nothing; everything it decides
 * is in the DOM.
 */
function stepBar(key, frac, dt, fillEl, ghostEl, wrapEl) {
  const s = PBAR_SMOOTH;
  const cur = chase(pbar[key], frac, frac > pbar[key] ? s.rise : s.fall, dt);
  pbar[key] = cur;
  const gk = `${key}Ghost`;
  // The trail chases the DISPLAYED value, not the raw one, so it can never be
  // caught underneath the fill and disappear on a frame where the two cross.
  pbar[gk] = chase(pbar[gk], cur, cur > pbar[gk] ? s.ghostRise : s.ghostFall, dt);

  if (fillEl) fillEl.style.setProperty('--sv-fill', cur.toFixed(4));
  // Clamped to the fill's own floor: a trail below the fill is invisible
  // anyway, and letting it go there makes the pale band flicker on a heal.
  if (ghostEl) ghostEl.style.setProperty('--sv-fill', Math.max(cur, pbar[gk]).toFixed(4));
  // --- THE SURGE ------------------------------------------------------------
  // See the note on surgeAt: a gauge with a threshold asks how big the chunk
  // still arriving is, and one without asks only whether it is filling.
  const pk = `${key}Prev`;
  const sk = `${key}Surge`;
  const climbing = frac > pbar[pk] + 1e-9;
  pbar[pk] = frac;
  const threshold = s.surgeAt[key];
  // `frac - cur` is what the bar has left to travel, which on the frame a heal
  // lands IS the size of that heal — the chase has not eaten any of it yet.
  const surging = threshold == null ? climbing : frac - cur >= threshold;

  // HELD AT FULL WHILE THE GAIN IS STILL ARRIVING, rather than fired once and
  // left to decay from the moment it triggered. A breach is a refill that
  // lasts as long as the seal stays up, and a glow that began decaying on the
  // first frame of it would be dimmest at the surface — the one moment the
  // gauge is reporting something good.
  pbar[sk] = surging ? 1 : chase(pbar[sk], 0, s.surgeFall, dt);

  if (wrapEl) {
    const alarm = Math.max(0, Math.min(1, (s.alarmAt - cur) / s.alarmAt));
    // Written already oscillating — CSS owns no clock here, so the pulse can
    // fade in with the danger instead of switching on at a threshold.
    const wave = 0.5 + 0.5 * Math.sin(pbar.clock * Math.PI * 2 * s.alarmHz);
    wrapEl.style.setProperty('--sv-alarm', (alarm * wave).toFixed(4));
    // Critical burns steadily; the surge burns on the way up. The larger wins,
    // so a bubble popped on an empty tank reads as one bright event rather
    // than two effects interfering.
    const critical = Math.max(0, Math.min(1, (s.criticalAt - cur) / s.criticalAt));
    wrapEl.style.setProperty('--sv-glow', Math.max(critical, pbar[sk]).toFixed(4));
  }
}

/**
 * Put both gauges back where the seal actually is, with no trail.
 *
 * Called at the top of a run (showHud). Without it the first frames of a new
 * run animate up from whatever the last run died on — a full bar draining, or
 * an empty one filling, either of which is a lie about a seal that has not
 * been touched yet.
 */
export function resetPlayerBars() {
  pbar.hp = 1; pbar.hpGhost = 1; pbar.o2 = 1; pbar.o2Ghost = 1;
  pbar.clock = 0;
  // The surge detector's memory goes with them. `prev` in particular: left at
  // a dying run's 0.05 it would read the reseed to full as a 95% heal and open
  // every run with both gauges blazing.
  pbar.hpPrev = 1; pbar.o2Prev = 1;
  pbar.hpSurge = 0; pbar.o2Surge = 0;
  // THE RUN'S OWN BASELINE, cleared so the next run takes its own. The corner
  // placement draws a column whose LENGTH is the seal's maximum measured
  // against what it started with, and "what it started with" is a fact about
  // one run — adopted on the first frame that has a player to read it off,
  // rather than assumed here from CONFIG. A future mode that opens with bonus
  // health would otherwise spend the whole run claiming to be over-length.
  pbar.baseHp = 0; pbar.baseO2 = 0;
  pbar.hpGrow = 1; pbar.o2Grow = 1;
  // The fuel column's baseline goes with them, and for the same reason: how
  // many pips this run STARTED cut into is a fact about one run, and a bar that
  // kept the last one's would open the next claiming to be already upgraded.
  boostBar.basePips = 0;
  boostBar.grow = 1;
  // The grain's drift goes back to where it starts, so two runs opened a
  // minute apart are the same picture rather than the same picture at two
  // arbitrary offsets. The baked field is deliberately NOT thrown away — it is
  // expensive and nothing about it is per-run.
  resetMeterNoise();
  grainTile = null;
  // UNDOING hidePlayerBars, which the last run's death left inline at zero.
  // The seal placement gets away without this because updateHUD rewrites the
  // opacity every frame from the idle test; the corner placement deliberately
  // does not fade at all, so nothing else would ever put it back and the whole
  // instrument would simply be missing for the rest of the session.
  if (el.svPlayerBars) el.svPlayerBars.style.opacity = '1';
}

/**
 * HOW LONG THE CORNER COLUMNS ARE — the placement's one extra idea.
 *
 * A gauge beside the seal is a fixed sliver: Deep Lungs and every +max-health
 * card in the game move the FRACTION inside it and nothing else, so a run that
 * has tripled its health looks identical to one that has not. Pinned to the
 * screen there is somewhere for that to go, so the track itself grows — the
 * column climbs the side of the screen as the maximum climbs, and the upgrade
 * is visible without a number on the HUD.
 *
 * What is written is a RATIO, not a length. The stylesheet turns it into
 * pixels against a quarter of the viewport and clamps it against the height of
 * the screen (see .sv-playerbars-corner), because the ceiling is a question
 * about the display and CSS is already holding the answer — computing it here
 * would mean re-measuring on every resize and every rotate.
 *
 * Chased rather than stamped, at the FILL's own rise rate: a max-health card
 * is a moment worth seeing, and a track that jumps to its new length between
 * two frames is the same silent step this whole file exists to get rid of.
 */
function stepTrackLength(player, dt) {
  const maxHp = Math.max(1, player.stats?.maxHp ?? 1);
  const maxO2 = Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen.max);
  // Adopted on the first frame of the run rather than at reset, which has no
  // player to ask. Both are taken together so a mode that starts with one of
  // them boosted cannot make the pair disagree about which run they are in.
  if (!pbar.baseHp) { pbar.baseHp = maxHp; pbar.baseO2 = maxO2; }

  const s = PBAR_SMOOTH;
  pbar.hpGrow = chase(pbar.hpGrow, maxHp / pbar.baseHp, s.rise, dt);
  pbar.o2Grow = chase(pbar.o2Grow, maxO2 / pbar.baseO2, s.rise, dt);
  const bars = el.svPlayerBars;
  if (!bars) return;
  bars.style.setProperty('--sv-hp-grow', pbar.hpGrow.toFixed(4));
  bars.style.setProperty('--sv-o2-grow', pbar.o2Grow.toFixed(4));
}

// ---------------------------------------------------------------------------
// THE GRAIN — one field of noise across all three gauges.
//
// The HUD is where the shared clock is advanced (systems/meterNoise.js reads
// it from the ring as well), and this is the once-a-frame call that does it.
// Everything below writes CUSTOM PROPERTIES on the stack and nothing else: the
// overlays are three inert elements inheriting one set of numbers, so the
// gauges cannot come apart into three fields at three phases.
// ---------------------------------------------------------------------------
let grainTile = null;   // the data URI on the stack now, so the boil is one
                        // property write per PHASE rather than per frame

function stepMeterGrain(dt) {
  advanceMeterNoise(dt);
  // ON THE UI ROOT, and it has to be the root rather than the HUD: the boss bar
  // is deliberately NOT inside .sv-hud (that is a flex row of corner panels and
  // a centred banner would fight the other two for space), so the HUD is not
  // an ancestor of every meter. Every meter on screen wears this field —
  // health, air, the boost column, the level strip and the boss bar — and
  // custom properties reach them by inheritance, so they have to be written
  // somewhere all five are under. Five overlays, one field, one phase, one
  // offset, one write.
  const bars = root;
  if (!bars) return;
  const frame = meterNoiseFrame();
  // NOT READY IS A REAL STATE and it has to draw as a plain bar: the field is
  // switched off, still baking (one phase a frame), or impossible to build at
  // all in this context. Depth 0 is the gauge as it was before any of this.
  if (!frame.ready || !frame.tile) {
    bars.style.setProperty('--sv-grain-depth', '0');
    return;
  }
  const t = frame.tuning;
  if (frame.tile !== grainTile) {
    grainTile = frame.tile;
    bars.style.setProperty('--sv-grain-img', frame.tile);
  }
  bars.style.setProperty('--sv-grain-size', `${t.tilePx}px`);
  // THE DRIFT ARRIVES IN TILES and is spent here in pixels, which is the only
  // place that conversion can honestly happen: the same offset is handed to
  // the shader in ring radii a few files away, and a field that slid at two
  // speeds in its two views would be two fields.
  bars.style.setProperty('--sv-grain-x', `${(frame.offset.x * t.tilePx).toFixed(2)}px`);
  bars.style.setProperty('--sv-grain-y', `${(frame.offset.y * t.tilePx).toFixed(2)}px`);
  bars.style.setProperty('--sv-grain-depth', t.depth.toFixed(3));
}

// ---------------------------------------------------------------------------
// THE BOOST COLUMN — the strike fuel, drawn as pips beside the air gauge.
//
// The alternative view of systems/strikeRing.js's outer wheel, and deliberately
// not a second model of it: the fills, the pops and the stagger that turns a
// gulp of five chum into five separate plops all live in that file and are read
// here through pipAnim(). Whichever style is on, the same springs are running;
// only one of them is drawn (see uFuel in the ring's shader).
//
// WHAT STAYS ON THE SEAL EITHER WAY: the drop of goo. Fuel and banked power
// move in opposite directions during a wind-up, and the second one is a thing
// the animal is holding rather than a number — pulling it into the corner with
// the pips would leave a wind-up with no read on the animal at all.
// ---------------------------------------------------------------------------
const boostBar = {
  count: 0,      // pips currently BUILT, so a re-segmentation is one rebuild
  key: '',       // ...and the colours they were built in, which the ` panel moves
  cells: [],     // { pip, fill } per segment, bottom-first — pip 0 is the floor
  basePips: 0,   // what this run STARTED cut into. See stepTrackLength.
  grow: 1,
};

/** One channel-wise sRGB mix of two 0xRRGGBB ints, as a CSS hex string. */
function hexMix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const out = [16, 8, 0].map((sh) => {
    const ca = (a >> sh) & 255;
    const cb = (b >> sh) & 255;
    return Math.round(ca + (cb - ca) * k);
  });
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * WHAT COLOUR PIP `i` IS, and it quotes the wheel rather than inventing a
 * ramp: the same mix(mix(colour, ready, t * 0.75), lastPip) the shader's
 * wheelColor() walks, so switching styles changes the shape of the meter and
 * not what it is saying. "One from full" keeps its own hue in both.
 *
 * Mixed in plain sRGB on purpose — these land in CSS, which is sRGB, where the
 * shader's .set() converts into the renderer's working space. Same numbers,
 * two destinations.
 */
function pipHex(i, n, ring) {
  const base = ring.color ?? 0x7ad7ff;
  const ready = ring.readyColor ?? 0x9dffd0;
  const last = ring.lastPipColor ?? ready;
  const t = n > 1 ? i / (n - 1) : 1;
  return i >= n - 1 ? hexMix(base, last, 1) : hexMix(base, ready, t * 0.75);
}

/**
 * Cut the column into `n` segments.
 *
 * Called only when the count or the tuned colours actually change — a link
 * landing mid-run, or somebody dragging a swatch in the ` panel. Rebuilding
 * per frame would throw away the elements the pops are being written to.
 */
function buildBoostPips(n, ring) {
  const host = el.svBoostPips;
  if (!host) return;
  host.innerHTML = '';
  boostBar.cells = [];
  for (let i = 0; i < n; i++) {
    const pip = document.createElement('div');
    pip.className = 'sv-boost-pip';
    const fill = document.createElement('i');
    fill.className = 'sv-boost-fill';
    fill.style.setProperty('--sv-pip-col', pipHex(i, n, ring));
    pip.appendChild(fill);
    host.appendChild(pip);
    boostBar.cells.push({ pip, fill });
  }
  boostBar.count = n;
}

// Which style the DOM is wearing, latched like the placement below it.
let boostMeterApplied = null;

/**
 * Put the fuel where the player has asked for it.
 *
 * The class is all this does: the ring reads the same setting itself (see
 * `fuelHere` in systems/strikeRing.js), so there is no state here that could
 * drift out of step with what the shader is drawing.
 *
 * Element check FIRST, then the latch — the settings handler in main.js can
 * reach this before initUI has built anything, and latching above that line
 * would make every later frame agree there was nothing to do.
 */
export function applyBoostMeter(mode = boostMeter()) {
  const bars = el.svPlayerBars;
  if (!bars) return;
  if (mode === boostMeterApplied) return;
  boostMeterApplied = mode;
  const column = mode === 'bar';
  bars.classList.toggle('sv-playerbars-boost', column);
  // The HUD carries this one too: on a phone the score and clock step inboard
  // of the gauges, and there is a third column to clear now.
  el.svHud?.classList.toggle('sv-hud-boostbar', column);
}

/**
 * One frame of the column. `dt` is the same real-seconds step the gauges get.
 *
 * Reads the ring's arrays as they stand, which is one frame behind: main.js
 * updates the HUD before the ring (the ring is outside the pause gate, with
 * the rest of the seal's own overlays). 16ms on a spring that takes 200ms to
 * settle is not a thing anyone can see, and the alternative — reordering the
 * frame so a HUD read can drive it — would put a display detail in charge of
 * where a gameplay system runs.
 */
function updateBoostBar(player, strikeState, dt) {
  const wrap = el.svBoostWrap;
  if (!wrap) return;
  const ring = CONFIG.strike.ring;
  const anim = pipAnim();
  // anim.count is 0 until the ring has run a frame — on the first frame of a
  // run, and for the whole of a paused menu opened before one. Falling back to
  // the model's own count means the column is built at the right length
  // immediately rather than appearing as a single empty pip.
  const n = Math.max(1, Math.min(anim.fill.length, anim.count || pipCount(player.stats)));
  const key = `${ring.color}|${ring.readyColor}|${ring.lastPipColor}`;
  if (n !== boostBar.count || key !== boostBar.key) {
    boostBar.key = key;
    buildBoostPips(n, ring);
  }

  // THE TRUE BAR IS A CEILING OVER THE QUEUE, and this line is the whole
  // reason the column can be a frame behind the springs and still be honest.
  //
  // main.js updates the HUD before the ring, so the arrays read here are last
  // frame's. On the way UP that is invisible and in fact wanted — the stagger
  // is deliberately late, one pip at a time. On the way DOWN it is not: holding
  // burns fuel and a release spends it, and both are things the player just
  // DID. A column that emptied a frame after the button reads as input lag,
  // which is the one thing this meter must never do.
  //
  // `charge` is current, so capping each pip at what the model says it holds
  // restates the ring's own asymmetry (gains queue, drains snap) using the
  // value already in hand — rather than reordering a gameplay system to suit a
  // read-out, which is what threading the ring before the HUD would amount to.
  const fuel = Math.max(0, Math.min(1, strikeState?.charge ?? 0));
  let loudest = 0;
  for (let i = 0; i < boostBar.cells.length; i++) {
    const { pip, fill } = boostBar.cells[i];
    const pop = anim.pop[i] ?? 0;
    if (pop > loudest) loudest = pop;
    const held = Math.max(0, Math.min(1, fuel * boostBar.count - i));
    fill.style.setProperty('--sv-pip', Math.min(anim.fill[i] ?? 0, held).toFixed(3));
    pip.style.setProperty('--sv-pop', pop.toFixed(3));
  }

  // THE HALO, on the same channel health and air raise theirs: a pip landing
  // lifts the whole column (the ring does exactly this with `loudest`), and a
  // full bar holds a steady lift because "you can strike now" is a state and
  // not an event.
  const loaded = fuel > 0.999;
  wrap.style.setProperty('--sv-glow', Math.min(1, loudest * 0.8 + (loaded ? 0.6 : 0)).toFixed(3));
  // Normalised exactly as uFlash is, so the two styles fade the spend over the
  // same window rather than one of them inventing a duration.
  const flashTime = Math.max(0.01, CONFIG.strike.charge.flashTime ?? 0.2);
  wrap.style.setProperty('--sv-spend', Math.max(0, Math.min(1, (strikeState?.flash ?? 0) / flashTime)).toFixed(3));

  // The track's LENGTH, in the corner placement only — chased rather than
  // stamped, at the fills' own rise rate, because a link arriving is a moment
  // worth seeing. The stylesheet turns the ratio into pixels and clamps it.
  if (!boostBar.basePips) boostBar.basePips = n;
  boostBar.grow = chase(boostBar.grow, n / boostBar.basePips, PBAR_SMOOTH.rise, dt);
  el.svPlayerBars?.style.setProperty('--sv-boost-grow', boostBar.grow.toFixed(4));
}

// Which placement the DOM is currently wearing, so the class work below runs
// on the frames it changes and not on all the others.
let barPlacementApplied = null;

/**
 * Put the two gauges where the player has asked for them.
 *
 * Called per frame from updateHUD (cheap — it early-outs) AND from main.js's
 * settings handler, and it needs both: the frame call is what makes the
 * placement correct without anything having to remember to wire it up, and the
 * settings call is what makes the switch visible IMMEDIATELY, from inside the
 * pause menu, on a frame where updateHUD is not running at all.
 */
export function applyBarPlacement(mode = barPlacement()) {
  const bars = el.svPlayerBars;
  // THE ELEMENT CHECK COMES FIRST, and the order is the whole point. This can
  // be reached from the settings handler before initUI has built anything, and
  // latching the mode above this line would make the first real frame agree
  // that there was nothing to do — the class would never be applied at all,
  // for the rest of the session, from a setting that was correctly saved.
  if (!bars) return;
  if (mode === barPlacementApplied) return;
  barPlacementApplied = mode;
  const corner = mode === 'corner';
  bars.classList.toggle('sv-playerbars-corner', corner);
  // The HUD carries the flag rather than the bars, because what it moves is
  // the OTHER block — the score and clock that share this corner on a phone.
  el.svHud?.classList.toggle('sv-hud-barcorner', corner);
  if (corner) {
    // INLINE STYLES BEAT THE STYLESHEET, so the per-frame anchor the seal
    // placement writes has to be taken back off rather than merely stopped.
    // Left in place, `left`/`top` in pixels would pin the corner stack to
    // wherever the seal last was and no rule in the sheet could move it —
    // the same trap the xp meter's `--sv-xp` fraction exists to avoid.
    bars.style.left = '';
    bars.style.top = '';
    // ...and it does not fade at full, either. A pinned instrument that dims
    // when nothing is wrong is one you have to look at twice to trust.
    bars.style.opacity = '1';
  }
}

/**
 * `dt` is REAL seconds — main.js hands it rawDt, not the gameplay dt every
 * other system gets. The two bars beside the seal are a read-out for a person,
 * and a hit-stop or a boss-kill shutter dropping the water to a tenth speed
 * must not also slow down the thing telling them how much health they have
 * left. It is a parameter rather than a clock read in here so the smoothing
 * can be driven frame by frame from a harness — see tools/player-bars-test.mjs;
 * a curve nobody can step is a curve nobody can check.
 */
export function updateHUD(gameState, player, strikeState = null, rapidFireTimer = 0, camera = null, dt = 1 / 60) {
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

  const o2Frac = Math.max(0, Math.min(1, player.oxygen / Math.max(1, player.stats?.maxOxygen ?? CONFIG.oxygen.max)));
  const hpFrac = Math.max(0, Math.min(1, player.hp / Math.max(1, player.stats.maxHp)));
  // On the FILL (which paints amber) and on the TRACK around it (whose halo
  // has to go amber with it). Two elements rather than one :has() selector:
  // the class is already being written here, and a parent-matching selector
  // would put the same fact somewhere a harness cannot read it back.
  el.svO2Bar.classList.toggle('sv-o2-low', o2Frac < 0.25);
  el.svO2Wrap?.classList.toggle('sv-o2-low', o2Frac < 0.25);

  // Clamped rather than trusted: a tab that was in the background for a minute
  // comes back with one enormous frame, and an unclamped exponential over it
  // would land exactly on the target — a snap, which is the whole thing this
  // is here to avoid.
  const step = Math.min(0.1, Math.max(0, dt));
  pbar.clock += step;
  // Before the gauges rather than after: the grain is what they are wearing,
  // not something laid over the top of a finished frame, and building this
  // frame's phase here means the ring (which only reads) can never be handed a
  // set with nothing in it.
  stepMeterGrain(step);
  stepBar('hp', hpFrac, step, el.svHpBar, el.svHpGhost, el.svHpWrap);
  stepBar('o2', o2Frac, step, el.svO2Bar, el.svO2Ghost, el.svO2Wrap);

  const placement = barPlacement();
  applyBarPlacement(placement);
  if (placement === 'corner') stepTrackLength(player, step);

  // The fuel, if it is being drawn here at all. Same shape as the placement
  // above: apply every frame (it early-outs) so the style is correct without
  // anything having to remember to wire it up, and only pay for the pips when
  // the column is the view that is on.
  const meter = boostMeter();
  applyBoostMeter(meter);
  if (meter === 'bar') updateBoostBar(player, strikeState, step);

  if (camera && el.svPlayerBars && placement !== 'corner') {
    // Offset in WORLD units, not pixels — a pixel gap would drift as the
    // arena rescales, where this keeps a constant distance from the seal.
    // On X now that the gauges stand BESIDE the animal rather than over it;
    // playerBarOffset has always meant "how far off the seal", and the
    // callout arrow still reads it as exactly that (see orbitRadiusPx).
    PROJECT_V.set(player.mesh.position.x - CONFIG.hud.playerBarOffset, player.mesh.position.y, player.mesh.position.z);
    projectToScreen(camera, PROJECT_V, screenPt);
    el.svPlayerBars.style.left = `${screenPt.x}px`;
    el.svPlayerBars.style.top = `${screenPt.y}px`;
    // At full health AND full oxygen there's nothing to watch, so the bars
    // fade back rather than permanently tagging the seal. Read off the
    // DISPLAYED values, not the true ones: a bar that is still visibly
    // draining must not fade out from under the drain it is showing.
    const idle = pbar.hp > 0.999 && pbar.hpGhost > 0.999 && pbar.o2 > 0.995;
    el.svPlayerBars.style.opacity = idle ? '0.3' : '1';
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
// link count alongside it — and, since it is now PINNED, how long the chain has
// left to run.
//
// Only ever one on screen. A chain extends faster than a toast can finish
// rising — six links inside two seconds is an ordinary run — so stacking one
// banner per link would leave a column of overlapping FOOD CHAIN!s climbing
// the screen and no readable number anywhere in it. Instead an extension
// re-uses the live node: new count, new colour, age wound back to zero, so it
// re-pops in place. That re-pop IS the feedback for the link.
//
// ---------------------------------------------------------------------------
// IT USED TO RISE OUT OF THE WATER WHERE THE LINK HAPPENED, and that is what
// changed. Two things were wrong with it and they compounded:
//
//   IT MOVED. The link is scored wherever the mouthful was swallowed, so the
//   banner came up in a different place every time — while the seal it belongs
//   to was somewhere else, usually travelling. A number that has to be found
//   before it can be read is a number nobody reads in a fight.
//
//   IT LEFT BEFORE THE THING IT ANNOUNCED DID. The banner's life is 1.3s
//   (CONFIG.textMotion.chain) and the chain window is 2.2s
//   (strike.chainWindow), so the last 40% of every chain ran with nothing on
//   screen saying a chain was running at all — and that is exactly the part
//   where knowing matters, because it is the part where you are about to lose
//   it.
//
// So it holds ABOVE THE SEAL, over the boost ring, and it stays up for as long
// as the window does. The arrival pop still plays on every link (that is the
// feedback for the link); what it no longer does is drift off and expire.
// See pinChainBanner below for where "above the seal" is measured from.
//
// ---------------------------------------------------------------------------
// AND WHILE IT IS UP, IT IS ALSO THE STRIKE PROMPT.
//
// The banner now sits directly above the slot the "STRIKE NOW!" line rides
// (ui/callout.js's on-seal surface), so mid-chain the player was shown two
// stacked lines — one of them the reason the other one exists. The banner takes
// the sentence instead: the words are replaced in place, the plate's edge
// lights neon, both flash on one clock, and the count comes back with the next
// link. The ring's own line still covers every moment the banner is not up,
// which includes the one that matters most — the window a release OPENS,
// before any link has been scored and therefore before there is a banner.
//
// The handover is decided in main.js and passed in, rather than being asked of
// this file: whether the moment is live is a fact about the strike model and
// the input, and the two surfaces have to answer to one reading of it. See
// `promptOnBanner`.
//
// THE WORDS ARE STILL callouts.csv's. `pin.promptText` is the resolved
// `strikeNow` row, so rewording it is a text edit and the ring's line and this
// one cannot start saying different things.
// ---------------------------------------------------------------------------
let chainToast = null;

/** 0xRRGGBB as a CSS hex string. The banner's colours arrive from CONFIG the
 *  way every other colour in the game does; the DOM wants a string. */
function hexCss(n) {
  return `#${(Number(n) >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** ...and as an "r,g,b" triple, which is what lets a stylesheet drop it into an
 *  rgba() whose alpha is a calc() over a custom property. */
function rgbTriple(n) {
  const v = Number(n) >>> 0;
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

/**
 * A link landed. `chain` is the new depth.
 *
 * Takes no position any more: the banner is pinned to the seal, and the point
 * the mouthful was swallowed at — which is what the world coordinates used to
 * be — is not where the announcement belongs. Placement is written on the same
 * frame by updateToasts, before the browser paints, so there is no frame where
 * this sits at the origin waiting to be told.
 */
export function spawnChainToast(chain) {
  if (!el.svToastLayer) return;
  chainToastAt(chainPin.x, chainPin.y, chain);
}

// THE COLOUR WALKS THE HUE WHEEL, one step per link, and comes back to the
// start when the chain breaks — the same wheel the "STRIKE NOW!" prompt and
// the ring's combo arc are on, so the three cannot drift apart. See
// systems/chainColor.js; the ramp it replaced (gold to a hot orange by link
// eight) had nothing left to say past eight, which is exactly where a chain is
// most worth shouting about.
//
// Written inline, per frame it changes, which is why textRoles.js marks this
// role `inlineColor` and typography.js emits no `color` for it — two writers
// on one property, where one of them silently never wins, is the bug that
// costs an afternoon.
function chainToastAt(x, y, chain) {
  const fc = CONFIG.strike?.foodChain ?? {};
  const color = hexCss(fc.color ?? 0x6dffa8);

  // A LINK TAKES THE PROMPT BACK OFF, here rather than a frame later. The
  // release that armed this link is over by definition, so the words are stale
  // the instant the count changes — and leaving it to the next updateToasts
  // would flip "STRIKE NOW!" to a NEW count one frame after the pop that
  // announced it, which reads as the banner correcting itself.
  chainPin.prompt = 0;
  chainPin.now = 0;

  if (chainToast && toasts.includes(chainToast)) {
    chainToast.age = 0;
    chainToast.x = x;
    chainToast.y = y;
    chainToast.node.style.color = color;
    chainToast.node.classList.remove('sv-chain-now');
    chainToast.word.textContent = CHAIN_WORDS;
    chainToast.count.textContent = `×${chain}`;
    chainToast.count.style.display = '';
    return chainToast;
  }

  const node = document.createElement('div');
  node.className = 'sv-chain';
  node.style.color = color;
  // The prompt's own colour, as a triple the stylesheet can put inside an
  // rgba() with a calc()'d alpha. Stamped when the banner is built rather than
  // per frame: it is a palette entry, and the thing that moves is the alpha.
  node.style.setProperty('--sv-chain-neon', rgbTriple(fc.prompt?.neon ?? 0x7dfcff));
  node.style.setProperty('--sv-chain-glow', `${Math.max(0, fc.prompt?.glow ?? 16)}px`);

  // THE WORDS IN A NODE OF THEIR OWN. They are swapped for the strike prompt
  // and back, and `textContent` on the banner itself would take the count and
  // the strip with them — the failure where a plate silently stops existing
  // the first time the prompt fires.
  const word = document.createElement('span');
  word.className = 'sv-chain-word';
  word.textContent = CHAIN_WORDS;

  const count = document.createElement('span');
  count.className = 'sv-chain-x';
  count.textContent = `×${chain}`;

  // The strip as an element rather than as text, for the same reason. It
  // carries no words of its own — the fill inside it is what moves — and it
  // inherits `color`, which is what puts the window's bar on the banner's hue
  // without a second writer for it.
  const strip = document.createElement('i');
  strip.className = 'sv-chain-strip';
  const fill = document.createElement('i');
  fill.className = 'sv-chain-fill';
  strip.appendChild(fill);

  node.appendChild(word);
  node.appendChild(count);
  node.appendChild(strip);
  el.svToastLayer.appendChild(node);

  chainToast = pushToast(node, x, y, 'chain');
  chainToast.word = word;
  chainToast.count = count;
  chainToast.strip = strip;
  return chainToast;
}

// What the banner says when it is being itself. A constant rather than a CSV
// row because, unlike the prompt it hands its plate to, this is the name of the
// mechanic rather than an instruction — it is in upgrades.csv, in the tuner's
// labels and in this file's comments, and it is not a thing to be reworded per
// device.
const CHAIN_WORDS = 'FOOD CHAIN!';

// ---------------------------------------------------------------------------
// WHERE THE BANNER HANGS, and how much of the window is left.
//
// Written once a frame by updateToasts from what main.js hands it, and kept
// here rather than passed around because the SPAWN needs it too: a link that
// lands before the first update would otherwise place the banner at the origin
// for one frame. `left` is 0 with no chain running, which is also the whole of
// "stop pinning it and let it leave".
// ---------------------------------------------------------------------------
const chainPin = {
  x: 0, y: 0, left: 0, live: false, flash: 0, clock: 0,
  // THE PROMPT. `prompt` is the gate — is a release due right now — and `now`
  // is the flash it drives, 0..1 on the layer's own clock. Two fields rather
  // than one because the gate is a fact handed in from main.js and the flash is
  // a picture of it, and collapsing them would make "is the prompt up" a
  // question with a different answer on every other frame.
  prompt: 0, now: 0, text: '',
};

/**
 * Project the anchor and decide whether the banner is being held.
 *
 * ABOVE THE BOOST RING, NOT ABOVE THE SEAL, and measured from the ring's own
 * numbers exactly as the on-seal callout is (see drawOnSeal in ui/callout.js):
 * the ring is a slider, and a banner anchored to the animal would end up
 * sitting inside the instrument the moment anyone scaled it up.
 *
 * IT CLEARS THE CALLOUT SLOT rather than negotiating with it. "STRIKE NOW!"
 * and "Boost Empty!" hang off that same anchor, and both are up during exactly
 * the wind-up a chain is being kept alive through. The clearance is taken from
 * the live element's own height when it is on screen — so it follows the Text
 * panel's type sizes — and from nothing at all when it is not, which is most of
 * the time. Measured rather than reserved: a permanent gap for a line that is
 * usually absent would float the banner for no reason.
 *
 * `worldToScreen` is not used here for the same reason updateHUD does not:
 * this file owns projectToScreen and the scratch point, and reaching into
 * ui/callout.js for its copy would be an import cycle between two files that
 * already share a layer.
 */
function pinChainBanner(camera, pin) {
  chainPin.live = false;
  chainPin.left = 0;
  chainPin.prompt = 0;
  if (!camera || !pin) return;

  const ring = CONFIG.strike?.ring ?? {};
  const top = pin.y
    + (ring.offsetY ?? 0)
    + (ring.radius ?? 1.9) * (ring.scale ?? 1)
    + (CONFIG.callouts?.ringGap ?? 0.55);
  PROJECT_V.set(pin.x + (ring.offsetX ?? 0), top, 0);
  projectToScreen(camera, PROJECT_V, screenPt);

  // The banner is centred on its anchor (translate -50%,-50%, the toast
  // layer's own transform) rather than hung off it, so half its height plus
  // the callout's full height is what clears the slot.
  const slot = calloutSlotHeight();
  const half = (chainToast?.node?.offsetHeight ?? 0) * 0.5;
  chainPin.x = screenPt.x;
  chainPin.y = screenPt.y - slot - half - (slot > 0 ? 6 : 2);
  chainPin.left = Math.max(0, Math.min(1, pin.left ?? 0));
  chainPin.live = chainPin.left > 0;
  // ONLY WHILE THE BANNER IS ACTUALLY UP. main.js decides whether the moment is
  // live; this decides whether there is a plate to say it on, and the two
  // together are what stop the prompt and the ring's own line ever being on
  // screen at once. `chainBannerHasPrompt()` reports the AND back so the
  // handover is one reading rather than two guesses.
  chainPin.prompt = pin.prompt && chainPin.live && chainToast ? 1 : 0;
  if (pin.promptText) chainPin.text = pin.promptText;
}

/**
 * Is the banner carrying the "STRIKE NOW!" line this frame?
 *
 * Read by main.js immediately after updateToasts to decide whether the ring's
 * own line should stand down. A reader rather than a return value because the
 * answer is also what the NEXT frame's callout gate wants, and a value that has
 * to be caught on exactly one line is a value somebody eventually forgets to
 * catch.
 */
export function chainBannerHasPrompt() {
  return chainPin.prompt > 0;
}

// The on-seal callout's height when it is actually on screen, 0 otherwise.
//
// Queried rather than imported: ui/callout.js imports popupPose and
// worldToScreen from this file, and importing back would close a cycle for one
// number. The node is cached because the query would otherwise run every frame
// of every chain; it is created once in initCallouts and never replaced.
let boostCalloutEl = null;
function calloutSlotHeight() {
  if (!boostCalloutEl) boostCalloutEl = root?.querySelector('.sv-callout-boost') ?? null;
  if (!boostCalloutEl || boostCalloutEl.classList.contains('sv-hidden')) return 0;
  return boostCalloutEl.offsetHeight;
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

/**
 * One frame of every popup on the layer.
 *
 * `camera` and `pin` are for the FOOD CHAIN! banner alone: `{ x, y, left }` —
 * where the seal is in world units and how much of the chain window is still to
 * run (0..1, from chainWindowLeft() in systems/strike.js, which is the one
 * expression the ring's arc quotes too). Null means no run, no chain, or a
 * caller that has nothing to pin — the banner then behaves exactly as it did
 * before, which is what the Text panel's specimen needs.
 */
export function updateToasts(dt, camera = null, pin = null) {
  pinChainBanner(camera, pin);
  // REAL SECONDS, and it has to be its own clock rather than the age of the
  // banner: the banner's age is deliberately FROZEN while the window runs (see
  // below), so a flash driven off it would stop the instant the thing it is
  // warning about started mattering.
  chainPin.clock += dt;
  // ALMOST OUT. Below `flashAt` the strip pulses, and the pulse is written as a
  // number rather than left to a CSS animation for the same reason the popups'
  // motion is: it stops when the game does. Squared so the bar sits mostly dark
  // and snaps bright, which reads as a blink instead of as a throb.
  const strip = CONFIG.strike?.foodChain?.strip ?? {};
  const flashAt = strip.flashAt ?? 0.28;
  if (chainPin.live && chainPin.left <= flashAt && flashAt > 0) {
    // Faster as it runs out, so the last half-second is unmistakable without
    // needing a second colour.
    const urgency = 1 + (1 - chainPin.left / flashAt) * 1.2;
    const s = Math.sin(chainPin.clock * (strip.flashHz ?? 5.5) * urgency * Math.PI * 2);
    chainPin.flash = s > 0 ? s * s : 0;
  } else {
    chainPin.flash = 0;
  }

  // A RELEASE IS DUE. Its own flash, on its own rate, and it can be lit at the
  // same time as the one above: a chain can be about to lapse AND have a
  // release due, and those are two different things to do about it. Squared for
  // the same reason — a blink, not a throb.
  const prompt = CONFIG.strike?.foodChain?.prompt ?? {};
  if (chainPin.prompt > 0) {
    const s = Math.sin(chainPin.clock * (prompt.flashHz ?? 7) * Math.PI * 2);
    chainPin.now = s > 0 ? s * s : 0;
  } else {
    chainPin.now = 0;
  }

  // THE WORDS, SWAPPED IN PLACE. Written only on the frames it CHANGES: this
  // runs every frame of every chain, and setting textContent unconditionally
  // would dirty the layout of a node the plate is sized from sixty times a
  // second for nothing. The count is hidden rather than emptied so the box does
  // not resize around it — though min-width on the banner is what actually
  // holds the plate still, and this is belt and braces on a surface that is
  // being used as a bar.
  if (chainToast?.word) {
    const want = chainPin.prompt > 0 ? (chainPin.text || CHAIN_WORDS) : CHAIN_WORDS;
    if (chainToast.word.textContent !== want) chainToast.word.textContent = want;
    const showCount = chainPin.prompt <= 0;
    const wantDisplay = showCount ? '' : 'none';
    if (chainToast.count.style.display !== wantDisplay) chainToast.count.style.display = wantDisplay;
    chainToast.node.classList.toggle('sv-chain-now', chainPin.prompt > 0);
  }

  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i];
    const m = motionFor(t.kind);
    // Read per frame rather than captured at birth, so a slider drag reshapes
    // the popups already in the air — which is the difference between tuning
    // this and guessing at it one kill at a time. It also means shortening the
    // life retires everything currently over that age on the next frame, which
    // is the behaviour you want from a control called "time on screen".
    // THE BANNER IS HELD WHILE ITS CHAIN IS ALIVE, and this is the whole of it.
    //
    // The age is capped at the last frame BEFORE the departure window opens, so
    // the arrival plays in full, the banner then sits, and the moment the
    // window lapses the cap comes off and the departure runs from exactly where
    // it would have. Nothing about the motion block changes — a pinned banner
    // leaves on the same curve, over the same 0.55s, as one that timed out.
    //
    // Capping the AGE rather than skipping the retirement test is deliberate:
    // it means `life` is still the thing that ends the banner, so shortening it
    // in the Text panel still retires everything on screen. A pinned popup that
    // ignored `life` would be the one popup the control did not reach.
    const pinned = t === chainToast && chainPin.live;
    let age = t.age + dt;
    if (pinned) {
      // popupPose owns the clamp on `life`, so the hold point is asked of it
      // rather than re-derived here — two copies of that arithmetic is how a
      // pinned banner ends up holding a frame into its own fade-out.
      // Floored at zero as well as capped. `out.time` is a slider and `life`
      // is a slider, and nothing stops the Text panel putting a 0.9s departure
      // on a 0.5s life — which makes the hold point negative, and an age that
      // never advances past zero is a banner frozen at its arrival scale for
      // the rest of the run. Zero is the honest answer there: hold at the
      // frame it was born on.
      age = Math.min(age, Math.max(0, popupPose(t.kind, 0).life - (m.out?.time ?? 0)));
    }
    const pose = popupPose(t.kind, age);
    t.age = age;
    if (t.age >= pose.life) { removeToast(i); continue; }

    if (pinned) {
      // Written, not integrated. The seal moves and the camera moves, so the
      // banner's position is a fact about this frame rather than a velocity —
      // and the travel is zeroed with it, or the rise would fight the pin and
      // the banner would sit a few pixels high for as long as it held.
      t.x = chainPin.x;
      t.y = chainPin.y;
      t.vx = 0;
      t.vy = 0;
    } else {
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy += (m.gravity ?? 0) * dt; // ease the rise so it settles rather than flying off
    }

    // THE WINDOW DRAINING. Written on every frame the banner exists, including
    // the ones after the chain has already lapsed — the strip empties to zero
    // and fades out with the banner rather than freezing part-full, which would
    // be the last thing on screen saying a dead chain still had time on it.
    if (t.strip) {
      t.strip.style.setProperty('--sv-chain-left', chainPin.left.toFixed(3));
      t.strip.style.setProperty('--sv-chain-flash', chainPin.flash.toFixed(3));
      // On the BANNER and not the strip: the plate's edge reads it and so does
      // the type, and the type is the strip's sibling rather than its child.
      // Custom properties inherit downward only.
      t.node.style.setProperty('--sv-chain-now', chainPin.now.toFixed(3));
    }

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
export const PREVIEW_SCREENS = ['clear', 'HUD', 'cards', 'score card'];

export function previewScreen(name) {
  if (!el.svHud) return;
  // Everything down first, so each branch only has to say what it puts UP and
  // no two screens can end up on top of each other.
  hideAllMenus();
  el.svHud.classList.add('sv-hidden');

  if (name === 'HUD') {
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
  // The banner, with its window strip part-run so the plate and the fill are
  // both visible in the panel. `chainPin` is what the strip reads and nothing
  // is pinning it here — the specimen has no seal — so the fraction is set
  // directly, which is also what stops the preview banner being held.
  chainPin.left = 0.42;
  chainPin.live = false;
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
  // The pin goes with them. `live` left true across a restart would hold the
  // first banner of the next run at the last frame's anchor — which is wherever
  // the previous seal died — until its first update, and `left` would draw a
  // strip reporting a chain that ended with the run.
  chainPin.live = false;
  chainPin.left = 0;
  chainPin.flash = 0;
  chainPin.prompt = 0;
  chainPin.now = 0;
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
  // A print from the LAST run must not still be held up over this one's card.
  closeShotView();
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
    // A tap PICKS IT AND HOLDS IT UP. Picking alone was the whole gesture, and
    // on a phone it meant the answer to "is this the one?" was a print the
    // width of a thumb — so the two buttons under the fan were pressed on
    // faith. openShotView selects as well, so the row below the fan still acts
    // on whatever was last touched once the sheet is closed.
    slot.addEventListener('click', () => openShotView(i));
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

// ---------------------------------------------------------------------------
// THE PRINT, HELD UP TO THE LIGHT
// ---------------------------------------------------------------------------
// A photograph in the fan is 120px of paper on a phone. That is enough to see
// that there are three of them and nowhere near enough to decide which one is
// worth posting — the boss's name is on the chin at four pixels tall. Tapping
// one opens it at nearly the size of the screen, with Share and Save under it,
// so the decision is made while LOOKING at the picture rather than after it has
// already gone to the OS.
//
// WHAT IT SHOWS IS THE FILE, not a bigger copy of the fan's paper. The two are
// genuinely different objects — the fan draws a Rive artboard live, and what
// leaves the game is a PNG rendered off screen at share size (see
// bossShotImage) — and a preview of the wrong one is worse than none, because
// it would be believed. The composite goes up on the first frame because it is
// already decoded and in the fan; the share file replaces it as soon as it is
// ready, which on the normal path is immediately (warmShareCards rendered every
// card while the screen was arriving).
//
// The token is what stops a slow render landing in a viewer that has since been
// closed, or reopened on a different print.
let shotViewToken = 0;

function shotViewOpen() {
  return !!el.svShotView && !el.svShotView.classList.contains('sv-hidden');
}

async function openShotView(i) {
  if (!el.svShotView || !el.svShotImg) return;
  wireShotView();
  selectShot(i);
  const shot = bossShots()[i];
  if (!shot) return;
  const token = ++shotViewToken;

  if (el.svShotStatus) el.svShotStatus.textContent = '';
  el.svShotImg.alt = shot.name ? `You beat ${shot.name}` : 'Your boss kill';
  el.svShotImg.src = shot.url ?? '';
  el.svShotView.classList.remove('sv-hidden');
  // Focus moves onto the way out, so Escape and a pad both have somewhere to
  // be. Not onto Share: the first thing a confirm should do on a sheet the
  // player has just opened is not post their run to the internet.
  el.svShotClose?.focus({ preventScroll: true });

  const url = await bossShotImage(i);
  if (url && token === shotViewToken && shotViewOpen()) el.svShotImg.src = url;
}

function closeShotView() {
  if (!el.svShotView) return;
  shotViewToken++;
  el.svShotView.classList.add('sv-hidden');
  // The attribute is REMOVED rather than blanked. A blank src is a request for
  // the current document, and what this is holding is a 1600x2000 data URL —
  // dropping it gives the decoded bitmap back rather than keeping one per
  // print looked at for the rest of the screen.
  el.svShotImg?.removeAttribute('src');
  if (el.svShotStatus) el.svShotStatus.textContent = '';
}

let shotViewWired = false;

function wireShotView() {
  if (shotViewWired) return;
  shotViewWired = true;
  const say = (msg) => { if (el.svShotStatus) el.svShotStatus.textContent = msg; };
  // Same three outcomes the trophy row reports, and said the same way — see
  // told() in wireTrophy for why "shared!" cannot cover all of them.
  const told = (how) => say({
    shared: 'Shared',
    saved: 'Saved to your downloads',
    opened: 'Opened — press and hold the picture to save it',
    cancelled: '',
    unavailable: 'Nothing to share',
  }[how] ?? '');

  // The same rule as the trophy row: where the OS has a share sheet, that sheet
  // is also how you save, so a second button is one doing the first one's job.
  if (canShareImages()) {
    el.svShotSave?.remove();
    el.svShotSave = null;
    if (el.svShotShare) el.svShotShare.textContent = 'Share this print';
  }

  bindMenuSounds(el.svShotShare)?.addEventListener('click', async () => {
    say('…');
    told(await shareBossShot(selectedShot));
  });
  bindMenuSounds(el.svShotSave)?.addEventListener('click', async () => {
    told(await saveBossShot(selectedShot));
  });
  bindMenuSounds(el.svShotClose)?.addEventListener('click', closeShotView);

  // THE SHEET'S OWN BACKDROP CLOSES IT.
  //
  // AND NOTHING IN HERE REACHES THE MENU UNDERNEATH. That one turns the card
  // over on any click outside the card (see bindTurn), and this sheet is inside
  // it — so without the stop, putting a photograph down would flip the card
  // behind it, and so would pressing Share. Stopped for the whole sheet rather
  // than for the backdrop alone, because every one of its controls is a click
  // outside the card as far as the menu can tell.
  el.svShotView?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === el.svShotView) closeShotView();
  });

  // Escape, before main.js's pause key sees it. The score screen is not a
  // paused game, so nothing else would answer.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !shotViewOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    closeShotView();
  }, true);
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

// ---------------------------------------------------------------------------
// THE RUN DETAIL TABS
// ---------------------------------------------------------------------------
// Two more readings of the run the player has just finished, built from the
// playtest ledger at the moment the score card opens.
//
// NOTHING HERE IS INSTRUMENTATION. Every figure below was already being
// recorded on every run — the recorder is not a dev-only feature, it starts in
// main.js on the same line the run does — and was reachable only from the B
// overlay on a dev build or from a JSONL file on disk. This is the same data
// with a player pointed at it.
//
// BUILT ON OPEN, NOT PER FRAME. analyzeRun walks a run's buckets, which is
// twenty-odd objects and free at this cadence; doing it once here also means
// the tabs cannot change under a player who is looking at them while the water
// carries on behind the card.

/**
 * A damage figure at the width the card has for it: 41.2k, not 41,203.
 *
 * The precision genuinely is not there to lose — these are sums of thousands
 * of per-frame slices of a rate, and the last three digits of that are noise
 * dressed as a measurement. What the player is reading is the ORDER and the
 * shares, both of which survive this intact.
 */
function compactDamage(n) {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v < 1000) return String(v);
  if (v < 100000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1e6) return `${Math.round(v / 1000)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}

// textContent, never innerHTML, for anything that came out of the ledger. The
// labels are ours (upgrade names, cause names) but the FALLBACK is a raw source
// key, and a source key is a string the game concatenated — the same rule the
// quip and the leaderboard name follow, for the same reason.
function brkRow({ name, tag, note, a, b, share, incoming }) {
  const row = document.createElement('div');
  row.className = `sv-brk-row${incoming ? ' sv-brk-in' : ''}`;
  row.style.setProperty('--sv-share', `${Math.max(0, Math.min(100, share ?? 0))}%`);

  const label = document.createElement('span');
  label.className = 'sv-brk-name';
  label.textContent = name;
  if (note) {
    const n = document.createElement('span');
    n.className = 'sv-brk-picks';
    n.textContent = note;
    label.appendChild(n);
  }
  if (tag) {
    const t = document.createElement('span');
    t.className = 'sv-brk-tag';
    t.textContent = tag;
    label.appendChild(t);
  }

  const left = document.createElement('span');
  left.className = 'sv-brk-a';
  left.textContent = a;
  const right = document.createElement('span');
  right.className = 'sv-brk-b';
  right.textContent = b;

  row.append(label, left, right);
  return row;
}

function brkHead(...cols) {
  const head = document.createElement('div');
  head.className = 'sv-brk-head';
  for (const c of cols) {
    const s = document.createElement('span');
    s.textContent = c;
    head.appendChild(s);
  }
  return head;
}

function brkFoot(pairs) {
  const foot = document.createElement('div');
  foot.className = 'sv-brk-foot';
  for (const [text, value] of pairs) {
    const s = document.createElement('span');
    s.textContent = `${text} `;
    const b = document.createElement('b');
    b.textContent = value;
    s.appendChild(b);
    foot.appendChild(s);
  }
  return foot;
}

function brkEmpty(panel, message) {
  const p = document.createElement('div');
  p.className = 'sv-brk-empty';
  p.textContent = message;
  panel.appendChild(p);
}

/**
 * Fill the Weapons and Threats panels for the run that has just ended.
 *
 * NEVER THROWS. This runs inside showGameOver, which is the only route back
 * into the game — a recap that fails has to leave an empty panel and a working
 * Try again, not a card that never appeared. Everything it reads is a plain
 * object from the recorder, and it is still wrapped, because the alternative
 * to being paranoid here is a run that cannot be restarted.
 */
function renderRunDetail(gameState) {
  const weapons = el.svPanelWeapons;
  const threats = el.svPanelThreats;
  if (!weapons || !threats) return;
  weapons.replaceChildren();
  threats.replaceChildren();
  if (el.svBackTitle) {
    // What the back is the back OF. The front carries the quip and the five
    // figures; a face with two tables and no heading could be anybody's run.
    el.svBackTitle.textContent =
      `${formatTime(gameState.time)} \u00B7 Level ${gameState.level ?? 1}`;
  }

  let a = null;
  try {
    const run = lastFinishedRun();
    if (run) a = analyzeRun(run);
  } catch (err) {
    console.warn(`[ui] could not read the run's ledger — ${err}`);
  }
  if (!a) {
    brkEmpty(weapons, 'No breakdown for this run.');
    brkEmpty(threats, 'No breakdown for this run.');
    return;
  }

  // --- WEAPONS ------------------------------------------------------------
  // Sorted by damage, which is the order the question is asked in. The share
  // is against the TOP row rather than against the total, so the bars use the
  // full width of the card at every scale of run — a build where one ability
  // does 80% and a build where four are level would otherwise be drawn as one
  // long bar and three slivers, and four bars in a dead heat.
  const dealt = a.abilities.filter((r) => r.damage > 0).sort((x, y) => y.damage - x.damage);
  const top = dealt[0]?.damage ?? 0;
  // The weapon that finished the last boss, tagged in the table. Matched on the
  // SOURCE KEY and not on the printed name: a weapon can be renamed mid-run
  // (see weaponName.js), so the polaroid carries what it was called at the
  // moment of the kill while this table shows what it ended the run as, and
  // comparing those two strings would silently stop finding the row the day
  // somebody picked up Cloned Pebbles.
  const finisher = bossShot()?.causeSource ?? '';

  if (!dealt.length) {
    brkEmpty(weapons, 'Nothing was damaged this run.');
  } else {
    weapons.appendChild(brkHead('Weapon', 'Damage', 'Kills'));
    const list = document.createElement('div');
    list.className = 'sv-brk';
    for (const r of dealt) {
      list.appendChild(brkRow({
        // What the run called it, not what the ledger calls it. analyzeRun is
        // import-free on purpose and cannot see the player's picks, so the
        // build-aware name is applied here, at the one place a person reads it.
        name: weaponName(r.source),
        // Picks, not stack-minutes: "×4" is what the player recognises from
        // the cards they took. The baseline pick Fin Pebbles gets for free is
        // in that count, which is honest — it is a stack you have.
        note: r.stacks > 0 ? `×${r.stacks}` : '',
        tag: finisher && r.source === finisher ? 'Final blow' : '',
        a: compactDamage(r.damage),
        b: String(r.kills ?? 0),
        share: top > 0 ? (r.damage / top) * 100 : 0,
      }));
    }
    weapons.appendChild(list);

    const foot = [['Total dealt', compactDamage(a.totalDamage)]];
    // THE ABILITIES THAT DEAL NOTHING BY DESIGN — Cold Snap, the Grabber,
    // Baby Beluga. They belong on this tab and they cannot be in the table:
    // a row of zeroes in a column headed Damage says the upgrade is broken,
    // which is the exact misreading the ledger's `control` flag exists to
    // prevent. So they are counted in events, on a line of their own.
    const control = a.abilities.filter((r) => r.control && r.events > 0);
    if (control.length) {
      const held = control.reduce((n, r) => n + r.events, 0);
      foot.push([`Caught, held or frozen`, String(held)]);
    } else {
      foot.push(['Kills', String(gameState.kills ?? 0)]);
    }
    weapons.appendChild(brkFoot(foot));
  }

  // --- THREATS ------------------------------------------------------------
  // Grouped by cause rather than listed by source. `a.threats` is keyed by the
  // strings that reach recordPlayerDamage — 'greatWhite', 'abyssShark',
  // 'megalodon' — and a player who spent a run being eaten by sharks did not
  // lose it to three things. primaryCause is the single-cause reading written
  // for exactly this: causesOfDeath returns several per source on purpose, and
  // adding up a table built from that would total more damage than was taken.
  const byCause = new Map();
  let taken = 0;
  for (const t of a.threats) {
    const cause = primaryCause(t.source);
    const key = cause?.id ?? t.source;
    const row = byCause.get(key) ?? { label: threatLabel(t.source), damage: 0 };
    row.damage += t.damage;
    byCause.set(key, row);
    taken += t.damage;
  }
  const rows = [...byCause.values()].sort((x, y) => y.damage - x.damage);

  if (!rows.length) {
    brkEmpty(threats, 'Nothing laid a finger on you.');
  } else {
    threats.appendChild(brkHead('What hurt you', 'Damage', 'Share'));
    const list = document.createElement('div');
    list.className = 'sv-brk';
    const worst = rows[0].damage;
    for (const r of rows) {
      list.appendChild(brkRow({
        incoming: true,
        name: r.label,
        a: compactDamage(r.damage),
        b: taken > 0 ? `${Math.round((r.damage / taken) * 100)}%` : '0%',
        share: worst > 0 ? (r.damage / worst) * 100 : 0,
      }));
    }
    threats.appendChild(list);

    const foot = [['Total taken', compactDamage(taken)]];
    // The killing blow, from the source killPlayer resolved at the moment of
    // death rather than from the top of this table — the thing that took the
    // most health off you over ten minutes is very often not the thing that
    // finished you, and saying so would be the card getting a fact wrong about
    // the run the player just played.
    const killer = primaryCause(gameState.deathSource);
    if (killer) foot.push(['Killed by', killer.threat]);
    threats.appendChild(brkFoot(foot));
  }
}

// The live turn, while the card is up. Re-mounted per death rather than kept:
// the card's height changes with what the run produced (a trophy row or not, a
// board that arrived or not), and the flip has to be measured against the card
// it is actually turning.
let flip = null;

/**
 * The card has come square — put the kill shots' drawing surfaces back.
 *
 * ONE FRAME LATER, AND THAT IS THE LOAD-BEARING PART. The thing being undone
 * is Rive re-sizing each print's surface off the rotated card (see
 * resyncSnapshotCards for the whole story), and it does that from a
 * ResizeObserver — which the browser delivers AFTER the animation-frame
 * callbacks of the frame that changed the box, not during them. On a normal
 * turn the landing is half a second past that and the ordering does not
 * matter; on a reduced-motion swap the face un-hides and the card "lands" in
 * the same synchronous breath, so a repair made here and now would be
 * overwritten by the observer a moment later and the card would come back
 * wrong for exactly the players who asked for less motion.
 *
 * Then sizeCard, because the prints going back to their real height changes
 * how tall the front face is, and the card is still whatever the ruined fan
 * measured until something says otherwise.
 */
function landSnapshotSurfaces() {
  requestAnimationFrame(() => {
    resyncPrintCards();
    sizeCard();
  });
}

/**
 * Size the card to the TALLER face and re-bake both worn edges.
 *
 * Both faces are absolutely positioned, so the card has no height of its own.
 * Measuring means briefly putting each face back in flow — the alternative is
 * trusting the front, and the back carries two tables the front does not, so
 * the card comes out short and the face's own overflow silently clips the last
 * control off the bottom of it. Nothing else reports that.
 */
function sizeCard() {
  const card = el.svCard;
  if (!card) return;
  let tallest = 0;
  for (const face of [el.svFaceFront, el.svFaceBack]) {
    if (!face) continue;
    // The class has to come off to measure a face that is currently the hidden
    // one — display:none measures 0, and the back is hidden for the whole of
    // the frame this runs on.
    const wasHidden = face.classList.contains('sv-hidden');
    face.classList.remove('sv-hidden');
    face.style.position = 'relative';
    tallest = Math.max(tallest, face.scrollHeight);
    face.style.position = '';
    if (wasHidden) face.classList.add('sv-hidden');
  }
  // Written only on a change — see watchCardSize for why that matters, and
  // because a height re-written every observer callback is a style recalc for
  // nothing on a screen that is sat on for minutes.
  const want = tallest > 0 ? `${tallest}px` : '';
  if (want && card.style.height !== want) card.style.height = want;

  // The border, eaten by the same noise field the menus dissolve through. Baked
  // per size and cached, so a resize costs one bake and a redraw costs nothing.
  // A null mask means the bake failed; the card then shows with a clean edge,
  // which is the look this replaced — never an empty mask, which would hide the
  // whole card and with it the way back into the game.
  //
  // MEASURED OFF THE LAYOUT BOX, NOT getBoundingClientRect. That method returns
  // the card's PROJECTION, and this card spends a second at a time rotated:
  // mid-turn its client rect is a few pixels wide and at 90 degrees it is zero.
  // Any content arriving during a turn — the trophy fan's prints, or the global
  // board replacing the local one, both of which land seconds after the card
  // opens and are exactly what watchCardSize exists to catch — re-baked the wear
  // at that width and stretched it back over the full face, which shreds the
  // card into vertical strands and takes the leaderboard with it. offsetWidth
  // and offsetHeight are the border box and ignore transforms entirely.
  //
  // NO ZERO-WIDTH GUARD HERE, deliberately: wornEdgeMask already returns null
  // below nine pixels, which lands on the clean-edge path above. A guard that
  // returned early instead would take the whole bake out of reach of the jsdom
  // harness, where every box is zero — and that harness is the only thing
  // testing the failed-bake path at all.
  const boxW = card.offsetWidth;
  const boxH = card.offsetHeight;
  const wear = CONFIG.death?.flip?.wear ?? {};
  const style = wear.style ?? 'houseField';
  for (const [i, face] of [el.svFaceFront, el.svFaceBack].entries()) {
    if (!face) continue;
    const mask = style === 'clean' ? null : wornEdgeMask({
      w: boxW,
      h: boxH || tallest,
      radius: wear.radius ?? 14,
      depth: wear.depth ?? 9,
      style,
      // Two faces, two seeds: the same card worn identically on both sides
      // reads as a texture rather than as an object.
      seed: i,
    });
    applyMask(face, mask ?? 'none', '100% 100%', '0 0', 'no-repeat');
    if (!mask) clearMask(face);
  }
}

// The two faces, watched so the card keeps following whichever is taller. Held
// at module scope so a second death disconnects the first one's watchers rather
// than stacking another set.
let cardWatch = null;

/**
 * Re-size the card whenever a face's CONTENT changes.
 *
 * A MUTATION OBSERVER AND NOT A RESIZE ONE, which is the whole point of this
 * comment. `.sv-face-inner` is `height: 100%` of a face that is `inset: 0` of
 * the card, so its box is exactly the card's height and CANNOT grow when
 * content is added to it — a ResizeObserver on it fires on a viewport change
 * and never once on the thing this exists to catch. It looks completely
 * correct and does nothing.
 *
 * What it has to catch is real and happens on every run: the trophy fan builds
 * its prints asynchronously, and the global leaderboard replaces the local one
 * whenever the network answers. Both are DOM insertions, minutes apart from
 * each other on a slow connection, into a card that was measured once.
 *
 * NOT COALESCED THROUGH requestAnimationFrame, and that is a correction rather
 * than a preference. Batching through a frame looks tidier and introduces a way
 * to wedge: the "one is already queued" flag latches, and a frame that never
 * arrives — a backgrounded tab, which is exactly where somebody leaves a score
 * screen — leaves it latched forever, so every later insertion is dropped and
 * the card is stuck at whatever height it had when the tab lost focus.
 *
 * There is nothing to gain by it either. A MutationObserver callback is already
 * batched: the fan inserting eight prints in a loop produces ONE call, not
 * eight. Measuring here forces one synchronous layout per batch, on a menu,
 * which is free at this cadence.
 */
function watchCardSize() {
  unwatchCardSize();
  const inners = [el.svFaceFront, el.svFaceBack]
    .map((f) => f?.querySelector('.sv-face-inner')).filter(Boolean);
  if (!inners.length) return;

  const soon = () => sizeCard();
  cardWatch = { mo: null, soon };
  if (typeof MutationObserver === 'function') {
    cardWatch.mo = new MutationObserver(soon);
    for (const inner of inners) cardWatch.mo.observe(inner, { childList: true, subtree: true });
  }
  // The viewport's own changes — a rotation, a desktop window dragged narrower.
  // Not a ResizeObserver for the reason above; the card's width comes from the
  // stylesheet, so what changes here is how the content wraps inside it.
  window.addEventListener('resize', soon);
}

function unwatchCardSize() {
  if (!cardWatch) return;
  cardWatch.mo?.disconnect();
  window.removeEventListener('resize', cardWatch.soon);
  cardWatch = null;
}

// Bound once, at build time, like every other control on this card. The faces
// are re-filled per death; the two turn controls never change.
function bindTurn() {
  for (const id of ['svTurnOver', 'svTurnBack']) {
    const button = el[id];
    if (!button) continue;
    // bindMenuSounds already voices the press. A second feedback() call here
    // would both double the blip and invent an event name nothing declares,
    // which the event audit reads as a typo.
    bindMenuSounds(button).addEventListener('click', () => flip?.flip());
  }

  // THE WATER AROUND THE CARD TURNS IT OVER TOO.
  //
  // "Turn it over" is a caption in the card's own type — small, low contrast,
  // and deliberately not a fifth button competing with Try again — which makes
  // it the right size for a label and the wrong size for a target. The card is
  // an object on a table and the rest of the screen is the table, so clicking
  // the table turns the object over: a whole screen's worth of hit area for a
  // gesture that has no cost, because the way back is the same gesture.
  //
  // The card itself is exempt, or every press on Try again would flip on its
  // way through — a click on a control inside the card bubbles up to here as
  // well as firing its own handler.
  el.svGameOverMenu?.addEventListener('click', (e) => {
    // The preview sheet is drawn over this and handles its own backdrop; a tap
    // there puts the photograph down and must not also turn the card behind it.
    if (shotViewOpen()) return;
    if (e.target?.closest?.('#svCard')) return;
    // Somebody who has just dragged across the leaderboard to copy a name is
    // finishing a selection, not asking for anything.
    if (window.getSelection?.()?.toString()) return;
    feedback('uiClick');
    flip?.flip();
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
  // Score on its own line at display size, the other four as one even row under
  // it — see .sv-scorecard for why the flat row of five had to go.
  const rest = [
    ['Time', formatTime(gameState.time)],
    ['Level', gameState.level],
    ['Kills', gameState.kills],
    ['Bosses', bosses],
  ].map(([k, v]) => `<span class="sv-stat"><b>${v}</b>${k}</span>`).join('');
  el.svGameOverStats.innerHTML =
    `<div class="sv-scorecard">` +
    `<div class="sv-score-hero"><b>${score.toLocaleString()}</b><span>Score</span></div>` +
    `<div class="sv-stat-row">${rest}</div>` +
    `</div>`;

  // ALWAYS FRONT SIDE UP. Which way the card was left is not a preference — a
  // player who read the weapons after one death is not asking to skip the
  // photographs after the next one, and the roll of prints is what this screen
  // leads with.
  renderRunDetail(gameState);
  flip = mountCardFlip({
    card: el.svCard,
    front: el.svFaceFront,
    back: el.svFaceBack,
    // The bubbles need somewhere bigger than the card to live, or they are
    // clipped the moment they leave its edge — which is the only place they
    // ever are. The centring layer is the whole screen.
    water: el.svGameOverMenu,
    onLand: landSnapshotSurfaces,
  });
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
  // A remembered name arrives whole rather than a character at a time, so it
  // never passes through the `input` handler that would size it.
  fitNameField();
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

  // SIZING HAPPENS HERE, AFTER THE UN-HIDE, and the ordering is the whole
  // thing. Called any earlier the menu is still display:none, every rectangle
  // measures 0, the card is given no height and both faces — which are absolute
  // and inset:0 — collapse into it. The card then renders as nothing, and
  // because nothing overflows a box of zero height, npm run layout reports a
  // clean sheet on a score screen that is completely invisible.
  //
  // Then WATCHED, because two things arrive after this frame and both change
  // how tall the front is: the trophy fan builds its prints asynchronously, and
  // the global leaderboard replaces the local one whenever the network answers.
  // A card sized once is a card that is the wrong height a second later.
  sizeCard();
  watchCardSize();

  // Focus lands on the field so a name can be typed without clicking first,
  // but only with a real keyboard — on touch, focusing would throw up the
  // on-screen keyboard over the board before the player has asked for it.
  if (!touchPrimary()) {
    el.svNameInput.focus();
    el.svNameInput.select();
  }
}

// --- THE NAME FIELD SHOWS THE WHOLE NAME -----------------------------------
//
// A cap of MAX_NAME_LEN characters is only worth what the player can see of it
// while they type. The field used to be sized in pixels against 24 characters
// of Inter, which was true of Inter and of nothing else: the font picker can
// put 'Press Start 2P' in this box, a full em per glyph, and the tail of a
// name scrolled out of the left of the field as it was typed — which reads as
// the field having eaten it rather than as the name being long.
//
// So the type SHRINKS to fit instead. The measurement is a hidden span wearing
// the field's own computed font, because that is the only thing that knows how
// wide the text actually is in whatever family is live — and because an
// <input>'s own scrollWidth is not reliable across browsers for exactly this
// question.
//
// A FLOOR, not an unbounded shrink: past this the name is legible in the sense
// that the pixels are there and in no other, and a full-length name in a pixel
// font is simply going to be small. 8px is 'Press Start 2P''s own native grid,
// which is the smallest this can go and still be that font rather than a smear
// of it.
//
// The RESTING size is read off the field rather than stated here — the
// stylesheet owns it, and a second copy would be a number that silently stops
// matching the rule it was written from. Only the floor is a decision.
const NAME_FONT_MIN_PX = 8;
let nameRuler = null;

function fitNameField(input = el.svNameInput) {
  if (!input) return;
  // Both back to their resting state before anything is measured — a fit
  // measured against the last fit's own size shrinks a little further on every
  // keystroke and never comes back when the name gets shorter.
  input.style.fontSize = '';
  el.svNameRow?.classList.remove('sv-name-stacked');
  if (!input.value) return;

  // Built once and left in the DOM — a ruler that is created and removed per
  // keystroke is a layout thrash on every character, and this one is 1px of
  // nothing parked off-screen.
  if (!nameRuler) {
    nameRuler = document.createElement('span');
    nameRuler.setAttribute('aria-hidden', 'true');
    nameRuler.style.cssText =
      'position:absolute; left:-9999px; top:0; white-space:pre; visibility:hidden;';
    document.body.appendChild(nameRuler);
  }

  const cs = getComputedStyle(input);
  // Read with no inline size on the field (cleared above), so this is the size
  // the stylesheet asks for and the one a short name is shown at.
  const base = parseFloat(cs.fontSize) || 14;
  nameRuler.style.fontFamily = cs.fontFamily;
  nameRuler.style.fontWeight = cs.fontWeight;
  nameRuler.style.letterSpacing = cs.letterSpacing;
  nameRuler.style.textTransform = cs.textTransform;
  nameRuler.textContent = input.value;
  // Measured at the resting size once and then scaled — text width is linear
  // in font-size, so one measurement answers it rather than a loop of reflows.
  nameRuler.style.fontSize = `${base}px`;
  const width = nameRuler.getBoundingClientRect().width;

  // The room inside the box: its width less its own padding, which is what the
  // text has to live in.
  const room = () => input.clientWidth
    - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);

  let avail = room();
  // Zero in a headless DOM, where nothing has a width — the guard is what keeps
  // the jsdom harness from walking this all the way down to the floor.
  if (!(avail > 0) || !(width > avail)) return;

  // THE LINE IS THE FIRST THING SPENT, not the type size. Beside its button the
  // field is about 270px, and 32 characters of a pixel font do not go into that
  // at any size a player would thank us for — so the row stacks and the field
  // gets the card's whole width before the type gives up anything more.
  if (base * (avail / width) < NAME_FONT_MIN_PX) {
    el.svNameRow?.classList.add('sv-name-stacked');
    avail = room();
    if (!(avail > 0) || !(width > avail)) return;
  }

  const size = Math.max(NAME_FONT_MIN_PX, Math.floor(base * (avail / width) * 10) / 10);
  input.style.fontSize = `${size}px`;
}

async function submitPendingRun() {
  if (!pendingRun) return;

  const run = pendingRun;
  pendingRun = null; // claim it before any await — a double click must not post twice

  // 'ANON' and NOT DEFAULT_PLAYER_NAME, and the difference is deliberate. The
  // token's fallback is the game's VOICE — "Nice one, Seal" reads fine to
  // somebody who never typed a name. A board is a list of PEOPLE, and a public
  // board with four rows called Seal reads as four players with the same
  // name rather than as four who declined to give one.
  const name = savePlayerName(el.svNameInput.value) || 'ANON';
  el.svNameSubmit.disabled = true;
  el.svNameInput.disabled = true;
  setStatus(isGlobal() ? 'Posting…' : 'Saving…');

  const result = await submitScore({ ...run, name });

  el.svNameRow.classList.add('sv-hidden');
  renderBoard(result.list, { global: result.global, result });

  if (result.error) {
    setStatus(`Couldn't reach the global board — saved on this device as ${name}`, true);
  } else if (result.madeList) {
    setStatus(`#${result.rank} as ${name}`);
  } else {
    setStatus(`Saved as ${name} — didn't make the top ${BOARD_SIZE}`);
  }
}

function setStatus(text, isError = false) {
  el.svLbStatus.textContent = text;
  el.svLbStatus.classList.toggle('sv-status-err', isError);
}

// `result` is only passed after a submit — that's the one case where a row can
// be identified as this player's, since rank comes back with the write.
/**
 * @param into  which element to paint. The score card's own panel by default;
 *              the standalone board from the main menu passes its own (see
 *              showLeaderboard). One renderer for both, because two would drift
 *              the moment a column is added — and the board a player checks
 *              before a run has to be the same board they are put on after it.
 */
function renderBoard(list, { global, result = null } = {}, into = el.svLeaderboard) {
  const heading = global ? 'Global leaderboard' : 'Leaderboard (this device)';
  if (!into) return;

  if (!list?.length) {
    into.innerHTML =
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
        <span class="sv-lb-lv">${e.level ?? ''}</span>
        <span class="sv-lb-time">${formatTime(e.time)}</span>
      </div>`;
    })
    .join('');

  // The rows in a wrapper of their own so the zebra counts from the first ROW
  // rather than from the caption above it, and so the header can sit outside
  // the stripe. Unpositioned on purpose — the scroll below measures offsets
  // against the list, and a positioned wrapper would become the offset parent.
  into.innerHTML =
    `<div class="sv-label" style="margin-bottom:6px;">${heading}</div>` +
    `<div class="sv-lb-head">` +
      `<span>#</span><span>Name</span><span>Score</span><span>Lv</span><span>Time</span>` +
    `</div>` +
    `<div class="sv-lb-rows">${rows}</div>`;

  // THE BOARD IS A HUNDRED DEEP AND THE BOX SHOWS EIGHT OF THEM. Being 61st is
  // making the leaderboard, and a panel that opens at rank 1 tells a player who
  // just got there that they are not on it — they would have to scroll a list
  // they have no reason to think they are in.
  //
  // scrollTop by hand rather than scrollIntoView: that method scrolls every
  // scrollable ancestor, and this list sits inside a score card that scrolls
  // too on a short screen — so it would drag the card out from under the
  // player to bring one row into the middle of the screen. The rows and the
  // list share an offset parent (nothing between them is positioned), which is
  // what makes the difference of their offsets the distance down the list.
  if (result?.madeList) {
    const mine = into.querySelector('.sv-lb-mine');
    if (mine) {
      into.scrollTop = Math.max(
        0,
        mine.offsetTop - into.offsetTop - (into.clientHeight - mine.offsetHeight) / 2,
      );
    }
  }
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
