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
// nine abilities a second costs at most nine class writes, not nine layouts (and
// fewer than nine, because PULSE_MIN_GAP drops a tile's repeats inside its own
// animation). The one thing that would undo that is reading any layout property
// here; nothing does.
import { CONFIG } from '../config.js';
import { UPGRADE_ICONS } from './upgradeIcons.js';
import { LEVELUP_IMAGES } from './levelUpImages.js';
import { onFeedback } from '../systems/feedback.js';
import { narrowScreen, shortScreen } from '../devices.js';
import { cssEase } from '../ease.js';
import { pressableWithin } from './press.js';

// Which upgrade a feedback event belongs to.
//
// Read off the systems that fire them — see the event list in CONFIG.feedback.
// Several abilities own more than one event and all of them pulse the same
// tile: a beluga bubble trapping something and that bubble later popping are
// both the beluga doing its job.
//
// AN ENTRY IS ONE OF THREE SHAPES, and the shape is the question being asked:
//
//   'id'                   this event is that upgrade, always
//   ['a', 'b']             one event, several cards — the volley below
//   { source: { ... } }    the event is shared by two weapons and only the
//                          payload's `source` says which one fired it
//
// EVENTS NOT LISTED HERE ARE IGNORED, which is still most of them. `kill` and
// the hit events fire constantly and belong to no card in particular; wiring
// them to the tiles that scale them would leave a third of the hive strobing,
// and a signal that is always on is not a signal. What makes the busy events
// that ARE wired here safe is PULSE_MIN_GAP below — nothing in this table may
// out-run its own animation.
// Exported for the audit in tools/hive-test.mjs, which checks both halves of
// every entry against the live CONFIG — nothing else reads it.

// THE PEBBLE VOLLEY. Every card here changes what leaves the muzzle, so the
// shot you are watching IS each of them doing its job — which is the whole
// claim the pulse makes, and the reason the list stops where it does.
//
// Deliberately NOT here: Iron Lung, Clone Warz, Glow Up! and Maneater. They
// ride the pebble too, but they ride every other weapon as well, so a flash
// tied to the gun would be telling only a fraction of the truth about them —
// and the last two already pulse on procs of their own. `overboost` and
// `pierce` are disabled cards (see upgrades.csv); they are listed so the wiring
// is already right on the day they are switched back on, and pulseHive is a
// no-op for a tile that isn't held.
const PEBBLE_VOLLEY = [
  'rapidFire',      // the cadence you are hearing
  'heavyRounds',    // what each pellet carries
  'flippersUp',     // and how big it is coming off each fin
  'multishot',      // how many left the fins
  'velocity',       // how fast they crossed
  'homingShot',     // and whether they turned on the way
  'overboost',
  'projectileLife',   // and how long they stayed out there
];

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
  // THE LAUNCH ONLY. `scallopJet` is every live shell's own bubble pulse, on
  // `scallop.pulseInterval` each — so a dozen shells in the water fired it
  // dozens of times a second and the tile never went dark. What the card
  // promises is shells GOING OUT, and that happens once a flight.
  scallopLaunch: 'scallopSquirter',
  pearlShot: 'oysterBlaster', pearlBurst: 'oysterBlaster',
  calamariPulse: 'calamari',
  garlicTick: 'seaGarlic',
  missileLaunch: 'homingMissile', missileImpact: 'homingMissile',
  missileLaunchExtra: 'homingMissile',
  musselBarrage: 'musselVolley',
  maneaterProc: 'maneater',
  beamCut: 'laserEyes',
  strikeBurst: 'strikeShrapnel',
  strikeChain: 'strikePower',
  strikeRam: 'strikeDash',
  strikePip: 'strikeCharge',
  // ONE EVENT PER ELEMENT, AND ONE CARD PER ELEMENT — so each of these lights
  // exactly the tile that bought it. It used to be four events pointing at one
  // card; the split means `elementHitVenom` can only ever come from the venom
  // card, because holding one locks the other three out of the run.
  //
  // `elementArc` and `elementFreeze` are shock's and chill's own moments and
  // are listed with them. All four ids are here whatever the run holds:
  // pulseHive is a no-op for a tile that isn't in the corner.
  elementHitShock: 'biolumShock', elementArc: 'biolumShock',
  elementHitVenom: 'biolumVenom',
  elementHitChill: 'biolumChill', elementFreeze: 'biolumChill',
  elementHitInfection: 'biolumInfection',

  // --- shared events, split by who fired them -------------------------------
  // `shoot` is fired by the main gun AND by Starfish Shuriken, which is why
  // this cannot be a flat entry: without the split, a starfish would light the
  // whole pebble volley and the starfish's own tile would stay dark, which is
  // exactly what it did before. main.js tags both call sites.
  shoot: { source: { gun: PEBBLE_VOLLEY, starfish: 'starfish' } },
  // The fin laser's volley, routed to exactly the same tiles. A laser run is
  // still the gun — same cards, same damage source — so a separate entry that
  // lit anything different would be claiming the loadout changed which
  // upgrades are paying for the shot, which it does not. Split by source for
  // the same reason `shoot` is, so the row stays correct if anything else ever
  // fires it.
  shootLaser: { source: { gun: PEBBLE_VOLLEY } },
  // Same shape, same reason, and it was a live bug: the bounce callback in
  // entities/projectiles.js fires for ANY projectile with bounces left, and
  // scallops carry `bounce: true` — so Ricochet Rounds used to flash every
  // time somebody else's shell kissed a wall.
  bounce: { source: { ricochet: 'bounceShot', scallop: 'scallopSquirter' } },

  // --- the surface ----------------------------------------------------------
  // Porpoising rides the CHAIN EXTENDING, not the breach. A breach is not
  // always worth links — chainStrike() refuses inside
  // CONFIG.strike.chainOn.cooldowns.breach — so a tile popping on `breach`
  // would advertise a payout the run never got, on exactly the skimming the
  // cooldown exists to stop paying for. `foodChain` fires from the funnel every
  // link comes through and carries the source that bought it, so this branch is
  // the breach's links and nothing else's.
  foodChain: { source: { breach: 'breachChain' } },
  // Second Wind is the refill, so it pulses on the gasp, not on the crossing —
  // and the gasp is now one per surfacing rather than one per interval, so this
  // is a tile pulse per breath taken.
  breathIn: 'oxygenRefill',
  // Deep Lungs is pure capacity and has no moment of its own. The warning beep
  // is the nearest honest one: it is the bar being spent, which is the stat.
  oxygenWarn: 'oxygenMax',
  // C.H.U.M. is the reach that got you the orb, and `pickup` is that orb
  // landing. High-frequency and safe only because of the gap below — a magnet
  // sweep swallowing six inside a frame is one pulse, not six.
  pickup: 'magnet',
};

