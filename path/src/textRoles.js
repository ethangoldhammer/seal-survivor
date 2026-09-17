// ============================================================================
// EVERY PIECE OF TEXT THE GAME PUTS ON SCREEN, as a list of ROLES.
//
// A leaf module with no imports, for the same reason ease.js and fonts.js are:
// config.js builds CONFIG.textStyles and the tuner rows out of this, and
// ui/typography.js turns those values back into CSS. Both ends need the list.
//
// A ROLE IS A SELECTOR PLUS A DEFAULT STYLE. The selectors are the classes
// ui/ui.js already writes into the markup — nothing here renames anything, and
// adding a role is a line here plus the class already being in the DOM.
//
// THE DEFAULTS ARE THE AUTHORED DESIGN, transcribed off the CSS in ui/ui.js as
// it stood before this file existed. That matters twice over: it is what makes
// this a redesign tool rather than a redesign, and it is what a Reset in the
// panel snaps back to. If a number here disagrees with ui/ui.js, THIS one wins
// — typography.js writes its stylesheet last.
//
// WHY EVERY ROLE CARRIES EVERY FIELD. The old system had one global weight and
// one global tracking that half the roles quietly overrode in their own CSS, so
// dragging "weight" moved some text and not the rest with nothing on screen to
// say which. Explicit per role is more rows and no mystery. The two things that
// genuinely are global — the family and the ink colour — stay global, and a
// role opts into them with `font: 'global'` and `useInk: true`.
// ============================================================================

// `case` is the CSS text-transform, named for the picker rather than for CSS:
// these strings are the pill labels AND the stored value (the wire format), so
// renaming one unsyncs saved tuning the same way an easing rename would.
export const TEXT_CASES = ['as typed', 'UPPER', 'lower'];

export const CASE_CSS = {
  'as typed': 'none',
  UPPER: 'uppercase',
  lower: 'lowercase',
};

// `font: 'global'` means "whatever CONFIG.typography.family says". It is a
// sentinel rather than an empty string so it can be a visible pill in the
// picker sitting alongside the real families.
export const FONT_GLOBAL = 'global';

// THE TWO TOOLTIPS DO NOT TAKE THE GLOBAL FAMILY, and this is why.
//
// Every other role is a voice — a title, a shout, a number flying off a kill —
// and a display face is what those are FOR. The tooltips are the one surface
// that is neither: they are a table of measurements the player reads at a
// glance, mid-decision, at 11-13px, and on a phone that is the smallest type in
// the game rendered on the least forgiving screen.
//
// With the family global they wore whatever the Text panel was set to, and a
// pixel face is the case that breaks: 'Press Start 2P' at 13.5px has one-pixel
// strokes, the card tooltip's `scan` mask cuts every third row of them, and the
// role's own glow plus the retro CRT bloom fill in what is left. The box reads
// as a lit smudge with no letters in it — measured at 375px wide, the shipped
// tip was also 377px across, wider than the phone it was on, where the same
// content in Inter is 205px.
//
// SO `ownFont` IS WHAT `global` MEANS ON THOSE TWO ROWS, rather than the two
// styles below simply naming Inter. That difference is the whole design of the
// fix. Their stored `font` stays the `global` sentinel it has always been, so
// no saved snapshot is unsynced and nothing has to be edited out of
// imported-tuning.json to make this reach an already-tuned game — see
// tuning-file-edits-lose-the-race, and the note on `scanGlow` below. The Text
// panel's picker is untouched: choose a real family for the tip rows and it
// still wins here, exactly as it does everywhere else. Only the fallback moved.
//
// Written out rather than imported because this file has no imports (see the
// header). It must stay character for character the `stack` of the Inter entry
// in fonts.js, or the picker will not show it as the selected pill.
const FONT_TIP = "'Inter', system-ui, sans-serif";

// `scan` — THE SHADOW MASK, per role. 0 is off, and it is off everywhere but
// the menu buttons.
//
// The global Retro treatment (CONFIG.typography.retro) lays one scanline sheet
// over the WHOLE screen at `mix-blend-mode: multiply`, which is a picture tube
// the game is being watched on. This is a different thing wearing the same
// stripe: the glyphs THEMSELVES are cut into lines, so the words read as
// something lit rather than something printed — a phosphor sign behind a
// shadow mask. Both can be on at once and they compose; neither replaces the
// other.
//
// It is a MASK on the element, so it takes the role's glow with it — which is
// the half that sells it. A scanline over the letters and an untouched halo
// around them looks like a decal laid on top of the type.
//
// `scanGap` is the period in px (line + gap), so 3 is the tube's own pitch and
// anything much above 6 stops being a raster and starts being a blind. The
// lines are in the ELEMENT's space, so they scale with a label that has been
// shrunk to fit its cell (see `fit`) rather than staying nailed to the screen.
// At the sizes anything here is set to, that is a difference you have to
// measure rather than see.
//
// `scanGlow` is the halo the treatment brings WITH it, and it is not the same
// control as `glow` above. The mask cuts the role's own bloom exactly as it
// cuts the letters, so a role that is scanned and not glowed is simply a dimmer
// role — the light has to be bright enough that what survives BETWEEN the lines
// still reads as lit. Kept separate rather than folded into `glow` because it
// belongs to the treatment: turn `scan` off and this should go with it, while
// `glow` is what the type does on its own.
//
// It is also, bluntly, the only one of the two that can reach a game somebody
// has already tuned: `glow` is in every saved snapshot and a new default for it
// would be overwritten on load, while a field the snapshot has never heard of
// arrives. See tuning-file-edits-lose-the-race — the same reason
// `dayNight.orbit.parallax` had to become `drift`.

