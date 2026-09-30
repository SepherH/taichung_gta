"""林酒店 The Lin Hotel（OSM way 456488572）。

執行：blender -b -P tools/blender/lin_hotel.py
依據：docs/ref/tiger-city-reference.md §3「同街廓（緊鄰老虎城）」、§5。
選它的理由：與老虎城同街廓、就在其西北後方，從河南路看老虎城時背景那棟深色高塔就是它。
外觀：深古銅 / 棕色玻璃帷幕 + 規律白色水平帶，頂部弧形收頭（§3 已確認外觀）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 456488572
SLUG = "lin_hotel"
NAME = "林酒店"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
LEVELS = 25            # OSM building:levels=25（參考文件 §3 目視推測 30 層以上，以 OSM 為準）
FLOOR_H = 3.8          # 飯店樓高。推測
H_BODY = LEVELS * FLOOR_H          # 95 m
BAND_EVERY = 1         # 每層一道白色水平帶。§3「規律白色水平帶」已確認；間隔推測
BAND = dict(h=0.45, d=0.3)
CROWN = [(-1.2, 3.5), (-3.2, 3.0), (-6.5, 2.5)]   # 弧形收頭以三段內縮近似（內縮量、段高）。形狀已確認、尺寸推測

C_BRONZE = "#4A3A33"   # §5
C_WHITE = "#E6E2DA"    # §5


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_bronze = L.mat("lin_bronze_glass", C_BRONZE, metallic=0.4, roughness=0.12,
                     emission="#FFE2B0", strength=0.04)
    m_white = L.mat("lin_white_band", C_WHITE, roughness=0.5)

    L.prism(ctx, "body", "body_bronze_glass", fp, 0, H_BODY, m_bronze)
    for i in range(BAND_EVERY, LEVELS, BAND_EVERY):
        L.band(ctx, "body", f"white_floor_band_{i:02d}", fp, i * FLOOR_H - BAND["h"], BAND["h"], BAND["d"], m_white)
    z = H_BODY
    for ci, (d, h) in enumerate(CROWN):
        L.prism(ctx, "roof", f"roof_curved_crown_{ci}", L.offset(fp, d), z, z + h, m_white if ci == 0 else m_bronze)
        z += h

    notes = (f"OSM 輪廓擠出；OSM 25 層 × 3.8 m + 冠頂 = {z:.0f} m（參考文件 §5 表寫 120 m 推測，與 OSM 層數不符，"
             "此處以 OSM 層數估算）。古銅玻璃 + 每層白色水平帶 + 三段內縮近似弧形收頭；裙樓泳池位置不明未建。")
    return L.finish(ctx, z, "estimated", notes, (L.B_DIR[0] + L.A_DIR[0] * 0.3, L.B_DIR[1] + L.A_DIR[1] * 0.3))


if __name__ == "__main__":
    build()
