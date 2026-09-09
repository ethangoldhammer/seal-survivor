// The devices the hitbox probe presses the title card on — the same list
// tools/layout/layout-audit.js sweeps.
//
// A MODULE OF ITS OWN because both ends need it and neither can import the
// other: tools/hit/splash-hit.js is a browser bundle that pulls in the Rive
// runtime and a 2.4MB .riv, and tools/splash-hit-test.mjs is a Node process
// that drives one browser window PER DEVICE and therefore has to know their
// names before any browser exists. Plain data, no imports, so `await
// import()` from Node costs nothing.
//
// Width and height are CSS pixels — the numbers a page actually sees, not the
// marketing resolution. `touch` is whether that device is a thumb, which is
// what decides whether a 40px button counts as a finding.
export const VIEWPORTS = [
  { name: 'iPhone SE', w: 375, h: 667, touch: true },
  { name: 'iPhone 15', w: 393, h: 852, touch: true },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, touch: true },
  // Landscape is not a rotation of the above, it is a different problem: 393px
  // of HEIGHT is less room than the entry column was designed for.
  { name: 'iPhone 15 landscape', w: 852, h: 393, touch: true },
  { name: 'iPad mini', w: 744, h: 1133, touch: true },
  { name: 'iPad landscape', w: 1024, h: 768, touch: false },
  { name: 'Laptop', w: 1280, h: 800, touch: false },
  { name: 'Desktop', w: 1920, h: 1080, touch: false },
];
