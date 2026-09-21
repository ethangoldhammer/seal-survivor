-- ============================================================================
-- THE TABLE — everything in Sealitaire that moves, in one Layout script that
-- fills the artboard.
--
-- Three layers, composited here:
--
--   1. WATER      vortex.wgsl into a GPU canvas. A card landing pushes a
--                 ripple in; the vortex's energy spikes and decays.
--   2. CARDS      the Card Face / Card Back artboards, instanced per card,
--                 drawn through the Rive renderer with a per-card transform.
--                 Every card has springs on position, rotation and scale, a
--                 pseudo-3D tilt toward the pointer, and a flip that scales
--                 X through zero — the Balatro feel.
--   1b. GOO       goo.wgsl into a half-size GPU canvas: the distance field of
--                 every stack, flier and droplet (puddle.luau), laid over the
--                 water by the CRT pass.
--   1b'. FOAM     foam.wgsl, a half-size buffer that persists (two canvases,
--                 ping-pong): the whitewater, carried by the vortex's flow,
--                 fed by card impacts, cards on the move and the seal.
--   1c. SURFACE   surface.wgsl: the water as a lit 3-D sheet over both — a
--                 height field from the swell, the ripples, the hand, the
--                 seal's wake and the goo's silhouette; refracts what is
--                 under it, lays caustics, raises bubbles the goo pops. Its
--                 output is the water the CRT samples.
--   3. THE SEAL   seal.wgsl: the fur seal's skinned mesh in a depth-tested
--                 GPU canvas. Its neck bends toward the hovered (or dragged)
--                 card the way systems/aimRig.js aims the run's seal at the
--                 upgrade cards.
--
-- Then crt.wgsl samples all of it (drawn into a 2-D canvas) for the screen.
--
-- THE MUSIC runs across all of it: music.luau reads the track's baked FFT
-- (music.bin) against the sound's own playhead and pushes ripples in on the
-- band onsets, into a ring of their own so they cannot crowd out a play's.
--
-- The RULES are klondike.luau; this file never decides legality itself.
-- ============================================================================

local K = require('klondike')
local TUNING = require('tuning')
local KNOCK = require('knock')
local HOVER = require('hover')
local REACT = require('react')
local PUPPET = require('puppet')
local BAIT = require('baitball')
local RIG = require('tankrig')
local PUDDLE = require('puddle')
local MUSIC = require('music')
local LAYOUT = require('layout')
local PAD = require('pad')
local BUB = require('bubbles')
local FOAM_STEPS = 8   -- most sub-steps the foam takes in one draw (see drawFoam)

-- THE LIVE VALUES. Every slider in tuning.luau, by key, read each frame by
-- whatever it tunes — the panel writes here, "save" prints them for
-- tools/sealitaire-tune.mjs to write back into the file.
local T: { [string]: number } = {}
for _, row in ipairs(TUNING) do
    T[row.key] = row.value
end

