"""臺中GTA 武器低模（Blender 5.2，bpy + bmesh）：球棒 bat / 手槍 pistol。

執行：blender -b -P tools/blender/weapons/build_weapons.py

座標約定（與遊戲程式的契約）：
- 單位公尺；Blender 內武器前端（棒頭 / 槍口）朝 −Y、上方 +Z、原點 = 慣用手握點
- 匯出 glTF（export_yup）後：+Z = 前端、+Y = 上、原點在握點；Blender (x, y, z) → glTF (x, z, −y)
- 每把武器合併成單一物件（bat / pistol），無 parent、transform 皆為單位矩陣
產出：public/models/weapons/*.glb + manifest.json、assets/blender/weapons/*.blend、docs/models/previews/weapon-*.png
"""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import blendsafe  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GLB_DIR = os.path.join(REPO, "public", "models", "weapons")
BLEND_DIR = os.environ.get("WEAPON_BLEND_DIR") or os.path.join(REPO, "assets", "blender", "weapons")
PREVIEW_DIR = os.environ.get("WEAPON_PREVIEW_DIR") or os.path.join(REPO, "docs", "models", "previews")
ONLY = [x for x in os.environ.get("WEAPON_ONLY", "").split(",") if x]   # 只建指定武器（其餘沿用 manifest 現有條目）
PREVIEW_COLL = "_preview（不匯出）"
MAX_TRIS = 1500
MAX_BYTES = 60 * 1024


# ---------------------------------------------------------------- 材質（同 char_lib 寫法）
def hex_rgba(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, 1.0)


def mat(name, color, roughness=0.7, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except (AttributeError, TypeError):   # 5.x 起材質一律用節點
        pass
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.get("Material Output") or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    m.diffuse_color = hex_rgba(color)
    m.roughness = roughness
    m.metallic = metallic
    return m


# ---------------------------------------------------------------- bmesh 幾何小工具
def lathe(bm, profile, n, mi):
    """沿 Y 軸的旋轉體。profile: [(y, r, 材質名), ...]；r = 0 表示極點（單一頂點）。
    第 i 段（profile[i] → profile[i+1]）使用 profile[i] 的材質。"""
    rings = []
    for y, r, _ in profile:
        if r <= 0:
            rings.append([bm.verts.new((0.0, y, 0.0))])
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * j / n), y,
                                        r * math.sin(2 * math.pi * j / n))) for j in range(n)])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        m = mi[profile[i][2]]
        for j in range(n):
            k = (j + 1) % n
            if len(a) == 1:
                f = bm.faces.new((a[0], b[k], b[j]))
            elif len(b) == 1:
                f = bm.faces.new((a[j], a[k], b[0]))
            else:
                f = bm.faces.new((a[j], a[k], b[k], b[j]))
            f.material_index = m
    return rings


def box(bm, size, m, matrix=Matrix()):
    """中心在 matrix 原點、尺寸 size=(x, y, z) 的長方體。"""
    sx, sy, sz = (s / 2 for s in size)
    vs = [bm.verts.new(matrix @ Vector((x, y, z)))
          for x in (-sx, sx) for y in (-sy, sy) for z in (-sz, sz)]
    for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        f = bm.faces.new([vs[i] for i in q])
        f.material_index = m


def box_span(bm, x0, x1, y0, y1, z0, z1, m):
    box(bm, (x1 - x0, y1 - y0, z1 - z0), m, Matrix.Translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)))


def cylinder_y(bm, cx, cz, y0, y1, r, n, m):
    """沿 Y 軸的封口圓柱（y0 → y1）。"""
    rings = []
    for y in (y0, y1):
        rings.append([bm.verts.new((cx + r * math.cos(2 * math.pi * j / n), y,
                                    cz + r * math.sin(2 * math.pi * j / n))) for j in range(n)])
    a, b = rings
    for j in range(n):
        k = (j + 1) % n
        bm.faces.new((a[j], a[k], b[k], b[j])).material_index = m
    bm.faces.new(a).material_index = m
    bm.faces.new(list(reversed(b))).material_index = m


