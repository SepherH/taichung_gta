"""臺中GTA Phase 10 路人生活動作：11 個新 clip（行人三體型與主角共用）。

- 上半身類（phone_talk / phone_text / phone_film / wave / angry_shout / cheer）只動脊椎 + 雙臂 + 頭，下半身維持綁定姿勢，
  程式以 boneGroups.upper 遮罩疊加在 idle / walk 之上；manifest 的 upperBodyOnly 讀本檔 CLIPS 第 4 欄。
- 全身類（chat_gesture / look_around / sit_idle / jog / cower）腳逐格貼地（GROUND），sit_idle 的臀部高度由貼地校正決定
  （大腿水平、小腿垂直，Hips 關節離地約 0.45 m）。
軸向同 char_lib 檔頭：X 前後彎（手臂負值往前抬）、Y 側擺（右臂正值外展）、Z 水平扭轉（正值往角色左方）。
"""
import copy
import os

import bpy

import char_lib as C

M = C.merge
FPS = C.FPS


def relax_l():
    return {"LeftUpperArm": (3, -6, 0), "LeftLowerArm": (-15, 0, 0)}


def idle0():
    return {"LeftUpperArm": (3, -5, 0), "RightUpperArm": (3, 5, 0), "LeftLowerArm": (-12, 0, 0),
            "RightLowerArm": (-12, 0, 0), "Spine": (1, 0, 0),
            "LeftUpperLeg": (0, -2, 0), "RightUpperLeg": (0, 2, 0), "LeftFoot": (0, 2, 0), "RightFoot": (0, -2, 0)}


def arms0():
    return {"LeftUpperArm": (3, -5, 0), "RightUpperArm": (3, 5, 0), "LeftLowerArm": (-12, 0, 0),
            "RightLowerArm": (-12, 0, 0), "Spine": (1, 0, 0)}


def arms(ua, la, ab=0.0):
    return {"LeftUpperArm": (ua, -ab, 0), "RightUpperArm": (ua, ab, 0),
            "LeftLowerArm": (la, 0, 0), "RightLowerArm": (la, 0, 0)}


# ---------------------------------------------------------------- 手機
def talk0():
    return M(relax_l(), {"Spine": (2, 0, 0), "Chest": (0, 0, 2), "Head": (0, 0, -4),
                         "RightUpperArm": (-36, 20, 0), "RightLowerArm": (-140, 0, 0), "RightHand": (0, 0, 15)})


def phone_talk_keys():
    a = talk0()
    b = M(a, {"Chest": (-1, 0, 5), "Head": (3, 0, -6), "Spine": (2, 0, 1), "RightUpperArm": (-34, 19, 0)})
    c = M(a, {"Head": (-2, 0, -2), "Chest": (0, 0, -1), "LeftUpperArm": (3, -8, 0), "LeftLowerArm": (-22, 0, 0)})
    d = M(a, {"Head": (4, 0, -5), "Chest": (-1, 0, 3)})
    return [(0, a), (12, b), (24, c), (36, d), (48, a)]


def text0():
    return {"Spine": (7, 0, 0), "Chest": (3, 0, 0), "Head": (24, 0, 0),
            "RightUpperArm": (-45, 6, 14), "RightLowerArm": (-70, 0, 0), "RightHand": (-10, 0, 0),
            "LeftUpperArm": (-45, -6, -14), "LeftLowerArm": (-70, 0, 0), "LeftHand": (-10, 0, 0)}


def phone_text_keys():
    a = text0()
    b = M(a, {"Head": (27, 0, 2), "RightHand": (-14, 0, 0), "LeftHand": (-8, 0, 0)})
    c = M(a, {"Head": (22, 0, -2), "RightHand": (-8, 0, 0), "LeftHand": (-13, 0, 0), "Chest": (3, 0, 2)})
    return [(0, a), (12, b), (24, c), (36, a)]


def film0():
    return {"Spine": (-1, 0, 0), "Chest": (-2, 0, 0), "Head": (2, 0, 0),
            "RightUpperArm": (-62, 6, 10), "RightLowerArm": (-52, 0, 0), "RightHand": (-8, 0, 0),
            "LeftUpperArm": (-62, -6, -10), "LeftLowerArm": (-52, 0, 0), "LeftHand": (-8, 0, 0)}


