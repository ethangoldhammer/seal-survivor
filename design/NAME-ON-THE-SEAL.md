# The name ON the seal

**Status: not built. This is the note, not the feature.**

The main menu shows the player's name on a card beside the seal
(`path/src/ui/nameTag.js`). The obvious next thought is to put it on the
*animal* — a name across the flank, riding with the body. This is what that
would actually take, written down at the point the idea was had so the next
person does not have to rediscover it.

## Why the easy version does not work

Two shortcuts look like they would do it, and neither does:

**A quad held at a bone.** Position a textured plane at `chest_04` every frame,
turn it to face the camera. This was built and thrown away. It is a card
*floating in front of* the flank, not a mark *on* it: it does not follow the
curve of the body, it slides out of register the moment the seal turns, and at
the menu's crop the gap between the card and the fur is plainly visible. It
reads as a bug — a UI element that failed to get out of the way — rather than
as a marking.

**`THREE.DecalGeometry`.** three's own decal projector cuts the target mesh's
triangles against a projector box and hands back new geometry. It cuts against
the **rest** geometry. The seal is skinned, so the decal is baked where the fur
was in bind pose and the fur then moves out from under it. Every frame of
animation makes it worse, and re-projecting per frame means rebuilding geometry
sixty times a second against a pose that has to be read back off the GPU.

## What it actually is

A mark on the seal is a **texture sampled in the seal's own UV space, blended
into the fragment shader already running on its material.** Then it is part of
the surface: it skins with the mesh for free, it is lit by whatever lights the
seal, the outline and bloom passes see it, and there is no second object to
keep in register with anything.

The hooks are all already here:

| Piece | Where it is |
| --- | --- |
| The seal's material injection | `path/src/systems/noiseShader.js` — `attachNoiseShader`, the `onBeforeCompile` at ~line 197 |
| Its fragment splice point | after `#include <map_fragment>`, where the mottle already modulates `diffuseColor` |
| The asset flag that turns it on | `noiseShader: true` on `ASSETS.ship` in `assets.js` |
| The name, already rendered to a canvas | `ui/nameTag.js` — its handle exposes `canvas`, a fixed-size backing store the Rive artboard draws into |
| Precedent for a texture replacing a body's look | `systems/biolumSkin.js`, `pigment: 1` |

`furseal.glb` **has UVs and no image** (see the note on `ASSETS.ship`). That is
unusually good news: nothing is competing for the UV space, so a name can own a
rectangle of it outright without fighting a diffuse map.

## The order to do it in

1. **Look at the UV layout first.** Everything below depends on there being a
   flank island big enough, un-mirrored, and not split across a seam. Unwrap
   `furseal.glb`'s UVs and *look* at them — this is a five-minute check that
   decides whether the rest is an afternoon or a remodel. If the flanks are
   mirrored onto the same island (common, and free for a model that never had a
   texture), the name appears on both sides and reads backwards on one. That
   case needs either a second UV set or a sign test on the object-space normal.
2. **Get the canvas to the shader.** A `CanvasTexture` over the nametag's
   canvas, as a uniform on the seal's material. The artboard is a still once the
   name is written, so it uploads once and never again.
3. **Splice the sample in.** In the fragment stage after `<map_fragment>`,
   sample the name at `vMapUv` remapped into a rectangle — offset and scale as
   uniforms, which is what the sliders end up driving. Blend over
   `diffuseColor` by the sampled alpha.
4. **Then, and only then, add sliders.** Offset u, offset v, scale, rotation,
   opacity. They are meaningless until step 1 says where on the body u and v
   land, which is exactly why the first pass at this shipped a slider group that
   could not be tuned into anything good.

## Two things that will bite

- **`Material.clone()` drops `onBeforeCompile`.** The seal's material is
  already injected; anything that clones it loses the shader silently. See the
  note at the top of `noiseShader.js` and how `setNoiseGlow` guards it.
- **The outline shells are copies of the same mesh.** A name blended into
  `diffuseColor` must not also appear on the rim shells, which use their own
  material — check what the shells do before assuming they are unaffected.

## Whether it is worth it

Open question, and worth asking before step 1. The card beside the seal already
says the name, on the one screen where the name matters. A mark on the flank is
a nicer *idea* than it is a legible piece of UI: at the menu's crop the flank is
maybe 300px of curved, shaded, moving surface, and text on it is small, warped
and half in shadow. It may be better as a **mark** than as the name — a brand, a
tally, a scar — with the name staying on the card that can hold it flat and
upright.
