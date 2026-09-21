// ============================================================================
// CAUSTIC — the table's water, mode 2. The light net on a pool floor: two
// layers of animated cellular (Worley) noise, lit along the cell borders
// where the second-nearest point is about as close as the nearest, drifting
// against each other and turned slowly about the centre. Same uniforms as
// vortex.wgsl; `energy` brightens the net, ripples ring through it.
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

fn hash2(p: vec2f) -> vec2f {
    let h = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
    return fract(sin(h) * 43758.5453123);
}

// The web: bright where a pixel is nearly equidistant from its two nearest
// cell points — the cell borders — with each point wandering in its cell.
fn web(p: vec2f, t: f32) -> f32 {
    let i = floor(p);
    let f = fract(p);
    var d1 = 8.0;
    var d2 = 8.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let g = vec2f(f32(x), f32(y));
            let h = hash2(i + g);
            let o = 0.5 + 0.45 * sin(t + 6.2831853 * h);
            let d = g + o - f;
            let dd = dot(d, d);
            if (dd < d1) {
                d2 = d1;
                d1 = dd;
            } else if (dd < d2) {
                d2 = dd;
            }
        }
    }
    let edge = sqrt(d2) - sqrt(d1);
    return 1.0 - smoothstep(0.0, 0.22, edge);
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

    // A slow turn about the eye, tighter toward it, so the net still swirls.
    let turn = t * speed * 0.06 * twist / (0.6 + r * 2.0) + energy * 0.3 * (1.0 - smoothstep(0.0, 0.8, r));
    let cs = cos(turn);
    let sn = sin(turn);
    let p = vec2f(cs * q.x - sn * q.y, sn * q.x + cs * q.y);

    // Two nets at different scales, drifting apart; a ripple bends both.
    let s = 3.0 + warpAmt * 2.0;
    let drift = t * speed * 0.12;
    let w1 = web(p * s + vec2f(drift, drift * 0.7) + ring * 0.25, t * speed * 0.5);
    let w2 = web(p * s * 1.7 + vec2f(-drift * 0.8, drift * 1.1) + 3.7, t * speed * 0.4 + 2.0);
    let net = w1 * w1 * 0.7 + w1 * w2 * 0.8;

    let deep = vec3f(0.02, 0.09, 0.20);
    let mid = vec3f(0.05, 0.36, 0.48);
    let teal = vec3f(0.10, 0.62, 0.62);
    let pale = vec3f(0.78, 0.95, 0.96);

    let depth = smoothstep(0.0, 0.9, r);
    var col = mix(deep, mid, depth * 0.8);
    col = mix(col, teal, net * 0.85);
    col = mix(col, pale, net * net * (0.25 + 0.35 * energy));
    col += pale * ring * 0.4;

    var pd = in.uv - pointer;
    pd.x *= aspect;
    col += teal * 0.25 * exp(-dot(pd, pd) * 18.0);
    col *= 0.55 + 0.45 * smoothstep(0.0, 0.25, r);
    let e = in.uv * (1.0 - in.uv);
    col *= 0.6 + 0.4 * pow(e.x * e.y * 18.0, 0.35);

    return vec4f(col * bright, 1.0);
}
