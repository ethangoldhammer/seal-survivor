#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:companions
//
// The two rules that decide WHICH companions a run may collect. Both live in
// availableUpgrades (path/src/entities/player.js) and neither is visible from
// any single card:
//
//   1. ONE SQUAD. Seal Team and Orca Family share `exclusive: 'escort'` — take
//      either and the other leaves the pool for the rest of the run. They buy
//      the same thing (a line of bodies that swims with you and peels off to
//      hit what you are near), so a run holding both is one build twice.
//   2. THREE COMPANIONS. CONFIG.maxCompanionCards caps how many DIFFERENT
//      animals a run collects. Deepening the ones already held is untouched —
//      the cap is on variety, never on depth — and Entourage and Big Rigz
//      carry `companionMod` and are not counted, because they scale the
//      bodies you have rather than adding one.
//
// Both are rules about an OFFER, which is what makes them worth a harness: a
// broken exclusive group or a cap that counts the wrong cards still deals three
// cards every level and still plays. Nothing throws, nothing looks wrong, and
// the only symptom is a build the deck was supposed to make you choose against
// showing up whole thirty levels in.
//
// No renderer — player.js builds three.js objects and they are plain data here.
//
//   node --import ./tools/vite-loader.mjs tools/companion-pool-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { player, availableUpgrades, isCompanionCard } from '../path/src/entities/player.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const byId = (id) => CONFIG.upgrades.find((u) => u.id === id);
const offered = () => availableUpgrades().map((u) => u.id);
const hold = (...ids) => { for (const id of ids) player.upgrades.push({ id, rarity: 'common' }); };
const reset = () => { player.upgrades.length = 0; };

// The bodies, as the offer pool sees them — asked of the same predicate rather
// than listed here, so a companion added to config.js is in this harness the
// day it exists. `enabled` is respected: the dolphin pod is a stub and is out
// of the deal, and a check that counted it would be counting a card that can
// never be dealt.
const BODIES = CONFIG.upgrades.filter((u) => isCompanionCard(u) && u.enabled !== false);

// ===========================================================================
section('THE SHAPE OF THE RULE');
// ===========================================================================

// Each of the checks below goes vacuous under a bad config in a way that still
// reads as a pass — a cap at or above the number of companions can never fire,
// and an exclusive group of one excludes nothing. So the numbers are held to a
// shape once, here, and the checks are then about the code.
check('the cap is smaller than the roster it caps',
  CONFIG.maxCompanionCards >= 1 && CONFIG.maxCompanionCards < BODIES.length,
  `${CONFIG.maxCompanionCards} of ${BODIES.length} companions`);
check('the escort group has two cards in it',
  byId('sealTeam')?.exclusive === 'escort' && byId('orcaFamily')?.exclusive === 'escort',
  `sealTeam ${byId('sealTeam')?.exclusive}, orcaFamily ${byId('orcaFamily')?.exclusive}`);
check('the two modifiers are not counted as companions',
  !isCompanionCard(byId('orbiterAmount')) && !isCompanionCard(byId('companionSize')),
  'Entourage, Big Rigz');
check('...and the bodies are',
  isCompanionCard(byId('sealTeam')) && isCompanionCard(byId('orcaFamily'))
  && isCompanionCard(byId('beluga')),
  BODIES.map((u) => u.id).join(', '));

// ===========================================================================
section('ONE SQUAD PER RUN');
// ===========================================================================

reset();
check('both squads are on offer to a run holding nothing',
  offered().includes('sealTeam') && offered().includes('orcaFamily'));

reset();
hold('sealTeam');
check('taking the escorts drops the pod', !offered().includes('orcaFamily'));
check('...and the escorts can still be deepened', offered().includes('sealTeam'));

// The other way round, because an exclusive group implemented as a one-way
// check would pass every test above and still hand a pod run the escorts.
reset();
hold('orcaFamily');
check('taking the pod drops the escorts', !offered().includes('sealTeam'));
check('...and the pod can still be deepened', offered().includes('orcaFamily'));

// The lock is on the GROUP and not on the pick count: a second stack of the
// squad you hold must not re-open the one you don't.
reset();
hold('orcaFamily', 'orcaFamily', 'orcaFamily');
check('a maxed pod still does not re-open the escorts', !offered().includes('sealTeam'));

// ===========================================================================
section('THREE COMPANIONS, THEN NO MORE NEW ONES');
// ===========================================================================

const cap = CONFIG.maxCompanionCards;
const distinct = BODIES.map((u) => u.id);

reset();
hold(...distinct.slice(0, cap - 1));
check('a run one short of the cap is still offered new companions',
  offered().some((id) => isCompanionCard(byId(id)) && !distinct.slice(0, cap - 1).includes(id)),
  `holding ${cap - 1}`);

reset();
const held = distinct.slice(0, cap);
hold(...held);
const stillOffered = offered().filter((id) => isCompanionCard(byId(id)));
check('at the cap, no companion the run does not already have is offered',
  stillOffered.every((id) => held.includes(id)),
  stillOffered.filter((id) => !held.includes(id)).join(', ') || 'none');
check('...and every one it does have is still offered',
  held.every((id) => stillOffered.includes(id)), stillOffered.join(', '));
check('...and the two modifiers are unaffected',
  offered().includes('orbiterAmount') && offered().includes('companionSize'));

// DEPTH IS NOT VARIETY. Six stacks of one companion is one companion — a cap
// that counted picks rather than ids would close the run's other two slots on
// a build that had taken a single card.
reset();
hold('beluga', 'beluga', 'beluga', 'beluga', 'beluga');
check('stacking one companion does not spend the other slots',
  offered().filter((id) => isCompanionCard(byId(id)) && id !== 'beluga').length > 0,
  `${offered().filter((id) => isCompanionCard(byId(id))).length} companions on offer`);

// The rest of the deck is untouched at the cap — the rule takes companions out
// of the offer, not cards in general.
reset();
hold(...held);
check('non-companion cards are still dealt at the cap',
  offered().some((id) => byId(id)?.family === 'gun'),
  `${offered().length} cards on offer`);

reset();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
