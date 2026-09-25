-- ============================================================================
-- THE SEAL, IN THE WELL — sealitaire's animal, doing the player's work.
--
-- The rig, the mesh, the swim and the celebrations are sealitaire's, byte for
-- byte: seal.mesh, seal.wgsl, puppet.luau and react.luau are copies kept
-- identical by `npm run test:wetrisshared`. What is wetris's is here:
--
--   WHERE IT SWIMS   a station beside the well at the live piece's height
--                    (motion.luau's 'card'), on whichever side the piece is
--                    nearer, below the hold and queue previews. A line clear
--                    sends it out to the open water to celebrate ('stage').
--   ITS FINS         the flipper on the piece's side of the body points AT
--                    the piece — the same measured two-step IK sealitaire uses
--                    to point at a card (aimFin) — and every input the player
--                    gives is a FLICK of that flipper: react.luau's swipe (a
--                    wind-up, the sweep, a settle) laid on top of the aim.
--                    A turn sweeps it clockwise or counter-clockwise with the
--                    piece; a move sweeps the tip the way the piece went.
--
-- The rules have already moved the piece by the time the flick starts: the
-- flick is the seal's answer to the input, never a delay on it. A stacker
-- that waits for an animation to finish before it moves the piece is a
-- stacker nobody can play.
--
-- NAMED swimmer, not seal: a script called `seal` collides with seal.wgsl in
-- the build, which then parses the shader as Luau.
--
-- A module of its own rather than more of board.luau for the reason
-- sealitaire's table.luau keeps writing down: Luau's inference budget is per
-- file, and the rig is enough annotated arithmetic to spend it.
-- ============================================================================

local PUPPET = require('puppet')
local REACT = require('react')
local MOTION = require('motion')
local CUBES = require('cubes')

local BONES = 28
local SEAL_BONES_AT = 64 + 64 + 16 * 5
local SEAL_UBO = SEAL_BONES_AT + BONES * 64

-- Slots, not names: bone names are not in the blob (tools/sealitaire-mesh.mjs).
local NECK: { number } = { 7, 8, 9 }
local NECK_SHARE: { number } = { 0.3, 0.35, 0.35 }
local TAIL: { number } = { 21, 22, 25 }
local TAIL_GAIN: { number } = { 0.5, 0.8, 1.0 }
local SHOULDER_L, SHOULDER_R = 13, 17
local MOUTH = 10
-- The flippers root to tip, and the wrist whose origin is the tip being aimed.
-- Chain 1 is model +x: the side a POSITIVE body bearing points to.
local FIN_CHAINS: { { number } } = { { 13, 14, 15 }, { 17, 18, 19 } }
local FIN_TIPS: { number } = { 16, 20 }
local FIN_SHARE: { number } = { 0.5, 0.3, 0.2 }

-- THE LIVE VALUES: tuning.luau's rows, which the tuner panel moves (T, then
-- SAVE writes them back). Read every frame, so a knob answers at once.
local S = require('tuner').T

export type Vec = PUPPET.Vec

-- What board.luau hands over each frame.
export type Scene = {
    w: number, h: number,
    L: number,              -- body length, px
    station: Vec,           -- where to hold beside the well
    piece: Vec?,            -- the live piece's centre, when there is one
    stage: Vec,             -- where to celebrate
    side: number,           -- -1 the station is left of the well, +1 right
    reactSeq: number,       -- bumped by the board on a clear
    reactVariant: string,
}

