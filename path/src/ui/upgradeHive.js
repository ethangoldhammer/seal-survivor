// THE HEX HIVE — every upgrade you hold, tiled into a corner, flashing when it
// fires.
//
// A run ends with twenty-odd picks and the only record of them was the cards
// themselves, seen once each. This is the build as a standing object: one hex
// per upgrade, stacks as pips, and a pulse on the frame the ability goes off so
// the passive half of a build stops being invisible.
//
// THREE THINGS ARE DELIBERATELY SEPARATE, because they are three different
// questions and auditioning them together is how you end up unable to say which
// one is wrong:
//
//   layout  where the tiles sit           cluster | rows | arc
//   style   what a tile is made of        art | ink | rarity
//   pulse   what firing looks like        per family, see PULSE
//
// All three are CONFIG.upgradeHive fields, so they can be cycled live (see the
// keys in main.js) and saved with the rest of the tuning.
//
// NO PER-FRAME WORK. The tiles are rebuilt only when the held set changes, and a
// pulse is a CSS animation restarted by toggling a class — so a fight that fires
// nine abilities a second costs nine class writes, not nine layouts. The one
// thing that would undo that is reading any layout property here; nothing does.
import { CONFIG } from '../config.js';
import { UPGRADE_ICONS } from './upgradeIcons.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
import { onFeedback } from '../systems/feedback.js';

// Which upgrade a feedback event belongs to.
//
// Read off the systems that fire them — see the event list in CONFIG.feedback.
// Several abilities own more than one event and all of them pulse the same
// tile: a beluga bubble trapping something and that bubble later popping are
// both the beluga doing its job.
//
// EVENTS NOT LISTED HERE ARE IGNORED, which is most of them. `shoot`, `kill`
// and `pickup` fire constantly and belong to no card in particular; wiring them
// to the tiles that scale them (every gun upgrade at once) would leave a third
// of the hive strobing continuously, which is the exact failure the pulse is
// meant to avoid — a signal that is always on is not a signal.
// Exported for the audit in tools/hive-test.mjs, which checks both halves of
// every entry against the live CONFIG — nothing else reads it.
export const EVENT_UPGRADE = {
  shrimpHit: 'shrimpRing',
  seagullDive: 'seagullBomb',
  sealRam: 'sealTeam', sealLunge: 'sealTeam', sealShot: 'sealTeam',
  belugaTrap: 'beluga', belugaPop: 'beluga', belugaSplit: 'beluga',
  eelBolt: 'electricEel', eelChain: 'electricEel',
  harpPluck: 'harp', harpCharm: 'harp', harpAura: 'harp',
  octoGrab: 'octoGrab', octoPop: 'octoGrab',
  dumboCharm: 'dumbo',
  bakalarBombDrop: 'bakalar', bakalarBombBlast: 'bakalar', bakalarHaul: 'bakalar',
  orcaStrike: 'orcaFamily',
  clubWhack: 'club', clubRicochet: 'club',
  clubThrow: 'clubThrow',
  clubBoom: 'clubBoom',
  clubFreeze: 'clubIce',
  scallopLaunch: 'scallopSquirter', scallopJet: 'scallopSquirter',
  pearlShot: 'oysterBlaster', pearlBurst: 'oysterBlaster',
  calamariPulse: 'calamari',
  garlicTick: 'seaGarlic',
  missileLaunch: 'homingMissile', missileImpact: 'homingMissile',
  missileLaunchExtra: 'homingMissile',
  musselBarrage: 'musselVolley',
  maneaterProc: 'maneater',
  beamCut: 'laserEyes',
  bounce: 'bounceShot',
  strikeBurst: 'strikeShrapnel',
  strikeChain: 'strikePower',
  strikeRam: 'strikeDash',
  strikePip: 'strikeCharge',
  elementArc: 'bioluminescence', elementFreeze: 'bioluminescence',
  elementHitShock: 'bioluminescence', elementHitVenom: 'bioluminescence',
  elementHitChill: 'bioluminescence', elementHitInfection: 'bioluminescence',
};

// How a family announces itself. The families are the ones config.js already
// sorts the upgrades into, so this needs no table of its own per card.
//
// The shapes differ because the ABILITIES differ, not for variety: a thrown
// weapon has a moment of release and gets a punch, an aura has no moment at all
// and gets a swell, a companion acts on its own schedule and gets a lean. A
// strike is the one you asked for, so it gets the hardest flash of the four.
const PULSE = {
  projectile: 'pop',
  gun: 'pop',
  aoe: 'swell',
  companion: 'lean',
  strike: 'flash',
  utility: 'glow',
};