def phone_film_keys():
    a = film0()
    b = M(a, {"Chest": (-2, 0, 4), "Head": (2, 0, -3), "Spine": (-1, 0, 1)})
    c = M(a, {"Chest": (-2, 0, -4), "Head": (2, 0, 3), "RightUpperArm": (-63, 6, 10), "LeftUpperArm": (-63, -6, -10)})
    return [(0, a), (16, b), (32, c), (48, a)]


# ---------------------------------------------------------------- 站立聊天 / 張望
def chat_gesture_keys():
    base = M(idle0(), {"Chest": (0, 0, 0)})
    g0 = M(base, {"Chest": (0, 0, 6), "Head": (3, 0, -8), "Spine": (2, 0, 3),
                  "RightUpperArm": (-35, 22, 0), "RightLowerArm": (-85, 0, 0), "RightHand": (0, 0, 15),
                  "LeftUpperArm": (-8, -8, 0), "LeftLowerArm": (-30, 0, 0),
                  "LeftUpperLeg": (-3, -2, 0), "RightUpperLeg": (2, 2, 0)})
    g1 = M(g0, {"Chest": (0, 0, 2), "Head": (-1, 0, -3), "RightUpperArm": (-48, 18, 0), "RightLowerArm": (-70, 0, 0),
                "RightHand": (0, 0, -10), "LeftUpperArm": (-22, -10, 0), "LeftLowerArm": (-60, 0, 0)})
    g2 = M(base, {"Chest": (0, 0, -6), "Head": (4, 0, 6), "Spine": (2, 0, -3),
                  "LeftUpperArm": (-38, -22, 0), "LeftLowerArm": (-80, 0, 0), "LeftHand": (0, 0, -15),
                  "RightUpperArm": (-12, 8, 0), "RightLowerArm": (-35, 0, 0),
                  "LeftUpperLeg": (2, -2, 0), "RightUpperLeg": (-3, 2, 0)})
    g3 = M(g2, {"Chest": (0, 0, -2), "Head": (0, 0, 2), "LeftUpperArm": (-26, -14, 0), "LeftLowerArm": (-55, 0, 0)})
    return [(0, base), (12, g0), (24, g1), (36, g2), (48, g3), (60, base)]


def look_around_keys():
    base = idle0()
    l1 = M(base, {"Head": (0, 0, 38), "Neck": (0, 0, 8), "Chest": (0, 0, 10), "Spine": (1, 0, 3),
                  "LeftUpperLeg": (-4, -2, 0), "RightUpperLeg": (2, 2, 0)})
    l2 = M(base, {"Head": (2, 0, 36), "Neck": (0, 0, 8), "Chest": (0, 0, 9), "Spine": (1, 0, 3),
                  "LeftUpperLeg": (-4, -2, 0), "RightUpperLeg": (2, 2, 0)})
    r1 = M(base, {"Head": (-2, 0, -40), "Neck": (0, 0, -8), "Chest": (0, 0, -10), "Spine": (1, 0, -3),
                  "LeftUpperLeg": (3, -2, 0), "RightUpperLeg": (-4, 2, 0)})
    r2 = M(base, {"Head": (0, 0, -38), "Neck": (0, 0, -8), "Chest": (0, 0, -9), "Spine": (1, 0, -3),
                  "LeftUpperLeg": (3, -2, 0), "RightUpperLeg": (-4, 2, 0)})
    return [(0, base), (12, l1), (26, l2), (38, base), (50, r1), (66, r2), (78, base)]


# ---------------------------------------------------------------- 坐姿
def sit0():
    legs = M(C.legs_flat(-88, 90, 0, "Left"), C.legs_flat(-88, 90, 0, "Right"))
    return M(legs, {"LeftUpperLeg": (-88, -4, 0), "RightUpperLeg": (-88, 4, 0), "Spine": (4, 0, 0), "Chest": (-1, 0, 0),
                    "Head": (0, 0, 0),
                    "LeftUpperArm": (-18, -6, 0), "LeftLowerArm": (-62, 0, 0), "LeftHand": (0, 0, 0),
                    "RightUpperArm": (-18, 6, 0), "RightLowerArm": (-62, 0, 0)})


