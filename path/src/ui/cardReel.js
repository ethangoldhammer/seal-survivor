// THE REEL — the level-up hand arrives by rolling, not by fading.
//
// Every card is already a hexagon (.sv-card, clipped on the art's own
// vertices), and flat-top hexagons tile perfectly in a VERTICAL COLUMN — one
// full card height per step, no half-offset. So a card can be a window onto a
// strip of other cards without a single seam showing, which is the whole
// reason this shape works here and a slot machine of squares would not.
//
// WHAT ROLLS PAST IS THE REAL POOL. The faces are upgrades the run could
// actually be offered right now — near-misses — drawn by ui.js from
// availableUpgrades() minus the hand being dealt. Nothing that cannot be
// offered ever blurs past, so the reel never advertises a card the run has no
// way to give you.
//
// THE REEL LANDS IN TIER ORDER, LOWEST FIRST. That is not the order the cards
// sit in: read left to right the hand is arbitrary, read floor-upwards it is a
// build, and the best card on the table is the last reel to stop. It is the
// same order the ignition already used (see igniteCards in ui.js) — the reel
// took the sequence over rather than adding a second one beside it, because
// two staggers on one hand fight.
//
// FIVE THINGS THAT RENDER PLAUSIBLY AND ARE WRONG:
//
//   A STRIP WITH NO HEIGHT     each face is positioned `top: i * 100%`, and a
//                              percentage top resolves against the CONTAINING
//                              BLOCK. The strip is `inset: 0` so that block is
//                              the card. Give the strip auto height instead
//                              and every face resolves to top: 0, stacks on
//                              face zero, and the reel spins for its full
//                              duration showing one motionless picture.
//
//   THE CARD AS A BACKDROP     the real card has to be the LAST CELL OF THE
//                              MOVING STRIP. Leave it sitting still under a
//                              strip of decoys that scrolls away and the reel
//                              does not decelerate onto your card — the last
//                              decoy slides off and uncovers it. That reads as
//                              a wipe, not as a machine stopping, and it is
//                              the difference between the whole effect landing
//                              and not.
//
//   A STALL AT THE HANDOVER    the roll is a cruise and then a deceleration,
//                              and the two have to hand over at the SAME
//                              SPEED. A cubic ease-out covering distance D in
//                              time T starts at 3D/T, so the number of faces
//                              is derived from the cruise speed rather than
//                              set beside it — see faceCount. Pick the two
//                              independently and the reel visibly hesitates,
//                              or lurches, one third of the way from the end.
//
//   A CAP THAT EATS THE TRAVEL the face count is capped, because a slow
//                              machine should not build ninety divs. The cap
//                              lowers the SPEED, never the curve: clamp the
//                              count alone and the reel simply arrives already
//                              stopped and holds a static card for the rest of
//                              its duration, which looks like a bug in the
//                              timing rather than in the cap.
//
//   A CARD LEFT INSIDE A STRIP landing has to put the card's own overlay,
//                              content and background back on .sv-card and
//                              delete the strip. Everything downstream — the
//                              text fit, the hover tip, the pick, the clone
//                              that flies to the hive — reads the shape
//                              showLevelUp built, and a card that stayed
//                              wrapped works until the first one of those
//                              looks for a child it can no longer see.
//
// The decoys carry a NAME and no description. cardDesc/cardEffect replay an
// upgrade's own apply() against probe stat blocks — real work, and the right
// price for a card you are being asked to choose. Sixty of them, at eighteen a
// second, for text nobody can read, is the entire cost of the menu spent on
// nothing.
//
// Nothing here reads a layout property, and nothing runs off the game loop:
// the run is paused behind this menu, so the roll owns a rAF of its own the
// way the dissolve does (see runReveal in ui.js).
import { CONFIG } from '../config.js';

// The reel currently rolling, if any. One at a time by construction — a second
// level-up landing on top of the first tears this one down first (ui.js calls
// cancelReel from cancelIgnition).
let live = null;

function cfg() {
  const c = CONFIG.upgradeReel ?? {};
  return {
    enabled: c.enabled !== false,
    speed: Math.max(1, c.speed ?? 22),
    first: Math.max(0.05, c.first ?? 0.62),
    stagger: Math.max(0, c.stagger ?? 0.3),
    knee: Math.min(0.95, Math.max(0.05, c.knee ?? 0.66)),
    bounce: Math.max(0, c.bounce ?? 0.9),
    blur: Math.max(0, c.blur ?? 2),
    minFaces: Math.max(2, Math.round(c.minFaces ?? 6)),
    maxFaces: Math.max(2, Math.round(c.maxFaces ?? 26)),
  };
}

/**
 * WHICH REEL STOPS WHEN — the whole schedule, as data.
 *
 * Pulled out as a pure function of the ranks so the harness can assert the
 * order and the timing without a browser: a reel that stops in the wrong order
 * is the one failure here that is invisible in a still and unarguable in a
 * list. See tools/card-reel-test.mjs.
 *
 * @param ranks  each card's rarity rank, in the order the cards sit on screen.
 * @returns one entry per card, in SCREEN order, each carrying the moment it
 *          lands, how many faces it rolls to get there, and its place in the
 *          sequence.
 */
