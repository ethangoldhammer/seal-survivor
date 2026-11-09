"""Prep public/models/furseal.glb for Unreal Engine 5.

Run headless (Blender 4.4+/5.x):

    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/ue5-seal-export.py -- [outdir]

Writes to build/ue5-seal/ by default:
    SK_Seal.fbx          skeletal mesh + skeleton, no animation
    A_Seal_<Clip>.fbx    one per clip, armature only, resampled to 30 fps
    manifest.json        length, loop, root-motion and fix notes per clip

What it does that a plain glTF -> FBX would not:
  * drops the glTF wrapper empties and the _rootJoint/Armature_00 bones, so
    root_01 is the single skeleton root UE wants
  * resamples every clip to 30 fps (the game's own frame grid; see assets.js
    `subclips`) so the idle crop 28-68 lands on whole frames
  * Idle is the game's crop (water_idle frames 28-68), not the raw clip,
    which hitches once per loop
  * Swim: resets uparm_R_016/arm_R_017/hand_R_018/neck01_05 to bind pose.
    The clip pins them with ONE keyframe each, which leaves the right flipper
    74 degrees out of place while the left sits at bind
  * Strike (`roll`): strips the 1.58 m X travel on center_ctrl_03 so the
    movement component owns the dash

Orientation: the seal faces -Y in Blender. Exported with forward=-Y, up=Z;
confirm in UE that it faces the red X arrow (flip AXIS_FORWARD below if not).
"""
import bpy, json, math, os, sys
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'models', 'furseal.glb')
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0]) if argv else os.path.join(ROOT, 'build', 'ue5-seal')
os.makedirs(OUT, exist_ok=True)

FPS = 30
SRC_FPS = 24          # the glb's authoring rate (Blender reads it as 24)
AXIS_FORWARD, AXIS_UP = '-Y', 'Z'
PREFIX = 'Furseal_Rig|Furseal_Rig|Furseal_Rig|'

# name -> source clip, optional (t0, t1) seconds, loop, notes
CLIPS = {
    'Idle':        dict(src='water_idle', t=(28 / 30, 68 / 30), loop=True,
                        note='game crop: water_idle frames 28-68 (the clean wag pair)'),
    'Swim':        dict(src='swim', loop=True, fix='swim_flippers',
                        note='right flipper chain + neck01 reset to bind pose'),
    'Boost':       dict(src='sliding', loop=True),
    'Strike':      dict(src='roll', loop=False, fix='strip_travel',
                        note='1.58 m X travel on center_ctrl_03 removed; movement owns the dash'),
    'Hit':         dict(src='ball', loop=False),
    'Bark':        dict(src='bark', loop=False, note='play as an upper-body layer from chest_04'),
    'Death':       dict(src='sleep_side', loop=False, note='hold the last pose'),
    'SurfaceIdle': dict(src='idle', loop=True),
    'SurfaceMove': dict(src='walk', loop=True),
}
SWIM_RESET = ['uparm_R_016', 'arm_R_017', 'hand_R_018', 'neck01_05']
DROP_BONES = ['_rootJoint', 'Armature_00']

# ---------------------------------------------------------------- import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scn = bpy.context.scene
scn.render.fps = SRC_FPS
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm)
actions = {a.name.replace(PREFIX, ''): a for a in bpy.data.actions}


def use_clip(act):
    ad = arm.animation_data_create()
    ad.action = act
    if hasattr(ad, 'action_slot') and act.slots:
        ad.action_slot = act.slots[0]


def fcurves(act):
    return [fc for l in act.layers for st in l.strips for cb in st.channelbags for fc in cb.fcurves]


# Blender's pose evaluation lags one action switch behind, so clips are sampled
# straight off their F-curves (below) rather than through frame_set().
# The wrapper bones may only be dropped if they are inert: same rest matrix as
# root_01, sitting at the origin, and never keyed by any clip.
_bm = arm.data.bones
for n in DROP_BONES:
    d = max(abs(x - y) for r0, r1 in zip(_bm[n].matrix_local.to_3x3(), _bm['root_01'].matrix_local.to_3x3()) for x, y in zip(r0, r1))
    assert d < 1e-5 and _bm[n].head_local.length < 1e-6, f'{n} is not inert'
    for name, act in actions.items():
        assert not any(f'"{n}"' in fc.data_path for fc in fcurves(act)), f'{name} keys {n}'

# ---------------------------------------------------------------- clean up
# keep armature + mesh, lose the Sketchfab wrapper empties and bone-shape sphere
for o in list(bpy.data.objects):
    if o not in (arm, mesh):
        bpy.data.objects.remove(o, do_unlink=True)
for o in (arm, mesh):
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
mesh.parent = arm
mesh.parent_type = 'OBJECT'
arm.name = 'Armature'
arm.data.name = 'Armature'
mesh.name = 'SK_Seal'

# no vertex may depend on a bone we are about to delete
vg_idx = {vg.index for vg in mesh.vertex_groups if vg.name in DROP_BONES}
leaked = sum(1 for v in mesh.data.vertices for g in v.groups if g.group in vg_idx and g.weight > 1e-4)
assert leaked == 0, f'{leaked} vertex weights on {DROP_BONES}; refusing to drop them'

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
eb['root_01'].parent = None
# ball_026 hangs off the dropped wrapper too; UE needs ONE root, so it moves under root_01
# (the wrapper bones are identity, so its local animation means the same thing)
for b in eb:
    if b.parent and b.parent.name in DROP_BONES and b.name != 'root_01':
        b.parent = eb['root_01']