// THE FLOOR UNDER EVERY TILE, in milliseconds, and the thing that makes the
// busy events above wirable at all.
//
// The pulses are CSS animations 220-380ms long (see .sv-hive-firing in ui.js).
// The gun at base cadence is a shot every 360ms, which is fine — but Supa Dupa
// Seal stacks multiply that by 0.75 each and the air-time ramp takes another
// 45% off, so a real build fires about nine times a second. Restarted every
// 110ms a 220ms animation never reaches its own back half: the tile stops
// reading as a beat and just sits lit, which is the failure this whole table
// was written around.
//
// 250 is a shade over the shortest animation on purpose. Every pulse gets to
// finish, a fast weapon reads as a steady rhythm instead of a smear, and an
// ability slower than four times a second — which is nearly all of them — is
// never touched by this at all.
//
// PER TILE, not global: two abilities firing in the same frame are two
// different things happening and both should show. Only a tile out-running
// itself is throttled.
const PULSE_MIN_GAP = 250;

/**
 * The upgrades one feedback event should light, or null for the common case of
 * an event no card owns.
 *
 * @param {string} event  key in CONFIG.feedback
 * @param {object} at     the feedback payload — read for `source` only
 * @returns {string[]|null}
 */
export function upgradesForEvent(event, at) {
  const entry = EVENT_UPGRADE[event];
  if (!entry) return null;
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry;
  // A source-split event with no `source` on the payload lights NOTHING rather
  // than guessing at a branch. Silence is the recoverable failure here: the
  // wrong branch would credit one card for another card's work, and the audit
  // in tools/hive-test.mjs cannot see a lie, only a blank.
  const branch = entry.source?.[at?.source];
  if (!branch) return null;
  return typeof branch === 'string' ? [branch] : branch;
}

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
  scale: 1,           // what hiveScale gave the last build — see onResize
  tiles: new Map(),   // upgrade id -> tile element
  shims: new Map(),   // upgrade id -> the layers of its pile, shallowest first
  held: '',           // signature of the last built set, so rebuilds are rare
  lastPicks: null,    // what to re-lay-out from when the LAYOUT changes
  newestId: null,     // the tile the shift wave and the ripple radiate from
  lastPulse: new Map(), // upgrade id -> performance.now() of its last pulse
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

// --- STACKS AS HEIGHT -------------------------------------------------------
//
// A second Shrimp Ring is not a second tile — it is the same tile, taller. The
// hexagon keeps the cell the packing gave it and extra picks extrude it, so the
// depth of a build is a SHAPE in the corner rather than a 11px number on top of
// the icon that told you nothing at a glance.
//
// THE PILE CANNOT LIVE INSIDE THE TILE. Every tile is clip-path'd to its own
// hexagon, so a child drawn below the flat bottom edge is not dimmed or partly
// visible, it is simply not painted — the classic version of this bug ships a
// stack that renders nothing and throws nothing. Each layer is therefore its
// own absolutely-positioned box, a sibling of the tile, carrying the same clip.
//
// THE LAYERS ARE NOT EVENLY SPACED. `falloff` compresses each one against the
// one under it: a nine-stack at a flat step is 40px of pile beneath a 52px
// hexagon, at which point the corner reads as a bar chart rather than a hive.
// The compression means the first pick is the one you can see (the fact worth
// showing loudest), and the ninth still fits in the corner.
function stackCfg() {
  return cfg().stack ?? {};
}

// THE PILE IS PART OF THE TILE, SO IT SHRINKS WITH IT.
//
// Every number in `stack` is px — a 7px first layer, a 2.5px sideways drift —
// and px do not follow a hexagon that has been scaled down to fit a phone. Left
// alone, a corner at 0.6 keeps its full-height piles: a five-deep stack is 26px
// of tower under a 31px hexagon, which is the bar chart the falloff exists to
// prevent, and the shrink gives back barely half of what it promised.
//
// Handed the scaled copy instead, everything the packing measures is linear in
// `scale` — which is the property hiveScale below relies on to solve the fit in
// one division rather than by laying the hive out repeatedly.
//
// Returns the config untouched at 1, so the corner at full size and every
// snapshot are the exact objects they were before this existed.
function stackAt(scale, s = stackCfg()) {
  if (!(scale > 0) || scale === 1) return s;
  const shadow = s.shadow ?? {};
  return {
    ...s,
    step: (s.step ?? 7) * scale,
    skew: (s.skew ?? 2.5) * scale,
    shadow: { ...shadow, lift: (shadow.lift ?? 3) * scale },
  };
}

/** Distance below the top face of each drawn layer, shallowest first. */
export function stackOffsets(count, s = stackCfg()) {
  const mode = s.mode ?? 'slab';
  if (mode === 'pip') return [];
  const layers = Math.max(0, Math.min(Math.floor(count) - 1, s.maxLayers ?? 5));
  const falloff = s.falloff ?? 0.82;
  const out = [];
  let y = 0;
  let step = s.step ?? 5;
  for (let i = 0; i < layers; i++) { y += step; step *= falloff; out.push(y); }
  return out;
}

/** Total added height for a stack of `count`. Zero for a single pick. */
export function stackDepth(count, s = stackCfg()) {
  const o = stackOffsets(count, s);
  return o.length ? o[o.length - 1] : 0;
}

// The prism silhouette for `riser`, in px, for a box of `box` and a depth of
// `depth`: the drawn hexagon's own vertices, with the two side vertices and the
// bottom edge dropped by the depth. Written out rather than done with a scaled
// copy of the CSS polygon because a percentage clip on a taller box squashes
// the hexagon — the top face has to stay the exact shape the tile above it is.
function riserClip(box, depth) {
  const x = (f) => (f * box).toFixed(2);
  const y = (f) => (f * box).toFixed(2);
  const d = (f) => (f * box + depth).toFixed(2);
  return `polygon(${x(0.057)}px ${y(0.51)}px, ${x(0.271)}px ${y(0.127)}px, `
       + `${x(0.723)}px ${y(0.127)}px, ${x(0.939)}px ${y(0.51)}px, `
       + `${x(0.939)}px ${d(0.51)}px, ${x(0.723)}px ${d(0.896)}px, `
       + `${x(0.271)}px ${d(0.896)}px, ${x(0.057)}px ${d(0.51)}px)`;
}

// The rim's width, in px. The same 2px the tile's face is inset by (see
// .sv-hive-face) — the layers have to carry the tile's own stroke, or the pile
// under a stacked tile is a different object from the tile on top of it.
const INK = 2;

