"""臺中GTA 地標建模共用模組（Blender 5.2，bpy + bmesh）。

每支地標腳本的流程都一樣：
    ctx = begin(slug, way_id, name)      # 清空場景、讀 OSM 輪廓、算原點
    ... 用 prism / box / cylinder / sign 等函式疊出量體 ...
    finish(ctx, height=..., ...)         # 存 .blend、匯出 .glb、算兩張預覽、更新 manifest

座標約定（與遊戲程式的契約）：
- 單位公尺；原點 = OSM 輪廓外接矩形中心、地面 z = 0
- Blender 內 +X 東、+Y 北、+Z 上；匯出 glTF 用預設 +Y up（glTF 內 +X 東、+Y 上、-Z 北）
- 投影：以原點做等距圓柱投影，1 緯度 = 111320 m，經度再乘 cos(原點緯度)
- 七期斜格網：a 軸 = 沿河南路往東北（方位角 31 度），b 軸 = 往東南（121 度）
  參考文件 docs/ref/tiger-city-reference.md 第 0 節。ab(b, a) 把格網座標換成 x, y。
"""
import bpy
import bmesh
import json
import math
import os
from mathutils import Vector

import blendsafe

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OSM_FILE = os.path.join(REPO, "data", "osm", "qiqi-raw-v2.json")   # Phase 2：範圍擴大到七期精華區（含市政府）
BLEND_DIR = os.path.join(REPO, "assets", "blender")
GLB_DIR = os.path.join(REPO, "public", "models")
PREVIEW_DIR = os.path.join(REPO, "docs", "models", "previews")
MANIFEST = os.path.join(GLB_DIR, "manifest.json")

M_PER_DEG_LAT = 111320.0
GRID_BEARING = 31.0  # 參考文件 §0：河南路走向方位角
_SA, _CA = math.sin(math.radians(GRID_BEARING)), math.cos(math.radians(GRID_BEARING))
A_DIR = (_SA, _CA)    # a 軸單位向量（往東北）
B_DIR = (_CA, -_SA)   # b 軸單位向量（往東南）

_osm_cache = None


# ---------------------------------------------------------------- OSM / 投影
def _osm_ways():
    global _osm_cache
    if _osm_cache is None:
        with open(OSM_FILE, encoding="utf-8") as f:
            data = json.load(f)
        _osm_cache = {e["id"]: e for e in data["elements"] if e["type"] == "way"}
    return _osm_cache


def load_footprint(way_id):
    """回傳 (anchor_lat, anchor_lon, [(x, y), ...])，點序為逆時針、已去掉閉合重複點。"""
    way = _osm_ways()[way_id]
    ll = [(p["lat"], p["lon"]) for p in way["geometry"]]
    if ll[0] == ll[-1]:
        ll = ll[:-1]
    lats = [p[0] for p in ll]
    lons = [p[1] for p in ll]
    lat0 = round((min(lats) + max(lats)) / 2, 7)
    lon0 = round((min(lons) + max(lons)) / 2, 7)
    k = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    pts = [((lon - lon0) * k, (lat - lat0) * M_PER_DEG_LAT) for lat, lon in ll]
    return lat0, lon0, ccw(pts)


def project(lat, lon, lat0, lon0):
    """經緯度 → 以 (lat0, lon0) 為原點的 (x 東, y 北) 公尺。"""
    k = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    return ((lon - lon0) * k, (lat - lat0) * M_PER_DEG_LAT)


def way_points(way_id, lat0, lon0):
    """任一 OSM way（含非閉合的線，例如步道 / 橋）投影成 [(x, y), ...]，保留原點序。"""
    return [project(p["lat"], p["lon"], lat0, lon0) for p in _osm_ways()[way_id]["geometry"]]


def ab(b, a):
    """格網座標 (b, a) → (x, y)。"""
    return (b * B_DIR[0] + a * A_DIR[0], b * B_DIR[1] + a * A_DIR[1])


def to_ab(x, y):
    return (x * B_DIR[0] + y * B_DIR[1], x * A_DIR[0] + y * A_DIR[1])


