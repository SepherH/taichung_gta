"""寶輝秋紅谷（OSM way 853807906）。

執行：blender -b -P tools/blender/baohui_qiuhonggu.py
依據：docs/ref/qiuhonggu-opera-vehicle-reference.md §1、§5（下稱「§1」）。
OSM 輪廓是 H 形 / 啞鈴形：兩翼沿 b 軸（市政北六路方向）長約 55 m，中間連接體；西北（-b）、東南（+b）
兩端各有一個缺口 = 立面上的全高垂直凹槽。用 L.to_ab 換成 (b, a) 後大約是：
    南翼 a -32.2…-17.5/-14.0、北翼 a 10.1/12.2…32.2（b -27…27.7）；連接體 b -12.0…13.8
    西北凹槽 b -27.8…-12.0、東南凹槽 b 13.8…27.6（a 約 -17.5…12.2）
輪廓各邊依法線方向自動分類：
    long  = 朝 ±a 的長邊（東北 / 西南長立面）：藍灰反光玻璃 + 每層白色鋸齒陽台板
    end   = 朝 ±b 的翼端（凹槽所在的西北 / 東南端立面）：米白石材 + 規律小方窗，靠凹槽一側留玻璃轉角
    notch = 凹槽內三面牆：玻璃（§1「凹槽兩側轉角為玻璃」），每 2 層一道白色樓板線（推測）
立面方位對應為推測（§1：依 OSM 缺口方位推得）；材質配色已確認（§1 照片）。
"""
import math
import os
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 853807906
SLUG = "baohui_qiuhonggu"
NAME = "寶輝秋紅谷"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H_TOTAL = 160.98       # 總高。§1 已確認（建照）
H_ROOF = 154.45        # 屋頂高。§1 已確認（建照）
LEVELS = 41            # 地上 41 層。§1 已確認
PODIUM_H = 9.0         # 裙樓約 2 層。§1 估算（照片約 2 層 ≈ 8–10 m）
PODIUM_LEVELS = 2      # §1 估算
TOWER_LEVELS = LEVELS - PODIUM_LEVELS
FLOOR_H = (H_ROOF - PODIUM_H) / TOWER_LEVELS   # ≈ 3.73 m：屋頂高扣裙樓後均分。估算

# 長立面陽台板：斜角切割鋸齒，3 層一組錯落（§1 已確認有鋸齒錯落；尺寸 / 週期推測）
BALC_T = 0.35          # 板厚。推測
BALC_TEETH = 3         # 每道長立面的鋸齒數。推測
BALC_GROUP = [         # (最淺外凸, 最深外凸, 相位比例, 兩端內縮)，依樓層 % 3 循環。推測
    (0.5, 1.8, 0.00, 0.0),
    (0.7, 2.2, 0.33, 1.8),
    (0.4, 1.4, 0.67, 0.9),
]

# 端立面石材格子（§1 已確認「米白石材 + 規律小方窗」；分割尺寸推測）
GLASS_CORNER = 3.5     # 靠凹槽一側的玻璃轉角寬。§1 已確認有玻璃轉角；寬度推測
PIER_SP = 2.8          # 石材直向窗間柱中距。推測
PIER_W = 1.1           # 窗間柱寬（窗寬 = 1.7）。推測
PIER_D = 0.45          # 窗間柱外凸。推測
SPAN_D = 0.35          # 水平石材窗下牆外凸（比柱淺，端點藏進柱側）。推測
SILL = 1.0             # 窗台高。推測
WIN_H = 1.7            # 窗高（約 1.7 × 1.7 小方窗）。推測
WIN_D = 0.08           # 深色窗玻璃板外凸（石材格子後方）。推測

NOTCH_BAND = dict(every=2, h=0.45, d=0.15)   # 凹槽玻璃牆白色樓板線。推測

# 頂部：平頂、無冠頂（§1 已確認）；凹槽頂空橋 + 透空框（§1 已確認有，尺寸推測）
PARAPET_H = 1.2        # 屋頂女兒牆。推測
PARAPET_T = 0.3        # 推測
LEG = dict(b=4.0, a=3.5)     # 凹槽兩側玻璃轉角往上延伸成框腳的平面尺寸。推測
BEAM_D = 2.0           # 凹槽口頂部橫樑深度（沿 b）。推測
BEAM_H = 2.2           # 橫樑高，頂緣 = 總高 160.98。高度已確認 / 分配推測
BRIDGE_D = 4.0         # 頂層空橋深度。推測
BRIDGE_SLAB = 0.6      # 空橋上下白色樓板厚。推測
SOLAR = dict(w=2.0, pitch=3.2, z=0.5, t=0.25, margin=2.5)   # 屋頂太陽能板列。§1 已確認有（Google 3D）；排列推測