-- The water's shaders, by mode: `waterMode` in tuning.luau picks one (the
-- vortex by default), W cycles them. Each is a .wgsl of the same name.
local WATER_MODES = { 'vortex', 'paint', 'caustic', 'marble' }
local function waterMode(): number
    return math.min(math.max(math.floor(T.waterMode + 0.5), 0), #WATER_MODES - 1) + 1
end

-- The card rim's materials, all one shader (crt.wgsl's rimShade): the mode is
-- a number in the card table, per entry, so a rim per suit or per rank is a
-- change to what table.luau writes and nothing else. `cardRimMode` in
-- tuning.luau picks one for every card, R cycles them.
local RIM_MODES = { 'pearl', 'emissive', 'metallic', 'reflective', 'refractive', 'holographic', 'chrome' }
local function cardRimMode(): number
    return math.min(math.max(math.floor(T.cardRimMode + 0.5), 0), #RIM_MODES - 1) + 1
end

-- THE CARD ROWS: the tuner's first category edits ONE CARD's tanks.csv row
-- rather than a key of T — the SUBJECT, which is whatever card was last
-- clicked with the panel open. That is what makes the panel a lab rather
-- than a list of globals: pick a card on the table, step it through every
-- species the pack holds, size and colour it, and SAVE prints a TANKS-SAVE
-- line per touched card that tools/sealitaire-tune.mjs writes back into
-- tanks.csv. The model row walks `self.pool` — every species in fish.mesh but
-- the bubble — so a lab bake (`npm run sealitaire:pool`) is what makes it
-- worth opening; the ship bake holds only what tanks.csv already uses.
-- `step` quantises a knob (the model index, the count); 0 is continuous.
type SubjectRow = { key: string, min: number, max: number, step: number }
local SUBJECT_ROWS: { SubjectRow } = {
    { key = 'model', min = 1, max = 1, step = 1 },       -- max becomes #pool when the pack loads
    { key = 'count', min = 1, max = 16, step = 1 },
    { key = 'size', min = 0.2, max = 10, step = 0 },
    { key = 'backR', min = 0, max = 1, step = 0 },
    { key = 'backG', min = 0, max = 1, step = 0 },
    { key = 'backB', min = 0, max = 1, step = 0 },
    { key = 'bellyR', min = 0, max = 1, step = 0 },
    { key = 'bellyG', min = 0, max = 1, step = 0 },
    { key = 'bellyB', min = 0, max = 1, step = 0 },
    { key = 'bgR', min = 0, max = 1, step = 0 },
    { key = 'bgG', min = 0, max = 1, step = 0 },
    { key = 'bgB', min = 0, max = 1, step = 0 },
    -- The layout, per card: a row reads the tuner's global until dragged,
    -- and then holds its own number (a tanks.csv cell); RESET blanks it.
    { key = 'colGap', min = 0.2, max = 2, step = 0 },
    { key = 'rowGap', min = 0.2, max = 2, step = 0 },
    { key = 'padX', min = 0, max = 0.6, step = 0 },
    { key = 'padY', min = 0, max = 0.6, step = 0 },
    { key = 'drop', min = -0.8, max = 0.8, step = 0 },
    -- The three axes: `rotate` leans in the card plane, `yaw` turns about
    -- the card's vertical (toward the viewer), `roll` rolls about the body.
    { key = 'rotate', min = -1.57, max = 1.57, step = 0 },
    { key = 'rotateVary', min = 0, max = 1.57, step = 0 },
    { key = 'yaw', min = -1.57, max = 1.57, step = 0 },
    { key = 'roll', min = -3.14, max = 3.14, step = 0 },
    { key = 'sway', min = 0, max = 1, step = 0 },          -- the idle rock and breathing; 0 is dead still
    { key = 'loop', min = 0, max = 1, step = 1 },          -- a lone creature: 0 holds the centre, 1 swims the oval (blank: aces loop, the court holds)
    -- The glow: a noise field through the whole tank, tinted per card.
    { key = 'bio', min = 0, max = 2, step = 0 },
    { key = 'bioR', min = 0, max = 1, step = 0 },
    { key = 'bioG', min = 0, max = 1, step = 0 },
    { key = 'bioB', min = 0, max = 1, step = 0 },
    -- The field, per card: blank reads the tuner's global (LAYOUT_ROWS).
    { key = 'bioSpeed', min = 0, max = 3, step = 0 },
    { key = 'bioScale', min = 0.1, max = 3, step = 0 },
    { key = 'bioContrast', min = 0.5, max = 4, step = 0 },
    { key = 'bioCoverage', min = 0, max = 1, step = 0 },
    { key = 'bioPan', min = -180, max = 180, step = 0 },
    { key = 'bioEvolve', min = 0, max = 3, step = 0 },
}
-- The per-card layout fields, and the tuner key each falls back to.
local LAYOUT_ROWS: { [string]: string } = {
    colGap = 'pipColGap', rowGap = 'pipRowGap', padX = 'fishPadX', padY = 'fishPadY',
    drop = 'pipDrop', rotate = 'pipRotate', rotateVary = 'pipRotateVary',
    yaw = 'pipYaw', roll = 'pipRoll', sway = 'pipSway',
    bioSpeed = 'bioSpeed', bioScale = 'bioScale', bioContrast = 'bioContrast', bioCoverage = 'bioCoverage', bioPan = 'bioPan', bioEvolve = 'bioEvolve',
}
-- The colour rows, by key: which of the record's three colours, which channel.
local COLOUR_ROWS: { [string]: { name: string, ch: number } } = {
    backR = { name = 'back', ch = 1 }, backG = { name = 'back', ch = 2 }, backB = { name = 'back', ch = 3 },
    bellyR = { name = 'belly', ch = 1 }, bellyG = { name = 'belly', ch = 2 }, bellyB = { name = 'belly', ch = 3 },
    bgR = { name = 'bg', ch = 1 }, bgG = { name = 'bg', ch = 2 }, bgB = { name = 'bg', ch = 3 },
    bioR = { name = 'bioColor', ch = 1 }, bioG = { name = 'bioColor', ch = 2 }, bioB = { name = 'bioColor', ch = 3 },
}
-- A headless run with `--data=lab=<species>` (tools/sealitaire-sheet.mjs)
-- puts that species on every card and deals this seed, so the contact sheet
-- shows each creature on the same seven faces.
local LAB_SEED = 7

-- ---------------------------------------------------------------------------
-- Geometry, in artboard units — which are the VIEWPORT's units, because the
-- artboard is fill-sized. So there is no fixed table: `self.L` is the whole
-- of it, recomputed by layout.luau every time the window changes size, and
-- every number below that used to be a constant is read off it.
--
-- Two scales come out of that and they are not the same. `L.fit` is the
-- CARD's — a card artboard is 120x168 whatever the screen is, and fit is what
-- puts it on screen at L.cw x L.ch, so it also scales the rim, the goo, a
-- droplet and every other number that was measured against a card. `L.ui` is
-- the CHROME's, and it barely moves: a 13px label is read at arm's length on
-- a phone and on a monitor alike, so the HUD is anchored to the corners at
-- close to its design size rather than shrunk into them.
--
-- The one thing that is still fixed is the card artboard itself.
-- ---------------------------------------------------------------------------
local CARD_W = LAYOUT.CARD_W
local CARD_H = LAYOUT.CARD_H
local COLS = LAYOUT.COLS
-- A first layout, for the frames before the runtime has said how big the
-- window is: `init` runs before `resize` and builds paths against it.
local W0 = 1600
local H0 = 1000
-- A tank card's face is a window onto a 3-D tank the size of the WHOLE
-- card, rounded like the plate (tanks.csv says which cards and what swims;
-- baitball.luau moves it). Every tank on screen takes a SLOT for the frame:
-- a tile of the tank atlas, the same tile of the ink atlas (the card's rank,
-- pips and border with the plate hidden, laid over the creature by the
-- CRT), and a row of the CRT's card table. The mask paints the slot number.
local TILE_COLS = 8
local TILE_ROWS = 7
local TANK_SLOTS = TILE_COLS * TILE_ROWS
-- The procedural sphere tools/sealitaire-fish.mjs always bakes, and how many
-- of it one tank may show at once (baitball.luau caps its own list at 28).
-- The tank uniform: camera and light, then the cel and outline rows the
-- tuner's `toon` category writes, the glow's field, and the dent's shape
-- (its depth and its ringing are per body, in the instance record).
local FISH_UBO = 240
-- The widest the tank sheet may get, in pixels. Two textures this size are
-- held (colour and depth32float), so 2048 is about 16MB each.
local ATLAS_MAX = 2048
local BUBBLE_SPECIES = 'bubble'
local BUBBLES_PER_TANK = 28
-- The closing speed, in tank units per second, that counts as a knock at full
-- volume. Above it a hit is simply loud; the scale is what makes a body
-- drifting into the glass quieter than one flung at it by a drag.
local TANK_HIT_LOUD = 6
-- Seconds between tank knocks, however many bodies are hitting glass.
local TANK_KNOCK_GAP = 0.07
-- THE FAN'S CHOKE. Take the pointer off the deck and the rising sound goes
-- with it — but not by stopping the voice dead, which lands the cut on a
-- non-zero sample and clicks, the same reason the bake fades every take by
-- 2ms. 60ms is short enough to read as "it stopped when I left" and long
-- enough that there is no edge on it.
local HOVER_CHOKE = 0.06
-- Seven shared rows, then five per entry (crt.wgsl's header has the layout).
local CRT_HEAD = 144
local CRT_ENTRY = 80
local CRT_UBO = CRT_HEAD + TANK_SLOTS * CRT_ENTRY
-- The tank camera: straight on, so the frustum's four edges ARE the card's
-- edges, and the sim's walls (BAIT.Walls) are exactly what is visible.
local CAM = { dist = 3.2, fov = 44, zFront = 1.0, zBack = -1.4 }
local WALLS: BAIT.Walls = { dist = CAM.dist, tanHalf = math.tan(math.rad(CAM.fov / 2)), aspect = CARD_W / CARD_H, zFront = CAM.zFront, zBack = CAM.zBack }
local SUIT_NAMES = { 'fish', 'star', 'bubble', 'shell' }
-- The fallback tank backgrounds, for a tanks.csv row whose `bg` is blank.
-- Warm behind a red suit, cold behind a black one.
local SUIT_BG_RED = { 0.11, 0.06, 0.12 }
local SUIT_BG_BLACK = { 0.03, 0.13, 0.24 }
-- The tuner panel: rows and headers are small artboards the script lays out
-- in columns, a category folding on its header. `L.tuner` sizes and places
-- it — right-anchored, one column where two will not fit, scaled down on a
-- small screen — and x0/x1 stay in ROW units (tuner.rml's 380x16 artboard),
-- so a pointer is divided by `L.tuner.scale` before it is read against them.
--
-- 15 headers and 89 rows is 1724px of stack. Two 960px columns hold 1920 of
-- it, which is why the desktop fits and a phone cannot: below that the panel
-- SCROLLS (drag its background) rather than dropping the tail off the bottom,
-- where a slider is invisible and unclickable rather than obviously missing.
-- tunerLayout still says so when even the scroll cannot reach a row.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
type View = {
    x: number, y: number, vx: number, vy: number, tx: number, ty: number,
    rot: number, vrot: number, trot: number,
    scale: number, vscale: number, tscale: number,
    lift: number,          -- shadow distance, smoothed
    pop: HOVER.Pop,        -- the hover pop: 0 at rest, 1 up (hover.luau)
    tiltX: number, tiltY: number, -- pseudo-3D lean, smoothed; the DRAG's bank only, a hover never shears
    flip: number, tflip: number,  -- 0 back .. 1 face
    z: number,
    phase: number,         -- idle sway offset
    fanLift: number,       -- the stock fan's extra shadow
    dealt: boolean,
    inst: Artboard<Data.Card>?,
    ink: Artboard<Data.Card>?,   -- the same face with the plate hidden: a tank card's ink
    pulses: { any },             -- the `pulse` property of each instance (black suits), fed the beat
    glows: { any },              -- the `red`/`black` property of each instance: whichever one is this card's suit, scaled by inkGlow every frame
}

-- One creature of the tank pack (fish.mesh, tools/sealitaire-fish.mjs):
-- its index range, and its own instance buffer, because the GPU API draws
-- from the START of an instance buffer (no first-instance), so each species
-- fills its own.
type Species = {
    name: string,
    firstIndex: number, indexCount: number,
    inst: GPUBuffer?, bytes: buffer, cap: number,
    n: number, at: number,           -- filled this frame
    -- The clip: a bone palette texture, bones*3 wide and `frames` tall, and
    -- the bind group that pairs it with the shared uniform. A species baked
    -- at rest has one frame of one identity bone. `duration` is the clip's
    -- seconds; 0 when there is none.
    bones: number, frames: number, duration: number,
    palette: GPUTexture?, bind: GPUBindGroup?,
    -- THE RIG (rigs.csv, baked into the pack as TNK3). `chains` is empty for
    -- a species with no row, and everything below it then costs nothing.
    -- `bend` is the per-instance bend palette: the same shape of texture as
    -- the clip palette but a row per INSTANCE, solved on the CPU by
    -- bonespring.luau and uploaded on the frames something is moving.
    boneParent: { number }, chains: { any },
    bend: GPUTexture?, bendBytes: buffer, bendRows: number,
    bendLive: { boolean }, bendDirty: boolean, bendOrder: { [number]: number },
}
-- What a card's face holds (one tanks.csv row).
-- The four layout fields are optional: nil means the tuner's global
-- (pipColGap, pipRowGap, fishPadX, fishPadY) and is saved back as a blank cell.
type TankRec = {
    species: Species, rank: number, count: number, size: number,
    back: { number }, belly: { number }, bg: { number },
    -- The sfxEvents.csv event this card's bodies knock with. '' means the
    -- default, `tankWall` — a flick-plop. A card holding something big names
    -- a heavier row here (tanks.csv `knock`), because one sample cannot be
    -- both a sardine off the glass and a whale against it.
    knock: string,
    colGap: number?, rowGap: number?, padX: number?, padY: number?,
    drop: number?, rotate: number?, rotateVary: number?,
    yaw: number?, roll: number?, sway: number?,
    loop: number?,                   -- 1 loops, 0 holds; nil is the rank's default (aces loop, the court holds)
    bio: number,                     -- the glow's strength; 0 is none
    bioColor: { number },            -- rgb
    -- The field's per-card overrides; nil is the tuner's global.
    bioSpeed: number?, bioScale: number?, bioContrast: number?, bioCoverage: number?, bioPan: number?, bioEvolve: number?,
}

-- A TankRec copied field for field, with its three colours copied rather than
-- shared: `tankOrig` is what RESET puts back, and the panel writes into the
-- LIVE record's colour lists.
--
-- A FUNCTION RATHER THAN A LITERAL AT THE CALL SITE, and the literal itself
-- split in two, because both are the CHECKER's budget rather than the
-- reader's. Luau infers a file at a time and table.luau is near the ceiling:
-- one whole-record literal here was "Code is too complex to typecheck" once
-- the glow's per-card columns joined it, and hoisting it out bought back the
-- room the pad's cursor needed years later. The error always lands on the
-- most expensive expression in the file, which is almost never the code that
-- tipped it over — so if it comes back, look for what was ADDED, not for
-- whatever line it is pointing at.
local function copyTank(rec: TankRec): TankRec
    local out: TankRec = {
        species = rec.species, rank = rec.rank, count = rec.count, size = rec.size, knock = rec.knock,
        bio = rec.bio,
        bioColor = { rec.bioColor[1], rec.bioColor[2], rec.bioColor[3] },
        back = { rec.back[1], rec.back[2], rec.back[3] },
        belly = { rec.belly[1], rec.belly[2], rec.belly[3] },
        bg = { rec.bg[1], rec.bg[2], rec.bg[3] },
    }
    out.colGap, out.rowGap, out.padX, out.padY = rec.colGap, rec.rowGap, rec.padX, rec.padY
    out.drop, out.rotate, out.rotateVary = rec.drop, rec.rotate, rec.rotateVary
    out.yaw, out.roll, out.sway, out.loop = rec.yaw, rec.roll, rec.sway, rec.loop
    out.bioSpeed, out.bioScale, out.bioContrast = rec.bioSpeed, rec.bioScale, rec.bioContrast
    out.bioCoverage, out.bioPan, out.bioEvolve = rec.bioCoverage, rec.bioPan, rec.bioEvolve
    return out
end

type Ripple = { x: number, y: number, age: number, strength: number }

-- A bubble rising through the water column, in front of the seal and
-- behind the cards. Spawned below the bottom edge, gone past the top.
type Bubble = { x: number, y: number, r: number, vy: number, phase: number, wobble: number }
local MAX_BUBBLES = 80
-- The seal's own pool (bubbles.luau). Bigger than the ambient column because a
-- somersault sheds off the whole animal at once; `shedMax` is what actually
-- decides the rate, and this is only the ceiling that keeps a frame bounded.
-- One Source per bone that has skin, built once by measureShed and filled in
-- place every frame after that. A fresh list per frame would be 23 tables a
-- frame for the collector to walk.
local shedSrc: { any } = {}

type Drag = {
    pile: K.Pile,
    index: number,
    cards: { K.Card },
    offX: number, offY: number,
    lastX: number, lastY: number,
    -- WHERE THE RUN IS ACTUALLY BEING CARRIED, and how fast. The pointer is
    -- `lastX/lastY`; this is that eased on the FRAME clock (`dragLag`), which
    -- is what the cards are pinned to. `vX/vY` is px/s, for the bank.
    smX: number, smY: number, vX: number, vY: number,
    -- One carried position PER CARD, because a trail is a thing each card
    -- remembers. Chasing them all off one anchor inside a single frame's loop
    -- is not a trail at all — it is the same point arrived at N times.
    trailX: { number }, trailY: { number },
    -- WHO IS CARRYING IT. A pointer drag follows the pointer; a pad drag is
    -- laid on the cursor's pile every frame and has no contact point at all.
    -- One field rather than reading `pad.on`, because the pad can be woken
    -- mid-drag (a stick nudged while the mouse holds a card) and the run must
    -- keep following the hand that picked it up.
    pad: boolean,
}

type Table = {
    -- One face artboard per rank (cards.rml); a card's id fixes its rank.
    faceA: Input<Artboard<Data.Card>>,
    face2: Input<Artboard<Data.Card>>,
    face3: Input<Artboard<Data.Card>>,
    face4: Input<Artboard<Data.Card>>,
    face5: Input<Artboard<Data.Card>>,
    face6: Input<Artboard<Data.Card>>,
    face7: Input<Artboard<Data.Card>>,
    face8: Input<Artboard<Data.Card>>,
    face9: Input<Artboard<Data.Card>>,
    face10: Input<Artboard<Data.Card>>,
    faceJ: Input<Artboard<Data.Card>>,
    faceQ: Input<Artboard<Data.Card>>,
    faceK: Input<Artboard<Data.Card>>,
    back: Input<Artboard<nil>>,
    -- The chrome, one artboard per corner (scene.rml, "THE CHROME"); each is
    -- placed and scaled from L rather than drawn where it was authored.
    hudTitle: Input<Artboard<Data.Table>>,
    hudStats: Input<Artboard<Data.Table>>,
    hudDeal: Input<Artboard<Data.Table>>,
    hudInst: { Artboard<Data.Table> },
    tunerRow: Input<Artboard<Data.TunerRow>>,
    tunerHead: Input<Artboard<Data.TunerHead>>,
    tunerRows: { Artboard<Data.TunerRow> },       -- one per line of tuning.luau
    tunerRowVm: { ViewModel },
    tunerHeads: { Artboard<Data.TunerHead> },     -- one per category, then SAVE and RESET
    tunerHeadVm: { ViewModel },
    tunerCats: { string },                        -- categories in order of first appearance
    tunerCatRows: { { number } },                 -- row indices per category
    tunerCatOpen: { boolean },
    tunerItems: { TunerItem },                    -- this frame's layout
    tunerSpillTold: boolean,                      -- the "rows off the panel" warning is said once, not every frame
    tunerOpen: boolean,
    tunerDrag: number,      -- row index being dragged, or 0
    tunerDragKind: string,  -- 'row' (a tuning.luau key) or 'srow' (a card row)
    -- The lab: the card the CARD rows edit, and what the panel has changed.
    subject: number,        -- card id, 0 for none
    subjectOpen: boolean,   -- the CARD category unfolded (closed until a card is picked)
    subjectRows: { Artboard<Data.TunerRow> },     -- one per SUBJECT_ROWS entry
    subjectRowVm: { ViewModel },
    subjectHead: Artboard<Data.TunerHead>?, subjectHeadVm: ViewModel?,
    suitHead: Artboard<Data.TunerHead>?, suitHeadVm: ViewModel?,
    pool: { Species },      -- every species in the pack but the bubble, by name
    tankOrig: { TankRec },  -- by card id: the row as tanks.csv had it, for RESET
    tankDirty: { [number]: boolean },  -- card ids the panel has changed since load
    lab: string,            -- the `lab` view model string, '' outside a sheet run
    tunerScroll: number,    -- px the columns are lifted by, 0 when they fit
    tunerReach: number,     -- how far they could be lifted, this frame
    tunerPan: number,       -- the y a background drag started at, or -1
    tunerPanFrom: number,
    panelPath: Path,
    panelPaint: Paint,
    thumbPaint: Paint,

    -- The stock's fan: hovering the deck lifts it into a ribbon.
    stockHovered: boolean,
    stockFan: number,       -- 0..1, eased
    stockPulse: number,     -- a click's drop, decaying

    -- The swimmer: the level-up seal's blender, pull and clip controller.
    puppet: PUPPET.Puppet,
    bitten: number,         -- card id the mouth is on (the head of the run in hand), or 0
    biteSide: number,       -- -1 left corner, 1 right corner
    releaseT: number,       -- seconds since the last release, or -1
    clips: { [string]: PUPPET.Clip },
    sealData: buffer?,
    boneAnim: { Mat4 },

    context: Context?,
    -- Where everything is, at this viewport. Rebuilt in `resize`.
    L: LAYOUT.Geom,
    size: Vector,
    scale: number,
    time: number,
    dealTime: number,

    game: K.Game,
    views: { View },        -- by card id
    order: { number },      -- card ids sorted by z, rebuilt when z changes
    orderDirty: boolean,
    backInst: Artboard<nil>?,

    pointer: Vector,
    pointerKnown: boolean,
    hovered: number,        -- card id or 0 — the SETTLED hover the seal and the glow follow
    popped: { number },     -- the card ids whose pop is armed up: the hovered run
    reactSeq: number,       -- bumped on every valid play; the puppet reacts to a new number
    reactVariant: string,   -- the reaction picked for it
    reactLast: string,      -- the one before, so the next is different
    hoverRaw: number,       -- what the pointer is over right now, after the spatial guard
    hoverPending: number,   -- the raw target waiting out the settle time
    hoverSince: number,     -- when it started waiting
    drag: Drag?,
    lastDownId: number,
    lastDownTime: number,
    dealSeed: number,

    -- ONE GESTURE AT A TIME. A pointer event carries the id of the pointer
    -- that made it, and on a phone that is a finger: a second thumb landing
    -- mid-drag arrives as a `pointerDown` like any other and would take the
    -- card out of the first one's hand. So a gesture CLAIMS an id and every
    -- event from another one is dropped until it is let go.
    gestureId: number,      -- the pointer id a drag/scroll/knob belongs to, or -1
    -- IS THIS A FINGER? Nothing in the event says so, and it has to be known:
    -- a finger covers the card it drags and wants the run lifted clear of it,
    -- a mouse cursor covers nothing. What tells them apart is the FREE MOVE —
    -- a mouse reports where it is on the way to a click and a finger never
    -- does, so a press landing somewhere the pointer has never been reported
    -- is a touch. Sticky, so a second click in the same spot does not flip it.
    touchOn: boolean,
    freeMove: Vector,       -- where the last button-up move was

    -- THE PAD, in one record (pad.luau). `pad.on` is only true once a
    -- controller has actually sent something: the cursor's ring must not sit
    -- on a table nobody is playing with a pad, and a mouse move puts it away.
    pad: PAD.State,
    padRing: Path,
    padPaint: Paint,

    -- The screen's data.
    movesProp: Property<string>?,
    scoreProp: Property<string>?,
    clockProp: Property<string>?,

    -- Water.
    goo: PUDDLE.Goo,
    bubbles: { Bubble },
    bubblePath: Path,
    bubblePaint: Paint,
    bubbleShine: Paint,
    energy: number,
    ripples: { Ripple },
    -- The music's own ring of eight. Separate from the play ripples above so
    -- the track, which rings a few times a second, can never push out the
    -- ring a card just made — and so the two can be weighted apart.
    musicRipples: { Ripple },
    music: MUSIC.Music,
    sound: AudioSound?,
    musicSource: AudioSource?,
    musicTried: boolean,
    muted: boolean,
    sfxIndex: number,       -- the card sound last auditioned (J/K/L), 0 before any
    sfxSound: AudioSound?,
    sfxRecent: { AudioSound },  -- one-shots in flight, so none is collected mid-sound
    sfx: { [string]: SfxEvent }, -- sfxEvents.csv, by event
    sfxBank: { string },    -- sfx.csv's ids in bank order, what J/K/L walks
    sfxMissing: { [string]: boolean }, -- events asked for with no row, each reported once
    fanWasUp: boolean,          -- the deck's fan was wanted last frame (the hover sound fires on the edge)
    hoverSound: AudioSound?,    -- the fan's voice, held so dropping the fan can choke it
    hoverVol: number,           -- the volume it started at, to ramp down FROM
    hoverFade: number,          -- seconds left of the choke ramp; 0 when not choking
    auraSound: AudioSound?,     -- the deck's looping bed, relaid when it completes
    auraTake: string,           -- the one take the whole hover uses; '' before the first
    auraLevel: number,          -- 0..1, the bed's own fade, on the table's clock
    fanX: number,               -- the ribbon's HEAD, held where the pointer left it
    fanY: number,               -- ...so the collapse is the ease and nothing else
    knockBest: number,      -- hardest tank knock offered this frame
    knockCard: number,      -- ...and which card made it, for its own `knock` event
    knockLen: number,       -- ...and how long the body was, for the pitch
    knockLast: number,      -- engine seconds one last sounded
    dealt: boolean,             -- a deal has happened: the next one is a re-deal
    muteWas: number,        -- the volume to come back to
    musicTime: number,      -- the playhead the analysis is read at
    beat: number,           -- 0..1, kicked by a band onset and decaying: what the black suits' glow pulses on
    soundLast: number,      -- the last reading off the sound itself
    soundStill: number,     -- seconds that reading has not changed
    vortexCentre: Vector,
    win: number,            -- seconds since the win, or -1

    -- Paints and paths built once.
    shadowPath: Path,
    shadowPaint: Paint,
    slotPath: Path,
    slotPaint: Paint,
    glowPath: Path,
    glowPaint: Paint,
    stockGlyph: Path,
    stockPaint: Paint,
    sampler: ImageSampler,

    -- GPU.
    gpu: boolean,
    scene: Canvas?,
    water: GPUCanvas?,
    screen: GPUCanvas?,
    sealUnderCanvas: GPUCanvas?,
    sealOverCanvas: GPUCanvas?,
    sealDepth: GPUTexture?,
    sealDepthView: GPUTextureView?,
    sealOverUbo: GPUBuffer?, sealOverBind: GPUBindGroup?,
    mouthDx: number, mouthDy: number,
    waterPipes: { GPUPipeline }, waterBinds: { GPUBindGroup }, waterUbo: GPUBuffer?, waterBytes: buffer,
    gooCanvas: GPUCanvas?, gooPipe: GPUPipeline?, gooUbo: GPUBuffer?, gooBind: GPUBindGroup?, gooBytes: buffer, gooSampler: GPUSampler?,
    surfaceCanvas: GPUCanvas?, surfacePipe: GPUPipeline?, surfaceUbo: GPUBuffer?, surfaceBind: GPUBindGroup?, surfaceBindB: GPUBindGroup?, surfaceBytes: buffer,
    foamA: GPUCanvas?, foamB: GPUCanvas?, foamPipe: GPUPipeline?, foamBytes: buffer,
    -- One uniform buffer (and a bind group per parity) per sub-step: the
    -- passes of a frame are submitted after every write, so a step that
    -- reused one buffer would read the last step's numbers.
    foamUbos: { GPUBuffer }, foamBindsA: { GPUBindGroup }, foamBindsB: { GPUBindGroup },
    foamParity: number,     -- 0: the next step writes foamA (reading B); 1: the reverse
    foamFresh: boolean,     -- canvases just built: clear both before the first carry
    foamTime: number,       -- the time the foam was last stepped to
    crtPipe: GPUPipeline?, crtUbo: GPUBuffer?, crtBind: GPUBindGroup?, crtBindInk: GPUBindGroup?, crtBytes: buffer, crtSampler: GPUSampler?, crtPoint: GPUSampler?,
    -- the fish tanks
    fishReady: boolean,
    fishPipe: GPUPipeline?, fishLinePipe: GPUPipeline?, fishUbo: GPUBuffer?, fishBind: GPUBindGroup?, fishBytes: buffer,
    fishBindLayout: any,
    fishVerts: GPUBuffer?, fishIndex: GPUBuffer?, fishIndexCount: number,
    species: { [string]: Species },  -- the pack, by tanks.csv `model`
    bubbleSpecies: Species?,         -- the sphere, looked up once
    speciesList: { Species },
    tankOf: { TankRec },           -- by card id: what its face holds (absent: a plain pip card)
    slotOf: { number },            -- by card id this frame, 0 when not a tank on screen
    slots: { number },             -- card id per slot this frame
    entryOf: { number },           -- by card id this frame: its row of the CRT's card table, 0 when off screen
    entries: number,               -- how many rows that table holds this frame
    fishInstCount: number,
    fishAtlas: GPUCanvas?, fishDepth: GPUTexture?, fishDepthView: GPUTextureView?,
    inkCanvas: Canvas?,
    maskCanvas: Canvas?,
    balls: { BAIT.Ball },          -- by card id
    tankSeen: { [number]: boolean }, -- by card id: its face was showing last frame, so a frame it shows and this is false is the reveal
    cardOf: { K.Card },            -- by id, this deal
    pressedCard: number,           -- the card pressed this frame, or 0
    played: { [number]: boolean }, -- the cards that landed in a valid spot this frame
    tankPaths: Path, entryPaint: { Paint },
    sealPipe: GPUPipeline?, sealUnderUbo: GPUBuffer?, sealUnderBind: GPUBindGroup?, sealBytes: buffer,
    sealVerts: GPUBuffer?, sealIndex: GPUBuffer?, sealIndexCount: number,
    boneParent: { number }, boneLocal: { Mat4 }, boneIbm: { Mat4 }, boneWorld: { Mat4 }, boneSkin: { Mat4 },
    boneScratch: Mat4,
    neckSlots: { number },
    gazeYaw: number, gazeVYaw: number, gazePitch: number, gazeVPitch: number,
    gazeTargetYaw: number, gazeTargetPitch: number,
    -- The flippers' aim, per side of the body: the card each one is on, the
    -- screen POINT it is sweeping toward, and the weight (0 with nothing to
    -- point at). What is sprung is the point, not an angle — see updateFins.
    finPick: { number },
    finWant: { number },     -- the body-relative bearing, held while a fin fades out
    swipeT: number,          -- seconds into the deal swipe, or -1
    -- The bite's take, eased: how much of the gap the body still has to close
    -- onto the corner (1 at the moment it takes, 0 once it is on), and the gap
    -- it started from. -1 is "not holding".
    biteEase: number, biteOffX: number, biteOffY: number,
    -- The seal's own bubbles (bubbles.luau). `shedBind` is 3 numbers per bone —
    -- the centroid of the skin that bone carries, at bind — and `shedSpread` is
    -- how far that skin reaches from it; `shedBones` lists the bones that have
    -- any. The last screen position of each is what gives it a speed.
    --
    -- `any`, and NOT `BUB.System`, on purpose. Naming another module's type here
    -- instantiates it into this one's inference, and this file has no room left:
    -- a single `bub: BUB.System` was the difference between a clean build and
    -- the whole project failing to typecheck, with the error pointing at the
    -- tanks.csv reader. CALLING bubbles.luau is free; only naming its types is
    -- not. The module itself is checked normally, which is where the pool's
    -- invariants actually live.
    bub: any,
    shedBones: { number },
    shedBind: { number }, shedSpread: { number },
    shedLastX: { number }, shedLastY: { number },
    shedWarm: boolean,
    bubSeq: number,
    finAimX: { number }, finAimY: { number },
    finAimVX: { number }, finAimVY: { number },
    finOn: { number }, finOnV: { number },
    playCards: { number },   -- card ids with a play on them, deduped; the fins' targets
    playsGame: K.Game?,      -- the game the list was read from, and at which move
    playsMoves: number,
    sealReady: boolean,
}

type TunerItem = { kind: string, i: number, x: number, y: number, h: number }


-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
local function spring(x: number, v: number, target: number, dt: number, k: number, d: number): (number, number)
    local a = k * (target - x) - d * v
    v += a * dt
    x += v * dt
    return x, v
end

local function clamp(v: number, lo: number, hi: number): number
    return math.max(lo, math.min(hi, v))
end

-- An angle folded into -pi..pi. A difference of two bearings is only a turn
-- once it has been through here.
local function wrapPi(a: number): number
    while a > math.pi do
        a -= math.pi * 2
    end
    while a < -math.pi do
        a += math.pi * 2
    end
    return a
end

local function roundedRect(path: Path, w: number, h: number, r: number)
    path:reset()
    local x0, y0, x1, y1 = -w / 2, -h / 2, w / 2, h / 2
    path:moveTo(Vector.xy(x0 + r, y0))
    path:lineTo(Vector.xy(x1 - r, y0))
    path:quadTo(Vector.xy(x1, y0), Vector.xy(x1, y0 + r))
    path:lineTo(Vector.xy(x1, y1 - r))
    path:quadTo(Vector.xy(x1, y1), Vector.xy(x1 - r, y1))
    path:lineTo(Vector.xy(x0 + r, y1))
    path:quadTo(Vector.xy(x0, y1), Vector.xy(x0, y1 - r))
    path:lineTo(Vector.xy(x0, y0 + r))
    path:quadTo(Vector.xy(x0, y0), Vector.xy(x0 + r, y0))
    path:close()
end

-- A card's draw matrix: centred at (x, y), rotated, scaled (x squashes through
-- a flip), leaned by the tilt. Rive's Mat2D maps x' = xx*x + yx*y + tx.
--
-- It maps the card ARTBOARD's own 120x168 onto the screen, so `fit` — the
-- card's width over that 120 — is folded into the scale here and nowhere
-- else. Every other transform that draws a card's face or its mask goes
-- through this matrix, which is what keeps the window, the rim and the ink
-- on the same rectangle at any size.
-- The pop's rise: a popped card sits this many px up the screen. Folded into
-- every transform that draws the card (the matrix, the shadow, the ring), and
-- NOT into v.y, so the hit test and the goo see the card where it rests and
-- the hover cannot chase itself.
-- THE HITBOX'S SOFT EDGE. A card's hitbox is a rect and the hover it decides
-- is a yes or a no, but what the pointer FEELS should not be: a card taken by
-- its very corner used to rise exactly as far as one taken dead centre, and
-- the change at the boundary was the whole of the difference between them.
--
-- So the yes/no stays — the wave that runs down a run is armed on an edge and
-- would restart every frame if its goal wandered (hover.luau) — and this scales
-- what the pop is WORTH once it has it. Centre is full, the edge is
-- `hoverFalloff` short of it, and it is eased, so crossing between two cards
-- hands the rise over instead of swapping it.
--
-- One number rather than a field per card: there is one hovered run at a time,
-- and everything not in it is at pop 0, where a multiplier cannot be seen.
local hoverFall = 1

-- THE DRAW'S FLIGHT. Which card is turning over on its way to the waste, how
-- far through it is, and where it left from. Table state living in module
-- locals, like `hoverFall` above and `shedSrc` below: there is exactly one
-- table, and every one of these is scratch that a second one would want its own
-- copy of anyway. The reason it is not on `Table` is that this module sits on
-- Luau's type-inference budget and that record is the thing that breaks it.
local flight = { id = 0, t = 0, x = 0, y = 0 }

local function popRise(g: LAYOUT.Geom, v: View): number
    return -T.popRise * g.fit * v.pop.pop * hoverFall
end

local function cardMatrix(g: LAYOUT.Geom, v: View, sx: number): Mat2D
    local c, s = math.cos(v.rot), math.sin(v.rot)
    local kx, ky = v.tiltX, v.tiltY
    -- M = R * S * K, applied to a column vector.
    local a11 = sx * v.scale * g.fit
    local a22 = v.scale * g.fit
    local l11 = c * a11
    local l12 = c * a11 * kx - s * a22
    local l21 = s * a11
    local l22 = s * a11 * kx + c * a22
    -- fold the y-skew in
    local m11 = l11 + l12 * ky
    local m12 = l12
    local m21 = l21 + l22 * ky
    local m22 = l22
    local cx, cy = CARD_W / 2, CARD_H / 2
    local y = v.y + popRise(g, v)
    return Mat2D.values(m11, m21, m12, m22, v.x - (m11 * cx + m12 * cy), y - (m21 * cx + m22 * cy))
end

-- The CRT pass shows the table barrel-curved: a scene point u lands on the
-- screen at s where u = s * (1 + k|s|^2), s centred in -1..1. The pointer
-- arrives in screen space, so it goes through that same map to reach the
-- table. Near the corners this is tens of pixels; the deal button lives there.
local function throughCurve(g: LAYOUT.Geom, p: Vector): Vector
    local sx = p.x / g.w * 2 - 1
    local sy = p.y / g.h * 2 - 1
    local m = 1 + T.curve * (sx * sx + sy * sy)
    return Vector.xy((sx * m + 1) * 0.5 * g.w, (sy * m + 1) * 0.5 * g.h)
end

local function fmtClock(seconds: number): string
    local s = math.floor(math.max(0, seconds))
    return string.format('%d:%02d', s // 60, s % 60)
end

-- ---------------------------------------------------------------------------
-- Card views: where every card wants to be, from the piles.
-- ---------------------------------------------------------------------------
local function pileOrigin(g: LAYOUT.Geom, p: K.Pile): (number, number)
    if p.kind == 'stock' then
        return LAYOUT.colX(g, 1), g.topY
    elseif p.kind == 'waste' then
        return LAYOUT.colX(g, 2), g.topY
    elseif p.kind == 'foundation' then
        return LAYOUT.colX(g, 3 + p.index), g.topY
    end
    return LAYOUT.colX(g, p.index), g.tabY
end

-- Target of card k in a pile, plus its z.
--
-- A tableau column's fan is the LAYOUT's until the column is long enough to
-- run off the bottom of the screen, and then both steps shrink together
-- (LAYOUT.fanFor). That is a phone's problem first — nineteen cards down a
-- 844px screen — but it was always this table's: a full run built on column
-- seven used to walk straight past y=1000 on the desktop too.
local function slotFor(g: LAYOUT.Geom, p: K.Pile, k: number): (number, number, number)
    local ox, oy = pileOrigin(g, p)
    if p.kind == 'tableau' then
        local down, up = 0, 0
        for _, c in ipairs(p.cards) do
            if c.faceUp then up += 1 else down += 1 end
        end
        local fanUp, fanDown = LAYOUT.fanFor(g, down, up)
        local y = oy
        for i = 1, k - 1 do
            y += if p.cards[i].faceUp then fanUp else fanDown
        end
        return ox, y, 1000 + p.index * 100 + k
    elseif p.kind == 'waste' then
        -- The top three spread a little, so a draw is seen to land.
        local n = #p.cards
        local fromTop = n - k
        local spread = (if fromTop < 3 then (2 - fromTop) * -6 else -12) * g.fit
        return ox + spread, oy - fromTop * 0.15, 200 + k
    elseif p.kind == 'foundation' then
        return ox, oy - k * 0.2, 400 + p.index * 20 + k
    end
    return ox + k * 0.25, oy - k * 0.3, 100 + k
end

local function relayout(self: Table)
    for _, p in ipairs(K.piles(self.game)) do
        for k, card in ipairs(p.cards) do
            local v = self.views[card.id]
            local x, y, z = slotFor(self.L, p, k)
            v.tx, v.ty, v.z = x, y, z
            v.trot = 0
            v.tscale = 1
            v.tflip = if card.faceUp then 1 else 0
        end
    end
    -- The drag keeps its own targets.
    local drag = self.drag
    if drag ~= nil then
        for i, card in ipairs(drag.cards) do
            local v = self.views[card.id]
            v.z = 5000 + i
        end
    end
    self.orderDirty = true
end

local function sortOrder(self: Table)
    table.sort(self.order, function(a: number, b: number): boolean
        return self.views[a].z < self.views[b].z
    end)
    self.orderDirty = false
end

-- ---------------------------------------------------------------------------
-- The water reacts.
-- ---------------------------------------------------------------------------
local function ripple(self: Table, x: number, y: number, strength: number)
    local r: Ripple = { x = x / self.L.w, y = y / self.L.h, age = 0, strength = strength }
    table.insert(self.ripples, 1, r)
    while #self.ripples > 8 do
        table.remove(self.ripples)
    end
    self.energy = math.min(1.5, self.energy + strength * 0.5)
end

-- A ripple the MUSIC pushed in. Its own ring, and it does NOT touch
-- `self.energy`: a play's ring spikes the energy and the spike decays, which
-- only works because plays are occasional. The music rings several times a
-- second, so feeding it the same way would hold the energy at its ceiling for
-- the whole track and the water would stop answering the cards at all. The
-- music's contribution to energy is a bed instead — the smoothed level, added
-- at the uniform, bounded by construction (see drawWater).
-- How fast the beat falls away, per second, e-folds. Fast enough that two
-- fires 0.22s apart (the table's gap) read as two hits rather than one held
-- swell; slow enough that a single kick is still visible a few frames later.
local BEAT_DECAY = 4.5

local function musicRipple(self: Table, x: number, y: number, strength: number)
    local r: Ripple = { x = x, y = y, age = 0, strength = strength }
    table.insert(self.musicRipples, 1, r)
    while #self.musicRipples > 8 do
        table.remove(self.musicRipples)
    end
end

-- The energy the water is given: the table's own (a play spikes it, it
-- decays) plus the music's bed — the track's mean band level, smoothed. A
-- BED, not spikes: bounded by construction at `musicSwell`, so however loud
-- the track gets it can never swamp the headroom a play needs to be felt.
-- The goo is deliberately not given it: the goo's energy is about the cards.
local function waterEnergy(self: Table): number
    return self.energy + self.music.energy * T.musicSwell
end

-- Both rings into a uniform, sixteen rows at `at`: the eight plays, then the
-- eight the music made. An empty slot is strength 0, which every shader skips.
local function writeRipples(self: Table, b: buffer, at: number)
    for k = 1, 16 do
        local r = if k <= 8 then self.ripples[k] else self.musicRipples[k - 8]
        local o = at + (k - 1) * 16
        if r ~= nil then
            buffer.writef32(b, o, r.x)
            buffer.writef32(b, o + 4, r.y)
            buffer.writef32(b, o + 8, r.age)
            buffer.writef32(b, o + 12, r.strength)
        else
            buffer.writef32(b, o, 0)
            buffer.writef32(b, o + 4, 0)
            buffer.writef32(b, o + 8, 0)
            buffer.writef32(b, o + 12, 0)
        end
    end
end

-- ---------------------------------------------------------------------------
-- Dealing
-- ---------------------------------------------------------------------------
-- The two suit inks, and they are RED and BLACK — the thing a player reads a
-- card by. Neither is legible on a dark tank by itself, so neither is asked
-- to be: crt.wgsl lights both from behind (a red glow under the red, a white
-- one under the black, pulsing on the beat). Before that the black suits
-- printed PALE, which made a deck of two near-identical light inks.
local RED = Color.rgb(240, 62, 48)
local BLACK = Color.rgb(8, 10, 14)

-- A seed nobody chose: wall-clock seconds, salted with the sub-second CPU
-- clock so two launches in the same second still differ. The deal itself
-- stays K's LCG, so the seed printed to the log reproduces it.
local function freshSeed(): number
    local ok, t = pcall(function(): number
        return os.time()
    end)
    local secs = if ok and typeof(t) == 'number' then t else 0
    local frac = math.floor((os.clock() % 1) * 1000)
    return (secs * 1000 + frac) % 2147483647
end

-- The light behind a rank is markup (cards.rml, the Corner's feathered text
-- layers): the script only says WHICH suit's glow shows — a fact about the
-- card, fixed at the deal — and keeps handles on the layer opacities so
-- `inkGlow` and `inkPulse` can drive them live.
--
-- The handles are the reason the card's own suit is decided here and the
-- STRENGTH is not: a value written once at the deal cannot answer a slider,
-- and the whole point of the tuner is that it answers while you watch.
local function bindGlow(v: View, d: any, card: K.Card)
    local isRed = K.isRed(card.suit)
    local red = d:getNumber('red')
    if red ~= nil then
        red.value = 0
        if isRed then
            table.insert(v.glows, red)
        end
    end
    local black = d:getNumber('black')
    if black ~= nil then
        black.value = 0
        if not isRed then
            table.insert(v.glows, black)
        end
    end
    local pulse = d:getNumber('pulse')
    if pulse ~= nil then
        pulse.value = 0
        if not isRed then
            -- red glows steadily; only a black suit pulses
            table.insert(v.pulses, pulse)
        end
    end
end

-- ---------------------------------------------------------------------------
-- The card sounds
-- ---------------------------------------------------------------------------
-- Every event that makes a noise is a row of sfxEvents.csv: its takes (bank
-- ids from sfx/, `|` between; one is picked at random so a run of plays does
-- not stutter the same sample), a gain on top of the sfxVolume slider, a
-- delay, and the least gap between two plays of it. Ethan casts there; the
-- code only names the event. The pack itself (sfx/): 72 physical takes, then
-- 12 "digi" ones, plus processed variants from sfxFx.csv. Auditioned with
-- `npm run sealitaire:audition`, or J/K/L in the game.
type SfxEvent = { takes: { string }, gain: number, delay: number, minGap: number, lastAt: number }

-- Play one take of an event at the sfx volume (muted with the music).
-- `level` scales it, 0..1, for an event whose loudness is a measurement
-- rather than a constant — the tank knocks; nil means full. A handful of
-- handles is kept so a one-shot is not collected mid-sound.
-- Returns the voice it started, or nil — `hover` holds onto its one so it can
-- be choked when the fan drops. Every other caller ignores it.
local function playSfx(self: Table, event: string, level: number?): AudioSound?
    local ctx = self.context
    local ev = self.sfx[event]
    if ctx == nil or ev == nil or #ev.takes == 0 then
        if ev == nil and not self.sfxMissing[event] then
            self.sfxMissing[event] = true
            print(`sealitaire: sfxEvents.csv has no row "{event}"`)
        end
        return nil
    end
    local now = Audio.time()
    if ev.minGap > 0 and now - ev.lastAt < ev.minGap then
        return nil
    end
    ev.lastAt = now
    local src = ctx:audio(ev.takes[math.random(1, #ev.takes)])
    if src == nil then
        return nil
    end
    local ok, snd = pcall(function(): AudioSound?
        return if ev.delay > 0 then Audio.playAtTime(src, now + ev.delay) else Audio.play(src)
    end)
    if ok and snd ~= nil then
        snd.volume = if self.muted then 0 else T.sfxVolume * ev.gain * (level or 1)
        table.insert(self.sfxRecent, snd)
        if #self.sfxRecent > 12 then
            table.remove(self.sfxRecent, 1)
        end
        return snd
    end
    return nil
end

-- LET THE FAN'S VOICE DOWN. Called on the fan dropping and on a click into
-- the deck: both end the rise, and a half-second take left ringing over a
-- settled deck is the thing that reads as wrong.
--
-- A ramp, not a stop: `stop()` lands the cut on a non-zero sample and clicks,
-- the same reason the bake fades every take by 2ms. Idempotent — a second
-- call while one is running leaves the ramp where it is rather than
-- restarting it, so a click during the fan's own fall does not lengthen it.
local function chokeHover(self: Table)
    if self.hoverSound ~= nil and self.hoverFade <= 0 then
        self.hoverFade = HOVER_CHOKE
    end
end

-- THE DECK'S AURA. A second, quiet voice under `hover`, alive for exactly as
-- long as the pointer is on the deck. The two are not the same sound doing
-- two jobs: `hover` is an EDGE — one blip as the ribbon goes up, over before
-- it is — and this is the STATE, which is why it is its own row of
-- sfxEvents.csv rather than a longer take in that one.
--
-- A LOOP HERE IS A RELAY. Rive's AudioSound has no loop flag, so looping is
-- what music.luau does with the track: watch the voice, and start another on
-- the frame it reports itself completed. That leaves up to one frame of
-- silence at the seam, which a sustained take of a second or more carries and
-- a short one turns into a pulse — the CSV row says so.
--
-- ONE TAKE FOR THE WHOLE HOVER. playSfx rolls a take per call, which is right
-- for a blip and wrong here: re-rolling at the seam changes timbre mid-hold,
-- which is a swap rather than a loop. The take is picked once, as the bed
-- comes up off silence.
--
-- The fade is a volume ramp on the table's clock, not a stop: `stop()` lands
-- the cut on a non-zero sample and clicks (the same reason chokeHover ramps),
-- so the voice is only ever stopped once the ramp has already taken it to
-- zero.
local function updateAura(self: Table, wanted: boolean, dt: number)
    local ctx = self.context
    local ev = self.sfx['hoverAura']
    -- A row with no takes is a stub, and a stub is silence, not a warning:
    -- this slot is cast in sfxEvents.csv and nowhere else.
    if ctx == nil or ev == nil or #ev.takes == 0 then
        return
    end
    local fade = math.max(T.stockAura, 0.02)
    local was = self.auraLevel
    self.auraLevel = clamp(was + (if wanted then dt else -dt) / fade, 0, 1)
    if was <= 0 and self.auraLevel > 0 then
        self.auraTake = ev.takes[math.random(1, #ev.takes)]
    end
    if self.auraLevel <= 0 then
        local old = self.auraSound
        if old ~= nil then
            -- Silent already: the ramp above got there first.
            old:stop()
            self.auraSound = nil
        end
        return
    end
    local snd = self.auraSound
    if snd ~= nil and snd:completed() then
        snd = nil
    end
    if snd == nil then
        local src = ctx:audio(self.auraTake)
        if src == nil then
            return
        end
        local ok, started = pcall(function(): AudioSound?
            return Audio.play(src)
        end)
        snd = if ok then started else nil
        self.auraSound = snd
    end
    if snd ~= nil then
        snd.volume = if self.muted then 0 else T.sfxVolume * ev.gain * self.auraLevel
    end
end

-- A KNOCK on the glass: the default event's take, pitched for the body's
-- size, plus its bus. The bank has every tankWall take at five pitch steps
-- and a reverb copy per step at four low-pass cutoffs (tools/sealitaire-
-- sfx-fx.mjs `knock`); knock.luau picks the rungs. Three voices at most: the
-- dry take and the two bus rungs the sweep sits between, the bus at
-- `busSend`. A card whose row names its own `knock` event, or a bank baked
-- without the ladder, plays through playSfx as before.
-- A BLIP FOR A HOVERED CARD, pitched by how deep its stack is.
--
-- The rung comes from KNOCK.step, which is already "inversely proportional,
-- clamped to the ladder" — it was written for a body's length against a
-- reference sardine and the shape is identical here: a depth against a
-- reference depth. Reusing it keeps one definition of the curve.
--
-- Depth is the PILE's card count, not the run under the pointer: what the
-- ear is being told is how big the thing you are touching is, and a column
-- of thirteen with two face-up is still a big pile.
--
-- Falls back to the unpitched take if the rung is missing, so a bank baked
-- before `sfx:fx hover` ran still makes a noise rather than going silent.
local function playCardHover(self: Table, depth: number)
    local ctx = self.context
    local ev = self.sfx['cardHover']
    if ctx == nil or ev == nil or #ev.takes == 0 then
        return
    end
    local now = Audio.time()
    if ev.minGap > 0 and now - ev.lastAt < ev.minGap then
        return
    end
    local take = ev.takes[math.random(1, #ev.takes)]
    local k = KNOCK.step(math.max(1, depth), T.hoverRefDepth, T.hoverPitch)
    local src = ctx:audio(`{take}-h{k}`) or ctx:audio(take)
    if src == nil then
        return
    end
    ev.lastAt = now
    local ok, snd = pcall(function(): AudioSound?
        return Audio.play(src)
    end)
    if ok and snd ~= nil then
        snd.volume = if self.muted then 0 else T.sfxVolume * ev.gain
        table.insert(self.sfxRecent, snd)
        if #self.sfxRecent > 12 then
            table.remove(self.sfxRecent, 1)
        end
    end
end

local function playKnock(self: Table, level: number, len: number)
    local ctx = self.context
    local ev = self.sfx['tankWall']
    if ctx == nil or ev == nil or #ev.takes == 0 then
        playSfx(self, 'tankWall', level)
        return
    end
    local take = ev.takes[math.random(1, #ev.takes)]
    local k = KNOCK.step(len, T.fishSize, T.knockPitch)
    local dry = ctx:audio(`{take}-p{k}`)
    if dry == nil then
        playSfx(self, 'tankWall', level)
        return
    end
    local now = Audio.time()
    if ev.minGap > 0 and now - ev.lastAt < ev.minGap then
        return
    end
    ev.lastAt = now
    local gain = if self.muted then 0 else T.sfxVolume * ev.gain * level
    local function voice(src: AudioSource?, vol: number)
        if src == nil or vol <= 0.001 then
            return
        end
        local ok, snd = pcall(function(): AudioSound?
            return Audio.play(src)
        end)
        if ok and snd ~= nil then
            snd.volume = vol
            table.insert(self.sfxRecent, snd)
            if #self.sfxRecent > 12 then
                table.remove(self.sfxRecent, 1)
            end
        end
    end
    voice(dry, gain)
    if T.busSend > 0 then
        local lo, hi, wlo, whi = KNOCK.sweep(T.busSweep)
        voice(ctx:audio(`knockbus-p{k}-c{lo}`), gain * T.busSend * wlo)
        if hi ~= lo then
            voice(ctx:audio(`knockbus-p{k}-c{hi}`), gain * T.busSend * whi)
        end
    end
end

local function deal(self: Table, seed: number)
    self.game = K.new(seed)
    self.dealSeed = seed
    print(`sealitaire: deal seed {seed}`)
    playSfx(self, if self.dealt then 'redeal' else 'shuffle')
    self.dealt = true
    self.dealTime = self.time
    self.drag = nil
    self.hovered = 0
    self.win = -1
    self.energy = 0.6
    MUSIC.noteDeal(self.music, K.founded(self.game), self.game.score, self.game.moves)
    -- Every card starts in the stock's corner and flies to its slot: the deal
    -- IS the entrance.
    local sx, sy = pileOrigin(self.L, self.game.stock)
    for _, p in ipairs(K.piles(self.game)) do
        for _, card in ipairs(p.cards) do
            self.cardOf[card.id] = card
            local v = self.views[card.id]
            v.x, v.y = sx, sy - 40
            v.vx, v.vy = 0, 0
            v.rot, v.vrot = 0, 0
            v.scale, v.vscale = 0.9, 0
            v.flip = 0
            v.lift = 0
            v.tiltX, v.tiltY = 0, 0
            local inst = v.inst
            if inst ~= nil then
                local d = inst.data
                local rank = d:getString('rank')
                if rank ~= nil then
                    rank.value = K.RANK_TEXT[card.rank]
                end
                local ink = d:getColor('ink')
                if ink ~= nil then
                    ink.value = if K.isRed(card.suit) then RED else BLACK
                end
                local names = { 'fish', 'star', 'bubble', 'shell' }
                for s, name in ipairs(names) do
                    local prop = d:getNumber(name)
                    if prop ~= nil then
                        prop.value = if s == card.suit then 1 else 0
                    end
                end
                -- A fresh instance's numbers start at 0, not at the RML
                -- instance's values: the plate has to be shown explicitly
                -- (the ink-only instance in inkFor hides it).
                local plate = d:getNumber('plate')
                if plate ~= nil then
                    plate.value = 1
                end
                table.clear(v.pulses)
                table.clear(v.glows)
                bindGlow(v, d, card)
            end
        end
    end
    relayout(self)
    ripple(self, LAYOUT.colX(self.L, 4), self.L.tabY, 1.0)
end

-- ---------------------------------------------------------------------------
-- Hit testing
-- ---------------------------------------------------------------------------
local function inRect(px: number, py: number, x: number, y: number, w: number, h: number): boolean
    return px >= x and px <= x + w and py >= y and py <= y + h
end

local function cardHit(g: LAYOUT.Geom, v: View, px: number, py: number, margin: number?): boolean
    -- Against the resting slot, not the sprung position, so a card mid-flight
    -- still answers where it lives. A positive margin grows the rect (keep a
    -- hover), a negative one shrinks it (take a hover only when clearly in).
    local m = margin or 0
    return math.abs(px - v.tx) <= g.cw / 2 + m and math.abs(py - v.ty) <= g.ch / 2 + m
end

-- The pile and index under the pointer, top-most card first.
local function hitCard(self: Table, px: number, py: number, margin: number?): (K.Pile?, number)
    local best: K.Pile? = nil
    local bestIndex = 0
    local bestZ = -1
    for _, p in ipairs(K.piles(self.game)) do
        for k = #p.cards, 1, -1 do
            local v = self.views[p.cards[k].id]
            if cardHit(self.L, v, px, py, margin) and v.z > bestZ then
                best, bestIndex, bestZ = p, k, v.z
                break
            end
        end
    end
    return best, bestIndex
end

local function pileUnder(self: Table, px: number, py: number): K.Pile?
    -- Foundations by their slot rectangle, tableau by column.
    local g = self.L
    for _, f in ipairs(self.game.foundations) do
        local ox, oy = pileOrigin(g, f)
        if math.abs(px - ox) <= g.cw / 2 + 8 * g.fit and math.abs(py - oy) <= g.ch / 2 + 8 * g.fit then
            return f
        end
    end
    if py > g.tabY - g.ch / 2 - 20 * g.fit then
        for col = 1, COLS do
            if math.abs(px - LAYOUT.colX(g, col)) <= (g.cw + g.gap) / 2 then
                return self.game.tableau[col]
            end
        end
    end
    return nil
end

-- ---------------------------------------------------------------------------
-- Moves, with their juice.
-- ---------------------------------------------------------------------------
local function landed(self: Table, cards: { K.Card }, strength: number)
    for _, card in ipairs(cards) do
        local v = self.views[card.id]
        v.vscale = 3.0        -- a pop
        v.vrot = (if v.x > self.L.w / 2 then -1 else 1) * 2.5
    end
    local top = self.views[cards[1].id]
    ripple(self, top.tx, top.ty, strength)
    -- The whitewater: the slap fires from each card's edge as it settles.
    local ids: { number } = {}
    for _, card in ipairs(cards) do
        table.insert(ids, card.id)
    end
    PUDDLE.play(self.goo, ids, 0.55 + 0.45 * strength)
end

-- `sent` names the sound a FOUNDATION landing makes, for the one caller that
-- got there a different way: a double-click sends a card up without ever
-- picking it up, and it should not sound like the end of a drag. nil means
-- the ordinary `foundation`. A tableau landing is `play` either way — there
-- is no double-click route onto the tableau to tell apart.
local function tryMove(self: Table, from: K.Pile, index: number, to: K.Pile, sent: string?): boolean
    local run = K.runFrom(from, index)
    if run == nil then
        return false
    end
    local r = K.move(self.game, from, index, to)
    if not r.ok then
        return false
    end
    relayout(self)
    landed(self, run, if r.toFoundation then 1.0 else 0.5)
    playSfx(self, if r.toFoundation then (sent or 'foundation') else 'play')
    -- The seal answers a play: a different reaction each time, on the stage.
    if math.random() < T.reactChance then
        self.reactSeq += 1
        self.reactVariant = REACT.pick(self.reactLast, math.random())
        self.reactLast = self.reactVariant
        -- THE ANIMAL'S OWN VOICE, one event per variant. The code names it —
        -- `spin` becomes `reactSpin` — and sfxEvents.csv casts it, so a
        -- somersault can breach and a bark can bark without this file
        -- knowing which sound either is. A variant with no row is reported
        -- once by playSfx and is silent, which is the right default for a
        -- move that has not been cast yet.
        --
        -- It lands ON TOP of the `play` that fired a few lines up: the play
        -- is the card, this is the seal answering it. Hence the low gains on
        -- the react rows — two sounds, one moment.
        local v = self.reactVariant
        playSfx(self, `react{v:sub(1, 1):upper()}{v:sub(2)}`)
    end
    -- The tanks in a played run swirl for a beat.
    for _, c in ipairs(run) do
        self.played[c.id] = true
    end
    if r.flipped then
        local flipped = K.top(from)
        if flipped ~= nil then
            self.views[flipped.id].vscale = 2.0
        end
        -- The uncovered card turns a beat after the run lands (the row's delay).
        playSfx(self, 'flip')
    end
    if self.game.won and self.win < 0 then
        self.win = 0
        self.energy = 1.5
        -- The music's own win. Queued here, on the EDGE, rather than read off
        -- `game.won` every frame: `won` stays true for as long as the win
        -- screen is up, and a frame-by-frame read would re-queue the loop on
        -- every one of them and never let it play.
        MUSIC.noteWin(self.music, K.founded(self.game), self.game.score, self.game.moves)
    end
    return true
end

local function drawStock(self: Table)
    local result = K.draw(self.game)
    relayout(self)
    -- The flipper's flick across the deck. A recycle gets one too: it is still
    -- the deck handing the player cards.
    self.swipeT = 0
    if result == 'drew' then
        playSfx(self, 'flip')
        local top = K.top(self.game.waste)
        if top ~= nil then
            local v = self.views[top.id]
            -- FROM WHERE IT IS, not from the deck's slot: with the fan up the
            -- card is somewhere out in the ribbon, and that is where the player
            -- just clicked it.
            flight.id = top.id
            flight.t = 0
            flight.x, flight.y = v.x, v.y
            v.flip = 0
            v.vrot = -3
            ripple(self, v.tx, v.ty, 0.35)
        end
    elseif result == 'recycled' then
        playSfx(self, 'recycle')
        local rx, ry = pileOrigin(self.L, self.game.stock)
        ripple(self, rx, ry, 0.7)
        for _, card in ipairs(self.game.stock.cards) do
            self.views[card.id].vrot = 2
        end
    end
end

-- ---------------------------------------------------------------------------
-- The tuner panel. One TunerRow artboard per line of tuning.luau and one
-- TunerHead per category, instanced here and laid out every frame in columns;
-- a header folds its category. This owns the drags and keeps each row's knob
-- and readout in step through its own view model.
-- ---------------------------------------------------------------------------
local function fmtValue(v: number): string
    local a = math.abs(v)
    if a >= 100 then
        return string.format('%.0f', v)
    elseif a >= 10 then
        return string.format('%.1f', v)
    elseif a >= 1 then
        return string.format('%.2f', v)
    end
    return string.format('%.3f', v)
end

local function writeTunerRow(self: Table, i: number)
    local vm = self.tunerRowVm[i]
    if vm == nil then
        return
    end
    local row = TUNING[i]
    local t = (T[row.key] - row.min) / (row.max - row.min)
    local knob = vm:getNumber('k')
    if knob ~= nil then
        -- In ROW units: the row artboard is drawn scaled, so the knob's x
        -- inside it never changes with the panel's size.
        local tn = self.L.tuner
        knob.value = tn.x0 + clamp(t, 0, 1) * (tn.x1 - tn.x0)
    end
    local val = vm:getString('v')
    if val ~= nil then
        val.value = fmtValue(T[row.key])
    end
    local label = vm:getString('l')
    if label ~= nil then
        label.value = row.key
    end
end

local function writeTunerHead(self: Table, c: number)
    local vm = self.tunerHeadVm[c]
    if vm == nil then
        return
    end
    local name = vm:getString('title')
    local mark = vm:getString('mark')
    local n = #self.tunerCats
    if c <= n then
        if name ~= nil then
            name.value = self.tunerCats[c]
        end
        if mark ~= nil then
            mark.value = if self.tunerCatOpen[c] then '-' else '+'
        end
    else
        if name ~= nil then
            name.value = if c == n + 1 then 'SAVE' else 'RESET'
        end
        if mark ~= nil then
            mark.value = ''
        end
    end
end

-- The card rows (SUBJECT_ROWS): the same row artboard, reading and writing
-- the subject's TankRec instead of T.
local function cardName(id: number): string
    local suit = (id - 1) // 13 + 1
    local rank = (id - 1) % 13 + 1
    return `{K.RANK_TEXT[rank]} {SUIT_NAMES[suit]}`
end

local function colourOf(rec: TankRec, name: string): { number }
    if name == 'back' then
        return rec.back
    elseif name == 'belly' then
        return rec.belly
    elseif name == 'bioColor' then
        return rec.bioColor
    end
    return rec.bg
end

local function subjectGet(self: Table, key: string): number
    local rec = self.tankOf[self.subject]
    if rec == nil then
        return 0
    end
    if key == 'model' then
        for i, sp in ipairs(self.pool) do
            if sp == rec.species then
                return i
            end
        end
        return 1
    elseif key == 'count' then
        return rec.count
    elseif key == 'size' then
        return rec.size
    elseif key == 'bio' then
        return rec.bio
    elseif key == 'loop' then
        return if rec.loop ~= nil then rec.loop else (if rec.rank >= 11 then 0 else 1)
    end
    local c = COLOUR_ROWS[key]
    if c ~= nil then
        return colourOf(rec, c.name)[c.ch]
    end
    local g = LAYOUT_ROWS[key]
    if g ~= nil then
        local own = (rec :: any)[key] :: number?
        return if own ~= nil then own else T[g]
    end
    return 0
end

-- Every species' instance buffer holds the sum of the counts that name it,
-- sized when the table loads (loadTankTable). A pick from the panel moves a
-- card between species, so the one it moved TO may need more room: regrow
-- here, never shrink, and let the old buffer go.
local function recapSpecies(self: Table)
    local need: { [Species]: number } = {}
    for id = 1, 52 do
        local rec = self.tankOf[id]
        if rec ~= nil then
            need[rec.species] = (need[rec.species] or 0) + rec.count
        end
    end
    for _, sp in ipairs(self.speciesList) do
        local n = need[sp] or 0
        if sp.name ~= BUBBLE_SPECIES and n > sp.cap then
            sp.cap = n
            sp.bytes = buffer.create(sp.cap * BAIT.STRIDE)
            sp.inst = GPUBuffer.new({ size = sp.cap * BAIT.STRIDE, usage = 'vertex', label = `tank {sp.name}` })
            -- A bigger instance buffer needs as many bend rows, and the bind
            -- group has to be rebuilt around the new texture.
            sp.bend = nil
            RIG.ensureBend(self, sp)
        end
    end
end

local function subjectSet(self: Table, key: string, v: number)
    local id = self.subject
    local rec = self.tankOf[id]
    if rec == nil then
        return
    end
    if key == 'model' then
        local sp = self.pool[clamp(math.floor(v + 0.5), 1, math.max(1, #self.pool))]
        if sp ~= nil and sp ~= rec.species then
            rec.species = sp
            recapSpecies(self)
        end
    elseif key == 'count' then
        rec.count = clamp(math.floor(v + 0.5), 1, 16)
        recapSpecies(self)
    elseif key == 'size' then
        rec.size = v
    elseif key == 'bio' then
        rec.bio = math.max(0, v)
    elseif key == 'loop' then
        rec.loop = if v >= 0.5 then 1 else 0
    elseif LAYOUT_ROWS[key] ~= nil then
        (rec :: any)[key] = v
    else
        local c = COLOUR_ROWS[key]
        if c ~= nil then
            colourOf(rec, c.name)[c.ch] = clamp(v, 0, 1)
        end
    end
    self.tankDirty[id] = true
end

local function writeSubjectRow(self: Table, i: number)
    local vm = self.subjectRowVm[i]
    local row = SUBJECT_ROWS[i]
    if vm == nil or row == nil then
        return
    end
    local v = subjectGet(self, row.key)
    local t = if row.max > row.min then (v - row.min) / (row.max - row.min) else 0
    local knob = vm:getNumber('k')
    if knob ~= nil then
        local tn = self.L.tuner
        knob.value = tn.x0 + clamp(t, 0, 1) * (tn.x1 - tn.x0)
    end
    local val = vm:getString('v')
    if val ~= nil then
        if row.key == 'model' then
            local sp = self.pool[math.floor(v + 0.5)]
            val.value = if sp ~= nil then sp.name else '?'
        elseif row.step > 0 then
            val.value = string.format('%d', math.floor(v + 0.5))
        elseif LAYOUT_ROWS[row.key] ~= nil and self.tankOf[self.subject] ~= nil and (self.tankOf[self.subject] :: any)[row.key] == nil then
            -- Inherited from the tuner's global: shown with a tilde so a
            -- card that is on its own number can be told from one that is not.
            val.value = '~' .. fmtValue(v)
        else
            val.value = fmtValue(v)
        end
    end
    local label = vm:getString('l')
    if label ~= nil then
        label.value = row.key
    end
end

local function writeSubjectHeads(self: Table)
    local vm = self.subjectHeadVm
    if vm ~= nil then
        local name = vm:getString('title')
        local mark = vm:getString('mark')
        if name ~= nil then
            -- Tooling text, not a player's: the panel is the tuner's.
            name.value = if self.subject > 0 and self.tankOf[self.subject] ~= nil then `card {cardName(self.subject)}` else 'card: click one'
        end
        if mark ~= nil then
            mark.value = if self.subjectOpen then '-' else '+'
        end
    end
    local svm = self.suitHeadVm
    if svm ~= nil then
        local name = svm:getString('title')
        local mark = svm:getString('mark')
        if name ~= nil then
            name.value = 'SUIT'
        end
        if mark ~= nil then
            mark.value = ''
        end
    end
end

local function writeSubject(self: Table)
    writeSubjectHeads(self)
    for i = 1, #SUBJECT_ROWS do
        writeSubjectRow(self, i)
    end
end

local function writeTuner(self: Table)
    for i = 1, #TUNING do
        writeTunerRow(self, i)
    end
    for c = 1, #self.tunerCats + 2 do
        writeTunerHead(self, c)
    end
    writeSubject(self)
end

-- The layout: headers and open rows, top to bottom, spilling into the next
-- column when a column is full. SAVE and RESET sit at the foot of column 1.
local function tunerLayout(self: Table)
    local tn = self.L.tuner
    local items = self.tunerItems
    table.clear(items)
    local col = 0
    local y = tn.top
    local limit = tn.maxH - tn.foot
    local deepest = 0
    -- Every column is lifted by the same scroll: the panel is one surface and
    -- scrolling its columns apart would be two panels.
    local lift = self.tunerScroll
    local function place(kind: string, i: number, h: number)
        if y + h > limit + lift and col < tn.cols - 1 then
            col += 1
            y = tn.top
        end
        deepest = math.max(deepest, y + h)
        table.insert(items, { kind = kind, i = i, x = tn.x + tn.gutter + col * tn.colW, y = tn.y + y - lift, h = h })
        y += h
    end
    -- The card rows first: they are what the panel is opened FOR when a
    -- card is being designed, and a subject with no rows showing is a click
    -- that did nothing.
    place('shead', 1, tn.headH)
    if self.subjectOpen and self.subject > 0 and self.tankOf[self.subject] ~= nil then
        for i = 1, #SUBJECT_ROWS do
            place('srow', i, tn.rowH)
        end
    end
    for c, _ in ipairs(self.tunerCats) do
        place('head', c, tn.headH)
        if self.tunerCatOpen[c] then
            for _, i in ipairs(self.tunerCatRows[c]) do
                place('row', i, tn.rowH)
            end
        end
    end
    -- How far the columns can still be lifted: exactly enough to bring the
    -- last row up to the foot. A drag in the gutter moves it, and the band
    -- below clips both the drawing and the hit test, so a row that is off the
    -- panel is off it entirely rather than floating over the table.
    self.tunerReach = math.max(0, deepest - limit)
    -- A panel with no room for even one row is a panel that takes the pointer
    -- and shows nothing, which reads as a tuner that does not work rather
    -- than one that does not fit. `spilled` alone no longer means anything —
    -- the scroll reaches every row by construction — so this is the failure
    -- that is left, and it says so once.
    if limit - tn.top < tn.rowH and not self.tunerSpillTold then
        self.tunerSpillTold = true
        print(`sealitaire: the tuner panel is {tn.maxH}px tall — too short to show a single row`)
    end
    local n = #self.tunerCats
    local footY = tn.y + tn.maxH - tn.foot + 6 * tn.scale
    local footX = tn.x + tn.gutter
    table.insert(items, { kind = 'save', i = n + 1, x = footX, y = footY, h = tn.headH })
    table.insert(items, { kind = 'reset', i = n + 2, x = footX + 110 * tn.scale, y = footY, h = tn.headH })
    -- SUIT: the subject's look onto every number card of its suit.
    table.insert(items, { kind = 'suit', i = n + 3, x = footX + 220 * tn.scale, y = footY, h = tn.headH })
end

-- The band a scrolling row is visible in: from the panel's top to the foot
-- the SAVE and RESET buttons sit in. Rows are clipped to it; the buttons are
-- not, because they are the foot.
local function tunerBand(self: Table): (number, number)
    local tn = self.L.tuner
    return tn.y + tn.top, tn.y + tn.maxH - tn.foot
end

local function tunerShows(self: Table, it: TunerItem): boolean
    if it.kind == 'save' or it.kind == 'reset' or it.kind == 'suit' then
        return true
    end
    local top, bottom = tunerBand(self)
    return it.y >= top - 0.5 and it.y + it.h <= bottom + 0.5
end

local function tunerItemAt(self: Table, px: number, py: number): TunerItem?
    local tn = self.L.tuner
    for _, it in ipairs(self.tunerItems) do
        -- The foot's buttons sit 110px apart on one line, so each is hit in
        -- its own 100px; a row or a head is the column's width. At the
        -- column's width SAVE was the first match for every press on the
        -- foot, and RESET (and now SUIT) could never be reached.
        local w = if it.kind == 'save' or it.kind == 'reset' or it.kind == 'suit' then 100 * tn.scale else tn.colW
        if tunerShows(self, it) and inRect(px, py, it.x, it.y, w, it.h) then
            return it
        end
    end
    return nil
end

local function tunerSet(self: Table, i: number, px: number, itemX: number)
    local tn = self.L.tuner
    local row = TUNING[i]
    -- Back into row units: the track is where it was authored, the panel is
    -- what changed size.
    local t = clamp(((px - itemX) / tn.scale - tn.x0) / (tn.x1 - tn.x0), 0, 1)
    T[row.key] = row.min + t * (row.max - row.min)
    writeTunerRow(self, i)
end

-- The same drag, on a card row: the knob's travel becomes the row's range,
-- snapped to `step` where the value is an index or a count.
local function subjectSetFromKnob(self: Table, i: number, px: number, itemX: number)
    local tn = self.L.tuner
    local row = SUBJECT_ROWS[i]
    local t = clamp(((px - itemX) / tn.scale - tn.x0) / (tn.x1 - tn.x0), 0, 1)
    local v = row.min + t * (row.max - row.min)
    if row.step > 0 then
        v = math.floor(v / row.step + 0.5) * row.step
    end
    subjectSet(self, row.key, v)
    writeSubjectRow(self, i)
end

local function rgbHex(c: { number }): string
    local function ch(v: number): number
        return clamp(math.floor(v * 255 + 0.5), 0, 255)
    end
    return string.format('#%02X%02X%02X', ch(c[1]), ch(c[2]), ch(c[3]))
end

-- The lines the tool outside is listening for: one TUNING-SAVE with every
-- slider, then one TANKS-SAVE per card the panel changed, each a whole
-- tanks.csv row — the tool rewrites those cells and leaves the rest of the
-- row (flip, notes) as it found them. `card=Q:star` because the line is
-- split on spaces.
local function tunerSave(self: Table)
    local parts: { string } = {}
    for _, row in ipairs(TUNING) do
        table.insert(parts, `{row.key}={string.format('%.5g', T[row.key])}`)
    end
    print('TUNING-SAVE ' .. table.concat(parts, ' '))
    local ids: { number } = {}
    for id, _ in pairs(self.tankDirty) do
        table.insert(ids, id)
    end
    table.sort(ids)
    for _, id in ipairs(ids) do
        local rec = self.tankOf[id]
        if rec ~= nil then
            local suit = (id - 1) // 13 + 1
            local rank = (id - 1) % 13 + 1
            local function opt(v: number?): string
                return if v ~= nil then string.format('%.4g', v) else ''
            end
            print(`TANKS-SAVE card={K.RANK_TEXT[rank]}:{SUIT_NAMES[suit]} model={rec.species.name} count={rec.count} size={string.format('%.4g', rec.size)} back={rgbHex(rec.back)} belly={rgbHex(rec.belly)} bg={rgbHex(rec.bg)} colGap={opt(rec.colGap)} rowGap={opt(rec.rowGap)} padX={opt(rec.padX)} padY={opt(rec.padY)} drop={opt(rec.drop)} rotate={opt(rec.rotate)} rotateVary={opt(rec.rotateVary)} yaw={opt(rec.yaw)} roll={opt(rec.roll)} sway={opt(rec.sway)} loop={opt(rec.loop)} bio={string.format('%.4g', rec.bio)} bioColor={rgbHex(rec.bioColor)} bioSpeed={opt(rec.bioSpeed)} bioScale={opt(rec.bioScale)} bioContrast={opt(rec.bioContrast)} bioCoverage={opt(rec.bioCoverage)} bioPan={opt(rec.bioPan)} bioEvolve={opt(rec.bioEvolve)}`)
        end
    end
end

local function tunerReset(self: Table)
    for _, row in ipairs(TUNING) do
        T[row.key] = row.value
    end
    -- And every card the panel touched, back to its tanks.csv row.
    for id, _ in pairs(self.tankDirty) do
        local rec = self.tankOf[id]
        local orig = self.tankOrig[id]
        if rec ~= nil and orig ~= nil then
            rec.species = orig.species
            rec.count = orig.count
            rec.size = orig.size
            rec.back = { orig.back[1], orig.back[2], orig.back[3] }
            rec.belly = { orig.belly[1], orig.belly[2], orig.belly[3] }
            rec.bg = { orig.bg[1], orig.bg[2], orig.bg[3] }
            rec.colGap, rec.rowGap, rec.padX, rec.padY = orig.colGap, orig.rowGap, orig.padX, orig.padY
            rec.drop, rec.rotate, rec.rotateVary = orig.drop, orig.rotate, orig.rotateVary
            rec.yaw, rec.roll, rec.sway, rec.loop = orig.yaw, orig.roll, orig.sway, orig.loop
            rec.bio = orig.bio
            rec.bioColor = { orig.bioColor[1], orig.bioColor[2], orig.bioColor[3] }
            rec.bioSpeed, rec.bioScale, rec.bioContrast = orig.bioSpeed, orig.bioScale, orig.bioContrast
            rec.bioCoverage, rec.bioPan, rec.bioEvolve = orig.bioCoverage, orig.bioPan, orig.bioEvolve
        end
    end
    table.clear(self.tankDirty)
    recapSpecies(self)
    writeTuner(self)
end

-- SUIT: the subject's species, size and colours onto every NUMBER card of
-- its suit (2-10 share a school and differ only by count), when the subject
-- is one of them. A court card or an ace is its own creature and this does
-- nothing but say so.
local function spreadSuit(self: Table)
    local id = self.subject
    local rec = self.tankOf[id]
    if rec == nil then
        return
    end
    local suit = (id - 1) // 13 + 1
    local rank = (id - 1) % 13 + 1
    if rank < 2 or rank > 10 then
        print(`sealitaire: SUIT spreads a number card's look; {cardName(id)} is its own creature`)
        return
    end
    for r = 2, 10 do
        local other = (suit - 1) * 13 + r
        local o = self.tankOf[other]
        if other ~= id and o ~= nil then
            o.species = rec.species
            o.size = rec.size
            o.back = { rec.back[1], rec.back[2], rec.back[3] }
            o.belly = { rec.belly[1], rec.belly[2], rec.belly[3] }
            o.bg = { rec.bg[1], rec.bg[2], rec.bg[3] }
            o.colGap, o.rowGap, o.padX, o.padY = rec.colGap, rec.rowGap, rec.padX, rec.padY
            o.drop, o.rotate, o.rotateVary = rec.drop, rec.rotate, rec.rotateVary
            o.yaw, o.roll, o.sway = rec.yaw, rec.roll, rec.sway
            o.bio = rec.bio
            o.bioColor = { rec.bioColor[1], rec.bioColor[2], rec.bioColor[3] }
            o.bioSpeed, o.bioScale, o.bioContrast = rec.bioSpeed, rec.bioScale, rec.bioContrast
            o.bioCoverage, o.bioPan, o.bioEvolve = rec.bioCoverage, rec.bioPan, rec.bioEvolve
            self.tankDirty[other] = true
        end
    end
    recapSpecies(self)
    print(`sealitaire: {cardName(id)}'s look spread over the {SUIT_NAMES[suit]} 2-10 ({rec.species.name})`)
end

-- The x of the row a drag is on, this frame.
local function tunerRowX(self: Table, kind: string, i: number): number
    for _, it in ipairs(self.tunerItems) do
        if it.kind == kind and it.i == i then
            return it.x
        end
    end
    return self.L.tuner.x
end

-- True when the panel took the press.
local function tunerPress(self: Table, px: number, py: number): boolean
    if not self.tunerOpen then
        return false
    end
    local tn = self.L.tuner
    if not inRect(px, py, tn.x, tn.y, tn.colW * tn.cols + tn.gutter, tn.maxH) then
        return false
    end
    local it = tunerItemAt(self, px, py)
    if it == nil then
        -- The background takes the press and becomes the scroll: on a panel
        -- that cannot show every row there has to be some way to reach the
        -- rest, and the gaps between the columns are the only surface that
        -- is not already a slider or a header.
        self.tunerPan = py
        self.tunerPanFrom = self.tunerScroll
    else
        if it.kind == 'head' then
            self.tunerCatOpen[it.i] = not self.tunerCatOpen[it.i]
            writeTunerHead(self, it.i)
        elseif it.kind == 'shead' then
            self.subjectOpen = not self.subjectOpen
            writeSubjectHeads(self)
        elseif it.kind == 'row' then
            self.tunerDrag = it.i
            self.tunerDragKind = 'row'
            tunerSet(self, it.i, px, it.x)
        elseif it.kind == 'srow' then
            self.tunerDrag = it.i
            self.tunerDragKind = 'srow'
            subjectSetFromKnob(self, it.i, px, it.x)
        elseif it.kind == 'save' then
            tunerSave(self)
        elseif it.kind == 'reset' then
            tunerReset(self)
        elseif it.kind == 'suit' then
            spreadSuit(self)
        end
    end
    return true
end

-- ---------------------------------------------------------------------------
-- Picking a run up and putting it down
--
-- Both are shared by the pointer and the pad, and that sharing is the point.
-- A gamepad port that reimplements "take these cards" ends up with two ideas
-- of what a grab is, and the one that is not the mouse's is the one that
-- quietly stops firing the bite, the pop or the sound. There is one grab here
-- and one release, and the two callers differ only in where the cards go
-- while they are in the air.
-- ---------------------------------------------------------------------------
local function grabRun(self: Table, pile: K.Pile, index: number, run: { K.Card }, offX: number, offY: number, px: number, py: number, pad: boolean)
    local card = pile.cards[index]
    local top = self.views[card.id]
    playSfx(self, 'grab')
    -- Every card starts where the hand is, so the run does not whip in from
    -- wherever the last drag left it.
    local trailX: { number } = {}
    local trailY: { number } = {}
    for i = 1, #run do
        trailX[i] = px
        trailY[i] = py
    end
    self.drag = {
        pile = pile, index = index, cards = run,
        offX = offX, offY = offY,
        lastX = px, lastY = py,
        smX = px, smY = py, vX = 0, vY = 0,
        trailX = trailX, trailY = trailY,
        pad = pad,
    }
    for i, c in ipairs(run) do
        local v = self.views[c.id]
        v.z = 5000 + i
        v.tscale = 1.08
        v.vscale = 1.2
    end
    -- The click: the card dips into the hand, then the drag's own scale
    -- takes over. The run's pop is let go — it is held now, not hovered.
    HOVER.kick(top.pop, T.pressKick)
    self.hovered = card.id
    self.hoverRaw = card.id
    self.orderDirty = true
    self.pressedCard = card.id
    -- The seal bites the corner nearest to it.
    self.bitten = card.id
    self.biteSide = if self.puppet.x < top.tx then -1 else 1
    self.releaseT = -1
end

-- Let go of whatever is in hand, onto `dest` or nowhere. `dest` being the
-- pile the run came from is the same as nowhere: the cards spring home and
-- nothing is scored, which is what a drag that changed its mind looks like.
local function releaseDrag(self: Table, dest: K.Pile?)
    local drag = self.drag
    if drag == nil then
        return
    end
    self.drag = nil
    if self.bitten ~= 0 then
        self.bitten = 0
        self.releaseT = 0
    end
    local moved = false
    if dest ~= nil and dest ~= drag.pile then
        moved = tryMove(self, drag.pile, drag.index, dest)
        if not moved then
            playSfx(self, 'invalid')
        end
    end
    if not moved then
        relayout(self)
        for _, c in ipairs(drag.cards) do
            self.views[c.id].vrot = 1.5
        end
    end
    self.hovered = 0
end

-- ---------------------------------------------------------------------------
-- Pointer
-- ---------------------------------------------------------------------------
-- How far a press may be from where the pointer was last REPORTED at rest and
-- still be the same device. A mouse moves to a target and then clicks it, so
-- the two agree to the pixel; a finger's press is the first the script has
-- heard of that point. A couple of px of slack covers a trackpad tap, which
-- does nudge the cursor on its way down.
local TOUCH_SLACK = 3

local function pointerDown(self: Table, event: PointerEvent)
    -- A GESTURE IS ALREADY RUNNING AND THIS IS NOT IT. On a phone that is a
    -- second thumb, and without this it takes the card out of the first one's
    -- hand: `self.drag` is one slot, so the new press overwrites it and the
    -- run already in the air is never released — it hangs at z 5000 over the
    -- table until the next deal. Dropped WITHOUT `event:hit()`, so the press
    -- goes on to whatever is behind us rather than being silently eaten.
    --
    -- ONLY WHILE ONE IS ACTUALLY IN FLIGHT, and the three things that can be
    -- are named rather than trusted to the id alone. An `up` that never
    -- arrives is not a rare case on a touchscreen — a finger can leave the
    -- glass outside the window, or the page can lose the pointer to the
    -- system — and an id claimed on a gesture that has quietly ended would
    -- leave the table deaf to every finger but that one, for good.
    if self.gestureId >= 0 and event.id ~= self.gestureId
        and (self.drag ~= nil or self.tunerDrag > 0 or self.tunerPan >= 0) then
        return
    end
    local at = throughCurve(self.L, event.position)
    local px, py = at.x, at.y
    -- The tuner is drawn FLAT, over the finished screen (drawTuner), so it is
    -- the one thing hit-tested where the pointer actually is rather than where
    -- the barrel curve put the table under it. It is also tested FIRST: it is
    -- an overlay, and a press inside it never reaches the cards beneath.
    local rp = event.position
    -- A press landing somewhere the pointer has never been reported is a
    -- finger. See `touchOn`.
    local away = math.abs(rp.x - self.freeMove.x) + math.abs(rp.y - self.freeMove.y)
    if away > TOUCH_SLACK then
        self.touchOn = true
    end
    self.gestureId = event.id
    self.pointer = at
    self.pointerKnown = true
    -- A hand on the table puts the pad's cursor away. It comes back on the
    -- next thing the pad sends, so the two can be swapped between freely and
    -- the ring is only ever up for the device in use.
    if self.drag == nil or not self.drag.pad then
        self.pad.on = false
    end
    event:hit()

    if tunerPress(self, rp.x, rp.y) then
        return
    end
    local title = self.L.title
    if inRect(px, py, title.x, title.y, title.w, title.h) then
        self.tunerOpen = not self.tunerOpen
        writeTuner(self)
        return
    end
    local button = self.L.button
    if inRect(px, py, button.x, button.y, button.w, button.h) then
        deal(self, freshSeed())
        return
    end
    if self.game.won then
        return
    end

    -- Stock: a click draws.
    local sx, sy = pileOrigin(self.L, self.game.stock)
    if math.abs(px - sx) <= self.L.cw / 2 and math.abs(py - sy) <= self.L.ch / 2 then
        -- The fan drops into the draw: the top card flips off the ribbon.
        self.stockPulse = 1
        -- The click ends the rise. The fan's own fall would choke it a frame
        -- later anyway (wantFan is scaled by 1 - stockPulse), but that is a
        -- side effect of a decay rate; this says it outright and survives
        -- stockDrop being retuned.
        chokeHover(self)
        drawStock(self)
        return
    end

    local pile, index = hitCard(self, px, py)
    if pile == nil then
        return
    end
    local card = pile.cards[index]
    -- With the panel open a face-up card is also the lab's SUBJECT: the card
    -- rows now edit its tanks.csv row. The drag still happens, because how
    -- the bodies rattle is part of what is being looked at.
    if self.tunerOpen and card.faceUp and self.tankOf[card.id] ~= nil then
        self.subject = card.id
        -- Picking a card is the ask to see its rows, so it unfolds the group
        -- the panel starts with closed. Otherwise the pick reads as nothing.
        self.subjectOpen = true
        writeSubject(self)
    end
    local run = K.runFrom(pile, index)
    if run == nil then
        return
    end

    -- A second press on the same card within a beat: send it up.
    if card.id == self.lastDownId and self.time - self.lastDownTime < 0.35 then
        self.lastDownId = 0
        local f = K.foundationFor(self.game, card)
        if f ~= nil and index == #pile.cards then
            tryMove(self, pile, index, f, 'foundationSend')
            return
        end
    end
    self.lastDownId = card.id
    self.lastDownTime = self.time

    local top = self.views[card.id]
    -- THE TOUCH LIFT. A thumb is over the card it has just taken, so a touch
    -- drag carries the run clear of the contact point and you aim with the
    -- card. It rides in the grab OFFSET rather than being added at the draw,
    -- which means the drop reads off the lifted card too — `pileUnder` is
    -- given the head's own position, so the pile you are over is the one the
    -- card is over and not the one your thumb is on.
    local lift = if self.touchOn then T.touchLift * self.L.ch else 0
    grabRun(self, pile, index, run, top.tx - px, top.ty - py - lift, px, py, false)
end

-- THE RUN IN HAND, on the frame clock. The pointer says where the hand is;
-- this decides where the cards are, and they are not the same place.
--
-- The head TRAILS the pointer by `dragLag`, and every card under it trails the
-- one above by a little more, so a run pulled across the table arrives as a
-- ribbon rather than a rigid stack welded to the cursor. The lag is small — at
-- the default the head is a couple of frames behind — but it is the whole
-- difference between carrying something through water and dragging an icon.
--
-- The bank comes off the eased VELOCITY in px/s, so it is the same for the same
-- hand speed whatever the pointer's report rate, and it decays to nothing when
-- the hand stops instead of holding the last event's delta.
local function updateDrag(self: Table, dt: number)
    local drag = self.drag
    if drag == nil or drag.pad or dt <= 0 then
        return
    end
    local k = 1 - math.exp(-math.max(0.01, T.dragLag) * dt)
    local nx = drag.smX + (drag.lastX - drag.smX) * k
    local ny = drag.smY + (drag.lastY - drag.smY) * k
    -- Measured off the eased anchor, not the raw pointer: the raw one is a
    -- staircase at any report rate below the frame rate, and the bank would
    -- show every step of it.
    local kv = 1 - math.exp(-9 * dt)
    drag.vX += ((nx - drag.smX) / dt - drag.vX) * kv
    drag.vY += ((ny - drag.smY) / dt - drag.vY) * kv
    drag.smX, drag.smY = nx, ny

    local fan = self.L.fanUp
    -- Card 1 chases the hand; every card under it chases the one ABOVE it, at a
    -- rate cut by `dragTrail` each step down. That is what bends the run
    -- through a turn instead of swinging it as one board.
    local rate: number = math.max(0.01, T.dragLag)
    local cut: number = 1 - clamp(T.dragTrail, 0, 0.9)
    local ax, ay = drag.smX, drag.smY
    local bank: number = clamp(drag.vX * T.dragBank, -0.35, 0.35)
    for i, c in ipairs(drag.cards) do
        local kt = 1 - math.exp(-rate * dt)
        drag.trailX[i] += (ax - drag.trailX[i]) * kt
        drag.trailY[i] += (ay - drag.trailY[i]) * kt
        ax, ay = drag.trailX[i], drag.trailY[i]
        rate *= cut
        local v = self.views[c.id]
        v.tx = drag.trailX[i] + drag.offX
        v.ty = drag.trailY[i] + drag.offY + (i - 1) * fan
        v.trot = bank
    end
end

-- How far the stock's fan may rise: the tuner's stockRise, capped so the top
-- card never covers a piece of chrome that stands over the deck's column and
-- never leaves the window. The arithmetic is LAYOUT.fanRoom's, pure and
-- tested there — it is geometry at a viewport like everything else in that
-- file, and it was silently returning zero at every screen size for as long
-- as the readouts have been at the foot.
local function fanRoom(self: Table): number
    local sx = pileOrigin(self.L, self.game.stock)
    return LAYOUT.fanRoom(self.L, sx, T.stockRise, T.stockClear)
end

local function pointerMove(self: Table, event: PointerEvent)
    if self.gestureId >= 0 and event.id ~= self.gestureId then
        return
    end
    local at = throughCurve(self.L, event.position)
    local px, py = at.x, at.y
    if self.gestureId < 0 then
        -- A FREE MOVE: the pointer reporting where it is with nothing held
        -- down. Only a mouse does this, so it both marks the device as a
        -- mouse and records the point a press is measured against.
        self.freeMove = event.position
        self.touchOn = false
        -- ...and it puts the pad's cursor away — unless the pad is holding a
        -- run, which nothing but the pad can put down.
        if self.drag == nil or not self.drag.pad then
            self.pad.on = false
        end
    end
    self.pointer = at
    self.pointerKnown = true
    if self.tunerPan >= 0 then
        event:hit()
        self.tunerScroll = clamp(self.tunerPanFrom - (event.position.y - self.tunerPan), 0, self.tunerReach)
        return
    end
    if self.tunerDrag > 0 then
        event:hit()
        -- Raw, like the press that started it: a knob dragged through the
        -- curve would slide away from the pointer toward the screen's edges.
        if self.tunerDragKind == 'srow' then
            subjectSetFromKnob(self, self.tunerDrag, event.position.x, tunerRowX(self, 'srow', self.tunerDrag))
        else
            tunerSet(self, self.tunerDrag, event.position.x, tunerRowX(self, 'row', self.tunerDrag))
        end
        return
    end
    -- An open panel swallows the pointer: no hover, no drag, no seal, under it.
    local tn = self.L.tuner
    if self.tunerOpen and inRect(event.position.x, event.position.y, tn.x, tn.y, tn.colW * tn.cols + tn.gutter, tn.maxH) then
        event:hit()
        self.hoverRaw = 0
        return
    end
    local drag = self.drag
    if drag ~= nil and drag.pad then
        -- A run the PAD is carrying is laid on the cursor's pile every frame
        -- (Pad.apply); a mouse moved across the table must not drag it out
        -- from under the cursor that is holding it.
        return
    end
    if drag ~= nil then
        event:hit()
        -- ONLY RECORD THE POINTER. Where the run goes is worked out on the
        -- frame clock (updateDrag), because none of it can be done here: a
        -- pointer event is not a tick. The bank used to be `px - lastX` x a
        -- constant, which is a distance PER EVENT — the same hand moving at the
        -- same speed banked the card twice as hard when the mouse reported at
        -- half the rate, and a stationary hand holding a card had whatever the
        -- last event happened to leave.
        drag.lastX, drag.lastY = px, py
        return
    end
    -- Over the deck? The fan, and no card hover. The deck's hitbox is its
    -- slot plus the room the fan may rise into, so the pointer can follow
    -- the ribbon up; leave it and the fan collapses.
    do
        local sx, sy = pileOrigin(self.L, self.game.stock)
        local m = 6 * self.L.fit
        local room = fanRoom(self)
        self.stockHovered = math.abs(px - sx) <= self.L.cw / 2 + m
            and py >= sy - self.L.ch / 2 - room - m and py <= sy + self.L.ch / 2 + m
            and #self.game.stock.cards > 0
    end
    -- HYSTERESIS. A pointer resting on the seam between two fanned cards
    -- would flip the hover every event, and the seal's landing point with
    -- it. So a new card only takes the hover when the pointer is clearly
    -- inside it (shrunk by half the margin), and the card that has it keeps
    -- it until the pointer is clearly out (grown by the margin) — unless a
    -- card ABOVE it in the stack has been clearly entered. The settle time
    -- in advance() is the second guard.
    local pile, index = hitCard(self, px, py, -T.hoverMargin * self.L.fit * 0.5)
    local raw = 0
    if pile ~= nil and pile.kind ~= 'stock' and K.runFrom(pile, index) ~= nil then
        raw = pile.cards[index].id
    end
    local keep = self.hovered
    if keep ~= 0 then
        local kv = self.views[keep]
        if cardHit(self.L, kv, px, py, T.hoverMargin * self.L.fit) and (raw == 0 or self.views[raw].z < kv.z) then
            raw = keep
        end
    end
    self.hoverRaw = raw
end

local function pointerUp(self: Table, event: PointerEvent)
    if self.gestureId >= 0 and event.id ~= self.gestureId then
        return
    end
    self.gestureId = -1
    local drag = self.drag
    self.pointer = throughCurve(self.L, event.position)
    if self.tunerPan >= 0 then
        self.tunerPan = -1
        event:hit()
        return
    end
    if self.tunerDrag > 0 then
        self.tunerDrag = 0
        event:hit()
        return
    end
    if drag == nil then
        -- A TAP THAT PICKED NOTHING UP still ends the hover on a touchscreen.
        -- There is no `pointerExit` when a finger leaves the glass — the
        -- pointer does not travel out of the window, it stops existing — so
        -- the card the tap lit up would stay lit, with the seal staring at
        -- it, until something else was touched.
        if self.touchOn then
            self.hoverRaw = 0
            self.pointerKnown = false
        end
        return
    end
    event:hit()
    local head = self.views[drag.cards[1].id]
    releaseDrag(self, pileUnder(self, head.tx, head.ty))
    if self.touchOn then
        self.hoverRaw = 0
        self.pointerKnown = false
    end
end

local function pointerExit(self: Table, event: PointerEvent)
    if self.drag == nil then
        self.hovered = 0
        self.hoverRaw = 0
        self.pointerKnown = false
        if self.tunerDrag == 0 and self.tunerPan < 0 then
            self.gestureId = -1
        end
    end
end

-- ---------------------------------------------------------------------------
-- The pad
--
-- A CURSOR, NOT A FLYING POINTER. `pad.luau` holds the whole of where it can
-- be and what a direction does to it, pure and tested; this half is what that
-- costs the table — where the cursor is in PIXELS, and the fact that a pad
-- press has to reach every piece of feel a click already reaches.
--
-- THE TRICK THAT MAKES IT NOT FEEL BOLTED ON: the cursor writes `self.pointer`
-- and `self.hoverRaw` every frame, which are the two things the rest of this
-- file already watches. So the seal's gaze follows the cursor, the hover pop
-- runs down the run it is standing on, the glow ring lights, the water's eye
-- drifts toward it and the deck fans when it arrives there — none of which
-- knows a pad exists. A second path for any of that would be a second thing
-- to keep in step, and the one that is not the mouse's is the one that
-- quietly stops firing.
-- ---------------------------------------------------------------------------
-- ONE LOCAL, NOT FIFTEEN. Luau's main chunk has 200 registers and every
-- top-level `local function` in this file takes one; table.luau was within a
-- handful of the limit before the pad arrived, and fifteen more failed at
-- LOAD with "Out of local registers", naming whichever function happened to
-- be allocated when the count ran out — a line with nothing wrong with it,
-- a long way from the code that spent the registers. A table of functions
-- costs one register for any number of them.
local Pad = {}

-- Where the head of a run would come to rest on this pile: on top of what is
-- there, one fan step down a column, or on the empty slot itself.
--
-- NOT `slotFor(g, pile, #cards + 1)`, which reads `cards[i].faceUp` up to the
-- index it is given and would index past the end of the list.
function Pad.landing(self: Table, pile: K.Pile): (number, number)
    local g = self.L
    local n = #pile.cards
    if n == 0 then
        return pileOrigin(g, pile)
    end
    local x, y = slotFor(g, pile, n)
    if pile.kind == 'tableau' then
        local down, up = 0, 0
        for _, c in ipairs(pile.cards) do
            if c.faceUp then up += 1 else down += 1 end
        end
        local fanUp = LAYOUT.fanFor(g, down, up)
        y += fanUp
    end
    return x, y
end

-- The point the cursor is standing on, with nothing in hand: the selected
-- card's own resting place, the top of the pile where none is selectable, or
-- the empty slot.
function Pad.point(self: Table): (number, number)
    local g = self.L
    local cur = self.pad.cursor
    local pile = PAD.pileAt(self.game, cur)
    if pile == nil then
        return LAYOUT.colX(g, cur.col), g.topY
    end
    local k = self.pad.grab
    if k > 0 and pile.cards[k] ~= nil then
        local v = self.views[pile.cards[k].id]
        return v.tx, v.ty
    end
    if #pile.cards > 0 then
        -- Two of slotFor's three: the z is the pile's own and means nothing
        -- to a cursor. Returned bare it would be a third value out of a
        -- function that promises two.
        local x, y = slotFor(g, pile, #pile.cards)
        return x, y
    end
    return pileOrigin(g, pile)
end

-- Every frame the pad is the device: the selection re-read against a game
-- that may have moved under it, and the two fields the rest of the file
-- watches written from it.
function Pad.apply(self: Table)
    local g = self.L
    local cur = self.pad.cursor
    local pile = PAD.pileAt(self.game, cur)
    local drag = self.drag
    if drag ~= nil and drag.pad then
        -- The run rides the cursor. Over the pile it came from it lies back
        -- on its own slots, which is what "you have not moved it anywhere
        -- yet" has to look like — `releaseDrag` treats the source as nowhere.
        local hx, hy
        if pile == nil or pile == drag.pile then
            hx, hy = slotFor(g, drag.pile, drag.index)
        else
            hx, hy = Pad.landing(self, pile)
        end
        for i, c in ipairs(drag.cards) do
            local v = self.views[c.id]
            v.tx = hx
            v.ty = hy + (i - 1) * g.fanUp
            v.trot = 0
        end
        self.pointer = Vector.xy(hx, hy)
        self.pointerKnown = true
        self.stockHovered = false
        return
    end
    self.pad.grab = if pile == nil then 0 else PAD.grabAt(pile, self.pad.grab)
    local px, py = Pad.point(self)
    self.pointer = Vector.xy(px, py)
    self.pointerKnown = true
    -- The deck fans for the cursor exactly as it does for a mouse.
    self.stockHovered = pile ~= nil and pile.kind == 'stock' and #self.game.stock.cards > 0
    local id = 0
    if pile ~= nil and self.pad.grab > 0 then
        local c = pile.cards[self.pad.grab]
        if c ~= nil and c.faceUp then
            id = c.id
        end
    end
    self.hoverRaw = id
end

function Pad.move(self: Table, dx: number, dy: number)
    local holding = self.drag ~= nil
    local r
    if dx ~= 0 then
        r = PAD.horizontal(self.game, self.pad.cursor, dx)
    else
        r = PAD.vertical(self.game, self.pad.cursor, self.pad.grab, dy, holding)
    end
    self.pad.cursor = r.cursor
    if not holding then
        self.pad.grab = r.grab
    end
end

-- SOUTH. On the deck it draws; on a card it takes the run; with a run in hand
-- it puts it down on the pile the cursor is over. The three are the same
-- button because they are the same intention — the thing under the cursor.
function Pad.south(self: Table)
    local drag = self.drag
    if drag ~= nil then
        if not drag.pad then
            return
        end
        local pile = PAD.pileAt(self.game, self.pad.cursor)
        releaseDrag(self, pile)
        return
    end
    local pile = PAD.pileAt(self.game, self.pad.cursor)
    if pile == nil or self.game.won then
        return
    end
    if pile.kind == 'stock' then
        -- The same three lines the deck's click runs: the fan drops as the
        -- top card flips off it, and the rising sound is choked rather than
        -- left to be cut off by the fan's own fall a frame later.
        self.stockPulse = 1
        chokeHover(self)
        drawStock(self)
        return
    end
    local k = self.pad.grab
    if k <= 0 then
        return
    end
    local run = K.runFrom(pile, k)
    if run == nil then
        return
    end
    -- With the panel open a picked card is the lab's SUBJECT too, the same as
    -- a click on one (see pointerDown).
    local card = pile.cards[k]
    if self.tunerOpen and card.faceUp and self.tankOf[card.id] ~= nil then
        self.subject = card.id
        self.subjectOpen = true
        writeSubject(self)
    end
    local v = self.views[card.id]
    grabRun(self, pile, k, run, 0, 0, v.tx, v.ty, true)
end

-- EAST puts a held run back where it came from. `releaseDrag(nil)` is the
-- same nowhere a drag released over open water lands on, so the cards spring
-- home, nothing is scored and no invalid sound fires — a cancel is not a
-- failed move.
function Pad.east(self: Table)
    local drag = self.drag
    if drag == nil or not drag.pad then
        return
    end
    self.pad.cursor = PAD.cursorOf(drag.pile)
    self.pad.grab = drag.index
    releaseDrag(self, nil)
end

-- NORTH sends the card under the cursor up, which is the pad's spelling of
-- the double-click. Only the TOP card of a pile can go: a foundation takes
-- one card, so a run's head going up would leave the rest of the run behind
-- it in mid-air.
function Pad.north(self: Table)
    if self.drag ~= nil or self.game.won then
        return
    end
    local pile = PAD.pileAt(self.game, self.pad.cursor)
    local k = self.pad.grab
    if pile == nil or k <= 0 or k ~= #pile.cards then
        return
    end
    local f = K.foundationFor(self.game, pile.cards[k])
    if f ~= nil then
        tryMove(self, pile, k, f, 'foundationSend')
    end
end

-- THE SHOULDERS jump to the next place worth being: with nothing in hand the
-- piles a move could start from, with a run in hand the piles it could land
-- on. Both rings are `K.plays` read as places, so the pad is pointed at the
-- same moves the seal's fins are pointing at and never at one the rules would
-- refuse — and the ring is rebuilt on every press, because a list held across
-- a move goes stale the instant the move changes what has a play on it.
function Pad.jump(self: Table, by: number)
    local drag = self.drag
    local ring
    if drag ~= nil then
        ring = PAD.destinations(self.game, drag.pile, drag.index)
    else
        ring = PAD.sources(self.game)
    end
    local to = PAD.nextIn(ring, self.pad.cursor, by)
    if to == nil then
        return
    end
    self.pad.cursor = to
    if drag == nil then
        local into = PAD.pileAt(self.game, to)
        self.pad.grab = if into == nil then 0 else PAD.grabAt(into, #into.cards)
    end
end

-- Waking the pad. The cursor comes up UNDER THE CARD THE POINTER WAS ON where
-- there is one, so picking up a controller mid-game does not throw the cursor
-- to the far side of the table.
function Pad.wake(self: Table)
    local st = self.pad
    if st.on then
        return
    end
    st.on = true
    if self.hovered == 0 or self.drag ~= nil then
        return
    end
    local cur, grab = PAD.find(self.game, self.hovered)
    if cur ~= nil then
        st.cursor = cur
        st.grab = grab
    end
end

function Pad.press(self: Table, name: string)
    if name == 'south' then
        Pad.south(self)
    elseif name == 'east' then
        Pad.east(self)
    elseif name == 'north' then
        Pad.north(self)
    elseif name == 'leftShoulder' then
        Pad.jump(self, -1)
    elseif name == 'rightShoulder' then
        Pad.jump(self, 1)
    elseif name == 'start' then
        deal(self, freshSeed())
        self.pad.cursor = PAD.new()
        self.pad.grab = 0
    elseif name == 'back' then
        self.tunerOpen = not self.tunerOpen
        writeTuner(self)
    end
end

-- `PAD.read` does the device half — the button edges and where the stick is.
-- A connect comes through the same door: it carries the full state too, and
-- reading it the same way is what stops a pad plugged in with a button
-- already down from firing it.
function Pad.take(self: Table, ev: any)
    Pad.wake(self)
    for _, name in ipairs(PAD.read(self.pad, ev, T.padDead)) do
        Pad.press(self, name)
    end
end

function Pad.event(self: Table, event: GamepadEvent)
    Pad.take(self, event)
end

function Pad.connected(self: Table, event: GamepadConnected)
    Pad.take(self, event)
end

function Pad.disconnected(self: Table, event: GamepadDisconnected)
    -- Unplugged mid-drag: the run goes back where it came from rather than
    -- hanging over the table at z 5000 with nothing able to put it down.
    local drag = self.drag
    if drag ~= nil and drag.pad then
        releaseDrag(self, nil)
    end
    -- The DEVICE is cleared, not the cursor. A pad that drops out and comes
    -- back — a flat battery on a charger, a dongle re-enumerated by the OS —
    -- should carry on from where it was rather than throwing the cursor back
    -- to the first column; it is the same player, mid-game.
    local st = self.pad
    st.on = false
    st.x, st.y = 0, 0
    st.lastX, st.lastY = 0, 0
    st.holdX, st.holdY = 0, 0
    st.state = {}
end

-- THE REPEAT, on the table's clock. A direction acts on the frame it is first
-- seen, then holds for `padDelay` and repeats at `padRepeat`. Held down and
-- acted on per EVENT it would move once; acted on per FRAME it would cross
-- seven columns in a tenth of a second.
function Pad.step(self: Table, dt: number)
    local drag = self.drag
    if not self.pad.on and (drag == nil or not drag.pad) then
        return
    end
    local rate = 1 / math.max(0.05, T.padRepeat)
    if self.pad.x ~= self.pad.lastX then
        self.pad.lastX = self.pad.x
        self.pad.holdX = T.padDelay
        if self.pad.x ~= 0 then
            Pad.move(self, self.pad.x, 0)
        end
    elseif self.pad.x ~= 0 then
        self.pad.holdX -= dt
        if self.pad.holdX <= 0 then
            self.pad.holdX = rate
            Pad.move(self, self.pad.x, 0)
        end
    end
    if self.pad.y ~= self.pad.lastY then
        self.pad.lastY = self.pad.y
        self.pad.holdY = T.padDelay
        if self.pad.y ~= 0 then
            Pad.move(self, 0, self.pad.y)
        end
    elseif self.pad.y ~= 0 then
        self.pad.holdY -= dt
        if self.pad.holdY <= 0 then
            self.pad.holdY = rate
            Pad.move(self, 0, self.pad.y)
        end
    end
    Pad.apply(self)
end

-- Keys. Codes are GLFW's (the input_demo sample: '1' is 49, backspace 259),
-- so T is 84 and N is 78. Only reaches the script because the ScriptedLayout
-- has a FocusData child and the viewer focuses it.
local KEY_T = 84
local KEY_N = 78
local KEY_W = 87
local KEY_M = 77
local KEY_R = 82
local KEY_J = 74   -- audition: previous card sound
local KEY_K = 75   -- audition: replay
local KEY_L = 76   -- audition: next
local function keyboardEvent(self: Table, event: KeyboardEvent): boolean
    if event.phase ~= 'down' then
        return false
    end
    if event.key == KEY_T then
        self.tunerOpen = not self.tunerOpen
        writeTuner(self)
        return true
    elseif event.key == KEY_N then
        deal(self, freshSeed())
        return true
    elseif event.key == KEY_W then
        T.waterMode = waterMode() % #WATER_MODES
        print(`sealitaire: water mode {T.waterMode} ({WATER_MODES[waterMode()]})`)
        writeTuner(self)
        return true
    elseif event.key == KEY_R then
        T.cardRimMode = cardRimMode() % #RIM_MODES
        print(`sealitaire: card rim {T.cardRimMode} ({RIM_MODES[cardRimMode()]})`)
        writeTuner(self)
        return true
    elseif event.key == KEY_J or event.key == KEY_K or event.key == KEY_L then
        -- AUDITION THE BANK from inside the game, where a hit sits under the
        -- water and the CRT: J back, L forward, K again. The id goes to the
        -- console so a keeper can be pasted into sfxEvents.csv, which is read
        -- live — a recast is heard without leaving the window.
        --
        -- It walks self.sfxBank, which is sfx.csv's own rows. It used to
        -- generate the id from the position (`hg-cards-%03d` under 73,
        -- `hg-cards-digi-%03d` over) against a hardcoded 84, and that could
        -- not spell the processed takes from sfxFx.csv — so the four `-phaser`
        -- variants sat in the bank, cast on `hover`, and were the four sounds
        -- this key could never play. A generated name can only reach the
        -- sounds whose names follow the pattern it knows.
        local bank = self.sfxBank
        local count = #bank
        if count == 0 then
            print('sealitaire: sfx bank empty; run npm run sealitaire:sfx -- --write')
            return true
        end
        local step = if event.key == KEY_J then -1 elseif event.key == KEY_L then 1 else 0
        self.sfxIndex = ((self.sfxIndex - 1 + step) % count + count) % count + 1
        local name = bank[self.sfxIndex]
        local playing = self.sfxSound
        if playing ~= nil then
            playing:stop()
        end
        local ctx = self.context
        local src = if ctx ~= nil then ctx:audio(name) else nil
        if src ~= nil then
            local snd = Audio.play(src)
            if snd ~= nil then
                snd.volume = if self.muted then 0 else T.sfxVolume
            end
            self.sfxSound = snd
            print(`sealitaire: sfx {self.sfxIndex}/{count} {name}`)
        else
            -- A row in sfx.csv with no AudioAsset beside it: the index and the
            -- bank block in scene.rml are written by the same tool, so this
            -- means one of them was hand-edited.
            print(`sealitaire: sfx {name} is in sfx.csv but not in the file`)
        end
        return true
    elseif event.key == KEY_M then
        -- Mute the SOUND, not the water: the ripples are the track's shape
        -- and being able to watch them with the room quiet is most of how
        -- they get tuned. Unmuting restores the volume that was set rather
        -- than a number typed here — a keystroke must not quietly overwrite
        -- a slider, least of all one that SAVE then writes into tuning.luau.
        self.muted = not self.muted
        if self.muted then
            self.muteWas = T.musicVolume
            T.musicVolume = 0
        else
            T.musicVolume = self.muteWas
        end
        print(`sealitaire: music {if self.muted then 'muted' else 'on'}`)
        writeTuner(self)
        return true
    end
    return false
end

-- ---------------------------------------------------------------------------
-- The seal's rig
-- ---------------------------------------------------------------------------
local BONES = 28
-- seal.wgsl's uniform block: mvp, model, light, tint, mottle, mottleCol,
-- layer, then the bone matrices.
local SEAL_BONES_AT = 64 + 64 + 16 * 5
local SEAL_UBO = SEAL_BONES_AT + BONES * 64
local _NECK = { 'neck01_05', 'neck02_06', 'head_07' } -- slots 7, 8, 9 (see neckSlots)
-- How much of the gaze each neck bone takes, base to head.
local NECK_SHARE = { 0.3, 0.35, 0.35 }

local function readMat4(buf: buffer, at: number): Mat4
    local v = table.create(16, 0)
    for k = 1, 16 do
        v[k] = buffer.readf32(buf, at + (k - 1) * 4)
    end
    return Mat4.values(v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14], v[15], v[16])
end

-- WHERE EACH BONE'S SKIN IS, at bind: the centroid of the vertices that bone
-- weighs most, and the spread of them around it. That is what a bubble shed off
-- "the tail" or "the left flipper" is born on — the bone's own ORIGIN is inside
-- the animal and, for a long bone, nowhere near the surface that is moving.
--
-- Read straight out of the vertex block rather than baked by the mesh tool: the
-- joints and weights are already in there (bytes 36 and 40 of each vertex, see
-- tools/sealitaire-mesh.mjs), it is one pass over 1374 vertices at load, and it
-- cannot go stale against a rebaked mesh the way a second file would.
--
-- The spread comes out of the same pass as E[|p|^2] - |E[p]|^2 rather than a
-- second one per bone; a nested pass here was 30,000 iterations and, more to
-- the point, enough extra code to put this module over Luau's type-inference
-- budget and stop the whole build (see FIN_CHAINS for the same trap).
--
-- Five of the 28 bones carry no skin at all — the root chain, and the ball —
-- and they are left out rather than shedding from the origin.
-- The eyeballs have skin of their own (17 and 29 vertices) and would otherwise
-- be two perfectly good sources: the head turning fast made the seal shed
-- bubbles out of its eyes. Slots, because bone names are not in the blob — the
-- same way NECK, TAIL and FIN_L are named here.
local NO_SHED: { [number]: boolean } = { [11] = true, [12] = true }

local function measureShed(self: Table, data: buffer, vcount: number)
    local sumX: { number } = {}
    local sumY: { number } = {}
    local sumZ: { number } = {}
    local sumSq: { number } = {}
    local count: { number } = {}
    for b = 1, BONES do
        sumX[b] = 0
        sumY[b] = 0
        sumZ[b] = 0
        sumSq[b] = 0
        count[b] = 0
    end
    for v = 0, vcount - 1 do
        local o: number = 16 + v * 48
        -- The joint this vertex belongs to most. A vertex split evenly between
        -- two bones lands on one of them, which is the right answer for a spawn
        -- point even though it would be the wrong one for a skin.
        local best: number = 0
        local bw: number = -1
        for k = 0, 3 do
            local wgt: number = buffer.readu8(data, o + 40 + k)
            if wgt > bw then
                bw = wgt
                best = buffer.readu8(data, o + 36 + k)
            end
        end
        local b: number = best + 1
        if b >= 1 and b <= BONES and not NO_SHED[b] then
            local x: number = buffer.readf32(data, o)
            local y: number = buffer.readf32(data, o + 4)
            local z: number = buffer.readf32(data, o + 8)
            sumX[b] += x
            sumY[b] += y
            sumZ[b] += z
            sumSq[b] += x * x + y * y + z * z
            count[b] += 1
        end
    end
    local bones: { number } = {}
    local bind: { number } = {}
    local spread: { number } = {}
    for b = 1, BONES do
        local n: number = count[b]
        if n > 0 then
            local cx: number = sumX[b] / n
            local cy: number = sumY[b] / n
            local cz: number = sumZ[b] / n
            table.insert(bones, b)
            local at: number = #bones * 3
            bind[at - 2] = cx
            bind[at - 1] = cy
            bind[at] = cz
            local vari: number = sumSq[b] / n - (cx * cx + cy * cy + cz * cz)
            spread[#bones] = math.sqrt(math.max(0, vari))
        end
    end
    self.shedBones = bones
    self.shedBind = bind
    self.shedSpread = spread
    for i = 1, #bones do
        self.shedLastX[i] = 0
        self.shedLastY[i] = 0
        shedSrc[i] = { x = 0, y = 0, vx = 0, vy = 0, r = 0 }
    end
    self.shedWarm = false
end

local function loadSeal(self: Table, context: Context): boolean
    local blob = context:blob('seal')
    local shader = context:shader('seal')
    if blob == nil or shader == nil then
        print('sealitaire: seal.mesh or seal.wgsl missing; no seal')
        return false
    end
    local data = blob.data
    if buffer.readu8(data, 0) ~= 83 then -- 'S'
        print('sealitaire: seal.mesh has the wrong magic')
        return false
    end
    local vcount = buffer.readu32(data, 4)
    local icount = buffer.readu32(data, 8)
    local bcount = buffer.readu32(data, 12)
    if bcount ~= BONES then
        print(`sealitaire: seal.mesh has {bcount} bones, shader expects {BONES}`)
        return false
    end
    local STRIDE = 48
    local vbytes = vcount * STRIDE
    local ibytes = icount * 4
    local vbuf = buffer.create(vbytes)
    buffer.copy(vbuf, 0, data, 16, vbytes)
    local ibuf = buffer.create(ibytes)
    buffer.copy(ibuf, 0, data, 16 + vbytes, ibytes)
    self.sealVerts = GPUBuffer.new({ size = vbytes, usage = 'vertex', data = vbuf, immutable = true, label = 'seal verts' })
    self.sealIndex = GPUBuffer.new({ size = ibytes, usage = 'index', data = ibuf, immutable = true, label = 'seal index' })
    self.sealIndexCount = icount

    local at = 16 + vbytes + ibytes
    for b = 1, bcount do
        local parent = buffer.readi32(data, at)
        self.boneParent[b] = parent + 1 -- 1-based, 0 = none
        self.boneLocal[b] = readMat4(data, at + 4)
        self.boneIbm[b] = readMat4(data, at + 68)
        self.boneWorld[b] = Mat4.identity()
        self.boneSkin[b] = Mat4.identity()
        at += 4 + 64 + 64
    end
    measureShed(self, data, vcount)
    -- Bone names are not in the blob; the neck is by slot (see
    -- tools/sealitaire-mesh.mjs output): neck01_05 = 6, neck02_06 = 7, head_07 = 8.
    self.neckSlots = { 7, 8, 9 }
    -- The clips follow the bones in the blob.
    self.clips = PUPPET.readClips(data, at, bcount)
    self.sealData = data
    for b = 1, bcount do
        self.boneAnim[b] = Mat4.identity()
    end

    self.sealPipe = GPUPipeline.new({
        vertex = shader,
        fragment = shader,
        vertexLayout = {
            {
                stride = STRIDE,
                attributes = {
                    { format = 'float32x3', slot = 0, offset = 0 },
                    { format = 'float32x3', slot = 1, offset = 12 },
                    { format = 'float32x3', slot = 2, offset = 24 },
                    { format = 'uint8x4', slot = 3, offset = 36 },
                    { format = 'unorm8x4', slot = 4, offset = 40 },
                },
            },
        },
        colorTargets = { { format = 'rgba8unorm' } },
        depthStencil = { format = 'depth32float', compare = 'less', write = true },
        cullMode = 'none',
        label = 'seal',
    })
    local uboSize = SEAL_UBO
    self.sealBytes = buffer.create(uboSize)
    self.sealUnderUbo = GPUBuffer.new({ size = uboSize, usage = 'uniform', label = 'seal ubo under' })
    self.sealUnderBind = GPUBindGroup.new({
        layout = (self.sealPipe :: GPUPipeline):getBindGroupLayout(0),
        ubos = { { slot = 0, buffer = self.sealUnderUbo :: GPUBuffer } },
    })
    -- The over-cards pass reads the same numbers with layer.x = 1; a second
    -- buffer, because both passes are submitted after both writes.
    self.sealOverUbo = GPUBuffer.new({ size = uboSize, usage = 'uniform', label = 'seal ubo over' })
    self.sealOverBind = GPUBindGroup.new({
        layout = (self.sealPipe :: GPUPipeline):getBindGroupLayout(0),
        ubos = { { slot = 0, buffer = self.sealOverUbo :: GPUBuffer } },
    })
    return true
end

-- The tail, for the game's wag on top of the clip (CONFIG.animation.states
-- wagAmplitude / wagSpeed): tail00, tail01, tail02 by slot.
local TAIL = { 21, 22, 25 }
local SHOULDER_L, SHOULDER_R = 13, 17
local TAIL_GAIN = { 0.5, 0.8, 1.0 }
local MOUTH = 10

-- THE FLIPPERS, root to tip: the three bones the aim turns, and the bone whose
-- origin is the tip being aimed (the wrist — the blade past it is skinned, not
-- boned, so the wrist is the last thing with a position to read).
--
-- `_L` is the flipper on model +x, which is the SCREEN'S RIGHT in this shot:
-- we are looking at the seal's back, so its left hand is on our right. The
-- code below never says left or right on screen for that reason — a side is
-- the sign of a bearing and nothing else.

-- How much of a swing each bone takes, shoulder to wrist. The shoulder carries
-- most, so the whole limb reads as swinging; the two after it curl the blade
-- round behind it rather than leaving it a plank.
local FIN_SHARE = { 0.5, 0.3, 0.2 }
-- Both, by side, hoisted. A table literal rebuilt per frame is work for
-- nothing, and this module sits close enough to Luau's type-inference budget
-- that it is work the COMPILER charges for too: the first draft of the three
-- functions below spent the last of that budget and the whole build stopped
-- typechecking, with the error pointing at the tanks.csv reader three
-- hundred lines away.
-- That is why everything here is annotated and nothing is a union — a `Mat4?`
-- accumulator alone was most of it.
-- What `finPick` holds when a flipper is on the DECK rather than a card. Card
-- ids are 1..52, so a negative cannot collide with one.
local DECK_PICK = -1
local FIN_CHAINS: { { number } } = { { 13, 14, 15 }, { 17, 18, 19 } }
local FIN_TIPS: { number } = { 16, 20 }

-- The bearing a flipper currently points, in the body's own frame: 0 is the
-- nose, and it grows toward model +x. Measured wrist-against-shoulder off the
-- posed skeleton, so it follows whatever the swim clip is doing with the limb
-- — there is no such thing as a fixed rest pose to aim off.
local function finBearing(self: Table, root: number, tip: number): number
    local a = self.boneWorld[root]:transformPoint(0, 0, 0)
    local b = self.boneWorld[tip]:transformPoint(0, 0, 0)
    return math.atan2(b.x - a.x, b.z - a.z)
end

-- Swing one flipper `by` radians about the body's own up axis (model Y, which
-- is the screen's normal in this top-down shot), each bone turning about its
-- OWN origin and sharing the angle out along the limb.
--
-- No re-walk: a rigid turn applied to a bone in MODEL space reaches every bone
-- under it by left-multiplying the same matrix, so the accumulated turn is
-- carried down the chain and handed to the wrist at the end.
local function swingFin(self: Table, chain: { number }, tip: number, by: number)
    local acc: Mat4 = Mat4.identity()
    for i = 1, #chain do
        local b: number = chain[i]
        local w: Mat4 = Mat4.multiply(Mat4.identity(), acc, self.boneWorld[b])
        local o = w:transformPoint(0, 0, 0)
        local turn: Mat4 = Mat4.multiply(Mat4.identity(), Mat4.fromTranslation(o.x, o.y, o.z), Mat4.fromRotationY(by * FIN_SHARE[i]))
        turn = Mat4.multiply(Mat4.identity(), turn, Mat4.fromTranslation(-o.x, -o.y, -o.z))
        self.boneWorld[b] = Mat4.multiply(Mat4.identity(), turn, w)
        acc = Mat4.multiply(Mat4.identity(), turn, acc)
    end
    self.boneWorld[tip] = Mat4.multiply(Mat4.identity(), acc, self.boneWorld[tip])
end

-- Point one flipper at `want` (a bearing in the body's frame), `weight` of the
-- way, and never more than `finReach` off the pose the clip left it in.
--
-- THE TRAP THIS SOLVES: a fan does NOT turn its tip by the angle you hand it.
-- Each bone turns about a different pivot, so the shoulder's share swings the
-- whole limb but the wrist's share swings only the blade, and the tip arrives
-- at about four fifths of the ask on this rig. That shortfall is exactly what
-- makes a fan look like a fin instead of a plank, so it is not something to
-- design out — but a flipper that means to POINT at a card has to actually get
-- there. So this swings once, MEASURES what the rig gave back, and spends one
-- secant step closing the rest. Two swings, and the residual is second order.
--
-- Measuring rather than dividing by a constant also means nothing here can be
-- wrong about the rig: a rebaked seal, a different FIN_SHARE, even Mat4's
-- handedness turning out to be the other way round all come out in the
-- response, because the response is read off the bones and not assumed.
local function aimFin(self: Table, chain: { number }, tip: number, want: number, weight: number)
    if weight <= 0.002 then
        return
    end
    local root: number = chain[1]
    local have0: number = finBearing(self, root, tip)
    local trial: number = clamp(wrapPi(want - have0), -T.finReach, T.finReach) * weight
    if math.abs(trial) < 1e-4 then
        return
    end
    local goal: number = have0 + trial
    swingFin(self, chain, tip, trial)
    local have1: number = finBearing(self, root, tip)
    local got: number = wrapPi(have1 - have0)
    if math.abs(got) < 1e-4 then
        return -- a chain that will not turn; leave it where the first swing put it
    end
    local lim: number = math.abs(trial)
    swingFin(self, chain, tip, clamp(wrapPi(goal - have1) * (trial / got), -lim, lim))
end

-- Both flippers, after the clips have had the skeleton. Re-skins only the
-- bones it moved.
local function aimFins(self: Table)
    for side = 1, 2 do
        local chain: { number } = FIN_CHAINS[side]
        local tip: number = FIN_TIPS[side]
        -- While the flipper HAS a card, the bearing is worked out here, from the
        -- aim point and the seal's position and heading as they are THIS frame,
        -- so the aim stays nailed to the card through any amount of swimming.
        --
        -- Once the card is gone it is held in the BODY'S frame instead, and
        -- that is not a detail. Going on reading a stale point is the same bug
        -- as springing an angle, one level further out: the point stops moving
        -- but the seal does not, so its bearing off the nose drifts, crosses to
        -- the other side of the body, and the flipper lunges after something it
        -- cannot reach — measured at 1.5 radians in a single frame, on a limb
        -- that was supposed to be letting go. Frozen against the body it simply
        -- stays where it was and fades.
        local p = self.puppet
        local want: number
        if self.finPick[side] ~= 0 then
            want = wrapPi(math.atan2(self.finAimX[side] - p.x, -(self.finAimY[side] - p.y)) - p.outHeading)
            self.finWant[side] = want
        else
            want = self.finWant[side]
        end
        -- THE DEAL SWIPE: a flick across the deck as the card comes off it, on
        -- the flipper that is pointing there and no other. The offset is in the
        -- BODY's frame, which is the screen's here — the deck pose is authored
        -- nose-up — so react.luau's -1 to +1 reads left to right.
        if self.swipeT >= 0 and self.finPick[side] == DECK_PICK then
            want += REACT.swipe(self.swipeT / math.max(0.05, T.swipeTime)) * T.swipeArc
        end
        aimFin(self, chain, tip, want, self.finOn[side])
        for i = 1, #chain do
            Mat4.multiply(self.boneSkin[chain[i]], self.boneWorld[chain[i]], self.boneIbm[chain[i]])
        end
        Mat4.multiply(self.boneSkin[tip], self.boneWorld[tip], self.boneIbm[tip])
    end
end

-- Pose the skeleton: the blended clips, the wag, the jaw, and the neck bent
-- toward the look target.
local function poseSeal(self: Table)
    local data = self.sealData
    if data == nil then
        return
    end
    local p = self.puppet
    PUPPET.buildLocals(p, data, self.clips, BONES, self.boneLocal, self.boneParent, self.boneAnim)
    local yaw, pitch = self.gazeYaw, self.gazePitch
    local wag = T.wagAmp * math.min(1, p.clipSpeed / math.max(0.1, T.moveThreshold))
    for b = 1, BONES do
        local localM = self.boneAnim[b]
        for n, slot in ipairs(self.neckSlots) do
            if slot == b then
                local share = NECK_SHARE[n] * T.gazeShare
                -- Measured at bind pose: a neck bone's Y runs along the neck
                -- toward the nose, X is sideways (world x) and Z points DOWN.
                -- A turn of the head is about local Z, negated; a nod about X.
                local m = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationZ(-yaw * share))
                localM = Mat4.multiply(Mat4.identity(), m, Mat4.fromRotationX(pitch * share))
            end
        end
        for n, slot in ipairs(TAIL) do
            if slot == b then
                local a = math.sin(p.time * T.wagSpeed - n * 0.8) * wag * TAIL_GAIN[n]
                localM = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationZ(a))
            end
        end
        if b == MOUTH then
            localM = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationX(p.jaw * T.jawOpen))
        end
        -- THE CLAP: the shoulders swing out about their Z and up about their
        -- X, mirrored, and at 1.4 radians of each the flippers meet over the
        -- back (measured on the rig: the probe in the notes). `clap` scales
        -- both, so the flippers travel the same arc in and out.
        if p.clap > 0 and (b == SHOULDER_L or b == SHOULDER_R) then
            local side = if b == SHOULDER_L then 1 else -1
            local a = T.clapRaise * p.clap
            local m = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationZ(side * a))
            localM = Mat4.multiply(Mat4.identity(), m, Mat4.fromRotationX(a))
        end
        local parent = self.boneParent[b]
        if parent > 0 then
            Mat4.multiply(self.boneWorld[b], self.boneWorld[parent], localM)
        else
            self.boneWorld[b] = localM
        end
        Mat4.multiply(self.boneSkin[b], self.boneWorld[b], self.boneIbm[b])
    end
    -- The flippers last: the aim is measured off the posed limb, so it has to
    -- see what the clips did with it first.
    aimFins(self)
end

-- The seal's model matrix: an orthographic window onto the artboard in px,
-- like the game's puppet — the seal's world IS the screen. The figure is
-- 2.125 units long at bind pose (tools/sealitaire-mesh.mjs), nose at +z,
-- back at +y, centred near the origin. Seen from above: back to the viewer,
-- nose up the screen at heading 0, then the heading about the screen
-- normal and the bank about the spine. The release brings it toward the
-- viewer: bigger, nose pitched at the camera.
local function sealModel(self: Table): Mat4
    local p = self.puppet
    local L = T.sealLength * self.L.sealRef
    local px = L / 2.125
    -- The lift is the reaction's (a plain release no longer rises); its
    -- somersault is a pitch about the body's own sideways axis.
    local lift = math.min(1, p.lift + p.reactLift)
    local grow = px * (1 + lift * T.releaseLift)
    return Mat4.fromTranslation(p.x, p.y, lift * 300)
        * Mat4.fromRotationZ(p.outHeading)
        * Mat4.fromRotationY(p.outRoll)
        * Mat4.fromRotationX(math.rad(90) - p.lift * 1.1 + p.outPitch)
        * Mat4.fromScale(grow, grow, grow)
        * Mat4.fromTranslation(0.02, -0.16, 0.04)
end

-- Where the mouth is on screen for the CURRENT pose, relative to the
-- centre: a point `mouthReach` along the head bone's Y (toward the nose), a
-- touch below it, through the model. Needs poseSeal to have run.
local function measureMouth(self: Table)
    if not self.sealReady then
        return
    end
    local p = self.puppet
    local model = sealModel(self)
    local head = self.boneWorld[9]
    local mp = head:transformPoint(0, T.mouthReach, 0.04)
    local ms = model:transformPoint(mp.x, mp.y, mp.z)
    self.mouthDx, self.mouthDy = ms.x - p.x, ms.y - p.y
end

-- THE SEAL'S BUBBLES — the geometry half. Everything past the sources is
-- bubbles.luau's: this measures where the animal's skin is and how fast it is
-- going, and hands that over. The seam is thin on purpose (see BUB.frame).
local function updateBubbles(self: Table, dt: number)
    if not self.sealReady or dt <= 0 then
        return
    end
    local sys = self.bub
    local p = self.puppet
    local g = self.L
    local L: number = T.sealLength * g.sealRef
    local model = sealModel(self)
    -- Bind units to screen px, measured off the model matrix rather than
    -- rebuilt from sealLength: the release lift scales the whole seal up, and a
    -- second copy of that sum would be a second thing to keep in step.
    local o0 = model:transformPoint(0, 0, 0)
    local o1 = model:transformPoint(1, 0, 0)
    local pxUnit: number = math.sqrt((o1.x - o0.x) * (o1.x - o0.x) + (o1.y - o0.y) * (o1.y - o0.y))

    -- A part cannot move further than this in a second. A resize, a deal, or
    -- the bite snapping the body onto a card corner all move the seal without
    -- it ever swimming, and with no ceiling the frame after one of those reads
    -- as the fastest motion of the whole run and empties the pool into it.
    local cap: number = L * 14
    local bones = self.shedBones
    for i = 1, #bones do
        local at: number = i * 3
        local mp = self.boneSkin[bones[i]]:transformPoint(self.shedBind[at - 2], self.shedBind[at - 1], self.shedBind[at])
        local sp = model:transformPoint(mp.x, mp.y, mp.z)
        local vx: number = 0
        local vy: number = 0
        if self.shedWarm then
            vx = clamp((sp.x - self.shedLastX[i]) / dt, -cap, cap)
            vy = clamp((sp.y - self.shedLastY[i]) / dt, -cap, cap)
        end
        self.shedLastX[i] = sp.x
        self.shedLastY[i] = sp.y
        local src = shedSrc[i]
        src.x = sp.x
        src.y = sp.y
        src.vx = vx
        src.vy = vy
        src.r = self.shedSpread[i] * pxUnit
    end
    self.shedWarm = true

    -- The two breath points, measured off the baked mesh rather than guessed:
    -- the jaw's own front edge is 0.13 along the mouth bone's local Y, and the
    -- nostrils 0.33 along the HEAD's with a little lift (-Z is up from the
    -- head). The nose rides the head and the mouth rides the jaw, so a bark
    -- opens one of them and not the other.
    local jaw = self.boneWorld[MOUTH]:transformPoint(0, 0.13, 0)
    local nose = self.boneWorld[9]:transformPoint(0, 0.33, -0.015)
    local jawS = model:transformPoint(jaw.x, jaw.y, jaw.z)
    local noseS = model:transformPoint(nose.x, nose.y, nose.z)

    -- An open jaw lets more out, and so does moving.
    local rate: number = T.breathRate * (1 + p.jaw * 1.6 + math.min(2, p.speed / math.max(0.1, T.moveThreshold)) * 0.35)
    -- A REACTION BEGINNING: the whoop of bubbles, and the seal's voice.
    --
    -- On `reactT` leaving -1, not on `reactSeq` changing, and the two are not
    -- the same moment. A new seq is the TABLE deciding a play deserves a
    -- reaction; the puppet then holds it pending until the body has reached the
    -- stage, or waited 0.9s for it (puppet.luau's `reaction`). Announcing the
    -- seq fired both of these while the animal was still swimming over, a beat
    -- or more before anything happened.
    --
    -- The voice is `react` + the variant's own name, capitalised — reactSpin,
    -- reactBarrel and the rest, one row each in sfxEvents.csv, whose takes are
    -- the seal recordings put under the water by sfxFx.csv. Built from the name
    -- rather than kept in a second table beside react.luau's roster: that table
    -- would be the thing that goes stale when a variant is added, and playSfx
    -- names a missing row on the console rather than failing quietly.
    local burst: number = 0
    if p.reactT >= 0 and p.reactSeq ~= self.bubSeq then
        self.bubSeq = p.reactSeq
        burst = T.burstPlay
        local nm = p.reactName
        if nm ~= '' then
            playSfx(self, `react{nm:sub(1, 1):upper()}{nm:sub(2)}`)
        end
    end
    -- The water's own sideways breathing, so a column of bubbles is not a ruler.
    local drift: number = math.sin(self.time * 0.31) * 6 * g.fit
    BUB.frame(sys, shedSrc, T, dt, self.time, g.fit, L,
        jawS.x, jawS.y, noseS.x, noseS.y, p.vx, p.vy, rate, burst, drift)
end

-- The cards with a play on them, deduped: what the flippers point at. Re-read
-- only when the game has actually moved, because `moves` is the whole of the
-- invalidation — a column only ever flips inside a move, and a draw bumps it
-- too. The game table is compared as well, since a fresh deal starts back at
-- move 0 and would otherwise keep the last deal's list.
local function refreshPlays(self: Table)
    if self.playsGame == self.game and self.playsMoves == self.game.moves then
        return
    end
    self.playsGame = self.game
    self.playsMoves = self.game.moves
    local seen: { [number]: boolean } = {}
    local out: { number } = {}
    for _, play in ipairs(K.plays(self.game)) do
        if not seen[play.card.id] then
            seen[play.card.id] = true
            table.insert(out, play.card.id)
        end
    end
    self.playCards = out
end

-- THE FINS' AIM — a flipper per side of the body, each pointing at the nearest
-- card on its own side that has a play on it (klondike's M.plays).
--
-- Bearings are taken from the body's CENTRE. The shoulders sit on the spine, at
-- model x = +-0.036 of a 2.125-unit body, so the bearing from the centre is the
-- bearing from the shoulder to well under a degree, and there is nothing to
-- correct. (The body's roll tilts the swing plane away from the screen; the
-- gaze ignores that too, and at these angles so can a gesture.)
--
-- WHAT IS SMOOTHED IS THE POINT, NOT THE ANGLE, and that is the whole of the
-- design. An angle from the seal to a card is made of three moving things: the
-- card, the seal's position, and the seal's heading. Only the first is a change
-- of intention; the other two are the seal going about its business, and the
-- limb is carried through both of them for free by the body it hangs off. Spring
-- the ANGLE and the flipper spends itself chasing its own body: measured, it lay
-- half a radian behind while the seal turned and a third of one while it swam,
-- worst exactly when the seal is sweeping round to a card and you are most
-- looking at it. So the spring carries a screen POINT from one card to the next,
-- aimFins takes the bearing off it live, and the seal can swim and spin under an
-- aim that stays nailed to the card.
--
-- The SIDE is the body's, because which shoulder can reach a card is a fact
-- about the body: positive body-relative bearing is model +x, the FIN_L chain,
-- whatever that looks like on screen.
--
-- Both choices are STICKY, because "the nearest card on this side" is not a
-- stable thing to be. Under a seal crossing the table the nearest play changed
-- hands nine times in twelve seconds, sometimes for a single frame, and every
-- change threw the whole limb across the table and back. So a card holds its
-- flipper until another is a clear fifth nearer, and holds its SIDE until it is
-- a good margin past the nose.
-- [1] radians past the nose before a card changes hands; [2] squared, so a
-- rival must be a fifth nearer to take a flipper off the card that has it.
local FIN_STICK = { 0.18, 0.64 }
local function updateFins(self: Table, dt: number)
    refreshPlays(self)
    local p = self.puppet
    local g = self.L
    local pick = self.finPick
    local bestDist = { math.huge, math.huge }
    local bestId = { 0, 0 }
    local bestX, bestY = { 0, 0 }, { 0, 0 }
    local heldDist = { math.huge, math.huge }
    local heldX, heldY = { 0, 0 }, { 0, 0 }
    local held: { [number]: boolean } = {}
    if self.drag ~= nil then
        for _, c in ipairs(self.drag.cards) do
            held[c.id] = true
        end
    end
    for _, id in ipairs(self.playCards) do
        if not held[id] then
            local v = self.views[id]
            local dx, dy = v.x - p.x, v.y - p.y
            local rel = wrapPi(math.atan2(dx, -dy) - p.outHeading)
            local side = if rel >= 0 then 1 else 2
            if id == pick[1] and rel >= -FIN_STICK[1] then
                side = 1
            elseif id == pick[2] and rel <= FIN_STICK[1] then
                side = 2
            end
            local d = dx * dx + dy * dy
            if d < bestDist[side] then
                bestDist[side], bestId[side] = d, id
                bestX[side], bestY[side] = v.x, v.y
            end
            if id == pick[side] then
                heldDist[side] = d
                heldX[side], heldY[side] = v.x, v.y
            end
        end
    end
    -- THE DECK OUTRANKS A CARD. While the pointer is on it, the flipper on its
    -- side points there: it is what the player is about to do, and a fin still
    -- indicating some play across the table while the hand is on the deck is
    -- pointing at the wrong thing. `heldDist` is cleared so the stickiness that
    -- keeps a card cannot out-stay it.
    if self.stockHovered and self.drag == nil then
        local sx, sy = pileOrigin(g, self.game.stock)
        local dx: number = sx - p.x
        local dy: number = sy - p.y
        local side: number = if wrapPi(math.atan2(dx, -dy) - p.outHeading) >= 0 then 1 else 2
        bestDist[side] = dx * dx + dy * dy
        bestId[side] = DECK_PICK
        bestX[side] = sx
        bestY[side] = sy
        heldDist[side] = math.huge
    end

    -- The clap owns both shoulders while it runs (react.luau); the aim stands
    -- down for it rather than fighting it for the same bones.
    local room = 1 - math.min(1, p.clap)
    -- `finEase` is the spring's frequency in rad/s, damped just under critical
    -- so the flipper arrives with a touch of follow-through.
    local k, damp = T.finEase * T.finEase, T.finEase * 1.8
    for side = 1, 2 do
        -- The card a flipper is already on keeps it unless a rival is clearly
        -- nearer.
        if heldDist[side] < math.huge and bestDist[side] > heldDist[side] * FIN_STICK[2] then
            bestDist[side], bestId[side] = heldDist[side], pick[side]
            bestX[side], bestY[side] = heldX[side], heldY[side]
        end
        pick[side] = bestId[side]
        local found = bestDist[side] < math.huge
        if found then
            if self.finOn[side] < 0.02 then
                -- Coming up from nothing: start ON the card. Springing in from
                -- wherever the last one was would be a sweep across the table
                -- that means nothing.
                self.finAimX[side], self.finAimY[side] = bestX[side], bestY[side]
                self.finAimVX[side], self.finAimVY[side] = 0, 0
            else
                self.finAimX[side], self.finAimVX[side] = spring(self.finAimX[side], self.finAimVX[side], bestX[side], dt, k, damp)
                self.finAimY[side], self.finAimVY[side] = spring(self.finAimY[side], self.finAimVY[side], bestY[side], dt, k, damp)
            end
        end
        -- The point is only chased while there is something to chase: with the
        -- weight falling away on its own, a flipper lets go of the last card
        -- where it left it rather than sweeping back through the body to a
        -- neutral it never had.
        local on = if found then T.finAim * room else 0
        self.finOn[side], self.finOnV[side] = spring(self.finOn[side], self.finOnV[side], on, dt, k, damp)
    end
end

-- The frame the puppet is handed, then its look turned into the neck's aim.
local function updateSwim(self: Table, dt: number)
    local g = self.L
    local L = T.sealLength * g.sealRef
    local focus = 0
    if self.drag ~= nil then
        focus = self.drag.cards[1].id
    elseif self.hovered ~= 0 then
        focus = self.hovered
    end
    local card: PUPPET.Vec? = nil
    if focus ~= 0 then
        local v = self.views[focus]
        card = { x = v.x, y = v.y }
    end
    local cursor: PUPPET.Vec? = nil
    if self.pointerKnown then
        cursor = { x = self.pointer.x, y = self.pointer.y }
    end
    local corner: PUPPET.Vec? = nil
    local mouthDx, mouthDy = self.mouthDx, self.mouthDy
    if self.bitten ~= 0 then
        local v = self.views[self.bitten]
        -- The card's bottom corner, on the side the seal came from, in the
        -- card's own rotation.
        local cx, cy = self.biteSide * g.cw / 2 * v.scale, g.ch / 2 * v.scale
        local c, sn = math.cos(v.rot), math.sin(v.rot)
        corner = { x = v.x + cx * c - cy * sn, y = v.y + cx * sn + cy * c }
    end
    if self.releaseT >= 0 then
        self.releaseT += dt
        if self.releaseT > T.releaseTime + 0.5 then
            self.releaseT = -1
        end
    end
    if self.swipeT >= 0 then
        self.swipeT += dt
        if self.swipeT > T.swipeTime then
            self.swipeT = -1
        end
    end
    -- THE STAGE: the open water under the columns, between the lowest card
    -- on the table and the foot strip, biased toward the middle of the
    -- screen and toward where the seal already is. A reaction happens here
    -- rather than over the cards it just played.
    local colBottom = g.tabY + g.ch * 0.5
    for _, pile in ipairs(K.piles(self.game)) do
        if pile.kind == 'tableau' then
            local last = pile.cards[#pile.cards]
            if last ~= nil then
                colBottom = math.max(colBottom, self.views[last.id].ty + g.ch * 0.5)
            end
        end
    end
    local footTop = g.title.y
    local stageY = clamp((colBottom + footTop) * 0.5, colBottom + L * 0.55, math.max(colBottom + L * 0.55, footTop - L * 0.45))
    local stageX = clamp(self.puppet.x * 0.5 + g.w * 0.25, g.w * 0.22, g.w * 0.78)
    -- Deliberately NOT annotated `PUPPET.Frame`. Naming that record here is
    -- what finally tipped this module past Luau's type-inference budget (see
    -- FIN_CHAINS and `bub`), and the annotation buys nothing: the literal goes
    -- straight into PUPPET.update, whose parameter IS `Frame`, so the shape is
    -- still checked — at the call rather than at the assignment.
    -- Optional-typed like `card` and `cursor` above, because without the
    -- annotation on the literal below Luau matches these fields exactly and a
    -- plain point is not a `Vec?`.
    local stage: PUPPET.Vec? = { x = stageX, y = stageY }
    local frame = {
        w = g.w, h = g.h, L = L,
        -- px per game unit: the game's seal is 1.68 units long at the same
        -- freeHeight, so its thrust and top speed scale by this.
        pxUnit = L / 1.68,
        row = { x = g.w * 0.5, y = g.tabY + g.ch * 0.5 },
        stage = stage,
        reactSeq = self.reactSeq, reactVariant = self.reactVariant, reactSpeed = T.reactSpeed,
        card = card,
        cursor = cursor,
        corner = corner,
        mouthDx = mouthDx, mouthDy = mouthDy,
        biting = self.bitten ~= 0,
        releaseT = self.releaseT,
        dragging = self.drag ~= nil,
        won = self.game.won,
        thrust = T.thrust, friction = T.friction, maxSpeed = T.maxSpeed, turnLerp = T.turnLerp, steer = T.steer,
        landEase = T.landEase, lean = T.lean,
        arrive = T.arrive, blendRate = T.blendRate, blendTime = T.blendTime, turnSettle = T.turnSettle,
        moveThreshold = T.moveThreshold, boostThreshold = T.boostThreshold, crossfade = T.crossfade,
        clipScale = T.clipScale,
        bobAmp = 0.035, bobPeriod = 2.8,
        biteOffset = T.biteOffset, biteHold = T.biteHold, jawClamp = T.jawClamp,
        releaseTime = T.releaseTime, releaseLift = T.releaseLift, releasePush = T.releasePush,
        steerTight = T.steerTight,
    }
    local p = self.puppet
    PUPPET.update(p, dt, frame)
    updateFins(self, dt)

    -- Pose now (not at draw: a headless run draws once, and the live one a
    -- frame late), measure the mouth, and while the bite holds put the body
    -- EXACTLY where the mouth is on the corner — the jaw cannot come off the
    -- card, whatever the hand does.
    if self.sealReady then
        poseSeal(self)
        measureMouth(self)
        if p.held and corner ~= nil then
            local depth = T.biteOffset * L
            local tx: number = corner.x - self.mouthDx + math.sin(p.outHeading) * depth
            local ty: number = corner.y - self.mouthDy - math.cos(p.outHeading) * depth
            -- THE TAKE IS A BLEND, NOT A CUT. The bite decides it has arrived
            -- off the BLENDED landing point — partway between the hover pose's
            -- and the corner's while the two states are still crossfading — and
            -- then this clamp puts the mouth exactly on the corner. Those are
            -- two different places, and the body used to cover the difference
            -- in a single frame: measured at 124px, a third of a body length,
            -- as a pop on every bite.
            --
            -- So the gap is remembered at the moment it takes and eased away
            -- over `biteBlend`. Nothing is given up by doing it: the clamp is
            -- still exactly the clamp once the ease is out, which is what keeps
            -- the jaw on the card however the hand moves.
            if self.biteEase < 0 then
                self.biteEase = 1
                self.biteOffX = p.x - tx
                self.biteOffY = p.y - ty
            else
                self.biteEase = math.max(0, self.biteEase - dt / math.max(1e-3, T.biteBlend))
            end
            -- Eased at both ends, so the body neither jerks away from the pose
            -- it had nor arrives at the corner still moving.
            local e: number = self.biteEase
            e = e * e * (3 - 2 * e)
            p.x = tx + self.biteOffX * e
            p.y = ty + self.biteOffY * e
            p.land = { x = p.x, y = p.y }
        else
            self.biteEase = -1
        end
    end
    -- After the bite clamp: the body is not where it will be drawn until that
    -- has run, and a bubble born at the pre-clamp position is born off the seal.
    updateBubbles(self, dt)

    -- The look, relative to the body's heading; `out` lifts the head toward
    -- the viewer.
    if p.lookOn then
        local ax = math.atan2(p.look.x - p.x, -(p.look.y - p.y))
        local rel = ax - p.outHeading
        while rel > math.pi do rel -= math.pi * 2 end
        while rel < -math.pi do rel += math.pi * 2 end
        self.gazeTargetYaw = clamp(rel, -1.1, 1.1)
        self.gazeTargetPitch = -p.lookOut * 0.35
    else
        self.gazeTargetYaw = 0
        self.gazeTargetPitch = 0
    end
    self.gazeYaw, self.gazeVYaw = spring(self.gazeYaw, self.gazeVYaw, self.gazeTargetYaw, dt, 60, 11)
    self.gazePitch, self.gazeVPitch = spring(self.gazePitch, self.gazeVPitch, self.gazeTargetPitch, dt, 60, 11)
end

-- ---------------------------------------------------------------------------
-- The fish: fish.mesh (tools/sealitaire-fish.mjs), drawn instanced.
-- ---------------------------------------------------------------------------
-- A csv line into cells, honouring quotes (the notes column has commas).
local function csvCells(line: string): { string }
    local cells = {}
    local cell = ''
    local q = false
    local i = 1
    while i <= #line do
        local c = line:sub(i, i)
        if q then
            if c == '"' then
                if line:sub(i + 1, i + 1) == '"' then
                    cell ..= '"'
                    i += 1
                else
                    q = false
                end
            else
                cell ..= c
            end
        elseif c == '"' then
            q = true
        elseif c == ',' then
            table.insert(cells, cell)
            cell = ''
        elseif c ~= '\r' then
            cell ..= c
        end
        i += 1
    end
    table.insert(cells, cell)
    return cells
end

local function hexRgb(h: string): { number }
    local x = h:gsub('^#', '')
    if #x ~= 6 then
        return { 0.5, 0.5, 0.5 }
    end
    return { (tonumber(x:sub(1, 2), 16) or 128) / 255, (tonumber(x:sub(3, 4), 16) or 128) / 255, (tonumber(x:sub(5, 6), 16) or 128) / 255 }
end

-- tanks.csv: which cards are tanks and what they hold. Read at runtime so a
-- count, a size or a colour is live under the watcher; a `model` the pack
-- has not baked is reported and the card stays a plain pip card.
-- sfxEvents.csv into self.sfx. Read at runtime so a recast is live under
-- the watcher; a take that is not in the bank is reported and skipped.
-- sfx.csv into self.sfxBank: the ids, in bank order, which is what J/K/L
-- walks. Only the id column is wanted — seconds and chans are the baker's
-- record, not the script's.
local function loadSfxBank(self: Table, context: Context)
    local blob = context:blob('sfxBank')
    if blob == nil then
        print('sealitaire: sfx.csv missing; J/K/L cannot audition')
        return
    end
    local text = buffer.tostring(blob.data)
    local head = true
    for line in text:gmatch('[^\n]+') do
        if head then
            head = false
        else
            local id = csvCells(line)[1]
            if id ~= nil and id ~= '' then
                table.insert(self.sfxBank, id)
            end
        end
    end
end

local function loadSfxEvents(self: Table, context: Context)
    local blob = context:blob('sfxEvents')
    if blob == nil then
        print('sealitaire: sfxEvents.csv missing; no card sounds')
        return
    end
    local text = buffer.tostring(blob.data)
    local head: { string }? = nil
    local col: { [string]: number } = {}
    for line in text:gmatch('[^\n]+') do
        local cells = csvCells(line)
        if head == nil then
            head = cells
            for k, name in ipairs(cells) do
                col[name] = k
            end
        else
            local function cell(name: string): string
                local k = col[name]
                return if k ~= nil then (cells[k] or '') else ''
            end
            local event = cell('event')
            if event ~= '' then
                local takes = {}
                for take in cell('takes'):gmatch('[^|]+') do
                    local id: string = take:match('^%s*(.-)%s*$') or ''
                    if id ~= '' then
                        if context:audio(id) ~= nil then
                            table.insert(takes, id)
                        else
                            print(`sealitaire: sfxEvents.csv: {event}: "{id}" is not in the bank`)
                        end
                    end
                end
                self.sfx[event] = {
                    takes = takes,
                    gain = tonumber(cell('gain')) or 1,
                    delay = tonumber(cell('delay')) or 0,
                    minGap = tonumber(cell('minGap')) or 0,
                    lastAt = -1000,
                }
            end
        end
    end
end

local function loadTankTable(self: Table, context: Context)
    local blob = context:blob('tanks')
    if blob == nil then
        print('sealitaire: tanks.csv missing; no tanks')
        return
    end
    local text = buffer.tostring(blob.data)
    local head: { string }? = nil
    local col: { [string]: number } = {}
    for line in text:gmatch('[^\n]+') do
        local cells = csvCells(line)
        if head == nil then
            head = cells
            for k, name in ipairs(cells) do
                col[name] = k
            end
        else
            local function cell(name: string): string
                local k = col[name]
                return if k ~= nil then (cells[k] or '') else ''
            end
            local card = cell('card')
            local model = cell('model')
            if card ~= '' and model ~= '' then
                local rankText, suitName = card:match('^(%S+)%s+(%S+)$')
                local rank, suit = 0, 0
                for r, t in ipairs(K.RANK_TEXT) do
                    if t == rankText then
                        rank = r
                    end
                end
                for sIdx, name in ipairs(SUIT_NAMES) do
                    if name == suitName then
                        suit = sIdx
                    end
                end
                local sp = self.species[model]
                if rank == 0 or suit == 0 then
                    print(`sealitaire: tanks.csv: card "{card}" is not a rank and a suit`)
                elseif sp == nil then
                    print(`sealitaire: tanks.csv: {card}: model "{model}" is not in fish.mesh; run npm run sealitaire:fish`)
                else
                    local id = (suit - 1) * 13 + rank
                    self.tankOf[id] = {
                        species = sp,
                        rank = rank,
                        count = math.max(1, math.min(16, tonumber(cell('count')) or 1)),
                        size = tonumber(cell('size')) or 1,
                        back = hexRgb(cell('back')),
                        belly = hexRgb(cell('belly')),
                        -- The tank's background. Blank falls back to the suit
                        -- family's, not to hexRgb's grey: a row with no colour
                        -- should still read as the red suit or the black one.
                        bg = if cell('bg') ~= '' then hexRgb(cell('bg')) else (if K.isRed(suit) then SUIT_BG_RED else SUIT_BG_BLACK),
                        knock = cell('knock'),
                        colGap = tonumber(cell('colGap')), rowGap = tonumber(cell('rowGap')),
                        padX = tonumber(cell('padX')), padY = tonumber(cell('padY')),
                        drop = tonumber(cell('drop')), rotate = tonumber(cell('rotate')), rotateVary = tonumber(cell('rotateVary')),
                        yaw = tonumber(cell('yaw')), roll = tonumber(cell('roll')), sway = tonumber(cell('sway')),
                        loop = tonumber(cell('loop')),
                        bio = tonumber(cell('bio')) or 0,
                        -- The game's bioluminescence colour when the cell is blank.
                        bioColor = if cell('bioColor') ~= '' then hexRgb(cell('bioColor')) else { 0.4, 1.0, 0.878 },
                        bioSpeed = tonumber(cell('bioSpeed')), bioScale = tonumber(cell('bioScale')), bioContrast = tonumber(cell('bioContrast')),
                        bioCoverage = tonumber(cell('bioCoverage')), bioPan = tonumber(cell('bioPan')), bioEvolve = tonumber(cell('bioEvolve')),
                    }
                    -- The row as the file had it, for RESET.
                    self.tankOrig[id] = copyTank(self.tankOf[id])
                end
            end
        end
    end
    -- The pool the model row walks: every species but the bubble, by name.
    table.clear(self.pool)
    for _, sp in ipairs(self.speciesList) do
        if sp.name ~= BUBBLE_SPECIES then
            table.insert(self.pool, sp)
        end
    end
    table.sort(self.pool, function(a: Species, b: Species): boolean
        return a.name < b.name
    end)
    SUBJECT_ROWS[1].max = math.max(1, #self.pool)
    -- The sheet's override: one species on every card, before the caps are
    -- summed so its buffer holds the whole table. Read again here: the tank
    -- table loads from resize, and the view model may have arrived since.
    local vm = context:viewModel()
    local labProp = if vm ~= nil then vm:getString('lab') else nil
    if labProp ~= nil and labProp.value ~= '' then
        self.lab = labProp.value
    end
    if self.lab ~= '' then
        print(`sealitaire: lab "{self.lab}" on every card, seed {LAB_SEED}`)
        -- The deal so far ran on a fresh seed; a sheet frame wants the
        -- same seven faces for every species.
        if self.dealSeed ~= LAB_SEED then
            deal(self, LAB_SEED)
        end
        local sp = self.species[self.lab]
        if sp == nil then
            print(`sealitaire: lab: "{self.lab}" is not in fish.mesh (run npm run sealitaire:pool)`)
        else
            for _, rec in pairs(self.tankOf) do
                rec.species = sp
            end
        end
    end
    for _, rec in pairs(self.tankOf) do
        rec.species.cap += rec.count
    end
    for _, sp in ipairs(self.speciesList) do
        -- The bubbles are not in tanks.csv, so the loop above counted none of
        -- them. They are shared by every tank on screen at once, so the cap is
        -- per SLOT rather than per card: a screen of rattling tanks is the
        -- case that has to fit, and the one that overflows a per-card guess.
        if sp.name == BUBBLE_SPECIES then
            sp.cap = TANK_SLOTS * BUBBLES_PER_TANK
        end
        sp.cap = math.max(1, sp.cap)
        sp.bytes = buffer.create(sp.cap * BAIT.STRIDE)
        sp.inst = GPUBuffer.new({ size = sp.cap * BAIT.STRIDE, usage = 'vertex', label = `tank {sp.name}` })
    end
    self.bubbleSpecies = nil
    for _, sp in ipairs(self.speciesList) do
        if sp.name == BUBBLE_SPECIES then
            self.bubbleSpecies = sp
        end
    end
    if self.bubbleSpecies == nil then
        print(`sealitaire: no "{BUBBLE_SPECIES}" in fish.mesh; tanks will knock silently and show nothing (run npm run sealitaire:fish)`)
    end
end

-- The tank pack: fish.mesh (tools/sealitaire-fish.mjs), every species in
-- one vertex list, drawn instanced a species at a time.
local function loadFish(self: Table, context: Context): boolean
    local blob = context:blob('fish')
    local shader = context:shader('fish')
    if blob == nil or shader == nil then
        print('sealitaire: fish.mesh or fish.wgsl missing; no tanks')
        return false
    end
    local data = blob.data
    -- TNK3 adds the rig: a bones block and a chains block between the
    -- indices and the palette, and sixteen more bytes on each species
    -- record. A TNK2 pack still loads and simply has neither, so a bake
    -- from before rigs.csv is not a broken game.
    local magic = buffer.readstring(data, 0, 4)
    if magic ~= 'TNK2' and magic ~= 'TNK3' then
        print('sealitaire: fish.mesh is not a tank pack (TNK2 or TNK3); run npm run sealitaire:fish')
        return false
    end
    local v3 = magic == 'TNK3'
    local nspecies = buffer.readu32(data, 4)
    local vcount = buffer.readu32(data, 8)
    local icount = buffer.readu32(data, 12)
    local pfloats = buffer.readu32(data, 16)
    local bcount = if v3 then buffer.readu32(data, 20) else 0
    local cwords = if v3 then buffer.readu32(data, 24) else 0
    local HEAD, VSTRIDE, BREC = 32, 32, 16
    local REC = if v3 then 80 else 64
    local recs = HEAD + nspecies * REC
    local vbytes = vcount * VSTRIDE
    local ibytes = icount * 4
    local vbuf = buffer.create(vbytes)
    buffer.copy(vbuf, 0, data, recs, vbytes)
    local ibuf = buffer.create(ibytes)
    buffer.copy(ibuf, 0, data, recs + vbytes, ibytes)
    local boneStart = recs + vbytes + ibytes
    local chainStart = boneStart + bcount * BREC
    local palStart = chainStart + cwords * 4
    for k = 0, nspecies - 1 do
        local r = HEAD + k * REC
        local name = buffer.readstring(data, r, 24):gsub('%z.*$', '')
        local sp: Species = {
            name = name,
            firstIndex = buffer.readu32(data, r + 32), indexCount = buffer.readu32(data, r + 36),
            inst = nil, bytes = buffer.create(0), cap = 0, n = 0, at = 0,
            bones = buffer.readu32(data, r + 48), frames = buffer.readu32(data, r + 52), duration = buffer.readf32(data, r + 56),
            palette = nil, bind = nil, bend = nil, bendBytes = buffer.create(0), bendRows = 0,
            boneParent = {}, chains = {}, bendLive = {}, bendDirty = false, bendOrder = {},
        }
        -- THE PALETTE: the species' clip as a float texture, three texels a
        -- bone (the rows of its 3x4) and a row per frame, uploaded once. A
        -- still species is one identity bone in one row — the same read.
        local po = buffer.readu32(data, r + 60)
        local pbytes = sp.bones * sp.frames * 48
        if po * 4 + pbytes <= pfloats * 4 and sp.bones > 0 and sp.frames > 0 then
            local pbuf = buffer.create(pbytes)
            buffer.copy(pbuf, 0, data, palStart + po * 4, pbytes)
            local ok, tex = pcall(function()
                local t = GPUTexture.new({ width = sp.bones * 3, height = sp.frames, format = 'rgba32float', label = `tank clip {name}` })
                t:upload({ data = pbuf })
                return t
            end)
            if ok then
                sp.palette = tex
            else
                print(`sealitaire: {name}: clip palette texture failed ({tex}); drawn at rest`)
            end
        end
        if v3 and sp.bones > 0 then
            RIG.loadRig(sp, data, r, boneStart, chainStart, BREC)
        end
        self.species[name] = sp
        table.insert(self.speciesList, sp)
    end
    self.fishVerts = GPUBuffer.new({ size = vbytes, usage = 'vertex', data = vbuf, immutable = true, label = 'tank verts' })
    self.fishIndex = GPUBuffer.new({ size = ibytes, usage = 'index', data = ibuf, immutable = true, label = 'tank index' })
    self.fishIndexCount = icount
    -- Vertex: position, normal, joints, weights. Instance: the model's four
    -- columns, back, belly, tile, anim, bio, dent (baitball.luau's STRIDE).
    local VERTEX_LAYOUT: VertexBufferLayout = { stride = VSTRIDE, attributes = {
        { format = 'float32x3', slot = 0, offset = 0 }, { format = 'float32x3', slot = 1, offset = 12 },
        { format = 'uint8x4', slot = 2, offset = 24 }, { format = 'unorm8x4', slot = 3, offset = 28 },
    } }
    local INSTANCE_LAYOUT: VertexBufferLayout = { stride = BAIT.STRIDE, stepMode = 'instance', attributes = {
        { format = 'float32x4', slot = 4, offset = 0 },
        { format = 'float32x4', slot = 5, offset = 16 },
        { format = 'float32x4', slot = 6, offset = 32 },
        { format = 'float32x4', slot = 7, offset = 48 },
        { format = 'float32x4', slot = 8, offset = 64 },
        { format = 'float32x4', slot = 9, offset = 80 },
        { format = 'float32x4', slot = 10, offset = 96 },
        { format = 'float32x4', slot = 11, offset = 112 },
        { format = 'float32x4', slot = 12, offset = 128 },
        { format = 'float32x4', slot = 13, offset = 144 },
        { format = 'float32x4', slot = 14, offset = 160 },
        { format = 'float32x4', slot = 15, offset = 176 },
        { format = 'float32x4', slot = 16, offset = 192 },
    } }
    self.fishPipe = GPUPipeline.new({
        vertex = shader, fragment = shader,
        vertexLayout = { VERTEX_LAYOUT, INSTANCE_LAYOUT },
        colorTargets = { { format = 'rgba8unorm' } },
        depthStencil = { format = 'depth32float', compare = 'less', write = true },
        cullMode = 'none',
        label = 'fish',
    })
    -- The outline: the same shader, the same instance buffer, the same bind
    -- group — a different entry point and FRONT faces culled, so what draws is
    -- the inside of a shell pushed out along the normals. Depth-writing, drawn
    -- before the bodies, which then cover everything but the rim.
    self.fishLinePipe = GPUPipeline.new({
        -- `{ module, entryPoint }` is the form that actually selects one. Bare
        -- `vertex = shader` takes the FIRST @vertex in the file, so the wrong
        -- spelling here does not error — it silently draws the body again
        -- with front faces culled, which looks like a broken outline rather
        -- than like a typo.
        vertex = { module = shader, entryPoint = 'vsLine' },
        fragment = { module = shader, entryPoint = 'fsLine' },
        vertexLayout = { VERTEX_LAYOUT, INSTANCE_LAYOUT },
        colorTargets = { { format = 'rgba8unorm' } },
        depthStencil = { format = 'depth32float', compare = 'less', write = true },
        cullMode = 'front',
        label = 'fish outline',
    })
    self.fishUbo = GPUBuffer.new({ size = FISH_UBO, usage = 'uniform', label = 'fish ubo' })
    -- One bind group per species: the shared uniform and its own palette.
    -- Both pipelines derive the same group 0, so a species' group serves the
    -- outline pass and the body pass alike. `fishBind` stays as the guard
    -- that says the pack is bound at all.
    local layout = (self.fishPipe :: GPUPipeline):getBindGroupLayout(0)
    self.fishBindLayout = layout
    local fallback: GPUTexture? = nil
    for _, sp in ipairs(self.speciesList) do
        if sp.palette == nil then
            -- A palette that failed: one identity bone so the shader still
            -- has a texel to read, and the pose weight is 0 anyway.
            if fallback == nil then
                local pbuf = buffer.create(48)
                buffer.writef32(pbuf, 0, 1); buffer.writef32(pbuf, 20, 1); buffer.writef32(pbuf, 40, 1)
                fallback = GPUTexture.new({ width = 3, height = 1, format = 'rgba32float', label = 'tank clip identity' })
                fallback:upload({ data = pbuf })
            end
            sp.palette = fallback
            sp.frames, sp.duration = 1, 0
        end
        RIG.ensureBend(self, sp)
        sp.bind = GPUBindGroup.new({
            layout = layout,
            ubos = { { slot = 0, buffer = self.fishUbo :: GPUBuffer } },
            textures = { { slot = 1, view = (sp.palette :: GPUTexture):view() }, { slot = 2, view = ((sp.bend or sp.palette) :: GPUTexture):view() } },
        })
    end
    self.fishBind = self.speciesList[1] ~= nil and self.speciesList[1].bind or nil
    loadTankTable(self, context)
    return true
end

-- Is this card a tank on screen: it has a tanks.csv row, face up (or
-- flipping to).
local function isTank(self: Table, id: number): boolean
    if self.tankOf[id] == nil then
        return false
    end
    local v = self.views[id]
    return v.flip > 0.5
end

-- THE HOVER'S RUN. The settled hover names one card; the run under it (that
-- card and every card below it in its pile — what a drag would take) is
-- what pops, the hovered card first and each card below it `popWave` later
-- (hover.luau). Whatever was popped and is no longer in the run is let
-- down the same way. A held run is never popped: the hand has it.
local function hoverPop(self: Table, now: number)
    local run: { number } = {}
    if self.hovered ~= 0 and self.drag == nil then
        local card = self.cardOf[self.hovered]
        if card ~= nil then
            for _, p in ipairs(K.piles(self.game)) do
                for i, c in ipairs(p.cards) do
                    if c.id == card.id then
                        local cards = if p.kind == 'stock' then nil else K.runFrom(p, i)
                        if cards ~= nil then
                            for _, rc in ipairs(cards) do
                                table.insert(run, rc.id)
                            end
                        end
                    end
                end
            end
        end
    end
    local inRun: { [number]: boolean } = {}
    local up: { HOVER.Pop } = {}
    for _, id in ipairs(run) do
        inRun[id] = true
        table.insert(up, self.views[id].pop)
    end
    local down: { HOVER.Pop } = {}
    for _, id in ipairs(self.popped) do
        if not inRun[id] then
            table.insert(down, self.views[id].pop)
        end
    end
    HOVER.arm(up, 1, now, T.popWave)
    HOVER.arm(down, 0, now, T.popWave)
    self.popped = run
end

-- The sim's inputs for a tank card: its row's count, size and colours, the
-- tuner's numbers, and the walls.
local function tankInputs(self: Table, rec: TankRec, hovered: boolean, pressed: boolean, played: boolean, dragging: boolean, velX: number, velY: number, revealed: boolean): BAIT.Inputs
    local sp = rec.species
    return {
        hovered = hovered, pressed = pressed, played = played, dragging = dragging, velX = velX, velY = velY,
        revealed = revealed, enterSpeed = T.entranceSpeed,
        -- The clip: one cycle per its duration, scaled by the tuner. A
        -- species baked at rest has no duration and reads as no clip.
        clipRate = if sp.frames > 1 and sp.duration > 0 then T.clipSpeed / sp.duration else 0,
        clipWeight = T.clipWeight,
        bio = rec.bioColor, bioStrength = rec.bio,
        bioSpeed = if rec.bioSpeed ~= nil then rec.bioSpeed else T.bioSpeed,
        bioScale = if rec.bioScale ~= nil then rec.bioScale else T.bioScale,
        bioContrast = if rec.bioContrast ~= nil then rec.bioContrast else T.bioContrast,
        bioCoverage = if rec.bioCoverage ~= nil then rec.bioCoverage else T.bioCoverage,
        bioPan = math.rad(if rec.bioPan ~= nil then rec.bioPan else T.bioPan),
        bioEvolve = if rec.bioEvolve ~= nil then rec.bioEvolve else T.bioEvolve,
        count = rec.count, size = rec.size * T.fishSize, back = rec.back, belly = rec.belly,
        spin = T.fishSpin, radius = T.fishRadius, exciteSpin = T.fishExcite, scatterPush = T.fishScatter,
        padX = rec.padX or T.fishPadX, padY = rec.padY or T.fishPadY,
        colGap = rec.colGap or T.pipColGap, rowGap = rec.rowGap or T.pipRowGap,
        -- `or` is wrong for a signed override: a row that means 0 would fall
        -- straight back to the tuner's number. These read the cell's presence.
        drop = if rec.drop ~= nil then rec.drop else T.pipDrop,
        rotate = if rec.rotate ~= nil then rec.rotate else T.pipRotate,
        rotateVary = if rec.rotateVary ~= nil then rec.rotateVary else T.pipRotateVary,
        yaw = if rec.yaw ~= nil then rec.yaw else T.pipYaw,
        roll = if rec.roll ~= nil then rec.roll else T.pipRoll,
        sway = if rec.sway ~= nil then rec.sway else T.pipSway,
        -- The court's creature holds still; an ace's apex predator still
        -- loops — unless the row says otherwise (`loop`).
        holds = if rec.loop ~= nil then rec.loop < 0.5 else rec.rank >= 11,
        swirlHold = T.swirlHold, swirlIn = T.swirlIn, swirlOut = T.swirlOut,
        slosh = T.fishSlosh, spring = T.fishSpring, damp = T.fishDamp, bounce = T.fishBounce,
        turn = T.fishTurn, turnMax = math.rad(T.fishTurnMax),
        hitSpeed = T.fishHitSpeed, hitGap = T.fishHitGap,
        dentAmount = T.dentAmount, dentFreq = T.dentFreq, dentDamp = T.dentDamp,
        bubbleCount = T.tankBubbles, bubbleSize = T.tankBubbleSize,
        bubbleRise = T.tankBubbleRise, bubbleLife = T.tankBubbleLife, bubbleSpread = T.tankBubbleSpread,
        loosen = T.rattleLoosen, still = T.rattleStill, settle = T.rattleSettle, friction = T.rattleFriction, gravity = T.rattleGravity, tumble = T.rattleTumble,
        walls = WALLS,
    }
end

-- ---------------------------------------------------------------------------
-- GPU setup: everything that depends on the canvas size.
-- ---------------------------------------------------------------------------
local function buildGpu(self: Table, context: Context, pw: number, ph: number)
    self.scene = context:canvas({ width = pw, height = ph })
    self.water = context:gpuCanvas({ width = pw, height = ph })
    self.screen = context:gpuCanvas({ width = pw, height = ph })
    local water = self.water :: GPUCanvas
    local screen = self.screen :: GPUCanvas

    -- The seal's own canvas, with a depth buffer. Built before the CRT bind
    -- group, which samples it. Views are made once: a view per frame is a
    -- native object churned per frame.
    -- The seal swims the whole screen, so its canvases are the screen's.
    local sw, sh = pw, ph
    self.sealUnderCanvas = context:gpuCanvas({ width = sw, height = sh })
    self.sealOverCanvas = context:gpuCanvas({ width = sw, height = sh })
    self.sealDepth = GPUTexture.new({ width = sw, height = sh, format = 'depth32float', renderTarget = true, label = 'seal depth' })
    self.sealDepthView = (self.sealDepth :: GPUTexture):view()
    local sealUnderCanvas = self.sealUnderCanvas :: GPUCanvas
    local sealOverCanvas = self.sealOverCanvas :: GPUCanvas

    -- One pipeline per water mode, all fed the same uniform buffer: the
    -- shaders share vortex.wgsl's layout so the table drives any of them
    -- alike. A mode whose shader is missing draws the vortex instead.
    self.waterBytes = buffer.create(48 + 16 * 16)
    self.waterUbo = GPUBuffer.new({ size = 48 + 16 * 16, usage = 'uniform', label = 'water ubo' })
    self.waterPipes = {}
    self.waterBinds = {}
    for m, name in ipairs(WATER_MODES) do
        local shader = context:shader(name)
        if shader ~= nil then
            local pipe = GPUPipeline.new({
                vertex = shader, fragment = shader, vertexLayout = {},
                colorTargets = { { format = water.format } }, label = name,
            })
            self.waterPipes[m] = pipe
            self.waterBinds[m] = GPUBindGroup.new({
                layout = pipe:getBindGroupLayout(0),
                ubos = { { slot = 0, buffer = self.waterUbo :: GPUBuffer } },
            })
        else
            print(`sealitaire: {name}.wgsl missing; water mode {m - 1} falls back to the vortex`)
        end
    end

    -- The goo, at half size: three evaluations of the whole field per pixel.
    local gw = math.max(1, math.floor(pw / 2))
    local gh = math.max(1, math.floor(ph / 2))
    self.gooCanvas = context:gpuCanvas({ width = gw, height = gh })
    local gooCanvas = self.gooCanvas :: GPUCanvas
    local gooShader = context:shader('goo')
    if gooShader ~= nil then
        self.gooPipe = GPUPipeline.new({
            vertex = gooShader, fragment = gooShader, vertexLayout = {},
            colorTargets = { { format = gooCanvas.format } }, label = 'goo',
        })
        self.gooBytes = buffer.create(PUDDLE.UBO_SIZE)
        self.gooUbo = GPUBuffer.new({ size = PUDDLE.UBO_SIZE, usage = 'uniform', label = 'goo ubo' })
        self.gooSampler = GPUSampler.new({ min = 'linear', mag = 'linear', wrapU = 'clamp-to-edge', wrapV = 'clamp-to-edge' })
        self.gooBind = GPUBindGroup.new({
            layout = (self.gooPipe :: GPUPipeline):getBindGroupLayout(0),
            ubos = { { slot = 0, buffer = self.gooUbo :: GPUBuffer } },
            textures = { { slot = 1, view = water:colorView() } },
            samplers = { { slot = 2, sampler = self.gooSampler :: GPUSampler } },
        })
    end

    -- The whitewater, half size, persistent: two canvases so a frame can
    -- read the last one while writing the next.
    self.foamA = context:gpuCanvas({ width = gw, height = gh })
    self.foamB = context:gpuCanvas({ width = gw, height = gh })
    self.foamFresh = true
    self.foamParity = 0
    local foamA = self.foamA :: GPUCanvas
    local foamB = self.foamB :: GPUCanvas
    local foamShader = context:shader('foam')
    if foamShader ~= nil and self.gooSampler ~= nil then
        self.foamPipe = GPUPipeline.new({
            vertex = foamShader, fragment = foamShader, vertexLayout = {},
            colorTargets = { { format = foamA.format } }, label = 'foam',
        })
        self.foamBytes = buffer.create(PUDDLE.FOAM_UBO_SIZE)
        local layout = (self.foamPipe :: GPUPipeline):getBindGroupLayout(0)
        self.foamUbos, self.foamBindsA, self.foamBindsB = {}, {}, {}
        for k = 1, FOAM_STEPS do
            local ubo = GPUBuffer.new({ size = PUDDLE.FOAM_UBO_SIZE, usage = 'uniform', label = `foam ubo {k}` })
            self.foamUbos[k] = ubo
            self.foamBindsA[k] = GPUBindGroup.new({
                layout = layout,
                ubos = { { slot = 0, buffer = ubo } },
                textures = { { slot = 1, view = foamB:colorView() } },
                samplers = { { slot = 2, sampler = self.gooSampler :: GPUSampler } },
            })
            self.foamBindsB[k] = GPUBindGroup.new({
                layout = layout,
                ubos = { { slot = 0, buffer = ubo } },
                textures = { { slot = 1, view = foamA:colorView() } },
                samplers = { { slot = 2, sampler = self.gooSampler :: GPUSampler } },
            })
        end
    end

    -- The surface, full size, over the water and the goo: what the CRT
    -- samples as its water from here on. One bind group per foam parity.
    self.surfaceCanvas = context:gpuCanvas({ width = pw, height = ph })
    local surfaceCanvas = self.surfaceCanvas :: GPUCanvas
    local surfaceShader = context:shader('surface')
    if surfaceShader ~= nil and self.gooSampler ~= nil then
        self.surfacePipe = GPUPipeline.new({
            vertex = surfaceShader, fragment = surfaceShader, vertexLayout = {},
            colorTargets = { { format = surfaceCanvas.format } }, label = 'surface',
        })
        self.surfaceBytes = buffer.create(112 + 16 * 16)
        self.surfaceUbo = GPUBuffer.new({ size = 112 + 16 * 16, usage = 'uniform', label = 'surface ubo' })
        local layout = (self.surfacePipe :: GPUPipeline):getBindGroupLayout(0)
        self.surfaceBind = GPUBindGroup.new({
            layout = layout,
            ubos = { { slot = 0, buffer = self.surfaceUbo :: GPUBuffer } },
            textures = {
                { slot = 1, view = water:colorView() },
                { slot = 2, view = gooCanvas:colorView() },
                { slot = 4, view = foamA:colorView() },
            },
            samplers = { { slot = 3, sampler = self.gooSampler :: GPUSampler } },
        })
        self.surfaceBindB = GPUBindGroup.new({
            layout = layout,
            ubos = { { slot = 0, buffer = self.surfaceUbo :: GPUBuffer } },
            textures = {
                { slot = 1, view = water:colorView() },
                { slot = 2, view = gooCanvas:colorView() },
                { slot = 4, view = foamB:colorView() },
            },
            samplers = { { slot = 3, sampler = self.gooSampler :: GPUSampler } },
        })
    end

    -- The tank atlas and the ink atlas: a card-sized tile per slot, the
    -- same grid in both; and the mask canvas the tanks are keyed by. All
    -- before the CRT bind group, which samples them.
    -- A tile per slot, at the card's size in DEVICE pixels — 8x7 of them in
    -- one texture, and a depth buffer to match, which is why layout.luau caps
    -- how big a card may get.
    local tw = math.max(8, math.floor(self.L.cw * self.scale))
    local th = math.max(8, math.floor(self.L.ch * self.scale))
    -- THE TANK IS DRAWN LARGER THAN IT IS SHOWN. A card is 120x168, so a
    -- sardine in the formation is about thirty pixels of fish, and at that
    -- size a cel band is two pixels and an outline at any believable weight is
    -- less than one — the toon look simply does not have the room to exist.
    -- Rendering the tank atlas at a multiple and letting the CRT sample it
    -- down puts the pixels where the detail is, and costs nothing anywhere
    -- else: the ink atlas and the mask keep their own sizes, and the tile
    -- coordinates are fractions, so nothing downstream knows.
    --
    -- The multiple is CHOSEN, not fixed, because the cost is quadratic and the
    -- base size already varies with the display. At 1x a 6x5 sheet of 120x168
    -- tiles is 720x840; doubled it is 1440x1680, which is 9.7MB of colour and
    -- as much again of depth32float. On a retina display the base is already
    -- doubled, and doubling again would be 2880x3360 — 38MB a side, for a
    -- sheet of playing cards. So it takes the largest multiple that keeps the
    -- sheet inside ATLAS_MAX and drops to 1 when even that will not fit.
    local ss = 1
    for _, try in ipairs({ 3, 2 }) do
        if tw * TILE_COLS * try <= ATLAS_MAX and th * TILE_ROWS * try <= ATLAS_MAX then
            ss = try
            break
        end
    end
    local aw, ah = tw * TILE_COLS * ss, th * TILE_ROWS * ss
    self.fishAtlas = context:gpuCanvas({ width = aw, height = ah })
    self.fishDepth = GPUTexture.new({ width = aw, height = ah, format = 'depth32float', renderTarget = true, label = 'fish depth' })
    self.fishDepthView = (self.fishDepth :: GPUTexture):view()
    self.inkCanvas = context:canvas({ width = tw * TILE_COLS, height = th * TILE_ROWS })
    self.maskCanvas = context:canvas({ width = pw, height = ph })
    local fishAtlas = self.fishAtlas :: GPUCanvas
    local maskCanvas = self.maskCanvas :: Canvas
    local maskImg = maskCanvas.image
    local inkImg = (self.inkCanvas :: Canvas).image
    if not self.fishReady then
        self.fishReady = loadFish(self, context)
    end

    local crt = context:shader('crt')
    if crt ~= nil and maskImg ~= nil and inkImg ~= nil then
        self.crtPipe = GPUPipeline.new({
            vertex = crt, fragment = crt, vertexLayout = {},
            colorTargets = { { format = screen.format } }, label = 'crt',
        })
        self.crtBytes = buffer.create(CRT_UBO)
        self.crtUbo = GPUBuffer.new({ size = CRT_UBO, usage = 'uniform', label = 'crt ubo' })
        self.crtSampler = GPUSampler.new({ min = 'linear', mag = 'linear', wrapU = 'clamp-to-edge', wrapV = 'clamp-to-edge' })
        -- The mask is an INDEX, not a picture: filtered, its red blends across
        -- a card's outline, the entry comes back wrong and the tank window
        -- misses by a pixel or two — which is the pale line the old cream
        -- plate used to show around every card.
        self.crtPoint = GPUSampler.new({ min = 'nearest', mag = 'nearest', wrapU = 'clamp-to-edge', wrapV = 'clamp-to-edge' })
        local scene = self.scene :: Canvas
        local img = scene.image
        if img ~= nil then
            -- The CRT pass is also the compositor: water under, the seal's
            -- canvas in its box, the 2-D scene (cards) over everything. A GPU
            -- canvas drawn INSIDE a 2-D canvas frame is not scheduled before
            -- that frame flushes, so the layers meet here, as textures.
            self.crtBind = GPUBindGroup.new({
                layout = (self.crtPipe :: GPUPipeline):getBindGroupLayout(0),
                ubos = { { slot = 0, buffer = self.crtUbo :: GPUBuffer } },
                textures = {
                    { slot = 1, view = img:view() },
                    { slot = 2, view = if self.surfacePipe ~= nil then surfaceCanvas:colorView() else water:colorView() },
                    { slot = 3, view = sealUnderCanvas:colorView() },
                    { slot = 4, view = sealOverCanvas:colorView() },
                    { slot = 5, view = maskImg:view() },
                    { slot = 6, view = fishAtlas:colorView() },
                },
                samplers = { { slot = 7, sampler = self.crtSampler :: GPUSampler } },
            })
            -- The ink atlas and the mask's nearest sampler, in group 1:
            -- group 0's eight slots are spoken for.
            self.crtBindInk = GPUBindGroup.new({
                layout = (self.crtPipe :: GPUPipeline):getBindGroupLayout(1),
                textures = { { slot = 0, view = inkImg:view() } },
                samplers = { { slot = 1, sampler = self.crtPoint :: GPUSampler } },
            })
        end
    end

    if not self.sealReady then
        self.sealReady = loadSeal(self, context)
    end
end

-- The rank artboard for a card. Ids are dealt (suit - 1) * 13 + rank in
-- klondike.luau, so the rank — and therefore the layout — never changes.
local FACE_KEYS = { 'faceA', 'face2', 'face3', 'face4', 'face5', 'face6', 'face7',
    'face8', 'face9', 'face10', 'faceJ', 'faceQ', 'faceK' }
local function faceFor(self: Table, id: number): Input<Artboard<Data.Card>>
    local rank = (id - 1) % 13 + 1
    return (self :: any)[FACE_KEYS[rank]]
end

-- A tank card's ink: the same rank artboard with the plate hidden, bound
-- like the card itself. Made the first time the card is a tank.
local function inkFor(self: Table, id: number): Artboard<Data.Card>?
    local v = self.views[id]
    if v.ink ~= nil then
        return v.ink
    end
    local card = self.cardOf[id]
    if card == nil then
        return nil
    end
    local ok, made = pcall(function(): Artboard<Data.Card>
        return faceFor(self, id):instance(Data.Card.new())
    end)
    if not ok then
        return nil
    end
    local d = made.data
    local rank = d:getString('rank')
    if rank ~= nil then
        rank.value = K.RANK_TEXT[card.rank]
    end
    local ink = d:getColor('ink')
    if ink ~= nil then
        ink.value = if K.isRed(card.suit) then RED else BLACK
    end
    for sIdx, name in ipairs(SUIT_NAMES) do
        local prop = d:getNumber(name)
        if prop ~= nil then
            prop.value = if sIdx == card.suit then 1 else 0
        end
    end
    local plate = d:getNumber('plate')
    if plate ~= nil then
        plate.value = 0
    end
    bindGlow(v, d, card)
    v.ink = made
    return made
end

-- ---------------------------------------------------------------------------
-- The viewport
-- ---------------------------------------------------------------------------
-- The chrome, in the order drawChrome places it: one artboard per corner
-- (scene.rml, "THE CHROME"), each against the rect of the same name in L.
local CHROME = { 'hudTitle', 'hudStats', 'hudDeal' }

-- Everything that has to be rebuilt when the viewport changes: the geometry,
-- the paths and paints that are measured against a card, every pile's
-- targets, and the two things that were placed in screen coordinates before
-- there was a screen.
--
-- THE PAINTS MATTER AS MUCH AS THE PATHS. A stroke's thickness and a
-- feather's radius are in path units, and these paths are drawn at scale 1,
-- so nothing scales them for us: a 5px glow ring and a 16px shadow feather
-- around a 45px phone card are a smear, and the card under them disappears.
-- Paints are safe to mutate after drawing; paths are not, which is why the
-- paths are rebuilt here rather than scaled at the draw.
local function applyLayout(self: Table)
    local was = self.L
    local g = LAYOUT.compute(self.size.x, self.size.y)
    self.L = g
    local f = g.fit

    roundedRect(self.shadowPath, g.cw, g.ch, 10 * f)
    roundedRect(self.slotPath, g.cw - 4 * f, g.ch - 4 * f, 9 * f)
    roundedRect(self.glowPath, g.cw + 10 * f, g.ch + 10 * f, 14 * f)
    -- The pad's cursor. Wider than the hover's ring so the two read apart
    -- when they are on the same card, which is most of the time a pad is in
    -- use: the glow says "the seal is looking at this", the cursor says "this
    -- is where you are".
    roundedRect(self.padRing, g.cw + 18 * f, g.ch + 18 * f, 18 * f)
    roundedRect(self.panelPath, g.tuner.colW * g.tuner.cols + g.tuner.gutter, g.tuner.maxH, 12)
    self.shadowPaint.feather = 16 * f
    self.slotPaint.thickness = 2 * f
    self.glowPaint.thickness = 5 * f
    self.glowPaint.feather = 8 * f
    self.stockPaint.thickness = 4 * f

    -- The "go round again" ring in an empty stock.
    self.stockGlyph:reset()
    local n = 24
    for k = 0, n do
        local a = (k / n) * math.pi * 1.6 - math.pi * 0.3
        local pt = Vector.xy(math.cos(a) * 22 * f, math.sin(a) * 22 * f)
        if k == 0 then
            self.stockGlyph:moveTo(pt)
        else
            self.stockGlyph:lineTo(pt)
        end
    end

    -- The bubbles and the seal were put somewhere on the OLD screen. Carried
    -- across in proportion rather than re-rolled: a live window drag calls
    -- this every frame, and a fresh random x each time is a column of static
    -- where a rising bubble should be.
    if was.w > 0 and was.h > 0 and (was.w ~= g.w or was.h ~= g.h) then
        local kx, ky = g.w / was.w, g.h / was.h
        for _, bb in ipairs(self.bubbles) do
            bb.x *= kx
            bb.y *= ky
        end
        local p = self.puppet
        p.x *= kx
        p.y *= ky
        p.land.x *= kx
        p.land.y *= ky
        -- Every bone is somewhere else now, and a bubble source cannot tell a
        -- resize from a sprint. Forget the last positions rather than read the
        -- jump as the fastest motion of the run.
        self.shedWarm = false
        local sys = self.bub
        for i = 1, sys.n do
            local q = sys.puffs[i]
            q.x *= kx
            q.y *= ky
        end
    end

    -- A scroll that was in range on a taller panel is not on a shorter one,
    -- and the piles are at the old screen's coordinates until this runs.
    self.tunerScroll = 0
    if #self.views > 0 then
        relayout(self)
    end
end

-- ---------------------------------------------------------------------------
-- Lifecycle
-- ---------------------------------------------------------------------------
local function init(self: Table, context: Context): boolean
    self.context = context
    loadSfxBank(self, context)
    loadSfxEvents(self, context)
    -- init runs twice and the view model is absent the first time.
    local vm = context:viewModel()
    if vm ~= nil then
        self.movesProp = vm:getString('moves')
        self.scoreProp = vm:getString('score')
        self.clockProp = vm:getString('clock')
        -- `--data=lab=<species>`: the contact sheet's run. Read here, acted on
        -- when the tank table loads (after resize builds the GPU side).
        -- `--data=lab=<species>`, the contact sheet's run. Not readable yet:
        -- the CLI applies --data after init, so loadTankTable (from the
        -- first resize) is where it is read and acted on.
        -- The four chrome artboards, all reading the same instance this
        -- script writes. They are held in ONE list, in the order drawChrome
        -- places them, so adding a fifth corner is a row here and a rect in
        -- layout.luau and nothing else.
        table.clear(self.hudInst)
        for _, key in ipairs(CHROME) do
            local okHud, made = pcall(function(): Artboard<Data.Table>
                return ((self :: any)[key] :: Input<Artboard<Data.Table>>):instance(vm)
            end)
            if okHud then
                table.insert(self.hudInst, made)
            else
                print(`sealitaire: no {key} instance: {made}`)
            end
        end
        -- The tuner: categories from the rows, one artboard per row and
        -- per header, all with their own view model.
        local catIndex: { [string]: number } = {}
        for i, row in ipairs(TUNING) do
            local c = catIndex[row.cat]
            if c == nil then
                table.insert(self.tunerCats, row.cat)
                c = #self.tunerCats
                catIndex[row.cat] = c
                self.tunerCatRows[c] = {}
                -- Closed on arrival: every category header fits on one screen
                -- that way, so the panel opens on the whole map of what is
                -- tunable rather than on one category's rows pushing the rest
                -- into a column you have to scroll to find.
                self.tunerCatOpen[c] = false
            end
            table.insert(self.tunerCatRows[c], i)
        end
        local okTuner, err = pcall(function()
            for i = 1, #TUNING do
                local rvm = Data.TunerRow.new()
                self.tunerRowVm[i] = rvm
                self.tunerRows[i] = self.tunerRow:instance(rvm)
            end
            for c = 1, #self.tunerCats + 2 do
                local hvm = Data.TunerHead.new()
                self.tunerHeadVm[c] = hvm
                self.tunerHeads[c] = self.tunerHead:instance(hvm)
            end
            for i = 1, #SUBJECT_ROWS do
                local svm = Data.TunerRow.new()
                self.subjectRowVm[i] = svm
                self.subjectRows[i] = self.tunerRow:instance(svm)
            end
            local shvm = Data.TunerHead.new()
            self.subjectHeadVm = shvm
            self.subjectHead = self.tunerHead:instance(shvm)
            local suvm = Data.TunerHead.new()
            self.suitHeadVm = suvm
            self.suitHead = self.tunerHead:instance(suvm)
        end)
        if okTuner then
            writeTuner(self)
        else
            print(`sealitaire: no tuner instances: {err}`)
        end
    end

    if #self.views == 0 then
        for id = 1, 52 do
            local inst: Artboard<Data.Card>? = nil
            local okInst, made = pcall(function(): Artboard<Data.Card>
                local cardVm = Data.Card.new()
                return faceFor(self, id):instance(cardVm)
            end)
            if okInst then
                inst = made
            end
            self.views[id] = {
                x = 0, y = 0, vx = 0, vy = 0, tx = 0, ty = 0,
                rot = 0, vrot = 0, trot = 0,
                scale = 1, vscale = 0, tscale = 1,
                lift = 0, pop = HOVER.new(), tiltX = 0, tiltY = 0,
                flip = 0, tflip = 0, z = 0,
                phase = id * 1.37,
                fanLift = 0,
                dealt = false,
                inst = inst,
                ink = nil,
                pulses = {}, glows = {},
            }
            self.order[id] = id
        end
        local okBack, backInst = pcall(function(): Artboard<nil>
            return self.back:instance()
        end)
        if okBack then
            self.backInst = backInst
        end
        -- The tank's window, in CARD ARTBOARD units: it is drawn through
        -- cardMatrix, which is where `fit` lives, so this one path is right
        -- at every size and is built once.
        roundedRect(self.tankPaths, CARD_W, CARD_H, 10)
        applyLayout(self)
        -- A unit circle, drawn scaled per bubble.
        do
            local kc = 0.5523
            local p = self.bubblePath
            p:reset()
            p:moveTo(Vector.xy(1, 0))
            p:cubicTo(Vector.xy(1, kc), Vector.xy(kc, 1), Vector.xy(0, 1))
            p:cubicTo(Vector.xy(-kc, 1), Vector.xy(-1, kc), Vector.xy(-1, 0))
            p:cubicTo(Vector.xy(-1, -kc), Vector.xy(-kc, -1), Vector.xy(0, -1))
            p:cubicTo(Vector.xy(kc, -1), Vector.xy(1, -kc), Vector.xy(1, 0))
            p:close()
        end
        -- A little ring in the empty stock, the "go round again" mark.
        deal(self, if self.lab ~= '' then LAB_SEED else freshSeed())
    end
    return true
end

-- The viewport changed. Everything that is measured in artboard px is
-- recomputed here, and every card's slot with it — a resize mid-game must
-- move the piles, not leave them at the old screen's coordinates while the
-- hit tests move to the new one.
--
-- The GPU canvases are torn down and rebuilt at the new size, which is not
-- cheap, so it is done only when the pixel size actually changed. A live
-- window drag calls this every frame.
local function resize(self: Table, size: Vector, scale: number)
    self.size = size
    self.scale = if scale > 0 then scale else 1
    applyLayout(self)
    local context = self.context
    if context == nil then
        return
    end
    local pw = math.max(1, math.floor(size.x * self.scale))
    local ph = math.max(1, math.floor(size.y * self.scale))
    local screen = self.screen
    if self.gpu and screen ~= nil and screen.width == pw and screen.height == ph then
        return
    end
    local ok, err = pcall(function()
        buildGpu(self, context, pw, ph)
    end)
    self.gpu = ok
    if not ok then
        print(`sealitaire: GPU canvases unavailable, drawing flat: {err}`)
    end
end

-- ---------------------------------------------------------------------------
-- The music. `Audio.play` hands back a sound that knows what time it is and
-- can be SEEKED, and music.luau uses both: it reads the baked FFT at the
-- playhead, and it keeps that playhead inside whichever region of the track
-- the table has earned. One asset, several loops, nothing cut into files —
-- see musicLoops.csv and `npm run sealitaire:loops`.
--
-- Only the watch player opens an audio device, so this is nil in most
-- headless modes and everything below is a no-op there — the table is the
-- same table without it.
-- ---------------------------------------------------------------------------
-- Find the track and the analysis. It does NOT start anything: starting is
-- music.luau's, because the table is built more than once per context and a
-- second table starting a second copy is the whole of the bug that was.
local function startMusic(self: Table, context: Context)
    if not MUSIC.load(self.music, context) then
        return
    end
    local src = context:audio('music')
    if src == nil then
        print('sealitaire: music.mp3 missing; the water will not hear anything')
        return
    end
    self.musicSource = src
end

-- The playhead the analysis is read at.
--
-- `sound:time()` is the truth whenever it MOVES: it is the speakers' own
-- clock, and a dropped frame must not slide the bands out of step with what
-- is actually being heard. But it does not always move. Every headless mode
-- that builds a player at all runs miniaudio with `noDevice`, which never
-- pulls a frame, so the playhead sits at 0 for the whole run — and a
-- `--screenshot` of the music's ripples would photograph frame zero of the
-- track forever and look entirely plausible. The modes that build no player
-- have no sound at all.
--
-- So: follow the sound while it is moving, and free-run on the table's clock
-- when it has not moved for a quarter second. Watch mode never takes the
-- fallback — a real device ticks the playhead every frame — and every
-- headless check takes it, which is what makes the ripples checkable.
local CLOCK_STALL = 0.25

local function musicClock(self: Table, dt: number): number
    local sound = self.sound
    if sound ~= nil then
        local now = sound:time()
        if now ~= self.soundLast then
            self.soundLast = now
            self.soundStill = 0
            self.musicTime = now
            return now
        end
        self.soundStill += dt
        if self.soundStill <= CLOCK_STALL then
            return self.musicTime
        end
    end
    self.musicTime += dt
    -- Free-running inside the REGION, not across the file. Without this the
    -- headless clock walks the whole 265 seconds and reads the bake for
    -- regions the table is not playing — which is exactly the kind of wrong
    -- that still produces a plausible screenshot.
    local loop = MUSIC.currentLoop(self.music)
    if loop ~= nil then
        if self.musicTime < loop.startSec or self.musicTime >= loop.endSec then
            self.musicTime = loop.startSec
        end
        return self.musicTime
    end
    local span = self.music.duration
    if span > 0 and self.musicTime > span then
        self.musicTime -= span
    end
    return self.musicTime
end

local function stepMusic(self: Table, dt: number)
    -- Started from the first advance, not from init: init runs twice (the
    -- view model is absent the first time) and starting there would play the
    -- track twice over itself, half a frame apart, which sounds like a
    -- flanger and is very hard to attribute to anything.
    if not self.musicTried then
        self.musicTried = true
        local context = self.context
        if context ~= nil then
            startMusic(self, context)
        end
    end
    if not self.music.ready then
        return
    end
    -- One shared sound, started and looped inside music.luau. Every table
    -- asks every frame and they all get the same one back; the playhead
    -- dropping to zero on a loop is what its refractory guard is written for.
    local src = self.musicSource
    if src ~= nil then
        self.sound = MUSIC.keepPlaying(src, T.musicVolume, self.time)
        MUSIC.setMix(T.musicVolume * T.musicWash, T.musicDebug)
        -- Then keep it inside its region. The gates are asked about the deal
        -- in front of us; the session's counters are music.luau's, because
        -- this table is rebuilt on a re-deal and a session is not.
        local g = self.game
        MUSIC.follow(self.music, self.sound, MUSIC.progress(K.founded(g), g.score, g.moves), Audio.time())
    end
    -- If a reload orphaned the track (see music.luau's RELOAD_GAP) there is no
    -- sound to read a playhead off, but there IS one playing. It started at
    -- engine time zero, so the engine's clock modulo the length is where it
    -- has got to — which keeps the water in step with what is audible instead
    -- of free-running from zero against a track that is minutes in.
    local t = if MUSIC.isOrphaned() then MUSIC.orphanPlayhead(self.music.duration) else musicClock(self, dt)
    local gain = T.musicRipple
    -- Stepped even at gain 0, so the bands stay smoothed and the bed does not
    -- jump when the slider comes back up mid-track.
    local bands = MUSIC.step(self.music, t, dt)
    -- THE BEAT. The black suits' glow pulses on this, so it is kicked here,
    -- before the ripple gain gate: at musicRipple 0 the track still plays and
    -- the water never shows it, and the cards should keep hearing it.
    --
    -- An onset is an EDGE, so the pulse is a kick and a decay, not the band's
    -- level read every frame — a level is loud for as long as the note is and
    -- reads as a slow swell, which is the opposite of a beat. The low bands
    -- count for most of it: a kick is the beat, a hi-hat is ornament.
    self.beat *= math.exp(-dt * BEAT_DECAY)
    for _, band in ipairs(bands) do
        local w = math.max(0.15, 1.25 - (band.k - 1) / math.max(1, self.music.bands - 1) * 1.1)
        self.beat = math.max(self.beat, math.min(1, w * (0.5 + 0.5 * band.flux)))
    end
    if gain <= 0 then
        return
    end
    for _, band in ipairs(bands) do
        musicRipple(self, band.x, band.y, band.flux * gain)
    end
end

local function advance(self: Table, dt: number): boolean
    dt = math.min(dt, 1 / 20)
    self.time += dt
    local t = self.time
    local g = self.L

    -- Water: energy decays, ripples age.
    self.energy = math.max(0, self.energy - dt * (if self.game.won then 0.05 else 0.6))
    for _, r in ipairs(self.ripples) do
        r.age += dt
    end
    -- The music's ring ages the same way, and is topped up from the track's
    -- own playhead rather than from `t` — a dropped frame must not slide the
    -- analysis out of step with what is actually coming out of the speakers.
    local dead = 0
    for _, r in ipairs(self.musicRipples) do
        r.age += dt
        if r.age > 3 then
            dead += 1
        end
    end
    while dead > 0 do
        table.remove(self.musicRipples)
        dead -= 1
    end
    stepMusic(self, dt)
    -- The pad, BEFORE anything reads the pointer: the cursor writes
    -- `self.pointer` and `self.hoverRaw`, and the water's eye, the hover's
    -- settle and the seal's gaze all read them further down this function.
    Pad.step(self, dt)
    local focus = self.pointer
    if self.hovered ~= 0 then
        local v = self.views[self.hovered]
        focus = Vector.xy(v.x, v.y)
    end
    local k = 1 - math.exp(-1.2 * dt)
    self.vortexCentre = Vector.xy(
        self.vortexCentre.x + ((0.5 + (focus.x / g.w - 0.5) * 0.35) - self.vortexCentre.x) * k,
        self.vortexCentre.y + ((0.55 + (focus.y / g.h - 0.5) * 0.35) - self.vortexCentre.y) * k
    )
    if self.win >= 0 then
        self.win += dt
        -- Every card circles the eye, tighter as it goes, and the water
        -- spins with them. The next deal springs them back out.
        local cx, cy = self.vortexCentre.x * g.w, self.vortexCentre.y * g.h
        local w = self.win
        for id = 1, 52 do
            local v = self.views[id]
            local a = w * 1.1 + id * 0.121
            local radius = (math.max(70, 460 - w * 26 - (id % 5) * 24)) * g.fit
            v.tx = cx + math.cos(a) * radius
            v.ty = cy + math.sin(a) * radius * 0.62
            v.trot = a + math.pi / 2
            v.tscale = 0.8 + 0.2 * math.sin(a)
            v.tflip = 1
            v.z = 6000 + math.floor(math.sin(a) * 100)
        end
        self.orderDirty = true
        self.energy = math.max(self.energy, 0.8)
    end

    -- Cards.
    if self.orderDirty then
        sortOrder(self)
    end
    local drag = self.drag
    local dragIndex: { [number]: number } = {}
    if drag ~= nil then
        for i, c in ipairs(drag.cards) do
            dragIndex[c.id] = i
        end
    end
    for id = 1, 52 do
        local v = self.views[id]
        local di = dragIndex[id]
        local dragged = di ~= nil

        -- Position: the held card chases hard; each card under it a little
        -- softer, so a run trails the hand like a ribbon.
        local kp, dp = T.cardSpring, T.cardDamp
        if di ~= nil then
            kp = math.max(220, 700 - (di - 1) * 140)
            dp = math.max(20, 42 - (di - 1) * 5)
        end
        v.x, v.vx = spring(v.x, v.vx, v.tx, dt, kp, dp)
        v.y, v.vy = spring(v.y, v.vy, v.ty, dt, kp, dp)

        -- Idle sway on the resting cards: a breath, not a wobble.
        local sway = math.sin(t * 1.3 + v.phase) * T.sway
        local trot = v.trot + (if dragged then 0 else sway)
        v.rot, v.vrot = spring(v.rot, v.vrot, trot, dt, 180, 16)

        -- THE POP. The hovered run is armed below (hoverPop); here each card
        -- springs toward wherever its own arming says, and the pop is read
        -- as scale, a rise (popRise, in the matrix) and shadow. Never a
        -- shear: a card under the pointer keeps its shape, and reads.
        HOVER.step(v.pop, t, dt, T.popSpring, T.popDamp)
        local tscale = v.tscale * (1 + (T.hoverScale - 1) * clamp(v.pop.pop * hoverFall, -0.5, 1.5))
        v.scale, v.vscale = spring(v.scale, v.vscale, tscale, dt, 320, 20)

        -- The drag banks with its velocity; a hover does not tilt.
        local wantTiltX, wantTiltY = 0, 0
        if dragged then
            wantTiltX = clamp(v.vy * 0.0004, -0.2, 0.2)
            wantTiltY = clamp(v.vx * 0.0004, -0.2, 0.2)
        end
        local kt = 1 - math.exp(-14 * dt)
        v.tiltX += (wantTiltX - v.tiltX) * kt
        v.tiltY += (wantTiltY - v.tiltY) * kt

        local wantLift = ((if dragged then 22 else 2 + 8 * math.max(0, v.pop.pop * hoverFall)) + v.fanLift) * g.fit
        v.lift += (wantLift - v.lift) * (1 - math.exp(-10 * dt))

        -- The flip: eased toward its side.
        local kf = 1 - math.exp(-9 * dt)
        v.flip += (v.tflip - v.flip) * kf
    end

    -- THE DRAWN CARD TURNS OVER ON ITS WAY ACROSS, and the turn IS the
    -- journey: `flip` is the progress, not a spring of its own, so the card is
    -- edge-on at exactly the half way point and lands face up as it arrives.
    --
    -- It overrides the spring rather than being given to it. The card spring is
    -- 736 — deliberately, because everything else on this table wants to snap
    -- to its slot — and a flip carried by it is over in a hundred milliseconds,
    -- which is a flicker rather than a card being turned. So this drives the
    -- position itself for `drawTime`, from wherever the card actually was (up
    -- in the ribbon, if the fan was up) to its slot in the waste.
    if flight.id ~= 0 then
        local v = self.views[flight.id]
        flight.t += dt
        local u: number = clamp(flight.t / math.max(0.05, T.drawTime), 0, 1)
        local e: number = u * u * (3 - 2 * u)
        v.x = flight.x + (v.tx - flight.x) * e
        v.y = flight.y + (v.ty - flight.y) * e
        -- The spring is not carrying it, so it must not arrive holding speed it
        -- never had.
        v.vx, v.vy = 0, 0
        v.flip = u
        -- Toward the viewer through the middle of the turn: a card coming over
        -- the top of an arc, not sliding across the felt.
        v.scale = v.tscale * (1 + T.drawArc * math.sin(u * math.pi))
        v.vscale = 0
        if u >= 1 then
            flight.id = 0
        end
    end

    -- The goo follows the cards. Luau arrays are invariant: a { View } is
    -- not a { Card } even though a View has every field a Card asks for,
    -- hence the casts.
    local dragIds: { number }? = nil
    if drag ~= nil then
        dragIds = {}
        for _, c in ipairs(drag.cards) do
            table.insert(dragIds, c.id)
        end
    end
    PUDDLE.advance(self.goo, {
        dt = dt, views = self.views :: any, piles = K.piles(self.game) :: any, dragIds = dragIds,
        cw = g.cw, ch = g.ch, px = g.fit, splash = T.gooSplash, won = self.game.won,
    })

    -- The hover settles: entering a card from nothing is immediate, but a
    -- How far into the hovered card the pointer actually is, eased. The rect
    -- metric is cardHit's own, so "1" here is exactly its boundary.
    do
        local want = 1
        if self.hovered ~= 0 and self.pointerKnown and self.drag == nil then
            local v = self.views[self.hovered]
            local nx = math.abs(self.pointer.x - v.tx) / math.max(1, g.cw / 2)
            local ny = math.abs(self.pointer.y - v.ty) / math.max(1, g.ch / 2)
            local d = clamp((math.max(nx, ny) - 0.3) / 0.85, 0, 1)
            want = 1 - clamp(T.hoverFalloff, 0, 1) * (d * d * (3 - 2 * d))
        end
        hoverFall += (want - hoverFall) * (1 - math.exp(-11 * dt))
    end

    -- switch to another card or a leave must hold for `hoverSettle` before
    -- the seal is told. A flicker shorter than that never reaches it.
    if self.drag == nil then
        if self.hoverRaw ~= self.hovered then
            if self.hoverPending ~= self.hoverRaw then
                self.hoverPending = self.hoverRaw
                self.hoverSince = t
            end
            if self.hovered == 0 or t - self.hoverSince >= T.hoverSettle then
                self.hovered = self.hoverRaw
                -- ON THE SETTLED EDGE, not the raw one: hoverRaw flickers as
                -- the pointer crosses the gap between two cards, and a blip
                -- on every flicker is a rattle. This is the same edge the
                -- seal is told about.
                if self.hovered ~= 0 then
                    -- Klondike has no card->pile lookup and does not need
                    -- one for this: the piles are twelve short lists and
                    -- this runs on a hover edge, not a frame.
                    local depth = 1
                    for _, p in ipairs(K.piles(self.game)) do
                        for _, c in ipairs(p.cards) do
                            if c.id == self.hovered then
                                depth = #p.cards
                                break
                            end
                        end
                    end
                    playCardHover(self, depth)
                end
            end
        else
            self.hoverPending = self.hovered
        end
    end
    hoverPop(self, t)

    -- THE STOCK'S FAN. Hovered, the deck rises into a ribbon — the top card
    -- pinned to the cursor, the rest weaving up to it like something held
    -- in a current; a click drops it as the top card flips away, and it
    -- settles back the moment the pointer leaves the deck's hitbox. The
    -- rise is capped by fanRoom(): never over the chrome, never off the top.
    -- Written onto the cards' targets, so the springs carry it.
    self.stockPulse = math.max(0, self.stockPulse - dt * T.stockDrop)
    -- Is the deck WANTED — the pointer on it and no card in hand. The fan's
    -- height scales that by the click pulse; the SOUND must not.
    local fanWanted = self.stockHovered and self.drag == nil
    local wantFan = (if fanWanted then 1 else 0) * (1 - self.stockPulse)
    -- The fan rising is a sound: once, on the edge, not while it is up. And
    -- the fan DROPPING takes it away again — the take can outlast the fan,
    -- which otherwise leaves the deck settled and still ringing.
    --
    -- ON `fanWanted`, NOT ON THE FAN'S HEIGHT. A click drops the height to
    -- zero (stockPulse) and it climbs back while the pointer never moved —
    -- so an edge read off the height fires the hover a SECOND time on every
    -- click of the deck, under the sound the click itself makes. The pointer
    -- is what the sound is about; the pulse is an animation.
    local fanUp = fanWanted
    if fanUp and not self.fanWasUp then
        -- A new rise cancels an unfinished choke outright: the old voice is
        -- on its way out and holding it would ramp the NEW one down.
        local dying = self.hoverSound
        if dying ~= nil and self.hoverFade > 0 then
            dying:stop()
        end
        self.hoverFade = 0
        local snd = playSfx(self, 'hover')
        self.hoverSound = snd
        -- What it actually started at, so the ramp scales from the real
        -- level rather than from a slider that may have moved since.
        self.hoverVol = if snd ~= nil then snd.volume else 0
    elseif not fanUp and self.fanWasUp then
        chokeHover(self)
    end
    self.fanWasUp = fanUp
    -- The bed under the blip, on the same `fanWanted` and for the same reason:
    -- a click drops the fan's HEIGHT to zero and it climbs back with the
    -- pointer never having moved, and an aura that cut out for that half
    -- second would be describing the click rather than the deck.
    updateAura(self, fanWanted, dt)
    -- The ramp itself, on the table's clock: a voice that has already ended
    -- is harmless to ramp and harmless to stop.
    if self.hoverFade > 0 then
        self.hoverFade -= dt
        local snd = self.hoverSound
        if snd ~= nil then
            if self.hoverFade <= 0 then
                snd:stop()
                self.hoverSound = nil
            else
                snd.volume = self.hoverVol * (self.hoverFade / HOVER_CHOKE)
            end
        end
        if self.hoverFade <= 0 then
            self.hoverFade = 0
        end
    end
    -- TWO RATES, AND THE SECOND ONE IS THE POINT. Going up is an answer to
    -- the pointer and wants to be immediate; coming back down is the deck
    -- settling and wants to be slow, so leaving is a glide rather than a
    -- retraction. `stockSettle` is only for the fall the POINTER caused: when
    -- the deck is still wanted the fall is the click's (stockPulse), the top
    -- card is flipping away over it, and that one has to stay quick.
    local rate = if fanWanted then T.stockEase else T.stockSettle
    self.stockFan += (wantFan - self.stockFan) * (1 - math.exp(-rate * dt))
    do
        local stock = self.game.stock
        local n = #stock.cards
        local sx, sy = pileOrigin(g, stock)
        local room = fanRoom(self)
        -- WHERE THE RIBBON'S HEAD IS. The cursor while the deck is hovered,
        -- held inside the hitbox — and then simply LEFT THERE when it is not.
        --
        -- That last part is what stops the snap. The head used to revert to
        -- the column's centre at full height the moment the pointer left, so
        -- with the fan still up the whole ribbon was yanked sideways by up to
        -- half a card AND upward to the top of its room, in one frame, before
        -- it fell — under a card spring of 736, which chases a moved target
        -- almost instantly. The ease was never the problem: the thing it was
        -- easing toward teleported. Held, the collapse is `stockFan` decaying
        -- into `lift` and nothing else, which is a glide by construction.
        --
        -- Parked at the default only once the fan is ALREADY down, where
        -- moving it cannot be seen: that way a hover that begins before the
        -- pointer is known still rises straight up its own column instead of
        -- toward wherever the pointer was last seen.
        if self.stockHovered and self.pointerKnown then
            self.fanX = clamp(self.pointer.x, sx - g.cw / 2, sx + g.cw / 2)
            self.fanY = clamp(self.pointer.y, sy - room, sy)
        elseif self.stockFan < 0.001 then
            self.fanX, self.fanY = sx, sy - room
        end
        local topX, topY = self.fanX, self.fanY
        -- OVER THE WASTE WHILE THE RIBBON IS UP. The stock sits at z 100+ and
        -- the waste beside it at 200+, which is right for two flat piles — the
        -- drawn card belongs on top of the deck it came off. But the fan rises
        -- ACROSS the waste's slot, and at those z values the ribbon was going
        -- up behind it and losing its head to the drawn card.
        --
        -- Lifted to 300+, which is over the waste and still under the
        -- foundations. Only while the fan is actually up: down, the two piles
        -- want their ordinary order back, and at fan 0 the ribbon is inside its
        -- own column where the z cannot be seen either way.
        local fanZ: number = if self.stockFan > 0.02 then 300 else 100
        for ki, card in ipairs(stock.cards) do
            local v = self.views[card.id]
            local bx, by = slotFor(g, stock, ki)
            local wantZ: number = fanZ + ki
            if v.z ~= wantZ then
                v.z = wantZ
                self.orderDirty = true
            end
            local u = if n > 1 then (ki - 1) / (n - 1) else 1
            local f = self.stockFan
            local lift = f * math.pow(u, 1.6)
            local sway = T.stockSway * g.fit * f * (1 - u) * math.sin(u * 4.2 + t * T.stockWobble)
            v.tx = bx + (topX - bx) * lift + sway
            v.ty = by + (topY - by) * lift
            v.trot = T.stockTilt * f * (1 - u * 0.5) * math.sin(u * 3.1 + t * T.stockWobble * 0.7)
            v.fanLift = f * u * 14
        end
    end

    updateDrag(self, dt)

    -- The seal swims.
    updateSwim(self, dt)

    -- Bubbles rise from below the frame; the water's energy hurries them.
    local nb = math.floor(clamp(T.bubbleCount, 0, MAX_BUBBLES))
    for bi = 1, nb do
        local bb = self.bubbles[bi]
        local rad = bb.r * T.bubbleSize * g.fit
        bb.y -= bb.vy * T.bubbleSpeed * (1 + self.energy * 0.8) * (0.6 + bb.r * 0.6) * dt
        bb.x += math.sin(t * 1.4 * bb.wobble + bb.phase) * 14 * dt
        if bb.y < -rad * 2 then
            bb.y = g.h + rad * 2 + math.random() * 120
            bb.x = math.random() * g.w
            bb.r = 0.4 + math.random() * 0.6
        end
    end

    -- The tanks: every tank card that is face up gets its bodies moved, and
    -- its ink face advanced (made on first sight).
    for id = 1, 52 do
        if not isTank(self, id) then
            self.tankSeen[id] = false
        else
            local rec = self.tankOf[id]
            local v = self.views[id]
            local dragged = false
            if drag ~= nil then
                for _, c in ipairs(drag.cards) do
                    if c.id == id then
                        dragged = true
                    end
                end
            end
            local ball = self.balls[id]
            if ball == nil then
                ball = BAIT.new(id)
                self.balls[id] = ball
            end
            -- The reveal: this face was not showing last frame.
            local revealed = self.tankSeen[id] ~= true
            self.tankSeen[id] = true
            BAIT.update(ball, dt, tankInputs(self, rec, self.hovered == id, self.pressedCard == id, self.played[id] == true, dragged, v.vx, v.vy, revealed))
            -- The big animals answer with their SKELETON: the same contact
            -- that dents a sardine shoves a shark's spine and fins, and the
            -- springs carry it down the body (bonespring.luau). A species
            -- with no rigs.csv row has no chains and costs nothing here.
            local rsp = rec.species
            if #rsp.chains > 0 then
                local rcfg = {
                    stiff = T.rigStiff, damp = T.rigDamp, tipLoose = T.rigTipLoose,
                    maxLag = math.rad(T.rigMaxLag), maxBend = math.rad(T.rigMaxBend), soft = 0.5,
                    impulse = T.rigImpulse, spread = T.rigSpread,
                }
                for bi = 1, #ball.fish do
                    RIG.stepRig(rsp, ball.fish[bi], dt, rcfg)
                end
            end
            -- The knocks want the LOUDEST of the frame, not all of them. Every
            -- other event here is one per player action; this one is not —
            -- seven tanks of sixteen bodies report dozens in a frame and a
            -- drag keeps it up for seconds. So they are collected and the
            -- best is played once, below, behind a gap.
            for _, hit in ipairs(ball.hits) do
                if hit.speed > self.knockBest then
                    self.knockBest = hit.speed
                    self.knockLen = hit.len
                    -- The card comes with the speed, because the sound is the
                    -- card's: one knock plays per frame and it should be the
                    -- voice of whatever actually hit the glass hardest.
                    self.knockCard = id
                end
            end
            local ink = inkFor(self, id)
            if ink ~= nil then
                ink:advance(dt)
            end
        end
    end
    self.pressedCard = 0
    table.clear(self.played)
    -- The light behind the ranks. `inkGlow` is the master: at 0 both steady
    -- glows and the pulse are dark, and the markup that draws them is still
    -- there in cards.rml untouched, waiting for the slider to come back up.
    do
        local glow = T.inkGlow
        local level = math.min(1, self.beat * T.inkPulse) * glow
        for id = 1, 52 do
            local v = self.views[id]
            for _, prop in ipairs(v.glows) do
                prop.value = glow
            end
            for _, prop in ipairs(v.pulses) do
                prop.value = level
            end
        end
    end

    -- Card instances need their binds pushed; the back needs its first
    -- advance or it never draws at all.
    for id = 1, 52 do
        local inst = self.views[id].inst
        if inst ~= nil then
            inst:advance(dt)
        end
    end
    local backInst = self.backInst
    if backInst ~= nil then
        backInst:advance(dt)
    end
    for _, inst in ipairs(self.hudInst) do
        inst:advance(dt)
    end
    if self.tunerOpen then
        -- Laid out here, not at draw: a press hit-tests this frame's items.
        tunerLayout(self)
        for _, inst in ipairs(self.tunerRows) do
            inst:advance(dt)
        end
        for _, inst in ipairs(self.tunerHeads) do
            inst:advance(dt)
        end
        -- The card rows and their two heads too: an instance that is not
        -- advanced never resolves its bindings and draws nothing at all.
        for _, inst in ipairs(self.subjectRows) do
            inst:advance(dt)
        end
        if self.subjectHead ~= nil then
            self.subjectHead:advance(dt)
        end
        if self.suitHead ~= nil then
            self.suitHead:advance(dt)
        end
    end

    -- HUD.
    if self.movesProp ~= nil then
        self.movesProp.value = tostring(self.game.moves)
    end
    if self.scoreProp ~= nil then
        self.scoreProp.value = tostring(self.game.score)
    end
    if self.clockProp ~= nil then
        local clockAt = if self.game.won and self.win >= 0 then self.dealTime + (t - self.dealTime) - self.win else t
        self.clockProp.value = fmtClock(clockAt - self.dealTime)
    end
    -- The frame's hardest tank knock, if the glass has been quiet long enough.
    -- On the AUDIO ENGINE's clock: the gap is about what the ear hears, and
    -- the table's clock is the one that stalls on a slow frame.
    if self.knockBest > 0 then
        local now = Audio.time()
        if now < self.knockLast then
            self.knockLast = -1000      -- the engine restarted under us
        end
        if now - self.knockLast >= TANK_KNOCK_GAP then
            self.knockLast = now
            -- The card's own event if its tanks.csv row names one, the
            -- default flick-plop otherwise. A row naming an event with no
            -- sfxEvents.csv row of its own is reported by playSfx and falls
            -- silent rather than quietly playing the default, which would
            -- hide the typo.
            local rec = self.tankOf[self.knockCard]
            local level = math.min(1, self.knockBest / TANK_HIT_LOUD)
            if rec ~= nil and rec.knock ~= '' then
                playSfx(self, rec.knock, level)
            else
                playKnock(self, level, self.knockLen)
            end
        end
        self.knockBest = 0
        self.knockCard = 0
        self.knockLen = 0
    end
    return true
end

-- ---------------------------------------------------------------------------
-- Drawing
-- ---------------------------------------------------------------------------
local function drawWater(self: Table)
    local water = self.water
    local mode = waterMode()
    local pipe = self.waterPipes[mode] or self.waterPipes[1]
    local bind = self.waterBinds[mode] or self.waterBinds[1]
    local ubo = self.waterUbo
    if water == nil or pipe == nil or ubo == nil or bind == nil then
        return
    end
    local b = self.waterBytes
    buffer.writef32(b, 0, water.width)
    buffer.writef32(b, 4, water.height)
    buffer.writef32(b, 8, self.time)
    buffer.writef32(b, 12, waterEnergy(self))
    buffer.writef32(b, 16, self.vortexCentre.x)
    buffer.writef32(b, 20, self.vortexCentre.y)
    buffer.writef32(b, 24, if self.pointerKnown then self.pointer.x / self.L.w else -1)
    buffer.writef32(b, 28, if self.pointerKnown then self.pointer.y / self.L.h else -1)
    buffer.writef32(b, 32, T.twist)
    buffer.writef32(b, 36, T.waterSpeed)
    buffer.writef32(b, 40, T.waterBright)
    buffer.writef32(b, 44, T.warp)
    writeRipples(self, b, 48)
    ubo:write(b)
    local pass = water:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0.03, 0.09, 0.17, 1 } } },
    })
    pass:setPipeline(pipe)
    pass:setBindGroup(0, bind)
    pass:draw(3)
    pass:finish()
end

local function drawGoo(self: Table)
    local canvas = self.gooCanvas
    local pipe = self.gooPipe
    local ubo = self.gooUbo
    local bind = self.gooBind
    if canvas == nil or pipe == nil or ubo == nil or bind == nil then
        return
    end
    if T.goo <= 0 then
        -- Off: the layer is cleared to nothing and the pass is skipped.
        local clear = canvas:beginRenderPass({
            color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
        })
        clear:finish()
        return
    end
    local b = self.gooBytes
    buffer.writef32(b, 0, canvas.width)
    buffer.writef32(b, 4, canvas.height)
    buffer.writef32(b, 8, self.time)
    buffer.writef32(b, 12, self.energy)
    -- Every one of these is px of TABLE, so every one is card-sized: the goo
    -- wraps the cards, and a skirt tuned against a 120px card is a puddle
    -- swallowing a 45px one.
    local g = self.L
    buffer.writef32(b, 16, g.w)
    buffer.writef32(b, 20, g.h)
    buffer.writef32(b, 24, T.gooSkirt * g.fit)
    buffer.writef32(b, 28, T.gooBlend * g.fit)
    buffer.writef32(b, 32, T.gooWobble * g.fit)
    buffer.writef32(b, 36, 14 * g.fit)     -- refraction, px
    buffer.writef32(b, 40, T.goo)
    buffer.writef32(b, 44, 22 * g.fit)     -- dome width, px
    PUDDLE.write(self.goo, b)
    ubo:write(b)
    local pass = canvas:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
    })
    pass:setPipeline(pipe)
    pass:setBindGroup(0, bind)
    pass:draw(3)
    pass:finish()
end

-- The foam is stepped from the time it was last drawn to now, in steps no
-- longer than a frame or two, so a hitch — or a headless render, which
-- draws once after all its advances — leaves fronts swept, not skipped.
local function drawFoam(self: Table)
    local foamA, foamB = self.foamA, self.foamB
    local pipe = self.foamPipe
    if foamA == nil or foamB == nil or pipe == nil or #self.foamUbos == 0 then
        return
    end
    if self.foamFresh then
        -- A new canvas holds whatever was in memory: start both from nothing.
        self.foamFresh = false
        for _, c in ipairs({ foamA, foamB }) do
            local clear = c:beginRenderPass({
                color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 1 } } },
            })
            clear:finish()
        end
    end
    local elapsed = if self.foamTime < 0 then 1 / 60 else math.max(0, self.time - self.foamTime)
    self.foamTime = self.time
    local steps = clamp(math.ceil(elapsed * 40), 1, FOAM_STEPS)
    local dt = elapsed / steps
    local p = self.puppet
    for k = 1, steps do
        local target = if self.foamParity == 0 then foamA else foamB
        local bind = if self.foamParity == 0 then self.foamBindsA[k] else self.foamBindsB[k]
        local b = self.foamBytes
        buffer.writef32(b, 0, target.width)
        buffer.writef32(b, 4, target.height)
        buffer.writef32(b, 8, self.time - elapsed + dt * k)
        buffer.writef32(b, 12, dt)
        buffer.writef32(b, 16, self.L.w)
        buffer.writef32(b, 20, self.L.h)
        buffer.writef32(b, 24, self.energy)
        buffer.writef32(b, 28, T.foamFade)
        buffer.writef32(b, 32, self.vortexCentre.x)
        buffer.writef32(b, 36, self.vortexCentre.y)
        buffer.writef32(b, 40, T.twist)
        buffer.writef32(b, 44, T.waterSpeed)
        buffer.writef32(b, 48, p.x)
        buffer.writef32(b, 52, p.y)
        buffer.writef32(b, 56, p.outHeading)
        buffer.writef32(b, 60, math.sqrt(p.vx * p.vx + p.vy * p.vy))
        buffer.writef32(b, 64, T.sealLength * self.L.sealRef)
        buffer.writef32(b, 68, T.whitewater)
        -- Impacts are written at the age they had at the end of THIS step.
        PUDDLE.writeFoam(self.goo, b, elapsed - dt * k)
        self.foamUbos[k]:write(b)
        local pass = target:beginRenderPass({
            color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 1 } } },
        })
        pass:setPipeline(pipe)
        pass:setBindGroup(0, bind)
        pass:draw(3)
        pass:finish()
        self.foamParity = 1 - self.foamParity
    end
end

local function drawSurface(self: Table)
    local canvas = self.surfaceCanvas
    local pipe = self.surfacePipe
    local ubo = self.surfaceUbo
    -- The foam step just written is the OTHER parity's canvas now.
    local bind = if self.foamParity == 1 then self.surfaceBind else self.surfaceBindB
    if canvas == nil or pipe == nil or ubo == nil or bind == nil then
        return
    end
    local b = self.surfaceBytes
    buffer.writef32(b, 0, canvas.width)
    buffer.writef32(b, 4, canvas.height)
    buffer.writef32(b, 8, self.time)
    buffer.writef32(b, 12, waterEnergy(self))
    buffer.writef32(b, 16, self.L.w)
    buffer.writef32(b, 20, self.L.h)
    buffer.writef32(b, 24, if self.pointerKnown then self.pointer.x else -1000)
    buffer.writef32(b, 28, if self.pointerKnown then self.pointer.y else -1000)
    buffer.writef32(b, 32, T.caustics)
    buffer.writef32(b, 36, T.bubbles)
    buffer.writef32(b, 40, T.waves)
    buffer.writef32(b, 44, T.glint)
    local p = self.puppet
    buffer.writef32(b, 48, p.x)
    buffer.writef32(b, 52, p.y)
    buffer.writef32(b, 56, p.outHeading)
    buffer.writef32(b, 60, math.sqrt(p.vx * p.vx + p.vy * p.vy))
    -- The vortex's own frame, for the turbulence.
    buffer.writef32(b, 64, self.vortexCentre.x)
    buffer.writef32(b, 68, self.vortexCentre.y)
    buffer.writef32(b, 72, T.twist)
    buffer.writef32(b, 76, T.waterSpeed)
    buffer.writef32(b, 80, T.refract)
    buffer.writef32(b, 84, T.turbulence)
    buffer.writef32(b, 88, T.whitewater)
    buffer.writef32(b, 92, 0)
    -- The surface as a surface: how far a ripple stands up, how much sky it
    -- turns around, and how far its slopes are exaggerated before the
    -- Fresnel is taken off them.
    buffer.writef32(b, 96, T.rippleRelief)
    buffer.writef32(b, 100, T.reflect)
    buffer.writef32(b, 104, T.reflectTilt)
    buffer.writef32(b, 108, 0)
    -- The same ripples the vortex has, plays and music alike.
    writeRipples(self, b, 112)
    ubo:write(b)
    local pass = canvas:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0.03, 0.09, 0.17, 1 } } },
    })
    pass:setPipeline(pipe)
    pass:setBindGroup(0, bind)
    pass:draw(3)
    pass:finish()