def rect_ab(b0, b1, a0, a1):
    return ccw([ab(b0, a0), ab(b1, a0), ab(b1, a1), ab(b0, a1)])


def area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
               for i in range(len(pts))) / 2


def ccw(pts):
    return list(pts) if area(pts) > 0 else list(reversed(pts))


def offset(pts, d):
    """多邊形外擴 d 公尺（負值 = 內縮），斜接轉角。"""
    pts = ccw(pts)
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        n1 = _edge_normal(p0, p1)
        n2 = _edge_normal(p1, p2)
        k = d / max(1.0 + n1[0] * n2[0] + n1[1] * n2[1], 0.3)
        out.append((p1[0] + (n1[0] + n2[0]) * k, p1[1] + (n1[1] + n2[1]) * k))
    return out


def _edge_normal(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy) or 1.0
    return (dy / ln, -dx / ln)  # 逆時針多邊形的外側


def facade_edge(pts, direction):
    """找出朝向 direction（水平向量）的最外側外牆邊，回傳 (p0, p1)。
    候選 = 法線與 direction 夾角 < 37 度且長度 > 8 m 的邊；取中點沿 direction 最遠者。"""
    pts = ccw(pts)
    best, score = None, -1e9
    for i in range(len(pts)):
        p0, p1 = pts[i], pts[(i + 1) % len(pts)]
        nx, ny = _edge_normal(p0, p1)
        if nx * direction[0] + ny * direction[1] < 0.8 or math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 8:
            continue
        s = (p0[0] + p1[0]) / 2 * direction[0] + (p0[1] + p1[1]) / 2 * direction[1]
        if s > score:
            best, score = (p0, p1), s
    return best


