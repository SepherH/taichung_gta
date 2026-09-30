"""A4 可平鋪貼圖：imgen-local 底圖 → 去低頻、四邊無縫化 → 疊程序接縫（地磚 / 石材分割 / 帷幕框）→ 512 JPG。

執行：blender -b -P tools/blender/tiles/build_tiles.py
輸入：imgen-local 原圖（$CC_LOG_DIR/imgen/tcgta_tile_<名>_00001_.png，未入 repo；缺檔的項目改用純程序生成）
輸出：public/art/tiles/<名>.jpg（經 sips 轉 JPEG）、TILES_CHECK 環境變數指定目錄時另出 2x2 拼接檢查圖
接縫原則：所有程序圖樣（格線 / 雜訊）都以 512 為週期，隨機雜訊用環狀（wrap）模糊，四邊天生連續。
"""
import os
import subprocess

import bpy
import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(REPO, "public", "art", "tiles")
SRC = os.path.join(os.environ.get("CC_LOG_DIR", os.path.expanduser("~/Library/Logs/claude-start")), "imgen")
CHECK = os.environ.get("TILES_CHECK", "")
N = 512
rng = np.random.default_rng(20260930)


def load(name):
    p = os.path.join(SRC, f"tcgta_tile_{name}_00001_.png")
    if not os.path.exists(p):
        return None
    im = bpy.data.images.load(p)
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    a = px.reshape(h, w, 4)[:, :, :3]
    f = h // N
    return a[:f * N, :f * N].reshape(N, f, N, f, 3).mean(axis=(1, 3))


def blur(a, sigma):
    """環狀高斯模糊（FFT，週期邊界 → 結果天生可平鋪）。"""
    k = np.fft.fftfreq(N)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (k[:, None] ** 2 + k[None, :] ** 2))
    if a.ndim == 2:
        return np.real(np.fft.ifft2(np.fft.fft2(a) * g))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[:, :, c]) * g)) for c in range(a.shape[2])], axis=2)


