// ============================================================================
// FOAM — the whitewater, simulated. A half-size buffer that persists from
// frame to frame (two canvases, ping-pong): each frame this pass reads the
// last frame's foam where the water's flow carried it FROM (the vortex's own
// spin and inward drift, so froth whirls into the eye the way the water
// does), spreads it a little, lets it fade, and then adds what this frame
// stirred up —
//
//   IMPACTS   a card played to its slot slaps the water: a front the exact
//             shape of the card races outward, thick and full of trapped
//             air at first, thinning as it goes; the card's footprint is
//             whipped white for a beat.
//   MOVERS    a card in flight or in hand pushes a bow wave off its leading
//             edge, in proportion to its speed.
//   THE SEAL  froth along its flanks and a churned tail behind it while it
//             swims, nothing while it rests.
//
// R is foam, G is trapped air (what surface.wgsl draws as fine bubbles).
// surface.wgsl breaks it up with noise when it draws it; this buffer stays
// smooth so the advection has something to carry.
//
// Uniform layout (16-byte rows):
//   row 0  res.xy, time, dt
//   row 1  table W, H, energy, fade (s)
//   row 2  vortex centre.xy (uv), twist, speed — the vortex's
//   row 3  seal x, y (px), heading, speed (px/s)
//   row 4  seal length (px), whitewater, nImpacts, nMovers
//   rows 5..20   impacts, two rows each: cx, cy, hw, hh | rot, age, strength, 0
//   rows 21..44  movers, two rows each:  cx, cy, hw, hh | rot, speed, dirx, diry
// ============================================================================

const MAX_IMPACTS: u32 = 8u;
const MAX_MOVERS: u32 = 12u;

