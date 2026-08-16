import {
  getAssetMaterials, setAssetTexture, setAssetTint, setAssetRepeat, hasCustomTexture,
  setAssetEmissive, setAssetGlow, supportsEmissive, getAssetSizeMultiplier,
  loadUploadedAsset, isSpriteFile, setAssetEmissiveMask, assetEmissiveMaskState,
  lookLeader, glowIsProcedural, assetGlowPreset,
} from '../assets.js';
import { saveModelToDB, loadModelFromDB, deleteModelFromDB } from '../systems/modelStorage.js';
import { CONFIG, TUNER_SCHEMA, saveTuningToStorage } from '../config.js';
import { expandDesc } from '../upgradeText.js';
import { buildSection, buildSectionedTunerGroups, buildExpandAllToggle } from './tunerControls.js';
import { isTypingTarget } from './typing.js';
import { playSfx, unlockAudio, applyAudioBusSettings, busReduction, gainToDb, dbToGain, DB_FLOOR } from '../systems/audio.js';
import { uploadAsset } from '../systems/assetUpload.js';
import { emit } from '../entities/particles.js';
import { loadTrackFromFile, hasTrack, clearTrack, play as playMusic, stop as stopMusic, loopDuration, onTracksChanged } from '../systems/music.js';
import {
  startAmbient, stopAmbient, resetAmbient, reloadAmbient, applyAmbientSettings,
  loadAmbientFromFile, clearAmbientClip, hasAmbientClip, onAmbientClipsChanged, ambientState,
  skipAmbientClip,
} from '../systems/ambient.js';

// Curated rather than every ASSETS key: particles and the like are tiny FX
// that don't benefit from a texture, so they're left out to reduce clutter. Everything that swims — every companion, and every species with an
// entry in CONFIG.enemies — gets a row, because tint/emissive/glow are how you
// tell two creatures sharing one model apart, and a creature with no row here
// has no way to be recoloured at all.
// The sections are what you actually navigate by: 48 model rows is four
// screens of scrolling, and "where's the megalodon" has no answer in a flat
// list except dragging past everything. These headers were already here as
// comments — they now collapse, which is the only reason the comments were
// worth reading in the first place.
const EDITABLE_SECTIONS = [
  ['Seal & companions', [
    ['ship', 'Seal (ship)'],
    // Colour, glow and texture come from the seal above — the escorts are the
    // same animal, so they are one surface (LOOK_FOLLOWS in assets.js). The
    // model upload and size on this row are still their own.
    ['sealTeam', 'Seal team escort (colour follows the seal)'],
    ['belugaDrone', 'Beluga (ability)'],
    ['eelCompanion', 'Eel companion (ability)'],
    ['seagull', 'Seagull bomb (ability)'],
    ['starfish', 'Starfish (ability)'],
    ['shrimp', 'Shrimp (ability, upload in main tuner)'],
    ['dumboOcto', 'Dumbo octopus (ability)'],
    ['octoGrabber', 'Octopus grabber (ability)'],
    ['orcaFriendBull', 'Orca family — bull (ability)'],
    ['orcaFriendCow', 'Orca family — cow (ability)'],
    ['orcaFriendCalf', 'Orca family — calf (ability)'],
  ]],
  ['Boats', [
    ['boat', 'Boat'],
    ['trawler', 'Trawler'],
    ['bakalarBoat', "Bakalar's boat (ability)"],
  ]],
  ['Pickups', [
    ['attractorOrb', 'Attractor orb'],
    ['xpOrb', 'Chum bit (XP pickup)'],
    ['bubbleOrb', 'Bubble (oxygen)'],
    ['strikeOrb', 'Strike orb'],
    ['rapidFireOrb', 'Rapid-fire orb'],
    ['trapBubble', 'Beluga bubble'],
  ]],
  ['Weapons & projectiles', [
    ['bullet', 'Bullet'],
    ['missile', 'Missile'],
    ['scallopShell', 'Scallop squirter (ability)'],
    ['pearl', 'Oyster pearl (ability)'],
    ['pearlBomblet', 'Pearl bomblet (ability)'],
    ['voicemailBomb', "Bakalar's voicemail bomb"],
    ['bounceShot', 'Bounce shot'],
    ['club', 'Fin club (ability)'],
    ['clubBoom', 'Club — Powder Keg (ability)'],
    ['clubIce', 'Club — Cold Snap (ability)'],
    ['clubThrow', 'Club — thrown (ability)'],
    ['shrapnel', 'Strike shrapnel'],
    ['enemyBullet', 'Enemy bullet'],
  ]],
  ['Apex predators', [
    ['enemyShark', 'Shark'],
    ['enemyGreatWhite', 'Great White'],
    ['enemyHammerhead', 'Hammerhead'],
    ['enemyMegalodon', 'Megalodon'],
    ['enemyMightyMeg', 'Mighty Meg'],
    ['enemyOrcaBull', 'Orca boss — bull'],
    ['enemyOrcaCow', 'Orca boss — cow'],
    ['enemyBarracuda', 'Barracuda'],
    ['enemyOtter', 'Otter'],
    ['enemyDolphin', 'Dolphin'],
  ]],
  ['Fish & schools', [
    ['enemyFish', 'Coral fish'],
    ['enemyTrout', 'Trout'],
    ['enemyTang', 'Tang'],
    ['enemyReeffish', 'Reef fish'],
    ['enemyFishPackA', 'Fish pack A'],
    ['enemyFishPackB', 'Fish pack B'],
    ['enemyFishPackC', 'Fish pack C'],
  ]],
  ['Drifters & crawlers', [
    ['enemyStingray', 'Stingray'],
    ['enemySeaTurtle', 'Sea turtle'],
    ['enemyWalkingCrab', 'Walking crab'],
    ['enemyOyster', 'Oyster'],
  ]],
];

// The same list in the two shapes appendSectioned() wants: membership by id,
// and the label each row is titled with.
const MODEL_SECTIONS = EDITABLE_SECTIONS.map(([title, entries]) => [title, entries.map(([key]) => key)]);
const MODEL_LABELS = new Map(EDITABLE_SECTIONS.flatMap(([, entries]) => entries));

// Which sections each Look & Sound tab shows, and in what order. Order is
// roughly "what you reach for most" first, not alphabetical. A group tagged
// with a section missing from these lists still renders, under "More" — see
// buildSectionedTunerGroups.
const SECTION_ORDER = {
  companions: ['Your weapon', 'Strike & movement', 'Escorts', 'Auras & orbits', 'Thrown & launched'],
  enemies: ['Apex predators', 'Fish & schools', 'Crabs & crawlers', 'Boats', 'Spawning & difficulty', 'Look & motion'],
};


const EMITTER_SECTIONS = [
  ['Your weapon', ['muzzle', 'sparks', 'bounce', 'explosion', 'bigExplosion', 'missileLaunch', 'missileTrail', 'missileImpact']],
  ['The seal', ['boost', 'playerHit', 'bite', 'splash', 'breathBubbles', 'wakeBubbles', 'bubbleBurst']],
  ['Pickups & progression', ['pickup', 'chumCrumbs', 'levelUp']],
  ['Escorts', ['trapPop']],
  ['The ocean', ['rainSplash', 'silt', 'sunPass', 'moonPass']],
];

// Upgrade cards, sorted by what taking one gives you rather than by the row
// order in upgrades.csv. Same section names as the Companions tab, so "which
// card grants the eel" and "what does the eel do" are one word apart.
const UPGRADE_SECTIONS = [
  ['Your weapon', ['rapidFire', 'heavyRounds', 'multishot', 'pierce', 'velocity', 'homingMissile', 'bounceShot']],
  ['Strike & movement', ['maxSpeed', 'overboost', 'strikePower', 'strikeDash', 'strikeShrapnel', 'strikeCharge', 'breachChain']],
  ['Survivability', ['vitality', 'regen', 'magnet', 'oxygenMax', 'oxygenRefill']],
  ['Escorts', ['sealTeam', 'electricEel', 'beluga', 'dumbo', 'octoGrab', 'orcaFamily']],
  ['Auras & orbits', ['seaGarlic', 'shrimpRing', 'calamari']],
  ['Thrown & launched', ['starfish', 'seagullBomb', 'scallopSquirter', 'oysterBlaster', 'bakalar']],
];