// The dark fill of one layer, inset inside its stroke. A separate element for
// the same reason the tile's face is one: an inset box-shadow paints the border
// BOX and the hexagonal clip then keeps only the parts of that rectangle that
// fall inside the shape, which leaves the four diagonal edges bare.
function shimFace(clip) {
  const face = document.createElement('div');
  face.className = 'sv-hive-shim-face';
  if (clip) {
    // The riser's face is its own prism, one rim narrower. Positioned by the
    // same inset so the two polygons share a centre.
    face.style.clipPath = clip;
    face.style.webkitClipPath = clip;
  }
  return face;
}

// The layers under one tile. Positioned in the host's coordinates, like the
// tiles themselves, so the FLIP can slide them with the tile they belong to.
function buildShims(entry, box, tileLeft, tileTop, s = stackCfg()) {
  const mode = s.mode ?? 'slab';
  const offsets = stackOffsets(entry.count, s);
  if (!offsets.length) return [];

  const tint = rarityColor(entry.rarity);
  const strokeMix = s.strokeMix ?? 100;
  // `riser` only — the light down the FILL of its extruded body. The stroke
  // around it is `strokeMix`, the same solid rim every plate gets: a ramp
  // belongs on the material, never on the outline.
  const topMix = s.topMix ?? 58;
  const baseMix = s.baseMix ?? 20;
  const out = [];

  // One body, not a stack of plates: the height IS the count, and there are no
  // seams to count. The loudest of the four at depth, and the only one that
  // still reads at a glance once the corner is full.
  if (mode === 'riser') {
    const depth = offsets[offsets.length - 1];
    const el = document.createElement('div');
    el.className = 'sv-hive-shim';
    el.dataset.upgrade = entry.id;
    el.dataset.mode = 'riser';
    el.style.left = `${tileLeft}px`;
    el.style.top = `${tileTop}px`;
    el.style.width = `${box}px`;
    el.style.height = `${box + depth}px`;
    el.style.clipPath = riserClip(box, depth);
    el.style.webkitClipPath = el.style.clipPath;
    el.style.setProperty('--sv-hive-rarity', tint);
    el.style.setProperty('--sv-shim-mix', `${strokeMix}%`);
    el.style.setProperty('--sv-shim-top', `${topMix}%`);
    el.style.setProperty('--sv-shim-base', `${baseMix}%`);
    // The body carries the stroke the same way the tile does — the outline is
    // the element's own background and the fill is a smaller copy inset on top
    // of it. A prism drawn as one flat colour has no edge where it meets the
    // water and the tower stops having a silhouette.
    el.appendChild(shimFace(riserClip(box - INK * 2, depth)));
    return [el];
  }

  // slab / deck: one hexagon per pick, each showing only the sliver of itself
  // the tile above does not cover. Darkening with depth is the occlusion that
  // stops the pile reading as a mis-registered copy of the tile.
  offsets.forEach((dy, i) => {
    const el = document.createElement('div');
    el.className = 'sv-hive-shim';
    el.dataset.upgrade = entry.id;
    el.dataset.mode = mode;
    el.style.left = `${tileLeft + (mode === 'deck' ? (s.skew ?? 2.5) * (i + 1) : 0)}px`;
    el.style.top = `${tileTop + dy}px`;
    el.style.width = `${box}px`;
    el.style.height = `${box}px`;
    el.style.setProperty('--sv-hive-rarity', tint);
    // EVERY PLATE IS A WHOLE HEXAGON, STROKE AND ALL, AND EVERY STROKE IS THE
    // SAME. Flat silhouettes give one dark wedge: you can see that the tile is
    // taller and not how many picks made it so. A stroke that FADES with depth
    // is that same failure arriving slowly — the bottom of a deep pile loses
    // its outline exactly where the seams are thickest on the ground. So each
    // layer is built the way the tile is, at the tile's own rim strength, and
    // the few px of it that show read as an EDGE.
    el.style.setProperty('--sv-shim-mix', `${strokeMix}%`);
    el.appendChild(shimFace());
    out.push(el);
  });
  return out;
}

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
// THE FOUR ELEMENTS SHARE ONE MARK, for now.
//
// upgradeIcons.js is generated (see its header) and carries one entry under the
// old single-card id. The card became four when the element stopped being
// rolled, and rather than hand-editing a generated file — where the next bake
// would drop it — the four ids point at the one render here.
//
// FOUR MARKS IS THE RIGHT ANSWER and this is not it: shock, venom, chill and
// infection are four different abilities and a player reading the corner should
// be able to tell which one they are carrying. One icon in four tiles is a
// placeholder until they are drawn.
// A NEW UPGRADE ID BORROWING AN OLDER ICON, until its own is baked.
//
// EMPTY, and that is the finished state rather than a stub. It was filled the
// day Glow Up! split into four cards: the four new ids had no renders, so they
// all pointed at the single `bioluminescence` icon to keep four monograms off
// the corner until the bake caught up. The bake has caught up — every element
// carries its own render now, and `bioluminescence` is not a key in
// UPGRADE_ICONS any more — so every one of those four entries pointed at an
// icon that no longer exists.
//
// Inert rather than broken, because the lookup below tries the real key first
// and never reached the alias. tools/hive-test.mjs catches it anyway, which is
// the point of auditing both directions: an alias aimed at nothing is a
// monogram waiting for the next id that needs one.
//
// Kept as the mechanism, not deleted, because the next rename wants it and the
// audit already guards both ends.
export const ICON_ALIAS = {};

function markFor(id, def) {
  const src = UPGRADE_ICONS[id] ?? UPGRADE_ICONS[ICON_ALIAS[id]];
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
  // HOW MANY OF IT, ON THE TILE. Every surface that hovers a hexagon needs the
  // stack count to build its tip (ui/upgradeTip.js), and the tile is the only
  // place all of them can read it from without a second source.
  //
  // NOT the playtest ledger, which is the obvious alternative and is wrong on
  // the one screen that matters most: `finalStacks` is written by endRun, so on
  // the score screen it is right, and on the DEMO score screen — and anywhere
  // else a hive is shown for a build the recorder never saw — it is an empty
  // object, which reads back as zero stacks and silently drops half the tip.
  // The tile was built from the fold, so it already knows.
  el.dataset.stacks = String(entry.count);
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

  // The number, ON TOP OF the pile — the pile is the thing you read across the
  // room and the digit is what you check when you care about the exact count.
  // (Pips were the first try and they cost the face: nine Shrimp Rings is nine
  // marks around a 56px tile, more pixels than the icon they surround.)
  // `stack.pipFrom` is how deep a stack has to be before the digit is worth the
  // clutter; at 99 the pile carries it alone.
  if (entry.count >= Math.max(2, stackCfg().pipFrom ?? 2)) {
    const pip = document.createElement('div');
    pip.className = 'sv-hive-pip';
    pip.textContent = entry.count;
    el.appendChild(pip);
  }

  el.title = `${def?.name ?? entry.id}${entry.count > 1 ? ` x${entry.count}` : ''}`;
  return el;
}