struct U {
    a: vec4f,
    b: vec4f,
    c: vec4f,
    d: vec4f,
    e: vec4f,
    impacts: array<vec4f, 16>,
    movers: array<vec4f, 24>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var prev: texture_2d<f32>;
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

fn sdBox(p: vec2f, c: vec2f, half: vec2f, rot: f32, r: f32) -> f32 {
    let cs = cos(rot);
    let sn = sin(rot);
    let q0 = p - c;
    let q = vec2f(cs * q0.x + sn * q0.y, -sn * q0.x + cs * q0.y);
    let d = abs(q) - half + vec2f(r);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

// Where the water carries a point in one second, in uv, from the vortex's
// own motion: its angle advances at speed * 0.35 and its log-radius drifts
// in at speed * 0.25 (vortex.wgsl), which is a spin and an inward pull.
fn flow(uv: vec2f) -> vec2f {
    let table = u.b.xy;
    let aspect = table.x / table.y;
    let centre = u.c.xy;
    let speed = u.c.w;
    var q = uv - centre;
    q.x *= aspect;
    let r = max(length(q), 0.02);
    let tang = vec2f(-q.y, q.x) / r * (speed * 0.35 * r);
    let radial = -q / r * ((r + 0.08) * speed * 0.227);
    var v = (tang + radial) * 0.35;
    v.x /= aspect;
    return v;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let res = u.a.xy;
    let t = u.a.z;
    let dt = u.a.w;
    let table = u.b.xy;
    let energy = u.b.z;
    let fade = max(0.05, u.b.w);
    let white = u.e.y;
    let nImpacts = u32(u.e.z);
    let nMovers = u32(u.e.w);
    let p = in.uv * table;

    // Carry: read where the flow brought this point from, blurred a texel
    // each way so the froth spreads as it goes.
    let src = in.uv - flow(in.uv) * dt;
    let tx = 1.0 / res;
    var old = textureSample(prev, samp, src).rg * 0.4;
    old += textureSample(prev, samp, src + vec2f(tx.x, 0.0)).rg * 0.15;
    old += textureSample(prev, samp, src - vec2f(tx.x, 0.0)).rg * 0.15;
    old += textureSample(prev, samp, src + vec2f(0.0, tx.y)).rg * 0.15;
    old += textureSample(prev, samp, src - vec2f(0.0, tx.y)).rg * 0.15;
    let carried = vec2f(old.x * exp(-dt / fade), old.y * exp(-dt / (fade * 0.45)));
    var foam = 0.0;
    var air = 0.0;

    // Impacts: a front the shape of the card.
    for (var i = 0u; i < MAX_IMPACTS; i++) {
        if (i >= nImpacts) { break; }
        let i0 = u.impacts[i * 2u];
        let i1 = u.impacts[i * 2u + 1u];
        let age = i1.y;
        let strength = i1.z;
        let d = sdBox(p, i0.xy, i0.zw, i1.x, 10.0);
        // The front leaves the card's edge at once and slows as it spreads.
        // It is painted over the whole distance it covered THIS step, from
        // where it was to where it is, so a long step (a hitch, a headless
        // render) leaves a band and not a gap.
        let v0 = (0.75 + 0.6 * strength) * 520.0;
        let r1 = v0 * (1.0 - exp(-age * 2.2)) / 2.2;
        let r0 = v0 * (1.0 - exp(-max(age - dt, 0.0) * 2.2)) / 2.2;
        let width = 6.0 + 14.0 * age + 4.0 * strength;
        let band = smoothstep(r0 - width, r0, d) * (1.0 - smoothstep(r1, r1 + width, d));
        let life = exp(-age * 1.4);
        foam += band * life * strength * 1.1;
        // Trapped air: thick in the front early, gone by the time it thins.
        air += band * strength * smoothstep(1.1, 0.0, age) * 0.9;
        // The slap: the footprint itself goes white for a beat.
        let slap = (1.0 - smoothstep(-6.0, 6.0, d)) * smoothstep(0.35, 0.0, age);
        foam += slap * strength * clamp(dt * 24.0, 0.0, 1.0);
        air += slap * strength * clamp(dt * 10.0, 0.0, 1.0);
    }

    // Movers: a bow wave off the leading edge.
    for (var i = 0u; i < MAX_MOVERS; i++) {
        if (i >= nMovers) { break; }
        let m0 = u.movers[i * 2u];
        let m1 = u.movers[i * 2u + 1u];
        let d = sdBox(p, m0.xy, m0.zw, m1.x, 10.0);
        let toP = p - m0.xy;
        let lead = smoothstep(-0.2, 0.8, dot(normalize(toP + vec2f(0.001)), m1.zw));
        let push = clamp(m1.y / 900.0, 0.0, 1.2);
        let edge = exp(-pow(d / 9.0, 2.0));
        foam += edge * lead * push * dt * 9.0;
        air += edge * lead * push * dt * 3.0;
    }

    // The seal: a capsule down its spine; froth on the flanks, churn behind.
    let seal = u.d.xy;
    let heading = u.d.z;
    let sealSpeed = clamp(u.d.w / 420.0, 0.0, 1.3);
    let L = max(40.0, u.e.x);
    let fwd = vec2f(sin(heading), -cos(heading));
    let right = vec2f(cos(heading), sin(heading));
    let nose = seal + fwd * L * 0.42;
    let tail = seal - fwd * L * 0.4;
    let ds = sdSegment(p, tail, nose) - L * 0.1;
    let flank = exp(-pow(ds / (L * 0.045), 2.0)) * step(0.0, ds);
    foam += flank * sealSpeed * dt * 6.0;
    let sd = p - seal;
    let qf = dot(sd, fwd);
    let qr = dot(sd, right);
    let behind = smoothstep(-L * 0.3, -L * 0.5, qf);
    let churn = behind * exp(-pow(qr / (L * 0.13), 2.0)) * exp((qf + L * 0.4) / (L * 0.5));
    foam += churn * sealSpeed * sealSpeed * dt * 7.0;
    air += churn * sealSpeed * dt * 4.0;

    foam = clamp(carried.x + foam * white, 0.0, 1.6);
    air = clamp(carried.y + air * white, 0.0, 1.6);
    return vec4f(foam, air, 0.0, 1.0);
}
