"""垃圾車（臺灣常見後裝壓縮式垃圾車的一般外觀，虛構塗裝，不仿任何機關 / 品牌 / 特定車款）。

執行：blender -b -P tools/blender/vehicles/garbage_truck.py
產出：public/models/vehicles/garbage_truck.glb、assets/blender/vehicles/garbage_truck.blend、
      docs/models/previews/garbage_truck-{front34,side,rear34}.png、
      docs/models/garbage_truck-manifest-entry.json（建議的 manifest 條目；本腳本不改 vehicles/manifest.json，
      也不在 build_vehicles.py 的 MODULES 內——垃圾車屬事件車，接進車輛清單由開發線決定）
依據：計畫檔規格「約 7.2 × 2.3 × 3.0 m、黃色車身、後裝壓縮式」；其餘尺寸皆為推測（一般 7 m 級 2 軸垃圾車外觀）。
- 結構：平頭駕駛室（cab-over）＋ 箱型壓縮車斗 ＋ 後方可掀尾門（下方投入口、兩側油壓缸）＋ 車尾站人踏板與扶手
- 塗裝：paint＝黃色（執行期可換色）；車斗兩側白底貼圖 decal（本機生圖：綠色回收箭頭 + 綠藍波紋，無文字、無徽章）
- 後輪雙胎以單一寬 0.46 輪表示（同 bus.py 作法）；駕駛室與尾門頂上有琥珀色警示燈 beacon（帶 emission）
座標：車頭朝 −Y、車輛左側 +X、地面 z=0（置中前座標；finish 以外接盒 XY 中心置中）。
節點：garbage_truck（根）底下 body、wheel_fl / wheel_fr / wheel_rl / wheel_rr（同 bus），另有 decal（車斗兩側貼圖，
      獨立網格以免 body 帶 UV；不參與換色）。
"""
import math
import os
import sys

import bmesh
import bpy
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402
import blendsafe  # noqa: E402

L2 = 3.60            # 半車長（規格 7.2 m）
HW = 1.15            # 車身半寬（規格 2.3 m，不含後照鏡）
H_BODY = 2.95        # 車斗頂（推測；警示燈頂約 3.05）
WB = 3.80            # 軸距（推測）
FO = 1.25            # 前懸（推測；後懸 = 7.2 − 1.25 − 3.80 = 2.15）
R = 0.46             # 輪胎半徑（推測，約 8.25R16 級）
TW_F = 0.28          # 前輪胎寬（推測）
TW_R = 0.46          # 後輪雙胎以單一較寬輪表示（推測）
TRACK = 1.80         # 輪距（推測）
FA = -L2 + FO        # 前軸 y = −2.35
RA = FA + WB         # 後軸 y = 1.45

CAB_Y = (-3.58, -1.85)      # 駕駛室前後（推測）
CAB_Z = (0.72, 2.55)        # 駕駛室底 / 頂（推測）
BOX_Y = (-1.75, 2.40)       # 壓縮車斗（推測）
BOX_Z = (1.00, H_BODY)
GATE_Y = (2.40, 3.45)       # 尾門（推測）
DECAL_Y = (-1.20, 1.60)     # 側面貼圖（2:1，配 512×256 貼圖）
DECAL_Z = (1.30, 2.70)
TEX = os.path.join(VL.BLEND_DIR, "garbage_truck_side.jpg")
PREVIEW_DIR = VL.PREVIEW_DIR


def cab_taper(z):
    """駕駛室上半部微內收（z 1.5 以上每公尺 3%）。"""
    return 1.0 - max(0.0, z - 1.5) * 0.03


def yf(z):
    """駕駛室前臉微後傾：z 1.25 → −3.60、z 2.40 → −3.50。"""
    return -3.60 + (z - 1.25) * (0.10 / 1.15)