export type Seal = {
    puppet: PUPPET.Puppet,
    ready: boolean,
    data: buffer?,
    clips: { [string]: PUPPET.Clip },
    boneParent: { number },
    boneLocal: { Mat4 },
    boneIbm: { Mat4 },
    boneWorld: { Mat4 },
    boneSkin: { Mat4 },
    boneAnim: { Mat4 },
    verts: GPUBuffer?,
    index: GPUBuffer?,
    icount: number,
    pipe: GPUPipeline?,
    ubo: GPUBuffer?,
    bind: GPUBindGroup?,
    bytes: buffer,
    canvas: GPUCanvas?,
    depth: GPUTexture?,
    depthView: GPUTextureView?,
    L: number,
    side: number,
    gazeYaw: number, gazeVYaw: number, gazePitch: number, gazeVPitch: number,
    -- the fins, by chain
    aimOn: { number }, aimOnV: { number },
    aimX: { number }, aimY: { number }, aimVX: { number }, aimVY: { number },
    want: { number },
    flickT: { number }, flickDir: { number },
    -- the cube seal (cubes.luau, voxel.wgsl): its own pipeline on the same
    -- uniforms, rebuilt when voxelRes or the fill's open/closed side moves
    cubePipe: GPUPipeline?,
    cubeBind: GPUBindGroup?,
    cubeVerts: GPUBuffer?,
    cubeIndex: GPUBuffer?,
    cubeCount: number,
    cubeRes: number,
    cubeOpen: boolean,
    cubeStrand: number,
}

local M = {}

local function spring(x: number, v: number, target: number, dt: number, k: number, d: number): (number, number)
    local a = k * (target - x) - d * v
    v += a * dt
    x += v * dt
    return x, v
end

local function clamp(v: number, lo: number, hi: number): number
    return math.max(lo, math.min(hi, v))
end

local function wrapPi(a: number): number
    while a > math.pi do
        a -= math.pi * 2
    end
    while a < -math.pi do
        a += math.pi * 2
    end
    return a
end

local function readMat4(buf: buffer, at: number): Mat4
    local v = table.create(16, 0)
    for k = 1, 16 do
        v[k] = buffer.readf32(buf, at + (k - 1) * 4)
    end
    return Mat4.values(v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14], v[15], v[16])
end

function M.new(x: number, y: number): Seal
    return {
        puppet = PUPPET.new(x, y),
        ready = false,
        data = nil,
        clips = {},
        boneParent = {}, boneLocal = {}, boneIbm = {}, boneWorld = {}, boneSkin = {}, boneAnim = {},
        verts = nil, index = nil, icount = 0,
        pipe = nil, ubo = nil, bind = nil, bytes = buffer.create(SEAL_UBO),
        canvas = nil, depth = nil, depthView = nil,
        L = 200,
        side = -1,
        gazeYaw = 0, gazeVYaw = 0, gazePitch = 0, gazeVPitch = 0,
        aimOn = { 0, 0 }, aimOnV = { 0, 0 },
        aimX = { 0, 0 }, aimY = { 0, 0 }, aimVX = { 0, 0 }, aimVY = { 0, 0 },
        want = { 0, 0 },
        flickT = { -1, -1 }, flickDir = { 0, 0 },
        cubePipe = nil, cubeBind = nil, cubeVerts = nil, cubeIndex = nil,
        cubeCount = 0, cubeRes = 0, cubeOpen = false, cubeStrand = 0,
    }
end

