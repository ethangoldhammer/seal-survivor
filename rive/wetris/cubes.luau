-- ============================================================================
-- THE SEAL IN CUBES — seal.mesh voxelized at load, rebuilt when voxelRes moves.
--
-- The mesh is small (about 1.4k vertices), so this runs here rather than in a
-- bake tool, which is what lets the grid be a live slider. Four passes over a
-- grid laid on the BIND pose, cubes along the body's long axis (+z):
--
--   SURFACE   every triangle sampled at half a cell's pitch; a sampled cell is
--             skin. Each sample votes for its interpolated colour and its
--             bone weights. Colour is the MODE of the hide's small palette,
--             not the mean — the mean turns a black eye into a grey smudge —
--             and near-black votes four times, so an eye or a nose that only
--             grazes a cell still claims it.
--   TRIM      a skin cell is any cell the surface passes through, which
--             pads the animal by half a cube all round. So each skin cell
--             keeps the sample nearest its centre and is dropped if its
--             centre lies OUTSIDE the surface there: a cube is where the body
--             is, which is what keeps the silhouette slender. Then any cube
--             with no neighbour across a face goes too: a lone cube is a
--             speck, not part of the animal. (The whiskers never reach this
--             grid; STRANDS below gives them cubes of their own.) The flippers are thick
--             enough to survive both at 12 cubes and up.
--   STRANDS   the whiskers, which the trim would otherwise delete, are lined
--             with cubes of their own instead. A strand is any piece of the
--             mesh (triangles joined by an edge or a welded vertex) with under
--             a tenth of the body's triangles — the six whiskers, three a side.
--             They stay out of the body's grid entirely and are sampled onto
--             a finer one, voxelWhisker of a body cube, every cell they pass
--             through a cube: a strand of cubes the width of one. Hide colour,
--             never mottled (voxel.wgsl), skinned like the vertex nearest.
--   OUTSIDE   flood fill from the padded corner; whatever it cannot reach is
--             the animal (a leak just leaves a hollow shell, still correct).
--   INSIDE    a breadth-first spread from the skin gives each interior cell
--             the colour and bone of the skin nearest it. Those only show at
--             a joint, where a bent neck or a flipper opens the body.
--   FACES     each cube's CENTRE is skinned like the skin it came from (the
--             four heaviest bones its samples voted for, strongest first),
--             and its corners turn with that first bone alone — so it lands
--             where the smooth seal's surface is and stays a cube. Rigid
--             cubes on one bone each were tried first: the bind pose is
--             curled head-up and the clips bend it flat, so every joint piled
--             cubes on the inside of the bend and tore holes on the outside.
--             A face is left out only between two cubes with the SAME
--             weights, which move as one; anywhere else it is kept, so a
--             bend shows a lid, not a hole. With `open` (voxelFill under 1,
--             cubes shrunk apart) nothing is left out, since every face can
--             then be seen.
--
-- Vertex layout (64 bytes): seal.mesh's 48 — position, normal, colour, joints,
-- weights — then the cube's centre f32x3, which voxel.wgsl samples the
-- mottling at (one flat value per cube, the hide as pixels) and shrinks the
-- cube toward; the cube's half size f32 (body and whisker cubes differ); and
-- f32 1 on a whisker cube, which the shader leaves unmottled.
--
-- NAMED cubes, not voxel: a script and a shader of the same name collide in
-- the build (swimmer.luau's header).
-- ============================================================================

local M = {}

M.STRIDE = 64

local SRC_STRIDE = 48

-- The six faces: axis (1..3), sign.
local DIRS: { { number } } = { { 1, 1 }, { 1, -1 }, { 2, 1 }, { 2, -1 }, { 3, 1 }, { 3, -1 } }

export type Built = {
    vbuf: buffer,
    ibuf: buffer,
    icount: number,
    cubes: number,
    faces: number,
    strands: number,
}

local function key(r: number, g: number, b: number): number
    return math.floor(r * 40 + 0.5) * 1681 + math.floor(g * 40 + 0.5) * 41 + math.floor(b * 40 + 0.5)
end

-- Joints and weights as the shader reads them: heaviest first, packed.
local function pack(j: { number }, w: { number }): (number, number)
    local order = { 1, 2, 3, 4 }
    table.sort(order, function(p: number, q: number): boolean
        return w[p] > w[q]
    end)
    local tmp = buffer.create(8)
    for r = 1, 4 do
        buffer.writeu8(tmp, r - 1, j[order[r]])
        buffer.writeu8(tmp, 4 + r - 1, w[order[r]])
    end
    return buffer.readu32(tmp, 0), buffer.readu32(tmp, 4)
end

-- `data` is seal.mesh; `res` cubes nose to tail; `open` keeps every face;
-- `strandSize` a whisker cube's edge as a share of a body cube's.
function M.build(data: buffer, res: number, open: boolean, strandSize: number): Built
    local vcount = buffer.readu32(data, 4)
    local icount = buffer.readu32(data, 8)
    local vat = 16
    local iat = 16 + vcount * SRC_STRIDE

    local px: { number }, py: { number }, pz: { number } = {}, {}, {}
    local cr: { number }, cg: { number }, cb: { number } = {}, {}, {}
    local qx: { number }, qy: { number }, qz: { number } = {}, {}, {}
    local jn: { { number } }, wt: { { number } } = {}, {}
    local lo = { math.huge, math.huge, math.huge }
    local hi = { -math.huge, -math.huge, -math.huge }
    for i = 1, vcount do
        local o = vat + (i - 1) * SRC_STRIDE
        local x, y, z = buffer.readf32(data, o), buffer.readf32(data, o + 4), buffer.readf32(data, o + 8)
        px[i], py[i], pz[i] = x, y, z
        qx[i] = buffer.readf32(data, o + 12)
        qy[i] = buffer.readf32(data, o + 16)
        qz[i] = buffer.readf32(data, o + 20)
        cr[i] = buffer.readf32(data, o + 24)
        cg[i] = buffer.readf32(data, o + 28)
        cb[i] = buffer.readf32(data, o + 32)
        jn[i] = { buffer.readu8(data, o + 36), buffer.readu8(data, o + 37), buffer.readu8(data, o + 38), buffer.readu8(data, o + 39) }
        wt[i] = { buffer.readu8(data, o + 40), buffer.readu8(data, o + 41), buffer.readu8(data, o + 42), buffer.readu8(data, o + 43) }
        lo[1], lo[2], lo[3] = math.min(lo[1], x), math.min(lo[2], y), math.min(lo[3], z)
        hi[1], hi[2], hi[3] = math.max(hi[1], x), math.max(hi[2], y), math.max(hi[3], z)
    end

    -- STRANDS: pieces of the mesh, by union over triangles and welded
    -- positions, and which triangles belong to a small one.
    local tcount = icount // 3
    local root: { number } = table.create(vcount, 0)
    for i = 1, vcount do
        root[i] = i
    end
    local function find(i: number): number
        while root[i] ~= i do
            root[i] = root[root[i]]
            i = root[i]
        end
        return i
    end
    local function join(a: number, b: number)
        local ra, rb = find(a), find(b)
        if ra ~= rb then
            root[ra] = rb
        end
    end
    local welded: { [string]: number } = {}
    for i = 1, vcount do
        local k = `{px[i]},{py[i]},{pz[i]}`
        local other = welded[k]
        if other ~= nil then
            join(i, other)
        else
            welded[k] = i
        end
    end
    for t = 0, tcount - 1 do
        local a = buffer.readu32(data, iat + t * 12) + 1
        join(a, buffer.readu32(data, iat + t * 12 + 4) + 1)
        join(a, buffer.readu32(data, iat + t * 12 + 8) + 1)
    end
    local piece: { [number]: number } = {}
    local biggest = 0
    for t = 0, tcount - 1 do
        local r = find(buffer.readu32(data, iat + t * 12) + 1)
        piece[r] = (piece[r] or 0) + 1
        biggest = math.max(biggest, piece[r])
    end
    local isStrand: { boolean } = table.create(tcount, false)
    for t = 0, tcount - 1 do
        isStrand[t + 1] = piece[find(buffer.readu32(data, iat + t * 12) + 1)] < biggest * 0.1
    end

    local cell = (hi[3] - lo[3]) / math.max(4, res)
    local half = cell * 0.5
    -- One empty cell of padding all round, so the flood fill can go round.
    local ox, oy, oz = lo[1] - cell, lo[2] - cell, lo[3] - cell
    local nx = math.ceil((hi[1] - lo[1]) / cell) + 3
    local ny = math.ceil((hi[2] - lo[2]) / cell) + 3
    local nz = math.ceil((hi[3] - lo[3]) / cell) + 3
    local nxy = nx * ny
    local n = nxy * nz

    -- 0 unknown, 1 skin, 2 outside, 3 inside
    local state = buffer.create(n)
    local colVotes: { [number]: { [number]: number } } = {}
    local boneVotes: { [number]: { [number]: number } } = {}
    local palette: { [number]: { number } } = {}
    -- per skin cell: the nearest sample's squared distance from the centre,
    -- and whether the centre is on the inside of it
    local nearD: { [number]: number } = {}
    local nearIn: { [number]: boolean } = {}

    local function at(x: number, y: number, z: number): number
        local ix = math.clamp(math.floor((x - ox) / cell), 0, nx - 1)
        local iy = math.clamp(math.floor((y - oy) / cell), 0, ny - 1)
        local iz = math.clamp(math.floor((z - oz) / cell), 0, nz - 1)
        return ix + nx * iy + nxy * iz
    end

    -- The whiskers' grid: finer, keyed sparse; each cell remembers the
    -- vertex nearest the first sample that landed in it.
    local fine = cell * math.max(0.05, strandSize)
    local FK = 4096
    local strandCells: { [number]: number } = {}
    local strandOrder: { number } = {}

    -- SURFACE
    for t = 0, tcount - 1 do
        local a = buffer.readu32(data, iat + t * 12) + 1
        local b = buffer.readu32(data, iat + t * 12 + 4) + 1
        local c = buffer.readu32(data, iat + t * 12 + 8) + 1
        local e1 = math.sqrt((px[a] - px[b]) ^ 2 + (py[a] - py[b]) ^ 2 + (pz[a] - pz[b]) ^ 2)
        local e2 = math.sqrt((px[b] - px[c]) ^ 2 + (py[b] - py[c]) ^ 2 + (pz[b] - pz[c]) ^ 2)
        local e3 = math.sqrt((px[c] - px[a]) ^ 2 + (py[c] - py[a]) ^ 2 + (pz[c] - pz[a]) ^ 2)
        local tri = { a, b, c }
        if isStrand[t + 1] then
            local fsteps = math.max(1, math.ceil(math.max(e1, e2, e3) / (fine * 0.5)))
            for i = 0, fsteps do
                for j = 0, fsteps - i do
                    local u, v = i / fsteps, j / fsteps
                    local w = 1 - u - v
                    local fx = math.floor((px[a] * u + px[b] * v + px[c] * w - lo[1]) / fine) + 1
                    local fy = math.floor((py[a] * u + py[b] * v + py[c] * w - lo[2]) / fine) + 1
                    local fz = math.floor((pz[a] * u + pz[b] * v + pz[c] * w - lo[3]) / fine) + 1
                    local fk = fx + FK * (fy + FK * fz)
                    if strandCells[fk] == nil then
                        strandCells[fk] = if u >= v and u >= w then a elseif v >= w then b else c
                        table.insert(strandOrder, fk)
                    end
                end
            end
            continue
        end
        local steps = math.max(1, math.ceil(math.max(e1, e2, e3) / (cell * 0.5)))
        for i = 0, steps do
            for j = 0, steps - i do
                local u, v = i / steps, j / steps
                local w = 1 - u - v
                local bary = { u, v, w }
                local x = px[a] * u + px[b] * v + px[c] * w
                local y = py[a] * u + py[b] * v + py[c] * w
                local z = pz[a] * u + pz[b] * v + pz[c] * w
                local r = cr[a] * u + cr[b] * v + cr[c] * w
                local g = cg[a] * u + cg[b] * v + cg[c] * w
                local bl = cb[a] * u + cb[b] * v + cb[c] * w
                local id = at(x, y, z)
                buffer.writeu8(state, id, 1)
                local ix = id % nx
                local iy = (id // nx) % ny
                local iz = id // nxy
                local dx = ox + (ix + 0.5) * cell - x
                local dy = oy + (iy + 0.5) * cell - y
                local dz = oz + (iz + 0.5) * cell - z
                local d2 = dx * dx + dy * dy + dz * dz
                if d2 < (nearD[id] or math.huge) then
                    nearD[id] = d2
                    local sx = qx[a] * u + qx[b] * v + qx[c] * w
                    local sy = qy[a] * u + qy[b] * v + qy[c] * w
                    local sz = qz[a] * u + qz[b] * v + qz[c] * w
                    nearIn[id] = dx * sx + dy * sy + dz * sz <= 0
                end
                local k = key(r, g, bl)
                if palette[k] == nil then
                    palette[k] = { r, g, bl }
                end
                local votes = colVotes[id]
                if votes == nil then
                    votes = {}
                    colVotes[id] = votes
                end
                local luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl
                votes[k] = (votes[k] or 0) + (if luma < 0.1 then 4 else 1)
                local bones = boneVotes[id]
                if bones == nil then
                    bones = {}
                    boneVotes[id] = bones
                end
                for q = 1, 3 do
                    local vi = tri[q]
                    local jj, ww = jn[vi], wt[vi]
                    for s = 1, 4 do
                        if ww[s] > 0 then
                            bones[jj[s]] = (bones[jj[s]] or 0) + ww[s] * bary[q]
                        end
                    end
                end
            end
        end
    end

    -- Each skin cell's winners: its colour, and its four heaviest bones,
    -- heaviest first, the weights summing to exactly 255.
    local cellJ = buffer.create(n * 4)
    local cellW = buffer.create(n * 4)
    local cellCol: { [number]: { number } } = {}
    local skin: { number } = {}
    for id, votes in colVotes do
        local best, bk = -1, 0
        for k, c in votes do
            if c > best then
                best, bk = c, k
            end
        end
        cellCol[id] = palette[bk]
        local ranked: { { number } } = {}
        for bone, w in boneVotes[id] do
            table.insert(ranked, { bone, w })
        end
        table.sort(ranked, function(p: { number }, q: { number }): boolean
            return p[2] > q[2]
        end)
        local total = 0
        for r = 1, math.min(4, #ranked) do
            total += ranked[r][2]
        end
        local left = 255
        for r = 1, math.min(4, #ranked) do
            local w = if r == math.min(4, #ranked) then left else math.floor(ranked[r][2] / total * 255 + 0.5)
            w = math.min(w, left)
            left -= w
            buffer.writeu8(cellJ, id * 4 + r - 1, ranked[r][1])
            buffer.writeu8(cellW, id * 4 + r - 1, w)
        end
        table.insert(skin, id)
    end

    local function each(id: number, f: (number) -> ())
        local ix = id % nx
        local iy = (id // nx) % ny
        local iz = id // nxy
        if ix > 0 then f(id - 1) end
        if ix < nx - 1 then f(id + 1) end
        if iy > 0 then f(id - nx) end
        if iy < ny - 1 then f(id + nx) end
        if iz > 0 then f(id - nxy) end
        if iz < nz - 1 then f(id + nxy) end
    end

    -- OUTSIDE
    local stack: { number } = { 0 }
    buffer.writeu8(state, 0, 2)
    while #stack > 0 do
        local id = table.remove(stack) :: number
        each(id, function(nb: number)
            if buffer.readu8(state, nb) == 0 then
                buffer.writeu8(state, nb, 2)
                table.insert(stack, nb)
            end
        end)
    end

    -- INSIDE: breadth first from the skin.
    local queue = skin
    local head = 1
    while head <= #queue do
        local id = queue[head]
        head += 1
        local col = cellCol[id]
        each(id, function(nb: number)
            if buffer.readu8(state, nb) == 0 then
                buffer.writeu8(state, nb, 3)
                buffer.writeu32(cellJ, nb * 4, buffer.readu32(cellJ, id * 4))
                buffer.writeu32(cellW, nb * 4, buffer.readu32(cellW, id * 4))
                cellCol[nb] = col
                table.insert(queue, nb)
            end
        end)
    end

    -- TRIM
    for _, id in skin do
        if not nearIn[id] then
            buffer.writeu8(state, id, 2)
        end
    end
    local loose: { number } = {}
    for _, id in skin do
        if buffer.readu8(state, id) == 1 then
            local held = false
            each(id, function(nb: number)
                local st = buffer.readu8(state, nb)
                if st == 1 or st == 3 then
                    held = true
                end
            end)
            if not held then
                table.insert(loose, id)
            end
        end
    end
    for _, id in loose do
        buffer.writeu8(state, id, 2)
    end

    local function solid(id: number): boolean
        local s = buffer.readu8(state, id)
        return s == 1 or s == 3
    end

    local function neighbour(id: number, axis: number, sign: number): number
        local ix = id % nx
        local iy = (id // nx) % ny
        local iz = id // nxy
        if axis == 1 then
            ix += sign
            if ix < 0 or ix >= nx then return -1 end
        elseif axis == 2 then
            iy += sign
            if iy < 0 or iy >= ny then return -1 end
        else
            iz += sign
            if iz < 0 or iz >= nz then return -1 end
        end
        return ix + nx * iy + nxy * iz
    end

    local function shows(id: number, d: { number }): boolean
        if open then
            return true
        end
        local nb = neighbour(id, d[1], d[2])
        return nb < 0 or not solid(nb)
            or buffer.readu32(cellJ, nb * 4) ~= buffer.readu32(cellJ, id * 4)
            or buffer.readu32(cellW, nb * 4) ~= buffer.readu32(cellW, id * 4)
    end

    -- FACES: count, then write. A whisker cube shows all six.
    local faces, cubes = #strandOrder * 6, #strandOrder
    for id = 0, n - 1 do
        if solid(id) then
            local any = false
            for _, d in DIRS do
                if shows(id, d) then
                    faces += 1
                    any = true
                end
            end
            if any then
                cubes += 1
            end
        end
    end

    local vbuf = buffer.create(faces * 4 * M.STRIDE)
    local ibuf = buffer.create(faces * 6 * 4)
    local f = 0
    local corner = { 0, 0, 0 }
    local US: { number } = { -1, 1, 1, -1 }
    local VS: { number } = { -1, -1, 1, 1 }
    local function face(cx: number, cy: number, cz: number, h: number, axis: number, sign: number,
        col: { number }, joints: number, weights: number, strand: number)
        local ua = axis % 3 + 1
        local va = ua % 3 + 1
        for k = 1, 4 do
            corner[axis] = sign
            corner[ua] = US[k] * sign
            corner[va] = VS[k]
            local o = (f * 4 + k - 1) * M.STRIDE
            buffer.writef32(vbuf, o, cx + corner[1] * h)
            buffer.writef32(vbuf, o + 4, cy + corner[2] * h)
            buffer.writef32(vbuf, o + 8, cz + corner[3] * h)
            buffer.writef32(vbuf, o + 12, if axis == 1 then sign else 0)
            buffer.writef32(vbuf, o + 16, if axis == 2 then sign else 0)
            buffer.writef32(vbuf, o + 20, if axis == 3 then sign else 0)
            buffer.writef32(vbuf, o + 24, col[1])
            buffer.writef32(vbuf, o + 28, col[2])
            buffer.writef32(vbuf, o + 32, col[3])
            buffer.writeu32(vbuf, o + 36, joints)
            buffer.writeu32(vbuf, o + 40, weights)
            buffer.writef32(vbuf, o + 44, cx)
            buffer.writef32(vbuf, o + 48, cy)
            buffer.writef32(vbuf, o + 52, cz)
            buffer.writef32(vbuf, o + 56, h)
            buffer.writef32(vbuf, o + 60, strand)
        end
        local base = f * 4
        local io = f * 24
        buffer.writeu32(ibuf, io, base)
        buffer.writeu32(ibuf, io + 4, base + 1)
        buffer.writeu32(ibuf, io + 8, base + 2)
        buffer.writeu32(ibuf, io + 12, base)
        buffer.writeu32(ibuf, io + 16, base + 2)
        buffer.writeu32(ibuf, io + 20, base + 3)
        f += 1
    end
    for id = 0, n - 1 do
        if solid(id) then
            local ix = id % nx
            local iy = (id // nx) % ny
            local iz = id // nxy
            local cx, cy, cz = ox + (ix + 0.5) * cell, oy + (iy + 0.5) * cell, oz + (iz + 0.5) * cell
            local joints = buffer.readu32(cellJ, id * 4)
            local weights = buffer.readu32(cellW, id * 4)
            local col = cellCol[id] or { 0.45, 0.45, 0.45 }
            for _, d in DIRS do
                if shows(id, d) then
                    face(cx, cy, cz, half, d[1], d[2], col, joints, weights, 0)
                end
            end
        end
    end
    local fhalf = fine * 0.5
    for _, fk in strandOrder do
        local vi = strandCells[fk]
        local fx = fk % FK
        local fy = (fk // FK) % FK
        local fz = fk // (FK * FK)
        local cx = lo[1] + (fx - 0.5) * fine
        local cy = lo[2] + (fy - 0.5) * fine
        local cz = lo[3] + (fz - 0.5) * fine
        local joints, weights = pack(jn[vi], wt[vi])
        local col = { cr[vi], cg[vi], cb[vi] }
        for _, d in DIRS do
            face(cx, cy, cz, fhalf, d[1], d[2], col, joints, weights, 1)
        end
    end

    return { vbuf = vbuf, ibuf = ibuf, icount = faces * 6, cubes = cubes, faces = faces, strands = #strandOrder }
end

return M
