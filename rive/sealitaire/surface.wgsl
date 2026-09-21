// ============================================================================
// SURFACE — the water seen from above as a lit 3-D sheet. A full-screen pass
// over the vortex and the goo: a height field (a swell, the ripples a play
// pushes in, a dent under the hand, the seal's wake, and the goo's own
// silhouette standing proud of the water) gives a normal per pixel, and the
// normal refracts what is underneath, catches the light in glints, and lays
// caustics on the floor. Bubbles rise through it. Everything that plays
// breaks it: a ripple bends the caustic net, the goo blocks the light under
// it and pops every bubble it touches, the seal drags a wake.
//
// Same light as the seal and the goo, same palette as the vortex. Output is
// the finished water picture, opaque; crt.wgsl samples it as its water.
//
// Uniform layout (16-byte rows):
//   row 0  res.xy, time, energy
//   row 1  table W, H (artboard px), pointer.xy (px, <0 when unknown)
//   row 2  caustics, bubbles, waves, glint
//   row 3  seal x, y (px), heading (rad, nose-up 0), speed (px/s)
//   row 4  vortex centre.xy (uv), twist, speed — the vortex's own
//   row 5  refract (px), turbulence, whitewater, unused
//   row 6  ripple relief, reflect, reflect tilt, unused
//   rows 7..14  eight PLAY ripples: x, y (uv), age (s), strength — the vortex's
//   rows 15..22 eight MUSIC ripples — also the vortex's; see vortex.wgsl
//
// Turbulence: a turbulent fbm (the octaves folded to ridges) laid on the
// same spinning log-polar frame the vortex draws itself on, so the churn
// turns with the water and grows with its energy and with the foam — the
// refraction is then a picture of the sim, not a texture over it.
// ============================================================================