CAB = [(-3.58, CAB_Z[0]), (-3.60, 1.25), (yf(2.40), 2.40), (-3.38, CAB_Z[1]), (CAB_Y[1], CAB_Z[1]),
       (CAB_Y[1], CAB_Z[0])]
BOX = [(BOX_Y[0], BOX_Z[0]), (BOX_Y[0], 2.80), (BOX_Y[0] + 0.15, BOX_Z[1]), (BOX_Y[1], BOX_Z[1]),
       (BOX_Y[1], BOX_Z[0])]
GATE = [(GATE_Y[0], 0.78), (GATE_Y[0], BOX_Z[1]), (2.80, BOX_Z[1]), (3.32, 2.35), (GATE_Y[1], 1.80),
        (GATE_Y[1], 0.88), (3.35, 0.78)]


def side(v, s, y0, y1, z0, z1, mat, out=0.012, inn=0.03, hw=HW, tp=None):
    """貼在側面的薄板：外表面離車身 out、往內埋 inn。s=+1 左側 / −1 右側。"""
    bm = v.box((0.0, (y0 + y1) / 2, (z0 + z1) / 2), (1.0, y1 - y0, z1 - z0), mat)
    for vt in bm.verts:
        surf = hw * (tp(vt.co.z) if tp else 1.0)
        vt.co.x = s * (surf + (out if vt.co.x > 0 else -inn))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def front(v, z0, z1, half_w, mat, out=0.012, thk=0.05, x_off=0.0, tp=True):
    """貼在後傾駕駛室前臉上的薄板（側視沿 yf 斜線）。"""
    pts = [(yf(z0) - out, z0), (yf(z1) - out, z1), (yf(z1) - out + thk, z1), (yf(z0) - out + thk, z0)]
    return v.profile(pts, half_w, mat, cab_taper if tp else None, x_off)


def rear(v, z0, z1, half_w, mat, out=0.012, thk=0.05, x_off=0.0):
    """貼在尾門直立後面（y = GATE_Y[1]）上的薄板。"""
    y = GATE_Y[1]
    return v.profile([(y + out, z0), (y + out, z1), (y + out - thk, z1), (y + out - thk, z0)], half_w, mat,
                     None, x_off)


class Truck(VL.Vehicle):
    def add_decal(self):
        """車斗兩側貼圖：獨立網格 decal（左右各一片，皆正向閱讀）。"""
        img = bpy.data.images.load(TEX)
        m = bpy.data.materials.new("decal")
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        bsdf.inputs["Roughness"].default_value = 0.45
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        bm = bmesh.new()
        uv = bm.loops.layers.uv.verify()
        (y0, y1), (z0, z1) = DECAL_Y, DECAL_Z
        for s in (1, -1):
            x = s * (HW + 0.006)
            q = [(x, y0, z0), (x, y1, z0), (x, y1, z1), (x, y0, z1)]
            if s < 0:
                q.reverse()
            f = bm.faces.new([bm.verts.new(p) for p in q])
            for lp in f.loops:
                u = (lp.vert.co.y - y0) / (y1 - y0)
                lp[uv].uv = (u if s > 0 else 1.0 - u, (lp.vert.co.z - z0) / (z1 - z0))
        me = bpy.data.meshes.new("decal")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(m)
        ob = bpy.data.objects.new("decal", me)
        self.coll("body").objects.link(ob)
        ob.parent = self.root
        self.wheels.append(ob)   # 借用 finish 的置中 / 材質清理 / 面數統計；回傳前從 manifest wheels 移除

    def _previews(self, views):
        scene = bpy.context.scene
        pc = bpy.data.collections.new("_preview（不匯出）")
        scene.collection.children.link(pc)
        me = bpy.data.meshes.new("preview_ground")
        bm = bmesh.new()
        s = 60
        bm.faces.new([bm.verts.new(p) for p in ((-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0))])
        bm.to_mesh(me)
        bm.free()
        me.materials.append(VL.make_mat("preview_ground", "#8A8C8D", 0.9))
        pc.objects.link(bpy.data.objects.new("preview_ground", me))
        for nm, energy, rot in (("preview_sun", 4.0, (45, 0, -30)), ("preview_fill", 1.6, (60, 0, 150))):
            sun = bpy.data.objects.new(nm, bpy.data.lights.new(nm, "SUN"))
            sun.data.energy = energy
            sun.rotation_euler = tuple(math.radians(a) for a in rot)
            pc.objects.link(sun)
        cam = bpy.data.objects.new("preview_camera", bpy.data.cameras.new("preview_camera"))
        pc.objects.link(cam)
        scene.camera = cam
        world = bpy.data.worlds.new("preview_sky")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs["Color"].default_value = VL.hex_rgba("#C4D1DE")
        world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.3
        scene.world = world
        scene.render.engine = "BLENDER_EEVEE"
        scene.view_settings.view_transform = "Standard"   # AgX 會把飽和黃壓成土黃；預覽改 Standard 貼近遊戲端色彩
        scene.view_settings.exposure = -0.3
        scene.render.resolution_x, scene.render.resolution_y = 768, 432
        scene.render.image_settings.file_format = "PNG"
        try:
            scene.eevee.taa_render_samples = 24
        except AttributeError:
            pass
        from mathutils import Vector
        for key, (loc, target, lens) in views.items():
            cam.location = loc
            cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
            cam.data.lens = lens
            blendsafe.render_png(os.path.join(PREVIEW_DIR, f"garbage_truck-{key}.png"), scene)


