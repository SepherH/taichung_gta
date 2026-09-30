"""臺中GTA 程序特效貼圖與 HUD 武器圖示（主機 python3 + numpy + Pillow，固定亂數種子，重跑結果完全相同）。

執行：python3 -I tools/art/build_fx_icons.py
產出：public/art/fx/blood-atlas.png（1024x1024，4x4 地面血跡污漬貼片）、public/art/fx/blood-drop.png（64x64 血滴粒子）、
      public/art/hud/weapon-{fist,bat,pistol}.png（128x128 白色線條圖示 + 35% 黑色外暈）
      有設 FX_PREVIEW_DIR 才另存 <FX_PREVIEW_DIR>/fx-preview.png。
PNG 以 Pillow 預設存檔，不帶任何文字 metadata。
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
FX_DIR = os.path.join(REPO, "public", "art", "fx")
HUD_DIR = os.path.join(REPO, "public", "art", "hud")
SEED = 20260930

CELL = 256
GRID = 4
EDGE = 12                   # 每格透明邊界下限
FIT = EDGE + 4              # 生成時實際要求的邊界（留柔化餘裕）
C_DARK = np.array([0x3A, 0x05, 0x05], dtype=np.float32) / 255
C_LIGHT = np.array([0x7A, 0x0E, 0x0E], dtype=np.float32) / 255


def save(img, rel):
    path = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print(f"FX {rel} {img.width}x{img.height} bytes={os.path.getsize(path)}")


def to_img(rgba):
    return Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")


# ---------------------------------------------------------------- 雜訊 / 形狀場
def value_noise(rng, n, cells):
    """n×n 平滑值雜訊（-1..1），cells = 低頻格數。"""
    g = rng.uniform(-1, 1, (cells + 2, cells + 2))
    t = np.arange(n) / n * cells
    i = np.floor(t).astype(int)
    f = t - i
    f = f * f * (3 - 2 * f)
    fy, fx = f[:, None], f[None, :]
    a, b = g[i][:, i], g[i][:, i + 1]
    c, d = g[i + 1][:, i], g[i + 1][:, i + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(rng, n, cells, octaves=3):
    out, amp, tot = np.zeros((n, n)), 1.0, 0.0
    for k in range(octaves):
        out += amp * value_noise(rng, n, cells * 2 ** k)
        tot += amp
        amp *= 0.5
    return out / tot


def ball(X, Y, cx, cy, r, sx=1.0, sy=1.0, ang=0.0):
    """橢圓高斯 metaball，r = 半徑尺度（場值 0.5 等值線約在 r）。"""
    ca, sa = math.cos(ang), math.sin(ang)
    dx, dy = X - cx, Y - cy
    u = (dx * ca + dy * sa) / sx
    v = (-dx * sa + dy * ca) / sy
    return np.exp(-(u * u + v * v) / (2 * (r / 1.1774) ** 2))


# 每格一組 metaball：(cx, cy, r, sx, sy, ang)，座標以格中心為 0、單位 px；kind 決定後處理
def spec_round(rng):
    return [(0, 0, 70, 1, 1, 0)] + [(rng.uniform(-30, 30), rng.uniform(-30, 30), rng.uniform(30, 45), 1, 1, 0) for _ in range(3)]


def spec_pool(rng):
    out = [(0, 0, 55, 1, 1, 0)]
    for _ in range(7):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(25, 60)
        out.append((d * math.cos(a), d * math.sin(a), rng.uniform(22, 42), 1, 1, 0))
    return out


def spec_drag(rng, ang):
    out = []
    ca, sa = math.cos(ang), math.sin(ang)
    for k in range(12):
        t = -85 + k * 15
        r = 38 - k * 2.4 + rng.uniform(-3, 3)
        off = rng.uniform(-4, 4)
        out.append((t * ca - off * sa, t * sa + off * ca, max(r, 8), 1.6, 0.8, ang))
    return out


def spec_drops(rng, n, rmin, rmax, spread):
    return [(rng.uniform(-spread, spread), rng.uniform(-spread, spread), rng.uniform(rmin, rmax), 1, 1, 0) for _ in range(n)]


def spec_splatter(rng, core, rays):
    out = [(0, 0, core, 1, 1, 0), (rng.uniform(-10, 10), rng.uniform(-10, 10), core * 0.7, 1, 1, 0)]
    for k in range(rays):
        a = 2 * math.pi * k / rays + rng.uniform(-0.2, 0.2)
        for d, r in ((core * 1.3, rng.uniform(8, 13)), (core * 1.7 + rng.uniform(0, 20), rng.uniform(5, 9)),
                     (core * 2.1 + rng.uniform(0, 25), rng.uniform(3, 6))):
            if d < 108:
                out.append((d * math.cos(a), d * math.sin(a), r, 1.4, 0.8, a))
    return out


def spec_trail(rng):
    out, x, y = [], -85.0, rng.uniform(-30, 30)
    a = rng.uniform(-0.3, 0.3)
    while x < 85:
        out.append((x, y, rng.uniform(7, 14), 1.2, 1, a))
        x += rng.uniform(14, 24)
        y += rng.uniform(-8, 8)
    return out


def spec_fingers(rng):
    out = spec_drag(rng, 0.0)[:8]
    for k in range(4):
        a = rng.uniform(-0.5, 0.5)
        for j in range(4):
            d = 30 + j * 14
            out.append((20 + d * math.cos(a), (k - 1.5) * 16 + d * math.sin(a), 11 - j * 2, 1.5, 0.8, a))
    return out


KINDS = [
    ("pool", lambda r: spec_round(r)),                              # 圓形積血
    ("pool", lambda r: spec_pool(r)),                               # 不規則大灘
    ("pool", lambda r: spec_drag(r, 0.0)),                          # 拖曳痕（水平）
    ("pool", lambda r: spec_drops(r, 9, 8, 18, 75)),                # 小滴群
    ("pool", lambda r: spec_splatter(r, 40, 11)),                   # 濺射
    ("ring", lambda r: spec_round(r)),                              # 半乾環形
    ("pool", lambda r: spec_drag(r, math.radians(45))),             # 拖曳痕（斜）
    ("pool", lambda r: spec_pool(r) + spec_drops(r, 6, 6, 11, 95)),  # 大灘 + 衛星滴
    ("pool", lambda r: [(0, 0, 60, 1.5, 0.7, r.uniform(0, 3.14))] + spec_drops(r, 3, 20, 30, 35)),  # 長條抹痕
    ("ring", lambda r: spec_pool(r)),                               # 半乾不規則灘
    ("pool", lambda r: spec_trail(r)),                              # 滴落軌跡
    ("pool", lambda r: spec_splatter(r, 30, 16)),                   # 細密濺射
    ("pool", lambda r: [(-35, -20, 48, 1, 1, 0), (38, 25, 42, 1, 1, 0), (0, 0, 28, 1, 1, 0)]),  # 雙灘相連
    ("pool", lambda r: spec_drops(r, 16, 4, 9, 90)),                # 細小散滴
    ("pool", lambda r: spec_fingers(r)),                            # 拖曳 + 指狀末端
    ("ring", lambda r: spec_drops(r, 4, 26, 40, 40)),               # 半乾多圈
]


def stain(rng, kind, spec, scale):
    n = CELL
    c = np.arange(n, dtype=np.float64) - (n - 1) / 2
    X, Y = np.meshgrid(c, c)
    f = np.zeros((n, n))
    for cx, cy, r, sx, sy, ang in spec:
        f += ball(X, Y, cx * scale, cy * scale, r * scale, sx, sy, ang)
    f += 0.18 * fbm(rng, n, 4)                    # 低頻擾動邊界
    body = f > 0.5
    hard = Image.fromarray((body * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.9))
    edge = np.asarray(hard, dtype=np.float64) / 255     # 邊緣 1–2 px 柔化
    depth = np.clip((f - 0.5) / max(float(f.max()) - 0.5, 1e-6), 0, 1)
    depth = np.sqrt(depth)                         # 0 邊緣 → 1 中心
    mottle = fbm(rng, n, 16, 2)
    tone = np.clip(1 - depth + 0.25 * mottle, 0, 1)   # 中心深、邊緣淺 + 斑駁
    rgb = C_DARK + (C_LIGHT - C_DARK) * tone[:, :, None]
    a_body = 0.90 + 0.05 * mottle
    if kind == "ring":                             # 乾涸：邊緣一圈 alpha 較高、內部較淡
        rim = np.exp(-((depth / 0.18) ** 2))
        a_body = 0.55 + 0.40 * rim + 0.05 * mottle
        rgb = C_DARK + (C_LIGHT - C_DARK) * np.clip(tone * (1 - 0.6 * rim), 0, 1)[:, :, None]
    alpha = np.clip(a_body, 0, 0.95) * edge
    return np.concatenate([np.clip(rgb, C_DARK, C_LIGHT), alpha[:, :, None]], axis=2)


def fits(rgba):
    ys, xs = np.nonzero(rgba[:, :, 3] > 0)
    if len(ys) == 0:
        return True
    return ys.min() >= FIT and xs.min() >= FIT and ys.max() < CELL - FIT and xs.max() < CELL - FIT


def blood_atlas(rng):
    atlas = np.zeros((CELL * GRID, CELL * GRID, 4), dtype=np.float64)
    atlas[:, :, :3] = C_LIGHT                      # 透明處 RGB 給邊緣色，避免 mipmap 黑邊
    for i, (kind, gen) in enumerate(KINDS):
        spec = gen(rng)
        state = rng.bit_generator.state
        scale = 1.0
        while True:
            rng.bit_generator.state = state        # 每次縮放重試用同一段亂數，結果可重現
            tile = stain(rng, kind, spec, scale)
            if fits(tile) or scale < 0.3:
                break
            scale *= 0.92
        tile[:EDGE, :, 3] = tile[-EDGE:, :, 3] = 0
        tile[:, :EDGE, 3] = tile[:, -EDGE:, 3] = 0
        r, c = divmod(i, GRID)
        atlas[r * CELL:(r + 1) * CELL, c * CELL:(c + 1) * CELL] = tile
    return to_img(atlas)


def blood_drop():
    n, k = 256, 4                                  # 4 倍超取樣再縮到 64
    c = (np.arange(n) + 0.5) / k
    X, Y = np.meshgrid(c, c)
    f = ball(X, Y, 32, 37, 17) + 0.55 * ball(X, Y, 32, 25, 9) + 0.35 * ball(X, Y, 32, 17, 4.5)
    body = f > 0.5
    edge = np.asarray(Image.fromarray((body * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.5 * k)),
                      dtype=np.float64) / 255
    base = np.array([0x7A, 0x0E, 0x0E], dtype=np.float64) / 255
    hi = np.array([0xC0, 0x40, 0x40], dtype=np.float64) / 255
    h = np.exp(-(((X - 26) ** 2 + (Y - 31) ** 2) / (2 * 2.6 ** 2)))[:, :, None]
    rgb = base * (1 - h) + hi * h
    rgba = np.concatenate([rgb, edge[:, :, None]], axis=2)
    return to_img(rgba).resize((64, 64), Image.LANCZOS)


# ---------------------------------------------------------------- HUD 武器圖示（抽象座標的折線 → 512 畫布 → 128）
BIG, OUT = 512, 128
LINE_W = 7 * BIG // OUT                            # 28 px @512 = 7 px @128
PAD = 12 * BIG // OUT                              # 四周留 12 px @128
GLOW = 6                                           # 外暈擴張（@512，約 1.5 px @128）


def arc(cx, cy, rx, ry, a0, a1, n=24):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * t / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * t / n))) for t in range(n + 1)]


def icon_fist():
    lines = []
    knuck = []
    for k in range(4):
        knuck += arc(20 + 16 * k, 30, 8, 8, 180, 360)
    lines.append(knuck)
    for x in (28, 44, 60):
        lines.append([(x, 30), (x, 50)])
    lines.append([(12, 30), (12, 64)] + arc(26, 64, 14, 22, 180, 120, 8))
    lines.append([(76, 30), (78, 60)] + arc(64, 60, 14, 26, 0, 60, 8))
    lines.append([(12, 54), (56, 52)] + arc(56, 58, 6, 6, -90, 90, 12) + [(56, 64), (18, 66)])
    return lines


def icon_bat():
    ax, ay = 1 / math.sqrt(2), -1 / math.sqrt(2)   # 握把左下 → 棒頭右上
    nx, ny = -ay, ax

    def rad(t):
        if t < 42:
            return 4.5
        return 4.5 + (10.5 - 4.5) * min((t - 42) / 43, 1) ** 1.3

    def pt(t, s):
        return (t * ax + s * nx, t * ay + s * ny)

    ts = [6 + k * 2 for k in range(48)]            # 6..100
    side_a = [pt(t, rad(t)) for t in ts]
    side_b = [pt(t, -rad(t)) for t in ts]
    head = [pt(100 + 10.5 * math.sin(math.radians(a)), 10.5 * math.cos(math.radians(a))) for a in range(0, 181, 10)]
    knob = arc(0, 0, 8, 8, 0, 360, 32)
    return [side_a + head + side_b[::-1], knob]


def icon_pistol():
    slide = ([(12, 18), (88, 18)] + arc(88, 22, 4, 4, -90, 0, 6) + [(92, 36)] + arc(88, 36, 4, 4, 0, 90, 6)
             + [(12, 40)] + arc(12, 36, 4, 4, 90, 180, 6) + [(8, 22)] + arc(12, 22, 4, 4, 180, 270, 6))
    grip = [(22, 40), (12, 84), (32, 88), (42, 50)]
    guard = arc(53, 42, 11, 16, 180, 0, 16)[::-1]
    trigger = [(52, 40), (52, 47), (48, 52)]
    return [slide, grip, guard, trigger]


def render_icon(lines):
    pts = np.array([p for ln in lines for p in ln], dtype=np.float64)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    avail = BIG - 2 * PAD - LINE_W - 2 * GLOW
    k = avail / max(hi - lo)
    off = (BIG - (hi - lo) * k) / 2 - lo * k
    mask = Image.new("L", (BIG, BIG), 0)
    d = ImageDraw.Draw(mask)
    r = LINE_W / 2
    for ln in lines:
        xy = [(x * k + off[0], y * k + off[1]) for x, y in ln]
        d.line(xy, fill=255, width=LINE_W)
        for x, y in xy:                           # 圓角端點 / 接點
            d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    a = np.asarray(mask, dtype=np.float64) / 255
    g = mask.filter(ImageFilter.MaxFilter(2 * GLOW + 1)).filter(ImageFilter.GaussianBlur(GLOW / 2))
    ga = np.asarray(g, dtype=np.float64) / 255 * 0.35
    out_a = a + ga * (1 - a)
    rgb = np.where(out_a[:, :, None] > 0, (a / np.maximum(out_a, 1e-6))[:, :, None], 0) * np.ones(3)
    rgba = np.concatenate([rgb, out_a[:, :, None]], axis=2)
    return to_img(rgba).resize((OUT, OUT), Image.LANCZOS)


# ---------------------------------------------------------------- 預覽
def checker(w, h, s=16, c0=(0xE8, 0xE8, 0xE8), c1=(0xC8, 0xC8, 0xC8)):
    y, x = np.mgrid[0:h, 0:w]
    m = ((x // s + y // s) % 2).astype(bool)
    arr = np.where(m[:, :, None], np.array(c1), np.array(c0)).astype(np.uint8)
    return Image.fromarray(arr, "RGB").convert("RGBA")


def preview(atlas, drop, icons, out_dir):
    gap = 16
    W = 512 + gap + 3 * OUT
    H = 512
    canvas = Image.new("RGBA", (W, H), (0x88, 0x88, 0x88, 255))
    bg = checker(512, 512)
    bg.alpha_composite(atlas.resize((512, 512), Image.LANCZOS))
    canvas.paste(bg, (0, 0))
    x0 = 512 + gap
    dbg = checker(256, 256)
    dbg.alpha_composite(drop.resize((256, 256), Image.NEAREST))
    canvas.paste(dbg, (x0, 0))
    for row, col in ((0, (0x33, 0x33, 0x33, 255)), (1, (0xDD, 0xDD, 0xDD, 255))):
        strip = Image.new("RGBA", (3 * OUT, OUT), col)
        for i, ic in enumerate(icons):
            strip.alpha_composite(ic, (i * OUT, 0))
        canvas.paste(strip, (x0, 256 + row * OUT))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "fx-preview.png")
    img = canvas.convert("RGB")
    img.save(path, "PNG")
    print(f"FX fx-preview.png {img.width}x{img.height} bytes={os.path.getsize(path)}")


def main():
    rng = np.random.default_rng(SEED)
    atlas = blood_atlas(rng)
    save(atlas, "public/art/fx/blood-atlas.png")
    drop = blood_drop()
    save(drop, "public/art/fx/blood-drop.png")
    icons = []
    for name, fn in (("fist", icon_fist), ("bat", icon_bat), ("pistol", icon_pistol)):
        ic = render_icon(fn())
        save(ic, f"public/art/hud/weapon-{name}.png")
        icons.append(ic)
    pdir = os.environ.get("FX_PREVIEW_DIR", "")
    if pdir:
        preview(atlas, drop, icons, pdir)
    print("FX_DONE")


if __name__ == "__main__":
    main()
