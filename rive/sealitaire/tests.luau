-- Rules tests for klondike.luau. `rive rive/sealitaire --test`.
local K = require('klondike')
local BAIT = require('baitball')
local MUSIC = require('music')
local LAYOUT = require('layout')
local PAD = require('pad')
local KNOCK = require('knock')
local BSPRING = require('bonespring')
local HOVER = require('hover')
local REACT = require('react')
local CASCADE = require('cascade')
local PUPPET = require('puppet')
local BUB = require('bubbles')

-- A music bake in memory. --test has no file to resolve an asset against, so
-- MUSIC.load cannot run here — but MUSIC.parse can, and this goes THROUGH it
-- rather than filling the Music table by hand.
--
-- That distinction earns its keep. A fake that assigns `m.head` itself agrees
-- with the parser about nothing: the loop table was added between the bands
-- and the frames, and a hand-filled fake would have kept passing every firing
-- test while the real parser read the loop records as audio frames. Building
-- the bytes and parsing them is the only version of this that can fail when
-- the layout moves.
local function bakeBytes(
    bands: number,
    frames: number,
    rate: number,
    barSeconds: number,
    loops: { MUSIC.Loop },
    at: (number, number) -> (number, number)
): buffer
    local head = 36 + bands * 4
    local data = buffer.create(head + #loops * 36 + frames * bands * 2)
    buffer.writestring(data, 0, 'SMUS')
    buffer.writeu32(data, 4, 3)
    buffer.writeu32(data, 8, frames)
    buffer.writef32(data, 12, rate)
    buffer.writef32(data, 16, frames / rate)
    buffer.writeu32(data, 20, bands)
    for k = 1, bands do
        buffer.writef32(data, 24 + (k - 1) * 4, 100 * k)
    end
    buffer.writef32(data, 24 + bands * 4, barSeconds)
    buffer.writeu32(data, 28 + bands * 4, 4)      -- blockBars
    buffer.writeu32(data, 32 + bands * 4, #loops)
    for i, l in ipairs(loops) do
        local o = head + (i - 1) * 36
        buffer.writestring(data, o, l.id)
        buffer.writef32(data, o + 16, l.startSec)
        buffer.writef32(data, o + 20, l.endSec)
        buffer.writeu8(data, o + 24, l.role)
        buffer.writeu8(data, o + 25, l.gate)
        buffer.writef32(data, o + 28, l.gateN)
        buffer.writef32(data, o + 32, l.washSeconds)
    end
    local at0 = head + #loops * 36
    for f = 0, frames - 1 do
        for k = 1, bands do
            local level, flux = at(f, k)
            local o = at0 + (f * bands + (k - 1)) * 2
            buffer.writeu8(data, o, math.floor(level * 255 + 0.5))
            buffer.writeu8(data, o + 1, math.floor(flux * 255 + 0.5))
        end
    end
    return data
end

local function fakeBake(bands: number, frames: number, rate: number, at: (number, number) -> (number, number)): MUSIC.Music
    local m = MUSIC.new()
    assert(MUSIC.parse(m, bakeBytes(bands, frames, rate, 0, {}, at)), 'the fake bake did not parse')
    return m
end

-- A loop row, spelled out so the tests below read as music rather than as
-- six positional numbers.
local function loop(id: string, startSec: number, endSec: number, role: number, gate: number, gateN: number): MUSIC.Loop
    return {
        id = id, startSec = startSec, endSec = endSec,
        role = role, gate = gate, gateN = gateN, washSeconds = 0, wash = nil,
    }
end

local function prog(deals: number, wins: number, foundations: number, score: number, moves: number): MUSIC.Progress
    return { deals = deals, wins = wins, foundations = foundations, score = score, moves = moves }
end

return function(): Tests
    return function(test: Tester)
        test.group('deal', function()
            test.case('deals 28 to the tableau and 24 to the stock', function(expect)
                local g = K.new(7)
                local n = 0
                for col = 1, 7 do
                    expect(#g.tableau[col].cards).is(col)
                    n += col
                    expect(g.tableau[col].cards[col].faceUp).is(true)
                    if col > 1 then
                        expect(g.tableau[col].cards[1].faceUp).is(false)
                    end
                end
                expect(n).is(28)
                expect(#g.stock.cards).is(24)
                expect(#g.waste.cards).is(0)
            end)
            test.case('a seed reproduces the same deal', function(expect)
                local a = K.new(1234)
                local b = K.new(1234)
                for col = 1, 7 do
                    expect(a.tableau[col].cards[col].id).is(b.tableau[col].cards[col].id)
                end
                expect(a.stock.cards[1].id).is(b.stock.cards[1].id)
            end)
            test.case('every card appears exactly once', function(expect)
                local g = K.new(99)
                local seen = table.create(52, false)
                local count = 0
                for _, p in ipairs(K.piles(g)) do
                    for _, c in ipairs(p.cards) do
                        expect(seen[c.id]).is(false)
                        seen[c.id] = true
                        count += 1
                    end
                end
                expect(count).is(52)
            end)
        end)

        test.group('stacking', function()
            test.case('tableau wants alternate colour, one lower', function(expect)
                local dest: K.Pile = { kind = 'tableau', index = 1, cards = { { id = 1, suit = 1, rank = 8, faceUp = true } } }
                expect(K.canStackOnTableau({ id = 2, suit = 3, rank = 7, faceUp = true }, dest)).is(true)
                expect(K.canStackOnTableau({ id = 3, suit = 2, rank = 7, faceUp = true }, dest)).is(false)
                expect(K.canStackOnTableau({ id = 4, suit = 3, rank = 6, faceUp = true }, dest)).is(false)
            end)
            test.case('only a king takes an empty column', function(expect)
                local dest: K.Pile = { kind = 'tableau', index = 1, cards = {} }
                expect(K.canStackOnTableau({ id = 1, suit = 1, rank = 13, faceUp = true }, dest)).is(true)
                expect(K.canStackOnTableau({ id = 2, suit = 1, rank = 12, faceUp = true }, dest)).is(false)
            end)
            test.case('foundation builds by suit from the ace', function(expect)
                local dest: K.Pile = { kind = 'foundation', index = 1, cards = {} }
                expect(K.canStackOnFoundation({ id = 1, suit = 4, rank = 1, faceUp = true }, dest)).is(true)
                expect(K.canStackOnFoundation({ id = 2, suit = 4, rank = 2, faceUp = true }, dest)).is(false)
                table.insert(dest.cards, { id = 1, suit = 4, rank = 1, faceUp = true })
                expect(K.canStackOnFoundation({ id = 2, suit = 4, rank = 2, faceUp = true }, dest)).is(true)
                expect(K.canStackOnFoundation({ id = 3, suit = 3, rank = 2, faceUp = true }, dest)).is(false)
            end)
        end)

        test.group('moving', function()
            test.case('a move flips the card it uncovers and scores it', function(expect)
                local g = K.new(5)
                -- Build a legal move by hand: put a red 7 on column 1 (which holds
                -- one face-up card) and a navy 6 as the run on column 2.
                g.tableau[1].cards = { { id = 60, suit = 1, rank = 7, faceUp = true } }
                g.tableau[2].cards = {
                    { id = 61, suit = 2, rank = 3, faceUp = false },
                    { id = 62, suit = 3, rank = 6, faceUp = true },
                }
                local r = K.move(g, g.tableau[2], 2, g.tableau[1])
                expect(r.ok).is(true)
                expect(r.flipped).is(true)
                expect(#g.tableau[1].cards).is(2)
                expect(g.tableau[2].cards[1].faceUp).is(true)
                expect(g.moves).is(1)
                expect(g.score).is(5)
            end)
            test.case('an illegal move changes nothing', function(expect)
                local g = K.new(5)
                g.tableau[1].cards = { { id = 60, suit = 1, rank = 7, faceUp = true } }
                g.tableau[2].cards = { { id = 62, suit = 1, rank = 6, faceUp = true } }
                local r = K.move(g, g.tableau[2], 1, g.tableau[1])
                expect(r.ok).is(false)
                expect(#g.tableau[2].cards).is(1)
                expect(g.moves).is(0)
            end)
            test.case('a face-down run cannot be picked up', function(expect)
                local g = K.new(5)
                expect(K.runFrom(g.tableau[3], 1)).is(nil)
                expect(#(K.runFrom(g.tableau[3], 3) :: { K.Card })).is(1)
            end)
        end)

        -- M.plays is what the seal's flippers point at, so a play it invents is
        -- a fin pointing at nothing and a play it drops is a chance the player
        -- is never shown.
        -- The seal's bubbles. The interesting claim is the SHED's: that a part
        -- of the body moving faster sheds more than in proportion, which is the
        -- whole of "the fastest parts do the most".
        -- The swim's fluidity: the landing point easing rather than teleporting,
        -- the lean toward the pointer with nothing settled on, and hysteresis
        -- on the clip thresholds.
        test.group('fluid swim', function()
            local function frame(cursor: any, card: any, landEase: number, lean: number): PUPPET.Frame
                return {
                    w = 1600, h = 1000, L = 150, pxUnit = 150 / 1.68,
                    row = { x = 800, y = 500 }, stage = { x = 800, y = 850 },
                    reactSeq = 0, reactVariant = 'spin', reactSpeed = 1,
                    card = card, cursor = cursor, corner = nil, mouthDx = 0, mouthDy = 0,
                    biting = false, releaseT = -1, dragging = false, won = false,
                    thrust = 6.4, friction = 0.965, maxSpeed = 34, turnLerp = 2.5, steer = 11,
                    landEase = landEase, lean = lean,
                    arrive = 0.45, blendRate = 2.3, blendTime = 0.5, turnSettle = 11,
                    moveThreshold = 1.5, boostThreshold = 18, crossfade = 0.2, clipScale = 1,
                    bobAmp = 0, bobPeriod = 2.8,
                    biteOffset = 0.1, jawClamp = 0.08, biteHold = 0.15, releaseTime = 1.6, releaseLift = 0.8, releasePush = 0,
                    steerTight = 2.3,
                }
            end

            test.case('the landing point eases to a new card instead of teleporting', function(expect)
                local p = PUPPET.new(800, 500)
                -- Settled on a card on the left.
                for _ = 1, 240 do
                    PUPPET.update(p, 1 / 60, frame(nil, { x = 300, y = 400 }, 6, 0.4))
                end
                local was = p.land.x
                -- The hover jumps to a card far to the right. The state does not
                -- change — `card` is still what is wanted — so nothing crossfades
                -- and only the easing stands between this and a teleport.
                PUPPET.update(p, 1 / 60, frame(nil, { x = 1300, y = 400 }, 6, 0.4))
                local step = p.land.x - was
                expect(step > 0).is(true)
                -- One frame of a 6/s ease is about a tenth of the gap, and the
                -- gap here is 1000px.
                expect(step < 200).is(true)
                -- ...and it still gets all the way there.
                for _ = 1, 240 do
                    PUPPET.update(p, 1 / 60, frame(nil, { x = 1300, y = 400 }, 6, 0.4))
                end
                expect(math.abs(p.land.x - was - 1000) < 30).is(true)
            end)

            test.case('at landEase 0 it is the old teleport', function(expect)
                local p = PUPPET.new(800, 500)
                for _ = 1, 240 do
                    PUPPET.update(p, 1 / 60, frame(nil, { x = 300, y = 400 }, 0, 0.4))
                end
                local was = p.land.x
                PUPPET.update(p, 1 / 60, frame(nil, { x = 1300, y = 400 }, 0, 0.4))
                expect(p.land.x - was > 900).is(true)
            end)

            test.case('with nothing settled the body leans toward the pointer', function(expect)
                local p = PUPPET.new(800, 500)
                -- The pointer well to the right, no card hovered: `idle`, whose
                -- anchor is the row pulled `lean` of the way to the pointer.
                for _ = 1, 600 do
                    PUPPET.update(p, 1 / 60, frame({ x = 1400, y = 500 }, nil, 6, 0.4))
                end
                -- 800 + 0.4 x 600 = 1040.
                expect(math.abs(p.land.x - 1040) < 12).is(true)
                -- And it is a LEAN, not a follow: clearly short of the pointer.
                expect(p.land.x < 1200).is(true)
            end)

            test.case('a pointer off the table leans nowhere', function(expect)
                local p = PUPPET.new(800, 500)
                for _ = 1, 600 do
                    PUPPET.update(p, 1 / 60, frame(nil, nil, 6, 0.4))
                end
                expect(math.abs(p.land.x - 800) < 6).is(true)
            end)

            test.case('a speed sitting on a threshold does not flip the clip', function(expect)
                local p = PUPPET.new(800, 500)
                p.clipState = 'swim'
                p.clipSpeed = 1.6
                local f = frame(nil, nil, 6, 0.4)
                local flips = 0
                local last = p.clipState
                -- Jitter either side of moveThreshold, which is what a slow
                -- approach actually does. Without the band this flipped every
                -- few frames and restarted a crossfade each time.
                for k = 1, 600 do
                    p.speed = 1.5 + math.sin(k * 0.7) * 0.18
                    PUPPET.clips(p, 1 / 60, f)
                    if p.clipState ~= last then
                        flips += 1
                        last = p.clipState
                    end
                end
                expect(flips).is(0)
            end)

            test.case('but a real change of pace still changes the clip', function(expect)
                local p = PUPPET.new(800, 500)
                p.clipState = 'idle'
                p.clipSpeed = 0
                local f = frame(nil, nil, 6, 0.4)
                p.speed = 8
                for _ = 1, 120 do
                    PUPPET.clips(p, 1 / 60, f)
                end
                expect(p.clipState).is('swim')
                p.speed = 30
                for _ = 1, 120 do
                    PUPPET.clips(p, 1 / 60, f)
                end
                expect(p.clipState).is('boost')
                p.speed = 0
                for _ = 1, 240 do
                    PUPPET.clips(p, 1 / 60, f)
                end
                expect(p.clipState).is('idle')
            end)
        end)

        -- The flipper's flick across the deck as a card is drawn.
        test.group('deal swipe', function()
            test.case('it is nothing outside its own window', function(expect)
                expect(REACT.swipe(0)).is(0)
                expect(REACT.swipe(1)).is(0)
                expect(REACT.swipe(-0.5)).is(0)
                expect(REACT.swipe(2)).is(0)
            end)

            test.case('it winds up one way, sweeps the other, and comes back', function(expect)
                local lo, hi, loAt, hiAt = 1, -1, 0, 0
                for k = 0, 1000 do
                    local u = k / 1000
                    local v = REACT.swipe(u)
                    if v < lo then lo, loAt = v, u end
                    if v > hi then hi, hiAt = v, u end
                end
                -- The full throw both ways...
                expect(math.abs(lo + 1) < 1e-6).is(true)
                expect(math.abs(hi - 1) < 1e-6).is(true)
                -- ...the wind-up BEFORE the sweep, which is what makes it read
                -- as a gesture rather than a drift...
                expect(loAt < hiAt).is(true)
                -- ...and settled by the end.
                expect(math.abs(REACT.swipe(0.999)) < 0.02).is(true)
            end)

            test.case('no seam in it anywhere', function(expect)
                -- Three pieces joined at two seams, and a curve that jumps at a
                -- seam is a flipper that teleports. Sampled far finer than a
                -- frame, so no step may exceed what the fastest stretch of the
                -- sweep covers in one.
                local prev = REACT.swipe(0)
                local worst = 0
                for k = 1, 20000 do
                    local v = REACT.swipe(k / 20000)
                    worst = math.max(worst, math.abs(v - prev))
                    prev = v
                end
                expect(worst < 0.002).is(true)
            end)
        end)

        test.group('bubbles', function()
            local function spec(): any
                return {
                    size = 3, sizeVary = 0, life = 2, lifeVary = 0,
                    rise = 40, drag = 2, wobble = 0, grow = 0.3, inherit = 0, spread = 0,
                }
            end
            local function cfg(power: number, maxRate: number): any
                return { threshold = 100, ref = 500, perSpeed = 10, power = power, maxRate = maxRate }
            end
            -- Two parts of the body, far enough apart that a puff's x says
            -- which one it came off.
            local function pair(slow: number, fast: number): { BUB.Source }
                return {
                    { x = 0, y = 0, vx = slow, vy = 0, r = 0 },
                    { x = 1000, y = 0, vx = fast, vy = 0, r = 0 },
                }
            end
            local function split(sys: BUB.System): (number, number)
                local a, b = 0, 0
                for i = 1, sys.n do
                    if sys.puffs[i].x < 500 then a += 1 else b += 1 end
                end
                return a, b
            end

            test.case('a still body sheds nothing at all', function(expect)
                local sys = BUB.new(500, 7)
                local srcs = pair(0, 0)
                for _ = 1, 120 do
                    expect(BUB.shed(sys, 1 / 60, srcs, cfg(1.6, 1000), spec())).is(0)
                end
                expect(sys.n).is(0)
            end)

            test.case('a part under the threshold sheds nothing while its neighbour does', function(expect)
                local sys = BUB.new(500, 7)
                -- 90 is under the threshold of 100; 600 is well over.
                local srcs = pair(90, 600)
                for _ = 1, 120 do
                    BUB.shed(sys, 1 / 60, srcs, cfg(1.6, 1000), spec())
                end
                local slow, fast = split(sys)
                expect(slow).is(0)
                expect(fast > 0).is(true)
            end)

            -- Averaged over seeds and over a long run, because which source a
            -- bubble comes off is a weighted COIN. A short run put the ratio
            -- 1.2 standard deviations out on an 18-bubble denominator, which is
            -- the kind of thing you fix with more samples and never by opening
            -- the bound until it passes.
            local function ratioAt(power: number): number
                local sum = 0
                for seed = 1, 4 do
                    local sys = BUB.new(60000, seed * 101)
                    local srcs = pair(300, 600)
                    for _ = 1, 6000 do
                        BUB.shed(sys, 1 / 60, srcs, cfg(power, 100000), spec())
                    end
                    local slow, fast = split(sys)
                    sum += fast / slow
                end
                return sum / 4
            end

            test.case('twice the speed sheds much more than twice the bubbles', function(expect)
                -- Over the threshold: 200 against 500, so 2.5x the speed. At
                -- power 1.6 that is 2.5^1.6 = 4.33x the bubbles, not 2.5x.
                local ratio = ratioAt(1.6)
                expect(ratio > 3.9).is(true)
                expect(ratio < 4.8).is(true)
            end)

            test.case('at power 1 it is exactly proportional', function(expect)
                -- The same pair with the curve taken out: 2.5x the speed over
                -- the threshold is 2.5x the bubbles, which is what `power`
                -- above 1 is measured against.
                local ratio = ratioAt(1)
                expect(ratio > 2.3).is(true)
                expect(ratio < 2.7).is(true)
            end)

            test.case('the ceiling scales the whole body down together', function(expect)
                -- Capped hard, the RATE falls but which parts shed most must
                -- not change: a ceiling that clipped each part separately would
                -- flatten the fast ones into the slow.
                local sys = BUB.new(4000, 3)
                local srcs = pair(300, 600)
                local free = BUB.shed(sys, 1 / 60, srcs, cfg(1.6, 100000), spec())
                expect(free > 12).is(true)
                local capped = BUB.shed(sys, 1 / 60, srcs, cfg(1.6, 12), spec())
                expect(math.abs(capped - 12) < 1e-9).is(true)

                local lo = BUB.new(4000, 3)
                for _ = 1, 900 do
                    BUB.shed(lo, 1 / 60, srcs, cfg(1.6, 12), spec())
                end
                local slow, fast = split(lo)
                local ratio = fast / slow
                expect(ratio > 3.6).is(true)
                expect(ratio < 5.8).is(true)
            end)

            test.case('breath keeps a rate that is under one a frame', function(expect)
                -- The carry is the whole point: at 3 a second a frame is worth
                -- 0.05 of a bubble, and without it every frame floors to none.
                local sys = BUB.new(500, 5)
                for _ = 1, 600 do
                    BUB.breathe(sys, 1 / 60, 10, 10, 0, 0, 3, spec())
                end
                -- 10 seconds at 3/s, and nothing has died yet at life 2? They
                -- have: only update kills, and it was never called.
                expect(sys.n).is(30)
            end)

            test.case('a burst is its own count, and the pool never overruns', function(expect)
                local sys = BUB.new(20, 9)
                BUB.burst(sys, 12, 0, 0, 5, 100, spec())
                expect(sys.n).is(12)
                BUB.burst(sys, 50, 0, 0, 5, 100, spec())
                expect(sys.n).is(20)
            end)

            test.case('a puff settles to a rise speed rather than climbing for ever', function(expect)
                local sys = BUB.new(10, 13)
                local sp = spec()
                BUB.burst(sys, 1, 0, 0, 0, 0, sp)
                local q = sys.puffs[1]
                -- Five time constants at drag 2, not one: the settle is
                -- exponential, and after a single second it is still 13% short.
                sp.life = 20
                q.life = 20
                for _ = 1, 600 do
                    BUB.update(sys, 1 / 60, sp, 0, 0)
                end
                -- Screen y is down, so rising is negative, and it settles at
                -- rise x its own radius rather than accelerating.
                expect(q.vy < 0).is(true)
                expect(math.abs(q.vy + sp.rise * q.r) < 1).is(true)
            end)

            test.case('a puff dies at its life and its slot comes back', function(expect)
                local sys = BUB.new(10, 13)
                local sp = spec()
                BUB.burst(sys, 4, 0, 0, 0, 0, sp)
                expect(sys.n).is(4)
                for _ = 1, 130 do
                    BUB.update(sys, 1 / 60, sp, 0, 0)
                end
                expect(sys.n).is(0)
                -- The pool is the same tables, reused, not regrown.
                expect(#sys.puffs).is(10)
            end)

            test.case('a seed replays a run exactly', function(expect)
                local function run(): number
                    local sys = BUB.new(500, 4242)
                    local srcs = pair(300, 600)
                    for _ = 1, 200 do
                        BUB.shed(sys, 1 / 60, srcs, cfg(1.6, 1000), spec())
                    end
                    local total = 0
                    for i = 1, sys.n do
                        total += sys.puffs[i].x + sys.puffs[i].r
                    end
                    return total
                end
                expect(math.abs(run() - run()) < 1e-9).is(true)
            end)
        end)

        test.group('plays', function()
            -- The claim the whole list rests on: every play it offers is a move
            -- the rules would actually take. Run over real deals, several moves
            -- deep, rather than a hand-built board — a hand-built board only
            -- ever proves the case you thought of.
            test.case('every play offered is a move the rules take', function(expect)
                for seed = 1, 12 do
                    local g = K.new(seed * 37)
                    for _ = 1, 20 do
                        local plays = K.plays(g)
                        for _, play in ipairs(plays) do
                            -- A copy per play: taking one would change the board
                            -- under the rest of the list.
                            local c = K.new(seed * 37)
                            c.stock.cards = {}
                            c.waste.cards = {}
                            for i, pile in ipairs(K.piles(g)) do
                                local dst = K.piles(c)[i]
                                dst.cards = {}
                                for _, card in ipairs(pile.cards) do
                                    table.insert(dst.cards, { id = card.id, suit = card.suit, rank = card.rank, faceUp = card.faceUp })
                                end
                            end
                            local from = K.piles(c)[table.find(K.piles(g), play.from) :: number]
                            local to = K.piles(c)[table.find(K.piles(g), play.to) :: number]
                            expect(K.move(c, from, play.index, to).ok).is(true)
                        end
                        if #plays == 0 then
                            K.draw(g)
                        else
                            K.move(g, plays[1].from, plays[1].index, plays[1].to)
                        end
                    end
                end
            end)

            test.case('a foundation is never a source', function(expect)
                local g = K.new(4)
                -- An ace up, and a navy two on a column that would take it back.
                g.foundations[1].cards = { { id = 1, suit = 1, rank = 1, faceUp = true } }
                g.tableau[1].cards = { { id = 2, suit = 3, rank = 2, faceUp = true } }
                for col = 2, 7 do
                    g.tableau[col].cards = {}
                end
                -- The rules DO take that pull; the list still does not offer it.
                expect(K.canStackOnTableau(g.foundations[1].cards[1], g.tableau[1])).is(true)
                for _, play in ipairs(K.plays(g)) do
                    expect(play.from.kind == 'foundation').is(false)
                end
            end)

            test.case('one empty column, not three', function(expect)
                local g = K.new(4)
                for col = 1, 7 do
                    g.tableau[col].cards = {}
                end
                g.tableau[1].cards = {
                    { id = 40, suit = 1, rank = 5, faceUp = true },
                    { id = 41, suit = 3, rank = 13, faceUp = true },
                }
                local n = 0
                for _, play in ipairs(K.plays(g)) do
                    if play.card.id == 41 then
                        n += 1
                    end
                end
                expect(n).is(1)
            end)

            test.case('a lone king is not shuffled between empty columns', function(expect)
                local g = K.new(4)
                for col = 1, 7 do
                    g.tableau[col].cards = {}
                end
                g.tableau[1].cards = { { id = 41, suit = 3, rank = 13, faceUp = true } }
                expect(#K.plays(g)).is(0)
                -- Bury a card under the SAME king and it is worth moving after
                -- all: the column it leaves has something to turn over. That is
                -- the exact edge the exclusion sits on.
                table.insert(g.tableau[1].cards, 1, { id = 42, suit = 1, rank = 4, faceUp = false })
                local ids = {}
                for _, play in ipairs(K.plays(g)) do
                    table.insert(ids, play.card.id)
                    expect(play.reveals).is(true)
                end
                expect(#ids).is(1)
                expect(ids[1]).is(41)
            end)

            test.case('the waste top plays, the cards under it do not', function(expect)
                local g = K.new(4)
                for col = 1, 7 do
                    g.tableau[col].cards = {}
                end
                g.tableau[1].cards = { { id = 50, suit = 1, rank = 7, faceUp = true } }
                g.waste.cards = {
                    { id = 51, suit = 3, rank = 6, faceUp = true },  -- buried: would fit
                    { id = 52, suit = 4, rank = 6, faceUp = true },  -- the top: fits too
                }
                local ids = {}
                for _, play in ipairs(K.plays(g)) do
                    table.insert(ids, play.card.id)
                end
                expect(#ids).is(1)
                expect(ids[1]).is(52)
            end)

            test.case('an ace goes up, once, whichever foundations are free', function(expect)
                local g = K.new(4)
                for col = 1, 7 do
                    g.tableau[col].cards = {}
                end
                g.tableau[1].cards = { { id = 60, suit = 2, rank = 1, faceUp = true } }
                local n = 0
                for _, play in ipairs(K.plays(g)) do
                    expect(play.toFoundation).is(true)
                    n += 1
                end
                expect(n).is(1)
            end)

            test.case('a play that uncovers a card says so', function(expect)
                local g = K.new(4)
                for col = 1, 7 do
                    g.tableau[col].cards = {}
                end
                g.tableau[1].cards = { { id = 70, suit = 1, rank = 7, faceUp = true } }
                g.tableau[2].cards = {
                    { id = 71, suit = 2, rank = 4, faceUp = false },
                    { id = 72, suit = 3, rank = 6, faceUp = true },
                }
                g.tableau[3].cards = { { id = 73, suit = 4, rank = 6, faceUp = true } }
                local reveals: { [number]: boolean } = {}
                for _, play in ipairs(K.plays(g)) do
                    reveals[play.card.id] = play.reveals
                end
                expect(reveals[72]).is(true)
                expect(reveals[73]).is(false)
            end)

            test.case('a won board has nothing left to point at', function(expect)
                local g = K.new(3)
                for s = 1, 4 do
                    g.foundations[s].cards = {}
                    for r = 1, 13 do
                        table.insert(g.foundations[s].cards, { id = (s - 1) * 13 + r, suit = s, rank = r, faceUp = true })
                    end
                end
                for col = 1, 7 do
                    g.tableau[col].cards = {}
                end
                g.stock.cards = {}
                g.waste.cards = {}
                expect(#K.plays(g)).is(0)
            end)
        end)

        test.group('stock', function()
            test.case('draw moves one card face up to the waste', function(expect)
                local g = K.new(8)
                expect(K.draw(g)).is('drew')
                expect(#g.waste.cards).is(1)
                expect(g.waste.cards[1].faceUp).is(true)
                expect(#g.stock.cards).is(23)
            end)
            test.case('an empty stock recycles the waste, face down, in order', function(expect)
                local g = K.new(8)
                for _ = 1, 24 do
                    K.draw(g)
                end
                local lastDrawn = g.waste.cards[24].id
                expect(K.draw(g)).is('recycled')
                expect(#g.stock.cards).is(24)
                expect(#g.waste.cards).is(0)
                expect(g.stock.cards[1].faceUp).is(false)
                -- The last card drawn is the bottom of the new stock.
                expect(g.stock.cards[1].id).is(lastDrawn)
            end)
            test.case('an empty stock and waste is empty', function(expect)
                local g = K.new(8)
                g.stock.cards = {}
                expect(K.draw(g)).is('empty')
            end)
        end)

        -- Ethan's rule: a creature swims FORWARD, nose first. The instance
        -- matrix's -z column is the body's nose (tools/sealitaire-fish.mjs
        -- puts every species' head there); it must point along the motion.
        -- And the card's edges are WALLS: nose and tail stay inside the
        -- frustum however hard the card is flung.
        local walls: BAIT.Walls = { dist = 3.2, tanHalf = math.tan(math.rad(22)), aspect = 120 / 168, zFront = 1.0, zBack = -1.4 }
        local function inputs(count: number, size: number): BAIT.Inputs
            return {
                hovered = false, pressed = false, played = false, dragging = false, velX = 0, velY = 0, count = count,
                size = size, back = { 0.2, 0.4, 0.6 }, belly = { 0.9, 0.95, 1 },
                spin = 1.2, radius = 0.7, exciteSpin = 1.5, scatterPush = 1.2, padX = 0.18, padY = 0.18, drop = 0, rotate = 0, rotateVary = 0,
                swirlHold = 0.9, swirlIn = 8, swirlOut = 2,
                slosh = 0.0012, spring = 12, damp = 4, bounce = 0.55, turn = 2, turnMax = math.rad(60),
                hitSpeed = 0.35, hitGap = 0.12,
                dentAmount = 0, dentFreq = 9, dentDamp = 0.35,
                bubbleCount = 4, bubbleSize = 0.09, bubbleRise = 0.55, bubbleLife = 1.1, bubbleSpread = 0.5,
                loosen = 12, still = 40, settle = 2.5, friction = 1.2, gravity = 2.5, tumble = 0.5, walls = walls,
                colGap = 1, rowGap = 1, holds = false,
                yaw = 0, roll = 0, sway = 1, revealed = false, enterSpeed = 0,
                clipRate = 0, clipWeight = 1, bio = { 0.4, 1, 0.9 }, bioStrength = 0,
                bioSpeed = 0.5, bioScale = 0.6, bioContrast = 1, bioCoverage = 0.45, bioPan = 0, bioEvolve = 0.3,
            }
        end
        test.group('bait ball', function()
            test.case('the walls are what the camera sees', function(expect)
                -- The sim's frustum (BAIT.Walls) must be the projection's: a
                -- point on the wall at z = 0 lands on the NDC edge.
                local proj = Mat4.perspective(math.rad(44), walls.aspect, 0.1, 20)
                local view = Mat4.lookAt(Vector.xyz(0, 0, walls.dist), Vector.xyz(0, 0, 0), Vector.xyz(0, 1, 0))
                local vp = proj * view
                local hx = walls.dist * walls.tanHalf * walls.aspect
                local hy = walls.dist * walls.tanHalf
                local x, _, _, w = vp:transformVec4(hx, 0, 0, 1)
                local _, y, _, w2 = vp:transformVec4(0, hy, 0, 1)
                expect(math.abs(x / w - 1)).lessThan(0.01)
                expect(math.abs(y / w2 - 1)).lessThan(0.01)
            end)
            test.case('a swirling sardine leans into its motion but never leaves its cone', function(expect)
                -- Bodies hold their facing: the nose leans toward the motion
                -- as far as the turn cone allows, and no further. At rest the
                -- school holds its number formation; a play starts the swirl.
                local inp = inputs(10, 0.7)
                inp.swirlHold = 10
                local b = BAIT.new(7)
                local dt = 1 / 60
                local S = BAIT.STRIDE
                local before = buffer.create(10 * S)
                local after = buffer.create(10 * S)
                inp.played = true
                BAIT.update(b, dt, inp)
                inp.played = false
                for _ = 1, 180 do
                    BAIT.update(b, dt, inp)
                end
                BAIT.write(b, inp, before, 0)
                BAIT.update(b, dt, inp)
                BAIT.write(b, inp, after, 0)
                local leaning = 0
                for i = 0, 9 do
                    local o = i * S
                    -- nose = -(third column), motion = translation delta
                    local nx, ny, nz = -buffer.readf32(before, o + 32), -buffer.readf32(before, o + 36), -buffer.readf32(before, o + 40)
                    local mx = buffer.readf32(after, o + 48) - buffer.readf32(before, o + 48)
                    local my = buffer.readf32(after, o + 52) - buffer.readf32(before, o + 52)
                    local mz = buffer.readf32(after, o + 56) - buffer.readf32(before, o + 56)
                    local nl = math.sqrt(nx * nx + ny * ny + nz * nz)
                    local ml = math.sqrt(mx * mx + my * my + mz * mz)
                    -- inside the cone: within 60 degrees (+ a little ease) of +-x
                    expect(math.abs(nx) / nl).greaterThan(math.cos(math.rad(62)))
                    local cosMotion = (nx * mx + ny * my + nz * mz) / math.max(1e-9, nl * ml)
                    local restCos = math.abs(mx) / math.max(1e-9, ml)
                    if cosMotion >= restCos - 0.05 then
                        leaning += 1
                    end
                end
                -- most fish lean into their motion; with the rotational drag a
                -- nose lags a reversing swirl, which is the point of the drag
                expect(leaning).greaterThan(4)
            end)
            test.case('a body turns slowly: a flipped velocity does not spin it round', function(expect)
                local inp = inputs(1, 1.2)
                local b = BAIT.new(2)
                local dt = 1 / 60
                for _ = 1, 120 do
                    BAIT.update(b, dt, inp)
                end
                local f = b.fish[1]
                local h0 = f.hx
                -- A hard shove straight backwards along its facing.
                f.vx = -h0 * 6
                local worstStep = 0
                local px, py, pz = f.hx, f.hy, f.hz
                for _ = 1, 60 do
                    BAIT.update(b, dt, inp)
                    local c = math.max(-1, math.min(1, px * f.hx + py * f.hy + pz * f.hz))
                    worstStep = math.max(worstStep, math.acos(c))
                    px, py, pz = f.hx, f.hy, f.hz
                    -- never past the cone from its rest facing (-x)
                    expect(-f.hx).greaterThan(math.cos(math.rad(61)))
                end
                -- and never more than `turn` radians in a frame
                expect(worstStep).lessThan(2 * dt + 1e-3)
            end)
            test.case('a school at rest sits in its number formation, broadside', function(expect)
                local inp = inputs(9, 0.7)
                local b = BAIT.new(5)
                for _ = 1, 240 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local S = BAIT.STRIDE
                local buf = buffer.create(9 * S)
                BAIT.write(b, inp, buf, 0)
                local left, right, mid = 0, 0, 0
                for i = 0, 8 do
                    local o = i * S
                    -- the nose: -(third column); broadside means it lies along x
                    local nx, ny, nz = -buffer.readf32(buf, o + 32), -buffer.readf32(buf, o + 36), -buffer.readf32(buf, o + 40)
                    local nl = math.sqrt(nx * nx + ny * ny + nz * nz)
                    expect(math.abs(nx) / nl).greaterThan(0.95)
                    local x = buffer.readf32(buf, o + 48)
                    if x < -0.2 then left += 1 elseif x > 0.2 then right += 1 else mid += 1 end
                end
                -- a nine: four a side and one in the middle
                expect(left).is(4)
                expect(right).is(4)
                expect(mid).is(1)
            end)
            test.case('a dragged card rattles its school loose, and an idle one seats it again', function(expect)
                local inp = inputs(5, 0.7)
                local b = BAIT.new(4)
                local dt = 1 / 60
                for _ = 1, 240 do
                    BAIT.update(b, dt, inp)
                end
                local function spread(): number
                    local d = 0
                    for i = 1, 5 do
                        d += math.abs(b.fish[i].y)
                    end
                    return d
                end
                local seated = spread()
                -- Drag: a jerky hand, then held. Loose, the bodies sink.
                inp.dragging = true
                for f = 1, 150 do
                    inp.velX = if f % 20 < 10 then 1500 else -1500
                    inp.velY = if f % 30 < 15 then 900 else -900
                    BAIT.update(b, dt, inp)
                end
                expect(b.loose).greaterThan(0.95)
                local sunk = 0
                for i = 1, 5 do
                    if b.fish[i].y < -0.3 then
                        sunk += 1
                    end
                end
                expect(sunk).greaterThan(2)
                expect(BAIT.inside(b, inp, 0.001)).is(true)
                -- Played: idle again, they settle back into the number.
                inp.dragging = false
                inp.velX, inp.velY = 0, 0
                for _ = 1, 300 do
                    BAIT.update(b, dt, inp)
                end
                expect(b.loose).lessThan(0.05)
                expect(math.abs(spread() - seated)).lessThan(0.15)
            end)
            test.case('only a play swirls the ball; hover, click and drag never do', function(expect)
                local inp = inputs(6, 0.7)
                local b = BAIT.new(9)
                local dt = 1 / 60
                inp.hovered = true
                for f = 1, 120 do
                    inp.pressed = f == 10
                    inp.dragging = f > 20
                    inp.velX = if f > 20 then 800 else 0
                    BAIT.update(b, dt, inp)
                end
                expect(b.excite).lessThan(0.01)
                inp.hovered, inp.pressed, inp.dragging, inp.velX = false, false, false, 0
                -- The play: a ball for a beat, then the number again.
                inp.played = true
                BAIT.update(b, dt, inp)
                inp.played = false
                for _ = 1, 40 do
                    BAIT.update(b, dt, inp)
                end
                expect(b.excite).greaterThan(0.9)
                for _ = 1, 240 do
                    BAIT.update(b, dt, inp)
                end
                expect(b.excite).lessThan(0.05)
            end)
            test.case('a held card that stops moving reseats its bodies until it moves again', function(expect)
                local inp = inputs(5, 0.7)
                local b = BAIT.new(6)
                local dt = 1 / 60
                for _ = 1, 240 do
                    BAIT.update(b, dt, inp)
                end
                local function spread(): number
                    local d = 0
                    for i = 1, 5 do
                        d += math.abs(b.fish[i].y)
                    end
                    return d
                end
                local seated = spread()
                -- Dragged and moving: loose.
                inp.dragging = true
                for f = 1, 120 do
                    inp.velX = if f % 20 < 10 then 1500 else -1500
                    BAIT.update(b, dt, inp)
                end
                expect(b.loose).greaterThan(0.95)
                -- Still held, but the hand has stopped: back to the number.
                inp.velX = 0
                for _ = 1, 300 do
                    BAIT.update(b, dt, inp)
                end
                expect(b.loose).lessThan(0.05)
                expect(math.abs(spread() - seated)).lessThan(0.15)
                -- Moved again: loose again.
                for f = 1, 60 do
                    inp.velX = if f % 20 < 10 then 1500 else -1500
                    BAIT.update(b, dt, inp)
                end
                expect(b.loose).greaterThan(0.9)
            end)
            test.case('a flung card keeps its school inside the frustum', function(expect)
                local inp = inputs(10, 0.7)
                local b = BAIT.new(3)
                local dt = 1 / 60
                for _ = 1, 30 do
                    BAIT.update(b, dt, inp)
                end
                expect(BAIT.inside(b, inp, 0.001)).is(true)
                -- A violent drag: the card's velocity jumps 4000 px/s, holds,
                -- then reverses, with a press in the middle.
                local worst = 0
                for f = 1, 240 do
                    inp.velX = if f < 60 then 4000 elseif f < 120 then -4000 else 0
                    inp.velY = if f > 30 and f < 90 then 3000 else 0
                    inp.pressed = f == 45
                    inp.dragging = f < 120
                    BAIT.update(b, dt, inp)
                    inp.pressed = false
                    if not BAIT.inside(b, inp, 0.001) then
                        worst += 1
                    end
                end
                expect(worst).is(0)
            end)
            test.case('an apex predator longer than the tank is wide stays inside', function(expect)
                -- 1.7 x 0.7 = 1.19 long in a tank 1.85 wide at z = 0.
                local inp = inputs(1, 1.7 * 0.7)
                local b = BAIT.new(11)
                local dt = 1 / 60
                local worst = 0
                for f = 1, 400 do
                    inp.velX = if f > 100 and f < 140 then 5000 elseif f > 200 and f < 240 then -5000 else 0
                    inp.pressed = f == 300
                    BAIT.update(b, dt, inp)
                    inp.pressed = false
                    if not BAIT.inside(b, inp, 0.001) then
                        worst += 1
                    end
                end
                expect(worst).is(0)
            end)
            -- THE DENT: a contact squashes the body, and the squash is flesh
            -- rather than pose. fish.wgsl warps the vertex after the skin
            -- matrix, so nothing here can reach a bone; what these cases
            -- hold is the half that is testable on the CPU — that the
            -- squash happens, that it is latched in the body's own frame,
            -- that it dies, and that it moves nothing else.
            local function flung(seed: number, amount: number, hitSpeed: number): (BAIT.Ball, BAIT.Inputs, BAIT.Fish)
                -- Warmed up with no dent, then put beside the right-hand
                -- glass and driven into it, so the contact is the first one
                -- and happens on a known frame rather than eventually.
                local inp = inputs(1, 0.7)
                inp.dentAmount = 0
                inp.hitSpeed = hitSpeed
                local b = BAIT.new(seed)
                for _ = 1, 120 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local f = b.fish[1]
                inp.dentAmount = amount
                f.x, f.vx, f.vy, f.vz = 0.4, 7, 0, 0
                return b, inp, f
            end
            test.case('the glass dents a body, and the dent rings back to nothing', function(expect)
                local b, inp, f = flung(3, 0.35, 0.35)
                expect(f.dent).is(0)
                local peak = 0
                for _ = 1, 12 do
                    BAIT.update(b, 1 / 60, inp)
                    peak = math.max(peak, f.dent)
                end
                expect(peak).greaterThan(0.05)
                -- A direction, not a magnitude: the shader scales along it.
                local dl = math.sqrt(f.dnx * f.dnx + f.dny * f.dny + f.dnz * f.dnz)
                expect(math.abs(dl - 1)).lessThan(1e-4)
                -- Somewhere on the body, in body lengths from its middle.
                expect(math.abs(f.dz0)).lessThan(0.501)
                -- And it ends at EXACTLY zero, which is the shader's early
                -- out: a dent that only got small would cost every resting
                -- body the whole warp for ever.
                inp.dentAmount = 0
                for _ = 1, 600 do
                    BAIT.update(b, 1 / 60, inp)
                end
                expect(f.dent).is(0)
                expect(f.dage).is(0)
            end)
            test.case("the dent is latched in the body's own frame", function(expect)
                -- The frame the squash is in and the frame the mesh is in
                -- are two pieces of arithmetic (toBodyLocal and write's
                -- Mat4), and if they ever disagree the dent lands on the
                -- wrong side of the animal and nothing errors. So: take the
                -- direction back out through the model matrix's own axis
                -- columns and it must be the wall's inward normal again.
                -- On the LATCH FRAME, and only then: the dent then rides
                -- the body, so a frame later this direction has honestly
                -- turned with it and is no longer the wall's.
                local b, inp, f = flung(5, 0.5, 0.35)
                for _ = 1, 12 do
                    BAIT.update(b, 1 / 60, inp)
                    if f.dent ~= 0 then
                        break
                    end
                end
                expect(f.dent).greaterThan(0)
                local S = BAIT.STRIDE
                local buf = buffer.create(S)
                BAIT.write(b, inp, buf, 0)
                local d = { f.dnx, f.dny, f.dnz }
                local wx, wy, wz = 0, 0, 0
                for j = 0, 2 do
                    wx += buffer.readf32(buf, j * 16) * d[j + 1]
                    wy += buffer.readf32(buf, j * 16 + 4) * d[j + 1]
                    wz += buffer.readf32(buf, j * 16 + 8) * d[j + 1]
                end
                local l = math.sqrt(wx * wx + wy * wy + wz * wz)
                -- The right-hand glass pushes -x, and nothing else.
                expect(wx / l).lessThan(-0.999)
            end)
            test.case('a contact hands the skeleton its shove', function(expect)
                -- The last link of the chain contact -> dent -> BONES: the
                -- rig is shoved by `dkick`, which is the RAW closing speed
                -- and must survive the dent being turned off entirely, or
                -- turning the squash down would quietly straighten every
                -- shark in the game (tankrig.luau reads it).
                local b, inp, f = flung(13, 0, 0.35)
                inp.dentAmount = 0
                local kicked = 0
                for _ = 1, 12 do
                    BAIT.update(b, 1 / 60, inp)
                    if f.dkick > 0 then
                        kicked += 1
                    end
                end
                expect(kicked).greaterThan(0)
                expect(f.dent).is(0)
                -- ...and it is cleared on a frame with no contact, or the
                -- chains would be shoved for ever by one touch of the glass.
                for _ = 1, 240 do
                    BAIT.update(b, 1 / 60, inp)
                end
                expect(f.dkick).is(0)
            end)
            test.case('nothing deforms until the card is touched', function(expect)
                -- WHAT MAKES A CONTACT AT ALL, measured, because the answer
                -- is narrower than it looks and it is the first thing to
                -- check when the tanks seem dead. `fishPadX`/`padY` hold the
                -- resting seats well inside the walls and the swirl's ring
                -- is fitted inside them too, so a card sitting on the table
                -- — and a card being PLAYED — never puts a body on the
                -- glass. A press and a drag are the only two things that do.
                local function contacts(n: number, drive: (number, BAIT.Inputs) -> ()): number
                    local inp = inputs(n, 0.7)
                    local b = BAIT.new(7)
                    for _ = 1, 180 do
                        BAIT.update(b, 1 / 60, inp)
                    end
                    local hits = 0
                    for fr = 1, 600 do
                        drive(fr, inp)
                        BAIT.update(b, 1 / 60, inp)
                        for i = 1, n do
                            if b.fish[i].dkick > 0 then
                                hits += 1
                            end
                        end
                    end
                    return hits
                end
                expect(contacts(5, function() end)).is(0)
                expect(contacts(5, function(fr, i) i.played = fr == 1 end)).is(0)
                expect(contacts(5, function(fr, i) i.pressed = fr % 120 == 1 end)).greaterThan(0)
            end)
            test.case('a scrape is one shove, not sixty a second', function(expect)
                -- A body held against the glass trips the wall on EVERY
                -- frame. The dent wants that — it is a spring on a scalar
                -- and a body leaning on the glass should stay squashed —
                -- but the skeleton is shoved with an IMPULSE, and sixty of
                -- those a second pump energy into the chain faster than the
                -- damping takes it out until it shakes itself apart. So the
                -- rig is shoved on the EDGE of a contact only.
                local inp = inputs(1, 0.7)
                inp.dentAmount = 0.12
                local b = BAIT.new(4)
                for _ = 1, 120 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local f = b.fish[1]
                local kicks, touching = 0, 0
                for _ = 1, 240 do
                    f.vx = math.max(f.vx, 3)
                    BAIT.update(b, 1 / 60, inp)
                    if f.dkick > 0 then
                        kicks += 1
                    end
                    if f.touch > 0 then
                        touching += 1
                    end
                end
                expect(touching).greaterThan(100)
                expect(kicks).lessThan(5)
                -- ...and the dent, which does want every frame, is still on.
                expect(f.dent ~= 0).is(true)
            end)
            test.case('a touch too quiet to knock still dents the body', function(expect)
                -- Two gates on one contact: the knock is throttled so a body
                -- scraping the glass does not machine-gun, the dent is not.
                local b, inp, f = flung(8, 0.5, 99)
                for _ = 1, 6 do
                    BAIT.update(b, 1 / 60, inp)
                end
                expect(#b.hits).is(0)
                expect(f.dent).greaterThan(0)
            end)
            test.case('a dent moves no bone and no body', function(expect)
                -- The dent is additive or it is not a dent: the same sim run
                -- with it on and off must put every body in the same place,
                -- on the same frame of its clip, at the same pose weight.
                local S = BAIT.STRIDE
                local function run(amount: number): buffer
                    local inp = inputs(6, 0.6)
                    inp.dentAmount = 0
                    inp.clipRate = 2
                    local b = BAIT.new(11)
                    for _ = 1, 120 do
                        BAIT.update(b, 1 / 60, inp)
                    end
                    inp.dentAmount = amount
                    for i = 1, 6 do
                        b.fish[i].x, b.fish[i].vx = 0.4, 7
                    end
                    for _ = 1, 10 do
                        BAIT.update(b, 1 / 60, inp)
                    end
                    local buf = buffer.create(6 * S)
                    BAIT.write(b, inp, buf, 0)
                    return buf
                end
                local off, on = run(0), run(0.6)
                for i = 0, 5 do
                    local o = i * S
                    for k = 0, 60, 4 do
                        expect(buffer.readf32(on, o + k)).is(buffer.readf32(off, o + k))
                    end
                    expect(buffer.readf32(on, o + 112)).is(buffer.readf32(off, o + 112))
                    expect(buffer.readf32(on, o + 116)).is(buffer.readf32(off, o + 116))
                end
                -- ...and one of them really did dent, or the above is a
                -- comparison of two runs that both did nothing.
                local dented = 0
                for i = 0, 5 do
                    if math.abs(buffer.readf32(on, i * S + 156)) > 1e-4 then
                        dented += 1
                    end
                end
                expect(dented).greaterThan(0)
                expect(buffer.readf32(off, 156)).is(0)
            end)
        end)

        -- THE BONE SPRING (bonespring.luau): a big animal answers a contact
        -- with its own skeleton. A straight five-bone chain down +z, the
        -- shape of a shark's tail, is enough to hold every rule.
        test.group('bone spring', function()
            local function chain(n: number): BSPRING.Chain
                local bones = {}
                for k = 1, n do
                    bones[k] = {
                        slot = k, hx = 0, hy = 0, hz = -0.2 + (k - 1) * 0.1,
                        rx = 0, ry = 0, rz = 1, len = 0.1,
                    }
                end
                return { role = 0, bones = bones }
            end
            local CFG: BSPRING.Cfg = { stiff = 60, damp = 7, tipLoose = 4, maxLag = math.rad(28), maxBend = math.rad(45), soft = 0.5 }
            test.case('a chain nothing has touched costs nothing', function(expect)
                local c = chain(5)
                local st = BSPRING.rest(c)
                local out: { [number]: { number } } = {}
                expect(BSPRING.solve(c, st, 1 / 60, CFG, out)).is(false)
                expect(next(out) == nil).is(true)
            end)
            test.case('a shove bends the chain, and it comes back', function(expect)
                local c = chain(5)
                local st = BSPRING.rest(c)
                BSPRING.impulse(c, st, 0, 1, 0, 3, 0.2, 0.45)
                local out: { [number]: { number } } = {}
                local worst = 0
                for _ = 1, 20 do
                    BSPRING.solve(c, st, 1 / 60, CFG, out)
                    for k = 1, 5 do
                        worst = math.max(worst, math.abs(st.dy[k]))
                    end
                end
                expect(worst).greaterThan(0.05)
                -- ...and settles: every bone back on its rest direction, and
                -- the chain reports itself asleep so the caller stops
                -- uploading it.
                for _ = 1, 4000 do
                    BSPRING.solve(c, st, 1 / 60, CFG, out)
                    if not st.live then
                        break
                    end
                end
                expect(st.live).is(false)
                for k = 1, 5 do
                    expect(math.abs(st.dy[k])).lessThan(0.02)
                    expect(st.dz[k]).greaterThan(0.99)
                end
            end)
            test.case('the tip trails further than the root: the wave', function(expect)
                -- The whole reason to use a skeleton rather than a warp of
                -- the vertices. If the tip ever stops lagging more than the
                -- root, `tipLoose` has stopped doing anything and what is
                -- left is an expensive way to draw a rigid bend.
                local c = chain(5)
                local st = BSPRING.rest(c)
                BSPRING.impulse(c, st, 0, 1, 0, 3, 0.2, 5)
                local out: { [number]: { number } } = {}
                local rootMax, tipMax = 0, 0
                for _ = 1, 40 do
                    BSPRING.solve(c, st, 1 / 60, CFG, out)
                    rootMax = math.max(rootMax, math.abs(st.dy[1]))
                    tipMax = math.max(tipMax, math.abs(st.dy[5]))
                end
                expect(tipMax).greaterThan(rootMax)
            end)
            test.case('a chain held under a steady shove does not fold or buzz', function(expect)
                -- THE TWO WAYS THIS SHOOK ITSELF APART, and both only show
                -- under a SUSTAINED contact, which is what a seat spring
                -- holding a body in a corner is.
                --
                -- maxLag is measured against the PARENT's carried rest, so
                -- relative caps compound: six bones at 28 degrees is 168,
                -- and every joint saturates and the tail folds through the
                -- animal. maxBend caps the angle from the bone's own rest
                -- and is what stops it. And an impulse is a change of
                -- velocity, so one handed over every frame pumps energy in
                -- faster than the damping takes it out — the bone ends up
                -- buzzing against its cap with a velocity that climbs
                -- without bound. The rate ceiling is the backstop for any
                -- caller that does that; baitball only shoves on the edge.
                local c = chain(6)
                local st = BSPRING.rest(c)
                local out: { [number]: { number } } = {}
                local worstAng, worstVel = 0, 0
                for _ = 1, 400 do
                    BSPRING.impulse(c, st, 0, 1, 0, 40, 0, 5)
                    BSPRING.solve(c, st, 1 / 60, CFG, out)
                    for k = 1, 6 do
                        -- Every bone's rest is +z here, so its own cone is
                        -- read straight off dz.
                        worstAng = math.max(worstAng, math.acos(math.max(-1, math.min(1, st.dz[k]))))
                        worstVel = math.max(worstVel, math.sqrt(st.vx[k] ^ 2 + st.vy[k] ^ 2 + st.vz[k] ^ 2))
                    end
                end
                expect(worstAng).lessThan(CFG.maxBend + 0.02)
                expect(worstVel).lessThan(math.sqrt(CFG.stiff) * 2.5 + 1)
            end)
            test.case('the skeleton does not come apart', function(expect)
                -- THE ONE THAT MATTERS. Each bone's bend must carry the NEXT
                -- bone's head to exactly where its own tip has gone, or the
                -- chain is a row of pieces that each look fine alone and
                -- separate at every joint. Nothing in a render says so — the
                -- skin stretches between them and reads as bad weighting.
                local c = chain(5)
                local st = BSPRING.rest(c)
                BSPRING.impulse(c, st, 0, 1, 0, 6, 0, 5)
                local out: { [number]: { number } } = {}
                local worst = 0
                for _ = 1, 60 do
                    BSPRING.solve(c, st, 1 / 60, CFG, out)
                    for k = 1, 4 do
                        local a = out[c.bones[k].slot]
                        local b = out[c.bones[k + 1].slot]
                        local h = c.bones[k + 1]
                        local function apply(m: { number }): (number, number, number)
                            return m[1] * h.hx + m[2] * h.hy + m[3] * h.hz + m[4],
                                m[5] * h.hx + m[6] * h.hy + m[7] * h.hz + m[8],
                                m[9] * h.hx + m[10] * h.hy + m[11] * h.hz + m[12]
                        end
                        local ax, ay, az = apply(a)
                        local bx, by, bz = apply(b)
                        worst = math.max(worst, math.abs(ax - bx), math.abs(ay - by), math.abs(az - bz))
                    end
                end
                expect(worst).lessThan(1e-5)
            end)
        end)

        test.group('three axes', function()
            -- The instance matrix's columns are the body's axes: column 3 is
            -- its length (nose at -z), column 2 its up. A school at rest,
            -- long settled, so the heading is the rest heading.
            local S = BAIT.STRIDE
            local function settled(inp: BAIT.Inputs, n: number): buffer
                local b = BAIT.new(3)
                for _ = 1, 300 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local buf = buffer.create(n * S)
                BAIT.write(b, inp, buf, 0)
                return buf
            end
            local function col(buf: buffer, i: number, c: number): (number, number, number)
                local o = i * S + c * 16
                return buffer.readf32(buf, o), buffer.readf32(buf, o + 4), buffer.readf32(buf, o + 8)
            end
            test.case('yaw turns the nose toward the viewer, the whole school together', function(expect)
                local inp = inputs(6, 0.4)
                inp.yaw = 0.6
                local buf = settled(inp, 6)
                for i = 0, 5 do
                    local zx, zy, zz = col(buf, i, 2)
                    -- The nose is -column 2: toward the camera (+z) for every body,
                    -- whichever way its row faces.
                    expect(-zz / math.sqrt(zx * zx + zy * zy + zz * zz)).greaterThan(0.45)
                end
                inp.yaw = -0.6
                buf = settled(inp, 6)
                for i = 0, 5 do
                    local zx, zy, zz = col(buf, i, 2)
                    expect(-zz / math.sqrt(zx * zx + zy * zy + zz * zz)).lessThan(-0.45)
                end
            end)
            test.case('roll rolls about the body, leaving the nose where it was', function(expect)
                local inp = inputs(4, 0.4)
                inp.sway = 0
                local a = settled(inp, 4)
                inp.roll = 1.2
                local b = settled(inp, 4)
                local function cosBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number
                    return (ax * bx + ay * by + az * bz) / math.max(1e-9, math.sqrt(ax * ax + ay * ay + az * az) * math.sqrt(bx * bx + by * by + bz * bz))
                end
                for i = 0, 3 do
                    local ax, ay, az = col(a, i, 2)
                    local bx, by, bz = col(b, i, 2)
                    -- Same length axis...
                    expect(cosBetween(ax, ay, az, bx, by, bz)).greaterThan(0.98)
                    -- ...different up: cos(1.2) of the old one.
                    local ux, uy, uz = col(a, i, 1)
                    local vx, vy, vz = col(b, i, 1)
                    expect(math.abs(cosBetween(ux, uy, uz, vx, vy, vz))).lessThan(0.5)
                end
            end)
            test.case('the number is a grid, whichever fish is the long one', function(expect)
                -- A school's bodies are scattered +-15% in length, and the
                -- formation used to be measured from EACH body's own: a short
                -- fish sat further out than the long one beside it, so no
                -- column was straight and no row was level. The drop made it
                -- worse — its room was per body too, so each fish fell its own
                -- distance and the rows sheared apart. Six fish came to rest
                -- with the top row 0.155 apart, a tenth of the card's height.
                --
                -- Two assertions, because either alone passes something wrong.
                -- The grid must MIRROR (a formation is symmetric about the
                -- card's centre line)...
                local function restOf(n: number, size: number, drop: number, gap: number, seed: number): ({ number }, { number })
                    local inp = inputs(n, size)
                    inp.sway = 0
                    inp.drop = drop
                    inp.rowGap = gap
                    local b = BAIT.new(seed)
                    for _ = 1, 900 do
                        BAIT.update(b, 1 / 60, inp)
                    end
                    local xs, ys = {}, {}
                    for i = 1, n do
                        table.insert(xs, b.fish[i].x)
                        table.insert(ys, b.fish[i].y)
                    end
                    return xs, ys
                end
                for _, c in ipairs({ { 6, 0.4, 0.8 }, { 7, 0.4, 0 }, { 9, 0.5, 0.3 }, { 10, 0.45, 0 } }) do
                    local n, size, drop = c[1], c[2], c[3]
                    local xs, ys = restOf(n, size, drop, 1, 4)
                    for i = 1, n do
                        -- every body has a partner across the centre line, on
                        -- its own row: the pair (x, y) and (-x, y)
                        local found = false
                        for j = 1, n do
                            if math.abs(xs[i] + xs[j]) < 0.004 and math.abs(ys[i] - ys[j]) < 0.004 then
                                found = true
                                break
                            end
                        end
                        expect(found).is(true)
                    end
                    -- ...and it must not depend on the length scatter at all.
                    -- A different seed deals different lengths; the number it
                    -- makes is the same number, to the pixel.
                    local xs2, ys2 = restOf(n, size, drop, 1, 17)
                    for i = 1, n do
                        expect(math.abs(xs[i] - xs2[i])).lessThan(0.004)
                        expect(math.abs(ys[i] - ys2[i])).lessThan(0.004)
                    end
                end
            end)
            test.case('the seven puts its double gap at the bottom, where a seven has it', function(expect)
                -- A seven is the one count with an odd pip off the centre, so
                -- one of its gaps is twice the others — that IS the shape of a
                -- seven, and it belongs between the middle and bottom rows.
                -- Row -1 is the card's BOTTOM (world +y is up), and the odd
                -- pip was at -0.5, which put the double gap at the TOP: the
                -- seven was printed upside down.
                local inp = inputs(7, 0.40355)
                inp.sway = 0
                local b = BAIT.new(4)
                for _ = 1, 900 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local ys = {}
                for i = 1, 7 do
                    table.insert(ys, b.fish[i].y)
                end
                table.sort(ys)
                -- four rows, bottom to top: two, two, the odd one, two
                local rows = {}
                for _, y in ipairs(ys) do
                    if #rows == 0 or math.abs(y - rows[#rows]) > 0.01 then
                        table.insert(rows, y)
                    end
                end
                expect(#rows).is(4)
                -- the gap off the bottom is the double one, and the three
                -- above it are even
                local low = rows[2] - rows[1]
                expect(math.abs((rows[3] - rows[2]) - (rows[4] - rows[3]))).lessThan(0.01)
                expect(low).greaterThan((rows[3] - rows[2]) * 1.8)
                -- and the odd pip is the one alone on its row, above centre
                expect(rows[3]).greaterThan(0)
            end)
            test.case('drop moves the whole number, bottom row included', function(expect)
                -- Row spacing must survive a drop: the formation shifts as one,
                -- and past the room it has it stops as one. A per-seat clamp
                -- parked the bottom row and squashed the rest onto it.
                local function rowsOf(drop: number): { number }
                    local inp = inputs(9, 0.4)
                    inp.sway = 0
                    inp.drop = drop
                    local b = BAIT.new(4)
                    for _ = 1, 400 do
                        BAIT.update(b, 1 / 60, inp)
                    end
                    local ys = {}
                    for i = 1, 9 do
                        table.insert(ys, b.fish[i].y)
                    end
                    table.sort(ys)
                    return ys
                end
                local flat, dropped, far = rowsOf(0), rowsOf(0.2), rowsOf(5)
                -- every body moved by the same amount
                for i = 1, 9 do
                    expect(math.abs((flat[i] - dropped[i]) - 0.2)).lessThan(0.02)
                end
                -- and the spread from top to bottom is kept even at the wall
                expect(math.abs((far[9] - far[1]) - (flat[9] - flat[1]))).lessThan(0.02)
                expect(far[1]).lessThan(flat[1])
            end)
            test.case('sway 0 holds a resting body dead still', function(expect)
                local inp = inputs(1, 1.0)
                inp.sway = 0
                inp.holds = true
                local b = BAIT.new(5)
                for _ = 1, 300 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local before = buffer.create(S)
                BAIT.write(b, inp, before, 0)
                for _ = 1, 60 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local after = buffer.create(S)
                BAIT.write(b, inp, after, 0)
                for k = 0, 60, 4 do
                    expect(math.abs(buffer.readf32(after, k) - buffer.readf32(before, k))).lessThan(1e-4)
                end
                -- and with sway on, the same body rocks
                inp.sway = 1
                for _ = 1, 30 do
                    BAIT.update(b, 1 / 60, inp)
                end
                BAIT.write(b, inp, after, 0)
                local moved = 0
                for k = 0, 60, 4 do
                    if math.abs(buffer.readf32(after, k) - buffer.readf32(before, k)) > 1e-4 then
                        moved += 1
                    end
                end
                expect(moved).greaterThan(0)
            end)
            test.case('a court creature swims in from off the card and ends inside', function(expect)
                local inp = inputs(1, 1.0)
                inp.holds = true
                inp.enterSpeed = 3
                local b = BAIT.new(8)
                BAIT.update(b, 1 / 60, inp)
                inp.revealed = true
                BAIT.update(b, 1 / 60, inp)
                inp.revealed = false
                -- Off the right edge on the frame of the reveal...
                expect(BAIT.inside(b, inp, 0.001)).is(false)
                expect(b.fish[1].x).greaterThan(0.5)
                -- ...and inside, at its seat, three seconds on.
                for _ = 1, 180 do
                    BAIT.update(b, 1 / 60, inp)
                end
                expect(BAIT.inside(b, inp, 0.001)).is(true)
                expect(math.abs(b.fish[1].x)).lessThan(0.1)
                expect(b.fish[1].enter).is(0)
            end)
            test.case('a big yawed body settles instead of bouncing on the front wall', function(expect)
                -- A lone creature two tank-units long, yawed hard toward the
                -- viewer: its nose used to reach past the front wall, the
                -- seat spring pulled it back and the wall reflected it, every
                -- frame, for ever. Now the seat offsets to where it fits and
                -- the body comes to rest.
                for _, yaw in ipairs({ 0.9, -0.9, 1.5 }) do
                    local inp = inputs(1, 2.0)
                    inp.holds = true
                    inp.sway = 0
                    inp.yaw = yaw
                    local b = BAIT.new(6)
                    for _ = 1, 400 do
                        BAIT.update(b, 1 / 60, inp)
                    end
                    local f = b.fish[1]
                    local energy = 0
                    for _ = 1, 120 do
                        BAIT.update(b, 1 / 60, inp)
                        energy = math.max(energy, math.abs(f.vx) + math.abs(f.vy) + math.abs(f.vz))
                    end
                    expect(energy).lessThan(0.05)
                    expect(BAIT.inside(b, inp, 0.02)).is(true)
                    expect(#b.hits).is(0)
                end
            end)
            test.case('a big yawed body thrown by a drag reseats and rests, at every size', function(expect)
                -- The seat used to be fitted for the REST heading only; a body
                -- coming back from a drag with its nose turned reached a wall
                -- the seat did not allow for, and the spring and the wall
                -- fought over it for ever.
                for _, size in ipairs({ 1.6, 2.4, 3.2 }) do
                    for _, yaw in ipairs({ 0.9, -1.2, 1.5 }) do
                        local inp = inputs(1, size)
                        inp.holds = true
                        inp.sway = 0
                        inp.yaw = yaw
                        inp.spring = 35
                        local b0 = BAIT.new(12)
                        for _ = 1, 120 do
                            BAIT.update(b0, 1 / 60, inp)
                        end
                        -- the same body LOOPING (an ace): it circles slowly, and a
                        -- shove must not turn that into a bounce either
                        local inpL = inputs(1, size)
                        inpL.holds = false
                        inpL.sway = 0
                        inpL.yaw = yaw
                        inpL.spring = 35
                        local bl = BAIT.new(13)
                        inpL.dragging = true
                        for k = 1, 60 do
                            inpL.velX = 900 * math.sin(k * 0.3)
                            inpL.velY = 700 * math.cos(k * 0.21)
                            BAIT.update(bl, 1 / 60, inpL)
                        end
                        inpL.dragging = false
                        inpL.velX, inpL.velY = 0, 0
                        for _ = 1, 360 do
                            BAIT.update(bl, 1 / 60, inpL)
                        end
                        local knocksL, eL = 0, 0
                        local fl = bl.fish[1]
                        for _ = 1, 180 do
                            BAIT.update(bl, 1 / 60, inpL)
                            knocksL += #bl.hits
                            eL = math.max(eL, math.abs(fl.vx) + math.abs(fl.vy) + math.abs(fl.vz))
                        end
                        -- It loops, so it moves; a brush of the glass now and then is
                        -- the oval reaching it, not a fight. A fight is dozens.
                        expect(knocksL).lessThan(3)
                        expect(eL).lessThan(2)
                        inp.spring = 35
                        local b = BAIT.new(12)
                        for _ = 1, 120 do
                            BAIT.update(b, 1 / 60, inp)
                        end
                        -- a hard drag: loose, kicked about, then let go
                        inp.dragging = true
                        for k = 1, 60 do
                            inp.velX = 900 * math.sin(k * 0.3)
                            inp.velY = 700 * math.cos(k * 0.21)
                            BAIT.update(b, 1 / 60, inp)
                        end
                        inp.dragging = false
                        inp.velX, inp.velY = 0, 0
                        for _ = 1, 300 do
                            BAIT.update(b, 1 / 60, inp)
                        end
                        local f = b.fish[1]
                        local energy, knocks = 0, 0
                        for _ = 1, 120 do
                            BAIT.update(b, 1 / 60, inp)
                            energy = math.max(energy, math.abs(f.vx) + math.abs(f.vy) + math.abs(f.vz))
                            knocks += #b.hits
                        end
                        expect(energy).lessThan(0.05)
                        expect(knocks).is(0)
                    end
                end
            end)
            test.case('a body longer than the tank is deep is parked, not bounced', function(expect)
                -- Ten tank-units long, facing straight at the camera: no z
                -- can fit both ends. It must sit still at the midpoint.
                local inp = inputs(1, 10)
                inp.holds = true
                inp.sway = 0
                inp.yaw = 1.5
                local b = BAIT.new(11)
                for _ = 1, 300 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local f = b.fish[1]
                local moved = 0
                local z0 = f.z
                for _ = 1, 60 do
                    BAIT.update(b, 1 / 60, inp)
                    moved = math.max(moved, math.abs(f.z - z0))
                end
                expect(moved).lessThan(1e-3)
                expect(math.abs(f.z - (inp.walls.zFront + inp.walls.zBack) * 0.5)).lessThan(0.05 + f.len * 0.15)
            end)
            test.case('a clip phase advances per body at its own pace and wraps', function(expect)
                local inp = inputs(5, 0.4)
                inp.clipRate = 0.5
                local b = BAIT.new(9)
                for _ = 1, 60 do
                    BAIT.update(b, 1 / 60, inp)
                end
                local buf = buffer.create(5 * S)
                BAIT.write(b, inp, buf, 0)
                local phases = {}
                for i = 0, 4 do
                    local ph = buffer.readf32(buf, i * S + 112)
                    expect(ph).greaterThan(-0.0001)
                    expect(ph).lessThan(1.0001)
                    expect(buffer.readf32(buf, i * S + 116)).is(1)
                    table.insert(phases, ph)
                end
                -- not all in step
                local spread = 0
                for i = 2, 5 do
                    spread = math.max(spread, math.abs(phases[i] - phases[1]))
                end
                expect(spread).greaterThan(0.01)
                -- no clip: the pose weight is 0 whatever clipWeight says
                inp.clipRate = 0
                BAIT.write(b, inp, buf, 0)
                expect(buffer.readf32(buf, 116)).is(0)
            end)
        end)
        test.group('tank knocks', function()
            local walls: BAIT.Walls = { dist = 3.2, tanHalf = math.tan(math.rad(22)), aspect = 120 / 168, zFront = 1.0, zBack = -1.4 }
            local function inp(over: { [string]: any }): BAIT.Inputs
                local t: any = {
                    hovered = false, pressed = false, played = false, dragging = false, velX = 0, velY = 0,
                    count = 4, size = 0.7, back = { 0.2, 0.4, 0.6 }, belly = { 0.9, 0.95, 1 },
                    spin = 1.2, radius = 0.7, exciteSpin = 1.5, scatterPush = 1.2, padX = 0.18, padY = 0.18, drop = 0, rotate = 0, rotateVary = 0,
                    swirlHold = 0.9, swirlIn = 8, swirlOut = 2,
                    slosh = 0.0012, spring = 12, damp = 4, bounce = 0.55, turn = 2, turnMax = math.rad(60),
                    hitSpeed = 0.35, hitGap = 0.12,
                    dentAmount = 0, dentFreq = 9, dentDamp = 0.35,
                    bubbleCount = 4, bubbleSize = 0.09, bubbleRise = 0.55, bubbleLife = 1.1, bubbleSpread = 0.5,
                    loosen = 6, still = 40, settle = 4, friction = 1.2, gravity = 1.5, tumble = 0.5,
                    walls = walls,
                    colGap = 1, rowGap = 1, holds = false,
                    yaw = 0, roll = 0, sway = 1, revealed = false, enterSpeed = 0,
                    clipRate = 0, clipWeight = 1, bio = { 0.4, 1, 0.9 }, bioStrength = 0,
                bioSpeed = 0.5, bioScale = 0.6, bioContrast = 1, bioCoverage = 0.45, bioPan = 0, bioEvolve = 0.3,
                }
                for k, v in pairs(over) do
                    t[k] = v
                end
                return t :: BAIT.Inputs
            end

            test.case('a body driven into the glass knocks', function(expect)
                local b = BAIT.new(3)
                BAIT.update(b, 1 / 60, inp({}))
                -- Fling it hard at the right-hand wall.
                for i = 1, #b.fish do
                    b.fish[i].vx = 40
                end
                local knocks = 0
                for _ = 1, 30 do
                    BAIT.update(b, 1 / 60, inp({}))
                    knocks += #b.hits
                end
                expect(knocks > 0).is(true)
            end)

            test.case('a body resting on the glass stops knocking', function(expect)
                -- THE one that matters. `wall` clamps, so a body held against
                -- the glass is touching it on every frame for as long as it
                -- sits there — and a drag parks a dozen of them in the corner
                -- under gravity. Counting touches rather than closing speed
                -- fires sixty times a second per fish, for ever.
                local b = BAIT.new(7)
                local held = inp({ dragging = true, velX = 900, velY = 900 })
                for _ = 1, 120 do
                    BAIT.update(b, 1 / 60, held)
                end
                -- Now hold the card still, so they settle wherever they are.
                local parked = inp({ dragging = true, velX = 0, velY = 0 })
                for _ = 1, 120 do
                    BAIT.update(b, 1 / 60, parked)
                end
                local late = 0
                for _ = 1, 180 do
                    BAIT.update(b, 1 / 60, parked)
                    late += #b.hits
                end
                -- Three settled seconds. A touch-counter would be in the
                -- hundreds here; a handful of real knocks as they reseat is
                -- fine, a steady stream is not.
                expect(late < 10).is(true)
            end)

            test.case('one frame reports one knock per body, not four', function(expect)
                -- `wall` runs four times per body (two passes, nose and tail)
                -- and a body driven into a corner trips three walls at once.
                local b = BAIT.new(11)
                BAIT.update(b, 1 / 60, inp({ count = 1 }))
                -- PUT it in the corner rather than hoping the sim gets there:
                -- a test that only trips one wall cannot tell one knock from
                -- three. The frustum at z = 0 is +-1.29 in y and +-0.92 in x
                -- (dist 3.2, 22 degrees, card aspect), and zFront is 1.0.
                local f = b.fish[1]
                f.x, f.y, f.z = 0.9, 1.28, 0.98
                f.vx, f.vy, f.vz = 60, 60, 60
                BAIT.update(b, 1 / 60, inp({ count = 1 }))
                expect(#b.hits).is(1)
                -- and it reports the hardest wall, not whichever came first
                expect(b.hits[1].speed > 0).is(true)
            end)

            test.case('the gap holds a scraping body down', function(expect)
                local b = BAIT.new(13)
                local i = inp({ count = 1, hitGap = 0.5 })
                BAIT.update(b, 1 / 60, i)
                local knocks = 0
                for _ = 1, 60 do
                    -- Re-flung every frame, so only the gap can stop it.
                    b.fish[1].vx = 40
                    BAIT.update(b, 1 / 60, i)
                    knocks += #b.hits
                end
                -- One second at a half-second gap. A literal, not
                -- `1 / i.hitGap` — a bound computed from the constant it is
                -- checking cannot fail when that constant is what broke.
                expect(knocks <= 3).is(true)
                expect(knocks >= 1).is(true)
            end)

            test.case('a soft touch is not a knock', function(expect)
                local b = BAIT.new(17)
                local i = inp({ count = 1, hitSpeed = 5 })
                BAIT.update(b, 1 / 60, i)   -- the bodies exist after one update
                for _ = 1, 60 do
                    b.fish[1].vx = 1.0      -- well under the threshold
                    BAIT.update(b, 1 / 60, i)
                end
                local knocks = 0
                for _ = 1, 60 do
                    b.fish[1].vx = 1.0
                    BAIT.update(b, 1 / 60, i)
                    knocks += #b.hits
                end
                expect(knocks).is(0)
            end)

            test.case('hits are drained every frame', function(expect)
                local b = BAIT.new(19)
                local i = inp({})
                for _ = 1, 200 do
                    for k = 1, #b.fish do
                        b.fish[k].vx = 40
                    end
                    BAIT.update(b, 1 / 60, i)
                end
                -- Never a backlog, and never more than ONE knock per body in a
                -- frame however chaotic it gets: four `wall` calls each, and
                -- a corner trips three walls inside one of them.
                expect(#b.hits <= 4).is(true)
            end)
        end)

        test.group('the cascade', function()
            local function inputs(): CASCADE.Inputs
                return {
                    w = 1600, h = 1000, cw = 120, ch = 168, fit = 1,
                    gravity = 1400, launch = 260, lift = 190, bounce = 0.72,
                    gap = 0.13, spin = 1.6, floor = 10, restSpeed = 90,
                }
            end
            -- Four foundations, thirteen each, ace at the bottom as they sit.
            local function piles(): { { number } }
                local out = {}
                for s = 1, 4 do
                    local p = {}
                    for r = 1, 13 do
                        table.insert(p, (s - 1) * 13 + r)
                    end
                    table.insert(out, p)
                end
                return out
            end
            local FROM = { { x = 700, y = 200 }, { x = 840, y = 200 }, { x = 980, y = 200 }, { x = 1120, y = 200 } }

            test.case('the piles empty a card at a time, in turn, top card first', function(expect)
                local order = CASCADE.order(piles())
                expect(#order).is(52)
                -- the first four are each pile's TOP card (the king)
                for i = 1, 4 do
                    expect(order[i].pile).is(i)
                    expect(order[i].id).is((i - 1) * 13 + 13)
                end
                -- and the round after takes the queens, in the same rotation
                for i = 5, 8 do
                    expect(order[i].pile).is(i - 4)
                    expect(order[i].id).is((i - 5) * 13 + 12)
                end
                -- every card exactly once
                local seen = {}
                for _, o in ipairs(order) do
                    expect(seen[o.id]).is(nil)
                    seen[o.id] = true
                end
            end)

            test.case('a short pile runs out without stalling the others', function(expect)
                local order = CASCADE.order({ { 1 }, { 2, 3, 4 }, {}, { 5, 6 } })
                expect(#order).is(6)
                local ids = {}
                for _, o in ipairs(order) do
                    table.insert(ids, o.id)
                end
                expect(table.concat(ids, ',')).is('1,4,6,3,5,2')
            end)

            test.case('the cards leave on the clock, not the frame rate', function(expect)
                local inp = inputs()
                local s = CASCADE.new(CASCADE.order(piles()), FROM)
                -- one long frame owes several cards and launches all of them
                CASCADE.update(s, 0.5, inp)
                expect(s.next - 1).is(math.floor(0.5 / inp.gap) + 1)
                local live = 0
                for _, c in ipairs(s.cards) do
                    if c.live then live += 1 end
                end
                expect(live).is(s.next - 1)
            end)

            test.case('a card bounces off the floor, lower each time, and never through it', function(expect)
                local inp = inputs()
                local s = CASCADE.new(CASCADE.order({ { 7 } }), { { x = 800, y = 200 } })
                local c = s.cards[1]
                local floorY = inp.h - inp.floor - inp.ch * 0.5
                local peaks, rising = {}, false
                local prevY = c.y
                for _ = 1, 600 do
                    CASCADE.update(s, 1 / 120, inp)
                    if not c.live and c.gone then break end
                    expect(c.y <= floorY + 0.001).is(true)
                    -- a peak is where it stops rising
                    if c.y > prevY and rising then
                        table.insert(peaks, prevY)
                        rising = false
                    elseif c.y < prevY then
                        rising = true
                    end
                    prevY = c.y
                end
                expect(c.bounces >= 2).is(true)
                -- each arc peaks lower than the one before (a bigger y is lower)
                for i = 2, #peaks do
                    expect(peaks[i] >= peaks[i - 1] - 0.001).is(true)
                end
            end)

            test.case('every card ends up off the screen, and the cascade reports itself done', function(expect)
                local inp = inputs()
                local s = CASCADE.new(CASCADE.order(piles()), FROM)
                expect(CASCADE.done(s)).is(false)
                local t = 0
                while t < 60 and not CASCADE.done(s) do
                    CASCADE.update(s, 1 / 60, inp)
                    t += 1 / 60
                end
                expect(CASCADE.done(s)).is(true)
                for _, c in ipairs(s.cards) do
                    expect(c.gone).is(true)
                    expect(c.x < -inp.cw or c.x > inp.w + inp.cw).is(true)
                end
            end)

            test.case('the throw goes both ways off a pile', function(expect)
                local inp = inputs()
                local s = CASCADE.new(CASCADE.order(piles()), FROM)
                for _ = 1, 60 do
                    CASCADE.update(s, 1 / 60, inp)
                end
                local left, right = 0, 0
                for _, c in ipairs(s.cards) do
                    if c.live then
                        if c.vx < 0 then left += 1 else right += 1 end
                    end
                end
                expect(left > 0).is(true)
                expect(right > 0).is(true)
            end)

            test.case('it is deterministic: the same trigger twice is the same cascade', function(expect)
                local inp = inputs()
                local function run(): string
                    local s = CASCADE.new(CASCADE.order(piles()), FROM)
                    for _ = 1, 200 do
                        CASCADE.update(s, 1 / 60, inp)
                    end
                    local out = {}
                    for _, c in ipairs(s.cards) do
                        table.insert(out, `{string.format('%.4f', c.x)},{string.format('%.4f', c.y)}`)
                    end
                    return table.concat(out, ' ')
                end
                expect(run()).is(run())
            end)

            test.case('a dead bounce stops bouncing instead of sliding along the floor', function(expect)
                local inp = inputs()
                inp.bounce = 0.1
                local s = CASCADE.new(CASCADE.order({ { 9 } }), { { x = 800, y = 200 } })
                local c = s.cards[1]
                for _ = 1, 2000 do
                    CASCADE.update(s, 1 / 120, inp)
                    if c.gone then break end
                end
                expect(c.gone).is(true)
                -- it stopped REPORTING bounces long before it left: a hit
                -- under restSpeed is a card settling, not a bounce.
                local reported = 0
                local s2 = CASCADE.new(CASCADE.order({ { 9 } }), { { x = 800, y = 200 } })
                for _ = 1, 2000 do
                    CASCADE.update(s2, 1 / 120, inp)
                    reported += #s2.hits
                    if s2.cards[1].gone then break end
                end
                expect(reported < 6).is(true)
            end)
        end)
        test.group('reactions', function()
            local TAU = math.pi * 2
            local function nearTurn(a: number): boolean
                local r = a % TAU
                return r < 1e-3 or TAU - r < 1e-3
            end
            test.case('every reaction ends where it began', function(expect)
                for _, v in ipairs(REACT.VARIANTS) do
                    local p = REACT.pose(v.name, v.duration)
                    expect(nearTurn(p.heading)).is(true)
                    expect(nearTurn(p.roll)).is(true)
                    expect(nearTurn(p.pitch)).is(true)
                    expect(p.clap).is(0)
                    expect(p.clipW).is(0)
                    expect(p.lift).is(0)
                    -- and did something in the middle
                    local moved = false
                    for t = 0, v.duration, v.duration / 40 do
                        local q = REACT.pose(v.name, t)
                        if math.abs(q.heading) + math.abs(q.roll) + math.abs(q.pitch) + q.clap + q.clipW > 0.05 then
                            moved = true
                        end
                    end
                    expect(moved).is(true)
                end
            end)
            test.case('a turn is monotone and whole: it arrives at the identity, never unwinds', function(expect)
                for _, name in ipairs({ 'spin', 'barrel', 'flip' }) do
                    local v = REACT.variant(name) :: REACT.Variant
                    local last = -1
                    local peak = 0
                    local arrived = false
                    for t = 0.3, v.duration - 0.01, 0.01 do
                        local q = REACT.pose(name, t)
                        local a = q.heading + q.roll + q.pitch
                        if arrived then
                            -- past the turn it reads as the identity, and stays there
                            expect(math.abs(a)).lessThan(1e-6)
                        elseif a < last - 1e-6 then
                            -- the one allowed drop: a whole turn becoming 0
                            expect(math.abs(last - TAU)).lessThan(0.02)
                            expect(math.abs(a)).lessThan(1e-6)
                            arrived = true
                        end
                        last = a
                        peak = math.max(peak, a)
                    end
                    expect(arrived).is(true)
                    expect(math.abs(peak - TAU)).lessThan(0.02)
                end
            end)
            test.case('the clap closes three times', function(expect)
                local closes, above = 0, false
                for t = 0, 1.4, 0.005 do
                    local c = REACT.pose('clap', t).clap
                    if c > 0.9 and not above then
                        closes += 1
                    end
                    above = c > 0.9
                end
                expect(closes).is(3)
            end)
            test.case('a clip reaction plays a window inside the baked clip and fades out', function(expect)
                local shortest = 5.4 -- ball, the shortest of the three baked (tools/sealitaire-mesh.mjs)
                for _, name in ipairs(REACT.CLIPS) do
                    local v = REACT.variant(name) :: REACT.Variant
                    expect(v.clip).is(name)
                    expect((v.clipFrom :: number) + (v.clipLen :: number) <= shortest).is(true)
                    local mid = REACT.pose(name, v.duration * 0.5)
                    expect(mid.clipW).is(1)
                    expect(mid.clip).is(name)
                    expect(REACT.pose(name, v.duration - 0.01).clipW).lessThan(0.1)
                end
            end)
            test.case('the pick never repeats the last one', function(expect)
                for k = 0, 40 do
                    local last = REACT.VARIANTS[(k % #REACT.VARIANTS) + 1].name
                    expect(REACT.pick(last, (k * 0.137) % 1) ~= last).is(true)
                end
            end)
            test.case('the puppet goes to the stage, performs, and comes back', function(expect)
                local p = PUPPET.new(800, 400)
                local function frame(seq: number): PUPPET.Frame
                    return {
                        w = 1600, h = 1000, L = 150, pxUnit = 150 / 1.68,
                        row = { x = 800, y = 500 }, stage = { x = 800, y = 850 },
                        reactSeq = seq, reactVariant = 'spin', reactSpeed = 1,
                        card = nil, cursor = nil, corner = nil, mouthDx = 0, mouthDy = 0,
                        biting = false, releaseT = -1, dragging = false, won = false,
                        thrust = 6.4, friction = 0.965, maxSpeed = 34, turnLerp = 2.5, steer = 11,
                        landEase = 0, lean = 0,
                        arrive = 0.45, blendRate = 2.3, blendTime = 0.5, turnSettle = 11,
                        moveThreshold = 1.5, boostThreshold = 18, crossfade = 0.2, clipScale = 1,
                        bobAmp = 0.035, bobPeriod = 2.8,
                        biteOffset = 0.1, jawClamp = 0.08, biteHold = 0.15, releaseTime = 1.6, releaseLift = 0.8, releasePush = 0,
                        steerTight = 2.3,
                    }
                end
                for _ = 1, 60 do
                    PUPPET.update(p, 1 / 60, frame(0))
                end
                expect(p.wanted).is('idle')
                local performed, lowest = false, 0
                for _ = 1, 360 do
                    PUPPET.update(p, 1 / 60, frame(1))
                    if PUPPET.reacting(p) then
                        expect(p.wanted).is('react')
                        if p.reactT > 0.3 then
                            performed = true
                            lowest = math.max(lowest, p.y)
                        end
                    end
                end
                expect(performed).is(true)
                -- it performed down at the stage, not up at the row
                expect(lowest).greaterThan(650)
                expect(PUPPET.reacting(p)).is(false)
                expect(p.wanted).is('idle')
                expect(math.abs(p.outPitch)).lessThan(1e-6)
            end)
        end)
        test.group('hover pop', function()
            local K_, D_, WAVE = 220, 11, 0.045
            local function chain(n: number): { HOVER.Pop }
                local c = {}
                for _ = 1, n do
                    table.insert(c, HOVER.new())
                end
                return c
            end
            local function run(c: { HOVER.Pop }, from: number, to: number)
                local t = from
                while t < to do
                    for _, p in ipairs(c) do
                        HOVER.step(p, t, 1 / 120, K_, D_)
                    end
                    t += 1 / 120
                end
            end
            test.case('the wave runs down the chain: the top card first, each below a beat later', function(expect)
                local c = chain(5)
                HOVER.arm(c, 1, 0, WAVE)
                run(c, 0, WAVE * 1.5)
                -- cards 1 and 2 have been told; 3, 4, 5 have not moved
                expect(c[1].pop).greaterThan(c[2].pop)
                expect(c[2].pop).greaterThan(0)
                expect(c[3].pop).is(0)
                expect(c[5].pop).is(0)
                run(c, WAVE * 1.5, WAVE * 3.5)
                for k = 1, 4 do
                    expect(c[k].pop).greaterThan(c[k + 1].pop - 1e-9)
                end
                expect(c[4].pop).greaterThan(0)
            end)
            test.case('it is springy: the top card overshoots and every card settles at 1', function(expect)
                local c = chain(4)
                HOVER.arm(c, 1, 0, WAVE)
                local peak = 0
                local t = 0
                while t < 3 do
                    for _, p in ipairs(c) do
                        HOVER.step(p, t, 1 / 120, K_, D_)
                    end
                    peak = math.max(peak, c[1].pop)
                    t += 1 / 120
                end
                expect(peak).greaterThan(1.02)
                for _, p in ipairs(c) do
                    expect(math.abs(p.pop - 1)).lessThan(0.005)
                end
            end)
            test.case('leaving lets the chain down the same way, and re-arming mid-wave does not restart it', function(expect)
                local c = chain(4)
                HOVER.arm(c, 1, 0, WAVE)
                run(c, 0, 1.5)
                HOVER.arm(c, 0, 1.5, WAVE)
                local arm3 = c[3].arm
                run(c, 1.5, 1.5 + WAVE * 1.5)
                -- the same run armed again: nothing moves
                HOVER.arm(c, 0, 1.5 + WAVE * 1.5, WAVE)
                expect(c[3].arm).is(arm3)
                expect(c[1].pop).lessThan(c[4].pop)
                run(c, 1.5 + WAVE * 1.5, 4)
                for _, p in ipairs(c) do
                    expect(math.abs(p.pop)).lessThan(0.005)
                end
            end)
            test.case('a press dips the card and it springs back', function(expect)
                local c = chain(1)
                HOVER.arm(c, 1, 0, WAVE)
                run(c, 0, 1.5)
                HOVER.kick(c[1], 4)
                local low = 1
                local t = 1.5
                while t < 3 do
                    HOVER.step(c[1], t, 1 / 120, K_, D_)
                    low = math.min(low, c[1].pop)
                    t += 1 / 120
                end
                expect(low).lessThan(0.9)
                expect(math.abs(c[1].pop - 1)).lessThan(0.01)
            end)
        end)
        test.group('knock', function()
            test.case('a bigger body knocks lower, a smaller one higher, an octave each way at most', function(expect)
                expect(KNOCK.step(0.4, 0.4, 1)).is(0)
                expect(KNOCK.step(0.8, 0.4, 1)).is(-2)       -- twice the size: an octave down
                expect(KNOCK.step(0.2, 0.4, 1)).is(2)        -- half: an octave up
                expect(KNOCK.step(0.57, 0.4, 1)).is(-1)      -- x1.41: six semitones
                expect(KNOCK.step(3, 0.4, 1)).is(-2)         -- clamped
                expect(KNOCK.step(0.8, 0.4, 0)).is(0)        -- the slider at 0: one pitch
                expect(KNOCK.step(0.8, 0.4, 2)).is(-2)
                expect(KNOCK.step(0, 0.4, 1)).is(0)
            end)
            test.case('the sweep crossfades down the ladder at equal power', function(expect)
                local lo, hi, a, b = KNOCK.sweep(0)
                expect(lo).is(0)
                expect(a).is(1)
                expect(math.abs(b)).lessThan(1e-9)
                lo, hi, a, b = KNOCK.sweep(1)
                expect(lo).is(KNOCK.CUTOFFS - 1)
                expect(hi).is(KNOCK.CUTOFFS - 1)
                for s = 0, 1, 0.05 do
                    local l2, h2, wa, wb = KNOCK.sweep(s)
                    expect(h2 - l2).lessThan(2)
                    expect(math.abs(wa * wa + wb * wb - 1)).lessThan(1e-6)
                end
                local l3, h3 = KNOCK.sweep(0.5)
                expect(l3).is(1)
                expect(h3).is(2)
            end)
        end)
        test.group('music', function()
            test.case('an onset rings once, not once a frame', function(expect)
                -- A flux spike four frames wide, which is what a real onset
                -- looks like at 60Hz. Counting frames over the threshold
                -- instead of edges would ring four times and spend half the
                -- ring on one drum hit.
                local m = fakeBake(1, 120, 60, function(f: number, _k: number): (number, number)
                    return 0.5, if f >= 20 and f <= 23 then 0.9 else 0.0
                end)
                local rings = 0
                for f = 0, 59 do
                    rings += #MUSIC.step(m, f / 60, 1 / 60)
                end
                expect(rings).is(1)
            end)

            test.case('a band waits out its refractory', function(expect)
                -- Flux pinned high forever: the only thing that can stop it
                -- ringing every frame is the refractory.
                local m = fakeBake(1, 600, 60, function(_f: number, _k: number): (number, number)
                    return 0.5, 1.0
                end)
                local rings = 0
                for f = 0, 299 do
                    rings += #MUSIC.step(m, f / 60, 1 / 60)
                end
                -- Twelve: five seconds at band 1's half-second refractory,
                -- plus the one at the start. A LITERAL, not `5 /
                -- MUSIC.REFRACTORY[1]` — a bound computed from the constant
                -- it is checking cannot fail, and with the refractories
                -- zeroed that expression is 5/0 and the test passes happily
                -- while the water rings forty times a second.
                expect(rings <= 12).is(true)
                expect(rings >= 2).is(true)
            end)

            test.case('a quiet passage does not ring', function(expect)
                -- Flux well under the threshold for ten seconds. The bands
                -- are normalised against the track's OWN quiet, so a soft
                -- passage still has plenty of small rises in it; if the
                -- threshold stops mattering the water pulses all the way
                -- through the parts of the track that are barely there.
                local m = fakeBake(8, 600, 60, function(_f: number, _k: number): (number, number)
                    return 0.2, 0.12
                end)
                local rings = 0
                for f = 0, 599 do
                    rings += #MUSIC.step(m, f / 60, 1 / 60)
                end
                expect(rings).is(0)
            end)

            test.case('one frame rings at most one band, the loudest', function(expect)
                local m = fakeBake(8, 120, 60, function(_f: number, k: number): (number, number)
                    return 0.5, 0.5 + k * 0.05
                end)
                local first = MUSIC.step(m, 0, 1 / 60)
                expect(#first).is(1)
                -- Band 8 is the loudest, and the spectrum runs left to right,
                -- so it rings on the right-hand side of the table.
                expect(first[1].x > 0.5).is(true)
            end)

            test.case("the table's own gap is what holds the rate down", function(expect)
                -- Eight bands each obeying their OWN refractory still fire on
                -- eight consecutive frames — a ring an eighth of a frame
                -- apart, which is one bright flash and eight spent slots. The
                -- table-wide gap is the limit that stops it, and the only one
                -- that can: per-band refractories cannot see each other.
                local m = fakeBake(8, 600, 60, function(_f: number, k: number): (number, number)
                    return 0.5, 0.5 + k * 0.05
                end)
                local rings = 0
                for f = 0, 59 do
                    rings += #MUSIC.step(m, f / 60, 1 / 60)
                end
                -- A second of every band screaming without pause. Six: the
                -- 0.22s gap, as a LITERAL for the same reason as above —
                -- `1 / MUSIC.GAP` is infinity the moment the gap is the thing
                -- that broke. Without the gap this is about twenty-three.
                expect(rings <= 6).is(true)
                expect(rings >= 2).is(true)
            end)

            test.case('the loop does not mute the top of the track', function(expect)
                local m = fakeBake(1, 600, 60, function(_f: number, _k: number): (number, number)
                    return 0.5, 1.0
                end)
                expect(#MUSIC.step(m, 5.0, 1 / 60)).is(1)
                -- The playhead going backwards is the track starting again.
                -- Held against a refractory kept in playhead seconds, the
                -- first half second of every loop would be silent water.
                expect(#MUSIC.step(m, 0.0, 1 / 60)).is(1)
            end)

            test.case('a flux peak survives the read between frames', function(expect)
                -- A one-frame spike, sampled half way between frames. Lerping
                -- the flux the way the level is lerped would halve exactly the
                -- peaks the impulses exist to fire on.
                local m = fakeBake(1, 120, 60, function(f: number, _k: number): (number, number)
                    return 0.5, if f == 30 then 1.0 else 0.0
                end)
                local _, flux = MUSIC.sample(m, 1, 29.5 / 60)
                expect(flux).is(1)
            end)
        end)

        -- ---------------------------------------------------------------
        -- THE LOOPS. One bounce, regions of it, and a seek between them.
        --
        -- None of these plays anything: `Audio` does not exist under --test.
        -- They are the decisions — which region, and when — which is why
        -- those are separate pure functions in music.luau.
        -- ---------------------------------------------------------------
        test.group('music loops', function()
            local BED, INTRO, WIN = 0, 1, 2
            local OPEN, DEALS, WINS, FOUND, SCORE, MOVES = 0, 1, 2, 3, 4, 5

            test.case('the loop table survives the round trip through the bake', function(expect)
                -- The header layout, end to end. The ids are the tell: they
                -- are the only variable-length thing in a fixed-size record,
                -- so an off-by-one anywhere in the offsets reads a startSec
                -- as part of a name or a name as a float.
                local rows = {
                    loop('open', 0, 10.2128, INTRO, OPEN, 0),
                    loop('deal', 10.2128, 71.4894, BED, OPEN, 0),
                    loop('drift', 71.4894, 173.617, BED, FOUND, 8),
                }
                local m = MUSIC.new()
                expect(MUSIC.parse(m, bakeBytes(4, 90, 60, 2.553191, rows, function(): (number, number)
                    return 0.5, 0.0
                end))).is(true)
                expect(#m.loops).is(3)
                expect(m.loops[1].id).is('open')
                expect(m.loops[3].id).is('drift')
                expect(m.loops[3].gate).is(FOUND)
                expect(m.loops[3].gateN).is(8)
                expect(math.abs(m.barSeconds - 2.553191) < 1e-5).is(true)
                -- And the frames still read: `head` has to have moved past
                -- the loop records. If it did not, the first loop's id would
                -- be sampled as a level and this would be 0.44, not 0.5.
                local level = MUSIC.sample(m, 1, 0.5)
                expect(math.abs(level - 0.5) < 0.01).is(true)
            end)

            test.case('a gate holds a loop back until the game earns it', function(expect)
                local l = loop('drift', 0, 10, BED, FOUND, 8)
                expect(MUSIC.unlocked(l, prog(0, 0, 7, 0, 0))).is(false)
                expect(MUSIC.unlocked(l, prog(0, 0, 8, 0, 0))).is(true)
                -- Every gate reads its own field and no other. Written out
                -- one by one because the bug this catches — two gates wired
                -- to the same counter — makes both of them look like they
                -- work as long as you only ever test one.
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, DEALS, 2), prog(2, 0, 0, 0, 0))).is(true)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, DEALS, 2), prog(1, 9, 9, 9, 9))).is(false)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, WINS, 1), prog(9, 1, 0, 0, 0))).is(true)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, WINS, 1), prog(9, 0, 9, 9, 9))).is(false)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, SCORE, 50), prog(9, 9, 9, 50, 0))).is(true)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, SCORE, 50), prog(9, 9, 9, 49, 9))).is(false)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, MOVES, 30), prog(9, 9, 9, 9, 30))).is(true)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, MOVES, 30), prog(9, 9, 9, 9, 29))).is(false)
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, OPEN, 0), prog(0, 0, 0, 0, 0))).is(true)
            end)

            test.case('an unknown gate locks, it does not open', function(expect)
                -- A bake from a newer table with a gate this script has never
                -- heard of. Defaulting to open would hand the player a loop
                -- the CSV meant to hold back, which is the failure you never
                -- find because it looks like generosity.
                expect(MUSIC.unlocked(loop('a', 0, 1, BED, 99, 0), prog(9, 9, 9, 9, 9))).is(false)
            end)

            test.case('the ladder climbs and stays climbed', function(expect)
                local rows = {
                    loop('open', 0, 10, INTRO, OPEN, 0),
                    loop('deal', 10, 20, BED, OPEN, 0),
                    loop('drift', 20, 30, BED, FOUND, 10),
                    loop('loud', 30, 40, BED, FOUND, 26),
                    loop('tail', 40, 50, WIN, OPEN, 0),
                }
                -- Nothing on the foundations: the bottom rung.
                expect(MUSIC.bedFor(rows, prog(1, 0, 0, 0, 0))).is(2)
                expect(MUSIC.bedFor(rows, prog(1, 0, 9, 0, 0))).is(2)
                -- Ten cards and the development takes over; TWENTY-FIVE is
                -- still the development, not the loud one.
                expect(MUSIC.bedFor(rows, prog(1, 0, 10, 0, 0))).is(3)
                expect(MUSIC.bedFor(rows, prog(1, 0, 25, 0, 0))).is(3)
                -- Half the deck and the loudest.
                expect(MUSIC.bedFor(rows, prog(1, 0, 26, 0, 0))).is(4)
                expect(MUSIC.bedFor(rows, prog(1, 0, 52, 0, 0))).is(4)
                -- THE LAST unlocked, not the first. A rotation would answer
                -- `deal` here — the bug this replaced — and the music would
                -- fall back to the opening bed every other phrase.
                expect(MUSIC.bedFor(rows, prog(9, 9, 52, 9, 9)) ~= 2).is(true)
                -- Roles that are not beds are found by name, not by ladder.
                expect(MUSIC.roleFor(rows, INTRO, prog(1, 0, 0, 0, 0))).is(1)
                expect(MUSIC.roleFor(rows, WIN, prog(1, 0, 0, 0, 0))).is(5)
                -- And a table with nothing unlocked answers 0 rather than
                -- guessing a row.
                expect(MUSIC.bedFor({ loop('x', 0, 1, BED, FOUND, 5) }, prog(0, 0, 0, 0, 0))).is(0)
            end)

            -- A stand-in for the audio engine: one asset in, something with
            -- `completed`, `stop` and `volume` out. That is the entire
            -- surface the transport uses, which is the point of keeping it
            -- that small.
            --
            -- `time()` is deliberately NOT provided. If anything in the
            -- driver ever reaches for the audio clock again this stops
            -- compiling here rather than working in tests and wedging in the
            -- player, which is what happened the last two times.
            local played: { string } = {}
            local function fakeEngine(srcName: string)
                local snd = { done = false, stopped = false, volume = 0 }
                function snd.completed(_self): boolean return snd.done end
                function snd.stop(_self, _fade: number?) snd.stopped = true end
                return snd
            end

            local live: any = nil
            local function installEngine()
                played = {}
                MUSIC.setPlayer(function(src: any): any
                    table.insert(played, tostring(src))
                    live = fakeEngine(tostring(src))
                    return live
                end)
            end

            -- A region's asset stands in as its id, so `played` reads as the
            -- sequence of loops the table actually put on.
            local function withAssets(rows: { MUSIC.Loop }, barSeconds: number): MUSIC.Music
                local m = MUSIC.new()
                assert(MUSIC.parse(m, bakeBytes(1, 60, 60, barSeconds, rows, function(): (number, number)
                    return 0.5, 0.0
                end)), 'the loop bake did not parse')
                for _, l in ipairs(m.loops) do
                    l.src = (l.id :: any)
                end
                MUSIC.resetTransport()
                installEngine()
                return m
            end

            -- 2.5s bar, so a block is four bars and TEN SECONDS. The beds are
            -- several blocks long on purpose: with one-block regions the
            -- block line and the region end fall at the same instant and an
            -- escalation case passes whichever one the code waited for.
            --
            --   bar 2.5s | block 10s | deal 60s, drift 40s, loud 40s
            local ROWS = {
                loop('open', 0, 10, INTRO, OPEN, 0),
                loop('deal', 10, 70, BED, OPEN, 0),
                loop('drift', 70, 110, BED, FOUND, 10),
                loop('loud', 110, 150, BED, FOUND, 26),
                loop('win', 150, 160, WIN, OPEN, 0),
            }

            -- Run the driver at 120Hz for `seconds`, with the fake sound
            -- finishing exactly when its region's length is up — which is
            -- what a real one does and the only thing the transport asks of
            -- it.
            local function play(m: MUSIC.Music, seconds: number, p: MUSIC.Progress)
                local dt = 1 / 120
                for _ = 1, math.floor(seconds * 120) do
                    local cur = MUSIC.currentLoop(m)
                    if cur ~= nil and live ~= nil and MUSIC.elapsedIn() + dt >= cur.endSec - cur.startSec then
                        live.done = true
                    end
                    MUSIC.drive(m, dt, 1.0, p)
                end
            end

            test.case('it starts on the intro and hands to the bottom rung', function(expect)
                local m = withAssets(ROWS, 2.5)
                play(m, 1, prog(1, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(1)
                expect(#played).is(1)
                expect(played[1]).is('open')
                play(m, 10, prog(1, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(2)
                expect(played[2]).is('deal')
            end)

            test.case('a region loops until the next one is ungated', function(expect)
                -- The whole of "loop the main bed until ten cards are up".
                -- `deal` is sixty seconds; three minutes at nine cards is
                -- three more plays of it and nothing else.
                local m = withAssets(ROWS, 2.5)
                play(m, 11, prog(1, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(2)
                play(m, 185, prog(1, 0, 9, 0, 0))
                expect(MUSIC.playingIndex()).is(2)
                expect(MUSIC.queuedIndex()).is(0)
                -- open, then deal, then deal again three times over.
                expect(#played).is(5)
                for k = 2, 5 do
                    expect(played[k]).is('deal')
                end
            end)

            test.case('an escalation lands on the next block, not the next region', function(expect)
                -- THE TWO TIMES ARE FIFTY SECONDS APART. `deal` runs sixty
                -- seconds; ten cards arriving twenty-two seconds in lands at
                -- the block line at thirty, not at the region's end.
                local m = withAssets(ROWS, 2.5)
                play(m, 11, prog(1, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(2)
                play(m, 12, prog(1, 0, 9, 0, 0))
                expect(MUSIC.queuedIndex()).is(0)
                -- Ten cards, twenty-two seconds into `deal`.
                play(m, 1, prog(1, 0, 10, 0, 0))
                expect(MUSIC.queuedIndex()).is(3)
                -- Not at the next bar: 25 and 27.5 are bar lines.
                play(m, 5, prog(1, 0, 10, 0, 0))
                expect(MUSIC.playingIndex()).is(2)
                -- At the block line, within ten seconds of the card.
                play(m, 3, prog(1, 0, 10, 0, 0))
                expect(MUSIC.playingIndex()).is(3)
                expect(played[#played]).is('drift')
            end)

            test.case('the ladder does not come back down inside a deal', function(expect)
                -- Klondike lets you pull the top card back off a foundation,
                -- and the stock recycle costs score. Without a latch the
                -- music drops a rung when you undo a card, for no reason the
                -- player can connect to anything.
                local m = withAssets(ROWS, 2.5)
                play(m, 11, prog(1, 0, 0, 0, 0))
                play(m, 15, prog(1, 0, 26, 0, 0))
                expect(MUSIC.playingIndex()).is(4)
                expect(MUSIC.bedFor(ROWS, prog(1, 0, 24, 0, 0))).is(3)
                play(m, 30, prog(1, 0, 24, 0, 0))
                expect(MUSIC.playingIndex()).is(4)
                -- Only a new deal lets go of the rung.
                MUSIC.noteDeal(m, 0, 0, 0)
                play(m, 5, prog(2, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(1)
                play(m, 11, prog(2, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(2)
            end)

            test.case('a win takes over at the next bar and then holds', function(expect)
                local m = withAssets(ROWS, 2.5)
                play(m, 11, prog(1, 0, 0, 0, 0))
                expect(MUSIC.playingIndex()).is(2)      -- `deal`, sixty long
                MUSIC.noteWin(m, 52, 0, 0)
                expect(MUSIC.queuedIndex()).is(5)
                play(m, 3, prog(1, 1, 52, 0, 0))
                expect(MUSIC.playingIndex()).is(5)      -- within a bar
                expect(played[#played]).is('win')
                local upTo = #played
                -- AND IT HOLDS. A foundation count of 52 would otherwise put
                -- it straight onto the loud bed; it plays the win region
                -- over and over instead, because the deal is over.
                play(m, 60, prog(1, 1, 52, 0, 0))
                expect(MUSIC.playingIndex()).is(5)
                for k = upTo, #played do
                    expect(played[k]).is('win')
                end
            end)

            test.case('a sound that claims to be finished early is not believed', function(expect)
                -- THE MACHINE-GUN. A handle to a sound somebody else stopped
                -- answers `completed` yes having played nothing. At a
                -- hundred and twenty advances a second, believing it starts
                -- a new voice every frame.
                --
                -- The region's length is known exactly, so the clock decides
                -- when it ran out and `completed` is only believed near the
                -- end. Here a sound says yes immediately, forever.
                local m = withAssets(ROWS, 2.5)
                MUSIC.setPlayer(function(src: any): any
                    table.insert(played, tostring(src))
                    local snd = { volume = 0 }
                    function snd.completed(_self): boolean return true end
                    function snd.stop(_self, _fade: number?) end
                    live = snd
                    return snd
                end)
                local dt = 1 / 120
                for _ = 1, 120 * 5 do
                    MUSIC.drive(m, dt, 1.0, prog(1, 0, 0, 0, 0))
                end
                -- Five seconds of it, and the intro has been started once.
                expect(#played).is(1)
                expect(played[1]).is('open')
                -- Past the intro's ten seconds it moves on, exactly once.
                for _ = 1, 120 * 6 do
                    MUSIC.drive(m, dt, 1.0, prog(1, 0, 0, 0, 0))
                end
                expect(#played).is(2)
                expect(played[2]).is('deal')
                MUSIC.setPlayer(nil)
            end)

            test.case('nothing in the transport reads the audio clock', function(expect)
                -- THE FAILURE THIS DESIGN EXISTS TO RULE OUT. The previous
                -- transport asked the sound where it was and asked the
                -- engine what time it was, and shipped broken twice: once
                -- because seeking did not move the playhead, once because a
                -- clock that never advanced wedged the throttle. Neither
                -- could be reproduced in a test, because a test supplies
                -- those clocks itself and they always behaved.
                --
                -- This runs the whole progression against a sound that
                -- THROWS if asked the time. If the transport ever reaches
                -- for it again, this is where it stops.
                local m = withAssets(ROWS, 2.5)
                MUSIC.setPlayer(function(src: any): any
                    table.insert(played, tostring(src))
                    local snd = { done = false, volume = 0 }
                    function snd.completed(_self): boolean return snd.done end
                    function snd.stop(_self, _fade: number?) end
                    function snd.time(_self): number
                        error('the transport must not read the audio clock')
                    end
                    function snd.seek(_self, _to: number)
                        error('the transport must not seek')
                    end
                    live = snd
                    return snd
                end)
                play(m, 11, prog(1, 0, 0, 0, 0))
                play(m, 15, prog(1, 0, 10, 0, 0))
                expect(MUSIC.playingIndex()).is(3)
                play(m, 15, prog(1, 0, 26, 0, 0))
                expect(MUSIC.playingIndex()).is(4)
                MUSIC.noteWin(m, 52, 0, 0)
                play(m, 3, prog(1, 1, 52, 0, 0))
                expect(MUSIC.playingIndex()).is(5)
                MUSIC.setPlayer(nil)
            end)

            test.case('a bar crossing is an edge, not a window', function(expect)
                local bar = 2.5
                expect(MUSIC.crossedBar(2.4, 2.6, bar)).is(true)
                expect(MUSIC.crossedBar(2.6, 2.9, bar)).is(false)
                expect(MUSIC.crossedBar(2.6, 5.1, bar)).is(true)
                -- Exactly on the line counts as crossed: 2.5 is bar 1.
                expect(MUSIC.crossedBar(2.4, 2.5, bar)).is(true)
                -- A seek backwards is not a crossing, and no bar grid means
                -- no crossings at all rather than one every frame.
                expect(MUSIC.crossedBar(5.0, 1.0, bar)).is(false)
                expect(MUSIC.crossedBar(1.0, 9.0, 0)).is(false)
            end)
        end)

        -- The geometry, at every shape of screen. The artboard is fill-sized,
        -- so these ARE viewports: a phone in the hand, a tablet, the window
        -- this was designed in.
        test.group('layout', function()
            -- The desktop look is the thing a responsive pass most easily
            -- costs you. Every number here was hand-tuned into table.luau
            -- before it moved into layout.luau, and the vertical proportions
            -- are written as fractions of a card that sum to 1000/168 exactly
            -- so that this stays true. If one of them is nudged, this fails
            -- rather than the desktop quietly drifting.
            -- Every one of these is a ratio of integers that lands on a whole
            -- number in reals and a few parts in 10^16 off it in doubles
            -- (120.00000000000001), so they are compared to a tolerance.
            -- The tolerance is 1e-9 of a pixel: this is an equality check
            -- with the float noise taken off, not a loose one.
            test.case('1600x1000 is the layout it replaced, to the pixel', function(expect)
                local g = LAYOUT.compute(1600, 1000)
                local function near(got: number, want: number): boolean
                    return math.abs(got - want) < 1e-9
                end
                expect(near(g.cw, 120)).is(true)
                expect(near(g.ch, 168)).is(true)
                expect(near(g.gap, 24)).is(true)
                expect(near(g.fit, 1)).is(true)
                expect(near(g.left, 308)).is(true)
                expect(near(g.topY, 208)).is(true)
                expect(near(g.tabY, 430)).is(true)
                expect(near(g.fanUp, 34)).is(true)
                expect(near(g.fanDown, 14)).is(true)
                expect(near(g.ui, 1)).is(true)
                expect(near(LAYOUT.colX(g, 1), 368)).is(true)
                -- The deal button and the panel, as they were; the title and
                -- the readouts along the foot, bottom-left.
                expect(near(g.button.x, 1400)).is(true)
                expect(near(g.button.y, 30)).is(true)
                expect(near(g.button.w, 160)).is(true)
                local tx, ty = LAYOUT.titleAt(g)
                expect(near(tx, 40)).is(true)
                expect(near(ty, 912)).is(true)
                expect(near(g.stats.x, 300)).is(true)
                expect(near(g.stats.y, 914)).is(true)
                -- The panel gained a scroll gutter down its left, so its own
                -- x moved by that much; its COLUMNS start where they did.
                expect(near(g.tuner.x + g.tuner.gutter, 820)).is(true)
                expect(g.tuner.cols).is(2)
            end)

            -- Seven columns is not negotiable — it is what klondike IS — so
            -- the card is sized from the width whenever the width is what
            -- runs out, and the board has to land inside the screen at every
            -- one of these or cards are simply unreachable.
            test.case('the board fits across every viewport', function(expect)
                local sizes = {
                    { 1600, 1000 }, { 390, 844 }, { 430, 932 }, { 360, 640 },
                    { 320, 568 }, { 768, 1024 }, { 1024, 768 }, { 834, 1194 },
                    { 844, 390 }, { 1280, 800 }, { 1920, 1080 }, { 2560, 1440 },
                    { 3440, 1440 },
                }
                for _, wh in ipairs(sizes) do
                    local g = LAYOUT.compute(wh[1], wh[2])
                    local leftEdge = LAYOUT.colX(g, 1) - g.cw / 2
                    local rightEdge = LAYOUT.colX(g, LAYOUT.COLS) + g.cw / 2
                    expect(leftEdge >= 0).is(true)
                    expect(rightEdge <= wh[1] + 0.001).is(true)
                    -- The top row sits below the top edge, the tableau below it.
                    expect(g.topY - g.ch / 2 > 0).is(true)
                    expect(g.tabY > g.topY + g.ch).is(true)
                end
            end)

            -- The chrome is anchored, not scaled. The wordmark and the
            -- readouts are a row along the foot: the readouts start where the
            -- wordmark ends, both sit inside the screen, and the deal button
            -- keeps the top right.
            test.case('the foot strip stays a row at every width', function(expect)
                local sizes = { { 320, 568 }, { 360, 640 }, { 390, 844 }, { 768, 1024 }, { 844, 390 }, { 1600, 1000 }, { 2560, 1440 } }
                for _, wh in ipairs(sizes) do
                    local g = LAYOUT.compute(wh[1], wh[2])
                    local tx, ty = LAYOUT.titleAt(g)
                    -- The wordmark is 230 wide and 56 tall at ui 1.
                    expect(tx + 230 * g.ui <= g.stats.x).is(true)
                    expect(ty + 56 * g.ui <= wh[2]).is(true)
                    expect(g.stats.y + g.stats.h <= wh[2]).is(true)
                    expect(g.stats.x + g.stats.w <= wh[1] + 0.001).is(true)
                    expect(g.button.x + g.button.w <= wh[1]).is(true)
                    -- The columns stop above the strip.
                    expect(g.tabY - g.ch / 2 + g.colSpan <= g.title.y + 0.001).is(true)
                end
            end)

            -- A column of nineteen used to walk straight off the bottom of
            -- the screen, on the desktop as much as anywhere. The squeeze is
            -- what stops it, and it must stop it at every size.
            test.case('the longest possible column stays on screen', function(expect)
                local sizes = { { 1600, 1000 }, { 390, 844 }, { 360, 640 }, { 768, 1024 }, { 844, 390 }, { 2560, 1440 } }
                for _, wh in ipairs(sizes) do
                    local g = LAYOUT.compute(wh[1], wh[2])
                    local up, down = LAYOUT.fanFor(g, 6, 13)
                    local extent = 6 * down + 12 * up + g.ch
                    expect(g.tabY - g.ch / 2 + extent <= wh[2] + 0.001).is(true)
                end
            end)

            -- And a column that FITS must not be squeezed: the fan is the
            -- layout's until the moment it cannot be.
            test.case('a short column keeps the full fan', function(expect)
                local g = LAYOUT.compute(1600, 1000)
                local up, down = LAYOUT.fanFor(g, 6, 1)
                expect(up).is(g.fanUp)
                expect(down).is(g.fanDown)
            end)

            -- THE DECK'S FAN HAS A CEILING AND IT IS NOT THE FOOT. The room
            -- above the stock is the strip between the window's top edge and
            -- the deck's, less the air `stockClear` keeps. The readouts sit
            -- at the foot and still overlap the deck's column — 836px below
            -- it on the desktop — and counting their bottom edge as the
            -- ceiling took the room to zero at every viewport, which is a fan
            -- that does not rise at all.
            test.case('the fan rises to the top edge, not to the foot', function(expect)
                for _, wh in ipairs({ { 1600, 1000 }, { 390, 844 }, { 844, 390 }, { 2560, 1440 } }) do
                    local g = LAYOUT.compute(wh[1], wh[2])
                    local sx = LAYOUT.colX(g, 1)
                    local topEdge = g.topY - g.ch / 2
                    -- A rise no slider would ask for, so the only thing left
                    -- to limit it is the geometry.
                    local room = LAYOUT.fanRoom(g, sx, 1e6, 8)
                    expect(room > 0).is(true)
                    -- Nothing at the foot may be what limits it: the ceiling
                    -- is the window's top edge, less the air it keeps.
                    expect(math.abs(room - (topEdge - 8 * g.fit)) < 1e-9).is(true)
                end
            end)

            -- The tuner's stockRise is the other cap, and it is in card px:
            -- the fan is card-shaped, so it rides `fit` like the rest of it.
            test.case('stockRise caps the fan in card px', function(expect)
                local g = LAYOUT.compute(1600, 1000)
                local sx = LAYOUT.colX(g, 1)
                expect(math.abs(LAYOUT.fanRoom(g, sx, 40, 0) - 40 * g.fit) < 1e-9).is(true)
                expect(LAYOUT.fanRoom(g, sx, 0, 0)).is(0)
                -- More clearance than there is room is no room, never less.
                expect(LAYOUT.fanRoom(g, sx, 300, 10000)).is(0)
            end)

            -- Chrome that DOES stand over the deck still stops it. The deal
            -- button keeps the top right, so a screen narrow enough to put it
            -- over column one has to take the fan down to nothing.
            test.case('chrome above the deck is still a ceiling', function(expect)
                local g = LAYOUT.compute(1600, 1000)
                local topEdge = g.topY - g.ch / 2
                local full = LAYOUT.fanRoom(g, LAYOUT.colX(g, 1), 300, 0)
                -- The button's own column: it reaches 74px down at ui 1, and
                -- the fan under it may only have what is left.
                local under = LAYOUT.fanRoom(g, g.button.x + g.button.w / 2, 300, 0)
                expect(under < full).is(true)
                expect(math.abs(under - (topEdge - (g.button.y + g.button.h))) < 1e-9).is(true)
            end)

            -- The two steps are one shape. Squeezing the face-up step alone
            -- would open the buried cards as the visible ones closed.
            test.case('the squeeze takes both steps together', function(expect)
                local g = LAYOUT.compute(360, 640)
                local up, down = LAYOUT.fanFor(g, 6, 13)
                expect(math.abs(up / down - g.fanUp / g.fanDown) < 1e-6).is(true)
            end)

            -- A card artboard is 120x168 whatever the screen is; `fit` is the
            -- only thing that carries it, and the tank window, the rim and
            -- the ink atlas all key off the same number.
            test.case('fit is the card over its artboard', function(expect)
                for _, wh in ipairs({ { 390, 844 }, { 768, 1024 }, { 1600, 1000 } }) do
                    local g = LAYOUT.compute(wh[1], wh[2])
                    expect(math.abs(g.fit - g.cw / LAYOUT.CARD_W) < 1e-9).is(true)
                    expect(math.abs(g.ch - g.cw * LAYOUT.CARD_H / LAYOUT.CARD_W) < 1e-9).is(true)
                end
            end)

            -- A degenerate size must still produce a usable table rather than
            -- a divide by zero: `resize` is called before the window has
            -- settled, and once with nothing at all.
            test.case('a zero viewport still computes', function(expect)
                local g = LAYOUT.compute(0, 0)
                expect(g.cw > 0).is(true)
                expect(g.ch > 0).is(true)
                expect(g.tuner.cols >= 1).is(true)
            end)
        end)

        -- THE PAD'S CURSOR (pad.luau). Everything here is pure -- a cursor is
        -- two integers and a step is a function of the game -- which is the
        -- whole reason the navigation lives in its own file rather than in
        -- table.luau's event handlers, where none of it could be reached
        -- without a window and a controller.
        test.group('pad cursor', function()
            -- A tiny fake with the shape the cursor walks: `pileAt` and
            -- `cursorOf` have to agree about all thirteen places, and the one
            -- hole in the grid has to stay a hole.
            local function pads(): K.Game
                return K.new(11)
            end

            test.case('every pile is reachable and names itself back', function(expect)
                local g = pads()
                for _, p in ipairs(K.piles(g)) do
                    local cur = PAD.cursorOf(p)
                    expect(PAD.pileAt(g, cur)).is(p)
                end
            end)

            test.case('the top row has a hole where the layout does', function(expect)
                local g = pads()
                -- Column 3 of the top row is the gap layout.luau leaves
                -- between the waste and the foundations.
                expect(PAD.pileAt(g, { row = PAD.TOP, col = 3 })).is(nil)
                expect(PAD.pileAt(g, { row = PAD.TABLEAU, col = 3 })).is(g.tableau[3])
            end)

            test.case('sideways skips the hole and wraps', function(expect)
                local g = pads()
                -- Waste (2) right is foundation one (4), not the gap.
                expect(PAD.right({ row = PAD.TOP, col = 2 }).col).is(4)
                expect(PAD.left({ row = PAD.TOP, col = 4 }).col).is(2)
                -- The last foundation wraps round to the deck.
                expect(PAD.right({ row = PAD.TOP, col = 7 }).col).is(1)
                expect(PAD.left({ row = PAD.TOP, col = 1 }).col).is(7)
                -- The tableau has no hole and wraps over all seven.
                expect(PAD.right({ row = PAD.TABLEAU, col = 7 }).col).is(1)
                expect(PAD.left({ row = PAD.TABLEAU, col = 1 }).col).is(7)
                local _ = g
            end)

            test.case('up from the middle column reaches for the waste', function(expect)
                -- Column 3 is equally near the waste (2) and the first
                -- foundation (4); the tie goes to the pile you take FROM.
                expect(PAD.nearestTop(3)).is(2)
                expect(PAD.nearestTop(1)).is(1)
                expect(PAD.nearestTop(5)).is(5)
                expect(PAD.up({ row = PAD.TOP, col = 1 })).is(nil)
                expect(PAD.down({ row = PAD.TABLEAU, col = 1 })).is(nil)
            end)

            test.case('the band is what a click could pick up', function(expect)
                local g = pads()
                -- The deck is never a source: you draw from it.
                local lo, hi = PAD.band(g.stock)
                expect(lo).is(0)
                expect(hi).is(0)
                -- A fresh column has one face-up card, at the bottom.
                lo, hi = PAD.band(g.tableau[5])
                expect(hi).is(5)
                expect(lo).is(5)
                -- An empty pile gives nothing.
                lo, hi = PAD.band(g.waste)
                expect(hi).is(0)
                -- And the band is exactly the indices runFrom accepts.
                local col = g.tableau[4]
                col.cards[3].faceUp = true
                col.cards[4].faceUp = true
                lo, hi = PAD.band(col)
                expect(lo).is(3)
                expect(hi).is(4)
                for k = 1, #col.cards do
                    expect(K.runFrom(col, k) ~= nil).is(k >= lo and k <= hi)
                end
            end)

            test.case('a face-down top card offers nothing', function(expect)
                -- Cannot happen in a legal deal, and the band must not hand
                -- out an index runFrom would refuse if it ever did.
                local col: K.Pile = { kind = 'tableau', index = 1, cards = {
                    { id = 1, suit = 1, rank = 5, faceUp = true },
                    { id = 2, suit = 3, rank = 4, faceUp = false },
                } }
                local lo, hi = PAD.band(col)
                expect(lo).is(0)
                expect(hi).is(0)
                expect(PAD.grabAt(col, 1)).is(0)
            end)

            test.case('up climbs the column before it leaves it', function(expect)
                local g = pads()
                local col = g.tableau[7]
                for k = 4, 7 do
                    col.cards[k].faceUp = true
                end
                local cur = { row = PAD.TABLEAU, col = 7 }
                -- Standing on the bottom card, up walks to 6, 5, 4...
                local r = PAD.vertical(g, cur, 7, -1, false)
                expect(r.left).is(false)
                expect(r.grab).is(6)
                r = PAD.vertical(g, cur, 5, -1, false)
                expect(r.left).is(false)
                expect(r.grab).is(4)
                -- ...and from the shallowest takeable card it steps off.
                r = PAD.vertical(g, cur, 4, -1, false)
                expect(r.left).is(true)
                expect(r.cursor.row).is(PAD.TOP)
            end)

            test.case('down stops at the bottom card', function(expect)
                local g = pads()
                local col = g.tableau[6]
                for k = 3, 6 do
                    col.cards[k].faceUp = true
                end
                local cur = { row = PAD.TABLEAU, col = 6 }
                local r = PAD.vertical(g, cur, 4, 1, false)
                expect(r.grab).is(5)
                expect(r.left).is(false)
                -- There is no third row, and a wrap here would fling the
                -- cursor to the deck in the middle of a climb.
                r = PAD.vertical(g, cur, 6, 1, false)
                expect(r.moved).is(false)
                expect(r.cursor.col).is(6)
            end)

            test.case('a run in hand turns the depth walk off', function(expect)
                local g = pads()
                local col = g.tableau[7]
                for k = 4, 7 do
                    col.cards[k].faceUp = true
                end
                local cur = { row = PAD.TABLEAU, col = 7 }
                -- The same press that climbed above leaves at once: with
                -- cards in hand the cursor is choosing a DESTINATION.
                local r = PAD.vertical(g, cur, 7, -1, true)
                expect(r.left).is(true)
                expect(r.cursor.row).is(PAD.TOP)
            end)

            test.case('arriving takes the bottom card', function(expect)
                local g = pads()
                for k = 2, 6 do
                    g.tableau[6].cards[k].faceUp = true
                end
                -- Sideways from a one-card column onto a six-card one: the
                -- grab is the foot of the new column, not the old height.
                local r = PAD.horizontal(g, { row = PAD.TABLEAU, col = 7 }, -1)
                expect(r.cursor.col).is(6)
                expect(r.grab).is(6)
                -- And down out of the top row does the same.
                r = PAD.vertical(g, { row = PAD.TOP, col = 6 }, 1, 1, false)
                expect(r.cursor.row).is(PAD.TABLEAU)
                expect(r.grab).is(6)
            end)

            test.case('the jumps offer only what the rules would take', function(expect)
                local g = pads()
                -- Every source the ring names has a play in K.plays, and the
                -- deck is never in it: drawing needs no pointing at.
                local live: { [string]: boolean } = {}
                for _, play in ipairs(K.plays(g)) do
                    live[`{play.from.kind}:{play.from.index}`] = true
                end
                for _, cur in ipairs(PAD.sources(g)) do
                    local p = PAD.pileAt(g, cur)
                    expect(p ~= nil).is(true)
                    expect((p :: K.Pile).kind == 'stock').is(false)
                    expect(live[`{(p :: K.Pile).kind}:{(p :: K.Pile).index}`]).is(true)
                end
                -- ...and every destination offered for a run is a play of
                -- that exact run.
                for _, cur in ipairs(PAD.sources(g)) do
                    local from = PAD.pileAt(g, cur) :: K.Pile
                    local _, hi = PAD.band(from)
                    for _, to in ipairs(PAD.destinations(g, from, hi)) do
                        local dest = PAD.pileAt(g, to) :: K.Pile
                        local ok = false
                        for _, play in ipairs(K.plays(g)) do
                            if play.from == from and play.index == hi and play.to == dest then
                                ok = true
                            end
                        end
                        expect(ok).is(true)
                    end
                end
            end)

            test.case('a ring with nothing in it moves nothing', function(expect)
                local cur = { row = PAD.TABLEAU, col = 3 }
                expect(PAD.nextIn({}, cur, 1)).is(nil)
                -- A cursor standing outside the ring enters it at the end
                -- the press is heading for.
                local ring = { { row = PAD.TABLEAU, col = 1 }, { row = PAD.TABLEAU, col = 5 } }
                expect((PAD.nextIn(ring, cur, 1) :: PAD.Cursor).col).is(1)
                expect((PAD.nextIn(ring, cur, -1) :: PAD.Cursor).col).is(5)
                -- ...and inside it, it steps and wraps.
                expect((PAD.nextIn(ring, ring[2], 1) :: PAD.Cursor).col).is(1)
            end)

            test.case('a card names its own place', function(expect)
                local g = pads()
                local want = g.tableau[4].cards[4]
                local cur, grab = PAD.find(g, want.id)
                expect(cur ~= nil).is(true)
                expect((cur :: PAD.Cursor).row).is(PAD.TABLEAU)
                expect((cur :: PAD.Cursor).col).is(4)
                expect(grab).is(4)
                -- Bound first: `find` returns two, and passing it bare would
                -- hand `expect` an index as a second argument.
                local none = PAD.find(g, 999)
                expect(none).is(nil)
            end)
        end)

        -- READING THE DEVICE. A pad event carries the whole state rather than
        -- the one field that changed, so the edges are a diff -- and the two
        -- ways that goes wrong (a press fired twice, a press fired for a
        -- button that was already down when the pad was plugged in) are both
        -- invisible without a controller in hand.
        test.group('pad device', function()
            local function ev(fields: { [string]: any }): any
                local e: { [string]: any } = {
                    south = false, east = false, north = false, west = false,
                    leftShoulder = false, rightShoulder = false,
                    start = false, back = false,
                    dpadUp = false, dpadDown = false, dpadLeft = false, dpadRight = false,
                    leftStick = { x = 0, y = 0 },
                }
                for k, v in pairs(fields) do
                    e[k] = v
                end
                return e
            end

            test.case('a press fires once, and the release fires nothing', function(expect)
                local st = PAD.newState()
                local down = PAD.read(st, ev({ south = true }), 0.45)
                expect(#down).is(1)
                expect(down[1]).is('south')
                -- Held: the same state arrives again and must not re-fire.
                expect(#PAD.read(st, ev({ south = true }), 0.45)).is(0)
                expect(#PAD.read(st, ev({}), 0.45)).is(0)
                -- ...and it can be pressed again.
                expect(#PAD.read(st, ev({ south = true }), 0.45)).is(1)
            end)

            test.case('a pad plugged in mid-press does not fire it', function(expect)
                -- `gamepadConnected` comes through the same door, and its
                -- event is the full state too. Recorded, not acted on.
                local st = PAD.newState()
                expect(#PAD.read(st, ev({ start = true, south = true }), 0.45)).is(2)
                local fresh = PAD.newState()
                fresh.state = { start = true, south = true }
                expect(#PAD.read(fresh, ev({ start = true, south = true }), 0.45)).is(0)
            end)

            test.case('several buttons in one event fire in a fixed order', function(expect)
                local st = PAD.newState()
                local down = PAD.read(st, ev({ back = true, south = true, north = true }), 0.45)
                expect(down[1]).is('south')
                expect(down[2]).is('north')
                expect(down[3]).is('back')
            end)

            test.case('the d-pad beats a resting stick', function(expect)
                local st = PAD.newState()
                PAD.read(st, ev({ dpadLeft = true, leftStick = { x = 0.9, y = 0 } }), 0.45)
                expect(st.x).is(-1)
                expect(st.y).is(0)
            end)

            test.case('a stick inside the deadzone says nothing', function(expect)
                local st = PAD.newState()
                PAD.read(st, ev({ leftStick = { x = 0.44, y = -0.3 } }), 0.45)
                expect(st.x).is(0)
                expect(st.y).is(0)
                PAD.read(st, ev({ leftStick = { x = 0.46, y = 0 } }), 0.45)
                expect(st.x).is(1)
            end)

            test.case('up is negative y, as W3C has it', function(expect)
                local st = PAD.newState()
                PAD.read(st, ev({ leftStick = { x = 0, y = -0.9 } }), 0.45)
                expect(st.y).is(-1)
                PAD.read(st, ev({ dpadUp = true }), 0.45)
                expect(st.y).is(-1)
                PAD.read(st, ev({ dpadDown = true }), 0.45)
                expect(st.y).is(1)
            end)

            test.case('a diagonal stick picks one axis', function(expect)
                -- Both rails crossed at once would step sideways AND out of
                -- the column on the same tick, which reads as a jumped slot.
                local st = PAD.newState()
                PAD.read(st, ev({ leftStick = { x = 0.8, y = -0.6 } }), 0.45)
                expect(st.x).is(1)
                expect(st.y).is(0)
                PAD.read(st, ev({ leftStick = { x = 0.5, y = -0.9 } }), 0.45)
                expect(st.x).is(0)
                expect(st.y).is(-1)
                -- The d-pad is exempt: two of its buttons at once is a
                -- deliberate diagonal.
                PAD.read(st, ev({ dpadRight = true, dpadUp = true }), 0.45)
                expect(st.x).is(1)
                expect(st.y).is(-1)
            end)

            test.case('an unknown mapping reports nothing rather than guessing', function(expect)
                -- The named fields are all false when the embedder could not
                -- normalise the device, and false is what this has to mean.
                local st = PAD.newState()
                expect(#PAD.read(st, ev({}), 0.45)).is(0)
                expect(st.x).is(0)
                expect(st.y).is(0)
            end)

            test.case('a pad with no stick at all is still readable', function(expect)
                local st = PAD.newState()
                PAD.read(st, ev({ leftStick = nil, dpadRight = true }), 0.45)
                expect(st.x).is(1)
            end)
        end)

        test.group('winning', function()
            test.case('four full foundations win', function(expect)
                local g = K.new(3)
                expect(K.isWon(g)).is(false)
                for s = 1, 4 do
                    g.foundations[s].cards = {}
                    for r = 1, 13 do
                        table.insert(g.foundations[s].cards, { id = (s - 1) * 13 + r, suit = s, rank = r, faceUp = true })
                    end
                end
                expect(K.isWon(g)).is(true)
            end)
        end)
    end
end