# 裙樓（§1 外觀已確認：米色石材基座 + 成排高窗 + 挑高大廳；尺寸估算 / 推測）
PODIUM_OUT = 0.4       # 石材基座外凸。推測
PODIUM_WIN = dict(sp=4.5, w=2.6, z0=1.4, z1=7.4, d=0.55)    # 成排高窗。推測
CORNICE = dict(z=8.4, h=0.6, d=0.8)                         # 裙樓頂線腳。推測
LOBBY = dict(w=14.0, d=1.5, h=8.0)       # 挑高大廳玻璃量體，置於西南長立面中央。位置推測（街側查無）
CANOPY = dict(w=18.0, d=4.5, z=8.2, t=0.4)                  # 入口雨遮。推測

C_STONE = "#D9CFBF"    # 米白石材。§1 / §5 已確認
C_GLASS = "#8FA7B5"    # 藍灰反光玻璃。§1 / §5 已確認
C_WHITE = "#E8E4DC"    # 白色腰帶 / 陽台板。§1 / §5 已確認
C_WINDOW = "#3A4148"   # 端立面小窗 / 裙樓高窗深色玻璃。推測
C_LOBBY = "#A9BCC6"    # 大廳玻璃（室內燈光）。推測
C_ROOF = "#9A9A96"     # 屋面。推測
C_SOLAR = "#1F2A3A"    # 太陽能板。推測


# ---- 幾何小工具：全部疊進同一個 bmesh，最後各部位一次 L._link -----------------------
def _edges(fp):
    """輪廓每條邊（逆時針序）的切向 / 外法線 / 長度，與在 (b, a) 格網下的分類。"""
    out = []
    for i in range(len(fp)):
        p0, p1 = fp[i], fp[(i + 1) % len(fp)]
        ln = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        t = ((p1[0] - p0[0]) / ln, (p1[1] - p0[1]) / ln)
        n = (t[1], -t[0])                      # 逆時針多邊形的外側
        nb, na = L.to_ab(*n)                   # to_ab 是純旋轉，可直接轉向量
        b0, a0 = L.to_ab(*p0)
        b1, a1 = L.to_ab(*p1)
        if abs(na) > 0.9 and ln > 40:
            kind = "long"
        elif abs(nb) > 0.9 and abs(b0 + b1) / 2 > 20:
            kind = "end"
        else:
            kind = "notch"
        out.append(dict(p0=p0, p1=p1, ln=ln, t=t, n=n, nb=nb, na=na, a0=a0, a1=a1, b0=b0, b1=b1, kind=kind))
    return out


def _wp(e, s, d):
    """邊 e 上沿切向 s 公尺、往外 d 公尺的點。"""
    return (e["p0"][0] + e["t"][0] * s + e["n"][0] * d, e["p0"][1] + e["t"][1] * s + e["n"][1] * d)


def _prism(bm, pts, z0, z1, top=True, bottom=False, keep_side=None):
    """同 L.prism，但疊進既有 bm；keep_side(nx, ny) 回 False 的側面不建（貼牆背面等看不到的面）。"""
    pts = L.ccw(pts)
    lo = [bm.verts.new((x, y, z0)) for x, y in pts]
    hi = [bm.verts.new((x, y, z1)) for x, y in pts]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        dx, dy = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
        ln = math.hypot(dx, dy) or 1.0
        if keep_side is None or keep_side(dy / ln, -dx / ln):
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    if top:
        bm.faces.new(hi)
    if bottom:
        bm.faces.new(list(reversed(lo)))


def _wall_box(bm, e, s0, s1, d0, d1, z0, z1, top=True, bottom=False, ends=True):
    """貼在邊 e 外側的方塊（沿邊 s0…s1、往外 d0…d1）。背面（朝牆）一律不建；ends=False 連兩端也不建。"""
    nx, ny = e["n"]

    def keep(sx, sy):
        dot = sx * nx + sy * ny
        return dot > 0.5 if not ends else dot > -0.5
    _prism(bm, [_wp(e, s0, d0), _wp(e, s1, d0), _wp(e, s1, d1), _wp(e, s0, d1)], z0, z1, top, bottom, keep)


