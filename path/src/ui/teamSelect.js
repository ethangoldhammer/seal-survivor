// ---------------------------------------------------------------------------
// THE BLUBBERBALL TEAM SELECT — a controller select the way a fighting game
// does it. Every controller in the room (and the keyboard) is a chip in the
// middle; push LEFT or RIGHT and your chip walks onto that side; A readies
// you, B walks you back; the first onto a side is its CAPTAIN and picks the
// team's colour off the wheel with UP and DOWN; Start starts it once both
// sides have a ready captain. A side nobody joins is the computer's.
//
// WHAT IT WRITES is versusSetup in systems/versusFlag.js — the sides, the
// devices, the colours — and nothing else: no CONFIG (the tuner would ship a
// pick as a default, see the note there) and no run. `onStart` is main.js's
// (`enterMode(true)`), which switches the mode and builds the match, and
// `onBack` reopens the Seal sports list.
//
// FOUR A SIDE IS THE SHAPE, ONE A SIDE IS THE GAME. Each column draws a
// captain's slot and three more under it, because a four-a-side match is
// where this is going and the screen should already be the right shape — but
// the three are locked: player 1 is `player` and player 2 is versus.js's one
// second body, and until there are four of each there is nothing for a third
// chip to drive. MAX_PER_SIDE is the number the lock will come off to. A
// second controller pushing onto a side that has a captain simply stays where
// it is.
//
// THE KEYBOARD IS LEFT-ONLY. input.js is player 1's, and player 1 is the
// left goal; the keyboard cannot be handed to the second body without
// input.js growing a second reader. So the keyboard chip refuses RIGHT, and
// the hint says nothing about it because it is the only device that does.
//
// PADS APPEAR WHEN TOUCHED. The browser does not expose a controller until a
// button on it is pressed, so the middle of the screen starts with only the
// keyboard chip and a line asking for a press (teamNoPads); each pad joins
// the pool on its first press and the press itself is spent on arriving.
//
// ...AND A HAT. Beside each name is a tile showing what that seal is wearing;
// click it to step through the drawer's ring — bare, then everything unlocked,
// in the same order the main menu's drawer walks. SEAT 0'S TILE IS THE PLAYER'S
// OWN SLOT, the one the drawer writes and localStorage remembers, so dressing
// yourself here is the same act as dressing yourself there and neither screen
// can disagree with the other. See systems/rosterCast.js.
//
// EVERY SEAT HAS A NAME ON IT. Seat 0 wears the name off the splash — the one
// this player has already chosen for themselves tonight (systems/playerName.js)
// — and every other seat is cast off sealNames.csv with a dice beside it to
// re-cast. The names are the match's, not the screen's (systems/rosterCast.js),
// so what you read here is what the goal card will say. Seat 0 has no dice:
// that name is changed on the splash, where it is saved.
//
// COPY: every word is a row of uiText.csv. The hint, the locked slots, the
// no-pads line and the prompt heading are lorem until Ethan writes them; the
// device names and the buttons are [DRAFT]; Blubberball and Rematch are his.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { uiText } from '../uiTextTable.js';
import { feedback } from '../systems/feedback.js';
import { beatGrid } from '../systems/music.js';
import { versusSetup, resetVersusSetup, KEYBOARD, MAX_PER_SIDE } from '../systems/versusFlag.js';
import { pollPads } from './padPoll.js';
// The roster is the match's, not the screen's — see systems/sealRoster.js.
import { rosterPerSide as matchRoster, setRosterSize as setMatchRoster, seatsOfTeam, MAX_PER_SIDE as ROSTER_MAX } from '../systems/sealRoster.js';
// ...and so is the CAST — see systems/rosterCast.js. The screen shows the
// names and re-rolls them; it does not own them, because the match reads the
// same list at kickoff and the goal card spends it.
import { syncRosterCast, seatName, rollSeatName, seatAccessory, cycleSeatAccessory } from '../systems/rosterCast.js';
// How the match ends — runtime state, not CONFIG, for the reason the roster and
// the colours are. See systems/matchRules.js.
import {
  isTimed, setTimed, goalsToWin, setGoalsToWin, matchSeconds, setMatchSeconds,
  STEP_SECONDS, MIN_GOALS, MAX_GOALS, MIN_SECONDS, MAX_SECONDS,
} from '../systems/matchRules.js';
// The tile picture and the name, from the drawer that already owns both — see
// accessoryName there for why the name lookup is not written out again here.
import { ACCESSORY_ICONS } from './accessoryIcons.js';
import { accessoryName } from './accessoryDrawer.js';
// This screen's stylesheet is filed UNDER the Text panel's role sheet — the
// screen builds on its first open, long after typography has written its
// rules, and appended after them its sizes would beat the panel's. The type
// in STYLE below is a fallback; the roles in textRoles.js own it.
import { installStyleBelowRoles } from './typography.js';

const POOL = -1;
// The dice face on the re-roll button. A glyph, not a word — see nameTag.
const DICE = '\u{1F3B2}';
// ...and what an EMPTY accessory tile shows. A bare head, not a cross: nothing
// on is a choice in the ring rather than the absence of one.
const BARE = '\u{1F9AD}';
// WHO IS DRIVING A SEAT, and whether they have readied — as glyphs rather than
// as words.
//
// The slot is a 34px row holding a chip, a name, a dice and a hat tile, three
// of which are already fixed-width. "Gamepad 1" and "Keyboard" are the only
// things in it that grow, and at three columns on a 600px window they grew
// past the slot: measured, the captain row spilled 29px past its own box.
//
// THE WORDS ARE NOT GONE. Each glyph carries the uiText row as its title and
// its accessible name — the same bargain the dice and the hat tile already
// make — so a hover and a screen reader still get Ethan's line, the table's
// rows are still read, and nothing about the layout had to change to fit them.
const KB = '\u2328';          // keyboard
const PAD = '\u{1F3AE}';      // game controller
const READY = '\u2713';       // check mark

let root = null;
let el = null;
let open = false;
let callbacks = { onStart: null, onBack: null, onChange: null };
// key → { key, kind: 'keyboard' | 'pad', index, side, ready }
const devices = new Map();
const padPrev = new Map();
// THE WHEEL INDEX EACH SIDE HAS PICKED, or null for a side that has not.
//
// NULL AND NOT A DEFAULT. It used to open on the shipped green and red, matched
// to the wheel by hue — so both sides arrived already dressed and the wheel was
// a thing you could ignore. Nobody is on a colour until somebody picks one: an
// unpicked side's light WALKS the ring on the quarter note, and what it has
// landed on when Start is pressed is what that side plays in. Pressing nothing
// is still an answer; it is just an answer the music gave.
const picks = [null, null];
let keyHandler = null;

