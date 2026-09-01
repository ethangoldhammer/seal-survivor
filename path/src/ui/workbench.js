import { CONFIG, saveTuningToStorage } from '../config.js';
import { feedback, shakeAllowed, hitstopAllowed } from '../systems/feedback.js';
import { emit } from '../entities/particles.js';
import { describeHaptic, previewHaptic } from '../systems/haptics.js';
import {
  playSfx, unlockAudio, gainToDb, dbToGain, DB_FLOOR, watchSfx, sfxVoiceLoad,
  busReduction, sampleCount, reloadSample, getAudioContext, isMuted, setSfxEcho, sfxEchoOpen, hasSample,
} from '../systems/audio.js';
import { uploadAsset } from '../systems/assetUpload.js';
import { stageState, onStageChanged, stageAnchor } from '../systems/stage.js';
import { fireBossBoom, resetBossBooms } from '../systems/bossBoom.js';
import { startCardRiser, stopCardRiser, stopAllCardRisers, cardRiserCount } from '../systems/cardRiser.js';
import { stageJet, stopStagedJet, stagedJetOpen, jetStats, bubbleJetState } from '../systems/bubbleJet.js';
import { jetBedCount } from '../systems/jetBed.js';
import { boltPalette, redressBolts } from '../systems/finLaser.js';
import { projectiles } from '../entities/projectiles.js';
import { player } from '../entities/player.js';
import { EASINGS } from '../ease.js';
import { isLaser, laserReachSteps, latticeGenerations, childrenAt, latticeWorstCase, latticeLiveChildren } from '../loadout.js';

// THE FEEL WORKBENCH — F.
//
// One surface for what an event does, because an event is one thing and the
// game's panels had it in three. `kill` used to be tuned in the Sound tab (its
// voice), the Haptics tab (its rumble) and — for seven events out of seventy-
// seven — the ` tuner (shake, hit-stop, ripple). The other seventy had no UI
// for half of what they do at all. feedback() fires all of it in one call, so
// the thing you are actually judging was never in one place.
//
// WHY EVENTS AND NOT SOUNDS. CONFIG.sfx is a list of voices; CONFIG.feedback is
// a list of moments. You tune moments. The catch is that several moments share
// one voice — chumEaten borrows bite, and there are seven such — so editing a
// level here can be heard somewhere you weren't looking. That is not hidden:
// every shared voice says who else hears it, and the picker will fork one.
//
// The layout is a rail, a detail pane and a dock, and the reason is width. The
// old Sound tab put 67 voices and up to nine sliders each into a 300px column,
// which is why its stylesheet carries a min-width:0 hack to stop the readouts
// falling off the right edge. This is a workbench; it gets the screen.
//
// The stage bar (ui/stage.js) is deliberately NOT absorbed into this. It is
// fixed to the bottom and floats over whatever is up, because parking the
// camera and firing an event are useful from the game as well as from here.

const RAIL_SECTIONS = [
  ['Your weapon', ['shoot', 'shootLaser', 'laserEyes', 'hit', 'bulletHit', 'latticeSplit', 'kill', 'bigKill', 'bounce', 'missileLaunch', 'missileImpact']],
  ['The seal', ['playerHit', 'playerDeath', 'boost', 'bite', 'clap', 'breach', 'surfacing', 'splash', 'seabedThud', 'seabedImpact', 'breathIn', 'breathOut', 'bubblePop', 'oxygenWarn']],
  ['Strike & food chain', ['strike', 'strikeChain', 'strikeBurst', 'strikeRam', 'strikeMark', 'boostEmpty', 'foodChain']],
  ['Pickups & progression', ['pickup', 'chumSlurp', 'chumEaten', 'chumHoover', 'chumChunkEaten', 'chumFull', 'levelUp']],
  ['Escorts', ['sealRam', 'sealLunge', 'sealShot', 'eelBolt', 'eelChain', 'belugaSplit', 'belugaTrap', 'belugaPop', 'dumboCharm', 'octoGrab', 'octoPop', 'orcaStrike']],
  ['Auras & orbits', ['garlicTick', 'shrimpHit', 'calamariPulse']],
  ['Thrown & launched', ['seagullDive', 'scallopLaunch', 'scallopJet', 'pearlShot', 'pearlBurst', 'bakalarHaul', 'bakalarBombDrop', 'bakalarBombBlast']],
  ['Boats', ['debrisBreak', 'boatExplosion', 'crewEaten', 'crewHit']],
  // THE LEVEL-UP SCREEN, in the order it happens: the comb powering on, then
  // one landing (its pop, its knock, and the sting for whichever tier landed),
  // then the payoff and the door closing. Listed rather than left in
  // "Everything else" because these are auditioned as a SEQUENCE — the five
  // rarity stings are a ladder and the only useful question about any one of
  // them is how it sits against the rung below, which is impossible to ask if
  // they are scattered down an alphabetical list.
  //
  // THE RISER IS PINNED TO THE TOP OF IT, by hand, for the reason the boss's
  // explosion is pinned to the top of Bosses: it is not a feedback event and so
  // cannot sit in this ordered list at all. It used to be a CONFIG.sfx voice
  // fired straight from ui.js, which meant the one sound on this screen with no
  // row anywhere — not here, not in the ` tuner, not in the old Sound tab.
  ['The level-up screen', ['combIgnite', 'cardPop', 'cardLand',
    'rarityCommon', 'rarityUncommon', 'rarityRare', 'rarityEpic', 'rarityLegendary',
    'combFlood', 'combDrain']],
  // The boss's own voices, which had no home here at all until the
  // explosion needed one. THE EXPLOSION ITSELF IS NOT IN THIS LIST: it is
  // not a feedback event (see BOOM_ROW), and the rail adds it to the top of
  // this section by hand.
  // Read top to bottom this is one blow going through its three layers: the
  // moment, then what the thing is made of, then what it says about it. Which
  // is also the order they fire in (see bossVoice), and the order they have to
  // be auditioned in — a cry judged without the impact under it is a sound
  // nobody will ever hear on its own.
  ['Bosses', ['bossHit', 'bossDeath',
    'bossDieFlesh', 'bossDieShell', 'bossDieHull',
    'bossHitFlesh', 'bossHitShell', 'bossHitHull', 'bossDaze',
    // The weak spots. Placed under the material voices they play ON TOP of
    // rather than in a section of their own — a crit is bossHitFlesh with
    // hotSpotHit over it, and the two are audited by ear together or not at
    // all.
    'hotSpotHit', 'hotSpotBurst']],
  // THE ENTRANCE, in the order it is heard. The alarm, the animal, the
  // variant, and the cue the whole thing resolves onto — which is why
  // `bossArrive` is at the BOTTOM of this section rather than the top: this is
  // the one part of a boss fight that is a phrase, and a list that put the
  // resolution first would be unauditionable. Fire them down the section and
  // you have heard the entrance.
  //
  // `bossArrive` had no row anywhere until now, in this panel or the ` tuner —
  // the loudest cue in the run, and the only way to hear it was to reach a
  // boss.
  //
  // The two variant cues at the end are the odd ones: `bossArriveStorm` is
  // named by four perks at once (CONFIG.boss.voicePerk), so the shared-voice
  // marker on it is telling the truth about a decision rather than warning
  // about a collision.
  ['The entrance', ['bossSiren',
    'bossArriveShark', 'bossArriveHammerhead', 'bossArriveOrca',
    'bossArriveMosasaur', 'bossArriveSquid', 'bossArriveAngler',
    'bossArriveCrab', 'bossArriveBoat', 'bossArriveYacht',
    'bossArriveElectric', 'bossArriveStorm',
    'bossArrive']],
  // THE CRIES — CONFIG.boss.voiceType, one pair per archetype. Their own
  // section rather than eighteen more rows under the material voices, because
  // the question they answer is a different one: up there you are asking
  // whether steel and flesh sound like steel and flesh, and down here whether
  // the hammerhead sounds like a smaller shark. Paired hit-then-death per
  // creature, so one animal is a two-row audition and not a hunt through an
  // alphabet.
  ['Boss cries', ['bossHitShark', 'bossDieShark',
    'bossHitHammerhead', 'bossDieHammerhead',
    'bossHitOrca', 'bossDieOrca',
    'bossHitMosasaur', 'bossDieMosasaur',
    'bossHitSquid', 'bossDieSquid',
    'bossHitAngler', 'bossDieAngler',
    'bossHitCrab', 'bossDieCrab',
    'bossHitBoat', 'bossDieBoat',
    'bossHitYacht', 'bossDieYacht']],
];

// The one rail row that is not a feedback event. `*` so it can never collide
// with a real event id, the same way '*global' does.
const BOOM_ROW = '*boom';
// What typing in the filter box has to match to find it. The id is a symbol
// nobody would type, and every other row is found by its own name.
const BOOM_TERMS = 'boom explosion smoke shockwave boss going up kill';

// THE LIGHT ON THE KILL, on the same terms and beside the explosion it lights.
// Not a feedback event either — it is a moment with no sound and no rumble, and
// systems/bossLight.js is driven by the corpse countdown rather than by a
// feedback() call.
const LIGHT_ROW = '*killlight';
const LIGHT_TERMS = 'light kill light shaft god ray hero volumetric wash polaroid trophy photo snapshot beam';

// THE GOO, on the same terms and for a stronger reason. A goo group is a
// SUBSTANCE, not a moment: `blood` is thrown by a kill, by a body coming apart
// and by a boss losing a weak spot, and `foam` by four different emitters that
// no single event owns. There is nowhere in a rail of events it could honestly
// hang, so it gets its own row — and until it had one the only goo surface with
// any UI in the game was `boom`, inside the explosion's view.
const GOO_ROW = '*goo';
const GOO_TERMS = 'goo blood gore foam smoke ichor aura hit pickup slime metaball density fuse surface';
// The first pill: CONFIG.fx.goo's own surface keys, which every group is a
// diff against. Not a group name — `*` so it can never collide with one.
const GOO_SHARED = '*shared';

// THE CARD RISER, on the same terms as the two above and for the same reason:
// it is a continuous voice, not a one-shot and not an event. systems/cardRiser.js
// says why it had to stop being a CONFIG.sfx entry — the short version is that
// a table of envelopes cannot be told how long the fall it is scoring takes,
// and this one is scheduled across exactly it.
const RISER_ROW = '*cardriser';
const RISER_TERMS = 'riser buildup sweep filter card falling slam fall build cardriser';

// THE BUBBLE JET, on the same terms as the three above and for the same reason
// the riser is: it is a CONTINUOUS thing, not a moment. Its two feedback events
// (`jetSpool`, `jetCut`) are in the rail like any others and neither of them
// carries the weapon's sound — that is a bed held open across the whole burn
// (systems/jetBed.js), which nothing in CONFIG.sfx can describe.
//
// It gets a row rather than living under `jetSpool` because the question you
// come here to answer is "does the stream look and sound right while it is
// open", and that is a thing you HOLD, not a thing you fire. An event view with
// a Fire button cannot ask it.
const JET_ROW = '*bubblejet';
const JET_TERMS = 'jet bubble jet stream beam spline snake wiggle moog synth bed drone plasma bubblejet';

// THE FIN LASER'S BOLT, on the same terms as the four above and for a reason
// that is the goo's rather than the jet's: it is a BODY, not a moment. A bolt
// has no feedback event of its own — the shot fires `shoot` and the impact
// fires `bulletHit`, exactly as a pebble does — so there is nowhere in a rail
// of events it could honestly hang, and until it had a row the only way to
// judge its length was to fire one and watch it leave.
//
// It is here rather than in the ` tuner for the reason the boss explosion is:
// this is the panel with the gun firing in front of it. A bolt's silhouette is
// judged at the speed it crosses the screen, and a slider two panels away from
// the thing it moves is a slider you tune by memory.
const LASER_ROW = '*finlaser';
const LASER_TERMS = 'laser fin laser bolt beam light shot pebble loadout lattice sealant shatter split glow overdrive halo finlaser';

// THE BED'S LOOPS — the two voices that are not fired by anything.
//
// This rail is built from CONFIG.feedback because you tune MOMENTS, and that is
// still right for every other row in it. These two have no moment: they are
// buffer material that CONFIG.bubbleJet.bed.layers loops, so nothing in
// CONFIG.feedback names them and they were unreachable here — you could pick
// them in the bed's layer list and had nowhere to hear one on its own, set its
// level, or put a different file behind it.
//
// Rows of their own rather than a general "voices with no event" section: two
// named things somebody can find beat a category nobody looks in, and if a
// third loop voice ever exists it wants to be named here too.
const LOOP_ROWS = { '*jetbedloop': 'jetBed', '*jetbedwiggleloop': 'jetBedWiggle' };
const LOOP_TERMS = 'loop bed jet bubble beam wiggle sample layer stream jetbed';

const STYLES = `
  .sv-wb { position: fixed; inset: 0 0 96px 0; z-index: 31; display: none;
    grid-template-columns: 248px 1fr 272px;
    background: rgba(6,7,11,0.96); backdrop-filter: blur(12px); color: #e8ecf3;
    font-family: 'Inter', system-ui, sans-serif; font-size: 12px; }
  .sv-wb.sv-wb-on { display: grid; }
  .sv-wb-rail { border-right: 1px solid rgba(255,255,255,0.09); overflow-y: auto; }
  .sv-wb-main { display: flex; flex-direction: column; overflow: hidden; }
  .sv-wb-dock { border-left: 1px solid rgba(255,255,255,0.09); display: flex; flex-direction: column; overflow: hidden; }

  .sv-wb h2 { font-size: 11px; letter-spacing: 0.11em; text-transform: uppercase; font-weight: 600; margin: 0; }
  .sv-wb-railhead { padding: 12px 13px 10px; border-bottom: 1px solid rgba(255,255,255,0.08);
    position: sticky; top: 0; background: rgba(8,9,14,0.98); z-index: 2; }
  .sv-wb-search { width: 100%; margin-top: 8px; background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; color: #e8ecf3;
    font: inherit; font-size: 11px; padding: 5px 8px; }
  .sv-wb-meta { font-size: 10px; color: rgba(232,236,243,0.4); margin-top: 6px; font-variant-numeric: tabular-nums; }
  .sv-wb-sec { font-size: 9px; letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(232,236,243,0.36); padding: 12px 13px 4px; font-weight: 600; }
  .sv-wb-ev { display: flex; align-items: center; gap: 7px; padding: 5px 13px; cursor: pointer;
    font-size: 11.5px; border-left: 2px solid transparent; }
  .sv-wb-ev:hover { background: rgba(255,255,255,0.04); }
  .sv-wb-ev.sv-wb-on-row { background: rgba(122,215,255,0.1); border-left-color: #7ad7ff; color: #bfe9ff; }
  .sv-wb-ev .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-wb-dots { display: flex; gap: 2.5px; flex-shrink: 0; }
  .sv-wb-dot { width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,0.13); }
  .sv-wb-dot.s { background: #ffb347; } .sv-wb-dot.h { background: #7ad7ff; } .sv-wb-dot.i { background: #ff8fb1; }

  .sv-wb-head { padding: 13px 18px 11px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sv-wb-title { display: flex; align-items: baseline; gap: 10px; }
  .sv-wb-title h1 { font-size: 18px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  .sv-wb-via { font-size: 10.5px; color: rgba(232,236,243,0.4);
    font-family: ui-monospace, Menlo, monospace; }
  .sv-wb-chips { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
  .sv-wb-chip { font-size: 9px; padding: 2.5px 7px; border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.15); color: rgba(232,236,243,0.6); }
  .sv-wb-chip.warn { border-color: rgba(255,179,71,0.5); color: #ffb347; background: rgba(255,179,71,0.07); }
  .sv-wb-chip.link { border-color: rgba(122,215,255,0.4); color: #7ad7ff; }
  .sv-wb-chip.bad { border-color: rgba(255,128,149,0.5); color: #ff8095; background: rgba(255,128,149,0.07); }

  /* auto-fit, not a fixed pair: the detail pane is whatever is left after the
     rail and the dock, which on a laptop is under 420px — and two hard columns
     there clipped the Rumble card off the right edge entirely. It collapses to
     one column rather than shrinking past legibility. */
  .sv-wb-cols { flex: 1; overflow-y: auto; padding: 13px 18px 24px;
    display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
    gap: 13px; align-content: start; }
  .sv-wb-card { border: 1px solid rgba(255,255,255,0.09); border-radius: 9px; padding: 11px 12px;
    background: rgba(255,255,255,0.015); }
  .sv-wb-card.wide { grid-column: 1 / -1; }
  .sv-wb-card h3 { font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
    margin: 0 0 2px; font-weight: 600; }
  .sv-wb-card .sub { font-size: 10px; color: rgba(232,236,243,0.38); margin-bottom: 9px; line-height: 1.4; }
  .sv-wb-snd h3 { color: #ffb347; } .sv-wb-hap h3 { color: #7ad7ff; } .sv-wb-imp h3 { color: #ff8fb1; }

  .sv-wb-f { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
  .sv-wb-f label { font-size: 10px; color: rgba(232,236,243,0.52); width: 76px; flex-shrink: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-wb-f input[type=range] { flex: 1; min-width: 0; height: 14px; }
  .sv-wb-snd input[type=range] { accent-color: #ffb347; }
  .sv-wb-hap input[type=range] { accent-color: #7ad7ff; }
  .sv-wb-imp input[type=range] { accent-color: #ff8fb1; }
  .sv-wb-num { width: 56px; flex-shrink: 0; background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.13); border-radius: 5px; color: #e8ecf3;
    font: inherit; font-size: 10px; padding: 2px 5px; text-align: right; font-variant-numeric: tabular-nums; }
  .sv-wb-f.dead { opacity: 0.32; }
  .sv-wb-f.dead .sv-wb-num { text-decoration: line-through; }
  .sv-wb-btn { font-size: 10px; font-weight: 600; padding: 4px 9px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: #e8ecf3;
    cursor: pointer; font-family: inherit; }
  .sv-wb-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-wb-sel { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 5px; color: #e8ecf3; font: inherit; font-size: 10px; padding: 3px 6px; }
  .sv-wb-scope { margin-top: 8px; border: 1px solid rgba(255,179,71,0.35);
    background: rgba(255,179,71,0.06); border-radius: 7px; padding: 7px 9px;
    font-size: 10px; color: #ffc98a; line-height: 1.45; }
  .sv-wb-scope b { color: #ffe0b8; }
  .sv-wb-none { font-size: 10px; color: rgba(232,236,243,0.4); line-height: 1.5; margin-top: 4px; }
  /* A surface row reading the SHARED value because this group does not
     override it. Marked on the readout rather than by grey-ing the control:
     the row is live, and moving it is exactly how a group takes a number of
     its own. The label keeps its width — a suffix there would ellipsise. */
  .sv-wb-f.sv-wb-inh .sv-wb-num { color: rgba(122,215,255,0.6); font-style: italic; }

  .sv-wb-takes { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .sv-wb-take { display: flex; align-items: center; gap: 6px; font-size: 10px; }
  .sv-wb-take .fn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: rgba(232,236,243,0.62); font-family: ui-monospace, Menlo, monospace; font-size: 9.5px; }
  .sv-wb-take .sv-wb-btn { padding: 1px 6px; }
  .sv-wb-drop { margin-top: 8px; border: 1px dashed rgba(255,255,255,0.18); border-radius: 7px;
    padding: 8px; text-align: center; font-size: 10px; color: rgba(232,236,243,0.4); }
  .sv-wb-drop.over { border-color: #7ad7ff; color: #7ad7ff; background: rgba(122,215,255,0.08); }

  .sv-wb-tabs { display: grid; grid-template-columns: 1fr 1fr; flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,0.09); }
  .sv-wb-tab { padding: 9px 4px; font-size: 9.5px; font-weight: 600; text-align: center; cursor: pointer;
    color: rgba(232,236,243,0.5); letter-spacing: 0.08em; text-transform: uppercase;
    border-bottom: 2px solid transparent; }
  .sv-wb-tab.on { color: #7ad7ff; border-bottom-color: #7ad7ff; background: rgba(122,215,255,0.07); }
  .sv-wb-pane { display: none; flex: 1; min-height: 0; flex-direction: column; }
  .sv-wb-pane.on { display: flex; }

  .sv-wb-libhead { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sv-wb-pills { display: flex; gap: 5px; margin-top: 7px; }
  .sv-wb-pill { font-size: 9px; padding: 3px 8px; border-radius: 20px; cursor: pointer;
    border: 1px solid rgba(255,255,255,0.14); color: rgba(232,236,243,0.55); }
  .sv-wb-pill.on { border-color: #7ad7ff; color: #7ad7ff; background: rgba(122,215,255,0.1); }
  .sv-wb-pill.orphan.on { border-color: #ffb347; color: #ffb347; background: rgba(255,179,71,0.1); }
  .sv-wb-liblist { flex: 1; overflow-y: auto; }
  .sv-wb-lib { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.045); }
  .sv-wb-lib:hover { background: rgba(255,255,255,0.035); }
  .sv-wb-lib.inset { background: rgba(122,215,255,0.07); }
  .sv-wb-lib .top { display: flex; align-items: center; gap: 6px; }
  .sv-wb-lib .fn { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(232,236,243,0.8); }
  .sv-wb-lib .kb { font-size: 9px; color: rgba(232,236,243,0.3); flex-shrink: 0; }
  .sv-wb-lib .used { font-size: 9px; margin-top: 3px; color: rgba(232,236,243,0.4); line-height: 1.35; }
  .sv-wb-lib .used b { color: rgba(122,215,255,0.85); font-weight: 500; }
  .sv-wb-lib .used.none { color: #ffb347; }
  .sv-wb-lib .used.other { color: rgba(150,255,190,0.85); }
  .sv-wb-libfoot { border-top: 1px solid rgba(255,255,255,0.08); padding: 8px 12px;
    font-size: 9.5px; color: rgba(232,236,243,0.4); line-height: 1.5; flex-shrink: 0; }
  .sv-wb-libfoot b { color: #ffb347; font-weight: 600; }
  .sv-wb-danger { border-color: rgba(255,128,149,0.5); color: #ff8095;
    background: rgba(255,128,149,0.08); margin-top: 6px; width: 100%; }

  .sv-wb-stats { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sv-wb-stat { display: flex; justify-content: space-between; font-size: 10px; margin-top: 4px;
    font-variant-numeric: tabular-nums; color: rgba(232,236,243,0.55); }
  .sv-wb-stat b { font-weight: 600; color: #e8ecf3; }
  .sv-wb-feed { flex: 1; overflow-y: auto; padding: 7px 12px 12px;
    font: 500 10.5px/1.55 ui-monospace, Menlo, monospace; }
  .sv-wb-fr { display: flex; gap: 6px; }
  .sv-wb-fr .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-wb-hint { position: fixed; right: 14px; bottom: 100px; z-index: 33; font-size: 10px;
    color: rgba(232,236,243,0.35); font-family: 'Inter', system-ui, sans-serif; pointer-events: none; }
  .sv-wb-hint.sv-wb-off { display: none; }
`;

const FEED_COLOR = {
  sample: 'rgba(122,215,255,0.95)', synth: 'rgba(232,236,243,0.78)',
  note: 'rgba(143,217,168,0.9)', gap: 'rgba(255,179,71,0.9)', far: 'rgba(255,179,71,0.9)',
  stolen: 'rgba(198,176,255,0.85)', voices: 'rgba(255,179,71,0.9)',
  muted: 'rgba(232,236,243,0.35)', off: 'rgba(232,236,243,0.35)',
  unknown: 'rgba(255,128,149,0.95)', missing: 'rgba(255,128,149,0.95)',
};

let panel = null;
let visible = false;
let current = 'kill';
// How big the body under the test explosion is. Lives here rather than in
// CONFIG for the reason stageState does: it is where the knob happens to be
// sitting while you work, not an authored value, and everything in CONFIG
// travels with the repo. 7 is a middling boss.
let boomTestRadius = 7;
// Which substance the goo view is showing, and which of the emitters feeding it
// the Burst card is pointed at. Both are where the panel is looking rather than
// anything authored, so — like boomTestRadius — they never go near CONFIG.
let gooGroup = null;
let gooShot = null;
// Handed in by main.js. Everything else in here is a live config write the game
// picks up on its next frame; the field's resolution is the one exception, and
// it needs the post chain resized before it means anything.
let onTuned = null;
let libFilter = 'all';
let library = [];        // { file, src, kb } straight off disk
let libraryError = '';
let feedRows = [];
const els = {};

// ---------------------------------------------------------------------------

// A loop row IS its voice; every other row names one through its event. Routed
// here rather than at each call site so the Library's + / − buttons, the "who
// else hears this" scan and the take list all work on a loop row unchanged.
const voiceOf = (event) => LOOP_ROWS[event] ?? CONFIG.feedback[event]?.sfx ?? null;
const srcsOf = (def) => (Array.isArray(def?.srcs) && def.srcs.length
  ? def.srcs.filter(Boolean)
  : (def?.src ? [def.src] : []));

/** Every event that plays a given voice — the sharing this panel refuses to hide. */
function eventsUsingVoice(voice) {
  return Object.keys(CONFIG.feedback).filter((e) => CONFIG.feedback[e].sfx === voice);
}

