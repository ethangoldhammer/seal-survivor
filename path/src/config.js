import importedTuning from './imported-tuning.json';
import upgradesCsv from './upgrades.csv?raw';
import { parseUpgradeCsv, applyUpgradeTable } from './upgradeTable.js';

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
    wallRestitution: 0.5, // 0 = stick to wall, 1 = perfect bounce
    airGravity: 29.5, // >0 arcs you back down after breaching the surface
    showDepthLines: true,
    depthLineSpacing: 6,
    waveAmplitude: 0.35,
    waveSpeed: 0.8,
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

  caustics: {
    enabled: true,
    intensity: 0.4, // brightness of the light veins
    scale: 0.16, // world units per pattern cycle — smaller = finer veins
    speed: 0.55,
    falloff: 1.6, // how fast caustics fade with depth (higher = shallower-only)
    color: 0xbfefff,
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
  },

  player: {
    maxHp: 100,
    thrustEnabled: true,
    thrust: 19,
    friction: 0.965, // per-frame drag at 60fps, applied framerate-independently
    maxSpeed: 34,
    hitRadius: 1.0,
    pickupRadius: 3,
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
  //   2-5      otter 2, animatedCrab 2, mightyMeg 3, megalodon 4, shark 5
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
      enemyAnimatedCrab: false,
    },
  },

  weapon: {
    // The basic shot grows on its own as you level, so it stays relevant
    // without needing an upgrade pick every time. Extra pellets arrive on a
    // fixed level cadence on top of that.
    damagePerLevel: 1.6,
    speedPerLevel: 0.35,
    levelsPerExtraShot: 8,
    autofire: true, // when true, holding down input.firing isn't needed
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
    contactDamage: 4,
    contactCooldown: 0.4, // per-shrimp, so one doesn't melt an enemy alone
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
      chumRefill: 0.2, // bar returned per chum swallowed
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

      // --- the feel of winding one up ---------------------------------------
      // Burning fuel should be felt, and it should build. The shake is
      // SUSTAINED — a continuous tremble that grows with banked power, not a
      // per-event jolt (see addSustainedShake in systems/feedback.js) — while
      // the rumble has to be re-triggered on an interval, because a motor can
      // only be handed discrete pulses.
      shake: 0.09,          // at fully banked power, scaling up from 0
      hapticInterval: 0.07, // seconds between rumble pulses while holding
      flashTime: 0.28,      // the bar flashing as it is spent, on release

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
    damage: 40,
    // "About a second" — long enough to swim into the chum a kill just
    // dropped, short enough that a combo has to be actively fed.
    chainWindow: 1.0, // seconds after a link to land the next one
    chainDamageMul: 1.15, // damage multiplier added per chain step
    // A dash used to be a fixed straight line — the impulse set velocity once
    // and nothing could steer it, so the whole 0.22s read as an animation you
    // waited out. Now the dash holds its SPEED but swings its heading toward
    // the stick at a capped angular rate, which is a turn RADIUS of
    // dashSpeed / dashTurnRate (46 / 12 ≈ 3.8 world units at defaults).
    dashTurnRate: 12, // radians/sec the dash heading can swing toward input
    dashFaceLerp: 22, // facing rotation speed while dashing (replaces player.turnLerp)
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
      chumFull: true,
      schoolWipe: true, // emptying a whole school inside one dash
      breach: true,   // crossing the surface upward — gated on the Porpoising upgrade
      // No cooldown on chumFull: the meter IS its rate limit. It takes
      // 1/chumRefill orbs to earn each link, which is a far better throttle
      // than a timer — it scales with how much food is actually there.
      cooldowns: { chumFull: 0, schoolWipe: 0, breach: 0.6 },
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
    // Ring meter drawn around the ship (replaces the numeric charge counter).
    ring: {
      radius: 1.9,
      thickness: 0.16,
      color: 0x7ad7ff,
      readyColor: 0x9dffd0,
      comboColor: 0xffe066,
      glow: 2.2,
      pulseSpeed: 9, // flashes per second while a combo is live
      segmentGap: 0.12, // radians of gap between charge segments
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
    fireRate: 1.4,
    baseDamage: 14,
    damagePerLevel: 6,
    baseChainRadius: 6,
    radiusPerLevel: 1.2,
    baseMaxChain: 2,
    chainPerLevel: 1,
    initialRange: 14, // how far the FIRST zap can reach from the player
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
    baseFireRate: 3.5, // seconds between runs at level 1
    fireRatePerLevel: 0.85, // multiplier per level (compounds, faster each level)
    damage: 60, // direct hit on the crab it lands on
    splashDamage: 20, // AoE to anything else nearby on impact
    splashRadius: 3,
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
    maxSeals: 6,
    contactDamage: 14,
    damagePerLevel: 5,
    contactRadius: 0.9,
    // Per-TARGET, so a seal in a crowd works through all of them rather than
    // hammering only the first one it found.
    contactCooldown: 0.5,
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
    evolveLevel: 6,
    evolved: {
      fireRate: 1.1, // seconds between shots, per seal
      damageMul: 0.5,
      speedMul: 0.9,
      range: 16, // won't shoot at anything farther away than this
    },
  },

  beluga: {
    fireRate: 2.2,
    speed: 12,
    life: 3,
    trapDuration: 2.5,
    baseBubbleRadius: 0.35,
    radiusPerLevel: 0.12,
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
    netColor: 0xbfe9ff,
    netOpacity: 0.18,
    haulSpeed: 5.5, // how fast a catch is dragged up toward the hull
    haulCatchGap: 0.6, // how close to the hull counts as landed
    bobSpeed: 1.6,
    bobAmount: 0.22,
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
  },

  spawn: {
    difficultyPerSecond: 1 / 20, // difficulty 1.0 every 20s
    baseInterval: 1.4,
    intervalPerDifficulty: 0.08,
    minInterval: 0.35,
    countPerDifficulty: 0.35,
    maxAlive: 220,

    // Population ceilings for a WHOLE FAMILY of creatures, applied on top of
    // each species' own `maxConcurrent`. Tag a creature with `spawnGroup` and
    // it draws from the shared allowance here.
    //
    // The apex group exists because the per-species caps only ever asked "how
    // many of THIS one", and every big predator answered separately: shark 6
    // + greatWhite 4 + dolphin 4 + megalodon 2 + mightyMeg 2 + orca 2 is 20
    // large bodies that could legally be on
    // screen at once, none of them over its own limit. That reads as a crowd
    // rather than as a threat, buries the player's own silhouette, and is now
    // also the expensive case — every one of these carries a tail spring.
    //
    // Whichever of them spawns first takes the slot; nothing here reserves
    // room for the rarer ones, since they are already gated behind
    // minDifficulty and minPlayerLevel.
    groupMaxAlive: { apex: 8 },

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
        preyRadius: 18, // breaks off to chase fish inside this range
        biteRange: 1.6,
        biteCooldown: 1.2,
        healPerMeal: 8, // eating a fish makes a shark tougher
        maxOverheal: 1.5, // ceiling, as a multiple of spawn hp
        growPerMeal: 0.03, // visual scale bump per meal
        maxGrow: 1.35,
        wanderChange: 1.8, // seconds between direction changes when idle
      },
      weight: 0.15,
      weightPerDifficulty: 0.03,
      maxWeight: 0.5,
      maxConcurrent: 6, // sharks are a threat, not a crowd
      // ...and the whole family shares one allowance on top of that, so six
      // sharks means no room for a megalodon. See CONFIG.spawn.groupMaxAlive.
      spawnGroup: 'apex',
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
      hunt: { preyRadius: 20, biteRange: 1.8, biteCooldown: 1.1, healPerMeal: 10, maxOverheal: 1.5, growPerMeal: 0.03, maxGrow: 1.35, wanderChange: 2 },
      weight: 0.14, weightPerDifficulty: 0.035, maxWeight: 0.45, maxConcurrent: 4, minDifficulty: 1.5,
      spawnGroup: 'apex',
    },
    megalodon: {
      separates: true,
      asset: 'enemyMegalodon', behavior: 'hunt', faceMotion: true,
      radius: 2.2, hp: 220, hpPerDifficulty: 20, speed: 5.5, speedVariance: 0.8,
      contactDamage: 42, xp: 40, turnRate: 1.6,
      hunt: { preyRadius: 24, biteRange: 2.6, biteCooldown: 1.4, healPerMeal: 16, maxOverheal: 1.4, growPerMeal: 0.02, maxGrow: 1.25, wanderChange: 2.4 },
      weight: 0.05, weightPerDifficulty: 0.015, maxWeight: 0.18, maxConcurrent: 2, minDifficulty: 3,
      spawnGroup: 'apex',
    },
    mightyMeg: {
      separates: true,
      asset: 'enemyMightyMeg', behavior: 'hunt', faceMotion: true,
      radius: 2.0, hp: 190, hpPerDifficulty: 18, speed: 6, speedVariance: 0.9,
      contactDamage: 38, xp: 36, turnRate: 1.8,
      hunt: { preyRadius: 22, biteRange: 2.4, biteCooldown: 1.3, healPerMeal: 15, maxOverheal: 1.4, growPerMeal: 0.02, maxGrow: 1.25, wanderChange: 2.2 },
      weight: 0.05, weightPerDifficulty: 0.015, maxWeight: 0.18, maxConcurrent: 2, minDifficulty: 2.6,
      spawnGroup: 'apex',
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
      // `strides` is how many steps this model's clip loop contains (measured
      // from the foot bones: crabwalking.glb packs 5 into its 3.33s take).
      beatSync: { beatsPerStride: 1, strides: 5, subdivisions: [2, 1, 0.5, 0.25] },
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
        },
      },
      weight: 0.35, weightPerDifficulty: 0.03, maxWeight: 0.6, maxConcurrent: 10, minDifficulty: 0.4,
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
      hunt: { preyRadius: 34, biteRange: 2.2, biteCooldown: 0.45, healPerMeal: 22,
              maxOverheal: 2.4, growPerMeal: 0.035, maxGrow: 1.6, wanderChange: 2 },
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
      porpoise: { interval: 6, launchSpeedX: 9, launchSpeedY: 17, gravity: 26, launchDepth: 6 },
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

    // Unkillable by construction rather than by a special case: an HP pool
    // nothing in the game can chew through. That keeps every damage source
    // (bullets, garlic, strike, seal team) working normally with no
    // invulnerability flag to thread through all of them. xp 0 so it would
    // award nothing even if something did finish it.
    seaTurtle: {
      separates: true,
      asset: 'enemySeaTurtle', behavior: 'drift', faceMotion: true,
      radius: 1, hp: 1e9, hpPerDifficulty: 0,
      speed: 1.6, speedVariance: 0.4, contactDamage: 8, xp: 0,
      drift: { wanderChange: 4 },
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

    // Slots into the existing crab layer alongside walkingCrab — same crawl
    // behaviour and the same seabed rules. Note crabSpawner does NOT pull
    // this one: pile-triggered swarms are walkingCrab only, so this arrives
    // through the ordinary weighted spawn pool.
    animatedCrab: {
      // gaitTravel +1: 'Derecha' (the clip this one walks on) carries it
      // toward +X, the mirror of the walking crab. The file also ships an
      // authored 'Izquierda' for the other direction — reversing Derecha
      // produces the same motion, so it goes unused, but it's there if the
      // reversal ever reads wrong.
      asset: 'enemyAnimatedCrab', behavior: 'crawl', faceCamera: true, gaitTravel: 1,
      collides: true,
      radius: 0.7, hp: 30, hpPerDifficulty: 3.5,
      speed: 3.4, speedVariance: 0.8, contactDamage: 11, xp: 8,
      // Same ramp as the walking crab — see the notes there.
      scalePerDifficulty: 0.015, maxGrowth: 1.6,
      contactDamagePerDifficulty: 0.4,
      speedPerDifficulty: 0.04,
      // 'Derecha' is a single stride, so one loop is one step.
      beatSync: { beatsPerStride: 1, strides: 1, subdivisions: [2, 1, 0.5, 0.25] },
      crawl: { aggroRadius: 12, wanderChange: 2.5, groundHeight: 2.5,
               floorRushHeight: 10.5, rushAggroRadius: 999, rushSpeedMul: 2.5,
               // Eats a little faster than the walking crab — same seek, less
               // patience, so a mixed swarm strips a pile unevenly.
               feed: { seekRadius: 120, eatRange: 1.1, eatTime: 1.8, reacquire: 0.4, distanceBias: 18 } },
      weight: 0.3, weightPerDifficulty: 0.025, maxWeight: 0.55,
      maxConcurrent: 10, minDifficulty: 0.4, spawnRateMul: 1, minPlayerLevel: 4,
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
  },

  // ---------------------------------------------------------------------------
  // EMITTERS — named particle bursts. Reference these from `feedback` below.
  // speed/size/life are [min, max] ranges. cone = 0 means a full circle.
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
    explosion: {
      count: 46, speed: [4, 24], size: [0.1, 0.34], life: [0.35, 0.9],
      colors: [0xff4d6d, 0xffb347, 0xffe066, 0xffffff], cone: 0, drag: 2.2,
      gravity: [0, -1.4], inherit: 0.2, glow: 2.2,
    },
    bigExplosion: {
      count: 110, speed: [5, 34], size: [0.14, 0.5], life: [0.5, 1.3],
      colors: [0xff4d6d, 0xc44dff, 0xffb347, 0xffffff], cone: 0, drag: 1.8,
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
    levelUp: {
      count: 80, speed: [6, 20], size: [0.12, 0.36], life: [0.6, 1.2],
      colors: [0x7ad7ff, 0x8effa1, 0xffe066, 0xffffff], cone: 0, drag: 1.6,
      gravity: [0, 1], inherit: 0, glow: 2.8,
    },
    // Bubbles rise, so their gravity is POSITIVE — and low drag is what lets
    // them keep rising for their whole life instead of stalling a few frames
    // after they leave the seal. Modest glow: these are ambient, and at this
    // spawn rate anything brighter turns into a permanent haze around the
    // player.
    breathBubbles: {
      count: 4, speed: [0.6, 2.2], size: [0.07, 0.18], life: [0.9, 1.9],
      colors: [0xbfefff, 0xffffff, 0x9fe8ff], cone: 0.55, drag: 1.1,
      gravity: [0, 4.5], inherit: 0.2, glow: 1.0,
    },
    wakeBubbles: {
      count: 2, speed: [0.8, 3.0], size: [0.05, 0.14], life: [0.6, 1.4],
      colors: [0x9fe8ff, 0xdff6ff, 0xffffff], cone: 0.6, drag: 1.6,
      gravity: [0, 3.2], inherit: 0.3, glow: 0.9,
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
    // A hard kick that decays — the dash shoving off, not a flat buzz. NOTE:
    // imported-tuning.json still has this as null and wins over these defaults
    // in dev, so a saved-tuning session needs it set there too.
    boost:     { emit: 'boost',       shake: 0.03, hitstop: 0,     glow: 0.1,  ripple: { strength: 1.1, radius: 6 },   sfx: null,       haptic: [{ duration: 45, magnitude: 0.85 }, { duration: 70, magnitude: 0.3, delay: 0 }] },
    // `sfxMinGap` is what keeps the impact sound from thickening every time
    // you take Multishot. A volley lands all its pellets inside one frame, so
    // without it a six-pellet burst played six copies of `hit` stacked on top
    // of each other — the same sound, six times louder, for the same volley.
    // One frame's worth of hits is one impact; the sparks, shake and ripple
    // are untouched and still fire per pellet.
    bulletHit: { emit: 'sparks',      shake: 0.03, hitstop: 0,     glow: 0.25, ripple: { strength: 0.8, radius: 4 },   sfx: 'hit',      haptic: [10], sfxMinGap: 0.05 },
    kill:      { emit: 'explosion',   shake: 0.22, hitstop: 0,     glow: 0.6,  ripple: { strength: 2.4, radius: 10 },  sfx: 'kill',     haptic: [18] },
    bigKill:   { emit: 'bigExplosion',shake: 0.7,  hitstop: 0.07,  glow: 1.2,  ripple: { strength: 4.5, radius: 18 },  sfx: 'bigKill',  haptic: [30, 25, 45] },
    playerHit: { emit: 'playerHit',   shake: 0.5,  hitstop: 0.06,  glow: 0.9,  ripple: { strength: 3.0, radius: 12 },  sfx: 'playerHit',haptic: [45] },
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
    levelUp:   { emit: 'levelUp',     shake: 0.4,  hitstop: 0,     glow: 0.8,  ripple: { strength: 3.5, radius: 22 },  sfx: 'levelUp',  haptic: [20, 40, 20] },
    breach:    { emit: 'splash',      shake: 0.2,  hitstop: 0,     glow: 0.3,  ripple: { strength: 2.0, radius: 9 },   sfx: 'splash',   haptic: [12] },
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
    // An enemy sealed in a bubble. Was playing `bulletHit` — an impact sound
    // for something that deals no damage at all.
    belugaTrap:  { emit: 'breathBubbles', shake: 0.02, hitstop: 0, glow: 0.2, ripple: { strength: 0.6, radius: 5 }, sfx: 'belugaTrap',
                   haptic: [{ duration: 18, magnitude: 0.3 }], sfxMinGap: 0.05 },
    // The net dragging a fish off. Counts as a kill everywhere else in the
    // game, but it isn't one to the hand — nothing was hit, something was
    // taken away, so it's a pull rather than a knock.
    bakalarHaul: { emit: 'breathBubbles', shake: 0.05, hitstop: 0, glow: 0.25, ripple: { strength: 1.0, radius: 7 }, sfx: 'bakalarHaul',
                   haptic: [{ duration: 34, magnitude: 0.45 }], sfxMinGap: 0.06 },
    // Charm. Was playing `pickup`, which made turning an enemy harmless sound
    // exactly like collecting chum.
    dumboCharm:  { emit: 'pickup', shake: 0.02, hitstop: 0, glow: 0.2, ripple: { strength: 0.4, radius: 4 }, sfx: 'dumboCharm',
                   haptic: [{ duration: 24, magnitude: 0.2 }], sfxMinGap: 0.05 },
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
    shakeDecay: 0.0004, // fraction of shake left after 1s
    maxShake: 0.85, // ceiling, so a busy fight can't pin the camera
    hitstopScale: 0.12, // time scale during a hit-stop, not a full freeze
    hitstopCooldown: 0.4, // minimum gap between hit-stops
    hitFlash: 0.12, // seconds an enemy pops when hit
    hitPop: 0.35, // extra scale on that pop
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
      idle:        { wagSpeed: 1.6, wagAmplitude: 0.12, headBob: 0.06, clipTimeScale: 0.45 },
      swim:        { wagSpeed: 4.2, wagAmplitude: 0.24, headBob: 0.03, clipTimeScale: 1.0 },
      boost:       { wagSpeed: 7.5, wagAmplitude: 0.34, headBob: 0.0,  clipTimeScale: 1.4 },
      surfaceIdle: { wagSpeed: 1.2, wagAmplitude: 0.10, headBob: 0.05, clipTimeScale: 1.0 },
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
    reach: 3.0, // aim target distance, in chain lengths — >1 straightens the fin
    tolerance: 0.01, // world units; stop iterating once the tip is this close
    // Fire the one-shots as authored: while the roll/hit/bark/death clip is
    // playing the fins hand back to it entirely, rather than pointing
    // downrange through the middle of a barrel roll.
    releaseOnOneShot: true,
    tipLengthMul: 1.0, // scales the asset's fin tipLength — slides the muzzle along the flipper
    muzzleOffset: 0.35, // world units further along the aim, so bullets clear the fin
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
  // a breath puff from the mouth on a loose timer, and a continuous wake off
  // the tip of the tail whose rate scales with how fast the seal is moving.
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
    },
  },

  audio: {
    enabled: true,
    masterVolume: 0.55,
    maxConcurrent: 12, // drop new sounds past this to avoid mush
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
    shoot:     { src: null, type: 'blip',  wave: 'square',   freq: [900, 260],  decay: 0.09, gain: 0.16, pitchVary: 0.04, detune: 14 },
    hit:       { src: null, type: 'noise', filter: 2600,     decay: 0.08, gain: 0.20, pitchVary: 0.10, filterVary: 0.20 },
    kill:      { src: null, type: 'boom',  freq: [220, 50],  decay: 0.34, gain: 0.34, noise: 0.5, filter: 1400, pitchVary: 0.12, filterVary: 0.18 },
    bigKill:   { src: null, type: 'boom',  freq: [150, 32],  decay: 0.6,  gain: 0.45, noise: 0.7, filter: 900,  pitchVary: 0.12, filterVary: 0.18 },
    playerHit: { src: null, type: 'boom',  freq: [320, 70],  decay: 0.3,  gain: 0.4,  noise: 0.6, filter: 1100, pitchVary: 0.08, filterVary: 0.15 },
    bite:      { src: null, type: 'noise', filter: 1200,     decay: 0.18, gain: 0.26, pitchVary: 0.14, filterVary: 0.25 },
    // Pitch is NOT random for pickups — it tracks XP progress toward the
    // next level, sweeping a full octave from 0% to 100%. Collecting chum
    // becomes an audible progress bar: the closer to levelling, the higher
    // the note. pitchVary stays 0 so that reading isn't muddied by noise.
    pickup:    { src: null, type: 'blip',  wave: 'triangle', freq: [620, 1180], decay: 0.12, gain: 0.16, pitchVary: 0 },
    levelUp:   { src: null, type: 'blip',  wave: 'triangle', freq: [440, 1320], decay: 0.5,  gain: 0.26, pitchVary: 0.03 },
    splash:    { src: null, type: 'noise', filter: 3400,     decay: 0.3,  gain: 0.24, pitchVary: 0.12, filterVary: 0.22 },
    bounce:    { src: null, type: 'blip',  wave: 'sine',     freq: [300, 120],  decay: 0.12, gain: 0.14, pitchVary: 0.16 },
    // The body hitting the seabed. Low and dull with the noise doing most of
    // the work — sand, not stone. It plays through the death dive's rate
    // scale like everything else, so it arrives even lower and longer than
    // this: these numbers describe it at full speed.
    seabedThud: { src: null, type: 'boom',  freq: [110, 34],  decay: 0.85, gain: 0.4,  noise: 0.85, filter: 480, pitchVary: 0.05, filterVary: 0.15 },
    strike:    { src: null, type: 'boom',  freq: [520, 90],  decay: 0.28, gain: 0.34, noise: 0.35, filter: 2200, pitchVary: 0.07, filterVary: 0.15 },
    strikeChain: { src: null, type: 'blip', wave: 'sawtooth', freq: [420, 1500], decay: 0.22, gain: 0.28, pitchVary: 0.05 },
    // The FOOD CHAIN! announcement. Pitched up per link by the caller like
    // `strikeChain` is, so a deep chain climbs — but where that one is a thin
    // tick riding on top of an impact, this is the fanfare underneath it, so
    // it's low, long and has body. pitchVary stays 0: the pitch IS the combo
    // depth here, and randomness would blur the reading.
    foodChain: { src: null, type: 'boom',  freq: [180, 620],  decay: 0.42, gain: 0.34, noise: 0.25, filter: 2200, pitchVary: 0, filterVary: 0.1 },
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
    // An enemy sealed inside a bubble. Rising sine, same "something closed
    // around it" shape as `bubblePop` reversed.
    belugaTrap: { src: null, type: 'blip',  wave: 'sine',     freq: [170, 880],  decay: 0.17, gain: 0.15, pitchVary: 0.12 },
    // The net closing on a fish and dragging it off. Longer than any other
    // passive here because a haul IS the whole ability paying off.
    bakalarHaul:{ src: null, type: 'noise', filter: 1400,     decay: 0.32, gain: 0.22, pitchVary: 0.10, filterVary: 0.22 },
    // Charm. The one deliberately pleasant sound in the block — rising
    // triangle, no aggression in it, because the enemy isn't being hurt.
    dumboCharm: { src: null, type: 'blip',  wave: 'triangle', freq: [880, 1560], decay: 0.28, gain: 0.14, pitchVary: 0.08 },
    // The dive. Falling sawtooth — a bird committing to a stoop.
    seagullDive:{ src: null, type: 'blip',  wave: 'sawtooth', freq: [1500, 480], decay: 0.30, gain: 0.16, pitchVary: 0.10 },
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
    // Deflection (0..1, after the deadzone) at which the aim stick starts
    // shooting. Separate from `deadzone` so a small nudge can re-point the ship
    // without opening fire.
    fireAt: 0.35,
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
  // MUSIC — a BPM-quantized loop player. Track switches wait for the next
  // loop boundary instead of cutting in immediately, so the music stays on
  // the grid. Level-up ducks the mix through a low-pass and swaps to the
  // upgrade loop; resuming gameplay sweeps it back open. `defaultSrc[i]`
  // preloads slot `i + 1` from public/music/ on startup — the same
  // load-with-fallback pattern as CONFIG.sfx's `src`. Upload in the T-menu's
  // Sound tab to replace any slot for the current session; with a slot
  // empty and no default set, that slot is just skipped.
  // ---------------------------------------------------------------------------
  music: {
    enabled: true,
    bpm: 120,
    beatsPerLoop: 32, // 8 bars of 4/4
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
    // What a hull does when it's shot. Boats have no skeleton, so they can't
    // use the creatures' spring flinch — this is the rigid-body equivalent:
    // recoil along the shot, a damped roll, and the shared scale pop.
    hitReaction: {
      perDamage: 0.012, // world units of recoil per point of damage
      max: 0.5, // ceiling, so a big hit staggers without teleporting the hull
      knockDecay: 9, // how fast the recoil eases back to zero
      trawlerResist: 2.2, // a trawler is heavier, so it barely flinches
      rockPerHit: 5.5, // roll imparted per unit of recoil
      rockStiffness: 42, // spring pulling the hull back level
      rockDamping: 5, // so it settles instead of oscillating
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
    chumXp: 3,
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
  bloom: {
    enabled: true,
    threshold: 0.55, // luminance above which pixels start to glow
    intensity: 0.9, // steady base glow strength
    radius: 3, // blur iterations — higher = wider, softer glow (costs more)
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
    collectRadius: 0.6,
    sinkSpeed: 1.2, // xp orbs drift down through the water
    maxAlive: 140, // oldest orbs are recycled past this
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
  },

  upgrades: [
    { id: 'rapidFire', name: 'Rapid Fire', desc: '+25% fire rate', apply: (s) => { s.fireRate *= 0.75; } },
    { id: 'heavyRounds', name: 'Heavy Rounds', desc: '+40% bullet damage', apply: (s) => { s.damage *= 1.4; } },
    { id: 'overboost', name: 'Overboost', desc: '+30% recoil boost', apply: (s) => { s.recoil *= 1.3; } },
    { id: 'maxSpeed', name: 'Redline', desc: '+20% max speed', apply: (s) => { s.maxSpeed *= 1.2; } },
    { id: 'multishot', name: 'Multishot', desc: '+1 projectile', apply: (s) => { s.multishot += 1; }, maxStacks: 6 },
    { id: 'pierce', name: 'Railgun', desc: 'Bullets pierce +1 enemy', apply: (s) => { s.pierce += 1; }, maxStacks: 4 },
    { id: 'vitality', name: 'Vitality', desc: '+30 max HP', apply: (s) => { s.maxHp += 30; } },
    { id: 'magnet', name: 'Magnet', desc: '+50% pickup radius', apply: (s) => { s.pickupRadius *= 1.5; } },
    { id: 'regen', name: 'Regeneration', desc: '+0.5 HP/sec', apply: (s) => { s.regenPerSec += 0.5; } },
    { id: 'velocity', name: 'Hot Rounds', desc: '+30% bullet speed', apply: (s) => { s.speed *= 1.3; } },
    { id: 'homingMissile', name: 'Homing Missile', desc: '+1 seeking missile per volley', apply: (s) => { s.missileCount = (s.missileCount ?? 0) + 1; }, maxStacks: 5 },
    { id: 'seaGarlic', name: 'Sea Garlic', desc: 'Damaging aura, +radius per level', apply: (s) => { s.garlicLevel = (s.garlicLevel ?? 0) + 1; }, maxStacks: 6 },
    { id: 'shrimpRing', name: 'Shrimp Ring', desc: '+1 orbiting shrimp', apply: (s) => { s.shrimpCount = (s.shrimpCount ?? 0) + 1; }, maxStacks: 8 },
    { id: 'bounceShot', name: 'Ricochet Rounds', desc: 'Chaining shot: +fire rate, +lifespan, +bounces', apply: (s) => {
        s.bounceLevel = (s.bounceLevel ?? 0) + 1;
        s.bounceFireRate = (s.bounceFireRate ?? CONFIG.bounce.fireRate) * 0.88;
        s.bounceLife = (s.bounceLife ?? CONFIG.bounce.life) + 0.6;
        s.bounceMaxBounces = (s.bounceMaxBounces ?? CONFIG.bounce.maxBounces) + CONFIG.bounce.maxBouncesPerLevel;
      }, maxStacks: 6 },
    { id: 'electricEel', name: 'Electric Eel', desc: 'Chain lightning: +area, +damage, +max chain', apply: (s) => { s.eelLevel = (s.eelLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'starfish', name: 'Starfish Shuriken', desc: 'Rapid thrown starfish: +fire rate, +size', apply: (s) => { s.starfishLevel = (s.starfishLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'seagullBomb', name: 'Seagull Bomb', desc: 'Homing dive-bombers vs. crabs: +fire rate', apply: (s) => { s.seagullLevel = (s.seagullLevel ?? 0) + 1; }, maxStacks: 8 },
    // `perLevelName` numbers the card by the stack it's offering — "Seal Team
    // 1", then "Seal Team 2" — so which one you're being offered is on the
    // card instead of in your head. `levelDescs` overrides the description at
    // a given stack, which is how the evolution announces itself rather than
    // arriving as a surprise on an identically-worded card.
    { id: 'sealTeam', name: 'Seal Team', desc: '+1 escort seal. Rams and lunges at enemies.',
      perLevelName: true,
      levelDescs: { 6: 'EVOLVE: the whole squad opens fire while it orbits.' },
      apply: (s) => { s.sealTeamLevel = (s.sealTeamLevel ?? 0) + 1; }, maxStacks: 6 },
    { id: 'beluga', name: 'Baby Beluga', desc: 'Bubble drone traps enemies: +bubble size', apply: (s) => { s.belugaLevel = (s.belugaLevel ?? 0) + 1; }, maxStacks: 8 },

    // --- strike line --------------------------------------------------------
    // These scale the dash, which until now had no per-run scaling at all —
    // every strike number was read straight off CONFIG. The stats they mutate
    // are seeded from CONFIG in recomputeStats(), same as the bounce fields, so
    // the tuner sliders still act as the base value.
    { id: 'strikePower', name: 'Killer Instinct', desc: '+35% strike damage, chains hit harder', apply: (s) => {
        s.strikeDamage *= 1.35;
        // Compounding on top of a base above 1, so each stack widens the gap
        // between a one-off strike and a long chain rather than just adding
        // flat damage twice.
        s.strikeChainMul = 1 + (s.strikeChainMul - 1) * 1.3;
      }, maxStacks: 5 },
    { id: 'strikeDash', name: 'Slipstream', desc: 'Strike dashes faster and further', apply: (s) => {
        s.strikeDashSpeed *= 1.22;
        s.strikeDashDuration *= 1.12;
      }, maxStacks: 5 },
    { id: 'strikeShrapnel', name: 'Bone Shrapnel', desc: 'Strike hits burst fragments outward: +fragments', apply: (s) => { s.shrapnelCount = (s.shrapnelCount ?? 0) + 1; }, maxStacks: 6 },
    // The rhythm upgrade. Both halves of the loop get faster: less time
    // winding a strike up by hand, and a bigger bite out of the meter per
    // chum, so fewer orbs are needed to earn each FOOD CHAIN link. Stacked
    // fully this turns a ~1s wind-up into ~0.37s and drops the orbs-per-link
    // from 5 to 3 — the difference between striking deliberately and
    // striking on the beat.
    { id: 'strikeCharge', name: 'Coiled Spring', desc: 'Strike charges faster, and chum refills more of the meter',
      perLevelName: true,
      apply: (s) => {
        s.strikeChargeTime *= 0.78;
        s.strikeChumRefill += 0.04;
      }, maxStacks: 4 },
    // The only upgrade that feeds the chain from something other than a hit.
    // It turns the surface into a combo tool: launch, and you come down on
    // the next school with the food chain already running. Stacks add links
    // per breach rather than shortening the cooldown, so the ceiling stays
    // "how often you can get out of the water", not "how fast you can skim
    // the water line" — see CONFIG.strike.chainOn.cooldowns.breach.
    { id: 'breachChain', name: 'Porpoising', desc: 'Breaching the surface extends your food chain: +links per breach',
      perLevelName: true,
      apply: (s) => { s.breachChainLevel = (s.breachChainLevel ?? 0) + 1; }, maxStacks: 3 },

    // --- oxygen line --------------------------------------------------------
    { id: 'oxygenMax', name: 'Deep Lungs', desc: '+30 max oxygen', apply: (s) => { s.maxOxygen += 30; }, maxStacks: 5 },
    { id: 'oxygenRefill', name: 'Second Wind', desc: '+40% surface refill speed', apply: (s) => { s.oxygenRefillRate *= 1.4; }, maxStacks: 5 },

    // --- new companions -----------------------------------------------------
    { id: 'bakalar', name: "Bakalar's Boat", desc: 'Trawler drags a net that hauls fish away: +net size, +sailings', apply: (s) => { s.bakalarLevel = (s.bakalarLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'calamari', name: 'Calamari Ring', desc: 'Shockwave sweeps outward: +damage, +radius, +rate', apply: (s) => { s.calamariLevel = (s.calamariLevel ?? 0) + 1; }, maxStacks: 8 },
    { id: 'dumbo', name: 'Dumbo Octopus', desc: 'Charms enemies harmless: +targets, +duration', apply: (s) => { s.dumboLevel = (s.dumboLevel ?? 0) + 1; }, maxStacks: 8 },
  ],

  upgradeChoices: 3,

  // NOTE: the display fields above (name, desc, maxStacks, enabled) and each
  // upgrade's card art are OVERWRITTEN at boot from upgrades.csv, which is the
  // source of truth for them — see upgradeTable.js. Editing them here only
  // changes what an upgrade falls back to when the CSV has no row for it.
  // What an upgrade DOES — its apply() — is only ever code, and lives here.

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
// ============================================================================

export const TUNER_SCHEMA = [
  {
    group: 'Movement',
    items: [
      { path: 'player.thrust', min: 0, max: 40, step: 0.5 },
      { path: 'player.friction', min: 0.8, max: 1, step: 0.005 },
      { path: 'player.maxSpeed', min: 5, max: 80, step: 1 },
      { path: 'weapon.recoil', min: 0, max: 40, step: 0.5, label: 'recoil boost' },
      { path: 'arena.airGravity', min: 0, max: 40, step: 0.5, label: 'gravity above water' },
    ],
  },
  {
    group: 'Weapon',
    items: [
      { path: 'weapon.fireRate', min: 0.03, max: 1.2, step: 0.01 },
      { path: 'weapon.damage', min: 0.5, max: 100, step: 0.5 },
      { path: 'weapon.speed', min: 5, max: 80, step: 1 },
      { path: 'weapon.multishot', min: 1, max: 12, step: 1, label: 'multishot (per fin)' },
      { path: 'weapon.finSpread', min: 0, max: 0.4, step: 0.005, label: 'spread within one fin' },
      { path: 'weapon.spread', min: 0, max: 0.6, step: 0.01, label: 'spread (no fin rig)' },
      { path: 'weapon.pierce', min: 0, max: 8, step: 1 },
      { path: 'weapon.shotSfx.enabled', type: 'bool', label: 'shot sound tracks fire rate' },
      { path: 'weapon.shotSfx.pitchRise', min: 0, max: 1.5, step: 0.05, label: 'shot pitch rise when fast' },
      { path: 'weapon.shotSfx.maxRateRatio', min: 1.5, max: 8, step: 0.1, label: 'fire rate ratio for full rise' },
      { path: 'weapon.shotSfx.fitDecay', type: 'bool', label: 'trim shot tail to fit the gap' },
      { path: 'weapon.shotSfx.decayHeadroom', min: 0.2, max: 1, step: 0.05, label: 'how much of the gap the tail may fill' },
      { path: 'feedback.bulletHit.sfxMinGap', min: 0, max: 0.4, step: 0.01, label: 'min gap between impact sounds' },
    ],
  },
  {
    group: 'Survivability',
    items: [
      { path: 'player.maxHp', min: 20, max: 500, step: 10 },
      { path: 'player.regenPerSec', min: 0, max: 10, step: 0.1 },
      { path: 'player.pickupRadius', min: 1, max: 20, step: 0.5 },
    ],
  },
  {
    group: 'The school',
    panel: 'enemies',
    items: [
      { path: 'enemies.fish.speed', min: 1, max: 20, step: 0.5 },
      { path: 'enemies.fish.swarm.cohesion', min: 0, max: 10, step: 0.1 },
      { path: 'enemies.fish.swarm.separation', min: 0, max: 15, step: 0.1 },
      { path: 'enemies.fish.swarm.alignment', min: 0, max: 10, step: 0.1 },
      { path: 'enemies.fish.swarm.towardPlayer', min: 0, max: 10, step: 0.1 },
      { path: 'enemies.fish.swarm.fleeFromPredators', min: 0, max: 20, step: 0.5 },
      { path: 'enemies.fish.group.max', min: 1, max: 30, step: 1, label: 'school size max' },
    ],
  },
  {
    group: 'Sharks',
    panel: 'enemies',
    items: [
      { path: 'enemies.shark.speed', min: 1, max: 20, step: 0.5 },
      { path: 'enemies.shark.hp', min: 10, max: 300, step: 5 },
      { path: 'enemies.shark.turnRate', min: 0.3, max: 10, step: 0.1 },
      { path: 'enemies.shark.hunt.preyRadius', min: 0, max: 60, step: 1 },
      { path: 'enemies.shark.hunt.healPerMeal', min: 0, max: 60, step: 1 },
      { path: 'enemies.shark.weightPerDifficulty', min: 0, max: 0.5, step: 0.01 },
    ],
  },
  {
    group: 'Biting & aggression',
    panel: 'enemies',
    items: [
      { path: 'bite.enabled', type: 'bool', label: 'hunters snap their jaws' },
      { path: 'bite.lead', min: 1, max: 5, step: 0.1, label: 'open mouth this far out (x reach)' },
      { path: 'bite.playerReach', min: 0.5, max: 3, step: 0.05, label: 'bite-at-player reach (x contact)' },
      { path: 'bite.cooldown', min: 0.2, max: 4, step: 0.05, label: 'fallback bite cooldown (s)' },
      // The jaw driver's own timing. Every one of these is per-BITE, not per
      // second, so the whole snap is openTime + holdTime + closeTime long.
      { path: 'bite.jaw.openTime', min: 0.02, max: 0.6, step: 0.01, label: 'jaw gape time (s)' },
      { path: 'bite.jaw.holdTime', min: 0, max: 0.5, step: 0.01, label: 'jaw held open (s)' },
      { path: 'bite.jaw.closeTime', min: 0.02, max: 0.6, step: 0.01, label: 'jaw snap-shut time (s)' },
      { path: 'bite.lunge.enabled', type: 'bool', label: 'lunge into the bite' },
      { path: 'bite.lunge.speedMul', min: 1, max: 4, step: 0.05, label: 'lunge speed (x)' },
      { path: 'bite.lunge.duration', min: 0.05, max: 1.5, step: 0.05, label: 'lunge length (s)' },
      // Behavioural difficulty ramp — see CONFIG.hunterRamp. Baked at spawn,
      // so moving these only affects hunters that appear afterwards.
      { path: 'hunterRamp.enabled', type: 'bool', label: 'hunters get more aggressive over time' },
      { path: 'hunterRamp.preyFocus', min: 0, max: 0.2, step: 0.005, label: 'fish distraction shed per 20s' },
      { path: 'hunterRamp.preyFocusMin', min: 0, max: 1, step: 0.05, label: 'min fish distraction left (x)' },
      { path: 'hunterRamp.turnRate', min: 0, max: 0.08, step: 0.002, label: 'hunter turn growth per 20s' },
      { path: 'hunterRamp.turnRateMax', min: 1, max: 4, step: 0.05, label: 'hunter turn growth cap (x)' },
    ],
  },
  {
    group: 'Difficulty',
    panel: 'enemies',
    items: [
      { path: 'spawn.difficultyPerSecond', min: 0.005, max: 0.3, step: 0.005 },
      { path: 'spawn.baseInterval', min: 0.1, max: 4, step: 0.05 },
      { path: 'spawn.minInterval', min: 0.05, max: 2, step: 0.05 },
      { path: 'spawn.countPerDifficulty', min: 0, max: 3, step: 0.05 },
      // Max drawn from the sum of the apex species' own maxConcurrent values
      // (27), so the top of the range is "no group cap at all" and anything
      // below it actually binds.
      { path: 'spawn.groupMaxAlive.apex', min: 0, max: 27, step: 1, label: 'max sharks/whales on screen' },
      // Compounding per difficulty point (20s by default), so small numbers
      // move a lot: 0.05 is x2.2 at five minutes and x4.3 at ten. The caps
      // are multipliers on the species' base stat.
      { path: 'spawn.ramp.hp', min: 0, max: 0.15, step: 0.005, label: 'enemy hp growth per 20s' },
      { path: 'spawn.ramp.hpMax', min: 1, max: 30, step: 0.5, label: 'enemy hp growth cap (x)' },
      { path: 'spawn.ramp.damage', min: 0, max: 0.15, step: 0.005, label: 'enemy damage growth per 20s' },
      { path: 'spawn.ramp.damageMax', min: 1, max: 12, step: 0.25, label: 'enemy damage growth cap (x)' },
      { path: 'spawn.ramp.speed', min: 0, max: 0.06, step: 0.001, label: 'enemy speed growth per 20s' },
      { path: 'spawn.ramp.speedMax', min: 1, max: 4, step: 0.05, label: 'enemy speed growth cap (x)' },
      // The xp curve sits in this panel rather than with the weapons: how fast
      // levels arrive is a difficulty knob, and it is only ever tuned while
      // looking at the spawn numbers directly above it.
      { path: 'xp.first', min: 5, max: 60, step: 1, label: 'xp for level 2' },
      { path: 'xp.mul', min: 1.05, max: 2.2, step: 0.01, label: 'xp growth, levels 1-5' },
      { path: 'xp.midMul', min: 1.05, max: 2.2, step: 0.01, label: 'xp growth, mid levels' },
      { path: 'xp.midFrom', min: 2, max: 20, step: 1, label: 'mid band starts at level' },
      { path: 'xp.lateMul', min: 1.05, max: 2.2, step: 0.01, label: 'xp growth, late levels' },
      { path: 'xp.lateFrom', min: 5, max: 40, step: 1, label: 'late band starts at level' },
    ],
  },
  {
    group: 'Ocean colors',
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
    group: 'Caustics & light beams',
    items: [
      { path: 'caustics.enabled', type: 'bool', label: 'caustics' },
      { path: 'caustics.intensity', min: 0, max: 1.5, step: 0.02 },
      { path: 'caustics.scale', min: 0.02, max: 0.6, step: 0.01 },
      { path: 'caustics.speed', min: 0, max: 2, step: 0.02 },
      { path: 'caustics.falloff', min: 0.2, max: 4, step: 0.1, label: 'caustics depth falloff' },
      { path: 'caustics.color', type: 'color' },
      { path: 'godrays.enabled', type: 'bool', label: 'light beams' },
      { path: 'godrays.count', min: 0, max: 8, step: 1 },
      { path: 'godrays.spread', min: 4, max: 60, step: 1 },
      { path: 'godrays.beamWidth', min: 0.3, max: 8, step: 0.1 },
      { path: 'godrays.angle', min: -3, max: 3, step: 0.05 },
      { path: 'godrays.sway', min: 0, max: 1, step: 0.02 },
      { path: 'godrays.intensity', min: 0, max: 1, step: 0.02 },
      { path: 'godrays.falloff', min: 0.2, max: 4, step: 0.1, label: 'beam depth falloff' },
      { path: 'godrays.color', type: 'color' },
    ],
  },
  {
    group: 'Lighting',
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
    items: [
      { path: 'weapon.autofire', type: 'bool', label: 'autofire' },
      { path: 'missile.fireRate', min: 0.2, max: 3, step: 0.05, label: 'missile fire rate' },
      { path: 'missile.damage', min: 1, max: 80, step: 1, label: 'missile damage' },
      { path: 'missile.turnRate', min: 0.5, max: 12, step: 0.1, label: 'missile turn rate' },
      { path: 'missile.speed', min: 4, max: 40, step: 1, label: 'missile speed' },
      { path: 'missile.homingDelay', min: 0, max: 1, step: 0.02, label: 'missile straight-flight time' },
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
      { path: 'bounce.fireRate', min: 0.1, max: 2, step: 0.02, label: 'bounce base fire rate' },
      { path: 'bounce.damage', min: 1, max: 60, step: 1, label: 'bounce damage' },
      { path: 'bounce.life', min: 0.5, max: 8, step: 0.1, label: 'bounce base lifespan' },
      { path: 'bounce.maxBounces', min: 0, max: 10, step: 1, label: 'bounce base max bounces' },
      { path: 'bounce.maxBouncesPerLevel', min: 0, max: 6, step: 1, label: 'bounce +bounces per level' },
      { path: 'bounce.chainRange', min: 0, max: 40, step: 0.5, label: 'bounce chain seek range' },
      { path: 'bounce.chainLock', min: 0, max: 0.4, step: 0.01, label: 'bounce chain re-hit lock' },
      { path: 'bounce.chainSpeedGain', min: 0.8, max: 1.3, step: 0.01, label: 'bounce chain speed gain' },
      { path: 'bounce.comboPitchStep', min: 0, max: 3, step: 0.05, label: 'bounce combo pitch step (semitones)' },
      { path: 'bounce.comboPitchMax', min: 0, max: 36, step: 1, label: 'bounce combo pitch cap (semitones)' },
      { path: 'bounce.comboScaleStep', min: 0, max: 0.6, step: 0.01, label: 'bounce combo fx growth' },
      { path: 'bounce.comboScaleMax', min: 1, max: 5, step: 0.1, label: 'bounce combo fx cap' },
    ],
  },
  {
    group: 'Sea garlic',
    panel: 'companions',
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
    items: [
      { path: 'shrimpRing.baseCount', min: 0, max: 12, step: 1 },
      { path: 'shrimpRing.radius', min: 0.5, max: 8, step: 0.1 },
      { path: 'shrimpRing.orbitSpeed', min: -6, max: 6, step: 0.1 },
      { path: 'shrimpRing.scale', min: 0.1, max: 2, step: 0.05 },
      { path: 'shrimpRing.contactDamage', min: 0, max: 30, step: 1 },
      { path: 'shrimpRing.contactCooldown', min: 0.05, max: 2, step: 0.05 },
    ],
  },
  {
    group: 'Strike / boost',
    panel: 'companions',
    items: [
      { path: 'strike.enabled', type: 'bool', label: 'strike system' },
      { path: 'strike.charge.time', min: 0.15, max: 3, step: 0.05, label: 'charge: seconds a full bar buys' },
      { path: 'strike.charge.minFire', min: 0, max: 0.9, step: 0.05, label: 'charge: minimum to fire' },
      { path: 'strike.charge.chumRefill', min: 0.02, max: 1, step: 0.02, label: 'charge: refill per chum' },
      { path: 'strike.charge.shake', min: 0, max: 0.3, step: 0.005, label: 'charge: wind-up shake' },
      { path: 'strike.charge.hapticInterval', min: 0.02, max: 0.4, step: 0.01, label: 'charge: rumble interval' },
      { path: 'strike.charge.flashTime', min: 0, max: 1, step: 0.02, label: 'charge: spend flash' },
      { path: 'strike.charge.tailLift', min: 0, max: 40, step: 0.5, label: 'wind-up: tail lift' },
      { path: 'strike.charge.vibrate.head', min: 0, max: 0.3, step: 0.005, label: 'wind-up: head tremble' },
      { path: 'strike.charge.vibrate.body', min: 0, max: 0.3, step: 0.005, label: 'wind-up: body tremble' },
      { path: 'strike.charge.vibrate.hz', min: 4, max: 28, step: 1, label: 'wind-up: tremble speed (Hz)' },
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
      { path: 'strike.damage', min: 5, max: 150, step: 5 },
      { path: 'strike.chainWindow', min: 0.2, max: 3, step: 0.05 },
      { path: 'strike.chainDamageMul', min: 1, max: 2, step: 0.02 },
      { path: 'strike.dashTurnRate', min: 0, max: 30, step: 0.5, label: 'dash turn rate (higher = tighter)' },
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
      { path: 'strike.chainOn.chumFull', type: 'bool', label: 'food chain: eating refills the meter to full' },
      { path: 'strike.chainOn.schoolWipe', type: 'bool', label: 'food chain: whole school in one strike' },
      { path: 'strike.chainOn.breach', type: 'bool', label: 'food chain: breach (Porpoising)' },
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
    group: 'Pickups & loot',
    items: [
      { path: 'pickups.healFraction', min: 0, max: 0.2, step: 0.005, label: 'heal per orb (fraction of max HP)' },
      { path: 'pickups.tiers.0.xpMul', min: 0.1, max: 3, step: 0.05, label: 'small orb xp mult' },
      { path: 'pickups.tiers.0.healMul', min: 0.1, max: 3, step: 0.05, label: 'small orb heal mult' },
      { path: 'pickups.tiers.2.xpMul', min: 0.1, max: 4, step: 0.05, label: 'big orb xp mult' },
      { path: 'pickups.tiers.2.healMul', min: 0.1, max: 4, step: 0.05, label: 'big orb heal mult' },
    ],
  },
  {
    group: 'Points',
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
    items: [
      { path: 'crabSpawn.enabled', type: 'bool', label: 'pile-triggered crabs' },
      { path: 'crabSpawn.pileThreshold', min: 1, max: 40, step: 1 },
      { path: 'crabSpawn.orbsPerCrab', min: 1, max: 20, step: 1 },
      { path: 'crabSpawn.maxCrabsPerWave', min: 1, max: 15, step: 1 },
      { path: 'crabSpawn.checkInterval', min: 0.5, max: 15, step: 0.5 },
      { path: 'crabSpawn.floorHeight', min: 0.3, max: 8, step: 0.1 },
      { path: 'enemies.walkingCrab.crawl.floorRushHeight', min: 1, max: 20, step: 0.5, label: 'crab rush trigger height' },
      { path: 'enemies.walkingCrab.crawl.rushSpeedMul', min: 1, max: 4, step: 0.1, label: 'crab rush speed mult' },
      { path: 'enemies.walkingCrab.crawl.feed.seekRadius', min: 0, max: 60, step: 1, label: 'chum seek radius' },
      { path: 'enemies.walkingCrab.crawl.feed.eatRange', min: 0.3, max: 5, step: 0.1, label: 'chum eat range' },
      { path: 'enemies.walkingCrab.crawl.feed.eatTime', min: 0.2, max: 12, step: 0.1, label: 'seconds to eat one orb' },
      { path: 'enemies.animatedCrab.crawl.feed.eatTime', min: 0.2, max: 12, step: 0.1, label: 'animated crab eat time' },
      // --- how crabs scale over a run (difficulty climbs 1.0 every 20s) ---
      { path: 'enemies.walkingCrab.scalePerDifficulty', min: 0, max: 0.1, step: 0.001, label: 'crab growth per difficulty' },
      { path: 'enemies.walkingCrab.maxGrowth', min: 1, max: 4, step: 0.05, label: 'crab max size multiplier' },
      { path: 'enemies.walkingCrab.hpPerDifficulty', min: 0, max: 30, step: 0.5, label: 'crab hp per difficulty' },
      { path: 'enemies.walkingCrab.contactDamagePerDifficulty', min: 0, max: 5, step: 0.05, label: 'crab damage per difficulty' },
      { path: 'enemies.walkingCrab.speedPerDifficulty', min: 0, max: 0.5, step: 0.01, label: 'crab speed per difficulty' },
      // --- gait tempo ---
      { path: 'enemies.walkingCrab.beatSync.beatsPerStride', min: 0.25, max: 8, step: 0.25, label: 'beats per crab footfall' },
      { path: 'enemies.animatedCrab.beatSync.beatsPerStride', min: 0.25, max: 8, step: 0.25, label: 'animated crab beats/footfall' },
      // --- how crabs find and reach the chum ---
      { path: 'enemies.walkingCrab.crawl.feed.seekRadius', min: 5, max: 150, step: 5, label: 'chum seek range' },
      { path: 'enemies.walkingCrab.crawl.feed.distanceBias', min: 2, max: 80, step: 1, label: 'pile pull half-distance' },
      { path: 'crabSpawn.spawnMargin', min: 0, max: 15, step: 0.5, label: 'offscreen spawn margin' },
      { path: 'crabSpawn.clusterRadius', min: 1, max: 20, step: 0.5, label: 'what counts as one pile' },
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
    ],
  },
  {
    group: 'Animation',
    items: [
      { path: 'animation.enabled', type: 'bool', label: 'creature animation' },
      { path: 'animation.moveThreshold', min: 0, max: 10, step: 0.1, label: 'idle -> swim speed' },
      { path: 'animation.boostThreshold', min: 1, max: 40, step: 0.5, label: 'swim -> boost speed' },
      { path: 'animation.crossfade', min: 0, max: 1, step: 0.01, label: 'blend time' },
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
    items: [
      { path: 'fins.enabled', type: 'bool', label: 'fin controls' },
      { path: 'fins.ik', type: 'bool', label: 'aim fins at cursor' },
      { path: 'fins.weight', min: 0, max: 1, step: 0.02, label: 'aim override (firing)' },
      { path: 'fins.idleWeight', min: 0, max: 1, step: 0.02, label: 'aim override (idle)' },
      { path: 'fins.weightLerp', min: 1, max: 30, step: 0.5, label: 'override ease' },
      { path: 'fins.smoothing', min: 1, max: 60, step: 1, label: 'aim tracking speed' },
      { path: 'fins.maxBend', min: 0, max: 3.14, step: 0.02, label: 'max bend per bone' },
      { path: 'fins.softness', min: 0.05, max: 1, step: 0.05, label: 'bend limit softness' },
      { path: 'fins.rootInfluence', min: 0, max: 1, step: 0.02, label: 'upper-arm share' },
      { path: 'fins.reach', min: 1, max: 8, step: 0.1, label: 'aim target distance' },
      { path: 'fins.iterations', min: 1, max: 12, step: 1, label: 'IK passes' },
      { path: 'fins.releaseOnOneShot', type: 'bool', label: 'let one-shots own the fins' },
      { path: 'fins.tipLengthMul', min: 0, max: 3, step: 0.05, label: 'muzzle along flipper' },
    ],
  },
  {
    group: 'Emit points',
    items: [
      { path: 'fins.muzzle', type: 'bool', label: 'fire from bone points' },
      { path: 'emitPoints.bullet', options: ['fins', 'mouth', 'tail', 'body'], label: 'basic shot' },
      { path: 'emitPoints.missile', options: ['fins', 'mouth', 'tail', 'body'], label: 'missiles' },
      { path: 'emitPoints.bounce', options: ['fins', 'mouth', 'tail', 'body'], label: 'bounce shot' },
      { path: 'emitPoints.starfish', options: ['fins', 'mouth', 'tail', 'body'], label: 'starfish' },
      { path: 'fins.muzzleOffset', min: 0, max: 2, step: 0.05, label: 'forward offset' },
      { path: 'fins.flattenZ', type: 'bool', label: 'emit in body plane' },
      { path: 'fins.alternate', type: 'bool', label: 'alternate fins per volley' },
    ],
  },
  {
    group: 'Creature spring',
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
    ],
  },
  {
    group: 'Tail',
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
    items: [
      { path: 'head.enabled', type: 'bool', label: 'head follows aim' },
      { path: 'head.weight', min: 0, max: 1, step: 0.02, label: 'look strength (firing)' },
      { path: 'head.idleWeight', min: 0, max: 1, step: 0.02, label: 'look strength (idle)' },
      { path: 'head.weightLerp', min: 1, max: 30, step: 0.5, label: 'look ease' },
      { path: 'head.smoothing', min: 1, max: 40, step: 0.5, label: 'look tracking speed' },
      { path: 'head.maxBend', min: 0, max: 1.2, step: 0.02, label: 'max bend per neck bone' },
      { path: 'head.softness', min: 0.05, max: 1, step: 0.05, label: 'bend limit softness' },
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
    items: [
      { path: 'playerOutline.enabled', type: 'bool', label: 'outline the seal' },
      { path: 'playerOutline.color', type: 'color', label: 'outline colour' },
      { path: 'playerOutline.thickness', min: 0, max: 0.6, step: 0.005, label: 'outline thickness' },
      // Past ~1 the rim starts blooming; how much halo you actually get also
      // depends on the Glow group's threshold and amount.
      { path: 'playerOutline.glow', min: 0, max: 8, step: 0.1, label: 'outline glow' },
      { path: 'playerOutline.opacity', min: 0, max: 1, step: 0.05, label: 'outline opacity' },
    ],
  },
  {
    group: 'Creature outlines',
    // Lives in the Look & Sound panel with the rest of the per-creature look
    // controls, not in the ` tuner — it's the same question as tint and glow.
    panel: 'enemies',
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
  {
    group: 'Bubbles',
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
      { path: 'emitters.wakeBubbles.cone', min: 0, max: 1.6, step: 0.02, label: 'wake cone' },
      { path: 'emitters.wakeBubbles.count', min: 1, max: 16, step: 1, label: 'wake count' },
      { path: 'emitters.wakeBubbles.glow', min: 0, max: 6, step: 0.1, label: 'wake glow' },
    ],
  },
  {
    group: 'Facing',
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
    group: 'Strike indicator',
    panel: 'companions',
    items: [
      { path: 'strike.ring.radius', min: 0.5, max: 8, step: 0.05, label: 'ring radius' },
      { path: 'strike.ring.thickness', min: 0.02, max: 0.6, step: 0.01 },
      { path: 'strike.ring.segmentGap', min: 0, max: 0.6, step: 0.01, label: 'gap between charges' },
      { path: 'strike.ring.color', type: 'color', label: 'charging colour' },
      { path: 'strike.ring.readyColor', type: 'color', label: 'fully-charged colour' },
      { path: 'strike.ring.comboColor', type: 'color', label: 'combo colour' },
      { path: 'strike.ring.glow', min: 0, max: 8, step: 0.1 },
      { path: 'strike.ring.pulseSpeed', min: 0, max: 30, step: 0.5, label: 'combo pulse speed' },
      { path: 'strike.comboGridWarp', min: 0, max: 6, step: 0.1, label: 'combo grid warp' },
      { path: 'strike.comboGridWarpMax', min: 0, max: 20, step: 0.5, label: 'combo grid warp cap' },
    ],
  },
  {
    group: 'HUD',
    items: [
      { path: 'hud.playerBarOffset', min: 0, max: 8, step: 0.1, label: 'bar height above seal' },
    ],
  },
  {
    group: 'Seal Team',
    panel: 'companions',
    items: [
      { path: 'sealTeam.maxSeals', min: 1, max: 12, step: 1, label: 'max seals' },
      { path: 'sealTeam.contactDamage', min: 0, max: 80, step: 1, label: 'ram damage' },
      { path: 'sealTeam.damagePerLevel', min: 0, max: 30, step: 1, label: 'damage per level' },
      { path: 'sealTeam.contactRadius', min: 0.2, max: 4, step: 0.1, label: 'ram reach' },
      { path: 'sealTeam.contactCooldown', min: 0.05, max: 3, step: 0.05, label: 'ram cooldown' },
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
      { path: 'sealTeam.evolveLevel', min: 1, max: 12, step: 1, label: 'level the squad opens fire' },
      { path: 'sealTeam.evolved.fireRate', min: 0.1, max: 5, step: 0.05, label: 'evolved fire rate' },
      { path: 'sealTeam.evolved.damageMul', min: 0.1, max: 3, step: 0.05, label: 'evolved damage x player' },
      { path: 'sealTeam.evolved.speedMul', min: 0.2, max: 2, step: 0.05, label: 'evolved shot speed x player' },
      { path: 'sealTeam.evolved.range', min: 2, max: 40, step: 1, label: 'evolved fire range' },
    ],
  },
  {
    group: 'Music',
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
  {
    group: 'Spawn rates',
    panel: 'enemies',
    items: Object.keys(CONFIG.enemies).map((key) => ({
      path: `enemies.${key}.spawnRateMul`,
      min: 0, max: 4, step: 0.05,
      label: `${key} rate (0 = off)`,
    })),
  },
  {
    group: 'Spawn level gates',
    panel: 'enemies',
    items: Object.keys(CONFIG.enemies).map((key) => ({
      path: `enemies.${key}.minPlayerLevel`,
      min: 0, max: 30, step: 1,
      label: `${key} unlocks at lvl`,
    })),
  },
  {
    group: 'Boats & trawlers',
    panel: 'enemies',
    items: [
      { path: 'boats.enabled', type: 'bool', label: 'boats' },
      { path: 'boats.spawnMin', min: 2, max: 60, step: 1 },
      { path: 'boats.spawnMax', min: 2, max: 90, step: 1 },
      { path: 'boats.maxAlive', min: 1, max: 8, step: 1 },
      { path: 'boats.speed', min: 0.5, max: 12, step: 0.1 },
      { path: 'boats.hp', min: 5, max: 400, step: 5 },
      { path: 'boats.radius', min: 0.5, max: 5, step: 0.1 },
      { path: 'boats.trawlerChance', min: 0, max: 1, step: 0.05, label: 'trawler chance' },
      { path: 'boats.trawlerHpMul', min: 1, max: 5, step: 0.1, label: 'trawler hp mult' },
      { path: 'boats.chumMin', min: 1, max: 60, step: 1, label: 'chum dropped (min)' },
      { path: 'boats.chumMax', min: 1, max: 90, step: 1, label: 'chum dropped (max)' },
      { path: 'boats.trawlerChumMul', min: 1, max: 5, step: 0.1, label: 'trawler chum mult' },
      { path: 'boats.chumSpread', min: 0.5, max: 12, step: 0.1, label: 'chum scatter' },
      { path: 'attractorOrb.lifetime', min: 1, max: 30, step: 0.5, label: 'attractor duration' },
      { path: 'attractorOrb.pullStrength', min: 1, max: 100, step: 1, label: 'attractor pull' },
      { path: 'attractorOrb.riseSpeed', min: 0, max: 10, step: 0.1, label: 'attractor rise' },
      { path: 'attractorOrb.color', type: 'color', label: 'attractor colour' },
      { path: 'attractorOrb.glow', min: 0, max: 8, step: 0.1, label: 'attractor glow' },
    ],
  },
  {
    group: 'Electric eel',
    panel: 'companions',
    items: [
      { path: 'eel.fireRate', min: 0.2, max: 4, step: 0.1 },
      { path: 'eel.baseDamage', min: 1, max: 80, step: 1 },
      { path: 'eel.damagePerLevel', min: 0, max: 30, step: 1 },
      { path: 'eel.baseChainRadius', min: 1, max: 20, step: 0.5, label: 'base area (chain radius)' },
      { path: 'eel.radiusPerLevel', min: 0, max: 5, step: 0.1 },
      { path: 'eel.baseMaxChain', min: 1, max: 15, step: 1 },
      { path: 'eel.chainPerLevel', min: 0, max: 5, step: 1 },
      { path: 'eel.initialRange', min: 2, max: 40, step: 1 },
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
    ],
  },
  {
    group: 'Starfish',
    panel: 'companions',
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
    items: [
      { path: 'seagullBomb.baseFireRate', min: 0.5, max: 10, step: 0.1 },
      { path: 'seagullBomb.fireRatePerLevel', min: 0.5, max: 1, step: 0.01, label: 'fire rate mult per level' },
      { path: 'seagullBomb.damage', min: 1, max: 150, step: 1 },
      { path: 'seagullBomb.splashDamage', min: 0, max: 80, step: 1 },
      { path: 'seagullBomb.splashRadius', min: 0.5, max: 10, step: 0.1 },
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
    ],
  },
  {
    group: 'Baby beluga',
    panel: 'companions',
    items: [
      { path: 'beluga.fireRate', min: 0.3, max: 8, step: 0.1 },
      { path: 'beluga.trapDuration', min: 0.5, max: 10, step: 0.1 },
      { path: 'beluga.baseBubbleRadius', min: 0.1, max: 2, step: 0.05, label: 'base bubble size' },
      { path: 'beluga.radiusPerLevel', min: 0, max: 0.5, step: 0.02, label: 'bubble size growth per level' },
      { path: 'beluga.orbitRadius', min: 0.5, max: 5, step: 0.1 },
      { path: 'beluga.orbitDepth', min: 0, max: 6, step: 0.1, label: 'orbit depth (3D)' },
      { path: 'beluga.orbitSpeed', min: -4, max: 4, step: 0.1 },
      { path: 'beluga.followSpring', min: 2, max: 80, step: 1, label: 'follow springiness' },
      { path: 'beluga.followDamping', min: 0.5, max: 20, step: 0.5, label: 'follow damping' },
      { path: 'beluga.bobAmount', min: 0, max: 2, step: 0.05, label: 'swim bob' },
      { path: 'beluga.speed', min: 2, max: 30, step: 1 },
      { path: 'beluga.offsetX', min: -10, max: 10, step: 0.1, label: 'offset X' },
      { path: 'beluga.offsetY', min: -10, max: 10, step: 0.1, label: 'offset Y' },
      { path: 'beluga.offsetZ', min: -10, max: 10, step: 0.1, label: 'offset Z (depth)' },
    ],
  },
  {
    group: "Bakalar's boat",
    panel: 'companions',
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
      { path: 'bakalar.netColor', type: 'color', label: 'net color' },
      { path: 'bakalar.netOpacity', min: 0, max: 1, step: 0.02, label: 'net opacity' },
      { path: 'bakalar.haulSpeed', min: 0.5, max: 30, step: 0.5, label: 'haul speed' },
      { path: 'bakalar.bobSpeed', min: 0, max: 6, step: 0.1, label: 'hull bob speed' },
      { path: 'bakalar.bobAmount', min: 0, max: 2, step: 0.02, label: 'hull bob' },
    ],
  },
  {
    group: 'Calamari ring',
    panel: 'companions',
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
    group: 'Level-up card art',
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
    items: [
      { path: 'bloom.enabled', type: 'bool', label: 'neon glow' },
      { path: 'bloom.threshold', min: 0.1, max: 1, step: 0.02, label: 'glow threshold' },
      { path: 'bloom.intensity', min: 0, max: 3, step: 0.05, label: 'glow amount' },
      { path: 'bloom.radius', min: 1, max: 8, step: 1, label: 'glow spread' },
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
    ],
  },
  {
    group: 'Feel',
    items: [
      { path: 'fx.hitstopScale', min: 0.01, max: 1, step: 0.01, label: 'hit-stop slowdown' },
      { path: 'fx.hitstopCooldown', min: 0, max: 2, step: 0.05, label: 'hit-stop cooldown' },
      { path: 'fx.maxShake', min: 0, max: 3, step: 0.05, label: 'max shake' },
      { path: 'fx.hitPop', min: 0, max: 1.5, step: 0.05, label: 'enemy hit pop' },
      { path: 'feedback.kill.shake', min: 0, max: 2, step: 0.05, label: 'kill shake' },
      { path: 'feedback.playerHit.shake', min: 0, max: 3, step: 0.05, label: 'damage shake' },
      { path: 'feedback.kill.ripple.strength', min: 0, max: 10, step: 0.1, label: 'kill grid punch' },
      { path: 'emitters.explosion.count', min: 0, max: 200, step: 5, label: 'explosion bits' },
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
    items: [
      { path: 'touch.stickRadius', min: 20, max: 160, step: 5, label: 'full deflection (px)' },
      { path: 'touch.deadzone', min: 0, max: 30, step: 1, label: 'stick deadzone (px)' },
      { path: 'touch.fireAt', min: 0, max: 1, step: 0.05, label: 'fire past deflection' },
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
      { path: 'death.restart.time', min: 0, max: 3, step: 0.05, label: 'try-again glide back (s)' },
      { path: 'death.restart.filterGlide', min: 0.05, max: 1, step: 0.01, label: 'filter sweep (x glide)' },
      { path: 'feedback.seabedImpact.shake', min: 0, max: 2, step: 0.05, label: 'landing shake' },
      { path: 'emitters.silt.count', min: 0, max: 200, step: 5, label: 'silt bits' },
    ],
  },
  {
    group: 'View',
    items: [
      { path: 'arena.viewHeight', min: 20, max: 120, step: 2 },
      { path: 'arena.surfaceFromTop', min: 0, max: 0.6, step: 0.01, label: 'water line' },
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
  { name: u.name, desc: u.desc, maxStacks: u.maxStacks, enabled: u.enabled, cardArt: null },
]));

// Parsed once — the file can't change without a page reload, since it's the
// dev server that notices the write.
const UPGRADE_ROWS = parseUpgradeCsv(upgradesCsv);

// Project tuning imported from another session — merged before DEFAULTS so
// Reset and fresh loads match the exported values.
const diskTuning = withoutLegacyUpgradeKeys(importedTuning);
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

// The CSV is applied AFTER the merge, at every load path, so the file always
// wins over a saved snapshot. It has to be this way round: saved tuning is
// whatever the browser last cached, the file is what you just edited, and the
// one you just edited is the one you expect to see.
applyUpgradesFromTable();

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
  applyUpgradeTable(CONFIG.upgrades, UPGRADE_BASE, UPGRADE_ROWS, LEVELUP_IMAGE_KEYS);
}

// These two used to be saved tuning, and every snapshot written before the
// move to upgrades.csv still carries them. Left alone they'd merge back into
// CONFIG, get written out again on the next save, and sit in the file forever
// looking like live settings while nothing read them. Dropped on the way in
// instead — the CSV is the only source for both now.
function withoutLegacyUpgradeKeys(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (!('upgradeOverrides' in snapshot) && !snapshot.levelUpCards?.assignments) return snapshot;
  const { upgradeOverrides, ...rest } = snapshot;
  if (rest.levelUpCards?.assignments) {
    const { assignments, ...cards } = rest.levelUpCards;
    rest.levelUpCards = cards;
  }
  return rest;
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
}

// Stamped into every snapshot so the two copies can be ordered on load.
// Without it there's no way to tell a stale browser cache from a fresh one
// that's holding edits the disk write never received.
const SAVED_AT = '_savedAt';

function tuningSnapshot() {
  const snapshot = {};
  for (const key of Object.keys(DEFAULTS)) snapshot[key] = CONFIG[key];
  snapshot[SAVED_AT] = Date.now();
  return snapshot;
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
    const snapshot = withoutLegacyUpgradeKeys(JSON.parse(raw));

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
    applyUpgradesFromTable();
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
  const snapshot = withoutLegacyUpgradeKeys(rawSnapshot);
  for (const key of Object.keys(snapshot)) {
    const sv = snapshot[key];
    if (CONFIG[key] && typeof CONFIG[key] === 'object' && sv && typeof sv === 'object') {
      deepMerge(CONFIG[key], sv);
    } else if (sv !== undefined && typeof sv !== 'object') {
      CONFIG[key] = sv;
    }
  }
  pruneUnknownEnemies();
  applyUpgradesFromTable();
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
