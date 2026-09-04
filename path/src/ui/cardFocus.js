// ---------------------------------------------------------------------------
// WHICH CARD IS BEING LOOKED AT — a DOM event, so the level-up screen can say
// it without knowing who is listening.
//
// The upgrade cards are DOM (ui/ui.js) and the seal that watches them is a
// three.js scene (systems/levelUpSeal.js). The screen already knows the moment
// a card is pointed at — the mouse's pointerenter, the pad's selectCard, a
// thumb's hold — and every one of those already calls showCardEffect. This is
// the same fact, announced once on `document`, so the seal (or anything else
// that wants to react to a hover) can subscribe without ui.js importing a
// renderer.
//
// `card` is the .sv-card element, or null when nothing is pointed at.
// ---------------------------------------------------------------------------

export const CARD_FOCUS_EVENT = 'sv-card-focus';

export function announceCardFocus(card) {
  if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') return;
  document.dispatchEvent?.(new CustomEvent(CARD_FOCUS_EVENT, { detail: { card: card ?? null } }));
}