// WHICH MATCH SETTING A PAD IS ON, or -1 for "nobody has asked".
//
// THE ROWS UNDER THE BOARD ARE THE MATCH, and until now they were the one part
// of this screen a controller could not touch: how many seals a side, first to N
// goals or N minutes, and which of those two it is. They were built as pointer
// controls and nothing ever gave them a second route — which on the one screen
// in this game most likely to be played from a sofa is the wrong half to leave
// out. A pad could choose a side, a colour and press Start, and could not change
// a single thing about the match it was starting.
//
// A READIED DEVICE'S STICK IS WHAT DRIVES THEM, and that is not a mode hidden in
// a corner: it is the only state on this screen where the directions have
// nothing else to mean. Unreadied, left and right walk between the sides and up
// and down turn the colour wheel; readied, move() and stepColor both refuse
// outright — they always have — so all four were dead buttons. Readying is also
// already what you must do before Start, so the sequence a player performs
// anyway (pick a side, pick a colour, lock in) ends with their stick on the
// match itself.
//
// NOTHING IS LIT UNTIL SOMEBODY ASKS, the rule every other cursor in this game
// follows: a ring drawn the moment a captain readies would be pointing at a
// control a mouse player is never going to use.
const SETTING_STOPS = 3;
let settingRow = -1;

