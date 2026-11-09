# Seal: UE5 animation state machine (3rd-person swim, follow cam)

Working doc, not game copy. Source rig: `public/models/furseal.glb` (player).
`sealhelper.glb` is the escort rig (different skeleton, no `ball`/`sliding`/`bark`) and is not covered here.

## What the game does today

`path/src/systems/animation.js` is a 2D-sidescroll machine: locomotion is picked every frame from speed
(`CONFIG.animation.moveThreshold` 1.5, `boostThreshold` 14), one-shots interrupt it by priority
(`death` > everything; `bark` loses to both). UE needs the same shape, plus what 3D adds: yaw, pitch, bank.

## Clips in furseal.glb (28 joints, one skin)

| Clip | Len | Loop | Root motion | Game state | UE use |
| --- | --- | --- | --- | --- | --- |
| `water_idle` | 2.67s | yes | none | idle (subclip 28-68 x2, see below) | **Idle** |
| `swim` | 1.00s | yes | none (0.06 bob) | swim | **Swim** |
| `sliding` | 1.93s | yes | none | boost | **Boost** |
| `roll` | 6.67s | no | 1.58 along X on `center_ctrl_03` | strike | **Strike** (strip the translate) |
| `ball` | 5.47s | no | none | hit | **Hit** |
| `bark` | 6.83s | no | none | bark | **Bark** (upper-body slot) |
| `sleep_side` | 4.00s | no | none | death | **Death** |
| `idle` | 6.00s | yes | none | surfaceIdle | **Surface idle** (breach / at surface) |
| `walk` | 2.20s | yes | none | surfaceMove | **Surface move** |
| `run` | 1.07s | yes | none | unused | skip |
| `sleep` | 6.00s | yes | none | unused | skip |

All swim-relevant clips are **in place**: root motion OFF, the Character/Pawn movement drives position.

Authored lengths of the one-shots (6-7s) are far longer than the beat the game plays; the game trims or
speeds them. In UE set per-state play rate, don't re-cut the clips.

### Known clip defects (carry these over)

- **`water_idle` seam hitch.** Fourth tail wag is mistimed (tail01 stalls frames 71-74). Game uses frames
  28-68 played twice. In UE: Sequence Player on a **cropped copy** (28-68), or set Start/End in the
  Animation Sequence. Don't use the raw clip.
- **`swim` leaves the flippers static.** The whole left arm chain is unkeyed (bind pose) and the right
  arm chain plus `neck01_05` carry ONE keyframe each, pinning the right flipper off-pose. There is nothing
  to mirror. `tools/ue5-seal-export.py` resets `uparm_R_016`, `arm_R_017`, `hand_R_018` and `neck01_05`
  to bind so both flippers match. Flipper motion in swim is yours to add in UE (Control Rig or additive).
- `boost`/`sliding` and `swim` have different bone coverage, so blending between them pops the same bones.

## State machine (AnimBP)

```
                ┌─────────── Locomotion (state machine, looped) ───────────┐
 Speed < 1.5 →  │  Idle  ⇄  Swim  ⇄  Boost                                │
                │    ↑↓ (Surfaced == true)                                 │
                │  SurfaceIdle ⇄ SurfaceMove                              │
                └──────────────────────────────────────────────────────────┘
   ↓ Layered blend per bone (slot "Upper")      ↓ Slot "FullBody" (one-shots)
   Bark on spine_up/head                        Strike, Hit, Death
```

### Variables (set in AnimBP Update from the Pawn)

| Var | Source | Notes |
| --- | --- | --- |
| `Speed` | `Velocity.Size()` | UE units are cm; game thresholds are game units. See scaling. |
| `Surfaced` | pawn Z above water plane | replaces `aboveSurface`; use a hysteresis so wave chop doesn't flicker |
| `YawRate` | `(Yaw - PrevYaw) / dt`, smoothed | drives bank |
| `Pitch` | velocity pitch, -90..90 | drives dive/climb lean |
| `IsBoosting` | input | not speed alone; see Boost |

### Locomotion transitions

| From → To | Rule | Blend |
| --- | --- | --- |
| Idle → Swim | `Speed >= MoveThreshold` | 0.20s |
| Swim → Idle | `Speed < MoveThreshold - 0.3` | 0.30s |
| Swim → Boost | `IsBoosting && Speed >= BoostThreshold` | 0.15s |
| Boost → Swim | `Speed < BoostThreshold - 2` | 0.30s |
| any → SurfaceIdle/Move | `Surfaced` (speed picks which) | 0.15s |
| Surface → water | `!Surfaced` | 0.10s |

Hysteresis margins are new: the game uses a bare threshold and guards "bounces" separately
(animation.js ~541, swim→boost→swim in two frames). In UE put the margin in the rule.