-- The mesh, the rig, the clips and the pipeline — sealitaire's loadSeal,
-- without the bubble sources it measures for its shedding.
function M.load(s: Seal, context: Context): boolean
    local blob = context:blob('seal')
    local shader = context:shader('seal')
    if blob == nil or shader == nil then
        print('wetris: seal.mesh or seal.wgsl missing; no seal')
        return false
    end
    local data = blob.data
    if buffer.readu8(data, 0) ~= 83 then -- 'S'
        print('wetris: seal.mesh has the wrong magic')
        return false
    end
    local vcount = buffer.readu32(data, 4)
    local icount = buffer.readu32(data, 8)
    local bcount = buffer.readu32(data, 12)
    if bcount ~= BONES then
        print(`wetris: seal.mesh has {bcount} bones, shader expects {BONES}`)
        return false
    end
    local STRIDE = 48
    local vbytes = vcount * STRIDE
    local ibytes = icount * 4
    local vbuf = buffer.create(vbytes)
    buffer.copy(vbuf, 0, data, 16, vbytes)
    local ibuf = buffer.create(ibytes)
    buffer.copy(ibuf, 0, data, 16 + vbytes, ibytes)
    s.verts = GPUBuffer.new({ size = vbytes, usage = 'vertex', data = vbuf, immutable = true, label = 'seal verts' })
    s.index = GPUBuffer.new({ size = ibytes, usage = 'index', data = ibuf, immutable = true, label = 'seal index' })
    s.icount = icount
    local at = 16 + vbytes + ibytes
    for b = 1, bcount do
        s.boneParent[b] = buffer.readi32(data, at) + 1
        s.boneLocal[b] = readMat4(data, at + 4)
        s.boneIbm[b] = readMat4(data, at + 68)
        s.boneWorld[b] = Mat4.identity()
        s.boneSkin[b] = Mat4.identity()
        s.boneAnim[b] = Mat4.identity()
        at += 4 + 64 + 64
    end
    s.clips = PUPPET.readClips(data, at, bcount)
    s.data = data
    s.pipe = GPUPipeline.new({
        vertex = shader,
        fragment = shader,
        vertexLayout = {
            {
                stride = STRIDE,
                attributes = {
                    { format = 'float32x3', slot = 0, offset = 0 },
                    { format = 'float32x3', slot = 1, offset = 12 },
                    { format = 'float32x3', slot = 2, offset = 24 },
                    { format = 'uint8x4', slot = 3, offset = 36 },
                    { format = 'unorm8x4', slot = 4, offset = 40 },
                },
            },
        },
        colorTargets = { { format = 'rgba8unorm' } },
        depthStencil = { format = 'depth32float', compare = 'less', write = true },
        cullMode = 'none',
        label = 'seal',
    })
    s.ubo = GPUBuffer.new({ size = SEAL_UBO, usage = 'uniform', label = 'seal ubo' })
    s.bind = GPUBindGroup.new({
        layout = (s.pipe :: GPUPipeline):getBindGroupLayout(0),
        ubos = { { slot = 0, buffer = s.ubo :: GPUBuffer } },
    })
    local cubeShader = context:shader('voxel')
    if cubeShader ~= nil then
        s.cubePipe = GPUPipeline.new({
            vertex = cubeShader,
            fragment = cubeShader,
            vertexLayout = {
                {
                    stride = CUBES.STRIDE,
                    attributes = {
                        { format = 'float32x3', slot = 0, offset = 0 },
                        { format = 'float32x3', slot = 1, offset = 12 },
                        { format = 'float32x3', slot = 2, offset = 24 },
                        { format = 'uint8x4', slot = 3, offset = 36 },
                        { format = 'unorm8x4', slot = 4, offset = 40 },
                        { format = 'float32x3', slot = 5, offset = 44 },
                        { format = 'float32x2', slot = 6, offset = 56 },
                    },
                },
            },
            colorTargets = { { format = 'rgba8unorm' } },
            depthStencil = { format = 'depth32float', compare = 'less', write = true },
            cullMode = 'none',
            label = 'seal cubes',
        })
        s.cubeBind = GPUBindGroup.new({
            layout = (s.cubePipe :: GPUPipeline):getBindGroupLayout(0),
            ubos = { { slot = 0, buffer = s.ubo :: GPUBuffer } },
        })
    else
        print('wetris: voxel.wgsl missing; the seal stays smooth')
    end
    s.ready = true
    return true
end

-- The cube mesh for the live voxelRes, rebuilt only when it (or whether the
-- cubes are shrunk apart) has changed. A drag across the slider rebuilds once
-- per whole step.
local function cubesFor(s: Seal)
    local data = s.data
    if data == nil or s.cubePipe == nil then
        return
    end
    local res = math.floor(S.voxelRes + 0.5)
    local open = S.voxelFill < 0.999
    local strand = math.floor(S.voxelWhisker * 100 + 0.5) / 100
    if res == s.cubeRes and open == s.cubeOpen and strand == s.cubeStrand and s.cubeVerts ~= nil then
        return
    end
    local built = CUBES.build(data, res, open, strand)
    s.cubeVerts = GPUBuffer.new({ size = buffer.len(built.vbuf), usage = 'vertex', data = built.vbuf, immutable = true, label = 'seal cube verts' })
    s.cubeIndex = GPUBuffer.new({ size = buffer.len(built.ibuf), usage = 'index', data = built.ibuf, immutable = true, label = 'seal cube index' })
    s.cubeCount = built.icount
    s.cubeRes, s.cubeOpen, s.cubeStrand = res, open, strand
    print(`wetris: seal in {built.cubes} cubes ({built.strands} on the whiskers), {built.faces} faces at {res}`)