const STYLE = `
/* RESPONSIVE, AND THE OLD min-width IS WHY IT WAS NOT.
   min-width: min(92vw, 720px) is a FLOOR: on a narrow screen it held the
   panel at 92vw and the padding of the .sv-menu around it pushed the whole
   thing past the viewport, so the right-hand team walked off the edge with no
   way to reach it. A width with a CEILING is what this wants — the panel is as
   wide as it needs to be, never wider than the screen — and box-sizing so the
   padding is inside that ceiling rather than added to it. Without it .sv-menu's
   own max-width: 90vw is a CONTENT width and its 32px of side padding is added
   on top, which on a 375px phone is 401px of panel in a 375px window: the right
   team walks off the edge and there is no way to reach it.
   90vw and not a wider figure of this screen's own, so the panel sits in the
   same margin every other menu in the game does.

   THE CEILING IS MEASURED, not chosen. 720px was a round number and it was
   about 300px short of what this screen actually holds: a seal name is up to
   MAX_NAME_LEN (32) characters, and a slot is a chip, that name, a dice and a
   hat tile side by side. At 32ch of 12px type the name alone is ~215px, which
   with the fixed furniture is a ~390px slot on a touch viewport — two of those
   plus the pool column and the gaps is 1040px of panel. Under that every name
   in the pool came out cut off with an ellipsis, which is the one thing a
   roster screen must not do to the names it is there to show. */
.sv-teams, .sv-teams * { box-sizing: border-box; }
.sv-teams { display: flex; flex-direction: column; align-items: center; gap: 14px;
  width: min(90vw, 1040px); max-height: 92vh; overflow-y: auto; overflow-x: hidden; }
/* TYPE IS THE TEXT PANEL'S — every size, weight, spacing and colour on a line
   of text below is a fallback the roles in textRoles.js restate; no opacity on
   a roled line, because the role's alpha is in its colour. Edit them there. */
.sv-teams-hint { font-size: 12px; letter-spacing: .04em; text-align: center; }
.sv-teams-board { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 16px; width: 100%; align-items: start; }
/* MINMAX(0, 1FR) AND NOT 1FR. A grid track's default minimum is its content's
   own minimum, so a column holding a nowrap chip and a 108px wheel refuses to
   go under about 200px whatever the container says — and three of those plus
   the gaps is what actually overflowed. Zero is the floor that lets the column
   be as narrow as the screen needs it to be; the ellipsis on the name and the
   wheel's own vmin sizing are what keep it readable down there. */
.sv-teams-side { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 10px 14px; border-radius: 12px; border: 2px solid var(--team, rgba(255,255,255,.14)); background: rgba(255,255,255,.03); min-height: 220px; min-width: 0; cursor: pointer; }
.sv-teams-side.sv-teams-cpu { border-style: dashed; }
.sv-teams-slots { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.sv-teams-slot { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; min-width: 0; overflow: hidden; border-radius: 8px; background: rgba(255,255,255,.05); font-size: 13px; }
.sv-teams-slot.sv-teams-captain { min-height: 44px; font-size: 15px; font-weight: 600; background: rgba(255,255,255,.09); }
.sv-teams-slot.sv-teams-locked { font-size: 11px; letter-spacing: .06em; border: 1px dashed rgba(255,255,255,.18); background: transparent; }
/* THE PILL CANNOT PUSH THE ROW APART. nowrap with no min-width makes a flex
   item that refuses to shrink below its own text, so the slot's content
   minimum was whatever the longest chip happened to say — measured at three
   columns on a 600px window, the captain row spilled 29px past its own box and
   took the hat tile with it. The glyphs above are what usually keeps this
   short; the floor of zero is what makes it impossible. */
.sv-teams-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,.12); border: 2px solid transparent; font-size: 13px; font-weight: 600; white-space: nowrap; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
.sv-teams-chip.sv-teams-ready { border-color: var(--team, #fff); }
/* THE NAME, and the dice that re-casts it. The row is a fixed three-part
   layout — chip, name, dice — so a long name pushes nothing about and the
   dice is in the same place on every slot; the name itself ellipsises rather
   than wrapping, because a slot that grows a second line is a column that
   jumps every time somebody presses the dice. */
/* THE NAME IS NEVER CUT. It used to be one nowrap line with an ellipsis on it,
   which on any screen narrower than the measured ceiling above turned "Congressman
   Jingleheimer Schmidt" into "Congressman Jingle…" — and the layout audit could
   not see it, because text-overflow: ellipsis is the one truncation it reads as
   deliberate (see tools/layout/layout-audit.js). Wrapping instead means a narrow
   screen costs a second line rather than the end of somebody's name, and the
   audit's clipped check is live on this row again.
   THE COLUMN DOES NOT JUMP, which was the original argument for nowrap: the
   slot's min-height already holds two lines of this type (34px against 2x15,
   44px on a captain against 2x16), so a name that wraps lands in room that was
   already there and a dice press moves nothing under it. */
.sv-teams-name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; justify-content: space-between; text-align: left; }
.sv-teams-name-text { min-width: 0; overflow-wrap: break-word; font-size: 12px; line-height: 1.25; }
.sv-teams-captain .sv-teams-name-text { font-size: 13px; }
.sv-teams-dice { flex: none; width: 22px; height: 22px; padding: 0; line-height: 1; border: 0; border-radius: 6px; cursor: pointer;
  background: rgba(255,255,255,.10); color: inherit; font-size: 13px; opacity: .7; transition: opacity .12s, transform .12s; }
.sv-teams-dice:hover { opacity: 1; transform: rotate(-12deg); }
/* WHAT THE SEAL IS WEARING, and the button that changes it. The picture is the
   control — see kitTag — so the tile is square, the render fills it, and the
   only thing drawn under it is the frame that says it is pressable. */
.sv-teams-kit { flex: none; width: 26px; height: 26px; padding: 0; line-height: 1; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.16); background-color: rgba(255,255,255,.06); color: inherit;
  font-size: 13px; display: inline-flex; align-items: center; justify-content: center; transition: border-color .12s, transform .12s; }
.sv-teams-kit:hover { border-color: var(--team, #fff); transform: translateY(-1px); }
.sv-teams-kit-bare { opacity: .55; }
.sv-teams-slot { padding: 0 8px; }
.sv-teams-stamp { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--team, #fff); }
.sv-teams-pool { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-width: 0; width: clamp(84px, 20vw, 150px); min-height: 220px; }
.sv-teams-nopads { font-size: 11px; text-align: center; line-height: 1.4; }
/* PORTRAIT STACKS. Two columns of seal slots side by side cannot be read on a
   phone held upright — the same conclusion the bust's button row came to (see
   hexMenu.layout). Stacked, each side gets the full width and the pool goes
   between them where it already is in source order. */
@media (max-aspect-ratio: 3/4), (max-width: 520px) {
  .sv-teams-board { grid-template-columns: minmax(0, 1fr); }
  .sv-teams-side { min-height: 0; }
  .sv-teams-pool { min-height: 0; width: 100%; flex-direction: row; flex-wrap: wrap; }
}
/* ONE CIRCLE, AND IT SCALES. The wheel is a single size — --wheel — and the
   dot and the ring are both derived from it, so the spacing between two dots
   and the size of a dot keep their ratio at every screen size. Written the
   other way (a px dot on a vmin ring) the dots crowd together on a phone and
   swim apart on a desktop, and the count that fits would be a different number
   on every device. */
.sv-teams-wheel { --wheel: clamp(96px, 22vmin, 132px); --dot: calc(var(--wheel) * .139);
  position: relative; width: var(--wheel); height: var(--wheel); flex: none; margin-top: 4px; }
/* THE TRANSFORM IS COMPOSED FROM THREE CUSTOM PROPERTIES and none of them is
   written as a finished string: --at is where the swatch sits (set once, on
   render), --pick is whether it is this side's colour, and --beat is how much
   of THIS dot's turn is left — one dot lights at a time and the light walks
   round the ring, a step per quarter note. Written as one transform by
   whichever of the three moved, they would take turns clobbering each other.
   No transition either: the beat IS the timing, and a 120ms ease over a 350ms
   note smears every attack.
   (No backticks in here, deliberately: this block is inside a template
   literal and one would end the string, with the error pointing at a comment.) */
.sv-teams-swatch { position: absolute; left: 50%; top: 50%; width: var(--dot); height: var(--dot);
  margin: calc(var(--dot) / -2) 0 0 calc(var(--dot) / -2); border-radius: 50%; border: 2px solid transparent; cursor: pointer;
  transform: var(--at) scale(calc(var(--pick, 1) * (1 + var(--beat, 0) * .55)));
  box-shadow: 0 0 calc(var(--beat, 0) * var(--dot) * .8) currentColor; }
.sv-teams-swatch.sv-teams-picked { border-color: #fff; box-shadow: 0 0 calc(6px + var(--beat, 0) * var(--dot)) currentColor; }
.sv-teams-swatch.sv-teams-taken { opacity: .25; cursor: default; }
.sv-teams-foot { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 4px; max-width: 100%; }
/* The roster row sits between the board and the buttons: it is a setting for
   the match rather than a way out of the screen, so it reads with the sides it
   changes and not with Back and Start. */
/* WRAPS RATHER THAN OVERFLOWS. These rows are a label, a pair of steppers and
   a number — short, until the label is a phrase and the window is a phone held
   sideways. A row that cannot wrap pushes the panel wider than the screen, and
   the panel is what the two teams are inside. */
.sv-teams-roster { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; max-width: 100%; font-size: 12px; letter-spacing: .04em; }
/* The number and its two steppers as ONE thing, so a pad's cursor has a box to
   be drawn around — the row also holds the kind button, which is a stop of its
   own. Inline-flex and not a block: it is a run of controls inside a row that
   wraps, and it has to wrap with it. */
.sv-teams-rules-group { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
/* WHERE A PAD IS, on the two settings rows. The same ring the score card and the
   pause menu draw (.sv-nav-sel in ui/ui.js), restated here because this screen
   carries its own sheet — and a ring rather than a colour, because a stepper at
   its clamp is already saying something with colour. */
.sv-teams-roster.sv-nav-sel, .sv-teams-rules-group.sv-nav-sel, .sv-teams-mode.sv-nav-sel {
  outline: 2px solid #fff; outline-offset: 3px; border-radius: 8px; }
.sv-teams-roster .sv-btn { min-width: 28px; padding: 2px 8px; }
.sv-teams-roster .sv-btn:disabled { opacity: .3; }
.sv-teams-roster-n { min-width: 1.5ch; text-align: center; font-variant-numeric: tabular-nums; }

/* THUMBS. Every control on this screen was built for a pointer and six of them
   are under Apple's 44px minimum on every touch viewport: the dice is 22
   square, the hat tile 26, and the four steppers are 28 wide. npm run layout
   found all six, at six viewports each, the first time this screen was in its
   list — which is the whole argument for putting it there.

   .sv-touch, not a width query. Whether there is a thumb is not a question
   about how wide the screen is: an iPad in landscape is 1024px and is still
   touched, and it was among the viewports failing. ui.js sets this class from
   the real pointer media query (and the layout audit sets it per tile, which
   is how these are exercised at all).

   GROWN, NOT PADDED. A hit area extended with a pseudo-element is the usual
   trick and it is invisible to a rectangle: the audit measures the element,
   and so does anybody eyeballing it. These take the room because the panel
   scrolls (max-height: 92vh above) and the name beside them ellipsises, which
   is what the ellipsis was for. */
.sv-touch .sv-teams-dice, .sv-touch .sv-teams-kit { width: 44px; height: 44px; font-size: 18px; }
.sv-touch .sv-teams-slot { min-height: 52px; }
/* The steppers keep .sv-btn's own height (44) and only want width. */
.sv-touch .sv-teams-roster .sv-btn { min-width: 44px; }
`;

