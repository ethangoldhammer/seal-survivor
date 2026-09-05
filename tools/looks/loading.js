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

const cold = mountInto('cold', {});
const resumed = mountInto('resume', { resuming: true });

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
