"""機車（臺灣常見 125 cc 腳踏板式速克達的一般外觀，不仿任何品牌或特定車款）。

執行：blender -b -P tools/blender/vehicles/scooter.py
尺寸依據：docs/ref/qiuhonggu-opera-vehicle-reference.md §4.3「建模建議」
  全長 1.85 / 全寬 0.70（含把手、後照鏡）/ 全高 1.10（含後照鏡）、軸距 1.28、輪外徑 0.44、胎寬 0.10
  ——官方規格區間已確認（GP 125、Dollar 125 等），此組建模值為中位數估算。
各零件的位置 / 造型尺寸（前擋板、坐墊、車殼、把手護蓋…）：依一般速克達外觀比例估算（推測），
§4.3 只給外廓，細部查無。
座標：車頭朝 −Y、左側 +X；前輪心 y = FA、後輪心 y = RA，finish 會以外接盒中心自動置中。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

WB = 1.28            # 軸距（§4.3 建模建議；估算）
R = 0.22             # 輪胎半徑 = 外徑 0.44 / 2（§4.3；估算，100/90-10 ≈ 0.43、110/70-12 ≈ 0.46）
TW = 0.10            # 胎寬（§4.3 100/90-10 的 100 mm；已確認為常見規格）
FA = -WB / 2         # 前輪心 y
RA = WB / 2          # 後輪心 y
# 全長 1.85（§4.3）：前端 = 前輪前緣 FA − R = −0.86，後端 = 車牌 / 尾燈 ≈ +0.99（後懸 0.35，估算）
HW_REAR = 0.19       # 後車殼半寬（估算）
SEAT_TOP = 0.79      # 坐墊頂面約 z 0.78–0.79（任務規格；估算）

# 前擋板（腳踏板前緣往上往前彎到把手下方；側視 y, z；估算）
SHIELD = [(-0.30, 0.28), (-0.34, 0.46), (-0.40, 0.64), (-0.46, 0.80), (-0.50, 0.90), (-0.56, 0.93),
          (-0.62, 0.86), (-0.64, 0.74), (-0.62, 0.60), (-0.55, 0.47), (-0.44, 0.37), (-0.40, 0.28)]
# 腳踏板下方車體（踏板頂 z 0.31，加防滑墊到 0.335；任務規格 z ≈ 0.28–0.34）
FLOOR = [(-0.38, 0.20), (-0.30, 0.17), (0.10, 0.17), (0.18, 0.22), (0.18, 0.31), (-0.38, 0.31)]
# 坐墊下方後車殼（往後收尖到尾燈，下緣挖後輪拱；估算）
REAR = [(0.10, 0.31), (0.03, 0.50), (-0.02, 0.70), (0.10, 0.725), (0.50, 0.725), (0.80, 0.705),
        (0.93, 0.665), (0.965, 0.625), (0.955, 0.56), (0.88, 0.50), (0.74, 0.40), (0.50, 0.34),
        (0.34, 0.26), (0.20, 0.22), (0.14, 0.24)]
# 坐墊（前段騎士、後段略高的乘客位；頂面約 0.78–0.79；估算）
SEAT = [(-0.06, 0.70), (-0.04, 0.75), (0.05, 0.775), (0.30, 0.78), (0.55, SEAT_TOP), (0.72, 0.782),
        (0.80, 0.745), (0.80, 0.70)]
# 把手護蓋（頭燈所在；頂 z ≈ 1.03；估算）
COVER = [(-0.66, 0.93), (-0.68, 0.98), (-0.62, 1.03), (-0.46, 1.02), (-0.40, 0.97), (-0.46, 0.92)]
HEADLIGHT = [(-0.672, 0.962), (-0.70, 0.965), (-0.705, 0.99), (-0.685, 1.012), (-0.67, 1.0)]
TAILLIGHT = [(0.90, 0.63), (0.955, 0.585), (0.99, 0.60), (0.985, 0.64), (0.93, 0.685)]
PLATE_HOLDER = [(0.86, 0.53), (0.92, 0.54), (0.975, 0.48), (0.975, 0.36), (0.955, 0.36), (0.90, 0.47)]
ENGINE = [(0.18, 0.20), (0.22, 0.33), (0.40, 0.36), (0.62, 0.30), (0.70, 0.22), (0.64, 0.14), (0.30, 0.12)]


def xscale(bm, f):
    """俯視收形：頂點 x 乘上 f(y)（profile 的 taper 只能依 z，這裡補依 y 的收尖）。"""
    for vt in bm.verts:
        vt.co.x *= f(vt.co.y)
    return bm


def arc_band(cy, cz, r0, r1, a0, a1, direction, n=9):
    """輪子上方的弧形土除側視輪廓：a = 0 指向 direction（−1 = 前方 −Y），90° 朝上。"""
    ang = [math.radians(a0 + (a1 - a0) * i / (n - 1)) for i in range(n)]
    outer = [(cy + direction * r1 * math.cos(a), cz + r1 * math.sin(a)) for a in ang]
    inner = [(cy + direction * r0 * math.cos(a), cz + r0 * math.sin(a)) for a in reversed(ang)]
    return outer + inner


def build(slug="scooter", name="機車（速克達）", paint="#D23A2E"):
    v = VL.Vehicle(slug, name, paint, extra_mats={"seat": dict(color="#1C1C1C", roughness=0.8)})

    # ---- 前擋板（paint）：上半部內收
    v.add(v.profile(SHIELD, 0.22, "paint", lambda z: 1.0 - max(z - 0.45, 0) * 0.55), bevel=0.04, segments=3)
    # ---- 腳踏板車體 + 防滑墊（trim）
    v.add(v.profile(FLOOR, 0.16, "paint"), bevel=0.04, segments=3)
    v.add(v.box((0, -0.10, 0.32), (0.30, 0.50, 0.03), "trim"), bevel=0.01)
    # ---- 後車殼（paint）：前段膝部收窄、尾段收尖；後輪拱從兩側挖穿
    rear_f = lambda y: (0.75 + 0.25 * min(max((y - 0.10) / 0.20, 0), 1)) if y < 0.30 else \
        1.0 - 0.45 * min(max((y - 0.55) / 0.44, 0), 1)
    v.add(xscale(v.profile(REAR, HW_REAR, "paint", lambda z: 1.0 - max(z - 0.55, 0) * 0.5), rear_f),
          bevel=0.04, segments=3, cutters=v.arch_cutters([(RA, R)], R, HW_REAR, depth=0.34))
    # ---- 坐墊（seat）
    seat_f = lambda y: 0.65 + 0.35 * min(max((y + 0.06) / 0.35, 0), 1)
    v.add(xscale(v.profile(SEAT, 0.155, "seat", lambda z: 1.0 - max(z - 0.74, 0) * 3.0), seat_f),
          bevel=0.03, segments=3)
    # ---- 把手護蓋（paint）+ 頭燈（headlight，在護蓋正面）+ 儀表（glass）
    v.add(v.profile(COVER, 0.20, "paint", lambda z: 1.0 - max(z - 0.95, 0) * 1.5), bevel=0.03, segments=3)
    v.add(v.profile(HEADLIGHT, 0.075, "headlight"), bevel=0.008)
    v.add(v.box((0, -0.49, 1.03), (0.14, 0.06, 0.012), "glass"), bevel=0.004)
    # ---- 把手橫桿 + 握把（trim）、煞車拉桿（chrome）、後照鏡（細桿 + 鏡殼 + 鏡面，最高點 z 1.10）
    v.add(v.cyl((-0.20, -0.56, 1.00), (0.20, -0.56, 1.00), 0.012, "trim", seg=8))
    for s in (1, -1):
        v.add(v.cyl((s * 0.19, -0.56, 1.00), (s * 0.33, -0.56, 1.00), 0.018, "trim", seg=10))
        v.add(v.cyl((s * 0.20, -0.585, 1.005), (s * 0.31, -0.60, 1.0), 0.007, "chrome", seg=6))
        v.add(v.cyl((s * 0.17, -0.52, 1.02), (s * 0.29, -0.512, 1.055), 0.008, "trim", seg=6))
        v.add(v.cyl((s * 0.305, -0.527, 1.055), (s * 0.305, -0.50, 1.055), 0.045, "trim", seg=12))
        v.add(v.cyl((s * 0.305, -0.50, 1.055), (s * 0.305, -0.496, 1.055), 0.038, "chrome", seg=12))
        # ---- 前叉：兩根細管（上段 chrome、下段較粗的叉管 trim）從擋板內到前輪心兩側
        top, hub = (s * 0.075, -0.50, 0.66), (s * 0.075, FA, R)
        mid = (s * 0.075, FA + (top[1] - FA) * 0.42, R + (top[2] - R) * 0.42)
        v.add(v.cyl(top, mid, 0.018, "chrome", seg=10))
        v.add(v.cyl(mid, hub, 0.026, "trim", seg=10))
    v.add(v.cyl((-0.085, FA, R), (0.085, FA, R), 0.012, "chrome", seg=8))   # 前輪軸
    # ---- 前土除（paint，蓋在前輪上方）
    v.add(v.profile(arc_band(FA, R, 0.245, 0.27, 40, 120, -1), 0.065, "paint"), bevel=0.01)
    # ---- 後土除（trim，拱內）+ 車牌架（trim）+ 空白車牌（plate）
    v.add(v.profile(arc_band(RA, R, 0.235, 0.25, 20, 130, 1), 0.06, "trim"), bevel=0.008)
    v.add(v.profile(PLATE_HOLDER, 0.11, "trim"), bevel=0.01)
    v.add(v.box((0, 0.982, 0.42), (0.20, 0.012, 0.11), "plate"), bevel=0.004)
    # ---- 尾燈（taillight，車尾收尖處）
    v.add(v.profile(TAILLIGHT, 0.085, "taillight"), bevel=0.012)
    # ---- 後扶手（trim）：兩側管 + 後橫管 + 支腳
    rr, z = 0.014, 0.745
    for s in (1, -1):
        v.add(v.cyl((s * 0.175, 0.45, z), (s * 0.165, 0.80, z + 0.01), rr, "trim", seg=8))
        v.add(v.cyl((s * 0.165, 0.80, z + 0.01), (s * 0.09, 0.88, z), rr, "trim", seg=8))
        v.add(v.cyl((s * 0.172, 0.52, z), (s * 0.165, 0.52, 0.69), 0.012, "trim", seg=6))
    v.add(v.cyl((0.09, 0.88, z), (-0.09, 0.88, z), rr, "trim", seg=8))
    # ---- 引擎 / 傳動箱（trim，左側 +X）+ 後避震（chrome）
    v.add(v.profile(ENGINE, 0.04, "trim", x_off=0.11), bevel=0.02)
    v.add(v.cyl((0.12, 0.66, 0.24), (0.13, 0.56, 0.54), 0.022, "chrome", seg=8))
    # ---- 排氣管（chrome，右側 −X）：前段排氣彎管 + 消音器錐筒 + 尾端蓋
    v.add(v.cyl((-0.04, 0.22, 0.16), (-0.13, 0.40, 0.24), 0.02, "chrome", seg=8))
    v.add(v.cyl((-0.13, 0.40, 0.24), (-0.145, 0.86, 0.36), 0.045, "chrome", seg=12, r1=0.055))
    v.add(v.cyl((-0.145, 0.86, 0.36), (-0.147, 0.885, 0.366), 0.03, "trim", seg=10))
    # ---- 車輪：前輪輪框外側朝 +X、後輪朝 −X（左側被引擎箱擋住）
    v.wheel("wheel_f", (0, FA, R), R, TW, 1)
    v.wheel("wheel_r", (0, RA, R), R, TW, -1)

    meta = dict(wheelbase=WB, track=0, wheelRadius=R, mass=120,
                seat=(0, 0.25, 0.80), paint=paint,
                notes=("臺灣常見 125 cc 腳踏板式速克達的一般外觀（不仿品牌 / 車款）。尺寸依 "
                       "docs/ref/qiuhonggu-opera-vehicle-reference.md §4.3（官方規格區間已確認、建模值 "
                       "1.85×0.70×1.10、軸距 1.28、輪外徑 0.44 為估算）；前擋板、坐墊、車殼等細部比例為推測。"
                       "mass 120 kg 為估算。騎乘沿用角色 drive 動作（Hips 關節在 seat 點）。"))
    views = {"front": ((2.4, -3.2, 1.3), (0, 0, 0.55), 45), "rear": ((-2.4, 3.3, 1.4), (0, 0, 0.55), 45)}
    return v.finish(meta, views)


if __name__ == "__main__":
    build()