end

-- The seal's canvas, full screen with a depth buffer. Rebuilt with the rest
-- of the GPU side on a resize.
function M.build(s: Seal, context: Context, pw: number, ph: number): GPUCanvas
    s.canvas = context:gpuCanvas({ width = pw, height = ph })
    s.depth = GPUTexture.new({ width = pw, height = ph, format = 'depth32float', renderTarget = true, label = 'seal depth' })
    s.depthView = (s.depth :: GPUTexture):view()
    return s.canvas :: GPUCanvas
end

-- ---------------------------------------------------------------------------
-- The fins: sealitaire's finBearing / swingFin / aimFin, unchanged.

local function finBearing(s: Seal, root: number, tip: number): number
    local a = s.boneWorld[root]:transformPoint(0, 0, 0)
    local b = s.boneWorld[tip]:transformPoint(0, 0, 0)
    return math.atan2(b.x - a.x, b.z - a.z)
end

local function swingFin(s: Seal, chain: { number }, tip: number, by: number)
    local acc: Mat4 = Mat4.identity()
    for i = 1, #chain do
        local b: number = chain[i]
        local w: Mat4 = Mat4.multiply(Mat4.identity(), acc, s.boneWorld[b])
        local o = w:transformPoint(0, 0, 0)
        local turn: Mat4 = Mat4.multiply(Mat4.identity(), Mat4.fromTranslation(o.x, o.y, o.z), Mat4.fromRotationY(by * FIN_SHARE[i]))
        turn = Mat4.multiply(Mat4.identity(), turn, Mat4.fromTranslation(-o.x, -o.y, -o.z))
        s.boneWorld[b] = Mat4.multiply(Mat4.identity(), turn, w)
        acc = Mat4.multiply(Mat4.identity(), turn, acc)
    end
    s.boneWorld[tip] = Mat4.multiply(Mat4.identity(), acc, s.boneWorld[tip])
end

-- Point one flipper at `want`, `weight` of the way, never more than finReach
-- off the clip's pose. Swing, MEASURE what the rig gave back, one secant step
-- to close the rest — the fan turns its tip by about four fifths of the ask.
local function aimFin(s: Seal, chain: { number }, tip: number, want: number, weight: number)
    if weight <= 0.002 then
        return
    end
    local root: number = chain[1]
    local have0: number = finBearing(s, root, tip)
    local trial: number = clamp(wrapPi(want - have0), -S.finReach, S.finReach) * weight
    if math.abs(trial) < 1e-4 then
        return
    end
    local goal: number = have0 + trial
    swingFin(s, chain, tip, trial)
    local have1: number = finBearing(s, root, tip)
    local got: number = wrapPi(have1 - have0)
    if math.abs(got) < 1e-4 then
        return
    end
    local lim: number = math.abs(trial)
    swingFin(s, chain, tip, clamp(wrapPi(goal - have1) * (trial / got), -lim, lim))
end

-- Both flippers, after the clips: the aim, the flick on top of it.
local function aimFins(s: Seal)
    local p = s.puppet
    for side = 1, 2 do
        local chain: { number } = FIN_CHAINS[side]
        local tip: number = FIN_TIPS[side]
        local want: number = s.want[side]
        if s.aimOn[side] > 0.002 then
            want = wrapPi(math.atan2(s.aimX[side] - p.x, -(s.aimY[side] - p.y)) - p.outHeading)
            s.want[side] = want
        end
        local weight: number = s.aimOn[side]
        local ft: number = s.flickT[side]
        if ft >= 0 then
            local u: number = ft / S.flickTime
            want += REACT.swipe(u) * S.flickArc * s.flickDir[side]
            -- A flick from a fin that was not pointing still has to be SEEN:
            -- it swings at the aim's weight for as long as it lasts.
            weight = math.max(weight, S.finAim * math.sin(math.min(1, u) * math.pi))
        end
        aimFin(s, chain, tip, want, weight)
        for i = 1, #chain do
            Mat4.multiply(s.boneSkin[chain[i]], s.boneWorld[chain[i]], s.boneIbm[chain[i]])
        end
        Mat4.multiply(s.boneSkin[tip], s.boneWorld[tip], s.boneIbm[tip])
    end
