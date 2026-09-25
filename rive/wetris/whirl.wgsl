// ============================================================================
// THE WHIRL — wetris's water: sealitaire's vortex.wgsl, FORKED so every number
// that shapes it is a slider. The arithmetic is the vortex's line for line;
// each constant it used to hold is now a uniform whose default (tuning.luau)
// is that constant, so with nothing moved the two draw the same water.
//
// Forked rather than shared because vortex.wgsl is sealitaire's byte for byte
// (test:wetrisshared) and its uniform block is its own: widening it would
// change sealitaire. goo, foam and surface still ARE sealitaire's, and read
// this water's frame — its centre, twist and speed — from the same rows.
//
// The rows past the ripples are the fork's (19..24): the eye and the spin,
// the noise, the foam, the depth and the eye's shadow, the rings and the
// vignette, and a grade (hue, saturation, contrast) laid over the palette.
//
// What follows is the vortex's own header.
// ----------------------------------------------------------------------------
// OCEAN VORTEX — the table's water. A full-screen pass: polar domain-warped
// fbm spun around a centre, with rings that the table pushes in when a card
// lands. `energy` is the whole thing's excitement (a play spikes it, it
// decays), so the water answers what the player does.
//
// Uniform layout (std140-style, 16-byte rows):
//   row 0  res.xy, time, energy
//   row 1  centre.xy (uv), pointer.xy (uv)
//   row 2  twist, speed, brightness, warp
//   rows 3..10  eight PLAY ripples: x, y (uv), age (s), strength
//   rows 11..18 eight MUSIC ripples, same shape — the track's onsets. Two
//               rings of eight rather than one of sixteen so the music, which
//               rings several times a second, can never evict the ring a card
//               play just pushed in. Strength 0 is an empty slot in both.
//   row 19  swirl core, swirl tightness, swirl reach, energy spin
//   row 20  noise scale, noise drift, octaves, warp drift
//   row 21  foam edge, foam softness, foam amount, foam with energy
//   row 22  teal mix, depth reach, eye darkness, eye size
//   row 23  vignette, ring warp, ring glow, crease sharpness
//   row 24  hue (turns), saturation, contrast, -
// ============================================================================

struct U {
    a: vec4f,
    b: vec4f,
    c: vec4f,
    ripples: array<vec4f, 16>,
    spin: vec4f,
    noise: vec4f,
    foam: vec4f,
    shade: vec4f,
    rings: vec4f,
    grade: vec4f,
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

fn hash(p: vec2f) -> f32 {
    let h = dot(p, vec2f(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

fn vnoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    let a = hash(i);
    let b = hash(i + vec2f(1.0, 0.0));
    let c = hash(i + vec2f(0.0, 1.0));
    let d = hash(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// `octaves` is a slider now: 1..7, the fractional part fading the last one
// in so dragging it does not step.
fn fbm(p0: vec2f) -> f32 {
    var p = p0;
    var v = 0.0;
    var amp = 0.5;
    let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
    let oct = clamp(u.noise.z, 1.0, 7.0);
    for (var k = 0; k < 7; k++) {
        let w = clamp(oct - f32(k), 0.0, 1.0);
        if (w <= 0.0) { break; }
        v += amp * vnoise(p) * w;
        p = rot * p * 2.03 + vec2f(1.7, 9.2);
        amp *= 0.5;
    }
    return v;
}

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
    var q = in.uv - centre;
    q.x *= aspect;
    let r = length(q);
    var ang = atan2(q.y, q.x);

    // The spin: angle advances with time, and more so toward the eye.
    let swirl = twist * (1.0 + u.spin.w * energy) / (u.spin.x + r * u.spin.y);
    ang += t * speed * 0.35 + swirl * (1.0 - smoothstep(0.0, u.spin.z, r));

    // Ripples: rings that spread from where a card landed and fade.
    var ring = 0.0;
    for (var k = 0; k < 16; k++) {
        let rp = u.ripples[k];
        if (rp.w <= 0.0) { continue; }
        var d = in.uv - rp.xy;
        d.x *= aspect;
        let dist = length(d);
        let radius = rp.z * ringGrow(k);
        let width = ringWidth(k, rp.z);
        let band = exp(-pow((dist - radius) / width, 2.0));
        let fade = rp.w * ringFade(k, rp.z);
        ring += band * fade;
    }

    // Domain-warped, creased octaves so it reads as water not cloud. The
    // log-polar frame is laid onto a circle (cos, sin) so the angle wraps with
    // no seam: a bare `ang` tears along the ray where atan2 flips sign.
    let rad = log(r + 0.08) * 1.1 - t * speed * 0.25;
    let polar = vec2f(cos(ang), sin(ang)) * (2.2 + rad) * u.noise.x + vec2f(t * u.noise.y * 0.1, 0.0);
    let wd = u.noise.w;
    let warp = vec2f(fbm(polar + vec2f(0.0, t * 0.15 * wd)), fbm(polar + vec2f(5.2, 1.3 - t * 0.12 * wd)));
    let n1 = fbm(polar + warpAmt * (warp - 0.5) * 2.0 + ring * u.rings.y);
    let crease = pow(abs(n1 - 0.5) * 2.0, max(0.1, u.rings.w));
    let foam = smoothstep(u.foam.x, u.foam.x + max(0.01, u.foam.y), 1.0 - crease);

    // Palette: deep navy at the eye, teal mid, pale foam.
    let deep = vec3f(0.02, 0.09, 0.20);
    let mid = vec3f(0.05, 0.36, 0.48);
    let teal = vec3f(0.10, 0.62, 0.62);
    let pale = vec3f(0.78, 0.95, 0.96);

    let depth = smoothstep(0.0, max(0.05, u.shade.y), r);
    var col = mix(deep, mid, depth);
    col = mix(col, teal, n1 * u.shade.x);
    col = mix(col, pale, foam * (u.foam.z + u.foam.w * energy));
    col += pale * ring * u.rings.z;

    // A soft light where the pointer is, so the water knows the hand.
    var pd = in.uv - pointer;
    pd.x *= aspect;
    col += teal * 0.25 * exp(-dot(pd, pd) * 18.0);

    // Eye of the vortex darkens; edges vignette.
    col *= (1.0 - u.shade.z) + u.shade.z * smoothstep(0.0, max(0.01, u.shade.w), r);
    let e = in.uv * (1.0 - in.uv);
    col *= (1.0 - u.rings.x) + u.rings.x * pow(e.x * e.y * 18.0, 0.35);

    // THE GRADE: the palette turned round the luma axis, then saturation and
    // contrast about mid-grey. At 0, 1, 1 it is exactly the vortex's colour.
    let l = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    let h = u.grade.x * 6.2831853;
    let yiq = mat3x3<f32>(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    let rgb = mat3x3<f32>(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    // Only when turned: the two matrices are the usual 3-decimal YIQ pair,
    // not exact inverses, and a round trip at hue 0 would shift the water by
    // a hair it never had.
    if (abs(h) > 1e-4) {
        var q3 = yiq * col;
        let cs = cos(h);
        let sn = sin(h);
        q3 = vec3f(q3.x, q3.y * cs - q3.z * sn, q3.y * sn + q3.z * cs);
        col = rgb * q3;
    }
    col = mix(vec3f(l), col, u.grade.y);
    col = (col - 0.5) * u.grade.z + 0.5;

    return vec4f(max(col, vec3f(0.0)) * bright, 1.0);
}
