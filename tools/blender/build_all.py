"""一鍵重建全部地標：blender -b -P tools/blender/build_all.py

依序執行每支地標腳本的 build()：存 assets/blender/<slug>.blend、匯出 public/models/<slug>.glb、
更新 public/models/manifest.json、算 docs/models/previews/<slug>-street.png / -aerial.png。
新增地標：寫好 tools/blender/<slug>.py（照其他檔的格式），再把模組名加進下面的 LANDMARKS。
"""
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LANDMARKS = [
    "tiger_city",
    "national_taichung_theater",
    "shin_kong_mitsukoshi",
    "top_city",
    "baohui_qiuhonggu",
    "lianju_zhongyong",
    "lin_hotel",
    # Phase 2（七期精華區擴充）
    "taichung_city_hall",
    "taichung_city_council",
    "mrt_city_hall_station",
    "qiuhonggu_pavilion",
    "qiuhonggu_red_bridge",
]

failed = []
for name in LANDMARKS:
    try:
        importlib.import_module(name).build()
    except Exception as exc:  # 一棟失敗不擋其他棟，最後統一回報
        import traceback
        traceback.print_exc()
        failed.append(f"{name}: {exc}")

print(f"BUILD_ALL done={len(LANDMARKS) - len(failed)} failed={len(failed)}")
for f in failed:
    print("FAILED", f)
if failed:
    sys.exit(1)
