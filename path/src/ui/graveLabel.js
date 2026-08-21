import { CONFIG } from '../config.js';
import { nearestGrave } from '../systems/gravesite.js';
import { worldToScreen } from './ui.js';
// The light that finds the stone at the same moment the caption does. Fired
// from here rather than from the frame loop because THIS is where the event
// happens — "the seal has arrived at a grave" is a fact this state machine
// already computes, and re-deriving it next to the renderer would be a second
// proximity check that can drift out of step with the first. A caption with no
// light, or a light with no caption, is the failure that split would produce.
import { sweepGrave } from '../systems/graveBeam.js';

// ============================================================================
// THE EPITAPH, READ ALOUD — the label that stands over a grave you swim across.
//
// The stone already carries the name and the cause, cut into its face. This is
// the same two lines again, in type, and the reason both exist is the reason
// any label on a thing exists: the inscription is at the stone's scale and a
// couple of units behind the play plane, angled and lit like everything else
// down there. It is the RIGHT way to show it and the wrong way to read it in
// the middle of a run. So the stone carries the fact and the label answers the
// question, which the player asks by swimming over and slowing down.
//
// ONE NODE, ONE LABEL AT A TIME, for the same reason ui/callout.js holds one
// line per surface: the yard is six stones and they can be a few units apart,
// so a label per stone is six captions stacked over a strip of seabed during a
// fight. The nearest one wins, and swapping between two is a fade rather than a
// cut — a caption that changes its words in place under a moving seal reads as
// a glitch, where the same change with a beat of nothing in the middle reads as
// having left one grave and arrived at another.
//
// NOT A CALLOUT, and that is a deliberate refusal to reuse. The world anchor in
// systems/callouts.js is a real label-on-its-subject and it was the obvious
// home for this, but it is ONE slot, it is the coach's, and it is priced as an
// interruption — cyan, twenty points, bloomed, and outranking every warning in
// the game. An epitaph is the opposite register: it is optional, it is quiet,
// and the player asked for it by going there. Putting it in that slot would
// mean a gravestone could talk over "Oxygen low!", which is the exact trade
// that file's header spends a paragraph refusing to make.
//
// IT NEVER BLOCKS THE FIGHT. The layer takes no pointer events and sits under
// the menus, unlike the callout layer — a caption about a seal that died four
// runs ago has no business finishing on top of the upgrade cards.
// ============================================================================

const CSS = `
  .sv-grave-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 4; }
  /* Stone colours, not interface colours. Everything else the game writes over
     the water is a system talking — a warning, a number, a tip — and is warm or
     cyan and glowing to say so. This is a thing IN the water being read, so it
     is the pale grey of the stone it is standing on and takes a shadow instead
     of a bloom. The one exception is the name, which is allowed to be slightly
     brighter than its own sub-line for the ordinary typographic reason. */
  .sv-grave { position: absolute; left: 0; top: 0; text-align: center;
    width: max-content; max-width: min(300px, 56vw); line-height: 1.2;
    text-wrap: balance; overflow-wrap: break-word;
    pointer-events: none; will-change: transform, opacity;
    text-shadow: 0 2px 8px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.8); }
  .sv-grave-name { display: block; font-weight: 800; letter-spacing: 0.06em;
    text-transform: uppercase; }
  .sv-grave-cause { display: block; font-weight: 500; letter-spacing: 0.02em;
    opacity: 0.72; margin-top: 2px; }
`;

let layer = null;
let box = null;
let nameEl = null;
let causeEl = null;

// What is on screen, and how far in it is. `shown` is the id of the grave the
// text currently BELONGS TO, which is not the same as the grave the seal is
// nearest — during a swap the text is still the old one on its way out.
let shown = null;
let alpha = 0;
let fading = false;
const anchor = { x: 0, y: 0 };

