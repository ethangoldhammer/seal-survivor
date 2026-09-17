// THE TWO LOADING SCREENS, SIDE BY SIDE.
//
// A resumed run and a cold boot sit through the same seconds on the same bar,
// so the only thing separating them is one line of type — and one line of type
// is exactly the kind of change that is impossible to judge in isolation and
// obvious in a pair. This page is the pair.
//
// It imports the REAL ui/loading.js rather than a copy of its markup: a static
// mock of the caption would keep looking right for exactly as long as it took
// the styles to drift.
//
//   npm run looks:loading
//
// A BUILD served as static files, never a dev server — the game's own dev
// server is the sole writer of imported-tuning.json. See SERVERS.md.
import { showLoading } from '../../path/src/ui/loading.js';
import { initTypography } from '../../path/src/ui/typography.js';

// FIRST, exactly as in boot(). The screen's two lines are Text panel roles
// (`loadTip`, `loadCaption`), so without the role sheet in the head this page
// would show them in the browser's default face and be a picture of nothing
// the game draws — which is the one thing a look page must never be.
initTypography();

// showLoading appends to document.body, so the two are mounted one at a time
// and their roots moved into the panes afterwards. Fiddly, and the alternative
// is a `mount` parameter on showLoading that exists only for this page.
function mountInto(paneId, opts) {
  const before = new Set(document.body.children);
  const handle = showLoading(opts);
  const root = [...document.body.children].find((el) => !before.has(el) && el.classList.contains('sv-load'));
  if (root) document.getElementById(paneId).appendChild(root);
  return handle;
}

// The same shuffle in both panes. The page exists to judge ONE difference —
// the caption — and two panes rotating to different tips would put a second
// difference on screen at every moment, which is the one thing a side-by-side
// must not do.
const seeded = () => {
  let a = 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const cold = mountInto('cold', { tips: { random: seeded() } });
const resumed = mountInto('resume', { resuming: true, tips: { random: seeded() } });

// Drive both bars together at a believable rate, so the caption is read against
// a moving screen rather than a still one. Boot on a phone is several seconds;
// this loops so a screenshot can be taken at any moment.
let t = 0;
function tick() {
  t = (t + 0.004) % 1.35;
  const p = Math.min(1, t);
  cold.setProgress(p);
  resumed.setProgress(p);
  requestAnimationFrame(tick);
}
tick();
