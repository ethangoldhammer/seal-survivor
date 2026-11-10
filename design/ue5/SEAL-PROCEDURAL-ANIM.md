# Seal procedural animation in UE5 (head, neck, flippers, tail)

The clips alone are not what the 3js seal looks like. The game layers a procedural pass on top of
them every frame (`path/src/systems/aimRig.js`, `ikChain.js`, `breathe.js`). Without it the seal
shows the raw clip pose: head raised, neck stiff, flippers at bind. Values are in
`build/ue5-seal-procedural/params.json` (`tools/ue5-seal-procedural-export.mjs`).

## The back arch (found, partly my bug)

- **Mine, fixed:** the first swim export reset `neck01_05` to bind. That bone's single keyframe in
  `swim` is the authored swim neck (62 deg about X, vs about 54 in the other clips), not a stray.
  Resetting it stood the neck upright against `neck02_06` and `head_07`, which keep their swim
  rotations, so the whole front arched. Fixed in `tools/ue5-seal-export.py` (re-export and re-import
  the clips). The right flipper chain is still reset (it is a real stray).
- **Still there after that fix:** the `swim` clip holds the head high (a rising pose). In the game the
  head IK below overrides the neck every frame and points it along the aim, so the raised head never
  shows. UE has no equivalent yet. That is the next fix, not a clip problem.

## The layers, in the order the game applies them

All run AFTER the clip writes the pose and only touch the bones they name.

### 1. Head and neck aim (the big one)

CCD IK on `neck01_05 > neck02_06 > head_07`, effector 0.19 past the head along the bone's +Y, target
placed far out along the aim direction (`reach` 4) so it reads as "straighten along the aim".

| Setting | Value | Meaning |
| --- | --- | --- |
| weight / idleWeight | 0.86 / 0.5 | blend of the solved pose over the clip while engaged / at rest |
| weightLerp | 6 | how fast that weight eases |
| smoothing | 9 | slerp rate of the solved pose frame to frame |
| iterations | 3 | CCD passes |
| rootInfluence | 0.26 | scales the work the root-most bones may take, so the head moves more than the base |
| maxBend | 0.4 rad | per bone, from the clip's pose |
| maxFold / maxTwist | 1.3 / 0.36 rad | absolute joint limits |
| softness | 0.45 | soft clamp near the limits |
| releaseOnOneShot | true | weight drops to 0 during strike/hit/etc. |

**Cone gate and glance.** `gate = 1 - smoothstep(frontCone 0.9, backCone 1.7, angle between the
seal's forward and the aim)`. When the aim is behind the seal the head gives up: the target is blended
toward the camera axis (`cameraBias` 0.86, keeping 0.36 of the target's height), the weight settles at
`glanceWeight` 0.46 instead of 0, and the BODY twists to help (`craneAngle` 0.7 rad, `craneLerp` 5).
It never cranes the neck backwards.

**Anti-ratchet.** The game puts back last frame's reference for bones the clip does not rewrite
(single-key and held tracks), or the blend creeps. UE re-evaluates every bone every frame, so it
does not need this; do not port it.

**UE build:** AnimBP post-graph, after the state machine. `CCD IK` (or Control Rig with a CCD/FABRIK
chain) on the three bones, with per-bone angle limits from the table, blended by an Alpha you drive from
the weight logic. The aim vector in 3D is the camera aim direction (or velocity when not aiming);
`gate` uses the angle between the seal's forward and that. Bone axes: check which local axis runs along
each bone in the UE skeleton (the game's rig runs +Y along every bone before the export's yaw).

### 2. Front flippers

CCD IK on `uparm > arm > hand` per side onto the aim. weight 1 / idle 0.56, smoothing 18, 4 iterations,
rootInfluence 0.46, maxBend 1.2, maxFold 1.4, maxTwist 0.6, effector 0.26. In the game this is also the
weapon muzzle. For a trailer it is the "flippers lead toward where it looks" read. Lower priority
than the head. The swim clip keeps both flippers at bind, so without this they are stiff.

### 3. Tail spring

Not IK: a damped spring on `tail00_019 > tail01_020 > tail02_023` so the tail trails turns.
stiffness 120, damping 14, tipLooseness 0.66 (the tip is looser than the root), maxLag 0.46,
softness 0.5, snapAngle 1.4. **UE build:** Anim Dynamics or a Spring Controller on the chain; map
stiffness/damping by feel, then tune against a three.js capture. The rear flippers are deliberately
NOT in this chain.

### 4. Resting breath (surface only)

Additive rise and fall on `chest_04` (about X) with `neck02_06` countering. Period 3.6 s, inhale 0.35
of the cycle (quick in, long out), depth 0.035 rad, neckCounter 0.55. Only while resting at the
surface, not underwater. `neck01_05` is deliberately not used (single-key: a delta compounds).

### 5. Jaw

`mouth_08` hinges about X, +0.5 rad opens. Additive over the clip, driven by eating (pickups) and
the level-up seal.

## Body turn (not a bone layer)

The mesh yaws to face the velocity: `faceMode velocity`, `turnLerp` 4.5/s, no turn below speed 0.8,
a 0.96 s turn-around when it reverses. In UE this is the pawn's rotation (orient to movement with a
matching yaw rate), not the AnimBP.

## Camera must not pass through geometry or PCG

Not seal animation, but you asked:

- Spring Arm: `Do Collision Test` ON, `Probe Size` 20-30 cm, `Probe Channel` Camera. Keep camera lag on
  but cap `Camera Lag Max Distance`: a lagging camera can overshoot a wall during a boost.
- Static meshes only block the camera if their collision responds to the Camera channel. **PCG
  output usually has no collision**: on the PCG Static Mesh Spawner, set the mesh descriptor's
  collision preset to one that Blocks Camera (BlockAll or a custom preset), and check the source mesh
  has simple collision or `Use Complex Collision As Simple`. Instanced meshes need it set on the
  descriptor, not the mesh asset.
- Landscape blocks Camera by default; water bodies should be Ignore for the camera so it can cross
  the surface.
- Verify with `Show Collision` and the spring arm's debug draw (`p.VisualizeSpringArm`-style cvar, or
  Draw Debug Camera) at the spots where it clips now.

## Status

Nothing here is built in UE. The swim neck fix is in the script (verified by render: the seal is
no longer upright-necked) but the clips need re-exporting and re-importing on the PC.
