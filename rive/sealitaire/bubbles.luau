-- ============================================================================
-- THE SEAL'S BUBBLES — what the animal sheds into the water.
--
-- Three things feed one pool:
--
--   BREATH   a slow trickle from the mouth and the nose, always. It is what
--            tells you the seal is alive when it is doing nothing at all.
--   SHED     the whole body, whenever a part of it is moving fast. Every
--            source sheds at a rate set by ITS OWN speed, so a lazy cruise
--            trails a few off the flipper tips and a somersault throws them
--            off everything at once. Nothing decides "this is a big move" —
--            the bigness is the speed, and the speed is measured.
--   BURST    a puff on a moment: a play landing, a reaction starting.
--
-- Pure, like klondike.luau and react.luau: no drawing, no bones, no GPU. It is
-- handed SOURCES — a point, a velocity and a radius, in SCREEN px — and it
-- keeps a pool of puffs. table.luau measures the sources off the posed
-- skeleton and draws the result.
--
-- `Puff` here is NOT table.luau's `Bubble`. Those are the ambient column that
-- rises from below the frame for the whole scene and recycles forever; these
-- are born on the animal, live a life and die.
-- ============================================================================

local M = {}

-- A point on the seal that can shed, in screen px: where it is, how it is
-- moving, and how big a patch of body it stands for (a puff spawns somewhere
-- inside `r`, so a flipper sheds off its whole blade and not off one dot).
export type Source = { x: number, y: number, vx: number, vy: number, r: number }

export type Puff = {
    x: number, y: number,
    vx: number, vy: number,
    r: number,              -- radius, in the same units the ambient bubbles use
    age: number, life: number,
    phase: number, wob: number,
}

-- How a puff is born and how it behaves once it is. One of these per channel,
-- so breath can be small and slow while a shed off a flipper is bigger and
-- keeps more of the speed that threw it.
type Spec = {
    size: number, sizeVary: number,   -- radius, and the fraction it varies by
    life: number, lifeVary: number,   -- seconds
    rise: number,                     -- px/s a unit-radius puff settles to, upward
    drag: number,                     -- per second: how fast it forgets the speed it was thrown with
    wobble: number,                   -- px/s of side-to-side weave
    grow: number,                     -- fraction of radius gained over a whole life
    inherit: number,                  -- share of the source's velocity it leaves with
    spread: number,                   -- x the source radius: how far off the source it may be born
}

export type System = {
    puffs: { Puff },
    n: number,              -- how many of `puffs` are alive; the rest are spare
    cap: number,
    debt: { number },       -- fractional emission carried between frames, per channel
    weights: { number },    -- scratch for the shed's per-source rates
    rand: () -> number,
}

M.BREATH = 1
M.SHED = 2

-- A seeded generator, so a test can replay a run exactly. The same LCG
-- klondike deals with; math.random is per-VM and would make this unrepeatable.
local function lcg(seed: number): () -> number
    local state = seed % 2147483647
    if state <= 0 then
        state += 2147483646
    end
    return function(): number
        state = (state * 48271) % 2147483647
        return state / 2147483647
    end
end

function M.new(cap: number, seed: number): System
    local sys: System = {
        puffs = {},
        n = 0,
        cap = math.max(1, math.floor(cap)),
        debt = { 0, 0 },
        weights = {},
        rand = lcg(seed),
    }
    -- The pool is built once and never grows: a puff that dies is swapped to
    -- the end and reused, so a somersault cannot allocate its way through a
    -- frame.
    for i = 1, sys.cap do
        sys.puffs[i] = { x = 0, y = 0, vx = 0, vy = 0, r = 1, age = 0, life = 1, phase = 0, wob = 1 }
    end
    return sys
end

function M.clear(sys: System)
    sys.n = 0
    sys.debt[M.BREATH] = 0
    sys.debt[M.SHED] = 0
end

-- One puff, at a point, carrying some of whatever threw it. Silently does
-- nothing when the pool is full — a dropped bubble in a storm of them is not
-- worth a branch anywhere else.
function M.spawn(sys: System, x: number, y: number, vx: number, vy: number, spread: number, spec: Spec)
    if sys.n >= sys.cap then
        return
    end
    local rnd = sys.rand
    sys.n += 1
    local q = sys.puffs[sys.n]
    -- Inside a disc, not a square: a square patch of spawns reads as a square.
    local a = rnd() * math.pi * 2
    local d = math.sqrt(rnd()) * spread
    q.x, q.y = x + math.cos(a) * d, y + math.sin(a) * d
    q.vx, q.vy = vx * spec.inherit, vy * spec.inherit
    q.r = spec.size * (1 + (rnd() * 2 - 1) * spec.sizeVary)
    q.age = 0
    q.life = spec.life * (1 + (rnd() * 2 - 1) * spec.lifeVary)
    q.phase = rnd() * math.pi * 2
    q.wob = 0.6 + rnd() * 0.8
end