/**
 * size      px at scale 1 — multiplied by CONFIG.typography.scale at render.
 * weight    absolute CSS font-weight. Single-weight display faces ignore it.
 * tracking  letter-spacing in em.
 * case      one of TEXT_CASES.
 * useInk    true = take CONFIG.typography.color; false = use `color` below.
 * color     the role's own hex, used when useInk is off.
 * alpha     applied to whichever of the two colours won.
 * shadow    px of dark drop shadow. 0 = none at all, not "a small one".
 * glow      px of bloom in the text's OWN colour (currentColor).
 * fit       true only for the upgrade cards: their type is additionally scaled
 *           per card by --sv-fit so a long name shrinks to fit the hex
 *           (ui.js, fitCardText). Multiplied in rather than replacing scale.
 * unit      'vmin' on a role whose size is a share of the screen rather than
 *           px — see the Blubberball roles. The slider is in that unit.
 * floor     px the size never drops under (only with unit: 'vmin').
 * plate     'glass' draws the specimen on a frosted pane, for type that is
 *           black on glass and would vanish on the panel's dark strip.
 * sampleFrom  a uiText.csv id the specimen's words come from, so the line on
 *           the panel is the line the player reads; `{name}` in it is filled
 *           with the longest seal name the roster can cast.
 * ownFont   the family a role falls back to when its `font` is the `global`
 *           sentinel, instead of CONFIG.typography.family. Only the two
 *           tooltips carry one — see FONT_TIP above for why.
 * inlineColor  true where ui.js writes `style.color` per element and would win
 *           over any rule here anyway — the "STRIKE NOW!" prompt on the ring
 *           walks the chain's hue wheel, and the FOOD CHAIN! banner is pinned
 *           to one colour that lives with the mechanic rather than with the
 *           type. typography.js emits no `color` for these roles: two writers
 *           on one property, where one of them silently never wins, is a bug
 *           that costs an afternoon.
 * colorFrom A dotted CONFIG path the LIVE colour of an inlineColor role comes
 *           from. The Text panel's specimen reads it so the swatch is what the
 *           game actually draws — without it the panel shows the role's stored
 *           colour, which for an inlineColor role is by definition NOT what is
 *           on screen. (It showed the chain banner in gold for a while after
 *           the banner stopped being gold, and a saved tuning snapshot means
 *           correcting the stored value would not have fixed it — see
 *           pruneUnknownKeys and the notes about renames in config.js.)
 *           Absent where the live colour is not a single CONFIG value, which is
 *           the prompt's case: it is a hue wheel, and its stored colour is at
 *           least the start of that wheel.
 */
