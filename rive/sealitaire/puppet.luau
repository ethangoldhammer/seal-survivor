-- ============================================================================
-- THE PUPPET — the level-up seal's motion, ported from
-- path/src/systems/levelUpSeal.js + levelUpSealMotion.js + animation.js.
--
-- Three things, in the order the game runs them:
--
--   1. THE BLENDER   every state in motion.luau is always evaluated and the
--                    output is their WEIGHTED SUM; the wanted state ramps to
--                    weight 1 over `blendTime` along `inOutCubic` (the game's
--                    CONFIG.levelUpSeal.motion), the rest ramp to 0. There is
--                    nothing to snap: a hover mid-blend re-aims the ramps.
--   2. THE PULL      the run's own physics carry the body to the blended
--                    landing point — CONFIG.player thrust / friction /
--                    maxSpeed / turnLerp in world units through px-per-unit,
--                    braking to stop ON the point (brake = sqrt(2 a d), an
--                    `arrive` ease band on top), steering in a banking arc
--                    while the point is far, straight push once close. The
--                    nose follows the swim at turnLerp only while the swim is
--                    toward the point and above the move threshold; at rest
--                    the AUTHORED heading and roll take over, reached along
--                    the leg (turnEase over how much of the swim is done,
--                    settled at turnSettle) so the body finishes turning as
--                    it arrives.
--   3. THE CLIPS     idle / swim / boost picked from the low-passed speed
--                    (moveThreshold, boostThreshold), crossfaded over
--                    CONFIG.animation.crossfade, each at its clipTimeScale —
--                    the three clips baked into seal.mesh by the mesh tool.
--
-- Pure: no renderer, no GPU. table.luau feeds it the frame and uploads the
-- bones it builds. Everything here is screen px and seconds.
-- ============================================================================

local MOTION = require('motion')
local REACT = require('react')

export type Vec = { x: number, y: number }

