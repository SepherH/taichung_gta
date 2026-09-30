"""臺中GTA 地標打卡徽章：12 棟地標各一枚圓形徽章（中央為該地標簡化剪影，無任何文字）。

執行：blender -b -P tools/blender/art/build_badges.py
產出：public/art/badges/<slug>.png（256x256 RGBA）、public/art/badges/manifest.json、
      docs/models/previews/badges.png（6x2 預覽拼圖，白底）
流程：每棟 factory reset → 匯入 public/models/<file> → Workbench 平塗單色正交算 1024 alpha 遮罩（暫存目錄）
      → numpy 4 倍超取樣合成徽章（描邊 / 金環 / 內圓底 + 漸層 / 剪影 + 深色描邊投影）→ box 降到 256。
座標：Blender 內 +X 東、+Y 北、+Z 上；方位角由正南往東量（相機在建物南偏東方向往建物中心看）。
不存 .blend。
"""
import json
import math
import os
import shutil
import sys
import tempfile

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import blendsafe  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
MODEL_DIR = os.path.join(REPO, "public", "models")
BADGE_DIR = os.path.join(REPO, "public", "art", "badges")
PREVIEW_DIR = os.path.join(REPO, "docs", "models", "previews")

SIZE = 256                  # 輸出邊長
SS = 4                      # 超取樣倍數
S = SIZE * SS               # 合成邊長（1024）
MASK_RES = 1024             # 遮罩算圖邊長
MARGIN = 0.06               # 遮罩畫面四邊留白

DEFAULT_VIEW = (30.0, 12.0)  # (方位角：由南往東, 仰角)
VIEWS = {
    "qiuhonggu_red_bridge": (35.0, 35.0),
    "qiuhonggu_pavilion": (30.0, 25.0),
    "mrt_city_hall_station": (30.0, 30.0),
    "national_taichung_theater": (20.0, 10.0),
}

R_OUTLINE, R_GOLD, R_INNER = 0.49, 0.46, 0.42
C_OUTLINE = "#2A1E3F"
C_GOLD = "#F0B43C"
C_BASES = ["#F07A1A", "#4A2A6A", "#2F7F7A", "#C8506A", "#3E6FA8", "#8A5A2B"]
C_SIL = "#FFF4E0"
C_SHADOW = "#1B1426"
SHADOW_ALPHA = 0.60
SIL_FRAC = 0.72             # 剪影最長邊 / 內圓直徑
SIL_DY = 0.03               # 剪影中心往下
GRAD_GAIN = 0.12            # 內圓上半部漸層亮度
STROKE_PX = 2               # 剪影描邊（256 尺度）
SHADOW_DY_PX = 1            # 投影往下位移（256 尺度）


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)


# ---------------------------------------------------------------- 遮罩算圖
def ensure_gltf():
    if not hasattr(bpy.ops.import_scene, "gltf"):
        import addon_utils
        addon_utils.enable("io_scene_gltf2", default_set=True)


def world_verts():
    """所有 mesh 物件的世界座標頂點 (N, 3)。"""
    bpy.context.view_layer.update()
    pts = []
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH" or not ob.data.vertices:
            continue
        n = len(ob.data.vertices)
        co = np.empty(n * 3, dtype=np.float64)
        ob.data.vertices.foreach_get("co", co)
        co = co.reshape(n, 3)
        m = np.array(ob.matrix_world, dtype=np.float64)
        pts.append(co @ m[:3, :3].T + m[:3, 3])
    if not pts:
        raise RuntimeError("模型內沒有任何 mesh")
    return np.concatenate(pts, axis=0)


def setup_mask_scene(scene):
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = MASK_RES
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "SINGLE"
    sh.single_color = (1.0, 1.0, 1.0)
    sh.show_shadows = False
    sh.show_cavity = False
    sh.show_object_outline = False
    for k, v in (("show_xray", False), ("show_specular_highlight", False), ("use_dof", False)):
        if hasattr(sh, k):
            setattr(sh, k, v)
    try:
        scene.display.render_aa = "8"
    except (AttributeError, TypeError):
        pass