// THE SHADE A TOWER CASTS ON THE HEXES IT COVERS.
//
// A tile that has grown out of its cell stands in front of the one behind it,
// and with nothing between them the two silhouettes meet as a hard seam of
// identical ink — the tower reads as CLIPPING its neighbour rather than as
// standing in front of it. This is the contact shadow that separates them, and
// it is deliberately almost invisible: the moment you can see it as a shape,
// the corner has a smudge in it.
//
// It is only drawn when the tile actually covers something. A tower on the top
// row overlaps nothing and gets nothing — a shadow under it would be a shadow
// cast on the water.
//
// NO BLUR FILTER. `filter` is applied BEFORE `clip-path`, so a blurred box that
// is also clipped comes back with a hard hexagonal edge — a soft shadow with a
// cut-out shape in it. The softness is a radial gradient instead, which needs
// no clip and no filter and costs nothing to composite.
function buildShade(place, i, box, hexW, hexH, s = stackCfg()) {
  const cfgShade = s.shadow ?? {};
  const me = place[i];
  if (cfgShade.enabled === false || !me.depth) return null;

  // Does this tile, as risen, cover any tile behind it? Measured on the drawn
  // HEXAGONS, not the boxes — neighbouring boxes overlap heavily by design (see
  // the note on ART), so a box test says yes for every tile in the hive.
  const hx = (p) => p.left + box * ART.left;
  const hy = (p) => p.top + box * ART.top;
  const covers = place.some((other, j) => j !== i
    && other.top < me.top - 0.5                                  // behind: higher up
    && hx(me) < hx(other) + hexW && hx(other) < hx(me) + hexW
    && hy(me) < hy(other) + hexH && hy(other) < hy(me) + hexH);
  if (!covers) return null;

  const spread = cfgShade.spread ?? 1.34;
  // Deeper towers cast more, because they cover more. Full strength is reached
  // at a stack a few picks deep rather than at the cap, or every shadow in a
  // real build is a fraction of one and none of them do anything.
  const strength = Math.min(1, me.depth / ((s.step ?? 7) * 2.2));
  const alpha = (cfgShade.alpha ?? 0.5) * strength;

  const el = document.createElement('div');
  el.className = 'sv-hive-shade';
  el.style.width = `${box * spread}px`;
  el.style.height = `${box * spread}px`;
  el.style.left = `${me.left - box * (spread - 1) / 2}px`;
  el.style.top = `${me.top - box * (spread - 1) / 2 - (cfgShade.lift ?? 3)}px`;
  el.style.setProperty('--sv-shade-alpha', alpha.toFixed(3));
  return el;
}

// THE LATTICE AS NUMBERS, WITH NOTHING BUILT.
//
// Pulled out of layoutHive so hiveScale below can ask how big a set WOULD come
// out at a given size without touching the DOM. The alternative is building the
// hive, measuring it and shrinking it afterwards, which is a second layout pass
// on every pick and, worse, a visible pop: the corner would appear at full size
// for one frame and then collapse.
//
// EVERYTHING HERE IS LINEAR IN `hexW`. `gap` and `stack` arrive already scaled
// (see stackAt), so doubling the hexagon doubles the box exactly — which is why
// the fit can be solved with one division instead of a search. A px constant
// sneaking in here — a fixed gap, an unscaled step — is what would quietly
// break that, and the way it breaks is a hive that stops just short of fitting.
function packMetrics(held, hexW, gap, stack) {
  const hexH = hexW * (ART.h / ART.w);
  const box = hexW / ART.w;
  const pos = hexPositions(held.length, cfg().layout ?? 'cluster', hexW, hexH, gap);

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

  // THE PILES ARE MEASURED BEFORE ANYTHING IS PLACED, because they change the
  // size of the corner. With `rise` the tallest stack lifts its tile clear of
  // the lattice, so the host needs that much more room ABOVE its top row — and
  // a host measured on the hexagons alone would leave the raised tile hanging
  // outside the box the HUD lays out against, which on a bottom corner walks it
  // under the score panel.
  const rise = stack.rise !== false && (stack.mode ?? 'slab') !== 'pip';
  const depths = held.map((e) => stackDepth(e.count, stack));
  const maxDepth = depths.length ? Math.max(...depths) : 0;
  const pad = rise ? maxDepth : 0;          // headroom the risen tiles need
  const skewMax = (stack.mode === 'deck')
    ? (stack.skew ?? 2.5) * Math.max(0, ...held.map((e) => stackOffsets(e.count, stack).length))
    : 0;

  // An empty hive is 0x0 and not NaN: with no tiles the bounds above are still
  // Infinity, and `NaNpx` on the host is a declaration the browser drops — so
  // the box keeps whatever size the last build gave it, which is a corner full
  // of nothing between two runs.
  const width = held.length ? maxX - minX + hexW + skewMax : 0;
  const height = held.length ? maxY - minY + hexH + maxDepth : 0;
  return { pos, hexW, hexH, box, minX, minY, rise, depths, maxDepth, pad, skewMax, width, height };
}

// The corner's own inset from the edge of the screen, in px — the `14px` in
// .sv-hive[data-corner] (see ui.js). Counted once for the margin the hive sits
// on and once for a margin of the same size on the far side, so "half the
// screen" means half the screen with the hive breathing on both sides of it
// rather than half the screen plus 14px.
const EDGE = 14;

