// ---------------------------------------------------------------------------
// THE iOS APP ICON AND LAUNCH SCREEN — `npm run icons:app`.
//
// TWO SOURCES, ON PURPOSE. They used to be one: both the icon and the launch
// screen were cut from the splash art embedded in path/src/ui/seal_survivor.riv.
// That art is a rim-lit silhouette in dark water, which is the right picture
// for a full screen and the wrong one for a 60pt tile — even cropped to the
// animal and pushed two stops it was a dark smudge among the other icons on a
// home screen. The icon now comes from design/app-icon.png, drawn for the tile:
// flat colour, heavy black line, a sky-to-navy gradient that reads at any size.
// The launch screen still comes from the .riv, so it still tracks the splash.
//
// NO GRADE ON THE ICON. The old brightness/saturation lift existed to rescue an
// underexposed crop. Applied to this art it blows the sky blue out to white —
// the picture is already composed at tile contrast, so it is copied, not fixed.
//
// NO ALPHA ON THE ICON. App Store Connect rejects an icon with an alpha
// channel outright, and the rejection arrives at upload time, long after the
// build. `flatten` is not optional decoration.
//
// THE ART IS VECTOR, SO EVERY SIZE IS RENDERED, NOT RESAMPLED. design/app-icon.svg
// declares a 300² viewBox, which is a unit box and not a resolution — librsvg is
// told a density that makes 300 units land on the target pixel count, so the
// 1024² store icon is drawn at 1024² rather than upscaled from 300². Resizing
// the rasterised 300 instead costs about three pixels of blur on every black
// stroke, which is exactly what this art is made of.
//
// THREE TARGETS, ONE PICTURE — `npm run icons:app` writes the iOS icon set, the
// web build's favicon and touch icon, and build/icon.png for electron-builder.
// Naming a target (`node tools/app-icon.mjs desktop`) writes only that one,
// which is how `npm run pack:desktop` refreshes the Mac icon without touching
// ios/ and leaving a dirty tree behind a build that never went near the phone.
//
// THE MAC ICON IS THE SAME SQUARE ART, deliberately. macOS does not mask an
// app icon the way iOS does — whatever the .icns contains is what sits in the
// Dock — so this one keeps its corners where the iOS tile gets rounded for it.
// That is the cost of one picture across three platforms, and it is a choice
// rather than an oversight: a Mac-shaped variant would be a second piece of art
// to keep in step with the first.
//
// The rounded corner in the file is NOT the icon's corner. The artboard draws a
// 336² rounded card centred at (149.8, 140), so its corner arcs all fall outside
// the 300² box and the gradient runs edge to edge — iOS applies the only mask
// that matters. The #282828 behind the card never shows; if a future export
// shrinks that card, dark corners will appear and iOS will mask them into
// visible dark wedges.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIV = path.join(ROOT, 'path/src/ui/seal_survivor.riv');
const ICON_ART = path.join(ROOT, 'design/app-icon.svg');
const ICONSET = path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
const SPLASHSET = path.join(ROOT, 'ios/App/App/Assets.xcassets/Splash.imageset');
const PUBLIC = path.join(ROOT, 'public');
// electron-builder's buildResources directory — see `directories.buildResources`
// in electron-builder.yml. It looks for icon.png here by name; without one it
// packages the default Electron icon and says so in a line that is easy to read
// past, which is exactly how the Mac build shipped without an icon.
const DESKTOP = path.join(ROOT, 'build');

// Which targets to write. No argument means all three — the common case, and
// what `npm run icons:app` does.
const TARGETS = ['ios', 'web', 'desktop'];
const asked = process.argv.slice(2).filter((a) => TARGETS.includes(a));
const unknown = process.argv.slice(2).filter((a) => !TARGETS.includes(a));
if (unknown.length) {
  console.error(`\n  unknown target: ${unknown.join(', ')} — expected any of ${TARGETS.join(', ')}\n`);
  process.exit(1);
}
const want = (t) => !asked.length || asked.includes(t);

