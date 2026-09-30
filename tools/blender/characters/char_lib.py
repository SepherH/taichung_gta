"""臺中GTA 人物共用模組（Blender 5.2，bpy + bmesh）：低模人形 + 標準骨架 + 腳本關鍵影格動畫。

流程：
    ch = build_character(variant)     # 依體型參數建網格（逐環放樣、權重逐環指定）與骨架
    make_actions(ch)                  # 10 個動作 clip，各自獨立 action + NLA 軌
    export(ch, glb_path)              # 匯出 glTF（skin + animations），存 .blend

座標約定（與遊戲程式的契約）：
- 單位公尺；原點 = 兩腳底中心、地面 z = 0；身高 1.75 m（含頭髮）
- Blender 內角色面向 −Y、+Z 上、角色左手在 +X；匯出 glTF（+Y up）後面向 +Z
- 動畫一律原地（不含水平位移），只有 Hips 有平移（上下 / 坐下 / 倒地）
- 姿勢以「骨架空間軸」描述：X 軸 = 前後彎（正值：上指骨往前彎、下指骨往後擺），
  Y 軸 = 左右側擺，Z 軸 = 水平扭轉（正值：往角色左方轉）。子骨旋轉相對於父骨。
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Euler, Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import blendsafe  # noqa: E402

FPS = 30
MAT_SLOTS = ["skin", "shirt", "pants", "hair", "shoes"]

# ---------------------------------------------------------------- 骨架（所有體型共用同一副）
# 名稱採常見人形標準（Hips / Spine / Chest / Neck / Head / Left* / Right*）
JOINTS = {
    "Hips": ((0, 0, 0.95), (0, 0, 1.05), None),
    "Spine": ((0, 0, 1.05), (0, 0, 1.22), "Hips"),
    "Chest": ((0, 0, 1.22), (0, 0, 1.45), "Spine"),
    "Neck": ((0, 0, 1.45), (0, 0, 1.555), "Chest"),
    "Head": ((0, 0, 1.555), (0, 0, 1.75), "Neck"),
    "LeftShoulder": ((0.03, 0, 1.415), (0.175, 0, 1.425), "Chest"),
    "LeftUpperArm": ((0.19, 0, 1.415), (0.215, 0, 1.13), "LeftShoulder"),
    "LeftLowerArm": ((0.215, 0, 1.13), (0.232, 0, 0.875), "LeftUpperArm"),
    "LeftHand": ((0.232, 0, 0.875), (0.24, 0, 0.70), "LeftLowerArm"),
    "LeftUpperLeg": ((0.095, 0, 0.92), (0.1, 0, 0.5), "Hips"),
    "LeftLowerLeg": ((0.1, 0, 0.5), (0.1, 0.015, 0.09), "LeftUpperLeg"),
    "LeftFoot": ((0.1, 0.015, 0.09), (0.1, -0.13, 0.025), "LeftLowerLeg"),
}
for _k in list(JOINTS):
    if _k.startswith("Left"):
        h, t, p = JOINTS[_k]
        JOINTS["Right" + _k[4:]] = ((-h[0], h[1], h[2]), (-t[0], t[1], t[2]),
                                    ("Right" + p[4:]) if p.startswith("Left") else p)
BONES = ["Hips", "Spine", "Chest", "Neck", "Head",
         "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
         "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
         "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
         "RightUpperLeg", "RightLowerLeg", "RightFoot"]
L_THIGH = 0.42
L_SHIN = 0.411
HIP_JOINT_Z = 0.92
HIPS_Z = 0.95
BASE_JOINTS = {k: (tuple(h), tuple(t), p) for k, (h, t, p) in JOINTS.items()}
ZMAP = None   # 體型高度重映射：[(基準 z, 新 z), ...]；None = 標準 1.75 m


def Z(z):
    """把以 1.75 m 標準體型寫的高度換成目前比例（分段線性，超出末點則平移）。"""
    if not ZMAP:
        return z
    for (a0, b0), (a1, b1) in zip(ZMAP, ZMAP[1:]):
        if z <= a1:
            return b0 + (z - a0) * (b1 - b0) / (a1 - a0)
    return z + (ZMAP[-1][1] - ZMAP[-1][0])


def set_proportions(zmap):
    """改身高比例：重算關節高度（骨名 / 階層 / 朝向不變）與腿長常數。頭部尺寸維持不變由 zmap 決定。"""
    global ZMAP, L_THIGH, L_SHIN, HIP_JOINT_Z, HIPS_Z
    ZMAP = zmap
    for k, (h, t, p) in BASE_JOINTS.items():
        JOINTS[k] = ((h[0], h[1], Z(h[2])), (t[0], t[1], Z(t[2])), p)
    hp, kn, an = (JOINTS["LeftUpperLeg"][0], JOINTS["LeftLowerLeg"][0], JOINTS["LeftFoot"][0])
    L_THIGH = (Vector(kn) - Vector(hp)).length
    L_SHIN = (Vector(an) - Vector(kn)).length
    HIP_JOINT_Z = hp[2]
    HIPS_Z = JOINTS["Hips"][0][2]


def V(*a):
    return Vector(a)


# ---------------------------------------------------------------- 材質
def hex_rgba(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, 1.0)


def mat(name, color, roughness=0.7, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    m.diffuse_color = hex_rgba(color)
    return m


# ---------------------------------------------------------------- 放樣網格
class Builder:
    """逐環放樣：每個環有中心、軸向、前方參考、橫半徑 rx、前 / 後半徑、權重與材質。"""

    def __init__(self):
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()

    def _w(self, v, weights):
        tot = sum(weights.values())
        for b, w in weights.items():
            v[self.dl][BONES.index(b)] = w / tot

    def loft(self, rings, n=10, cap0=0.0, cap1=0.0):
        """rings: dict(c=Vector, ax=Vector, fw=Vector, rx, rf, rb, w={bone: w}, m=slot, tilt=0, cf=0)。
        cap0 / cap1：頭尾封蓋往外凸出的距離（0 = 平蓋）。"""
        vrings = []
        for r in rings:
            ax = r["ax"].normalized()
            fw = (r["fw"] - ax * r["fw"].dot(ax)).normalized()
            sd = fw.cross(ax)
            ring = []
            for j in range(n):
                t = 2 * math.pi * j / n
                c, s = math.cos(t), math.sin(t)
                ry = r["rf"] if s >= 0 else r["rb"]
                p = r["c"] + sd * (r["rx"] * c) + fw * (ry * s + r.get("cf", 0.0)) + ax * (r.get("tilt", 0.0) * s)
                v = self.bm.verts.new(p)
                self._w(v, r["w"])
                ring.append(v)
            vrings.append(ring)
        for i in range(len(rings) - 1):
            a, b = vrings[i], vrings[i + 1]
            for j in range(n):
                k = (j + 1) % n
                f = self.bm.faces.new((a[j], a[k], b[k], b[j]))
                f.material_index = MAT_SLOTS.index(rings[i]["m"])
        for idx, sign, cap in ((0, -1, cap0), (-1, 1, cap1)):
            r = rings[idx]
            ax = r["ax"].normalized()
            fw = (r["fw"] - ax * r["fw"].dot(ax)).normalized()
            cen = self.bm.verts.new(r["c"] + ax * (sign * cap) + fw * r.get("cf", 0.0))
            self._w(cen, r["w"])
            ring = vrings[idx]
            for j in range(n):
                f = self.bm.faces.new((ring[j], ring[(j + 1) % n], cen))
                f.material_index = MAT_SLOTS.index(r["m"])

    def to_object(self, name, coll, arm, mats):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in mats:
            me.materials.append(m)
        for p in me.polygons:
            p.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        for b in BONES:
            ob.vertex_groups.new(name=b)
        ob.parent = arm
        mod = ob.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
        return ob


def R(c, ax, fw, rx, rf, rb, w, m, tilt=0.0, cf=0.0):
    return dict(c=c, ax=ax, fw=fw, rx=rx, rf=rf, rb=rb, w=w, m=m, tilt=tilt, cf=cf)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- 體型
def build_body(B, g, side, arms=True):
    """四肢（side = +1 左 / -1 右）。g = 體型參數 dict。arms=False 只建腿與鞋（主角另建七分袖手臂）。"""
    S = "Left" if side > 0 else "Right"
    X = V(1, 0, 0)
    fwd = V(0, -1, 0)
    sh =V(*JOINTS[S + "UpperArm"][0])
    el = V(*JOINTS[S + "LowerArm"][0])
    wr = V(*JOINTS[S + "Hand"][0])
    tip = V(*JOINTS[S + "Hand"][1])
    a = g["arm"]
    UA, LA, HD, SH = S + "UpperArm", S + "LowerArm", S + "Hand", S + "Shoulder"
    if arms:
        _arm(B, g, side, S, sh, el, wr, tip, a, UA, LA, HD, SH, fwd)
    _leg(B, g, side, S, fwd)


def _arm(B, g, side, S, sh, el, wr, tip, a, UA, LA, HD, SH, fwd):
    d1 = el - sh
    # 上臂：肩頭（三角肌）→ 短袖 → 手肘
    B.loft([
        R(sh - d1 * 0.08 + V(-side * g["delt_in"], 0, 0), d1, fwd, 0.040 * a, 0.040 * a, 0.040 * a, {SH: .6, UA: .4}, "shirt"),
        R(sh + d1 * 0.06, d1, fwd, 0.050 * a, 0.049 * a, 0.049 * a, {UA: .75, SH: .25}, "shirt"),
        R(sh + d1 * 0.30, d1, fwd, 0.049 * a, 0.047 * a, 0.047 * a, {UA: 1}, "shirt"),
        R(sh + d1 * g["sleeve"], d1, fwd, 0.047 * a, 0.046 * a, 0.046 * a, {UA: 1}, "shirt"),
        R(sh + d1 * (g["sleeve"] + 0.015), d1, fwd, 0.042 * a, 0.041 * a, 0.041 * a, {UA: 1}, "skin"),
        R(sh + d1 * 0.78, d1, fwd, 0.040 * a, 0.039 * a, 0.039 * a, {UA: 1}, "skin"),
        R(sh + d1 * 0.96, d1, fwd, 0.037 * a, 0.036 * a, 0.038 * a, {UA: .6, LA: .4}, "skin"),
        R(el + (wr - el) * 0.06, wr - el, fwd, 0.037 * a, 0.036 * a, 0.038 * a, {UA: .35, LA: .65}, "skin"),
        R(el + (wr - el) * 0.30, wr - el, fwd, 0.040 * a, 0.038 * a, 0.036 * a, {LA: 1}, "skin"),
        R(el + (wr - el) * 0.85, wr - el, fwd, 0.028 * a, 0.024 * a, 0.024 * a, {LA: 1}, "skin"),
        R(el + (wr - el) * 1.02, wr - el, fwd, 0.026 * a, 0.022 * a, 0.022 * a, {LA: .5, HD: .5}, "skin"),
    ], n=10, cap0=0.0, cap1=0.01)
    # 手掌（扁、掌心朝身體）+ 拇指
    hd = tip - wr
    k = g.get("hand", 1.0)
    inward = V(-side, 0, 0)
    B.loft([
        R(wr + hd * 0.02, hd, inward, 0.027 * k, 0.017 * k, 0.017 * k, {LA: .3, HD: .7}, "skin"),
        R(wr + hd * 0.38, hd, inward, 0.043 * k, 0.020 * k, 0.018 * k, {HD: 1}, "skin"),
        R(wr + hd * 0.72, hd, inward, 0.041 * k, 0.017 * k, 0.015 * k, {HD: 1}, "skin", cf=0.004),
        R(wr + hd * 0.95, hd, inward, 0.030 * k, 0.012 * k, 0.011 * k, {HD: 1}, "skin", cf=0.008),
    ], n=8, cap0=0.0, cap1=0.012)
    th0 = wr + hd * 0.18 + V(0, -0.028, 0) + inward * 0.006
    th1 = th0 + V(0, -0.018, -0.055) + inward * 0.012
    B.loft([
        R(th0, th1 - th0, inward, 0.013, 0.012, 0.012, {HD: 1}, "skin"),
        R(lerp(th0, th1, 0.6), th1 - th0, inward, 0.011, 0.010, 0.010, {HD: 1}, "skin"),
        R(th1, th1 - th0, inward, 0.009, 0.008, 0.008, {HD: 1}, "skin"),
    ], n=6, cap0=0.0, cap1=0.008)



def _leg(B, g, side, S, fwd):
    # 腿：大腿 → 膝 → 小腿（褲管到腳踝）
    hp = V(*JOINTS[S + "UpperLeg"][0])
    kn = V(*JOINTS[S + "LowerLeg"][0])
    an = V(*JOINTS[S + "Foot"][0])
    UL, LL, FT = S + "UpperLeg", S + "LowerLeg", S + "Foot"
    l = g["leg"]
    d1, d2 = kn - hp, an - kn
    B.loft([
        R(hp - d1 * 0.12 + V(-side * 0.015, 0, 0), d1, fwd, 0.080 * l, 0.075 * l, 0.085 * l, {"Hips": .55, UL: .45}, "pants"),
        R(hp + d1 * 0.10, d1, fwd, 0.088 * l, 0.082 * l, 0.090 * l, {UL: .85, "Hips": .15}, "pants"),
        R(hp + d1 * 0.45, d1, fwd, 0.074 * l, 0.074 * l, 0.070 * l, {UL: 1}, "pants"),
        R(hp + d1 * 0.85, d1, fwd, 0.056 * l, 0.058 * l, 0.054 * l, {UL: .85, LL: .15}, "pants"),
        R(kn - d1 * 0.02, d1, fwd, 0.054 * l, 0.058 * l, 0.052 * l, {UL: .5, LL: .5}, "pants"),
        R(kn + d2 * 0.08, d2, fwd, 0.052 * l, 0.054 * l, 0.054 * l, {UL: .2, LL: .8}, "pants"),
        R(kn + d2 * 0.32, d2, fwd, 0.054 * l, 0.050 * l, 0.064 * l, {LL: 1}, "pants"),
        R(kn + d2 * 0.70, d2, fwd, 0.044 * l, 0.044 * l, 0.046 * l, {LL: 1}, "pants"),
        R(kn + d2 * 0.90, d2, fwd, 0.047 * l, 0.047 * l, 0.047 * l, {LL: .9, FT: .1}, "pants"),
        R(kn + d2 * 0.92, d2, fwd, 0.036, 0.034, 0.036, {LL: .7, FT: .3}, "skin"),
        R(kn + d2 * 1.0, d2, fwd, 0.035, 0.033, 0.035, {LL: .5, FT: .5}, "skin"),
    ], n=10, cap0=0.0, cap1=0.0)
    # 鞋：沿 −Y 放樣，前方參考 = 上
    up = V(0, 0, 1)
    ax = V(0, -1, 0)
    x = an.x
    sw = g["shoe"]
    B.loft([
        R(V(x, an.y + 0.060, 0.045), ax, up, 0.030 * sw, 0.025, 0.030, {FT: 1}, "shoes"),
        R(V(x, an.y + 0.045, 0.050), ax, up, 0.042 * sw, 0.040, 0.050, {FT: 1}, "shoes"),
        R(V(x, an.y + 0.000, 0.052), ax, up, 0.044 * sw, 0.045, 0.052, {FT: 1}, "shoes"),
        R(V(x, an.y - 0.070, 0.042), ax, up, 0.048 * sw, 0.032, 0.042, {FT: 1}, "shoes"),
        R(V(x, an.y - 0.140, 0.034), ax, up, 0.046 * sw, 0.024, 0.034, {FT: 1}, "shoes"),
        R(V(x, an.y - 0.175, 0.030), ax, up, 0.034 * sw, 0.018, 0.030, {FT: 1}, "shoes"),
    ], n=10, cap0=0.004, cap1=0.012)


def build_torso(B, g):
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    t, h, c = g["torso"], g["hip"], g["chest"]
    bel = g["belly"]
    rows = [  # z, rx, 前, 後, 權重, 材質（此環到下一環那段的材質）
        (0.835, 0.095 * h, 0.065, 0.075, {"Hips": 1}, "pants"),
        (0.885, 0.160 * h, 0.098, 0.115 * h, {"Hips": 1}, "pants"),
        (0.970, 0.168 * h, 0.104 * bel, 0.112 * h, {"Hips": 1}, "pants"),
        (1.035, 0.152 * t, 0.100 * bel, 0.100, {"Hips": .55, "Spine": .45}, "shirt"),
        (1.110, 0.142 * t, 0.098 * bel, 0.092, {"Spine": 1}, "shirt"),
        (1.200, 0.152 * t, 0.104 * max(bel, c * 0.95), 0.098, {"Spine": .5, "Chest": .5}, "shirt"),
        (1.290, 0.170 * t, 0.118 * c, 0.104, {"Chest": 1}, "shirt"),
        (1.370, 0.182 * g["shoulder"], 0.112 * c, 0.100, {"Chest": 1}, "shirt"),
        (1.440, 0.165 * g["shoulder"], 0.080, 0.084, {"Chest": .9, "Neck": .1}, "shirt"),
        (1.482, 0.080 * g["neck"], 0.058 * g["neck"], 0.062 * g["neck"], {"Chest": .5, "Neck": .5}, "shirt"),
    ]
    B.loft([R(V(0, 0, Z(z)), up, fwd, rx, rf, rb, w, m) for z, rx, rf, rb, w, m in rows], n=14, cap0=0.02, cap1=0.0)
    # 頸
    nk = g["neck"]
    B.loft([
        R(V(0, 0.004, Z(1.43)), up, fwd, 0.060 * nk, 0.054 * nk, 0.060 * nk, {"Chest": .5, "Neck": .5}, "skin"),
        R(V(0, 0.006, Z(1.50)), up, fwd, 0.056 * nk, 0.050 * nk, 0.056 * nk, {"Neck": 1}, "skin"),
        R(V(0, 0.008, Z(1.565)), up, fwd, 0.054 * nk, 0.048 * nk, 0.054 * nk, {"Neck": .4, "Head": .6}, "skin"),
    ], n=10, cap0=0.0, cap1=0.0)


def build_head(B, g):
    """頭（下巴到頭頂）+ 鼻、耳、眼、眉。頭頂留給頭髮。"""
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    H = {"Head": 1}
    rows = [  # z, rx, 前, 後, 前移
        (1.538, 0.030, 0.028, 0.030, -0.030),
        (1.552, 0.056, 0.060, 0.045, -0.012),
        (1.580, 0.070, 0.082, 0.070, -0.004),
        (1.620, 0.080, 0.092, 0.088, 0.0),
        (1.660, 0.084, 0.094, 0.098, 0.0),
        (1.700, 0.082, 0.088, 0.100, 0.0),
        (1.730, 0.066, 0.070, 0.082, 0.0),
    ]
    B.loft([R(V(0, 0, z), up, fwd, rx, rf, rb, H, "skin", cf=cf) for z, rx, rf, rb, cf in rows],
           n=16, cap0=0.004, cap1=0.012)
    # 鼻
    B.loft([
        R(V(0, -0.084, 1.632), V(0, -1, -0.25), up, 0.012, 0.016, 0.010, H, "skin"),
        R(V(0, -0.101, 1.612), V(0, -1, -0.25), up, 0.010, 0.010, 0.006, H, "skin"),
    ], n=6, cap0=0.0, cap1=0.006)
    for sx in (1, -1):
        # 耳
        B.loft([
            R(V(sx * 0.078, 0.004, 1.628), V(sx, 0, 0), up, 0.014, 0.026, 0.022, H, "skin"),
            R(V(sx * 0.092, 0.010, 1.630), V(sx, 0.25, 0), up, 0.012, 0.024, 0.020, H, "skin"),
        ], n=8, cap0=0.0, cap1=0.004)
        # 眼（深色小圓片，用 hair 材質）
        B.loft([
            R(V(sx * 0.033, -0.078, 1.648), fwd, up, 0.011, 0.008, 0.008, H, "hair"),
            R(V(sx * 0.033, -0.087, 1.648), fwd, up, 0.010, 0.007, 0.007, H, "hair"),
        ], n=8, cap0=0.0, cap1=0.002)
        # 眉
        B.loft([
            R(V(sx * 0.050, -0.087, 1.674), V(-sx, 0, 0.12), fwd, 0.005, 0.004, 0.003, H, "hair"),
            R(V(sx * 0.016, -0.093, 1.676), V(-sx, 0, 0.12), fwd, 0.005, 0.004, 0.003, H, "hair"),
        ], n=6, cap0=0.004, cap1=0.004)


def build_hair(B, style):
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    H = {"Head": 1}
    if style == "short":      # 短髮：前額髮際 1.690、後腦 1.585
        rows = [(1.637, 0.090, 0.098, 0.106, 0.053, 0.0), (1.690, 0.094, 0.100, 0.110, 0.030, 0.0),
                (1.722, 0.086, 0.090, 0.100, 0.012, 0.0), (1.742, 0.062, 0.064, 0.074, 0.0, 0.0)]
        B.loft([R(V(0, 0, z), up, fwd, rx, rf, rb, H, "hair", tilt=tl, cf=cf) for z, rx, rf, rb, tl, cf in rows],
               n=16, cap0=0.0, cap1=0.008)
    elif style == "bob":      # 及肩鮑伯：前額 1.692、兩側到耳下、後方到頸
        rows = [(1.580, 0.098, 0.104, 0.118, 0.112, 0.0), (1.640, 0.100, 0.104, 0.118, 0.058, 0.0),
                (1.695, 0.096, 0.100, 0.112, 0.028, 0.0), (1.724, 0.086, 0.090, 0.100, 0.010, 0.0),
                (1.744, 0.060, 0.064, 0.072, 0.0, 0.0)]
        B.loft([R(V(0, 0, z), up, fwd, rx, rf, rb, H, "hair", tilt=tl, cf=cf) for z, rx, rf, rb, tl, cf in rows],
               n=16, cap0=0.0, cap1=0.008)
        # 馬尾
        B.loft([
            R(V(0, 0.100, 1.660), V(0, 0.45, -1), fwd, 0.030, 0.026, 0.026, H, "hair"),
            R(V(0, 0.130, 1.590), V(0, 0.25, -1), fwd, 0.034, 0.030, 0.030, H, "hair"),
            R(V(0, 0.140, 1.500), V(0, 0.05, -1), fwd, 0.024, 0.022, 0.022, H, "hair"),
        ], n=8, cap0=0.0, cap1=0.03)
    else:                     # 平頭：貼頭皮的薄殼
        rows = [(1.640, 0.087, 0.096, 0.101, 0.050, 0.0), (1.692, 0.088, 0.094, 0.104, 0.028, 0.0),
                (1.722, 0.078, 0.082, 0.092, 0.010, 0.0), (1.740, 0.050, 0.052, 0.060, 0.0, 0.0)]
        B.loft([R(V(0, 0, z), up, fwd, rx, rf, rb, H, "hair", tilt=tl, cf=cf) for z, rx, rf, rb, tl, cf in rows],
               n=16, cap0=0.0, cap1=0.006)


# ---------------------------------------------------------------- 骨架 / 組裝
def build_character(v):
    """v = 變體 dict：slug、name、colors、g（體型）、hair。回傳 ch（含 arm、meshes、colls）。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    root = bpy.data.collections.new(v["slug"])
    scene.collection.children.link(root)
    colls = {}
    for part in ("rig", "body", "head", "hair"):
        c = bpy.data.collections.new(f"{v['slug']}.{part}")
        root.children.link(c)
        colls[part] = c

    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new(v["slug"], arm_data)
    colls["rig"].objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name in BONES:
        h, t, p = JOINTS[name]
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail = h, t
        eb.roll = 0.0
        if p:
            eb.parent = arm_data.edit_bones[p]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")

    c = v["colors"]
    mats = [mat("skin", c["skin"], 0.6), mat("shirt", c["shirt"], 0.8), mat("pants", c["pants"], 0.85),
            mat("hair", c["hair"], 0.55), mat("shoes", c["shoes"], 0.5)]
    g = v["g"]
    B = Builder()
    build_torso(B, g)
    build_body(B, g, +1)
    build_body(B, g, -1)
    body = B.to_object("body", colls["body"], arm, mats)
    B = Builder()
    build_head(B, g)
    head = B.to_object("head", colls["head"], arm, mats)
    B = Builder()
    build_hair(B, v["hair"])
    hair = B.to_object("hair", colls["hair"], arm, mats)
    for ob in (body, head, hair):   # 清掉沒用到的材質槽以免匯出空 primitive
        used = {p.material_index for p in ob.data.polygons}
        for i in reversed(range(len(ob.data.materials))):
            if i not in used:
                ob.data.materials.pop(index=i)
    return dict(v=v, arm=arm, meshes=[body, head, hair], root=root, colls=colls)


