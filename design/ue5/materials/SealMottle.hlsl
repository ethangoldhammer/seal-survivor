// SealMottle — the seal's procedural hide, ported from path/src/systems/noiseGlsl.js
// (perlin3, noiseFbm, mottleGlsl). Paste the BODY of this file into a Material "Custom" node.
//
// Custom node setup
//   Output Type : CMOST_Float4   (rgb = painted colour, a = n, the raw noise mask 0..1)
//   Inputs (names must match):
//     PreSkinnedPos  float3  <- "Pre-Skinned Local Position" node (skeletal mesh, cm)
//     Seed           float3  vector parameter, default 0,0,0 (per-body offset, see below)
//     Size           float   scalar parameter, default 0.04
//     Strength       float   scalar parameter, default 0.83
//     Contrast       float   scalar parameter, default 3.55
//     NoiseColor     float3  vector parameter (LINEAR), default 0,0,0
//     BaseColor      float3  vector parameter (LINEAR), default 1,1,1
//     Paint          float   scalar parameter, default 0
//     Diffuse        float3  the material's own tint (LINEAR), default 1,1,1
//   Wire rgb to Base Color. Roughness 0.55, Metallic 0.05, Emissive per params.json (x 0.15).
//
// Values come from build/ue5-mottle/params.json (tools/ue5-mottle-export.mjs).
// Colours in that file are given as LINEAR floats; three.js converts hex sRGB -> linear, so feed UE
// the linear numbers, not the hex.
//
// WHY PRE-SKINNED: the noise is sampled at the BIND-POSE vertex so the pattern is painted ON the
// animal and deforms with it, instead of swimming across the skin. Same reason as the three.js side.
//
// THE AXIS REMAP below is the one fragile line. It turns UE's pre-skinned local position (cm) back into
// the GLB's own vertex space, where `Size` is measured. The GLB -> Blender-rest shift is measured exactly
// (1374/1374 vertices). tools/ue5-seal-export.py then yaws the seal so the head is on UE +X (confirmed
// in UE 5.9) and works in cm. NOT CONFIRMED: that UE's importer mirrors Y for handedness, which a correct
// import does. Check: bone hand_L_014 (the seal's left flipper) should sit at NEGATIVE Y in UE. If it is
// POSITIVE, there was no mirror: change `-P.y * 0.01` to `P.y * 0.01` below and nothing else.
// A wrong sign shows as mirrored spots (left and right swapped), not as an error.
//
// KNOWN LIMIT: fract(sin(x) * 43758.5453) is GPU-dependent. UE will match the three.js pattern in scale,
// contrast and character, but not necessarily freckle for freckle on every GPU. For an exact match, bake
// the field to vertex colours or a texture instead.

struct SealNoise
{
    float3 Hash3(float3 p)
    {
        p = float3(dot(p, float3(127.1, 311.7, 74.7)),
                   dot(p, float3(269.5, 183.3, 246.1)),
                   dot(p, float3(113.5, 271.9, 124.6)));
        return -1.0 + 2.0 * frac(sin(p) * 43758.5453123);
    }

    float Perlin3(float3 p)
    {
        float3 i = floor(p);
        float3 f = frac(p);
        float3 u = f * f * (3.0 - 2.0 * f);
        return lerp(
            lerp(lerp(dot(Hash3(i + float3(0, 0, 0)), f - float3(0, 0, 0)),
                      dot(Hash3(i + float3(1, 0, 0)), f - float3(1, 0, 0)), u.x),
                 lerp(dot(Hash3(i + float3(0, 1, 0)), f - float3(0, 1, 0)),
                      dot(Hash3(i + float3(1, 1, 0)), f - float3(1, 1, 0)), u.x), u.y),
            lerp(lerp(dot(Hash3(i + float3(0, 0, 1)), f - float3(0, 0, 1)),
                      dot(Hash3(i + float3(1, 0, 1)), f - float3(1, 0, 1)), u.x),
                 lerp(dot(Hash3(i + float3(0, 1, 1)), f - float3(0, 1, 1)),
                      dot(Hash3(i + float3(1, 1, 1)), f - float3(1, 1, 1)), u.x), u.y), u.z);
    }

    // Three octaves, lacunarity 2.02 (not 2, so octave lattices do not line up).
    float Fbm(float3 p)
    {
        float v = 0.0;
        float a = 0.5;
        for (int k = 0; k < 3; k++)
        {
            v += a * Perlin3(p);
            p *= 2.02;
            a *= 0.5;
        }
        return v;
    }
};

SealNoise Fn;

// UE pre-skinned local (cm)  ->  GLB vertex space (the space Size is measured in).
float3 P = PreSkinnedPos;
float3 Acc = float3(-P.y * 0.01,
                     P.z * 0.01 + 0.1347,
                     P.x * 0.01 - 0.2081);

float N = saturate(Fn.Fbm((Acc + Seed) / max(0.0001, Size)) * Contrast * 0.5 + 0.5);

// Paint coat first (0 = leave the body colour), then the mottling, exactly as mottleGlsl orders them.
float3 Dst = lerp(Diffuse, BaseColor * Diffuse, saturate(Paint));
Dst = lerp(Dst, NoiseColor, Strength * N);

return float4(Dst, N);
