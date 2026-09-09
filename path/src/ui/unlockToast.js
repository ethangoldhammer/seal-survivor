import { CONFIG } from '../config.js';
import { ACCESSORY_ICONS } from './accessoryIcons.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
import { feedback } from '../systems/feedback.js';

// ---------------------------------------------------------------------------
// THE UNLOCK TOAST — a gate popping, mid-run.
//
// A card drops in from the top of the screen, holds, and lifts out: the
// picture of the thing (its drawer icon for an accessory, its card art for an
// upgrade) beside the row's `label` from unlocks.csv. That line is the whole
// copy — it is Ethan's, it names the thing and the deed in one breath, and a
// heading over it would say "unlocked" twice.
//
// IT ANNOUNCES, IT DOES NOT GRANT. The thing is collected at the end of the
// run (systems/unlocks.js, commitUnlocks): this is the receipt, not the
// handover, so nothing here touches the slot or the offer pool.
//
// WALL CLOCK, ON PURPOSE. A boss unlock lands inside the kill shot, which runs
// the water's clock at a fifth of a second per second; a toast timed on that
// clock would crawl. CSS animations run on the compositor's clock and ignore
// the game's dilation entirely, so the motion is CSS keyframes and the only
// number JS hands them is the total length. Which also means it survives a
// paused game, which is where the player is most likely to read it.
//
// ONE AT A TIME. Two gates can pop on one hull (a hat and a stat both crossing
// 50); the second waits for the first to leave rather than stacking. The
// queue is small, and it is drained by the animation ending — not by a timer,
// so a tab in the background (where animations do not run) does not spend
// the toasts unseen.
//
// THE LOOK IS A DRAFT. Every number is in CONFIG.unlockToast and on the tuner
// so the timing can be dragged live; the shape of the motion is the
// keyframes below and is the thing a look page would iterate on.
// ---------------------------------------------------------------------------

const STYLES = `
  .sv-unlock-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 30; }
  .sv-unlock { position: absolute; left: 50%; top: var(--sv-unlock-top, 9vh);
    display: flex; align-items: center; gap: 12px; padding: 9px 16px 9px 10px;
    border-radius: 10px; background: rgba(8,18,30,0.78); border: 1px solid rgba(150,200,255,0.28);
    box-shadow: 0 8px 28px rgba(0,0,0,0.45), 0 0 18px rgba(124,230,160,0.18);
    backdrop-filter: blur(8px); color: rgba(232,244,255,0.95); white-space: nowrap;
    transform: translate(-50%, -160%); opacity: 0; will-change: transform, opacity;
    animation: sv-unlock-in var(--sv-unlock-time, 3.2s) var(--sv-unlock-ease, cubic-bezier(.2,.9,.25,1)) forwards; }
  .sv-unlock-pic { width: 44px; height: 44px; border-radius: 6px; flex: 0 0 auto;
    background: linear-gradient(160deg, rgba(120,150,180,0.35), rgba(60,80,100,0.2)) center / contain no-repeat; }
  .sv-unlock-label { font-size: 15px; font-weight: 700; letter-spacing: 0.06em;
    text-shadow: 0 2px 5px rgba(0,0,0,0.9); }
  @keyframes sv-unlock-in {
    0%   { transform: translate(-50%, -160%) scale(0.92); opacity: 0; }
    12%  { transform: translate(-50%, 0) scale(1.04); opacity: 1; }
    17%  { transform: translate(-50%, 0) scale(1); }
    84%  { transform: translate(-50%, 0) scale(1); opacity: 1; }
    100% { transform: translate(-50%, -160%) scale(0.96); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sv-unlock { animation-name: sv-unlock-still; }
    @keyframes sv-unlock-still {
      0% { transform: translate(-50%, 0); opacity: 0; } 8% { opacity: 1; } 90% { opacity: 1; }
      100% { transform: translate(-50%, 0); opacity: 0; }
    }
  }
`;

let styled = false;
let layer = null;
let showing = null;
const queue = [];

function cfg() {
  return CONFIG.unlockToast ?? {};
}

/**
 * Put the layer into the HUD. Idempotent; called once by main.js with the UI
 * root, and by a harness with any element.
 */
export function mountUnlockToasts(parent) {
  if (!styled) {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    styled = true;
  }
  if (layer && layer.parentNode === parent) return layer;
  layer?.remove();
  layer = document.createElement('div');
  layer.className = 'sv-unlock-layer';
  parent.appendChild(layer);
  return layer;
}

/** Drop whatever is up and queued — a run ending, a menu taking the screen. */
export function clearUnlockToasts() {
  queue.length = 0;
  showing?.remove();
  showing = null;
}

/**
 * Announce a popped gate.
 *
 * @param gate  what unlockProgress() returns — `{ kind, target, label }` is all
 *   that is read. A gate with no label shows nothing: the label is the toast,
 *   and a card with a picture and no words would look like a bug.
 */
export function showUnlockToast(gate) {
  const c = cfg();
  if (c.enabled === false || !layer || !gate?.label) return null;
  queue.push(gate);
  if (!showing) next();
  return gate;
}

function next() {
  const gate = queue.shift();
  if (!gate) { showing = null; return; }
  const c = cfg();
  const node = document.createElement('div');
  node.className = 'sv-unlock';
  node.style.setProperty('--sv-unlock-top', `${c.top ?? 9}vh`);
  node.style.setProperty('--sv-unlock-time', `${c.time ?? 3.2}s`);

  const pic = document.createElement('div');
  pic.className = 'sv-unlock-pic';
  const art = artFor(gate);
  if (art) pic.style.backgroundImage = `url("${art}")`;

  const label = document.createElement('div');
  label.className = 'sv-unlock-label';
  label.textContent = gate.label;

  node.append(pic, label);
  // The animation ending is what advances the queue; `animationcancel` covers
  // a layer torn down mid-toast so the next one is not orphaned.
  const done = () => {
    node.remove();
    if (showing === node) { showing = null; next(); }
  };
  node.addEventListener('animationend', done);
  node.addEventListener('animationcancel', done);
  layer.appendChild(node);
  showing = node;
  if (c.sfx !== false) feedback('unlock');
  return node;
}

// The picture: the same render the drawer shows for an accessory, the same
// art the level-up card wears for an upgrade. Either can be missing (nothing
// shot yet, a card with no art), and then the tile is its neutral slate.
function artFor(gate) {
  if (gate.kind === 'accessory') return ACCESSORY_ICONS[gate.target] ?? null;
  if (gate.kind === 'upgrade') {
    const u = (CONFIG.upgrades ?? []).find((x) => x.id === gate.target);
    return (u?.cardArt && LEVELUP_IMAGES?.[u.cardArt]) ?? null;
  }
  return null;
}

/** For the harness: what is on screen and what is waiting. */
export function unlockToastState() {
  return { showing: showing?.querySelector('.sv-unlock-label')?.textContent ?? null, queued: queue.length };
}
