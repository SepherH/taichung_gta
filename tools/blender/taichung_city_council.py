"""臺中市議會 議政大樓（OSM way 222636758）。

執行：blender -b -P tools/blender/taichung_city_council.py
依據：docs/ref/civic-center-reference.md §2「臺中市議會 議政大樓」與「建模摘要」表。
OSM 輪廓是 108 × 32 m 的矩形，長軸方位 122°（與七期 b 軸差 1°），主立面朝東北（市政公園）。
辨識關鍵是「扁方鏡面藍玻璃盒 + 中上部弧底穿透開口」：主體用 OSM 輪廓擠出，
EXACT 布林挖出前後貫穿、上緣水平下緣下彎弧的大開口（切面淺色），地面層前後各內退一個深色玻璃大廳。
為了貼齊輪廓（而非差 1° 的格網），本檔用輪廓本身求出的局部座標：
s = 沿長軸（往東南為正，約等於格網 b），t = 沿短軸（往東北為正，約等於格網 a）。
"""
import math
import os
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 222636758
SLUG = "taichung_city_council"
NAME = "臺中市議會"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H = 69.8               # 總高。§2「總高度 69.8 m」官方新聞稿。已確認
FLOORS = 14            # 地上 14 層，每層一道淺色細帶。§2 已確認（層數 / 水平條紋）；帶寬、凸出量推測
BAND_H = 0.35          # 樓層細帶高。推測
BAND_D = 0.12          # 細帶凸出玻璃面。推測
COPING_H = 0.6         # 頂部女兒牆壓頂（淺灰，兼作第 14 道帶）。推測
OPEN_C = -18.0         # 穿透開口中心 s（略偏西北端）。§2 位置已確認「略偏西北」；數值估算
OPEN_W = 30.0          # 穿透開口寬。§2 估算（3D 截圖比例）
OPEN_TOP = 53.0        # 開口上緣（水平）z。§2 開口高約 15 m，位置「中上部」；估算
OPEN_BOT = 38.0        # 開口下緣弧最低點 z（開口中央），OPEN_TOP − 15。估算
OPEN_SAG = 4.0         # 下緣弧下彎量：弧兩端比中央高 4 m。§2「下緣是往下彎的弧形」形狀已確認；下彎量推測
OPEN_SEG = 12          # 下緣弧分段
LOBBY_W = 60.0         # 底部開口寬。§2 推測 + 估算（寬約 60 m）
LOBBY_H = 11.0         # 底部開口高。§2 推測 + 估算（高約 10–12 m）
LOBBY_RECESS = 4.0     # 大廳玻璃內退深度（前後各一，不貫穿）。任務指示；§2 底部開口本身為推測
COL_R = 0.6            # 大廳承托圓柱半徑。推測
COL_S = (-22.5, -7.5, 7.5, 22.5)   # 圓柱 s 位置（每側 4 支，間距 15 m）。推測
COL_INSET = 1.4        # 圓柱中心距立面內退距離。推測
GARDENS = ((-44.0, -24.0), (22.0, 46.0))   # 屋頂花園 s 範圍（兩塊）。§2「頂樓空中花園」細節查無，推測
GARDEN_INSET = 3.0     # 花園距屋頂邊緣。推測
GARDEN_H = 0.35        # 花園覆土高（高出 69.8 m 的屋頂面）。推測
LAWN_W = 40.0          # 東北側方形草坪庭院寬（沿立面）。§2 存在已確認；尺寸推測
LAWN_D = 25.0          # 草坪縱深。推測
LAWN_GAP = 4.0         # 草坪與立面間鋪面走道寬。推測
LAWN_C = 0.0           # 草坪中心 s（對齊大廳）。推測
PAVE_M = 4.0           # 建物四周鋪面外擴。推測
SIGN = dict(w=18.0, h=2.4, z=12.9)   # 大廳上方東北立面招牌。任務指示位置；尺寸推測

C_GLASS = "#5D7FA3"    # §2 / 建模摘要：鏡面藍玻璃（估算色）
C_BAND = "#D8DBDE"     # 淺色水平細帶。推測
C_CUT = "#E6E4DE"      # 開口內側淺色弧面（§2 已確認「開口內側為淺色弧面」；色碼任務指定）
C_LOBBY = "#2B3540"    # 大廳深色玻璃。推測
C_ROOF = "#BDBEBB"     # 平屋頂淺灰。§2 已確認（3D 平頂淺灰）
C_GARDEN = "#6E8F4E"   # 屋頂花園。推測
C_LAWN = "#6B7F45"     # 草坪（沿用建模摘要市政公園草色）
C_PAVE = "#CFCAC0"     # 鋪面（沿用建模摘要市府前廣場鋪面色）。推測
C_SIGN = "#F2F2EE"     # 招牌底板。推測


