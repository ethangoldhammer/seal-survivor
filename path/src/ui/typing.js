// Single-letter hotkeys (`, T, P, M, G, H) are bound on window, so every one
// of them fires while a text field has focus unless the handler checks first.
// That was survivable when the only fields were in the tuner, and became a
// real problem once the game-over screen asked players to type a name: typing
// "TOM" muted the audio and opened the texture panel.
//
// This lived as two near-identical local copies (gamepadDebug, textures)
// before the name field needed a third and fourth caller.
export function isTypingTarget(el) {
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el?.isContentEditable);
}

// The narrower question: is the player entering TEXT, as opposed to merely
// having some control focused?
//
// The two came apart when the pause menu arrived. Its sliders are real
// <input type="range"> elements and the cursor focuses them, so while a volume
// row is selected `isTypingTarget` is true — and every handler guarded by it
// goes dead. That is right for the single-letter hotkeys (M would be nonsense
// there) and badly wrong for Escape, which is how the menu is closed: the
// player would reach the volume slider and find they could no longer leave.
//
// Arrow keys are the other half of it. A focused range input steps itself on
// left/right, which is a SECOND step on top of the menu's own — the menu
// cancels the default, and it can only do that if it is still handling the key
// at all.
export function isTextEntry(el) {
  const tag = el?.tagName;
  if (el?.isContentEditable) return true;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  // Everything that is not an explicitly non-text input type. Listing the
  // exclusions rather than the inclusions on purpose: the text-ish list is
  // long and growing (text, search, email, url, tel, password, number, date…)
  // and a type missing from it would silently eat a keystroke someone typed.
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(el.type);
}