const state = {
  root: null,
  host: null,
  tiles: new Map(),   // upgrade id -> tile element
  held: '',           // signature of the last built set, so rebuilds are rare
  lastPicks: null,    // what to re-lay-out from when the LAYOUT changes
  off: null,
};

function cfg() {
  return CONFIG.upgradeHive ?? {};
}

// THE TILE IS A SQUARE. THE HEXAGON INSIDE IT IS NOT THE WHOLE SQUARE.
//
// The art in design/assets is a flat-top hexagon DRAWN WITH A MARGIN inside a
// square 512x512 image: measured, the shape including its dark border runs
// 5.5%-94.1% across and 12.7%-89.8% down, and it is very nearly regular
// (ratio 0.870 against a true hexagon's 0.866).
//
// So a tile carries the art the way a level-up card does — square box,
// background-size 100% 100%, clipped on the vertices the art actually has (see
// .sv-card, where these same numbers came from). Getting this wrong is not
// subtle and it is not symmetrical: a non-square box squashes the drawing, and
// a clip on generic full-bleed hexagon vertices then cuts through the border it
// no longer lines up with, shaving the outline off two sides and leaving it on
// the others.
//
// Which means the PACKING cannot use the box. Tiles are laid out on the
// hexagon that is actually visible, and each square box is then hung around its
// centre — so neighbouring BOXES overlap heavily and correctly, while the
// hexagons interlock exactly.
const ART = {
  left: 0.057, right: 0.939,      // the clip's vertices, a shade inside the ink
  top: 0.127, bottom: 0.896,      // so the outer antialiased edge is trimmed
};
ART.w = ART.right - ART.left;     // visible hexagon width, as a fraction of the box
ART.h = ART.bottom - ART.top;     // and its height
ART.cx = (ART.left + ART.right) / 2;
ART.cy = (ART.top + ART.bottom) / 2;

// Exported so tools/hive-test.mjs measures the same hexagons the CSS draws,
// rather than the square boxes, which legitimately overlap.
export const HEX_GEOMETRY = ART;

// Centres, in the space of the VISIBLE hexagons — `w`/`h` here are the drawn
// hexagon's size, not the tile box's. rebuild() hangs the boxes around them.
function hexPositions(n, layout, w, h, gap) {
  const stepX = w * 0.75 + gap;
  const stepY = h + gap;
  const out = [];

  if (layout === 'rows') {
    // Offset rows growing UPWARD out of the corner, which is the direction the
    // corner block already grows (see .sv-hud-corner's column rule).
    const per = cfg().perRow ?? 5;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / per);
      const col = i % per;
      out.push({ x: col * stepX, y: -row * stepY - (col % 2 ? stepY / 2 : 0) });
    }
    return out;
  }

  if (layout === 'arc') {
    // A band curving around the corner. `bow` is how far the middle of the run
    // bulges away from the straight line — at 0 this is one long row.
    const bow = cfg().bow ?? 0.55;
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      out.push({ x: i * stepX, y: -Math.sin(t * Math.PI) * h * bow * n * 0.14 });
    }
    return out;
  }

  // cluster: a spiral of rings, which is the only one of the three that stays
  // roughly square as it grows. A build of six and a build of twenty-six want
  // very different footprints and this is the layout that gives both of them a
  // blob rather than a stripe.
  // The six axial neighbours, IN RING ORDER, and the ring is entered at the
  // corner that order starts from — DIRS[4] scaled out by the radius. The two
  // have to agree: walking a correct set of directions from the wrong corner
  // re-visits cells it has already placed, which puts several tiles at exactly
  // the same coordinates. It does not look like a packing bug from a distance,
  // it looks like a hive with fewer upgrades in it than you are holding.
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const cells = [[0, 0]];
  for (let ring = 1; cells.length < n; ring++) {
    let q = DIRS[4][0] * ring, r = DIRS[4][1] * ring;
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < ring; step++) {
        cells.push([q, r]);
        q += DIRS[side][0];
        r += DIRS[side][1];
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const [q, r] = cells[i];
    out.push({ x: q * stepX, y: (r + q / 2) * stepY });
  }
  return out;
}

// The tiles, as one string. A rebuild is only worth doing when the SET changed —
// picking a second Shrimp Ring changes a pip, not the layout, so the signature
// carries the stack count too but the rebuild it triggers is still the cheap
// path compared with laying out on every frame.
function signature(held) {
  return held.map((h) => `${h.id}:${h.count}:${h.rarity}`).join(',');
}