end

-- One of the seal's two canvases. `over` is the side of the cards it is
-- composited on, which is also `layer.x` — the number seal.wgsl discards
-- against. `draw` false clears the canvas and nothing more: away from a bite
-- the whole animal is on one side, so the other side has nothing to hold and
-- a second full pass over the mesh would be spent entirely on discards.
local function sealPass(self: Table, target: GPUCanvas, ubo: GPUBuffer, bind: GPUBindGroup,
                        pipe: GPUPipeline, verts: GPUBuffer, index: GPUBuffer, depthView: GPUTextureView,
                        over: boolean, draw: boolean)
    local b = self.sealBytes
    if not draw then
        local empty = target:beginRenderPass({
            color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
        })
        empty:finish()
        return
    end
    buffer.writef32(b, 192, if over then 1.0 else 0.0) -- layer.x: which pass this is
    ubo:write(b)
    local rp = target:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
        depthStencil = { view = depthView, depthLoadOp = 'clear', depthStoreOp = 'discard', depthClearValue = 1 },
    })
    rp:setPipeline(pipe)
    rp:setBindGroup(0, bind)
    rp:setVertexBuffer(0, verts)
    rp:setIndexBuffer(index, 'uint32')
    rp:drawIndexed(self.sealIndexCount)
    rp:finish()
