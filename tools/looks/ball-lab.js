// ---------------------------------------------------------------------------
// BALL LAB — the versus ball, live
//
//   npm run looks:ball      then open http://localhost:4716/tools/looks/ball-lab.html
//
// The ball is a soft body drawn through the goo pass (systems/versus.js), and
// what it does when a seal hits it depends on WHERE it is hit and HOW HARD:
// a square ram sends it down the dash's line, a glancing one sends it off the
// normal and spins it, a fast one dents it deeper and flatter. None of that
// can be judged in a match, where the hit is over in a frame and two seals
// are fighting for the rebound. This is the ball on its own, struck wherever
// the pointer says, with every number that shapes the answer in one column.
//
// WHY A PAGE AND NOT THE GAME. There is exactly one dev server in this project
// and it is the sole writer of path/src/imported-tuning.json; a second one is a
// second game quietly flattening real tuning work. This is a static BUILD of the
// shipped modules with no save path into the tuning file anywhere in it — `W`
// writes tools/looks/ball-lab.json, and "write to config.js" splices the
// numbers into the game through tools/apply-ball-lab.mjs, which clears the
// snapshot's copies rather than adding to them. See SERVERS.md.
//
// IT DRAWS THE SHIPPED BALL. stepBallAlone, strikeBallFrom and renderBall are
// the game's; the goo group is CONFIG.fx.goo.groups.ball through the game's
// own post chain; the sliders write CONFIG. If it reads right here it reads
// right in the match.
//
// THE POINTER IS THE SEAL. Press on (or near) the ball: that is the point of
// impact. Drag: that is the dash's line, and the drag's length is the wind-up
// (`drag = full power` below). Let go: strikeBallFrom moves a virtual seal
// onto the contact circle along that line and rams. A press with no drag is
// a square hit toward the centre at the panel's power.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { bounds, updateBounds, midWater } from '../../path/src/arena.js';
import { enableVersus } from '../../path/src/systems/versusFlag.js';
import { createPost } from '../../path/src/systems/post.js';
import { ballEvent, setBallDrive, updateBallLook, resetBallLook, teamColor, ballCredit } from '../../path/src/systems/ballLook.js';
import { updateBallTrail, clearBallTrail, ballTrailStats, ballTrailSplit } from '../../path/src/systems/ballTrail.js';
import { ballSpitStats, resetBallSpit } from '../../path/src/systems/ballSpit.js';
import { updateBallGrid, publishBallGrid, resetBallGrid, ballGridState } from '../../path/src/systems/ballGrid.js';
import { createGrid } from '../../path/src/systems/grid.js';
import {
  initParticles, updateParticles, updateParticleScale, particleCount, setParticleRelief,
} from '../../path/src/entities/particles.js';
import {
  ball, initBallAlone, stepBallAlone, strikeBallFrom, flipSlapBall, renderBall, resetBall, rimRadius, rimAngle, driveOutline,
  ballContactReach, ballHitRadiusAt,
} from '../../path/src/systems/versus.js';
import { ballSpinState } from '../../path/src/systems/ballSpin.js';
import {
  flipState, triggerFlip, updateSealFlip, resetSealFlip, flipSlapWindow,
  flipTailPoint, flipTailLaying, flipTailSpent, noteFlipCommit,
} from '../../path/src/systems/sealFlip.js';
import {
  spawnGooWall, extendGooWall, sealGooWall, updateGooWalls, resetGooWalls, gooWalls,
} from '../../path/src/systems/gooWall.js';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const slidersEl = document.getElementById('sliders');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');
const b = (id) => document.getElementById(id);

// The pitch is the versus pitch: the flag is what arena.js reads its width off.
enableVersus(true);

// --- what the panel drives --------------------------------------------------
// LAB is the test bench — how the pointer becomes a strike, the view — and is
// not saved. CONFIG_SLIDERS is the ball, and every path is a real CONFIG key.
const lab = {
  view: 52,        // world units top to bottom in the frame
  power: 1,        // the wind-up behind a press with no drag, 0..1
  sealSpeed: 46,   // how fast the virtual seal arrives (the strike's dash speed)
  dragFull: 12,    // a drag this long (world units) is a full wind-up
  autoHz: 0.8,
  // ENGLISH on every strike the pointer makes, -1..1 — the two sticks'
  // disagreement, which the lab has no sticks to read. Positive is the swim
  // anticlockwise of the aim, which spins the ball clockwise.
  english: 0,
  spinNudge: 3,    // rad/s that [ and ] add to the spin directly
};
const LAB_SLIDERS = [
  ['view', 'view height', 30, 90, 1],
  ['power', 'press power', 0, 1, 0.05],
  ['sealSpeed', 'seal speed u/s', 5, 80, 1],
  ['dragFull', 'drag = full power', 3, 30, 0.5],
  ['autoHz', 'auto: per second', 0.1, 4, 0.1],
  ['english', 'english on strikes', -1, 1, 0.05],
  ['spinNudge', '[ ] spin nudge rad/s', 0.5, 10, 0.5],
];

// WHO HAS IT, in the lab. The match decides this from whoever last struck the
// ball; here it is a button, because the whole point of the lab is to see the
// possession colour without playing a match to earn it.
//
// Declared UP HERE rather than beside step(): the buttons that write it are
// bound near resize(), which runs first, and a `let` further down the file is
// in its temporal dead zone at that point — which fails as "cannot access
// before initialization" from a minified name that says nothing.
let labOwner = -1;

