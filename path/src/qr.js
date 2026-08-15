// ---------------------------------------------------------------------------
// QR — a URL, as a square somebody can point a phone at.
//
// The share image already carries the address in two places (the wordmark line
// on a kill shot, the top-right of the run sheet), and both of them are TEXT:
// a stranger who sees the picture on somebody else's phone has to read a URL
// off a screen and type it into theirs. Almost nobody does that. A QR is the
// same fact in a form the phone that is already pointed at the picture can act
// on, which is the only reason it is here — it is not decoration, it is the
// only route from "saw the image" to "played the game" that does not go
// through a keyboard.
//
// WHY THIS IS HAND-WRITTEN AND NOT A LIBRARY. The whole thing is about 300
// lines and has no dependencies; the smallest npm QR encoder is bigger than
// that once it is bundled, and this ships inside a game where every kilobyte
// is a slower first load for something the player sees once per run. It is
// also pure — no DOM, no canvas — so the Node harness can encode a code and
// assert its modules without a browser (see tools/qr-test.mjs, which decodes
// the result back with the system's own scanner rather than trusting this
// file's arithmetic).
//
// WHAT IT SUPPORTS. Byte mode, versions 1 to 10, all four error-correction
// levels. That is up to 271 bytes at level M — an ocean of room for a URL, and
// the cap is what keeps the tables in this file short. Anything longer returns
// null rather than throwing: a caption that has to be drawn on the frame a
// boss died on must not be able to take the frame down with it.
//
// Nothing here is on the hot path. One encode per image composed.
// ---------------------------------------------------------------------------

// Error-correction blocks, per version, per level:
//   [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
// Straight out of the spec's table 13-22. There is no deriving these — they
// are a lookup, and a wrong row produces a code that scans as nothing at all,
// which is why tools/qr-test.mjs round-trips every one of them.
const BLOCKS = {
  1:  { L: [7,  [[1, 19]]],            M: [10, [[1, 16]]],            Q: [13, [[1, 13]]],            H: [17, [[1, 9]]] },
  2:  { L: [10, [[1, 34]]],            M: [16, [[1, 28]]],            Q: [22, [[1, 22]]],            H: [28, [[1, 16]]] },
  3:  { L: [15, [[1, 55]]],            M: [26, [[1, 44]]],            Q: [18, [[2, 17]]],            H: [22, [[2, 13]]] },
  4:  { L: [20, [[1, 80]]],            M: [18, [[2, 32]]],            Q: [26, [[2, 24]]],            H: [16, [[4, 9]]] },
  5:  { L: [26, [[1, 108]]],           M: [24, [[2, 43]]],            Q: [18, [[2, 15], [2, 16]]],   H: [22, [[2, 11], [2, 12]]] },
  6:  { L: [18, [[2, 68]]],            M: [16, [[4, 27]]],            Q: [24, [[4, 19]]],            H: [28, [[4, 15]]] },
  7:  { L: [20, [[2, 78]]],            M: [18, [[4, 31]]],            Q: [18, [[2, 14], [4, 15]]],   H: [26, [[4, 13], [1, 14]]] },
  8:  { L: [24, [[2, 97]]],            M: [22, [[2, 38], [2, 39]]],   Q: [22, [[4, 18], [2, 19]]],   H: [26, [[4, 14], [2, 15]]] },
  9:  { L: [30, [[2, 116]]],           M: [22, [[3, 36], [2, 37]]],   Q: [20, [[4, 16], [4, 17]]],   H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]],   M: [26, [[4, 43], [1, 44]]],   Q: [24, [[6, 19], [2, 20]]],   H: [28, [[6, 15], [2, 16]]] },
};

// Where the alignment patterns sit, per version. Every pairing of these
// coordinates gets one, except the three that would land on a finder.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// The two bits that say which level a code was encoded at. Not in level order
// — M is 00 and L is 01, and getting this backwards makes a code that a
// scanner reads with the wrong correction and rejects.
const LEVEL_BITS = { M: 0b00, L: 0b01, H: 0b10, Q: 0b11 };