struct U {
    a: vec4f,
    b: vec4f,
    c: vec4f,
    d: vec4f,
    e: vec4f,
    f: vec4f,
    g: vec4f,
    ripples: array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var water: texture_2d<f32>;
@group(0) @binding(2) var goo: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var foam: texture_2d<f32>;

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

fn hash2(p: vec2f) -> vec2f {
    return vec2f(hash(p), hash(p + vec2f(19.19, 7.77)));
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

// Turbulent fbm: each octave folded about its middle, so the field is all
// creases and eddies rather than soft hills.
fn turb(p0: vec2f) -> f32 {
    var p = p0;
    var v = 0.0;
    var amp = 0.5;
    let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
    for (var k = 0; k < 4; k++) {
        v += amp * abs(vnoise(p) * 2.0 - 1.0);
        p = rot * p * 2.1 + vec2f(3.1, 1.7);
        amp *= 0.5;
    }
    return v;
}

// The height of the water at a table point, in "px of relief" — the normal
// is taken from its slope, so only differences matter.
fn height(p: vec2f, t: f32) -> f32 {
    let table = u.b.xy;
    let energy = u.a.w;
    let waves = u.c.z;
    let aspect = table.x / table.y;

    // The swell: two crossing sines and a slow fbm, more when excited.
    var h = sin(dot(p, vec2f(0.72, 0.69)) * 0.011 + t * 1.1) * 0.55
          + sin(dot(p, vec2f(-0.55, 0.83)) * 0.017 - t * 1.5) * 0.3
          + (fbm3(p * 0.0065 + vec2f(t * 0.06, -t * 0.04)) - 0.5) * 1.4;
    h *= waves * (0.85 + 0.25 * energy);

    // THE RIPPLES, as water standing up rather than a ring drawn on it. The
    // vortex underneath draws the same four numbers as light; here they are
    // geometry, and the normal taken off this is what refracts, catches the
    // sky and lays the caustics. Three things make it read as a wave:
    //
    //   SPREADING  the same push of water goes round an ever bigger circle,
    //              so the crest falls as 1/sqrt(radius). Without it a ring
    //              is as tall crossing the table as it was at the splash.
    //   A TRAIN    one sine lobe is a bump. A spreading ring is a steep
    //              front with a few waves trailing INSIDE it, and the tail
    //              stretches as it goes — the long waves outrun the short.
    //              So the envelope is asymmetric: tight ahead of the front,
    //              three and a half times as long behind it.
    //   RELIEF     all of it scaled by a number of its own. How far the
    //              water stands up is a look, not a measurement, and it is
    //              the one thing here worth a slider.
    let relief = u.g.x;
    let uv = p / table;
    for (var k = 0; k < 16; k++) {
        let rp = u.ripples[k];
        if (rp.w <= 0.0) { continue; }
        var dd = uv - rp.xy;
        dd.x *= aspect;
        let dist = length(dd) * table.y;
        let radius = rp.z * ringGrow(k) * table.y;
        let width = ringWidth(k, rp.z) * table.y;
        // Behind the front is NEGATIVE: the train trails toward the centre.
        let sgn = dist - radius;
        let lead = exp(-pow(max(sgn, 0.0) / width, 2.0));
        let tail = exp(-pow(min(sgn, 0.0) / (width * 3.5), 2.0));
        let fade = rp.w * ringFade(k, rp.z);
        let spread = inverseSqrt(1.0 + radius / (0.22 * table.y));
        // The wavelength grows with distance behind the front, which is what
        // turns one lobe into a train that reads as a wake.
        let phase = sgn * 0.16 / (1.0 + max(0.0, -sgn) * 0.0045);
        h += lead * tail * fade * spread * sin(phase) * 3.4 * relief;
    }

    // A dent under the hand.
    let pointer = u.b.zw;
    let pd = p - pointer;
    h -= 2.5 * exp(-dot(pd, pd) / (48.0 * 48.0)) * step(0.0, pointer.x);

    // The seal: a trough under the body, a chevron wake behind it that only
    // exists while it swims.
    let seal = u.d.xy;
    let heading = u.d.z;
    let speed = clamp(u.d.w / 500.0, 0.0, 1.0);
    let fwd = vec2f(sin(heading), -cos(heading));
    let right = vec2f(cos(heading), sin(heading));
    let sd = p - seal;
    let qf = dot(sd, fwd);
    let qr = dot(sd, right);
    let body = exp(-(qf * qf) / (110.0 * 110.0) - (qr * qr) / (40.0 * 40.0));
    h -= body * 3.0 * (0.4 + 0.6 * speed);
    let behind = smoothstep(0.0, 60.0, -qf);
    let wakeSpread = 30.0 + (-qf) * 0.35;
    let wake = behind * exp(-(qr * qr) / (wakeSpread * wakeSpread)) * exp(qf / 260.0);
    h += wake * speed * sin(-qf * 0.09 + abs(qr) * 0.05 - t * 9.0) * 3.5;

    // The goo stands proud of the water: its coverage is height, so the
    // slope at its edge is a meniscus that bends the light.
    let g = textureSample(goo, samp, uv).a;
    h += smoothstep(0.0, 1.0, g) * 2.2;

    // Turbulence, on the vortex's own frame: the angle advances and the
    // log-radius drifts in exactly as vortex.wgsl's do, laid on a circle so
    // the wrap has no seam. Foam churns it further.
    let fm = textureSample(foam, samp, uv).r;
    let centre = u.e.xy;
    let twist = u.e.z;
    let vspeed = u.e.w;
    var q = uv - centre;
    q.x *= aspect;
    let r = length(q);
    var ang = atan2(q.y, q.x);
    let swirl = twist * (1.0 + 2.0 * energy) / (0.35 + r * 1.6);
    ang += t * vspeed * 0.35 + swirl * (1.0 - smoothstep(0.0, 1.4, r));
    let rad = log(r + 0.08) * 1.1 - t * vspeed * 0.25;
    let polar = vec2f(cos(ang), sin(ang)) * (2.2 + rad) * 1.25;
    let tb = turb(polar * 2.6 + vec2f(t * 0.15, -t * 0.1)) - 0.45;
    h += tb * u.f.y * (1.6 + 4.0 * energy + 5.0 * fm);
    h += fm * 1.5;
    return h;
}

// THE SKY A TILTED FACE TURNS AROUND. The camera looks straight down, so
// flat water reflects the zenith — which is nearly black — and only a face
// steep enough to swing the reflected ray toward the horizon shows anything
// at all. That is the whole reason a ripple reads as three-dimensional here
// instead of as a light ring: its walls are the only thing on the table with
// a slope, so they are the only thing the sky can land on, and the eye reads
// "this stands up" from the fact that the crest is lit and the flat water
// beside it is not.
//
// It is a gradient and a sun, not a picture: there is nothing above this
// table to reflect, and anything more literal would have to be invented.
fn sky(r: vec3f, l: vec3f) -> vec3f {
    let zenith = vec3f(0.03, 0.13, 0.26);
    let horizon = vec3f(0.62, 0.86, 0.92);
    // pow() on the way up, so the horizon band is thin and the transition
    // sits where a slope actually reaches rather than smeared over the lot.
    let up = clamp(r.z, 0.0, 1.0);
    var c = mix(horizon, zenith, pow(up, 0.55));
    // The sun, broad: the sharp glint is still the specular below, and two
    // tight highlights on one crest would read as two lights.
    let sun = max(dot(r, l), 0.0);
    c += vec3f(1.0, 0.97, 0.88) * pow(sun, 12.0) * 0.7;
    return c;
}

// Caustics: two ridged noise fields sliding over each other — a ridge is
// where the noise crosses its middle, so each field is a net of thin bright
// lines, and their product is the folded web light makes on a floor. The
// vortex draws its foam from the same kind of crease.
fn ridge(p: vec2f) -> f32 {
    return 1.0 - abs(vnoise(p) * 2.0 - 1.0);
}

fn caustic(p: vec2f, t: f32) -> f32 {
    let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
    let r1 = ridge(p + vec2f(t * 0.35, t * 0.2));
    let r2 = ridge(rot * p * 1.45 + vec2f(-t * 0.25, t * 0.3));
    let r3 = ridge(p * 0.6 + vec2f(t * 0.1, -t * 0.15));
    let net = pow(r1 * r2, 3.0) * (0.5 + 0.5 * r3);
    return smoothstep(0.02, 0.6, net);
}

// Bubbles: two layers of cells rising at their own speeds; a cell holds a
// bubble by lot, drawn as a thin ring with a bright bead at its shoulder.
fn bubbles(p: vec2f, t: f32, density: f32) -> f32 {
    var acc = 0.0;
    for (var layer = 0; layer < 2; layer++) {
        let fl = f32(layer);
        let cell = 96.0 - fl * 30.0;
        let rise = t * (34.0 + fl * 22.0);
        let q = vec2f(p.x, p.y + rise) / cell;
        let id = floor(q) + vec2f(fl * 7.3, fl * 3.1);
        let f = fract(q) - 0.5;
        let lot = hash(id + vec2f(5.5, 1.1));
        let has = step(lot, density * 0.24);
        let r = 0.06 + 0.1 * hash(id + vec2f(3.3, 8.8));
        let sway = vec2f(sin(t * 1.7 + lot * 6.283) * 0.07, 0.0);
        let off = (hash2(id) - 0.5) * 0.55 + sway;
        let d = length(f - off);
        let ring = smoothstep(r + 0.015, r, d) * (1.0 - smoothstep(r - 0.035, r - 0.012, d));
        let bead = 1.0 - smoothstep(0.0, r * 0.5, length(f - off - vec2f(-r * 0.45, -r * 0.45)));
        let fill = (1.0 - smoothstep(0.0, r, d)) * 0.08;
        acc += has * (ring * 0.55 + bead * 0.9 + fill);
    }
    return clamp(acc, 0.0, 1.0);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let t = u.a.z;
    let energy = u.a.w;
    let table = u.b.xy;
    let causticsAmt = u.c.x;
    let bubbleAmt = u.c.y;
    let glint = u.c.w;
    let p = in.uv * table;

    // The slope of the height field, and a normal from it. The relief is
    // px of height over px of table, scaled to read as water, not glass.
    let e = 2.0;
    let h0 = height(p, t);
    let hx = height(p + vec2f(e, 0.0), t) - h0;
    let hy = height(p + vec2f(0.0, e), t) - h0;
    let n = normalize(vec3f(-hx / e * 1.1, -hy / e * 1.1, 1.0));

    // What lies beneath, bent by the surface: the vortex, then the goo, at
    // the same displaced point so the two stay registered.
    let ruv = in.uv + n.xy * u.f.x / table;
    // DISPERSION. Red bends least and blue most, so the three channels are
    // sampled a fraction apart along the slope. It is what separates
    // refraction from a smear: a displaced image alone reads as the water
    // being out of focus, and the coloured fringe on the steep face is the
    // cue that says the thing bending it is a lens.
    //
    // Scaled by the SLOPE, so flat water pays nothing and the fringe appears
    // exactly on the ripple walls that earned it.
    let tilt = length(n.xy);
    let disp = normalize(n.xy + vec2f(1e-6, 0.0)) * tilt * u.f.x * 0.5 / table;
    var col = vec3f(
        textureSample(water, samp, ruv + disp).r,
        textureSample(water, samp, ruv).g,
        textureSample(water, samp, ruv - disp).b);
    // The goo is NOT refracted: its own edge is in the height field, and
    // bending it by itself tears it into shards.
    let g = textureSample(goo, samp, in.uv);
    col = col * (1.0 - g.a) + g.rgb;
    let gooHere = g.a;

    let teal = vec3f(0.10, 0.62, 0.62);
    let pale = vec3f(0.78, 0.95, 0.96);
    let sun = vec3f(0.95, 0.98, 0.9);
    let l = normalize(vec3f(-0.45, -0.6, 0.8));
    let v = vec3f(0.0, 0.0, 1.0);

    // Caustics on the floor, bent by the normal, blocked under the goo and
    // fading into the vortex's dark eye.
    let cp = (p + n.xy * 40.0) * 0.011;
    let c = caustic(cp, t);
    let lum = dot(col, vec3f(0.299, 0.587, 0.114));
    col += sun * c * causticsAmt * (0.10 + 0.22 * lum) * (1.0 - gooHere * 0.85);

    // Bubbles, popped by the goo.
    let b = bubbles(p, t, bubbleAmt) * (1.0 - gooHere);
    col += pale * b * 0.6;

    // FRESNEL. Everything above this line is what is UNDER the water, seen
    // through it. This is the water's own face.
    //
    // Water is barely reflective head-on — 2% — and a mirror at a glancing
    // angle, so looking straight down the flat table shows what is beneath
    // it and only the tilted faces show sky. That split is what gives a
    // ripple depth for free: no term here says "ring", the ring simply is
    // the only geometry with a slope.
    //
    // The slopes are exaggerated first. Real relief at this scale leaves
    // every normal within a few degrees of straight up, where (1-cos)^5 is
    // effectively zero and nothing reflects at all — the picture would be
    // correct and completely flat. `reflectTilt` is the lie that makes the
    // geometry visible, and it is a slider because it is a look.
    let nr = normalize(vec3f(n.xy * u.g.z, n.z));
    let cosv = clamp(dot(nr, v), 0.0, 1.0);
    let fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
    let mirror = sky(reflect(-v, nr), l);
    col = mix(col, mirror, clamp(fres * u.g.y, 0.0, 1.0) * (1.0 - gooHere));

    // Whitewater: the simulated foam, broken into froth by noise as it is
    // drawn, and its trapped air as a finer, denser swarm of bubbles.
    let fm = textureSample(foam, samp, in.uv);
    let breakup = fbm3(p * 0.035 + vec2f(t * 0.3, -t * 0.2));
    let froth = smoothstep(0.10, 0.6, fm.r * (0.5 + 1.0 * breakup)) * (1.0 - gooHere * 0.7);
    col = mix(col, pale * (0.86 + 0.14 * breakup), froth * 0.92);
    let fine = bubbles(p * 1.9 + vec2f(37.0, 11.0), t * 1.5, 2.0) * clamp(fm.g, 0.0, 1.0);
    col += pale * fine * 0.85;

    // The sheen: a broad soft light on the facing slopes and a sharp glint.
    let ndl = max(dot(n, l), 0.0);
    let hv = normalize(l + v);
    let spec = pow(max(dot(n, hv), 0.0), 90.0);
    col += sun * spec * 0.3 * glint * (1.0 - froth);
    let tiltAmt = smoothstep(0.0, 0.5, length(n.xy));
    col += teal * (0.12 + 0.1 * energy) * tiltAmt;
    col *= 0.92 + 0.12 * ndl;

    return vec4f(col, 1.0);
}
