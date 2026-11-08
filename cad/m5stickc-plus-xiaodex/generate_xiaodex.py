"""Xiaodex companion case — parametric build (runs inside the live Blender session).

Design source: xiaodex product sheet. Overall body 27.0 x 16.0 x 72.0 mm
(72.0 includes the lanyard loop; raised approve button / screen bezel sit
proud of the 16.0 mm body). Built around the repo's pinned official
M5StickC Plus envelope: 24.00 x 48.00 x 13.50 mm.

Frame: X = width (27), Y = depth (16, front face at -8), Z = height.
Device: x -12..12, y -6.6..6.9, z 6..54 (screen up, USB down).
Validated M5 feature map (measurements retained from earlier enclosure work,
plus the official shell geometry, ray-measured from StickC-Plus.stl at M5Stack
commit 48baa75a9476f4070dd5f107c1c28e2c9f383a96; see M5STACK_REFERENCE_LICENSE.txt):
  shell display opening 14.8 x 24.8 centered +8.0 from device centre
  (panel: 1.14" ST7789v2, active area 14.864 x 24.912 in a 17.6 x 31.0 glass);
  case window 14.2 x 24.2 = opening minus 0.3/side so the charcoal bezel
  always covers the orange shell ring at worst-case device shift (+-0.3 cavity)
  Button A switch centre -13.8, travel 0.35
  Button B on right flank at +8.25, power on left flank at -14.5

Load xiaodex_case_blender_validation.blend before running this script; its
separate reference scene supplies the embedded official M5 reference mesh.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

# ---------------------------------------------------------------- parameters
CASE_W, CASE_D, BODY_H, TOTAL_H = 27.0, 16.0, 63.0, 72.0
R_FACE, R_PILLOW = 5.5, 2.6
DEV_W, DEV_L, DEV_T = 24.0, 48.0, 13.5
DEV_Z0, DEV_ZC = 6.0, 30.0
DEV_Y0, DEV_Y1 = -6.6, 6.9
CAV_W, CAV_D, CAV_YC = 24.6, 14.1, 0.05          # y -7.0 .. 7.1
CAV_Z0, CAV_Z1 = 3.5, 60.0
PART_Y = 2.0                                      # clamshell parting plane
SCREEN_W, SCREEN_H, SCREEN_ZC = 14.2, 24.2, DEV_ZC + 8.0
BTN_A_ZC = DEV_ZC - 13.8                          # 16.2
BTN_B_ZC = DEV_ZC + 8.25                          # 38.25 (right flank)
PWR_ZC = DEV_ZC - 14.5                            # 15.5  (left flank)
GRAPHITE, PURPLE = 0x262829, 0x7C6FE8
SCENE_NAME = "xiaodex_case"
COLL_NAME = "XIAODEX_ASSEMBLY"

# ---------------------------------------------------------------- scene setup
old = bpy.data.scenes.get(SCENE_NAME)
if old is not None:
    for ob in list(old.collection.all_objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.scenes.remove(old)

ref_scene = bpy.data.scenes[0]
scene = bpy.data.scenes.new(SCENE_NAME)
scene.unit_settings.system = ref_scene.unit_settings.system
scene.unit_settings.scale_length = ref_scene.unit_settings.scale_length
scene.unit_settings.length_unit = ref_scene.unit_settings.length_unit
bpy.context.window.scene = scene
coll = bpy.data.collections.new(COLL_NAME)
scene.collection.children.link(coll)


def _link(ob):
    coll.objects.link(ob)
    return ob


def make_box(name, w, d, h, center):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * w, v.co.y * d, v.co.z * h))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = Vector(center)
    return _link(ob)


def make_cyl(name, r, depth, center, axis="Z", segments=48):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments,
                          radius1=r, radius2=r, depth=depth)
    rot = {"Z": Matrix.Identity(4), "Y": Matrix.Rotation(math.radians(90), 4, "X"),
           "X": Matrix.Rotation(math.radians(90), 4, "Y")}[axis]
    bm.transform(rot)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = Vector(center)
    return _link(ob)


def _apply_mod(ob, mod):
    with bpy.context.temp_override(object=ob, active_object=ob,
                                   selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def bevel_axis(ob, axis_idx, width, segments=10):
    """Bevel only edges parallel to the given axis (rounded-rect corners)."""
    me = ob.data
    attr = me.attributes.get("bevel_weight_edge")
    if attr is None:
        attr = me.attributes.new("bevel_weight_edge", "FLOAT", "EDGE")
    for e in me.edges:
        d = (me.vertices[e.vertices[1]].co - me.vertices[e.vertices[0]].co)
        if d.length == 0:
            continue
        d = d.normalized()
        attr.data[e.index].value = 1.0 if abs(d[axis_idx]) > 0.99 else 0.0
    mod = ob.modifiers.new("corner_bevel", "BEVEL")
    mod.limit_method = "WEIGHT"
    mod.width = width
    mod.segments = segments
    mod.use_clamp_overlap = True
    _apply_mod(ob, mod)
    return ob


def bevel_angle(ob, width, segments=6, angle_deg=40):
    mod = ob.modifiers.new("pillow_bevel", "BEVEL")
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle_deg)
    mod.width = width
    mod.segments = segments
    mod.use_clamp_overlap = True
    _apply_mod(ob, mod)
    return ob


def bool_op(target, cutter, op="DIFFERENCE", keep=False):
    mod = target.modifiers.new("bool", "BOOLEAN")
    mod.operation = op
    mod.object = cutter
    mod.solver = "EXACT"
    _apply_mod(target, mod)
    if not keep:
        bpy.data.objects.remove(cutter, do_unlink=True)
    return target


def rounded_slot(name, w, d, h, center, axis_idx, r, segments=8):
    ob = make_box(name, w, d, h, center)
    return bevel_axis(ob, axis_idx, r, segments)


# ---------------------------------------------------------------- body solid
body = make_box("xiaodex_body", CASE_W, CASE_D, BODY_H, (0, 0, BODY_H / 2))
bevel_axis(body, 1, R_FACE, 12)
bevel_angle(body, R_PILLOW, 8)

# raised screen bezel frame on the front face
frame = rounded_slot("bezel_frame", 17.8, 1.1, 27.8, (0, -8.05, SCREEN_ZC), 1, 3.2)
frame_hole = rounded_slot("bezel_frame_hole", 14.6, 4.0, 24.6, (0, -8.05, SCREEN_ZC), 1, 2.2)
bool_op(frame, frame_hole)
bool_op(body, frame, "UNION")

# device cavity
cavity = rounded_slot("cavity", CAV_W, CAV_D, CAV_Z1 - CAV_Z0,
                      (0, CAV_YC, (CAV_Z0 + CAV_Z1) / 2), 1, 4.0)
bool_op(body, cavity)

# screen window (through the raised frame and the front wall)
window = rounded_slot("screen_window", SCREEN_W, 4.6, SCREEN_H, (0, -7.0, SCREEN_ZC), 1, 2.0)
bool_op(body, window)

# approve-button aperture + inner flange pocket
xa = rounded_slot("x_aperture", 18.6, 3.0, 14.6, (0, -7.5, BTN_A_ZC), 1, 3.8)
bool_op(body, xa)
xpocket = rounded_slot("x_flange_pocket", 21.8, 1.15, 17.8, (0, -6.975, BTN_A_ZC), 1, 4.6)
bool_op(body, xpocket)

# right flank button B aperture + pocket (purple cap)
ba = rounded_slot("b_aperture", 3.0, 3.8, 9.6, (13.0, 0, BTN_B_ZC), 0, 1.75)
bool_op(body, ba)
bpocket = rounded_slot("b_pocket", 0.73, 5.9, 11.7, (12.615, 0, BTN_B_ZC), 0, 2.4)
bool_op(body, bpocket)

# left flank power aperture + pocket
pa = rounded_slot("pwr_aperture", 3.0, 3.4, 7.6, (-13.0, 0, PWR_ZC), 0, 1.6)
bool_op(body, pa)
ppocket = rounded_slot("pwr_pocket", 0.73, 5.5, 9.7, (-12.615, 0, PWR_ZC), 0, 2.2)
bool_op(body, ppocket)

# USB-C slot through the bottom wall
usb = rounded_slot("usb_slot", 11.0, 5.5, 8.0, (0, CAV_YC, 2.5), 2, 1.8)
bool_op(body, usb)

# rear speaker / mic grid: 6 x 8 through-holes
bm = bmesh.new()
for ci in range(6):
    for ri in range(8):
        x = -7.5 + ci * 3.0
        z = 41.0 + ri * 2.4
        m = (Matrix.Translation(Vector((x, 7.5, z)))
             @ Matrix.Rotation(math.radians(90), 4, "X"))
        bmesh.ops.create_cone(bm, cap_ends=True, segments=24,
                              radius1=0.8, radius2=0.8, depth=2.6, matrix=m)
me = bpy.data.meshes.new("grid_holes")
bm.to_mesh(me)
bm.free()
grid = bpy.data.objects.new("grid_holes", me)
_link(grid)
bool_op(body, grid)

# rear "xiaodex" wordmark (debossed, readable from the back)
crv = bpy.data.curves.new("wordmark", "FONT")
crv.body = "xiaodex"
crv.size = 5.0
crv.extrude = 0.5
crv.align_x = "CENTER"
crv.align_y = "CENTER"
tx = bpy.data.objects.new("wordmark", crv)
_link(tx)
tx.location = (0, 8.1, 24.0)
tx.rotation_euler = (math.radians(90), 0, math.radians(180))
deps = bpy.context.evaluated_depsgraph_get()
tme = bpy.data.meshes.new_from_object(tx.evaluated_get(deps))
tmo = bpy.data.objects.new("wordmark_mesh", tme)
_link(tmo)
tmo.matrix_world = tx.matrix_world.copy()
bpy.data.objects.remove(tx, do_unlink=True)
bool_op(body, tmo)

# ribbed flanks: diagonal grip grooves on both narrow sides
for side in (-1, 1):
    bmr = bmesh.new()
    for i in range(26):
        z = 4.0 + i * 2.6
        m = (Matrix.Translation(Vector((side * 13.45, 0, z)))
             @ Matrix.Rotation(math.radians(45), 4, "X"))
        bmesh.ops.create_cube(bmr, size=1.0, matrix=m @ Matrix.Diagonal(Vector((0.7, 1.0, 26.0, 1.0))))
    rme = bpy.data.meshes.new("ribs")
    bmr.to_mesh(rme)
    bmr.free()
    ribs = bpy.data.objects.new("ribs", rme)
    _link(ribs)
    band = make_box("rib_band", 1.4, 14.4, 51.0, (side * 13.55, 0, 31.5))
    bool_op(ribs, band, "INTERSECT")
    # keep-out around the flank button pockets so grooves never pierce the
    # thinned wall there
    keep_z = PWR_ZC if side < 0 else BTN_B_ZC
    keep = make_box("rib_keepout", 2.2, 7.0, 14.5, (side * 13.45, 0, keep_z))
    bool_op(ribs, keep)
    bool_op(body, ribs)

# ------------------------------------------------------- split into two shells
half_front = make_box("half_front", 80, 40, 200, (0, PART_Y - 20.0, 40))
half_rear = make_box("half_rear", 80, 40, 200, (0, PART_Y + 20.0, 40))
cover = body.copy()
cover.data = body.data.copy()
cover.name = "xiaodex_rear_cover"
_link(cover)
body.name = "xiaodex_front_tray"
tray = body
bool_op(tray, half_front, "INTERSECT", keep=False)
bool_op(cover, half_rear, "INTERSECT", keep=False)

# lanyard loop: depth-centred, owned by the rear cover (as on the product sheet);
# its front half floats above the tray's top surface, so it clears assembly.
loop = rounded_slot("lanyard_loop", 15.0, 7.0, 13.0, (0, 3.0, 65.5), 1, 4.5, 12)
bevel_angle(loop, 1.8, 6)
bool_op(cover, loop, "UNION")
loop_hole = rounded_slot("loop_hole", 8.0, 14.0, 4.5, (0, 3.0, 67.0), 1, 2.0)
bool_op(cover, loop_hole)
# seat relief: the loop's front half must clear the tray's top wall (y <= 2.05,
# z 60..63) or the shells cannot close — verified interference-free by boolean.
relief = make_box("loop_relief", 30.0, 11.05, 3.1, (0, -3.475, 61.5))
bool_op(cover, relief)

# alignment pegs (rear cover) into sockets (front tray)
for x, z in ((-7, 61.0), (7, 61.0), (-7, 2.0), (7, 2.0)):
    peg = make_cyl("peg", 1.1, 3.6, (x, PART_Y - 1.3, z), "Y", 32)
    bool_op(cover, peg, "UNION")
    sock = make_cyl("sock", 1.25, 4.4, (x, PART_Y - 1.9, z), "Y", 32)
    bool_op(tray, sock)

# ------------------------------------------------------------------- X button
xcap = rounded_slot("xiaodex_button_x", 18.0, 1.3, 14.0, (0, -8.2, BTN_A_ZC), 1, 3.5, 10)
bevel_angle(xcap, 0.55, 5)
flange = rounded_slot("x_flange", 21.2, 0.5, 17.2, (0, -7.3, BTN_A_ZC), 1, 4.3)
bool_op(xcap, flange, "UNION")
stem = make_cyl("x_stem", 3.0, 0.32, (0, -6.89, BTN_A_ZC), "Y", 40)
bool_op(xcap, stem, "UNION")
for ang in (45, -45):
    bar = rounded_slot("x_bar", 11.0, 1.2, 2.6, (0, -8.8, BTN_A_ZC), 1, 1.28)
    bar.rotation_euler = (0, math.radians(ang), 0)
    bool_op(xcap, bar)

# ------------------------------------------------------------ side button caps
bcap = rounded_slot("xiaodex_button_b", 1.35, 3.4, 9.2, (13.575, 0, BTN_B_ZC), 0, 1.6, 8)
bevel_angle(bcap, 0.45, 4)
bfl = rounded_slot("b_flange", 0.45, 5.6, 11.4, (12.675, 0, BTN_B_ZC), 0, 2.2)
bool_op(bcap, bfl, "UNION")
bstem = make_box("b_stem", 0.35, 2.6, 5.0, (12.275, 0, BTN_B_ZC))
bool_op(bcap, bstem, "UNION")

pcap = rounded_slot("xiaodex_power_cap", 1.0, 3.0, 7.2, (-13.4, 0, PWR_ZC), 0, 1.45, 8)
bevel_angle(pcap, 0.35, 4)
pfl = rounded_slot("pwr_flange", 0.45, 5.2, 9.4, (-12.675, 0, PWR_ZC), 0, 2.0)
bool_op(pcap, pfl, "UNION")
pstem = make_box("pwr_stem", 0.35, 2.4, 4.6, (-12.275, 0, PWR_ZC))
bool_op(pcap, pstem, "UNION")

# ------------------------------------------------------------ screen stack
glass = rounded_slot("xiaodex_screen_glass", 15.0, 0.27, 25.0, (0, -6.885, SCREEN_ZC), 1, 2.2)
disp = rounded_slot("xiaodex_display_demo", 16.4, 0.04, 26.4, (0, -6.68, SCREEN_ZC), 1, 2.4)

# UI: status dot, wordmark, "connected", approve ring + check, caption
ui_parts = []
dot = make_cyl("ui_dot", 0.55, 0.05, (0, -6.76, SCREEN_ZC + 10.3), "Y", 24)
ui_parts.append(("ui_green", dot))


def ui_text(name, body_text, size, z, mat_key):
    c = bpy.data.curves.new(name, "FONT")
    c.body = body_text
    c.size = size
    c.extrude = 0.0
    c.align_x = "CENTER"
    c.align_y = "CENTER"
    o = bpy.data.objects.new(name, c)
    _link(o)
    o.location = (0, -6.76, z)
    o.rotation_euler = (math.radians(90), 0, 0)
    ui_parts.append((mat_key, o))
    return o


ui_text("ui_brand", "xiaodex", 2.3, SCREEN_ZC + 7.3, "ui_white")
ui_text("ui_status", "connected", 1.25, SCREEN_ZC + 5.0, "ui_green")
ui_text("ui_caption", "Tap to Approve", 1.25, SCREEN_ZC - 9.5, "ui_white")

ring = bpy.data.meshes.new("ui_ring")
bmr = bmesh.new()
bmesh.ops.create_circle(bmr, cap_ends=False, segments=64, radius=4.6)
bmesh.ops.solidify(bmr, geom=list(bmr.faces) + list(bmr.edges) + list(bmr.verts), thickness=0.0)
bmr.free()
ring_ob = None
# torus is simpler and robust:
bmr = bmesh.new()
bmesh.ops.create_cone(bmr, cap_ends=True, segments=64, radius1=3.9, radius2=3.9, depth=0.06)
inner = bmesh.new()
# build ring by boolean of two cylinders in object mode instead
me_out = bpy.data.meshes.new("ring_out")
bmr.to_mesh(me_out)
bmr.free()
ring_ob = bpy.data.objects.new("ui_ring", me_out)
_link(ring_ob)
ring_ob.rotation_euler = (math.radians(90), 0, 0)
ring_ob.location = (0, -6.76, SCREEN_ZC - 1.6)
ring_in = make_cyl("ring_in", 3.3, 0.3, (0, -6.76, SCREEN_ZC - 1.6), "Y", 64)
bool_op(ring_ob, ring_in)
ui_parts.append(("ui_purple", ring_ob))

# checkmark inside the ring: two stadium bars
chk1 = rounded_slot("ui_chk1", 2.2, 0.06, 0.8, (-1.25, -6.76, SCREEN_ZC - 2.5), 1, 0.39)
chk1.rotation_euler = (0, math.radians(45), 0)
chk2 = rounded_slot("ui_chk2", 3.8, 0.06, 0.8, (0.7, -6.76, SCREEN_ZC - 1.7), 1, 0.39)
chk2.rotation_euler = (0, math.radians(-45), 0)
bool_op(chk1, chk2, "UNION")
chk1.name = "ui_check"
ui_parts.append(("ui_purple", chk1))

# dark dust-mesh insert behind the speaker grid (keeps the grid reading dark)
grille = make_box("xiaodex_grille_mesh", 19.0, 0.14, 21.0, (0, 7.02, 48.4))
grille_mat_holder = True

# ------------------------------------------------------------ M5 reference
src = None
for sc in bpy.data.scenes:
    if sc.name == SCENE_NAME:
        continue
    for ob in sc.collection.all_objects:
        if ob.name.startswith("m5stickc_plus_reference"):
            src = ob
            break
    if src:
        break
m5 = None
if src is not None:
    m5 = src.copy()
    m5.data = src.data.copy()
    m5.name = "m5stickc_plus_reference"
    m5.hide_render = False
    m5.hide_viewport = False
    _link(m5)
    deps = bpy.context.evaluated_depsgraph_get()
    # world bbox in the source scene layout
    corners = [src.matrix_world @ Vector(c) for c in src.bound_box]
    dims = Vector((max(c.x for c in corners) - min(c.x for c in corners),
                   max(c.y for c in corners) - min(c.y for c in corners),
                   max(c.z for c in corners) - min(c.z for c in corners)))
    order = sorted(range(3), key=lambda i: dims[i])  # thin, mid, long
    # target: long axis -> Z, thin axis -> Y, mid -> X
    thin, mid, longa = order[0], order[1], order[2]
    axes = [Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))]
    rot = Matrix((axes[mid], axes[thin], axes[longa])).transposed().to_4x4()
    # rot maps source mid->X? build change of basis: columns are images of X,Y,Z
    cols = [None, None, None]
    cols[mid] = Vector((1, 0, 0))
    cols[thin] = Vector((0, 1, 0))
    cols[longa] = Vector((0, 0, 1))
    rot = Matrix((
        (cols[0].x, cols[1].x, cols[2].x, 0),
        (cols[0].y, cols[1].y, cols[2].y, 0),
        (cols[0].z, cols[1].z, cols[2].z, 0),
        (0, 0, 0, 1),
    ))
    m5.matrix_world = rot @ src.matrix_world
    # now translate so bbox fits the pocket
    corners = [m5.matrix_world @ Vector(c) for c in m5.bound_box]
    mn = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    mx = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    tgt_min = Vector((-DEV_W / 2, DEV_Y0, DEV_Z0))
    m5.matrix_world = Matrix.Translation(tgt_min - mn) @ m5.matrix_world
    # the bbox fit above is sign-ambiguous: the screen may end up facing the
    # rear cover. Probe the display through-opening (device centre +8) from the
    # front; if the first surface hit is shallow, the front is a closed wall,
    # so spin the device 180 about Z (about the cavity centre) to face -Y.
    deps = bpy.context.evaluated_depsgraph_get()
    ev = m5.evaluated_get(deps)
    mwi = m5.matrix_world.inverted()
    o = mwi @ Vector((0.0, DEV_Y0 - 5.0, DEV_ZC + 8.0))
    d = (mwi.to_3x3() @ Vector((0, 1, 0))).normalized()
    hit, loc, _, _ = ev.ray_cast(o, d)
    if hit and (m5.matrix_world @ loc).y < DEV_Y0 + 1.0:
        yc = (DEV_Y0 + DEV_Y1) / 2.0
        pivot = Matrix.Translation(Vector((0, yc, 0)))
        m5.matrix_world = (pivot @ Matrix.Rotation(math.radians(180), 4, "Z")
                           @ pivot.inverted() @ m5.matrix_world)

# ------------------------------------------------------------------ materials
def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    return tuple(srgb_to_linear(((h >> s) & 0xFF) / 255.0) for s in (16, 8, 0))


def mat(name, hexcol, rough=0.55, emit=0.0, emit_hex=None, metallic=0.0):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*hex_lin(hexcol), 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metallic
    if "Specular IOR Level" in b.inputs:
        b.inputs["Specular IOR Level"].default_value = 0.0
    if emit > 0:
        b.inputs["Emission Color"].default_value = (*hex_lin(emit_hex or hexcol), 1.0)
        b.inputs["Emission Strength"].default_value = emit
    return m


m_case = mat("Xiaodex Graphite", GRAPHITE, 0.58, 0.12)
m_purple = mat("Xiaodex Purple", PURPLE, 0.45, 0.10)
m_glass = mat("Screen Glass", 0x0A0C0E, 0.15)
bg = next(n for n in m_glass.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bg.inputs["Alpha"].default_value = 0.12
try:
    m_glass.blend_method = "BLEND"
    m_glass.show_transparent_back = False
except AttributeError:
    pass
m_screen = mat("Screen Black", 0x07090B, 0.4, 0.35, 0x07090B)
m_ui_w = mat("UI White", 0xF2F4F6, 0.4, 1.6, 0xF2F4F6)
m_ui_g = mat("UI Green", 0x3ECF6E, 0.4, 1.4, 0x3ECF6E)
m_ui_p = mat("UI Purple", PURPLE, 0.4, 1.0, PURPLE)
m_mesh = mat("Grille Mesh", 0x141618, 0.85)

for ob in (tray, cover, xcap, pcap):
    ob.data.materials.clear()
    ob.data.materials.append(m_case)
bcap.data.materials.clear()
bcap.data.materials.append(m_purple)
glass.data.materials.append(m_glass)
grille.data.materials.append(m_mesh)
disp.data.materials.append(m_screen)
for key, ob in ui_parts:
    m = {"ui_white": m_ui_w, "ui_green": m_ui_g, "ui_purple": m_ui_p}[key]
    if ob.type == "FONT":
        ob.data.materials.append(m)
    else:
        ob.data.materials.append(m)

for ob in (tray, cover, xcap, bcap, pcap):
    for p in ob.data.polygons:
        p.use_smooth = False

# ------------------------------------------------------------ studio + camera
world = bpy.data.worlds.get("xiaodex_world") or bpy.data.worlds.new("xiaodex_world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (*hex_lin(0xE9E7E3), 1.0)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world

for name, direction, energy in (("key", (-0.6, -0.55, 1.0), 1.5),
                                ("fill", (0.85, -0.5, 0.55), 0.9),
                                ("rim", (0.2, 0.9, 0.55), 1.2),
                                ("top", (0.0, 0.12, 1.0), 0.6)):
    li = bpy.data.lights.new("xd_" + name, "SUN")
    li.energy = energy
    li.angle = math.radians(5)
    lo = bpy.data.objects.new("xd_" + name, li)
    _link(lo)
    lo.rotation_euler = Vector(direction).normalized().to_track_quat("Z", "Y").to_euler()

target = bpy.data.objects.new("cam_target", None)
_link(target)
target.location = (0, 0, 33)
cam_data = bpy.data.cameras.new("xiaodex_cam")
cam_data.lens = 65
cam = bpy.data.objects.new("xiaodex_cam", cam_data)
_link(cam)
cam.location = (52, -120, 62)
con = cam.constraints.new("TRACK_TO")
con.target = target
con.track_axis = "TRACK_NEGATIVE_Z"
con.up_axis = "UP_Y"
scene.camera = cam

scene.render.resolution_x = 1400
scene.render.resolution_y = 1400
try:
    scene.render.engine = "BLENDER_EEVEE"
except TypeError:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.eevee.taa_render_samples = 32
scene.view_settings.view_transform = "Standard"

# ------------------------------------------------------------------- report
deps = bpy.context.evaluated_depsgraph_get()


def bbox(ob):
    cs = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = [min(c[i] for c in cs) for i in range(3)]
    mx = [max(c[i] for c in cs) for i in range(3)]
    return [round(mx[i] - mn[i], 2) for i in range(3)], [round(v, 2) for v in mn], [round(v, 2) for v in mx]


report = {}
for ob in coll.objects:
    if ob.type == "MESH":
        d, mn, mx = bbox(ob)
        report[ob.name] = {"dims": d, "min": mn, "max": mx, "polys": len(ob.data.polygons)}

overall_min = [min(report[n]["min"][i] for n in ("xiaodex_front_tray", "xiaodex_rear_cover")) for i in range(3)]
overall_max = [max(report[n]["max"][i] for n in ("xiaodex_front_tray", "xiaodex_rear_cover")) for i in range(3)]
result = {
    "overall_shells": [round(overall_max[i] - overall_min[i], 2) for i in range(3)],
    "m5_found": m5 is not None,
    "m5_dims": report.get("m5stickc_plus_reference", {}).get("dims"),
    "parts": {k: v["dims"] for k, v in report.items()},
}
