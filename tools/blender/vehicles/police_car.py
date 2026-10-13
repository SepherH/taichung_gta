"""警車（臺灣警車一般外觀：白色四門轎車＋藍色斜條紋＋車頂紅藍警示燈條；推測，不仿任何特定車款）。

執行：blender -b -P tools/blender/vehicles/police_car.py
      blender -b -P tools/blender/vehicles/police_car.py -- --font <ttf 路徑>   （選用：字樣改寫「警察」）
產出：public/models/vehicles/police.glb、assets/blender/vehicles/police.blend、
      docs/models/previews/vehicle-police-{front,rear}.png（同 suv.py，皆由 vehicle_lib.Vehicle.finish 產出）；
      本腳本不改 manifest.json，結束時印出 POLICE_ENTRY（實測 dims / triangles / bytes）供人工核對 manifest。
尺寸：比照 sedan 條目——長 4.66 / 寬 1.99（含後照鏡）/ 車頂 1.425 m、軸距 2.70、輪距 1.54、輪胎半徑 0.315 m，
      前懸 0.945（外接盒置中後輪心與 sedan 相同）；警示燈條頂 1.555 m → 全高 1.555（依據：外包任務單 p7-art；
      可信度：推測，非特定車款）。
塗裝：白色車身（paint #F4F6F8）、車側深藍＋淺藍斜條紋、前門與引擎蓋「POLICE」字樣（Blender 內建字型轉 mesh；
      帶 --font 時改寫「警察」）、車頂燈條左紅右藍（lightbar_red / lightbar_blue 兩個獨立 emission 材質，供執行期閃爍）、
      前後保險桿深灰（依據：任務單「外觀」一節；可信度：推測，臺灣警車一般外觀共通特徵）。
"""
import argparse
import json
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

SLUG = "police"
NAME = "警車"
PAINT = "#F4F6F8"    # 白色主色（任務單）
MASS = 1450          # kg（任務單）

L2 = 4.66 / 2        # 半車長（比照 sedan 4.66）
HW = 0.90            # 車身鈑件半寬（全寬 1.99 含後照鏡；鈑件 1.80 為推測）
MIRROR_X = 1.99 / 2  # 後照鏡外緣半寬（= sedan 外接盒寬 / 2）
WB = 2.70            # 軸距（sedan）
FO = 0.945           # 前懸（使前軸 glTF z = 1.385，與 sedan 一致）→ 後懸 4.66 − 0.945 − 2.70 = 1.015
R = 0.315            # 輪胎半徑（sedan）
TW = 0.205           # 胎寬（推測，205/55R16 級距）
TRACK = 1.54         # 輪距（sedan）
FA = -L2 + FO        # 前軸 y（車頭朝 −Y）
RA = FA + WB         # 後軸 y
FLOOR = 0.18         # 車身下緣 z（推測）
WAIST = 0.92         # 腰線（推測）
ROOF_Z = 1.425       # 車頂高（sedan 高度）
SEAT = (0.37, 0.15, 0.52)   # 駕駛座 H 點（Blender 座標；= sedan seat 轉回）

# 下車身側視輪廓 (y, z)：保險桿內縮的鼻面 → 引擎蓋 → 腰線 → 行李箱蓋 → 車尾（座標估算）
# 車頭 / 車尾最外緣留給保險桿與車牌，使外接盒長度恰為 4.66
LOWER = [(-L2 + 0.12, FLOOR), (-L2 + 0.03, 0.36), (-L2 + 0.04, 0.58), (-L2 + 0.16, 0.70),   # 鼻面
         (-1.70, 0.79), (-1.05, 0.865),                                                     # 引擎蓋
         (0.80, WAIST), (1.80, 0.955), (L2 - 0.10, 0.95),                                   # 腰線 → 行李箱蓋
         (L2 - 0.03, 0.82), (L2 - 0.035, 0.42), (L2 - 0.15, FLOOR)]                         # 車尾
HOOD = [(-L2 + 0.16, 0.70), (-1.70, 0.79), (-1.05, 0.865)]   # 引擎蓋上緣（字樣貼附用）
# 車艙側視輪廓：斜擋風 → 車頂（最高 1.425）→ 斜後窗接行李箱（估算）
CABIN = [(-1.08, 0.84), (-1.05, 0.92), (-0.20, 1.40), (0.35, ROOF_Z), (0.85, 1.415), (1.15, 1.36),
         (1.72, 1.00), (1.72, 0.88)]
CAB_HW = 0.80        # 車艙底部半寬（估算）

