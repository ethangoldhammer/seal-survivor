// ============================================================================
// THE SEAL — a skinned mesh, lit, into a full-screen depth-tested GPU canvas
// OVER the cards. The script builds the bone matrices (bind pose plus the
// swim wave down the spine and the neck bent toward the hovered card) and
// uploads them every frame.
//
// THE MOTTLING is the game's own (path/src/systems/noiseGlsl.js): Perlin fbm,
// three octaves, sampled at the BIND-POSE vertex so the markings are painted
// on the animal and deform with it rather than swimming across the skin.
// Same field, same polarity rule, same mix — a picture of the same seal.
//
// Vertex layout (48 bytes): position f32x3, normal f32x3, colour f32x3,
// joints u8x4, weights unorm8x4.
//
// Uniform layout:
//   mvp        mat4 (64)     model → clip (orthographic, screen px)
//   model      mat4 (64)     model → world (for normals)
//   light      vec4          dir.xyz, split (0..1: the mouth is on a card)
//   tint       vec4          rgb, rim
//   mottle     vec4          size, strength, contrast, seed
//   mottleCol  vec4          rgb, -
//   layer      vec4          pass, behind, -, -
//   bones      28 x mat4
//
// THE TWO SIDES OF THE CARDS. The animal is drawn into two canvases and the
// crt pass lays one UNDER the cards and one OVER them. Which canvas a
// fragment lands in is this pass's only branch, and two numbers decide it.
//
// `behind` (motion.luau, per state, blended by puppet.luau) is the animal's
// side of the table: 0 — the default — swims it over the cards, 1 sends it
// under them for a state that wants the cards in front.
//
// `split` overrides that AT THE MOUTH, and nowhere else. A card held in the
// jaws has to be INSIDE the animal — upper head in front of it, lower jaw
// behind — so exactly one lip crosses to the far side of the cards and the
// rest of the seal stays put: from behind it is `head` (head_07 and the eyes)
// that comes up, from in front it is `jaw` (mouth_08) that goes down. The lip
// crosses progressively as `split` rises, the vertices furthest from the seam
// first, so the mouth opens around the card instead of popping.
// ============================================================================

struct U {
    mvp: mat4x4<f32>,
    model: mat4x4<f32>,
    light: vec4f,
    tint: vec4f,
    mottle: vec4f,
    mottleCol: vec4f,
    layer: vec4f,
    bones: array<mat4x4<f32>, 28>,
};
@group(0) @binding(0) var<uniform> u: U;

struct VSIn {
    @location(0) pos: vec3f,
    @location(1) nrm: vec3f,
    @location(2) col: vec3f,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4f,
};

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) bind: vec3f,
    @location(1) nrm: vec3f,
    @location(2) col: vec3f,
    @location(3) head: f32,
    @location(4) jaw: f32,
};

@vertex
fn vs(in: VSIn) -> VSOut {
    var skin = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    skin = skin + u.bones[in.joints.x] * in.weights.x;
    skin = skin + u.bones[in.joints.y] * in.weights.y;
    skin = skin + u.bones[in.joints.z] * in.weights.z;
    skin = skin + u.bones[in.joints.w] * in.weights.w;
    let p = skin * vec4f(in.pos, 1.0);
    let n = (skin * vec4f(in.nrm, 0.0)).xyz;
    var o: VSOut;
    o.bind = in.pos;
    o.nrm = normalize((u.model * vec4f(n, 0.0)).xyz);
    o.col = in.col;
    // The two halves of the mouth, by bone weight: head_07 (8) and the eyes
    // (10, 11) above the bite line, mouth_08 (9) below it. Everything else is
    // BODY and belongs to neither — which matters, because the two are read
    // separately rather than as complements: whichever side of the cards the
    // animal is on, it is one lip that crosses to meet the other, and the
    // body stays where it was.
    var h = 0.0;
    var j = 0.0;
    let js = array<u32, 4>(in.joints.x, in.joints.y, in.joints.z, in.joints.w);
    let ws = array<f32, 4>(in.weights.x, in.weights.y, in.weights.z, in.weights.w);
    for (var k = 0; k < 4; k++) {
        if (js[k] == 8u || js[k] == 10u || js[k] == 11u) { h += ws[k]; }
        if (js[k] == 9u) { j += ws[k]; }
    }
    o.head = h;
    o.jaw = j;
    o.pos = u.mvp * p;
    return o;
}