def frame_camera(scene, verts, az_deg, el_deg):
    """正交相機：由建物南偏東 az、仰角 el 往中心看，ortho_scale 依投影外接框自動框進、四邊留 MARGIN。"""
    from mathutils import Vector
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = np.array([math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)])   # 中心 → 相機
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    center = (lo + hi) / 2
    diag = float(np.linalg.norm(hi - lo)) or 1.0
    cam = bpy.data.objects.new("badge_camera", bpy.data.cameras.new("badge_camera"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    rot = (Vector(tuple(-d))).to_track_quat("-Z", "Y")
    right = np.array(rot @ Vector((1, 0, 0)))
    up = np.array(rot @ Vector((0, 1, 0)))
    rel = verts - center
    px, py = rel @ right, rel @ up
    cx, cy = (px.min() + px.max()) / 2, (py.min() + py.max()) / 2
    span = max(px.max() - px.min(), py.max() - py.min(), 1e-3)
    dist = diag * 2 + 10
    loc = center + right * cx + up * cy + d * dist
    cam.location = tuple(loc)
    cam.rotation_euler = rot.to_euler()
    cam.data.ortho_scale = span / (1 - 2 * MARGIN)
    cam.data.clip_start = 0.1
    cam.data.clip_end = dist * 2 + diag
    return cam


def render_mask(glb, az, el, tmp):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ensure_gltf()
    bpy.ops.import_scene.gltf(filepath=glb)
    scene = bpy.context.scene
    verts = world_verts()
    setup_mask_scene(scene)
    frame_camera(scene, verts, az, el)
    path = os.path.join(tmp, os.path.basename(glb).replace(".glb", "_mask.png"))
    blendsafe.render_png(path, scene)
    im = bpy.data.images.load(path)
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return np.flipud(px.reshape(h, w, 4)[:, :, 3]).copy()     # 由上而下


# ---------------------------------------------------------------- 徽章合成（numpy，由上而下座標）
def resample(a, oh, ow):
    """雙線性縮放 2D 陣列到 (oh, ow)。"""
    h, w = a.shape
    ys = np.clip((np.arange(oh) + 0.5) * h / oh - 0.5, 0, h - 1)
    xs = np.clip((np.arange(ow) + 0.5) * w / ow - 0.5, 0, w - 1)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, h - 1), np.minimum(x0 + 1, w - 1)
    fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def shift(a, dy, dx):
    out = np.zeros_like(a)
    h, w = a.shape
    out[max(dy, 0):h + min(dy, 0), max(dx, 0):w + min(dx, 0)] = a[max(-dy, 0):h + min(-dy, 0), max(-dx, 0):w + min(-dx, 0)]
    return out


def dilate(a, r):
    out = a.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if (dy or dx) and dy * dy + dx * dx <= r * r:
                np.maximum(out, shift(a, dy, dx), out=out)
    return out


def place_silhouette(mask):
    """遮罩裁外接框 → 等比縮放到最長邊 = 內圓直徑 × SIL_FRAC → 置中略偏下，回傳 S×S 覆蓋率。"""
    ys, xs = np.nonzero(mask > 1e-3)
    out = np.zeros((S, S), dtype=np.float32)
    if len(ys) == 0:
        return out
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = crop.shape
    target = SIL_FRAC * 2 * R_INNER * S
    k = target / max(h, w)
    oh, ow = max(1, int(round(h * k))), max(1, int(round(w * k)))
    sil = np.clip(resample(crop, oh, ow), 0, 1)
    cy, cx = (0.5 + SIL_DY) * S, 0.5 * S
    y0, x0 = int(round(cy - oh / 2)), int(round(cx - ow / 2))
    ya, xa = max(y0, 0), max(x0, 0)
    yb, xb = min(y0 + oh, S), min(x0 + ow, S)
    out[ya:yb, xa:xb] = sil[ya - y0:yb - y0, xa - x0:xb - x0]
    return out


def compose_badge(mask, base_hex):
    c = (np.arange(S, dtype=np.float32) + 0.5) / S - 0.5
    u, v = np.meshgrid(c, c)                      # v < 0 為上方
    r = np.sqrt(u * u + v * v)
    rgb = np.empty((S, S, 3), dtype=np.float32)
    rgb[:] = hex_rgb(C_OUTLINE)
    rgb[r <= R_GOLD] = hex_rgb(C_GOLD)
    inner = r <= R_INNER
    t = np.clip(-v / R_INNER, 0, 1)
    t = t * t * (3 - 2 * t)                       # 柔和：中心 0 → 頂端 1
    base = hex_rgb(base_hex)
    grad = base[None, None, :] + (1 - base[None, None, :]) * (GRAD_GAIN * t)[:, :, None]
    rgb[inner] = grad[inner]
    alpha = (r <= R_OUTLINE).astype(np.float32)
    innerf = inner.astype(np.float32)

    sil = place_silhouette(mask) * innerf
    d = dilate(sil, STROKE_PX * SS)
    stroke = np.maximum(d, shift(d, SHADOW_DY_PX * SS, 0)) * innerf * SHADOW_ALPHA
    rgb = rgb * (1 - stroke[:, :, None]) + hex_rgb(C_SHADOW) * stroke[:, :, None]
    rgb = rgb * (1 - sil[:, :, None]) + hex_rgb(C_SIL) * sil[:, :, None]

    pm = np.concatenate([rgb * alpha[:, :, None], alpha[:, :, None]], axis=2)
    pm = pm.reshape(SIZE, SS, SIZE, SS, 4).mean(axis=(1, 3))
    a = pm[:, :, 3:4]
    out = np.where(a > 0, pm[:, :, :3] / np.maximum(a, 1e-6), 0)
    return np.concatenate([np.clip(out, 0, 1), a], axis=2).astype(np.float32), int(np.count_nonzero(sil))


def save_png(arr, path, name):
    """arr：由上而下 (H, W, 4) straight alpha。"""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(np.flipud(arr).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    blendsafe.strip_png_text(path)


def preview_sheet(badges, out, cols=6, cell=128):
    rows = (len(badges) + cols - 1) // cols
    big = np.ones((rows * cell, cols * cell, 4), dtype=np.float32)
    f = SIZE // cell
    for i, b in enumerate(badges):
        pm = np.concatenate([b[:, :, :3] * b[:, :, 3:4], b[:, :, 3:4]], axis=2)
        pm = pm.reshape(cell, f, cell, f, 4).mean(axis=(1, 3))
        rgb = pm[:, :, :3] + (1 - pm[:, :, 3:4])          # 疊白底
        r, c = divmod(i, cols)
        big[r * cell:(r + 1) * cell, c * cell:(c + 1) * cell, :3] = rgb
    save_png(big, out, "badges_preview")


# ---------------------------------------------------------------- 主流程
def main():
    with open(os.path.join(MODEL_DIR, "manifest.json"), encoding="utf-8") as f:
        models = json.load(f)
    os.makedirs(BADGE_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="tcgta_badges_")
    entries, badges = [], []
    try:
        for i, m in enumerate(models):
            slug = m["file"][:-4] if m["file"].endswith(".glb") else m["file"]
            az, el = VIEWS.get(slug, DEFAULT_VIEW)
            mask = render_mask(os.path.join(MODEL_DIR, m["file"]), az, el, tmp)
            badge, _ = compose_badge(mask, C_BASES[i % len(C_BASES)])
            out = os.path.join(BADGE_DIR, f"{slug}.png")
            save_png(badge, out, f"badge_{slug}")
            badges.append(badge)
            entries.append({"id": m["id"], "slug": slug, "name": m["name"], "file": f"{slug}.png"})
            print(f"BADGE {slug} mask_px={int(np.count_nonzero(mask))} bytes={os.path.getsize(out)}")
        with open(os.path.join(BADGE_DIR, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"size": SIZE, "badges": entries}, f, indent=2, ensure_ascii=False)
            f.write("\n")
        preview_sheet(badges, os.path.join(PREVIEW_DIR, "badges.png"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("BADGES_DONE")


main()
