# Goo and bubbles: porting the three.js VFX to UE5 (Niagara)

Working doc. Source of truth is the three.js code; this describes what to rebuild and in what order.
Sources: `path/src/entities/particles.js` (sim + splat), `path/src/systems/post.js` (`gooFragmentShader`,
the isoline composite), `path/src/systems/bubbles.js` (seal emitters), `CONFIG.emitters` and `CONFIG.fx.goo`
in `path/src/config.js`, tuned values in `path/src/imported-tuning.json`.

## How the three.js version works

**One shared particle buffer, simulated entirely in the vertex shader, closed form.** Each particle stores
origin, velocity, drag, gravity, start time, life, size. Position at age `t`:

```
disp.xyz = v * (1 - exp(-k t)) / k            // velocity under linear drag
disp.xy += 0.5 * g * t^2                      // gravity
pos.xy  += turbulenceAt(pos.xy * freq, time * rate) * (strength * aTurb * t)   // curl-ish current
turbulenceAt(p, t) = ( sin(p.y+t)        + 0.5 sin(2.13 p.y - 1.70 t + 1.3),
                       sin(1.17 p.x - t) + 0.5 sin(2.47 p.x + 1.10 t + 4.1) )
```

Turbulence is sampled at the ballistic position (not the displaced one) so there is no self-advection and
the CPU twin agrees exactly. Particles with `aClip = 1` die at the water line (`surfaceHeightAt(x)`), and
`surfacePop: 'bubbleBurst'` spawns another emitter where they break the surface.

**Bubbles** (`breathBubbles`, `wakeBubbles`, `bubbleBurst`, `blastBubbles`...) are plain sprite discs from
that buffer: alpha disc with `smoothstep(0.25, 0, d)` edge, colour from a small palette, size shrinking to
35% over life, alpha = `1 - t`. Seal emitters are anchored to bones: breath is a randomised timer puff from
the mouth; wake is continuous from the hind flipper tips or tail, rate scaled by speed, silent below
`minSpeed`. Underwater only.

**Goo is the same particles drawn a second time, as metaballs in screen space.** Particles flagged
`goo: <group>` are splatted into a half/third-res offscreen target as soft density:

```
f = (1 - d)^3,  d = dot(uv,uv)*4  (1 at sprite edge);   out = (rgb*w, w),  w = f * alpha     // additive, premultiplied
splat diameter = particle size * group.radius * pixelsPerUnit
```

`post.js` then thresholds that field: `a = smoothstep(iso - soft, iso + soft, density)`, colour =
`rgb / a`-style divide-out, a normal from the density gradient, a **rim** band just inside the isoline,
a **specular** off that normal. Each substance is its own group (own field, own surface): blood, smoke,
hit, pickup, suck, ichor, aura, gooWall, foam, gore, boom. Foam adds whitewater/air bubbles and ocean murk/fog.

Density over life is held flat then released (`legacyAlpha`), or follows a per-particle randomised
rise-peak-fall curve (`uGooCurve*`) with a hash of velocity and burst start time.

Tuned values that actually render (these beat `config.js`): default `divisor 3, radius 3.4, iso 0.9,
soft 0.22, rim 1.05, spec 1.2, normal 6`; `pickup` iso 0.28 additive; `foam` iso 0.57 soft 0.45 additive,
no spec; `smoke` alpha not additive, iso 0.34 soft 0.5; `hit` additive radius 5.8. Read the full set from
the exporter below rather than from this paragraph.

## UE5 plan

### 1. Data first: export, don't retype

`tools/ue5-vfx-export.mjs` (to build): loads `config.js` with the JSON loader shim, resolves the tuned
values, and writes `build/ue5-vfx/emitters.json` and `goo-groups.json` (+ turbulence constants, wave
constants, group order). In UE these become a DataTable / DataAsset, so retuning in the game's tuner and
re-exporting updates UE without hand edits.

### 2. Bubbles: Niagara GPU emitter, closed form

