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
 *           over any rule here anyway — the chain banner ramps gold to orange
 *           with the link count. The role's colour is still read: it is the
 *           BOTTOM of that ramp (see CONFIG.textMotion.chain.colorHot).
 */
export const TEXT_ROLES = [
  // --- screens: menus, the score card, the pause menu -----------------------
  { key: 'title', label: 'Menu title', selector: '.sv-title', section: 'Screens',
    sample: 'FOOD CHAIN',
    style: { font: FONT_GLOBAL, size: 30, weight: 700, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0 } },
  { key: 'sub', label: 'Menu body', selector: '.sv-sub', section: 'Screens',
    sample: 'Eat everything smaller than you.',
    style: { font: FONT_GLOBAL, size: 13, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.6, shadow: 0, glow: 0 } },
  { key: 'button', label: 'Buttons', selector: '.sv-btn', section: 'Screens',
    sample: 'Try again',
    // Dark on purpose: the button's fill is the pale blue, so this is the one
    // role whose text goes DOWN in value rather than up.
    style: { font: FONT_GLOBAL, size: 14, weight: 600, tracking: 0.02, case: 'as typed', useInk: false, color: 0x0a0c12, alpha: 1, shadow: 0, glow: 0 } },
  { key: 'hint', label: 'Hints', selector: '.sv-hint', section: 'Screens',
    sample: 'WASD to swim — space to strike',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.35, shadow: 0, glow: 0 } },
  { key: 'board', label: 'Leaderboard row', selector: '.sv-lb-row', section: 'Screens',
    sample: '1   SEAL   184,200',
    style: { font: FONT_GLOBAL, size: 12, weight: 400, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0 } },
  { key: 'status', label: 'Status line', selector: '.sv-status', section: 'Screens',
    sample: 'Posting your run…',
    style: { font: FONT_GLOBAL, size: 11, weight: 400, tracking: 0.03, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.5, shadow: 0, glow: 0 } },

  // --- the HUD: read at a glance, mid-fight --------------------------------
  { key: 'label', label: 'HUD label', selector: '.sv-label', section: 'HUD',
    sample: 'Score',
    style: { font: FONT_GLOBAL, size: 10, weight: 500, tracking: 0.06, case: 'UPPER', useInk: true, color: 0xe8ecf3, alpha: 0.55, shadow: 0, glow: 0 } },
  { key: 'value', label: 'HUD number', selector: '.sv-value', section: 'HUD',
    sample: '184,200',
    style: { font: FONT_GLOBAL, size: 20, weight: 600, tracking: 0, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 0, glow: 0 } },
  // Inside the xp track now, not beside it, and the track grows to fit this —
  // so this size is what makes the bar thick. Small on purpose.
  { key: 'level', label: 'Level in xp bar', selector: '.sv-xptop-level', section: 'HUD',
    sample: 'Level 7',
    style: { font: FONT_GLOBAL, size: 8, weight: 600, tracking: 0.1, case: 'UPPER', useInk: true, color: 0xe8ecf3, alpha: 0.5, shadow: 4, glow: 0 } },
  { key: 'bossName', label: 'Boss name', selector: '.sv-boss-name', section: 'HUD',
    sample: 'THE OLD MAN OF THE REEF',
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.14, case: 'UPPER', useInk: false, color: 0xffd7d7, alpha: 1, shadow: 4, glow: 12 } },

  // --- upgrade cards: the only type that resizes itself --------------------
  { key: 'cardName', label: 'Card name', selector: '.sv-card-name', section: 'Upgrade cards',
    sample: 'Barnacle Plating', fit: true,
    style: { font: FONT_GLOBAL, size: 15, weight: 700, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 1, shadow: 4, glow: 0 } },
  { key: 'cardDesc', label: 'Card text', selector: '.sv-card-desc', section: 'Upgrade cards',
    sample: '+18% armour, and chum sticks to you.', fit: true,
    style: { font: FONT_GLOBAL, size: 13, weight: 400, tracking: 0.04, case: 'as typed', useInk: true, color: 0xe8ecf3, alpha: 0.92, shadow: 4, glow: 0 } },

  // --- popups: the numbers that fly off the kills --------------------------
  // `motion` names the CONFIG.textMotion block this role flies on. The Text
  // panel's specimen plays it on a loop, which is what makes an APPEAR or LEAVE
  // row visible without firing a burst into the game and watching it go past.
  { key: 'score', label: 'Score popup', selector: '.sv-toast', section: 'Popups',
    sample: '+420', motion: 'score',
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.02, case: 'as typed', useInk: false, color: 0xffffff, alpha: 1, shadow: 8, glow: 0 } },
  // Rendered on top of the score popup — the node carries BOTH classes — so
  // this must stay after it in the list. typography.js writes the rules in
  // exactly this order, and the two selectors are the same weight.
  { key: 'combo', label: 'Combo popup', selector: '.sv-toast-combo', section: 'Popups',
    sample: '+1,680', motion: 'combo',
    style: { font: FONT_GLOBAL, size: 15, weight: 700, tracking: 0.02, case: 'as typed', useInk: false, color: 0xffe066, alpha: 1, shadow: 8, glow: 0 } },
  { key: 'chain', label: 'Chain banner', selector: '.sv-chain', section: 'Popups',
    sample: 'FOOD CHAIN! ×6', inlineColor: true, motion: 'chain',
    style: { font: FONT_GLOBAL, size: 21, weight: 800, tracking: 0.1, case: 'UPPER', useInk: false, color: 0xffe066, alpha: 1, shadow: 10, glow: 16 } },
  // AN UPGRADE PAYING OUT — "MANEATER +12%", fired by a `toast` channel on a
  // feedback event (systems/feedback.js). Cool where the chain banner is gold,
  // and well under half its size: both ride the same layer, and a proc reading
  // as loudly as a chain extension would have the quietest event in the game
  // shouting over the loudest. It is a receipt, and a receipt is read once.
  { key: 'proc', label: 'Upgrade proc', selector: '.sv-proc', section: 'Popups',
    sample: 'MANEATER +12%', motion: 'proc',
    style: { font: FONT_GLOBAL, size: 13, weight: 700, tracking: 0.08, case: 'UPPER', useInk: false, color: 0x9fe3ff, alpha: 1, shadow: 8, glow: 10 } },

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
    style: { font: FONT_GLOBAL, size: 24, weight: 800, tracking: 0.1, case: 'as typed', useInk: false, color: 0xff5566, alpha: 1, shadow: 10, glow: 18 } },
  // Rendered on top of the warning band — the node carries BOTH classes — so
  // this must stay after it in the list, exactly as the combo popup does. Cold
  // where the warning is hot: a tip is not an alarm, and the colour is the
  // fastest way to tell the two apart before either has been read.
  { key: 'coach', label: 'First-run tip', selector: '.sv-callout-coach', section: 'Popups',
    sample: 'Swim up for air', motion: 'coach',
    style: { font: FONT_GLOBAL, size: 20, weight: 700, tracking: 0.04, case: 'as typed', useInk: false, color: 0x9fe3ff, alpha: 1, shadow: 10, glow: 12 } },
  // A ROLE OF ITS OWN, not a size on the warning band, because it is not on the
  // band at all: it rides just above the boost ring on the seal (callouts.csv,
  // `anchor`). Small on purpose — it sits on the instrument it is about, where
  // the answer already is, so it has to be legible at a glance and nothing
  // more. Its colour is the ring's own warm gold rather than the alarm red, so
  // it reads as that gauge talking rather than as a fifth emergency.
  { key: 'boostWarn', label: 'Boost warning', selector: '.sv-callout-boost', section: 'Popups',
    sample: 'Boost Empty!', motion: 'boostWarn',
    style: { font: FONT_GLOBAL, size: 12, weight: 700, tracking: 0.08, case: 'as typed', useInk: false, color: 0xffc65a, alpha: 1, shadow: 6, glow: 8 } },
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