const CONFIG_SLIDERS = [
  ['the body', null],
  ['versus.ball.radius', 'radius', 1, 5, 0.05],
  ['versus.ball.maxSpeed', 'max speed', 20, 120, 1],
  ['versus.ball.drag', 'water drag /frame', 0.97, 1, 0.001],
  ['versus.ball.restitution', 'wall bounce', 0, 1.2, 0.02],
  ['versus.ball.body.nose', 'seal nose reach', 0.5, 6, 0.05],
  ['versus.ball.body.tail', 'seal tail reach', 0.5, 6, 0.05],
  ['versus.ball.body.thickness', 'seal half-thickness', 0.2, 3, 0.05],
  ['heavy: mass, air, water', null],
  ['versus.ball.mass', 'mass (seals)', 0.2, 10, 0.1],
  ['versus.ball.air.gravityMul', 'air gravity x', 0, 5, 0.1],
  ['versus.ball.water.buoyancy', 'buoyancy u/s²', 0, 30, 0.5],
  ['versus.ball.water.buoyancyBelow', 'buoyant under u/s', 1, 40, 0.5],
  ['the strike', null],
  ['versus.ball.strikeImpulse', 'impulse @ 0 power', 0, 100, 1],
  ['versus.ball.strikeImpulseMax', 'impulse @ full', 0, 140, 1],
  ['versus.ball.keep', 'keeps own velocity', 0, 1, 0.02],
  ['versus.ball.carry', 'carries seal speed', 0, 1.5, 0.02],
  ['versus.ball.bumpGain', 'swim bump gain', 0, 3, 0.05],
  ['impact: where and how hard', null],
  ['versus.ball.impact.grip', 'grip (0 = frictionless)', 0, 1, 0.02],
  ['versus.ball.impact.speedRef', 'hard hit = u/s', 5, 80, 1],
  ['versus.ball.impact.dentBySpeed', 'deeper by speed', 0, 2, 0.05],
  ['versus.ball.impact.narrowBySpeed', 'narrower by speed', 0, 2, 0.05],
  ['versus.ball.impact.squash', 'whole-body squash', 0, 1, 0.02],
  ['versus.ball.impact.recoil', 'striker recoil', 0, 1.5, 0.02],
  ['versus.ball.impact.recoilMax', 'recoil cap u/s', 0, 80, 1],
  // SPIN IS FRICTION — the slip at the contact, Coulomb-capped, split
  // between spin and a sideways kick. See CONFIG.versus.ball.impact.
  ['spin: friction and the curve', null],
  ['versus.ball.impact.friction', 'contact friction μ', 0, 1.5, 0.02],
  ['versus.ball.impact.squirt', 'squirt (kick share)', 0, 1, 0.02],
  ['versus.ball.impact.spinCap', 'spin cap rad/s', 2, 40, 0.5],
  ['versus.ball.impact.spinDecay', 'spin decay /s (water)', 0, 4, 0.05],
  ['versus.ball.impact.spinDecayAir', 'spin decay /s (air)', 0, 2, 0.02],
  ['versus.ball.impact.curve', 'curve (magnus, water)', 0, 0.2, 0.001],
  ['versus.ball.impact.curveAir', 'curve in air, share', 0, 1, 0.01],
  ['versus.ball.impact.wallFriction', 'wall friction μ', 0, 1.5, 0.02],
  ['english', null],
  ['versus.ball.english.deadzone', 'sticks must disagree by', 0, 0.9, 0.02],
  ['versus.ball.english.slip', 'slip u/s at full english', 0, 80, 1],
  ['spin streaks', null],
  ['versus.ball.spinStrokes.count', 'strokes', 1, 6, 1],
  ['versus.ball.spinStrokes.spinMin', 'show above rad/s', 0.5, 10, 0.25],
  ['versus.ball.spinStrokes.spinFull', 'full length at rad/s', 2, 30, 0.5],
  ['versus.ball.spinStrokes.arcMin', 'arc at least (rad)', 0.05, 1.5, 0.05],
  ['versus.ball.spinStrokes.arcMax', 'arc at most (rad)', 0.2, 4, 0.05],
  ['versus.ball.spinStrokes.travel', 'travel x rim speed', 0, 4, 0.05],
  ['versus.ball.spinStrokes.hug', 'hug (x radius)', 0.9, 1.8, 0.01],
  ['versus.ball.spinStrokes.lift', 'lift per stroke (x r)', 0, 0.5, 0.01],
  ['versus.ball.spinStrokes.width', 'band width', 0.05, 2, 0.01],
  ['versus.ball.spinStrokes.flare', 'tail flare (x r)', 0, 1, 0.01],
  ['versus.ball.spinStrokes.head', 'head taper share', 0.02, 0.9, 0.02],
  ['versus.ball.spinStrokes.tail', 'tail taper share', 0.02, 0.9, 0.02],
  ['versus.ball.spinStrokes.trimRate', 'trim chase /s', 0.5, 20, 0.5],
  ['versus.ball.spinStrokes.fadeIn', 'fade in s', 0.02, 1, 0.02],
  ['versus.ball.spinStrokes.fadeOut', 'fade out s', 0.02, 1.5, 0.02],
  ['versus.ball.spinStrokes.color', 'stroke colour', 'color'],
  ['versus.ball.spinStrokes.glow', 'stroke glow', 0, 4, 0.05],
  ['the soft body', null],
  ['versus.ball.soft.spring', 'spring', 5, 400, 1],
  ['versus.ball.soft.damping', 'damping', 0, 20, 0.1],
  ['versus.ball.soft.couple', 'ripple coupling', 0, 2000, 10],
  ['versus.ball.soft.dentDepth', 'dent depth', 0, 1, 0.02],
  ['versus.ball.soft.dentWidth', 'dent width rad', 0.1, 2.5, 0.05],
  ['versus.ball.soft.wallDent', 'wall dent', 0, 1, 0.02],
  ['versus.ball.soft.stretch', 'stretch by speed', 0, 0.6, 0.01],
  ['versus.ball.soft.maxDeform', 'max deform', 0.1, 0.9, 0.01],
  ['the look (splats)', null],
  ['versus.ball.look.color', 'colour', 'color'],
  ['versus.ball.look.glow', 'glow', 0, 4, 0.05],
  // The body's own build — and the HITBOX with it, since the goo isoline
  // through these splats is what everything collides against (ballShape.js).
  // All five are shares of the ball's radius, so `radius` scales the lot.
  ['versus.ball.splats.rim', 'rim splat size (x radius)', 0.2, 2, 0.01],
  ['versus.ball.splats.inner', 'inner splat size (x radius)', 0.2, 2.5, 0.01],
  ['versus.ball.splats.core', 'core splat size (x radius)', 0.2, 3, 0.01],
  ['versus.ball.splats.innerAt', 'inner ring at (x radius)', 0, 1.4, 0.01],
  ['versus.ball.splats.ring', 'rim ring at (x soft body)', 0.3, 1.6, 0.01],
  ['the surface (goo group)', null],
  ['fx.goo.groups.ball.radius', 'splat radius', 1, 8, 0.1],
  ['fx.goo.groups.ball.iso', 'iso', 0.05, 1.5, 0.01],
  ['fx.goo.groups.ball.soft', 'edge softness', 0.01, 0.8, 0.01],
  ['fx.goo.groups.ball.opacity', 'opacity', 0, 1, 0.02],
  ['fx.goo.groups.ball.rim', 'rim (− = outline)', -1.5, 2, 0.05],
  ['fx.goo.groups.ball.rimWidth', 'rim width', 0.02, 0.8, 0.01],
  ['fx.goo.groups.ball.spec', 'specular', 0, 2, 0.05],
  ['fx.goo.groups.ball.specPower', 'spec power', 2, 80, 1],
  ['fx.goo.groups.ball.normal', 'normal strength', 0, 12, 0.1],

  // THE WARP — one noise layer folding through itself. `amount` is the RESTING
  // value: while a match runs, systems/ballLook.js overwrites it every frame
  // from speed, charge and the bounce/goal/reset pulses, so what you set here
  // is the floor those build on rather than the number you see in play. The
  // other three are the character of the noise and nothing drives them.
  ['the warp', null],
  ['fx.goo.groups.ball.warp.amount', 'warp at rest (texels)', 0, 12, 0.1],
  ['fx.goo.groups.ball.warp.scale', 'noise cells across', 1, 24, 0.5],
  ['fx.goo.groups.ball.warp.speed', 'drift speed', 0, 2, 0.02],
  ['fx.goo.groups.ball.warp.feed', 'feedback (0 = plain wobble)', 0, 3, 0.05],

  // THE BOIL INSIDE — the interior, broken up. Everything above works on the
  // EDGE; this is the rest of the ball, which is most of what you are looking
  // at. The field is turbulence in the ball's OWN frame, turned by its spin,
  // on a clock that can flow or step. Nothing in the match drives any of it:
  // what you set here is what plays.
  ['the boil inside', null],
  ['fx.goo.groups.ball.mottle.amount', 'break-up (0 = flat)', 0, 1, 0.02],
  ['fx.goo.groups.ball.mottle.scale', 'cells across the ball', 0.5, 12, 0.1],
  ['fx.goo.groups.ball.mottle.speed', 'churn speed', 0, 3, 0.05],
  ['fx.goo.groups.ball.mottle.feed', 'folds through itself', 0, 3, 0.05],
  ['fx.goo.groups.ball.mottle.boil', 'steps rather than flows', 0, 1, 0.05],
  ['fx.goo.groups.ball.mottle.hz', '...how often it steps', 1, 30, 0.5],
  ['fx.goo.groups.ball.mottle.gain', 'contrast (curds vs cloud)', 0.2, 4, 0.05],
  ['fx.goo.groups.ball.mottle.relief', 'lumps bend the light', 0, 8, 0.1],
  ['fx.goo.groups.ball.mottle.edge', 'lets go at the edge', 0.02, 1.2, 0.02],

  // HOW THE MATCH DRIVES IT. These are the curve, not the look — turn them all
  // down and the ball sits at the resting warp above however hard it is hit.
  ['what drives the warp', null],
  ['versus.ball.look.warpGain', 'texels per unit of drive', 0, 20, 0.1],
  ['versus.ball.look.bySpeed', 'share that is ball speed', 0, 1, 0.02],
  ['versus.ball.look.byCharge', 'share that is seal charge', 0, 1, 0.02],
  ['versus.ball.look.pulseDecay', 'pulse decay /s', 0.2, 8, 0.1],
  ['versus.ball.look.pulseMax', 'pulse ceiling', 0, 6, 0.1],
  ['versus.ball.look.pulses.bounce', 'kick: bounce', 0, 2, 0.05],
  ['versus.ball.look.pulses.goal', 'kick: goal', 0, 4, 0.05],
  ['versus.ball.look.pulses.reset', 'kick: reset', 0, 4, 0.05],

  // THE OUTLINE — a drawn line inside the surface with a BOIL: a noise field
  // that re-seeds boilHz times a second instead of drifting. boilAmp/boilHz
  // here are the rest; the block after is how the match drives them.
  ['the outline', null],
  ['fx.goo.groups.ball.outline.strength', 'outline', 0, 1, 0.02],
  ['fx.goo.groups.ball.outline.width', 'width (texels)', 0, 12, 0.25],
  ['fx.goo.groups.ball.outline.soft', 'feather (texels)', 0.1, 6, 0.1],
  ['fx.goo.groups.ball.outline.color', 'line colour', 'color'],
  ['fx.goo.groups.ball.outline.boilAmp', 'boil at rest (texels)', 0, 8, 0.1],
  ['fx.goo.groups.ball.outline.boilHz', 'boil at rest (Hz)', 0, 30, 0.5],
  ['fx.goo.groups.ball.outline.boilScale', 'boil cells across', 1, 60, 0.5],
  ['fx.goo.groups.ball.outline.boilEdge', 'silhouette boils too', 0, 1.5, 0.05],
  ['what drives the boil', null],
  ['versus.ball.outline.ampRest', 'amp rest', 0, 8, 0.1],
  ['versus.ball.outline.ampByPulse', 'amp by impact', 0, 12, 0.1],
  ['versus.ball.outline.ampBySpeed', 'amp by speed', 0, 8, 0.1],
  ['versus.ball.outline.ampBySpin', 'amp by spin', 0, 8, 0.1],
  ['versus.ball.outline.ampByCharge', 'amp by charge', 0, 8, 0.1],
  ['versus.ball.outline.ampMax', 'amp ceiling', 0, 16, 0.5],
  ['versus.ball.outline.hzRest', 'Hz rest', 0, 30, 0.5],
  ['versus.ball.outline.hzByPulse', 'Hz by impact', 0, 30, 0.5],
  ['versus.ball.outline.hzBySpeed', 'Hz by speed', 0, 30, 0.5],
  ['versus.ball.outline.hzMax', 'Hz ceiling', 1, 60, 1],

  // POSSESSION. The colour comes from CONFIG.versus.teams — green vs red — and
  // is not tunable here on purpose: it is the team's identity across the goal,
  // the posts and the HUD, not a per-ball look. How far the goo is pulled
  // toward it, and how fast, are.
  ['possession', null],
  ['versus.ball.look.tintMax', 'how far toward the team colour', 0, 1, 0.02],
  ['versus.ball.look.tintRate', 'how fast it changes hands /s', 0.5, 20, 0.5],
  // The two-colour field — see CONFIG.versus.ball.look.shareRate.
  ['versus.ball.look.shareRate', 'how fast a colour marches round /s', 0.2, 12, 0.1],
  ['versus.ball.look.lobes', 'lobes riding the mass', 0, 7, 1],
  ['versus.ball.look.lobeSize', 'lobe size (x the mass)', 0, 1.4, 0.02],
  ['versus.ball.look.wobble', 'how far they are thrown', 0, 1.6, 0.02],
  ['versus.ball.look.spin', 'how fast their ring rolls rad/s', -3, 3, 0.05],
  ['versus.ball.look.breathe', 'how hard each one breathes', 0, 1, 0.02],
  ['versus.ball.look.slosh', 'how far a hit throws the mass', 0, 4, 0.05],
  ['versus.ball.look.sloshLag', 'how fast it catches back up /s', 0.5, 20, 0.5],
  ['versus.ball.look.sloshMax', 'ceiling on the throw (x radius)', 0, 1, 0.02],

  // THE TRAIL — systems/ballTrail.js, which is the seal's trail (breachTrail)
  // running on the shared engine in systems/ribbonTrail.js. Two profiles, air
  // and water, and the water block below only names what differs; anything it
  // does not name is inherited from the air one directly above it, so a knob
  // dragged up here moves BOTH unless the water row for it exists.
  //
  // The colours are not in this panel and cannot be: they are the two teams',
  // live off the possession ledger. Use the 1 / 2 buttons to hand the ball
  // over and watch the split march.
  ['the trail: where and when', null],
  ['versus.ball.trail.atRadius', 'on the edge (x radius)', 0.2, 1.4, 0.02],
  ['versus.ball.trail.minSpeed', 'nothing under u/s', 0, 30, 0.5],
  ['versus.ball.trail.fullSpeed', 'full at u/s', 5, 100, 1],
  ['the trail: the cloud', null],
  ['versus.ball.trail.emitPerSecond', 'particles /s', 5, 200, 1],
  ['versus.ball.trail.life', 'lifetime s (= its length)', 0.1, 3, 0.02],
  ['versus.ball.trail.lifeVary', 'lifetime spread', 0, 0.9, 0.02],
  ['versus.ball.trail.maxNodes', 'particle ceiling', 10, 400, 5],
  ['versus.ball.trail.samples', 'curve samples (smoothness)', 16, 400, 4],
  ['versus.ball.trail.curveSmooth', 'smoothing passes', 0, 8, 1],
  ['the trail: the band', null],
  ['versus.ball.trail.width', 'width', 0.05, 3, 0.01],
  ['versus.ball.trail.growth', 'opens up x by death', 0, 5, 0.05],
  ['versus.ball.trail.fade', 'brightness falloff', 0.2, 4, 0.05],
  ['versus.ball.trail.glow', 'glow (over bloom)', 0, 5, 0.05],
  ['versus.ball.trail.minIntensity', 'floor under the ramp', 0, 1, 0.02],
  ['versus.ball.trail.coreWidth', 'core half-width (share)', 0.01, 0.5, 0.01],
  ['versus.ball.trail.coreGain', 'core brightness', 0, 3, 0.05],
  ['versus.ball.trail.haloGain', 'halo brightness', 0, 3, 0.05],
  ['versus.ball.trail.softness', 'halo shape (2 = gaussian)', 0.5, 5, 0.1],
  ['versus.ball.trail.headTaper', 'head taper (share)', 0, 0.5, 0.01],
  ['versus.ball.trail.tailTaper', 'tail taper (share)', 0, 0.5, 0.01],
  ['versus.ball.trail.z', 'depth', -0.4, 0.4, 0.01],
  // THE POSSESSION SPLIT. `trail` and `spread` are how far the two colours are
  // pulled apart at parity; `throw` and `bias` are how much winning changes it.
  // Both of the latter are centred on an even ball, so at 50/50 they do nothing
  // and what you are looking at is the pair above.
  ['the trail: the colour split', null],
  ['versus.ball.trail.channelTrail', 'split along the path (x width)', 0, 0.8, 0.005],
  ['versus.ball.trail.channelSpread', 'split sideways (x width)', 0, 0.8, 0.005],
  ['versus.ball.trail.splitThrow', 'losing colour thrown clear', 0, 2, 0.05],
  ['versus.ball.trail.splitBias', 'winning colour burns brighter', 0, 1.5, 0.05],
  ['the trail: how it moves', null],
  ['versus.ball.trail.turbulence', 'turbulence u/s²', 0, 12, 0.1],
  ['versus.ball.trail.turbFreq', 'field cells (lower = broader)', 0.05, 1.5, 0.01],
  ['versus.ball.trail.turbSpeed', 'field churn /s', 0, 3, 0.05],
  ['versus.ball.trail.blowOut', 'thrown off the line u/s', 0, 6, 0.05],
  ['versus.ball.trail.blowWave', 'how fast that side swings', 0.01, 1, 0.01],
  ['versus.ball.trail.inherit', 'keeps ball velocity', 0, 1, 0.02],
  ['versus.ball.trail.drag', 'gives it up /s', 0, 8, 0.05],
  ['versus.ball.trail.foldSafety', 'fold guard', 0.2, 1, 0.01],
  // UNDERWATER: THE MEDIUM, NOT THE LOOK. There are deliberately no water
  // sliders for width, glow, the core/halo or the sampling — the band is
  // drawn the same above and below the line, and systems/ballTrail.js drops
  // any look key set on the override. See the note there.
  ['the trail: underwater (how it moves)', null],
  ['versus.ball.trail.water.emitPerSecond', 'particles /s', 5, 200, 1],
  ['versus.ball.trail.water.life', 'lifetime s', 0.1, 3, 0.02],
  ['versus.ball.trail.water.maxNodes', 'particle ceiling', 10, 400, 5],
  ['versus.ball.trail.water.blowOut', 'thrown off the line u/s', 0, 6, 0.05],
  ['versus.ball.trail.water.turbulence', 'turbulence u/s²', 0, 12, 0.1],
  ['versus.ball.trail.water.turbSpeed', 'field churn /s', 0, 3, 0.05],
  ['versus.ball.trail.water.drag', 'gives it up /s', 0, 8, 0.05],
  ['versus.ball.trail.water.inherit', 'keeps ball velocity', 0, 1, 0.02],
  ['versus.ball.trail.water.z', 'depth', -0.4, 0.4, 0.01],
  ['the trail: bubbles (underwater)', null],
  ['versus.ball.trail.water.bubbles.perSecond', 'bubbles /s', 0, 60, 1],
  ['versus.ball.trail.water.bubbles.scale', 'per burst x', 0.2, 4, 0.1],
  ['versus.ball.trail.water.bubbles.sizeMul', 'size x', 0.2, 4, 0.1],
  ['versus.ball.trail.water.bubbles.speedMul', 'thrown x', 0.2, 4, 0.1],
  ['versus.ball.trail.water.bubbles.tint', 'tinted by who owns it', 0, 1, 0.02],
  ['versus.ball.trail.water.bubbles.color', 'bubble colour', 'color'],

  // WHAT IT SPITS WHEN IT IS HIT — systems/ballSpit.js, out of the CONTACT
  // PATCH rather than off the back, which is the whole difference between it
  // and the bubbles above. Two fans: the jet along the line the ball leaves on
  // (the direction of the impulse) and the wash back out of the pinch toward
  // whoever hit it (the source).
  //
  // THIS IS THE PAGE FOR IT, and not because it is convenient. The effect is a
  // tenth of a second long and fires on a contact, so in a match it is over
  // before you have found it; here the same strike goes off the `R` key from
  // the same bearing at the same power as many times as it takes, and the drag
  // aims it. Judge the jet on a GLANCING strike — a square one puts the
  // impulse on the normal, which is where a burst that had stopped reading the
  // impulse at all would also be.
  ['the hit: how much', null],
  ['versus.ball.spit.forcePow', 'ramp (low = a pass still boils)', 0.2, 2, 0.05],
  ['versus.ball.spit.minForce', 'under this, nothing', 0, 0.3, 0.005],
  ['versus.ball.spit.maxParticles', 'ceiling per hit', 40, 600, 10],
  ['versus.ball.spit.sizeMin', 'bubble size, a nothing touch x', 0.2, 2, 0.05],
  ['versus.ball.spit.sizeMax', 'bubble size, the hardest x', 0.2, 3, 0.05],
  ['the hit: the patch', null],
  ['versus.ball.spit.patch', 'spread across the contact, x radius', 0, 1.5, 0.02],
  ['versus.ball.spit.patchSoft', 'of that, at a nothing touch', 0, 1, 0.02],
  ['versus.ball.spit.patchJitter', 'scatter off the slot', 0, 1.5, 0.05],
  ['versus.ball.spit.lift', 'off the skin, x radius', 0, 0.6, 0.01],
  ['versus.ball.spit.speedVary', 'per-puff throw scatter', 0, 1, 0.02],
  ['the hit: the jet (the impulse)', null],
  ['versus.ball.spit.jetPuffsMin', 'puffs, a nothing touch', 1, 8, 1],
  ['versus.ball.spit.jetPuffsMax', 'puffs, the hardest', 1, 10, 1],
  ['versus.ball.spit.jetScaleMin', 'per puff x, a nothing touch', 0.1, 3, 0.05],
  ['versus.ball.spit.jetScaleMax', 'per puff x, the hardest', 0.1, 4, 0.05],
  ['versus.ball.spit.jetSpeedMin', 'thrown x, a nothing touch', 0.1, 3, 0.05],
  ['versus.ball.spit.jetSpeedMax', 'thrown x, the hardest', 0.1, 4, 0.05],
  ['versus.ball.spit.jetFan', 'fanned by the patch, rad', 0, 1.6, 0.05],
  ['versus.ball.spit.jetWander', 'jitter off that, rad', 0, 1.2, 0.02],
  ['versus.ball.spit.jetInherit', 'keeps the new velocity', 0, 1.5, 0.05],
  ['the hit: the wash (the source)', null],
  ['versus.ball.spit.washPuffsMin', 'puffs, a nothing touch', 0, 6, 1],
  ['versus.ball.spit.washPuffsMax', 'puffs, the hardest', 1, 8, 1],
  ['versus.ball.spit.washScaleMin', 'per puff x, a nothing touch', 0.1, 3, 0.05],
  ['versus.ball.spit.washScaleMax', 'per puff x, the hardest', 0.1, 4, 0.05],
  ['versus.ball.spit.washSpeedMin', 'thrown x, a nothing touch', 0.1, 3, 0.05],
  ['versus.ball.spit.washSpeedMax', 'thrown x, the hardest', 0.1, 3, 0.05],
  ['versus.ball.spit.washFan', 'fanned by the patch, rad', 0, 2, 0.05],
  ['versus.ball.spit.washWander', 'jitter off that, rad', 0, 1.5, 0.02],
  ['versus.ball.spit.washInherit', 'keeps the new velocity', 0, 1, 0.02],
  ['versus.ball.spit.washSize', 'size against the jet\'s x', 0.3, 2.5, 0.05],
  ['the hit: whose it was', null],
  ['versus.ball.spit.tint', 'tinted by who hit it', 0, 1, 0.02],
  ['versus.ball.spit.color', 'water colour', 'color'],

  // THE BACKDROP — systems/ballGrid.js, drawn by the game's own lattice
  // (systems/grid.js) behind this ball. The chain of dents can only really be
  // judged by watching ONE hit go through it, which is the one thing a match
  // never lets you do: here the same strike can be fired over and over off the
  // `R` key until the spring and the spacing are right.
  //
  // The colour on those dents is the possession field itself — the same
  // function that paints the two colours across the body — so the team buttons
  // move the trail exactly as they move the ball.
  ['the backdrop: how hard', null],
  ['versus.ball.grid.amount', 'overall', 0, 4, 0.05],
  ['versus.ball.grid.base', 'sitting still', 0, 2, 0.05],
  ['versus.ball.grid.bySpeed', 'plus, at the speed cap', 0, 3, 0.05],
  ['versus.ball.grid.byPulse', 'plus, per unit of contact', 0, 3, 0.05],
  ['versus.ball.grid.hitScale', 'the mark left AT a contact x', 1, 5, 0.1],
  ['the backdrop: the shape of a dent', null],
  ['versus.ball.grid.drive', 'drag along the flight', 0, 6, 0.05],
  ['versus.ball.grid.radial', 'shove outward', 0, 4, 0.05],
  ['versus.ball.grid.swirl', 'shear around it', 0, 4, 0.05],
  ['versus.ball.grid.stretch', 'smear down the flight', 1, 8, 0.1],
  ['versus.ball.grid.headingLag', 'drag swings to new flight /s', 0.2, 20, 0.2],
  ['versus.ball.grid.reach', "the ball's dent x radii", 0.5, 10, 0.1],
  ['versus.ball.grid.echoReach', "...and an echo's", 0.5, 10, 0.1],
  ['the backdrop: the spring and the chain', null],
  ['versus.ball.grid.springHz', 'springs back at Hz', 0, 10, 0.1],
  ['versus.ball.grid.damp', 'ringing dies at', 0.1, 10, 0.1],
  ['versus.ball.grid.life', 'an echo lives s', 0.1, 6, 0.1],
  ['versus.ball.grid.spacing', 'one echo every x radii', 0.1, 4, 0.05],
  ['versus.ball.grid.gain', 'possession colour', 0, 4, 0.05],
  ['versus.ball.grid.alpha', 'extra opacity', 0, 2, 0.05],
  // The lattice itself is NOT on this panel, deliberately. CONFIG.grid is the
  // whole game's backdrop and this page's save path (tools/apply-ball-lab.mjs)
  // only writes CONFIG.versus and CONFIG.fx — a row here would be a slider that
  // silently does not save. It is drawn at whatever the game has it at, which
  // is the honest thing to tune a dent against anyway.

  // ---- THE BACKFLIP'S WALL (D) ------------------------------------------
  // Goo laid off the fluke as the somersault swings it (systems/gooWall.js).
  // It is on THIS page and not the pose lab because the only question that
  // matters about it is whether the blobs fuse into one barrier, and that is a
  // metaball field through the real goo pass — a thing you look at.
  //
  // All four blocks save: tools/apply-ball-lab.mjs writes `emitters` and
  // `sealFlip` alongside `versus` and `fx` for exactly these rows.
  ['the wall — the throw', null],
  // HOW MUCH OF THE TAIL'S SPEED EACH LOBE KEEPS, and the drag that brings it
  // back to rest. THE TWO MOVE TOGETHER: a lobe coasts inherit x tailSpeed /
  // drag, and that distance has to stay inside the barrier the same blobs are
  // drawing (the readout under the ball prints it against the bound). Inherit
  // alone walks the goo off its own hitbox; inherit with drag is a harder
  // throw that still lands.
  ['emitters.gooWall.inherit', 'inherits the tail x', 0, 1, 0.01],
  ['emitters.gooWall.drag', 'drag (settles it)', 1, 30, 0.5],
  // The wobble. A noise field that grows with each lobe's AGE, so the wall
  // comes off the tail clean and goes ragged as it dissolves — which is what
  // stops twenty identical lobes in a row reading as extruded.
  ['emitters.gooWall.turbulence', 'turbulence', 0, 3, 0.05],
  ['emitters.gooWall.count', 'lobes per blob', 1, 24, 1],
  ['emitters.gooWall.glow', 'glow', 0, 3, 0.05],
  ['sealFlip.back.blobSize', 'lobe size x', 0.3, 3, 0.05],
  ['sealFlip.back.blobSpeed', 'lobe throw x', 0, 3, 0.05],
  ['sealFlip.back.blobScale', 'lobe count x', 0.2, 4, 0.1],

  ['the wall — the barrier', null],
  // `step` is the COHESION number: how far the fluke travels between blobs.
  // Under a lobe's drawn radius (size x the group's radius, below) the blobs
  // overlap and the row closes into one wall; over it, beads on a string.
  ['sealFlip.back.step', 'blob every x units (cohesion)', 0.3, 4, 0.05],
  ['sealFlip.back.thick', 'wall thickness (hitbox)', 0.2, 6, 0.1],
  ['sealFlip.back.life', 'wall lives s', 0.1, 2, 0.05],
  ['sealFlip.back.hold', 'stops things for s', 0, 1.5, 0.05],
  // Where in the turn the tail lays it, as a phase of the spin. Not the whole
  // circle: goo along every degree is a RING with the seal inside it.
  ['sealFlip.back.emitFrom', 'laying starts at (phase)', 0, 1, 0.02],
  ['sealFlip.back.emitTo', 'laying ends at (phase)', 0, 1, 0.02],
  ['sealFlip.back.ballBounce', 'ball keeps x off it', 0, 1, 0.02],
  ['sealFlip.back.ballSpin', 'ball keeps x of its spin', 0, 1, 0.02],

  ['the wall — the surface (goo group)', null],
  // The other half of the cohesion. The surface is drawn where summed lobes
  // cross `iso`, so a LOW one means neighbours bleed together well before they
  // properly overlap. `radius` multiplies the emitter's size into the drawn
  // lobe, so it and `step` are the pair that decide whether this is a wall.
  ['fx.goo.groups.gooWall.radius', 'splat radius', 1, 10, 0.1],
  ['fx.goo.groups.gooWall.iso', 'iso (low = fuses)', 0.05, 1.2, 0.01],
  ['fx.goo.groups.gooWall.soft', 'edge softness', 0.01, 0.8, 0.01],
  ['fx.goo.groups.gooWall.opacity', 'opacity', 0, 1, 0.02],
  ['fx.goo.groups.gooWall.rim', 'rim (− = outline)', -1.5, 2, 0.05],
  ['fx.goo.groups.gooWall.rimWidth', 'rim width', 0.02, 0.8, 0.01],
  ['fx.goo.groups.gooWall.spec', 'specular', 0, 2, 0.05],
  ['fx.goo.groups.gooWall.normal', 'normal strength', 0, 12, 0.1],

  ['the pitch', null],
  ['versus.widthScale', 'pitch width x frame', 1, 3, 0.05],
];

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks[ks.length - 1]] = v;
}
const DEFAULTS = {};
for (const [path, label] of CONFIG_SLIDERS) if (label) DEFAULTS[path] = getPath(CONFIG, path);