One generic emitter, all fields as User Parameters from the data table. Per-particle on a GPU sim stage:

- Position from the formula above in a Custom HLSL module (no integration, so it matches the three.js
  twin exactly). Spawn with `speed`, `cone`, `inherit` (fraction of the parent's velocity), `drag`, `gravity`,
  `size`, `life`, palette colour.
- Turbulence: the sine field above in Custom HLSL. `uTurb` (strength, spatial frequency, time scale) from CONFIG.
- Sprite material: unlit, translucent, `edge = smoothstep(0.25, 0, d)`, emissive from `glow`.
- Water line: Kill when `pos.z > SurfaceZ(x)`; use Death Event to spawn the `surfacePop` emitter. UE has no
  `WAVE`, so use a flat water plane or sample the water body; keep it a parameter.
- Seal emitters: attach to sockets `head_07`/`mouth_08` (breath) and `tail02_023`/`foot_*` (wake); drive spawn
  rate from the pawn's speed (`minSpeed` gate). The 3D seal has no fixed back-plane: **decide whether bubbles
  rise in world +Z or screen-up** (the game is a side view; world +Z is the natural 3D reading).
- Unit scale: game size/speed numbers are in game units. The 3D seal is about 211 cm; the 2D seal is a few
  game units long, so start with a single `WorldUnitToCm` parameter (about 50 as a first guess, **unmeasured**)
  and tune against the seal's size on screen. Never place VFX in hand-typed UE units.

Do bubbles first: no post process, quick to compare against the three.js version.

### 3. Goo: capture target + post-process threshold

Closest equivalent to the screen-space isoline pass:

1. **Splat emitters.** Same Niagara emitters, goo-flagged particles use `M_GooSplat`: unlit, Additive,
   output `(rgb*w, w)` with `w = (1-d)^3 * alpha`. Sprite size = `size * group.radius` (perspective applies
   for free, replacing `uScale`).
2. **Density field.** A SceneCapture2D (RGBA16F render target, resolution = screen / `divisor`) with
   `ShowOnly` set to the goo actors, matching the main camera's transform, FOV and aspect every tick. One RT
   per group, or one RT with groups in separate channels if only a few are active. Skip a group's capture while
   nothing is alive in it (the game does the same).
3. **Composite.** A post-process material (After Tonemapping or Before, to taste) that samples the RT with
   bilinear filtering and ports `gooFragmentShader`: isoline `smoothstep`, colour divide-out, gradient normal
   (central differences on density), rim, specular, additive/alpha switch per group, plus opacity.
4. **Defer the rest.** Mottle, outline, whitewater, ocean murk/fog, team tint and the glass-wetness path are
   not needed for a first match; add them after the base surface matches.

Alternatives, if the capture route fights UE 5.9: Niagara Fluids (different look, much heavier), or Niagara
mesh particles with a metaball-ish sphere shader (cheap, but no real fusion between particles). The isoline
field is what makes it read as goo, so keep it unless it proves unworkable.

### 4. Verify side by side

Record a three.js burst (fixed seed, fixed camera) and the UE one at matching size and time, then compare
frames: where the isoline breaks, how long the neck lasts, when the rim fades. Match `iso` and `soft` first,
then `radius`, then lighting.

## Reality check on tooling

- Materials and HLSL custom nodes can be written as text and pasted in. **Niagara systems are binary
  `.uasset`** and are awkward to author from a script; expect the first Niagara emitter to be assembled by
  hand in the editor from this spec, then data-driven from there. The PC-side session can do the editor work
  if it has the Unreal Python plugin enabled; confirm what it can create before committing to a route.
- UE 5.9 is a preview; node names and capture settings may differ from 5.5/5.6 docs.

## Open questions

- Rise direction: world +Z, or screen-up, given the third-person follow camera?
- All eleven goo groups, or just the seal's (pickup, foam, blood)? Recommend starting with pickup + foam.
- Is this for gameplay VFX in a UE version of the game, or a look reference for a trailer?