end

local function drawSeal(self: Table)
    local canvas = self.sealUnderCanvas
    local pipe = self.sealPipe
    local ubo = self.sealUnderUbo
    local bind = self.sealUnderBind
    local verts = self.sealVerts
    local index = self.sealIndex
    local depthView = self.sealDepthView
    if canvas == nil or pipe == nil or ubo == nil or bind == nil or verts == nil or index == nil or depthView == nil then
        return
    end
    -- Posed and measured in advance; here only the upload.
    local proj = Mat4.ortho(0, self.L.w, self.L.h, 0, -4000, 4000)
    local p = self.puppet
    local model = sealModel(self)
    local mvp = proj * model

    local b = self.sealBytes
    mvp:writeToBuffer(b, 0)
    model:writeToBuffer(b, 64)
    buffer.writef32(b, 128, -0.45)
    buffer.writef32(b, 132, -0.6)
    buffer.writef32(b, 136, 0.8)
    buffer.writef32(b, 140, p.split)
    buffer.writef32(b, 144, 1.0)
    buffer.writef32(b, 148, 0.96)
    buffer.writef32(b, 152, 0.9)
    buffer.writef32(b, 156, T.rim + self.energy * 0.5)
    buffer.writef32(b, 160, T.mottleSize)
    buffer.writef32(b, 164, T.mottleStrength)
    buffer.writef32(b, 168, T.mottleContrast)
    buffer.writef32(b, 172, 0.0) -- seed
    buffer.writef32(b, 176, 0.02)
    buffer.writef32(b, 180, 0.05)
    buffer.writef32(b, 184, 0.09)
    buffer.writef32(b, 188, 0.0) -- mottleCol.w, unused
    buffer.writef32(b, 196, p.behind)
    buffer.writef32(b, 200, 0)
    buffer.writef32(b, 204, 0)
    for k = 1, BONES do
        self.boneSkin[k]:writeToBuffer(b, SEAL_BONES_AT + (k - 1) * 64)
    end

    -- Which side, or sides, of the cards the animal is on this frame. It is
    -- OVER them by default and under them while a state asks for it
    -- (motion.luau's `behind`); a bite puts it on both at once, whichever
    -- side the body is on, so the card ends up inside the mouth.
    local biting = p.split > 0.01
    local behind = p.behind >= 0.5
    local overCanvas, overUbo, overBind = self.sealOverCanvas, self.sealOverUbo, self.sealOverBind
    sealPass(self, canvas, ubo, bind, pipe, verts, index, depthView, false, biting or behind)
    if overCanvas ~= nil and overUbo ~= nil and overBind ~= nil then
        sealPass(self, overCanvas, overUbo, overBind, pipe, verts, index, depthView, true, biting or not behind)
    end
end

-- Every tank on screen into the tank atlas: a slot per tank, one instanced
-- draw per species, each body carrying its slot's tile. Also fills the CRT's
-- card table, and decides the slots the mask and the ink atlas use.
--
-- The card table holds EVERY card on screen, not only the tanks: the rim is
-- drawn from the same entry the window is, so a face-down card in the fan
-- gets its edge shaded like any other. `hasTank` is what separates the two.
-- The entry index is what the mask paints, so it is also the z-order key.
local function drawFish(self: Table)
    local atlas, pipe, ubo, bind, verts, index, depthView = self.fishAtlas, self.fishPipe, self.fishUbo, self.fishBind, self.fishVerts, self.fishIndex, self.fishDepthView
    local cb = self.crtBytes
    -- Clear the card table, the slots and the entries.
    for k = 0, TANK_SLOTS * CRT_ENTRY // 4 - 1 do
        buffer.writef32(cb, CRT_HEAD + k * 4, 0)
    end
    for id = 1, 52 do
        self.slotOf[id] = 0
        self.entryOf[id] = 0
    end
    table.clear(self.slots)
    self.entries = 0
    if atlas == nil or pipe == nil or ubo == nil or bind == nil or verts == nil or index == nil or depthView == nil then
        return
    end
    for _, sp in ipairs(self.speciesList) do
        sp.n, sp.at = 0, 0
        -- The bend palette needs a row per body this species will lay out,
        -- and `cap` can have grown since the bind groups were built — the
        -- card lab moves a species onto every card at once. Idempotent: it
        -- returns immediately once the texture is big enough.
        if #sp.chains > 0 then
            RIG.ensureBend(self, sp)
        end
    end
    local n = 0
    local tileU, tileV = 1 / TILE_COLS, 1 / TILE_ROWS
    local rimMode = cardRimMode() - 1
    for _, id in ipairs(self.order) do
        if self.entries < TANK_SLOTS then
            local v = self.views[id]
            -- Every card takes an entry: the rim is keyed off it whether or
            -- not there is a tank behind the glass.
            self.entries += 1
            local entry = self.entries
            self.entryOf[id] = entry
            local e = CRT_HEAD + (entry - 1) * CRT_ENTRY
            local sx = math.abs(math.cos(v.flip * math.pi))
            -- The CRT keys the window and the rim off THIS rectangle, so it
            -- has to be the one the face is drawn at: risen by the pop, or
            -- the face lifts off its own window and every hovered card is two.
            buffer.writef32(cb, e, v.x)
            buffer.writef32(cb, e + 4, v.y + popRise(self.L, v))
            buffer.writef32(cb, e + 8, math.cos(v.rot))
            buffer.writef32(cb, e + 12, math.sin(v.rot))
            buffer.writef32(cb, e + 16, v.scale * math.max(0.02, sx))
            buffer.writef32(cb, e + 20, v.scale)
            buffer.writef32(cb, e + 44, rimMode)
            -- The tilt, the same skew cardMatrix leans the artboard by. It
            -- used to be missing here: the plate and its rank leaned with
            -- the hover and the drag while the window, the rim and the ink
            -- laid over the tank stayed flat — a second, offset card edge
            -- trailing the face, because the tilt is smoothed.
            buffer.writef32(cb, e + 64, v.tiltX)
            buffer.writef32(cb, e + 68, v.tiltY)
            -- The suit, twice: the tank's background colour, and which family
            -- the rank's glow is lit in. A card with no tanks.csv row still
            -- gets both, from its suit.
            local card = self.cardOf[id]
            local suitRed = if card ~= nil and K.isRed(card.suit) then 1 else 0
            local rec0 = self.tankOf[id]
            local bg = if rec0 ~= nil then rec0.bg else (if suitRed == 1 then SUIT_BG_RED else SUIT_BG_BLACK)
            buffer.writef32(cb, e + 48, bg[1] * T.tankBg)
            buffer.writef32(cb, e + 52, bg[2] * T.tankBg)
            buffer.writef32(cb, e + 56, bg[3] * T.tankBg)
            buffer.writef32(cb, e + 60, suitRed)
            if isTank(self, id) and #self.slots < TANK_SLOTS then
                local rec = self.tankOf[id]
                local sp = rec.species
                local ball = self.balls[id]
                if ball ~= nil and sp.inst ~= nil and sp.n + rec.count <= sp.cap then
                    table.insert(self.slots, id)
                    local slot = #self.slots
                    self.slotOf[id] = slot
                    local t = slot - 1
                    local col, row = t % TILE_COLS, t // TILE_COLS
                    local inp = tankInputs(self, rec, false, false, false, false, 0, 0, false)
                    -- THE SKELETON, before the instances are written: the
                    -- row a body lands on is its offset in the species'
                    -- buffer, which is exactly what baitball packs into the
                    -- whole-number part of anim.x for the shader to read.
                    if #sp.chains > 0 then
                        local row0 = sp.at // BAIT.STRIDE
                        local bodies = math.max(1, math.min(16, math.floor(rec.count)))
                        -- A card that moved in the order hands its row to
                        -- a different body, so the texture is stale even if
                        -- nothing bent this frame.
                        if sp.bendOrder[row0 + 1] ~= id then
                            sp.bendDirty = true
                            sp.bendOrder[row0 + 1] = id
                        end
                        for bi = 1, math.min(bodies, #ball.fish) do
                            RIG.writeBendRow(sp, ball.fish[bi], row0 + (bi - 1))
                        end
                    end
                    local next = BAIT.write(ball, inp, sp.bytes, sp.at)
                    -- The tile, in NDC (y up; row 0 is the top of the texture).
                    local ox = -1 + (col + 0.5) * 2 * tileU
                    local oy = 1 - (row + 0.5) * 2 * tileV
                    for k = sp.at, next - BAIT.STRIDE, BAIT.STRIDE do
                        buffer.writef32(sp.bytes, k + 96, ox)
                        buffer.writef32(sp.bytes, k + 100, oy)
                        buffer.writef32(sp.bytes, k + 104, tileU)
                        buffer.writef32(sp.bytes, k + 108, tileV)
                    end
                    local wrote = (next - sp.at) // BAIT.STRIDE
                    sp.n += wrote
                    sp.at = next
                    n += wrote
                    -- The bubbles this tank knocked loose, into the SPHERE's
                    -- instance buffer with this card's tile — a second species
                    -- in the same pass, not a second pass.
                    local bub = self.bubbleSpecies
                    if bub ~= nil and bub.inst ~= nil then
                        local room = math.min(BUBBLES_PER_TANK, bub.cap - bub.n)
                        if room > 0 then
                            local bnext = BAIT.writeBubbles(ball, bub.bytes, bub.at, room)
                            for k = bub.at, bnext - BAIT.STRIDE, BAIT.STRIDE do
                                buffer.writef32(bub.bytes, k + 96, ox)
                                buffer.writef32(bub.bytes, k + 100, oy)
                                buffer.writef32(bub.bytes, k + 104, tileU)
                                buffer.writef32(bub.bytes, k + 108, tileV)
                            end
                            local bwrote = (bnext - bub.at) // BAIT.STRIDE
                            bub.n += bwrote
                            bub.at = bnext
                            n += bwrote
                        end
                    end
                    -- The window's two tiles, and the flag that says it has one.
                    buffer.writef32(cb, e + 24, col * tileU)
                    buffer.writef32(cb, e + 28, row * tileV)
                    buffer.writef32(cb, e + 32, col * tileU)
                    buffer.writef32(cb, e + 36, row * tileV)
                    buffer.writef32(cb, e + 40, 1)
                end
            end
        end
    end
    self.fishInstCount = n
    if n == 0 then
        local pass = atlas:beginRenderPass({ color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } } })
        pass:finish()
        return
    end
    local ub = self.fishBytes
    local aspect = CARD_W / CARD_H
    local proj = Mat4.perspective(math.rad(CAM.fov), aspect, 0.1, 20)
    -- Straight on: the frustum's edges are the card's, and the sim's walls.
    -- The ring is tilted instead (baitball.luau) so the swirl still reads.
    local view = Mat4.lookAt(Vector.xyz(0, 0, CAM.dist), Vector.xyz(0, 0, 0), Vector.xyz(0, 1, 0))
    local vp = proj * view
    vp:writeToBuffer(ub, 0)
    buffer.writef32(ub, 64, -0.4)
    buffer.writef32(ub, 68, 0.8)
    buffer.writef32(ub, 72, 0.6)
    buffer.writef32(ub, 76, self.time)
    buffer.writef32(ub, 80, 1.0)
    buffer.writef32(ub, 84, 1.0)
    buffer.writef32(ub, 88, 0.8)
    buffer.writef32(ub, 92, 0)
    buffer.writef32(ub, 96, atlas.width)
    buffer.writef32(ub, 100, atlas.height)
    buffer.writef32(ub, 104, 0)
    buffer.writef32(ub, 108, 0)
    buffer.writef32(ub, 112, 0)
    buffer.writef32(ub, 116, 0)
    buffer.writef32(ub, 120, CAM.dist)
    buffer.writef32(ub, 124, 0)
    -- The look, live from the tuner.
    buffer.writef32(ub, 128, T.celSteps)
    buffer.writef32(ub, 132, T.celSoft)
    buffer.writef32(ub, 136, T.celShadow)
    buffer.writef32(ub, 140, T.celSpec)
    buffer.writef32(ub, 144, T.lineR)
    buffer.writef32(ub, 148, T.lineG)
    buffer.writef32(ub, 152, T.lineB)
    buffer.writef32(ub, 156, T.lineWidth)
    -- The glow's field (fish.wgsl's header has each one).
    buffer.writef32(ub, 160, T.bioScale)
    buffer.writef32(ub, 164, T.bioSpeed)
    buffer.writef32(ub, 168, T.bioCoverage)
    buffer.writef32(ub, 172, T.bioSoft)
    buffer.writef32(ub, 176, T.bioStrength)
    buffer.writef32(ub, 180, T.bioEvolve)
    buffer.writef32(ub, 184, math.rad(T.bioPan))
    buffer.writef32(ub, 188, T.bioStretch)
    buffer.writef32(ub, 192, T.bioOctaves)
    buffer.writef32(ub, 196, T.bioContrast)
    buffer.writef32(ub, 200, T.bioWarp)
    buffer.writef32(ub, 204, T.bioPulse)
    buffer.writef32(ub, 208, T.bioPulseRate)
    buffer.writef32(ub, 212, 0)
    buffer.writef32(ub, 216, 0)
    buffer.writef32(ub, 220, 0)
    -- The dent's SHAPE. How deep it goes and how it rings are per body and
    -- ride in the instance record; these four are the same on every body.
    buffer.writef32(ub, 224, T.dentSpread)
    buffer.writef32(ub, 228, T.dentWave)
    buffer.writef32(ub, 232, T.dentWaveK)
    buffer.writef32(ub, 236, T.dentWaveSpeed)
    ubo:write(ub)
    local pass = atlas:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
        depthStencil = { view = depthView, depthLoadOp = 'clear', depthStoreOp = 'discard', depthClearValue = 1 },
    })
    -- THE SKELETONS go up first and on their own, before either pass. They
    -- lived in the outline's loop for a while, which is where the instance
    -- buffers are uploaded — and that loop is skipped entirely when
    -- `lineWidth` is 0, which is the default. The bend palette then never
    -- reached the GPU on any normal frame and every animal stayed straight,
    -- with the solver running perfectly the whole time.
    for _, sp in ipairs(self.speciesList) do
        if sp.bendDirty and sp.bend ~= nil then
            sp.bendDirty = false;
            (sp.bend :: GPUTexture):upload({ data = sp.bendBytes })
        end
    end
    -- THE OUTLINE FIRST, then the bodies over it. Both write depth, so the
    -- body covers all of its own shell except the rim that pokes out.
    --
    -- The instance buffers are uploaded here, in the outline pass, and NOT
    -- again below: `inst:write` is the upload, and the second pass reads the
    -- same buffer. Writing them twice would be a second upload of the same
    -- bytes every frame for nothing.
    local linePipe = self.fishLinePipe
    if linePipe ~= nil and T.lineWidth > 0 then
        pass:setPipeline(linePipe)
        pass:setVertexBuffer(0, verts)
        pass:setIndexBuffer(index, 'uint32')
        for _, sp in ipairs(self.speciesList) do
            local inst = sp.inst
            if sp.n > 0 and inst ~= nil and sp.bind ~= nil then
                inst:write(sp.bytes, 0, 0, sp.at)
                pass:setBindGroup(0, sp.bind :: GPUBindGroup)
                pass:setVertexBuffer(1, inst)
                pass:drawIndexed(sp.indexCount, sp.n, sp.firstIndex)
            end
        end
    end
    pass:setPipeline(pipe)
    pass:setVertexBuffer(0, verts)
    pass:setIndexBuffer(index, 'uint32')
    for _, sp in ipairs(self.speciesList) do
        local inst = sp.inst
        if sp.n > 0 and inst ~= nil and sp.bind ~= nil then
            if linePipe == nil or T.lineWidth <= 0 then
                inst:write(sp.bytes, 0, 0, sp.at)
            end
            -- The species' own palette rides in its bind group.
            pass:setBindGroup(0, sp.bind :: GPUBindGroup)
            pass:setVertexBuffer(1, inst)
            pass:drawIndexed(sp.indexCount, sp.n, sp.firstIndex)
        end
    end
    pass:finish()