// player.upgrades is a flat list with one entry per PICK — six Shrimp Rings are
// six entries. The hive shows one tile per ability, so they are folded here,
// keeping the best tier seen: a card dealt Legendary is the interesting fact
// about that stack and it must not be lost behind five Commons.
const TIER_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export function foldUpgrades(picks) {
  const by = new Map();
  for (const p of picks) {
    const cur = by.get(p.id);
    if (!cur) { by.set(p.id, { id: p.id, count: 1, rarity: p.rarity ?? 'common' }); continue; }
    cur.count += 1;
    if (TIER_ORDER.indexOf(p.rarity) > TIER_ORDER.indexOf(cur.rarity)) cur.rarity = p.rarity;
  }
  return [...by.values()];
}

// The tier colour AS CSS.
//
// rarityTable.js parses the `#rrggbb` in rarities.csv into a NUMBER, because
// almost everything that wants it wants it for three.js. Handing that straight
// to a custom property is the bug this exists to avoid: `--sv-hive-rarity`
// becomes `12108492`, which is not invalid CSS at parse time — it is a perfectly
// good custom-property value — so nothing warns. It only falls over where it is
// USED, and there the whole declaration is dropped as invalid at computed-value
// time, taking the var's own fallback with it. The result is a tile with no rim
// and, in the `rarity` style, no face at all: not a subtle colour, no background
// whatsoever, and no error anywhere. Same conversion applyRarityStyle uses.
function rarityColor(id) {
  const c = CONFIG.rarities?.find((r) => r.id === id)?.color;
  if (c == null) return '#b8c2cc';
  return typeof c === 'number' ? `#${(c >>> 0).toString(16).padStart(6, '0')}` : c;
}

function upgradeDef(id) {
  return CONFIG.upgrades?.find((u) => u.id === id);
}

// The mark on the face.
//
// A render if this upgrade has one, and a MONOGRAM if it does not. The monogram
// is not a stopgap waiting to be replaced everywhere: two thirds of the roster
// fires a primitive (Homing Mussels is a black oval) or grants no object at all
// (Sea Garlic is an aura), and those will always need a drawn mark. Showing
// initials makes the gap visible during a run instead of leaving a blank tile
// that reads as a loading failure.
function markFor(id, def) {
  const src = UPGRADE_ICONS[id];
  if (src) {
    const img = document.createElement('img');
    img.className = 'sv-hive-icon';
    img.src = src;
    img.alt = '';
    return img;
  }
  const mono = document.createElement('div');
  mono.className = 'sv-hive-mono';
  // Initials off the DISPLAY name — the name on the card is what the player
  // has actually read. "Big Willy Style" is BW, not `breachChain`.
  const words = (def?.name ?? id).split(/[\s'']+/).filter(Boolean);
  mono.textContent = words.length > 1
    ? (words[0][0] + words[1][0]).toUpperCase()
    : (def?.name ?? id).slice(0, 2).toUpperCase();
  return mono;
}

function buildTile(entry) {
  const def = upgradeDef(entry.id);
  const el = document.createElement('div');
  el.className = 'sv-hive-tile';
  el.dataset.upgrade = entry.id;
  el.dataset.family = def?.family ?? 'utility';
  el.dataset.pulse = PULSE[def?.family] ?? 'glow';
  el.style.setProperty('--sv-hive-rarity', rarityColor(entry.rarity));

  const face = document.createElement('div');
  face.className = 'sv-hive-face';
  // `art` style only: the biome hex the card was dealt on, behind the mark. It
  // cannot identify the upgrade — a dozen cards share Beach_001 — so it is
  // texture here and nothing more, which is why it is one style among three
  // rather than the default.
  const artKey = def?.cardArt;
  if (artKey && LEVELUP_IMAGES[artKey]) {
    face.style.setProperty('--sv-hive-art', `url(${LEVELUP_IMAGES[artKey].src})`);
  }
  el.appendChild(face);
  el.appendChild(markFor(entry.id, def));

  // Stacks as a number, not as pips. Pips were the first try and they cost the
  // face: nine Shrimp Rings is nine marks around a 56px tile, which is more
  // pixels than the icon they surround.
  if (entry.count > 1) {
    const pip = document.createElement('div');
    pip.className = 'sv-hive-pip';
    pip.textContent = entry.count;
    el.appendChild(pip);
  }

  el.title = `${def?.name ?? entry.id}${entry.count > 1 ? ` x${entry.count}` : ''}`;
  return el;
}