def _frame(fp):
    """由輪廓最長邊求局部座標：回傳 P(s, t) → (x, y) 與 s / t 範圍。"""
    n = len(fp)
    i = max(range(n), key=lambda k: math.dist(fp[k], fp[(k + 1) % n]))
    p0, p1 = fp[i], fp[(i + 1) % n]
    ln = math.dist(p0, p1)
    u = ((p1[0] - p0[0]) / ln, (p1[1] - p0[1]) / ln)
    if u[0] * L.B_DIR[0] + u[1] * L.B_DIR[1] < 0:
        u = (-u[0], -u[1])
    v = (-u[1], u[0])   # u 逆時針轉 90° → 往東北
    ss = [x * u[0] + y * u[1] for x, y in fp]
    ts = [x * v[0] + y * v[1] for x, y in fp]
    s_mid, t_mid = (min(ss) + max(ss)) / 2, (min(ts) + max(ts)) / 2

    def P(s, t):
        s, t = s + s_mid, t + t_mid
        return (s * u[0] + t * v[0], s * u[1] + t * v[1])
    hs, ht = (max(ss) - min(ss)) / 2, (max(ts) - min(ts)) / 2
    return P, hs, ht, v


def _rect(P, s0, s1, t0, t1):
    return [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)]


def _bm_box(bm, P, s0, s1, t0, t1, z0, z1, mi=0):
    """在 bmesh 內加一個局部座標方盒（封閉六面）。"""
    q = _rect(P, s0, s1, t0, t1)
    lo = [bm.verts.new((x, y, z0)) for x, y in q]
    hi = [bm.verts.new((x, y, z1)) for x, y in q]
    faces = [bm.faces.new(hi), bm.faces.new(list(reversed(lo)))]
    for a in range(4):
        b = (a + 1) % 4
        faces.append(bm.faces.new((lo[a], lo[b], hi[b], hi[a])))
    for f in faces:
        f.material_index = mi
    return faces


def _arc_geom():
    """開口下緣圓弧：弦長 OPEN_W、拱高 OPEN_SAG，回傳 (半徑, 圓心 z)。"""
    c = OPEN_W / 2
    r = (c * c + OPEN_SAG * OPEN_SAG) / (2 * OPEN_SAG)
    return r, OPEN_BOT + r


def _open_halfwidth(z0, z1):
    """z0..z1 高度帶內穿透開口的最大半寬（0 = 不相交），用來把樓層帶在開口處斷開。"""
    if z0 >= OPEN_TOP or z1 <= OPEN_BOT:
        return 0.0
    r, zc = _arc_geom()
    z = min(z1, OPEN_BOT + OPEN_SAG)
    return math.sqrt(max(r * r - (zc - z) ** 2, 0.0))


def _opening_cutter(ctx, P, ht, m_cut):
    """側視輪廓（s, z）：上緣水平、兩側垂直、下緣下彎圓弧；沿 t 前後貫穿（兩端各多 2 m）。"""
    r, zc = _arc_geom()
    c = OPEN_W / 2
    a_end = math.asin(c / r)
    prof = [(OPEN_C - c, OPEN_TOP)]
    for k in range(OPEN_SEG + 1):                 # 下緣弧：由西北端往東南端
        a = -a_end + 2 * a_end * k / OPEN_SEG
        prof.append((OPEN_C + r * math.sin(a), zc - r * math.cos(a)))
    prof.append((OPEN_C + c, OPEN_TOP))
    bm = bmesh.new()
    tt = ht + 2.0
    front = [bm.verts.new((*P(s, tt), z)) for s, z in prof]
    back = [bm.verts.new((*P(s, -tt), z)) for s, z in prof]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    n = len(prof)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return L._link(ctx, "body", "cut_upper_opening", bm, m_cut)


def _lobby_cutter(ctx, P, ht, side, m_soffit, m_lobby):
    """地面層大廳內退挖刀：頂面（挖後成為大廳天花）用淺色，其餘面（內退玻璃牆 / 兩端側牆）用深色玻璃。"""
    bm = bmesh.new()
    t_in, t_out = ht - LOBBY_RECESS, ht + 2.0
    t0, t1 = (t_in, t_out) if side > 0 else (-t_out, -t_in)
    faces = _bm_box(bm, P, -LOBBY_W / 2, LOBBY_W / 2, t0, t1, -1.0, LOBBY_H, mi=1)
    faces[0].material_index = 0
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    tag = "northeast" if side > 0 else "southwest"
    return L._link(ctx, "body", f"cut_lobby_{tag}", bm, [m_soffit, m_lobby])


