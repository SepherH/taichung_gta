"""夜市攤車變體 2 款（店名皆虛構）：蚵仔煎攤（大海蚵仔煎，藍白棚）、珍奶飲料攤（青葉珍奶，綠黃棚）。

執行：blender -b -P tools/blender/props/night_market_stall_variants.py [-- oyster|tea]（不帶參數＝兩款都建）
產出：public/models/props/night_market_stall_{oyster,tea}.glb、manifest.json（以 id 合併，不動既有條目）、
      assets/blender/props/night_market_stall_{oyster,tea}.blend（+ 招牌貼圖 *_sign.jpg）、
      docs/models/previews/night_market_stall_{oyster,tea}-front34.png
車架、棚頂、招牌板、吊燈與尺寸完全比照 night_market_stall.py（外接盒同為約 2.10 × 1.56 × 3.04 m，擺位與碰撞可共用），
只換檯面上的品項與配色。座標 / 節點 / 材質契約同 prop_lib.py。
"""
import os
import sys

import bmesh
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prop_lib as PL  # noqa: E402

CART = (1.80, 0.90, 0.88)
ROOF_Z = 2.30
SIGN = (1.90, 0.66, 2.36)
COUNTER = (0.0, 0.95, 0.62)
VIEWS = {"front34": ((3.6, -6.0, 2.6), (0, 0, 1.5), 35)}


def frame(v):
    """共用車架（同 night_market_stall.py）：箱體、檯面、腰帶、腳輪、立柱、條紋棚、垂邊、招牌底板、吊燈。"""
    L, D, H = CART
    v.add(v.box((0, 0, (0.18 + H) / 2), (L, D, H - 0.18), "steel"), bevel=0.02)
    v.add(v.box((0, 0, H + 0.02), (L + 0.08, D + 0.08, 0.04), "steel"), bevel=0.01)
    v.add(v.box((0, -D / 2 - 0.006, 0.55), (L - 0.1, 0.012, 0.16), "paint"))
    for x in (-L / 2 + 0.12, L / 2 - 0.12):
        for y in (-D / 2 + 0.12, D / 2 - 0.12):
            v.add(v.cyl((x - 0.03, y, 0.08), (x + 0.03, y, 0.08), 0.08, "trim", seg=10))
            v.add(v.box((x, y, 0.15), (0.05, 0.05, 0.06), "trim"))
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
        v.add(v.box((x, -(D + 0.50) / 2 + 0.01, ROOF_Z - 0.06), (w, 0.02, 0.16), "paint" if i % 2 == 0 else "white"))
    v.add(v.box((0, -D / 2 - 0.10, SIGN[2] + 0.33), (SIGN[0], 0.04, SIGN[1] + 0.04), "steel"))
    v.add(v.box((0, -D / 2 - 0.12, SIGN[2] + 0.33), (SIGN[0] - 0.06, 0.02, SIGN[1] - 0.02), "paint"))
    for x in (-0.55, 0.55):
        v.add(v.cyl((x, -0.15, ROOF_Z), (x, -0.15, ROOF_Z - 0.35), 0.006, "trim", seg=4))
        v.add(v.cyl((x, -0.15, ROOF_Z - 0.35), (x, -0.15, ROOF_Z - 0.47), 0.05, "bulb", seg=10, r1=0.035))
    # 瓦斯桶（車後）
    v.add(v.cyl((0.55, D / 2 + 0.25, 0.0), (0.55, D / 2 + 0.25, 0.62), 0.16, "tank", seg=12))


def oyster(v):
    """蚵仔煎：大鐵板（前半）+ 四份煎餅淋醬、右後蚵仔盆與蛋籃、左後盤子堆。"""
    H = CART[2]
    v.add(v.box((-0.20, -0.08, H + 0.07), (1.20, 0.62, 0.05), "iron"))
    v.add(v.box((-0.20, -0.08, H + 0.025), (1.10, 0.52, 0.05), "steel"))
    for x in (-0.80, 0.40):   # 鐵板擋邊
        v.add(v.box((x, -0.08, H + 0.12), (0.02, 0.62, 0.06), "steel"))
    v.add(v.box((-0.20, 0.235, H + 0.12), (1.20, 0.02, 0.06), "steel"))
    for x, y in ((-0.55, -0.22), (-0.20, -0.22), (0.15, -0.22), (-0.38, 0.06)):
        v.add(v.cyl((x, y, H + 0.095), (x, y, H + 0.115), 0.12, "food", seg=12))
        v.add(v.cyl((x, y, H + 0.115), (x, y, H + 0.122), 0.075, "sauce", seg=10))
    v.add(v.cyl((0.65, -0.18, H + 0.04), (0.65, -0.18, H + 0.16), 0.15, "white", seg=12, r1=0.18))
    v.add(v.cyl((0.65, -0.18, H + 0.14), (0.65, -0.18, H + 0.15), 0.16, "oyster", seg=12))
    v.add(v.box((0.62, 0.20, H + 0.08), (0.30, 0.22, 0.08), "basket"))
    for i in range(3):
        for j in range(2):
            v.add(v.cyl((0.53 + i * 0.09, 0.15 + j * 0.10, H + 0.12), (0.53 + i * 0.09, 0.15 + j * 0.10, H + 0.17),
                        0.03, "egg", seg=6, r1=0.022))
    v.add(v.cyl((-0.65, 0.30, H + 0.04), (-0.65, 0.30, H + 0.16), 0.13, "white", seg=12))