def seamless(a):
    """去掉大尺度明暗（高通）後，以錯位半張的副本在四邊做餘弦交叉淡化。"""
    a = a - blur(a, 48) + a.mean(axis=(0, 1))
    b = np.roll(a, (N // 2, N // 2), axis=(0, 1))
    t = np.sin(np.pi * (np.arange(N) + 0.5) / N) ** 2
    w = (t[:, None] * t[None, :]) ** 0.5
    w = w[:, :, None]
    return a * w + b * (1 - w)


def noise(sigma, amp=1.0):
    return blur(rng.standard_normal((N, N)), sigma) * amp / max(blur(rng.standard_normal((N, N)), sigma).std(), 1e-6)


def recolor(a, hexcol, contrast=1.0):
    h = hexcol.lstrip("#")
    target = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    lum = a.mean(axis=2, keepdims=True)
    lum = (lum - lum.mean()) * contrast
    return np.clip(target + lum, 0, 1)


def grid_mask(cols, rows, line, offset_rows=False):
    """地磚 / 石材接縫遮罩（1 = 接縫），回傳 (mask, tile_id)。"""
    y, x = np.mgrid[0:N, 0:N]
    cw, ch = N / cols, N / rows
    r = (y // ch).astype(int)
    xs = x + (np.where(r % 2 == 1, cw / 2, 0) if offset_rows else 0)
    c = (xs // cw).astype(int) % cols
    fx, fy = xs % cw, y % ch
    m = ((fx < line) | (fx > cw - line) | (fy < line) | (fy > ch - line)).astype(np.float32)
    return blur(m, 0.6), r * 1000 + c


def per_tile_tone(tile_id, amp):
    ids = np.unique(tile_id)
    tone = dict(zip(ids, rng.normal(0, amp, len(ids))))
    return np.vectorize(tone.get)(tile_id)[:, :, None]


def save(name, a, quality=80):
    os.makedirs(OUT, exist_ok=True)
    png = os.path.join(bpy.app.tempdir, f"{name}.png")
    img = bpy.data.images.new(name, N, N)
    rgba = np.concatenate([np.clip(a, 0, 1), np.ones((N, N, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = png
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    jpg = os.path.join(OUT, f"{name}.jpg")
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(quality), png, "--out", jpg],
                   check=True, capture_output=True)
    while os.path.getsize(jpg) > 150 * 1024 and quality > 40:
        quality -= 8
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(quality), png, "--out", jpg],
                       check=True, capture_output=True)
    print(f"TILE {name} bytes={os.path.getsize(jpg)} q={quality}")
    return a


def base_or_noise(name, color, sigma=1.2, amp=0.08):
    a = load(name)
    if a is None:
        print(f"TILE {name}: 無 imgen 底圖，改純程序")
        g = noise(sigma, amp) + noise(6, amp * 0.6)
        return recolor(np.repeat(g[:, :, None], 3, axis=2) + 0.5, color), False
    return seamless(a), True


def build():
    out = {}
    # 1 柏油（imgen rc=6 未產出 → 程序：細顆粒 + 亮色骨材點 + 大片色差）
    g = noise(0.8, 0.07) + noise(5, 0.03) + noise(30, 0.025)
    spk = (rng.random((N, N)) > 0.985).astype(np.float32)
    g = g + blur(spk, 0.7) * 0.9
    out["asphalt"] = save("asphalt", recolor(np.repeat(g[:, :, None], 3, axis=2), "#46484B"))
    # 2 草地
    a, _ = base_or_noise("grass", "#5C8F4A")
    out["grass"] = save("grass", recolor(a, "#5B8A45", 1.1))   # imgen 原色過艷，壓回參考文件 §5 草地色
    # 3 混凝土
    a, _ = base_or_noise("concrete", "#A9A8A3")
    out["concrete"] = save("concrete", a)
    # 4 人行道灰色地磚（30 cm 方磚、圖幅 2.4 m → 8×8 片）
    a, _ = base_or_noise("paver_gray", "#9C9C98")
    a = recolor(a, "#A3A29D", 0.8)
    m, tid = grid_mask(8, 8, 1.6)
    a = a + per_tile_tone(tid, 0.035)
    out["sidewalk_gray"] = save("sidewalk_gray", a * (1 - 0.45 * m[:, :, None]))
    # 5 人行道紅磚色地磚（20×10 cm 丁字錯縫、圖幅 1.6 m → 8×16 片）
    a, _ = base_or_noise("paver_red", "#9A5040")
    a = recolor(a, "#9C5442", 0.9)
    m, tid = grid_mask(8, 16, 1.5, offset_rows=True)
    a = a + per_tile_tone(tid, 0.05)
    out["sidewalk_redbrick"] = save("sidewalk_redbrick", a * (1 - 0.40 * m[:, :, None]))
    # 6 豪宅外牆石材 A（米色砂岩，imgen rc=3 未產出 → 借花崗岩顆粒改色；120×60 cm 石板、圖幅 2.4 m → 2×4 片）
    a, _ = base_or_noise("stone_granite", "#D6CCBA")
    a = recolor(a, "#D8CEBD", 0.45)
    m, tid = grid_mask(2, 4, 1.4, offset_rows=True)
    a = a + per_tile_tone(tid, 0.02)
    out["stone_cream"] = save("stone_cream", a * (1 - 0.30 * m[:, :, None]))
    # 7 豪宅外牆石材 B（淺棕灰花崗岩；90×60 cm 石板、圖幅 1.8 m → 2×3 片）
    a, _ = base_or_noise("stone_granite", "#B4A898")
    a = recolor(a, "#B7AB9B", 0.9)
    m, tid = grid_mask(2, 3, 1.4)
    a = a + per_tile_tone(tid, 0.025)
    out["stone_granite"] = save("stone_granite", a * (1 - 0.30 * m[:, :, None]))
    # 8 / 9 玻璃帷幕：反射底圖 + 竪框 / 橫框 + 層間不透明帶 + 每片玻璃色差
    for name, col, frame, cols in (("glass_blue", "#5C7A92", "#2B3238", 2), ("glass_dark", "#3C3530", "#1E1D1C", 4)):
        a, _ = base_or_noise(name, col)
        a = recolor(a, col, 0.6)
        y, x = np.mgrid[0:N, 0:N]
        cw = N / cols
        tid = (x // cw).astype(int)
        a = a + per_tile_tone(tid, 0.03)
        spandrel = (y >= N * 0.78).astype(np.float32)   # 圖底 22% = 樓板 / 層間帶（不透明）
        a = a * (1 - spandrel[:, :, None]) + recolor(a, frame, 0.3) * spandrel[:, :, None] * 1.25
        mull = ((x % cw) < 5) | ((x % cw) > cw - 5) | (np.abs(y - N * 0.78) < 4) | (y < 3) | (y > N - 3)
        fr = np.array([int(frame.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)])
        a = np.where(blur(mull.astype(np.float32), 0.6)[:, :, None] > 0.5, fr, a)
        out[name] = save(name, a, 82)
    if CHECK:
        os.makedirs(CHECK, exist_ok=True)
        names = list(out)
        big = np.ones((3 * 2 * 256, 3 * 2 * 256, 4), dtype=np.float32)
        for i, nm in enumerate(names):
            t = out[nm][::2, ::2]
            t2 = np.concatenate([np.concatenate([t, t], 1), np.concatenate([t, t], 1)], 0)
            r, c = divmod(i, 3)
            big[r * 512:(r + 1) * 512, c * 512:(c + 1) * 512, :3] = t2[::-1] if False else t2
        img = bpy.data.images.new("check", big.shape[1], big.shape[0])
        img.pixels.foreach_set(np.ascontiguousarray(big[::-1]).ravel())
        img.filepath_raw = os.path.join(CHECK, "tiles-2x2.png")
        img.file_format = "PNG"
        img.save()
        print("CHECK", names)


build()
