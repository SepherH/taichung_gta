"""聯聚中雍大廈（OSM way 865367994）。

執行：blender -b -P tools/blender/lianju_zhongyong.py
依據：docs/ref/tiger-city-reference.md §3（新光三越與大遠百之間的 39 層黑色玻璃塔）、§5。
選它的理由：§1 / §3 指出「低矮商場被高塔環繞」是七期的核心辨識點，而這棟夾在兩家百貨之間、
§5 列為 165 m 黑色玻璃超高層，是這一帶天際線最顯眼的塔。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 865367994
SLUG = "lianju_zhongyong"
NAME = "聯聚中雍大廈"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H = 165.0              # §5「31×40×165」、OSM 39 層。推測
CROWN_H = 7.0          # 頂部退縮冠。推測
FIN = dict(spacing=2.6, depth=0.6, width=0.3)   # 垂直線條 §3「黑色玻璃超高層、垂直線條」已確認；間距推測
LOBBY_H = 8.0          # 大廳挑高玻璃。推測

C_GLASS = "#2A2D33"    # §5 黑玻璃
C_FIN = "#474C55"


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_glass = L.mat("zhongyong_black_glass", C_GLASS, metallic=0.4, roughness=0.08,
                    emission="#DDE6F0", strength=0.08)
    m_fin = L.mat("zhongyong_fin", C_FIN, metallic=0.7, roughness=0.35)
    m_lobby = L.mat("zhongyong_lobby_glass", "#3A4048", metallic=0.3, roughness=0.1,
                    emission="#FFE2B0", strength=0.1)

    L.prism(ctx, "body", "body_black_glass", fp, 0, H - CROWN_H, m_glass)
    L.band(ctx, "body", "body_lobby_glass", fp, 0, LOBBY_H, 0.15, m_lobby)
    L.fins(ctx, "body", "body_vertical_fins", fp, FIN["spacing"], LOBBY_H, H - CROWN_H,
           FIN["depth"], FIN["width"], m_fin)
    L.prism(ctx, "roof", "roof_crown", L.offset(fp, -1.5), H - CROWN_H, H, m_fin)

    notes = "OSM 矩形輪廓擠出；OSM 39 層，高度依參考文件 §5 推測 165 m。黑色玻璃 + 垂直鰭片依 §3；頂冠退縮與大廳挑高推測。"
    return L.finish(ctx, H, "estimated", notes, (L.A_DIR[0] - L.B_DIR[0], L.A_DIR[1] - L.B_DIR[1]))


if __name__ == "__main__":
    build()
