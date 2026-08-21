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
  { key: 'coach', label: 'First-run tip', selector: '.sv-callout-coach', section: 'Popups',
    sample: 'Swim up for air', motion: 'coach',
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
];

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
