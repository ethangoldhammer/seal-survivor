import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ensureFontLoaded } from '../ui/typography.js';

// ============================================================================
// THE EPITAPH — a name and a cause of death, cut into the face of a stone.
//
// This is a CANVAS ON A QUAD, not geometry and not a shader, and the three
// reasons are worth writing down because each one is a path somebody will
// otherwise take and lose a day to.
//
//   NOT GEOMETRY. Text as triangles has to be authored, which means the string
//   is fixed at export. The whole point of a gravesite is that it carries the
//   name the player just typed and the animal that just killed them, and no
//   exported mesh can carry a string chosen at runtime. That is also the exact
//   reason a Spline scene cannot be the source here: Spline's own runtime CAN
//   rebind a text object (setVariable with a string), but only inside its own
//   Application canvas — a second renderer with its own depth buffer, so the
//   dust could never settle in front of the stone and the daylight could never
//   reach it. Export it to glTF instead and the text is baked triangles and
//   the materials are gone. The two halves are mutually exclusive and the
//   half we need is the one that doesn't survive the trip.
//
//   NOT A SHADER. A carved letter reads because its edges catch light from one
//   side and shadow on the other, which wants a derivative of the coverage —
//   and GLSL ES 1.00 has no fwidth, so an injected shader cannot have one. See
//   the note in systems/noiseShader.js. Baking the bevel into the canvas costs
//   two extra fillText calls, happens once per stone, and works everywhere.
//
//   NOT A MAP ON THE STONE'S OWN MATERIAL. Three reasons, all fatal: the
//   stones came out of a Sketchfab pack and their UVs are whatever the pack
//   author left there; Material.clone() silently drops onBeforeCompile and
//   with it every shader the look pipeline injected; and the asset cache hands
//   the SAME material object to every stone, so writing a map onto it would
//   put one seal's name on the whole graveyard. A separate quad with its own
//   material sidesteps all three, and — because it is its own object — can be
//   faded in on its own clock, which is what makes the etch an event rather
//   than a texture that was always there.
//
// WHERE THE QUAD GOES. Every grave asset is oriented so its inscription face
// ends up pointing at the camera — that is what the `forward`/`up` pair on the
// three entries in assets.js is FOR, and why the plaque's differs from the
// other two (prop-import measured each stone's face normal; the plaque's
// slopes the opposite way). So after createVisual the face is world +Z for all
// three, and placing the quad is a bounding-box measurement rather than a
// per-stone table that would drift the moment a `fit` changed.
// ============================================================================

/** Texels per world unit. The quad is small on screen; 256 is already generous
 *  for a stone about two units tall, and the canvas is thrown away after the
 *  texture uploads. Tunable because a player on a 4K display standing under a
 *  tomb sees a different amount of it than the number implies. */
const DEFAULT_DPI = 256;

function cfg() {
  return CONFIG.gravesite ?? {};
}

function hexCss(hex, alpha = 1) {
  const n = (hex ?? 0) >>> 0;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Shrink the font until the string fits the width, then hand back the size
 * that fit. A rolled seal name is up to MAX_NAME_LEN characters and the stones
 * are not all the same width, so a fixed size is a name that overhangs a
 * plaque — which reads as the etching being broken rather than as the name
 * being long.
 *
 * Measured rather than estimated per character: the shelf in fonts.js runs
 * from Press Start 2P to Bangers, and no per-character constant survives that.
 */
function fitFont(ctx, text, family, weight, maxPx, maxWidth) {
  let px = maxPx;
  for (let i = 0; i < 24 && px > 6; i += 1) {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    px *= 0.92;
  }
  return px;
}

/**
 * Break `text` over at most `maxLines`, shrinking only once it has run out of
 * lines to use.
 *
 * THE ORDER IS THE POINT. Shrink-then-wrap and wrap-then-shrink produce very
 * different type: the first hands back a small block with room to spare beside
 * it, the second uses the width it has and only gives up size when the box is
 * genuinely full. A gravestone is mostly width, so the second is right.
 *
 * Words are never broken. A boss name split across a hyphen the author did not
 * write is worse than a name that is one size smaller, and every string that
 * reaches here is somebody's name or a phrase somebody wrote.
 *
 * A single word wider than the box is the one case wrapping cannot answer —
 * "Ancientchompers" on a plaque — and it falls through to the shrink, which is
 * exactly right.
 */
function fitLines(ctx, text, family, weight, maxPx, maxWidth, maxLines) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { px: maxPx, lines: [''] };

  let px = maxPx;
  let best = null;
  for (let attempt = 0; attempt < 24 && px > 6; attempt += 1) {
    ctx.font = `${weight} ${px}px ${family}`;
    const lines = [];
    let line = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const next = `${line} ${words[i]}`;
      if (ctx.measureText(next).width <= maxWidth) line = next;
      else { lines.push(line); line = words[i]; }
    }
    lines.push(line);
    // Remembered even when it is too tall, so a box with room for one line
    // still gets the best single-line answer rather than nothing.
    best = { px, lines };
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (lines.length <= maxLines && widest <= maxWidth) return best;
    px *= 0.92;
  }
  // Out of room and out of sizes. Hand back what it managed and let it be small
  // — the alternative is a blank line where the cause of death should be.
  return best ?? { px, lines: [text] };
}