def sit_idle_keys():
    a = sit0()
    b = M(a, {"Head": (2, 0, 14), "Chest": (-1, 0, 4), "Spine": (4, 0, 2)})
    c = M(a, {"Head": (3, 0, -3), "RightUpperArm": (-45, 8, 0), "RightLowerArm": (-110, 0, 0), "RightHand": (0, 0, 10)})
    d = M(a, {"Head": (0, 0, -12), "Chest": (-1, 0, -4), "Spine": (4, 0, -2), "LeftUpperArm": (-26, -6, 0)})
    return [(0, a), (20, b), (40, a), (60, c), (80, d), (96, a)]


# ---------------------------------------------------------------- 慢跑（步頻介於 walk 32 與 run 20 之間：24 格）
def jog_keys():
    import build_characters as BC
    k = BC.ks()
    j0 = M({"loc": (0, 0, -0.048 * k), "Hips": (0, 0, -7), "Spine": (6, 0, 0), "Chest": (1, 0, 10), "Head": (-6, 0, -3)},
           {"LeftUpperLeg": (-25, 0, 0), "LeftLowerLeg": (10, 0, 0), "LeftFoot": (1, 0, 0)},
           {"RightUpperLeg": (19, 0, 0), "RightLowerLeg": (48, 0, 0), "RightFoot": (24, 0, 0)},
           {"LeftUpperArm": (26, -5, 0), "LeftLowerArm": (-42, 0, 0),
            "RightUpperArm": (-32, 5, 0), "RightLowerArm": (-62, 0, 0)})
    j1 = M({"loc": (0, 0, 0.0), "Spine": (6, 0, 0), "Chest": (1, 0, 0), "Head": (-6, 0, 0)},
           {"LeftUpperLeg": (4, 0, 0), "LeftLowerLeg": (16, 0, 0), "LeftFoot": (12, 0, 0)},
           {"RightUpperLeg": (-36, 0, 0), "RightLowerLeg": (70, 0, 0), "RightFoot": (8, 0, 0)},
           {"LeftUpperArm": (2, -5, 0), "LeftLowerArm": (-50, 0, 0),
            "RightUpperArm": (-8, 5, 0), "RightLowerArm": (-54, 0, 0)})
    return [(0, j0), (6, j1), (12, C.mirror(j0)), (18, C.mirror(j1)), (24, j0)]


# ---------------------------------------------------------------- 揮手 / 罵 / 歡呼（單次）
def wave_keys():
    up = {"Spine": (1, 0, 0), "Chest": (0, 0, -4), "Head": (0, 0, 6),
          "RightUpperArm": (-12, 78, 0), "RightLowerArm": (0, 80, 0), "RightHand": (0, 0, 0),
          "LeftUpperArm": (3, -5, 0), "LeftLowerArm": (-12, 0, 0)}
    w1 = M(up, {"RightLowerArm": (0, 98, 0), "RightHand": (0, 12, 0), "Head": (0, 0, 8)})
    w2 = M(up, {"RightLowerArm": (0, 62, 0), "RightHand": (0, -12, 0)})
    return [(0, arms0()), (8, up), (12, w1), (16, w2), (20, w1), (24, w2), (28, up), (36, arms0())]


def angry_shout_keys():
    pre = {"Spine": (8, 0, 0), "Chest": (3, 0, 6), "Head": (8, 0, -6),
           "RightUpperArm": (-60, 10, -10), "RightLowerArm": (-110, 0, 0),
           "LeftUpperArm": (-30, -14, 0), "LeftLowerArm": (-100, 0, 0)}
    jab = {"Spine": (14, 0, 0), "Chest": (4, 0, 16), "Head": (10, 0, -14),
           "RightUpperArm": (-90, 6, 6), "RightLowerArm": (-8, 0, 0), "RightHand": (0, 0, 8),
           "LeftUpperArm": (-30, -16, 0), "LeftLowerArm": (-95, 0, 0)}
    back = M(pre, {"Chest": (3, 0, 10), "Spine": (10, 0, 0)})
    return [(0, arms0()), (5, pre), (8, jab), (11, back), (14, jab), (17, back), (20, jab), (26, pre), (32, arms0())]


