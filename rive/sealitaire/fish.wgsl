// ============================================================================
// THE TANKS — every creature in every tank card, instanced, into one tile of
// the tank atlas per card. Each instance carries its own model matrix (four
// columns), its colours, its tile, its pose and its light; the uniform is the
// camera and the look, shared by every tile. One draw per species
// (tools/sealitaire-fish.mjs packs them into one vertex list with absolute
// indices).
//
// Vertex buffer 0 (stride 32): position f32x3, normal f32x3, joints u8x4,
//   weights unorm8x4. A species with no clip has every vertex on joint 0.
// Vertex buffer 1 (stride 160, per instance): model columns c0..c3 f32x4,
//   back f32x4 (rgb, shine), belly f32x4 (rgb, EMISSIVE), tile f32x4 (NDC
//   offset xy, NDC scale xy) — which tile of the atlas this body is drawn
//   into — anim f32x4 (phase 0..1 through the clip, pose weight 0..1, the
//   dent's place along the body, its age in seconds), bio f32x4 (the glow's
//   rgb, strength) and dent f32x4 (the dent's direction xyz, its depth).
//   Every tank shares one camera;
//   the tile transform is applied in clip space after projection, and the
//   fragment stage clips to the tile's pixel rect, so all the tanks are one
//   draw per species with no viewport switching.
//
// Uniform:
//   viewProj  mat4 (64)
//   light     vec4  dir.xyz, time
//   params    vec4  back darkening, belly brightening, rim, unused
//   res       vec4  atlas width, atlas height, unused, unused
//   eye       vec4  camera position xyz, unused
//   cel       vec4  steps, edge softness, shadow floor, specular size
//   line      vec4  outline rgb, thickness (tank units)
//   bio       vec4  feature scale (tank units), speed (tank units/s), coverage, softness
//   bio2      vec4  master strength, evolve (field units/s), pan (radians), stretch (x along the pan)
//   bio3      vec4  octaves (1..4), contrast, warp, pulse amount
//   bio4      vec4  pulse rate (Hz), unused x3
//
// THE POSE is a bone palette in @binding(1): an rgba32float texture, three
// texels per bone (the rows of a 3x4 affine) and one row per sampled frame,
// uploaded once per species by table.luau from the pack. Every instance
// reads its own phase, so a school of one species swims out of step. The
// matrices are RELATIVE to the rest pose the vertices are already in (the
// baker's note), which is what lets a still species and a swimming one share
// this file: a still one is a one-bone identity palette, one texel read.
//
// THE DENT is a collision, and it is deliberately NOT in the skeleton. The
// vertex is skinned first, exactly as it always was, and the dent then warps
// the POSED vertex in the body's own space — so the clip keeps playing
// through a squash, no joint can come apart, and a dent of zero is the exact
// identity (and an early out). baitball.luau owns every number that moves:
// the direction and the place are latched in the body's frame at the contact
// and the depth is a spring ringing back to nothing, so this stage is a pure
// function of them. It is applied in `vs` AND in `vsLine` — the outline is
// the same mesh drawn again, and a body that dented without its line would
// push straight through it.
//
// THE GLOW (bioluminescence) is a noise field in TANK space, not on the body:
// `world` is the fragment's position after the model matrix, so one field
// runs through every body in the tank and a school lights up in a wave that
// crosses from fish to fish, rather than each fish carrying its own private
// pattern. It TRAVELS at `speed` tank units a second along `pan` (0 across
// the card, +90 up it), and separately EVOLVES — the field itself changing
// where it stands — by walking the noise's third axis at `evolve`. `stretch`
// draws the patches out along the travel so a pan reads as a current;
// `octaves` is how much fine detail rides on the big shapes, `contrast`
// sharpens the field before the mask, `warp` bends it with a second field
// (the game's domain warp) and `pulse` breathes the whole thing at a rate.
// Perlin fbm, the game's own field (systems/biolumSkin.js), masked at
// `coverage` with a `softness` shoulder, tinted per card, ADDED to the shaded
// colour. The atlas is 8-bit so it clamps rather than blooms; keep the colour
// saturated and the strength honest.
//
// CEL, not a soft ramp. The light is quantised into `steps` bands with a
// controllable edge, so a body reads as flat colour separated by a hard
// terminator rather than as a sphere. Everything about how that looks is in
// the tuner under `toon` — the number of bands, how hard the step is, how
// dark the shadow side goes, how big the highlight is.
//
// The outline is an INVERTED HULL: the same mesh drawn again, pushed out
// along its normals, with front faces culled so only the inside of the
// expanded shell survives, in flat colour, behind the body. It is a second
// draw of the same instance buffer through `vsLine`/`fsLine` below, and it
// is skinned the same way so the line follows the pose.
// ============================================================================