/**
 * Draw one line as a CARVED groove: a dark body with a light lip above it and
 * a darker shadow below. Three draws of the same string at sub-pixel offsets.
 *
 * The order matters and is the opposite of the intuitive one. The lip is drawn
 * FIRST and the body last, so the body's antialiased edge sits on top of the
 * lip rather than under it — drawn the other way round the highlight eats the
 * letter's outline and the text reads as embossed, which is the same three
 * draws making exactly the wrong picture.
 */
function carveLine(ctx, text, x, y, depth, colors) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = hexCss(colors.lip, colors.lipAlpha);
  ctx.fillText(text, x - depth, y - depth);

  ctx.fillStyle = hexCss(colors.shadow, colors.shadowAlpha);
  ctx.fillText(text, x + depth, y + depth);

  // Not fully opaque — see the blending note in makeEpitaph. A groove the stone
  // shows a little of is a groove the daylight still reaches.
  ctx.fillStyle = hexCss(colors.ink, colors.inkAlpha);
  ctx.fillText(text, x, y);
}

/**
 * Build the inscription.
 *
 * @param {object} opts
 *   name    the seal's name, already sanitised — this does no trimming, because
 *           the caller (systems/playerName.js) is the only thing that knows what
 *           the leaderboard will accept.
 *   cause   the sub-line, as deathCauses.js words it — "a shark", "running out
 *           of air". Lowercase and mid-sentence on purpose; the template below
 *           is what supplies the sentence around it.
 *   width   the face's width in WORLD UNITS
 *   height  the face's height in world units
 *
 * @returns {THREE.Mesh} a quad in the stone's local space, facing +Z, with its
 *   material's opacity at 0 — nothing is revealed until the caller says so.
 */
