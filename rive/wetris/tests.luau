-- Rules tests for wetris.luau. `npm run wetris:test`.
local WET = require('wetris')
local PUDDLE = require('puddle')
local MUSIC = require('music')

local function fillRow(g: WET.Game, row: number, gap: number)
    for c = 1, WET.W do
        g.cells[row][c] = if c == gap then 0 else 3
    end
end

-- The live piece, for a test that has just made one. A nil here is the test
-- failing, not a case to handle.
local function live(g: WET.Game): WET.Piece
    return g.piece :: WET.Piece
end

-- THE MUSIC'S ENGINE, faked: a clock the test moves, and every copy the
-- transport ever starts, kept across a fake rebuild the way the real engine
-- keeps them. `overlaps` is the whole question — two copies sounding at once.
local LOOP = 115.2

local function fakeEngine()
    local e = { now = 0, starts = {} :: { number } }
    MUSIC.engine = {
        time = function(): number
            return e.now
        end,
        play = function(_src: any): any
            table.insert(e.starts, e.now)
            return { volume = 1, completed = function() return false end }
        end,
        playAtTime = function(_src: any, at: number): any
            table.insert(e.starts, at)
            return { volume = 1, completed = function() return false end }
        end,
    }
    return e
end

local function overlaps(starts: { number }): boolean
    local s = table.clone(starts)
    table.sort(s)
    for i = 2, #s do
        if s[i] - s[i - 1] < LOOP - 1e-6 then
            return true
        end
    end
    return false
end

-- Frames of `dt` until the clock reaches `untilT`, every board stepping.
local function run(e: any, boards: { MUSIC.Music }, untilT: number)
    local dt = 1 / 60
    while e.now < untilT do
        e.now += dt
        for _, b in boards do
            MUSIC.step(b, dt, 0.5)
        end
    end
end

