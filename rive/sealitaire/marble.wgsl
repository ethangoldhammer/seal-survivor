// ============================================================================
// MARBLE — the table's water, mode 3. Ink in water: fbm warped by fbm warped
// by fbm (Quilez's triple warp), on a plane that turns slowly about the
// centre. The two inner warps are read back as colour, so the veins are
// coloured by how they were bent, not by a second noise. Same uniforms as
// vortex.wgsl; `energy` deepens the warp, ripples bend the veins.
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

fn fbm(p0: vec2f) -> f32 {
    var p = p0;
    var v = 0.0;
    var amp = 0.5;
    let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
    for (var k = 0; k < 5; k++) {
        v += amp * vnoise(p);
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

    let ring = rippleAt(in.uv, aspect);

    var q = in.uv - centre;
    q.x *= aspect;
    let r = length(q);

    // The plane turns about the eye, faster near it.
    let turn = t * speed * 0.05 * twist / (0.5 + r * 2.5) + energy * 0.4 * (1.0 - smoothstep(0.0, 0.7, r));
    let cs = cos(turn);
    let sn = sin(turn);
    let p = vec2f(cs * q.x - sn * q.y, sn * q.x + cs * q.y) * 3.2;

    // Three warps deep. `warp` sets how far the second bends the third;
    // energy adds to it so a play stirs the ink.
    let tt = t * speed * 0.08;
    let w = (warpAmt + energy * 0.5) * 4.0;
    let q1 = vec2f(fbm(p + vec2f(0.0, tt)), fbm(p + vec2f(5.2, 1.3) - tt * 0.8));
    let r1 = vec2f(
        fbm(p + w * q1 + vec2f(1.7, 9.2) + tt * 1.5 + ring * 0.5),
        fbm(p + w * q1 + vec2f(8.3, 2.8) + tt * 1.26));
    let f = fbm(p + w * r1);

    let deep = vec3f(0.02, 0.09, 0.20);
    let mid = vec3f(0.05, 0.36, 0.48);
    let teal = vec3f(0.10, 0.62, 0.62);
    let pale = vec3f(0.78, 0.95, 0.96);

    // Colour by the warps: the deep field by f, teal along the first bend,
    // foam where the second bend pinched the veins together.
    var col = mix(deep, mid, smoothstep(0.25, 0.75, f));
    col = mix(col, teal, smoothstep(0.45, 1.0, length(q1)) * 0.8);
    let vein = smoothstep(0.25, 0.6, abs(r1.y - 0.5) * 2.0 * (1.0 - f));
    col = mix(col, pale, vein * (0.25 + 0.3 * energy));
    col += pale * ring * 0.4;

    var pd = in.uv - pointer;
    pd.x *= aspect;
    col += teal * 0.25 * exp(-dot(pd, pd) * 18.0);
    col *= 0.55 + 0.45 * smoothstep(0.0, 0.25, r);
    let e = in.uv * (1.0 - in.uv);
    col *= 0.6 + 0.4 * pow(e.x * e.y * 18.0, 0.35);

    return vec4f(col * bright, 1.0);
}