// HOW BIG THE CORNER IS ALLOWED TO BE, as a multiplier on CONFIG's `size`.
//
// TWO QUESTIONS, ONE NUMBER. `size` is a desktop measurement, so a narrow
// screen starts from `mobile.scale` of it — that part is flat, and it is the
// answer to "these hexagons are too big on a phone". The rest is the answer to
// "and the hive keeps growing": the lattice stays roughly square as it fills,
// so every ring costs the corner about a tile in each direction, and past the
// `maxW`/`maxH` fractions of the viewport the whole thing is scaled to fit.
//
// IT ONLY EVER SHRINKS. The fractions are a ceiling and never a target, so a
// build of four tiles is exactly the size CONFIG says on any screen — the
// clamp is `min(1, …)` for that reason, and a scale above the start would
// otherwise make the hive GROW into a big screen, which is not what anybody
// asked for and would move the corner every time the window changed.
//
// `minSize` is the floor. A hexagon that always fits is a hexagon nobody can
// read, and past a point the honest answer is that the corner is full — the
// hive is allowed to sit slightly over its ceiling rather than turn to grit.
//
// Cheap: arithmetic and two window properties, on rebuild only (a pick, or a
// resize that actually moves the number). Nothing here reads a layout property
// off an element, which is the promise at the head of this file.
function hiveScale(held) {
  const c = cfg();
  const f = c.fit ?? {};
  const narrow = narrowScreen() || shortScreen();
  const mob = f.mobile ?? {};
  const start = narrow ? (mob.scale ?? 0.6) : 1;
  if (f.enabled === false || !held.length || typeof window === 'undefined') return start;

  const base = c.size ?? 52;
  const roomW = (window.innerWidth || 0) * ((narrow ? mob.maxW : f.maxW) ?? 0.5) - EDGE * 2;
  const roomH = (window.innerHeight || 0) * ((narrow ? mob.maxH : f.maxH) ?? 0.5) - EDGE * 2;
  if (!(roomW > 0) || !(roomH > 0)) return start;

  const nat = packMetrics(held, base * start, (c.gap ?? 2) * start, stackAt(start));
  const k = Math.min(1,
    nat.width > 0 ? roomW / nat.width : 1,
    nat.height > 0 ? roomH / nat.height : 1);
  // The floor cannot RAISE the scale past where the screen started it: on a
  // phone `minSize / base` is larger than `mobile.scale`, so a bare
  // Math.max(scale, floor) would undo the whole shrink at the first pick.
  return Math.max(start * k, Math.min(start, (f.minSize ?? 18) / base));
}

// THE PACKING, WRITTEN ONCE AND POINTED AT A HOST.
//
// Pulled out of rebuild() when the score screen grew a hive of its own. The
// alternative — a second implementation that lays hexagons out at snapshot size
// — is the exact failure the note above hiveTileRect warns about, one level up:
// two packings that have to agree forever, with the drift showing as a hive
// that interlocks in the corner and overlaps on the card, or the other way
// round, depending which one was retuned.
//
// So there is one lattice, and a snapshot is the corner at a different `size`
// with the FLIP left off (there is nothing for a freshly built hive to slide
// from) and the tile map handed back rather than stored.
//
// TWO WAYS TO ASK FOR A SMALLER HIVE, and they are not the same question.
// `size` names the hexagon outright, which is what a snapshot does — it knows
// the box it has to fill. `scale` is the corner's answer to the screen it woke
// up on (see hiveScale) and multiplies the hexagon, the gap and the pile
// together, so the hive that comes out is the same drawing at another size
// rather than a differently-proportioned one.
//
// Returns { tiles, shims } — Maps of upgrade id to element, the same shape
// state holds. `host` is emptied first, and is stamped with the size the tiles
// need: they are absolutely positioned, so a host left at auto is a zero-height
// box with the whole hive hanging outside it.
function layoutHive(host, held, { size = null, scale = 1 } = {}) {
  const tiles = new Map();
  const shims = new Map();
  host.textContent = '';

  const c = cfg();
  // THE STYLE HOOK, ON THE HOST. The three looks are CSS descendant rules and
  // they have to attach to something that exists in both cases — the corner's
  // host sits inside a .sv-hive root, and a snapshot's host sits inside nothing
  // at all. Keyed on the root, a snapshot would render as tiles with no face,
  // which reads as a loading failure rather than as a missing selector.
  host.dataset.style = c.style ?? 'ink';
  // `size` is the size of the HEXAGON, which is the thing anyone looking at the
  // corner is judging. The square box that carries it is larger, by exactly the
  // margin the art is drawn with.
  const stack = stackAt(scale);
  const m = packMetrics(held, (size ?? c.size ?? 52) * scale, (c.gap ?? 2) * scale, stack);
  const { pos, hexW, hexH, box, minX, minY, rise, depths, pad } = m;
  // AND ON THE HOST TOO, because two things inside a tile are typed rather than
  // drawn — the pip and the `mono` fallback face — and type is the one part of
  // a hexagon that does not follow a width. Left at 15px on a hexagon scaled to
  // fit a phone, the fallback glyph is most of the tile. See .sv-hive-mono.
  host.style.setProperty('--sv-hive-scale', scale.toFixed(3));

  // EVERY BOX IS PLACED BEFORE ANY IS BUILT, because a tower has to know what
  // it is standing in front of — see the shade below, which is a question about
  // pairs of tiles and cannot be answered one tile at a time.
  const place = held.map((entry, i) => {
    // The box hung around the hexagon's centre: its own centre sits at
    // (ART.cx, ART.cy) of itself, so that is what has to land on the lattice.
    const left = pos[i].x - minX + hexW / 2 - box * ART.cx;
    // The cell the packing gave this tile — where the BASE of the pile sits.
    // With `rise` the tile itself is that much higher and the layers fill the
    // gap down to it, so growing a stack never moves the footprint.
    const base = pos[i].y - minY + hexH / 2 - box * ART.cy + pad;
    return { entry, left, base, top: rise ? base - depths[i] : base, depth: depths[i] };
  });

  // BOTTOM ROW LAST. Once a tile can stand taller than its cell it overlaps the
  // one behind it, and which of the two wins has to be the near one — painting
  // in map order instead puts a far tile over the top of a near tile's pile at
  // random, which looks like the piles are interleaved rather than stacked.
  const order = held.map((_, i) => i).sort((a, b) => pos[a].y - pos[b].y);

  order.forEach((i) => {
    const p = place[i];
    const el = buildTile(p.entry);
    el.style.width = `${box}px`;
    el.style.height = `${box}px`;
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;

    // ONE OBJECT, IN PAINTER'S ORDER: the shade it casts, then its pile, then
    // the tile itself. Nothing here carries a z-index — see the note in ui.js.
    // The shade goes FIRST so it lands only on the cells already painted behind
    // it; between the pile and the tile it would shade its own stack, which
    // reads as the pile being made of dirtier material than the hexagon on top.
    const shade = buildShade(place, i, box, hexW, hexH, stack);
    if (shade) host.appendChild(shade);
    const pile = buildShims(p.entry, box, p.left, p.top, stack);
    for (const shim of pile) host.appendChild(shim);
    host.appendChild(el);
    tiles.set(p.entry.id, el);
    if (pile.length) shims.set(p.entry.id, pile);
  });

  host.style.width = `${m.width}px`;
  host.style.height = `${m.height}px`;

  return { tiles, shims };
}