end

local function pose(s: Seal)
    local data = s.data
    if data == nil then
        return
    end
    local p = s.puppet
    PUPPET.buildLocals(p, data, s.clips, BONES, s.boneLocal, s.boneParent, s.boneAnim)
    local yaw, pitch = s.gazeYaw, s.gazePitch
    local wag = S.wagAmp * math.min(1, p.clipSpeed / math.max(0.1, S.moveThreshold))
    for b = 1, BONES do
        local localM = s.boneAnim[b]
        for n, slot in ipairs(NECK) do
            if slot == b then
                local share = NECK_SHARE[n] * S.gazeShare
                local m = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationZ(-yaw * share))
                localM = Mat4.multiply(Mat4.identity(), m, Mat4.fromRotationX(pitch * share))
            end
        end
        for n, slot in ipairs(TAIL) do
            if slot == b then
                local a = math.sin(p.time * S.wagSpeed - n * 0.8) * wag * TAIL_GAIN[n]
                localM = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationZ(a))
            end
        end
        if b == MOUTH then
            localM = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationX(p.jaw * S.jawOpen))
        end
        if p.clap > 0 and (b == SHOULDER_L or b == SHOULDER_R) then
            local sd = if b == SHOULDER_L then 1 else -1
            local a = S.clapRaise * p.clap
            local m = Mat4.multiply(Mat4.identity(), localM, Mat4.fromRotationZ(sd * a))
            localM = Mat4.multiply(Mat4.identity(), m, Mat4.fromRotationX(a))
        end
        local parent = s.boneParent[b]
        if parent > 0 then
            Mat4.multiply(s.boneWorld[b], s.boneWorld[parent], localM)
        else
            s.boneWorld[b] = localM
        end
        Mat4.multiply(s.boneSkin[b], s.boneWorld[b], s.boneIbm[b])
    end
    aimFins(s)
end

-- ---------------------------------------------------------------------------

-- Which flipper faces a point: the sign of its bearing off the nose.
local function sideOf(s: Seal, x: number, y: number): number
    local p = s.puppet
    local rel = wrapPi(math.atan2(x - p.x, -(y - p.y)) - p.outHeading)
    return if rel >= 0 then 1 else 2
end

-- THE FLICK. `dir` +1 sweeps the flipper clockwise on screen, -1 counter.
function M.flick(s: Seal, dir: number, x: number, y: number)
    local side = sideOf(s, x, y)
    s.flickT[side] = 0
    s.flickDir[side] = dir
    -- Pointed at the piece from the first frame, so the flick is aimed even
    -- when the fin had let go.
    if s.aimOn[side] < 0.02 then
        s.aimX[side], s.aimY[side] = x, y
        s.aimVX[side], s.aimVY[side] = 0, 0
    end
end

-- A MOVE is a flick whose TIP goes the way the piece went. A flipper pointing
-- up-screen sweeps its tip right by turning clockwise; one pointing down does
-- it by turning counter-clockwise — so the turn is read off where the fin
-- points on screen right now, not assumed.
function M.flickMove(s: Seal, dx: number, x: number, y: number)
    local p = s.puppet
    local screen = math.atan2(x - p.x, -(y - p.y))
    local dir = if math.cos(screen) >= 0 then dx else -dx
    M.flick(s, dir, x, y)
end