def loop_yz(bm, cy, cz, ry, rz, tx, tr, n, m):
    """YZ 平面上的橢圓環（方形截面：X 向厚 tx、徑向厚 tr），用於扳機護弓。"""
    secs = []
    for j in range(n):
        t = 2 * math.pi * j / n
        c, s = math.cos(t), math.sin(t)
        sec = []
        for dx, dr in ((-tx / 2, -tr / 2), (tx / 2, -tr / 2), (tx / 2, tr / 2), (-tx / 2, tr / 2)):
            sec.append(bm.verts.new((dx, cy + (ry + dr) * c, cz + (rz + dr) * s)))
        secs.append(sec)
    for j in range(n):
        a, b = secs[j], secs[(j + 1) % n]
        for q in range(4):
            p = (q + 1) % 4
            bm.faces.new((a[q], a[p], b[p], b[q])).material_index = m


# ---------------------------------------------------------------- 武器定義
BAT_MATS = [("wood", "#C79A5B", 0.65, 0.0), ("grip", "#232323", 0.9, 0.0), ("knob", "#6B4A2B", 0.6, 0.0)]
PISTOL_MATS = [("metal", "#2E3136", 0.4, 0.6), ("grip", "#1C1D1F", 0.8, 0.0), ("sight", "#D8D8D8", 0.5, 0.0)]
MUZZLE_Z = 0.045     # 槍管 / 滑套軸線高度（原點上方）


def build_bat(bm, mi):
    """全長 0.85 m：knob 端 y = +0.10，棒頭端 y = −0.75；握點（原點）距 knob 端 0.10 m。"""
    profile = [
        (0.100, 0.0, "knob"), (0.0995, 0.012, "knob"), (0.0985, 0.019, "knob"), (0.0955, 0.0232, "knob"),
        (0.0915, 0.0240, "knob"), (0.0870, 0.0225, "knob"), (0.0835, 0.0180, "knob"), (0.0805, 0.0140, "grip"),
        (0.0700, 0.0130, "grip"), (0.0000, 0.0130, "grip"), (-0.0900, 0.0132, "grip"), (-0.1800, 0.0136, "wood"),
        (-0.2400, 0.0146, "wood"), (-0.3200, 0.0175, "wood"), (-0.4000, 0.0215, "wood"), (-0.4700, 0.0260, "wood"),
        (-0.5300, 0.0298, "wood"), (-0.5800, 0.0320, "wood"), (-0.6300, 0.0330, "wood"), (-0.6650, 0.0327, "wood"),
        (-0.6950, 0.0315, "wood"), (-0.7180, 0.0292, "wood"), (-0.7340, 0.0250, "wood"), (-0.7445, 0.0185, "wood"),
        (-0.7490, 0.0095, "wood"), (-0.7500, 0.0, "wood"),
    ]
    lathe(bm, profile, 16, mi)
    return {"smooth": True, "tip_z": None}


def build_pistol(bm, mi):
    """全長約 0.19 m：原點 = 握把中段中心；滑套軸線在原點上方 0.045、槍口在原點前方約 0.145。"""
    metal, grip, sight = mi["metal"], mi["grip"], mi["sight"]
    zc = MUZZLE_Z
    # 滑套（長 0.19、寬 0.028、高 0.032）
    box_span(bm, -0.014, 0.014, -0.145, 0.045, zc - 0.016, zc + 0.016, metal)
    # 滑套後方防滑紋（左右各 3 條細凸條）
    for y in (0.027, 0.032, 0.037):
        for sx in (-1, 1):
            box_span(bm, *sorted((sx * 0.0138, sx * 0.0146)), y - 0.001, y + 0.001, zc - 0.011, zc + 0.012, grip)
    # 槍身（聚合物，滑套下方）
    box_span(bm, -0.013, 0.013, -0.132, 0.036, 0.011, zc - 0.016, grip)
    # 握把：向後傾 15°，長 0.11（軸向 −0.08 → +0.03）、厚 0.03（X）、寬 0.05（前後）
    rot = Matrix.Rotation(math.radians(15), 4, "X")
    box(bm, (0.030, 0.050, 0.110), grip, rot @ Matrix.Translation((0, 0, -0.025)))
    # 彈匣底板
    box(bm, (0.032, 0.054, 0.006), metal, rot @ Matrix.Translation((0, 0.001, -0.083)))
    # 扳機護弓（橢圓環，上緣埋入槍身）與扳機
    loop_yz(bm, -0.050, 0.004, 0.022, 0.014, 0.006, 0.004, 12, grip)
    box(bm, (0.005, 0.005, 0.016), metal,
        Matrix.Translation((0, -0.040, 0.004)) @ Matrix.Rotation(math.radians(-12), 4, "X"))
    # 前照門 + 白點（朝射手 +Y 面）、後照門（左右兩塊，中間留缺口）
    top = zc + 0.016
    box_span(bm, -0.002, 0.002, -0.141, -0.135, top, top + 0.005, metal)
    box_span(bm, -0.001, 0.001, -0.135, -0.1344, top + 0.002, top + 0.004, sight)
    for sx in (-1, 1):
        box_span(bm, *sorted((sx * 0.0025, sx * 0.008)), 0.034, 0.040, top, top + 0.005, metal)
        box_span(bm, *sorted((sx * 0.0035, sx * 0.0055)), 0.0400, 0.0406, top + 0.002, top + 0.004, sight)
    # 槍口：深色圓片（略凸出滑套前緣）
    cylinder_y(bm, 0.0, zc, -0.1455, -0.1449, 0.0055, 12, grip)
    return {"smooth": False, "tip_z": zc}