function rebuild(held) {
  const host = state.host;
  if (!host) return;

  // WHERE EVERY TILE WAS, before the new packing throws it away.
  //
  // A cluster relayouts on almost every pick — one more hexagon changes the
  // ring, and half the corner moves a few pixels. Rebuilt cold, that is a jump
  // cut: the hive is simply arranged differently on the next frame, and the eye
  // reads it as the whole readout flickering rather than as one tile joining.
  // Captured here, replayed as a slide in flipTiles() below.
  const before = new Map();
  for (const [id, el] of state.tiles) {
    before.set(id, { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 });
  }

  // FILLED, NOT REPLACED. hiveParts() hands hiveReward.js `state.tiles` itself
  // and the ceremony rebuilds under its feet on every stack taken — the note
  // there calls it a live view on purpose. Swapping the Map for a new one would
  // keep every re-read correct and quietly break any reference held across a
  // rebuild, which is the one thing that contract promises.
  state.tiles.clear();
  state.shims.clear();
  // THE SIZE IS DECIDED HERE, ON EVERY REBUILD, and not once at boot: the hive
  // grows all run and the screen can turn over halfway through one. Stashed
  // because the resize hook below has to know whether the number actually moved
  // before it throws the corner away and lays it out again.
  state.scale = hiveScale(held);
  const built = layoutHive(host, held, { scale: state.scale });
  for (const [id, tile] of built.tiles) state.tiles.set(id, tile);
  for (const [id, pile] of built.shims) state.shims.set(id, pile);

  flipTiles(before);
}

/**
 * A HIVE THAT IS NOT THE CORNER — one detached element holding the whole build,
 * at whatever size the caller has room for.
 *
 * WHAT IT IS FOR: the score screen, where it sits to the right of the last kill
 * shot as the run's other object, and the sheet that opens when it is tapped.
 * Both want the same lattice the player has been reading all run, and neither
 * may disturb the live corner — so this shares the packing (see layoutHive) and
 * shares nothing else. No FLIP, no pulses, no entry in `state`, and the corner
 * keeps its own tiles whether this is built once or five times.
 *
 * `picks` is the flat pick list, one entry per level-up, exactly as
 * setHiveUpgrades takes it — folded here rather than by the caller so a
 * snapshot cannot disagree with the corner about how stacks collapse or which
 * tier a stack keeps.
 *
 * Returns null for an empty build. A caller must treat that as "there is
 * nothing to show", never as a reason to render an empty frame: an empty box
 * on the score screen reads as an image that failed to load.
 */
export function buildHiveSnapshot(picks, { size = 30 } = {}) {
  const held = foldUpgrades(picks ?? []);
  if (!held.length) return null;
  const host = document.createElement('div');
  host.className = 'sv-hive-host sv-hive-snap';
  // layoutHive stamps data-style on it, which is what carries the run's own
  // look onto a host with no .sv-hive root over it.
  const { tiles } = layoutHive(host, held, { size });
  return { host, tiles, held };
}

// Slide every tile that moved from where it used to be to where it now is.
//
// FLIP, and it has to be: the tiles were destroyed and rebuilt at their new
// coordinates, so there is nothing left to animate FROM. Each one is instead
// offset back to its old spot with a transform and then released — the browser
// animates the transform to identity, which looks like the tile travelling even
// though it was never anywhere else.
//
// TRANSFORM ONLY. `left`/`top` are already correct and are never touched here,
// so nothing in this relayout costs a second layout pass, and the pulse
// animations (which also use transform) take over cleanly once it settles.
//
// STAGGERED FROM THE NEWCOMER OUTWARD. A dozen tiles all starting together is a
// block of pixels sliding, which reads as the panel resizing; the same dozen
// starting a few milliseconds apart in order of distance reads as the new tile
// pushing its way in and the others giving way. That is the whole effect.
function flipTiles(before) {
  const cfg = CONFIG.upgradeHive?.shift ?? {};
  if (cfg.enabled === false || !before.size) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;

  const secs = cfg.seconds ?? 0.42;
  const stagger = cfg.stagger ?? 0.022;
  const curve = cssEase(cfg.ease ?? 'outBack');

  // Distance is measured from the tile that just arrived, so the wave starts
  // where the new hexagon lands. With nothing new (a layout cycled by hand) it
  // falls back to the first tile, which still reads as a wave rather than a
  // block.
  const originEl = state.tiles.get(state.newestId) ?? state.tiles.values().next().value;
  const ox = parseFloat(originEl?.style.left) || 0;
  const oy = parseFloat(originEl?.style.top) || 0;

  const moved = [];
  for (const [id, el] of state.tiles) {
    const old = before.get(id);
    if (!old) continue;                       // brand new: it has no old place
    const nx = parseFloat(el.style.left) || 0;
    const ny = parseFloat(el.style.top) || 0;
    const dx = old.left - nx;
    const dy = old.top - ny;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;   // it did not move
    moved.push({ id, el, dx, dy, dist: Math.hypot(nx - ox, ny - oy) });
  }
  if (!moved.length) return;

  moved.sort((a, b) => a.dist - b.dist);
  // A tile and its pile travel as one object. The layers are siblings rather
  // than children (they have to be — the tile's clip would eat them), so
  // nothing carries them along on its own: left out of the FLIP they stay put
  // while the hexagon above them slides off, which reads as the pile shearing.
  moved.forEach((m) => {
    for (const el of [m.el, ...(state.shims.get(m.id) ?? [])]) {
      el.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
    }
  });

  // One forced reflow for the whole batch, not one per tile: the offsets above
  // have to be committed before the transitions are armed, and doing that inside
  // the loop would lay the corner out once per tile.
  void host().offsetWidth;

  moved.forEach((m, i) => {
    const group = [m.el, ...(state.shims.get(m.id) ?? [])];
    for (const el of group) {
      el.style.transition = `transform ${secs}s ${curve} ${(i * stagger).toFixed(3)}s`;
      el.style.transform = '';
    }
    // The transition is cleared once it lands, so a pulse firing later is not
    // fighting a leftover transition on the same property — that is the bug
    // where a tile's flash slides instead of snapping.
    const clear = () => { for (const el of group) el.style.transition = ''; };
    m.el.addEventListener('transitionend', clear, { once: true });
    setTimeout(clear, Math.round((secs + i * stagger) * 1000) + 120);
  });
}

function host() { return state.host; }

