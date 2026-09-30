"""臺中GTA 行人角色：3 個體型 / 髮型變體，共用同一副骨架與同一組 10 個動作。

執行：blender -b -P tools/blender/characters/build_characters.py
產出：assets/blender/characters/<slug>.blend、public/models/characters/<slug>.glb、
      public/models/characters/manifest.json、docs/models/previews/characters-*.png
外觀依據：無特定真人原型（通用行人）；臺灣街頭常見穿著＝短袖上衣 + 長褲 + 球鞋。
"""
import json
import math
import os
import struct
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import char_lib as C  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GLB_DIR = os.path.join(REPO, "public", "models", "characters")
BLEND_DIR = os.path.join(REPO, "assets", "blender", "characters")
PREVIEW_DIR = os.path.join(REPO, "docs", "models", "previews")
SCRATCH = os.environ.get("CHAR_PREVIEW_SCRATCH", "")   # 有設才輸出大張驗收圖

BASE_G = dict(arm=1.28, leg=1.12, hand=1.2, torso=1.0, hip=1.0, chest=1.0, belly=1.0, shoulder=1.0,
              neck=1.0, shoe=1.0, sleeve=0.45, delt_in=0.0)
VARIANTS = [
    dict(slug="pedestrian", name="行人 A（短髮男性、標準體型）", hair="short",
         colors=dict(skin="#D6A27C", shirt="#3E6FA8", pants="#3A3F4B", hair="#1C1917", shoes="#E8E6E1"),
         g=dict(BASE_G)),
    dict(slug="pedestrian_f", name="行人 B（及肩短髮 + 馬尾女性、纖細體型）", hair="bob",
         colors=dict(skin="#E3B393", shirt="#C8506A", pants="#2F3A58", hair="#2A1C16", shoes="#F2F0EC"),
         g=dict(BASE_G, arm=1.12, leg=1.05, hand=1.1, torso=0.9, hip=1.05, chest=0.95, shoulder=0.88,
                neck=0.9, shoe=0.9, sleeve=0.30, delt_in=0.02)),
    dict(slug="pedestrian_heavy", name="行人 C（平頭、壯碩體型）", hair="buzz",
         colors=dict(skin="#C68E68", shirt="#5B6B3A", pants="#4B4038", hair="#141210", shoes="#3A3A3A"),
         g=dict(BASE_G, arm=1.5, leg=1.28, hand=1.3, torso=1.14, hip=1.10, chest=1.12, belly=1.22, shoulder=1.10,
                neck=1.2, shoe=1.05, sleeve=0.50)),
]

# ---------------------------------------------------------------- 動作（骨架空間軸，見 char_lib 檔頭）
M = C.merge


def idle0():
    return {"LeftUpperArm": (3, -5, 0), "RightUpperArm": (3, 5, 0), "LeftLowerArm": (-12, 0, 0),
            "RightLowerArm": (-12, 0, 0), "Spine": (1, 0, 0),
            "LeftUpperLeg": (0, -2, 0), "RightUpperLeg": (0, 2, 0), "LeftFoot": (0, 2, 0), "RightFoot": (0, -2, 0)}


def idle1():
    return M(idle0(), {"Chest": (-2, 0, 0), "LeftUpperArm": (4, -6, 0), "RightUpperArm": (4, 6, 0),
                       "LeftShoulder": (0, -1.5, 0), "RightShoulder": (0, 1.5, 0), "Head": (1, 0, 3),
                       "loc": (0, 0, 0.004)})


def walk_keys():
    w0 = M({"loc": (0, 0, -0.032), "Hips": (0, 0, -6), "Spine": (3, 0, 0), "Chest": (0, 0, 8),
            "Head": (-2, 0, -2)},
           {"LeftUpperLeg": (-20, 0, 0), "LeftLowerLeg": (3, 0, 0), "LeftFoot": (-10, 0, 0)},
           {"RightUpperLeg": (16, 0, 0), "RightLowerLeg": (20, 0, 0), "RightFoot": (22, 0, 0)},
           {"LeftUpperArm": (18, -5, 0), "LeftLowerArm": (-12, 0, 0),
            "RightUpperArm": (-20, 5, 0), "RightLowerArm": (-28, 0, 0)})
    w1 = M({"loc": (0, 0, 0.0), "Spine": (3, 0, 0)},
           {"LeftUpperLeg": (-2, 0, 0), "LeftLowerLeg": (8, 0, 0), "LeftFoot": (-6, 0, 0)},
           {"RightUpperLeg": (-18, 0, 0), "RightLowerLeg": (48, 0, 0), "RightFoot": (6, 0, 0)},
           {"LeftUpperArm": (0, -5, 0), "LeftLowerArm": (-16, 0, 0),
            "RightUpperArm": (0, 5, 0), "RightLowerArm": (-18, 0, 0)})
    return [(0, w0), (8, w1), (16, C.mirror(w0)), (24, C.mirror(w1)), (32, w0)]