export const TEXT_ROLES = [
  // --- screens: menus, the score card, the pause menu -----------------------
  { key: 'title', label: 'Menu title', selector: '.sv-title', section: 'Screens',
    sample: 'FOOD CHAIN',
    style: { font: FONT_GLOBAL, size: 30, weight: 700, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // THE SCORE CARD'S QUIP IS ITS OWN ROLE, and the reason is the lockup rather
  // than taste. `title` is a banner centred over a narrow menu; this one shares
  // a line with a 46px score on a card twice that wide, and at the banner's
  // size the longest quip in quips.csv ("Get ready to learn yoga, buddy!")
  // wrapped to FOUR lines of the pixel face and pushed the readout off a
  // laptop. Sized for the lockup instead, and still a row in the Text panel —
  // the alternative was a hard-coded px in ui.js that beat the panel silently,
  // on the one line of type in the game that is the game's own voice.
  //
  // The selector is two classes deep on purpose: it has to win against
  // `title`'s own rule, which is in the same sheet and matches the same node.
  { key: 'quip', label: 'Score card quip', selector: '.sv-ldg-head .sv-title', section: 'Screens',
    sample: "You're the Chum Now, Dog",
    style: { font: FONT_GLOBAL, size: 22, weight: 700, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'sub', label: 'Menu body', selector: '.sv-sub', section: 'Screens',
    sample: 'Eat everything smaller than you.',
    style: { font: FONT_GLOBAL, size: 13, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.6, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'button', label: 'Buttons', selector: '.sv-btn', section: 'Screens',
    sample: 'Try again',
    // Dark on purpose: the button's fill is the pale blue, so this is the one
    // role whose text goes DOWN in value rather than up.
    style: { font: FONT_GLOBAL, size: 14, weight: 600, tracking: 0.02, case: 'as typed', useInk: false, color: 0x0a0c12, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'hint', label: 'Hints', selector: '.sv-hint', section: 'Screens',
    sample: 'WASD to swim — space to strike',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.35, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // The splash's blob menu (systems/gooMenu.js). Its own role rather than
  // `button`: those are pale plates with dark text on them, and these are
  // labels sitting ON a translucent bubble, so they want the opposite treatment
  // — light, tracked out, and carrying a shadow the flat buttons never need.
  // `fit: true` — the same per-element shrink the upgrade cards use (see
  // fitCardText in ui/ui.js): the role's size is multiplied by --sv-fit, which
  // whatever mounts the labels sets per button. A hexagon is a narrow thing to
  // put a word in, and "Leader Boards" does not fit one at the size the rest of
  // the row wants to be.
  // THE MAIN MENU'S BUTTONS. The one role in the game that is lit rather than
  // printed: it sits on a fresnel film over open water with nothing else on
  // screen, so it can afford to be the brightest thing in the frame and it has
  // to be, or it reads as a caption on a button rather than as the button's
  // own face.
  //
  // Off the global ink on purpose — the ink is a legibility grey chosen to sit
  // on panels, and this wants to be the colour the hexagon goes when it is hot
  // (CONFIG.splashBust.menu.hot), so the word and the tile it is in are lit by
  // the same light. Heavier and wider than it was: at 13px/700 inside a cell
  // this size the type was a label, and the hexagon was the object.
  //
  // `glow` past the shadow, and then `scan` cutting both — see the note on
  // scan above. The halo is what survives the mask between the lines, so the
  // two are one decision: raising the scan without raising the glow just makes
  // the word dimmer.
  { key: 'blobButton', label: 'Splash blob button', selector: '.sv-blob-label', section: 'Screens',
    sample: 'LEADER\nBOARDS', fit: true,
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.16, case: 'UPPER', useInk: true, color: 0xeaf7ff, alpha: 1, shadow: 6, glow: 0, scan: 0.55, scanGap: 3, scanGlow: 16 } },
  { key: 'board', label: 'Leaderboard row', selector: '.sv-lb-row', section: 'Screens',
    sample: '1   SEAL   184,200',
    style: { font: FONT_GLOBAL, size: 12, weight: 400, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'status', label: 'Status line', selector: '.sv-status', section: 'Screens',
    sample: 'Posting your run…',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0.03, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.5, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- the loading screen: the first type anybody sees ---------------------
  // THE ONLY SURFACE THAT IS UP BEFORE THE GAME EXISTS, which is why these two
  // were hard-coded Inter in ui/loading.js for as long as that screen has had
  // words on it: the Text panel's sheet is written by initTypography, and that
  // used to run three hundred lines of boot AFTER the bar went up. It runs
  // first now (see boot() in main.js), so the loading screen wears the game's
  // face like everything else and these are ordinary rows.
  //
  // loading.js still carries the LAYOUT for both — where the line sits, how
  // wide it may be, the height reserved for a second line, the crossfade — and
  // none of the type. Its stylesheet is inserted BELOW the role sheet
  // (installStyleBelowRoles' rule, applied by hand there because the screen
  // builds and removes its own <style>), so a declaration that overlapped
  // would beat the panel silently. Keep them disjoint.
  //
  // `sample` is absent on the tip on purpose: its words are loadTips.csv, read
  // live by the panel the same way the warning band reads callouts.csv, and a
  // hand-typed stand-in here would be a line of the game's voice written in a
  // source file. The caption's is `sampleFrom`, one row of uiText.csv — the
  // line the player actually reads on a resumed boot.
  //
  // A DARK SHADOW AND FULL ALPHA, unlike the rest of the Screens block, and
  // both were measured rather than chosen. Every other menu role sits on a
  // panel; these two sit on open water at the top of the boot with the retro
  // treatment's own 14px halo over them (CONFIG.typography.retro is on). At
  // 0.88 alpha and no shadow the tip was a smudge with no letterforms in it —
  // a long line spread over 480px, where the caption's short dense word
  // survives the same halo because its glyphs reinforce each other. The dark
  // pass under the glow is what holds the edges. Judged on npm run looks:loading,
  // which renders this file's values through the real module.
  { key: 'loadTip', label: 'Loading tip', selector: '.sv-load-tip-line', section: 'Loading',
    style: { font: FONT_GLOBAL, size: 15, weight: 500, tracking: 0.01, case: 'as typed', useInk: false, color: 0xceeafc, alpha: 1, shadow: 8, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // The resume line under the bar. Its own role rather than a size on the tip:
  // the two are different registers on one screen — the tip is the thing you
  // are meant to read, the caption is the screen saying what it is doing — and
  // the whole design of that screen is that a resumed boot and a cold one are
  // one composition with one line of difference. Tuning them together would
  // make it impossible to widen that difference.
  { key: 'loadCaption', label: 'Loading caption', selector: '.sv-load-cap', section: 'Loading',
    sampleFrom: 'loadResuming',
    style: { font: FONT_GLOBAL, size: 13, weight: 500, tracking: 0.02, case: 'as typed', useInk: false, color: 0x7ad7ff, alpha: 0.72, shadow: 6, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- the HUD: read at a glance, mid-fight --------------------------------
  { key: 'label', label: 'HUD label', selector: '.sv-label', section: 'HUD',
    sample: 'Score',
    style: { font: FONT_GLOBAL, size: 10, weight: 500, tracking: 0.06, case: 'UPPER', useInk: true, color: 0xe8ecf3, alpha: 0.55, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'value', label: 'HUD number', selector: '.sv-value', section: 'HUD',
    sample: '184,200',
    style: { font: FONT_GLOBAL, size: 20, weight: 600, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // Inside the xp track now, not beside it, and the track grows to fit this —
  // so this size is what makes the bar thick. Small on purpose.
  { key: 'level', label: 'Level in xp bar', selector: '.sv-xptop-level', section: 'HUD',
    sample: 'Level 7',
    style: { font: FONT_GLOBAL, size: 8, weight: 600, tracking: 0.1, case: 'UPPER', useInk: true, color: 0xe8ecf3, alpha: 0.5, shadow: 4, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'bossName', label: 'Boss name', selector: '.sv-boss-name', section: 'HUD',
    sample: 'THE OLD MAN OF THE REEF',
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.14, case: 'UPPER', useInk: false, color: 0xffd7d7, alpha: 1, shadow: 4, glow: 12, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- upgrade cards: the only type that resizes itself --------------------
  { key: 'cardName', label: 'Card name', selector: '.sv-card-name', section: 'Upgrade cards',
    sample: 'Barnacle Plating', fit: true,
    style: { font: FONT_GLOBAL, size: 15, weight: 700, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 4, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'cardDesc', label: 'Card text', selector: '.sv-card-desc', section: 'Upgrade cards',
    sample: '+18% armour, and chum sticks to you.', fit: true,
    style: { font: FONT_GLOBAL, size: 13, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.92, shadow: 4, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // THE TWO TOOLTIPS. One builder (ui/upgradeTip.js) fills both, but they are
  // two roles because they are two surfaces sized against different things:
  // the card tooltip hangs under a hexagon that already carries the name and
  // the description, so it is the breakdown alone and can afford a bigger
  // face; the hive tooltip floats beside a bare tile, has to carry the name
  // as well, and has to stay small enough to sit inside the hive.
  //
  // Neither `fit`s: the card's own type shrinks to its hexagon, the tooltip
  // is a box outside it. Every size INSIDE the box — the name, the stack count,
  // the row labels — is written in em in ui.js, so the one number here moves
  // all of them together. The row accents (the stack pip, the "next" value)
  // keep their own colour: they are the panel's blue, not the type's ink.
  { key: 'cardTip', label: 'Card tooltip', selector: '.sv-card-fx', section: 'Upgrade cards',
    ownFont: FONT_TIP,
    sample: 'NEXT  +6 more orbiting shrimp',
    style: { font: FONT_GLOBAL, size: 13, weight: 400, tracking: 0, case: 'as typed', useInk: false, color: 0xcfeaff, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'hiveTip', label: 'Hive tooltip', selector: '.sv-uptip', section: 'Upgrade cards',
    ownFont: FONT_TIP,
    sample: 'Barnacle Plating  ×3',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0, case: 'as typed', useInk: false, color: 0xcfeaff, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- popups: the numbers that fly off the kills --------------------------
  // `motion` names the CONFIG.textMotion block this role flies on. The Text
  // panel's specimen plays it on a loop, which is what makes an APPEAR or LEAVE
  // row visible without firing a burst into the game and watching it go past.
  { key: 'score', label: 'Score popup', selector: '.sv-toast', section: 'Popups',
    sample: '+420', motion: 'score',
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.02, case: 'as typed', useInk: false, color: 0xffffff, alpha: 1, shadow: 8, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // Rendered on top of the score popup — the node carries BOTH classes — so
  // this must stay after it in the list. typography.js writes the rules in
  // exactly this order, and the two selectors are the same weight.
  { key: 'combo', label: 'Combo popup', selector: '.sv-toast-combo', section: 'Popups',
    sample: '+1,680', motion: 'combo',
    style: { font: FONT_GLOBAL, size: 15, weight: 700, tracking: 0.02, case: 'as typed', useInk: false, color: 0xffe066, alpha: 1, shadow: 8, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'chain', label: 'Chain banner', selector: '.sv-chain', section: 'Popups',
    sample: 'FOOD CHAIN! ×6', inlineColor: true, motion: 'chain',
    // ONE COLOUR, and it lives with the mechanic rather than with the type:
    // the banner used to walk the chain's hue wheel and two depths a lap were
    // unreadable over open water. See CONFIG.strike.foodChain.color.
    colorFrom: 'strike.foodChain.color',
    // 900 with the Strike prompt, and heavier than the warning band's 800 on
    // purpose: the food chain is its own voice, and it should be recognisable
    // as one before a word of it has been read.
    style: { font: FONT_GLOBAL, size: 21, weight: 900, tracking: 0.1, case: 'UPPER', useInk: false, color: 0xffe066, alpha: 1, shadow: 10, glow: 16, scan: 0, scanGap: 3, scanGlow: 0 } },
  // AN UPGRADE PAYING OUT — "MANEATER +12%", fired by a `toast` channel on a
  // feedback event (systems/feedback.js). Cool where the chain banner is a hot
  // green, and well under half its size: both ride the same layer, and a proc reading
  // as loudly as a chain extension would have the quietest event in the game
  // shouting over the loudest. It is a receipt, and a receipt is read once.
  { key: 'proc', label: 'Upgrade proc', selector: '.sv-proc', section: 'Popups',
    sample: 'MANEATER +12%', motion: 'proc',
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.08, case: 'UPPER', useInk: false, color: 0x9fe3ff, alpha: 1, shadow: 8, glow: 10, scan: 0, scanGap: 3, scanGlow: 0 } },
  // WHAT A HIT COST — the only place the amount of damage taken is ever written
  // down. See CONFIG.fx.playerDamage.readout for the mechanic and
  // CONFIG.textMotion.dmg for the movement.
  //
  // `inlineColor`, because the line runs hotter with the size of the hit and
  // ui.js writes that colour per element. What is set HERE is the bottom of
  // that ramp — the colour of the smallest hit worth printing — and `colorFrom`
  // points the Text panel's swatch at the top of it, so the panel shows a live
  // colour rather than one that has not been what the player sees since the
  // ramp was added.
  //
  // BIGGER AND HEAVIER THAN THE SCORE POPUP, and that is the whole hierarchy
  // argument. A kill is worth a small white number because there are twelve of
  // them and none is read alone; being bitten happens once and has to be read
  // once. Still under the warning band's 24 — an alarm is a sentence about the
  // run, this is a figure about a moment.
  { key: 'dmg', label: 'Damage taken', selector: '.sv-dmg', section: 'Popups',
    sample: '-24', inlineColor: true, motion: 'dmg',
    colorFrom: 'fx.playerDamage.readout.colorHot',
    style: { font: FONT_GLOBAL, size: 19, weight: 800, tracking: 0.03, case: 'as typed', useInk: false, color: 0xff9a7a, alpha: 1, shadow: 10, glow: 12, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- the band: the one line that is not about the score ------------------
  // Screen-anchored rather than flying off a kill, but it is the same node
  // machinery and the same motion curves, so it belongs with the popups here.
  //
  // `case` is left AS TYPED, unlike the two banners above. The warnings are
  // written with their own capitals in callouts.csv ("Boost Empty!" next to
  // "Oxygen low!"), and a transform here would quietly overrule whoever chose
  // them. Set it to UPPER in the panel if the band should shout.
  { key: 'warn', label: 'Warning band', selector: '.sv-callout', section: 'Popups',
    sample: 'Oxygen low!', motion: 'warn',
    style: { font: FONT_GLOBAL, size: 24, weight: 800, tracking: 0.1, case: 'as typed', useInk: false, color: 0xff5566, alpha: 1, shadow: 10, glow: 18, scan: 0, scanGap: 3, scanGlow: 0 } },
  // Rendered on top of the warning band — the node carries BOTH classes — so
  // this must stay after it in the list, exactly as the combo popup does. Cold
  // where the warning is hot: a tip is not an alarm, and the colour is the
  // fastest way to tell the two apart before either has been read.
  //
  // `compact` — this is the one voice that gets SMALLER in a hand. A first-run
  // tip is read once and then never again, and on a phone it is read over the
  // top of the fight it is explaining; at the desktop size it is the loudest
  // thing on a 375px screen, which puts the tutorial where the game should be.
  // The factor is --sv-tipScale, set per breakpoint in ui.js. Nothing else in
  // the game shrinks this way on purpose: a warning that got quieter on the
  // screen it matters most on would be exactly backwards.
  { key: 'coach', label: 'First-run tip', selector: '.sv-callout-coach', section: 'Popups',
    sample: 'Swim up for air', motion: 'coach', compact: true,
    style: { font: FONT_GLOBAL, size: 20, weight: 700, tracking: 0.04, case: 'as typed', useInk: false, color: 0x9fe3ff, alpha: 1, shadow: 10, glow: 12, scan: 0, scanGap: 3, scanGlow: 0 } },
  // A ROLE OF ITS OWN, not a size on the warning band, because it is not on the
  // band at all: it rides just above the boost ring on the seal (callouts.csv,
  // `anchor`). Small on purpose — it sits on the instrument it is about, where
  // the answer already is, so it has to be legible at a glance and nothing
  // more. Its colour is the ring's own warm gold rather than the alarm red, so
  // it reads as that gauge talking rather than as a fifth emergency.
  { key: 'boostWarn', label: 'Boost warning', selector: '.sv-callout-boost', section: 'Popups',
    sample: 'Boost Empty!', motion: 'boostWarn',
    style: { font: FONT_GLOBAL, size: 12, weight: 700, tracking: 0.08, case: 'as typed', useInk: false, color: 0xffc65a, alpha: 1, shadow: 6, glow: 8, scan: 0, scanGap: 3, scanGlow: 0 } },
  // Rendered on top of the boost warning — the node carries BOTH classes — so
  // this must stay after it in the list, exactly as the coach tip does over the
  // band. It is the SAME SLOT on the ring and a completely different message,
  // and the two used to be indistinguishable: "Boost Empty!" is the gauge
  // reporting a fact, and "STRIKE NOW!" is the FOOD CHAIN asking for an input
  // inside a tenth of a second.
  //
  // SO IT IS DRESSED AS FOOD CHAIN, not as boost. Heaviest weight in the game
  // and UPPER, matched to the FOOD CHAIN! banner, and `inlineColor` because it
  // wears the live chain's own hue — ui/callout.js writes it per frame off the
  // same wheel the banner and the ring's arc are on (systems/chainColor.js).
  // The colour here is only what the role falls back to before a run starts.
  { key: 'strikeNow', label: 'Strike prompt', selector: '.sv-callout-strike', section: 'Popups',
    sample: 'STRIKE NOW!', inlineColor: true, motion: 'strikeNow',
    style: { font: FONT_GLOBAL, size: 14, weight: 900, tracking: 0.14, case: 'UPPER', useInk: false, color: 0xffe066, alpha: 1, shadow: 6, glow: 14, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- Blubberball: the match --------------------------------------------
  // Every line the two-seal ball game puts up (systems/versus.js). These were
  // hard-coded px and vmin in that file's own stylesheet, which meant the one
  // panel built for designing type could not reach a single word of the mode.
  //
  // `unit: 'vmin'` — THE SIZE SLIDER IS IN VMIN, NOT PX, on the roles that
  // are sized to the screen. The countdown numeral and the goal card were
  // authored in vmin on purpose (a "3" that is 26% of the shorter edge on a
  // phone and on a monitor), and converting them to px would trade a
  // responsive design for a slider. The global scale still multiplies.
  // `floor` is the px the size can never drop under — the prompt after a
  // match has to stay a tap target in a phone held sideways, where vmin alone
  // shrinks it under 44px. Both are constants of the role, like `fit`.
  //
  // `plate: 'glass'` — THE SPECIMEN IS DRAWN ON THE PANE IT IS READ ON. The
  // goal card and the replay tag are BLACK type on a light frosted pane
  // (see the .sv-glass block in versus.js); on the Text panel's dark strip
  // that is invisible, and a role you cannot see is a role you tune blind.
  //
  // `sampleFrom` — the specimen's words are that row of uiText.csv, filled
  // by the panel rather than typed here (this file has no imports). The line
  // Ethan writes is the line the specimen shows, and a lorem row shows as
  // lorem, which is the point. `{name}` in the row is filled with the longest
  // name sealNames.csv can produce, because the worst case is the case that
  // decides the type.
  //
  // THE TEAM COLOUR IS INLINE. The score strip's two sides and the READY
  // stamp are painted in whichever colour each side picked on the team
  // select — written per element (style.color on the side, var(--team) on
  // the stamp), so those roles are `inlineColor` and the swatch here is only
  // what P1 wears before anybody picks. `colorFrom` points the specimen at
  // the shipped P1 colour so it is at least a colour the game draws.
  { key: 'vsScore', label: 'Match score', selector: '.sv-versus-score', section: 'Blubberball',
    sample: '3', inlineColor: true, colorFrom: 'versus.teams.0.color',
    style: { font: FONT_GLOBAL, size: 34, weight: 700, tracking: 0, case: 'as typed', useInk: false, color: 0x3ddc63, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'vsClock', label: 'Match clock', selector: '.sv-versus-clock', section: 'Blubberball',
    sample: '2:47',
    style: { font: FONT_GLOBAL, size: 22, weight: 700, tracking: 0.02, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.92, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // The kickoff count. Two roles on one node: the numerals, and the whistle
  // line that follows them (`.sv-versus-go` is added for the last pop). The
  // whistle's selector is two classes deep so it beats the numeral's rule on
  // the same element — same trick as the score card quip above.
  { key: 'vsCount', label: 'Kickoff countdown', selector: '.sv-versus-count', section: 'Blubberball',
    sample: '3', unit: 'vmin',
    style: { font: FONT_GLOBAL, size: 26, weight: 800, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 16, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'vsGo', label: 'Kickoff whistle', selector: '.sv-versus-count.sv-versus-go', section: 'Blubberball',
    sampleFrom: 'versusGo', sample: 'Go!', unit: 'vmin',
    style: { font: FONT_GLOBAL, size: 16, weight: 800, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 16, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // THE MATCHUP CARD under the count on the opening kickoff. The names are
  // painted in each side's own kit colour, written per element the way the
  // score is — so this role is `inlineColor` too, and its swatch is only what
  // P1 wears before anybody picks.
  { key: 'vsTeamName', label: 'Kickoff team name', selector: '.sv-versus-teams-name', section: 'Blubberball',
    sample: 'Green Blubberbusters', unit: 'vmin', floor: 15, inlineColor: true, colorFrom: 'versus.teams.0.color',
    style: { font: FONT_GLOBAL, size: 3.4, weight: 800, tracking: 0.02, case: 'as typed', useInk: false, color: 0x3ddc63, alpha: 1, shadow: 14, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'vsTeamVs', label: 'Kickoff matchup word', selector: '.sv-versus-teams-vs', section: 'Blubberball',
    sampleFrom: 'versusKickoffVs', sample: 'vs', unit: 'vmin', floor: 11,
    style: { font: FONT_GLOBAL, size: 2, weight: 700, tracking: 0.1, case: 'upper', useInk: true, color: 0xe8ecf3, alpha: 0.8, shadow: 12, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // THE GOAL CARD — three lines of black type on the scoring team's glass.
  // No shadow on any of them: a dark shadow under black type on a light pane
  // reads as dirt, which is the first thing the glass was built to get rid of.
  //
  // THERE WAS A FOURTH, `vsCardWin`: the winner line this card turned into at
  // the final whistle. The result is on the stats page now (the champion block
  // in rive/blubberball/stats-page.rml), and type inside a Rive artboard has no
  // DOM node for a role to measure — its sizes are the Theme view model in
  // data.rml instead. So the role is gone rather than pointing at a selector
  // nothing builds, which is a specimen that silently measures zero.
  { key: 'vsCardName', label: 'Goal card — scorer', selector: '.sv-versus-card-name', section: 'Blubberball',
    sample: '{name}', unit: 'vmin', plate: 'glass',
    style: { font: FONT_GLOBAL, size: 3.6, weight: 700, tracking: 0.02, case: 'as typed', useInk: false, color: 0x05070a, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'vsCardLine', label: 'Goal card — assist line', selector: '.sv-versus-card-line', section: 'Blubberball',
    sampleFrom: 'versusAssist', sample: 'Assisted by {name}', unit: 'vmin', plate: 'glass',
    style: { font: FONT_GLOBAL, size: 2.4, weight: 600, tracking: 0.02, case: 'as typed', useInk: false, color: 0x05070a, alpha: 0.88, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'vsCardTime', label: 'Goal card — clock', selector: '.sv-versus-card-time', section: 'Blubberball',
    sample: '1:52', unit: 'vmin', plate: 'glass',
    style: { font: FONT_GLOBAL, size: 2.4, weight: 600, tracking: 0.02, case: 'as typed', useInk: false, color: 0x05070a, alpha: 0.74, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // NO ROLES FOR THE PLAY-AGAIN PROMPT, for the same reason `vsCardWin` has
  // none: the prompt was a DOM panel under the highlight reel (a
  // `.sv-versus-over` column with an `Again?` heading over two buttons) and it
  // lives on the stats page now, which is a Rive artboard sized by the Theme
  // view model rather than by a tuner row. Its three lines did not move — see
  // the note in ui/statsCopy.js, which still reads `versusOverTitle`,
  // `versusRematch` and `mainMenuButton` off uiText.csv — but the selectors
  // `vsOverTitle` and `vsOverButton` named are gone from the markup, and a role
  // is a selector plus a default: one nobody's markup wears is a group of
  // sliders that move nothing. npm run test:textdesign is what caught it.
  // THE CORNER TAG — on the instant replay, and (reel) on the highlight reel
  // under the prompt, where it is smaller and has no skip line under it.
  { key: 'vsReplayTag', label: 'Replay tag', selector: '.sv-versus-replay-tag', section: 'Blubberball',
    sampleFrom: 'versusReplay', sample: 'Replay', plate: 'glass',
    style: { font: FONT_GLOBAL, size: 18, weight: 700, tracking: 0.08, case: 'UPPER', useInk: false, color: 0x05070a, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // Alpha 1 here on purpose: the skip line's opacity is written per frame by
  // versus.js (paintSkip) — it brightens from 0.7 to 1 as the hold registers,
  // which is the mechanic's feedback and not the type's — and an alpha in the
  // colour on top of that would dim the rest state twice.
  { key: 'vsReplaySkip', label: 'Replay skip prompt', selector: '.sv-versus-replay-skip', section: 'Blubberball',
    sampleFrom: 'versusReplaySkip', sample: 'Hold to skip', plate: 'glass',
    style: { font: FONT_GLOBAL, size: 12, weight: 600, tracking: 0, case: 'as typed', useInk: false, color: 0x05070a, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'vsReelTag', label: 'Highlight reel tag', selector: '.sv-versus-reel .sv-versus-replay-tag', section: 'Blubberball',
    sampleFrom: 'versusReelCheck', sample: 'Blubber check', unit: 'vmin', floor: 13, plate: 'glass',
    style: { font: FONT_GLOBAL, size: 1.6, weight: 700, tracking: 0.08, case: 'UPPER', useInk: false, color: 0x05070a, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },

  // --- Blubberball: the team select -------------------------------------
  // The screen before the match (ui/teamSelect.js). Its heading is `title`
  // and its Back / Start are `button`, so neither is repeated here; these are
  // the lines that are its own.
  { key: 'tsHint', label: 'Team select hint', selector: '.sv-teams-hint', section: 'Team select',
    sampleFrom: 'teamSelectHint', sample: 'Select Team',
    style: { font: FONT_GLOBAL, size: 12, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.6, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'tsChip', label: 'Team select device chip', selector: '.sv-teams-chip', section: 'Team select',
    sampleFrom: 'teamKeyboard', sample: 'Keyboard',
    style: { font: FONT_GLOBAL, size: 13, weight: 600, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'tsStamp', label: 'Team select READY stamp', selector: '.sv-teams-stamp', section: 'Team select',
    sampleFrom: 'teamReady', sample: 'Ready', inlineColor: true, colorFrom: 'versus.teams.0.color',
    style: { font: FONT_GLOBAL, size: 10, weight: 400, tracking: 0.08, case: 'UPPER', useInk: false, color: 0x3ddc63, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // A seal's name on a slot: the captain's row is a size up from the bench.
  // Two roles, because that step IS the hierarchy of the column.
  { key: 'tsCaptainName', label: 'Team select captain name', selector: '.sv-teams-captain .sv-teams-name-text', section: 'Team select',
    sample: '{name}',
    style: { font: FONT_GLOBAL, size: 13, weight: 600, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'tsSlotName', label: 'Team select bench name', selector: '.sv-teams-name-text', section: 'Team select',
    sample: '{name}',
    style: { font: FONT_GLOBAL, size: 12, weight: 400, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.85, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'tsLocked', label: 'Team select locked slot', selector: '.sv-teams-slot.sv-teams-locked', section: 'Team select',
    sampleFrom: 'teamLocked', sample: 'Locked',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0.06, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.35, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  // The two settings rows under the board — "Per side", "on the clock" —
  // one role for both, because they are one register: a label beside a
  // number beside a pair of steppers.
  { key: 'tsRow', label: 'Team select settings row', selector: '.sv-teams-roster', section: 'Team select',
    sampleFrom: 'teamRoster', sample: 'Per side',
    style: { font: FONT_GLOBAL, size: 12, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.75, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
  { key: 'tsNoPads', label: 'Team select no-pads line', selector: '.sv-teams-nopads', section: 'Team select',
    sampleFrom: 'teamNoPads', sample: 'Press a key/button.',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.55, shadow: 0, glow: 0, scan: 0, scanGap: 3, scanGlow: 0 } },
];

/**
 * The CSS size unit a role's `size` is in. 'px' unless the role says
 * otherwise — see `unit` on the Blubberball roles.
 */
export function roleUnit(role) {
  return role?.unit === 'vmin' ? 'vmin' : 'px';
}

export const TEXT_ROLE_KEYS = TEXT_ROLES.map((r) => r.key);

const BY_KEY = new Map(TEXT_ROLES.map((r) => [r.key, r]));

/** The role with this key, or null. */
export function textRole(key) {
  return BY_KEY.get(key) ?? null;
}

/**
 * A fresh copy of every role's default style, shaped as CONFIG.textStyles.
 * Called once, by config.js, to declare the section — so DEFAULTS captures it
 * and pruneUnknownKeys knows the shape is real rather than user entries.
 */
export function defaultTextStyles() {
  return Object.fromEntries(TEXT_ROLES.map((r) => [r.key, { ...r.style }]));
}