// GF(256) with the QR primitive, 0x11d. Built once at module load.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
}

// The Reed-Solomon generator polynomial for n check codewords: the product of
// (x - a^i) for i < n. Highest degree first.
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** The n error-correction codewords for one block of data. */
function eccFor(data, n) {
  const g = generator(n);
  const rem = new Uint8Array(data.length + n);
  rem.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i];
    if (!factor) continue;
    for (let j = 0; j < g.length; j++) rem[i + j] ^= gfMul(g[j], factor);
  }
  return Array.from(rem.subarray(data.length));
}

/** Data codewords a version/level pair holds, before error correction. */
function capacity(version, level) {
  const [, groups] = BLOCKS[version][level];
  return groups.reduce((sum, [count, data]) => sum + count * data, 0);
}

// Byte mode's character-count field is 8 bits up to version 9 and 16 from
// version 10 — a version bump can therefore COST a byte of payload, which is
// why the fit is checked per version rather than solved for.
function countBits(version) {
  return version < 10 ? 8 : 16;
}

function fitVersion(byteLength, level) {
  for (let v = 1; v <= 10; v++) {
    const bits = 4 + countBits(v) + byteLength * 8;
    if (bits <= capacity(v, level) * 8) return v;
  }
  return 0;
}

/**
 * Encode a string as a QR code.
 *
 * @param text  what the code says. UTF-8, byte mode — a URL, in practice.
 * @param level 'L' | 'M' | 'Q' | 'H'. M is the right default for something
 *              that will be photographed off a screen: L saves a version at
 *              the cost of the redundancy that survives a bad angle.
 * @returns { size, modules, version, level } where `modules` is one byte per
 *          module, row-major, 1 = dark — or null if the text is too long for
 *          version 10, which no URL this game would carry ever is.
 */
export function encodeQr(text, level = 'M') {
  const lvl = LEVEL_BITS[level] === undefined ? 'M' : level;
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const version = fitVersion(bytes.length, lvl);
  if (!version || !bytes.length) return null;

  const [ecPerBlock, groups] = BLOCKS[version][lvl];
  const total = capacity(version, lvl);

  // THE BIT STREAM: mode, length, payload, terminator, then alternating pad
  // bytes until the version is full.
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  for (let i = 0; data.length < total; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

  // Split into blocks, correct each one, then INTERLEAVE both halves. The
  // interleave is the whole point of the block structure: a scuff on the
  // printed code takes one codeword out of every block rather than all of one
  // block, and no single block ever exceeds what it can repair.
  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      eccBlocks.push(eccFor(block, ecPerBlock));
    }
  }
  const stream = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) stream.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of eccBlocks) stream.push(block[i]);
  }

  return draw(version, lvl, stream);
}

// ---------------------------------------------------------------------------
// THE MATRIX
// ---------------------------------------------------------------------------

function draw(version, level, stream) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  // Which modules belong to the code's furniture rather than to the message.
  // Everything downstream — data placement, masking — is "the rest of it", so
  // this array is what keeps a mask from eating a finder pattern.
  const fixed = new Uint8Array(size * size);
  const set = (row, col, dark, isFixed) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row * size + col] = dark ? 1 : 0;
    if (isFixed) fixed[row * size + col] = 1;
  };

  // Finders, with their separators — the -1..7 sweep writes the light ring in
  // the same pass, and off-matrix writes are dropped by `set`.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2;
        set(row + r, col + c, dark, true);
      }
    }
  }

  // Alignment patterns, at every pairing of the version's coordinates except
  // the three corners already occupied by a finder.
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      const onFinder = (r === 6 && c === 6)
        || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1, true);
        }
      }
    }
  }

  // Timing: the dotted line between the finders, on row and column 6.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    set(6, i, dark, true);
    set(i, 6, dark, true);
  }

  // The dark module. Always set, always here, no reason beyond the spec.
  set(size - 8, 8, true, true);

  // Format info is reserved now and written for real once the mask is chosen —
  // its bits depend on the mask, and the mask depends on a matrix with the
  // data already in it.
  placeFormat(set, size, level, 0);
  if (version >= 7) placeVersion(set, size, version);

  // THE MESSAGE, up and down two-module columns from the right edge, skipping
  // the timing column. Any module the stream does not reach stays light and is
  // masked with the rest — those are the spec's remainder bits, and they carry
  // nothing.
  let bit = 0;
  const bitAt = (i) => (i >>> 3 < stream.length ? (stream[i >>> 3] >>> (7 - (i & 7))) & 1 : 0);
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (fixed[row * size + col]) continue;
        if (bit < stream.length * 8) modules[row * size + col] = bitAt(bit);
        bit++;
      }
    }
  }

  // Eight masks, scored, lowest wins. The scoring is the spec's four penalty
  // rules and it is not cosmetic: an unmasked code can come out with a run of
  // identical rows or a shape that looks like a finder, and a scanner will
  // either lock onto the wrong thing or never lock on at all.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, fixed, size, mask);
    placeFormat(set, size, level, mask);
    const score = penalty(modules, size);
    if (best === null || score < best.score) best = { mask, score };
    applyMask(modules, fixed, size, mask); // XOR is its own undo
  }
  applyMask(modules, fixed, size, best.mask);
  placeFormat(set, size, level, best.mask);

  return { size, modules, version, level, mask: best.mask };
}