const STYLES = `
  .sv-tex { position: fixed; top: 0; left: 0; bottom: 0; width: 300px; z-index: 30;
    background: rgba(10,12,18,0.94); border-right: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(10px); color: #e8ecf3; font-family: 'Inter', system-ui, sans-serif;
    display: flex; flex-direction: column; }
  .sv-tex.sv-hidden { display: none; }
  .sv-tex h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; margin: 0; }
  .sv-tex-head { padding: 16px 18px 0; flex-shrink: 0; }
  .sv-tex .sv-tex-note { font-size: 10px; color: rgba(232,236,243,0.4); margin: 6px 0 12px; line-height: 1.5; }
  /* Six tabs don't fit one 300px row, so they wrap into a 3x2 grid — with a
     full border and radius, since the "tab strip sitting on the body" look
     (no bottom border) only reads right as a single row. */
  .sv-tex-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 10px 0 8px; }
  .sv-tex-tab { padding: 6px 3px; font-size: 10px; font-weight: 600; text-align: center; cursor: pointer;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
    background: rgba(255,255,255,0.03); color: rgba(232,236,243,0.55);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-tex-tab.sv-tex-tab-active { background: rgba(122,215,255,0.12); color: #7ad7ff; border-color: rgba(122,215,255,0.4); }
  .sv-tex-body { flex: 1; overflow-y: auto; padding: 12px 18px 32px; }
  .sv-tex-panel { display: none; }
  .sv-tex-panel.sv-tex-panel-active { display: block; }
  .sv-tex-expand-row { display: flex; justify-content: flex-end; padding-bottom: 2px;
    border-bottom: 1px solid rgba(255,255,255,0.08); }
  .sv-tex-row { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .sv-tex-name { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .sv-tex-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.2); flex-shrink: 0; }
  .sv-tex-dot.sv-tex-active { background: #7ad7ff; }
  .sv-tex-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .sv-tex-controls input[type=file] { display: none; }
  .sv-tex-btn { font-size: 10px; font-weight: 600; padding: 5px 9px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.16);
    background: rgba(255,255,255,0.06); color: #e8ecf3; cursor: pointer; font-family: inherit; }
  .sv-tex-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-tex-controls input[type=color] { width: 26px; height: 24px; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 5px; background: none; padding: 0; cursor: pointer; }
  .sv-tex-repeat { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
  .sv-tex-repeat label { font-size: 9px; color: rgba(232,236,243,0.5); width: 12px; }
  .sv-tex-repeat input[type=range] { flex: 1; accent-color: #7ad7ff; height: 14px; }
  .sv-tex-divider { border-top: 1px solid rgba(255,255,255,0.08); margin: 8px 0 6px; padding-top: 6px; }
  .sv-tex-glowrow { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .sv-tex-glowrow label { font-size: 9px; color: rgba(232,236,243,0.5); width: 46px; flex-shrink: 0; }
  .sv-tex-glowrow input[type=range] { flex: 1; accent-color: #ffb347; height: 14px; }
  .sv-tex-glowrow input[type=color] { width: 26px; height: 22px; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 5px; background: none; padding: 0; cursor: pointer; }
  .sv-tex-variant-name { font-size: 9px; color: rgba(232,236,243,0.45); flex-shrink: 0; min-width: 62px; text-align: right; }
  .sv-tex-upload-status { font-size: 9px; color: rgba(232,236,243,0.45); margin-top: 4px; line-height: 1.4; }
  .sv-up-text { flex: 1; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 3px 6px; font-size: 10px; min-width: 0; }
  /* The read-only twin of .sv-up-text — same size and rhythm so the Upgrades
     roster lines up with the editable rows in the other tabs, but no box
     around it, because there's nothing to type into. */
  .sv-up-value { flex: 1; color: #e8ecf3; font-size: 10px; min-width: 0; padding: 3px 0;
    line-height: 1.35; overflow-wrap: anywhere; }
  .sv-tex-size-number { width: 54px; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 2px 5px; font-size: 10px; }

  .sv-sfx-row { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .sv-sfx-name { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
  .sv-sfx-type { font-size: 9px; color: rgba(232,236,243,0.4); text-transform: uppercase; letter-spacing: 0.05em; }
  .sv-sfx-field { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
  /* One row per loaded sample variation, indented under the sample controls
     so it reads as belonging to them rather than as another field. */
  .sv-sfx-variations { margin: 4px 0 2px 50px; display: flex; flex-direction: column; gap: 3px; }
  .sv-sfx-variation { display: flex; align-items: center; gap: 5px; }
  .sv-sfx-variation-name { flex: 1; font-size: 9px; color: rgba(232,236,243,0.55);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-sfx-variation .sv-tex-btn { padding: 1px 6px; font-size: 10px; line-height: 1.4; }
  /* Wide enough for the longest field names ('noise mix', 'pitch var',
     'filt var') at this font size. Ellipsis rather than a hard clip so
     anything longer still degrades readably, with the full text on hover. */
  .sv-sfx-field label { font-size: 9px; color: rgba(232,236,243,0.5); width: 62px; flex-shrink: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-sfx-field input[type=range] { flex: 1; accent-color: #ffb347; height: 14px; }
  .sv-sfx-field select { flex: 1; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 4px 6px; font-size: 10px; }
  .sv-sfx-val { font-size: 9px; color: rgba(232,236,243,0.6); width: 44px; flex-shrink: 0;
    text-align: right; font-variant-numeric: tabular-nums; }
  /* A flex child defaults to min-width:auto, and a range input's intrinsic
     width is wider than the space left in a 300px panel once the label and the
     value readout have taken theirs — so these rows were pushing their own
     numbers off the right edge (81 of them on the Sound tab). Letting them
     shrink fixes it. Pre-dates the sections; their 11px indent is what made it
     impossible to miss. */
  .sv-sfx-field input[type=range], .sv-sfx-field select,
  .sv-tex-glowrow input[type=range], .sv-tex-repeat input[type=range] { min-width: 0; }
`;

let panel = null;
let upgradesPanelEl = null;
const rows = new Map();
const resetExtras = new Map();

// Refresh closures for every control in the Sound, Haptics and Particles tabs
// (see slider(), and the hand-built rows in buildHapticRow). These tabs build
// their own controls rather than going through TUNER_SCHEMA, so
// refreshTunerRows() in tunerControls.js does not know about them.
const texRows = [];

/**
 * Put the Sound, Haptics and Particles controls back in step with CONFIG.
 * Call after anything that rewrites CONFIG behind the panel's back — Reset and
 * importing a tuning file both do.
 */
export function refreshTexturePanelRows() {
  for (const fn of texRows) fn();
}

// Rebuild the Upgrades tab from CONFIG. Its inputs are populated once, when
// the panel is built, so anything that changes CONFIG.upgrades from outside
// (Reset, importing a tuning file) needs to say so — otherwise the table goes
// on showing values that are no longer in effect. The rows are pure CONFIG
// with no upload state, so throwing them away and rebuilding is safe.
export function refreshUpgradeTable() {
  if (!upgradesPanelEl) return;
  upgradesPanelEl.replaceChildren(buildUpgradeTable());
}

// `onTuningChanged` is the same handler the ` tuner uses — the Companions and
// Enemies tabs hold real tuner controls, so a slider there has to rebuild the
// grid or resize the camera exactly like it would on the other panel.
// Fill a tab with rows sorted into collapsible sections, plus the
// expand/collapse-all toggle above them. `sections` is [[title, ids]] in the
// order they should appear; `keys` is what the config actually holds right now.
//
// The two are checked against each other rather than trusted: an id listed in a
// section but missing from the config is skipped (a sound can be deleted), and
// an id in the config that no section claims lands in a trailing "More". That
// second half is the important one — adding a sound to CONFIG.sfx and
// forgetting to file it here leaves it reachable and visibly unfiled, instead
// of building a panel that silently cannot edit it.
function appendSectioned(container, scope, sections, keys, makeRow) {
  const present = new Set(keys);
  const claimed = new Set();
  const plan = [];
  for (const [title, ids] of sections) {
    const mine = ids.filter((id) => present.has(id));
    for (const id of mine) claimed.add(id);
    if (mine.length) plan.push([title, mine]);
  }
  const unfiled = keys.filter((id) => !claimed.has(id));
  if (unfiled.length) plan.push(['More', unfiled]);

  const body = document.createElement('div');
  for (const [title, ids] of plan) {
    const section = buildSection(title, scope);
    for (const id of ids) section.body.appendChild(makeRow(id));
    section.setCount(ids.length);
    body.appendChild(section.el);
  }

  const bar = document.createElement('div');
  bar.className = 'sv-tex-expand-row';
  bar.appendChild(buildExpandAllToggle(body));
  container.append(bar, body);
  return body;
}

