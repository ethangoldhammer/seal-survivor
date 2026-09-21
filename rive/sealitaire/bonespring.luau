-- ============================================================================
-- THE BONE SPRING — damped-spring secondary motion for a chain of bones, so a
-- big animal answers a collision with its own SKELETON rather than with a
-- squash of its vertices (baitball.luau's dent, which is what the schools
-- still get).
--
-- A port of path/src/systems/boneSpring.js, the solver that already carries
-- every hit reaction in the game proper, onto the chains rive/sealitaire/
-- rigs.csv copies out of that same file's `springChains`. It is NOT IK:
-- nothing aims at anything. Each bone's DIRECTION is handed to a spring that
-- chases where the rest pose already put it, so the chain declines to keep
-- up — a shove leaves it behind for a moment and it overshoots slightly
-- settling back.
--
-- Three details make it flow rather than wobble, and all three are the
-- original's:
--
--   - Bones solve ROOT TO TIP and each measures its target AFTER its parent
--     has already been displaced, so the lag accumulates into a travelling
--     wave down the chain instead of every bone lagging the same amount.
--     That wave IS the follow-through, and it is the whole reason to use a
--     skeleton here rather than a spatial warp: a warp has no per-joint
--     state, so its tail can only move while the dent that made it is still
--     moving. A tail that keeps swinging after the head has stopped is a
--     thing only this can do.
--   - `tipLoose` softens the spring toward the tip so the far end trails
--     furthest. Damping is scaled by the SQUARE ROOT of the same factor,
--     which holds the damping RATIO constant — otherwise the loose end
--     rings like a struck spring while the stiff base sits dead.
--   - `maxLag` caps how far a bone may travel from its target, eased into
--     rather than clamped, so nothing snaps taut.
--
-- An impulse is injected straight into the spring velocities: there is no
-- separate flinch, a hit just shoves the chain and the spring carries the
-- shove down the body and settles it.
--
-- Everything here is in the pack's CANONICAL frame (centred, long axis z,
-- head at -z, length 1), which is the frame the vertices and the bone heads
-- are already in, so a solve means the same thing on a sardine and an orca.
-- Pure: no GPU, no globals, and tests.luau holds its numbers.
-- ============================================================================

local M = {}

export type Bone = {
    slot: number,        -- its index in the species' palette
    hx: number, hy: number, hz: number,   -- its rest head, canonical
    rx: number, ry: number, rz: number,   -- its rest direction, unit (toward the next bone, or the chain's own run at the tip)
    len: number,         -- rest length to the next head
}

export type Chain = {
    role: number,        -- 0 tail, 1 fin
    bones: { Bone },
}

-- One chain's live state: where each bone is pointing now, and how fast.
export type State = {
    dx: { number }, dy: { number }, dz: { number },
    vx: { number }, vy: { number }, vz: { number },
    live: boolean,       -- false once everything has settled: the caller may skip the upload
}

export type Cfg = {
    stiff: number,       -- spring constant at the ROOT of a chain
    damp: number,        -- damping at the root
    tipLoose: number,    -- >1: how much softer the tip is than the root
    maxLag: number,      -- radians a bone may sit from ITS PARENT's carried rest: the per-joint cap, and what the wave is made of
    maxBend: number,     -- radians a bone may sit from its OWN rest, whatever its parents did: the cap on the WHOLE chain
    soft: number,        -- 0..1 of a cap where the easing starts
}

-- A chain at rest: every bone pointing exactly where the rest pose put it.
function M.rest(c: Chain): State
    local st: State = { dx = {}, dy = {}, dz = {}, vx = {}, vy = {}, vz = {}, live = false }
    for k, b in ipairs(c.bones) do
        st.dx[k], st.dy[k], st.dz[k] = b.rx, b.ry, b.rz
        st.vx[k], st.vy[k], st.vz[k] = 0, 0, 0
    end
    return st
end

function M.reset(c: Chain, st: State)
    for k, b in ipairs(c.bones) do
        st.dx[k], st.dy[k], st.dz[k] = b.rx, b.ry, b.rz
        st.vx[k], st.vy[k], st.vz[k] = 0, 0, 0
    end
    st.live = false
end

-- The same soft knee the game's chains use: linear below `soft` of the cap,
-- then compressed onto an exponential that approaches the cap without
-- reaching it. Value and slope match at the knee, so there is no corner.
local function knee(v: number, cap: number, soft: number): number
    local lin = cap * soft
    if v <= lin then
        return v
    end
    return cap - (cap - lin) * math.exp(-(v - lin) / math.max(1e-6, cap - lin))
end

-- SHOVE. `nx,ny,nz` is the push, canonical and unit; `amp` its strength in
-- direction-units per second. Every bone is kicked by the part of the push
-- ACROSS its own length — a shove straight down a bone's axis cannot bend
-- it, and adding it anyway is what makes a chain stretch instead of swing.
-- `at` and `spread` localise it along the body the way the dent is
-- localised, so a hit on the nose barely moves the tail's root.
function M.impulse(c: Chain, st: State, nx: number, ny: number, nz: number, amp: number, at: number, spread: number)
    if amp == 0 then
        return
    end
    local s2 = 2 * math.max(1e-3, spread) * math.max(1e-3, spread)
    for k, b in ipairs(c.bones) do
        local dz = b.hz - at
        local w = math.exp(-(dz * dz) / s2)
        if w > 1e-3 then
            local dx, dy, dzz = st.dx[k], st.dy[k], st.dz[k]
            local along = nx * dx + ny * dy + nz * dzz
            local px, py, pz = nx - along * dx, ny - along * dy, nz - along * dzz
            local pl = math.sqrt(px * px + py * py + pz * pz)
            if pl > 1e-6 then
                local g = amp * w / pl
                st.vx[k] += px * g
                st.vy[k] += py * g
                st.vz[k] += pz * g
                st.live = true
            end
        end
    end
end

-- Rodrigues: the 3x3 taking unit `a` onto unit `b`, written into a 3x4 with
-- no translation. Antiparallel is the degenerate case and is left as the
-- identity rather than picking an arbitrary axis — a bone that has been
-- turned exactly inside out is a bug upstream, not a pose to render.
local function rotBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: { number })
    local cx, cy, cz = ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx
    local s = math.sqrt(cx * cx + cy * cy + cz * cz)
    local c = ax * bx + ay * by + az * bz
    if s < 1e-7 then
        out[1], out[2], out[3] = 1, 0, 0
        out[4], out[5], out[6] = 0, 1, 0
        out[7], out[8], out[9] = 0, 0, 1
        return
    end
    cx, cy, cz = cx / s, cy / s, cz / s
    local t = 1 - c
    out[1] = t * cx * cx + c;      out[2] = t * cx * cy - s * cz; out[3] = t * cx * cz + s * cy
    out[4] = t * cx * cy + s * cz; out[5] = t * cy * cy + c;      out[6] = t * cy * cz - s * cx
    out[7] = t * cx * cz - s * cy; out[8] = t * cy * cz + s * cx; out[9] = t * cz * cz + c