/** Every voice that references a file. Recomputed live, so an assignment shows at once. */
function voicesUsingFile(src) {
  const out = [];
  for (const [id, def] of Object.entries(CONFIG.sfx)) if (srcsOf(def).includes(src)) out.push(id);
  return out;
}

/**
 * Who else claims this file, outside CONFIG.sfx entirely.
 *
 * The ambient bed holds eight of these and the music slots hold more, and
 * neither goes through a voice. Counting only voice references reports them as
 * unused — and "unused" here is a delete button, so getting this wrong is not
 * cosmetic.
 */
function nonVoiceUsersOfFile(src) {
  const out = [];
  if ((CONFIG.ambient?.srcs ?? []).includes(src)) out.push('ambient bed');
  if ((CONFIG.music?.defaultSrc ?? []).includes(src)) out.push('music slot');
  return out;
}

const changed = () => saveTuningToStorage();

// ---------------------------------------------------------------------------
// the goo
//
// Two different fields are spelled `goo` and they do different work, which is
// the one thing to hold on to in here: an EVENT's `goo` names a second emitter
// to fire (systems/feedback.js), and an EMITTER's `goo` names which surface in
// CONFIG.fx.goo.groups its particles are thresholded against.

const gooGroupNames = () => Object.keys(CONFIG.fx?.goo?.groups ?? {});

/**
 * Which group an emitter's particles land in, or null for an ordinary spray.
 *
 * `goo: true` means the FIRST group — the default surface, which is what the
 * whole feature was before groups existed. Both spellings are live in the
 * emitter table, so both are resolved here or the panel reports a substance
 * that nothing feeds.
 */
function gooGroupOf(name) {
  const g = name ? CONFIG.emitters[name]?.goo : null;
  if (!g) return null;
  return g === true ? (gooGroupNames()[0] ?? null) : g;
}

/** Every emitter that feeds one group, `goo: true` included. */
const gooEmitters = (group) => Object.keys(CONFIG.emitters)
  .filter((k) => gooGroupOf(k) === group)
  .sort();

/**
 * Every event that fires an emitter, through EITHER slot.
 *
 * The spray and the goo are two fields naming one table, so an emitter used as
 * one event's spray and another's goo is shared exactly as hard as two sprays
 * are — and the shared-burst warning has to say so.
 */
const eventsFiringEmitter = (name) => Object.keys(CONFIG.feedback)
  .filter((e) => CONFIG.feedback[e].emit === name || CONFIG.feedback[e].goo === name);

// ---------------------------------------------------------------------------
// controls

function slider(host, label, { min = 0, max = 1, step = 0.01, dp = 2, get, set, dead = false, title = '' }) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f' + (dead ? ' dead' : '');
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = dead ? 'Ignored — a loaded sample replaces the synth entirely' : (title || label);
  const input = document.createElement('input');
  input.type = 'range';
  input.autocomplete = 'off';
  input.min = min; input.max = max; input.step = step;
  input.value = get();
  input.disabled = dead;
  const num = document.createElement('input');
  num.className = 'sv-wb-num';
  num.autocomplete = 'off';
  num.value = Number(get()).toFixed(dp);
  const push = (v) => { set(Number(v)); changed(); };
  input.addEventListener('input', () => { num.value = Number(input.value).toFixed(dp); push(input.value); });
  // Typed entry as well as the track. A slider is for feel; a number is for
  // "the same as that other one", and half of tuning is the second thing.
  num.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Number(num.value) || 0));
    num.value = v.toFixed(dp);
    input.value = v;
    push(v);
  });
  row.append(lab, input, num);
  host.appendChild(row);
  return row;
}

// Levels are stored linear and shown in dB, for the reason the old Sound tab
// gives: a linear track wastes almost all its travel, and several samples in
// the bank are authored 20dB below the rest.
function dbSlider(host, label, { get, set }) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = `${label} — in dB. 0 is unity; the stored value is a linear multiplier.`;
  const input = document.createElement('input');
  input.type = 'range';
  input.autocomplete = 'off';
  input.min = DB_FLOOR; input.max = 24; input.step = 0.5;
  const num = document.createElement('input');
  num.className = 'sv-wb-num';
  num.autocomplete = 'off';
  const show = () => {
    const g = get();
    const db = Math.min(24, gainToDb(g));
    input.value = db;
    num.value = g > 0 ? `${db >= 0 ? '+' : ''}${db.toFixed(1)}` : 'off';
    num.title = `x${Number(g).toFixed(3)}`;
  };
  show();
  input.addEventListener('input', () => { set(dbToGain(Number(input.value))); show(); changed(); });
  num.addEventListener('change', () => {
    const db = Number(String(num.value).replace('+', ''));
    if (Number.isFinite(db)) { set(dbToGain(Math.min(24, Math.max(DB_FLOOR, db)))); changed(); }
    show();
  });
  row.append(lab, input, num);
  host.appendChild(row);
}

function card(host, cls, title, sub) {
  const el = document.createElement('div');
  el.className = `sv-wb-card ${cls}`;
  el.innerHTML = `<h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}`;
  host.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// the rail

function railRow(id) {
  const def = CONFIG.feedback[id];
  const el = document.createElement('div');
  el.className = 'sv-wb-ev' + (id === current ? ' sv-wb-on-row' : '');
  const dots = document.createElement('div');
  dots.className = 'sv-wb-dots';
  const has = [!!def.sfx, !!def.haptic, !!(def.shake || def.glow || def.emit || def.ripple)];
  ['s', 'h', 'i'].forEach((k, i) => {
    const d = document.createElement('div');
    d.className = 'sv-wb-dot' + (has[i] ? ` ${k}` : '');
    dots.appendChild(d);
  });
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = id;
  el.append(dots, nm);
  el.addEventListener('click', () => { current = id; render(); });
  return el;
}

function renderRail() {
  const list = els.list;
  const filter = els.search.value.trim().toLowerCase();
  list.replaceChildren();

  const g = document.createElement('div');
  g.className = 'sv-wb-ev' + (current === '*global' ? ' sv-wb-on-row' : '');
  g.innerHTML = '<span class="nm" style="font-weight:600">⚙ Global shaping</span>';
  g.addEventListener('click', () => { current = '*global'; render(); });
  list.appendChild(g);

  // The goo sits with Global shaping rather than in a section, because it is
  // not any one event's business: nine substances, fed by two dozen emitters
  // and fired by events, by systems and by the splash menu's own buttons.
  // Matched on a bag of words like the explosion is — its id is a symbol nobody
  // would type — so a filter that has nothing to do with it hides it.
  if (!filter || GOO_TERMS.includes(filter)) {
    const go = document.createElement('div');
    go.className = 'sv-wb-ev' + (current === GOO_ROW ? ' sv-wb-on-row' : '');
    go.innerHTML = '<span class="nm" style="font-weight:600">◉ The goo</span>';
    go.title = 'The density pass every wet burst in the game is thresholded through — one surface per substance, and the emitters that feed each.';
    go.addEventListener('click', () => { current = GOO_ROW; render(); });
    list.appendChild(go);
  }

  const all = Object.keys(CONFIG.feedback);
  const placed = new Set(RAIL_SECTIONS.flatMap(([, ids]) => ids).filter((id) => CONFIG.feedback[id]));
  const groups = RAIL_SECTIONS
    .map(([t, ids]) => [t, ids.filter((id) => CONFIG.feedback[id])])
    .concat([['Everything else', all.filter((id) => !placed.has(id))]]);

  let shown = 0;
  for (const [title, ids] of groups) {
    const hits = ids.filter((id) => id.toLowerCase().includes(filter));
    // The explosion rides at the top of the Bosses section. It is matched on a
    // bag of words rather than on its id, which is a symbol nobody would type.
    const boomHere = title === 'Bosses' && (!filter || BOOM_TERMS.includes(filter));
    // ...and the light on the kill rides directly under it, on the same terms.
    const lightHere = title === 'Bosses' && (!filter || LIGHT_TERMS.includes(filter));
    // ...and the card riser rides at the top of the level-up section, on the
    // same terms. See RISER_ROW.
    const riserHere = title === 'The level-up screen' && (!filter || RISER_TERMS.includes(filter));
    // ...and the stream rides at the top of the weapon section, on the same
    // terms again. See JET_ROW.
    const jetHere = title === 'Your weapon' && (!filter || JET_TERMS.includes(filter));
    // ...and the bolt sits under it, in the same section, on the same terms.
    // See LASER_ROW.
    const laserHere = title === 'Your weapon' && (!filter || LASER_TERMS.includes(filter));
    // ...and the bed's two loop voices under the stream they belong to. See
    // LOOP_ROWS — they are voices, not events, so nothing else would list them.
    const loopsHere = title === 'Your weapon' && (!filter || LOOP_TERMS.includes(filter));
    if (!hits.length && !boomHere && !lightHere && !riserHere && !jetHere && !laserHere && !loopsHere) continue;
    const h = document.createElement('div');
    h.className = 'sv-wb-sec';
    h.textContent = title;
    list.appendChild(h);
    if (boomHere) {
      const b = document.createElement('div');
      b.className = 'sv-wb-ev' + (current === BOOM_ROW ? ' sv-wb-on-row' : '');
      b.innerHTML = '<span class="nm" style="font-weight:600">\u2622 The boss going up</span>';
      b.title = 'The kill explosion — the cloud, its surface, the shockwave and the puff they are all made of.';
      b.addEventListener('click', () => { current = BOOM_ROW; render(); });
      list.appendChild(b);
      shown++;
    }
    if (lightHere) {
      const lr = document.createElement('div');
      lr.className = 'sv-wb-ev' + (current === LIGHT_ROW ? ' sv-wb-on-row' : '');
      lr.innerHTML = '<span class="nm" style="font-weight:600">\u2600 The light on the kill</span>';
      lr.title = 'The hero shaft on the seal and the wash behind the body it beat, raised for the trophy photograph.';
      lr.addEventListener('click', () => { current = LIGHT_ROW; render(); });
      list.appendChild(lr);
      shown++;
    }
    if (riserHere) {
      const r = document.createElement('div');
      r.className = 'sv-wb-ev' + (current === RISER_ROW ? ' sv-wb-on-row' : '');
      r.innerHTML = '<span class="nm" style="font-weight:600">\u2197 The riser under a card</span>';
      r.title = 'The filter sweep under one card falling into its cell, scheduled across exactly how long the fall takes and cut by the landing.';
      r.addEventListener('click', () => { current = RISER_ROW; render(); });
      list.appendChild(r);
      shown++;
    }
    if (jetHere) {
      const jr = document.createElement('div');
      jr.className = 'sv-wb-ev' + (current === JET_ROW ? ' sv-wb-on-row' : '');
      jr.innerHTML = '<span class="nm" style="font-weight:600">\u224b The bubble jet</span>';
      jr.title = 'The snaking stream and the bed that holds under it — the wave, the whip, the overdrive. Held open by hand rather than fired.';
      jr.addEventListener('click', () => { current = JET_ROW; render(); });
      list.appendChild(jr);
      shown++;
    }
    if (laserHere) {
      const lz = document.createElement('div');
      lz.className = 'sv-wb-ev' + (current === LASER_ROW ? ' sv-wb-on-row' : '');
      lz.innerHTML = '<span class="nm" style="font-weight:600">\u2500 The fin laser\u2019s bolt</span>';
      lz.title = 'The body of a bolt \u2014 its length, its glow and the halo around it \u2014 and the colour it takes from whichever element the run is carrying.';
      lz.addEventListener('click', () => { current = LASER_ROW; render(); });
      list.appendChild(lz);
      shown++;
    }
    if (loopsHere) {
      for (const [row, voice] of Object.entries(LOOP_ROWS)) {
        // Skipped rather than shown broken if the voice is ever removed from
        // CONFIG.sfx — a row that opens onto nothing is worse than no row.
        if (!CONFIG.sfx[voice]) continue;
        const lp = document.createElement('div');
        lp.className = 'sv-wb-ev' + (current === row ? ' sv-wb-on-row' : '');
        lp.innerHTML = `<span class="nm">\u25cc ${voice}</span>`;
        lp.title = 'Loop material for the bubble jet\u2019s bed. No event fires it — it is looped as a layer, so this is where to hear it alone and change the file behind it.';
        lp.addEventListener('click', () => { current = row; render(); });
        list.appendChild(lp);
        shown++;
      }
    }
    for (const id of hits) { list.appendChild(railRow(id)); shown++; }
  }

  els.meta.textContent = `${shown} of ${all.length} · `
    + `${all.filter((e) => CONFIG.feedback[e].sfx).length} with sound · `
    + `${all.filter((e) => CONFIG.feedback[e].haptic).length} with rumble`;
}

// ---------------------------------------------------------------------------
// the detail pane

function render() {
  if (!panel) return;
  // See `jetPoll` — the jet view is the one detail pane with a timer behind it.
  if (jetPoll) { clearInterval(jetPoll); jetPoll = null; }
  renderRail();
  // The library is part of the detail view, not a fixed sidebar: its + buttons
  // assign to THIS event's voice, and its rows say which voices use each file.
  // Leaving it out of the re-render was not a stale-label bug, it was a wrong-
  // target bug — the buttons stayed bound to whichever event was selected when
  // the panel opened, so a sample you added to `kill` landed silently on
  // whatever had been showing an hour ago.
  renderLibrary();
  if (current === '*global') return renderGlobal();
  if (current === GOO_ROW) return renderGoo();
  if (current === BOOM_ROW) return renderBoom();
  if (current === LIGHT_ROW) return renderKillLight();
  if (current === RISER_ROW) return renderCardRiser();
  if (current === JET_ROW) return renderBubbleJet();
  if (current === LASER_ROW) return renderFinLaser();
  if (LOOP_ROWS[current]) return renderLoopVoice(LOOP_ROWS[current]);

  const event = current;
  const def = CONFIG.feedback[event];
  if (!def) { current = 'kill'; return render(); }
  const voice = def.sfx;
  const vdef = voice ? CONFIG.sfx[voice] : null;
  const srcs = srcsOf(vdef);
  const sampled = srcs.length > 0;
  // A loaded sample replaces the synth outright (see playSfx), so a voice that
  // has both is showing synth controls that do nothing at all. 24 of 62 voices
  // are in that state.
  const deadSynth = sampled && !!vdef?.type;

  els.name.textContent = event;
  els.via.textContent = `CONFIG.feedback.${event}${voice ? `  →  CONFIG.sfx.${voice}` : ''}`;

  els.chips.replaceChildren();
  const chip = (text, cls = '') => {
    const c = document.createElement('span');
    c.className = `sv-wb-chip ${cls}`;
    c.textContent = text;
    els.chips.appendChild(c);
  };
  if (!voice) chip('silent — no voice', 'warn');
  else chip(sampled ? `${srcs.length} take${srcs.length > 1 ? 's' : ''}` : `synth · ${vdef?.type ?? '?'}`);
  if (deadSynth) chip(`sample wins — ${vdef.type} params are dead`, 'bad');
  const shared = voice ? eventsUsingVoice(voice).filter((e) => e !== event) : [];
  if (shared.length) chip(`voice shared with ${shared.join(', ')}`, 'link');
  if (!def.haptic) chip('no rumble authored', 'warn');
  if (def.sfxMinGap) chip(`throttled — ${(def.sfxMinGap * 1000).toFixed(0)} ms min gap`);
  // The second burst, and which substance it lands in. An emitter in the `goo`
  // slot that is not in a group is legal and fires as an ordinary second spray
  // — almost always a mistake, so it is called out rather than shown as goo.
  if (def.goo) {
    const grp = gooGroupOf(def.goo);
    chip(grp ? `goo · ${def.goo} → ${grp}` : `goo · ${def.goo} — not in a group`, grp ? 'link' : 'bad');
  }

  const cols = els.cols;
  cols.replaceChildren();

  // --- SOUND ---------------------------------------------------------------
  const snd = card(cols, 'sv-wb-snd', 'Sound', voice
    ? (sampled
      ? 'Sampled. playSfx picks a different take each time and never repeats one twice running.'
      : 'Synthesised — this voice has no files, so the fields below are the whole sound.')
    : 'This event makes no sound at all.');

  const pick = document.createElement('div');
  pick.className = 'sv-wb-f';
  const pickLab = document.createElement('label');
  pickLab.textContent = 'plays voice';
  const pickSel = document.createElement('select');
  pickSel.className = 'sv-wb-sel';
  pickSel.autocomplete = 'off';
  pickSel.style.flex = '1';
  for (const id of ['— silent —', ...Object.keys(CONFIG.sfx).sort()]) {
    const o = document.createElement('option');
    o.value = id; o.textContent = id;
    pickSel.appendChild(o);
  }
  pickSel.value = voice ?? '— silent —';
  pickSel.addEventListener('change', () => {
    def.sfx = pickSel.value === '— silent —' ? null : pickSel.value;
    changed();
    render();
  });
  const fork = document.createElement('button');
  fork.className = 'sv-wb-btn';
  fork.textContent = 'Fork';
  fork.title = 'Copy this voice to a new entry named after the event, so changes stop being heard elsewhere';
  fork.addEventListener('click', () => {
    if (!vdef) return;
    // Named after the EVENT, because the reason to fork is always "this moment
    // should stop sounding like that one".
    let name = event;
    while (CONFIG.sfx[name]) name += '2';
    CONFIG.sfx[name] = JSON.parse(JSON.stringify(vdef));
    def.sfx = name;
    changed();
    render();
  });
  const test = document.createElement('button');
  test.className = 'sv-wb-btn';
  test.textContent = '▶';
  test.title = 'Play this voice alone';
  test.addEventListener('click', () => { unlockAudio(); if (voice) playSfx(voice, 1); });
  pick.append(pickLab, pickSel, fork, test);
  snd.appendChild(pick);

  if (shared.length) {
    const warn = document.createElement('div');
    warn.className = 'sv-wb-scope';
    warn.innerHTML = `Takes and levels here belong to the voice <b>${voice}</b>, not to this event — `
      + `<b>${shared.join(', ')}</b> ${shared.length > 1 ? 'hear' : 'hears'} every change too. Fork to break the tie.`;
    snd.appendChild(warn);
  }

  if (vdef) {
    dbSlider(snd, 'gain', { get: () => vdef.gain ?? 0.2, set: (v) => { vdef.gain = v; } });
    slider(snd, 'pitch var', { max: 0.5, get: () => vdef.pitchVary ?? 0, set: (v) => { vdef.pitchVary = v; } });
    if (vdef.filter != null) {
      slider(snd, 'filter', { min: 80, max: 6000, step: 20, dp: 0, get: () => vdef.filter, set: (v) => { vdef.filter = v; } });
      slider(snd, 'filter var', { max: 0.6, get: () => vdef.filterVary ?? 0, set: (v) => { vdef.filterVary = v; } });
    }
    if (vdef.freq) {
      slider(snd, 'freq lo', { min: 20, max: 2000, step: 5, dp: 0, dead: deadSynth, get: () => vdef.freq[0], set: (v) => { vdef.freq = [v, vdef.freq[1]]; } });
      slider(snd, 'freq hi', { min: 20, max: 2000, step: 5, dp: 0, dead: deadSynth, get: () => vdef.freq[1], set: (v) => { vdef.freq = [vdef.freq[0], v]; } });
    }
    if (vdef.decay != null) slider(snd, 'decay', { max: 1.5, dead: deadSynth, get: () => vdef.decay, set: (v) => { vdef.decay = v; } });
    if (vdef.noise != null) slider(snd, 'noise mix', { dead: deadSynth, get: () => vdef.noise, set: (v) => { vdef.noise = v; } });
    if (vdef.detune != null) slider(snd, 'detune', { max: 80, step: 1, dp: 0, dead: deadSynth, get: () => vdef.detune, set: (v) => { vdef.detune = v; } });

    const takes = document.createElement('div');
    takes.className = 'sv-wb-takes';
    srcs.forEach((src) => {
      const row = document.createElement('div');
      row.className = 'sv-wb-take';
      const fn = document.createElement('span');
      fn.className = 'fn';
      fn.textContent = src.split('/').pop();
      fn.title = src;
      const play = document.createElement('button');
      play.className = 'sv-wb-btn';
      play.textContent = '▶';
      play.title = 'Play just this take';
      play.addEventListener('click', () => auditionFile(src, vdef.gain ?? 0.3));
      const del = document.createElement('button');
      del.className = 'sv-wb-btn';
      del.textContent = '×';
      del.title = 'Take this file out of the set — the file stays in the library';
      del.addEventListener('click', async () => {
        vdef.srcs = srcs.filter((s) => s !== src);
        vdef.src = null;
        changed();
        await reloadSample(voice);
        render();
      });
      row.append(fn, play, del);
      takes.appendChild(row);
    });
    snd.appendChild(takes);

    // Adding a take, all three ways it can happen. Drag-and-drop alone was not
    // enough: it is invisible unless you already know it is there, and it
    // cannot be reached from a file dialog at all.
    const addFiles = async (files) => {
      drop.textContent = 'uploading…';
      for (const file of files) {
        const src = await uploadAsset('sfx', file);
        if (!src) { drop.textContent = `${file.name} — no dev server, not saved`; continue; }
        if (!Array.isArray(vdef.srcs)) vdef.srcs = vdef.src ? [vdef.src] : [];
        if (!vdef.srcs.includes(src)) vdef.srcs.push(src);
        vdef.src = null;
      }
      changed();
      await reloadSample(voice);
      await loadLibrary();
      render();
    };

    const pickRow = document.createElement('div');
    pickRow.className = 'sv-wb-f';
    const pickLabel = document.createElement('label');
    pickLabel.textContent = 'add takes';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      if (files.length) await addFiles(files);
    });
    const upBtn = document.createElement('button');
    upBtn.className = 'sv-wb-btn';
    upBtn.textContent = 'Upload…';
    upBtn.title = 'Choose audio files — saved into public/sfx and added to this voice';
    upBtn.addEventListener('click', () => fileInput.click());
    const libHint = document.createElement('span');
    libHint.style.cssText = 'font-size:10px;color:rgba(232,236,243,0.38)';
    libHint.textContent = 'or + one from the Library →';
    pickRow.append(pickLabel, upBtn, fileInput, libHint);
    snd.appendChild(pickRow);

    const drop = document.createElement('div');
    drop.className = 'sv-wb-drop';
    drop.textContent = sampled
      ? '…or drop files here to add takes'
      : '…or drop files here to replace the synth';
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      await addFiles([...(e.dataTransfer?.files ?? [])]);
    });
    snd.appendChild(drop);
  }

  // --- RUMBLE --------------------------------------------------------------
  const pulses = describeHaptic(def.haptic);
  const hap = card(cols, 'sv-wb-hap', 'Rumble', pulses.length
    ? `Envelope is what the mixer sums — flat while it holds, then the ${CONFIG.haptics.mixing?.release ?? 70} ms release tail that lets repeats fuse into a bed.`
    : 'Nothing authored. Moving anything here seeds a pattern.');

  if (pulses.length) hap.appendChild(pulseSvg(pulses));

  // Writing any field converts the event to explicit pulses, carrying the
  // resolved values across — so a legacy millisecond pattern keeps its exact
  // feel at the moment you start editing it instead of snapping to a default.
  const toExplicit = () => {
    const p = describeHaptic(def.haptic);
    if (!p.length) return [{ duration: 30, magnitude: 0.5, delay: 0 }];
    // `gap`, never `delay`: delay is absolute, and writing it back re-adds the
    // previous pulse's duration on every edit, walking the tail later each time.
    return p.map((q) => ({ duration: q.duration, magnitude: q.resolved, delay: q.gap }));
  };
  const writePulse = (i, field, v) => {
    const next = toExplicit();
    while (next.length <= i) next.push({ duration: 0, magnitude: 0.3, delay: 0 });
    next[i][field] = v;
    if (i === 1 && field === 'duration' && v <= 0) next.length = 1;
    def.haptic = next;
    changed();
  };
  const p0 = () => describeHaptic(def.haptic)[0] ?? { duration: 30, resolved: 0.5 };
  const p1 = () => describeHaptic(def.haptic)[1] ?? { duration: 0, resolved: 0 };

  slider(hap, 'duration', { max: 200, step: 1, dp: 0, get: () => p0().duration, set: (v) => writePulse(0, 'duration', v) });
  slider(hap, 'strength', { get: () => p0().resolved, set: (v) => writePulse(0, 'magnitude', v) });
  slider(hap, 'tail ms', { max: 200, step: 1, dp: 0, get: () => p1().duration, set: (v) => writePulse(1, 'duration', v) });
  slider(hap, 'tail str', { get: () => p1().resolved, set: (v) => writePulse(1, 'magnitude', v) });

  const hapRow = document.createElement('div');
  hapRow.className = 'sv-wb-f';
  const hapLab = document.createElement('label');
  hapLab.textContent = 'enabled';
  const hapBox = document.createElement('input');
  hapBox.type = 'checkbox';
  hapBox.autocomplete = 'off';
  hapBox.checked = pulses.length > 0;
  hapBox.addEventListener('change', () => {
    def.haptic = hapBox.checked ? [{ duration: 30, magnitude: 0.5, delay: 0 }] : null;
    changed();
    render();
  });
  const hapTest = document.createElement('button');
  hapTest.className = 'sv-wb-btn';
  hapTest.textContent = '▶ feel it';
  hapTest.addEventListener('click', () => previewHaptic(def.haptic));
  hapRow.append(hapLab, hapBox, hapTest);
  hap.appendChild(hapRow);

  // --- IMPACT --------------------------------------------------------------
  const imp = card(cols, 'sv-wb-imp wide', 'Impact',
    'The rest of what feedback() fires. Only 7 of the 77 events expose any of this today, scattered through the ` tuner by topic.');
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0 20px';
  const L = document.createElement('div');
  const R = document.createElement('div');
  grid.append(L, R);
  // MUTED EVENTS SAY SO. CONFIG.fx.shakeOnly is a guest list, so most events'
  // shake never reaches the camera — and a slider that moves a number nothing
  // reads is the exact trap this project keeps falling into (the dead
  // `spawnRateMul`, the pace dials). Left EDITABLE rather than disabled: the
  // honest order of work is to set the amount and then decide whether the
  // moment earns the list, and a locked track would make that impossible.
  const shakeMuted = !shakeAllowed(event);
  slider(L, shakeMuted ? 'shake — muted' : 'shake', {
    max: 2,
    title: shakeMuted
      ? `Not in CONFIG.fx.shakeOnly, so this never reaches the camera. Add "${event}" to that list to let it through.`
      : 'On the CONFIG.fx.shakeOnly guest list — this one moves the camera.',
    get: () => def.shake ?? 0,
    set: (v) => { def.shake = v; },
  });
  // Same treatment, same reason — CONFIG.fx.hitstopOnly is the freeze's guest
  // list, and it is shorter than the shake's by design. Also editable while
  // muted, for the same reason.
  const stopMuted = !hitstopAllowed(event);
  slider(L, stopMuted ? 'hit-stop — muted' : 'hit-stop', {
    max: 0.2,
    step: 0.005,
    dp: 3,
    title: stopMuted
      ? `Not in CONFIG.fx.hitstopOnly, so this never freezes the frame. Add "${event}" to that list to let it through.`
      : 'On the CONFIG.fx.hitstopOnly guest list — this one stops the game.',
    get: () => def.hitstop ?? 0,
    set: (v) => { def.hitstop = v; },
  });
  slider(L, 'glow', { max: 2, step: 0.05, get: () => def.glow ?? 0, set: (v) => { def.glow = v; } });
  slider(R, 'ripple hit', { max: 10, step: 0.1, dp: 1, get: () => def.ripple?.strength ?? 0, set: (v) => { (def.ripple ??= { strength: 0, radius: 4 }).strength = v; } });
  slider(R, 'ripple size', { max: 30, step: 1, dp: 0, get: () => def.ripple?.radius ?? 0, set: (v) => { (def.ripple ??= { strength: 0, radius: 4 }).radius = v; } });
  slider(R, 'min gap', { max: 0.5, get: () => def.sfxMinGap ?? 0, set: (v) => { def.sfxMinGap = v; } });
  imp.appendChild(grid);

  const emRow = document.createElement('div');
  emRow.className = 'sv-wb-f';
  const emLab = document.createElement('label');
  emLab.textContent = 'particles';
  const emSel = document.createElement('select');
  emSel.className = 'sv-wb-sel';
  emSel.autocomplete = 'off';
  emSel.style.flex = '1';
  for (const id of ['— none —', ...Object.keys(CONFIG.emitters).sort()]) {
    const o = document.createElement('option');
    o.value = id; o.textContent = id;
    emSel.appendChild(o);
  }
  emSel.value = def.emit ?? '— none —';
  emSel.addEventListener('change', () => {
    def.emit = emSel.value === '— none —' ? null : emSel.value;
    changed();
    render();
  });
  const emTest = document.createElement('button');
  emTest.className = 'sv-wb-btn';
  emTest.textContent = '▶ burst';
  emTest.title = 'Throw this burst on the seal';
  emTest.addEventListener('click', () => { if (def.emit) emit(def.emit, 0, 0); });
  emRow.append(emLab, emSel, emTest);
  imp.appendChild(emRow);

  // THE SECOND BURST. feedback() fires `emit` and `goo` off the one call, on the
  // same `at` and the same death tint — the spray, and the body of liquid under
  // it (systems/feedback.js). Until this row existed the panel could see half of
  // what a kill throws: nine events fire a goo burst and not one of them had a
  // control for it anywhere in the game.
  const gooRow = document.createElement('div');
  gooRow.className = 'sv-wb-f';
  const gooLab = document.createElement('label');
  gooLab.textContent = 'goo';
  gooLab.title = 'A second emitter fired on the same event. Its particles are splatted into a density field and thresholded into one fused body instead of being drawn as separate sprites.';
  const gooSel = document.createElement('select');
  gooSel.className = 'sv-wb-sel';
  gooSel.autocomplete = 'off';
  gooSel.style.flex = '1';
  const gooNone = document.createElement('option');
  gooNone.value = '— none —';
  gooNone.textContent = '— none —';
  gooSel.appendChild(gooNone);
  // Grouped rather than filtered: the field takes ANY emitter and only the
  // flagged ones fuse, so a sprite burst here is legal, occasionally wanted,
  // and never what you meant to pick by accident.
  const allEmitters = Object.keys(CONFIG.emitters).sort();
  for (const [gLabel, ids] of [
    ['fuses — goo', allEmitters.filter((k) => gooGroupOf(k))],
    ['sprites', allEmitters.filter((k) => !gooGroupOf(k))],
  ]) {
    if (!ids.length) continue;
    const og = document.createElement('optgroup');
    og.label = gLabel;
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = gooGroupOf(id) ? `${id} → ${gooGroupOf(id)}` : id;
      og.appendChild(o);
    }
    gooSel.appendChild(og);
  }
  gooSel.value = def.goo ?? '— none —';
  gooSel.addEventListener('change', () => {
    def.goo = gooSel.value === '— none —' ? null : gooSel.value;
    changed();
    render();
  });
  const gooTest = document.createElement('button');
  gooTest.className = 'sv-wb-btn';
  gooTest.textContent = '▶ goo';
  gooTest.title = 'Throw the goo burst on its own, without the spray over it';
  gooTest.addEventListener('click', () => { if (def.goo) emit(def.goo, 0, 0); });
  const gooSurf = document.createElement('button');
  gooSurf.className = 'sv-wb-btn';
  gooSurf.textContent = 'surface →';
  gooSurf.title = 'Open the substance this lands in. It is shared — what you do to it there, you do to everything else made of it.';
  gooSurf.disabled = !gooGroupOf(def.goo);
  gooSurf.addEventListener('click', () => {
    gooGroup = gooGroupOf(def.goo);
    gooShot = def.goo;
    current = GOO_ROW;
    render();
  });
  gooRow.append(gooLab, gooSel, gooTest, gooSurf);
  imp.appendChild(gooRow);

  const fireRow = document.createElement('div');
  fireRow.className = 'sv-wb-f';
  const fireLab = document.createElement('label');
  fireLab.textContent = 'all together';
  const fireBtn = document.createElement('button');
  fireBtn.className = 'sv-wb-btn';
  fireBtn.textContent = '▶ Fire the whole event';
  fireBtn.title = 'The real feedback() — sound, rumble, particles, shake, hit-stop and ripple at once. F closes this panel; the stage bar keeps firing.';
  fireBtn.addEventListener('click', () => {
    unlockAudio();
    stageState.event = event;
    feedback(event, { x: 0, y: 0, scale: stageState.scale });
  });
  fireRow.append(fireLab, fireBtn);
  imp.appendChild(fireRow);

  // --- BURST ---------------------------------------------------------------
  // Both bursts get one, and they are not the same kind of thing: a goo
  // emitter's numbers are the opposite of a spray's — a narrow speed band,
  // heavy drag, single-digit counts, and sizes that are density radii rather
  // than drawn ones — which is exactly why editing one against the other's card
  // was the hole this fills.
  burstCard(cols, def.emit, event);
  if (def.goo && def.goo !== def.emit) burstCard(cols, def.goo, event);
}