for n in DROP_BONES:
    if n in eb:
        eb.remove(eb[n])
bpy.ops.object.mode_set(mode='OBJECT')
roots = [b.name for b in arm.data.bones if b.parent is None]
assert roots == ['root_01'], roots

dims = Vector(mesh.dimensions)
print(f'[seal] skeleton ok: root={roots[0]}, bones={len(arm.data.bones)}, '
      f'mesh {dims.x:.3f} x {dims.y:.3f} x {dims.z:.3f} m')

# ---------------------------------------------------------------- resample
BONES = [pb.name for pb in arm.pose.bones]
for pb in arm.pose.bones:
    pb.rotation_mode = 'QUATERNION'


_DEFAULT = {'location': (0.0, 0.0, 0.0), 'rotation_quaternion': (1.0, 0.0, 0.0, 0.0), 'scale': (1.0, 1.0, 1.0)}


def sample(src_act, t0, t1):
    """Pose of every bone at FPS over [t0, t1] -> [{bone: (loc, quat, scale)}].
    Channels a clip does not key stay at bind pose (loc 0, identity, scale 1)."""
    import re
    cur = {}
    for fc in fcurves(src_act):
        m = re.match(r'pose\.bones\["(.+?)"\]\.(\w+)$', fc.data_path)
        if m and m.group(1) in BONES and m.group(2) in _DEFAULT:
            cur[(m.group(1), m.group(2), fc.array_index)] = fc
    end = src_act.frame_range[1] / SRC_FPS
    out = []
    for i in range(max(1, round((t1 - t0) * FPS)) + 1):
        f = min(t0 + i / FPS, end) * SRC_FPS
        fr = {}
        for b in BONES:
            vals = []
            for prop, dflt in _DEFAULT.items():
                vals.append(tuple(cur[(b, prop, k)].evaluate(f) if (b, prop, k) in cur else dflt[k]
                                  for k in range(len(dflt))))
            fr[b] = tuple(vals)
        out.append(fr)
    return out


def apply_fix(kind, frames):
    notes = []
    if kind == 'swim_flippers':
        for fr in frames:
            for b in SWIM_RESET:
                fr[b] = ((0, 0, 0), (1, 0, 0, 0), (1, 1, 1))
        notes.append('reset ' + ', '.join(SWIM_RESET))
    elif kind == 'strip_travel':
        b = 'center_ctrl_03'
        x0 = frames[0][b][0][0]
        lo = min(f[b][0][0] for f in frames); hi = max(f[b][0][0] for f in frames)
        for fr in frames:
            l, q, s = fr[b]
            fr[b] = ((x0, l[1], l[2]), q, s)
        notes.append(f'removed {hi - lo:.3f} m travel on {b} local X')
    return notes


def bake(name, frames):
    act = bpy.data.actions.new(f'A_Seal_{name}')
    use_clip(act)
    for i, fr in enumerate(frames):
        for b, (loc, quat, sc) in fr.items():
            pb = arm.pose.bones[b]
            pb.location, pb.rotation_quaternion, pb.scale = loc, quat, sc
            pb.keyframe_insert('location', frame=i)
            pb.keyframe_insert('rotation_quaternion', frame=i)
            pb.keyframe_insert('scale', frame=i)
    return act


def export(path, objs, anim, frame_end=0):
    for o in bpy.data.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = arm
    scn.render.fps = FPS
    scn.frame_start, scn.frame_end = 0, frame_end
    bpy.ops.export_scene.fbx(
        filepath=path, use_selection=True,
        object_types={'ARMATURE', 'MESH'} if not anim else {'ARMATURE'},
        axis_forward=AXIS_FORWARD, axis_up=AXIS_UP,
        apply_unit_scale=True, global_scale=1.0, apply_scale_options='FBX_SCALE_NONE',
        add_leaf_bones=False, use_armature_deform_only=False, primary_bone_axis='Y', secondary_bone_axis='X',
        bake_anim=anim, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
        bake_anim_use_all_bones=True, bake_anim_force_startend_keying=True,
        bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
        mesh_smooth_type='FACE', use_tspace=False, path_mode='COPY', embed_textures=False)


# ---------------------------------------------------------------- export
manifest = {'fps': FPS, 'axis_forward': AXIS_FORWARD, 'axis_up': AXIS_UP,
            'seal_length_m': round(max(dims.x, dims.y, dims.z), 3),
            'root_bone': 'root_01', 'clips': {}}

arm.animation_data_clear()
export(os.path.join(OUT, 'SK_Seal.fbx'), [arm, mesh], anim=False)
print('[seal] SK_Seal.fbx')

for name, c in CLIPS.items():
    src = actions[c['src']]
    t0, t1 = c.get('t', (0.0, src.frame_range[1] / SRC_FPS))
    frames = sample(src, t0, t1)
    notes = apply_fix(c['fix'], frames) if c.get('fix') else []
    act = bake(name, frames)
    use_clip(act)
    export(os.path.join(OUT, f'A_Seal_{name}.fbx'), [arm], anim=True, frame_end=len(frames) - 1)
    manifest['clips'][f'A_Seal_{name}'] = {
        'source': c['src'], 'frames': len(frames), 'seconds': round((len(frames) - 1) / FPS, 3),
        'loop': c['loop'], 'root_motion': False,
        'notes': ([c['note']] if c.get('note') else []) + notes}
    print(f'[seal] A_Seal_{name}.fbx  {len(frames)} frames  {"; ".join(notes)}')

with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
print('[seal] done ->', OUT)
