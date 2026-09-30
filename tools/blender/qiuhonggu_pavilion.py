"""秋紅谷展示館（心之谷永續教育園區，北端綠頂橢圓建物；無 OSM 建物輪廓，用 begin_point）。

執行：blender -b -P tools/blender/qiuhonggu_pavilion.py
依據：docs/ref/qiuhonggu-opera-vehicle-reference.md §2.1、§5 建模摘要表；
      docs/ref/tiger-city-reference.md §6.1（谷深推測）、§6.2（展示館在路面高度、北端近臺灣大道）。
平面是細長蛋形 / 淚滴形（一端較尖），長軸方位約 130°。剖面由上而下：綠色屋頂面、厚實白色圓角屋簷帶、
斜向排列的古銅金屬鰭板（扇形張開、向外傾斜）、內縮玻璃帷幕、細鋼柱架空。
原點 z = 0 = 北端路面高度；建物往谷內下降，z < 0 的部分預期懸在 / 埋入谷坡（地形由遊戲程式處理）。
"""
import math
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

SLUG = "qiuhonggu_pavilion"
IDENT = "qiuhonggu_pavilion"
NAME = "秋紅谷展示館（心之谷永續教育園區）"
LAT0, LON0 = 24.16831, 120.63928   # 綠頂中心。§2.1 估算（衛星截圖 7.3 px/m 換算）

# ---- 平面（公尺） -------------------------------------------------------------
OUT_A, OUT_B = 18.5, 7.5   # 外圈（含屋簷）半長 / 半寬 → 37 × 15。§2.1 估算
ROOF_A, ROOF_B = 11.0, 4.5 # 亮綠屋頂面半長 / 半寬 → 22 × 9。§2.1 估算
AXIS_BEARING = 130.0       # 長軸方位（由正北順時針）。§2.1「方位約 130°」估算（衛星正射已確認形狀）
EGG_E = 0.28               # 蛋形不對稱度：東南端（+長軸）較尖。一端較尖已確認（§2.1）；哪一端較尖、尖的程度為推測
SEG = 48                   # 外形分段數（面數預算用）

# ---- 剖面（z，公尺；原點 = 北端路面） ------------------------------------------
Z_ROOF = 0.3               # 綠屋頂面。§2.1「屋頂大致與路面同高」推測
Z_EAVE_TOP = 0.6           # 白色屋簷帶頂。推測（屋簷略高於綠面、形成一圈白邊）
Z_EAVE_BOT = -1.5          # 白色屋簷帶底。推測（照片中屋簷帶厚實，約 2 m）
Z_LOUVER_BOT = -5.0        # 金屬鰭板層底。推測（約 1 層）
Z_GLASS_BOT = -9.0         # 玻璃帷幕層底。推測（約 1 層）
Z_SLAB_BOT = -9.3          # 底板下緣。推測
Z_COLUMN_BOT = -12.0       # 鋼柱底（坡面以下由地形埋住）。§2.1「目視約 3 層、10–12 m」推測

EAVE_PROFILE = [           # 屋簷帶外緣圓角剖面 (距外圈的內縮量 d, z)；外凸圓角。造型 §2.1 已確認；數值推測
    (-0.50, Z_EAVE_TOP), (-0.15, 0.45), (-0.02, 0.10), (0.00, -0.40),
    (-0.05, -0.90), (-0.25, -1.30), (-0.60, Z_EAVE_BOT),
]
LOUVER_D_BOT = -3.2        # 鰭板下端內縮量（z −5）。推測
LOUVER_D_TOP = -1.4        # 鰭板上端內縮量（z −1.5）→ 向外傾斜、扇形張開。§2.1 造型已確認；數值推測
LOUVER_SPACING = 0.9       # 鰭板間距（沿下緣弧長）。推測
LOUVER_WIDTH = 0.6         # 鰭板寬。推測
LOUVER_THICK = 0.05        # 鰭板厚。推測
LOUVER_YAW = 35.0          # 鰭板相對外法線的水平偏轉角（「斜向排列」）。造型已確認；角度推測
GLASS_D = -3.6             # 玻璃帷幕內縮量（外圈往內 3.6 m）。§2.1「再下層玻璃帷幕」內縮已確認；數值推測
SLAB_D = -3.3              # 底板內縮量。推測
COLUMN_D = -4.5            # 鋼柱所在圈的內縮量。推測
COLUMN_N = 12              # 鋼柱支數。推測（§2.1 只寫「細鋼柱架空」）
COLUMN_R = 0.12            # 鋼柱半徑。推測

