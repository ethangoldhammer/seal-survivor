import { CONFIG } from '../config.js';

// THE TROPHY — the kill shot, kept.
//
// systems/bossKill.js already stops the world and pushes the frame in on the
// seal for half a second after a boss dies. That moment is the best-looking
// thing the game produces and it was, until now, gone the instant it finished.
// This grabs it: one PNG per boss killed, composited with the boss's name and
// what the run was at when it died, held for the rest of the session and
// offered on the death screen with a share button.
//
// WHY THE GRAB HAS TO HAPPEN WHERE IT DOES. The renderer is built without
// `preserveDrawingBuffer` (see world.js), which is the right default — it lets
// the browser throw the colour buffer away the moment the frame is composited,
// and turning it on costs a full-screen copy on EVERY frame of the game to
// serve about eight frames in a whole run. The consequence is that
// `canvas.toDataURL()` returns a blank image unless it is called in the same
// task as the draw. So main.js calls capture() immediately after post.render(),
// inside the same frame, and this file cannot be driven from anywhere else.
//
// Nothing here is on the hot path. capture() runs at most once per boss.

const state = {
  // A data URL for the composited image, and the blob behind it. Both, because
  // they are wanted by different things: an <img> src takes the URL and the
  // share sheet takes a File made from the blob.
  url: null,
  blob: null,
  name: '',
  level: 0,
  score: 0,
  time: 0,
  at: 0,
};

function cfg() {
  return CONFIG.boss?.kill?.snapshot ?? {};
}

/** The trophy from this run, or null if no boss has been beaten. */
export function bossShot() {
  return state.url ? { ...state } : null;
}

