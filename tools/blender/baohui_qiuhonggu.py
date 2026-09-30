"""寶輝秋紅谷（OSM way 853807906）。

執行：blender -b -P tools/blender/baohui_qiuhonggu.py
依據：OSM（building=apartments、building:levels=41、Z 字形輪廓）。
參考文件沒有這棟的外觀描述，只能套 §3 / §5「七期豪宅群：米色 / 淺棕石材外牆超高層住宅，頂部常有古典冠頂」
的通用風格——所以顏色、冠頂、分割全部是推測，只有輪廓與層數是 OSM 資料。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 853807906
SLUG = "baohui_qiuhonggu"
NAME = "寶輝秋紅谷"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
LEVELS = 41            # OSM building:levels=41
FLOOR_H = 3.3          # §5「住宅 3.3 m / 層」
H_BODY = LEVELS * FLOOR_H          # 135.3 m
PODIUM_H = 9.0         # 石材基座。推測
PILASTER = dict(spacing=4.5, depth=0.5, width=0.8)  # 石材壁柱。推測
BAND_EVERY = 5         # 每 5 層一道水平線腳。推測
CROWN = [(-1.0, 4.0), (-2.5, 3.0)]                 # 古典冠頂以兩段內縮近似。§3 通用風格，推測

C_STONE = "#CDBFA6"    # §5 七期豪宅米石材
C_STONE2 = "#E3D8C3"
C_BASE = "#A89479"
C_WINDOW = "#3C4248"


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_window = L.mat("baohui_window_glass", C_WINDOW, metallic=0.3, roughness=0.15,
                     emission="#FFE2B0", strength=0.12)
    m_stone = L.mat("baohui_stone", C_STONE, roughness=0.7)
    m_stone2 = L.mat("baohui_stone_light", C_STONE2, roughness=0.7)
    m_base = L.mat("baohui_stone_base", C_BASE, roughness=0.8)

    L.prism(ctx, "body", "body_window_core", fp, 0, H_BODY, m_window)
    L.band(ctx, "body", "podium_stone", fp, 0, PODIUM_H, 0.4, m_base)
    L.fins(ctx, "body", "stone_pilasters", fp, PILASTER["spacing"], PODIUM_H, H_BODY,
           PILASTER["depth"], PILASTER["width"], m_stone, skip_short=4.0)
    for i in range(BAND_EVERY, LEVELS, BAND_EVERY):
        L.band(ctx, "body", f"stone_band_{i:02d}", fp, i * FLOOR_H - 0.6, 0.6, 0.5, m_stone2)
    z = H_BODY
    for ci, (d, h) in enumerate(CROWN):
        L.prism(ctx, "roof", f"roof_crown_{ci}", L.offset(fp, d), z, z + h, m_stone2 if ci == 0 else m_stone)
        z += h

    notes = (f"OSM Z 字形輪廓擠出；OSM 41 層 × 3.3 m（參考文件 §5 住宅層高）+ 冠頂 = {z:.0f} m。"
             "參考文件無此棟外觀描述：米色石材、壁柱、冠頂皆套 §3 七期豪宅通用風格，屬推測。")
    return L.finish(ctx, z, "estimated", notes, (L.B_DIR[0] + L.A_DIR[0] * 0.5, L.B_DIR[1] + L.A_DIR[1] * 0.5))


if __name__ == "__main__":
    build()