-- Turn a rate in bubbles per second into whole bubbles, carrying the fraction
-- over to the next frame. Without the carry a rate under one per frame rounds
-- to nothing and the breath never starts.
local function due(sys: System, channel: number, rate: number, dt: number): number
    local debt = sys.debt[channel] + math.max(0, rate) * dt
    local n = math.floor(debt)
    sys.debt[channel] = debt - n
    return n
end

-- BREATH: a steady trickle from a point that moves with the head.
function M.breathe(sys: System, dt: number, x: number, y: number, vx: number, vy: number, rate: number, spec: Spec)
    for _ = 1, due(sys, M.BREATH, rate, dt) do
        M.spawn(sys, x, y, vx, vy, spec.spread, spec)
    end
end

-- BURST: a puff on a moment, thrown outward from a point.
function M.burst(sys: System, count: number, x: number, y: number, spread: number, throw: number, spec: Spec)
    local rnd = sys.rand
    for _ = 1, math.floor(count) do
        local a = rnd() * math.pi * 2
        local s = throw * (0.4 + rnd() * 0.6)
        -- Thrown velocity goes in RAW: `inherit` is about how much of a
        -- swimming body a bubble keeps, which is a different question from how
        -- hard a burst throws.
        M.spawn(sys, x, y, math.cos(a) * s / math.max(1e-4, spec.inherit), math.sin(a) * s / math.max(1e-4, spec.inherit), spread, spec)
    end
end

type ShedCfg = {
    threshold: number,   -- px/s a part must beat before it sheds at all
    ref: number,         -- px/s over the threshold that counts as FLAT OUT
    perSpeed: number,    -- bubbles/s a source sheds at `ref`
    power: number,       -- above 1, the fastest parts take a sharper share
    maxRate: number,     -- bubbles/s, the whole body: a ceiling on a somersault
}

-- SHED: the body. Every source sheds at a rate its own speed decides, the sum
-- is the frame's budget, and each bubble picks the source it comes off in
-- proportion to that same rate.
--
-- Weighting the PICK rather than giving each source its own accumulator is the
-- same thing in the long run and much less state, but it matters that the
-- weights are rates and not speeds: `power` above 1 is what makes a flipper tip
-- at twice the speed of the belly shed far more than twice as much, which is
-- the whole read of "the fastest parts do the most".
--
-- Returns the rate it ran at, which is what a test asserts on.
function M.shed(sys: System, dt: number, sources: { Source }, cfg: ShedCfg, spec: Spec): number
    local w = sys.weights
    local total = 0
    local count = #sources
    for i = 1, count do
        local s = sources[i]
        local over = math.sqrt(s.vx * s.vx + s.vy * s.vy) - cfg.threshold
        -- Measured against `ref` rather than in raw px/s, so `perSpeed` is a
        -- number with a meaning — bubbles a second off one part of the seal
        -- going flat out — instead of a coefficient that has to be retuned
        -- every time `power` or the screen size moves.
        local rate = if over > 0 then cfg.perSpeed * (over / math.max(1e-4, cfg.ref)) ^ cfg.power else 0
        w[i] = rate
        total += rate
    end
    if total <= 0 then
        -- Nothing is moving: drop the carry so a long still spell does not bank
        -- a fraction and fire it at the first twitch.
        sys.debt[M.SHED] = 0
        return 0
    end
    -- The ceiling scales the whole body down together, so which parts are
    -- shedding most stays true however hard it is clamped.
    local scale = if total > cfg.maxRate then cfg.maxRate / total else 1
    local n = due(sys, M.SHED, total * scale, dt)
    local rnd = sys.rand
    for _ = 1, n do
        local pick = rnd() * total
        local acc = 0
        local hit = count
        for i = 1, count do
            acc += w[i]
            if pick <= acc then
                hit = i
                break
            end
        end
        local s = sources[hit]
        M.spawn(sys, s.x, s.y, s.vx, s.vy, s.r * spec.spread, spec)
    end
    return total * scale
end

-- The pool, a frame on. Dead puffs are swapped to the end and become spare;
-- `drift` is the water's own sideways push (the scene's energy, in px/s).
function M.update(sys: System, dt: number, spec: Spec, drift: number, time: number)
    local i = 1
    while i <= sys.n do
        local q = sys.puffs[i]
        q.age += dt
        if q.age >= q.life then
            -- Swap-remove: the dead one goes to the live end and the count
            -- drops, so it is spare again and the loop does not skip its
            -- replacement (i is deliberately not advanced).
            sys.puffs[i] = sys.puffs[sys.n]
            sys.puffs[sys.n] = q
            sys.n -= 1
        else
            -- One first-order settle does both jobs: it forgets the speed the
            -- body threw it with and it arrives at a rise speed, rather than
            -- accelerating upward forever. Bigger bubbles rise faster, which is
            -- what separates a shed off a flipper from a breath.
            local k = 1 - math.exp(-spec.drag * dt)
            q.vx += (0 - q.vx) * k
            q.vy += (-spec.rise * q.r - q.vy) * k
            q.x += (q.vx + drift + math.sin(time * 1.6 * q.wob + q.phase) * spec.wobble) * dt
            q.y += q.vy * dt
            i += 1
        end
    end
end