export function makeEpitaph({ name, cause, lead: leadIn = '', width, height, type = {} }) {
  // `type` is the STONE's own overrides for the block below — see
  // CONFIG.gravesite.faces. It exists because a panel's proportions decide how
  // big its type can be, and the three stones' panels are not the same shape:
  // the tomb's is a 6:1 letterbox, so type sized as a fraction of its HEIGHT
  // comes out a sixth of the size the width could carry. Spread over the shared
  // settings rather than replacing them, so a stone overrides one number
  // without restating the other nine.
  const c = { ...(cfg().etch ?? {}), ...type };
  const family = c.font ?? "'Cinzel', Georgia, serif";
  ensureFontLoaded(family);

  const dpi = c.dpi ?? DEFAULT_DPI;
  const w = Math.max(16, Math.round(width * dpi));
  const h = Math.max(16, Math.round(height * dpi));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // A canvas with no 2D context is a jsdom harness, not a browser — see the
  // note in tools/dom-stub.mjs. Bail with a quad that draws nothing rather than
  // throwing from inside three.js, which is where the error would surface and
  // is nowhere near the cause.
  if (!ctx) return blankQuad(width, height);

  // THE CANVAS IS LEFT TRANSPARENT. Only the letters are ever drawn into it, so
  // the stone's own face shows through everywhere else — see the blending note
  // on the material below for why this is an ordinary alpha decal and not the
  // multiply it started as.
  const colors = {
    ink: c.ink ?? 0x1a1714,
    // The lit edge of the groove — a real highlight, drawn over the stone. This
    // is the thing MultiplyBlending could not do at any value, which is half of
    // why this quad is a plain decal now.
    lip: c.lip ?? 0xe8e0d0,
    lipAlpha: c.lipAlpha ?? 0.55,
    inkAlpha: c.inkAlpha ?? 0.88,
    shadow: c.shadow ?? 0x000000,
    shadowAlpha: c.shadowAlpha ?? 0.4,
  };
  // The groove's half-width in texels. Scaled off the canvas rather than fixed,
  // so the bevel is the same fraction of a letter on a plaque and on a tomb.
  const depth = Math.max(1, (c.depth ?? 0.006) * h);

  const pad = (c.padding ?? 0.12) * w;
  const inner = w - pad * 2;
  const mid = h * (c.baseline ?? 0.42);

  // --- the name -------------------------------------------------------------
  // STACKED, when it will take one. "FAT TONY" set on one line across a stone
  // is limited by the stone's WIDTH; broken into "FAT" over "TONY" it is
  // limited by the height, and a headstone is taller than it is wide — so the
  // same name comes out roughly twice the size for free.
  //
  // Which is the whole reason the panel is the whole front now. A rect that
  // covered a third of the stone had no height to spend, so stacking bought
  // nothing and the name had to stay small.
  //
  // fitLines does the work and needs no special case for a one-word name: it
  // wraps what it can and hands back a single line when there is nothing to
  // break. "Rumpshaker" and "Sir Flops-A-Lot" are both handled by asking the
  // same question.
  const nameLines = Math.max(1, Math.floor(c.nameLines ?? 2));
  const nameSet = fitLines(ctx, name, family, c.nameWeight ?? 700, (c.namePx ?? 0.2) * h, inner, nameLines);
  const namePx = nameSet.px;
  const nameStep = namePx * (c.nameLineGap ?? 1.02);
  ctx.font = `${c.nameWeight ?? 700} ${namePx}px ${family}`;
  // The block is centred on `mid` rather than started at it, so adding a second
  // line grows the name in both directions instead of pushing the cause down
  // off the stone.
  const nameTop = mid - (nameSet.lines.length - 1) * nameStep * 0.5;
  nameSet.lines.forEach((line, i) => {
    carveLine(ctx, line, w / 2, nameTop + i * nameStep, depth, colors);
  });
  // Where the rest of the inscription starts from — the BOTTOM of the name
  // block, not the middle of it. A cause positioned from `mid` would be written
  // straight through the second line of a stacked name.
  const nameBottom = nameTop + (nameSet.lines.length - 1) * nameStep;

  // --- the cause ------------------------------------------------------------
  // Two lines, and they are one sentence: "taken by / a shark". The template is
  // here rather than in deathCauses.js because the labels there are written to
  // be dropped into ANY sentence — the greeting uses the same strings — and a
  // stone is only one of the places they land.
  // THE LEAD IS THE GRAVE'S, not the config's. epitaphs.csv holds a pool per
  // cause and systems/epitaphLead.js rolls one when the grave is filed, so
  // "chomped by" lands on a shark death and "who ran out of" on a drowning.
  // The config value is what a stone with no rolled lead falls back to — the
  // look page, a harness, and any death filed before the table existed.
  const lead = String(leadIn ?? '').trim() || c.lead || 'lost to';
  const causePx = Math.max(8, namePx * (c.causeScale ?? 0.42));
  const gap = causePx * (c.lineGap ?? 1.35);

  // THE LEAD IS FITTED TOO, and it went years without being. It was drawn at a
  // fixed size with no width check at all, which was invisible while every lead
  // was "taken by" or "lost to" — three syllables that fit anything. epitaphs.csv
  // has "bitten clean through by" and "minced by the propeller of" in it now,
  // and on a stone whose name is deliberately dominant those are wider than the
  // panel: the line rendered CLIPPED AT BOTH ENDS, reading "ITTEN CLEAN THROUGH
  // B" with nothing anywhere reporting it.
  //
  // The same wrap-then-shrink the name and the cause use, so the three lines of
  // an inscription are now fitted by one function and cannot disagree about what
  // fits.
  const leadY = nameBottom + namePx * 0.78;
  const leadSet = fitLines(ctx, lead, family, c.causeWeight ?? 400, causePx, inner,
    Math.max(1, Math.floor(c.leadLines ?? 2)));
  const leadStep = leadSet.px * (c.causeLineGap ?? 1.15);
  ctx.font = `${c.causeWeight ?? 400} ${leadSet.px}px ${family}`;
  ctx.globalAlpha = c.leadAlpha ?? 0.72;
  leadSet.lines.forEach((line, i) => {
    carveLine(ctx, line, w / 2, leadY + i * leadStep, depth * 0.7, colors);
  });
  ctx.globalAlpha = 1;
  const leadBottom = leadY + (leadSet.lines.length - 1) * leadStep;

  // WRAPPED, NOT JUST SHRUNK, and the reason is bosses. A cause used to be
  // "a shark" or "running out of air" — four words at the outside, and shrinking
  // one to fit was the whole problem. It can now be a boss's own rolled name,
  // and those run to "Wealthyveranda the Boat Full of Billionaire Bozos": forty
  // nine characters, where the median is twenty seven. Shrinking that onto one
  // line puts it at a size nobody reads, on the line that says what killed you.
  //
  // So it takes as many lines as it needs up to `causeLines`, and only shrinks
  // once it has run out of lines — which is the order a person setting type
  // would do it in.
  const causeText = cause || 'the sea';
  // Off the BOTTOM of the lead, not off its first line — a two-line lead would
  // otherwise be written straight through by the cause underneath it.
  const causeTop = leadBottom + gap;
  // What is left of the panel underneath. The block must not run off the bottom
  // of the stone, so the line count is bounded by the room as well as by the
  // setting — a five-line cause on a plaque would be five lines hanging in the
  // water below it.
  const roomBelow = h - causeTop - (c.padding ?? 0.12) * h;
  const maxLines = Math.max(1, Math.min(
    Math.floor(c.causeLines ?? 3),
    Math.floor(roomBelow / Math.max(1, causePx * (c.causeLineGap ?? 1.15))),
  ));
  const set = fitLines(ctx, causeText, family, c.causeWeight ?? 400, causePx, inner, maxLines);
  ctx.font = `${c.causeWeight ?? 400} ${set.px}px ${family}`;
  const step = set.px * (c.causeLineGap ?? 1.15);
  set.lines.forEach((line, i) => {
    carveLine(ctx, line, w / 2, causeTop + i * step, depth * 0.7, colors);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // No mips and a clamped wrap: the quad is never seen at a steep angle in a
  // side view, and a mipped inscription goes to mush at the first minification
  // step because the whole read is one-texel-wide bevels.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    // AN ORDINARY ALPHA DECAL, and it took two wrong pictures to get here.
    //
    // This started as MultiplyBlending, on the reasoning that a groove is a
    // SUBTRACTION from whatever the stone is doing — so it would darken and
    // lighten with the daylight instead of sitting at one brightness while the
    // stone went to dusk behind it. That reasoning is still true and it is not
    // worth what it costs:
    //
    //   Multiply reads the colour of every pixel, including the ones nothing
    //   drew into. A fresh canvas is transparent BLACK, so "no ink here"
    //   multiplied the stone by zero and the inscription rendered as a solid
    //   black rectangle stuck on the headstone. Filling the canvas white first
    //   fixed that and produced a solid WHITE rectangle instead.
    //
    //   And multiply can only ever darken. The lit lip of a carved letter — the
    //   single thing that makes an engraving read as cut rather than printed —
    //   is unreachable at any value.
    //
    // Both failures are invisible to everything except a picture: the geometry
    // is right, the placement is right, the texture uploads, the text is in it,
    // and nothing throws. npm run looks:graves is what found them, and is the
    // only thing that can.
    //
    // The daylight response is bought back cheaply instead: `ink` is dark but
    // not opaque black, so the stone's own lighting shows through the groove
    // and a dark mark on a stone at dusk is still a dark mark on a dark stone.
    blending: THREE.NormalBlending,
    depthWrite: false,
    // The quad sits a hair proud of the face; polygon offset is what stops it
    // z-fighting with the stone when the camera pushes in during a kill shot.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.name = 'epitaph';
  mesh.renderOrder = 2;
  mesh.userData.epitaph = true;
  return mesh;
}

/** A quad that exists and draws nothing — the headless path. See makeEpitaph. */
function blankQuad(width, height) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  mesh.name = 'epitaph';
  mesh.userData.epitaph = true;
  mesh.userData.blank = true;
  return mesh;
}

/**
 * How far the etching has been cut, 0 to 1. A plain opacity ramp rather than a
 * wipe across the letters: a wipe is the obvious "chisel travelling along the
 * line" and it is wrong here, because the two lines are centred and a wipe
 * from the left starts in the middle of the first word on a short name and at
 * the edge on a long one. The same reveal has to read for "Al" and for
 * "Sir Flops-A-Lot".
 */
export function revealEpitaph(mesh, t) {
  if (!mesh?.material) return;
  mesh.material.opacity = Math.max(0, Math.min(1, t));
}

/** Drop the texture and the geometry. The MATERIAL is this quad's own, unlike
 *  the stone's, so it is safe to dispose here. */
export function disposeEpitaph(mesh) {
  if (!mesh) return;
  mesh.material?.map?.dispose();
  mesh.material?.dispose();
  mesh.geometry?.dispose();
  mesh.parent?.remove(mesh);
}