struct U {
    viewProj: mat4x4<f32>,
    light: vec4f,
    params: vec4f,
    res: vec4f,
    eye: vec4f,
    cel: vec4f,
    line: vec4f,
    bio: vec4f,
    bio2: vec4f,
    bio3: vec4f,
    bio4: vec4f,
    dent: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var palette: texture_2d<f32>;
// THE BEND: the same shape of texture as the palette, but a row per
// INSTANCE rather than per frame — the skeleton's reaction to a collision,
// solved on the CPU a body at a time (bonespring.luau) and uploaded once a
// frame. Identity everywhere nothing has been hit.
//
// Which row is this body's? `rig.x`, a column of its own in the instance
// record. NOT @builtin(instance_index): the Metal backend refuses that
// outright ("attribute 'instance_id' is not supported for target MSL
// version"), which is a compile error and no picture at all. Packing it
// into the whole number of anim.x would also have been free, since the
// pose already read the phase through `fract` — but anim.x MEANS the clip
// phase and there is a test that says so.
@group(0) @binding(2) var bendPal: texture_2d<f32>;

struct VSIn {
    @location(0) pos: vec3f,
    @location(1) nrm: vec3f,
    @location(2) joints: vec4<u32>,
    @location(3) weights: vec4f,
    @location(4) c0: vec4f,
    @location(5) c1: vec4f,
    @location(6) c2: vec4f,
    @location(7) c3: vec4f,
    @location(8) back: vec4f,
    @location(9) belly: vec4f,
    @location(10) tile: vec4f,
    @location(11) anim: vec4f,
    @location(12) bio: vec4f,
    @location(13) dent: vec4f,
    // The glow field's per-card numbers (table.luau resolves a tanks.csv
    // cell or the tuner's global): speed, scale, contrast, coverage; then
    // pan (radians), evolve. Two cards on one screen can run two currents.
    @location(14) bioField: vec4f,
    // pan (radians), evolve, THE BEND ROW, unused.
    //
    // SIXTEEN ATTRIBUTES IS THE CEILING, and the bend row used to be a
    // seventeenth of its own. WebGL2 guarantees MAX_VERTEX_ATTRIBS 16 and
    // WebKit ships exactly the minimum, so `@location(16)` is not merely
    // tight — it fails to compile on every WebGL2 browser: "Attribute
    // location out of range", then the bind group cannot resolve, then the
    // pipeline drops every pass. No fish in any tank on the site, while the
    // native viewer (far more slots) rendered all 52 cards perfectly, so
    // nothing in the project could see it. It rides here because this
    // record already carried two unused floats.
    @location(15) bioField2: vec4f,
};

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) nrm: vec3f,
    @location(1) local: vec3f,
    @location(2) back: vec4f,
    @location(3) view: vec3f,
    @location(4) @interpolate(flat) rect: vec4f,
    @location(5) belly: vec3f,
    // belly.w, carried through: 0 is a lit body, 1 is a flat emissive one.
    // The bubbles are the only thing that uses it, and they use it because a
    // LIT sphere reads as a pearl — the shading is what tells you a thing is
    // solid, so a bubble has to have none.
    @location(6) @interpolate(flat) emissive: f32,
    @location(7) world: vec3f,
    @location(8) @interpolate(flat) bio: vec4f,
    @location(9) @interpolate(flat) bioSpec: vec4f,   // speed, scale, contrast, coverage
    @location(10) @interpolate(flat) bioSpec2: vec2f, // pan, evolve
};