function cssColor(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

function palette() {
  const p = CONFIG.versus?.wheel;
  return Array.isArray(p) && p.length >= 2 ? p : [0x3ddc63, 0xff4d4d];
}

/** Hue in degrees of a 0xRRGGBB colour, for matching a default to the wheel. */
function hueOf(n) {
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (d < 1e-6) return -1;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// --- the wheel's geometry -----------------------------------------------------

/**
 * WHERE SWATCH `i` SITS on the ring — an angle, and a radius as a SHARE of the
 * wheel rather than a number of pixels.
 *
 * A share, because the wheel itself is sized in vmin (see --wheel in the
 * stylesheet) so that a dot and the gap between two dots keep their ratio on
 * every screen. A radius in px here would be a third unit fighting the other
 * two: the dots would crowd on a phone and swim apart on a desktop, and "how
 * many fit" would have a different answer on every device.
 *
 * ONE CIRCLE. The count that fits is a property of that ratio and is measured —
 * see the note on CONFIG.versus.wheel.
 */
function swatchAt(i, total) {
  return {
    angle: (i / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2,
    // 0.5 would put the dot's centre on the wheel's own edge; this leaves the
    // ring a dot's width of margin inside it, which is the room a pulse needs.
    share: 0.36,
  };
}

function build(parent) {
  installStyleBelowRoles('svTeamSelectStyle', STYLE);
  root = document.createElement('div');
  root.className = 'sv-center sv-hidden';
  root.id = 'svTeamSelect';
  root.innerHTML = `
    <div class="sv-menu sv-teams">
      <div class="sv-title"></div>
      <div class="sv-teams-hint"></div>
      <div class="sv-teams-board">
        <div class="sv-teams-side" data-side="0"></div>
        <div class="sv-teams-pool"></div>
        <div class="sv-teams-side" data-side="1"></div>
      </div>
      <div class="sv-teams-roster">
        <span class="sv-teams-roster-label"></span>
        <button class="sv-btn sv-teams-roster-less" type="button">&minus;</button>
        <span class="sv-teams-roster-n"></span>
        <button class="sv-btn sv-teams-roster-more" type="button">+</button>
      </div>
      <div class="sv-teams-roster sv-teams-rules">
        <button class="sv-btn sv-teams-mode" type="button"></button>
        <span class="sv-teams-rules-group">
          <span class="sv-teams-rules-label"></span>
          <button class="sv-btn sv-teams-rules-less" type="button">&minus;</button>
          <span class="sv-teams-rules-n"></span>
          <button class="sv-btn sv-teams-rules-more" type="button">+</button>
        </span>
      </div>
      <div class="sv-teams-foot">
        <button class="sv-btn" id="svTeamBack" type="button"></button>
        <button class="sv-btn" id="svTeamStart" type="button"></button>
      </div>
    </div>`;
  parent.appendChild(root);
  el = {
    title: root.querySelector('.sv-title'),
    hint: root.querySelector('.sv-teams-hint'),
    sides: [...root.querySelectorAll('.sv-teams-side')],
    pool: root.querySelector('.sv-teams-pool'),
    back: root.querySelector('#svTeamBack'),
    start: root.querySelector('#svTeamStart'),
    rosterLabel: root.querySelector('.sv-teams-roster-label'),
    rosterN: root.querySelector('.sv-teams-roster-n'),
    rosterLess: root.querySelector('.sv-teams-roster-less'),
    rosterMore: root.querySelector('.sv-teams-roster-more'),
    mode: root.querySelector('.sv-teams-mode'),
    // The two rows a PAD walks, and the one span inside the second that a
    // cursor can be drawn around — see SETTING_STOPS.
    rosterRow: root.querySelector('.sv-teams-roster'),
    rulesGroup: root.querySelector('.sv-teams-rules-group'),
    rulesLabel: root.querySelector('.sv-teams-rules-label'),
    rulesN: root.querySelector('.sv-teams-rules-n'),
    rulesLess: root.querySelector('.sv-teams-rules-less'),
    rulesMore: root.querySelector('.sv-teams-rules-more'),
    // Rebuilt by render(); pulse() writes one property onto each.
    wheels: [],
  };
  el.title.textContent = uiText('sportBall');
  el.hint.textContent = uiText('teamSelectHint');
  el.back.textContent = uiText('sealSportsBack');
  el.start.textContent = uiText('teamStart');
  el.rosterLabel.textContent = uiText('teamRoster');
  el.back.addEventListener('click', () => leave());
  el.start.addEventListener('click', () => tryStart());
  // HOW MANY SEALS EACH SIDE PUTS ON THE PITCH. A control rather than a
  // constant: whether four a side on a pitch tuned for one is a scramble or a
  // mess is a question you answer by playing it, and a rebuild between each try is
  // how a question like that stops being asked. See systems/sealRoster.js.
  el.rosterLess.addEventListener('click', () => stepRoster(-1));
  el.rosterMore.addEventListener('click', () => stepRoster(1));
  // HOW THE MATCH ENDS. The button flips between the two kinds and the pair
  // beside it steps whichever number that kind is played to — one row, because
  // they are one decision: a match is first to N goals OR N minutes long, and
  // showing both numbers at once would be two settings where there is one.
  el.mode.addEventListener('click', () => { setTimed(!isTimed()); feedback('uiClick'); render(); });
  el.rulesLess.addEventListener('click', () => stepRules(-1));
  el.rulesMore.addEventListener('click', () => stepRules(1));
  // A click on a column is the keyboard-and-mouse player joining it — the
  // one device with no d-pad. It walks the keyboard chip there (left only,
  // see the header), or readies it if it is already there.
  el.sides.forEach((node, side) => node.addEventListener('click', (e) => {
    if (e.target.closest('.sv-teams-swatch')) return;
    const kb = devices.get(KEYBOARD);
    if (!kb) return;
    if (kb.side === side) toggleReady(kb);
    else move(kb, side);
  }));
}

// --- the model ------------------------------------------------------------

function captain(side) {
  for (const d of devices.values()) if (d.side === side) return d;
  return null;
}

/** What to CALL a device — the words, for a title and a screen reader. */
function label(d) {
  return d.kind === 'keyboard' ? uiText('teamKeyboard') : `${uiText('teamPad')} ${d.index + 1}`;
}

/**
 * ...and what to DRAW for it: the glyph, with a pad's number after it so four
 * controllers in a room are still four different chips. See KB/PAD above for
 * why this is not the word.
 */
function glyph(d) {
  return d.kind === 'keyboard' ? KB : `${PAD}${d.index + 1}`;
}

function move(d, side) {
  if (d.ready) return;
  if (side !== POOL && captain(side) && captain(side) !== d) return;
  if (side === 1 && d.kind === 'keyboard') return;
  if (d.side === side) return;
  d.side = side;
  feedback('uiHover');
  render();
}

function toggleReady(d) {
  if (d.side === POOL) return;
  d.ready = !d.ready;
  feedback('uiClick');
  render();
}

/**
 * THE COLOURS A SIDE MAY STILL TAKE — every swatch on the wheel except the one
 * the other side is already holding.
 *
 * The list, not a test, because the CHASE walks it: a light that stepped over
 * the other side's colour by skipping an index would pause on the beat it
 * skipped, and a light that pauses is a light that has stopped keeping time.
 * Walking a list that never contained it, it cannot land there and never
 * hesitates.
 */
function openTo(side) {
  const taken = picks[1 - side];
  const out = [];
  for (let i = 0; i < palette().length; i++) if (i !== taken) out.push(i);
  return out;
}

/**
 * WHERE AN UNPICKED SIDE'S LIGHT IS — the wheel index, derived from the beat
 * count rather than stepped by it.
 *
 * DERIVED, for the reason the pulse itself is: a counter incremented each time
 * a boundary was noticed drifts by a beat for every frame dropped and never
 * recovers. Read off the clock it is right on the frame after a stall.
 *
 * THE TWO SIDES RUN OPPOSITE WAYS. Given the same beat they would otherwise
 * light the same colour all the way round, which reads as one light drawn
 * twice rather than as two sides choosing — and would make the commonest
 * outcome of pressing nothing two teams in the same kit, which the rest of this
 * screen spends its whole time preventing.
 */
function chaseAt(side, beats) {
  const open = openTo(side);
  if (!open.length) return null;
  const n = open.length;
  const step = Math.floor(beats);
  const at = side === 0 ? step : -step - 1;
  return open[((at % n) + n) % n];
}

/** What a side is showing right now: its pick, or wherever its light has got to. */
function colorOf(side) {
  return picks[side] ?? chase[side];
}

// Where each side's light is this frame — written by pulse(), read by render()
// and by writeSetup. Null before the first beat, and on a side that has picked.
const chase = [null, null];


/**
 * TELL THE MATCH WHAT THIS SIDE IS WEARING — its pick, or wherever its light
 * has walked to.
 *
 * The pitch is standing behind this screen with the roster on it, and a side
 * with no colour written would show the CONFIG default: green and red, which is
 * exactly the "defaults to a team colour" this screen no longer does. Writing
 * the light's colour as it walks means the seals in the water are always
 * wearing what that side would get if Start were pressed now, which is the rule
 * itself made visible rather than a thing you find out afterwards.
 *
 * versusSetup and not CONFIG — see the note in systems/versusFlag.js. A colour
 * written to CONFIG would be snapshotted by the tuner and ship as a default.
 */
function publishColor(side) {
  const t = versusSetup.teams[side];
  if (!t) return false;
  const was = t.color;
  t.color = palette()[colorOf(side) ?? -1] ?? null;
  return t.color !== was;
}

/** Step side `side`'s colour round the wheel, skipping the other side's. */
/**
 * Grow or shrink the roster. Clamped by sealRoster (1..MAX_PER_SIDE), and the
 * screen re-reads what it actually became rather than what it asked for — a
 * request the cap refused has to be visibly refused.
 */
function stepRoster(dir) {
  const was = matchRoster();
  const now = setMatchRoster(was + dir);
  if (now !== was) feedback('uiClick');
  render();
}

/**
 * Step whichever number the match is played to — goals in a first-to, seconds
 * on the clock in a timed match. Clamped by matchRules, and the screen re-reads
 * what it actually became rather than what it asked for: a request the clamp
 * refused has to be visibly refused.
 */
function stepRules(dir) {
  if (isTimed()) {
    const was = matchSeconds();
    if (setMatchSeconds(was + dir * STEP_SECONDS) !== was) feedback('uiClick');
  } else {
    const was = goalsToWin();
    if (setGoalsToWin(was + dir) !== was) feedback('uiClick');
  }
  render();
}

/** Flip first-to-N against N-minutes. The same act the kind button performs. */
function flipRulesKind() {
  setTimed(!isTimed());
  feedback('uiClick');
  render();
}

/**
 * THE THREE STOPS A PAD WALKS on the rows under the board, and the element each
 * one draws its ring around.
 *
 * Three and not two: the kind button is a decision of its own — first to five
 * goals and five minutes are different matches — and folding it into the number
 * beside it would make the one control on those rows a pad could not reach the
 * one that decides what the number MEANS.
 *
 * Rebuilt on demand rather than held, for the reason el.wheels is: render()
 * rewrites the board every frame something changes, and a handle taken once
 * would eventually point at an element that has left the document.
 */
function settingStops() {
  return [
    { node: el.rosterRow, step: stepRoster },
    { node: el.mode, step: flipRulesKind },
    { node: el.rulesGroup, step: stepRules },
  ];
}

/** Walk between the settings rows. Clamped, like every other list in the game. */
function stepSettingRow(dir) {
  const was = settingRow;
  settingRow = was < 0 ? 0 : Math.max(0, Math.min(SETTING_STOPS - 1, was + dir));
  if (settingRow !== was) feedback('uiHover');
  render();
}

/**
 * Change whatever the cursor is on — and with nothing selected yet, SELECT
 * rather than change. The first thing a readied stick says is the asking; a push
 * that silently altered the roster before anything was drawn would be a setting
 * changing with no indication of which one.
 */
function stepSettingValue(dir) {
  if (settingRow < 0) { stepSettingRow(1); return; }
  settingStops()[settingRow]?.step(dir);
}

/**
 * The pad's up and down. A STEP FROM WHERE THE LIGHT IS, on a side that has not
 * picked yet — so thumbing the stick takes the colour under the light and moves
 * from there, rather than jumping to the top of a wheel the player was already
 * watching. It is a pick either way: the light stops the moment a hand is on it.
 */
function stepColor(side, dir) {
  const open = openTo(side);
  if (!open.length) return;
  const from = colorOf(side);
  const at = Math.max(0, open.indexOf(from));
  const next = open[((at + dir) % open.length + open.length) % open.length];
  picks[side] = next;
  chase[side] = null;
  feedback('uiHover');
  render();
}

/**
 * A SIDE PICKS, and its light stops walking. Refused where the other side is
 * already holding that colour — two teams in one kit is the thing this screen
 * exists to prevent, and a wheel that let you take it and then quietly moved
 * you off it would be worse than one that says no.
 */
function setColor(side, i) {
  if (i === picks[1 - side]) return;
  picks[side] = i;
  chase[side] = null;
  feedback('uiClick');
  render();
}

/** Both sides have a captain who is ready, or are empty (the CPU's), and at least one is a person. */
export function canStart() {
  const c = [captain(0), captain(1)];
  if (!c[0] && !c[1]) return false;
  return c.every((d) => !d || d.ready);
}

function leave() {
  if (!open) return;
  hideTeamSelect();
  feedback('uiClick');
  callbacks.onBack?.();
}

function tryStart() {
  if (!open || !canStart()) return;
  writeSetup();
  hideTeamSelect();
  feedback('uiClick');
  callbacks.onStart?.(versusSetup);
}

/** The screen's answer, in the shape the match reads. */
export function writeSetup() {
  const wheel = palette();
  resetVersusSetup();
  for (let side = 0; side < 2; side++) {
    const t = versusSetup.teams[side];
    const c = captain(side);
    // PRESSING NOTHING IS STILL AN ANSWER — it is just the one the music gave.
    // A side that never picked plays in whatever its light had walked to when
    // Start was pressed. Null only where there is no wheel at all.
    t.color = wheel[colorOf(side) ?? -1] ?? null;
    t.members.push(c
      ? { kind: 'human', pad: c.kind === 'keyboard' ? KEYBOARD : c.index }
      : { kind: 'cpu', pad: null });
  }
  return versusSetup;
}

// --- input ----------------------------------------------------------------

function act(d, press) {
  // A READIED DEVICE'S STICK IS THE MATCH'S — see settingRow. Every one of these
  // four directions is refused by move() and stepColor() while `ready` is set,
  // so nothing is being taken away from anything: they were dead.
  if (d.ready && (press.left || press.right || press.up || press.down)) {
    if (press.up) stepSettingRow(-1);
    else if (press.down) stepSettingRow(1);
    else stepSettingValue(press.right ? 1 : -1);
    return;
  }
  if (press.left) move(d, d.side === POOL ? 0 : d.side === 1 ? POOL : 0);
  else if (press.right) move(d, d.side === POOL ? 1 : d.side === 0 ? POOL : 1);
  else if (press.up && d.side !== POOL && !d.ready) stepColor(d.side, -1);
  else if (press.down && d.side !== POOL && !d.ready) stepColor(d.side, 1);
  else if (press.a) { if (d.side === POOL) move(d, d.kind === 'keyboard' ? 0 : (captain(0) ? 1 : 0)); else toggleReady(d); }
  else if (press.b) { if (d.ready) toggleReady(d); else if (d.side !== POOL) move(d, POOL); else leave(); }
  else if (press.start) tryStart();
}

/**
 * Once a frame while the screen is up (main.js calls it beside the other
 * menu polls). Registers any pad it has not seen, drops any that has gone,
 * and hands each pad's presses to its chip.
 */
export function updateTeamSelect(list = null) {
  if (!open) return;
  pulse();
  const pads = pollPads(padPrev, list);
  const seen = new Set([KEYBOARD]);
  let changed = false;
  for (const p of pads) {
    const key = `pad${p.index}`;
    seen.add(key);
    let d = devices.get(key);
    if (!d) {
      d = { key, kind: 'pad', index: p.index, side: POOL, ready: false };
      devices.set(key, d);
      changed = true;
      // The press that made the browser show this pad is spent on arriving.
      continue;
    }
    act(d, p.press);
  }
  for (const [key, d] of devices) {
    if (!seen.has(key)) { devices.delete(key); changed = true; }
    void d;
  }
  if (changed) render();
}

function onKey(e) {
  if (!open) return;
  const kb = devices.get(KEYBOARD);
  if (!kb) return;
  const press = { left: false, right: false, up: false, down: false, a: false, b: false, start: false };
  switch (e.key) {
    case 'ArrowLeft': case 'a': press.left = true; break;
    case 'ArrowRight': case 'd': press.right = true; break;
    case 'ArrowUp': case 'w': press.up = true; break;
    case 'ArrowDown': case 's': press.down = true; break;
    case 'Enter': case ' ': press.a = true; break;
    case 'Escape': case 'Backspace': press.b = true; break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
  act(kb, press);
}

// --- rendering --------------------------------------------------------------

/**
 * WHAT A SEAT IS WEARING, and a click to change it.
 *
 * The picture is the control, exactly as it is in the drawer: at this size
 * there is no room for a word, and the accessory's name is on the title where a
 * pointer and a screen reader both find it. A right-click (or shift) steps
 * backwards, so a ring of nine is not eight clicks away from the one you just
 * passed.
 */
function kitTag(seat) {
  const key = seatAccessory(seat);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sv-teams-kit' + (key ? '' : ' sv-teams-kit-bare');
  // WHICH SEAT THIS IS, on the element. The columns are SIDES, so document
  // order is 0, 2, 1, 3 and nothing outside this function should have to know
  // that to find a seat's controls.
  btn.dataset.seat = String(seat);
  const shot = key ? ACCESSORY_ICONS[key] : null;
  // A background image rather than an <img>, for the drawer's reason: the two
  // states then differ in one property instead of in what is inside the tile.
  btn.style.background = shot ? `url("${shot}") center / contain no-repeat` : '';
  const name = accessoryName(key);
  btn.title = name;
  btn.setAttribute('aria-label', name);
  // A tile with no render is a tile with nothing in it, which reads as broken.
  // The name's first letter is a stand-in until somebody shoots that mesh —
  // the same bargain the drawer's coloured lozenge makes.
  if (!shot) btn.textContent = key ? name.slice(0, 1) : BARE;
  const step = (dir) => { cycleSeatAccessory(seat, dir); feedback('uiClick'); render(); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); step(e.shiftKey ? -1 : 1); });
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); step(-1); });
  return btn;
}

