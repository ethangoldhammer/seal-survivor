// The gameplay moments the upgrade icons are photographs of.
//
// Read by tools/upgrade-icons.mjs, which resolves every `asset` here through
// ASSETS and writes the result into tools/atlas-render/icons.json as a
// `kind: "scene"` spec. Nothing in this file is a file path or an axis: those
// are FACTS about an asset and are re-read from the asset table on every run,
// exactly as the single-model icons already do it. What is authored here is
// only WHICH objects are in the picture and WHERE.
//
// ---------------------------------------------------------------------------
// WHY THESE EXIST
//
// Thirty of the forty-eight upgrades grant no object: a fire rate, an aura, a
// radius, a stat. There is nothing to photograph, so all thirty fell back to
// the hive's two-letter monogram — a wall of type that tells the player nothing
// about what the card does. A moment is the answer that a still image can
// actually carry: not "what is this upgrade", but "what does it look like when
// it happens". The stone leaving in a fan. The mussel curving onto a fish. The
// ring the garlic draws around you.
//
// ---------------------------------------------------------------------------
// THE COORDINATE SYSTEM, AND WHY IT IS NOT WORLD UNITS
//
// Every part is normalised to a bounding sphere of radius 1 and then multiplied
// by its own `scale`, so:
//
//   scale: 1     this part is as big as any other part at scale 1
//   at: [2,0,0]  two of those radii along the icon's forward axis
//
// The sources run from a 0.18-unit pebble to a 14-unit trawler. A hand-typed
// world offset would therefore mean something different in every scene and
// every one would have to be re-found by eye — the same reason VFX in this
// project are never authored in world units either.
//
// Axes are the ICON's, after each part is turned by its declared forward/up:
//
//   +X   the direction the subject faces and shots travel
//   +Y   up
//   +Z   toward the viewer's side of the frame
//
// The shared camera sits low and to the -X side, so +Z separation is what
// creates depth in a fan or a stream and +X separation is what reads as travel.
//
// ---------------------------------------------------------------------------
// A PART
//
//   asset    a key in ASSETS. Its model, format, forward/up, mesh index and
//            clip list are derived. An asset with no model resolves to its own
//            `shape` — the stone really is the game's stone.
//   prim     instead of `asset`, for the marks that exist only as shader passes
//            in the game and so have no asset to borrow: an aura ring, a beam,
//            a motion streak. See makePrimitive() in iconRender.js.
//   clip     which animation to pose from, by name; `clipAt` where in it.
//   at       [x,y,z] placement, in the units above.
//   rot      [x,y,z] degrees, applied before placement.
//   scale    bounding-sphere radius after normalising. Default 1.
//   color    flat tone, overriding the file's materials (models) or the
//            shape's own colour (prims).
//   ink      false to skip the black ink line on this part. Needed on a CLOSED
//            transparent volume and nowhere else — the rim is a back-facing
//            hull, so on a sphere it is an opaque black disc filling the
//            silhouette. See addOutline() in iconRender.js.
//
// ---------------------------------------------------------------------------
// KEEP THEM TO THREE PARTS, AND KEEP THEM CLOSE.
//
// These are looked at at 56px on a hex face. Every scene below was cut down to
// the two or three shapes that survive that size; the fourth object is always
// the one that turns the icon into mush. If a moment needs four things to be
// legible, it is the wrong moment for this card.
//
// The second half of that rule is the one that is easy to get wrong, because
// it is invisible while you are writing the numbers. THE CAMERA FRAMES THE
// WHOLE COMPOSITION — so pushing an accent out to `at: [2.5, 0, 0]` does not
// move the accent, it shrinks the SUBJECT, and the first pass of these scenes
// came back with a beautiful fish and a seal the size of the label under it.
// Keep every part inside about 1.5 radii of the origin, give the subject
// scale 1.2-1.4 and the marks around it 0.3-0.6, and the subject stays the
// thing the icon is of.
// ---------------------------------------------------------------------------

