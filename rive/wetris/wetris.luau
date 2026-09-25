-- ============================================================================
-- WETRIS — the rules, and nothing else.
--
-- The same split as sealitaire's klondike.luau: no drawing, no pointer, no
-- springs, so `rive rive/wetris --test` proves the rules without a frame ever
-- rendering (tests.luau). board.luau owns everything you can see.
--
-- Rows count DOWN from the top: row 1 is the ceiling, row H the floor. A cell
-- is 0 when empty, otherwise the kind (1..7) of the piece that left it, which
-- is all the board needs to remember to colour it.
--
-- Rotation is SRS-shaped (the four states, the standard kick tables) because a
-- stacker that kicks differently from every other one feels broken to anybody
-- who has played one. Scoring is the plain guideline table; both are the first
-- things a real design pass will want to touch.
-- ============================================================================

local M = {}

M.W = 10
M.H = 20
-- Hidden rows above the ceiling a piece spawns into, so a tall piece can
-- rotate on arrival without clipping the lid.
M.SPAWN_ROW = 0

-- 1 I, 2 O, 3 T, 4 S, 5 Z, 6 J, 7 L. Each state is four {col, row} cells
-- relative to the piece's origin; state 1 is spawn, then clockwise.
local SHAPES: { { { { number } } } } = {
    { -- I
        { { 0, 1 }, { 1, 1 }, { 2, 1 }, { 3, 1 } },
        { { 2, 0 }, { 2, 1 }, { 2, 2 }, { 2, 3 } },
        { { 0, 2 }, { 1, 2 }, { 2, 2 }, { 3, 2 } },
        { { 1, 0 }, { 1, 1 }, { 1, 2 }, { 1, 3 } },
    },
    { -- O
        { { 1, 0 }, { 2, 0 }, { 1, 1 }, { 2, 1 } },
        { { 1, 0 }, { 2, 0 }, { 1, 1 }, { 2, 1 } },
        { { 1, 0 }, { 2, 0 }, { 1, 1 }, { 2, 1 } },
        { { 1, 0 }, { 2, 0 }, { 1, 1 }, { 2, 1 } },
    },
    { -- T
        { { 1, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } },
        { { 1, 0 }, { 1, 1 }, { 2, 1 }, { 1, 2 } },
        { { 0, 1 }, { 1, 1 }, { 2, 1 }, { 1, 2 } },
        { { 1, 0 }, { 0, 1 }, { 1, 1 }, { 1, 2 } },
    },
    { -- S
        { { 1, 0 }, { 2, 0 }, { 0, 1 }, { 1, 1 } },
        { { 1, 0 }, { 1, 1 }, { 2, 1 }, { 2, 2 } },
        { { 1, 1 }, { 2, 1 }, { 0, 2 }, { 1, 2 } },
        { { 0, 0 }, { 0, 1 }, { 1, 1 }, { 1, 2 } },
    },
    { -- Z
        { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 2, 1 } },
        { { 2, 0 }, { 1, 1 }, { 2, 1 }, { 1, 2 } },
        { { 0, 1 }, { 1, 1 }, { 1, 2 }, { 2, 2 } },
        { { 1, 0 }, { 0, 1 }, { 1, 1 }, { 0, 2 } },
    },
    { -- J
        { { 0, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } },
        { { 1, 0 }, { 2, 0 }, { 1, 1 }, { 1, 2 } },
        { { 0, 1 }, { 1, 1 }, { 2, 1 }, { 2, 2 } },
        { { 1, 0 }, { 1, 1 }, { 0, 2 }, { 1, 2 } },
    },
    { -- L
        { { 2, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } },
        { { 1, 0 }, { 1, 1 }, { 1, 2 }, { 2, 2 } },
        { { 0, 1 }, { 1, 1 }, { 2, 1 }, { 0, 2 } },
        { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 1, 2 } },
    },
}
M.SHAPES = SHAPES

-- SRS wall kicks, indexed by the state being LEFT, for a clockwise turn.
-- Counter-clockwise uses the negation of the kicks for the turn it reverses.
-- Rows are y-down here, so the published +y values are flipped.
local KICKS_JLSTZ: { { { number } } } = {
    { { 0, 0 }, { -1, 0 }, { -1, -1 }, { 0, 2 }, { -1, 2 } },
    { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 0, -2 }, { 1, -2 } },
    { { 0, 0 }, { 1, 0 }, { 1, -1 }, { 0, 2 }, { 1, 2 } },
    { { 0, 0 }, { -1, 0 }, { -1, 1 }, { 0, -2 }, { -1, -2 } },
}
local KICKS_I: { { { number } } } = {
    { { 0, 0 }, { -2, 0 }, { 1, 0 }, { -2, 1 }, { 1, -2 } },
    { { 0, 0 }, { -1, 0 }, { 2, 0 }, { -1, -2 }, { 2, 1 } },
    { { 0, 0 }, { 2, 0 }, { -1, 0 }, { 2, -1 }, { -1, 2 } },
    { { 0, 0 }, { 1, 0 }, { -2, 0 }, { 1, 2 }, { -2, -1 } },
}

