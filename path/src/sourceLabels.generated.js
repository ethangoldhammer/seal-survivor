// GENERATED FROM uiText.csv — DO NOT EDIT.
//
// Edit the `source*` rows in path/src/uiText.csv, then run:
//   npm run gen:sourcelabels
//
// It exists because systems/playtestAnalysis.js is import-free on purpose and
// cannot reach a `?raw` CSV — see tools/gen-source-labels.mjs for the whole
// reason. `npm run test:sourcelabels` fails if this file has gone stale.
export const SOURCE_LABELS = {
  impact: "Collision",
  splash: "Blast",
  deathBlast: "Chain Reaction",
  sunPass: "Sun",
  reentry: "Belly Flop",
  lightning: "Lightning",
  pickupBlast: "Pickup Blast",
  bubbleJet: "Bubble Jet",
  crabRicochet: "Crab Collision",
};

/** The uiText.csv rows this file was built from — read by tools/ui-text-test.mjs. */
export const SOURCE_TEXT_IDS = [
  'sourceImpact',
  'sourceSplash',
  'sourceDeathBlast',
  'sourceSunPass',
  'sourceReentry',
  'sourceLightning',
  'sourcePickupBlast',
  'sourceBubbleJet',
  'sourceCrabRicochet',
];