// ONE BURST CARD, shared by the event view and the boss explosion.
//
// Extracted rather than copied because these controls are the only UI the
// emitter table has anywhere in the game — the six under the divider have no
// other control at all — and a second copy would be a set of numbers that
// quietly stopped agreeing with the first.
//
// `event` is the feedback event the emitter hangs off, or null for a caller
// that owns its emitter directly: systems/bossBoom.js fires `bossBoom` itself,
// dozens of times per explosion, and no event names it. It is used only for
// the shared-burst warning, which has nothing to say without one.
function burstCard(cols, name, event = null) {
  const edef = name ? CONFIG.emitters[name] : null;
  if (!edef) return;
  const grp = gooGroupOf(name);
  const par = card(cols, 'sv-wb-imp wide', grp ? `Burst · ${name} → ${grp}` : `Burst · ${name}`,
    grp
      ? 'What the particles do. These are thresholded into the group named above rather than drawn as sprites, so the counts are single digits — each particle is a whole lobe of a body — and CONFIG.fx.spriteDensity does not thin them.'
      : 'What the particles do. The six under the divider have no control anywhere else in the game.');
  // BOTH SLOTS. An emitter used as one event's spray and another's goo is shared
  // exactly as hard as two sprays are, and killGoo really is: `kill` and
  // `bigKill` throw the same body of blood.
  const users = eventsFiringEmitter(name).filter((e) => e !== event);
  if (users.length) {
    const w = document.createElement('div');
    w.className = 'sv-wb-scope';
    // The advice only makes sense with an event selected. From the goo view
    // there is no "this event" and no picker above it — the same warning worded
    // as an instruction would be pointing at a control that is not on screen.
    w.innerHTML = event
      ? `Shared burst — <b>${users.join(', ')}</b> throw the same particles. Pick another emitter above to give this event its own.`
      : `Shared burst — thrown by <b>${users.join(', ')}</b>. Everything below is every one of them.`;
    par.appendChild(w);
  }
  const g2 = document.createElement('div');
  g2.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0 20px';
  const A = document.createElement('div');
  const B = document.createElement('div');
  g2.append(A, B);
  slider(A, 'count', { max: 200, step: 1, dp: 0, get: () => edef.count, set: (v) => { edef.count = Math.round(v); } });
  pairSlider(A, 'size', edef.size, 3, 0.01, 2);
  pairSlider(A, 'life', edef.life, 3, 0.01, 2);
  pairSlider(B, 'speed', edef.speed, 40, 0.5, 1);
  slider(B, 'cone', { max: 6.3, step: 0.05, get: () => edef.cone ?? 0, set: (v) => { edef.cone = v; } });
  slider(B, 'glow', { max: 4, step: 0.1, dp: 1, get: () => edef.glow ?? 0, set: (v) => { edef.glow = v; } });
  par.appendChild(g2);
  const div = document.createElement('div');
  div.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08); margin:8px 0 2px';
  par.appendChild(div);
  const g3 = document.createElement('div');
  g3.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0 20px';
  const C = document.createElement('div');
  const D = document.createElement('div');
  g3.append(C, D);
  slider(C, 'drag', { max: 8, step: 0.1, dp: 1, get: () => edef.drag ?? 0, set: (v) => { edef.drag = v; } });
  slider(C, 'inherit', { step: 0.05, get: () => edef.inherit ?? 0, set: (v) => { edef.inherit = v; } });
  slider(D, 'gravity', { min: -6, max: 6, step: 0.1, dp: 1, get: () => (edef.gravity ?? [0, 0])[1], set: (v) => { edef.gravity = [(edef.gravity ?? [0, 0])[0], v]; } });
  par.appendChild(g3);

  // Reach under linear drag — the same closed form particles.js integrates.
  // speed x life is the no-drag answer and is wildly wrong for anything that
  // slows: bigExplosion reads 73 units that way and travels 18.
  const k = Math.max(0.05, edef.drag ?? 0.05);
  const reach = edef.speed[1] * (1 - Math.exp(-k * edef.life[1])) / k;
  const note = document.createElement('div');
  note.className = 'sv-wb-none';
  note.textContent = `Reaches about ${reach.toFixed(1)} world units. The seal is 4.2 across.`;
  par.appendChild(note);

  const colours = document.createElement('div');
  colours.className = 'sv-wb-f';
  colours.innerHTML = '<label>colours</label>';
  (edef.colors ?? []).forEach((c, i) => {
    const sw = document.createElement('input');
    sw.type = 'color';
    sw.autocomplete = 'off';
    sw.value = `#${c.toString(16).padStart(6, '0')}`;
    sw.style.cssText = 'width:30px;height:22px;padding:0;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:none;cursor:pointer';
    sw.addEventListener('input', () => { edef.colors[i] = parseInt(sw.value.slice(1), 16); changed(); });
    colours.appendChild(sw);
  });
  par.appendChild(colours);
}

// A NESTED block on a group — `whitewater`, `medium` — is merged SHALLOW (see
// gooSurface in entities/particles.js): a group that declares one REPLACES the
// shared block outright rather than diffing into it. So the first write forks a
// copy of what was being inherited, or turning one knob quietly drops every
// other key that block had.
function forkedBlock(target, shared, key) {
  if (!target[key]) target[key] = { ...(shared?.[key] ?? {}) };
  return target[key];
}

// The aerated surface. Foam is the only group that uses it today, and the one
// thing worth knowing before touching it is at the top of the card: any
// strength above zero forces ALPHA blending whatever the group says, because
// the whole claim of packed foam is that it hides what is behind it.
function whitewaterCard(cols, target, shared) {
  const w = { ...(shared?.whitewater ?? {}), ...(target.whitewater ?? {}) };
  const own = () => forkedBlock(target, shared, 'whitewater');
  const el = card(cols, 'sv-wb-imp', 'Aerated',
    'Trapped air, drawn from the density itself — thick means packed and white, thin means a veil the colour of the water behind it. Any strength above 0 forces alpha blending, whatever the surface above says.');
  const row = (label, k, fb, opts = {}) => slider(el, label, {
    ...opts,
    get: () => w[k] ?? fb,
    set: (v) => { own()[k] = v; w[k] = v; },
    title: opts.title ?? label,
  });
  row('whitewater', 'strength', 0, { max: 1, step: 0.05,
    title: '0 is the old glow — the group\u2019s plain surface. Above it, the mass is aerated water and blends as alpha.' });
  row('air packs at', 'packedAt', 0.6, { min: 0.1, max: 3, step: 0.05,
    title: 'The density at which the foam is fully white. Low is whiter sooner; high leaves more of the mass as a thin veil.' });
  row('bubble texture', 'bubbles', 0.6, { max: 1.5, step: 0.05 });
  row('...how fine', 'bubbleScale', 1.1, { min: 0.2, max: 4, step: 0.05,
    title: 'Cells per world unit.' });
  row('air rises', 'airRise', 1.4, { max: 6, step: 0.1,
    title: 'Units per second. 0 paints the bubbles on and the whole thing reads as a texture rather than as something happening in water.' });
  const swatch = document.createElement('div');
  swatch.className = 'sv-wb-f';
  const swLab = document.createElement('label');
  swLab.textContent = 'foam colour';
  const sw = document.createElement('input');
  sw.type = 'color';
  sw.autocomplete = 'off';
  sw.value = `#${(w.color ?? 0xffffff).toString(16).padStart(6, '0')}`;
  sw.style.cssText = 'width:30px;height:22px;padding:0;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:none;cursor:pointer';
  sw.addEventListener('input', () => { own().color = parseInt(sw.value.slice(1), 16); changed(); });
  swatch.append(swLab, sw);
  el.appendChild(swatch);
  // On the shared block this is EVERY substance at once, and it is the one
  // place in here where that is easy to do by accident: no group declares a
  // whitewater of its own today, so the rows all read as empty and inviting.
  if (!shared) {
    const n = document.createElement('div');
    n.className = 'sv-wb-none';
    n.textContent = 'Shared: this is every substance in the game. A group that declares its own replaces the whole block rather than diffing into it.';
    el.appendChild(n);
  }
  return el;
}

// Where the goo sits relative to the ocean and the air. Per group on purpose:
// blood in the water should recede with depth exactly as foam does, and the
// boss's explosion is a cel-drawn cloud that hazing would only turn grey.
function mediumCard(cols, target, shared) {
  const m = { ...(shared?.medium ?? {}), ...(target.medium ?? {}) };
  const own = () => forkedBlock(target, shared, 'medium');
  const el = card(cols, 'sv-wb-imp', 'In the water',
    'Whether the ocean closes over this substance or it lies on the finished frame. Both are free at 0 \u2014 the shader skips the whole depth solve when neither is asked for.');
  const row = (label, k, fb, opts = {}) => slider(el, label, {
    ...opts,
    get: () => m[k] ?? fb,
    set: (v) => { own()[k] = v; m[k] = v; },
    title: opts.title ?? label,
  });
  row('the ocean closes over it', 'murk', 0, { max: 1, step: 0.05 });
  row('...over how far down', 'murkReach', 7, { min: 1, max: 20, step: 0.5, dp: 1,
    title: 'World units below the wave, not below the camera \u2014 the ramp is measured from the surface the goo broke.' });
  row('the horizon haze in front', 'fog', 0, { max: 1, step: 0.05 });
  // On the shared block this is EVERY substance at once, and it is the one
  // place in here where that is easy to do by accident: no group declares a
  // medium of its own today, so the rows all read as empty and inviting.
  if (!shared) {
    const n = document.createElement('div');
    n.className = 'sv-wb-none';
    n.textContent = 'Shared: this is every substance in the game. A group that declares its own replaces the whole block rather than diffing into it.';
    el.appendChild(n);
  }
  return el;
}

// ---------------------------------------------------------------------------
// THE GOO — the second view here that is not an event.
//
// A goo group is a SUBSTANCE. Particles flagged `goo: <group>` are splatted as
// soft density into an offscreen field and that field is thresholded at an
// isoline, so near neighbours FUSE instead of overlapping as separate discs
// (entities/particles.js writes it, systems/post.js finds the surface). Nine of
// them, fed by two dozen emitters, thrown by events, by systems and by the
// splash menu — which is precisely why none of it could live on an event row.
//
// WHAT WAS HERE BEFORE: one group, `boom`, inside the explosion's own view,
// because that is the effect that happened to need it. Everything else in the
// pass — the blood a kill leaves, the foam off a breach, a burning hull's
// smoke, the ichor out of a weak spot — was tuned by editing config.js.
//
// THE ONE RULE THIS VIEW IS BUILT AROUND: a group is a DIFF against
// CONFIG.fx.goo's own keys, so most rows in most groups are showing a number
// that belongs to everything. Those rows are marked, and nothing is written
// until a handle moves. See surfaceCard.
// ---------------------------------------------------------------------------

function renderGoo() {
  const g = CONFIG.fx?.goo;
  els.name.textContent = 'The goo';
  els.via.textContent = 'CONFIG.fx.goo  →  .groups  →  the emitters that feed them';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();

  const names = gooGroupNames();
  if (!g || !names.length) {
    card(cols, 'sv-wb-imp wide', 'Not in this build',
      'CONFIG.fx.goo has no groups in it, so there is no substance to tune.');
    return;
  }
  if (gooGroup !== GOO_SHARED && !names.includes(gooGroup)) gooGroup = names[0];
  const showing = gooGroup === GOO_SHARED ? null : gooGroup;
  const feeds = showing ? gooEmitters(showing) : [];
  // The Burst card follows the group. Re-picked rather than remembered across
  // groups, or it points at an emitter that is made of something else.
  if (!feeds.includes(gooShot)) gooShot = feeds[0] ?? null;

  const chip = (text, cls = '') => {
    const c = document.createElement('span');
    c.className = `sv-wb-chip ${cls}`;
    c.textContent = text;
    els.chips.appendChild(c);
  };
  if (showing) {
    chip(`${feeds.length} emitter${feeds.length === 1 ? '' : 's'} feed it`, feeds.length ? '' : 'warn');
    if (showing === names[0]) chip('`goo: true` lands here', 'link');
    const own = Object.keys(g.groups[showing] ?? {}).length;
    chip(own ? `${own} of its own, the rest shared` : 'inherits the shared surface entirely');
    if (g.enabled === false) chip('the pass is off — these draw as sprites', 'bad');
  } else {
    chip(`the block all ${names.length} groups are a diff against`, 'link');
  }

  // --- WHICH SUBSTANCE -------------------------------------------------------
  const which = card(cols, 'sv-wb-imp wide', 'Which substance',
    'One group per substance, and the split is not cosmetic: everything inside a group SUMS, so two sharing one would weld to each other — a kill at the water line would grow a neck into the seal\u2019s foam. Order is composite order; a later group lands on top of an earlier one.');
  const pills = document.createElement('div');
  pills.className = 'sv-wb-pills';
  pills.style.flexWrap = 'wrap';
  const pill = (key, label, title) => {
    const el = document.createElement('span');
    el.className = 'sv-wb-pill' + (gooGroup === key ? ' on' : '');
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', () => { gooGroup = key; gooShot = null; render(); });
    pills.appendChild(el);
  };
  pill(GOO_SHARED, 'shared default',
    'CONFIG.fx.goo\u2019s own surface keys — what every group inherits where it says nothing itself.');
  for (const n of names) {
    const fed = gooEmitters(n);
    pill(n, n, fed.length ? `fed by ${fed.join(', ')}` : 'nothing in the emitter table feeds this');
  }
  which.appendChild(pills);
  const wNote = document.createElement('div');
  wNote.className = 'sv-wb-none';
  wNote.textContent = showing
    ? (feeds.length
      ? `${showing} — thrown by ${feeds.join(', ')}.`
      : `${showing} — nothing in the emitter table lands here. Either a system splats it directly (see registerGooField) or it is dead weight.`)
    : 'Everything below moves every group that has not overridden it. `blood` declares nothing at all, so this IS blood\u2019s surface.';
  which.appendChild(wNote);

  // --- THE PASS --------------------------------------------------------------
  const pass = card(cols, 'sv-wb-imp', 'The pass',
    'One buffer the groups take turns in, and it only runs on frames with something alive in it. A group nothing is emitting into costs nothing at all.');
  toggle(pass, 'goo', () => g.enabled, (v) => { g.enabled = v; },
    'Off, the flagged particles draw as ordinary sprites — the burst is not deleted, it stops fusing. That is the A/B for whether the pass is earning its 0.34 ms.');
  slider(pass, 'coarseness', {
    min: 1, max: 6, step: 1, dp: 0,
    get: () => g.divisor ?? 2,
    set: (v) => {
      g.divisor = Math.round(v);
      // The one row in this panel that is not picked up on the next frame: the
      // field is sized when the post chain is, so without this it reads as a
      // dead slider until the window is resized.
      onTuned?.('fx.goo.divisor');
    },
    title: 'Resolution divisor for the density field, and therefore the SOFTNESS of the surface — the isoline is found on a bilinear upsample, so a coarser field is a wobblier, more molten edge. 2 reads as surface tension; much coarser reads as a low-resolution image of goo.',
  });
  const pNote = document.createElement('div');
  pNote.className = 'sv-wb-none';
  pNote.textContent = 'Shared by every group — it sizes the one buffer they take turns in.';
  pass.appendChild(pNote);

  // --- THE SURFACE -----------------------------------------------------------
  // The shared card. `target` is the group's own diff (created on first write,
  // never on render) or, for the first pill, the block they all diff against.
  surfaceCard(cols, showing ? (g.groups[showing] ??= {}) : g, {
    title: showing ? `Its surface · ${showing}` : 'The shared surface',
    shared: showing ? g : null,
    sub: showing
      ? 'What this substance looks like where it is thick, where it ends and how it catches the light. Never a size: a mass is made bigger by scaling the emitter\u2019s size and speed together, below. Rows in italic blue are the shared value — move one and this group takes a copy of its own.'
      : 'Every group starts from these, and most of them keep most of them. Moving anything here moves every substance in the game that has not overridden it.',
  });

  // --- THE NESTED BLOCKS -----------------------------------------------------
  // Not rows on the surface card: they are objects, and a group either has one
  // or inherits the whole thing. Shown for every group rather than only for the
  // one using them today — a substance that should sink into the water is a
  // decision, not a property of being foam.
  const surfaceTarget = showing ? g.groups[showing] : g;
  whitewaterCard(cols, surfaceTarget, showing ? g : null);
  mediumCard(cols, surfaceTarget, showing ? g : null);

  // --- WHAT FEEDS IT ---------------------------------------------------------
  if (showing) {
    const feed = card(cols, 'sv-wb-imp', 'What feeds it',
      'The emitters whose particles are thresholded against this surface. Pick one to put it under the Burst card below, or throw it at the parked seal.');
    if (!feeds.length) {
      const none = document.createElement('div');
      none.className = 'sv-wb-none';
      none.textContent = 'Nothing. This group is either splatted by a system directly or unused.';
      feed.appendChild(none);
    }
    const list = document.createElement('div');
    list.className = 'sv-wb-takes';
    for (const name of feeds) {
      const row = document.createElement('div');
      row.className = 'sv-wb-take';
      const nm = document.createElement('span');
      nm.className = 'fn';
      nm.textContent = name;
      const evs = eventsFiringEmitter(name);
      nm.title = evs.length
        ? `fired by ${evs.join(', ')}`
        : 'no feedback event names it — a system fires this one directly';
      const pick = document.createElement('button');
      pick.className = 'sv-wb-btn';
      pick.textContent = name === gooShot ? 'editing' : 'edit';
      pick.disabled = name === gooShot;
      pick.addEventListener('click', () => { gooShot = name; render(); });
      const fire = document.createElement('button');
      fire.className = 'sv-wb-btn';
      fire.textContent = '▶';
      fire.title = 'Throw this burst on the parked seal';
      fire.addEventListener('click', () => {
        const a = stageAnchor();
        emit(name, a.x, a.y);
      });
      row.append(nm, pick, fire);
      list.appendChild(row);
    }
    feed.appendChild(list);
  }

  // --- THE BURST -------------------------------------------------------------
  // The ordinary emitter card, on whichever emitter is selected above. The
  // surface is how the mass LOOKS; this is what is thrown into it.
  if (gooShot) burstCard(cols, gooShot);
}

