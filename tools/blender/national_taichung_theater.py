"""臺中國家歌劇院（OSM way 222636759）。

執行：blender -b -P tools/blender/national_taichung_theater.py
依據：docs/ref/qiuhonggu-opera-vehicle-reference.md §3「臺中國家歌劇院外牆」、§5 建模摘要；
      docs/ref/tiger-city-reference.md §3「範圍內地標」（OSM 輪廓約 74 × 123 m，長邊沿 a 軸）。
造型：平直白色方盒被內部曲面管切穿，立面洞口 = 管體被盒面切出的剖面（酒瓶 / 沙漏形：
落地寬、約 1/3–1/2 高收腰、上端再放寬並在屋頂線切出弧形缺口）。每個管體是自建 bmesh 挖刀：
沿高度疊 13 層水平 D 形截面（前方直段伸出牆外、後方半超橢圓伸進牆內），寬度與退深都隨 z 變化，
EXACT 布林後成為往內彎曲的洞壁；後段曲面在布林後變成洞底（玻璃或淺灰曲牆）。
"""
import math
import os
import random
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 222636759
SLUG = "national_taichung_theater"
NAME = "臺中國家歌劇院"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H = 37.7               # 主量體高。qiuhonggu §3「建築高度 37.7 m」（zh.wikipedia / 官方）。已確認
LAWN_INSET = 2.0       # 屋頂草坪自外緣內縮。qiuhonggu §3 草坪屋頂已確認；內縮量任務指定（估算）
LAWN_T = 0.15          # 草坪層厚。估算

# 洞口（曲面管）截面輪廓：寬度為立面上的全寬
W_BOT = 24.0           # 落地處最寬。qiuhonggu §3「最寬處約 20–28 m」。估算
W_WAIST = 13.5         # 收腰寬。qiuhonggu §3「收腰處約 12–15 m」。估算
W_TOP = 25.0           # 上端放寬（屋頂線）。qiuhonggu §3 同上。估算
Z_WAIST = 0.42         # 收腰高度 / H。qiuhonggu §3「約 1/3–1/2 高度處收腰」。估算
FOOT = 0.9             # 地面處寬度 / W_BOT（圓拱腳：落地前略收，做出圓角）。推測
ROOF_FLARE = 1.06      # 屋頂線以上再外張比例 → 屋頂弧形缺口。qiuhonggu §3 缺口已確認；比例推測
# 退深（洞底離立面的深度）：(地面, 腰部, 屋頂)，腰部最深 → 管壁往內彎
DEPTH_GLASS = (3.0, 4.5, 2.5)     # 玻璃封面洞。推測
DEPTH_CAVE = (13.0, 15.0, 7.0)    # 東南面開放洞穴。任務指定深挖 12–15 m（依 qiuhonggu §3 開放洞穴）。估算
DEPTH_NW_CAVE = (6.0, 8.0, 4.0)   # 西北面中洞做淺洞穴（呼應 §3「5 號出入口在西北側」）。推測
P_GLASS = 2.6          # 截面超橢圓指數（>2 → 洞底較平，方便放竪框）。推測
P_CAVE = 2.0           # 開放洞穴截面為一般橢圓。推測
SCALE_NW = 0.9         # 西北面洞口尺寸比例。§3 其他三面數量 / 尺寸查無 → 推測
SCALE_SHORT = 0.72     # 東北 / 西南短邊洞口尺寸比例。推測
JITTER = 0.06          # 寬度 / 深度隨機擾動（固定種子）。推測
WAIST_JITTER = 0.05    # 收腰高度擾動（H 比例）。推測
# 挖刀網格：13 層 × (12 弧點 + 2 前緣點)，任務上限 20 邊 × 14 層
F_LAYERS = (-0.03, 0.04, 0.12, 0.21, 0.30, 0.39, 0.48, 0.58, 0.68, 0.78, 0.88, 0.96, 1.08)
ARC_N = 12
ARC_LIP = 0.4          # 弧端略伸出牆面，避免與牆面共線造成布林碎面
CUT_OUT = 2.0          # 挖刀前緣伸出牆外距離
BACK_ANGLE = 45.0      # 截面弧上 45°–135° 的部分算洞底（玻璃 / 淺灰），兩側為白色曲牆

