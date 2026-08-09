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
