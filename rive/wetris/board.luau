-- ============================================================================
-- WETRIS — the board: everything you can see and every key and finger.
--
-- The rules are wetris.luau, pure and proved by tests.luau; this file owns
-- time, input and pixels — the same split as sealitaire's klondike.luau and
-- table.luau.
--
-- THE WATER IS SEALITAIRE'S. goo.wgsl, foam.wgsl and surface.wgsl are
-- copies of rive/sealitaire's (test:wetrisshared), and whirl.wgsl is its
-- vortex forked only to expose its constants, so the two games draw the
-- same sea with the same code, and the numbers in `T`
-- below are sealitaire's tuned defaults. The passes run in sealitaire's
-- order, each into its own GPU canvas:
--
--   whirl    the water, full screen, spun and rung by ripples (the vortex)
--   goo      the stack's silhouette as one blob of clinging water (half size;
--            puddle.luau says what is in it), refracting the vortex
--   foam     the whitewater sim, ping-ponged: lock fronts, drop streaks
--   surface  the lit sheet over all three — the finished water picture
--   crt      the compositor: that water, the 2-D scene over it (blocks, well,
--            readout), then the screen treatment sealitaire ends in
--
-- THE SEAL IS SEALITAIRE'S TOO (swimmer.luau): it holds station beside the well,
-- points a flipper at the live piece, and flicks it for every move and turn
-- the player makes — keys, touch or a pad. A line clear sends it out to
-- celebrate. It is drawn into its own canvas and laid over the scene by
-- crt.wgsl.
--
-- If the GPU canvases cannot be made (an old runtime, a headless verify) the
-- board draws flat on navy and plays the same — the same fallback table.luau
-- keeps.
--
-- The artboard is fill-sized, like sealitaire's: the size `resize` hands us is
-- the window's and one artboard unit is one CSS px.
-- ============================================================================

local WET = require('wetris')
local PUDDLE = require('puddle')
local SEAL = require('swimmer')
local TUNER = require('tuner')
local INK = require('ink')
local DRIPS = require('drips')
local TILES = require('tiles')
local SOUND = require('sound')
local MUSIC = require('music')

-- Key codes arrive as GLFW's in the CLI viewer (Backspace is 259, the arrows
-- 262-265) and letters as their ASCII capital either way. The arrows are also
-- matched on the DOM's 37-40 so a runtime that forwards keyCode still plays;
-- nothing else on a keyboard sends those. ONE TABLE, not a local per key —
-- sealitaire ran out of local registers doing the other thing.
local KEY = {
    LEFT = 263, RIGHT = 262, DOWN = 264, UP = 265,
    DOM_LEFT = 37, DOM_UP = 38, DOM_RIGHT = 39, DOM_DOWN = 40,
    SPACE = 32,
    Z = 90, X = 88, C = 67, N = 78, P = 80, T = 84,
    SHIFT = 340,
}

-- THE LIVE VALUES: every slider in tuning.luau by key. The tuner panel (T
-- or a click on the score) moves them and SAVE writes them back to the file
-- through tools/wetris-tune.mjs — `npm run wetris` runs the viewer inside it.
local T = TUNER.T

-- The goo's px numbers were tuned against a 120px card. A cell is smaller
-- than a card and the stack is one continuous body, so the goo is scaled by
-- the CELL (REF_CELL is the cell at which sealitaire's skirt and wobble read
-- right on a block) and the blend is in CELLS (`gooBlend`): at a card's 76px
-- every piece would fuse with the stack two rows early and the well would be
-- one puddle.
local REF_CELL = 45

local FOAM_STEPS = 3
-- whirl.wgsl's block: the vortex's 3 rows and 16 ripples, then its own 6.
local WHIRL_UBO = 48 + 16 * 16 + 6 * 16

-- The piece colours are ink.luau's, which also runs them together in the stack.
local KIND_RGB = INK.RGB

local MAX_BUBBLES = 48

type Bubble = { x: number, y: number, r: number, vy: number, phase: number }
type Ripple = { x: number, y: number, age: number, strength: number }

-- The gamepad, as sealitaire's pad.luau reads one: the whole device state per
-- event, button edges diffed against the last, the direction held as -1/0/1
-- and repeated on the board's clock (a held stick sends no more events).
type Pad = {
    state: { [string]: boolean },
    x: number, y: number,
    lastX: number,
    holdX: number,
}

type Board = {
    hud: Input<Artboard<Data.Board>>,
    tunerRow: Input<Artboard<Data.TunerRow>>,
    tunerHead: Input<Artboard<Data.TunerHead>>,
    panel: TUNER.Panel,
    panelGesture: boolean,
    hudInst: Artboard<Data.Board>?,

    context: Context?,
    size: Vector,
    scale: number,
    time: number,

    game: WET.Game,
    seed: number,
    paused: boolean,
    fallT: number,
    lockGrace: number,
    lockResets: number,     -- moves and turns that have reset the lock delay this piece
    lowestRow: number,      -- the deepest row this piece has reached
    softDrop: boolean,
    flash: number,
    flashRows: { number },

    -- The live piece as drawn: where it is in the rules, plus an offset that
    -- springs to zero, so a step down or sideways glides instead of snapping.
    -- The glide is what gives the goo and the foam a velocity to answer.
    lastKind: number, lastCol: number, lastRow: number, lastLocks: number,
    offX: number, offY: number,
    rotOff: number,                 -- radians the drawn piece still has to turn
    cellAt: { { number } },         -- the piece's cell centres as drawn this frame
    cellVel: { { number } },        -- ...and how fast each is moving, px/s
    drips: DRIPS.Drips,
    sound: SOUND.Sound,
    music: MUSIC.Music,
    wasOver: boolean,
    pieceFresh: boolean,            -- a new piece this frame: drops on the old one let go
    visX: number, visY: number, visVx: number, visVy: number,

    cell: number,
    ox: number,
    oy: number,

    bubbles: { Bubble },
    ripples: { Ripple },
    energy: number,
    goo: PUDDLE.Goo,
    ink: INK.Ink,
    stack: Canvas?,
    stackCellPath: Path,
    stackPaint: Paint,
    seal: SEAL.Seal,
    sealSide: number,
    reactSeq: number,
    reactVariant: string,
    pad: Pad,

    gestureId: number,
    downAt: Vector,
    downTime: number,
    dragCols: number,
    dragRows: number,

    scoreProp: any,
    linesProp: any,
    levelProp: any,
    labProp: any,
    -- THE READOUT'S LIFE: the score as shown (it counts up to the real one),
    -- the pop a clear gives the whole readout (a spring back to 0), and the
    -- ring a level-up throws off the level badge.
    shownScore: number,
    pop: number, popV: number,
    glow: number,            -- the warm light behind the score: its own slower fade
    levelFlash: number,
    hudPath: Path, glowPaint: Paint, barOnPaint: Paint, barOffPaint: Paint, ringPaint: Paint, bedPaint: Paint,
    labDone: boolean,

    -- The GPU side, all nil until resize builds it.
    gpu: boolean,
    scene: Canvas?,
    water: GPUCanvas?,
    screen: GPUCanvas?,
    waterPipe: GPUPipeline?, waterUbo: GPUBuffer?, waterBind: GPUBindGroup?, waterBytes: buffer,
    gooCanvas: GPUCanvas?, gooPipe: GPUPipeline?, gooUbo: GPUBuffer?, gooBind: GPUBindGroup?, gooBytes: buffer,
    sampler: GPUSampler?,
    foamA: GPUCanvas?, foamB: GPUCanvas?, foamPipe: GPUPipeline?, foamBytes: buffer,
    foamUbos: { GPUBuffer }, foamBindsA: { GPUBindGroup }, foamBindsB: { GPUBindGroup },
    foamParity: number, foamFresh: boolean, foamTime: number,
    surfaceCanvas: GPUCanvas?, surfacePipe: GPUPipeline?, surfaceUbo: GPUBuffer?,
    surfaceBind: GPUBindGroup?, surfaceBindB: GPUBindGroup?, surfaceBytes: buffer,
    crtPipe: GPUPipeline?, crtUbo: GPUBuffer?, crtBind: GPUBindGroup?, crtBytes: buffer,
    imageSampler: ImageSampler,

    wellPath: Path,
    wellPaint: Paint,
    floorPaint: Paint,
    cellPaths: { Path },
    cellPaints: { Paint },
    shinePath: Path,
    shinePaint: Paint,
    shadowPath: Path,
    shadowPaint: Paint,
    ghostPath: Path,
    ghostPaint: Paint,
    flashPath: Path,
    flashPaint: Paint,
    bubblePath: Path,
    bubblePaint: Paint,
    veilPaint: Paint,
    veilPath: Path,
}

local function clamp(v: number, lo: number, hi: number): number
    return if v < lo then lo elseif v > hi then hi else v
end

-- Corners as cubics at the circle constant: quadTo reads as a chamfer at cell
-- size, which turned every block into an octagon.
local K = 0.5523

local function roundRect(path: Path, x: number, y: number, w: number, h: number, r: number)
    local x1, y1 = x + w, y + h
    local k = r * (1 - K)
    path:moveTo(Vector.xy(x + r, y))
    path:lineTo(Vector.xy(x1 - r, y))
    path:cubicTo(Vector.xy(x1 - k, y), Vector.xy(x1, y + k), Vector.xy(x1, y + r))
    path:lineTo(Vector.xy(x1, y1 - r))
    path:cubicTo(Vector.xy(x1, y1 - k), Vector.xy(x1 - k, y1), Vector.xy(x1 - r, y1))
    path:lineTo(Vector.xy(x + r, y1))
    path:cubicTo(Vector.xy(x + k, y1), Vector.xy(x, y1 - k), Vector.xy(x, y1 - r))
    path:lineTo(Vector.xy(x, y + r))
    path:cubicTo(Vector.xy(x, y + k), Vector.xy(x + k, y), Vector.xy(x + r, y))
    path:close()
