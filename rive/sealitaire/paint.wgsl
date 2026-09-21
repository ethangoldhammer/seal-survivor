// ============================================================================
// PAINT — the table's water, mode 1. The Balatro-style "paint" swirl: a
// pixelated spin around the centre, then five passes of sin/cos folding that
// smear the plane into brush strokes, banded into three colours by how far
// the fold carried each pixel. Same uniforms as vortex.wgsl (see its header),
// same reactions: `energy` kicks the spin, ripples push the bands, the
// pointer lights the water.
// ============================================================================

struct U {
    a: vec4f,
    b: vec4f,
    c: vec4f,
    ripples: array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> u: U;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: VSOut;
    o.pos = vec4f(p[vi], 0.0, 1.0);
    o.uv = vec2f(p[vi].x * 0.5 + 0.5, 1.0 - (p[vi].y * 0.5 + 0.5));
    return o;
}

// A RIPPLE'S SHAPE, by slot. Slots 0..7 are card plays: one big splash that
// owns the water for a second. Slots 8..15 are the music's, which ring a
// couple of times a second — at a play's size they overlap into an even wash
// and the water just looks generally busy, so they spread slower, run about a
// third the width and are gone in a second. Same four numbers per ripple,
// read into a different shape. Every water mode shares these so the music
// looks the same however the water is drawn.
fn ringGrow(k: i32) -> f32 { return select(0.55, 0.34, k >= 8); }
fn ringWidth(k: i32, age: f32) -> f32 { return select(0.035 + age * 0.05, 0.018 + age * 0.028, k >= 8); }
fn ringFade(k: i32, age: f32) -> f32 { return exp(-age * select(1.4, 2.4, k >= 8)); }

// Rings that spread from where a card landed and fade.
fn rippleAt(uv: vec2f, aspect: f32) -> f32 {
    var ring = 0.0;
    for (var k = 0; k < 16; k++) {
        let rp = u.ripples[k];
        if (rp.w <= 0.0) { continue; }
        var d = uv - rp.xy;
        d.x *= aspect;
        let dist = length(d);
        let radius = rp.z * ringGrow(k);
        let width = ringWidth(k, rp.z);
        let band = exp(-pow((dist - radius) / width, 2.0));
        ring += band * rp.w * ringFade(k, rp.z);
    }
    return ring;
}

const PIXEL_SIZE_FAC = 700.0;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let res = u.a.xy;
    let t = u.a.z;
    let energy = u.a.w;
    let centre = u.b.xy;
    let pointer = u.b.zw;
    let twist = u.c.x;
    let speed = u.c.y;
    let bright = u.c.z;
    let warpAmt = u.c.w;
    let aspect = res.x / res.y;

    let ring = rippleAt(in.uv, aspect);

    // Pixelated, centred on the vortex's eye, in units of the screen diagonal.
    let diag = length(res);
    let pixel = diag / PIXEL_SIZE_FAC;
    let frag = floor(in.pos.xy / pixel) * pixel;
    var uv = (frag - centre * res) / diag;
    let uvLen = length(uv);

    // The spin. `twist` is the source's spin_amount (its 1.05 sits at the
    // table's default twist); energy winds it up toward the eye.
    let spinAmount = twist * 0.22;
    let spinTime = t * speed;
    let spin = spinTime * 0.1 + 302.2;
    let ang = atan2(uv.y, uv.x) + spin
        - 10.0 * (spinAmount * uvLen + (1.0 - spinAmount))
        + energy * 1.2 * (1.0 - smoothstep(0.0, 0.6, uvLen));
    uv = vec2f(cos(ang), sin(ang)) * uvLen;

    // The paint: five folds of the plane.
    uv *= 30.0;
    let spd = spinTime * 0.7;
    var uv2 = vec2f(uv.x + uv.y);
    for (var i = 0; i < 5; i++) {
        uv2 += sin(max(uv.x, uv.y)) + uv;
        uv += 0.5 * vec2f(
            cos(5.1123314 + 0.353 * uv2.y + spd * 0.131121),
            sin(uv2.x - 0.113 * spd));
        uv -= cos(uv.x + uv.y) - sin(uv.x * 0.711 - uv.y);
    }

    // Three bands by how far the fold carried the pixel. `warp` is the
    // source's contrast; a ripple shoves the band under it outward.
    let contrast = 0.6 + warpAmt * 0.6;
    let contrastMod = 0.25 * contrast + 0.5 * spinAmount + 1.2;
    let paint = min(2.0, max(0.0, length(uv) * 0.035 * contrastMod + ring * 0.6));
    let c1p = max(0.0, 1.0 - contrastMod * abs(1.0 - paint));
    let c2p = max(0.0, 1.0 - contrastMod * abs(paint));
    let c3p = 1.0 - min(1.0, c1p + c2p);

    // Palette: the vortex's. Deep navy is the base and the first band, teal
    // the second, mid-blue the third; foam is only what energy lifts out.
    let deep = vec3f(0.02, 0.09, 0.20);
    let mid = vec3f(0.05, 0.36, 0.48);
    let teal = vec3f(0.10, 0.62, 0.62);
    let pale = vec3f(0.78, 0.95, 0.96);

    let base = 0.3 / contrast;
    var col = base * deep + (1.0 - base) * (deep * c1p + teal * c2p + mid * c3p);
    col = mix(col, pale, c2p * (0.08 + 0.3 * energy));
    col += pale * ring * 0.4;

    // The hand, the eye, the vignette: as the vortex has them.
    var pd = in.uv - pointer;
    pd.x *= aspect;
    col += teal * 0.25 * exp(-dot(pd, pd) * 18.0);
    col *= 0.6 + 0.4 * smoothstep(0.0, 0.18, uvLen);
    let e = in.uv * (1.0 - in.uv);
    col *= 0.6 + 0.4 * pow(e.x * e.y * 18.0, 0.35);

    return vec4f(col * bright, 1.0);
}