def build():
    v = Truck("garbage_truck", "垃圾車", "#F2C200", extra_mats={
        "stripe": dict(color="#2E9B4F", roughness=0.4, metallic=0.1),        # 綠色腰線（虛構塗裝）
        "steel": dict(color="#8A8E93", roughness=0.45, metallic=0.6),        # 大樑、護欄、油壓缸、扶手
        "beacon": dict(color="#E89A00", roughness=0.2, emission="#FFA000", strength=2.0),   # 琥珀色警示燈
    })
    pb = v.mats[v.mi("paint")].node_tree.nodes.get("Principled BSDF")   # 黃色漆改低金屬度，避免看起來像土黃
    pb.inputs["Metallic"].default_value = 0.1
    pb.inputs["Roughness"].default_value = 0.35
    # ---- 駕駛室：平頭、前臉微後傾、上半部內收、倒角；前輪拱挖在駕駛室下緣
    cutters = v.arch_cutters([(FA, R)], R, HW, depth=0.40)
    v.add(v.profile(CAB, HW, "paint", cab_taper), bevel=0.07, segments=2, cutters=cutters)
    # ---- 壓縮車斗：箱型、前上角斜切、倒角
    v.add(v.profile(BOX, HW, "paint"), bevel=0.08, segments=2)
    # ---- 尾門：側視多邊形（頂部往後下斜、後面直立），比車斗略窄
    v.add(v.profile(GATE, HW - 0.03, "paint"), bevel=0.06, segments=2)

    # ---- 底盤：大樑、副車架、前保險桿、後防撞桿
    for s in (1, -1):
        v.add(v.box((s * 0.45, 0.0, 0.76), (0.12, 6.6, 0.24), "trim"))
    v.add(v.box((0, (BOX_Y[0] + GATE_Y[1]) / 2, 0.94), (2.0, GATE_Y[1] - BOX_Y[0] - 0.1, 0.12), "trim"))
    v.add(v.box((0, -3.60, 0.58), (2.30, 0.10, 0.30), "trim"), bevel=0.02)            # 前保險桿
    v.add(v.box((0, 3.36, 0.52), (2.00, 0.12, 0.14), "steel"), bevel=0.01)            # 後防撞桿
    # 側護欄（兩軸之間兩條橫桿）、油箱（左）、工具箱（右）
    for s in (1, -1):
        for z in (0.50, 0.74):
            v.add(v.box((s * 1.08, (FA + R + 0.15 + RA - R - 0.15) / 2, z), (0.04, RA - FA - 2 * R - 0.3, 0.07),
                        "steel"))
    v.add(v.cyl((0.80, -1.55, 0.66), (0.80, -0.75, 0.66), 0.22, "steel", seg=12))
    v.add(v.box((-0.82, -1.15, 0.66), (0.34, 0.80, 0.42), "trim"), bevel=0.02)
    # 後輪擋泥板與泥擋
    for s in (1, -1):
        v.add(v.box((s * 0.90, RA, 0.985), (0.52, 1.25, 0.05), "trim"))
        v.add(v.box((s * 0.90, RA + 0.62, 0.62), (0.50, 0.02, 0.60), "trim"))

    # ---- 駕駛室細節：擋風玻璃、側窗、車門縫、頭燈、格柵、腰線、踏板
    v.add(front(v, 1.42, 2.36, 1.08, "trim", out=0.006))
    v.add(front(v, 1.46, 2.32, 1.03, "glass", out=0.012))
    v.add(front(v, 0.86, 1.18, 0.62, "trim", out=0.01))                              # 格柵
    for s in (1, -1):
        v.add(front(v, 0.86, 1.08, 0.20, "headlight", out=0.02, x_off=s * 0.86, tp=False), bevel=0.015)
        v.add(side(v, s, -3.30, -2.48, 1.58, 2.36, "glass", out=0.012, tp=cab_taper))   # 車門窗
        v.add(side(v, s, -3.36, -3.33, 0.80, 2.42, "trim", out=0.016, tp=cab_taper))    # 車門縫（前）
        v.add(side(v, s, -2.45, -2.42, 0.80, 2.42, "trim", out=0.016, tp=cab_taper))    # 車門縫（後）
        v.add(side(v, s, -2.38, -1.95, 1.62, 2.30, "glass", out=0.012, tp=cab_taper))   # 後側小窗
        for zz in (1.05,):
            v.add(side(v, s, CAB_Y[0] + 0.05, CAB_Y[1] - 0.03, zz, zz + 0.14, "stripe", out=0.01, tp=cab_taper))
            v.add(side(v, s, BOX_Y[0] + 0.05, BOX_Y[1] - 0.05, zz + 0.05, zz + 0.19, "stripe", out=0.01))
        v.add(v.box((s * 1.02, -3.0, 0.48), (0.26, 0.55, 0.05), "steel"))            # 上車踏板
    v.add(front(v, 1.24, 1.32, 1.10, "stripe", out=0.008))                           # 前臉腰線
    # 兩側後照鏡（臂 + 鏡殼）
    for s in (1, -1):
        v.add(v.cyl((s * 1.12, -3.40, 2.20), (s * 1.30, -3.40, 2.20), 0.02, "trim", seg=6))
        v.add(v.cyl((s * 1.30, -3.40, 2.20), (s * 1.30, -3.40, 1.70), 0.018, "trim", seg=6))
        v.add(v.box((s * 1.30, -3.38, 1.92), (0.07, 0.10, 0.38), "trim"), bevel=0.015)
        v.add(v.box((s * 1.30, -3.325, 1.92), (0.05, 0.012, 0.32), "chrome"))
    # 駕駛室頂：警示燈 + 廣播喇叭
    v.add(v.cyl((-0.45, -2.55, CAB_Z[1] - 0.02), (-0.45, -2.55, CAB_Z[1] + 0.16), 0.09, "beacon", seg=10))
    v.add(v.box((0.40, -2.70, CAB_Z[1] + 0.08), (0.30, 0.22, 0.16), "trim"), bevel=0.02)
    v.add(v.cyl((0.40, -2.82, CAB_Z[1] + 0.08), (0.40, -3.02, CAB_Z[1] + 0.08), 0.06, "trim", seg=8, r1=0.10))

    # ---- 車斗 / 尾門側面：尾門接縫、油壓缸
    for s in (1, -1):
        v.add(side(v, s, GATE_Y[0] - 0.03, GATE_Y[0] + 0.03, 0.80, BOX_Z[1] - 0.05, "trim", out=0.014))
        v.add(v.cyl((s * 1.19, 2.05, 1.12), (s * 1.19, 2.62, 2.62), 0.055, "steel", seg=8))
        v.add(v.cyl((s * 1.19, 2.05, 1.12), (s * 1.19, 1.95, 0.95), 0.07, "trim", seg=8))
    # ---- 車尾：投入口（深色凹槽）、投入口下唇、尾燈、警示燈、扶手、站人踏板
    v.add(rear(v, 1.00, 1.66, 0.96, "trim", out=0.010))
    v.add(v.box((0, GATE_Y[1] + 0.06, 0.92), (2.02, 0.16, 0.10), "steel"), bevel=0.01)
    for s in (1, -1):
        v.add(rear(v, 1.00, 1.55, 0.06, "taillight", out=0.016, x_off=s * 1.03), bevel=0.01)
        v.add(v.cyl((s * 0.92, 2.62, BOX_Z[1] - 0.05), (s * 0.92, 2.62, BOX_Z[1] + 0.10), 0.07, "beacon", seg=10))
        v.add(v.cyl((s * 1.10, GATE_Y[1] + 0.03, 1.05), (s * 1.10, GATE_Y[1] + 0.03, 2.05), 0.022, "steel", seg=6))
        v.add(v.box((s * 0.62, GATE_Y[1] + 0.12, 0.45), (0.56, 0.30, 0.04), "steel"))
    v.add(rear(v, 0.62, 0.74, 0.17, "plate", out=0.04))   # 空白車牌（不放真實號碼）

    v.add_decal()
    for nm, y, s, w in (("wheel_fl", FA, 1, TW_F), ("wheel_fr", FA, -1, TW_F),
                        ("wheel_rl", RA, 1, TW_R), ("wheel_rr", RA, -1, TW_R)):
        v.wheel(nm, (s * (TRACK / 2), y, R), R, w, s)

    meta = dict(wheelbase=WB, track=TRACK, wheelRadius=R, mass=9000,
                seat=(0.55, -2.95, 1.55), paint="#F2C200",
                notes=("臺灣常見 7 m 級後裝壓縮式垃圾車一般外觀（虛構塗裝，不仿特定車款 / 機關）。規格約 7.2 × 2.3 × 3.0 m；"
                       "軸距、輪距、輪徑、前後懸、各部位尺寸皆為推測。平頭駕駛室 + 壓縮車斗 + 後方尾門（投入口在車尾，glTF −Z 面）。"
                       "車斗兩側 decal 為獨立節點（白底綠色回收箭頭貼圖、無文字），不參與 paint 換色。beacon 材質為琥珀色警示燈"
                       "（帶 emission，未列入 EMISSIVE_MATERIALS）。後輪雙胎以單一寬 0.46 輪表示。外接盒寬含後照鏡。"
                       "seat = 駕駛座 H 點（左駕）。"))
    views = {"front34": ((8.6, -10.8, 3.6), (0, -0.4, 1.35), 35),
             "side": ((11.5, 0.0, 1.55), (0, 0.0, 1.45), 35),
             "rear34": ((-8.6, 10.8, 3.8), (0, 0.4, 1.35), 35)}
    entry = v.finish(meta, views)
    entry["wheels"].pop("decal", None)
    out = os.path.join(VL.REPO, "docs", "models", "garbage_truck-manifest-entry.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("GT_ENTRY", json.dumps({k: entry[k] for k in ("length", "width", "height", "triangles", "bytes")}))
    return entry


if __name__ == "__main__":
    build()