// ---------------------------------------------------------------------------
// THE BOSS GOING UP — the first view here that was not an event.
//
// systems/bossBoom.js fires `bossBoom` itself, dozens of times per explosion,
// each call with its own size, speed, colour and glow — so there is no
// feedback event to hang it off and no `emit` field to pick it from. It gets
// its own view instead, and the same Burst card everything else gets, because
// the puff those dozens of calls throw IS an ordinary emitter row.
//
// WHY IT IS HERE AND NOT IN THE ` TUNER. It was there first, filed under
// 'Look & FX', and that is the correct shelf for it and the wrong panel: this
// is where the particles are, this is the panel with a parked seal and a Fire
// button in front of it, and an effect you cannot fire while you tune it is an
// effect you tune by killing bosses.
// ---------------------------------------------------------------------------

// A checkbox row. `get() !== false` rather than a truth test, because most of
// what this switches is a config flag whose absence means ON.
function toggle(host, label, get, set, title) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f';
  const lab = document.createElement('label');
  lab.textContent = label;
  if (title) lab.title = title;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.autocomplete = 'off';
  box.checked = get() !== false;
  box.addEventListener('change', () => { set(box.checked); changed(); render(); });
  row.append(lab, box);
  host.appendChild(row);
  return row;
}

// ---------------------------------------------------------------------------
// ONE SURFACE CARD, shared by the goo view and the boss explosion.
//
// The rows are the keys of CONFIG.fx.goo's surface block, and a GROUP is a DIFF
// against it — so `target` is what a moved handle writes into and `shared` is
// what an untouched row is reading.
//
// NOTHING IS WRITTEN UNTIL A HANDLE MOVES. A row that painted its displayed
// value into the group on render would turn every inherited number into an
// override — a panel silently forking a preset it only meant to show, which is
// a bug the ` tuner shipped once already. Inherited rows are MARKED instead.
function surfaceCard(cols, target, { title = 'Its surface', sub = '', shared = null, notes = {} } = {}) {
  const el = card(cols, 'sv-wb-imp', title, sub);
  const read = (k, fb) => target[k] ?? shared?.[k] ?? fb;
  const mark = (row, k) => {
    if (shared && target[k] === undefined) {
      row.classList.add('sv-wb-inh');
      row.title = 'Inherited from the shared surface — moving it gives this group its own.';
    }
    return row;
  };
  const row = (label, k, fb, opts = {}) => mark(slider(el, label, {
    ...opts,
    get: () => read(k, fb),
    set: (v) => { target[k] = v; },
    title: notes[k] ?? opts.title ?? label,
  }), k);

  mark(toggle(el, 'light, not substance', () => !!read('additive', false),
    (v) => { target.additive = v; },
    notes.additive ?? 'Additive lays light INTO the water; alpha hides what is behind it — the only way a lobe can be darker than the ocean it is in.'), 'additive');
  row('opacity', 'opacity', 1, { max: 1, step: 0.02 });
  row('surface', 'iso', 0.9, { min: 0.15, max: 1.2, step: 0.02,
    title: 'Where the isoline sits, in accumulated density. A single splat peaks at exactly 1 by construction, so at or above it NOTHING shows unless two lobes overlap — right for a burst thrown from one point, empty for anything spread out.' });
  row('edge', 'soft', 0.22, { min: 0.02, max: 0.8, step: 0.01,
    title: 'Half-width of the transition, in density. Small is a hard wet edge and a cel read; large is mist, and stops reading as liquid at all.' });
  row('rim', 'rim', 0.75, { min: -1.5, max: 1.5, step: 0.05,
    title: 'The wet edge — a band just inside the surface, brightened. Negative darkens it instead, which is how the cel outline is drawn, and which additive light cannot do.' });
  row('...how far in', 'rimWidth', 0.7, { min: 0.05, max: 2, step: 0.05,
    title: 'A band of DENSITY, not a distance. Wide on an additive surface it lights the dip between every pair of lobes, and one mass renders as fifty overlapping circles.' });
  row('highlight', 'spec', 0.55, { max: 1.5, step: 0.02,
    title: 'Lit off the density gradient, which points out of the goo and so serves as a normal. Most of what separates "viscous" from "flat silhouette" — and it is WETNESS, so the dry substances set it to 0.' });
  row('...how tight', 'specPower', 16, { min: 1, max: 64, step: 1, dp: 0 });
  row('...surface relief', 'normal', 6, { max: 12, step: 0.1, dp: 1,
    title: 'How steeply the gradient is read as a normal. High is a fat rounded body; low is a flat sheet with a highlight lying on it.' });
  row('lit from x', 'lightX', -0.5, { min: -1, max: 1, step: 0.05 });
  row('...and y', 'lightY', 0.85, { min: -1, max: 1, step: 0.05 });
  row('lobe size', 'radius', 3.4, { min: 1, max: 8, step: 0.1, dp: 1,
    title: 'Splat diameter, as a multiple of each particle\u2019s own size. THE control that decides whether anything fuses at all — below about 2 a burst is a group of separate droplets. Not a way to make a mass bigger: for that, scale the emitter\u2019s size and speed together.' });
  return el;
}

// ---------------------------------------------------------------------------
// THE CARD RISER — the buildup under one card falling into its cell.
//
// The point of the view is that ONE number here is not a number: the length of
// the sweep is `upgradeSlam.time`, read live, and there is no slider for it in
// this card because there must not be two. The fall's length is a property of
// the animation, and the riser's job is to agree with it. So the length is
// shown as a readout, and the fall itself is tuned where the fall is tuned.
// ---------------------------------------------------------------------------
// THE BUBBLE JET
// ---------------------------------------------------------------------------
// Three things in one view because they are one object to the player: the SHAPE
// (a whip carrying a travelling wave), the LIGHT it is made of, and the BED
// underneath it. Splitting them across a tuner group and a sound tab is exactly
// the arrangement this whole panel exists to undo — you cannot judge how thick
// the stream should be while the sound telling you how much power it has is
// two panels away.
//
// THE THROUGHPUT IS NOT HERE, and says so out loud. Damage, reach, uptime and
// cadence are weapons.csv's, because those are read against the rest of the
// arsenal over a whole run and a slider is the wrong instrument for that
// comparison. A readout rather than nothing, so the numbers the stream you are
// looking at is actually carrying are visible while you look at it.
// ---------------------------------------------------------------------------
// THE FIN LASER'S BOLT
//
// One view because a bolt is one object to the player: a SHAPE (long and thin,
// lying along its own travel), the LIGHT it is made of, and the COLOUR it takes
// from the run. Splitting those across a tuner group and a config block is the
// arrangement this whole panel exists to undo — you cannot judge how long a
// bolt should be while the overdrive deciding whether it blooms at all is
// somewhere you have to go and find.
//
// THE THROUGHPUT IS NOT HERE, and says so out loud. Speed, reach, the reach
// ramp and every count in Lattice Sealant are weapons.csv's, because those are
// read against the pebble gun and the rest of the arsenal over a whole run and
// a slider is the wrong instrument for that comparison. What IS here is a
// readout of the numbers the run in front of you is actually carrying, so you
// are not judging a bolt while guessing which one it is.
//
// EVERY HANDLE REACHES THE BOLTS ALREADY IN THE AIR. redressBolts re-dresses
// the live shots on each change — without it a length slider only touches the
// next bolt fired, which at this cadence means judging a change against a
// screen still half full of the old one.
// ---------------------------------------------------------------------------

function renderFinLaser() {
  const c = CONFIG.finLaser;
  els.name.textContent = 'The fin laser’s bolt';
  els.via.textContent = 'CONFIG.finLaser.look  →  systems/finLaser.js';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();
  if (!c) {
    card(cols, 'sv-wb-imp wide', 'Not in this build',
      'CONFIG.finLaser is missing, so there is nothing to tune.');
    return;
  }
  const l = (c.look ??= {});

  // Redress on every change rather than only on the ones that move geometry:
  // the colour and the overdrive both pick a different cached material, and a
  // bolt in the air holds the one it was born with.
  const touched = () => { changed(); redressBolts(projectiles); };

  // The redress rides in `set` rather than being wired to each row, because
  // slider() calls set() and then changed() — so a row that only wrote the
  // config would move the number and leave every bolt in the air wearing the
  // old one, which is exactly the two-panels-away problem the view exists to
  // fix, reproduced inside the view.
  const row = (host, label, key, fb, opts = {}) => slider(host, label, {
    ...opts,
    get: () => l[key] ?? fb,
    set: (v) => { l[key] = v; redressBolts(projectiles); },
    title: opts.title ?? label,
  });

  // --- WHAT THIS RUN IS CARRYING --------------------------------------------
  // A readout and not a control, and the distinction is the point of the card:
  // a bolt's length is a taste question and its reach is not, so the numbers
  // that decide whether you are looking at a laser at all are shown rather than
  // offered. See the header.
  const state = card(cols, 'sv-wb-imp', 'This run',
    'Read-only. The bolt’s throughput is <b>weapons.csv</b> — speed, reach, the ramp and every count in the shatter are judged against the pebble gun over a run, which is a spreadsheet question rather than a slider one.');
  const num = document.createElement('div');
  num.className = 'sv-wb-none';
  const refreshState = () => {
    const s = player?.stats ?? {};
    const on = isLaser(s.loadout);
    const steps = laserReachSteps(player?.upgrades ?? [], player?.bossesDefeated ?? 0);
    const gens = latticeGenerations(s.pierce ?? 0);
    num.innerHTML = on
      ? `Firing <b>bolts</b>. Reach <b>${steps}/${c.reachStepsMax ?? 0}</b> steps `
        + `(&times;${(1 + steps * (c.reachStepMul ?? 0)).toFixed(2)} flight)<br>`
        + `Lattice: <b>${childrenAt(0, s.latticeAmount ?? 0)}</b> wide, `
        + `<b>${gens}</b> deep — worst case <b>${latticeWorstCase(s.latticeAmount ?? 0, gens)}</b> shards `
        + `off one bolt, budget <b>${c.lattice?.budget ?? '—'}</b> (<b>${latticeLiveChildren()}</b> live)`
      : `Firing <b>pebbles</b>. The sliders below still work — they are the bolt’s look, `
        + `not this run’s — but nothing on screen is wearing them. `
        + `<code>?loadout=laser</code> forces the roll.`;
  };
  refreshState();
  state.appendChild(num);

  // --- THE BODY -------------------------------------------------------------
  const body = card(cols, 'sv-wb-imp', 'Its body',
    'Multipliers on whatever size the shot already is, so Flippers Up! and the shatter’s own falloff still move a bolt. At 1 by 1 the laser is a glowing pebble — the elongation <em>is</em> the silhouette.');
  row(body, 'length', 'length', 2.6, { min: 0.5, max: 8, step: 0.1, dp: 1,
    title: 'Along its own direction of travel — the asset is stretched on art-forward Y and the shot is spawned `orient: true`, so this reads as length however the seal is aiming. Long and thin is what separates a bolt from a bead of light.' });
  row(body, 'width', 'width', 0.45, { min: 0.05, max: 2, step: 0.05,
    title: 'Across it. It moves the drawn body only — the HIT circle is the gun’s `radius`, in weapons.csv, so a bolt thinned to a hair still connects exactly as a pebble does. That is deliberate: the reach is this loadout’s cost and the hitbox is not.' });

  // --- THE LIGHT ------------------------------------------------------------
  const light = card(cols, 'sv-wb-imp', 'The light it is made of',
    'A bolt is mostly glow, and the bright pass thresholds on <b>luminance</b> — where blue counts for 7% and green for 72%. The overdrive normalises on the colour’s <em>peak channel</em> before scaling, which is the only reason a blue bolt and a green one bloom alike.');
  row(light, 'overdrive', 'overdrive', 2.2, { min: 0.5, max: 6, step: 0.1, dp: 1,
    title: 'How far past 1 the body is pushed on its peak channel. Under about 1.2 nothing crosses the bright pass and the bolt is a flat shape; far above it every element is pinned white and the colour stops carrying.' });
  row(light, 'halo', 'glow', 2.4, { min: 0, max: 8, step: 0.1, dp: 1,
    title: 'The sprite around the body, in bolt-widths. A sprite rather than a second mesh so it stays round however the bolt is turned — a quad would go edge-on and blink out for a whole heading. 0 leaves the bare body.' });
  row(light, '...its own overdrive', 'glowOverdrive', 0.6, { min: 0.1, max: 2, step: 0.05,
    title: 'As a fraction of the body’s. Keep it below 1: a halo that outshines what it surrounds is a smudge with no bolt in it. With the charge below, this is the brightness at the PEAK rather than for the whole flight.' });
  row(light, 'halo position', 'tip', 1, { min: -1, max: 1, step: 0.05,
    title: 'Along the bolt, as a fraction of its own half-length: 1 is the nose, 0 the middle, -1 the tail. Measured off the body’s real bounds, so the nose stays the nose at any length. Centred, a 2.6:1 bolt lights evenly and reads as a glowing pill instead of a point of light with a streak behind it.' });

  // --- THE CHARGE -----------------------------------------------------------
  // Its own card rather than four more rows under the halo, because it is a
  // curve over time and the three sliders only mean anything read together —
  // `from` and `to` are fractions of the row above, and the peak is where the
  // row above IS.
  const ramp = (l.ramp ??= {});
  const chg = card(cols, 'sv-wb-imp', 'Its charge',
    'The halo rides up over the flight and is snuffed at the end of it, on the bolt’s <b>own</b> life — so a lattice shard runs the whole arc inside its much shorter one rather than being born half spent. The two ends are fractions of the halo’s overdrive above, which is now the value at the <em>peak</em>.');
  const rrow = (label, key, fb, opts = {}) => slider(chg, label, {
    ...opts,
    get: () => ramp[key] ?? fb,
    set: (v) => { ramp[key] = v; redressBolts(projectiles); },
    title: opts.title ?? label,
  });
  // A curve is a NAME out of ease.js, never a number written here — see that
  // file's header on why the vocabulary is shared. A <select> rather than a row
  // of pills because the list is thirteen long and the pill row in this panel
  // is already carrying the goo groups.
  const pickEase = (host, label, key, fb, title) => {
    const r = document.createElement('div');
    r.className = 'sv-wb-f';
    const lab = document.createElement('label');
    lab.textContent = label;
    lab.title = title.replace(/<[^>]+>/g, '');
    const sel = document.createElement('select');
    sel.className = 'sv-wb-search';
    sel.style.cssText = 'margin:0;flex:1;min-width:0';
    for (const name of EASINGS) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    }
    sel.value = ramp[key] ?? fb;
    sel.addEventListener('change', () => { ramp[key] = sel.value; touched(); });
    r.append(lab, sel);
    host.appendChild(r);
  };
  rrow('at the muzzle', 'from', 0.25, { min: 0, max: 1, step: 0.05,
    title: 'What the bright pass sees is <b>overdrive &times; its own overdrive &times; this</b>, and the threshold is 0.58 — so if that product lands under it, a new bolt has no bloom at all and then <em>ignites</em>. Worth aiming for, and easy to lose: push either overdrive up and the halo brightens without ever lighting up.' });
  rrow('peaks at', 'peakAt', 0.55, { min: 0.05, max: 0.95, step: 0.05,
    title: 'Where in the life the halo is brightest. Past the middle, so the brightest moment is out in front of the seal rather than on the fin.' });
  rrow('at the end', 'to', 0.1, { min: 0, max: 1, step: 0.05,
    title: 'What is left as it dies. Near 0 the bolt goes out before it despawns, which is what makes the fizzle read as the end of something rather than as a deletion.' });
  pickEase(chg, 'rise curve', 'rise', 'inExpo',
    'Muzzle to peak. An <b>in</b> curve holds near the muzzle then rushes — dark, dark, flare. An <b>out</b> curve inverts it into a bolt brightest at the fin, which is a muzzle flash and not a charge.');
  pickEase(chg, 'fall curve', 'fall', 'inExpo',
    'Peak to death. An <b>in</b> curve holds bright and then drops away at the very end, which is what “dims as it nears the end of its life” means; an <b>out</b> curve starts fading the instant it peaks.');

  // --- THE COLOUR -----------------------------------------------------------
  const col = card(cols, 'sv-wb-imp', 'Its colour',
    'The bolt takes the <b>element the fin is carrying</b>, and the run’s if the fin has none. Two bolts in one volley can disagree — that is why the element rides the pellet rather than being looked up where it lands. The swatch below is the bolt with <em>no</em> element anywhere; the four beside it are not editable here, because renaming an element’s colour in two places is how two spellings of one idea start.');
  const swatch = document.createElement('div');
  swatch.className = 'sv-wb-f';
  const swLab = document.createElement('label');
  swLab.textContent = 'no element';
  const sw = document.createElement('input');
  sw.type = 'color';
  sw.autocomplete = 'off';
  sw.value = `#${(l.color ?? 0x66e0ff).toString(16).padStart(6, '0')}`;
  sw.style.cssText = 'width:30px;height:22px;padding:0;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:none;cursor:pointer';
  sw.addEventListener('input', () => { l.color = parseInt(sw.value.slice(1), 16); touched(); });
  swatch.append(swLab, sw);
  col.appendChild(swatch);

  // The four elements, as read-only chips. Straight off boltPalette so a chip
  // that disagreed with a bolt would be a bug in one function rather than a
  // drift between the panel and the weapon.
  const strip = document.createElement('div');
  strip.className = 'sv-wb-f';
  const stripLab = document.createElement('label');
  stripLab.textContent = 'elements';
  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;gap:6px;flex:1;min-width:0';
  for (const p of boltPalette()) {
    if (!p.id) continue;
    const dot = document.createElement('div');
    dot.style.cssText = `flex:1;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,0.2);`
      + `background:#${(p.color ?? 0xffffff).toString(16).padStart(6, '0')}`;
    dot.title = `${p.id} — CONFIG.biolum.elements.${p.id}.color. Tuned where the element is tuned.`;
    chips.appendChild(dot);
  }
  strip.append(stripLab, chips);
  col.appendChild(strip);

  // --- THE RIBBON -----------------------------------------------------------
  // The trail is CONFIG.trails.finLaser rather than the look block, and it is
  // shown here anyway for the reason the whole panel exists: a bolt and the
  // streak behind it are one object to the eye, and tuning them in two places
  // is how a short bolt ends up with a ribbon twice its own length.
  const t = (CONFIG.trails ??= {});
  const tl = (t.finLaser ??= {});
  const trail = card(cols, 'sv-wb-imp', 'The streak behind it',
    'CONFIG.trails.finLaser. On a laser the ribbon is not exhaust — it is the shot <em>still being there</em> a moment after it has gone, which is most of what makes something this fast and this short legible. Its colour follows the element too, so only a run carrying none ever shows the authored one.');
  slider(trail, 'length', { min: 2, max: 40, step: 1, dp: 0,
    get: () => tl.points ?? 14, set: (v) => { tl.points = Math.round(v); }, title: 'Points of history the ribbon is built through. Geometry, allocated once at this size — so unlike everything above it, this one reaches the NEXT bolt rather than the ones in the air.' });
  slider(trail, 'width', { min: 0.01, max: 0.6, step: 0.01,
    get: () => tl.width ?? 0.09, set: (v) => { tl.width = v; }, title: 'At the head. It tapers to nothing at the tail.' });
  slider(trail, 'glow', { min: 0, max: 8, step: 0.1, dp: 1,
    get: () => tl.glow ?? 3.2, set: (v) => { tl.glow = v; }, title: 'Brightness at the head. Additive, so this is the alpha as well — black is transparent.' });
  slider(trail, 'taper', { min: 0.2, max: 4, step: 0.1, dp: 1,
    get: () => tl.taper ?? 0.9, set: (v) => { tl.taper = v; }, title: 'How fast the width falls off toward the tail. Below 1 the ribbon holds its width most of the way and then drops — which is what makes it read as a line rather than as a comet.' });
  slider(trail, 'fade', { min: 0.2, max: 4, step: 0.1, dp: 1,
    get: () => tl.fade ?? 1.2, set: (v) => { tl.fade = v; }, title: 'The same falloff for brightness. Lower than the taper leaves a thin bright line; higher leaves a wide dim one.' });
}

// ---------------------------------------------------------------------------
// A LOOP VOICE ON ITS OWN — see LOOP_ROWS.
//
// Everything else in this panel is reached through the moment that fires it,
// and these have no moment. What they still need is everything a voice needs:
// somewhere to hear it, a level, and a way to put a different recording behind
// it — the Library dock on the right already targets whatever voiceOf(current)
// resolves to, which is why its + and − work here without knowing about this.
//
// NO PITCH OR FILTER ROWS. They would render and do nothing: a bed layer is
// played by systems/jetBed.js through its own graph, which reads the BUFFER and
// none of the one-shot fields. `gain` is here for the same reason with the
// opposite answer — it is what the ▶ audition below is scaled by, so it is the
// level you judge the file at even though the bed's own mix is set per layer in
// the jet panel.
// ---------------------------------------------------------------------------
function renderLoopVoice(voice) {
  const vdef = CONFIG.sfx[voice];
  els.name.textContent = voice;
  els.via.textContent = `CONFIG.sfx.${voice}  \u2192  CONFIG.bubbleJet.bed.layers  \u2192  systems/jetBed.js`;
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();
  if (!vdef) {
    card(cols, 'sv-wb-imp wide', 'Not in this build', `CONFIG.sfx.${voice} is missing, so there is nothing to tune.`);
    return;
  }

  const srcs = srcsOf(vdef);
  const bed = CONFIG.bubbleJet?.bed ?? {};
  const layers = Array.isArray(bed.layers) ? bed.layers : [];
  // Who actually loops this, including the single-name shorthand. Printed
  // rather than assumed: a layer removed in the jet panel leaves this voice
  // sitting here doing nothing, and that is worth being told.
  const usedBy = [
    ...(bed.sample === voice ? ['the first loop'] : []),
    ...layers.map((l, i) => (l.sample === voice ? `layer ${i + (bed.sample ? 2 : 1)}` : null)).filter(Boolean),
  ];

  const c = card(cols, 'sv-wb-imp wide', 'Loop material',
    'Not a sound anything fires. It is a <b>buffer</b> the bubble jet\u2019s bed loops as one layer, summed with the other layers and the oscillator stack ahead of the overdrive \u2014 so one filter sweep opens across all of them. Its level in that mix is set per layer in the jet panel; this is where you audition the file itself and change which file it is.');

  const where = document.createElement('div');
  where.className = usedBy.length ? 'sv-wb-scope' : 'sv-wb-none';
  where.innerHTML = usedBy.length
    ? `Looped by <b>${usedBy.join('</b>, <b>')}</b> of the bed. Set the balance there \u2014 <b>\u224b The bubble jet</b> in this rail.`
    : 'Nothing loops this at the moment. Add it as a layer in <b>\u224b The bubble jet</b> and it starts sounding on the next stream.';
  c.appendChild(where);

  if (!srcs.length) {
    const n = document.createElement('div');
    n.className = 'sv-wb-none';
    n.textContent = 'No file behind it, so this layer is silent. Add one from the Library on the right.';
    c.appendChild(n);
  }

  dbSlider(c, 'audition level', { get: () => vdef.gain ?? 0.2, set: (v) => { vdef.gain = v; } });

  // The takes, same row idiom as the event pane's. A loop voice wants exactly
  // ONE file — the lookup picks at random, which is variation on a one-shot and
  // a character change on a bed — so this says so rather than only allowing it.
  if (srcs.length > 1) {
    const warn = document.createElement('div');
    warn.className = 'sv-wb-scope';
    warn.innerHTML = `<b>${srcs.length} files on one loop voice.</b> The bed asks for a buffer once per stream and gets a random one of these, so the bed changes character between bursts rather than layering them. Take all but one out, or make the second a layer of its own.`;
    c.appendChild(warn);
  }

  const takes = document.createElement('div');
  takes.className = 'sv-wb-takes';
  srcs.forEach((src) => {
    const row = document.createElement('div');
    row.className = 'sv-wb-take';
    const fn = document.createElement('span');
    fn.className = 'fn';
    fn.textContent = src.split('/').pop();
    fn.title = src;
    const play = document.createElement('button');
    play.className = 'sv-wb-btn';
    play.textContent = '\u25b6';
    play.title = 'Play this file straight through, once — not looped and not through the bed';
    play.addEventListener('click', () => auditionFile(src, vdef.gain ?? 0.3));
    const del = document.createElement('button');
    del.className = 'sv-wb-btn';
    del.textContent = '\u00d7';
    del.title = 'Take this file off the voice \u2014 the file stays in the library';
    del.addEventListener('click', async () => {
      vdef.srcs = srcs.filter((x) => x !== src);
      vdef.src = null;
      changed();
      await reloadSample(voice);
      render();
    });
    row.append(fn, play, del);
    takes.appendChild(row);
  });
  c.appendChild(takes);

  const hint = document.createElement('div');
  hint.className = 'sv-wb-none';
  hint.textContent = 'A new file only reaches a stream that starts after it \u2014 an open bed keeps the buffer it opened with.';
  c.appendChild(hint);
}