export function initTexturePanel(onAssetChanged, onTuningChanged) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-tex sv-hidden';
  panel.innerHTML = `
    <div class="sv-tex-head">
      <h2>Look &amp; Sound</h2>
      <div class="sv-tex-note">Everything that lives in the ocean: models and textures, companion abilities, enemy behaviour and spawns, upgrade cards, sound and particles. Press T to toggle, \` for the rest of the tuning.</div>
      <div class="sv-tex-tabs">
        <div class="sv-tex-tab sv-tex-tab-active" data-tab="creatures">Models</div>
        <div class="sv-tex-tab" data-tab="companions">Companions</div>
        <div class="sv-tex-tab" data-tab="enemies">Enemies</div>
        <div class="sv-tex-tab" data-tab="upgrades">Upgrades</div>
        <div class="sv-tex-tab" data-tab="sound">Mix</div>
        <div class="sv-tex-tab" data-tab="particles">Particles</div>
      </div>
    </div>
    <div class="sv-tex-body">
      <div class="sv-tex-panel sv-tex-panel-active" id="svTexPanelCreatures"></div>
      <div class="sv-tex-panel" id="svTexPanelCompanions"></div>
      <div class="sv-tex-panel" id="svTexPanelEnemies"></div>
      <div class="sv-tex-panel" id="svTexPanelUpgrades"></div>
      <div class="sv-tex-panel" id="svTexPanelSound"></div>
      <div class="sv-tex-panel" id="svTexPanelParticles"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const creaturesPanel = panel.querySelector('#svTexPanelCreatures');
  appendSectioned(creaturesPanel, 'models', MODEL_SECTIONS, [...MODEL_LABELS.keys()], (key) => {
    const row = buildCreatureRow(key, MODEL_LABELS.get(key), onAssetChanged);
    rows.set(key, row);
    return row.el;
  });

  // What is left of the old Sound tab once the per-event rows moved to the
  // workbench (F): the three things here that were never one event's sound.
  // The bus colours every voice, the music chain is on its own graph entirely,
  // and the ambient bed is a continuous sound with no event behind it — none
  // of the three has a row in an event-first panel to live in.
  //
  // The 67 voice rows and the whole Haptics tab are gone. They were a second
  // place to edit the same numbers, and a second place is a place to disagree:
  // that tab listed voices while Haptics listed events, so `kill` appeared in
  // both under different identities and neither showed what the other did.
  const soundPanel = panel.querySelector('#svTexPanelSound');
  const master = buildSection('Mix, music & ambience', 'sound');
  master.body.append(buildBusRow(), buildMusicRow(), buildAmbientRow());
  master.setCount(3);
  soundPanel.appendChild(master.el);

  const moved = document.createElement('div');
  moved.className = 'sv-tex-upload-status';
  moved.style.marginTop = '12px';
  moved.textContent = 'Per-sound levels, samples, rumble and everything else an event does are in the Feel workbench — press F.';
  soundPanel.appendChild(moved);

  const particlesPanel = panel.querySelector('#svTexPanelParticles');
  appendSectioned(particlesPanel, 'particles', EMITTER_SECTIONS, Object.keys(CONFIG.emitters), buildEmitterRow);

  upgradesPanelEl = panel.querySelector('#svTexPanelUpgrades');
  upgradesPanelEl.appendChild(buildUpgradeTable());

  // The ability and enemy groups that used to sit in the ` panel's flat
  // scroll. Filtered by tag rather than listed here, so moving a group between
  // panels is a one-line change in TUNER_SCHEMA and can't leave it homeless.
  for (const [tag, id, blurb] of [
    ['companions', '#svTexPanelCompanions',
      'Every ability that fights alongside you — orbit, reach, damage and cooldown. Which upgrade card grants each one is on the Upgrades tab; its model and colour are on Models. The camera punch the food chain fires is under Camera in the ` panel, with the rest of the camera.'],
    ['enemies', '#svTexPanelEnemies',
      'What spawns, how often, how early, and how it behaves. Set a spawn rate to 0 to switch a creature off entirely. The kill shot’s push-in and its trophy photo are under Camera in the ` panel.'],
  ]) {
    const el = panel.querySelector(id);
    const note = document.createElement('div');
    note.className = 'sv-tex-upload-status';
    note.style.marginBottom = '4px';
    note.textContent = blurb;
    el.appendChild(note);

    // Same collapsed-by-default groups as the ` panel, with the same
    // open-everything escape hatch above them — sorted here into named
    // sections, which the flat ` panel has no equivalent of.
    const groupsEl = document.createElement('div');
    groupsEl.appendChild(buildSectionedTunerGroups(
      TUNER_SCHEMA.filter((g) => g.panel === tag), SECTION_ORDER[tag], onTuningChanged, tag,
    ));

    const expandAll = document.createElement('div');
    expandAll.className = 'sv-tex-expand-row';
    expandAll.appendChild(buildExpandAllToggle(groupsEl));
    el.append(expandAll, groupsEl);
  }

  const tabPanelIds = {
    creatures: 'svTexPanelCreatures',
    companions: 'svTexPanelCompanions',
    enemies: 'svTexPanelEnemies',
    upgrades: 'svTexPanelUpgrades',
    sound: 'svTexPanelSound',
    particles: 'svTexPanelParticles',
  };
  for (const tab of panel.querySelectorAll('.sv-tex-tab')) {
    tab.addEventListener('click', () => {
      for (const t of panel.querySelectorAll('.sv-tex-tab')) t.classList.remove('sv-tex-tab-active');
      for (const p of panel.querySelectorAll('.sv-tex-panel')) p.classList.remove('sv-tex-panel-active');
      tab.classList.add('sv-tex-tab-active');
      panel.querySelector(`#${tabPanelIds[tab.dataset.tab]}`).classList.add('sv-tex-panel-active');
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 't' && !isTypingTarget(e.target)) {
      panel.classList.toggle('sv-hidden');
    }
  });
}

// Re-push every stored look value onto whatever materials the asset
// currently has. Safe to call any time; used after a model swap replaces
// the material instances the look was originally applied to.
function reapplyLook(key, look) {
  if (!look) return;
  if (look.tint != null) setAssetTint(key, look.tint);
  // Emission is the biolumSkin's on a procedurally-shaded model and there is
  // no control for it here (see the note where those rows are built), so a
  // stale flood in the snapshot must not come back through a model swap
  // either — this function is the other door into the same materials.
  const procedural = glowIsProcedural(key);
  if (!procedural && look.emissive != null) setAssetEmissive(key, look.emissive);
  if (!procedural && look.glow != null && look.glow !== 1) setAssetGlow(key, look.glow);
  if (look.repeatX !== 1 || look.repeatY !== 1) setAssetRepeat(key, look.repeatX, look.repeatY);
  // Size is assets.csv's — see the read-only row below. Re-pushing it here
  // would put a stale snapshot value back over the file.
  // Explicit choices only — null means "follow the global", and re-pushing it
  // would pin the model to whatever the global happened to be at the time.
  if (look.emissiveMask != null) setAssetEmissiveMask(key, look.emissiveMask);
}

// The stored look for `key` — which for a FOLLOWER is its leader's, not one of
// its own. The escorts' row therefore drags the player's colour, and both
// bodies move together; see LOOK_FOLLOWS in assets.js for why they are one
// surface. Everything else on that row (the model upload, the size readout) is
// still the escorts' own.
function lookState(key) {
  const lead = lookLeader(key);
  if (lead !== key) return lookState(lead);
  if (!CONFIG.assetLooks[key]) {
    CONFIG.assetLooks[key] = {
      tint: null, emissive: null,
      repeatX: 1, repeatY: 1, sizeMultiplier: 1, glow: 1,
      // null = follow CONFIG.glow.emissiveMaps; true/false = this model
      // overrides it. See setAssetEmissiveMask.
      emissiveMask: null,
    };
  }
  return CONFIG.assetLooks[key];
}