SMG_MATS = [("metal", "#2E3136", 0.4, 0.6), ("grip", "#1C1D1F", 0.8, 0.0), ("sight", "#D8D8D8", 0.5, 0.0)]
SHOTGUN_MATS = [("metal", "#2E3136", 0.4, 0.6), ("wood", "#7A4E2D", 0.65, 0.0),
                ("grip", "#1C1D1F", 0.8, 0.0), ("sight", "#D8D8D8", 0.5, 0.0)]


def build_smg(bm, mi):
    """全長 0.45 m：原點 = 握把中心；機匣軸線高 0.05，槍口在原點前方 0.35、折疊托後端在 +0.10。"""
    metal, grip, sight = mi["metal"], mi["grip"], mi["sight"]
    zc = 0.05
    box_span(bm, -0.021, 0.021, -0.20, 0.07, zc - 0.026, zc + 0.026, metal)          # 機匣
    box_span(bm, -0.017, 0.017, -0.20, 0.07, zc + 0.026, zc + 0.032, grip)           # 上蓋防滑
    cylinder_y(bm, 0.0, zc + 0.006, -0.35, -0.20, 0.0115, 10, metal)                 # 槍管 / 護套
    cylinder_y(bm, 0.0, zc + 0.006, -0.26, -0.20, 0.0165, 10, grip)                  # 護套粗段
    cylinder_y(bm, 0.0, zc + 0.006, -0.3503, -0.35, 0.0075, 10, grip)                # 槍口孔
    rot = Matrix.Rotation(math.radians(15), 4, "X")
    box(bm, (0.030, 0.042, 0.105), grip, rot @ Matrix.Translation((0, 0, -0.02)))   # 握把
    loop_yz(bm, -0.075, 0.012, 0.020, 0.013, 0.006, 0.004, 10, grip)                # 扳機護弓
    box(bm, (0.005, 0.005, 0.016), metal,
        Matrix.Translation((0, -0.066, 0.010)) @ Matrix.Rotation(math.radians(-12), 4, "X"))
    box(bm, (0.026, 0.034, 0.125), grip,                                              # 彈匣（前傾）
        Matrix.Translation((0, -0.135, -0.020)) @ Matrix.Rotation(math.radians(-8), 4, "X"))
    box(bm, (0.028, 0.038, 0.006), metal,
        Matrix.Translation((0, -0.146, -0.083)) @ Matrix.Rotation(math.radians(-8), 4, "X"))
    box_span(bm, -0.010, 0.010, -0.195, -0.160, zc - 0.062, zc - 0.026, grip)       # 前握把（貼機匣底）
    box_span(bm, -0.002, 0.002, -0.19, -0.185, zc + 0.032, zc + 0.040, metal)       # 前照門
    box_span(bm, -0.001, 0.001, -0.185, -0.1845, zc + 0.034, zc + 0.038, sight)
    for sx in (-1, 1):                                                                # 後照門
        box_span(bm, *sorted((sx * 0.003, sx * 0.008)), 0.045, 0.052, zc + 0.032, zc + 0.039, metal)
    box_span(bm, -0.002, 0.002, 0.07, 0.10, zc + 0.012, zc + 0.020, metal)          # 折疊托（上桿）
    box_span(bm, -0.002, 0.002, 0.10, 0.104, zc - 0.018, zc + 0.020, metal)
    box_span(bm, -0.002, 0.002, 0.07, 0.10, zc - 0.018, zc - 0.010, metal)          # 折疊托（下桿）
    return {"smooth": False, "tip_z": zc + 0.006}