function renderBubbleJet() {
  const c = CONFIG.bubbleJet;
  els.name.textContent = 'The bubble jet';
  els.via.textContent = 'CONFIG.bubbleJet  →  systems/bubbleJet.js + systems/jetBed.js';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();
  if (!c) {
    card(cols, 'sv-wb-imp wide', 'Not in this build',
      'CONFIG.bubbleJet is missing, so there is nothing to tune.');
    return;
  }
  const l = (c.look ??= {});
  const bed = (c.bed ??= {});

  // A small labelled <select>. Three of the controls in here are choices from a
  // list rather than numbers, and typing a key into a text field and finding
  // out at fire time whether it exists is how `bubbleEmitter` ends up naming a
  // preset that was renamed six months ago — silently, because emit() returns
  // on an unknown name.
  const pick = (host, label, options, get, set, title) => {
    const row = document.createElement('div');
    row.className = 'sv-wb-f';
    const lab = document.createElement('label');
    lab.textContent = label;
    if (title) lab.title = title;
    const sel = document.createElement('select');
    sel.className = 'sv-wb-search';
    sel.style.cssText = 'margin:0;flex:1;min-width:0';
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = get();
    sel.addEventListener('change', () => { set(sel.value); changed(); });
    row.append(lab, sel);
    host.appendChild(row);
    return sel;
  };

  // --- HOLDING IT OPEN -------------------------------------------------------
  const drive = card(cols, 'sv-wb-imp', 'Holding it open',
    'Not a Fire button. This is a sustained weapon — the whole question is what it does while it is <em>on</em>, and a burst you have to re-trigger to look at is a burst, not a stream. Hold opens one at the seal and leaves it; Let go vents it. It does no damage while staged, so the thing you are judging it against is still there afterwards.');

  const holdRow = document.createElement('div');
  holdRow.className = 'sv-wb-f';
  const holdLab = document.createElement('label');
  holdLab.textContent = 'the stream';
  const holdBtn = document.createElement('button');
  holdBtn.className = 'sv-wb-btn sv-stage-fire';
  const dropBtn = document.createElement('button');
  dropBtn.className = 'sv-wb-btn';
  dropBtn.textContent = '■ Let go';
  const status = document.createElement('div');
  status.className = 'sub';
  status.style.margin = '0';

  // Polled rather than pushed, and deliberately: the stream is opened and
  // closed by the game as well as by these two buttons — the seal's own duty
  // cycle runs underneath this panel whenever the sim is on — so a label driven
  // by the buttons alone would say "held" over a stream that had already
  // vented. Cleared when the view is torn down; see `jetPoll`.
  const refresh = () => {
    const open = stagedJetOpen();
    holdBtn.textContent = open ? '● Held' : '▶ Hold';
    holdBtn.disabled = open;
    dropBtn.disabled = !open;
    const st = bubbleJetState();
    status.textContent = open
      ? `held · ${st.jets} stream${st.jets === 1 ? '' : 's'} alive · ${jetBedCount()} bed${jetBedCount() === 1 ? '' : 's'} sounding`
      : (st.open
        ? `the seal’s own is running — open ${st.held.toFixed(2)}s`
        : 'nothing open');
  };
  holdBtn.addEventListener('click', () => {
    unlockAudio();
    const at = stageAnchor();
    // Along the aim the seal is actually holding is not available from here, so
    // the stream is pointed to the right — the same direction the stage bar's
    // `distance` offsets along, so an event fired from the bar and a stream
    // opened from here are laid out on the same axis.
    stageJet({ x: at.x, y: at.y }, { x: 1, y: 0 });
    refresh();
  });
  dropBtn.addEventListener('click', () => { stopStagedJet(); refresh(); });
  holdRow.append(holdLab, holdBtn, dropBtn);
  drive.appendChild(holdRow);
  const statusRow = document.createElement('div');
  statusRow.className = 'sv-wb-f';
  const statusLab = document.createElement('label');
  statusLab.textContent = 'right now';
  statusRow.append(statusLab, status);
  drive.appendChild(statusRow);
  refresh();
  jetPoll = setInterval(refresh, 250);

  // WHAT THE STREAM IS WORTH, measured rather than typed. The same rule the
  // upgrade cards follow: never write a number next to a curve, print what the
  // curve actually returns. A readout that disagreed with the water would be
  // worse than none.
  // ONE STACK, always — the first pick is the one whose numbers you cannot
  // read anywhere else, and a readout that tracked whatever level the current
  // run happened to be at would print a different answer every time the panel
  // was opened.
  const stats = jetStats(1);
  const num = document.createElement('div');
  num.className = 'sv-wb-none';
  num.innerHTML = 'Throughput is <b>weapons.csv</b>, not this panel — damage, reach, uptime and cadence are read against the rest of the arsenal over a run.<br>'
    + `At one stack: ${stats.damage.toFixed(1)} per tick every ${(c.tickEvery ?? 0.1).toFixed(2)}s, `
    + `${stats.reach.toFixed(0)} long, open ${stats.hold.toFixed(2)}s then ${stats.cool.toFixed(2)}s venting.`;
  drive.appendChild(num);

  // --- SECONDARY MOTION ------------------------------------------------------
  const whip = card(cols, 'sv-wb-imp', 'Secondary motion',
    'The stream is a <b>solid column</b> and does not wiggle on its own. Every bend in it is a consequence of the seal having moved: the energy at the far end left the mouth <em>travel</em> seconds ago and has been going the way it was fired ever since. Stand still and it is a straight bar. Strafe and it leans. Change course and a kink travels off the end.');
  slider(whip, 'memory', { max: 1, step: 0.005, dp: 3,
    get: () => l.travel ?? 0.22, set: (v) => { l.travel = v; },
    title: 'Seconds of muzzle history the column is drawn from — how long the energy takes to reach the tip. 0 is a rigid laser that snaps with your aim. It is also exactly how long the stream takes to straighten out after you stop moving, so this is the settle time as well.' });
  slider(whip, 'sway', { max: 4, step: 0.02,
    get: () => l.sway ?? 1.35, set: (v) => { l.sway = v; },
    title: 'How much of that displacement is applied. 1 is the physical answer; the look usually wants more than physics gives at swimming speed. 0 is a rigid beam, which is a real look — the column stays exactly on the aim.' });
  slider(whip, 'bend ceiling', { max: 20, step: 0.2, dp: 1,
    get: () => l.swayMax ?? 6, set: (v) => { l.swayMax = v; },
    title: 'World units, per node. NOT a taste control — the muzzle is read live off a rig this panel can swap mid-burn, and a run reset moves it across the arena. Either puts a metre of displacement into the history in one frame, and without this the column is flung off the screen.' });

  // --- THE WATER -------------------------------------------------------------
  const water = card(cols, 'sv-wb-imp', 'The water it is in',
    'The bend does not snap to where history says it should be — every point <em>eases</em> toward it, so a change of course arrives as a swell travelling through the beam rather than as a crease appearing in it. The turbulence then makes that easing uneven along the length, which is the difference between a smooth bend and something that folds like a ribbon.');
  slider(water, 'drag', { min: 0.5, max: 40, step: 0.1, dp: 1,
    get: () => l.drag ?? 7, set: (v) => { l.drag = v; },
    title: 'Per second. LOW IS HEAVY — syrupy, a long way behind you, and the smoothest. High is nearly rigid, at which point the drag and the turbulence both stop mattering and you are back to reading history directly.' });
  slider(water, 'turbulence', { max: 1, step: 0.01,
    get: () => l.dragTurbulence ?? 0.55, set: (v) => { l.dragTurbulence = v; },
    title: 'How much the drag varies along the length, as a fraction of it. ON THE DRAG, NEVER ON THE POSITION — drag decides how fast a point reaches its target and has no say in where the target is, so with the seal still every point settles to exactly zero however hard this is swinging. That is what lets the beam have this much character and still be dead straight at rest.' });
  slider(water, '...how fast it drifts', { min: 0.02, max: 8, step: 0.02,
    get: () => l.turbulenceRate ?? 1.1, set: (v) => { l.turbulenceRate = v; },
    title: 'How quickly the eddies move. Slow is one lazy fold travelling the beam; fast is a shimmer.' });
  slider(water, '...how tight', { min: 0.05, max: 4, step: 0.01,
    get: () => l.turbulenceScale ?? 0.7, set: (v) => { l.turbulenceScale = v; },
    title: 'Radians of phase per point — how closely packed the eddies are along the length. Tight enough and neighbouring points disagree so much that the column reads as noise rather than as fabric.' });
  slider(water, 'smoothing', { max: 6, step: 1, dp: 0,
    get: () => l.normalSmooth ?? 2, set: (v) => { l.normalSmooth = Math.round(v); },
    title: 'Blur passes over the ribbon\u2019s normals. A fold turns the normal sharply and a sharp turn is a visible seam down the beam, so this is the cheapest smoothing there is. The two ends are never blurred \u2014 the first normal is what welds the ribbon to the seal\u2019s mouth.' });
  slider(water, 'points', { min: 8, max: 160, step: 1, dp: 0,
    get: () => l.points ?? 72, set: (v) => { l.points = Math.round(v); },
    title: 'How many points the spline has. RESOLUTION, not shape \u2014 the per-point turbulence needs enough of them to read as a fold rather than as a zigzag. Takes effect on the NEXT stream: the ribbon is allocated at the count it was born with.' });

  // --- THE COLUMN ------------------------------------------------------------
  const wave = card(cols, 'sv-wb-imp', 'The column',
    'It holds full width down almost the whole length and only rounds off at the very end. A long taper is what a <em>spray</em> does, and a sprayed beam reads as weak however bright it is — what sells this is being the same thickness at the far end as at the mouth.');
  slider(wave, 'holds full to', { min: 0.1, max: 1, step: 0.01,
    get: () => l.columnFrom ?? 0.88, set: (v) => { l.columnFrom = v; },
    title: 'Where along the length the round-off begins. Push it to 1 for a bar cut flat at the end; pull it back toward 0.5 and it is a cone again.' });
  slider(wave, '...ends at', { max: 1, step: 0.01,
    get: () => l.columnTip ?? 0.62, set: (v) => { l.columnTip = v; },
    title: 'The width at the very tip, as a fraction of the body. 0 is a point — which is the spray this card exists to argue against. Around 0.6 rounds the end off without narrowing the beam.' });
  slider(wave, 'muzzle fade', { min: 0.005, max: 0.4, step: 0.005, dp: 3,
    get: () => l.muzzleFade ?? 0.04, set: (v) => { l.muzzleFade = v; },
    title: 'How quickly it reaches full width off the mouth. 0 leaves a full-width vertical cut sitting in open water at exactly the point the stream is meant to be emerging from something. Short — the column should clearly ORIGINATE, not fade up out of nothing.' });
  slider(wave, 'pulse', { max: 0.8, step: 0.01,
    get: () => l.pulseAmount ?? 0.12, set: (v) => { l.pulseAmount = v; },
    title: 'The ONE thing that moves on its own, and it moves the WIDTH rather than the position — a travelling swell reads as energy flowing up a solid bar, and the identical amount of travelling SIDEWAYS motion reads as a rope. That is the difference this whole panel is built around. Keep it small; it is texture, not shape.' });
  slider(wave, '...how fast', { max: 40, step: 0.1, dp: 1,
    get: () => l.pulseRate ?? 9, set: (v) => { l.pulseRate = v; } });
  slider(wave, '...how tight', { min: 0.2, max: 24, step: 0.1, dp: 1,
    get: () => l.pulseLength ?? 5.5, set: (v) => { l.pulseLength = v; },
    title: 'Radians of phase per unit length. High is a fine ripple running up the bar; low is one slow swell in the whole thing.' });

  // --- THE LIGHT -------------------------------------------------------------
  const light = card(cols, 'sv-wb-imp', 'The light',
    'Two ribbons written from the same nodes: a hot core inside a wide soft glow. The widths are not a taste question — the bright pass runs at a sixth of the screen, so anything under about 1.5 bloom pixels contributes nothing however brightly it is authored.');
  const swatch = document.createElement('div');
  swatch.className = 'sv-wb-f';
  const swLab = document.createElement('label');
  swLab.textContent = 'colour';
  swLab.title = 'Pushed past 1.0 on its PEAK CHANNEL before it reaches the bright pass, which is the only reason it blooms at all — the threshold is on luminance, where blue is worth 7%.';
  const sw = document.createElement('input');
  sw.type = 'color';
  sw.autocomplete = 'off';
  sw.value = `#${(l.color ?? 0x62f2ff).toString(16).padStart(6, '0')}`;
  sw.style.cssText = 'width:30px;height:22px;padding:0;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:none;cursor:pointer';
  sw.addEventListener('input', () => { l.color = parseInt(sw.value.slice(1), 16); changed(); });
  swatch.append(swLab, sw);
  light.appendChild(swatch);
  slider(light, 'overdrive', { max: 8, step: 0.05,
    get: () => l.overdrive ?? 3.2, set: (v) => { l.overdrive = v; },
    title: 'How far past 1.0 the colour is pushed. Under about 2 the stream is a coloured shape; past it, it is a light source.' });
  slider(light, 'halo overdrive', { max: 2, step: 0.02,
    get: () => l.glowOverdriveMul ?? 0.5, set: (v) => { l.glowOverdriveMul = v; },
    title: 'As a fraction of the core’s. The wide one should be dimmer, or the core stops reading as hotter than what surrounds it.' });
  slider(light, 'core width', { max: 2, step: 0.01,
    get: () => l.coreWidthMul ?? 0.34, set: (v) => { l.coreWidthMul = v; },
    title: 'As a fraction of the stream’s width. Thin, but not sub-pixel in the bloom buffer — see the card’s note.' });
  slider(light, 'halo width', { max: 4, step: 0.02,
    get: () => l.glowWidthMul ?? 1, set: (v) => { l.glowWidthMul = v; },
    title: 'The wide ribbon. This is what actually blooms.' });
  slider(light, 'core level', { max: 1, step: 0.01,
    get: () => l.coreOpacity ?? 0.95, set: (v) => { l.coreOpacity = v; } });
  slider(light, 'halo level', { max: 1, step: 0.01,
    get: () => l.glowOpacity ?? 0.5, set: (v) => { l.glowOpacity = v; } });
  slider(light, 'edge softness', { min: 0.05, max: 1, step: 0.01,
    get: () => l.edgeSoftness ?? 0.6, set: (v) => { l.edgeSoftness = v; },
    title: 'How much of the half-width is falloff. Baked into a texture at first use — RELOAD to see a change, which is the price of not putting a shader on the one effect that has to stay checkable without a GPU.' });
  slider(light, 'muzzle spill', { max: 3, step: 0.02,
    get: () => l.spillStrength ?? 0.75, set: (v) => { l.spillStrength = v; },
    title: 'The soft glow where the stream leaves the seal — an additive sprite, not a light, because half this game’s creatures are unlit and a real light would simply not reach them.' });
  slider(light, '...its size', { max: 20, step: 0.1, dp: 1,
    get: () => l.spillSize ?? 5, set: (v) => { l.spillSize = v; } });
  slider(light, 'bloom floor', { max: 2, step: 0.02,
    get: () => c.sustainGlow ?? 0.45, set: (v) => { c.sustainGlow = v; },
    title: 'How hot the whole frame runs while a stream burns. A FLOOR, not a set — the per-cut spikes have to be able to punch above it.' });

  // --- THE BUBBLES -----------------------------------------------------------
  const bub = card(cols, 'sv-wb-imp', 'The bubbles',
    'What makes it a bubble jet rather than a laser. Thrown sideways off the stream at random points along its whole length — at the muzzle only they read as a puff on the end of a beam.');
  pick(bub, 'made of', Object.keys(CONFIG.emitters ?? {}).map((k) => [k, k]),
    () => l.bubbleEmitter ?? 'blastBubbles', (v) => { l.bubbleEmitter = v; },
    'A preset from CONFIG.emitters. A list rather than a text field because emit() returns silently on a name it does not know, so a typo here is an effect that simply stops having bubbles.');
  slider(bub, 'per second', { max: 120, step: 1, dp: 0,
    get: () => l.bubblesPerSecond ?? 26, set: (v) => { l.bubblesPerSecond = v; },
    title: 'Scaled by how far up the stream is, so a spooling jet does not spit at full rate before it is lit.' });
  slider(bub, 'size', { max: 2, step: 0.01,
    get: () => l.bubbleScale ?? 0.25, set: (v) => { l.bubbleScale = v; },
    title: 'Multiplies the preset’s own count as well as its size — see emit().' });
  slider(bub, 'thrown at', { max: 3, step: 0.02,
    get: () => l.bubbleSpeed ?? 0.7, set: (v) => { l.bubbleSpeed = v; },
    title: 'How hard they peel off sideways. Low and they ride along with the stream, which reads as one object rather than as something shedding.' });

  // --- THE BED ---------------------------------------------------------------
  // THE STACK IS DEAD ONLY WHEN ITS LEVEL IS ZERO. This used to read
  // `!!bed.sample`, from the days when naming a sample meant the oscillators
  // were never built — so picking one greyed out the whole tone card. They
  // layer now, so a sampled bed still has every one of those controls live.
  const deadStack = (bed.synthLevel ?? 1) <= 0;
  const b = card(cols, 'sv-wb-imp wide', 'The bed',
    'One voice that ramps up and then <b>holds</b> — not a sound in CONFIG.sfx, and it could not be: everything in that table knows its own length when it is triggered, and this is held open for as long as the stream burns. The ramp is the only part with movement in it; the hold is deliberately flat, because a sustained sound that keeps developing never arrives.');
  toggle(b, 'bed under the stream', () => bed.enabled, (v) => { bed.enabled = v; },
    'Off, the stream is silent apart from its cuts. The two feedback events are unaffected.');

  // --- THE LAYERS ------------------------------------------------------------
  // Every mp3 loop and the oscillator stack sound TOGETHER, summed ahead of the
  // drive and the ladder — so they saturate and sweep as one instrument rather
  // than being three sounds mixed afterwards. `bed.sample` is the single-name
  // shorthand and is layer zero; the list below is everything after it.
  const layerNote = document.createElement('div');
  layerNote.className = 'sv-wb-none';
  layerNote.innerHTML = 'Loops and the stack sound <b>together</b>, summed before the overdrive — so one filter sweep opens across all of them. A layer wants a voice holding exactly <b>one</b> file: the lookup picks a take at random, which is variation on a one-shot and a character change on a bed.';
  b.appendChild(layerNote);

  const voiceOptions = (blank) => [[blank[0], blank[1]],
    ...Object.keys(CONFIG.sfx ?? {}).map((k) => [k, `${k}${hasSample(k) ? '' : ' (nothing loaded)'}`])];

  // The shorthand slot, kept because it is what `bed.sample` has always been
  // and what an older saved tuning carries.
  pick(b, 'loop', voiceOptions(['', 'none — stack only']),
    () => bed.sample ?? '', (v) => { bed.sample = v; render(); },
    'The first mp3 loop. A loaded voice is looped and run through the same drive, the same filter sweep and the same envelope as the stack — it inherits the shape rather than being a second, unrelated bed. Load files into a voice from the library below.');
  if (bed.sample) {
    if (!hasSample(bed.sample)) {
      const n = document.createElement('div');
      n.className = 'sv-wb-none';
      n.textContent = `CONFIG.sfx.${bed.sample} has no file loaded, so this layer is silent and you are hearing the rest of the bed. Add one from the library and it joins on the next stream.`;
      b.appendChild(n);
    }
    slider(b, '...its level', { max: 2, step: 0.01,
      get: () => bed.sampleLevel ?? 1, set: (v) => { bed.sampleLevel = v; },
      title: 'Where this loop sits against the other layers and the stack.' });
    slider(b, '...loops from (s)', { max: 6, step: 0.001, dp: 3,
      get: () => bed.loopStart ?? 0, set: (v) => { bed.loopStart = v; },
      title: 'Seconds, not frames, so the points survive a re-record at a different rate. Both at 0 loops the whole file — right for something recorded as a bed, and a click every pass on anything else.' });
    slider(b, '...to (s)', { max: 6, step: 0.001, dp: 3,
      get: () => bed.loopEnd ?? 0, set: (v) => { bed.loopEnd = v; },
      title: 'Left at 0 (or below the start) the loop runs to the end of the file. Clamped to the file length, so an over-long value is the whole file rather than silence.' });
  }

  // The rest of the layers, each one removable.
  const layers = Array.isArray(bed.layers) ? bed.layers : (bed.layers = []);
  layers.forEach((layer, i) => {
    const head = document.createElement('div');
    head.className = 'sv-wb-take';
    const lab = document.createElement('span');
    lab.className = 'fn';
    // Numbered from what is actually above them: `bed.sample` is layer one when
    // it names something and is not a layer at all when it is blank, so a bed
    // built entirely out of this list reads "layer 1, layer 2" rather than
    // starting at two with nothing before it.
    lab.textContent = `layer ${i + (bed.sample ? 2 : 1)}`;
    const del = document.createElement('button');
    del.className = 'sv-wb-btn';
    del.textContent = '×';
    del.title = 'Take this layer out of the bed — the voice and its files stay in the library';
    del.addEventListener('click', () => { layers.splice(i, 1); changed(); render(); });
    head.append(lab, del);
    b.appendChild(head);

    pick(b, '...loop', voiceOptions(['', 'none']),
      () => layer.sample ?? '', (v) => { layer.sample = v; render(); },
      'Which voice this layer loops.');
    slider(b, '...level', { max: 2, step: 0.01,
      get: () => layer.level ?? 1, set: (v) => { layer.level = v; } });
    slider(b, '...loops from (s)', { max: 6, step: 0.001, dp: 3,
      get: () => layer.loopStart ?? 0, set: (v) => { layer.loopStart = v; } });
    slider(b, '...to (s)', { max: 6, step: 0.001, dp: 3,
      get: () => layer.loopEnd ?? 0, set: (v) => { layer.loopEnd = v; } });
  });

  const addRow = document.createElement('div');
  addRow.className = 'sv-wb-take';
  const addBtn = document.createElement('button');
  addBtn.className = 'sv-wb-btn';
  addBtn.textContent = '+ another loop';
  addBtn.title = 'Stack another mp3 loop into the bed. It starts pointing at nothing, which is silent rather than wrong.';
  addBtn.addEventListener('click', () => {
    // Starts EMPTY rather than guessing a voice. A new row that arrived
    // already naming something would be an edit nobody made — the same trap
    // the tuner's own rows used to fall into by writing their midpoint onto
    // every preset that had no value.
    layers.push({ sample: '', level: 1, rate: 1, loopStart: 0, loopEnd: 0 });
    changed();
    render();
  });
  addRow.appendChild(addBtn);
  b.appendChild(addRow);

  slider(b, 'the stack in that mix', { max: 2, step: 0.01,
    get: () => bed.synthLevel ?? 1, set: (v) => { bed.synthLevel = v; render(); },
    title: 'The oscillator stack’s level against the loops above. 0 silences it and leaves the loops — the tone card below then greys out, because there is nothing left for it to shape.' });
  slider(b, 'level', { max: 1, step: 0.005, dp: 3,
    get: () => bed.gain ?? 0.22, set: (v) => { bed.gain = v; },
    title: 'The held level. The ramp climbs to it and then sits there.' });
  slider(b, 'ramps over', { min: 0.02, max: 3, step: 0.01,
    get: () => bed.ramp ?? 0.45, set: (v) => { bed.ramp = v; },
    title: 'Seconds. Deliberately independent of the stream’s own spool: they are the same gesture but do not have to arrive together, and a bed landing a little after the ribbon is at full reads as the thing settling into its note.' });
  slider(b, '...attack (of that)', { min: 0.01, max: 1, step: 0.01,
    get: () => bed.attack ?? 0.35, set: (v) => { bed.attack = v; },
    title: 'A FRACTION of the ramp, not a number of seconds — so retuning the ramp keeps the shape instead of turning it into a click followed by a long climb.' });
  slider(b, '...level at that point', { max: 1, step: 0.01,
    get: () => bed.attackLevel ?? 0.55, set: (v) => { bed.attackLevel = v; },
    title: 'How much of the held level has arrived by the end of the attack. The rest climbs with the filter, which is what makes the spool read as gaining power rather than as a filter opening on a sound that was already there.' });
  slider(b, 'release', { min: 0.01, max: 1.5, step: 0.01,
    get: () => bed.release ?? 0.12, set: (v) => { bed.release = v; },
    title: 'Down, fast. The stream is cut, not faded out — the tail is the room, not the synth.' });

  const tone = card(cols, 'sv-wb-imp', 'The tone',
    'A stack, not a chord. Three saws a few cents apart beat slowly against each other and are heard as ONE thick voice; past about thirty cents they separate into a detuned mess. The square an octave down carries the weight the saws have none of.');
  slider(tone, 'note (Hz)', { min: 20, max: 220, step: 1, dp: 0, dead: deadStack,
    get: () => bed.note ?? 55, set: (v) => { bed.note = v; },
    title: 'Low. Above about 80 this starts competing with the boss cries for the same part of the spectrum.' });
  pick(tone, 'shape', [['sawtooth', 'sawtooth'], ['square', 'square'], ['triangle', 'triangle'], ['sine', 'sine']],
    () => bed.wave ?? 'sawtooth', (v) => { bed.wave = v; },
    'Sawtooth is the Moog answer: everything the drive and the filter do downstream needs harmonics to work on, and a sine has none.');
  slider(tone, 'voices', { min: 1, max: 7, step: 1, dp: 0, dead: deadStack,
    get: () => bed.unison ?? 3, set: (v) => { bed.unison = Math.round(v); },
    title: 'An ODD count keeps one voice dead centre, which is what stops the pitch itself drifting as the spread is widened.' });
  slider(tone, 'spread (cents)', { max: 60, step: 0.5, dp: 1, dead: deadStack,
    get: () => bed.detune ?? 11, set: (v) => { bed.detune = v; } });
  slider(tone, 'sub', { max: 2, step: 0.02, dead: deadStack,
    get: () => bed.sub ?? 0.7, set: (v) => { bed.sub = v; },
    title: 'A square an octave below the note. This is the weight — the saws alone are all edge, and the edge is what the drive is about to multiply.' });

  const dirt = card(cols, 'sv-wb-imp', 'The overdrive',
    'Not a volume. The shaper sits <b>before</b> the filter, which is the ordering that makes this a Moog rather than a loud synth: drive generates the harmonics and the resonant lowpass then decides which of them you hear. Distorting afterwards just fuzzes whatever survived and cannot be swept.');
  slider(dirt, 'into the shaper', { min: 0.1, max: 8, step: 0.05,
    get: () => bed.preGain ?? 1.6, set: (v) => { bed.preGain = v; },
    title: 'How hard the signal hits the curve. This and hardness below do different things: this one decides how much of the waveform is in the bent part.' });
  slider(dirt, 'hardness', { min: 0.5, max: 30, step: 0.1, dp: 1,
    get: () => bed.drive ?? 6, set: (v) => { bed.drive = v; },
    title: 'The curve’s own bend. Normalised so it still reaches full scale — without that, more drive would also mean quieter, and this slider would fight the level.' });
  slider(dirt, 'resonance', { min: 0.1, max: 24, step: 0.1, dp: 1,
    get: () => bed.resonance ?? 9, set: (v) => { bed.resonance = v; },
    title: 'On the second pole only. Stacked in both stages the ladder peaks twice and screams.' });
  slider(dirt, 'opens from (Hz)', { min: 20, max: 2000, step: 5, dp: 0,
    get: () => bed.from ?? 180, set: (v) => { bed.from = v; } });
  slider(dirt, '...to (Hz)', { min: 100, max: 12000, step: 25, dp: 0,
    get: () => bed.to ?? 2600, set: (v) => { bed.to = v; },
    title: 'Where the filter sits for the whole hold. Exponential on the way there, because a sweep is heard in octaves — a linear ramp reads as opening instantly and then sitting still.' });
  slider(dirt, 'closes back to (Hz)', { min: 20, max: 4000, step: 5, dp: 0,
    get: () => bed.releaseTo ?? 180, set: (v) => { bed.releaseTo = v; },
    title: 'The filter comes back with the level on release. A bed whose gain alone fell read as someone turning a volume knob down; this is what makes it read as the thing switching off.' });
  slider(dirt, 'breath depth (Hz)', { max: 1200, step: 10, dp: 0,
    get: () => bed.breathDepth ?? 220, set: (v) => { bed.breathDepth = v; },
    title: 'The only movement in the hold, and it has to stay under the threshold of being followed — anything you can track is development, and this is meant to be felt as the thing idling. 0 is a dead hold, which is a real choice for a short one.' });
  slider(dirt, '...how slowly', { min: 0.02, max: 8, step: 0.02,
    get: () => bed.breathRate ?? 0.7, set: (v) => { bed.breathRate = v; },
    title: 'Hz. Under 1 is a swell; over about 4 it is a wobble and reads as an effect rather than as the sound.' });
}

