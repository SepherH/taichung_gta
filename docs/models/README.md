# 地標模型（Blender）

遊戲裡的地標建築不寫死在 JS，而是一般 3D 軟體打得開的檔案：

| 檔案 | 用途 |
|---|---|
| `assets/blender/<slug>.blend` | Blender 來源檔，給人打開來看 / 改 |
| `public/models/<slug>.glb` | 遊戲載入用（glTF 二進位），由 .blend 的內容匯出 |
| `public/models/manifest.json` | 每棟的 OSM id、檔名、原點經緯度、高度、說明 |
| `tools/blender/*.py` | 產生上面三者的腳本（每棟一支 + 共用 `landmark_lib.py`） |
| `docs/models/previews/` | 每棟兩張預覽圖（`-street` 街道視角、`-aerial` 鳥瞰） |

外觀依據一律是 `docs/ref/tiger-city-reference.md`；腳本檔頭的每個尺寸都註明出處章節與「已確認 / 推測」。

## 用 Blender 打開

1. 安裝 Blender（免費，blender.org），打開 `assets/blender/tiger_city.blend`
2. 右上角 **Outliner** 是物件清單：`tiger_city` collection 底下按部位分 `body`（主體）/ `roof`（屋頂）/ `entrance`（入口、柱廊、玻璃塔）/ `site`（廣場）/ `signs`（招牌）
3. `_preview（不匯出）` 裡是預覽用的地面、太陽、相機，不會進遊戲
4. 滑鼠中鍵拖曳旋轉視角、滾輪縮放；數字鍵盤 `.` 對焦選到的物件；`F12` 用預覽相機算一張圖

## 座標約定（與遊戲程式的契約，改模型時別破壞）

- 單位公尺；**原點 = 該建築 OSM 輪廓外接矩形的中心**，地面高度 0
- Blender 內 +X 東、+Y 北、+Z 上；匯出 glTF 時轉成 +Y 上（glTF 內 −Z 是北）
- 原點的經緯度寫在 manifest 的 `anchorLat` / `anchorLon`，遊戲靠它放置模型
- 招牌文字不做成幾何：名為 `sign:<文字>` 的平面（例 `sign:TIGER CITY`），遊戲執行期貼字；平面正面朝外
- 材質只用 Principled BSDF 的顏色 / 金屬度 / 粗糙度 / 自發光（夜間發亮的部位）

## 改完怎麼重新匯出

**建議改腳本、不要只改 .blend**——腳本才是正本，重建時 .blend 會被覆蓋。

```sh
# 重建單棟（.blend、.glb、manifest、預覽圖一起更新）
blender -b -P tools/blender/tiger_city.py
# 重建全部
blender -b -P tools/blender/build_all.py
```

若只想在 Blender 裡手動改一下試試：改完後 `File → Export → glTF 2.0`，格式選 `glTF Binary (.glb)`，
勾 `Limit to → Selected Objects`（先在 Outliner 選 `tiger_city` collection 的全部物件，不要選 `_preview`），
`Transform → +Y Up` 保持勾選，存到 `public/models/tiger_city.glb`。記得把同樣的改動寫回腳本。

## 新增一棟地標

1. 在 `data/osm/qiqi-raw.json` 用名稱找到該建築的 way id（有 `building` tag 的 way）
2. 複製一支最像的腳本（例如塔樓抄 `lianju_zhongyong.py`），改 `WAY_ID` / `SLUG` / `NAME` 與檔頭尺寸參數，每個數字註明參考來源
3. 把模組名加進 `tools/blender/build_all.py` 的 `LANDMARKS`
4. 跑 `blender -b -P tools/blender/<slug>.py`，打開預覽圖檢查像不像
5. 預算：每個 glb ≤ 300 KB、全部 ≤ 1.5 MB；三角面數幾百到幾千

常用函式（`landmark_lib.py`）：`prism` 把輪廓擠出成量體、`offset` 輪廓外擴 / 內縮、`band` 水平帶、
`fins` 垂直線條、`box_ab` 沿七期斜格網放方塊、`sign` 招牌平面、`boolean_cut` 挖洞、`mat` 建材質。
