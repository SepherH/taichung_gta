"""消防車（臺灣常見 7 m 級水箱消防車的一般外觀，虛構塗裝，不仿任何機關 / 品牌 / 特定車款）。

執行：blender -b -P tools/blender/vehicles/fire_truck.py
產出：public/models/vehicles/fire_truck.glb、assets/blender/vehicles/fire_truck.blend、
      docs/models/previews/vehicle-fire_truck-{front,rear}.png、
      docs/models/fire_truck-manifest-entry.json（建議的 manifest 條目；本腳本不改 vehicles/manifest.json，
      也不在 build_vehicles.py 的 MODULES 內——同 garbage_truck 作法，條目由開發線併入）
規格：約 7.6 × 2.5（含後照鏡）× 3.0 m、紅色車身；軸距 4.0、輪距 1.9、輪徑 0.5（皆推測）。
結構：平頭駕駛室 + 水箱 / 裝備箱車身 + 車頂水砲（獨立節點 cannon）+ 車頂紅藍警示燈列 + 琥珀警示燈
      + 側邊銀色裝備箱 + 後方捲門 + 後梯架；後輪雙胎以單一寬輪表示。
座標：車頭朝 −Y、車輛左側 +X、地面 z=0。節點：fire_truck（根）底下 body、cannon、wheel_fl / fr / rl / rr。
"""
import json
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

L2 = 3.80
HW = 1.10            # 車身半寬（含後照鏡約 2.5 m）
WB = 4.00
FO = 1.30
R = 0.50
TW_F = 0.30
TW_R = 0.48          # 後輪雙胎以單一寬輪表示
TRACK = 1.90
FA = -L2 + FO        # 前軸 y = −2.5
RA = FA + WB         # 後軸 y = 1.5
CAB_Z = (0.85, 2.55)
CAB_BACK = -2.20
BOX_Y = (-2.15, 3.55)
BOX_Z = (1.00, 2.70)


def cab_taper(z):
    return 1.0 - max(0.0, z - 1.5) * 0.03


def yf(z):
    return -3.80 + (z - 1.30) * (0.10 / 1.1)


CAB = [(-3.78, CAB_Z[0]), (-3.80, 1.30), (yf(2.40), 2.40), (-3.58, CAB_Z[1]), (CAB_BACK, CAB_Z[1]),
       (CAB_BACK, CAB_Z[0])]
BOX = [(BOX_Y[0], BOX_Z[0]), (BOX_Y[0], BOX_Z[1]), (BOX_Y[1], BOX_Z[1]), (BOX_Y[1], BOX_Z[0])]


def side(v, s, y0, y1, z0, z1, mat, out=0.012, inn=0.03, hw=HW, tp=None):
    bm = v.box((0.0, (y0 + y1) / 2, (z0 + z1) / 2), (1.0, y1 - y0, z1 - z0), mat)
    for vt in bm.verts:
        surf = hw * (tp(vt.co.z) if tp else 1.0)
        vt.co.x = s * (surf + (out if vt.co.x > 0 else -inn))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def front(v, z0, z1, half_w, mat, out=0.012, thk=0.05, x_off=0.0, tp=True):
    pts = [(yf(z0) - out, z0), (yf(z1) - out, z1), (yf(z1) - out + thk, z1), (yf(z0) - out + thk, z0)]
    return v.profile(pts, half_w, mat, cab_taper if tp else None, x_off)


def rear(v, z0, z1, half_w, mat, out=0.012, thk=0.05, x_off=0.0):
    y = BOX_Y[1]
    return v.profile([(y + out, z0), (y + out, z1), (y + out - thk, z1), (y + out - thk, z0)], half_w, mat,
                     None, x_off)


def merge(dst, src):
    """把 bmesh src 併入 dst（保留面的 material_index）。"""
    me = bpy.data.meshes.new("_m")
    src.to_mesh(me)
    src.free()
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)


class Fire(VL.Vehicle):
    def add_cannon(self):
        """車頂水砲：獨立網格節點 cannon（底座 + 砲管 + 噴嘴），位於車頂前段。"""
        bm = bmesh.new()
        cx, cy, z0 = 0.0, -1.25, BOX_Z[1]
        merge(bm, self.box((cx, cy, z0 + 0.06), (0.50, 0.50, 0.12), "steel"))
        merge(bm, self.cyl((cx, cy, z0 + 0.10), (cx, cy, z0 + 0.20), 0.12, "steel", seg=10))
        merge(bm, self.cyl((cx, cy, z0 + 0.20), (cx, cy - 0.55, z0 + 0.22), 0.07, "steel", seg=10))
        merge(bm, self.cyl((cx, cy - 0.55, z0 + 0.22), (cx, cy - 0.70, z0 + 0.23), 0.05, "steel", seg=10, r1=0.09))
        merge(bm, self.cyl((cx, cy, z0 + 0.20), (cx, cy + 0.30, z0 + 0.26), 0.045, "trim", seg=8))
        me = bpy.data.meshes.new("cannon")
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new("cannon", me)
        self.coll("body").objects.link(ob)
        ob.parent = self.root
        self.wheels.append(ob)   # 借用 finish 的置中 / 材質清理 / 面數統計；回傳前從 wheels 移除