# 車側斜條紋：(中心 y, 寬, 材質)；z 範圍與傾斜共用（推測版面）
STRIPE_Z = (0.30, 0.88)
STRIPE_SHEAR = 0.45  # 每公尺高度往後偏移量（上緣往車尾斜）
STRIPES = [(0.36, 0.16, "stripe_dark"), (0.58, 0.08, "stripe_light")]
DECAL_OUT = 0.008    # 貼面薄板 / 字樣離車身表面的距離
TEXT_RES = 3         # 字型曲線解析度（壓三角面數）
DOOR_TEXT = (-0.48, 0.66, 0.80, 0.16)   # 前門字樣：中心 y、中心 z、最大寬、最大高
HOOD_TEXT = (-1.55, 0.95, 0.22)         # 引擎蓋字樣：中心 y、最大寬（沿 x）、最大高（沿 y）

# 警示燈條：中心 y、寬、深、底座頂 z、燈罩頂 z（燈罩頂 = 全車最高點）
LB_Y, LB_W, LB_D = 0.30, 1.10, 0.26
LB_Z0, LB_TOP = ROOF_Z + 0.02, ROOF_Z + 0.13

EXTRA_MATS = {
    "bumper": dict(color="#3A3D42", roughness=0.6),                                       # 前後保險桿深灰
    "stripe_dark": dict(color="#1B3A8C", roughness=0.4, metallic=0.1),                    # 深藍條紋
    "stripe_light": dict(color="#4FA3E0", roughness=0.4, metallic=0.1),                   # 淺藍條紋
    "lettering": dict(color="#14285E", roughness=0.4),                                    # 字樣
    "lightbar_red": dict(color="#C8102E", roughness=0.2, emission="#FF1A1A", strength=3.0),
    "lightbar_blue": dict(color="#1040C0", roughness=0.2, emission="#2A5BFF", strength=3.0),
}
LIGHTBAR_MATS = ["lightbar_red", "lightbar_blue"]

__all__ = ["SLUG", "NAME", "PAINT", "MASS", "L2", "HW", "MIRROR_X", "WB", "FO", "R", "TW", "TRACK", "FA", "RA",
           "ROOF_Z", "LB_TOP", "SEAT", "EXTRA_MATS", "LIGHTBAR_MATS", "parse_args", "build"]


def lower_taper(z):  # 下車身上半內收（估算）
    return 1.0 if z < 0.60 else 1.0 - (z - 0.60) * 0.12


def cab_taper(z):    # 車艙上半內收（tumblehome；估算）
    return 1.0 - max(z - WAIST, 0) * 0.40


def cab_x(z):        # 車艙側面在高度 z 的半寬
    return CAB_HW * cab_taper(z)


def side_x(z):       # 下車身側面在高度 z 的半寬
    return HW * lower_taper(z)


def hood_z(y):       # 引擎蓋上緣在 y 的高度（線性內插）
    for (y0, z0), (y1, z1) in zip(HOOD, HOOD[1:]):
        if y0 <= y <= y1:
            return z0 + (z1 - z0) * (y - y0) / (y1 - y0)
    return HOOD[0][1] if y < HOOD[0][0] else HOOD[-1][1]


def parse_args(argv=None):
    """Blender 自身參數在 "--" 之前，本腳本只讀 "--" 之後。"""
    argv = sys.argv if argv is None else argv
    own = argv[argv.index("--") + 1:] if "--" in argv else []
    ap = argparse.ArgumentParser(prog="police_car.py")
    ap.add_argument("--font", default=None, help="TTF/OTF 路徑；指定時字樣改寫「警察」")
    return ap.parse_args(own)


def pillar(v, y, w, s, mat, z0=0.95, z1=1.38):
    """貼著內收車艙側面的柱（同 suv.py）：頂點沿車艙斜面剪切，不做鏡射以免翻法線。"""
    bm = v.box((0, y, (z0 + z1) / 2), (0.024, w, z1 - z0), mat)
    for vt in bm.verts:
        vt.co.x += s * cab_x(vt.co.z)
    return bm