# 竪框（東南面兩個玻璃洞）：qiuhonggu §3「灰藍玻璃 + 深色方格竪框」已確認；尺寸估算
MULL_W = 0.3
MULL_OFF = 0.15        # 竪框離玻璃面距離

# 屋頂（ab 座標相對輪廓中心，b 往東南、a 往東北）
TOWER_NE = dict(b=-3.0, a=30.0, size=23.0)   # 東北側舞台塔 23 × 23。qiuhonggu §3（衛星估算）；位置推測
TOWER_SW = dict(b=-3.0, a=-30.0, size=22.0)  # 西南側舞台塔 22 × 22。同上
TOWER_H = 8.0          # 舞台塔高出屋頂。任務「約 8 m」。推測
SKYLIGHTS = 13         # 白色火山口狀採光筒數量。qiuhonggu §3「約 12–14 個」。已確認
SKY_R = (1.5, 4.0)     # 採光筒長半徑（直徑 3–8 m）。估算
SKY_H = 1.2            # 採光筒高出屋面。推測
ROOF_DISC = dict(b=6.0, a=0.0, r=7.0)        # 白色圓形鋪面。存在已確認（§3）；位置 / 尺寸推測

# 地面（site）
PLAZA_D = 38.0         # 東南前廣場進深。存在已確認（§3），範圍推測
POOL = dict(d=20.0, ra=15.0, rb=11.0)        # 淺藍橢圓水池約 30 × 22（§3 估算）；離牆距離推測
POSTS = 20             # 池緣紅色小圓樁。存在已確認（§3），數量 / 尺寸推測
POST_R, POST_H = 0.2, 0.7
AMPHI = dict(d=18.0, r0=4.0, step=3.0, rise=0.45, rings=4)   # 西南角同心圓階梯草坪劇場（§3 已確認）；尺寸推測

C_WHITE = "#EDEDEA"    # qiuhonggu §3 外牆白
C_CAVE = "#C9CCD2"     # qiuhonggu §3 陰影處灰（開放洞穴曲牆）
C_GLASS = "#7E97A8"    # qiuhonggu §3 玻璃灰藍
C_FRAME = "#3C4148"    # qiuhonggu §3 竪框深灰
C_TOWER = "#5A5E63"    # qiuhonggu §3 舞台塔深灰
C_LAWN = "#6F8F4E"     # qiuhonggu §3 屋頂草
C_SKY_TOP = "#2F3338"  # 採光筒深色頂面。推測
C_POOL = "#9CC3E0"     # qiuhonggu §5 水池淺藍
C_POST = "#C23A32"     # 池緣紅樁（§3 紅色，hex 推測）
C_PAVE = "#C9C4B8"     # 廣場鋪面。推測


# ---- 立面座標系 ----------------------------------------------------------------
def facade_frame(fp, direction):
    """朝 direction 那面外牆的座標系：t = 沿牆切向、n = 朝外法線、c = 牆面到原點的距離、
    s0..s1 = 輪廓在 t 上的投影範圍。世界座標 = t * s + n * (c + d)，d > 0 在牆外。"""
    e = L.facade_edge(fp, direction)
    if e:
        (x0, y0), (x1, y1) = e
        ln = math.hypot(x1 - x0, y1 - y0)
        t = ((x1 - x0) / ln, (y1 - y0) / ln)
        n = (t[1], -t[0])
        c = x0 * n[0] + y0 * n[1]
    else:
        n = direction
        t = (-n[1], n[0])
        c = max(x * n[0] + y * n[1] for x, y in fp)
    ss = [x * t[0] + y * t[1] for x, y in fp]
    return dict(t=t, n=n, c=c, s0=min(ss), s1=max(ss))


def at(fr, s, d, z=None):
    x = fr["t"][0] * s + fr["n"][0] * (fr["c"] + d)
    y = fr["t"][1] * s + fr["n"][1] * (fr["c"] + d)
    return (x, y) if z is None else (x, y, z)


# ---- 曲面管截面 ----------------------------------------------------------------
def _interp(ctrl, x):
    """分段 smoothstep 插值，ctrl = ((x, v), ...) 依 x 遞增。"""
    if x <= ctrl[0][0]:
        return ctrl[0][1]
    for (x0, v0), (x1, v1) in zip(ctrl, ctrl[1:]):
        if x <= x1:
            u = (x - x0) / (x1 - x0)
            return v0 + (v1 - v0) * u * u * (3 - 2 * u)
    return ctrl[-1][1]