-- THE GUIDELINE'S SCORING, every entry multiplied by the level:
--
--   lines at once   single 100, double 300, triple 500, tetris 800
--   T-spin          none 400, single 800, double 1200, triple 1600
--   T-spin mini     none 100, single 200, double 400
--   back-to-back    a tetris or a line-clearing T-spin right after another
--                   one (anything that clears lines in between breaks it;
--                   a lock that clears nothing does not) pays 1.5x
--   combo           every consecutive lock that clears lines pays 50 x
--                   combo x level on top, from the second one
--   drops           soft 1 per row, hard 2 per row (not x level)
--
-- LEVELS COME QUICKLY, THEN THE WATER SPEEDS UP. Not the guideline's fixed ten
-- lines a level: the goal starts at 3 and grows by one a level up to 10 (3, 4,
-- 5 ... 10, 10), so level 2 is three lines in and the early levels are a
-- handful of lines each. And the speed rides the guideline's gravity curve at
-- RAMP levels per level, so each level is a bigger step than the guideline's
-- — top speed arrives around level 12, about 80 lines. Tests hold every row.
M.LINE_SCORE = { 100, 300, 500, 800 }
M.TSPIN_SCORE = { 400, 800, 1200, 1600 }   -- index: lines + 1
M.MINI_SCORE = { 100, 200, 400 }           -- index: lines + 1
M.COMBO_SCORE = 50
M.B2B = 1.5
M.GOAL_START = 3            -- lines from level 1 to level 2
M.GOAL_MAX = 10             -- the most any level asks for
M.RAMP = 1.15               -- guideline levels of speed per wetris level
M.LINES_PER_LEVEL = M.GOAL_MAX   -- the level bar's segment count

--- Lines level `level` asks for before the next.
function M.goal(level: number): number
    return math.min(M.GOAL_MAX, M.GOAL_START + math.max(1, level) - 1)
end

--- The level for a total of `lines`, and how far into it: (level, done, goal).
function M.levelFor(lines: number): (number, number, number)
    local level, left = 1, lines
    while left >= M.goal(level) do
        left -= M.goal(level)
        level += 1
    end
    return level, left, M.goal(level)
end

export type Piece = { kind: number, rot: number, col: number, row: number }

export type Game = {
    cells: { { number } },   -- cells[row][col], row 1 = top
    piece: Piece?,
    hold: number,            -- 0 = empty
    holdUsed: boolean,       -- once per piece
    queue: { number },       -- upcoming kinds, [1] is next
    rng: number,             -- LCG state, so a seed replays exactly
    score: number,
    lines: number,
    level: number,
    over: boolean,
    lastClear: number,       -- lines cleared by the most recent lock (0..4)
    clearedRows: { number }, -- which rows that lock cleared, for board.luau's splash
    locks: number,           -- total pieces locked; board.luau watches it for edges
    -- The guideline's memory between locks:
    lastRotated: boolean,    -- the last successful move was a turn (a T-spin needs it)
    lastKick: number,        -- which kick that turn used (5 is the one that makes any T-spin full)
    combo: number,           -- consecutive line-clearing locks, -1 when the run is broken
    b2b: boolean,            -- the last line clear was a tetris or a T-spin
    award: Award,            -- what the most recent lock paid, for the readout
}

-- What one lock paid and why, so the board can say it without re-deriving it.
export type Award = {
    points: number,
    lines: number,
    tspin: string,           -- '', 'mini' or 'full'
    b2b: boolean,            -- the back-to-back bonus applied
    combo: number,           -- the combo this lock extended, 0 if none
    levelUp: boolean,
}

-- ---------------------------------------------------------------------------
-- The bag. A plain LCG so a seed is a whole game, which is what tests need and
-- what a daily-seed mode would need later.

local function nextRand(g: Game): number
    g.rng = (g.rng * 1103515245 + 12345) % 2147483648
    return g.rng / 2147483648
end

