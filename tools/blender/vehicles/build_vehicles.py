"""一鍵重建全部車輛：blender -b -P tools/blender/vehicles/build_vehicles.py

依序執行每支車輛腳本（sedan.py 同時產出 sedan / taxi），匯出 public/models/vehicles/<slug>.glb、
存 assets/blender/vehicles/<slug>.blend、算 docs/models/previews/vehicle-<slug>-front/-rear.png，
最後寫 public/models/vehicles/manifest.json（長寬高、軸距、輪距、輪徑、座位點、建議質量、輪心座標）。
"""
import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_lib as VL  # noqa: E402

MODULES = ["sedan", "suv", "bus", "scooter"]
entries, failed = [], []
for name in MODULES:
    try:
        mod = importlib.import_module(name)
        res = mod.build_all() if hasattr(mod, "build_all") else [mod.build()]
        entries.extend(res)
    except Exception as exc:  # 一台失敗不擋其他台
        import traceback
        traceback.print_exc()
        failed.append(f"{name}: {exc}")

manifest = {
    "convention": ("原點＝地面、車輛外接盒中心正下方；面向 glTF +Z、+Y 上、公尺。節點 body + wheel_fl/fr/rl/rr（機車 wheel_f/r），"
                   "輪子原點在輪心、繞本地 X 轉動、繞本地 Y 轉向。材質 paint＝車身主色（執行期換色）；headlight / taillight 帶 emission。"
                   "seat＝駕駛（騎士）H 點，角色 drive 動作的 Hips 關節位置：角色原點 = seat − (0, 0.30, 0)。"
                   "width 含後照鏡；座標皆為 glTF（x 左右、y 上、z 前）。"),
    "vehicles": entries,
}
os.makedirs(VL.GLB_DIR, exist_ok=True)
with open(os.path.join(VL.GLB_DIR, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"BUILD_VEHICLES done={len(entries)} failed={len(failed)}")
for f in failed:
    print("FAILED", f)
if failed:
    sys.exit(1)
