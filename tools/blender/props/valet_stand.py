"""代客泊車亭一組（小亭 + 立牌；字樣「星河代客泊車 / VALET PARKING」為虛構），給代客泊車打工的接單點。

執行：blender -b -P tools/blender/props/valet_stand.py
產出：public/models/props/valet_stand.glb、manifest.json（以 id 合併，不動既有條目）、
      assets/blender/props/valet_stand.blend（+ 招牌貼圖 valet_stand_sign.jpg）、docs/models/previews/valet_stand-front34.png
外觀（推測尺寸，一般停車場收費亭）：亭 1.3 × 1.1 m、牆高 2.25、前窗 1.0–2.0、窗外接單檯面高 1.05、屋頂招牌頂約 2.9；
立牌在亭的右側（顧客面看過去的右手邊）。顧客面（窗、檯面、招牌、立牌）朝 glTF +Z。
節點：valet_stand（根）底下 body（亭 + 立牌，多材質單一網格）+ sign（屋頂招牌與立牌兩面，共用一張貼圖）。
材質：bulb 帶 emission（窗上燈）；sign 帶微弱 emission；paint＝深藍（屋頂、腰帶、門、招牌框）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prop_lib as PL  # noqa: E402

SLUG = "valet_stand"
W, DP, WALL_H = 1.30, 1.10, 2.25
SX, SY = W / 2 + 0.60, -DP / 2 + 0.05     # 立牌位置（Blender，顧客面在 −Y）
COUNTER = (0.0, 1.05, DP / 2 + 0.26 + 0.30)   # glTF：窗外檯面前緣再往前 0.3 m（顧客站位）


def build():
    v = PL.Prop(SLUG, "代客泊車亭", "#1D3557", extra_mats={
        "white": dict(color="#EEEDE8", roughness=0.6),
        "steel": dict(color="#C9CDD1", roughness=0.3, metallic=0.85),
        "key": dict(color="#E8B931", roughness=0.4),
        "bulb": dict(color="#FFF1CC", roughness=0.2, emission="#FFE2A0", strength=3.0),
    })
    zc = lambda z0, z1: (z0 + z1) / 2
    # ---- 亭身：底座、後牆、兩側牆、前牆下半、窗、窗上橫楣
    v.add(v.box((0, 0, 0.05), (W + 0.06, DP + 0.06, 0.10), "trim"))
    v.add(v.box((0, DP / 2 - 0.03, zc(0.10, WALL_H)), (W, 0.06, WALL_H - 0.10), "white"))
    for s in (-1, 1):
        v.add(v.box((s * (W / 2 - 0.03), 0, zc(0.10, WALL_H)), (0.06, DP - 0.12, WALL_H - 0.10), "white"))
    v.add(v.box((0, -DP / 2 + 0.03, zc(0.10, 1.00)), (W, 0.06, 0.90), "white"))
    v.add(v.box((0, -DP / 2 - 0.002, 0.80), (W - 0.04, 0.01, 0.12), "paint"))
    v.add(v.box((0, -DP / 2 + 0.03, 1.50), (W - 0.12, 0.03, 1.00), "glass"))
    v.add(v.box((0, -DP / 2 + 0.03, zc(2.00, WALL_H)), (W, 0.06, WALL_H - 2.00), "paint"))
    # 側窗（左牆）與右側門
    v.add(v.box((-W / 2 - 0.002, 0, 1.55), (0.01, 0.60, 0.70), "glass"))
    v.add(v.box((W / 2 + 0.004, 0.08, 1.02), (0.01, 0.70, 1.84), "paint"))
    v.add(v.box((W / 2 + 0.02, -0.20, 1.05), (0.03, 0.10, 0.03), "steel"))
    # 窗外接單檯面 + 兩支托架
    v.add(v.box((0, -DP / 2 - 0.13, 1.03), (W - 0.10, 0.26, 0.04), "steel"), bevel=0.01)
    for x in (-0.45, 0.45):
        v.add(v.box((x, -DP / 2 - 0.08, 0.92), (0.03, 0.16, 0.18), "steel"))
    # 室內鑰匙櫃（隔窗可見）
    v.add(v.box((0.25, DP / 2 - 0.08, 1.55), (0.50, 0.04, 0.55), "steel"))
    for i in range(4):
        for j in range(2):
            v.add(v.box((0.07 + i * 0.12, DP / 2 - 0.105, 1.68 - j * 0.24), (0.04, 0.01, 0.07), "key"))
    # ---- 屋頂（外伸）+ 窗上燈 + 屋頂招牌板
    v.add(v.box((0, 0, WALL_H + 0.04), (W + 0.36, DP + 0.36, 0.08), "paint"), bevel=0.01)
    v.add(v.cyl((0, -DP / 2 - 0.12, WALL_H), (0, -DP / 2 - 0.12, WALL_H - 0.04), 0.08, "bulb", seg=12))
    v.add(v.box((0, -DP / 2 + 0.05, WALL_H + 0.08 + 0.27), (1.36, 0.06, 0.54), "paint"))
    for x in (-0.5, 0.5):
        v.add(v.box((x, -DP / 2 + 0.12, WALL_H + 0.30), (0.04, 0.08, 0.44), "steel"))
    # ---- 立牌：底座、立柱、牌板（字面朝顧客）
    v.add(v.box((SX, SY, 0.02), (0.50, 0.36, 0.04), "trim"))
    v.add(v.cyl((SX, SY + 0.04, 0.04), (SX, SY + 0.04, 1.40), 0.025, "steel", seg=8))
    v.add(v.box((SX, SY, 1.20), (0.88, 0.03, 0.36), "paint"))

    sign_y = -DP / 2 + 0.05 - 0.032
    sign = v.sign_quads(os.path.join(PL.BLEND_DIR, f"{SLUG}_sign.jpg"), [
        (0.0, sign_y, WALL_H + 0.11, 1.30, 0.48),          # 屋頂招牌
        (SX, SY - 0.017, 1.045, 0.84, 0.31),                # 立牌
    ])
    notes = ("一般停車場收費亭外觀（推測尺寸）：亭 1.3 × 1.1 m、牆高 2.25、窗外檯面高 1.05、屋頂招牌頂約 2.9；"
             "立牌在顧客面右手邊（glTF +X 側）。顧客面朝 glTF +Z；counter＝接單點（檯面前方顧客站位，glTF 座標）。"
             "招牌與立牌共用一張本機生圖貼圖（虛構字樣「星河代客泊車 / VALET PARKING」，無真實商標）；bulb 材質帶 emission。")
    views = {"front34": ((3.4, -6.2, 2.5), (0.3, 0, 1.4), 35)}
    return PL.finish(v, sign, "代客泊車亭 + 立牌（星河代客泊車，虛構字樣）", notes, COUNTER, views)


if __name__ == "__main__":
    build()