def tea(v):
    """珍奶飲料攤：後排三桶茶桶（附龍頭）、右側封口機、前排一列杯（奶茶色 + 白蓋 + 吸管）、左側冰桶。"""
    H = CART[2]
    for x in (-0.45, -0.10, 0.25):
        v.add(v.cyl((x, 0.22, H + 0.04), (x, 0.22, H + 0.50), 0.14, "steel", seg=12))
        v.add(v.cyl((x, 0.22, H + 0.50), (x, 0.22, H + 0.53), 0.145, "trim", seg=12))
        v.add(v.cyl((x, 0.07, H + 0.12), (x, 0.03, H + 0.12), 0.015, "trim", seg=6))
    v.add(v.box((0.62, 0.12, H + 0.22), (0.30, 0.34, 0.40), "white"), bevel=0.02)
    v.add(v.box((0.62, -0.06, H + 0.32), (0.22, 0.02, 0.10), "trim"))
    for i in range(7):
        x = -0.72 + i * 0.17
        v.add(v.cyl((x, -0.25, H + 0.04), (x, -0.25, H + 0.20), 0.038, "tea", seg=10, r1=0.046))
        v.add(v.cyl((x, -0.25, H + 0.20), (x, -0.25, H + 0.215), 0.05, "white", seg=10))
        v.add(v.cyl((x + 0.01, -0.25, H + 0.215), (x + 0.02, -0.25, H + 0.31), 0.007, "paint", seg=4))
    v.add(v.box((-0.68, 0.18, H + 0.16), (0.36, 0.34, 0.28), "cooler"), bevel=0.02)


VARIANTS = {
    "oyster": dict(
        slug="night_market_stall_oyster", label="夜市攤車・蚵仔煎", paint="#1F4E8C", build=oyster,
        name="夜市攤車（大海蚵仔煎，虛構店名）",
        mats={"iron": dict(color="#2B2B2D", roughness=0.45, metallic=0.6),
              "food": dict(color="#D8B46A", roughness=0.8),
              "sauce": dict(color="#C2452F", roughness=0.4),
              "oyster": dict(color="#A9A396", roughness=0.35),
              "basket": dict(color="#8C6A3E", roughness=0.9),
              "egg": dict(color="#E9DCC3", roughness=0.6)},
        notes="同 night_market_stall 車架與尺寸（攤車 1.8 × 0.9 m、檯面 0.88、棚頂約 2.3、招牌頂約 3.0）；品項為蚵仔煎鐵板、藍白棚。"),
    "tea": dict(
        slug="night_market_stall_tea", label="夜市攤車・珍奶", paint="#2E8B57", build=tea,
        name="夜市攤車（青葉珍奶，虛構店名）",
        mats={"tea": dict(color="#C59B6D", roughness=0.3),
              "cooler": dict(color="#2E6FB0", roughness=0.5)},
        notes="同 night_market_stall 車架與尺寸（攤車 1.8 × 0.9 m、檯面 0.88、棚頂約 2.3、招牌頂約 3.0）；品項為珍奶飲料（茶桶、封口機、杯列），綠白棚。"),
}
BASE_NOTE = ("顧客面（招牌、檯面）朝 glTF +Z；counter＝取餐點（檯面前緣上方，glTF 座標，與 night_market_stall 相同）。"
             "招牌為本機生圖貼圖（虛構店名，無真實商標）；bulb 材質帶 emission。")


def build(key):
    c = VARIANTS[key]
    mats = {
        "steel": dict(color="#C9CDD1", roughness=0.3, metallic=0.85),
        "bulb": dict(color="#FFE9B0", roughness=0.2, emission="#FFD27A", strength=3.0),
        "white": dict(color="#F1F0EA", roughness=0.6),
        "tank": dict(color="#B23A2E", roughness=0.5),
    }
    mats.update(c["mats"])
    v = PL.Prop(c["slug"], c["label"], c["paint"], extra_mats=mats)
    frame(v)
    c["build"](v)
    D = CART[1]
    sign = v.sign_quads(os.path.join(PL.BLEND_DIR, f"{c['slug']}_sign.jpg"),
                        [(0.0, -D / 2 - 0.137, SIGN[2] + 0.02, 1.76, 0.62)])
    return PL.finish(v, sign, c["name"], c["notes"] + BASE_NOTE, COUNTER, VIEWS)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for k in (argv or list(VARIANTS)):
        build(k)
