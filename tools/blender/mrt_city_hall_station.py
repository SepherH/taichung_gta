"""捷運綠線市政府站高架站體（OSM way 862750722）。

執行：blender -b -P tools/blender/mrt_city_hall_station.py
依據：docs/ref/civic-center-reference.md §3「捷運市政府站」、建模摘要表。
OSM 輪廓是約 125 × 28 m 的矩形，長軸沿 a 軸（31°，沿文心路），站體跨在文心路正上方。
造型：懸空方盒站體（底面約 9 m、屋頂約 24 m），立面灰色金屬水平百葉（深色內殼 + 外凸橫條），
平屋頂 + 長條天窗；月台層兩側一條玻璃帶。站體下沿中心線 4 支單柱 + 帽梁（推測）；
兩端半圓拱形全罩式隔音罩 + 肋條各外延 25 m（示意），延伸段下方 1 支墩柱 + 高架軌道梁。
所有幾何都在七期斜格網 (b, a) 座標下建，原點中線 b = 0 即文心路中央分隔島。
"""
import math
import os
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 862750722
SLUG = "mrt_city_hall_station"
NAME = "捷運市政府站"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H = 24.0               # 屋頂高。§3「屋頂約 22–25 m」取 24（依 4 層 × 約 5.5 m）。估算
Z_BOT = 9.0            # 站體底面離路面。§3「約 8–10 m」取 9。估算
Z_ROOF = 23.5          # 金屬立面頂 = 屋頂板底；屋頂板 0.5 m 厚到 H。推測
ROOF_OVER = 0.25       # 屋頂板外挑（壓頂線）。推測
CORE_INSET = 0.3       # 百葉後方深色內殼內縮量（做出水平線條陰影）。推測
LOUVER_STEP = 0.5      # 水平百葉間距。§3「灰色金屬水平百葉 / 金屬板」已確認；間距推測
LOUVER_H = 0.14        # 單條百葉厚。推測
GLASS_Z = (12.0, 14.5) # 月台層兩側玻璃帶高度範圍（3F 月台）。§3 樓層已確認；玻璃帶本身推測
GLASS_END = 3.0        # 玻璃帶距站體兩端退縮。推測
SKY_B = (-9.0, -3.0, 3.0, 9.0)   # 屋頂長條天窗中心線 b 座標（4 條，沿長軸）。§3「數條長條形天窗」已確認；條數 / 位置推測
SKY_W = 1.8            # 天窗寬。推測
SKY_END = 10.0         # 天窗距站體兩端退縮。推測
SKY_H = 0.5            # 天窗凸出屋頂高。推測

PIER_A = (-46.5, -15.5, 15.5, 46.5)   # 站體下 4 支單柱沿長軸位置（間距 31 m）。§3「站體正下方墩柱數量與位置查無」→ 推測
PIER_R = 1.25          # 墩柱半徑。§3「單柱混凝土墩」已確認（站體外）；尺寸推測
CAP_B = 11.0           # 站體下帽梁半長（沿 b，托住 28 m 寬站體）。推測
CAP_A = 2.4            # 帽梁寬（沿 a）。推測
CAP_D = 1.8            # 帽梁深（頂面貼站體底面）。推測

EXT = 25.0             # 兩端隔音罩 / 軌道梁外延長度。任務指定（只做示意段）
GIRDER_B = 5.5         # 高架軌道梁半寬（雙線）。推測
GIRDER_D = 1.8         # 軌道梁深，底面與站體底面齊 → 梁頂 = 軌面。推測
EXT_PIER_A = 16.0      # 延伸段墩柱距站體端部。推測
EXT_CAP_B = 4.5        # 延伸段帽梁半長。推測
TUBE_R = 5.4           # 隔音罩半圓內半徑（雙線全罩）。§3「半圓拱形全罩式」已確認；尺寸推測
TUBE_T = 0.1           # 隔音罩面板厚。推測
TUBE_SEG = 16          # 半圓分段數
RIB_STEP = 2.5         # 肋條間距。§3「綠色半透明面板 + 肋條」已確認；間距推測
RIB_W = 0.3            # 肋條寬（沿 a）。推測
RIB_D = 0.35           # 肋條外凸深。推測
RIB_SEG = 12

SIGN_W, SIGN_H, SIGN_Z = 14.0, 2.8, 19.0   # 長立面招牌（玻璃帶之上）。任務指定兩側各一；尺寸 / 高度推測