const hex = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');

let dirtyPreset = false;
const outputs = new Map();
function addRow(parent, label, min, max, step, read, write) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  l.title = label;
  if (min === 'color') {
    const c = document.createElement('input');
    c.type = 'color';
    c.value = hex(read());
    const o = document.createElement('output');
    o.textContent = c.value;
    c.addEventListener('input', () => { write(parseInt(c.value.slice(1), 16)); o.textContent = c.value; });
    row.append(l, c, o);
    parent.appendChild(row);
    return { r: c, o, fmt: (v) => hex(v), read, color: true };
  }
  const r = document.createElement('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step;
  r.value = read();
  const o = document.createElement('output');
  const fmt = (v) => Number(v).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0);
  o.textContent = fmt(r.value);
  r.addEventListener('input', () => {
    const v = Number(r.value);
    write(v);
    o.textContent = fmt(v);
  });
  row.append(l, r, o);
  parent.appendChild(row);
  return { r, o, fmt, read };
}

function onConfigChange(path) {
  dirtyPreset = true;
  // Through resize(), not updateBounds directly: the wall override lives there
  // and calling updateBounds alone would put the collider back on the pitch.
  if (path === 'versus.widthScale') resize();
}

function buildSliders() {
  slidersEl.innerHTML = '';
  outputs.clear();
  const h = document.createElement('h2');
  h.textContent = 'test bench';
  slidersEl.appendChild(h);
  for (const [key, label, min, max, step] of LAB_SLIDERS) {
    addRow(slidersEl, label, min, max, step, () => lab[key], (v) => { lab[key] = v; if (key === 'view') resize(); });
  }
  for (const [path, label, min, max, step] of CONFIG_SLIDERS) {
    if (!label) {
      const head = document.createElement('h2');
      head.textContent = path;
      slidersEl.appendChild(head);
      continue;
    }
    const ctl = addRow(slidersEl, label, min, max, step,
      () => getPath(CONFIG, path) ?? 0,
      (v) => { setPath(CONFIG, path, v); onConfigChange(path); });
    outputs.set(path, ctl);
  }
}
function refreshSliders() {
  for (const [path, ctl] of outputs) {
    const v = getPath(CONFIG, path) ?? 0;
    ctl.r.value = ctl.color ? hex(v) : v;
    ctl.o.textContent = ctl.fmt(v);
  }
}