/** Rebuild from the player's pick list. Cheap to call every level-up. */
export function setHiveUpgrades(picks) {
  if (!state.host) return;
  // Which id is new SINCE THE LAST CALL — the wave radiates from it, and the
  // slam belongs to it. Worked out before the rebuild, because after it every
  // tile is equally new.
  const had = new Set(state.tiles.keys());
  const arriving = (picks ?? []).map((p) => p.id).find((id) => !had.has(id));
  state.newestId = arriving ?? null;
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

// WHERE A TILE ACTUALLY IS, so the card can be flown to it.
//
// MEASURED, never predicted. The alternative is recomputing the lattice from
// CONFIG a second time in the caller — which means two implementations of the
// packing that have to agree forever, and the failure is a card that lands next
// to its tile instead of on it. Reading the box back off the element is one
// source of truth and it is correct by construction, including while the corner
// is mid-relayout because a stack just changed the count.
//
// Returns null when there is no tile: the hive is switched off, or the pick
// somehow isn't held. Callers treat that as "no flight".
export function hiveTileRect(id) {
  const el = state.tiles.get(id);
  if (!el || !state.root || state.root.classList.contains('sv-hidden')) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/**
 * The whole corner as one rectangle, or null when there is nothing in it.
 *
 * WHAT IT IS FOR: the first-run tip that points the hive out (`hiveStack` in
 * systems/tutorial.js) stands beside the block rather than beside any one
 * hexagon. Which tile is "the" tile changes on every pick, and a label that
 * hopped from one hexagon to another as the corner filled would be describing
 * the newest upgrade instead of the readout.
 *
 * The HOST and not the root: the root is a fixed-position wrapper with no size
 * of its own, and the host is the box upgradeHive stamps to fit the tiles (see
 * rebuild). A hidden hive answers null, which is what stops a tip being offered
 * about a readout that is switched off.
 */
export function hiveRect() {
  if (!state.host || !state.root || state.root.classList.contains('sv-hidden')) return null;
  const r = state.host.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/**
 * Hide a tile while something else stands in for it.
 *
 * `visibility`, not `display`: the tile has to keep its box so the corner does
 * not reflow the moment a flight starts and re-land every other tile a few
 * pixels over — which would make the destination this returns stale before the
 * card got there.
 */
export function setTileVisible(id, on) {
  const el = state.tiles.get(id);
  if (el) el.style.visibility = on ? '' : 'hidden';
}

/**
 * The transform that carries one square box exactly onto another.
 *
 * Pulled out as a function of two rectangles so it can be checked with real
 * numbers instead of eyeballed: in jsdom every element measures zero, so a test
 * that drove the DOM could only ever confirm that nothing moved.
 *
 * WITH transform-origin AT 0 0 this is exact rather than approximate. The scale
 * pins the top-left corner and grows the box from there, so translating that one
 * corner onto the destination's corner and scaling by the size ratio puts every
 * other point where it belongs — and because a card and a tile are both SQUARE
 * and clipped on the same hexagon vertices, the two hexagons coincide too. With
 * a centred origin the scale pulls the box back toward its own middle and the
 * landing misses by half the difference in size, which looks like a near miss
 * rather than like a bug.
 */
export function flyTransform(from, to) {
  const scale = to.width / from.width;
  return {
    scale,
    dx: to.left - from.left,
    dy: to.top - from.top,
    css: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale})`,
  };
}

/**
 * Flash the tile for one upgrade. Safe to call for an upgrade not held.
 *
 * Rate-limited per tile to PULSE_MIN_GAP — see the note there for why a gun
 * firing nine times a second must not write nine class changes. Pass
 * `force` for a pulse that is not the ability going off and must never be
 * dropped: the level-up slam is one moment, not a stream, and reduced-motion
 * routes its arrival through here.
 */
export function pulseHive(id, force = false) {
  const el = state.tiles.get(id);
  if (!el) return;
  if (!force) {
    // performance.now() rather than a frame counter: this is a duration in
    // milliseconds against a CSS animation measured in milliseconds, and it
    // must not stretch with hitstop or the dilated clock a strike runs on.
    const now = performance.now();
    if (now - (state.lastPulse.get(id) ?? -Infinity) < PULSE_MIN_GAP) return;
    state.lastPulse.set(id, now);
  }
  // Restarting a running CSS animation needs the class OFF, a reflow, and the
  // class back on — without the forced reflow the browser coalesces the two
  // writes and the animation simply continues, so a second shot inside the
  // first flash produces no second flash. Reading offsetWidth is the reflow.
  // Still needed WITH the gap above: the gap is shorter than the swell and the
  // lean, so those two legitimately restart mid-animation.
  el.classList.remove('sv-hive-firing');
  void el.offsetWidth;
  el.classList.add('sv-hive-firing');
}

/**
 * The new tile hits, and the corner feels it.
 *
 * Two beats, in order, because they mean different things: the SLAM is the tile
 * arriving under its own weight, and the RIPPLE is the rest of the hive
 * registering it. Fired together they read as the whole panel flashing, which
 * says nothing about which upgrade was just taken — the sequence is the message.
 *
 * The ripple is ordered by distance from the newcomer, not by index, so it
 * spreads outward as a wave rather than sweeping in whatever order the tiles
 * happen to sit in the map.
 */
export function slamAndRipple(id) {
  const el = state.tiles.get(id);
  if (!el) return;
  const cfg = CONFIG.upgradeHive?.ripple ?? {};
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    pulseHive(id, true);
    return;
  }

  el.classList.remove('sv-hive-arriving');
  void el.offsetWidth;                     // restart it if one is already running
  el.classList.add('sv-hive-arriving');
  el.addEventListener('animationend', () => el.classList.remove('sv-hive-arriving'), { once: true });

  if (cfg.enabled === false) return;

  const ox = parseFloat(el.style.left) || 0;
  const oy = parseFloat(el.style.top) || 0;
  // ms per pixel of distance — how fast the wave crosses the corner. Slower
  // than it sounds: a 250px hive at 0.9 takes about a fifth of a second to
  // cross, which is the difference between a wave and everything at once.
  const perPx = cfg.msPerPx ?? 0.9;
  const delay = cfg.delay ?? 90;           // after the slam starts, not with it

  const others = [];
  for (const [otherId, other] of state.tiles) {
    if (otherId === id) continue;
    const d = Math.hypot((parseFloat(other.style.left) || 0) - ox,
                         (parseFloat(other.style.top) || 0) - oy);
    others.push({ other, d });
  }
  for (const { other, d } of others) {
    setTimeout(() => {
      other.classList.remove('sv-hive-rippling');
      void other.offsetWidth;
      other.classList.add('sv-hive-rippling');
      other.addEventListener('animationend',
        () => other.classList.remove('sv-hive-rippling'), { once: true });
    }, delay + d * perPx);
  }
}

export function setHiveLayout(layout) {
  CONFIG.upgradeHive.layout = layout;
  state.held = '';                 // force the next set call to lay out again
  if (state.lastPicks) setHiveUpgrades(state.lastPicks);
}

export function setHiveStyle(style) {
  CONFIG.upgradeHive.style = style;
  // BOTH, and the host is the one the CSS reads. The root keeps the attribute
  // because it is what anything asking "what does the hive look like" inspects
  // from outside; the host carries it because that is where the style rules
  // hang (see layoutHive). Written here as well as there so cycling the style
  // from the tuner does not need a relayout to take effect.
  if (state.root) state.root.dataset.style = style;
  if (state.host) state.host.dataset.style = style;
}

// --- TIPS ON THE CORNER, WHILE THE RUN IS STOPPED --------------------------
//
// Hovering a corner tile mid-fight is not a gesture anybody makes on purpose.
// The mouse IS the aim in this game, and the hive sits in a bottom corner — so
// on a desktop run the pointer crosses these hexagons every time the seal
// shoots down and to the side, which with a tip bound to hover means a box
// opening over the fight several times a minute. A dwell delay would fix the
// flicker and not the underlying thing: the player never asked.
//
// So the corner answers questions only when the game is stopped and the player
// is looking rather than playing. main.js calls this from setPaused, which is
// the flag the whole frame loop is already written around.
//
// TWO THINGS HAVE TO CHANGE, AND MISSING EITHER IS A SILENT NO-OP:
//
//   POINTER EVENTS  .sv-hive is pointer-events: none at rest, so nothing in it
//                   can be hovered at all.
//   THE STACK       the pause menu lives in a .sv-center, which is a
//                   full-screen box at z-index 8 with pointer-events: all. It
//                   covers the corner completely. A hive that opted back into
//                   the pointer without also clearing that would receive
//                   nothing, and would look exactly like a wiring bug.
//
// Both live on one attribute — see .sv-hive[data-tips="on"] in ui.js, which is
// the same trick the reward ceremony uses one line above it.
//
// THE LISTENERS ARE ADDED AND REMOVED rather than added once and gated by a
// flag. The gated version costs a delegated pointerover on the HUD for every
// frame of every fight, which is precisely the per-frame work the head of this
// file says the hive does not do.
let tipHandlers = null;

export function setHiveTips(on, { onShow, onHide } = {}) {
  if (!state.root) return false;
  const want = !!on && !!CONFIG.upgradeHive?.enabled;
  if (want === !!tipHandlers) return want;

  if (!want) {
    state.host?.removeEventListener('pointerover', tipHandlers.over);
    state.host?.removeEventListener('pointerout', tipHandlers.out);
    tipHandlers.unpress?.();
    tipHandlers = null;
    state.root.removeAttribute('data-tips');
    onHide?.();
    return false;
  }

  // Delegated on the host, so a rebuild mid-pause (the tuner cycling a layout
  // while the game is stopped is a real thing somebody does) does not strand a
  // listener on a tile that no longer exists.
  const over = (e) => {
    const tile = e.target.closest?.('.sv-hive-tile');
    if (!tile) return;
    onShow?.(tile.dataset.upgrade, tile);
  };
  const out = (e) => {
    // relatedTarget inside the same tile is the pointer crossing from the face
    // to the icon, which is not leaving anything.
    const tile = e.target.closest?.('.sv-hive-tile');
    if (tile && tile.contains(e.relatedTarget)) return;
    onHide?.();
  };
  state.host.addEventListener('pointerover', over);
  state.host.addEventListener('pointerout', out);
  // AND FOR A THUMB, which has no pointerover at all — so without this the
  // corner is a readout you can only interrogate with a mouse, on a game most
  // people play on a phone. Hold a hexagon for its tip; pull off and it goes.
  // Delegated the same way, and torn down with the rest of it.
  const unpress = pressableWithin(state.host, '.sv-hive-tile', {
    onHold: (tile) => onShow?.(tile.dataset.upgrade, tile),
    onHoldEnd: () => onHide?.(),
    onSlip: () => onHide?.(),
  });
  tipHandlers = { over, out, unpress };
  state.root.dataset.tips = 'on';
  return true;
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

  // A SCREEN THAT CHANGES SIZE CHANGES THE CORNER'S CEILING — a phone turned on
  // its side, a desktop window dragged narrow, the address bar sliding away.
  // The held set has not moved, so setHiveUpgrades' signature guard would never
  // rebuild; without this the hive keeps whatever scale it was born at and a
  // rotation is exactly the case where that is wrong.
  //
  // TWO GUARDS, and both matter. The rAF latch collapses the burst of events a
  // window drag fires into one rebuild per frame, and the comparison means a
  // resize that does not move the number costs the arithmetic and nothing else
  // — no relayout, no FLIP, on a listener that is live for the whole run.
  let pending = false;
  state.onResize = () => {
    if (pending || !state.lastPicks) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!state.host || !state.lastPicks) return;
      const held = foldUpgrades(state.lastPicks);
      if (Math.abs(hiveScale(held) - (state.scale ?? 1)) < 0.001) return;
      rebuild(held);
    });
  };
  window.addEventListener('resize', state.onResize);

  // One listener for every ability in the game — see onFeedback. An event with
  // no upgrade behind it is the common case and costs a map miss.
  state.off = onFeedback((event, at) => {
    const ids = upgradesForEvent(event, at);
    if (!ids) return;
    for (const id of ids) pulseHive(id);
  });
}

/** Kept so a restart can drop the tiles without tearing the mount down. */
export function clearHive() {
  state.held = '';
  state.lastPicks = null;
  // Or the first shot of the next run is swallowed by the last run's timestamp.
  state.lastPulse.clear();
  if (state.host) state.host.textContent = '';
  state.tiles.clear();
  state.shims.clear();
}

/**
 * Cycle the stack treatment. Same shape as setHiveLayout — it changes the
 * packing (a risen tile needs headroom the host has to be measured for), so the
 * signature is dropped and the held set is laid out again from scratch.
 */
export function setHiveStack(mode) {
  CONFIG.upgradeHive.stack = { ...(CONFIG.upgradeHive.stack ?? {}), mode };
  state.held = '';
  if (state.lastPicks) setHiveUpgrades(state.lastPicks);
}

/**
 * The two boxes and the tile map, for ui/hiveReward.js.
 *
 * The reward ceremony PICKS THE HIVE UP AND CARRIES IT — it transforms the root,
 * hangs a halo behind individual tiles and listens on the host — so it needs the
 * actual elements rather than a rectangle. It is the only caller, and it is
 * deliberately a live view: `rebuild()` throws the whole tile map away on every
 * stack taken during the ceremony, so a snapshot handed over once would be
 * pointing at detached nodes by the second pick.
 *
 * Everything else in the game asks this module for a MEASUREMENT (hiveTileRect,
 * hiveRect) rather than for the DOM, and should keep doing so.
 */
export function hiveParts() {
  return { root: state.root, host: state.host, tiles: state.tiles };
}