end

local function mul3(a: { number }, b: { number }, out: { number })
    for r = 0, 2 do
        for cc = 1, 3 do
            out[r * 3 + cc] = a[r * 3 + 1] * b[cc] + a[r * 3 + 2] * b[3 + cc] + a[r * 3 + 3] * b[6 + cc]
        end
    end
end

-- Pull a direction back toward `t` until it sits inside `cap` of it, through
-- the knee above rather than at it. Returns the direction unchanged when it
-- is already inside.
local function ease(dx: number, dy: number, dz: number, tx: number, ty: number, tz: number, cap: number, soft: number): (number, number, number)
    local cosA = math.max(-1, math.min(1, dx * tx + dy * ty + dz * tz))
    local ang = math.acos(cosA)
    if ang <= cap * soft or ang < 1e-6 then
        return dx, dy, dz
    end
    local want = knee(ang, cap, soft)
    if want >= ang - 1e-6 then
        return dx, dy, dz
    end
    local f = want / ang
    local sinA = math.sin(ang)
    if sinA < 1e-6 then
        return dx, dy, dz
    end
    local a0 = math.sin((1 - f) * ang) / sinA
    local a1 = math.sin(f * ang) / sinA
    local ox, oy, oz = tx * a0 + dx * a1, ty * a0 + dy * a1, tz * a0 + dz * a1
    local l = math.sqrt(ox * ox + oy * oy + oz * oz)
    if l < 1e-6 then
        return dx, dy, dz
    end
    return ox / l, oy / l, oz / l
end

local _q = { 1, 0, 0, 0, 1, 0, 0, 0, 1 }
local _acc = { 1, 0, 0, 0, 1, 0, 0, 0, 1 }
local _nxt = { 1, 0, 0, 0, 1, 0, 0, 0, 1 }

