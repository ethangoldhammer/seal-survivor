-- ============================================================================
-- THE CASCADE — the win, in the shape Windows Solitaire taught everybody: the
-- foundations empty themselves down the screen, a card at a time, each one
-- thrown sideways, falling under gravity and BOUNCING off the bottom until it
-- walks off the edge. Pure, so `tests.luau` can hold the physics and the
-- table can tune it live.
--
-- WHAT MAKES IT READ AS THE ORIGINAL, and each of these is a thing that looks
-- wrong when it is missing:
--
--   ONE AT A TIME, from the four piles in turn, top card first. All 52 at
--   once is a curtain, not a cascade; the stagger (`gap`) is the whole rhythm
--   of it, and taking them pile by pile is what keeps the four columns
--   feeding evenly instead of one emptying while the others sit.
--
--   IT BOUNCES, IT DOES NOT LAND. `bounce` is the fraction of the downward
--   speed kept on each hit, and the arcs it makes are the picture. Below
--   about 0.5 the card dies where it lands and the screen fills with a heap.
--
--   THE THROW IS SIDEWAYS AND ALTERNATES. Every card leaves with the same
--   horizontal speed and only the SIGN changes (`h1`), so the cascade opens
--   both ways off each pile rather than drifting the same way every time.
--   The speed never changes after launch — nothing slows a card down — which
--   is why the arcs stay even all the way across.
--
--   IT IS DETERMINISTIC. Every number a card needs comes from its own index
--   through `hash`, not from math.random: the same trigger gives the same
--   cascade twice, which is the difference between tuning a look and chasing
--   one. `npm run sealitaire` with the C key re-runs it as often as you like.
--
-- Screen space, y DOWN, px and seconds. The table owns the clock and the
-- geometry; this owns where each card is.
-- ============================================================================

export type Card = {
    id: number,
    x: number, y: number,
    vx: number, vy: number,
    spin: number,          -- radians, its own tumble
    live: boolean,         -- launched and still on screen
    gone: boolean,         -- walked off the edge; nothing more to do
    rest: boolean,         -- settled on the floor: sliding off, done bouncing
    bounces: number,
}

export type Hit = { x: number, y: number, speed: number }

export type Inputs = {
    w: number, h: number,        -- the screen
    cw: number, ch: number,      -- a card
    fit: number,                 -- px per artboard px: every speed scales by it
    -- tunables
    gravity: number,             -- px/s^2 at fit 1
    launch: number,              -- px/s sideways at the throw
    lift: number,                -- px/s upward at the throw
    bounce: number,              -- 0..1 of the downward speed kept on a hit
    gap: number,                 -- seconds between one card leaving and the next
    spin: number,                -- radians/s of tumble at full launch speed
    floor: number,               -- px above the bottom edge the cards bounce on
    restSpeed: number,           -- px/s below which a bounce is not worth having
}

export type State = {
    t: number,                   -- seconds since the cascade began
    cards: { Card },             -- by slot, in launch order
    next: number,                -- the next slot to launch
    hits: { Hit },               -- bounces THIS frame; the caller drains them
}

local M = {}

-- The launch order: the four foundations in turn, each from its TOP card
-- down. `piles` is four lists of card ids, ace at the bottom as they sit on
-- the table, so each pile is walked backwards and the four are interleaved.
function M.order(piles: { { number } }): { { pile: number, id: number } }
    local out: { { pile: number, id: number } } = {}
    local at: { number } = {}
    for i, p in ipairs(piles) do
        at[i] = #p
    end
    local left = true
    while left do
        left = false
        for i, p in ipairs(piles) do
            local k = at[i]
            if k >= 1 then
                table.insert(out, { pile = i, id = p[k] })
                at[i] = k - 1
                left = true
            end
        end
    end
    return out
end

local function hash(n: number): number
    local x = math.sin(n * 12.9898 + 78.233) * 43758.5453
    return x - math.floor(x)
end

-- `from` is where each card starts: the foundation slot it is leaving, in px.
function M.new(order: { { pile: number, id: number } }, from: { { x: number, y: number } }): State
    local cards: { Card } = {}
    for i, o in ipairs(order) do
        local p = from[o.pile] or { x = 0, y = 0 }
        table.insert(cards, {
            id = o.id, x = p.x, y = p.y, vx = 0, vy = 0, spin = 0,
            live = false, gone = false, rest = false, bounces = 0,
        })
    end
    return { t = 0, cards = cards, next = 1, hits = {} }
end

function M.done(s: State): boolean
    if s.next <= #s.cards then
        return false
    end
    for _, c in ipairs(s.cards) do
        if c.live then
            return false
        end
    end
    return true
end

function M.update(s: State, dt: number, inp: Inputs)
    table.clear(s.hits)
    s.t += dt
    -- Launch whatever is due. A frame long enough to owe two cards launches
    -- two: the rhythm is the CLOCK's, not the frame rate's, so a stutter
    -- cannot silently stretch the cascade.
    local gap = math.max(0.01, inp.gap)
    while s.next <= #s.cards and s.t >= (s.next - 1) * gap do
        local c = s.cards[s.next]
        local side = if hash(c.id * 7.3 + s.next) < 0.5 then -1 else 1
        -- A little variation either side of the throw, from the card's own
        -- hash: dead-equal arcs read as a machine rather than a spill.
        local vary = 0.75 + 0.5 * hash(c.id * 3.1)
        c.vx = side * inp.launch * vary * inp.fit
        c.vy = -inp.lift * (0.8 + 0.4 * hash(c.id * 5.7)) * inp.fit
        c.live = true
        s.next += 1
    end
    local floorY = inp.h - inp.floor * inp.fit - inp.ch * 0.5
    local offX = inp.cw
    for _, c in ipairs(s.cards) do
        if not c.live then
            continue
        end
        -- A RESTING card has no gravity to answer to. Without that it falls
        -- a frame's worth, trips the floor, is clamped back and counts
        -- another bounce — sixty a second, for as long as it takes to slide
        -- off. It read as settled and reported 242 bounces.
        if not c.rest then
            c.vy += inp.gravity * inp.fit * dt
        end
        c.x += c.vx * dt
        c.y += c.vy * dt
        c.spin += inp.spin * (c.vx / math.max(1, inp.launch * inp.fit)) * dt
        if c.rest then
            c.y = floorY
        elseif c.y >= floorY and c.vy > 0 then
            c.y = floorY
            local hitSpeed = c.vy
            c.vy = -c.vy * math.clamp(inp.bounce, 0, 0.99)
            c.bounces += 1
            -- A bounce with nothing left in it is a card SITTING on the floor
            -- sliding along, which is not what any of this is for: it keeps
            -- its sideways speed and simply stops bouncing.
            if math.abs(c.vy) < inp.restSpeed * inp.fit then
                c.vy = 0
                c.rest = true
            else
                table.insert(s.hits, { x = c.x, y = c.y, speed = hitSpeed })
            end
        end
        if c.x < -offX or c.x > inp.w + offX then
            c.live = false
            c.gone = true
        end
    end
end

return M
