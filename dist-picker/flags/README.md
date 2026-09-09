# Flags

What flies off a boat's masthead. Served from the site root, so
`public/flags/foo.webp` is referenced as `/flags/foo.webp`.

Two halves, and nothing here is in code:

| Where | What it decides |
| --- | --- |
| this folder | the images |
| `path/src/flags.csv` | which image, on which boat, how likely |
| `CONFIG.flags` (` tuner, Boats) | how big it is on the mast and how it moves |

## Adding one

1. Put the file in this folder.
2. Add a row in `npm run csv` → **Flags**: an `id`, the `src`
   (`/flags/yourfile.webp`), and leave `hulls` blank to put it in the pool every
   flag-flying boat draws from.

`hulls` is the one column that decides anything else. A row that names a hull is
**exclusive** to it — that hull flies only the rows written for it, and those
rows never appear on any other boat. That is how Bakalar's flag stays his: its
row names `bakalarBoat`, so nothing in the pool can land on his mast and his
flag can never turn up on a boss.

Which hulls fly flags at all is `CONFIG.flags.hulls` — today Bakalar's trawler,
the boat boss and the yacht. The ordinary chum boats deliberately fly nothing:
there can be three of them on screen at once, and a flag on every one turns the
horizon into bunting.

## The format

Same rules as `public/sprites/` — the quad is cut with `alphaTest`, not
alpha-blended, so a **transparent** PNG or WebP is needed for anything that
isn't a plain rectangle. A white background shows up as a white box.

Prefer **WebP** for anything shipped.

The flag is cut to the image's own **aspect ratio**: its height comes from
`CONFIG.flags.heightFraction` (a fraction of the hull's own measured height, so
one number is right for both hulls), and the width follows from the image. So a
2:1 image flies as a long pennant and a square one as a square, with no setting
to change.

Authored with the **hoist on the left**, the way a flag is normally drawn. It is
tied to the mast by its right-hand edge and flies aft, which for a boat sailing
right puts the image on screen the way round you drew it — and mirrors it when
the boat comes about, which is what a real flag does.

## What happens when a file is missing

Nothing, loudly enough to find: the mast flies nothing and one line goes to the
console naming the row and the path. A flag is never a blank white rectangle and
never a crash.

## Currently expected here

| File | Used by |
| --- | --- |
| `bakalar.webp` | the `bakalar` row — Bakalar's trawler. **Not in the repo yet.** |
