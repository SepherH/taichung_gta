"""夜市攤車道具（臺灣夜市常見不鏽鋼攤車 + 遮雨棚 + 招牌的一般外觀；店名「阿福鹽酥雞」為虛構）。

執行：blender -b -P tools/blender/props/night_market_stall.py
產出：public/models/props/night_market_stall.glb、public/models/props/manifest.json、
      assets/blender/props/night_market_stall.blend（+ 招牌貼圖原檔 night_market_stall_sign.jpg）、
      docs/models/previews/night_market_stall-{front34,rear34}.png
用途：給「夜市時段外送」的取餐點擺放（接法由開發線決定）。尺寸皆為推測（一般夜市攤車）。
座標（glTF）：原點＝地面、外接盒中心正下方；+Y 上；顧客面（招牌、玻璃櫃正面）朝 +Z；公尺。
節點：night_market_stall（根）底下 body（攤車本體，多材質單一網格）+ sign（招牌貼圖面，獨立網格帶 UV）。
材質：bulb 帶 emission（夜間燈泡）；paint＝遮雨棚 / 招牌底紅色。
"""
import json
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "vehicles"))
import vehicle_lib as VL  # noqa: E402
import blendsafe  # noqa: E402

SLUG = "night_market_stall"
REPO = VL.REPO
OUT_DIR = os.path.join(REPO, "public", "models", "props")
BLEND_DIR = os.path.join(REPO, "assets", "blender", "props")
TEX = os.path.join(BLEND_DIR, "night_market_stall_sign.jpg")

CART = (1.80, 0.90, 0.88)     # 攤車本體 長（x）× 深（y）× 檯面高（推測）
ROOF_Z = 2.30                 # 棚頂高（推測）
SIGN = (1.90, 0.66, 2.36)     # 招牌 寬 × 高、下緣 z（貼圖 1024×384 比例約 2.67:1 → 寬 1.76 時高 0.66）
COUNTER = (0.0, 0.95, 0.62)   # 取餐點（glTF：檯面前緣上方，顧客站位前方）


class Prop(VL.Vehicle):
    def sign_plane(self):
        img = bpy.data.images.load(TEX)
        m = bpy.data.materials.new("sign")
        m.use_nodes = True
        nt = m.node_tree
        b = nt.nodes.get("Principled BSDF")
        b.inputs["Roughness"].default_value = 0.5
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
        nt.links.new(tex.outputs["Color"], b.inputs["Emission Color"])   # 夜間招牌微亮
        b.inputs["Emission Strength"].default_value = 0.35
        bm = bmesh.new()
        uv = bm.loops.layers.uv.verify()
        w, h, z0 = 1.76, 0.62, SIGN[2] + 0.02
        y = -CART[1] / 2 - 0.137   # 招牌紅底板前面在 −0.58，貼圖面再往前 7 mm 避免 z-fight
        f = bm.faces.new([bm.verts.new(p) for p in ((-w / 2, y, z0), (w / 2, y, z0), (w / 2, y, z0 + h), (-w / 2, y, z0 + h))])
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
        for lp in f.loops:
            lp[uv].uv = ((lp.vert.co.x + w / 2) / w, (lp.vert.co.z - z0) / h)
        me = bpy.data.meshes.new("sign")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(m)
        ob = bpy.data.objects.new("sign", me)
        self.coll("body").objects.link(ob)
        ob.parent = self.root
        return ob


