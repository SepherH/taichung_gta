"""秋紅谷紅色跨湖步道（OSM way 336765610，bridge=yes path；無建物輪廓，用 begin_point）。

執行：blender -b -P tools/blender/qiuhonggu_red_bridge.py
依據：docs/ref/qiuhonggu-opera-vehicle-reference.md §2.2、§5 建模摘要表；
      docs/ref/tiger-city-reference.md §6.1（水面 −7 m、湖邊步道 −6 m，推測）、§6.2（紅橋樣式）。
走向沿 OSM 中心線（Z / S 形折線），轉角以斜接（miter）連續接起，橋面 / 扶手無縫無重疊。
兩側朱紅鋼欄杆 = 斜向細桿交叉網格 + 底框 + 頂端扶手 + 立柱；灰色圓柱墩 + 橫樑約每 8 m 一組。
原點 z = 0 = 湖水面（推測相對周邊路面 −7 m）；遊戲端放置時需把模型整體下移到水面高度。
"""
import math
import os
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

SLUG = "qiuhonggu_red_bridge"
IDENT = "qiuhonggu_red_bridge"
NAME = "秋紅谷紅色跨湖步道"
WAY_ID = 336765610                  # OSM bridge=yes path，7 點（OSM）
LAT0, LON0 = 24.1671585, 120.6386591  # 中心線外接矩形中心（任務指定，由 OSM 點算出）
REF_CENTERLINE = [(-21.6, -11.4), (0.3, -12.3), (6.5, -11.2), (0.3, 1.3),
                  (4.5, 7.3), (10.8, 12.3), (21.6, 11.2)]   # 同原點投影參考值（任務提供）；OSM 讀不到時備用

# ---- 尺寸參數（公尺；z 以水面為 0） ---------------------------------------------
DECK_TOP = 1.2           # 橋面頂離水。§2.2 估算 1–1.5 m
DECK_THICK = 0.25        # 橋面厚。估算
DECK_W = 2.8             # 橋面寬。§2.2 估算 2.5–3 m
RAIL_H = 1.15            # 欄杆高（橋面到扶手頂）。§2.2 估算 1.1–1.2 m
RAIL_INSET = 0.05        # 欄杆中心線距橋面邊緣。估算
HANDRAIL_W, HANDRAIL_H = 0.08, 0.06   # 頂端扶手斷面。估算
BOTTOM_RAIL_H = 0.10     # 底框高（網格下緣）。估算
BOTTOM_RAIL_W = 0.06     # 底框寬。估算
LATTICE_PITCH = 0.5      # 斜桿間距（沿橋向，兩向交叉成菱形網格）。§2.2「斜向細桿密排」已確認；間距估算
BAR_W = 0.035            # 斜桿寬。估算
BAR_GAP = 0.012          # 斜桿雙面板間距（兩片反向面，兩側都看得到）。建模手法
POST_MAX = 4.0           # 欄杆立柱最大間距。估算
POST_W = 0.06            # 立柱斷面。估算
PIER_MAX = 8.0           # 橋墩最大間距。任務指定約每 8 m 一組（§2.2 樣式已確認、間距估算）
PIER_R = 0.3             # 圓柱墩半徑。估算
PIER_BOT = -1.5          # 墩底（入水）。任務指定；水深查無
BEAM_H, BEAM_D = 0.30, 0.40   # 橫樑高 / 沿橋向寬。估算
BEAM_OVER = 0.10         # 橫樑超出橋面邊緣。估算
END_INSET = 1.0          # 兩端橋墩離端點距離。估算

C_DECK = "#9A9A96"       # §5
C_RED = "#D2283A"        # §2.2 近似 hex
C_PIER = "#8C8C88"       # §5

DECK_BOT = DECK_TOP - DECK_THICK
RAIL_TOP = DECK_TOP + RAIL_H


# ---------------------------------------------------------------- 折線工具
def _unit(dx, dy):
    ln = math.hypot(dx, dy) or 1.0
    return dx / ln, dy / ln


def _left(d):
    return (-d[1], d[0])


def centerline():
    try:
        pts = L.way_points(WAY_ID, round(LAT0, 7), round(LON0, 7))
    except (KeyError, OSError) as e:
        print(f"WARNING {SLUG}: 讀不到 OSM way {WAY_ID}（{e}），改用參考中心線")
        pts = list(REF_CENTERLINE)
    out = [pts[0]]
    for p in pts[1:]:
        if math.dist(p, out[-1]) > 0.05:
            out.append(p)
    return out


def dirs(pts):
    return [_unit(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1)]


def miter(pts, off):
    """開放折線往左側平移 off（負 = 右側），轉角斜接，回傳同點數折線。"""
    ds = dirs(pts)
    out = []
    for i, p in enumerate(pts):
        if i == 0 or i == len(pts) - 1:
            n = _left(ds[0] if i == 0 else ds[-1])
            out.append((p[0] + n[0] * off, p[1] + n[1] * off))
            continue
        n0, n1 = _left(ds[i - 1]), _left(ds[i])
        k = off / max(1.0 + n0[0] * n1[0] + n0[1] * n1[1], 0.3)
        out.append((p[0] + (n0[0] + n1[0]) * k, p[1] + (n0[1] + n1[1]) * k))
    return out


