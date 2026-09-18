# Device icons

The marks on the controller chips in the Blubberball team select — one per
device the screen can tell apart. Baked into `path/src/ui/deviceIcons.js` as
data URIs by:

```bash
npm run device:icons -- --bake --strict
```

`--bake` with no path means this folder. `--strict` refuses to write anything
unless all five are here, which is what you want for a run that is meant to be
complete; without it a partial set is fine and the missing keys keep their
glyph.

## The five

The key is the filename. `ui/padBrand.js` decides which one a controller gets,
from the free-text `id` the Gamepad API reports; the keyboard is not detected,
it is simply the one device in the room that is not a controller.

| key | drawn as | source in the pack |
| --- | --- | --- |
| `keyboard` | a keyboard | `Keyboard & Mouse/Vector/keyboard.svg` |
| `xbox` | Xbox Series pad | `Xbox Series/Vector/controller_xboxseries.svg` |
| `playstation` | DualSense | `PlayStation Series/Vector/controller_playstation5.svg` |
| `switch` | Switch Pro | `Nintendo Switch/Vector/controller_switch_pro.svg` |
| `pad` | a nameless pad | `Flairs/Vector/controller_generic.svg` |

**Silhouettes rather than brand logos, and not by choice.** Kenney cannot ship
the Xbox, PlayStation or Nintendo word marks, and neither can we — so what tells
the four apart at 18px is the shape of the body: the DualSense's light bar, the
Pro Controller's round grips, the plus-shaped d-pad on the nameless one. They
are more alike than four logos would be. The number beside the mark is still
what makes two pads of the same make two different chips, and it is why
`dressChip` keeps it.

## Where they came from

Kenney's **Input Prompts** pack, version 1.5A (11-07-2026), from
[kenney.nl](https://www.kenney.nl) — the zip is in
`~/Documents/_DesignSystems/SealSurvivor/kenney_input-prompts_1.5.zip`.

**Licence: CC0 1.0 (public domain).** Personal, educational and commercial use,
no attribution required. Kenney asks only that you credit 'Kenney' or
'www.kenney.nl' if you feel like it — which is what this paragraph is.

The pack has fifteen more platforms in it (Steam Deck, Steam Controller, Meta
Quest, GameCube, Wii, WiiU, Playdate, Valve Index, Switch 2…) in both PNG and
SVG. Adding one is a row in `PAD_BRANDS`, a vendor id or a pattern in
`padBrand.js`, and a file here named for the new key — the bake asks for
whatever `padBrand.js` can answer, so the two lists cannot drift.

## What the bake does to an SVG

`tidySvg` in `tools/device-icons.mjs`, and the first thing it does is the one
that matters: **it adds a `viewBox`.** Kenney's files carry `width="64"
height="64"` and no viewBox, which says nothing about how the artwork maps onto
a box of another size — Chromium infers one and scales, and an engine that does
not draws a 64px controller inside an 18px element and clips it. This game is
played on iOS Safari, so without it the mark would be a crop of a controller on
exactly the devices the marks matter most on, while looking perfect in every
preview taken on this Mac. `tools/device-icon-test.mjs` asserts the viewBox
survived.

The rest is bytes — an empty `<defs/>`, an xlink namespace nothing references, a
`stroke="none"` that is SVG's initial value anyway, the indentation between
tags. It never touches path data, merges shapes or rounds coordinates: those
are the edits that can quietly change a drawing, and this runs unattended.

The files here are Kenney's originals, untouched. The tidying happens on the way
into the module, so re-running the bake against a fresh copy of the pack gives
the same result.