/** A new run starts with no trophy — the death screen must not show the last one's. */
export function resetBossShot() {
  state.url = null;
  state.blob = null;
  state.name = '';
  state.level = 0;
  state.score = 0;
  state.time = 0;
  state.at = 0;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Grab the frame that is on screen RIGHT NOW and keep it.
 *
 * @param canvas the renderer's own canvas, mid-frame — see the note above.
 * @param meta   { name, level, score, time } for the caption.
 */
export function captureBossShot(canvas, meta = {}) {
  if (cfg().enabled === false || !canvas) return false;
  try {
    const out = compose(canvas, meta);
    if (!out) return false;
    state.url = out.toDataURL('image/png');
    state.name = meta.name ?? '';
    state.level = meta.level ?? 0;
    state.score = meta.score ?? 0;
    state.time = meta.time ?? 0;
    state.at = Date.now();
    // The blob is asynchronous and the URL is not, so the image is usable
    // immediately and the share sheet becomes available a beat later. That
    // ordering is deliberate: the death screen is seconds away at the earliest,
    // and an <img> that appears at once matters more than a button that does.
    out.toBlob?.((blob) => { state.blob = blob; }, 'image/png');
    return true;
  } catch (err) {
    // A tainted canvas, a lost context, a browser that refuses toDataURL on a
    // WebGL surface. None of it is worth a broken frame — the trophy is a
    // bonus, and the run carries on without one.
    console.warn(`[bossShot] could not keep the kill shot — ${err}`);
    return false;
  }
}

// The caption. Drawn onto a copy rather than over the live canvas, which would
// be drawing UI into the frame the player is still playing in.
function compose(src, meta) {
  const maxW = Math.max(320, cfg().maxWidth ?? 1600);
  const scale = Math.min(1, maxW / Math.max(1, src.width));
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  if (!(w > 0 && h > 0)) return null;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (!g) return null;
  // The game renders on a transparent canvas over a dark page (alpha: true in
  // world.js), so a straight copy onto an empty bitmap keeps that transparency
  // and every share target composites it against something different — usually
  // white. The backdrop is what makes the PNG look like the game rather than
  // like a screenshot of a bug.
  g.fillStyle = cfg().backdrop ?? '#05070d';
  g.fillRect(0, 0, w, h);
  g.drawImage(src, 0, 0, w, h);

  const band = Math.max(64, Math.round(h * (cfg().captionHeight ?? 0.22)));
  const grad = g.createLinearGradient(0, h - band, 0, h);
  grad.addColorStop(0, 'rgba(5,7,13,0)');
  grad.addColorStop(1, 'rgba(5,7,13,0.92)');
  g.fillStyle = grad;
  g.fillRect(0, h - band, w, band);

  const pad = Math.round(w * 0.035);
  const nameSize = Math.max(18, Math.round(h * 0.052));
  const subSize = Math.max(12, Math.round(h * 0.026));
  const family = CONFIG.typography?.family ?? 'system-ui, sans-serif';

  g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(255,120,120,0.95)';
  g.font = `700 ${subSize}px ${family}`;
  g.letterSpacing = '0.18em'; // ignored where unsupported; harmless
  g.fillText((cfg().kicker ?? 'DEFEATED').toUpperCase(), pad, h - pad - nameSize - subSize * 0.9);

  g.fillStyle = '#ffffff';
  g.font = `700 ${nameSize}px ${family}`;
  g.letterSpacing = '0.02em';
  fitText(g, (meta.name ?? 'A BOSS').toUpperCase(), pad, h - pad - subSize * 1.5, w - pad * 2, nameSize, family);

  g.fillStyle = 'rgba(232,236,243,0.72)';
  g.font = `600 ${subSize}px ${family}`;
  const bits = [
    `Level ${meta.level ?? 0}`,
    formatTime(meta.time),
    `${Math.floor(meta.score ?? 0).toLocaleString()} pts`,
  ];
  g.fillText(bits.join('  ·  '), pad, h - pad * 0.6);

  // The wordmark, right-aligned on the same line. It is the only reason a
  // stranger who sees this image knows what game it is.
  const mark = cfg().wordmark ?? 'SEAL SURVIVOR';
  g.textAlign = 'right';
  g.fillStyle = 'rgba(232,236,243,0.5)';
  g.fillText(mark, w - pad, h - pad * 0.6);
  g.textAlign = 'left';

  return out;
}

// Boss names run to forty characters ("Wicked Grimgullet the Chumbucket
// Rumbler"), and a name that runs off the edge of the image is worse than a
// small one. Shrinks until it fits, down to a floor.
function fitText(g, text, x, y, maxWidth, size, family) {
  let px = size;
  g.font = `700 ${px}px ${family}`;
  while (g.measureText(text).width > maxWidth && px > 12) {
    px -= 1;
    g.font = `700 ${px}px ${family}`;
  }
  g.fillText(text, x, y);
}

/** A filename with the boss and the date in it, so a folder of these reads. */
function fileName() {
  const slug = (state.name || 'boss').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `seal-survivor-${slug || 'boss'}.png`;
}

/**
 * Hand the image to the player. MUST be called from a click — both the share
 * sheet and (on some browsers) the download are gated on a user gesture.
 *
 * Three routes, in order of how good they are, and the first one that exists
 * wins:
 *   1. THE NATIVE SHARE SHEET, with the file attached. This is the one the
 *      request was actually about — it is what puts the image into Messages,
 *      Instagram, Discord, anywhere the device knows about — and it is the only
 *      route that can hand over a FILE rather than a link. Mobile, mostly.
 *   2. A DOWNLOAD, which every desktop browser can do, leaving the player to
 *      post it themselves.
 *   3. Opening it in a tab, if even the download anchor is refused.
 *
 * Nothing here posts anything anywhere. The share sheet is the OS asking the
 * player where they want it; this code never sees an account and never picks a
 * destination.
 *
 * @returns 'shared' | 'saved' | 'opened' | 'cancelled' | 'unavailable'
 */
export async function shareBossShot() {
  if (!state.url) return 'unavailable';

  const title = state.name ? `I beat ${state.name}` : 'Seal Survivor';
  const text = state.name
    ? `${title} at level ${state.level} in Seal Survivor. ${cfg().url ?? 'https://seal-survivor.pages.dev'}`
    : `Seal Survivor. ${cfg().url ?? 'https://seal-survivor.pages.dev'}`;

  const file = state.blob
    ? new File([state.blob], fileName(), { type: 'image/png' })
    : null;

  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      // AbortError is the player closing the sheet, which is not a failure and
      // must not fall through to a download they did not ask for.
      if (err?.name === 'AbortError') return 'cancelled';
      console.warn(`[bossShot] share failed, saving instead — ${err}`);
    }
  }
  return saveBossShot();
}

/** Straight to disk, no sheet. Also the fallback for share. */
export function saveBossShot() {
  if (!state.url) return 'unavailable';
  try {
    const a = document.createElement('a');
    a.href = state.url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    return 'saved';
  } catch (err) {
    console.warn(`[bossShot] could not save — ${err}`);
    window.open(state.url, '_blank');
    return 'opened';
  }
}
