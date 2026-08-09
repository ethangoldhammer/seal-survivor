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