def run_keys():
    r0 = M({"loc": (0, 0, -0.065), "Hips": (0, 0, -8), "Spine": (10, 0, 0), "Chest": (2, 0, 12),
            "Head": (-10, 0, -4)},
           {"LeftUpperLeg": (-30, 0, 0), "LeftLowerLeg": (18, 0, 0), "LeftFoot": (12, 0, 0)},
           {"RightUpperLeg": (22, 0, 0), "RightLowerLeg": (75, 0, 0), "RightFoot": (25, 0, 0)},
           {"LeftUpperArm": (35, -6, 0), "LeftLowerArm": (-70, 0, 0),
            "RightUpperArm": (-45, 6, 0), "RightLowerArm": (-95, 0, 0)})
    r1 = M({"loc": (0, 0, 0.0), "Spine": (10, 0, 0), "Chest": (2, 0, 0), "Head": (-10, 0, 0)},
           {"LeftUpperLeg": (12, 0, 0), "LeftLowerLeg": (25, 0, 0), "LeftFoot": (30, 0, 0)},
           {"RightUpperLeg": (-55, 0, 0), "RightLowerLeg": (95, 0, 0), "RightFoot": (10, 0, 0)},
           {"LeftUpperArm": (5, -6, 0), "LeftLowerArm": (-80, 0, 0),
            "RightUpperArm": (-10, 6, 0), "RightLowerArm": (-85, 0, 0)})
    return [(0, r0), (5, r1), (10, C.mirror(r0)), (15, C.mirror(r1)), (20, r0)]


def both_legs(thigh, knee, hips_pitch=0.0, extra=0.0):
    return M(C.legs_flat(thigh, knee, hips_pitch, "Left", extra), C.legs_flat(thigh, knee, hips_pitch, "Right", extra))


def arms(ua, la, ab=0.0):
    """雙臂對稱：ua = 上臂 X（負 = 往前抬），ab = 外展度數，la = 手肘彎。"""
    return {"LeftUpperArm": (ua, -ab, 0), "RightUpperArm": (ua, ab, 0),
            "LeftLowerArm": (la, 0, 0), "RightLowerArm": (la, 0, 0)}


def jump_keys():
    crouch = M(both_legs(-55, 95), {"loc": (0, 0, C.crouch_drop(-55, 95)), "Spine": (22, 0, 0),
                                     "Chest": (5, 0, 0), "Head": (-15, 0, 0)}, arms(45, -20, 5))
    take = M({"LeftUpperLeg": (0, 0, 0), "RightUpperLeg": (0, 0, 0), "LeftLowerLeg": (5, 0, 0),
              "RightLowerLeg": (5, 0, 0), "LeftFoot": (35, 0, 0), "RightFoot": (35, 0, 0),
              "Spine": (-3, 0, 0)}, arms(-150, -10, 10))
    tuck = M({"LeftUpperLeg": (-60, 0, 0), "RightUpperLeg": (-60, 0, 0), "LeftLowerLeg": (100, 0, 0),
              "RightLowerLeg": (100, 0, 0), "LeftFoot": (20, 0, 0), "RightFoot": (20, 0, 0),
              "Spine": (10, 0, 0), "Head": (-6, 0, 0)}, arms(-110, -30, 15))
    pre = M({"LeftUpperLeg": (-25, 0, 0), "RightUpperLeg": (-25, 0, 0), "LeftLowerLeg": (30, 0, 0),
             "RightLowerLeg": (30, 0, 0), "LeftFoot": (5, 0, 0), "RightFoot": (5, 0, 0),
             "Spine": (5, 0, 0)}, arms(-60, -20, 20))
    land = M(both_legs(-45, 75), {"loc": (0, 0, C.crouch_drop(-45, 75)), "Spine": (18, 0, 0),
                                   "Head": (-12, 0, 0)}, arms(-30, -40, 15))
    return [(0, idle0()), (6, crouch), (11, take), (17, tuck), (23, pre), (26, land), (32, idle0())]


