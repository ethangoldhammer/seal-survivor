-- ============================================================================
-- THE TANK RIG — the glue between the pack's skeletons, bonespring.luau's
-- solver and the GPU. table.luau calls four things here and holds none of
-- the arithmetic.
--
-- Its own module rather than four more functions in table.luau, and for a
-- concrete reason: added there, they pushed the file past Luau's
-- type-inference budget, which does not report as "this function is too
-- big" — it reports as `Code is too complex to typecheck` pointing at an
-- unrelated table constructor three hundred lines away, and then a cascade
-- of `Internal error: Lambda has non-function type`. A module gets its own
-- budget, so this is a structural fix rather than a smaller one.
--
--   loadRig       the pack's bones and chains for one species (TNK3)
--   ensureBend    its per-instance bend palette, sized to the instance buffer
--   stepRig       one body, one frame: shove the chains and solve them
--   writeBendRow  ...and into the texture, once the instances are laid out
--
-- `Species` is table.luau's and is taken as `any` here: this module reaches
-- for six of its fields and typing the whole record across the boundary is
-- what the budget above is made of.
-- ============================================================================

local BSPRING = require('bonespring')

local M = {}

-- THE RIG (TNK3). The bones block gives every slot its parent and its rest
-- head; the chains block gives the runs of them a contact may shove. Its own
-- function, and not because it is reused: inlined into loadFish it pushed
-- the whole module past Luau's type-inference budget, which reports as
-- "Code is too complex to typecheck" pointing at a line of somebody else's
-- code three hundred lines away.
--
-- A chain's bone points at the NEXT one in the chain. The tip has no next,
-- so it takes a real child of its own if the rig has one and otherwise
-- carries straight on at the previous bone's length. That fallback is
-- load-bearing: a chain ending on a LEAF whose direction came out
-- zero-length has a DEAD final bone, and nothing says so — the chain still
-- springs, just with its tip frozen, which reads as bad tuning.
function M.loadRig(sp: any, data: buffer, r: number, boneStart: number, chainStart: number, BREC: number)

        local bofs = buffer.readu32(data, r + 64)
        local nchain = buffer.readu32(data, r + 68)
        local cofs = buffer.readu32(data, r + 72)
        local head: { number } = {}
        for sl = 0, sp.bones - 1 do
            local o = boneStart + (bofs + sl) * BREC
            sp.boneParent[sl + 1] = buffer.readu32(data, o)
            head[sl * 3 + 1] = buffer.readf32(data, o + 4)
            head[sl * 3 + 2] = buffer.readf32(data, o + 8)
            head[sl * 3 + 3] = buffer.readf32(data, o + 12)
        end
        local firstChildOf: { [number]: number } = {}
        for sl = 0, sp.bones - 1 do
            local par = sp.boneParent[sl + 1]
            if par ~= 0xFFFFFFFF and firstChildOf[par] == nil then
                firstChildOf[par] = sl
            end
        end
        local w = chainStart + cofs * 4
        for _ = 1, nchain do
            local role = buffer.readu32(data, w)
            local cnt = buffer.readu32(data, w + 4)
            w += 8
            local slots: { number } = {}
            for j = 1, cnt do
                slots[j] = buffer.readu32(data, w)
                w += 4
            end
            local bones: any = {}
            for j = 1, cnt do
                local sl = slots[j]
                local hx = head[sl * 3 + 1] :: number
                local hy = head[sl * 3 + 2] :: number
                local hz = head[sl * 3 + 3] :: number
                -- Where this bone POINTS: at the next bone of the chain. The
                -- tip has no next, so it takes a real child of its own if
                -- the rig gives it one, and otherwise carries straight on at
                -- the previous bone's length.
                local nsl = -1
                if j < cnt then
                    nsl = slots[j + 1]
                else
                    local kid = firstChildOf[sl]
                    if kid ~= nil then
                        nsl = kid
                    end
                end
                local dx, dy, dz, len = 0, 0, 0, 0
                if nsl >= 0 then
                    dx = (head[nsl * 3 + 1] :: number) - hx
                    dy = (head[nsl * 3 + 2] :: number) - hy
                    dz = (head[nsl * 3 + 3] :: number) - hz
                    len = math.sqrt(dx * dx + dy * dy + dz * dz)
                end
                if len < 1e-6 and j > 1 then
                    local prev = bones[j - 1]
                    dx, dy, dz, len = prev.rx, prev.ry, prev.rz, prev.len
                elseif len < 1e-6 then
                    dx, dy, dz, len = 0, 0, 1, 0.05
                else
                    dx, dy, dz = dx / len, dy / len, dz / len
                end
                bones[j] = { slot = sl, hx = hx, hy = hy, hz = hz, rx = dx, ry = dy, rz = dz, len = len }
            end
            table.insert(sp.chains, { role = role, bones = bones })
        end
end