def _wall_quad(bm, e, s0, s1, z0, z1, d):
    """貼牆單面板（正面朝外）。"""
    (x0, y0), (x1, y1) = _wp(e, s0, d), _wp(e, s1, d)
    bm.faces.new([bm.verts.new(v) for v in ((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))])


def _ring(bm, outer, inner, z0, z1):
    """女兒牆：外輪廓 outer 與內輪廓 inner（點數相同、同序）之間的環狀牆。"""
    outer, inner = L.ccw(outer), L.ccw(inner)
    n = len(outer)
    ol = [bm.verts.new((x, y, z0)) for x, y in outer]
    oh = [bm.verts.new((x, y, z1)) for x, y in outer]
    il = [bm.verts.new((x, y, z0)) for x, y in inner]
    ih = [bm.verts.new((x, y, z1)) for x, y in inner]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ol[i], ol[j], oh[j], oh[i]))     # 外側
        bm.faces.new((il[j], il[i], ih[i], ih[j]))     # 內側（朝屋面）
        bm.faces.new((oh[i], oh[j], ih[j], ih[i]))     # 頂


def _box_ab(bm, b0, b1, a0, a1, z0, z1, bottom=True):
    _prism(bm, L.rect_ab(min(b0, b1), max(b0, b1), min(a0, a1), max(a0, a1)), z0, z1, True, bottom)