end

local function ellipse(path: Path, x: number, y: number, rx: number, ry: number)
    local kx, ky = rx * K, ry * K
    path:moveTo(Vector.xy(x + rx, y))
    path:cubicTo(Vector.xy(x + rx, y + ky), Vector.xy(x + kx, y + ry), Vector.xy(x, y + ry))
    path:cubicTo(Vector.xy(x - kx, y + ry), Vector.xy(x - rx, y + ky), Vector.xy(x - rx, y))
    path:cubicTo(Vector.xy(x - rx, y - ky), Vector.xy(x - kx, y - ry), Vector.xy(x, y - ry))
    path:cubicTo(Vector.xy(x + kx, y - ry), Vector.xy(x + rx, y - ky), Vector.xy(x + rx, y))
    path:close()
end

local function circle(path: Path, x: number, y: number, r: number)
    local k = r * K
    path:moveTo(Vector.xy(x + r, y))
    path:cubicTo(Vector.xy(x + r, y + k), Vector.xy(x + k, y + r), Vector.xy(x, y + r))
    path:cubicTo(Vector.xy(x - k, y + r), Vector.xy(x - r, y + k), Vector.xy(x - r, y))
    path:cubicTo(Vector.xy(x - r, y - k), Vector.xy(x - k, y - r), Vector.xy(x, y - r))
    path:cubicTo(Vector.xy(x + k, y - r), Vector.xy(x + r, y - k), Vector.xy(x + r, y))
    path:close()
end

-- ---------------------------------------------------------------------------
-- Layout. The well is 10x20; beside it a column for hold (left) and the queue
-- (right), each four cells wide. On a phone held upright that is 18 cells
-- across — the side columns shrink to three before the well does.

local function layout(self: Board)
    local w, h = self.size.x, self.size.y
    local side = if w < h then 3 else 4
    local across = WET.W + side * 2 + 2
    local down = WET.H + 2
    local cell = math.floor(math.min(w / across, h / down))
    self.cell = math.max(4, cell)
    self.ox = math.floor((w - WET.W * self.cell) / 2)
    self.oy = math.floor((h - WET.H * self.cell) / 2)
end

local function px(self: Board): number
    return self.cell / REF_CELL
end

-- ---------------------------------------------------------------------------
-- The water reacts: sealitaire's ripple, uv and all, and the energy spike.

local function ripple(self: Board, x: number, y: number, strength: number)
    table.insert(self.ripples, 1, { x = x / self.size.x, y = y / self.size.y, age = 0, strength = strength })
    while #self.ripples > 8 do
        table.remove(self.ripples)
    end
    self.energy = math.min(1.5, self.energy + strength * 0.5)
end

-- The play ring's eight slots, then eight empty music slots (there is no
-- music yet; vortex.wgsl and surface.wgsl skip a strength-0 slot).
local function writeRipples(self: Board, b: buffer, at: number)
    for k = 1, 16 do
        local r = if k <= 8 then self.ripples[k] else nil
        local o = at + (k - 1) * 16
        buffer.writef32(b, o, if r then r.x else 0)
        buffer.writef32(b, o + 4, if r then r.y else 0)
        buffer.writef32(b, o + 8, if r then r.age else 0)
        buffer.writef32(b, o + 12, if r then r.strength else 0)
    end
end

-- ---------------------------------------------------------------------------

local function newGame(self: Board, seed: number)
    SOUND.play(self.sound, 'newGame')
    self.seed = seed
    self.game = WET.new(seed)
    self.shownScore = 0
    INK.reset(self.ink)
    DRIPS.clear(self.drips)
    self.fallT = 0
    self.lockGrace = 0
    self.flash = 0
    self.flashRows = {}
    self.lastLocks = -1
    self.energy = 0.6
    ripple(self, self.ox + WET.W * self.cell / 2, self.oy + WET.H * self.cell / 2, 0.8)
end

local function freshSeed(self: Board): number
    return math.floor(self.time * 1000 + math.random() * 1e6) + 1
end

local function writeReadout(self: Board)
    local g = self.game
    if self.scoreProp ~= nil then
        self.scoreProp.value = tostring(math.floor(self.shownScore + 0.5))
    end
    if self.linesProp ~= nil then
        self.linesProp.value = tostring(g.lines)
    end
    if self.levelProp ~= nil then
        self.levelProp.value = tostring(g.level)
    end
end

-- The drawn box of the live piece, px: x0, y0, x1, y1.
local function pieceBox(self: Board, p: WET.Piece?): (number, number, number, number)
    if p == nil then
        return 0, 0, 0, 0
    end
    local c = self.cell
    local x0: number, y0: number, x1: number, y1: number = 1e9, 1e9, -1e9, -1e9
    for _, cc in WET.cellsOf(p) do
        local x: number = self.ox + (cc[1] - 1) * c
        local y: number = self.oy + (cc[2] - 1) * c
        if x < x0 then x0 = x end
        if y < y0 then y0 = y end
        if x + c > x1 then x1 = x + c end
        if y + c > y1 then y1 = y + c end
    end
    return x0, y0, x1, y1
end

-- The live piece's centre where it is DRAWN, glide and all: what the seal's
-- flipper points at.
local function pieceCentre(self: Board): (number, number)
    local x0, y0, x1, y1 = pieceBox(self, self.game.piece)
    return (x0 + x1) / 2 + self.offX, (y0 + y1) / 2 + self.offY
end

-- A lock, a clear, or both — everything the water does about one. `hard` is
-- the rows a hard drop fell, 0 for a piece that settled on its own.
local function landed(self: Board, box: { number }, hard: number)
    local g = self.game
    local c = self.cell
    local goo = self.goo
    local x0, y0, x1, y1 = box[1], box[2], box[3], box[4]
    local cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    local hw, hh = (x1 - x0) / 2, (y1 - y0) / 2
    -- A settle is a nudge; a hard drop from the lid is a slap.
    local strength = if hard > 0 then clamp(0.35 + hard / 18, 0.35, 1) else 0.22
    if hard > 0 then
        SOUND.play(self.sound, 'hardDrop', -2, 0.55 + 0.45 * math.min(1, hard / 16))
    else
        SOUND.play(self.sound, 'lock', -1)
    end
    PUDDLE.impact(goo, cx, cy, hw, hh, strength)
    PUDDLE.splash(goo, cx, cy, hw, hh, strength, math.floor((1 + 4 * strength) * T.gooSplash * 0.6 + 0.5), 0.18, 0.55)
    ripple(self, cx, cy, 0.25 + 0.6 * strength)

    if g.lastClear > 0 then
        local w = WET.W * c
        local big = g.lastClear / 4
        for _, row in g.clearedRows do
            local ry = self.oy + (row - 0.5) * c
            PUDDLE.impact(goo, self.ox + w / 2, ry, w / 2, c / 2, 0.7 + 0.3 * big)
            -- The row's water is thrown up and out, and flies longer than a
            -- lock's so it is seen leaving before the stack pulls it home.
            PUDDLE.splash(goo, self.ox + w / 2, ry, w / 2, c / 2, 0.8 + 0.2 * big,
                math.floor(3 * T.gooSplash + 0.5), 0.35, 0.7)
        end
        local first = g.clearedRows[1]
        ripple(self, self.ox + w / 2, self.oy + (first - 0.5) * c, 0.8 + 0.7 * big)
        self.energy = math.max(self.energy, 0.6 + 0.9 * big)
        self.flash = 0.18
        self.flashRows = table.clone(g.clearedRows)
        -- THE READOUT POPS, harder for a bigger clear: a single is a nudge, a
        -- tetris, a T-spin, a back-to-back and a long combo each add to it.
        local a = g.award
        local kick = 0.35 + 0.12 * g.lastClear
            + (if a.tspin ~= '' then 0.3 else 0) + (if a.b2b then 0.3 else 0) + math.min(0.4, a.combo * 0.08)
        self.pop = math.max(self.pop, math.min(1.3, kick))
        self.popV = 0
        self.glow = math.max(self.glow, math.min(1.3, kick))
        if a.levelUp then
            self.levelFlash = 1
        end
        -- THE SEAL CELEBRATES: a new reaction, any but the last one — and a
        -- four-line clear is always the somersault, the biggest thing it does.
        self.reactSeq += 1
        self.reactVariant = if g.lastClear >= 4 then 'flip' else SEAL.pick(self.reactVariant, math.random())
        -- A note per cleared row, a rung higher each: a run up the ladder.
        for i = 1, g.lastClear do
            SOUND.play(self.sound, 'clear', -2 + (i - 1) * 1.34, 1, (i - 1) * 0.07)
        end
        if g.lastClear >= 4 then
            SOUND.play(self.sound, 'tetris')
        end
        -- The seal's voice goes with its move (react.luau's names, capitalised).
        local v = self.reactVariant
        SOUND.play(self.sound, 'react' .. v:sub(1, 1):upper() .. v:sub(2))
    end
    self.fallT = 0
    self.lockGrace = 0
    writeReadout(self)
end

-- The cells the live piece is about to lock into, for the ink's clock.
local function landingCells(self: Board): { { number } }
    local ghost = WET.ghost(self.game)
    return if ghost ~= nil then WET.cellsOf(ghost) else {}
end

local function stampInk(self: Board, cells: { { number } }, kind: number)
    local g = self.game
    INK.lock(self.ink, cells, kind, if g.lastClear > 0 then g.clearedRows else {}, self.time)
