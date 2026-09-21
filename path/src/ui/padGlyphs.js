// ---------------------------------------------------------------------------
// WHAT TO PRESS — the marks that sit on a control and name the button that
// drives it.
//
// WHY THESE ARE PICTURES AND NOT WORDS. The team select's settings answer to a
// pad and to nothing else once a chip is readied, and for as long as the screen
// said so nowhere the only way to find a binding was to push things and watch.
// A line of text would have fixed that in one language, on a screen four people
// are reading from a couch; a mark of the button itself is read at a glance, by
// anybody, at the distance this screen is actually played at.
//
// THEY ARE ART, NOT COPY, which is the other half of the same decision — see
// ui/deviceIcons.js, which makes it for the chips. Nothing here is a string a
// player reads as language: the two letters that do appear are stamped on the
// plastic of every controller in the room.
//
// STANDARD MAPPING, NOT A BRAND. ui/padBrand.js can tell an Xbox pad from a
// DualSense and this deliberately does not ask it. Every mark below is either
// POSITIONAL — the d-pad's arms, the shoulders, the right stick — or the
// standard-mapping name the rest of the input code already uses (padPoll.js's
// header, input.js's BACK_BUTTON). Position is the thing that is actually the
// same on all of them: the right stick is the right stick on every pad ever
// made, while the button padPoll calls `b` is B, Circle or A depending on whose
// hands it is in. Where a mark would have to guess at a brand it does not draw
// a letter at all, and the two that do (L and R on the shoulders) are the
// letters those shoulders carry on Xbox, PlayStation and Switch alike.
//
// A BRAND-SPECIFIC SET IS A SEAM, not a missing feature. padBrand already hands
// back the brand and glyphFor takes one; today every brand resolves to the same
// mark, and a per-brand table can land later without a caller changing.
//
// Inline SVG rather than data URIs — unlike deviceIcons.js, which embeds baked
// art it did not draw. These are drawn here, they are small, and inline they
// inherit `currentColor`, so a mark on a cyan button and the same mark on the
// panel are one file rather than two exports.
// ---------------------------------------------------------------------------

const BOX = 'viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false"';

// AN AXIS: two arrowheads facing out of a small centre.
//
// ARROWHEADS AND NOT A D-PAD PICTURE, which is what this was first. A plus with
// one pair of arms filled and the other pair left as an outline is a lovely
// mark at 72px and a smudge at the 18 these are actually drawn at — the whole
// reading is "which pair is solid", and at that size the outline is a grey blur
// the eye takes for part of the same shape. A pair of triangles survives being
// small, which is the only test that matters here.
//
// ...AND IT IS ALSO THE TRUER MARK. padPoll folds the d-pad and the LEFT STICK
// into the same four directions, so a drawing of a d-pad names one of the two
// things that work. An axis names the gesture, which is what both of them are.
//
// BOTH ARROWHEADS, because the binding is the axis: left AND right step the
// number, and a mark showing one of them would read as "push right", which is
// half a control.
const AXIS = (live) => `<svg ${BOX}>
  <rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1.2" fill="currentColor" opacity=".55"/>
  ${live === 'x'
    ? '<path fill="currentColor" d="M7.6 6.4v11.2L1.6 12zM16.4 6.4v11.2L22.4 12z"/>'
    : '<path fill="currentColor" d="M6.4 7.6h11.2L12 1.6zM6.4 16.4h11.2L12 22.4z"/>'}
</svg>`;

// A shoulder: the tab you press, with the grip it sits on suggested under it.
// The letter is inside the tab because that is where it is printed.
// THE LETTER SETS THE SIZE OF THE TAB, not the other way round. At the 18px
// these are drawn at a tab sized to look right at 64 leaves an "L" three pixels
// tall, which is a white pill and nothing else — and a white pill on the left
// of the button and a white pill on the right of it are the same mark twice.
// So the tab is as tall as the letter needs and the grip under it is a hint
// rather than half the drawing.
const BUMPER = (letter) => `<svg ${BOX}>
  <rect x="1.5" y="2.6" width="21" height="12.4" rx="5" fill="currentColor"/>
  <path fill="none" stroke="currentColor" stroke-width="1.8" opacity=".45"
    d="M3.4 18.2q8.6 4.6 17.2 0"/>
  <text x="12" y="12.5" text-anchor="middle" font-size="11" font-weight="800"
    font-family="inherit" fill="#0a0c12">${letter}</text>
</svg>`;

export const PAD_GLYPHS = {
  // Left and right — the d-pad or the left stick, which padPoll reads alike.
  dpadX: AXIS('x'),
  // Up and down, the same pair.
  dpadY: AXIS('y'),
  bumperL: BUMPER('L'),
  bumperR: BUMPER('R'),
  // THE RIGHT STICK, AND IT SAYS WHICH ONE. A stick top on its own is either
  // stick; the pair of dots under it is the pad's two sticks seen from above
  // with the right one filled, which is the only way to say "the right one"
  // without a letter that changes per brand. The arc is that it TURNS — this
  // mark sits in the middle of a colour wheel and the gesture is to push the
  // stick round it.
  stickR: `<svg ${BOX}>
    <circle cx="12" cy="10" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="12" cy="10" r="2.3" fill="currentColor"/>
    <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".7"
      d="M18.6 7.2a7.4 7.4 0 0 1 0 5.6"/>
    <path fill="currentColor" opacity=".7" d="M18.2 12.2l1.9.6-.6 1.9z"/>
    <circle cx="8" cy="20" r="1.9" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"/>
    <circle cx="16" cy="20" r="1.9" fill="currentColor"/>
  </svg>`,
  // The right-hand face button — B on an Xbox pad, which is the name padPoll
  // and input.js both use for it. A ring rather than a filled disc so it is not
  // mistaken for the stick above.
  faceB: `<svg ${BOX}>
    <circle cx="12" cy="12" r="10.4" fill="currentColor"/>
    <text x="12" y="16.4" text-anchor="middle" font-size="14" font-weight="800"
      font-family="inherit" fill="#0a0c12">B</text>
  </svg>`,
  // Start / Menu / Options. Three bars is the one shape all three of them draw.
  menu: `<svg ${BOX}>
    <rect x="1.6" y="4.8" width="20.8" height="14.4" rx="3.4" fill="currentColor"/>
    <path stroke="#0a0c12" stroke-width="1.9" stroke-linecap="round" d="M6.4 9.2h11.2M6.4 12h11.2M6.4 14.8h11.2"/>
  </svg>`,
};

export const PAD_GLYPH_KEYS = Object.keys(PAD_GLYPHS);

/**
 * The mark for `name`, for the pad `brand` is holding.
 *
 * `brand` is ignored today and is in the signature rather than out of it on
 * purpose: see the header. A name with no mark returns an empty string rather
 * than throwing, so a cue added ahead of its art draws nothing instead of
 * taking the screen down.
 */
export function glyphFor(name, brand = 'pad') {
  void brand;
  return PAD_GLYPHS[name] ?? '';
}