// The poll behind the "right now" readout. Held module-level and cleared on
// every re-render, or every visit to this view would leave another interval
// running against a detached label — invisible, and eventually the panel is
// doing more work idle than the game is.
let jetPoll = null;

function renderCardRiser() {
  const slam = CONFIG.upgradeSlam;
  const r = slam?.riser;
  els.name.textContent = 'The riser under a card';
  els.via.textContent = 'CONFIG.upgradeSlam.riser  →  systems/cardRiser.js';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();
  if (!slam || !r) {
    card(cols, 'sv-wb-imp wide', 'Not in this build',
      'CONFIG.upgradeSlam.riser is missing, so there is nothing to tune.');
    return;
  }
  // The live array, not a copy — every fader below writes into these objects.
  const bands = (r.bands ??= []);

  // --- WHAT DRIVES IT --------------------------------------------------------
  const when = card(cols, 'sv-wb-imp', 'What drives it',
    'It is not a one-shot with a decay. The cutoff is scheduled across exactly how long the card is in the air, so it arrives open on the frame of impact — and is then cut by the landing, which is what a riser is for.');
  toggle(when, 'riser under the fall', () => r.enabled, (v) => { r.enabled = v; },
    'Off, a card falls in silence until it lands. The pop and the tier sting are unaffected.');

  const span = document.createElement('div');
  span.className = 'sv-wb-f';
  const spanLab = document.createElement('label');
  spanLab.textContent = 'sweeps across';
  spanLab.title = 'CONFIG.upgradeSlam.time — the card’s air time, the same number the CSS animation runs on. Read live rather than duplicated: two sliders for one length is how a riser drifts off the thing it is scoring.';
  const spanVal = document.createElement('div');
  spanVal.className = 'sub';
  spanVal.style.margin = '0';
  spanVal.textContent = Number(slam.time ?? 0.26).toFixed(2)
    + 's — the card\u2019s fall, tuned under "how the hand arrives" in the \u0060 tuner';
  span.append(spanLab, spanVal);
  when.appendChild(span);

  const fireRow = document.createElement('div');
  fireRow.className = 'sv-wb-f';
  const fireLab = document.createElement('label');
  fireLab.textContent = 'try it';
  const fireBtn = document.createElement('button');
  fireBtn.className = 'sv-wb-btn sv-stage-fire';
  fireBtn.textContent = '▶ One card falling';
  fireBtn.title = 'Starts a real riser at the current fall length and cuts it on the frame the card would land. Not a preview of the sound — it is the sound, including the choke, which is half of it.';
  fireBtn.addEventListener('click', () => {
    unlockAudio();
    const dur = Math.max(0.04, slam.time ?? 0.26);
    const key = {};
    startCardRiser(key, dur);
    // CUT ON THE LANDING, not left to run out. A riser auditioned without its
    // own ending is a different sound from the one that ships: the whole
    // gesture is the build being taken away, and a tail nobody will ever hear
    // is exactly what this stopped being when it left CONFIG.sfx.
    setTimeout(() => stopAllCardRisers(), dur * 1000);
  });
  // ...and the hand, because VARIATION CANNOT BE JUDGED ONE AT A TIME. A single
  // audition of a riser with variation on sounds exactly like a single audition
  // of one without; the whole question is whether three in a row sound copied,
  // and that is three in a row at the real stagger or it is nothing.
  const seqBtn = document.createElement('button');
  seqBtn.className = 'sv-wb-btn';
  seqBtn.textContent = '\u25b6\u25b6 The whole hand';
  seqBtn.title = 'Throws a full hand at the real stagger, each with its own roll of the variation below. This is the only way to hear whether the riser repeats.';
  seqBtn.addEventListener('click', () => {
    unlockAudio();
    const dur = Math.max(0.04, slam.time ?? 0.26);
    const gap = Math.max(0, slam.stagger ?? 0.58);
    for (let i = 0; i < (CONFIG.upgradeChoices ?? 3); i++) {
      const key = {};
      setTimeout(() => {
        startCardRiser(key, dur);
        setTimeout(() => stopCardRiser(key), dur * 1000);
      }, i * gap * 1000);
    }
  });
  fireRow.append(fireLab, fireBtn, seqBtn);
  when.appendChild(fireRow);

  // --- THE MIXER -------------------------------------------------------------
  // The faders, and the reason this view is laid out the way it is: a riser is
  // three swept bands at different levels far more often than it is any one of
  // them, so the BALANCE is the first thing you reach for and the per-band
  // shaping is the second.
  //
  // Level and swell live in the shared envelope below rather than here, so
  // moving a fader changes the mix and never the shape. That is what makes this
  // a mixer rather than four copies of the same card.
  const mixer = card(cols, 'sv-wb-imp', 'The mixer',
    'One looping noise source per band, each through its own resonant bandpass climbing its own range across the fall. No tone anywhere in it — a riser made of pitched material is a note that gets brighter, because the ear locks onto the fundamental and hears the filter as timbre.');
  bands.forEach((b, i) => {
    slider(mixer, `band ${i + 1}`, { max: 2, step: 0.02,
      get: () => b.level ?? 1, set: (v) => { b.level = v; },
      title: `The fader for band ${i + 1}. 0 builds no band at all — not a silent one.` });
  });

  const bandRow = document.createElement('div');
  bandRow.className = 'sv-wb-f';
  const bandLab = document.createElement('label');
  bandLab.textContent = 'how many';
  bandLab.title = 'The bank is any length. Adding one copies the last band so it arrives somewhere audible rather than at a default nobody chose.';
  const addBtn = document.createElement('button');
  addBtn.className = 'sv-wb-btn';
  addBtn.textContent = '+ band';
  addBtn.addEventListener('click', () => {
    const last = bands[bands.length - 1];
    // A COPY, not a fresh default. A new row at some midpoint is a band you
    // then have to find by ear before you can tune it; a copy of the last one
    // is already in the sound, and moving it is the edit.
    bands.push(last ? { ...last } : { level: 0.5, q: 4, from: 200, to: 4000, at: 0 });
    changed();
    render();
  });
  const dropBtn = document.createElement('button');
  dropBtn.className = 'sv-wb-btn';
  dropBtn.textContent = '− band';
  dropBtn.disabled = bands.length <= 1;
  dropBtn.addEventListener('click', () => {
    if (bands.length <= 1) return;
    bands.pop();
    changed();
    render();
  });
  bandRow.append(bandLab, addBtn, dropBtn);
  mixer.appendChild(bandRow);

  // --- ONE CARD PER BAND -----------------------------------------------------
  bands.forEach((b, i) => {
    const el = card(cols, 'sv-wb-imp', `Band ${i + 1}`,
      i === bands.length - 1 && bands.length > 1
        ? 'The narrow one, usually. A band held back until the last third gives a quarter-second riser stages it has no room for otherwise.'
        : 'Where it starts, where it lands on the frame of impact, and how narrow it is on the way.');
    slider(el, 'width (Q)', { min: 0.1, max: 30, step: 0.1, dp: 1,
      get: () => b.q ?? 4, set: (v) => { b.q = v; },
      title: 'Under about 3 is weather — a wash of air with no pitch in it. Over about 15 it sings, and the sweep reads as one voice climbing rather than as movement.' });
    slider(el, 'climbs from (Hz)', { min: 30, max: 4000, step: 10, dp: 0,
      get: () => b.from ?? 140, set: (v) => { b.from = v; },
      title: 'Every band leaves at the throw (or at its entry below) and lands at the impact. The RANGE is what differs.' });
    slider(el, '...to (Hz)', { min: 100, max: 16000, step: 50, dp: 0,
      get: () => b.to ?? 5200, set: (v) => { b.to = v; },
      title: 'Where it is on the frame the card lands. Below "climbs from" this band falls while the others climb — there is no clamp stopping it, and one descending band under two rising ones is a real sound. "Reverse the sweep" under Modulation is the whole bank doing it at once.' });
    slider(el, 'enters at (of the fall)', { max: 0.95, step: 0.01,
      get: () => b.at ?? 0, set: (v) => { b.at = v; },
      title: 'A share of the fall to wait before this band comes in. 0 is from the throw. The cheapest way to make a short riser feel staged.' });
  });

  // --- MODULATION ------------------------------------------------------------
  // Shared across the bank on purpose: bands sweeping on different curves is
  // three risers, not one.
  const modc = card(cols, 'sv-wb-imp', 'Modulation',
    'Shared by every band, because the bank has to read as one gesture. The skew decides whether it slides or approaches; the wobble decides whether it is being drawn or is under strain.');
  toggle(modc, 'reverse the sweep', () => r.reverse === true, (v) => { r.reverse = v; },
    'Flips every band end for end. Climbing is arrival; falling is the floor dropping out from under the card — the opposite feeling from the same bank. Shared, because half of it going each way is a chord rather than a sweep. One band alone can be made to fall by putting its "to" below its "from".');
  slider(modc, 'sweep skew', { min: 0.2, max: 4, step: 0.05,
    get: () => r.curve ?? 1.35, set: (v) => { r.curve = v; },
    title: '1 is the plain exponential — even in octaves, so even to the ear. Under 1 opens early and hangs at the top; over 1 holds low and rushes the last third, which is the one that reads as an approach rather than a slide.' });
  slider(modc, 'wobble (semitones)', { max: 6, step: 0.05,
    get: () => r.wobbleDepth ?? 0, set: (v) => { r.wobbleDepth = v; },
    title: '0 is a clean sweep. Windowed to nothing at both ends — a wobble still going at the landing would leave the bank somewhere other than where it was aimed, and arriving exactly on the impact is the point of the whole thing.' });
  slider(modc, '...at (cycles/s)', { max: 40, step: 0.5, dp: 1,
    get: () => r.wobbleFrom ?? 0, set: (v) => { r.wobbleFrom = v; },
    title: 'The wobble rate at the throw.' });
  slider(modc, '...rising to', { max: 60, step: 0.5, dp: 1,
    get: () => r.wobbleTo ?? 0, set: (v) => { r.wobbleTo = v; },
    title: 'And at the landing. A wobble that speeds up as it climbs is the oldest trick in the form — its phase is integrated rather than played by an LFO, which would click when its rate was ramped.' });
  slider(modc, 'resolution (points)', { min: 4, max: 160, step: 1, dp: 0,
    get: () => r.steps ?? 48, set: (v) => { r.steps = v; },
    title: 'How finely the sweep and the wobble are scheduled. RESOLUTION, not shape: it has to clear a couple of points per wobble cycle or the wobble aliases into a wrong, slower one. This many points per band per card.' });

  // --- VARIATION -------------------------------------------------------------
  const vary = (r.vary ??= {});
  const vc = card(cols, 'sv-wb-imp', 'Variation per throw',
    'Three cards a level-up and twenty level-ups a run is sixty of these, and sixty identical risers stop being a sound and become a tic. Every number here is rolled once per throw and shared down the bank, so what varies is the riser rather than the bands’ relationship to each other. None of it touches the timing — the length is the fall.');
  slider(vc, 'register (semitones)', { max: 12, step: 0.25, dp: 2,
    get: () => vary.pitch ?? 0, set: (v) => { vary.pitch = v; },
    title: 'The whole bank transposed, either way. The one that does most of the work: same gesture, different register. All of these at 0 makes every trigger identical, which is worth hearing once to know what the variation is buying.' });
  slider(vc, 'spread', { max: 0.4, step: 0.005, dp: 3,
    get: () => vary.spread ?? 0, set: (v) => { vary.spread = v; },
    title: 'Each END of each band nudged independently on top of the transpose, so a throw varies how far each band TRAVELS and not just where it sits. Wants to be the small one — past a little of it they stop being the same three bands.' });
  slider(vc, 'weight', { max: 0.5, step: 0.01,
    get: () => vary.level ?? 0, set: (v) => { vary.level = v; },
    title: 'As a fraction of the level below.' });
  slider(vc, 'wobble speed', { max: 1, step: 0.01,
    get: () => vary.wobble ?? 0, set: (v) => { vary.wobble = v; },
    title: 'One factor for both ends of the wobble ramp, so a bank that varies its speed keeps its acceleration. Two rolls would sometimes invert it.' });

  // --- THE SHAPE -------------------------------------------------------------
  const shape = card(cols, 'sv-wb-imp', 'Its shape in time',
    'The two numbers that scale with the fall rather than fighting it. Both are shares, not seconds — a fall retuned from a quarter-second to two-thirds of one keeps this shape exactly.');
  dbSlider(shape, 'level', { get: () => r.gain ?? 0.14, set: (v) => { r.gain = v; } });
  slider(shape, 'swells to', { min: 0.2, max: 4, step: 0.05,
    get: () => r.swell ?? 1.6, set: (v) => { r.swell = v; },
    title: 'How much louder it is at the impact than at the top of its attack. 1 is a flat level — the filter still opens, but a build with no weight behind it reads as a sweep rather than as a build.' });
  slider(shape, 'attack (of the fall)', { min: 0.02, max: 0.95, step: 0.01,
    get: () => r.fadeIn ?? 0.3, set: (v) => { r.fadeIn = v; },
    title: 'A SHARE of the fall, not seconds — the one unit here that differs from the boss riser’s, and deliberately. A fixed attack right for a two-second arrival never reaches its own level inside a quarter-second one.' });
  slider(shape, 'cut over (s)', { min: 0.005, max: 0.3, step: 0.005, dp: 3,
    get: () => r.fadeOut ?? 0.035, set: (v) => { r.fadeOut = v; },
    title: 'How fast the landing takes it away. Short: being cut IS the gesture, and anything long enough to hear is a tail over the tier’s sting.' });

  const live = document.createElement('div');
  live.className = 'sub';
  live.style.margin = '9px 0 0';
  live.textContent = cardRiserCount()
    ? `${cardRiserCount()} sounding right now`
    : 'nothing sounding — one per card in the air, up to the hand';
  shape.appendChild(live);
}

