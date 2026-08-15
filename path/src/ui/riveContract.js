// WHAT THE GAME NEEDS seal_survivor.riv TO CONTAIN.
//
// Three names, and every one of them is a handshake with a file this codebase
// does not author. Rename an artboard in the Rive editor, or rebind a property,
// and nothing here stops compiling — the game just quietly comes up with a
// blank splash or a health bar that never moves.
//
// So they live in one dependency-free module, imported by the code that uses
// them AND by the tool that swaps the file in (tools/riv-sync.mjs), which
// refuses an export that has stopped containing them. That is the only reason
// this file exists: a constant used in one place would be better off inline,
// but a constant that a build step has to check has to be reachable without
// dragging in the config, the runtime, or a canvas.
//
// Deliberately no imports. The sync tool runs before anything is built.

/** The title-screen artboard. Named explicitly since the file gained a second. */
export const SPLASH_ARTBOARD = 'Splash Screen';

/** The in-game boss health bar. CONFIG.boss.bar.artboard can override it. */
export const BOSS_BAR_ARTBOARD = 'Boss Health';

/**
 * The data-binding properties the boss bar drives, by role. All three sit on
 * one view model, which the splash shares — see ui/bossBarRive.js for what
 * each is measured to mean.
 */
export const BOSS_BAR_BINDINGS = {
  health: 'numBossHealth',   // 0..100, how full the bar is
  size: 'numHealthBarSize',  // 0..100, the bar's length as a % of artboard width
  name: 'strBossName',       // the label under it
};

/** Everything a usable export must contain, flat, for a validator to walk. */
export function riveRequirements(bossArtboard = BOSS_BAR_ARTBOARD) {
  return {
    artboards: [SPLASH_ARTBOARD, bossArtboard],
    bindings: Object.values(BOSS_BAR_BINDINGS),
  };
}