local function refill(g: Game)
    local bag = { 1, 2, 3, 4, 5, 6, 7 }
    for i = 7, 2, -1 do
        local j = math.floor(nextRand(g) * i) + 1
        bag[i], bag[j] = bag[j], bag[i]
    end
    for _, k in bag do
        table.insert(g.queue, k)
    end
end

local function take(g: Game): number
    if #g.queue < 7 then
        refill(g)
    end
    return table.remove(g.queue, 1) :: number
end

-- ---------------------------------------------------------------------------

function M.cellsOf(p: Piece): { { number } }
    local out = {}
    for _, c in SHAPES[p.kind][p.rot] do
        table.insert(out, { p.col + c[1], p.row + c[2] })
    end
    return out
end

function M.fits(g: Game, p: Piece): boolean
    for _, c in SHAPES[p.kind][p.rot] do
        local col = p.col + c[1]
        local row = p.row + c[2]
        if col < 1 or col > M.W or row > M.H then
            return false
        end
        -- Above the ceiling is open air: only the walls and the floor hold.
        if row >= 1 and g.cells[row][col] ~= 0 then
            return false
        end
    end
    return true
end

local function spawn(g: Game, kind: number)
    local p = { kind = kind, rot = 1, col = 4, row = M.SPAWN_ROW }
    g.piece = p
    g.holdUsed = false
    g.lastRotated = false
    g.lastKick = 0
    if not M.fits(g, p) then
        g.over = true
    end
end

function M.new(seed: number): Game
    local cells = {}
    for r = 1, M.H do
        local row = {}
        for c = 1, M.W do
            row[c] = 0
        end
        cells[r] = row
    end
    local g: Game = {
        cells = cells,
        piece = nil,
        hold = 0,
        holdUsed = false,
        queue = {},
        rng = math.max(1, math.floor(seed)) % 2147483648,
        score = 0,
        lines = 0,
        level = 1,
        over = false,
        lastClear = 0,
        clearedRows = {},
        locks = 0,
        lastRotated = false,
        lastKick = 0,
        combo = -1,
        b2b = false,
        award = { points = 0, lines = 0, tspin = '', b2b = false, combo = 0, levelUp = false },
    }
    spawn(g, take(g))
    return g
end

--- Shift the live piece. True if it moved.
function M.shift(g: Game, dc: number, dr: number): boolean
    local p = g.piece
    if g.over or p == nil then
        return false
    end
    local moved = { kind = p.kind, rot = p.rot, col = p.col + dc, row = p.row + dr }
    if not M.fits(g, moved) then
        return false
    end
    g.piece = moved
    g.lastRotated = false
    return true
end

--- Turn the live piece: dir 1 clockwise, -1 counter. True if it turned.
function M.rotate(g: Game, dir: number): boolean
    local p = g.piece
    if g.over or p == nil or p.kind == 2 then
        return false
    end
    local to = ((p.rot - 1 + dir) % 4) + 1
    local table_ = if p.kind == 1 then KICKS_I else KICKS_JLSTZ
    local kicks: { { number } }
    local sign = 1
    if dir == 1 then
        kicks = table_[p.rot]
    else
        kicks = table_[to]
        sign = -1
    end
    for i, k in kicks do
        local tried = { kind = p.kind, rot = to, col = p.col + k[1] * sign, row = p.row + k[2] * sign }
        if M.fits(g, tried) then
            g.piece = tried
            g.lastRotated = true
            g.lastKick = i
            return true
        end
    end
    return false
end

--- Where the live piece would land, for the ghost.
function M.ghost(g: Game): Piece?
    local p = g.piece
    if p == nil then
        return nil
    end
    local drop = { kind = p.kind, rot = p.rot, col = p.col, row = p.row }
    while true do
        local below = { kind = drop.kind, rot = drop.rot, col = drop.col, row = drop.row + 1 }
        if not M.fits(g, below) then
            break
        end
        drop = below
    end
    return drop
end

local function clearLines(g: Game): number
    local cleared = {}
    for r = 1, M.H do
        local full = true
        for c = 1, M.W do
            if g.cells[r][c] == 0 then
                full = false
                break
            end
        end
        if full then
            table.insert(cleared, r)
        end
    end
    -- Top to bottom, so each removal leaves the indices below it untouched.
    for _, r in cleared do
        table.remove(g.cells, r)
        local fresh = {}
        for c = 1, M.W do
            fresh[c] = 0
        end
        table.insert(g.cells, 1, fresh)
    end
    g.clearedRows = cleared
    return #cleared
end