// The saved preset first, so the sliders open on the last session's numbers
// rather than on config.js and quietly discarding them on the first drag.
let presetNote = '';
try {
  const saved = await (await fetch('/preset/ball-lab.json')).json();
  let n = 0;
  for (const [path, label] of CONFIG_SLIDERS) {
    if (!label) continue;
    const v = saved[path];
    if (typeof v === 'number') { setPath(CONFIG, path, v); n++; }
  }
  if (n) presetNote = `preset loaded from tools/looks/ball-lab.json (${n} values)`;
} catch { /* no server, or nothing saved yet — the normal first run */ }
buildSliders();

// --- the frame --------------------------------------------------------------
const gl = new THREE.WebGLRenderer({ canvas: stage, antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
gl.outputColorSpace = THREE.SRGBColorSpace;
const post = createPost(gl);

const scene = new THREE.Scene();
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshBasicMaterial({ color: 0x0d3550 }),
);
water.position.z = -5;
scene.add(water);
// The air above the surface, so the ball's gravity above y=0 reads as leaving the water.
const sky = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 300),
  new THREE.MeshBasicMaterial({ color: 0x1a2a3c }),
);
sky.position.set(0, 150, -4);
scene.add(sky);

// THE GAME'S OWN BACKDROP LATTICE, because the dents the ball springs into it
// are half of what this page is now for. It is the shipped module drawn into
// the shipped scene: the hexes, the ripples, the water-line clip. Nothing here
// publishes a seal, a hull or a finger into it, so the only thing moving it is
// the ball — which is exactly the isolation a match cannot give you.
const grid = createGrid(scene);
// Nowhere near the pitch, at zero strength: grid.update wants a body to hang
// slot 0's wake on and there is no seal on this page.
const NO_SEAL = { x: 0, y: -1e5 };

