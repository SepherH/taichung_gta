"""新光三越 台中中港店（OSM way 148849083）。

執行：blender -b -P tools/blender/shin_kong_mitsukoshi.py
依據：docs/ref/tiger-city-reference.md §3「範圍內地標」、§5 建模摘要表。
OSM 輪廓：長邊沿 a 軸的長條量體，北端（往臺灣大道、偏惠來路側）是一段圓弧 = 圓柱形塔。
圓心 / 半徑直接由 OSM 圓弧節點擬合，不手填。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 148849083
SLUG = "shin_kong_mitsukoshi"
NAME = "新光三越 台中中港店"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H_BODY = 60.0          # 方盒主體。§5「59×124×65」、OSM 地上 14 層；主體取 60。推測
H_DRUM = 66.0          # 圓柱塔略高出主體。§3「西北角有圓柱形塔」存在已確認；高度推測
RED_BAND = (47.0, 3.0) # 紅色水平帶（起點高、厚）。§3「一道紅色水平帶」已確認；高度推測
SHOP_H = 6.0           # 1F 店面玻璃帶。推測
DRUM_PAD = 1.0         # 圓塔玻璃比擬合圓外擴，蓋住輪廓折線節點
ARC_EDGE_MAX = 9.0     # 輪廓中相鄰兩邊都短於此值的節點視為圓弧節點（擬合圓柱塔用）
SIGN = dict(t=0.55, z=52.0, w=26.0, h=5.0)   # 招牌：朝惠來路（西）的長立面上方。位置推測

C_WINE = "#7A2E2E"     # §5 暗酒紅
C_RED = "#C0392B"      # §5 紅帶
C_GLASS = "#4F6664"    # §5 灰綠玻璃 #6E8C8A 調暗
C_SHOP = "#2F3A3A"


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_wall = L.mat("skm_wine_panel", C_WINE, roughness=0.6)
    m_red = L.mat("skm_red_band", C_RED, roughness=0.5, emission=C_RED, strength=0.6)
    m_glass = L.mat("skm_green_glass", C_GLASS, metallic=0.3, roughness=0.1,
                    emission="#D6F0E8", strength=0.15)
    m_shop = L.mat("skm_shopfront_glass", C_SHOP, metallic=0.3, roughness=0.1,
                   emission="#FFD9A0", strength=0.08)
    m_roof = L.mat("skm_roof", "#8C8C88", roughness=0.8)
    m_sign = L.mat("sign_placeholder", "#FFFFFF", emission="#FFFFFF", strength=1.0)

    # ---- body ----------------------------------------------------------------
    L.prism(ctx, "body", "body_wine_box", fp, 0, H_BODY, m_wall)
    L.band(ctx, "body", "body_red_band", fp, RED_BAND[0], RED_BAND[1], 0.35, m_red)
    L.band(ctx, "body", "body_shopfront_band", fp, 0.0, SHOP_H, 0.2, m_shop)

    n = len(fp)
    arc = [fp[i] for i in range(n)
           if math.dist(fp[i], fp[i - 1]) < ARC_EDGE_MAX and math.dist(fp[i], fp[(i + 1) % n]) < ARC_EDGE_MAX]
    cx, cy, r = L.fit_circle(arc)
    L.cylinder(ctx, "body", "round_tower_glass", cx, cy, r + DRUM_PAD, SHOP_H, H_DRUM, m_glass, seg=24)
    L.cylinder(ctx, "body", "round_tower_crown", cx, cy, r + DRUM_PAD + 0.4, H_DRUM, H_DRUM + 1.2, m_wall, seg=24)
    for zi, z in enumerate(range(12, int(H_DRUM), 9)):
        L.cylinder(ctx, "body", f"round_tower_floor_ring_{zi}", cx, cy, r + DRUM_PAD + 0.2, z, z + 0.6, m_wall,
                   seg=24, bottom=True)
    L.cylinder(ctx, "body", "round_tower_red_band", cx, cy, r + DRUM_PAD + 0.35, RED_BAND[0], RED_BAND[0] + RED_BAND[1],
               m_red, seg=24, bottom=True)

    # ---- roof ----------------------------------------------------------------
    L.prism(ctx, "roof", "roof_parapet_inner", L.offset(fp, -1.0), H_BODY, H_BODY + 0.2, m_roof)
    L.box_ab(ctx, "roof", "roof_mech_box", -12, 8, -30, -5, H_BODY, H_BODY + 5, m_roof)

    # ---- signs ---------------------------------------------------------------
    w0, w1 = L.facade_edge(fp, (-L.B_DIR[0], -L.B_DIR[1]))
    (sx, sy), nrm = L.edge_frame(w0, w1, SIGN["t"])
    L.sign(ctx, "新光三越", (sx + nrm[0] * 0.2, sy + nrm[1] * 0.2, SIGN["z"]), nrm, SIGN["w"], SIGN["h"], m_sign)

    notes = (f"OSM 輪廓擠出主體 {H_BODY:.0f} m、北端圓弧擬合為圓柱玻璃塔 {H_DRUM:.0f} m（OSM 14 層；高度依參考文件 §5 推測）。"
             "暗酒紅牆板 + 一道紅帶 + 灰綠玻璃依 §3；紅帶高度、玻璃在圓塔上、招牌位置皆推測。"
             "OSM name:en 標 (suspended)，營運現況未查證。")
    street_dir = (-L.B_DIR[0] + L.A_DIR[0] * 0.6, -L.B_DIR[1] + L.A_DIR[1] * 0.6)
    return L.finish(ctx, H_DRUM + 1.2, "estimated", notes, street_dir)


if __name__ == "__main__":
    build()