end

-- The mask the CRT keys the cards by: every card's whole rounded rectangle
-- painted with its ENTRY in the card table, in z-order, so a card above
-- covers the one under it. Same transforms as the cards. The CRT reads this
-- with a nearest sampler — it is an index, not a picture.
local function drawMask(self: Table)
    local mask = self.maskCanvas
    if mask == nil or mask.width == 0 then
        return
    end
    local r = mask:beginFrame({ clearColor = Color.rgba(0, 0, 0, 0) })
    r:save()
    r:transform(Mat2D.withScale(self.scale, self.scale))
    for _, id in ipairs(self.order) do
        local v = self.views[id]
        local sx = math.max(0.02, math.abs(math.cos(v.flip * math.pi)))
        r:save()
        r:transform(cardMatrix(self.L, v, sx))
        r:transform(Mat2D.withTranslation(CARD_W / 2, CARD_H / 2))
        -- No entry (the card table was never filled — no fish pipeline this
        -- frame) means no row for the CRT to read: leave the mask at 0 rather
        -- than pointing every card at a zeroed row, whose centre and scale
        -- would put a rim somewhere the cards are not.
        local entry = self.entryOf[id]
        if entry > 0 then
            r:drawPath(self.tankPaths, self.entryPaint[entry])
        end
        r:restore()
    end
    r:restore()
    mask:endFrame()