export function reelPlan(ranks, c = cfg()) {
  // Ties keep their dealt order, so two cards of the same tier still land left
  // to right rather than swapping around between level-ups.
  const order = ranks
    .map((rank, i) => ({ i, rank: Number(rank) || 0 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i));

  const plan = ranks.map(() => null);
  order.forEach(({ i }, step) => {
    const seconds = c.first + step * c.stagger;
    plan[i] = { index: i, step, seconds, faces: faceCount(seconds, c) };
  });
  return plan;
}

// How many faces a reel of this length rolls past.
//
// Derived from the cruise speed and the shape of the curve, NOT chosen: the
// deceleration has to start at exactly the speed the cruise ended at, and a
// tail that eases over time T from speed v covers v*T/k, where k is that
// easing's opening slope (3 for a cubic, 3 + bounce with the overshoot on).
// So the distance is fixed once the speed and the knee are, and the count is
// what falls out.
export function faceCount(seconds, c = cfg()) {
  const k = 3 + c.bounce;
  const shape = c.knee + (1 - c.knee) / k;
  return Math.max(c.minFaces, Math.min(c.maxFaces, Math.round(c.speed * seconds * shape)));
}

/**
 * Where a reel is, in faces, at time t. 0 is the first decoy, `faces` is the
 * real card.
 *
 * Two phases. A cruise at a constant speed — this is the part that reads as a
 * machine rather than as an animation — and then a tail that eases onto the
 * card, overshooting a touch and settling back if `bounce` is on. The cruise
 * speed is re-derived from the face count rather than taken from config, so a
 * count that hit the cap slows the reel down instead of truncating its travel.
 */
export function reelPos(t, seconds, faces, c = cfg()) {
  if (t >= seconds) return faces;
  if (t <= 0) return 0;
  const k = 3 + c.bounce;
  const shape = c.knee + (1 - c.knee) / k;
  const speed = faces / (seconds * shape);   // faces per second, at cruise
  const kneeT = seconds * c.knee;
  if (t < kneeT) return speed * t;

  const tail = seconds - kneeT;
  const x = (t - kneeT) / tail;
  const from = speed * kneeT;
  const d = faces - from;
  const y = c.bounce > 0
    // easeOutBack: past the card by a few per cent of what is left, then back
    // onto it — a reel settling rather than arriving.
    ? 1 + (c.bounce + 1) * (x - 1) ** 3 + c.bounce * (x - 1) ** 2
    : 1 - (1 - x) ** 3;
  return from + d * y;
}

// --- the strip ---------------------------------------------------------------

function faceEl(top) {
  const el = document.createElement('div');
  el.className = 'sv-reel-face';
  el.style.top = `${top * 100}%`;
  return el;
}

function decoyEl(top, face) {
  const el = faceEl(top);
  if (face?.image) {
    el.style.backgroundImage = `url(${face.image})`;
    el.style.backgroundSize = '100% 100%';
    el.style.backgroundPosition = 'center';
  }
  // Its own tier's ring, so the ladder is part of what is spinning. The real
  // card's ring is switched off for the duration (see build) — it is drawn on
  // the window rather than on a face, so leaving it up would announce the tier
  // the reel is about to land on before it lands.
  if (face?.ring) {
    el.style.boxShadow = `inset 0 0 0 ${CONFIG.rarityCard?.ringWidth ?? 3}px ${face.ring}`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'sv-card-overlay';
  const oc = CONFIG.levelUpCards?.overlayColor ?? 0;
  const [r, g, b] = [(oc >> 16) & 255, (oc >> 8) & 255, oc & 255];
  overlay.style.background = face?.image
    ? `rgba(${r},${g},${b},${CONFIG.levelUpCards?.overlayOpacity ?? 0.4})`
    : 'transparent';

  const content = document.createElement('div');
  content.className = 'sv-card-content';
  const name = document.createElement('div');
  name.className = 'sv-card-name';
  name.textContent = face?.name ?? '';
  content.appendChild(name);

  el.append(overlay, content);
  return el;
}

// Wrap one card in a strip: `faces` decoys, then the card's own look as the
// last cell. Returns what landing needs to put it all back.
function build(card, faces, face) {
  const strip = document.createElement('div');
  strip.className = 'sv-reel';
  for (let i = 0; i < faces; i++) strip.appendChild(decoyEl(i, face()));

  const real = faceEl(faces);
  real.style.backgroundImage = card.style.backgroundImage;
  real.style.backgroundSize = card.style.backgroundSize;
  real.style.backgroundPosition = card.style.backgroundPosition;
  const moved = [...card.children];
  real.append(...moved);
  strip.appendChild(real);

  const held = {
    bg: card.style.backgroundImage,
    size: card.style.backgroundSize,
    pos: card.style.backgroundPosition,
    ring: card.style.getPropertyValue('--sv-ring-w'),
  };
  card.style.backgroundImage = '';
  // The window's own ring would sit still through the whole roll spelling out
  // the tier that is coming. Off until it lands; each decoy draws its own.
  card.style.setProperty('--sv-ring-w', '0px');
  card.appendChild(strip);

  return { card, strip, real, moved, held, faces };
}

function landOne(r) {
  if (r.landed) return;
  r.landed = true;
  r.card.append(...r.moved);
  r.card.style.backgroundImage = r.held.bg;
  r.card.style.backgroundSize = r.held.size;
  r.card.style.backgroundPosition = r.held.pos;
  if (r.held.ring) r.card.style.setProperty('--sv-ring-w', r.held.ring);
  else r.card.style.removeProperty('--sv-ring-w');
  r.strip.remove();
}

/**
 * Roll a dealt hand.
 *
 * @param cards   the .sv-card elements, in screen order. Each is expected to
 *                carry data-rarity-rank — applyRarityStyle puts it there.
 * @param face    () -> { name, image, ring } for one decoy. Called once per
 *                face; ui.js owns what the pool is.
 * @param onLand  (card, step) as each reel stops, in tier order. This is what
 *                fires the flare, the pop and the tier's sting.
 * @param onDone  once the last reel has landed, or the roll was skipped.
 * @returns a handle with skip(), or null if nothing could roll — in which case
 *          onDone has NOT been called and the caller keeps its own path.
 */
export function rollReels(cards, { face, onLand, onDone }) {
  cancelReel();
  const c = cfg();
  if (!c.enabled || !cards.length) return null;

  const plan = reelPlan(cards.map((card) => card.dataset.rarityRank), c);
  const reels = cards.map((card, i) => ({
    ...build(card, plan[i].faces, face),
    seconds: plan[i].seconds,
    step: plan[i].step,
    landed: false,
    blur: -1,
  }));

  const start = performance.now();
  const last = Math.max(...reels.map((r) => r.seconds));

  // Times itself off performance.now() for the reason runReveal gives: the
  // timestamp rAF hands in is not guaranteed to be the same clock `start` came
  // from, and a roll measured across two clocks either finishes on frame one
  // or never finishes at all.
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    // WHO LANDED THIS FRAME, IN TIER ORDER. Collected rather than fired inside
    // the loop below, because the loop runs in SCREEN order: on any frame long
    // enough to cover two stops — a hitch, a tab coming back, a machine slow
    // enough that a frame is longer than the stagger — both would land, and
    // the flare and the sting would announce them left to right instead of
    // worst to best. The whole sequence would be wrong on exactly the frames
    // nobody reproduces.
    const due = [];
    for (const r of reels) {
      if (r.landed) continue;
      const p = reelPos(t, r.seconds, r.faces, c);
      r.strip.style.transform = `translateY(${(-p * 100).toFixed(3)}%)`;

      // Blur tracks speed, quantised: `filter` on a moving layer repaints it,
      // and writing the same string sixty times a second is the one thing here
      // that would cost a frame.
      if (c.blur > 0) {
        const ahead = reelPos(Math.min(t + 1 / 60, r.seconds), r.seconds, r.faces, c);
        const px = Math.round(Math.min(c.blur, Math.abs(ahead - p) * c.blur * 4) * 4) / 4;
        if (px !== r.blur) {
          r.blur = px;
          r.strip.style.filter = px > 0.01 ? `blur(${px}px)` : 'none';
        }
      }

      if (t >= r.seconds) due.push(r);
    }
    for (const r of due.sort((a, b) => a.step - b.step)) {
      landOne(r);
      onLand?.(r.card, r.step);
    }
    if (t >= last) {
      live = null;
      onDone?.();
      return;
    }
    // Only if the roll is still ours: onLand above runs the caller's code, and
    // a card picked or a level-up landing inside it can have torn this down
    // already. Without the guard the loop resurrects itself against a strip
    // that is no longer in the document.
    if (live) live.raf = requestAnimationFrame(frame);
  };

  live = {
    raf: 0,
    reels,
    // THE SKIP. Everything lands on this frame, and the reels that had not
    // stopped yet still get their moment — handed back in tier order to the
    // caller, which puts them on the ignition's own ladder. Skipping the roll
    // is not the same as skipping the read-out of what was dealt.
    skip() {
      if (!live) return [];
      cancelAnimationFrame(live.raf);
      const pending = reels.filter((r) => !r.landed).sort((a, b) => a.step - b.step);
      for (const r of reels) landOne(r);
      live = null;
      return pending.map((r) => ({ card: r.card, step: r.step }));
    },
  };
  // First frame painted synchronously, so a card is never on screen unrolled
  // for the frame between the menu being shown and the first rAF landing. It
  // schedules the next one itself — asking for a frame here as well would
  // leave two loops driving the same strips, at double speed.
  const handle = live;
  frame();
  return handle;
}

/** Tear a live roll down where it stands, leaving every card intact. */
export function cancelReel() {
  if (!live) return;
  cancelAnimationFrame(live.raf);
  for (const r of live.reels) landOne(r);
  live = null;
}

/** Whether a roll is on screen right now — what the skip binding asks. */
export function reelRolling() {
  return !!live;
}
