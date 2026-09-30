"""臺中GTA 主角（玩家角色）：依用戶提供的全身照打扮建模，身高 1.86 m。

執行：blender -b -P tools/blender/characters/hero.py
      （設 CHAR_PREVIEW_SCRATCH=<目錄> 會另外輸出全 clip 蒙皮檢查拼圖 hero-clips.png 到該目錄）
產出：public/models/characters/hero.glb、assets/blender/characters/hero.blend、hero_jeans.jpg（程序生成牛仔褲刷色）、
      manifest.json 的 hero 一筆（role: player）、docs/models/previews/hero-*.png
依據（照片目視）：瘦高、偏白膚色；深棕中分及肩直髮（髮尾外翹、額頭兩側露出）；深灰 / 黑寬橫條紋連帽上衣
      （七分袖、V 領、兩條帽繩、帽子垂在背後）；淺藍水洗直筒牛仔褲（大腿正面較淺、褲腳堆疊）；黑鞋；招牌姿勢＝本人右手插腰。
臉部貼圖：assets/blender/characters/hero_face.jpg（照片裁臉 → 本機 qwen-edit 清晰化 → 雙眼水平、鼻樑置中對齊 →
      低頻膚色拉平 → 橢圓羽化到膚色；羽化外圈顏色＝skin 材質色）。原始照片不入 repo。
骨架：與行人相同的 19 根骨頭與骨名 / 階層 / 朝向，只是關節高度依 1.86 m 比例重排；10 個 clip 同名同長度，另加循環 clip「idle_pose」。
"""
import json
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import char_lib as C  # noqa: E402

# ---- 比例：基準 1.75 m 的高度 → 主角 1.86 m（腿 +0.07、軀幹 +0.04、頭頸以上平移 +0.11） ---------------------
C.set_proportions([(0.0, 0.0), (0.09, 0.09), (0.50, 0.535), (0.92, 0.99), (0.95, 1.02), (1.05, 1.13),
                   (1.22, 1.32), (1.45, 1.56), (1.555, 1.665)])
import build_characters as BC  # noqa: E402  （clip 關鍵影格函式在呼叫時讀 C 的新比例）
import combat_clips as CC  # noqa: E402

C.MAT_SLOTS.extend(["shirt_stripe", "face"])
V, R = C.V, C.R
SLUG = "hero"
HEIGHT = 1.86
DZ = 0.11                       # 頭部平移量
K = 0.001714                    # 照片比例尺：全身 1085 px ≈ 1.86 m（估算）
TEX_DIR = os.path.join(BC.REPO, "assets", "blender", "characters")
FACE_TEX = os.path.join(TEX_DIR, "hero_face.jpg")
JEANS_TEX = os.path.join(TEX_DIR, "hero_jeans.jpg")
# 臉部貼圖對位（貼圖 512 px：雙眼 y=172 px、瞳距 141 px、下巴 y≈425 px；中線 u=0.5）
EYE_Z = 1.648 + DZ              # 模型眼睛高度
V_EYE = 1 - 172 / 512
TEX_SU = 0.225                  # 貼圖寬 1.0 對應公尺（瞳距 0.062 m / 0.275）
TEX_SV = 0.223                  # 貼圖高 1.0 對應公尺（眼到下巴 0.110 m / 0.494）
FACE_EL = (-0.027, 0.0769, 0.0958)   # 貼圖羽化橢圓（中心相對眼高、半寬、半高，公尺）；外側貼圖＝純膚色

COLORS = dict(skin="#EDBFA8",           # 臉部貼圖羽化外圈的實際膚色（兩者一致，face / skin 交界無色差）
              shirt="#56606B", shirt_stripe="#1D1F23", pants="#9DB4CC", hair="#3A2A20", shoes="#141414")
G = dict(arm=1.07, leg=1.18, torso=0.95, hip=0.95, chest=0.92, belly=0.9,
         shoulder=0.93, neck=1.0, shoe=1.05, hand=1.15, sleeve=0.45, delt_in=0.0)


def zph(y_px):
    """照片縱座標（px）→ 模型高度。"""
    return (1235 - y_px) * K


# 上衣橫條紋（照片目視，高度＝照片 px 換算）：肩→胸上灰、胸黑、腹灰、腰黑、下擺灰
HEM = zph(670)
BLACK_BANDS = [(zph(452), zph(380)), (zph(585), zph(525))]
SLEEVE_BLACK = [(0.09, 0.21), (0.33, 0.40)]    # 袖子條紋：由肩往手腕的沿臂距離（公尺）
SLEEVE_END = 0.47


def band(z):
    if z < HEM:
        return "pants"
    return "shirt_stripe" if any(a <= z < b for a, b in BLACK_BANDS) else "shirt"


def lerpw(w0, w1, t):
    out = {}
    for k in set(w0) | set(w1):
        out[k] = w0.get(k, 0) * (1 - t) + w1.get(k, 0) * t
    return {k: v for k, v in out.items() if v > 1e-4}


def catmull(rows, z, cols):
    """rows = [(z, v1, v2, ...)] 依 z 遞增；回傳 z 處各欄的 Catmull-Rom 內插值（平滑剖面）。"""
    n = len(rows)
    i = max(0, min(n - 2, max(k for k in range(n - 1) if rows[k][0] <= z) if z >= rows[0][0] else 0))
    p0, p1, p2, p3 = rows[max(i - 1, 0)], rows[i], rows[i + 1], rows[min(i + 2, n - 1)]
    t = max(0.0, min(1.0, (z - p1[0]) / (p2[0] - p1[0])))
    out = []
    for c in cols:
        a, b, cc, d = p0[c], p1[c], p2[c], p3[c]
        out.append(0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t * t + (-a + 3 * b - 3 * cc + d) * t ** 3))
    return out


