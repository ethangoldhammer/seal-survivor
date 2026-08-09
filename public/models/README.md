# Models

Drop `.glb` or `.gltf` files in this folder. Anything here is served from the
site root, so `public/models/ship.glb` is referenced as `/models/ship.glb`.

## Swapping the ship

1. Put your file here, e.g. `public/models/ship.glb`
2. Open `path/src/assets.js` and point the `ship` entry at it:

```js
ship: {
  model: '/models/ship.glb',
  fit: 1.9,        // longest axis becomes 1.9 world units
  yaw: 0,          // radians, if the model faces the wrong way
  layFlat: true,   // true for normal Y-up exports
  offset: [0,0,0],
  tint: null,      // set a hex to override the model's own colour
  // the fields below stay as the fallback if the model fails to load
  shape: 'cone', radius: 0.7, height: 1.6, color: 0x7ad7ff,
}
```

Nothing else needs editing. Same pattern for any enemy — set `model` on
`enemyShark`, `enemyOtter`, etc.

## Orientation

The game plays on the XY plane with the camera looking down Z. Standard glTF
exports are Y-up with **-Z as forward**, and `layFlat: true` converts that
automatically.

If your ship comes out sideways or backwards, adjust `yaw` in quarter turns:

| Looks like | Set |
| --- | --- |
| Facing 90° right | `yaw: Math.PI / 2` |
| Facing backwards | `yaw: Math.PI` |
| Facing 90° left | `yaw: -Math.PI / 2` |

If your model was authored Z-up (some CAD exports), set `layFlat: false` and
correct it with `yaw` instead.

## Notes

- `fit` auto-scales, so model units don't matter. The pivot is recentred on the
  bounding box, so off-origin exports are fine too.
- Keep it low-poly. Hundreds of enemies can be on screen; a 50k-triangle ship is
  fine but a 50k-triangle enemy is not.
- Draco or Meshopt compressed files need their decoder wired into the loader in
  `path/src/assets.js`. Export uncompressed to skip that.
- If a model fails to load the game logs a warning and falls back to the
  built-in shape, so a bad file never breaks the build.
- **`.fbx` side-car textures are never fetched.** An FBX stores its textures as
  paths on the machine it was exported from (`F:\3dsmax\...\T_Seagull_BaseColor.jpg`),
  and three.js retries them as bare filenames next to the model. None of ours
  ship those files, so every one was a 404 per boot — and worse, the material
  kept a texture that never resolved, which multiplies the diffuse to black and
  (via `alphaMap`) the alpha to zero. That is what made the trout invisible.
  `assets.js` now hands FBXLoader a stub for external image files and drops the
  slot, so an FBX renders in its material colours. Textures EMBEDDED in the
  .fbx still work. If you need a real texture on an FBX, wire it up explicitly
  with `texture: { ... }` on the asset entry, pointing at `public/textures/`.