-- One chain, one frame. Writes each sprung bone's bend into `out` as a 3x4
-- keyed by palette slot: out[slot] = { 12 numbers }, canonical space,
-- relative to the rest pose (which is what the shader multiplies the clip
-- palette by). Returns whether anything is still moving.
function M.solve(c: Chain, st: State, dt: number, cfg: Cfg, out: { [number]: { number } }): boolean
    if not st.live then
        return false
    end
    local n = #c.bones
    -- The accumulated rotation of everything above this bone, and the point
    -- it rotates about — which MOVES as the parents turn, or the chain comes
    -- apart at every joint.
    _acc[1], _acc[2], _acc[3] = 1, 0, 0
    _acc[4], _acc[5], _acc[6] = 0, 1, 0
    _acc[7], _acc[8], _acc[9] = 0, 0, 1
    local px, py, pz = c.bones[1].hx, c.bones[1].hy, c.bones[1].hz
    local moving = false
    for k = 1, n do
        local b = c.bones[k]
        -- Softer toward the tip; damping by the SQUARE ROOT of the same, so
        -- the ratio holds and the loose end does not ring on for ever.
        local u = if n > 1 then (k - 1) / (n - 1) else 0
        local loose = 1 + (cfg.tipLoose - 1) * u
        local stiff = cfg.stiff / loose
        local damp = cfg.damp / math.sqrt(loose)
        -- The target: the rest direction carried by whatever the parents
        -- have already done. Measured AFTER them, which is what turns the
        -- lag into a wave.
        local tx = _acc[1] * b.rx + _acc[2] * b.ry + _acc[3] * b.rz
        local ty = _acc[4] * b.rx + _acc[5] * b.ry + _acc[6] * b.rz
        local tz = _acc[7] * b.rx + _acc[8] * b.ry + _acc[9] * b.rz
        local dx, dy, dz = st.dx[k], st.dy[k], st.dz[k]
        local vx, vy, vz = st.vx[k], st.vy[k], st.vz[k]
        vx += (tx - dx) * stiff * dt
        vy += (ty - dy) * stiff * dt
        vz += (tz - dz) * stiff * dt
        local decay = math.exp(-damp * dt)
        vx, vy, vz = vx * decay, vy * decay, vz * decay
        -- A CEILING ON THE RATE, and it is insurance rather than shaping.
        -- The caps below bound where a bone may BE, not how fast it is
        -- travelling, so a caller that shoves every frame pumps velocity in
        -- faster than the damping takes it out and the bone buzzes against
        -- its cap for ever. Scaled off the spring's own natural frequency,
        -- so it means the same thing at any stiffness and is never the
        -- thing that shapes a normal swing.
        local cap = math.sqrt(stiff) * 2.5
        local vl = math.sqrt(vx * vx + vy * vy + vz * vz)
        if vl > cap then
            local g = cap / vl
            vx, vy, vz = vx * g, vy * g, vz * g
        end
        dx, dy, dz = dx + vx * dt, dy + vy * dt, dz + vz * dt
        local dl = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dl < 1e-6 then
            dx, dy, dz, dl = tx, ty, tz, 1
        end
        dx, dy, dz = dx / dl, dy / dl, dz / dl
        -- TWO CAPS, and the second is not optional.
        --
        -- maxLag is relative to the parent-carried target, which is what
        -- makes the wave: every bone is allowed to be a little behind the
        -- one above it. But relative caps COMPOUND — six bones at 28° each
        -- is 168°, and a chain held under a steady shove saturates every
        -- joint and folds the tail through the animal. So maxBend caps the
        -- angle from the bone's OWN rest as well, whatever its parents did.
        -- Both are eased through the same knee, never snapped.
        dx, dy, dz = ease(dx, dy, dz, tx, ty, tz, cfg.maxLag, cfg.soft)
        dx, dy, dz = ease(dx, dy, dz, b.rx, b.ry, b.rz, cfg.maxBend, cfg.soft)
        local cosA = math.max(-1, math.min(1, dx * tx + dy * ty + dz * tz))
        local ang = math.acos(cosA)
        st.dx[k], st.dy[k], st.dz[k] = dx, dy, dz
        st.vx[k], st.vy[k], st.vz[k] = vx, vy, vz
        if math.abs(ang) > 1e-4 or (vx * vx + vy * vy + vz * vz) > 1e-8 then
            moving = true
        end
        -- This bone's own extra turn, on top of what it inherited.
        rotBetween(tx, ty, tz, dx, dy, dz, _q)
        mul3(_q, _acc, _nxt)
        for i = 1, 9 do
            _acc[i] = _nxt[i]
        end
        -- The bend for this bone: rotate about the head it actually has now
        -- (`px,py,pz`), by everything accumulated. A 3x4, canonical.
        local m = out[b.slot]
        if m == nil then
            m = table.create(12, 0)
            out[b.slot] = m
        end
        m[1], m[2], m[3] = _acc[1], _acc[2], _acc[3]
        m[5], m[6], m[7] = _acc[4], _acc[5], _acc[6]
        m[9], m[10], m[11] = _acc[7], _acc[8], _acc[9]
        -- t = p - R * h, so the bone's REST head maps to where the chain has
        -- carried it. Using the rest head on both sides would rotate every
        -- bone about its own original joint and tear the chain into pieces
        -- that each look fine on their own.
        m[4] = px - (_acc[1] * b.hx + _acc[2] * b.hy + _acc[3] * b.hz)
        m[8] = py - (_acc[4] * b.hx + _acc[5] * b.hy + _acc[6] * b.hz)
        m[12] = pz - (_acc[7] * b.hx + _acc[8] * b.hy + _acc[9] * b.hz)
        -- The next joint sits at the end of this bone, wherever it now points.
        px += dx * b.len
        py += dy * b.len
        pz += dz * b.len
    end
    st.live = moving
    return moving
end

return M