PREVIEW_GROUND_Z = Z_COLUMN_BOT - 0.05   # 預覽地面降到柱底，否則 z < 0 的下半部會被預覽地面遮住

C_GREEN = "#2FBF6A"        # §2.1 衛星色調（已確認顏色）
C_WHITE = "#E6E6E2"        # §5
C_BRONZE = "#9C8A6E"       # §5
C_GLASS = "#7E97A8"        # §5
C_STEEL = "#8A8D90"        # 任務指定；鋼柱顏色推測

_UX, _UY = math.sin(math.radians(AXIS_BEARING)), math.cos(math.radians(AXIS_BEARING))


def _world(u, v):
    """長軸座標 (u 沿 130°, v 往其左側) → (x 東, y 北)。"""
    return (u * _UX - v * _UY, u * _UY + v * _UX)


def egg(a, b, seg=SEG):
    """蛋形輪廓（+u 端較尖），半長 a、最大半寬 b，逆時針。"""
    raw = []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        raw.append((math.cos(t), math.sin(t) * (1 - EGG_E * math.cos(t))))
    k = 1.0 / max(abs(v) for _, v in raw)
    return [_world(a * u, b * v * k) for u, v in raw]


def ring(d, seg=SEG):
    """外圈往內縮 d（d ≤ 0）的蛋形。"""
    return egg(OUT_A + d, OUT_B + d, seg)


