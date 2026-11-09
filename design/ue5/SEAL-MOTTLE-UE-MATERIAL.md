# Seal mottling as a UE5 material

Ports the player seal's procedural hide (`path/src/systems/noiseGlsl.js`) to a UE material.
Files: `design/ue5/materials/SealMottle.hlsl` (the shader), `tools/ue5-mottle-export.mjs` (parameters
and a reference table), output in `build/ue5-mottle/`.

## What the shader is

Not a texture. The three.js seal ships with none: its look is 3-octave Perlin noise sampled at each
vertex's BIND-POSE position (so the spots are painted on the body and deform with it), then
`colour = mix(body, spotColour, strength * n)`. Player seal = base `CONFIG.sealShader`, no preset:

| Param | Value | Note |
| --- | --- | --- |
| size | 0.04 | feature size in GLB mesh units, not world units; the seal is 1.68 long, so about 40 cells down the body |
| strength | 0.83 | how far the body is pulled to the spot colour |
| contrast | 3.55 | hard patches |
| color | black | spot colour |
| baseColor / paint | white / 0 | no paint coat |
| material | roughness 0.55, metalness 0.05, emissive #0a2233 x 0.15 | from `ASSETS.ship.material` |

Colours are exported as LINEAR floats (`params.json`); feed those to UE, not the hex.

## Building it in UE

1. New Material `M_SealMottle`, Shading Model Default Lit, Used with Skeletal Meshes ON.
2. Custom node: paste the body of `SealMottle.hlsl`, set the inputs listed at its top. Feed
   `Pre-Skinned Local Position` into `PreSkinnedPos`. Wire output `rgb` to Base Color.
3. Parameters as vector/scalar parameters so a Material Instance can retune them. Roughness 0.55,
   Metallic 0.05, Emissive = emissive linear colour x 0.15.
4. `Seed` is a per-body offset into the same infinite field (the game uses it so two seals are not
   identical twins). Leave 0 for the hero seal; set per instance for companions.

## The two things that can be wrong

- **Axis remap.** UE pre-skinned local (cm) is turned back into GLB space by three lines in the HLSL.
  The GLB-to-Blender step is measured exactly; the Blender-to-UE step assumes the seal faces +X
  (the same facing check as `SEAL-ANIM-STATE-MACHINE.md`). A wrong remap shows as mirrored or
  rotated spots, not as an error. `reference.json` lists the six landmark vertices in UE local cm
  with their expected noise value `n`.
- **Pre-Skinned Local Position on a skeletal mesh.** If the node returns zero or a flat result in
  your 5.9 preview build (it can depend on skin cache settings), the fallback is to bake the rest
  position into UV channels in `tools/ue5-seal-export.py` and read those instead.

## Not exact

`frac(sin(x) * 43758.5453)` depends on the GPU's `sin` precision, so UE matches the three.js hide
in scale, contrast and character, but not freckle for freckle everywhere. For an exact match,
bake the field into vertex colours or a texture instead.

## Not ported yet

The wet film (`wet*`, caustic reflections), the sky/ocean belly split, and the element glow layers.
Values are kept under `deferred` in `params.json`. Each is a separate layer on top of the mottle.

## Status

Untested in UE: the HLSL has not been compiled, and the remap has not been checked against a render.