def build_shotgun(bm, mi):
    """全長 1.0 m：原點 = 握把中心；槍口在原點前方 0.70、槍托後端約 +0.30。護木中心約在 −0.36。"""
    metal, wood, grip, sight = mi["metal"], mi["wood"], mi["grip"], mi["sight"]
    zc = 0.05
    box_span(bm, -0.019, 0.019, -0.12, 0.09, zc - 0.028, zc + 0.026, metal)          # 機匣
    box_span(bm, -0.004, 0.004, -0.04, 0.02, zc - 0.028, zc - 0.034, metal)          # 退殼口 / 底部扳機座
    cylinder_y(bm, 0.0, zc + 0.008, -0.70, -0.12, 0.0125, 12, metal)                 # 槍管
    cylinder_y(bm, 0.0, zc + 0.008, -0.7003, -0.70, 0.0085, 12, grip)                # 槍口孔
    cylinder_y(bm, 0.0, zc - 0.018, -0.62, -0.12, 0.011, 10, metal)                  # 彈倉管
    cylinder_y(bm, 0.0, zc - 0.018, -0.63, -0.62, 0.0135, 10, metal)                 # 管尾蓋
    box_span(bm, -0.021, 0.021, -0.49, -0.27, zc - 0.045, zc - 0.002, wood)         # 泵動護木
    for y in (-0.46, -0.44, -0.42, -0.40):                                            # 護木防滑槽
        for sx in (-1, 1):
            box_span(bm, *sorted((sx * 0.0210, sx * 0.0218)), y - 0.004, y + 0.004, zc - 0.036, zc - 0.012, grip)
    rot = Matrix.Rotation(math.radians(15), 4, "X")
    box(bm, (0.028, 0.040, 0.100), grip, rot @ Matrix.Translation((0, 0, -0.015)))  # 握把
    loop_yz(bm, -0.060, 0.014, 0.022, 0.013, 0.006, 0.004, 10, metal)               # 扳機護弓
    box(bm, (0.005, 0.005, 0.016), metal,
        Matrix.Translation((0, -0.052, 0.012)) @ Matrix.Rotation(math.radians(-12), 4, "X"))
    # 槍托：由機匣尾端向後下方斜伸（長約 0.21），尾端加厚為肩墊
    stock = Matrix.Translation((0, 0.195, zc - 0.012)) @ Matrix.Rotation(math.radians(-8), 4, "X")
    box(bm, (0.034, 0.21, 0.050), wood, stock)
    box(bm, (0.038, 0.014, 0.078), grip, Matrix.Translation((0, 0.305, zc - 0.034)) @ Matrix.Rotation(math.radians(-8), 4, "X"))
    box_span(bm, -0.0015, 0.0015, -0.69, -0.685, zc + 0.020, zc + 0.027, metal)     # 準星
    box_span(bm, -0.0008, 0.0008, -0.685, -0.6845, zc + 0.022, zc + 0.026, sight)
    return {"smooth": False, "tip_z": zc + 0.008}


WEAPONS = [
    {"id": "bat", "name": "球棒", "type": "melee", "mats": BAT_MATS, "build": build_bat},
    {"id": "pistol", "name": "手槍", "type": "ranged", "mats": PISTOL_MATS, "build": build_pistol},
    {"id": "smg", "name": "衝鋒槍", "type": "ranged", "mats": SMG_MATS, "build": build_smg,
     "offHand": [0, -0.03, 0.18]},    # 前握把（glTF z +0.18、握把下緣）
    {"id": "shotgun", "name": "散彈槍", "type": "ranged", "mats": SHOTGUN_MATS, "build": build_shotgun,
     "offHand": [0, 0.0, 0.38]},      # 泵動護木中心
]