-- THE BEND PALETTE. One row per instance of this species, three texels a
-- bone, identity until something is hit. Sized to `cap`, so it is rebuilt
-- whenever the instance buffer is — and with it the bind group, because the
-- texture it names is gone. A species with no rig still gets a 1x1-bone
-- identity so the shader has a texel to read and one code path to run.
function M.ensureBend(self: any, sp: any)
    local rows = math.max(1, sp.cap)
    if sp.bend ~= nil and sp.bendRows >= rows then
        return
    end
    local bones = math.max(1, sp.bones)
    local bytes = bones * rows * 48
    local bb = buffer.create(bytes)
    for row = 0, rows - 1 do
        for bn = 0, bones - 1 do
            local o = (row * bones + bn) * 48
            buffer.writef32(bb, o + 0, 1)
            buffer.writef32(bb, o + 20, 1)
            buffer.writef32(bb, o + 40, 1)
        end
    end
    sp.bendBytes = bb
    sp.bendRows = rows
    sp.bendLive = {}
    local ok, tex = pcall(function()
        local t = GPUTexture.new({ width = bones * 3, height = rows, format = 'rgba32float', label = `tank bend {sp.name}` })
        t:upload({ data = bb })
        return t
    end)
    if not ok then
        print(`sealitaire: {sp.name}: bend palette failed ({tex}); no skeleton reaction`)
        sp.bend = nil
        return
    end
    sp.bend = tex
    if self.fishBindLayout ~= nil and sp.palette ~= nil then
        sp.bind = GPUBindGroup.new({
            layout = self.fishBindLayout,
            ubos = { { slot = 0, buffer = self.fishUbo :: GPUBuffer } },
            textures = { { slot = 1, view = (sp.palette :: GPUTexture):view() }, { slot = 2, view = (tex :: GPUTexture):view() } },
        })
    end
end

-- ONE BODY's skeleton, one frame. Shoved by whatever contact baitball
-- reported — the RAW one, not the throttled knock, so a graze too quiet to
-- hear still moves the animal — then solved. The result is held on the body
-- (`f.rig.out`), because the solve needs `dt` and the row it will be
-- uploaded to is not known until the instances are laid out.
function M.stepRig(sp: any, f: any, dt: number, cfg: any)
    local st = f.rig
    if st == nil then
        st = { chain = {}, out = {}, live = false, dirty = false }
        for ci, c in ipairs(sp.chains) do
            st.chain[ci] = BSPRING.rest(c)
        end
        f.rig = st
    end
    if f.dkick > 0 then
        local amp = f.dkick * cfg.impulse
        for ci, c in ipairs(sp.chains) do
            BSPRING.impulse(c, st.chain[ci], f.dnx, f.dny, f.dnz, amp, f.dz0, cfg.spread)
        end
    end
    table.clear(st.out)
    local live = false
    for ci, c in ipairs(sp.chains) do
        if BSPRING.solve(c, st.chain[ci], dt, cfg, st.out) then
            live = true
        end
    end
    -- The frame it falls ASLEEP still has to be written, to put its row back
    -- to identity; without that the last pose it held is frozen into the
    -- texture for ever and the animal never straightens out.
    st.dirty = live or st.live
    st.live = live
end

-- ...and into its row of the bend palette, once the instances are laid out.
-- ...and into its row of the bend palette, once the instances are laid out.
--
-- EVERY body writes EVERY frame, and skipping the ones that have not moved
-- is wrong however tempting it looks. A row is a POSITION in the species'
-- instance buffer, not a body: the order comes from the tableau and it
-- changes whenever a card is picked up, played or dropped — which is
-- exactly when the tanks are being shaken. Skip a sleeping body and it
-- wears whatever the last body to hold that row was doing. It costs twelve
-- floats a bone, and a species with no chains never reaches here at all.
function M.writeBendRow(sp: any, f: any, row: number)
    local st = f.rig
    if st == nil or sp.bend == nil or row >= sp.bendRows then
        return
    end
    -- The UPLOAD still only happens when something moved, or when something
    -- has just stopped and its row has to go back to identity.
    if st.dirty then
        sp.bendDirty = true
    end
    st.dirty = false
    -- Every slot, in order. A bone the chains did not touch INHERITS its
    -- parent's bend — the slots are topologically sorted (the baker's test
    -- holds parent < slot), so one pass is enough. Without it a fin hanging
    -- off a sprung spine would stay where it was while the body moved.
    local eff: any = {}
    local base = row * sp.bones * 48
    local bb = sp.bendBytes
    for sl = 0, sp.bones - 1 do
        local m = st.out[sl]
        if m == nil then
            local par = sp.boneParent[sl + 1]
            if par ~= nil and par ~= 0xFFFFFFFF then
                m = eff[par + 1]
            end
        end
        eff[sl + 1] = m
        local o = base + sl * 48
        if m == nil then
            for j = 0, 11 do
                buffer.writef32(bb, o + j * 4, 0)
            end
            buffer.writef32(bb, o + 0, 1)
            buffer.writef32(bb, o + 20, 1)
            buffer.writef32(bb, o + 40, 1)
        else
            for j = 1, 12 do
                buffer.writef32(bb, o + (j - 1) * 4, m[j])
            end
        end
    end
end

return M
