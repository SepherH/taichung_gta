"""臺中市政府臺灣大道市政大樓（OSM way 222413435）。

執行：blender -b -P tools/blender/taichung_city_hall.py
依據：docs/ref/civic-center-reference.md §1「臺中市政府臺灣大道市政大樓」與「建模摘要」表。
OSM 輪廓是 253 × 53 m 的長條矩形，長軸沿 b 軸（121°），主立面朝東北（a 軸正向，面向臺灣大道）。
量體 = 單一長條板樓 + 中央大門洞（前後通透）：輪廓沿 b 軸切三段，西翼（惠中樓）/ 東翼（文心樓）
從地面擠到屋頂，中央川堂段只做門楣（門洞淨高 → 屋頂），不用布林。門洞內懸掛灰色集會堂量體，
朝東北面貼深色 LED 螢幕面板。立面藍灰玻璃帷幕 + 每層一道水平條紋 + 白色垂直核心筒。
"""
import math
import os
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 222413435
SLUG = "taichung_city_hall"
NAME = "臺中市政府臺灣大道市政大樓"

# ---- 尺寸參數（公尺；b 沿 121° 往東南、a 沿 31° 往東北，原點 = 輪廓外接矩形中心） ----------------
H = 43.2               # 屋頂高。§1「屋頂高 43.2 m」（zh.wikipedia 資訊框）。已確認（官方）
FLOOR = 4.3            # 層高 ≈ 43.2 / 10 層。§1 地上 10 層。估算
GATE_W = 65.0          # 中央門洞寬（沿 b）。§1「寬約 60–75 m」、摘要表 65 m。估算
GATE_H = 25.8          # 門洞淨高 = 門楣底。§1「淨高約 25–28 m（約 6 層）」→ 取 6 × 4.3。估算
BAND_H = 0.6           # 水平條紋高。§1「密集水平條紋」已確認；尺寸推測
BAND_D = 0.3           # 水平條紋凸出玻璃面。推測
PARAPET = dict(out=0.2, inset=0.5, z0=H - 0.4, z1=H + 0.9)   # 女兒牆環。推測
CORE_W = 7.0           # 白色垂直核心筒寬。§1 核心筒存在 / 位置已確認；寬度推測
CORE_OUT = 0.5         # 核心筒凸出立面。任務書指定。推測
CORE_IN = 3.0          # 核心筒埋入量體（隱藏，只為封閉幾何）
CORE_TOP = H + 1.2     # 核心筒略高出屋頂。推測
HALL = dict(b=(-20.0, 20.0), a=(-12.5, 12.5), z=(12.0, 24.0))   # 懸掛集會堂 40 × 25 × 12。§1 存在已確認；尺寸 / 高度推測
LED = dict(w=34.0, h=9.0, z=18.0, d=0.12)                        # 集會堂東北面 LED 螢幕。§1 照片已確認；尺寸推測
HANGER = 0.4           # 集會堂吊桿斷面（24 m → 門楣底）。推測
CANOPY = dict(b=(-16.0, 16.0), a_in=5.0, a_out=3.0, z=(6.0, 6.8))  # 門洞入口雨遮（相對前立面）。§1 雨遮 + 字樣已確認；尺寸 / 位置推測
DOOR = dict(w=16.0, h=5.0)                                       # 兩翼朝門洞內側的入口玻璃門面。推測
SOLAR_BLOCKS = [(46.0, 68.0), (70.0, 92.0), (94.0, 116.0)]       # 太陽能板區塊 |b| 範圍（兩翼對稱）。§1 深色太陽能板已確認；排列推測
SOLAR_ROW = 3.0        # 每列板寬（沿 a）。推測
SOLAR_GAP = 1.6        # 列距。推測
SOLAR_ROWS = 9         # 列數。推測
SOLAR_Z = (0.45, 0.6)  # 板離屋面高度（含支架）。推測
MECH = [((36.0, 43.0), (-12.0, 2.0), 3.5),                      # 白色機房小量體 (|b|, a, 高)，兩翼對稱。§1 存在已確認；位置 / 尺寸推測
        ((38.0, 43.0), (6.0, 14.0), 2.5),
        ((119.0, 124.0), (-8.0, 8.0), 3.0)]