function buildCreatureRow(key, label, onAssetChanged) {
  const look = lookState(key);

  const el = document.createElement('div');
  el.className = 'sv-tex-row';

  const nameRow = document.createElement('div');
  nameRow.className = 'sv-tex-name';
  const dot = document.createElement('span');
  dot.className = 'sv-tex-dot';
  const nameText = document.createElement('span');
  nameText.textContent = label;
  nameRow.append(dot, nameText);

  const controls = document.createElement('div');
  controls.className = 'sv-tex-controls';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'sv-tex-btn';
  uploadBtn.textContent = 'Upload';
  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const THREE = await import('three');
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      setAssetTexture(key, tex);
      dot.classList.add('sv-tex-active');
      // Uploaded images aren't saved across reloads — an image can be
      // hundreds of KB to several MB, and localStorage's quota (usually
      // 5-10MB total) wouldn't survive more than one or two of these.
      // Everything else on this row (tint/emissive/glow/roughness/size/
      // variant) DOES persist.
    } catch (err) {
      console.warn(`[textures] failed to load uploaded image for "${key}"`, err?.message ?? err);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  const tint = document.createElement('input');
  tint.type = 'color';
  tint.title = 'Tint';
  tint.value = look.tint != null ? `#${look.tint.toString(16).padStart(6, '0')}` : '#ffffff';
  tint.addEventListener('input', () => {
    const hex = parseInt(tint.value.slice(1), 16);
    look.tint = hex;
    setAssetTint(key, hex);
    saveTuningToStorage();
  });
  if (look.tint != null) setAssetTint(key, look.tint);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'sv-tex-btn';
  resetBtn.textContent = 'Reset';

  controls.append(fileInput, uploadBtn, tint, resetBtn);

  const repeatRow = document.createElement('div');
  repeatRow.className = 'sv-tex-repeat';
  const lx = document.createElement('label');
  lx.textContent = 'X';
  const repeatX = document.createElement('input');
  repeatX.type = 'range';
  repeatX.min = '0.2'; repeatX.max = '6'; repeatX.step = '0.1'; repeatX.value = look.repeatX;
  const ly = document.createElement('label');
  ly.textContent = 'Y';
  const repeatY = document.createElement('input');
  repeatY.type = 'range';
  repeatY.min = '0.2'; repeatY.max = '6'; repeatY.step = '0.1'; repeatY.value = look.repeatY;
  const syncRepeat = () => {
    look.repeatX = Number(repeatX.value);
    look.repeatY = Number(repeatY.value);
    setAssetRepeat(key, look.repeatX, look.repeatY);
    saveTuningToStorage();
  };
  repeatX.addEventListener('input', syncRepeat);
  repeatY.addEventListener('input', syncRepeat);
  repeatRow.append(lx, repeatX, ly, repeatY);
  if (look.repeatX !== 1 || look.repeatY !== 1) setAssetRepeat(key, look.repeatX, look.repeatY);

  el.append(nameRow, controls, repeatRow);

  // Emissive colour / glow / roughness — a flat-colour alternative to
  // uploading a texture. Only shown for materials that support it.
  // Glow applies to EVERY material now — lit ones via emissiveIntensity,
  // unlit ones (all the orbs, bullets and procedural shapes) via HDR colour
  // overdrive — so it's always shown rather than hidden on unlit assets.
  // Emissive colour still only exists on lit materials. Roughness and the
  // variant cycler were removed.
  let emissiveSwatch = null, glowSlider = null;
  {
    const divider = document.createElement('div');
    divider.className = 'sv-tex-divider';
    el.append(divider);

    // A CREATURE WHOSE GLOW IS PROCEDURAL GETS NEITHER CONTROL.
    //
    // Both of these write a UNIFORM emission over the whole body, and these
    // models ship no emissive map to shape one with — so the only thing they
    // can do is flood the pattern that is meant to be the mask. The day crab
    // spent months at emissive #f4d2f8 / glow 4.05 and rendered as a flat
    // white silhouette with all three of its shell skins invisible
    // underneath, which is what this row is for.
    //
    // A note rather than a disabled slider, and the same treatment the Size
    // slider got when assets.csv took it over: a control that still moves but
    // is discarded on the next reload is worse than no control, because it
    // looks like it worked.
    if (glowIsProcedural(key)) {
      const note = document.createElement('div');
      note.className = 'sv-tex-glowrow';
      note.style.opacity = '0.72';
      note.style.display = 'block';
      note.textContent = `Glow is procedural on this model — the "${assetGlowPreset(key)}" `
        + 'pattern is its emissive mask. Tune it under Bioluminescence, not here.';
      el.append(note);
    } else if (supportsEmissive(key)) {
      const emissiveRow = document.createElement('div');
      emissiveRow.className = 'sv-tex-glowrow';
      const emissiveLabel = document.createElement('label');
      emissiveLabel.textContent = 'Emissive';
      emissiveSwatch = document.createElement('input');
      emissiveSwatch.type = 'color';
      emissiveSwatch.value = look.emissive != null ? `#${look.emissive.toString(16).padStart(6, '0')}` : '#000000';
      emissiveSwatch.addEventListener('input', () => {
        const hex = parseInt(emissiveSwatch.value.slice(1), 16);
        look.emissive = hex;
        setAssetEmissive(key, hex);
        saveTuningToStorage();
      });
      emissiveRow.append(emissiveLabel, emissiveSwatch);
      el.append(emissiveRow);
      if (look.emissive != null) setAssetEmissive(key, look.emissive);
    }

    if (!glowIsProcedural(key)) {
      const glowRow = document.createElement('div');
      glowRow.className = 'sv-tex-glowrow';
      const glowLabel = document.createElement('label');
      glowLabel.textContent = 'Glow';
      glowSlider = document.createElement('input');
      glowSlider.type = 'range';
      glowSlider.min = '0'; glowSlider.max = '8'; glowSlider.step = '0.05';
      glowSlider.value = look.glow ?? 1;
      const glowVal = document.createElement('span');
      glowVal.className = 'sv-tex-variant-name';
      glowVal.textContent = `${Number(glowSlider.value).toFixed(2)}x`;
      glowSlider.addEventListener('input', () => {
        look.glow = Number(glowSlider.value);
        setAssetGlow(key, look.glow);
        glowVal.textContent = `${look.glow.toFixed(2)}x`;
        saveTuningToStorage();
      });
      glowRow.append(glowLabel, glowSlider, glowVal);
      el.append(glowRow);
      if (look.glow != null && look.glow !== 1) setAssetGlow(key, look.glow);
    }

    // Per-model glow source. Only shown for models that actually ship a mask
    // in public/textures/emissive — for everything else there is nothing to
    // choose between, and the row would be a dead control implying otherwise.
    //
    // Three states, cycled by the button rather than a checkbox, because
    // "follow the global" is a real and useful state that a two-state control
    // cannot express: a checkbox would silently pin every model the first
    // time you touched it.
    const maskState = assetEmissiveMaskState(key);
    if (maskState.has) {
      const maskRow = document.createElement('div');
      maskRow.className = 'sv-tex-glowrow';
      const maskLabel = document.createElement('label');
      maskLabel.textContent = 'Mask';
      const maskBtn = document.createElement('button');
      maskBtn.type = 'button';
      maskBtn.className = 'sv-tex-btn';
      maskBtn.title = 'Where this model\'s glow comes from. Auto follows the global '
        + '"glow from emissive masks" toggle; Masked and Uniform override it for this model only.';
      const paint = () => {
        const st = assetEmissiveMaskState(key);
        maskBtn.textContent = look.emissiveMask == null
          ? `Auto (${st.on ? 'masked' : 'uniform'})`
          : (look.emissiveMask ? 'Masked' : 'Uniform');
      };
      maskBtn.addEventListener('click', () => {
        // null -> true -> false -> null
        look.emissiveMask = look.emissiveMask == null ? true : (look.emissiveMask ? false : null);
        setAssetEmissiveMask(key, look.emissiveMask);
        paint();
        saveTuningToStorage();
      });
      paint();
      maskRow.append(maskLabel, maskBtn);
      el.append(maskRow);
      if (look.emissiveMask != null) setAssetEmissiveMask(key, look.emissiveMask);
    }
  }


  // Size — READ ONLY, and deliberately so. It used to be a slider here.
  //
  // It is not a look: the hitbox is derived from the visual scale, so this
  // decides how big a creature is to HIT as well as to see. That makes it a
  // balance number, and balance numbers live in a table where they can be read
  // against each other. Left as a slider it drifted exactly the way live
  // tuning drifts — the walking crab reached 10.46, a crab 29 world units tall
  // in a 40-unit arena, while its own night variant sat at 2.42 and nothing in
  // the repo recorded that either was intended.
  //
  // Shown rather than hidden, because "where is the size control" is the first
  // question anyone opening this panel will have.
  const sizeDivider = document.createElement('div');
  sizeDivider.className = 'sv-tex-divider';
  const sizeRow = document.createElement('div');
  sizeRow.className = 'sv-tex-glowrow';
  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'Size';
  const sizeVal = document.createElement('span');
  sizeVal.className = 'sv-tex-variant-name';
  sizeVal.textContent = `${getAssetSizeMultiplier(key)}x — edit in assets.csv (npm run csv)`;
  sizeRow.append(sizeLabel, sizeVal);

  // 3D model / 2D sprite upload — replaces this asset's mesh with an uploaded
  // .glb / .gltf / .fbx, or with a flat quad cut to an uploaded image's aspect
  // ratio. Saved to IndexedDB (not localStorage — a model is megabytes, well
  // past that quota) and restored automatically on the next load.
  //
  // Note this is NOT the Upload button at the top of the row: that one wraps
  // an image around the geometry the asset already has (a drawn starfish
  // smeared over an octahedron). This one throws the geometry away and draws
  // the image itself, which is what you want for 2D art.
  const modelRow = document.createElement('div');
  modelRow.className = 'sv-tex-glowrow';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Mesh';
  const modelFile = document.createElement('input');
  modelFile.type = 'file';
  modelFile.accept = '.glb,.gltf,.fbx,image/*';
  modelFile.style.display = 'none';
  const modelBtn = document.createElement('button');
  modelBtn.className = 'sv-tex-btn';
  modelBtn.style.flex = '1';
  modelBtn.textContent = '3D model / 2D sprite';
  modelBtn.title = 'Replace this asset with an uploaded .glb/.gltf/.fbx model, or with a 2D sprite from a PNG/JPG/WEBP';
  const modelClear = document.createElement('button');
  modelClear.className = 'sv-tex-btn';
  modelClear.textContent = 'Reset';
  modelClear.title = 'Forget the uploaded model or sprite and go back to the built-in one (takes effect next reload)';
  const modelStatus = document.createElement('div');
  modelStatus.className = 'sv-tex-upload-status';

  async function applyModel(file, { persist }) {
    const sprite = isSpriteFile(file);
    modelStatus.textContent = `Loading ${file.name}...`;
    try {
      // Match the fit of whatever this asset already uses, so an upload lands
      // at the same in-game scale rather than needing the size slider
      // re-dialled from scratch every time.
      await loadUploadedAsset(key, file);
      // Loading a model builds BRAND NEW materials, discarding whatever
      // tint/glow/emissive/tiling was applied to the old ones. The look
      // restore above runs synchronously at row-build time, but this load is
      // async — so on a reload the saved model would land AFTER the look and
      // silently wipe it, leaving the asset looking untouched until you
      // nudged a control (which re-applied it). Re-apply here so the model
      // and its look always end up in sync no matter which finishes first.
      reapplyLook(key, look);
      const kind = sprite ? '2D sprite' : 'model';
      // Glow multiplies an unlit material's colour, so a saved glow of 0
      // multiplies the sprite's image to black — it IS drawn, at the right
      // size, in the right place, and completely invisible. Say so here
      // rather than leaving it looking like the upload failed.
      const blacked = sprite && look.glow === 0;
      modelStatus.textContent = blacked
        ? `Using ${file.name} — but Glow is 0 on this row, so it draws black. Raise Glow to see it.`
        : `Using ${file.name} as a ${kind}${persist ? '' : ' (restored)'}.`;
      if (persist) {
        saveModelToDB(key, file).catch((err) =>
          console.warn('[models] could not save the uploaded model for next time —', err?.message ?? err));
      }
      onAssetChanged?.(key); // rebuild singletons (ship / drone / companion) now
    } catch (err) {
      modelStatus.textContent = `Couldn't load ${file.name} — keeping the built-in ${sprite ? 'shape' : 'model'}.`;
      console.warn(`[models] upload failed for "${key}" —`, err?.message ?? err);
    }
  }

  modelBtn.addEventListener('click', () => modelFile.click());
  modelFile.addEventListener('change', () => {
    const file = modelFile.files?.[0];
    if (file) applyModel(file, { persist: true });
  });
  modelClear.addEventListener('click', () => {
    deleteModelFromDB(key).catch(() => {});
    modelStatus.textContent = 'Saved model cleared — built-in model returns next reload.';
  });
  modelRow.append(modelLabel, modelBtn, modelClear, modelFile);

  el.append(sizeDivider, sizeRow, modelRow, modelStatus);

  // Restore a model uploaded in a previous session.
  loadModelFromDB(key).then((file) => {
    if (file) applyModel(file, { persist: false });
  }).catch((err) => console.warn('[models] could not check for a saved model —', err?.message ?? err));


  resetBtn.addEventListener('click', () => {
    setAssetTexture(key, null);
    setAssetTint(key, null);
    tint.value = '#ffffff';
    dot.classList.remove('sv-tex-active');
    repeatX.value = 1;
    repeatY.value = 1;
    setAssetRepeat(key, 1, 1);
    // Size is NOT reset: this button clears the look, and size is not a look.
    // It also has no controls left here to clear.
    if (emissiveSwatch) { setAssetEmissive(key, null); emissiveSwatch.value = '#000000'; }
    if (glowSlider) { setAssetGlow(key, null); glowSlider.value = '1'; }
    // The LEADER's entry, so resetting a follower's row clears the look it was
    // actually editing rather than deleting an empty object beside it and
    // leaving the colour on screen. See lookState.
    delete CONFIG.assetLooks[lookLeader(key)];
    saveTuningToStorage();
    onAssetChanged?.(key);
  });

  if (hasCustomTexture(key)) dot.classList.add('sv-tex-active');

  return { el, dot };
}


