-- ============================================================================
-- WETRIS'S TUNABLES — one row per slider in the in-game tuner.
--
-- sealitaire's tuning.luau, the same shape and the same loop: this file is
-- BOTH the defaults the board starts from and the panel's row list. Press T
-- (or click the score) for the panel, drag a knob, press SAVE; the board
-- prints the live values and tools/wetris-tune.mjs (`npm run wetris`) writes
-- them back into the `value =` of each row here, and the watcher rebuilds.
-- Tune live, save, and the numbers are in source.
--
-- `cat` groups rows under a header, in order of first appearance; a header
-- folds. Keys are the labels.
--
-- The water, goo, surface, crt and seal numbers START as sealitaire's tuned
-- values (2026-09-24) and are wetris's own from here: a save writes this file,
-- never sealitaire's. The water SHADERS are shared (test:wetrisshared); the
-- numbers fed to them are not.
--
-- Look and feel only. Anything that decides the game — gravity, lock delay,
-- scoring — is wetris.luau's, where tests.luau can see it.
-- ============================================================================

export type Row = { key: string, min: number, max: number, value: number, cat: string }

local rows: { Row } = {
    -- the water (vortex.wgsl)
    { key = 'twist', min = 0, max = 5, value = 4.2609, cat = 'water' },
    { key = 'waterSpeed', min = 0, max = 3, value = 1.0067, cat = 'water' },
    { key = 'waterBright', min = 0.2, max = 2, value = 1.2855, cat = 'water' },
    { key = 'warp', min = 0, max = 2, value = 1.4174, cat = 'water' },
    { key = 'vortexX', min = 0, max = 1, value = 0.5, cat = 'water' },                -- the eye across the screen
    { key = 'vortexY', min = 0, max = 1, value = 0.52188, cat = 'water' },                -- the eye's height, a fraction of the screen: a little below centre so the water turns round the stack
    { key = 'energyDecay', min = 0.05, max = 3, value = 1.8053, cat = 'water' },           -- per second the water calms after a lock or a clear
    -- the vortex's shape (whirl.wgsl, sealitaire's vortex with its constants
    -- exposed; every default is the constant it replaced)
    { key = 'swirlCore', min = 0.02, max = 2, value = 1.589, cat = 'vortex' },          -- how hard the eye spins: small is a tight fast core
    { key = 'swirlTight', min = 0, max = 6, value = 2.3522, cat = 'vortex' },             -- how fast the twist falls off away from the eye
    { key = 'swirlReach', min = 0.1, max = 3, value = 1.4, cat = 'vortex' },           -- how far out (screen heights) the twist reaches before it lets go
    { key = 'energySpin', min = 0, max = 8, value = 4.5057, cat = 'vortex' },               -- how much a lock or a clear spins the water up
    { key = 'eyeDark', min = 0, max = 1, value = 0.45, cat = 'vortex' },               -- how dark the eye goes
    { key = 'eyeSize', min = 0.01, max = 1, value = 0.1703, cat = 'vortex' },            -- ...over how wide a hole
    { key = 'depthReach', min = 0.05, max = 3, value = 1.1756, cat = 'vortex' },          -- how far out the deep navy fades to the mid blue
    { key = 'ringWarp', min = 0, max = 3, value = 0.77761, cat = 'vortex' },               -- how much a ripple bends the noise it passes through
    { key = 'ringGlow', min = 0, max = 2, value = 1.0743, cat = 'vortex' },               -- how bright a ripple's ring draws
    { key = 'waterVignette', min = 0, max = 1, value = 0.9529, cat = 'vortex' },          -- the water's own edge darkening (the CRT has another)
    -- the water's noise (whirl.wgsl's fbm and its creases)
    { key = 'noiseScale', min = 0.2, max = 5, value = 1.2569, cat = 'noise' },           -- how big the pattern is: small is broad, large is fine
    { key = 'octaves', min = 1, max = 7, value = 5, cat = 'noise' },                   -- layers of detail; fractional values fade the last one in
    { key = 'warpDrift', min = 0, max = 5, value = 4.8119, cat = 'noise' },                 -- how fast the domain warp itself crawls
    { key = 'noiseDrift', min = -3, max = 3, value = 0, cat = 'noise' },               -- a straight slide of the whole pattern, on top of the spin
    { key = 'crease', min = 0.2, max = 4, value = 0.8262, cat = 'noise' },                  -- the ridges' sharpness: under 1 soft swells, over 1 knife-edged creases
    { key = 'tealMix', min = 0, max = 2, value = 0.9, cat = 'noise' },                 -- how much the noise lifts the water to teal
    { key = 'foamEdge', min = 0, max = 1, value = 0.55, cat = 'noise' },               -- where on a crease the foam starts
    { key = 'foamSoft', min = 0.01, max = 1, value = 0.4, cat = 'noise' },             -- how soft the foam's edge is
    { key = 'foamAmount', min = 0, max = 1.5, value = 0.22, cat = 'noise' },           -- the foam at rest
    { key = 'foamEnergy', min = 0, max = 2, value = 0.3, cat = 'noise' },              -- ...and how much more a lock or a clear whips up
    -- the water's grade, laid over the vortex's palette (0, 1, 1 is untouched)
    { key = 'waterHue', min = -0.5, max = 0.5, value = 0, cat = 'noise' },             -- turns of the colour wheel
    { key = 'waterSat', min = 0, max = 2, value = 1, cat = 'noise' },
    { key = 'waterContrast', min = 0.3, max = 2.5, value = 1, cat = 'noise' },
    -- the goo (goo.wgsl, puddle.luau). Its px numbers ride the cell, against a 45px one.
    { key = 'goo', min = 0, max = 1, value = 1, cat = 'goo' },                         -- the layer's opacity
    { key = 'gooSkirt', min = 0, max = 40, value = 10.934, cat = 'goo' },              -- px of goo showing round the stack
    { key = 'gooBlend', min = 0.1, max = 3, value = 0.85, cat = 'goo' },                -- CELLS apart at which two shapes still fuse: the piece reaches for the stack inside this
    { key = 'gooWobble', min = 0, max = 30, value = 23.64, cat = 'goo' },             -- px the membrane jiggles
    { key = 'gooSplash', min = 0, max = 3, value = 2.7302, cat = 'goo' },              -- droplets per lock or cleared row, scale
    -- the surface (surface.wgsl)
    { key = 'caustics', min = 0, max = 2, value = 0.68846, cat = 'surface' },
    { key = 'bubbles', min = 0, max = 2, value = 0.21638, cat = 'surface' },
    { key = 'waves', min = 0, max = 2, value = 0.89459, cat = 'surface' },
    { key = 'glint', min = 0, max = 2, value = 0.75216, cat = 'surface' },
    { key = 'rippleRelief', min = 0, max = 3, value = 3, cat = 'surface' },
    { key = 'reflect', min = 0, max = 2, value = 1.4859, cat = 'surface' },
    { key = 'reflectTilt', min = 1, max = 12, value = 5, cat = 'surface' },
    { key = 'refract', min = 0, max = 40, value = 36.444, cat = 'surface' },
    { key = 'turbulence', min = 0, max = 2, value = 0.90521, cat = 'surface' },
    -- the whitewater (foam.wgsl)
    { key = 'whitewater', min = 0, max = 2, value = 0.34671, cat = 'foam' },
    { key = 'foamFade', min = 0.2, max = 4, value = 2.4882, cat = 'foam' },
    -- the screen (crt.wgsl)
    { key = 'curve', min = 0, max = 0.15, value = 0.018058, cat = 'crt' },
    { key = 'scanlines', min = 0, max = 1, value = 0.48994, cat = 'crt' },
    { key = 'aberration', min = 0, max = 0.02, value = 0, cat = 'crt' },
    { key = 'vignette', min = 0, max = 1, value = 0.54835, cat = 'crt' },
    { key = 'shadowMask', min = 0, max = 1, value = 0.29396, cat = 'crt' },            -- the RGB mask; it rode the scanlines (0.6 of them) and is its own now, starting where yours left it
    { key = 'scanDrift', min = -10, max = 10, value = 0.5, cat = 'crt' },              -- how fast the scanlines crawl
    { key = 'brightLift', min = 0, max = 1, value = 0.25, cat = 'crt' },               -- the bloom-ish lift on the brights
    { key = 'flicker', min = 0, max = 0.3, value = 0.03, cat = 'crt' },
    { key = 'flickerRate', min = 0, max = 80, value = 37, cat = 'crt' },
    { key = 'edgeGlow', min = 0, max = 4, value = 1, cat = 'crt' },                    -- the glass's glow at the screen's edge
    { key = 'grain', min = 0, max = 0.3, value = 0, cat = 'crt' },                     -- film grain, per frame; off by default
    { key = 'grainSize', min = 1, max = 8, value = 1.5, cat = 'crt' },                 -- px a grain covers
    -- the ink: the stack's colours running into each other (ink.luau, crt.wgsl inkAt)
    { key = 'mixTime', min = 1, max = 120, value = 1.3734, cat = 'ink' },                  -- seconds for a locked cell to ripen (e-folding): how slowly the colours run
    { key = 'mixReach', min = 0.3, max = 2.5, value = 1.8751, cat = 'ink' },              -- CELLS a fully ripe cell's colour reaches into its neighbours
    { key = 'mixSwirl', min = 0, max = 1.5, value = 0.21044, cat = 'ink' },               -- CELLS the slow swirl marbles a ripe stack by
    { key = 'fuseReach', min = 0, max = 0.5, value = 0.24036, cat = 'ink' },               -- the THRESHOLD: CELLS apart two locked tiles' edges may be and still melt into one (the gap between neighbours is 0.07; past half a cell it would reach tiles the 3x3 in crt.wgsl stackAt does not look at, and seams appear on the cell lines)
    { key = 'fuseAmount', min = 0, max = 2, value = 1.3801, cat = 'ink' },                -- how far they melt once inside it, riding the same ripeness clock as the colour: 0 crisp tiles, 1 a smooth union, 2 a bulging goo
    { key = 'skirtTint', min = 0, max = 1, value = 0.7, cat = 'ink' },               -- how much the goo skirt takes the colour of the blocks it clings to: 0 the water's own teal
    { key = 'skirtReach', min = 0.1, max = 1.5, value = 0.5, cat = 'ink' },           -- CELLS over which the skirt's colour blends between neighbouring blocks: small follows each block, large one wash
    -- the tiles, faux 3-D (crt.wgsl tileAt / shadeTop): bevel and extrusion in CELLS
    { key = 'bevel', min = 0, max = 0.5, value = 0.15124, cat = 'tiles' },                -- how much of a tile the rounded bevel takes
    { key = 'extrude', min = 0, max = 0.5, value = 0.30145, cat = 'tiles' },              -- how deep the side shows, down-right away from the light
    { key = 'gloss', min = 0, max = 2, value = 1.1556, cat = 'tiles' },                     -- the highlights, tiles and drips
    { key = 'film', min = 0, max = 2, value = 1.4018, cat = 'tiles' },                    -- the wet film sliding over a tile's face
    { key = 'tileShadow', min = 0, max = 1, value = 0, cat = 'tiles' },
    { key = 'tileReflect', min = 0, max = 1.5, value = 1.2401, cat = 'tiles' },          -- how much water the bevels and drips mirror (Fresnel)
    -- the drips the falling piece sheds (drips.luau)
    { key = 'dripRate', min = 0, max = 30, value = 3.1161, cat = 'drips' },                 -- drops per second from a piece at rest
    { key = 'dripSpeedRate', min = 0, max = 4, value = 0.29754, cat = 'drips' },           -- more per cell/s the piece is moving
    { key = 'dripInherit', min = 0, max = 1.5, value = 0.85, cat = 'drips' },          -- how much of its cell's velocity (glide AND turn) a drop leaves with
    { key = 'dripFling', min = 0, max = 40, value = 19.731, cat = 'drips' },               -- the fastest a drop may leave, CELLS per second: caps the turn's fling
    { key = 'dripForm', min = 0.05, max = 3, value = 0.7, cat = 'drips' },             -- seconds a drop gathers on the piece's outline before it lets go
    { key = 'dripGel', min = 0, max = 0.95, value = 0.7, cat = 'drips' },              -- how hard the goo clings to the tiles, as a share of the iso: under 1 so a tile never grows a halo on its own
    { key = 'gelReach', min = 0.05, max = 1, value = 0.4, cat = 'drips' },             -- CELLS out from a tile's edge the cling reaches
    { key = 'dripSize', min = 0.03, max = 0.4, value = 0.056192, cat = 'drips' },          -- radius, in CELLS
    { key = 'dripGravity', min = 0, max = 120, value = 30, cat = 'drips' },            -- CELLS per second squared
    { key = 'dripDrag', min = 0, max = 8, value = 4.1827, cat = 'drips' },                -- per second, in the water
    { key = 'dripStain', min = 0, max = 1, value = 0.35, cat = 'drips' },              -- how far one drop moves the cell it lands on toward its colour
    { key = 'dripStretch', min = 0, max = 0.1, value = 0.05485, cat = 'drips' },         -- seconds of travel the tail trails by: the faster a drop falls the longer its teardrop
    { key = 'dripIso', min = 0.1, max = 0.9, value = 0.35, cat = 'drips' },            -- the metaball threshold: lower welds drops sooner
    { key = 'dripHeight', min = 0, max = 12, value = 1.2317, cat = 'drips' },               -- how domed a bead's shading is
    -- the sound (sound.luau): the takes are sealitaire's, already through its
    -- bank-wide low-pass; the bus is a reverb crossfaded down four baked cutoffs
    { key = 'musicVolume', min = 0, max = 1, value = 0.5, cat = 'sound' },            -- the loop (music.luau)
    { key = 'sfxVolume', min = 0, max = 1, value = 0.8, cat = 'sound' },
    { key = 'busSend', min = 0, max = 1.5, value = 0, cat = 'sound' },               -- the reverb bus under every dry take (each event's `send` scales it); 0 is dry only
    { key = 'busSweep', min = 0, max = 1, value = 0, cat = 'sound' },                -- the bus's low-pass, swept DOWN: 0 open (12kHz), 1 darkest (400Hz)
    -- the board
    { key = 'glide', min = 4, max = 60, value = 25.902, cat = 'board' },                   -- per second the drawn piece catches the rules' one: low glides, high snaps
    { key = 'spin', min = 4, max = 60, value = 18, cat = 'board' },                    -- per second the drawn piece turns through a rotation: low sweeps, high snaps
    -- the seal's body and swim (swimmer.luau, puppet.luau)
    { key = 'sealLength', min = 2, max = 9, value = 7.6449, cat = 'seal' },               -- body length in CELLS
    { key = 'thrust', min = 2, max = 60, value = 9.6368, cat = 'seal' },
    { key = 'friction', min = 0.8, max = 0.995, value = 0.965, cat = 'seal' },
    { key = 'maxSpeed', min = 4, max = 80, value = 34, cat = 'seal' },
    { key = 'turnLerp', min = 1, max = 20, value = 2.5337, cat = 'seal' },
    { key = 'steer', min = 0.5, max = 12, value = 11.475, cat = 'seal' },
    { key = 'arrive', min = 0.1, max = 1.5, value = 0.1, cat = 'seal' },
    { key = 'steerTight', min = 0.2, max = 3, value = 2.2832, cat = 'seal' },
    { key = 'landEase', min = 0, max = 30, value = 3.1042, cat = 'seal' },
    { key = 'lean', min = 0, max = 0.9, value = 0.6287, cat = 'seal' },
    { key = 'blendRate', min = 0.5, max = 8, value = 2.3, cat = 'seal' },
    { key = 'blendTime', min = 0, max = 1.5, value = 0.6, cat = 'seal' },
    { key = 'turnSettle', min = 1, max = 15, value = 11.71, cat = 'seal' },
    -- the seal's clips
    { key = 'moveThreshold', min = 0.2, max = 6, value = 1.5, cat = 'clips' },
    { key = 'boostThreshold', min = 4, max = 40, value = 18.767, cat = 'clips' },
    { key = 'crossfade', min = 0.02, max = 1, value = 0.2, cat = 'clips' },
    { key = 'clipScale', min = 0.2, max = 3, value = 1, cat = 'clips' },
    { key = 'wagAmp', min = 0, max = 0.6, value = 0.12, cat = 'clips' },
    { key = 'wagSpeed', min = 0, max = 10, value = 4.2, cat = 'clips' },
    { key = 'jawOpen', min = 0, max = 1.2, value = 0.5, cat = 'clips' },
    { key = 'gazeShare', min = 0, max = 1.5, value = 1.1531, cat = 'clips' },
    -- the flippers: the aim at the piece, and the flick on every input
    { key = 'finAim', min = 0, max = 1, value = 0.85, cat = 'fins' },                  -- the aim's weight: 0 the flippers only swim, 1 they point straight at the piece
    { key = 'finReach', min = 0, max = 2.6, value = 1.5429, cat = 'fins' },               -- radians a flipper may swing off the pose the clip left it in
    { key = 'finEase', min = 1, max = 30, value = 10.678, cat = 'fins' },                   -- how eagerly the aim arrives and lets go
    { key = 'flickTime', min = 0.08, max = 1, value = 0.38283, cat = 'fins' },             -- seconds a flick takes: wind up, sweep, settle
    { key = 'flickArc', min = 0, max = 1.6, value = 0.39884, cat = 'fins' },                 -- radians either side of the aim the flick sweeps
    -- the celebration (react.luau)
    { key = 'reactSpeed', min = 0.3, max = 2.5, value = 1, cat = 'react' },
    { key = 'clapRaise', min = 0, max = 2, value = 1.4, cat = 'react' },
    { key = 'releaseLift', min = 0, max = 2, value = 0.8, cat = 'react' },             -- how far toward the viewer a celebration lifts the body
    -- the hide (seal.wgsl)
    { key = 'mottleSize', min = 0.01, max = 0.3, value = 0.05, cat = 'hide' },
    { key = 'mottleStrength', min = 0, max = 1.5, value = 0.83, cat = 'hide' },
    { key = 'mottleContrast', min = 0.2, max = 6, value = 3.55, cat = 'hide' },
    { key = 'rim', min = 0, max = 2, value = 0.9, cat = 'hide' },
    -- the seal in cubes (cubes.luau, voxel.wgsl)
    { key = 'voxelOn', min = 0, max = 1, value = 1, cat = 'cubes' },                   -- above a half the seal is drawn in cubes, below it the smooth mesh
    { key = 'voxelRes', min = 12, max = 96, value = 78.377, cat = 'cubes' },               -- cubes nose to tail; each whole step rebuilds the mesh
    { key = 'voxelWhisker', min = 0.1, max = 0.8, value = 0.3, cat = 'cubes' },          -- a whisker cube's edge as a share of a body cube's; every hundredth rebuilds
    { key = 'voxelFill', min = 0.6, max = 1, value = 0.72261, cat = 'cubes' },               -- a cube's size against its cell: 1 they touch, less opens a gap between them
    { key = 'voxelRim', min = 0, max = 1, value = 0.86883, cat = 'cubes' },               -- the hide's rim light on cubes, as a share of rim: edge-on faces are everywhere on a block body
    { key = 'voxelEdge', min = 0, max = 1, value = 0.23579, cat = 'cubes' },              -- how dark each face goes toward its rim, so a flat run still reads as blocks
}

return rows