SKY = dict(b=(-22.0, 22.0), a=(-11.0, 11.0), curb=0.6, curb_h=1.0)  # 門楣上方屋頂天井開口。§1 已確認；尺寸推測
TRUSS_B = (-16.0, -8.0, 0.0, 8.0, 16.0)                          # 天井上橫跨鋼構架位置。§1「有鋼構架橫跨」已確認；數量推測
PLAZA_D = 40.0         # 前方廣場縱深（只做 40 m，其餘屬道路 / 地形）。任務書指定；§1 實際縱深 183–226 m
FLAG = dict(a=20.0, n=7, spacing=6.0, r=0.12, h=12.0)            # 旗桿列（距前立面 a、支數、間距、半徑、高）。§1 旗桿群已確認；數量 / 位置推測
PLINTH = dict(b=(-66.0, -54.0), a=(30.0, 31.5), h=1.2)           # 廣場北側地面銘牌石座（a 相對前立面）。§1 已確認；位置 / 尺寸推測

C_GLASS = "#4F6F8F"    # §1 主色：玻璃（估算）
C_BAND = "#A9B8C6"     # §1 水平帶（估算）
C_CORE = "#E3E3DE"     # §1 白色核心筒（估算）
C_HALL = "#8C8F93"     # §1 門洞內灰色量體（估算）
C_PAVE = "#CFCAC0"     # §1 前廣場石材鋪面（估算）
C_ROOF = "#BEC1C2"     # 平頂淺灰。§1 已確認；色碼推測
C_SOLAR = "#1F2A36"    # 深色太陽能板。推測
C_DARK = "#2A2F33"     # 天井凹入 / 暗部。推測
C_STEEL = "#6E7479"    # 鋼構架 / 吊桿。推測
C_SOFFIT = "#C9CCCE"   # 門楣底板。推測
C_LED = "#15191D"      # LED 面板底色（自發光深色，無文字）。推測
C_LED_EMIT = "#2B3A4C"
C_DOOR = "#2A3440"     # 入口玻璃門。推測
C_CANOPY = "#9A9EA2"   # 雨遮金屬。推測
C_AXIS = "#A8A39A"     # 廣場中軸分隔線。推測
C_POLE = "#D8DADC"     # 旗桿。推測
C_STONE = "#EEECE6"    # 銘牌石座（§1「白色石材銘牌」）
C_SIGN = "#F4F3EF"     # 招牌佔位平面底色


def _solid(bm, pts, z0, z1, bottom=True):
    """在既有 bmesh 內加一個擠出多邊形（同 L.prism，但可多個合成一個物件）。"""
    pts = L.ccw(pts)
    lo = [bm.verts.new((x, y, z0)) for x, y in pts]
    hi = [bm.verts.new((x, y, z1)) for x, y in pts]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(hi)
    if bottom:
        bm.faces.new(list(reversed(lo)))


def _solids(ctx, part, name, items, material, bottom=True):
    """items = [(pts, z0, z1), ...] 合併成單一物件。"""
    bm = bmesh.new()
    for pts, z0, z1 in items:
        _solid(bm, pts, z0, z1, bottom)
    return L._link(ctx, part, name, bm, material)


def _ring(ctx, part, name, pts, out, inset, z0, z1, material):
    """女兒牆：輪廓外擴 out、內縮 inset 之間的環狀牆（中間鏤空，不蓋住屋面）。"""
    o = L.offset(pts, out)
    i_ = L.offset(pts, -inset)
    bm = bmesh.new()
    n = len(o)
    ol = [bm.verts.new((x, y, z0)) for x, y in o]
    oh = [bm.verts.new((x, y, z1)) for x, y in o]
    il = [bm.verts.new((x, y, z0)) for x, y in i_]
    ih = [bm.verts.new((x, y, z1)) for x, y in i_]
    for k in range(n):
        j = (k + 1) % n
        bm.faces.new((ol[k], ol[j], oh[j], oh[k]))     # 外牆
        bm.faces.new((il[j], il[k], ih[k], ih[j]))     # 內牆（朝內）
        bm.faces.new((oh[k], oh[j], ih[j], ih[k]))     # 壓頂
        bm.faces.new((ol[j], ol[k], il[k], il[j]))     # 底
    return L._link(ctx, part, name, bm, material)