// One bone's 3x4 at frame f, as a mat4.
fn boneAt(j: u32, f: i32) -> mat4x4<f32> {
    let x = i32(j) * 3;
    let r0 = textureLoad(palette, vec2i(x, f), 0);
    let r1 = textureLoad(palette, vec2i(x + 1, f), 0);
    let r2 = textureLoad(palette, vec2i(x + 2, f), 0);
    return mat4x4<f32>(
        vec4f(r0.x, r1.x, r2.x, 0.0),
        vec4f(r0.y, r1.y, r2.y, 0.0),
        vec4f(r0.z, r1.z, r2.z, 0.0),
        vec4f(r0.w, r1.w, r2.w, 1.0));
}

// The instance's skin matrix: its four joints at its own phase, the two
// bracketing frames blended so a 30fps bake does not step, then faded toward
// the identity by the pose weight so a clip can be turned down, not only off.
fn skinOf(in: VSIn) -> mat4x4<f32> {
    let frames = i32(textureDimensions(palette).y);
    let fpos = fract(in.anim.x) * f32(frames);
    let f0 = i32(floor(fpos)) % frames;
    let f1 = (f0 + 1) % frames;
    let t = fract(fpos);
    let row = in.bioField2.z;
    let id = mat4x4<f32>(vec4f(1.0, 0.0, 0.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.0, 1.0, 0.0), vec4f(0.0, 0.0, 0.0, 1.0));
    // The pose weight fades THE CLIP, and only the clip. Faded outside the
    // per-joint loop, as it was, it also faded the bend — and since no
    // species names a clip, that weight is 0 on every body in the game, so
    // the entire skeleton reaction was multiplied away and the sharks came
    // out arrow straight with nothing in the log to say why.
    let w = clamp(in.anim.y, 0.0, 1.0);
    var s = mat4x4<f32>(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
    let js = array<u32, 4>(in.joints.x, in.joints.y, in.joints.z, in.joints.w);
    let ws = array<f32, 4>(in.weights.x, in.weights.y, in.weights.z, in.weights.w);
    for (var k = 0; k < 4; k++) {
        if (ws[k] > 0.0) {
            let a = boneAt(js[k], f0);
            let b = boneAt(js[k], f1);
            let posed = id * (1.0 - w) + (a * (1.0 - t) + b * t) * w;
            s = s + (bendAt(js[k], row) * posed) * ws[k];
        }
    }
    return s;
}

// --- the dent --------------------------------------------------------------
// A squash along the contact normal with a stretch across it, localised to
// the end that was hit, plus a wave of flesh travelling away from the
// contact. Body-local, always: expressed in tank space instead, the squash
// would rotate across the body as it turned and a still fish would shimmer.
//
// u.dent is (spread along the body in body lengths, wobble amplitude, its
// wavenumber in cycles per body length, its travel in cycles/s).
struct Dented { pos: vec3f, nrm: vec3f };

fn dentOf(p: vec3f, nr: vec3f, d: vec4f, z0: f32, age: f32) -> Dented {
    var o: Dented;
    o.pos = p;
    o.nrm = nr;
    let amt = d.w;
    if (abs(amt) < 1e-4) { return o; }
    let n = d.xyz;
    let spread = max(1e-3, u.dent.x);
    // The mesh is canonical: length 1, head at -z, so z is -0.5 .. 0.5 and
    // the spread is in body lengths on every species alike.
    let dz = p.z - z0;
    let w = exp(-(dz * dz) / (2.0 * spread * spread));
    // Squash by s along n and give the volume back ACROSS n — but not
    // evenly. Spreading it over both cross axes stretches an elongated body
    // along its own length, which reads as taffy rather than as flesh, so
    // the share that goes down the body is tied to how AXIAL the hit was:
    // a broadside hit bulges sideways and keeps its length, a nose-on hit
    // has nothing but the cross-section to bulge into and spreads it evenly.
    // Either way the three factors multiply to 1.
    let s = clamp(1.0 - amt * w, 0.15, 2.0);
    let inv = 1.0 / s;
    let axial = abs(n.z);
    let kSide = pow(inv, mix(1.0, 0.5, axial));
    let kAxial = pow(inv, mix(0.0, 0.5, axial));
    let along = dot(p, n);
    let across = p - along * n;
    // The body's long axis as seen inside the cross plane. It vanishes for a
    // nose-on hit, where the two factors have met anyway.
    var zp = vec3f(0.0, 0.0, 1.0) - n * n.z;
    let zl = length(zp);
    var q = n * (along * s);
    if (zl > 1e-3) {
        zp = zp / zl;
        let ca = dot(across, zp);
        q = q + zp * (ca * kAxial) + (across - zp * ca) * kSide;
    } else {
        q = q + across * kSide;
    }
    // The flesh: a wave along the contact normal running away from where it
    // landed, dying over a couple of spreads. It is scaled by `amt`, which
    // is the spring, so it cannot outlive the dent that started it.
    let waveAmp = u.dent.y * amt * exp(-abs(dz) / (2.5 * spread));
    let ph = u.dent.z * dz - u.dent.w * age * 6.2832;
    q = q + n * (waveAmp * sin(ph));
    o.pos = q;
    // The normal takes the RECIPROCAL of the same scaling (an axis squash
    // scales normals by 1/s along it) plus the wave's slope, which is the
    // part the cel terminator actually shows. It drops the gradient of the
    // falloff itself, which is second order for any spread worth using; the
    // alternative is finite-differencing the whole warp three more times.
    let nAlong = dot(nr, n);
    let nAcross = nr - nAlong * n;
    var m = n * (nAlong / s);
    if (zl > 1e-3) {
        let nca = dot(nAcross, zp);
        m = m + zp * (nca / kAxial) + (nAcross - zp * nca) / kSide;
    } else {
        m = m + nAcross / kSide;
    }
    let slope = u.dent.z * cos(ph) * waveAmp;
    m = m - vec3f(0.0, 0.0, 1.0) * (slope * nAlong);
    o.nrm = normalize(m);
    return o;
}

fn bendAt(b: u32, inst: f32) -> mat4x4<f32> {
    let x = i32(b) * 3;
    // Clamped: a species whose bend texture failed has one row, and reading
    // past it returns zeros — which is not "no bend", it is a body
    // collapsed to a point.
    let y = clamp(i32(inst), 0, i32(textureDimensions(bendPal).y) - 1);
    let r0 = textureLoad(bendPal, vec2i(x, y), 0);
    let r1 = textureLoad(bendPal, vec2i(x + 1, y), 0);
    let r2 = textureLoad(bendPal, vec2i(x + 2, y), 0);
    return mat4x4<f32>(vec4f(r0.x, r1.x, r2.x, 0.0), vec4f(r0.y, r1.y, r2.y, 0.0), vec4f(r0.z, r1.z, r2.z, 0.0), vec4f(r0.w, r1.w, r2.w, 1.0));
}

fn tileRect(tile: vec4f) -> vec4f {
    // The tile's pixel rect, from its NDC rect (y down in pixels).
    let x0 = (tile.x - tile.z) * 0.5 + 0.5;
    let x1 = (tile.x + tile.z) * 0.5 + 0.5;
    let y0 = 1.0 - ((tile.y + tile.w) * 0.5 + 0.5);
    let y1 = 1.0 - ((tile.y - tile.w) * 0.5 + 0.5);
    return vec4f(x0 * u.res.x, y0 * u.res.y, x1 * u.res.x, y1 * u.res.y);
}

@vertex
fn vs(in: VSIn) -> VSOut {
    let model = mat4x4<f32>(in.c0, in.c1, in.c2, in.c3);
    let skin = skinOf(in);
    // Skin, THEN dent: the pose is the skeleton's and the dent is the
    // flesh's, and in that order neither can break the other.
    let posed = skin * vec4f(in.pos, 1.0);
    let dented = dentOf(posed.xyz, (skin * vec4f(in.nrm, 0.0)).xyz, in.dent, in.anim.z, in.anim.w);
    let world = model * vec4f(dented.pos, 1.0);
    var o: VSOut;
    var clip = u.viewProj * world;
    clip = vec4f(clip.xy * in.tile.zw + in.tile.xy * clip.w, clip.zw);
    o.pos = clip;
    o.rect = tileRect(in.tile);
    o.nrm = normalize((model * vec4f(dented.nrm, 0.0)).xyz);
    o.local = in.pos;
    o.back = in.back;
    o.belly = in.belly.rgb;
    o.emissive = in.belly.w;
    o.view = normalize(u.eye.xyz - world.xyz);
    o.world = world.xyz;
    o.bio = in.bio;
    o.bioSpec = in.bioField;
    o.bioSpec2 = in.bioField2.xy;
    return o;
}

// --- the glow's field --------------------------------------------------------
// Perlin fbm, three octaves: the game's noise (systems/noiseGlsl.js,
// biolumSkin.js's bioPerlin) in WGSL, so a tank's light is the same stuff the
// creatures glow with on the seabed.
fn bioHash3(p: vec3f) -> vec3f {
    let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)), dot(p, vec3f(269.5, 183.3, 246.1)), dot(p, vec3f(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(q) * 43758.5453123);
}
fn bioPerlin(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let w = f * f * (3.0 - 2.0 * f);
    let a = dot(bioHash3(i + vec3f(0.0, 0.0, 0.0)), f - vec3f(0.0, 0.0, 0.0));
    let b = dot(bioHash3(i + vec3f(1.0, 0.0, 0.0)), f - vec3f(1.0, 0.0, 0.0));
    let c = dot(bioHash3(i + vec3f(0.0, 1.0, 0.0)), f - vec3f(0.0, 1.0, 0.0));
    let d = dot(bioHash3(i + vec3f(1.0, 1.0, 0.0)), f - vec3f(1.0, 1.0, 0.0));
    let e = dot(bioHash3(i + vec3f(0.0, 0.0, 1.0)), f - vec3f(0.0, 0.0, 1.0));
    let g = dot(bioHash3(i + vec3f(1.0, 0.0, 1.0)), f - vec3f(1.0, 0.0, 1.0));
    let h = dot(bioHash3(i + vec3f(0.0, 1.0, 1.0)), f - vec3f(0.0, 1.0, 1.0));
    let k = dot(bioHash3(i + vec3f(1.0, 1.0, 1.0)), f - vec3f(1.0, 1.0, 1.0));
    return mix(mix(mix(a, b, w.x), mix(c, d, w.x), w.y), mix(mix(e, g, w.x), mix(h, k, w.x), w.y), w.z);
}
fn bioFbm(p0: vec3f, octaves: i32) -> f32 {
    var p = p0;
    var v = 0.0;
    var a = 0.5;
    var norm = 0.0;
    for (var i = 0; i < 4; i++) {
        if (i >= octaves) { break; }
        v += a * bioPerlin(p);
        norm += a;
        p *= 2.02;   // not exactly 2, so the octave lattices never line up
        a *= 0.5;
    }
    // Normalised, so one octave and four fill the same range and the
    // coverage slider means the same thing at every octave count.
    return v / max(0.5, norm) * 0.875;
}

