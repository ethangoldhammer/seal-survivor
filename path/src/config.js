import importedTuning from './imported-tuning.json';
import upgradesCsv from './upgrades.csv?raw';
import raritiesCsv from './rarities.csv?raw';
import enemiesCsv from './enemies.csv?raw';
import spawningCsv from './spawning.csv?raw';
import weaponsCsv from './weapons.csv?raw';
import behaviourCsv from './behaviour.csv?raw';
import { parseUpgradeCsv, applyUpgradeTable } from './upgradeTable.js';
import { parseRarityCsv, buildRarities, checkRaritySfx } from './rarityTable.js';
// A leaf module on purpose — see the note at the top of it. The tuner's beat
// pickers are built from the same list systems/beatSync.js interprets, and
// config.js cannot import beatSync (beatSync imports CONFIG).
import { BEAT_DIVISIONS, divisionBeatsIn, nearestDivisionIn } from './beatDivisions.js';
// A leaf, like beatDivisions above it: the star field's placement rule, with
// no imports of its own, so the tuner can count the field it is about to build
// without config.js having to import the system that builds it.
import { STAR_THRESHOLD, starsIn } from './systems/starField.js';
import { chainReachAt } from './systems/constellationReach.js';
import {
  parseEnemyCsv, applyEnemyTable, captureEnemyBase, withoutEnemyTableFields,
  ENEMY_TABLE_FIELDS,
} from './enemyTable.js';
import { createPathTable, stripAllTables } from './pathTable.js';
import { withoutAssetTableFields } from './assetTable.js';

// ============================================================================
// CONFIG — every gameplay number lives here. Nothing else hardcodes balance.
// Edit values, save, and Vite hot-reloads. Or press ` in game to tune live.
// ============================================================================

export const CONFIG = {
  // 'side'    — vertical slice of ocean, creatures seen in profile (current)
  // 'topDown' — original overhead view, creatures seen from above
  // Only changes how models are oriented; the gameplay is identical either way.
  view: 'side',

  // Per-creature look overrides from the T-menu's Creatures tab (tint,
  // emissive, glow, roughness, texture repeat, size, variant index). Starts
  // empty — a key only appears here once that creature's row is touched —
  // and round-trips through the same localStorage mechanism as everything
  // else in DEFAULTS below, so a reload restores exactly what you set.
  assetLooks: {},

  arena: {
    viewHeight: 52, // world units visible top to bottom
    surfaceFromTop: 0.2, // water line, as a fraction of screen height
    // How much WIDER than the frame the walls sit, 1 = flush with the screen
    // edge (how it was before this knob existed). Above 1 the ocean runs off
    // past both sides and the camera pans to follow — the only way to get
    // more room to swim sideways without zooming the whole game out, because
    // the frame's width is `viewHeight * aspect` and nothing else.
    //
    // It buys travel, not density: spawn rate, concurrent caps and every
    // creature budget are per-second numbers that know nothing about the
    // arena, so a wider ocean is the same pressure arriving from further out.
    // At 2 a flat-out crossing takes 6.7s instead of 3.7s.
    widthScale: 2,
    // How much higher than the frame the CEILING sits, as a multiple of the
    // visible air band. The ceiling is real — clampToArena stops a breach
    // dead at it — and at 1 it sat 9.4 units up, which a plain straight-up
    // strike dash overshoots by 5.7 units and a combo'd one by sixty. So this
    // is the knob that stops jumps getting caught; `surfaceFromTop` only
    // moves the water line within the frame and pays for air with depth.
    airScale: 3,
    wallRestitution: 0.5, // 0 = stick to wall, 1 = perfect bounce

    // GRAVITY — the world's now, not just the player's, and a real number
    // rather than a taste one.
    //
    // The scale it is derived from: the seal renders 6.14 world units nose to
    // tail (assets.js `fit: 2.6` times the 2.36 in assets.csv) for an animal
    // that is about two metres long, so ONE WORLD UNIT IS ~0.33 m and 9.81
    // m/s^2 lands at 29.7 u/s^2. The same scale says the 34 u/s top swim speed
    // is 11 m/s, which is a real seal flat out — so the ocean is honest about
    // its size and gravity can be honest with it.
    //
    // Everything that falls THROUGH AIR reads this one number: the seal, any
    // shot that breaks the surface (see entities/projectiles.js), a body off a
    // deck, wreckage, spilled chum, a porpoising dolphin. That is the whole
    // point of it being here rather than five numbers between 9 and 26 — a
    // shell and the seal that fired it trace the same curve, so the arc reads
    // as the world working on both of them.
    //
    // Nothing UNDERWATER uses it. Water cancels most of a body's weight and
    // adds drag that dwarfs what is left, so a sinking body (death.sinkGravity),
    // a settling chunk (boats.debris.waterGravity), a walking crab
    // (crabPhysics.gravity) and a drifting orb keep their own, much gentler,
    // numbers. Being submerged is the exception, and it is spelled out at each
    // of those sites.
    //
    // Renamed from `airGravity` deliberately: a saved snapshot wins over a
    // config.js default for any key it already holds, and every snapshot on
    // disk carries `airGravity: 29.5` from before this was tuned. A new name
    // is the only way a new default is what actually loads.
    gravity: 29.7,

    // Drag above the water line, per 1/60 s frame — the same units as
    // `player.friction`, which is what this replaces up there.
    //
    // The seal used to keep its WATER friction in the air: 0.98 per frame is
    // 0.98^60 = 0.30 of your speed left after one second, i.e. air that bled
    // 70% of a breach every second. That is what made a jump feel like it was
    // pushing through syrup — the arc lost its horizontal run and came down
    // near where it left, and no gravity value could fix it because gravity
    // was not what was flattening it.
    //
    // Real air drag on a two-metre animal at 10 m/s is about 0.05 m/s^2 —
    // nothing next to gravity — so this is nearly 1. Not exactly 1: the last
    // sliver keeps a maximum-speed strike dash from parking itself against the
    // arena ceiling, and at 0.999 (94% of your speed per second) it costs a
    // 20 u/s breach about 1.2 u/s^2, still 25x under gravity.
    airDrag: 0.999,

    // Share of `gravity` a fired shot feels once it is above the water, 0..1.
    // At 1 a bullet and the seal fall at the same rate, which is the honest
    // reading and the one this ships at; below it the shots hang and the seal
    // does not, which is a look rather than a physics.
    //
    // Self-propelled ordnance is exempt at the source regardless of this —
    // a missile under thrust and a scallop clapping its way across the sky are
    // not in free fall. See entities/projectiles.js.
    projectileGravity: 1,

    showDepthLines: true,
    depthLineSpacing: 6,
    waveAmplitude: 0.35,
    waveSpeed: 0.8,
  },

  // ---------------------------------------------------------------------------
  // WALL ROCKS — the boundary, drawn (systems/wallRocks.js).
  //
  // Scenery only. The wall itself is clampToArena and always has been; this is
  // what makes it legible now that `arena.widthScale` has moved it off the
  // edge of the screen and into open water. Rebuilt on resize, from a fixed
  // seed, so it is the same shore every time.
  wallRocks: {
    enabled: true,
    seed: 1337,
    count: 26,        // boulders per wall
    size: [1.6, 4.4], // radius range, world units
    taper: 0.35,      // how much smaller they get toward the top, 0..1
    roughness: 0.32,  // vertex displacement, 0 is a smooth ball
    detail: 1,        // icosahedron subdivisions; 2 quadruples the vertex count
    bury: 2.5,        // units of the stack sunk below the seabed
    aboveWater: 5,    // how far the shore breaks the surface
    z: -2.2,          // behind the swimming plane, in front of the seabed
    color: 0x0d2230,
  },

  // ---------------------------------------------------------------------------
  // AIM INDICATOR — where the GUN is pointing (systems/aimIndicator.js).
  //
  // Two independent halves, so `enabled` on top of them gives three real
  // looks: a beam on its own, a reticle on its own, or the pair. Off by
  // default; the game has always aimed without one.
  //
  // Distinct from the dash corridor in cinecam.lens.path, and the two can
  // legitimately contradict each other on screen: this follows input.aim
  // (cursor / right stick), the corridor follows the dash heading — halfway
  // between the swim and the aim, see strike.aimBlend — and aiming one way
  // while swimming another is ordinary play.
  aimIndicator: {
    enabled: false,
    opacity: 1,
    // What it drops to when nothing is firing, as a fraction of `opacity`. A
    // permanent full-strength beam becomes furniture and stops being read.
    idleOpacity: 0.55,
    fade: 0.12, // seconds, the ease between those two states
    z: -0.04,

    line: {
      enabled: true,
      color: 0x6fd3ff,
      glow: 1.4,
      start: 1.2,     // gap between the seal and the near end, world units
      length: 16,
      width: 0.16,    // half-width of the core
      softness: 0.75, // 0 is a hard-edged bar, 1 is all falloff and no core
      fade: 0.8,      // how much it dims toward the far end, 0..1
      dashed: false,
      dashSize: 1.6,  // world units per dash + gap
      dashDuty: 0.55, // the lit fraction of that
      dashSpeed: 6,   // world units/s, scrolling away from the seal
    },

    reticle: {
      enabled: true,
      color: 0x9fe8ff,
      glow: 1.6,
      // Stand-off along the aim. There is no "range" for it to sit at — the
      // guns fire along a direction — so this is a look, not a measurement.
      distance: 16,
      radius: 1.1,
      thickness: 0.16,
      tickCount: 4,    // 0 for a bare ring
      tickLength: 0.5,
      tickWidth: 0.14,
      dot: 0.18,       // 0 for no centre dot
      spinSpeed: 0,    // rad/s; 0 for a fixed reticle
    },
  },

  camera: {
    followPlayer: false,
    followLerp: 0.08,
    // A punch-in: the frustum snaps tighter and eases back out. Distinct from
    // shake, which rattles the camera without changing what's in frame — this
    // is the lens leaning in, and it's what sells a chain extension as heavy
    // rather than merely loud. Independent of `followPlayer`, which is off in
    // the saved tuning; a punch has to land whether the camera tracks or not.
    punch: {
      enabled: true,
      max: 0.14,  // ceiling on total zoom, or a long chain walks the camera in
      decay: 7,   // per second, exponential — instant attack, eased release
    },
  },

  // ---------------------------------------------------------------------------
  // CINEMATIC CAMERA — the opt-in second camera brain (systems/cineCamera.js).
  // `enabled: false` is the shipped default and it is a real off switch: the
  // rig never ticks, the lens uniforms stay at zero, the extra blur chain is
  // never allocated work, and world.js takes the original fixed-frame path.
  //
  // Nothing in here moves the PLAYFIELD. Arena bounds come from
  // arena.viewHeight and the aspect ratio alone; this only decides which part
  // of that unchanged box is framed, and how sharp it is. That does mean the
  // rig has to sit above zoom 1 to have anywhere to pan to — at zoom 1 the
  // frustum already covers the whole arena and the clamp collapses to a point.
  //
  // `base` is the resting rig. Each entry in `states` is a SPARSE override on
  // it — anything a state doesn't name, it inherits, so a base value tuned
  // here flows to all eight states instead of needing eight edits. Keys ending
  // `Mul` scale the base; the rest replace it.
  cinecam: {
    enabled: false,

    base: {
        // The loose punch-in. Everything else is measured against this: the
        // dead zone and the lead are fractions of the frame this zoom produces.
        // Resting width. Deliberately loose — normal play wants to see the water
        // around the seal, and the states are what earn a tighter frame. The
        // cost of going wider is pan range: the clamp closes as zoom approaches
        // 1 (at exactly 1 the frustum IS the arena and there is nowhere to pan),
        // so at 1.18 the frame can travel about 7 world units off centre against
        // 12 at the old 1.35. That is the trade being made here, on purpose.
        zoom: 1.18,
        zoomMax: 3,
        zoomStiffness: 26,
        // Under 1, so every zoom move overshoots a little and settles back
        // rather than easing politely into place. This is what makes the strike
        // wind-up feel elastic in both directions — see `zoomDampMul` on the
        // charging state, and the note by the zoom spring in cineCamera.js.
        zoomDamping: 0.8,

        // Per-axis spring stiffness. Y is softer than X on purpose — the arena
        // is a tall vertical slice with a fixed water line, and a vertical
        // follow as tight as the horizontal one makes every dive feel like the
        // ocean is being winched past the seal rather than the seal descending.
        stiffness: { x: 55, y: 38 },
        // A damping RATIO, not a coefficient: 1 is critically damped at any
        // stiffness, below 1 overshoots and settles back. 0.9 is a single
        // barely-perceptible overshoot, which is what reads as "sprung" rather
        // than "slow".
        damping: 0.9,

        // Soft box, as a fraction of the HALF-frame. Inside it the camera does
        // not move at all, so small corrections and the aim-rig's constant
        // little adjustments don't drag the whole frame around with them.
        deadZone: { x: 0.1, y: 0.14 },

        // Velocity lead, in SECONDS — "frame where the seal will be this long
        // from now". Time rather than distance because it stays correct when
        // Redline and the combo speed multiplier raise the top speed.
        lookAhead: 0.18,
        lookAheadMax: 12,   // world units, so a dash can't throw the seal out of frame
        lookAheadLag: 0.35, // the lead has its own smoothing, or a direction flip snaps

        // How far the frame drifts toward the aim direction, in world units, on
        // top of the player. Shooting off to one side pulls that side into view.
        aimBias: 3.5,

        // Lens defaults. States override these; see the tilt-shift and flare
        // blocks under `lens` for the parts that aren't per-state.
        defocus: 0.55,      // 0..1, how much of the blurred buffer the edges take
        focusRadius: 0.26,  // sharp disc radius around the seal, in aspect-corrected uv
        focusFeather: 0.34, // how far the falloff takes to reach full blur
        flare: 0.35,
        vignette: 0.25,
        // The dash corridor's strength, 0..1. Zero everywhere except `charging`,
        // and blendable like anything else, so it fades in and out on the same
        // curve as the pull-in. Its GEOMETRY lives under lens.path below.
        path: 0,

        // Fallbacks for a state that names neither.
        blendIn: 0.4,
        blendOut: 0.6,
    },

      // Every one of these is a sparse override. `hold` is only meaningful on
      // the two states that expire on their own clock (roundStart, foodChain)
      // and on deathHit, where it is how long the hit beat lasts before the
      // fall takes over.
      states: {
        // Wide, calm, barely tracking — then it settles into the normal follow
        // as the blend-out runs. The rig is placed rather than sprung on the
        // first frame of a run (see cineCamera.js), so this opens where the
        // seal is instead of sailing in from the last death.
        roundStart: {
          hold: 1.6, blendIn: 0.9, blendOut: 1.4,
          zoom: 1.08, stiffMul: 0.45, zoomStiffMul: 0.45, lookAheadMul: 0.2, aimBiasMul: 0.3,
          defocus: 0.25, focusRadius: 0.4, flare: 0.7, vignette: 0.1,
        },
        // The lens leans in and the world falls away — the seal ends up the
        // only sharp thing on screen while the meter fills.
        // Held for exactly as long as the strike button is DOWN — the state
        // rides the button, not strikeState.charging, so holding through an
        // empty bar keeps the lens in (see the note in cineCamera.js).
        //
        // The elastic pull-in is `zoomDampMul` doing the work, not the blend:
        // at 0.72 x the base 0.8 the zoom spring is well under-damped, so it
        // overshoots past 1.62 on the way in and rebounds. Release hands it a
        // target that has jumped back out to the resting width and the same
        // spring throws the frame open past it before settling — the pop out is
        // the pull-in run backwards, which is why there is no separate release
        // animation anywhere.
        charging: {
          blendIn: 0.35, blendOut: 0.5,
          zoom: 1.62, zoomDampMul: 0.72,
          stiffMul: 1.5, zoomStiffMul: 1.5, lookAheadMul: 0.35, aimBiasMul: 0.4, deadZoneMul: 0.4,
          defocus: 0.95, focusRadius: 0.17, focusFeather: 0.3, flare: 0.5, vignette: 0.5,
          // The only state that lights the dash corridor.
          path: 1,
        },
        // The opposite move: snaps wide and goes SOFT, so the dash outruns the
        // frame for a beat before the spring catches up. The low stiffMul is
        // doing the work here — a dash the camera keeps up with perfectly has
        // no speed to it.
        boosting: {
          blendIn: 0.12, blendOut: 0.45,
          // zoomStiffMul is the ONE place these two deliberately disagree: the
          // frame stays soft (0.55) so the dash outruns it, while the lens snaps
          // open at 2.6. Matched to stiffMul, the release crawled wide over most
          // of a second and read as an ease rather than a spring.
          zoom: 1.18, stiffMul: 0.55, zoomStiffMul: 2.6, dampMul: 0.8, lookAheadMul: 2, aimBiasMul: 0.2,
          defocus: 0.8, focusRadius: 0.34, focusFeather: 0.2, flare: 0.9, vignette: 0.45,
        },
        // A hard, short punch. Blends in over four frames and takes most of a
        // second to let go, which is the asymmetry that makes it land as a hit.
        foodChain: {
          hold: 1.1, blendIn: 0.08, blendOut: 0.9,
          zoom: 1.62, stiffMul: 2.2, zoomStiffMul: 2.2, lookAheadMul: 0.3, aimBiasMul: 0, deadZoneMul: 0,
          defocus: 1, focusRadius: 0.2, focusFeather: 0.26, flare: 1.4, vignette: 0.55,
        },

        // --- the death, in three beats ---------------------------------------
        // Framing during a death is still deathDive.js's job — it publishes a
        // focus claim that world.js blends over whatever the rig produced, and
        // at full weight it owns the shot outright. The rig's ZOOM hands over on
        // that same ramp (see updateCamera), so these zooms and death.camera.zoom
        // do not compound: the hit lands at full strength because the handover
        // has barely started that early, and by the seabed the dive is at
        // exactly the 1.8 it is tuned for. The LENS does not hand over — these
        // states own the focus falloff, flares and vignette throughout.
        deathHit: {
          hold: 0.5, blendIn: 0.06, blendOut: 0.6,
          zoom: 1.5, stiffMul: 2.5, zoomStiffMul: 2.5, lookAheadMul: 0, aimBiasMul: 0, deadZoneMul: 0,
          defocus: 1, focusRadius: 0.14, focusFeather: 0.22, flare: 1.1, vignette: 0.7,
        },
        deathFall: {
          blendIn: 1.2, blendOut: 0.8,
          zoom: 1.15, stiffMul: 0.3, zoomStiffMul: 0.3, dampMul: 1.2, lookAheadMul: 0.6, aimBiasMul: 0,
          defocus: 0.7, focusRadius: 0.3, focusFeather: 0.4, flare: 0.3, vignette: 0.6,
        },
        deathFloor: {
          blendIn: 0.8, blendOut: 0.8,
          zoom: 1.35, stiffMul: 0.8, zoomStiffMul: 0.8, lookAheadMul: 0, aimBiasMul: 0, deadZoneMul: 0,
          defocus: 0.9, focusRadius: 0.22, focusFeather: 0.3, flare: 0.15, vignette: 0.8,
        },
    },

      // The parts of the lens that are global rather than per-state. Each has
      // its own enable so any one of the three can be A/B'd on its own without
      // losing the rig.
      lens: {
        tiltShift: {
          enabled: true,
          strength: 1,  // master scale over every state's `defocus`
          // Blur iterations on the defocus chain. Each one is two half-res
          // draws, and each roughly doubles the apparent blur radius — 2 is a
          // gentle optical falloff, 4 is unmistakably a miniature.
          radius: 2,
        },
        flare: {
          enabled: true,
          strength: 1,   // master scale over every state's `flare`
          // Ghosts are sampled from the bloom buffer along the line through the
          // centre of frame, so anything bright throws them with no authoring.
          ghosts: 3,
          spacing: 0.32,
          halo: 0.42,
          // The anamorphic smear. Small numbers: this is a uv step per tap and
          // nine taps wide, so 0.006 already reaches 5% of the screen.
          streak: 0.006,
          streakGain: 0.5,
        },
        // THE DASH CORRIDOR. A second focus claim laid along the line the strike
        // will travel, live only while one is being wound up.
        //
        // It is a union with the radial focus, not a replacement: the seal keeps
        // its own sharp disc and this carves a sharp LANE out ahead of it, so
        // the shot reads as "here, and that way" rather than the sharp region
        // sliding off the player. The vignette is the other half — darkening
        // everything outside the lane is what turns a sharp streak into a
        // highlighted path.
        //
        // Distances are in aspect-corrected uv, where 1.0 is the height of the
        // frame, so they mean the same thing at any window shape.
        path: {
          enabled: true,
          width: 0.1,        // half-width of the sharp lane
          feather: 0.18,     // falloff either side of it
          length: 0.3,       // reach at zero charge
          lengthPerPower: 0.35, // ...and how much further a full meter throws it
          vignette: 0.45,    // darkening OUTSIDE the lane, added to the state's own
        },

        droplets: {
          enabled: true,
          perBreach: 1,   // how wet one surface crossing leaves the glass
          life: 3.2,      // seconds to dry, linear — drops evaporate, they don't decay
          density: 9,     // cells across the frame; higher = more, smaller drops
          size: 0.34,     // drop radius as a fraction of its cell
          refract: 0.05,  // how far a drop bends what's behind it, in uv
          spec: 0.5,      // the highlight on the bead
          // How far a drop RUNS before it dries, in cell heights, accelerating
          // the whole way. Above 1 it leaves its own cell, which the shader
          // handles by evaluating the cell overhead as well.
          //
          // That one extra lookup is also the ceiling. The fastest drops carry a
          // 1.3x personal multiplier, so this reaches ~1.5 cells of travel, and
          // a drop that outran the neighbour lookup would blink out in mid-fall
          // instead of drying. It gets away with even that much only because a
          // drop at full travel is also at the end of its drain and is a sliver
          // by the time it arrives — which is why the slider stops at 1.6 rather
          // than somewhere rounder.
          slide: 1.15,
          // Vertical elongation at full speed. This is the difference between
          // water running down glass and a circle sliding down glass.
          stretch: 1.7,
          // How far the trailing half is pinched into a tail, 0..1. The leading
          // edge always stays full width — a drop is a teardrop point-up.
          taper: 0.55,
        },
    },
    },

    lighting: {
      ambient: 0.85,
      keyIntensity: 1.25,
      keyPosition: [4, 8, 14],
      hemiIntensity: 0.4,
    },

    colors: {
      sky: 0x0a1626,
      // Three-stop depth gradient — shallow near the surface, mid, and deep.
      // zoneStops are fractions of the water column (0 = surface, 1 = bottom)
      // marking where shallow->mid and mid->deep are fully blended.
      waterShallow: 0x145e82,
      waterMid: 0x0a2b45,
      waterDeep: 0x030c16,
      zoneStops: [0.32, 0.72],
      surface: 0x6fd3ff,
      depthLine: 0x123049,
      seabed: 0x0a1a24,
    },

    // ---------------------------------------------------------------------------
    // DAY / NIGHT — one clock (systems/daylight.js) that every other sky system
    // reads. It publishes a single "light bus": how bright the world is right
    // now, what colour that light is, and where in the sky it's coming from. The
    // sky gradient, the sun and moon, the caustics and the light beams all hang
    // off that one object rather than each deriving their own idea of the time,
    // so nothing can drift out of step with anything else.
    //
    // The clock runs on REAL seconds scaled by `scale`: at 60 one real second is
    // one in-game minute, so a full day takes 24 minutes.
    // ---------------------------------------------------------------------------
    dayNight: {
      enabled: true,
      // Open the game at the player's OWN time of day, read off the device
      // clock, and then let the cycle run at `scale` from there. Someone
      // playing at dusk starts at dusk; someone playing at 2am starts in the
      // dark with the lanternfish already out (CONFIG.spawn.nightlife).
      //
      // Only the STARTING point comes from the system clock. The day does not
      // track real time after that — a 24-minute day chasing a 24-hour one
      // would freeze the sky, and the whole cycle is built to be seen inside
      // one run.
      //
      // Local time, deliberately: this is the sun outside the player's window,
      // not a timestamp, so a timezone is exactly what it should be read in.
      startFromSystemClock: true,
      // Where a fresh save opens when the line above is off — morning. Also
      // the fallback if the device clock is unreadable.
      startHour: 7.5,
      scale: 60, // in-game seconds per real second. 60 = 1 real sec is 1 minute
      // A plain multiplier over `scale`, so the baseline above keeps meaning
      // what it says (1 real second = 1 in-game minute) and this is the dial
      // you actually turn. Everything measured in real seconds of ordinary
      // passage rides it — the clock itself AND the per-chum nudge below — so
      // turning it up moves the whole day forward together rather than
      // changing what a mouthful of chum is worth relative to a sunset.
      //
      // At 2 with scale 60: 120 in-game seconds per real second, a full day
      // every 12 real minutes.
      rate: 2,
      // Every chum orb swallowed nudges the clock on. In REAL seconds of
      // ordinary passage, not in-game minutes, so it stays proportional to
      // `scale` instead of quietly changing meaning when the clock is retuned:
      // at 60x, 0.35 here buys 21 in-game seconds a mouthful.
      //
      // Sized to be felt over a run and invisible per orb. A busy 12-minute run
      // eats a couple of hundred orbs, which is about +1.2 in-game hours on the
      // 12 that run covers anyway — call it 10% further through the day, with
      // no single swallow ever visibly jumping the sun. Turn it up if you want
      // hunting to drive the cycle rather than just lean on it.
      chumSeconds: 0.35,
      // A new run picks the clock up where the last one left it, so the first
      // run of a session is the one that opens at the starting hour and later
      // runs inherit whatever time you died at. Flip this on to re-read the
      // starting hour every run instead — which with `startFromSystemClock`
      // means every run opens at the real time of day, however long the
      // session has been going.
      restartAtMorning: false,
      // Tuning aids, not gameplay: freeze the clock and scrub it by hand so a
      // sunset can be looked at for longer than the fifteen seconds it lasts.
      paused: false,
      scrubHour: 7.5,

      // The sky, as keyframes through the day. Two colours (the band at the
      // water line, and the top of the frame) plus `light`, which is the master
      // brightness the caustics, beams and lighting rig all ride. Whichever two
      // entries bracket the current hour are interpolated, wrapping past
      // midnight — so the list only needs the moments where the sky CHANGES
      // character, not one entry per hour.
      sky: [
        { hour: 0,    zenith: 0x03070f, horizon: 0x081627, light: 0.10 },
        { hour: 5,    zenith: 0x101f3a, horizon: 0x53406b, light: 0.24 },
        { hour: 6.5,  zenith: 0x2d6396, horizon: 0xff9d63, light: 0.55 },
        { hour: 9,    zenith: 0x3f8ac9, horizon: 0xb6dff5, light: 0.90 },
        { hour: 12,   zenith: 0x4b9fe0, horizon: 0xd6efff, light: 1.00 },
        { hour: 17,   zenith: 0x4285bb, horizon: 0xf2c493, light: 0.82 },
        { hour: 19,   zenith: 0x1f3a59, horizon: 0xff7440, light: 0.42 },
        { hour: 20.5, zenith: 0x0a1730, horizon: 0x35284a, light: 0.18 },
        { hour: 22,   zenith: 0x03070f, horizon: 0x081627, light: 0.10 },
      ],
      // How the gradient is distributed. >1 pushes the horizon colour further up
      // the frame, which is what a real sky does — the interesting band is thin.
      skyCurve: 1.35,
      // How far off the horizon the sun still counts as "rising" or "setting",
      // as a fraction of the arc (elevation is -1..1). Sets the width of
      // skyLight.twilight, the bus value the horizon glow softens against —
      // 0.3 is roughly the hour either side of the crossing.
      twilightBand: 0.3,

      // Stars. Fade in with the night factor (see daylight.js) and out again at
      // dawn; density is cells per world unit, so a smaller number is sparser.
      stars: { enabled: true, intensity: 0.55, density: 0.55, twinkle: 0.7 },

      // The shared ellipse. Sun and moon sit on polar opposite points of it, so
      // exactly one of them is above the water line at any moment. Radii are
      // FRACTIONS — of half the arena width, and of the air band's height — so
      // the arc reframes itself on resize instead of needing world units that
      // only look right at one aspect ratio.
      orbit: {
        radiusX: 0.72,
        radiusY: 0.74,
        centerY: 0, // world units above the water line; 0 = rise/set on it
        riseHour: 6, // sun crosses the horizon going up; it sets 12h later

        // DRIFT — how far a body slides across the FRAME per unit of camera
        // motion. 1 pins the bodies to the world (they pass exactly like a rock
        // on the seabed), 0 welds them to the screen. 0.04 is the sky of
        // something genuinely far away: swimming the whole width of the ocean
        // moves the sun under two units on a ninety-unit frame — present, but
        // never enough to read as an object hanging a few metres back.
        //
        // Done as an explicit x offset, NOT by moving it back in z. The camera
        // is orthographic — there is no perspective divide, so depth alone buys
        // exactly nothing. `depth` below is still worth setting (it's the sort
        // order against the sky plane at -6 and the cloud overlay at -5.2) but
        // it does not, on its own, move anything.
        //
        // IT REPLACED `parallax`, which meant the identical thing and sat at
        // 0.15. Renaming it is the only way a new default can actually arrive:
        // `parallax` is in every saved imported-tuning.json, saved tuning beats
        // config.js in the merge, and a re-defaulted 0.04 would have reached
        // nobody who has ever opened the tuner. celestial.js still falls back
        // to the old key if this one is missing.
        drift: 0.04,
        depth: -5.8,

        // --- keeping a body in the shot ----------------------------------------
        // The orbit is measured off the FRAME (see place() in daylight.js), so
        // at the default radii a body cannot leave it. These are what hold that
        // true anyway once the shot stops being the default one: the cinematic
        // rig and the punch both zoom in, which crops the frame around a sun
        // that has no idea it happened.
        //
        // 0 switches the fit off; 1 fits as hard as it honestly can. It is not
        // a promise the sun is always on screen and cannot be — dive deep
        // enough and the whole sky is out of frame, water line included. See
        // fitToFrame in systems/celestial.js for the bound, which is the
        // horizon: a body may only be lowered while the water line has already
        // left the top of the shot, because that is the only time nobody can
        // tell it moved.
        keepInFrame: 1,
        // How much clearance the fit keeps, in DISC RADII. 1 is the disc's edge
        // exactly on the frame's; above it keeps a margin of the halo in shot
        // as well, which is what stops a "fitted" sun from still looking cut.
        framePad: 1.25,
    },

      // Both bodies take the same shape of definition, so anything written
      // against one works on the other.
      //
      // `texture` and `model` are the replacement hooks: leave both null for the
      // built-in placeholder disc, set `texture` to a .webp/.png path under
      // public/ for flat art, or `model` to a .glb. A model is auto-scaled so
      // its largest dimension matches `size` — deliberately, so swapping art in
      // can't drop a sun of some unrelated size into the sky (assets carry their
      // own scale, and hand-matching it is a trap).
      //
      // The DISC is cut off by the horizon rather than dissolving through it —
      // by the water fill itself, which is opaque and clips to the wave, so the
      // cut rides the swell. The HALO is the other way round: it fades out over
      // `haloFade` as it comes down to the water, because a wide additive glow
      // that simply stops leaves a hard edge wherever it stops. See the note at
      // the top of systems/celestial.js.
      sun: {
        size: 5.2, // world units across the disc
        color: 0xfff0c8,
        brightness: 1.25, // >1 pushes past the bloom threshold and blooms
        halo: 3.4, // glow diameter, as a multiple of `size`
        haloStrength: 0.55,
        // The same bloom floor the moon has, and see the long note on it there.
        // It was MISSING here while the tuner shipped a slider for it and
        // celestial.js read it — so the sun's corona floor lived only in
        // imported-tuning.json, and a fresh clone got `?? 0` (no floor at all).
        // Declared at the value the saved snapshot holds, so the sky a new
        // checkout renders is the sky this one does. Found by pruneUnknownKeys:
        // an undeclared key that a slider points at is the one shape of
        // "unknown" that is a missing default rather than a dead value.
        bloomRim: 2,
        // Extra glow while the disc is touching the horizon — the moment the
        // sun is half in the water is the one that should flare.
        horizonGlow: 1.7,
        horizonRange: 1.6, // how far (in disc radii) off the line still counts
        // World units the halo takes to come up to full strength above the
        // water line. This is the anti-seam control: the glow is worth around
        // 0.9 in linear at the crossing, and however correct the place you stop
        // it, stopping it in one pixel is a hard horizontal edge across a fifth
        // of the frame. Sized against CONFIG.horizonGlow.up (the fog band's own
        // reach) so the two read as one piece of haze rather than as a glow
        // sitting in front of a bank. 0 is the hard cut this replaced.
        haloFade: 4.5,
        texture: null,
        model: null,
        // Fold the disc's circular edge into the art's alpha. On by default
        // because a body painted on an opaque background is otherwise a square
        // in the sky — the single most likely thing to be wrong with a dropped
        // -in .webp. Turn it off for art that spills past its own circle
        // (a corona, a ring, a crescent with a glow).
        maskToDisc: true,
        edgeFeather: 0.06, // width of that alpha edge, in disc radii
    },
      moon: {
        size: 3.4,
        color: 0xcfe2ff,
        // Above 1, like the sun, and for a reason the sun does not have: the
        // painted moon is DARK. Its mid grey is around 0.45 in sRGB, which the
        // loader decodes to roughly 0.17 linear before this multiplies it, so
        // the 0.85 it used to sit at put the whole disc under the bloom
        // threshold and the moon was a flat grey sticker. At 1.5 the lighter
        // wisps and the rim clear the bright pass while the dark maria stay
        // under it — which is what makes it read as a lit body with structure
        // rather than as a white blob. See the note on luminance below.
        brightness: 1.5,
        // The glow itself. The README in public/textures/sky/ says it and it
        // is worth repeating: paint the art as the OBJECT, and let the halo do
        // the emitting. Cranking `brightness` far enough to glow on its own
        // just flattens the craters.
        halo: 3.8, // glow diameter, as a multiple of `size`
        // Was 0.35, which put the halo an order of magnitude under the bright
        // pass everywhere outside the disc it was hidden behind — a glow that
        // technically existed and never bloomed. At 1.2 the corona clears the
        // threshold from the disc edge out to about half the halo's radius.
        //
        // WHY THE NUMBER IS WHAT IT IS. post.js thresholds Rec.709 LUMINANCE,
        // and this pale blue is 0.75 of it; the halo's own falloff is 0.32 at
        // the disc edge. 0.75 x 0.32 x 1.2 = 0.29, comfortably over. Changing
        // `color` toward a deeper blue drops that fast — blue is 7% of
        // luminance — so a colder moon needs this raised with it.
        haloStrength: 1.2,
        // ...and the guarantee that it actually blooms whatever the above says.
        // The rig SOLVES for the halo strength that puts the corona's rim this
        // far past CONFIG.bloom.threshold, and takes whichever is higher — so
        // the slider still works, but it can no longer be left somewhere the
        // glow silently does nothing. 1.0 sits exactly on the threshold.
        //
        // This is what makes the moon glow on a machine that already has a
        // tuning snapshot: `haloStrength` is persisted, so a new default up
        // there would never have arrived. See haloStrengthFor in
        // systems/celestial.js.
        bloomRim: 1.6,
        horizonGlow: 1.5,
        horizonRange: 1.6,
        // Shorter than the sun's, in proportion to the smaller, dimmer halo it
        // has to dissolve — see `haloFade` on the sun.
        haloFade: 3.2,
        // Painted moon. If the file isn't there the rig warns once and falls
        // back to the placeholder disc, so this path is safe to keep set.
        texture: '/textures/sky/moon.webp',
        model: null,
        maskToDisc: true,
        // Wider than the sun's default: the art is a hand-painted blob whose
        // edge is slightly irregular and doesn't quite reach the frame, so a
        // tight mask leaves a bright rim of background between the paint and
        // the cut. Raise it further if a white ring shows at moonrise; drop it
        // to 0.06 if the source ever gets a proper alpha channel.
        edgeFeather: 0.12,
    },

      // -----------------------------------------------------------------------
      // GOING THROUGH IT (systems/celestialPass.js).
      //
      // There is a TRIGGER ZONE inside each body, and a seal that breaches hard
      // enough to fly through it sets the thing off. That is reachable at any
      // hour and it is not easy: the sun sits about 7.7 units above the water
      // at noon and a straight-up dash reaches 28, so getting there is a matter
      // of aiming a jump rather than of waiting for the sky to come down. At
      // sunrise and sunset the same body is skimming the water line, which is
      // the other, cheaper way in — and the one that reads as luck.
      //
      // WHY IT IS SHAPED THE WAY IT IS. The sun and the moon are the only two
      // things in this game that are always there and have never done anything.
      // Everything about the pass is built to keep it that way round: it costs
      // a jump rather than a resource, it cannot be farmed (`cooldown`), and
      // what it pays out is TIMING — a refilled strike meter you didn't have to
      // earn, a night the element gets to be awake in — rather than a number.
      //
      // WHERE THE ZONE IS. Inside the DRAWN body, not the orbit's: the drift
      // and the frame fit both move a body a little (see systems/celestial.js),
      // and a trigger sitting at the arithmetic position rather than the
      // painted one is a hitbox that misses the thing you can see.
      pass: {
        enabled: true,
        // The zone, as a fraction of the disc's radius. Under 1 on purpose —
        // the seal has to be properly inside the light, not clipping the rim,
        // and a zone that reached the edge would fire on a graze that looks
        // from the outside like a near miss.
        radius: 0.7,
        // How far back out the seal has to get before the zone re-arms, in
        // trigger radii. A seal hanging at the apex of a jump inside the sun
        // would otherwise re-fire on every frame the distance jittered across
        // the boundary.
        hysteresis: 1.35,
        // ...and the real rate limit. Long enough that a pass is an event
        // rather than a rotation: a second one costs another whole jump, and
        // by then the sky has moved.
        cooldown: 6,
        // How big the event reads, from how fast the seal was going through it.
        // A dash straight through the middle is worth well over a drifting
        // clip, which is the difference between a stunt and an accident.
        speedScale: { base: 0.75, per: 34, max: 1.6 },

        // --- the shine ---------------------------------------------------------
        // What the body itself does about it. Runs on REAL time, so a hit-stop
        // doesn't hold the flicker still, and it decays from wherever a second
        // pass tops it up to.
        flare: {
          max: 3,        // ceiling on banked shine, so two passes can't blow out
          decay: 0.55,   // seconds to fall to 1/e of it
          flicker: 0.45, // depth of the wobble, 0 = a clean fade
          flickerRate: 17, // radians/sec of the fast lobe; a slower one beats against it
          // How much the corona takes — this is the visible half, and the one
          // number to pull if a pass reads as a white-out rather than a flash.
          // At 1.25 a flat-out pass peaks the halo around four times its
          // resting strength, which through the bright pass is a burst of
          // bloom rather than a filled frame.
          haloGain: 1.25,
          discGain: 0.35,// and the body, deliberately far less: see systems/celestial.js
          swell: 0.18,   // how much the halo grows with it
        },

        // --- the sun -----------------------------------------------------------
        // A FLARE. It goes off where the seal is, which is up in the air where
        // the gulls and the boats are, and it hands back the strike meter.
        sun: {
          flare: 1.35, // what it does to the body's own glow, before speed
          // The blast. `damage` rides abilityDamageMul and `radius` rides
          // Splash Zone exactly like every other blast in the game, which is
          // the synergy: the cards that widen your explosions widen this too,
          // without it having to know they exist.
          blast: { damage: 30, radius: 12 },
          // Fraction of the strike charge meter given straight back. The sun is
          // the one thing in the sky that can hand you a full-power strike for
          // a jump, and landing out of one with the meter full is the whole
          // feeling this is for.
          charge: 0.6,
          // FOOD CHAIN links, and the third synergy: gated on Big Willy Style
          // (breachChain), because you had to breach to get up here and that is
          // precisely the card that says a breach is worth something.
          chainPerBreachLevel: 1,
        },

        // --- the moon ----------------------------------------------------------
        // No blast. The moon's payout is that it makes the NIGHT happen early:
        // the seal comes out of it lit, and for a few seconds its
        // bioluminescence runs at full dark-hour power whatever the clock says.
        moon: {
          flare: 1.15,
          // Seconds of full element power — the Glow Up! synergy. Worth
          // nothing at all in a run that never took the card, which is the
          // point of a synergy: it is a reason to have it, not a consolation
          // for not having it.
          surge: 7,
          // The tide. Chum inside this radius of the seal is pulled in on the
          // spot — scaled by Attractor's gulp radius like the strike release's
          // own gulp is, so the card that widens your mouth widens this.
          gulp: 26,
          chainPerBreachLevel: 1,
        },
    },
    },

    // -------------------------------------------------------------------------
    // THE NIGHT SKY (systems/constellations.js) — the backdrop grid's opposite
    // number, in the air instead of the water, and only after dark.
    //
    // The lattice is the star field itself. dayNight.stars above is a shader
    // painting a dot per cell; this promotes the BRIGHTEST of exactly those
    // cells to real geometry, strings nearest-neighbour links between them, and
    // grows a fractal branch out of the brightest of all. Both layers read the
    // same placement rule (systems/starField.js), so the lines are always
    // between stars that are actually up there — and `star density` in the Sky
    // panel is the one control that moves both.
    //
    // Two things then happen to it. It BLOOMS on the beat: every star carries a
    // phase quantised onto a beat slot, so the field lights in waves that land
    // on the music, and the light travels out along the links and one
    // generation per step through the fractal. And it SPRINGS: world.js tees
    // every backdrop ripple into it, so the same kills and explosions that
    // punch the grid ring the constellations overhead.
    // -------------------------------------------------------------------------
    constellations: {
      enabled: true,
      // Fraction of the sky's own stars promoted to geometry. Not a count: the
      // field is whatever `dayNight.stars.density` makes it, and this says how
      // much of it is worth drawing properly. Past ~0.6 the sky reads as a mesh
      // rather than as constellations.
      brightest: 0.45,
      margin: 4, // world units of field built past the frame, so a warped line
                 // never drags its end into view
      depth: -5.7, // in front of the sky plane (-6), behind the moon (-5.5)
      haze: 3.2, // world units above the wave that a star fades in over

      // --- when it is there ---------------------------------------------------
      // Both on the same 0..1 darkness the stars and the nocturnal spawns ride
      // (skyLight.night), so scrubbing the clock under Day & night and dragging
      // these two is how you find the moment the sky should come alive. With
      // the day/night cycle switched off, `night` is a flat 0 and this system
      // never appears at all — there is no second switch to forget.
      dusk: 0.12,
      dark: 0.55,

      // --- the stars ----------------------------------------------------------
      size: 0.34, // world units, half-width of the biggest star's quad
      color: 0xbcd8ff,
      hotColor: 0xfff2cc, // what a star mixes to at the peak of its bloom
      opacity: 0.95,
      core: 1.7, // falloff power of the hot centre; higher = tighter
      halo: 0.45, // and of the soft lobe around it; lower = wider
      haloAmount: 0.4,
      spike: 0.8, // the four-point diffraction flare
      spikeWidth: 5.5, // higher = thinner arms

      // --- the connections ----------------------------------------------------
      links: 2, // nearest neighbours each star reaches for AT REST
      linkRadius: 11, // and how far it will reach, in world units, at rest
      linkColor: 0x2f5f96,
      linkOpacity: 0.45,
      subdivisions: 4, // segments per link; higher = curvier under a ripple

      // --- the food chain -----------------------------------------------------
      // THE SKY ANSWERS THE FOOD CHAIN. Every link of a chain (see onChainHit
      // in main.js — a dash landing, an orb taken, a breach) reaches the
      // constellations further across the sky and lets each star hold more
      // neighbours, so a long combo visibly wires the night together and a
      // lapsed one lets it fall dark again.
      //
      // Nothing is rebuilt for this. The geometry is made once, at the reach
      // the DEEPEST chain would ask for, and the extra links sit dark until the
      // two numbers below let them in — a combo costs one uniform write, not an
      // allocation and a buffer upload in the middle of a fight.
      //
      // The two gates are two different claims, and both are needed. `reach` is
      // how far a star can see, which is what strings the long links across
      // empty sky; `links` is how many it will hold, which is what lights up a
      // dense cluster — where the eye already is, and where a wider radius on
      // its own would change nothing.
      chain: {
        enabled: true,
        // Per link of chain. At 0.22 a five-deep chain is reaching 2.1x as far
        // as a resting sky, and at maxLevel it is 2.8x.
        reach: 0.22,
        // Extra neighbours per star per link of chain — fractional, so they
        // fade up as the chain climbs instead of snapping in on whole numbers.
        // 2 at rest, 6 at the top.
        links: 0.5,
        maxLevel: 8, // reach and count stop growing here; the build is sized on it
        fade: 2.5, // world units a link fades in over as the reach passes it
        // Extra brightness on the links already lit, at maxLevel. A deep chain
        // shouldn't only add faint new lines at the edge of the frame — it
        // should burn what is already there a little hotter.
        glow: 0.4,
        // Asymmetric on purpose: the sky opens faster than it closes, because
        // the opening is the reward and the closing is only its absence.
        attack: 6, // per-second rate the reach grows at
        release: 1.8, // ...and falls back at once the chain window lapses
      },

      // --- the fractal --------------------------------------------------------
      // A branch grown out of the brightest stars: `branches` children fanned
      // across `spread` radians, each `shrink` of its parent, `depth` deep. The
      // tips are stars in their own right, so they bloom and spring with the
      // rest of the field rather than being decoration hung off it.
      fractal: {
        enabled: true,
        anchors: 0.3, // fraction of the promoted stars that grow one
        depth: 3,
        branches: 2,
        length: 3.2, // world units of the first limb
        shrink: 0.62, // each generation, as a fraction of its parent
        spread: 1.15, // radians the fan covers
        wobble: 0.45, // radians of per-branch scatter, so no two trees match
        tipScale: 0.55, // how much smaller each generation's stars are
      },
      // Its own colour, so the two families of line read as different kinds of
      // thing rather than as one messy web.
      fractalColor: 0x6f4fb0,

      // --- the bloom ----------------------------------------------------------
      // One bloom per division, per star. The phase steps are what make it a
      // FIELD blooming rather than a field flashing: at '1 bar' with 4 steps
      // the sky lights on the four beats of the bar, in whichever order the
      // stars happened to be seeded in.
      bloomSync: '1 bar',
      bloomRate: 0.5, // cycles/sec, and only used at 'free'
      phaseSteps: 4,
      phaseSpread: 1,
      bloomDecay: 5, // how fast a bloom falls away. Higher = a sharper flash
      base: 0.3, // brightness between blooms — starlight, with nothing on it
      gain: 1, // and how much the bloom adds on top
      swell: 0.85, // how much bigger a star gets at its peak
      // Both in CYCLES, and both defaulted to a sixteenth of the bloom's own
      // division so the crawl is itself on the grid rather than being one more
      // rate picked by eye.
      genDelay: 0.0625, // a fractal generation's lag behind its parent
      travel: 0.05, // how long light takes to cross one link

      // --- what the game does to it -------------------------------------------
      // Every ripple the backdrop grid gets, this gets too (see world.js), at
      // these scales. `squash` is the one that matters: the gameplay is under
      // the water and the sky is above it, so the falloff measures the vertical
      // distance at a quarter weight and a blast far below arrives overhead as
      // a broad sideways swell instead of not arriving at all.
      rippleGain: 0.35,
      rippleReach: 2.2, // multiplies the radius the event asked for
      rippleSquash: 0.25,
      rippleDecay: 1.9, // higher = snaps back faster
      rippleFreq: 5.5,
      rippleWavelength: 0.8,
      warpGain: 1.6, // how bright a warped link gets
      // How far a link is allowed to bow. THE STARS NEVER MOVE — they are
      // fixed points, and a link's displacement is masked to zero at both ends
      // so it stays welded to the two stars it joins and does all its moving in
      // between them. This is the amount of that middle, and it is the only
      // thing in the night sky that travels: at 0 the constellations are rigid
      // and the ripples show as brightness alone.
      bend: 1,
      // ...and a cap on it, as a fraction of the link's OWN length. The ripple
      // answers in world units, which suits a lattice of equal spans and does
      // not suit this: the fractal's deepest twigs are under a unit long, and a
      // shove that bows a long constellation line nicely throws one of those
      // most of its own length and reads as noise. 0.3 lets every string swing
      // by up to a third of itself, so a twig sways and a long line still
      // carries the whole ripple.
      bendMax: 0.3,

      // The fingers, on the same terms as grid.touchGlow but without the
      // per-finger palette or the charge meter — up here it is one sky, and a
      // hand on the glass pulls the constellations out of shape.
      touch: {
        enabled: true,
        radius: 9,
        push: 0.35,
        swirl: 0.3,
        wave: 0.9,
        spin: 1.8,
        attack: 14,
        release: 4,
      },
    },

    caustics: {
      enabled: true,
      intensity: 0.4, // brightness of the light veins
      scale: 0.16, // world units per pattern cycle — smaller = finer veins
      speed: 0.55,
      falloff: 1.6, // how fast caustics fade with depth (higher = shallower-only)
      color: 0xbfefff,
      // Caustics are sunlight refracted through the surface, so they have no
      // business being at full strength at midnight. With this on, `intensity`
      // becomes the NOON value and the day/night light bus scales it down from
      // there — `nightFloor` is what's left under a full moon, and `tintMix` is
      // how much of the light's own colour (warm at dawn, cold at night) is
      // blended into `color`.
      followSun: true,
      nightFloor: 0.22,
      tintMix: 0.55,
    },

    godrays: {
      enabled: true,
      count: 5, // max 8 — the shader loop is capped there
      spread: 30, // world-unit half-width the beam anchors are scattered across
      angle: 0.5, // world units of horizontal drift from surface to seabed
      sway: 0.12, // how much beams sway side to side over time
      speed: 0.18,
      beamWidth: 2.4,
      intensity: 0.22,
      falloff: 1.2, // how fast beams fade with depth
      color: 0xdff6ff,
      // Same coupling as the caustics, plus the geometry: beams lean AWAY from
      // wherever the light is (a low sun on the left throws light down and to
      // the right) and the whole bundle slides under it. Both are driven by the
      // body's horizontal position as a fraction of half the arena, which is
      // zero at the top of the arc and ±1 at the horizon — so the lean is
      // strongest at sunrise and sunset and vanishes at noon, for free.
      followSun: true,
      nightFloor: 0.16,
      tintMix: 0.55,
      followTilt: 1.6, // extra `angle` at the extremes of the arc
      followShift: 0.45, // fraction of the light's x the anchors slide by
    },

    // ---------------------------------------------------------------------------
    // HORIZON GLOW — a soft band of light along the water line
    // (systems/horizon.js). The seam between the sky and the water fill is the
    // hardest edge in the frame, and this is what stops it reading as the place
    // two rectangles happen to stop.
    //
    // Everything with `twilight` in the name is the second half of the job: at
    // sunrise and sunset the sky and the sea are further apart in tone than at
    // any other time, so the band widens, brightens, and takes the sky's own
    // colour until the seam effectively dissolves. It rides skyLight.twilight,
    // which peaks exactly as the sun crosses the line and eases off both sides.
    // ---------------------------------------------------------------------------
    horizonGlow: {
      enabled: true,
      color: 0x6fd3ff, // the base tint, before any of the sky is mixed in

      // The two halves of what fog does, split so they can be dialled
      // independently. `opacity` is how much of the background it HIDES;
      // `light` is how much it EMITS. Equal values are exactly fog —
      // mix(background, colour, density). `light` above `opacity` makes it glow
      // as well, and because the background is attenuated in step it still
      // cannot blow out to white the way an additive band does.
      //
      // Kept CLOSE together, though. `light` far above `opacity` leaves the
      // bank visibly paler than the sky it hangs in front of, and a pale band
      // on an orange sky has a top edge of its own — a second seam, higher up,
      // which is the opposite of the job. A little over is a glow; a lot over
      // is a stripe.
      opacity: 0.5,
      light: 0.62,

      up: 4.2, // world units the bank reaches into the air...
      down: 2.4, // ...and down into the water. Light scatters up more.
      // Gaussian sharpness. Lower is softer and wider-shouldered; there is no
      // hard shoulder anywhere in the curve at any value, which is the point of
      // a gaussian over a pow() ramp.
      falloff: 1.9,

      // What stops it reading as a rectangle. The noise perturbs the HEIGHT of
      // the bank along the water, so its top is ragged and drifting, rather
      // than merely dirtying an even band.
      noise: 0.75, // 0 = a perfectly even band, 1 = fully broken up
      noiseScale: 0.055, // cells per world unit — smaller is bigger, softer banks
      noiseStretch: 5, // how much longer than tall the wisps are
      drift: 0.02, // how fast it crawls on its own
      windDrift: 0.06, // ...and how much the weather's wind pushes it along

      // Anti-banding. A wide shallow gradient over a fifth of the screen is the
      // textbook case for 8-bit contouring, and the composite is LDR with no
      // tonemapping to hide it. Roughly one quantisation step of per-pixel
      // noise: enough to break the contours, far too little to see as grain.
      dither: 0.014,
      // The same treatment for the SKY gradient behind it, which has exactly
      // the same problem for exactly the same reason — a wide two-stop ramp
      // in an 8-bit composite. Lives here rather than under dayNight because
      // it is the same fix for the same artefact and wants tuning alongside.
      skyDither: 0.005,

      // At full twilight: the reach multiplies by 1 + this...
      twilightSpread: 2.2,
      // ...the opacity and the emission both by 1 + this...
      twilightBoost: 0.8,
      // ...and the colour goes this far toward the sky's own horizon band,
      // versus `skyTint` the rest of the time. Pulling it nearly all the way is
      // what makes the fog BE the sunset rather than a blue bank in front of
      // one.
      skyTint: 0.4,
      twilightTint: 0.9,

      // The drawn water line itself (colors.surface). `lineGain` pushes it past
      // 1 so the bloom bright-pass gives the stroke a halo instead of leaving it
      // a flat 1px rule; `lineOpacity` is the global dial for how present that
      // stroke should be at all — take it toward 0 and the water line is
      // carried entirely by the fog, with no hard edge anywhere.
      lineGain: 1.35,
      lineOpacity: 0.75,
      // ...and this dissolves the stroke further as twilight comes in. The hard
      // line is exactly what wants softening at sunset, so it hands the seam
      // over to the fog and takes it back afterwards.
      lineTwilightFade: 0.6,
    },

    // ---------------------------------------------------------------------------
    // WEATHER — occasional rainstorms, and nothing else yet. The state machine
    // (systems/weather.js) publishes an intensity and a wind, and every visual
    // reads those two numbers: the rain, the cloud overlay, and the dimming the
    // day/night light bus applies during a storm. Adding a weather TYPE later
    // means adding a state to that machine and something that reads it — not
    // touching any of the three consumers.
    //
    // All of these are REAL seconds. Weather keeps running on menus and through
    // a death, because a storm that pauses with the game reads as a bug.
    // ---------------------------------------------------------------------------
    weather: {
      enabled: true,
      // -1 = run the schedule. Anything 0..1 pins the intensity there and holds
      // it, which is the only sane way to tune rain that otherwise shows up
      // twice in ten minutes.
      forceIntensity: -1,

      firstDelay: [45, 150], // [min, max] before the first storm of a run
      // Clear spell between storms. Wide, and deliberately: with the durations
      // below this rains about 15% of the time, which is what "occasional"
      // measures out to. Halve it and it's raining a quarter of every run.
      gap: [150, 420],
      duration: [30, 75], // how long a storm lasts, ramps included
      peak: [0.45, 1], // how hard a given storm rains at its height
      rampIn: 8, // seconds to reach peak
      rampOut: 12, // seconds to fall back to clear
      dim: 0.45, // how much of the sky's brightness a full storm takes away

      // Wind is one signed number, -1 (hard left) to +1 (hard right). Two slow
      // sines beating against each other give gusts that never repeat on any
      // interval you can hear; `turbulence` is derived from how hard it's
      // gusting and is what the rain jitters against.
      wind: {
        base: 0.15, // prevailing direction, before gusts
        gust: 0.85, // gust amplitude
        speed: [0.11, 0.29], // the two beat frequencies, Hz
        calmGust: 0.35, // fraction of the gust that blows outside a storm
    },

      // SEA STATE — how the weather moves the water itself. The wave in
      // arena.js has a calm baseline (arena.waveAmplitude) and this is what a
      // storm does to it: taller, faster, and with a third shorter term mixed
      // in that only exists in heavy weather — which is what turns a swell
      // into chop rather than just a bigger version of the same smooth roll.
      //
      // It rides `weatherState.swell`, NOT the rain intensity, and the two are
      // deliberately different numbers: water has mass. The sea takes tens of
      // seconds to get up and minutes to lie back down, so the roughest water
      // of a storm arrives after the heaviest rain and outlasts it. That lag
      // is most of what sells it.
      //
      // Cosmetic in the strict sense: breaching, oxygen and every clamp read
      // the FLAT water line at bounds.surfaceY, so none of this changes where
      // the seal can go or how a run plays. It changes what the sea looks
      // like it is doing.
      sea: {
        enabled: true,
        amp: 2.6, // amplitude multiplier at full storm
        chop: 1, // how much of the short, fast storm term is mixed in, 0..1
        speed: 1.7, // wave speed multiplier at full storm
        buildTime: 25, // seconds for a flat calm to reach a full sea...
        settleTime: 80, // ...and much longer to lie back down again
      },

      rain: {
        enabled: true,
        maxDrops: 1200, // pool size; the ring buffer never grows past this
        perSecond: 900, // spawn rate at full intensity
        speed: [30, 46], // fall speed, world units/sec
        length: [0.8, 1.9], // streak length, scaled by speed
        drift: 26, // world units/sec of sideways push at wind = 1
        turbulence: 6, // extra per-drop wobble at full turbulence
        color: 0xc6e2f5,
        opacity: 0.45,
        splash: true,
        splashChance: 0.22, // fraction of drops that leave a splash particle
    },

      // THUNDERSTORMS. Whether a storm is electrical is decided once, when it
      // starts — so a run gets whole thunderstorms rather than the occasional
      // stray bolt in otherwise ordinary rain, and the first flash is a warning
      // that more are coming. See systems/lightning.js.
      lightning: {
        enabled: true,
        chance: 0.5, // fraction of storms that turn out to be electrical
        minIntensity: 0.35, // no lightning until the storm has properly built
        // Seconds between flashes at FULL intensity; a storm barely over the
        // threshold above fires proportionally slower.
        interval: [3, 12],
        // How many of those flashes are real bolts, as opposed to the sky
        // lighting up with nothing in it. Kept under half on purpose: sheet
        // lightning is what makes a strike land. If every flash killed
        // something, the flash would stop being a warning and become a
        // metronome.
        strikeChance: 0.4,

        flash: {
          strike: 0.9, // how far toward `color` the sky goes for a bolt
          flicker: 0.45, // ...and for sheet lightning
          color: 0xdce8ff,
          decay: 5.5, // per second
          flickerHz: 22, // strobe rate over that decay — a flash is a burst
          // What the flash does to the rest of the scene, through the same
          // day/night light bus the sun uses: the caustics and the light beams
          // flare with it, so the whole ocean registers the strike and not just
          // the sky above it.
          lightBoost: 2.5,
        },

        bolt: {
          segments: 16,
          jitter: 2.4, // world units of sideways wander, tapered to 0 at the ends
          leanX: 7, // how far off vertical the bolt enters the frame
          branches: [1, 3],
          branchLength: 0.32, // offshoot drop, as a fraction of what's left
          branchAlpha: 0.55,
          life: [0.18, 0.34],
          overscan: 10, // how far above the top of the frame it starts
          maxBolts: 3,
          color: 0xeaf2ff,
          gain: 1.6, // pushed past 1 so the bright-pass gives it a real glow
        },

        // THE KILL. Anything in the water within this radius of where the bolt
        // meets the surface dies outright — not damaged, killed, whatever it is
        // and however much health it has left. In WORLD units (the arena is
        // ~92 across and 52 tall), because everything else in this file is;
        // there is no pixel measurement to tune against at two aspect ratios.
        //
        // Note the strike lands ON the surface, so depth is the counterplay
        // that already exists: this only ever reaches what is near the top.
        killRadius: 7,
        // Killed by the weather still pays out — score, XP orbs, the food
        // chain. A sky that hands you five orbs and no risk is a good moment,
        // and the orbs still have to be swum to.
        credit: true,

        // What a strike does to the SEAL. 0 means lightning cannot touch the
        // player, which is the shipped default: an instant death out of an
        // offscreen event the player had no read on is the least fair thing
        // this game could do. Raise it and the surface becomes genuinely
        // dangerous in a storm — at 100 it is lethal outright. Uses the same
        // killRadius as everything else.
        playerDamage: 0,
    },

      // CLOUDS — a stub, on purpose. There is no cloud layer yet: this is a
      // noise field over the sky band that darkens with the storm and slides
      // with the wind, which is enough to read as overcast from a distance.
      // When real clouds arrive they belong in systems/clouds.js alongside
      // this, reading the same two numbers; the overlay then becomes the
      // bottom layer of that stack rather than something to tear out.
      clouds: {
        enabled: true,
        color: 0x0a1220,
        opacity: 0.6, // at full storm intensity
        coverage: 0.42, // 0 = wisps, 1 = solid ceiling
        softness: 0.35, // edge feather on the noise
        scale: 0.055, // noise cells per world unit
        drift: 3.2, // world units/sec of scroll at wind = 1
        base: 0.12, // a little haze even in clear weather
    },
    },

    player: {
      maxHp: 100,
      thrustEnabled: true,
      thrust: 19,
      friction: 0.965, // per-frame drag at 60fps, applied framerate-independently
      maxSpeed: 34,
      hitRadius: 1.0,
      // Widened from 3: the food chain is gated on how much chum reaches the
      // seal per second, and at 3 the water had to hold an orb every ~58 square
      // units before the loop could turn over. See systems/chumMagnet.js for
      // the per-state multipliers stacked on top of this.
      pickupRadius: 6,
      regenPerSec: 0.4,
      // 'velocity' = the seal points where it's actually moving (reads as
      // swimming); 'aim' = points at the cursor (the old behaviour, which
      // twitched with every mouse move). turnLerp smooths the rotation so a
      // sudden direction change sweeps around instead of snapping.
      faceMode: 'velocity',
      turnLerp: 8,
      minSpeedToTurn: 0.8, // below this, hold the current facing rather than spinning on noise
      // Reversing direction mirrors the model about its own forward axis. That
      // used to hard-swap, hidden behind a spin CLIP with the swap deferred to
      // the clip's midpoint — the pop was still there, just timed for when the
      // seal was edge-on. Now the mirror is simply ROLLED across: it is a half
      // turn about the same axis the barrel roll uses, so easing the angle is
      // the turnaround, and no clip is involved at all.
      turnAroundEnabled: true,
      turnAroundDuration: 0.42,
      // A dash that reverses turns over far faster — waiting out a lazy swim
      // turnaround for the model to agree with where you are already going is
      // the "animation has to finish before the input counts" feel. Short, but
      // never instant: the snap is exactly as ugly during a dash.
      turnAroundDashDuration: 0.12,
      invulnAfterHit: 0.0,
    },

    // A rim drawn around the seal's silhouette, so you can always find yourself
    // in a dark, crowded, particle-heavy frame. Replaces the ring that used to
    // be drawn around the ship: an outline tracks the actual animated shape
    // instead of hovering at a fixed radius, and it doesn't read as a hitbox.
    // Inverted-hull shells — see systems/outlines.js.
    playerOutline: {
      enabled: true,
      color: 0x6ff2ff,
      // WORLD units. The shader offsets in object space, so this is divided by
      // the model's scale before it goes in — meaning the rim keeps the same
      // on-screen width when the seal's T-menu size changes, rather than
      // fattening with it.
      thickness: 0.14,
      // Multiplies the colour past 1.0 so the HDR bright-pass catches the rim
      // and bloom haloes it. 1 = flat colour, no glow; it does nothing at all
      // with CONFIG.bloom.enabled off, which is the honest answer — there's no
      // glow without the bloom pass.
      glow: 2.0,
      opacity: 1,

      // Taking damage. The rim is the one thing on screen that is always
      // exactly the seal's shape and always findable, which makes it the right
      // surface to say "that was YOU" on — particles land wherever the hit
      // did, and the shake is a property of the whole frame.
      //
      // The COLOUR goes fully to `color` on the frame of any hit, whatever its
      // size, and eases back to the tuned rim. It has to be all-or-nothing: a
      // rim only 20% of the way to red on a small hit reads as the outline
      // being slightly off-white, not as being bitten.
      //
      // The BLOWOUT — glow and width — is what carries how much it cost. That
      // is scaled by the fraction of the health bar the hit took (see
      // fx.playerDamage), along with how long the flash lasts, so a graze is a
      // brief red blink and a megalodon is a long, bright red flare.
      hit: {
        enabled: true,
        // A red that survives the rim's own glow multiplier. Deliberately
        // pushed towards orange rather than pure 0xff0000: at glow 5 a pure
        // red rim clips to a flat unreadable slab in the bloom pass, and the
        // warmer hue keeps its shape (see the note in glow-clipping).
        color: 0xff2a18,
        // Seconds a FULL-strength flash takes to fade out completely.
        time: 0.45,
        // ...and what the smallest hit gets. Floored well above a couple of
        // frames: the point of the flash is that you notice it while looking
        // somewhere else on the screen.
        minTime: 0.18,
        // Added to playerOutline.glow / .thickness at the peak of a
        // full-strength flash. Same units and same meaning as the strike
        // wind-up's, and added on top of it — being hit mid-charge shows both.
        glowAdd: 4.0,
        thicknessAdd: 0.07,
      },
    },

    // The same rim, on the things hunting you. One shared colour across every
    // species that has it switched on, so "outlined" reads as a category — big
    // body, real threat — rather than as decoration on individual creatures.
    // Deliberately a different hue from playerOutline: the two rims are answers
    // to two different questions, and they should never be confused for each
    // other at a glance.
    //
    // COST. Each outlined creature costs ONE EXTRA DRAW CALL PER MESH IN ITS
    // MODEL, and some of these models are not one mesh. Counts, so a switch here
    // is an informed one:
    //
    //   1 mesh   greatWhite, orca, dolphin, seaTurtle, stingray, walkingCrab
    //   2-5      otter 2, mightyMeg 3, megalodon 4, shark 5
    //
    // The apex family is capped at 8 bodies on screen (enemies.groupMaxAlive),
    // so the whole apex row switched on is bounded at a few dozen extra calls,
    // worst case all-sharks. The fill cost is the less obvious one: a shell
    // draws before its creature into an empty depth buffer, so it covers the
    // whole silhouette rather than just the rim — cheap per pixel (flat colour,
    // no lighting), but it scales with how big the thing is on screen.
    creatureOutline: {
      color: 0xff7a3d,
      // WORLD units, same as playerOutline.thickness — divided by each model's
      // own scale before it reaches the shader, so one number gives the same
      // on-screen width on a dolphin and on a megalodon. Slightly under the
      // player's, so the seal still wins the read when they overlap.
      thickness: 0.12,
      glow: 2.4,
      opacity: 1,
      // Per-species switches, keyed by ASSET key (the model), not by the species
      // name in `enemies` — the outline hangs off the model, and two species
      // sharing one asset share one rim.
      //
      // A species listed here gets its shells built at spawn whether its switch
      // is on or off, so flicking one in the T-menu shows up immediately on the
      // creatures already swimming rather than only on the next wave. Keys NOT
      // listed at all never build anything.
      on: {
        // The apex family — on by default. These are the bodies you need to see
        // coming, and the ones the cap already limits to 8 at a time.
        enemyShark: true,
        enemyGreatWhite: true,
        enemyMegalodon: true,
        enemyMightyMeg: true,
        enemyOrca: true,
        enemyDolphin: true,
        // Everything else large enough for a rim to read on. Off by default:
        // these are not the threats the outline exists to call out, and several
        // of them can be on screen in numbers.
        enemyOtter: false,
        enemySeaTurtle: false,
        enemyStingray: false,
        enemyWalkingCrab: false,
    },
    },

    weapon: {
      // The basic shot grows on its own as you level, so it stays relevant
      // without needing an upgrade pick every time. Extra pellets arrive on a
      // fixed level cadence on top of that.
      damagePerLevel: 1.6,
      speedPerLevel: 0.35,
      levelsPerExtraShot: 8,
      // The only thing that decides whether the guns are live — there is no fire
      // button any more, on any device. Turning this off silences every weapon
      // that fires on the trigger (shots, missiles, bounce) and leaves the passive
      // ones running; it is a tuning switch, not a control scheme.
      autofire: true,
      fireRate: 0.36, // seconds between shots (lower = faster)
      damage: 7.5,
      speed: 22,
      life: 1.6,
      radius: 0.18,
      // `multishot` is now pellets PER FIN, not per volley — the basic shot
      // fires one from each flipper, so 1 here means two bullets. Each extra
      // point adds one more to BOTH fins.
      multishot: 1,
      finSpread: 0.05, // radians between pellets leaving the SAME fin — deliberately tiny
      spread: 0.09, // radians between pellets when there's no fin rig to split across
      pierce: 0,
      recoilEnabled: true,
      recoil: 0, // backward impulse per shot (0 = movement comes from thrust instead)

      // The shot's VOICE is keyed to the firing INTERVAL and to nothing else.
      // A volley is one gunshot no matter how many pellets are in it, so
      // stacking Multishot deliberately does not reach this — otherwise the gun
      // gets louder and fatter every level for a reason the player never chose,
      // and by the late game it's a wall.
      //
      // Fire rate is the opposite case: that one SHOULD be audible, because a
      // faster gun is a different gun. Both knobs below push the same way,
      // toward tighter and snappier as the interval shrinks.
      shotSfx: {
        enabled: true,
        // Interval ratio (base / current) that maps to the full pitch rise.
        // 3 means "three times the starting fire rate is as extreme as it gets".
        maxRateRatio: 3,
        pitchRise: 0.3,
        // Cap the tail so a shot can never still be ringing when the next one
        // leaves — which is the OTHER way sounds pile into a smear, and the one
        // that actually bites once Rapid Fire is stacked. Note this only shapes
        // the synthesised shot; an uploaded sample plays to its natural end, and
        // gets the same tightening from playbackRate via `pitchRise` instead.
        fitDecay: true,
        decayHeadroom: 0.85, // fraction of the interval the tail may occupy
    },
    },

    // ---------------------------------------------------------------------------
    // HOMING MISSILES — a second weapon that fires alongside the main gun once
    // the upgrade is taken. Each level adds one more missile per volley.
    // ---------------------------------------------------------------------------
    missile: {
      fireRate: 0.9,
      damage: 16,
      speed: 14,
      turnRate: 4.5, // radians/sec — how sharply it can curve toward a target
      life: 4,
      radius: 0.22,
      acquireRadius: 26, // won't lock onto anything farther than this
      // Random spread on the LAUNCH direction only — homing pulls them back
      // onto the target, but each missile takes its own path getting there
      // instead of every one in a volley tracing the same curve.
      launchSpread: 0.5, // radians of random jitter, +/-
      launchSpeedJitter: 0.25, // fraction of speed randomised per missile
      // Seconds of dumb flight before the seeker wakes up. The launch is the
      // event here — a big flash off the flipper and a shell thrown clear —
      // and homing that engages instantly swallows it, curving each shell onto
      // the target before it has visibly left the fin.
      homingDelay: 0.18,
      // The launch flash, per shell. Scales the `missileLaunch` feedback event
      // below; the sound plays once for the whole volley regardless (see
      // fireMissiles), or a five-shell volley is five overlapping thumps.
      launchFlashScale: 1.6,
      // The detonation, at the far end of the flight. The particle burst and the
      // shake/sound live in the `missileImpact` feedback event; what's here is
      // the sheet of light that goes with them — a real expanding disc, because
      // a burst of points reads as debris and the thing that sells a detonation
      // is the instant before the debris where the whole area goes white.
      //
      // It's tinted with the colour of whatever the shell hit, which is what
      // ties the explosion to the target rather than to the weapon: a crab pops
      // in crab colours. The flash starts white-hot regardless and cools into
      // that colour (see systems/impactFlash.js), so tinting never costs it its
      // punch.
      impact: {
        flash: true,
        // Sized off WHAT IT HIT, not in absolute world units. Creatures carry
        // their own spawn scale and a `sizeMultiplier` from the Look panel, so a
        // fixed world-unit radius is only ever right for one creature at one
        // size setting — pinned at 2.6 the "big" explosion came out smaller than
        // the mussel that caused it. A multiple of the target's live radius
        // makes it big relative to the thing that just died, which is what reads
        // as big. `minRadius` keeps a hit on something tiny from being a
        // pinprick.
        radiusScale: 3.2, // multiple of the hit creature's radius
        minRadius: 2.2, // world units, floor for very small targets
        life: 0.17, // seconds — quick, by design
        glow: 3.2, // overdrive into the HDR bright-pass, so bloom catches it
        // Anything whose asset has no colour of its own — an uploaded model
        // with no tint set, most often. Warm, so it still reads as an
        // explosion rather than as a missing value.
        fallbackColor: 0xffb347,
        // The impact takes over from the generic `bulletHit` feedback for that
        // hit, rather than stacking on top of it. Turn this off to get the old
        // behaviour back (a mussel landing like any other pellet).
        replacesBulletHit: true,
    },
    },

    // ---------------------------------------------------------------------------
    // SEA GARLIC — a constant low-damage aura around the ship. Level increases
    // radius. The cloudy visual is a procedural shader, no texture needed.
    // ---------------------------------------------------------------------------
    garlic: {
      baseRadius: 3.5,
      tickInterval: 0.25,
      damagePerTick: 1.5, // combined with tickInterval this gives a DPS
      opacity: 0.35,
      color: 0x8fffb0,
      swirl: 0.6, // how fast the cloud texture drifts
      density: 1.4, // cloud noise scale — higher = finer wisps
    },

    // ---------------------------------------------------------------------------
    // SHRIMP RING — clones of an uploaded model orbiting the ship. Deals small
    // contact damage on overlap. Level increases how many orbit.
    // ---------------------------------------------------------------------------
    shrimpRing: {
      baseCount: 3,
      radius: 2.6,
      orbitSpeed: 1.4, // radians/sec
      scale: 0.4, // world-unit size of each cloned instance
      contactDamage: 12, // weapons.csv owns this
      contactCooldown: 0.4, // per-shrimp, so one doesn't melt an enemy alone
    },

    // ---------------------------------------------------------------------------
    // THE CLUB — driftwood lashed to the fin tips, swung by the seal's own
    // swimming. See systems/club.js for the shape of the mechanic; what lives
    // here is every number in it.
    //
    // The two halves to tune are the SWING (how fast the clubs turn, which is
    // a function of how fast the player is moving) and the THROW (what happens
    // to whatever they connect with). The throw is where the weapon's damage
    // actually is: `damage` is a chip, and `ricochetDamage` paid out over a
    // full bounce budget is the real payload. Raising `damage` to "fix" a club
    // that feels weak is the wrong lever — it turns a break shot into a worse
    // shrimp ring. Raise the bounces, the launch speed, or the reach.
    // ---------------------------------------------------------------------------
    club: {
      enabled: true,
      // --- the flail -----------------------------------------------------
      // THE FINS SWING THIS WEAPON. There is no rate here, because there is no
      // clock: each club chases the direction its own flipper is pointing
      // (systems/aimRig.js solves that against the player's aim), on a loose
      // angular spring. These two numbers are the entire feel of the thing.
      //
      // `stiffness` is how urgently it catches up and `damping` is how much
      // overshoot survives. Loose (low stiffness, low damping) is a heavy club
      // on a long rope — it trails far behind the fin and keeps going after
      // the fin stops. Tight is a rigid prop bolted to the flipper, which
      // reads as a bug rather than as a weapon. Somewhere near 40/4 is a club.
      stiffness: 42,
      damping: 4.5,
      // Ceiling on the swing, radians/sec. A spring handed an impulsive target
      // (an aim that snapped across the screen) can wind past the point where
      // even the swept hit test keeps up.
      maxSwing: 34,
      // A heavy thing in water sags when it isn't being swung. Blended in by
      // how slow the club is going, so this never touches a real swing —
      // `droopCutoff` is the swing speed at which the sag is fully gone.
      droop: 0.5,
      droopCutoff: 3,
      // THE FLOP IS THE SEAL'S OWN MOVEMENT. A loose weight socketed in a
      // flipper and hauled through water streams out BEHIND the direction of
      // travel, so the club's target is the reciprocal of the velocity.
      // `velocityFollow` is how completely the water wins over the flipper's
      // own pointing direction, and `dragFullSpeed` is the speed at which it
      // wins that hard. At 1.0 / 12 a cruising seal has both clubs trailing
      // flat behind it and every turn drags them across the body — which is
      // where the hits come from, and why the weapon rewards changing
      // direction rather than holding a line.
      // NOT 1, and the reason is both physical and mechanical. A club socketed
      // in a flipper is HELD: the fin constrains it, so it can never lie fully
      // along the drag the way something on a string would. And measured
      // against the melee weapon, full dominance is the worst setting there is
      // — the drag target of a seal swimming in a straight line is constant,
      // so the clubs settle onto it and stop hitting anything. At 0.7 a
      // straight-line cruise still flops (7.8 rad/s), turning clearly beats it
      // (10.8), and bodies are thrown furthest.
      velocityFollow: 0.7,
      dragFullSpeed: 12,
      // A slow turn added on top of all that. THIS IS A CRUTCH, and is meant to
      // go to 0: it exists so the clubs still swing for a player who is barely
      // moving on a rig whose flippers only point at the cursor. Once the fins
      // spin under their own animation, zero this.
      assistSpin: 3.4,
      // What counts as a swing at all. Below this the club is being carried,
      // not swung, and it does no damage — see the gate in club.js.
      minSwing: 1.2,
      // The swing speed that counts as a full-power hit, and the ceiling on
      // how far past it a very fast swing is allowed to scale. Damage and
      // launch speed are both multiplied by (swing / powerReference).
      powerReference: 9,
      powerMax: 1.6,
      length: 2.4,        // fin tip to club head, in world units
      lengthPerLevel: 0.4,
      headRadius: 0.6,    // the business end's contact radius
      // The shaft connects too, at a thinner radius — a body leaning on the
      // seal is touching wood even when the head is elsewhere on its arc.
      shaftHits: true,
      shaftRadius: 0.22,
      contactCooldown: 0.45, // per club, per body
      // --- the look ---
      scale: 1,        // multiplier on the asset's own size (see assets.csv)
      // Trim only. club.glb is pivoted at its handle (ASSETS.club.pivot), so
      // the grip already lands on the fin tip at 0 — this is for art whose
      // handle sits a little off its own origin.
      gripOffset: 0,
      depth: -0.05,    // z nudge, so a club passes behind the seal's silhouette
      // How long a fin stays empty after the Hurler throws its club. The whole
      // price of that card: throw, and the melee weapon is gone until this
      // runs out. Long enough to be a real gap you can feel, short enough that
      // the seal is not swimming around unarmed waiting for it.
      respawnTime: 2.2,
      // --- the throw ---
      damage: 6,          // the whack itself: deliberately a chip
      damagePerLevel: 2.5,
      launchSpeed: 38,    // how hard a struck body leaves, at pivot size
      dashLaunchMul: 1.5, // a dash-swing throws harder as well as faster
      launchPivotRadius: 0.8, // the body size that takes launchSpeed unmodified
      launchMassExp: 1,   // how hard size resists being thrown (1 = linear)
      outwardShare: 0.35, // 0 = purely tangential, 1 = straight out from the
                          // seal. Some outward lean is what stops thrown bodies
                          // orbiting into the opposite fin.
      // --- the carom ---
      ricochetDamage: 18, // what a flying body does to what it lands on
      ricochetDamagePerLevel: 5,
      selfDamageShare: 0.5, // and what it takes back, so the pinball dies too
      maxBounces: 3,
      bouncesPerLevel: 1,
      bounceSpeedKeep: 0.82, // speed retained through a carom
      reHitLock: 0.12,   // seconds before the same pair may collide again
      flightTime: 1.6,   // hard ceiling on one throw, seconds
      flightDrag: 1.1,   // water resistance while airborne
      restSpeed: 4,      // below this the flight is over
      landHandoff: 0.5,  // share of the leftover speed handed to knockX/knockY,
                         // so a spent body coasts to a stop instead of halting
    },

    // ---------------------------------------------------------------------------
    // THE THROWN CLUB — the club's variant card. A strike RELEASE hurls clubs,
    // as many as the charge paid for. See fireClubThrow in systems/club.js.
    //
    // It does NOT replace the fin clubs: they stay on the flippers and keep
    // swinging. A thrown club hits for the melee club's own damage (times
    // `damageMul`), so the base card arms this one — which is what makes the
    // pair a build rather than two unrelated picks.
    // ---------------------------------------------------------------------------
    clubThrow: {
      enabled: true,
      // HOW MANY, across the charge. A flick throws `countAtMin`, a fully
      // banked strike throws `countAtFull`, and everything between is lerped —
      // the card promises the number depends on how hard you charged, so it
      // has to be a ramp and not a threshold.
      countAtMin: 1,
      countAtFull: 7,
      countPerLevel: 2,
      // Below this a release throws nothing at all. Deliberately low: this is
      // here to stop a twitch-flick spraying clubs, not to gate the ability
      // behind a full charge the way the mussel barrage is gated.
      minPower: 0.15,
      // THE THROW RIDES THE SEAL'S VELOCITY. `velocityScale` is how much of the
      // dash's own speed the club leaves with; the clamps keep a standing throw
      // from dribbling out and a full-tilt one from outrunning its own seeker.
      velocityScale: 1.15,
      minSpeed: 14,
      maxSpeed: 40,
      arc: 0.7,      // radians the fan spans, centred on the heading
      spread: 0.09,  // random jitter on top, so two throws never trace one path
      // THEN THE SEEKER. `homingDelay` is the straight flight first, and it is
      // long on purpose — seeing the club leave on the body's momentum is the
      // point of the weapon, and homing from frame one hides it.
      homingDelay: 0.22,
      turnRate: 5.5,
      acquireRadius: 30,
      damageMul: 1.6,  // as a multiple of the melee club's damage
      life: 3.2,
      radius: 0.4,
      pierce: 1,
      scale: 0.5,    // the club model is sized to be SWUNG; a thrown one is smaller
      spin: 14,      // radians/sec of end-over-end tumble
    },

    // ---------------------------------------------------------------------------
    // POWDER KEG and COLD SNAP — the club's two RIDERS.
    //
    // Neither is a weapon. Each hangs off every club hit in the run at once:
    // the swing off the fin, the body caroming through a crowd, and the thrown
    // variant. That is deliberate — the club line should reward being built
    // into rather than being three separate weapons sharing a name — and it is
    // also why their numbers are modest. A rider that fires three or four times
    // a second from two clubs is not priced like an ability that fires once.
    // ---------------------------------------------------------------------------
    clubBoom: {
      enabled: true,
      damage: 14,
      damagePerLevel: 6,
      radius: 3.1,
      radiusPerLevel: 0.55,
    },
    clubIce: {
      enabled: true,
      // Slow added per hit. The SHAPE of chill — how far it stacks, where it
      // saturates, that saturating locks the body — belongs to the element
      // system and is shared with the Glow Up! chill roll; only the amounts
      // are here. See chillEnemy in systems/elements.js.
      slowPerHit: 0.2,
      slowPerHitPerLevel: 0.06,
      duration: 3.2,      // seconds before it thaws
      freezeFor: 1,       // seconds a saturating hit locks the body solid
      freezeForPerLevel: 0.2,
    },

    // ---------------------------------------------------------------------------
    // BOUNCING SHOT — a third weapon, ricochets off the arena wall AND off the
    // enemies it hits instead of despawning on either. One shared bounce budget
    // covers both, so levelling it (maxBouncesPerLevel) is what turns it from a
    // two-hit ricochet into a shot that ping-pongs through a whole crowd.
    // ---------------------------------------------------------------------------
    bounce: {
      fireRate: 0.6,
      damage: 8,
      speed: 20,
      life: 3,
      radius: 0.2,
      maxBounces: 2,
      maxBouncesPerLevel: 2, // added to the budget by each Ricochet Rounds stack
      restitution: 1, // 1 = perfect reflection off the wall
      chainRange: 14, // how far it looks for its next victim after a hit
      chainLock: 0.06, // seconds of hit-immunity after a ricochet, so one body
                       // it's still overlapping can't eat the whole combo
      chainSpeedGain: 1.05, // each body it kicks off gives it a little more zip
      // Combo escalation: every consecutive ricochet (wall or body) raises the
      // pitch of the bink and throws a bit more spray, so a long chain audibly
      // and visibly climbs instead of being ten identical clicks.
      comboPitchStep: 0.7, // semitones per bounce — under a semitone, so it
                           // drifts upward rather than playing a scale
      comboPitchMax: 15, // ceiling in semitones, or it ends up inaudible
      comboScaleStep: 0.16, // particle/shake/glow growth per bounce
      comboScaleMax: 2.4,
    },

    // ---------------------------------------------------------------------------
    // STRIKE — a boost/dash attack with a cooldown, chainable across multiple
    // enemies (each chained hit resets the chain window). Blue orbs spawn
    // randomly and instantly restore a charge.
    // ---------------------------------------------------------------------------
    strike: {
      enabled: true,

      // --- the charge meter ----------------------------------------------------
      // The bar is FUEL, and holding the strike button burns it. Every second of
      // holding drains a second's worth of bar and banks that much POWER for the
      // strike being wound up; the release turns banked power into the dash. So a
      // full bar buys exactly one second of wind-up, and a half-empty bar can
      // only buy half a strike — how hard you can hit is capped by how well you
      // have been eating rather than by a cooldown.
      //
      // Nothing refills it but food. No passive regeneration, and holding never
      // adds: after a strike the bar comes back only as chum goes down, and the
      // mouthful that tops it off inside a live combo is what scores a FOOD
      // CHAIN link. That is the whole loop — eat to afford the next strike,
      // strike to make more to eat.
      //
      // Chum refills the bar EVERYWHERE, not only mid-combo. A strike that
      // connects with nothing opens no chain window, and if refills were gated on
      // that window the miss would leave the bar unfillable with no way back.
      // The window gates the chain LINK; it must never gate the refill.
      charge: {
        time: 1.0,       // seconds of wind-up a full bar buys — i.e. its drain time
        minFire: 0.35,   // power that must be banked before a release will fire
        chumRefill: 0.2, // bar returned per chum swallowed — i.e. 5 chum a link

        // --- PIPS -------------------------------------------------------------
        // The bar is CUT INTO PIPS and one chum is always exactly one pip. The
        // count is not configured here — it is round(1 / chumRefill), so the
        // two can never drift apart and Coiled Spring raising the refill is
        // what takes a link from five mouthfuls to three.
        //
        // EACH LINK STILL COSTS MORE THAN THE LAST; the escalation just moved
        // onto the ring. This replaced a compounding discount that made a
        // mouthful worth 0.20 of the bar, then 0.164, then 0.134, with nothing
        // on screen saying so — the bar filled at a different rate every link
        // for reasons the player could not see, which is the single thing that
        // made it read as unpredictable.
        chainPipsPerLink: 1,
        // The ceiling, doing the job the old `chainRefillFloor` did: without
        // one, a deep chain reaches a bar that cannot practically be filled and
        // the combo dies to arithmetic rather than to anything the player did.
        // 12 is also about where pips stop being countable at the size the ring
        // renders — see the note in systems/strikeRing.js.
        maxPips: 12,
        // Minimum seconds between PIP TICKS. A magnet sweep collects six orbs
        // inside one frame, and six ticks on one frame is a chord rather than
        // six ticks. The crossings queue and drain on this floor, which turns a
        // sweep into an ascending run — see notePips in systems/strike.js.
        pipGap: 0.055,
        // What banked power is worth, as multipliers over the 0..1 power. Both
        // ranges start below 1 so a barely-armed strike is genuinely feeble and
        // a full one is genuinely a commitment.
        damageMulMin: 0.8,
        damageMulMax: 2.2,
        // Reach scales the dash's DURATION, not its speed — the seal keeps a
        // constant, readable dash velocity and simply travels for longer. Reach
        // is what feeds the loop: a longer dash crosses more chum, and crossing
        // chum is what refills the bar.
        reachMulMin: 0.6,
        reachMulMax: 2.2,

        // --- the gulp ---------------------------------------------------------
        // Winding up SEALS THE MOUTH. For as long as the button is held the seal
        // neither swallows chum nor REACHES for it: no xp, no heal, and above all
        // nothing back into the bar. Without that gate a wind-up held over a pile
        // paid for itself — the meter refilled about as fast as the hold drained
        // it, and a full commitment cost nothing.
        //
        // The magnet goes off with the swallow, and has to. Gating only the
        // swallow looked worse than no gate at all: the magnet dragged every orb
        // in range inside the seal's body, where it sat hidden, which reads as
        // having been collected while the gate quietly refused to collect it.
        // Nothing moves during a wind-up; `tell` below is how the player sees
        // what the release is about to take.
        //
        // The release swallows the lot. Every orb inside `radius` goes down on
        // the frame the strike fires, through exactly the same collect path as
        // swimming over one, so the xp, the healing and the refill all land as
        // normal — the wind-up banks food alongside power and the strike cashes
        // both at once. That refill arriving on the release frame is also what
        // keeps the eat-strike-eat loop turning through a gate that would
        // otherwise starve it.
        //
        // Only a release that actually FIRES gulps: the mouthful is the strike's
        // payoff, not the hold's. A fizzle under `minFire` leaves the chum where
        // it is, still magnetised, for the wind-up that follows.
        //
        // The gate follows the BUTTON, for as long as it is down, and not the
        // meter's `charging` flag. Charging goes false the moment the bar runs
        // dry — a second into a hold at the `time` above — and a still-held
        // button burns each swallowed chum's refill straight back out, so a gate
        // tied to it came off partway through every long hold and let the pile
        // go down anyway. Releasing is what reopens the mouth, and nothing can
        // starve behind that: whatever gathered while it was shut is swallowed
        // by the ordinary collect path on the frame after the let-go, fired or
        // not.
        gulp: {
          blockEating: true, // false = eat freely while charging, and no gulp
          radius: 5,         // world units swallowed on release, before upgrades

          // How chum inside that radius shows it is spoken for while the mouth is
          // shut. It does not move an inch — it shivers in place and spins up.
          //
          // Both channels are GEOMETRIC. That began as a constraint — orb
          // materials are shared across every instance (see spawnXpOrb in
          // entities/pickups.js), so a flash written to a colour or an emissive
          // lights up every orb in the arena at once, including the ones nowhere
          // near the seal. It is now only a choice: CONFIG.pickups.glow drives
          // brightness per INSTANCE, and a third channel could ride the same
          // route. Chum inside the gulp is already deep inside that halo, so
          // what a tell of its own would add is a change of RATE, not of level.
          tell: {
            shiver: 0.07,  // world units of jitter, peak — a buzz, not a wobble
            hz: 18,        // under the ~20Hz Nyquist ceiling at 60fps, same limit
                           // the wind-up tremble lives under (see `vibrate`)
            spinMul: 3.5,  // tumble speed while it waits on the release
          },
        },

        // --- the feel of winding one up ---------------------------------------
        // Burning fuel should be felt, and it should build. The shake is
        // SUSTAINED — a continuous tremble that grows with banked power, not a
        // per-event jolt (see addSustainedShake in systems/feedback.js) — while
        // the rumble has to be re-triggered on an interval, because a motor can
        // only be handed discrete pulses.
        shake: 0.09,          // at fully banked power, scaling up from 0
        hapticInterval: 0.07, // seconds between rumble pulses while holding
        flashTime: 0.28,      // the bar flashing as it is spent, on release

        // --- the rim, winding up ----------------------------------------------
        // The seal's own outline (CONFIG.playerOutline) throbs while a strike is
        // being wound up and blows out when it fires. The rim is the one piece of
        // the seal that is always readable — it is drawn as a shell around the
        // silhouette, so it survives a dark frame, a crowd, and the particle haze
        // the wind-up itself is throwing off.
        //
        // Everything here is ADDED to the live playerOutline values rather than
        // replacing them, so whatever colour and width the rim is tuned to stays
        // the thing that swells; the tuner's own outline sliders keep meaning
        // what they meant. Glow is the channel that carries it — it multiplies
        // the colour past 1.0 into the HDR bright-pass, which is what makes the
        // rim BLOOM instead of merely turning a lighter blue.
        //
        // The pulse ACCELERATES as power banks (hzMin -> hzMax) rather than
        // getting only brighter. Rate reads as urgency in a way amplitude does
        // not, and it stays legible when the amplitude is already near the top —
        // the same reason a heart monitor speeds up instead of getting louder.
        //
        // `pulseDepth` splits the wind-up boost between a floor that just sits
        // there and the part that throbs. At 0 the rim swells smoothly with no
        // beat; at 1 it drops back to the untouched outline at the bottom of
        // every cycle, which strobes.
        outline: {
          enabled: true,
          glowAdd: 5.0,       // extra glow at fully banked power
          thicknessAdd: 0.06, // extra rim, WORLD units, at fully banked power
          hzMin: 2.2,         // pulse rate as the wind-up starts
          hzMax: 7.5,         // ...and at full power. Well under the 60fps limit.
          pulseDepth: 0.55,   // 0 = a steady swell, 1 = a full strobe
          // The release. A one-shot spike far past anything the wind-up reaches,
          // eased out over `flareTime` — the rim blows off the body as the
          // banked power leaves it. Scaled by the power actually spent, so a
          // flick pops and a full commitment detonates.
          flareGlow: 9.0,
          flareThickness: 0.14,
          flareTime: 0.32,
        },

        // --- the wind-up pose -------------------------------------------------
        // A TREMBLE, not a pose. An authored coil pulled the head back into
        // exactly the craning-neck motion the look blend works to avoid (see
        // `cameraBias` in CONFIG.head), and on a real neck that reads as a
        // break rather than as effort. Shivering the targets says "loading up"
        // without moving anything anywhere it shouldn't be.
        //
        // `hz` stays well under the 60fps Nyquist limit or the tremble aliases
        // into a slow wobble; at 14Hz there are ~4.3 samples per cycle, about
        // the fastest that still reads as a smooth buzz. aimRig beats two
        // incommensurate frequencies off it so it shivers rather than settling
        // into a visible standing wave.
        //
        // `head` looks enormous next to `body` because the two take very
        // different paths. The body angle is applied raw, so 0.035rad IS 2
        // degrees of shudder. The head figure is a nudge to the IK's look
        // TARGET, which then passes through CONFIG.head.smoothing — a 9/sec
        // filter against a 14Hz signal attenuates it about sevenfold, so 0.3 on
        // the target comes out as roughly 0.8 degrees at the skull. Measured,
        // not derived: raising `head.smoothing` will quietly mute this.
        vibrate: {
          head: 0.3,   // nudge to the normalised look target, BEFORE smoothing
          body: 0.035, // radians of shudder applied straight to the body
          hz: 14,
        },
        // The tail still lifts — that one was never the problem, and a tail
        // coming up is what makes the wind-up read from behind.
        tailLift: 9,
    },

      dashSpeed: 46, // world units/sec during the dash
      dashDuration: 0.22, // at full charge this is multiplied by reachMulMax

      // THE STRIKE IS NOT A WEAPON UNTIL YOU MAKE IT ONE.
      //
      // A base strike is the hoover, the shove and a POP. It gulps the chum in
      // front of it, it throws the seal, whatever it touches is knocked back
      // (see `knockback`) rather than opened up — and the damage it does have
      // all goes off at once, as a small blast at the point of RELEASE.
      //
      // Damage at the point of release rather than on contact, because that is
      // where the strike is a single readable event. Contact damage was spread
      // invisibly across whatever the dash happened to clip on its way past,
      // which makes a strike's worth depend on a collision test the player
      // cannot see; a blast where they let go is a thing that happens WHERE
      // THEY PRESSED THE BUTTON, and it rewards winding one up in a crowd
      // instead of hoping to clip through it.
      //
      // Every card in the strike family adds `cardDamage` to it (see
      // CONFIG.upgrades), so the dash grows teeth over a run rather than
      // arriving with them. Killer Instinct is the bite card and pays
      // `powerShare` of those slices at once.
      burst: {
        enabled: true,
        damage: 8,       // before charge — a full-charge release is ~2.2x this
        radius: 3,       // world units, and scaled by Splash Zone like any blast
        // Reach grows with commitment as well as damage does: a flick pops
        // around the seal, a full charge clears a body's width of water.
        radiusPowerMul: 1.5,
        // The explosive half of it — bodies inside the blast are thrown
        // OUTWARD from it, as a share of the ram's own knockback speed. This
        // is what makes it read as a detonation rather than as damage
        // happening in a circle.
        knock: 0.55,
      },
      // How much of the strike's damage a RAM still deals on contact, on top of
      // the shove. Zero: the strike hits once, where it was released. Kept as a
      // dial rather than deleted because "the dash also grazes what it passes
      // through" is a legitimate thing to want, and the contact path (the
      // shove, the mark, the shrapnel, the element) runs either way.
      contactShare: 0,
      cardDamage: 5,   // strike damage added per strike-family card
      powerShare: 3,   // slices Killer Instinct pays at once

      // The NOMINAL strike — what the RIDERS measure themselves against: Bone
      // Shrapnel's fragments and Glow Up!'s elemental half, both of which fire
      // per body on contact and are authored as a fraction of "a strike".
      // Neither can ride the burst (they happen somewhere else, to something
      // specific) and neither can ride the ram, which deals nothing. It is also
      // the field the tuner has been writing since the strike shipped, so a
      // shared number would have the slider fighting the rebalance.
      damage: 40,

      // WHAT A RAM DOES INSTEAD OF DAMAGE.
      //
      // An impulse, held apart from the creature's own steering (see
      // applyKnockback in entities/enemies.js) so it lands the same on a
      // turn-limited shark, a flocking school and a crab on the seabed —
      // every one of which writes its velocity a different way.
      //
      // Scaled by how hard the strike was charged and DIVIDED by how big the
      // body is: `pivotRadius` is the size that takes the full shove, and
      // anything bigger takes proportionally less. A flick nudges a minnow; a
      // full-commitment strike visibly throws a shark off its line.
      knockback: {
        enabled: true,
        speed: 26,       // world units/sec imparted at pivot size, full charge
        powerMin: 0.45,  // share of that at a barely-armed strike
        powerMax: 1.3,   // and at a fully banked one
        // The body size that takes `speed` unmodified — in AUTHORED radius
        // units, i.e. the `radius` fields in CONFIG.enemies below, never the
        // live hitbox. The hitbox has the tuner's per-asset Size slider baked
        // into it, and a number here compared against that would let art scale
        // decide the physics (see applyKnockback).
        pivotRadius: 0.8,
        massExp: 1,      // how hard size resists it (1 = linear in radius)
        // How fast the shove bleeds off, and the field that decides how FAR a
        // body actually goes: the throw integrates to speed/decay, so this and
        // `speed` together are the distance. At 26 and 12 a minnow is thrown
        // about three units and a shark about two — a shove that lands and is
        // over, rather than a launch that sends fish sailing off screen.
        decay: 12,
        spin: 5,         // tumble imparted to bodies that roll (crabs)
        boneImpulse: 2.6, // the flinch through the skeleton, as bone spring units
      },

      // THE MARK. A strike that lands on something too big to throw around —
      // a shark, a crab, a hull — paints it instead, and every homing weapon
      // the seal owns prefers a painted target for `duration` seconds.
      //
      // This is what the ram is FOR before it has teeth: the seal is a
      // spotter, and the mussels, the squad and the pod are the damage. Small
      // fish are excluded by `minRadius` — a school does not need help dying,
      // and marking one would drag every homing shot off the thing that
      // actually threatens you.
      mark: {
        enabled: true,
        duration: 6,
        minRadius: 0.65,  // bodies smaller than this are not worth painting
        boats: true,
        // How much closer a marked target LOOKS to anything picking one. At 0.3
        // a painted shark three units out beats a minnow one unit out, which is
        // the whole point — the ordnance flies PAST the small stuff to reach
        // what the player pointed at. It is still a preference and not a leash:
        // a mark on the far side of the arena loses to anything nearby, so a
        // shell never ignores the thing about to eat you.
        homingPull: 0.3,
        // The reticle, sized off the target's own radius (never hand-typed —
        // every body in the game carries an asset size multiplier).
        ring: {
          radiusMul: 1.55,
          thickness: 0.16,
          color: 0xffc65a,
          glow: 2.4,
          hz: 2.6,       // pulses per second
          pulseDepth: 0.55,
          spin: 0.7,     // rad/sec, so it reads as live rather than painted on
          fade: 0.6,     // seconds of ramp-out at the end of the mark
        },
      },

      // THE PREY CULL — what stops the dash being toothless.
      //
      // `contactShare` is 0, so before this a dash through a school killed
      // nothing, dropped no chum, and the food chain was gated on the mussels
      // and the squad doing the killing. The seal could not feed itself.
      //
      // The size rule is SHARED with the mark (`mark.minRadius` below) on
      // purpose: a body is either small enough to eat or big enough to paint,
      // and one boundary means the two can never disagree about a borderline
      // fish. Everything above the line is still only shoved and marked.
      preyCull: {
        enabled: true,
        // Defaults to the mark's threshold when omitted; set explicitly to
        // decouple them. At 0.65 this is the minnows and the schooling fish
        // (radius 0.4) and nothing that fights back.
        maxRadius: 0.65,
      },

      // SMALL FISH GET OUT OF THE WAY. A school that sat still while a seal
      // wound up a strike was free food; now the wind-up itself scatters them,
      // and a dash arrives at a hole where the school used to be unless it was
      // aimed where the school is GOING.
      //
      // Fed into the swarm behaviour as another panic term (the one schooling
      // fish already run from predators), so it composes with the flocking
      // instead of overriding it — they break and re-form, they don't teleport.
      scare: {
        enabled: true,
        radius: 7,        // how far the fright reaches
        strength: 12,     // weight in the boids sum, against fleeFromPredators' 9.5
        // AND THEY BOLT. `strength` above only competes for the school's
        // HEADING — steerTo normalises the boids sum, so a bigger panic term
        // turns them harder and moves them not one unit faster. Without this a
        // dash in flight scattered a school no quicker than a wind-up did,
        // which is the difference between fish dodging and fish drifting.
        // Peak extra speed at point-blank, full commitment.
        speedMul: 0.9,
        chargeShare: 0.7, // of that while merely winding up, scaled by banked power
        lead: 2.5,        // world units ahead along the strike heading the fright
                          // is centred, so they clear the CORRIDOR, not the seal
      },

      // "About a second" — long enough to swim into the chum a kill just
      // dropped, short enough that a combo has to be actively fed.
      chainWindow: 1.0, // seconds after a link to land the next one
      chainDamageMul: 1.15, // damage multiplier added per chain step
      // How many links' worth of food buys NO multiplier — the opening stake.
      // 1 is the inherited behaviour: the first bar's worth of eating opens the
      // chain and pays nothing, exactly as link 1 never did. Drop it to 0 and
      // the very first mouthful already hits harder.
      //
      // It applies to a FRACTIONAL level now (see chainLevel), so this is a
      // real dial rather than an on/off: 0.5 pays out from half a bar in.
      chainLevelOffset: 1,
      // A dash used to be a fixed straight line — the impulse set velocity once
      // and nothing could steer it, so the whole 0.22s read as an animation you
      // waited out. Now the dash holds its SPEED but swings its heading toward
      // the stick at a capped angular rate, which is a turn RADIUS of
      // dashSpeed / dashTurnRate (46 / 12 ≈ 3.8 world units at defaults).
      dashTurnRate: 12, // radians/sec the dash heading can swing toward input
      dashFaceLerp: 22, // facing rotation speed while dashing (replaces player.turnLerp)
      // Where the dash LAUNCHES, as a blend between the two things the player is
      // already steering with: 0 = straight along the swim (left stick / WASD),
      // 1 = straight at the aim (cursor / right stick), 0.5 = the angular
      // halfway point between them. Halfway is the default because either end
      // on its own ignores one of the player's hands — see strikeDirection() in
      // systems/strike.js for the full argument. Blended as an angle, so a
      // half-pushed stick steers as hard as a fully pushed one.
      //
      // The corridor the lens paints during the wind-up reads the SAME
      // function, so what the player is shown is what the release does.
      aimBlend: 0.5,
      // The barrel roll. The strike one-shot clip already rolls the seal; this
      // spins it FURTHER, additively, and the extra turns are bought with banked
      // power — so a full-commitment strike is visibly a bigger manoeuvre than a
      // flick, without needing a second clip.
      //
      // Turns are rounded to a whole number on purpose: a roll that stops on
      // three-quarters of a rotation leaves the seal belly-up for the rest of
      // the dash. Rounding means the extra roll always lands back flush with the
      // mirror pose underneath it.
      roll: {
        enabled: true,
        turnsAtFull: 2, // whole extra rotations at fully banked power
        // Spread over the dash, which itself grows with power — so more turns
        // across a longer dash keeps the angular speed roughly constant instead
        // of making big strikes spin frantically.
        durationMul: 1,
    },
      // Every live chain link makes the seal faster: dash speed, top speed and
      // thrust all scale together. dashTurnRate scales with them so the turn
      // radius stays exactly as tight at combo 8 as it is at combo 1 — the
      // point of a combo is to feel more agile, not to trade agility for speed.
      comboSpeedPerLevel: 0.09,
      comboSpeedMax: 1.75,
      orbSpawnMin: 8, // seconds between blue-orb spawns
      orbSpawnMax: 14,
      orbLifetime: 12,
      // Dashing through something shouldn't also mean eating its contact
      // damage — i-frames cover the dash plus a short tail so you're not
      // punished the instant you emerge still overlapping an enemy.
      //
      // A TAIL now, not a total: the dash's length is set by how hard you
      // charged, so a fixed total would have left a full-charge dash finishing
      // outside its own i-frames — the longest, most committed strike in the
      // game would have been the one that got you hit.
      invulnTail: 0.23,

      // --- what keeps a FOOD CHAIN alive ---------------------------------------
      // A dash landing on an enemy has always extended the chain. These are the
      // other ways to keep it going, each one a separate switch because they
      // fire at very different rates and are the first thing you'd want to turn
      // off while tuning. `cooldowns` is per-source, in seconds, and exists
      // because one of these arrives in bursts: a magnet sweep collects six orbs
      // inside one frame. Without a floor between links that alone would hold a
      // chain open forever.
      chainOn: {
        // Eating refilled the charge meter all the way back to full. THE main
        // engine — see `charge` above. Orbs no longer add a link directly; they
        // reach the combo only by way of the meter, so one full meter is one
        // link no matter how many orbs it took to fill.
        // A STRIKE RELEASE THAT WAS PAID FOR IN FOOD. The main engine now.
        // The link fires on the RELEASE — see tryStrike — because the bar
        // crossing full is a passive threshold the player isn't doing anything
        // at, and scoring there is why nobody could tell what earned a link.
        // The condition is "I refilled the bar and I'm spending it again
        // before the window shut", which is the strike -> eat -> strike rhythm
        // the whole system is named after.
        strikeRelease: true,
        // The bar merely REACHING full. Superseded by `strikeRelease` above and
        // switched off: leaving both on scores two links for one loop of the
        // cycle, and this is the half that happens while you are just swimming.
        chumFull: false,
        schoolWipe: true, // emptying a whole school inside one dash
        breach: true,   // crossing the surface upward — gated on the Porpoising upgrade
        // A DASH CONNECTING no longer scores a link on its own. It was the
        // original source, and it stopped making sense the moment the ram
        // became a shove: a strike that bounces a shark off its line has not
        // eaten anything, and the FOOD chain is meant to be paid for in food.
        // Left as a switch rather than deleted because it is one flag away
        // from the old behaviour and worth being able to try.
        strikeHit: false,
        // No cooldown on chumFull: the meter IS its rate limit. It takes
        // 1/chumRefill orbs to earn each link, which is a far better throttle
        // than a timer — it scales with how much food is actually there.
        // No cooldown on strikeRelease: a release already costs a bar of food
        // and a wind-up, which is a far harder throttle than any timer.
        cooldowns: { strikeRelease: 0, chumFull: 0, schoolWipe: 0, breach: 0.6, strikeHit: 0 },
    },

      // The FOOD CHAIN! announcement — the toast, the stop frame and the camera
      // punch that land when the chain EXTENDS (i.e. from the second link on;
      // the first link is just a strike connecting).
      foodChain: {
        minChain: 2,     // links before the banner shows at all
        punch: 0.045,    // camera zoom added on the first extension
        punchPerChain: 0.012, // and per link on top of that
    },

      // Porpoising (the `breachChain` upgrade): breaching the surface extends
      // the chain, so a seal launching out of the water arrives at the next
      // school with the combo already running. Upward crossings only — dropping
      // back in is the same surface twice and would double every jump.
      breachChain: {
        linksPerLevel: 1, // chain links granted per breach, per stack taken
    },
      // ---- the meter, drawn as TWO ARCS around the ship ----------------------
      // Outer = fuel in pips, inner = banked power. See the long note at the
      // top of systems/strikeRing.js for why it is two and why the inner one
      // sits as far in as it does.
      ring: {
        radius: 1.9,
        thickness: 0.16,
        // WHERE THE INSTRUMENT SITS, without touching `radius` — which the pip
        // geometry is derived from and wants to stay put. `scale` multiplies
        // the whole thing; the offsets push it off the seal in WORLD units, so
        // it stays put on the animal as the camera zooms and the seal turns.
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        color: 0x7ad7ff,
        readyColor: 0x9dffd0,
        comboColor: 0xffe066,
        // The LAST pip, held distinct so "one mouthful from a strike" reads
        // off the hue without counting segments.
        lastPipColor: 0x9dffd0,
        glow: 2.2,
        pulseSpeed: 9, // flashes per second while a combo is live
        segmentGap: 0.12, // radians of gap between pips

        // --- the banked-power arc ---------------------------------------------
        // 0.58 rather than the obvious 0.78, and it is a BLOOM number, not a
        // taste one: the bright pass runs at CONFIG.bloom.divisor 4 / radius 3,
        // which spreads about 14px at 1080p. Two bands closer than that fuse
        // into one. At the shipped radius 0.78 leaves 10px and 0.58 leaves 20.
        innerRadiusMul: 0.58,
        innerThicknessMul: 0.7,
        // Held DIM on purpose. What doesn't pass CONFIG.bloom.threshold gets no
        // halo, and an inner arc that never blooms can't bleed outward into the
        // fuel ring it sits inside — belt and braces with the radius above.
        innerGlowMul: 0.55,

        // The chain window, as a thin arc outside the fuel ring. It was never
        // drawn before: the ring pulsed at a fixed rate whether the combo had
        // 0.9s left or 0.05s.
        chainRadiusMul: 1.14,

        // --- how the needle moves ---------------------------------------------
        // Underdamped (ratio ~0.62 at these values), so a pip landing rings
        // slightly and settles. Gains only — the spend snaps, because a
        // smoothed drain makes the wind-up feel laggy. See trackSpring.
        springStiffness: 210,
        springDamping: 18,

        // --- THE PIPS PLOPPING UP, one at a time ------------------------------
        // A gulp or a magnet sweep swallows a whole bar inside one frame. Drawn
        // straight, that is a single jump from empty to full — the most
        // rewarding moment in the loop, over in 16ms, reading as a number
        // changing rather than as five things being eaten.
        //
        // So each pip has its own spring and its own pop, and they are RELEASED
        // on a stagger. Presentation only: `charge` is already whatever it is
        // and the strike is already affordable, the ring is just late to say so.
        // The drain is never staggered — see updatePips.
        //
        // Deliberately the same value as CONFIG.strike.charge.pipGap, which is
        // the floor the pip TICKS drain on, so the plop you see and the tick
        // you hear are the same event. Two fields rather than one reference
        // because one is a sound-design floor and the other is an animation
        // rate; if you move one, move the other. A concrete number rather than
        // a null-means-inherit, because the tuner binds a slider to this and a
        // null would come back as NaN the moment it was dragged.
        pipStagger: 0.055,
        // Bouncier than the bar spring above (ratio ~0.36 against its ~0.62):
        // a single pip is a small, light thing and should visibly overshoot and
        // settle rather than easing in.
        pipStiffness: 320,
        pipDamping: 13,
        // The landing. `popSwell` widens that pip's band — the channel that
        // actually reads at 4px, where brightness alone is a twinkle — and
        // `popGlow` drives its colour past 1 into the HDR bright pass so it
        // blooms outward instead of clipping white in place.
        popSwell: 0.9,
        popGlow: 2.6,
        popDecay: 4.5,   // pops per second the flare fades at
        // The overshoot comes out as GLOW rather than as fill, so the bar can
        // never spring visibly past full and read as ready before it is.
        bounceGlow: 6,
    },
      // Higher combos shove the warp grid around harder — the screen itself
      // reacts to a long chain, not just the numbers.
      comboGridWarp: 1.6, // extra ripple strength per chain step
      comboGridWarpMax: 8,
      // Bone Shrapnel: fragments burst from every enemy the dash connects with.
      // Damage is a FRACTION of the strike hit that spawned it rather than a
      // fixed number, which is what makes it ride the chain multiplier — the
      // fifth link of a chain sprays harder than the first.
      shrapnel: {
        count: 5, // fragments in the first stack's burst
        countPerLevel: 2,
        damageFrac: 0.28, // of the strike damage that spawned the burst
        speed: 22,
        life: 0.55, // short: this is a burst around the kill, not a second gun
        radius: 0.16,
        pierce: 0,
        spread: 0.35, // radians of jitter on each fragment's slot in the ring
        spin: 12,
    },
    },

    // ---------------------------------------------------------------------------
    // ELECTRIC EEL — periodic chain lightning: zaps the nearest enemy, then
    // jumps to the nearest unzapped enemy within range, up to maxChain times.
    // Level scales area (chain jump radius), damage, and max chain length.
    // ---------------------------------------------------------------------------
    eel: {
      fireRate: 2,
      baseDamage: 32,
      damagePerLevel: 7,
      baseChainRadius: 12.5,
      radiusPerLevel: 1.2,
      baseMaxChain: 5,
      chainPerLevel: 1,
      initialRange: 30, // how far the FIRST zap can reach from the player
      boltLife: 0.3, // seconds the lightning visual persists
      boltColor: 0x9fe8ff,
      boltGlow: 3,
      // --- arc shape ---
      // The bolt is a spline between targets, displaced perpendicular by
      // high-contrast value noise: `noiseOctaves` layers of increasingly fine
      // detail, each contributing less, which is what gives it a jagged
      // lightning silhouette instead of a smooth curve.
      segmentsPerHop: 14,
      noiseAmplitude: 0.55, // world units of max displacement
      noiseOctaves: 3,
      noiseContrast: 2.1, // >1 sharpens the noise into spikes rather than waves
      noiseScrollSpeed: 22, // how fast the displacement pattern churns
      coreWidth: 0.16,
      glowWidth: 0.85, // the soft outer halo drawn behind the bright core
      glowOpacity: 0.5,
      // --- branching ---
      branchChance: 0.55, // per hop, odds of throwing a dead-end fork
      branchesPerHop: 2,
      branchLength: 0.45, // fraction of the hop's length
      branchTaper: 0.55, // branches are dimmer/thinner than the main arc
      flickerSpeed: 40, // brightness flicker while the bolt is alive

      // --- storm response ---------------------------------------------------
      // The eel reads weatherState.intensity (0..1) and scales its LOOK with it,
      // so a storm overhead makes the chain lightning visibly angrier. Purely
      // visual by default: `damageInStorm` is 1, so a storm changes how the
      // ability reads without quietly changing how strong it is. Turn that up
      // only if you want weather to be a balance lever as well as a mood one.
      //
      // Every multiplier below is applied as 1 + (mul - 1) * intensity, so at
      // intensity 0 the eel is exactly what it always was and nothing about
      // clear-weather behaviour moves.
      storm: {
        enabled: true,
        glowMul: 2.3, // bolt brightness at full storm
        widthMul: 1.7, // core and halo thickness
        amplitudeMul: 1.9, // how far the arc thrashes off the straight line
        contrastMul: 1.35, // sharper spikes, less gentle waving
        branchChanceMul: 1.8, // far more dead-end forks
        branchesPerHopMul: 1.6,
        flickerMul: 1.5,
        lifeMul: 1.35, // bolts linger a little longer in the murk
        damageInStorm: 1, // 1 = looks angrier, hits exactly the same
        // Tint the bolt toward this colour as the storm builds. A cold white-
        // violet rather than a hotter blue: the storm should read as higher
        // voltage, not as a different element.
        color: 0xe6e2ff,
        colorMix: 0.75, // how far toward `color` a full storm pulls the bolt
    },
    },

    // ---------------------------------------------------------------------------
    // STARFISH — rapid-fire shuriken-style projectiles, straight line, no
    // homing or bouncing. Level scales fire rate and projectile size.
    // ---------------------------------------------------------------------------
    starfish: {
      baseFireRate: 0.5,
      fireRatePerLevel: 0.92, // multiplier per level (compounds)
      damage: 9,
      speed: 24,
      life: 1.4,
      baseRadius: 0.22,
      radiusPerLevel: 0.06,
      spinSpeed: 14, // radians/sec, purely visual
    },

    // ---------------------------------------------------------------------------
    // SEAGULL BOMB — an attack run rather than a shot. A gull enters from off
    // the side of the arena above the water, cruises in alternating flapping
    // flight and glides, picks the densest knot of crabs on the seabed, and
    // once overhead commits to a dive it holds until it connects. Level scales
    // how often a run launches. See systems/seagull.js.
    // ---------------------------------------------------------------------------
    seagullBomb: {
      baseFireRate: 2.3, // seconds between runs at level 1
      fireRatePerLevel: 0.85, // multiplier per level (compounds, faster each level)
      damage: 87, // direct hit on the crab it lands on
      splashDamage: 41, // AoE to anything else nearby on impact
      splashRadius: 5.2,
      life: 14, // seconds before an unresolved run gives up and leaves

      // --- target selection ---
      // A "pile" is scored as the crab with the most neighbours inside this
      // radius; the gull aims at that knot's centroid, not at one individual.
      clusterRadius: 7,
      minClusterSize: 1, // 1 = a lone crab is still worth a dive
      retargetInterval: 0.5, // re-scan while inbound; crabs move and die

      // --- cruise ---
      // Keep cruiseAltitude below arena.viewHeight * arena.surfaceFromTop (the
      // visible sky, currently 10.4 units) or the approach happens off-screen
      // and the first thing you see is the dive.
      cruiseAltitude: 7, // above the water line, where the run begins
      cruiseSpeed: 13,
      flapTime: 1.1, // seconds of flapping between glides
      glideTime: 0.9, // seconds of gliding between flaps
      flapLift: 3.2, // vertical accel while flapping (climbs a little)
      glideSink: 3.6, // vertical accel while gliding (sheds a little)
      // Lift and sink are tuned independently and don't cancel, so the bob
      // would otherwise integrate into a steady climb or dive. These hold the
      // undulation around cruiseAltitude instead of letting it drift.
      altitudeHold: 2.2, // spring pulling back to the cruise height
      altitudeDamp: 1.4, // bleeds off vertical speed so the spring settles

      // --- dive ---
      diveZone: 2.4, // horizontal half-width overhead that triggers the commit
      diveAccel: 34, // downward acceleration once committed
      diveSpeedMax: 30,
      diveSteer: 16, // horizontal correction while falling
      hitRadius: 0.55, // gull's own contact radius, added to the crab's
      // DEGREES of body rotation to take BACK OUT while diving, because the
      // stoop clip is not a level pose.
      //
      // The two cruise clips sit within 4 degrees of level, so pointing the
      // gull down its own velocity vector is the whole story for them. The dive
      // clip is not like that: the artist animated the stoop as a tuck with the
      // body already pitched 84 degrees nose-down, in place, expecting the pose
      // to carry the plunge (see ASSETS.seagull.subclips). Aiming a container
      // at the ground and then playing a clip that is ALSO aimed at the ground
      // put the bird 96 degrees off its own flight path — it fell sideways.
      //
      // 96 rather than 84: it cancels the stoop's pitch and the -3.6 the level
      // clips carry as well, which is what makes the nose land on the velocity
      // vector instead of near it. Measured, and it moves with the dive range —
      // re-pick those frames and this needs re-solving.
      divePitch: 96,
    },

    // ---------------------------------------------------------------------------
    // BABY BELUGA BUBBLE BLASTER — a small drone that orbits the ship and
    // periodically fires a bubble at the nearest enemy; a hit traps that enemy
    // (frozen in place, harmless) for a fixed duration. Level scales bubble size
    // (and therefore its catch radius) only.
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // SEAL TEAM — escort seals that ride the same tilted 3D orbit ring as the
    // beluga drone and ram what they touch. Each level adds another seal (up to
    // `maxSeals`) and a little damage, so the upgrade is visibly "more friends".
    // ---------------------------------------------------------------------------
    sealTeam: {
      // --- how they look -------------------------------------------------------
      // NOTHING HERE. The escorts wear the player's own surface — the
      // procedural Perlin mottling of CONFIG.sealShader, opted into by
      // `noiseShader: true` on the sealTeam asset — so the squad is tuned by
      // the same sliders the seal is and can never drift away from it.
      //
      // What used to be here: a `skin.variants` list that stamped a different
      // biolum pattern and palette onto each squad member, on the argument
      // that six identical bodies made it impossible to see WHICH seal broke
      // formation. What it actually produced was six differently-coloured
      // glowing animals escorting a seal that looked like none of them. The
      // lunge already reads on its own — one body leaves the ring and dashes —
      // so the colour was paying for legibility the movement was providing.
      maxSeals: 6,
      contactDamage: 24,
      damagePerLevel: 8,
      contactRadius: 1.05,
      // Per-TARGET, so a seal in a crowd works through all of them rather than
      // hammering only the first one it found.
      contactCooldown: 0.4,
      orbitRadius: 2.6,
      orbitSpeed: 0.9,
      orbitDepth: 1.6,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      followSpring: 22,
      followDamping: 5,
      bobAmount: 0.3,

      // --- lunge --------------------------------------------------------------
      // Escorts break formation to charge something in reach, then fall back
      // into the ring. The orbit spring is what carries them home, so "return"
      // is simply the absence of a lunge — no second set of movement rules.
      // Only ONE seal may be out at a time (teamCooldown), or a six-seal squad
      // dissolves into a permanent brawl and the ring stops reading at all.
      lunge: {
        enabled: true,
        range: 7.5, // how far out a seal will look for something to charge
        speed: 26, // dash speed, well above orbit speed so it reads as a lunge
        maxDuration: 0.9, // give up if it hasn't connected by now
        cooldown: 2.2, // per-seal rest after returning
        teamCooldown: 0.5, // minimum gap between ANY two seals lunging
        // Stop short of the target's centre instead of swimming through it —
        // the ram lands on contact anyway (contactRadius).
        standoff: 0.5,
    },

      // --- evolution ----------------------------------------------------------
      // At this many stacks the squad also opens fire while orbiting, using the
      // player's own bullet stats (so every damage/speed upgrade carries over)
      // scaled by the multipliers below.
      // Under the card's maxStacks (6) on purpose: at 6 the squad only opened
      // fire on the very last stack of a card most runs never finish, so the
      // evolution was a promise the median run never saw.
      evolveLevel: 4,
      evolved: {
        fireRate: 1.1, // seconds between shots, per seal
        damageMul: 0.7,
        speedMul: 0.9,
        range: 16, // won't shoot at anything farther away than this
    },
    },

    beluga: {
      fireRate: 1.8,
      speed: 15,
      life: 4,
      trapDuration: 5.2,
      baseBubbleRadius: 0.5,
      radiusPerLevel: 0.24,
      orbitRadius: 1.8,
      orbitSpeed: 1.1,
      // Depth of the orbit ring. The circle is tilted rather than flat against
      // the screen, so the drone passes in front of the seal on one half and
      // behind it on the other. 0 collapses it back to a flat 2D circle.
      orbitDepth: 1.4,
      // Shifts the whole ring off the player, so the drone can ride above or
      // ahead rather than being centred on the seal. Z pushes it toward (+) or
      // away from (−) the camera.
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      // The orbit point is a target the drone spring-follows, not a position
      // it's pinned to — so it swims after you instead of being welded on.
      followSpring: 26,
      followDamping: 5.5,
      bobAmount: 0.35,
      // THE TRAP, TELEGRAPHED. A catch used to be the bubble vanishing on the
      // frame it touched a fish, which is the least legible thing a hit can do
      // — the one object that explains what just happened is gone before the
      // eye lands on it. So the bubble now HOLDS on the creature for a beat,
      // strobing, and then bursts. Two beats, two sounds: `belugaTrap` as it
      // closes, `belugaPop` as it goes.
      popFlicker: 0.22,   // seconds the caught bubble hangs and strobes
      popFlickerHz: 24,   // on/off cycles per second during that hold
      popSwell: 1.45,     // how far it inflates before it bursts, x its size
      // No droneScale here anymore — the beluga model's own `fit` (in
      // assets.js) already sizes it correctly. A second multiplier on top of
      // an already-correctly-scaled model was quietly halving it; the T-menu's
      // per-mesh Size slider is the right place to adjust this now.
    },

    // ---------------------------------------------------------------------------
    // BAKALAR'S BOAT — a friendly trawler sails the surface dragging a net, and
    // anything the net sweeps up is hauled out of the water and gone. The
    // beluga's trap from the other direction: the bubble comes to the fish and
    // holds it, the net comes down and takes it away. Removes enemies without
    // dealing damage — the payoff is the XP orb the haul drops.
    // ---------------------------------------------------------------------------
    bakalar: {
      enabled: true,
      speed: 7, // how fast it sails across
      hullRadius: 2.2, // used only for the offscreen margin
      spawnMin: 14, // seconds between sailings at level 1
      spawnMax: 22,
      spawnFasterPerLevel: 1.6,
      spawnMinFloor: 5, // even a maxed stack leaves gaps to fight through
      netWidth: 7,
      netWidthPerLevel: 1.4,
      netDepth: 9,
      netDepthPerLevel: 1.6,
      netTrail: 2.2, // how far behind the hull the net hangs, so it reads as dragged
      netColor: 0xbfe9ff, // now the BEAM colour — see the beam block below
      // (`netOpacity` lived here until the beam replaced the flat panel. It is
      // gone rather than kept as a tombstone: a config value nothing reads is
      // indistinguishable from a slider that has quietly stopped working. The
      // beam carries its strength in `beam.intensity`.)
      haulSpeed: 5.5, // how fast a catch is dragged up toward the hull
      haulCatchGap: 0.6, // how close to the hull counts as landed

      // --- the tractor beam ----------------------------------------------------
      // The net was a flat translucent rectangle. It was honest about the
      // volume and it read as a pane of glass hanging off the boat, because
      // the thing that makes light look like light is FALLOFF — brightest on
      // its axis and at its source, fading to nothing at the edges — and a
      // constant-opacity quad has none of it.
      //
      // Drawn additively, so the beam brightens the water rather than covering
      // it and the fish inside stay legible. That matters more here than
      // anywhere else in the game: this beam is full of fish by design.
      //
      // See systems/bakalar.js for the shader itself. `intensity` above 1 is
      // meaningful — post.js runs the bright pass through a HalfFloat target,
      // so the core blooms instead of clipping.
      beam: {
        intensity: 1.5,
        // The cone: beam width at the HULL as a fraction of its width at the
        // bottom. Below 1 it tapers upward, which is what makes it read as
        // coming from the boat. At 1 it is a column again.
        topWidth: 0.45,
        // How hard it fades across its own width. This is the single control
        // that decides searchlight (high) versus slab of colour (low).
        edgeFalloff: 1.8,
        // How much the water eats it on the way down. Higher = the bottom of
        // the beam disappears.
        depthFalloff: 0.85,
        // Bands travelling UP the beam — the suction made visible. Without a
        // direction cue a static glow reads as a wall rather than as a pull.
        // One full travel of the band pattern per `bandSync`. A bar is the
        // nearest figure to the 1.8s cycle `bandSpeed` was authored at, and
        // the beam is a big bright thing that arrives on a timer — exactly the
        // sort of event that reads as intentional when it lands on a bar and
        // as an accident when it doesn't. Only the beam's MIDDLE is exactly on
        // the grid; see the note in the shader about the depth taper.
        bandSync: '1 bar',
        bandSpeed: 0.55, // cycles/sec, used only when bandSync is 'free'
        bandCount: 3.5,
        bandAmount: 0.28, // 0 is a smooth beam with no travelling structure
        // A hot core down the axis, over the body of the beam. Without it the
        // beam is uniformly bright across its width and reads flat.
        coreBoost: 0.9,
    },

      // --- suction -------------------------------------------------------------
      // The gameplay half of the same two curves the beam is DRAWN with (see
      // suctionAt in systems/bakalar.js). Keeping them in one function is
      // load-bearing: if the pull and the light disagreed, fish would be
      // dragged hardest through the dim parts of the beam, which reads as
      // broken without anyone being able to say why.
      //
      // What this replaced was a constant haul speed with the catch pinned at
      // a fixed offset — every fish rose at the same rate wherever it sat,
      // which is a conveyor belt rather than a pull.
      suction: {
        strength: 1.0, // overall multiplier on the pull
        edgeFalloff: 1.5, // across the cone. Near the shader's, not identical — the
        // pull is allowed to reach a little wider than the visible glow, or
        // fish appear to be gripped by nothing at the edges.
        depthFalloff: 0.7, // weaker the further from the hull
        // How fast the catch is drawn IN toward the beam axis, as a rate
        // scaled by the local pull. This is the horizontal half, and the
        // reason a catch converges into a column under the hull instead of
        // riding up in the spread it was caught in.
        inwardRate: 1.6,
        // A floor under the rise, so a fish at the very edge of the cone is
        // still slowly recovered rather than parked there for the whole
        // sailing. The falloff should make the haul UNEVEN, not stall it.
        minPull: 0.18,
    },
      bobSpeed: 1.6,
      bobAmount: 0.22,

      // --- voicemail bombs ------------------------------------------------
      // Dropped INTO the loaded net while the boat sails, on top of the haul
      // rather than instead of it. The haul is a quiet remover — fish go up and
      // away — and it always lacked a moment you could watch coming. The bomb
      // is that moment: it falls down the net, detonates among whatever is
      // still being dragged, and pays the whole catch out as chum in a radius
      // far wider than the net itself.
      //
      // Chum rather than XP orbs on purpose. The haul already pays XP through
      // onHauled; if the bomb paid XP too, the two halves would compete to
      // collect the same fish and the boat would become the only ability worth
      // taking. Chum feeds the strike meter instead, so the bomb pays into a
      // different loop than the net it rides on.
      bomb: {
        enabled: true,
        dropInterval: 3.2, // seconds between drops while sailing, at level 1
        dropIntervalPerLevel: 0.22,
        dropIntervalFloor: 1.2,
        minCatch: 1, // don't waste a bomb on an empty net
        fallSpeed: 9, // how fast it sinks down the net toward the catch
        fuse: 0.55, // seconds it sits armed at the bottom before going off
        radius: 11, // blast radius — deliberately much wider than netWidth
        radiusPerLevel: 1.1,
        damage: 60, // enough to finish anything the net could realistically hold
        damagePerLevel: 22,
        knockback: 14,
        // Chum paid per enemy killed in the blast, plus a flat scatter so a
        // bomb that catches nothing still reads as worth watching.
        chumPerKill: 3,
        chumScatter: 4,
        chumXp: 3, // per bit — a netted catch blown open is a real payday
        chumSpread: 5.5, // how far the chum is flung from the blast centre
        size: 0.72, // visual radius of the falling bomb
        color: 0xffd27a,
        blinkSpeed: 9, // how fast it flashes once armed
    },
    },

    // ---------------------------------------------------------------------------
    // SCALLOP SQUIRTER — the anti-mussel. A shell that claps itself around the
    // playfield on a bubble jet, choosing a NEW random heading every time its
    // jet pulses, and only stopping when it hits something.
    //
    // The homing mussel answers "hit the thing I'm looking at". This answers
    // "cover the water I'm not looking at" — which is why it deliberately has no
    // seeker. Adding homing to it would collapse it into a slower mussel; the
    // wandering IS the ability, and the payoff is that scallops are still
    // bouncing around behind you while you fight something else.
    // ---------------------------------------------------------------------------
    scallop: {
      fireRate: 1.45, // seconds between launches of the whole flight
      damage: 48,
      speed: 15, // jet burst speed
      life: 9, // seconds before it gives up and sinks
      radius: 0.42,
      // The jet: a hard shove in a new direction, then coasting drag until the
      // next pulse. That stop-start is what makes it read as a scallop clapping
      // rather than a bullet flying.
      pulseInterval: [0.18, 0.42], // seconds between jets, randomised per pulse
      pulseSpeed: [11, 19], // speed added by each jet
      turnRange: 2.4, // radians of heading change a pulse may apply
      drag: 1.9, // per-second velocity falloff between pulses
      sinkAccel: 2.2, // gravity once `life` runs out, so spent shells settle
      maxBounces: 6, // ricochets off the arena walls before it's spent
      restitution: 0.85,
      spin: 7, // radians/sec, purely visual — the shell tumbles as it jets
      launchStagger: 0.09, // seconds between each scallop in one flight
    },

    // ---------------------------------------------------------------------------
    // OYSTER BLASTER — a slow, heavy pearl that is worth much more when it lands
    // than while it travels. On impact it cracks into `bomblets` glowing shards
    // that fly outward and detonate individually.
    //
    // Stacks buy the BURST, not the rate of fire, so the upgrade always answers
    // "what happens where the pearl lands" rather than "how many pearls". That
    // keeps it distinct from the basic shot, which is already a rate-of-fire
    // upgrade with three cards feeding it.
    // ---------------------------------------------------------------------------
    oyster: {
      fireRate: 1.05, // seconds between pearls
      fireRatePerLevel: 0.08, // only a slight cadence gain — the burst is the upgrade
      fireRateFloor: 0.6,
      damage: 30, // the pearl's own impact
      damagePerLevel: 7,
      speed: 13,
      life: 3.2,
      radius: 0.4,
      pearlColor: 0xfff3d6,
      pearlGlow: 2.4,
      // --- the burst ---
      bomblets: 5,
      bombletsPerLevel: 1,
      bombletDamage: 24,
      bombletDamagePerLevel: 6,
      // Travel is deliberately held UNDER `bombletBlastRadius`. Under
      // exponential drag a bomblet covers (speed/drag)*(1-e^(-drag*life)), which
      // at the first pass of these numbers ([7,13] speed, 1.4 drag, up to 0.7s)
      // reached 5.8 units against a 2.4 blast — so a fast bomblet detonated in a
      // ring 3.4 to 8.2 units out and the impact point itself, where the fish
      // the pearl just hit is standing, was covered by nothing. It read as a
      // pearl that sometimes did nothing at all.
      //
      // Keeping max travel (2.44) just inside the blast radius (2.4) means every
      // bomblet's blast still reaches back over where the pearl landed, so the
      // burst is contiguous from the impact outward however the angles roll.
      bombletSpeed: [4, 8],
      bombletLife: [0.3, 0.55], // seconds of flight before it detonates
      bombletRadius: 0.2,
      bombletBlastRadius: 2.4,
      bombletBlastRadiusPerLevel: 0.18,
      bombletSpread: 6.283, // full circle — the pearl shatters, it doesn't cone
      bombletColor: 0xfff0c0,
      bombletGlow: 3.2,
      bombletDrag: 2.4,
    },

    // ---------------------------------------------------------------------------
    // OCTOPUS GRABBER — the game's only defensive companion. It hangs off the
    // seal and reels fish in with individually-tracked arms; a fish an arm has
    // hold of is inert, and arrives as chum rather than as a corpse.
    //
    // Each arm is its own state machine (idle → reaching → holding → reeling →
    // pop) rather than the whole octopus sharing one target, because the whole
    // point of the fantasy is several arms busy with several different fish at
    // once. That's also why `octoGrabLevel` adds arms rather than speed.
    //
    // NOTE: the arms are procedural curves for now — real rigged arm art is a
    // separate task. systems/octoGrab.js draws them from `armSegments` points so
    // swapping in a rig later means replacing the draw call, not the logic.
    // ---------------------------------------------------------------------------
    octoGrab: {
      // Three at level 1, not two. The card promises an animal that takes fish
      // off you, and half the rig sitting idle at the level most people see it
      // at read as an octopus that had not noticed the fight — the numbers
      // through this whole block are tuned so the FIRST fish to come inside
      // reach is reached for, rather than waited out.
      arms: 4, // at level 1
      armsPerLevel: 1,
      // No maxArms: the rig IS the cap. The model has six tentacles, and
      // systems/octoGrab.js clamps to however many arm chains actually
      // resolved — a config number claiming nine would be a slider that
      // silently does nothing past six.
      // THE GRAB RADIUS — the stat the upgrade actually buys. In world units,
      // and sized against the rig: one tentacle measures 4.38 units at
      // ASSETS.octoGrabber.fit (measured, not estimated — the sweep is in
      // tools/octopus-rig-test.mjs). Level 1 now sits PAST that on purpose and
      // spends `reachStretch` below to get there — a strained arm points hard
      // at the fish instead of quite touching it, which is what a reaching
      // octopus does anyway, and it is what makes the grab happen the moment
      // something is near rather than only once it has swum right in.
      //
      // These three numbers are ONE setting. The level scaling has to still
      // land under the stretch cap (4.38 * reachStretch) or the upgrade's whole
      // reason to exist stops working silently partway up the levels: every
      // level past the cap buys nothing at all. At 5.0/0.25/1.6 the cap is 7.0
      // and level 8 asks for 6.75, so the stat keeps paying the whole way.
      reach: 6.0,
      reachPerLevel: 0.3, // level 8 reaches 8.10, just inside the 8.31 cap
      // How far past its real length an arm may strain, as a multiple of the
      // measured chain. Above 1 the tip stops quite touching the fish and the
      // tentacle simply points hard at it — which is what a real octopus
      // reaching does, and is far better than the alternative of silently
      // refusing grabs the config asked for. Set it to 1 to forbid straining;
      // the grab radius is then hard-capped at the arm's true reach.
      reachStretch: 1.9,
      // Per-arm rest after a pop before it can reach again. Short: this is the
      // single number that decided whether the octopus looked busy or looked
      // asleep, because with six arms on a long rest the whole bundle spends
      // most of a fight in cooldown.
      grabCooldown: 0.16,
      // A strained arm never gets its tip onto the fish, so "have I arrived"
      // cannot be a distance test alone or those grabs hang in `reaching`
      // forever. After this long the arm has committed and takes hold. At the
      // strained reach above this is the usual way a grab lands, so it is
      // deliberately short — it IS the grab speed.
      graspTimeout: 0.22,
      reelSpeed: 14, // how fast a held fish is dragged toward the seal
      reelSpeedPerLevel: 0.9,
      popDistance: 1.5, // how close to the seal a fish gets before it pops
      // A fish too big to reel is simply never grabbed — an arm that latched
      // onto a megalodon and then couldn't move it would look broken, and the
      // arm would be tied up for the rest of the run.
      maxTargetRadius: 2.2,
      // What a popped fish is worth. Chum rather than a normal kill payout: the
      // arm did the work, and chum feeds the strike meter, so the octopus
      // converts incoming pressure into strike uptime.
      chumPerPop: 2,
      chumSpread: 1.4,
      chumXp: 2, // per bit — a popped fish is worth a little more than a minnow drop

      // --- the rig -------------------------------------------------------------
      // Six real arm chains, driven by CCD IK against a target at each chain's
      // tip. `arms` above is now how many may GRAB AT ONCE, not how many exist:
      // the model has six tentacles whatever your level is, and hiding two of
      // them at level 1 would look like a broken octopus. The rest dangle.
      ik: {
        iterations: 5, // CCD passes per arm per frame
        rootInfluence: 0.12, // low: the base of a tentacle should barely swing
        // Both raised a long way for the flow pass. A tight bend cap is what
        // makes CCD produce a stiff arc — the solver distributes its correction
        // evenly and every joint ends up at a similar angle. Letting a single
        // joint bend a radian and a half lets the arm curl.
        maxBend: 1.5,
        softness: 0.6, // <1 eases into the limit rather than stopping hard
        // How fast an arm chases a moving fish. Was 4, which was languid to the
        // point of looking uninterested — the arm arrived after the fish had
        // gone. This is the visible half of "grabs right away"; `weightLerpIn`
        // below is the other half.
        smoothing: 9,
        tolerance: 0.02,
    },
      // How completely the IK owns an arm in each state. Reaching is near-total;
      // dangling is deliberately weak, so an idle arm keeps most of its rest
      // pose and only drifts toward the trailing point.
      reachWeight: 0.95,
      // Very low: an idle arm is barely posed by the IK at all. It hangs in
      // roughly the right direction and the per-bone spring below supplies
      // everything else.
      // ZERO, and that is the point. An idle arm is not posed by the IK at
      // all — it is pure spring, driven only by how the body moves. Any
      // non-zero value here reimposes a single solved shape on the whole arm
      // every frame, which is exactly what made the first two passes read as
      // sticks on strings. Measured: 0 gives ~55% more shape change while being
      // dragged than 0.15 does, and a less extended arm.
      dangleWeight: 0,
      // Per-second easing between those two. This is what makes the grab read as
      // a REACH rather than a snap: the weight ramps, so the arm visibly leaves
      // its dangle and extends. Slower out than in — letting go is lazier than
      // grabbing.
      weightLerpIn: 11,
      weightLerpOut: 2.5,

      // --- dangle --------------------------------------------------------------
      // Where an unoccupied arm's target sits: behind the body, opposite the
      // direction of travel, fanned out per arm so six tentacles don't converge
      // on one point.
      // Only in play while an arm is RELEASING — with dangleWeight at 0 an
      // idle arm ignores this entirely. Kept short so a letting-go arm relaxes
      // inward rather than being flung out to full extension first.
      dangleLength: 1.8,
      dangleSpread: 1.4,
      dangleDroop: 1.1, // how far the fan sags below the trail line
      // Idle undulation, DELIBERATELY OFF. The flow comes from the per-bone
      // spring below reacting to how the body actually moves, not from a sine
      // wave playing whether or not anything is happening — a hand-animated
      // wander on top of real secondary motion is what makes a tentacle read as
      // a decorated stick. Left as a slider because a touch of it is useful for
      // a becalmed octopus sitting perfectly still.
      idleWave: 1.15,
      idleAmp: 0,

      // --- drift and drag ------------------------------------------------------
      // What makes the arms read as LOOSE rather than as posed sticks.
      //
      // The IK target does not sit on the computed dangle point; it lags behind
      // it on a soft spring, per arm. That lag IS the secondary motion: when the
      // octopus accelerates the arms are still where the body used to be, and
      // they get dragged into line over the next half second rather than
      // teleporting along with it.
      //
      // `stiffnessVariance` is what stops the six looking like one object. Each
      // arm's spring is scaled by 1 ± this, so they settle at visibly different
      // rates and the bundle never moves in lockstep — which is the single thing
      // that most made the first pass look rigid.
      drift: {
        stiffness: 3.0, // spring pulling the target toward the dangle point
        damping: 1.6, // low, so it overshoots and sways instead of easing in
        stiffnessVariance: 0.5, // ±50% per arm
        // A second, slower wander layered over the first at a non-harmonic
        // ratio. Only audible if idleAmp is turned back up.
        wanderOctave: 0.37,
        wanderOctaveAmp: 0.7,
        // How much of the body's own velocity is thrown into the trailing
        // point. Above zero the arms visibly stream backward when it jets.
        velocityDrag: 0.45,
    },

      // --- hunting -------------------------------------------------------------
      // THE OCTOPUS LEAVES STATION. Without this it station-keeps at
      // `bodyOffset` and waits for fish to swim into reach, which is what made
      // it read as a passenger: the arms did all the work and the body did
      // none. Here the head target — which is also the thrust vector, see the
      // head block — is pulled off station toward the nearest grabbable fish,
      // so the whole animal commits to the hunt and the arms arrive because
      // the body took them there.
      //
      // `weight` is the aggression dial. At 0 it station-keeps exactly as
      // before; at 1 it ignores the seal completely and chases fish across the
      // arena. Below 1 on purpose — it is still an escort, and an octopus that
      // never comes home stops protecting the thing it is escorting.
      hunt: {
        enabled: true,
        radius: 15, // how far out it will look for something to go after
        weight: 0.8, // how far off station a hunt pulls the head target
        // Jets harder and more often while committed. An octopus closing on
        // prey shouldn't be coasting on the same lazy duty cycle it patrols
        // with — this is most of what reads as "it noticed you".
        thrustBoost: 1.7,
        pulseFraction: 0.85, // of each jet interval, while hunting
        // Ignore anything already claimed by an arm. Without this it would
        // keep charging the fish it is currently reeling in, which means it
        // swims away from the seal it is delivering to.
        skipHeld: true,
    },

      // --- turbulence ----------------------------------------------------------
      // SLOW BUT STRONG. The per-bone spring below only reacts to the body
      // moving, so an octopus holding station has perfectly still arms — the
      // one state it spends most of a fight in. This is an independent force
      // field pushing each tentacle around on its own wandering vector,
      // injected into the same spring as the drag impulse.
      //
      // The character is entirely in the ratio of `strength` to `speed`: a big
      // force that changes direction slowly gives long, heavy, unpredictable
      // sweeps (a tentacle in a current), where a small fast one gives a
      // buzzing jitter that reads as noise. Keep speed low and strength high.
      //
      // Non-harmonic octaves, and every arm is seeded off its own slot, so no
      // two tentacles ever wander together and the field never lands on a beat
      // you can see repeating.
      turbulence: {
        enabled: true,
        strength: 22, // impulse per second at full deflection. Deliberately big.
        speed: 0.4, // how fast the field itself changes. Deliberately small.
        octave: 2.9, // second layer's frequency ratio — irrational-ish on purpose
        octaveAmp: 0.45,
        // Where the push lands along the arm. Near 1 the base stays planted and
        // the tip does the flailing, which is the shape a real tentacle makes.
        tipBias: 0.85,
        // How much of the force is TANGENTIAL (a swirl around the body) rather
        // than a straight push. Some of it is what makes the arms curl and
        // sweep instead of just being shoved back and forth.
        swirl: 0.55,
        // Turbulence still applies to an arm that is reaching or holding, at
        // this fraction — a working tentacle should still be in the water, it
        // just shouldn't be thrashing hard enough to miss.
        busyScale: 0.35,
    },

      // --- spread --------------------------------------------------------------
      // THE ANTI-BUNCHING PASS, and the reason it is needed: `dangleWeight` is
      // 0, so an idle arm is not posed by the IK at all. Nothing was holding
      // the six apart. The spring's drag and droop both push every tentacle the
      // same way, so over a few seconds they collect into one thick rope
      // hanging under the body — six arms rendering as one.
      //
      // Two forces, both measured on the arms' own solved TIPS:
      //
      //   radial   a tip closer to the body than `minRadius` is pushed out
      //            along its own bearing. This is what stops the bundle
      //            collapsing INTO the mantle.
      //   pairwise two tips closer together than `minGap` shove each other
      //            apart. This is what keeps them distinguishable once out.
      //
      // Applied as spring impulses rather than by moving the IK targets,
      // because the IK is off for exactly these arms — the spring is the only
      // channel that reaches an idle tentacle at all.
      spread: {
        enabled: true,
        // THE FAN — the part that actually holds the star open. Each arm owns
        // a permanent bearing and is pulled toward the point at `fanRadius`
        // along it, so it always has somewhere to be. `fanArc` is how much of
        // the circle the six share out, centred behind the direction of
        // travel: a full 2PI wraps the end arms back around the front and they
        // meet, which is the bunching this exists to prevent.
        fanRadius: 4.2,
        fanForce: 9,
        fanArc: 4.2, // radians the fan spans, ~240 degrees
        minRadius: 2.6, // how far a tip must stay from the body centre
        radialForce: 20,
        minGap: 2.2, // world units between two tips before they push apart
        gapForce: 16,
        tipBias: 1.0, // spreading is entirely a tip concern
        // Engaged arms are exempt from the pairwise shove: two arms reaching
        // for fish that happen to be next to each other SHOULD converge, and
        // pushing them apart would make both grabs miss.
        skipBusy: true,
    },

      // --- per-bone flow (the flagellum) ---------------------------------------
      // THIS is what makes a tentacle flow rather than swing. Everything above
      // moves one TARGET and lets the IK pose the whole arm to it, so however
      // loosely that target drifts, the arm itself arrives as a single rigid
      // shape — which is exactly why the first pass read as a stick on a string.
      //
      // A damped spring per bone fixes it structurally. Each bone chases the pose
      // the IK just wrote, but measures its target AFTER its parent has already
      // been displaced, so the lag accumulates into a wave travelling from base
      // to tip instead of every bone lagging by the same amount. Same solver as
      // the seal's tail — see systems/boneSpring.js.
      //
      // Numbers are far looser than any other creature in the game (a fish body
      // is 90/11 with a 0.4 lag cap): a tentacle has no skeleton in it, and it
      // should trail nearly a radian and a half per joint.
      spring: {
        enabled: true,
        // Swept rather than guessed. Deformation while being dragged peaks
        // around here and falls off BOTH ways: stiffer and the arm holds its
        // shape, much softer and the spring stops responding at all, so the arm
        // freezes into one lagged pose instead of flowing through them.
        stiffness: 12,
        damping: 1.8, // rings for a long time once disturbed
        tipLooseness: 0.94, // the last joints are almost free
        maxLag: 2.0, // radians a single bone may trail. Huge, on purpose.
        softness: 0.55, // eases into that cap instead of snapping taut
        snapAngle: 3.0, // near PI: almost nothing counts as a teleport
        // How much of the pose the lag replaces. Held high even while gripping —
        // an arm hauling a fish should still flow, it just aims deliberately.
        weightIdle: 1.0,
        weightBusy: 0.7,
        // TRANSLATION IS THE POINT. The spring reacts to the parent chain
        // ROTATING; an octopus that only slides across the screen rotates almost
        // nothing, so on its own the solver would sit perfectly still while the
        // body flew about. Body acceleration is therefore injected directly as
        // an impulse, which is what turns "drag it around" into arms that whip.
        dragGain: 9, // impulse per unit of body acceleration
        dragMax: 26, // ceiling, so a jet doesn't fold the arms through the body
        tipBias: 1.0, // 1 = the whip lands entirely at the tips
        // OFF by default, and measured rather than assumed: a constant force
        // does not make anything flow, it just moves the point the spring
        // settles at, and the arms then hang against it. Turning it off gained
        // ~40% more shape change than droop 2.2. Left as a slider because a
        // little of it suits an octopus resting on the seabed.
        droop: 0,
    },

      // --- bioluminescence -----------------------------------------------------
      // A glow that runs up each arm from the TIP, so how much the octopus is
      // helping is legible at a glance: a dark bundle is idle, a bundle with
      // three lit tips is holding three fish. See systems/bioluminescence.js.
      //
      // Per-channel, one channel per arm — which is the whole reason the glow is
      // procedural rather than an emissive map. A texture can say "tentacles
      // glow"; it cannot say "THAT tentacle, right now".
      glow: {
        enabled: true,
        color: 0x59ffd8,
        strength: 1.9,
        falloff: 2.4, // >1 concentrates it at the tip
        span: 0.5, // fraction of the arm, from the tip back, that lights at all
        ambient: 0.06, // a faint always-on shimmer, so it never looks dead
        shimmerAmp: 0.3,
        shimmerFreq: 7.0,
        // One travel of the shimmer down each arm per bar — the nearest figure
        // to the 2.6s cycle `shimmerSpeed` was authored at, so the arms kept
        // their pace and gained the grid. See systems/beatSync.js.
        shimmerSync: '1 bar',
        shimmerSpeed: 2.4, // radians/sec, used only when shimmerSync is 'free'
        // Target level per arm state. Reaching is a flare of intent; holding is
        // the sustained "this arm is working" read.
        reachLevel: 0.65,
        holdLevel: 1.0,
        // Per-second easing toward those. Fast up, slow down — a tip that has
        // just let go keeps a fading afterglow, which reads as effort spent.
        riseRate: 7.0,
        fallRate: 1.8,
    },

      // --- camouflage ----------------------------------------------------------
      // A real octopus takes the colour of what it is near, and this one does it
      // PER ARM: each tentacle's glow channel eases toward the colour of the
      // fish it is holding, or of the nearest creature to its own TIP when it
      // is holding nothing, and back to `glow.color` when there is nothing
      // close. Six arms therefore routinely wear six different colours at once.
      //
      // Where the colour comes from is a cascade — a tint set in the T panel,
      // then the average of the creature's own base texture, then its material
      // colour — see creatureTint in systems/octoGrab.js. That means it tracks
      // the actual art rather than a table someone has to keep in sync.
      camouflage: {
        enabled: true,
        // How near counts as near, measured from the arm's solved TIP rather
        // than from the body — "close to" should mean close to that tentacle.
        // Comfortably past `reach`, so an arm picks up the colour of what it is
        // about to go for before it commits.
        radius: 7.5,
        // Per-second easing onto a colour, and back off it. Slower off, so an
        // arm that has just let go keeps the colour for a beat instead of
        // snapping back to teal the frame the fish pops.
        blend: 5.0,
        fade: 1.6,
        // The sampled colour is pushed past what was actually measured. A
        // creature's own colour, added at its own level, is a wash — this is
        // what keeps it reading as a glow, and above ~2 it starts clipping to
        // white in the bright-pass.
        gain: 1.5,
    },

      // --- head / propulsion ---------------------------------------------------
      // The mantle chain aims at a point ahead of the body, and that same point
      // is what the body accelerates toward — so the octopus genuinely swims
      // where its head is pointing instead of sliding sideways with the head
      // decorating the motion.
      head: {
        weight: 0.8,
        lead: 3.2, // how far ahead of the body the head target is placed
        thrust: 26, // acceleration toward the head target
        maxSpeed: 15,
        drag: 3.4,
        // Jet in pulses rather than thrusting continuously — an octopus glides
        // between contractions, and a constant push reads as a hovering drone.
        pulseInterval: 0.75,
        pulseFraction: 0.45, // of each interval spent actually thrusting
    },

      bodyOffset: [-1.9, -1.1], // where the octopus prefers to ride vs the seal
      bodyFollow: 7, // spring pulling the head target back toward that spot
    },

    // ---------------------------------------------------------------------------
    // MUSSEL BARRAGE — the octopus's second trick, and the payoff for
    // committing to a full charge.
    //
    // Releasing a strike at or above `chargeThreshold` throws the whole flight
    // of homing mussels at once, in a wide fan around the dash heading. It is
    // deliberately the Hades multishot bow: you do not get a stream, you get
    // ONE loud moment that costs you a full wind-up, and the fan is wide
    // enough that it is an area answer rather than an aimed one — the homing
    // is what turns the spread back into hits.
    //
    // WHY IT HANGS OFF THE STRIKE rather than being another auto-firing
    // companion: the strike meter is already the game's commitment currency
    // (see systems/strike.js), and the one thing a full charge did NOT do
    // before was pay out offensively — it bought reach and damage on the dash
    // itself and nothing else. This makes the deepest charge the biggest
    // single burst of damage in the game, which is the read a charge-up meter
    // is supposed to have.
    //
    // The threshold is the whole design. Below it, nothing: a flick strike is
    // still just a dash, so the barrage can never become the thing you spam.
    musselVolley: {
      enabled: true,
      // How hard the strike must be charged to trigger it at all. High on
      // purpose — this is the reward for a FULL commitment, and at 0.85 a
      // panic-flick release cannot buy it.
      chargeThreshold: 0.85,
      count: 8, // shells per barrage at level 1
      countPerLevel: 2,
      // The fan, in radians, centred on the dash heading. Wide: the barrage is
      // meant to clear the space you are diving into, not to snipe.
      arc: 2.1,
      // Random jitter on each shell's launch angle on top of its slot in the
      // fan, so two barrages never trace the same eight curves.
      spread: 0.16,
      speedJitter: 0.22,
      // Its own numbers rather than CONFIG.missile's: this is a burst on a
      // long cooldown, where the missile is a sustained stream, so it hits
      // harder per shell and flies faster and shorter.
      damage: 22,
      damagePerLevel: 7,
      speed: 19,
      life: 2.6,
      radius: 0.24,
      turnRate: 5.2, // curves harder than a standard missile
      acquireRadius: 30,
      // Longer than the missile's, and for a different reason: eight shells
      // leaving at once from one point need to visibly BE a volley before the
      // seekers pull them onto separate targets. Homing that engages instantly
      // collapses the fan into a single stream in the first few frames.
      homingDelay: 0.26,
      launchFlashScale: 1.9,
    },

    // ---------------------------------------------------------------------------
    // ORCA FAMILY — a pod of three that hunts the surface boats specifically.
    //
    // Boats are the one threat the rest of the arsenal handles badly: they sit
    // at the surface, out of the way of the seal's usual fight, and chip at you
    // while you're busy below. Every other companion targets whatever is
    // nearest, which in practice means fish. This one deliberately looks past
    // fish to the thing you'd otherwise have to swim up and deal with yourself,
    // and only falls back to large fish when there's no boat left to hunt.
    // ---------------------------------------------------------------------------
    orca: {
      count: 3, // the pod. Fixed — stacks make them stronger, not more numerous
      damage: 30,
      damagePerLevel: 14,
      // Seconds between one orca's attack runs. The pod staggers itself so all
      // three don't breach the same boat on the same frame.
      attackInterval: 2.6,
      attackIntervalPerLevel: 0.18,
      attackIntervalFloor: 1.0,
      chargeSpeed: 22,
      chargeSpeedPerLevel: 1.4,
      cruiseSpeed: 9,
      hitRadius: 2.0, // how close a charging orca must get to land the hit
      huntRange: 34, // how far it will travel to find a boat
      // Falls back to fish only above this radius — the pod ignores minnows even
      // when idle, so it never looks like a third seal team.
      fallbackMinRadius: 0.9,
      knockback: 6,
      // Formation while there's nothing to hunt: a loose line abreast trailing
      // the seal, spaced so they read as a family group rather than a stack.
      formationSpacing: 2.6,
      formationOffset: [-3.4, 1.6],
      formationFollow: 5.5,
      breachChance: 0.35, // odds an attack run carries through the surface
      turnRate: 5.5,

      // --- facing ---------------------------------------------------------------
      // How the pod turns, as opposed to where it goes. All of this exists
      // because the cruise velocity is a spring toward a formation point that
      // moves with the seal: swimming circles around the pod used to swing each
      // orca's drift through every angle there is, at almost no speed, and the
      // model snapped end to end several times a second. See faceTravel in
      // systems/orca.js — the three numbers below are one mechanism, not three.
      //
      // e-folds per second the heading eases toward the direction of travel.
      // Deliberately unhurried: an orca is three tonnes and should read like it.
      faceLerp: 5,
      // Below this speed it holds the facing it has rather than turning to
      // chase near-zero drift. Well above the old 0.4 — station-keeping happens
      // almost entirely under it, which is where the flipping lived.
      minSpeedToTurn: 2.2,
      // How far off vertical the facing must get before a side swap is even
      // considered, as |cos(heading)|. A pod drifting up and down never asks.
      mirrorDeadZone: 0.35,
      // ...and then it has to keep asking for this long before the roll starts.
      mirrorHold: 0.35,
      // Seconds the eased half turn takes once it does. Long enough to read as
      // the animal coming about.
      mirrorDuration: 0.55,
    },

    // ---------------------------------------------------------------------------
    // CALAMARI RING — a glowing shockwave that sweeps outward from the seal on a
    // cadence. Same value-noise look as Sea Garlic, opposite damage model: each
    // enemy is hit ONCE as the wavefront crosses it, plus knockback. Garlic
    // rewards standing in a crowd; this rewards timing and position.
    // ---------------------------------------------------------------------------
    calamari: {
      interval: 3.4, // seconds between waves at level 1
      intervalPerLevel: 0.28,
      intervalFloor: 1.1,
      baseRadius: 6.5, // how far a wave travels before dissipating
      radiusPerLevel: 1.3,
      speed: 16, // how fast the front expands, world units/sec
      damage: 14,
      damagePerLevel: 6,
      knockback: 9, // outward shove, added to enemy velocity
      // Width of the lit/damaging band as a FRACTION of the wave's max radius,
      // so a bigger wave keeps the same proportions instead of turning into a
      // hairline as it grows.
      ringWidth: 0.16,
      color: 0xff8adf,
      opacity: 0.75,
      swirl: 1.6,
      density: 2.2,
    },

    // ---------------------------------------------------------------------------
    // DUMBO OCTOPUS — a companion that charms enemies. Charmed = pacified and
    // nothing else: stops chasing, stops dealing contact damage, drifts there
    // looking dazed. Pure crowd control, no damage of its own. Uses its own
    // `charmTimer` on the enemy so it can overlap the beluga's bubble without
    // either cutting the other short.
    // ---------------------------------------------------------------------------
    dumbo: {
      interval: 4.5, // seconds between charm pulses at level 1
      intervalPerLevel: 0.35,
      intervalFloor: 1.6,
      range: 8,
      rangePerLevel: 0.8,
      duration: 3.5, // how long a charm holds
      durationPerLevel: 0.4,
      targets: 1, // enemies charmed per pulse at level 1
      targetsPerLevel: 0.5, // floored, so every 2nd stack adds another target
      // Shared orbit contract — see systems/orbit.js.
      orbitRadius: 2.1,
      orbitSpeed: 0.8,
      orbitDepth: 1.2,
      offsetX: 0,
      offsetY: 0.4,
      offsetZ: 0,
      followSpring: 20,
      followDamping: 5,
      bobAmount: 0.45,
    },

    // ---------------------------------------------------------------------------
    // GLOW UP! — the seal's own bioluminescence, and the game's only ELEMENT.
    //
    // Every other upgrade adds a thing to the water. This one changes what the
    // seal's existing attacks ARE: the basic shot and the strike both start
    // carrying a second damage packet with a status attached, in a colour the
    // seal itself wears (systems/elements.js paints a biolumSkin on the body to
    // match, so you can see which element you rolled without opening a menu).
    //
    // WHICH element is rolled ONCE per run, on the card, and shown before you
    // pick it — so it's a variant you accept rather than a surprise you're
    // handed. Every stack after the first deepens the element you already have.
    //
    // THE NIGHT RAMP is the reason the ability is bioluminescence rather than
    // "elemental damage". `skyLight.night` already runs 0 by day to 1 in full
    // dark (systems/daylight.js), and a game day is 12 real minutes, so any run
    // past the first few levels crosses at least one dusk. The damage bonus at
    // night is deliberately SMALL — the real night payoff is `durationMul`,
    // because a status that lingers changes how a fight plays out, while 20%
    // more damage is a number nobody can feel.
    // ---------------------------------------------------------------------------
    biolum: {
      enabled: true,

      // The elemental packet, as a FRACTION of the hit's own damage rather than
      // a flat number. Flat elemental damage is enormous at level 3 and
      // rounding error at level 30; a fraction keeps the element worth carrying
      // for the whole run without ever eclipsing the weapon it rides on.
      damageFraction: 0.3,
      damageFractionPerLevel: 0.16,

      // Scales every status magnitude — DoT rates, slow strength, spread reach,
      // arc counts. One knob so a stack feels like the same amount of "more"
      // whichever element was rolled.
      statusPerLevel: 0.22,

      // The strike carries the element too, at a discount. A dash that hits six
      // fish would otherwise apply six full-strength statuses in one frame and
      // make the gun — the thing this upgrade is nominally about — irrelevant.
      strikeFraction: 0.5,

      night: {
        enabled: true,
        // At full dark. Modest on purpose; see the note above.
        damageMul: 1.2,
        // The one that matters. A venom that ticks for three seconds by day
        // ticks for five and a half at midnight, and an infection gets that
        // much longer to find its next host.
        durationMul: 1.8,
        // Twilight counts as most of the way to night for this ability, so
        // dusk is when it visibly wakes up rather than an hour later.
        twilightBoost: 0.35,

        // HOW MUCH OF THE ABILITY IS LIVE AT FULL NOON, 0..1. Zero is the
        // point: bioluminescence at midday is a contradiction, and a seal
        // blazing away under the sun reads as a bug in the shader rather than
        // as a power. At 0 the glow goes out AND nothing elemental is applied
        // — no bonus packet, no venom, no arc — until the light starts going.
        //
        // The knob is here rather than hardcoded because it is a real design
        // trade: a run that rolls Glow Up! at 9am has bought an ability that
        // does nothing for several minutes, and the card does not currently
        // say so. Put this at ~0.25 if that reads as broken rather than as
        // "wait for dark".
        //
        // Live statuses are NOT cancelled at sunrise — see applyElementalHit.
        dayPower: 0,
        // Shapes the fade between the two. 1 is linear in `nightFactor`;
        // above 1 holds the ability off until it is properly dark, below 1
        // wakes it early in the dusk. The crossfade to the plain noise-shaded
        // seal rides the same curve, so this is also how sharp dawn looks.
        blendGamma: 1.2,
      },

      // How the seal is lit to match the element.
      //
      // NOT a pattern. The seal's markings are already procedural — furseal.glb
      // ships no texture, so CONFIG.sealShader's mottling IS its surface — and
      // this makes the BRIGHT PATCHES of that mottling emit. Nothing here
      // changes what the seal looks like, only which parts of it are giving off
      // light, so a glowing seal is recognisably the same animal as a dark one.
      // See setNoiseGlow in systems/noiseShader.js.
      //
      // The previous version painted a second `biolumSkin` pattern over the top
      // and darkened the body underneath to make it legible; the note above
      // updateElementSkin records why that came out as a decal on an animal you
      // could not find at night.
      skin: {
        enabled: true,
        // How much of the mottling lights up, and how hard its edge is. Same
        // two knobs, same shaping, as every glowing creature's coverage and
        // contrast — see bioMask in systems/biolumSkin.js.
        coverage: 0.3,
        contrast: 2.2,
        // Climbs with the level, so a maxed Glow Up! is visibly lit up rather
        // than merely tinted. Above 1 is meaningful: post.js renders the bright
        // pass to a HalfFloat target, so this blooms instead of clipping.
        strength: 1.4,
        strengthPerLevel: 0.3,
        // The hottest patches run toward this colour rather than staying flat
        // in the element's hue — a single flat hue reads as paint, a core that
        // goes white reads as light. `white` is how far it gets there; high
        // values blow the patch out to white and lose the element's colour,
        // which is the thing the card is nominally about.
        tipColor: 0xffffff,
        white: 0.35,
        // Feature size of the LIGHT, as a multiple of the skin's own
        // (CONFIG.sealShader.size). 1 is the seal's markings exactly. Above 1
        // samples the same field further out, so the light gathers into bigger
        // patches of the same shape — which is usually what you want, because
        // the skin size is tuned for fine surface texture and a glow that fine
        // reads as speckle rather than as an animal lighting up. Measured on
        // furseal.glb at the shipped sealShader.size of 0.04: 1 is confetti, 5
        // is a handful of lit patches you can actually see the element's colour
        // in, 10 has swallowed the pattern into one blob.
        //
        // NOT called `scale`, which is the obvious name and is already taken:
        // imported-tuning.json still holds `biolum.skin.scale: 0.28` from the
        // pattern this replaced, saved tuning wins over every default here, and
        // 0.28 as a multiplier is a quarter of the skin's size — so the glow
        // came back finer than the mottling and the default in this file was
        // never what anyone saw. A stale saved key under a reused name is
        // silent in exactly the way that costs an afternoon.
        patchScale: 5,
        pulseAmp: 0.3,
        // The breath runs free at the rate below by default. Set it to a
        // division ('2 bars') to lock the seal to the music the way the shoals
        // are — systems/beatSync.js.
        pulseSync: 'free',
        pulseSpeed: 1.6,
        // ...and brighter after dark, which is the whole conceit.
        nightStrengthMul: 1.6,
      },

      // -------------------------------------------------------------------------
      // THE FOUR ELEMENTS. Each is a different ANSWER to a crowd, not a
      // different number: shock picks a second target, venom rewards staying on
      // one, chill buys you space, and infection turns the crowd against itself.
      //
      // `label` is what the card calls it, so these are content and can be
      // renamed freely. The ids are not — systems/elements.js switches on them.
      // -------------------------------------------------------------------------
      elements: {
        // Arcs to one more body. The cheapest element to read at a glance and
        // the only one whose whole effect is over within a frame.
        shock: {
          label: 'Voltaic',
          desc: 'Shots arc to a second fish',
          color: 0x9fe8ff,
          chance: 0.4,
          chancePerLevel: 0.08,
          chanceMax: 0.9,
          arcRange: 6.5,
          arcs: 1,
          arcsPerLevel: 0.34, // floored, so every third stack buys another hop
          // Fraction of the elemental packet the arc victim takes. Under 1 so a
          // chain is a bonus rather than free damage multiplication.
          arcDamage: 0.7,
        },

        // Stacking damage over time. The focus-fire element: five stacks on one
        // shark is worth far more than one stack on five fish.
        venom: {
          label: 'Venom',
          desc: 'Shots poison. Stacks on the same fish',
          color: 0x7dff3d,
          dps: 4,
          dpsPerLevel: 2.4,
          duration: 3,
          maxStacks: 5,
          tick: 0.35, // seconds between damage applications
          // A fresh hit refreshes the whole duration rather than tracking each
          // stack's own clock — one timer per enemy, and a fight you're
          // actually in keeps the poison alive by itself.
          refreshes: true,
        },

        // Slow, then a hard stop at saturation. The defensive element.
        chill: {
          label: 'Chill',
          desc: 'Shots slow. Enough of them freeze',
          color: 0xbdf5ff,
          slowPerHit: 0.16,
          slowPerHitPerLevel: 0.03,
          maxSlow: 0.7, // never a full stop from the slow alone — that's `freeze`
          duration: 2.5,
          // Saturating the slow locks the fish outright for a moment, using the
          // same `trapTimer` the beluga's bubble writes. Reused deliberately:
          // "held, inert, harmless" already exists and every system in the game
          // already agrees about what it means.
          freezeAt: 0.98, // fraction of maxSlow that triggers it
          freezeDuration: 0.9,
          freezeDurationPerLevel: 0.12,
          // Spent on freezing: the slow resets so a frozen fish thaws into full
          // speed rather than into a permanent lock.
          freezeResets: true,
        },

        // The contagion. Ticks like venom, but it also CREEPS to neighbours
        // while the host is alive and BURSTS to more of them when it dies —
        // so a packed school infected at one edge lights up across its whole
        // width without another shot fired.
        //
        // Three limiters keep that from eating the arena, and all three are
        // load-bearing: `maxHosts` caps how many are sick at once, `generations`
        // caps how far from the shot fish it can travel, and `hopFalloff`
        // weakens every hop so the far edge of a school is a nuisance rather
        // than a second gun.
        infection: {
          label: 'Infected',
          desc: 'Shots infect. It spreads between fish',
          color: 0x66ff9e,
          dps: 3.5,
          dpsPerLevel: 1.7,
          duration: 5,
          tick: 0.4,

          // --- creep, while the host lives ---
          spreadInterval: 1.2,
          spreadRange: 3.4,
          spreadRangePerLevel: 0.28,
          spreadPerHop: 1, // how many neighbours one creep event may take

          // --- burst, when the host dies ---
          burstRange: 4.5,
          burstRangePerLevel: 0.3,
          burstTargets: 3,
          // Straight damage to everything in the burst, on top of the new
          // infections. This is what makes a chain reaction visible as damage
          // and not just as more green fish.
          burstDamage: 9,
          burstDamagePerLevel: 4,

          // --- limits ---
          maxHosts: 14,
          generations: 4, // hops from the originally-shot fish
          hopFalloff: 0.8, // dps multiplier applied per generation

          // --- the motes ---
          // Tiny points that pulse and bloom around an infected body, and
          // visibly TRAVEL to the next one when it spreads. The travel is the
          // point: without it a second fish just turns green somewhere else on
          // screen and the contagion reads as coincidence.
          motes: {
            enabled: true,
            perHost: 5,
            size: 0.09,
            orbitRadius: 0.65, // as a fraction of the host's radius, plus this
            orbitSpeed: 2.2,
            pulseSpeed: 5.5,
            pulseAmp: 0.6,
            glow: 3.4,
            travelSpeed: 9, // world units/sec on a spread hop
            // Motes are pooled — this is the ceiling across every host at once,
            // so a maxed infection in a dense school can't allocate its way
            // into a frame spike.
            maxAlive: 90,
          },
        },
      },
    },

    // XP curve. Each level costs the previous one times a factor, plus `add`.
    //
    // The factor is banded rather than fixed, because the thing it races —
    // incoming xp — does not grow at a fixed rate either. The spawner's output
    // roughly DOUBLES every 90 seconds between minutes one and five (the count
    // budget climbs with difficulty while the interval falls to its floor), and
    // then flattens to roughly linear once that floor is hit. A single 1.35x
    // could not keep up with the first half of that and was far more than
    // enough for the second, which is exactly what a run felt like: levels 8
    // through 15 all arriving 17 seconds apart, then a wall.
    //
    // Measured against the real spawn tables, the factor a smooth pace needs is
    // about 1.25 early, 1.6 through the middle, and 1.4 late. That is what
    // these three bands are.
    //
    // Bands are chosen by the level being STARTED — `midFrom` 6 means the cost
    // of going from 6 to 7 is the first one to use midMul.
    xp: {
      first: 10,
      add: 5,
      mul: 1.35, // levels 1-5: the opening stays quick, four or five fast picks
      midMul: 1.6, // levels 6-16: the window where spawn income explodes
      midFrom: 6,
      lateMul: 1.42, // level 17+: income growth is linear by here, so this is plenty
      lateFrom: 17,

      // EARLY CHUM HOLDBACK. A multiplier on the xp an orb is worth, applied
      // where it drops and baked into that orb for good.
      //
      // The opening minute is the one time the player kills almost everything
      // that spawns — the creatures there are small, slow and thin, and a seal
      // with the starting weapon clears them faster than the spawner refills.
      // Paying full value for that made the first few levels arrive in a heap
      // before the run had shown the player anything, and left the water carpeted
      // in orbs worth a level between them.
      //
      // So early kills still drop a full orb — the chum is what feeds the strike
      // meter and the healing, and thinning it out would starve both — it is only
      // worth less. Value climbs linearly with difficulty and reaches full at
      // `fullAt`, by which point the spawner is producing faster than the player
      // can eat and the holdback has nothing left to hold back.
      //
      // `fullAt` is in DIFFICULTY POINTS, the same clock the roster's
      // minDifficulty gates run on — so retuning spawn.difficultyPerSecond moves
      // the holdback along with everything else it paces, instead of leaving it
      // stranded at a wall-clock time the rest of the run no longer agrees with.
      // 16 points lands the ramp around three minutes at the rate currently
      // saved, well after the last of the big predators has been let in
      // (megalodon, at difficulty 3). Set `start` to 1 to switch this off.
      dropRamp: {
        start: 0.5, // multiplier at difficulty 0 — the first seconds of a run
        fullAt: 16, // difficulty at which orbs pay their full listed xp
    },
    },

    spawn: {
      difficultyPerSecond: 1 / 20, // difficulty 1.0 every 20s
      baseInterval: 1.4,
      intervalPerDifficulty: 0.08,
      minInterval: 0.35,
      countPerDifficulty: 0.35,
      maxAlive: 220,

      // WAVES — the run breathes instead of pouring.
      //
      // Everything above describes a tap: an interval and a count budget, both
      // smooth functions of difficulty. That fills the water evenly at every
      // moment of a run, which means there is never a swell to brace for and
      // never a quiet stretch in which to notice you survived one. This block
      // gives that output a shape without changing how much of it there is.
      //
      // The cycle is SURGE (full roster, rate swelling to a crest and falling
      // away) then CALM (little fish only, slowly, carrying almost no chum),
      // repeating. The clock and the curve live in systems/waves.js; this is
      // the whole tuning surface.
      //
      // THROUGHPUT. The crest gives more and the trough gives less, and over a
      // full cycle they very nearly cancel. Measured against the same spawner
      // with `enabled: false`, over fifteen minutes at each point (the figures
      // tools/wave-test.mjs prints, so they can be re-measured rather than
      // trusted): 0.85x at the start of a run, 0.96x at three minutes, 1.09x
      // at seven and beyond. So this is a gentler opening and a mild late-run
      // tightening, not a difficulty rewrite. `peakRate` is the knob if that
      // late figure wants to come back to 1.0.
      //
      // Both multipliers are needed to get that, and the reason shows up in
      // those numbers: early on the count budget is still flooring to 1, so
      // only the interval can carry the wave; past difficulty ~13 the interval
      // has hit `minInterval` and can't stretch further, so only the budget
      // can. Drop either and half the run stops breathing.
      //
      // Set `enabled: false` and every multiplier reads 1: the spawner goes
      // back to the flat tap exactly, with no other value here consulted.
      waves: {
        enabled: true,

        // Phase lengths, in seconds, drifting with difficulty — surges grow,
        // calms shrink, both to a limit. A run therefore opens with a third of
        // its time as respite and ends with under a tenth of it, which is the
        // late game closing in expressed as pacing rather than as more hp.
        //
        // `perDifficulty` is per difficulty POINT, not per second, so retuning
        // spawn.difficultyPerSecond above moves the wave pacing with it. At the
        // rate currently saved to tuning (0.09/s, i.e. a point every ~11s) the
        // surge reaches its ceiling and the calm its floor at around eight
        // minutes in.
        surge: { seconds: 24, perDifficulty: 0.5, max: 46 },
        calm: { seconds: 12, perDifficulty: -0.16, min: 5 },

        // The shape of a surge, as fractions of its length: how much of it is
        // spent climbing to the crest, and how much falling away from it. The
        // rest is the crest itself. Both ramps are smoothstepped in waves.js —
        // a linear one reads as a dial being turned rather than as water
        // arriving.
        attack: 0.3,
        release: 0.22,

        // What pressure is worth. The spawn rate is lerped between these two by
        // the 0..1 curve, so `calmRate` is the trough and `peakRate` the crest.
        // Both multiply the tick interval AND the per-tick creature budget —
        // the interval alone stops doing anything once a long run pins it at
        // `minInterval`, and the budget alone is too coarse early, when it is
        // still flooring to 1.
        calmRate: 0.3,
        peakRate: 1.6,

        // Where the roster hands over. At or below this pressure only the small
        // fry spawn — which covers the whole calm plus the low ends of a
        // surge's two ramps, so the shoal arrives before the predators do and
        // the last thing a breaking wave sends is minnows again. A phase flag
        // instead of a threshold would put a megalodon in the water on the
        // same frame the calm ended.
        lullBelow: 0.35,

        lull: {
          // Who a lull is allowed to send: creatures already tagged `prey`
          // (the eight schooling fish), capped by size so a future large prey
          // animal can't join them. Nothing is listed by name — see
          // lullEligible() in systems/waves.js.
          maxRadius: 0.5,

          // Lull schools arrive at a fraction of their authored size. A single
          // pick of a schooling species spawns the WHOLE school regardless of
          // what is left of the tick's budget, so without this one unlucky
          // roll would put fourteen fish in the water and end the respite in a
          // single tick.
          groupMul: 0.4,

          // ...and what they are worth. THIS IS THE POINT OF THE LULL, not a
          // side effect of it: a respite that paid full chum would be the best
          // farming window in the run, and the optimal play would be to hold
          // fire through every surge and clean up in the quiet. At a quarter
          // value the calm is still worth fishing — the orbs feed the strike
          // meter and the healing at full strength, since only the xp is
          // scaled (exactly like the early holdback in CONFIG.xp.dropRamp) —
          // but it is not where levels come from. Levels come from surviving
          // the wave.
          //
          // Score is deliberately NOT scaled with it. Killing a fish in the
          // quiet still banks its full points, so a calm is a scoring window
          // that doesn't accelerate the difficulty curve.
          xpMul: 0.25,
      },
    },

      // Population ceilings for a WHOLE FAMILY of creatures, applied on top of
      // each species' own `maxConcurrent`. Tag a creature with `spawnGroup` and
      // it draws from the shared allowance here.
      //
      // The apex group exists because the per-species caps only ever asked "how
      // many of THIS one", and every big predator answered separately: shark 6
      // + greatWhite 4 + hammerhead 4 + dolphin 4 + abyssShark 2 + megalodon 2
      // + mightyMeg 2 + orca 2 is 26 large bodies that could legally be on
      // screen at once, none of them over its own limit. That reads as a crowd
      // rather than as a threat, buries the player's own silhouette, and is now
      // also the expensive case — every one of these carries a tail spring and
      // a set of fin springs (measured at tools/apex-spring-test.mjs: 0.4ms of
      // spring solving for the whole group at its caps).
      //
      // Whichever of them spawns first takes the slot; nothing here reserves
      // room for the rarer ones, since they are already gated behind
      // minDifficulty and minPlayerLevel.
      // `crab` is here because crabs arrive through TWO doors: the ordinary
      // weighted pool and systems/crabSpawner.js's chum-pile summons. Each
      // door honours maxConcurrent per TYPE, so without a family cap a dusk
      // changeover could field ten day crabs and ten night ones at once. This
      // binds in pickType and in spawnNamed, so it holds whichever door they
      // come through — and the summoner's own family count keeps its waves
      // under the same ceiling.
      // `shark` is the tighter ceiling inside the apex allowance, and it is
      // what stops the water filling up with fins. Eight apex slots divided
      // among seven shark species meant a perfectly legal shiver of six — six
      // separate 26-damage bodies converging, none of them individually over
      // any limit, and none of them readable as THE shark you are meant to be
      // dealing with. Two is the number: one is the fight, a second is
      // pressure, a third is a crowd.
      //
      // Every shark carries `spawnGroup: 'apex shark'` (see enemies.csv) so
      // both caps bind, and the boss counts against this too — a boss fight is
      // the boss plus at most one ordinary shark, never a boss lost in a
      // shiver of its own kind. Raise this and the whole family loosens at
      // once, which is the point of it being one number.
      groupMaxAlive: { apex: 8, shark: 2, crab: 10 },

      // NIGHTLIFE — the sun going down swaps the CAST, not just the light.
      //
      // Two curves over one ramp. Creatures tagged `bioluminescent` in
      // enemies.csv fade in as it gets dark; everything else fades out. Both
      // are multipliers on spawn weight, and because the spawner draws a fixed
      // budget of creatures per tick and normalises over whatever weight it
      // finds, suppressing the daylight roster does not make the night emptier
      // — it makes the same number of bodies be different bodies.
      //
      // That is the whole reason this is two curves rather than one. Merely
      // holding the glowing fish back until sunset made them 13% of a night's
      // spawns: present, findable in a log, and completely lost in an
      // otherwise unchanged daylight ocean. "It gets dark" is a lighting
      // change; "the tangs and trout go wherever fish go, and the deep comes
      // up" is a different place.
      //
      // This is the third kind of "not yet" the roster has: minDifficulty asks
      // how long the run has gone on, minPlayerLevel asks how strong the seal
      // is, and this asks what time it is — the only one of the three that can
      // go back to `no` later, because morning comes.
      //
      // A RAMP RATHER THAN A SWITCH. `skyLight.night` is 0 at the moment the
      // sun touches the water and 1 once it is properly under, so the window
      // between `dusk` and `dark` is a changeover you can watch happen.
      // Flipping at a threshold instead would swap the whole ocean between two
      // spawn ticks, which reads as a bug rather than as nightfall.
      //
      // Nothing is removed at either changeover: these only decide what NEW
      // spawns are drawn, so a school caught out by sunrise swims on and is
      // thinned by the ordinary maxAlive churn. Despawning on a clock would
      // delete creatures out from under a player mid-fight.
      nightlife: {
        enabled: true,
        // Where the changeover starts and finishes, both on skyLight.night,
        // which is clamp01(-sunElevation / 0.35) — so 0.05 is just below the
        // horizon and 0.45 is a good way into the blue hour.
        dusk: 0.05,
        dark: 0.45,
        // The tagged roster. `day` above 0 lets a few glowing fish wander the
        // daylight ocean; at 0 the gate is absolute and they do not exist
        // before sunset.
        glowing: { day: 0, night: 1 },
        // Everything else. `night` here is what makes the swap read as a swap
        // rather than as a garnish — at 0.08 the daylight species drop to a
        // twelfth of their usual weight after dark, which puts the glowing
        // roster in the clear majority of bodies on screen. The exact share is
        // measured and asserted in tools/nightlife-test.mjs.
        //
        // Turning it up is how you keep the night dangerous in the ordinary
        // way: every apex predator is untagged, so this number doubles as "how
        // much of the shark population survives sunset". At 0.08 a night is
        // mostly lights and very few teeth — a mood, but also easier than the
        // day it follows. The other lever is tagging a predator bioluminescent
        // instead, which is exactly what abyssShark is.
        daylight: { day: 1, night: 0.08 },
    },

      // Run-wide stat ramp, layered ON TOP of each species' own linear
      // `hpPerDifficulty` / `contactDamagePerDifficulty` / `speedPerDifficulty`.
      // Those are per-creature and mostly only touch hp, so a ten-minute run
      // used to face sharks that hit and swam exactly as hard as the ones in
      // the first minute — only more of them, with more hp. This is the curve
      // that makes elapsed time itself the threat.
      //
      // Each rate compounds per difficulty point (one point = 20s at the
      // default difficultyPerSecond), so a rate of 0.05 is "+5% every 20s",
      // i.e. x2.2 at five minutes and x4.3 at ten. Caps are multipliers on the
      // species' base stat and exist so a long run gets brutal without going
      // arithmetically absurd — an uncapped speed ramp eventually produces
      // creatures that cross the arena between frames and tunnel through the
      // player instead of hitting them.
      //
      // Everything here is per-instance and baked at spawn (see spawnOne), so
      // raising the ramp mid-run only affects creatures spawned after it.
      ramp: {
        hp: 0.05,
        hpMax: 10,
        damage: 0.04,
        damageMax: 4,
        speed: 0.013,
        speedMax: 1.9,
    },

      // --- NIGHT DIFFICULTY (stub — not wired to anything yet) ----------------
      // The idea: the water itself gets harder after dark, not just differently
      // populated. `nightlife` above already decides WHICH creatures the night
      // sends; this would decide how hard the ones it sends actually are.
      //
      // It sits here, off, rather than in a notebook because this is the block
      // it belongs to — the multipliers below are the same three stats `ramp`
      // scales, and wiring it means multiplying them by these at spawn (again
      // in spawnOne, again per-instance and baked, so the same "only affects
      // creatures spawned after it" rule holds).
      //
      // WHY IT IS NOT WIRED. It interacts with Glow Up!, which is also a
      // night-scaling ability (CONFIG.biolum.night). Turning both on at once
      // means the night is simultaneously more dangerous and the moment your
      // element is strongest, and whether those cancel out or compound is a
      // question for a played run rather than for a number chosen here. Ship
      // one, feel it, then decide what the other is worth.
      //
      // Multipliers on the species' base stat, applied at full dark and ramped
      // by skyLight.night exactly as the element's bonus is — so 1.0 is "no
      // change" and the shape matches the ability it has to coexist with.
      nightDifficulty: {
        enabled: false,
        hpMul: 1.15,
        damageMul: 1.1,
        speedMul: 1.05,
        // Reuse `nightlife`'s dusk/dark window rather than introducing a second
        // definition of when night starts — two answers to that question is how
        // the sky and the spawner end up disagreeing about what time it is.
        followsNightlifeWindow: true,
    },
    },

    // ---------------------------------------------------------------------------
    // THE BOSS — see systems/boss.js
    // ---------------------------------------------------------------------------
    // Every so many levels the water sends one enormous shark with a name and a
    // health bar. Everything about WHEN and HOW BIG lives here; what it hits
    // for and how much hp it has is the `bossShark` row in enemies.csv, like
    // every other creature; and what it is CALLED comes out of bossNames.csv.
    //
    // Levels rather than minutes on purpose. The run's difficulty clock is
    // already the thing that scales the ordinary roster, so pacing the boss off
    // it too would put the marquee spawn on the same curve as everything else —
    // and a player who is levelling fast is the one asking for a wall.
    boss: {
      enabled: true,
      // Levels between bosses, rolled fresh each time (inclusive). A jittered
      // gap rather than a fixed twelve so the arrival stays an event instead of
      // something you can count down to — and so two runs of the same length
      // don't fight the same number of bosses at the same moments.
      //
      // The FIRST boss is rolled from the same range, so it lands somewhere in
      // levels 8-12: far enough in that the build has an identity, close enough
      // that a run reaches one.
      everyLevelsMin: 8,
      everyLevelsMax: 12,
      // The creature it sends, and how much bigger than its own row it arrives.
      // The body is a megalodon's (radius 2.2 × the model's 2.30 fit = 5.06
      // world units), so 1.6 puts a boss at radius ~8 — a fifth of the arena's
      // 80-unit width, unmistakably the biggest thing in the water, and still
      // small enough to swim around rather than fill the screen.
      //
      // Applied to the visual, the hitbox and the size roll together (see
      // systems/boss.js) — a boss you cannot miss is not the same as a boss
      // that merely looks big.
      enemy: 'bossShark',
      sizeMul: 1.6,

      // THE WATER EMPTIES. A boss arriving is the biggest thing in the ocean
      // announcing itself, and the read is ruined if it has to share the frame
      // with thirty fish, a shiver of sharks and a crab pile — the player
      // cannot tell which of the forty bodies is the fight. So everything else
      // leaves, and nothing new is sent until it is dead.
      //
      // WHICH creatures stay is enemies.csv's `bossMinion` column, not a list
      // here: it is a per-creature yes/no that sits next to minDifficulty and
      // minPlayerLevel as one more answer to "when does this one appear", and
      // it wants to be read down a column with them. With nothing flagged the
      // fight is a duel, which is the default.
      clearOut: {
        enabled: true,
        // Creatures are sent AWAY, not deleted. Every one of them turns for
        // the nearest wall and swims out under its own power, and the existing
        // `leaving` machinery removes each as it crosses the edge — the same
        // exit the sea turtle has always taken when its visit is over.
        //
        // Popping forty bodies out of existence on one frame was the obvious
        // implementation and is unusable: half the arena vanishes between two
        // frames, which reads as the renderer having dropped the roster rather
        // than as anything in the fiction.
        exitSpeed: 5,
        // Whether minions already in the water may stay. Off would mean a
        // clean sweep followed by the escort swimming back in, which is a
        // worse-looking version of the same end state.
        keepMinions: true,
      },
    },

    // ---------------------------------------------------------------------------
    // Enemy roster. Add a key and it spawns — no other file needs editing.
    // behavior: 'chase' | 'keepDistance' | 'orbit' | 'swarm' | 'hunt'
    // ---------------------------------------------------------------------------
    enemies: {
      fish: {
        asset: 'enemyFish',
        behavior: 'swarm',
        faceMotion: true,
        prey: true, // sharks will eat these
        radius: 0.4,
        hp: 6,
        hpPerDifficulty: 0.8,
        speed: 6,
        speedVariance: 1.5,
        contactDamage: 3,
        xp: 2,
        // Fish arrive as a school rather than one at a time.
        group: { min: 6, max: 14, spread: 4 },
        swarm: {
          cohesion: 2.2, // pull toward the school's centre
          separation: 5.0, // push apart from close neighbours
          separationDist: 1.4,
          alignment: 1.6, // match neighbours' heading
          towardPlayer: 1.5, // drift the whole school at the player
          fleeFromPredators: 9.0,
          fleeRadius: 7,
          wander: 1.2,
        },
        // A single pick spawns a whole school, so the weight stays modest.
        weight: 0.6,
        weightPerDifficulty: 0.04,
        maxWeight: 1.2,
        maxConcurrent: 90,
        minDifficulty: 0,
    },

      shark: {
        separates: true,
        asset: 'enemyShark',
        behavior: 'hunt',
        faceMotion: true,
        radius: 1.2,
        hp: 60,
        hpPerDifficulty: 5,
        speed: 6.5,
        speedVariance: 1,
        contactDamage: 24,
        xp: 15,
        turnRate: 2.6, // radians/sec — sharks arc rather than pivot on the spot
        hunt: {
        // CRUISE — how this body carries itself when it is not mid-bite. See
        // the shark-cruise notes in entities/enemies.js for the mechanism; the
        // short version is that vertical movement has to be earned by getting
        // close, and the sinuous shape is carried by the HEAD (the look target
        // this weaves) with the body trailing on the existing spring chain.
        //
        // On the sharks only. The dolphin and orca are deliberately left out:
        // they are cetaceans that surface to breathe, and `porpoise` and their
        // own arcs are built on being able to climb whenever they like.
        lateral: {
          // Vertical authority ramps between these two HORIZONTAL distances to
          // the thing being chased — see updateSwim for why horizontal and not
          // straight-line. Outside `climbRange` a shark closes almost flat;
          // inside `climbFull` it is directly enough beneath its target to come
          // up into it.
          climbRange: 15,
          climbFull: 5.5,
          // Never quite zero, or a shark could never correct its depth at all
          // and would slowly settle onto whatever line it spawned on.
          climbFloor: 0.12,
          // Per-second easing of that gain. Low on purpose: this is the number
          // that decides "not abrupt", and at 0.9 a shark takes a good second
          // and a half to commit to a climb after the range opens it up.
          climbEase: 0.9,
          // The idle weave. One full side-to-side sweep every `weavePeriod`
          // seconds, aimed `weaveLead` ahead of the nose and swinging
          // `weaveAmp` to each side of the path.
          weavePeriod: 5.5,
          weaveLead: 6,
          weaveAmp: 2.4,
          // How much of that weave reaches the STEERING rather than staying in
          // the head. These last two are the ones that decide whether a cruise
          // reads as lateral, and they ADD: tools/shark-swim-test.mjs measures
          // vertical travel against horizontal, and it lands at roughly
          // `weaveBody + tan(wanderPitch)`. At 0.18/0.22 that came out near 40%
          // and the path visibly snaked; these give about 24%, which is a
          // gentle weave on a body that is clearly going somewhere. The head
          // swing (`weaveAmp`) is deliberately NOT reduced with them — that is
          // the part that is supposed to be obvious.
          weaveBody: 0.1,
          // Radians either side of horizontal the idle wander may pick.
          wanderPitch: 0.14,
        },
          preyRadius: 18, // breaks off to chase fish inside this range
          biteRange: 1.6,
          biteCooldown: 1.2,
          healPerMeal: 8, // eating a fish makes a shark tougher
          maxOverheal: 1.5, // ceiling, as a multiple of spawn hp
          growPerMeal: 0.03, // visual scale bump per meal
          maxGrow: 1.35,
          wanderChange: 1.8, // seconds between direction changes when idle
          // SCAVENGING. A shark that swims over a pile of chum should take some.
          // It outranks the player and is outranked by live fish, which is the
          // right order for an opportunist: it will break off you for a free
          // meal underfoot, but not for one across the arena, and a fish it can
          // actually chase still beats both.
          //
          // Unlike the crab this is a GULP, not a sit-down meal. The shark keeps
          // swimming (`hold: false`), takes the orb on the pass with its jaw
          // open, and `cooldown` then keeps it off the pile long enough to be a
          // threat again rather than a cleaner.
          scavenge: {
            seekRadius: 16, // only chum it is already near — see the note above
            eatRange: 2.6, // gulped from a body-length out, not nuzzled
            eatTime: 0.45, // one pass, not a meal
            reacquire: 0.5,
            distanceBias: 10, // more parochial than a crab: nearest heap, not biggest
            // Give up on an orb it has been chasing this long. A turn-limited
            // body (turnRate 2.6 against speed 6.5 is a ~2.5-unit turning
            // circle) can orbit a scrap it cannot quite line up on forever, and
            // a shark doing laps around one piece of chum is worse than one that
            // never scavenged. Abandoning also starts `cooldown`, so a shark
            // that misses goes back on the hunt rather than immediately
            // re-targeting the same unreachable orb.
            maxChase: 3.5,
            cooldown: 3, // seconds off the chum after each orb, or after a miss
            hold: false, // never stops swimming to feed
            hoover: {
              // Harder and further than the crab's: a shark inhales an orb from
              // arm's length rather than picking at it, and the jaw is out front
              // along the way it is swimming.
              pull: 9,
              mouthForward: 0.95,
              mouthRise: 0,
              crumbRate: 9,
            },
          },
        },
        weight: 0.15,
        weightPerDifficulty: 0.03,
        maxWeight: 0.5,
        maxConcurrent: 6, // a per-species ceiling the shark cap now sits under
        // TWO families, and the tighter one decides. `apex` is the shared
        // allowance for big rigged bodies (orca, dolphin and the rest);
        // `shark` is the one that matters here, and it is deliberately tiny —
        // see CONFIG.spawn.groupMaxAlive. `maxConcurrent: 6` above is left
        // where it is as the per-species ceiling it always was; it simply
        // never binds first any more.
        spawnGroup: 'apex shark',
        minDifficulty: 0.5,
    },

      // --- original abstract enemies; delete these keys to go fully aquatic ---
      // --- new schooling prey, alongside the original 'fish' ---
      trout: {
        asset: 'enemyTrout', behavior: 'swarm', faceMotion: true, prey: true,
        radius: 0.42, hp: 7, hpPerDifficulty: 0.9, speed: 5.5, speedVariance: 1.3,
        contactDamage: 3, xp: 3,
        group: { min: 4, max: 10, spread: 4 },
        swarm: { cohesion: 2.0, separation: 4.5, separationDist: 1.3, alignment: 1.5, towardPlayer: 1.3, fleeFromPredators: 8.5, fleeRadius: 7, wander: 1.1 },
        weight: 0.7, weightPerDifficulty: 0.05, maxWeight: 1.4, maxConcurrent: 60, minDifficulty: 0,
    },
      tang: {
        asset: 'enemyTang', behavior: 'swarm', faceMotion: true, prey: true,
        radius: 0.4, hp: 6, hpPerDifficulty: 0.8, speed: 5, speedVariance: 1.2,
        contactDamage: 3, xp: 3,
        group: { min: 5, max: 12, spread: 4 },
        swarm: { cohesion: 2.2, separation: 4.8, separationDist: 1.3, alignment: 1.6, towardPlayer: 1.4, fleeFromPredators: 8.8, fleeRadius: 7, wander: 1.2 },
        weight: 0.7, weightPerDifficulty: 0.05, maxWeight: 1.4, maxConcurrent: 60, minDifficulty: 0,
    },
      reeffish: {
        asset: 'enemyReeffish', behavior: 'swarm', faceMotion: true, prey: true,
        radius: 0.38, hp: 6, hpPerDifficulty: 0.8, speed: 5.5, speedVariance: 1.4,
        contactDamage: 3, xp: 3,
        group: { min: 5, max: 12, spread: 4 },
        swarm: { cohesion: 2.1, separation: 4.6, separationDist: 1.3, alignment: 1.5, towardPlayer: 1.3, fleeFromPredators: 8.6, fleeRadius: 7, wander: 1.15 },
        weight: 0.6, weightPerDifficulty: 0.04, maxWeight: 1.2, maxConcurrent: 60, minDifficulty: 0,
    },
      // Three fish split out of one file via meshIndex — small individual
      // weights since together they read as one more schooling option.
      fishPackA: {
        asset: 'enemyFishPackA', behavior: 'swarm', faceMotion: true, prey: true,
        radius: 0.35, hp: 6, hpPerDifficulty: 0.8, speed: 5, speedVariance: 1.2, contactDamage: 3, xp: 3,
        group: { min: 4, max: 9, spread: 4 },
        swarm: { cohesion: 2.1, separation: 4.6, separationDist: 1.3, alignment: 1.5, towardPlayer: 1.3, fleeFromPredators: 8.5, fleeRadius: 7, wander: 1.1 },
        weight: 0.35, weightPerDifficulty: 0.02, maxWeight: 0.7, maxConcurrent: 40, minDifficulty: 0,
    },
      fishPackB: {
        asset: 'enemyFishPackB', behavior: 'swarm', faceMotion: true, prey: true,
        radius: 0.42, hp: 7, hpPerDifficulty: 0.9, speed: 4.6, speedVariance: 1, contactDamage: 3, xp: 4,
        group: { min: 3, max: 7, spread: 4 },
        swarm: { cohesion: 2.0, separation: 4.4, separationDist: 1.4, alignment: 1.4, towardPlayer: 1.2, fleeFromPredators: 8.2, fleeRadius: 7, wander: 1.0 },
        weight: 0.35, weightPerDifficulty: 0.02, maxWeight: 0.7, maxConcurrent: 40, minDifficulty: 0,
    },
      fishPackC: {
        asset: 'enemyFishPackC', behavior: 'swarm', faceMotion: true, prey: true,
        radius: 0.32, hp: 5, hpPerDifficulty: 0.7, speed: 5.4, speedVariance: 1.3, contactDamage: 2, xp: 3,
        group: { min: 4, max: 10, spread: 4 },
        swarm: { cohesion: 2.2, separation: 4.8, separationDist: 1.2, alignment: 1.6, towardPlayer: 1.4, fleeFromPredators: 8.8, fleeRadius: 7, wander: 1.2 },
        weight: 0.35, weightPerDifficulty: 0.02, maxWeight: 0.7, maxConcurrent: 40, minDifficulty: 0,
    },

      // The plain `fish`, wearing the procedural glow — same model file, same
      // schooling numbers, its own asset key so it gets its own MATERIAL (the
      // asset pipeline shares materials across clones of one key, so lighting
      // this one on `enemyFish` would light every ordinary fish with it).
      //
      // It arrives after sunset and in smaller schools than the fish it copies.
      // A creature whose whole job is to look like the deep is wasted in
      // daylight — the glow is additive over a very dark body, so at noon it is
      // a dim fish with an odd tint, and a glowing school of fourteen is a wall
      // of bloom rather than a shoal of lights. The first is why it is tagged
      // `bioluminescent` (see CONFIG.spawn.nightlife) and the second is why the
      // group is smaller.
      lanternfish: {
        asset: 'enemyLanternfish', behavior: 'swarm', faceMotion: true, prey: true,
        bioluminescent: true, // held back until the sun is down — enemies.csv owns this
        radius: 0.4, hp: 7, hpPerDifficulty: 0.9, speed: 5.8, speedVariance: 1.4,
        contactDamage: 3, xp: 4,
        group: { min: 4, max: 9, spread: 4 },
        swarm: {
          cohesion: 2.4, // tighter than the plain fish — the lights cluster
          separation: 5.0, separationDist: 1.4, alignment: 1.8,
          towardPlayer: 1.4, fleeFromPredators: 9.0, fleeRadius: 7, wander: 1.1,
        },
        weight: 0.5, weightPerDifficulty: 0.05, maxWeight: 1.2, maxConcurrent: 45,
        minDifficulty: 2, // ~40s in at the default ramp
    },

      // The other two night shoals. Same schooling numbers as the lanternfish
      // — a school is a school, and three of them behaving differently would
      // read as a bug rather than as variety — so what separates them is the
      // preset (see reefGlow / dartGlow) and the way they move as a group.
      //
      // Their weights add up to roughly the lanternfish's on purpose: the
      // night roster is supposed to be MORE VARIED, not more crowded, and the
      // suppression curve already decides how much of the arena glows. Three
      // shoals at 0.5 each would have tripled the night's population instead.
      glowTang: {
        asset: 'enemyGlowTang', behavior: 'swarm', faceMotion: true, prey: true,
        bioluminescent: true,
        radius: 0.4, hp: 7, hpPerDifficulty: 0.9, speed: 5.2, speedVariance: 1.2,
        contactDamage: 3, xp: 4,
        // Bigger and looser than the lanternfish: a broad, slow curtain of
        // warm light, against the lanternfish's tight cold knot.
        group: { min: 5, max: 11, spread: 5.5 },
        swarm: {
          cohesion: 1.8, separation: 4.6, separationDist: 1.5, alignment: 1.5,
          towardPlayer: 1.3, fleeFromPredators: 8.5, fleeRadius: 7, wander: 1.3,
        },
        weight: 0.28, weightPerDifficulty: 0.03, maxWeight: 0.7, maxConcurrent: 30,
        minDifficulty: 2.5,
      },
      glowDarter: {
        asset: 'enemyGlowDarter', behavior: 'swarm', faceMotion: true, prey: true,
        bioluminescent: true,
        radius: 0.34, hp: 6, hpPerDifficulty: 0.8, speed: 7.2, speedVariance: 1.8,
        contactDamage: 3, xp: 4,
        // Small, fast and tightly packed — the one that arrives as a knot and
        // scatters hard when something big turns toward it.
        group: { min: 6, max: 12, spread: 3 },
        swarm: {
          cohesion: 3.0, separation: 5.6, separationDist: 1.1, alignment: 2.2,
          towardPlayer: 1.5, fleeFromPredators: 11.0, fleeRadius: 8.5, wander: 1.0,
        },
        weight: 0.24, weightPerDifficulty: 0.03, maxWeight: 0.65, maxConcurrent: 36,
        minDifficulty: 3,
      },

      // --- new predators, alongside the original 'shark' ---
      otter: {
        separates: true,
        asset: 'enemyOtter', behavior: 'hunt', faceMotion: true,
        radius: 0.7, hp: 26, hpPerDifficulty: 3, speed: 8, speedVariance: 1.5,
        contactDamage: 10, xp: 7, turnRate: 4.5,
        hunt: { preyRadius: 14, biteRange: 1.3, biteCooldown: 0.7, healPerMeal: 6, maxOverheal: 1.4, growPerMeal: 0.015, maxGrow: 1.2, wanderChange: 1.6 },
        weight: 0.3, weightPerDifficulty: 0.04, maxWeight: 0.6, maxConcurrent: 8, minDifficulty: 0.3,
    },
      greatWhite: {
        separates: true,
        asset: 'enemyGreatWhite', behavior: 'hunt', faceMotion: true,
        radius: 1.4, hp: 85, hpPerDifficulty: 9, speed: 6, speedVariance: 1,
        contactDamage: 26, xp: 18, turnRate: 2.2,
        // Cruise shaping — see the `lateral` notes on `shark`.
        hunt: { preyRadius: 20, biteRange: 1.8, biteCooldown: 1.1, healPerMeal: 10, maxOverheal: 1.5, growPerMeal: 0.03, maxGrow: 1.35, wanderChange: 2,
                lateral: { climbRange: 15, climbFull: 5.5, climbFloor: 0.12, climbEase: 0.85, weavePeriod: 6.2, weaveLead: 7, weaveAmp: 2.6, weaveBody: 0.1, wanderPitch: 0.13 } },
        weight: 0.14, weightPerDifficulty: 0.035, maxWeight: 0.45, maxConcurrent: 4, minDifficulty: 1.5,
        spawnGroup: 'apex shark',
    },
      // The great white in its glowing variant, and the only PREDATOR in the
      // family. Everything else that glows is prey or scenery, so this one is
      // deliberately the odd read: ember where the others are cold, steady
      // where the others stutter.
      //
      // Rarer and later than the great white it copies. A hunter you can see
      // coming from across the arena is easier than one you cannot, so it pays
      // for its visibility with more hp and a harder bite rather than staying
      // as common as the fish it swims past.
      abyssShark: {
        separates: true,
        asset: 'enemyAbyssShark', behavior: 'hunt', faceMotion: true,
        radius: 1.4, hp: 110, hpPerDifficulty: 10, speed: 6.4, speedVariance: 1,
        contactDamage: 30, xp: 26, turnRate: 2.2,
        // Cruise shaping — see the `lateral` notes on `shark`.
        hunt: { preyRadius: 24, biteRange: 1.8, biteCooldown: 1.0, healPerMeal: 12, maxOverheal: 1.5, growPerMeal: 0.03, maxGrow: 1.35, wanderChange: 2,
                lateral: { climbRange: 16, climbFull: 6, climbFloor: 0.12, climbEase: 0.85, weavePeriod: 6, weaveLead: 7, weaveAmp: 2.6, weaveBody: 0.1, wanderPitch: 0.13 } },
        weight: 0.07, weightPerDifficulty: 0.02, maxWeight: 0.28, maxConcurrent: 2,
        minDifficulty: 3, minPlayerLevel: 5,
        spawnGroup: 'apex shark',
      },

      // The manoeuvrable one. Every other shark in this group is a straight-line
      // threat you out-turn — a great white at turnRate 2.2 against speed 6 has
      // a wide arc, and the whole counterplay is circling inside it. The
      // hammerhead is built to punish exactly that: the highest turnRate of any
      // apex (3.4, above the dolphin's 3.6 only because the dolphin is not
      // really a shark), traded against hp and bite that sit below the great
      // white's. It should cost you the turn, not the trade.
      //
      // Its `preyRadius` is the widest of the plain sharks at 22, which is the
      // one place the model's own gimmick shows up in the numbers — the head is
      // a sensor array, so it notices fish from further out.
      hammerhead: {
        separates: true,
        asset: 'enemyHammerhead', behavior: 'hunt', faceMotion: true,
        radius: 1.3, hp: 80, hpPerDifficulty: 6, speed: 7.5, speedVariance: 1,
        contactDamage: 25, xp: 17, turnRate: 3.4,
        // Cruise shaping — see the `lateral` notes on `shark`.
        hunt: { preyRadius: 22, biteRange: 1.7, biteCooldown: 1.15, healPerMeal: 9, maxOverheal: 1.5, growPerMeal: 0.03, maxGrow: 1.35, wanderChange: 1.6,
                lateral: { climbRange: 15, climbFull: 5, climbFloor: 0.14, climbEase: 1.05, weavePeriod: 4.6, weaveLead: 6, weaveAmp: 2.8, weaveBody: 0.13, wanderPitch: 0.16 } },
        weight: 0.13, weightPerDifficulty: 0.04, maxWeight: 0.45, maxConcurrent: 4, minDifficulty: 1,
        minPlayerLevel: 3,
        spawnGroup: 'apex shark',
      },

      megalodon: {
        separates: true,
        asset: 'enemyMegalodon', behavior: 'hunt', faceMotion: true,
        radius: 2.2, hp: 220, hpPerDifficulty: 20, speed: 5.5, speedVariance: 0.8,
        contactDamage: 42, xp: 40, turnRate: 1.6,
        // Cruise shaping — see the `lateral` notes on `shark`.
        hunt: { preyRadius: 24, biteRange: 2.6, biteCooldown: 1.4, healPerMeal: 16, maxOverheal: 1.4, growPerMeal: 0.02, maxGrow: 1.25, wanderChange: 2.4,
                lateral: { climbRange: 18, climbFull: 7, climbFloor: 0.1, climbEase: 0.6, weavePeriod: 8, weaveLead: 10, weaveAmp: 3.4, weaveBody: 0.08, wanderPitch: 0.11 } },
        weight: 0.05, weightPerDifficulty: 0.015, maxWeight: 0.18, maxConcurrent: 2, minDifficulty: 3,
        spawnGroup: 'apex shark',
    },
      mightyMeg: {
        separates: true,
        asset: 'enemyMightyMeg', behavior: 'hunt', faceMotion: true,
        radius: 2.0, hp: 190, hpPerDifficulty: 18, speed: 6, speedVariance: 0.9,
        contactDamage: 38, xp: 36, turnRate: 1.8,
        // Cruise shaping — see the `lateral` notes on `shark`.
        hunt: { preyRadius: 22, biteRange: 2.4, biteCooldown: 1.3, healPerMeal: 15, maxOverheal: 1.4, growPerMeal: 0.02, maxGrow: 1.25, wanderChange: 2.2,
                lateral: { climbRange: 17, climbFull: 6.5, climbFloor: 0.1, climbEase: 0.65, weavePeriod: 7.4, weaveLead: 9, weaveAmp: 3.2, weaveBody: 0.08, wanderPitch: 0.12 } },
        weight: 0.05, weightPerDifficulty: 0.015, maxWeight: 0.18, maxConcurrent: 2, minDifficulty: 2.6,
        spawnGroup: 'apex shark',
    },

      // THE BOSS. A megalodon's body at CONFIG.boss.sizeMul, with a rolled
      // name and a red health bar over it — see systems/boss.js. Everything
      // that makes it a boss rather than a big megalodon is in that file; this
      // is only the creature it sends.
      //
      // `weight: 0` and `spawnRateMul: 0` keep it out of the weighted pool
      // entirely (pickType drops anything that works out to zero), so the ONLY
      // way one appears is the level trigger. Both, not one: either alone
      // would do it, and a stray edit to either is a boss turning up as
      // ordinary wildlife.
      //
      // It carries the same `apex shark` tags as the rest of the family, which
      // is what keeps a boss fight from also being a shiver — the boss holds
      // one of the two shark slots itself. Its own arrival ignores those caps
      // (systems/boss.js spawns with ignoreCaps), because a boss that failed to
      // turn up because two sharks were already swimming would be a bug with no
      // symptom but silence.
      //
      // Reuses `enemyMegalodon` rather than declaring an asset of its own: a
      // new asset key needs a row in assets.csv or it spawns at size 1, and
      // there is no second model to point it at anyway.
      bossShark: {
        separates: true,
        asset: 'enemyMegalodon', behavior: 'hunt', faceMotion: true,
        radius: 2.2, hp: 600, hpPerDifficulty: 40, speed: 5.2,
        contactDamage: 50, xp: 120, turnRate: 1.4,
        // Slower to turn and wider-ranging than the megalodon it is built from:
        // a boss should be something you kite, and the counterplay to a body
        // this size is the same as the counterplay to every shark — circle
        // inside its arc.
        hunt: { preyRadius: 26, biteRange: 3.0, biteCooldown: 1.5, healPerMeal: 18, maxOverheal: 1.3, growPerMeal: 0, maxGrow: 1, wanderChange: 2.6,
                lateral: { climbRange: 20, climbFull: 8, climbFloor: 0.1, climbEase: 0.55, weavePeriod: 9, weaveLead: 11, weaveAmp: 3.6, weaveBody: 0.07, wanderPitch: 0.1 } },
        weight: 0, spawnRateMul: 0, maxConcurrent: 1,
        spawnGroup: 'apex shark',
    },

      // --- seabed dwellers ---
      // The crab layer's mainstay, and the one crabSpawner pulls from when a
      // pickup pile draws a swarm.
      //
      // `radius` is deliberately BELOW the half-width its model would suggest.
      // It is a sphere radius doing two jobs at once: the collision reach, and —
      // via clampBelowSurface — how high off the seabed the body rests. This
      // crab's silhouette is 2.80 wide by only 0.93 tall, so a radius that
      // matched its width would park it half a unit up in the water, visibly
      // hovering. 0.8 keeps it near the sand (0.34 clearance, against the
      // hermit crab's old 0.13) while staying a fair target to shoot at.
      walkingCrab: {
        // No `separates`: that soft shove keeps bodies (rA+rB)*gap apart, which
        // is further than the collision contact distance, so it would hold
        // crabs apart and CONFIG.crabPhysics would never fire. Contact between
        // crabs is resolved properly instead — see resolveCrabCollisions.
        // Broadside to camera, walking sideways — see the faceCamera block in
        // entities/enemies.js. gaitTravel -1: this model's authored cycle
        // carries it toward its own -X (measured from the swing/stance split of
        // the foot bones), so it plays forward when walking screen-left and
        // reversed when walking screen-right.
        asset: 'enemyWalkingCrab', behavior: 'crawl', faceCamera: true, gaitTravel: -1,
        collides: true, // real crab-vs-crab knockback, see CONFIG.crabPhysics
        radius: 0.8, hp: 34, hpPerDifficulty: 4, speed: 3, speedVariance: 0.6,
        contactDamage: 12, xp: 9,
        // --- crowd variation -----------------------------------------------
        // A swarm of identical crabs at identical depth reads as one repeated
        // sprite. These three break that up without touching the behaviour, and
        // every one of them is a MULTIPLE of something the creature already
        // carries rather than a hand-typed world offset, so they survive the
        // Look panel's size slider (see CONFIG.trails' note on the mussel).
        //
        // Size: +/- this fraction of the crab's spawn scale, rolled once per
        // individual. The hitbox follows the visual (see spawnOne), so a bigger
        // crab is genuinely a bigger target and shoulders smaller ones aside —
        // mass in CONFIG.crabPhysics goes as radius squared.
        scaleVariance: 0.16,
        // Depth: how far in front of / behind the play plane a crab may sit, as
        // a MULTIPLE OF ITS OWN RADIUS. The camera is orthographic, so this
        // changes what occludes what and nothing else — no perspective scaling
        // to fight with. Crabs further apart in z than `depthContact` allows
        // simply pass each other, which is what turns a queue at the pile into a
        // crowd with a front row and a back one.
        //
        // A multiple, not world units, and this one bites HARD if you get it
        // wrong: the crab ships a Look-panel sizeMultiplier of 2.42, so its real
        // radius in play is ~1.94 against the 0.8 written above. A hand-typed
        // spread of "0.85 units" reads as ±0.85 against bodies four units wide —
        // invisible, and never enough to clear the `depthContact` threshold, so
        // the lanes would silently do nothing at all.
        // Sized against `crabPhysics.depthContact`: the two together decide what
        // fraction of the crowd walks past each other rather than into each
        // other. At +/-1.4 radii and a 1.2-radius contact depth, about a third of
        // random pairs are decoupled — enough that the crowd visibly has a front
        // and a back, with the other two thirds still shouldering (and climbing)
        // so the heap still forms. Turning this up much further stops crabs
        // interacting at all; the seabed backdrop sits at z -4.4, which is the
        // hard limit either way.
        depthSpread: 1.4,
        // Rest pose jitter, radians, +/- per individual. `restLean` tips the
        // whole body off vertical (it rides under the collision tumble, which
        // springs back to this angle rather than to zero); `restYaw` turns it
        // off-camera about its own up axis. Both stay small: past ~0.3 the
        // sideways walk cycle starts to read as sliding.
        restLean: 0.18,
        restYaw: 0.34,
        // Scaling over a run. Difficulty climbs 1.0 every 20s, so at the
        // 10-minute mark (difficulty 30) a fresh crab is 1.45x the size of a
        // minute-one crab, hits for 25 instead of 12 and moves at 4.2 instead
        // of 3. Growth is capped so a very long run doesn't turn the seabed
        // into a wall of crab — and since the hitbox is derived from the visual
        // scale, the cap holds the hitbox too.
        scalePerDifficulty: 0.015, maxGrowth: 1.6,
        contactDamagePerDifficulty: 0.45,
        speedPerDifficulty: 0.04,
        // March to the music: one footfall per beat at the crab's normal amble,
        // halving to two per beat when it rushes. Every option is a musical
        // subdivision, so footfalls always land on the grid whatever the speed.
        //
        // `strides` is how many steps this model's clip loop contains, and it
        // is a property of the FILE rather than of the crab — crabpincer.glb's
        // "Scene" is a single 0.48s stride, where the crabwalking.glb it
        // replaced packed 5 into a 3.33s take. Left at 5 it would stretch one
        // step across five beats and the crab would moonwalk.
        beatSync: { beatsPerStride: 1, strides: 1, subdivisions: [2, 1, 0.5, 0.25] },
        crawl: {
          aggroRadius: 12, wanderChange: 2.5, groundHeight: 2.5,
          floorRushHeight: 10.5, // player within this height of the seabed triggers a rush
          rushAggroRadius: 999, // effectively "always chases" while rushing
          rushSpeedMul: 2.5,
          // Feeding on the pile. Ranks BELOW chasing you: a crab that can see
          // you comes for you, and only goes back to the chum once you leave.
          // That makes diving down the way to interrupt a feed — at the cost of
          // standing in the middle of the swarm you just interrupted.
          feed: {
            // Arena-wide on purpose. A crab walking on from the wings has to be
            // able to SEE the pile it is coming for, and the arena is ~92 units
            // across; a short radius left them wandering at the edge. Which
            // pile wins is decided by `distanceBias` below, not by clipping the
            // search — that's what makes it "biggest OR nearest" rather than
            // just nearest.
            seekRadius: 120,
            eatRange: 1.1, // close enough to start chewing
            eatTime: 2.2, // seconds of uninterrupted chewing to destroy one orb
            reacquire: 0.4, // seconds between target re-picks (not every frame)
            // Distance at which a pile's pull halves. Small = parochial, crabs
            // grab whatever is underfoot; large = they commit to the big heap
            // across the map. A 14-orb pile 79 units away outscores a 3-orb
            // pile 20 units away at this value.
            distanceBias: 18,
            // THE HOOVER. Without this an orb being eaten only shrank in place,
            // which is indistinguishable from one despawning — nothing on screen
            // said a crab was taking it. Now the orb is dragged into the mouth
            // for the whole meal, so the eating is the visible event and the
            // shrink is just the last of it going down.
            hoover: {
              // How fast the orb closes on the mouth, as a FRACTION of the gap
              // per second (exponential, framerate-independent). It never quite
              // arrives, which is the point: the orb hangs at the lips being
              // worried at rather than snapping to a point and sitting still.
              pull: 5.5,
              // Mouth position, as multiples of the eater's own radius: forward
              // along the way it is walking, and down toward the mouthparts.
              //
              // A crab's mouth is low and central, at the front underside of the
              // shell. The body's half-height is ~0.58 of its radius (a 2.80 x
              // 0.93 silhouette against a radius describing its WIDTH), so -0.5
              // is just inside the bottom edge — which is also about where a
              // settled orb is already lying, so the pull reads as the orb being
              // drawn in under the crab rather than lifted up into it.
              mouthForward: 0.35,
              mouthRise: -0.5,
              // Crumbs. `crumbRate` is bursts per second while feeding; the
              // whole point is a trickle, so this is slow enough that one crab
              // reads as nibbling and six read as a swarm stripping the floor.
              crumbRate: 4,
            },
            // Crabs park on the orb and chew. A shark does not — see the note on
            // `hold` where updateEnemies reads it.
            hold: true,
          },
          // THE PILE-ON. While the seal is dead the crabs drop everything, come
          // for the body from wherever they are, and — because they now stack
          // (CONFIG.crabPhysics) — climb onto it and onto each other instead of
          // forming a ring around it. Nothing here damages anything: the run is
          // already over, this is the last thing you watch.
          corpse: {
            // Chasing a corpse is faster than chasing a live seal. It cannot
            // fight back or swim away, and the pile has to actually form inside
            // the few seconds the death dive lasts.
            speedMul: 2.2,
            // Stop steering in once this close, in multiples of the crab's own
            // radius, and let the collisions do the rest. Without a stop every
            // crab drives at the same point forever and the pile jitters as the
            // contact impulses fight the steering.
            settleRange: 1.6,
          },
        },
        weight: 0.35, weightPerDifficulty: 0.03, maxWeight: 0.6, maxConcurrent: 10, minDifficulty: 0.4,
    },

      // THE SAME CRAB, AFTER DARK. A different shell and a harder stat line;
      // everything about how it walks, feeds, rushes and piles onto a corpse is
      // literally the walking crab's, shared by reference rather than copied —
      // see the note at linkCrabVariants near applyEnemiesFromTable. That is
      // deliberately unlike abyssShark and lanternRay, which each carry a full
      // duplicate of their parent's behaviour block: those blocks are a dozen
      // lines and the crab's is seventy, and seventy lines of feeding tuning
      // maintained in two places would be wrong within a week.
      //
      // WHICH ONE SPAWNS IS NOT DECIDED HERE, and not by a knob either. Crabs
      // do not come from the weighted pool at all (both rows ship
      // spawnRateMul 0) — systems/crabSpawner.js summons them, and it splits
      // between the family by each row's `bioluminescent` column against
      // CONFIG.spawn.nightlife, which is the same changeover rule the rest of
      // the roster uses. enemies.csv is the whole story.
      emberCrab: {
        asset: 'enemyEmberCrab', behavior: 'crawl', faceCamera: true, gaitTravel: -1,
        collides: true,
        bioluminescent: true, // held back until the sun is down — enemies.csv owns this
        // Balance lives in enemies.csv. The values here are the built-in
        // fallback for a row that goes missing, and are what the CSV's
        // emberCrab line currently restates.
        radius: 0.8, hp: 44, hpPerDifficulty: 9, speed: 3.2, speedVariance: 0.6,
        contactDamage: 15, xp: 14,
        scalePerDifficulty: 0.015, maxGrowth: 1.6,
        contactDamagePerDifficulty: 0.5,
        speedPerDifficulty: 0.04,
        // Crowd variation, same reasoning as the day crab's — these are facts
        // about the model, which is the same model, so they are the same
        // numbers.
        scaleVariance: 0.16,
        depthSpread: 1.4,
        restLean: 0.18,
        restYaw: 0.34,
        weight: 0.35, weightPerDifficulty: 0.03, maxWeight: 0.6, maxConcurrent: 10, minDifficulty: 1.5,
        spawnGroup: 'crab',
    },
      // --- new creatures -------------------------------------------------------
      // Eats far more than any other hunter — a huge prey radius, a short bite
      // cooldown and a big heal per meal. Left alone in a school it snowballs,
      // so it's a "deal with this now" threat rather than a slow grind.
      orca: {
        separates: true,
        asset: 'enemyOrca', behavior: 'hunt', faceMotion: true,
        radius: 1.8, hp: 260, hpPerDifficulty: 16,
        speed: 6.2, speedVariance: 0.8, contactDamage: 34, xp: 45, turnRate: 2,
        // The orca used to be the roster's runaway: a 0.45s bite (three times
        // faster than any other apex), a 34-unit prey radius that covers most of
        // the arena, and 3.5% growth per meal up to 1.6x. Those numbers
        // multiplied out to a pod that hit maximum size roughly EIGHT SECONDS
        // after arriving — every orca a player ever saw was already the biggest
        // it could be, which read as "orcas scale absurdly" when nothing about
        // the difficulty curve was involved at all. Now in line with the other
        // apex feeders: still the fastest eater and the widest hunter of them,
        // by a nose rather than by a factor of three.
        hunt: { preyRadius: 24, biteRange: 2.2, biteCooldown: 1.0, healPerMeal: 16,
                maxOverheal: 1.6, growPerMeal: 0.02, maxGrow: 1.3, wanderChange: 2 },
        weight: 0.05, weightPerDifficulty: 0.02, maxWeight: 0.22,
        maxConcurrent: 2, minDifficulty: 2.2, spawnRateMul: 1, minPlayerLevel: 5,
        spawnGroup: 'apex',
    },

      // Faster than a shark and leaves the water on a timer — `canBreach` lets
      // it above the surface, and `porpoise` does the ballistic arc.
      dolphin: {
        separates: true, canBreach: true,
        asset: 'enemyDolphin', behavior: 'porpoise', faceMotion: true,
        radius: 0.85, hp: 44, hpPerDifficulty: 4,
        speed: 10.5, speedVariance: 1.5, contactDamage: 18, xp: 16, turnRate: 3.6,
        hunt: { preyRadius: 16, biteRange: 1.3, biteCooldown: 0.8, healPerMeal: 6,
                maxOverheal: 1.4, growPerMeal: 0.02, maxGrow: 1.25, wanderChange: 1.5 },
        // No `gravity` of its own — the arc is arena.gravity's, like every
        // other body in the air. `launchSpeedY` is what sets how high it goes.
        porpoise: { interval: 6, launchSpeedX: 9, launchSpeedY: 17, launchDepth: 6 },
        weight: 0.12, weightPerDifficulty: 0.025, maxWeight: 0.4,
        maxConcurrent: 4, minDifficulty: 1, spawnRateMul: 1, minPlayerLevel: 3,
        // Grouped with the sharks as a whale, on the reading that "sharks and
        // whales" is about big rigged bodies competing for screen. It is by far
        // the lightest of them, though, so if the apex allowance starts feeling
        // like it's spent on dolphins, this is the tag to drop first.
        spawnGroup: 'apex',
    },

      // Cruises a band above the seabed. Traffic to swim around while you farm
      // the floor, not a pursuer.
      stingray: {
        asset: 'enemyStingray', behavior: 'glide', faceMotion: true,
        radius: 0.7, hp: 30, hpPerDifficulty: 2.5,
        speed: 5, speedVariance: 1.2, contactDamage: 14, xp: 10,
        glide: { height: 8, bandSpread: 3 },
        weight: 0.25, weightPerDifficulty: 0.02, maxWeight: 0.5,
        maxConcurrent: 8, minDifficulty: 0.4, spawnRateMul: 1, minPlayerLevel: 2,
    },

      // The ray in its glowing variant. Same glide behaviour and the same
      // shape in the water; what differs is that it arrives later, alone, and
      // carries the marble preset across a wingspan wide enough to show it.
      lanternRay: {
        asset: 'enemyLanternRay', behavior: 'glide', faceMotion: true,
        radius: 0.7, hp: 34, hpPerDifficulty: 2.8,
        speed: 4.6, speedVariance: 1.0, contactDamage: 14, xp: 14,
        // Deeper band than the ordinary ray's 8 — this one belongs to the
        // dark part of the column, which is also where its glow reads.
        glide: { height: 14, bandSpread: 4 },
        weight: 0.16, weightPerDifficulty: 0.015, maxWeight: 0.35,
        maxConcurrent: 4, minDifficulty: 2.5, spawnRateMul: 1, minPlayerLevel: 3,
      },

      // Unkillable by construction rather than by a special case: an HP pool
      // nothing in the game can chew through. That keeps every damage source
      // (bullets, garlic, strike, seal team) working normally with no
      // invulnerability flag to thread through all of them. xp 0 so it would
      // award nothing even if something did finish it.
      //
      // Which is what makes it the one creature worth SIMULATING. Nothing else
      // survives long enough to be a physics prop; this one is around all run,
      // so `rigidBody` gives it a real body (see systems/rigidBody.js) and the
      // seal's strike stops being damage it shrugs off and becomes a shot from
      // a cannon. Named rather than a boolean: the string picks which profile
      // under CONFIG.physics the body is built from.
      seaTurtle: {
        separates: true, rigidBody: 'turtle',
        asset: 'enemySeaTurtle', behavior: 'drift', faceMotion: true,
        radius: 1, hp: 1e9, hpPerDifficulty: 0,
        speed: 1.6, speedVariance: 0.4, contactDamage: 8, xp: 0,
        // `stay` is the whole reason a turtle can be common now. It cannot be
        // killed, so it has no other way of leaving: every one that ever
        // wandered in used to still be there at minute ten, holding a slot in
        // the population budget forever. It visits for about half a minute
        // instead and then makes for open water — which is also the only exit
        // an animal nothing in the game can hurt would ever take.
        //
        // The clock stops while it is mid-punt (see BEHAVIORS.drift), so the
        // one you are currently playing with never vanishes on you.
        drift: { wanderChange: 4, stay: 30, stayJitter: 8, exitSpeed: 3 },
        weight: 0.12, weightPerDifficulty: 0, maxWeight: 0.12,
        maxConcurrent: 3, minDifficulty: 0.6, spawnRateMul: 1, minPlayerLevel: 2,
    },

      // Glass cannon: hits harder than a shark, dies to almost anything.
      barracuda: {
        asset: 'enemyBarracuda', behavior: 'chase', faceMotion: true,
        radius: 0.45, hp: 10, hpPerDifficulty: 1,
        speed: 9, speedVariance: 2, contactDamage: 32, xp: 8,
        weight: 0.3, weightPerDifficulty: 0.03, maxWeight: 0.6,
        maxConcurrent: 12, minDifficulty: 0.8, spawnRateMul: 1, minPlayerLevel: 3,
    },

      // Squid. A straight chaser, deliberately — it is the roster's plainest
      // behaviour and that is the point, because the ASSET cannot carry any
      // other kind. The model is a static mesh: no bones exist for it and none
      // can (see enemySquid in assets.js), so its arms are frozen in one pose
      // forever. That pose happens to be a good one — arms gathered and
      // trailing, the shape a squid holds while it is actually swimming — which
      // means the one thing this creature must never do is hold still. Moving
      // nose-first it reads as a swimming animal; stopped, it reads as a
      // statue. `chase` is the behaviour that never stops.
      //
      // Slotted between the barracuda and the stingray in threat: tougher and
      // slower than the barracuda, hits for less, and worth a little more. It
      // arrives at the same time as the ray so the mid-game has a pursuer
      // alongside the traffic rather than only traffic.
      squid: {
        separates: true, // a big arm spread looks wrong overlapping itself
        asset: 'enemySquid', behavior: 'chase', faceMotion: true,
        radius: 0.55, hp: 24, hpPerDifficulty: 2.2,
        speed: 6.4, speedVariance: 1.2, contactDamage: 16, xp: 9,
        // Arcs rather than pivoting. A squid that spun on the spot would swing
        // its whole 1.7-unit arm trail around like a rigid board — the turn
        // has to be slow enough that the silhouette sweeps instead of snapping.
        turnRate: 2.2,
        weight: 0.24, weightPerDifficulty: 0.025, maxWeight: 0.45,
        // maxConcurrent IS THE NIGHT BUDGET, not just a crowd limit, and this
        // one is held at 5 for that reason rather than for pacing. The arena
        // sits at its maxAlive ceiling most of a run, so any untagged creature
        // occupies its full headcount after dark no matter how far
        // nightlife.daylight suppresses its spawn RATE — a slow trickle still
        // accumulates to the cap over three minutes, and every body it holds is
        // one the glowing roster is not filling. Measured: at 10 this creature
        // alone took the glowing share of bodies from 64% to 51%, one point off
        // failing the majority assertion in tools/nightlife-test.mjs. At 5 it
        // costs about half that. Raise it and re-run `npm run test:nightlife`.
        maxConcurrent: 5, minDifficulty: 0.7, spawnRateMul: 1, minPlayerLevel: 2,
    },

      // Sits on the seabed and does nothing until killed, then drops a pearl
      // bomb — a big radius blast that clears the crab layer around it. Slow to
      // kill on purpose, so popping one is a decision rather than incidental.
      oyster: {
        floorSpawn: true,
        asset: 'enemyOyster', behavior: 'trap', faceMotion: false,
        radius: 0.6, hp: 40, hpPerDifficulty: 3,
        speed: 0, speedVariance: 0, contactDamage: 0, xp: 12,
        trap: { range: 0, cooldown: 999 },
        deathBlast: { radius: 9, damage: 90 },
        weight: 0.2, weightPerDifficulty: 0.015, maxWeight: 0.4,
        maxConcurrent: 6, minDifficulty: 0.5, spawnRateMul: 1, minPlayerLevel: 2,
    },

    },

    // ---------------------------------------------------------------------------
    // GRID — the Geometry Wars backdrop. Nodes are pushed around by ripples that
    // the game fires off, plus a constant pull from the player's wake.
    // ---------------------------------------------------------------------------
    grid: {
      enabled: true,
      // 'square' or 'hex'. Purely the shape of the lines — the ripple/wake warp
      // is a vertex shader that displaces whatever nodes exist, so both patterns
      // spring identically. 'hex' is flat-top and matches the level-up card art.
      pattern: 'square',
      // Cut the grid off at the water line so it reads as something in the water
      // rather than a backdrop behind everything. The cut follows the animated
      // wave, not a flat y=0, and it happens per-fragment AFTER the ripple warp —
      // so a ripple that throws a line into the air gets clipped along with it.
      clipAtSurface: true,
      spacing: 2.6, // world units between nodes; in hex it's the flat-to-flat height
      subdivisions: 4, // segments per span; higher = curvier warps
      lineWidth: 1,
      opacity: 0.55,
      color: 0x1d4b73,
      hotColor: 0x7fe9ff,
      warpGain: 1.5, // how bright a warped line gets
      maxRipples: 24, // ring buffer; oldest is recycled
      rippleDecay: 2.6, // higher = snaps back faster
      rippleFreq: 9.0, // ripple oscillation speed
      rippleWavelength: 1.4,
      wakeRadius: 7,
      wakeStrength: -0.55, // negative = grid sucks inward toward the ship
      wakeSpeedGain: 0.02, // extra pull proportional to ship speed

      // TOUCH GLOW — what the player's fingers do to the lattice on a phone.
      // Every contact on the canvas gets a slot (see TOUCH_SLOTS in input.js),
      // and each slot shoves the grid around AND lights it with a colour of its
      // own, so a hand on the glass tears five holes in the backdrop rather
      // than one anonymous smudge.
      //
      // THE MULTICOLOUR HERE IS DELIBERATE, and the one place in the game it
      // is. The rule everywhere else — see the note above `emitters` — is one
      // colour family per effect, because a burst tinted per creature stops
      // telling you anything. This is the opposite case: the colour is the only
      // thing that says WHICH FINGER, which is exactly the information a
      // multitouch flourish has to convey. The ramp still escalates in heat
      // rather than picking five unrelated hues.
      touchGlow: {
        enabled: true,
        radius: 6.0,  // world units the first finger reaches; scaled per finger
        // How bright the finger's colour burns at the core. Kept near 1 for a
        // reason: the composite is LDR, so colour * gain * power clips at 1 and
        // anything much over it lands as white. Push this up and the fingers
        // stop being TELLABLE APART, which is the one thing they're for — the
        // fifth finger already spends its 1.5x power on a white-hot core, and
        // that's meant to be the top of the range rather than where all five
        // sit. Brightness lives in `alpha` instead, which doesn't cost hue.
        gain: 1.15,
        alpha: 0.5,   // extra opacity at the core, on top of grid.opacity
        push: 0.5,    // outward shove on the lattice nodes
        swirl: 0.4,   // rotational shear — what makes it read as DISRUPTION
        wave: 1.1,    // spatial frequency of the shove, so it ripples outward
        spin: 2.2,    // how fast that ripple churns
        attack: 16,   // per-second rate the glow rises at when a finger lands
        release: 5,   // and falls at when it lifts. Slower, so it trails off

        // THE KNOCK. A finger landing punches the lattice and lets it spring
        // back. This is not a second warp system — it pushes into the very same
        // ripple ring buffer every kill, splash and explosion uses, so it
        // oscillates and snaps back on `rippleDecay` along with all of them and
        // costs nothing extra to draw. The sustained push/swirl above is what
        // holds the hole open while the finger sits there; this is the WATER
        // MOVING when it arrives and when it goes.
        ripple: {
          strength: 1.4,
          radius: 5.0,
          liftScale: 0.55, // the smaller knock as the finger comes off again
        },

        // THE CHARGE. A finger winding up a strike — the third-finger press, or
        // a double-tap-and-hold thumb — doesn't just sit there glowing. It
        // GROWS with the meter and throws a ripple outward on a beat that
        // tightens as it fills, so the wind-up is visible in the backdrop
        // instead of only in the HUD. Progress is strikeState.pending, the same
        // 0..1 the dash spends on release, so the grid can never disagree with
        // the strike about how hard it was charged.
        // Sized against a PORTRAIT PHONE, which is the only place any of this
        // runs: the arena is ~50 tall there but only ~23 across, so reach is
        // spent against the narrow axis. At `grow` 0.8 the third finger ends a
        // full wind-up about half the screen wide, which is a crescendo. Past
        // ~1.5 it stops being a finger and becomes a full-screen wash — that is
        // the first slider to pull back if a charge starts drowning the fight.
        charge: {
          grow: 0.8,          // extra reach at full charge, as a fraction
          power: 0.6,         // extra brightness and shove at full charge
          pulseAt: 0.46,      // seconds between pulses at the start of a charge
          pulseAtFull: 0.13,  // ...and once it's full. The beat tightening IS
                              // the tell that something is about to happen.
                              // Note these go into the same 24-slot ring buffer
                              // as combat, so a full-tilt wind-up spends about a
                              // third of it per second — fine at this cadence,
                              // and the reason not to drop it much below 0.1
          pulseStrength: 1.1, // at full charge; scaled down early on
          pulseRadius: 7.0,
        },
        // In order of arrival: finger 0 is whoever touched down first. `power`
        // and `spread` scale gain/push/swirl and radius respectively, so the
        // fifth finger is a bigger event than the first — a full hand slapped
        // on the screen should look like one.
        fingers: [
          { color: 0x7fe9ff, power: 1.0, spread: 1.0 },  // the grid's own hot cyan
          { color: 0x4dffc3, power: 1.1, spread: 1.05 }, // aqua
          { color: 0xffe071, power: 1.2, spread: 1.1 },  // gold
          { color: 0xff7ad9, power: 1.35, spread: 1.15 },// hot pink
          { color: 0xb98cff, power: 1.5, spread: 1.25 }, // violet
        ],
      },
    },

    // ---------------------------------------------------------------------------
    // EMITTERS — named particle bursts. Reference these from `feedback` below.
    // speed/size/life are [min, max] ranges. cone = 0 means a full circle.
    //
    // ONE COLOUR FAMILY PER EMITTER. `colors` is a list so a burst can have
    // depth — a hot core, a mid, a white — not so it can have variety. Two hues
    // that aren't neighbours in the same ramp put a rainbow on the screen, and a
    // screen where every burst is multicoloured is a screen where colour has
    // stopped telling you anything about what just happened. If a burst needs to
    // read as different, change its SHAPE: count, speed, size, life, drag.
    //
    // There is deliberately no way for a caller to pass a colour in (see
    // entities/particles.js). Bursts tinted per creature were how the rainbow got
    // in last time.
    //
    // `turbulence` scales how hard the global current (CONFIG.fx.turbulence)
    // takes this emitter's particles. 1 unless there's a reason.
    // ---------------------------------------------------------------------------
    emitters: {
      muzzle: {
        count: 10, speed: [6, 16], size: [0.09, 0.2], life: [0.12, 0.3],
        colors: [0xbfefff, 0xffffff, 0x7ad7ff], cone: 0.5, drag: 3.5,
        gravity: [0, 0], inherit: 0.2, glow: 1.4,
    },
      boost: {
        count: 14, speed: [3, 10], size: [0.12, 0.3], life: [0.3, 0.7],
        colors: [0x2effea, 0x7ad7ff, 0xffffff], cone: 0.9, drag: 2.2,
        gravity: [0, 1.2], inherit: 0.1, glow: 1.6,
    },
      sparks: {
        count: 12, speed: [7, 20], size: [0.07, 0.16], life: [0.15, 0.4],
        colors: [0xffe066, 0xffffff, 0xff9f4d], cone: 1.2, drag: 4,
        gravity: [0, -1], inherit: 0.3, glow: 1.8,
    },

      // --- Glow Up! (one per element) ------------------------------------------
      // Four presets rather than one preset tinted per call, because a burst's
      // colour is the EMITTER's here — feedback() deliberately takes no `color`
      // (see systems/feedback.js). That rule is what keeps particle colour
      // authored in one place instead of decided by whichever system happened to
      // fire the event, and the element is no reason to break it.
      //
      // All four are small: they land on top of `bulletHit`, which has already
      // fired for the same pellet on the same frame. Half the count of `sparks`
      // and a shorter life, so the element decorates the impact rather than
      // doubling it.
      elementShock: {
        count: 8, speed: [9, 24], size: [0.05, 0.13], life: [0.1, 0.26],
        colors: [0x9fe8ff, 0xffffff, 0x6fd0ff], cone: 1.6, drag: 5,
        gravity: [0, 0], inherit: 0.3, glow: 2.6,
    },
      elementVenom: {
        // Slower and heavier than the rest — venom should look like it drips
        // off the fish rather than spraying off it.
        count: 9, speed: [2, 8], size: [0.07, 0.17], life: [0.3, 0.7],
        colors: [0x7dff3d, 0xc6ff9e, 0x3aa81f], cone: 0, drag: 2.6,
        gravity: [0, -2.2], inherit: 0.2, glow: 2.0,
    },
      elementChill: {
        count: 10, speed: [3, 11], size: [0.06, 0.15], life: [0.25, 0.6],
        colors: [0xbdf5ff, 0xffffff, 0x7fd8ff], cone: 0, drag: 4.5,
        gravity: [0, -0.4], inherit: 0.15, glow: 2.2,
    },
      elementInfection: {
        // The pixels. Deliberately near-uniform in size and long-lived, so a
        // burst reads as a cloud of points hanging around the fish rather than
        // as a spray leaving it — the same look the orbiting motes carry, which
        // is what ties the impact to the contagion that follows it.
        count: 12, speed: [1.5, 6], size: [0.07, 0.1], life: [0.4, 0.9],
        colors: [0x66ff9e, 0xd6ffe8, 0x1fbf6b], cone: 0, drag: 3.2,
        gravity: [0, 0.3], inherit: 0.15, glow: 2.8,
    },
      explosion: {
        count: 46, speed: [4, 24], size: [0.1, 0.34], life: [0.35, 0.9],
        colors: [0xff4d6d, 0xffb347, 0xffe066, 0xffffff], cone: 0, drag: 2.2,
        gravity: [0, -1.4], inherit: 0.2, glow: 2.2,
    },
      // Same fire ramp as `explosion`, bigger and longer. The purple that used
      // to sit second in this list was the loudest rainbow in the game — a
      // magenta flash in the middle of an orange blast, on the single most
      // frequent big event there is. It reads as bigger WITHOUT it, because
      // nothing in the burst is competing with the core any more.
      bigExplosion: {
        count: 110, speed: [5, 34], size: [0.14, 0.5], life: [0.5, 1.3],
        colors: [0xff4d6d, 0xff7a3d, 0xffb347, 0xffffff], cone: 0, drag: 1.8,
        gravity: [0, -1.2], inherit: 0.15, glow: 3.5,
    },
      bite: {
        count: 26, speed: [3, 14], size: [0.1, 0.28], life: [0.3, 0.8],
        colors: [0xff5566, 0xff8899, 0xffd0d8], cone: 0, drag: 2.4,
        gravity: [0, -0.8], inherit: 0.2, glow: 1.5,
    },
      pickup: {
        count: 10, speed: [2, 7], size: [0.08, 0.18], life: [0.25, 0.5],
        colors: [0x8effa1, 0xd6ffe2, 0xffffff], cone: 0, drag: 3,
        gravity: [0, 1.5], inherit: 0, glow: 1.3,
    },
      playerHit: {
        count: 30, speed: [4, 16], size: [0.12, 0.3], life: [0.3, 0.7],
        colors: [0xff3355, 0xff8899, 0xffffff], cone: 0, drag: 2.6,
        gravity: [0, 0], inherit: 0.2, glow: 2.0,
    },
      splash: {
        count: 34, speed: [4, 15], size: [0.1, 0.3], life: [0.4, 1.0],
        colors: [0x9fe8ff, 0xffffff, 0x6fd3ff], cone: 1.1, drag: 1.4,
        gravity: [0, -14], inherit: 0.35, glow: 1.0,
    },
      bounce: {
        count: 10, speed: [3, 10], size: [0.08, 0.2], life: [0.2, 0.45],
        colors: [0x6fd3ff, 0xffffff], cone: 1.4, drag: 3, gravity: [0, 0], inherit: 0.2, glow: 1.2,
    },
      // One raindrop hitting the water. Fires hundreds of times a second in a
      // storm, so it is the smallest burst in the table by a distance — three
      // specks, barely alive, no glow to speak of. The volume is the effect;
      // any one of these being visible on its own would be too much.
      rainSplash: {
        count: 3, speed: [1.5, 4.5], size: [0.05, 0.12], life: [0.12, 0.3],
        colors: [0xbfe4ff, 0xffffff], cone: 0.9, drag: 3.2,
        gravity: [0, -9], inherit: 0.15, glow: 0.8,
    },
      // A bolt hitting the sea: a hard vertical column of steam and spray,
      // thrown straight up. Narrow cone and high speed, because the energy came
      // from directly overhead and went straight down.
      lightningHit: {
        count: 40, speed: [10, 30], size: [0.1, 0.4], life: [0.3, 0.8],
        colors: [0xffffff, 0xdce8ff, 0x9fd0ff], cone: 0.45, drag: 2.0,
        gravity: [0, -12], inherit: 0, glow: 2.6,
    },
      // Was cyan + green + yellow + white, which is three unrelated hues and
      // the closest thing in the table to literal confetti. One cool ramp
      // instead: the level-up already owns the whole screen for a moment
      // (time dilation, the cards, the sound), so the particles only have to
      // be bright, not busy.
      levelUp: {
        count: 80, speed: [6, 20], size: [0.12, 0.36], life: [0.6, 1.2],
        colors: [0x7ad7ff, 0xbfefff, 0xffffff], cone: 0, drag: 1.6,
        gravity: [0, 1], inherit: 0, glow: 2.8,
    },
      // THE TWO SKY BURSTS — a seal coming out the far side of the sun or the
      // moon (see CONFIG.dayNight.pass). Both are authored for AIR, which is
      // the one place no other emitter in this table fires: negative gravity is
      // a spray falling back into the sea, and these should hang and rise, so
      // the gravity is positive and the drag is low enough to let them travel.
      // Long lives for the same reason — up there, nothing is going to be in
      // front of them a tenth of a second later.
      sunPass: {
        count: 90, speed: [8, 26], size: [0.14, 0.42], life: [0.5, 1.4],
        colors: [0xffe9a8, 0xffc247, 0xffffff], cone: 0, drag: 1.5,
        gravity: [0, 0.8], inherit: 0.25, glow: 4.2,
    },
      // Cooler, sparser and slower than the sun's: the moon's whole character
      // in this game is that it is the quiet one, and matching the sun burst
      // for burst would delete the difference between passing through them.
      moonPass: {
        count: 60, speed: [5, 18], size: [0.10, 0.34], life: [0.7, 1.8],
        colors: [0xcfe2ff, 0x9fc8ff, 0xffffff], cone: 0, drag: 1.9,
        gravity: [0, 1.1], inherit: 0.2, glow: 3.4,
    },
      // Bubbles rise, so their gravity is POSITIVE — and low drag is what lets
      // them keep rising for their whole life instead of stalling a few frames
      // after they leave the seal. Modest glow: these are ambient, and at this
      // spawn rate anything brighter turns into a permanent haze around the
      // player.
      // `surfacePop` is the one emitter field the CPU acts on rather than the
      // GPU: entities/particles.js follows these particles and bursts them into
      // the named emitter the moment they break the water line, instead of
      // letting them drift on into the sky and fade. Any emitter can opt in; only
      // things that rise have a reason to.
      breathBubbles: {
        count: 4, speed: [0.6, 2.2], size: [0.07, 0.18], life: [0.9, 1.9],
        colors: [0xbfefff, 0xffffff, 0x9fe8ff], cone: 0.55, drag: 1.1,
        gravity: [0, 4.5], inherit: 0.2, glow: 1.0, surfacePop: 'bubbleBurst',
    },
      wakeBubbles: {
        count: 2, speed: [0.8, 3.0], size: [0.05, 0.14], life: [0.6, 1.4],
        colors: [0x9fe8ff, 0xdff6ff, 0xffffff], cone: 0.6, drag: 1.6,
        gravity: [0, 3.2], inherit: 0.3, glow: 0.9, surfacePop: 'bubbleBurst',
    },
      // What a bubble leaves behind at the water line. Small, fast and short —
      // the whole event is over in a third of a second, because a burst that
      // lingers reads as a splash, and a bubble is not big enough to splash.
      // Gravity is NEGATIVE here, the only bubble-ish emitter where it is: the
      // droplets are thrown into the air and fall straight back in.
      bubbleBurst: {
        count: 5, speed: [1.2, 3.4], size: [0.04, 0.09], life: [0.18, 0.34],
        colors: [0xdff6ff, 0xffffff, 0xbfefff], cone: 1.1, drag: 3.2,
        gravity: [0, -9], inherit: 0, glow: 1.1,
    },
      // A beluga bubble bursting on the fish it just caught. `cone: 0` is the
      // whole idea — a full circle, because a bubble that popped threw its skin
      // in every direction at once, and any cone at all would read as the
      // bubble having been SHOT rather than having burst. Small, many and
      // fast-braking: high drag stops them almost where they started, and only
      // then does the bubble gravity carry what's left upward, so the shape is
      // a ring that blooms and drifts rather than a spray that travels. Rides
      // the same rise-and-pop-at-the-surface path as every other bubble here.
      trapPop: {
        count: 20, speed: [2.0, 7.0], size: [0.04, 0.12], life: [0.4, 1.1],
        colors: [0xbfefff, 0xffffff, 0x9fe8ff], cone: 0, drag: 3.0,
        gravity: [0, 3.4], inherit: 0.1, glow: 1.6, surfacePop: 'bubbleBurst',
    },
      // Crumbs coming off an orb as it is being hoovered into a mouth. Fires
      // several times a second per feeding animal for as long as the meal lasts,
      // so it is deliberately tiny — the read is a steady trickle of bits being
      // pulled off the pile, not a burst. Gravity is POSITIVE and small so the
      // crumbs drift up out of the mouth like scraps a feeding animal misses.
      // Green family only — it matches `pickup`, which is the same substance
      // being collected rather than eaten. The yellow that used to be third in
      // the list was the odd one out of that pair.
      chumCrumbs: {
        count: 3, speed: [0.8, 3.2], size: [0.05, 0.13], life: [0.25, 0.6],
        colors: [0x8effa1, 0xd6ffe2, 0xffffff], cone: 0, drag: 3.4,
        gravity: [0, 1.6], inherit: 0.25, glow: 1.2,
    },
      // Seabed silt, kicked up when the dead seal lands on it. Everything here
      // is the opposite of an explosion: slow, wide, long-lived and barely
      // glowing, drifting up and settling back rather than bursting. Upward
      // cone, since the floor is what it came off.
      silt: {
        count: 40, speed: [1.5, 6], size: [0.3, 0.9], life: [1.4, 3.2],
        colors: [0x6b6350, 0x8a7f66, 0x4a4a44, 0x9aa3a0], cone: 1.5, drag: 2.6,
        gravity: [0, 0.5], inherit: 0.15, glow: 0.35,
    },
      // --- homing mussels -----------------------------------------------------
      // A much bigger, hotter version of `muzzle` — the shell leaves the flipper
      // as an event you can hear and see, not a quiet spawn. High inherit throws
      // the flash forward with the shot rather than leaving a ball hanging where
      // the fin was.
      missileLaunch: {
        count: 26, speed: [8, 26], size: [0.14, 0.36], life: [0.18, 0.45],
        colors: [0xfff1c9, 0xffb347, 0xff7a3d, 0xffffff], cone: 0.55, drag: 3.2,
        gravity: [0, -0.6], inherit: 0.45, glow: 3.2,
    },
      // Burning chips shed along the flight path — the bright trail behind a
      // shell that is itself black. Emitted per-second from the projectile
      // rather than as a burst (see CONFIG.trails.missile.particles), so `count`
      // here is how many chips come off at each emission, kept low because
      // they're constant rather than one-off. Near-zero drag and a slow
      // downward drift make them hang in the water and sink like embers instead
      // of shooting off sideways.
      missileTrail: {
        count: 2, speed: [0.3, 1.6], size: [0.08, 0.2], life: [0.4, 0.95],
        colors: [0xffd27a, 0xff8c42, 0xfff6e0], cone: 0, drag: 0.8,
        gravity: [0, -1.1], inherit: 0.08, glow: 3.6,
    },
      // The detonation. Fast and hard rather than big and slow: high speed,
      // heavy drag and a short life mean it throws out and stops almost at
      // once, which is what a shell going off looks like — `explosion` by
      // comparison is a body coming apart and drifting. The colours here are
      // only the fallback; a mussel that actually hit something passes the hit
      // creature's own colour through `opts.color` and this palette is unused
      // (see emit()).
      missileImpact: {
        count: 34, speed: [10, 34], size: [0.1, 0.34], life: [0.16, 0.42],
        colors: [0xffffff, 0xffe7b8, 0xff9f4d], cone: 0, drag: 5.5,
        gravity: [0, -1.0], inherit: 0.12, glow: 3.4,
    },
      // --- oyster blaster -----------------------------------------------------
      // A bomblet going off. White, and ONLY white — no warm tint, no cool
      // tint, nothing sampled from anything else. It borrowed `sparks` before,
      // which is a yellow-orange fire ramp, and a pearl throwing sparks reads
      // as ordnance; a pearl should throw light. The depth that a palette
      // usually supplies comes from the glow instead: every particle is the
      // same colour and blown well past white, so the crowded middle of the
      // burst blooms harder than its edges.
      pearlBurst: {
        count: 30, speed: [6, 22], size: [0.08, 0.26], life: [0.2, 0.5],
        colors: [0xffffff], cone: 0, drag: 4.5,
        gravity: [0, -0.8], inherit: 0.1, glow: 4.5,
    },
    },

    // ---------------------------------------------------------------------------
    // FEEDBACK — one entry per game event. Everything juicy is wired from here:
    // particles, screen shake, hit-stop, a grid ripple, a sound, and a haptic
    // buzz. Add a key here and call feedback('name', ...) to use it.
    // ---------------------------------------------------------------------------
    // `glow` on each event pushes feedbackState.glowPulse up temporarily (see
    // CONFIG.bloom.pulseStrength/pulseDecay), so every collision/impact makes
    // the whole screen's neon glow flash brighter for an instant.
    feedback: {
      shoot:     { emit: 'muzzle',      shake: 0.02, hitstop: 0,     glow: 0.15, ripple: { strength: 0.5, radius: 4 },   sfx: 'shoot',    haptic: [6] },
      // NOT the dash, despite the name and despite what this comment used to
      // say. The only thing that fires it is the WEAPON'S RECOIL — the exhaust
      // plume out the back of a shot, once per shot, whenever
      // `CONFIG.weapon.recoilEnabled` is on. The dash is `strike` below.
      //
      // Silent on purpose, and it has been since the day it shipped. Anything
      // audible here plays at the fire rate and on top of `shoot`, so it needs to
      // be a sound authored for that job — a whoosh borrowed from the dash lasts
      // seconds, stacks on itself and eats the voice budget within one burst.
      // The particles and the light rumble are the recoil's feedback; the sound
      // it shares is the shot's.
      boost:     { emit: 'boost',       shake: 0.03, hitstop: 0,     glow: 0.1,  ripple: { strength: 1.1, radius: 6 },   sfx: null,       haptic: [{ duration: 45, magnitude: 0.85 }, { duration: 70, magnitude: 0.3, delay: 0 }] },
      // `sfxMinGap` is what keeps the impact sound from thickening every time
      // you take Multishot. A volley lands all its pellets inside one frame, so
      // without it a six-pellet burst played six copies of `hit` stacked on top
      // of each other — the same sound, six times louder, for the same volley.
      // One frame's worth of hits is one impact; the sparks, shake and ripple
      // are untouched and still fire per pellet.
      bulletHit: { emit: 'sparks',      shake: 0.03, hitstop: 0,     glow: 0.25, ripple: { strength: 0.8, radius: 4 },   sfx: 'hit',      haptic: [10], sfxMinGap: 0.09 },
      // Was unthrottled, which is fine when kills are occasional and is not when
      // a volley clears a school: several kills land inside one frame and play
      // several copies of one sound stacked, which is the same smear `bulletHit`
      // has always guarded against. Shorter than bulletHit's gap on purpose — a
      // kill is rarer and worth hearing individually for longer.
      kill:      { emit: 'explosion',   shake: 0.22, hitstop: 0,     glow: 0.6,  ripple: { strength: 2.4, radius: 10 },  sfx: 'kill',     haptic: [18], sfxMinGap: 0.05 },
      bigKill:   { emit: 'bigExplosion',shake: 0.7,  hitstop: 0.07,  glow: 1.2,  ripple: { strength: 4.5, radius: 18 },  sfx: 'bigKill',  haptic: [30, 25, 45] },
      // A bolt landing on the water. The heaviest shake in the table — heavier
      // than bigKill — because unlike everything else here it is not something
      // the player did, and the only way an event with no input behind it reads
      // as YOUR problem is if it hits the frame harder than your own kills do.
      // No hitstop: freezing on a strike the player didn't cause reads as a
      // dropped frame rather than as impact.
      lightningStrike: { emit: 'lightningHit', shake: 0.85, hitstop: 0, glow: 1.6, ripple: { strength: 6, radius: 26 }, sfx: 'thunderCrack', haptic: [40, 30, 90] },
      // Sheet lightning, miles off: the sky and the mix, and nothing else. No
      // particles and no ripple — there is no bolt in the arena to have made
      // them, and a rumble that shook the water would give away that the strike
      // is imaginary.
      thunder:   { emit: null,          shake: 0.06, hitstop: 0,     glow: 0.35, sfx: 'thunderRumble', haptic: [{ duration: 90, magnitude: 0.25 }] },
      // Taking a hit. NEVER call this directly — it goes through
      // systems/playerDamageFx.js, which is what turns a damage number into
      // the `scale` below and fires the rim flash alongside it.
      //
      // `shake` is deliberately one of the SMALLEST numbers in this table,
      // well under a kill's, and that is not a mistake. It is multiplied by a
      // scale that runs from ~0.35 on a graze to 2.0 on a hit that takes half
      // the bar, so the useful thing is the RANGE, and the range only exists
      // below fx.maxShake — anything that reaches the ceiling on an ordinary
      // hit is a constant rattle with the scaling quietly clamped out of it.
      // At 0.07 the whole curve tops out around 0.14, which is subtle on its
      // own and unmistakable next to a graze.
      playerHit: { emit: 'playerHit',   shake: 0.07, hitstop: 0.06,  glow: 0.9,  ripple: { strength: 3.0, radius: 12 },  sfx: 'playerHit',haptic: [45] },
      // The player's own death, which until now fired `bigKill` — the sound and
      // the particles of killing something else, played at the moment you are the
      // thing that died. Same weight as bigKill deliberately (it is the biggest
      // single event in a run) but no hitstop: the death dive takes the frame
      // over on the very next tick and dilates time far harder than a hitstop
      // would, so one stacked on top of it just delays the dive's first frame.
      playerDeath: { emit: 'bigExplosion', shake: 1.0, hitstop: 0, glow: 1.4, ripple: { strength: 5.5, radius: 22 }, sfx: 'playerDeath',
                     haptic: [{ duration: 70, magnitude: 1 }, { duration: 120, magnitude: 0.45, delay: 60 }] },
      bite:      { emit: 'bite',        shake: 0.10, hitstop: 0,     glow: 0.35, ripple: { strength: 1.6, radius: 7 },   sfx: 'bite',     haptic: [14] },
      // A light tick, not nothing. Chum arrives constantly, so this is near the
      // bottom of the scale — but it IS the game's main reward loop, and it was
      // the only rewarding event in the table you couldn't feel at all.
      pickup:    { emit: 'pickup',      shake: 0.02, hitstop: 0,     glow: 0.2,  ripple: { strength: 0.35, radius: 3 },  sfx: 'pickup',   haptic: [{ duration: 12, magnitude: 0.22 }] },
      // A crab finishing an orb off the seabed. Deliberately quieter than
      // `pickup` and with no haptic: it happens away from the player, often
      // several at once, and a swarm stripping a pile should read as a steady
      // nibbling in the background rather than a rumble per orb. `sfxMinGap`
      // stops six crabs finishing on the same frame from stacking six copies.
      // Kept the lightest haptic in the table rather than none: a swarm
      // stripping your chum off the seabed is something you want to notice
      // WITHOUT it competing with the fight in front of you. The `sfxMinGap`
      // already collapses a pile-up, and the shared magnitude ceiling in
      // haptics.js stops a big crab wave from summing into a drone.
      chumEaten: { emit: 'bite',        shake: 0.04, hitstop: 0,     glow: 0.15, ripple: { strength: 0.7, radius: 4 },   sfx: 'bite',     haptic: [{ duration: 10, magnitude: 0.14 }], sfxMinGap: 0.12 },
      // The SUCK, as opposed to chumEaten's swallow. Fires repeatedly for as long
      // as an orb is being dragged into a mouth, which is why it carries no
      // shake, no ripple, no haptic and — the one that isn't obvious — no glow
      // either. The pulse decays at CONFIG.bloom.pulseDecay, so a value here
      // wouldn't read as a pulse at all: a feeding swarm re-adds it faster than
      // it falls and the whole screen just sits brighter for as long as anything
      // is eating. The crumbs carry their own overdrive; that is the brightness.
      // The sound is throttled hard for the same reason the rest is empty — a
      // seabed full of feeding crabs would otherwise be one continuous hiss.
      chumHoover: { emit: 'chumCrumbs', shake: 0,    hitstop: 0,                                                          sfx: 'chumSlurp', sfxMinGap: 0.4 },
      levelUp:   { emit: 'levelUp',     shake: 0.4,  hitstop: 0,     glow: 0.8,  ripple: { strength: 3.5, radius: 22 },  sfx: 'levelUp',  haptic: [20, 40, 20] },

      // --- the interface --------------------------------------------------------
      // The two events in this table with no place in the world. Everything else
      // here happens AT somewhere and throws particles, shakes the camera or
      // ripples the grid at that point; a menu is not in the water, so all of
      // that is deliberately empty. Fired through this table anyway rather than
      // as a bare playSfx, so the menus get the same throttle, the same haptics
      // and the same line in the 0 overlay as everything else.
      //
      // The hover's `sfxMinGap` is not about pile-ups the way the gameplay ones
      // are — it is about the mouse. Dragging a cursor along a row of cards can
      // fire pointerenter several times in a few frames, and worse, a cursor
      // resting on a boundary can chatter between two cards indefinitely.
      uiHover:   { emit: null, shake: 0, hitstop: 0, glow: 0, sfx: 'uiHover', haptic: null, sfxMinGap: 0.04 },
      // A commit gets a haptic where the hover does not: choosing an upgrade is
      // one of the few moments a player is deliberately pressing something, and
      // it is worth feeling. Light, because a menu is not an impact.
      uiClick:   { emit: null, shake: 0, hitstop: 0, glow: 0, sfx: 'uiClick',
                   haptic: [{ duration: 18, magnitude: 0.35 }] },
      // One character into the name field. This fires FAR more often than any
      // other menu sound — a name is a dozen of these in two seconds — so it
      // sits well below the hover, which is itself below the click. The order
      // hover < click was already deliberate; typing goes under all of it,
      // because a keystroke is the least significant thing a menu can report.
      //
      // No haptic: a phone buzzing per character while the on-screen keyboard
      // is up is the one place rumble stops being feedback and becomes noise.
      //
      // The gap is set just under a held key's repeat rate (~30/s), so normal
      // typing is never swallowed but leaning on a key ticks at a rate that
      // still resolves as separate sounds instead of a buzz.
      uiType:    { emit: null, shake: 0, hitstop: 0, glow: 0, sfx: 'uiType',
                   haptic: null, sfxMinGap: 0.03 },
      // A body swallowed. The heaviest `bite` in the game — it is the biggest
      // single mouthful there is — and it reads as eating, not as a kill.
      crewEaten: { emit: 'bite',        shake: 0.18, hitstop: 0.03,  glow: 0.5,  ripple: { strength: 2.2, radius: 9 },   sfx: 'bite',     haptic: [24, 20, 30] },
      // A man taken off a deck. Light and wet rather than explosive — he is not
      // an enemy and killing him is not an achievement; it should read as
      // something knocked into the sea.
      crewHit:   { emit: 'splash',      shake: 0.06, hitstop: 0,     glow: 0.15, ripple: { strength: 1.0, radius: 5 },   sfx: 'splash',   haptic: [10], sfxMinGap: 0.1 },
      // A chunk of wreckage coming apart. Heavier than the pellet that did it,
      // lighter than a kill — and rate-limited, because a splash landing in a
      // debris field breaks several on the same frame.
      debrisBreak: { emit: 'explosion', shake: 0.09, hitstop: 0,     glow: 0.3,  ripple: { strength: 1.4, radius: 6 },   sfx: 'kill',     haptic: [12], sfxMinGap: 0.08 },
      // The hull itself going up, which is a bigger event than the biggest kill:
      // it throws the crew, the wreckage and the catch all at once.
      boatExplosion: { emit: 'bigExplosion', shake: 1.0, hitstop: 0.09, glow: 1.6, ripple: { strength: 6, radius: 24 },  sfx: 'bigKill',  haptic: [40, 30, 60] },
      // Its own sound now rather than the generic `splash`, which is what a body
      // knocked off a boat makes. Coming out of the water and landing in it are
      // opposite events and were sharing one voice.
      breach:    { emit: 'splash',      shake: 0.2,  hitstop: 0,     glow: 0.3,  ripple: { strength: 2.0, radius: 9 },   sfx: 'breach',   haptic: [12] },
      // GOING THROUGH THE SUN. The loudest thing in the table that isn't a
      // death, and it should be: it is the rarest thing a player can do on
      // purpose, it costs a whole jump, and CONFIG.dayNight.pass.cooldown means
      // nobody is going to hear it twice in a row. The hitstop is real but
      // short — the seal is mid-arc and freezing an airborne body reads as a
      // stutter rather than as weight, so this lands nearer `strikeRam` than
      // `foodChain`. The ripple is enormous and does nothing to the water:
      // it rings the CONSTELLATIONS, which is the point of ringing the sky
      // from the sky (see the grid wrapper in world.js).
      sunPass:  { emit: 'sunPass',  shake: 0.5, hitstop: 0.04, glow: 1.4, ripple: { strength: 4.5, radius: 26 },
                  sfx: 'celestialSun', haptic: [30, 20, 45] },
      // The moon's is the same event played quieter, in every channel at once
      // — no hitstop at all, half the shake, a longer softer rumble. It hands
      // out time rather than damage (see CONFIG.dayNight.pass.moon), and an
      // event that pays in patience should not punch.
      moonPass: { emit: 'moonPass', shake: 0.22, hitstop: 0, glow: 1.1, ripple: { strength: 3.4, radius: 24 },
                  sfx: 'celestialMoon', haptic: [{ duration: 60, magnitude: 0.45 }] },
      bounce:    { emit: 'bounce',      shake: 0.12, hitstop: 0,     glow: 0.25, ripple: { strength: 1.2, radius: 6 },   sfx: 'bounce',   haptic: [8] },
      // Collecting a bubble orb bursts it into smaller bubbles rather than the
      // generic pickup spray — it's the one pickup that IS a bubble.
      bubblePop: { emit: 'breathBubbles',shake: 0.03, hitstop: 0,    glow: 0.25, ripple: { strength: 0.5, radius: 4 },   sfx: 'bubblePop',haptic: [8] },
      // Launching a mussel, not detonating one — heavier than a bullet's muzzle
      // flash and roughly as loud as a kill, since a volley leaving the flippers
      // is the moment the weapon reads as a weapon. Deliberately no hitstop: the
      // shells fly on after launch, and freezing the frame for the throw makes
      // the seal look like it hit something instead.
      missileLaunch: { emit: 'missileLaunch', shake: 0.14, hitstop: 0, glow: 0.5, ripple: { strength: 1.8, radius: 8 }, sfx: 'missileLaunch', haptic: [22] },
      // Shells 2..n of the same volley: the flash off their own flipper, and
      // nothing else. Same emitter, so tuning the look is one edit above.
      missileLaunchExtra: { emit: 'missileLaunch', shake: 0, hitstop: 0, glow: 0.12, ripple: { strength: 0.6, radius: 5 }, sfx: null, haptic: null },
      // The MUSSEL BARRAGE going off — eight shells leaving on one frame, on
      // top of a full-charge strike that is already the loudest thing the
      // player does. Bigger than a missile launch in every channel because it
      // is the payoff for the deepest commitment in the game, but STILL no
      // hitstop: it fires on the frame the dash launches, and freezing there
      // would eat the one manoeuvre it is supposed to be celebrating.
      musselBarrage: { emit: 'missileLaunch', shake: 0.3, hitstop: 0, glow: 1.1, ripple: { strength: 3.2, radius: 13 }, sfx: 'musselBarrage', haptic: [45, 30, 55] },
      // A mussel detonating on a target. Fires INSTEAD of the generic
      // `bulletHit` for that hit, not on top of it — a shell going off and a
      // pellet landing are not the same event, and playing both stacked two
      // impact sounds on the same frame. Carries an `sfxMinGap` for the same
      // reason bulletHit does: a five-shell volley lands inside one frame on a
      // packed school, and five copies of one crack is a smear, while five
      // separate flashes in five places is exactly what you want to see.
      // Hitstop, because unlike the launch this one HAS hit something.
      missileImpact: { emit: 'missileImpact', shake: 0.3, hitstop: 0.045, glow: 0.9, ripple: { strength: 3.2, radius: 12 }, sfx: 'missileImpact', haptic: [26], sfxMinGap: 0.05 },

      // =========================================================================
      // Everything below authors its haptic as explicit pulses —
      // { duration, magnitude } — rather than the millisecond patterns above.
      // Two reasons. A ms pattern has no intensity of its own, so its strength
      // is inferred from its LENGTH, which couples "how long" to "how hard" and
      // makes a short-but-heavy thump impossible to write. And the Haptics tab
      // (T panel) edits magnitude directly, so an authored number is what the
      // slider picks up; a ms pattern shows its derived value until you touch
      // it. See systems/haptics.js.
      //
      // The magnitudes across this block are one deliberate scale, because six
      // passives can be running at once and rumble does not mix — it sums into
      // one continuous buzz the moment two mid-strength events overlap. So the
      // repeating passives (garlic, shrimp, eel links, squad fire) sit at 0.1
      // to 0.25, and only the one-off moments — a ram landing, a wave going
      // out, the dash itself — are allowed past 0.5.
      // =========================================================================

      // --- the dash -------------------------------------------------------------
      // Was `feedback('boost', scale 2)` with a bare playSfx('strike') alongside
      // it, which meant the game's single most physical input had no haptic of
      // its own and borrowed the wrong particle burst. Two pulses: the shove
      // off, then the glide settling behind it.
      strike:      { emit: 'boost', shake: 0.18, hitstop: 0, glow: 0.5, ripple: { strength: 2.6, radius: 12 }, sfx: 'strike',
                     haptic: [{ duration: 50, magnitude: 0.95 }, { duration: 75, magnitude: 0.3, delay: 0 }] },
      // Each link of a strike chain. `scale` climbs with the combo at the call
      // site, so this one authored pulse covers a 1-hit chain and a 6-hit one.
      strikeChain: { emit: 'sparks', shake: 0.06, hitstop: 0, glow: 0.3, ripple: { strength: 1.0, radius: 6 }, sfx: 'strikeChain',
                     haptic: [{ duration: 16, magnitude: 0.4 }] },
      // THE POP AT THE RELEASE. The strike's whole damage output, going off
      // where the player let go — see CONFIG.strike.burst. Fires on EVERY
      // strike, which is what every number here is chosen around: no hitstop
      // (the dash is a movement input and freezing it fights the launch), a
      // shake well under the dash's own 0.18 so the two read as one event, and
      // a short `sfxMinGap` so a fast eat-and-strike loop doesn't stack the
      // same bang on itself. `scale` rides banked power at the call site.
      strikeBurst: { emit: 'explosion', shake: 0.12, hitstop: 0, glow: 0.55, ripple: { strength: 2.2, radius: 9 },
                     sfx: 'pearlBurst', haptic: [{ duration: 22, magnitude: 0.5 }], sfxMinGap: 0.06 },
      // THE RAM. A dash connecting with a body — which is now a shove rather
      // than a wound, and so needed a sound of its own: the hit feedback it
      // used to borrow was scaled by damage, and a strike that deals five
      // points of chip damage made a noise like a graze while visibly
      // throwing a shark across the screen.
      //
      // Borrows the escort squad's `sealRam` voice on purpose — it is the same
      // event performed by a smaller seal, and a second boom authored for it
      // would be the same sample twice. `sfxMinGap` because one dash through a
      // crowd lands four of these inside one frame.
      strikeRam:   { emit: 'bite', shake: 0.16, hitstop: 0.03, glow: 0.35, ripple: { strength: 2.0, radius: 8 }, sfx: 'sealRam',
                     haptic: [{ duration: 30, magnitude: 0.7 }], sfxMinGap: 0.07 },
      // TWO BODIES MEETING — a punted turtle arriving at a hull, or the hull it
      // shoved arriving at the next one. Heavier than the ram above, because
      // this one is not the seal touching something: it is a ton of shell
      // hitting a boat at the speed the seal threw it, and the `scale` it
      // arrives with rides the impact speed (see systems/rigidBody.js). Same
      // borrowed boom, with the gap that keeps a scrape from machine-gunning.
      bodyImpact:  { emit: 'bite', shake: 0.34, hitstop: 0.05, glow: 0.6, ripple: { strength: 3.4, radius: 12 }, sfx: 'sealRam',
                     haptic: [{ duration: 45, magnitude: 0.9 }], sfxMinGap: 0.12 },
      // A target painted for the homing weapons. Quiet and small: this fires
      // on the same frame as the ram that caused it, and its job is to say
      // "that one" — the reticle does the talking (see systems/marks.js).
      strikeMark:  { emit: 'sparks', shake: 0, hitstop: 0, glow: 0.2, sfx: 'strikeChain',
                     haptic: null, sfxMinGap: 0.12 },
      // Winding a strike up. Re-fired on `charge.hapticInterval` for as long as
      // the button is held, with `scale` riding the power banked so far, so the
      // rumble builds instead of buzzing flat. No particles and no sound: the
      // shake for this is SUSTAINED rather than per-event (see
      // CONFIG.strike.charge.shake), and a spray of sparks every 70ms would bury
      // the seal in its own wind-up. `sfx` is left wired but null — a rising
      // whine belongs here if one gets authored.
      strikeCharging: { emit: null, shake: 0, hitstop: 0, glow: 0.05, sfx: null,
                        haptic: [{ duration: 55, magnitude: 0.3 }] },
      // The mouthful that topped the charge meter back off, fired at the ORB
      // rather than at the seal so it reads as "THAT is what refilled you".
      // Deliberately silent and rumble-free: it lands on the same frame as
      // `foodChain` below, which is already carrying a fanfare and two haptic
      // pulses, and a third sound stacked on those is the smear this table
      // spends most of its comments avoiding. Purely the visual marker.
      chumFull:    { emit: 'pickup', shake: 0.04, hitstop: 0, glow: 0.5, ripple: { strength: 1.2, radius: 6 }, sfx: null, haptic: null },
      // ONE PIP OF THE BAR FILLING — the tick under the meter.
      //
      // No emitter, no shake, no ripple and no hitstop, and every one of those
      // is deliberate: this fires five to twelve times per link, more than
      // anything else in the strike loop, and the entire table's worth of hard
      // experience says the repeated event is the one that has to stay out of
      // the way. What it gets is a quiet tick and the faintest tap.
      //
      // The rate limit is NOT `sfxMinGap`, which would collapse a burst into
      // one sound and lose the count. The crossings queue in systems/strike.js
      // and drain on CONFIG.strike.charge.pipGap, so all six of a magnet
      // sweep's pips are heard — just spread into a run.
      strikePip:   { emit: null, shake: 0, hitstop: 0, glow: 0.06, sfx: 'strikePip',
                     haptic: [{ duration: 18, magnitude: 0.22 }] },
      // FOOD CHAIN! — fires once per EXTENSION, on top of the per-link
      // `strikeChain` above, and it's the one event in the table whose job is
      // weight rather than information. The hitstop is deliberately longer than
      // bigKill's 0.07: main.js fires this BEFORE the kill event so it wins the
      // shared hitstop cooldown (see feedback.js), and a chain extension that
      // stopped the frame for less time than the kill underneath it would read
      // as the smaller of the two events. Two pulses — the catch, then the
      // swallow.
      foodChain:   { emit: 'levelUp', shake: 0.32, hitstop: 0.08, glow: 0.9, ripple: { strength: 3.2, radius: 14 }, sfx: 'foodChain',
                     haptic: [{ duration: 45, magnitude: 0.85 }, { duration: 70, magnitude: 0.35, delay: 20 }] },

      // --- oxygen ---------------------------------------------------------------
      // The drowning beep, felt as well as heard. Both of these already drove
      // their pitch from how bad the situation is (see systems/oxygenFx.js);
      // routing them through here is what lets the rumble do the same, via
      // `scale`. No particles on the warning — it fires on a timer while you're
      // suffocating and a spray of sparks every beep would be nonsense.
      oxygenWarn:  { emit: null, shake: 0, hitstop: 0, glow: 0.1, sfx: 'oxygenWarn',
                     haptic: [{ duration: 22, magnitude: 0.25 }] },
      breathIn:    { emit: 'breathBubbles', shake: 0.02, hitstop: 0, glow: 0.12, sfx: 'breathIn',
                     haptic: [{ duration: 40, magnitude: 0.3 }] },

      // --- electric eel ---------------------------------------------------------
      // The discharge, once per bolt regardless of how far it chains. Two
      // pulses so it crackles rather than thumps — a single flat buzz is the
      // one thing electricity must not feel like.
      eelBolt:     { emit: 'sparks', shake: 0.10, hitstop: 0, glow: 0.45, ripple: { strength: 1.4, radius: 8 }, sfx: 'eelBolt',
                     haptic: [{ duration: 28, magnitude: 0.55 }, { duration: 14, magnitude: 0.3, delay: 18 }] },
      // Per hop down the chain. Fires up to `maxChain` times inside ONE frame,
      // which is exactly the pile-up `sfxMinGap` exists for — but the gap is
      // tiny rather than zero so a long chain still reads as a run of ticks
      // instead of collapsing to a single click. The haptic is deliberately
      // below the floor's reach on its own; what you feel is the sum of a
      // chain, not any one link.
      eelChain:    { emit: 'sparks', shake: 0.02, hitstop: 0, glow: 0.15, ripple: { strength: 0.5, radius: 4 }, sfx: 'eelChain',
                     haptic: [{ duration: 8, magnitude: 0.24 }], sfxMinGap: 0.02 },

      // --- seal team ------------------------------------------------------------
      // A ram connecting. The heaviest of the companion events: it's a whole
      // seal hitting something, and it's the ability's actual damage.
      sealRam:     { emit: 'bite', shake: 0.14, hitstop: 0, glow: 0.4, ripple: { strength: 1.8, radius: 8 }, sfx: 'sealRam',
                     haptic: [{ duration: 30, magnitude: 0.6 }], sfxMinGap: 0.04 },
      // Breaking formation to charge. No damage yet — this is the wind-up, and
      // it's gated to one seal at a time by `lunge.teamCooldown`, so it can
      // afford to be felt.
      sealLunge:   { emit: 'boost', shake: 0.04, hitstop: 0, glow: 0.2, ripple: { strength: 0.8, radius: 6 }, sfx: 'sealLunge',
                     haptic: [{ duration: 20, magnitude: 0.28 }] },
      // The evolved squad's gunfire. Six seals firing on staggered timers is
      // the highest-frequency event in this entire block, so it gets the
      // longest `sfxMinGap` and the lightest touch of anything that isn't
      // ambient.
      sealShot:    { emit: 'muzzle', shake: 0, hitstop: 0, glow: 0.08, sfx: 'sealShot',
                     haptic: [{ duration: 6, magnitude: 0.18 }], sfxMinGap: 0.08 },

      // --- calamari ring --------------------------------------------------------
      // The wave going out. Was borrowing `boost` — the dash's particles, the
      // dash's (absent) sound and none of its weight. A long swell rather than
      // a hit: the front takes real time to cross the arena, and the rumble
      // should still be dying as it does.
      calamariPulse: { emit: 'boost', shake: 0.16, hitstop: 0, glow: 0.55, ripple: { strength: 3.0, radius: 14 }, sfx: 'calamariPulse',
                       haptic: [{ duration: 55, magnitude: 0.7 }, { duration: 90, magnitude: 0.25, delay: 10 }] },

      // --- the quiet passives ---------------------------------------------------
      // Garlic ticks on a timer for as long as anything is standing in it, so
      // this is the single most repeated event in the game. No particles at all
      // (the aura shader already shows the field), the quietest sound in the
      // table, and a rumble barely above the floor. Fires ONCE per tick, not
      // once per enemy — see the onTick hook in systems/garlic.js.
      garlicTick:  { emit: null, shake: 0.01, hitstop: 0, glow: 0.1, sfx: 'garlicTick',
                     haptic: [{ duration: 14, magnitude: 0.12 }], sfxMinGap: 0.1 },
      // A shrimp connecting. Eight of them orbiting through a school can hit on
      // the same frame; the gap collapses that to one clack.
      shrimpHit:   { emit: 'bounce', shake: 0.02, hitstop: 0, glow: 0.15, ripple: { strength: 0.5, radius: 4 }, sfx: 'shrimpHit',
                     haptic: [{ duration: 10, magnitude: 0.2 }], sfxMinGap: 0.06 },

      // --- the club -----------------------------------------------------------
      // Wood on fish. This is the weapon's signature moment and it wants real
      // weight, but it is also a REPEATING event — two clubs turning at swim
      // speed through a school connect several times a second — so it carries
      // no hitstop at all and the sound is throttled. The heft has to come from
      // the shake and the ripple, which cost nothing to repeat.
      clubWhack:   { emit: 'bite', shake: 0.11, hitstop: 0, glow: 0.3, ripple: { strength: 1.5, radius: 7 }, sfx: 'clubWhack',
                     haptic: [{ duration: 18, magnitude: 0.45 }], sfxMinGap: 0.05 },
      // A thrown body landing on another one. Lighter than the whack on
      // purpose: the carom is the payoff, but it fires once per body in the
      // chain and stacking full-weight impacts turns a good break shot into a
      // wall of noise. The pitch climbs per link at the call site instead, the
      // same trick the eel's chain and the ricochet shot's combo both use.
      clubRicochet: { emit: 'bounce', shake: 0.05, hitstop: 0, glow: 0.2, ripple: { strength: 0.9, radius: 5 }, sfx: 'clubRicochet',
                     haptic: [{ duration: 12, magnitude: 0.28 }], sfxMinGap: 0.05 },
      // A club leaving the flipper on a strike release. Fires several times on
      // ONE frame — a full-charge throw is four or more at once — and lands on
      // a frame that is already loud with the strike itself, so only the first
      // gets the full event and the rest are flash-only (see main.js). No
      // shake for the same reason: the release already shook the camera.
      clubThrow:   { emit: 'muzzle', shake: 0.04, hitstop: 0, glow: 0.3, sfx: 'clubThrow',
                     haptic: [{ duration: 14, magnitude: 0.35 }], sfxMinGap: 0.06 },
      // Powder Keg going off. A real bang, but a REPEATING one — two clubs in
      // a crowd set these off several times a second — so no hitstop and a
      // hard throttle on the sound. The ripple carries the weight instead; it
      // costs nothing to fire often. Its own ripple is sized off the blast in
      // main.js rather than fixed here, since the radius grows per stack.
      clubBoom:    { emit: 'explosion', shake: 0.16, hitstop: 0, glow: 0.6, sfx: 'clubBoom',
                     haptic: [{ duration: 22, magnitude: 0.5 }], sfxMinGap: 0.07 },
      // Cold Snap, at the moment a body locks solid. Fires far less often than
      // the chill itself (only on saturation), so it can afford to be a proper
      // event — this is the payoff the card is bought for.
      clubFreeze:  { emit: 'bubbleBurst', shake: 0.06, hitstop: 0, glow: 0.45, ripple: { strength: 1.0, radius: 5 },
                     sfx: 'clubFreeze', haptic: [{ duration: 16, magnitude: 0.4 }], sfxMinGap: 0.06 },
      // An enemy sealed in a bubble. Was playing `bulletHit` — an impact sound
      // for something that deals no damage at all.
      belugaTrap:  { emit: 'breathBubbles', shake: 0.02, hitstop: 0, glow: 0.2, ripple: { strength: 0.6, radius: 5 }, sfx: 'belugaTrap',
                     haptic: [{ duration: 18, magnitude: 0.3 }], sfxMinGap: 0.05 },
      // The same catch, one beat later: the held bubble giving out. Fires from
      // the end of the flicker (CONFIG.beluga.popFlicker), not from the touch,
      // so the two sounds are heard as a sequence rather than as one thick
      // noise — see the note on those fields. The particles do the talking
      // here, so everything else is kept at or below the seal that preceded it;
      // a second jolt on the camera a fifth of a second after the first reads
      // as a stutter, not as emphasis.
      belugaPop:   { emit: 'trapPop', shake: 0.02, hitstop: 0, glow: 0.3, ripple: { strength: 0.9, radius: 6 }, sfx: 'belugaPop',
                     haptic: [{ duration: 12, magnitude: 0.22 }], sfxMinGap: 0.05 },

      // --- Glow Up! (systems/elements.js) -----------------------------------
      // The elemental half of a hit rides on TOP of `bulletHit`, which has
      // already fired for the same pellet on the same frame. So everything here
      // is deliberately smaller than the impact it decorates: no hitstop at
      // all, minimal shake, and a tight `sfxMinGap` on every one of them,
      // because the basic shot is the most frequently landing thing in the game
      // and this fires on every single pellet that connects.
      //
      // ONE ENTRY PER ELEMENT, keyed `elementHit<Element>` — systems/elements.js
      // builds the key from the element id. They differ only in their emitter,
      // and that is exactly why they can't be collapsed into one row: a burst's
      // colour belongs to the emitter (feedback() takes no `color`, on purpose),
      // so four colours means four emitters means four rows.
      elementHitShock: { emit: 'elementShock', shake: 0.012, hitstop: 0, glow: 0.3, sfx: 'elementHit',
                     haptic: [{ duration: 8, magnitude: 0.12 }], sfxMinGap: 0.11 },
      elementHitVenom: { emit: 'elementVenom', shake: 0.012, hitstop: 0, glow: 0.26, sfx: 'elementHit',
                     haptic: [{ duration: 8, magnitude: 0.12 }], sfxMinGap: 0.11 },
      elementHitChill: { emit: 'elementChill', shake: 0.012, hitstop: 0, glow: 0.3, sfx: 'elementHit',
                     haptic: [{ duration: 8, magnitude: 0.12 }], sfxMinGap: 0.11 },
      elementHitInfection: { emit: 'elementInfection', shake: 0.012, hitstop: 0, glow: 0.34, sfx: 'elementHit',
                     haptic: [{ duration: 8, magnitude: 0.12 }], sfxMinGap: 0.11 },
      // Voltaic arcing to a second body. Louder than the hit that caused it —
      // this one is the ability doing something you did not aim at, and it has
      // to announce itself or it reads as the fish dying at random.
      elementArc:  { emit: 'sparks', shake: 0.05, hitstop: 0, glow: 0.55, ripple: { strength: 1.2, radius: 6 }, sfx: 'elementArc',
                     haptic: [{ duration: 14, magnitude: 0.25 }], sfxMinGap: 0.07 },
      // Chill saturating into a hard lock. A rarer event than the rest of this
      // block and worth a real beat: it is the moment the element pays off.
      elementFreeze: { emit: 'breathBubbles', shake: 0.06, hitstop: 0, glow: 0.7, ripple: { strength: 1.6, radius: 7 }, sfx: 'elementFreeze',
                     haptic: [{ duration: 22, magnitude: 0.35 }], sfxMinGap: 0.06 },
      // An infected host coming apart and taking its neighbours with it. The
      // heaviest of the four, because a burst can chain into another burst and
      // the chain is the whole reason to pick the element.
      infectionBurst: { emit: 'explosion', shake: 0.18, hitstop: 0, glow: 0.8, ripple: { strength: 2.2, radius: 9 }, sfx: 'infectionBurst',
                     haptic: [{ duration: 24, magnitude: 0.4 }], sfxMinGap: 0.05 },
      // The contagion creeping to the next fish. Almost silent on purpose: the
      // motes travelling between bodies are the event, and a sound on every hop
      // would turn a spreading school into a rattle.
      infectionSpread: { emit: null, shake: 0, hitstop: 0, glow: 0.12, sfx: 'infectionSpread',
                     sfxMinGap: 0.22 },
      // The net dragging a fish off. Counts as a kill everywhere else in the
      // game, but it isn't one to the hand — nothing was hit, something was
      // taken away, so it's a pull rather than a knock.
      bakalarHaul: { emit: 'breathBubbles', shake: 0.05, hitstop: 0, glow: 0.25, ripple: { strength: 1.0, radius: 7 }, sfx: 'bakalarHaul',
                     haptic: [{ duration: 34, magnitude: 0.45 }], sfxMinGap: 0.06 },
      // Charm. Was playing `pickup`, which made turning an enemy harmless sound
      // exactly like collecting chum.
      dumboCharm:  { emit: 'pickup', shake: 0.02, hitstop: 0, glow: 0.2, ripple: { strength: 0.4, radius: 4 }, sfx: 'dumboCharm',
                     haptic: [{ duration: 24, magnitude: 0.2 }], sfxMinGap: 0.05 },

      // --- scallop squirter ---------------------------------------------------
      // The launch is one event for the whole flight, not one per shell: they
      // all leave the mouth on the same frame, and six stacked spits is a smear.
      scallopLaunch: { emit: 'bubbleBurst', shake: 0.04, hitstop: 0, glow: 0.2, ripple: { strength: 0.6, radius: 4 },
                       sfx: 'scallopLaunch', haptic: [{ duration: 14, magnitude: 0.3 }] },
      // Every clap of the jet, from every shell in the water at once. This is
      // the most frequently fired event in the game by some margin — a full
      // stack of twelve scallops claps roughly forty times a second between
      // them — so it carries NO shake and NO haptic, and the sound is throttled
      // hard. Camera shake on this would be a permanent tremble.
      scallopJet:  { emit: 'wakeBubbles', shake: 0, hitstop: 0, glow: 0.05, sfx: 'scallopJet',
                     haptic: null, sfxMinGap: 0.14 },

      // --- oyster blaster -----------------------------------------------------
      pearlShot:   { emit: 'muzzle', shake: 0.05, hitstop: 0, glow: 0.35, ripple: { strength: 0.8, radius: 5 },
                     sfx: 'pearlShot', haptic: [{ duration: 18, magnitude: 0.45 }], sfxMinGap: 0.05 },
      // A bomblet going off. Several land within a few frames of each other by
      // design, so this is throttled and light — the pearl's own impact already
      // played the big sound, and this is the sparkle after it.
      pearlBurst:  { emit: 'pearlBurst', shake: 0.05, hitstop: 0, glow: 0.5, ripple: { strength: 1.0, radius: 5 },
                     sfx: 'pearlBurst', haptic: [{ duration: 12, magnitude: 0.28 }], sfxMinGap: 0.06 },

      // --- octopus grabber ----------------------------------------------------
      // An arm latching on. Quiet and throttled: with nine arms this fires
      // constantly, and it is not the moment worth selling — the pop is.
      octoGrab:    { emit: null, shake: 0.02, hitstop: 0, glow: 0.12, sfx: 'octoGrab',
                     haptic: [{ duration: 10, magnitude: 0.2 }], sfxMinGap: 0.1 },
      // A fish reeled all the way in and popped into chum. THIS is the payoff
      // beat of the ability, so it gets the weight the grab doesn't.
      octoPop:     { emit: 'bite', shake: 0.09, hitstop: 0, glow: 0.4, ripple: { strength: 1.4, radius: 6 },
                     sfx: 'octoPop', haptic: [{ duration: 22, magnitude: 0.5 }], sfxMinGap: 0.05 },

      // --- orca family --------------------------------------------------------
      // A three-tonne animal hitting a hull. Real weight, and the one companion
      // event that earns hitstop — it happens rarely, away from the player, and
      // it's the pod's whole reason to exist.
      orcaStrike:  { emit: 'splash', shake: 0.3, hitstop: 0.04, glow: 0.5, ripple: { strength: 2.8, radius: 12 },
                     sfx: 'orcaStrike', haptic: [26, 18], sfxMinGap: 0.06 },

      // --- bakalar's voicemail bombs -------------------------------------------
      // The drop is a tell, not an impact: it tells you something is about to
      // happen in the net so you can be somewhere useful when it does.
      bakalarBombDrop: { emit: 'bubbleBurst', shake: 0.03, hitstop: 0, glow: 0.25, sfx: 'bakalarBombDrop',
                         haptic: [{ duration: 16, magnitude: 0.35 }] },
      // And the payoff. The biggest single blast in the game — a netful of fish
      // going up at once — so it's tuned near `bigKill` rather than near the
      // other ability events.
      bakalarBombBlast: { emit: 'bigExplosion', shake: 0.6, hitstop: 0.06, glow: 1.1, ripple: { strength: 4.2, radius: 20 },
                          sfx: 'bakalarBombBlast', haptic: [34, 24, 40] },
      // A bomber committing to its stoop. The one event here that fires far
      // from the player, so it's the sound that carries it, not the rumble.
      seagullDive: { emit: null, shake: 0.02, hitstop: 0, glow: 0.15, sfx: 'seagullDive',
                     haptic: [{ duration: 20, magnitude: 0.3 }], sfxMinGap: 0.08 },
      // The body reaching the seabed at the end of the death dive. No hitstop —
      // the whole sequence is already dilated, and stopping the clock inside slow
      // motion does nothing you can see. The shake is the low, soft kind you'd
      // feel through the floor rather than the crack of an impact.
      seabedImpact: { emit: 'silt', shake: 0.35, hitstop: 0, glow: 0.15, ripple: { strength: 2.6, radius: 16 },
                      sfx: 'seabedThud', haptic: [{ duration: 90, magnitude: 0.5 }] },
    },

    fx: {
      maxParticles: 8000, // ring buffer; oldest bursts are overwritten

      // THE CURRENT. One divergence-free swirl field covering the whole arena
      // that every particle in the game is pushed by — see entities/particles.js
      // for the shape of it. Global on purpose: two bursts going off next to
      // each other bending the same way is the entire reason it reads as water
      // rather than as noise per emitter.
      turbulence: {
        enabled: true,
        // World units of wander per second of a particle's life, before the
        // emitter's own `turbulence` multiplier. Ramps from zero at spawn, so
        // the number is what a one-second particle picks up, and a 0.3s spark
        // sees very little of it.
        strength: 0.55,
        // Spatial frequency: 0.35 puts the main swirl at roughly an 18-unit
        // wavelength, which is a good fraction of the visible arena — big slow
        // eddies with a smaller harmonic folded in, not a rippling texture.
        frequency: 0.35,
        // How fast the field itself churns. Low: the current should drift, and
        // anything quick enough to see moving stops looking like water.
        timeScale: 0.6,
        // Per-particle spread on the emitter's drag, as a fraction either way
        // (0.5 = every particle lands somewhere in 0.5x..1.5x). At 0 a burst is
        // a rigid shell that all stops on the same frame; this is what lets the
        // light bits stall in the water while the heavy ones carry on.
        dragVary: 0.5,
      },

      shakeDecay: 0.0004, // fraction of shake left after 1s
      maxShake: 0.85, // ceiling, so a busy fight can't pin the camera
      hitstopScale: 0.12, // time scale during a hit-stop, not a full freeze
      hitstopCooldown: 0.4, // minimum gap between hit-stops
      hitFlash: 0.12, // seconds an enemy pops when hit
      hitPop: 0.35, // extra scale on that pop

      // How a number of damage becomes a hit you can feel. Read only by
      // systems/playerDamageFx.js — the long version of why any of this is
      // needed is at the top of that file.
      playerDamage: {
        // Minimum real seconds between two damage events being SHOWN. Damage
        // arriving inside the window isn't dropped, it's added to the next
        // one — so swimming into a school reads as a run of solid hits
        // instead of forty overlapping copies of the same sound.
        minGap: 0.16,
        // ...and the smallest pile worth showing at all, as a fraction of max
        // HP. Below this the accumulator just keeps counting. This is what
        // stops a 3-damage-per-second fish brushing past from firing the full
        // hit treatment eight times a second.
        minFraction: 0.012,
        // fraction of the bar lost -> `scale` on the feedback event, which is
        // what drives shake, particle count, ripple, glow and sfx volume:
        //
        //   scale = clamp(base + lost * gain, base, max)
        //
        // At the shipped numbers a 1% graze is 0.39, a 10% bite is 0.75, and
        // anything past ~41% of the bar in one go pins the ceiling. Tuned in
        // FRACTIONS rather than raw damage on purpose: max HP moves a long
        // way over a run (Blubber stacks), and a 20-damage hit late is not
        // the emergency the same 20 was on the first wave.
        base: 0.35,
        gain: 4.0,
        max: 2.0,
        // The fraction of the bar that earns a full-strength rim flash — the
        // longest, brightest red. Lower than the point where `scale` pins, so
        // the rim saturates before the shake does; the rim is the readable
        // channel and the camera is the one that gets annoying.
        flashFraction: 0.3,
        // ...and the floor under it, so the smallest hit still flashes for a
        // readable length rather than for two frames.
        minFlash: 0.3,
      },
    },

    // ---------------------------------------------------------------------------
    // DEATH DIVE — the run doesn't end on the frame you die. The seal goes limp,
    // time (and sound with it) dilates, the body sinks to the seabed, and only
    // once it has settled there does the score screen ask for a name. See
    // systems/deathDive.js; every number here is either WALL-CLOCK seconds (the
    // dilation ramp and the settle pause, which have to stay honest while the
    // rest of the game crawls) or a rate in DILATED time (the physics, which is
    // the thing being slowed).
    // ---------------------------------------------------------------------------
    death: {
      enabled: true,

      // --- time dilation (wall-clock) ------------------------------------------
      slowMo: 0.11, // time scale at the bottom of the dip — the moment of death
      // Seconds to ease from full speed down into it. Long enough to read as the
      // world leaning into the slow motion rather than cutting to it — under
      // half a second the ramp is over before you've registered the hit, which
      // is indistinguishable from a snap.
      dilateTime: 0.9,
      // Held at slowMo, a fall from the surface to the seabed takes the better
      // part of a minute, so it eases back out to a drift. Still obviously slow
      // motion; just watchable. The pair below is the main dial on how long the
      // whole sequence lasts — with these, a death at the surface reaches the
      // floor in about three seconds and a death mid-water in half that.
      driftScale: 0.45,
      driftTime: 1.4, // seconds of that recovery

      // --- the body (rates in dilated time) ------------------------------------
      launch: 0.35, // fraction of the seal's velocity at death that carries on
      kickUp: 5, // a limp lift before the water takes it, world units/s
      sinkGravity: 34,
      // Terminal sink speed. Reached in about a second — `drag` alone would cap
      // it well below this, so the two are tuned together: drag shapes the first
      // moments, this decides the descent.
      sinkSpeedMax: 30,
      // How much faster a body dropped from the very top falls than one that
      // died on the seabed, scaled linearly by the distance it has to cover.
      // Without it the sequence runs twice as long for a death near the surface
      // — the one case where there's already the most nothing to watch. Both
      // gravity and the terminal speed above take this, so the fall still
      // reaches its top speed just as quickly; that speed is simply higher.
      depthBoost: 2.2,
      drag: 0.985, // velocity kept per 1/60s
      sway: 3, // lazy horizontal drift on the way down
      swayHz: 0.4,
      spin: 2.4, // tumble, rad/s, scaled by how fast it was moving when it died
      spinDamp: 0.7, // e-folds per second
      bodyRoll: 1.6, // barrel roll about the seal's own forward axis, rad/s
      rollDamp: 0.5,
      craneRelax: 3, // how fast the body's look-behind twist unwinds, e-folds per second
      tailKick: 9, // shove into the tail spring, so the limp tail has something to trail

      // --- the landing ---------------------------------------------------------
      // Restitution off the seabed. Low, and it has to stay low: the settle
      // pause below is wall clock, and at these time scales it buys about a
      // second of dilated time — anything springier than this is still in the
      // air when the score card goes up.
      bounce: 0.08,
      settleDrag: 0.86, // velocity kept per 1/60s once it's down
      // How fast it rolls flat, e-folds per second. Fast, because the pause
      // below is dilated time as far as this is concerned: it has to be SETTLED
      // and lying there, not still turning as the card fades in over it.
      settleTurn: 14,
      // WALL-CLOCK seconds on the floor before the score screen. This is the
      // beat where the body just lies there and the silt drifts — the card
      // arriving the moment it lands reads as the game rushing you off the
      // scene it just spent four seconds staging.
      settle: 2.5,
      fadeIn: 0.9, // seconds the score card takes to fade up (see ui.js)

      // --- the shot ------------------------------------------------------------
      // The frame leaves the wide arena view, closes in on the body and rides it
      // down. Both times are WALL-CLOCK: the push is a separate movement laid
      // over the dilation, and running it on dilated time would leave it nearly
      // frozen through the exact second it exists for. The view is clamped to
      // the edges of the ocean (see world.js), so on the way down the seabed
      // rises into the bottom of the frame rather than the corpse staying
      // pinned to the middle of it.
      camera: {
        enabled: true,
        zoom: 1.8, // push-in multiplier — 1.8 shows a bit over half the arena
        pushTime: 3.2, // seconds to reach it; deliberately longer than a short dive
        frameTime: 1.2, // seconds to slide from the wide framing onto the body
    },

      // --- sound ---------------------------------------------------------------
      // The mix follows the picture: the music drags down like a tape stop and
      // one-shots play back long and low with it.
      audio: {
        enabled: true,
        follow: 1, // 0 = sound ignores the dilation, 1 = it slows exactly as far
        minRate: 0.3, // floor — below this a loop is mud rather than a drop
        glide: 0.25, // seconds of smoothing on the music's rate, so it doesn't zipper
        // The music does NOT stop when the score card appears — it plays on
        // under it, and over these seconds it winds back up to pitch. The drag
        // is the dive's; the score screen is not part of the dive, and leaving
        // the loop down at `minRate` there is a rumble you sit in for as long
        // as it takes to type a name. Everything else stays dilated: the
        // seabed the body is lying on is still in slow motion.
        restoreTime: 2.6,
    },

      // --- coming back ---------------------------------------------------------
      // "Try again" doesn't cut straight into the next run. Everything the death
      // bent — the clock, the pitch, the muffling, the push-in — glides back to
      // normal first, and only then does the run start. Without it the next run
      // opened on a slowed, filtered mix that snapped back to normal a moment
      // later, which sounds like a bug rather than a transition.
      restart: {
        time: 0.9, // WALL-CLOCK seconds of that glide before the run begins
        // Time constant for sweeping the SFX bus back open, as a fraction of
        // `time` — a third gets it essentially there by the time the run starts
        // without the last of it sounding like a switch being thrown.
        filterGlide: 0.33,
    },
    },

    // ---------------------------------------------------------------------------
    // AUDIO — every sound is synthesised by default, so there are no files to
    // ship. Drop a .wav/.mp3 in public/sfx/ and set `src` to use it instead; if
    // the file is missing the synth is used, same as the model fallback.
    // type: 'blip' (pitched sweep) | 'noise' (filtered burst) | 'boom' (both)
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // ANIMATION — a small state machine per rigged creature. If the model's
    // clips include a matching name (see ASSETS.<key>.animations) that clip
    // plays via AnimationMixer. If not, the state falls back to a procedural
    // bone wag driven by ASSETS.<key>.rig — a travelling sine wave down the
    // named bone chain, so an unanimated rig still visibly swims rather than
    // sliding around stiff. Same fallback philosophy as a missing model/texture.
    // ---------------------------------------------------------------------------
    animation: {
      enabled: true,
      moveThreshold: 1.5, // speed above which idle -> swim
      boostThreshold: 14, // speed above which swim -> boost
      chainPhase: 0.6, // radians of phase offset between successive chain bones
      crossfade: 0.2, // default blend time between states, in seconds
      states: {
        // wagSpeed/wagAmplitude/headBob drive the PROCEDURAL fallback (models
        // with no matching clip). clipTimeScale drives playback speed — for
        // models reusing one clip across states, and for one-shots that want
        // to play faster/slower than authored. `fade` overrides the global
        // crossfade for entering that specific state.
        //
        // `beatsPerLoop` locks a LOOPING state to the music instead: one full
        // cycle spans that many beats at the audible tempo (CONFIG.music.bpm
        // through the death dive's drag), and the cycle is started in phase
        // with the beat grid, so the seal's idle waggle keeps time with the
        // loop that's playing rather than running at whatever pace it was
        // authored at. 0 or absent = play at the clip's own speed, which is
        // every other state.
        //
        // Idle is one bar of 4/4 and the surface idle two — the closest
        // musical figures to how those two clips were authored (2.67s and 6s,
        // against 2.29s and 4.57s at 105bpm), so they read as the same
        // animations, now in time. Note this REPLACES clipTimeScale for these
        // states: a beat-synced loop takes its tempo from the music alone, or
        // the second multiplier would put it straight back off the grid.
        // Moving speed is deliberately left alone — a swim cycle has to match
        // how fast the seal is actually travelling, or it foot-slides.
        idle:        { wagSpeed: 1.6, wagAmplitude: 0.12, headBob: 0.06, clipTimeScale: 0.45, beatsPerLoop: 4 },
        swim:        { wagSpeed: 4.2, wagAmplitude: 0.24, headBob: 0.03, clipTimeScale: 1.0 },
        boost:       { wagSpeed: 7.5, wagAmplitude: 0.34, headBob: 0.0,  clipTimeScale: 1.4 },
        surfaceIdle: { wagSpeed: 1.2, wagAmplitude: 0.10, headBob: 0.05, clipTimeScale: 1.0, beatsPerLoop: 8 },
        surfaceMove: { wagSpeed: 3.6, wagAmplitude: 0.20, headBob: 0.04, clipTimeScale: 1.2 },
        // One-shots. Short fades so they punch in rather than easing in.
        // `maxDuration` caps how long the one-shot may hold locomotion —
        // these clips are full authored performances (bark is 6.8s, roll 6.7s,
        // ball 5.5s), and playing them to completion locked the seal out of
        // swimming for seconds at a time, which read as the state machine
        // getting stuck after a breach. Capped, they play as brief reactions
        // and hand straight back. null = play the whole clip (death only).
        strike:      { clipTimeScale: 1.6, fade: 0.06, maxDuration: 0.5 },
        // A predator's jaw snap. Only megalodon.glb has a clip for this (1.30s
        // "metarig|Bite"); it plays a touch fast and is capped just under its
        // own length, so the shark is back to swimming as the mouth shuts
        // rather than coasting through the tail of the clip. Every other
        // hunter bites through the procedural jaw instead — systems/jaw.js.
        bite:        { clipTimeScale: 1.25, fade: 0.05, maxDuration: 0.9 },
        hit:         { clipTimeScale: 1.3, fade: 0.05, maxDuration: 0.35 },
        bark:        { clipTimeScale: 1.2, fade: 0.08, maxDuration: 0.6 },
        death:       { clipTimeScale: 1.0, fade: 0.15, maxDuration: null },
    },
      // Higher wins: a death interrupts anything, a hit interrupts a bark, and
      // nothing interrupts a death.
      // A bite outranks a dash but still yields to a flinch and a death — a
      // shark that gets shot mid-snap reacts to the shot, and one that dies
      // mid-snap dies rather than finishing its meal.
      oneShotPriority: { bark: 1, strike: 2, bite: 2, hit: 3, death: 10 },
      // Per-one-shot on/off, so a reaction animation you don't like can be
      // disabled without touching the code that triggers it.
      oneShots: { strike: true, bite: true, hit: true, bark: true, death: true },
      hit: { amplitude: 0.4, duration: 0.22 }, // brief flinch pulse on taking damage

      // Damped-spring secondary motion layered over whatever wrote the pose,
      // for any creature whose asset names a `rig` bone chain. Two jobs:
      //
      //   1. It stops the sine-wave fallback reading as a rigid metronome. A
      //      shark with no clips (shark.glb ships none) now lags and overshoots
      //      when it turns instead of wagging in place.
      //   2. It IS the hit reaction. `impulse()` shoves these springs and they
      //      carry the shove down the body and settle — which is how a creature
      //      with no authored flinch clip can still flinch.
      //
      // Same solver as the seal's tail (CONFIG.tail) — see systems/boneSpring.js.
      spring: {
        enabled: true,
        weight: 1.0, // how much of the lagged pose is blended over the target
        stiffness: 90, // spring constant at the ROOT of the chain
        damping: 11, // higher = less wobble; scaled per bone to hold the ratio
        tipLooseness: 0.75, // 0..1 — how much softer the tail end is than the head end
        maxLag: 0.4, // radians a bone may trail its target pose
        softness: 0.5, // ease into that cap rather than snapping taut
        snapAngle: 1.4, // past this the spring resets instead of slinging the long way
        // Hit impulse. Strength is damage-scaled and capped, so a chip of
        // splash damage twitches the body and a big hit visibly buckles it,
        // without a crit folding the creature in half.
        impulsePerDamage: 0.5,
        impulseMax: 14,
        impulseTipBias: 0.85, // 0 = whole body kicked equally, 1 = all of it at the tail

        // PER-ROLE LOOSENESS. Every value above is one setting shared by every
        // chain on every creature, which was fine while the only chain was the
        // tail. It stops being fine the moment a pectoral fin gets its own
        // spring: a fin is a short stiff blade on a 2-3 bone chain, and run at
        // the tail's numbers it trails as far as a tail does — over a span a
        // fifth as long, which reads as the fin having come unstuck rather than
        // as it flexing.
        //
        // So each chain in `rig.springChains` declares a role, and the number
        // here scales the solver for it. Higher = looser:
        //
        //   stiffness / L    lower L is a stiffer spring, so it keeps up better
        //   maxLag   * L     and is allowed to travel less far before the cap
        //   damping  / sqrt(L)
        //
        // That last one is the same correction boneSpring already applies along
        // a chain for `tipLooseness`, for the same reason: the damping RATIO is
        // what decides whether a spring wobbles or settles, and changing
        // stiffness without it turns a stiffer fin into a ringing one.
        //
        // 1.0 is "exactly the numbers above", so the tail is unscaled by
        // definition and every existing chain behaves as it always has.
        roleLooseness: {
          tail: 1.0,
          fin: 0.8, // eyeballed, not measured — it is a look, and it is on a slider
        },
    },
    },

    // ---------------------------------------------------------------------------
    // FINS — the front flippers are IK-driven to point wherever the player is
    // aiming, and bullets leave from their tips. These values write to the fin
    // bones ONLY (the chains named in ASSETS.<key>.fins); the spine, tail, head
    // and rear flippers keep whatever the animation clip gave them. See
    // systems/aimRig.js.
    // ---------------------------------------------------------------------------
    fins: {
      enabled: true,
      ik: true, // aim the flippers; off = they keep the clip's pose
      muzzle: true, // master switch for ALL bone emit points; off = everything fires from the body centre
      // How completely the aim pose replaces the clip. 1 = the fin bones are
      // fully owned by the IK. `idleWeight` is what's used while NOT firing, so
      // the flippers can keep most of their swim motion until you shoot.
      weight: 1.0,
      idleWeight: 0.55,
      weightLerp: 10, // how fast it eases between the two, per second
      smoothing: 18, // how fast the fins chase a moving aim (higher = snappier)
      iterations: 4, // CCD passes per frame per fin
      rootInfluence: 0.45, // 0..1 — how much of the turn the upper arm may take
      maxBend: 1.2, // radians a single fin bone may deviate from its keyframe
      softness: 1.0, // 1 = hard stop at maxBend; lower eases into it (see CONFIG.head)
      // The anti-pinch stop. maxBend above limits how far a bone TRAVELS from
      // its keyframe; these limit where it may END UP, measured from the pose
      // the model was authored in. The swim clip already folds a shoulder to 93
      // degrees, and the solver pushing that to 102 is what closes the armpit
      // and pinches the skin over it. Past these angles the pose is held at
      // whatever the CLIP does, so the guard can only ever take back something
      // the solver added — it never pulls a bone off a keyframe. `maxTwist` is
      // the cheaper win of the two: spinning a bone about its own length hardly
      // moves the tip, so the solver barely wants it, and it is the rotation
      // that wrings the skin out. See systems/ikChain.js and npm run test:rig.
      maxFold: 1.4, // radians (80 deg) off the rest axis
      maxTwist: 0.6, // radians (34 deg) about it
      reach: 3.0, // aim target distance, in chain lengths — >1 straightens the fin
      tolerance: 0.01, // world units; stop iterating once the tip is this close
      // Fire the one-shots as authored: while the roll/hit/bark/death clip is
      // playing the fins hand back to it entirely, rather than pointing
      // downrange through the middle of a barrel roll.
      releaseOnOneShot: true,
      // Two different points, and they were one for too long. `tipLengthMul`
      // scales the AIM effector, which lives past the skin on purpose (see the
      // fin defs in assets.js); `muzzleLengthMul` scales the visible emit
      // point, which is measured onto the outermost skinned vertex of the
      // flipper. Turning the first one up makes the seal aim harder; turning
      // the second one up slides the flash off the end of the fin.
      tipLengthMul: 1.0,
      muzzleLengthMul: 1.0,
      // World units further along the aim, past that edge. 0 = right on the
      // geometry, which is what the flash and the fin bubbles want. Replaces
      // `muzzleOffset` (0.35), which sat on top of an effector that already
      // overshot the skin and put the flash a fifth of a body-length out in
      // open water — renamed rather than re-defaulted, since a saved tuning
      // value beats a config default and the old number would have won.
      muzzleNudge: 0,
      flattenZ: true, // spawn bullets in the body's plane, not the fin's own depth
      alternate: true, // consecutive volleys start from the other flipper
    },

    // ---------------------------------------------------------------------------
    // EMIT POINTS — which bit of the seal each aimed weapon leaves from. Values
    // are 'fins' (both flipper tips), 'mouth', 'tail' or 'body'. Anything the
    // current ship model can't provide falls back to the body centre on its
    // own, so this is safe to point anywhere. The master on/off is
    // CONFIG.fins.muzzle. See systems/aimRig.js.
    //
    // 'fins' means something slightly different per weapon: the basic shot
    // fires from EVERY fin at once, while the missile volley walks across them
    // one missile at a time (CONFIG.fins.alternate rotates which one starts).
    // ---------------------------------------------------------------------------
    emitPoints: {
      bullet: 'fins',
      missile: 'fins',
      bounce: 'mouth',
      starfish: 'tail',
      // The scallop is spat, not thrown — it leaves the mouth and immediately
      // stops taking direction from the seal, which is the whole joke.
      scallop: 'mouth',
      oyster: 'fins',
    },

    // ---------------------------------------------------------------------------
    // TAIL — damped-spring secondary motion, NOT IK. The tail doesn't aim at
    // anything; it just declines to keep up with the body, so a turn leaves it
    // behind for a moment and it overshoots slightly settling back. Layered on
    // top of the swim clip, and like every other chain here it writes only to
    // the bones named in ASSETS.<key>.aimRig.tail. See systems/aimRig.js.
    // ---------------------------------------------------------------------------
    tail: {
      enabled: true,
      weight: 1.0, // how much of the lag is blended over the clip
      weightLerp: 8,
      stiffness: 120, // spring constant at the BASE of the tail
      damping: 14, // higher = less wobble; scaled per bone to hold the ratio
      tipLooseness: 0.65, // 0..1 — how much softer the tip is than the base
      maxLag: 0.45, // radians a tail bone may trail its keyframe
      softness: 0.5, // ease into that cap rather than snapping taut
      snapAngle: 1.4, // past this the spring resets instead of slinging the long way
      impulseTipBias: 0.9, // where a shove lands along the tail; 1 = all at the tip
      releaseOnOneShot: true,
    },

    // ---------------------------------------------------------------------------
    // HEAD — same IK as the fins, on the neck chain, so the seal LOOKS where
    // you're aiming. Same shape of config, very different numbers: a neck is
    // not a flipper, and the whole risk here is a head that detaches or spins.
    //
    // Three separate guard rails, because one wasn't enough:
    //   maxBend   how far a single neck bone may leave its keyframe. 0.32 rad
    //             over three bones is ~55 degrees of total turn — enough to
    //             read as looking, not enough to reach a pose the rig was never
    //             built for.
    //   softness  where the ease into that limit begins, as a fraction of it.
    //             Below 0.45*maxBend nothing is changed at all; past that the
    //             remaining travel compresses onto a curve that approaches the
    //             limit without hitting it, so the head glides to a stop
    //             instead of slamming into a wall and locking there.
    //   frontCone / backCone   the "don't reach around behind you" rule. Once
    //             the cursor is more than frontCone off the body's own facing
    //             the head progressively stops trying, and by backCone it has
    //             handed the pose back to the clip entirely — rather than CCD
    //             taking the geometrically-shortest route to a target behind
    //             the seal, which folds the neck down into its own chest.
    //             Measured against the CHEST, which this system never writes.
    // See systems/aimRig.js.
    // ---------------------------------------------------------------------------
    head: {
      enabled: true,
      weight: 0.85, // never quite 1: a trace of the clip's head motion stays
      idleWeight: 0.5,
      weightLerp: 6, // slower than the fins — a head turn is a lazier motion
      smoothing: 9, // low: the head trails the aim instead of snapping to it
      iterations: 3,
      rootInfluence: 0.25, // the base of the neck barely moves; the skull does the looking
      maxBend: 0.32, // radians per bone — the anti-broken-neck limit
      softness: 0.45, // fraction of maxBend where the ease-in to the stop begins
      // Where a neck bone may END UP, measured from the authored rest pose, as
      // opposed to how far maxBend lets it travel from this frame's keyframe.
      // Tighter than the fins on both counts: the throat has less skin to give
      // than an armpit does, and a neck that spins about its own axis is the one
      // failure that reads instantly as broken. See the note in CONFIG.fins.
      maxFold: 1.3, // radians (74 deg) off the rest axis
      maxTwist: 0.35, // radians (20 deg) about it
      frontCone: 0.9, // radians off the body's facing before the head starts giving up
      backCone: 1.7, // ...and where it has fully given up (~97 degrees)
      // As the head gives up on a target behind the seal it turns out toward
      // the viewer instead of just facing front — `cameraBias` is how far the
      // look target tilts onto the camera axis at full give-up, `glanceWeight`
      // is how much pose is left to express it with (0 = the old behaviour,
      // head simply returns to the clip).
      // `cameraBias` is now a BLEND toward the camera axis rather than a nudge
      // of +Z added to a target still pointing backwards — at full give-up the
      // head simply looks at the viewer, with no backward component left to
      // crane into. `peekKeepY` is how much of the target's height survives the
      // blend, so the peek still tips up or down toward whatever it lost.
      cameraBias: 0.85,
      peekKeepY: 0.35,
      glanceWeight: 0.45,
      // ...and the neck is no longer what reaches a target behind the animal:
      // the BODY twists to bring it into view, which is how a seal actually does
      // it. Additive on top of the mirror and the barrel roll (all three are the
      // same body transform — see entities/player.js), and eased so a cursor
      // flicking past the tail doesn't snap the whole animal round.
      craneAngle: 0.7, // radians of body twist toward the camera at full give-up
      craneLerp: 5,    // how fast the twist eases in and out
      reach: 4.0,
      tolerance: 0.01,
      releaseOnOneShot: true, // let the bark/roll/death clips own the head
    },

    // ---------------------------------------------------------------------------
    // ENEMY HEAD-LOOK — the hunters turn their heads toward what they're
    // chasing. Same CCD chain as the seal's neck above (systems/ikChain.js),
    // driven by systems/headLook.js off the target the creature is already
    // steering at, and scoped to the bones in ASSETS.<key>.lookRig.head.
    //
    // Every value here is deliberately more conservative than CONFIG.head, for
    // one structural reason: the seal has a real neck, and these animals mostly
    // don't. On shark.glb and megalodon the "head chain" runs
    // through SPINE bones, so the same rotation that tilts a seal's skull bends
    // a shark's whole front third. The bend cap, not the solver, is what keeps
    // that readable — see maxBend.
    // ---------------------------------------------------------------------------
    enemyLook: {
      enabled: true,
      weight: 0.55, // vs the seal's 0.85 — the clip keeps most of the head
      weightLerp: 3.5, // slow to commit; a shark doesn't snap its head round
      smoothing: 5, // low, so the head trails the target rather than tracking it
      iterations: 2, // 2 is plenty when maxBend stops it well short of converged
      rootInfluence: 0.2, // the base of the chain barely moves; the skull does the looking
      // Radians per bone, measured against the pose the clip wrote. ~10 degrees
      // — a lean, not a stare. This is the value that stops the chain being
      // broken by over-rotation, so treat it as the safety limit rather than as
      // a look-strength dial: turn `weight` up first if the gesture is too
      // subtle, and only raise this if the head still can't reach.
      maxBend: 0.18,
      softness: 0.4, // fraction of maxBend where the ease-in to the stop begins
      // Give up on anything too far round the body to reach without folding the
      // spine back through itself. Tighter than the seal's 0.9/1.7: a shark
      // that can't see its target simply turns, and its turnRate means the body
      // is already coming round anyway.
      frontCone: 0.7,
      backCone: 1.3,
      // ...and give up on distance too. Between these the look fades out.
      //
      // Sized against the hunters' own `preyRadius` (17 to 24, and the orca's
      // 34) so this never overrides a creature that is genuinely tracking
      // something — it exists for the other case, where `playerAggroRadius` is
      // unset and a shark steers at the player from clear across a ~92-unit
      // arena. Staring that far reads as possessed rather than as hunting.
      fadeRange: 24,
      maxRange: 36,
      reach: 4.0,
      tolerance: 0.01,
    },

    // ---------------------------------------------------------------------------
    // BITE — the hunters snap their jaws at whatever they are chasing, fish and
    // player alike. Driven from entities/enemies.js (the player) and
    // systems/predation.js (fish), performed by either an authored clip or the
    // procedural jaw in systems/jaw.js.
    //
    // The mouth OPENS BEFORE CONTACT, which is the whole point of `lead`. Fish
    // predation is instantaneous — resolvePredation deletes the fish the frame
    // it comes inside biteRange — so a bite fired on the eat would be a mouth
    // opening around nothing, after the meal had already vanished. Firing at
    // `lead` times the reach means the jaws are already wide when the fish gets
    // there and shut on it. Same for the player: contact damage is a
    // per-second drain, so the snap has to be its own event or nothing on
    // screen ever says the animal is biting you rather than bumping you.
    // ---------------------------------------------------------------------------
    bite: {
      enabled: true,
      // How far out the mouth starts opening, as a multiple of the reach the
      // bite actually lands at. 1 = no anticipation at all.
      lead: 2.2,
      // Fallback rate limit, in seconds. A species with a `hunt.biteCooldown`
      // (all of them do) uses that instead, so the snapping stays in step with
      // how often that predator can actually eat.
      cooldown: 1.1,
      // The player is not prey — nothing eats them, so there is no biteRange on
      // the def to reuse. This is the contact reach (hunter radius + player
      // radius) the snap fires at, as a multiple.
      playerReach: 1.35,

      // Procedural jaw timing (systems/jaw.js). Ignored by megalodon, which
      // plays its authored clip instead.
      jaw: {
        openTime: 0.16, // gape
        holdTime: 0.04, // ...held open for a beat
        closeTime: 0.09, // ...and shut, faster than it opened
    },

      // The last stretch, covered in a burst rather than at cruise. This is
      // what makes a bite read as a decision: the animal commits, and if you
      // move it misses and has to come round again.
      lunge: {
        enabled: true,
        speedMul: 1.85,
        duration: 0.3,
    },
    },

    // ---------------------------------------------------------------------------
    // HUNTER AGGRESSION RAMP — how much more single-minded the predators get as
    // a run goes on. Sits alongside CONFIG.spawn.ramp, which already scales hp,
    // damage and speed; this is the BEHAVIOURAL half of the same idea.
    //
    // Two dials, because they answer the two different ways a shark stops being
    // survivable:
    //
    //   preyFocus  Early on a shark is an opportunist — it breaks off for any
    //              fish inside `hunt.preyRadius`, and a live school is cover.
    //              Shrinking that radius over the run takes the cover away, so
    //              the same shark swims past the school and comes for you.
    //   turnRate   Sharks arc rather than pivot (see steerTo), so a wide turn
    //              circle is what lets you slip a charge. Tightening it is what
    //              makes late-run hunters actually able to corner you.
    //
    // Both are baked PER INSTANCE at spawn, exactly like hp/damage/speed and
    // for the same reason (see spawnOne): `def` is one object shared by the
    // whole species, so scaling it in place would retroactively re-tune every
    // shark already on screen. The consequence is that a shark keeps whatever
    // character it spawned with for its whole life, and the run gets meaner by
    // sending meaner NEW ones — which is how every other ramp here works.
    // ---------------------------------------------------------------------------
    hunterRamp: {
      enabled: true,
      // Fraction of the REMAINING prey distraction shed per difficulty point
      // (one point = 20s at the default difficultyPerSecond). 0.04 leaves a
      // shark at ~55% of its authored preyRadius after five minutes and ~30%
      // after ten.
      preyFocus: 0.04,
      // ...but never below this fraction of it. Zero would mean late-run sharks
      // ignore fish entirely, which also switches off the food chain — no
      // meals, so no growth and no overheal, and the "clear the school early"
      // decision stops existing. They should still eat; just not instead of
      // eating you.
      preyFocusMin: 0.3,
      // Compounding per difficulty point, capped as a multiple of the species'
      // own turnRate — same shape as the CONFIG.spawn.ramp entries.
      turnRate: 0.02,
      turnRateMax: 2.0,
    },

    // ---------------------------------------------------------------------------
    // BUBBLES — two emitters anchored to bones (see ASSETS.ship.aimRig.anchors):
    // a breath puff from the mouth on a loose timer, and a continuous wake whose
    // rate scales with how fast the seal is moving. The wake is born off the
    // hind flipper TIPS and along the tail, not from a single point — see
    // `tailShare` below.
    // Both are underwater-only; a breaching seal shouldn't be blowing bubbles
    // into the air. See systems/bubbles.js.
    // ---------------------------------------------------------------------------
    bubbles: {
      enabled: true,
      breath: {
        enabled: true,
        interval: [1.1, 2.6], // seconds between puffs, picked fresh each time
        scale: 0.7, // multiplier on the emitter's particle count
        speedScale: 0.35, // extra puff size at full speed — a working seal breathes harder
    },
      wake: {
        enabled: true,
        minSpeed: 2.5, // below this the tail isn't working hard enough to cavitate
        perSecond: 26, // emissions per second at maxSpeed, scaled down linearly
        scale: 0.55,
        // WHERE each burst is born, rather than how many there are — the rate
        // above is unchanged by either of these. See wakeOrigin in
        // systems/bubbles.js.
        //
        // The rest come off the two hind flipper TIPS, alternating. Those are
        // the surfaces pushing water, so most of the wake belongs to them;
        // this is the minority share that trails the tail as well.
        tailShare: 0.45,
        // How hard the tail's share crowds to the tip. The root of a tail
        // barely moves and the tip whips, so an even spread reads wrong — at 3,
        // half the samples land in the last sixth of the tail. 0 spreads them
        // evenly down its length.
        tipBias: 3,
    },
      // --- the wind-up vent ----------------------------------------------------
      // Charging a strike opens EVERY emitter on the seal at once — mouth and
      // tail together, on their own path rather than by leaning on the two
      // above. Neither of those would do it: breath is a puff on a 1-2s timer
      // and the wake is switched off entirely below `wake.minSpeed`, which is
      // exactly the case a wind-up is (you brake, you hold, you release).
      //
      // The rate ramps with BANKED POWER, not with elapsed time, so it answers
      // "how big is the strike I'm holding" rather than "how long has the button
      // been down". Those are the same thing while there is fuel in the bar and
      // deliberately diverge once it runs dry: the venting plateaus with the
      // power instead of climbing forever on a hold that is no longer buying
      // anything.
      //
      // At `perSecondMax` this is a lot of particles — that is the point, and
      // the cost is a share of a FIXED pool rather than memory: the ring in
      // entities/particles.js is CONFIG.fx.maxParticles wide and recycles
      // oldest-first, so an over-eager rate quietly evicts other effects.
      //
      // The budget, at the numbers below: ~30 particles a burst across the two
      // emitters, ~1.2s average bubble life, so a sustained full-power hold
      // sits at roughly 70 * 30 * 1.2 ~ 2500 alive — about a third of the 8000
      // pool. Loud, bounded, and it costs the seal's own oldest bubbles first.
      // Doubling `perSecondMax` would put the vent past half the pool and start
      // eating other people's explosions; that is the ceiling to weigh against.
      //
      // `maxPerFrame` is the same guard the wake has, for the same reason — one
      // long frame must not dump a second's backlog in a single burst.
      charge: {
        enabled: true,
        perSecondMin: 10, // bursts/sec (per emitter) the moment a wind-up starts
        perSecondMax: 70, // ...and at fully banked power
        scaleMin: 0.6,    // multiplier on each burst's particle count, at the start
        scaleMax: 1.9,    // ...and at full
        maxPerFrame: 6,   // per emitter, after a hitch
    },
    },

    audio: {
      enabled: true,
      masterVolume: 0.55,
      // How many one-shots may sound at once. Past this the newest sound still
      // plays and the voice with the least left to play is faded out under it
      // (see systems/audio.js) — so this is a density control, not a cliff.
      //
      // It was 12, sized when every sound was a synthesised oscillator. A
      // buffer source is far cheaper than an oscillator plus a filter plus an
      // envelope, and the bus already carries a compressor and a soft ceiling
      // for exactly the case of a dozen one-shots landing on one frame, so the
      // old number was protecting against something that is now handled a
      // stage later. At 12 a wave clear spent the entire budget on `kill`
      // alone — 20/s against a tail that long is more than twice the cap — and
      // every other sound in the game went silent behind it.
      //
      // 32 is measured, not chosen. A heavy wave clear (~41 sounds a second,
      // real sample lengths) wants 21.5 voices on average and peaks near 32,
      // and a sweep of the cap against that load has its knee exactly there:
      //
      //     cap 12 -> 40 steals/s     cap 32 -> 0.1 steals/s
      //     cap 16 -> 37 steals/s     cap 40 -> 0 steals/s
      //     cap 24 -> 11 steals/s     cap 64 -> 0 steals/s
      //
      // Nothing above 32 buys anything: demand stops at 21.5 whatever the cap
      // is, so a bigger number only widens a headroom nobody uses.
      //
      // NOT saved tuning: this is stripped out of any snapshot on the way in
      // (see withoutTableOwnedKeys) so config.js owns it outright. A cap that
      // can be quietly restored to an old value by a months-old localStorage
      // snapshot is a bug nobody can see, which is precisely how it survived.
      maxConcurrent: 32,

      // PRIORITY — which sound wins when they can't all be heard.
      //
      // The cap above and the `sfxMinGap` throttles both have to throw
      // something away, and until this existed neither of them knew WHERE any
      // of it happened. Both picked on timing alone — newest wins at the cap,
      // first wins in a throttle window — so a kill at the far wall could cut
      // the hit landing on the seal's nose, and one pellet resolving early
      // could hold a window shut against eleven closer ones. Distance is the
      // information that was missing: the same event is worth a slot on top of
      // you and worth nothing across the arena.
      //
      // Distance is quantised into BANDS rather than compared raw, so that
      // "about as close" stays a real state and the older least-left-to-play
      // rule still decides inside it. Ranking on raw distance would silently
      // replace that rule, since no two distances are ever equal.
      //
      // A sound with no position — every UI click, the level-up, the death —
      // is always top band, so this can only take from the world.
      priority: {
        enabled: true,
        // Inside this radius everything is "on top of you" and ranks top.
        // The frame is ~92 units wide at 16:9, so 18 is roughly the seal and
        // what is brawling with it.
        nearRadius: 18,
        // At and beyond this a sound is bottom band — first to be cut, and the
        // first to lose a throttle window. The arena is twice the frame wide
        // (arena.widthScale), so 70 is comfortably off-screen sideways.
        farRadius: 70,
        // How many rungs between the two. More bands means distance decides
        // more often and the tail rule less; at 1 the whole mechanism is off.
        // It also bounds the throttle: a window can be broken open at most
        // (bands - 1) times, because only a strictly closer call may do it.
        bands: 4,
    },

      // REPETITION — what stops a fast sound turning to static.
      //
      // Three separate things make a repeating sound read as noise, and this
      // block only fixes one of them, so it is worth naming all three:
      //
      //   SUMMING       copies overlap each other's tails and their energies add.
      //                 That is what this fixes.
      //   PERIODICITY   a FIXED throttle is a metronome. Twenty identical hits a
      //                 second on an exact 50ms grid is a 20Hz pulse train, which
      //                 is literally a tone. `gapJitter` below fixes that.
      //   SAMENESS      one take, played identically every time. Only more takes
      //                 (or wider `pitchVary`) fix that.
      //
      // Each rapid repeat of the same SOUND plays quieter than the one before,
      // recovering as soon as it stops firing. Keyed by sound rather than by
      // event, because sound copies are what pile up — `kill` and `debrisBreak`
      // are two events sharing one voice.
      repetition: {
        enabled: true,
        // Seconds for the crowding to fade. At 0.5 a sound fired once a second
        // is essentially untouched, while one fired twenty times a second sits
        // at the floor within a quarter second.
        recovery: 0.5,
        // How hard the ducking bites per stacked copy. Higher = quieter sooner.
        strength: 0.35,
        // Never below this fraction of the sound's own gain. The floor is what
        // keeps a sustained wall of hits audible AS a wall — at 0 a firefight
        // would go silent, which is a worse bug than the buzz.
        floor: 0.25,
    },

      // +/- fraction applied to every event's `sfxMinGap`. Small, and it is not
      // about taste: a fixed gap makes a burst of hits perfectly periodic, and
      // the ear hears a periodic train of identical clicks as a PITCH rather than
      // as clicks. Jittering the gap breaks the phase lock, and the same wall of
      // hits becomes texture instead of tone.
      sfxGapJitter: 0.35,
      // Shared filter + reverb every SFX passes through on its way out. Music
      // has its own chain and is NOT affected by these. Tune in the T-menu's
      // Sound tab, under "Master FX bus".
      bus: {
        filterType: 'lowpass',
        // 20kHz is effectively "off" for a lowpass — above hearing, so the
        // filter is inaudible until you actually pull it down.
        filterHz: 20000,
        filterQ: 1,
        // 0 = fully dry. The dry/wet crossfade is equal-power, so the total
        // loudness stays put as you move it.
        reverbMix: 0,
        reverbSeconds: 1.6, // tail length
        reverbDecay: 2, // higher = faster fall-off = smaller room
        // Ties the bus cutoff to how deep the player is, the same way the music
        // filter works — but with its OWN range. SFX sit in a different part of
        // the mix and want a much narrower sweep than the score; borrowing the
        // music's clamps turns every hit to mud the moment you leave the
        // surface. While this is on, it owns the cutoff and `filterHz` above is
        // ignored.
        depth: {
          enabled: false,
          surfaceHz: 20000,
          deepHz: 5000,
          smoothing: 0.15,
        },

        // DYNAMICS — light glue compression, makeup, and a soft ceiling. This is
        // what lets the per-sound gains be driven hard: the bank's samples arrive
        // with a ~20dB spread as authored, so getting the quiet ones audible
        // means large gains, and a dozen one-shots landing on one frame then sums
        // past full scale. Without a ceiling that is a click rather than a loud
        // sound. See the diagram above buildBus in systems/audio.js.
        comp: {
          // Off unpatches the compressor entirely rather than setting it
          // transparent, because the node adds a few ms of lookahead delay even
          // when it is doing nothing. `makeup` and `ceiling` stay live either
          // way — the ceiling is a safety rail, not an effect.
          enabled: true,
          threshold: -18, // dB, where it starts working
          knee: 12, // dB of soft transition around the threshold
          ratio: 3, // gentle. Above ~6 this stops being glue and starts pumping
          attack: 0.005, // fast enough to catch an impact, slow enough to let it crack
          release: 0.18, // long enough that a burst of hits reads as one event
          // What the compressor took off, put back. THIS is the loudness knob —
          // the compressor alone only makes the mix smaller.
          makeup: 1.6,
          // Soft-clip ceiling, 0..1 of full scale. A hard bound: the output can
          // never exceed it however hard the bus is driven. It is the curve's
          // ASYMPTOTE, so the practical maximum sits a little under — at these
          // defaults a full-scale input comes out around 0.88 rather than 0.95,
          // which is a bound erring on the safe side and is the point.
          ceiling: 0.95,
          // Where the bend starts, as a fraction of the ceiling. Everything below
          // `ceiling * ceilingKnee` passes through bit-exact, so this is really
          // "how much of the range stays untouched" — at 0.6 the ceiling is doing
          // nothing at all until a peak is within about 5dB of full scale.
          ceilingKnee: 0.6,
          // 'none' | '2x' | '4x'. The ceiling is a nonlinearity and generates
          // harmonics above Nyquist that fold back as aliasing; oversampling is
          // the difference between a driven bus sounding saturated and it
          // sounding gritty.
          oversample: '2x',
        },
    },
    },

    // `pitchVary` is a +/- fraction applied to playback rate / oscillator
    // frequency each time the sound fires, so repeated shots never phase into
    // one flat machine-gun tone. `filterVary` does the same for the noise
    // filter cutoff. Pickups get a wide clamped spread (a little melodic
    // randomness reads as pleasant); weapons stay tight so they still feel
    // like one consistent gun, with a touch of detune/noise instead.
    // `src` holds a user-uploaded sample (data URL) — when set it plays
    // INSTEAD of the synth, with the same pitch/filter variation applied.
    sfx: {
      // Six takes, and the reason there are six is the fire rate: the basic shot
      // goes off several times a second, and one sample at that rate turns into a
      // machine-gun rattle no amount of pitch variation hides. `pickSample` never
      // plays the same take twice running, so a burst is a run of different
      // mouths rather than one repeated.
      shoot:     { srcs: [
        '/sfx/Seal_Shoot_01.mp3',
        '/sfx/Seal_Shoot_02.mp3',
        '/sfx/Seal_Shoot_03.mp3',
        '/sfx/Seal_Shoot_04.mp3',
        '/sfx/Seal_Shoot_05.mp3',
        '/sfx/Seal_Shoot_06.mp3',
      ], gain: 0.16, pitchVary: 0.04 },
      hit:       { src: null, type: 'noise', filter: 2600,     decay: 0.08, gain: 0.20, pitchVary: 0.10, filterVary: 0.20 },
      // Thunder, synthesised rather than sampled — there is no thunder in the
      // sfx library and `boom` is already exactly the right shape for it: a
      // pitch sweeping down through the floor with a big noise bed over it,
      // which is what thunder is. Both take a `src`/`srcs` like any other voice
      // if you'd rather drop real recordings in later.
      //
      // The crack is the longest voice in the table by some way. A short one
      // reads as a gunshot; what makes thunder thunder is the tail.
      thunderCrack:  { src: null, type: 'boom', freq: [110, 22], decay: 1.8, gain: 0.5, noise: 0.95, filter: 700, pitchVary: 0.18, filterVary: 0.3 },
      // Distant sheet lightning: no crack at all, just the rumble arriving late
      // and filtered by a few miles of air.
      thunderRumble: { src: null, type: 'noise', filter: 320,   decay: 2.4, gain: 0.26, pitchVary: 0.2, filterVary: 0.35 },
      kill:      { src: null, type: 'boom',  freq: [220, 50],  decay: 0.34, gain: 0.34, noise: 0.5, filter: 1400, pitchVary: 0.12, filterVary: 0.18 },
      bigKill:   { src: null, type: 'boom',  freq: [150, 32],  decay: 0.6,  gain: 0.45, noise: 0.7, filter: 900,  pitchVary: 0.12, filterVary: 0.18 },
      // Nine takes, and it needs every one of them: getting hit is the sound a
      // player hears most in a bad run, and a repeated yelp stops reading as pain
      // and starts reading as a sound file.
      playerHit: { srcs: [
        '/sfx/Seal_PlayerHit_01.mp3',
        '/sfx/Seal_PlayerHit_02.mp3',
        '/sfx/Seal_PlayerHit_03.mp3',
        '/sfx/Seal_PlayerHit_04.mp3',
        '/sfx/Seal_PlayerHit_05.mp3',
        '/sfx/Seal_PlayerHit_06.mp3',
        '/sfx/Seal_PlayerHit_07.mp3',
        '/sfx/Seal_PlayerHit_08.mp3',
        '/sfx/Seal_PlayerHit__09.mp3',
      ], gain: 0.4, filter: 1100, pitchVary: 0.08, filterVary: 0.15 },
      // The player dying. Was borrowing `bigKill` — the sound of killing
      // something, played at the moment you are the thing that died. Long,
      // because the death dive that follows it is long: the body sinks for
      // several seconds and this is what carries them.
      //
      // The gain is measured rather than guessed. These takes average ~10dB
      // quieter than the sample `bigKill` uses, so 2.2 puts the death at roughly
      // the level the biggest kill in the game sits at, which is where the
      // player's own death belongs.
      playerDeath: { srcs: [
        '/sfx/Seal_Death_01.mp3',
        '/sfx/Seal_Death_02.mp3',
        '/sfx/Seal_PlayerDeath_03.mp3',
      ], gain: 2.2, filter: 900, pitchVary: 0.06, filterVary: 0.15 },
      bite:      { src: null, type: 'noise', filter: 1200,     decay: 0.18, gain: 0.26, pitchVary: 0.14, filterVary: 0.25 },
      // The hoover, not the bite: darker, softer and shorter than `bite`, so a
      // crab working through an orb sits under the fight instead of on top of
      // it. Wide pitch/filter variation because several animals feed at once and
      // identical copies of a quiet noise burst read as a machine, not a mouth.
      chumSlurp: { src: null, type: 'noise', filter: 520,      decay: 0.13, gain: 0.09, pitchVary: 0.22, filterVary: 0.35 },
      // Pitch is NOT random for pickups — it tracks XP progress toward the
      // next level, sweeping a full octave from 0% to 100%. Collecting chum
      // becomes an audible progress bar: the closer to levelling, the higher
      // the note. pitchVary stays 0 so that reading isn't muddied by noise.
      pickup:    { src: null, type: 'blip',  wave: 'triangle', freq: [620, 1180], decay: 0.12, gain: 0.16, pitchVary: 0 },
      levelUp:   { src: null, type: 'blip',  wave: 'triangle', freq: [440, 1320], decay: 0.5,  gain: 0.26, pitchVary: 0.03 },
      splash:    { src: null, type: 'noise', filter: 3400,     decay: 0.3,  gain: 0.24, pitchVary: 0.12, filterVary: 0.22 },
      // Coming out of the water, as opposed to something landing in it. It used
      // to share `splash` with a fisherman being knocked off a deck, which meant
      // the seal's own most athletic move sounded like a body hitting the sea.
      // One take, so `pitchVary` does more work here than anywhere else in the
      // table — it is the only thing keeping a repeated breach from reading as a
      // loop.
      breach:    { srcs: ['/sfx/Seal_Breach_01.mp3'], gain: 1.0, filter: 3400, pitchVary: 0.14, filterVary: 0.22 },
      bounce:    { src: null, type: 'blip',  wave: 'sine',     freq: [300, 120],  decay: 0.12, gain: 0.14, pitchVary: 0.16 },
      // --- the sky ------------------------------------------------------------
      // THE CELESTIAL BANK. Both entries are arrays for the reason `shoot` and
      // `playerHit` are, turned inside out: those need takes because they fire
      // constantly and one sample becomes a rattle; these fire a handful of
      // times in a good run, and a player who hears the SAME chime the third
      // time they thread the sun learns it is a sound file rather than a place.
      // A rare event gets exactly one chance to feel like an event.
      //
      // The two banks are disjoint on purpose, and it is the only thing telling
      // you which body you went through without looking: bright, struck and
      // metallic for the sun, soft and swelling for the moon. Nothing in the
      // library was authored for this — these are synth takes doing a job —
      // so the wide pitch spread is load-bearing rather than decorative.
      celestialSun:  { srcs: [
        '/sfx/HGUI_Organ_Gyro.mp3',
        '/sfx/HG_SF_FX_Arp2600_SpringShot_3.mp3',
        '/sfx/Juno60_blips_050.mp3',
      ], gain: 0.85, filter: 6000, pitchVary: 0.10, filterVary: 0.18 },
      // Pitched DOWN of its own accord (the takes are lower to begin with) and
      // filtered further: the moon is the quiet one everywhere else in this
      // config and it should be here too.
      celestialMoon: { srcs: [
        '/sfx/Pilea_059.mp3',
        '/sfx/Juno60_blips_043.mp3',
      ], gain: 0.7, filter: 2600, pitchVary: 0.12, filterVary: 0.22 },
      // The body hitting the seabed. Low and dull with the noise doing most of
      // the work — sand, not stone. It plays through the death dive's rate
      // scale like everything else, so it arrives even lower and longer than
      // this: these numbers describe it at full speed.
      seabedThud: { src: null, type: 'boom',  freq: [110, 34],  decay: 0.85, gain: 0.4,  noise: 0.85, filter: 480, pitchVary: 0.05, filterVary: 0.15 },
      // THE DASH. Note the name: the dash fires the `strike` event (see
      // CONFIG.feedback.strike and the call site in main.js), NOT `boost` —
      // `boost` is the weapon's recoil plume and always has been, despite what
      // its comment used to claim. The Seal_Boost_* takes are the dash's, and
      // this is where they belong.
      //
      // `pitchVary` is deliberately modest even though the tuned value for the
      // old one-second blip was much wider: these takes run 2 to 3.5 seconds, and
      // a +/-50% spread on a sample that long is the difference between a
      // chipmunk and a foghorn rather than a bit of variety. The dash also
      // carries its own pitch from the charge (`sfxOpts` at the call site), so
      // random pitch on top of that blurs the one thing the sound is telling you.
      strike:    { srcs: [
        '/sfx/Seal_Boost_01.mp3',
        '/sfx/Seal_Boost_02.mp3',
        '/sfx/Seal_Boost_03.mp3',
        '/sfx/Seal_Boost_04.mp3',
      ], gain: 1.51, filter: 2200, pitchVary: 0.12, filterVary: 0.15 },
      strikeChain: { src: null, type: 'blip', wave: 'sawtooth', freq: [420, 1500], decay: 0.22, gain: 0.28, pitchVary: 0.05 },
      // ONE PIP OF THE METER FILLING. The most repeated sound in the strike
      // loop by a distance — five to twelve of these per link — so it is short,
      // quiet and soft-edged, and it is a triangle rather than the sawtooth
      // `strikeChain` uses so the two never sound like the same event.
      //
      // The caller pitches it up per pip (see onPip in main.js), which is what
      // turns a magnet sweep into an ascending run instead of six identical
      // clicks. `pitchVary` is 0 for the same reason it is 0 on foodChain: the
      // pitch IS the reading — how close the bar is to full — and randomness
      // would blur the one thing it says.
      strikePip: { src: null, type: 'blip', wave: 'triangle', freq: [660, 900], decay: 0.09, gain: 0.13, pitchVary: 0 },
      // The FOOD CHAIN! announcement. Pitched up per link by the caller like
      // `strikeChain` is, so a deep chain climbs — but where that one is a thin
      // tick riding on top of an impact, this is the fanfare underneath it, so
      // it's low, long and has body. pitchVary stays 0: the pitch IS the combo
      // depth here, and randomness would blur the reading.
      // NOTE: the caller pitches this up per link, and `playbackRate` doubles as
      // pitch for a sample — so the takes climb with the combo exactly the way
      // the synth version did. `pitchVary` stays 0 for the same reason it always
      // did: the pitch IS the combo depth here, and randomness would blur it.
      foodChain: { srcs: [
        '/sfx/Seal_FoodChain_01.mp3',
        '/sfx/Seal_FoodChain_02.mp3',
        '/sfx/Seal_FoodChain_03.mp3',
      ], gain: 0.65, filter: 2200, pitchVary: 0, filterVary: 0.1 },
      // --- oxygen -------------------------------------------------------------
      // The warning beep's pitch is driven, not random — it climbs as oxygen
      // runs out (see CONFIG.oxygen.fx.beepPitchRise), so how close you are to
      // drowning is audible without looking at the bar. pitchVary stays 0 so
      // that reading isn't muddied, same reasoning as `pickup`.
      oxygenWarn: { src: null, type: 'blip',  wave: 'square',   freq: [1046, 990], decay: 0.1,  gain: 0.13, pitchVary: 0 },
      // A gasp. Repeats on a timer for as long as you're topping up at the
      // surface, so refilling sounds like a seal gulping air rather than one
      // sound effect that happens to be long.
      breathIn:   { src: null, type: 'noise', filter: 1700,     decay: 0.42, gain: 0.24, pitchVary: 0.08, filterVary: 0.25 },
      // Rising sine — a bubble bursting reads as an upward bloop, where the
      // falling sweep the other pickups use reads as something landing.
      bubblePop:  { src: null, type: 'blip',  wave: 'sine',     freq: [260, 1500], decay: 0.09, gain: 0.22, pitchVary: 0.18 },
      // The mussel launch: a low thump with a lot of noise in it — a wet, heavy
      // thing being thrown, pitched well below the pea-shooter `shoot` blip so a
      // volley cuts through a firefight already full of it.
      missileLaunch: { src: null, type: 'boom', freq: [260, 60], decay: 0.26, gain: 0.32, noise: 0.65, filter: 1800, pitchVary: 0.10, filterVary: 0.20 },
      // The barrage: the same wet thump dropped an octave and given a long
      // tail, so eight shells leaving at once read as ONE heavy release rather
      // than as a fast burst of the single-shell sound. Low pitchVary on
      // purpose — this fires at most once per full charge, so it should sound
      // like the same event every time instead of wandering.
      musselBarrage: { src: null, type: 'boom', freq: [190, 38], decay: 0.52, gain: 0.44, noise: 0.7, filter: 1500, pitchVary: 0.04, filterVary: 0.15 },
      // The detonation at the far end of the flight. Pitched ABOVE the launch
      // and much shorter — the launch is a heavy thing being thrown and this is
      // it coming apart, so it cracks rather than thumps, and the two stay
      // tellable apart when a volley's launches and impacts overlap.
      missileImpact: { src: null, type: 'boom', freq: [420, 70], decay: 0.22, gain: 0.36, noise: 0.85, filter: 2800, pitchVary: 0.12, filterVary: 0.22 },

      // --- companion abilities -------------------------------------------------
      // Until now every passive ability was silent, or borrowed a sound that
      // belonged to something else — the calamari wave played `boost`, a beluga
      // trap played `hit`, a dumbo charm played `pickup`. Six abilities can be
      // running at once, so each one needs a voice you can pick out of the mix
      // without it competing with gunfire. The rule across this block: passives
      // sit LOW and SHORT (they repeat on a timer forever), and the one-off
      // moments — a haul landing, a wave going out — are allowed to be big.

      // The discharge itself. A lot of noise through a bright filter is what
      // reads as electricity; the pitch drop across the decay is the arc
      // collapsing rather than a tone playing.
      eelBolt:   { src: null, type: 'boom',  freq: [900, 180],  decay: 0.18, gain: 0.26, noise: 0.75, filter: 3400, pitchVary: 0.10, filterVary: 0.30 },
      // One tick per hop down the chain, pitched UP per link by the caller — so
      // a five-target chain is an ascending run and you can hear how far it
      // travelled without counting corpses. Deliberately tiny: this fires up to
      // `maxChain` times per bolt.
      eelChain:  { src: null, type: 'blip',  wave: 'sawtooth', freq: [1400, 820], decay: 0.06, gain: 0.10, pitchVary: 0.03 },

      // A seal hitting something at speed. Pitched between `bite` and `kill`:
      // it's a body blow, not a mouthful and not a death.
      sealRam:   { src: null, type: 'boom',  freq: [300, 80],   decay: 0.20, gain: 0.28, noise: 0.55, filter: 1500, pitchVary: 0.12, filterVary: 0.20 },
      // The charge leaving formation — water moving, no impact. Filtered low so
      // it reads as a swimming thing accelerating rather than a whoosh in air.
      sealLunge: { src: null, type: 'noise', filter: 900,       decay: 0.24, gain: 0.16, pitchVary: 0.14, filterVary: 0.28 },
      // The evolved squad's gunfire. The player's own `shoot` transposed down a
      // fifth and quieter, so a six-seal volley is audibly THEM and never
      // masks the shot you fired yourself.
      sealShot:  { src: null, type: 'blip',  wave: 'square',   freq: [600, 175],  decay: 0.08, gain: 0.09, pitchVary: 0.06, detune: 20 },

      // The shockwave going out. The lowest thing in the game bar `bigKill` —
      // a pulse you feel more than hear, which is the point of pairing it with
      // the heaviest haptic in the table.
      calamariPulse: { src: null, type: 'boom', freq: [190, 52], decay: 0.46, gain: 0.30, noise: 0.35, filter: 750, pitchVary: 0.06, filterVary: 0.15 },

      // The aura ticking. This one repeats forever while you stand in a crowd,
      // so it's the quietest entry in the whole table and heavily filtered —
      // felt as a pulse under the mix, not heard as an event.
      garlicTick: { src: null, type: 'noise', filter: 520,      decay: 0.16, gain: 0.07, pitchVary: 0.10, filterVary: 0.20 },
      // A shrimp connecting: a small dry clack, high and instant, so a ring of
      // eight of them reads as a rattle rather than a drone.
      shrimpHit:  { src: null, type: 'noise', filter: 3100,     decay: 0.05, gain: 0.11, pitchVary: 0.18, filterVary: 0.25 },
      // The club connecting. A low wooden thud — `boom` with the noise dialled
      // up and the filter low, which is the same recipe as the escort seal's
      // ram because it is the same event: a heavy blunt object hitting a fish.
      // Shorter decay than the ram, though, since this one repeats.
      clubWhack:  { src: null, type: 'boom',  freq: [260, 70],  decay: 0.14, gain: 0.26, noise: 0.6, filter: 1200, pitchVary: 0.14, filterVary: 0.22 },
      // A body caroming off another. Drier and higher than the whack, so a
      // chain of them reads as a run of clacks under the thud that started it.
      clubRicochet: { src: null, type: 'noise', filter: 2100,   decay: 0.07, gain: 0.13, pitchVary: 0.16, filterVary: 0.25 },
      // A club thrown. The whoosh of something heavy leaving a hand, not an
      // impact — low noise swept short, so it sits under the strike's own bark
      // instead of competing with it.
      clubThrow:  { src: null, type: 'noise', filter: 800,      decay: 0.18, gain: 0.16, pitchVary: 0.20, filterVary: 0.30 },
      // Powder Keg. A short, dry crump rather than the long boom a boat gets —
      // this repeats, and anything with a tail on it turns a crowd into a
      // rumble that never stops.
      clubBoom:   { src: null, type: 'boom',  freq: [180, 50],  decay: 0.22, gain: 0.3, noise: 0.65, filter: 900, pitchVary: 0.12, filterVary: 0.22 },
      // Cold Snap locking a body. A falling sine — the opposite shape to the
      // beluga's rising trap, because this one closes on the creature rather
      // than sealing around it.
      clubFreeze: { src: null, type: 'blip',  wave: 'sine',     freq: [900, 180], decay: 0.2, gain: 0.16, pitchVary: 0.14 },
      // An enemy sealed inside a bubble. Rising sine, same "something closed
      // around it" shape as `bubblePop` reversed.
      belugaTrap: { src: null, type: 'blip',  wave: 'sine',     freq: [170, 880],  decay: 0.17, gain: 0.15, pitchVary: 0.12 },
      // ...and the same bubble letting go. Noise, not a tone: the trap sound is
      // pitched because something closed, and a burst has no pitch to it at
      // all. Filtered high and cut short so it lands as the tail of the rising
      // blip rather than as a second event competing with it, and quieter than
      // the trap for the same reason.
      belugaPop:  { src: null, type: 'noise', filter: 2600,     decay: 0.11, gain: 0.12, pitchVary: 0.18, filterVary: 0.28 },
      // The net closing on a fish and dragging it off. Longer than any other
      // passive here because a haul IS the whole ability paying off.
      bakalarHaul:{ src: null, type: 'noise', filter: 1400,     decay: 0.32, gain: 0.22, pitchVary: 0.10, filterVary: 0.22 },

      // --- Glow Up! ---------------------------------------------------------
      // These play UNDER the shot that carried them, on the same frame, so all
      // of them are quiet and short. `elementHit` in particular fires on every
      // pellet that connects — it is the most frequent voice in this table
      // after the gun itself, and anything with a tail here becomes a drone.
      elementHit: { src: null, type: 'blip',  wave: 'triangle', freq: [1500, 2200], decay: 0.045, gain: 0.06, pitchVary: 0.22 },
      // The arc. Short, bright and dry — a crackle rather than the eel's
      // full-length discharge, because this is one hop and not a chain.
      elementArc: { src: null, type: 'noise', filter: 4200,     decay: 0.09,  gain: 0.13, pitchVary: 0.20, filterVary: 0.30 },
      // Water going hard. Falling rather than rising, the opposite shape to
      // belugaTrap's closing bubble — one thing seizes up, the other encloses.
      elementFreeze: { src: null, type: 'blip', wave: 'sine',   freq: [900, 260],   decay: 0.2,  gain: 0.16, pitchVary: 0.12 },
      // The burst. Low and wet, so a chain reaction rolls through the mix
      // rather than clicking through it.
      infectionBurst: { src: null, type: 'noise', filter: 900,  decay: 0.26, gain: 0.2,  pitchVary: 0.14, filterVary: 0.25 },
      // A hop landing on a new host. Barely there by design — see the note on
      // the feedback entry; the motes crossing the gap are the real event.
      infectionSpread: { src: null, type: 'blip', wave: 'sine', freq: [640, 1180],  decay: 0.07, gain: 0.05, pitchVary: 0.3 },
      // Charm. The one deliberately pleasant sound in the block — rising
      // triangle, no aggression in it, because the enemy isn't being hurt.
      dumboCharm: { src: null, type: 'blip',  wave: 'triangle', freq: [880, 1560], decay: 0.28, gain: 0.14, pitchVary: 0.08 },
      // The dive. Falling sawtooth — a bird committing to a stoop.
      seagullDive:{ src: null, type: 'blip',  wave: 'sawtooth', freq: [1500, 480], decay: 0.30, gain: 0.16, pitchVary: 0.10 },

      // Scallops. The launch is a wet spit; the jet is deliberately the
      // quietest thing in this table — it fires dozens of times a second across
      // a full stack, so anything with body would become a drone.
      // Deliberately the quietest of the new samples: this fires once per volley
      // with a full stack of twelve scallops in the water, and it is furniture
      // around the jet rather than an event of its own.
      scallopLaunch: { srcs: [
        '/sfx/Seal_ScallopSquirt_01.mp3',
        '/sfx/Seal_ScallopSquirt_02.mp3',
        '/sfx/Seal_ScallopSquirt_03.mp3',
      ], gain: 0.8, filter: 1900, pitchVary: 0.14, filterVary: 0.25 },
      scallopJet:    { src: null, type: 'noise', filter: 2600, decay: 0.09, gain: 0.05, pitchVary: 0.22, filterVary: 0.30 },

      // Pearls. A hard glassy tick going out, a bright sparkle coming back.
      pearlShot:  { src: null, type: 'blip',  wave: 'sine',     freq: [1200, 640], decay: 0.22, gain: 0.17, pitchVary: 0.07 },
      pearlBurst: { src: null, type: 'blip',  wave: 'triangle', freq: [1800, 2600], decay: 0.18, gain: 0.12, pitchVary: 0.16 },

      // The octopus. A soft suck on the grab, a wet pop on the payoff.
      octoGrab:   { src: null, type: 'noise', filter: 900,  decay: 0.14, gain: 0.07, pitchVary: 0.12, filterVary: 0.20 },
      octoPop:    { src: null, type: 'blip',  wave: 'sine', freq: [420, 180], decay: 0.20, gain: 0.18, pitchVary: 0.12 },

      // Three tonnes of orca into a wooden hull.
      orcaStrike: { src: null, type: 'boom',  freq: [150, 44], decay: 0.52, gain: 0.32, noise: 0.45, filter: 620, pitchVary: 0.08, filterVary: 0.18 },

      // The bomb: a hollow clunk as it goes in, and the biggest boom in the
      // table when it goes off.
      // --- the menus ------------------------------------------------------------
      // The only sounds in the table that are not the game making a noise — they
      // are the INTERFACE answering you, and they follow different rules for it.
      //
      // Four takes on the hover because it is the most repeated sound in the
      // whole bank per second of exposure: sweeping a mouse across four upgrade
      // cards fires it four times inside half a second, and one blip repeated at
      // that rate is a rattle. Quiet, too — a hover is an acknowledgement, not an
      // event, and it should be under the click by a clear margin or picking a
      // card feels no different from passing over one.
      //
      // These four sit within about 3dB of each other as authored, which is why
      // they are the four: a variation set that jumps in level reads as a bug in
      // the menu rather than as variety.
      uiHover:   { srcs: [
        '/sfx/HG_UI_Blip_Menu_Blockhead.mp3',
        '/sfx/HG_UI_Blip_Menu_Blicky-converted.mp3',
        '/sfx/HG_UI_Blip_Menu_Terminal-converted.mp3',
        '/sfx/HG_UI_Blip_Menu_Spat-converted.mp3',
      ], gain: 0.68, pitchVary: 0.06 },
      // And the commit. Two takes rather than four: a confirmation wants an
      // identity, and too much variation stops it reading as the same answer
      // every time. Both are matched to within a fifth of a dB.
      uiClick:   { srcs: [
        '/sfx/HG_UI_Blip_Menu_Tappies-converted.mp3',
        '/sfx/HG_UI_Blip_Menu_Static-converted.mp3',
      ], gain: 1.0, pitchVary: 0.03 },

      // --- the rarity stings --------------------------------------------------
      // ONE of these plays as the level-up menu opens, for the best tier on the
      // table (see bestRarity). They are a LADDER and have to be heard as one:
      // the same gesture climbing in pitch, length and weight, so "that was a
      // better one than last time" is legible before you have read a single
      // card.
      //
      // `rarityCommon` is deliberately absent from rarities.csv's sfx column by
      // default and left here only so a project that wants a floor-tier tick
      // has something to point at. Most level-ups in a run are floor-tier, and
      // a sound on those is the interface announcing that nothing happened.
      //
      // Synthesised rather than sampled on purpose: what matters is that the
      // five are unmistakably the same sound at five heights, and five separate
      // takes would each have their own character fighting that.
      rarityCommon:    { src: null, type: 'blip', wave: 'triangle', freq: [420, 560],  decay: 0.1,  gain: 0.06, pitchVary: 0.04 },
      rarityUncommon:  { src: null, type: 'blip', wave: 'triangle', freq: [520, 780],  decay: 0.16, gain: 0.11, pitchVary: 0.03 },
      rarityRare:      { src: null, type: 'blip', wave: 'sine',     freq: [620, 1080], decay: 0.26, gain: 0.15, pitchVary: 0.02 },
      // The top two get a longer tail and a wider interval — the reach of the
      // sweep is what separates "good" from "drop everything".
      rarityEpic:      { src: null, type: 'blip', wave: 'sine',     freq: [700, 1560], decay: 0.4,  gain: 0.19, pitchVary: 0.02 },
      rarityLegendary: { src: null, type: 'blip', wave: 'sine',     freq: [780, 2340], decay: 0.62, gain: 0.24, pitchVary: 0.01 },
      // The keystroke. Synthesised rather than sampled — this is the one menu
      // sound with no file behind it, because what it needs is to be tiny and
      // slightly different every time, and that is exactly what the synth path
      // is good at. A single sampled take repeated twelve times in two seconds
      // is a machine gun; `pitchVary` at 0.18 is what stops it.
      //
      // A short DOWNWARD blip: up reads as confirmation, and a name half typed
      // is not a confirmation of anything. 40ms decay keeps a fast typist's
      // ticks from overlapping into a tone.
      uiType:    { src: null, type: 'blip', wave: 'square', freq: [1500, 1150], decay: 0.04, gain: 0.30, pitchVary: 0.18 },

      bakalarBombDrop:  { src: null, type: 'blip', wave: 'square', freq: [300, 150], decay: 0.18, gain: 0.13, pitchVary: 0.10 },
      bakalarBombBlast: { src: null, type: 'boom', freq: [130, 34], decay: 0.85, gain: 0.38, noise: 0.55, filter: 520, pitchVary: 0.05, filterVary: 0.20 },
    },

    // ---------------------------------------------------------------------------
    // FLIGHT SFX — the sound a projectile makes WHILE it's travelling, as
    // opposed to the one-shots in CONFIG.sfx above. Keyed by asset name, the
    // same way CONFIG.trails is, so anything with an entry here gets a voice
    // and anything without stays silent in flight.
    //
    // These can't be CONFIG.sfx entries: a one-shot is fired and forgotten,
    // whereas a voice is a little synth per shell whose pitch, brightness, pan
    // and level are rewritten every frame from what that shell is actually
    // doing. See systems/projectileVoices.js for the graph. What the mussel's
    // voice is FOR is filling the gap between the launch thump and the impact
    // crack, which used to be several seconds of silence with five shells
    // visibly hunting across the arena.
    // ---------------------------------------------------------------------------
    flightSfx: {
      enabled: true,
      gain: 1, // master over every voice, on top of each preset's own `gain`
      // Continuous sound is far more expensive in the MIX than in the CPU: past
      // a handful of shells the extra voices add level without adding anything
      // you can pick out. Shells beyond the cap simply fly silently.
      maxVoices: 5,
      // Seconds of glide on every per-frame parameter write. Without it, 60
      // discrete steps a second on a swept frequency is audible zipper noise —
      // on exactly the sweeps this system exists to produce.
      smoothing: 0.03,

      missile: {
        enabled: true,
        gain: 0.11,
        attack: 0.14, // fades in behind the launch thump rather than under it
        release: 0.08, // ramped, not cut — a stopped oscillator clicks

        // --- speed ------------------------------------------------------------
        // The shell's speed maps across this range onto every "how hard is it
        // working" parameter below. Spans launch jitter (speed * 0.75) up past
        // the base speed, so a fast shell is audibly faster.
        speedRange: [8, 22],
        toneWave: 'sawtooth', // harmonics, so the pitch sweep survives small speakers
        toneHz: [130, 300], // the burn, slow shell -> fast shell
        toneQ: 3,
        toneGain: 0.5,
        toneFilterHz: [700, 3000], // opens up as it accelerates
        subRatio: 0.5, // the weight underneath, one octave down
        subGain: 0.3,
        noiseGain: 0.45, // the water going past
        noiseAtRest: 0.35, // fraction of that hiss at the bottom of speedRange
        noiseHz: [500, 2200],
        noiseQ: 1.1,

        // --- velocity ---------------------------------------------------------
        // Doppler off the measured rate of closure with the seal. Taking it from
        // the distance between frames rather than the shell's own velocity means
        // the player's movement counts too, so strafing past a shell in flight
        // shifts it the way moving past a real source would. `dopplerRef` is the
        // closing speed that reaches full shift.
        doppler: 0.2, // +/- this fraction of pitch at full closing speed
        dopplerRef: 34,

        // --- direction --------------------------------------------------------
        // The seeker, and the most characterful part of the voice: how fast the
        // heading is CHANGING drives a warble on top of the pitch. A shell on
        // rails runs clean; one carving after a target wobbles hard, so you can
        // hear it hunting without looking at it. `turnRef` is the turn rate that
        // reaches full wobble — matched to missile.turnRate, i.e. flat out.
        turnRef: 4.5,
        turnSmoothing: 0.12, // seconds; raw per-frame turn is far too spiky
        warbleHz: [3, 16], // wobble rate, straight -> hard turn
        warbleCents: [0, 90], // wobble depth
        panWidth: 18, // world units from the seal for a full-width pan
        panAmount: 0.8, // never hard-panned; a shell isn't ONLY in one ear

        // --- lifetime ---------------------------------------------------------
        lifeRise: 0.28, // pitch climbs this fraction across the whole flight
        lifeFade: 0.5, // seconds of life left over which it burns out

        // --- placement --------------------------------------------------------
        falloff: 14, // world units at which it's half as loud
        spreadCents: 60, // per-shell detune, so a volley is five voices not one
    },
    },

    // HAPTICS — controller rumble. Per-event patterns live in CONFIG.feedback
    // below, as `haptic`. These are the global shaping controls on top of them.
    //
    // A pattern can be a millisecond on/off list ([30, 25, 45] — pulse, gap,
    // pulse), in which case intensity is derived from that event's `shake` via
    // the curve below, or a list of explicit pulses when you want to author the
    // feel directly: [{ duration: 30, magnitude: 1 }, { duration: 60, magnitude: 0.4 }].
    haptics: {
      enabled: true,
      intensity: 1, // master multiplier over every magnitude
      // For ms patterns, strength comes from the authored pulse LENGTH — not from
      // the event's shake, so screen shake and rumble stay independent.
      fullAtMs: 45, // pulse length that should rumble at full strength
      curve: 0.6, // <1 lifts the small stuff so light taps are still felt
      floor: 0.15, // weakest rumble worth sending; below this motors don't spin
      // Split across the pad's two motors. Strong is the heavy low-frequency
      // one, weak the high-frequency buzz.
      strongRatio: 1,
      weakRatio: 0.45,
      minDuration: 20, // ms — anything shorter never spins up at all
      maxDuration: 1000,

      // MIXING — sum overlapping events instead of letting the loudest replace
      // the rest. See the long note above the mixer in systems/haptics.js for
      // why this can't be done on the pad and has to be done in software.
      //
      // What it buys: a fast fire rate fuses into a steady bed, and a kill adds
      // ON TOP of that bed instead of erasing it and handing it back. What it
      // costs: everything running at once now contributes, so the quiet
      // passives are audible in a way they weren't when the loudest event was
      // the only one being felt.
      mixing: {
        enabled: true,
        // 'soft' | 'linear' | 'max'. 'max' reproduces the old replace-based
        // feel exactly — flip to it for a straight A/B without touching
        // anything else.
        sumMode: 'soft',
        // How often the summed total is re-sent. Onsets do NOT wait for this —
        // adding a voice ticks immediately, so this is the refresh rate of the
        // bed, not the latency of a hit.
        tickMs: 40,
        // Each effect is sent this many ticks long so consecutive ones overlap.
        // Below ~1.5 the motor drops into the gap between effects and a held
        // bed buzzes at the tick rate instead of holding steady.
        overlap: 2.5,
        // Linear fall after a pulse's hold, in ms. THE knob for how fused a
        // stream of events feels: at 0 a volley is separate taps, at 150 a fast
        // fire rate is one continuous hum. Raise it to thicken the bed.
        release: 70,
        // Don't re-send for changes smaller than this — motors have nothing
        // like float resolution and every send costs the browser a preempt.
        minStep: 0.02,
        ceiling: 1, // total is clamped here; below 1 leaves permanent headroom
    },
    },

    // ---------------------------------------------------------------------------
    // TOUCH — the two floating virtual sticks on a phone. See input.js for how a
    // finger claims one; these are the numbers that decide how they FEEL.
    // ---------------------------------------------------------------------------
    touch: {
      // CSS px of travel from where the thumb landed that counts as full
      // deflection. Deliberately an absolute length rather than a fraction of the
      // screen: what it's really measuring is thumb reach, which is the same
      // handful of millimetres on a phone as on a tablet.
      stickRadius: 55,
      // Travel below this reads as centred. Small on purpose — the anchor is
      // wherever you put your thumb, so there's no spring-back pulling the stick
      // off centre and nothing for a wide deadzone to protect against.
      deadzone: 6,
      // Fraction of the canvas width the left (movement) stick owns. Everything
      // to the right of it belongs to the aim stick.
      splitX: 0.5,
      // With a thumb on the move stick and none on aim, point the ship where it's
      // swimming. Without this the aim direction just sticks at whatever it was
      // when the aim thumb lifted, so one-thumbed swimming leaves the seal facing
      // backwards.
      aimFollowsMove: true,

      // STRIKE — a charge-and-release with no shoulder button to live on. Both
      // routes below are live at once and OR together, exactly like LB/RB/LT/RT
      // do on a pad, so either can wind the same single meter.
      //
      //   thirdTouch  any finger beyond the two sticks charges for as long as
      //               it's down. It has to land in a half that already has a
      //               thumb in it — an empty half still means "I want that
      //               stick" — so in practice it's a second finger next to
      //               whichever thumb is already planted.
      //   doubleTap   tap a half, then press and hold it again. The hold charges
      //               AND still drives that half's stick, so you keep steering
      //               and aiming through the entire wind-up.
      //
      // Neither needs to supply a direction: the dash launches along movement
      // and only falls back to aim from a standstill (see main.js).
      strike: {
        thirdTouch: true,
        doubleTap: true,
        doubleTapMs: 300, // longest gap from the tap's release to the re-press
        tapMaxMs: 250,    // a press held longer than this is a stick grab, not a tap
        tapSlop: 16,      // px the tap may drift and still count as a tap
    },
    },

    // ---------------------------------------------------------------------------
    // POST — full-screen shader stack. Switch presets live in the tuning panel,
    // or cycle them with the P key.
    // ---------------------------------------------------------------------------
    post: {
      enabled: true,
      preset: 'crt',
    },

    // ---------------------------------------------------------------------------
    // GLOW SOURCE — where a creature's emissive comes from, which decides what
    // the bloom bright-pass in systems/post.js actually picks up.
    //
    //   emissiveMaps: false  the existing behaviour. A lit model's emissive is
    //     seeded from its diffuse colour, so turning the glow slider up lights
    //     the WHOLE body evenly and bloom haloes the entire silhouette.
    //
    //   emissiveMaps: true   assets that name `texture.emissive` get that
    //     high-contrast mask on emissiveMap, so only the bright markings glow —
    //     an orca's eye patches and belly, a shark's counter-shaded underside —
    //     and the body stays dark. The glow slider still controls strength, it
    //     just drives a pattern instead of a flood.
    //
    // Masks live in public/textures/emissive and were generated from each
    // model's own base-colour texture (see tools/make-emissive-masks.mjs), so
    // they line up with the UVs already on the model — no re-authoring.
    //
    // Defaults OFF so the game looks exactly as it did; this is an A/B you flip
    // in the tuner ("Glow" panel) rather than a change to how anything renders.
    // An asset with no mask is unaffected either way.
    glow: {
      emissiveMaps: false,
      // How hard a masked creature glows, for any creature whose own glow
      // slider has never been touched. Only used while `emissiveMaps` is on —
      // a lit model sits at emissiveIntensity 0 by default, so without this the
      // toggle would attach the masks and render nothing at all. Reclaimed the
      // moment the toggle goes off, or the moment you set that creature's glow
      // by hand.
      maskIntensity: 1.0,
    },

    // ---------------------------------------------------------------------------
    // SEAL SURFACE NOISE — procedural Perlin mottling on the player, because
    // furseal.glb ships no texture at all and renders as one flat colour.
    // Injected into the standard material's diffuse, so lighting, shadows and
    // the emissive map all still apply; see systems/noiseShader.js.
    //
    // Opt-in per asset via `noiseShader: true` in ASSETS — only the seal uses
    // it today, but nothing about it is seal-specific.
    // ---------------------------------------------------------------------------
    sealShader: {
      enabled: true,
      // Feature size in WORLD UNITS, not a frequency — bigger number, bigger
      // blobs. (The shader divides by it, so this reads the way you'd expect
      // rather than backwards.) The seal is ~2.6 units long, so 0.4 gives
      // roughly six patches down its body.
      size: 0.4,
      strength: 0.35, // how far the base colour is pulled toward `color`
      contrast: 1.0, // >1 pushes toward hard patches, <1 toward a soft wash
      color: 0x0a2233, // what the dark side of the noise mixes toward
    },

    // ---------------------------------------------------------------------------
    // THE SEAL READS ITS OWN METER — the charge state, on the animal.
    //
    // The ring says how much boost there is; this says the same thing on the
    // body, so it can be read without looking away from what you're about to
    // hit. It lights the markings `sealShader` above already paints, exactly
    // the way Glow Up! does — but through a SECOND, independent set of shader
    // uniforms, because the element layer early-outs at level 0 and most runs
    // never take that card. See systems/chargeSkin.js.
    //
    // COLOUR IS NOT HERE ON PURPOSE. It is read straight out of
    // CONFIG.strike.ring (`color` while filling, `readyColor` at full) so the
    // meter and the animal can never disagree about what state the run is in.
    // Recolouring the ring recolours the seal.
    // ---------------------------------------------------------------------------
    sealCharge: {
      enabled: true,
      strength: 0.9, // peak glow on a full bar, before `fullBoost`
      // EMPTY HAS TO READ AS EMPTY. Above 1 this bends the ramp so the bottom
      // of the range goes genuinely dark rather than merely dimmer — at a
      // linear 1.0 a bar at 20% still looks lit, and "I cannot strike" is the
      // one state that must be unmistakable at a glance.
      falloff: 1.35,
      fullBoost: 1.25, // extra multiplier once the bar is actually full

      // The breath. Slow and shallow while filling — barely a shimmer — then
      // opening up at full, so "loaded" is a change of STATE rather than the
      // same animation running brighter. It holds indefinitely: the player has
      // to be able to look back ten seconds later and still see it.
      pulseSpeed: 1.1,
      pulseAmp: 0.08,
      fullPulseSpeed: 2.4,
      fullPulseAmp: 0.30,
      // Locked to the music the same way every other glow in the game is, or
      // left free. See systems/beatSync.js.
      pulseSync: 'free',

      // The crossing flash: one band of light running head to tail on the frame
      // the bar fills. Doing double duty on purpose — filling the meter inside
      // a live combo is also what scores a FOOD CHAIN link, so one animation
      // teaches the whole eat-strike-eat loop.
      wave: {
        enabled: true,
        duration: 0.5, // seconds for the band to travel nose to flukes
      },

      // Mask shape, matching setNoiseGlow's arguments so both layers answer to
      // the same numbers on the same markings.
      coverage: 0.3,
      contrast: 2.2,
      white: 0.35,
      tipColor: 0xffffff,
    },

    // ---------------------------------------------------------------------------
    // BIOLUMINESCENT SKIN — procedural glow patterns painted across a whole
    // body, one shared setting for every creature carrying `biolumSkin: true`
    // in ASSETS. Today that is the lanternfish alone; nothing here is specific
    // to it. See systems/biolumSkin.js.
    //
    // NOT the same system as `octoGrab.glow`. That one lights REGIONS on
    // command (which arm is working, right now) and is driven by gameplay. This
    // one is surface pattern with no gameplay behind it — the procedural
    // equivalent of an emissive map, except you can audition seven of them on a
    // dropdown instead of repainting a texture.
    // ---------------------------------------------------------------------------
    biolumSkin: {
      enabled: true,

      // BASE is what every glowing creature starts from; a PRESET below is what
      // one species overrides. Any key absent from a preset falls through to
      // here, which is what lets "glow strength" be one slider that moves the
      // whole family while a species still gets to disagree about its pattern.
      //
      // An asset opts in with `biolumSkin: '<preset name>'` in ASSETS.
      base: {
      // One of BIOLUM_PATTERNS in systems/biolumSkin.js. The tuner offers these
      // as a dropdown and switching costs no recompile, so this is meant to be
      // flipped through while a school is on screen.
      pattern: 'blotches',
      // Feature size as a FRACTION OF BODY LENGTH, not world units — 0.25 is
      // roughly four features down the fish whatever size the model or the
      // per-asset Size slider makes it. This is the one number that would have
      // been silently wrong in world units.
      scale: 0.25,
      // The fallback for a material attached with no preset of its own; every
      // preset in the roster overrides it, so this is not what the glowing
      // creatures run on — see the presets below and the note on
      // `lantern.strength` for how those are sized against the clip.
      //
      // Above 1 on purpose: post.js runs the BRIGHT PASS through a HalfFloat
      // target, so an over-bright value blooms there rather than clipping. The
      // catch, and the reason every preset now sits near 1, is that the bright
      // pass is not the composite — the composite is LDR and clips at 1.0, so
      // a value chosen for the bloom's benefit flattens the pattern and the
      // breath in the frame underneath it.
      //
      // 1.8, not the 2.4 this used to declare: a saved snapshot had been
      // pinning it at 1.8, so 2.4 was never the number running. Reconciled
      // rather than restored — 1.8 is what has actually been on screen.
      strength: 1.8,
      // ONE KNOB FOR THE WHOLE FAMILY'S BLOOM, multiplied onto `strength`.
      //
      // Two controls rather than one because they answer different questions.
      // `strength` is per species and says how bright THIS animal is next to
      // the others — tuning worth keeping once the palettes settle. `glow`
      // says how hard the family as a whole pushes past the bloom threshold,
      // which is a decision about the whole screen and gets re-made whenever
      // CONFIG.bloom moves.
      //
      // Watch the readout in the tuner group, not this number: post.js's
      // bright pass thresholds REC.709 LUMINANCE, so a deep blue at 1.0 counts
      // as 0.07 and a pale cyan at the same strength counts as 0.71. Which
      // colours in a ramp bloom is a question about the palette at least as
      // much as about this slider.
      glow: 1.35,
      contrast: 1.6, // >1 hardens the edge of each feature, <1 softens to a wash
      coverage: 0.45, // how much of the body lights at all, 0..1
      // How fast the whole field drifts, as a rate through the NOISE FIELD —
      // roughly "features per second", not distance across the body. A preset
      // that samples at a multiple of the base frequency (speckle, at 4x)
      // travels across the animal proportionally slower for the same number
      // here, which is why `lantern` sets its own.
      //
      // 0.3, not the 0.05 this used to hold. Every preset had been carrying a
      // saved `flow: 0.3` of its own, so the base was dead and its value was
      // never the one running — dropping those copies is what surfaced it.
      // At 0.05 a stripe took 36 seconds to cross an abyss shark; at 0.3 it
      // takes 6, which is what the presets were authored against.
      flow: 0.3,
      // A slow breath over everything, so a stationary fish is never a static
      // decal. Amplitude is a fraction of full brightness.
      pulseAmp: 0.25,
      // ONE BREATH PER `pulseSync`. A name from BEAT_DIVISIONS in
      // systems/beatSync.js, picked in the tuner with a button row; the
      // breath then keeps time with whatever loop is playing and retimes
      // itself when the BPM moves or the death dive drags the tape down.
      //
      // The `pulse` pattern's travelling wave rides the same clock at twice
      // the rate, which is the ratio it had when both came off `pulseSpeed`.
      pulseSync: '2 bars',
      // What the breath does when `pulseSync` is 'free' (or the master switch
      // in CONFIG.beatSync is off). Radians per second, which is what it has
      // always been — 1.8 is one breath every 3.5s, and '2 bars' is the
      // closest musical figure to it at 105bpm. Kept rather than deleted so
      // turning sync off is a real A/B and not a jump to some other look.
      pulseSpeed: 1.8,
      // The colour field's own feature size, independent of the pattern's — a
      // big number means one colour drifts across the whole animal, a small one
      // means neighbouring patches disagree.
      hueScale: 1.2,
      hueSpread: 1.0, // 0 collapses the ramp to one colour; 1 uses all three
      // IS THIS PATTERN LIGHT, OR IS IT PIGMENT? True for every preset that
      // means "this animal emits"; false for one that is only borrowing the
      // generator to paint a surface.
      //
      // It reads as a technicality and it is not. The whole roster used to be
      // luminous, so "has a biolumSkin" and "is bioluminescent" described the
      // same set of creatures and either could stand in for the other. The day
      // crab breaks that: `carapace` is a shell texture — dim, static, brown —
      // on a creature that must NOT be night-gated. Without a flag saying so,
      // the only way to tell the two apart is to eyeball `strength`, and the
      // invariant that a glowing creature never spawns at noon (asserted in
      // tools/biolum-skin-test.mjs) quietly stops meaning anything.
      luminous: true,
      // --- the eyes, as a separate lamp -------------------------------------
      // Not part of the body pattern and not scaled by its `strength`: a crab's
      // eyes sit on stalks and should read as two hot points whatever the shell
      // is doing. Only creatures whose asset declares `eyeStalks` have anything
      // to light, so `eyeStrength` here is the default for the ones that do.
      //
      // OFF in the shared base, ON per preset. Every glowing fish in the roster
      // inherits this block, and none of them has an eye stalk to put it on.
      eyeStrength: 0,
      // Which colour the eyes burn. Warm by default and that is a BLOOM
      // decision, not only a taste one: the bright pass is Rec.709 luminance,
      // where blue counts for 0.07 against green's 0.72, so a cold blue eye can
      // be visibly bright on screen and never reach the bloom threshold at all.
      eyeColor: 0xffd166,
      // Where along the stalk the light actually sits. aEyeGlow is a linear
      // 0..1 from socket to tip, so this is the exponent that concentrates it:
      // 1 lights the whole stalk evenly (a glowing antenna), 3 keeps the stalk
      // dark and blows out the last third (an eyeball), 6 is a pinpoint.
      eyeFalloff: 3,
      // A slow bloom in and out, on the body's own breath clock so the two
      // never drift apart. Shallower than the body's `pulseAmp` on purpose —
      // an eye pulsing as hard as the shell reads as a blinking indicator.
      eyePulse: 0,
      // Positive concentrates the glow toward the tail, negative toward the
      // head, 0 lights evenly.
      tailBias: 0.2,
      // The same bias applied to the RAMP rather than to brightness: positive
      // pushes the tail end toward colorC and the head end toward colorA, so
      // the animal changes colour along its length instead of merely getting
      // brighter. 0 leaves the ramp wherever the pattern put it, which is what
      // every preset written before this knob existed expects.
      //
      // This is what buys a two-tone creature without a second material. See
      // `emberClaw`: one ramp, dark red at the shell, ember at the claws.
      hueBias: 0,
      // How far the organic patterns (flow, billow, marble) displace their own
      // sample point before reading it. 0 leaves them as ordinary noise; this is
      // the single control that turns lumps into something that looks advected.
      // Same operation the menus' dissolve field uses — see ui/dither.js.
      warp: 0.8,
      // How far the BODY under the glow is darkened. The glow is additive, so
      // this is what decides whether it reads as light coming out of the animal
      // or as a bright animal — at 1 the pattern washes into an already-lit
      // body and the shapes disappear.
      bodyDarken: 0.35,
      colorA: 0x00e5ff, // the ramp, low to high
      colorB: 0x7b2dff,
      colorC: 0xffd166,

      // --- flicker -------------------------------------------------------------
      // A stutter over the top of the breath, driven by value noise in time
      // rather than a sine — a sine is a throb, and `pulseAmp` is already that.
      // 0 is off, which is where every preset that wants to look calm leaves it.
      flickerAmp: 0,
      // ONE STUTTER STEP PER `flickerSync`. Its own division rather than the
      // breath's, because the two are usually nowhere near each other: a
      // shark breathing on four bars still wants its photophores twitching on
      // eighths. The stutter is value noise, so quantising it means the noise
      // CHANGES VALUE on the grid — the light still wanders, it just stops
      // wandering off the beat.
      flickerSync: '1/8',
      flickerRate: 2.5, // stutters per second when `flickerSync` is 'free'

      // How far apart in the cycle two individuals of the same species are. 1
      // scatters them across the whole cycle; 0 collapses a school into perfect
      // unison, which is worth having as a setting because it is the only way to
      // judge a pattern without nine bodies disagreeing about it.
      //
      // This is the ONE setting that needs a material per creature rather than
      // per species — see instantiateBiolumSkin.
      phaseSpread: 1,
      // HOW MANY SLOTS that spread is allowed to use. This is the setting that
      // makes a school musical rather than merely desynchronised: at 0 every
      // fish sits a random fraction of a beat off the grid, which quietly
      // undoes `pulseSync` one creature at a time. At 4, a school on '1 bar'
      // breathes on the four beats of the bar, in whatever order they were
      // born in — a section, not mush.
      //
      // Set it to the number of subdivisions you want to hear. 2 is call and
      // response, 4 is a bar of quarters, 8 gets busy.
      phaseSteps: 4,

      // --- the school wave -----------------------------------------------------
      // A slow noise field filling the WATER, which every glowing creature
      // reads at wherever it is floating. Everything else in this block is
      // sampled in the animal's own bind pose and belongs to that animal; this
      // is the one term that belongs to the ocean, so a shoal drifting through
      // it lights a few fish at a time in the order the field reaches them.
      //
      // It dims rather than brightens (the field is a 0..1 noise mixed toward,
      // like the flicker), so a fish at the trough goes dark and one at the
      // crest keeps its full glow. That direction matters: brightening would
      // push the crest past the clip and the whole effect would land in white.
      //
      // `schoolSpeed` lives on the base ONLY — it is the current, and one
      // ocean has one of those. Amp and scale resolve per preset, so a species
      // out of the water column can opt out (see `carapace`).
      schoolAmp: 0.45, // 0 = off. 1 would take a trough to black.
      // World units per noise feature. Schools spawn with a spread of about 4
      // units in an 80-unit arena, so at 7 a feature is a little wider than a
      // school — the wave arrives at one end and leaves at the other instead
      // of switching all of it at once.
      schoolScale: 7,
      // World units per second. At 4 a feature crosses a school in under two
      // seconds and the whole arena in twenty.
      schoolSpeed: 4,
    },

    // -------------------------------------------------------------------------
    // PRESETS — one per glowing species. Each is a DIFF against `base`.
    //
    // These are meant to be told apart at a glance in a crowded arena, so they
    // are pulled apart on the two axes the eye sorts fastest: colour, then
    // rhythm. Pattern is the third, and matters least at gameplay distance.
    // -------------------------------------------------------------------------
    presets: {
      // The schooling fish. Fine, dense points — a shoal of lights rather than
      // one lit animal, which is the read that survives nine of them at once.
      lantern: {
        pattern: 'speckle',
        scale: 0.22,
        coverage: 0.5,
        contrast: 2.4,
        // Sized against the CLIP, not by eye against bloom. The pattern is
        // ADDED to an LDR composite, so `strength * glow` is a ceiling on the
        // lit core: at the old 2.0 the core sat at 4.0 and three quarters of
        // the mask resolved to identical white, which flattened the speckle
        // into one blob AND hid the breath inside it (the whole cycle ran
        // 3.20..4.80, entirely above 1.0). At 0.8 the core lands at 1.08, so
        // the breath crosses 1.0 — peaks still clip and bloom, troughs read as
        // dark — and 93% of the mask carries visible detail. See
        // systems/glowDebug.js, and `npm run test:glowphase` for the numbers.
        strength: 0.8,
        // Faster than `base` because SPECKLE IS SAMPLED AT 4x FREQUENCY
        // (bioVoronoi(bp * 4.0 + drift)), and `flow` is a rate through the
        // noise field, not across the body. At the base 0.3 a dot took 60
        // seconds to travel the length of a fish that is on screen for about
        // five, so the pattern only ever churned in place. 0.9 crosses the
        // body in ~30s and turns a dot over every 1.7s, which is the shimmer
        // this preset is after. 0.6 rather than the 0.9 first tried here —
        // dialled back in game and adopted from the snapshot, which is where
        // this and the strengths below were settled.
        flow: 0.6,
        tailBias: 0.1,
        // Fast and shallow: a shoal should shimmer, not blink.
        flickerAmp: 0.35,
        flickerRate: 5.0,
        pulseAmp: 0.2,
        pulseSpeed: 2.4,
        // The divisions nearest the two rates above at 105bpm, so nothing
        // about the shoal's tempo visibly moved when it went on the grid —
        // 2.4 rad/s is a breath every 2.6s against a bar's 2.29s, and 5
        // stutters a second is 0.2s against a sixteenth's 0.14s.
        pulseSync: '1 bar',
        flickerSync: '1/16',
        // Nine at once, so this is the preset the spread actually matters for.
        // Four slots on a one-bar breath puts the shoal on the four beats.
        phaseSteps: 4,
        colorA: 0x00e5ff, colorB: 0x7b2dff, colorC: 0xffd166,
      },

      // The ray. Broad flat wings are the one body in the roster with room for
      // a big pattern, so it gets the folded veining — on a fish that shape
      // reads as noise, on a wingspan it reads as markings.
      //
      // Slow everything. A ray glides; a fast flicker on one would look like a
      // different animal wearing its body.
      veil: {
        // MEASURED, not chosen: rendered against all ten, marble and flow both
        // dissolve on this body — the game's side-on camera sees a ray almost
        // edge-on, so a pattern that needs area to read has none. `net` lights
        // the wing EDGE, which is the part of a ray that is always facing you.
        pattern: 'net',
        scale: 0.42,
        coverage: 0.5,
        contrast: 1.8,
        // Scaled by the same factor as every other preset, so the family keeps
        // the relative brightness it was tuned with — the ray stays dimmer
        // than the shoal and the abyss shark stays brightest. See the note on
        // `lantern.strength` for what the number is measured against.
        strength: 0.7,
        warp: 1.3, // more fold than the fish — the wings can carry it
        flow: 0.09,
        tailBias: -0.15, // weighted forward, onto the wings, not the whip tail
        flickerAmp: 0.12,
        flickerRate: 1.2,
        pulseAmp: 0.35,
        pulseSpeed: 0.7,
        // Four bars a breath, which is the nearest figure to its 9s glide and
        // the slowest thing on screen. Rays arrive alone, so the phase spread
        // has nobody to spread against — the steps here only matter on the
        // rare frame two are in the water at once.
        pulseSync: '4 bars',
        flickerSync: '1/2',
        phaseSteps: 2,
        colorA: 0x1de5c8, colorB: 0x2f6fd6, colorC: 0xbdf5ff, // cold
      },

      // NO `escort` PRESET. The seal team used to carry one — a restrained
      // glow, deliberately dimmer than the fish so the squad didn't out-light
      // the animal it was escorting. It is gone because the escorts now wear
      // the player's own noise mottling instead (CONFIG.sealShader, via
      // `noiseShader: true` on the sealTeam asset), which is the same surface
      // on the same species rather than a second, unrelated pattern painted
      // over it. See systems/noiseShader.js for why the seal's markings are
      // not a biolum skin.

      // The second and third shoals. Both exist so a night is not one school
      // repeated, and both are pulled away from `lantern` on the two axes the
      // eye sorts fastest at gameplay distance — COLOUR first, then RHYTHM.
      // Pattern is the third axis and the weakest: on a 0.4-unit fish twenty
      // metres away, net and speckle are both "textured", but cyan and gold
      // are never the same thing.
      //
      // Their strengths match the family's, so all three shoals sit at the
      // same brightness and the palettes do the separating. See the note on
      // `lantern.strength` for what those numbers are measured against.

      // Warm and slow. Reads as the reef waking up rather than as deep water,
      // which is what makes it worth having next to the cold lanternfish.
      reefGlow: {
        pattern: 'net', // seams and cell borders — a coral read, not a photophore one
        scale: 0.3,
        coverage: 0.42,
        contrast: 2.0,
        strength: 0.8,
        tailBias: 0.15,
        // Half the lanternfish's rate on both clocks. Two shoals stuttering at
        // the same speed read as one species in two colours; the difference in
        // TEMPO is most of what makes them separate animals.
        flickerAmp: 0.18,
        flickerSync: '1/8',
        pulseAmp: 0.28,
        pulseSync: '2 bars',
        phaseSteps: 4,
        colorA: 0xffc14d, colorB: 0x7bd66b, colorC: 0xfff2b8, // warm gold to green
      },

      // Cold violet, sparse and sharp. Discrete photophores rather than a
      // wash, so at distance it reads as a scatter of moving points — the
      // densest-looking of the three despite the lowest coverage.
      dartGlow: {
        pattern: 'spots',
        scale: 0.18, // small and many; these are organs, not patches
        coverage: 0.34,
        contrast: 2.8,
        strength: 0.8,
        tailBias: -0.1, // weighted forward, so a school shows its heads
        // The fastest of the three, and the only one on a sixteenth — a darting
        // fish should look nervous next to the lanternfish's shimmer.
        flickerAmp: 0.4,
        flickerSync: '1/16',
        pulseAmp: 0.22,
        pulseSync: '1 bar',
        phaseSteps: 8, // busier subdivision to match the busier fish
        colorA: 0xc86bff, colorB: 0x4b5bff, colorC: 0xe9d7ff,
      },

      // The shark. Not a light show — a warning. Stripes down a long body, low
      // coverage so it is mostly dark animal with a few burning lines, and the
      // one preset in ember rather than a cold palette, because it is the only
      // one that is supposed to read as a threat rather than as scenery.
      abyssHunter: {
        pattern: 'stripes',
        scale: 0.55, // few, wide bands — a shark is long, and 20 stripes is a fish
        coverage: 0.28,
        contrast: 3.0,
        // The brightest of the family, and still the brightest after the
        // rescale — see `lantern.strength`. Its 0.45 breath is the deepest in
        // the set, so it is also the one that most needed the room: the swing
        // now runs 0.71..1.88 through the clip instead of 2.64..6.96 above it.
        strength: 0.95,
        tailBias: -0.35, // brightest at the head, which is the end that matters
        hueSpread: 0.55, // a narrow ember range, not the full three-stop rainbow
        // Slow, deep breath and no stutter. The menace is that it is steady.
        flickerAmp: 0,
        pulseAmp: 0.45,
        pulseSpeed: 0.55,
        // The slowest thing in the roster: one breath every four bars, which
        // is nine seconds at 105bpm and is meant to be felt rather than
        // watched. Never more than one on screen, so the spread is moot.
        pulseSync: '4 bars',
        // No flickerSync of its own: flickerAmp is 0, so there is no stutter
        // to put on a grid. Pinning a division on a silent effect is a value
        // that looks meaningful and isn't — it inherits base's instead, which
        // is what it will use the moment anyone turns the flicker up.
        phaseSteps: 0,
        colorA: 0xff4d2e, colorB: 0xffa62b, colorC: 0xfff1a8, // ember
      },

      // --- the two crabs -------------------------------------------------------
      // The first preset pair in the file, and the first that is NOT about
      // bioluminescence at all on one side of it. Both ride the same shader for
      // the same reason: a crab's shell is mottled, and the pattern generator
      // already makes mottling. What separates them is whether the mottling is
      // LIGHT or merely COLOUR.

      // DAYTIME. Every walking crab wears this, which makes it the only preset
      // in the roster that is on a creature the player meets in the first
      // minute — so it has to survive being looked at a lot, and it must not
      // read as "glowing" in daylight.
      //
      // Three deliberate zeroes: `strength` is low, and `pulseAmp`, `flickerAmp`
      // and `flow` are all 0. That last trio is what makes this a TEXTURE rather
      // than an effect — the shader is handed phases rather than a clock (see
      // the header of systems/biolumSkin.js), so a zeroed drift and a zeroed
      // breath mean the pattern is a pure function of position and never moves.
      // A crab whose shell mottling crawled while it walked would give the whole
      // thing away instantly.
      carapace: {
        // PIGMENT, NOT LIGHT — the one preset in the file that is not
        // bioluminescence. This is what keeps the day crab out of the
        // night-gated roster; see `luminous` in `base`.
        //
        // Out of the school wave for the same reason: the field is a thing in
        // the water column that the shoals drift through, and this animal is
        // walking on the seabed wearing a shell. A crab whose markings dimmed
        // as a wave passed overhead would read as a lighting bug.
        schoolAmp: 0,
        //
        // Its EYES are the exception, and they are why eyeStrength hangs off
        // the preset rather than off the pattern's `strength`: the shell emits
        // nothing and the eyes still catch the light. Kept low — this is a wet
        // highlight on a daylight animal, not a lamp.
        // A WET HIGHLIGHT, not a lamp. The instinct is a near-black eye colour
        // because a crab's eye is a dark bead — but this term is ADDITIVE, and
        // adding near-black is indistinguishable from adding nothing (measured:
        // 0x1a1410 at 0.5 contributes a peak luminance of 0.004). Additive
        // light cannot darken anything, so the only honest daylight read is a
        // small pale glint, kept deliberately under the bloom threshold: peak
        // Rec.709 luminance ~0.13 against CONFIG.bloom.threshold 0.18, so the
        // eye catches the light without the day crab hazing.
        eyeStrength: 0.14,
        eyeColor: 0xffe6c4,
        eyeFalloff: 5,   // tight, so only the bead itself picks it up
        luminous: false,
        pattern: 'marble', // turbulence-folded veining reads as shell, not as spots
        scale: 0.3,
        coverage: 0.34,
        contrast: 1.9,
        // Low, and this is the number that keeps it out of the bloom pass. The
        // bright pass thresholds LUMINANCE, and these browns are dark enough
        // that nothing here reaches it — which is the point. See the note on
        // `strength` in the header for why the glowing presets go past 1.
        strength: 0.55,
        // Off. All three of them.
        flow: 0,
        pulseAmp: 0,
        flickerAmp: 0,
        // Wet shell: brown into rust into a bone highlight. Nothing saturated,
        // nothing that could be mistaken for light.
        colorA: 0x4a3524, colorB: 0x7a4a2c, colorC: 0xa88a63,
        hueSpread: 0.7,
        // Mild, and forward — the claws and the front of the shell catch a
        // little more than the back does, the way a wet animal does under a
        // sun that is above and in front of it. Needs biolumAxis 'z' on the
        // asset to mean anything; see ASSETS.enemyWalkingCrab.
        tailBias: 0.18,
        hueBias: 0,
        // The body underneath is a real texture on this model, unlike the fish,
        // so darkening it hard would just make a muddy crab. Light touch.
        bodyDarken: 0.12,
        // No phase spread worth having on a static pattern — there is no phase.
        phaseSpread: 0,
        phaseSteps: 0,
      },

      // NIGHT. The same animal after dark: a dark shell with light in the
      // cracks, and claws that are visibly hotter than the rest of it.
      //
      // The two-tone is `hueBias`, not a second material. The ramp runs dark
      // crimson -> red -> hot ember, and biasing the ramp along the body axis
      // samples the low end on the shell and the high end at the claws. That
      // only works because the asset declares biolumAxis 'z': the derived axis
      // would have been X, which runs from one claw to the OTHER and would have
      // lit the left claw and blacked out the right. Measured in
      // tools/crab-claw-probe.mjs — with 'z' both claws sit at 0.94 and the
      // shell at 0.54.
      emberClaw: {
        pattern: 'veins', // filaments in the shell seams
        scale: 0.26,
        coverage: 0.3,
        contrast: 2.6,
        strength: 0.85, // same rescale as the rest — see `lantern.strength`
        // Both biases pushed hard toward the claw end. tailBias gathers the
        // BRIGHTNESS there, hueBias gathers the COLOUR — together that is "dark
        // red shell, ember claws" rather than "evenly orange crab".
        tailBias: 0.55,
        hueBias: 0.45,
        hueSpread: 0.8,
        colorA: 0x5c0f1e, colorB: 0xc22a1c, colorC: 0xffb04a,
        // Dark under the light, unlike the day preset — after sunset the body
        // texture is competing with the glow rather than carrying it.
        bodyDarken: 0.55,
        // A slow bellows rather than a shimmer. This animal walks; a fast
        // stutter on a slow walker reads as a rendering fault, and the crab is
        // the only glowing thing in the roster with FEET.
        // THE EYES ARE THE BRIGHTEST THING ON THIS ANIMAL, and the point of
        // the whole feature: two hot points that find you before the shell
        // resolves out of the dark. Well above the body's own strength on
        // purpose. Warm, so the bloom's Rec.709 bright pass actually catches
        // them — see `eyeColor` in base.
        // Hot enough to be the first thing you see and not so hot that it is
        // just a white disc: the composite is LDR with no tonemapping, so
        // anything far over 1 clips flat. At 2.4 the very tip clips and the
        // falloff keeps a warm fringe around it, which is what reads as a
        // glowing eye rather than a bloom sprite. Peak Rec.709 luminance ~1.3
        // against a 0.18 threshold, so it blooms hard.
        eyeStrength: 2.4,
        eyeColor: 0xffb347,
        eyeFalloff: 3.2,
        eyePulse: 0.22,
        pulseAmp: 0.32,
        // 2pi/4.571s, which IS '2 bars' at 105bpm. The two have to agree: the
        // sync picker decides the pace when beat sync is on and `pulseSpeed`
        // decides it when it is off, so a mismatched pair means switching sync
        // off visibly changes the animal's tempo. tools/beat-sync-test.mjs
        // checks every pair in the file for exactly this.
        pulseSpeed: 1.375,
        pulseSync: '2 bars',
        // A little stutter, on a slow division — the claws guttering like
        // something burning inside the shell.
        flickerAmp: 0.18,
        flickerSync: '1/4',
        // ...and the free-running twin of that division — one step per beat.
        flickerRate: 1.75,
        // Crabs arrive in crowds, so the spread matters more here than on the
        // apex presets: four slots keeps a heap of them breathing as a section
        // instead of one animal with nine bodies.
        phaseSpread: 1,
        phaseSteps: 4,
      },
    },
  },

  // ---------------------------------------------------------------------------
  // GRASS — seabed plants bending in the current. Entirely a vertex shader
  // (systems/grassSway.js), so the cost is the same for two clumps or two
  // hundred and every number here is a uniform write rather than a rebuild.
  // ---------------------------------------------------------------------------
  grass: {
    sway: {
      enabled: true,
      // How far the TIP travels to one side, as a FRACTION OF BLADE HEIGHT —
      // so it means the same thing at any `fit`. 0.09 is a lean; past about
      // 0.3 the blades start visibly sliding through each other, which the
      // arc-length correction below cannot hide.
      amplitude: 0.09,
      // Exponent on the root-to-tip mask. 1 hinges the whole blade at the root
      // like a wiper; higher keeps the lower third planted and curls the top,
      // which is what a stem in current actually does.
      stiffness: 1.8,
      // ONE SWAY PER `speedSync`, and one flutter per `flutterSync` — the two
      // divisions nearest the rates below at 105bpm, so the field kept its
      // pace and gained the grid. Set either to 'free' to go back to the
      // rad/sec figure beside it. See systems/beatSync.js.
      //
      // Worth doing even though nobody watches the grass: it is a large, slow,
      // full-width thing, and a large slow thing that is nearly in time is
      // what makes a whole screen feel off without anyone being able to say
      // which element is wrong.
      speedSync: '2 bars',
      speed: 1.1, // radians/sec of the main sway, when speedSync is 'free'
      // Spatial frequency of the travelling wave, in radians per world unit.
      // This is what makes the current cross the field as a gust instead of
      // every clump breathing in unison; 0 pins them all to the same phase.
      wavelength: 0.35,
      direction: 0, // radians in the model's ground plane; 0 = along +X
      flutter: 0.025, // fast tip-weighted chatter riding on the main sway
      flutterSync: '1 bar',
      flutterSpeed: 3.7, // radians/sec, when flutterSync is 'free'
      // Arc-length correction: how much the tip drops to pay for moving
      // sideways. 1 keeps blades their own length, 0 lets them stretch (which
      // reads as rubber). No reason to lower it except to see what it does.
      bend: 1,
    },
  },

  // ---------------------------------------------------------------------------
  // POINTS — score replaces a plain kill counter. Small schooling fish are
  // worth little individually but pop a bonus when the whole school is
  // wiped; tougher non-schooling creatures are worth more per kill. Any kill
  // landed while a strike chain is active gets multiplied by the chain.
  // ---------------------------------------------------------------------------
  points: {
    preyMultiplier: 2.2, // base points = enemy.xp * this, for schooling prey
    predatorMultiplier: 6, // ...for everything else (sharks, crabs, etc.)
    schoolWipeBonus: 150, // awarded once, to whichever kill empties a school
    comboMultiplierPerChain: 0.5, // +50% per chain step beyond the first
    comboMaxMultiplier: 5,
  },

  // Keeps big creatures from occupying the same space. Only enemies flagged
  // `separates` participate (hunters + large bodies) — schooling fish have
  // their own flocking separation already.
  enemySeparation: { gap: 2.2, strength: 0.55 },

  // How the big bodies share one player — see systems/apexCrowd.js for the
  // reasoning. enemySeparation above is the physical shove that happens after
  // two creatures are already too close; this is the steering that stops them
  // choosing to be there in the first place.
  apexCrowd: {
    enabled: true,
    // Personal space a hunter steers AROUND, as a multiple of the two bodies'
    // radii. Deliberately wider than enemySeparation.gap: this one has to act
    // early enough to change a course, not just to unstick an overlap.
    avoidGap: 3.2,
    avoidStrength: 1.5,
    // How many may press the player at once. The rest hold the ring. Two is
    // the number that reads as a pack working together rather than as a queue
    // (one) or a pile (four or more).
    feedingSlots: 2,
    // Seconds a hunter holds the front before it stops being favoured and the
    // pack rotates. Not a hard eviction — it just gets ranked honestly again,
    // so it keeps the slot if nothing else is closer.
    feedTurn: 4.5,
    // Ranking bonus, in world units, for whoever currently holds a slot. Stops
    // two evenly-matched hunters swapping places every frame.
    incumbentBonus: 2.5,
    // The waiting ring. Jitter is per-creature so it reads as a loose shoal
    // rather than a drawn circle.
    standoff: 7,
    standoffJitter: 2.5,
    // Tangential weight while holding the ring: 0 hovers, 1 circles at about
    // the same rate it closes.
    circleStrength: 1,
  },

  // ---------------------------------------------------------------------------
  // CRAB CLAW — the telegraphed pinch (systems/crabClaw.js).
  //
  // A crab used to be a walking contact hitbox: nothing it did on screen said
  // it was about to hurt you, and nothing you could do in the moment avoided
  // it. This is the tell and the answer to it. The claw rears up, hangs, and
  // slams — and the whole gesture is long enough that a player who reads it
  // gets out of the way.
  //
  // Contact damage is UNCHANGED and still applies. This is deliberately a
  // second, longer-ranged threat rather than a replacement: touching a crab
  // should always hurt, and the pinch is what makes standing just outside
  // touching distance stop being free. `damageMul` below is what keeps that
  // from being a straight buff.
  //
  // Every distance here is a MULTIPLE of something the crab already carries —
  // its own radius or its arm's measured reach — for the reason written out at
  // enemies.walkingCrab.depthSpread: the crab ships a size multiplier well
  // above 1, so a hand-typed number in world units means something different
  // in play than it does in this file.
  // ---------------------------------------------------------------------------
  crabClaw: {
    enabled: true,

    // --- timing, in seconds --------------------------------------------------
    // The three phases. `windup` is the contract with the player: it is the
    // only part they can act on, so it is the longest of the three by some way
    // and it is where the claw is furthest from where it will end up.
    windup: 0.42,
    // Fast, because a slow strike is a strike you can walk out of after it has
    // committed, which makes the windup meaningless.
    strike: 0.16,
    recover: 0.34,
    // Between pinches. Long: a crab that pinches on a two-second cycle is a
    // damage-per-second problem rather than a thing you dodge, and there are
    // usually six of them.
    cooldown: 2.6,
    // How far into the STRIKE phase the claws actually meet, as a fraction.
    // Not 1.0 — the slam curve puts most of its travel at the end, so the
    // claws are effectively shut a little before the phase formally ends, and
    // billing the damage at 1.0 lands it a frame after the visual contact.
    connectAt: 0.85,
    // Seconds the second claw trails the first. Small, but it is the single
    // cheapest thing that stops two claws reading as one animation played
    // twice.
    armLag: 0.06,

    // --- geometry ------------------------------------------------------------
    // How far the player can be and still be pinched, in multiples of the
    // crab's own radius. The arm's real reach is measured off the skeleton at
    // runtime, so this is the GAMEPLAY range, deliberately kept a little
    // shorter than what the arm can physically cover — a pinch that connects
    // at the exact limit of the IK looks like a miss.
    range: 2.4,
    // ...and how far inside that range the crab has to be before it commits.
    // Without this a crab at the edge of range starts a windup, the player
    // drifts a hair further out, and the whole 0.9s gesture plays to nobody.
    commitRange: 2.1,
    // Windup offsets, as fractions of the arm's measured reach: how far the
    // claw lifts above the aim line, and how far back along it the claw draws
    // before coming forward.
    rise: 0.55,
    draw: 0.3,
    // How far past its true reach the solver is allowed to aim. Slightly over
    // 1 keeps the arm from locking dead straight at full extension, which is
    // the pose that reads as a stick rather than a limb.
    reachStretch: 1.05,

    // --- the scissor ---------------------------------------------------------
    // Radians. `gape` swings the claw head AWAY from the crab's midline (the
    // measured sign of a positive rotation about the Palm's local z, on both
    // sides — see ASSETS.enemyWalkingCrab.clawRig), and `snap` carries it back
    // through rest and a little past on the slam.
    //
    // Kept modest, and this is a limitation talking rather than taste: the
    // claw is a closed lump with no interior geometry, so a large angle reads
    // as the whole head swivelling on the wrist rather than as a pincer. Under
    // about 0.7 it reads as a snap.
    gape: 0.6,
    snap: 0.22,
    // How much of `gape` a REAL jaw uses. Separate from the scissor's angle
    // because they are different joints doing different jobs: the scissor
    // swings a whole claw head and 0.6rad on it is a modest cock of the wrist,
    // while 0.6rad on a pincer finger is a wide-open claw. Measured on
    // crabpincer.glb: 0.4rad already takes the tip aperture from 9% of finger
    // length to 33%, so the full gape here is a deliberate, threatening gape
    // rather than the most the joint will take.
    //
    // The jaw never closes past rest whatever this says — see the clamp in
    // systems/crabClaw.js, and `snap` above for what it is protecting against.
    jawScale: 0.85,
    // How much of the scissor angle the FOREARM takes, negated — this is what
    // makes it a shear rather than a wave. At 0 the whole head swings on a
    // still forearm; at 1 the two rotate equal and opposite and the claw
    // barely moves through space at all.
    counterRotation: 0.45,

    // --- how completely the IK owns the arm -----------------------------------
    // Near-total while striking. Unlike the octopus's idle tentacles there is
    // no dangle state to preserve — a crab not pinching is simply walking, and
    // the walk cycle should own the arm completely.
    reachWeight: 0.92,
    weightLerpIn: 14,
    weightLerpOut: 4,

    ik: {
      iterations: 4, // a 5-bone chain converges well short of the octopus's 5
      // Low, for the reason the octopus's is low: the collarbone is the
      // cheapest joint to move the tip a long way, and letting it take the
      // work reads as a shoulder coming out of its socket.
      rootInfluence: 0.15,
      // Tighter than the octopus's 1.5. A tentacle curls; a crab's arm has
      // three rigid segments and an elbow, and letting one joint take a radian
      // and a half folds the forearm through the shell.
      maxBend: 0.9,
      softness: 0.6,
      // Fast — the strike phase is 0.16s, and a smoothing that takes longer
      // than the phase turns the slam into a drift.
      smoothing: 16,
      tolerance: 0.02,
    },

    // --- damage ---------------------------------------------------------------
    // The pinch's damage as a MULTIPLE of the crab's contact damage, which
    // already carries the difficulty ramp — so this rides the ramp for free
    // and never has to be re-tuned against it.
    //
    // Below 1 on purpose. Contact damage is charged per second while touching;
    // this is a burst on a 2.6s cycle at longer range, and pricing it at parity
    // with a full second of contact would make walking into a crab the SAFER
    // option, which is exactly backwards.
    damageMul: 0.75,
    // Shove, as a multiple of the usual contact knockback. A pinch that
    // pushes you out of range is the reward for having been hit by the thing
    // you were supposed to dodge.
    knockback: 1.4,
  },

  // ---------------------------------------------------------------------------
  // CRAB PHYSICS — real collisions between creatures marked `collides`, as
  // opposed to the soft `enemySeparation` shove everything else uses. Crabs
  // crowd the same chum pile, so they need to actually barge each other.
  //
  // A hit lands in three places at once: velocity (they bounce), tumble (the
  // body rolls and rights itself), and the bone springs (the skeleton is
  // shoved and settles back into the walk cycle by itself, because the spring
  // chases whatever the clip wrote — see systems/boneSpring.js).
  // ---------------------------------------------------------------------------
  crabPhysics: {
    enabled: true,
    contactScale: 0.95, // contact distance as a fraction of the summed radii
    restitution: 0.45, // 0 = dead stop, 1 = perfectly elastic
    positionCorrection: 0.6, // how much overlap is resolved per frame, 0..1
    // Below this closing speed a contact is just jostling in a crowd: the
    // bodies still separate, but nothing tumbles or flails. Without it a
    // dense pile would shake itself apart permanently.
    minImpactSpeed: 1.2,
    tumblePerSpeed: 0.5, // radians/sec of roll per unit of closing speed
    maxTumble: 6,
    maxLean: 1.1, // hard cap on how far a crab may roll (radians)
    rightingStiffness: 40, // spring pulling the body back upright
    rightingDamping: 6,
    // Skeleton reaction. The impulse goes into the leg/claw springs; they
    // carry it out along each limb and settle back into the animation.
    boneImpulsePerSpeed: 0.4,
    maxBoneImpulse: 3,
    bumpCooldown: 0.15, // per-crab gap between flails, so crowds don't buzz

    // --- stacking ------------------------------------------------------------
    //
    // Crabs used to resolve contact purely along the line between their
    // centres, which on a flat seabed is almost always horizontal — so a
    // swarm converging on one pile spread out into a single flat rank, all at
    // exactly floor height. These four turn the same collision into a climb.
    //
    // The loop is: `climbBias` steers part of each contact's positional
    // correction UPWARD for whichever crab is already higher, so a crab
    // shoving into another rides up over it rather than sliding around it.
    // Once up there the pair pass records a support height for it
    // (`stackHeight`), and `gravity` pulls it back down the moment it walks
    // off the far side. Nothing scripts a stack; a heap is just what a crowd
    // of these rules does around one pile of food.
    climbBias: 0.55, // 0 = pure sideways shove (old behaviour), 1 = pure climb
    // Where a crab rides when it is on top of another, as a fraction of the
    // summed radii. Well under 1 on purpose: this crab is 2.80 wide by 0.93
    // TALL, so its radius describes its width, and stacking at a full radius
    // apart would leave each one hovering a body-height above the shell it is
    // supposedly standing on.
    stackHeight: 0.6,
    // Downward acceleration on anything that crawls, world units/sec^2. This
    // is what makes a stack fall apart when the crab underneath walks out, and
    // what settles a climbing crab back onto the sand.
    gravity: 20,
    // How close in z two bodies must be to touch at all, as a fraction of the
    // summed radii. Below 1 crabs in different depth lanes (see
    // enemies.walkingCrab.depthSpread) pass in front of and behind each other
    // instead of colliding — which is the whole reason they have lanes.
    //
    // Read together with that spread, never on its own: this is the threshold,
    // that is the range fed into it. Set too close to each other and almost
    // every pair still collides, so the lanes cost a `continue` and buy
    // nothing visible.
    depthContact: 0.6,
    // How fast a crab is carried up onto a support that appeared underneath it
    // (per second, exponential). Only the way UP is eased — falling is
    // `gravity` above. A snap here reads as a pop; this reads as scrambling on.
    supportRise: 9,
    // How wide the "standing on it" test is compared to the contact distance.
    // Slightly narrower than contact, so a crab has to be genuinely over
    // another to be held up by it rather than clinging to its edge.
    supportSpan: 0.85,
    // The dead seal is a surface too — this is `stackHeight` for climbing onto
    // the corpse. Lower, because a crab riding a body sits ON it, and the
    // seal's radius is its swimming hitbox rather than its visible thickness.
    corpseStackHeight: 0.45,
  },

  // ---------------------------------------------------------------------------
  // RIGID BODIES — the two things in this ocean that get knocked around instead
  // of killed: the sea turtle and the boats. See systems/rigidBody.js.
  //
  // Both are floating props with a right way up, so both get the same body:
  // a velocity laid over their own motion, one roll axis, and a spring that
  // rights them. What that buys is the turtle becoming AMMUNITION — it cannot
  // die, so the seal can punt the same one across the arena into a hull all
  // run, and what happens next is a collision the fight has no other way to
  // produce.
  // ---------------------------------------------------------------------------
  physics: {
    // The collision layer only. Bodies still move and still write their
    // position — a hull's position IS its body now — so turning this off means
    // "nothing bumps into anything", not "no boats". See stepBodies.
    enabled: true,
    // Shared solver. Restitution is the bounce off another body; a body may
    // override it (see `boat.restitution`) and the softer of the pair loses —
    // the solver takes the larger, which is what makes hitting a hull springy
    // even though the turtle itself is not.
    restitution: 0.45,
    positionCorrection: 0.7, // share of the overlap resolved per frame, 0..1
    // Below this closing speed a contact is a nudge: the bodies still
    // separate, but nothing takes damage and nothing is reported as an impact.
    minImpactSpeed: 2.5,
    // Two hulls under thrust meet head-on and DEADLOCK — see canCollide. So
    // they only touch while at least one of them is `disturbed`: recently hit
    // by a turtle, a blast or the seal. This is the seconds that flag lasts.
    boatVsBoat: true,
    disturbedFor: 1.6,
    // The wreck's explosion, as it reaches other bodies (on top of the debris
    // and crew it already throws). 0 turns off the chain reaction.
    blastMul: 1,

    // --- the turtle ----------------------------------------------------------
    turtle: {
      // Light, and it barely slows down: it is a beach ball, and the whole
      // point is that a strike sends it all the way across the arena.
      //
      // This is what a NOMINAL turtle weighs. The roster rolls each one a size
      // (scaleVariance in enemies.csv, currently ±0.6), and mass follows that
      // by `massExp` — squared, the same rule the crab crowd uses — so the
      // spread of shells on screen is a spread of weights, not a paint job.
      // The runts are cannonballs and the big ones barely move.
      mass: 2.4,
      massExp: 2,
      drag: 0.55,
      angularDrag: 0.7,
      // Slack righting on purpose. A turtle that snapped level would look like
      // it was never really hit; this one cartwheels, unwinds, and is upright
      // again a couple of seconds later.
      righting: 4.5,
      rightingDamping: 2.2,
      spin: 1.6, // radians/sec of tumble per unit of impulse
      restitution: 0.5,
      wallRestitution: 0.55, // it BOUNCES off the walls and the seabed
      // THE PUNT, in world units/sec at full charge, before the strike's own
      // power ramp (CONFIG.strike.knockback.powerMin/Max) scales it. Its own
      // number rather than the creature knockback speed, because that one is
      // divided by body size to stop big animals being thrown around — and
      // this is a big animal that is entirely meant to be. At this speed and
      // this drag a full-charge strike sends it most of the way across the
      // arena, which is what makes aiming it at a boat a plan rather than a
      // coincidence.
      strikeImpulse: 34,
      // Above this speed the turtle has stopped swimming and is cargo: no
      // steering, no turning to face its heading, just the tumble. Below it,
      // it goes back to drifting wherever it was pointed.
      launchSpeed: 4,
      // A launched turtle bowls through whatever it meets. This is the shove
      // it hands a creature, as a share of a full-power strike's knockback —
      // no damage, so it can never quietly become a damage source.
      plow: 0.7,
    },

    // --- a hull --------------------------------------------------------------
    boat: {
      // Heavy. A hull takes the same impulse a turtle does and moves a
      // fraction as far, which is most of what makes the two read as different
      // weights rather than as two sizes of the same object.
      mass: 14,
      // Multiplied on top for a trawler. Kept as its own number rather than
      // reusing hitReaction.trawlerResist so the old flinch tuning and the new
      // mass can't silently double up on each other.
      trawlerMass: 2.4,
      // No linear drag: the hull's horizontal motion is governed by `thrust`
      // below (a spring toward cruise speed) and its vertical by `buoyancy`,
      // and a drag term on top of either would just fight it.
      drag: 0,
      angularDrag: 2.2,
      righting: 42, // the old rock spring, unchanged in feel
      rightingDamping: 5,
      spin: 2.6,
      restitution: 0.35,
      // How fast a shoved hull gets back up to its sailing speed, per second.
      // Low enough that a big punt visibly costs it way — it coasts backwards,
      // slows, turns around and carries on.
      thrust: 0.9,
      // The vertical spring back to the water line. This is what makes a hull
      // driven down into the water surge back up and bob it off, instead of
      // simply sliding back to its line.
      buoyancy: 30,
      buoyancyDamping: 4.2,
      // The seal's ram, as an impulse. Scaled by banked charge, then divided by
      // the hull's mass — so a full-charge dash punts a rowboat at several
      // times its own sailing speed and leans on a trawler.
      strikeImpulse: 300,
      // Per point of damage, and the ceiling on it — the shot recoil.
      damageImpulse: 1.1,
      maxDamageImpulse: 26,
    },

    // --- a turtle arriving at a hull -----------------------------------------
    //
    // The payoff. The hull takes real damage from being hit by a real body,
    // priced off the impact speed the solver measured, so a lazy drift into a
    // boat is nothing and a full-charge punt across the arena is a serious hit.
    impact: {
      // Damage per unit of the impulse the solver actually exchanged, so the
      // turtle's SIZE is in it: a nominal one hitting a rowboat at full punt
      // lands about 60, a runt a fraction of that, and one of the big ones
      // comes through the hull. Priced on impulse rather than speed precisely
      // because scaleVariance now spreads their masses an order of magnitude.
      damagePerImpulse: 0.5,
      minSpeed: 6, // below this it's a bump: roll and flash, no damage
      maxDamage: 120,
    },
  },

  // ---------------------------------------------------------------------------
  // HUD — health and oxygen ride just above the seal rather than in a corner
  // panel, so the two bars you have to react to fastest are already where
  // you're looking. XP is the full-width bar across the top of the screen.
  // ---------------------------------------------------------------------------
  hud: {
    // How far above the seal the health/oxygen stack floats, in WORLD units.
    playerBarOffset: 2.6,
  },

  // ---------------------------------------------------------------------------
  // BEAT SYNC — the master switch for every shader that animates on a musical
  // division instead of on a rate in seconds. See systems/beatSync.js for the
  // reasoning; in short, a dozen effects each running at a hand-picked
  // rad/sec are each very slightly out of time with the loop, and the screen
  // never quite agrees with itself.
  //
  // The individual pickers live next to the effects they belong to — the
  // breath and flicker divisions under each Bioluminescence group, the sway
  // under Grass, the beam bands under Bakalar. This block is only the two
  // things they all share.
  // ---------------------------------------------------------------------------
  beatSync: {
    // Off sends every synced effect back to its own rate in seconds, which is
    // exactly how the game ran before any of this existed. Worth keeping as a
    // toggle rather than a code path to delete: A/B-ing "is this actually
    // better" is the only way to answer it.
    enabled: true,
    // What "1 bar" means. Everything else in the picker is a note value and
    // needs no interpretation; only the bar figures read this, and they are
    // the ones most FX end up on.
    beatsPerBar: 4,
  },

  // ---------------------------------------------------------------------------
  // MUSIC — a loop player that changes tracks on a boundary. A switch waits
  // for the file that's playing to finish rather than cutting in on the frame
  // you levelled up, and it counts that wait in the TRACK's time, not the
  // room's — so a loop dragged down to a third speed by the death dive still
  // gets to play all the way through. Level-up ducks the mix through a
  // low-pass and swaps to the next loop; resuming gameplay sweeps it back
  // open. The music does not stop when you die: it drags down with the dive,
  // winds back up to pitch under the score card and keeps playing there.
  // `defaultSrc[i]`
  // preloads slot `i + 1` from public/music/ on startup — the same
  // load-with-fallback pattern as CONFIG.sfx's `src`. Upload in the T-menu's
  // Sound tab to replace any slot for the current session; with a slot
  // empty and no default set, that slot is just skipped.
  // ---------------------------------------------------------------------------
  music: {
    enabled: true,
    bpm: 120,
    // 8 bars of 4/4. This is the BEAT GRID — what beat-synced animation marches
    // to — and no longer where a track switch lands: that's the end of the
    // playing file, which is the only thing a listener can actually hear come
    // round. The two agreeing to the millisecond was never realistic (an mp3
    // is a few frames long or short), and every switch used to land a little
    // further into the next loop than the last one did.
    beatsPerLoop: 32,
    volume: 0.5,
    playbackRate: 1,
    slots: 15, // upload up to this many loops in the Sound tab
    defaultSrc: [
      '/music/747_Cocktails_Loop01.mp3',
      '/music/747_Cocktails_Loop02.mp3',
      '/music/747_Cocktails_Loop03.mp3',
      '/music/747_Cocktails_Loop04.mp3',
      '/music/747_Cocktails_Loop05.mp3',
      '/music/747_Cocktails_Loop06.mp3',
      '/music/747_Cocktails_Loop07.mp3',
      '/music/747_Cocktails_Loop08.mp3',
      '/music/747_Cocktails_Loop09.mp3',
      '/music/747_Cocktails_Loop10.mp3',
      '/music/747_Cocktails_Loop11.mp3',
      '/music/747_Cocktails_Loop12.mp3',
      '/music/747_Cocktails_Loop13.mp3',
      '/music/747_Cocktails_Loop14.mp3',
      '/music/747_Cocktails_Loop15.mp3',
    ],
    // Which loop is playing follows the player's level: every
    // `levelsPerSlot` levels advances to the next filled loop, so the
    // track evolves as a run goes on. Empty slots are skipped, so you can
    // set fewer than `slots` loops and they'll still spread across the run.
    levelsPerSlot: 4,
    // The low-pass tracks the player's DEPTH, not their level: fully open at
    // `surfaceHz` when breaching into the air, rolling off toward `deepHz`
    // at the seabed. That makes diving audibly muffle the mix the way water
    // actually does, and it follows the player continuously instead of
    // stepping once per level-up. `depthSmoothing` is the time constant of
    // the glide toward the depth-derived target — small enough to feel
    // responsive, large enough that fast bobbing at the surface doesn't
    // chatter the filter.
    surfaceHz: 18000,
    deepHz: 2600,
    depthSmoothing: 0.18,
    // The upgrade screen ducks below wherever the depth filter currently
    // sits, then hands control back to depth tracking on resume.
    duckedHz: 420,
    duckTime: 0.35,
    sweepTime: 0.9,
    resonance: 1.2,
  },

  // ---------------------------------------------------------------------------
  // AMBIENCE — the bed under everything. A short list of clips, one playing at
  // a time on a loop, crossfading into the next one every `holdSeconds`.
  //
  // Deliberately NOT music and NOT a CONFIG.sfx entry. Music is beat-locked
  // (switches wait for a loop boundary so a phrase is never cut) and a
  // CONFIG.sfx entry is a fire-and-forget one-shot; ambience is neither — it
  // is continuous, has no grid to land on, and its whole job is to never
  // announce itself. Crossfading rather than cutting is what keeps it that
  // way: a hard switch between two beds is the one moment a player notices
  // there IS a bed.
  //
  // It runs through the SFX bus (systems/audio.js getSfxBus), so diving
  // muffles the ambience exactly as it muffles hits. Music has its own chain
  // and does not — which is the right split, since the score is scoring the
  // run and the ambience is scoring the WATER.
  // ---------------------------------------------------------------------------
  ambient: {
    enabled: true,
    volume: 0.4,
    // The clips cycled through, in order.
    srcs: [
      '/sfx/Seal_Ambient_01.mp3',
      '/sfx/Seal_Ambient_02.mp3',
      '/sfx/Seal_Ambient_03.mp3',
      '/sfx/Seal_Ambient_04.mp3',
      '/sfx/Seal_Ambient_05.mp3',
      '/sfx/Seal_Ambient_06.mp3',
      '/sfx/Seal_Ambient_07.mp3',
      '/sfx/Seal_Ambient_08.mp3',
      null,
      null,
    ],
    slots: 10, // upload slots shown in the Sound tab

    // --- sporadic mode --------------------------------------------------------
    // Seconds of SILENCE between one clip finishing and the next beginning.
    // Above zero this is the mode the system runs in: a clip fades up, plays
    // through ONCE, fades away, and the water is quiet until the next one.
    //
    // That is a different system from a crossfade with a long gap in it, and
    // the difference is the looping. A continuous bed loops its clip to fill
    // the hold; an appearance must not, because these clips are seal calls and
    // swells rather than texture, and a call heard twice back to back reads as
    // a tape rather than as an animal. The clip's own length is therefore the
    // hold in this mode, and `holdSeconds` below is ignored.
    //
    // Set this to 0 to get the continuous crossfading bed instead, which is
    // what a long looping texture wants.
    gapSeconds: 22,
    // ± fraction on that silence. This is the parameter that does the most work
    // in the whole block: a fixed gap is a metronome, and the ear finds it
    // within three repeats even at twenty seconds apart.
    gapVary: 0.55,
    // Fade in and fade out of each appearance. Clamped at runtime so both fades
    // always fit inside the clip with room between them.
    fadeSeconds: 1.8,

    // --- continuous mode ------------------------------------------------------
    // Both of these are ignored while `gapSeconds` is above zero.
    //
    // Seconds a clip holds before the next is brought in UNDER it. Long, on
    // purpose: a bed that changes every few seconds is a bed you're listening
    // to instead of hearing.
    holdSeconds: 34,
    holdVary: 0.25,
    // Seconds of overlap between the outgoing and incoming clip.
    crossfade: 7,

    // --- both -----------------------------------------------------------------
    // Per-clip playback-rate spread, rolled fresh each time a clip comes
    // round. Same trick the one-shots use for the same reason: an identical
    // repeat is what the ear locks onto.
    pitchVary: 0.04,
    // Random pick (never the same clip twice running) vs straight round-robin
    // through the filled slots.
    shuffle: true,
    // Seconds to fade out when a run ends. Longer than it strictly needs to be,
    // so the ambience outlives the death sound rather than vanishing with it.
    fadeOut: 1.6,
  },

  // ---------------------------------------------------------------------------
  // TYPOGRAPHY — global text styling. `retro` routes the whole UI layer
  // through the same CRT/VHS post shader the gameplay uses, so the text
  // scanlines and warps along with everything else instead of floating on
  // top looking modern. (It's a CSS filter chain approximating the shader
  // rather than the shader itself — the UI is DOM, not WebGL, so it can't
  // literally sample the same pass; the knobs below match its look.)
  // ---------------------------------------------------------------------------
  typography: {
    family: "'Inter', system-ui, sans-serif",
    weight: 600,
    letterSpacing: 0.04, // em
    scale: 1.0, // multiplies every UI font size
    color: 0xe8ecf3,
    retro: true,
    retroScanlineOpacity: 0.22,
    retroChromaShift: 0.7, // px of r/b split on text
    retroFlicker: 0.05, // 0 = steady, higher = more CRT flicker
    retroGlow: 0.5,
  },

  // ---------------------------------------------------------------------------
  // BOATS — sail along the surface line. Destroying one dumps a load of chum
  // into the water. A TRAWLER additionally drops an attractor orb, which
  // hoovers up every chum bit resting on the sea floor and drags it to you —
  // the payoff for letting a pile build up down there (which also draws
  // crabs, so it's a real trade).
  // ---------------------------------------------------------------------------
  boats: {
    enabled: true,
    spawnMin: 14, // seconds between boat spawns
    spawnMax: 26,
    maxAlive: 3,
    speed: 3.2,
    speedVariance: 1.2,
    hp: 60,
    hpPerDifficulty: 8,
    // Fallback hitbox size only. A boat's real hitbox is the box measured off
    // its own model at spawn (see hullExtents in systems/boats.js), so a
    // trawler, or anything the T-menu's Size slider has resized, is hit where
    // it looks like it should be. This value is used only if that measurement
    // finds nothing — i.e. the model failed to load.
    radius: 1.6,
    bobAmount: 0.22, // vertical bob on the surface
    bobSpeed: 1.6,
    contactDamage: 0, // boats are targets, not threats — they sit above the water
    xp: 20,
    // What a hull does when it's hit. A boat is a SIMULATED BODY — mass, one
    // roll axis, a righting spring — so the recoil, the roll and the weight
    // of a trawler all live in CONFIG.physics.boat, shared with the only
    // other thing in the ocean that gets knocked around instead of killed.
    // What is left here is what belongs to boats alone.
    hitReaction: {
      // NO CAPSIZE WHILE IT FLOATS. The roll is a spring, and the seal hits
      // hulls hard enough to wind it past vertical — at which point the boat
      // is upside down, sailing on, with its crew standing on the underside of
      // the deck. Clamped to a hard lean instead: going over is what SINKING
      // looks like, and a hull that is still alive has not earned it.
      maxRoll: 0.55, // radians — about 32 degrees of lean, both ways
      strike: {
        // What the seal's ram itself is worth against a hull, as a share of
        // its strike damage. Low on purpose — a strike marks a boat for the
        // things that actually sink boats (see CONFIG.strike.mark), and
        // headbutting a trawler to death should stay a long afternoon.
        damageMul: 0.6,
      },
    },
    // WRECKAGE. A destroyed hull breaks into boxes laid out over the boat's
    // own measured surface — generic shapes on purpose: cutting the real model
    // leaves hollow chunks with sawtooth edges, because these hulls are open
    // shells. Every chunk leaves with an UPWARD velocity, whichever part of
    // the boat it came from: a piece driven straight down is a piece that
    // spends the explosion underwater where nobody sees it.
    // See systems/boatDebris.js.
    debris: {
      enabled: true,
      // Chunk size as a fraction of the hull's length — so a trawler breaks
      // into bigger pieces than a rowboat, not more of them.
      chunkFraction: 0.12,
      // How much of a grid cell the hull has to actually cover before it earns
      // a chunk. This is the cull: rigging, cables and stray fittings have
      // almost no surface area and would otherwise fly off as solid boxes.
      minCoverage: 0.12,
      maxChunks: 26, // densest cells win past this
      sizeJitter: 0.35, // ± on each axis, on top of the chunk's form
      tilt: 0.35, // radians of random lean at spawn — a lean, not a shuffle
      // Fraction of chunks that come out at a completely free roll instead of
      // just a lean. A few pieces already turned over sell the break; all of
      // them turned over means the boat was never there.
      yawFree: 0.12,
      // --- shooting the wreckage ---------------------------------------
      // Chunks are targets. hp is proportional to size: `chunkHp` is what a
      // chunk one `hpAtExtent` across is worth, and the rest scale off that,
      // so a splinter pops and a hull panel takes a burst.
      chunkHp: 6,
      hpAtExtent: 1,
      hitInvuln: 0.12, // seconds a chunk shrugs off further hits after one lands
      hitKnock: 3.5, // how hard a non-fatal hit shoves it
      shatterPieces: 2, // fragments a broken chunk leaves
      shatterScale: 0.55, // each one this much of the parent
      shatterSpeed: 4, // thrown off the break this fast
      // Fragments smaller than this fraction of the ORIGINAL chunk stop
      // splitting and simply go — halving forever ends in a cloud of specks
      // that costs more to draw than it is worth looking at.
      shatterFloor: 0.34,
      dropChance: 0.18, // chance a broken chunk had something stowed in it
      // What it was, by weight. `chum` drops a small scatter rather than one
      // orb. An entry whose system is switched off is skipped, not rolled.
      drops: { rapidFire: 1, strike: 1.4, bubble: 1.2, chum: 3 },
      // What a dash is worth against wreckage, as a share of its damage to a
      // creature. A charged strike should go straight through a debris field.
      strikeMul: 1,
      outSpeed: 7, // thrown away from the hull's centre
      upSpeed: 6.5, // and up, on top of that, always
      scatter: 2.5, // random sideways kick, so amidships isn't a fountain
      // The fall back to the water is arena.gravity's now — a chunk of hull in
      // the air weighs what everything else in the air weighs.
      carry: 0.6, // share of the boat's own speed the pieces keep
      spin: 5, // rad/s, mostly about the view axis
      // In the water. Drag kills the throw fast, then `sinkSpeed` — the chum's
      // drift, near enough — carries the wreck down to the seabed.
      waterDrag: 3.6,
      waterGravity: 5,
      sinkSpeed: 1.4,
      spinDamp: 1.8,
      life: 6.5, // seconds before the chunk is gone
      // ...of which the last this many are spent DISSOLVING. Not shrinking: a
      // box scaling toward nothing reads as it retreating into the distance.
      // It's eaten away by the same organic noise the menus reveal through.
      fade: 1.4,
      dissolveCells: 6, // noise cells across a chunk — lower is chunkier
      maxAlive: 72,
      // Water entry. Small, and rate-limited across all the chunks in the air,
      // so a dozen landing together read as one wreck going in and not as a
      // dozen splashes stacked on the same pixel.
      splashScale: 0.4,
      splashGap: 0.06,
    },
    // THE EXPLOSION when a hull finally goes: an outward impulse applied to
    // the wreckage and to whoever was still aboard. Never downward, same rule
    // as the break — see systems/boatDebris.js.
    blast: {
      radius: 9,
      strength: 11,
      trawlerMul: 1.4, // a trawler goes up harder and reaches further
    },
    // THE CREW. Ragdoll figures standing on the deck who bail once the hull is
    // clearly going down, and who are thrown by the explosion if they left it
    // too late. Placeholder art (a box per bone) over a real humanoid joint
    // layout — see systems/crew.js.
    crew: {
      enabled: true,
      count: 2,
      trawlerCount: 2,
      // ABSOLUTE, not scaled by the boat: a trawler being bigger than a
      // rowboat doesn't make the people on it bigger.
      height: 1.25,
      // Only a fallback. The deck is MEASURED off the hull's own geometry (see
      // deckProfile in systems/crew.js), so the crew stands on the boat rather
      // than at a height somebody typed in — which is how they ended up
      // floating above it. This is what's used if a hull can't be read.
      deckHeight: 0.5,
      deckSpread: 0.6, // fraction of the hull's half-length they stand across
      // WHAT TAKES THEM OFF THE BOAT. Nothing they decide themselves: they
      // idle until a shot, a blast or the seal reaches them, and then they are
      // ragdolls. `hitRadius` is a share of a man's height added to whatever
      // the attack's own reach was, so a shot at his head counts as a hit.
      hitRadius: 0.45,
      knock: 7,
      knockSpin: 6,
      // A BODY IN THE WATER IS FOOD. The seal eats one on contact and it pays
      // out like chum; the hunters break off what they were doing to get to
      // one. `xp` is several ordinary orbs' worth — a man is the biggest
      // single mouthful in the game — and `healMul` multiplies the usual
      // per-orb heal on top.
      food: {
        xp: 12,
        healMul: 2.5,
        radius: 0.35, // his size as a target, as a share of his height
        // How far a shark or an orca will come for one. Generous on purpose:
        // this is the behaviour that makes sinking a boat change what every
        // predator on screen is doing.
        huntRadius: 16,
        biteRange: 1.4,
      },
      // Ragdoll solver. Fixed 1/60 steps regardless of frame rate. Gravity is
      // arena.gravity — a man falling off a deck falls at the same rate as the
      // wreckage beside him — and `buoyancy` below is what the water changes.
      airDrag: 0.25,
      waterDrag: 4.5,
      // How much of gravity the water cancels — high, so a body entering the
      // water slows hard and then settles instead of dropping like a stone.
      buoyancy: 0.82,
      iterations: 4,
      floorClearance: 0.3,
      floorFriction: 0.35,
      // How much speed survives a bounce off the seabed or the arena edge.
      // Low: a body is not a ball.
      bounce: 0.2,
      // Cosine of the widest angle the neck may bend to, measured against the
      // spine. Negative allows a good lolling head; 1 would weld it upright.
      neckLimit: -0.15,
      // How hard the joint limits push. These are approximations of joint
      // limits, not bone lengths — solved as hard as the links they distort
      // the body they are meant to be shaping.
      limitStiffness: 0.35,
      life: 9, // seconds before the body dissolves
      fade: 1.6,
      dissolveCells: 7,
      color: 0x14202c,
      outlineColor: 0x9fc6e8,
      outlineThickness: 0.035,
    },
    // How the catch spills when the hull goes. Outward from the boat and
    // barely up — the chum is the heavy half of the wreck, and it belongs on
    // the seabed, not in the air.
    chumToss: {
      out: 4, // outward speed at the edge of chumSpread
      up: 1.6, // scale of the vertical kick, biased downward
      carry: 0.3, // share of the boat's speed
    },
    // Chance a given boat is a trawler (bigger, tougher, drops the attractor).
    trawlerChance: 0.35,
    trawlerHpMul: 2.2,
    trawlerScale: 1.5,
    // Chum dumped on destruction.
    chumMin: 14,
    chumMax: 26,
    trawlerChumMul: 2.0,
    chumSpread: 3.5,
    // XP per bit. Was 3, which made a boat a level-up in a can: ~26 bits is
    // 79 xp, a trawler 117, against the 256 it takes to reach level 7 from
    // scratch. One trawler popped at thirty seconds covered levels one
    // through six by itself, which is exactly what "levels 2-7 fly past"
    // was — the recorded gaps SHRANK through that stretch (8s, 7s, 6s, 5s)
    // because the boat's lump landed in the middle of it.
    //
    // Only the xp value moved. The bits still drop in the same numbers, still
    // heal, still refill the strike meter, and still bait the crabs — the
    // spectacle of a hull coming apart is the point and is untouched. A boat
    // is now worth 26 xp: a real reward, not a shortcut through a third of
    // the level curve.
    chumXp: 1,
  },

  // Sucks every settled chum bit off the sea floor and carries it to the
  // player. Dropped only by trawlers.
  attractorOrb: {
    lifetime: 9,
    pullRadius: 999, // effectively the whole arena — that's the point of it
    pullStrength: 26,
    riseSpeed: 2.2, // it floats upward while it works
    color: 0xffcf40,
    glow: 3,
    scale: 1.4,
  },

  // ---------------------------------------------------------------------------
  // OXYGEN — depletes underwater, refills fast at the surface or instantly
  // from a bubble orb. Hitting zero starts draining health instead, so
  // running out is dangerous but not an instant death.
  // ---------------------------------------------------------------------------
  oxygen: {
    enabled: true,
    max: 100,
    depleteRate: 4, // per second while underwater
    refillRateSurface: 26, // per second while above the surface
    bubbleRefillAmount: 30, // instant, per bubble orb collected
    drainDamagePerSec: 8, // once oxygen hits 0, health drains at this rate
    bubbleSpawnMin: 7, // seconds between ambient bubble-orb spawns
    bubbleSpawnMax: 13,
    bubbleLifetime: 14,
    bubbleRiseSpeed: 1.6, // bubbles drift UP, unlike xp orbs which sink

    // The suffocation effects — a warning beep, gasping at the surface, and
    // the screen/mix falling apart as you black out. See systems/oxygenFx.js.
    //
    // Everything here is driven by ONE 0..1 "strain" value, which stays at 0
    // until oxygen drops below `threshold` and reaches 1 at empty. Below the
    // threshold nothing is running at all — no beep, no shader cost, no
    // filter — so the effect can't quietly tax a run you're playing well.
    fx: {
      enabled: true,
      // 1/8 of the bar. Deliberately late: the whole point is that the
      // screen coming apart is a genuine emergency, not ambience.
      threshold: 0.125,
      // Time constants for strain easing. Asymmetric on purpose — the effect
      // creeps in as you suffocate, but relief should feel like relief, so
      // it's not so slow to clear that surfacing feels unrewarded.
      attack: 0.5,
      release: 0.7,

      // --- pixelation -------------------------------------------------------
      // Block size in device pixels at full suffocation. This rides ON TOP of
      // whatever the current post preset does (vhs/vga already pixelate a
      // little), taking whichever is chunkier, so it still reads on a preset
      // that has its own pixel value.
      pixelMax: 18,
      // >1 holds the effect subtle through the early part of the range and
      // saves the ugly blocks for the last moments. Linear made 1/8 oxygen
      // look immediately broken, which spent the whole effect at once.
      pixelCurve: 1.8,

      // --- music band-pass --------------------------------------------------
      // A parallel band-pass mixed in alongside the normal (depth-filtered)
      // signal. Crossfaded rather than switched so the score narrows into a
      // band as you fade out instead of jumping there — see systems/music.js.
      musicEnabled: true,
      musicMix: 0.92, // how much of the band-passed path at full strain
      musicCenterHz: 900,
      musicQ: 3.6, // band narrows from wide-open toward this

      // --- warning beep -----------------------------------------------------
      // Cadence accelerates and pitch climbs as oxygen runs out.
      beepEnabled: true,
      beepIntervalFar: 1.1, // seconds between beeps just under the threshold
      beepIntervalNear: 0.22, // ...and at empty
      beepPitchRise: 0.6, // playback rate added by the time you're empty

      // --- surface gasps ----------------------------------------------------
      // Repeats for as long as you're actually gaining oxygen at the surface,
      // so a quick dip up for one breath makes one sound and a long top-up
      // makes several.
      breathEnabled: true,
      breathInterval: 0.5,
    },
  },

  // ---------------------------------------------------------------------------
  // RAPID FIRE PICKUP — a yellow orb, temporarily doubles fire rate and shot
  // count. Stacks its timer (not its strength) if collected again while active.
  // ---------------------------------------------------------------------------
  rapidFirePickup: {
    enabled: true,
    duration: 8,
    fireRateMul: 2,
    multishotMul: 2,
    spawnMin: 16,
    spawnMax: 26,
    lifetime: 14,
  },

  // ---------------------------------------------------------------------------
  // CRAB SPAWN — leaving xp orbs uncollected on the seabed draws crabs: past
  // a pile-size threshold, more crabs spawn the bigger the pile gets. Ties
  // into the walking crab's own floor-rush aggro (see enemies.walkingCrab.crawl).
  // ---------------------------------------------------------------------------
  crabSpawn: {
    enabled: true,
    checkInterval: 3, // seconds between pile checks
    floorHeight: 1.5, // how close to the seabed counts as "on the floor"
    pileThreshold: 6, // orbs piled before crabs start spawning at all
    orbsPerCrab: 3, // each additional this-many orbs spawns one more crab
    maxCrabsPerWave: 5,
    // Crabs walk on from off the side of the arena rather than appearing on
    // the seabed. `spawnMargin` is how far past the edge they start — enough
    // to be fully hidden, so the arrival reads as a scuttle in from the wings.
    spawnMargin: 3,
    // How close two orbs must be to count as the same heap, for the
    // biggest-pile scoring crabs use to choose a target.
    clusterRadius: 6,

    // THE PILE-ON. The moment the seal dies, a wave walks on from the wings to
    // join whatever crabs are already down there. Deliberately its own block
    // rather than reusing the pile-triggered numbers above: the run is over,
    // nothing here can hurt anyone, and the caps that keep the FIGHT readable
    // are exactly the wrong caps for the last shot of it.
    deathPile: {
      enabled: true,
      count: 9, // extra crabs summoned on death, on top of the ones on screen
      // Ignores enemies.walkingCrab.maxConcurrent and comes with its own
      // ceiling instead, since the point is a heap and ten is not a heap.
      maxCrabs: 22,
      // Spawned across a window rather than all on one frame, so they arrive
      // in a straggling line — the whole seabed noticing at once looks staged.
      // Seconds; the death dive runs on dilated time and this does not, so
      // keep it comfortably shorter than the descent.
      spawnWindow: 1.6,
    },
  },

  // ---------------------------------------------------------------------------
  // PROJECTILE TRAILS — ribbon trails behind ability projectiles, keyed by
  // asset name. `points` is how many positions of history the ribbon spans
  // (longer = a longer streak), `taper` shapes how fast it narrows and
  // `fade` how fast it dims. Anything without an entry here gets no trail.
  // ---------------------------------------------------------------------------
  trails: {
    enabled: true,
    // The mussel's trail is mostly the burning chips, not the ribbon: the
    // ribbon is narrowed to a thin hot core and `particles` does the work. A
    // trail preset with no `particles` block behaves exactly as before.
    // `perSecond` is emissions per second (each one emits the emitter's own
    // count), so it stays a rate no matter the framerate.
    // The mussel is the one projectile big enough for its own body to matter,
    // so its trail is placed RELATIVE TO THE SHELL rather than in absolute
    // world units — both of these are multiples of the shell's measured size,
    // not distances. That's deliberate: the shell carries a `sizeMultiplier`
    // from the Look panel (7.38 at the time of writing), so any hand-typed
    // world-unit offset is wrong by whatever that multiplier is, and silently
    // re-breaks the next time somebody drags the size slider.
    //
    //   tailOffset      multiple of the shell's half-LENGTH. 1 = exactly at
    //                   the tail, so the ribbon and the burning chips come off
    //                   the back instead of erupting out of its ribs.
    //   depthClearance  multiple of the shell's half-DEPTH. >1 puts the ribbon
    //                   clear behind the body, and since the shell is opaque
    //                   and writes depth, it then occludes its own trail.
    missile:    { points: 16, width: 0.16, color: 0xff8844, glow: 2.6, taper: 1.1, fade: 1.4,
                  tailOffset: 1.05, depthClearance: 1.4,
                  particles: { emitter: 'missileTrail', perSecond: 34 } },
    bounceShot: { points: 20, width: 0.30, color: 0x66ddff, glow: 2.8, taper: 0.9, fade: 1.2 },
    seagull:    { points: 14, width: 0.45, color: 0xf2f2f2, glow: 1.8, taper: 1.3, fade: 1.5 },
    starfish:   { points: 10, width: 0.26, color: 0xff7fb0, glow: 2.2, taper: 1.0, fade: 1.3 },
    bullet:     { points: 8,  width: 0.18, color: 0xffe066, glow: 2.0, taper: 1.2, fade: 1.6 },
  },

  // ---------------------------------------------------------------------------
  // BLOOM — the neon glow. Independent of the CRT/VHS preset system above;
  // either can be on without the other. Bright-pass threshold + ping-pong
  // blur at half resolution, composited additively before the screen filters.
  // Impact events push `feedbackState.glowPulse` up temporarily (see
  // CONFIG.feedback's `glow` field on each event) for a punchy flash on
  // every collision, decaying back to the steady base intensity below.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // RENDER SCALE — how many real pixels a screen pixel is worth.
  //
  // The one control in the game whose cost is nothing to do with what is
  // happening in it. Almost everything expensive here is paid per pixel of the
  // drawing buffer — the water's caustics and god-rays, the bloom chain, the
  // tilt-shift, and a composite pass that takes around twenty texture samples
  // for every pixel on screen — and the buffer is `min(devicePixelRatio, this)`
  // squared. None of it scales with the number of creatures.
  //
  // Which is why a laptop struggles where a phone does not, and it is not the
  // GPU: a 16-inch display filled edge to edge at ratio 2 is about 7.5 million
  // pixels against a phone's 1.3. Same game, same creatures, 5.6x the work.
  //
  // A CAP, not a multiplier. On a 1x display nothing above 1 does anything, so
  // this only ever gives back what a dense display was asking for — and below 1
  // it undersamples on any display, which is the setting to reach for last.
  //
  // Live in the tuner: dropping it mid-run reallocates the render targets on
  // the next frame (post.js resize) and nothing else notices. Sweep it while
  // watching the fps and Mpix in the tuner readout, and stop where the rim
  // lights and the grid lines start to crawl — those two go soft first, well
  // before the creatures do.
  render: {
    pixelRatio: 2,
  },

  bloom: {
    enabled: true,
    threshold: 0.55, // luminance above which pixels start to glow
    intensity: 0.9, // steady base glow strength
    // SOFT SHOULDER on the final composite. 0 = off, the hard clip this had
    // always had; 0.8 = identity below 0.8, then rolling off asymptotically to
    // 1 so nothing truncates.
    //
    // Not the same knob as `threshold`, and reaching for that one instead is
    // the natural mistake: `threshold` decides which pixels get a HALO, not how
    // bright they are. Raising it to stop something blowing out leaves the
    // pixel just as clipped and stops it blooming too.
    //
    // The scene target is HalfFloat so overdriven colours survive the bright
    // pass on purpose (see systems/post.js). This is only about the last write
    // into an 8-bit framebuffer, where each channel truncates independently and
    // a warm overdrive turns flat white. `npm run glow` reports which presets
    // are over the line.
    knee: 0.8,
    radius: 3, // blur iterations — higher = wider, softer glow (costs more)
    // How far below full resolution the glow is built. 2 = half, 4 = quarter.
    //
    // This is the single cheapest knob in the renderer: every pass in
    // renderBloom (one bright-pass plus `radius` x 2 blurs) is paid per pixel
    // of THIS buffer, so 4 costs a quarter of what 2 does. The output is
    // blurred and then added on top of a sharp image, which is why the
    // resolution it was built at is close to invisible.
    //
    // It is not free of look, though, and the direction surprises people: the
    // blur steps in TEXELS, so a bigger divisor makes each tap reach further
    // across the screen and the glow comes out WIDER at the same `radius`.
    // Going 2 -> 4 roughly doubles the spread. Halve `radius` alongside it to
    // land back where you were — and that is a second saving on top.
    divisor: 4,
    pulseStrength: 1.4, // how much an impact pulse multiplies intensity
    pulseDecay: 3.5, // higher = pulses snap back to baseline faster
    // Global multiplier on every particle's own `glow` value (see
    // CONFIG.emitters). The render target is HDR (HalfFloat), so this
    // genuinely pushes colour past 1.0 rather than clamping to plain white —
    // crank it for an overwhelming, blown-out look.
    particleOverdrive: 1.0,
  },

  postPresets: {
    off:  { pixel: 0, curve: 0,    scan: 0,    scanCount: 0,   chroma: 0,   noise: 0,    posterize: 0,  vignette: 0,    mask: 0,   jitter: 0,     bleed: 0 },
    crt:  { pixel: 0, curve: 0.14, scan: 0.22, scanCount: 700, chroma: 1.2, noise: 0.02, posterize: 0,  vignette: 0.35, mask: 0.3, jitter: 0,     bleed: 0.2 },
    vhs:  { pixel: 2, curve: 0.05, scan: 0.12, scanCount: 420, chroma: 3.5, noise: 0.09, posterize: 0,  vignette: 0.3,  mask: 0.1, jitter: 0.004, bleed: 0.5 },
    vga:  { pixel: 5, curve: 0,    scan: 0.06, scanCount: 300, chroma: 0,   noise: 0.01, posterize: 12, vignette: 0.2,  mask: 0,   jitter: 0,     bleed: 0 },
    arcade: { pixel: 3, curve: 0.2, scan: 0.3, scanCount: 540, chroma: 2.0, noise: 0.03, posterize: 24, vignette: 0.4, mask: 0.45, jitter: 0,   bleed: 0.3 },
  },

  // Procedural rocks — the bullet and the pickups (see systems/rocks.js).
  // These are the DEFAULTS for every `shape: 'rock'` asset; individual assets
  // override any of them in their own `rock: {}` block in assets.js.
  //
  // Changing a value here rebuilds the geometry pools on the next spawn, so
  // these are live in the tuner. Rocks already in the water keep the shape
  // they were born with — same limitation as the asset size slider.
  rocks: {
    variants: 6,      // distinct stones per asset, built once and drawn from
    detail: 1,        // icosphere subdivisions: 0 = 20 faces, 1 = 80, 2 = 320
    amplitude: 0.42,  // how far the noise pushes a vertex, as a fraction of radius
    frequency: 2.2,   // noise scale — low = a few big lobes, high = gravelly
    octaves: 3,       // fBm layers; each adds finer detail at half the weight
    lacunarity: 2.1,
    gain: 0.5,
    squash: 0.3,      // per-variant ellipsoid stretch, 0 = every rock round
    shade: 0.55,      // baked facet shading depth; 0 = flat silhouette again
    // Where the darkest facet lands in FINAL output on a glowing rock. The
    // composite target is LDR, so anything at 1.0 or over clips to white and
    // the shading with it — at the bullet's glow of ~5 a plain `shade` of 0.55
    // put every facet above 3.0 and the rock rendered as a featureless blob.
    // Lower this for deeper shadows on glowing rocks, raise it toward 1 to let
    // the glow eat them again.
    glowHeadroom: 0.55,
    grit: 0.08,       // per-facet brightness jitter on top of the shading
    tumble: 1.5,      // fallback spin rate (rad/s) for a rock asset with none
    tumbleScale: 1,   // global multiplier over every asset's own tumble rate
  },

  pickups: {
    magnetSpeed: 14,

    // --- THE MAGNET, PER STATE ------------------------------------------------
    // How far the seal reaches, and how hard it pulls, depending on what it is
    // doing. One flat radius for every state is what made the FOOD CHAIN
    // unreachable: sustaining a chain needs five to ten orbs a second, and at a
    // fixed 4-unit reach the water has to hold an orb every 58 square units
    // before the loop can turn over at all. See systems/chumMagnet.js.
    //
    // `speedMul` matters more than `radiusMul` and is the one people forget.
    // The base pull is 14 u/s against a 46 u/s dash — an orb anywhere but
    // straight ahead falls behind at 32 u/s and never arrives — so widening
    // the striking radius WITHOUT raising the pull collects nothing extra.
    magnet: {
      idle:     { radiusMul: 1,    speedMul: 1 },
      // Moving with intent reaches further than drifting, so the wide magnet
      // reads as a reward for swimming rather than for parking on a pile.
      swimming: { radiusMul: 1.6,  speedMul: 1.3 },
      boosting: { radiusMul: 1.9,  speedMul: 1.6 },
      striking: {
        radiusMul: 2.2,
        // Above 1 x dashSpeed/magnetSpeed (46/14 = 3.3) an orb can gain on a
        // dashing seal from any angle. 3.4 clears it with a little to spare;
        // below about 3.3 the sides of the corridor are decorative.
        speedMul: 3.4,
        // THE CORRIDOR. While dashing the reach is a capsule swept along the
        // dash heading rather than a disc around the seal — the player flew
        // down a lane, and the food they expect to have taken is the food in
        // that lane. `corridorBack` is the more important half: it is what
        // collects the orbs the dash has already shot past, which a circle
        // leaves behind as an untouched trail down the line just travelled.
        // Both in world units; 0/0 falls back to a plain circle.
        corridorBack: 10,
        corridorAhead: 3,
      },
    },
    collectRadius: 0.6,
    sinkSpeed: 1.2, // xp orbs drift down through the water
    maxAlive: 140, // oldest orbs are recycled past this
    // A drop that was THROWN rather than placed — boat chum spilling out of a
    // hull. The throw is temporary: gravity above the water line, drag below
    // it, and once it's spent the orb goes back to the plain sink above.
    // (Gravity for the airborne half is arena.gravity's, like every other
    // fall in this game; only the two drags are the orb's own.)
    toss: { airDrag: 1.2, waterDrag: 4.5 },
    healFraction: 0.02, // fraction of max HP restored per orb, before tier scaling
    // Orb size is tiered by the source enemy's radius, so a school fish drops
    // a small dim orb and a shark or squid drops a big bright one — both xp
    // and heal scale with the tier, not just the raw xp value.
    tiers: [
      { maxRadius: 0.5, xpMul: 0.7, healMul: 0.6, scale: 0.8, color: 0xff5577 },
      { maxRadius: 1.0, xpMul: 1.0, healMul: 1.0, scale: 1.0, color: 0xff3355 },
      // A finite ceiling rather than Infinity: JSON.stringify writes Infinity
      // out as `null`, so the saved copy came back with no upper tier bound at
      // all. 999 is far past any enemy radius and survives the round-trip.
      { maxRadius: 999, xpMul: 1.6, healMul: 2.2, scale: 1.6, color: 0xff2244 },
    ],

    // THE PULL. Chum brightens as the seal closes on it. A scattered orb is
    // litter on the seabed until you are near enough for it to be worth
    // turning for, and then it lights up and asks — which is the whole job:
    // what catches an eye is the CHANGE, not the brightness. A pile that
    // glowed this hard at rest would be scenery within a minute.
    //
    // Per INSTANCE, through the chum instance buffer (setGlow in
    // systems/instancedPool.js). That is what makes it possible at all: orb
    // materials are shared across every orb in the arena, so a colour written
    // to the material lights the whole seabed at once — the constraint the
    // gulp tell was built around (see CONFIG.strike.charge.gulp.tell).
    //
    // It MULTIPLIES whatever colour the orb is already wearing — tier colour,
    // texture-panel tint, texture-panel glow — so the hue never shifts, only
    // the brightness. Past 1 that drives the colour beyond white in the HDR
    // scene target, which is precisely what the bloom bright-pass is looking
    // for (CONFIG.bloom.threshold), so the halo swells as the seal arrives.
    glow: {
      enabled: true,
      // Brightness right on top of the orb, as a multiple of its resting
      // colour. 1 = off. Worth reading against the glow already on the asset
      // in the texture panel: the two multiply, so chum tinted bright is
      // starting much closer to the bloom threshold than the default red is.
      near: 2.6,
      // ...and out at the rim of the halo. Below 1 dims distant chum instead
      // of only brightening near chum — the same contrast, bought without
      // pushing the near end any further into white.
      far: 1.0,
      // How far the halo reaches, as a MULTIPLE of the player's pickup radius.
      // Tied to the magnet rather than fixed so a Magnet upgrade widens the
      // light along with the reach it advertises, and so the glow never
      // promises a pull the seal doesn't have.
      radius: 3,
      // Shape of the ramp, from the rim inward. 1 = linear, which lights the
      // whole radius visibly; above 1 holds the lift back until the seal is
      // genuinely close, and that is what keeps a busy arena from glowing
      // everywhere at once.
      curve: 1.8,
      // A shimmer on top, so chum the seal is closing on MOVES rather than
      // merely sitting there bright. Scaled by the same ramp — distant chum is
      // perfectly still — and phased per orb, or a pile pulses in lockstep and
      // reads as one object breathing instead of a dozen loose bits catching
      // the light. `depth` is the swing either side of the ramp's value.
      pulse: { hz: 1.6, depth: 0.3 },
    },
  },

  upgrades: [
    { id: 'rapidFire', family: 'gun', name: 'Rapid Fire', desc: '+25% fire rate', apply: (s) => { s.fireRate *= 0.75; } },
    { id: 'heavyRounds', family: 'gun', name: 'Heavy Rounds', desc: '+40% bullet damage', apply: (s) => { s.damage *= 1.4; } },
    { id: 'overboost', family: 'gun', name: 'Overboost', desc: '+30% recoil boost', apply: (s) => { s.recoil *= 1.3; } },
    { id: 'maxSpeed', family: 'utility', name: 'Redline', desc: '+20% max speed', apply: (s) => { s.maxSpeed *= 1.2; } },
    { id: 'multishot', family: 'gun', name: 'Multishot', desc: '+1 projectile', apply: (s) => { s.multishot += 1; }, maxStacks: 6 },
    { id: 'pierce', family: 'gun', name: 'Railgun', desc: 'Bullets pierce +1 enemy', apply: (s) => { s.pierce += 1; }, maxStacks: 4 },
    { id: 'vitality', family: 'utility', name: 'Vitality', desc: '+30 max HP', apply: (s) => { s.maxHp += 30; } },
    // Scales the gulp with the magnet deliberately: both are "how far the
    // seal's mouth reaches", and splitting them would mean an Attractor that
    // widened the passive sweep while the strike's own mouthful stayed the
    // size it was on the first card.
    { id: 'magnet', family: 'utility', name: 'Magnet', desc: '+50% pickup radius', apply: (s) => { s.pickupRadius *= 1.5; s.chumGulpRadius *= 1.5; } },
    { id: 'regen', family: 'utility', name: 'Regeneration', desc: '+0.5 HP/sec', apply: (s) => { s.regenPerSec += 0.5; } },
    { id: 'velocity', family: 'gun', name: 'Hot Rounds', desc: '+30% bullet speed', apply: (s) => { s.speed *= 1.3; } },
    { id: 'homingMissile', family: 'projectile', name: 'Homing Missile', desc: '+1 seeking missile per volley', apply: (s) => { s.missileCount = (s.missileCount ?? 0) + 1; }, maxStacks: 5 },
    { id: 'seaGarlic', family: 'aoe', name: 'Sea Garlic', desc: 'Damaging aura, +radius per level', apply: (s) => { s.garlicLevel = (s.garlicLevel ?? 0) + 1; }, maxStacks: 6 },
    // First pick opens the ring at `baseCount` — one lone shrimp circling reads
    // as a bug rather than an orbital weapon. Every stack after that is +1.
    { id: 'shrimpRing', family: 'projectile', name: 'Shrimp Ring', desc: '+1 orbiting shrimp',
      apply: (s) => { s.shrimpCount = s.shrimpCount ? s.shrimpCount + 1 : CONFIG.shrimpRing.baseCount; },
      // Not interpolated from `baseCount`: this literal is built before CONFIG
      // is assigned, so the number can't be read here.
      levelDescs: { 1: 'Opens a full ring of orbiting shrimp' }, maxStacks: 8 },
    // Reads the CONFIG count rather than counting its own stacks, for the same
    // reason bounceShot reads maxBouncesPerLevel: the card's promise is "a
    // barrage of N", and N lives in one place so the tuner slider and the
    // description can't drift apart.
    { id: 'musselVolley', family: 'projectile', name: 'Mussel Barrage', desc: 'Full-charge strike fires a barrage of homing mussels',
      apply: (s) => { s.musselVolleyLevel = (s.musselVolleyLevel ?? 0) + 1; }, maxStacks: 5,
      perLevelName: true,
      levelDescs: { 1: 'Full-charge strike fires 8 homing mussels at once' } },
    { id: 'bounceShot', family: 'projectile', name: 'Ricochet Rounds', desc: 'Chaining shot: +fire rate, +lifespan, +bounces', apply: (s) => {
        s.bounceLevel = (s.bounceLevel ?? 0) + 1;
        s.bounceFireRate = (s.bounceFireRate ?? CONFIG.bounce.fireRate) * 0.88;
        s.bounceLife = (s.bounceLife ?? CONFIG.bounce.life) + 0.6;
        s.bounceMaxBounces = (s.bounceMaxBounces ?? CONFIG.bounce.maxBounces) + CONFIG.bounce.maxBouncesPerLevel;
      }, maxStacks: 6 },
    { id: 'electricEel', family: 'aoe', name: 'Electric Eel', desc: 'Chain lightning: +area, +damage, +max chain', apply: (s) => { s.eelLevel = (s.eelLevel ?? 0) + 1; }, maxStacks: 8 },
    // The club is family 'projectile' because the thing it does is LAUNCH — its
    // damage goes through abilityDamage() like every other thrown thing, so a
    // high-tier roll pays into abilityDamageMul and reaches both the whack and
    // the caroms. Filed under the melee-looking weapons it is not.
    { id: 'club', family: 'projectile', name: 'Driftwood Club', desc: 'Clubs on both fins, swung by your own swimming. Whacked enemies ricochet.',
      perLevelName: true,
      levelDescs: { 1: 'Straps a club to each fin tip — swim faster, swing harder' },
      apply: (s) => { s.clubLevel = (s.clubLevel ?? 0) + 1; }, maxStacks: 6 },
    // The club's variant. Reads clubLevel for its damage, so it is worth most
    // in a run that already took the base card — but it deliberately does not
    // REQUIRE it (fireClubThrow floors clubLevel at 1), because a card that
    // can be dealt as a dead pick is worse than one that is merely better in
    // the right build.
    { id: 'clubThrow', family: 'projectile', name: 'Hurler', desc: 'Strike release hurls homing clubs — the harder you charged, the more of them',
      perLevelName: true,
      levelDescs: { 1: 'Releasing a strike throws clubs that seek what you painted' },
      apply: (s) => { s.clubThrowLevel = (s.clubThrowLevel ?? 0) + 1; }, maxStacks: 5 },
    // The two riders. Both hang off EVERY club hit the run has — the fin
    // swing, the carom, and the throw — which is what makes the club line a
    // build. Same reasoning as Hurler on not requiring the base card: they
    // read clubLevel for nothing, so they simply do less in a run without it
    // rather than nothing at all.
    { id: 'clubBoom', family: 'aoe', name: 'Powder Keg', desc: 'Every club hit detonates — swung, caromed or thrown',
      perLevelName: true,
      levelDescs: { 1: 'Club hits go off in a blast that catches the crowd behind them' },
      apply: (s) => { s.clubBoomLevel = (s.clubBoomLevel ?? 0) + 1; }, maxStacks: 5 },
    { id: 'clubIce', family: 'aoe', name: 'Cold Snap', desc: 'Club hits chill what they touch, and freeze it solid once the chill saturates',
      perLevelName: true,
      levelDescs: { 1: 'Club hits stack a slow, and lock the body when it maxes' },
      apply: (s) => { s.clubIceLevel = (s.clubIceLevel ?? 0) + 1; }, maxStacks: 5 },
    { id: 'starfish', family: 'projectile', name: 'Starfish Shuriken', desc: 'Rapid thrown starfish: +fire rate, +size', apply: (s) => { s.starfishLevel = (s.starfishLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'seagullBomb', family: 'aoe', name: 'Seagull Bomb', desc: 'Homing dive-bombers vs. crabs: +fire rate', apply: (s) => { s.seagullLevel = (s.seagullLevel ?? 0) + 1; }, maxStacks: 8 },
    // `perLevelName` numbers the card by the stack it's offering — "Seal Team
    // 1", then "Seal Team 2" — so which one you're being offered is on the
    // card instead of in your head. `levelDescs` overrides the description at
    // a given stack, which is how the evolution announces itself rather than
    // arriving as a surprise on an identically-worded card.
    { id: 'sealTeam', family: 'companion', name: 'Seal Team', desc: '+1 escort seal. Rams and lunges at enemies.',
      perLevelName: true,
      levelDescs: { 6: 'EVOLVE: the whole squad opens fire while it orbits.' },
      apply: (s) => { s.sealTeamLevel = (s.sealTeamLevel ?? 0) + 1; }, maxStacks: 6 },
    { id: 'beluga', family: 'companion', name: 'Baby Beluga', desc: 'Bubble drone traps enemies: +bubble size', apply: (s) => { s.belugaLevel = (s.belugaLevel ?? 0) + 1; }, maxStacks: 8 },

    // --- strike line --------------------------------------------------------
    // These scale the dash, which until now had no per-run scaling at all —
    // every strike number was read straight off CONFIG. The stats they mutate
    // are seeded from CONFIG in recomputeStats(), same as the bounce fields, so
    // the tuner sliders still act as the base value.
    //
    // EVERY CARD HERE ADDS BITE. A base strike is a shove that deals a chip
    // (CONFIG.strike.contactDamage), so the family carries the damage between
    // them: each card is worth `cardDamage`, and Killer Instinct — the card
    // whose whole identity is hitting harder — pays `powerShare` of those at
    // once. Read from CONFIG rather than written out five times so one slider
    // moves the whole line, the same way bounceShot reads maxBouncesPerLevel.
    { id: 'strikePower', family: 'strike', name: 'Killer Instinct', desc: '+35% strike damage, chains hit harder', apply: (s) => {
        s.strikeDamage += CONFIG.strike.cardDamage * CONFIG.strike.powerShare;
        // Compounding on top of a base above 1, so each stack widens the gap
        // between a one-off strike and a long chain rather than just adding
        // flat damage twice.
        s.strikeChainMul = 1 + (s.strikeChainMul - 1) * 1.3;
      }, maxStacks: 5 },
    { id: 'strikeDash', family: 'strike', name: 'Slipstream', desc: 'Strike dashes faster and further', apply: (s) => {
        s.strikeDashSpeed *= 1.22;
        s.strikeDashDuration *= 1.12;
        s.strikeDamage += CONFIG.strike.cardDamage;
      }, maxStacks: 5 },
    { id: 'strikeShrapnel', family: 'strike', name: 'Bone Shrapnel', desc: 'Strike hits burst fragments outward: +fragments', apply: (s) => {
        s.shrapnelCount = (s.shrapnelCount ?? 0) + 1;
        s.strikeDamage += CONFIG.strike.cardDamage;
      }, maxStacks: 6 },
    // The rhythm upgrade. Both halves of the loop get faster: less time
    // winding a strike up by hand, and a bigger bite out of the meter per
    // chum, so fewer orbs are needed to earn each FOOD CHAIN link. Stacked
    // fully this turns a ~1s wind-up into ~0.37s and drops the orbs-per-link
    // from 5 to 3 — the difference between striking deliberately and
    // striking on the beat.
    { id: 'strikeCharge', family: 'strike', name: 'Coiled Spring', desc: 'Strike charges faster, and chum refills more of the meter',
      perLevelName: true,
      apply: (s) => {
        s.strikeChargeTime *= 0.78;
        s.strikeChumRefill += 0.04;
        s.strikeDamage += CONFIG.strike.cardDamage;
      }, maxStacks: 4 },
    // The only upgrade that feeds the chain from something other than a hit.
    // It turns the surface into a combo tool: launch, and you come down on
    // the next school with the food chain already running. Stacks add links
    // per breach rather than shortening the cooldown, so the ceiling stays
    // "how often you can get out of the water", not "how fast you can skim
    // the water line" — see CONFIG.strike.chainOn.cooldowns.breach.
    { id: 'breachChain', family: 'strike', name: 'Porpoising', desc: 'Breaching the surface extends your food chain: +links per breach',
      perLevelName: true,
      apply: (s) => {
        s.breachChainLevel = (s.breachChainLevel ?? 0) + 1;
        s.strikeDamage += CONFIG.strike.cardDamage;
      }, maxStacks: 3 },

    // --- oxygen line --------------------------------------------------------
    { id: 'oxygenMax', family: 'utility', name: 'Deep Lungs', desc: '+30 max oxygen', apply: (s) => { s.maxOxygen += 30; }, maxStacks: 5 },
    { id: 'oxygenRefill', family: 'utility', name: 'Second Wind', desc: '+40% surface refill speed', apply: (s) => { s.oxygenRefillRate *= 1.4; }, maxStacks: 5 },

    // --- new companions -----------------------------------------------------
    { id: 'bakalar', family: 'companion', name: "Bakalar's Boat", desc: 'Trawler drags a net that hauls fish away: +net size, +sailings', apply: (s) => { s.bakalarLevel = (s.bakalarLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'calamari', family: 'aoe', name: 'Calamari Ring', desc: 'Shockwave sweeps outward: +damage, +radius, +rate', apply: (s) => { s.calamariLevel = (s.calamariLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'dumbo', family: 'companion', name: 'Dumbo Octopus', desc: 'Charms enemies harmless: +targets, +duration', apply: (s) => { s.dumboLevel = (s.dumboLevel ?? 0) + 1; }, maxStacks: 8 },

    // --- shellfish line -----------------------------------------------------
    // Two takes on the homing mussel, deliberately pulling in opposite
    // directions. The mussel tracks: it picks a target and turns onto it. The
    // scallop does NOT — it jets off at random and only turns when a wall or a
    // gust of its own bubble jet points it somewhere new, so it covers ground
    // the mussel never would and arrives from angles you didn't aim at. Count
    // rather than level, same as the mussel, because "how many are loose in
    // the water" IS the upgrade.
    { id: 'scallopSquirter', family: 'projectile', name: 'Scallop Squirter', desc: '+1 wild scallop', apply: (s) => { s.scallopCount = (s.scallopCount ?? 0) + 1; }, maxStacks: 12 },
    // Levelled rather than counted: the pearl's payload is what grows, not the
    // number in the air. See CONFIG.oyster — stacks buy more shrapnel pearls
    // per burst and a wider burst, so the ceiling is the size of one impact.
    { id: 'oysterBlaster', family: 'projectile', name: 'Oyster Blaster', desc: 'Pearls burst into glowing bomblets: +bomblets, +radius', apply: (s) => { s.oysterLevel = (s.oysterLevel ?? 0) + 1; }, maxStacks: 8 },

    // --- grapple / escort ---------------------------------------------------
    // The only DEFENSIVE companion in the game. Every other one adds output;
    // this one removes threats from the board by holding them, and a held fish
    // cannot touch you (see systems/octoGrab.js). Stacks add arms, so it reads
    // as "how many things can be held at once" — which is exactly the stat
    // that matters when a school closes in.
    { id: 'octoGrab', family: 'companion', name: 'Octopus Grabber', desc: '+1 tentacle. Held fish deal no damage.',
      perLevelName: true,
      apply: (s) => { s.octoGrabLevel = (s.octoGrabLevel ?? 0) + 1; }, maxStacks: 8 },
    // A pod, not a count — all three orcas arrive on the first pick and stacks
    // make them hit harder and hunt more often. Splitting the pod across
    // levels would mean the first card bought a lone orca, and a lone orca is
    // not what the fantasy is.
    { id: 'orcaFamily', family: 'companion', name: 'Orca Family', desc: 'Three orcas hunt enemy boats: +damage, +speed', apply: (s) => { s.orcaLevel = (s.orcaLevel ?? 0) + 1; }, maxStacks: 6 },

    // --- the cross-cutting four ----------------------------------------------
    // Every upgrade above this line grants or deepens ONE ability. These four
    // grant nothing and scale what you already have, which makes them the only
    // cards whose value depends on the rest of the build — and the reason they
    // are capped low and weighted rare. A +1-to-everything card offered as
    // often as Rapid Fire, at eight stacks, is the whole game.
    //
    // Their stats are seeded in stats.js with a full note on why the projectile
    // bonus is applied at the point of use instead of here.

    // Clone Warz. The count is added at each firing site through
    // projectileCount() — see stats.js. Deliberately flat rather than a
    // percentage: +1 shrimp on a ring of three and +1 pellet per fin are both
    // legible from the seat, where "+22% projectiles" is not.
    { id: 'projectileAmount', family: 'projectile', name: 'Clone Warz', desc: '+1 of everything you fire',
      perLevelName: true,
      apply: (s) => { s.projectileBonus += 1; }, maxStacks: 3 },

    // Splash Zone. Two multipliers, not one — see stats.js for why reach and
    // acquisition are split, and why acquisition moves so much less.
    { id: 'areaOfEffect', family: 'aoe', name: 'Splash Zone', desc: '+18% blast, aura and wave size',
      perLevelName: true,
      apply: (s) => { s.aoeMul *= 1.18; s.targetingMul *= 1.06; }, maxStacks: 5 },

    // Big Rigz. Scale is applied to the mesh AND the contact radius, so the
    // size is a real hitbox rather than a bigger picture of the same animal.
    { id: 'companionSize', family: 'companion', name: 'Big Rigz', desc: '+15% companion size, +25% companion damage',
      perLevelName: true,
      apply: (s) => { s.companionScale *= 1.15; s.companionDamageMul *= 1.25; }, maxStacks: 5 },

    // Glow Up!. `roll` names a variant rolled at DRAW time and shown on the
    // card — ui.js asks systems/elements.js for it, so which element you're
    // being offered is on the card before you commit. The roll happens once per
    // run: every later stack deepens the element already carried.
    { id: 'bioluminescence', family: 'gun', name: 'Glow Up!', desc: 'Your shots and strike carry an element',
      perLevelName: true,
      roll: 'biolumElement',
      apply: (s) => { s.biolumLevel += 1; }, maxStacks: 6 },
  ],

  upgradeChoices: 3,

  // ---------------------------------------------------------------------------
  // RARITY — the tier a dealt card is rolled at.
  //
  // These are FALLBACKS ONLY. rarities.csv is the whole definition (see
  // rarityTable.js); this list exists so the game still deals cards if the file
  // is missing or empty, and so the ladder has a shape before the CSV is
  // parsed. Editing names or colours here does nothing — the CSV overwrites the
  // lot at boot, which is the same contract upgrades.csv has for the display
  // half of an upgrade.
  //
  // ROW ORDER IS TIER ORDER. The first is the floor and must have statMul 1.
  // ---------------------------------------------------------------------------
  rarities: [
    { id: 'common', name: 'Common', color: 0xb8c2cc, glow: 0, statMul: 1, weightEarly: 70, weightLate: 18, sfx: 'rarityCommon' },
    { id: 'uncommon', name: 'Uncommon', color: 0x5ee07a, glow: 0.35, statMul: 1.12, weightEarly: 22, weightLate: 26, sfx: 'rarityUncommon' },
    { id: 'rare', name: 'Rare', color: 0x4aa8ff, glow: 0.7, statMul: 1.25, weightEarly: 6, weightLate: 28, sfx: 'rarityRare' },
    { id: 'epic', name: 'Epic', color: 0xb565ff, glow: 1.1, statMul: 1.45, weightEarly: 1.6, weightLate: 19, sfx: 'rarityEpic' },
    { id: 'legendary', name: 'Legendary', color: 0xffb020, glow: 1.6, statMul: 1.7, weightEarly: 0.4, weightLate: 9, sfx: 'rarityLegendary' },
  ],

  // What fraction of a tier's multiplier an INTEGER-ONLY upgrade gets paid,
  // through its family's continuous stat, since its own count can't take a
  // fraction. See payFamily in systems/rarity.js for why this is well under 1.
  rarityPayout: 0.35,

  // The player level at which the rarity odds have fully crossed from the
  // `weightEarly` column to `weightLate`. Level rather than elapsed time
  // because the roll happens on the level-up screen, which is the one moment
  // the player is being asked to care — and because a run that levels slowly
  // has earned its odds staying low.
  rarityRampLevel: 20,

  // How the rarity ring is drawn. The card is a clip-path hexagon, and a
  // clip-path eats both an outer border and a drop-shadow on the same element
  // — so the ring is an INSET stroke (the trick the focus state already used)
  // and the bloom lives on a wrapper that isn't clipped. See ui.js.
  rarityCard: {
    // Ring thickness in px. The selection highlight is drawn as a second ring
    // just inside this one, so the two read as "which tier" and "which card"
    // rather than fighting for the same edge.
    ringWidth: 3,
    // Bloom, in px, at glow 1. Each tier's `glow` column scales it, so the
    // floor tier at 0 has a ring and no bloom at all.
    glowRadius: 16,
    // ...and a second, tighter pass so a high tier has a hot edge as well as a
    // halo. One big soft shadow alone reads as fog rather than as the card
    // being lit.
    glowTight: 5,
  },

  // NOTE: the display fields above (name, desc, maxStacks, enabled) and each
  // upgrade's card art are OVERWRITTEN at boot from upgrades.csv, which is the
  // source of truth for them — see upgradeTable.js. Editing them here only
  // changes what an upgrade falls back to when the CSV has no row for it.
  // What an upgrade DOES — its apply() — is only ever code, and lives here.

  // ---------------------------------------------------------------------------
  // THE LEVEL-UP PAUSE — the beat between filling the XP bar and picking a
  // card. The world eases into slow motion and holds there with every body
  // frozen where it stands (systems/levelUpTime.js), the cards dither in over
  // the top of it, and the pick hands the run straight back while the speed
  // ramps home. Times are WALL-CLOCK seconds: they're what decides the
  // dilation, so they can't be measured in it.
  // ---------------------------------------------------------------------------
  levelUp: {
    enabled: true,
    hold: 0.5, // time scale the world settles at while the cards are up
    // Long enough to read as the ocean leaning into the slow motion. Under
    // about a fifth of a second it's over before you've registered the level,
    // which is indistinguishable from the old instant pop-up.
    dilateTime: 0.45,
    // A beat at the BOTTOM of the ramp before the cards start arriving, so the
    // slow motion is seen as slow motion rather than as a frame behind a menu.
    menuDelay: 0.12,
    // Back to full speed after a pick. Gameplay is live for all of it — the
    // run re-engages on the frame the card is clicked and the world catches up
    // underneath it.
    restoreTime: 0.55,

    // The mix sags with the picture. Gentler than the death dive by default:
    // this sits on top of the filter duck the upgrade screen already applies
    // (music.js duckForUpgrade), and a full-follow drop on top of that buries
    // the loop.
    audio: {
      enabled: true,
      follow: 0.5, // 0 = sound ignores the dilation, 1 = it slows exactly as far
      minRate: 0.5, // floor on the playback rate
      glide: 0.2, // seconds of smoothing on the music's rate, so it doesn't zipper
    },

    // How the cards themselves arrive — which noise, how long, how chunky —
    // lives under CONFIG.reveals.upgrades, with the splash's and the score
    // card's, because all three share one machine: ui/dither.js builds the
    // masks and ui.js applies them.
  },

  // ---------------------------------------------------------------------------
  // REVEALS — how surfaces arrive and leave.
  //
  // Nothing in this UI cuts in or plain-fades. Every menu dissolves through a
  // mask built from noise, and each surface gets its OWN algorithm so the
  // transitions read as different events rather than one effect used three
  // times. The masks are built in ui/dither.js and applied by ui.js.
  //
  // Two styles:
  //   'hex'     an ordered dither on a hexagonal lattice — the shape the cards
  //             are clipped to and the seabed is tiled with — with the noise
  //             deciding where it fills in. Chunky, stepped, deliberately
  //             digital. Needs a surface with an inner box to mask.
  //   'smooth'  no lattice and no dithering: the field alone with a soft edge.
  //
  // The algorithms (NOISE_ALGOS in ui/dither.js — keep the tuner's dropdowns
  // in sync with it): value, perlin, simplex, worley, ridged, billow.
  // ---------------------------------------------------------------------------
  reveals: {
    enabled: true,

    // Shared by every surface, because it's what the bake costs are made of:
    // one set of tiles per ALGORITHM, and these decide how many and how big.
    // Roughly 60ms per algorithm at these numbers, 130 for the cellular one,
    // paid once at boot while the browser is idle (ui.js warmReveals).
    field: {
      size: 128, // px the field is baked at — it gets stretched over the surface
      octaves: 2, // fractal detail. Costs a full pass of the field each
      scale: 8, // noise cells across the field: higher is finer, patchier
      levels: 12, // openness steps the reveal is quantised to
      phases: 5, // frames in the boil loop (slices of one continuous field)
      boilHz: 12, // frames per second of churn — below 60 on purpose, like hand-drawn animation
      drift: 26, // px the field slides while it opens, settling as it lands
      over: 18, // % the field oversizes the surface, so the drift can't pull it off the edge
    },

    // THE UPGRADE CARDS. Billow through the hex lattice: puffy clumps of
    // hexagons filling in, which is the most "game" of the three and belongs
    // on the one screen that interrupts play. Nothing on the menu can be
    // clicked until it lands, so a held fire button can't pick through it.
    upgrades: {
      style: 'hex',
      algo: 'billow',
      inTime: 0.5,
      outTime: 0.22,
      steps: 14, // dither levels — fewer is chunkier
      hexSize: 24, // hex width, point to point, in px
      // How much of the reveal the field owns, with the lattice taking the
      // rest. The two exponents add to 1, so the reveal still paces linearly
      // however it's split.
      bias: 0.35,
      softness: 0, // a hard edge: the hexes ARE the edge
      curve: 1,
    },

    // THE SPLASH, LEAVING. Worley breaks it into rounded cells that clear one
    // by one — a title screen coming apart rather than fading out. The run is
    // already live underneath it by the time this runs (see riveSplash.js), so
    // it can afford to be the longest of the three.
    splash: {
      style: 'smooth',
      algo: 'worley',
      outTime: 0.85,
      scale: 6, // coarser than the default: bigger cells read better full-screen
      softness: 0.3,
      curve: 1.4,
    },

    // THE SCORE CARD. Ridged comes in as veins and strands rather than blobs —
    // slower and colder, which is the right note for the end of a run. Runs
    // alongside the card's rise (CONFIG.death.fadeIn), not instead of it.
    scoreCard: {
      style: 'smooth',
      algo: 'ridged',
      inTime: 0.9,
      scale: 9,
      softness: 0.35,
      curve: 1.7,
    },

    // THE PAUSE MENU. Plain simplex — the last algorithm of the four, and the
    // right one here precisely because it is the least characterful: this is
    // the only surface the player opens ON PURPOSE, possibly several times a
    // run, and a transition with a strong personality gets tiresome at that
    // frequency. Fast in both directions for the same reason. Fine-grained
    // (scale 14) so it reads as the panel resolving rather than as weather.
    pause: {
      style: 'smooth',
      algo: 'simplex',
      inTime: 0.22,
      outTime: 0.16,
      scale: 14,
      softness: 0.4,
      curve: 1.5,
    },
  },

  // ---------------------------------------------------------------------------
  // LEVEL-UP CARD ART — a hex background image per upgrade, with a dark
  // overlay between the image and the text so the card stays readable. Which
  // image goes with which upgrade is the `cardArt` column of upgrades.csv
  // (valid keys are LEVELUP_IMAGE_KEYS below); the overlay is tunable here
  // because it's a look, not content.
  // ---------------------------------------------------------------------------
  levelUpCards: {
    overlayOpacity: 0.55,
    overlayColor: 0x000000,
  },
};

// Kept separate from the actual image data (in ui/levelUpImages.js) so this
// config file — otherwise pure data — never has to import a UI-layer module
// just to know the list of valid keys for the dropdown below.
// Must stay in sync with LEVELUP_IMAGES in ui/levelUpImages.js — same keys, same
// order. Ordered by biome (beach -> tide pools -> reef -> open ocean -> deep sea)
// rather than alphabetically, so the dropdown reads as the depth progression.
// `OpeanOcean` keeps its original misspelling on purpose: renaming the key would
// silently blank the art on any saved tuning that already references it.
export const LEVELUP_IMAGE_KEYS = [
  'Beach_001', 'Beach_002', 'Beach_003', 'Crab', 'SeaLion', 'Seagull',
  'TidePool_001', 'TidePool_002', 'TidePool_003', 'Periwinkles', 'SeaAnemone', 'SeaStar',
  'Reef_001', 'Reef_002', 'Reef_003', 'MoorishIdol', 'MorayEel', 'Octopus',
  'OpeanOcean_001', 'OpeanOcean_002', 'OpeanOcean_003', 'GreatWhite', 'Humpback', 'Sardines',
  'DeepSea_001', 'DeepSea_002', 'DeepSea_003', 'VampireSquid', 'DumboOctopus', 'AnglerFish',
];

// ============================================================================
// TUNER — which values get a slider in the in-game panels.
// Add a line here to expose any config value. Nothing else to wire up.
//
// A group renders in the ` tuner by default. Give it `panel: 'companions'` or
// `panel: 'enemies'` and it renders as a tab in the Look & Sound panel (T)
// instead, alongside the models and the upgrade table for the same creatures.
// Both panels build their controls from the same code, so where a group lives
// is purely about where you'd go looking for it — moving one is this one line.
//
// EVERY group carries a `section` — a named run one level up. In the Look &
// Sound tabs those are apex predators, fish & schools, escorts, thrown &
// launched; in the main tuner they are the seven families in ui/tuner.js, each
// with its own colour. Both panels were flat lists where "is the eel an escort
// or an aura?", or "where does weather live?", could only be answered by
// opening things. The panel decides which sections it shows and in what order
// (SECTIONS in ui/tuner.js, SECTION_ORDER in ui/textures.js); a group whose
// section isn't in that list still renders, under "More", rather than
// disappearing.
// ============================================================================

// ---------------------------------------------------------------------------
// The controls a bioluminescent skin has, once. `prefix` is the config path
// they hang off, so the same list serves `biolumSkin.base` and every preset
// under `biolumSkin.presets`.
//
// A preset that omits a key inherits it from base, and the tuner writes the
// key into the preset the moment the slider moves — so dragging a control in a
// species' group is what promotes that value from inherited to overridden.
// That is the intended workflow and the reason the rows are identical.
// ---------------------------------------------------------------------------
// What a bioluminescence group's controls actually resolve to. `base` is read
// straight; a preset is base with its own overrides on top, exactly as
// systems/biolumSkin.js layers them — the readouts have to agree with the
// shader or they are worse than no readout at all.
function resolveBiolumCfg(prefix) {
  const base = CONFIG.biolumSkin?.base ?? {};
  const PRESETS = 'biolumSkin.presets.';
  if (!prefix.startsWith(PRESETS)) return base;
  return { ...base, ...(CONFIG.biolumSkin?.presets?.[prefix.slice(PRESETS.length)] ?? {}) };
}

// Rec.709, matching the bright pass in systems/post.js exactly. This is the
// coefficient set that makes blue nearly invisible to bloom (0.07 against
// green's 0.72), which is the single most surprising thing about tuning a
// cold-palette glow and the reason this readout exists.
function relLuminance(hex) {
  const n = hex >>> 0;
  return 0.2126 * (((n >> 16) & 255) / 255)
    + 0.7152 * (((n >> 8) & 255) / 255)
    + 0.0722 * ((n & 255) / 255);
}

function biolumBloomReadout(prefix) {
  const cfg = resolveBiolumCfg(prefix);
  // What the shader adds at a FULLY LIT pixel, at the top of the breath. The
  // ceiling, not the average: bioMask() only reaches 1 where the noise field
  // peaks, so most of a lit patch sits below this. It is still the right
  // number to check, because bloom is a threshold — what matters is whether
  // the brightest pixels get over it, not what the mean does.
  const gain = (cfg.strength ?? 1.6) * (cfg.glow ?? 1) * (1 + (cfg.pulseAmp ?? 0));
  const stops = [['A', cfg.colorA ?? 0x00e5ff], ['B', cfg.colorB ?? 0x7b2dff], ['C', cfg.colorC ?? 0xffd166]];
  const vals = stops.map(([n, c]) => [n, relLuminance(c) * gain]);
  const bloom = CONFIG.bloom ?? {};
  const thr = bloom.threshold ?? 0.55;
  const clear = vals.filter(([, v]) => v >= thr).length;
  if (bloom.enabled === false) {
    return ['bloom is OFF in CONFIG.bloom — nothing here glows past its own colour'];
  }
  return [
    `brightest pixel: ${vals.map(([n, v]) => `${n} ${v.toFixed(2)}`).join('   ')}`,
    `threshold ${thr.toFixed(2)} · ${clear}/3 ramp stops clear it · bloom intensity ${(bloom.intensity ?? 0).toFixed(2)}`,
  ];
}

// The tempo the readouts quote. The AUDIBLE rate lives inside music.js behind
// a ramp and importing it here would be a cycle (music.js imports CONFIG), so
// this is the configured tempo — which is what it settles to, and what you are
// tuning against anyway.
function tunerBpm() {
  return Math.max(1, (CONFIG.music?.bpm ?? 120) * (CONFIG.music?.playbackRate ?? 1));
}

function biolumTimingReadout(prefix) {
  const cfg = resolveBiolumCfg(prefix);
  const bpm = tunerBpm();
  const beat = 60 / bpm;
  const bpb = Math.max(1, CONFIG.beatSync?.beatsPerBar ?? 4);
  const synced = CONFIG.beatSync?.enabled !== false;

  // A picker on 'free' gets its real period printed AND the figure it is
  // closest to, so setting it properly is reading one line rather than doing
  // the arithmetic. This is the whole point of the row.
  const show = (division, freeSeconds) => {
    const secs = synced ? divisionBeatsIn(division, bpb) * beat : 0;
    if (secs > 0) return `${division} · ${secs.toFixed(2)}s`;
    const near = nearestDivisionIn(freeSeconds, beat, bpb);
    return `free · ${freeSeconds.toFixed(2)}s (nearest: ${near})`;
  };

  // pulseSpeed is radians/sec, flickerRate is steps/sec — both converted to
  // one period so the two halves of the line are comparable.
  const breath = (Math.PI * 2) / Math.max(0.01, cfg.pulseSpeed ?? 1.8);
  const flick = 1 / Math.max(0.01, cfg.flickerRate ?? 2.5);
  const steps = Math.round(cfg.phaseSteps ?? 0);
  const spread = cfg.phaseSpread ?? 1;

  return [
    `breath  ${show(cfg.pulseSync, breath)}`,
    `flicker ${show(cfg.flickerSync, flick)}`,
    `${bpm.toFixed(0)} bpm · beat ${beat.toFixed(2)}s · bar ${(beat * bpb).toFixed(2)}s`,
    spread <= 0 ? 'school: lockstep (spread 0)'
      : steps > 0 ? `school: ${steps} slots across ${(spread * 100).toFixed(0)}% of the cycle`
        : 'school: continuous random — individuals sit OFF the grid',
  ];
}

// EVERY beat-synced effect in the game, in one list.
//
// The pickers themselves are scattered on purpose — each sits beside the thing
// it drives, because auditioning a fish by scrolling away from it is not
// auditioning it. The cost of that is you can no longer see the whole picture,
// and "the whole picture" is exactly what you need when the question is
// whether two effects are fighting each other. So this list exists, and the
// Beat sync group prints it.
//
// Adding a synced effect and forgetting this line is the one drift worth
// guarding: tools/beat-sync-test.mjs checks that every '…Sync' key reachable
// from the tuner schema appears here.
const SYNCED_FX = [
  ['lanternfish', () => resolveBiolumCfg('biolumSkin.presets.lantern'), ['pulseSync', 'flickerSync']],
  ['lantern ray', () => resolveBiolumCfg('biolumSkin.presets.veil'), ['pulseSync', 'flickerSync']],
  ['abyss shark', () => resolveBiolumCfg('biolumSkin.presets.abyssHunter'), ['pulseSync', 'flickerSync']],
  ['ember crab', () => resolveBiolumCfg('biolumSkin.presets.emberClaw'), ['pulseSync', 'flickerSync']],
  // Listed even though it is STATIC — carapace zeroes pulseAmp and flickerAmp,
  // so neither division does anything today. It still owns the pickers, and a
  // row that says '2 bars / 1/8' next to an effect with no amplitude is the
  // honest reading of "configured but silent". Dropping it instead would mean
  // the day anyone turns that amplitude up, the effect is beat-synced and
  // absent from the one list that is supposed to show every synced effect.
  ['walking crab (static)', () => resolveBiolumCfg('biolumSkin.presets.carapace'), ['pulseSync', 'flickerSync']],
  // The player's own glow, which is NOT a biolumSkin preset — Glow Up! lights
  // the seal's existing noise pattern instead of painting one over it, so it
  // owns its own breath rather than inheriting a species preset's. The escort
  // squad wears that same noise pattern and is deliberately absent from this
  // list: it has no glow of its own to put on the grid. See setNoiseGlow in
  // systems/noiseShader.js.
  ['seal — Glow Up!', () => CONFIG.biolum?.skin ?? {}, ['pulseSync']],
  ['octopus arms', () => CONFIG.octoGrab?.glow ?? {}, ['shimmerSync']],
  ['grass', () => CONFIG.grass?.sway ?? {}, ['speedSync', 'flutterSync']],
  ['bakalar beam', () => CONFIG.bakalar?.beam ?? {}, ['bandSync']],
  ['night sky', () => CONFIG.constellations ?? {}, ['bloomSync']],
];

// The generic version of the bioluminescence timing rows, for the effects that
// have one or two synced phases rather than a whole preset behind them.
//
// `entries` are [label, path to the division, () => the free period in
// seconds]. The free period is a thunk because it has to be read at paint
// time — the slider next to it is what moves it.
function fxTimingReadout(entries) {
  const bpm = tunerBpm();
  const beat = 60 / bpm;
  const bpb = Math.max(1, CONFIG.beatSync?.beatsPerBar ?? 4);
  const synced = CONFIG.beatSync?.enabled !== false;
  const lines = entries.map(([label, path, freeSeconds]) => {
    const free = freeSeconds();
    const secs = synced ? divisionBeatsIn(getPath(CONFIG, path), bpb) * beat : 0;
    if (secs > 0) return `${label}  ${getPath(CONFIG, path)} · ${secs.toFixed(2)}s`;
    // Off the grid: print what it actually is and what it is nearest, so
    // putting it on the grid is reading a line rather than doing the maths.
    return `${label}  free · ${free.toFixed(2)}s (nearest: ${nearestDivisionIn(free, beat, bpb)})`;
  });
  return [...lines, `${bpm.toFixed(0)} bpm · beat ${beat.toFixed(2)}s · bar ${(beat * bpb).toFixed(2)}s`];
}

// How much of a celestial body clears the bloom bright pass.
//
// Two numbers nobody can hold in their head at once: the halo's own falloff
// curve, and the fact that post.js thresholds Rec.709 LUMINANCE — where this
// pale blue moon is worth 0.75 and a deeper blue would be worth a third of
// that. "Turn the halo up until it glows" is otherwise a slider you drag
// blind, because the part of the halo you can see is the part the disc is not
// covering, and that is where the falloff has already eaten most of it.
function celestialBloomReadout(which) {
  const cfg = CONFIG.dayNight?.[which] ?? {};
  const bloom = CONFIG.bloom ?? {};
  if (bloom.enabled === false) return ['bloom is OFF in CONFIG.bloom — nothing here glows'];
  const thr = bloom.threshold ?? 0.55;
  const lum = relLuminance(cfg.color ?? 0xffffff);

  // The halo's two summed lobes, straight out of haloFragment in
  // systems/celestial.js. Mirrored rather than imported because config.js
  // cannot import a system — and a drift here is a wrong readout, not a wrong
  // render, so it is worth the copy.
  const falloff = (d) => {
    const r = Math.max(0, 1 - d);
    return Math.pow(r, 2.6) * 0.65 + Math.pow(r, 9.0) * 0.35;
  };
  // Where the disc's own edge sits on the halo quad: the halo is `halo` times
  // the disc across, so everything inside this radius is hidden behind it.
  const rim = 1 / Math.max(1, cfg.halo ?? 2);
  // The SOLVED strength, matching haloStrengthFor in systems/celestial.js —
  // reporting the raw slider here would tell you the corona is dark on a body
  // whose `bloomRim` is quietly holding it lit.
  const want = cfg.bloomRim ?? 0;
  const solved = want > 0
    ? Math.max(thr * want / Math.max(1e-4, lum * falloff(rim)), cfg.haloStrength ?? 0.5)
    : (cfg.haloStrength ?? 0.5);
  const at = (d) => falloff(d) * lum * solved;

  // How far out the corona still clears the threshold — the actual answer to
  // "how big is the glow", in disc radii rather than in halo units.
  let reach = rim;
  for (let d = rim; d <= 1; d += 0.005) { if (at(d) >= thr) reach = d; }
  const discLum = lum * (cfg.brightness ?? 1);

  const art = cfg.texture || cfg.model;
  const lines = [
    `disc ${discLum.toFixed(2)} · corona rim ${at(rim).toFixed(2)} · threshold ${thr.toFixed(2)}`
      + (solved > (cfg.haloStrength ?? 0.5) + 1e-6 ? ` · bloomRim solved halo to ${solved.toFixed(2)}` : ''),
    at(rim) >= thr
      ? `corona blooms out to ${(reach / rim).toFixed(2)}x the disc radius`
      : `the corona never blooms — raise halo strength past ${(thr / Math.max(0.001, falloff(rim) * lum)).toFixed(2)}`,
  ];
  // The disc figure above is the WHITE-ART case. Painted art multiplies into
  // it, and the art here is dark — so the honest reading is a range, and the
  // number that matters is the one for the mid-greys, not the highlights.
  if (art) {
    lines.push('with art the disc figure is multiplied by each pixel, so it is a RANGE:');
    lines.push(`  mid-grey (0.45 sRGB ~ 0.17 linear) -> ${(discLum * 0.17).toFixed(2)}`
      + `,  highlights (0.7 ~ 0.45) -> ${(discLum * 0.45).toFixed(2)}`);
    // Dark maria under the threshold and bright wisps over it is the GOOD
    // outcome — that split is what leaves craters visible instead of a white
    // blob. Only flag it when the whole disc is dark.
    lines.push(discLum * 0.45 >= thr
      ? 'highlights bloom, dark areas do not — which is what keeps the craters readable'
      : `nothing on the disc blooms — brightness ${(thr / Math.max(0.01, lum * 0.45)).toFixed(2)} would light the highlights`);
  } else {
    lines.push(discLum >= thr ? 'the disc blooms' : `the disc does NOT bloom — raise brightness past ${(thr / Math.max(0.01, lum)).toFixed(2)}`);
  }
  return lines;
}

// The Glow Up! day/night ramp, as a table. `elementPower` itself lives in
// systems/elements.js and cannot be imported here (it imports CONFIG), so the
// curve is restated — it is three lines and the alternative is a slider whose
// effect you can only see by waiting for dusk.
function elementPowerReadout() {
  const n = CONFIG.biolum?.night ?? {};
  if (!n.enabled || CONFIG.dayNight?.enabled === false) {
    return ['no day cycle (or the night bonus is off) — the element is always fully awake'];
  }
  const floor = Math.min(1, Math.max(0, n.dayPower ?? 0));
  const g = Math.max(0.05, n.blendGamma ?? 1);
  const at = (dark) => floor + (1 - floor) * Math.pow(dark, g);
  const row = [0, 0.25, 0.5, 0.75, 1]
    .map((d) => `${String(Math.round(d * 100)).padStart(3)}%->${String(Math.round(at(d) * 100)).padStart(3)}%`)
    .join('  ');
  return [
    'how dark it is -> how much glow + elemental effect:',
    row,
    floor <= 0
      ? 'at noon: no glow at all, and no elemental hit is applied (statuses already ticking still finish)'
      : `at noon: ${Math.round(floor * 100)}% power`,
  ];
}

function beatGridReadout() {
  const bpm = tunerBpm();
  const beat = 60 / bpm;
  const bpb = Math.max(1, CONFIG.beatSync?.beatsPerBar ?? 4);
  if (CONFIG.beatSync?.enabled === false) {
    return ['sync is OFF — every effect below is running at its own rate in seconds'];
  }
  // The conversion table, once, so no picker anywhere needs one beside it.
  const grid = ['1/16', '1/8', '1/4', '1/2', '1 bar', '2 bars', '4 bars', '8 bars']
    .map((n) => `${n} ${(divisionBeatsIn(n, bpb) * beat).toFixed(2)}s`)
    .join('   ');
  const fx = SYNCED_FX.map(([label, read, keys]) => {
    const cfg = read();
    return `${label}: ${keys.map((k) => cfg[k] ?? 'free').join(' / ')}`;
  });
  return [`${bpm.toFixed(0)} bpm · ${bpb}/4 · beat ${beat.toFixed(2)}s · bar ${(beat * bpb).toFixed(2)}s`, grid, ...fx];
}

// THE ROW THAT ANSWERS "is there anything up there to join up".
//
// The constellations don't have a star count of their own — they take a share
// of the field the sky shader is already painting, so the control that decides
// how many there are lives in a different group (Day & night's `star density`)
// and its effect here is not something you can work out by looking at it. On a
// portrait phone the sky band is a quarter the width of a landscape one, so
// the same density that gives a rich field on a desktop can leave a phone with
// four stars and nothing to draw between them. That is exactly the failure
// this prints before it happens.
//
// The counts are real: this walks the same placement rule the system does,
// over the frame each aspect ratio would actually build.
// What a food chain buys the sky, printed beside the sliders that decide it.
//
// The build is sized on `maxLevel`, so these rows are the only place the COST
// of a deep chain is visible: raising it does not change what a resting sky
// looks like, it quietly makes more geometry that stays dark all run.
function chainReachReadout() {
  const cfg = CONFIG.constellations ?? {};
  if (cfg.chain?.enabled === false) {
    return ['off — the sky is the same width however deep the chain goes'];
  }
  const rest = chainReachAt(0, cfg);
  const most = chainReachAt(Infinity, cfg);
  const lines = [`no chain: reach ${rest.radius.toFixed(1)} units · ${rest.links.toFixed(1)} links per star`];
  for (const level of [2, 5, most.depth]) {
    if (level > most.depth) continue;
    const at = chainReachAt(level, cfg);
    lines.push(`chain ${String(level).padStart(2)}: reach ${at.radius.toFixed(1)} (x${(at.radius / rest.radius).toFixed(2)})`
      + ` · ${at.links.toFixed(1)} links per star`
      + (level === most.depth ? '  <- the whole build is sized here' : ''));
  }
  const grow = (most.radius / Math.max(0.001, rest.radius)) * (most.links / Math.max(0.001, rest.links));
  lines.push(`a full chain is roughly ${grow.toFixed(1)}x the link geometry of a resting sky`);
  return lines;
}

function constellationReadout() {
  const cfg = CONFIG.constellations ?? {};
  if (!cfg.enabled) return ['off — only the sky shader’s own dots are drawn'];

  const density = CONFIG.dayNight?.stars?.density ?? 0.55;
  const air = CONFIG.arena.viewHeight * CONFIG.arena.surfaceFromTop;
  const margin = cfg.margin ?? 4;
  const keep = Math.max(0, Math.min(1, cfg.brightest ?? 0.5));
  const threshold = 1 - (1 - STAR_THRESHOLD) * keep;

  const lines = [`one cell per ${(1 / Math.max(0.01, density)).toFixed(2)} units · sky band ${air.toFixed(1)} tall`];
  let thinnest = Infinity;
  for (const [name, aspect] of [['landscape 16:9', 16 / 9], ['phone 9:19.5', 9 / 19.5]]) {
    // The field is built across the ARENA, so a widened one really does have
    // more sky to fill — count it that way or this under-reports exactly when
    // the extra width is what rescued a thin field.
    const half = (CONFIG.arena.viewHeight * aspect * Math.max(1, CONFIG.arena.widthScale ?? 1)) / 2;
    const field = starsIn(
      { left: -half - margin, right: half + margin, bottom: 0, top: air + margin },
      density,
    );
    const drawn = field.filter((s) => s.seed > threshold).length;
    thinnest = Math.min(thinnest, drawn);
    lines.push(`${name}: ${field.length} in the sky, ${drawn} drawn, ~${Math.round(drawn * (cfg.links ?? 2) * 0.75)} links`);
  }
  if (thinnest < 6) {
    lines.push('too thin to read as constellations — raise `star density` under Day & night');
  }
  if (!CONFIG.dayNight?.enabled) {
    lines.push('the day/night cycle is OFF, so night never comes and none of this is drawn');
  }
  return lines;
}

function biolumSkinItems(prefix) {
  const at = (k) => `${prefix}.${k}`;
  return [
    {
      path: at('pattern'), label: 'pattern',
      options: [
        'blotches', 'spots', 'net', 'stripes', 'veins', 'pulse', 'speckle',
        // the organic family
        'flow', 'billow', 'marble',
      ],
    },
    // THE ROW THAT ANSWERS "will this actually bloom". Everything above and
    // below it is a number you set; this is the number you were guessing at.
    //
    // post.js's bright pass thresholds Rec.709 LUMINANCE, not the biggest
    // channel, so this is the one place the palette and the strength sliders
    // meet: a saturated blue at strength 3 sits at 0.22 and barely lights,
    // while a pale cyan at the same strength is at 2.1. Both ends of the ramp
    // are shown because it is normal for one of them to bloom and the other
    // not to — that is what makes a pattern read as having a hot core.
    { type: 'readout', label: 'bloom check', lines: () => biolumBloomReadout(prefix) },
    // Fraction of BODY LENGTH per feature, so it means the same thing after
    // any per-asset Size change.
    { path: at('scale'), min: 0.04, max: 1.2, step: 0.01, label: 'feature size' },
    { path: at('strength'), min: 0, max: 5, step: 0.05, label: 'glow strength (this species)' },
    { path: at('glow'), min: 0, max: 4, step: 0.05, label: 'bloom push (× strength)' },
    { path: at('coverage'), min: 0, max: 1, step: 0.01, label: 'how much of the body lights' },
    { path: at('contrast'), min: 0.1, max: 6, step: 0.05, label: 'edge hardness' },
    { path: at('bodyDarken'), min: 0.05, max: 1, step: 0.01, label: 'body darkening under the glow' },
    { path: at('tailBias'), min: -1, max: 1, step: 0.05, label: 'head ← → tail bias' },
    { path: at('hueBias'), min: -1, max: 1, step: 0.05, label: 'colour shift along the body' },
    // Only does anything on a creature whose asset declares `eyeStalks` —
    // today the two crabs. Left visible on every preset so it is discoverable
    // rather than hidden behind a species check.
    { path: at('eyeStrength'), min: 0, max: 6, step: 0.05, label: 'eye glow' },
    { path: at('eyeColor'), type: 'color', label: 'eye colour' },
    { path: at('eyeFalloff'), min: 1, max: 8, step: 0.1, label: 'eye tightness (1 = whole stalk, 6 = pinpoint)' },
    { path: at('eyePulse'), min: 0, max: 1, step: 0.02, label: 'eye breath depth' },
    // Only flow / billow / marble read this.
    { path: at('warp'), min: 0, max: 3, step: 0.05, label: 'organic warp (flow/billow/marble)' },
    // --- motion ---
    // Drift is the one motion here that is honestly a rate in seconds: it
    // translates through the noise rather than repeating, so there is no cycle
    // to put on the grid. See the note in systems/biolumSkin.js's FRAG_BODY.
    { path: at('flow'), min: 0, max: 0.6, step: 0.01, label: 'pattern drift (not synced)' },
    // The world-space field. Amp and size are per species — a seabed crawler
    // is not in the same water as a shoal — but the speed is the current, so
    // it only exists on the shared base and is not offered here.
    { path: at('schoolAmp'), min: 0, max: 1, step: 0.01, label: 'school wave depth (world space)' },
    { path: at('schoolScale'), min: 1, max: 30, step: 0.5, label: 'school wave size (world units)' },
    { path: at('pulseAmp'), min: 0, max: 1, step: 0.01, label: 'breath depth' },
    // One breath per division. The row below only does anything at 'free'.
    { path: at('pulseSync'), type: 'choice', options: BEAT_DIVISIONS, label: 'breath — one per' },
    { path: at('pulseSpeed'), min: 0, max: 8, step: 0.1, label: '…or free-running, rad/s' },
    // --- flicker ---
    // Noise in time, not a sine — the sine is `breath depth` above. At 0 the
    // creature is perfectly steady, which is a look, not an absence of one.
    { path: at('flickerAmp'), min: 0, max: 1, step: 0.01, label: 'flicker depth' },
    { path: at('flickerSync'), type: 'choice', options: BEAT_DIVISIONS, label: 'flicker — one step per' },
    { path: at('flickerRate'), min: 0.1, max: 12, step: 0.1, label: '…or free-running, per second' },
    // A live reading of what those two pickers cost in real seconds at the
    // tempo currently playing, so "2 bars" is a duration you can judge rather
    // than a conversion you have to do in your head.
    { type: 'readout', label: 'timing', lines: () => biolumTimingReadout(prefix) },
    // How far apart two individuals sit in the cycle. 0 is lockstep, which is
    // the setting to use while judging a pattern and the wrong one afterwards.
    { path: at('phaseSpread'), min: 0, max: 1, step: 0.01, label: 'phase spread across a school' },
    // ...and how many slots that spread may use. This is what keeps a school
    // ON the beat while still being spread out — see the note on phaseSteps in
    // CONFIG.biolumSkin.base. 0 is a continuous random offset, which puts
    // every individual slightly off the grid.
    { path: at('phaseSteps'), min: 0, max: 16, step: 1, label: 'phase slots (0 = off-grid random)' },
    // --- colour ---
    { path: at('hueSpread'), min: 0, max: 1, step: 0.01, label: 'colour variety (0 = one colour)' },
    { path: at('hueScale'), min: 0.1, max: 4, step: 0.05, label: 'colour patch size' },
    { path: at('colorA'), type: 'color', label: 'colour A' },
    { path: at('colorB'), type: 'color', label: 'colour B' },
    { path: at('colorC'), type: 'color', label: 'colour C' },
  ];
}

// Read off CONFIG rather than hardcoded, so adding a preset to the config adds
// its tuner group with it and neither can drift from the other.
function biolumSkinGroups() {
  const LABELS = {
    lantern: 'Bioluminescence — lanternfish',
    veil: 'Bioluminescence — lantern ray',
    abyssHunter: 'Bioluminescence — abyss shark',
    reefGlow: 'Bioluminescence — glowing tang',
    dartGlow: 'Bioluminescence — glowing darter',
    emberClaw: 'Bioluminescence — ember crab',
    // Not bioluminescence at all — the one preset using the generator as
    // pigment rather than light. Named differently on purpose, so nobody goes
    // looking for it under the glowing species. See `luminous`.
    carapace: 'Shell pattern — walking crab (daytime)',
  };
  const groups = [{
    group: 'Bioluminescence — shared base',
    section: 'Look & FX',
    items: [
      { path: 'biolumSkin.enabled', type: 'bool', label: 'glowing skin (all species)' },
      // The current the world-space wave drifts on. Base only, and offered
      // only here: every creature reads one field, so a per-species speed
      // would be several fields pretending to be one.
      { path: 'biolumSkin.base.schoolSpeed', min: 0, max: 20, step: 0.5, label: 'school wave speed (world units/s)' },
      ...biolumSkinItems('biolumSkin.base'),
    ],
  }];
  for (const name of Object.keys(CONFIG.biolumSkin?.presets ?? {})) {
    groups.push({
      group: LABELS[name] ?? `Bioluminescence — ${name}`,
      section: 'Look & FX',
      items: biolumSkinItems(`biolumSkin.presets.${name}`),
    });
  }
  return groups;
}

export const TUNER_SCHEMA = [
  {
    group: 'Ocean colors',
    section: 'The ocean',
    items: [
      { path: 'colors.sky', type: 'color', label: 'sky' },
      { path: 'colors.waterShallow', type: 'color', label: 'shallow water' },
      { path: 'colors.waterMid', type: 'color', label: 'mid water' },
      { path: 'colors.waterDeep', type: 'color', label: 'deep water' },
      { path: 'colors.seabed', type: 'color', label: 'seabed' },
      { path: 'colors.surface', type: 'color', label: 'surface line' },
      { path: 'colors.zoneStops.0', min: 0, max: 1, step: 0.01, label: 'shallow -> mid depth' },
      { path: 'colors.zoneStops.1', min: 0, max: 1, step: 0.01, label: 'mid -> deep depth' },
    ],
  },
  {
    group: 'Day & night',
    section: 'The ocean',
    items: [
      { path: 'dayNight.enabled', type: 'bool', label: 'day/night cycle' },
      { path: 'dayNight.scale', min: 0, max: 600, step: 5, label: 'clock speed (x real time)' },
      { path: 'dayNight.rate', min: 0, max: 10, step: 0.25, label: 'time rate multiplier' },
      // Turn this off before tuning a specific hour, or the slider under it
      // does nothing and the reason isn't visible from the panel.
      { path: 'dayNight.startFromSystemClock', type: 'bool', label: 'open at the real time of day' },
      { path: 'dayNight.startHour', min: 0, max: 24, step: 0.25, label: 'first run starts at (if not)' },
      // In seconds of ordinary passage, so it reads against `scale` above: at
      // 60x, 0.35 is 21 in-game seconds per orb, ~+10% of clock over a run.
      { path: 'dayNight.chumSeconds', min: 0, max: 5, step: 0.05, label: 'clock per chum eaten (s)' },
      { path: 'dayNight.restartAtMorning', type: 'bool', label: 'every run starts at that hour' },
      // The pair that makes any of the rest of this tunable: freeze the clock,
      // then drag it to the moment you want to look at.
      { path: 'dayNight.paused', type: 'bool', label: 'freeze clock' },
      { path: 'dayNight.scrubHour', min: 0, max: 24, step: 0.05, label: 'scrub to hour (while frozen)' },
      { path: 'dayNight.skyCurve', min: 0.4, max: 4, step: 0.05, label: 'horizon band height' },
      { path: 'dayNight.stars.enabled', type: 'bool', label: 'stars' },
      { path: 'dayNight.stars.intensity', min: 0, max: 2, step: 0.05, label: 'star brightness' },
      { path: 'dayNight.stars.density', min: 0.1, max: 2, step: 0.05, label: 'star density' },
      { path: 'dayNight.stars.twinkle', min: 0, max: 1, step: 0.05, label: 'star twinkle' },
    ],
  },
  {
    // One row per keyframe, in clock order. `light` is the master brightness
    // the caustics and beams ride, NOT the sky's own — the colours carry that.
    group: 'Sky through the day',
    section: 'The ocean',
    items: [
      { path: 'dayNight.sky.0.horizon', type: 'color', label: '00:00 horizon' },
      { path: 'dayNight.sky.0.zenith', type: 'color', label: '00:00 zenith' },
      { path: 'dayNight.sky.0.light', min: 0, max: 1, step: 0.02, label: '00:00 light' },
      { path: 'dayNight.sky.1.horizon', type: 'color', label: '05:00 horizon' },
      { path: 'dayNight.sky.1.zenith', type: 'color', label: '05:00 zenith' },
      { path: 'dayNight.sky.1.light', min: 0, max: 1, step: 0.02, label: '05:00 light' },
      { path: 'dayNight.sky.2.horizon', type: 'color', label: '06:30 horizon' },
      { path: 'dayNight.sky.2.zenith', type: 'color', label: '06:30 zenith' },
      { path: 'dayNight.sky.2.light', min: 0, max: 1, step: 0.02, label: '06:30 light' },
      { path: 'dayNight.sky.3.horizon', type: 'color', label: '09:00 horizon' },
      { path: 'dayNight.sky.3.zenith', type: 'color', label: '09:00 zenith' },
      { path: 'dayNight.sky.3.light', min: 0, max: 1, step: 0.02, label: '09:00 light' },
      { path: 'dayNight.sky.4.horizon', type: 'color', label: '12:00 horizon' },
      { path: 'dayNight.sky.4.zenith', type: 'color', label: '12:00 zenith' },
      { path: 'dayNight.sky.4.light', min: 0, max: 1, step: 0.02, label: '12:00 light' },
      { path: 'dayNight.sky.5.horizon', type: 'color', label: '17:00 horizon' },
      { path: 'dayNight.sky.5.zenith', type: 'color', label: '17:00 zenith' },
      { path: 'dayNight.sky.5.light', min: 0, max: 1, step: 0.02, label: '17:00 light' },
      { path: 'dayNight.sky.6.horizon', type: 'color', label: '19:00 horizon' },
      { path: 'dayNight.sky.6.zenith', type: 'color', label: '19:00 zenith' },
      { path: 'dayNight.sky.6.light', min: 0, max: 1, step: 0.02, label: '19:00 light' },
      { path: 'dayNight.sky.7.horizon', type: 'color', label: '20:30 horizon' },
      { path: 'dayNight.sky.7.zenith', type: 'color', label: '20:30 zenith' },
      { path: 'dayNight.sky.7.light', min: 0, max: 1, step: 0.02, label: '20:30 light' },
      { path: 'dayNight.sky.8.horizon', type: 'color', label: '22:00 horizon' },
      { path: 'dayNight.sky.8.zenith', type: 'color', label: '22:00 zenith' },
      { path: 'dayNight.sky.8.light', min: 0, max: 1, step: 0.02, label: '22:00 light' },
    ],
  },
  {
    group: 'Sun & moon',
    section: 'The ocean',
    items: [
      { path: 'dayNight.orbit.radiusX', min: 0.1, max: 1.4, step: 0.02, label: 'arc width (x half arena)' },
      { path: 'dayNight.orbit.radiusY', min: 0.1, max: 1.6, step: 0.02, label: 'arc height (x air band)' },
      { path: 'dayNight.orbit.centerY', min: -10, max: 10, step: 0.25, label: 'horizon offset' },
      { path: 'dayNight.orbit.riseHour', min: 0, max: 12, step: 0.25, label: 'sunrise hour' },
      // 0 = welded to the screen, 1 = sits in the world like a rock. Fine steps
      // because everything interesting about it happens in the first tenth —
      // this is the difference between "far away" and "in space", and it is a
      // couple of hundredths wide. (The old `parallax` path is gone: it is
      // still in every saved snapshot at 0.15, which is why the field had to be
      // renamed to change — see the note on `drift` in the config above.)
      { path: 'dayNight.orbit.drift', min: 0, max: 1, step: 0.005, label: 'sky drift with camera' },
      { path: 'dayNight.orbit.depth', min: -5.9, max: -5.3, step: 0.05, label: 'sky layer z (sort only)' },
      // Turn `keep in frame` to 0 to see what the fit is actually doing: the
      // bodies go back to sitting wherever the orbit put them, cropped edges
      // and all.
      { path: 'dayNight.orbit.keepInFrame', min: 0, max: 1, step: 0.05, label: 'keep sun/moon in frame' },
      { path: 'dayNight.orbit.framePad', min: 0.5, max: 3, step: 0.05, label: 'frame clearance (x disc radius)' },
      { path: 'dayNight.sun.size', min: 0.5, max: 20, step: 0.1, label: 'sun size' },
      { path: 'dayNight.sun.color', type: 'color', label: 'sun colour' },
      { path: 'dayNight.sun.brightness', min: 0, max: 3, step: 0.05, label: 'sun brightness' },
      { path: 'dayNight.sun.halo', min: 1, max: 8, step: 0.1, label: 'sun halo size' },
      { path: 'dayNight.sun.haloStrength', min: 0, max: 2, step: 0.02, label: 'sun halo strength' },
      { path: 'dayNight.sun.bloomRim', min: 0, max: 4, step: 0.05, label: 'sun corona bloom (0 = off)' },
      { path: 'dayNight.sun.horizonGlow', min: 0, max: 5, step: 0.1, label: 'sun horizon flare' },
      { path: 'dayNight.sun.horizonRange', min: 0.2, max: 5, step: 0.1, label: 'sun flare reach' },
      { path: 'dayNight.sun.haloFade', min: 0, max: 12, step: 0.1, label: 'sun glow dissolve into the sea' },
      { path: 'dayNight.sun.maskToDisc', type: 'bool', label: 'crop sun art to a circle' },
      { path: 'dayNight.sun.edgeFeather', min: 0.01, max: 0.5, step: 0.01, label: 'sun edge feather' },
      { path: 'dayNight.moon.size', min: 0.5, max: 20, step: 0.1, label: 'moon size' },
      { path: 'dayNight.moon.color', type: 'color', label: 'moon colour' },
      { path: 'dayNight.moon.brightness', min: 0, max: 3, step: 0.05, label: 'moon brightness' },
      { path: 'dayNight.moon.halo', min: 1, max: 8, step: 0.1, label: 'moon halo size' },
      { path: 'dayNight.moon.haloStrength', min: 0, max: 2, step: 0.02, label: 'moon halo strength' },
      { path: 'dayNight.moon.bloomRim', min: 0, max: 4, step: 0.05, label: 'moon corona bloom (0 = off)' },
      { path: 'dayNight.moon.horizonGlow', min: 0, max: 5, step: 0.1, label: 'moon horizon flare' },
      { path: 'dayNight.moon.horizonRange', min: 0.2, max: 5, step: 0.1, label: 'moon flare reach' },
      { path: 'dayNight.moon.haloFade', min: 0, max: 12, step: 0.1, label: 'moon glow dissolve into the sea' },
      { path: 'dayNight.moon.maskToDisc', type: 'bool', label: 'crop moon art to a circle' },
      { path: 'dayNight.moon.edgeFeather', min: 0.01, max: 0.5, step: 0.01, label: 'moon edge feather' },
      // What the moon's disc and halo are actually worth to the bright pass.
      // The moon art is dark and the palette is blue, which is the pair of
      // facts that makes 'is it glowing' impossible to answer from the two
      // sliders above.
      { type: 'readout', label: 'moon bloom', lines: () => celestialBloomReadout('moon') },
    ],
  },
  {
    // Flying through them. The zone is inside the disc, so `zone size` under
    // about 0.4 is a hole you have to thread and above 0.9 is a body you can
    // clip — see CONFIG.dayNight.pass for what a pass pays out.
    group: 'Sun & moon — flying through',
    section: 'The ocean',
    items: [
      { path: 'dayNight.pass.enabled', type: 'bool', label: 'trigger zones' },
      { path: 'dayNight.pass.radius', min: 0.1, max: 1, step: 0.05, label: 'zone size (x disc radius)' },
      { path: 'dayNight.pass.cooldown', min: 0, max: 30, step: 0.5, label: 'cooldown (s)' },
      { path: 'dayNight.pass.hysteresis', min: 1, max: 3, step: 0.05, label: 're-arm distance (x zone)' },
      // The shine. Drag `halo gain` with the clock frozen at noon and fly the
      // seal through the sun to see it; everything here is on real time, so it
      // reads the same at any hit-stop.
      { path: 'dayNight.pass.flare.haloGain', min: 0, max: 5, step: 0.1, label: 'flare — corona gain' },
      { path: 'dayNight.pass.flare.discGain', min: 0, max: 2, step: 0.05, label: 'flare — body gain' },
      { path: 'dayNight.pass.flare.swell', min: 0, max: 1, step: 0.02, label: 'flare — halo swell' },
      { path: 'dayNight.pass.flare.decay', min: 0.1, max: 4, step: 0.05, label: 'flare — decay (s)' },
      { path: 'dayNight.pass.flare.flicker', min: 0, max: 1, step: 0.02, label: 'flare — flicker depth' },
      { path: 'dayNight.pass.flare.flickerRate', min: 1, max: 60, step: 1, label: 'flare — flicker rate' },
      // What each one pays out.
      { path: 'dayNight.pass.sun.blast.damage', min: 0, max: 200, step: 5, label: 'sun — blast damage' },
      { path: 'dayNight.pass.sun.blast.radius', min: 0, max: 40, step: 1, label: 'sun — blast radius' },
      { path: 'dayNight.pass.sun.charge', min: 0, max: 1, step: 0.05, label: 'sun — strike meter back' },
      { path: 'dayNight.pass.sun.flare', min: 0, max: 3, step: 0.05, label: 'sun — flare strength' },
      { path: 'dayNight.pass.moon.surge', min: 0, max: 30, step: 0.5, label: 'moon — element awake (s)' },
      { path: 'dayNight.pass.moon.gulp', min: 0, max: 60, step: 1, label: 'moon — chum pull radius' },
      { path: 'dayNight.pass.moon.flare', min: 0, max: 3, step: 0.05, label: 'moon — flare strength' },
    ],
  },
  {
    // The backdrop grid, in the air. Everything here needs the clock to be
    // somewhere dark to be visible at all — freeze it and scrub to ~23h under
    // Day & night before touching any of it.
    group: 'Night sky',
    section: 'The ocean',
    items: [
      { path: 'constellations.enabled', type: 'bool', label: 'constellations' },
      { type: 'readout', label: 'the field', lines: () => constellationReadout() },
      { path: 'constellations.brightest', min: 0, max: 1, step: 0.05, label: 'share of stars drawn' },
      // The two that decide when the sky wakes up, on the same 0..1 darkness
      // the nocturnal spawns use.
      { path: 'constellations.dusk', min: 0, max: 1, step: 0.01, label: 'darkness it starts appearing at' },
      { path: 'constellations.dark', min: 0, max: 1, step: 0.01, label: 'darkness it reaches full at' },
      // --- the stars ---
      { path: 'constellations.size', min: 0.05, max: 1.5, step: 0.01, label: 'star size' },
      { path: 'constellations.color', type: 'color', label: 'star colour' },
      { path: 'constellations.hotColor', type: 'color', label: 'bloom colour' },
      { path: 'constellations.opacity', min: 0, max: 1, step: 0.05, label: 'star brightness' },
      { path: 'constellations.spike', min: 0, max: 2, step: 0.05, label: 'star flare' },
      { path: 'constellations.spikeWidth', min: 1, max: 14, step: 0.5, label: 'star flare thinness' },
      { path: 'constellations.haloAmount', min: 0, max: 1.5, step: 0.05, label: 'star halo' },
      { path: 'constellations.haze', min: 0.2, max: 12, step: 0.2, label: 'horizon fade (units)' },
      // --- the connections ---
      { path: 'constellations.links', min: 0, max: 5, step: 1, label: 'links per star (at rest)' },
      { path: 'constellations.linkRadius', min: 1, max: 30, step: 0.5, label: 'link reach (at rest)' },
      { path: 'constellations.linkColor', type: 'color', label: 'link colour' },
      { path: 'constellations.linkOpacity', min: 0, max: 1, step: 0.05, label: 'link brightness' },
      { path: 'constellations.subdivisions', min: 1, max: 12, step: 1, label: 'link segments (curviness)' },
      // --- the food chain ---
      // What a combo buys, printed as it is dragged: the two rows below change
      // how much geometry is BUILT, so the readout is the only way to see that
      // a maxLevel of 12 is costing four hundred links that are dark all run.
      { type: 'readout', label: 'what a chain buys', lines: () => chainReachReadout() },
      { path: 'constellations.chain.enabled', type: 'bool', label: 'food chain widens the sky' },
      { path: 'constellations.chain.reach', min: 0, max: 1, step: 0.02, label: 'extra reach per chain link (x)' },
      { path: 'constellations.chain.links', min: 0, max: 2, step: 0.1, label: 'extra links per star per chain link' },
      { path: 'constellations.chain.maxLevel', min: 1, max: 16, step: 1, label: 'chain depth it stops growing at' },
      { path: 'constellations.chain.glow', min: 0, max: 2, step: 0.05, label: 'extra link glow at full chain' },
      { path: 'constellations.chain.fade', min: 0.1, max: 10, step: 0.1, label: 'new links fade in over (units)' },
      { path: 'constellations.chain.attack', min: 0.5, max: 20, step: 0.5, label: 'how fast the sky opens' },
      { path: 'constellations.chain.release', min: 0.2, max: 10, step: 0.1, label: '...and closes again' },
      // --- the fractal ---
      { path: 'constellations.fractal.enabled', type: 'bool', label: 'fractal branches' },
      { path: 'constellations.fractal.anchors', min: 0, max: 1, step: 0.05, label: 'share of stars that grow one' },
      // Cost is branches^depth per anchor, so these two multiply fast — the
      // readout above counts stars, not tips.
      { path: 'constellations.fractal.depth', min: 1, max: 6, step: 1, label: 'fractal depth' },
      { path: 'constellations.fractal.branches', min: 1, max: 4, step: 1, label: 'branches per split' },
      { path: 'constellations.fractal.length', min: 0.5, max: 12, step: 0.1, label: 'first limb length' },
      { path: 'constellations.fractal.shrink', min: 0.2, max: 0.95, step: 0.01, label: 'shrink per generation' },
      { path: 'constellations.fractal.spread', min: 0, max: 3.2, step: 0.05, label: 'fan width (rad)' },
      { path: 'constellations.fractal.wobble', min: 0, max: 2, step: 0.05, label: 'branch scatter (rad)' },
      { path: 'constellations.fractal.tipScale', min: 0.1, max: 1, step: 0.05, label: 'tip star size (x parent)' },
      { path: 'constellations.fractalColor', type: 'color', label: 'branch colour' },
      // --- the bloom ---
      { path: 'constellations.bloomSync', type: 'choice', options: BEAT_DIVISIONS, label: 'bloom — one per' },
      { path: 'constellations.bloomRate', min: 0.05, max: 4, step: 0.05, label: '…or free-running, cycles/s' },
      { type: 'readout', label: 'timing', lines: () => fxTimingReadout([
        ['bloom', 'constellations.bloomSync', () => 1 / Math.max(0.01, CONFIG.constellations?.bloomRate ?? 0.5)],
      ]) },
      // 0 puts the whole sky on one flash, which is a look and is almost never
      // the one you want; 4 lights it on the four beats of the bar.
      { path: 'constellations.phaseSteps', min: 0, max: 16, step: 1, label: 'beat slots across the field' },
      { path: 'constellations.phaseSpread', min: 0, max: 1, step: 0.05, label: 'how much of the cycle they spread over' },
      { path: 'constellations.bloomDecay', min: 0.5, max: 20, step: 0.5, label: 'bloom sharpness' },
      { path: 'constellations.base', min: 0, max: 1, step: 0.05, label: 'brightness between blooms' },
      { path: 'constellations.gain', min: 0, max: 3, step: 0.05, label: 'bloom brightness' },
      { path: 'constellations.swell', min: 0, max: 3, step: 0.05, label: 'bloom growth' },
      { path: 'constellations.genDelay', min: 0, max: 0.5, step: 0.005, label: 'fractal step (cycles)' },
      { path: 'constellations.travel', min: 0, max: 0.5, step: 0.005, label: 'light travel per link (cycles)' },
      // --- what the game does to it ---
      { path: 'constellations.rippleGain', min: 0, max: 2, step: 0.05, label: 'how hard events ring the sky' },
      { path: 'constellations.rippleReach', min: 0.2, max: 6, step: 0.1, label: 'event reach (x)' },
      { path: 'constellations.rippleSquash', min: 0.02, max: 1, step: 0.02, label: 'vertical reach (lower = further)' },
      { path: 'constellations.rippleDecay', min: 0.3, max: 8, step: 0.1, label: 'sky snap-back' },
      // The stars are fixed; this is how far the LINES between them bow. 0
      // makes the constellations rigid and leaves only the brightness.
      { path: 'constellations.bend', min: 0, max: 4, step: 0.05, label: 'how far links bow (stars never move)' },
      { path: 'constellations.bendMax', min: 0, max: 1, step: 0.02, label: 'max bow (x the link’s own length)' },
      { path: 'constellations.warpGain', min: 0, max: 5, step: 0.1, label: 'warped link brightness' },
      { path: 'constellations.touch.enabled', type: 'bool', label: 'fingers bend the sky (touch)' },
      { path: 'constellations.touch.radius', min: 1, max: 25, step: 0.5, label: 'finger reach' },
      { path: 'constellations.touch.push', min: 0, max: 3, step: 0.05, label: 'finger shove' },
      { path: 'constellations.touch.swirl', min: 0, max: 3, step: 0.05, label: 'finger swirl' },
    ],
  },
  {
    group: 'Weather',
    section: 'The ocean',
    items: [
      { path: 'weather.enabled', type: 'bool', label: 'weather' },
      // -1 runs the schedule; anything else pins the storm there. The only
      // practical way to tune rain that shows up twice in ten minutes.
      { path: 'weather.forceIntensity', min: -1, max: 1, step: 0.05, label: 'pin storm strength (-1 = auto)' },
      { path: 'weather.firstDelay.0', min: 0, max: 300, step: 5, label: 'first storm, earliest (s)' },
      { path: 'weather.firstDelay.1', min: 0, max: 600, step: 5, label: 'first storm, latest (s)' },
      { path: 'weather.gap.0', min: 10, max: 600, step: 5, label: 'clear spell, shortest (s)' },
      { path: 'weather.gap.1', min: 10, max: 900, step: 5, label: 'clear spell, longest (s)' },
      { path: 'weather.duration.0', min: 5, max: 300, step: 5, label: 'storm, shortest (s)' },
      { path: 'weather.duration.1', min: 5, max: 400, step: 5, label: 'storm, longest (s)' },
      { path: 'weather.peak.0', min: 0, max: 1, step: 0.05, label: 'storm strength, weakest' },
      { path: 'weather.peak.1', min: 0, max: 1, step: 0.05, label: 'storm strength, strongest' },
      { path: 'weather.rampIn', min: 0.5, max: 60, step: 0.5, label: 'ramp in (s)' },
      { path: 'weather.rampOut', min: 0.5, max: 60, step: 0.5, label: 'ramp out (s)' },
      { path: 'weather.dim', min: 0, max: 1, step: 0.02, label: 'storm dims the light by' },
      { path: 'weather.wind.base', min: -1, max: 1, step: 0.05, label: 'prevailing wind' },
      { path: 'weather.wind.gust', min: 0, max: 1.5, step: 0.05, label: 'gust strength' },
      { path: 'weather.wind.speed.0', min: 0.01, max: 1, step: 0.01, label: 'gust beat 1 (hz)' },
      { path: 'weather.wind.speed.1', min: 0.01, max: 1, step: 0.01, label: 'gust beat 2 (hz)' },
      { path: 'weather.wind.calmGust', min: 0, max: 1, step: 0.05, label: 'wind on a clear day' },
      // Sea state. `arena.waveAmplitude` (Arena group) is the calm baseline
      // these multiply; pin weather.forceIntensity to watch them build.
      { path: 'weather.sea.enabled', type: 'bool', label: 'storms raise the sea' },
      { path: 'weather.sea.amp', min: 1, max: 8, step: 0.1, label: 'wave height at full storm (x)' },
      { path: 'weather.sea.chop', min: 0, max: 1, step: 0.05, label: 'storm chop (short, fast term)' },
      { path: 'weather.sea.speed', min: 1, max: 4, step: 0.05, label: 'wave speed at full storm (x)' },
      { path: 'weather.sea.buildTime', min: 1, max: 180, step: 1, label: 'seconds for the sea to get up' },
      { path: 'weather.sea.settleTime', min: 1, max: 400, step: 5, label: 'seconds for it to settle' },
    ],
  },
  {
    group: 'Rain',
    section: 'The ocean',
    items: [
      { path: 'weather.rain.enabled', type: 'bool', label: 'rain' },
      { path: 'weather.rain.perSecond', min: 0, max: 3000, step: 25, label: 'drops/sec at full storm' },
      { path: 'weather.rain.speed.0', min: 5, max: 100, step: 1, label: 'fall speed, min' },
      { path: 'weather.rain.speed.1', min: 5, max: 120, step: 1, label: 'fall speed, max' },
      { path: 'weather.rain.length.0', min: 0.1, max: 6, step: 0.1, label: 'streak length, min' },
      { path: 'weather.rain.length.1', min: 0.1, max: 8, step: 0.1, label: 'streak length, max' },
      { path: 'weather.rain.drift', min: 0, max: 80, step: 1, label: 'wind push' },
      { path: 'weather.rain.turbulence', min: 0, max: 30, step: 0.5, label: 'turbulence' },
      { path: 'weather.rain.color', type: 'color', label: 'rain colour' },
      { path: 'weather.rain.opacity', min: 0, max: 1, step: 0.02, label: 'rain opacity' },
      { path: 'weather.rain.splash', type: 'bool', label: 'surface splashes' },
      { path: 'weather.rain.splashChance', min: 0, max: 1, step: 0.02, label: 'drops that splash' },
    ],
  },
  {
    group: 'Thunderstorms',
    items: [
      { path: 'weather.lightning.enabled', type: 'bool', label: 'lightning' },
      { path: 'weather.lightning.chance', min: 0, max: 1, step: 0.05, label: 'storms that are electrical' },
      // Pinning weather.forceIntensity also forces thunder on, so this group
      // can be tuned without waiting out the dice — see systems/lightning.js.
      { path: 'weather.lightning.minIntensity', min: 0, max: 1, step: 0.05, label: 'storm strength needed' },
      { path: 'weather.lightning.interval.0', min: 0.5, max: 60, step: 0.5, label: 'gap between flashes, min (s)' },
      { path: 'weather.lightning.interval.1', min: 0.5, max: 120, step: 0.5, label: 'gap between flashes, max (s)' },
      { path: 'weather.lightning.strikeChance', min: 0, max: 1, step: 0.05, label: 'flashes that are real bolts' },
      { path: 'weather.lightning.killRadius', min: 0, max: 30, step: 0.5, label: 'kill radius (world units)' },
      { path: 'weather.lightning.playerDamage', min: 0, max: 100, step: 1, label: 'damage to the seal (0 = immune)' },
      { path: 'weather.lightning.flash.strike', min: 0, max: 1, step: 0.02, label: 'sky flash, bolt' },
      { path: 'weather.lightning.flash.flicker', min: 0, max: 1, step: 0.02, label: 'sky flash, sheet' },
      { path: 'weather.lightning.flash.color', type: 'color', label: 'flash colour' },
      { path: 'weather.lightning.flash.decay', min: 0.5, max: 20, step: 0.25, label: 'flash decay' },
      { path: 'weather.lightning.flash.flickerHz', min: 1, max: 60, step: 1, label: 'flash strobe rate' },
      { path: 'weather.lightning.flash.lightBoost', min: 0, max: 6, step: 0.1, label: 'flash lifts caustics/beams' },
      { path: 'weather.lightning.bolt.color', type: 'color', label: 'bolt colour' },
      { path: 'weather.lightning.bolt.gain', min: 0.2, max: 5, step: 0.1, label: 'bolt brightness' },
      { path: 'weather.lightning.bolt.segments', min: 3, max: 48, step: 1, label: 'bolt segments' },
      { path: 'weather.lightning.bolt.jitter', min: 0, max: 12, step: 0.1, label: 'bolt wander' },
      { path: 'weather.lightning.bolt.leanX', min: 0, max: 30, step: 0.5, label: 'bolt lean off vertical' },
      { path: 'weather.lightning.bolt.branches.0', min: 0, max: 8, step: 1, label: 'branches, min' },
      { path: 'weather.lightning.bolt.branches.1', min: 0, max: 10, step: 1, label: 'branches, max' },
      { path: 'weather.lightning.bolt.branchLength', min: 0, max: 1, step: 0.02, label: 'branch length' },
      { path: 'weather.lightning.bolt.branchAlpha', min: 0, max: 1, step: 0.05, label: 'branch brightness' },
      { path: 'weather.lightning.bolt.life.0', min: 0.05, max: 2, step: 0.01, label: 'bolt life, min (s)' },
      { path: 'weather.lightning.bolt.life.1', min: 0.05, max: 3, step: 0.01, label: 'bolt life, max (s)' },
      { path: 'weather.lightning.bolt.maxBolts', min: 1, max: 8, step: 1, label: 'max bolts at once' },
    ],
  },
  {
    group: 'Clouds (overlay stub)',
    section: 'The ocean',
    items: [
      { path: 'weather.clouds.enabled', type: 'bool', label: 'cloud overlay' },
      { path: 'weather.clouds.color', type: 'color', label: 'cloud colour' },
      { path: 'weather.clouds.opacity', min: 0, max: 1, step: 0.02, label: 'opacity at full storm' },
      { path: 'weather.clouds.base', min: 0, max: 1, step: 0.02, label: 'haze on a clear day' },
      { path: 'weather.clouds.coverage', min: 0, max: 1, step: 0.02, label: 'coverage' },
      { path: 'weather.clouds.softness', min: 0.02, max: 1, step: 0.02, label: 'edge softness' },
      { path: 'weather.clouds.scale', min: 0.005, max: 0.3, step: 0.005, label: 'noise scale' },
      { path: 'weather.clouds.drift', min: 0, max: 30, step: 0.2, label: 'scroll with wind' },
    ],
  },
  {
    group: 'Horizon fog',
    items: [
      { path: 'horizonGlow.enabled', type: 'bool', label: 'water line fog' },
      { path: 'horizonGlow.color', type: 'color', label: 'fog colour' },
      // opacity = how much it hides, light = how much it emits. Equal is
      // pure fog; light above opacity is fog that also glows.
      { path: 'horizonGlow.opacity', min: 0, max: 1, step: 0.02, label: 'fog thickness (hides)' },
      { path: 'horizonGlow.light', min: 0, max: 2, step: 0.02, label: 'fog glow (emits)' },
      { path: 'horizonGlow.up', min: 0, max: 20, step: 0.1, label: 'reach into the air' },
      { path: 'horizonGlow.down', min: 0, max: 20, step: 0.1, label: 'reach into the water' },
      { path: 'horizonGlow.falloff', min: 0.2, max: 10, step: 0.1, label: 'edge softness (lower = softer)' },
      { path: 'horizonGlow.noise', min: 0, max: 1, step: 0.05, label: 'break up the silhouette' },
      { path: 'horizonGlow.noiseScale', min: 0.005, max: 0.3, step: 0.005, label: 'wisp size' },
      { path: 'horizonGlow.noiseStretch', min: 0.5, max: 20, step: 0.5, label: 'wisp stretch' },
      { path: 'horizonGlow.drift', min: 0, max: 0.5, step: 0.005, label: 'drift speed' },
      { path: 'horizonGlow.windDrift', min: 0, max: 1, step: 0.01, label: 'wind pushes the fog' },
      { path: 'horizonGlow.dither', min: 0, max: 0.06, step: 0.002, label: 'fog dither (kills banding)' },
      { path: 'horizonGlow.skyDither', min: 0, max: 0.03, step: 0.001, label: 'sky dither (kills banding)' },
      { path: 'horizonGlow.skyTint', min: 0, max: 1, step: 0.05, label: 'takes sky colour (day)' },
      // The twilight softening. Scrub dayNight.scrubHour to 06:00 or 18:00
      // with the clock frozen to tune these against the moment they exist for.
      { path: 'dayNight.twilightBand', min: 0.05, max: 1, step: 0.01, label: 'how long twilight lasts' },
      { path: 'horizonGlow.twilightSpread', min: 0, max: 8, step: 0.1, label: 'twilight: extra reach' },
      { path: 'horizonGlow.twilightBoost', min: 0, max: 4, step: 0.05, label: 'twilight: extra thickness' },
      { path: 'horizonGlow.twilightTint', min: 0, max: 1, step: 0.05, label: 'twilight: takes sky colour' },
      { path: 'horizonGlow.lineGain', min: 0.2, max: 4, step: 0.05, label: 'water line brightness' },
      { path: 'horizonGlow.lineOpacity', min: 0, max: 1, step: 0.05, label: 'water line presence (0 = none)' },
      { path: 'horizonGlow.lineTwilightFade', min: 0, max: 1, step: 0.05, label: 'twilight: dissolve the line' },
    ],
  },
  {
    group: 'Caustics & light beams',
    section: 'The ocean',
    items: [
      { path: 'caustics.enabled', type: 'bool', label: 'caustics' },
      { path: 'caustics.intensity', min: 0, max: 1.5, step: 0.02 },
      { path: 'caustics.scale', min: 0.02, max: 0.6, step: 0.01 },
      { path: 'caustics.speed', min: 0, max: 2, step: 0.02 },
      { path: 'caustics.falloff', min: 0.2, max: 4, step: 0.1, label: 'caustics depth falloff' },
      { path: 'caustics.color', type: 'color' },
      { path: 'caustics.followSun', type: 'bool', label: 'caustics follow the sun' },
      { path: 'caustics.nightFloor', min: 0, max: 1, step: 0.02, label: 'caustics left at night' },
      { path: 'caustics.tintMix', min: 0, max: 1, step: 0.05, label: 'caustics take sun colour' },
      { path: 'godrays.enabled', type: 'bool', label: 'light beams' },
      { path: 'godrays.count', min: 0, max: 8, step: 1 },
      { path: 'godrays.spread', min: 4, max: 60, step: 1 },
      { path: 'godrays.beamWidth', min: 0.3, max: 8, step: 0.1 },
      { path: 'godrays.angle', min: -3, max: 3, step: 0.05 },
      { path: 'godrays.sway', min: 0, max: 1, step: 0.02 },
      { path: 'godrays.intensity', min: 0, max: 1, step: 0.02 },
      { path: 'godrays.falloff', min: 0.2, max: 4, step: 0.1, label: 'beam depth falloff' },
      { path: 'godrays.color', type: 'color' },
      { path: 'godrays.followSun', type: 'bool', label: 'beams follow the sun' },
      { path: 'godrays.nightFloor', min: 0, max: 1, step: 0.02, label: 'beams left at night' },
      { path: 'godrays.tintMix', min: 0, max: 1, step: 0.05, label: 'beams take sun colour' },
      { path: 'godrays.followTilt', min: 0, max: 5, step: 0.1, label: 'beam lean at sunrise/set' },
      { path: 'godrays.followShift', min: 0, max: 1.5, step: 0.05, label: 'beams slide under the sun' },
    ],
  },
  {
    group: 'Lighting',
    section: 'The ocean',
    items: [
      { path: 'lighting.ambient', min: 0, max: 2, step: 0.05, label: 'ambient' },
      { path: 'lighting.keyIntensity', min: 0, max: 3, step: 0.05, label: 'key light' },
      { path: 'lighting.hemiIntensity', min: 0, max: 2, step: 0.05, label: 'sky/sea fill' },
      { path: 'lighting.keyPosition.0', min: -30, max: 30, step: 0.5, label: 'key light x' },
      { path: 'lighting.keyPosition.1', min: -30, max: 30, step: 0.5, label: 'key light y' },
      { path: 'lighting.keyPosition.2', min: 0, max: 40, step: 0.5, label: 'key light z (height)' },
    ],
  },
  {
    group: 'Weapons',
    panel: 'companions',
    section: 'Your weapon',
    items: [
      { path: 'missile.launchFlashScale', min: 0, max: 4, step: 0.1, label: 'missile launch flash size' },
      { path: 'emitters.missileLaunch.count', min: 1, max: 80, step: 1, label: 'launch flash particles' },
      { path: 'emitters.missileLaunch.glow', min: 0, max: 10, step: 0.1, label: 'launch flash glow' },
      { path: 'trails.missile.particles.perSecond', min: 0, max: 120, step: 1, label: 'mussel trail rate' },
      { path: 'emitters.missileTrail.count', min: 1, max: 12, step: 1, label: 'mussel trail per emission' },
      { path: 'emitters.missileTrail.glow', min: 0, max: 10, step: 0.1, label: 'mussel trail glow' },
      // Both are multiples of the shell's own measured size, not world units —
      // 1.0 means "exactly at the shell's edge" whatever size it renders at.
      { path: 'trails.missile.tailOffset', min: 0, max: 2.5, step: 0.05, label: 'mussel trail tail offset (x shell length)' },
      { path: 'trails.missile.depthClearance', min: 0, max: 4, step: 0.05, label: 'mussel trail depth (x shell depth)' },
      // --- mussel impact ---
      { path: 'missile.impact.flash', type: 'bool', label: 'mussel impact flash' },
      { path: 'missile.impact.radiusScale', min: 0.5, max: 10, step: 0.1, label: 'impact flash size (x target radius)' },
      { path: 'missile.impact.minRadius', min: 0.2, max: 8, step: 0.1, label: 'impact flash minimum size' },
      { path: 'missile.impact.life', min: 0.04, max: 0.6, step: 0.01, label: 'impact flash length' },
      { path: 'missile.impact.glow', min: 0, max: 8, step: 0.1, label: 'impact flash glow' },
      { path: 'missile.impact.replacesBulletHit', type: 'bool', label: 'impact replaces generic hit fx' },
      { path: 'emitters.missileImpact.count', min: 0, max: 120, step: 2, label: 'impact bits' },
      { path: 'emitters.missileImpact.glow', min: 0, max: 10, step: 0.1, label: 'impact bits glow' },
      { path: 'feedback.missileImpact.shake', min: 0, max: 1.5, step: 0.02, label: 'impact shake' },
      { path: 'feedback.missileImpact.hitstop', min: 0, max: 0.2, step: 0.005, label: 'impact hit-stop' },
      { path: 'feedback.missileImpact.sfxMinGap', min: 0, max: 0.4, step: 0.01, label: 'min gap between impact sounds' },
      // --- mussel flight voice ---
      // The continuous sound while a shell is in the air. Everything here is
      // read per frame, so a slider moves a mussel that's already flying.
      { path: 'flightSfx.enabled', type: 'bool', label: 'in-flight sound' },
      { path: 'flightSfx.gain', min: 0, max: 2, step: 0.05, label: 'in-flight volume' },
      { path: 'flightSfx.maxVoices', min: 1, max: 12, step: 1, label: 'max shells heard at once' },
      { path: 'flightSfx.missile.gain', min: 0, max: 0.5, step: 0.005, label: 'mussel voice level' },
      { path: 'flightSfx.missile.toneHz.0', min: 40, max: 400, step: 5, label: 'mussel pitch (slow)' },
      { path: 'flightSfx.missile.toneHz.1', min: 60, max: 900, step: 5, label: 'mussel pitch (fast)' },
      { path: 'flightSfx.missile.toneFilterHz.1', min: 300, max: 8000, step: 50, label: 'mussel brightness (fast)' },
      { path: 'flightSfx.missile.noiseGain', min: 0, max: 1.5, step: 0.02, label: 'mussel hiss' },
      { path: 'flightSfx.missile.subGain', min: 0, max: 1.5, step: 0.02, label: 'mussel weight' },
      { path: 'flightSfx.missile.doppler', min: 0, max: 0.6, step: 0.01, label: 'mussel doppler' },
      { path: 'flightSfx.missile.warbleCents.1', min: 0, max: 400, step: 5, label: 'seeker wobble depth' },
      { path: 'flightSfx.missile.warbleHz.1', min: 1, max: 40, step: 0.5, label: 'seeker wobble rate' },
      { path: 'flightSfx.missile.turnRef', min: 0.5, max: 12, step: 0.1, label: 'turn rate for full wobble' },
      { path: 'flightSfx.missile.lifeRise', min: 0, max: 1.5, step: 0.02, label: 'pitch climb over flight' },
      { path: 'flightSfx.missile.falloff', min: 2, max: 60, step: 1, label: 'mussel distance falloff' },
      { path: 'flightSfx.missile.panAmount', min: 0, max: 1, step: 0.05, label: 'mussel stereo width' },
      { path: 'bounce.comboPitchStep', min: 0, max: 3, step: 0.05, label: 'bounce combo pitch step (semitones)' },
      { path: 'bounce.comboPitchMax', min: 0, max: 36, step: 1, label: 'bounce combo pitch cap (semitones)' },
      { path: 'bounce.comboScaleStep', min: 0, max: 0.6, step: 0.01, label: 'bounce combo fx growth' },
      { path: 'bounce.comboScaleMax', min: 1, max: 5, step: 0.1, label: 'bounce combo fx cap' },
    ],
  },
  // Glow Up!. Split into the shared curve and one group per element, because
  // only ONE element is live in any run — a single flat list would be four
  // fifths sliders that do nothing to the seal currently on screen.
  {
    group: 'Glow Up! (shared)',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'biolum.damageFraction', min: 0, max: 1, step: 0.02, label: 'element damage (of hit)' },
      { path: 'biolum.damageFractionPerLevel', min: 0, max: 0.5, step: 0.01, label: '...per level' },
      { path: 'biolum.statusPerLevel', min: 0, max: 1, step: 0.02, label: 'status growth per level' },
      { path: 'biolum.strikeFraction', min: 0, max: 1, step: 0.05, label: 'share the strike carries' },
      { path: 'biolum.night.damageMul', min: 1, max: 3, step: 0.05, label: 'night damage' },
      { path: 'biolum.night.durationMul', min: 1, max: 4, step: 0.05, label: 'night duration' },
      { path: 'biolum.night.twilightBoost', min: 0, max: 1, step: 0.05, label: 'dusk counts for' },
      // 0 = the ability is asleep at noon, glow and elemental effects alike.
      { path: 'biolum.night.dayPower', min: 0, max: 1, step: 0.05, label: 'power kept in daylight' },
      { path: 'biolum.night.blendGamma', min: 0.25, max: 4, step: 0.05, label: 'day → night fade curve' },
      { type: 'readout', label: 'day/night', lines: () => elementPowerReadout() },
      { path: 'biolum.skin.strength', min: 0, max: 5, step: 0.1, label: 'seal glow' },
      { path: 'biolum.skin.strengthPerLevel', min: 0, max: 1, step: 0.05, label: '...per level' },
      { path: 'biolum.skin.nightStrengthMul', min: 1, max: 4, step: 0.1, label: '...at night' },
      // Which parts of the seal's OWN mottling light up. Coverage slides the
      // brightness threshold, contrast decides whether the lit patch has a
      // hard rim or fades out — see setNoiseGlow in systems/noiseShader.js.
      { path: 'biolum.skin.coverage', min: 0, max: 1, step: 0.02, label: 'seal glow coverage' },
      { path: 'biolum.skin.contrast', min: 0.1, max: 6, step: 0.1, label: 'seal glow edge' },
      // 1 = the seal's markings at their own size. Up = the same shapes, in
      // bigger patches; the skin's size slider is tuned for fine texture, and
      // a glow that fine is speckle rather than light.
      { path: 'biolum.skin.patchScale', min: 0.5, max: 12, step: 0.1, label: 'glow patch size (× skin)' },
      { path: 'biolum.skin.white', min: 0, max: 1, step: 0.05, label: 'white-hot core' },
      { path: 'biolum.skin.tipColor', type: 'color', label: 'core colour' },
      { path: 'biolum.skin.pulseAmp', min: 0, max: 1, step: 0.05, label: 'seal glow breath' },
      { path: 'biolum.skin.pulseSync', type: 'choice', options: BEAT_DIVISIONS, label: 'breath — one per' },
      { path: 'biolum.skin.pulseSpeed', min: 0.1, max: 8, step: 0.1, label: '...rate when free (rad/s)' },
    ],
  },
  {
    group: 'Glow Up! — Voltaic',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'biolum.elements.shock.color', type: 'color' },
      { path: 'biolum.elements.shock.chance', min: 0, max: 1, step: 0.05, label: 'arc chance' },
      { path: 'biolum.elements.shock.chancePerLevel', min: 0, max: 0.3, step: 0.01 },
      { path: 'biolum.elements.shock.arcRange', min: 1, max: 20, step: 0.5 },
      { path: 'biolum.elements.shock.arcDamage', min: 0, max: 2, step: 0.05 },
      { path: 'biolum.elements.shock.arcsPerLevel', min: 0, max: 2, step: 0.02 },
    ],
  },
  {
    group: 'Glow Up! — Venom',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'biolum.elements.venom.color', type: 'color' },
      { path: 'biolum.elements.venom.dps', min: 0, max: 30, step: 0.5 },
      { path: 'biolum.elements.venom.dpsPerLevel', min: 0, max: 15, step: 0.2 },
      { path: 'biolum.elements.venom.duration', min: 0.5, max: 12, step: 0.25 },
      { path: 'biolum.elements.venom.maxStacks', min: 1, max: 12, step: 1 },
      { path: 'biolum.elements.venom.tick', min: 0.05, max: 1, step: 0.05 },
    ],
  },
  {
    group: 'Glow Up! — Chill',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'biolum.elements.chill.color', type: 'color' },
      { path: 'biolum.elements.chill.slowPerHit', min: 0, max: 0.6, step: 0.01 },
      { path: 'biolum.elements.chill.slowPerHitPerLevel', min: 0, max: 0.2, step: 0.005 },
      { path: 'biolum.elements.chill.maxSlow', min: 0.1, max: 0.95, step: 0.05 },
      { path: 'biolum.elements.chill.duration', min: 0.5, max: 10, step: 0.25 },
      { path: 'biolum.elements.chill.freezeDuration', min: 0, max: 4, step: 0.1 },
    ],
  },
  {
    group: 'Glow Up! — Infected',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'biolum.elements.infection.color', type: 'color' },
      { path: 'biolum.elements.infection.dps', min: 0, max: 30, step: 0.5 },
      { path: 'biolum.elements.infection.dpsPerLevel', min: 0, max: 15, step: 0.2 },
      { path: 'biolum.elements.infection.duration', min: 0.5, max: 15, step: 0.25 },
      { path: 'biolum.elements.infection.spreadInterval', min: 0.1, max: 5, step: 0.1 },
      { path: 'biolum.elements.infection.spreadRange', min: 0.5, max: 15, step: 0.25 },
      { path: 'biolum.elements.infection.generations', min: 1, max: 10, step: 1, label: 'hops from the shot fish' },
      { path: 'biolum.elements.infection.maxHosts', min: 1, max: 60, step: 1 },
      { path: 'biolum.elements.infection.hopFalloff', min: 0.2, max: 1, step: 0.02 },
      { path: 'biolum.elements.infection.burstRange', min: 0.5, max: 20, step: 0.5 },
      { path: 'biolum.elements.infection.burstDamage', min: 0, max: 60, step: 1 },
      { path: 'biolum.elements.infection.burstTargets', min: 0, max: 12, step: 1 },
      { path: 'biolum.elements.infection.motes.perHost', min: 0, max: 16, step: 1 },
      { path: 'biolum.elements.infection.motes.size', min: 0.01, max: 0.5, step: 0.01 },
      { path: 'biolum.elements.infection.motes.pulseSpeed', min: 0, max: 15, step: 0.5 },
      { path: 'biolum.elements.infection.motes.pulseAmp', min: 0, max: 1.5, step: 0.05 },
      { path: 'biolum.elements.infection.motes.travelSpeed', min: 1, max: 30, step: 0.5 },
      { path: 'biolum.elements.infection.motes.maxAlive', min: 10, max: 300, step: 10 },
    ],
  },
  {
    group: 'Sea garlic',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'garlic.baseRadius', min: 0.5, max: 12, step: 0.1 },
      { path: 'garlic.damagePerTick', min: 0, max: 10, step: 0.1 },
      { path: 'garlic.tickInterval', min: 0.05, max: 1, step: 0.05 },
      { path: 'garlic.opacity', min: 0, max: 1, step: 0.02 },
      { path: 'garlic.color', type: 'color' },
      { path: 'garlic.swirl', min: 0, max: 3, step: 0.05 },
      { path: 'garlic.density', min: 0.2, max: 4, step: 0.05 },
    ],
  },
  {
    group: 'Shrimp ring',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      // baseCount / contactDamage / contactCooldown are weapons.csv's.
      { path: 'shrimpRing.radius', min: 0.5, max: 8, step: 0.1 },
      { path: 'shrimpRing.orbitSpeed', min: -6, max: 6, step: 0.1 },
      { path: 'shrimpRing.scale', min: 0.1, max: 2, step: 0.05 },
    ],
  },
  {
    group: 'Club',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'club.enabled', type: 'bool', label: 'club system' },
      { path: 'club.stiffness', min: 2, max: 200, step: 1, label: 'flail: how hard it chases the fin' },
      { path: 'club.damping', min: 0.5, max: 30, step: 0.1, label: 'flail: how fast the wobble dies' },
      { path: 'club.maxSwing', min: 4, max: 80, step: 1, label: 'flail: swing speed ceiling' },
      { path: 'club.velocityFollow', min: 0, max: 1, step: 0.05, label: 'flop: how much the water wins' },
      { path: 'club.dragFullSpeed', min: 1, max: 40, step: 0.5, label: 'flop: speed at which it wins fully' },
      { path: 'club.droop', min: 0, max: 1, step: 0.02, label: 'flail: sag when idle' },
      { path: 'club.droopCutoff', min: 0.2, max: 12, step: 0.2, label: 'flail: swing that cancels the sag' },
      { path: 'club.assistSpin', min: 0, max: 12, step: 0.1, label: 'flail: assist spin (0 once fins spin)' },
      { path: 'club.respawnTime', min: 0, max: 10, step: 0.1, label: 'socket: refill after a throw' },
      { path: 'club.minSwing', min: 0, max: 8, step: 0.1, label: 'swing: below this it does no damage' },
      { path: 'club.powerReference', min: 1, max: 30, step: 0.5, label: 'swing: speed that counts as full power' },
      { path: 'club.powerMax', min: 1, max: 4, step: 0.1, label: 'swing: power ceiling' },
      { path: 'club.shaftHits', type: 'bool', label: 'reach: the shaft connects too' },
      { path: 'club.scale', min: 0.1, max: 3, step: 0.05, label: 'look: size' },
      { path: 'club.gripOffset', min: -2, max: 2, step: 0.05, label: 'look: slide along the shaft' },
      { path: 'club.depth', min: -1, max: 1, step: 0.05, label: 'look: depth nudge' },
      { path: 'club.outwardShare', min: 0, max: 1, step: 0.05, label: 'throw: outward lean' },
      { path: 'club.selfDamageShare', min: 0, max: 2, step: 0.05, label: 'carom: share taken back' },
      { path: 'club.bounceSpeedKeep', min: 0.2, max: 1, step: 0.02, label: 'carom: speed kept' },
      { path: 'club.flightTime', min: 0.2, max: 5, step: 0.1, label: 'carom: max flight time' },
      { path: 'club.flightDrag', min: 0, max: 6, step: 0.1, label: 'carom: water drag' },
    ],
  },
  {
    group: 'Club (thrown)',
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      { path: 'clubThrow.enabled', type: 'bool', label: 'thrown club' },
      { path: 'clubThrow.minPower', min: 0, max: 1, step: 0.05, label: 'charge: minimum to throw' },
      { path: 'clubThrow.velocityScale', min: 0, max: 3, step: 0.05, label: 'throw: share of the seal\'s speed' },
      { path: 'clubThrow.minSpeed', min: 2, max: 40, step: 1, label: 'throw: slowest it may leave' },
      { path: 'clubThrow.maxSpeed', min: 10, max: 90, step: 1, label: 'throw: fastest it may leave' },
      { path: 'clubThrow.arc', min: 0, max: 3.2, step: 0.05, label: 'throw: fan width' },
      { path: 'clubThrow.homingDelay', min: 0, max: 1.5, step: 0.02, label: 'seeker: straight flight first' },
      { path: 'clubThrow.turnRate', min: 0.5, max: 14, step: 0.1, label: 'seeker: turn rate' },
      { path: 'clubThrow.acquireRadius', min: 5, max: 60, step: 1, label: 'seeker: acquisition range' },
      { path: 'clubThrow.life', min: 0.5, max: 8, step: 0.1, label: 'flight: lifespan' },
      { path: 'clubThrow.scale', min: 0.1, max: 2, step: 0.05, label: 'look: size' },
      { path: 'clubThrow.spin', min: 0, max: 40, step: 0.5, label: 'look: tumble speed' },
    ],
  },
  {
    group: 'Club riders (Powder Keg / Cold Snap)',
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      { path: 'clubBoom.enabled', type: 'bool', label: 'powder keg' },
      { path: 'clubIce.enabled', type: 'bool', label: 'cold snap' },
    ],
  },
  {
    group: 'Strike / boost',
    panel: 'companions',
    section: 'Strike & movement',
    items: [
      { path: 'strike.enabled', type: 'bool', label: 'strike system' },
      { path: 'strike.charge.time', min: 0.15, max: 3, step: 0.05, label: 'charge: seconds a full bar buys' },
      { path: 'strike.charge.minFire', min: 0, max: 0.9, step: 0.05, label: 'charge: minimum to fire' },
      { path: 'strike.charge.chumRefill', min: 0.02, max: 1, step: 0.02, label: 'charge: refill per chum' },
      { path: 'strike.charge.gulp.blockEating', type: 'bool', label: 'gulp: charging seals the mouth' },
      { path: 'strike.charge.gulp.radius', min: 0, max: 20, step: 0.5, label: 'gulp: chum swallowed on release (radius)' },
      { path: 'strike.charge.gulp.tell.shiver', min: 0, max: 0.4, step: 0.01, label: 'gulp: waiting chum shiver' },
      { path: 'strike.charge.gulp.tell.hz', min: 2, max: 20, step: 1, label: 'gulp: shiver speed (Hz)' },
      { path: 'strike.charge.gulp.tell.spinMul', min: 1, max: 10, step: 0.5, label: 'gulp: waiting chum spin-up' },
      { path: 'strike.charge.shake', min: 0, max: 0.3, step: 0.005, label: 'charge: wind-up shake' },
      { path: 'strike.charge.hapticInterval', min: 0.02, max: 0.4, step: 0.01, label: 'charge: rumble interval' },
      { path: 'strike.charge.flashTime', min: 0, max: 1, step: 0.02, label: 'charge: spend flash' },
      { path: 'strike.charge.tailLift', min: 0, max: 40, step: 0.5, label: 'wind-up: tail lift' },
      { path: 'strike.charge.vibrate.head', min: 0, max: 0.3, step: 0.005, label: 'wind-up: head tremble' },
      { path: 'strike.charge.vibrate.body', min: 0, max: 0.3, step: 0.005, label: 'wind-up: body tremble' },
      { path: 'strike.charge.vibrate.hz', min: 4, max: 28, step: 1, label: 'wind-up: tremble speed (Hz)' },
      { path: 'strike.charge.outline.enabled', type: 'bool', label: 'wind-up: rim pulses' },
      { path: 'strike.charge.outline.glowAdd', min: 0, max: 16, step: 0.25, label: 'wind-up: rim glow at full' },
      { path: 'strike.charge.outline.thicknessAdd', min: 0, max: 0.4, step: 0.005, label: 'wind-up: rim swell at full' },
      { path: 'strike.charge.outline.hzMin', min: 0.5, max: 12, step: 0.1, label: 'wind-up: rim pulse rate at start (Hz)' },
      { path: 'strike.charge.outline.hzMax', min: 0.5, max: 16, step: 0.1, label: 'wind-up: rim pulse rate at full (Hz)' },
      { path: 'strike.charge.outline.pulseDepth', min: 0, max: 1, step: 0.05, label: 'wind-up: rim pulse depth' },
      { path: 'strike.charge.outline.flareGlow', min: 0, max: 24, step: 0.5, label: 'release: rim flare glow' },
      { path: 'strike.charge.outline.flareThickness', min: 0, max: 0.6, step: 0.005, label: 'release: rim flare swell' },
      { path: 'strike.charge.outline.flareTime', min: 0.05, max: 1.5, step: 0.02, label: 'release: rim flare fade' },
      { path: 'strike.roll.enabled', type: 'bool', label: 'barrel roll on strike' },
      { path: 'strike.roll.turnsAtFull', min: 0, max: 5, step: 1, label: 'barrel roll: extra turns at full charge' },
      { path: 'strike.roll.durationMul', min: 0.2, max: 3, step: 0.05, label: 'barrel roll: length vs dash' },
      { path: 'strike.charge.damageMulMin', min: 0.1, max: 2, step: 0.05, label: 'charge: damage at empty' },
      { path: 'strike.charge.damageMulMax', min: 1, max: 5, step: 0.1, label: 'charge: damage at full' },
      { path: 'strike.charge.reachMulMin', min: 0.1, max: 2, step: 0.05, label: 'charge: reach at empty' },
      { path: 'strike.charge.reachMulMax', min: 1, max: 5, step: 0.1, label: 'charge: reach at full' },
      { path: 'strike.dashSpeed', min: 10, max: 100, step: 2 },
      { path: 'strike.dashDuration', min: 0.05, max: 1, step: 0.01, label: 'dash duration (before charge)' },
      { path: 'strike.invulnTail', min: 0, max: 1, step: 0.01, label: 'i-frames after the dash ends' },
      { path: 'strike.damage', min: 5, max: 150, step: 5, label: 'nominal strike (shrapnel/element measure from this)' },
      { path: 'strike.burst.enabled', type: 'bool', label: 'release burst' },
      { path: 'strike.burst.damage', min: 0, max: 80, step: 1, label: 'burst: damage before upgrades' },
      { path: 'strike.burst.radius', min: 0.5, max: 14, step: 0.25, label: 'burst: radius' },
      { path: 'strike.burst.radiusPowerMul', min: 1, max: 4, step: 0.05, label: 'burst: radius at full charge' },
      { path: 'strike.burst.knock', min: 0, max: 2, step: 0.05, label: 'burst: outward shove' },
      { path: 'strike.contactShare', min: 0, max: 1, step: 0.05, label: 'ram: share of that damage dealt on contact' },
      { path: 'strike.cardDamage', min: 0, max: 30, step: 1, label: 'strike damage added per strike card' },
      { path: 'strike.powerShare', min: 1, max: 8, step: 1, label: 'card slices Killer Instinct pays' },
      { path: 'strike.knockback.enabled', type: 'bool', label: 'ram: knock enemies back' },
      { path: 'strike.knockback.speed', min: 0, max: 80, step: 1, label: 'ram: knockback speed' },
      { path: 'strike.knockback.powerMin', min: 0, max: 2, step: 0.05, label: 'ram: knockback at empty charge' },
      { path: 'strike.knockback.powerMax', min: 0, max: 3, step: 0.05, label: 'ram: knockback at full charge' },
      { path: 'strike.knockback.pivotRadius', min: 0.1, max: 3, step: 0.05, label: 'ram: body size that takes the full shove' },
      { path: 'strike.knockback.massExp', min: 0, max: 3, step: 0.1, label: 'ram: how hard size resists' },
      { path: 'strike.knockback.decay', min: 0.5, max: 20, step: 0.25, label: 'ram: knockback falloff' },
      { path: 'strike.knockback.spin', min: 0, max: 20, step: 0.5, label: 'ram: tumble imparted' },
      { path: 'strike.knockback.boneImpulse', min: 0, max: 10, step: 0.1, label: 'ram: skeleton flinch' },
      { path: 'strike.mark.enabled', type: 'bool', label: 'mark: strike paints big targets' },
      { path: 'strike.mark.duration', min: 0.5, max: 20, step: 0.5, label: 'mark: seconds it lasts' },
      { path: 'strike.mark.minRadius', min: 0, max: 3, step: 0.05, label: 'mark: smallest body worth painting' },
      { path: 'strike.mark.boats', type: 'bool', label: 'mark: boats too' },
      { path: 'strike.mark.homingPull', min: 0.05, max: 1, step: 0.05, label: 'mark: how much closer it looks to homing' },
      { path: 'strike.mark.ring.radiusMul', min: 0.5, max: 4, step: 0.05, label: 'mark: reticle size' },
      { path: 'strike.mark.ring.thickness', min: 0.02, max: 0.6, step: 0.01, label: 'mark: reticle thickness' },
      { path: 'strike.mark.ring.color', type: 'color', label: 'mark: reticle colour' },
      { path: 'strike.mark.ring.glow', min: 0, max: 8, step: 0.1, label: 'mark: reticle glow' },
      { path: 'strike.mark.ring.hz', min: 0, max: 10, step: 0.1, label: 'mark: reticle pulse (Hz)' },
      { path: 'strike.mark.ring.pulseDepth', min: 0, max: 1, step: 0.05, label: 'mark: reticle pulse depth' },
      { path: 'strike.mark.ring.spin', min: -4, max: 4, step: 0.1, label: 'mark: reticle spin' },
      { path: 'strike.scare.enabled', type: 'bool', label: 'scare: small fish flee a strike' },
      { path: 'strike.scare.radius', min: 0, max: 25, step: 0.5, label: 'scare: reach' },
      { path: 'strike.scare.strength', min: 0, max: 40, step: 0.5, label: 'scare: panic weight' },
      { path: 'strike.scare.speedMul', min: 0, max: 3, step: 0.05, label: 'scare: extra speed when bolting' },
      { path: 'strike.scare.chargeShare', min: 0, max: 2, step: 0.05, label: 'scare: share of that while winding up' },
      { path: 'strike.scare.lead', min: 0, max: 12, step: 0.5, label: 'scare: centred this far up the corridor' },
      { path: 'strike.chainWindow', min: 0.2, max: 3, step: 0.05 },
      { path: 'strike.chainDamageMul', min: 1, max: 2, step: 0.02 },
      { path: 'strike.dashTurnRate', min: 0, max: 30, step: 0.5, label: 'dash turn rate (higher = tighter)' },
      { path: 'strike.aimBlend', min: 0, max: 1, step: 0.05, label: 'dash heading: swim (0) -> aim (1)' },
      { path: 'strike.dashFaceLerp', min: 1, max: 40, step: 0.5, label: 'dash facing snap' },
      { path: 'strike.comboSpeedPerLevel', min: 0, max: 0.4, step: 0.01, label: 'combo: speed per link' },
      { path: 'strike.comboSpeedMax', min: 1, max: 3, step: 0.05, label: 'combo: speed cap' },
      { path: 'strike.orbSpawnMin', min: 2, max: 30, step: 1 },
      { path: 'strike.orbSpawnMax', min: 2, max: 40, step: 1 },
      { path: 'strike.shrapnel.count', min: 1, max: 24, step: 1, label: 'shrapnel: fragments' },
      { path: 'strike.shrapnel.countPerLevel', min: 0, max: 6, step: 1, label: 'shrapnel: fragments per level' },
      { path: 'strike.shrapnel.damageFrac', min: 0.02, max: 1, step: 0.02, label: 'shrapnel: damage (frac of strike)' },
      { path: 'strike.shrapnel.speed', min: 4, max: 60, step: 1, label: 'shrapnel: speed' },
      { path: 'strike.shrapnel.life', min: 0.1, max: 3, step: 0.05, label: 'shrapnel: lifespan' },
      { path: 'strike.shrapnel.radius', min: 0.05, max: 1, step: 0.01, label: 'shrapnel: hit size' },
      { path: 'strike.shrapnel.pierce', min: 0, max: 5, step: 1, label: 'shrapnel: pierce' },
      { path: 'strike.shrapnel.spread', min: 0, max: 1.5, step: 0.05, label: 'shrapnel: angle jitter' },
      { path: 'strike.chainOn.strikeRelease', type: 'bool', label: 'food chain: a strike paid for in food (the main engine)' },
      { path: 'strike.chainOn.chumFull', type: 'bool', label: 'food chain: eating refills the meter to full (superseded)' },
      { path: 'strike.preyCull.enabled', type: 'bool', label: 'dash eats small prey outright' },
      { path: 'strike.preyCull.maxRadius', min: 0, max: 2, step: 0.05, label: 'dash eats prey under this radius' },
      { path: 'strike.chainOn.schoolWipe', type: 'bool', label: 'food chain: whole school in one strike' },
      { path: 'strike.chainOn.breach', type: 'bool', label: 'food chain: breach (Porpoising)' },
      { path: 'strike.chainOn.strikeHit', type: 'bool', label: 'food chain: a dash connecting (off — the ram is a shove)' },
      { path: 'strike.chainOn.cooldowns.breach', min: 0, max: 3, step: 0.05, label: 'food chain: min gap, breach' },
      { path: 'strike.foodChain.minChain', min: 2, max: 10, step: 1, label: 'FOOD CHAIN!: links before banner' },
      { path: 'strike.foodChain.punch', min: 0, max: 0.2, step: 0.005, label: 'FOOD CHAIN!: camera punch' },
      { path: 'strike.foodChain.punchPerChain', min: 0, max: 0.05, step: 0.002, label: 'FOOD CHAIN!: punch per link' },
      { path: 'strike.breachChain.linksPerLevel', min: 1, max: 4, step: 1, label: 'Porpoising: links per breach, per stack' },
      // Camera-wide settings, surfaced here because the food chain is the only
      // thing that punches the lens today — if that changes they want their
      // own group.
      { path: 'camera.punch.enabled', type: 'bool', label: 'camera punch-in' },
      { path: 'camera.punch.max', min: 0, max: 0.4, step: 0.01, label: 'camera punch: max zoom' },
      { path: 'camera.punch.decay', min: 1, max: 20, step: 0.5, label: 'camera punch: release speed' },
    ],
  },
  {
    // The follow rig. Off by default and a real off switch — see the cinecam
    // block up top. The zoom floor is above 1 because the arena exactly fills
    // the frame at zoom 1, so a rig at 1 has nowhere to pan to.
    group: 'Aim indicator',
    section: 'Interface & controls',
    items: [
      { path: 'aimIndicator.enabled', type: 'bool', label: 'show an aim indicator' },
      { path: 'aimIndicator.opacity', min: 0, max: 1, step: 0.02, label: 'opacity while firing' },
      { path: 'aimIndicator.idleOpacity', min: 0, max: 1, step: 0.02, label: 'opacity when not firing (x)' },
      { path: 'aimIndicator.fade', min: 0.01, max: 1, step: 0.01, label: 'fade between those (s)' },
      // --- the beam ---
      { path: 'aimIndicator.line.enabled', type: 'bool', label: 'line: draw the beam' },
      { path: 'aimIndicator.line.length', min: 2, max: 60, step: 0.5, label: 'line: length' },
      { path: 'aimIndicator.line.start', min: 0, max: 8, step: 0.1, label: 'line: gap from the seal' },
      { path: 'aimIndicator.line.width', min: 0.02, max: 1.2, step: 0.01, label: 'line: half-width' },
      { path: 'aimIndicator.line.softness', min: 0, max: 0.99, step: 0.01, label: 'line: edge softness' },
      { path: 'aimIndicator.line.fade', min: 0, max: 1, step: 0.02, label: 'line: dim toward the far end' },
      { path: 'aimIndicator.line.glow', min: 0, max: 4, step: 0.05, label: 'line: glow' },
      { path: 'aimIndicator.line.dashed', type: 'bool', label: 'line: dashed' },
      { path: 'aimIndicator.line.dashSize', min: 0.1, max: 8, step: 0.1, label: 'line: dash + gap length' },
      { path: 'aimIndicator.line.dashDuty', min: 0.05, max: 0.95, step: 0.05, label: 'line: lit fraction of a dash' },
      { path: 'aimIndicator.line.dashSpeed', min: -30, max: 30, step: 0.5, label: 'line: dash scroll speed' },
      // --- the reticle ---
      { path: 'aimIndicator.reticle.enabled', type: 'bool', label: 'reticle: draw it' },
      { path: 'aimIndicator.reticle.distance', min: 2, max: 60, step: 0.5, label: 'reticle: stand-off along the aim' },
      { path: 'aimIndicator.reticle.radius', min: 0.1, max: 6, step: 0.05, label: 'reticle: ring radius' },
      { path: 'aimIndicator.reticle.thickness', min: 0.02, max: 1, step: 0.01, label: 'reticle: stroke thickness' },
      { path: 'aimIndicator.reticle.tickCount', min: 0, max: 12, step: 1, label: 'reticle: ticks (0 = bare ring)' },
      { path: 'aimIndicator.reticle.tickLength', min: 0, max: 3, step: 0.05, label: 'reticle: tick length' },
      { path: 'aimIndicator.reticle.tickWidth', min: 0.02, max: 1, step: 0.01, label: 'reticle: tick width' },
      { path: 'aimIndicator.reticle.dot', min: 0, max: 1.5, step: 0.02, label: 'reticle: centre dot (0 = none)' },
      { path: 'aimIndicator.reticle.spinSpeed', min: -4, max: 4, step: 0.05, label: 'reticle: spin (rad/s)' },
      { path: 'aimIndicator.reticle.glow', min: 0, max: 4, step: 0.05, label: 'reticle: glow' },
    ],
  },
  {
    group: 'Cine camera: rig',
    section: 'Camera',
    items: [
      { path: 'cinecam.enabled', type: 'bool', label: 'cinematic follow camera' },
      { path: 'cinecam.base.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'punch-in (x)' },
      { path: 'cinecam.base.zoomMax', min: 1.2, max: 4, step: 0.05, label: 'zoom ceiling (x)' },
      { path: 'cinecam.base.zoomStiffness', min: 4, max: 90, step: 1, label: 'zoom spring stiffness' },
      { path: 'cinecam.base.zoomDamping', min: 0.4, max: 1.6, step: 0.02, label: 'zoom damping (1 = critical)' },
      { path: 'cinecam.base.stiffness.x', min: 4, max: 160, step: 1, label: 'spring stiffness: horizontal' },
      { path: 'cinecam.base.stiffness.y', min: 4, max: 160, step: 1, label: 'spring stiffness: vertical' },
      { path: 'cinecam.base.damping', min: 0.4, max: 1.6, step: 0.02, label: 'damping (1 = critical, less = overshoot)' },
      { path: 'cinecam.base.deadZone.x', min: 0, max: 0.45, step: 0.005, label: 'dead zone: horizontal (frac of half-frame)' },
      { path: 'cinecam.base.deadZone.y', min: 0, max: 0.45, step: 0.005, label: 'dead zone: vertical (frac of half-frame)' },
      { path: 'cinecam.base.lookAhead', min: 0, max: 0.8, step: 0.01, label: 'look-ahead (seconds of velocity)' },
      { path: 'cinecam.base.lookAheadMax', min: 0, max: 30, step: 0.5, label: 'look-ahead cap (world units)' },
      { path: 'cinecam.base.lookAheadLag', min: 0.02, max: 1.5, step: 0.02, label: 'look-ahead smoothing (s)' },
      { path: 'cinecam.base.aimBias', min: 0, max: 15, step: 0.1, label: 'aim bias (world units)' },
      { path: 'cinecam.base.blendIn', min: 0.02, max: 3, step: 0.02, label: 'default blend in (s)' },
      { path: 'cinecam.base.blendOut', min: 0.02, max: 3, step: 0.02, label: 'default blend out (s)' },
    ],
  },
  {
    // The lens. Each of the three has its own enable so any one can be A/B'd
    // without losing the rig. Flare intensities stay low on purpose: the
    // composite is LDR with no tonemapping, so an additive flare over an
    // already-bright frame clips straight to white.
    group: 'Cine camera: lens',
    section: 'Camera',
    items: [
      { path: 'cinecam.lens.tiltShift.enabled', type: 'bool', label: 'tilt shift' },
      { path: 'cinecam.lens.tiltShift.strength', min: 0, max: 1.5, step: 0.02, label: 'tilt shift: master strength' },
      { path: 'cinecam.lens.tiltShift.radius', min: 1, max: 6, step: 1, label: 'tilt shift: blur iterations (cost)' },
      { path: 'cinecam.base.defocus', min: 0, max: 1, step: 0.02, label: 'tilt shift: edge blur (base)' },
      { path: 'cinecam.base.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'tilt shift: sharp radius (base)' },
      { path: 'cinecam.base.focusFeather', min: 0.02, max: 0.8, step: 0.01, label: 'tilt shift: falloff width (base)' },
      { path: 'cinecam.lens.flare.enabled', type: 'bool', label: 'lens flares' },
      { path: 'cinecam.lens.flare.strength', min: 0, max: 2, step: 0.02, label: 'flare: master strength' },
      { path: 'cinecam.base.flare', min: 0, max: 2, step: 0.02, label: 'flare: amount (base)' },
      { path: 'cinecam.lens.flare.spacing', min: 0.05, max: 1, step: 0.01, label: 'flare: ghost spacing' },
      { path: 'cinecam.lens.flare.halo', min: 0, max: 1, step: 0.01, label: 'flare: halo distance' },
      { path: 'cinecam.lens.flare.streak', min: 0, max: 0.03, step: 0.0005, label: 'flare: anamorphic width' },
      { path: 'cinecam.lens.flare.streakGain', min: 0, max: 2, step: 0.02, label: 'flare: anamorphic strength' },
      { path: 'cinecam.base.vignette', min: 0, max: 1, step: 0.02, label: 'vignette (base, adds to the post preset)' },
      // --- the dash corridor ---
      { path: 'cinecam.lens.path.enabled', type: 'bool', label: 'highlight the dash path while charging' },
      { path: 'cinecam.lens.path.width', min: 0.01, max: 0.4, step: 0.005, label: 'dash path: lane half-width' },
      { path: 'cinecam.lens.path.feather', min: 0.02, max: 0.6, step: 0.01, label: 'dash path: lane falloff' },
      { path: 'cinecam.lens.path.length', min: 0, max: 1, step: 0.02, label: 'dash path: reach at zero charge' },
      { path: 'cinecam.lens.path.lengthPerPower', min: 0, max: 1.2, step: 0.02, label: 'dash path: extra reach at full charge' },
      { path: 'cinecam.lens.path.vignette', min: 0, max: 1, step: 0.02, label: 'dash path: darkening outside the lane' },
      { path: 'cinecam.lens.droplets.enabled', type: 'bool', label: 'water on the lens after a breach' },
      { path: 'cinecam.lens.droplets.perBreach', min: 0, max: 1, step: 0.02, label: 'droplets: wetness per breach' },
      { path: 'cinecam.lens.droplets.life', min: 0.3, max: 10, step: 0.1, label: 'droplets: time to dry (s)' },
      { path: 'cinecam.lens.droplets.density', min: 3, max: 26, step: 1, label: 'droplets: count across the frame' },
      { path: 'cinecam.lens.droplets.size', min: 0.05, max: 0.5, step: 0.01, label: 'droplets: bead size' },
      { path: 'cinecam.lens.droplets.refract', min: 0, max: 0.2, step: 0.002, label: 'droplets: refraction' },
      { path: 'cinecam.lens.droplets.spec', min: 0, max: 2, step: 0.02, label: 'droplets: highlight' },
      { path: 'cinecam.lens.droplets.slide', min: 0, max: 1.6, step: 0.05, label: 'droplets: run distance (cell heights)' },
      { path: 'cinecam.lens.droplets.stretch', min: 0, max: 4, step: 0.05, label: 'droplets: vertical stretch when running' },
      { path: 'cinecam.lens.droplets.taper', min: 0, max: 0.9, step: 0.02, label: 'droplets: teardrop tail' },
      { path: 'cinecam.lens.droplets.slide', min: 0, max: 1, step: 0.02, label: 'droplets: how far they creep down' },
    ],
  },
  {
    // Per-state overrides. Anything a state doesn't set, it inherits from the
    // rig and lens groups above — these are the deltas, not a second copy.
    // `Mul` sliders scale the base value; the rest replace it.
    group: 'Cine camera: states',
    section: 'Camera',
    items: [
      { path: 'cinecam.states.roundStart.hold', min: 0, max: 6, step: 0.1, label: 'round start: length (s)' },
      { path: 'cinecam.states.roundStart.blendIn', min: 0.02, max: 3, step: 0.02, label: 'round start: blend in (s)' },
      { path: 'cinecam.states.roundStart.blendOut', min: 0.02, max: 4, step: 0.02, label: 'round start: blend out (s)' },
      { path: 'cinecam.states.roundStart.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'round start: zoom' },
      { path: 'cinecam.states.roundStart.stiffMul', min: 0.05, max: 4, step: 0.05, label: 'round start: stiffness (x)' },
      { path: 'cinecam.states.roundStart.lookAheadMul', min: 0, max: 3, step: 0.05, label: 'round start: look-ahead (x)' },
      { path: 'cinecam.states.roundStart.defocus', min: 0, max: 1, step: 0.02, label: 'round start: edge blur' },
      { path: 'cinecam.states.roundStart.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'round start: sharp radius' },
      { path: 'cinecam.states.roundStart.flare', min: 0, max: 2, step: 0.02, label: 'round start: flare' },
      { path: 'cinecam.states.roundStart.vignette', min: 0, max: 1, step: 0.02, label: 'round start: vignette' },

      { path: 'cinecam.states.charging.blendIn', min: 0.02, max: 3, step: 0.02, label: 'charging: blend in (s)' },
      { path: 'cinecam.states.charging.blendOut', min: 0.02, max: 3, step: 0.02, label: 'charging: blend out (s)' },
      { path: 'cinecam.states.charging.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'charging: zoom' },
      { path: 'cinecam.states.charging.zoomDampMul', min: 0.3, max: 1.6, step: 0.02, label: 'charging: zoom elasticity (lower = bouncier)' },
      { path: 'cinecam.states.charging.zoomStiffMul', min: 0.05, max: 4, step: 0.05, label: 'charging: zoom pull-in speed (x)' },
      { path: 'cinecam.states.boosting.zoomStiffMul', min: 0.05, max: 4, step: 0.05, label: 'boosting: zoom snap-out speed (x)' },
      { path: 'cinecam.states.charging.path', min: 0, max: 1, step: 0.02, label: 'charging: dash path highlight' },
      { path: 'cinecam.states.charging.stiffMul', min: 0.05, max: 4, step: 0.05, label: 'charging: stiffness (x)' },
      { path: 'cinecam.states.charging.lookAheadMul', min: 0, max: 3, step: 0.05, label: 'charging: look-ahead (x)' },
      { path: 'cinecam.states.charging.deadZoneMul', min: 0, max: 2, step: 0.05, label: 'charging: dead zone (x)' },
      { path: 'cinecam.states.charging.defocus', min: 0, max: 1, step: 0.02, label: 'charging: edge blur' },
      { path: 'cinecam.states.charging.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'charging: sharp radius' },
      { path: 'cinecam.states.charging.flare', min: 0, max: 2, step: 0.02, label: 'charging: flare' },
      { path: 'cinecam.states.charging.vignette', min: 0, max: 1, step: 0.02, label: 'charging: vignette' },

      { path: 'cinecam.states.boosting.blendIn', min: 0.02, max: 3, step: 0.02, label: 'boosting: blend in (s)' },
      { path: 'cinecam.states.boosting.blendOut', min: 0.02, max: 3, step: 0.02, label: 'boosting: blend out (s)' },
      { path: 'cinecam.states.boosting.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'boosting: zoom' },
      // Below 1 is the point of this one: a soft spring is what lets the dash
      // outrun the frame instead of the frame gliding along with it.
      { path: 'cinecam.states.boosting.stiffMul', min: 0.05, max: 4, step: 0.05, label: 'boosting: stiffness (x)' },
      { path: 'cinecam.states.boosting.dampMul', min: 0.3, max: 2, step: 0.05, label: 'boosting: damping (x)' },
      { path: 'cinecam.states.boosting.lookAheadMul', min: 0, max: 4, step: 0.05, label: 'boosting: look-ahead (x)' },
      { path: 'cinecam.states.boosting.defocus', min: 0, max: 1, step: 0.02, label: 'boosting: edge blur' },
      { path: 'cinecam.states.boosting.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'boosting: sharp radius' },
      { path: 'cinecam.states.boosting.flare', min: 0, max: 2, step: 0.02, label: 'boosting: flare' },
      { path: 'cinecam.states.boosting.vignette', min: 0, max: 1, step: 0.02, label: 'boosting: vignette' },

      { path: 'cinecam.states.foodChain.hold', min: 0.1, max: 4, step: 0.05, label: 'food chain: length (s)' },
      { path: 'cinecam.states.foodChain.blendIn', min: 0.02, max: 2, step: 0.01, label: 'food chain: blend in (s)' },
      { path: 'cinecam.states.foodChain.blendOut', min: 0.02, max: 3, step: 0.02, label: 'food chain: blend out (s)' },
      { path: 'cinecam.states.foodChain.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'food chain: zoom' },
      { path: 'cinecam.states.foodChain.stiffMul', min: 0.05, max: 5, step: 0.05, label: 'food chain: stiffness (x)' },
      { path: 'cinecam.states.foodChain.defocus', min: 0, max: 1, step: 0.02, label: 'food chain: edge blur' },
      { path: 'cinecam.states.foodChain.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'food chain: sharp radius' },
      { path: 'cinecam.states.foodChain.flare', min: 0, max: 2, step: 0.02, label: 'food chain: flare' },
      { path: 'cinecam.states.foodChain.vignette', min: 0, max: 1, step: 0.02, label: 'food chain: vignette' },

      // The three death beats. `deathHit.hold` is also the handover point —
      // it's how long the hit lasts before the fall takes the frame. Framing
      // during a death still belongs to deathDive.js's push-in, which blends
      // over the top of these, so keep the zooms near the base value or the
      // two push-ins compound into a close-up of one flipper.
      { path: 'cinecam.states.deathHit.hold', min: 0.05, max: 3, step: 0.05, label: 'death hit: length before the fall (s)' },
      { path: 'cinecam.states.deathHit.blendIn', min: 0.02, max: 2, step: 0.01, label: 'death hit: blend in (s)' },
      { path: 'cinecam.states.deathHit.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'death hit: zoom' },
      { path: 'cinecam.states.deathHit.stiffMul', min: 0.05, max: 5, step: 0.05, label: 'death hit: stiffness (x)' },
      { path: 'cinecam.states.deathHit.defocus', min: 0, max: 1, step: 0.02, label: 'death hit: edge blur' },
      { path: 'cinecam.states.deathHit.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'death hit: sharp radius' },
      { path: 'cinecam.states.deathHit.flare', min: 0, max: 2, step: 0.02, label: 'death hit: flare' },
      { path: 'cinecam.states.deathHit.vignette', min: 0, max: 1, step: 0.02, label: 'death hit: vignette' },

      { path: 'cinecam.states.deathFall.blendIn', min: 0.02, max: 4, step: 0.02, label: 'death fall: blend in (s)' },
      { path: 'cinecam.states.deathFall.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'death fall: zoom' },
      { path: 'cinecam.states.deathFall.stiffMul', min: 0.05, max: 4, step: 0.05, label: 'death fall: stiffness (x)' },
      { path: 'cinecam.states.deathFall.dampMul', min: 0.3, max: 2, step: 0.05, label: 'death fall: damping (x)' },
      { path: 'cinecam.states.deathFall.lookAheadMul', min: 0, max: 3, step: 0.05, label: 'death fall: look-ahead (x)' },
      { path: 'cinecam.states.deathFall.defocus', min: 0, max: 1, step: 0.02, label: 'death fall: edge blur' },
      { path: 'cinecam.states.deathFall.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'death fall: sharp radius' },
      { path: 'cinecam.states.deathFall.flare', min: 0, max: 2, step: 0.02, label: 'death fall: flare' },
      { path: 'cinecam.states.deathFall.vignette', min: 0, max: 1, step: 0.02, label: 'death fall: vignette' },

      { path: 'cinecam.states.deathFloor.blendIn', min: 0.02, max: 4, step: 0.02, label: 'floor hit: blend in (s)' },
      { path: 'cinecam.states.deathFloor.zoom', min: 1.02, max: 2.5, step: 0.01, label: 'floor hit: zoom' },
      { path: 'cinecam.states.deathFloor.stiffMul', min: 0.05, max: 4, step: 0.05, label: 'floor hit: stiffness (x)' },
      { path: 'cinecam.states.deathFloor.defocus', min: 0, max: 1, step: 0.02, label: 'floor hit: edge blur' },
      { path: 'cinecam.states.deathFloor.focusRadius', min: 0.02, max: 0.8, step: 0.01, label: 'floor hit: sharp radius' },
      { path: 'cinecam.states.deathFloor.flare', min: 0, max: 2, step: 0.02, label: 'floor hit: flare' },
      { path: 'cinecam.states.deathFloor.vignette', min: 0, max: 1, step: 0.02, label: 'floor hit: vignette' },
    ],
  },
  {
    group: 'Pickups & loot',
    section: 'Gameplay',
    items: [
      { path: 'pickups.healFraction', min: 0, max: 0.2, step: 0.005, label: 'heal per orb (fraction of max HP)' },
      // --- THE MAGNET, PER STATE (systems/chumMagnet.js) ---
      // `speedMul` is the one that matters while striking: the base pull is
      // 14 u/s against a 46 u/s dash, so below about 3.3x an orb off to the
      // side can never catch a dashing seal and the extra radius is decorative.
      { path: 'player.pickupRadius', min: 0.5, max: 16, step: 0.1, label: 'magnet: base radius' },
      { path: 'pickups.magnetSpeed', min: 2, max: 60, step: 0.5, label: 'magnet: base pull speed' },
      { path: 'pickups.magnet.swimming.radiusMul', min: 1, max: 4, step: 0.05, label: 'swimming: radius (x)' },
      { path: 'pickups.magnet.swimming.speedMul', min: 1, max: 6, step: 0.05, label: 'swimming: pull (x)' },
      { path: 'pickups.magnet.boosting.radiusMul', min: 1, max: 4, step: 0.05, label: 'fast swim: radius (x)' },
      { path: 'pickups.magnet.boosting.speedMul', min: 1, max: 6, step: 0.05, label: 'fast swim: pull (x)' },
      { path: 'pickups.magnet.striking.radiusMul', min: 1, max: 5, step: 0.05, label: 'striking: radius (x)' },
      { path: 'pickups.magnet.striking.speedMul', min: 1, max: 8, step: 0.1, label: 'striking: pull (x) — needs 3.3+' },
      { path: 'pickups.magnet.striking.corridorBack', min: 0, max: 20, step: 0.5, label: 'striking: corridor behind' },
      { path: 'pickups.magnet.striking.corridorAhead', min: 0, max: 20, step: 0.5, label: 'striking: corridor ahead' },
      // --- the chain's multiplier ---
      { path: 'strike.chainLevelOffset', min: 0, max: 3, step: 0.25, label: 'chain: free links before the multiplier starts' },
      { path: 'pickups.tiers.0.xpMul', min: 0.1, max: 3, step: 0.05, label: 'small orb xp mult' },
      { path: 'pickups.tiers.0.healMul', min: 0.1, max: 3, step: 0.05, label: 'small orb heal mult' },
      { path: 'pickups.tiers.2.xpMul', min: 0.1, max: 4, step: 0.05, label: 'big orb xp mult' },
      { path: 'pickups.tiers.2.healMul', min: 0.1, max: 4, step: 0.05, label: 'big orb heal mult' },

      // The proximity glow. Worth tuning with the texture panel's own chum glow
      // open alongside it: the two multiply, so how far `near` has to travel to
      // reach the bloom threshold depends entirely on where that slider is.
      { path: 'pickups.glow.enabled', type: 'bool', label: 'chum glow: on' },
      { path: 'pickups.glow.near', min: 1, max: 8, step: 0.1, label: 'chum glow: brightness up close (x)' },
      { path: 'pickups.glow.far', min: 0.2, max: 2, step: 0.05, label: 'chum glow: brightness at the rim (x)' },
      { path: 'pickups.glow.radius', min: 0.5, max: 8, step: 0.1, label: 'chum glow: reach (x pickup radius)' },
      { path: 'pickups.glow.curve', min: 0.5, max: 5, step: 0.1, label: 'chum glow: ramp (1 = linear)' },
      { path: 'pickups.glow.pulse.hz', min: 0, max: 6, step: 0.1, label: 'chum glow: shimmer rate (Hz)' },
      { path: 'pickups.glow.pulse.depth', min: 0, max: 1, step: 0.02, label: 'chum glow: shimmer depth' },
    ],
  },
  {
    group: 'Points',
    section: 'Gameplay',
    items: [
      { path: 'points.preyMultiplier', min: 0, max: 10, step: 0.1 },
      { path: 'points.predatorMultiplier', min: 0, max: 20, step: 0.5 },
      { path: 'points.schoolWipeBonus', min: 0, max: 1000, step: 10 },
      { path: 'points.comboMultiplierPerChain', min: 0, max: 2, step: 0.05 },
      { path: 'points.comboMaxMultiplier', min: 1, max: 15, step: 0.5 },
    ],
  },
  {
    group: 'Oxygen',
    section: 'Gameplay',
    items: [
      { path: 'oxygen.enabled', type: 'bool', label: 'oxygen system' },
      { path: 'oxygen.max', min: 20, max: 300, step: 5 },
      { path: 'oxygen.depleteRate', min: 0, max: 20, step: 0.2, label: 'deplete rate (underwater)' },
      { path: 'oxygen.refillRateSurface', min: 1, max: 100, step: 1, label: 'refill rate (surface)' },
      { path: 'oxygen.bubbleRefillAmount', min: 0, max: 100, step: 1 },
      { path: 'oxygen.drainDamagePerSec', min: 0, max: 40, step: 0.5, label: 'damage per sec at 0 oxygen' },
      { path: 'oxygen.bubbleSpawnMin', min: 1, max: 40, step: 1 },
      { path: 'oxygen.bubbleSpawnMax', min: 1, max: 60, step: 1 },
    ],
  },
  {
    group: 'Suffocation FX',
    section: 'Gameplay',
    items: [
      { path: 'oxygen.fx.enabled', type: 'bool', label: 'suffocation effects' },
      { path: 'oxygen.fx.threshold', min: 0.02, max: 0.6, step: 0.005, label: 'starts below this much oxygen' },
      { path: 'oxygen.fx.attack', min: 0.05, max: 3, step: 0.05, label: 'ease in (seconds)' },
      { path: 'oxygen.fx.release', min: 0.05, max: 3, step: 0.05, label: 'ease out (seconds)' },
      { path: 'oxygen.fx.pixelMax', min: 1, max: 60, step: 1, label: 'pixel block size at empty' },
      { path: 'oxygen.fx.pixelCurve', min: 0.5, max: 4, step: 0.1, label: 'pixel curve (higher = later)' },
      { path: 'oxygen.fx.musicEnabled', type: 'bool', label: 'band-pass the music' },
      { path: 'oxygen.fx.musicMix', min: 0, max: 1, step: 0.02, label: 'band-pass mix at empty' },
      { path: 'oxygen.fx.musicCenterHz', min: 200, max: 4000, step: 20, label: 'band centre' },
      { path: 'oxygen.fx.musicQ', min: 0.7, max: 12, step: 0.1, label: 'band narrowness' },
      { path: 'oxygen.fx.beepEnabled', type: 'bool', label: 'low oxygen beep' },
      { path: 'oxygen.fx.beepIntervalFar', min: 0.1, max: 3, step: 0.05, label: 'beep gap at threshold' },
      { path: 'oxygen.fx.beepIntervalNear', min: 0.05, max: 2, step: 0.01, label: 'beep gap at empty' },
      { path: 'oxygen.fx.beepPitchRise', min: 0, max: 2, step: 0.05, label: 'beep pitch climb' },
      { path: 'oxygen.fx.breathEnabled', type: 'bool', label: 'surface gasps' },
      { path: 'oxygen.fx.breathInterval', min: 0.15, max: 2, step: 0.05, label: 'seconds between gasps' },
    ],
  },
  {
    group: 'Rapid fire pickup',
    section: 'Gameplay',
    items: [
      { path: 'rapidFirePickup.enabled', type: 'bool', label: 'rapid fire pickup' },
      { path: 'rapidFirePickup.duration', min: 1, max: 30, step: 0.5 },
      { path: 'rapidFirePickup.fireRateMul', min: 1, max: 5, step: 0.1 },
      { path: 'rapidFirePickup.multishotMul', min: 1, max: 5, step: 0.1 },
      { path: 'rapidFirePickup.spawnMin', min: 1, max: 60, step: 1 },
      { path: 'rapidFirePickup.spawnMax', min: 1, max: 90, step: 1 },
    ],
  },
  {
    group: 'Crab spawn',
    panel: 'enemies',
    section: 'Crabs & crawlers',
    items: [
      // How crabs scale over a run used to be five sliders here
      // (scalePerDifficulty, maxGrowth, hpPerDifficulty,
      // contactDamagePerDifficulty, speedPerDifficulty). They're columns in
      // enemies.csv now, where the crab's ramp sits next to every other
      // creature's instead of on its own in a panel.
      // --- gait tempo ---
      { path: 'enemies.walkingCrab.beatSync.beatsPerStride', min: 0.25, max: 8, step: 0.25, label: 'beats per crab footfall' },
      // --- how crabs find and reach the chum ---
      // --- the pinch (systems/crabClaw.js) ---
      // `windup` is the one that changes how the crab FEELS rather than how it
      // looks: it is the whole window a player has to read the attack and move,
      // so shortening it makes crabs harder without touching a damage number.
      { path: 'crabClaw.enabled', type: 'bool', label: 'crabs pinch at you' },
      { path: 'crabClaw.windup', min: 0.1, max: 1.5, step: 0.02, label: 'windup (the tell)' },
      { path: 'crabClaw.strike', min: 0.05, max: 0.6, step: 0.01, label: 'strike' },
      { path: 'crabClaw.recover', min: 0.1, max: 1, step: 0.02, label: 'recover' },
      { path: 'crabClaw.cooldown', min: 0.3, max: 8, step: 0.1, label: 'between pinches' },
      { path: 'crabClaw.range', min: 1, max: 6, step: 0.1, label: 'reach (x crab radius)' },
      { path: 'crabClaw.commitRange', min: 1, max: 6, step: 0.1, label: 'range it commits at' },
      { path: 'crabClaw.damageMul', min: 0, max: 3, step: 0.05, label: 'damage (x contact damage)' },
      { path: 'crabClaw.knockback', min: 0, max: 4, step: 0.1, label: 'knockback' },
      // --- what the pinch looks like ---
      { path: 'crabClaw.rise', min: 0, max: 1.5, step: 0.05, label: 'how high the claw rears' },
      { path: 'crabClaw.draw', min: 0, max: 1, step: 0.05, label: 'how far back it draws' },
      { path: 'crabClaw.gape', min: 0, max: 1.4, step: 0.02, label: 'claw gape' },
      { path: 'crabClaw.snap', min: 0, max: 0.8, step: 0.02, label: 'snap overshoot (scissor only)' },
      { path: 'crabClaw.jawScale', min: 0, max: 1.5, step: 0.05, label: 'how wide a real claw opens' },
      { path: 'crabClaw.counterRotation', min: 0, max: 1, step: 0.05, label: 'forearm shear (0 = whole head swings)' },
      { path: 'crabClaw.armLag', min: 0, max: 0.4, step: 0.01, label: 'second claw lag' },
      { path: 'crabClaw.reachWeight', min: 0, max: 1, step: 0.02, label: 'how completely the IK owns the arm' },
      { path: 'crabClaw.ik.maxBend', min: 0.1, max: 2, step: 0.05, label: 'max bend per joint' },
      { path: 'crabClaw.ik.rootInfluence', min: 0, max: 1, step: 0.05, label: 'shoulder swing' },
      { path: 'crabClaw.ik.smoothing', min: 1, max: 30, step: 0.5, label: 'IK smoothing' },
      // --- crab-vs-crab collisions ---
      { path: 'crabPhysics.enabled', type: 'bool', label: 'crab collisions' },
      { path: 'crabPhysics.restitution', min: 0, max: 1, step: 0.05, label: 'bounciness' },
      { path: 'crabPhysics.contactScale', min: 0.5, max: 1.5, step: 0.05, label: 'contact distance scale' },
      { path: 'crabPhysics.positionCorrection', min: 0, max: 1, step: 0.05, label: 'overlap resolved per frame' },
      { path: 'crabPhysics.minImpactSpeed', min: 0, max: 8, step: 0.1, label: 'speed before a knock registers' },
      { path: 'crabPhysics.tumblePerSpeed', min: 0, max: 3, step: 0.05, label: 'roll per impact speed' },
      { path: 'crabPhysics.maxLean', min: 0.1, max: 3.14, step: 0.05, label: 'max roll angle' },
      { path: 'crabPhysics.rightingStiffness', min: 1, max: 150, step: 1, label: 'righting spring' },
      { path: 'crabPhysics.rightingDamping', min: 0.5, max: 30, step: 0.5, label: 'righting damping' },
      { path: 'crabPhysics.boneImpulsePerSpeed', min: 0, max: 3, step: 0.05, label: 'skeleton flail per impact' },
      { path: 'crabPhysics.maxBoneImpulse', min: 0, max: 12, step: 0.25, label: 'max skeleton flail' },
      // --- climbing and depth: how a crowd arranges itself ---
      // `climb bias` at 0 restores the old behaviour exactly (a flat rank of
      // crabs all at floor height), which makes it the first slider to reach
      // for when a heap looks wrong.
      { path: 'crabPhysics.climbBias', min: 0, max: 1, step: 0.05, label: 'climb bias (0 = flat rank)' },
      { path: 'crabPhysics.stackHeight', min: 0.2, max: 1.2, step: 0.05, label: 'how high one crab rides on another' },
      { path: 'crabPhysics.gravity', min: 0, max: 60, step: 1, label: 'crab gravity' },
      { path: 'crabPhysics.supportRise', min: 1, max: 30, step: 0.5, label: 'climb-on speed' },
      { path: 'crabPhysics.supportSpan', min: 0.3, max: 1.5, step: 0.05, label: 'how far over another to be held up' },
      { path: 'crabPhysics.depthContact', min: 0, max: 1.5, step: 0.05, label: 'depth within which crabs collide' },
      { path: 'crabPhysics.corpseStackHeight', min: 0.1, max: 1.2, step: 0.05, label: 'how high a crab rides the corpse' },
      { path: 'enemies.walkingCrab.depthSpread', min: 0, max: 3, step: 0.05, label: 'crab depth spread (x radius)' },
      // Size variation is a COLUMN now (scaleVariance in enemies.csv), because
      // the turtle wanted a wide one and the question "how much do these vary"
      // is one you answer by reading down a column. A slider here would be one
      // of the dead ones described above the Boats group: applyEnemyTable puts
      // the table's value back at the next boot, Reset or CSV save.
      { path: 'enemies.walkingCrab.restLean', min: 0, max: 0.6, step: 0.02, label: 'crab rest lean (+/- rad)' },
      { path: 'enemies.walkingCrab.restYaw', min: 0, max: 1, step: 0.02, label: 'crab turn off-camera (+/- rad)' },
      // --- hoovering the chum ---
      // --- the pile-on ---
    ],
  },
  {
    group: 'Animation',
    section: 'Creature rigging',
    items: [
      { path: 'animation.enabled', type: 'bool', label: 'creature animation' },
      { path: 'animation.moveThreshold', min: 0, max: 10, step: 0.1, label: 'idle -> swim speed' },
      { path: 'animation.boostThreshold', min: 1, max: 40, step: 0.5, label: 'swim -> boost speed' },
      { path: 'animation.crossfade', min: 0, max: 1, step: 0.01, label: 'blend time' },
      // Idle tempo comes from the music (see beatsPerLoop on
      // CONFIG.animation.states), so the two 'idle speed' sliders below only
      // bite once these are set back to 0.
      { path: 'animation.states.idle.beatsPerLoop', min: 0, max: 16, step: 1, label: 'beats per idle loop (0 = off)' },
      { path: 'animation.states.surfaceIdle.beatsPerLoop', min: 0, max: 16, step: 1, label: 'beats per surface idle loop' },
      { path: 'animation.states.idle.clipTimeScale', min: 0.05, max: 3, step: 0.05, label: 'idle speed' },
      { path: 'animation.states.swim.clipTimeScale', min: 0.05, max: 3, step: 0.05, label: 'swim speed' },
      { path: 'animation.states.boost.clipTimeScale', min: 0.05, max: 4, step: 0.05, label: 'boost speed' },
      { path: 'animation.states.surfaceIdle.clipTimeScale', min: 0.05, max: 3, step: 0.05, label: 'surface idle speed' },
      { path: 'animation.states.surfaceMove.clipTimeScale', min: 0.05, max: 3, step: 0.05, label: 'surface move speed' },
      // Procedural fallback (models with no matching clip) — see the wagSpeed/
      // wagAmplitude note on CONFIG.animation.states.
      { path: 'animation.states.idle.wagAmplitude', min: 0, max: 1, step: 0.02, label: 'idle wag amount' },
      { path: 'animation.states.swim.wagSpeed', min: 0, max: 15, step: 0.2, label: 'swim wag speed' },
      { path: 'animation.states.swim.wagAmplitude', min: 0, max: 1, step: 0.02, label: 'swim wag amount' },
      { path: 'animation.states.boost.wagSpeed', min: 0, max: 20, step: 0.2, label: 'boost wag speed' },
      { path: 'animation.states.boost.wagAmplitude', min: 0, max: 1, step: 0.02, label: 'boost wag amount' },
      { path: 'animation.states.strike.maxDuration', min: 0.05, max: 4, step: 0.05, label: 'strike anim length' },
      { path: 'animation.states.hit.maxDuration', min: 0.05, max: 4, step: 0.05, label: 'hit anim length' },
      { path: 'animation.states.bark.maxDuration', min: 0.05, max: 4, step: 0.05, label: 'bark anim length' },
      { path: 'animation.oneShots.strike', type: 'bool', label: 'play strike anim' },
      { path: 'animation.oneShots.hit', type: 'bool', label: 'play hit anim' },
      { path: 'animation.oneShots.bark', type: 'bool', label: 'play bark on surfacing' },
      { path: 'animation.oneShots.death', type: 'bool', label: 'play death anim' },
      { path: 'animation.hit.amplitude', min: 0, max: 2, step: 0.02, label: 'flinch amount' },
      { path: 'animation.hit.duration', min: 0.05, max: 1.5, step: 0.05, label: 'flinch duration' },
    ],
  },
  {
    group: 'Fins',
    section: 'Creature rigging',
    items: [
      { path: 'fins.enabled', type: 'bool', label: 'fin controls' },
      { path: 'fins.ik', type: 'bool', label: 'aim fins at cursor' },
      { path: 'fins.weight', min: 0, max: 1, step: 0.02, label: 'aim override (firing)' },
      { path: 'fins.idleWeight', min: 0, max: 1, step: 0.02, label: 'aim override (idle)' },
      { path: 'fins.weightLerp', min: 1, max: 30, step: 0.5, label: 'override ease' },
      { path: 'fins.smoothing', min: 1, max: 60, step: 1, label: 'aim tracking speed' },
      { path: 'fins.maxBend', min: 0, max: 3.14, step: 0.02, label: 'max bend per bone' },
      { path: 'fins.softness', min: 0.05, max: 1, step: 0.05, label: 'bend limit softness' },
      // The anti-pinch stops. Both sliders top out where the skin over the
      // joint starts to close (npm run test:rig measures it), so turning them
      // DOWN is always safe and there is no setting that pinches the seal.
      { path: 'fins.maxFold', min: 0.3, max: 1.6, step: 0.02, label: 'joint fold limit' },
      { path: 'fins.maxTwist', min: 0, max: 0.8, step: 0.02, label: 'joint twist limit' },
      { path: 'fins.rootInfluence', min: 0, max: 1, step: 0.02, label: 'upper-arm share' },
      { path: 'fins.reach', min: 1, max: 8, step: 0.1, label: 'aim target distance' },
      { path: 'fins.iterations', min: 1, max: 12, step: 1, label: 'IK passes' },
      { path: 'fins.releaseOnOneShot', type: 'bool', label: 'let one-shots own the fins' },
      { path: 'fins.tipLengthMul', min: 0, max: 3, step: 0.05, label: 'aim target along flipper' },
    ],
  },
  {
    group: 'Emit points',
    section: 'Creature rigging',
    items: [
      { path: 'fins.muzzle', type: 'bool', label: 'fire from bone points' },
      { path: 'emitPoints.bullet', options: ['fins', 'mouth', 'tail', 'body'], label: 'basic shot' },
      { path: 'emitPoints.missile', options: ['fins', 'mouth', 'tail', 'body'], label: 'missiles' },
      { path: 'emitPoints.bounce', options: ['fins', 'mouth', 'tail', 'body'], label: 'bounce shot' },
      { path: 'emitPoints.starfish', options: ['fins', 'mouth', 'tail', 'body'], label: 'starfish' },
      { path: 'fins.muzzleLengthMul', min: 0, max: 2, step: 0.05, label: 'muzzle along flipper (1 = the edge)' },
      { path: 'fins.muzzleNudge', min: 0, max: 2, step: 0.05, label: 'forward offset past it' },
      { path: 'fins.flattenZ', type: 'bool', label: 'emit in body plane' },
      { path: 'fins.alternate', type: 'bool', label: 'alternate fins per volley' },
    ],
  },
  {
    group: 'Creature spring',
    section: 'Creature rigging',
    items: [
      { path: 'animation.spring.enabled', type: 'bool', label: 'body spring + hit impulse' },
      { path: 'animation.spring.weight', min: 0, max: 1, step: 0.02, label: 'lag strength' },
      { path: 'animation.spring.stiffness', min: 5, max: 400, step: 5, label: 'spring stiffness' },
      { path: 'animation.spring.damping', min: 1, max: 40, step: 0.5, label: 'damping (higher = less wobble)' },
      { path: 'animation.spring.tipLooseness', min: 0, max: 0.95, step: 0.02, label: 'tail end looser' },
      { path: 'animation.spring.maxLag', min: 0, max: 1.5, step: 0.02, label: 'max lag per bone' },
      { path: 'animation.spring.softness', min: 0.05, max: 1, step: 0.05, label: 'lag limit softness' },
      { path: 'animation.spring.impulsePerDamage', min: 0, max: 3, step: 0.05, label: 'hit impulse per damage' },
      { path: 'animation.spring.impulseMax', min: 0, max: 60, step: 1, label: 'hit impulse cap' },
      { path: 'animation.spring.impulseTipBias', min: 0, max: 1, step: 0.02, label: 'impulse toward tail' },
      { path: 'animation.spring.roleLooseness.fin', min: 0.1, max: 2, step: 0.05, label: 'fin looseness (vs tail)' },
      // Shark cruise — see the `lateral` block on enemies.shark. On the base
      // shark only; the rest of the family carries its own copy, which is the
      // same arrangement every other per-creature block here uses.
    ],
  },
  {
    group: 'Tail',
    section: 'Creature rigging',
    items: [
      { path: 'tail.enabled', type: 'bool', label: 'tail spring lag' },
      { path: 'tail.weight', min: 0, max: 1, step: 0.02, label: 'lag strength' },
      { path: 'tail.stiffness', min: 5, max: 400, step: 5, label: 'spring stiffness' },
      { path: 'tail.damping', min: 1, max: 40, step: 0.5, label: 'damping (higher = less wobble)' },
      { path: 'tail.tipLooseness', min: 0, max: 0.95, step: 0.02, label: 'tip looser than base' },
      { path: 'tail.maxLag', min: 0, max: 1.5, step: 0.02, label: 'max lag per bone' },
      { path: 'tail.softness', min: 0.05, max: 1, step: 0.05, label: 'lag limit softness' },
      { path: 'tail.weightLerp', min: 1, max: 30, step: 0.5, label: 'lag ease' },
      { path: 'tail.releaseOnOneShot', type: 'bool', label: 'let one-shots own the tail' },
    ],
  },
  {
    group: 'Head aim',
    section: 'Creature rigging',
    items: [
      { path: 'head.enabled', type: 'bool', label: 'head follows aim' },
      { path: 'head.weight', min: 0, max: 1, step: 0.02, label: 'look strength (firing)' },
      { path: 'head.idleWeight', min: 0, max: 1, step: 0.02, label: 'look strength (idle)' },
      { path: 'head.weightLerp', min: 1, max: 30, step: 0.5, label: 'look ease' },
      { path: 'head.smoothing', min: 1, max: 40, step: 0.5, label: 'look tracking speed' },
      { path: 'head.maxBend', min: 0, max: 1.2, step: 0.02, label: 'max bend per neck bone' },
      { path: 'head.softness', min: 0.05, max: 1, step: 0.05, label: 'bend limit softness' },
      { path: 'head.maxFold', min: 0.3, max: 1.5, step: 0.02, label: 'neck fold limit' },
      { path: 'head.maxTwist', min: 0, max: 0.6, step: 0.02, label: 'neck twist limit' },
      { path: 'head.frontCone', min: 0, max: 3.14, step: 0.02, label: 'start giving up past' },
      { path: 'head.backCone', min: 0, max: 3.14, step: 0.02, label: 'fully given up past' },
      { path: 'head.cameraBias', min: 0, max: 1, step: 0.02, label: 'peek to camera (blend)' },
      { path: 'head.peekKeepY', min: 0, max: 1, step: 0.02, label: 'peek: keep target height' },
      { path: 'head.glanceWeight', min: 0, max: 1, step: 0.02, label: 'glance strength' },
      { path: 'head.craneAngle', min: 0, max: 1.6, step: 0.02, label: 'body crane toward camera' },
      { path: 'head.craneLerp', min: 0.5, max: 20, step: 0.5, label: 'body crane speed' },
      { path: 'head.rootInfluence', min: 0, max: 1, step: 0.02, label: 'neck base share' },
      { path: 'head.reach', min: 1, max: 8, step: 0.1, label: 'look target distance' },
      { path: 'head.iterations', min: 1, max: 8, step: 1, label: 'IK passes' },
      { path: 'head.releaseOnOneShot', type: 'bool', label: 'let one-shots own the head' },
    ],
  },
  {
    group: 'Enemy head-look',
    panel: 'enemies',
    section: 'Look & motion',
    items: [
      { path: 'enemyLook.enabled', type: 'bool', label: 'hunters look at their target' },
      { path: 'enemyLook.weight', min: 0, max: 1, step: 0.02, label: 'look strength' },
      // Capped at 0.5 rad rather than the seal's 1.2. Most of these chains are
      // spine bones, so this is the joint-breaking limit — reach for `look
      // strength` first if the gesture is too subtle.
      { path: 'enemyLook.maxBend', min: 0, max: 0.5, step: 0.01, label: 'max bend per bone' },
      { path: 'enemyLook.softness', min: 0.05, max: 1, step: 0.05, label: 'bend limit softness' },
      { path: 'enemyLook.weightLerp', min: 0.5, max: 20, step: 0.5, label: 'look ease' },
      { path: 'enemyLook.smoothing', min: 1, max: 40, step: 0.5, label: 'look tracking speed' },
      { path: 'enemyLook.rootInfluence', min: 0, max: 1, step: 0.02, label: 'chain base share' },
      { path: 'enemyLook.frontCone', min: 0, max: 3.14, step: 0.02, label: 'start giving up past' },
      { path: 'enemyLook.backCone', min: 0, max: 3.14, step: 0.02, label: 'fully given up past' },
      { path: 'enemyLook.fadeRange', min: 0, max: 60, step: 1, label: 'look fades out from' },
      { path: 'enemyLook.maxRange', min: 0, max: 90, step: 1, label: 'look gone by' },
      { path: 'enemyLook.iterations', min: 1, max: 6, step: 1, label: 'IK passes' },
    ],
  },
  {
    group: 'Glow source',
    section: 'Look & FX',
    items: [
      // The A/B. OFF is the existing look — glow floods the whole body and
      // bloom haloes the silhouette. ON routes it through each creature's
      // emissive mask so only the bright markings light up. Assets with no
      // mask in public/textures/emissive are unaffected either way.
      { path: 'glow.emissiveMaps', type: 'bool', label: 'glow from emissive masks' },
      { path: 'glow.maskIntensity', min: 0, max: 4, step: 0.05, label: 'masked glow strength' },
    ],
  },
  {
    group: 'Seal outline',
    section: 'Look & FX',
    items: [
      { path: 'playerOutline.enabled', type: 'bool', label: 'outline the seal' },
      { path: 'playerOutline.color', type: 'color', label: 'outline colour' },
      { path: 'playerOutline.thickness', min: 0, max: 0.6, step: 0.005, label: 'outline thickness' },
      // Past ~1 the rim starts blooming; how much halo you actually get also
      // depends on the Glow group's threshold and amount.
      { path: 'playerOutline.glow', min: 0, max: 8, step: 0.1, label: 'outline glow' },
      { path: 'playerOutline.opacity', min: 0, max: 1, step: 0.05, label: 'outline opacity' },
      // The damage flash. Sat next to the base rim rather than in Feel because
      // it is read against the colour two rows up — a hit colour is only ever
      // "red enough" relative to whatever the rim already is.
      { path: 'playerOutline.hit.enabled', type: 'bool', label: 'flash on damage' },
      { path: 'playerOutline.hit.color', type: 'color', label: 'damage colour' },
      { path: 'playerOutline.hit.time', min: 0.05, max: 1.5, step: 0.01, label: 'damage flash time' },
      { path: 'playerOutline.hit.minTime', min: 0.05, max: 1.5, step: 0.01, label: '...on a graze' },
      { path: 'playerOutline.hit.glowAdd', min: 0, max: 12, step: 0.1, label: 'damage flash glow' },
      { path: 'playerOutline.hit.thicknessAdd', min: 0, max: 0.4, step: 0.005, label: 'damage flash width' },
    ],
  },
  {
    group: 'Creature outlines',
    // Lives in the Look & Sound panel with the rest of the per-creature look
    // controls, not in the ` tuner — it's the same question as tint and glow.
    panel: 'enemies',
    section: 'Look & motion',
    items: [
      { path: 'creatureOutline.color', type: 'color', label: 'outline colour' },
      { path: 'creatureOutline.thickness', min: 0, max: 0.6, step: 0.005, label: 'outline thickness' },
      { path: 'creatureOutline.glow', min: 0, max: 8, step: 0.1, label: 'outline glow' },
      { path: 'creatureOutline.opacity', min: 0, max: 1, step: 0.05, label: 'outline opacity' },
      // One switch per species. Built from the config block rather than typed
      // out, so adding a creature to `creatureOutline.on` gives it a row here
      // for free — and the two can't drift apart, which is exactly how a
      // toggle ends up in the menu for something that was never wired up.
      // Labels drop the `enemy` prefix the asset keys carry.
      ...Object.keys(CONFIG.creatureOutline.on).map((key) => ({
        path: `creatureOutline.on.${key}`,
        type: 'bool',
        label: key.replace(/^enemy/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
      })),
    ],
  },
  {
    group: 'Seal surface noise',
    section: 'Look & FX',
    items: [
      { path: 'sealShader.enabled', type: 'bool', label: 'procedural noise on the seal' },
      // World units per blob — the headline control. Range runs from finer
      // than the fur reads at this camera distance up to patches the size of
      // the whole animal.
      { path: 'sealShader.size', min: 0.02, max: 3, step: 0.01, label: 'noise size' },
      { path: 'sealShader.strength', min: 0, max: 1, step: 0.01, label: 'noise strength' },
      { path: 'sealShader.contrast', min: 0.1, max: 4, step: 0.05, label: 'noise contrast' },
      { path: 'sealShader.color', type: 'color', label: 'noise colour' },
    ],
  },
  // One group per glowing species, plus the shared base they all fall through
  // to — GENERATED, because the alternative is fourteen near-identical rows
  // written out per preset and a fifth species quietly getting only nine of
  // them. `biolumSkinItems` is the single definition of what a glow HAS; the
  // groups below only decide whose copy you are looking at.
  ...biolumSkinGroups(),
  {
    group: 'Grass sway',
    section: 'The ocean',
    items: [
      { path: 'grass.sway.enabled', type: 'bool', label: 'grass bends in the current' },
      // Fraction of blade height the tip travels — the headline control. The
      // top of the range is deliberately past the point where blades start
      // sliding through each other, so the limit is visible rather than
      // guessed at.
      { path: 'grass.sway.amplitude', min: 0, max: 0.4, step: 0.005, label: 'sway distance (of height)' },
      { path: 'grass.sway.stiffness', min: 1, max: 5, step: 0.1, label: 'stiffness (1 = hinges at root)' },
      { path: 'grass.sway.speedSync', type: 'choice', options: BEAT_DIVISIONS, label: 'sway — one per' },
      { path: 'grass.sway.speed', min: 0, max: 4, step: 0.05, label: '…or free-running, rad/s' },
      { path: 'grass.sway.wavelength', min: 0, max: 2, step: 0.01, label: 'gust spread (0 = all in unison)' },
      { path: 'grass.sway.direction', min: 0, max: 6.28, step: 0.05, label: 'current direction (rad)' },
      { path: 'grass.sway.flutter', min: 0, max: 0.15, step: 0.005, label: 'tip flutter' },
      { path: 'grass.sway.flutterSync', type: 'choice', options: BEAT_DIVISIONS, label: 'flutter — one per' },
      { path: 'grass.sway.flutterSpeed', min: 0, max: 12, step: 0.1, label: '…or free-running, rad/s' },
      { type: 'readout', label: 'timing', lines: () => fxTimingReadout([
        ['sway', 'grass.sway.speedSync', () => (Math.PI * 2) / Math.max(0.01, CONFIG.grass?.sway?.speed ?? 1.1)],
        ['flutter', 'grass.sway.flutterSync', () => (Math.PI * 2) / Math.max(0.01, CONFIG.grass?.sway?.flutterSpeed ?? 3.7)],
      ]) },
      { path: 'grass.sway.bend', min: 0, max: 1, step: 0.05, label: 'keep blade length (0 = stretches)' },
    ],
  },
  {
    group: 'Bubbles',
    section: 'Look & FX',
    items: [
      { path: 'bubbles.enabled', type: 'bool', label: 'bubbles' },
      { path: 'bubbles.breath.enabled', type: 'bool', label: 'mouth breath puffs' },
      { path: 'bubbles.breath.scale', min: 0.1, max: 3, step: 0.05, label: 'breath size' },
      { path: 'bubbles.breath.speedScale', min: 0, max: 2, step: 0.05, label: 'breath harder when fast' },
      { path: 'emitters.breathBubbles.count', min: 1, max: 24, step: 1, label: 'breath count' },
      { path: 'emitters.breathBubbles.glow', min: 0, max: 6, step: 0.1, label: 'breath glow' },
      { path: 'bubbles.wake.enabled', type: 'bool', label: 'tail wake' },
      { path: 'bubbles.wake.minSpeed', min: 0, max: 20, step: 0.5, label: 'wake min speed' },
      { path: 'bubbles.wake.perSecond', min: 1, max: 80, step: 1, label: 'wake rate at top speed' },
      { path: 'bubbles.wake.scale', min: 0.1, max: 3, step: 0.05, label: 'wake size' },
      { path: 'bubbles.wake.tailShare', min: 0, max: 1, step: 0.05, label: 'wake: share off the tail (rest = flipper tips)' },
      { path: 'bubbles.wake.tipBias', min: 0, max: 8, step: 0.25, label: 'wake: crowd tail bubbles to the tip' },
      { path: 'emitters.wakeBubbles.cone', min: 0, max: 1.6, step: 0.02, label: 'wake cone' },
      { path: 'emitters.wakeBubbles.count', min: 1, max: 16, step: 1, label: 'wake count' },
      { path: 'emitters.wakeBubbles.glow', min: 0, max: 6, step: 0.1, label: 'wake glow' },
      { path: 'bubbles.charge.enabled', type: 'bool', label: 'wind-up vents bubbles' },
      { path: 'bubbles.charge.perSecondMin', min: 0, max: 60, step: 1, label: 'wind-up: bubble rate at start' },
      { path: 'bubbles.charge.perSecondMax', min: 1, max: 160, step: 1, label: 'wind-up: bubble rate at full' },
      { path: 'bubbles.charge.scaleMin', min: 0.1, max: 3, step: 0.05, label: 'wind-up: bubble size at start' },
      { path: 'bubbles.charge.scaleMax', min: 0.1, max: 4, step: 0.05, label: 'wind-up: bubble size at full' },
    ],
  },
  {
    group: 'Facing',
    section: 'Gameplay',
    items: [
      { path: 'player.faceMode', options: ['velocity', 'aim'], label: 'seal faces' },
      { path: 'player.turnLerp', min: 0.5, max: 30, step: 0.5, label: 'turn smoothing (lower = smoother)' },
      { path: 'player.minSpeedToTurn', min: 0, max: 6, step: 0.1, label: 'min speed to re-aim' },
      { path: 'player.turnAroundEnabled', type: 'bool', label: 'roll over when reversing' },
      { path: 'player.turnAroundDuration', min: 0.1, max: 1.5, step: 0.02, label: 'turnaround roll length' },
      { path: 'player.turnAroundDashDuration', min: 0.02, max: 0.6, step: 0.01, label: 'turnaround roll length (dashing)' },
    ],
  },
  {
    // The world above the water line. All three are judged by eye off a single
    // breach, which is why they're on sliders rather than in a table — but note
    // that gravity is the one number here with a RIGHT answer: 29.7 u/s^2 is
    // 9.81 m/s^2 at this game's scale (see CONFIG.arena.gravity). Drag it and
    // you are choosing a look over the physics, which is a fine thing to do
    // knowingly and a confusing one to do by accident.
    group: 'Gravity',
    section: 'Gameplay',
    items: [
      { path: 'arena.gravity', min: 0, max: 80, step: 0.1, label: 'gravity (29.7 = real)' },
      { path: 'arena.airDrag', min: 0.98, max: 1, step: 0.0005, label: 'air drag (1 = none)' },
      { path: 'arena.projectileGravity', min: 0, max: 1, step: 0.05, label: 'how much shots feel it' },
    ],
  },
  {
    group: 'Strike indicator',
    panel: 'companions',
    section: 'Strike & movement',
    items: [
      // --- where the instrument sits ---
      { path: 'strike.ring.radius', min: 0.5, max: 8, step: 0.05, label: 'ring radius' },
      { path: 'strike.ring.scale', min: 0.2, max: 3, step: 0.01, label: 'ring scale (x radius)' },
      { path: 'strike.ring.offsetX', min: -8, max: 8, step: 0.05, label: 'offset from seal: x' },
      { path: 'strike.ring.offsetY', min: -8, max: 8, step: 0.05, label: 'offset from seal: y' },
      { path: 'strike.ring.thickness', min: 0.02, max: 0.6, step: 0.01 },
      { path: 'strike.ring.segmentGap', min: 0, max: 0.6, step: 0.01, label: 'gap between pips' },
      // --- colour ---
      { path: 'strike.ring.color', type: 'color', label: 'charging colour' },
      { path: 'strike.ring.readyColor', type: 'color', label: 'fully-charged colour' },
      { path: 'strike.ring.lastPipColor', type: 'color', label: 'last pip colour' },
      { path: 'strike.ring.comboColor', type: 'color', label: 'combo colour' },
      { path: 'strike.ring.glow', min: 0, max: 8, step: 0.1 },
      { path: 'strike.ring.pulseSpeed', min: 0, max: 30, step: 0.5, label: 'combo pulse speed' },
      // --- the banked-power arc, inside. innerRadiusMul is a BLOOM number:
      // below about 0.7 the two bands fuse into one at the shipped bloom
      // settings. See systems/strikeRing.js.
      { path: 'strike.ring.innerRadiusMul', min: 0.2, max: 0.95, step: 0.01, label: 'banked arc: radius (x outer)' },
      { path: 'strike.ring.innerThicknessMul', min: 0.2, max: 2, step: 0.05, label: 'banked arc: thickness (x)' },
      { path: 'strike.ring.innerGlowMul', min: 0, max: 2, step: 0.05, label: 'banked arc: brightness (x)' },
      { path: 'strike.ring.chainRadiusMul', min: 1, max: 1.6, step: 0.01, label: 'chain-window arc: radius (x)' },
      // --- how the needle moves ---
      { path: 'strike.ring.springStiffness', min: 20, max: 600, step: 5, label: 'needle: spring stiffness' },
      { path: 'strike.ring.springDamping', min: 2, max: 60, step: 0.5, label: 'needle: damping (lower = bouncier)' },
      { path: 'strike.ring.bounceGlow', min: 0, max: 20, step: 0.5, label: 'needle: bounce flare' },
      // --- the pips plopping up ---
      { path: 'strike.ring.pipStagger', min: 0, max: 0.4, step: 0.005, label: 'pip plop: gap between pips (s)' },
      { path: 'strike.ring.pipStiffness', min: 40, max: 900, step: 10, label: 'pip plop: spring' },
      { path: 'strike.ring.pipDamping', min: 2, max: 60, step: 0.5, label: 'pip plop: damping (lower = bouncier)' },
      { path: 'strike.ring.popSwell', min: 0, max: 3, step: 0.05, label: 'pip plop: band swell' },
      { path: 'strike.ring.popGlow', min: 0, max: 10, step: 0.1, label: 'pip plop: flare' },
      { path: 'strike.ring.popDecay', min: 0.5, max: 20, step: 0.25, label: 'pip plop: flare fade speed' },
      // --- pips ---
      { path: 'strike.charge.chainPipsPerLink', min: 0, max: 3, step: 1, label: 'pips added per chain link' },
      { path: 'strike.charge.maxPips', min: 3, max: 20, step: 1, label: 'max pips on the ring' },
      { path: 'strike.charge.pipGap', min: 0, max: 0.3, step: 0.005, label: 'min gap between pip ticks (s)' },
      // --- the seal's own read of the meter (systems/chargeSkin.js) ---
      { path: 'sealCharge.enabled', type: 'bool', label: 'seal glows with the meter' },
      { path: 'sealCharge.strength', min: 0, max: 4, step: 0.05, label: 'seal glow: strength at full' },
      { path: 'sealCharge.falloff', min: 0.5, max: 4, step: 0.05, label: 'seal glow: how dark empty reads' },
      { path: 'sealCharge.fullBoost', min: 1, max: 3, step: 0.05, label: 'seal glow: extra when full' },
      { path: 'sealCharge.pulseSpeed', min: 0, max: 8, step: 0.1, label: 'seal glow: breath while filling' },
      { path: 'sealCharge.pulseAmp', min: 0, max: 1, step: 0.02, label: 'seal glow: breath depth, filling' },
      { path: 'sealCharge.fullPulseSpeed', min: 0, max: 8, step: 0.1, label: 'seal glow: breath at full' },
      { path: 'sealCharge.fullPulseAmp', min: 0, max: 1, step: 0.02, label: 'seal glow: breath depth, full' },
      { path: 'sealCharge.wave.enabled', type: 'bool', label: 'seal glow: crossing flash' },
      { path: 'sealCharge.wave.duration', min: 0.1, max: 2, step: 0.05, label: 'crossing flash: nose to tail (s)' },
      { path: 'sealCharge.coverage', min: 0, max: 1, step: 0.02, label: 'seal glow: coverage' },
      { path: 'sealCharge.contrast', min: 0.2, max: 6, step: 0.1, label: 'seal glow: contrast' },
      { path: 'sealCharge.white', min: 0, max: 1, step: 0.02, label: 'seal glow: white core' },
      { path: 'strike.comboGridWarp', min: 0, max: 6, step: 0.1, label: 'combo grid warp' },
      { path: 'strike.comboGridWarpMax', min: 0, max: 20, step: 0.5, label: 'combo grid warp cap' },
    ],
  },
  {
    group: 'HUD',
    section: 'Interface & controls',
    items: [
      { path: 'hud.playerBarOffset', min: 0, max: 8, step: 0.1, label: 'bar height above seal' },
    ],
  },
  {
    group: 'Seal Team',
    panel: 'companions',
    section: 'Escorts',
    items: [
      // No skin rows: the escorts wear the player's own procedural mottling,
      // so their look is tuned in the Seal shader group and nowhere else.
      { path: 'sealTeam.orbitRadius', min: 0.5, max: 10, step: 0.1, label: 'orbit radius' },
      { path: 'sealTeam.orbitSpeed', min: 0, max: 5, step: 0.05, label: 'orbit speed' },
      { path: 'sealTeam.orbitDepth', min: 0, max: 6, step: 0.1, label: 'orbit depth (3D)' },
      { path: 'sealTeam.offsetX', min: -10, max: 10, step: 0.1, label: 'offset X' },
      { path: 'sealTeam.offsetY', min: -10, max: 10, step: 0.1, label: 'offset Y' },
      { path: 'sealTeam.offsetZ', min: -10, max: 10, step: 0.1, label: 'offset Z (depth)' },
      { path: 'sealTeam.followSpring', min: 1, max: 60, step: 1, label: 'follow spring' },
      { path: 'sealTeam.followDamping', min: 0.5, max: 20, step: 0.5, label: 'follow damping' },
      { path: 'sealTeam.bobAmount', min: 0, max: 2, step: 0.05, label: 'bob' },
      { path: 'sealTeam.lunge.enabled', type: 'bool', label: 'lunge at enemies' },
      { path: 'sealTeam.lunge.range', min: 1, max: 25, step: 0.5, label: 'lunge range' },
      { path: 'sealTeam.lunge.speed', min: 5, max: 60, step: 1, label: 'lunge speed' },
      { path: 'sealTeam.lunge.maxDuration', min: 0.1, max: 3, step: 0.05, label: 'lunge give-up time' },
      { path: 'sealTeam.lunge.cooldown', min: 0, max: 8, step: 0.1, label: 'lunge rest (per seal)' },
      { path: 'sealTeam.lunge.teamCooldown', min: 0, max: 4, step: 0.05, label: 'gap between lunges (squad)' },
      { path: 'sealTeam.lunge.standoff', min: 0, max: 3, step: 0.05, label: 'lunge stop-short distance' },
      { path: 'sealTeam.evolved.speedMul', min: 0.2, max: 2, step: 0.05, label: 'evolved shot speed x player' },
    ],
  },
  {
    // The two settings every beat-synced effect shares. The pickers
    // themselves live beside the effects they drive — that is deliberate:
    // "what division is the lanternfish's breath on" is a question about the
    // lanternfish, and burying twelve pickers in one panel would mean
    // auditioning a fish by scrolling away from it.
    group: 'Beat sync',
    section: 'Audio',
    items: [
      { path: 'beatSync.enabled', type: 'bool', label: 'quantise shader FX to the beat' },
      { path: 'beatSync.beatsPerBar', min: 2, max: 12, step: 1, label: 'beats per bar' },
      { type: 'readout', label: 'grid', lines: () => beatGridReadout() },
    ],
  },
  {
    group: 'Music',
    section: 'Audio',
    items: [
      { path: 'music.enabled', type: 'bool', label: 'music' },
      { path: 'music.bpm', min: 40, max: 220, step: 1 },
      { path: 'music.beatsPerLoop', min: 4, max: 128, step: 4, label: 'beats per loop' },
      { path: 'music.volume', min: 0, max: 1, step: 0.02 },
      { path: 'music.playbackRate', min: 0.5, max: 2, step: 0.01 },
      { path: 'music.levelsPerSlot', min: 1, max: 20, step: 1, label: 'levels per loop' },
      { path: 'music.surfaceHz', min: 2000, max: 20000, step: 100, label: 'filter above water' },
      { path: 'music.deepHz', min: 200, max: 20000, step: 100, label: 'filter at seabed' },
      { path: 'music.depthSmoothing', min: 0.01, max: 1.5, step: 0.01, label: 'depth glide time' },
      { path: 'music.duckedHz', min: 80, max: 4000, step: 20, label: 'upgrade screen cutoff' },
      { path: 'music.duckTime', min: 0.05, max: 3, step: 0.05, label: 'sweep-down time' },
      { path: 'music.sweepTime', min: 0.05, max: 4, step: 0.05, label: 'sweep-up time' },
      { path: 'music.resonance', min: 0.1, max: 12, step: 0.1, label: 'filter resonance' },
    ],
  },
  {
    group: 'Typography',
    section: 'Interface & controls',
    items: [
      { path: 'typography.scale', min: 0.6, max: 2.2, step: 0.05, label: 'text size' },
      { path: 'typography.weight', min: 300, max: 900, step: 100 },
      { path: 'typography.letterSpacing', min: -0.05, max: 0.3, step: 0.01 },
      { path: 'typography.color', type: 'color' },
      { path: 'typography.family', options: [
        "'Inter', system-ui, sans-serif",
        "'Courier New', monospace",
        "Georgia, 'Times New Roman', serif",
        "'Trebuchet MS', sans-serif",
        "Impact, sans-serif",
      ] },
      { path: 'typography.retro', type: 'bool', label: 'retro shader on text' },
      { path: 'typography.retroScanlineOpacity', min: 0, max: 1, step: 0.02 },
      { path: 'typography.retroChromaShift', min: 0, max: 4, step: 0.1 },
      { path: 'typography.retroFlicker', min: 0, max: 0.4, step: 0.01 },
      { path: 'typography.retroGlow', min: 0, max: 3, step: 0.1 },
    ],
  },
  // 'Spawn rates' and 'Spawn level gates' USED TO BE HERE — fifty generated
  // sliders, one per creature, for `spawnRateMul` and `minPlayerLevel`.
  //
  // Both are columns in enemies.csv, and applyEnemyTable() runs at boot, on
  // Reset and whenever the CSV changes. So every one of those sliders moved a
  // number the table then silently put back: dragging shark's rate to 0.123
  // and re-applying the table returned it to 1. Fifty controls that looked
  // live and were not. They are edited in the Creatures table, which is the
  // only place that can actually hold them.
  {
    group: 'Boats & trawlers',
    panel: 'enemies',
    section: 'Boats',
    items: [
      { path: 'boats.enabled', type: 'bool', label: 'boats' },
      { path: 'boats.spawnMin', min: 2, max: 60, step: 1 },
      { path: 'boats.spawnMax', min: 2, max: 90, step: 1 },
      { path: 'boats.maxAlive', min: 1, max: 8, step: 1 },
      { path: 'boats.speed', min: 0.5, max: 12, step: 0.1 },
      { path: 'boats.hp', min: 5, max: 400, step: 5 },
      { path: 'boats.radius', min: 0.5, max: 5, step: 0.1 },
      { path: 'boats.hitReaction.maxRoll', min: 0.1, max: 1.6, step: 0.05, label: 'roll limit while afloat (no capsize)' },
      { path: 'boats.hitReaction.strike.damageMul', min: 0, max: 3, step: 0.05, label: 'ram: damage vs hulls (x strike damage)' },
      { path: 'boats.trawlerChance', min: 0, max: 1, step: 0.05, label: 'trawler chance' },
      { path: 'boats.trawlerHpMul', min: 1, max: 5, step: 0.1, label: 'trawler hp mult' },
      { path: 'boats.chumMin', min: 1, max: 60, step: 1, label: 'chum dropped (min)' },
      { path: 'boats.chumMax', min: 1, max: 90, step: 1, label: 'chum dropped (max)' },
      // The one that decides whether a boat is a reward or a level-up. Read
      // it next to the level costs: reaching level 7 takes 256 xp total.
      { path: 'boats.chumXp', min: 0, max: 6, step: 0.5, label: 'xp per chum bit' },
      { path: 'boats.trawlerChumMul', min: 1, max: 5, step: 0.1, label: 'trawler chum mult' },
      { path: 'boats.chumSpread', min: 0.5, max: 12, step: 0.1, label: 'chum scatter' },
      { path: 'attractorOrb.lifetime', min: 1, max: 30, step: 0.5, label: 'attractor duration' },
      { path: 'attractorOrb.pullStrength', min: 1, max: 100, step: 1, label: 'attractor pull' },
      { path: 'attractorOrb.riseSpeed', min: 0, max: 10, step: 0.1, label: 'attractor rise' },
      { path: 'attractorOrb.color', type: 'color', label: 'attractor colour' },
      { path: 'attractorOrb.glow', min: 0, max: 8, step: 0.1, label: 'attractor glow' },
    ],
  },

  // The rigid-body layer: the turtle and the hulls, which are the same body
  // with different numbers in it. Everything here is felt rather than read, so
  // the sliders matter more than usual — see systems/rigidBody.js.
  {
    group: 'Knocked around (turtle & hulls)',
    panel: 'enemies',
    section: 'Physics',
    items: [
      { path: 'physics.enabled', type: 'bool', label: 'bodies collide with each other' },
      { path: 'physics.restitution', min: 0, max: 1, step: 0.05, label: 'bounciness' },
      { path: 'physics.minImpactSpeed', min: 0, max: 20, step: 0.5, label: 'min speed to count as a hit' },
      { path: 'physics.boatVsBoat', type: 'bool', label: 'hulls can hit hulls (once shoved)' },
      { path: 'physics.blastMul', min: 0, max: 4, step: 0.1, label: 'wreck blast → bodies' },
      { path: 'physics.turtle.mass', min: 0.5, max: 20, step: 0.5, label: 'turtle: mass' },
      { path: 'physics.turtle.drag', min: 0, max: 4, step: 0.05, label: 'turtle: drag (how soon it stops)' },
      { path: 'physics.turtle.spin', min: 0, max: 8, step: 0.1, label: 'turtle: tumble per hit' },
      { path: 'physics.turtle.righting', min: 0, max: 40, step: 0.5, label: 'turtle: righting spring' },
      { path: 'physics.turtle.rightingDamping', min: 0, max: 20, step: 0.2, label: 'turtle: righting damping' },
      { path: 'physics.turtle.wallRestitution', min: 0, max: 1, step: 0.05, label: 'turtle: wall bounce' },
      { path: 'physics.turtle.strikeImpulse', min: 0, max: 90, step: 1, label: 'punt: how fast a strike fires it' },
      { path: 'physics.turtle.launchSpeed', min: 0, max: 20, step: 0.5, label: 'turtle: speed that counts as launched' },
      { path: 'physics.turtle.plow', min: 0, max: 2, step: 0.05, label: 'turtle: shove it hands a crowd' },
      // How long one visits for, and how fast it leaves. Here rather than with
      // the rest of the drift block because this is the number you reach for
      // when the ocean feels crowded with them, which is a physics-panel
      // feeling, not a steering one.
      { path: 'enemies.seaTurtle.drift.stay', min: 5, max: 180, step: 5, label: 'turtle: seconds before it leaves' },
      { path: 'enemies.seaTurtle.drift.stayJitter', min: 0, max: 60, step: 1, label: 'turtle: +/- on that' },
      { path: 'enemies.seaTurtle.drift.exitSpeed', min: 1, max: 8, step: 0.1, label: 'turtle: how fast it swims out (x speed)' },
      { path: 'physics.boat.mass', min: 1, max: 60, step: 1, label: 'hull: mass' },
      { path: 'physics.boat.trawlerMass', min: 1, max: 6, step: 0.1, label: 'hull: trawler mass mult' },
      { path: 'physics.boat.thrust', min: 0, max: 6, step: 0.05, label: 'hull: how fast it recovers course' },
      { path: 'physics.boat.buoyancy', min: 1, max: 90, step: 1, label: 'hull: buoyancy spring' },
      { path: 'physics.boat.buoyancyDamping', min: 0, max: 20, step: 0.2, label: 'hull: buoyancy damping' },
      { path: 'physics.boat.righting', min: 1, max: 90, step: 1, label: 'hull: righting spring' },
      { path: 'physics.boat.spin', min: 0, max: 10, step: 0.1, label: 'hull: roll per hit' },
      { path: 'physics.boat.strikeImpulse', min: 0, max: 400, step: 5, label: 'ram: hull shove' },
      { path: 'physics.boat.damageImpulse', min: 0, max: 6, step: 0.05, label: 'hull: recoil per damage' },
      { path: 'physics.impact.damagePerImpulse', min: 0, max: 3, step: 0.05, label: 'turtle→hull: damage per impulse' },
      { path: 'physics.impact.minSpeed', min: 0, max: 30, step: 0.5, label: 'turtle→hull: speed that starts hurting' },
      { path: 'physics.impact.maxDamage', min: 0, max: 300, step: 5, label: 'turtle→hull: damage cap' },
      { path: 'physics.turtle.massExp', min: 0, max: 3, step: 0.1, label: 'turtle: how much size adds mass' },
    ],
  },
  {
    group: 'Electric eel',
    panel: 'companions',
    section: 'Escorts',
    items: [
      { path: 'eel.boltColor', type: 'color', label: 'bolt colour' },
      { path: 'eel.boltGlow', min: 0, max: 10, step: 0.1, label: 'bolt glow' },
      { path: 'eel.glowWidth', min: 0.02, max: 1.5, step: 0.02, label: 'glow halo width' },
      { path: 'eel.glowOpacity', min: 0, max: 1, step: 0.02, label: 'glow halo opacity' },
      { path: 'eel.coreWidth', min: 0.01, max: 0.5, step: 0.01, label: 'core width' },
      { path: 'eel.boltLife', min: 0.05, max: 1.5, step: 0.01, label: 'bolt lifetime' },
      { path: 'eel.noiseAmplitude', min: 0, max: 3, step: 0.05, label: 'jaggedness' },
      { path: 'eel.noiseOctaves', min: 1, max: 5, step: 1, label: 'noise detail' },
      { path: 'eel.noiseContrast', min: 0.5, max: 5, step: 0.1, label: 'noise contrast' },
      { path: 'eel.noiseScrollSpeed', min: 0, max: 80, step: 1, label: 'noise churn' },
      { path: 'eel.segmentsPerHop', min: 3, max: 40, step: 1, label: 'spline segments' },
      { path: 'eel.branchChance', min: 0, max: 1, step: 0.05, label: 'branch chance' },
      { path: 'eel.branchesPerHop', min: 0, max: 5, step: 1, label: 'branches per hop' },
      { path: 'eel.branchLength', min: 0.1, max: 1.5, step: 0.05, label: 'branch length' },
      { path: 'eel.flickerSpeed', min: 0, max: 120, step: 1, label: 'flicker speed' },
      // Storm response. Every one of these is a MULTIPLIER reached at full
      // storm and folded in as 1 + (mul - 1) * intensity, so 1 means "weather
      // changes nothing about this" and the sliders above stay the clear-sky
      // truth. `damage in storm` is the only one that touches balance rather
      // than looks — left at 1 deliberately.
      { path: 'eel.storm.enabled', type: 'bool', label: 'storm response' },
      { path: 'eel.storm.glowMul', min: 1, max: 6, step: 0.1, label: 'storm: glow x' },
      { path: 'eel.storm.widthMul', min: 1, max: 5, step: 0.1, label: 'storm: width x' },
      { path: 'eel.storm.amplitudeMul', min: 1, max: 5, step: 0.1, label: 'storm: thrash x' },
      { path: 'eel.storm.contrastMul', min: 1, max: 3, step: 0.05, label: 'storm: spikiness x' },
      { path: 'eel.storm.branchChanceMul', min: 1, max: 4, step: 0.1, label: 'storm: fork chance x' },
      { path: 'eel.storm.branchesPerHopMul', min: 1, max: 4, step: 0.1, label: 'storm: forks per hop x' },
      { path: 'eel.storm.flickerMul', min: 1, max: 4, step: 0.1, label: 'storm: flicker x' },
      { path: 'eel.storm.lifeMul', min: 1, max: 3, step: 0.05, label: 'storm: bolt lifetime x' },
      { path: 'eel.storm.damageInStorm', min: 1, max: 3, step: 0.05, label: 'storm: damage x' },
      { path: 'eel.storm.color', type: 'color', label: 'storm: bolt tint' },
      { path: 'eel.storm.colorMix', min: 0, max: 1, step: 0.05, label: 'storm: tint strength' },
    ],
  },
  {
    group: 'Starfish',
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      { path: 'starfish.baseFireRate', min: 0.05, max: 2, step: 0.05 },
      { path: 'starfish.fireRatePerLevel', min: 0.5, max: 1, step: 0.01, label: 'fire rate mult per level' },
      { path: 'starfish.damage', min: 1, max: 50, step: 1 },
      { path: 'starfish.baseRadius', min: 0.05, max: 1, step: 0.02, label: 'base size' },
      { path: 'starfish.radiusPerLevel', min: 0, max: 0.3, step: 0.01, label: 'size growth per level' },
      { path: 'starfish.speed', min: 4, max: 50, step: 1 },
    ],
  },
  {
    group: 'Seagull bomb',
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      // fire rate, damage and splash are weapons.csv's.
      { path: 'seagullBomb.life', min: 3, max: 30, step: 0.5, label: 'run gives up after' },
      // --- approach ---
      { path: 'seagullBomb.cruiseAltitude', min: 1, max: 10, step: 0.25, label: 'cruise height above water' },
      { path: 'seagullBomb.cruiseSpeed', min: 3, max: 30, step: 0.5 },
      { path: 'seagullBomb.flapTime', min: 0.2, max: 4, step: 0.1, label: 'seconds flapping' },
      { path: 'seagullBomb.glideTime', min: 0.2, max: 4, step: 0.1, label: 'seconds gliding' },
      { path: 'seagullBomb.flapLift', min: 0, max: 12, step: 0.1, label: 'climb while flapping' },
      { path: 'seagullBomb.glideSink', min: 0, max: 12, step: 0.1, label: 'sink while gliding' },
      { path: 'seagullBomb.altitudeHold', min: 0, max: 8, step: 0.1, label: 'pull back to cruise height' },
      // --- target and dive ---
      { path: 'seagullBomb.clusterRadius', min: 1, max: 25, step: 0.5, label: 'crab pile radius' },
      { path: 'seagullBomb.minClusterSize', min: 1, max: 10, step: 1, label: 'min crabs to dive on' },
      { path: 'seagullBomb.diveZone', min: 0.5, max: 12, step: 0.1, label: 'overhead zone to commit' },
      { path: 'seagullBomb.diveAccel', min: 5, max: 100, step: 1 },
      { path: 'seagullBomb.diveSpeedMax', min: 5, max: 80, step: 1 },
      { path: 'seagullBomb.diveSteer', min: 0, max: 50, step: 1, label: 'steering while diving' },
      { path: 'seagullBomb.hitRadius', min: 0.1, max: 3, step: 0.05 },
      // Full 360 because the honest answer depends entirely on which frames the
      // dive clip is cut from, and 96 is only right for the current ones.
      { path: 'seagullBomb.divePitch', min: -180, max: 180, step: 1, label: 'cancel the stoop clip’s baked pitch (deg)' },
    ],
  },
  {
    group: 'Baby beluga',
    panel: 'companions',
    section: 'Escorts',
    items: [
      // 0 on the hold is the old behaviour — the bubble disappears on contact —
      // and the burst still fires, so this is a look control, not an on/off.
      { path: 'beluga.popFlicker', min: 0, max: 1, step: 0.01, label: 'caught: flicker for (s)' },
      { path: 'beluga.popFlickerHz', min: 2, max: 60, step: 1, label: 'caught: flicker rate (per s)' },
      { path: 'beluga.popSwell', min: 1, max: 3, step: 0.05, label: 'caught: swells to (x)' },
      { path: 'beluga.orbitRadius', min: 0.5, max: 5, step: 0.1 },
      { path: 'beluga.orbitDepth', min: 0, max: 6, step: 0.1, label: 'orbit depth (3D)' },
      { path: 'beluga.orbitSpeed', min: -4, max: 4, step: 0.1 },
      { path: 'beluga.followSpring', min: 2, max: 80, step: 1, label: 'follow springiness' },
      { path: 'beluga.followDamping', min: 0.5, max: 20, step: 0.5, label: 'follow damping' },
      { path: 'beluga.bobAmount', min: 0, max: 2, step: 0.05, label: 'swim bob' },
      { path: 'beluga.offsetX', min: -10, max: 10, step: 0.1, label: 'offset X' },
      { path: 'beluga.offsetY', min: -10, max: 10, step: 0.1, label: 'offset Y' },
      { path: 'beluga.offsetZ', min: -10, max: 10, step: 0.1, label: 'offset Z (depth)' },
    ],
  },
  {
    group: "Bakalar's boat",
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      { path: 'bakalar.enabled', type: 'bool', label: 'boat sails' },
      { path: 'bakalar.speed', min: 1, max: 30, step: 0.5, label: 'sail speed' },
      { path: 'bakalar.spawnMin', min: 2, max: 60, step: 1, label: 'seconds between sailings (min)' },
      { path: 'bakalar.spawnMax', min: 2, max: 90, step: 1, label: 'seconds between sailings (max)' },
      { path: 'bakalar.spawnFasterPerLevel', min: 0, max: 6, step: 0.1, label: 'sails sooner per level' },
      { path: 'bakalar.spawnMinFloor', min: 1, max: 30, step: 0.5, label: 'fastest allowed interval' },
      { path: 'bakalar.netWidth', min: 1, max: 30, step: 0.5, label: 'net width' },
      { path: 'bakalar.netWidthPerLevel', min: 0, max: 5, step: 0.1, label: 'net width per level' },
      { path: 'bakalar.netDepth', min: 1, max: 40, step: 0.5, label: 'net depth' },
      { path: 'bakalar.netDepthPerLevel', min: 0, max: 6, step: 0.1, label: 'net depth per level' },
      { path: 'bakalar.netTrail', min: 0, max: 10, step: 0.1, label: 'net drag behind hull' },
      { path: 'bakalar.netColor', type: 'color', label: 'beam color' },
      // --- beam (the look) ---
      // `edge falloff` is the one to reach for first: high reads as a
      // searchlight, low as a flat slab of colour.
      { path: 'bakalar.beam.intensity', min: 0, max: 5, step: 0.1, label: 'beam brightness' },
      { path: 'bakalar.beam.topWidth', min: 0.05, max: 1, step: 0.05, label: 'width at the hull (cone)' },
      { path: 'bakalar.beam.edgeFalloff', min: 0.2, max: 6, step: 0.1, label: 'edge falloff (soft <-> tight)' },
      { path: 'bakalar.beam.depthFalloff', min: 0.1, max: 4, step: 0.05, label: 'light falloff with depth' },
      { path: 'bakalar.beam.bandSync', type: 'choice', options: BEAT_DIVISIONS, label: 'bands — one travel per' },
      { path: 'bakalar.beam.bandSpeed', min: 0, max: 3, step: 0.05, label: '…or free-running, cycles/s' },
      { type: 'readout', label: 'timing', lines: () => fxTimingReadout([
        ['bands', 'bakalar.beam.bandSync', () => 1 / Math.max(0.01, CONFIG.bakalar?.beam?.bandSpeed ?? 0.55)],
      ]) },
      { path: 'bakalar.beam.bandCount', min: 0.5, max: 12, step: 0.5, label: 'band count' },
      { path: 'bakalar.beam.bandAmount', min: 0, max: 1, step: 0.02, label: 'band strength' },
      { path: 'bakalar.beam.coreBoost', min: 0, max: 3, step: 0.05, label: 'hot core' },
      // --- suction (the pull) ---
      // Deliberately mirrors the two falloffs above. Drag them apart and fish
      // get pulled hardest through the dim parts of the beam.
      { path: 'bakalar.suction.strength', min: 0, max: 3, step: 0.05, label: 'suction strength' },
      { path: 'bakalar.suction.edgeFalloff', min: 0.2, max: 6, step: 0.1, label: 'suction falloff across' },
      { path: 'bakalar.suction.depthFalloff', min: 0.1, max: 4, step: 0.05, label: 'suction falloff with depth' },
      { path: 'bakalar.suction.inwardRate', min: 0, max: 6, step: 0.1, label: 'pull toward the axis' },
      { path: 'bakalar.suction.minPull', min: 0, max: 1, step: 0.02, label: 'minimum pull at the edge' },
      { path: 'bakalar.haulSpeed', min: 0.5, max: 30, step: 0.5, label: 'haul speed' },
      { path: 'bakalar.bobSpeed', min: 0, max: 6, step: 0.1, label: 'hull bob speed' },
      { path: 'bakalar.bobAmount', min: 0, max: 2, step: 0.02, label: 'hull bob' },
      { path: 'bakalar.bomb.enabled', type: 'bool', label: 'drops voicemail bombs' },
      { path: 'bakalar.bomb.dropInterval', min: 0.5, max: 15, step: 0.1, label: 'seconds between drops' },
      { path: 'bakalar.bomb.dropIntervalPerLevel', min: 0, max: 2, step: 0.02, label: 'drops sooner per level' },
      { path: 'bakalar.bomb.dropIntervalFloor', min: 0.3, max: 8, step: 0.1, label: 'fastest allowed drop' },
      { path: 'bakalar.bomb.minCatch', min: 0, max: 10, step: 1, label: 'fish needed to bother' },
      { path: 'bakalar.bomb.fallSpeed', min: 1, max: 30, step: 0.5, label: 'bomb fall speed' },
      { path: 'bakalar.bomb.fuse', min: 0, max: 3, step: 0.05, label: 'fuse (seconds armed)' },
      { path: 'bakalar.bomb.radius', min: 1, max: 30, step: 0.5, label: 'blast radius' },
      { path: 'bakalar.bomb.radiusPerLevel', min: 0, max: 4, step: 0.1, label: 'blast radius per level' },
      { path: 'bakalar.bomb.damage', min: 1, max: 250, step: 5, label: 'blast damage' },
      { path: 'bakalar.bomb.damagePerLevel', min: 0, max: 80, step: 2, label: 'blast damage per level' },
      { path: 'bakalar.bomb.knockback', min: 0, max: 40, step: 1, label: 'blast knockback' },
      { path: 'bakalar.bomb.chumPerKill', min: 0, max: 10, step: 1, label: 'chum per kill' },
      { path: 'bakalar.bomb.chumScatter', min: 0, max: 20, step: 1, label: 'chum scattered regardless' },
      { path: 'bakalar.bomb.chumSpread', min: 0.5, max: 20, step: 0.5, label: 'chum spread' },
      { path: 'bakalar.bomb.size', min: 0.1, max: 3, step: 0.02, label: 'bomb size' },
      { path: 'bakalar.bomb.color', type: 'color', label: 'bomb light color' },
      { path: 'bakalar.bomb.blinkSpeed', min: 1, max: 30, step: 0.5, label: 'blink speed' },
    ],
  },
  {
    group: 'Scallop squirter',
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      // fireRate, damage, life and maxBounces are weapons.csv's.
      { path: 'scallop.speed', min: 1, max: 40, step: 0.5, label: 'launch speed' },
      { path: 'scallop.radius', min: 0.1, max: 2, step: 0.02, label: 'hit radius' },
      { path: 'scallop.turnRange', min: 0, max: 3.2, step: 0.05, label: 'heading change per jet' },
      { path: 'scallop.drag', min: 0, max: 8, step: 0.1, label: 'coast drag between jets' },
      { path: 'scallop.restitution', min: 0.1, max: 1.2, step: 0.02, label: 'bounce retention' },
      { path: 'scallop.spin', min: 0, max: 25, step: 0.5, label: 'tumble speed' },
    ],
  },
  {
    group: 'Oyster blaster',
    panel: 'companions',
    section: 'Thrown & launched',
    items: [
      // Cadence, pearl/bomblet damage, bomblet count and blast radius are
      // weapons.csv's — the burst's whole payload is one balance question.
      { path: 'oyster.speed', min: 1, max: 40, step: 0.5, label: 'pearl speed' },
      { path: 'oyster.life', min: 0.5, max: 10, step: 0.1, label: 'pearl lifetime' },
      { path: 'oyster.pearlColor', type: 'color', label: 'pearl color' },
      // These three set how far a bomblet travels before it goes off, and they
      // have to stay in proportion to the blast radius above — travel much
      // further than the blast and the burst stops covering the impact point.
      // See the note in CONFIG.oyster.
      { path: 'oyster.bombletDrag', min: 0.2, max: 8, step: 0.1, label: 'bomblet drag' },
      { path: 'oyster.bombletColor', type: 'color', label: 'bomblet color' },
      { path: 'oyster.bombletGlow', min: 0, max: 8, step: 0.1, label: 'bomblet glow' },
      // The white burst, fired both where the pearl cracks and at every
      // bomblet. No colour control on purpose — it is white, and the glow is
      // the only dial it needs.
      { path: 'emitters.pearlBurst.count', min: 0, max: 120, step: 2, label: 'pearl burst particles' },
      { path: 'emitters.pearlBurst.glow', min: 0, max: 10, step: 0.1, label: 'pearl burst glow' },
    ],
  },
  {
    group: 'Octopus grabber',
    panel: 'companions',
    section: 'Escorts',
    items: [
      // How many arms may be GRABBING at once, not how many exist — the
      // model always shows six and the surplus dangle.
      { path: 'octoGrab.arms', min: 1, max: 6, step: 1, label: 'arms grabbing at level 1' },
      { path: 'octoGrab.armsPerLevel', min: 0, max: 3, step: 1, label: 'arms per level' },
      // THE GRAB RADIUS. Capped in code at the arm's measured length times
      // `arm strain` below, so pushing this past what the tentacle can cover
      // stops having an effect rather than silently granting reach the arm
      // visibly doesn't have.
      { path: 'octoGrab.reach', min: 1, max: 25, step: 0.5, label: 'grab radius' },
      { path: 'octoGrab.reachPerLevel', min: 0, max: 3, step: 0.05, label: 'grab radius per level' },
      { path: 'octoGrab.reachStretch', min: 1, max: 2.5, step: 0.05, label: 'arm strain (x real length)' },
      { path: 'octoGrab.reelSpeed', min: 0.5, max: 30, step: 0.5, label: 'reel speed' },
      { path: 'octoGrab.reelSpeedPerLevel', min: 0, max: 4, step: 0.1, label: 'reel speed per level' },
      { path: 'octoGrab.grabCooldown', min: 0, max: 5, step: 0.05, label: 'arm rest after a pop' },
      { path: 'octoGrab.graspTimeout', min: 0.1, max: 3, step: 0.05, label: 'seconds before it commits' },
      { path: 'octoGrab.popDistance', min: 0.2, max: 6, step: 0.1, label: 'pop distance' },
      { path: 'octoGrab.maxTargetRadius', min: 0.2, max: 6, step: 0.1, label: 'biggest grabbable fish' },
      { path: 'octoGrab.chumPerPop', min: 0, max: 10, step: 1, label: 'chum per pop' },
      { path: 'octoGrab.chumXp', min: 1, max: 20, step: 1, label: 'xp per chum bit' },
      // --- rig ---
      { path: 'octoGrab.reachWeight', min: 0, max: 1, step: 0.05, label: 'IK weight while reaching' },
      { path: 'octoGrab.dangleWeight', min: 0, max: 1, step: 0.05, label: 'IK weight while dangling' },
      { path: 'octoGrab.weightLerpIn', min: 0.5, max: 20, step: 0.5, label: 'reach ramp in' },
      { path: 'octoGrab.weightLerpOut', min: 0.5, max: 20, step: 0.5, label: 'release ramp out' },
      { path: 'octoGrab.ik.iterations', min: 1, max: 12, step: 1, label: 'CCD passes per arm' },
      { path: 'octoGrab.ik.rootInfluence', min: 0, max: 1, step: 0.05, label: 'how much the base swings' },
      { path: 'octoGrab.ik.maxBend', min: 0.1, max: 2.5, step: 0.05, label: 'max bend per bone' },
      { path: 'octoGrab.ik.softness', min: 0.1, max: 1, step: 0.05, label: 'bend limit softness' },
      { path: 'octoGrab.ik.smoothing', min: 1, max: 40, step: 1, label: 'arm chase speed' },
      // --- dangle ---
      { path: 'octoGrab.dangleLength', min: 0.2, max: 10, step: 0.1, label: 'dangle trail length' },
      { path: 'octoGrab.dangleSpread', min: 0, max: 6, step: 0.1, label: 'dangle fan width' },
      { path: 'octoGrab.dangleDroop', min: 0, max: 4, step: 0.05, label: 'dangle sag' },
      { path: 'octoGrab.idleWave', min: 0, max: 6, step: 0.1, label: 'idle undulation speed' },
      { path: 'octoGrab.idleAmp', min: 0, max: 4, step: 0.05, label: 'idle undulation' },
      // --- drift / secondary motion ---
      // LOWER stiffness and damping = looser. The variance is what stops the
      // six arms reading as one object.
      { path: 'octoGrab.drift.stiffness', min: 0.5, max: 30, step: 0.5, label: 'arm follow stiffness' },
      { path: 'octoGrab.drift.damping', min: 0.2, max: 15, step: 0.1, label: 'arm damping (low = sways)' },
      { path: 'octoGrab.drift.stiffnessVariance', min: 0, max: 0.9, step: 0.05, label: 'per-arm stiffness spread' },
      { path: 'octoGrab.drift.wanderOctave', min: 0.05, max: 1, step: 0.01, label: 'second wander ratio' },
      { path: 'octoGrab.drift.wanderOctaveAmp', min: 0, max: 2, step: 0.05, label: 'second wander amount' },
      { path: 'octoGrab.drift.velocityDrag', min: 0, max: 1, step: 0.02, label: 'streaming from velocity' },
      // --- hunting ---
      // `aggression` is the one that changes its personality: 0 station-keeps
      // beside the seal and waits, 1 abandons the escort entirely to chase.
      { path: 'octoGrab.hunt.enabled', type: 'bool', label: 'hunt for fish' },
      { path: 'octoGrab.hunt.radius', min: 2, max: 40, step: 0.5, label: 'hunting radius' },
      { path: 'octoGrab.hunt.weight', min: 0, max: 1, step: 0.05, label: 'aggression (off station)' },
      { path: 'octoGrab.hunt.thrustBoost', min: 1, max: 4, step: 0.1, label: 'thrust while hunting' },
      { path: 'octoGrab.hunt.pulseFraction', min: 0.1, max: 1, step: 0.05, label: 'jet duty while hunting' },
      // --- turbulence ---
      // SLOW and STRONG is the setting. Raising `speed` past about 1 turns
      // long heavy sweeps into a buzz, whatever the strength.
      { path: 'octoGrab.turbulence.enabled', type: 'bool', label: 'arm turbulence' },
      { path: 'octoGrab.turbulence.strength', min: 0, max: 60, step: 1, label: 'turbulence strength' },
      { path: 'octoGrab.turbulence.speed', min: 0.05, max: 3, step: 0.05, label: 'turbulence speed (low = heavy)' },
      { path: 'octoGrab.turbulence.octave', min: 1, max: 6, step: 0.1, label: 'second octave ratio' },
      { path: 'octoGrab.turbulence.octaveAmp', min: 0, max: 1.5, step: 0.05, label: 'second octave amount' },
      { path: 'octoGrab.turbulence.swirl', min: 0, max: 1, step: 0.05, label: 'swirl vs straight push' },
      { path: 'octoGrab.turbulence.tipBias', min: 0, max: 1, step: 0.05, label: 'turbulence toward the tips' },
      { path: 'octoGrab.turbulence.busyScale', min: 0, max: 1, step: 0.05, label: 'turbulence while gripping' },
      // --- spread (anti-bunching) ---
      // What stops the six tentacles collecting into one rope under the body.
      { path: 'octoGrab.spread.enabled', type: 'bool', label: 'keep arms apart' },
      { path: 'octoGrab.spread.fanRadius', min: 0.5, max: 10, step: 0.1, label: 'fan radius' },
      { path: 'octoGrab.spread.fanForce', min: 0, max: 40, step: 0.5, label: 'fan strength' },
      { path: 'octoGrab.spread.fanArc', min: 0.5, max: 6.28, step: 0.1, label: 'fan arc (radians)' },
      { path: 'octoGrab.spread.minRadius', min: 0, max: 8, step: 0.1, label: 'min tip distance from body' },
      { path: 'octoGrab.spread.radialForce', min: 0, max: 60, step: 1, label: 'push out of the centre' },
      { path: 'octoGrab.spread.minGap', min: 0, max: 8, step: 0.1, label: 'min gap between tips' },
      { path: 'octoGrab.spread.gapForce', min: 0, max: 60, step: 1, label: 'push tips apart' },
      { path: 'octoGrab.spread.tipBias', min: 0, max: 1, step: 0.05, label: 'spread toward the tips' },
      // --- per-bone flow (the flagellum) ---
      // These are the looseness controls. `arm IK while idle` at 0 means the
      // arms are pure physics; raising it reimposes a posed shape and is the
      // fastest way to make them look like sticks again.
      { path: 'octoGrab.spring.enabled', type: 'bool', label: 'per-bone flow' },
      { path: 'octoGrab.spring.stiffness', min: 1, max: 120, step: 1, label: 'flow stiffness (low = floppy)' },
      { path: 'octoGrab.spring.damping', min: 0.2, max: 20, step: 0.1, label: 'flow damping (low = rings)' },
      { path: 'octoGrab.spring.tipLooseness', min: 0, max: 0.98, step: 0.02, label: 'tip looser than base' },
      { path: 'octoGrab.spring.maxLag', min: 0.1, max: 3, step: 0.05, label: 'max lag per bone' },
      { path: 'octoGrab.spring.softness', min: 0.05, max: 1, step: 0.05, label: 'lag limit softness' },
      { path: 'octoGrab.spring.weightIdle', min: 0, max: 1, step: 0.05, label: 'flow while idle' },
      { path: 'octoGrab.spring.weightBusy', min: 0, max: 1, step: 0.05, label: 'flow while gripping' },
      { path: 'octoGrab.spring.dragGain', min: 0, max: 30, step: 0.5, label: 'whip from body acceleration' },
      { path: 'octoGrab.spring.dragMax', min: 1, max: 80, step: 1, label: 'whip ceiling' },
      { path: 'octoGrab.spring.tipBias', min: 0, max: 1, step: 0.05, label: 'whip toward the tips' },
      { path: 'octoGrab.spring.droop', min: 0, max: 8, step: 0.1, label: 'downward hang' },
      // --- bioluminescence ---
      { path: 'octoGrab.glow.enabled', type: 'bool', label: 'arm glow' },
      { path: 'octoGrab.glow.color', type: 'color', label: 'glow color' },
      { path: 'octoGrab.glow.strength', min: 0, max: 6, step: 0.1, label: 'glow strength' },
      { path: 'octoGrab.glow.falloff', min: 0.5, max: 8, step: 0.1, label: 'glow falloff (higher = tip only)' },
      { path: 'octoGrab.glow.span', min: 0.05, max: 1, step: 0.05, label: 'lit fraction of the arm' },
      { path: 'octoGrab.glow.ambient', min: 0, max: 0.5, step: 0.01, label: 'idle glow floor' },
      { path: 'octoGrab.glow.shimmerAmp', min: 0, max: 1, step: 0.05, label: 'shimmer amount' },
      { path: 'octoGrab.glow.shimmerFreq', min: 0, max: 20, step: 0.5, label: 'shimmer frequency' },
      { path: 'octoGrab.glow.shimmerSync', type: 'choice', options: BEAT_DIVISIONS, label: 'shimmer — one travel per' },
      { path: 'octoGrab.glow.shimmerSpeed', min: 0, max: 10, step: 0.1, label: '…or free-running, rad/s' },
      { type: 'readout', label: 'timing', lines: () => fxTimingReadout([
        ['shimmer', 'octoGrab.glow.shimmerSync', () => (Math.PI * 2) / Math.max(0.01, CONFIG.octoGrab?.glow?.shimmerSpeed ?? 2.4)],
      ]) },
      { path: 'octoGrab.glow.reachLevel', min: 0, max: 1, step: 0.05, label: 'glow while reaching' },
      { path: 'octoGrab.glow.holdLevel', min: 0, max: 1, step: 0.05, label: 'glow while holding' },
      { path: 'octoGrab.glow.riseRate', min: 0.5, max: 20, step: 0.5, label: 'glow rise rate' },
      { path: 'octoGrab.glow.fallRate', min: 0.2, max: 20, step: 0.1, label: 'glow fade rate' },
      // --- head / propulsion ---
      { path: 'octoGrab.head.weight', min: 0, max: 1, step: 0.05, label: 'head IK weight' },
      { path: 'octoGrab.head.lead', min: 0.5, max: 12, step: 0.1, label: 'head target lead' },
      { path: 'octoGrab.head.thrust', min: 1, max: 80, step: 1, label: 'jet thrust' },
      { path: 'octoGrab.head.maxSpeed', min: 1, max: 40, step: 0.5, label: 'max swim speed' },
      { path: 'octoGrab.head.drag', min: 0.2, max: 12, step: 0.1, label: 'water drag' },
      { path: 'octoGrab.head.pulseInterval', min: 0.1, max: 3, step: 0.05, label: 'seconds between jets' },
      { path: 'octoGrab.head.pulseFraction', min: 0.05, max: 1, step: 0.05, label: 'jet duty cycle' },
      { path: 'octoGrab.bodyFollow', min: 0.5, max: 25, step: 0.5, label: 'body follow spring' },
    ],
  },
  {
    group: 'Orca family',
    panel: 'companions',
    section: 'Escorts',
    items: [
      { path: 'orca.count', min: 1, max: 8, step: 1, label: 'pod size' },
      { path: 'orca.damage', min: 1, max: 200, step: 2, label: 'damage per hit' },
      { path: 'orca.damagePerLevel', min: 0, max: 60, step: 1, label: 'damage per level' },
      { path: 'orca.attackInterval', min: 0.3, max: 12, step: 0.1, label: 'seconds between runs' },
      { path: 'orca.attackIntervalPerLevel', min: 0, max: 1.5, step: 0.02, label: 'faster per level' },
      { path: 'orca.attackIntervalFloor', min: 0.2, max: 6, step: 0.1, label: 'fastest allowed' },
      { path: 'orca.chargeSpeed', min: 2, max: 60, step: 1, label: 'charge speed' },
      { path: 'orca.chargeSpeedPerLevel', min: 0, max: 8, step: 0.2, label: 'charge speed per level' },
      { path: 'orca.cruiseSpeed', min: 1, max: 30, step: 0.5, label: 'cruise speed' },
      { path: 'orca.hitRadius', min: 0.3, max: 8, step: 0.1, label: 'hit radius' },
      { path: 'orca.huntRange', min: 5, max: 90, step: 1, label: 'hunt range' },
      { path: 'orca.fallbackMinRadius', min: 0, max: 4, step: 0.1, label: 'smallest fish it will chase' },
      { path: 'orca.knockback', min: 0, max: 30, step: 0.5, label: 'knockback' },
      { path: 'orca.turnRate', min: 0.5, max: 15, step: 0.1, label: 'turn rate' },
      { path: 'orca.formationSpacing', min: 0.5, max: 10, step: 0.1, label: 'formation spacing' },
      { path: 'orca.formationFollow', min: 0.5, max: 20, step: 0.5, label: 'formation follow spring' },
    ],
  },
  {
    group: 'Calamari ring',
    panel: 'companions',
    section: 'Auras & orbits',
    items: [
      { path: 'calamari.interval', min: 0.3, max: 12, step: 0.1, label: 'seconds between waves' },
      { path: 'calamari.intervalPerLevel', min: 0, max: 1.5, step: 0.02, label: 'faster per level' },
      { path: 'calamari.intervalFloor', min: 0.2, max: 6, step: 0.1, label: 'fastest allowed interval' },
      { path: 'calamari.baseRadius', min: 1, max: 30, step: 0.5, label: 'wave reach' },
      { path: 'calamari.radiusPerLevel', min: 0, max: 5, step: 0.1, label: 'reach per level' },
      { path: 'calamari.speed', min: 2, max: 60, step: 1, label: 'expansion speed' },
      { path: 'calamari.damage', min: 1, max: 120, step: 1 },
      { path: 'calamari.damagePerLevel', min: 0, max: 40, step: 1, label: 'damage per level' },
      { path: 'calamari.knockback', min: 0, max: 40, step: 0.5 },
      { path: 'calamari.ringWidth', min: 0.02, max: 0.6, step: 0.01, label: 'band width (frac of reach)' },
      { path: 'calamari.color', type: 'color' },
      { path: 'calamari.opacity', min: 0, max: 1, step: 0.02 },
      { path: 'calamari.swirl', min: 0, max: 6, step: 0.1 },
      { path: 'calamari.density', min: 0.2, max: 8, step: 0.1 },
    ],
  },
  {
    group: 'Dumbo octopus',
    panel: 'companions',
    section: 'Escorts',
    items: [
      { path: 'dumbo.interval', min: 0.3, max: 15, step: 0.1, label: 'seconds between charms' },
      { path: 'dumbo.intervalPerLevel', min: 0, max: 2, step: 0.05, label: 'faster per level' },
      { path: 'dumbo.intervalFloor', min: 0.2, max: 8, step: 0.1, label: 'fastest allowed interval' },
      { path: 'dumbo.range', min: 1, max: 30, step: 0.5, label: 'charm range' },
      { path: 'dumbo.rangePerLevel', min: 0, max: 4, step: 0.1, label: 'range per level' },
      { path: 'dumbo.duration', min: 0.5, max: 20, step: 0.1, label: 'charm duration' },
      { path: 'dumbo.durationPerLevel', min: 0, max: 3, step: 0.1, label: 'duration per level' },
      { path: 'dumbo.targets', min: 1, max: 10, step: 1, label: 'targets per pulse' },
      { path: 'dumbo.targetsPerLevel', min: 0, max: 2, step: 0.1, label: 'targets per level' },
      { path: 'dumbo.orbitRadius', min: 0.5, max: 6, step: 0.1 },
      { path: 'dumbo.orbitDepth', min: 0, max: 6, step: 0.1, label: 'orbit depth (3D)' },
      { path: 'dumbo.orbitSpeed', min: -4, max: 4, step: 0.1 },
      { path: 'dumbo.followSpring', min: 2, max: 80, step: 1, label: 'follow springiness' },
      { path: 'dumbo.followDamping', min: 0.5, max: 20, step: 0.5, label: 'follow damping' },
      { path: 'dumbo.bobAmount', min: 0, max: 2, step: 0.05, label: 'swim bob' },
      { path: 'dumbo.offsetX', min: -10, max: 10, step: 0.1, label: 'offset X' },
      { path: 'dumbo.offsetY', min: -10, max: 10, step: 0.1, label: 'offset Y' },
      { path: 'dumbo.offsetZ', min: -10, max: 10, step: 0.1, label: 'offset Z (depth)' },
    ],
  },
  {
    group: 'Level-up pause',
    section: 'Gameplay',
    items: [
      { path: 'levelUp.enabled', type: 'bool', label: 'slow down before the cards' },
      { path: 'levelUp.hold', min: 0.05, max: 1, step: 0.01, label: 'held time scale' },
      { path: 'levelUp.dilateTime', min: 0.05, max: 2, step: 0.05, label: 'time to reach it (s)' },
      { path: 'levelUp.menuDelay', min: 0, max: 2, step: 0.02, label: 'beat before the cards (s)' },
      { path: 'levelUp.restoreTime', min: 0.05, max: 3, step: 0.05, label: 'speed back up over (s)' },
      { path: 'levelUp.audio.enabled', type: 'bool', label: 'slow the sound too' },
      { path: 'levelUp.audio.follow', min: 0, max: 1, step: 0.05, label: 'how far sound follows' },
      { path: 'levelUp.audio.minRate', min: 0.1, max: 1, step: 0.02, label: 'slowest playback rate' },
      { path: 'levelUp.audio.glide', min: 0, max: 1, step: 0.05, label: 'music rate smoothing (s)' },
      { path: 'reveals.enabled', type: 'bool', label: 'dissolve menus in/out' },
      { path: 'reveals.upgrades.algo', options: ['value', 'perlin', 'simplex', 'worley', 'ridged', 'billow'], label: 'upgrades: noise' },
      { path: 'reveals.upgrades.style', options: ['hex', 'smooth'], label: 'upgrades: style' },
      { path: 'reveals.upgrades.inTime', min: 0.05, max: 2, step: 0.05, label: 'upgrades: in (s)' },
      { path: 'reveals.upgrades.outTime', min: 0, max: 2, step: 0.02, label: 'upgrades: out (s)' },
      { path: 'reveals.upgrades.steps', min: 2, max: 32, step: 1, label: 'upgrades: dither levels' },
      { path: 'reveals.upgrades.hexSize', min: 8, max: 64, step: 4, label: 'upgrades: hex size (px)' },
      { path: 'reveals.upgrades.bias', min: 0.05, max: 0.9, step: 0.05, label: 'upgrades: organic share' },
      { path: 'reveals.splash.algo', options: ['value', 'perlin', 'simplex', 'worley', 'ridged', 'billow'], label: 'splash: noise' },
      { path: 'reveals.splash.outTime', min: 0.1, max: 3, step: 0.05, label: 'splash: clear over (s)' },
      { path: 'reveals.splash.softness', min: 0.02, max: 1, step: 0.02, label: 'splash: edge softness' },
      { path: 'reveals.splash.scale', min: 1, max: 20, step: 1, label: 'splash: detail' },
      { path: 'reveals.scoreCard.algo', options: ['value', 'perlin', 'simplex', 'worley', 'ridged', 'billow'], label: 'score card: noise' },
      { path: 'reveals.scoreCard.inTime', min: 0.1, max: 3, step: 0.05, label: 'score card: in (s)' },
      { path: 'reveals.scoreCard.softness', min: 0.02, max: 1, step: 0.02, label: 'score card: edge softness' },
      { path: 'reveals.scoreCard.scale', min: 1, max: 20, step: 1, label: 'score card: detail' },
      { path: 'reveals.field.size', min: 48, max: 224, step: 16, label: 'field bake size (px)' },
      { path: 'reveals.field.levels', min: 2, max: 24, step: 1, label: 'field levels' },
      { path: 'reveals.field.phases', min: 1, max: 10, step: 1, label: 'boil frames' },
      { path: 'reveals.field.octaves', min: 1, max: 4, step: 1, label: 'field octaves' },
      { path: 'reveals.field.boilHz', min: 0, max: 30, step: 1, label: 'boil rate (fps)' },
      { path: 'reveals.field.drift', min: 0, max: 120, step: 2, label: 'field drift (px)' },
    ],
  },
  {
    group: 'Level-up card art',
    section: 'Interface & controls',
    // Only the overlay is a slider now. Which image sits behind which upgrade
    // is the `cardArt` column of upgrades.csv, alongside that upgrade's name
    // and description — one row per upgrade, rather than the art being picked
    // here and the words written in a different panel.
    items: [
      { path: 'levelUpCards.overlayOpacity', min: 0, max: 1, step: 0.02, label: 'overlay darkness' },
      { path: 'levelUpCards.overlayColor', type: 'color', label: 'overlay color' },
    ],
  },
  {
    group: 'Projectile trails',
    section: 'Look & FX',
    items: [
      { path: 'trails.enabled', type: 'bool', label: 'projectile trails' },
      ...['missile', 'bounceShot', 'seagull', 'starfish', 'bullet'].flatMap((k) => ([
        { path: `trails.${k}.width`, min: 0, max: 2, step: 0.02, label: `${k} width` },
        { path: `trails.${k}.points`, min: 2, max: 40, step: 1, label: `${k} length` },
        { path: `trails.${k}.glow`, min: 0, max: 8, step: 0.1, label: `${k} glow` },
        { path: `trails.${k}.color`, type: 'color', label: `${k} colour` },
        { path: `trails.${k}.taper`, min: 0.1, max: 4, step: 0.05, label: `${k} taper` },
        { path: `trails.${k}.fade`, min: 0.1, max: 4, step: 0.05, label: `${k} fade` },
      ])),
    ],
  },
  {
    group: 'Rocks (ammo & pickups)',
    section: 'Gameplay',
    items: [
      { path: 'rocks.amplitude', min: 0, max: 1, step: 0.02, label: 'lumpiness' },
      { path: 'rocks.frequency', min: 0.4, max: 6, step: 0.1, label: 'noise scale' },
      { path: 'rocks.octaves', min: 1, max: 5, step: 1, label: 'noise detail layers' },
      { path: 'rocks.squash', min: 0, max: 0.8, step: 0.02, label: 'shape variation' },
      { path: 'rocks.detail', min: 0, max: 3, step: 1, label: 'polygon detail' },
      { path: 'rocks.variants', min: 1, max: 16, step: 1, label: 'distinct rocks per asset' },
      { path: 'rocks.shade', min: 0, max: 1, step: 0.02, label: 'facet shading' },
      { path: 'rocks.glowHeadroom', min: 0.05, max: 1, step: 0.02, label: 'facet shading under glow' },
      { path: 'rocks.grit', min: 0, max: 0.4, step: 0.01, label: 'facet grit' },
      { path: 'rocks.tumbleScale', min: 0, max: 4, step: 0.05, label: 'tumble speed' },
    ],
  },
  {
    group: 'Glow',
    section: 'Look & FX',
    items: [
      { path: 'bloom.enabled', type: 'bool', label: 'neon glow' },
      { path: 'bloom.threshold', min: 0.1, max: 1, step: 0.02, label: 'glow threshold' },
      { path: 'bloom.intensity', min: 0, max: 3, step: 0.05, label: 'glow amount' },
      { path: 'bloom.knee', min: 0, max: 0.99, step: 0.01, label: 'highlight roll-off (0 = hard clip)' },
      { path: 'bloom.radius', min: 1, max: 8, step: 1, label: 'glow spread' },
      // A performance control that happens to have a look. See the note on
      // bloom.divisor — higher is cheaper AND wider, so it trades against
      // `glow spread` directly above rather than standing on its own.
      { path: 'bloom.divisor', min: 2, max: 8, step: 1, label: 'glow resolution (higher = cheaper)' },
      { path: 'bloom.pulseStrength', min: 0, max: 4, step: 0.1, label: 'impact pulse amount' },
      { path: 'bloom.pulseDecay', min: 0.5, max: 10, step: 0.1, label: 'impact pulse snap-back' },
      { path: 'bloom.particleOverdrive', min: 0, max: 8, step: 0.1, label: 'particle glow overdrive' },
      { path: 'emitters.explosion.glow', min: 0, max: 10, step: 0.1, label: 'explosion glow' },
      { path: 'emitters.bigExplosion.glow', min: 0, max: 10, step: 0.1, label: 'big explosion glow' },
      { path: 'emitters.muzzle.glow', min: 0, max: 10, step: 0.1, label: 'muzzle flash glow' },
      { path: 'emitters.levelUp.glow', min: 0, max: 10, step: 0.1, label: 'level-up glow' },
    ],
  },
  {
    group: 'Look',
    section: 'Look & FX',
    items: [
      { path: 'post.preset', options: ['off', 'crt', 'vhs', 'vga', 'arcade'], label: 'screen filter' },
      { path: 'post.enabled', type: 'bool', label: 'post-processing' },
      { path: 'grid.enabled', type: 'bool', label: 'warp grid' },
      { path: 'grid.pattern', options: ['square', 'hex'], label: 'grid pattern' },
      { path: 'grid.clipAtSurface', type: 'bool', label: 'grid stops at water' },
      { path: 'grid.spacing', min: 1, max: 8, step: 0.2 },
      { path: 'grid.opacity', min: 0, max: 1, step: 0.05 },
      { path: 'grid.warpGain', min: 0, max: 5, step: 0.1 },
      { path: 'grid.rippleDecay', min: 0.3, max: 8, step: 0.1, label: 'ripple snap-back' },
      { path: 'grid.wakeStrength', min: -3, max: 3, step: 0.05, label: 'ship wake' },
      { path: 'grid.touchGlow.enabled', type: 'bool', label: 'finger glow (touch)' },
      { path: 'grid.touchGlow.radius', min: 1, max: 20, step: 0.5, label: 'finger glow reach' },
      { path: 'grid.touchGlow.gain', min: 0, max: 4, step: 0.1, label: 'finger glow brightness' },
      { path: 'grid.touchGlow.push', min: 0, max: 3, step: 0.05, label: 'finger shove' },
      { path: 'grid.touchGlow.swirl', min: 0, max: 3, step: 0.05, label: 'finger swirl' },
      { path: 'grid.touchGlow.ripple.strength', min: 0, max: 8, step: 0.1, label: 'finger knock' },
      { path: 'grid.touchGlow.ripple.radius', min: 1, max: 20, step: 0.5, label: 'finger knock reach' },
      { path: 'grid.touchGlow.charge.grow', min: 0, max: 4, step: 0.1, label: 'charge growth' },
      { path: 'grid.touchGlow.charge.pulseAtFull', min: 0.04, max: 1, step: 0.01, label: 'charge beat at full (s)' },
      { path: 'grid.touchGlow.charge.pulseStrength', min: 0, max: 8, step: 0.1, label: 'charge pulse' },
    ],
  },
  {
    group: 'Performance',
    section: 'Look & FX',
    items: [
      // The biggest single lever in the renderer, and the only one that costs
      // sharpness rather than an effect. See CONFIG.render — sweep it against
      // the fps and Mpix in the readout at the bottom of this panel.
      { path: 'render.pixelRatio', min: 0.5, max: 3, step: 0.05, label: 'render scale (cap on display ratio)' },
    ],
  },
  {
    group: 'Feel',
    section: 'Look & FX',
    items: [
      { path: 'fx.hitstopScale', min: 0.01, max: 1, step: 0.01, label: 'hit-stop slowdown' },
      { path: 'fx.hitstopCooldown', min: 0, max: 2, step: 0.05, label: 'hit-stop cooldown' },
      { path: 'fx.maxShake', min: 0, max: 3, step: 0.05, label: 'max shake' },
      { path: 'fx.hitPop', min: 0, max: 1.5, step: 0.05, label: 'enemy hit pop' },
      { path: 'feedback.kill.shake', min: 0, max: 2, step: 0.05, label: 'kill shake' },
      // A tenth the range and a fifth the step of the other shakes, because
      // this one is multiplied by a 0.35..2.0 scale before it lands and the
      // whole curve has to stay under `max shake` for that scaling to survive
      // — see the note on CONFIG.feedback.playerHit.
      { path: 'feedback.playerHit.shake', min: 0, max: 0.3, step: 0.01, label: 'damage shake (x0.35-2 by hp lost)' },
      { path: 'fx.playerDamage.minGap', min: 0.02, max: 0.6, step: 0.01, label: 'min gap between hits shown' },
      { path: 'fx.playerDamage.gain', min: 0, max: 12, step: 0.1, label: 'hit size per hp fraction' },
      { path: 'fx.playerDamage.flashFraction', min: 0.05, max: 1, step: 0.01, label: 'hp lost for a full rim flash' },
      { path: 'feedback.kill.ripple.strength', min: 0, max: 10, step: 0.1, label: 'kill grid punch' },
      { path: 'emitters.explosion.count', min: 0, max: 200, step: 5, label: 'explosion bits' },
      // The current every particle in the game swims in. `drag spread` is the
      // one to reach for first — it costs nothing and is most of the
      // difference between a burst that looks thrown through water and one
      // that looks played back.
      { path: 'fx.turbulence.enabled', type: 'bool', label: 'water turbulence' },
      { path: 'fx.turbulence.strength', min: 0, max: 3, step: 0.05, label: 'turbulence strength' },
      { path: 'fx.turbulence.frequency', min: 0.05, max: 2, step: 0.05, label: 'turbulence eddy size (low = big)' },
      { path: 'fx.turbulence.timeScale', min: 0, max: 4, step: 0.05, label: 'turbulence churn speed' },
      { path: 'fx.turbulence.dragVary', min: 0, max: 0.95, step: 0.05, label: 'particle drag spread' },
      { path: 'audio.masterVolume', min: 0, max: 1, step: 0.05 },
      { path: 'audio.enabled', type: 'bool', label: 'sound' },
      { path: 'haptics.enabled', type: 'bool', label: 'haptics' },
      { path: 'haptics.intensity', min: 0, max: 2, step: 0.05, label: 'rumble strength' },
      { path: 'haptics.fullAtMs', min: 5, max: 150, step: 5, label: 'rumble full at ms' },
      { path: 'haptics.curve', min: 0.2, max: 2, step: 0.05, label: 'rumble curve' },
      { path: 'haptics.floor', min: 0, max: 0.6, step: 0.01, label: 'rumble floor' },
      { path: 'haptics.strongRatio', min: 0, max: 1, step: 0.05, label: 'rumble low motor' },
      { path: 'haptics.weakRatio', min: 0, max: 1, step: 0.05, label: 'rumble high motor' },
      { path: 'haptics.minDuration', min: 0, max: 120, step: 5, label: 'rumble min ms' },
      { path: 'haptics.mixing.enabled', type: 'bool', label: 'stack overlapping rumble' },
      { path: 'haptics.mixing.sumMode', options: ['soft', 'linear', 'max'], label: 'rumble sum law' },
      { path: 'haptics.mixing.release', min: 0, max: 400, step: 5, label: 'rumble tail (fuses repeats)' },
    ],
  },
  {
    group: 'Touch sticks',
    section: 'Interface & controls',
    items: [
      { path: 'touch.stickRadius', min: 20, max: 160, step: 5, label: 'full deflection (px)' },
      { path: 'touch.deadzone', min: 0, max: 30, step: 1, label: 'stick deadzone (px)' },
      { path: 'touch.splitX', min: 0.2, max: 0.8, step: 0.05, label: 'move / aim screen split' },
      { path: 'touch.aimFollowsMove', type: 'bool', label: 'face travel when not aiming' },
      { path: 'touch.strike.thirdTouch', type: 'bool', label: 'strike: third finger' },
      { path: 'touch.strike.doubleTap', type: 'bool', label: 'strike: double-tap & hold' },
      { path: 'touch.strike.doubleTapMs', min: 120, max: 600, step: 10, label: 'double-tap window (ms)' },
      { path: 'touch.strike.tapMaxMs', min: 80, max: 500, step: 10, label: 'longest press still a tap (ms)' },
      { path: 'touch.strike.tapSlop', min: 4, max: 48, step: 2, label: 'tap drift allowed (px)' },
    ],
  },
  {
    group: 'Death dive',
    section: 'Gameplay',
    items: [
      { path: 'death.enabled', type: 'bool', label: 'ragdoll & sink on death' },
      { path: 'death.slowMo', min: 0.02, max: 1, step: 0.01, label: 'slow-mo scale' },
      { path: 'death.dilateTime', min: 0.05, max: 2, step: 0.05, label: 'time to reach it (s)' },
      { path: 'death.driftScale', min: 0.05, max: 1, step: 0.01, label: 'drift scale after the dip' },
      { path: 'death.driftTime', min: 0.1, max: 6, step: 0.1, label: 'ease back over (s)' },
      { path: 'death.launch', min: 0, max: 1.5, step: 0.05, label: 'momentum kept' },
      { path: 'death.kickUp', min: 0, max: 20, step: 0.5, label: 'limp lift' },
      { path: 'death.sinkGravity', min: 1, max: 80, step: 1, label: 'sink gravity' },
      { path: 'death.sinkSpeedMax', min: 2, max: 60, step: 1, label: 'terminal sink speed' },
      { path: 'death.depthBoost', min: 1, max: 5, step: 0.1, label: 'faster from higher up (x)' },
      { path: 'death.drag', min: 0.8, max: 1, step: 0.005, label: 'water drag' },
      { path: 'death.sway', min: 0, max: 20, step: 0.5, label: 'sideways drift' },
      { path: 'death.swayHz', min: 0.05, max: 2, step: 0.05, label: 'drift rate (hz)' },
      { path: 'death.spin', min: 0, max: 10, step: 0.1, label: 'tumble' },
      { path: 'death.spinDamp', min: 0, max: 4, step: 0.05, label: 'tumble damping' },
      { path: 'death.bodyRoll', min: 0, max: 8, step: 0.1, label: 'barrel roll' },
      { path: 'death.rollDamp', min: 0, max: 4, step: 0.05, label: 'barrel roll damping' },
      { path: 'death.tailKick', min: 0, max: 30, step: 0.5, label: 'tail shove' },
      { path: 'death.bounce', min: 0, max: 1, step: 0.02, label: 'seabed bounce' },
      { path: 'death.settleDrag', min: 0.5, max: 1, step: 0.01, label: 'settle drag' },
      { path: 'death.settleTurn', min: 0.5, max: 20, step: 0.5, label: 'roll flat rate' },
      { path: 'death.settle', min: 0, max: 6, step: 0.1, label: 'pause before score screen (s)' },
      { path: 'death.fadeIn', min: 0, max: 3, step: 0.05, label: 'score card fade-in (s)' },
      { path: 'death.camera.enabled', type: 'bool', label: 'push in and follow the body' },
      { path: 'death.camera.zoom', min: 1, max: 3.5, step: 0.05, label: 'push-in zoom (x)' },
      { path: 'death.camera.pushTime', min: 0.2, max: 8, step: 0.1, label: 'push-in time (s)' },
      { path: 'death.camera.frameTime', min: 0.1, max: 4, step: 0.1, label: 'time to frame the body (s)' },
      { path: 'death.audio.enabled', type: 'bool', label: 'slow the sound too' },
      { path: 'death.audio.follow', min: 0, max: 1, step: 0.05, label: 'how far sound follows' },
      { path: 'death.audio.minRate', min: 0.1, max: 1, step: 0.02, label: 'slowest playback rate' },
      { path: 'death.audio.glide', min: 0, max: 1, step: 0.05, label: 'music rate smoothing (s)' },
      { path: 'death.audio.restoreTime', min: 0, max: 8, step: 0.1, label: 'music back to pitch (s)' },
      { path: 'death.restart.time', min: 0, max: 3, step: 0.05, label: 'try-again glide back (s)' },
      { path: 'death.restart.filterGlide', min: 0.05, max: 1, step: 0.01, label: 'filter sweep (x glide)' },
      { path: 'feedback.seabedImpact.shake', min: 0, max: 2, step: 0.05, label: 'landing shake' },
      { path: 'emitters.silt.count', min: 0, max: 200, step: 5, label: 'silt bits' },
    ],
  },
  {
    group: 'View',
    section: 'The ocean',
    items: [
      { path: 'arena.viewHeight', min: 20, max: 120, step: 2 },
      { path: 'arena.surfaceFromTop', min: 0, max: 0.6, step: 0.01, label: 'water line' },
      { path: 'arena.widthScale', min: 1, max: 4, step: 0.05, label: 'arena width (x frame)' },
      { path: 'arena.airScale', min: 1, max: 8, step: 0.1, label: 'jump ceiling (x sky)' },
      { path: 'wallRocks.enabled', type: 'bool', label: 'rocks on the walls' },
      { path: 'wallRocks.count', min: 0, max: 80, step: 1, label: 'boulders per wall' },
      // Two sliders, because `size` is a [smallest, largest] RANGE — the spread
      // between them is what stops the face reading as one repeated boulder.
      // A single slider here wrote a bare number over the pair, and the
      // destructure in wallRocks.js then threw before the first frame.
      { path: 'wallRocks.size.0', min: 0.5, max: 9, step: 0.1, label: 'boulder size (smallest)' },
      { path: 'wallRocks.size.1', min: 0.5, max: 9, step: 0.1, label: 'boulder size (largest)' },
      { path: 'wallRocks.roughness', min: 0, max: 0.8, step: 0.02, label: 'boulder lumpiness' },
      { path: 'wallRocks.aboveWater', min: 0, max: 20, step: 0.5, label: 'shore above water' },
      { path: 'wallRocks.color', type: 'color', label: 'rock colour' },
      { path: 'arena.waveAmplitude', min: 0, max: 2, step: 0.05 },
    ],
  },
];

// Frozen snapshot so the tuner's "Reset" button can restore launch values.
// Every creature gets these two knobs, defaulted here rather than repeated
// on 18 entries: spawnRateMul scales its weight (0 = never spawns),
// minPlayerLevel hard-gates it until the player reaches that level.
for (const def of Object.values(CONFIG.enemies)) {
  if (def.spawnRateMul == null) def.spawnRateMul = 1;
  if (def.minPlayerLevel == null) def.minPlayerLevel = 0;
}

// The roster config.js itself declares, captured before ANY saved tuning is
// merged in. Tuning snapshots are deep-merged, and a deep merge adds keys it
// finds — so a creature deleted from config.js comes straight back the moment
// a stale snapshot mentioning it is applied. It comes back BROKEN, too: its
// `asset` no longer resolves, and createVisual returns a bare Object3D for an
// unknown key, which means an invisible enemy still dealing contact damage.
// Deleting the hermit crab is what surfaced this. See pruneUnknownEnemies.
const BUILT_IN_ENEMY_KEYS = new Set(Object.keys(CONFIG.enemies));

// The glow presets config.js declares, captured for the same reason and with
// the same failure mode one step quieter. A preset a merge brings back is not
// broken, it is UNREACHABLE: the tuner's groups are built from this object at
// module load, before any tuning is merged, so a resurrected preset has no
// panel, no way to be edited, and no asset naming it — while still being
// written back to the next snapshot forever. Deleting the seal team's `escort`
// preset is what surfaced this. See pruneUnknownGlowPresets.
const BUILT_IN_GLOW_PRESETS = new Set(Object.keys(CONFIG.biolumSkin?.presets ?? {}));

// ---------------------------------------------------------------------------
// ...and the same idea once more, generalised: every dotted path config.js
// declares, captured before any snapshot is merged.
//
// The two sets above each name one container that had the problem. This is the
// class. A deep merge ADDS keys, so any field ever deleted from this file comes
// straight back out of a snapshot and then lives forever — written to the next
// save, and to every save after that. It is worse than clutter, because
// TUNER_SCHEMA is built at module load, ABOVE the merge: a resurrected field
// has no group, no slider and no way to be edited or removed from inside the
// game. `sealTeam.skin` (six squad palettes, deliberately dropped for the
// player's own surface) and `beluga.droneScale` (superseded by the model's own
// `fit`) are the two that surfaced this, and an audit against the built-in
// shape found 70 more — old field names from before boat crews were counted
// (`boats.crew.min`), from before the strike charged (`strike.maxCharges`),
// from before the crab had a spawn group (`enemies.walkingCrab.group`).
//
// DATA_SUBTREES is the other half, and the dangerous half. Some containers hold
// USER ENTRIES rather than a schema, so their children are supposed to be
// absent from this file and pruning them would delete real work. The audit
// above would have taken 146 such keys with it. Each one is listed with why:
const DATA_SUBTREES = [
  // Ships EMPTY on purpose (see the note there) — every entry is tuning.
  /^assetLooks$/,
  // The sound workbench writes a voice's take list (`srcs`) and its synth
  // fallback onto the def — those samples are the sound design, not a default.
  // The WHOLE container, not `sfx.<voice>`: the workbench's duplicate button
  // makes new voices too (it copies the def and appends a "2", see
  // workbench.js), so a voice name config.js has never heard of is a voice
  // somebody built. `oxygenWarn2` is one, and a per-voice rule ate it.
  /^sfx$/,
  /^ambient$/,
  // A preset is a DIFF against `base` and is SAVED as one (see
  // withoutInheritedPresetKeys), so a key config.js never declared is a
  // deliberate per-species override — and a reachable one, since the tuner
  // builds every preset's rows from one fixed item list. The preset NAMES are
  // still schema, and pruneUnknownGlowPresets owns those.
  /^biolumSkin\.presets\.[^.]+$/,
  // Keyed by asset, and the model panel adds a row for any asset you toggle.
  /^creatureOutline\.on$/,
];

// Walk every plain object, recording dotted paths. Arrays are leaves — they're
// values here (a frequency pair, a tier table), and deepMerge replaces them
// wholesale rather than merging them, so their indices are never keys.
function collectKeyPaths(obj, prefix, out) {
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) collectKeyPaths(v, path, out);
  }
  return out;
}

// `upgrades` is skipped for the reason it's skipped everywhere else: its
// entries carry apply() functions, it is never saved, and upgrades.csv owns
// the fields that are editable.
const BUILT_IN_KEY_PATHS = collectKeyPaths(
  Object.fromEntries(Object.keys(CONFIG).filter((k) => k !== 'upgrades').map((k) => [k, CONFIG[k]])),
  '', new Set(),
);

// What the NEXT level costs, given the level just reached and what the last
// one cost. Lives here beside the curve it reads so there is one definition of
// it — main.js used to inline the arithmetic, which is how the curve could
// only ever be a single multiplier.
export function xpForNextLevel(level, previous) {
  const c = CONFIG.xp;
  const factor = level >= (c.lateFrom ?? Infinity)
    ? (c.lateMul ?? c.mul)
    : level >= (c.midFrom ?? Infinity)
      ? (c.midMul ?? c.mul)
      : c.mul;
  return Math.floor(previous * factor + c.add);
}

// What one orb's listed xp is actually worth, at one moment in a run — see
// CONFIG.xp.dropRamp. Read once, where the orb drops, so an orb keeps whatever
// it was worth when it hit the water no matter how long it sits there.
export function chumValueRamp(difficulty) {
  const ramp = CONFIG.xp?.dropRamp;
  const start = ramp?.start ?? 1;
  const fullAt = ramp?.fullAt ?? 0;
  if (!(start < 1) || !(fullAt > 0)) return 1;
  const t = Math.min(1, Math.max(0, difficulty) / fullAt);
  return start + (1 - start) * t;
}

// The run-length stat multiplier for one stat, at one moment in a run — see
// CONFIG.spawn.ramp. Compounding rather than linear, because linear scaling
// is exactly what already exists per-species and what makes the tenth minute
// feel like the third. `which` is a key of CONFIG.spawn.ramp; the cap lives
// beside it as `<which>Max`.
//
// Lives here rather than in enemies.js so boats can use the same curve
// without the surface hazards importing the creature roster.
export function difficultyRamp(which, difficulty) {
  const ramp = CONFIG.spawn.ramp;
  const rate = ramp?.[which] ?? 0;
  if (!(rate > 0) || !(difficulty > 0)) return 1;
  const cap = ramp[`${which}Max`] ?? Infinity;
  return Math.min(cap, (1 + rate) ** difficulty);
}

// Drop any enemy a merge introduced that config.js doesn't define. Called
// after every path that merges tuning (disk file, localStorage cache, manual
// import), since all three can carry a roster older than the code.
function pruneUnknownEnemies() {
  for (const key of Object.keys(CONFIG.enemies)) {
    if (BUILT_IN_ENEMY_KEYS.has(key)) continue;
    delete CONFIG.enemies[key];
    console.warn(`[config] dropped saved tuning for removed enemy "${key}" — it is no longer in config.js.`);
  }
}

// Same job for the glow presets: a species preset deleted from config.js must
// not come back out of a snapshot as a group nobody can see and nothing wears.
// Called from every path that merges tuning, exactly like the roster above.
function pruneUnknownGlowPresets() {
  const presets = CONFIG.biolumSkin?.presets;
  if (!presets) return;
  for (const key of Object.keys(presets)) {
    if (BUILT_IN_GLOW_PRESETS.has(key)) continue;
    delete presets[key];
    console.warn(`[config] dropped saved tuning for removed glow preset "${key}" — it is no longer in config.js.`);
  }
}

// And the general case: drop any FIELD a merge introduced that config.js does
// not declare. See BUILT_IN_KEY_PATHS above for what this is for and, more
// importantly, for what DATA_SUBTREES keeps it away from.
//
// Runs after the two prunes above rather than instead of them. It would catch
// both — a removed creature and a removed preset are just unknown keys — but
// those two say what they dropped and why, and a roster entry deserves a louder
// line than a stray field. This is the net under them, not their replacement.
//
// One warning per boot, listing everything, because the alternative is 70
// console lines on a load that is otherwise working perfectly.
//
// linkCrabVariants() re-points these two at the day crab's blocks immediately
// after every merge (see the note there), so a snapshot's own copy of them is
// MEANT to be dropped — the drop is what makes the link stick. Deleted like
// anything else, but not reported: it happens on every load, and a warning
// that always fires is one nobody reads. Note they must not simply be treated
// as built-in instead: by the second merge path they ARE the day crab's
// objects, and descending into them would strip the walking crab's own
// behaviour out from under it.
const RELINKED_KEYS = new Set(['enemies.emberCrab.crawl', 'enemies.emberCrab.beatSync']);

function pruneUnknownKeys(obj = CONFIG, prefix = '', dropped = []) {
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === 'upgrades') continue;
    if (!BUILT_IN_KEY_PATHS.has(path)) {
      delete obj[key];
      if (!RELINKED_KEYS.has(path)) dropped.push(path);
      continue;
    }
    // Known key — descend, unless its children are user entries rather than a
    // shape this file declares.
    if (DATA_SUBTREES.some((re) => re.test(path))) continue;
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) pruneUnknownKeys(v, path, dropped);
  }
  if (!prefix && dropped.length) {
    console.warn(`[config] dropped ${dropped.length} saved value(s) config.js no longer declares:\n  ${dropped.join('\n  ')}`);
  }
  return dropped;
}

// A saved snapshot outranks the literal in this file, so a tuner slider aimed
// at the wrong SHAPE of value doesn't just save a bad number — it changes the
// type of that field for every load afterwards, and the file it came from
// can't correct it. `wallRocks.size` is a [smallest, largest] pair that was
// briefly bound to a single slider; the scalar it wrote destructured to
// `undefined` in wallRocks.js and took the whole boot down before the first
// frame, on disk AND in localStorage, with no way to reach the tuner to undo
// it. Healed at every merge path so the next save writes the pair back and
// the stored copies repair themselves.
//
// Kept narrow on purpose: an audit of all 1460 tuner paths against the
// defaults in this file found `wallRocks.size` to be the only scalar control
// pointed at an array, and it now has two sliders. This is the net under it.
function healNumberPair(obj, key, fallback) {
  const v = obj?.[key];
  if (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) return;
  // A bare number reads as the LARGEST of the pair, keeping the default's
  // proportional spread — that's the end of the range a "size" slider is
  // reaching for, and it keeps the variety the range exists to give.
  const healed = Number.isFinite(v) ? [v * (fallback[0] / fallback[1]), v] : [...fallback];
  if (!obj) return;
  obj[key] = healed;
  console.warn(`[config] saved tuning had "${key}" as ${JSON.stringify(v)} where a [min, max] pair belongs — using ${JSON.stringify(healed)}.`);
}

function healTunedShapes() {
  healNumberPair(CONFIG.wallRocks, 'size', [1.6, 4.4]);
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      deepMerge(tv, sv);
    } else {
      target[key] = sv;
    }
  }
}

// The built-in display fields of every upgrade, captured BEFORE the CSV is
// applied. applyUpgradeTable() resets to these first, so an upgrade whose row
// is deleted from the CSV goes back to its config.js values instead of keeping
// whichever edit was applied last.
const UPGRADE_BASE = new Map(CONFIG.upgrades.map((u) => [
  u.id,
  // `weight` is undefined here on purpose: config.js declares no rarity, so
  // the built-in state of every upgrade is "ordinary", which the offer pool
  // reads as 1. Listed rather than omitted so the reset contract is visible —
  // a row that loses its weight column goes back to this, not to whatever the
  // last edit set.
  { name: u.name, desc: u.desc, maxStacks: u.maxStacks, enabled: u.enabled, weight: undefined, cardArt: null, sfx: null },
]));

// Parsed once — the file can't change without a page reload, since it's the
// dev server that notices the write.
const UPGRADE_ROWS = parseUpgradeCsv(upgradesCsv);

// The rarity ladder's built-ins, captured before the CSV replaces them — the
// fallback buildRarities() falls back to, per field, and the whole table if the
// file turns out to be empty.
const RARITY_BASE = CONFIG.rarities.map((r) => ({ ...r }));
const RARITY_ROWS = parseRarityCsv(raritiesCsv);

// The same pair for the creature roster. `captureEnemyBase` runs HERE, above
// the merge below, for exactly the reason UPGRADE_BASE does: it has to hold
// what config.js declares, not what a saved snapshot last set.
const ENEMY_BASE = captureEnemyBase(CONFIG.enemies);
const ENEMY_ROWS = parseEnemyCsv(enemiesCsv);

// THE PATH TABLES — the balance numbers, keyed by a dotted CONFIG path. See
// pathTable.js for why these are files rather than sliders. Captured here for
// the same reason the two above are: the base must hold what config.js
// declares, not what a snapshot last set, and it is what a row DELETED from a
// CSV falls back to.
//
// `behaviour.csv` may write under `enemies`, which enemies.csv also writes —
// so it carries a veto for the flat per-creature columns that table owns. That
// is not hypothetical tidiness: the tuner shipped 50 sliders for
// `enemies.*.spawnRateMul` and `enemies.*.minPlayerLevel` that enemies.csv
// silently overwrote on every apply, and this is what stops the CSVs growing
// the same disagreement.
function enemyCsvOwns(id) {
  const m = /^enemies\.[A-Za-z0-9_]+\.([A-Za-z0-9_]+)$/.exec(id);
  if (m && ENEMY_TABLE_FIELDS.includes(m[1])) {
    return `enemies.csv already owns the "${m[1]}" column, and applyEnemyTable would overwrite this on the next apply.`;
  }
  return null;
}

const PATH_TABLES = [
  createPathTable({
    label: 'spawning', file: 'spawning.csv', text: spawningCsv,
    roots: ['spawn', 'crabSpawn', 'xp'],
  }),
  createPathTable({
    label: 'weapons', file: 'weapons.csv', text: weaponsCsv,
    // The ability blocks are here for their THROUGHPUT numbers only — damage,
    // cadence, counts, splash, uptime. Everything that is judged by eye while
    // it moves (orbit radius, pearl colour, the gull's whole flight model, the
    // scallop's jet) is deliberately still on a slider in the same block. See
    // pathTable.js: strip() is per-ROW, so those sliders keep working.
    roots: ['weapon', 'missile', 'bounce', 'shrimpRing', 'scallop', 'oyster', 'seagullBomb',
      'eel', 'sealTeam', 'beluga', 'club', 'clubThrow', 'clubBoom', 'clubIce'],
  }),
  createPathTable({
    label: 'behaviour', file: 'behaviour.csv', text: behaviourCsv,
    roots: ['bite', 'hunterRamp', 'apexCrowd', 'enemies'], forbid: enemyCsvOwns,
  }),
];
const PATH_BASES = PATH_TABLES.map((t) => t.captureBase(CONFIG));

// Project tuning imported from another session — merged before DEFAULTS so
// Reset and fresh loads match the exported values.
const diskTuning = withoutTableOwnedKeys(importedTuning);
for (const key of Object.keys(diskTuning)) {
  if (key === '_savedAt') continue; // bookkeeping, not a tunable value
  const sv = diskTuning[key];
  if (CONFIG[key] && typeof CONFIG[key] === 'object' && sv && typeof sv === 'object') {
    deepMerge(CONFIG[key], sv);
  } else if (sv !== undefined && typeof sv !== 'object') {
    CONFIG[key] = sv;
  }
}
pruneUnknownEnemies();
pruneUnknownGlowPresets();
pruneUnknownKeys();
healTunedShapes();

// The CSV is applied AFTER the merge, at every load path, so the file always
// wins over a saved snapshot. It has to be this way round: saved tuning is
// whatever the browser last cached, the file is what you just edited, and the
// one you just edited is the one you expect to see.
applyUpgradesFromTable();
applyEnemiesFromTable();
applyPathTables();

// Everything the tuner, the Look & Sound panel or the Reset button can touch
// gets saved — and this list is what decides that. It used to be written out
// by hand, one `key: CONFIG.key` line per section, which meant every section
// added afterwards had to be remembered here too. It wasn't: `sealTeam` had
// fourteen live sliders whose values were never written to disk, never
// restored on load and never reset. Deriving it from CONFIG means a new
// section is persisted the moment it exists.
//
// `upgrades` is the sole exclusion, and now for two reasons: each entry
// carries an apply() function that neither structuredClone nor JSON can
// carry, and its editable fields belong to upgrades.csv — saving them here
// would give them a second home that could disagree with the file.
const UNSAVEABLE_KEYS = new Set(['upgrades']);

export const DEFAULTS = structuredClone(Object.fromEntries(
  Object.keys(CONFIG).filter((k) => !UNSAVEABLE_KEYS.has(k)).map((k) => [k, CONFIG[k]]),
));

// ============================================================================
// PERSISTENCE — every section in DEFAULTS (i.e. everything the tuner or the
// Reset button can touch) is saved automatically on every tuner change, to
// TWO places:
//
//   1. path/src/imported-tuning.json, via the dev server (vite.config.js).
//      This is the durable copy: it survives clearing site data, travels
//      with the repo, and diffs in git. Tuning is a permanent edit to the
//      game, so the file is the source of truth.
//   2. localStorage, as an instant-restore cache and the fallback for when
//      there's no dev server to write through (a production build).
//
// On boot, imported-tuning.json is merged into CONFIG at module load, then
// any localStorage snapshot merges on top. Both are written together, so
// they agree; the localStorage layer only matters when disk writes aren't
// available.
//
// Note this makes imported-tuning.json the baseline DEFAULTS is captured
// from — so "Reset" returns you to the last values written to that file,
// not to whatever was originally typed into config.js.
// ============================================================================

const STORAGE_KEY = 'deep-run-tuning-v2';

// Reapply upgrades.csv over CONFIG.upgrades. Called after every path that
// merges saved tuning in, so the file always has the last word over a stale
// snapshot — apply() is never touched, only the display fields, so an edited
// upgrade still DOES the same thing, it's just named/described/capped
// differently.
export function applyUpgradesFromTable() {
  applyUpgradeTable(CONFIG.upgrades, UPGRADE_BASE, UPGRADE_ROWS, LEVELUP_IMAGE_KEYS, console.warn, Object.keys(CONFIG.sfx ?? {}));
  // The rarity ladder rides along on the same call for the same reason: this
  // runs after every path that merges saved tuning in, and a saved snapshot
  // from before a CSV edit must not outlive the file. Note the ARRAY IS
  // REPLACED rather than mutated in place — rarities.csv defines how many tiers
  // exist, so a row added to the file has to be able to add a rung.
  CONFIG.rarities = buildRarities(RARITY_ROWS, RARITY_BASE);
  checkRaritySfx(CONFIG.rarities, Object.keys(CONFIG.sfx ?? {}));
}

// The roster's equivalent, and it has to be called in all the same places for
// the same reason: the file is what you just edited, a snapshot is what the
// browser last cached, and the one you just edited is the one you expect to
// see. Only the flat stats are touched — the nested behaviour blocks are
// still ordinary saved tuning and still merge normally.
export function applyEnemiesFromTable() {
  applyEnemyTable(CONFIG.enemies, ENEMY_BASE, ENEMY_ROWS);
}

// The path tables' equivalent, called everywhere the other two are and for the
// same reason: the file is what you just edited, so it has to win over both a
// cached snapshot and a Reset.
export function applyPathTables() {
  PATH_TABLES.forEach((t, i) => t.apply(CONFIG, PATH_BASES[i]));
}

// The night crab walks, feeds and piles on EXACTLY like the day crab, because
// it is the day crab. Pointing its nested behaviour blocks at the originals is
// what keeps that true — a duplicate would be seventy lines of feeding tuning
// maintained in two places, and the copy would be stale the first time anyone
// dragged a slider.
//
// Runs AFTER tuning has been merged, and has to: the merge gives each crab its
// own copy of every nested block, so linking earlier would just be undone. The
// consequence is that the night crab always ends up wearing the day crab's
// behaviour even if a snapshot carried something else for it — which is the
// intended reading of "it is the same animal", and the only outcome that
// cannot drift.
//
// Nested blocks only. Every flat stat is enemies.csv's, and the two crabs
// genuinely differ there.
//
// --- and the LOOK -----------------------------------------------------------
// `sizeMultiplier` is the trap. CONFIG.assetLooks ships EMPTY — every entry in
// it is tuning — so a newly added asset starts at 1 while the thing it is a
// variant of may have been dragged to something else entirely. The walking crab
// sits at 2.42, so without this the night crab is the same animal at 40% scale,
// and because the hitbox is derived from the visual scale it would be a
// correspondingly smaller target too.
//
// Mirrored rather than hardcoded: writing 2.42 into config.js would be a second
// copy of a number the user can drag, and the two would disagree the first time
// they did. Only the size is copied — glow and emissive are deliberately left
// alone, since the ember crab is unlit with no emissive mask and gets its light
// from `emberClaw` instead.
//
// Not written into imported-tuning.json, which the live game rewrites from its
// own state; a field config.js owns is the thing that survives.
function linkCrabVariants() {
  const day = CONFIG.enemies.walkingCrab;
  const night = CONFIG.enemies.emberCrab;
  if (!day || !night) return;
  night.crawl = day.crawl;
  night.beatSync = day.beatSync;

  // The size mirroring that used to live here is gone: assets.csv carries an
  // explicit row for each crab, which is better than a copy made at boot —
  // the two numbers are now visible side by side instead of one being an
  // invisible echo of the other.
}
linkCrabVariants();

// Everything a CSV owns, taken back out of a snapshot on its way in.
//
// Three of these used to be saved tuning, and every snapshot written before
// the move to a file still carries them. Left alone they'd merge back into
// CONFIG, get written out again on the next save, and sit in the file forever
// looking like live settings while nothing read them.
//
// `upgradeOverrides` and the card `assignments` are whole keys and simply go.
// The creature stats are one level deeper — CONFIG.enemies is still saved
// tuning for its nested blocks (swarm weights, hunt radii, the crawl feed
// rules), so only the flat fields enemies.csv owns are lifted out and the
// rest of each creature is left exactly as it was.
function withoutTableOwnedKeys(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { upgradeOverrides, ...rest } = snapshot;
  if (rest.levelUpCards?.assignments) {
    const { assignments, ...cards } = rest.levelUpCards;
    rest.levelUpCards = cards;
  }
  if (rest.enemies) rest.enemies = withoutEnemyTableFields(rest.enemies);
  // Spawn size is assets.csv's now. The model panel wrote it for months, so
  // every snapshot still carries one per asset — left in, a stale drag (the
  // walking crab reached 10.46) would keep winning over the file.
  if (rest.assetLooks) rest.assetLooks = withoutAssetTableFields(rest.assetLooks);
  // THE BLOOM KNOB'S SHADOW. `glow` is declared on biolumSkin.base ONLY, and
  // documented there as the one control that moves the whole family's bloom
  // together. The tuner writes a full resolved copy of every preset, so a save
  // stamped `glow` onto all six — and since a preset resolves as
  // { ...base, ...preset }, those copies shadowed the base outright. Dragging
  // the family knob did nothing, and the presets sat at whatever multiplier
  // was current the day the snapshot was written (2, against a base of 1.35),
  // which put every creature's whole breath above the composite's clip.
  //
  // Stripped rather than reconciled because there is nothing to reconcile:
  // config.js declares no per-preset glow, so every copy is an echo. Per-preset
  // `strength` is NOT stripped — that one has a real slider, a real default in
  // config.js, and is meant to differ per species.
  if (rest.biolumSkin?.presets) {
    const presets = {};
    for (const [name, p] of Object.entries(rest.biolumSkin.presets)) {
      if (p && typeof p === 'object' && 'glow' in p) {
        const { glow, ...keep } = p;
        presets[name] = keep;
      } else presets[name] = p;
    }
    rest.biolumSkin = { ...rest.biolumSkin, presets };
  }
  if (rest.emitters) rest.emitters = withoutCodeOwnedFields(rest.emitters, ['colors']);
  if (rest.feedback) rest.feedback = withoutCodeOwnedFields(rest.feedback, ['emit']);
  // The voice cap has never had a control either — the Sound tab tunes levels
  // and the bus, not polyphony — so every snapshot carrying `maxConcurrent` is
  // an echo of whatever config.js held the day it was written. Left in, that
  // echo wins: raising the cap in source would do nothing at all, because a
  // snapshot on disk AND one in localStorage both still said 12. Everything
  // else under `audio` is real, reachable tuning and merges normally.
  if (rest.audio && 'maxConcurrent' in rest.audio) {
    const { maxConcurrent, ...audio } = rest.audio;
    rest.audio = audio;
  }
  // GRAVITY'S OLD ADDRESSES. It used to be five numbers in five sections —
  // the player's `airGravity`, a ragdoll's, a debris chunk's, a tossed orb's
  // and the dolphin's — all of them somewhere between 9 and 29.5 and none of
  // them agreeing. They are one number now (`arena.gravity`, see the note
  // there), so nothing reads any of these; every snapshot on disk still
  // carries all five. Dropped on the way in so they stop travelling, and so
  // nobody later edits a 22 that has not done anything for months.
  //
  // The list is inline rather than a module const because this function runs
  // during module init, above where such a const would be declared — a `const`
  // does not hoist, and the boot dies in its temporal dead zone.
  for (const dead of [
    'arena.airGravity',
    'boats.crew.gravity',
    'boats.debris.gravity',
    'pickups.toss.gravity',
    'enemies.dolphin.porpoise.gravity',
  ]) {
    const keys = dead.split('.');
    const field = keys.pop();
    const owner = keys.reduce((o, k) => (o == null ? o : o[k]), rest);
    if (owner && typeof owner === 'object' && field in owner) delete owner[field];
  }
  // The spawn knobs, which spawning.csv now owns outright. Every snapshot
  // written before that table existed still carries them, and a saved value
  // beats a config.js default — left in, editing the CSV would appear to do
  // nothing at all. LAST, so it sees everything the strips above left behind.
  return stripAllTables(rest, PATH_TABLES);
}

// Fields inside a saved snapshot that config.js owns outright.
//
// The tuner has never had a control for a burst's palette or for which emitter
// an event fires — a snapshot carries them only because it saves whole objects,
// so what's in the file is an echo of whatever config.js held on the day it was
// written. Left in, that echo is authoritative: the palettes are the one part
// of the particle design that has to hold across the whole game (see the note
// on CONFIG.emitters), and a months-old snapshot would quietly put the rainbow
// back every time it loaded, whatever the source says.
//
// Everything the tuner CAN reach — count, size, speed, life, glow, cone — is
// left exactly as saved. This drops nothing anyone tuned.
function withoutCodeOwnedFields(section, fields) {
  if (!section || typeof section !== 'object') return section;
  const out = {};
  for (const [name, entry] of Object.entries(section)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out[name] = entry;
      continue;
    }
    const kept = { ...entry };
    for (const f of fields) delete kept[f];
    out[name] = kept;
  }
  return out;
}

// Overwrite `target` with `source` in place, preserving the identity of every
// nested plain object rather than swapping it for a clone.
//
// The delete pass matters as much as the copy: a key added since boot (an
// `assetLooks` entry for a creature you just tinted, say) has no counterpart
// in DEFAULTS and would otherwise survive the Reset that was meant to clear it.
//
// Arrays are replaced wholesale, deliberately. They're values here — a
// frequency pair, a haptic pulse list, the pickup tier table — and nothing
// captures an array itself the way the panels capture objects, so preserving
// their identity would buy nothing and merging them element-wise would leave
// a longer stale array's tail behind.
function deepReplace(target, source) {
  for (const k of Object.keys(target)) {
    if (!(k in source)) delete target[k];
  }
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = target[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)
        && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      deepReplace(tv, sv);
    } else {
      // Cloned, or Reset would hand out a live reference INTO DEFAULTS and the
      // next slider drag would quietly edit the baseline it resets to.
      target[k] = sv && typeof sv === 'object' ? structuredClone(sv) : sv;
    }
  }
}

// Snap every saved section back to the baseline captured at boot (i.e. what
// imported-tuning.json holds on disk). Lives here rather than in the tuner so
// the upgrade table can't be left out of it again.
export function resetConfigToDefaults() {
  for (const key of Object.keys(DEFAULTS)) {
    const dv = DEFAULTS[key];
    // Scalar sections (`view`, `upgradeChoices`) are assigned; Object.assign
    // onto a primitive throws trying to write its read-only character
    // indices, which used to abort this loop partway through.
    if (!dv || typeof dv !== 'object') {
      CONFIG[key] = dv;
      continue;
    }
    // Replace the section's CONTENTS, keeping the object identity other
    // modules captured a reference to — RECURSIVELY, which is the part this
    // used to get wrong. It kept the identity of `CONFIG.feedback` but swapped
    // every child inside it for a fresh clone, and the panels that edit those
    // children capture the CHILD, not the section: the Sound tab holds
    // `CONFIG.sfx.kill`, the Haptics tab holds `CONFIG.feedback.strike`, the
    // Particles tab holds `CONFIG.emitters.sparks`. After one Reset every one
    // of those references pointed at an orphaned object, so the rows went on
    // writing into garbage — sliders moved, nothing changed, nothing saved,
    // and only a reload fixed it.
    deepReplace(CONFIG[key], dv);
  }
  applyUpgradesFromTable();
  applyEnemiesFromTable();
  applyPathTables();
}

// Stamped into every snapshot so the two copies can be ordered on load.
// Without it there's no way to tell a stale browser cache from a fresh one
// that's holding edits the disk write never received.
const SAVED_AT = '_savedAt';

function tuningSnapshot() {
  const snapshot = {};
  for (const key of Object.keys(DEFAULTS)) snapshot[key] = CONFIG[key];
  // The creature stats belong to enemies.csv, so they must not be written
  // here as well. Stripping them on the way in (see withoutTableOwnedKeys)
  // stops a stale copy winning, but only NOT WRITING them keeps the file
  // honest — otherwise every save puts twenty creatures' worth of hp and
  // speed back into imported-tuning.json, where they'd read as live settings
  // and disagree with the CSV the moment you edited one. The nested blocks
  // survive: those are still tuner-owned and still need saving.
  snapshot.enemies = withoutEnemyTableFields(CONFIG.enemies);
  // ...and it goes out the same way it comes in, or every save would quietly
  // re-accumulate the field the file owns.
  snapshot.assetLooks = withoutAssetTableFields(CONFIG.assetLooks);
  // Same reasoning one level along: a bioluminescence preset is a DIFF against
  // `base`, and the tuner writes whole objects. Saving a preset in full pins
  // every key it never meant to override, so the first drag of any species
  // slider silently severs that species from the shared base — and the "shared
  // base" group in the tuner then moves nothing, which looks like a broken
  // control rather than a save artifact.
  //
  // A key deliberately set to the same value as base is dropped here and then
  // inherits it, which is the same value by a different route. That is what a
  // diff means, and it is the trade the enemies table already makes.
  snapshot.biolumSkin = withoutInheritedPresetKeys(CONFIG.biolumSkin);
  // The spawn knobs go out the same way they come in — spawning.csv owns them,
  // so writing them here would give them a second home that could disagree
  // with the file. Both halves are needed: stripping only on load would leave
  // the snapshot quietly accumulating them again on every save.
  const stripped = stripAllTables(snapshot, PATH_TABLES);
  stripped[SAVED_AT] = Date.now();
  return stripped;
}

// Drop every preset key that merely restates `base`. Returns a new object; the
// input is the live CONFIG and must not be mutated.
//
// Exported for tools/biolum-skin-test.mjs. Dropping a key the user meant to
// keep is the worst thing this function can do, and it happens on the save
// path where nothing would report it.
export function withoutInheritedPresetKeys(skin) {
  if (!skin?.presets) return skin;
  const base = skin.base ?? {};
  const presets = {};
  for (const [name, preset] of Object.entries(skin.presets)) {
    const diff = {};
    for (const [k, v] of Object.entries(preset ?? {})) {
      if (v !== base[k]) diff[k] = v;
    }
    presets[name] = diff;
  }
  return { ...skin, presets };
}

// Writing to disk goes through the dev server (see vite.config.js), so it's
// coalesced: dragging a slider fires a change per frame, and each one would
// otherwise be its own file write.
let diskSaveTimer = null;
let pendingSnapshot = null;
let warnedNoDisk = false;
let onDiskSaveError = null;

// Lets the tuner surface a failed save in its status line. A console warning
// is not good enough for this — silently losing tuning is the single worst
// thing this file can do, and it has happened.
export function setTuningSaveErrorHandler(fn) {
  onDiskSaveError = fn;
}

function writeCache(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[config] could not save tuning to localStorage —', err?.message ?? err);
  }
}

function postTuning(snapshot) {
  return fetch('/__tuning', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pendingSnapshot = null;
    // Mirror the SAME snapshot (same `_savedAt`) into the cache only once
    // disk has it. Writing the cache first would leave its timestamp
    // permanently ahead of the file, so every load would take the cache
    // branch and the file would never actually be the authority.
    writeCache(snapshot);
  }).catch((err) => {
    // Disk refused it — now the cache is the only copy, and its newer
    // timestamp is exactly what tells the next load to prefer it.
    writeCache(snapshot);
    // Deliberately NOT latched off after one failure. An earlier version
    // disabled disk saves permanently on the first error while dev mode had
    // also stopped writing localStorage — so a single hiccup (a dev server
    // started before this endpoint existed, say) meant every later edit went
    // nowhere at all, silently. Retry on the next save instead.
    if (!warnedNoDisk) {
      warnedNoDisk = true;
      console.warn('[config] could not write tuning to disk —', err?.message ?? err,
        '\n  Edits are still cached in this browser. Run `npm run dev` so they persist to imported-tuning.json.');
    }
    onDiskSaveError?.(err?.message ?? String(err));
  });
}

function saveTuningToDisk(snapshot) {
  pendingSnapshot = snapshot;
  if (diskSaveTimer) clearTimeout(diskSaveTimer);
  diskSaveTimer = setTimeout(() => {
    diskSaveTimer = null;
    postTuning(snapshot);
  }, 400);
}

// A debounced save is still in flight when the page reloads (Vite HMR does
// this constantly while editing). Without a flush, the last edit before a
// reload is the one that gets lost — which reads exactly like "my settings
// reset again".
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!pendingSnapshot) return;
    if (diskSaveTimer) { clearTimeout(diskSaveTimer); diskSaveTimer = null; }
    // keepalive lets the request outlive the page teardown.
    try {
      fetch('/__tuning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingSnapshot),
        keepalive: true,
      });
    } catch { /* nothing more we can do at teardown */ }
  });
}

export function saveTuningToStorage() {
  const snapshot = tuningSnapshot();
  // In dev the disk write drives everything and mirrors into the cache when
  // it resolves (see postTuning) — so the cache is a real fallback without
  // ever becoming a stale override. In production there's no dev server, so
  // the cache is the only store and gets written directly.
  if (import.meta.env?.DEV) saveTuningToDisk(snapshot);
  else writeCache(snapshot);
}

// Call once at boot, before anything else reads CONFIG. Returns true if a
// saved snapshot was found and applied.
// Merge a saved snapshot INTO the live config rather than replacing whole
// sections. `Object.assign(CONFIG.animation, saved.animation)` swaps the
// entire object, so any key added to config.js SINCE that snapshot was saved
// silently vanishes — a save from before the new animation states existed
// would drop states.surfaceIdle / strike / oneShotPriority entirely, and the
// state machine would then quietly misbehave until you touched a control
// (which re-saves the complete current config and rebuilds). That's exactly
// the "animations don't respond until I adjust a param" symptom. Recursing
// means saved values win for keys they actually contain, and everything else
// keeps its config.js default.
export function loadTuningFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const snapshot = withoutTableOwnedKeys(JSON.parse(raw));

    // Both copies carry a timestamp, so "which is authoritative" is a
    // question with an answer rather than a fixed precedence rule.
    // - cache NEWER than the file: it holds edits the disk write never
    //   landed (no dev server, a failed POST), so apply it.
    // - cache OLDER or equal: the file already has everything, and applying
    //   the cache would resurrect stale values AND write them back over the
    //   file on the next save. Skip it.
    const cacheAt = Number(snapshot[SAVED_AT] ?? 0);
    const diskAt = Number(importedTuning?.[SAVED_AT] ?? 0);
    if (import.meta.env?.DEV && cacheAt <= diskAt) return false;

    for (const key of Object.keys(snapshot)) {
      if (key === SAVED_AT) continue;
      const sv = snapshot[key];
      if (CONFIG[key] && typeof CONFIG[key] === 'object' && sv && typeof sv === 'object') {
        deepMerge(CONFIG[key], sv);
      } else if (sv !== undefined && typeof sv !== 'object') {
        CONFIG[key] = sv; // top-level scalars: view, upgradeChoices
      }
    }
    pruneUnknownEnemies();
    pruneUnknownGlowPresets();
    pruneUnknownKeys();
    healTunedShapes();
    linkCrabVariants();
    applyUpgradesFromTable();
    applyEnemiesFromTable();
    return true;
  } catch (err) {
    console.warn('[config] saved tuning was unreadable, using config.js defaults —', err?.message ?? err);
    return false;
  }
}

// Apply an exported tuning file. Goes through the same deep merge as a
// saved snapshot, so importing an older file adds its values without
// deleting anything that's been added to config.js since it was exported.
export function importTuning(rawSnapshot) {
  const snapshot = withoutTableOwnedKeys(rawSnapshot);
  for (const key of Object.keys(snapshot)) {
    const sv = snapshot[key];
    if (CONFIG[key] && typeof CONFIG[key] === 'object' && sv && typeof sv === 'object') {
      deepMerge(CONFIG[key], sv);
    } else if (sv !== undefined && typeof sv !== 'object') {
      CONFIG[key] = sv;
    }
  }
  pruneUnknownEnemies();
  pruneUnknownGlowPresets();
  pruneUnknownKeys();
  healTunedShapes();
  linkCrabVariants();
  applyUpgradesFromTable();
  applyEnemiesFromTable();
  applyPathTables();
}

export function clearSavedTuning() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[config] could not clear saved tuning —', err?.message ?? err);
  }
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}