def punch_keys():
    stance = {"LeftUpperLeg": (-10, 0, 0), "LeftLowerLeg": (12, 0, 0), "LeftFoot": (-2, 0, 0),
              "RightUpperLeg": (10, 0, 0), "RightLowerLeg": (14, 0, 0), "RightFoot": (-24, 0, 0)}
    guard = M(stance, {"loc": (0, 0, -0.03), "Spine": (5, 0, 0), "Chest": (0, 0, -10), "Head": (0, 0, 8),
                       "LeftUpperArm": (-45, -8, 0), "LeftLowerArm": (-125, 0, 0),
                       "RightUpperArm": (-40, 8, 0), "RightLowerArm": (-130, 0, 0)})
    hit = M(stance, {"loc": (0, 0, -0.04), "Spine": (8, 0, 6), "Chest": (0, 0, 28), "Head": (0, 0, -24),
                     "LeftUpperArm": (-50, -8, 0), "LeftLowerArm": (-125, 0, 0),
                     "RightUpperArm": (-88, -6, 0), "RightLowerArm": (-4, 0, 0)})
    back = M(stance, {"loc": (0, 0, -0.03), "Spine": (6, 0, 2), "Chest": (0, 0, 10), "Head": (0, 0, -6),
                      "LeftUpperArm": (-45, -8, 0), "LeftLowerArm": (-120, 0, 0),
                      "RightUpperArm": (-60, 4, 0), "RightLowerArm": (-70, 0, 0)})
    return [(0, idle0()), (4, guard), (7, hit), (10, hit), (13, back), (18, idle0())]


def hit_keys():
    snap = M({"loc": (0, 0, -0.02), "Spine": (-10, 0, 4), "Chest": (-10, 0, 6), "Neck": (-10, 0, 0),
              "Head": (-18, 0, 8),
              "LeftUpperLeg": (6, 0, 0), "LeftLowerLeg": (10, 0, 0), "LeftFoot": (-16, 0, 0),
              "RightUpperLeg": (-8, 0, 0), "RightLowerLeg": (12, 0, 0), "RightFoot": (-4, 0, 0)},
             arms(15, -35, 25))
    rec = M(both_legs(-8, 16), {"loc": (0, 0, C.crouch_drop(-8, 16)), "Spine": (6, 0, -2), "Chest": (3, 0, 0),
                                "Head": (5, 0, 0)}, arms(5, -25, 10))
    return [(0, idle0()), (3, snap), (8, rec), (15, idle0())]


LIE_LOC = (0, 0.25, 0.115 - 0.95)


def lie_pose():
    return {"loc": LIE_LOC, "Hips": (-90, 0, 0), "Spine": (-2, 0, 0), "Head": (0, 0, 20),
            "LeftUpperArm": (-15, -40, 0), "RightUpperArm": (-10, 45, 0),
            "LeftLowerArm": (-20, 0, 0), "RightLowerArm": (-30, 0, 0),
            "LeftUpperLeg": (-4, -6, 0), "LeftLowerLeg": (8, 0, 0), "LeftFoot": (-10, 0, 0),
            "RightUpperLeg": (-12, 6, 0), "RightLowerLeg": (22, 0, 0), "RightFoot": (-6, 0, 0)}


def knockdown_keys():
    stag = M(both_legs(-15, 30), {"loc": (0, 0.05, C.crouch_drop(-15, 30)), "Spine": (-15, 0, 0),
                                  "Chest": (-10, 0, 0), "Head": (-25, 0, 0)}, arms(-50, -30, 35))
    fall = M({"loc": (0, 0.20, -0.40), "Hips": (-45, 0, 0), "Spine": (-5, 0, 0), "Head": (15, 0, 0),
              "LeftUpperLeg": (5, 0, 0), "RightUpperLeg": (-5, 0, 0), "LeftLowerLeg": (25, 0, 0),
              "RightLowerLeg": (35, 0, 0), "LeftFoot": (-10, 0, 0), "RightFoot": (-10, 0, 0)},
             arms(-80, -20, 50))
    impact = M(lie_pose(), {"Hips": (-88, 0, 0), "loc": (0, 0.25, -0.83), "Head": (8, 0, 10),
                            "LeftUpperArm": (-30, -50, 0), "RightUpperArm": (-30, 50, 0)})
    bounce = M(lie_pose(), {"Hips": (-86, 0, 0), "loc": (0, 0.25, -0.82), "Head": (2, 0, 16)})
    return [(0, idle0()), (5, stag), (13, fall), (20, impact), (26, bounce), (36, lie_pose())]