def cheer_keys():
    up = M(arms(-150, -18, -35), {"Spine": (-4, 0, 0), "Chest": (-6, 0, 0), "Head": (-12, 0, 0)})
    pump = M(arms(-165, -8, -32), {"Spine": (-6, 0, 0), "Chest": (-8, 0, 0), "Head": (-16, 0, 0)})
    return [(0, arms0()), (7, up), (11, pump), (15, up), (19, pump), (23, up), (28, up), (36, arms0())]


# ---------------------------------------------------------------- 蹲低抱頭發抖
def cower0():
    return M(C.legs_flat(-118, 130, -4, "Left"), C.legs_flat(-118, 130, -4, "Right"),
             {"loc": (0, 0, C.crouch_drop(-118, 130)), "Hips": (-4, 0, 0), "Spine": (38, 0, 0), "Chest": (14, 0, 0),
              "Neck": (10, 0, 0), "Head": (14, 0, 0),
              "RightUpperArm": (-132, 36, 18), "RightLowerArm": (-135, 0, 0), "RightHand": (0, 0, 0),
              "LeftUpperArm": (-132, -36, -18), "LeftLowerArm": (-135, 0, 0), "LeftHand": (0, 0, 0)})


def cower_keys():
    a = cower0()
    s1 = M(a, {"Spine": (40, 0, 1.5), "Chest": (15, 0, 1.5), "Head": (15, 0, 2),
               "RightUpperArm": (-133, 36, 19), "LeftUpperArm": (-131, -36, -17)})
    s2 = M(a, {"Spine": (37, 0, -1.5), "Chest": (13, 0, -1.5), "Head": (13, 0, -2),
               "RightUpperArm": (-131, 36, 17), "LeftUpperArm": (-133, -36, -19)})
    return [(0, a), (3, s1), (6, s2), (9, s1), (12, a)]


# ---------------------------------------------------------------- 清單（名稱, 關鍵影格, 是否循環, 只動上半身）
CLIPS = [
    ("phone_talk", phone_talk_keys, True, True),
    ("phone_text", phone_text_keys, True, True),
    ("phone_film", phone_film_keys, True, True),
    ("chat_gesture", chat_gesture_keys, True, False),
    ("look_around", look_around_keys, True, False),
    ("sit_idle", sit_idle_keys, True, False),
    ("jog", jog_keys, True, False),
    ("wave", wave_keys, False, True),
    ("cower", cower_keys, True, False),
    ("angry_shout", angry_shout_keys, False, True),
    ("cheer", cheer_keys, False, True),
]
GROUND = {"chat_gesture": ("all", "lock"), "look_around": ("all", "lock"), "sit_idle": ("all", "lock"),
          "cower": ("all", "lock"), "jog": ([0, 12, 24], "clamp")}
PREVIEW_FRAMES = {"phone_talk": [0, 12], "phone_text": [0, 12], "phone_film": [0, 16], "chat_gesture": [12, 36],
                  "look_around": [12, 50], "sit_idle": [0, 60], "jog": [0, 6, 12], "wave": [8, 12, 16],
                  "cower": [0, 3], "angry_shout": [8, 14], "cheer": [7, 11]}


def add_actions(ch):
    for name, keys, loop, _ in CLIPS:
        # 每格各自一份複本：make_action 的貼地校正會就地改 pose['loc']，首尾格共用同一物件會被扣兩次
        ks = [(f, copy.deepcopy(p)) for f, p in keys()]
        C.make_action(ch, name, ks, loop, ground=GROUND.get(name))


def previews(ch, cam, out_dir, tag, cols=6):
    """每個新 clip 的關鍵格各渲一張（正側 3/4 視角），回傳 png 清單，由呼叫端拼圖。"""
    import build_characters as BC
    arm = ch["arm"]
    cells = []
    for name, _, _, _ in CLIPS:
        arm.animation_data.action = bpy.data.actions[name]
        for f in PREVIEW_FRAMES[name]:
            bpy.context.scene.frame_set(f)
            low = name in ("cower", "sit_idle")
            BC.look(cam, (1.9, -2.9, 1.3 if not low else 1.0), (0, 0, 0.88 if not low else 0.6))
            p = os.path.join(out_dir, f"{tag}-amb-{name}-{f:03d}.png")
            BC.render_to(p, 300, 360)
            cells.append(p)
    arm.animation_data.action = None
    return cells