/**
 * THE NAME ON A SLOT — what the seal in seat `i` is called, and (for every
 * seat but the player's own) a dice that re-casts it.
 *
 * The button is a GLYPH rather than a word: it sits inside a 34px row beside a
 * chip and a name, and there is no room for a verb there in any language. The
 * word is on its title, where a pointer and a screen reader can both find it.
 */
function nameTag(seat, rollable) {
  const wrap = document.createElement('span');
  wrap.className = 'sv-teams-name';
  const text = document.createElement('span');
  text.className = 'sv-teams-name-text';
  text.textContent = seatName(seat);
  wrap.appendChild(text);
  if (!rollable) return wrap;
  const dice = document.createElement('button');
  dice.type = 'button';
  dice.className = 'sv-teams-dice';
  dice.dataset.seat = String(seat);
  dice.textContent = DICE;
  dice.title = uiText('teamReroll');
  dice.setAttribute('aria-label', uiText('teamReroll'));
  dice.addEventListener('click', (e) => {
    e.stopPropagation();
    rollSeatName(seat);
    feedback('uiClick');
    render();
  });
  wrap.appendChild(dice);
  return wrap;
}

/**
 * THE PITCH BEHIND THE SCREEN IS OUT OF DATE — a seat added, a colour picked,
 * a name rolled, a hat cycled.
 *
 * Fired from render() rather than from each of the six handlers that change
 * something, because every one of those already ends by re-rendering and a
 * seventh call site is the one somebody forgets. It is the same argument as
 * the rebuild on the other end (refreshRosterPreview): one place, every time.
 */