def getup_keys():
    sit = M({"loc": (0, 0.12, 0.12 - 0.95), "Hips": (-25, 0, 0), "Spine": (15, 0, 0), "Chest": (10, 0, 0),
             "Head": (5, 0, 0),
             "LeftUpperLeg": (-63, -4, 0), "RightUpperLeg": (-85, 4, 0), "LeftLowerLeg": (2, 0, 0),
             "RightLowerLeg": (45, 0, 0), "LeftFoot": (-5, 0, 0), "RightFoot": (20, 0, 0)},
            arms(35, -10, 15))
    squat = M(both_legs(-120, 135, -5), {"loc": (0, 0.0, C.crouch_drop(-120, 135)), "Hips": (-5, 0, 0),
                                         "Spine": (40, 0, 0), "Chest": (10, 0, 0), "Head": (-20, 0, 0)},
              arms(-40, -40, 10))
    half = M(both_legs(-60, 95), {"loc": (0, 0, C.crouch_drop(-60, 95)), "Spine": (25, 0, 0), "Chest": (5, 0, 0),
                                  "Head": (-12, 0, 0)}, arms(-15, -30, 8))
    return [(0, lie_pose()), (10, sit), (20, squat), (32, half), (45, idle0())]


DRIVE_HIP_H = 0.30   # drive 時 Hips 關節離腳底平面（＝車內地板）的高度


def drive0():
    return M({"loc": (0, 0, DRIVE_HIP_H - 0.95), "Hips": (-15, 0, 0), "Spine": (8, 0, 0), "Chest": (2, 0, 0),
              "Neck": (3, 0, 0), "Head": (2, 0, 0),
              "LeftUpperLeg": (-67, -4, 0), "RightUpperLeg": (-67, 4, 0), "LeftLowerLeg": (50, 0, 0),
              "RightLowerLeg": (50, 0, 0), "LeftFoot": (15, 0, 0), "RightFoot": (15, 0, 0),
              "LeftUpperArm": (-52, 10, 0), "RightUpperArm": (-52, -10, 0),
              "LeftLowerArm": (-55, 0, 0), "RightLowerArm": (-55, 0, 0)})


def drive1():
    return M(drive0(), {"LeftUpperArm": (-57, 10, 0), "RightUpperArm": (-47, -10, 0), "Chest": (2, 0, 3),
                        "Head": (2, 0, 6)})


def enter_keys():
    reach = M(idle0(), {"RightUpperArm": (-50, 18, 0), "RightLowerArm": (-25, 0, 0), "Chest": (0, 0, -12),
                        "Head": (0, 0, -15)})
    pull = M(idle0(), {"loc": (0, 0, -0.02), "RightUpperArm": (-35, 30, 0), "RightLowerArm": (-60, 0, 0),
                       "Chest": (0, 0, -20), "Head": (0, 0, -10)})
    duck = M(C.legs_flat(-25, 40, 0, "Left"),
             {"loc": (0, 0, C.crouch_drop(-25, 40)), "Spine": (35, 0, 0), "Chest": (5, 0, 0), "Head": (10, 0, 0),
              "RightUpperLeg": (-55, 25, 0), "RightLowerLeg": (70, 0, 0), "RightFoot": (-15, 0, 0),
              "RightUpperArm": (-45, 10, 0), "RightLowerArm": (-30, 0, 0),
              "LeftUpperArm": (-20, -15, 0), "LeftLowerArm": (-30, 0, 0)})
    sitdown = M({"loc": (0, 0, -0.55), "Hips": (-10, 0, 0), "Spine": (15, 0, 0), "Head": (0, 0, 0),
                 "RightUpperLeg": (-70, 10, 0), "RightLowerLeg": (60, 0, 0), "RightFoot": (10, 0, 0),
                 "LeftUpperLeg": (-55, 0, 0), "LeftLowerLeg": (70, 0, 0), "LeftFoot": (-5, 0, 0)},
                arms(-40, -50, -8))
    return [(0, idle0()), (8, reach), (16, pull), (25, duck), (33, sitdown), (40, drive0())]