-- ---------------------------------------------------------------------------
-- A whole frame, in one call
-- ---------------------------------------------------------------------------
-- table.luau measures the SOURCES off the posed skeleton — that needs bones and
-- a model matrix and cannot live here — and everything after that does. So the
-- specs, the three channels and the step are all behind this one entry point,
-- fed a flat record of numbers straight off the sliders.
--
-- It is one call rather than five, and it reads the LIVE SLIDER TABLE rather
-- than a record of its own, for a reason beyond tidiness: table.luau sits on
-- Luau's type-inference budget and this module's types are instantiated into it
-- by the require. A 25-field Frame record was on its own enough to stop the
-- whole project typechecking, so the seam here is deliberately thin — an
-- indexer, three exported types, and everything else kept internal. Think twice
-- before exporting another one.
--
-- The keys it reads out of `tune` (tuning.luau's `fins`-style rows, cat
-- `breath`): breathRate breathSize shedThreshold shedRef shedRate shedPower
-- shedMax shedSize puffRise puffLife puffDrag puffWobble.

-- Rebuilt in place each frame rather than allocated: the pool exists so a
-- somersault does not allocate, and it would be a poor showing to hand it three
-- fresh tables a frame on the way in.
local breathSpec: Spec = {
    size = 2.5, sizeVary = 0.35, life = 2.2, lifeVary = 0.3,
    rise = 30, drag = 2.2, wobble = 9, grow = 0.3, inherit = 0.35, spread = 2.5,
}
local shedSpec: Spec = {
    size = 3.4, sizeVary = 0.45, life = 1.7, lifeVary = 0.35,
    rise = 30, drag = 2.2, wobble = 9, grow = 0.3, inherit = 0.3, spread = 1,
}
local shedCfg: ShedCfg = { threshold = 0, ref = 1, perSpeed = 0, power = 1, maxRate = 0 }

-- The physics both channels share. `rise` is scaled by a bubble's own radius in
-- update, so a fat one shed off a flipper climbs away from a thin one off the
-- nose without a second set of numbers to keep in step.
-- `mouth` and `nose` are screen px; `headV*` is what the head is doing, px/s;
-- `bodyLen` is the seal on screen, which is what a threshold in body lengths a
-- second is measured against; `fit` is the card scale that carries a size or a
-- speed in px onto this screen; `burst` is bubbles to throw from the mouth this
-- frame, 0 for none.
function M.frame(
    sys: System,
    sources: { Source },
    tune: { [string]: number },
    dt: number, time: number, fit: number, bodyLen: number,
    mouthX: number, mouthY: number, noseX: number, noseY: number,
    headVX: number, headVY: number, breathRate: number, burst: number,
    drift: number
)
    -- The physics both channels share. `rise` is scaled by a bubble's own
    -- radius in update, so a fat one shed off a flipper climbs away from a thin
    -- one off the nose without a second set of numbers to keep in step.
    breathSpec.rise = tune.puffRise * fit
    breathSpec.drag = tune.puffDrag
    breathSpec.wobble = tune.puffWobble * fit
    shedSpec.rise = breathSpec.rise
    shedSpec.drag = breathSpec.drag
    shedSpec.wobble = breathSpec.wobble

    breathSpec.size = tune.breathSize
    breathSpec.life = tune.puffLife
    shedSpec.size = tune.shedSize
    shedSpec.life = tune.puffLife * 0.8

    shedCfg.threshold = tune.shedThreshold * bodyLen
    shedCfg.ref = tune.shedRef * bodyLen
    shedCfg.perSpeed = tune.shedRate
    shedCfg.power = tune.shedPower
    shedCfg.maxRate = tune.shedMax
    M.shed(sys, dt, sources, shedCfg, shedSpec)

    -- Half the rate at each point. They share one accumulator, so which of the
    -- two crosses the next whole bubble alternates on its own and neither has
    -- to carry a fraction of its own.
    M.breathe(sys, dt, mouthX, mouthY, headVX, headVY, breathRate * 0.5, breathSpec)
    M.breathe(sys, dt, noseX, noseY, headVX, headVY, breathRate * 0.5, breathSpec)

    if burst > 0 then
        M.burst(sys, burst, mouthX, mouthY, bodyLen * 0.06, bodyLen * 0.7, breathSpec)
    end

    M.update(sys, dt, breathSpec, drift, time)
end

-- The spec a live puff is drawn with. One physics for the pool, so this is the
-- one the caller wants for M.radius.
function M.drawSpec(): Spec
    return breathSpec
end

-- A puff's radius now: bubbles swell as they rise and the pressure drops.
function M.radius(q: Puff, spec: Spec): number
    return q.r * (1 + spec.grow * (q.age / q.life))
end

-- 0..1. Up fast so a bubble does not appear to grow out of nothing, down over
-- the last third, which is the whole of dying — there is no pop.
function M.alpha(q: Puff): number
    local t = q.age / q.life
    local inF = math.min(1, q.age / 0.09)
    local outF = if t > 0.7 then (1 - t) / 0.3 else 1
    return inF * outF
end

return M