function changed() {
  callbacks.onChange?.();
}


/** Seconds as a clock — the same shape the strip shows during the match. */
function clockText(s) {
  const whole = Math.max(0, Math.round(s));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function render() {
  if (!el) return;
  // The cast follows the roster: a side grown since the last frame has seats
  // with nobody in them, and a blank where a name goes reads as a bug.
  syncRosterCast();
  const n = matchRoster();
  el.rosterN.textContent = String(n);
  el.rosterLess.disabled = n <= 1;
  el.rosterMore.disabled = n >= ROSTER_MAX;
  // HOW THE MATCH ENDS. The button says which kind it IS rather than which kind
  // it would switch to — a toggle labelled with its own opposite is the oldest
  // way to make somebody press it twice to find out what it does.
  const timed = isTimed();
  el.mode.textContent = timed ? uiText('teamTimed') : uiText('teamFirstTo');
  el.rulesLabel.textContent = timed ? uiText('teamMinutes') : uiText('teamGoals');
  el.rulesN.textContent = timed ? clockText(matchSeconds()) : String(goalsToWin());
  el.rulesLess.disabled = timed ? matchSeconds() <= MIN_SECONDS : goalsToWin() <= MIN_GOALS;
  el.rulesMore.disabled = timed ? matchSeconds() >= MAX_SECONDS : goalsToWin() >= MAX_GOALS;
  // WHERE THE PAD IS ON THESE TWO ROWS — and nowhere at all unless somebody is
  // readied, because a readied device is the only thing that can be driving
  // them (see settingRow). Dropping it here rather than in toggleReady means the
  // one place that has to remember is the one place that draws: un-ready, walk
  // back to the pool, unplug the controller — all three end up here, and a ring
  // left on a row nothing can move is a cursor that has silently gone.
  if (![...devices.values()].some((d) => d.ready)) settingRow = -1;
  settingStops().forEach((stop, i) => stop.node?.classList.toggle('sv-nav-sel', i === settingRow));
  const wheel = palette();
  // Both sides, before anything is drawn: the colours are what the rest of this
  // render reads, and what the pitch behind the screen is about to be told.
  publishColor(0);
  publishColor(1);
  el.wheels.length = 0;
  for (let side = 0; side < 2; side++) {
    const node = el.sides[side];
    const seats = seatsOfTeam(side);
    const c = captain(side);
    // The side's colour is its pick, or wherever its light has walked to — see
    // colorOf. White only before the first beat has landed.
    const color = cssColor(wheel[colorOf(side) ?? -1] ?? 0xffffff);
    node.style.setProperty('--team', color);
    node.classList.toggle('sv-teams-cpu', !c);
    node.textContent = '';
    const slots = document.createElement('div');
    slots.className = 'sv-teams-slots';
    const cap = document.createElement('div');
    cap.className = 'sv-teams-slot sv-teams-captain';
    const chip = document.createElement('span');
    chip.className = 'sv-teams-chip' + (c?.ready ? ' sv-teams-ready' : '');
    chip.textContent = c ? glyph(c) : uiText('teamCpu');
    if (c) { chip.title = label(c); chip.setAttribute('aria-label', label(c)); }
    cap.appendChild(chip);
    if (c?.ready) {
      const stamp = document.createElement('span');
      stamp.className = 'sv-teams-stamp';
      stamp.textContent = READY;
      stamp.title = uiText('teamReady');
      stamp.setAttribute('aria-label', uiText('teamReady'));
      cap.appendChild(stamp);
    }
    // SEAT 0 IS THE ONE NAME WITHOUT A DICE — it is the player's own, off the
    // splash. Every other seat, the far captain included, may be re-cast.
    cap.appendChild(nameTag(seats[0], seats[0] > 0));
    cap.appendChild(kitTag(seats[0]));
    slots.appendChild(cap);
    // THE REST OF THE SIDE. A slot per seat the roster actually has, each with
    // its seal's name and a dice to re-cast it; the seats the roster has NOT
    // grown into yet stay locked, because four a side is the shape this screen
    // is drawn to whatever tonight's number is.
    for (let i = 1; i < MAX_PER_SIDE; i++) {
      const s = document.createElement('div');
      const seat = seats[i];
      if (seat == null) {
        s.className = 'sv-teams-slot sv-teams-locked';
        s.textContent = uiText('teamLocked');
        slots.appendChild(s);
        continue;
      }
      s.className = 'sv-teams-slot';
      const chip = document.createElement('span');
      chip.className = 'sv-teams-chip';
      chip.textContent = uiText('teamCpu');
      s.appendChild(chip);
      s.appendChild(nameTag(seat, true));
      s.appendChild(kitTag(seat));
      slots.appendChild(s);
    }
    node.appendChild(slots);
    // The wheel: every swatch on its ring, the pick swollen, the other side's
    // pick dimmed and dead to the pointer.
    const w = document.createElement('div');
    w.className = 'sv-teams-wheel';
    wheel.forEach((n, i) => {
      const sw = document.createElement('i');
      const { angle, share } = swatchAt(i, wheel.length);
      // PICKED is the ring and the swell that say CHOSEN — an unpicked side has
      // none, because its light walking over a swatch is not the same statement
      // as somebody having taken it.
      sw.className = 'sv-teams-swatch' + (i === picks[side] ? ' sv-teams-picked' : '') + (i === picks[1 - side] ? ' sv-teams-taken' : '');
      sw.style.background = cssColor(n);
      sw.style.color = cssColor(n);
      // THE PLACEMENT IS A CUSTOM PROPERTY, not a finished transform. The beat
      // writes a scale onto the same element every frame (see pulse), and two
      // writers of one `transform` is the last one of the frame winning.
      // In wheel-relative units, so the ring scales with the wheel and nothing
      // here has to know how many pixels that is on this screen.
      sw.style.setProperty('--at', `translate(calc(var(--wheel) * ${(Math.cos(angle) * share).toFixed(4)}), calc(var(--wheel) * ${(Math.sin(angle) * share).toFixed(4)}))`);
      sw.style.setProperty('--pick', i === picks[side] ? '1.5' : '1');
      sw.dataset.i = String(i);
      sw.addEventListener('click', (e) => { e.stopPropagation(); setColor(side, i); });
      w.appendChild(sw);
    });
    node.appendChild(w);
    el.wheels.push(w);
  }
  // The pool: whoever has not chosen a side, and the no-pads line while the
  // keyboard is the only device.
  el.pool.textContent = '';
  const waiting = [...devices.values()].filter((d) => d.side === POOL);
  for (const d of waiting) {
    const chip = document.createElement('span');
    chip.className = 'sv-teams-chip';
    chip.textContent = glyph(d);
    chip.title = label(d);
    chip.setAttribute('aria-label', label(d));
    el.pool.appendChild(chip);
  }
  if (![...devices.values()].some((d) => d.kind === 'pad')) {
    const line = document.createElement('div');
    line.className = 'sv-teams-nopads';
    line.textContent = uiText('teamNoPads');
    el.pool.appendChild(line);
  }
  el.start.disabled = !canStart();
  changed();
}


// --- the beat -----------------------------------------------------------------

/**
 * ONE DOT AT A TIME, WALKING ROUND THE RING — a step per quarter note of
 * whatever is actually playing.
 *
 * This screen starts the match's own bank at the match's own tempo (see
 * enterTeamSelectPitch in main.js), so the beat the light walks on is the one
 * the match will be played to — 170 rather than the library's 106, read off the
 * FILE rather than off CONFIG.music.bpm, which is a different number for a
 * different job (systems/music.js, beatGrid).
 *
 * THE WHOLE WHEEL FLASHING AT ONCE was the first version and it reads as the
 * screen blinking rather than as anything keeping time: twenty-four dots
 * arriving together is one event, and one event repeated is a strobe. A light
 * that MOVES is a thing you can follow, and following it is how you hear the
 * tempo.
 *
 * WHICH DOT is counted in whole beats off the transport's own clock, not by
 * incrementing on each frame that crosses a boundary: frames are dropped, a
 * tab is backgrounded, and a counter that steps per crossing drifts further
 * from the music every time one is missed. Derived, it is right on the frame
 * after a stall as surely as on any other.
 *
 * SILENCE IS STILL AND DARK. beatGrid reports `running: false` before the audio
 * context has been unlocked and after stop(), and a wheel that chased anyway
 * would be keeping time to music nobody can hear — on a phone that has not been
 * touched yet, that is the whole screen.
 */
function pulse() {
  pulseTo(beatGrid());
}

/**
 * The same thing, driven by a grid somebody else is holding — for a harness,
 * and for the same reason systems/ballLook.js is drivable from the shader lab:
 * the transport needs an unlocked audio context and a decoded file, and neither
 * of those is available to a test that wants to ask what the wheel does on beat
 * one hundred.
 */
export function pulseTo(g) {
  if (!el || !g) return;
  // The tail is short and the attack is instant: the light is ON the beat and
  // out of the way well before its neighbour's turn, which is what makes the
  // movement read as a step rather than as a smear round the ring.
  const k = g.running ? (1 - g.phase) ** 2 : 0;
  for (let side = 0; side < el.wheels.length; side++) {
    const w = el.wheels[side];
    const dots = w.children;
    const n = dots.length;
    if (!n) continue;
    // A SIDE THAT HAS PICKED IS DONE. Its colour is chosen and its light is
    // off; leaving it walking would say the choice was still being made.
    const lit = picks[side] == null && g.running ? chaseAt(side, g.beats) : null;
    const moved = lit !== chase[side];
    chase[side] = picks[side] == null ? lit : null;
    for (let i = 0; i < n; i++) {
      dots[i].style.setProperty('--beat', i === lit ? k.toFixed(3) : '0');
    }
    // THE COLUMN FOLLOWS ITS LIGHT, so a side that has not picked is already
    // wearing what it would get — which is the whole of the rule that says
    // pressing nothing takes whatever the light landed on. Written only on the
    // beat it actually moves, not every frame.
    if (!moved || lit == null) continue;
    w.closest('.sv-teams-side')?.style.setProperty('--team', cssColor(palette()[lit] ?? 0xffffff));
    // ...AND THE PITCH BEHIND THE SCREEN FOLLOWS IT — see publishColor. Only on
    // the beat the light actually moved, never per frame.
    if (publishColor(side)) callbacks.onChange?.();
  }
}

// --- lifecycle ----------------------------------------------------------------

/**
 * Open the screen over `parent` (the UI root). `onStart(setup)` fires with
 * versusSetup written; `onBack()` when the player leaves without starting.
 */
export function showTeamSelect({ parent = document.body, onStart, onBack, onChange } = {}) {
  if (!root) build(parent);
  callbacks = { onStart, onBack, onChange };
  devices.clear();
  padPrev.clear();
  devices.set(KEYBOARD, { key: KEYBOARD, kind: 'keyboard', index: -1, side: POOL, ready: false });
  // NOBODY IS ON A COLOUR. The screen used to open with both sides already
  // matched to the shipped green and red by hue, which made the wheel a thing
  // you could ignore — and made the commonest match in the game the one nobody
  // chose the colours of.
  picks[0] = null;
  picks[1] = null;
  chase[0] = null;
  chase[1] = null;
  // ...and nothing is on the settings rows either. A screen that reopened with a
  // ring already drawn would be pointing at a row on behalf of a device that has
  // not readied yet — see settingRow.
  settingRow = -1;
  open = true;
  root.classList.remove('sv-hidden');
  if (!keyHandler) {
    keyHandler = onKey;
    window.addEventListener('keydown', keyHandler, true);
  }
  render();
}

export function hideTeamSelect() {
  open = false;
  root?.classList.add('sv-hidden');
  if (keyHandler) {
    window.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
}

export function teamSelectOpen() { return open; }

/** For tests: the chips as the screen sees them. */
export function teamSelectState() {
  return { picks: [...picks], devices: [...devices.values()].map((d) => ({ ...d })), settingRow };
}