def build():
    v = Prop(SLUG, "夜市攤車", "#C8322B", extra_mats={
        "steel": dict(color="#C9CDD1", roughness=0.3, metallic=0.85),     # 不鏽鋼
        "food": dict(color="#C98A2E", roughness=0.8),                      # 炸物
        "bulb": dict(color="#FFE9B0", roughness=0.2, emission="#FFD27A", strength=3.0),
        "white": dict(color="#F1F0EA", roughness=0.6),
    })
    L, D, H = CART
    # ---- 攤車本體：不鏽鋼箱體、檯面、前面板腰帶、腳輪
    v.add(v.box((0, 0, (0.18 + H) / 2), (L, D, H - 0.18), "steel"), bevel=0.02)
    v.add(v.box((0, 0, H + 0.02), (L + 0.08, D + 0.08, 0.04), "steel"), bevel=0.01)
    v.add(v.box((0, -D / 2 - 0.006, 0.55), (L - 0.1, 0.012, 0.16), "paint"))
    for x in (-L / 2 + 0.12, L / 2 - 0.12):
        for y in (-D / 2 + 0.12, D / 2 - 0.12):
            v.add(v.cyl((x - 0.03, y, 0.08), (x + 0.03, y, 0.08), 0.08, "trim", seg=10))
            v.add(v.box((x, y, 0.15), (0.05, 0.05, 0.06), "trim"))
    # ---- 玻璃展示櫃（前半）與炸物
    # 展示櫃做成開放框（不鏽鋼框 + 深色背板），不用不透明玻璃，炸物才看得到
    v.add(v.box((-0.15, 0.17, H + 0.26), (1.20, 0.02, 0.44), "glass"))
    for x in (-0.74, 0.44):
        for y in (-0.37, 0.17):
            v.add(v.box((x, y, H + 0.26), (0.025, 0.025, 0.44), "steel"))
    v.add(v.box((-0.15, -0.10, H + 0.485), (1.24, 0.60, 0.03), "steel"))
    for i in range(6):
        for j in range(2):
            v.add(v.box((-0.62 + i * 0.19, -0.24 + j * 0.24, H + 0.10), (0.13, 0.15, 0.07), "food"), bevel=0.02)
    # ---- 後方油鍋與瓦斯桶
    v.add(v.cyl((0.62, 0.15, H + 0.04), (0.62, 0.15, H + 0.24), 0.22, "trim", seg=14))
    v.add(v.cyl((0.62, 0.15, H + 0.22), (0.62, 0.15, H + 0.245), 0.20, "food", seg=14))
    v.add(v.cyl((0.55, D / 2 + 0.25, 0.0), (0.55, D / 2 + 0.25, 0.62), 0.16, "paint", seg=12))
    # ---- 四根立柱、遮雨棚（紅白條紋，前低後高）
    for x in (-L / 2 + 0.03, L / 2 - 0.03):
        for y in (-D / 2 + 0.03, D / 2 - 0.03):
            v.add(v.cyl((x, y, H), (x, y, ROOF_Z + (0.08 if y > 0 else 0)), 0.022, "steel", seg=8))
    n = 7
    w = (L + 0.30) / n
    for i in range(n):
        x = -(L + 0.30) / 2 + (i + 0.5) * w
        bm = v.box((x, 0.0, ROOF_Z + 0.04), (w, D + 0.50, 0.03), "paint" if i % 2 == 0 else "white")
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(x, 0, ROOF_Z + 0.04), matrix=Matrix.Rotation(-0.09, 3, "X"))
        v.add(bm)
    # 前垂邊（波浪改直條，省面）
    for i in range(n):
        x = -(L + 0.30) / 2 + (i + 0.5) * w
        v.add(v.box((x, -(D + 0.50) / 2 + 0.01, ROOF_Z - 0.06), (w, 0.02, 0.16), "paint" if i % 2 == 0 else "white"))
    # ---- 招牌底板（紅底 + 不鏽鋼框）與兩支吊燈
    v.add(v.box((0, -D / 2 - 0.10, SIGN[2] + 0.33), (SIGN[0], 0.04, SIGN[1] + 0.04), "steel"))
    v.add(v.box((0, -D / 2 - 0.12, SIGN[2] + 0.33), (SIGN[0] - 0.06, 0.02, SIGN[1] - 0.02), "paint"))
    for x in (-0.55, 0.55):
        v.add(v.cyl((x, -0.15, ROOF_Z), (x, -0.15, ROOF_Z - 0.35), 0.006, "trim", seg=4))
        v.add(v.cyl((x, -0.15, ROOF_Z - 0.35), (x, -0.15, ROOF_Z - 0.47), 0.05, "bulb", seg=10, r1=0.035))

    sign = v.sign_plane()
    # ---- 收尾：body 成形、置中（外接盒 XY 中心）、清材質、匯出
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
    glb = os.path.join(OUT_DIR, f"{SLUG}.glb")
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
    entry = dict(id=SLUG, name="夜市攤車（阿福鹽酥雞，虛構店名）", file=f"{SLUG}.glb",
                 width=round(max(xs) - min(xs), 3), depth=round(max(ys) - min(ys), 3), height=round(max(zs), 3),
                 counter=g(Vector((COUNTER[0], -COUNTER[2], COUNTER[1])) - Vector((cx, cy, 0))),
                 triangles=tris, bytes=os.path.getsize(glb),
                 notes=("臺灣夜市常見不鏽鋼攤車一般外觀（推測尺寸）：攤車 1.8 × 0.9 m、檯面高 0.88、棚頂約 2.3、招牌頂約 3.0。"
                        "顧客面（招牌、玻璃櫃）朝 glTF +Z；counter＝取餐點（檯面前緣上方，glTF 座標）。"
                        "招牌為本機生圖貼圖（虛構店名，無真實商標）；bulb 材質帶 emission。"))
    manifest = {"convention": ("原點＝地面、外接盒中心正下方；+Y 上、正面（顧客面）朝 glTF +Z、公尺。"
                               "節點 body（本體）+ sign（招牌貼圖面）；座標皆為 glTF（x 左右、y 上、z 前）。"),
                "props": [entry]}
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    Previews = VL.Vehicle.__dict__["_previews"]
    v.slug = SLUG
    views = {"front34": ((3.6, -6.0, 2.6), (0, 0, 1.5), 35), "rear34": ((-3.6, 5.8, 2.8), (0, 0, 1.5), 35)}
    Previews(v, views)
    for k in views:   # vehicle_lib 的預覽檔名帶 vehicle- 前綴，改成道具名
        os.replace(os.path.join(VL.PREVIEW_DIR, f"vehicle-{SLUG}-{k}.png"),
                   os.path.join(VL.PREVIEW_DIR, f"{SLUG}-{k}.png"))
    blendsafe.save_blend(os.path.join(BLEND_DIR, f"{SLUG}.blend"))
    print("PROP_ENTRY", json.dumps({k: entry[k] for k in ("width", "depth", "height", "counter", "triangles", "bytes")}))


if __name__ == "__main__":
    build()