return function(): Tests
    return function(test: Tester)
        test.group('bag', function()
            test.case('every seven pieces are the seven kinds', function(expect)
                local g = WET.new(11)
                local seen = { live(g).kind }
                for i = 1, 6 do
                    table.insert(seen, g.queue[i])
                end
                table.sort(seen)
                for k = 1, 7 do
                    expect(seen[k]).is(k)
                end
            end)

            test.case('a seed is a whole game', function(expect)
                local a, b = WET.new(42), WET.new(42)
                expect(live(a).kind).is(live(b).kind)
                for i = 1, 6 do
                    expect(a.queue[i]).is(b.queue[i])
                end
            end)
        end)

        test.group('moving', function()
            test.case('the walls hold', function(expect)
                local g = WET.new(3)
                local n = 0
                while WET.shift(g, -1, 0) do
                    n += 1
                end
                expect(n < WET.W).is(true)
                for _, c in WET.cellsOf(live(g)) do
                    expect(c[1] >= 1).is(true)
                end
            end)

            test.case('four turns come back to spawn', function(expect)
                local g = WET.new(5)
                g.piece = { kind = 3, rot = 1, col = 4, row = 5 }
                for _ = 1, 4 do
                    expect(WET.rotate(g, 1)).is(true)
                end
                expect(live(g).rot).is(1)
                expect(live(g).col).is(4)
                expect(live(g).row).is(5)
            end)

            test.case('a turn against the wall kicks off it', function(expect)
                local g = WET.new(5)
                -- A vertical I hard against the left wall: flat would poke
                -- through it unless the kick moves it right.
                g.piece = { kind = 1, rot = 4, col = 0, row = 5 }
                expect(WET.fits(g, live(g))).is(true)
                expect(WET.rotate(g, 1)).is(true)
                for _, c in WET.cellsOf(live(g)) do
                    expect(c[1] >= 1).is(true)
                end
            end)
        end)

        test.group('clearing', function()
            test.case('a hard drop into the gap clears the line and scores it', function(expect)
                local g = WET.new(9)
                fillRow(g, WET.H, 1)
                -- A vertical I in column 1.
                g.piece = { kind = 1, rot = 4, col = 0, row = 0 }
                WET.hardDrop(g)
                expect(g.lastClear).is(1)
                expect(g.lines).is(1)
                expect(g.score >= WET.LINE_SCORE[1]).is(true)
                -- The rest of the I fell into the floor row.
                expect(g.cells[WET.H][1]).is(1)
                expect(g.cells[WET.H][2]).is(0)
            end)

            test.case('four at once is the big one', function(expect)
                local g = WET.new(9)
                for r = WET.H - 3, WET.H do
                    fillRow(g, r, 1)
                end
                g.piece = { kind = 1, rot = 4, col = 0, row = 0 }
                WET.hardDrop(g)
                expect(g.lastClear).is(4)
                for c = 1, WET.W do
                    expect(g.cells[WET.H][c]).is(0)
                end
            end)

            test.case('three lines is level 2', function(expect)
                local g = WET.new(9)
                g.lines = 2
                fillRow(g, WET.H, 1)
                g.piece = { kind = 1, rot = 4, col = 0, row = 0 }
                WET.hardDrop(g)
                expect(g.level).is(2)
            end)
        end)

        test.group('holding', function()
            test.case('hold swaps once per piece', function(expect)
                local g = WET.new(7)
                local first = live(g).kind
                expect(WET.hold(g)).is(true)
                expect(g.hold).is(first)
                expect(WET.hold(g)).is(false)
            end)
        end)

        test.group('topping out', function()
            test.case('a full well ends the game', function(expect)
                local g = WET.new(1)
                for r = 1, WET.H do
                    fillRow(g, r, 10)
                end
                g.cells[1][10] = 3
                WET.lock(g)
                expect(g.over).is(true)
            end)
        end)

        test.group('the goo', function()
            -- The goo's field is built from boxes, and a box that covers an
            -- empty cell is goo standing in open water, while a cell no box
            -- covers is a block with no goo round it. Neither shows as an
            -- error; both show as a wrong-looking puddle.
            local function cover(g: WET.Game): ({ { number } }, boolean)
                local f = {
                    dt = 0, cells = g.cells, cols = WET.W, rows = WET.H, cell = 10, ox = 0, oy = 0,
                    piece = {}, pieceVx = 0, pieceVy = 0, px = 1,
                }
                local boxes = PUDDLE.stackBoxes(f)
                local hits: { { number } } = {}
                for r = 1, WET.H do
                    hits[r] = {}
                    for c = 1, WET.W do
                        hits[r][c] = 0
                    end
                end
                for _, b in boxes do
                    for r = b[3], b[4] do
                        for c = b[1], b[2] do
                            hits[r][c] += 1
                        end
                    end
                end
                local exact = true
                for r = 1, WET.H do
                    for c = 1, WET.W do
                        local want = if g.cells[r][c] ~= 0 then 1 else 0
                        if hits[r][c] ~= want then
                            exact = false
                        end
                    end
                end
                return boxes, exact
            end

            test.case('the boxes cover every block exactly once and nothing else', function(expect)
                local g = WET.new(4)
                -- A ragged stack with a hole and an overhang in it.
                for r = 12, WET.H do
                    for c = 1, WET.W do
                        g.cells[r][c] = if (r * 7 + c * 3) % 5 == 0 then 0 else 2
                    end
                end
                local _, exact = cover(g)
                expect(exact).is(true)
            end)

            test.case('a flat stack is a few boxes, not a box per cell', function(expect)
                local g = WET.new(4)
                for r = WET.H - 5, WET.H do
                    for c = 1, WET.W - 1 do
                        g.cells[r][c] = 1
                    end
                end
                local boxes, exact = cover(g)
                expect(exact).is(true)
                expect(#boxes).is(1)
            end)
        end)

        test.group('scoring like the guideline', function()
            -- The TSD slot: the floor row full but for column 5, the row above
            -- full but for 4..6, and an overhang at column 4 above that. A T
            -- turned into it points DOWN (rot 3) at origin (4, H - 2).
            local function tsdBoard(g: WET.Game)
                for c = 1, WET.W do
                    g.cells[WET.H][c] = if c == 5 then 0 else 2
                    g.cells[WET.H - 1][c] = if c >= 4 and c <= 6 then 0 else 2
                end
                g.cells[WET.H - 2][4] = 2
            end

            test.case('a T turned into the slot is a T-spin double: 1200 x level', function(expect)
                local g = WET.new(21)
                tsdBoard(g)
                g.piece = { kind = 3, rot = 3, col = 4, row = WET.H - 2 }
                g.lastRotated, g.lastKick = true, 1
                expect(WET.tspin(g, live(g))).is('full')
                WET.lock(g)
                expect(g.lastClear).is(2)
                expect(g.award.tspin).is('full')
                expect(g.score).is(1200)
            end)

            test.case('the same T SLID in, not turned, is only a double', function(expect)
                local g = WET.new(21)
                tsdBoard(g)
                g.piece = { kind = 3, rot = 3, col = 4, row = WET.H - 2 }
                g.lastRotated = false
                WET.lock(g)
                expect(g.award.tspin).is('')
                expect(g.score).is(300)
            end)

            test.case('a T with only its back corners filled is a mini', function(expect)
                local g = WET.new(21)
                -- Pointing UP on the floor: the two corners below it are the
                -- floor, one top corner is filled by hand, so the FRONT pair
                -- is not both filled.
                g.piece = { kind = 3, rot = 1, col = 4, row = WET.H - 1 }
                g.cells[WET.H - 1][4] = 2
                g.lastRotated, g.lastKick = true, 1
                expect(WET.tspin(g, live(g))).is('mini')
            end)

            test.case('a tetris straight after a tetris pays back-to-back', function(expect)
                local g = WET.new(9)
                for r = WET.H - 3, WET.H do
                    fillRow(g, r, 1)
                end
                g.piece = { kind = 1, rot = 4, col = 0, row = WET.H - 3 }
                WET.lock(g)
                expect(g.score).is(800)
                for r = WET.H - 3, WET.H do
                    fillRow(g, r, 1)
                end
                g.piece = { kind = 1, rot = 4, col = 0, row = WET.H - 3 }
                WET.lock(g)
                expect(g.award.b2b).is(true)
                -- The first tetris is four lines, past level 1's goal of 3, so
                -- the second pays at LEVEL 2: 1200 back-to-back plus 50 for
                -- combo 1, both doubled. (Eight lines then puts it at level 3.)
                expect(g.score).is(800 + (1200 + 50) * 2)
                expect(g.level).is(3)
            end)

            test.case('a single between two tetrises breaks back-to-back', function(expect)
                local g = WET.new(9)
                g.b2b = true
                fillRow(g, WET.H, 1)
                g.piece = { kind = 1, rot = 4, col = 0, row = WET.H - 3 }
                WET.lock(g)
                expect(g.b2b).is(false)
            end)

            test.case('consecutive clears build a combo; a dry lock breaks it', function(expect)
                local g = WET.new(9)
                fillRow(g, WET.H, 1)
                g.piece = { kind = 1, rot = 4, col = 0, row = WET.H - 3 }
                WET.lock(g)
                expect(g.combo).is(0)
                fillRow(g, WET.H, 10)
                g.piece = { kind = 1, rot = 4, col = 9, row = WET.H - 3 }
                WET.lock(g)
                expect(g.combo).is(1)
                expect(g.award.points).is(100 + 50)
                g.piece = { kind = 2, rot = 1, col = 1, row = 0 }
                WET.lock(g)
                expect(g.combo).is(-1)
            end)

            test.case('the goal grows 3, 4, 5 ... to 10 lines a level', function(expect)
                expect(WET.goal(1)).is(3)
                expect(WET.goal(2)).is(4)
                expect(WET.goal(8)).is(10)
                expect(WET.goal(20)).is(10)
                local l, done, goal = WET.levelFor(0)
                expect(l).is(1)
                l, done, goal = WET.levelFor(3)
                expect(l).is(2)
                expect(done).is(0)
                expect(goal).is(4)
                l, done, goal = WET.levelFor(8)
                expect(l).is(3)
                expect(done).is(1)
                l = WET.levelFor(52)
                expect(l).is(9)
            end)

            test.case('a clear that crosses a goal is a level-up', function(expect)
                local g = WET.new(9)
                g.lines = 2
                fillRow(g, WET.H, 1)
                g.piece = { kind = 1, rot = 4, col = 0, row = WET.H - 3 }
                WET.lock(g)
                expect(g.level).is(2)
                expect(g.award.levelUp).is(true)
            end)
        end)

        test.group('the music is only ever one copy', function()
            test.case('two boards in one context start one loop', function(expect)
                local e = fakeEngine()
                MUSIC.reset()
                MUSIC.loadSource({}, LOOP)
                local a, b = MUSIC.new(), MUSIC.new()
                e.now = 0.4
                run(e, { a, b }, 400)
                expect(overlaps(e.starts)).is(false)
                expect(#e.starts >= 3).is(true)
            end)

            test.case('a board rebuilt mid-loop carries the same loop on', function(expect)
                local e = fakeEngine()
                MUSIC.reset()
                MUSIC.loadSource({}, LOOP)
                e.now = 0.4
                run(e, { MUSIC.new() }, 90)
                -- the first board is gone; a new one arrives and drives
                run(e, { MUSIC.new() }, 400)
                expect(overlaps(e.starts)).is(false)
            end)

            test.case('a rebuild never doubles the loop, wherever in it the save lands', function(expect)
                for saveAt = 3, 700, 7.3 do
                    local e = fakeEngine()
                    MUSIC.reset()
                    MUSIC.loadSource({}, LOOP)
                    e.now = 0.4
                    run(e, { MUSIC.new() }, saveAt)
                    -- THE REBUILD: a fresh module, the engine and its copies carry on
                    MUSIC.reset()
                    MUSIC.loadSource({}, LOOP)
                    e.now += 0.5
                    run(e, { MUSIC.new() }, saveAt + 3 * LOOP)
                    expect(overlaps(e.starts)).is(false)
                end
            end)

            test.case('and two rebuilds in quick succession do not either', function(expect)
                local e = fakeEngine()
                MUSIC.reset()
                MUSIC.loadSource({}, LOOP)
                e.now = 0.4
                run(e, { MUSIC.new() }, 113.5)
                for _ = 1, 3 do
                    MUSIC.reset()
                    MUSIC.loadSource({}, LOOP)
                    e.now += 0.4
                    run(e, { MUSIC.new() }, e.now + 0.6)
                end
                run(e, { MUSIC.new() }, 600)
                expect(overlaps(e.starts)).is(false)
            end)

            test.case('a first launch starts the loop within a couple of seconds', function(expect)
                local e = fakeEngine()
                MUSIC.reset()
                MUSIC.loadSource({}, LOOP)
                e.now = 0.4
                run(e, { MUSIC.new() }, 1)
                expect(#e.starts).is(1)
                expect(e.starts[1] < 3).is(true)
            end)
        end)

        test.group('gravity', function()
            test.case('level 1 is a second a row; the ramp is steeper than the guideline', function(expect)
                expect(math.abs(WET.gravity(1) - 1) < 1e-9).is(true)
                -- The guideline's level 10 is 0.064s a row; wetris is past it.
                expect(WET.gravity(10) < 0.064).is(true)
                expect(WET.gravity(12) <= 0.021).is(true)
            end)

            test.case('it only gets faster', function(expect)
                local last = math.huge
                for level = 1, 30 do
                    local s = WET.gravity(level)
                    expect(s <= last).is(true)
                    expect(s > 0).is(true)
                    last = s
                end
            end)
        end)
    end
end