CLIPS = [  # 名稱, 關鍵影格, 是否循環
    ("idle", lambda: [(0, idle0()), (30, idle1()), (60, idle0())], True),
    ("walk", walk_keys, True),
    ("run", run_keys, True),
    ("jump", jump_keys, False),
    ("punch", punch_keys, False),
    ("hit", hit_keys, False),
    ("knockdown", knockdown_keys, False),
    ("getup", getup_keys, False),
    ("enter_car", enter_keys, False),
    ("drive", lambda: [(0, drive0()), (30, drive1()), (60, drive0())], True),
]
PREVIEW_FRAMES = {"idle": [0, 30], "walk": [0, 8, 16], "run": [0, 5, 10], "jump": [6, 17, 26],
                  "punch": [4, 7, 13], "hit": [3, 8], "knockdown": [5, 13, 36], "getup": [10, 20, 32],
                  "enter_car": [8, 25, 33], "drive": [0, 30]}


# ---------------------------------------------------------------- glb 解析（驗證用）
def glb_info(path):
    with open(path, "rb") as f:
        data = f.read()
    ln = struct.unpack_from("<I", data, 12)[0]
    js = json.loads(data[20:20 + ln])
    acc = js["accessors"]
    anims = []
    for a in js.get("animations", []):
        dur = max(acc[s["input"]]["max"][0] for s in a["samplers"])
        anims.append((a["name"], round(dur, 4)))
    tris = 0
    for m in js["meshes"]:
        for p in m["primitives"]:
            tris += acc[p["indices"]]["count"] // 3
    mats = [m["name"] for m in js.get("materials", [])]
    nodes = [n.get("name") for n in js["nodes"]]
    return dict(anims=anims, tris=tris, mats=mats, nodes=nodes, bytes=len(data),
                joints=len(js["skins"][0]["joints"]) if js.get("skins") else 0)


# ---------------------------------------------------------------- 預覽
def preview_scene(ch):
    import bmesh
    scene = bpy.context.scene
    pc = bpy.data.collections.new("_preview（不匯出）")
    scene.collection.children.link(pc)
    me = bpy.data.meshes.new("preview_ground")
    bm = bmesh.new()
    s = 6
    bm.faces.new([bm.verts.new(v) for v in ((-s, -s, -0.002), (s, -s, -0.002), (s, s, -0.002), (-s, s, -0.002))])
    bm.to_mesh(me)
    bm.free()
    me.materials.append(C.mat("preview_ground", "#B8BBB4", 0.9))
    pc.objects.link(bpy.data.objects.new("preview_ground", me))
    cam = bpy.data.objects.new("preview_camera", bpy.data.cameras.new("preview_camera"))
    pc.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 50
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.image_settings.file_format = "PNG"
    world = bpy.data.worlds.new("preview_sky")
    world.color = C.hex_rgba("#C9D3DC")[:3]
    scene.world = world
    return cam


def look(cam, loc, target):
    from mathutils import Vector
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def render_to(path, w, h):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def sheet(cells, cols, cw, chh, out):
    """cells = [png 路徑]（由左到右、由上到下），拼成一張 PNG。"""
    import numpy as np
    rows = (len(cells) + cols - 1) // cols
    W, H = cols * cw, rows * chh
    big = np.ones((H, W, 4), dtype=np.float32)
    for i, p in enumerate(cells):
        im = bpy.data.images.load(p)
        px = np.empty(cw * chh * 4, dtype=np.float32)
        im.pixels.foreach_get(px)
        px = px.reshape(chh, cw, 4)
        r, c = divmod(i, cols)
        y0 = H - (r + 1) * chh
        big[y0:y0 + chh, c * cw:(c + 1) * cw] = px
        bpy.data.images.remove(im)
    img = bpy.data.images.new("sheet", W, H, alpha=True)
    img.pixels.foreach_set(big.ravel())
    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def clip_previews(ch, cam, out_dir, tag):
    arm = ch["arm"]
    cells = []
    for name, _, _ in CLIPS:
        act = bpy.data.actions[name]
        arm.animation_data.action = act
        for f in PREVIEW_FRAMES[name]:
            bpy.context.scene.frame_set(f)
            if name in ("knockdown", "getup"):
                view = ((2.3, -3.1, 1.6), (0, 0.15, 0.5))
            elif name in ("punch", "enter_car", "drive"):
                view = ((3.2, -1.3, 1.25), (0, 0, 0.8))
            else:
                view = ((1.9, -2.9, 1.3), (0, 0, 0.88))
            look(cam, *view)
            p = os.path.join(out_dir, f"{tag}-{name}-{f:02d}.png")
            render_to(p, 300, 360)
            cells.append(p)
    arm.animation_data.action = None
    return cells