// The palette the marks are drawn in, so a beam in one scene is the same blue
// as a beam in another. Named rather than inlined because the whole point of a
// set of icons is that they look like a set.
const IC = {
  motion: 0xbfe9ff,   // speed streaks and travel
  water: 0x7fd4ff,    // splash, surface, breach
  aura: 0x9be870,     // garlic and the smelly auras
  ink: 0xb07ad0,      // calamari, squid
  heat: 0xff8a4a,     // blasts and booms
  ice: 0xa8e6ff,      // the frozen club
  charge: 0x4db8ff,   // strike energy
  glow: 0x7ffff0,     // bioluminescence
  air: 0xdff6ff,      // breath and bubbles
};

export const SCENES = {
  // --- the gun ------------------------------------------------------------
  // Six cards all modify the same thrown stone, so the STONE cannot be what
  // tells them apart — the arrangement has to. A stream, a size comparison, a
  // streak, a lock-on, a fan and a crowd.
  rapidFire: {
    note: 'three stones already in the air, one behind the next',
    parts: [
      { asset: 'bullet', scale: 0.78, at: [1.25, 0.3, -0.2] },
      { asset: 'bullet', scale: 0.62, at: [0.1, 0, 0.2] },
      { asset: 'bullet', scale: 0.48, at: [-1.0, -0.3, 0.5] },
    ],
  },
  heavyRounds: {
    note: 'the stone that got bigger, with the old one for scale',
    parts: [
      { asset: 'bullet', scale: 1.35, at: [0.35, 0.15, 0] },
      { asset: 'bullet', scale: 0.38, at: [-1.5, -0.6, 0.4] },
    ],
  },
  velocity: {
    note: 'a stone outrunning its own streak',
    parts: [
      { asset: 'bullet', scale: 0.8, at: [1.35, 0, 0] },
      { prim: 'streak', length: 4.2, tube: 0.42, color: IC.motion, opacity: 0.9, scale: 1.2, at: [-0.5, 0, 0] },
    ],
  },
  // TWO STONES AND THE ARCS THEY CAME IN ON. It was a stone and a fish, which
  // is a picture of the stone ARRIVING and says nothing about how it got there
  // — the fish did all the work of implying the homing, and at 52px the fish is
  // the only thing you can see. What homing looks like is a path that BENT, so
  // the trails are the subject and the pebbles are what is on the end of them.
  //
  // The stones are left at the `bullet` asset's own colour: 0x6b7078 is the
  // grey the game actually throws, and an icon of the pebble should be the
  // pebble. Opposite curve signs so the two read as a pair of paths rather than
  // as one drawn twice.
  homingShot: {
    note: 'two grey pebbles, each trailing the arc it turned through',
    parts: [
      { asset: 'bullet', scale: 0.6, at: [1.25, 0.45, 0] },
      // A ribbon's head sits about `scale` along +X of its `at` — see the prim.
      { prim: 'ribbon', length: 3, curve: 1.15, width: 0.36, color: IC.motion, opacity: 0.85, scale: 1.05, at: [0.24, 0.12, -0.05] },
      { asset: 'bullet', scale: 0.46, at: [0.5, -0.8, 0.35] },
      { prim: 'ribbon', length: 2.4, curve: -0.95, width: 0.3, color: IC.motion, opacity: 0.7, scale: 0.85, at: [-0.3, -0.6, 0.3] },
    ],
  },
  // Glow Up!! is NOT here any more, and the entry that was here was DEAD: it
  // was keyed `bioluminescence`, and no upgrade has had that id since the card
  // split into biolumShock / Venom / Chill / Infection. It matched nothing, so
  // it rendered nothing, and nothing said so.
  //
  // It was also the wrong picture — a lit stone in a ring, i.e. a glowing
  // projectile. The upgrade does not light the projectile, it lights the SEAL:
  // CONFIG.biolum.skin makes the bright patches of the animal's own mottling
  // emit. So all four are renders of the seal wearing the real glow layer, each
  // in its element's colour, and they live in ICON_ASSETS in
  // tools/upgrade-icons.mjs with the other renders.

  // --- what leaves the gun ------------------------------------------------
  multishot: {
    note: 'three stones leaving in a fan',
    parts: [
      { asset: 'bullet', scale: 0.7, at: [0.55, 0.15, -1.05] },
      { asset: 'bullet', scale: 0.7, at: [0.95, 0, 0] },
      { asset: 'bullet', scale: 0.7, at: [0.55, -0.15, 1.05] },
    ],
  },
  projectileAmount: {
    note: 'the fan is now a wall',
    parts: [
      { asset: 'bullet', scale: 0.46, at: [0.3, 0.55, -1.35] },
      { asset: 'bullet', scale: 0.46, at: [0.95, 0.2, -0.45] },
      { asset: 'bullet', scale: 0.46, at: [1.0, -0.15, 0.5] },
      { asset: 'bullet', scale: 0.46, at: [0.45, -0.5, 1.35] },
    ],
  },
  bounceShot: {
    note: 'one guppy caught mid-bounce, its arc behind it',
    parts: [
      { asset: 'bounceShot', scale: 0.8, at: [1.2, 0.5, 0] },
      { asset: 'bounceShot', scale: 0.55, at: [0.0, -0.6, 0.25] },
      { asset: 'bounceShot', scale: 0.4, at: [-1.15, 0.35, 0.5] },
    ],
  },
  homingMissile: {
    note: 'the mussel bending onto a fish',
    parts: [
      { asset: 'enemyFish', scale: 1.2, at: [0.8, 0.2, -0.25], clipAt: 0.45 },
      // TINTED, and it has to be. The mussel's own colour is #07070a — a black
      // shell that the game reads as a silhouette against bright water, and
      // that an icon with a black ink line around it reads as a hole. This is
      // the shell colour it would be if it were lit; the game never lights it.
      { asset: 'missile', scale: 0.5, color: 0x6a7b9e, at: [-1.05, -0.35, 0.45], rot: [0, 0, 24] },
    ],
  },
  musselVolley: {
    note: 'a volley of three, staggered',
    parts: [
      { asset: 'missile', scale: 0.55, color: 0x6a7b9e, at: [1.15, 0.4, -0.6] },
      { asset: 'missile', scale: 0.55, color: 0x6a7b9e, at: [0.15, 0, 0.1] },
      { asset: 'missile', scale: 0.55, color: 0x6a7b9e, at: [-0.9, -0.4, 0.8] },
    ],
  },
  oysterBlaster: {
    note: 'the shell open, the pearl already gone',
    parts: [
      { asset: 'scallopShell', scale: 1.3, at: [-0.45, 0, 0] },
      { asset: 'pearl', scale: 0.4, at: [1.2, 0.3, -0.15] },
      { asset: 'pearl', scale: 0.24, at: [1.85, 0.55, 0.3] },
    ],
  },
  // BOUNCER had no picture at all — `kind: 'image'` with nothing attached, so
  // the hive fell back to a monogram. It is a club card, so it gets the club:
  // what separates it from the other four is not the weapon but the RESULT, so
  // the fish is mid-flight off the head rather than swimming past it.
  clubPower: {
    note: 'the club connecting, and the fish going the other way',
    parts: [
      { asset: 'club', scale: 1.2, at: [-0.55, -0.15, 0], rot: [0, 0, 34] },
      { asset: 'enemyFish', scale: 0.95, at: [1.2, 0.55, -0.2], rot: [0, 0, -26], clipAt: 0.4 },
      { prim: 'streak', length: 1.5, tube: 0.12, color: IC.motion, opacity: 0.8, at: [0.35, 0.3, 0.1], rot: [0, 0, -24] },
    ],
  },
  clubThrow: {
    note: 'the club end over end',
    parts: [
      { asset: 'club', scale: 1.3, at: [0.35, 0, 0], rot: [0, 0, 38] },
      { prim: 'streak', length: 3.4, tube: 0.14, color: IC.motion, opacity: 0.65, scale: 1.0, at: [-1.4, -0.45, 0.45], rot: [0, 0, 18] },
    ],
  },

  // --- auras and blasts ---------------------------------------------------
  // All four are a ring in the game and would be four identical rings here, so
  // each one carries the OBJECT that makes it that ring: the seal for garlic,
  // the club for boom and ice, the squid for calamari.
  seaGarlic: {
    note: 'the ring you drag around with you',
    parts: [
      { asset: 'ship', scale: 1.25, clip: 'swim', clipAt: 0.35, at: [0, 0.3, 0] },
      { prim: 'ring', inner: 1.55, outer: 2.1, color: IC.aura, opacity: 0.85, scale: 1.7, at: [0, -0.7, 0] },
    ],
  },
  calamari: {
    note: 'the ink ring, and what makes it',
    parts: [
      { asset: 'enemySquid', scale: 1.15, at: [0, 0.35, 0], clipAt: 0.4 },
      { prim: 'ring', inner: 1.5, outer: 2.1, color: IC.ink, opacity: 0.85, scale: 1.7, at: [0, -0.7, 0] },
    ],
  },
  clubBoom: {
    note: 'the club at the centre of its own blast',
    parts: [
      { asset: 'club', scale: 1.2, at: [0, 0.2, 0], rot: [0, 0, 24] },
      { prim: 'ring', inner: 1.4, outer: 2.1, color: IC.heat, opacity: 0.9, scale: 1.7, at: [0, -0.5, 0] },
      { asset: 'shrapnel', scale: 0.28, at: [1.2, 0.9, -0.4] },
    ],
  },
  clubIce: {
    note: 'the club frozen in, shards off it',
    parts: [
      { asset: 'club', scale: 1.25, color: IC.ice, at: [0, 0.1, 0], rot: [0, 0, 24] },
      { asset: 'shrapnel', scale: 0.38, color: IC.ice, at: [1.15, 0.75, -0.35] },
      { asset: 'shrapnel', scale: 0.3, color: IC.ice, at: [-1.1, -0.6, 0.45] },
    ],
  },
  areaOfEffect: {
    note: 'the same blast, twice as wide',
    parts: [
      { prim: 'ring', inner: 0.55, outer: 0.95, color: IC.heat, opacity: 0.95, scale: 0.85, at: [0, 0.1, 0] },
      { prim: 'ring', inner: 1.72, outer: 2.1, color: IC.heat, opacity: 0.6, scale: 1.8, at: [0, -0.2, 0] },
    ],
  },
  laserEyes: {
    note: 'two beams, still leaving the head',
    parts: [
      { asset: 'ship', scale: 1.3, clip: 'swim', clipAt: 0.3, at: [-0.55, 0, 0] },
      { prim: 'streak', length: 4.6, tube: 0.15, color: 0xff5a3c, opacity: 0.95, scale: 1.1, at: [1.35, 0.3, -0.22] },
      { prim: 'streak', length: 4.6, tube: 0.15, color: 0xff5a3c, opacity: 0.95, scale: 1.1, at: [1.35, 0.3, 0.22] },
    ],
  },

  // --- the strike ---------------------------------------------------------
  strikePower: {
    note: 'one strike orb pulling the next two along',
    parts: [
      { asset: 'strikeOrb', scale: 0.95, at: [1.1, 0.25, -0.2] },
      { asset: 'strikeOrb', scale: 0.65, at: [-0.25, -0.1, 0.3] },
      { asset: 'strikeOrb', scale: 0.45, at: [-1.3, -0.4, 0.7] },
    ],
  },
  strikeDash: {
    note: 'the seal in the strike itself',
    parts: [
      { asset: 'ship', scale: 1.35, clip: 'strike', clipAt: 0.45, at: [0.45, 0, 0] },
      { prim: 'streak', length: 4.0, tube: 0.5, color: IC.charge, opacity: 0.7, scale: 1.15, at: [-1.3, -0.05, 0.3] },
    ],
  },
  strikeShrapnel: {
    note: 'bone leaving the impact',
    parts: [
      { asset: 'gorebone', scale: 1.2, at: [0.1, 0.15, 0], rot: [0, 0, 34] },
      { asset: 'shrapnel', scale: 0.34, at: [1.25, 0.7, -0.45] },
      { asset: 'shrapnel', scale: 0.27, at: [-1.1, -0.7, 0.55] },
    ],
  },
  strikeCharge: {
    note: 'the orb wound all the way up',
    parts: [
      { asset: 'strikeOrb', scale: 1.15, color: IC.charge, at: [0, 0, 0] },
      { prim: 'torus', tube: 0.11, color: IC.charge, opacity: 0.85, scale: 1.8, at: [0, 0, 0], rot: [66, 0, 12] },
      { prim: 'torus', tube: 0.08, color: IC.charge, opacity: 0.55, scale: 2.1, at: [0, 0, 0], rot: [66, 0, -34] },
    ],
  },
  breachChain: {
    note: 'clear of the water, going up',
    parts: [
      { asset: 'ship', scale: 1.3, clip: 'boost', clipAt: 0.4, at: [0.2, 0.65, 0], rot: [0, 0, 34] },
      { prim: 'ring', inner: 1.3, outer: 2.0, color: IC.water, opacity: 0.85, scale: 1.5, at: [-0.1, -0.95, 0] },
    ],
  },

  // --- what you are -------------------------------------------------------
  maxSpeed: {
    note: 'the seal, and how fast it is going',
    parts: [
      { asset: 'ship', scale: 1.4, clip: 'boost', clipAt: 0.4, at: [0.55, 0, 0] },
      { prim: 'streak', length: 3.6, tube: 0.2, color: IC.motion, opacity: 0.8, scale: 0.7, at: [-1.15, 0.4, 0.2] },
      { prim: 'streak', length: 3.0, tube: 0.16, color: IC.motion, opacity: 0.6, scale: 0.58, at: [-1.2, -0.45, 0.45] },
    ],
  },
  vitality: {
    note: 'a whole seal inside a whole bubble',
    parts: [
      { asset: 'ship', scale: 1.05, clip: 'idle', clipAt: 0.3, at: [0, 0, 0] },
      // The bubble reads as a rim and a sheen, not as a lid. `ink: false` is what
      // makes that possible at all: with an outline it is a solid grey disc at
      // any opacity, because what you are seeing through the glass is the
      // glass's own rim.
      { asset: 'trapBubble', scale: 1.4, color: IC.air, opacity: 0.34, ink: false, at: [0, 0, 0] },
    ],
  },
  regen: {
    note: 'the wound closing — bubbles going up off the body',
    parts: [
      { asset: 'ship', scale: 1.35, clip: 'idle', clipAt: 0.3, at: [0, -0.3, 0] },
      { asset: 'bubbleOrb', scale: 0.34, color: IC.air, at: [0.5, 0.85, -0.15] },
      { asset: 'bubbleOrb', scale: 0.24, color: IC.air, at: [-0.25, 1.2, 0.25] },
    ],
  },
  magnet: {
    note: 'chum coming to you',
    parts: [
      { asset: 'attractorOrb', scale: 0.8, at: [0, 0, 0] },
      { asset: 'chumChunk', scale: 0.45, at: [1.35, 0.5, -0.4] },
      { asset: 'chumChunk', scale: 0.38, at: [-1.2, -0.6, 0.55] },
    ],
  },
  oxygenMax: {
    note: 'one big breath held',
    parts: [
      // The ORB rather than the trap bubble, which is the see-through one. With
      // nothing inside it to show, a transparent sphere is just a grey ball on
      // a dark hex; the orb is the pale, inked bubble the eye reads as air.
      { asset: 'bubbleOrb', scale: 1.15, color: IC.air, at: [0.25, 0, 0] },
      { asset: 'bubbleOrb', scale: 0.34, color: IC.air, at: [-1.25, 0.75, 0.25] },
      { asset: 'bubbleOrb', scale: 0.22, color: IC.air, at: [-1.55, -0.45, 0.5] },
    ],
  },
  oxygenRefill: {
    note: 'bubbles reaching the surface',
    parts: [
      { prim: 'ring', inner: 1.6, outer: 2.1, color: IC.water, opacity: 0.8, scale: 1.5, at: [0, 0.75, 0] },
      { asset: 'bubbleOrb', scale: 0.55, color: IC.air, at: [0.1, -0.1, 0] },
      { asset: 'bubbleOrb', scale: 0.34, color: IC.air, at: [-0.6, -0.95, 0.35] },
    ],
  },
  companionSize: {
    note: 'the escort you had, next to the escort you have',
    parts: [
      // The SHRIMP rather than a helper seal, and the reason is silhouette. Two
      // seals at two sizes are two pale lozenges and the card reads as nothing;
      // a shrimp has legs and a tail curl that survive being shrunk, so "the
      // same animal, bigger" is legible at 56px.
      { asset: 'shrimp', scale: 1.3, at: [0.3, 0.25, 0] },
      { asset: 'shrimp', scale: 0.45, at: [-1.25, -0.7, 0.5] },
    ],
  },
};
