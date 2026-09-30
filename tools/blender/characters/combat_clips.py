"""臺中GTA Phase 4 戰鬥 / 武器動作：10 個新 clip（主角與三個行人共用，關鍵影格在呼叫時讀 char_lib 的當前比例）。

- 持武器類（weapon_equip、bat_*、pistol_*）只動脊椎 + 雙臂 + 頭，下半身（Hips 與雙腿）維持綁定姿勢，
  讓程式以 boneGroups.upper 做上半身遮罩疊加在下半身移動動作上；pistol_fire 第 0 格＝pistol_aim，可當加法層。
- hit_front / hit_back 是全身定向受擊（正面被打往後仰、背後被打往前踉蹌），腳底逐格貼地。
- 右手武器插槽 weapon_socket（char_lib.add_weapon_socket）：原點在掌心；glTF 本地 +Z＝拇指方向（握拳時棒身方向，
  綁定姿勢朝角色前方）、+Y＝由指尖指向手腕、+X＝掌心法線。球棒直接掛（socketRotation 單位）；手槍槍管沿手指（本地 −Y）、
  槍的上方＝拇指（本地 +Z），掛上插槽時套 weapons manifest 的 socketRotation（繞 X 轉 +90°）。
軸向說明同 char_lib 檔頭：X 前後彎（下指的手臂 / 手負值往前抬）、Y 側擺、Z 水平扭轉（正值往角色左方）；手臂先 X 後 Z＝抬起後水平轉向。
"""
import os

import bpy
import bmesh

import char_lib as C

M = C.merge
FPS = C.FPS

UPPER = ["Spine", "Chest", "Neck", "Head",
         "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
         "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand", C.SOCKET]