# ---------------------------------------------------------------- 動畫
def _rest3(arm, bone):
    return arm.data.bones[bone].matrix_local.to_3x3().normalized()


def _key_pose(arm, pose, frame, prev):
    """pose = {bone: (x, y, z) 度}（骨架空間軸，相對父骨）+ 'loc': (dx, dy, dz)（Hips 平移，骨架空間）。"""
    for b in BONES:
        pb = arm.pose.bones[b]
        pb.rotation_mode = "QUATERNION"
        rx, ry, rz = pose.get(b, (0, 0, 0))
        qa = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_matrix()
        R3 = _rest3(arm, b)
        q = (R3.inverted() @ qa @ R3).to_quaternion()
        if b in prev and prev[b].dot(q) < 0:
            q = -q
        prev[b] = q
        pb.rotation_quaternion = q
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=b)
    pb = arm.pose.bones["Hips"]
    d = Vector(pose.get("loc", (0, 0, 0)))
    pb.location = _rest3(arm, "Hips").inverted() @ d
    pb.keyframe_insert("location", frame=frame, group="Hips")


def legs_flat(thigh, knee, hips_pitch=0.0, side="Left", foot_extra=0.0):
    """回傳某腿的 (UpperLeg, LowerLeg, Foot) X 旋轉：thigh = 大腿世界俯仰（負 = 往前抬），
    knee = 膝彎（正），腳掌保持水平貼地（+foot_extra）。"""
    return {side + "UpperLeg": (thigh - hips_pitch, 0, 0), side + "LowerLeg": (knee, 0, 0),
            side + "Foot": (-(thigh + knee) + foot_extra, 0, 0)}


