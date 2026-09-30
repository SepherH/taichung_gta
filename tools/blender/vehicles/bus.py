"""市區公車（臺中市區常見 12 m 級低地板大巴一般外觀，不仿任何品牌或特定車款）。

執行：blender -b -P tools/blender/vehicles/bus.py
依據：docs/ref/qiuhonggu-opera-vehicle-reference.md §4.1 / §5
- 尺寸：長 12.19 / 寬 2.50 / 高 3.14 m、軸距 6.10 m——國產 12 m 電巴一例（§4.1，已確認摘要）
- 車型：低地板、前方大面擋風玻璃、上方 LED 路線牌、側面大窗、車頂電池 / 空調艙（§4.1，已確認照片）
- 車門：2 門，前門在前輪之前、中門在兩軸之間約車身中段（§4.1，已確認）；門在右側（−X，右側通行上下客）
- 配色：業者各異（§4.1，已確認）；白底 + 業者色帶（綠 #6CC04A，§4.1 建模建議），stripe 執行期換色
座標：車頭朝 −Y、車輛左側 +X、地面 z=0（置中前座標；finish 以外接盒 XY 中心置中）。
"""
import bmesh
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

L2 = 12.19 / 2       # 半車長（§4.1，已確認摘要）
HW = 2.50 / 2        # 車身半寬（§4.1，已確認摘要）
H_BODY = 3.00        # 車身頂（不含車頂艙；推測，艙頂 = 總高 3.14）
H_TOTAL = 3.14       # 總高（§4.1，已確認摘要）
WB = 6.10            # 軸距（§4.1，已確認摘要）
FO = 2.55            # 前懸（推測；後懸 = 12.19 − 2.55 − 6.10 = 3.54）
R = 0.48             # 輪胎半徑（任務指定；推測）
TW_F = 0.30          # 前輪胎寬（任務指定；推測）
TW_R = 0.40          # 後輪雙胎以單一較寬輪表示（任務指定；推測）
TRACK = 2.05         # 輪距（推測）
FLOOR = 0.30         # 低地板車身底 z（任務指定；推測）
FA = -L2 + FO        # 前軸 y（車頭朝 −Y）
RA = FA + WB         # 後軸 y

FRONT_DOOR = (-5.80, -4.62)   # 前門：前輪之前（§4.1 已確認位置；尺寸估算）
MID_DOOR = (-1.10, 0.12)      # 中門：兩軸之間約車身中段（§4.1 已確認位置；尺寸估算）
WIN_Z = (1.25, 2.60)          # 側窗帶高度（任務指定；估算）
ARCH_CLEAR = 0.60             # 輪拱在 y 方向的半寬（含間隙，給窗帶以下的色帶避讓用；估算）


def taper(z):
    """上半部內收：側面為線性斜面（z=0.30 → 1.0、z=3.00 → 0.968），保持側面為平面。"""
    return 1.0 - (z - FLOOR) * 0.012


def yf(z):
    """前臉略後傾：車頭面 y 隨 z 線性後退（z 0.42 → −6.095、z 2.90 → −5.983；估算）。"""
    return -L2 + (z - 0.42) * 0.045


def yr(z):
    """車尾面：幾乎直立，微後傾（估算）。"""
    return L2 - (z - 0.42) * (0.04 / 2.46)


BODY = [(-L2 + 0.035, FLOOR), (-L2, 0.42), (yf(2.90), 2.90), (-5.93, 2.965), (-5.84, H_BODY),
        (5.88, H_BODY), (5.99, 2.96), (yr(2.88), 2.88), (L2, 0.42), (L2 - 0.035, FLOOR)]


def side_panel(v, s, y0, y1, z0, z1, mat, out=0.012, inn=0.03):
    """貼在側面（依 taper 內收的斜面）上的薄板：外表面離車身 out、往內埋 inn。s=+1 左側 / −1 右側。"""
    bm = v.box((0.0, (y0 + y1) / 2, (z0 + z1) / 2), (1.0, y1 - y0, z1 - z0), mat)
    for vt in bm.verts:
        surf = HW * taper(vt.co.z)
        vt.co.x = s * (surf + (out if vt.co.x > 0 else -inn))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def front_panel(v, z0, z1, half_w, mat, out=0.012, thk=0.05, x_off=0.0, tp=True):
    """貼在後傾車頭面上的薄板（側視沿 yf 斜線）。"""
    pts = [(yf(z0) - out, z0), (yf(z1) - out, z1), (yf(z1) - out + thk, z1), (yf(z0) - out + thk, z0)]
    return v.profile(pts, half_w, mat, taper if tp else None, x_off)


