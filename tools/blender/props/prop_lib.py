"""道具共用：招牌貼圖面、收尾匯出（body / sign 節點）、manifest 合併寫入、預覽圖。

契約同 night_market_stall.py：原點＝地面、外接盒 XY 中心正下方；+Y 上；顧客面朝 glTF +Z（Blender −Y）；公尺。
manifest 以 id 合併：同 id 取代、其餘條目與 convention 原樣保留（不覆寫別的道具）。
"""
import json
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "vehicles"))
sys.path.insert(0, os.path.dirname(HERE))
import vehicle_lib as VL  # noqa: E402
import blendsafe  # noqa: E402

REPO = VL.REPO
OUT_DIR = os.path.join(REPO, "public", "models", "props")
BLEND_DIR = os.path.join(REPO, "assets", "blender", "props")
MANIFEST = os.path.join(OUT_DIR, "manifest.json")
CONVENTION = ("原點＝地面、外接盒中心正下方；+Y 上、正面（顧客面）朝 glTF +Z、公尺。"
              "節點 body（本體）+ sign（招牌貼圖面）；座標皆為 glTF（x 左右、y 上、z 前）。")


def merge_manifest(entry):
    data = {"convention": CONVENTION, "props": []}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            data = json.load(f)
    props = data.setdefault("props", [])
    for i, e in enumerate(props):
        if e.get("id") == entry["id"]:
            props[i] = entry
            break
    else:
        props.append(entry)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


class Prop(VL.Vehicle):
    def sign_quads(self, tex, quads, strength=0.35):
        """quads：[(cx, y, z0, w, h)]，皆面向 −Y（顧客面），整張貼圖貼滿每個面；合成單一 sign 網格。"""
        m = bpy.data.materials.new("sign")
        m.use_nodes = True
        nt = m.node_tree
        b = nt.nodes.get("Principled BSDF")
        b.inputs["Roughness"].default_value = 0.5
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(tex)
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        nt.links.new(t.outputs["Color"], b.inputs["Emission Color"])   # 夜間招牌微亮
        b.inputs["Emission Strength"].default_value = strength
        bm = bmesh.new()
        uv = bm.loops.layers.uv.verify()
        for cx, y, z0, w, h in quads:
            pts = ((cx - w / 2, y, z0), (cx + w / 2, y, z0), (cx + w / 2, y, z0 + h), (cx - w / 2, y, z0 + h))
            f = bm.faces.new([bm.verts.new(p) for p in pts])
            f.normal_update()
            if f.normal.y > 0:
                f.normal_flip()
            for lp in f.loops:
                lp[uv].uv = ((lp.vert.co.x - (cx - w / 2)) / w, (lp.vert.co.z - z0) / h)
        me = bpy.data.meshes.new("sign")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(m)
        ob = bpy.data.objects.new("sign", me)
        self.coll("body").objects.link(ob)
        ob.parent = self.root
        return ob


def finish(v, sign, name, notes, counter, views):
    """counter：取餐點（glTF x, y, z，置中前座標）；views：{key: (cam loc, target, lens)}。回傳 manifest 條目。"""
    slug = v.slug
    me = bpy.data.meshes.new("body")
    bmesh.ops.remove_doubles(v.bm, verts=v.bm.verts, dist=0.0005)
    v.bm.to_mesh(me)
    v.bm.free()
    for m in v.mats:
        me.materials.append(m)
    body = bpy.data.objects.new("body", me)
    v.coll("body").objects.link(body)
    body.parent = v.root
    me.set_sharp_from_angle(angle=0.73)
    if "_tmp" in v.colls:
        bpy.data.collections.remove(v.colls.pop("_tmp"))
    pts = [p.co.copy() for p in me.vertices] + [p.co.copy() for p in sign.data.vertices]
    xs, ys, zs = [p.x for p in pts], [p.y for p in pts], [p.z for p in pts]
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    for mm in (me, sign.data):
        mm.transform(Matrix.Translation((-cx, -cy, 0)))
    used = {p.material_index for p in me.polygons}
    keep = [m for i, m in enumerate(me.materials) if i in used]
    remap = {i: keep.index(m) for i, m in enumerate(me.materials) if i in used}
    idx = [remap[p.material_index] for p in me.polygons]
    me.materials.clear()
    for m in keep:
        me.materials.append(m)
    for p, i in zip(me.polygons, idx):
        p.material_index = i

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(BLEND_DIR, exist_ok=True)
    glb = os.path.join(OUT_DIR, f"{slug}.glb")
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in v.root_coll.all_objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_apply=True,
                              export_yup=True, export_cameras=False, export_lights=False, export_animations=False)
    tris = 0
    for o in (body, sign):
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    g = lambda p: [round(p[0], 3), round(p[2], 3), round(-p[1], 3)]   # Blender → glTF
    entry = dict(id=slug, name=name, file=f"{slug}.glb",
                 width=round(max(xs) - min(xs), 3), depth=round(max(ys) - min(ys), 3), height=round(max(zs), 3),
                 counter=g(Vector((counter[0], -counter[2], counter[1])) - Vector((cx, cy, 0))),
                 triangles=tris, bytes=os.path.getsize(glb), notes=notes)
    merge_manifest(entry)
    VL.Vehicle.__dict__["_previews"](v, views)
    for k in views:   # vehicle_lib 的預覽檔名帶 vehicle- 前綴，改成道具名
        os.replace(os.path.join(VL.PREVIEW_DIR, f"vehicle-{slug}-{k}.png"),
                   os.path.join(VL.PREVIEW_DIR, f"{slug}-{k}.png"))
    blendsafe.save_blend(os.path.join(BLEND_DIR, f"{slug}.blend"))
    print("PROP_ENTRY", slug, json.dumps({k: entry[k] for k in ("width", "depth", "height", "counter", "triangles", "bytes")}))
    return entry
