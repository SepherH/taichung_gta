"""老虎城購物中心（OSM way 150999799）。

執行：blender -b -P tools/blender/tiger_city.py
依據：docs/ref/tiger-city-reference.md §1（本體）、§5（建模摘要表）。
格網座標 (b, a)：b 往東南（河南路側為 +b），a 往東北。以下數值皆相對模型原點。
OSM 輪廓在格網上約為 b -30…48、a -35…44 的 L 形，東側缺角 b 0…48、a 5…44 = 前廣場。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 150999799
SLUG = "tiger_city"
NAME = "老虎城購物中心"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H_BODY = 30.0          # 主體屋頂。§1「推測約 35–40 m」含影城；主體取 30。推測
H_CINEMA = 40.0        # 後段白色影城方盒（最高）。§5 表「約 60×30×40」。估算
CINEMA_B = (-8.0,)     # 影城方盒前緣 b（後緣貼 OSM 西北牆）；a -16…44。§1 屋頂 + §5 位置估算
CINEMA_A = (-16.0, 44.4)
GF_H = 5.0             # 1F 柱廊高度。§1「1F 白色圓柱騎樓」。高度推測
GF_INSET = 3.0         # 1F 店面退縮，留出柱廊。推測
F2_TOP = 10.0          # 2F 外露陽台所在樓層頂。§1「2F 外露陽台」。推測
COL_SPACING = 7.0      # 柱距。推測
TOWER = dict(b=(-12.0, 0.5), a=(32.0, 45.0), h=45.0)   # 玻璃景觀塔 §1 右側 + §5「12×12×45」。已確認存在，尺寸估
PAVILION = dict(b=34.0, a=32.0, r=7.0, h=10.0)         # 圓柱綠牆亭 §1 + §5「直徑 14 × 高 10」。已確認存在，尺寸估
PLAZA = dict(b=(1.0, 47.0), a=(5.5, 44.0))             # 前廣場 = OSM 缺角。§1 注意事項。已確認
SUNKEN = dict(b=(8.0, 28.0), a=(10.0, 27.0))           # 下沉廣場範圍。§1 / §5「約 45×40」內。位置推測
ROTUNDA = dict(b=22.0, a=-15.0, r=7.5, h=5.0)          # 屋頂玻璃圓筒 §1 屋頂 + §5「直徑約 15」。已確認（3D），尺寸估
SKYLIGHT = dict(b=36.0, a=-26.0, r=4.0, h=3.0)         # 淺綠金字塔採光頂 §1 屋頂。已確認存在，尺寸推測
LOGO = dict(t=0.2, z=25.0, r=2.6)                      # TIGER CITY 圓形 logo：主立面西南頂角。§1 / §5 直徑約 5 m。已確認，尺寸估
SIGN_TEXT = dict(t=0.2, z=20.5, w=15.0, h=3.0)         # logo 下方深灰金屬字 → sign 平面

# ---- 顏色（§5 表） -------------------------------------------------------------
C_METAL = "#B8BCC0"    # 銀灰金屬牆板
C_WHITE = "#E8E8E6"    # 白柱
C_CINEMA = "#EDEDEB"   # 影城白方盒
C_GLASS = "#3E5A60"    # 店面 / 景觀塔玻璃（深色低粗糙度，依 #7FA3A8 調暗）
C_FRAME = "#9A9EA2"
C_VINE = "#4E7A3A"
C_ROOFDISC = "#D8D8D8"
C_PAVE = "#A9A49C"
C_PAVE2 = "#CFC6B5"
C_WOOD = "#8B6B4A"
C_LOGO = "#1F4E8C"
C_ROOF_GREEN = "#6E8F4E"


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint

    m_metal = L.mat("tiger_metal_panel", C_METAL, metallic=0.6, roughness=0.4)
    m_white = L.mat("tiger_white_column", C_WHITE, roughness=0.5)
    m_cinema = L.mat("tiger_cinema_white", C_CINEMA, roughness=0.6)
    m_shop = L.mat("tiger_shopfront_glass", C_GLASS, metallic=0.3, roughness=0.1,
                   emission="#FFD9A0", strength=0.1)
    m_glass = L.mat("tiger_tower_glass", C_GLASS, metallic=0.3, roughness=0.1,
                    emission="#CFE6FF", strength=0.3)
    m_frame = L.mat("tiger_tower_frame", C_FRAME, metallic=0.7, roughness=0.4)
    m_vine = L.mat("tiger_vine_green", C_VINE, roughness=0.9)
    m_disc = L.mat("tiger_pavilion_roof", C_ROOFDISC, roughness=0.5)
    m_pave = L.mat("tiger_plaza_paving", C_PAVE, roughness=0.9)
    m_pave2 = L.mat("tiger_plaza_paving_light", C_PAVE2, roughness=0.9)
    m_wood = L.mat("tiger_wood_deck", C_WOOD, roughness=0.8)
    m_rail = L.mat("tiger_glass_rail", "#9FC2C8", metallic=0.2, roughness=0.05)
    m_green = L.mat("tiger_roof_garden", C_ROOF_GREEN, roughness=0.9)
    m_logo = L.mat("tiger_logo_navy", C_LOGO, roughness=0.4, emission=C_LOGO, strength=1.5)
    m_logo2 = L.mat("tiger_logo_light", "#6FA0D8", roughness=0.4, emission="#6FA0D8", strength=2.0)
    m_sign = L.mat("sign_placeholder", "#4A4F55", metallic=0.5, roughness=0.4,
                   emission="#FFFFFF", strength=1.0)
    m_lamp = L.mat("tiger_orb_lamp", "#F2A33A", emission="#FFB347", strength=4.0)
    m_mech = L.mat("tiger_roof_mech", "#8C8F92", roughness=0.7)

    # ---- body：1F 退縮店面 + 2F 陽台層 + 3F 以上銀灰主體 -------------------------
    L.prism(ctx, "body", "body_ground_floor_shops", L.offset(fp, -GF_INSET), 0, GF_H, m_shop)
    L.prism(ctx, "body", "body_2f_slab", fp, GF_H, GF_H + 0.5, m_white, bottom=True)
    L.prism(ctx, "body", "body_2f_terrace_floor", L.offset(fp, -2.5), GF_H + 0.5, F2_TOP, m_shop)
    L.prism(ctx, "body", "body_upper", fp, F2_TOP, H_BODY, m_metal, bottom=True)
    # 影城方盒：後緣沿 OSM 西北牆（b 由 -29.25 漸變到 -31.0），前緣 b = -8
    cinema = [L.ab(-29.25, CINEMA_A[0]), L.ab(CINEMA_B[0], CINEMA_A[0]),
              L.ab(CINEMA_B[0], CINEMA_A[1]), L.ab(-31.0, 44.0)]
    L.prism(ctx, "body", "body_cinema_box", L.offset(cinema, 0.25), F2_TOP, H_CINEMA, m_cinema, bottom=True)

    # ---- entrance：主立面柱廊、2F 玻璃欄杆與植栽、玻璃景觀塔、綠牆亭 -----------------
    se0, se1 = L.facade_edge(fp, L.B_DIR)                  # 主立面（朝東南 / 河南路）
    edges = [(se0, se1)]
    i = fp.index(se1)                                      # 沿逆時針接續缺角的兩道內牆
    edges += [(fp[i], fp[(i + 1) % len(fp)]), (fp[(i + 1) % len(fp)], fp[(i + 2) % len(fp)])]
    inner = L.offset(fp, -1.2)
    n = 0
    for p0, p1 in edges:
        ln = ((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2) ** 0.5
        k = max(int(ln // COL_SPACING), 1)
        for j in range(1, k):
            (x, y), (nx, ny) = L.edge_frame(p0, p1, j / k)
            L.cylinder(ctx, "entrance", f"colonnade_column_{n:02d}", x - nx * 1.2, y - ny * 1.2,
                       0.45, 0, GF_H, m_white, seg=8)
            n += 1
    rail = L.offset(fp, -0.3)
    for p0, p1 in edges:
        (x, y), (nx, ny) = L.edge_frame(p0, p1, 0.5)
        ln = ((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2) ** 0.5
        L.facade_panel(ctx, "entrance", f"terrace_glass_rail_{edges.index((p0, p1))}",
                       (x - nx * 0.35, y - ny * 0.35, GF_H + 1.05), (nx, ny), ln - 1, 1.1, 0.08, m_rail)
        L.facade_panel(ctx, "entrance", f"terrace_planter_{edges.index((p0, p1))}",
                       (x - nx * 1.3, y - ny * 1.3, GF_H + 0.85), (nx, ny), ln - 3, 0.7, 0.8, m_green)

    t = TOWER
    L.box_ab(ctx, "entrance", "glass_tower", t["b"][0], t["b"][1], t["a"][0], t["a"][1], 0, t["h"], m_glass)
    for bi, (bb, aa) in enumerate(((t["b"][0], t["a"][0]), (t["b"][1], t["a"][0]),
                                   (t["b"][1], t["a"][1]), (t["b"][0], t["a"][1]))):
        L.box_ab(ctx, "entrance", f"glass_tower_frame_{bi}", bb - 0.4, bb + 0.4, aa - 0.4, aa + 0.4,
                 0, t["h"] + 0.6, m_frame)
    for zi, z in enumerate(range(9, int(t["h"]), 9)):
        L.box_ab(ctx, "entrance", f"glass_tower_floor_band_{zi}", t["b"][0] - 0.2, t["b"][1] + 0.2,
                 t["a"][0] - 0.2, t["a"][1] + 0.2, z, z + 0.5, m_frame)
    L.box_ab(ctx, "entrance", "glass_tower_cap", t["b"][0] - 0.4, t["b"][1] + 0.4,
             t["a"][0] - 0.4, t["a"][1] + 0.4, t["h"], t["h"] + 0.6, m_frame)

    p = PAVILION
    px, py = L.ab(p["b"], p["a"])
    L.cylinder(ctx, "entrance", "green_wall_pavilion", px, py, p["r"], 0, p["h"], m_vine, seg=20)
    L.cylinder(ctx, "entrance", "green_wall_pavilion_roof_disc", px, py, p["r"] + 1.0,
               p["h"], p["h"] + 0.6, m_disc, seg=20, bottom=True)

    # ---- site：前廣場鋪面、下沉廣場（僅地表示意，不往下挖）、球形燈 ---------------------
    pl, sk = PLAZA, SUNKEN
    L.box_ab(ctx, "site", "plaza_paving", pl["b"][0], pl["b"][1], pl["a"][0], pl["a"][1], 0, 0.06, m_pave)
    L.box_ab(ctx, "site", "sunken_plaza_wood_deck", sk["b"][0], sk["b"][1], sk["a"][0], sk["a"][1],
             0.06, 0.1, m_wood)
    for si in range(5):  # 寬大階梯：朝河南路側的淺色條帶
        b0 = sk["b"][1] - 1.6 * (si + 1)
        L.box_ab(ctx, "site", f"sunken_plaza_step_{si}", b0, b0 + 0.8, sk["a"][0], sk["a"][1],
                 0.1, 0.13, m_pave2)
    for ri, (b0, b1, a0, a1) in enumerate(((sk["b"][0], sk["b"][1], sk["a"][0] - 0.1, sk["a"][0]),
                                          (sk["b"][0], sk["b"][1], sk["a"][1], sk["a"][1] + 0.1),
                                          (sk["b"][0] - 0.1, sk["b"][0], sk["a"][0], sk["a"][1]))):
        L.box_ab(ctx, "site", f"sunken_plaza_rail_{ri}", b0, b1, a0, a1, 0.1, 1.2, m_rail)
    for li, (bb, aa) in enumerate(((5, 8), (5, 30), (32, 8), (44, 20), (22, 40), (44, 42))):
        lx, ly = L.ab(bb, aa)
        L.cylinder(ctx, "site", f"orb_lamp_pole_{li}", lx, ly, 0.08, 0, 3.4, m_frame, seg=6)
        L.sphere(ctx, "site", f"orb_lamp_{li}", lx, ly, 3.7, 0.4, m_lamp)

    # ---- roof：屋頂花園、玻璃圓筒、金字塔採光頂、影城機電 ------------------------------
    L.box_ab(ctx, "roof", "roof_garden", 4.0, 44.0, -31.0, 2.0, H_BODY, H_BODY + 0.3, m_green)
    r = ROTUNDA
    rx, ry = L.ab(r["b"], r["a"])
    L.cylinder(ctx, "roof", "roof_glass_rotunda", rx, ry, r["r"], H_BODY, H_BODY + r["h"], m_rail, seg=16)
    s = SKYLIGHT
    sx, sy = L.ab(s["b"], s["a"])
    L.pyramid(ctx, "roof", "roof_pyramid_skylight", L.rect_ab(s["b"] - s["r"], s["b"] + s["r"],
              s["a"] - s["r"], s["a"] + s["r"]), H_BODY + 0.3, H_BODY + 0.3 + s["h"], m_rail)
    for mi, (bb, aa) in enumerate(((-22, 0), (-15, 12), (-22, 28))):
        L.box_ab(ctx, "roof", f"roof_mech_unit_{mi}", bb - 3, bb + 3, aa - 4, aa + 4,
                 H_CINEMA, H_CINEMA + 2.5, m_mech)

    # ---- signs：主立面西南頂角的圓形 logo（抽象同心圓，不重製原圖）+ 字牌 ----------------
    (lx, ly), nrm = L.edge_frame(se0, se1, LOGO["t"])
    L.disc_on_wall(ctx, "signs", "logo_disc_outer", (lx, ly, LOGO["z"]), nrm, LOGO["r"], 0.3, m_logo)
    L.disc_on_wall(ctx, "signs", "logo_disc_inner", (lx, ly, LOGO["z"]), nrm, LOGO["r"] * 0.55, 0.4, m_logo2)
    (tx, ty), nrm = L.edge_frame(se0, se1, SIGN_TEXT["t"])
    L.sign(ctx, "TIGER CITY", (tx + nrm[0] * 0.15, ty + nrm[1] * 0.15, SIGN_TEXT["z"]), nrm,
           SIGN_TEXT["w"], SIGN_TEXT["h"], m_sign)

    notes = ("OSM L 形輪廓擠出；主立面朝東南（河南路）。高度無官方數字，依參考文件 §1 推測 35–40 m："
             "主體 30 m、影城方盒 40 m、玻璃景觀塔 45 m（height 取景觀塔頂）。下沉廣場只做地表示意、"
             "未往地下挖。sign:TIGER CITY 為字牌佔位，圓形 logo 為抽象同心圓。")
    street = ((*L.ab(95, 30), 1.7), (*L.ab(10, -2), 17))
    return L.finish(ctx, TOWER["h"], "estimated", notes, L.B_DIR, street=street)


if __name__ == "__main__":
    build()