Swim should be a **Blend Space 1D on Speed** (Idle 0 → Swim ~1.5 → Boost max), with swim's play rate
scaled by speed. Game: `speedScale { base 0.75, per 34, max 1.6 }` at config.js:1771 is the nearest analog.
Start with play rate 0.75-1.6 on Swim.

### One-shots (FullBody / Upper slots)

| Trigger | Clip | Slot | Priority | Notes |
| --- | --- | --- | --- | --- |
| `Death` | `sleep_side` | FullBody | 3 | Hold last pose (no loop). Cuts everything. |
| `Strike` | `roll` | FullBody | 2 | Strip the 1.58 translate on `center_ctrl_03`; movement owns the dash. |
| `Hit` | `ball` | FullBody | 1 | Short play rate; flinch, not a performance. |
| `Bark` | `bark` | Upper (spine up) | 0 | Layered blend per bone from `chest_04`. Loses to Hit/Strike/Death. |

Priority mirrors `ONESHOT_STATES` (animation.js:156): a higher priority interrupts, a lower one cannot.
Implement as a Montage per one-shot with `Montage Play` + an enum in the pawn, and drop lower montages when a
higher one fires.

## 3D additions the 2D clips don't have

None of the clips turn, bank, climb or dive. These are **procedural**, not clip-based:

1. **Bank** (roll into turns): additive rotation on `center_ctrl_03` about the forward axis,
   `Bank = clamp(YawRate * k, -35, 35)`, interpolated (InterpSpeed ~6).
2. **Pitch lean**: additive on `chest_04` / `neck01_05` / `head_07` split 0.3 / 0.3 / 0.4 of `Pitch`.
3. **Look at**: head/neck `Look At` or Aim Offset toward the camera-aim point. Aim Offset needs 5 poses
   (centre, L, R, up, down) off `swim`; build them as single-frame additive poses in Blender.
4. **Tail / flipper secondary motion**: the game runs damped springs on tail chain
   (`tail00_019` -> `tail02_023`) and hind legs. Use **Anim Dynamics** or **Rigid Body** nodes on that chain.
   Do not rely on the clip alone.
5. **Jaw**: `mouth_08` hinges about X, +0.5 rad opens (assets.js:424). Drive additively for eating.

## Follow cam (outside the AnimBP)

Spring Arm + Camera on the pawn. Starting values for a seal ~1.7 m long:

- Arm length 450 cm, socket offset (0, 0, 40), `bUsePawnControlRotation = true`.
- Camera lag on: location 8, rotation 12. Lag max distance 120.
- Boost: lengthen arm to 560 and raise FOV 90 → 104 over 0.25s; return on exit.
- Underwater: collision test ON (probe 20 cm); ignore the water volume.
- Pitch limit -70..+70 so the seal never flips; camera and pawn yaw decouple only on Boost.
- Movement mode: Flying/Swimming. `SwimmingMode` with `bOrientRotationToMovement = true`,
  RotationRate yaw 360, pitch 180.

Camera is where the in-game `cineCamera` states live (menu, opening shot, gameplay). The Level
Sequence equivalent is a separate pass; not part of this state machine.

## Export (done by script)

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/ue5-seal-export.py -- [outdir]
```

Writes `build/ue5-seal/`: `SK_Seal.fbx` (mesh + 26-bone skeleton, single root `root_01`), nine
`A_Seal_<Clip>.fbx` (Idle, Swim, Boost, Strike, Hit, Bark, Death, SurfaceIdle, SurfaceMove, all 30 fps,
armature only) and `manifest.json` (length, loop, notes per clip). Loops include the duplicate end frame.

What it fixes: drops the glTF wrapper empties and `_rootJoint`/`Armature_00`, crops Idle to the game's
wag pair, resets the swim flipper chain, strips the Strike travel. The seal is 168 cm long in its rest pose.

Still manual in UE:

1. **Facing.** Exported forward=-Y, up=Z. After import the seal should face the red X arrow; if not, flip
   `AXIS_FORWARD` at the top of the script. I could not check this without UE.
2. Import `SK_Seal.fbx` first, then each clip against that skeleton. FBX carries no loop flag: set Loop on
   the Sequence Player nodes using `manifest.json`.
3. Sockets on `head_07`, `mouth_08`, `tail02_023`. The game's eye glow is a vertex attribute and won't travel.
4. Blend-mask `eye_L_09`, `eye_R_010`, `mouth_08` out of the Upper layer so blink and jaw stay with the face.
5. Material: the fur is a runtime noise shader (`CONFIG.sealShader`), not a texture. Needs a UE material
   or a bake.

## Open questions for Ethan

- Boost: input-held or speed-held? Game is speed-only; 3D follow-cam feels better held.
- Does the seal ever surface in the UE version? If not, drop SurfaceIdle/Move and `walk`/`idle`.
- One-shot lengths: game plays shortened versions; confirm target durations before retiming.
