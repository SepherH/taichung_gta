"""臺中GTA 車輛共用模組（Blender 5.2，bpy + bmesh）。

座標約定（與遊戲程式的契約）：
- 單位公尺；原點 = 地面、車輛外接盒中心正下方；Blender 內車頭朝 −Y、+Z 上、車輛左側在 +X
  （匯出 glTF +Y up 後車頭朝 +Z）
- 節點：<slug>（根）底下 body + wheel_fl / wheel_fr / wheel_rl / wheel_rr（機車 wheel_f / wheel_r），
  輪子原點在輪心、不帶旋轉，程式繞本地 X 轉動、繞本地 Y 轉向
- 材質：paint（車身主色，執行期換色）、headlight / taillight（帶 emission）、glass、trim、tire、rim 等

建模手法：側視輪廓擠出 → 上半部內收（tumblehome）→ Bevel 倒角 → 布林挖輪拱 → 依法線分玻璃 / 車頂，
所有車身零件合併成單一 body 網格（多材質），降低 draw call。
"""
import bpy
import bmesh
import json
import math
import os
import struct
import sys
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import blendsafe  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GLB_DIR = os.path.join(REPO, "public", "models", "vehicles")
BLEND_DIR = os.path.join(REPO, "assets", "blender", "vehicles")
PREVIEW_DIR = os.path.join(REPO, "docs", "models", "previews")


def hex_rgba(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, 1.0)


