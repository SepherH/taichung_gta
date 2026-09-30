"""休旅車（臺灣街頭常見 C-SUV 的一般外觀，不仿任何品牌或特定車款）。

執行：blender -b -P tools/blender/vehicles/suv.py
尺寸：長 4.60 / 寬 1.85（不含後照鏡）/ 高 1.68 m（含車頂架）、軸距 2.69 m、輪距 1.58 m、輪胎半徑 0.36 m、
      胎寬 0.225 m、前懸 0.92 m、離地約 0.20 m、1650 kg——一般 C-SUV 級距值（依據：外包任務單 p2-veh-suv
      「規格」一節；可信度：推測，非特定車款）。docs/ref/qiuhonggu-opera-vehicle-reference.md §4.2 只提到
      計程車有「小型休旅」，未給 SUV 尺寸，故本檔尺寸全數為推測 / 估算。
造型：高腰線（約 1.05 m）、短而高的引擎蓋、斜擋風、近水平車頂、近乎垂直的尾門；黑色塑膠輪拱飾條與下護板、
      車頂縱向行李架（依據：任務單「造型」一節；可信度：推測，一般 SUV 外觀共通特徵）。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

L2 = 4.60 / 2        # 半車長（任務單：全長 4.60；推測）
HW = 0.90            # 車身鈑件半寬；輪拱飾條外緣到 0.925 → 全寬 1.85（任務單：全寬 1.85；推測）
CLAD = 0.925         # 輪拱飾條 / 下護板外緣半寬（= 全寬 1.85 / 2；推測）
WB = 2.69            # 軸距（任務單；推測）
FO = 0.92            # 前懸（任務單；推測）→ 後懸 = 4.60 − 0.92 − 2.69 = 0.99
R = 0.36             # 輪胎半徑（任務單；推測，約 225/60R18 級距）
TW = 0.225           # 胎寬（任務單；推測）
TRACK = 1.58         # 輪距（任務單；推測）
FA = -L2 + FO        # 前軸 y（車頭朝 −Y）
RA = FA + WB         # 後軸 y
FLOOR = 0.22         # 車身下緣 z（任務單：離地約 0.20，底盤最低點再低一點；估算）
WAIST = 1.05         # 腰線（任務單：約 1.05；推測）
ARCH_R = R + 0.045   # 輪拱挖刀半徑（vehicle_lib.arch_cutters 預設 clear 0.045）

# 下車身側視輪廓 (y, z)：前保險桿 → 短而高的引擎蓋 → 高腰線 → 近垂直尾門下半 → 後保險桿（造型依任務單；座標估算）
LOWER = [(-L2 + 0.08, FLOOR), (-L2, 0.36), (-L2 + 0.005, 0.66), (-L2 + 0.10, 0.90),   # 車頭：較直立的鼻面
         (-1.55, 0.98), (-1.00, 1.03),                                                  # 短而高的引擎蓋
         (0.50, WAIST + 0.005), (1.90, WAIST + 0.025), (L2 - 0.03, WAIST + 0.02),        # 腰線微微上揚
         (L2, 0.82), (L2 - 0.005, 0.40), (L2 - 0.10, FLOOR)]                           # 近垂直尾門下半 + 後保險桿
# 車艙側視輪廓：斜擋風 → 近水平車頂延伸到後方 → 近垂直後窗（約 15° 後傾；估算）
CABIN = [(-1.02, 0.98), (-1.00, 1.04), (-0.25, 1.605), (1.00, 1.62), (2.12, 1.61), (2.26, 1.08), (2.26, 0.98)]
CAB_HW = 0.80        # 車艙底部半寬（估算）
ROOF_Z = 1.62        # 車頂高（估算；加行李架 → 1.68）


def cab_taper(z):    # 車艙上半內收（tumblehome；估算）
    return 1.0 - max(z - WAIST, 0) * 0.40


def cab_x(z):        # 車艙側面在高度 z 的半寬
    return CAB_HW * cab_taper(z)


def pillar(v, y, w, s, z0=1.08, z1=1.59):
    """貼著內收車艙側面的車身色柱（B / C / D 柱）：頂點沿車艙斜面剪切，不做鏡射以免翻法線。"""
    bm = v.box((0, y, (z0 + z1) / 2), (0.024, w, z1 - z0), "paint")
    for vt in bm.verts:
        vt.co.x += s * cab_x(vt.co.z)
    return bm


def flare(v, y, s, r_in=ARCH_R, r_out=ARCH_R + 0.065, seg=14):
    """黑色塑膠輪拱飾條：輪心周圍的弧形帶（−15°～195°），擠出在車側外緣（SUV 辨識點；估算）。"""
    a0, a1 = math.radians(-15), math.radians(195)
    ts = [a0 + (a1 - a0) * i / seg for i in range(seg + 1)]
    pts = [(y + r_out * math.cos(t), R + r_out * math.sin(t)) for t in ts]
    pts += [(y + r_in * math.cos(t), R + r_in * math.sin(t)) for t in reversed(ts)]
    hw = (CLAD - 0.86) / 2
    return v.profile(pts, hw, "trim", x_off=s * (0.86 + hw))


def build(slug="suv", name="休旅車", paint="#5A6470"):
    v = VL.Vehicle(slug, name, paint)
    taper = lambda z: 1.0 if z < 0.60 else 1.0 - (z - 0.60) * 0.12   # 下車身上半內收（估算）
    v.add(v.profile(LOWER, HW, "paint", taper), bevel=0.06, segments=3,
          cutters=v.arch_cutters([(FA, R), (RA, R)], R, HW))
    v.add(v.profile(CABIN, CAB_HW, "paint", cab_taper), bevel=0.05, segments=3, glass_sides=0.93)
    for s in (1, -1):
        # B 柱（前後門之間）、C 柱（後門後緣）、D 柱（尾門旁，車身色較寬）（位置估算）
        v.add(pillar(v, -0.05, 0.09, s), bevel=0.008, segments=1)
        v.add(pillar(v, 1.30, 0.10, s), bevel=0.008, segments=1)
        v.add(pillar(v, 2.03, 0.14, s), bevel=0.008, segments=1)
        # 窗框下緣黑色飾條（沿腰線）
        v.add(v.box((s * 0.815, 0.57, WAIST + 0.035), (0.03, 3.05, 0.025), "trim"))
        # 後照鏡：支架 + 鏡殼（車身色）
        v.add(v.box((s * 0.86, -0.92, 1.10), (0.16, 0.05, 0.05), "trim"))
        v.add(v.box((s * 0.97, -0.93, 1.14), (0.10, 0.08, 0.13), "paint"), bevel=0.02)
        # 門把（前門、後門）
        for y in (-0.40, 0.62):
            v.add(v.box((s * 0.865, y, 0.97), (0.03, 0.15, 0.03), "chrome"))
        # 黑色塑膠輪拱飾條 + 兩輪間下護板（側裙）
        for y in (FA, RA):
            v.add(flare(v, y, s), bevel=0.01, segments=1)
        rock = WB - 2 * (ARCH_R + 0.065) + 0.02
        v.add(v.box((s * (CLAD - 0.03), (FA + RA) / 2, 0.31), (0.06, rock, 0.18), "trim"), bevel=0.02)
        # 頭燈：細長、在鼻面上緣；尾燈：尾門兩側
        v.add(v.box((s * 0.58, -L2 + 0.09, 0.84), (0.40, 0.12, 0.07), "headlight"), bevel=0.02)
        v.add(v.box((s * 0.70, L2 - 0.04, 0.95), (0.30, 0.10, 0.12), "taillight"), bevel=0.03)
        # 車頂縱向行李架：兩端支腳（trim）+ 橫桿（chrome）；頂端 z = 1.68（任務單：全高含車頂架）
        for y in (-0.12, 1.95):
            v.add(v.box((s * 0.52, y, ROOF_Z + 0.02), (0.04, 0.10, 0.05), "trim"), bevel=0.01)
        v.add(v.box((s * 0.52, 0.915, ROOF_Z + 0.045), (0.035, 2.17, 0.03), "chrome"), bevel=0.01)
    # 大型水箱護罩（trim）、前後保險桿下緣黑色下護板 + 銀色護板、車牌（空白）
    v.add(v.box((0, -L2 + 0.02, 0.65), (0.84, 0.06, 0.26), "trim"), bevel=0.02)
    v.add(v.box((0, -L2 + 0.07, 0.30), (1.72, 0.16, 0.16), "trim"), bevel=0.03)
    v.add(v.box((0, L2 - 0.07, 0.30), (1.72, 0.16, 0.16), "trim"), bevel=0.03)
    v.add(v.box((0, -L2 + 0.025, 0.27), (0.80, 0.04, 0.06), "chrome"), bevel=0.01)
    v.add(v.box((0, L2 - 0.025, 0.27), (0.80, 0.04, 0.06), "chrome"), bevel=0.01)
    v.add(v.box((0, -L2 - 0.005, 0.45), (0.34, 0.02, 0.12), "plate"))
    v.add(v.box((0, L2 + 0.005, 0.62), (0.34, 0.02, 0.12), "plate"))
    for nm, y, s in (("wheel_fl", FA, 1), ("wheel_fr", FA, -1), ("wheel_rl", RA, 1), ("wheel_rr", RA, -1)):
        v.wheel(nm, (s * (TRACK / 2), y, R), R, TW, s)
    meta = dict(wheelbase=WB, track=TRACK, wheelRadius=R, mass=1650,
                seat=(0.38, 0.10, 0.72), paint=paint,   # seat：任務單給定約值（推測）
                notes=("臺灣街頭常見 C-SUV 的一般外觀；長寬高、軸距、輪距、輪胎、懸長、離地、質量皆為一般 C-SUV "
                       "級距值（推測，非特定車款）。seat = 駕駛座 H 點（左駕，角色 drive 動作的 Hips 關節位置）。"
                       "黑色塑膠輪拱飾條 / 下護板、車頂行李架、近垂直尾門為一般 SUV 外觀特徵（推測）。"))
    views = {"front": ((5.2, -6.9, 2.3), (0, 0, 0.75), 40), "rear": ((-5.4, 6.5, 2.5), (0, 0, 0.75), 40)}
    return v.finish(meta, views)


if __name__ == "__main__":
    build()