// The pitch: its walls, floor and ceiling as a line, rebuilt when the width changes.
let pitchLine = null;
function layoutPitch() {
  // The lattice is generated across `bounds`, so it is rebuilt with them.
  grid.build();
  if (pitchLine) scene.remove(pitchLine);
  const pts = [
    new THREE.Vector3(bounds.left, bounds.bottom, 0), new THREE.Vector3(bounds.right, bounds.bottom, 0),
    new THREE.Vector3(bounds.right, bounds.top, 0), new THREE.Vector3(bounds.left, bounds.top, 0),
    new THREE.Vector3(bounds.left, bounds.bottom, 0),
  ];
  pitchLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0.5 }));
  pitchLine.position.z = -1;
  scene.add(pitchLine);
}

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
cam.position.set(0, 0, 20);
cam.lookAt(0, 0, 0);

// See bolt-lab.js for why this is not window.innerWidth: the pane reports 0
// while hidden and the frame is built out of NaN.
function viewport() {
  const w = window.innerWidth || document.documentElement?.clientWidth || 0;
  const h = window.innerHeight || document.documentElement?.clientHeight || 0;
  return { w: w > 1 ? w : 1280, h: h > 1 ? h : 720 };
}

function resize() {
  const { w, h } = viewport();
  gl.setSize(w, h, false);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  updateBounds(w / h);
  const halfH = lab.view / 2;
  const halfW = halfH * (w / h);
  const cx = (bounds.left + bounds.right) / 2;
  const cy = bounds.bottom + (CONFIG.arena.viewHeight ?? 52) / 2;
  cam.left = cx - halfW; cam.right = cx + halfW; cam.top = cy + halfH; cam.bottom = cy - halfH;
  cam.updateProjectionMatrix();

  // THE WALLS ARE THE WINDOW, in the lab and only in the lab.
  //
  // The real pitch is `versus.widthScale` frames wide and the camera pans
  // across it, so a ball driven hard leaves the view and keeps bouncing off
  // walls nobody can see — which in a test bench is just the ball vanishing.
  // Here the collider is overwritten with the camera's own rect AFTER the
  // frustum is set, so every edge you can see is a wall and nothing can get
  // out. The pitch outline drawn below then traces the window exactly, which
  // is the honest picture of what the ball is actually hitting.
  //
  // This does not touch the game: `bounds` is arena.js's live object and the
  // match sets it from the real pitch every frame it runs.
  bounds.left = cam.left;
  bounds.right = cam.right;
  bounds.bottom = cam.bottom;
  bounds.top = cam.top;
  layoutPitch();
  post.resize();
  updateParticleScale(cam, gl);
}
// --- possession and the goal pulse, for testing the colour -------------------
// The match sets the owner from whoever last struck the ball and fires the goal
// pulse from the shutter. Neither happens here, so both are buttons — and they
// call the SAME functions systems/ballLook.js exposes to versus.js, so what you
// tune against is the shipping curve rather than a lab approximation.
const setOwner = (i) => {
  labOwner = i;
  for (const [id, want] of [['bOwnNone', -1], ['bOwn0', 0], ['bOwn1', 1]]) {
    document.getElementById(id)?.classList.toggle('on', labOwner === want);
  }
  if (i < 0) resetBallLook();
};
document.getElementById('bOwnNone')?.addEventListener('click', () => setOwner(-1));
document.getElementById('bOwn0')?.addEventListener('click', () => setOwner(0));
document.getElementById('bOwn1')?.addEventListener('click', () => setOwner(1));
document.getElementById('bGoal')?.addEventListener('click', () => ballEvent('goal'));
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '0') setOwner(-1);
  if (e.key === '1') setOwner(0);
  if (e.key === '2') setOwner(1);
  if (e.key.toLowerCase() === 'g') ballEvent('goal');
});
setOwner(-1);

window.addEventListener('resize', resize);

initParticles(scene);
resize();
initBallAlone();

// --- the path trace ----------------------------------------------------------
// Where the ball has been, as a thin line: the curve a spin puts on a flight
// is a shape, and the shape is what a still frame of the ball cannot show.
let trace = q.has('trace');
const TRACE_N = 360;
const traceGeo = new THREE.BufferGeometry();
traceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACE_N * 3), 3));
const traceLine = new THREE.Line(traceGeo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.55 }));
traceLine.position.z = 1.4;
traceLine.frustumCulled = false;
scene.add(traceLine);
const tracePts = [];
function traceStep() {
  const l = tracePts[tracePts.length - 1];
  if (l && Math.hypot(l.x - ball.x, l.y - ball.y) < 0.15) return;
  tracePts.push({ x: ball.x, y: ball.y });
  if (tracePts.length > TRACE_N) tracePts.shift();
}
function clearTrace() { tracePts.length = 0; }
function updateTrace() {
  traceLine.visible = trace && tracePts.length > 1;
  if (!traceLine.visible) return;
  const pos = traceGeo.attributes.position;
  for (let i = 0; i < tracePts.length; i++) pos.setXYZ(i, tracePts[i].x, tracePts[i].y, 0);
  traceGeo.setDrawRange(0, tracePts.length);
  pos.needsUpdate = true;
}