// ---------------------------------------------------------------------------
// Sound tab — one row per CONFIG.sfx entry, fields shown depend on its type,
// each with a Test button that plays it immediately through the real synth.
// ---------------------------------------------------------------------------

// A level control, mapped in DECIBELS rather than in the linear gain it
// stores.
//
// The gain sliders used to run 0..4 linearly, and both halves of that were
// wrong. Four was not enough — several samples are authored 20dB below the rest
// of the bank and were still too quiet pinned at the top — and a linear track
// wastes almost all of its travel: doubling the loudness from 2 to 4 gets half
// the slider, while everything between silence and half volume is crammed into
// the first eighth.
//
// dB fixes both at once. The range below is 64dB wide, every dB is the same
// distance along the track, and the top is +24dB (a gain of ~15.8) which is
// four times the old ceiling. What gets STORED is unchanged — a plain linear
// multiplier — so nothing downstream and no saved tuning has to know.
// The conversion itself lives in systems/audio.js, so the panel and the engine
// cannot drift apart on what a level means.
const DB_MIN = DB_FLOOR;
const DB_MAX = 24;

const clampDb = (gain) => Math.min(DB_MAX, gainToDb(gain));

function dbSlider(container, label, value, onInput) {
  const read = typeof value === 'function' ? value : () => value;
  const show = (gain) => (gain > 0 ? `${clampDb(gain) >= 0 ? '+' : ''}${clampDb(gain).toFixed(1)}` : 'off');

  const row = document.createElement('div');
  row.className = 'sv-sfx-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = `${label} — in dB. 0 is unity; the readout is decibels, the stored value is a linear multiplier.`;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = DB_MIN; input.max = DB_MAX; input.step = 0.5;
  input.value = clampDb(read());
  const val = document.createElement('span');
  val.className = 'sv-sfx-val';
  const paint = () => {
    const gain = read();
    val.textContent = show(gain);
    val.title = `x${Number(gain).toFixed(3)}`;
  };
  paint();
  input.addEventListener('input', () => {
    onInput(dbToGain(Number(input.value)));
    paint();
    saveTuningToStorage();
  });
  row.append(lab, input, val);
  container.appendChild(row);

  if (typeof value === 'function') {
    texRows.push(() => { input.value = clampDb(read()); paint(); });
  }
  return input;
}

// Every control in the Sound, Haptics and Particles tabs is one of these.
//
// `value` may be a number OR a getter. A getter also registers the row for
// refreshTexturePanelRows(), which is what puts it back in step after a Reset
// or an import — those rewrite CONFIG behind the panel's back, and a slider
// left at its old position then reports a value that is no longer in effect
// and jumps the moment you nudge it. Plain numbers still work and simply
// don't refresh, so this stayed backwards-compatible while the call sites
// were converted.
function slider(container, label, min, max, step, value, onInput) {
  const read = typeof value === 'function' ? value : () => value;
  const fmt = (v) => Number(v).toFixed(step < 1 ? 2 : 0);

  const row = document.createElement('div');
  row.className = 'sv-sfx-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = label; // the box ellipsizes; hover still gives the full name
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step; input.value = read();
  const val = document.createElement('span');
  val.className = 'sv-sfx-val';
  val.textContent = fmt(read());
  input.addEventListener('input', () => {
    val.textContent = fmt(input.value);
    onInput(Number(input.value));
    saveTuningToStorage();
  });
  row.append(lab, input, val);
  container.appendChild(row);

  if (typeof value === 'function') {
    texRows.push(() => { input.value = read(); val.textContent = fmt(read()); });
  }
  return input;
}