function M.update(s: Seal, dt: number, sc: Scene)
    local p = s.puppet
    s.L = sc.L
    -- Turned in toward the well from whichever side it is on.
    if sc.side ~= s.side then
        s.side = sc.side
    end
    MOTION.card.heading = -0.25 * s.side
    MOTION.card.roll = 0.12 * s.side

    local card: Vec? = sc.station
    local cursor: Vec? = sc.piece
    local stage: Vec? = sc.stage
    local none: Vec? = nil
    local frame = {
        w = sc.w, h = sc.h, L = sc.L,
        pxUnit = sc.L / 1.68,
        row = sc.station,
        stage = stage,
        reactSeq = sc.reactSeq, reactVariant = sc.reactVariant, reactSpeed = S.reactSpeed,
        card = if sc.piece ~= nil then card else none,
        cursor = cursor,
        corner = none,
        mouthDx = 0, mouthDy = 0,
        biting = false,
        releaseT = -1,
        dragging = false,
        won = false,
        thrust = S.thrust, friction = S.friction, maxSpeed = S.maxSpeed, turnLerp = S.turnLerp, steer = S.steer,
        landEase = S.landEase, lean = S.lean,
        arrive = S.arrive, blendRate = S.blendRate, blendTime = S.blendTime, turnSettle = S.turnSettle,
        moveThreshold = S.moveThreshold, boostThreshold = S.boostThreshold, crossfade = S.crossfade,
        clipScale = S.clipScale,
        bobAmp = 0.035, bobPeriod = 2.8,
        biteOffset = 0, biteHold = 0, jawClamp = 0,
        releaseTime = 1, releaseLift = S.releaseLift, releasePush = 0,
        steerTight = S.steerTight,
    }
    PUPPET.update(p, dt, frame)

    -- THE AIM. The point springs, the angle is taken off it live in aimFins,
    -- so the flipper stays on the piece however the body swims — the
    -- argument sealitaire's updateFins makes at length. The fin on the
    -- piece's side of the body points; the other lets go. A celebration's
    -- clap owns both shoulders, so the aim stands down for it.
    local k, damp = S.finEase * S.finEase, S.finEase * 1.8
    local room = 1 - math.min(1, p.clap)
    local piece = sc.piece
    local faces = if piece ~= nil then sideOf(s, piece.x, piece.y) else 0
    for side = 1, 2 do
        local on = 0
        if piece ~= nil and side == faces and not PUPPET.reacting(p) then
            if s.aimOn[side] < 0.02 then
                s.aimX[side], s.aimY[side] = piece.x, piece.y
                s.aimVX[side], s.aimVY[side] = 0, 0
            else
                s.aimX[side], s.aimVX[side] = spring(s.aimX[side], s.aimVX[side], piece.x, dt, k * 4, damp * 2)
                s.aimY[side], s.aimVY[side] = spring(s.aimY[side], s.aimVY[side], piece.y, dt, k * 4, damp * 2)
            end
            on = S.finAim * room
        end
        s.aimOn[side], s.aimOnV[side] = spring(s.aimOn[side], s.aimOnV[side], on, dt, k, damp)
        if s.flickT[side] >= 0 then
            s.flickT[side] += dt
            if s.flickT[side] >= S.flickTime then
                s.flickT[side] = -1
            end
        end
    end

    if s.ready then
        pose(s)
    end

    if p.lookOn then
        local rel = wrapPi(math.atan2(p.look.x - p.x, -(p.look.y - p.y)) - p.outHeading)
        s.gazeYaw, s.gazeVYaw = spring(s.gazeYaw, s.gazeVYaw, clamp(rel, -1.1, 1.1), dt, 60, 11)
        s.gazePitch, s.gazeVPitch = spring(s.gazePitch, s.gazeVPitch, -p.lookOut * 0.35, dt, 60, 11)
    else
        s.gazeYaw, s.gazeVYaw = spring(s.gazeYaw, s.gazeVYaw, 0, dt, 60, 11)
        s.gazePitch, s.gazeVPitch = spring(s.gazePitch, s.gazeVPitch, 0, dt, 60, 11)
    end
end

-- sealitaire's sealModel: an orthographic window onto the artboard in px; the
-- figure is 2.125 units long at bind, nose at +z, back at +y.
local function model(s: Seal): Mat4
    local p = s.puppet
    local px = s.L / 2.125
    local lift = math.min(1, p.lift + p.reactLift)
    local grow = px * (1 + lift * S.releaseLift)
    return Mat4.fromTranslation(p.x, p.y, lift * 300)
        * Mat4.fromRotationZ(p.outHeading)
        * Mat4.fromRotationY(p.outRoll)
        * Mat4.fromRotationX(math.rad(90) - p.lift * 1.1 + p.outPitch)
        * Mat4.fromScale(grow, grow, grow)
        * Mat4.fromTranslation(0.02, -0.16, 0.04)