// --- the rim overlay ----------------------------------------------------------
// The soft body drawn as a thin line, so the physics can be judged apart from
// the goo that dresses it. Plus the contact circle the seal rams against.
let overlay = q.has('overlay');
const rimGeo = new THREE.BufferGeometry();
const rimPts = new Float32Array((64 + 1) * 3);
rimGeo.setAttribute('position', new THREE.BufferAttribute(rimPts, 3));
const rimLine = new THREE.Line(rimGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
rimLine.position.z = 2;
scene.add(rimLine);
const contactRing = new THREE.Mesh(new THREE.RingGeometry(0.98, 1, 48), new THREE.MeshBasicMaterial({ color: 0xff8a5e, transparent: true, opacity: 0.6 }));
contactRing.position.z = 2;
scene.add(contactRing);
function updateOverlay() {
  rimLine.visible = overlay;
  contactRing.visible = overlay;
  if (!overlay) return;
  const n = ball.rim.length;
  const pos = rimGeo.attributes.position;
  for (let i = 0; i <= n; i++) {
    const j = i % n;
    const a = rimAngle(j);
    const r = rimRadius(j);
    pos.setXYZ(i, ball.x + Math.cos(a) * r, ball.y + Math.sin(a) * r, 0);
  }
  rimGeo.setDrawRange(0, n + 1);
  pos.needsUpdate = true;
  const cr = ballContactReach(0);
  contactRing.position.x = ball.x;
  contactRing.position.y = ball.y;
  contactRing.scale.setScalar(cr);
}

// --- the striker's marks ------------------------------------------------------
// Where the last seal was, and the line it came in on, fading.
const sealMark = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0 }));
sealMark.position.z = 1.5;
scene.add(sealMark);
const dragGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const dragLine = new THREE.Line(dragGeo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0 }));
dragLine.position.z = 1.6;
scene.add(dragLine);
let markFade = 0;

// --- the pointer is the seal --------------------------------------------------
function toWorld(ev) {
  const rect = stage.getBoundingClientRect();
  const u = (ev.clientX - rect.left) / Math.max(1, rect.width);
  const v = (ev.clientY - rect.top) / Math.max(1, rect.height);
  return { x: cam.left + (cam.right - cam.left) * u, y: cam.top - (cam.top - cam.bottom) * v };
}
let press = null;
let last = null;
stage.addEventListener('pointerdown', (ev) => {
  press = toWorld(ev);
  last = press;
  stage.setPointerCapture(ev.pointerId);
});
stage.addEventListener('pointermove', (ev) => {
  if (!press) return;
  last = toWorld(ev);
  dragGeo.setFromPoints([new THREE.Vector3(press.x, press.y, 0), new THREE.Vector3(last.x, last.y, 0)]);
  dragLine.material.opacity = 0.9;
});
stage.addEventListener('pointerup', (ev) => {
  if (!press) return;
  const up = toWorld(ev);
  let dx = up.x - press.x;
  let dy = up.y - press.y;
  const len = Math.hypot(dx, dy);
  let power = lab.power;
  if (len < 0.4) {
    // A press: square at the centre.
    dx = ball.x - press.x; dy = ball.y - press.y;
  } else {
    power = Math.min(1, len / lab.dragFull);
  }
  strikeAt(press, { x: dx, y: dy }, power);
  press = null;
  dragLine.material.opacity = 0;
});

let lastStrike = null;
function strikeAt(at, dir, power, english = lab.english) {
  const before = { spin: ball.spin };
  const hit = strikeBallFrom(at, dir, lab.sealSpeed, power, english, labOwner >= 0 ? labOwner : 0);
  lastStrike = { at, dir, power, hit, dSpin: ball.spin - before.spin, t: 0 };
  sealMark.position.x = at.x;
  sealMark.position.y = at.y;
  sealMark.scale.setScalar(CONFIG.versus.ball.body?.thickness ?? 0.69);
  markFade = 1;
  window.__strikes = (window.__strikes ?? 0) + 1;
  // The match fires this from strikeBall with the striking seal's index. Here
  // the buttons decide who is striking, so the colour follows the same path.
  ballEvent('bounce', { force: power, team: labOwner });
}

