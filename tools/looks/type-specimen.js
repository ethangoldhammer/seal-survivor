// The Text panel, mounted with no game behind it.
//
// WHY THIS EXISTS. The panel is a dev surface bound to Y inside a running game,
// which makes it the wrong place to LOOK at the type: the specimen strip is a
// 38vh scroll box over a live fight, and the lines that matter most are the
// long ones that scroll out of it. Here the strip is the whole page.
//
// It is also the only way to see it without starting the game's dev server,
// which is the sole writer of imported-tuning.json — see SERVERS.md and
// tools/looks/serve.mjs. This is a static build; nothing it does can reach the
// tuning file.
import { initUI, uiRoot } from '../../path/src/ui/ui.js';
import { initTextPanel, setTextPanelOpen, textPanelEl } from '../../path/src/ui/textPanel.js';
import { initCallouts } from '../../path/src/ui/callout.js';
import { initTypography } from '../../path/src/ui/typography.js';

const noop = () => {};
initUI({ onStart: noop, onRestart: noop, onLevelChoice: noop, onResume: noop, onPauseRestart: noop });
// The callout layer's stylesheet carries the fallback type for the three
// callout roles. Without it the specimen's band lines would be styled by the
// role sheet alone and would differ from the game by whatever ui/callout.js
// states — which is exactly the drift a specimen is supposed to expose.
initCallouts(uiRoot());
// THE ROLE SHEET, which main.js injects at boot and this page did not.
//
// Without it the specimen lines are styled by ui/ui.js's own CSS instead of by
// CONFIG.textStyles — which looks right for every role ui.js happens to carry a
// rule for, and looks like nothing at all for one it does not. A role added
// since that CSS was written (`blobButton`, the splash's blob menu) rendered at
// browser defaults here while rendering correctly in the game, which reads as
// the new role being broken rather than as the tool missing a line.
initTypography();
initTextPanel(noop);
setTextPanelOpen(true);

// Let the panel lay out, then widen it so the whole strip is on screen at once
// rather than inside its own scroller. Cosmetic, and only here: the cap is
// right in the game, where a 634px sheet would hide the tuner behind it.
//
// A TIMER, NOT requestAnimationFrame. The agent's browser pane suspends rAF,
// so a callback scheduled that way never runs at all and the page comes up
// looking finished while none of this has happened — which is exactly how it
// was written the first time. Layout does not need a frame; it needs the call
// stack to unwind, and getBoundingClientRect forces it regardless.
setTimeout(() => {
  const spec = textPanelEl()?.querySelector('.sv-txp-spec');
  if (spec) {
    spec.style.maxHeight = 'none';
    spec.style.overflow = 'visible';
  }
  document.title = 'Type specimen — ready';
}, 50);