def _floor_bands(ctx, P, hs, ht, m_band):
    """每層一道淺色細帶（第 1–13 層樓板線；第 14 道 = 頂部壓頂），在開口 / 大廳處斷開，合成單一物件。"""
    bm = bmesh.new()
    fh = H / FLOORS
    e = BAND_D
    for k in range(1, FLOORS):
        z0 = k * fh - BAND_H / 2
        z1 = z0 + BAND_H
        # 長立面（東北 / 西南）：扣掉與開口、大廳重疊的區段
        holes = []
        hw = _open_halfwidth(z0, z1)
        if hw > 0:
            holes.append((OPEN_C - hw, OPEN_C + hw))
        if z0 < LOBBY_H:
            holes.append((-LOBBY_W / 2, LOBBY_W / 2))
        segs, cur = [], -hs - e
        for a, b in sorted(holes):
            if a > cur:
                segs.append((cur, a))
            cur = max(cur, b)
        segs.append((cur, hs + e))
        for s0, s1 in segs:
            _bm_box(bm, P, s0, s1, ht - 0.05, ht + e, z0, z1)
            _bm_box(bm, P, s0, s1, -ht - e, -ht + 0.05, z0, z1)
        # 短立面（西北 / 東南）：整段
        _bm_box(bm, P, -hs - e, -hs + 0.05, -ht, ht, z0, z1)
        _bm_box(bm, P, hs - 0.05, hs + e, -ht, ht, z0, z1)
    return L._link(ctx, "body", "floor_bands", bm, m_band)


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    P, hs, ht, front_n = _frame(fp)

    m_glass = L.mat("council_blue_mirror_glass", C_GLASS, metallic=0.6, roughness=0.08)
    m_band = L.mat("council_floor_band", C_BAND, roughness=0.5)
    m_cut = L.mat("council_opening_soffit", C_CUT, roughness=0.6)
    m_lobby = L.mat("council_lobby_glass", C_LOBBY, metallic=0.3, roughness=0.08,
                    emission="#FFE2B0", strength=0.08)
    m_roof = L.mat("council_roof_gray", C_ROOF, roughness=0.85)
    m_garden = L.mat("council_roof_garden", C_GARDEN, roughness=0.9)
    m_lawn = L.mat("council_courtyard_lawn", C_LAWN, roughness=0.95)
    m_pave = L.mat("council_site_paving", C_PAVE, roughness=0.9)
    m_sign = L.mat("council_sign_panel", C_SIGN, roughness=0.6)

    # ---- body：藍玻璃盒 + 穿透開口 + 地面層內退大廳 ---------------------------------
    body = L.prism(ctx, "body", "body_glass_box", fp, 0, H - COPING_H, m_glass, bottom=True)
    cutters = [_opening_cutter(ctx, P, ht, m_cut),
               _lobby_cutter(ctx, P, ht, +1, m_cut, m_lobby),
               _lobby_cutter(ctx, P, ht, -1, m_cut, m_lobby)]
    L.boolean_cut(body, cutters)
    _floor_bands(ctx, P, hs, ht, m_band)

    # ---- entrance：大廳承托圓柱（前後各 4 支） --------------------------------------
    for side, tag in ((+1, "northeast"), (-1, "southwest")):
        t = side * (ht - COL_INSET)
        for i, s in enumerate(COL_S):
            x, y = P(s, t)
            L.cylinder(ctx, "entrance", f"lobby_column_{tag}_{i}", x, y, COL_R, 0, LOBBY_H, m_cut, seg=12)

    # ---- roof：淺灰壓頂 / 平屋頂 + 兩塊屋頂花園 --------------------------------------
    L.prism(ctx, "roof", "roof_coping_slab", L.offset(fp, BAND_D), H - COPING_H, H, m_roof, bottom=True)
    for i, (s0, s1) in enumerate(GARDENS):
        L.prism(ctx, "roof", f"roof_garden_{i}",
                _rect(P, s0, s1, -ht + GARDEN_INSET, ht - GARDEN_INSET), H, H + GARDEN_H, m_garden)

    # ---- site：建物四周鋪面 + 東北側方形草坪庭院 -------------------------------------
    L.prism(ctx, "site", "site_paving",
            _rect(P, -hs - PAVE_M, hs + PAVE_M, -ht - PAVE_M, ht + LAWN_GAP + LAWN_D + PAVE_M), 0, 0.05, m_pave)
    t0 = ht + LAWN_GAP
    L.prism(ctx, "site", "northeast_courtyard_lawn",
            _rect(P, LAWN_C - LAWN_W / 2, LAWN_C + LAWN_W / 2, t0, t0 + LAWN_D), 0.05, 0.12, m_lawn)

    # ---- signs：東北立面底部（大廳上緣上方）招牌 -------------------------------------
    sx, sy = P(0.0, ht + BAND_D + 0.02)
    L.sign(ctx, NAME, (sx, sy, SIGN["z"]), front_n, SIGN["w"], SIGN["h"], m_sign)

    notes = ("OSM 108 × 32 m 矩形擠出官方總高 69.8 m（§2）。鏡面藍玻璃盒 + 14 道淺色樓層細帶；"
             "中上部前後貫穿開口（寬約 30 m、z 38–53，上緣水平、下緣下彎弧，略偏西北）形狀依 §2 已確認，尺寸 / 下彎量為估算推測。"
             "地面層底部開口屬 §2 推測，做成前後各內退 4 m 的深色玻璃大廳 + 圓柱承托（寬 60 m、高 11 m 估算）。"
             "屋頂花園細節查無，兩塊綠地位置推測；東北側草坪庭院存在已確認、尺寸推測。")
    return L.finish(ctx, H, "official", notes, L.A_DIR)


if __name__ == "__main__":
    build()
