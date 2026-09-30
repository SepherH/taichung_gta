"""轎車 / 計程車（臺灣街頭常見的緊湊型四門轎車一般外觀，不仿任何品牌或特定車款）。

執行：blender -b -P tools/blender/vehicles/sedan.py   （同時產出 sedan.glb 與 taxi.glb）
尺寸：長 4.63 / 寬 1.78 / 高 1.44 m、軸距 2.70 m、輪距 1.54 m、輪徑 0.63 m（205/55R16）——
      臺灣常見 C 段轎車的一般規格值（推測，非特定車款）。
計程車：docs/ref/qiuhonggu-opera-vehicle-reference.md §4（法規色卡純黃約 #F5C400、車頂燈一盞、不得紅色）。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

L2 = 4.63 / 2
HW = 0.89            # 車身半寬
WB = 2.70            # 軸距
FO = 0.93            # 前懸
R = 0.315            # 輪胎半徑
TW = 0.205           # 胎寬
TRACK = 1.54
FA = -L2 + FO        # 前軸 y（車頭朝 −Y）
RA = FA + WB

LOWER = [(-L2 + 0.05, 0.17), (-L2, 0.30), (-L2 + 0.01, 0.55), (-L2 + 0.13, 0.71), (-1.15, 0.84),
         (1.30, 0.89), (1.95, 0.91), (L2 - 0.04, 0.87), (L2, 0.62), (L2 - 0.01, 0.30), (L2 - 0.07, 0.17)]
CABIN = [(-1.12, 0.80), (-1.10, 0.86), (-0.28, 1.40), (0.62, 1.425), (1.42, 0.92), (1.44, 0.84)]


def build(slug="sedan", name="轎車", paint="#B8BEC6", taxi=False):
    v = VL.Vehicle(slug, name, paint, extra_mats={"taxisign": dict(color="#F5C400", roughness=0.3,
                                                                    emission="#FFD84A", strength=0.8)} if taxi else None)
    taper = lambda z: 1.0 if z < 0.55 else 1.0 - (z - 0.55) * 0.12
    v.add(v.profile(LOWER, HW, "paint", taper), bevel=0.06, segments=3,
          cutters=v.arch_cutters([(FA, R), (RA, R)], R, HW))
    ctaper = lambda z: 1.0 - max(z - 0.86, 0) * 0.42
    v.add(v.profile(CABIN, 0.76, "paint", ctaper), bevel=0.05, segments=3, glass_sides=0.93)
    # B 柱（車身色細條）與窗框下緣飾條
    for s in (1, -1):
        v.add(v.box((s * 0.70, 0.20, 1.10), (0.03, 0.09, 0.42), "paint"), bevel=0.01)
        v.add(v.box((s * 0.80, 0.15, 0.875), (0.03, 2.4, 0.025), "chrome"))
        # 後照鏡：支架 + 鏡殼
        v.add(v.box((s * 0.84, -0.98, 0.92), (0.16, 0.05, 0.05), "trim"))
        v.add(v.box((s * 0.95, -0.99, 0.96), (0.09, 0.07, 0.11), "paint"), bevel=0.02)
        # 門把、側裙
        for y in (-0.55, 0.45):
            v.add(v.box((s * 0.875, y, 0.80), (0.03, 0.14, 0.03), "chrome"))
        v.add(v.box((s * 0.86, (FA + RA) / 2, 0.21), (0.05, WB - 2 * R - 0.12, 0.08), "trim"))
        # 頭燈（前角）、尾燈（後角）
        v.add(v.box((s * 0.62, -L2 + 0.06, 0.66), (0.34, 0.14, 0.10), "headlight"), bevel=0.03)
        v.add(v.box((s * 0.66, L2 - 0.05, 0.74), (0.30, 0.12, 0.10), "taillight"), bevel=0.03)
    # 水箱護罩、前後保險桿下緣、車牌（空白）
    v.add(v.box((0, -L2 + 0.02, 0.60), (0.70, 0.06, 0.12), "trim"), bevel=0.02)
    v.add(v.box((0, -L2 + 0.05, 0.28), (1.50, 0.10, 0.14), "trim"), bevel=0.03)
    v.add(v.box((0, L2 - 0.05, 0.28), (1.50, 0.10, 0.14), "trim"), bevel=0.03)
    v.add(v.box((0, -L2 - 0.005, 0.42), (0.34, 0.02, 0.12), "plate"))
    v.add(v.box((0, L2 + 0.005, 0.50), (0.34, 0.02, 0.12), "plate"))
    if taxi:   # 車頂燈箱：§4.2 法規＝車頂前半部、一盞、不得紅色；黃色梯形楔狀，約 0.40 × 0.12 × 0.12（估算）
        v.add(v.box((0, -0.02, 1.43), (0.30, 0.10, 0.03), "trim"), bevel=0.008)
        v.add(v.profile([(-0.10, 1.44), (0.06, 1.44), (0.03, 1.58), (-0.07, 1.58)], 0.21, "taxisign"),
              bevel=0.015)
    for nm, y, s in (("wheel_fl", FA, 1), ("wheel_fr", FA, -1), ("wheel_rl", RA, 1), ("wheel_rr", RA, -1)):
        v.wheel(nm, (s * (TRACK / 2), y, R), R, TW, s)
    meta = dict(wheelbase=WB, track=TRACK, wheelRadius=R, mass=1350 if taxi else 1300,
                seat=(0.37, 0.15, 0.52), paint=paint,
                notes=("臺灣常見 C 段四門轎車的一般外觀與規格值（推測，非特定車款）。seat = 駕駛座 H 點（左駕，"
                       "角色 drive 動作的 Hips 關節位置）。" + ("計程車：法規色卡純黃、車頂燈箱一盞（查證檔 "
                       "docs/ref/qiuhonggu-opera-vehicle-reference.md §4）；燈箱不放文字，材質 taxisign 帶 emission。"
                       if taxi else "")))
    views = {"front": ((4.6, -6.2, 2.0), (0, 0, 0.6), 40), "rear": ((-4.8, 5.8, 2.2), (0, 0, 0.6), 40)}
    return v.finish(meta, views)


def build_all():
    return [build(), build("taxi", "計程車", "#F5C400", taxi=True)]


if __name__ == "__main__":
    build_all()