end

-- The ink atlas: each slot's card face with the plate hidden, in its tile,
-- for the CRT to lay over the tank.
local function drawInk(self: Table)
    local canvas = self.inkCanvas
    if canvas == nil or canvas.width == 0 then
        return
    end
    local r = canvas:beginFrame({ clearColor = Color.rgba(0, 0, 0, 0) })
    local tw = canvas.width / TILE_COLS
    local th = canvas.height / TILE_ROWS
    for slot, id in ipairs(self.slots) do
        local ink = self.views[id].ink
        if ink ~= nil then
            local t = slot - 1
            local col, row = t % TILE_COLS, t // TILE_COLS
            r:save()
            r:transform(Mat2D.withTranslation(col * tw, row * th))
            r:transform(Mat2D.withScale(tw / CARD_W, th / CARD_H))
            ink:draw(r)
            r:restore()
        end
    end
    canvas:endFrame()
end

-- The tuner. NOT part of the table: it is drawn straight onto the artboard's
-- renderer, after the CRT pass has already been laid down as an image, so
-- nothing the CRT composites can land on top of it and none of the CRT's own
-- treatment lands on it either.
--
-- Both halves of that matter. It used to go into the scene canvas with the
-- cards, which put it UNDER every tank window — the CRT keys those in after
-- the scene — so a panel opened over the tableau was a panel with cards
-- printed through it. And even clear of the cards it was being read through
-- the barrel curve, the scanlines and the chromatic split, which is exactly
-- the wrong treatment for 89 rows of 11px numbers.
--
-- The cost is that the tuner is the one surface NOT on the curved screen, so
-- it is hit-tested in RAW pointer coordinates while everything else goes
-- through `throughCurve`. That is the whole reason `pointerDown` carries two
-- points; near the corners the two are tens of pixels apart.
local function drawTuner(self: Table, r: Renderer)
    if not self.tunerOpen then
        return
    end
    local tn = self.L.tuner
    r:save()
    r:transform(Mat2D.withTranslation(tn.x + (tn.colW * tn.cols + tn.gutter) / 2, tn.y + tn.maxH / 2))
    r:drawPath(self.panelPath, self.panelPaint)
    r:restore()
    if self.tunerReach > 0 then
        -- The thumb: how much of the list is showing, and where.
        local top, bottom = tunerBand(self)
        local band = math.max(1, bottom - top)
        local frac = band / (band + self.tunerReach)
        local at = self.tunerScroll / self.tunerReach
        r:save()
        r:transform(Mat2D.withTranslation(tn.x + tn.gutter / 2, top + (band - band * frac) * at + band * frac / 2))
        r:transform(Mat2D.withScale(tn.gutter * 0.3, band * frac / 2))
        r:drawPath(self.bubblePath, self.thumbPaint)
        r:restore()
    end
    for _, it in ipairs(self.tunerItems) do
        -- The panel has no clip of its own, so a row outside the band is not
        -- drawn at all: half a slider floating over the table reads as a bug
        -- rather than as a list that is scrolled.
        if not tunerShows(self, it) then
            continue
        end
        r:save()
        r:transform(Mat2D.withTranslation(it.x, it.y))
        r:transform(Mat2D.withScale(tn.scale, tn.scale))
        -- Rows and heads are different artboard types, so each kind draws
        -- its own; one variable of both types is a call Luau cannot type.
        if it.kind == 'row' or it.kind == 'srow' then
            local inst = if it.kind == 'row' then self.tunerRows[it.i] else self.subjectRows[it.i]
            if inst ~= nil then
                inst:draw(r)
            end
        else
            local head = if it.kind == 'shead' then self.subjectHead elseif it.kind == 'suit' then self.suitHead else self.tunerHeads[it.i]
            if head ~= nil then
                head:draw(r)
            end
        end
        r:restore()
    end