# ---------------------------------------------------------------- 場景 / 匯出 / 預覽
def make_object(w):
    mats = [mat(n, c, r, m) for n, c, r, m in w["mats"]]
    mi = {n: i for i, (n, *_rest) in enumerate(w["mats"])}
    bm = bmesh.new()
    info = w["build"](bm, mi)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(w["id"])
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = info["smooth"]
    me.validate()
    ob = bpy.data.objects.new(w["id"], me)
    bpy.context.scene.collection.objects.link(ob)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    used = sorted({p.material_index for p in me.polygons})
    return ob, info, [w["mats"][i][0] for i in used]


def bbox(objs):
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def export_glb(ob, path):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_animations=False, export_cameras=False, export_lights=False)


def setup_preview(ob):
    sc = bpy.context.scene
    coll = bpy.data.collections.new(PREVIEW_COLL)
    sc.collection.children.link(coll)
    lo, hi = bbox([ob])
    center, dims = (lo + hi) / 2, hi - lo
    # 地面：武器下方的淺灰薄板
    gm = bpy.data.meshes.new("_ground")
    bm = bmesh.new()
    s = max(dims) * 3
    box_span(bm, -s, s, -s, s, lo.z - 0.004, lo.z - 0.001, 0)
    bm.to_mesh(gm)
    bm.free()
    gm.materials.append(mat("_ground", "#BDBDBD", 0.9, 0.0))
    ground = bpy.data.objects.new("_ground", gm)
    coll.objects.link(ground)
    cam_data = bpy.data.cameras.new("_preview_cam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("_preview_cam", cam_data)
    coll.objects.link(cam)
    sc.camera = cam
    # 算圖設定：Workbench、材質色、STUDIO 光、淺灰背景
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 768, 512, 100
    sc.render.film_transparent = False
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    for k, v in (("show_shadows", True), ("show_cavity", False), ("background_type", "WORLD")):
        try:
            setattr(sh, k, v)
        except (AttributeError, TypeError):
            pass
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.color = hex_rgba("#E6E6E6")[:3]
    try:
        sc.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    return cam, center, dims


def aim(cam, pos, target):
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()


def render_previews(w, ob):
    cam, center, dims = setup_preview(ob)
    dist = max(dims) * 4 + 1.0
    # 3/4 視角（前端偏右、略俯視）
    d = Vector((-1.0, -0.7, 0.6)).normalized()
    aim(cam, center + d * dist, center)
    cam.data.ortho_scale = dims.length * 1.1
    cam.data.clip_end = dist * 3
    blendsafe.render_png(os.path.join(PREVIEW_DIR, f"weapon-{w['id']}-34.png"))
    # 側視（從 −X 看，前端在畫面右側）
    aim(cam, center + Vector((-dist, 0, 0)), center)
    cam.data.ortho_scale = max(dims.y, dims.z * 1.5) * 1.15
    blendsafe.render_png(os.path.join(PREVIEW_DIR, f"weapon-{w['id']}-side.png"))


def gl(v):
    """Blender (x, y, z) → glTF (x, z, −y)。"""
    return [round(v[0], 4) + 0.0, round(v[2], 4) + 0.0, round(-v[1], 4) + 0.0]


def build(w):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ob, info, mat_names = make_object(w)
    tris = len(ob.data.polygons)
    lo, hi = bbox([ob])
    tip_b = (0.0, lo.y, info["tip_z"] if info["tip_z"] is not None else 0.0)
    glb = os.path.join(GLB_DIR, f"{w['id']}.glb")
    export_glb(ob, glb)
    render_previews(w, ob)
    blendsafe.save_blend(os.path.join(BLEND_DIR, f"{w['id']}.blend"))
    size = os.path.getsize(glb)
    if tris > MAX_TRIS:
        print(f"WARN {w['id']} 三角面 {tris} 超過上限 {MAX_TRIS}")
    if size > MAX_BYTES:
        print(f"WARN {w['id']} glb {size} bytes 超過上限 {MAX_BYTES}")
    entry = {"id": w["id"], "name": w["name"], "type": w["type"], "file": f"{w['id']}.glb",
             "length": round(hi.y - lo.y, 4), "gripOffset": [0, 0, 0], "tipOffset": gl(tip_b)}
    if w["id"] == "bat":
        tip = entry["tipOffset"][2]
        entry["offHandOffset"] = [0, 0, 0.09]
        entry["sweep"] = {"from": [0, 0, 0.35], "to": [0, 0, tip], "radius": 0.04}
        entry["socketRotation"] = [0, 0, 0, 1]
    else:
        entry["offHandOffset"] = w.get("offHand", [0, -0.01, 0.0])
        entry["socketRotation"] = [0.70711, 0, 0, 0.70711]
    entry.update({"triangles": tris, "bytes": size, "materials": mat_names})
    return entry


def write_manifest(entries):
    data = {
        "units": "meters",
        "axes": "glTF: +Z = 前端（棒頭 / 槍口）, +Y = 上, 原點 = 握點",
        "socket": "weapon_socket",
        "weapons": entries,
        "notes": ("原點在慣用手握點；掛到角色 weapon_socket 骨下時設 weapon.quaternion = socketRotation（x, y, z, w）、"
                  "position = 0。tipOffset（前端點）、sweep（近戰揮擊判定線段與半徑）、offHandOffset（另一手托握點）"
                  "皆為武器本地座標（glTF：+Z 前端、+Y 上），單位公尺；length / triangles / bytes 由建模腳本實測寫入。"),
    }
    with open(os.path.join(GLB_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def verify(entry):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb = os.path.join(GLB_DIR, entry["file"])
    bpy.ops.import_scene.gltf(filepath=glb)
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.context.view_layer.update()
    tris = sum(len(p.vertices) - 2 for o in objs for p in o.data.polygons)
    lo, hi = bbox(objs)
    d = hi - lo
    tip = [0.0, entry["tipOffset"][1], round(-lo.y, 4)]
    print(f"WEAPON {entry['id']} tris={tris} bytes={os.path.getsize(glb)} "
          f"dims={d.x:.4f},{d.y:.4f},{d.z:.4f} tip={tip[0]:.4f},{tip[1]:.4f},{tip[2]:.4f}")
    if tris != entry["triangles"]:
        print(f"WARN {entry['id']} 重新匯入三角面 {tris} ≠ manifest {entry['triangles']}")
    if abs(tip[2] - entry["tipOffset"][2]) > 1e-3:
        print(f"WARN {entry['id']} 重新匯入 tip z {tip[2]} ≠ manifest {entry['tipOffset'][2]}")


def load_old_entries(mp):
    """讀既有 manifest 的條目（id → entry）；檔案不存在 / 格式壞掉 → 空 dict（印 WARN，不丟例外）。"""
    if not os.path.exists(mp):
        return {}
    try:
        with open(mp, encoding="utf-8") as f:
            items = json.load(f).get("weapons", [])
        return {e["id"]: e for e in items if isinstance(e, dict) and "id" in e}
    except (OSError, ValueError, AttributeError) as err:
        print(f"WARN 讀不到既有 manifest（{err}），只寫入這次建的武器")
        return {}


def merge_entries(weapons, only, old, build_fn):
    """WEAPON_ONLY 指定時只重建指定武器，其餘沿用既有 manifest 條目；既有 manifest 缺項 → 略過並 WARN（不 KeyError）。
    既有 manifest 裡不在 WEAPONS 清單的條目原樣保留在最後。"""
    entries = []
    for w in weapons:
        if not only or w["id"] in only:
            entries.append(build_fn(w))
        elif w["id"] in old:
            entries.append(old[w["id"]])
        else:
            print(f"WARN {w['id']} 不在既有 manifest 且未列入 WEAPON_ONLY，略過（要建請加進 WEAPON_ONLY）")
    if only:
        ids = {w["id"] for w in weapons}
        entries.extend(e for k, e in old.items() if k not in ids)
    return entries


def main():
    for p in (GLB_DIR, BLEND_DIR, PREVIEW_DIR):
        os.makedirs(p, exist_ok=True)
    mp = os.path.join(GLB_DIR, "manifest.json")
    old = load_old_entries(mp) if ONLY else {}
    entries = merge_entries(WEAPONS, ONLY, old, build)
    write_manifest(entries)
    for e in entries:
        verify(e)
    print("WEAPONS_DONE")


main()