// A read-only roster of what upgrades.csv actually produced. Deliberately not
// editable: the file is the source of truth, and a second place to type a
// name is a second place for the two to disagree. What this tab is FOR is
// confirming that the row you just edited is the row the game loaded — a
// typo'd id or an unknown card art key shows up here as a value that didn't
// change, and in the console as a warning.
function buildUpgradeTable() {
  const wrap = document.createElement('div');

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.style.marginBottom = '10px';
  note.textContent = 'Upgrades are edited in path/src/upgrades.csv — open it in a spreadsheet, save, and reload the page. This is a read-only view of what that file loaded, so you can check an edit landed. What an upgrade DOES is its apply() function in config.js and is only ever code.';
  wrap.appendChild(note);

  // Sectioned by what the card gives you, not by csv row order — the file is
  // append-only in practice, so its order is the history of when each card was
  // written, which is no help at all when you're checking the weapon cards.
  const byId = new Map(CONFIG.upgrades.map((u) => [u.id, u]));
  appendSectioned(wrap, 'upgrades', UPGRADE_SECTIONS, [...byId.keys()], (id) => buildUpgradeRow(byId.get(id)));

  return wrap;
}

function buildUpgradeRow(u) {
  const row = document.createElement('div');
  row.className = 'sv-sfx-row';
  row.style.opacity = u.enabled === false ? '0.45' : '1';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const idSpan = document.createElement('span');
  idSpan.className = 'sv-sfx-type';
  idSpan.textContent = u.id;
  head.appendChild(idSpan);
  if (u.enabled === false) {
    const off = document.createElement('span');
    off.className = 'sv-sfx-type';
    off.textContent = 'not offered';
    head.appendChild(off);
  }
  row.appendChild(head);

  const field = (label, value) => {
    const el = document.createElement('div');
    el.className = 'sv-sfx-field';
    const lab = document.createElement('label');
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'sv-up-value';
    val.textContent = value;
    el.append(lab, val);
    row.appendChild(el);
  };

  field('name', u.name);
  // Expanded at `owned: 0` — the Upgrades tab is a roster, so every row
  // answers "what does the first one of these give me". The level-up card
  // itself asks the same question about the stack it is actually offering.
  field('desc', expandDesc(u.desc, u, { owned: 0 }));
  field('max stacks', u.maxStacks ?? '∞');
  field('card art', u.cardArt ?? '—');

  return row;
}

// Master FX bus — one filter and one reverb every SFX runs through. Sits at
// the top of the Sound tab because it colours everything below it.
function buildBusRow() {
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';
  el.style.borderColor = 'rgba(255,179,71,0.3)';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const title = document.createElement('span');
  title.textContent = 'Master FX bus';
  const kind = document.createElement('span');
  kind.className = 'sv-sfx-type';
  kind.textContent = 'sfx only';
  head.append(title, kind);
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.textContent = 'Filter and reverb applied to every sound effect. Music is on its own chain and is not affected. Reverb is a parallel send, so the dry hit stays intact as you add wet.';
  el.appendChild(note);

  const bus = () => (CONFIG.audio.bus ??= {});
  const changed = () => { applyAudioBusSettings(); saveTuningToStorage(); };

  // Filter type is a choice, not a range, so it gets a select rather than a
  // slider — a lowpass and a highpass are not two ends of one continuum.
  const typeRow = document.createElement('div');
  typeRow.className = 'sv-sfx-field';
  const typeLab = document.createElement('label');
  typeLab.textContent = 'filter';
  typeLab.title = 'filter type';
  const typeSel = document.createElement('select');
  for (const t of ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf']) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    typeSel.appendChild(o);
  }
  typeSel.value = bus().filterType ?? 'lowpass';
  typeSel.addEventListener('change', () => { bus().filterType = typeSel.value; changed(); });
  typeRow.append(typeLab, typeSel);
  el.appendChild(typeRow);

  slider(el, 'cutoff', 20, 20000, 10, () => bus().filterHz ?? 20000, (v) => { bus().filterHz = v; changed(); });
  slider(el, 'resonance', 0.1, 20, 0.1, () => bus().filterQ ?? 1, (v) => { bus().filterQ = v; changed(); });
  slider(el, 'reverb mix', 0, 1, 0.01, () => bus().reverbMix ?? 0, (v) => { bus().reverbMix = v; changed(); });
  slider(el, 'reverb tail', 0.05, 6, 0.05, () => bus().reverbSeconds ?? 1.6, (v) => { bus().reverbSeconds = v; changed(); });
  slider(el, 'reverb decay', 0.1, 8, 0.1, () => bus().reverbDecay ?? 2, (v) => { bus().reverbDecay = v; changed(); });

  // Depth tracking. Its own range rather than the music's — see the note in
  // CONFIG.audio.bus.depth for why they can't share one.
  const depth = () => (bus().depth ??= {});
  const depthRow = document.createElement('div');
  depthRow.className = 'sv-sfx-field';
  const depthLab = document.createElement('label');
  depthLab.textContent = 'depth filt';
  depthLab.title = 'tie cutoff to how deep the player is';
  const depthBox = document.createElement('input');
  depthBox.type = 'checkbox';
  depthBox.checked = depth().enabled === true;
  depthBox.title = 'While on, depth drives the cutoff and the manual cutoff slider above is ignored';
  const depthHint = document.createElement('span');
  depthHint.className = 'sv-sfx-val';
  depthHint.style.width = 'auto';
  const refreshHint = () => {
    depthHint.textContent = depthBox.checked ? 'overrides cutoff' : 'off';
  };
  refreshHint();
  depthBox.addEventListener('change', () => {
    depth().enabled = depthBox.checked;
    refreshHint();
    changed();
  });
  depthRow.append(depthLab, depthBox, depthHint);
  el.appendChild(depthRow);

  slider(el, 'at surface', 200, 20000, 100, () => depth().surfaceHz ?? 20000, (v) => { depth().surfaceHz = v; changed(); });
  slider(el, 'at seabed', 200, 20000, 100, () => depth().deepHz ?? 5000, (v) => { depth().deepHz = v; changed(); });
  slider(el, 'depth glide', 0.01, 1.5, 0.01, () => depth().smoothing ?? 0.15, (v) => { depth().smoothing = v; changed(); });

  // --- repetition -----------------------------------------------------------
  // Not on the bus at all — it is a per-sound gain applied before anything
  // reaches the bus — but it lives here because it is the other half of "why
  // is the mix loud", and tuning one without the other is guesswork.
  const rep = () => (CONFIG.audio.repetition ??= {});
  const repChanged = () => { saveTuningToStorage(); };

  const repHead = document.createElement('div');
  repHead.className = 'sv-tex-divider sv-tex-upload-status';
  repHead.textContent = 'Repetition. Each rapid repeat of the SAME sound plays quieter than the one before, recovering when it stops firing. This is what keeps a wall of hits reading as a wall rather than as static. Press 0 in game to watch it work.';
  el.appendChild(repHead);

  const repRow = document.createElement('div');
  repRow.className = 'sv-sfx-field';
  const repLab = document.createElement('label');
  repLab.textContent = 'crowding';
  const repBox = document.createElement('input');
  repBox.type = 'checkbox';
  repBox.checked = rep().enabled !== false;
  repBox.addEventListener('change', () => { rep().enabled = repBox.checked; repChanged(); });
  repRow.append(repLab, repBox);
  el.appendChild(repRow);

  slider(el, 'recovery', 0.05, 2, 0.05, () => rep().recovery ?? 0.5, (v) => { rep().recovery = v; });
  slider(el, 'strength', 0, 2, 0.05, () => rep().strength ?? 0.35, (v) => { rep().strength = v; });
  dbSlider(el, 'floor', () => rep().floor ?? 0.25, (v) => { rep().floor = v; });
  slider(el, 'gap jitter', 0, 0.9, 0.01, () => CONFIG.audio.sfxGapJitter ?? 0.35, (v) => { CONFIG.audio.sfxGapJitter = v; });

  // --- dynamics -------------------------------------------------------------
  const comp = () => (bus().comp ??= {});

  const compHead = document.createElement('div');
  compHead.className = 'sv-tex-divider sv-tex-upload-status';
  compHead.textContent = 'Compressor, makeup and ceiling. The ceiling is what makes the per-sound gain sliders safe to drive — below it nothing is touched, above it peaks bend instead of clipping.';
  el.appendChild(compHead);

  const compRow = document.createElement('div');
  compRow.className = 'sv-sfx-field';
  const compLab = document.createElement('label');
  compLab.textContent = 'compress';
  compLab.title = 'Light glue compression across the whole SFX bus';
  const compBox = document.createElement('input');
  compBox.type = 'checkbox';
  compBox.checked = comp().enabled !== false;
  // The gain-reduction readout. A compressor you can't see working is a
  // compressor nobody can tune — this is the only way to tell "threshold too
  // low, everything is squashed" from "threshold too high, doing nothing".
  const reduction = document.createElement('span');
  reduction.className = 'sv-sfx-val';
  reduction.style.width = 'auto';
  reduction.textContent = 'idle';
  compBox.addEventListener('change', () => { comp().enabled = compBox.checked; changed(); });
  compRow.append(compLab, compBox, reduction);
  el.appendChild(compRow);

  // Polled rather than driven off the frame loop: this panel is dev-only, the
  // number only has to be readable, and the game loop should not be carrying a
  // debug readout. Skipped entirely while the panel is hidden.
  window.setInterval(() => {
    if (!el.offsetParent) return;
    const db = busReduction();
    reduction.textContent = db < -0.1 ? `${db.toFixed(1)} dB` : 'idle';
    reduction.style.color = db < -12 ? '#ffb347' : '';
  }, 150);

  slider(el, 'threshold', -60, 0, 1, () => comp().threshold ?? -18, (v) => { comp().threshold = v; changed(); });
  slider(el, 'knee', 0, 40, 1, () => comp().knee ?? 12, (v) => { comp().knee = v; changed(); });
  slider(el, 'ratio', 1, 20, 0.5, () => comp().ratio ?? 3, (v) => { comp().ratio = v; changed(); });
  slider(el, 'attack', 0, 0.2, 0.001, () => comp().attack ?? 0.005, (v) => { comp().attack = v; changed(); });
  slider(el, 'release', 0.01, 1, 0.01, () => comp().release ?? 0.18, (v) => { comp().release = v; changed(); });
  dbSlider(el, 'makeup', () => comp().makeup ?? 1.6, (v) => { comp().makeup = v; changed(); });
  slider(el, 'ceiling', 0.1, 1, 0.01, () => comp().ceiling ?? 0.95, (v) => { comp().ceiling = v; changed(); });
  slider(el, 'ceil knee', 0, 0.98, 0.01, () => comp().ceilingKnee ?? 0.6, (v) => { comp().ceilingKnee = v; changed(); });

  const osRow = document.createElement('div');
  osRow.className = 'sv-sfx-field';
  const osLab = document.createElement('label');
  osLab.textContent = 'oversamp';
  osLab.title = 'Anti-aliasing for the ceiling curve. Higher costs CPU and sounds cleaner when the bus is driven hard.';
  const osSel = document.createElement('select');
  for (const o of ['none', '2x', '4x']) {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    osSel.appendChild(opt);
  }
  osSel.value = comp().oversample ?? '2x';
  osSel.addEventListener('change', () => { comp().oversample = osSel.value; changed(); });
  osRow.append(osLab, osSel);
  el.appendChild(osRow);

  // Audition through the bus without waiting for the right thing to happen
  // in game.
  const testRow = document.createElement('div');
  testRow.className = 'sv-sfx-field';
  const testLab = document.createElement('label');
  testLab.textContent = 'test';
  for (const [label, sfx] of [['Shot', 'shoot'], ['Kill', 'kill'], ['Big kill', 'bigKill']]) {
    const b = document.createElement('button');
    b.className = 'sv-tex-btn';
    b.textContent = label;
    b.addEventListener('click', () => { unlockAudio(); playSfx(sfx, 1); });
    testRow.appendChild(b);
  }
  testRow.insertBefore(testLab, testRow.firstChild);
  el.appendChild(testRow);

  return el;
}

