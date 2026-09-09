# Sprites

Flat art loaded as a camera-facing quad instead of a 3D model. Served from the
site root, so `public/sprites/foo.png` is referenced as `/sprites/foo.png`.

The format needs an alpha channel: the quad is cut with `alphaTest`, not
alpha-blended, so a white background shows up as a white box rather than
disappearing. Transparent PNG and WebP both behave.

Prefer **WebP** for anything shipped. The starfish set is byte-for-byte
identical in silhouette to its PNG originals — the alpha channel survives
intact, so the `alphaTest` cutout doesn't move by a single pixel — at roughly
a quarter of the weight (993 KB of PNG became 232 KB). The lossy part only
touches colour inside the shape, a few levels per channel, which does not
survive being drawn at projectile size.

## How an asset uses them

Add `sprites: [...]` to its entry in `path/src/assets.js`:

```js
starfish: {
  sprites: ['/sprites/starfish-1.webp', '/sprites/starfish-2.webp'],
  // the shape below stays as the fallback if none of the images load
  shape: 'octahedron', radius: 0.22, color: 0xff7fb0, unlit: true,
},
```

Several files per key is a **pool**, not a sequence — `createVisual` picks one
at random per spawn, which is what keeps a fast-firing ability from reading as
one sprite flickering across the screen. Images that fail to load are dropped
individually, so four good files out of five give a pool of four.

The quad is cut to each image's own aspect ratio, and its longest side becomes
`fit` (or `radius * 2`) world units. The Look & Sound panel's size multiplier
then applies on top of that, so the on-screen size is usually not the number in
`assets.js` — check both before deciding the art is the wrong scale.

## Currently expected here

| File | Used by |
| --- | --- |
| `starfish-1.webp` … `starfish-5.webp` | `starfish` — the thrown shuriken |