end

local function lockNow(self: Board)
    local x0, y0, x1, y1 = pieceBox(self, WET.ghost(self.game))
    local cells = landingCells(self)
    local kind = if self.game.piece ~= nil then (self.game.piece :: WET.Piece).kind else 1
    WET.lock(self.game)
    stampInk(self, cells, kind)
    landed(self, { x0, y0, x1, y1 }, 0)
end

local function hardDrop(self: Board)
    local g = self.game
    local _, sy0, _, sy1 = pieceBox(self, g.piece)
    local x0, y0, x1, y1 = pieceBox(self, WET.ghost(g))
    local cells = landingCells(self)
    local kind = if g.piece ~= nil then (g.piece :: WET.Piece).kind else 1
    local rows = WET.hardDrop(g)
    stampInk(self, cells, kind)
    if rows > 0 then
        -- The streak: a bow wave down the whole fall, for a moment, the width
        -- of the piece — the card flight's wake, rotated into a well.
        local fall = y1 - sy1
        PUDDLE.streak(self.goo, (x0 + x1) / 2, (sy0 + y1) / 2, (x1 - x0) / 2, (y1 - sy0) / 2,
            0, math.max(900, fall * 12), 0.12)
    end
    landed(self, { x0, y0, x1, y1 }, rows)
end

-- THE GUIDELINE'S LOCK DELAY: a grounded piece locks after LOCK_DELAY, and a
-- move or a turn resets the clock — but only LOCK_RESETS times, and the count
-- starts over only when the piece reaches a row deeper than it has been. So a
-- piece cannot be spun on the stack forever, and one that is still working
-- its way down never runs out.
local function resetLock(self: Board)
    if self.lockResets < WET.LOCK_RESETS then
        self.lockGrace = 0
        self.lockResets += 1
    end
end

-- ---------------------------------------------------------------------------
-- Input. Every action is one function so keys and fingers reach the same code.

local function act(self: Board, what: string)
    local g = self.game
    if what == 'new' then
        newGame(self, freshSeed(self))
        writeReadout(self)
        return
    end
    if what == 'pause' then
        self.paused = not self.paused
        return
    end
    if g.over or self.paused then
        return
    end
    -- Every move and turn that takes is the seal's flick: the rules have
    -- already moved the piece, the flipper answers it.
    if what == 'left' or what == 'right' then
        local dx = if what == 'left' then -1 else 1
        if WET.shift(g, dx, 0) then
            resetLock(self)
            local px, py = pieceCentre(self)
            SEAL.flickMove(self.seal, dx, px, py)
            -- A rung by COLUMN: walking the piece plays a little scale.
            SOUND.play(self.sound, 'move', -2 + 4 * math.clamp((px - self.ox) / (WET.W * self.cell), 0, 1))
        end
    elseif what == 'cw' or what == 'ccw' then
        local dir = if what == 'cw' then 1 else -1
        if WET.rotate(g, dir) then
            resetLock(self)
            -- The drawn piece turns THROUGH the rotation: it starts from the
            -- layout it had (a quarter turn back) and springs round, so its
            -- cells sweep — and fling their goo — instead of snapping.
            self.rotOff -= dir * math.pi / 2
            local px, py = pieceCentre(self)
            SEAL.flick(self.seal, dir, px, py)
            SOUND.play(self.sound, 'rotate', dir)
        end
    elseif what == 'down' then
        if WET.shift(g, 0, 1) then
            local p = g.piece
            SOUND.play(self.sound, 'softDrop', if p ~= nil then 2 - 4 * math.clamp(p.row / WET.H, 0, 1) else 0)
            g.score += 1
            self.fallT = 0
            writeReadout(self)
        end
    elseif what == 'drop' then
        hardDrop(self)
    elseif what == 'hold' then
        if WET.hold(g) then
            SOUND.play(self.sound, 'hold')
            self.fallT = 0
            self.lockGrace = 0
        end
    end
end

local function keyboardEvent(self: Board, event: KeyboardEvent): boolean
    local k = event.key
    local down = event.phase == 'down'
    local held = down or event.phase == 'repeat'
    if k == KEY.DOWN or k == KEY.DOM_DOWN then
        self.softDrop = event.phase ~= 'up'
        if held then act(self, 'down') end
        return true
    end
    if not held then
        return false
    end
    -- Movement repeats with the OS; everything else fires once per press.
    if k == KEY.LEFT or k == KEY.DOM_LEFT then
        act(self, 'left')
    elseif k == KEY.RIGHT or k == KEY.DOM_RIGHT then
        act(self, 'right')
    elseif not down then
        return false
    elseif k == KEY.UP or k == KEY.DOM_UP or k == KEY.X then
        act(self, 'cw')
    elseif k == KEY.Z then
        act(self, 'ccw')
    elseif k == KEY.SPACE then
        act(self, 'drop')
    elseif k == KEY.C or k == KEY.SHIFT then
        act(self, 'hold')
    elseif k == KEY.N then
        act(self, 'new')
    elseif k == KEY.P then
        act(self, 'pause')
    elseif k == KEY.T then
        TUNER.toggle(self.panel)
    else
        return false
    end
    return true
end

-- Touch: drag sideways to walk the piece a cell at a time, drag down to soft
-- drop, flick down to hard drop, tap to turn. A tap on a finished board deals.
-- The readout, where a click opens the tuner (sealitaire opens its panel from
-- the title the same way). Artboard px, as drawScene places it.
-- The readout's size against the screen: bigger on a big display, never
-- smaller than readable on a phone.
local function hudScale(self: Board): number
    return math.clamp(math.min(self.size.x / 1600, self.size.y / 1000) * 1.1, 0.55, 1.5)
end

local HUD_X, HUD_Y = 28, 64
-- The level ring in the readout's own px: its node's position, and the 64px
-- ellipse at the node's 0.84 scale. Kept in step with scene.rml by hand — an
-- editor move of the badge wants these moved too.
local RING_X, RING_Y, RING_R = 36, 37, 27

local function onReadout(self: Board, x: number, y: number): boolean
    local k = hudScale(self)
    return x >= HUD_X - 8 and x <= HUD_X + 340 * k and y >= HUD_Y - 8 and y <= HUD_Y + 110 * k
end

local function pointerDown(self: Board, event: PointerEvent)
    if self.gestureId >= 0 or self.panelGesture then
        return
    end
    -- The panel first: an overlay, and a press inside it never reaches the
    -- board beneath.
    local at = event.position
    if TUNER.press(self.panel, at.x, at.y) then
        self.panelGesture = true
        event:hit()
        return
    end
    if onReadout(self, at.x, at.y) then
        TUNER.toggle(self.panel)
        event:hit()
        return
    end
    self.gestureId = event.id
    self.downAt = event.position
    self.downTime = self.time
    self.dragCols = 0
    self.dragRows = 0
    event:hit()
end

local function pointerMove(self: Board, event: PointerEvent)
    if self.panelGesture then
        TUNER.move(self.panel, event.position.x, event.position.y)
        event:hit()
        return
    end
    if event.id ~= self.gestureId then
        return
    end
    local c = self.cell
    local dx = event.position.x - self.downAt.x
    local dy = event.position.y - self.downAt.y
    local cols = if dx >= 0 then math.floor(dx / c) else -math.floor(-dx / c)
    while self.dragCols < cols do
        act(self, 'right')
        self.dragCols += 1
    end
    while self.dragCols > cols do
        act(self, 'left')
        self.dragCols -= 1
    end
    local rows = math.max(0, math.floor(dy / c))
    while self.dragRows < rows do
        act(self, 'down')
        self.dragRows += 1
    end
    event:hit()
end

local function pointerUp(self: Board, event: PointerEvent)
    if self.panelGesture then
        self.panelGesture = false
        TUNER.up(self.panel)
        event:hit()
        return
    end
    if event.id ~= self.gestureId then
        return
    end
    self.gestureId = -1
    local dx = event.position.x - self.downAt.x
    local dy = event.position.y - self.downAt.y
    local dt = self.time - self.downTime
    local c = self.cell
    if self.game.over then
        act(self, 'new')
    elseif dt < 0.25 and dy > c * 2 and math.abs(dy) > math.abs(dx) * 1.5 then
        act(self, 'drop')
    elseif math.abs(dx) < c * 0.5 and math.abs(dy) < c * 0.5 then
        act(self, 'cw')
    end
    event:hit()
end

local function pointerExit(self: Board, event: PointerEvent)
    if event.id == self.gestureId then
        self.gestureId = -1
    end
    if self.panelGesture then
        self.panelGesture = false
        TUNER.up(self.panel)
    end
end

-- THE PAD. Left and right walk the piece and repeat on the board's clock;
-- down soft-drops while held; up hard-drops. South turns clockwise and east
-- counter-clockwise, north or a shoulder holds, start pauses, back re-deals.
local PAD_BUTTONS = { 'south', 'east', 'north', 'west', 'leftShoulder', 'rightShoulder', 'start', 'back' }
local PAD_DEAD = 0.45      -- sealitaire's padDead
local PAD_DELAY = 0.17     -- s before a held direction repeats
local PAD_REPEAT = 0.05    -- s between repeats