// ---------------------------------------------------------------------------
// THE TAIL SLAP — the flip's contact (systems/sealFlip.js, flipSlapBall in
// systems/versus.js), which is the deepest dent and the biggest mess anything
// in this game makes of this ball.
//
// THE SHIPPING PATH, not an impression of it: a real flip is triggered and its
// clock stepped by the frame loop below, so the window opens where the move
// says it does and the slap lands on the arc the move actually swings. The
// only thing invented here is WHERE THE SEAL IS — flipSlapBall takes that as
// an argument for this page's sake, because the lab has a ball and a pointer
// and no animal at all.
//
// The seal is placed on the side the pointer is on, at the distance the tail
// would put it: the slap's own geometry then decides whether it connects,
// exactly as it does in a match.
let slapFrom = null;
function tailSlap(at = null, dir = +1) {
  resetSealFlip();
  const a = at
    ? Math.atan2(at.y - ball.y, at.x - ball.x)
    : Math.random() * Math.PI * 2;
  const R = ballContactReach(0) + (CONFIG.sealFlip?.reach ?? 5.2) * 0.55;
  // The seal, placed so its TAIL is on the ball rather than its nose. The
  // fluke is at heading + the turn + a half turn (flipSlapSegment), so the
  // heading that points the tail down the line to the ball is that backwards
  // — worked out after the clock jump below, once the turn is known.
  slapFrom = { x: ball.x + Math.cos(a) * R, y: ball.y + Math.sin(a) * R, heading: a + Math.PI };
  triggerFlip(dir, {}, false, null);
  // ...AND STRAIGHT TO THE CONTACT. The wind-up and the spin are the POSE
  // LAB's question (`npm run looks:poselab`, "flip move"); this page's is what
  // the tail does to the ball when it arrives, and the third of a second in
  // between is a third of a second of a buoyant ball floating out of the arc.
  // The first version of this did not skip it and the slap missed every time,
  // which looked exactly like a broken hitbox.
  //
  // The clock is jumped, not faked: updateSealFlip is a pure function of it,
  // so the window opens where the move says it does and everything downstream
  // — the angle, the arc, the direction the goo leaves in — is the real one.
  updateSealFlip(Math.max(0, flipSlapWindow().open) + 1e-3, null);
  // THE TAIL HAS TO POINT AT THE BALL, and it is two half-turns away from the
  // heading: flipSlapSegment swings the fluke along `heading + angle + PI`,
  // and `a` here runs from the BALL out to the seal. So the heading that lays
  // the tail down the line to the ball is `a - angle`, which lands the fluke
  // on `a + PI` — back the way it came. Getting this sign wrong points the
  // tail into empty water and the slap misses every time while the seal marker
  // sits exactly where you expect it.
  slapFrom.heading = a - flipState.angle;
  sealMark.position.set(slapFrom.x, slapFrom.y, sealMark.position.z);
  sealMark.scale.setScalar(CONFIG.versus.ball.body?.thickness ?? 0.69);
  markFade = 1;
  window.__slaps = (window.__slaps ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// THE BACKFLIP'S WALL — the OTHER thing a flip does, and the one this page is
// actually the right place to judge.
//
// The wall is goo laid off the fluke a blob at a time as the somersault swings
// it (systems/gooWall.js), and whether those blobs FUSE into one barrier or
// sit there as beads on a string is a question about a metaball field that no
// test can answer and no amount of reading the numbers will settle. It has to
// be looked at, through the real goo pass, at the size it is played at — which
// is this page.
//
// The seal is where the pointer put it, exactly as for a slap, and the wall is
// painted by the same loop main.js runs.
let wallSeal = null;
// The fastest the fluke went while painting the last wall — what the goo was
// actually thrown with, which is the number the coast is computed from. Held
// rather than derived from the config, because the tail's peak speed depends
// on the spin's length and the easing and is the one term of the three nobody
// can read off a slider.
let wallTipSpeed = 0;
function tailWall(at = null) {
  resetSealFlip();
  resetGooWalls();
  const a = at
    ? Math.atan2(at.y - ball.y, at.x - ball.x)
    : Math.random() * Math.PI * 2;
  const R = ballContactReach(0) + (CONFIG.sealFlip?.reach ?? 5.2) * 0.55;
  wallSeal = {
    x: ball.x + Math.cos(a) * R,
    y: ball.y + Math.sin(a) * R,
    heading: a + Math.PI,
    wall: null,
  };
  // A BACKFLIP (+1) and a full follow-through, because a half-drawn one lays a
  // shorter wall and the question here is what a whole one looks like.
  triggerFlip(1, {}, false, null);
  noteFlipCommit(1);
  wallTipSpeed = 0;
  sealMark.position.set(wallSeal.x, wallSeal.y, sealMark.position.z);
  sealMark.scale.setScalar(CONFIG.versus.ball.body?.thickness ?? 0.69);
  markFade = 1;
  window.__walls = (window.__walls ?? 0) + 1;
}

/** One frame of the tail painting, the same loop main.js runs. */
function stepTailWall() {
  if (!wallSeal) return;
  if (!flipState.active && wallSeal.wall) { sealGooWall(wallSeal.wall); wallSeal = null; return; }
  // The wall is opened at the LAUNCH, not at the trigger — there is nothing in
  // the water during the gather.
  if (!wallSeal.wall) {
    if (!flipState.launched) return;
    wallSeal.wall = spawnGooWall(wallSeal.x, wallSeal.y, wallSeal.heading);
  }
  // SPENT, not "not laying" — the span opens a fraction after the launch, so
  // sealing on "not laying" closes the wall before a blob is in it.
  if (flipTailSpent()) { sealGooWall(wallSeal.wall); wallSeal = null; return; }
  if (!flipTailLaying()) return;
  // The fluke's position AND its motion — the goo leaves along the swing, and
  // this page is where you find out whether that reads as thrown or as
  // sprayed. The lab's seal does not swim, so there is no body velocity to
  // add; in a match main.js sums the two.
  const t = flipTailPoint(wallSeal.x, wallSeal.y, wallSeal.heading, DT);
  wallTipSpeed = Math.max(wallTipSpeed, t.speed);
  extendGooWall(wallSeal.wall, t.x, t.y, t.vx, t.vy);
}

// A strike from a random point on the ball, in toward it with a random glance.
function randomStrike() {
  const a = Math.random() * Math.PI * 2;
  const R = ballContactReach(0) + 2;
  const at = { x: ball.x + Math.cos(a) * R, y: ball.y + Math.sin(a) * R };
  const glance = (Math.random() * 2 - 1) * 0.9;
  const dir = { x: Math.cos(a + Math.PI + glance), y: Math.sin(a + Math.PI + glance) };
  strikeAt(at, dir, 0.3 + Math.random() * 0.7);
}
function throwBall() {
  const a = Math.random() * Math.PI * 2;
  const s = 20 + Math.random() * 40;
  ball.vx = Math.cos(a) * s;
  ball.vy = Math.sin(a) * s;
}

// --- readout ----------------------------------------------------------------
function readout() {
  let worst = 0;
  for (let i = 0; i < ball.rim.length; i++) worst = Math.max(worst, Math.abs(ball.rim[i]));
  const ss = ballSpinState();
  const lines = [
    `speed ${Math.hypot(ball.vx, ball.vy).toFixed(1)}   spin ${ball.spin.toFixed(2)} rad/s ${ball.spin > 0.01 ? '↺' : ball.spin < -0.01 ? '↻' : ''}   deform ${(worst / ball.r * 100).toFixed(0)}%`,
    `at ${ball.x.toFixed(1)}, ${ball.y.toFixed(1)}   ${ball.y > 0 ? 'AIR' : 'water'}   colour ${hex(CONFIG.versus.ball.look.color)}   strokes ${ss.streaks.length}${ss.streaks.length ? ` arc ${(ss.streaks[0].arc).toFixed(2)} rad` : ''}`,
  ];
  // THE WALL, WHILE ONE IS UP — and the one line that has to be there is the
  // COAST against its bound.
  //
  // The lobes keep `inherit` of the fluke's speed and coast that over the
  // drag; the wall they are drawing is `thick` deep with lobes of their own
  // radius. Past thick + a lobe's radius the mass stops covering the barrier
  // and the goo is visibly somewhere the fish is not stopping, which reads as
  // the collision being broken rather than the throw being loud. It is three
  // numbers on two panels, so nobody could hold it in their head while
  // dragging one of them — hence the arithmetic, live, where the drag is.
  if (gooWalls.length || wallSeal) {
    const w = gooWalls[gooWalls.length - 1];
    const em = CONFIG.emitters.gooWall;
    const B = CONFIG.sealFlip.back;
    const lobe = (em.size?.[0] ?? 0.5) * (CONFIG.fx.goo.groups.gooWall?.radius ?? 4);
    const swing = wallTipSpeed;
    const coast = ((em.inherit ?? 0) * swing) / Math.max(0.01, em.drag ?? 1);
    const bound = (B.thick ?? 1.6) + lobe * 0.5;
    lines.push(
      `wall ${w ? `${w.nodes.length} blobs, ${w.life.toFixed(2)}s left` : 'laying…'}`
      + `   gap ${(B.step ?? 1).toFixed(2)} vs lobe ${lobe.toFixed(2)} across `
      + `${lobe > (B.step ?? 1) ? '(fuses)' : '(BEADS)'}`,
      `goo coasts ${coast.toFixed(2)} off the tail at ${swing.toFixed(0)} u/s `
      + `— bound ${bound.toFixed(2)} (thick + half a lobe) `
      + `${coast <= bound ? 'OK' : 'DRIFTS OFF THE HITBOX'}`,
    );
  }
  // POSSESSION, as the ledger and the field actually hold it — the two colours
  // and how much of the body each has. Without it the only way to tell a share
  // of 0.2 from a share of 1.0 is to look at the ball, which is the thing being
  // judged.
  {
    const c = ballCredit();
    const tm = CONFIG.fx?.goo?.groups?.ball?.teams;
    lines.push(`possession: credit ${c.credit[0].toFixed(1)} / ${c.credit[1].toFixed(1)}   newest ${c.newest}   share ${c.share.toFixed(3)}   seed ${c.seed.toFixed(2)} rad`);
    if (tm) lines.push(`  field: A ${hex(tm.a)} → B ${hex(tm.b)}   ${tm.lobes} lobes   thrown ${tm.wobble.toFixed(2)}   spin ${tm.spin.toFixed(2)}   r ${tm.wr.toFixed(1)}`);
    // THE TRAIL'S SPLIT, as numbers. Which channel is which colour, where each
    // one sits across the band and how bright it is — the three things the
    // ledger decides, and the only way to tell a lean of 0.9 from one of 0.6
    // without measuring pixels.
    const sp = ballTrailSplit();
    const air = ballTrailStats('air');
    const wat = ballTrailStats('water');
    lines.push(`  trail: ${sp.colors.map((c, i) => `${hex(c)} lean ${sp.lean[i].toFixed(2)} x${sp.gain[i].toFixed(2)}`).join('   ')}`);
    lines.push(`  cloud: ${wat.count} under / ${air.count} over   ${wat.plumes} plume(s)`);
    // THE BACKDROP'S CHAIN. How many dents are live, what the newest one is
    // doing and which way it is being dragged — the spring is a signed number
    // that spends half its life negative, and a picture of the lattice cannot
    // tell you whether a dent is on its way out or on its way back.
    const bg = ballGridState();
    const head = bg.dents[0];
    // ...and the LAG, as the angle between the two. A drag that has come round
    // already and one that never lags at all draw the same still frame; the
    // number between them is the whole of what headingLag does.
    const sp2 = Math.hypot(ball.vx, ball.vy);
    const lagDeg = sp2 > 1e-3
      ? (Math.acos(Math.max(-1, Math.min(1, (bg.heading.x * ball.vx + bg.heading.y * ball.vy) / sp2))) * 180 / Math.PI)
      : 0;
    lines.push(`  backdrop: ${bg.live} dent(s)   head amp ${head.amp.toFixed(2)} (born ${head.amp0.toFixed(2)})   along ${head.dirX.toFixed(2)}, ${head.dirY.toFixed(2)}   lag ${lagDeg.toFixed(0)}°`);
  }
  if (lastStrike?.hit) {
    const h = lastStrike.hit;
    lines.push(`last strike: power ${lastStrike.power.toFixed(2)}  impulse ${h.imp?.toFixed(1)}  glance ${h.off?.toFixed(2)}  english ${(h.english ?? 0).toFixed(2)}  slip ${(h.slip ?? 0).toFixed(1)}  +spin ${lastStrike.dSpin.toFixed(2)}`);
    if (h.dent) lines.push(`  dent ${(h.dent.depth * 100).toFixed(0)}% deep, ${h.dent.width.toFixed(2)} rad wide, hardness ${h.dent.hard.toFixed(2)}`);
  } else if (lastStrike) {
    lines.push('last strike: MISSED (press nearer the ball)');
  }
  valsEl.textContent = lines.join('\n');
  noteEl.textContent = presetNote + (dirtyPreset ? '  ·  unsaved changes (W)' : '');
}

// --- controls ---------------------------------------------------------------
let auto = false;
let frozen = false;
let autoClock = 0;
b('bStrike').addEventListener('click', randomStrike);
b('bSlap').addEventListener('click', () => tailSlap());
b('bWall').addEventListener('click', () => tailWall());
b('bThrow').addEventListener('click', throwBall);
b('bAuto').addEventListener('click', () => { auto = !auto; b('bAuto').classList.toggle('on', auto); });
b('bFreeze').addEventListener('click', () => { frozen = !frozen; b('bFreeze').classList.toggle('on', frozen); });
b('bReset').addEventListener('click', () => { resetBall(); clearBallTrail(scene); resetBallGrid(); });
b('bOverlay').addEventListener('click', () => { overlay = !overlay; b('bOverlay').classList.toggle('on', overlay); });
b('bOverlay').classList.toggle('on', overlay);
b('bSave').addEventListener('click', () => writePreset());
b('bApply').addEventListener('click', () => applyToConfig());
b('bDefaults').addEventListener('click', () => {
  // config.js as loaded — which INCLUDES imported-tuning.json, because that is
  // what the game actually runs.
  for (const [path, v] of Object.entries(DEFAULTS)) setPath(CONFIG, path, v);
  refreshSliders();
  updateBounds(viewport().w / viewport().h);
  layoutPitch();
  dirtyPreset = false;
  presetNote = 'config.js as loaded (tuning included)';
});
window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); randomStrike(); }
  if (e.key === 't' || e.key === 'T') throwBall();
  if (e.key === 's' || e.key === 'S') tailSlap();
  if (e.key === 'd' || e.key === 'D') tailWall();
  if (e.key === 'a' || e.key === 'A') b('bAuto').click();
  if (e.key === 'f' || e.key === 'F') b('bFreeze').click();
  if (e.key === 'r' || e.key === 'R') { resetBall(); clearBallTrail(scene); resetBallSpit(); resetBallGrid(); }
  if (e.key === 'o' || e.key === 'O') b('bOverlay').click();
  if (e.key === 'W') writePreset();
  if (e.key === '[') ball.spin -= lab.spinNudge;
  if (e.key === ']') ball.spin += lab.spinNudge;
  if (e.key === 'p' || e.key === 'P') { trace = !trace; if (trace) clearTrace(); }
  if (e.key === 'c' || e.key === 'C') clearTrace();
});