def side_plate(v, s, yc, w, z0, z1, mat, shear=0.0, out=DECAL_OUT, inn=0.03):
    """貼在下車身側面的薄板（條紋 / 門縫）：外表面離車身 out、往內埋 inn；shear = 上緣往 +Y 的斜率。"""
    zc = (z0 + z1) / 2
    bm = v.box((0.0, yc, zc), (1.0, w, z1 - z0), mat)
    for vt in bm.verts:
        z = vt.co.z
        vt.co.x = s * (side_x(z) + (out if vt.co.x > 0 else -inn))
        vt.co.y += (z - zc) * shear
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def glyphs(v, text, font, mat, fit_w, fit_h):
    """文字曲線 → 平面網格（本地 XY、法線 +Z、置中於原點並等比縮到 fit_w × fit_h 內）。"""
    cu = bpy.data.curves.new("lettering", "FONT")
    cu.body = text
    if font:
        cu.font = font
    cu.align_x = "CENTER"
    cu.resolution_u = TEXT_RES
    ob = bpy.data.objects.new("lettering", cu)
    v.coll("_tmp").objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    if not bm.faces:
        raise SystemExit(f"POLICE 字樣轉 mesh 失敗（字型缺字？）：{text!r}")
    bm.normal_update()
    up = [f for f in bm.faces if f.normal.z > 0]
    down = [f for f in bm.faces if f.normal.z <= 0]
    if up and down:      # 正反兩面都填：只留朝 +Z 的一面
        bmesh.ops.delete(bm, geom=down, context="FACES")
    elif down:
        bmesh.ops.reverse_faces(bm, faces=down)
    xs, ys = [vt.co.x for vt in bm.verts], [vt.co.y for vt in bm.verts]
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    k = min(fit_w / (max(xs) - min(xs)), fit_h / (max(ys) - min(ys)))
    for vt in bm.verts:
        vt.co = ((vt.co.x - cx) * k, (vt.co.y - cy) * k, 0.0)
    for f in bm.faces:
        f.material_index = v.mi(mat)
    return bm


def on_side(src, s, yc, zc):
    """平面字樣貼到車側：左側（+X）文字往 +Y 讀、右側（−X）往 −Y 讀，兩側皆正向可讀。"""
    bm = src.copy()
    for vt in bm.verts:
        lx, ly = vt.co.x, vt.co.y
        z = zc + ly
        vt.co = (s * (side_x(z) + DECAL_OUT), yc + s * lx, z)
    return bm


def on_hood(src, yc):
    """平面字樣貼到引擎蓋：由車頭前方看正向可讀（字頂朝車尾）。"""
    bm = src.copy()
    for vt in bm.verts:
        lx, ly = vt.co.x, vt.co.y
        y = yc + ly
        vt.co = (lx, y, hood_z(y) + DECAL_OUT)
    return bm