def _face_a(edge, b):
    """立面邊 edge 在格網位置 b 處的 a 座標（輪廓略歪，約 1.4 m / 253 m，逐點內插）。"""
    b0, a0 = L.to_ab(*edge[0])
    b1, a1 = L.to_ab(*edge[1])
    return a0 + (a1 - a0) * (b - b0) / (b1 - b0)


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_glass = L.mat("city_hall_glass_curtain", C_GLASS, metallic=0.35, roughness=0.12)
    m_band = L.mat("city_hall_floor_band", C_BAND, metallic=0.2, roughness=0.4)
    m_core = L.mat("city_hall_white_core", C_CORE, roughness=0.6)
    m_hall = L.mat("city_hall_assembly_hall", C_HALL, metallic=0.2, roughness=0.5)
    m_led = L.mat("city_hall_led_screen", C_LED, roughness=0.3, emission=C_LED_EMIT, strength=0.6)
    m_steel = L.mat("city_hall_steel", C_STEEL, metallic=0.6, roughness=0.4)
    m_soffit = L.mat("city_hall_gate_soffit", C_SOFFIT, roughness=0.6)
    m_door = L.mat("city_hall_entrance_glass", C_DOOR, metallic=0.3, roughness=0.1,
                   emission="#FFE2B0", strength=0.05)
    m_canopy = L.mat("city_hall_canopy_metal", C_CANOPY, metallic=0.5, roughness=0.35)
    m_roof = L.mat("city_hall_roof_slab", C_ROOF, roughness=0.85)
    m_solar = L.mat("city_hall_solar_panel", C_SOLAR, metallic=0.3, roughness=0.25)
    m_dark = L.mat("city_hall_skylight_void", C_DARK, roughness=0.8)
    m_pave = L.mat("city_hall_plaza_paving", C_PAVE, roughness=0.9)
    m_axis = L.mat("city_hall_plaza_axis_line", C_AXIS, roughness=0.9)
    m_pole = L.mat("city_hall_flagpole", C_POLE, metallic=0.7, roughness=0.3)
    m_stone = L.mat("city_hall_stone_plinth", C_STONE, roughness=0.7)
    m_sign = L.mat("city_hall_sign_panel", C_SIGN, roughness=0.5)

    bs = [L.to_ab(x, y)[0] for x, y in fp]
    b_min, b_max = min(bs), max(bs)
    g = GATE_W / 2
    west = L.clip(fp, L.rect_ab(b_min - 50, -g, -100, 100))    # 惠中樓（西北翼）
    east = L.clip(fp, L.rect_ab(g, b_max + 50, -100, 100))     # 文心樓（東南翼）
    gate = L.clip(fp, L.rect_ab(-g, g, -100, 100))             # 中央川堂段
    front = L.facade_edge(fp, L.A_DIR)                         # 東北主立面
    back = L.facade_edge(fp, (-L.A_DIR[0], -L.A_DIR[1]))       # 西南背立面
    fa0 = _face_a(front, 0.0)

    # ---- body：兩翼 + 門楣 + 水平條紋 + 核心筒 ------------------------------------------
    L.prism(ctx, "body", "west_wing_glass", west, 0, H, m_glass)
    L.prism(ctx, "body", "east_wing_glass", east, 0, H, m_glass)
    L.prism(ctx, "body", "gate_lintel_glass", gate, GATE_H, H, m_glass)
    L.prism(ctx, "body", "gate_lintel_soffit", gate, GATE_H - 0.15, GATE_H, m_soffit, bottom=True)

    n_gate = int(round(GATE_H / FLOOR))          # 門洞高度內的樓層線只繞兩翼（含門洞內側牆）
    n_all = int(round(H / FLOOR))                # 最頂一道由女兒牆取代
    bands = []
    for k in range(1, n_gate + 1):
        z = k * FLOOR - BAND_H / 2
        bands += [(L.offset(west, BAND_D), z, z + BAND_H), (L.offset(east, BAND_D), z, z + BAND_H)]
    for k in range(n_gate + 1, n_all):
        z = k * FLOOR - BAND_H / 2
        bands.append((L.offset(fp, BAND_D), z, z + BAND_H))
    _solids(ctx, "body", "floor_bands", bands, m_band)
    _ring(ctx, "roof", "roof_parapet", fp, PARAPET["out"], PARAPET["inset"],
          PARAPET["z0"], PARAPET["z1"], m_band)

    cores = []
    core_b = [-(g + CORE_W / 2), g + CORE_W / 2,                        # 門洞兩側
              b_min + 1.0 + CORE_W / 2, b_max - 1.0 - CORE_W / 2]       # 兩翼端部
    for cb in core_b:
        b0, b1 = cb - CORE_W / 2, cb + CORE_W / 2
        af = _face_a(front, cb)
        ak = _face_a(back, cb)
        cores.append((L.rect_ab(b0, b1, af - CORE_IN, af + CORE_OUT), 0, CORE_TOP))
        cores.append((L.rect_ab(b0, b1, ak - CORE_OUT, ak + CORE_IN), 0, CORE_TOP))  # 背面對稱。推測
    _solids(ctx, "body", "white_cores", cores, m_core, bottom=False)

    # ---- entrance：懸掛集會堂 + LED + 吊桿 + 雨遮 + 入口門 ---------------------------------
    h = HALL
    L.box_ab(ctx, "entrance", "assembly_hall_box", h["b"][0], h["b"][1], h["a"][0], h["a"][1],
             h["z"][0], h["z"][1], m_hall, bottom=True)
    lx, ly = L.ab(0.0, h["a"][1])
    L.facade_panel(ctx, "entrance", "assembly_hall_led_screen", (lx, ly, LED["z"]), L.A_DIR,
                   LED["w"], LED["h"], LED["d"], m_led)
    hangers = []
    for hb in (h["b"][0] + 3, h["b"][1] - 3):
        for ha in (h["a"][0] + 3, h["a"][1] - 3):
            hangers.append((L.rect_ab(hb - HANGER / 2, hb + HANGER / 2, ha - HANGER / 2, ha + HANGER / 2),
                            h["z"][1], GATE_H - 0.15))
    _solids(ctx, "entrance", "assembly_hall_hangers", hangers, m_steel, bottom=False)

    c = CANOPY
    ca0, ca1 = fa0 - c["a_in"], fa0 + c["a_out"]
    L.box_ab(ctx, "entrance", "gate_canopy", c["b"][0], c["b"][1], ca0, ca1, c["z"][0], c["z"][1],
             m_canopy, bottom=True)
    posts = []
    for pb in (c["b"][0] + 2, c["b"][1] - 2):
        px, py = L.ab(pb, ca1 - 0.6)
        posts.append((L.circle(px, py, 0.25, 8), 0, c["z"][0]))
    _solids(ctx, "entrance", "gate_canopy_posts", posts, m_steel, bottom=False)
    for tag, sgn in (("west", -1), ("east", 1)):
        dx, dy = L.ab(sgn * g, 0.0)
        nrm = (-sgn * L.B_DIR[0], -sgn * L.B_DIR[1])          # 朝門洞內
        L.facade_panel(ctx, "entrance", f"{tag}_wing_entrance_doors", (dx, dy, DOOR["h"] / 2 + 0.05), nrm,
                       DOOR["w"], DOOR["h"], 0.1, m_door)

    # ---- roof：屋面 + 太陽能板 + 機房 + 門楣天井 ------------------------------------------
    L.prism(ctx, "roof", "roof_slab", L.offset(fp, -PARAPET["inset"] + 0.05), H, H + 0.15, m_roof)
    zr = H + 0.15
    rows_w = SOLAR_ROWS * (SOLAR_ROW + SOLAR_GAP) - SOLAR_GAP
    panels = []
    for sgn in (-1, 1):
        for lo, hi in SOLAR_BLOCKS:
            b0, b1 = sorted((sgn * lo, sgn * hi))
            for r in range(SOLAR_ROWS):
                a0 = -rows_w / 2 + r * (SOLAR_ROW + SOLAR_GAP)
                panels.append((L.rect_ab(b0, b1, a0, a0 + SOLAR_ROW), zr + SOLAR_Z[0], zr + SOLAR_Z[1]))
    _solids(ctx, "roof", "solar_panel_array", panels, m_solar, bottom=True)

    mech = []
    for sgn in (-1, 1):
        for (lo, hi), (a0, a1), mh in MECH:
            b0, b1 = sorted((sgn * lo, sgn * hi))
            mech.append((L.rect_ab(b0, b1, a0, a1), zr, zr + mh))
    _solids(ctx, "roof", "roof_mechanical_rooms", mech, m_core, bottom=False)

    s = SKY
    L.box_ab(ctx, "roof", "roof_skylight_void", s["b"][0], s["b"][1], s["a"][0], s["a"][1],
             zr, zr + 0.03, m_dark)
    cw = s["curb"]
    curbs = [
        (L.rect_ab(s["b"][0] - cw, s["b"][1] + cw, s["a"][0] - cw, s["a"][0]), zr, zr + s["curb_h"]),
        (L.rect_ab(s["b"][0] - cw, s["b"][1] + cw, s["a"][1], s["a"][1] + cw), zr, zr + s["curb_h"]),
        (L.rect_ab(s["b"][0] - cw, s["b"][0], s["a"][0], s["a"][1]), zr, zr + s["curb_h"]),
        (L.rect_ab(s["b"][1], s["b"][1] + cw, s["a"][0], s["a"][1]), zr, zr + s["curb_h"]),
    ]
    _solids(ctx, "roof", "roof_skylight_curb", curbs, m_core, bottom=False)
    truss = [(L.rect_ab(tb - 0.2, tb + 0.2, s["a"][0] - cw, s["a"][1] + cw),
              zr + s["curb_h"] - 0.1, zr + s["curb_h"] + 0.5) for tb in TRUSS_B]
    _solids(ctx, "roof", "roof_skylight_truss", truss, m_steel)

    # ---- site：前廣場（東北 40 m）+ 川堂地坪 + 中軸線 + 旗桿 + 銘牌石座 ------------------------
    plaza = [L.ab(b_min, _face_a(front, b_min)), L.ab(b_max, _face_a(front, b_max)),
             L.ab(b_max, _face_a(front, b_max) + PLAZA_D), L.ab(b_min, _face_a(front, b_min) + PLAZA_D)]
    L.prism(ctx, "site", "front_plaza_paving", plaza, 0, 0.05, m_pave)
    L.prism(ctx, "site", "gate_passage_paving", gate, 0, 0.05, m_pave)
    L.box_ab(ctx, "site", "plaza_axis_line", -0.6, 0.6, fa0, fa0 + PLAZA_D, 0.05, 0.07, m_axis)

    f = FLAG
    poles = []
    for i in range(f["n"]):
        pb = (i - (f["n"] - 1) / 2) * f["spacing"]
        px, py = L.ab(pb, _face_a(front, pb) + f["a"])
        poles.append((L.circle(px, py, f["r"], 6), 0.05, f["h"]))
    _solids(ctx, "site", "flagpoles", poles, m_pole, bottom=False)

    p = PLINTH
    pa = _face_a(front, sum(p["b"]) / 2)
    L.box_ab(ctx, "site", "name_plinth_stone", p["b"][0], p["b"][1], pa + p["a"][0], pa + p["a"][1],
             0.05, p["h"], m_stone)

    # ---- signs ---------------------------------------------------------------------------
    sx, sy = L.ab(0.0, ca1 + 0.03)
    L.sign(ctx, "臺中市政府", (sx, sy, sum(c["z"]) / 2), L.A_DIR, 12.0, 0.55, m_sign)
    sx, sy = L.ab(sum(p["b"]) / 2, pa + p["a"][1] + 0.03)
    L.sign(ctx, "臺中市政府 TAICHUNG CITY GOVERNMENT", (sx, sy, (0.05 + p["h"]) / 2 + 0.05), L.A_DIR,
           11.0, 0.8, m_sign)

    notes = ("輪廓取自 OSM（253 × 53 m 長條矩形，長軸 121°）；高度 43.2 m 為官方數字（維基資訊框）。"
             "單一長條板樓 + 中央大門洞：門洞寬 65 m、淨高 25.8 m 為估算（Google 3D / 空拍比例）。"
             "門洞內懸掛灰色集會堂存在已確認，40 × 25 × 12 m、懸於 12–24 m 為推測；東北面 LED 面板尺寸推測。"
             "藍灰玻璃帷幕、每層水平條紋、白色核心筒已確認，條紋與核心筒尺寸、背面核心筒為推測。"
             "屋頂太陽能板、中央天井、白色機房存在已確認，排列與尺寸推測。"
             "前廣場只做 40 m 縱深（實際至臺灣大道約 183–226 m）；旗桿數量 / 位置、銘牌位置、雨遮尺寸推測。")
    return L.finish(ctx, H, "official", notes, L.A_DIR,
                    street=((L.A_DIR[0] * 95 + L.B_DIR[0] * 40, L.A_DIR[1] * 95 + L.B_DIR[1] * 40, 1.7), (0.0, 0.0, 16.0)))   # 由廣場斜看門洞（主控調整）


if __name__ == "__main__":
    build()
