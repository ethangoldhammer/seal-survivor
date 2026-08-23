// ============================================================================
// WHAT A DRAWN ICON MAY BE — one list, because four had to agree.
//
// An uploaded icon passes through four gates on its way into the game, and
// every one of them had its own copy of the format list:
//
//   picker.html      the file input's `accept`
//   server.mjs       the upload gate, which refuses an extension it dislikes
//   server.mjs       the MIME map, which serves the file back for the preview
//   upgrade-icons.mjs  the bake, which stamps a MIME into the data: URI
//
// Four copies of one fact is four chances to add a format to three of them.
// The failure is quiet in the worst way: the upload succeeds, the preview
// looks right, and the bake writes `data:image/png` over an SVG — which no
// browser renders, so the icon is simply missing in the hive, weeks later,
// with nothing pointing back at the upload.
//
// SVG IS THE ONE THAT MADE THIS MATTER. The other three formats are rasters
// that behave alike; SVG is the one where the bake's guess is wrong rather
// than merely imprecise, because the bytes are text and the MIME is the only
// thing telling the browser so.
//
// Safe in an <img>, which is the only place these are used (ui/upgradeHive.js
// builds an <img> and sets .src). SVG loaded that way runs no script and
// fetches no external reference, so accepting one is not accepting markup into
// the page. Anywhere it got inlined into the DOM instead, that would stop
// being true.
// ============================================================================

export const ICON_FORMATS = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export const ICON_EXTS = Object.keys(ICON_FORMATS);

// The extension, lowercased, or '' — the one place the "last dot" rule lives.
export const extOf = (name) => {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i).toLowerCase();
};

export const isIconFile = (name) => extOf(name) in ICON_FORMATS;
export const mimeFor = (name) => ICON_FORMATS[extOf(name)] ?? null;