function buildMusicRow() {
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';
  el.style.borderColor = 'rgba(122,215,255,0.3)';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const title = document.createElement('span');
  title.textContent = 'Music loops';
  const info = document.createElement('span');
  info.className = 'sv-sfx-type';
  const refreshInfo = () => {
    info.textContent = `${CONFIG.music.bpm}bpm · loop ${loopDuration().toFixed(2)}s`;
  };
  refreshInfo();
  head.append(title, info);
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.textContent = `${CONFIG.music.slots} loops ship built in (747 Cocktails). Upload a file to replace any slot for this session, or Clear to silence it. Which one plays follows your level (every ${CONFIG.music.levelsPerSlot} levels moves to the next FILLED slot, so gaps are skipped). A switch waits for the file that's playing to reach its end, however long it is, so a loop is never cut off half-finished — and it waits in the track's own time, so a loop dragging through the death dive still gets to finish. The bpm/loop figures above are the beat grid the animation marches to, not the switch point. The low-pass opens as you level, and ducks while the upgrade screen is open.`;
  el.appendChild(note);

  for (let i = 1; i <= CONFIG.music.slots; i++) {
    const trackName = String(i);
    const row = document.createElement('div');
    row.className = 'sv-sfx-field';
    const lab = document.createElement('label');
    lab.style.width = '46px';
    lab.textContent = `loop ${i}`;
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'audio/*';
    file.style.display = 'none';
    const up = document.createElement('button');
    up.className = 'sv-tex-btn';
    up.textContent = hasTrack(trackName) ? 'Replace' : 'Upload';
    const clr = document.createElement('button');
    clr.className = 'sv-tex-btn';
    clr.textContent = 'Clear';
    const status = document.createElement('span');
    status.className = 'sv-sfx-val';
    status.style.width = 'auto';
    status.textContent = hasTrack(trackName) ? 'loaded' : '—';

    // This row is built long before the built-in default for this slot has
    // finished fetching, so its initial "—" above is provisional — refresh
    // once the load lands rather than leaving it stale forever. A manual
    // upload or clear takes over the row for good, so the built-in default
    // finishing late doesn't stomp on it.
    let userTouched = false;
    const unsubscribe = onTracksChanged(() => {
      if (userTouched) return;
      const loaded = hasTrack(trackName);
      status.textContent = loaded ? 'loaded' : '—';
      up.textContent = loaded ? 'Replace' : 'Upload';
    });

    up.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      userTouched = true;
      unsubscribe();
      unlockAudio();
      status.textContent = 'loading…';
      const ok = await loadTrackFromFile(trackName, f);
      if (ok) {
        // Same deal as the SFX rows: save the file and record it as this
        // slot's default, so the loop is still here after a reload.
        const src = await uploadAsset('music', f);
        if (src) {
          CONFIG.music.defaultSrc[i - 1] = src;
          saveTuningToStorage();
          status.textContent = `saved ${f.name.slice(0, 10)}`;
        } else {
          status.textContent = `${f.name.slice(0, 9)} (session)`;
        }
      } else {
        status.textContent = 'failed';
      }
      up.textContent = ok ? 'Replace' : 'Upload';
    });
    clr.addEventListener('click', () => {
      userTouched = true;
      unsubscribe();
      clearTrack(trackName);
      // Clear the saved default too, or the slot refills itself on reload.
      CONFIG.music.defaultSrc[i - 1] = null;
      saveTuningToStorage();
      status.textContent = '—';
      up.textContent = 'Upload';
    });
    row.append(lab, up, clr, file, status);
    el.appendChild(row);
  }

  const controls = document.createElement('div');
  controls.className = 'sv-sfx-field';
  const previewLab = document.createElement('label');
  previewLab.style.width = '46px';
  previewLab.textContent = 'preview';
  const playBtn = document.createElement('button');
  playBtn.className = 'sv-tex-btn';
  playBtn.textContent = 'Play';
  playBtn.addEventListener('click', () => { unlockAudio(); refreshInfo(); playMusic(1); });
  const stopBtn = document.createElement('button');
  stopBtn.className = 'sv-tex-btn';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => stopMusic());
  controls.append(previewLab, playBtn, stopBtn);
  el.appendChild(controls);

  return el;
}