# ---------------------------------------------------------------- 主流程
def build_variant(v):
    ch = C.build_character(v)
    for name, keys, loop in CLIPS:
        C.make_action(ch, name, keys(), loop)
    glb = os.path.join(GLB_DIR, f"{v['slug']}.glb")
    blend = os.path.join(BLEND_DIR, f"{v['slug']}.blend")
    os.makedirs(GLB_DIR, exist_ok=True)
    C.export(ch, glb, blend)
    info = glb_info(glb)
    cam = preview_scene(ch)
    # 立繪（idle 第 0 格）給 lineup
    arm = ch["arm"]
    arm.animation_data.action = bpy.data.actions["idle"]
    bpy.context.scene.frame_set(0)
    look(cam, (1.5, -3.6, 1.2), (0, 0, 0.88))
    tmp = SCRATCH or bpy.app.tempdir
    stand = os.path.join(tmp, f"{v['slug']}-stand.png")
    render_to(stand, 256, 420)
    arm.animation_data.action = None
    cells = clip_previews(ch, cam, tmp, v["slug"]) if (SCRATCH or v["slug"] == "pedestrian") else []
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)
    print(f"CHARACTER {v['slug']} tris={info['tris']} glb_bytes={info['bytes']} joints={info['joints']} "
          f"anims={info['anims']} mats={info['mats']}")
    return info, stand, cells


def main():
    results = {}
    stands = []
    for v in VARIANTS:
        info, stand, cells = build_variant(v)
        results[v["slug"]] = info
        stands.append(stand)
        if cells:
            n = len(cells)
            half = 13
            sheet(cells[:half], 5, 300, 360, os.path.join(SCRATCH or bpy.app.tempdir, f"{v['slug']}-clips-a.png"))
            sheet(cells[half:], 5, 300, 360, os.path.join(SCRATCH or bpy.app.tempdir, f"{v['slug']}-clips-b.png"))
            if v["slug"] == "pedestrian":
                full = os.path.join(PREVIEW_DIR, "characters-clips.png")
                sheet(cells, 7, 300, 360, full)
    sheet(stands, 3, 256, 420, os.path.join(PREVIEW_DIR, "characters-lineup.png"))

    base = results["pedestrian"]
    loops = {n: lp for n, _, lp in CLIPS}
    manifest = {
        "skeleton": C.BONES,
        "materialSlots": C.MAT_SLOTS,
        "fps": C.FPS,
        "clips": [{"name": n, "duration": d, "loop": loops[n]} for n, d in base["anims"]],
        "variants": [{"id": v["slug"], "name": v["name"], "file": f"{v['slug']}.glb",
                      "height": 1.75, "bytes": results[v["slug"]]["bytes"], "triangles": results[v["slug"]]["tris"],
                      "colors": v["colors"]} for v in VARIANTS],
        "events": {"punch": {"hitWindow": [round(5 / C.FPS, 3), round(10 / C.FPS, 3)], "hand": "RightHand"}},
        "poses": {
            "knockdownEndHips": [0, 0.115, -0.25],
            "driveHips": [0, DRIVE_HIP_H, 0],
        },
        "notes": ("原點＝兩腳底中心、地面；面向 glTF +Z、+Y 上；身高 1.75 m。三個變體共用同一副骨架（19 根骨頭、"
                  "關節位置相同）與同一組動作，動作可跨檔共用（依骨頭名稱綁定）。動作皆原地，只有 Hips 有平移。"
                  "knockdown 最後一格＝getup 第一格（仰躺，Hips 關節在 glTF (0, 0.115, -0.25)，頭朝 −Z、腳朝 +Z）。"
                  "drive 與 enter_car 最後一格為坐姿：Hips 關節在原點上方 0.30 m，程式放置時令 角色原點 ＝ 車輛 seat 點 − (0, 0.30, 0)。"
                  "punch 右拳命中窗 hitWindow（秒）。材質槽名稱固定，執行期可依名稱換色（眼睛 / 眉毛共用 hair 材質）。"),
    }
    with open(os.path.join(GLB_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("CHARACTERS_DONE", json.dumps({k: [r["tris"], r["bytes"]] for k, r in results.items()}))


if __name__ == "__main__":
    main()