local function padTake(self: Board, ev: any)
    local st = self.pad
    local was = st.state
    local now: { [string]: boolean } = {}
    for _, name in PAD_BUTTONS do
        local down = ev[name] == true
        now[name] = down
        if down and not was[name] then
            if name == 'south' or name == 'west' then
                act(self, 'cw')
            elseif name == 'east' then
                act(self, 'ccw')
            elseif name == 'north' or name == 'leftShoulder' or name == 'rightShoulder' then
                act(self, 'hold')
            elseif name == 'start' then
                act(self, 'pause')
            elseif name == 'back' then
                act(self, 'new')
            end
        end
    end
    st.state = now
    local stick = ev.leftStick
    local sx = if stick ~= nil then stick.x else 0
    local sy = if stick ~= nil then stick.y else 0
    local dx = if ev.dpadLeft then -1 elseif ev.dpadRight then 1 elseif sx <= -PAD_DEAD then -1 elseif sx >= PAD_DEAD then 1 else 0
    local dy = if ev.dpadUp then -1 elseif ev.dpadDown then 1 elseif sy <= -PAD_DEAD then -1 elseif sy >= PAD_DEAD then 1 else 0
    if dy == -1 and st.y ~= -1 then
        act(self, 'drop')
    end
    st.x, st.y = dx, dy
    self.softDrop = dy == 1
end

local function padStep(self: Board, dt: number)
    local st = self.pad
    if st.x ~= st.lastX then
        st.lastX = st.x
        st.holdX = PAD_DELAY
        if st.x ~= 0 then
            act(self, if st.x < 0 then 'left' else 'right')
        end
    elseif st.x ~= 0 then
        st.holdX -= dt
        if st.holdX <= 0 then
            st.holdX = PAD_REPEAT
            act(self, if st.x < 0 then 'left' else 'right')
        end
    end
end

local function gamepadEvent(self: Board, event: GamepadEvent)
    padTake(self, event)
end

local function gamepadConnected(self: Board, event: GamepadConnected)
    padTake(self, event)
end

local function gamepadDisconnected(self: Board, event: GamepadDisconnected)
    local st = self.pad
    st.state = {}
    st.x, st.y, st.lastX = 0, 0, 0
    self.softDrop = false
end

-- ---------------------------------------------------------------------------
-- The GPU side: sealitaire's buildGpu, minus the seal, the tanks and the
-- card mask. Same canvases, same sizes, same bind layouts, because the
-- shaders are the same files.

local function buildGpu(self: Board, context: Context, pw: number, ph: number)
    self.scene = context:canvas({ width = pw, height = ph })
    self.water = context:gpuCanvas({ width = pw, height = ph })
    self.screen = context:gpuCanvas({ width = pw, height = ph })
    local water = self.water :: GPUCanvas
    local screen = self.screen :: GPUCanvas

    -- whirl.wgsl: sealitaire's vortex, forked so its every constant is a
    -- slider (see its header). Its block is the vortex's plus six rows.
    local vortex = context:shader('whirl')
    if vortex == nil then
        error('whirl.wgsl missing')
    end
    self.waterUbo = GPUBuffer.new({ size = WHIRL_UBO, usage = 'uniform', label = 'water ubo' })
    self.waterPipe = GPUPipeline.new({
        vertex = vortex, fragment = vortex, vertexLayout = {},
        colorTargets = { { format = water.format } }, label = 'whirl',
    })
    self.waterBind = GPUBindGroup.new({
        layout = (self.waterPipe :: GPUPipeline):getBindGroupLayout(0),
        ubos = { { slot = 0, buffer = self.waterUbo :: GPUBuffer } },
    })

    self.sampler = GPUSampler.new({ min = 'linear', mag = 'linear', wrapU = 'clamp-to-edge', wrapV = 'clamp-to-edge' })
    local sampler = self.sampler :: GPUSampler

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
        self.gooUbo = GPUBuffer.new({ size = PUDDLE.UBO_SIZE, usage = 'uniform', label = 'goo ubo' })
        self.gooBind = GPUBindGroup.new({
            layout = (self.gooPipe :: GPUPipeline):getBindGroupLayout(0),
            ubos = { { slot = 0, buffer = self.gooUbo :: GPUBuffer } },
            textures = { { slot = 1, view = water:colorView() } },
            samplers = { { slot = 2, sampler = sampler } },
        })
    end

    self.foamA = context:gpuCanvas({ width = gw, height = gh })
    self.foamB = context:gpuCanvas({ width = gw, height = gh })
    self.foamFresh = true
    self.foamParity = 0
    local foamA = self.foamA :: GPUCanvas
    local foamB = self.foamB :: GPUCanvas
    local foamShader = context:shader('foam')
    self.foamUbos, self.foamBindsA, self.foamBindsB = {}, {}, {}
    if foamShader ~= nil then
        self.foamPipe = GPUPipeline.new({
            vertex = foamShader, fragment = foamShader, vertexLayout = {},
            colorTargets = { { format = foamA.format } }, label = 'foam',
        })
        local fl = (self.foamPipe :: GPUPipeline):getBindGroupLayout(0)
        for k = 1, FOAM_STEPS do
            local ubo = GPUBuffer.new({ size = PUDDLE.FOAM_UBO_SIZE, usage = 'uniform', label = `foam ubo {k}` })
            self.foamUbos[k] = ubo
            self.foamBindsA[k] = GPUBindGroup.new({
                layout = fl, ubos = { { slot = 0, buffer = ubo } },
                textures = { { slot = 1, view = foamB:colorView() } },
                samplers = { { slot = 2, sampler = sampler } },
            })
            self.foamBindsB[k] = GPUBindGroup.new({
                layout = fl, ubos = { { slot = 0, buffer = ubo } },
                textures = { { slot = 1, view = foamA:colorView() } },
                samplers = { { slot = 2, sampler = sampler } },
            })
        end
    end

    self.surfaceCanvas = context:gpuCanvas({ width = pw, height = ph })
    local surfaceCanvas = self.surfaceCanvas :: GPUCanvas
    local surfaceShader = context:shader('surface')
    if surfaceShader ~= nil then
        self.surfacePipe = GPUPipeline.new({
            vertex = surfaceShader, fragment = surfaceShader, vertexLayout = {},
            colorTargets = { { format = surfaceCanvas.format } }, label = 'surface',
        })
        self.surfaceUbo = GPUBuffer.new({ size = 112 + 16 * 16, usage = 'uniform', label = 'surface ubo' })
        local sl = (self.surfacePipe :: GPUPipeline):getBindGroupLayout(0)
        for parity = 0, 1 do
            local bind = GPUBindGroup.new({
                layout = sl,
                ubos = { { slot = 0, buffer = self.surfaceUbo :: GPUBuffer } },
                textures = {
                    { slot = 1, view = water:colorView() },
                    { slot = 2, view = gooCanvas:colorView() },
                    { slot = 4, view = if parity == 0 then foamA:colorView() else foamB:colorView() },
                },
                samplers = { { slot = 3, sampler = sampler } },
            })
            if parity == 0 then self.surfaceBind = bind else self.surfaceBindB = bind end
        end
    end

    local sealCanvas = SEAL.build(self.seal, context, pw, ph)
    self.stack = context:canvas({ width = pw, height = ph })
    local stackImg = (self.stack :: Canvas).image

    local crt = context:shader('crt')
    local img = (self.scene :: Canvas).image
    if crt ~= nil and img ~= nil and stackImg ~= nil then
        self.crtPipe = GPUPipeline.new({
            vertex = crt, fragment = crt, vertexLayout = {},
            colorTargets = { { format = screen.format } }, label = 'crt',
        })
        self.crtUbo = GPUBuffer.new({ size = INK.UBO_SIZE, usage = 'uniform', label = 'crt ubo' })
        self.crtBind = GPUBindGroup.new({
            layout = (self.crtPipe :: GPUPipeline):getBindGroupLayout(0),
            ubos = { { slot = 0, buffer = self.crtUbo :: GPUBuffer } },
            textures = {
                { slot = 1, view = img:view() },
                { slot = 2, view = if self.surfacePipe ~= nil then surfaceCanvas:colorView() else water:colorView() },
                { slot = 4, view = sealCanvas:colorView() },
                { slot = 5, view = stackImg:view() },
                { slot = 6, view = gooCanvas:colorView() },
            },
            samplers = { { slot = 3, sampler = sampler } },
        })
    end
end

local function init(self: Board, context: Context): boolean
    self.context = context
    if not self.seal.ready then
        SEAL.load(self.seal, context)
    end
    if self.sound.context == nil then
        SOUND.load(self.sound, context)
    end
    -- init runs twice and the view model is absent the first time.
    local vm = context:viewModel()
    if vm ~= nil then
        self.scoreProp = vm:getString('score')
        self.linesProp = vm:getString('lines')
        self.levelProp = vm:getString('level')
        self.labProp = vm:getString('lab')
        writeReadout(self)
        TUNER.build(self.panel, self.tunerRow, self.tunerHead)
        local ok, made = pcall(function(): Artboard<Data.Board>
            return self.hud:instance(vm)
        end)
        if ok then
            self.hudInst = made
        else
            print(`wetris: no readout instance: {made}`)
        end
    end
    return true
end

local function resize(self: Board, size: Vector, scale: number)
    self.size = size
    self.scale = if scale > 0 then scale else 1
    layout(self)
    TUNER.resize(self.panel, size.x, size.y)
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
        print(`wetris: GPU canvases unavailable, drawing flat: {err}`)
    end
end