def _arc_stations(pts, spacing=None, count=None):
    """沿閉合點列取等弧長站點，回傳 [(索引, 外法線), ...]。"""
    n = len(pts)
    seg_len = [math.dist(pts[i], pts[(i + 1) % n]) for i in range(n)]
    total = sum(seg_len)
    if count is None:
        count = max(int(total // spacing), 3)
    out, acc, j = [], 0.0, 0
    for k in range(count):
        s = total * k / count
        while acc + seg_len[j] < s:
            acc += seg_len[j]
            j += 1
        p0, p1 = pts[j - 1], pts[(j + 1) % n]
        tx, ty = p1[0] - p0[0], p1[1] - p0[1]
        ln = math.hypot(tx, ty) or 1.0
        out.append((j, (ty / ln, -tx / ln)))
    return out


def _box(bm, corners_lo, corners_hi):
    """8 點六面體（底 4 點、頂 4 點，同序），加入 bm 並回傳新面。"""
    lo = [bm.verts.new(p) for p in corners_lo]
    hi = [bm.verts.new(p) for p in corners_hi]
    faces = [bm.faces.new(lo[::-1]), bm.faces.new(hi)]
    for i in range(4):
        j = (i + 1) % 4
        faces.append(bm.faces.new((lo[i], lo[j], hi[j], hi[i])))
    return faces


def eave_ring_bm():
    """白色屋簷帶：外緣圓角剖面沿蛋形放樣，內緣接綠屋頂輪廓，成一個封閉環體。"""
    inner = egg(ROOF_A, ROOF_B)
    rings = [[(x, y, Z_EAVE_TOP) for x, y in inner]]
    for d, z in EAVE_PROFILE:
        rings.append([(x, y, z) for x, y in ring(d)])
    rings.append([(x, y, Z_EAVE_BOT) for x, y in inner])
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    m, n = len(vs), len(vs[0])
    for i in range(m):
        r0, r1 = vs[i], vs[(i + 1) % m]
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def louvers_bm():
    """斜向金屬鰭板：下端在內縮圈（z −5）、上端在較外圈（z −1.5），板面水平偏轉 LOUVER_YAW，合併一個物件。"""
    dense = 720
    bot, top = ring(LOUVER_D_BOT, dense), ring(LOUVER_D_TOP, dense)
    bm = bmesh.new()
    cy, sy = math.cos(math.radians(LOUVER_YAW)), math.sin(math.radians(LOUVER_YAW))
    for idx, (nx, ny) in _arc_stations(bot, spacing=LOUVER_SPACING):
        wx, wy = nx * cy - ny * sy, nx * sy + ny * cy          # 板寬方向（法線偏轉）
        px, py = -wy, wx                                         # 板厚方向
        hw, ht = LOUVER_WIDTH / 2, LOUVER_THICK / 2
        offs = [(-hw, -ht), (hw, -ht), (hw, ht), (-hw, ht)]

        def quad(c, z):
            return [(c[0] + wx * a + px * b, c[1] + wy * a + py * b, z) for a, b in offs]
        faces = _box(bm, quad(bot[idx], Z_LOUVER_BOT), quad(top[idx], Z_EAVE_BOT))
        bmesh.ops.recalc_face_normals(bm, faces=faces)
    return bm


def columns_bm():
    dense = ring(COLUMN_D, 720)
    bm = bmesh.new()
    for idx, _ in _arc_stations(dense, count=COLUMN_N):
        cx, cy = dense[idx]
        pts = L.circle(cx, cy, COLUMN_R, 8)
        lo = [bm.verts.new((x, y, Z_COLUMN_BOT)) for x, y in pts]
        hi = [bm.verts.new((x, y, Z_SLAB_BOT)) for x, y in pts]
        for i in range(8):
            j = (i + 1) % 8
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    return bm


def _lower_preview_ground():
    """預覽地面（landmark_lib 固定在 z −0.05）改放到柱底，讓預覽看得到下半部。只影響預覽，不進 glb。"""
    orig = L._preview_setup

    def setup(ctx):
        cam = orig(ctx)
        g = bpy.data.objects.get("preview_ground")
        if g is not None:
            g.location.z = PREVIEW_GROUND_Z + 0.05   # 平面頂點本身在 z −0.05
        return cam
    L._preview_setup = setup


def build():
    ctx = L.begin_point(SLUG, IDENT, NAME, LAT0, LON0, ring(0.0))
    m_green = L.mat("pavilion_green_roof", C_GREEN, roughness=0.85)
    m_white = L.mat("pavilion_white_eave", C_WHITE, roughness=0.5)
    m_bronze = L.mat("pavilion_bronze_louver", C_BRONZE, metallic=0.7, roughness=0.4)
    m_glass = L.mat("pavilion_glass", C_GLASS, metallic=0.3, roughness=0.08,
                    emission="#FFE2B0", strength=0.06)
    m_steel = L.mat("pavilion_steel_column", C_STEEL, metallic=0.8, roughness=0.4)

    # ---- roof：綠屋頂面 + 白色圓角屋簷帶 -----------------------------------------
    L.prism(ctx, "roof", "roof_green_surface", egg(ROOF_A, ROOF_B), Z_EAVE_BOT, Z_ROOF, m_green, bottom=True)
    L._link(ctx, "roof", "roof_white_eave_band", eave_ring_bm(), m_white)

    # ---- body：斜向金屬鰭板、內縮玻璃帷幕、底板、細鋼柱 ------------------------------
    L._link(ctx, "body", "body_bronze_louvers", louvers_bm(), m_bronze)
    L.prism(ctx, "body", "body_glass_curtain", ring(GLASS_D), Z_GLASS_BOT, Z_EAVE_BOT - 0.05, m_glass)
    L.prism(ctx, "body", "body_floor_slab", ring(SLAB_D), Z_SLAB_BOT, Z_GLASS_BOT, m_white, bottom=True)
    L._link(ctx, "body", "body_steel_columns", columns_bm(), m_steel)

    notes = ("秋紅谷北端綠頂蛋形展示館（Google 標「心之谷永續教育園區」，是否即 A 館為推測）。"
             "位置（綠頂中心 24.16831,120.63928）與平面 37 × 15 m、綠頂 22 × 9 m、長軸方位 130° 皆為衛星截圖估算；"
             "哪一端較尖為推測。原點 z=0 = 北端路面高度（屋頂約與路面同高，推測）；建物往谷內下降，"
             "屋簷帶 −1.5、鰭板層 −5、玻璃層 −9、鋼柱到 −12，總高 12.3 m 為推測（參考文件目視約 3 層）；"
             "z<0 部分預期懸在 / 埋入谷坡（谷底水面約 −7 m，推測）。繞行坡道未建模。")
    street = ((L.A_DIR[0] * 42, L.A_DIR[1] * 42, 1.7), (0, 0, -4.5))
    ang = math.radians(35)
    ax = L.A_DIR[0] * math.cos(ang) - L.A_DIR[1] * math.sin(ang)
    ay = L.A_DIR[0] * math.sin(ang) + L.A_DIR[1] * math.cos(ang)
    aerial = ((ax * 80, ay * 80, 42), (0, 0, -5.0))
    _lower_preview_ground()
    return L.finish(ctx, Z_ROOF - Z_COLUMN_BOT, "estimated", notes, L.A_DIR, street=street, aerial=aerial)


if __name__ == "__main__":
    build()