def section(h, z):
    """高度 z 的截面弧：回傳 (半寬, [(s, d), ...])，s 相對洞中心、d 相對牆面（負 = 牆內）。"""
    f = z / H
    w = _interp(((0.0, FOOT * h["wb"]), (0.1, h["wb"]), (h["zw"], h["ww"]), (0.86, h["wt"]),
                 (1.08, ROOF_FLARE * h["wt"])), f) / 2
    db, dw, dt = h["depth"]
    d = _interp(((0.0, db), (h["zw"], dw), (1.0, dt)), f)
    e = 2.0 / h["p"]
    arc = []
    for i in range(ARC_N):
        th = math.pi * i / (ARC_N - 1)
        cs, sn = math.cos(th), max(math.sin(th), 0.0)
        arc.append((w * math.copysign(abs(cs) ** e, cs), ARC_LIP - d * sn ** e))
    return w, arc


def is_back(i):
    """弧段 i（弧點 i → i+1）是否屬於洞底。"""
    mid = math.pi * (i + 0.5) / (ARC_N - 1)
    return math.sin(mid) > math.sin(math.radians(BACK_ANGLE))


def cutter(ctx, h, name, m_white):
    fr = h["fr"]
    bm = bmesh.new()
    rings = []
    for f in F_LAYERS:
        z = f * H
        w, arc = section(h, z)
        loc = [(w, CUT_OUT)] + arc + [(-w, CUT_OUT)]
        rings.append([bm.verts.new(at(fr, h["s"] + s, d, z)) for s, d in loc])
    m = len(rings[0])
    for lo, hi in zip(rings, rings[1:]):
        for j in range(m):
            jj = (j + 1) % m
            face = bm.faces.new((lo[j], lo[jj], hi[jj], hi[j]))
            i = j - 1                      # 環上第 j 段 = 弧段 j-1
            face.material_index = 1 if 0 <= i < ARC_N - 1 and is_back(i) else 0
            face.smooth = True             # 曲牆平滑著色（也讓 glb 共用頂點）
    bm.faces.new(rings[0])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return L._link(ctx, "body", name, bm, [m_white, h["back"]])


def add_mullions(bm, h):
    """在玻璃洞底曲面前 MULL_OFF 處鋪方格竪框：竪向沿弧點、橫向沿截面層（約每層樓一條）。"""
    fr = h["fr"]
    tx, ty = fr["t"]
    nx, ny = fr["n"]
    back = [i for i in range(ARC_N - 1) if is_back(i)]
    cols = range(back[0], back[-1] + 2)
    layers = [f * H for f in F_LAYERS if 0.3 < f * H < H - 0.3]
    grid = []
    for z in layers:
        arc = section(h, z)[1]
        row = []
        for c in cols:
            x, y = at(fr, h["s"] + arc[c][0], arc[c][1])
            row.append((x + nx * MULL_OFF, y + ny * MULL_OFF, z))
        grid.append(row)
    hw = MULL_W / 2
    for c in range(len(cols)):             # 竪向
        lv = [bm.verts.new((r[c][0] - tx * hw, r[c][1] - ty * hw, r[c][2])) for r in grid]
        rv = [bm.verts.new((r[c][0] + tx * hw, r[c][1] + ty * hw, r[c][2])) for r in grid]
        for k in range(len(grid) - 1):
            bm.faces.new((lv[k], rv[k], rv[k + 1], lv[k + 1])).smooth = True
    for r in grid:                         # 橫向
        lo = [bm.verts.new((p[0], p[1], p[2] - hw)) for p in r]
        hi = [bm.verts.new((p[0], p[1], p[2] + hw)) for p in r]
        for c in range(len(r) - 1):
            bm.faces.new((lo[c + 1], lo[c], hi[c], hi[c + 1])).smooth = True


# ---- 小型 bmesh 量體 -----------------------------------------------------------
def add_loft(bm, rings, top_mat=0, side_mat=0, smooth_sides=False):
    """逆時針點環 [(pts, z), ...] 由下往上接成側面，頂端封面。"""
    vs = [[bm.verts.new((x, y, z)) for x, y in pts] for pts, z in rings]
    n = len(vs[0])
    for lo, hi in zip(vs, vs[1:]):
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
            f.material_index = side_mat
            f.smooth = smooth_sides
    bm.faces.new(vs[-1]).material_index = top_mat