-- THE LAB. `--data=lab=<name>` stages a board so a screenshot can show the
-- water doing something without playing a game to get there. Read on the
-- first advance, not in init: the CLI applies --data after init.
--   clear   four rows full but for column 5, an I standing over the gap and
--           six lines on the count: one Space is a four-line clear AND a
--           level-up
--   stack   a ragged half-full well, for the goo's silhouette
local function stageLab(self: Board)
    self.labDone = true
    local prop = self.labProp
    local lab = if prop ~= nil then prop.value else ''
    if lab == '' then
        return
    end
    local g = self.game
    for r = 1, WET.H do
        for c = 1, WET.W do
            g.cells[r][c] = 0
        end
    end
    if lab == 'clear' then
        for r = WET.H - 3, WET.H do
            for c = 1, WET.W do
                g.cells[r][c] = if c == 5 then 0 else ((r + c) % 7) + 1
            end
        end
        g.piece = { kind = 1, rot = 2, col = 3, row = 2 }
        -- Six lines already, so the clear crosses into level 2 and the
        -- level-up shows too.
        g.lines = 6
    elseif lab == 'stack' then
        for r = 11, WET.H do
            for c = 1, WET.W do
                if (r * 7 + c * 3) % 5 ~= 0 and r - 10 > math.abs(c - 5) * 0.8 then
                    -- In runs of three, so it reads like pieces rather than
                    -- confetti.
                    g.cells[r][c] = ((r * 3 + (c - 1) // 3) % 7) + 1
                end
            end
        end
    end
    INK.paint(self.ink, g.cells)
end

-- How long a grounded piece may slide before it locks.
local LOCK_DELAY = WET.LOCK_DELAY

-- Keep the drawn piece's glide honest: a move in the rules becomes an offset
-- the other way that decays, so the drawing starts where it was.
local function trackPiece(self: Board, dt: number)
    local g = self.game
    local p = g.piece
    local c = self.cell
    if p == nil then
        self.lastKind = 0
        return
    end
    local fresh = p.kind ~= self.lastKind or g.locks ~= self.lastLocks
    if fresh then
        -- A new piece (or a hold swap): it drops in from half a cell up.
        self.offX, self.offY = 0, -c * 0.5
        self.rotOff = 0
        self.pieceFresh = true
        self.lockResets = 0
        self.lowestRow = p.row
    else
        self.offX -= (p.col - self.lastCol) * c
        self.offY -= (p.row - self.lastRow) * c
    end
    self.lastKind, self.lastCol, self.lastRow, self.lastLocks = p.kind, p.col, p.row, g.locks
    local decay = math.exp(-T.glide * dt)
    self.offX *= decay
    self.offY *= decay
    self.rotOff *= math.exp(-T.spin * dt)
    -- Every cell where it is drawn, and how fast it got there — the glide AND
    -- the turn, which is what a drip leaving that cell inherits.
    local at = TILES.pieceCells(p, self.ox, self.oy, c, self.offX, self.offY, self.rotOff)
    for i, pt in at do
        local was = self.cellAt[i]
        if fresh or was == nil or dt <= 0 then
            self.cellVel[i] = { 0, 0 }
        else
            self.cellVel[i] = { (pt[1] - was[1]) / dt, (pt[2] - was[2]) / dt }
        end
    end
    self.cellAt = at
    local x0, y0 = pieceBox(self, p)
    local vx, vy = x0 + self.offX, y0 + self.offY
    if dt > 0 then
        self.visVx = (vx - self.visX) / dt
        self.visVy = (vy - self.visY) / dt
    end
    self.visX, self.visY = vx, vy
end

-- THE PIECE SHEDS ITS COLOUR (drips.luau). Drops gather BEHIND the piece at
-- points on its contour — undersides far more often than tops, reckoned on
-- screen so a turned piece drips from whatever now faces down — ride with it
-- while they swell out past the edge, then let go with that point's velocity.
-- More start the faster the piece moves.
local function shedGoo(self: Board, dt: number)
    local g = self.game
    local c = self.cell
    local p = g.piece
    if self.pieceFresh then
        -- The piece they hung from is the stack now (or the hold): let go.
        DRIPS.release(self.drips)
        self.pieceFresh = false
    end
    if p ~= nil and not g.over and not self.paused and #self.cellAt == 4 then
        local speed = 0
        for _, v in self.cellVel do
            speed = math.max(speed, math.sqrt(v[1] * v[1] + v[2] * v[2]))
        end
        local rate = T.dripRate + T.dripSpeedRate * speed / c
        local n = DRIPS.due(self.drips, rate, dt)
        if n > 0 and DRIPS.forming(self.drips) < 10 then
            local sites = TILES.contour(p)
            local cs, sn = math.cos(self.rotOff), math.sin(self.rotOff)
            -- Weighted by how much each edge faces DOWN the screen.
            local weights: { number } = {}
            local total = 0
            for k, site in sites do
                local down = sn * site[2] + cs * site[3]
                local w = 0.06 + math.max(0, down) ^ 2 * 1.5
                weights[k] = w
                total += w
            end
            local rgb = INK.kindRgb(p.kind)
            for _ = 1, n do
                local pick = math.random() * total
                local k = 1
                while k < #sites and pick > weights[k] do
                    pick -= weights[k]
                    k += 1
                end
                local site = sites[k]
                local nx, ny = site[2], site[3]
                -- On the edge, somewhere along it.
                local along = (math.random() - 0.5) * 0.7 * c
                local lx = nx * 0.5 * c * 0.93 - ny * along
                local ly = ny * 0.5 * c * 0.93 + nx * along
                DRIPS.form(self.drips, site[1], lx, ly, nx, ny,
                    T.dripSize * c * (0.7 + 0.6 * math.random()), rgb,
                    T.dripForm * (0.7 + 0.6 * math.random()))
            end
        end
        DRIPS.follow(self.drips, dt, { at = self.cellAt, vel = self.cellVel, turn = self.rotOff },
            T.dripInherit, T.dripFling * c, 0.25 / c)
    end
    DRIPS.step(self.drips, dt, { cells = g.cells, ox = self.ox, oy = self.oy, cell = c }, self.ink,
        T.dripGravity * c, T.dripDrag, T.dripStain)
end

-- WHERE THE SEAL GOES. The station is beside the well at the piece's
-- height, clamped below the previews at the top of each side column; the
-- side is whichever the piece is nearer, with a margin wide enough that the
-- seal does not cross the board for every piece. The celebration is out in
-- the open water on the same side, lower down.
local function updateSeal(self: Board, dt: number)
    local c = self.cell
    local w, h = WET.W * c, WET.H * c
    local L = T.sealLength * c
    local g = self.game
    local piece: SEAL.Vec? = nil
    local py = self.oy + h * 0.6
    if g.piece ~= nil and not g.over then
        local px, pcy = pieceCentre(self)
        piece = { x = px, y = pcy }
        py = pcy
        local col = (px - self.ox) / c
        if self.sealSide < 0 and col > 7.5 then
            self.sealSide = 1
        elseif self.sealSide > 0 and col < 2.5 then
            self.sealSide = -1
        end
    end
    local side = self.sealSide
    local sx = if side < 0 then self.ox - c * 0.5 - L * 0.3 else self.ox + w + c * 0.5 + L * 0.3
    local sy = clamp(py + L * 0.35, self.oy + c * 9.5 + L * 0.3, self.oy + h - L * 0.45)
    SEAL.update(self.seal, dt, {
        w = self.size.x, h = self.size.y, L = L,
        station = { x = sx, y = sy },
        piece = piece,
        stage = { x = sx + side * L * 0.25, y = self.oy + h * 0.66 },
        side = side,
        reactSeq = self.reactSeq, reactVariant = self.reactVariant,
    })
end

local function advance(self: Board, dt: number): boolean
    dt = math.min(dt, 1 / 20)
    self.time += dt
    if not self.labDone then
        stageLab(self)
    end
    local g = self.game
    local c = self.cell

    self.energy = math.max(0, self.energy - dt * T.energyDecay)
    for _, r in self.ripples do
        r.age += dt
    end
    for _, b in self.bubbles do
        b.y -= b.vy * c * dt
        if b.y < -c then
            b.y = self.size.y + c
            b.x = math.random() * self.size.x
        end
    end
    self.flash = math.max(0, self.flash - dt)
    -- An instanced artboard lays its text out on advance; one that is never
    -- advanced draws nothing and says nothing.
    local hud = self.hudInst
    if hud ~= nil then
        hud:advance(dt)
    end
    TUNER.advance(self.panel, dt)
    -- The score counts up to the real one — fast enough that it lands inside
    -- the pop, slow enough to be seen doing it.
    local target = g.score
    if self.shownScore ~= target then
        self.shownScore += (target - self.shownScore) * (1 - math.exp(-10 * dt))
        if math.abs(target - self.shownScore) < 0.5 then
            self.shownScore = target
        end
        writeReadout(self)
    end
    -- The pop, a stiff spring back to rest so it overshoots once.
    local acc = -170 * self.pop - 13 * self.popV
    self.popV += acc * dt
    self.pop += self.popV * dt
    self.levelFlash = math.max(0, self.levelFlash - dt / 0.8)
    -- The glow outlasts the bounce: the pop is over in a fifth of a second,
    -- and a light that short is never seen.
    self.glow *= math.exp(-2.2 * dt)

    if not (g.over or self.paused or g.piece == nil) then
        local step = WET.gravity(g.level)
        -- The guideline's soft drop: twenty times the level's gravity.
        if self.softDrop then
            step = step / WET.SOFT_DROP
        end
        self.fallT += dt
        while self.fallT >= step do
            self.fallT -= step
            if not WET.shift(g, 0, 1) then
                self.fallT = 0
                break
            end
            if self.softDrop then
                g.score += 1
                writeReadout(self)
            end
        end
        local p = g.piece
        if p ~= nil then
            if p.row > self.lowestRow then
                self.lowestRow = p.row
                self.lockResets = 0
            end
            local below = { kind = p.kind, rot = p.rot, col = p.col, row = p.row + 1 }
            if WET.fits(g, below) then
                self.lockGrace = 0
            else
                self.lockGrace += dt
                if self.lockGrace >= LOCK_DELAY then
                    lockNow(self)
                end
            end
        end
    end

    -- The top-out, as an EDGE: one sound, not one a frame.
    if g.over and not self.wasOver then
        SOUND.play(self.sound, 'gameOver', -2)
    end
    self.wasOver = g.over
    -- The loop: loaded and started from the first advance, not from init,
    -- which runs twice (sealitaire's music learned that one the hard way).
    if not self.music.tried and self.context ~= nil then
        MUSIC.load(self.music, self.context :: Context)
    end
    MUSIC.step(self.music, dt, T.musicVolume)
    padStep(self, dt)
    trackPiece(self, dt)
    shedGoo(self, dt)
    updateSeal(self, dt)

    -- The goo's frame: the board, and the piece where it is drawn.
    local pieceCells = {}
    local p = g.piece
    if p ~= nil and not g.over then
        -- Where the cells are DRAWN, turn and all, so the goo skirt sweeps
        -- round a rotation with the tiles instead of waiting at the new layout.
        for _, at in self.cellAt do
            if at[2] > self.oy then
                table.insert(pieceCells, { at[1] - c / 2, at[2] - c / 2 })
            end
        end
    end
    PUDDLE.advance(self.goo, {
        dt = dt, cells = g.cells, cols = WET.W, rows = WET.H,
        cell = c, ox = self.ox, oy = self.oy,
        piece = pieceCells, pieceVx = self.visVx, pieceVy = self.visVy,
        px = px(self),
    })
    return true
end

-- ---------------------------------------------------------------------------
-- The passes, in sealitaire's order and with sealitaire's uniform rows. The
-- seal's rows carry the real animal, so it froths and wakes the water as it
-- swims, exactly as it does on the card table.

local SEAL_AWAY = -100000

-- The seal's body for the water's froth and wake, or parked off the table
-- when there is no seal to draw.
local function sealWake(self: Board): (number, number, number, number)
    if not self.seal.ready then
        return SEAL_AWAY, SEAL_AWAY, 0, 0
    end
    return SEAL.wake(self.seal)
end

local function drawWater(self: Board)
    local water, pipe, bind, ubo = self.water, self.waterPipe, self.waterBind, self.waterUbo
    if water == nil or pipe == nil or bind == nil or ubo == nil then
        return
    end
    local b = self.waterBytes
    buffer.writef32(b, 0, water.width)
    buffer.writef32(b, 4, water.height)
    buffer.writef32(b, 8, self.time)
    buffer.writef32(b, 12, self.energy)
    -- The vortex's eye sits in the well, a little below centre, so the water
    -- turns around the stack the way it turns around sealitaire's tableau.
    buffer.writef32(b, 16, T.vortexX)
    buffer.writef32(b, 20, T.vortexY)
    buffer.writef32(b, 24, -1)
    buffer.writef32(b, 28, -1)
    buffer.writef32(b, 32, T.twist)
    buffer.writef32(b, 36, T.waterSpeed)
    buffer.writef32(b, 40, T.waterBright)
    buffer.writef32(b, 44, T.warp)
    writeRipples(self, b, 48)
    local at = 48 + 16 * 16
    local rows = {
        T.swirlCore, T.swirlTight, T.swirlReach, T.energySpin,
        T.noiseScale, T.noiseDrift, T.octaves, T.warpDrift,
        T.foamEdge, T.foamSoft, T.foamAmount, T.foamEnergy,
        T.tealMix, T.depthReach, T.eyeDark, T.eyeSize,
        T.waterVignette, T.ringWarp, T.ringGlow, T.crease,
        T.waterHue, T.waterSat, T.waterContrast, 0,
    }
    for k, v in rows do
        buffer.writef32(b, at + (k - 1) * 4, v)
    end
    ubo:write(b)
    local pass = water:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0.03, 0.09, 0.17, 1 } } },
    })
    pass:setPipeline(pipe)
    pass:setBindGroup(0, bind)
    pass:draw(3)
    pass:finish()
