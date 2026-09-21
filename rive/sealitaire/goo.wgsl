// ============================================================================
// GOO — the water that clings. A signed-distance layer between the vortex and
// the seal: every stack, every card in flight and every droplet is one
// primitive in a single distance field, smooth-unioned, so shapes near each
// other fuse into one blob, a droplet flung from a landing stretches a neck
// and snaps free, and a droplet pulled home merges back without a seam. The
// field is jiggled by slow noise so the membrane never sits still, and it is
// shaded as a dome under the seal's light — the same two-band toon step, the
// same cool rim — over the vortex's own palette, so the three GPU layers read
// as one picture once the CRT is over them.
//
// Draws at half resolution, premultiplied, over a transparent clear; crt.wgsl
// lays it between the water and the seal. It samples the water to refract it.
//
// Uniform layout (16-byte rows):
//   row 0  res.xy (this canvas, px), time, energy
//   row 1  table W, H (artboard px), skirt (px), blend k (px)
//   row 2  wobble (px), refract (px), amount, dome (px)
//   row 3  nBodies, nDrops, unused, unused
//   rows 4..51  bodies, two rows each: cx, cy, hw, hh | rot, radius, phase, kind
//   rows 52..75 drops: x, y, r, life
// ============================================================================

const MAX_BODIES: u32 = 24u;
const MAX_DROPS: u32 = 24u;

struct U {
    a: vec4f,
    b: vec4f,
    c: vec4f,
    d: vec4f,
    bodies: array<vec4f, 48>,
    drops: array<vec4f, 24>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var water: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

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

// Three octaves: the jiggle is a slow, fat wobble, not a texture.
fn fbm3(p0: vec2f) -> f32 {
    var p = p0;
    var v = 0.0;
    var amp = 0.5;
    let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
    for (var k = 0; k < 3; k++) {
        v += amp * vnoise(p);
        p = rot * p * 2.03 + vec2f(1.7, 9.2);
        amp *= 0.5;
    }
    return v;
}

// Polynomial smooth minimum: the fusing. k is how far apart two shapes
// still reach for each other.
fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// A rounded box, rotated, in table px.
fn sdBox(p: vec2f, c: vec2f, half: vec2f, rot: f32, r: f32) -> f32 {
    let cs = cos(rot);
    let sn = sin(rot);
    let q0 = p - c;
    let q = vec2f(cs * q0.x + sn * q0.y, -sn * q0.x + cs * q0.y);
    let d = abs(q) - half + vec2f(r);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

// The whole field at a table point.
fn field(p: vec2f, t: f32, energy: f32) -> f32 {
    let skirt = u.b.z;
    let k = u.b.w;
    let nBodies = u32(u.d.x);
    let nDrops = u32(u.d.y);
    var d = 1.0e5;
    for (var i = 0u; i < MAX_BODIES; i++) {
        if (i >= nBodies) { break; }
        let b0 = u.bodies[i * 2u];
        let b1 = u.bodies[i * 2u + 1u];
        // A stack breathes: its skirt swells and relaxes on its own phase,
        // more when the table is excited.
        let breathe = 1.0 + (0.08 + 0.18 * energy) * sin(t * 2.3 + b1.z);
        let sk = skirt * breathe;
        let half = b0.zw + vec2f(sk);
        d = smin(d, sdBox(p, b0.xy, half, b1.x, b1.y + sk), k);
    }
    for (var i = 0u; i < MAX_DROPS; i++) {
        if (i >= nDrops) { break; }
        let dr = u.drops[i];
        // A drop rounds off as it dies; a fresh one is a little squashed by
        // its own speed, which the table folds into r.
        let r = dr.z * smoothstep(0.0, 0.25, dr.w);
        d = smin(d, length(p - dr.xy) - r, k * 0.8);
    }
    // The jiggle: a low-frequency displacement of the boundary, faster and
    // bigger while the table is excited. Blubber, not ripples.
    let w = fbm3(p * 0.011 + vec2f(t * 0.45, -t * 0.33)) - 0.5;
    let w2 = sin(p.x * 0.021 + t * 3.1) * sin(p.y * 0.017 - t * 2.4);
    d += (w * 1.6 + w2 * 0.35) * u.c.x * (0.7 + 0.6 * energy);
    return d;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let t = u.a.z;
    let energy = u.a.w;
    let table = u.b.xy;
    let refract = u.c.y;
    let amount = u.c.z;
    let dome = max(4.0, u.c.w);
    let p = in.uv * table;

    // The field and its gradient by central-ish differences: three evals of
    // everything, which is why this pass draws at half size.
    let e = 1.5;
    let d = field(p, t, energy);
    let dx = field(p + vec2f(e, 0.0), t, energy) - d;
    let dy = field(p + vec2f(0.0, e), t, energy) - d;
    let grad = vec2f(dx, dy) / e;

    // A dome: flat in the middle, steep at the rim. The normal leans outward
    // along the gradient of the distance, most where the goo is thinnest.
    let hgt = smoothstep(0.0, -dome, d);
    let slope = (1.0 - hgt) * (1.0 - hgt) * 3.0 + 0.15;
    let n = normalize(vec3f(grad * slope, 1.0));

    // Refract the water underneath: sampled first, unconditionally, so every
    // textureSample stays in uniform control flow.
    let ouv = in.uv + n.xy * refract / table;
    let under = textureSample(water, samp, ouv).rgb;

    // The vortex's palette, the seal's light.
    let mid = vec3f(0.05, 0.36, 0.48);
    let teal = vec3f(0.10, 0.62, 0.62);
    let pale = vec3f(0.78, 0.95, 0.96);
    let rimCol = vec3f(0.35, 0.75, 0.85);
    let l = normalize(vec3f(-0.45, -0.6, 0.8));
    let v = vec3f(0.0, 0.0, 1.0);

    // Body colour: the refracted water, pulled toward the teal and lifted,
    // so the goo reads as thicker water rather than a paint.
    var base = mix(under * 1.15, teal, 0.28) + mid * 0.12;
    let ndl = dot(n, l);
    let band = smoothstep(-0.05, 0.25, ndl) * 0.7 + smoothstep(0.45, 0.75, ndl) * 0.3;
    var col = base * (0.5 + 0.6 * band);
    // Depth: the middle of a thick blob is a shade deeper.
    col = mix(col, col * 0.82 + mid * 0.1, hgt * 0.5);
    // The rim, and the wet highlight riding the bright side of the dome.
    let rim = pow(1.0 - max(n.z, 0.0), 2.5) * (1.0 + 0.6 * energy);
    col += rimCol * rim * 0.9;
    let h = normalize(l + v);
    let spec = pow(max(dot(n, h), 0.0), 40.0) * 0.55;
    col += pale * spec;
    // A pale line at the boundary, the foam the vortex draws on its creases.
    let edge = 1.0 - smoothstep(0.0, 2.2, abs(d + 1.2));
    col = mix(col, pale, edge * 0.6);

    // Coverage: the goo, then a soft contact shadow just outside it so the
    // blob sits ON the water instead of floating over it.
    let a = smoothstep(1.0, -1.2, d) * amount;
    let shade = (1.0 - smoothstep(0.0, 9.0, d)) * step(0.0, d) * 0.32 * amount;
    let outA = a + shade * (1.0 - a);
    // Premultiplied: the shadow is black, so it adds alpha and no colour.
    return vec4f(col * a, outA);
}