// The app's own background, so the launch screen and the first painted frame
// are the same colour and the handover is invisible. Matches index.html and
// capacitor.config.json — three copies of one value, which is two too many,
// but the other two are read by tools that cannot import from here.
const BG = { r: 5, g: 6, b: 10 };

/**
 * The first embedded PNG in a .riv. Rive's container format is not documented
 * as something to parse, so this does not try — it finds the PNG signature and
 * reads to the matching IEND, which is well defined regardless of what wraps
 * it. Two images are embedded (the second is the polaroid frame); the seal is
 * the first.
 */
function firstEmbeddedPng(file) {
  const buf = fs.readFileSync(file);
  const start = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (start < 0) throw new Error(`no embedded PNG in ${path.basename(file)}`);
  const end = buf.indexOf(Buffer.from('IEND\xae\x42\x60\x82', 'binary'), start);
  if (end < 0) throw new Error(`embedded PNG in ${path.basename(file)} has no IEND`);
  return buf.subarray(start, end + 8);
}

// --- the icon ---------------------------------------------------------------
const art = await sharp(ICON_ART).metadata();
if (art.width !== art.height) {
  throw new Error(`${path.relative(ROOT, ICON_ART)} is ${art.width}x${art.height}; the icon art must be square`);
}
console.log(`  source  ${art.width}x${art.height} from ${path.relative(ROOT, ICON_ART)}`);

const icon = (size) => sharp(ICON_ART, { density: (72 * size) / art.width })
  .resize(size, size)
  .flatten({ background: BG })
  .png();

if (want('ios')) {
  await icon(1024).toFile(path.join(ICONSET, 'AppIcon-512@2x.png'));
  console.log('  icon    ios AppIcon-512@2x.png  1024²');
}

// The web build has never had an icon of any kind, so a phone that adds the
// deployed page to its home screen draws a screenshot of the page. Same art,
// so the bookmark and the real app are not two different products.
if (want('web')) {
  await icon(180).toFile(path.join(PUBLIC, 'apple-touch-icon.png'));
  await icon(32).toFile(path.join(PUBLIC, 'favicon.png'));
  console.log('  icon    public/apple-touch-icon.png 180², public/favicon.png 32²');
}

// --- the Mac icon -----------------------------------------------------------
// ONE 1024² PNG, NOT AN .icns. electron-builder generates the icns itself and
// wants the largest size it can get — handing it 512² produces a Dock icon that
// is soft on a Retina display, and this art is black line work where softness is
// the first thing you see.
if (want('desktop')) {
  fs.mkdirSync(DESKTOP, { recursive: true });
  await icon(1024).toFile(path.join(DESKTOP, 'icon.png'));
  console.log('  icon    build/icon.png  1024²  (electron-builder makes the .icns)');
}

// --- the launch screen ------------------------------------------------------
// iOS only: it is a storyboard asset, and neither the web build nor the Mac
// shell has anything that reads it.
if (want('ios')) {
  const source = firstEmbeddedPng(RIV);
  const riv = await sharp(source).metadata();
  console.log(`  source  ${riv.width}x${riv.height} from ${path.relative(ROOT, RIV)}`);

  // One square at 2732, which the storyboard scaleAspectFills — so it covers any
  // device in either orientation by cropping, never by letterboxing. The upscale
  // from 620 is large, but the picture is a soft gradient with a rim-lit
  // silhouette and it is on screen for under a second.
  const splash = await sharp(source)
    .resize(2732, 2732, { kernel: 'lanczos3', fit: 'cover' })
    .flatten({ background: BG })
    .png()
    .toBuffer();

  // Three identical entries because the imageset declares 1x/2x/3x and Xcode
  // warns on an unassigned slot. The image is already far larger than any of
  // them needs; there is nothing to gain from three real sizes.
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    fs.writeFileSync(path.join(SPLASHSET, name), splash);
  }
  console.log('  splash  ios Splash.imageset  2732² x3');
}