end

local function drawGoo(self: Board)
    local canvas, pipe, ubo, bind = self.gooCanvas, self.gooPipe, self.gooUbo, self.gooBind
    if canvas == nil or pipe == nil or ubo == nil or bind == nil then
        return
    end
    local f = px(self)
    local b = self.gooBytes
    buffer.writef32(b, 0, canvas.width)
    buffer.writef32(b, 4, canvas.height)
    buffer.writef32(b, 8, self.time)
    buffer.writef32(b, 12, self.energy)
    buffer.writef32(b, 16, self.size.x)
    buffer.writef32(b, 20, self.size.y)
    buffer.writef32(b, 24, T.gooSkirt * f)
    buffer.writef32(b, 28, T.gooBlend * self.cell)
    buffer.writef32(b, 32, T.gooWobble * f)
    buffer.writef32(b, 36, 14 * f)
    buffer.writef32(b, 40, T.goo)
    buffer.writef32(b, 44, 22 * f)
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

local function drawFoam(self: Board)
    local foamA, foamB, pipe = self.foamA, self.foamB, self.foamPipe
    if foamA == nil or foamB == nil or pipe == nil or #self.foamUbos == 0 then
        return
    end
    if self.foamFresh then
        self.foamFresh = false
        for _, cv in { foamA, foamB } do
            local clear = cv:beginRenderPass({
                color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 1 } } },
            })
            clear:finish()
        end
    end
    local elapsed = if self.foamTime < 0 then 1 / 60 else math.max(0, self.time - self.foamTime)
    self.foamTime = self.time
    local steps = clamp(math.ceil(elapsed * 40), 1, FOAM_STEPS)
    local dt = elapsed / steps
    local sx, sy, sh, sv = sealWake(self)
    for k = 1, steps do
        local target = if self.foamParity == 0 then foamA else foamB
        local bind = if self.foamParity == 0 then self.foamBindsA[k] else self.foamBindsB[k]
        local b = self.foamBytes
        buffer.writef32(b, 0, target.width)
        buffer.writef32(b, 4, target.height)
        buffer.writef32(b, 8, self.time - elapsed + dt * k)
        buffer.writef32(b, 12, dt)
        buffer.writef32(b, 16, self.size.x)
        buffer.writef32(b, 20, self.size.y)
        buffer.writef32(b, 24, self.energy)
        buffer.writef32(b, 28, T.foamFade)
        buffer.writef32(b, 32, T.vortexX)
        buffer.writef32(b, 36, T.vortexY)
        buffer.writef32(b, 40, T.twist)
        buffer.writef32(b, 44, T.waterSpeed)
        buffer.writef32(b, 48, sx)
        buffer.writef32(b, 52, sy)
        buffer.writef32(b, 56, sh)
        buffer.writef32(b, 60, sv)
        buffer.writef32(b, 64, T.sealLength * self.cell)
        buffer.writef32(b, 68, T.whitewater)
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

local function drawSurface(self: Board)
    local canvas, pipe, ubo = self.surfaceCanvas, self.surfacePipe, self.surfaceUbo
    local bind = if self.foamParity == 1 then self.surfaceBind else self.surfaceBindB
    if canvas == nil or pipe == nil or ubo == nil or bind == nil then
        return
    end
    local b = self.surfaceBytes
    buffer.writef32(b, 0, canvas.width)
    buffer.writef32(b, 4, canvas.height)
    buffer.writef32(b, 8, self.time)
    buffer.writef32(b, 12, self.energy)
    buffer.writef32(b, 16, self.size.x)
    buffer.writef32(b, 20, self.size.y)
    buffer.writef32(b, 24, -1000)
    buffer.writef32(b, 28, -1000)
    buffer.writef32(b, 32, T.caustics)
    buffer.writef32(b, 36, T.bubbles)
    buffer.writef32(b, 40, T.waves)
    buffer.writef32(b, 44, T.glint)
    local sx, sy, sh, sv = sealWake(self)
    buffer.writef32(b, 48, sx)
    buffer.writef32(b, 52, sy)
    buffer.writef32(b, 56, sh)
    buffer.writef32(b, 60, sv)
    buffer.writef32(b, 64, T.vortexX)
    buffer.writef32(b, 68, T.vortexY)
    buffer.writef32(b, 72, T.twist)
    buffer.writef32(b, 76, T.waterSpeed)
    buffer.writef32(b, 80, T.refract)
    buffer.writef32(b, 84, T.turbulence)
    buffer.writef32(b, 88, T.whitewater)
    buffer.writef32(b, 92, 0)
    buffer.writef32(b, 96, T.rippleRelief)
    buffer.writef32(b, 100, T.reflect)
    buffer.writef32(b, 104, T.reflectTilt)
    buffer.writef32(b, 108, 0)
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

-- ---------------------------------------------------------------------------
-- The 2-D scene: the well, the blocks, the readout. On the GPU path this goes
-- into the scene canvas over NOTHING (the water is under it in the CRT pass);
-- on the flat path straight to the renderer over navy.

local function addCell(self: Board, path: Path, x: number, y: number, s: number)
    local inset = s * 0.05
    roundRect(path, x + inset, y + inset, s - inset * 2, s - inset * 2, s * 0.28)
end

local function addShine(self: Board, x: number, y: number, s: number)
    -- The wet: a small highlight up and left on every cell, lit from the
    -- surface, the same light the goo and the surface use.
    circle(self.shinePath, x + s * 0.3, y + s * 0.28, s * 0.11)
end

local function addBlock(self: Board, kind: number, x: number, y: number, s: number)
    addCell(self, self.cellPaths[kind], x, y, s)
    addCell(self, self.shadowPath, x, y + s * 0.12, s)
    addShine(self, x, y, s)
end