end

-- Into its own canvas, cleared to nothing; crt.wgsl lays it over the scene.
function M.draw(s: Seal, w: number, h: number, energy: number)
    local canvas, pipe, ubo, bind = s.canvas, s.pipe, s.ubo, s.bind
    local verts, index, depthView = s.verts, s.index, s.depthView
    if canvas == nil or pipe == nil or ubo == nil or bind == nil or verts == nil or index == nil or depthView == nil then
        return
    end
    if not s.ready then
        local empty = canvas:beginRenderPass({
            color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
        })
        empty:finish()
        return
    end
    local proj = Mat4.ortho(0, w, h, 0, -4000, 4000)
    local m = model(s)
    local mvp = proj * m
    local b = s.bytes
    mvp:writeToBuffer(b, 0)
    m:writeToBuffer(b, 64)
    buffer.writef32(b, 128, -0.45)
    buffer.writef32(b, 132, -0.6)
    buffer.writef32(b, 136, 0.8)
    buffer.writef32(b, 140, 0)          -- split: nothing is in the mouth
    buffer.writef32(b, 144, 1.0)
    buffer.writef32(b, 148, 0.96)
    buffer.writef32(b, 152, 0.9)
    local cubes = S.voxelOn > 0.5 and s.cubePipe ~= nil
    -- A cube's side faces meet the eye edge-on all over the body, not just at
    -- the silhouette, so the rim is turned down for them.
    buffer.writef32(b, 156, (S.rim + energy * 0.5) * (if cubes then S.voxelRim else 1))
    buffer.writef32(b, 160, S.mottleSize)
    buffer.writef32(b, 164, S.mottleStrength)
    buffer.writef32(b, 168, S.mottleContrast)
    buffer.writef32(b, 172, 0.0)
    buffer.writef32(b, 176, 0.02)
    buffer.writef32(b, 180, 0.05)
    buffer.writef32(b, 184, 0.09)
    if cubes then
        cubesFor(s)
    end
    -- voxel.wgsl's fill; seal.wgsl never reads it
    buffer.writef32(b, 188, S.voxelFill)
    -- layer: this is the OVER pass, and the body is never behind anything.
    buffer.writef32(b, 192, 1.0)
    buffer.writef32(b, 196, 0)
    -- voxel.wgsl's bevel; seal.wgsl never reads it
    buffer.writef32(b, 200, 0)
    buffer.writef32(b, 204, S.voxelEdge)
    for k = 1, BONES do
        s.boneSkin[k]:writeToBuffer(b, SEAL_BONES_AT + (k - 1) * 64)
    end
    ubo:write(b)
    local rp = canvas:beginRenderPass({
        color = { { loadOp = 'clear', storeOp = 'store', clearColor = { 0, 0, 0, 0 } } },
        depthStencil = { view = depthView, depthLoadOp = 'clear', depthStoreOp = 'discard', depthClearValue = 1 },
    })
    local cubePipe, cubeBind, cubeVerts, cubeIndex = s.cubePipe, s.cubeBind, s.cubeVerts, s.cubeIndex
    if cubes and cubePipe ~= nil and cubeBind ~= nil and cubeVerts ~= nil and cubeIndex ~= nil then
        rp:setPipeline(cubePipe)
        rp:setBindGroup(0, cubeBind)
        rp:setVertexBuffer(0, cubeVerts)
        rp:setIndexBuffer(cubeIndex, 'uint32')
        rp:drawIndexed(s.cubeCount)
    else
        rp:setPipeline(pipe)
        rp:setBindGroup(0, bind)
        rp:setVertexBuffer(0, verts)
        rp:setIndexBuffer(index, 'uint32')
        rp:drawIndexed(s.icount)
    end
    rp:finish()
end

-- For the water: where the body is and how fast, for foam's froth and the
-- surface's wake.
function M.wake(s: Seal): (number, number, number, number)
    local p = s.puppet
    return p.x, p.y, p.outHeading, math.sqrt(p.vx * p.vx + p.vy * p.vy)
end

M.pick = REACT.pick

return M