def build(font_path=None):
    v = VL.Vehicle(SLUG, NAME, PAINT, extra_mats=EXTRA_MATS)
    pb = v.mats[v.mi("paint")].node_tree.nodes.get("Principled BSDF")   # 白漆降金屬度，避免看起來灰
    pb.inputs["Metallic"].default_value = 0.1
    pb.inputs["Roughness"].default_value = 0.3
    # ---- 車身：下車身（挖輪拱）+ 車艙（側窗 / 擋風 / 後窗轉 glass）
    v.add(v.profile(LOWER, HW, "paint", lower_taper), bevel=0.05, segments=3,
          cutters=v.arch_cutters([(FA, R), (RA, R)], R, HW))
    v.add(v.profile(CABIN, CAB_HW, "paint", cab_taper), bevel=0.05, segments=2, glass_sides=0.93)
    for s in (1, -1):
        # B 柱（黑）、C 柱（車身色）（位置估算）
        v.add(pillar(v, 0.06, 0.09, s, "trim"), bevel=0.008, segments=1)
        v.add(pillar(v, 1.02, 0.18, s, "paint", z1=1.34), bevel=0.008, segments=1)
        # 窗框下緣黑色飾條（沿腰線）
        v.add(v.box((s * 0.81, 0.25, WAIST + 0.03), (0.03, 2.20, 0.025), "trim"))
        # 後照鏡：支架 + 鏡殼（車身色）；鏡殼外緣 = MIRROR_X
        v.add(v.box((s * 0.88, -0.95, 0.98), (0.10, 0.05, 0.04), "trim"))
        v.add(v.box((s * (MIRROR_X - 0.05), -0.96, 1.00), (0.10, 0.08, 0.11), "paint"), bevel=0.02)
        # 門縫（前門前緣、前後門之間、後門後緣）、門把
        for yc, z0 in ((-1.00, 0.40), (0.06, 0.25), (1.00, 0.50)):
            v.add(side_plate(v, s, yc, 0.012, z0, 0.88, "trim", out=0.004))
        for yc in (-0.15, 0.87):
            v.add(v.box((s * (side_x(0.80) + 0.005), yc, 0.80), (0.03, 0.14, 0.03), "chrome"))
        # 車側深藍 + 淺藍斜條紋（後門）
        for yc, w, mat in STRIPES:
            v.add(side_plate(v, s, yc, w, *STRIPE_Z, mat, shear=STRIPE_SHEAR))
        # 頭燈 / 尾燈
        v.add(v.box((s * 0.60, -L2 + 0.13, 0.64), (0.38, 0.12, 0.07), "headlight"), bevel=0.02)
        v.add(v.box((s * 0.66, L2 - 0.08, 0.80), (0.34, 0.12, 0.10), "taillight"), bevel=0.02)
    # ---- 水箱護罩、前後保險桿（深灰）、車牌（空白；前後車牌外緣 = 外接盒前後緣）
    v.add(v.box((0, -L2 + 0.05, 0.49), (0.66, 0.06, 0.12), "trim"), bevel=0.01)
    v.add(v.box((0, -L2 + 0.095, 0.30), (1.74, 0.16, 0.20), "bumper"), bevel=0.03)
    v.add(v.box((0, L2 - 0.095, 0.30), (1.74, 0.16, 0.20), "bumper"), bevel=0.03)
    v.add(v.box((0, -L2 + 0.01, 0.30), (0.34, 0.02, 0.11), "plate"))
    v.add(v.box((0, L2 - 0.02, 0.60), (0.34, 0.04, 0.12), "plate"))
    # ---- 車頂警示燈條：深色底座 + 左紅（+X）右藍（−X）燈罩 + 中央隔條
    v.add(v.box((0, LB_Y, (ROOF_Z - 0.02 + LB_Z0) / 2), (LB_W, LB_D, LB_Z0 - ROOF_Z + 0.02), "trim"),
          bevel=0.015, segments=1)
    lens_w, lens_h = LB_W / 2 - 0.03, LB_TOP - LB_Z0
    for s, mat in ((1, "lightbar_red"), (-1, "lightbar_blue")):
        v.add(v.box((s * (0.02 + lens_w / 2), LB_Y, LB_Z0 + lens_h / 2), (lens_w, LB_D - 0.04, lens_h), mat),
              bevel=0.015, segments=1)
    v.add(v.box((0, LB_Y, LB_Z0 + (lens_h - 0.01) / 2), (0.04, LB_D - 0.06, lens_h - 0.01), "trim"))
    # ---- 字樣：前門兩側 + 引擎蓋（預設 Blender 內建字型「POLICE」；--font 時「警察」）
    font = bpy.data.fonts.load(os.path.abspath(font_path)) if font_path else None
    text = "警察" if font else "POLICE"
    yc, zc, fw, fh = DOOR_TEXT
    door = glyphs(v, text, font, "lettering", fw, fh)
    for s in (1, -1):
        v.add(on_side(door, s, yc, zc))
    door.free()
    hy, hw_, hh = HOOD_TEXT
    hood = glyphs(v, text, font, "lettering", hw_, hh)
    v.add(on_hood(hood, hy))
    hood.free()
    if font:   # 字型已轉成 mesh，不把外部字型路徑留進 .blend
        bpy.data.fonts.remove(font)

    for nm, y, s in (("wheel_fl", FA, 1), ("wheel_fr", FA, -1), ("wheel_rl", RA, 1), ("wheel_rr", RA, -1)):
        v.wheel(nm, (s * (TRACK / 2), y, R), R, TW, s)
    meta = dict(wheelbase=WB, track=TRACK, wheelRadius=R, mass=MASS, seat=SEAT, paint=PAINT,
                notes=("臺灣警車一般外觀（推測，非特定車款）：白色四門轎車基底，尺寸、軸距、輪距、輪胎比照 sedan；"
                       "車側深藍＋淺藍斜條紋、前門與引擎蓋「POLICE」字樣（mesh）、前後保險桿深灰。"
                       "車頂警示燈條左紅右藍，材質 lightbar_red / lightbar_blue 帶 emission，供執行期閃爍；"
                       "height 含燈條。seat = 駕駛座 H 點（左駕，角色 drive 動作的 Hips 關節位置）。"),
                lightbar=list(LIGHTBAR_MATS))
    views = {"front": ((5.0, -6.6, 2.2), (0, 0, 0.70), 40), "rear": ((-5.2, 6.3, 2.4), (0, 0, 0.70), 40)}
    entry = v.finish(meta, views)
    print("POLICE_ENTRY", json.dumps(entry, ensure_ascii=False))
    return entry


if __name__ == "__main__":
    build(parse_args().font)