-- What the table hands over each frame.
export type Frame = {
    w: number, h: number,
    L: number,            -- body length on screen, px
    pxUnit: number,       -- px per game world unit (the run's numbers scale by it)
    row: Vec,             -- the row anchor
    stage: Vec?,          -- the open water under the columns: where a reaction is performed
    reactSeq: number,     -- bumped by the table on every valid play; a new number is a new reaction
    reactVariant: string, -- which one (react.luau's roster)
    reactSpeed: number,   -- x the choreography's tempo
    card: Vec?,           -- the hovered card, or the one in hand
    cursor: Vec?,         -- the pointer, when known
    corner: Vec?,         -- the corner of the card being bitten, while the pointer holds it
    mouthDx: number, mouthDy: number, -- where the mouth is, relative to the centre, from the last drawn pose
    biting: boolean,      -- the pointer is down on a card
    releaseT: number,     -- seconds since the last release, or -1
    dragging: boolean,
    won: boolean,
    -- tunables
    thrust: number, friction: number, maxSpeed: number, turnLerp: number, steer: number,
    landEase: number, lean: number,
    arrive: number, blendRate: number, blendTime: number, turnSettle: number,
    moveThreshold: number, boostThreshold: number, crossfade: number,
    clipScale: number,
    bobAmp: number, bobPeriod: number,
    -- the bite
    biteOffset: number,   -- body lengths the mouth is pushed PAST the corner (how deep the bite is)
    jawClamp: number,     -- the jaw's opening once clamped on the card, 0..1
    biteHold: number,     -- body lengths within which the bite takes and the body locks to the corner
    releaseTime: number,  -- seconds the release pose lasts
    releaseLift: number,  -- how far it comes toward the viewer (scale up) on release
    releasePush: number,  -- px/s shove away from the card on release
    steerTight: number,   -- the steer turns at least tight enough to keep the arc inside this many arrive bands
}

type Ramp = { from: number, t: number }

export type Clip = { name: string, frames: number, fps: number, at: number, duration: number }

export type Puppet = {
    -- blender
    weights: { [string]: number },
    ramps: { [string]: Ramp },
    wanted: string,
    time: number,
    -- the pull
    x: number, y: number, vx: number, vy: number,
    heading: number,        -- the swim's own, follows the velocity
    speed: number,          -- world units per second
    land: Vec,              -- the blended point this frame
    landOn: boolean,
    -- the leg
    bodyHeading: number, bodyRoll: number,
    legFromH: number, legFromR: number, legDist0: number, legState: string,
    -- the bite
    held: boolean,          -- mouth on the corner: the body rides the card
    jawSnap: number,        -- the snap on the bite, decaying
    jawHeld: number,        -- the jaw while clamped, easing shut
    split: number,          -- 0..1 the mouth is on a card: the head and the jaw take opposite sides of it
    behind: number,         -- 0..1 blended from the states: which side of the cards the body swims on
    lift: number,           -- 0..1 toward the viewer, on release
    -- the reaction (react.luau): its clock, and what it is adding this frame
    reactSeq: number, reactName: string, reactT: number, reactWait: number,
    outPitch: number, clap: number, reactLift: number,
    -- outputs
    outHeading: number, outRoll: number, jaw: number,
    look: Vec, lookOut: number, lookOn: boolean,
    -- clips
    clipState: string,
    clipSpeed: number,
    clipW: { [string]: number },
    clipT: { [string]: number },
}

local STATES = { 'idle', 'card', 'drag', 'bite', 'release', 'react', 'win' }
local CLIP_STATES = { 'idle', 'swim', 'boost' }
-- The fraction either side of a clip threshold that has to be crossed.
local CLIP_HYST = 0.18
-- Every clip the blender may weight: the speed set, then the reactions'.
local ALL_CLIPS = { 'idle', 'swim', 'boost' }
for _, c in ipairs(REACT.CLIPS) do
    table.insert(ALL_CLIPS, c)
end
-- CONFIG.animation.states[*].clipTimeScale
local CLIP_SCALE: { [string]: number } = { idle = 0.45, swim = 1.0, boost = 1.8 }

local M = {}

local function lerpAngle(a: number, b: number, t: number): number
    local d = b - a
    while d > math.pi do d -= math.pi * 2 end
    while d < -math.pi do d += math.pi * 2 end
    return a + d * t
end

local function inOutCubic(u: number): number
    if u < 0.5 then
        return 4 * u * u * u
    end
    local v = -2 * u + 2
    return 1 - v * v * v / 2
end

function M.new(x: number, y: number): Puppet
    local weights: { [string]: number } = {}
    local ramps: { [string]: Ramp } = {}
    for _, s in ipairs(STATES) do
        weights[s] = if s == 'idle' then 1 else 0
        ramps[s] = { from = weights[s], t = 1e9 }
    end
    local clipW: { [string]: number } = {}
    local clipT: { [string]: number } = {}
    for _, c in ipairs(ALL_CLIPS) do
        clipW[c] = if c == 'idle' then 1 else 0
        clipT[c] = 0
    end
    return {
        weights = weights, ramps = ramps, wanted = 'idle', time = 0,
        x = x, y = y, vx = 0, vy = 0, heading = 0, speed = 0,
        land = { x = x, y = y }, landOn = false,
        bodyHeading = 0, bodyRoll = 0,
        legFromH = 0, legFromR = 0, legDist0 = 0, legState = '',
        held = false, jawSnap = 0, jawHeld = 0, split = 0, behind = 0, lift = 0,
        reactSeq = 0, reactName = '', reactT = -1, reactWait = 0, outPitch = 0, clap = 0, reactLift = 0,
        outHeading = 0, outRoll = 0, jaw = 0,
        look = { x = x, y = y }, lookOut = 0, lookOn = false,
        clipState = 'idle', clipSpeed = 0, clipW = clipW, clipT = clipT,
    }
end

-- An anchor in px, or nil when it cannot be placed this frame.
local function resolve(anchor: string, f: Frame, p: Puppet): Vec?
    if anchor == 'row' then
        return f.row
    elseif anchor == 'stage' then
        return f.stage or f.row
    elseif anchor == 'card' then
        return f.card
    elseif anchor == 'cursor' then
        return f.cursor or f.card
    elseif anchor == 'lean' then
        -- The row, pulled part of the way to the pointer. Not the pointer
        -- itself: this is the body leaning the way the hand is going, which has
        -- to stay clearly less than what hovering an actual card does or the
        -- two read as the same thing and settling on a card stops meaning
        -- anything. With the pointer off the table it is just the row.
        local c = f.cursor
        if c == nil then
            return f.row
        end
        return { x = f.row.x + (c.x - f.row.x) * f.lean, y = f.row.y + (c.y - f.row.y) * f.lean }
    elseif anchor == 'corner' then
        return f.corner or f.card
    elseif anchor == 'self' then
        return { x = p.x, y = p.y }
    elseif anchor == 'free' then
        return { x = 0, y = 0 }
    end
    return nil
end

local function place(anchor: string, ox: number, oy: number, f: Frame, p: Puppet, yInLengths: boolean): Vec?
    local a = resolve(anchor, f, p)
    if a == nil then
        return nil
    end
    local dy = if anchor == 'free' then oy * f.h else (if yInLengths then oy * f.L else oy * f.h)
    return { x = a.x + ox * f.w, y = a.y + dy }
end

-- THE REACTION'S CLOCK. A new `reactSeq` from the table names a reaction;
-- it is PENDING until the body is near the stage (or has waited long
-- enough that it should just go), then runs from 0 to its duration at the
-- tuner's tempo and is over. The hand outranks it: a bite or a drag while
-- one is pending or playing is what the animal does instead.
local function reaction(p: Puppet, dt: number, f: Frame, near: boolean)
    if f.reactSeq ~= p.reactSeq then
        p.reactSeq = f.reactSeq
        p.reactName = if REACT.variant(f.reactVariant) ~= nil then f.reactVariant else ''
        p.reactT = -1
        p.reactWait = 0
    end
    if p.reactName == '' then
        return
    end
    local v = REACT.variant(p.reactName)
    if v == nil then
        p.reactName = ''
        return
    end
    if p.reactT < 0 then
        p.reactWait += dt
        if near or p.reactWait > 0.9 then
            p.reactT = 0
        end
    else
        p.reactT += dt * math.max(0.05, f.reactSpeed)
        if p.reactT >= v.duration then
            p.reactName = ''
            p.reactT = -1
        end
    end
end

function M.reacting(p: Puppet): boolean
    return p.reactName ~= ''
end

function M.update(p: Puppet, dt: number, f: Frame)
    p.time += dt

    -- The reaction, before the blender picks a state: near enough to the
    -- stage to begin is measured against the LAST frame's landing point.
    do
        local near = false
        if f.stage ~= nil then
            local dx, dy = f.stage.x - p.x, f.stage.y - p.y
            near = math.sqrt(dx * dx + dy * dy) < f.L * 1.2
        end
        reaction(p, dt, f, near)
    end

    -- 1. THE BLENDER. Timed ramps along inOutCubic, restarted from wherever
    -- they are when the wanted state changes.
    local want = 'idle'
    if f.won then
        want = 'win'
    elseif f.biting and f.corner ~= nil then
        want = 'bite'
    elseif M.reacting(p) and not f.dragging then
        want = 'react'
    elseif f.releaseT >= 0 and f.releaseT < f.releaseTime then
        want = 'release'
    elseif f.dragging and f.card ~= nil then
        want = 'drag'
    elseif f.card ~= nil then
        want = 'card'
    end
    if want ~= 'bite' and p.held then
        -- Let go: a shove away from the card, and the rise toward the viewer.
        p.held = false
        p.vy += f.releasePush
        p.jawSnap = 0.6
    end
    if want ~= p.wanted then
        p.wanted = want
        for _, s in ipairs(STATES) do
            p.ramps[s].from = p.weights[s]
            p.ramps[s].t = 0
        end
    end
    local k = 1 - math.exp(-math.max(0, f.blendRate) * dt)
    local sum = 0
    for _, s in ipairs(STATES) do
        local target = if s == p.wanted then 1 else 0
        if f.blendTime > 0 then
            local r = p.ramps[s]
            r.t += dt
            local u = math.min(1, r.t / f.blendTime)
            p.weights[s] = r.from + (target - r.from) * inOutCubic(u)
        else
            p.weights[s] += (target - p.weights[s]) * k
        end
        if p.weights[s] < 1e-3 and s ~= p.wanted then
            p.weights[s] = 0
        end
        sum += p.weights[s]
    end
    if sum <= 1e-9 then
        p.weights[p.wanted] = 1
        sum = 1
    end

    -- The weighted pose: landing point, heading and roll as vectors, jaw,
    -- look target.
    local lx, ly, lw = 0, 0, 0
    local hx, hy, rx, ry, jaw, behind = 0, 0, 0, 0, 0, 0
    local kx, ky, ks, kw = 0, 0, 0, 0
    for _, s in ipairs(STATES) do
        local w = p.weights[s] / sum
        if w <= 0 then
            continue
        end
        local st = MOTION[s]
        local pt = place(st.land.anchor, st.land.x, st.land.y, f, p, true)
        if s == 'bite' and pt ~= nil then
            -- The MOUTH goes to the corner, not the centre: back the point off
            -- by where the mouth was drawn last frame, then push it past the
            -- corner by the bite's depth along the nose.
            local depth = f.biteOffset * f.L
            pt = { x = pt.x - f.mouthDx + math.sin(p.outHeading) * depth, y = pt.y - f.mouthDy - math.cos(p.outHeading) * depth }
        end
        if pt ~= nil then
            local by = 0
            if s == 'idle' then
                by = math.sin(p.time * math.pi * 2 / math.max(0.1, f.bobPeriod)) * f.bobAmp * f.L
            end
            lx += pt.x * w
            ly += (pt.y + by) * w
            lw += w
        end
        hx += math.cos(st.heading) * w
        hy += math.sin(st.heading) * w
        rx += math.cos(st.roll) * w
        ry += math.sin(st.roll) * w
        jaw += st.jaw * w
        behind += st.behind * w
        local lk = place(st.look.anchor, st.look.x, st.look.y, f, p, false)
        if lk ~= nil then
            kx += lk.x * w
            ky += lk.y * w
            ks += st.look.out * w
            kw += w
        end
    end
    local wantH = math.atan2(hy, hx)
    local wantR = math.atan2(ry, rx)
    p.jawSnap = math.max(0, p.jawSnap - dt * 4)
    if p.held then
        -- Clamped: the jaw shuts fast onto the card and stays there.
        p.jawHeld += (f.jawClamp - p.jawHeld) * (1 - math.exp(-16 * dt))
        p.jaw = p.jawHeld
    else
        p.jawHeld = jaw
        p.jaw = math.min(1.2, jaw + p.jawSnap)
    end
    -- The head and the lower jaw take opposite sides of the card in the mouth.
    local wantSplit = if p.held then 1 else 0
    p.split += (wantSplit - p.split) * (1 - math.exp(-14 * dt))
    -- Which side of the cards the body is on. Already smooth: `w` is the
    -- crossfade, so this is the states' own blend and needs no spring of its
    -- own. seal.wgsl reads it at a threshold — see motion.luau.
    p.behind = behind
    -- No rise toward the viewer on release: letting go of a card is not an
    -- event, and the animal popping at the camera every time read as one.
    -- The lift is the REACTIONS' now (react.luau's `lift`, in reactLift);
    -- `p.lift` stays so the model's release nod has a number to read, at 0.
    local wantLift = 0
    p.lift += (wantLift - p.lift) * (1 - math.exp(-3 * dt))
    if kw > 1e-6 then
        p.look = { x = kx / kw, y = ky / kw }
        p.lookOut = ks / kw
        p.lookOn = true
    else
        p.lookOn = false
    end
    if lw > 1e-6 then
        local nx, ny = lx / lw, ly / lw
        -- Keep the point on the screen by half a body.
        local edge = f.L * 0.5
        nx = math.max(edge, math.min(f.w - edge, nx))
        ny = math.max(edge, math.min(f.h - edge, ny))
        -- THE POINT EASES; the body still swims to it on its own physics.
        --
        -- Crossfading the states covers a change of STATE, but not a change of
        -- ANCHOR under a state that is already at weight 1: hovering from one
        -- card to the next keeps `card` wanted and simply teleports its landing
        -- point, so the direction of the pull, the distance, the braking speed
        -- and the steer's blend all step at once and the swim reads as a series
        -- of darts. Lagging the point turns each of those steps into a ramp
        -- without softening the arrival, because what arrives is still the
        -- animal under thrust and friction.
        --
        -- The bite is exempt. Its point is the card's corner, offset by where
        -- the mouth was actually drawn, and a lagged corner is a mouth that
        -- closes next to the card instead of on it.
        if p.landOn and f.landEase > 0 and p.wanted ~= 'bite' then
            local ke = 1 - math.exp(-f.landEase * dt)
            p.land = { x = p.land.x + (nx - p.land.x) * ke, y = p.land.y + (ny - p.land.y) * ke }
        else
            p.land = { x = nx, y = ny }
        end
        p.landOn = true
    else
        p.landOn = false
    end

    -- THE BITE HOLDS: once the mouth is on the corner the body rides the card
    -- and the pull is off, so the seal drags with the hand rather than
    -- chasing it. The clip controller still sees the speed of the ride.
    if want == 'bite' and p.landOn then
        local hx0, hy0 = p.land.x - p.x, p.land.y - p.y
        local hd = math.sqrt(hx0 * hx0 + hy0 * hy0)
        if not p.held and hd < f.biteHold * f.L then
            p.held = true
        end
        if p.held then
            local kh = 1 - math.exp(-30 * dt)
            local nx, ny = p.x + hx0 * kh, p.y + hy0 * kh
            p.vx, p.vy = (nx - p.x) / math.max(1e-4, dt), (ny - p.y) / math.max(1e-4, dt)
            p.x, p.y = nx, ny
            p.speed = math.sqrt(p.vx * p.vx + p.vy * p.vy) / f.pxUnit
            p.heading = lerpAngle(p.heading, 0, 1 - math.exp(-f.turnLerp * dt))
            local ksettle = 1 - math.exp(-f.turnSettle * dt)
            p.bodyHeading = lerpAngle(p.bodyHeading, wantH, ksettle)
            p.bodyRoll = lerpAngle(p.bodyRoll, wantR, ksettle)
            p.outHeading = p.heading + p.bodyHeading
            p.outRoll = p.bodyRoll
            p.outPitch, p.clap, p.reactLift = 0, 0, 0
            p.legState = 'bite'
            M.clips(p, dt, f)
            return
        end
    end

    -- 2. THE PULL — the run's numbers through px per unit.
    local px = f.pxUnit
    local thrust = f.thrust * px
    local top = f.maxSpeed * px
    local ex, ey = p.land.x - p.x, p.land.y - p.y
    local dist = math.sqrt(ex * ex + ey * ey)
    local arrive = math.max(1, f.arrive * f.L)
    -- A new leg whenever the state changes or the point pulls away.
    if p.legState ~= p.wanted then
        p.legFromH, p.legFromR, p.legDist0 = p.bodyHeading, p.bodyRoll, dist
        p.legState = p.wanted
    elseif dist > p.legDist0 then
        p.legDist0 = dist
    end

    local brake = math.sqrt(2 * thrust * dist)
    local wantSpeed = math.min(top, brake, top * (dist / arrive))
    local ux, uy = 0, 0
    if dist > 1e-6 then
        ux, uy = ex / dist, ey / dist
    end
    local dvx = ux * wantSpeed - p.vx
    local dvy = uy * wantSpeed - p.vy
    local dv = math.sqrt(dvx * dvx + dvy * dvy)
    local nvx, nvy = p.vx, p.vy
    if dv > 1e-6 then
        local push = math.min(dv, thrust * dt)
        nvx += dvx / dv * push
        nvy += dvy / dv * push
    end
    -- The steer: the speed kept, its direction turned toward the point in a
    -- banking arc, only while the point is beyond the arrive band.
    local sp0 = math.sqrt(p.vx * p.vx + p.vy * p.vy)
    local steerW = if sp0 > 1e-3 and dist > 1e-6 then math.min(1, dist / arrive) else 0
    if steerW > 0 then
        local cur = math.atan2(p.vy, p.vx)
        local wantA = math.atan2(ey, ex)
        -- A turn-limited chase orbits a point it cannot turn inside, so the
        -- steer is at least tight enough for the arc to fit `steerTight`
        -- arrive bands: rate >= speed / radius.
        local minRate = sp0 / math.max(1, f.steerTight * arrive)
        local ang = lerpAngle(cur, wantA, 1 - math.exp(-math.max(f.steer, minRate) * dt))
        local mag = sp0 + math.max(-thrust * dt, math.min(thrust * dt, wantSpeed - sp0))
        local svx, svy = math.cos(ang) * mag, math.sin(ang) * mag
        local w = steerW * steerW * (3 - 2 * steerW)
        nvx += (svx - nvx) * w
        nvy += (svy - nvy) * w
    end
    local fr = math.pow(math.max(0, math.min(0.999, f.friction)), dt * 60)
    p.vx = nvx * fr
    p.vy = nvy * fr
    local sp = math.sqrt(p.vx * p.vx + p.vy * p.vy)
    if sp > top and sp > 0 then
        p.vx *= top / sp
        p.vy *= top / sp
        sp = top
    end
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.speed = sp / px

    -- The nose follows the swim while it is toward the point and moving; a
    -- swim that has arrived hands the heading back to the authored pose.
    local toward = p.vx * ex + p.vy * ey > 0 and dist > arrive * 0.5
    if toward and p.speed > f.moveThreshold then
        local target = math.atan2(p.vx, -p.vy)
        p.heading = lerpAngle(p.heading, target, 1 - math.exp(-f.turnLerp * dt))
    else
        p.heading = lerpAngle(p.heading, 0, 1 - math.exp(-f.turnLerp * 0.5 * dt))
    end

    -- The leg: the authored heading and roll reached by how far the swim is
    -- done, settled at turnSettle.
    local frac = 1
    if p.legDist0 > 1 then
        frac = math.max(0, math.min(1, 1 - dist / p.legDist0))
    end
    local prog = inOutCubic(frac)
    local legH = lerpAngle(p.legFromH, wantH, prog)
    local legR = lerpAngle(p.legFromR, wantR, prog)
    local ksettle = 1 - math.exp(-f.turnSettle * dt)
    p.bodyHeading = lerpAngle(p.bodyHeading, legH, ksettle)
    p.bodyRoll = lerpAngle(p.bodyRoll, legR, ksettle)
    -- The reaction's choreography rides on top: whole turns that arrive
    -- back at the identity, a somersault, the clap, a lift.
    local rp = REACT.pose(p.reactName, p.reactT)
    p.outHeading = p.heading + p.bodyHeading + rp.heading
    p.outRoll = p.bodyRoll + rp.roll
    p.outPitch = rp.pitch
    p.clap = rp.clap
    p.reactLift = rp.lift

    M.clips(p, dt, f)
end

-- 3. THE CLIPS, from the low-passed speed.
function M.clips(p: Puppet, dt: number, f: Frame)
    p.clipSpeed += (p.speed - p.clipSpeed) * (1 - math.exp(-6 * dt))
    -- HYSTERESIS, because a threshold with none is a coin toss at the threshold.
    -- A speed loitering on `moveThreshold` — which is most of a slow approach —
    -- flipped idle and swim every few frames, and each flip restarted a
    -- crossfade that never finished, so the animal spent the whole approach
    -- half in one clip and half in the other. The band has to be crossed, and
    -- crossed back by more, before the clip changes.
    local state = p.clipState
    local up, down = 1 + CLIP_HYST, 1 - CLIP_HYST
    if state == 'boost' then
        if p.clipSpeed < f.boostThreshold * down then
            state = 'swim'
        end
    elseif state == 'swim' then
        if p.clipSpeed >= f.boostThreshold * up then
            state = 'boost'
        elseif p.clipSpeed < f.moveThreshold * down then
            state = 'idle'
        end
    else
        if p.clipSpeed >= f.boostThreshold * up then
            state = 'boost'
        elseif p.clipSpeed >= f.moveThreshold * up then
            state = 'swim'
        end
    end
    p.clipState = state
    local kc = if f.crossfade > 0 then math.min(1, dt / f.crossfade) else 1
    -- A reaction clip takes its weight off the speed set, so it is the
    -- pose while it plays rather than half of one; its time is the
    -- reaction's own clock, not a free-running one.
    local rp = REACT.pose(p.reactName, p.reactT)
    for _, c in ipairs(CLIP_STATES) do
        local target = (if c == state then 1 else 0) * (1 - rp.clipW)
        p.clipW[c] += (target - p.clipW[c]) * kc
        p.clipT[c] += dt * CLIP_SCALE[c] * f.clipScale
    end
    for _, c in ipairs(REACT.CLIPS) do
        local target = if rp.clip == c then rp.clipW else 0
        p.clipW[c] += (target - p.clipW[c]) * math.min(1, kc * 2)
        if rp.clip == c then
            p.clipT[c] = rp.clipT
        end
    end
end

-- ---------------------------------------------------------------------------
-- Clips: the blob's sampled bone transforms, blended by the controller.
-- ---------------------------------------------------------------------------
function M.readClips(data: buffer, at: number, bones: number): ({ [string]: Clip }, number)
    local clips: { [string]: Clip } = {}
    local count = buffer.readu32(data, at)
    at += 4
    for _ = 1, count do
        local nameLen = buffer.readu32(data, at)
        at += 4
        local name = buffer.readstring(data, at, nameLen)
        at += nameLen
        local frames = buffer.readu32(data, at)
        at += 4
        local fps = buffer.readf32(data, at)
        at += 4
        clips[name] = { name = name, frames = frames, fps = fps, at = at, duration = frames / fps }
        at += frames * bones * 10 * 4
    end
    return clips, at
end

local function trsMatrix(tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): Mat4
    local xx, yy, zz = qx * qx, qy * qy, qz * qz
    local xy, xz, yz = qx * qy, qx * qz, qy * qz
    local wx, wy, wz = qw * qx, qw * qy, qw * qz
    return Mat4.values(
        (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
        2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
        2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
        tx, ty, tz, 1)
end

-- Ten floats of one bone at a fractional frame, lerped between its two frames.
local acc = table.create(10, 0)
local function sampleBone(data: buffer, clip: Clip, bones: number, b: number, t: number, out: { number }, w: number, first: boolean)
    local ft = (t % clip.duration) * clip.fps
    local f0 = math.floor(ft) % clip.frames
    local f1 = (f0 + 1) % clip.frames
    local u = ft - math.floor(ft)
    local a0 = clip.at + ((f0 * bones + (b - 1)) * 10) * 4
    local a1 = clip.at + ((f1 * bones + (b - 1)) * 10) * 4
    -- pos and scale lerp; the quat nlerps with a hemisphere check.
    local q0 = { buffer.readf32(data, a0 + 12), buffer.readf32(data, a0 + 16), buffer.readf32(data, a0 + 20), buffer.readf32(data, a0 + 24) }
    local q1 = { buffer.readf32(data, a1 + 12), buffer.readf32(data, a1 + 16), buffer.readf32(data, a1 + 20), buffer.readf32(data, a1 + 24) }
    local dq = q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3] + q0[4] * q1[4]
    local sg = if dq < 0 then -1 else 1
    local q = { q0[1] + (q1[1] * sg - q0[1]) * u, q0[2] + (q1[2] * sg - q0[2]) * u, q0[3] + (q1[3] * sg - q0[3]) * u, q0[4] + (q1[4] * sg - q0[4]) * u }
    if not first then
        local d = out[4] * q[1] + out[5] * q[2] + out[6] * q[3] + out[7] * q[4]
        if d < 0 then
            q[1], q[2], q[3], q[4] = -q[1], -q[2], -q[3], -q[4]
        end
    end
    for c = 0, 2 do
        local v = buffer.readf32(data, a0 + c * 4)
        v += (buffer.readf32(data, a1 + c * 4) - v) * u
        out[1 + c] += v * w
        local s = buffer.readf32(data, a0 + 28 + c * 4)
        s += (buffer.readf32(data, a1 + 28 + c * 4) - s) * u
        out[8 + c] += s * w
    end
    for c = 1, 4 do
        out[3 + c] += q[c] * w
    end
end

-- The blended LOCAL matrix of every bone into `locals`. The root's clip
-- transform is applied on top of its bind local (which carries the chain
-- above the skeleton, including the file's 0.01 scale); every other bone's
-- clip transform IS its local.
function M.buildLocals(p: Puppet, data: buffer, clips: { [string]: Clip }, bones: number, bindLocal: { Mat4 }, parent: { number }, locals: { Mat4 })
    local total = 0
    for _, c in ipairs(ALL_CLIPS) do
        if clips[c] ~= nil then
            total += p.clipW[c]
        end
    end
    if total <= 1e-6 then
        for b = 1, bones do
            locals[b] = bindLocal[b]
        end
        return
    end
    for b = 1, bones do
        for c = 1, 10 do
            acc[c] = 0
        end
        local first = true
        for _, c in ipairs(ALL_CLIPS) do
            local clip = clips[c]
            local w = p.clipW[c] / total
            if clip ~= nil and w > 1e-4 then
                sampleBone(data, clip, bones, b, p.clipT[c], acc, w, first)
                first = false
            end
        end
        local qn = math.sqrt(acc[4] * acc[4] + acc[5] * acc[5] + acc[6] * acc[6] + acc[7] * acc[7])
        if qn < 1e-6 then
            qn = 1
        end
        local m = trsMatrix(acc[1], acc[2], acc[3], acc[4] / qn, acc[5] / qn, acc[6] / qn, acc[7] / qn, acc[8], acc[9], acc[10])
        if parent[b] == 0 then
            locals[b] = Mat4.multiply(Mat4.identity(), bindLocal[b], m)
        else
            locals[b] = m
        end
    end
end

return M