def miter_factor(pts, i):
    """頂點 i 的斜接長度倍率 1 / cos(轉角 / 2)。"""
    if i == 0 or i == len(pts) - 1:
        return 1.0
    ds = dirs(pts)
    a, b = ds[i - 1], ds[i]
    c = math.hypot(a[0] + b[0], a[1] + b[1]) / 2
    return 1.0 / max(c, 0.3)


# ---------------------------------------------------------------- bmesh 積木
def strip(bm, pts, off, hw, z0, z1):
    """沿折線（中心往左偏 off）做寬 2·hw、z0→z1 的連續實心帶，轉角斜接共用頂點 → 無縫無重疊。"""
    lft, rgt = miter(pts, off + hw), miter(pts, off - hw)
    n = len(pts)
    lb = [bm.verts.new((x, y, z0)) for x, y in lft]
    rb = [bm.verts.new((x, y, z0)) for x, y in rgt]
    lt = [bm.verts.new((x, y, z1)) for x, y in lft]
    rt = [bm.verts.new((x, y, z1)) for x, y in rgt]
    faces = []
    for i in range(n - 1):
        j = i + 1
        faces.append(bm.faces.new((lt[i], rt[i], rt[j], lt[j])))
        faces.append(bm.faces.new((lb[i], lb[j], rb[j], rb[i])))
        faces.append(bm.faces.new((lb[i], lt[i], lt[j], lb[j])))
        faces.append(bm.faces.new((rb[i], rb[j], rt[j], rt[i])))
    faces.append(bm.faces.new((lb[0], rb[0], rt[0], lt[0])))
    faces.append(bm.faces.new((lb[-1], lt[-1], rt[-1], rb[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=faces)


def oriented_box(bm, c, d, len_along, len_across, z0, z1):
    n = _left(d)
    ha, hc = len_along / 2, len_across / 2
    quad = [(c[0] + d[0] * a + n[0] * b, c[1] + d[1] * a + n[1] * b)
            for a, b in ((-ha, -hc), (ha, -hc), (ha, hc), (-ha, hc))]
    lo = [bm.verts.new((x, y, z0)) for x, y in quad]
    hi = [bm.verts.new((x, y, z1)) for x, y in quad]
    faces = [bm.faces.new(lo[::-1]), bm.faces.new(hi)]
    for i in range(4):
        j = (i + 1) % 4
        faces.append(bm.faces.new((lo[i], lo[j], hi[j], hi[i])))
    bmesh.ops.recalc_face_normals(bm, faces=faces)


def facing_quad(bm, corners, want):
    """單面四邊形，法線朝 want（水平向量）。"""
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = corners[0], corners[1], corners[2]
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny = uy * vz - uz * vy, uz * vx - ux * vz
    if nx * want[0] + ny * want[1] < 0:
        corners = corners[::-1]
    bm.faces.new([bm.verts.new(p) for p in corners])


def lattice_side(bm, line, z0, z1):
    """一側欄杆的斜桿網格：每段是一個直立平面，兩向 45° 斜桿；圖樣沿全長連續（用累積弧長），在轉角處截斷。"""
    hb = z1 - z0
    s0 = 0.0
    hw = BAR_W / 2 / math.sqrt(2)          # 45° 斜桿寬在 s / h 方向的分量
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        ls = math.dist(a, b)
        d = _unit(b[0] - a[0], b[1] - a[1])
        n = _left(d)
        k0 = math.floor((s0 - hb) / LATTICE_PITCH)
        k1 = math.ceil((s0 + ls + hb) / LATTICE_PITCH)
        for k in range(k0, k1 + 1):
            c = k * LATTICE_PITCH - s0
            for sgn in (1, -1):                 # sgn=1：s = c + h；sgn=-1：s = c − h
                if sgn == 1:
                    h0, h1 = max(0.0, -c), min(hb, ls - c)
                else:
                    h0, h1 = max(0.0, c - ls), min(hb, c)
                if h1 - h0 < 0.03:
                    continue
                ends = [(c + sgn * h, h) for h in (h0, h1)]
                # 桿寬方向垂直於桿（在 s-h 平面內），端點夾回本段範圍內避免穿出轉角
                qs = []
                for (s, h), side in ((ends[0], -1), (ends[1], -1), (ends[1], 1), (ends[0], 1)):
                    ss = min(max(s - side * sgn * hw, 0.0), ls)
                    hh = min(max(h + side * hw, 0.0), hb)
                    qs.append((ss, hh))
                for face_side in (1, -1):
                    o = face_side * BAR_GAP / 2
                    pts3 = [(a[0] + d[0] * s + n[0] * o, a[1] + d[1] * s + n[1] * o, z0 + h) for s, h in qs]
                    facing_quad(bm, pts3, (n[0] * face_side, n[1] * face_side))
        s0 += ls


def posts_side(bm, line, z0, z1):
    ds = dirs(line)
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        ls = math.dist(a, b)
        m = max(math.ceil(ls / POST_MAX), 1)
        for k in range(m + (1 if i == len(line) - 2 else 0)):
            t = k / m
            oriented_box(bm, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), ds[i],
                         POST_W, POST_W, z0, z1)


def pier_stations(pts):
    """橋墩位置：每個折點（兩端內縮 END_INSET）+ 各段內等分使間距 ≤ PIER_MAX。回傳 [(點, 沿橋方向, 斜接倍率)]。"""
    ds = dirs(pts)
    out = []
    for i, p in enumerate(pts):
        if i == 0:
            out.append(((p[0] + ds[0][0] * END_INSET, p[1] + ds[0][1] * END_INSET), ds[0], 1.0))
        elif i == len(pts) - 1:
            out.append(((p[0] - ds[-1][0] * END_INSET, p[1] - ds[-1][1] * END_INSET), ds[-1], 1.0))
        else:
            t = _unit(ds[i - 1][0] + ds[i][0], ds[i - 1][1] + ds[i][1])
            out.append((p, t, miter_factor(pts, i)))
        if i < len(pts) - 1:
            q = pts[i + 1]
            ls = math.dist(p, q)
            m = math.ceil(ls / PIER_MAX)
            for k in range(1, m):
                out.append(((p[0] + (q[0] - p[0]) * k / m, p[1] + (q[1] - p[1]) * k / m), ds[i], 1.0))
    return out


def piers_bm(pts):
    bm = bmesh.new()
    for c, d, mf in pier_stations(pts):
        circ = L.circle(c[0], c[1], PIER_R, 12)
        lo = [bm.verts.new((x, y, PIER_BOT)) for x, y in circ]
        hi = [bm.verts.new((x, y, DECK_BOT - BEAM_H)) for x, y in circ]
        for i in range(12):
            j = (i + 1) % 12
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
        oriented_box(bm, c, d, BEAM_D, DECK_W * mf + 2 * BEAM_OVER, DECK_BOT - BEAM_H, DECK_BOT)
    return bm


def build():
    pts = centerline()
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    pad = DECK_W / 2 + 0.5
    footprint = [(min(xs) - pad, min(ys) - pad), (max(xs) + pad, min(ys) - pad),
                 (max(xs) + pad, max(ys) + pad), (min(xs) - pad, max(ys) + pad)]   # 概略外包，只供預覽取景
    ctx = L.begin_point(SLUG, IDENT, NAME, LAT0, LON0, footprint)
    m_deck = L.mat("bridge_deck_grey", C_DECK, roughness=0.85)
    m_red = L.mat("bridge_railing_red", C_RED, metallic=0.3, roughness=0.45)
    m_pier = L.mat("bridge_pier_concrete", C_PIER, roughness=0.8)

    # ---- body：連續橋面 --------------------------------------------------------
    bm = bmesh.new()
    strip(bm, pts, 0.0, DECK_W / 2, DECK_BOT, DECK_TOP)
    L._link(ctx, "body", "deck_grey", bm, m_deck)

    # ---- body：兩側朱紅欄杆（網格 + 底框 + 扶手 + 立柱，合併一個物件） -----------------
    rail_off = DECK_W / 2 - RAIL_INSET
    bar_z0 = DECK_TOP + BOTTOM_RAIL_H
    bar_z1 = RAIL_TOP - HANDRAIL_H
    bm = bmesh.new()
    for side in (1, -1):
        line = miter(pts, side * rail_off)
        strip(bm, pts, side * rail_off, HANDRAIL_W / 2, bar_z1, RAIL_TOP)
        strip(bm, pts, side * rail_off, BOTTOM_RAIL_W / 2, DECK_TOP, bar_z0)
        lattice_side(bm, line, bar_z0, bar_z1)
        posts_side(bm, line, bar_z0, bar_z1)
    L._link(ctx, "body", "railing_red_lattice", bm, m_red)

    # ---- body：圓柱墩 + 橫樑 -----------------------------------------------------
    L._link(ctx, "body", "piers_concrete", piers_bm(pts), m_pier)

    # street_dir：垂直於橋主走向（兩端點連線），取朝南那一側
    main = _unit(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
    street_dir = (main[1], -main[0]) if -main[0] < 0 else (-main[1], main[0])

    length = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    notes = (f"走向取 OSM way {WAY_ID}（bridge=yes path）中心線，Z / S 形折線全長約 {length:.0f} m，轉角斜接。"
             "橋面離水 1.2 m、寬 2.8 m、厚 0.25 m、欄杆高 1.15 m、墩距約 8 m 皆為照片 / 衛星估算；"
             "朱紅斜桿網格欄杆與灰色圓柱墩樣式已確認，細部尺寸估算。"
             "原點 z=0 = 湖水面，推測相對周邊路面 −7 m（湖邊步道約 −6 m，推測）；墩柱下伸到 −1.5 m 入水。")
    return L.finish(ctx, 2.4, "estimated", notes, street_dir,
                    street=((-12.0, -28.0, 4.0), (0.0, 0.0, 1.2)), aerial=((35.0, -45.0, 38.0), (0.0, 0.0, 0.0)))   # 近景取景（主控調整）


if __name__ == "__main__":
    build()