def crouch_drop(thigh, knee):
    """雙腳貼地時骨盆需要下降的量（公尺，負值）。"""
    a, k = math.radians(thigh), math.radians(knee)
    h = L_THIGH * math.cos(a) + L_SHIN * math.cos(a + k)
    return h - (L_THIGH + L_SHIN)


def mirror(pose):
    out = {}
    for b, r in pose.items():
        if b == "loc":
            out[b] = (-r[0], r[1], r[2])
            continue
        nb = "Right" + b[4:] if b.startswith("Left") else "Left" + b[5:] if b.startswith("Right") else b
        out[nb] = (r[0], -r[1], -r[2])
    return out


def merge(*ps):
    out = {}
    for p in ps:
        out.update(p)
    return out


def _lowest(ch):
    dg = bpy.context.evaluated_depsgraph_get()
    low = 1e9
    for ob in ch["meshes"]:
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        mw = ob.matrix_world
        low = min(low, min((mw @ v.co).z for v in me.vertices))
        ev.to_mesh_clear()
    return low


def make_action(ch, name, keys, loop, pre_post=None, ground=None):
    """keys = [(frame, pose)]。循環 clip 另加前後各一個延伸鍵，讓首尾切線連續。
    ground = (關鍵影格清單或 "all", 模式, 逐格檢查到第幾格)：先把指定關鍵影格的全身最低點平移到 z = 0，
    再逐格檢查——模式 "lock" 每格都貼地（站立類），"clamp" 只把低於地面的格抬回地面（有騰空 / 坐下的動作）。"""
    frames_spec, mode, until = (ground + (None,))[:3] if ground else (None, None, None)
    arm = ch["arm"]
    if arm.animation_data is None:
        arm.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    prev = {}
    allkeys = list(keys)
    if loop:
        f_end = keys[-1][0]
        allkeys = [(keys[-2][0] - f_end, keys[-2][1])] + allkeys + [(f_end + keys[1][0], keys[1][1])]
    for f, p in allkeys:
        _key_pose(arm, p, f, prev)
    if ground:
        frames = [f for f, _ in keys] if frames_spec == "all" else frames_spec
        for f, p in keys:
            if f in frames:
                bpy.context.scene.frame_set(int(f))
                dz = _lowest(ch)
                loc = p.get("loc", (0, 0, 0))
                p["loc"] = (loc[0], loc[1], loc[2] - dz)
        prev = {}
        for f, p in allkeys:
            _key_pose(arm, p, f, prev)
        pb = arm.pose.bones["Hips"]
        inv = _rest3(arm, "Hips").inverted()
        last = keys[-1][0] if until is None else until
        for f in range(int(keys[0][0]), int(last) + 1):
            bpy.context.scene.frame_set(f)
            low = _lowest(ch)
            if mode == "lock" or low < 0:
                pb.location = pb.location + inv @ Vector((0, 0, -low))
                pb.keyframe_insert("location", frame=f, group="Hips")
    for fc in _fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
            kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"
        fc.update()
    act.use_frame_range = True
    act.frame_start, act.frame_end = keys[0][0], keys[-1][0]
    act.use_cyclic = loop
    arm.animation_data.action = None
    tr = arm.animation_data.nla_tracks.new()
    tr.name = name
    strip = tr.strips.new(name, int(keys[0][0]), act)
    strip.action_frame_start, strip.action_frame_end = keys[0][0], keys[-1][0]
    tr.mute = True
    return act


def _fcurves(act):
    try:
        return list(act.fcurves)
    except AttributeError:   # Blender 4.4+ 分層 action
        out = []
        for layer in act.layers:
            for st in layer.strips:
                for cb in st.channelbags:
                    out.extend(cb.fcurves)
        return out


# ---------------------------------------------------------------- 匯出 / 預覽
def export(ch, glb, blend):
    arm = ch["arm"]
    for o in bpy.context.scene.objects:
        o.select_set(False)
    arm.select_set(True)
    for m in ch["meshes"]:
        m.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_optimize_animation_size=True, export_skins=True, export_def_bones=True,
        export_cameras=False, export_lights=False, export_frame_range=False)
    os.makedirs(os.path.dirname(blend), exist_ok=True)
    blendsafe.save_blend(blend)