local function blocked(g: Game, col: number, row: number): boolean
    if col < 1 or col > M.W or row > M.H then
        return true
    end
    return row >= 1 and g.cells[row][col] ~= 0
end

-- THE T-SPIN, the guideline's three-corner rule: a T whose last move was a
-- turn, with three of the four corners of its 3x3 box filled (the walls and
-- the floor count). FULL when both corners on the side it points to are
-- filled, or when the turn needed the last kick; MINI otherwise.
function M.tspin(g: Game, p: Piece): string
    if p.kind ~= 3 or not g.lastRotated then
        return ''
    end
    local c, r = p.col, p.row
    local tl, tr = blocked(g, c, r), blocked(g, c + 2, r)
    local bl, br = blocked(g, c, r + 2), blocked(g, c + 2, r + 2)
    local n = (if tl then 1 else 0) + (if tr then 1 else 0) + (if bl then 1 else 0) + (if br then 1 else 0)
    if n < 3 then
        return ''
    end
    -- The front corners, by where the T points: up, right, down, left.
    local front = if p.rot == 1 then (tl and tr) elseif p.rot == 2 then (tr and br)
        elseif p.rot == 3 then (bl and br) else (tl and bl)
    return if front or g.lastKick == 5 then 'full' else 'mini'
end

--- Weld the live piece into the board, clear, score, and bring the next one.
function M.lock(g: Game)
    local p = g.piece
    if g.over or p == nil then
        return
    end
    -- Read before the piece is written: its own cells are not corners, but a
    -- clear would move the ones that are.
    local spin = M.tspin(g, p)
    local above = false
    for _, c in M.cellsOf(p) do
        if c[2] < 1 then
            above = true
        else
            g.cells[c[2]][c[1]] = p.kind
        end
    end
    g.locks += 1
    local n = clearLines(g)
    g.lastClear = n
    local base = 0
    if spin == 'full' then
        base = M.TSPIN_SCORE[n + 1] or 0
    elseif spin == 'mini' then
        base = M.MINI_SCORE[n + 1] or M.MINI_SCORE[3]
    elseif n > 0 then
        base = M.LINE_SCORE[n]
    end
    local difficult = n > 0 and (n == 4 or spin ~= '')
    local b2b = difficult and g.b2b
    if b2b then
        base = math.floor(base * M.B2B)
    end
    local points = base * g.level
    local combo = 0
    if n > 0 then
        g.combo += 1
        combo = g.combo
        if g.combo > 0 then
            points += M.COMBO_SCORE * g.combo * g.level
        end
        -- Any clear decides the next back-to-back; a lock that clears nothing
        -- leaves it where it was.
        g.b2b = difficult
    else
        g.combo = -1
    end
    local was = g.level
    g.score += points
    g.lines += n
    g.level = (M.levelFor(g.lines))
    g.award = { points = points, lines = n, tspin = spin, b2b = b2b, combo = combo, levelUp = g.level > was }
    -- Locking with a cell still above the lid is a top-out, even if the
    -- next piece would have fitted.
    if above then
        g.over = true
        g.piece = nil
        return
    end
    spawn(g, take(g))
end

--- One gravity step. Locks if it cannot fall. True if the piece locked.
function M.fall(g: Game): boolean
    if M.shift(g, 0, 1) then
        return false
    end
    M.lock(g)
    return true
end

--- Drop to the floor and lock. Two points per row, the guideline's rate.
function M.hardDrop(g: Game): number
    local rows = 0
    while M.shift(g, 0, 1) do
        rows += 1
    end
    g.score += rows * 2
    M.lock(g)
    return rows
end

--- Swap the live piece with the held one, once per piece.
function M.hold(g: Game): boolean
    local p = g.piece
    if g.over or p == nil or g.holdUsed then
        return false
    end
    local held = g.hold
    g.hold = p.kind
    spawn(g, if held ~= 0 then held else take(g))
    g.holdUsed = true
    return true
end

--- Seconds per row at a level: the guideline curve, (0.8 - (L-1) x 0.007)^(L-1),
--- floored so the top levels are fast rather than instant. Soft drop is this
--- divided by SOFT_DROP; lock delay and its move-reset limit are the board's
--- (they are clocks, not rules).
function M.gravity(level: number): number
    local l = (math.max(1, level) - 1) * M.RAMP
    return math.max(0.02, (0.8 - l * 0.007) ^ l)
end

M.SOFT_DROP = 20
M.LOCK_DELAY = 0.5
M.LOCK_RESETS = 15

return M
