"""公開 repo 用的存檔 / 算圖出口：.blend 與預覽 PNG 不留本機絕對路徑、使用者名稱或 .blend1 備份。

- save_blend(path)：算圖輸出路徑改 "//"、影像路徑轉相對、不產 .blend1；存檔後把檔內任何含本機家目錄 / repo 絕對路徑的
  字串（含 Blender 記錄的「Save As」運算子目錄、字串緩衝區殘留）以等長 NUL 蓋掉，再用 zstd 壓縮（無 zstd 則存未壓縮）。
- render_png(path)：關閉全部 stamp / metadata 後算圖，並刪掉 PNG 的文字區段（tEXt / zTXt / iTXt / tIME）。
"""
import os
import shutil
import struct
import subprocess
import zlib

import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_MARKERS = {b"/Users/", b"/home/", os.path.expanduser("~").encode(), (os.path.basename(REPO) + "/").encode()}


def quiet_render(scene=None):
    r = (scene or bpy.context.scene).render
    for k in dir(r):
        if k.startswith("use_stamp") and isinstance(getattr(r, k, None), bool):
            try:
                setattr(r, k, False)
            except (AttributeError, TypeError):
                pass


def strip_png_text(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return
    out, i = [data[:8]], 8
    while i < len(data):
        ln, typ = struct.unpack(">I4s", data[i:i + 8])
        if typ not in (b"tEXt", b"zTXt", b"iTXt", b"tIME"):
            out.append(data[i:i + 12 + ln])
        i += 12 + ln
    with open(path, "wb") as f:
        f.write(b"".join(out))


def render_png(path, scene=None):
    sc = scene or bpy.context.scene
    quiet_render(sc)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    sc.render.filepath = "//"
    strip_png_text(path)


def _scrub(raw):
    buf = bytearray(raw)
    hits = 0
    for mk in _MARKERS:
        j = buf.find(mk)
        while j >= 0:
            a = j
            while a > 0 and buf[a - 1] != 0 and j - a < 1024:
                a -= 1
            b = j
            while b < len(buf) and buf[b] != 0 and b - j < 1024:
                b += 1
            buf[a:b] = bytes(b - a)
            hits += 1
            j = buf.find(mk, b)
    return bytes(buf), hits


def save_blend(path):
    bpy.context.preferences.filepaths.save_version = 0          # 不產 .blend1
    for sc in bpy.data.scenes:
        sc.render.filepath = "//"
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=False)
    try:
        bpy.ops.file.make_paths_relative()
        bpy.ops.wm.save_mainfile(compress=False)
    except RuntimeError:
        pass
    with open(path, "rb") as f:
        raw, hits = _scrub(f.read())
    with open(path, "wb") as f:
        f.write(raw)
    zstd = shutil.which("zstd") or next((p for p in ("/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd") if os.path.exists(p)), None)
    if zstd:
        tmp = path + ".zst.tmp"
        subprocess.run([zstd, "-q", "-f", "-19", path, "-o", tmp], check=True)
        os.replace(tmp, path)
    print(f"BLENDSAFE {os.path.basename(path)} scrubbed={hits} zstd={bool(zstd)}")
