# Sky art — the sun and the moon

Flat art for the two celestial bodies. Drop a file here and point
`CONFIG.dayNight.sun.texture` / `.moon.texture` (path/src/config.js) at it,
with a leading slash and no `public`:

    /textures/sky/moon.webp
    /textures/sky/sun.webp

Currently expected:

| file        | used by                       |
|-------------|-------------------------------|
| `moon.webp` | `CONFIG.dayNight.moon.texture` |

## What the art should be

- **Square, and centred.** It's mapped onto a unit quad and scaled to
  `size` world units, so a non-square image comes out stretched.
- **Transparent outside the disc**, ideally. If it isn't, leave
  `maskToDisc: true` (the default) and the shader folds a circular alpha
  edge over it — an opaque white background then reads as a disc rather than
  as a square in the sky. Turn `maskToDisc` off only for art that
  deliberately spills past its own circle: a corona, a ring, a glow.
- **Mid-bright.** The art is multiplied by `color` and `brightness`, and the
  result goes through the bloom bright-pass, so anything already near white
  blows out to a flat white blob. Paint it as the object, not as the light —
  the halo behind it is what does the glowing.

## Making it glow

Two knobs, and they answer different questions.

- **`brightness`** is how bright the ART is. It multiplies into every pixel of
  the painted disc, so raising it far enough to glow on its own just flattens
  the craters into white. Set it so the highlights read and stop.
- **`bloomRim`** is the glow. The halo behind the disc is what emits, and this
  states the thing you actually want — "the corona's rim should sit this far
  past the bloom threshold". The rig SOLVES for the halo strength that
  achieves it and takes whichever is higher, so `haloStrength` still works as
  a slider but can no longer be left somewhere the glow silently does nothing.
  1.0 sits exactly on the threshold; 1.6 is comfortably over. 0 turns the
  solve off and hands control back to `haloStrength` alone.

Why a solve rather than a number: the bright pass in `systems/post.js`
thresholds **Rec.709 luminance**, where blue counts for 7% and green for 72%.
A moon at `0xcfe2ff` is worth 0.75 to it; the same halo strength on a deeper
blue is worth a third of that and quietly stops blooming. The solve tracks
`color`, `halo` and `CONFIG.bloom.threshold` together, so retuning any of them
keeps the glow.

The `moon bloom` readout in the tuner's sky group prints all of it — the disc,
the corona's rim, what the solve landed on, and how far out the glow blooms in
disc radii.

## If a bright ring shows around the art

`edgeFeather` is the width of the circular alpha edge, in disc radii. Painted
art whose blob doesn't quite reach the frame, on a background that isn't
properly transparent, leaves a rim of that background between the paint and
the mask. Widening the feather eats it. The moon ships at `0.12` for exactly
this reason; drop it back to `0.06` if the source gains a real alpha channel.

## What happens if the file is missing

The rig warns once to the console and falls back to the built-in placeholder
disc, so a wrong path costs you a plain circle, never an empty sky. Note that
on the deployed site a missing file does **not** 404 — the Pages SPA fallback
serves `index.html` with a 200, which then fails to decode as an image and
lands on the same fallback. The warning text is the same either way.

## Swapping art at runtime

The paths are re-read every frame, so editing config.js hot-reloads the new
file with no restart. A `.glb` works too, via `.model` instead of `.texture`
— it gets auto-scaled so its largest dimension matches `size`.