function renderBoom() {
  const b = CONFIG.boss?.boom;
  const goo = CONFIG.fx?.goo?.groups?.boom;
  els.name.textContent = 'The boss going up';
  els.via.textContent = 'CONFIG.boss.boom  \u2192  CONFIG.fx.goo.groups.boom  \u2192  CONFIG.emitters.bossBoom';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();
  if (!b || !goo) {
    card(cols, 'sv-wb-imp wide', 'Not in this build',
      'CONFIG.boss.boom or the `boom` goo group is missing, so there is nothing to tune.');
    return;
  }

  // --- WHEN, AND FIRING IT ---------------------------------------------------
  const when = card(cols, 'sv-wb-imp', 'The moment',
    'It goes off before the trophy photo, not on the killing blow \u2014 the shutter is derived from the kill shot, so retuning the beat moves this with it.');
  toggle(when, 'bosses go up', () => b.enabled, (v) => { b.enabled = v; },
    'Off, a boss dies the way it did before: wreckage and a hole.');
  slider(when, 'before the photo', { max: 1.2, step: 0.02, get: () => b.lead ?? 0.34, set: (v) => { b.lead = v; },
    title: 'Wall seconds. Set a little longer than the waves take to finish, so the cloud is fully open and just beginning to settle in the picture.' });

  const fireRow = document.createElement('div');
  fireRow.className = 'sv-wb-f';
  const fireLab = document.createElement('label');
  fireLab.textContent = 'try it';
  const fireBtn = document.createElement('button');
  fireBtn.className = 'sv-wb-btn sv-stage-fire';
  fireBtn.textContent = '\u25b6 Blow up the seal';
  fireBtn.title = 'Detonates a real explosion on the parked seal, at the size the slider below says. The world is held still with the panel open, so it blooms across a frozen ocean exactly as it does in the shot.';
  fireBtn.addEventListener('click', () => {
    const a = stageAnchor();
    resetBossBooms();
    // A BODY WITH NO ANIMAL IN IT. fireBossBoom measures a hitbox, falls back
    // to a visual, and falls back again to a point and a radius — which is all
    // three of the things a test body can honestly provide. Same shape the look
    // sheet's `stand()` builds, and it goes through the real colour path.
    fireBossBoom({
      mesh: { position: { x: a.x, y: a.y } },
      radius: boomTestRadius,
      assetKey: '__stage__',
      vx: 0,
      vy: 0,
    });
  });
  fireRow.append(fireLab, fireBtn);
  when.appendChild(fireRow);
  slider(when, 'test body radius', { min: 1, max: 20, step: 0.5, dp: 1,
    get: () => boomTestRadius, set: (v) => { boomTestRadius = v; },
    title: 'How big the animal under the test explosion is. The roster measures about 12.5 (kraken) to 16.8 (megalodon). Not saved \u2014 it is a staging knob, not a value.' });

  // --- THE CLOUD -------------------------------------------------------------
  const cloud = card(cols, 'sv-wb-imp', 'The cloud',
    'Everything that moves the whole thing at once. Every number in the effect is a multiple of the measured body, so these are the only absolute sizes in it.');
  slider(cloud, 'size', { min: 0.2, max: 3, step: 0.05, get: () => b.size ?? 1, set: (v) => { b.size = v; },
    title: 'Rings and lobes together \u2014 the one lever that means bigger without changing the shape.' });
  slider(cloud, 'keeps opening', { max: 3, step: 0.05, get: () => b.speed ?? 1, set: (v) => { b.speed = v; } });
  slider(cloud, 'brightness', { max: 4, step: 0.05, get: () => b.glow ?? 1, set: (v) => { b.glow = v; },
    title: 'The cloud is ADDITIVE, so this is a lift on top of one. Past about 0.6 the core blows to flat white and the bloom welds across it.' });
  slider(cloud, 'lightness', { min: 0.2, max: 1, step: 0.02, get: () => b.tint?.lightness ?? 0.82, set: (v) => { (b.tint ??= {}).lightness = v; },
    title: 'The boss keeps its HUE and gets this value. Every boss in the roster is a near-black hide, and smoke tinted with one is a black cloud on dark water.' });
  slider(cloud, 'saturation lift', { max: 3, step: 0.05, get: () => b.tint?.saturation ?? 1.4, set: (v) => { (b.tint ??= {}).saturation = v; },
    title: 'Scaled, never floored \u2014 a grey animal has to stay grey, or the megalodon gets a bright red explosion off a meaningless hue.' });
  slider(cloud, '...its ceiling', { max: 1, step: 0.05, get: () => b.tint?.maxSaturation ?? 0.55, set: (v) => { (b.tint ??= {}).maxSaturation = v; } });
  slider(cloud, 'smallest body', { min: 0.5, max: 8, step: 0.1, dp: 1, get: () => b.minRadius ?? 3, set: (v) => { b.minRadius = v; } });
  slider(cloud, '...and largest', { min: 3, max: 20, step: 0.5, dp: 1, get: () => b.maxRadius ?? 17, set: (v) => { b.maxRadius = v; },
    title: 'The clamp the measured body passes through. Keep the range wide: a ceiling inside the roster band makes every boss go up the same size.' });

  // --- THE SURFACE -----------------------------------------------------------
  // The shared card, pointed at the boom's own group — shared rather than
  // copied for the reason the Burst card below is: these rows are the only
  // controls the goo groups have anywhere in the game, and a second set of them
  // is a set of numbers that quietly stops agreeing with the first. The
  // tooltips are overridden because each one here is about what ADDITIVE does,
  // and this is the group that is additive.
  surfaceCard(cols, goo, {
    shared: CONFIG.fx.goo,
    sub: 'The shared metaball pass (CONFIG.fx.goo.groups.boom). These are the splats\u2019 relationship to each other, never a size \u2014 for bigger, use the cloud\u2019s own size above. Every substance in the game is on the goo row of the rail.',
    notes: {
      additive: 'Additive. Off, the cloud hides the animal it came out of \u2014 which is what it did until the body stopped reading through its own explosion.',
      soft: 'Low is a drawn cel edge, high is mist. This is where the toon read lives now that additive light cannot draw a dark outline.',
      rim: 'On an additive surface a negative rim cannot darken anything \u2014 light has no way to be darker than the water.',
      rimWidth: 'A band of DENSITY, not a distance. Wide, it lights the dip between every pair of lobes and the mass renders as fifty overlapping circles.',
    },
  });

  // --- RANDOMNESS ------------------------------------------------------------
  const org = card(cols, 'sv-wb-imp', 'How random it is',
    'Rolled per explosion, so no two kills give the same cloud. The lumps are shared by every ring \u2014 per-lobe noise averages back into a circle.');
  slider(org, 'lumpiness', { max: 0.8, step: 0.02, get: () => b.organic?.lumps ?? 0, set: (v) => { (b.organic ??= {}).lumps = v; },
    title: '0 is a wheel of evenly spaced circles. Where a bulge pushes neighbours apart their lobes grow by the same factor, so fusion survives any depth.' });
  slider(org, 'walks off centre', { max: 0.5, step: 0.02, get: () => b.organic?.lean ?? 0, set: (v) => { (b.organic ??= {}).lean = v; } });
  slider(org, 'a ring spread over', { max: 0.09, step: 0.005, dp: 3, get: () => b.organic?.stagger ?? 0, set: (v) => { (b.organic ??= {}).stagger = v; },
    title: 'Seconds. Without it a ring pops into existence on one frame, which is the tell that this is a schedule and not an explosion.' });
  slider(org, 'lobe size scatter', { max: 0.6, step: 0.02, get: () => b.organic?.lobeVary ?? 0, set: (v) => { (b.organic ??= {}).lobeVary = v; } });
  slider(org, 'brightness scatter', { max: 0.8, step: 0.02, get: () => b.organic?.toneVary ?? 0, set: (v) => { (b.organic ??= {}).toneVary = v; } });

  // --- THE OUTERMOST RING ----------------------------------------------------
  const w3 = b.waves?.[3];
  if (w3) {
    const ring = card(cols, 'sv-wb-imp', 'The outermost ring',
      'The one the eye reads as \u201chow big was that\u201d. The other three rings are a table in the config \u2014 they are the shape, and a panel with forty sliders is a panel nobody opens.');
    slider(ring, 'reach', { min: 0.4, max: 3.5, step: 0.05, get: () => w3.ring ?? 1, set: (v) => { w3.ring = v; },
      title: 'x the body.' });
    slider(ring, 'lobes around it', { min: 4, max: 40, step: 1, dp: 0, get: () => w3.puffs ?? 8, set: (v) => { w3.puffs = Math.round(v); } });
    slider(ring, 'lobe size', { min: 0.05, max: 0.6, step: 0.01, get: () => w3.lobe ?? 0.3, set: (v) => { w3.lobe = v; } });
    slider(ring, 'how dark the edge', { min: 0.2, max: 2.5, step: 0.05, get: () => w3.tone ?? 1, set: (v) => { w3.tone = v; },
      title: 'Rides on the glow rather than the colour: emit() lifts a dark tint clear of the water before it uses it, so a ramp authored into the colour quietly would not exist.' });
  }

  // --- THE COLOURS -------------------------------------------------------------
  const pal = b.palette;
  const bp = CONFIG.bodyPalette;
  if (pal) {
    const cols2 = card(cols, 'sv-wb-imp', 'Every colour it had',
      'The cloud is tinted from the animal\u2019s own shaders \u2014 the texture averages, the '
      + 'material colours, the bioluminescent uniforms, the Look panel\u2019s signature \u2014 '
      + 'weighted by how much of the body wears each one, plus whatever elemental status was on '
      + 'it. One hex per asset could not do this: the megalodon keeps its colour in a texture '
      + 'behind four white materials and the orca keeps its in shader uniforms behind one.');
    toggle(cols2, 'read the whole body', () => pal.enabled, (v) => { pal.enabled = v; },
      'Off is the single tint this shipped with: the Look signature, lifted.');
    slider(cols2, 'how much reaches the cloud', { max: 1, step: 0.02, get: () => pal.spread ?? 0.75, set: (v) => { pal.spread = v; },
      title: 'How far a puff moves from the body\u2019s mean toward its own swatch. 0 is one flat colour; 1 is the full palette with nothing holding it together.' });
    slider(cols2, 'colour regions round it', { min: 0.5, max: 6, step: 0.1, dp: 1, get: () => pal.bands ?? 2.5, set: (v) => { pal.bands = v; },
      title: 'How many times the palette is walked around the cloud. Keep it fractional \u2014 a whole number closes the loop on itself and puts the same colour on both sides of the seam.' });
    slider(cols2, 'and how they mingle', { max: 0.6, step: 0.02, get: () => pal.jitter ?? 0.18, set: (v) => { pal.jitter = v; },
      title: 'Scatter on the pick, so a boundary between two regions is a mingling rather than a line. Past about a third it becomes the confetti that picking by position exists to avoid.' });
    if (bp) {
      slider(cols2, 'how many colours', { min: 1, max: 10, step: 1, dp: 0, get: () => bp.max ?? 6, set: (v) => { bp.max = Math.round(v); },
        title: 'Past about six the extras are all within a few percent of each other and only make the cloud slower to work out.' });
      slider(cols2, '...merged this close', { max: 0.3, step: 0.01, get: () => bp.merge ?? 0.08, set: (v) => { bp.merge = v; },
        title: 'Compared in HSL, with hue counting for only as much as saturation makes hue mean \u2014 the megalodon\u2019s hue is a meaningless 0 and so is the crab\u2019s.' });
      slider(cols2, 'trust the texture', { max: 3, step: 0.05, get: () => (bp.weights ??= {}).texture ?? 1.4, set: (v) => { (bp.weights ??= {}).texture = v; },
        title: 'For a textured body the map IS the colour, and the white material.color over it is a multiplier of 1 that says nothing.' });
      slider(cols2, '...the skin', { max: 3, step: 0.05, get: () => (bp.weights ??= {}).skin ?? 1.1, set: (v) => { (bp.weights ??= {}).skin = v; },
        title: 'The bioluminescent pattern\u2019s colours. For the orca this is the entire animal.' });
      slider(cols2, '...the tuned look', { max: 3, step: 0.05, get: () => (bp.weights ??= {}).look ?? 1.2, set: (v) => { (bp.weights ??= {}).look = v; },
        title: 'The Look panel\u2019s signature, or the authored colour behind it \u2014 the one colour on the list a person chose on purpose.' });
      slider(cols2, '...and the element', { max: 5, step: 0.05, get: () => (bp.weights ??= {}).element ?? 2.2, set: (v) => { (bp.weights ??= {}).element = v; },
        title: 'A boss dying with venom on it IS a green animal, and no material on the body says so. The only source here that is about this individual rather than the species.' });
    }
    slider(cols2, 'keeps its light-to-dark order', { max: 1, step: 0.02, get: () => b.tint?.lightnessSpread ?? 0.55, set: (v) => { (b.tint ??= {}).lightnessSpread = v; },
      title: 'At 0 every swatch is lifted to one lightness, which flattens a palette into the same colour several times. This keeps a share of each swatch\u2019s distance from the body\u2019s mean.' });
    slider(cols2, '...floored at', { max: 1, step: 0.02, get: () => b.tint?.lightnessFloor ?? 0.42, set: (v) => { (b.tint ??= {}).lightnessFloor = v; },
      title: 'What stops the dark end going back under the water it was lifted out of.' });
    slider(cols2, '...and capped at', { min: 0.5, max: 1, step: 0.02, get: () => b.tint?.lightnessCeil ?? 0.9, set: (v) => { (b.tint ??= {}).lightnessCeil = v; },
      title: 'HSL at 1.0 is white whatever the hue says, so a pale swatch pushed to the top comes out colourless rather than bright.' });
  }

  // --- THE EDGE ---------------------------------------------------------------
  const rim = b.rim;
  if (rim) {
    const edge = card(cols, 'sv-wb-imp', 'Struck off the edge',
      'The bands are laid along the animal\u2019s measured silhouette and pushed OUTWARD from it, '
      + 'so nothing is born inside the outline. Off, they are rings about its centroid and the '
      + 'brightest part of the cloud lands on the boss the photograph is of.');
    toggle(edge, 'follow the outline', () => rim.enabled, (v) => { rim.enabled = v; },
      'Off is the old shape: concentric rings on the body\u2019s middle.');
    slider(edge, 'sits off the skin', { max: 0.4, step: 0.01, get: () => rim.hug ?? 0.02, set: (v) => { rim.hug = v; },
      title: 'Where the INNERMOST band lands, x the body radius, measured outward from the outline. 0 is exactly on it \u2014 which is what turns the white-hot first wave into a rim light tracing the animal.' });
    slider(edge, 'and reaches', { min: 0.1, max: 1.6, step: 0.05, get: () => rim.reach ?? 0.6, set: (v) => { rim.reach = v; },
      title: 'Where the OUTERMOST band lands. The number to move if the aura is too thick to see the boss through, or too thin to read as an explosion.' });
    slider(edge, 'how much outline is kept', { max: 1, step: 0.05, get: () => rim.round ?? 0.25, set: (v) => { rim.round = v; },
      title: '0 traces the collision shape exactly, which is a diagram of the hitbox. 1 is a circle, which is the old effect. Between them is the animal\u2019s mass without the accidents of where its spheres were placed.' });
    slider(edge, 'smoothing passes', { max: 6, step: 1, dp: 0, get: () => rim.smooth ?? 2, set: (v) => { rim.smooth = Math.round(v); },
      title: 'A hitbox is a chain of overlapping balls and every seam between two of them is a cusp \u2014 a lobe born on one points its normal off at an angle.' });
    slider(edge, 'lobes overlap by', { min: 0.2, max: 1, step: 0.02, get: () => rim.overlap ?? 0.62, set: (v) => { rim.overlap = v; },
      title: 'How many lobes a band gets is DERIVED from its own perimeter, not typed \u2014 a fixed count beads a crab and crowds a megalodon. 1 is lobes exactly touching, which the metaball pass renders as beads.' });
    slider(edge, '...up to', { min: 8, max: 96, step: 1, dp: 0, get: () => rim.maxPuffs ?? 64, set: (v) => { rim.maxPuffs = Math.round(v); },
      title: 'The particle backstop. A band pinned here has stopped being derived and is a fixed count on a perimeter nobody measured \u2014 npm run test:boom fails if any band reaches it.' });
  }

  // --- THE SHOCKWAVE ---------------------------------------------------------
  const sc = b.shock;
  if (sc) {
    const shock = card(cols, 'sv-wb-imp', 'The shockwave',
      'Not goo \u2014 the shared telegraph ring (systems/organicRing.js), because goo would fuse into the cloud it is outrunning. Both rings are gone before the shutter.');
    toggle(shock, 'shockwave', () => sc.enabled, (v) => { sc.enabled = v; });
    slider(shock, 'brightness', { max: 8, step: 0.1, dp: 1, get: () => sc.glow ?? 3.2, set: (v) => { sc.glow = v; } });
    slider(shock, 'how white-hot', { max: 1, step: 0.02, get: () => sc.white ?? 0.72, set: (v) => { sc.white = v; },
      title: '0 is the boss\u2019s own colour. The front says FORCE and the slow ring behind it says which animal it was.' });
    slider(shock, 'how ragged', { max: 0.4, step: 0.01, get: () => sc.wobble ?? 0.26, set: (v) => { sc.wobble = v; },
      title: 'x the body, in world units \u2014 but capped as a fraction of the ring\u2019s CURRENT radius, so it only spends the full amount once the front is wide.' });
    slider(shock, 'thickness varies', { max: 1.2, step: 0.05, get: () => sc.massVar ?? 0, set: (v) => { sc.massVar = v; } });
    slider(shock, 'decelerates', { min: 0.5, max: 5, step: 0.1, dp: 1, get: () => sc.ease ?? 2.6, set: (v) => { sc.ease = v; } });
    const r0 = sc.rings?.[0];
    if (r0) {
      slider(shock, 'front reach', { min: 0.6, max: 4, step: 0.05, get: () => r0.to ?? 2.7, set: (v) => { r0.to = v; },
        title: 'x the body. Past about 3 at fight scale it stops reading as coming off the animal.' });
      slider(shock, '...over', { min: 0.08, max: 0.34, step: 0.01, get: () => r0.seconds ?? 0.26, set: (v) => { r0.seconds = v; },
        title: 'Wall seconds, like everything else racing the shutter.' });
      slider(shock, '...rubbed out from', { max: 0.95, step: 0.05, get: () => r0.eat ?? 0.45, set: (v) => { r0.eat = v; },
        title: 'When the trailing edge starts eating the front from behind.' });
    }
  }

  // --- THE BODY LETTING GO -----------------------------------------------------
  // A different moment from everything above it — the explosion fires BEFORE the
  // photograph and this fires on the frame after it, when the visual goes back
  // to the pool. It lives in this view anyway because it is the same beat and a
  // rail row of its own would be a third synthetic entry for four sliders.
  const dis = CONFIG.boss?.dissolve;
  const disEm = CONFIG.emitters?.bossDissolve;
  if (dis) {
    const melt = card(cols, 'sv-wb-imp', 'The body letting go',
      'On the frame the mesh is handed back to the pool, the boss is replaced by a cloud of '
      + 'its own surface \u2014 a point per sample, each one wearing the texel it came off. It '
      + 'is what stops the largest thing in the run vanishing on a cut.');
    toggle(melt, 'dissolve the body', () => dis.enabled, (v) => { dis.enabled = v; },
      'Off, the boss simply disappears under its own wreckage, which is what it did.');
    slider(melt, 'points', { min: 200, max: 3000, step: 50, dp: 0, get: () => dis.points ?? 1400, set: (v) => { dis.points = Math.round(v); },
      title: 'The one number that costs something \u2014 they come out of the shared pool, and the frame that samples them walks this many triangles through the skeleton.' });
    slider(melt, 'point size', { min: 0.2, max: 3, step: 0.05, get: () => dis.sizeMul ?? 1, set: (v) => { dis.sizeMul = v; },
      title: 'x the emitter\u2019s own band. Dense enough that the cloud is a silhouette rather than a scatter is the whole job.' });
    slider(melt, 'brightness', { max: 1.5, step: 0.02, get: () => dis.glow ?? 0.35, set: (v) => { dis.glow = v; },
      title: 'Well under 1: every particle is multiplied by CONFIG.bloom.particleOverdrive (3.4) on the way in, which is right for a spark and wrong for a hide. At 1 the megalodon\u2019s mouth blows out to flat white.' });
    slider(melt, 'the silhouette opens', { max: 5, step: 0.05, get: () => dis.push ?? 1.8, set: (v) => { dis.push = v; },
      title: 'Per unit of distance from the middle, so the edge drifts and the centre stays. Read it against the emitter\u2019s drag \u2014 travel is push \u00f7 drag, and under about a tenth of the body it is a stencil that dims rather than a body letting go.' });
    slider(melt, '...and turns', { max: 2, step: 0.05, get: () => dis.swirl ?? 0.5, set: (v) => { dis.swirl = v; },
      title: 'At 0 every point moves along its own spoke and the moment before the drag catches them reads as a zoom.' });
    slider(melt, 'edge frays', { max: 1, step: 0.02, get: () => dis.jitter ?? 0.35, set: (v) => { dis.jitter = v; } });
    slider(melt, 'carries its drift', { max: 1, step: 0.02, get: () => dis.inherit ?? 0.25, set: (v) => { dis.inherit = v; },
      title: 'A share of what the animal was doing. A cloud hanging exactly where the body was reads as an effect played at a coordinate.' });
    slider(melt, 'darkest point', { max: 0.6, step: 0.01, get: () => dis.minPeak ?? 0.22, set: (v) => { dis.minPeak = v; },
      title: 'A floor on the PEAK channel, which keeps the hue and the point\u2019s place in the body\u2019s own light-to-dark order. Every boss is a near-black hide and an untouched texel is a particle nobody can see.' });
    if (disEm) {
      slider(melt, 'how hard the water holds', { min: 1, max: 16, step: 0.5, dp: 1,
        get: () => (Array.isArray(disEm.drag) ? disEm.drag[0] : disEm.drag) ?? 7.5,
        set: (v) => { disEm.drag = v; },
        title: 'High \u2014 the points are a body coming apart, not something thrown. At the explosion\u2019s 2.0 they are still visibly travelling when the cloud is meant to be hanging still.' });
      if (Array.isArray(disEm.life)) {
        pairSlider(melt, 'and how long they last', disEm.life, 6, 0.1, 1);
      }
    }
  }

  // --- THE PUFF --------------------------------------------------------------
  // The ordinary emitter card, on the ordinary emitter. Everything above places
  // and scales these; this is what is being placed.
  burstCard(cols, 'bossBoom');
}

function renderKillLight() {
  const L = CONFIG.boss?.light;
  els.name.textContent = 'The light on the kill';
  els.via.textContent = 'CONFIG.boss.light  \u2192  CONFIG.damageGlow.sources.killLightHero / killLightSubject';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();
  if (!L) {
    card(cols, 'sv-wb-imp wide', 'Not in this build',
      'CONFIG.boss.light is missing, so there is nothing to tune.');
    return;
  }
  const glow = CONFIG.damageGlow?.sources ?? {};

  // --- WHEN ------------------------------------------------------------------
  const when = card(cols, 'sv-wb-imp', 'The moment',
    'It is up before the SMOKE, not before the shutter \u2014 the cloud is the brightest thing in '
    + 'the frame either side of the picture, and a key still climbing under it is one nobody can '
    + 'tell was switched on. The lead is the rise plus the explosion\u2019s own, derived.');
  toggle(when, 'light the kill', () => L.enabled, (v) => { L.enabled = v; },
    'Off, the trophy is two dark bodies on dark water, which is what it was.');
  slider(when, 'comes up over', { min: 0.1, max: 1.6, step: 0.05, get: () => L.rise ?? 0.55, set: (v) => { L.rise = v; },
    title: 'Wall seconds. This IS the lead: it has to be flat by the time the picture is taken.' });
  slider(when, 'holds for', { max: 3, step: 0.05, get: () => L.hold ?? 1.1, set: (v) => { L.hold = v; },
    title: 'Has to outlast the shutter and the print\u2019s flight, or the frame goes flat under a still image.' });
  slider(when, 'and goes out over', { min: 0.1, max: 2.5, step: 0.05, get: () => L.fall ?? 0.8, set: (v) => { L.fall = v; },
    title: 'Slower than the rise \u2014 a light going out fast reads as a switch, and this one is the moment ending.' });

  // --- THE SHAFT -------------------------------------------------------------
  const s = L.shaft;
  if (s) {
    const shaft = card(cols, 'sv-wb-imp', 'The hero shaft',
      'Overlapping additive blades, some in front of the seal and some behind it \u2014 that split '
      + 'is what makes it read as volume rather than as a decal. No real light: half the roster is '
      + 'unlit MeshBasicMaterial and a SpotLight would miss it entirely.');
    toggle(shaft, 'shaft', () => s.enabled, (v) => { s.enabled = v; });
    slider(shaft, 'brightness', { min: 0.4, max: 3, step: 0.05, get: () => s.overdrive ?? 1.5, set: (v) => { s.overdrive = v; },
      title: 'Pushed past 1 on its peak channel so it crosses the bright pass. Under about 1 the cone is there and does not bloom, which reads as a grey wedge.' });
    slider(shaft, 'width where it lands', { min: 2, max: 26, step: 0.5, dp: 1, get: () => s.width ?? 11, set: (v) => { s.width = v; } });
    slider(shaft, 'length', { min: 8, max: 60, step: 1, dp: 0, get: () => s.height ?? 30, set: (v) => { s.height = v; },
      title: 'World units, hung by its BOTTOM edge on the seal. It wants to run off the top of the frame \u2014 a visible top edge inside the crop reads as a quad.' });
    slider(shaft, 'rake', { max: 0.6, step: 0.01, get: () => s.tilt ?? 0.17, set: (v) => { s.tilt = v; },
      title: 'Radians. Upright is a spotlight rig; leaned over is light arriving from somewhere.' });
    slider(shaft, 'taper at the top', { min: 0.05, max: 1, step: 0.01, get: () => s.topWidth ?? 0.3, set: (v) => { s.topWidth = v; },
      title: 'As a share of the quad. Narrow where the light comes from and wide where it lands is what makes it a cone rather than a stripe.' });
    slider(shaft, 'eaten going down', { max: 4, step: 0.05, get: () => s.falloff ?? 1.4, set: (v) => { s.falloff = v; },
      title: 'A god ray reads as one because you can see it running out. Even brightness down its length is a wall.' });
    slider(shaft, '...but still arrives', { max: 1, step: 0.02, get: () => s.endLevel ?? 0.45, set: (v) => { s.endLevel = v; },
      title: 'How much is left at the landing. At 0 the cone is brightest thirty units above the seal and spent by the time it reaches it \u2014 a lit patch of empty water with a dark animal under it.' });
  }

  // --- THE POOL --------------------------------------------------------------
  const p = L.pool;
  if (p) {
    const pool = card(cols, 'sv-wb-imp', 'Where it lands',
      'A wide flat glow on the seal, so the cone arrives somewhere. Without it the shaft hangs in '
      + 'the water with nothing under it and reads as a curtain. Behind the animal, so it is lit '
      + 'against the pool rather than washed by it.');
    slider(pool, 'brightness', { max: 3, step: 0.05, get: () => p.overdrive ?? 1.2, set: (v) => { p.overdrive = v; } });
    slider(pool, 'strength', { max: 1.5, step: 0.02, get: () => p.opacity ?? 0.72, set: (v) => { p.opacity = v; } });
    slider(pool, 'across', { min: 2, max: 34, step: 0.5, dp: 1, get: () => p.width ?? 15, set: (v) => { p.width = v; } });
    slider(pool, 'and deep', { min: 1, max: 22, step: 0.5, dp: 1, get: () => p.height ?? 8, set: (v) => { p.height = v; },
      title: 'Wider than it is tall \u2014 light landing on a surface spreads along it.' });
  }

  // --- THE WASH --------------------------------------------------------------
  const w = L.wash;
  if (w) {
    const wash = card(cols, 'sv-wb-imp', 'The wash on the body',
      'BEHIND the dead animal, which is the whole trick: every boss is a near-black hide, and a '
      + 'glow laid OVER one brightens the hide and the water equally. Behind it, the hide is the '
      + 'one dark shape on a light field.');
    toggle(wash, 'wash', () => w.enabled, (v) => { w.enabled = v; });
    slider(wash, 'brightness', { max: 3, step: 0.05, get: () => w.overdrive ?? 1.1, set: (v) => { w.overdrive = v; } });
    slider(wash, 'strength', { max: 1.5, step: 0.02, get: () => w.opacity ?? 0.5, set: (v) => { w.opacity = v; } });
    slider(wash, 'spreads', { min: 0.8, max: 3, step: 0.05, get: () => w.spread ?? 1.55, set: (v) => { w.spread = v; },
      title: 'x the measured half-extents of the body, off the same hitbox the explosion is sized from \u2014 so a crab is lit wide and a megalodon long. Under about 1.2 it is inside the silhouette and lights the hide instead of standing behind it.' });
  }

  // --- THE LIFTS -------------------------------------------------------------
  const lift = card(cols, 'sv-wb-imp', 'The bodies themselves',
    'The only half that puts anything back INSIDE a silhouette. Both go through the shared '
    + 'damage-glow handle, which swaps in per-instance materials and carries the injected shaders '
    + 'across \u2014 a plain clone drops every one of them silently.');
  slider(lift, 'on the seal', { max: 2, step: 0.05, get: () => L.heroLift ?? 1, set: (v) => { L.heroLift = v; },
    title: 'x CONFIG.damageGlow.sources.killLightHero.peak.' });
  slider(lift, '...its peak', { max: 3, step: 0.05, get: () => glow.killLightHero?.peak ?? 0.8,
    set: (v) => { (glow.killLightHero ??= {}).peak = v; },
    title: 'The seal is a PALE body, so it needs less than the boss does \u2014 pushed up it blows out flat white in the print.' });
  slider(lift, 'on the boss', { max: 2, step: 0.05, get: () => L.subjectLift ?? 1, set: (v) => { L.subjectLift = v; } });
  slider(lift, '...its peak', { max: 3, step: 0.05, get: () => glow.killLightSubject?.peak ?? 0.35,
    set: (v) => { (glow.killLightSubject ??= {}).peak = v; },
    title: 'Taken as EMISSIVE, which is light added on top of the shading. Past about a third of a stop the boss stops being a lit body and becomes a flat coloured cutout in the shape of the animal, hue and all.' });
}

function pairSlider(host, label, pair, max, step, dp) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f';
  const lab = document.createElement('label');
  lab.textContent = label;
  const lo = document.createElement('input');
  const hi = document.createElement('input');
  const num = document.createElement('input');
  num.className = 'sv-wb-num';
  num.readOnly = true;
  const paint = () => { num.value = `${Number(pair[0]).toFixed(dp)}–${Number(pair[1]).toFixed(dp)}`; };
  for (const [input, idx] of [[lo, 0], [hi, 1]]) {
    input.type = 'range';
    input.autocomplete = 'off';
    input.min = 0; input.max = max; input.step = step;
    input.value = pair[idx];
    input.addEventListener('input', () => { pair[idx] = Number(input.value); paint(); changed(); });
  }
  paint();
  row.append(lab, lo, hi, num);
  host.appendChild(row);
}