// The light on this fragment: the field at its TANK position, drifting, cut
// at the coverage with a soft shoulder. 0 for a card with no glow, so the
// noise is never even evaluated there.
fn bioGlow(world: vec3f, bio: vec4f, spec: vec4f, spec2: vec2f) -> vec3f {
    let strength = bio.w * u.bio2.x;
    if (strength <= 0.0) {
        return vec3f(0.0);
    }
    let scale = max(0.05, spec.y);
    let t = u.light.w;
    let octaves = clamp(i32(u.bio3.x + 0.5), 1, 4);
    // The travel: along `pan` in the card plane, at `speed`.
    let dir = vec3f(cos(spec2.x), sin(spec2.x), 0.0);
    var q = world - dir * (spec.x * t);
    // The stretch: the coordinate ALONG the travel is compressed, so the
    // patches are drawn out that way and a pan reads as a current.
    let along = dot(q, dir);
    q = q - dir * along * (1.0 - 1.0 / max(0.1, u.bio2.w));
    q = q / scale;
    // The evolution: the field walks its own third axis, changing in place
    // whether or not it is travelling.
    q.z += spec2.y * t;
    // The warp: a second field displaces the sample (biolumSkin's bioWarp).
    if (u.bio3.z > 0.0) {
        let w = vec2f(bioFbm(q * 0.6 + vec3f(31.7, 0.0, 0.0), 2), bioFbm(q * 0.6 + vec3f(0.0, 17.3, 0.0), 2));
        q += vec3f(w * u.bio3.z, 0.0);
    }
    var n = bioFbm(q, octaves) * 0.5 + 0.5;
    n = 0.5 + (n - 0.5) * max(0.05, spec.z);
    let cov = 1.0 - clamp(spec.w, 0.0, 1.0);
    let soft = max(0.005, u.bio.w);
    let m = smoothstep(cov - soft, cov + soft, n);
    // The pulse: the whole glow breathes, never fully out at amount 1.
    let breath = 1.0 - clamp(u.bio3.w, 0.0, 1.0) * 0.5 * (1.0 - sin(t * u.bio4.x * 6.2831853));
    return bio.rgb * m * strength * breath;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    if (in.pos.x < in.rect.x || in.pos.x > in.rect.z || in.pos.y < in.rect.y || in.pos.y > in.rect.w) { discard; }
    let n = normalize(in.nrm);
    let l = normalize(u.light.xyz);
    let v = normalize(in.view);
    // Countershading: the back's colour above, the belly's below, a flank
    // between — by the body's own up axis, so it stays painted on as the
    // body rolls. The species picks the two colours (tanks.csv).
    let up = clamp(in.local.y * 2.0 + 0.5, 0.0, 1.0);
    let back = in.back.rgb * u.params.x;
    let belly = in.belly * u.params.y;
    let flank = mix(belly, back, 0.55);
    var base = mix(belly, flank, smoothstep(0.0, 0.45, up));
    base = mix(base, back, smoothstep(0.5, 0.95, up));
    // THE CEL RAMP. Lambert, quantised: `steps` bands between the shadow
    // floor and full light, each edge softened by `soft`.
    //
    // The softening is in the LIGHT term, before quantising, and it is what
    // separates cel shading from posterisation. A hard floor() alone aliases
    // horribly on a curved body at this size — the terminator crawls a pixel
    // at a time as the fish turns, and at tile resolution that reads as the
    // silhouette fizzing. Mixing each step toward the next across `soft` puts
    // a controlled, sub-band gradient exactly on the edge and nowhere else.
    let steps = max(1.0, floor(u.cel.x + 0.5));
    let soft = max(0.0001, u.cel.y);
    let floorLit = clamp(u.cel.z, 0.0, 1.0);
    let ndl = max(dot(n, l), 0.0);
    let scaled = ndl * steps;
    let stepIndex = floor(scaled);
    let intoStep = scaled - stepIndex;
    // `soft` as a fraction of one band, so the edge keeps its look when the
    // number of bands changes — otherwise adding a band re-softens everything.
    let lit = (stepIndex + smoothstep(1.0 - soft, 1.0, intoStep)) / steps;
    var col = base * mix(floorLit, 1.0, lit);
    // The highlight is a band too, not a falloff: cel art puts a flat shape
    // of light on a thing, and `u.cel.w` is how much of the body it covers.
    let h = normalize(l + v);
    let specSize = clamp(u.cel.w, 0.0, 1.0);
    let specTerm = pow(max(dot(n, h), 0.0), 48.0) * (0.5 + in.back.w);
    let spec = smoothstep(1.0 - specSize, 1.0 - specSize * 0.6, specTerm);
    col += vec3f(spec) * 0.8;
    let rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * u.params.z;
    col += vec3f(0.3, 0.7, 0.9) * rim;
    // The glow, on a lit body only: a bubble is already all light.
    col += bioGlow(in.world, in.bio, in.bioSpec, in.bioSpec2) * (1.0 - in.emissive);
    // An emissive body keeps its own colour whatever the light is doing, and
    // takes the rim brighter — the edge is the only part of a bubble there is
    // anything to see on.
    let glow = in.back.rgb * (0.75 + 0.85 * pow(1.0 - max(dot(n, v), 0.0), 2.0));
    col = mix(col, glow, in.emissive);
    return vec4f(col, 1.0);
}