end

-- The chrome, each artboard translated to its own corner and scaled by
-- `L.ui`. It is drawn as a BLOCK per corner rather than laid out here,
-- because text is markup-only: the script can place an artboard, not a word.
local function drawChrome(self: Table, r: Renderer)
    local g = self.L
    local rects: { LAYOUT.Rect } = { g.title, g.stats, g.button }
    local tx, ty = LAYOUT.titleAt(g)
    for i, inst in ipairs(self.hudInst) do
        local rect = rects[i]
        if rect ~= nil then
            r:save()
            -- The title's hot zone reaches the screen's corner; the wordmark
            -- sits inside it, so it is the one block placed at its own point
            -- rather than at its rectangle.
            if i == 1 then
                r:transform(Mat2D.withTranslation(tx, ty))
            else
                r:transform(Mat2D.withTranslation(rect.x, rect.y))
            end
            r:transform(Mat2D.withScale(g.ui, g.ui))
            inst:draw(r)
            r:restore()
        end
    end
end

-- FADE A DRAW, WHERE THE RUNTIME HAS IT. `Renderer.modulateOpacity` is in the
-- CLI's renderer and NOT in the web one, and calling a method that is not
-- there raises — which, inside drawCards, aborts the loop before a single
-- card is drawn. That presents as slot outlines on an empty table, i.e.
-- exactly like the deal never happening, which is a long way from "the
-- shadows are missing".
--
-- Probed once rather than guarded per call: the binding logs its own error
-- every time, and this runs per card per frame. A runtime without it draws
-- the shadows and the bubbles at full strength, which is wrong and visible,
-- and still a table you can play.
local canModulate: boolean? = nil
local function modulate(r: Renderer, alpha: number)
    if canModulate == false then
        return
    end
    local ok = pcall(function()
        r:modulateOpacity(alpha)
    end)
    if canModulate == nil then
        canModulate = ok
        if not ok then
            print('sealitaire: this runtime has no Renderer.modulateOpacity; shadows draw unfaded')
        end
    end