def rear_panel(v, z0, z1, half_w, mat, out=0.012, thk=0.05, x_off=0.0, tp=True):
    pts = [(yr(z0) + out, z0), (yr(z1) + out, z1), (yr(z1) + out - thk, z1), (yr(z0) + out - thk, z0)]
    return v.profile(pts, half_w, mat, taper if tp else None, x_off)


def segs(y0, y1, excl, min_len=0.08):
    """[y0, y1] 扣掉 excl 區間後剩下的段。"""
    out, cur = [], y0
    for a, b in sorted(excl):
        if a > cur and a - cur >= min_len:
            out.append((cur, min(a, y1)))
        cur = max(cur, b)
    if y1 - cur >= min_len:
        out.append((cur, y1))
    return out


def window_band(v, s, y0, y1):
    """一段側窗：glass 大窗 + 黑色窗柱（等距）+ 下緣黑色窗台條。"""
    z0, z1 = WIN_Z
    v.add(side_panel(v, s, y0, y1, z0, z1, "glass", out=0.012))
    v.add(side_panel(v, s, y0, y1, z0 - 0.05, z0, "trim", out=0.016))
    n = max(1, round((y1 - y0) / 1.35))   # 窗距約 1.35 m（估算）
    for k in range(n + 1):
        y = y0 + k * (y1 - y0) / n
        v.add(side_panel(v, s, y - 0.045, y + 0.045, z0 - 0.02, z1 + 0.03, "trim", out=0.02))


def door(v, y0, y1):
    """右側（−X）雙扇玻璃門：trim 門框（在後）+ glass 門片 + 中縫 / 橫檔。"""
    s = -1
    v.add(side_panel(v, s, y0, y1, FLOOR + 0.02, 2.66, "trim", out=0.008))
    v.add(side_panel(v, s, y0 + 0.06, y1 - 0.06, FLOOR + 0.07, 2.60, "glass", out=0.014))
    ym = (y0 + y1) / 2
    v.add(side_panel(v, s, ym - 0.025, ym + 0.025, FLOOR + 0.07, 2.60, "trim", out=0.02))
    for z in (1.02, 1.95):   # 門片橫檔（估算）
        v.add(side_panel(v, s, y0 + 0.06, y1 - 0.06, z, z + 0.05, "trim", out=0.02))