// ---------------------------------------------------------------------------
// THE OUTLINE — the same mesh, the same instances, pushed out along its
// normals and drawn in flat colour with FRONT faces culled, so what survives
// is the inside of a shell slightly larger than the body. Drawn first; the
// body then covers all of it but the rim.
//
// The push is applied in WORLD space, after the model matrix, so the line is
// the same weight on every creature. Pushing in local space instead would
// scale the line with the body and the sardines would have a hairline while
// the octopus wore a band — the trap this project has hit before with a
// thickness quoted in source units on a model of a different size.
// ---------------------------------------------------------------------------
@vertex
fn vsLine(in: VSIn) -> VSOut {
    let model = mat4x4<f32>(in.c0, in.c1, in.c2, in.c3);
    let skin = skinOf(in);
    // The same dent as the body, or the body pushes through its own line.
    let dented = dentOf((skin * vec4f(in.pos, 1.0)).xyz, (skin * vec4f(in.nrm, 0.0)).xyz, in.dent, in.anim.z, in.anim.w);
    var world = model * vec4f(dented.pos, 1.0);
    let worldN = normalize((model * vec4f(dented.nrm, 0.0)).xyz);
    world = vec4f(world.xyz + worldN * u.line.w, world.w);
    var o: VSOut;
    var clip = u.viewProj * world;
    clip = vec4f(clip.xy * in.tile.zw + in.tile.xy * clip.w, clip.zw);
    o.pos = clip;
    o.rect = tileRect(in.tile);
    o.nrm = worldN;
    o.local = in.pos;
    o.back = in.back;
    o.belly = in.belly.rgb;
    o.emissive = in.belly.w;
    o.view = normalize(u.eye.xyz - world.xyz);
    o.world = world.xyz;
    o.bio = in.bio;
    o.bioSpec = in.bioField;
    o.bioSpec2 = in.bioField2.xy;
    return o;
}

@fragment
fn fsLine(in: VSOut) -> @location(0) vec4f {
    if (in.pos.x < in.rect.x || in.pos.x > in.rect.z || in.pos.y < in.rect.y || in.pos.y > in.rect.w) { discard; }
    // A bubble is a few pixels of flat white; a line around it is most of the
    // bubble. The emissive bodies opt out.
    if (in.emissive > 0.5) { discard; }
    return vec4f(u.line.rgb, 1.0);
}