end

local function drawSlot(self: Table, r: Renderer, x: number, y: number)
    r:save()
    r:transform(Mat2D.withTranslation(x, y))
    r:drawPath(self.slotPath, self.slotPaint)
    r:restore()
end

-- THE PAD'S CURSOR. Drawn against the card's LIVE position rather than its
-- target, so the ring rides the spring in with the card it has just landed
-- on instead of arriving a beat early and waiting; and against `popRise`,
-- because that is where the face is and the ring has to sit on the face.
--
-- With a run in hand it marks the DESTINATION — the slot the cards are flying
-- to — which is the whole of what the cursor means while something is held.
function Pad.draw(self: Table, r: Renderer)
    local drag = self.drag
    if not self.pad.on and (drag == nil or not drag.pad) then
        return
    end
    local g = self.L
    local cur = self.pad.cursor
    local pile = PAD.pileAt(self.game, cur)
    local x, y
    if drag ~= nil and drag.pad then
        if pile == nil or pile == drag.pile then
            x, y = slotFor(g, drag.pile, drag.index)
        else
            x, y = Pad.landing(self, pile)
        end
    elseif pile ~= nil and self.pad.grab > 0 and pile.cards[self.pad.grab] ~= nil then
        local v = self.views[pile.cards[self.pad.grab].id]
        x, y = v.x, v.y + popRise(g, v)
    elseif pile ~= nil and #pile.cards > 0 then
        local v = self.views[pile.cards[#pile.cards].id]
        x, y = v.x, v.y + popRise(g, v)
    elseif pile ~= nil then
        x, y = pileOrigin(g, pile)
    else
        x, y = LAYOUT.colX(g, cur.col), g.topY
    end
    -- Live, not built with the path: these are sliders, and a ring rebuilt
    -- only on a resize would not move until the window was dragged.
    self.padPaint.thickness = T.padRing * g.fit
    self.padPaint.feather = T.padGlow * g.fit
    r:save()
    r:transform(Mat2D.withTranslation(x, y))
    r:drawPath(self.padRing, self.padPaint)
    r:restore()
end

local function drawCards(self: Table, r: Renderer)
    -- Empty slots first, so a card covers them.
    local g = self.L
    drawSlot(self, r, LAYOUT.colX(g, 1), g.topY)
    drawSlot(self, r, LAYOUT.colX(g, 2), g.topY)
    for f = 1, 4 do
        drawSlot(self, r, LAYOUT.colX(g, 3 + f), g.topY)
    end
    for col = 1, COLS do
        drawSlot(self, r, LAYOUT.colX(g, col), g.tabY)
    end
    if #self.game.stock.cards == 0 then
        r:save()
        r:transform(Mat2D.withTranslation(LAYOUT.colX(g, 1), g.topY))
        r:drawPath(self.stockGlyph, self.stockPaint)
        r:restore()
    end

    for _, id in ipairs(self.order) do
        local v = self.views[id]
        local angle = v.flip * math.pi
        local sx = math.abs(math.cos(angle))
        local faceUp = math.cos(angle) < 0
        if sx < 0.02 then
            sx = 0.02
        end
        local m = cardMatrix(g, v, sx)

        -- Shadow, offset by the lift. A resting card casts almost nothing —
        -- the rim is what separates it from the water now, and a hard navy
        -- edge under every card in the fan read as dirt. What is left is the
        -- LIFT: a card picked up or in flight earns its shadow.
        r:save()
        r:transform(Mat2D.withTranslation(v.x + v.lift * 0.5, v.y + popRise(g, v) + v.lift))
        r:transform(Mat2D.withRotation(v.rot))
        r:transform(Mat2D.withScale(v.scale * sx, v.scale))
        modulate(r, (0.05 + math.min(v.lift, 24 * g.fit) / (24 * g.fit) * 0.28) * T.cardShadow)
        r:drawPath(self.shadowPath, self.shadowPaint)
        r:restore()

        -- Glow ring on the hovered card.
        if self.hovered == id then
            r:save()
            r:transform(Mat2D.withTranslation(v.x, v.y + popRise(g, v)))
            r:transform(Mat2D.withRotation(v.rot))
            r:transform(Mat2D.withScale(v.scale * sx, v.scale))
            r:drawPath(self.glowPath, self.glowPaint)
            r:restore()
        end

        r:save()
        r:transform(m)
        if faceUp then
            local inst = v.inst
            if inst ~= nil then
                inst:draw(r)
            end
        else
            local backInst = self.backInst
            if backInst ~= nil then
                backInst:draw(r)
            end
        end
        r:restore()
    end

    -- Last, so it is over every card. It belongs to the CARD layer rather
    -- than to the chrome: it is a thing on the table, and it goes through the
    -- barrel curve with the cards it is pointing at.
    Pad.draw(self, r)
end

local function draw(self: Table, renderer: Renderer)
    local scene = self.scene
    local screen = self.screen
    local inv = 1 / self.scale

    if self.gpu and scene ~= nil and scene.width > 0 then
        drawWater(self)
        drawGoo(self)
        drawFoam(self)
        drawSurface(self)
        if self.sealReady then
            drawSeal(self)
        end
        if self.fishReady then
            drawFish(self)
        end
        drawMask(self)
        drawInk(self)

        -- The cards into the 2-D scene canvas, at device pixels, over nothing:
        -- the CRT pass lays this over the water and the seal.
        local r = scene:beginFrame({ clearColor = Color.rgba(0, 0, 0, 0) })
        r:save()
        r:transform(Mat2D.withScale(self.scale, self.scale))
        -- Bubbles, under the cards.
        local nb = math.floor(clamp(T.bubbleCount, 0, MAX_BUBBLES))
        for k = 1, nb do
            local bb = self.bubbles[k]
            local rad = bb.r * T.bubbleSize * self.L.fit
            r:save()
            r:transform(Mat2D.withTranslation(bb.x, bb.y))
            r:transform(Mat2D.withScale(rad, rad))
            modulate(r, 0.35 + bb.r * 0.5)
            r:drawPath(self.bubblePath, self.bubblePaint)
            r:transform(Mat2D.withTranslation(-0.38, -0.38))
            r:transform(Mat2D.withScale(0.22, 0.22))
            r:drawPath(self.bubblePath, self.bubbleShine)
            r:restore()
        end
        -- The seal's own, with the ambient column and in the same ink. This
        -- canvas is laid over the water AND the seal by the CRT pass and under
        -- nothing but the cards, so they read as rising in front of the animal
        -- that made them and behind the hand that is playing.
        local sys = self.bub
        local pspec = BUB.drawSpec()
        for k = 1, sys.n do
            local q = sys.puffs[k]
            local rad = BUB.radius(q, pspec) * self.L.fit
            r:save()
            r:transform(Mat2D.withTranslation(q.x, q.y))
            r:transform(Mat2D.withScale(rad, rad))
            modulate(r, BUB.alpha(q) * 0.8)
            r:drawPath(self.bubblePath, self.bubblePaint)
            r:transform(Mat2D.withTranslation(-0.38, -0.38))
            r:transform(Mat2D.withScale(0.22, 0.22))
            r:drawPath(self.bubblePath, self.bubbleShine)
            r:restore()
        end
        drawCards(self, r)
        drawChrome(self, r)
        r:restore()
        scene:endFrame()

        -- The CRT pass composites the three layers and writes the screen.
        local crtPipe, crtUbo, crtBind, crtBindInk = self.crtPipe, self.crtUbo, self.crtBind, self.crtBindInk
        if screen ~= nil and crtPipe ~= nil and crtUbo ~= nil and crtBind ~= nil and crtBindInk ~= nil then
            local b = self.crtBytes
            local g = self.L
            buffer.writef32(b, 0, screen.width)
            buffer.writef32(b, 4, screen.height)
            buffer.writef32(b, 8, self.time)
            buffer.writef32(b, 12, self.energy)
            buffer.writef32(b, 16, T.curve)
            buffer.writef32(b, 20, T.scanlines)
            buffer.writef32(b, 24, T.aberration)
            buffer.writef32(b, 28, T.vignette)
            -- Where the seal's canvas sits, in screen uv.
            buffer.writef32(b, 32, 0)
            buffer.writef32(b, 36, 0)
            buffer.writef32(b, 40, 1)
            buffer.writef32(b, 44, 1)
            -- The artboard and the card, the two atlases' tiles, and the
            -- plate's corner, for the tank compositor.
            buffer.writef32(b, 48, g.w)
            buffer.writef32(b, 52, g.h)
            buffer.writef32(b, 56, g.cw / 2)
            buffer.writef32(b, 60, g.ch / 2)
            buffer.writef32(b, 64, 1 / TILE_COLS)
            buffer.writef32(b, 68, 1 / TILE_ROWS)
            buffer.writef32(b, 72, 1 / TILE_COLS)
            buffer.writef32(b, 76, 1 / TILE_ROWS)
            buffer.writef32(b, 80, g.radius)
            -- The rim and the glow behind a rank are both measured on a card,
            -- so both ride `fit`. Left in artboard px the rim would be a
            -- third of a phone card's width.
            buffer.writef32(b, 84, T.cardRimWidth * g.fit)
            buffer.writef32(b, 88, T.cardRim)
            buffer.writef32(b, 92, self.beat)
            -- The metal (crt.wgsl rows 6 and 7: the metallic and chrome rims).
            buffer.writef32(b, 96, T.metalTint)
            buffer.writef32(b, 100, T.metalBody)
            buffer.writef32(b, 104, T.metalGrain)
            buffer.writef32(b, 108, T.metalGrainLines)
            buffer.writef32(b, 112, T.metalGlint)
            buffer.writef32(b, 116, T.metalGlintWidth)
            buffer.writef32(b, 120, T.metalMirror)
            buffer.writef32(b, 124, T.metalSeam)
            -- The tank's scanlines (row 8).
            buffer.writef32(b, 128, T.tankScan)
            buffer.writef32(b, 132, T.tankScanPitch)
            buffer.writef32(b, 136, T.tankScanScroll)
            buffer.writef32(b, 140, T.tankScanBg)
            crtUbo:write(b)
            local pass = screen:beginRenderPass({
                color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 1 } } },
            })
            pass:setPipeline(crtPipe)
            pass:setBindGroup(0, crtBind)
            pass:setBindGroup(1, crtBindInk)
            pass:draw(3)
            pass:finish()
            renderer:save()
            renderer:transform(Mat2D.withScale(inv, inv))
            renderer:drawImage(screen.image, self.sampler, 'srcOver', 1)
            renderer:restore()
            drawTuner(self, renderer)
        else
            local img = scene.image
            if img ~= nil then
                renderer:save()
                renderer:transform(Mat2D.withScale(inv, inv))
                renderer:drawImage(img, self.sampler, 'srcOver', 1)
                renderer:restore()
            end
            drawTuner(self, renderer)
        end
    else
        -- No GPU canvas (the headless verify, an old runtime): flat table.
        drawCards(self, renderer)
        drawChrome(self, renderer)
        drawTuner(self, renderer)
    end
end

return function(context: Context): Layout<Table>
    local boneParent: { number } = {}
    local boneLocal: { Mat4 } = {}
    local boneIbm: { Mat4 } = {}
    local boneWorld: { Mat4 } = {}
    local boneSkin: { Mat4 } = {}
    local bubbles: { Bubble } = {}
    for k = 1, MAX_BUBBLES do
        bubbles[k] = { x = math.random() * W0, y = H0 + math.random() * H0, r = 0.4 + math.random() * 0.6, vy = 0.7 + math.random() * 0.6, phase = math.random() * 6.28, wobble = 0.5 + math.random() }
    end
    local balls: { BAIT.Ball } = {}
    local entryPaint: { Paint } = {}
    for entry = 1, TANK_SLOTS do
        -- The mask encodes the entry in red, spaced by 4 so a byte of 8-bit
        -- red survives the round trip (56 entries: every card can have one).
        entryPaint[entry] = Paint.with({ color = Color.rgba(entry * 4, 0, 0, 255), style = 'fill' })
    end
    local slotOf: { number } = {}
    for id = 1, 52 do
        slotOf[id] = 0
    end
    return {
        faceA = late(), face2 = late(), face3 = late(), face4 = late(),
        face5 = late(), face6 = late(), face7 = late(), face8 = late(),
        face9 = late(), face10 = late(), faceJ = late(), faceQ = late(),
        faceK = late(),
        back = late(),
        hudTitle = late(), hudStats = late(), hudDeal = late(),
        hudInst = {},
        tunerRow = late(),
        tunerHead = late(),
        tunerRows = {}, tunerRowVm = {}, tunerHeads = {}, tunerHeadVm = {},
        tunerCats = {}, tunerCatRows = {}, tunerCatOpen = {}, tunerItems = {}, tunerSpillTold = false,
        tunerOpen = false,
        tunerDrag = 0, tunerDragKind = 'row',
        subject = 0, subjectOpen = false, subjectRows = {}, subjectRowVm = {},
        subjectHead = nil, subjectHeadVm = nil, suitHead = nil, suitHeadVm = nil,
        pool = {}, tankOrig = {}, tankDirty = {}, lab = '',
        tunerScroll = 0, tunerReach = 0, tunerPan = -1, tunerPanFrom = 0,
        panelPath = Path.new(),
        -- Nearly opaque. It was 216 when the panel lived in the scene canvas
        -- under the cards, where a little transparency cost nothing; drawn
        -- over the finished screen it is the only thing between 93 rows of
        -- 11px numbers and a moving table, so it hides almost all of it.
        panelPaint = Paint.with({ color = Color.rgba(6, 22, 40, 240), style = 'fill' }),
        -- The gutter's thumb: the unit circle scaled into a lozenge.
        thumbPaint = Paint.with({ color = Color.rgba(185, 212, 238, 150), style = 'fill' }),
        stockHovered = false, stockFan = 0, stockPulse = 0,

        puppet = PUPPET.new(W0 * 0.1875, H0 * 0.76),
        bitten = 0, biteSide = 1, releaseT = -1,
        clips = {},
        sealData = nil,
        boneAnim = {},

        context = nil,
        L = LAYOUT.compute(W0, H0),
        size = Vector.xy(W0, H0),
        scale = 1,
        time = 0,
        dealTime = 0,

        game = K.new(1),
        views = {},
        order = {},
        orderDirty = true,
        backInst = nil,

        pointer = Vector.xy(W0 / 2, H0 / 2),
        pointerKnown = false,
        hovered = 0, popped = {}, reactSeq = 0, reactVariant = '', reactLast = '',
        hoverRaw = 0, hoverPending = 0, hoverSince = 0,
        drag = nil,
        lastDownId = 0,
        lastDownTime = -10,
        dealSeed = 0,

        gestureId = -1,
        touchOn = false,
        freeMove = Vector.xy(-1e6, -1e6),

        pad = PAD.newState(),
        padRing = Path.new(),
        -- The same warm gold the hover's glow is, at half its weight: the two
        -- are on the same card most of the time a pad is in use and a second
        -- hue there would read as a second state.
        padPaint = Paint.with({ color = Color.rgba(255, 226, 150, 235), style = 'stroke', thickness = 3.5, feather = 6 }),

        movesProp = nil,
        scoreProp = nil,
        clockProp = nil,

        goo = PUDDLE.new(),
        bubbles = bubbles,
        bubblePath = Path.new(),
        bubblePaint = Paint.with({ color = Color.rgba(205, 240, 255, 150), style = 'stroke', thickness = 0.14 }),
        bubbleShine = Paint.with({ color = Color.rgba(255, 255, 255, 170), style = 'fill' }),
        energy = 0,
        ripples = {},
        musicRipples = {},
        music = MUSIC.new(),
        sound = nil,
        musicSource = nil,
        musicTried = false,
        muted = false, muteWas = 0.5,
        sfxIndex = 0, sfxSound = nil, sfxRecent = {}, dealt = false, sfx = {}, sfxBank = {}, sfxMissing = {}, fanWasUp = false,
        hoverSound = nil, hoverVol = 0, hoverFade = 0,
        auraSound = nil, auraTake = '', auraLevel = 0,
        fanX = 0, fanY = 0,
        knockBest = 0, knockCard = 0, knockLen = 0, knockLast = -1000,
        musicTime = 0, soundLast = -1, soundStill = 0, beat = 0,
        vortexCentre = Vector.xy(0.5, 0.55),
        win = -1,

        shadowPath = Path.new(),
        shadowPaint = Paint.with({ color = Color.rgba(0, 10, 30, 255), style = 'fill', feather = 16 }),
        slotPath = Path.new(),
        slotPaint = Paint.with({ color = Color.rgba(180, 230, 255, 70), style = 'stroke', thickness = 2 }),
        glowPath = Path.new(),
        glowPaint = Paint.with({ color = Color.rgba(255, 214, 120, 200), style = 'stroke', thickness = 5, feather = 8 }),
        stockGlyph = Path.new(),
        stockPaint = Paint.with({ color = Color.rgba(180, 230, 255, 120), style = 'stroke', thickness = 4, cap = 'round' }),
        sampler = ImageSampler('clamp', 'clamp', 'bilinear'),

        gpu = false,
        scene = nil, water = nil, screen = nil, sealUnderCanvas = nil, sealOverCanvas = nil, sealDepth = nil, sealDepthView = nil,
        sealOverUbo = nil, sealOverBind = nil, mouthDx = 0, mouthDy = -120,
        waterPipes = {}, waterBinds = {}, waterUbo = nil, waterBytes = buffer.create(48 + 16 * 16),
        gooCanvas = nil, gooPipe = nil, gooUbo = nil, gooBind = nil, gooBytes = buffer.create(PUDDLE.UBO_SIZE), gooSampler = nil,
        surfaceCanvas = nil, surfacePipe = nil, surfaceUbo = nil, surfaceBind = nil, surfaceBindB = nil, surfaceBytes = buffer.create(112 + 16 * 16),
        foamA = nil, foamB = nil, foamPipe = nil, foamBytes = buffer.create(PUDDLE.FOAM_UBO_SIZE),
        foamUbos = {}, foamBindsA = {}, foamBindsB = {},
        foamParity = 0, foamFresh = true, foamTime = -1,
        crtPipe = nil, crtUbo = nil, crtBind = nil, crtBindInk = nil, crtBytes = buffer.create(CRT_UBO), crtSampler = nil, crtPoint = nil,
        fishReady = false,
        fishPipe = nil, fishLinePipe = nil, fishUbo = nil, fishBind = nil, fishBytes = buffer.create(FISH_UBO), fishBindLayout = nil,
        fishVerts = nil, fishIndex = nil, fishIndexCount = 0,
        species = {}, speciesList = {}, bubbleSpecies = nil, tankOf = {}, slotOf = slotOf, slots = {}, entryOf = {}, entries = 0, fishInstCount = 0,
        fishAtlas = nil, fishDepth = nil, fishDepthView = nil,
        inkCanvas = nil,
        maskCanvas = nil,
        balls = balls, tankSeen = {}, cardOf = {}, pressedCard = 0, played = {},
        tankPaths = Path.new(), entryPaint = entryPaint,
        sealPipe = nil, sealUnderUbo = nil, sealUnderBind = nil, sealBytes = buffer.create(SEAL_UBO),
        sealVerts = nil, sealIndex = nil, sealIndexCount = 0,
        boneParent = boneParent, boneLocal = boneLocal, boneIbm = boneIbm, boneWorld = boneWorld, boneSkin = boneSkin,
        boneScratch = Mat4.identity(),
        neckSlots = {},
        gazeYaw = 0, gazeVYaw = 0, gazePitch = 0, gazeVPitch = 0,
        gazeTargetYaw = 0, gazeTargetPitch = 0,
        finPick = { 0, 0 }, finWant = { 0, 0 },
        swipeT = -1,
        biteEase = -1, biteOffX = 0, biteOffY = 0,
        bub = BUB.new(260, 20260921),
        shedBones = {}, shedBind = {}, shedSpread = {},
        shedLastX = {}, shedLastY = {}, shedWarm = false, bubSeq = 0,
        finAimX = { 0, 0 }, finAimY = { 0, 0 },
        finAimVX = { 0, 0 }, finAimVY = { 0, 0 },
        finOn = { 0, 0 }, finOnV = { 0, 0 },
        playCards = {}, playsGame = nil, playsMoves = -1,
        sealReady = false,

        init = init,
        resize = resize,
        advance = advance,
        draw = draw,
        pointerDown = pointerDown,
        pointerMove = pointerMove,
        pointerUp = pointerUp,
        pointerExit = pointerExit,
        gamepadConnected = Pad.connected,
        gamepadDisconnected = Pad.disconnected,
        gamepadEvent = Pad.event,
        keyboardEvent = keyboardEvent,
    }
end
