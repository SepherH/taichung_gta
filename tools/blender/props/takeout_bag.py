"""外帶餐點提袋小道具（白色紙袋 + 紙提把 + 紅色圓標；字樣「夜市好味 / 外帶」為虛構）。跑單時手持 / 放攤上。

執行：blender -b -P tools/blender/props/takeout_bag.py
產出：public/models/props/takeout_bag.glb、manifest.json（以 id 合併，不動既有條目）、
      assets/blender/props/takeout_bag.blend（+ 貼圖 takeout_bag_sign.jpg）、docs/models/previews/takeout_bag-front34.png
尺寸（推測，一般外帶紙袋）：袋身 0.24 × 0.14 × 0.30 m、提把頂約 0.40。印面朝 glTF +Z。
節點：takeout_bag（根）底下 body（袋身 + 提把 + 袋內餐盒）+ sign（前面印刷圓標）。
counter：手持握點（提把頂端，glTF 座標）；角色手持時把此點對到手掌即可。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prop_lib as PL  # noqa: E402

SLUG = "takeout_bag"
BW, BD, BH = 0.24, 0.14, 0.30
GRIP = 0.40


def build():
    v = PL.Prop(SLUG, "外帶提袋", "#C8322B", extra_mats={
        "white": dict(color="#F7F8FA", roughness=0.5),   # 與印面貼圖底色、粗糙度一致，免出現方框
        "inner": dict(color="#8E8A80", roughness=0.9),
        "kraft": dict(color="#B98A55", roughness=0.9),
        "box": dict(color="#E9E2D0", roughness=0.7),
    })
    v.add(v.box((0, 0, BH / 2), (BW, BD, BH), "white"))
    v.add(v.box((0, 0, BH + 0.0005), (BW - 0.012, BD - 0.012, 0.001), "inner"))   # 袋口內側（開口感）
    v.add(v.box((0, 0.01, BH + 0.02), (0.16, 0.10, 0.05), "box"))                   # 露出袋口的餐盒
    # 兩條紙提把（前後各一，半圓弧 6 段）
    for y in (-BD / 2 + 0.01, BD / 2 - 0.01):
        pts = [(0.06 * math.cos(math.pi * i / 6), y, BH - 0.03 + (GRIP - BH + 0.03) * math.sin(math.pi * i / 6))
               for i in range(7)]
        for a, b in zip(pts, pts[1:]):
            v.add(v.cyl(a, b, 0.005, "kraft", seg=5))
    sign = v.sign_quads(os.path.join(PL.BLEND_DIR, f"{SLUG}_sign.jpg"),
                        [(0.0, -BD / 2 - 0.002, 0.0, BW, BH)], strength=0.0)   # 印面蓋滿袋身前面，免出現貼圖方框
    notes = ("一般外帶紙袋外觀（推測尺寸）：袋身 0.24 × 0.14 × 0.30 m、提把頂約 0.40。印面朝 glTF +Z。"
             "counter 在此為手持握點（提把頂端，glTF 座標），非取餐點。印面為本機生圖貼圖（虛構字樣「夜市好味 / 外帶」，無真實商標）；"
             "sign 材質 emission 強度 0（不發光，名稱仍為 sign 以符合載入器節點契約）。")
    views = {"front34": ((0.55, -0.95, 0.42), (0, 0, 0.19), 35)}
    return PL.finish(v, sign, "外帶餐點提袋（夜市好味，虛構字樣）", notes, (0.0, GRIP, 0.0), views)


if __name__ == "__main__":
    build()