def build():
    v = Fire("fire_truck", "消防車", "#D32F2F", extra_mats={
        "steel": dict(color="#C4C8CD", roughness=0.35, metallic=0.7),       # 銀色水砲 / 裝備箱 / 捲門
        "stripe": dict(color="#F2F2EE", roughness=0.4, metallic=0.1),       # 白色腰線（虛構塗裝）
        "beacon": dict(color="#E89A00", roughness=0.2, emission="#FFA000", strength=2.0),
        "beacon_red": dict(color="#D01010", roughness=0.2, emission="#FF2020", strength=2.0),
        "beacon_blue": dict(color="#1040D0", roughness=0.2, emission="#2060FF", strength=2.0),
    })
    pb = v.mats[v.mi("paint")].node_tree.nodes.get("Principled BSDF")
    pb.inputs["Metallic"].default_value = 0.1
    pb.inputs["Roughness"].default_value = 0.35
    cutters = v.arch_cutters([(FA, R)], R, HW, depth=0.40)
    v.add(v.profile(CAB, HW, "paint", cab_taper), bevel=0.07, segments=2, cutters=cutters)
    rc = v.arch_cutters([(RA, R)], R, HW, depth=0.45)
    v.add(v.profile(BOX, HW, "paint"), bevel=0.08, segments=1, cutters=rc)

    # 底盤：大樑、前保險桿、後防撞桿、後輪擋泥板
    for s in (1, -1):
        v.add(v.box((s * 0.45, 0.0, 0.78), (0.12, 7.0, 0.24), "trim"))
    v.add(v.box((0, -3.76, 0.60), (2.30, 0.10, 0.30), "trim"), bevel=0.02)
    v.add(v.box((0, 3.61, 0.58), (2.00, 0.12, 0.16), "steel"), bevel=0.01)
    for s in (1, -1):
        v.add(v.box((s * 0.95, RA, 1.05), (0.54, 1.30, 0.05), "trim"))
        v.add(v.box((s * 0.95, RA + 0.68, 0.66), (0.52, 0.02, 0.62), "trim"))

    # 駕駛室：擋風玻璃、側窗、格柵、頭燈、腰線、車門縫、踏板
    v.add(front(v, 1.50, 2.38, 1.06, "trim", out=0.006))
    v.add(front(v, 1.54, 2.34, 1.01, "glass", out=0.012))
    v.add(front(v, 0.92, 1.24, 0.62, "trim", out=0.01))
    v.add(front(v, 1.30, 1.38, 1.12, "stripe", out=0.008))
    for s in (1, -1):
        v.add(front(v, 0.92, 1.14, 0.20, "headlight", out=0.02, x_off=s * 0.86, tp=False), bevel=0.015)
        v.add(side(v, s, -3.50, -2.75, 1.62, 2.38, "glass", out=0.012, tp=cab_taper))
        v.add(side(v, s, -2.65, -2.30, 1.62, 2.38, "glass", out=0.012, tp=cab_taper))
        v.add(side(v, s, -2.72, -2.68, 0.86, 2.45, "trim", out=0.016, tp=cab_taper))
        v.add(side(v, s, -3.60, -3.56, 0.86, 2.45, "trim", out=0.016, tp=cab_taper))
        v.add(side(v, s, CAB_BACK - 0.06, BOX_Y[1] - 0.05, 1.28, 1.38, "stripe", out=0.01))   # 車身白腰線
        v.add(v.box((s * 1.05, -3.20, 0.52), (0.26, 0.60, 0.05), "steel"))
    # 後照鏡（臂 + 鏡殼）
    for s in (1, -1):
        v.add(v.cyl((s * 1.08, -3.55, 2.25), (s * 1.24, -3.55, 2.25), 0.02, "trim", seg=6))
        v.add(v.cyl((s * 1.24, -3.55, 2.25), (s * 1.24, -3.55, 1.80), 0.018, "trim", seg=6))
        v.add(v.box((s * 1.24, -3.53, 2.00), (0.06, 0.10, 0.38), "trim"), bevel=0.015)
        v.add(v.box((s * 1.24, -3.475, 2.00), (0.05, 0.012, 0.32), "chrome"))
    # 車頂紅藍警示燈列（駕駛室頂）+ 琥珀警示燈（車身頂後方）
    v.add(v.box((0, -2.95, CAB_Z[1] + 0.025), (1.00, 0.30, 0.05), "trim"))
    for i, mat in enumerate(("beacon_red", "beacon_red", "beacon_blue", "beacon_blue")):
        v.add(v.box((-0.375 + i * 0.25, -2.95, CAB_Z[1] + 0.11), (0.23, 0.28, 0.12), mat), bevel=0.01)
    for s in (1, -1):
        v.add(v.cyl((s * 0.85, 3.15, BOX_Z[1] - 0.02), (s * 0.85, 3.15, BOX_Z[1] + 0.14), 0.07, "beacon", seg=10))

    # 側邊銀色裝備箱（每側 3 格，捲簾式）與水箱艙腰線
    for s in (1, -1):
        for y0, y1 in ((-1.85, -0.55), (-0.45, 0.85), (0.95, 2.25)):
            v.add(side(v, s, y0, y1, 1.45, 2.45, "steel", out=0.05))
            for k in range(1, 3):
                zz = 1.45 + k * (1.0 / 3)
                v.add(side(v, s, y0 + 0.03, y1 - 0.03, zz - 0.006, zz + 0.006, "trim", out=0.056))
        v.add(side(v, s, 2.40, 3.40, 1.70, 2.45, "steel", out=0.05))           # 後段水帶箱
    # 後方：捲門（銀色橫條）、尾燈、車牌、後梯架
    v.add(rear(v, 1.20, 2.40, 0.88, "trim", out=0.010))
    for k in range(8):
        zz = 1.26 + k * 0.14
        v.add(rear(v, zz, zz + 0.10, 0.84, "steel", out=0.018, thk=0.04))
    v.add(v.box((0, BOX_Y[1] + 0.04, 0.92), (2.10, 0.12, 0.10), "steel"), bevel=0.01)
    for s in (1, -1):
        v.add(rear(v, 1.10, 1.60, 0.07, "taillight", out=0.016, x_off=s * 1.02), bevel=0.01)
        v.add(rear(v, 2.20, 2.50, 0.07, "taillight", out=0.016, x_off=s * 1.02), bevel=0.01)
        v.add(v.cyl((s * 1.00, BOX_Y[1] + 0.03, 1.05), (s * 1.00, BOX_Y[1] + 0.03, 2.65), 0.022, "steel", seg=6))
        v.add(v.box((s * 0.62, BOX_Y[1] + 0.07, 0.50), (0.56, 0.20, 0.04), "steel"))
    v.add(rear(v, 0.70, 0.82, 0.17, "plate", out=0.04))
    # 車頂：水帶架（兩條縱桿）與吸水管
    for s in (1, -1):
        v.add(v.cyl((s * 0.55, 0.0, BOX_Z[1] + 0.10), (s * 0.55, 3.30, BOX_Z[1] + 0.10), 0.07, "steel", seg=8))
        for yy in (0.2, 1.7, 3.1):
            v.add(v.box((s * 0.55, yy, BOX_Z[1] + 0.04), (0.10, 0.06, 0.08), "trim"))

    v.add_cannon()
    for nm, y, s, w in (("wheel_fl", FA, 1, TW_F), ("wheel_fr", FA, -1, TW_F),
                        ("wheel_rl", RA, 1, TW_R), ("wheel_rr", RA, -1, TW_R)):
        v.wheel(nm, (s * (TRACK / 2), y, R), R, w, s)

    meta = dict(wheelbase=WB, track=TRACK, wheelRadius=R, mass=9500,
                seat=(0.55, -3.00, 1.45), paint="#D32F2F",
                notes=("臺灣常見 7 m 級水箱消防車一般外觀（虛構塗裝，不仿特定車款 / 機關）。規格約 7.6 × 2.5 × 3.0 m；"
                       "軸距 4.0、輪距 1.9、輪徑 0.5、各部位尺寸皆為推測。平頭駕駛室 + 水箱 / 裝備箱車身 + 後方捲門。"
                       "cannon 為車頂前段水砲的獨立節點（銀色，不參與 paint 換色）。beacon 為琥珀警示燈、beacon_red / "
                       "beacon_blue 為駕駛室頂紅藍燈列（皆帶 emission，名稱含 beacon，未列入 EMISSIVE_MATERIALS）。"
                       "後輪雙胎以單一寬 0.48 輪表示。外接盒寬含後照鏡。seat = 駕駛座 H 點（左駕）。"))
    views = {"front": ((8.4, -11.2, 3.8), (0, -0.4, 1.35), 35),
             "rear": ((-8.6, 11.0, 3.8), (0, 0.4, 1.35), 35)}
    entry = v.finish(meta, views)
    entry["wheels"].pop("cannon", None)
    out = os.path.join(VL.REPO, "docs", "models", "fire_truck-manifest-entry.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("FT_ENTRY", json.dumps({k: entry[k] for k in ("length", "width", "height", "triangles", "bytes", "seat")}))
    return entry


if __name__ == "__main__":
    build()
