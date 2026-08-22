// ---------------------------------------------------------------------------
// THE BOSS DIVIDEND, on its own.
//
//   npm run looks:dividend    then open http://localhost:4696/dividend.html
//
// The ceremony that opens after a boss dies: the hive comes off the corner,
// flies to the middle of the screen, and the player deepens a stack per boss
// killed. Reaching it in the game means beating a boss, which is several
// minutes of play per look — and the three things worth judging (how far it
// travels, how the glow reads on a hexagon, and whether the corner settles or
// jumps as a pile grows under it) are all LAYOUT AND MOTION, which the jsdom
// harness cannot see and a Node harness cannot measure.
//
// So the real ui.js is mounted here, the real upgradeHive.js is handed a build,
// and the real hiveReward.js opens over it. Every number comes out of the same
// CONFIG the game reads, so tuning CONFIG.upgradeHive.reward and reloading this
// page is the tightening loop.
//
// IT WRITES NOTHING. A vite build behind the read-only look server, with no
// /__tuning endpoint to reach — see SERVERS.md. The one thing it cannot show is
// the beat before it: in a run this opens under a level-up ramp, after the kill
// shot has let the clock go.
// ---------------------------------------------------------------------------
import { CONFIG } from '../../path/src/config.js';
import { initTypography } from '../../path/src/ui/typography.js';
import { initUI } from '../../path/src/ui/ui.js';
import { setHiveUpgrades } from '../../path/src/ui/upgradeHive.js';
import {
  startHiveReward, resetHiveReward, hiveRewardActive, bossDividendStacks,
} from '../../path/src/ui/hiveReward.js';

const say = (t) => { document.getElementById('say').textContent = t; };

initTypography();
initUI({
  onStart: () => {}, onRestart: () => {}, onLevelChoice: () => {},
  onResume: () => {}, onPauseRestart: () => {}, onSplash: () => {}, onMenu: () => {},
});
// initUI builds the title screen too, and it would sit over the whole page.
document.getElementById('svStartMenu')?.classList.add('sv-hidden');
document.querySelector('.sv-hud')?.classList.add('sv-hidden');

// A BUILD WITH SOMETHING TO SAY. Mixed tiers, because the halo takes its colour
// off the tile's rarity and a sheet of Commons cannot show that; mixed depths,
// because the ceremony re-centres as a pile grows and a hive of singles never
// exercises it; and one card pinned at its cap, so there is always a hexagon on
// screen that must refuse to be clicked.
const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const CAPPED = 'sealTeam';
const capOf = (id) => CONFIG.upgrades.find((u) => u.id === id)?.maxStacks ?? null;

function build(deep) {
  const picks = [];
  const add = (id, n, tier) => {
    for (let i = 0; i < n; i++) picks.push({ id, rarity: tier });
  };
  add('shrimpRing', deep ? 6 : 2, TIERS[4]);
  add('club', deep ? 4 : 1, TIERS[3]);
  add('seaGarlic', deep ? 3 : 1, TIERS[2]);
  add('harp', 1, TIERS[1]);
  add('electricEel', deep ? 2 : 1, TIERS[0]);
  if (deep) {
    add('beluga', 2, TIERS[3]);
    add('oysterBlaster', 1, TIERS[4]);
    add('homingMissile', 3, TIERS[2]);
    add('starfish', 1, TIERS[1]);
  }
  // At its ceiling on purpose — the one tile that has to stay dark.
  add(CAPPED, capOf(CAPPED) ?? 3, TIERS[4]);
  return picks;
}

let picks = build(false);
let deep = false;
const countOf = (id) => picks.filter((p) => p.id === id).length;
const canStack = (id) => {
  const def = CONFIG.upgrades.find((u) => u.id === id);
  if (!def || def.enabled === false) return false;
  return def.maxStacks == null || countOf(id) < def.maxStacks;
};

function paint() {
  setHiveUpgrades(picks);
}

function open(stacks) {
  resetHiveReward();
  picks = build(deep);
  paint();
  const taken = [];
  const started = startHiveReward({
    stacks,
    canStack,
    onStack: (id) => {
      if (!canStack(id)) return false;
      picks.push({ id, rarity: TIERS[Math.min(4, countOf(id))] });
      taken.push(id);
      paint();
      say(`took ${taken.join(', ')} — ${stacks - taken.length} left`);
      return true;
    },
    onDone: () => {
      say(`spent: ${taken.join(', ') || 'nothing'} — the hive is flying home`);
    },
  });
  say(started
    ? `${stacks} stack${stacks === 1 ? '' : 's'} to spend. ${CAPPED} is at its cap and must not answer.`
    : 'refused to open — nothing in this build can take another stack');
}

document.getElementById('btnOne').onclick = () => open(bossDividendStacks(1));
document.getElementById('btnThree').onclick = () => open(bossDividendStacks(3));
document.getElementById('btnDeep').onclick = () => {
  deep = !deep;
  say(deep ? 'deep build — reopen to see it' : 'shallow build — reopen to see it');
  if (!hiveRewardActive()) { picks = build(deep); paint(); }
};
document.getElementById('btnHome').onclick = () => {
  resetHiveReward();
  say('sent home the hard way (a restart mid-ceremony takes this route)');
};

paint();
say('the corner, as a run would show it. Pick a payout above.');