function placeFormat(set, size, level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  // Written TWICE, in the two L-shaped strips beside the top-left and the
  // other two finders, so a code with a damaged corner still says what level
  // and mask it was made at. The layout is not symmetric — bit 7 of the first
  // copy is the module at the elbow, and the two halves of each strip run in
  // opposite directions. (Transposing this is the single most convincing way
  // to be wrong here: the code still draws, the finders are still perfect,
  // and every scanner on earth reads it as nothing.)
  for (let i = 0; i < 15; i++) {
    const bit = (bits >>> i) & 1;
    if (i < 6) set(i, 8, bit, true);
    else if (i === 6) set(7, 8, bit, true);
    else if (i === 7) set(8, 8, bit, true);
    else if (i === 8) set(8, 7, bit, true);
    else set(8, 14 - i, bit, true);

    if (i < 8) set(8, size - 1 - i, bit, true);
    else set(size - 15 + i, 8, bit, true);
  }
}

function placeVersion(set, size, version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, bit, true);
    set(b, a, bit, true);
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(modules, fixed, size, mask) {
  const fn = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (!fixed[i] && fn(r, c)) modules[i] ^= 1;
    }
  }
}

// The four penalty rules, as written. Nothing here is tunable — a scanner is
// the only judge and it does not read config.js.
function penalty(modules, size) {
  const at = (r, c) => modules[r * size + c];
  let score = 0;

  // Rule 1: runs of five or more of the same colour, in both directions.
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = axis ? at(0, a) : at(a, 0);
      for (let b = 1; b < size; b++) {
        const m = axis ? at(b, a) : at(a, b);
        if (m === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          prev = m;
          run = 1;
        }
      }
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const m = at(r, c);
      if (m === at(r, c + 1) && m === at(r + 1, c) && m === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: anything that looks like a finder pattern in the middle of the
  // code — the 1:1:3:1:1 run, with four light modules on one side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 11 <= size; b++) {
        let hitA = true;
        let hitB = true;
        for (let k = 0; k < 11; k++) {
          const m = axis ? at(b + k, a) : at(a, b + k);
          if (m !== A[k]) hitA = false;
          if (m !== B[k]) hitB = false;
        }
        if (hitA) score += 40;
        if (hitB) score += 40;
      }
    }
  }

  // Rule 4: how far off a 50/50 split of dark and light the code is.
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const pct = (dark * 100) / modules.length;
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * The code as rows of 0/1, for a harness or a printer. The drawing side reads
 * `modules` directly — this is only ever worth the allocation in a test.
 */
export function qrRows(qr) {
  if (!qr) return [];
  const rows = [];
  for (let r = 0; r < qr.size; r++) {
    rows.push(Array.from(qr.modules.subarray(r * qr.size, (r + 1) * qr.size)));
  }
  return rows;
}