local function addPreview(self: Board, kind: number, cx: number, cy: number, s: number)
    local shape = WET.SHAPES[kind][1]
    local minC, maxC, minR, maxR = 9, -9, 9, -9
    for _, cc in shape do
        minC = math.min(minC, cc[1]); maxC = math.max(maxC, cc[1])
        minR = math.min(minR, cc[2]); maxR = math.max(maxR, cc[2])
    end
    local w = (maxC - minC + 1) * s
    local h = (maxR - minR + 1) * s
    for _, cc in shape do
        addBlock(self, kind, cx - w / 2 + (cc[1] - minC) * s, cy - h / 2 + (cc[2] - minR) * s, s)
    end
end

-- The well: sealitaire's empty-slot outline, over a faint floor so the water
-- still reads through it.
local function drawWell(self: Board, r: Renderer)
    local c = self.cell
    local w, h = WET.W * c, WET.H * c
    self.wellPath:reset()
    roundRect(self.wellPath, self.ox - c * 0.2, self.oy - c * 0.2, w + c * 0.4, h + c * 0.4, c * 0.4)
    r:drawPath(self.wellPath, self.floorPaint)
    r:drawPath(self.wellPath, self.wellPaint)
end

-- UNDER THE TILES: the well's floor and outline, in a canvas of their own so
-- crt.wgsl can lay the tiles (which it draws itself) between them and the
-- scene.
local function drawUnder(self: Board, r: Renderer)
    drawWell(self, r)
end

-- The hold (left) and the next three (right): kind, centre x, centre y, cell.
local function previewSlots(self: Board): { { number } }
    local g = self.game
    local c = self.cell
    local w = WET.W * c
    local s = c * 0.75
    local side = if self.size.x < self.size.y then 3 else 4
    local leftX = self.ox - (side * c) / 2 - c * 0.6
    local rightX = self.ox + w + (side * c) / 2 + c * 0.6
    local out: { { number } } = {}
    if g.hold > 0 then
        table.insert(out, { g.hold, leftX, self.oy + c * 2, s })
    end
    for i = 1, math.min(3, #g.queue) do
        table.insert(out, { g.queue[i], rightX, self.oy + c * (2 + (i - 1) * 3), s })
    end
    return out
end

-- Every tile that is not on the grid, for crt.wgsl: the live piece as drawn
-- (glide and turn), then the previews.
local function freeTiles(self: Board): { TILES.Free }
    local g = self.game
    local out: { TILES.Free } = {}
    local p = g.piece
    if p ~= nil and not g.over then
        local rgb = INK.kindRgb(p.kind)
        for _, at in self.cellAt do
            -- Above the lid is hidden, as the flat draw hides it.
            if at[2] > self.oy - self.cell * 0.1 then
                table.insert(out, { x = at[1], y = at[2], size = self.cell, turn = self.rotOff, rgb = rgb })
            end
        end
    end
    for _, slot in previewSlots(self) do
        local rgb = INK.kindRgb(slot[1])
        for _, at in TILES.previewCells(slot[1], slot[2], slot[3], slot[4]) do
            table.insert(out, { x = at[1], y = at[2], size = slot[4], turn = 0, rgb = rgb })
        end
    end
    return out
end

local function drawScene(self: Board, r: Renderer, flat: boolean)
    local g = self.game
    local c = self.cell
    local w, h = WET.W * c, WET.H * c

    for k = 1, 7 do
        self.cellPaths[k]:reset()
    end
    self.shinePath:reset()
    self.shadowPath:reset()
    self.ghostPath:reset()

    -- Flat has no surface.wgsl to raise bubbles, so it draws its own.
    if flat then
        self.bubblePath:reset()
        for _, b in self.bubbles do
            circle(self.bubblePath, b.x + math.sin(self.time * 1.3 + b.phase) * c * 0.2, b.y, b.r * c * 0.25)
        end
        r:drawPath(self.bubblePath, self.bubblePaint)
    end

    -- The well and the stack. Flat, in their own colours, here; on the GPU
    -- path the well is the under canvas's (drawUnder) and every tile is
    -- crt.wgsl's.
    if flat then
        drawWell(self, r)
        for row = 1, WET.H do
            for col = 1, WET.W do
                local kind = g.cells[row][col]
                if kind > 0 then
                    addBlock(self, kind, self.ox + (col - 1) * c, self.oy + (row - 1) * c, c)
                end
            end
        end
    end

    local p = g.piece
    if p ~= nil and not g.over then
        local ghost = WET.ghost(g)
        if ghost ~= nil then
            for _, cc in WET.cellsOf(ghost) do
                if cc[2] >= 1 then
                    local inset = c * 0.12
                    roundRect(self.ghostPath, self.ox + (cc[1] - 1) * c + inset, self.oy + (cc[2] - 1) * c + inset,
                        c - inset * 2, c - inset * 2, c * 0.22)
                end
            end
        end
        -- The piece and the previews are crt.wgsl's tiles on the GPU path.
        if flat then
            for _, cc in WET.cellsOf(p) do
                local y = self.oy + (cc[2] - 1) * c + self.offY
                if y > self.oy - c * 0.6 then
                    addBlock(self, p.kind, self.ox + (cc[1] - 1) * c + self.offX, y, c)
                end
            end
        end
    end

    if flat then
        for _, slot in previewSlots(self) do
            addPreview(self, slot[1], slot[2], slot[3], slot[4])
        end
    end

    r:drawPath(self.ghostPath, self.ghostPaint)
    r:drawPath(self.shadowPath, self.shadowPaint)
    for k = 1, 7 do
        r:drawPath(self.cellPaths[k], self.cellPaints[k])
    end
    r:drawPath(self.shinePath, self.shinePaint)

    if self.flash > 0 then
        self.flashPath:reset()
        for _, row in self.flashRows do
            roundRect(self.flashPath, self.ox, self.oy + (row - 1) * c, w, c, c * 0.3)
        end
        r:drawPath(self.flashPath, self.flashPaint)
    end

    if g.over or self.paused then
        self.veilPath:reset()
        roundRect(self.veilPath, self.ox, self.oy, w, h, c * 0.3)
        r:drawPath(self.veilPath, self.veilPaint)
    end

    -- The readout, top-left under the game's Back button: scaled with the
    -- screen, popped about the level ring's centre on a clear, with a warm
    -- glow behind the score, the level bar under it, and a ring thrown off
    -- the badge on a level-up. Everything here is in the readout's own px.
    local hud = self.hudInst
    if hud ~= nil then
        local k = hudScale(self) * (1 + 0.28 * self.pop)
        r:save()
        r:transform(Mat2D.withTranslation(HUD_X, HUD_Y))
        -- About the level ring's centre: (36, 37) since Ethan grouped the
        -- badge in the editor (scene.rml, Node 1:9110).
        r:transform(Mat2D.withTranslation(RING_X, RING_Y))
        r:transform(Mat2D.withScale(k, k))
        r:transform(Mat2D.withTranslation(-RING_X, -RING_Y))
        local path = self.hudPath
        local digits = #tostring(math.floor(self.shownScore + 0.5))
        local sw = digits * 36
        -- A soft dark bed under the whole readout, so it reads over the
        -- busiest water: drawn at its real size, because a feather is scaled
        -- with its path and a unit shape blown up blurs its edge to nothing.
        path:reset()
        roundRect(path, -6, 0, 104 + sw, 104, 40)
        r:drawPath(path, self.bedPaint)
        local glow = math.clamp(self.glow, 0, 1.3)
        if glow > 0.02 then
            path:reset()
            ellipse(path, 80 + sw / 2, 40, sw / 2 + 16 + 14 * glow, 26 + 14 * glow)
            -- The fade is the PAINT's alpha: Renderer.modulateOpacity drew
            -- this at nothing in the CLI, at any value.
            self.glowPaint.color = Color.rgba(255, 214, 130, math.floor(255 * math.min(1, glow * 1.1)))
            r:drawPath(path, self.glowPaint)
        end
        -- The level bar: ten segments, lit by the share of this level's goal done.
        local _, done, goal = WET.levelFor(g.lines)
        local lit = math.floor(done / goal * WET.LINES_PER_LEVEL + 1e-6)
        for i = 0, WET.LINES_PER_LEVEL - 1 do
            path:reset()
            roundRect(path, 84 + i * 15.5, 84, 12, 10, 3)
            r:drawPath(path, if i < lit or self.levelFlash > 0.5 then self.barOnPaint else self.barOffPaint)
        end
        if self.levelFlash > 0 then
            local t = 1 - self.levelFlash
            path:reset()
            circle(path, RING_X, RING_Y, RING_R + 46 * t)
            self.ringPaint.color = Color.rgba(255, 226, 150, math.floor(255 * self.levelFlash))
            r:drawPath(path, self.ringPaint)
        end
        hud:draw(r)
        r:restore()
    end
end

local function draw(self: Board, renderer: Renderer)
    local scene, screen = self.scene, self.screen
    local inv = 1 / self.scale
    local crtPipe, crtUbo, crtBind = self.crtPipe, self.crtUbo, self.crtBind
    if self.gpu and scene ~= nil and screen ~= nil and crtPipe ~= nil and crtUbo ~= nil and crtBind ~= nil then
        drawWater(self)
        drawGoo(self)
        drawFoam(self)
        drawSurface(self)
        SEAL.draw(self.seal, self.size.x, self.size.y, self.energy)

        local stack = self.stack
        if stack ~= nil then
            local sr = stack:beginFrame({ clearColor = Color.rgba(0, 0, 0, 0) })
            sr:save()
            sr:transform(Mat2D.withScale(self.scale, self.scale))
            drawUnder(self, sr)
            sr:restore()
            stack:endFrame()
        end

        local r = scene:beginFrame({ clearColor = Color.rgba(0, 0, 0, 0) })
        r:save()
        r:transform(Mat2D.withScale(self.scale, self.scale))
        drawScene(self, r, false)
        r:restore()
        scene:endFrame()

        local b = self.crtBytes
        buffer.writef32(b, 0, screen.width)
        buffer.writef32(b, 4, screen.height)
        buffer.writef32(b, 8, self.time)
        buffer.writef32(b, 12, self.energy)
        buffer.writef32(b, 16, T.curve)
        buffer.writef32(b, 20, T.scanlines)
        buffer.writef32(b, 24, T.aberration)
        buffer.writef32(b, 28, T.vignette)
        INK.write(self.ink, self.game.cells, b, self.time, self.ox, self.oy, self.cell,
            self.size.x, self.size.y, T.mixTime, T.mixReach, T.mixSwirl)
        local nFree = TILES.write(freeTiles(self), b)
        local nDrips = DRIPS.write(self.drips, b, T.dripStretch)
        buffer.writef32(b, INK.ART_AT, self.size.x)
        buffer.writef32(b, INK.ART_AT + 4, self.size.y)
        buffer.writef32(b, INK.ART_AT + 8, nFree)
        buffer.writef32(b, INK.ART_AT + 12, nDrips)
        buffer.writef32(b, INK.LOOK_AT, T.bevel)
        buffer.writef32(b, INK.LOOK_AT + 4, T.extrude)
        buffer.writef32(b, INK.LOOK_AT + 8, T.gloss)
        buffer.writef32(b, INK.LOOK_AT + 12, T.film)
        buffer.writef32(b, INK.LOOK2_AT, T.tileShadow)
        buffer.writef32(b, INK.LOOK2_AT + 4, T.tileReflect)
        buffer.writef32(b, INK.LOOK2_AT + 8, T.dripIso)
        buffer.writef32(b, INK.LOOK2_AT + 12, T.dripHeight)
        buffer.writef32(b, INK.LOOK3_AT, T.dripGel)
        buffer.writef32(b, INK.LOOK3_AT + 4, T.gelReach)
        buffer.writef32(b, INK.LOOK3_AT + 8, T.fuseReach)
        buffer.writef32(b, INK.LOOK3_AT + 12, T.fuseAmount)
        buffer.writef32(b, INK.LOOK4_AT, T.skirtTint)
        buffer.writef32(b, INK.LOOK4_AT + 4, T.skirtReach)
        buffer.writef32(b, INK.LOOK4_AT + 8, 0)
        buffer.writef32(b, INK.LOOK4_AT + 12, 0)
        buffer.writef32(b, INK.POST_AT, T.grain)
        buffer.writef32(b, INK.POST_AT + 4, T.grainSize)
        buffer.writef32(b, INK.POST_AT + 8, T.shadowMask)
        buffer.writef32(b, INK.POST_AT + 12, T.brightLift)
        buffer.writef32(b, INK.POST2_AT, T.flicker)
        buffer.writef32(b, INK.POST2_AT + 4, T.flickerRate)
        buffer.writef32(b, INK.POST2_AT + 8, T.edgeGlow)
        buffer.writef32(b, INK.POST2_AT + 12, T.scanDrift)
        crtUbo:write(b)
        local pass = screen:beginRenderPass({
            color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 1 } } },
        })
        pass:setPipeline(crtPipe)
        pass:setBindGroup(0, crtBind)
        pass:draw(3)
        pass:finish()
        renderer:save()
        renderer:transform(Mat2D.withScale(inv, inv))
        renderer:drawImage(screen.image, self.imageSampler, 'srcOver', 1)
        renderer:restore()
    else
        drawScene(self, renderer, true)
    end
    -- Flat, over the finished screen: a knob seen through the CRT's curve is
    -- not where the pointer is.
    TUNER.draw(self.panel, renderer)