function cfg() {
  return CONFIG.gravesite?.label ?? {};
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function hexCss(hex, a = 1) {
  const n = (hex ?? 0xffffff) >>> 0;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * @param {HTMLElement} root uiRoot(), the same layer every other overlay is
 *   mounted into. A no-op if called twice — main.js builds the UI once, but
 *   the look pages mount pieces of it on their own terms.
 */
export function initGraveLabel(root) {
  if (layer || !root) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  layer = document.createElement('div');
  layer.className = 'sv-grave-layer';

  box = document.createElement('div');
  box.className = 'sv-grave sv-hidden';
  nameEl = document.createElement('span');
  nameEl.className = 'sv-grave-name';
  causeEl = document.createElement('span');
  causeEl.className = 'sv-grave-cause';
  box.append(nameEl, causeEl);
  layer.appendChild(box);
  root.appendChild(layer);
}

/** Take the label down now, with no fade. What a restart and a death call —
 *  a caption left standing over a graveyard the run has finished with. */
export function clearGraveLabel() {
  shown = null;
  alpha = 0;
  fading = false;
  box?.classList.add('sv-hidden');
}

/**
 * @param {number} dt      seconds. The gameplay delta is right here: the label
 *   belongs to a seal that is swimming, and a hit-stop that freezes the seal
 *   should freeze the caption riding above it too.
 * @param {object} ctx
 *   camera  world.camera
 *   x, y    the seal's world position
 *   live    false while the run is not being played — a menu, the death dive,
 *           the score card. The label fades out rather than vanishing, because
 *           the level-up cards open ON TOP of a live frame and a caption that
 *           blinks off the instant they do is a flicker in the corner of the
 *           eye during the one moment the player is reading something else.
 */
export function updateGraveLabel(dt, ctx = {}) {
  if (!box) return;
  const c = cfg();
  if (c.enabled === false) { clearGraveLabel(); return; }

  const step = Math.min(Math.max(dt ?? 0, 0), 0.1);
  const near = ctx.live === false || !ctx.camera
    ? null
    : nearestGrave(ctx.x ?? 0, c.radius ?? 6);

  // --- who the label is about ----------------------------------------------
  // A DIFFERENT grave takes the old one down first rather than swapping the
  // words underneath. See the header: an in-place change reads as a glitch.
  if (near && shown !== null && near.id !== shown) fading = true;
  else if (near && shown === near.id) fading = false;
  else if (near && shown === null) {
    shown = near.id;
    fading = false;
    nameEl.textContent = near.name;
    // Both, and the second is not optional in practice: the beam rakes from the
    // height it is given, so a sweep handed no base is displaced sideways by
    // the rake times the seabed's own depth — about thirteen units, which is
    // eight band-widths clear of the stone it was meant to light.
    sweepGrave(near.x, near.baseY);
    // THE STONE'S OWN LEAD, rolled once when the grave was filed — not a fresh
    // roll and not the config default. The caption and the inscription are the
    // same sentence about the same death, and a caption that said "chomped by"
    // over a stone reading "who ran out of" would be two writers describing one
    // seal.
    const lead = near.lead || CONFIG.gravesite?.etch?.lead || 'lost to';
    causeEl.textContent = near.cause ? `${lead} ${near.cause}` : '';
    anchor.x = near.x;
    anchor.y = near.topY;
  } else if (!near) fading = true;

  // --- how far in it is -----------------------------------------------------
  const inRate = 1 / Math.max(0.01, c.fadeIn ?? 0.22);
  const outRate = 1 / Math.max(0.01, c.fadeOut ?? 0.35);
  alpha += (fading ? -outRate : inRate) * step;
  alpha = Math.min(1, Math.max(0, alpha));

  // Fully out. Only NOW does the label let go of its subject, which is what
  // makes a swap two events instead of one: the next frame finds `shown` null
  // and adopts whichever grave the seal is over by then.
  if (alpha <= 0) {
    if (shown !== null) shown = null;
    box.classList.add('sv-hidden');
    return;
  }

  // --- where it sits --------------------------------------------------------
  // Projected at the stone's own x and the top of its head. The camera is
  // orthographic and unrotated, so a grave at z = -3.2 projects to the same
  // screen point as the z = 0 plane worldToScreen assumes — see its note. That
  // is true today and is the reason this can use the cheap call; a camera that
  // ever gains a tilt makes it wrong by the depth of the graveyard.
  worldToScreen(ctx.camera, anchor.x, anchor.y, anchor.pt ?? (anchor.pt = { x: 0, y: 0 }));
  const gap = c.gap ?? 26;
  const pad = c.pad ?? 10;
  const w = box.offsetWidth;
  const h = box.offsetHeight;

  const left = Math.min(Math.max(anchor.pt.x - w / 2, pad), Math.max(pad, window.innerWidth - w - pad));
  // Above the stone, and never flipped below it: a caption that swapped sides
  // when the camera rode low would be sitting in the seabed. Clamped to the
  // frame at BOTH ends instead — the same trade drawWorld takes, and for the
  // same reason: half a sentence against an edge is readable where none of it
  // is not. The bottom clamp is the one that matters, because the graveyard is
  // on the floor and the floor is the edge the camera leaves the frame at.
  const top = clamp(anchor.pt.y - gap - h, pad, Math.max(pad, window.innerHeight - h - pad));

  // The last of the arrival is a small rise, so it reads as coming up out of
  // the stone rather than switching on. Squared, so most of the travel is over
  // in the first third of the fade and the end is a settle.
  const lift = (1 - alpha) * (1 - alpha) * (c.rise ?? 10);
  box.style.left = `${left}px`;
  box.style.top = `${top + lift}px`;
  box.style.opacity = `${alpha}`;
  box.style.color = hexCss(c.color ?? 0xd9d2c4);
  nameEl.style.fontSize = `${c.nameSize ?? 17}px`;
  causeEl.style.fontSize = `${c.causeSize ?? 12}px`;
  box.classList.remove('sv-hidden');
}

/** What the label is saying, or null. For tests — there is no other way to ask
 *  a DOM node whether it is meaningfully visible rather than merely present. */
export function graveLabelState() {
  if (!box || box.classList.contains('sv-hidden')) return null;
  return { id: shown, name: nameEl.textContent, cause: causeEl.textContent, alpha };
}