C_METAL = "#9EA3A8"    # 金屬立面 §3（估算，3D 目視取色）
C_CORE = "#6F7479"     # 百葉後方深色內殼（陰影層）。推測
C_ROOF = "#CFD1D2"     # 屋頂 §3（估算）
C_GLASS = "#4C6470"    # 玻璃帶 / 天窗。推測
C_TUBE = "#8CC5B4"     # 隔音罩 §3「半透明綠」（估算；L.mat 無透明度，做不透明）
C_CONCRETE = "#BFBDB8" # 墩柱 / 帽梁 / 軌道梁 §3（估算）
C_PORTAL = "#2A2D30"   # 站體端部軌道開口（隔音罩內看進去的暗部）。推測
C_SIGN = "#F2F2EE"     # 招牌底板。推測


def V(b, a, z):
    x, y = L.ab(b, a)
    return (x, y, z)


def _half_ring(bm, a0, a1, r_in, r_out, z0, seg, bc=0.0):
    """沿 a 軸、a0..a1 之間的半圓環實體（截面為 r_in..r_out 的環帶，θ 0..π），封閉。"""
    rows = []
    for i in range(seg + 1):
        t = math.pi * i / seg
        c, s = math.cos(t), math.sin(t)
        rows.append([bm.verts.new(V(bc + r * c, a, z0 + r * s))
                     for r, a in ((r_in, a0), (r_out, a0), (r_out, a1), (r_in, a1))])
    for i in range(seg):
        p, q = rows[i], rows[i + 1]
        for k in range(4):
            m = (k + 1) % 4
            bm.faces.new((p[k], p[m], q[m], q[k]))
    bm.faces.new(rows[0])
    bm.faces.new(list(reversed(rows[-1])))