def _balcony(bm, e, z, group):
    """長立面一道陽台板：背緣貼牆，前緣為三角波鋸齒（斜角切割），3 層一組錯落。"""
    dmin, dmax, phase, inset = group
    s0, s1 = inset, e["ln"] - inset
    period = (s1 - s0) / BALC_TEETH
    ph = s0 + phase * period

    def depth(s):
        u = ((s - ph) / period) % 1.0
        return dmin + (dmax - dmin) * (1.0 - abs(2.0 * u - 1.0))
    ss = [s0, s1]
    k = math.floor((s0 - ph) / (period / 2)) - 1
    while True:
        s = ph + k * period / 2
        k += 1
        if s > s1 - 0.4:
            break
        if s > s0 + 0.4:
            ss.append(s)
    ss.sort()
    front = [_wp(e, s, depth(s)) for s in reversed(ss)]
    pts = [_wp(e, s0, -0.05), _wp(e, s1, -0.05)] + front
    nx, ny = e["n"]
    _prism(bm, pts, z - BALC_T, z, True, True, lambda sx, sy: sx * nx + sy * ny > -0.9)


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    edges = _edges(fp)
    m_glass = L.mat("baohui_glass_bluegrey", C_GLASS, metallic=0.5, roughness=0.12)
    m_stone = L.mat("baohui_stone_cream", C_STONE, roughness=0.7)
    m_white = L.mat("baohui_band_white", C_WHITE, roughness=0.55)
    m_window = L.mat("baohui_window_dark", C_WINDOW, metallic=0.3, roughness=0.18,
                     emission="#FFE2B0", strength=0.1)
    m_lobby = L.mat("baohui_lobby_glass", C_LOBBY, metallic=0.2, roughness=0.1,
                    emission="#FFE2B0", strength=0.35)
    m_roof = L.mat("baohui_roof_concrete", C_ROOF, roughness=0.9)
    m_solar = L.mat("baohui_solar_panel", C_SOLAR, metallic=0.5, roughness=0.25)

    # ---- body：H 形輪廓整體擠出（凹槽已在輪廓裡），玻璃為底 ----------------------------
    L.prism(ctx, "body", "body_glass_core", fp, 0, H_ROOF, m_glass)

    # 長立面：每層白色鋸齒陽台板
    bm = bmesh.new()
    for e in edges:
        if e["kind"] != "long":
            continue
        for k in range(1, TOWER_LEVELS):
            _balcony(bm, e, PODIUM_H + k * FLOOR_H, BALC_GROUP[k % len(BALC_GROUP)])
    L._link(ctx, "body", "long_facade_balconies_white", bm, m_white)

    # 端立面：深色窗玻璃底板 + 米白石材格子（直向窗間柱 + 每層水平窗下牆）；靠凹槽端留玻璃轉角
    bm_win, bm_stone = bmesh.new(), bmesh.new()
    notch_corners = []
    for e in edges:
        if e["kind"] != "end":
            continue
        inner_at_start = abs(e["a0"]) < abs(e["a1"])
        if inner_at_start:
            s_lo, s_hi = GLASS_CORNER, e["ln"]
            notch_corners.append((e["b0"], e["a0"]))
        else:
            s_lo, s_hi = 0.0, e["ln"] - GLASS_CORNER
            notch_corners.append((e["b1"], e["a1"]))
        _wall_quad(bm_win, e, s_lo, s_hi, PODIUM_H, H_ROOF, WIN_D)
        m = max(round((s_hi - s_lo - PIER_W) / PIER_SP), 1)
        for i in range(m + 1):
            c = s_lo + PIER_W / 2 + (s_hi - s_lo - PIER_W) * i / m
            _wall_box(bm_stone, e, c - PIER_W / 2, c + PIER_W / 2, 0.0, PIER_D, PODIUM_H, H_ROOF)
        z_prev = PODIUM_H
        for k in range(TOWER_LEVELS + 1):
            z_sill = PODIUM_H + k * FLOOR_H + SILL if k < TOWER_LEVELS else H_ROOF
            _wall_box(bm_stone, e, s_lo + 0.1, s_hi - 0.1, 0.0, SPAN_D, z_prev, z_sill,
                      bottom=True, ends=False)
            z_prev = z_sill + WIN_H
    L._link(ctx, "body", "end_facade_windows_dark", bm_win, m_window)
    L._link(ctx, "body", "end_facade_stone_grid", bm_stone, m_stone)

    # 凹槽內玻璃牆：白色樓板線
    bm = bmesh.new()
    nb_ = NOTCH_BAND
    for e in edges:
        if e["kind"] != "notch":
            continue
        for k in range(nb_["every"], TOWER_LEVELS, nb_["every"]):
            z = PODIUM_H + k * FLOOR_H
            _wall_quad(bm, e, 0.0, e["ln"], z - nb_["h"], z, nb_["d"])
    L._link(ctx, "body", "notch_floor_lines_white", bm, m_white)

    # ---- 裙樓：米色石材基座 + 成排高窗 + 頂線腳 ----------------------------------------
    L.prism(ctx, "body", "podium_stone", L.offset(fp, PODIUM_OUT), 0, PODIUM_H, m_stone)
    L.band(ctx, "body", "podium_cornice", fp, CORNICE["z"], CORNICE["h"], CORNICE["d"], m_stone)
    bm = bmesh.new()
    pw = PODIUM_WIN
    lobby_edge = min((e for e in edges if e["kind"] == "long"), key=lambda e: e["na"])   # 西南長立面
    for e in edges:
        if e["ln"] < pw["sp"] + 1:
            continue
        cnt = int(e["ln"] // pw["sp"])
        for i in range(cnt):
            c = e["ln"] * (i + 0.5) / cnt
            if e is lobby_edge and abs(c - e["ln"] / 2) < LOBBY["w"] / 2 + pw["w"] / 2:
                continue
            _wall_quad(bm, e, c - pw["w"] / 2, c + pw["w"] / 2, pw["z0"], pw["z1"], pw["d"])
    L._link(ctx, "body", "podium_tall_windows", bm, m_window)

    # ---- entrance：挑高大廳玻璃量體 + 雨遮（西南長立面中央，位置推測） -------------------
    e = lobby_edge
    mid = e["ln"] / 2
    bm = bmesh.new()
    _wall_box(bm, e, mid - LOBBY["w"] / 2, mid + LOBBY["w"] / 2, 0.0, PODIUM_OUT + LOBBY["d"], 0.0, LOBBY["h"])
    L._link(ctx, "entrance", "lobby_glass_atrium", bm, m_lobby)
    bm = bmesh.new()
    _wall_box(bm, e, mid - CANOPY["w"] / 2, mid + CANOPY["w"] / 2, 0.0, CANOPY["d"],
              CANOPY["z"], CANOPY["z"] + CANOPY["t"], bottom=True)
    L._link(ctx, "entrance", "entrance_canopy", bm, m_white)

    # ---- roof：平頂屋面 + 女兒牆 + 太陽能板 --------------------------------------------
    inner = L.offset(fp, -PARAPET_T)
    L.prism(ctx, "roof", "roof_slab", inner, H_ROOF, H_ROOF + 0.15, m_roof)
    bm = bmesh.new()
    _ring(bm, fp, inner, H_ROOF, H_ROOF + PARAPET_H)
    L._link(ctx, "roof", "roof_parapet_white", bm, m_white)

    bs = [L.to_ab(*p)[0] for p in fp]
    as_ = [L.to_ab(*p)[1] for p in fp]
    s = SOLAR
    wing_b = (min(bs) + 1 + s["margin"], max(bs) - 1 - s["margin"])
    a_inner_s = min(a for _, a in notch_corners if a < 0)    # 南翼內緣（取較靠外者，兩端都在翼內）
    a_inner_n = max(a for _, a in notch_corners if a > 0)
    bm = bmesh.new()
    for a_lo, a_hi in ((min(as_) + s["margin"], a_inner_s - s["margin"]),
                       (a_inner_n + s["margin"], max(as_) - s["margin"])):
        rows = max(int((a_hi - a_lo + s["pitch"] - s["w"]) // s["pitch"]), 1)
        for r in range(rows):
            a0 = a_lo + r * s["pitch"]
            z = H_ROOF + s["z"]
            _box_ab(bm, wing_b[0], wing_b[1], a0, a0 + s["w"], z, z + s["t"])
    L._link(ctx, "roof", "roof_solar_panels", bm, m_solar)

    # ---- roof：凹槽頂 Π / 日字收頭（玻璃轉角升起成框腳 + 頂橫樑 + 頂層空橋） ---------------
    bm_leg, bm_beam, bm_bridge = bmesh.new(), bmesh.new(), bmesh.new()
    for side in (-1, 1):
        cs = [(b, a) for b, a in notch_corners if b * side > 0]
        for bc, ac in cs:
            sa = 1 if ac > 0 else -1          # 背離凹槽的方向 = 翼內
            _box_ab(bm_leg, bc, bc - side * LEG["b"], ac, ac + sa * LEG["a"], H_ROOF, H_TOTAL, bottom=False)
        b_out = side * min(abs(b) for b, _ in cs)
        a_lo = min(a for _, a in cs) - 0.3
        a_hi = max(a for _, a in cs) + 0.3
        _box_ab(bm_beam, b_out, b_out - side * BEAM_D, a_lo, a_hi, H_TOTAL - BEAM_H, H_TOTAL)
        z_b = H_ROOF - FLOOR_H
        _box_ab(bm_bridge, b_out, b_out - side * BRIDGE_D, a_lo, a_hi, z_b, H_ROOF)
        _box_ab(bm_beam, b_out + side * 0.1, b_out - side * (BRIDGE_D + 0.1), a_lo, a_hi,
                z_b - BRIDGE_SLAB, z_b)
        _box_ab(bm_beam, b_out + side * 0.1, b_out - side * (BRIDGE_D + 0.1), a_lo, a_hi,
                H_ROOF, H_ROOF + BRIDGE_SLAB)
    L._link(ctx, "roof", "notch_glass_corner_legs", bm_leg, m_glass)
    L._link(ctx, "roof", "notch_top_beams_white", bm_beam, m_white)
    L._link(ctx, "roof", "notch_sky_bridges_glass", bm_bridge, m_glass)

    notes = ("OSM H 形（啞鈴形）輪廓擠出：兩板塔夾西北 / 東南兩端全高凹槽。總高 160.98 m、屋頂 154.45 m、41 層為官方數字"
             "（建照，參考文件 §1）。長立面藍灰反光玻璃 + 每層白色斜角鋸齒陽台板（3 層一組錯落）、端立面米白石材小方窗 + "
             "凹槽側玻璃轉角：材質配色依照片已確認，立面方位對應為推測，分割尺寸推測。平頂無冠頂；凹槽頂空橋 + 透空框（Π / 日字）"
             "與玻璃轉角女兒牆、屋頂太陽能板為已確認造型、尺寸推測。裙樓 2 層 9 m 為估算；大廳入口置於西南長立面中央屬推測。")
    street = (-L.A_DIR[0] - L.B_DIR[0] * 0.6, -L.A_DIR[1] - L.B_DIR[1] * 0.6)   # 由西南看入口立面與西北凹槽
    return L.finish(ctx, 161.0, "official", notes, street)


if __name__ == "__main__":
    build()
