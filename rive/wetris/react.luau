-- ============================================================================
-- THE REACTIONS — what the seal does with its body when a card play lands.
--
-- A valid play is the one good thing the hand does, and the animal answers
-- it: it swims to the STAGE (the open water under the columns, table.luau
-- measures it each frame) and performs one of these, a different one each
-- time. Pure: `pose(variant, t)` is the whole choreography as a function of
-- seconds since the reaction began — deltas the puppet adds on top of its
-- blended pose, never a replacement — and the puppet owns the clock.
--
--   spin     a full turn about the screen's normal (heading), with a gather
--   barrel   a full roll about the spine, rising a little at the top
--   flip     a somersault toward the viewer (pitch), the body lifting through it
--   clap     the flippers raised over the back and brought together, three
--            times, on a little lift
--   bark     the file's own clip, a slice of it
--   roll     the file's own roll clip
--   ball     the file's own ball clip
--
-- THE ROTATIONS ARE NOT ENVELOPED. A spin eases to a whole turn, which IS
-- the identity, so the pose blends out by arriving; an enveloped rotation
-- would visibly unwind the turn it just made (systems/sealFlip.js has the
-- argument). Every variant ends where it began, and tests.luau holds it to
-- that: at `duration` every delta is 0 mod a turn and every weight is 0.
--
-- The CLIP variants play a WINDOW of the baked clip (tools/sealitaire-mesh.mjs
-- bakes bark, roll and ball beside the swim set) at weight 1 between a fade
-- in and a fade out; the puppet feeds `clipT` straight to the sampler.
-- ============================================================================

export type Pose = {
    heading: number,      -- radians added to the body's heading
    roll: number,         -- radians added to the roll about the spine
    pitch: number,        -- radians of somersault toward the viewer
    lift: number,         -- 0..1 toward the viewer (scale up), added to the puppet's own
    clap: number,         -- 0..1 the flippers raised and together
    clip: string?,        -- a baked clip to weight in, or nil
    clipW: number,        -- its weight
    clipT: number,        -- where in the clip, seconds
}

export type Variant = { name: string, duration: number, clip: string?, clipFrom: number?, clipLen: number? }

local VARIANTS: { Variant } = {
    { name = 'spin', duration = 1.35 },
    { name = 'barrel', duration = 1.2 },
    { name = 'flip', duration = 1.3 },
    { name = 'clap', duration = 1.4 },
    { name = 'bark', duration = 2.2, clip = 'bark', clipFrom = 0.0, clipLen = 1.9 },
    { name = 'roll', duration = 3.0, clip = 'roll', clipFrom = 0.0, clipLen = 2.7 },
    { name = 'ball', duration = 2.6, clip = 'ball', clipFrom = 0.0, clipLen = 2.3 },
}
local CLIPS = { 'bark', 'roll', 'ball' }

local M = { VARIANTS = VARIANTS, CLIPS = CLIPS }

local TAU = math.pi * 2

function M.variant(name: string): Variant?
    for _, v in ipairs(VARIANTS) do
        if v.name == name then
            return v
        end
    end
    return nil
end

-- The next reaction: any but the last one, from `rnd` in [0, 1).
function M.pick(last: string, rnd: number): string
    local pool = {}
    for _, v in ipairs(VARIANTS) do
        if v.name ~= last then
            table.insert(pool, v.name)
        end
    end
    local i = math.min(#pool, math.floor(math.max(0, math.min(0.999999, rnd)) * #pool) + 1)
    return pool[i]
end

local function inOutCubic(u: number): number
    u = math.max(0, math.min(1, u))
    if u < 0.5 then
        return 4 * u * u * u
    end
    local v = -2 * u + 2
    return 1 - v * v * v / 2
end

-- A one-shot bump: 0 at both ends, 1 at its peak, sine shaped.
local function bump(t: number, from: number, to: number): number
    if t <= from or t >= to then
        return 0
    end
    return math.sin((t - from) / (to - from) * math.pi)
end

-- A whole turn between `from` and `to`, eased, with a short gather before
-- it: the body counter-rotates by `gather` and springs through the turn.
local function turn(t: number, from: number, to: number, gather: number): number
    if t <= from then
        -- the gather, eased in
        local g0 = from - 0.22
        if t <= g0 then
            return 0
        end
        return -gather * inOutCubic((t - g0) / (from - g0))
    end
    if t >= to then
        return 0 -- TAU is the identity: arrive there and read as 0
    end
    local u = inOutCubic((t - from) / (to - from))
    return -gather + (TAU + gather) * u
end

function M.pose(name: string, t: number): Pose
    local p: Pose = { heading = 0, roll = 0, pitch = 0, lift = 0, clap = 0, clip = nil, clipW = 0, clipT = 0 }
    local v = M.variant(name)
    if v == nil or t < 0 or t >= v.duration then
        return p
    end
    if name == 'spin' then
        p.heading = turn(t, 0.28, 1.2, 0.35)
        p.lift = 0.25 * bump(t, 0.25, 1.25)
    elseif name == 'barrel' then
        p.roll = turn(t, 0.22, 1.1, 0.25)
        p.lift = 0.35 * bump(t, 0.2, 1.15)
    elseif name == 'flip' then
        p.pitch = turn(t, 0.26, 1.2, 0.3)
        p.lift = 0.6 * bump(t, 0.2, 1.25)
    elseif name == 'clap' then
        -- Three claps: raise, then three quick closes, then down.
        local raise = inOutCubic(t / 0.3) * (1 - inOutCubic((t - 1.1) / 0.3))
        local closes = 0
        for k = 0, 2 do
            local c0 = 0.35 + k * 0.25
            closes = math.max(closes, bump(t, c0, c0 + 0.22))
        end
        p.clap = raise * (0.55 + 0.45 * closes)
        p.lift = 0.3 * bump(t, 0.1, 1.35)
        p.heading = 0.12 * math.sin(t * 9) * raise
    elseif v.clip ~= nil then
        local from, len = v.clipFrom or 0, v.clipLen or v.duration
        local fadeIn, fadeOut = 0.18, 0.3
        local w = math.min(1, t / fadeIn) * math.min(1, math.max(0, (v.duration - t) / fadeOut))
        p.clip = v.clip
        p.clipW = math.max(0, math.min(1, w))
        p.clipT = from + math.min(len, t)
    end
    return p
end

-- THE DEAL SWIPE — the flipper's flick across the deck as a card is drawn, as
-- a multiplier on a bearing: -1 is a wind-up to one side, +1 the far side of
-- the sweep, 0 the flipper back where the aim had it. `u` is 0..1 through the
-- gesture.
--
-- Three beats, because two do not read as a swipe. Straight from neutral to
-- the far side is a drift; it is the WIND-UP that makes the sweep look like it
-- was aimed, and the return that stops it looking like the fin simply ended up
-- over there. The wind-up is slow-ish, the sweep is the fast part, and the
-- return is softest of the three so the flipper settles rather than snaps.
--
-- Pure and here rather than in table.luau because it is choreography, the same
-- as everything else in this file, and because a curve that has to hit -1, +1
-- and 0 at the right moments is worth a test.
function M.swipe(u: number): number
    if u <= 0 or u >= 1 then
        return 0
    end
    local WIND, SWEEP = 0.28, 0.66   -- ends of the wind-up and of the sweep
    if u < WIND then
        return -inOutCubic(u / WIND)
    elseif u < SWEEP then
        return -1 + 2 * inOutCubic((u - WIND) / (SWEEP - WIND))
    end
    return 1 - inOutCubic((u - SWEEP) / (1 - SWEEP))
end

return M