def build():
    v = VL.Vehicle("bus", "市區公車", "#F2F2EE", extra_mats={
        "stripe": dict(color="#6CC04A", roughness=0.35, metallic=0.2),   # 業者色帶（§4.1 建模建議）
        "display": dict(color="#1A1A1A", roughness=0.4, emission="#FFB030", strength=1.5),   # LED 路線牌
    })
    # 主車身：側視輪廓（前臉後傾、車頂前後圓角）+ 上半部內收 + 倒角 0.10 + 輪拱（後輪雙胎挖深一點）
    cutters = (v.arch_cutters([(FA, R)], R, HW, depth=0.44) +
               v.arch_cutters([(RA, R)], R, HW, depth=0.52))
    v.add(v.profile(BODY, HW, "paint", taper), bevel=0.10, segments=3, cutters=cutters)
    # 車頂電池 / 空調艙（後段；§4.1「車頂後段 / 前段有電池或空調艙」，尺寸估算）
    v.add(v.box((0, 2.55, (H_BODY - 0.01 + H_TOTAL) / 2), (2.0, 4.0, H_TOTAL - H_BODY + 0.01), "paint"),
          bevel=0.05, segments=2)

    # ---- 側面：窗帶、車門、下緣色帶
    arches = [(FA - ARCH_CLEAR, FA + ARCH_CLEAR), (RA - ARCH_CLEAR, RA + ARCH_CLEAR)]
    doors = [(FRONT_DOOR[0] - 0.06, FRONT_DOOR[1] + 0.06), (MID_DOOR[0] - 0.06, MID_DOOR[1] + 0.06)]
    window_band(v, 1, -5.85, 5.20)                          # 左側（+X）無門：整排大窗（含駕駛窗）
    for a, b in segs(-5.85, 5.20, doors):                   # 右側（−X）窗帶避開車門
        window_band(v, -1, a, b)
    door(v, *FRONT_DOOR)
    door(v, *MID_DOOR)
    for s in (1, -1):
        for a, b in segs(-5.96, 5.96, arches + (doors if s < 0 else [])):
            v.add(side_panel(v, s, a, b, 0.46, 0.74, "stripe", out=0.008))
        v.add(side_panel(v, s, 4.05, 4.45, 0.62, 0.70, "taillight", out=0.014))   # 側標燈（估算）

    # ---- 車頭：大面擋風玻璃、LED 路線牌、頭燈、保險桿
    v.add(front_panel(v, 0.92, 2.65, 1.17, "trim", out=0.006))          # 擋風玻璃黑框
    v.add(front_panel(v, 0.95, 2.62, 1.13, "glass", out=0.012))         # 擋風玻璃（z 0.95–2.62）
    v.add(front_panel(v, 2.67, 2.92, 1.02, "trim", out=0.006))          # 路線牌外框
    v.add(front_panel(v, 2.70, 2.89, 0.96, "display", out=0.012))       # LED 路線牌（無文字）
    v.add(front_panel(v, 0.82, 0.89, 1.17, "stripe", out=0.006))        # 車頭色帶
    v.add(front_panel(v, 0.60, 0.76, 0.52, "trim", out=0.01))           # 下格柵
    for s in (1, -1):
        v.add(front_panel(v, 0.57, 0.79, 0.19, "headlight", out=0.02, x_off=s * 0.92, tp=False),
              bevel=0.015)                                              # 頭燈（前下角）
    v.add(front_panel(v, FLOOR, 0.50, 1.21, "trim", out=0.03))          # 前保險桿
    v.add(front_panel(v, 0.33, 0.47, 0.17, "plate", out=0.04, tp=False))   # 空白車牌

    # ---- 車尾：小後窗、後路線牌、直立尾燈條、保險桿
    v.add(rear_panel(v, 2.00, 2.67, 0.76, "trim", out=0.006))
    v.add(rear_panel(v, 2.05, 2.62, 0.70, "glass", out=0.012))          # 小後窗
    v.add(rear_panel(v, 2.72, 2.86, 0.30, "display", out=0.012))        # 後路線牌（無文字）
    v.add(rear_panel(v, 0.62, 1.30, 0.70, "trim", out=0.01))            # 後艙蓋格柵
    for s in (1, -1):
        v.add(rear_panel(v, 0.60, 1.90, 0.07, "taillight", out=0.015, x_off=s * 1.08, tp=False),
              bevel=0.015)                                              # 直立尾燈條
    v.add(rear_panel(v, FLOOR, 0.50, 1.21, "trim", out=0.03))           # 後保險桿
    v.add(rear_panel(v, 0.33, 0.47, 0.17, "plate", out=0.04, tp=False))

    # ---- 兔耳式後照鏡：從前上緣伸出往前下垂的臂 + 鏡殼（尺寸估算）
    for s in (1, -1):
        top = (s * 1.02, yf(2.90) + 0.04, 2.92)
        elbow = (s * 1.24, -6.34, 2.80)
        v.add(v.cyl(top, elbow, 0.025, "trim", seg=6))
        v.add(v.cyl(elbow, (s * 1.24, -6.34, 2.18), 0.022, "trim", seg=6))
        v.add(v.box((s * 1.24, -6.34, 1.97), (0.10, 0.08, 0.42), "trim"), bevel=0.02)
        v.add(v.box((s * 1.24, -6.295, 1.97), (0.08, 0.012, 0.36), "chrome"))   # 鏡面朝後

    for nm, y, s, w in (("wheel_fl", FA, 1, TW_F), ("wheel_fr", FA, -1, TW_F),
                        ("wheel_rl", RA, 1, TW_R), ("wheel_rr", RA, -1, TW_R)):
        v.wheel(nm, (s * (TRACK / 2), y, R), R, w, s)

    meta = dict(wheelbase=WB, track=TRACK, wheelRadius=R, mass=12500,
                seat=(0.72, -4.95, 1.35), paint="#F2F2EE",
                notes=("臺中市區 12 m 級低地板公車一般外觀（不仿特定車款）。尺寸依 "
                       "docs/ref/qiuhonggu-opera-vehicle-reference.md §4.1 國產電巴一例（長 12.19 × 寬 2.50 × "
                       "高 3.14、軸距 6.10，已確認摘要）；前懸 2.55、輪距 2.05、輪徑、車身頂 3.00 為推測。"
                       "配色業者各異（§4.1），預設白底 + 綠色帶，stripe 材質可執行期換色；路線牌 display "
                       "材質不含文字。2 門配置（§4.1 已確認，部分業者為 3 門）：門在右側（−X）。後輪雙胎以單一"
                       "寬 0.40 輪表示。外接盒長寬含兔耳後照鏡，略大於規格值。seat = 駕駛座 H 點（左駕）。"))
    views = {"front": ((-12.5, -16.0, 4.2), (0, -0.5, 1.4), 35),
             "rear": ((12.5, 16.0, 4.5), (0, 0.5, 1.4), 35)}
    return v.finish(meta, views)


if __name__ == "__main__":
    build()