def make_mat(name, color, roughness=0.5, metallic=0.0, emission=None, strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = hex_rgba(color)
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    if emission:
        b.inputs["Emission Color"].default_value = hex_rgba(emission)
        b.inputs["Emission Strength"].default_value = strength
    m.diffuse_color = hex_rgba(color)
    return m


COMMON_MATS = {
    "glass": dict(color="#1E2A33", roughness=0.05, metallic=0.3),
    "trim": dict(color="#1B1C1E", roughness=0.6),
    "chrome": dict(color="#B9BDC2", roughness=0.2, metallic=0.9),
    "headlight": dict(color="#F4F1E6", roughness=0.1, emission="#FFF6DD", strength=2.0),
    "taillight": dict(color="#9E1010", roughness=0.2, emission="#FF2A1A", strength=1.5),
    "plate": dict(color="#EDEDE8", roughness=0.5),
    "tire": dict(color="#1A1A1A", roughness=0.9),
    "rim": dict(color="#A7ABB0", roughness=0.3, metallic=0.8),
}


class Vehicle:
    def __init__(self, slug, name, paint, extra_mats=None):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.slug, self.name = slug, name
        scene = bpy.context.scene
        scene.unit_settings.system = "METRIC"
        self.root_coll = bpy.data.collections.new(slug)
        scene.collection.children.link(self.root_coll)
        self.colls = {}
        self.root = bpy.data.objects.new(slug, None)
        self.root.empty_display_size = 1.5
        self.root_coll.objects.link(self.root)
        defs = {"paint": dict(color=paint, roughness=0.3, metallic=0.4)}
        defs.update(COMMON_MATS)
        defs.update(extra_mats or {})
        self.mat_names = list(defs)
        self.mats = [make_mat(n, **defs[n]) for n in self.mat_names]
        self.bm = bmesh.new()      # 合併後的 body
        self.wheels = []

    def mi(self, name):
        return self.mat_names.index(name)

    def coll(self, part):
        if part not in self.colls:
            c = bpy.data.collections.new(f"{self.slug}.{part}")
            self.root_coll.children.link(c)
            self.colls[part] = c
        return self.colls[part]

    # ------------------------------------------------------------ 暫存物件 → 修改器 → 併入 body
    def _tmp(self, bm, name="tmp"):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        self.coll("_tmp").objects.link(ob)
        return ob

    def _bake(self, ob):
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        old = ob.data
        ob.modifiers.clear()
        ob.data = me
        bpy.data.meshes.remove(old)

    def add(self, bm, bevel=0.0, segments=2, cutters=(), glass_sides=0.0, angle=35):
        """glass_sides = 法線 z 門檻（例 0.93）：車艙面法線 z 小於它的改成 glass；0 = 不分。"""
        ob = self._tmp(bm)
        if bevel > 0:
            md = ob.modifiers.new("bevel", "BEVEL")
            md.width = bevel
            md.segments = segments
            md.limit_method = "ANGLE"
            md.angle_limit = math.radians(angle)
            md.harden_normals = False
            self._bake(ob)
        if cutters:
            for i, c in enumerate(cutters):
                md = ob.modifiers.new(f"cut{i}", "BOOLEAN")
                md.operation = "DIFFERENCE"
                md.solver = "EXACT"
                md.material_mode = "TRANSFER"
                md.object = c
            self._bake(ob)
            for c in cutters:
                me = c.data
                bpy.data.objects.remove(c)
                bpy.data.meshes.remove(me)
        if glass_sides:   # 車艙：除了近水平的車頂面，其餘（側窗、擋風、後窗）→ glass
            gi, pi = self.mi("glass"), self.mi("paint")
            for p in ob.data.polygons:
                if p.material_index == pi and p.normal.z < glass_sides:
                    p.material_index = gi
        for p in ob.data.polygons:
            p.use_smooth = True
        self.bm.from_mesh(ob.data)
        me = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)

    # ------------------------------------------------------------ 形狀
    def profile(self, pts_yz, half_w, mat, taper=None, x_off=0.0):
        """側視輪廓 (y, z) 擠出成寬 2·half_w 的實體；taper(z) 回傳 x 縮放（上半部內收）。"""
        pts = list(pts_yz)
        a = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
                for i in range(len(pts)))
        if a < 0:
            pts.reverse()
        bm = bmesh.new()
        L, Rr = [], []
        for y, z in pts:
            s = taper(z) if taper else 1.0
            L.append(bm.verts.new((x_off + half_w * s, y, z)))
            Rr.append(bm.verts.new((x_off - half_w * s, y, z)))
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((Rr[i], Rr[j], L[j], L[i]))
        bm.faces.new(L)
        bm.faces.new(list(reversed(Rr)))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for f in bm.faces:
            f.material_index = self.mi(mat)
        return bm

    def box(self, c, size, mat):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=size, verts=bm.verts)
        bmesh.ops.translate(bm, vec=c, verts=bm.verts)
        for f in bm.faces:
            f.material_index = self.mi(mat)
        return bm

    def cyl(self, p0, p1, r, mat, seg=12, r1=None):
        """p0 → p1 的圓柱（r1 = 末端半徑，做錐台）。"""
        r1 = r if r1 is None else r1
        p0, p1 = Vector(p0), Vector(p1)
        ax = (p1 - p0).normalized()
        ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
        u = ax.cross(ref).normalized()
        v = ax.cross(u)
        bm = bmesh.new()
        a, b = [], []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            d = u * math.cos(t) + v * math.sin(t)
            a.append(bm.verts.new(p0 + d * r))
            b.append(bm.verts.new(p1 + d * r1))
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((a[i], a[j], b[j], b[i]))
        bm.faces.new(list(reversed(a)))
        bm.faces.new(b)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for f in bm.faces:
            f.material_index = self.mi(mat)
        return bm

    def cutter(self, p0, p1, r, mat="trim", seg=24):
        ob = self._tmp(self.cyl(p0, p1, r, mat, seg), "cutter")
        ob.hide_render = True
        return ob

    def arch_cutters(self, axles, r, half_w, depth=0.34, clear=0.045):
        """每個輪位從車側往內挖 depth 公尺的輪拱（不貫穿車身），切面沿用 trim 黑色。"""
        out = []
        for y, z in axles:
            for s in (1, -1):
                out.append(self.cutter((s * (half_w + 0.3), y, z), (s * (half_w - depth), y, z), r + clear))
        return out

    # ------------------------------------------------------------ 輪子
    def wheel(self, name, center, r, width, side, rim_ratio=0.64, spokes=5):
        """車輪：旋轉體輪胎（圓角胎肩）+ 內凹輪框 + 輻條；外側面朝 side（+1 = +X）。"""
        w = width / 2
        rr = r * rim_ratio
        prof = [  # (x, 半徑, 材質) 由內側到外側
            (-w, rr * 0.9, "tire"), (-w, r - 0.045, "tire"), (-w + 0.018, r - 0.008, "tire"),
            (-w + 0.045, r, "tire"), (w - 0.045, r, "tire"), (w - 0.018, r - 0.008, "tire"),
            (w, r - 0.045, "tire"), (w, rr, "rim"), (w - 0.02, rr * 0.93, "rim"),
            (w - 0.045, rr * 0.35, "rim"), (w - 0.035, rr * 0.18, "chrome"), (w - 0.03, 0.0, "chrome"),
        ]
        seg = 24
        bm = bmesh.new()
        rings = []
        for x, rad, _ in prof:
            if rad <= 1e-6:
                rings.append([bm.verts.new((x, 0, 0))])
                continue
            rings.append([bm.verts.new((x, rad * math.cos(2 * math.pi * i / seg), rad * math.sin(2 * math.pi * i / seg)))
                          for i in range(seg)])
        inner_c = bm.verts.new((-w, 0, 0))
        for i in range(seg):   # 內側封蓋
            bm.faces.new((rings[0][(i + 1) % seg], rings[0][i], inner_c)).material_index = self.mi("tire")
        for k in range(len(rings) - 1):
            a, b = rings[k], rings[k + 1]
            m = self.mi(prof[k][2])
            for i in range(seg):
                j = (i + 1) % seg
                if len(b) == 1:
                    f = bm.faces.new((a[i], a[j], b[0]))
                else:
                    f = bm.faces.new((a[i], a[j], b[j], b[i]))
                f.material_index = m
        for s in range(spokes):   # 輻條：讓轉動看得出來
            t = 2 * math.pi * s / spokes
            d = Vector((0, math.cos(t), math.sin(t)))
            n = Vector((0, -math.sin(t), math.cos(t)))
            c0 = d * rr * 0.30 + Vector((w - 0.035, 0, 0))
            c1 = d * rr * 0.92 + Vector((w - 0.022, 0, 0))
            q = []
            for c in (c0, c1):
                for dx in (-0.012, 0.012):
                    for dn in (-1, 1):
                        q.append(bm.verts.new(c + Vector((dx, 0, 0)) + n * dn * r * 0.075))
            for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 2, 6, 4), (1, 5, 7, 3), (0, 4, 5, 1), (2, 3, 7, 6)):
                bm.faces.new([q[i] for i in f]).material_index = self.mi("rim")
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if side < 0:
            bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi, 3, "Z"))
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        for p in me.polygons:
            p.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        ob.location = center
        self.coll("wheels").objects.link(ob)
        ob.parent = self.root
        self.wheels.append(ob)
        return ob

    # ------------------------------------------------------------ 收尾
    def finish(self, meta, views):
        """body 成形、置中、清未用材質、匯出 glb、存 .blend、算預覽、回傳 manifest 條目。"""
        me = bpy.data.meshes.new("body")
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=0.0005)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        body = bpy.data.objects.new("body", me)
        self.coll("body").objects.link(body)
        body.parent = self.root
        me.set_sharp_from_angle(angle=math.radians(42))   # 硬邊保留，匯出時拆法線
        if "_tmp" in self.colls:
            bpy.data.collections.remove(self.colls.pop("_tmp"))
        # 置中：以 body + 輪子的外接盒 XY 中心為原點
        pts = [v.co.copy() for v in me.vertices]
        for w in self.wheels:
            pts += [w.location + v.co for v in w.data.vertices]
        xs, ys, zs = [p.x for p in pts], [p.y for p in pts], [p.z for p in pts]
        cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
        me.transform(Matrix.Translation((-cx, -cy, 0)))
        for w in self.wheels:
            w.location.x -= cx
            w.location.y -= cy
        dims = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - max(min(zs), 0))
        for ob in [body] + self.wheels:   # 清掉沒用到的材質槽
            used = {p.material_index for p in ob.data.polygons}
            keep = [m for i, m in enumerate(ob.data.materials) if i in used]
            remap = {i: keep.index(m) for i, m in enumerate(ob.data.materials) if i in used}
            idx = [remap[p.material_index] for p in ob.data.polygons]
            ob.data.materials.clear()
            for m in keep:
                ob.data.materials.append(m)
            for p, i in zip(ob.data.polygons, idx):
                p.material_index = i

        os.makedirs(GLB_DIR, exist_ok=True)
        os.makedirs(BLEND_DIR, exist_ok=True)
        glb = os.path.join(GLB_DIR, f"{self.slug}.glb")
        for o in bpy.context.scene.objects:
            o.select_set(False)
        for o in self.root_coll.all_objects:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_apply=True,
                                  export_yup=True, export_cameras=False, export_lights=False,
                                  export_animations=False)
        tris = 0
        for o in [body] + self.wheels:
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)

        g = lambda v: [round(v[0], 3), round(v[2], 3), round(-v[1], 3)]   # Blender → glTF
        wheels = {w.name: g(w.location) for w in self.wheels}
        entry = dict(id=self.slug, name=self.name, file=f"{self.slug}.glb",
                     length=round(dims[1], 3), width=round(dims[0], 3), height=round(dims[2], 3))
        entry.update(meta)
        entry["seat"] = g(Vector(meta["seat"]) - Vector((cx, cy, 0)))
        entry["wheels"] = wheels
        entry["triangles"] = tris
        entry["bytes"] = os.path.getsize(glb)
        self._previews(views)
        blendsafe.save_blend(os.path.join(BLEND_DIR, f"{self.slug}.blend"))
        print(f"VEHICLE {self.slug} tris={tris} glb_bytes={entry['bytes']} dims={[round(d, 3) for d in dims]}")
        return entry

    def _previews(self, views):
        scene = bpy.context.scene
        pc = bpy.data.collections.new("_preview（不匯出）")
        scene.collection.children.link(pc)
        me = bpy.data.meshes.new("preview_ground")
        bm = bmesh.new()
        s = 60
        bm.faces.new([bm.verts.new(v) for v in ((-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0))])
        bm.to_mesh(me)
        bm.free()
        me.materials.append(make_mat("preview_ground", "#77797A", 0.9))
        pc.objects.link(bpy.data.objects.new("preview_ground", me))
        sun = bpy.data.objects.new("preview_sun", bpy.data.lights.new("preview_sun", "SUN"))
        sun.data.energy = 3.2
        sun.rotation_euler = (math.radians(45), 0, math.radians(-30))
        pc.objects.link(sun)
        cam = bpy.data.objects.new("preview_camera", bpy.data.cameras.new("preview_camera"))
        pc.objects.link(cam)
        scene.camera = cam
        world = bpy.data.worlds.new("preview_sky")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgba("#B9C7D6")
        world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
        scene.world = world
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_x, scene.render.resolution_y = 768, 432
        scene.render.image_settings.file_format = "PNG"
        try:
            scene.eevee.taa_render_samples = 24
        except AttributeError:
            pass
        for key, (loc, target, lens) in views.items():
            cam.location = loc
            cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
            cam.data.lens = lens
            out = os.path.join(PREVIEW_DIR, f"vehicle-{self.slug}-{key}.png")
            blendsafe.render_png(out, scene)


def glb_nodes(path):
    with open(path, "rb") as f:
        data = f.read()
    ln = struct.unpack_from("<I", data, 12)[0]
    js = json.loads(data[20:20 + ln])
    return [n.get("name") for n in js["nodes"]], [m["name"] for m in js.get("materials", [])]