def clip(pts, window):
    """Sutherland–Hodgman：把多邊形 pts 裁到凸多邊形 window 之內（取建物某個角落用）。"""
    out = ccw(pts)
    window = ccw(window)
    for i in range(len(window)):
        a, b = window[i], window[(i + 1) % len(window)]
        inside = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0

        def cross_pt(p, q):
            x1, y1, x2, y2 = p[0], p[1], q[0], q[1]
            x3, y3, x4, y4 = a[0], a[1], b[0], b[1]
            den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
            t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
            return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
        src, out = out, []
        for j in range(len(src)):
            cur, prev = src[j], src[j - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross_pt(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross_pt(prev, cur))
    return out


def fit_circle(pts):
    """最小平方擬合圓（Kåsa 法），回傳 (cx, cy, r)。用於 OSM 輪廓裡的圓弧段。"""
    from mathutils import Matrix
    sxx = sxy = syy = sx = sy = sxz = syz = sz = 0.0
    n = len(pts)
    for x, y in pts:
        z = x * x + y * y
        sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y
        sxz += x * z; syz += y * z; sz += z
    m = Matrix(((sxx, sxy, sx), (sxy, syy, sy), (sx, sy, n)))
    d, e, f = m.inverted() @ Vector((-sxz, -syz, -sz))
    cx, cy = -d / 2, -e / 2
    return cx, cy, math.sqrt(cx * cx + cy * cy - f)


def edge_frame(p0, p1, t):
    """邊 p0→p1 上比例 t 的點，與該邊朝外的法線 (nx, ny)。p0→p1 須為逆時針序。"""
    x = p0[0] + (p1[0] - p0[0]) * t
    y = p0[1] + (p1[1] - p0[1]) * t
    return (x, y), _edge_normal(p0, p1)


# ---------------------------------------------------------------- 材質
def mat(name, color, metallic=0.0, roughness=0.6, emission=None, strength=1.0):
    """Principled BSDF 單色材質。color / emission 用 hex 字串，例 '#B8BCC0'。"""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    rgba = hex_rgba(color)
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(emission)
        bsdf.inputs["Emission Strength"].default_value = strength
    m.diffuse_color = rgba  # Workbench 預覽用
    return m


def hex_rgba(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, 1.0)


# ---------------------------------------------------------------- 場景 / collection
class Ctx:
    pass


def begin(slug, way_id, name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ctx = Ctx()
    ctx.slug, ctx.way_id, ctx.name = slug, way_id, name
    ctx.lat0, ctx.lon0, ctx.footprint = load_footprint(way_id)
    ctx.has_footprint = True
    return _begin_scene(ctx)


def begin_point(slug, ident, name, lat0, lon0, footprint):
    """沒有 OSM 建物輪廓的物件（公園內小建物、橋）：自訂原點經緯度與概略平面 footprint（x, y 公尺，
    只用於自動預覽取景）。manifest 的 id 用 ident（字串），footprint 欄寫 false。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ctx = Ctx()
    ctx.slug, ctx.way_id, ctx.name = slug, ident, name
    ctx.lat0, ctx.lon0, ctx.footprint = round(lat0, 7), round(lon0, 7), ccw(footprint)
    ctx.has_footprint = False
    return _begin_scene(ctx)


def _begin_scene(ctx):
    slug = ctx.slug
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    ctx.root_coll = bpy.data.collections.new(slug)
    scene.collection.children.link(ctx.root_coll)
    ctx.root = bpy.data.objects.new(slug, None)  # 匯出後的 glTF 根節點
    ctx.root.empty_display_size = 5
    ctx.root_coll.objects.link(ctx.root)
    ctx.colls = {}
    return ctx


def coll(ctx, part):
    """取得 / 建立部位 collection，例 body、roof、entrance、signs、site。"""
    if part not in ctx.colls:
        c = bpy.data.collections.new(f"{ctx.slug}.{part}")
        ctx.root_coll.children.link(c)
        ctx.colls[part] = c
    return ctx.colls[part]


def _link(ctx, part, name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if isinstance(material, (list, tuple)):
        for m in material:
            me.materials.append(m)
    else:
        me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    coll(ctx, part).objects.link(ob)
    ob.parent = ctx.root
    return ob


# ---------------------------------------------------------------- 幾何
def prism(ctx, part, name, pts, z0, z1, material, bottom=False):
    """把 2D 多邊形從 z0 擠出到 z1（貼合輪廓的量體）。"""
    pts = ccw(pts)
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, z0)) for x, y in pts]
    hi = [bm.verts.new((x, y, z1)) for x, y in pts]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(hi)
    if bottom:
        bm.faces.new(list(reversed(lo)))
    return _link(ctx, part, name, bm, material)


def box_ab(ctx, part, name, b0, b1, a0, a1, z0, z1, material, bottom=False):
    return prism(ctx, part, name, rect_ab(b0, b1, a0, a1), z0, z1, material, bottom)


def circle(cx, cy, r, seg=16, rx=None, rot=0.0):
    rx = r if rx is None else rx
    c, s = math.cos(rot), math.sin(rot)
    pts = []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        px, py = rx * math.cos(t), r * math.sin(t)
        pts.append((cx + px * c - py * s, cy + px * s + py * c))
    return pts


def cylinder(ctx, part, name, cx, cy, r, z0, z1, material, seg=16, bottom=False):
    return prism(ctx, part, name, circle(cx, cy, r, seg), z0, z1, material, bottom)


def pyramid(ctx, part, name, pts, z0, z1, material):
    pts = ccw(pts)
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    bm = bmesh.new()
    base = [bm.verts.new((x, y, z0)) for x, y in pts]
    apex = bm.verts.new((cx, cy, z1))
    for i in range(len(base)):
        bm.faces.new((base[i], base[(i + 1) % len(base)], apex))
    return _link(ctx, part, name, bm, material)


def sphere(ctx, part, name, x, y, z, r, material):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, z))
    return _link(ctx, part, name, bm, material)


def facade_panel(ctx, part, name, center, normal, width, height, depth, material):
    """貼在立面上的薄板（normal 為水平朝外向量），用於帶狀裝飾、logo 圓盤底板等。"""
    nx, ny = normal
    rx, ry = -ny, nx
    cx, cy, cz = center
    bm = bmesh.new()
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    back = [bm.verts.new((cx + rx * width / 2 * u, cy + ry * width / 2 * u, cz + height / 2 * v)) for u, v in corners]
    front = [bm.verts.new((cx + rx * width / 2 * u + nx * depth, cy + ry * width / 2 * u + ny * depth,
                           cz + height / 2 * v)) for u, v in corners]
    bm.faces.new(front)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((back[i], back[j], front[j], front[i]))
    return _link(ctx, part, name, bm, material)


def disc_on_wall(ctx, part, name, center, normal, r, depth, material, seg=20):
    """貼牆圓盤（抽象 logo 用），正面朝 normal。"""
    nx, ny = normal
    rx, ry = -ny, nx
    cx, cy, cz = center
    bm = bmesh.new()
    back, front = [], []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        u, v = r * math.cos(t), r * math.sin(t)
        back.append(bm.verts.new((cx + rx * u, cy + ry * u, cz + v)))
        front.append(bm.verts.new((cx + rx * u + nx * depth, cy + ry * u + ny * depth, cz + v)))
    bm.faces.new(front)
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((back[i], back[j], front[j], front[i]))
    return _link(ctx, part, name, bm, material)


def sign(ctx, text, center, normal, width, height, material):
    """招牌佔位平面：物件名 sign:<文字>，程式端執行期貼字。正面法線朝 normal，附 0..1 UV。"""
    nx, ny = normal
    rx, ry = -ny, nx  # 觀看者視角的右方
    cx, cy, cz = center
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    vs = [bm.verts.new((cx + rx * width / 2 * u, cy + ry * width / 2 * u, cz + height / 2 * v))
          for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = bm.faces.new(vs)
    for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = (u, v)
    return _link(ctx, "signs", f"sign:{text}", bm, material)


def band(ctx, part, name, pts, z, h, d, material):
    """水平帶：沿輪廓外擴 d 公尺、厚 h 的環狀板（樓層線、紅色腰帶等）。"""
    return prism(ctx, part, name, offset(pts, d), z, z + h, material, bottom=True)


def fins(ctx, part, name, pts, spacing, z0, z1, depth, width, material, skip_short=6.0):
    """沿輪廓每 spacing 公尺立一片垂直鰭片 / 窗框線，全部合成一個物件以省面數。"""
    pts = ccw(pts)
    bm = bmesh.new()
    for i in range(len(pts)):
        p0, p1 = pts[i], pts[(i + 1) % len(pts)]
        ln = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        if ln < skip_short:
            continue
        nx, ny = _edge_normal(p0, p1)
        tx, ty = (p1[0] - p0[0]) / ln, (p1[1] - p0[1]) / ln
        k = max(int(ln // spacing), 1)
        for j in range(1, k):
            cx = p0[0] + tx * ln * j / k
            cy = p0[1] + ty * ln * j / k
            quad = [(cx - tx * width / 2, cy - ty * width / 2), (cx + tx * width / 2, cy + ty * width / 2),
                    (cx + tx * width / 2 + nx * depth, cy + ty * width / 2 + ny * depth),
                    (cx - tx * width / 2 + nx * depth, cy - ty * width / 2 + ny * depth)]
            quad = ccw(quad)
            lo = [bm.verts.new((x, y, z0)) for x, y in quad]
            hi = [bm.verts.new((x, y, z1)) for x, y in quad]
            for a in range(4):
                b = (a + 1) % 4
                bm.faces.new((lo[a], lo[b], hi[b], hi[a]))
            bm.faces.new(hi)
    return _link(ctx, part, name, bm, material)


def ellipse_cutter(ctx, name, center, normal, rx, rz, out, depth, side_mat, cap_mat, seg=20):
    """水平方向的橢圓柱挖刀：沿 normal 從牆外 out 公尺穿到牆內 depth 公尺。
    側面用 side_mat、內端蓋用 cap_mat（布林後成為凹洞底的玻璃）。"""
    nx, ny = normal
    rx_, ry_ = -ny, nx
    cx, cy, cz = center
    bm = bmesh.new()
    outer, inner = [], []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        u, v = rx * math.cos(t), rz * math.sin(t)
        outer.append(bm.verts.new((cx + rx_ * u + nx * out, cy + ry_ * u + ny * out, cz + v)))
        inner.append(bm.verts.new((cx + rx_ * u - nx * depth, cy + ry_ * u - ny * depth, cz + v)))
    f = bm.faces.new(outer)
    f.material_index = 0
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((outer[i], inner[i], inner[j], outer[j])).material_index = 0
    bm.faces.new(list(reversed(inner))).material_index = 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _link(ctx, "body", name, bm, [side_mat, cap_mat])


def boolean_cut(target, cutters, floor=0.0):
    """從 target 挖掉 cutters（EXACT 布林，切面沿用 cutter 材質），套用後刪除 cutters。
    布林偶爾會在地面以下留下殘片，最後沿 z = floor 切平並刪掉地下部分。"""
    for i, c in enumerate(cutters):
        mod = target.modifiers.new(f"cut{i}", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.material_mode = "TRANSFER"
        mod.object = c
        c.hide_render = True
    dg = bpy.context.evaluated_depsgraph_get()
    new_me = bpy.data.meshes.new_from_object(target.evaluated_get(dg))
    old = target.data
    target.modifiers.clear()
    target.data = new_me
    new_me.name = target.name
    bpy.data.meshes.remove(old)
    bm = bmesh.new()
    bm.from_mesh(new_me)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, floor),
                           plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(new_me)
    bm.free()
    for c in cutters:
        me = c.data
        bpy.data.objects.remove(c)
        bpy.data.meshes.remove(me)


# ---------------------------------------------------------------- 輸出
def model_objects(ctx):
    return [o for o in ctx.root_coll.all_objects]


def triangle_count(ctx):
    n = 0
    for o in model_objects(ctx):
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            n += len(o.data.loop_triangles)
    return n


def _look(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def _preview_setup(ctx):
    scene = bpy.context.scene
    pc = bpy.data.collections.new("_preview（不匯出）")
    scene.collection.children.link(pc)
    ground = bpy.data.meshes.new("preview_ground")
    bm = bmesh.new()
    s = 800
    bm.faces.new([bm.verts.new(v) for v in ((-s, -s, -0.05), (s, -s, -0.05), (s, s, -0.05), (-s, s, -0.05))])
    bm.to_mesh(ground)
    bm.free()
    ground.materials.append(mat("preview_ground", "#8A8C86", roughness=0.9))
    g = bpy.data.objects.new("preview_ground", ground)
    pc.objects.link(g)
    sun_data = bpy.data.lights.new("preview_sun", "SUN")
    sun_data.energy = 3.5
    sun = bpy.data.objects.new("preview_sun", sun_data)
    sun.rotation_euler = (math.radians(40), 0, math.radians(35))
    pc.objects.link(sun)
    cam_data = bpy.data.cameras.new("preview_camera")
    cam = bpy.data.objects.new("preview_camera", cam_data)
    pc.objects.link(cam)
    scene.camera = cam
    world = bpy.data.worlds.new("preview_sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgba("#B9C7D6")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    scene.render.resolution_x = 768   # 預覽長邊 ≤ 768（控制 repo 大小）
    scene.render.resolution_y = 480
    scene.render.image_settings.file_format = "PNG"
    engine = os.environ.get("LANDMARK_PREVIEW_ENGINE", "BLENDER_EEVEE")
    scene.render.engine = engine
    if engine == "BLENDER_WORKBENCH":
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.light = "STUDIO"
        scene.display.shading.show_shadows = True
    else:
        try:
            scene.eevee.taa_render_samples = 16
        except AttributeError:
            pass
    return cam


def _auto_views(ctx, height, street_dir):
    xs = [p[0] for p in ctx.footprint]
    ys = [p[1] for p in ctx.footprint]
    r = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) / 2
    dx, dy = street_dir
    ln = math.hypot(dx, dy)
    dx, dy = dx / ln, dy / ln
    dist = max(r * 1.6 + 25, height * 0.95)
    street = ((dx * dist, dy * dist, 1.7), (0, 0, min(height * 0.42, 60)))
    ang = math.radians(35)
    ax, ay = dx * math.cos(ang) - dy * math.sin(ang), dx * math.sin(ang) + dy * math.cos(ang)
    far = max(r * 2.6, height * 1.7) + 40
    aerial = ((ax * far, ay * far, far * 0.7 + height * 0.4), (0, 0, height * 0.4))
    return street, aerial


def finish(ctx, height, height_source, notes, street_dir, street=None, aerial=None):
    """存 .blend、匯出 .glb、更新 manifest、算街道 / 鳥瞰兩張預覽。"""
    for d in (BLEND_DIR, GLB_DIR, PREVIEW_DIR):
        os.makedirs(d, exist_ok=True)
    blend = os.path.join(BLEND_DIR, f"{ctx.slug}.blend")
    glb = os.path.join(GLB_DIR, f"{ctx.slug}.glb")

    # 匯出 glb：只選模型 collection 內的物件（預覽用地面 / 相機 / 燈不匯出）。
    # 非招牌的網格先合併成單一 <slug>_mesh（每種材質一個 primitive）以降低 draw call；
    # .blend 仍保留按部位分 collection 的原始物件，合併體匯出後即刪除。
    tris = triangle_count(ctx)
    merged = _merge_for_export(ctx)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in [ctx.root, merged] + [o for o in model_objects(ctx) if o.name.startswith("sign:")]:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_cameras=False,
                              export_lights=False)
    me = merged.data
    bpy.data.objects.remove(merged)
    bpy.data.meshes.remove(me)

    cam = _preview_setup(ctx)
    auto_street, auto_aerial = _auto_views(ctx, height, street_dir)
    views = {"street": street or auto_street, "aerial": aerial or auto_aerial}
    engine = bpy.context.scene.render.engine
    for key, (loc, target) in views.items():
        cam.location = loc
        _look(cam, target)
        cam.data.lens = 22 if key == "street" else 30
        cam.data.clip_end = 5000
        blendsafe.render_png(os.path.join(PREVIEW_DIR, f"{ctx.slug}-{key}.png"))
    cam.location, _ = views["aerial"]
    _look(cam, views["aerial"][1])

    blendsafe.save_blend(blend)

    entry = {
        "id": ctx.way_id, "name": ctx.name, "file": f"{ctx.slug}.glb",
        "anchorLat": ctx.lat0, "anchorLon": ctx.lon0,
        "height": round(height, 1), "heightSource": height_source,
        "footprint": ctx.has_footprint, "notes": notes,
    }
    _update_manifest(entry)
    size = os.path.getsize(glb)
    print(f"LANDMARK {ctx.slug} way={ctx.way_id} tris={tris} glb_bytes={size} engine={engine}")
    return tris, size


def _merge_for_export(ctx):
    """把模型內所有非 sign: 網格（套用修改器後、世界座標）併成一個物件，材質槽取聯集。"""
    dg = bpy.context.evaluated_depsgraph_get()
    mats, bm = [], bmesh.new()
    inv = ctx.root.matrix_world.inverted()
    for o in model_objects(ctx):
        if o.type != "MESH" or o.name.startswith("sign:"):
            continue
        me = o.evaluated_get(dg).to_mesh()
        me.transform(inv @ o.matrix_world)
        remap = []
        for m in me.materials:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        n0 = len(bm.faces)
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        for f in bm.faces[n0:]:
            f.material_index = remap[f.material_index] if remap else 0
        o.evaluated_get(dg).to_mesh_clear()
    me = bpy.data.meshes.new(f"{ctx.slug}_mesh")
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(f"{ctx.slug}_mesh", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = ctx.root
    return ob


def _update_manifest(entry):
    items = []
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            items = json.load(f)
    items = [e for e in items if e["id"] != entry["id"]] + [entry]
    items.sort(key=lambda e: e["file"])
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
        f.write("\n")