end

return function(context: Context): Layout<Board>
    local bubbles: { Bubble } = {}
    for k = 1, MAX_BUBBLES do
        bubbles[k] = { x = math.random() * 1600, y = math.random() * 1000, r = 0.4 + math.random() * 0.6, vy = 0.6 + math.random() * 0.8, phase = math.random() * 6.28 }
    end
    local cellPaths: { Path } = {}
    local cellPaints: { Paint } = {}
    for k = 1, 7 do
        local rgb = KIND_RGB[k]
        cellPaths[k] = Path.new()
        cellPaints[k] = Paint.with({ color = Color.rgba(rgb[1], rgb[2], rgb[3], 240), style = 'fill' })
    end
    local seed = 20260924
    return {
        hud = late(),
        tunerRow = late(),
        tunerHead = late(),
        panel = TUNER.new(),
        panelGesture = false,
        hudInst = nil,

        context = nil,
        size = Vector.xy(1600, 1000),
        scale = 1,
        time = 0,

        game = WET.new(seed),
        seed = seed,
        paused = false,
        fallT = 0,
        lockGrace = 0,
        lockResets = 0,
        lowestRow = -99,
        softDrop = false,
        flash = 0,
        flashRows = {},

        lastKind = 0, lastCol = 0, lastRow = 0, lastLocks = -1,
        offX = 0, offY = 0,
        rotOff = 0,
        cellAt = {},
        cellVel = {},
        drips = DRIPS.new(),
        sound = SOUND.new(),
        music = MUSIC.new(),
        wasOver = false,
        pieceFresh = false,
        visX = 0, visY = 0, visVx = 0, visVy = 0,

        cell = 40,
        ox = 0,
        oy = 0,

        bubbles = bubbles,
        ripples = {},
        energy = 0.6,
        goo = PUDDLE.new(),
        ink = INK.new(),
        stack = nil,
        stackCellPath = Path.new(),
        stackPaint = Paint.with({ color = Color.rgba(209, 209, 209, 240), style = 'fill' }),
        seal = SEAL.new(200, 700),
        sealSide = -1,
        reactSeq = 0,
        reactVariant = '',
        pad = { state = {}, x = 0, y = 0, lastX = 0, holdX = 0 },

        gestureId = -1,
        downAt = Vector.xy(0, 0),
        downTime = 0,
        dragCols = 0,
        dragRows = 0,

        scoreProp = nil,
        linesProp = nil,
        levelProp = nil,
        labProp = nil,
        shownScore = 0,
        pop = 0, popV = 0,
        glow = 0,
        levelFlash = 0,
        hudPath = Path.new(),
        glowPaint = Paint.with({ color = Color.rgba(255, 214, 130, 255), style = 'fill', feather = 22 }),
        barOnPaint = Paint.with({ color = Color.rgba(255, 226, 150, 240), style = 'fill', feather = 2 }),
        barOffPaint = Paint.with({ color = Color.rgba(127, 182, 232, 110), style = 'fill' }),
        bedPaint = Paint.with({ color = Color.rgba(3, 12, 24, 150), style = 'fill', feather = 28 }),
        ringPaint = Paint.with({ color = Color.rgba(255, 226, 150, 255), style = 'stroke', thickness = 4, feather = 8 }),
        labDone = false,

        gpu = false,
        scene = nil, water = nil, screen = nil,
        waterPipe = nil, waterUbo = nil, waterBind = nil, waterBytes = buffer.create(WHIRL_UBO),
        gooCanvas = nil, gooPipe = nil, gooUbo = nil, gooBind = nil, gooBytes = buffer.create(PUDDLE.UBO_SIZE),
        sampler = nil,
        foamA = nil, foamB = nil, foamPipe = nil, foamBytes = buffer.create(PUDDLE.FOAM_UBO_SIZE),
        foamUbos = {}, foamBindsA = {}, foamBindsB = {},
        foamParity = 0, foamFresh = true, foamTime = -1,
        surfaceCanvas = nil, surfacePipe = nil, surfaceUbo = nil,
        surfaceBind = nil, surfaceBindB = nil, surfaceBytes = buffer.create(112 + 16 * 16),
        crtPipe = nil, crtUbo = nil, crtBind = nil, crtBytes = buffer.create(INK.UBO_SIZE),
        imageSampler = ImageSampler('clamp', 'clamp', 'bilinear'),

        wellPath = Path.new(),
        wellPaint = Paint.with({ color = Color.rgba(180, 230, 255, 70), style = 'stroke', thickness = 2 }),
        floorPaint = Paint.with({ color = Color.rgba(3, 14, 28, 110), style = 'fill' }),
        cellPaths = cellPaths,
        cellPaints = cellPaints,
        shinePath = Path.new(),
        shinePaint = Paint.with({ color = Color.rgba(255, 255, 255, 150), style = 'fill' }),
        shadowPath = Path.new(),
        shadowPaint = Paint.with({ color = Color.rgba(0, 10, 30, 200), style = 'fill', feather = 10 }),
        ghostPath = Path.new(),
        ghostPaint = Paint.with({ color = Color.rgba(255, 226, 150, 120), style = 'stroke', thickness = 2, feather = 4 }),
        flashPath = Path.new(),
        flashPaint = Paint.with({ color = Color.rgba(235, 250, 255, 200), style = 'fill', feather = 12 }),
        bubblePath = Path.new(),
        bubblePaint = Paint.with({ color = Color.rgba(205, 240, 255, 90), style = 'stroke', thickness = 1.2 }),
        veilPaint = Paint.with({ color = Color.rgba(7, 24, 43, 170), style = 'fill' }),
        veilPath = Path.new(),

        init = init,
        resize = resize,
        advance = advance,
        draw = draw,
        pointerDown = pointerDown,
        pointerMove = pointerMove,
        pointerUp = pointerUp,
        pointerExit = pointerExit,
        keyboardEvent = keyboardEvent,
        gamepadEvent = gamepadEvent,
        gamepadConnected = gamepadConnected,
        gamepadDisconnected = gamepadDisconnected,
    }
end