def pl(pts, x):
    """分段線性。pts = [(x, y)] 依 x 遞增。"""
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


# ---------------------------------------------------------------- 軀幹（條紋分段）+ 頸 + V 領 + 帽繩 + 帽兜
def build_torso(B):
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    g = G
    base = [(0.835, 0.095 * g["hip"], 0.065, 0.075, {"Hips": 1}),
            (0.885, 0.160 * g["hip"], 0.098, 0.112 * g["hip"], {"Hips": 1}),
            (0.970, 0.166 * g["hip"], 0.100, 0.108 * g["hip"], {"Hips": 1}),
            (1.035, 0.150 * g["torso"], 0.094, 0.098, {"Hips": .55, "Spine": .45}),
            (1.110, 0.140 * g["torso"], 0.090, 0.090, {"Spine": 1}),
            (1.200, 0.150 * g["torso"], 0.095, 0.096, {"Spine": .5, "Chest": .5}),
            (1.290, 0.162 * g["torso"], 0.104, 0.100, {"Chest": 1}),
            (1.360, 0.172 * g["shoulder"], 0.103, 0.098, {"Chest": 1}),
            (1.400, 0.162 * g["shoulder"], 0.095, 0.093, {"Chest": 1}),
            (1.430, 0.136 * g["shoulder"], 0.082, 0.082, {"Chest": .95, "Neck": .05}),
            (1.458, 0.104, 0.066, 0.070, {"Chest": .8, "Neck": .2}),
            (1.482, 0.080, 0.058, 0.062, {"Chest": .5, "Neck": .5})]
    rows = [(C.Z(z), rx, rf, rb, w) for z, rx, rf, rb, w in base]

    def at(z):
        i = max(k for k in range(len(rows) - 1) if rows[k][0] <= z) if z > rows[0][0] else 0
        a, b = rows[i], rows[min(i + 1, len(rows) - 1)]
        t = (z - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0
        rx, rf, rb = catmull(rows, z, (1, 2, 3))
        return z, rx, rf, rb, lerpw(a[4], b[4], max(0, min(1, t)))
    key = sorted({r[0] for r in rows} | {HEM, HEM + 0.001} | {z for bnd in BLACK_BANDS for z in bnd})
    zs = sorted(set(key) | {(a + b) / 2 for a, b in zip(key, key[1:]) if b - a > 0.03})
    rings = []
    for i, z in enumerate(zs):
        z_, rx, rf, rb, w = at(z)
        loose = 1.0 if z < HEM + 0.0005 else (1.07 if z < HEM + 0.01 else 1.03)   # 上衣略寬鬆、下擺外擴
        mid = (z + zs[i + 1]) / 2 if i + 1 < len(zs) else z
        rings.append(R(V(0, 0, z), up, fwd, rx * loose, rf * loose, rb * loose, w, band(mid)))
    B.loft(rings, n=32, cap0=0.02, cap1=0.0)
    B.loft([R(V(0, 0.004, C.Z(1.43)), up, fwd, 0.062, 0.054, 0.060, {"Chest": .5, "Neck": .5}, "skin"),
            R(V(0, 0.006, C.Z(1.50)), up, fwd, 0.058, 0.051, 0.056, {"Neck": 1}, "skin"),
            R(V(0, 0.010, C.Z(1.565)), up, fwd, 0.056, 0.049, 0.054, {"Neck": .4, "Head": .6}, "skin")], n=16)
    # V 領：胸前露膚三角 + 兩側滾邊
    zt, zb = C.Z(1.47), C.Z(1.385)
    fy = lambda z: -at(z)[2] * 1.03 - 0.004
    W = {"Chest": .8, "Neck": .2}
    tl, bt, tr = V(0.052, fy(zt) + 0.012, zt), V(0.0, fy(zb), zb), V(-0.052, fy(zt) + 0.012, zt)
    vs = [B.bm.verts.new(p) for p in (tl, bt, tr)]
    for v in vs:
        B._w(v, W)
    B.bm.faces.new(vs).material_index = C.MAT_SLOTS.index("skin")
    for a in (tl, tr):
        mid = (a + bt) / 2 + V(0, -0.003, 0)
        B.loft([R(a, bt - a, fwd, 0.005, 0.004, 0.004, W, "shirt"), R(mid, bt - a, fwd, 0.006, 0.005, 0.005, W, "shirt"),
                R(bt + (a - bt).normalized() * 0.004, bt - a, fwd, 0.005, 0.004, 0.004, W, "shirt")], n=6, cap0=0.003, cap1=0.003)
    # 兩條帽繩：由領口兩側垂到胸下，末端金屬頭（右側較長，照片）
    for s, drop in ((1, 0.20), (-1, 0.24)):
        pts = [V(s * 0.036, fy(zt) + 0.006, zt - 0.005)]
        for k in (0.25, 0.5, 0.75, 1.0):
            z = zt - drop * k
            pts.append(V(s * (0.037 + 0.006 * k), fy(z) - 0.007 - 0.004 * k, z))
        Wc = {"Chest": 1}
        rr = [R(p, (pts[min(i + 1, 4)] - pts[max(i - 1, 0)]), fwd, 0.0035, 0.0035, 0.0035, Wc, "shirt") for i, p in enumerate(pts)]
        rr.append(R(pts[-1] + V(0, 0, -0.004), V(0, 0, -1), fwd, 0.0055, 0.0055, 0.0055, Wc, "shirt_stripe"))
        rr.append(R(pts[-1] + V(0, 0, -0.020), V(0, 0, -1), fwd, 0.0050, 0.0050, 0.0050, Wc, "shirt_stripe"))
        B.loft(rr, n=6, cap1=0.003)
    # 背後帽兜：頂端深色開口、中段鼓起垂墜、下端收成尖
    hood = [(1.478, 0.080, 0.010, 0.025, 0.066, "shirt_stripe"), (1.472, 0.094, 0.014, 0.036, 0.072, "shirt"),
            (1.445, 0.114, 0.018, 0.052, 0.080, "shirt"), (1.410, 0.121, 0.020, 0.063, 0.086, "shirt"),
            (1.370, 0.117, 0.020, 0.066, 0.090, "shirt"), (1.330, 0.100, 0.018, 0.058, 0.091, "shirt"),
            (1.300, 0.070, 0.014, 0.040, 0.089, "shirt"), (1.282, 0.030, 0.008, 0.016, 0.085, "shirt")]
    B.loft([R(V(0, cy, C.Z(z)), up, fwd, rx, rf, rb, {"Chest": .7, "Neck": .3} if i < 2 else {"Chest": 1}, m)
            for i, (z, rx, rf, rb, cy, m) in enumerate(hood)], n=16, cap0=0.02, cap1=0.006)


# ---------------------------------------------------------------- 七分袖手臂 + 分指手掌
def build_arm(B, side):
    S = "Left" if side > 0 else "Right"
    fwd = V(0, -1, 0)
    sh, el = V(*C.JOINTS[S + "UpperArm"][0]), V(*C.JOINTS[S + "LowerArm"][0])
    wr, tip = V(*C.JOINTS[S + "Hand"][0]), V(*C.JOINTS[S + "Hand"][1])
    UA, LA, HD, SH = S + "UpperArm", S + "LowerArm", S + "Hand", S + "Shoulder"
    a = G["arm"]
    lu, lf = (el - sh).length, (wr - el).length

    def pos(s):   # 沿臂距離 s → 位置、軸向、權重（肘前後各一段漸層）
        if s <= lu:
            t = s / lu
            w = {UA: 1} if t < 0.85 else {UA: 1 - (t - 0.85) / 0.3, LA: (t - 0.85) / 0.3}
            return sh + (el - sh) * t, el - sh, w
        t = (s - lu) / lf
        w = {UA: max(0.5 - t * 3.3, 0), LA: min(0.5 + t * 3.3, 1)} if t < 0.15 else ({LA: 1} if t < 0.88 else {LA: 1 - (t - 0.88) * 4, HD: (t - 0.88) * 4})
        return el + (wr - el) * t, wr - el, {k: v for k, v in w.items() if v > 0}

    def sleeve_mat(s):
        return "shirt_stripe" if any(a0 <= s < a1 for a0, a1 in SLEEVE_BLACK) else "shirt"
    cuts = sorted({-0.025, 0.0, 0.02, 0.05, 0.14, 0.2, 0.26, lu - 0.03, lu, lu + 0.03, 0.42, SLEEVE_END - 0.015, SLEEVE_END - 0.004, SLEEVE_END}
                  | {x for bnd in SLEEVE_BLACK for x in bnd})
    rings = []
    for i, s in enumerate(cuts):
        p, ax, w = pos(max(s, 0.0))
        if s < 0:
            p = sh + V(-side * 0.026, 0, -0.012)        # 肩頭收進軀幹，不外凸成墊肩
            w = {SH: .6, UA: .4}
        elif s < 0.03:
            w = {SH: .35 * (1 - s / 0.03), **{UA: 1 - .35 * (1 - s / 0.03)}}
        r = ((0.036 + 0.011 * min(max(s + 0.025, 0) / 0.05, 1)) if s < 0.03 else (0.047 if s < lu else 0.047 - (s - lu) * 0.05))
        if s >= SLEEVE_END - 0.005:
            r += 0.004            # 七分袖口微外擴、有收邊
        mid = (s + cuts[i + 1]) / 2 if i + 1 < len(cuts) else s
        rings.append(R(p, ax, fwd, r * a, r * a * 0.97, r * a * 0.97, w, sleeve_mat(mid)))
    for s, r in ((SLEEVE_END + 0.002, 0.033), (lu + lf * 0.55, 0.031), (lu + lf * 0.85, 0.027), (lu + lf * 1.01, 0.024)):
        p, ax, w = pos(s)
        rings.append(R(p, ax, fwd, r * a, r * a * 0.9, r * a * 0.9, w, "skin"))
    rings[len(cuts) - 1]["m"] = "shirt_stripe"          # 袖口內側陰影
    B.loft(rings, n=24, cap0=0.012, cap1=0.01)
    # 手掌（掌心朝身體）→ 四指（兩個指節、指尖內勾、指縫分開）+ 分離的拇指
    hd = tip - wr
    k = G["hand"]
    inward = V(-side, 0, 0)
    H = {HD: 1}
    B.loft([R(wr + hd * 0.02, hd, inward, 0.027 * k, 0.017 * k, 0.017 * k, {LA: .3, HD: .7}, "skin"),
            R(wr + hd * 0.22, hd, inward, 0.037 * k, 0.019 * k, 0.018 * k, H, "skin"),
            R(wr + hd * 0.40, hd, inward, 0.043 * k, 0.019 * k, 0.017 * k, H, "skin"),
            R(wr + hd * 0.52, hd, inward, 0.043 * k, 0.015 * k, 0.013 * k, H, "skin")], n=12, cap1=0.004)
    wdir = hd.cross(inward).normalized()   # 手掌寬度方向
    dn = hd.normalized()
    for j, off in enumerate((-0.028, -0.0095, 0.009, 0.026)):
        ln = (0.075, 0.085, 0.080, 0.064)[j] * k
        d = (dn + wdir * off * 1.2).normalized()      # 四指微微張開
        b0 = wr + hd * 0.50 + wdir * off * k
        p1 = b0 + d * ln * 0.42 + inward * 0.004
        p2 = b0 + d * ln * 0.74 + inward * 0.011
        p3 = b0 + d * ln + inward * 0.019
        rr = 0.0086 * k
        B.loft([R(b0, d, inward, rr, rr * .95, rr * .95, H, "skin"),
                R((b0 + p1) / 2, p1 - b0, inward, rr * 0.9, rr * .85, rr * .85, H, "skin"),
                R(p1, p2 - b0, inward, rr * 0.98, rr * .92, rr * .92, H, "skin"),
                R((p1 + p2) / 2, p2 - p1, inward, rr * 0.85, rr * .8, rr * .8, H, "skin"),
                R(p2, p3 - p1, inward, rr * 0.88, rr * .82, rr * .82, H, "skin"),
                R(p3, p3 - p2, inward, rr * 0.72, rr * .68, rr * .68, H, "skin")], n=8, cap1=0.006)
    th0 = wr + hd * 0.15 + wdir * (-0.032 * k) + inward * 0.008
    th1 = th0 + dn * 0.036 + wdir * (-0.020) + inward * 0.013
    th2 = th1 + dn * 0.028 + wdir * (-0.004) + inward * 0.010
    B.loft([R(th0, th1 - th0, inward, 0.013, 0.012, 0.012, H, "skin"),
            R((th0 + th1) / 2, th1 - th0, inward, 0.0115, 0.0105, 0.0105, H, "skin"),
            R(th1, th2 - th0, inward, 0.0110, 0.0100, 0.0100, H, "skin"),
            R(th2, th2 - th1, inward, 0.0085, 0.0078, 0.0078, H, "skin")], n=8, cap1=0.007)


# ---------------------------------------------------------------- 直筒牛仔褲（褲腳堆疊）+ 分層鞋
def build_leg(B, side):
    S = "Left" if side > 0 else "Right"
    fwd = V(0, -1, 0)
    hp, kn, an = (V(*C.JOINTS[S + b][0]) for b in ("UpperLeg", "LowerLeg", "Foot"))
    UL, LL, FT = S + "UpperLeg", S + "LowerLeg", S + "Foot"
    l = G["leg"]
    d1, d2 = kn - hp, an - kn
    spec = [(hp - d1 * 0.12 + V(-side * 0.015, 0, 0), d1, 0.080, 0.075, 0.085, {"Hips": .55, UL: .45}),
            (hp + d1 * 0.10, d1, 0.088, 0.082, 0.090, {UL: .85, "Hips": .15}),
            (hp + d1 * 0.28, d1, 0.082, 0.079, 0.082, {UL: 1}),
            (hp + d1 * 0.48, d1, 0.073, 0.073, 0.070, {UL: 1}),
            (hp + d1 * 0.68, d1, 0.063, 0.064, 0.060, {UL: 1}),
            (hp + d1 * 0.86, d1, 0.056, 0.058, 0.054, {UL: .85, LL: .15}),
            (kn - d1 * 0.02, d1, 0.054, 0.059, 0.052, {UL: .5, LL: .5}),
            (kn + d2 * 0.08, d2, 0.053, 0.055, 0.054, {UL: .2, LL: .8}),
            (kn + d2 * 0.30, d2, 0.053, 0.050, 0.058, {LL: 1}),
            (kn + d2 * 0.55, d2, 0.050, 0.049, 0.052, {LL: 1}),
            (kn + d2 * 0.74, d2, 0.049, 0.048, 0.049, {LL: 1}),
            # 褲腳堆疊：鼓 / 收交錯，最後蓋住鞋面
            (kn + d2 * 0.82, d2, 0.053, 0.052, 0.052, {LL: 1}),
            (kn + d2 * 0.87, d2, 0.049, 0.048, 0.049, {LL: 1}),
            (kn + d2 * 0.92, d2, 0.055, 0.054, 0.054, {LL: .95, FT: .05}),
            (kn + d2 * 0.97, d2, 0.050, 0.050, 0.051, {LL: .9, FT: .1}),
            (an + V(0, 0.004, -0.008), d2, 0.055, 0.056, 0.054, {LL: .85, FT: .15}),
            (an + V(0, 0.008, -0.026), d2, 0.052, 0.054, 0.050, {LL: .8, FT: .2})]
    rings = [R(c, ax, fwd, rx * l, rf * l, rb * l, w, "pants") for c, ax, rx, rf, rb, w in spec]
    rings[-1]["m"] = "shirt_stripe"      # 褲管內側（封口）暗色
    B.loft(rings, n=20, cap0=0.0, cap1=-0.02)
    # 鞋面（沿 −Y 放樣）＋ 外凸一圈的鞋底（兩層）
    up, ax = V(0, 0, 1), V(0, -1, 0)
    x, sw = an.x, G["shoe"]
    upper = [(0.060, 0.045, 0.030, 0.025, 0.030), (0.048, 0.050, 0.042, 0.040, 0.048), (0.020, 0.053, 0.045, 0.046, 0.051),
             (0.000, 0.052, 0.045, 0.045, 0.050), (-0.040, 0.047, 0.047, 0.038, 0.045), (-0.080, 0.041, 0.048, 0.030, 0.039),
             (-0.120, 0.037, 0.047, 0.026, 0.035), (-0.155, 0.034, 0.042, 0.021, 0.032), (-0.178, 0.032, 0.030, 0.016, 0.029)]
    B.loft([R(V(x, an.y + dy, z), ax, up, rx * sw, rf, rb, {FT: 1}, "shoes") for dy, z, rx, rf, rb in upper],
           n=16, cap0=0.004, cap1=0.010)
    sole = [(0.068, 0.028), (0.050, 0.046), (0.0, 0.050), (-0.080, 0.052), (-0.150, 0.047), (-0.182, 0.032), (-0.188, 0.020)]
    B.loft([R(V(x, an.y + dy, 0.009), ax, up, rx * sw + 0.004, 0.011, 0.009, {FT: 1}, "shirt_stripe") for dy, rx in sole],
           n=12, cap0=0.003, cap1=0.003)


# ---------------------------------------------------------------- 頭（網格頭 + 五官起伏，臉部貼圖正面投影）
HEAD_ROWS = [(1.538, .030, .028, .030, -.030), (1.548, .048, .052, .040, -.018), (1.562, .060, .068, .055, -.010),
             (1.585, .069, .082, .072, -.004), (1.610, .075, .088, .082, 0.0), (1.635, .078, .092, .090, 0.0),
             (1.660, .081, .094, .097, 0.0), (1.685, .083, .092, .100, 0.0), (1.708, .080, .086, .098, 0.0),
             (1.728, .068, .072, .086, 0.0)]
NOSE_H = [(-0.056, 0.0), (-0.050, 0.004), (-0.044, 0.012), (-0.036, 0.016), (-0.020, 0.010), (0.0, 0.004), (0.015, 0.0)]
NOSE_W = [(-0.050, 0.016), (-0.036, 0.011), (-0.020, 0.008), (0.015, 0.006)]


def face_relief(x, zr):
    """臉部起伏（往前凸的公尺數）：x = 橫向、zr = 相對眼高。"""
    e = math.exp
    ax = abs(x)
    h = pl(NOSE_H, zr) * e(-(x / pl(NOSE_W, zr)) ** 2)
    h += 0.005 * e(-((ax - 0.016) / 0.006) ** 2 - ((zr + 0.045) / 0.006) ** 2)      # 鼻翼
    h -= 0.004 * e(-((ax - 0.031) / 0.013) ** 2 - (zr / 0.009) ** 2)               # 眼窩
    h += 0.003 * e(-((ax - 0.030) / 0.020) ** 2 - ((zr - 0.020) / 0.007) ** 2)     # 眉骨
    h += 0.004 * e(-(x / 0.022) ** 2 - ((zr + 0.066) / 0.009) ** 2)                # 唇
    h += 0.004 * e(-(x / 0.020) ** 2 - ((zr + 0.100) / 0.010) ** 2)                # 下巴
    h += 0.003 * e(-((ax - 0.048) / 0.014) ** 2 - ((zr + 0.020) / 0.012) ** 2)     # 顴骨
    return h


def build_head(B):
    H = {"Head": 1}
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    NA, NZ = 40, 30
    phis = [math.pi * (0.4 * u + 0.6 * u ** 3) for u in (-1 + 2 * j / NA for j in range(NA))]   # 正面較密
    z0, z1 = HEAD_ROWS[0][0], HEAD_ROWS[-1][0]
    grid = []
    for i in range(NZ):
        z = z0 + (z1 - z0) * i / (NZ - 1)
        rx, rf, rb, cf = catmull(HEAD_ROWS, z, (1, 2, 3, 4))
        ring = []
        for ph in phis:
            c, s = math.cos(ph), math.sin(ph)
            x = rx * s
            y = -((rf if c > 0 else rb) * c + cf)
            if c > 0:
                y -= face_relief(x, z + DZ - EYE_Z) * min(1.0, c * 1.5)
            v = B.bm.verts.new((x, y, z + DZ))
            B._w(v, H)
            ring.append(v)
        grid.append(ring)
    si = C.MAT_SLOTS.index("skin")
    for a, b in zip(grid, grid[1:]):
        for j in range(NA):
            k = (j + 1) % NA
            B.bm.faces.new((a[j], a[k], b[k], b[j])).material_index = si
    for ring, zc, yc in ((grid[0], z0 + DZ - 0.004, 0.030), (grid[-1], z1 + DZ + 0.012, 0.0)):
        cen = B.bm.verts.new((0, yc, zc))
        B._w(cen, H)
        for j in range(NA):
            B.bm.faces.new((ring[j], ring[(j + 1) % NA], cen)).material_index = si
    for sx in (1, -1):     # 耳（多半被頭髮蓋住）
        B.loft([R(V(sx * 0.076, 0.004, 1.628 + DZ), V(sx, 0, 0), up, 0.014, 0.026, 0.022, H, "skin"),
                R(V(sx * 0.090, 0.010, 1.630 + DZ), V(sx, 0.25, 0), up, 0.012, 0.024, 0.020, H, "skin")],
               n=10, cap1=0.004)


def face_uv(ob):
    """正面投影 UV；貼圖羽化橢圓（外擴 5%）內的正面改用 face 材質，其外貼圖本身已是純膚色，交界無接縫。"""
    me = ob.data
    uv = me.uv_layers.new(name="UVMap")
    for lp in me.loops:
        co = me.vertices[lp.vertex_index].co
        uv.data[lp.index].uv = (0.5 + co.x / TEX_SU, V_EYE + (co.z - EYE_Z) / TEX_SV)
    fi, si = C.MAT_SLOTS.index("face"), C.MAT_SLOTS.index("skin")
    zc, ex, ez = FACE_EL
    for p in me.polygons:
        c = p.center
        if p.material_index == si and c.y < -0.02 and (c.x / ex) ** 2 + ((c.z - EYE_Z - zc) / ez) ** 2 < 1.1:
            p.material_index = fi


# ---------------------------------------------------------------- 頭髮：頭蓋 + 髮束（中分、及肩、髮尾外翹）
HA, HF, HB, HZ0, HTOP = 0.098, 0.100, 0.113, 1.770, 1.862


def hair_pt(phi, z, extra=0.0):
    """頭髮外殼上的點：phi = 0 正面、90° = 角色左側（+X）。"""
    s = math.sqrt(max(0.0, 1 - ((z - HZ0) / (HTOP - HZ0 + 0.004)) ** 2)) if z > HZ0 else 1.0
    flare = 1.0 + 0.10 * max(0.0, min(1.0, (1.63 - z) / 0.04)) ** 1.5 if z < 1.63 else 1.0
    c = math.cos(phi)
    x = HA * math.sin(phi)
    y = -(HF if c > 0 else HB) * c + 0.004
    k = (s + extra / 0.1) * flare
    return V(x * k, y * k, z)


def build_hair(B):
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    H = {"Head": 1}
    # 頭蓋：前額髮際較高、後腦較低；頂部圓順（無尖角）
    cap = [(1.770, 0.095, 0.098, 0.109, 0.056), (1.800, 0.094, 0.096, 0.108, 0.040), (1.825, 0.086, 0.088, 0.099, 0.024),
           (1.844, 0.068, 0.070, 0.080, 0.010), (1.856, 0.042, 0.043, 0.050, 0.003)]
    B.loft([R(V(0, 0.004, z), up, fwd, rx, rf, rb, H, "hair", tilt=tl) for z, rx, rf, rb, tl in cap], n=32, cap1=0.006)

    def lock(path, width, thick=0.006):
        rings = []
        n = len(path)
        for i, (phi, z, ex) in enumerate(path):
            p = hair_pt(phi, z, ex * 0.4 + 0.003)
            q = hair_pt(path[min(i + 1, n - 1)][0], path[min(i + 1, n - 1)][1], path[min(i + 1, n - 1)][2] + 0.006)
            o = hair_pt(path[max(i - 1, 0)][0], path[max(i - 1, 0)][1], path[max(i - 1, 0)][2] + 0.006)
            ax = (q - o) if (q - o).length > 1e-5 else V(0, 0, -1)
            radial = (p - V(0, 0.004, min(z, HZ0) - 0.02)).normalized()   # 頭皮法線：寬度沿頭皮切向
            grow = 0.3 if i == 0 else (0.7 if i == 1 else 1.0)            # 起點收窄埋進頭蓋，頭頂不冒尖
            w = H if z > 1.70 else {"Head": 0.65, "Neck": 0.35}
            rings.append(R(p, ax, radial, width * grow * (1.0 - 0.3 * (i / (n - 1))), thick * min(grow, 1), thick, w, "hair"))
        B.loft(rings, n=8, cap0=0.002, cap1=0.003)

    d = math.radians
    # 中分前髮：由頭頂分線往兩側蓋過額角、沿臉側垂到下顎、髮尾外翹（額頭中央露出）
    for s in (1, -1):
        lock([(s * d(12), 1.846, -0.010), (s * d(24), 1.836, 0.002), (s * d(42), 1.800, 0.007),
              (s * d(60), 1.748, 0.010), (s * d(70), 1.690, 0.012), (s * d(74), 1.630, 0.016),
              (s * d(80), 1.598, 0.034)], 0.040, 0.014)
        lock([(s * d(18), 1.842, -0.010), (s * d(38), 1.822, 0.005), (s * d(74), 1.762, 0.010),
              (s * d(88), 1.690, 0.012), (s * d(92), 1.630, 0.014), (s * d(96), 1.590, 0.036)], 0.045)
    # 側面與後方髮束：及肩、每束角度與長度略有差異
    for i, deg in enumerate(range(110, 251, 20)):
        jit = (0.012, -0.008, 0.015, 0.0, -0.01, 0.01, -0.006, 0.008)[i % 8]
        ph = d(deg)
        lock([(ph * 0.85, 1.840, -0.012), (ph, 1.818, 0.004), (ph, 1.760, 0.008), (ph, 1.690, 0.010),
              (ph, 1.630 + jit, 0.010), (ph, 1.590 + jit, 0.030)], 0.075)


# ---------------------------------------------------------------- 牛仔褲程序貼圖 + UV
def make_jeans_tex():
    """128×256 刷色：大腿正面較淺、膝蓋微白、後側較深、內外側縫線、縱向織紋、褲腳堆疊摺痕、腰頭。
    u：0.5＝褲管正面、0.25 / 0.75＝兩側縫、0 / 1＝後方；v＝高度 / 1.05 m。"""
    import numpy as np
    W, H = 128, 256
    rng = np.random.RandomState(7)
    u = (np.arange(W) + 0.5)[None, :] / W
    z = ((np.arange(H) + 0.5)[:, None] / H) * 1.05
    base = np.array([0.58, 0.67, 0.77])
    front = np.exp(-((u - 0.5) / 0.14) ** 2)
    thigh = np.exp(-((z - 0.68) / 0.09) ** 2) * front * 0.42 + np.exp(-((z - 0.50) / 0.05) ** 2) * front * 0.15
    back = np.exp(-(np.minimum(u, 1 - u) / 0.16) ** 2) * 0.10
    col = base[None, None, :] + (np.array([0.93, 0.95, 0.97]) - base)[None, None, :] * thigh[:, :, None]
    col = col * (1 - back[:, :, None])
    streak = np.convolve(rng.normal(0, 1, W), np.ones(3) / 3, "same")[None, :] * 0.025
    col = col * (1 + streak[:, :, None] + rng.normal(0, 0.018, (H, W, 1)))
    seam = (np.exp(-((u - 0.25) / 0.012) ** 2) + np.exp(-((u - 0.75) / 0.012) ** 2)) * 0.22
    col = col * (1 - seam[:, :, None])
    stack = np.clip((0.22 - z) / 0.08, 0, 1) * (0.5 + 0.5 * np.sin(z * 2 * np.pi / 0.033 + u * 2.0)) * 0.16
    col = col * (1 - stack[:, :, None])
    waist = np.clip((z - 0.935) / 0.01, 0, 1) * 0.12
    col = np.clip(col * (1 - waist[:, :, None]), 0, 1)
    img = bpy.data.images.new("hero_jeans_gen", W, H)
    img.pixels.foreach_set(np.concatenate([col, np.ones((H, W, 1))], 2).astype(np.float32).ravel())
    img.filepath_raw = JEANS_TEX
    img.file_format = "JPEG"
    img.save()
    bpy.data.images.remove(img)
    return bpy.data.images.load(JEANS_TEX)


def pants_uv(ob):
    """褲子（與全身）UV：以各腿軸為中心的角度 → u、高度 → v；跨後方接縫的面把 u 補 1（貼圖 REPEAT）。"""
    me = ob.data
    uv = me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        us = []
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            cx = math.copysign(0.10, co.x) if abs(co.x) > 1e-4 else 0.0
            ang = math.atan2(co.x - cx, -co.y)
            us.append((li, 0.5 + ang / (2 * math.pi), co.z / 1.05))
        if max(t[1] for t in us) - min(t[1] for t in us) > 0.5:
            us = [(li, u + 1 if u < 0.5 else u, v) for li, u, v in us]
        for li, u, v in us:
            uv.data[li].uv = (u, v)


# ---------------------------------------------------------------- 組裝
def tex_mat(name, image, roughness):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    m.diffuse_color = C.hex_rgba(COLORS.get(name, COLORS["skin"]))
    return m


def make_mats():
    mats = []
    for name in C.MAT_SLOTS:
        if name == "face":
            m = tex_mat("face", bpy.data.images.load(FACE_TEX), 0.6)
        elif name == "pants":
            m = tex_mat("pants", make_jeans_tex(), 0.9)
        else:
            m = C.mat(name, COLORS[name], {"shoes": 0.35, "hair": 0.5, "skin": 0.6}.get(name, 0.75))
        mats.append(m)
    return mats


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = C.FPS
    root = bpy.data.collections.new(SLUG)
    scene.collection.children.link(root)
    colls = {}
    for part in ("rig", "body", "head", "hair"):
        c = bpy.data.collections.new(f"{SLUG}.{part}")
        root.children.link(c)
        colls[part] = c
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new(SLUG, arm_data)
    colls["rig"].objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name in C.BONES:
        h, t, p = C.JOINTS[name]
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail, eb.roll = h, t, 0.0
        if p:
            eb.parent = arm_data.edit_bones[p]
    C.add_weapon_socket(arm_data)
    bpy.ops.object.mode_set(mode="OBJECT")
    mats = make_mats()

    B = C.Builder()
    build_torso(B)
    for s in (1, -1):
        build_arm(B, s)
        build_leg(B, s)
    body = B.to_object("body", colls["body"], arm, mats)
    pants_uv(body)
    B = C.Builder()
    build_head(B)
    head = B.to_object("head", colls["head"], arm, mats)
    face_uv(head)
    B = C.Builder()
    build_hair(B)
    hair = B.to_object("hair", colls["hair"], arm, mats)
    for ob in (body, head, hair):
        used = {p.material_index for p in ob.data.polygons}
        for i in reversed(range(len(ob.data.materials))):
            if i not in used:
                ob.data.materials.pop(index=i)
    ch = dict(v=dict(slug=SLUG), arm=arm, meshes=[body, head, hair], root=root, colls=colls)
    for name, keys, loop in BC.CLIPS:
        C.make_action(ch, name, keys(), loop, ground=BC.GROUND.get(name))
    C.make_action(ch, "idle_pose", idle_pose_keys(), True, ground=BC.GROUND["idle_pose"])
    CC.add_actions(ch)   # Phase 4 戰鬥 / 武器 clip（同名同長度，與行人共用清單）
    glb = os.path.join(BC.GLB_DIR, f"{SLUG}.glb")
    blend = os.path.join(BC.BLEND_DIR, f"{SLUG}.blend")
    C.export(ch, glb, blend)
    info = BC.glb_info(glb)
    previews(ch)
    C.blendsafe.save_blend(blend)
    ground = foot_check(ch)
    update_manifest(info)
    print(f"HERO tris={info['tris']} glb_bytes={info['bytes']} joints={info['joints']} anims={info['anims']} "
          f"mats={info['mats']} ground={ground}")


def idle_pose_keys():
    """招牌待機：照片中本人「右手」插腰（觀看者左側）、左手自然下垂、重心在左腳、身體微側、頭微傾。"""
    p0 = {"RightUpperArm": (14, 38, 0), "RightLowerArm": (-25, -66, 0), "RightHand": (0, -20, -15),
          "LeftUpperArm": (2, -6, 0), "LeftLowerArm": (-10, 0, 0),
          "Hips": (0, 4, 6), "Spine": (0, -2, 0), "Chest": (0, -3, -8), "Neck": (0, 0, 0), "Head": (2, -6, 4),
          "RightUpperLeg": (-6, -2, 0), "RightLowerLeg": (10, 0, 0), "RightFoot": (-4, 1, 0),
          "LeftUpperLeg": (0, -4, 0), "LeftFoot": (0, 4, 0), "loc": (0.0, 0, 0.0)}
    p1 = C.merge(p0, {"Chest": (-2, -3, -8), "Head": (1, -7, 3), "LeftUpperArm": (3, -7, 0)})
    return [(0, p0), (45, p1), (90, p0)]


def foot_check(ch):
    """各 clip 逐格量鞋底最低點（腳底貼地檢查）：回傳 {clip: (最低, 最高)}，單位公尺。"""
    arm = ch["arm"]
    body = ch["meshes"][0]
    shoe_i = {i for i, m in enumerate(body.data.materials) if m.name in ("shoes", "shirt_stripe")}
    idx = sorted({v for p in body.data.polygons if p.material_index in shoe_i for v in p.vertices
                  if body.data.vertices[v].co.z < 0.12})
    out = {}
    for name in ("idle", "idle_pose", "walk", "run", "punch", "hit", "jump", "enter_car", "getup"):
        act = bpy.data.actions[name]
        arm.animation_data.action = act
        lows = []
        for f in range(int(act.frame_start), int(act.frame_end) + 1, 2):
            bpy.context.scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            me = body.evaluated_get(dg).to_mesh()
            lows.append(min((body.matrix_world @ me.vertices[i].co).z for i in idx))
            body.evaluated_get(dg).to_mesh_clear()
        out[name] = (round(min(lows), 3), round(max(lows), 3))
    arm.animation_data.action = None
    return out


def previews(ch):
    cam = BC.preview_scene(ch)
    sc = bpy.context.scene
    sc.display.shading.color_type = "TEXTURE"   # 顯示臉部 / 牛仔褲貼圖
    sc.world.color = C.hex_rgba("#D9D9D9")[:3]    # 中性灰白背景
    arm = ch["arm"]
    shots = [("front", "idle", 0, (0.0, -4.2, 1.05), (0, 0, 0.95), 50, 576, 768),
             ("side", "idle", 0, (4.2, -0.3, 1.05), (0, 0, 0.95), 50, 576, 768),
             ("back", "idle", 0, (0.3, 4.2, 1.05), (0, 0, 0.95), 50, 576, 768),
             ("idle_pose", "idle_pose", 0, (1.1, -4.0, 1.05), (0, 0, 0.95), 50, 576, 768),
             ("run", "run", 5, (2.6, -3.3, 1.05), (0, 0, 0.95), 50, 576, 768),
             ("face-front", "idle", 0, (0.0, -0.62, 1.76), (0, 0, 1.745), 50, 640, 640),
             ("face-34", "idle", 0, (0.42, -0.46, 1.77), (0, 0, 1.745), 50, 640, 640)]
    for key, clip, frame, loc, tgt, lens, w, h in shots:
        arm.animation_data.action = bpy.data.actions[clip]
        sc.frame_set(frame)
        cam.data.lens = lens
        BC.look(cam, loc, tgt)
        BC.render_to(os.path.join(BC.PREVIEW_DIR, f"hero-{key}.png"), w, h)
    CC.previews(ch, cam, CC.HERO_FRAMES, os.path.join(BC.PREVIEW_DIR, "hero-combat-{n}.png"), height=HEIGHT)
    if BC.SCRATCH:    # 蒙皮檢查：全 clip 關鍵影格（含 run / punch / knockdown / drive 極端格）
        cells = BC.clip_previews(ch, cam, BC.SCRATCH, SLUG)
        BC.sheet(cells, 6, 300, 360, os.path.join(BC.SCRATCH, "hero-clips.png"))
    arm.animation_data.action = None


def update_manifest(info):
    path = os.path.join(BC.GLB_DIR, "manifest.json")
    with open(path, encoding="utf-8") as f:
        man = json.load(f)
    entry = {"id": SLUG, "name": "主角", "role": "player", "file": f"{SLUG}.glb", "height": HEIGHT,
             "bytes": info["bytes"], "triangles": info["tris"], "colors": COLORS, "randomColors": False,
             "extraClips": ["idle_pose"], "materials": info["mats"],
             "poses": {"driveHips": [0, BC.DRIVE_HIP_H, 0], "knockdownEndHips": [0, 0.115, -0.25]},
             "notes": ("依用戶提供的全身照打扮建模（照片不入 repo，臉部貼圖只含裁切後臉部）。身高 1.86 m；骨名 / 階層 / 朝向與行人相同，"
                       "關節高度依比例不同（頭部同尺寸、增高在腿與軀幹），請用本檔自帶的 clip。材質 face 為臉部貼圖（羽化外圈＝skin 色）、"
                       "pants 帶程序刷色貼圖、shirt_stripe 為上衣黑色橫條（也用於袖口 / 鞋底 / 帽兜開口暗部）；預設不換色。"
                       "idle_pose＝本人右手插腰招牌待機（循環）。")}
    man["variants"] = [x for x in man["variants"] if x.get("id") != SLUG] + [entry]
    man["extraClips"] = [{"name": "idle_pose", "duration": 3.0, "loop": True, "variants": [SLUG]}]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    build()