function rebuild(held) {
  const host = state.host;
  if (!host) return;
  host.textContent = '';
  state.tiles.clear();

  const c = cfg();
  // `size` is the size of the HEXAGON, which is the thing anyone looking at the
  // corner is judging. The square box that carries it is larger, by exactly the
  // margin the art is drawn with.
  const hexW = c.size ?? 52;
  const hexH = hexW * (ART.h / ART.w);
  const box = hexW / ART.w;
  const gap = c.gap ?? 2;
  const pos = hexPositions(held.length, c.layout ?? 'cluster', hexW, hexH, gap);

  // The tiles are placed absolutely, so the host has no size of its own — it is
  // measured here and stamped, or the corner block it lives in collapses and the
  // score panel slides over the hive.
  //
  // Measured on the HEXAGONS and then grown by the box margin, so the host is
  // the size of what you can see plus the transparent surround the boxes need —
  // not the size of a lattice of squares, which would leave a margin of nothing
  // between the hive and the edge of the screen on every side.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pos) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }

  held.forEach((entry, i) => {
    const el = buildTile(entry);
    el.style.width = `${box}px`;
    el.style.height = `${box}px`;
    // The box hung around the hexagon's centre: its own centre sits at
    // (ART.cx, ART.cy) of itself, so that is what has to land on the lattice.
    el.style.left = `${pos[i].x - minX + hexW / 2 - box * ART.cx}px`;
    el.style.top = `${pos[i].y - minY + hexH / 2 - box * ART.cy}px`;
    host.appendChild(el);
    state.tiles.set(entry.id, el);
  });

  host.style.width = `${maxX - minX + hexW}px`;
  host.style.height = `${maxY - minY + hexH}px`;
}

/** Rebuild from the player's pick list. Cheap to call every level-up. */
export function setHiveUpgrades(picks) {
  if (!state.host) return;
  // Kept BEFORE the early return, so a layout change mid-run has something to
  // rebuild from even when the held set has not moved since the last call —
  // which is the usual case, since cycling layouts is something you do while
  // standing still looking at the corner.
  state.lastPicks = picks ?? [];
  const held = foldUpgrades(state.lastPicks);
  const sig = signature(held);
  if (sig === state.held) return;
  state.held = sig;
  rebuild(held);
}

/** Flash the tile for one upgrade. Safe to call for an upgrade not held. */
export function pulseHive(id) {
  const el = state.tiles.get(id);
  if (!el) return;
  // Restarting a running CSS animation needs the class OFF, a reflow, and the
  // class back on — without the forced reflow the browser coalesces the two
  // writes and the animation simply continues, so a second shot inside the
  // first flash produces no second flash. Reading offsetWidth is the reflow.
  el.classList.remove('sv-hive-firing');
  void el.offsetWidth;
  el.classList.add('sv-hive-firing');
}

export function setHiveLayout(layout) {
  CONFIG.upgradeHive.layout = layout;
  state.held = '';                 // force the next set call to lay out again
  if (state.lastPicks) setHiveUpgrades(state.lastPicks);
}

export function setHiveStyle(style) {
  CONFIG.upgradeHive.style = style;
  if (state.root) state.root.dataset.style = style;
}

export function toggleHive(on) {
  CONFIG.upgradeHive.enabled = on ?? !CONFIG.upgradeHive.enabled;
  if (state.root) state.root.classList.toggle('sv-hidden', !CONFIG.upgradeHive.enabled);
  return CONFIG.upgradeHive.enabled;
}

export function initUpgradeHive(mount) {
  if (state.root) return;
  const c = cfg();
  const root = document.createElement('div');
  root.className = 'sv-hive';
  root.dataset.style = c.style ?? 'ink';
  root.dataset.corner = c.corner ?? 'bl';
  if (!c.enabled) root.classList.add('sv-hidden');
  const host = document.createElement('div');
  host.className = 'sv-hive-host';
  root.appendChild(host);
  mount.appendChild(root);
  state.root = root;
  state.host = host;

  // One listener for every ability in the game — see onFeedback. An event with
  // no upgrade behind it is the common case and costs a map miss.
  state.off = onFeedback((event) => {
    const id = EVENT_UPGRADE[event];
    if (id) pulseHive(id);
  });
}

/** Kept so a restart can drop the tiles without tearing the mount down. */
export function clearHive() {
  state.held = '';
  state.lastPicks = null;
  if (state.host) state.host.textContent = '';
  state.tiles.clear();
}