// The ambient bed — the clip rotation and the shape of the crossfade between
// them. Sits directly under the music row because the two are the only
// continuous sounds in the game and they're tuned against each other; the
// one-shot rows below are a different job entirely.
function buildAmbientRow() {
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';
  el.style.borderColor = 'rgba(150,255,190,0.3)';

  const amb = () => (CONFIG.ambient ??= {});
  const changed = () => { applyAmbientSettings(); saveTuningToStorage(); };

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const title = document.createElement('span');
  title.textContent = 'Ambient bed';
  const info = document.createElement('span');
  info.className = 'sv-sfx-type';
  const refreshInfo = () => {
    const s = ambientState();
    const n = `${s.clips.length} clip${s.clips.length === 1 ? '' : 's'}`;
    info.textContent = s.mode === 'sporadic'
      ? `${n} · sporadic, ~${Math.round(amb().gapSeconds ?? 22)}s apart`
      : (s.clips.length < 2 ? `${n} · no cycle` : `${n} · ${Math.round(amb().holdSeconds ?? 34)}s hold`);
  };
  refreshInfo();
  head.append(title, info);
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.textContent = 'Two modes, chosen by the gap slider. Above zero it is SPORADIC: a clip fades up, plays once, fades away, and the water is quiet until the next one. At zero it is a CONTINUOUS bed — one clip looping at a time, crossfading into the next every hold. Either way it runs through the master FX bus above, so it ducks underwater with the sound effects, unlike music.';
  el.appendChild(note);

  for (let i = 0; i < (amb().slots ?? 6); i++) {
    const row = document.createElement('div');
    row.className = 'sv-sfx-field';
    const lab = document.createElement('label');
    lab.style.width = '46px';
    lab.textContent = `clip ${i + 1}`;
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'audio/*';
    file.style.display = 'none';
    const up = document.createElement('button');
    up.className = 'sv-tex-btn';
    const clr = document.createElement('button');
    clr.className = 'sv-tex-btn';
    clr.textContent = 'Clear';
    const status = document.createElement('span');
    status.className = 'sv-sfx-val';
    status.style.width = 'auto';

    // A slot's label depends on two things that land at different times: what
    // the config says is in it (immediately) and whether that file has decoded
    // (after the fetch). Read both, and re-read on the decode.
    const refresh = () => {
      const src = (amb().srcs ?? [])[i] ?? null;
      up.textContent = src ? 'Replace' : 'Upload';
      if (!src) status.textContent = '—';
      else status.textContent = hasAmbientClip(src) ? src.split('/').pop().slice(0, 14) : 'not loaded yet';
    };
    refresh();
    const unsubscribe = onAmbientClipsChanged(refresh);

    up.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      unlockAudio();
      status.textContent = 'loading…';
      // Save to disk FIRST so the slot can hold the real path rather than a
      // session-only handle — the tuning file is what survives a reload, and a
      // path it can't resolve next boot is worse than no clip at all.
      const src = await uploadAsset('sfx', f);
      const key = src ?? `session:${f.name}`;
      const ok = await loadAmbientFromFile(key, f);
      if (!ok) { status.textContent = 'failed'; return; }
      (amb().srcs ??= [])[i] = key;
      resetAmbient();
      await reloadAmbient();
      startAmbient();
      saveTuningToStorage();
      refreshInfo();
      refresh();
      if (!src) status.textContent = `${f.name.slice(0, 9)} (session)`;
    });
    clr.addEventListener('click', async () => {
      const src = (amb().srcs ?? [])[i] ?? null;
      if (src) clearAmbientClip(src);
      (amb().srcs ??= [])[i] = null;
      resetAmbient();
      await reloadAmbient();
      startAmbient();
      saveTuningToStorage();
      refreshInfo();
      refresh();
    });
    // Nothing here unmounts, so the subscription lives as long as the panel —
    // held only so the intent is on the page next to the thing it feeds.
    void unsubscribe;

    row.append(lab, up, clr, file, status);
    el.appendChild(row);
  }

  slider(el, 'volume', 0, 1, 0.01, () => amb().volume ?? 0.4, (v) => { amb().volume = v; applyAmbientSettings(); });

  // The mode switch, and the reason it's the first timing control: everything
  // below it only applies to one mode or the other, and which one is live is
  // decided here.
  const gapSlider = slider(el, 'gap', 0, 120, 1, () => amb().gapSeconds ?? 22, (v) => {
    amb().gapSeconds = v;
    refreshInfo();
    refreshModeHints();
  });
  gapSlider.title = 'Seconds of silence between clips. 0 turns the sporadic mode off and gives a continuous crossfading bed instead.';
  slider(el, 'gap vary', 0, 0.9, 0.01, () => amb().gapVary ?? 0.55, (v) => { amb().gapVary = v; });
  slider(el, 'fade', 0.1, 10, 0.1, () => amb().fadeSeconds ?? 1.8, (v) => { amb().fadeSeconds = v; });

  const holdRow = slider(el, 'hold', 4, 120, 1, () => amb().holdSeconds ?? 34, (v) => { amb().holdSeconds = v; refreshInfo(); });
  const holdVaryRow = slider(el, 'hold vary', 0, 0.8, 0.01, () => amb().holdVary ?? 0.25, (v) => { amb().holdVary = v; });
  const crossRow = slider(el, 'crossfade', 0.2, 20, 0.1, () => amb().crossfade ?? 7, (v) => { amb().crossfade = v; });

  // A slider that does nothing is worse than one that isn't there, so the three
  // continuous-only controls say so rather than sitting live and inert while
  // sporadic mode ignores them.
  const refreshModeHints = () => {
    const off = (amb().gapSeconds ?? 0) > 0;
    for (const input of [holdRow, holdVaryRow, crossRow]) {
      const row = input.parentElement;
      row.style.opacity = off ? '0.4' : '';
      input.disabled = off;
      input.title = off ? 'Continuous mode only — ignored while gap is above zero' : '';
    }
  };
  refreshModeHints();

  slider(el, 'pitch var', 0, 0.3, 0.01, () => amb().pitchVary ?? 0.04, (v) => { amb().pitchVary = v; });
  slider(el, 'fade out', 0.1, 8, 0.1, () => amb().fadeOut ?? 1.6, (v) => { amb().fadeOut = v; });

  const orderRow = document.createElement('div');
  orderRow.className = 'sv-sfx-field';
  const orderLab = document.createElement('label');
  orderLab.textContent = 'order';
  const shuffleBox = document.createElement('input');
  shuffleBox.type = 'checkbox';
  shuffleBox.checked = amb().shuffle !== false;
  const orderHint = document.createElement('span');
  orderHint.className = 'sv-sfx-val';
  orderHint.style.width = 'auto';
  const refreshOrder = () => { orderHint.textContent = shuffleBox.checked ? 'shuffle' : 'in order'; };
  refreshOrder();
  shuffleBox.addEventListener('change', () => { amb().shuffle = shuffleBox.checked; refreshOrder(); changed(); });
  orderRow.append(orderLab, shuffleBox, orderHint);
  el.appendChild(orderRow);

  // Audition without waiting for a run — and without a 34-second wait to hear
  // the one thing worth auditioning, which is the crossfade. "Skip" forces the
  // next switch immediately.
  const testRow = document.createElement('div');
  testRow.className = 'sv-sfx-field';
  const testLab = document.createElement('label');
  testLab.textContent = 'preview';
  const playBtn = document.createElement('button');
  playBtn.className = 'sv-tex-btn';
  playBtn.textContent = 'Play';
  playBtn.addEventListener('click', async () => {
    unlockAudio();
    await reloadAmbient();
    startAmbient();
    refreshInfo();
  });
  const skipBtn = document.createElement('button');
  skipBtn.className = 'sv-tex-btn';
  skipBtn.textContent = 'Skip';
  skipBtn.title = 'Bring the next clip in now, instead of waiting out the gap or the hold';
  skipBtn.addEventListener('click', () => { unlockAudio(); skipAmbientClip(); });
  const stopBtn = document.createElement('button');
  stopBtn.className = 'sv-tex-btn';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => stopAmbient());
  testRow.append(testLab, playBtn, skipBtn, stopBtn);
  el.appendChild(testRow);

  return el;
}


function pairSlider(container, label, min, max, step, pair, onInput) {
  const row = document.createElement('div');
  row.className = 'sv-sfx-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  const lo = document.createElement('input');
  lo.type = 'range'; lo.min = min; lo.max = max; lo.step = step; lo.value = pair[0];
  const hi = document.createElement('input');
  hi.type = 'range'; hi.min = min; hi.max = max; hi.step = step; hi.value = pair[1];
  const val = document.createElement('span');
  val.className = 'sv-sfx-val';
  val.style.width = '58px';
  const fmt = (v) => Number(v).toFixed(step < 1 ? 2 : 0);
  val.textContent = `${fmt(pair[0])}-${fmt(pair[1])}`;
  const sync = () => {
    val.textContent = `${fmt(lo.value)}-${fmt(hi.value)}`;
    onInput([Number(lo.value), Number(hi.value)]);
    saveTuningToStorage();
  };
  lo.addEventListener('input', sync);
  hi.addEventListener('input', sync);
  row.append(lab, lo, hi, val);
  container.appendChild(row);
}

function buildEmitterRow(name) {
  const def = CONFIG.emitters[name];
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  const testBtn = document.createElement('button');
  testBtn.className = 'sv-tex-btn';
  testBtn.textContent = 'Test';
  testBtn.addEventListener('click', () => emit(name, 0, 0));
  head.append(nameSpan, testBtn);
  el.appendChild(head);

  pairSlider(el, 'size', 0.01, 3, 0.01, def.size, (v) => { def.size = v; });
  pairSlider(el, 'life', 0.02, 3, 0.01, def.life, (v) => { def.life = v; });
  pairSlider(el, 'speed', 0, 40, 0.5, def.speed, (v) => { def.speed = v; });
  slider(el, 'count', 1, 200, 1, () => def.count, (v) => { def.count = Math.round(v); });

  return el;
}

export function refreshTexturePanel() {
  for (const [key, row] of rows) {
    row.dot.classList.toggle('sv-tex-active', hasCustomTexture(key));
  }
}