// --- the game's noise field, verbatim in WGSL ---------------------------------
fn noiseHash3(p0: vec3f) -> vec3f {
    let p = vec3f(dot(p0, vec3f(127.1, 311.7, 74.7)),
                  dot(p0, vec3f(269.5, 183.3, 246.1)),
                  dot(p0, vec3f(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

fn perlin3(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    let c000 = dot(noiseHash3(i + vec3f(0.0, 0.0, 0.0)), f - vec3f(0.0, 0.0, 0.0));
    let c100 = dot(noiseHash3(i + vec3f(1.0, 0.0, 0.0)), f - vec3f(1.0, 0.0, 0.0));
    let c010 = dot(noiseHash3(i + vec3f(0.0, 1.0, 0.0)), f - vec3f(0.0, 1.0, 0.0));
    let c110 = dot(noiseHash3(i + vec3f(1.0, 1.0, 0.0)), f - vec3f(1.0, 1.0, 0.0));
    let c001 = dot(noiseHash3(i + vec3f(0.0, 0.0, 1.0)), f - vec3f(0.0, 0.0, 1.0));
    let c101 = dot(noiseHash3(i + vec3f(1.0, 0.0, 1.0)), f - vec3f(1.0, 0.0, 1.0));
    let c011 = dot(noiseHash3(i + vec3f(0.0, 1.0, 1.0)), f - vec3f(0.0, 1.0, 1.0));
    let c111 = dot(noiseHash3(i + vec3f(1.0, 1.0, 1.0)), f - vec3f(1.0, 1.0, 1.0));
    return mix(mix(mix(c000, c100, s.x), mix(c010, c110, s.x), s.y),
               mix(mix(c001, c101, s.x), mix(c011, c111, s.x), s.y), s.z);
}

fn noiseFbm(p0: vec3f) -> f32 {
    var p = p0;
    var v = 0.0;
    var a = 0.5;
    for (var k = 0; k < 3; k++) {
        v += a * perlin3(p);
        p *= 2.02;
        a *= 0.5;
    }
    return v;
}

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let split = u.light.w;
    let thisPass = u.layer.x;
    let behind = step(0.5, u.layer.y);
    // One lip crosses the cards to meet the other, and ONLY that lip: from
    // behind, the upper head comes up over them; from in front, the lower jaw
    // drops under. The body is not the complement of either — it stays on the
    // animal's own side, because in front of the cards the complement of the
    // head is the whole torso, and sending that under puts the seal back
    // behind every pile it happens to be swimming across.
    let overBehind = step(0.5, in.head * split);
    let overFront = 1.0 - step(0.5, in.jaw * split);
    let over = mix(overFront, overBehind, behind);
    if (thisPass > 0.5 && over < 0.5) { discard; }
    if (thisPass < 0.5 && over > 0.5) { discard; }
    let n = normalize(in.nrm);
    let l = normalize(u.light.xyz);
    // Orthographic: the eye is straight down the screen normal.
    let v = vec3f(0.0, 0.0, 1.0);

    // The hide: the vertex colour, mottled by the game's rule.
    var base = in.col * u.tint.rgb;
    let size = max(0.0001, u.mottle.x);
    let seed = vec3f(u.mottle.w, u.mottle.w * 0.37, u.mottle.w * 1.91);
    let field = clamp(noiseFbm((in.bind + seed) / size) * u.mottle.z * 0.5 + 0.5, 0.0, 1.0);
    let ink = u.mottleCol.rgb;
    let polarity = step(dot(ink, LUMA), dot(base, LUMA));
    let lit = mix(field, 1.0 - field, polarity);
    base = mix(base, ink, u.mottle.y * field);

    // Two-band toon shading with a soft seam, plus a cool rim so the
    // silhouette reads against the water.
    let ndl = dot(n, l);
    let band = smoothstep(-0.05, 0.25, ndl) * 0.7 + smoothstep(0.45, 0.75, ndl) * 0.3;
    var col = base * (0.3 + 0.7 * band);
    let rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * u.tint.w;
    col += vec3f(0.35, 0.75, 0.85) * rim;
    // Wet highlight, riding the pale markings.
    let h = normalize(l + v);
    let spec = pow(max(dot(n, h), 0.0), 36.0) * (0.15 + 0.3 * lit);
    col += vec3f(spec);
    return vec4f(col, 1.0);
}