LOWER = ["Hips", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot"]


def arms0():
    return {"LeftUpperArm": (3, -5, 0), "RightUpperArm": (3, 5, 0), "LeftLowerArm": (-12, 0, 0),
            "RightLowerArm": (-12, 0, 0), "Spine": (1, 0, 0)}


LEFT_RELAX = {"LeftUpperArm": (3, -6, 0), "LeftLowerArm": (-15, 0, 0)}


# ---------------------------------------------------------------- 手槍
def pistol_hold0():
    return M(LEFT_RELAX, {"Spine": (2, 0, 0), "Chest": (0, 0, -4), "Head": (0, 0, 4),
                          "RightUpperArm": (-18, 0, 8), "RightLowerArm": (-55, 0, 0)})


def pistol_hold_keys():
    p1 = M(pistol_hold0(), {"Chest": (-1.5, 0, -4), "RightUpperArm": (-20, 0, 8), "Head": (1, 0, 5)})
    return [(0, pistol_hold0()), (30, p1), (60, pistol_hold0())]


def aim0():
    return {"Spine": (3, 0, 0), "Chest": (0, 0, 0), "Head": (6, 0, 0),
            "RightUpperArm": (-84, 0, 20), "RightLowerArm": (-6, 0, 0),
            "LeftUpperArm": (-74, 0, -18), "LeftLowerArm": (-20, 0, 0)}


def pistol_aim_keys():
    a1 = M(aim0(), {"Chest": (-0.8, 0, 1), "Head": (6, 0, 1), "RightUpperArm": (-85, 0, 20)})
    return [(0, aim0()), (30, a1), (60, aim0())]


def pistol_fire_keys():
    kick = M(aim0(), {"Chest": (-3, 0, 0), "Head": (4, 0, 0), "RightUpperArm": (-90, 0, 20),
                      "RightLowerArm": (-18, 0, 0), "RightHand": (-14, 0, 0),
                      "LeftUpperArm": (-79, 0, -18), "LeftLowerArm": (-30, 0, 0), "LeftHand": (-10, 0, 0)})
    return [(0, aim0()), (2, kick), (8, aim0())]


def pistol_reload_keys():
    gun_up = {"RightUpperArm": (-25, 0, 30), "RightLowerArm": (-95, 0, 0), "RightHand": (0, 0, -35),
              "Chest": (0, 0, -3), "Head": (14, 0, -6), "Spine": (3, 0, 0)}
    r8 = M(pistol_hold0(), gun_up)
    r16 = M(r8, {"LeftUpperArm": (8, -12, 0), "LeftLowerArm": (-40, 0, 0), "Head": (12, 0, -8)})
    r26 = M(r8, {"LeftUpperArm": (-30, 0, -35), "LeftLowerArm": (-100, 0, 0)})
    r32 = M(r8, {"LeftUpperArm": (-34, 0, -38), "LeftLowerArm": (-95, 0, 0), "Chest": (1, 0, -3)})
    r38 = M(r8, {"LeftUpperArm": (-45, 0, -40), "LeftLowerArm": (-85, 0, 0),
                 "RightUpperArm": (-30, 0, 28), "RightLowerArm": (-85, 0, 0)})
    return [(0, pistol_hold0()), (8, r8), (16, r16), (26, r26), (32, r32), (38, r38), (45, pistol_hold0())]


# ---------------------------------------------------------------- 球棒（棒身沿拇指方向）
def bat_hold0():
    return M(LEFT_RELAX, {"Spine": (2, 0, 0), "Chest": (0, 0, -5), "Head": (0, 0, 5),
                          "RightUpperArm": (-25, 0, -5), "RightLowerArm": (-115, 0, 0)})


def bat_hold_keys():
    b1 = M(bat_hold0(), {"Chest": (-1.5, 0, -5), "RightLowerArm": (-111, 0, 0), "Head": (1, 0, 6)})
    return [(0, bat_hold0()), (30, b1), (60, bat_hold0())]


def bat_swing_a_keys():
    """水平揮擊：右後方蓄力 → 正前方命中（第 7–12 格）→ 收到左側。"""
    wind = {"Spine": (0, 0, -15), "Chest": (-3, 0, -25), "Head": (0, 0, 30),
            "RightUpperArm": (-70, 0, -100), "RightLowerArm": (-70, 0, 0), "RightHand": (0, 0, 20),
            "LeftUpperArm": (-35, 0, -20), "LeftLowerArm": (-60, 0, 0)}
    hit = {"Spine": (2, 0, 6), "Chest": (0, 0, 16), "Head": (0, 0, -18),
           "RightUpperArm": (-85, 0, -40), "RightLowerArm": (-8, 0, 0), "RightHand": (0, 0, 90),
           "LeftUpperArm": (-20, 0, 0), "LeftLowerArm": (-40, 0, 0)}
    follow = {"Spine": (3, 0, 12), "Chest": (2, 0, 26), "Head": (0, 0, -30),
              "RightUpperArm": (-80, 0, 35), "RightLowerArm": (-30, 0, 0), "RightHand": (0, 0, 90),
              "LeftUpperArm": (-10, -10, 0), "LeftLowerArm": (-30, 0, 0)}
    return [(0, bat_hold0()), (5, wind), (9, hit), (12, M(hit, {"Chest": (0, 0, 22), "RightUpperArm": (-84, 0, -5)})),
            (14, follow), (18, bat_hold0())]


def bat_swing_b_keys():
    """過頭下劈：舉棒到頭後 → 往前下劈命中（第 7–12 格）→ 收棒。"""
    wind = {"Spine": (-6, 0, -5), "Chest": (-8, 0, -5), "Head": (8, 0, 0),
            "RightUpperArm": (-160, 0, -10), "RightLowerArm": (-70, 0, 0),
            "LeftUpperArm": (-40, 0, 0), "LeftLowerArm": (-40, 0, 0)}
    hit = {"Spine": (15, 0, 0), "Chest": (12, 0, 0), "Head": (-8, 0, 0),
           "RightUpperArm": (-50, 0, 10), "RightLowerArm": (-5, 0, 0), "RightHand": (35, 0, 0),
           "LeftUpperArm": (-20, 0, 0), "LeftLowerArm": (-30, 0, 0)}
    follow = {"Spine": (20, 0, 5), "Chest": (8, 0, 5), "Head": (-10, 0, 0),
              "RightUpperArm": (-15, 0, 15), "RightLowerArm": (-10, 0, 0), "RightHand": (40, 0, 0),
              "LeftUpperArm": (0, -10, 0), "LeftLowerArm": (-25, 0, 0)}
    return [(0, bat_hold0()), (5, wind), (9, hit), (12, M(hit, {"RightUpperArm": (-35, 0, 12), "Spine": (18, 0, 2)})),
            (14, follow), (18, bat_hold0())]


# ---------------------------------------------------------------- 切換武器
def weapon_equip_keys():
    reach = M(LEFT_RELAX, {"Spine": (2, 0, 0), "Chest": (0, 0, -8), "Head": (0, 0, 6),
                           "RightShoulder": (0, -3, 0), "RightUpperArm": (18, 12, 0),
                           "RightLowerArm": (-55, 0, 0), "RightHand": (0, 0, 20)})
    ready = M(LEFT_RELAX, {"Spine": (2, 0, 0), "Chest": (0, 0, -3), "RightUpperArm": (-15, 0, 8),
                           "RightLowerArm": (-50, 0, 0)})
    return [(0, arms0()), (6, reach), (10, M(ready, {"RightLowerArm": (-60, 0, 0)})), (15, ready)]


# ---------------------------------------------------------------- 定向受擊（全身）
def idle0():
    return {"LeftUpperArm": (3, -5, 0), "RightUpperArm": (3, 5, 0), "LeftLowerArm": (-12, 0, 0),
            "RightLowerArm": (-12, 0, 0), "Spine": (1, 0, 0),
            "LeftUpperLeg": (0, -2, 0), "RightUpperLeg": (0, 2, 0), "LeftFoot": (0, 2, 0), "RightFoot": (0, -2, 0)}


def arms(ua, la, ab=0.0):
    return {"LeftUpperArm": (ua, -ab, 0), "RightUpperArm": (ua, ab, 0),
            "LeftLowerArm": (la, 0, 0), "RightLowerArm": (la, 0, 0)}


def hit_front_keys():
    """正面受擊：上身往後仰、右腳退半步、雙手往前甩。"""
    snap = M({"Spine": (-14, 0, 3), "Chest": (-12, 0, 4), "Neck": (-8, 0, 0), "Head": (-18, 0, 6),
              "LeftUpperLeg": (-4, -2, 0), "LeftLowerLeg": (8, 0, 0), "LeftFoot": (-4, 2, 0),
              "RightUpperLeg": (14, 2, 0), "RightLowerLeg": (18, 0, 0), "RightFoot": (-26, -2, 0)},
             arms(-30, -30, 20))
    rec = M({"Spine": (4, 0, -2), "Chest": (2, 0, 0), "Head": (4, 0, 0),
             "LeftUpperLeg": (-6, -2, 0), "LeftLowerLeg": (10, 0, 0), "LeftFoot": (-4, 2, 0),
             "RightUpperLeg": (6, 2, 0), "RightLowerLeg": (10, 0, 0), "RightFoot": (-14, -2, 0)},
            arms(0, -25, 12))
    return [(0, idle0()), (3, snap), (8, rec), (15, idle0())]


def hit_back_keys():
    """背後受擊：上身往前撲、左腳往前踉蹌一步、雙手往後甩、頭往後甩。"""
    snap = M({"Spine": (16, 0, -3), "Chest": (12, 0, -4), "Neck": (-4, 0, 0), "Head": (-12, 0, -4),
              "RightUpperLeg": (8, 2, 0), "RightLowerLeg": (10, 0, 0), "RightFoot": (-18, -2, 0)},
             C.legs_flat(-22, 26, 0, "Left"), arms(28, -20, 15))
    rec = M({"Spine": (8, 0, 0), "Chest": (4, 0, 0), "Head": (2, 0, 0),
             "RightUpperLeg": (4, 2, 0), "RightLowerLeg": (6, 0, 0), "RightFoot": (-10, -2, 0)},
            C.legs_flat(-12, 16, 0, "Left"), arms(8, -20, 10))
    return [(0, idle0()), (3, snap), (8, rec), (15, idle0())]


# ---------------------------------------------------------------- 清單（名稱, 關鍵影格, 是否循環, 只動上半身）
CLIPS = [
    ("weapon_equip", weapon_equip_keys, False, True),
    ("bat_hold", bat_hold_keys, True, True),
    ("bat_swing_a", bat_swing_a_keys, False, True),
    ("bat_swing_b", bat_swing_b_keys, False, True),
    ("pistol_hold", pistol_hold_keys, True, True),
    ("pistol_aim", pistol_aim_keys, True, True),
    ("pistol_fire", pistol_fire_keys, False, True),
    ("pistol_reload", pistol_reload_keys, False, True),
    ("hit_front", hit_front_keys, False, False),
    ("hit_back", hit_back_keys, False, False),
]
GROUND = {"hit_front": ("all", "lock"), "hit_back": ("all", "lock")}   # 上半身 clip 腿不動、不需校正
EVENTS = {
    "weapon_equip": {"swapAt": round(6 / FPS, 3)},
    "bat_swing_a": {"hitWindow": [round(7.2 / FPS, 3), round(11.7 / FPS, 3)], "weapon": "bat"},
    "bat_swing_b": {"hitWindow": [round(7.2 / FPS, 3), round(11.7 / FPS, 3)], "weapon": "bat"},
    "pistol_fire": {"shotAt": 0.0, "recoilPeak": round(2 / FPS, 3)},
    "pistol_reload": {"magOut": round(12 / FPS, 3), "magIn": round(30 / FPS, 3), "done": round(40 / FPS, 3)},
}
WEAPON_OF = {"bat_hold": "bat", "bat_swing_a": "bat", "bat_swing_b": "bat", "pistol_hold": "pistol",
             "pistol_aim": "pistol", "pistol_fire": "pistol", "pistol_reload": "pistol"}
HERO_FRAMES = [("weapon_equip", 6), ("weapon_equip", 15), ("bat_hold", 0), ("bat_swing_a", 5), ("bat_swing_a", 9),
               ("bat_swing_a", 14), ("bat_swing_b", 5), ("bat_swing_b", 9), ("bat_swing_b", 14), ("pistol_hold", 0),
               ("pistol_aim", 0), ("pistol_fire", 2), ("pistol_reload", 8), ("pistol_reload", 26),
               ("pistol_reload", 38), ("hit_front", 3), ("hit_front", 8), ("hit_back", 3), ("hit_back", 8)]
PED_FRAMES = [("bat_swing_a", 9), ("pistol_aim", 0), ("hit_back", 3)]


def add_actions(ch):
    for name, keys, loop, _ in CLIPS:
        C.make_action(ch, name, keys(), loop, ground=GROUND.get(name))


# ---------------------------------------------------------------- 預覽（武器以簡化代理幾何掛在插槽，不匯出）
def _proxy(ch, kind):
    arm = ch["arm"]
    bm = bmesh.new()
    if kind == "bat":      # 棒身沿插槽骨本地 +Z（＝glTF +Y，拇指方向）
        bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.016, radius2=0.034, depth=0.85,
                              matrix=__import__("mathutils").Matrix.Translation((0, 0, 0.325)))
        col = "#B08040"
    else:                  # 槍：前端沿骨本地 −Y（＝glTF +Z），上方沿骨本地 +Z
        bmesh.ops.create_cube(bm, size=1.0, matrix=__import__("mathutils").Matrix.Diagonal((0.028, 0.19, 0.032, 1))
                              @ __import__("mathutils").Matrix.Translation((0, -0.26, 1.4)))
        bmesh.ops.create_cube(bm, size=1.0, matrix=__import__("mathutils").Matrix.Diagonal((0.026, 0.035, 0.10, 1)))
        col = "#202226"
    me = bpy.data.meshes.new(f"_proxy_{kind}")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(C.mat(f"_proxy_{kind}", col, 0.6))
    ob = bpy.data.objects.new(f"_proxy_{kind}", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = arm
    ob.parent_type = "BONE"
    ob.parent_bone = C.SOCKET
    ob.location = (0, -arm.data.bones[C.SOCKET].length, 0)   # 骨子物件預設在骨尾；移回骨頭（掌心）
    return ob


def previews(ch, cam, frames, out, cw=192, chh=230, cols=4, rows=3, height=1.75):
    """frames = [(clip, frame)]；每 cols×rows 格拼一張，回傳輸出檔清單（out 內 {n} 代入序號）。"""
    import build_characters as BC
    arm = ch["arm"]
    prox = {k: _proxy(ch, k) for k in ("bat", "pistol")}
    tmp = BC.TMP
    cells = []
    for clip, f in frames:
        for k, ob in prox.items():
            ob.hide_render = WEAPON_OF.get(clip, "pistol" if clip == "weapon_equip" and f >= 10 else None) != k
        arm.animation_data.action = bpy.data.actions[clip]
        bpy.context.scene.frame_set(f)
        k = height / 1.75
        BC.look(cam, (-2.6 * k, -3.0 * k, 1.45 * k), (0, 0, 0.95 * k))
        p = os.path.join(tmp, f"{ch['v']['slug']}-cb-{clip}-{f:02d}.png")
        BC.render_to(p, cw, chh)
        cells.append(p)
    arm.animation_data.action = None
    for ob in prox.values():
        me = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
    outs = []
    per = cols * rows
    for i in range(0, len(cells), per):
        o = out.format(n=i // per + 1)
        BC.sheet(cells[i:i + per], cols, cw, chh, o)
        outs.append(o)
    return outs, cells