function pulseSvg(pulses) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 46');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'width:100%;height:46px;margin:2px 0 4px';
  const base = document.createElementNS(ns, 'line');
  base.setAttribute('x1', 0); base.setAttribute('x2', 300);
  base.setAttribute('y1', 42); base.setAttribute('y2', 42);
  base.setAttribute('stroke', 'rgba(255,255,255,0.14)');
  svg.appendChild(base);
  const release = CONFIG.haptics.mixing?.release ?? 70;
  const span = Math.max(120, pulses.reduce((m, p) => Math.max(m, p.delay + p.duration + release), 0));
  for (const p of pulses) {
    const x = (p.delay / span) * 300;
    const w = (p.duration / span) * 300;
    const rel = (release / span) * 300;
    const y = 42 - p.resolved * 34;
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', `${x},42 ${x},${y} ${x + w},${y} ${x + w + rel},42`);
    poly.setAttribute('fill', 'rgba(122,215,255,0.28)');
    poly.setAttribute('stroke', '#7ad7ff');
    svg.appendChild(poly);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// global shaping

function renderGlobal() {
  els.name.textContent = 'Global shaping';
  els.via.textContent = 'scales all 77 events';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();

  const fx = CONFIG.fx;
  const cam = card(cols, 'sv-wb-imp', 'Camera & time',
    'How every shake decays, and how often hit-stop is allowed to land at all.');
  slider(cam, 'max shake', { max: 1, get: () => fx.maxShake, set: (v) => { fx.maxShake = v; } });
  slider(cam, 'shake decay', { max: 0.005, step: 0.0001, dp: 4, get: () => fx.shakeDecay, set: (v) => { fx.shakeDecay = v; } });
  // The master switch, above the two numbers it governs. Off, no event starts
  // a stop at all — see CONFIG.fx.hitstopEnabled. The sliders stay live rather
  // than greying out: what you want mid-A/B is to set the scale you're about
  // to compare against while the freeze is still switched off.
  const stopRow = document.createElement('div');
  stopRow.className = 'sv-wb-f';
  const stopLab = document.createElement('label');
  stopLab.textContent = 'hit-stop';
  stopLab.title = 'Every hit-stop in the game. Off, the events keep their shake, glow, sound and rumble — only the freeze goes.';
  const stopBox = document.createElement('input');
  stopBox.type = 'checkbox';
  stopBox.autocomplete = 'off';
  stopBox.checked = fx.hitstopEnabled !== false;
  stopBox.addEventListener('change', () => {
    fx.hitstopEnabled = stopBox.checked;
    changed();
    camNote.textContent = noteText();
  });
  stopRow.append(stopLab, stopBox);
  cam.appendChild(stopRow);
  slider(cam, 'hitstop scale', { max: 1, get: () => fx.hitstopScale, set: (v) => { fx.hitstopScale = v; } });
  slider(cam, 'hitstop gap', { max: 2, step: 0.05, get: () => fx.hitstopCooldown, set: (v) => { fx.hitstopCooldown = v; } });
  // The gap used to be the answer here — one stop every 0.4s, whoever asked
  // first — and it is no longer the interesting one: CONFIG.fx.hitstopOnly now
  // decides WHICH events may ask at all, so the gap only separates repeats of
  // the few that can. Says the count rather than the names, because the list is
  // meant to stay short enough that a number is the alarming part.
  const stopList = Array.isArray(fx.hitstopOnly) ? fx.hitstopOnly.length : 0;
  const noteText = () => (fx.hitstopEnabled === false
    ? 'Hit-stop is OFF — these two are what it will come back at.'
    : stopList
      ? `Only ${stopList} event${stopList === 1 ? '' : 's'} may freeze the frame (CONFIG.fx.hitstopOnly). The gap separates repeats of those: one every ${fx.hitstopCooldown}s.`
      : `No guest list, so every event with a hit-stop competes for one every ${fx.hitstopCooldown}s — whoever asks first.`);
  const camNote = document.createElement('div');
  camNote.className = 'sv-wb-none';
  camNote.textContent = noteText();
  cam.appendChild(camNote);

  // One number over every sprite burst in the game. It lives here rather than
  // on the per-event Burst cards because it is the only control that is about
  // the SCREEN instead of about an event: the counts on those cards set how big
  // each burst is relative to the others, and this sets how much of all of them
  // there is. The goo is deliberately not on the same slider — see the note in
  // CONFIG.fx.spriteDensity.
  const par = card(cols, 'sv-wb-imp', 'Particle density',
    'How many sprite particles every burst throws, as a multiplier on the counts authored per event. The goo is not scaled by it.');
  slider(par, 'sprites', {
    min: 0.1, max: 1.5, step: 0.05,
    get: () => fx.spriteDensity ?? 1,
    set: (v) => { fx.spriteDensity = v; },
    title: 'Scales every emitter\'s count at once. 1 is the counts as authored; the floor of one particle per burst means nothing disappears entirely.',
  });
  const parNote = document.createElement('div');
  parNote.className = 'sv-wb-none';
  parNote.textContent = 'Applies on the next burst — bits already in the water live out their lives.';
  par.appendChild(parNote);

  const h = CONFIG.haptics;
  const hap = card(cols, 'sv-wb-hap', 'Rumble mix',
    'How overlapping rumbles sum, and the release tail that decides whether repeats fuse into a bed.');
  slider(hap, 'strength', { max: 2, step: 0.05, get: () => h.intensity ?? 1, set: (v) => { h.intensity = v; } });
  slider(hap, 'low motor', { step: 0.05, get: () => h.strongRatio ?? 1, set: (v) => { h.strongRatio = v; } });
  slider(hap, 'high motor', { step: 0.05, get: () => h.weakRatio ?? 0.45, set: (v) => { h.weakRatio = v; } });
  slider(hap, 'release', { max: 400, step: 5, dp: 0, get: () => (h.mixing ??= {}).release ?? 70, set: (v) => { (h.mixing ??= {}).release = v; } });
  slider(hap, 'auto full at', { min: 5, max: 150, step: 5, dp: 0, get: () => h.fullAtMs ?? 45, set: (v) => { h.fullAtMs = v; } });
  slider(hap, 'auto curve', { min: 0.2, max: 2, step: 0.05, get: () => h.curve ?? 0.6, set: (v) => { h.curve = v; } });

  const bus = (CONFIG.audio.bus ??= {});
  const au = card(cols, 'sv-wb-snd', 'Sound bus',
    'Filter, reverb and the ceiling every voice runs through. Full controls stay on the T panel.');
  slider(au, 'cutoff', { min: 20, max: 20000, step: 10, dp: 0, get: () => bus.filterHz ?? 20000, set: (v) => { bus.filterHz = v; } });
  slider(au, 'reverb mix', { get: () => bus.reverbMix ?? 0, set: (v) => { bus.reverbMix = v; } });
  slider(au, 'ceiling', { min: 0.1, get: () => (bus.comp ??= {}).ceiling ?? 0.95, set: (v) => { (bus.comp ??= {}).ceiling = v; } });

  // The celebration echo is shut for the whole run, which makes it the one
  // thing on this panel you cannot hear by moving its slider. So: hold it
  // open. Everything fired while this is down goes through the delay at the
  // level the T panel's `echo level` is set to, and letting go runs the same
  // fade-out gameplay gets.
  const echo = (bus.echo ??= {});
  const echoBtn = document.createElement('button');
  echoBtn.className = 'sv-wb-btn';
  echoBtn.textContent = 'hold echo open';
  echoBtn.title = 'Open the celebration delay for as long as this is held, to tune against';
  const shut = () => { setSfxEcho(false); echoBtn.textContent = 'hold echo open'; };
  echoBtn.addEventListener('pointerdown', () => {
    unlockAudio();
    if (echo.enabled === false) { echoBtn.textContent = 'echo is switched off'; return; }
    setSfxEcho(true);
    echoBtn.textContent = 'echo open — release to close';
  });
  // Released ANYWHERE, not just over the button: a pointerup that lands off
  // the control never fires on it, and the echo would stay open for the rest
  // of the session with nothing on screen saying so.
  echoBtn.addEventListener('lostpointercapture', shut);
  window.addEventListener('pointerup', shut);
  window.addEventListener('pointercancel', shut);
  au.appendChild(echoBtn);

  const rep = (CONFIG.audio.repetition ??= {});
  const cr = card(cols, 'sv-wb-snd', 'Crowding',
    'Each rapid repeat of one sound plays quieter than the last. This is what keeps a wall of hits reading as a wall rather than as static.');
  slider(cr, 'recovery', { min: 0.05, max: 2, step: 0.05, get: () => rep.recovery ?? 0.5, set: (v) => { rep.recovery = v; } });
  slider(cr, 'strength', { max: 2, step: 0.05, get: () => rep.strength ?? 0.35, set: (v) => { rep.strength = v; } });
  slider(cr, 'gap jitter', { max: 0.9, get: () => CONFIG.audio.sfxGapJitter ?? 0.35, set: (v) => { CONFIG.audio.sfxGapJitter = v; } });

  // The two radii are the PRIORITY block's, not the falloff's, and one card
  // carries both jobs because they are one geometry — see the note on
  // CONFIG.audio.falloff. Moving `near` here moves what wins a voice and what
  // is mixed at full level together, which is the only way they can be right.
  const prio = (CONFIG.audio.priority ??= {});
  const fall = (CONFIG.audio.falloff ??= {});
  const di = card(cols, 'sv-wb-snd', 'Distance',
    'Sound inside the near radius is at full level and never loses its voice. Past it the level falls to the far level, reached at the far radius. UI, the level-up and the death have no position and are never attenuated.');
  slider(di, 'near radius', { max: 60, step: 1, dp: 0, get: () => prio.nearRadius ?? 18, set: (v) => { prio.nearRadius = v; } });
  slider(di, 'far radius', { min: 10, max: 220, step: 1, dp: 0, get: () => prio.farRadius ?? 70, set: (v) => { prio.farRadius = v; } });
  slider(di, 'far level', { max: 1, step: 0.005, dp: 3, get: () => fall.minGain ?? 0.125, set: (v) => { fall.minGain = v; } });
  slider(di, 'curve', { min: 0.2, max: 4, step: 0.05, get: () => fall.curve ?? 1.8, set: (v) => { fall.curve = v; } });
}

// ---------------------------------------------------------------------------
// the library

async function loadLibrary() {
  try {
    const res = await fetch('/__sfx-list');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    library = data.files ?? [];
    libraryError = '';
  } catch (err) {
    // Expected in a production build, which has no dev server to ask.
    library = [];
    libraryError = 'No dev server — the file list is only available under npm run dev.';
  }
}

async function auditionFile(src, gain) {
  unlockAudio();
  try {
    const ctx = getAudioContext();
    const buf = await ctx.decodeAudioData(await (await fetch(src)).arrayBuffer());
    const node = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = gain ?? 0.3;
    node.buffer = buf;
    node.connect(g).connect(ctx.destination);
    node.start();
  } catch (err) {
    console.warn(`[workbench] could not audition ${src} —`, err?.message ?? err);
  }
}

function renderLibrary() {
  const list = els.liblist;
  if (!list) return;
  const q = els.libsearch.value.trim().toLowerCase();
  const voice = voiceOf(current);
  const vdef = voice ? CONFIG.sfx[voice] : null;
  const mine = new Set(srcsOf(vdef));
  list.replaceChildren();

  let shown = 0;
  for (const f of library) {
    const voices = voicesUsingFile(f.src);
    const others = nonVoiceUsersOfFile(f.src);
    const unused = !voices.length && !others.length;
    if (libFilter === 'unused' && !unused) continue;
    if (libFilter === 'here' && !mine.has(f.src)) continue;
    if (q && !f.file.toLowerCase().includes(q)) continue;
    shown++;

    const row = document.createElement('div');
    row.className = 'sv-wb-lib' + (mine.has(f.src) ? ' inset' : '');
    const top = document.createElement('div');
    top.className = 'top';
    const fn = document.createElement('span');
    fn.className = 'fn';
    fn.textContent = f.file;
    fn.title = f.src;
    const kb = document.createElement('span');
    kb.className = 'kb';
    kb.textContent = `${f.kb}k`;
    const play = document.createElement('button');
    play.className = 'sv-wb-btn';
    play.textContent = '▶';
    play.addEventListener('click', () => auditionFile(f.src, vdef?.gain ?? 0.3));
    const add = document.createElement('button');
    add.className = 'sv-wb-btn';
    add.textContent = mine.has(f.src) ? '−' : '+';
    add.disabled = !vdef;
    add.title = !vdef ? 'This event has no voice to add a take to'
      : mine.has(f.src) ? `Remove this take from ${voice}` : `Add as a take of ${voice}`;
    add.addEventListener('click', async () => {
      if (!vdef) return;
      const srcs = srcsOf(vdef);
      // Deduped on the way in. `mine` is a snapshot taken when this row was
      // built, so two clicks landing before the re-render both read "not in
      // the set" and both append — which is how one file ended up in a voice
      // twice, doubling its odds in pickSample for no visible reason.
      vdef.srcs = srcs.includes(f.src)
        ? srcs.filter((s) => s !== f.src)
        : [...srcs, f.src];
      vdef.src = null;
      changed();
      await reloadSample(voice);
      render();
    });
    top.append(fn, kb, play, add);
    row.appendChild(top);

    const used = document.createElement('div');
    if (unused) { used.className = 'used none'; used.textContent = 'unused — ships, plays never'; }
    else if (others.length && !voices.length) { used.className = 'used other'; used.textContent = others.join(', '); }
    else {
      used.className = 'used';
      used.innerHTML = voices.map((v) => `<b>${v}</b>`).join(', ')
        + (others.length ? ` · ${others.join(', ')}` : '');
    }
    row.appendChild(used);
    list.appendChild(row);
  }

  const orphans = library.filter((f) => !voicesUsingFile(f.src).length && !nonVoiceUsersOfFile(f.src).length);
  const kb = orphans.reduce((n, f) => n + f.kb, 0);
  const foot = els.libfoot;
  foot.replaceChildren();
  const line = document.createElement('div');
  line.innerHTML = libraryError
    ? libraryError
    : `${shown} of ${library.length} files · <b>${orphans.length} unused, ${kb} kb</b> shipping for nothing.`;
  foot.appendChild(line);
  els.pillUnused.textContent = `Unused ${orphans.length}`;
  if (!orphans.length || libraryError) return;

  const del = document.createElement('button');
  del.className = 'sv-wb-btn sv-wb-danger';
  del.textContent = `Delete ${orphans.length} unused (${kb} kb)`;
  del.addEventListener('click', () => {
    // Two steps, and the confirm NAMES them. A numbered take reading as an
    // orphan is far more likely to be a set that lost a member than junk.
    del.remove();
    const box = document.createElement('div');
    box.className = 'sv-wb-scope';
    box.innerHTML = `<b>Delete these ${orphans.length} files from public/sfx?</b> This removes them from disk and cannot be undone.`
      + `<div style="max-height:110px;overflow-y:auto;margin:6px 0;font-family:ui-monospace,Menlo,monospace;font-size:9px">`
      + orphans.map((f) => f.file).join('<br>') + '</div>';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px';
    const yes = document.createElement('button');
    yes.className = 'sv-wb-btn sv-wb-danger';
    yes.style.marginTop = '0';
    yes.textContent = 'Delete';
    yes.addEventListener('click', async () => {
      yes.textContent = 'deleting…';
      try {
        // Recomputed HERE rather than trusting the captured list — an
        // assignment made while the confirm was open must not be deleted.
        const still = library
          .filter((f) => !voicesUsingFile(f.src).length && !nonVoiceUsersOfFile(f.src).length)
          .map((f) => f.file);
        await fetch('/__sfx-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: still }),
        });
      } catch (err) {
        console.warn('[workbench] delete failed —', err?.message ?? err);
      }
      await loadLibrary();
      renderLibrary();
    });
    const no = document.createElement('button');
    no.className = 'sv-wb-btn';
    no.style.marginTop = '0';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => renderLibrary());
    row.append(yes, no);
    box.appendChild(row);
    foot.appendChild(box);
  });
  foot.appendChild(del);
}

// ---------------------------------------------------------------------------
// the live feed — the same watchSfx tap the 0 overlay uses, docked beside the
// row being edited so a burst and its drops are readable in one place.

function noteFeed(name, outcome, detail) {
  const key = `${name}|${outcome}`;
  const found = feedRows.find((r) => r.key === key);
  if (found) { found.count++; found.at = performance.now(); found.detail = detail ?? found.detail; }
  else {
    feedRows.unshift({ key, name, outcome, detail, count: 1, at: performance.now() });
    if (feedRows.length > 16) feedRows.length = 16;
  }
}

function renderFeed() {
  if (!visible || !els.feed) return;
  const load = sfxVoiceLoad();
  els.statVoices.textContent = `${load.active} / ${load.cap}`;
  const red = busReduction();
  els.statBus.textContent = red < -0.1 ? `${red.toFixed(1)} dB` : 'idle';
  els.statMuted.textContent = isMuted() ? 'MUTED' : 'live';

  const now = performance.now();
  feedRows = feedRows.filter((r) => now - r.at < 2600);
  els.feed.replaceChildren();
  if (!feedRows.length) {
    const idle = document.createElement('div');
    idle.style.color = 'rgba(232,236,243,0.3)';
    idle.textContent = 'listening…';
    els.feed.appendChild(idle);
    return;
  }
  for (const r of feedRows) {
    const line = document.createElement('div');
    line.className = 'sv-wb-fr';
    line.style.color = FEED_COLOR[r.outcome] ?? FEED_COLOR.synth;
    line.style.opacity = String(Math.max(0.3, 1 - ((now - r.at) / 2600) * 0.7));
    line.innerHTML = `<span class="n">${r.name}</span><span>${r.outcome}${r.count > 1 ? ` x${r.count}` : ''}</span>`;
    els.feed.appendChild(line);
  }
}

// ---------------------------------------------------------------------------

/**
 * @param onChange  the same handler the ` tuner is given, called with a config
 *                  path for the few edits in here that need something rebuilt
 *                  rather than just re-read. Optional: everything else in this
 *                  panel is a live value the game picks up on its next frame.
 */
export function initWorkbench(onChange = null) {
  onTuned = onChange;
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-wb';

  // rail
  const rail = document.createElement('div');
  rail.className = 'sv-wb-rail';
  const railhead = document.createElement('div');
  railhead.className = 'sv-wb-railhead';
  railhead.innerHTML = '<h2>Feel</h2>';
  els.search = document.createElement('input');
  els.search.className = 'sv-wb-search';
  els.search.autocomplete = 'off';
  els.search.placeholder = 'filter events…';
  els.search.addEventListener('input', renderRail);
  els.meta = document.createElement('div');
  els.meta.className = 'sv-wb-meta';
  railhead.append(els.search, els.meta);
  els.list = document.createElement('div');
  rail.append(railhead, els.list);

  // main
  const main = document.createElement('div');
  main.className = 'sv-wb-main';
  const head = document.createElement('div');
  head.className = 'sv-wb-head';
  const title = document.createElement('div');
  title.className = 'sv-wb-title';
  els.name = document.createElement('h1');
  els.via = document.createElement('span');
  els.via.className = 'sv-wb-via';
  title.append(els.name, els.via);
  els.chips = document.createElement('div');
  els.chips.className = 'sv-wb-chips';
  head.append(title, els.chips);
  els.cols = document.createElement('div');
  els.cols.className = 'sv-wb-cols';
  main.append(head, els.cols);

  // dock
  const dock = document.createElement('div');
  dock.className = 'sv-wb-dock';
  const tabs = document.createElement('div');
  tabs.className = 'sv-wb-tabs';
  const paneLib = document.createElement('div');
  paneLib.className = 'sv-wb-pane on';
  const paneLive = document.createElement('div');
  paneLive.className = 'sv-wb-pane';
  for (const [key, label, pane] of [['lib', 'Library', paneLib], ['live', 'Live', paneLive]]) {
    const tab = document.createElement('div');
    tab.className = 'sv-wb-tab' + (key === 'lib' ? ' on' : '');
    tab.textContent = label;
    tab.addEventListener('click', () => {
      for (const t of tabs.children) t.classList.toggle('on', t === tab);
      paneLib.classList.toggle('on', pane === paneLib);
      paneLive.classList.toggle('on', pane === paneLive);
    });
    tabs.appendChild(tab);
  }

  const libhead = document.createElement('div');
  libhead.className = 'sv-wb-libhead';
  els.libsearch = document.createElement('input');
  els.libsearch.className = 'sv-wb-search';
  els.libsearch.autocomplete = 'off';
  els.libsearch.style.marginTop = '0';
  els.libsearch.placeholder = 'filter files…';
  els.libsearch.addEventListener('input', renderLibrary);
  const pills = document.createElement('div');
  pills.className = 'sv-wb-pills';
  const mkPill = (key, text, cls = '') => {
    const p = document.createElement('span');
    p.className = `sv-wb-pill ${cls}` + (libFilter === key ? ' on' : '');
    p.textContent = text;
    p.addEventListener('click', () => {
      libFilter = key;
      for (const x of pills.children) x.classList.toggle('on', x === p);
      renderLibrary();
    });
    pills.appendChild(p);
    return p;
  };
  mkPill('all', 'All');
  mkPill('here', 'In this event');
  els.pillUnused = mkPill('unused', 'Unused', 'orphan');
  libhead.append(els.libsearch, pills);
  els.liblist = document.createElement('div');
  els.liblist.className = 'sv-wb-liblist';
  els.libfoot = document.createElement('div');
  els.libfoot.className = 'sv-wb-libfoot';
  paneLib.append(libhead, els.liblist, els.libfoot);

  const stats = document.createElement('div');
  stats.className = 'sv-wb-stats';
  const mkStat = (label) => {
    const row = document.createElement('div');
    row.className = 'sv-wb-stat';
    const b = document.createElement('b');
    row.innerHTML = `<span>${label}</span>`;
    row.appendChild(b);
    stats.appendChild(row);
    return b;
  };
  els.statVoices = mkStat('voices');
  els.statBus = mkStat('bus reduction');
  els.statMuted = mkStat('audio');
  els.feed = document.createElement('div');
  els.feed.className = 'sv-wb-feed';
  paneLive.append(stats, els.feed);

  dock.append(tabs, paneLib, paneLive);
  panel.append(rail, main, dock);
  document.body.appendChild(panel);

  els.hint = document.createElement('div');
  els.hint.className = 'sv-wb-hint sv-wb-off';
  els.hint.textContent = 'F closes · the stage bar below keeps working';
  document.body.appendChild(els.hint);

  // ONE KEY, ONE SURFACE. F already opens the stage bar, and the two are the
  // same job seen from two distances — the bar is how you fire an event, this
  // is what the event is made of. Binding a second key would mean a workbench
  // with no way to test and a test rig with nothing to edit, which is the
  // split this panel exists to end. So the workbench simply follows the stage:
  // F opens both, F closes both, and the bar keeps floating over the bottom
  // where it can still be reached with the panel shut.
  onStageChanged((on) => setWorkbenchVisible(on));

  // The bar rewraps as the window changes, and the gap under the panel has to
  // follow it or the library's delete button ends up behind it again.
  window.addEventListener('resize', () => { if (visible) fitToStageBar(); });
}

// Leave exactly enough room for the stage bar, which wraps to two or three
// rows depending on the window. Two things this got wrong on the first try,
// both worth keeping guarded:
//
//   MEASURED TOO EARLY  the bar is shown in the same tick this runs, and
//                       reading it before the browser has settled the wrap
//                       returned 732px — a bar twenty rows tall — which put
//                       the whole workbench off the top of the screen. Deferred
//                       a frame, so the measurement is of the laid-out bar.
//   TRUSTED BLINDLY     a measurement that absurd should never have been
//                       usable. Clamped to a range a control bar can actually
//                       occupy, so the worst case is a slightly wrong margin
//                       rather than a panel nobody can see.
function fitToStageBar() {
  requestAnimationFrame(() => {
    if (!visible || !panel) return;
    const bar = document.querySelector('.sv-stage');
    const raw = bar ? bar.getBoundingClientRect().height : 0;
    const h = Math.min(260, Math.max(72, Math.round(raw)));
    panel.style.bottom = `${h + 22}px`;
  });
}

export function setWorkbenchVisible(on) {
  if (!panel) return;
  visible = !!on;
  panel.classList.toggle('sv-wb-on', visible);
  els.hint.classList.toggle('sv-wb-off', !visible);
  // The tap is only installed while the panel is up, so playSfx costs one null
  // check per sound the rest of the time.
  watchSfx(visible ? noteFeed : null);
  feedRows = [];
  if (visible) {
    fitToStageBar();
    loadLibrary().then(() => { renderLibrary(); });
    render();
  }
}

export function isWorkbenchOpen() {
  return visible;
}

/** Called every frame from the loop; returns immediately while hidden. */
export function updateWorkbench() {
  if (!visible) return;
  renderFeed();
}
