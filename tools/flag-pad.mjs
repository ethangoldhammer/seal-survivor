#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pads a piece of square art out to a flag's aspect, in the art's own border
// colour, and writes the webp that goes in public/flags/.
//
//   node tools/flag-pad.mjs <in> <out.webp> [ratio]      ratio default 3:2
//
// WHY IT IS NOT JUST A CROP IN A GRAPHICS APP. A flag is cut to its image's own
// aspect ratio (see systems/flags.js — the height comes from CONFIG.flags and
// the width follows from the file), so the aspect IS the shape of the flag on
// the mast. Square art flies as a square, which reads as a sign rather than as
// cloth. Padding it here means the source art stays square and reusable, and
// the flag's proportions are a number on a command line.
//
// THE BORDER COLOUR IS SAMPLED, not typed. The corners of this kind of art are
// a flat field, and a hand-typed hex that is one level off shows up as a seam
// down the middle of the flag exactly where the original edge was — invisible
// in a thumbnail and obvious the moment it is two hundred pixels wide on a
// mast. All four corners are read and the most common one wins, so a stray
// pixel of anti-aliasing in one corner cannot pick the colour for the whole
// border.
//
// 3:2 by default, the commonest flag proportion. 2:1 is the other one worth
// trying (UK/Australia); past that the art is a stamp in the middle of a lot of
// empty cloth, which is a different design rather than the same one padded.
// ---------------------------------------------------------------------------
import sharp from 'sharp';

const [input, output, ratioArg = '3:2'] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/flag-pad.mjs <in> <out.webp> [ratio]');
  process.exit(1);
}

const [rw, rh] = ratioArg.split(':').map(Number);
if (!(rw > 0) || !(rh > 0)) {
  console.error(`"${ratioArg}" is not a ratio — write it as w:h, e.g. 3:2`);
  process.exit(1);
}

const src = sharp(input);
const meta = await src.metadata();

// Sampled off the four corners of the source rather than off the padded canvas,
// which does not exist yet.
const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const at = (x, y) => {
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};
const corners = [
  at(0, 0), at(info.width - 1, 0), at(0, info.height - 1), at(info.width - 1, info.height - 1),
];
const tally = new Map();
for (const c of corners) {
  const key = c.join(',');
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
// Ties go to the top-left corner, which is the one a border is most likely to
// be clean in.
const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
const [r, g, b] = best.split(',').map(Number);

// Grown, never cropped: the whole point is to keep every pixel of the art and
// add cloth around it. The long side of the source sets the flag's short side.
const height = Math.max(meta.height, Math.round(meta.width * rh / rw));
const width = Math.max(meta.width, Math.round(height * rw / rh));

await sharp({
  create: { width, height, channels: 3, background: { r, g, b } },
})
  .composite([{
    input: await src.png().toBuffer(),
    left: Math.round((width - meta.width) / 2),
    top: Math.round((height - meta.height) / 2),
  }])
  .webp({ quality: 92 })
  .toFile(output);

console.log(`${input} ${meta.width}x${meta.height} -> ${output} ${width}x${height} (${ratioArg}), `
  + `border rgb(${r}, ${g}, ${b}) sampled from ${tally.get(best)}/4 corners`);
