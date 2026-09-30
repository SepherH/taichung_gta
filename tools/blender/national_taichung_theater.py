"""臺中國家歌劇院（OSM way 222636759）。

執行：blender -b -P tools/blender/national_taichung_theater.py
依據：docs/ref/tiger-city-reference.md §3「範圍內地標」、§5 建模摘要表。
OSM 輪廓是約 72 × 122 m 的矩形，長邊沿 a 軸（河南路方向）。
辨識關鍵是「白色曲牆 / 洞孔狀量體」：這裡用 EXACT 布林在四面白牆挖出上下交錯的
橢圓凹洞（下排從地面起拱、上排懸空），洞底填深色玻璃，維持低模。
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_lib as L

WAY_ID = 222636759
SLUG = "national_taichung_theater"
NAME = "臺中國家歌劇院"

# ---- 尺寸參數（公尺） ---------------------------------------------------------
H = 30.0               # 主量體高。§3「高度查無，推測約 30 m」（OSM 地上 6 層）。推測
SLOT = 15.0            # 洞孔欄距：每欄隨機（固定種子）選「單一高洞」或「地面拱 + 上方洞」。§3 曲牆 / 洞孔已確認；排列推測
TALL = dict(z=12.0, rx=6.3, rz=12.5)        # 貫穿 1–4 層的高橢圓洞。推測
ARCH = dict(z=0.0, rx=6.5, rz=9.5)          # 從地面起拱的入口洞。推測
HOLE = dict(z=21.5, rx=5.5, rz=5.5)         # 上方懸空洞。推測
JITTER = 0.18          # 尺寸 / 位置隨機擾動比例，讓洞孔不像規則拱廊。推測
RECESS = 3.5           # 凹洞深度（洞底玻璃退縮）。推測
FLY = dict(b=(-12.0, 12.0), a=(-8.0, 22.0), h=8.0)   # 屋頂深灰方盒 §3「頂部有深灰方盒」。存在已確認，位置 / 尺寸推測
POOL = dict(b=62.0, a=0.0, ra=22.0, rb=9.0)          # 東側橢圓淺藍水景 §3。存在已確認，位置 / 尺寸推測
PLAZA = dict(b=(37.0, 80.0), a=(-55.0, 55.0))        # 東側鋪面廣場 §3。存在已確認，範圍推測

C_WHITE = "#F2F2EE"    # §5
C_GLASS = "#2E3B40"
C_GREEN = "#6E8F4E"
C_DARK = "#4A4D50"
C_POOL = "#8CC3D6"
C_PAVE = "#C9C4B8"


def build():
    ctx = L.begin(SLUG, WAY_ID, NAME)
    fp = ctx.footprint
    m_white = L.mat("theater_white_wall", C_WHITE, roughness=0.5)
    m_glass = L.mat("theater_glass", C_GLASS, metallic=0.3, roughness=0.08,
                    emission="#FFE2B0", strength=0.08)
    m_green = L.mat("theater_roof_garden", C_GREEN, roughness=0.9)
    m_dark = L.mat("theater_roof_box", C_DARK, roughness=0.6)
    m_pool = L.mat("theater_pool_water", C_POOL, metallic=0.1, roughness=0.05)
    m_pave = L.mat("theater_plaza_paving", C_PAVE, roughness=0.9)

    # ---- body：白色量體 + 橢圓洞孔 ----------------------------------------------
    body = L.prism(ctx, "body", "body_white_shell", fp, 0, H, m_white, bottom=True)
    cutters = []
    rng = random.Random(WAY_ID)

    def cut(tag, x, y, nrm, spec):
        j = lambda v: v * (1 + rng.uniform(-JITTER, JITTER))
        cutters.append(L.ellipse_cutter(ctx, f"cut_{tag}_{len(cutters)}", (x, y, spec["z"] if spec["z"] == 0 else j(spec["z"])),
                                        nrm, j(spec["rx"]), j(spec["rz"]), 2.0, RECESS, m_white, m_glass))

    for i in range(len(fp)):
        p0, p1 = fp[i], fp[(i + 1) % len(fp)]
        ln = ((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2) ** 0.5
        n = max(round(ln / SLOT), 2)
        for k in range(n):
            t = 0.1 + 0.8 * (k + 0.5 + rng.uniform(-0.12, 0.12)) / n   # 避開轉角，免得兩面的洞互相切穿
            (x, y), nrm = L.edge_frame(p0, p1, t)
            if rng.random() < 0.45:
                cut("tall", x, y, nrm, TALL)
            else:
                cut("arch", x, y, nrm, ARCH)
                (x2, y2), _ = L.edge_frame(p0, p1, t + rng.uniform(-0.25, 0.25) / n)
                cut("hole", x2, y2, nrm, HOLE)
    L.boolean_cut(body, cutters)

    # ---- roof：屋頂花園 + 深灰方盒 ----------------------------------------------
    L.prism(ctx, "roof", "roof_garden", L.offset(fp, -3.0), H, H + 0.4, m_green)
    f = FLY
    L.box_ab(ctx, "roof", "roof_dark_box", f["b"][0], f["b"][1], f["a"][0], f["a"][1], H, H + f["h"], m_dark)

    # ---- site：東側廣場 + 橢圓水景 ----------------------------------------------
    p = PLAZA
    L.box_ab(ctx, "site", "east_plaza_paving", p["b"][0], p["b"][1], p["a"][0], p["a"][1], 0, 0.05, m_pave)
    px, py = L.ab(POOL["b"], POOL["a"])
    rot = math.atan2(L.A_DIR[1], L.A_DIR[0])   # 橢圓長軸沿 a 軸
    L.prism(ctx, "site", "east_oval_pool", L.circle(px, py, POOL["rb"], 24, rx=POOL["ra"], rot=rot),
            0.05, 0.15, m_pool)

    notes = ("OSM 矩形輪廓擠出 30 m（參考文件 §3 推測高）。白色外牆以布林挖出上下交錯的橢圓洞孔、洞底深色玻璃，"
             "表現伊東豐雄曲牆洞孔意象；洞的數量 / 位置為推測。屋頂花園 + 深灰方盒（位置推測）。"
             "東側廣場與橢圓水景超出建物輪廓，位置 / 尺寸推測。")
    return L.finish(ctx, H + FLY["h"], "estimated", notes, L.B_DIR)


if __name__ == "__main__":
    build()
