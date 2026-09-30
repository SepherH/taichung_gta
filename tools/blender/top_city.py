"""Top City 台中大遠百（OSM way 224955652）。

執行：blender -b -P tools/blender/top_city.py
依據：docs/ref/tiger-city-reference.md §3「範圍內地標」、§5 建模摘要表。
藍灰玻璃帷幕方盒 + 垂直分割線；上方紅色 Top City 字標；底部轉角為橘紅磚色量體。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 224955652
SLUG = "top_city"
NAME = "Top City 台中大遠百"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H = 65.0               # §5「115×124×65」、OSM 地上 14 層。推測
MULLION = dict(spacing=6.0, depth=0.5, width=0.4)   # 垂直分割線 §3 已確認；間距推測
BRICK = dict(h=14.0, b_len=32.0, a_len=38.0)        # 底部轉角磚色量體 §3 已確認；位於北角（臺灣大道 × 西側）與尺寸推測
SIGN = dict(t=0.5, z=H - 6.0, w=28.0, h=6.0)        # 紅色 Top City 字標 §3 已確認；朝臺灣大道立面推測

C_GLASS = "#557585"    # §5 #6F8FA0 藍灰玻璃調暗
C_MULLION = "#A7B6BE"
C_BRICK = "#B5653A"    # §5
C_RED = "#D0202E"      # §5 字標


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_glass = L.mat("topcity_bluegrey_glass", C_GLASS, metallic=0.35, roughness=0.12,
                    emission="#DCEBFF", strength=0.12)
    m_mull = L.mat("topcity_mullion", C_MULLION, metallic=0.6, roughness=0.4)
    m_brick = L.mat("topcity_brick_base", C_BRICK, roughness=0.8)
    m_roof = L.mat("topcity_roof", "#8C8C88", roughness=0.8)
    m_sign = L.mat("sign_placeholder_red", C_RED, emission=C_RED, strength=2.0)

    L.prism(ctx, "body", "body_glass_box", fp, 0, H, m_glass)
    L.fins(ctx, "body", "body_vertical_mullions", fp, MULLION["spacing"], 0, H,
           MULLION["depth"], MULLION["width"], m_mull)
    L.band(ctx, "body", "body_top_parapet", fp, H - 1.0, 1.4, 0.3, m_mull)

    # 底部轉角：取輪廓最北角（+a、-b 方向最遠的節點）周圍一塊，裁在輪廓內
    corner = max(fp, key=lambda p: L.to_ab(*p)[1] - L.to_ab(*p)[0])
    cb, ca = L.to_ab(*corner)
    window = L.rect_ab(cb - 2, cb + BRICK["b_len"], ca - BRICK["a_len"], ca + 2)
    L.prism(ctx, "body", "base_brick_corner", L.offset(L.clip(fp, window), 0.4), 0, BRICK["h"], m_brick)

    L.prism(ctx, "roof", "roof_deck", L.offset(fp, -1.0), H, H + 0.2, m_roof)
    L.box_ab(ctx, "roof", "roof_mech_box", -15, 15, -20, 10, H, H + 5, m_roof)

    n0, n1 = L.facade_edge(fp, L.A_DIR)
    (sx, sy), nrm = L.edge_frame(n0, n1, SIGN["t"])
    L.sign(ctx, "Top City", (sx + nrm[0] * 0.7, sy + nrm[1] * 0.7, SIGN["z"]), nrm, SIGN["w"], SIGN["h"], m_sign)

    notes = ("OSM 輪廓擠出 65 m（OSM 14 層，高度依參考文件 §5 推測）。藍灰玻璃 + 垂直分割線 + 紅色 Top City 字標 + "
             "底部磚色轉角量體依 §3；字標朝臺灣大道、磚色量體在北角為推測。")
    street_dir = (L.A_DIR[0] - L.B_DIR[0] * 0.5, L.A_DIR[1] - L.B_DIR[1] * 0.5)
    return L.finish(ctx, H + 5, "estimated", notes, street_dir)


if __name__ == "__main__":
    build()