def add_annulus(bm, cx, cy, r_in, r_out, z0, z1, seg):
    """環形台階：頂面 + 內外側壁（頂面與側壁頂點分開，側壁平滑、頂面保持平）。"""
    o = L.circle(cx, cy, r_out, seg)
    n = L.circle(cx, cy, r_in, seg)
    top_o = [bm.verts.new((x, y, z1)) for x, y in o]
    top_i = [bm.verts.new((x, y, z1)) for x, y in n]
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((top_o[i], top_o[j], top_i[j], top_i[i]))
    for pts, outward in ((o, True), (n, False)):
        lo = [bm.verts.new((x, y, z0)) for x, y in pts]
        hi = [bm.verts.new((x, y, z1)) for x, y in pts]
        for i in range(seg):
            j = (i + 1) % seg
            quad = (lo[i], lo[j], hi[j], hi[i]) if outward else (lo[j], lo[i], hi[i], hi[j])
            bm.faces.new(quad).smooth = True


def mark_smooth_interior(ob, frames):
    """布林後：落在盒面（四面外牆 / 屋頂 / 底面）上的面維持平面著色，其餘（洞壁）改平滑。"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for f in bm.faces:
        cx, cy, cz = f.calc_center_median()
        on_box = cz < 0.02 or cz > H - 0.02 or any(
            abs(cx * fr["n"][0] + cy * fr["n"][1] - fr["c"]) < 0.02 for fr in frames)
        f.smooth = not on_box
    bm.to_mesh(ob.data)
    bm.free()


# ---- 主流程 --------------------------------------------------------------------
def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_white = L.mat("theater_white_wall", C_WHITE, roughness=0.5)
    m_cave = L.mat("theater_cave_wall", C_CAVE, roughness=0.6)
    m_glass = L.mat("theater_glass", C_GLASS, metallic=0.3, roughness=0.1)
    m_frame = L.mat("theater_mullion", C_FRAME, metallic=0.4, roughness=0.4)
    m_tower = L.mat("theater_stage_tower", C_TOWER, roughness=0.6)
    m_lawn = L.mat("theater_lawn", C_LAWN, roughness=0.9)
    m_sky_top = L.mat("theater_skylight_opening", C_SKY_TOP, roughness=0.5)
    m_pool = L.mat("theater_pool_water", C_POOL, metallic=0.1, roughness=0.05)
    m_post = L.mat("theater_pool_post", C_POST, roughness=0.5)
    m_pave = L.mat("theater_plaza_paving", C_PAVE, roughness=0.9)

    a_dir, b_dir = L.A_DIR, L.B_DIR
    fr_se = facade_frame(fp, b_dir)                        # 東南面（惠來路二段 / 前廣場）
    fr_nw = facade_frame(fp, (-b_dir[0], -b_dir[1]))       # 西北面
    fr_ne = facade_frame(fp, a_dir)                        # 東北短邊
    fr_sw = facade_frame(fp, (-a_dir[0], -a_dir[1]))       # 西南短邊
    frames = (fr_se, fr_nw, fr_ne, fr_sw)

    rng = random.Random(WAY_ID)

    def hole(fr, s, kind, scale=1.0, mullions=False):
        j = lambda v: v * (1 + rng.uniform(-JITTER, JITTER))
        depth = {"glass": DEPTH_GLASS, "cave": DEPTH_CAVE, "nw_cave": DEPTH_NW_CAVE}[kind]
        return dict(fr=fr, s=s, kind=kind, mullions=mullions,
                    wb=j(W_BOT * scale), ww=j(W_WAIST * scale), wt=j(W_TOP * scale),
                    zw=Z_WAIST + rng.uniform(-WAIST_JITTER, WAIST_JITTER),
                    depth=tuple(j(d) for d in depth),
                    p=P_GLASS if kind == "glass" else P_CAVE,
                    back=m_glass if kind == "glass" else m_cave)

    holes = []
    # 東南面：3 大洞 + 兩端轉角各半個（qiuhonggu §3 已確認）。面向立面時左、中為玻璃，右（東北側）為開放洞穴
    s0, s1 = fr_se["s0"], fr_se["s1"]
    ln = s1 - s0
    ne_is_high_s = fr_se["t"][0] * a_dir[0] + fr_se["t"][1] * a_dir[1] > 0
    open_k = 3 if ne_is_high_s else 1
    for k in range(5):
        s = s0 + ln * k / 4
        if k in (0, 4):
            holes.append(hole(fr_se, s, "glass"))                     # 轉角半洞：洞底型式推測
        elif k == open_k:
            holes.append(hole(fr_se, s, "cave"))
        else:
            holes.append(hole(fr_se, s, "glass", mullions=True))
    # 西北面 3 個、短邊 1–2 個：數量 / 型式查無 → 推測
    s0, s1 = fr_nw["s0"], fr_nw["s1"]
    for k, t in enumerate((0.2, 0.5, 0.8)):
        s = s0 + (s1 - s0) * (t + rng.uniform(-0.03, 0.03))
        holes.append(hole(fr_nw, s, "nw_cave" if k == 1 else "glass", SCALE_NW))
    holes.append(hole(fr_ne, (fr_ne["s0"] + fr_ne["s1"]) / 2, "glass", SCALE_SHORT))
    for t in (0.3, 0.7):
        holes.append(hole(fr_sw, fr_sw["s0"] + (fr_sw["s1"] - fr_sw["s0"]) * t, "glass", SCALE_SHORT))

    # ---- body：白色方盒被曲面管切穿 ------------------------------------------------
    body = L.prism(ctx, "body", "body_white_box", fp, 0, H, m_white, bottom=True)
    L.boolean_cut(body, [cutter(ctx, h, f"tube_cutter_{i}", m_white) for i, h in enumerate(holes)])
    mark_smooth_interior(body, frames)

    bm = bmesh.new()
    for h in holes:
        if h["mullions"]:
            add_mullions(bm, h)
    L._link(ctx, "body", "glass_mullion_grid", bm, m_frame)

    # 開放洞穴的地坪（布林把盒底一起挖掉，補一片鋪面讓地面可穿入）
    for i, h in enumerate(holes):
        if h["kind"] != "glass":
            arc = section(h, 0.0)[1]
            pts = [at(h["fr"], h["s"] + s, min(d, 0.0)) for s, d in arc]
            L.prism(ctx, "site", f"cave_floor_{i}", pts, 0, 0.05, m_pave)

    # ---- roof：草坪（同一組曲面管切出缺口）+ 採光筒 + 圓形鋪面 + 舞台塔 --------------------
    lawn = L.prism(ctx, "roof", "roof_lawn", L.offset(fp, -LAWN_INSET), H, H + LAWN_T, m_lawn, bottom=True)
    L.boolean_cut(lawn, [cutter(ctx, h, f"lawn_cutter_{i}", m_white) for i, h in enumerate(holes)])

    abs_ = [L.to_ab(x, y) for x, y in fp]
    bmin, bmax = min(p[0] for p in abs_), max(p[0] for p in abs_)
    amin, amax = min(p[1] for p in abs_), max(p[1] for p in abs_)
    bc, ac = (bmin + bmax) / 2, (amin + amax) / 2
    hb, ha = (bmax - bmin) / 2, (amax - amin) / 2

    towers = []
    for tag, tw in (("ne", TOWER_NE), ("sw", TOWER_SW)):
        b, a, r = bc + tw["b"], ac + tw["a"], tw["size"] / 2
        L.box_ab(ctx, "roof", f"stage_tower_{tag}", b - r, b + r, a - r, a + r, H, H + TOWER_H, m_tower)
        towers.append((b, a, r))

    db_, da_ = bc + ROOF_DISC["b"], ac + ROOF_DISC["a"]
    L.prism(ctx, "roof", "roof_white_disc", L.circle(*L.ab(db_, da_), ROOF_DISC["r"], 20),
            H + LAWN_T, H + LAWN_T + 0.05, m_white)

    bm = bmesh.new()
    placed = []
    for _ in range(3000):
        if len(placed) >= SKYLIGHTS:
            break
        rx = rng.uniform(*SKY_R)
        b = bc + rng.uniform(-hb + 9.0, hb - 20.0)       # 避開東南洞穴缺口（深 15 m）與其他面缺口
        a = ac + rng.uniform(-ha + 9.0, ha - 9.0)
        if any(abs(b - tb) < tr + rx + 1.5 and abs(a - ta) < tr + rx + 1.5 for tb, ta, tr in towers):
            continue
        if math.hypot(b - db_, a - da_) < ROOF_DISC["r"] + rx + 1.0:
            continue
        if any(math.hypot(b - pb, a - pa) < rx + pr + 1.5 for pb, pa, pr in placed):
            continue
        placed.append((b, a, rx))
        x, y = L.ab(b, a)
        ry, rot = rx * rng.uniform(0.6, 0.9), rng.uniform(0, math.pi)
        add_loft(bm, [(L.circle(x, y, ry, 12, rx=rx, rot=rot), H),
                      (L.circle(x, y, ry * 0.72, 12, rx=rx * 0.72, rot=rot), H + LAWN_T + SKY_H)],
                 top_mat=1, side_mat=0, smooth_sides=True)
    L._link(ctx, "roof", "roof_skylight_craters", bm, [m_white, m_sky_top])

    # ---- site：東南前廣場 + 橢圓淺水池 + 紅樁；西南角同心圓階梯草坪劇場 --------------------
    s0, s1 = fr_se["s0"], fr_se["s1"]
    plaza = [at(fr_se, s0, 0), at(fr_se, s1, 0), at(fr_se, s1, PLAZA_D), at(fr_se, s0, PLAZA_D)]
    L.prism(ctx, "site", "southeast_plaza_paving", plaza, 0, 0.05, m_pave)
    px, py = at(fr_se, (s0 + s1) / 2, POOL["d"])
    rot = math.atan2(fr_se["t"][1], fr_se["t"][0])     # 長軸沿立面
    L.prism(ctx, "site", "plaza_oval_pool", L.circle(px, py, POOL["rb"], 28, rx=POOL["ra"], rot=rot),
            0.05, 0.12, m_pool)
    bm = bmesh.new()
    for x, y in L.circle(px, py, POOL["rb"] + 0.6, POSTS, rx=POOL["ra"] + 0.6, rot=rot):
        add_loft(bm, [(L.circle(x, y, POST_R, 5), 0.05), (L.circle(x, y, POST_R, 5), 0.05 + POST_H)])
    L._link(ctx, "site", "pool_red_posts", bm, m_post)

    ax, ay = at(fr_sw, (fr_sw["s0"] + fr_sw["s1"]) / 2, AMPHI["d"])
    L.prism(ctx, "site", "amphitheater_stage", L.circle(ax, ay, AMPHI["r0"], 16), 0, 0.05, m_pave)
    bm = bmesh.new()
    for k in range(AMPHI["rings"]):
        r_in = AMPHI["r0"] + AMPHI["step"] * k
        add_annulus(bm, ax, ay, r_in, r_in + AMPHI["step"], 0.0, AMPHI["rise"] * (k + 1), 18)
    L._link(ctx, "site", "amphitheater_lawn_steps", bm, m_lawn)

    notes = ("高 37.7 m（官方，qiuhonggu §3 已確認）。平直白盒 #EDEDEA 被 12 條曲面管切穿，立面洞口為酒瓶 / 沙漏形"
             "（落地寬、約 0.42H 收腰、屋頂線弧形缺口）；洞口尺寸寬 24 / 腰 13.5 / 上 25 m 為 Google 3D 估算。"
             "東南面 3 大洞 + 兩端轉角半洞已確認：左、中為灰藍玻璃 + 深色方格竪框，右為開放洞穴（深約 15 m，估算）；"
             "轉角半洞洞底型式推測。西北面 3 個、東北 1 個、西南 2 個洞口為推測（§3 查無），尺寸以固定種子擾動。"
             "屋頂草坪、13 個白色火山口狀採光筒、白色圓形鋪面、兩座深灰舞台塔（23 / 22 m 見方，估算）已確認存在；"
             "舞台塔高出屋頂 8 m 與位置為推測。前廣場淺藍橢圓水池約 30 × 22 m（估算）+ 紅色池緣樁、"
             "西南角同心圓階梯草坪劇場已確認存在，位置 / 尺寸推測。防火水幕噴頭小圓點省略。")
    return L.finish(ctx, H, "official", notes, L.B_DIR)


if __name__ == "__main__":
    build()