def _half_disc(bm, a, r, z0, seg, bc=0.0):
    vs = [bm.verts.new(V(bc + r * math.cos(math.pi * i / seg), a, z0 + r * math.sin(math.pi * i / seg)))
          for i in range(seg + 1)]
    return bm.faces.new(vs)


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    abs_ = [L.to_ab(x, y) for x, y in fp]
    B0, B1 = min(p[0] for p in abs_), max(p[0] for p in abs_)
    A0, A1 = min(p[1] for p in abs_), max(p[1] for p in abs_)
    bc, ac = (B0 + B1) / 2, (A0 + A1) / 2   # 輪廓中線（≈ 0，文心路中央分隔島）

    m_metal = L.mat("station_metal_louver", C_METAL, metallic=0.6, roughness=0.45)
    m_core = L.mat("station_metal_core", C_CORE, metallic=0.4, roughness=0.6)
    m_roof = L.mat("station_roof", C_ROOF, roughness=0.7)
    m_glass = L.mat("station_glass", C_GLASS, metallic=0.3, roughness=0.08,
                    emission="#FFE9C4", strength=0.08)
    m_tube = L.mat("noise_barrier_green_panel", C_TUBE, metallic=0.1, roughness=0.15)
    m_conc = L.mat("viaduct_concrete", C_CONCRETE, roughness=0.85)
    m_portal = L.mat("track_portal_dark", C_PORTAL, roughness=0.9)
    m_sign = L.mat("station_sign_panel", C_SIGN, roughness=0.5)

    # ---- body：懸空方盒 = 深色內殼 + 水平金屬百葉 + 月台層玻璃帶 --------------------
    L.prism(ctx, "body", "body_metal_core", L.offset(fp, -CORE_INSET), Z_BOT, Z_ROOF, m_core, bottom=True)
    L.band(ctx, "body", "body_bottom_fascia", fp, Z_BOT, 0.6, 0.0, m_metal)
    z = Z_BOT + 0.6 + LOUVER_STEP - LOUVER_H
    i = 0
    while z + LOUVER_H <= Z_ROOF - 0.1:
        if not (GLASS_Z[0] - 0.2 < z + LOUVER_H and z < GLASS_Z[1] + 0.2):
            L.band(ctx, "body", f"body_louver_{i:02d}", fp, z, LOUVER_H, 0.0, m_metal)
            i += 1
        z += LOUVER_STEP
    L.box_ab(ctx, "body", "platform_glass_band", B0 + 0.1, B1 - 0.1, A0 + GLASS_END, A1 - GLASS_END,
             GLASS_Z[0], GLASS_Z[1], m_glass)

    # ---- roof：平屋頂板 + 長條天窗 ------------------------------------------------
    L.prism(ctx, "roof", "roof_slab", L.offset(fp, ROOF_OVER), Z_ROOF, H, m_roof, bottom=True)
    for k, b in enumerate(SKY_B):
        L.box_ab(ctx, "roof", f"roof_skylight_{k}", bc + b - SKY_W / 2, bc + b + SKY_W / 2,
                 A0 + SKY_END, A1 - SKY_END, H, H + SKY_H, m_glass)

    # ---- body：站體下墩柱 + 帽梁（沿中心線 4 支，推測） ----------------------------
    for k, a in enumerate(PIER_A):
        x, y = L.ab(bc, ac + a)
        L.cylinder(ctx, "body", f"station_pier_{k}", x, y, PIER_R, 0, Z_BOT - CAP_D, m_conc, seg=16)
        L.box_ab(ctx, "body", f"station_pier_cap_{k}", bc - CAP_B, bc + CAP_B, ac + a - CAP_A / 2,
                 ac + a + CAP_A / 2, Z_BOT - CAP_D, Z_BOT, m_conc, bottom=True)

    # ---- entrance：兩端軌道梁 + 墩柱 + 半圓拱隔音罩（示意延伸段） --------------------
    z_rail = Z_BOT + GIRDER_D
    for tag, a_end, sgn in (("south", A0, -1), ("north", A1, 1)):
        a_far = a_end + sgn * EXT
        lo, hi = min(a_end, a_far), max(a_end, a_far)
        L.box_ab(ctx, "entrance", f"viaduct_girder_{tag}", bc - GIRDER_B, bc + GIRDER_B, lo, hi,
                 Z_BOT, z_rail, m_conc, bottom=True)
        pa = a_end + sgn * EXT_PIER_A
        x, y = L.ab(bc, pa)
        L.cylinder(ctx, "entrance", f"viaduct_pier_{tag}", x, y, PIER_R * 0.9, 0, Z_BOT - 1.6, m_conc, seg=16)
        L.box_ab(ctx, "entrance", f"viaduct_pier_cap_{tag}", bc - EXT_CAP_B, bc + EXT_CAP_B,
                 pa - 1.1, pa + 1.1, Z_BOT - 1.6, Z_BOT, m_conc, bottom=True)

        bm = bmesh.new()   # 隔音罩面板：半圓殼（封閉實體，雙面可見）
        _half_ring(bm, lo, hi, TUBE_R, TUBE_R + TUBE_T, z_rail, TUBE_SEG, bc)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        L._link(ctx, "entrance", f"noise_barrier_tube_{tag}", bm, m_tube)

        bm = bmesh.new()   # 肋條：沿長度每 RIB_STEP 一道半圓肋 + 兩側底緣縱梁
        n = int(EXT // RIB_STEP)
        for j in range(n + 1):
            a = a_end + sgn * min(j * RIB_STEP + RIB_W / 2, EXT - RIB_W / 2)
            _half_ring(bm, a - RIB_W / 2, a + RIB_W / 2, TUBE_R + TUBE_T, TUBE_R + TUBE_T + RIB_D,
                       z_rail, RIB_SEG, bc)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        L._link(ctx, "entrance", f"noise_barrier_ribs_{tag}", bm, m_metal)
        for side, b in (("w", bc - TUBE_R - 0.25), ("e", bc + TUBE_R + 0.25)):
            L.box_ab(ctx, "entrance", f"noise_barrier_curb_{tag}_{side}", b - 0.3, b + 0.3, lo, hi,
                     z_rail, z_rail + 0.6, m_metal)

        bm = bmesh.new()   # 站體端牆上的軌道開口暗部（從罩內看進去）
        f = _half_disc(bm, a_end + sgn * 0.05, TUBE_R, z_rail, TUBE_SEG, bc)
        f.normal_update()
        if (f.normal.x * L.A_DIR[0] + f.normal.y * L.A_DIR[1]) * sgn < 0:
            f.normal_flip()
        L._link(ctx, "entrance", f"track_portal_{tag}", bm, m_portal)

    # ---- signs：兩側長立面各一 ------------------------------------------------------
    for b, nrm in ((B1, L.B_DIR), (B0, (-L.B_DIR[0], -L.B_DIR[1]))):
        x, y = L.ab(b + (0.2 if b == B1 else -0.2), ac)
        L.sign(ctx, "市政府站", (x, y, SIGN_Z), nrm, SIGN_W, SIGN_H, m_sign)

    notes = ("平面依 OSM 輪廓（125 × 28 m，沿文心路跨路口上方）；高度 24 m 與底面 9 m 為估算（參考文件 §3，官方查無）。"
             "灰色金屬水平百葉方盒站體、平屋頂長條天窗（條數推測）、月台層兩側玻璃帶（推測）。"
             "站體下墩柱數量與位置查無，做沿中心線 4 支單柱 + 帽梁為推測；"
             "兩端半圓拱形隔音罩與高架軌道梁各外延 25 m 只示意，高架軌道全線不在本模型；隔音罩實為半透明綠，模型為不透明。"
             "出入口聯開大樓（G9-1 / G9-2）為施工中工地，不建模（§3）。")
    return L.finish(ctx, H, "estimated", notes, L.B_DIR,
                    street=((L.B_DIR[0] * 45 + L.A_DIR[0] * 50, L.B_DIR[1] * 45 + L.A_DIR[1] * 50, 1.7), (0.0, 0.0, 14.0)))   # 由路口斜看站體（主控調整）


if __name__ == "__main__":
    build()
