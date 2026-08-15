// ============================================================================
// THE FONT SHELF, and nothing else.
//
// A leaf module with no imports, for the same reason ease.js is one: config.js
// builds the picker's options out of this list, and ui/typography.js turns a
// choice into a loaded font — so a system importing CONFIG would close a cycle.
//
// THE WIRE FORMAT IS THE STACK, NOT THE LABEL. `stack` is what lands in CONFIG
// and gets written to imported-tuning.json, exactly as it did when the picker
// was five hardcoded strings in the schema. That is why the first six entries
// carry their original stacks character for character: tuning already on disk
// says `'Courier New', monospace`, and a "tidier" stack here would leave that
// saved value pointing at nothing in the picker while the game kept rendering
// it. Appending is safe; editing a `stack` in place unsyncs saved tuning.
//
// A `google` entry is loaded on demand the first time something asks for that
// stack (see ensureFontLoaded) rather than up front — nineteen families is a
// lot of network for a shelf you pick one thing off. The families WITHOUT one
// are already on the machine, so they keep working with no network at all.
// ============================================================================

export const FONTS = [
  // --- the five the picker shipped with, plus the system stack --------------
  { label: 'Inter', stack: "'Inter', system-ui, sans-serif", google: 'Inter:wght@400;500;600;700;800;900' },
  { label: 'System', stack: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { label: 'Courier', stack: "'Courier New', monospace" },
  { label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Trebuchet', stack: "'Trebuchet MS', sans-serif" },
  { label: 'Impact', stack: 'Impact, sans-serif' },
  { label: 'Mono', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },

  // --- rounded and friendly: the register the HUD and the cards sit in ------
  { label: 'Nunito', stack: "'Nunito', system-ui, sans-serif", google: 'Nunito:wght@400;600;700;800;900' },
  { label: 'Fredoka', stack: "'Fredoka', system-ui, sans-serif", google: 'Fredoka:wght@300;400;500;600;700' },
  { label: 'Baloo', stack: "'Baloo 2', system-ui, sans-serif", google: 'Baloo+2:wght@400;500;600;700;800' },

  // --- loud: display faces, for the things that shout ----------------------
  // Single-weight, all three of them — the weight slider does nothing on these,
  // which is a property of the font rather than a bug in the row.
  { label: 'Titan One', stack: "'Titan One', system-ui, sans-serif", google: 'Titan+One' },
  { label: 'Luckiest', stack: "'Luckiest Guy', system-ui, sans-serif", google: 'Luckiest+Guy' },
  { label: 'Bangers', stack: "'Bangers', system-ui, sans-serif", google: 'Bangers' },

  // --- technical: squarer, for numbers and boss furniture ------------------
  { label: 'Chakra', stack: "'Chakra Petch', system-ui, sans-serif", google: 'Chakra+Petch:wght@400;500;600;700' },
  { label: 'Grotesk', stack: "'Space Grotesk', system-ui, sans-serif", google: 'Space+Grotesk:wght@400;500;600;700' },
  { label: 'Orbitron', stack: "'Orbitron', system-ui, sans-serif", google: 'Orbitron:wght@400;500;600;700;800;900' },

  // --- pixel and terminal: the register the retro treatment is aimed at ----
  { label: 'Press Start', stack: "'Press Start 2P', monospace", google: 'Press+Start+2P' },
  { label: 'VT323', stack: "'VT323', monospace", google: 'VT323' },
  { label: 'Silkscreen', stack: "'Silkscreen', monospace", google: 'Silkscreen:wght@400;700' },
];

/** Every stack, in shelf order — what a tuner `choice` row wants for options. */
export const FONT_STACKS = FONTS.map((f) => f.stack);

/** The matching labels, so the pills read "Bangers" and not a CSS font stack. */
export const FONT_LABELS = FONTS.map((f) => f.label);

const BY_STACK = new Map(FONTS.map((f) => [f.stack, f]));

/** The shelf entry for a stack, or null for one typed in by hand. */
export function fontForStack(stack) {
  return BY_STACK.get(stack) ?? null;
}

/**
 * Friendly name for a stack — the picker's label where there is one, and the
 * first family in the stack where there isn't, so a hand-edited value still
 * reads as something rather than as a wall of fallbacks.
 */
export function fontLabel(stack) {
  const known = BY_STACK.get(stack);
  if (known) return known.label;
  const first = String(stack ?? '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return first || 'unset';
}
