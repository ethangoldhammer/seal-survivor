// ---------------------------------------------------------------------------
// WHICH CONTROLLER IS THIS — the one place the guess is made.
//
// The browser will not tell you what a pad IS. All it hands over is `id`, a
// free-text string the driver chose, and every platform writes it differently:
//
//   "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
//   "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
//   "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)"
//   "054c-0ce6-Wireless Controller"            (Firefox, which gives no words)
//   "Unknown Gamepad (Vendor: 0079 Product: 0006)"
//
// So the brand is READ OUT OF A STRING, and this is the only file that does it.
// The alternative is the version this replaced, where every controller in the
// room was the same emoji: four people holding four different pads, looking at
// four identical chips, working out whose is whose by pushing a stick.
//
// TWO ROUTES, AND THE VENDOR ID IS THE BETTER ONE. The USB vendor number is a
// fact — 045e is Microsoft, 054c is Sony, 057e is Nintendo — and it survives
// Firefox, which gives you the numbers and no words at all. The words are the
// fallback, for the browsers and wrappers that report a name and no ids.
//
// "PRO CONTROLLER" IS THE TRAP, and it is why the order below is not
// alphabetical. Nintendo's pad reports itself as "Pro Controller" with no
// mention of Nintendo, and "controller" appears in almost every other id on the
// list — so a words pass that checked for a generic term first would take the
// Switch pad for a nameless one on every browser that does not report a vendor.
// Each pattern is matched against the WHOLE id, most specific first.
//
// AN UNRECOGNISED PAD IS NOT A FAILURE. There are hundreds of third-party
// controllers and this will never know them all; 'pad' is a real answer with
// its own icon, and a pad that lands there works exactly as well as one that
// did not. What it must never do is guess WRONG — a knock-off reported as a
// DualSense would put the wrong face buttons in front of somebody — so every
// pattern here is a mark the real manufacturer puts on its own hardware.
// ---------------------------------------------------------------------------

/** The brands this can tell apart, in the order they are tested. */
export const PAD_BRANDS = ['xbox', 'playstation', 'switch', 'pad'];

// Vendor first — see the header. Each is the USB vendor id as the Gamepad API
// spells it into `id`, which is four lowercase hex digits.
const VENDORS = [
  ['xbox', '045e'],
  ['playstation', '054c'],
  ['switch', '057e'],
];

// ...and the words, for when there are no numbers. Anchored on marks a
// manufacturer puts on its own hardware rather than on generic terms.
const WORDS = [
  ['xbox', /\bxbox\b|\bxinput\b|microsoft/i],
  ['playstation', /playstation|dual\s?shock|dual\s?sense|\bsony\b|\bps[345]\b/i],
  // "Pro Controller" before anything generic — see the header.
  ['switch', /nintendo|joy-?con|\bswitch\b|pro\s?controller/i],
];

/**
 * @param {string} id  the Gamepad's own `id` string
 * @returns {'xbox'|'playstation'|'switch'|'pad'}
 */
export function padBrand(id) {
  const s = String(id ?? '');
  // The vendor id, wherever in the string it appears: "Vendor: 045e" on Chrome
  // and Safari, a bare "045e-..." prefix on Firefox.
  const vendor = /vendor:?\s*([0-9a-f]{4})/i.exec(s)?.[1] ?? /^([0-9a-f]{4})-/i.exec(s)?.[1];
  if (vendor) {
    // A VENDOR ID ENDS IT EITHER WAY, and that is the point of preferring it.
    // A third-party pad reporting "Vendor: 0079" while calling itself an "Xbox
    // 360 Controller for Windows" in the same string is not Microsoft hardware,
    // and the number is the half of that which cannot flatter itself. Falling
    // through to the words here would let every knock-off on the shelf claim a
    // brand it is only imitating.
    return VENDORS.find(([, v]) => v === vendor.toLowerCase())?.[0] ?? 'pad';
  }
  for (const [brand, re] of WORDS) if (re.test(s)) return brand;
  return 'pad';
}