function preset() {
  const out = {};
  for (const [path, label] of CONFIG_SLIDERS) {
    if (!label) continue;
    out[path] = getPath(CONFIG, path);
  }
  out.savedAt = new Date().toISOString();
  return out;
}
async function writePreset() {
  try {
    const r = await fetch('/preset/ball-lab.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    presetNote = r.ok ? `saved tools/looks/ball-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
    dirtyPreset = !r.ok;
  } catch (err) {
    presetNote = `save failed: ${err.message}`;
  }
}
async function applyToConfig() {
  try {
    const r = await fetch('/apply/ball-lab', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    const report = await r.json();
    if (report.error) { presetNote = `apply failed: ${report.error}`; return; }
    const changed = report.changes?.length ?? 0;
    const cleared = report.cleared?.length ?? 0;
    presetNote = (report.wrote ? `wrote config.js: ${changed} value(s)` : 'config.js already matches')
      + (cleared ? `, cleared ${cleared} shadowing tuning value(s)` : '')
      + '\n' + (report.notes ?? []).filter((n) => n.startsWith('!') || n.startsWith('?')).join('\n');
    dirtyPreset = false;
  } catch (err) {
    presetNote = `apply failed: ${err.message}`;
  }
}

// --- the loop ---------------------------------------------------------------
const DT = 1 / 60;
function step(dt) {
  // The same two calls the match makes, so the lab drives the SHIPPING state
  // machine rather than an impression of it. speedRef matches versus.js.
  const ref = Math.max(1, CONFIG.versus?.impact?.speedRef ?? 30);
  setBallDrive({
    speed01: Math.hypot(ball.vx, ball.vy) / ref,
    charge01: lab.pressPower ?? 0,
    owner: labOwner >= 0 ? labOwner : null,
  });
  // WALL CLOCK in the match; here dt already is one.
  updateBallLook(dt);
  driveOutline();
  if (auto) {
    autoClock += dt;
    const every = 1 / Math.max(0.05, lab.autoHz);
    if (autoClock >= every) { autoClock -= every; randomStrike(); }
  }
  // THE FLIP'S OWN CLOCK, on wall seconds like the match runs it, and the
  // contact resolved while its window is open. Before stepBallAlone for the
  // same reason the match resolves contacts before it steps the ball: the
  // impulse belongs on the frame the tail was there.
  updateSealFlip(dt, null);
  if (flipState.slapLive && slapFrom) flipSlapBall(0, slapFrom);
  if (!flipState.active) slapFrom = null;
  // ...and the backflip's wall, painted and then ageing. The ball bounces off
  // it inside versus.js's own frame, which this page does not run — so what is
  // on show here is the MASS: whether the blobs fuse into a barrier.
  stepTailWall();
  updateGooWalls(dt, null);
  stepBallAlone(dt);
  // THE TRAIL, exactly as updateVersusClock drives it: the shipping module, the
  // shipping wall clock, the ball's own drawn edge. It is the only place the
  // two-colour split can be judged, because what it splits into is a possession
  // ledger and the lab is the only place that hands the ball over on a button.
  updateBallTrail(dt, scene, ball, { radiusAt: ballHitRadiusAt });
  // ...AND THE BACKDROP'S CHAIN OF DENTS, on the same clock and in the same
  // order the match drives them (updateVersusClock, then main.js's publish).
  // The lattice gets no seal and no fingers here — see NO_SEAL — so everything
  // moving in it is the ball.
  updateBallGrid(dt);
  publishBallGrid(grid);
  grid.update(dt, NO_SEAL, null, { camera: cam, wake: 0 });
  if (trace) traceStep();
  updateParticles(dt);
  if (markFade > 0) {
    markFade = Math.max(0, markFade - dt * 1.5);
    sealMark.material.opacity = markFade * 0.5;
  }
  if (lastStrike) lastStrike.t += dt;
}
function render() {
  updateOverlay();
  updateTrace();
  renderBall();
  post.render(scene, cam, DT);
}

let sizedW = 0;
let sizedH = 0;
function ensureSize() {
  const { w, h } = viewport();
  if (w === sizedW && h === sizedH) return;
  sizedW = w; sizedH = h;
  resize();
}

let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  ensureSize();
  if (!frozen) step(dt);
  readout();
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// A frame off disk on demand, for reading without a live pane.
async function shoot(name) {
  render();
  const blob = await new Promise((res) => stage.toBlob(res, 'image/png'));
  await fetch(`/shot/${name}.png`, { method: 'POST', body: blob });
}
window.__shoot = shoot;
window.__strike = strikeAt;
window.__random = randomStrike;
window.__ball = ball;
window.__set = (path, v) => { setPath(CONFIG, path, v); refreshSliders(); onConfigChange(path); };
window.__lab = lab;
window.__step = (n = 1) => { for (let i = 0; i < n; i++) step(DT); readout(); render(); };
window.__preset = preset;
// WHAT THE LAST HIT ACTUALLY SPAT, for tuning the contact-patch burst
// (systems/ballSpit.js) without counting dots on a screenshot. `asked` is what
// the two fans requested and `alive` is what is in the buffer right now — the
// gap between them is CONFIG.fx.spriteDensity and the relief ramp, which is
// exactly the thing a count off a picture cannot tell you.
window.__spit = () => ({ ...ballSpitStats(), alive: particleCount() });
// The relief ramp adapts to frame time, and stepping this page by hand feeds it
// nonsense dt. Pinned so a measured burst is a measurement of the burst.
window.__relief = (v = 1) => setParticleRelief(v);
window.__trace = (on = true) => { trace = on; clearTrace(); };
window.__spinState = ballSpinState;
window.__wall = () => tailWall();
window.__walls2 = () => gooWalls.map((w) => ({ nodes: w.nodes.length, life: +w.life.toFixed(3) }));
// The lattice and the chain, for a harness driving this page from outside —
// tools/looks/serve.mjs shoots frames off it and there is no other way to ask
// whether a dent was actually published.
window.__grid = grid;
window.__gridState = ballGridState;
window.__scene = scene;
window.__bounds = bounds;

// `?shots` posts a strip: the ball at rest, then a glancing strike a few frames in.
if (q.has('shots')) {
  for (let i = 0; i < 120; i++) {
    ensureSize();
    if (stage.width >= 8 && sizedW === viewport().w && sizedH === viewport().h) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 150));
  ensureSize();
  frozen = true;
  resetBall();
  window.__step(2);
  await shoot('ball-rest');
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y + 1.5 }, { x: 1, y: 0.35 }, 1);
  window.__step(3);
  await shoot('ball-struck');
  window.__step(12);
  await shoot('ball-ripple');

  // THE SPIN. A ball turning hard each way, the strokes fully out, then a
  // struck ball with english on it, its path traced so the curve shows.
  resetBall();
  ball.spin = 12;
  window.__step(30);
  await shoot('ball-spin-ccw');
  resetBall();
  ball.spin = -12;
  window.__step(30);
  await shoot('ball-spin-cw');
  resetBall();
  ball.spin = 4;
  window.__step(30);
  await shoot('ball-spin-light');
  // The curve: square hit from the left, full power, english all the way.
  resetBall();
  ball.x = bounds.left + ball.r + 6;
  trace = true; clearTrace();
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, 1, 1);
  window.__step(48);
  await shoot('ball-english-curve');
  resetBall();
  ball.x = bounds.left + ball.r + 6;
  clearTrace();
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, 1, -1);
  window.__step(48);
  await shoot('ball-english-curve-reverse');
  resetBall();
  ball.x = bounds.left + ball.r + 6;
  clearTrace();
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, 1, 0);
  window.__step(48);
  await shoot('ball-english-none');
  trace = false;
  noteEl.textContent = 'shots posted';
}
