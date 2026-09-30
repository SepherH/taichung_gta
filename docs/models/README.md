# 3D 模型（Blender）：地標、角色、車輛、貼圖

遊戲裡的地標建築不寫死在 JS，而是一般 3D 軟體打得開的檔案：

| 檔案 | 用途 |
|---|---|
| `assets/blender/<slug>.blend` | Blender 來源檔，給人打開來看 / 改 |
| `public/models/<slug>.glb` | 遊戲載入用（glTF 二進位），由 .blend 的內容匯出 |
| `public/models/manifest.json` | 每棟的 OSM id、檔名、原點經緯度、高度、說明 |
| `tools/blender/*.py` | 產生上面三者的腳本（每棟一支 + 共用 `landmark_lib.py`） |
| `docs/models/previews/` | 每棟兩張預覽圖（`-street` 街道視角、`-aerial` 鳥瞰），長邊 768 px |

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
- 招牌文字不做成幾何：名為 `sign:<文字>` 的平面（例 `sign:TIGER CITY`），遊戲執行期貼字；平面正面朝外。同一文字出現多次時 Blender 會自動加 `.001`、`.002` 後綴（例 `sign:市政府站.001`），程式取字時請去掉結尾 `.數字`
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

1. 在 `data/osm/qiqi-raw-v2.json`（Phase 2 起的 OSM 資料）用名稱找到該建築的 way id（有 `building` tag 的 way）
2. 複製一支最像的腳本（例如塔樓抄 `lianju_zhongyong.py`），改 `WAY_ID` / `SLUG` / `NAME` 與檔頭尺寸參數，每個數字註明參考來源
3. 把模組名加進 `tools/blender/build_all.py` 的 `LANDMARKS`
4. 跑 `blender -b -P tools/blender/<slug>.py`，打開預覽圖檢查像不像
5. 預算：每個 glb ≤ 300 KB、全部 ≤ 1.5 MB；三角面數幾百到幾千

常用函式（`landmark_lib.py`）：`prism` 把輪廓擠出成量體、`offset` 輪廓外擴 / 內縮、`band` 水平帶、
`fins` 垂直線條、`box_ab` 沿七期斜格網放方塊、`sign` 招牌平面、`boolean_cut` 挖洞、`mat` 建材質。

沒有 OSM 建物輪廓的物件（秋紅谷展示館、紅色跨湖步道）用 `L.begin_point(slug, 字串id, 名稱, 緯度, 經度, 概略平面)` 開場，
manifest 的 `id` 是字串、`footprint` 為 false；原點高度假設寫在該筆 `notes`（例：步道原點＝水面，推測比路面低 7 m）。
匯出時 `finish` 會把所有非招牌網格合併成一個 `<slug>_mesh`（每種材質一個 primitive），遊戲端 draw call 約等於材質數；
.blend 裡仍保留按部位分的原始物件，方便打開來改。

---

# 角色（行人 / 玩家）

| 檔案 | 用途 |
|---|---|
| `tools/blender/characters/char_lib.py` | 共用：網格放樣、骨架、動作工具、匯出 |
| `tools/blender/characters/build_characters.py` | 3 個變體的體型 / 配色 / 髮型與 10 個動作的關鍵影格；一鍵重建 |
| `assets/blender/characters/<id>.blend` | Blender 來源檔（`pedestrian` / `pedestrian_f` / `pedestrian_heavy`） |
| `public/models/characters/<id>.glb` | 遊戲用（含骨架、蒙皮、10 個動畫） |
| `public/models/characters/manifest.json` | 變體清單、clip 名稱 / 長度 / 是否循環、材質槽、命中窗、坐姿 / 倒地位置 |
| `docs/models/previews/characters-lineup.png`、`characters-clips.png` | 三變體站姿、各動作關鍵影格 |

**打開來看**：Blender 開 `assets/blender/characters/pedestrian.blend`。Outliner 裡 `pedestrian.rig` 是骨架、`.body` / `.head` / `.hair` 是網格。
想看動作：選骨架 → 上方切到 **Animation** 工作區 → 下方 **Nonlinear Animation**（NLA）面板可看到 10 條軌（idle、walk…），
點某一條軌的星號（Solo）再按空白鍵播放。

**座標契約**：身高 1.75 m、原點在兩腳底中心、面向 glTF +Z；動作全部原地（位移由程式控制），只有 Hips 會上下 / 坐下 / 倒地。
骨頭名稱採常見人形標準（Hips、Spine、Chest、Neck、Head、Left/RightShoulder、UpperArm、LowerArm、Hand、UpperLeg、LowerLeg、Foot），
三個變體骨架完全相同，動畫可跨檔共用。材質槽 skin / shirt / pants / hair / shoes 可在執行期依名稱換色（眼睛與眉毛共用 hair）。

**怎麼改**：
- 改體型：`build_characters.py` 的 `VARIANTS` → `g`（arm / leg / torso / hip / chest / belly / shoulder 等倍率）與 `colors`、`hair`（short / bob / buzz）。
- 改動作：同檔的 `*_keys()` 函式，每個關鍵影格是「骨頭 → (X, Y, Z) 度」：X 前後彎（上指的骨頭正值往前彎、下指的腿 / 手臂負值往前抬）、
  Y 左右擺、Z 水平扭轉；子骨相對父骨。改完重跑即可，不必進 Blender 手動擺。
- 新增動作：在 `CLIPS` 加一列（名稱、關鍵影格函式、是否循環），並告知程式端（manifest 的 clip 名稱是契約）。

```sh
blender -b -P tools/blender/characters/build_characters.py
```

## 主角（hero）

`tools/blender/characters/hero.py` → `public/models/characters/hero.glb`、`assets/blender/characters/hero.blend`，manifest 中 `role: "player"`、`height: 1.86`。
依用戶提供的照片打扮建模：深灰 / 黑寬橫條紋連帽上衣（七分袖外擴袖口、V 領滾邊、兩條帽繩、帽兜垂在背後）、淺藍直筒牛仔褲（程序刷色貼圖 `hero_jeans.jpg`：大腿正面較淺、側縫、褲腳堆疊摺痕）、黑鞋（鞋面 + 外凸鞋底兩層）、中分及肩直髮（多片髮束、髮尾外翹、額頭中央露出）、分指手掌（拇指分離、四指兩節）。約 1.18 萬三角面（行人的 2 倍以上）。
臉部用 `assets/blender/characters/hero_face.jpg`（照片裁臉 → 本機 qwen-edit 清晰化 → 雙眼水平、鼻樑置中 → 低頻膚色拉平 → 橢圓羽化到膚色；**原始照片不入 repo**）以正面投影貼在網格頭（鼻 / 眼窩 / 唇 / 下巴起伏）上，材質名 `face`；羽化外圈顏色＝`skin` 材質色（`#EDBFA8`），側面與耳後為膚色，無接縫。換臉圖後要把新的外圈膚色同步寫回 `hero.py` 的 `COLORS["skin"]`，對位常數為 `V_EYE` / `TEX_SU` / `TEX_SV`。
上衣黑條為 `shirt_stripe`（也用於袖口內側、鞋底、帽兜開口與褲管封口暗部）。
骨名 / 階層 / 朝向與行人相同，但關節高度依 1.86 m 比例重排（頭部同尺寸、增高在腿與軀幹），所以**主角請用 hero.glb 自帶的 clip**；
另有循環 clip `idle_pose`（本人右手插腰招牌待機，3.0 秒）。改比例改 `C.set_proportions([...])` 的高度對照表；各動作腳底貼地由 `build_characters.py` 的 `GROUND` 表自動校正。
設 `CHAR_PREVIEW_SCRATCH=<目錄>` 執行時會另外輸出全 clip 蒙皮檢查拼圖 `hero-clips.png`（不入 repo）。

# 車輛

| 檔案 | 用途 |
|---|---|
| `tools/blender/vehicles/vehicle_lib.py` | 共用：側視輪廓擠出、倒角、輪拱布林、輪子、匯出 / 預覽 |
| `tools/blender/vehicles/<車種>.py` | 每種一支（`sedan.py` 同時產出轎車與計程車） |
| `tools/blender/vehicles/build_vehicles.py` | 一鍵重建全部並寫 manifest |
| `public/models/vehicles/<id>.glb`、`manifest.json` | 遊戲用；manifest 有長寬高、軸距、輪距、輪徑、座位點、建議質量、各輪心座標 |
| `docs/models/previews/vehicle-<id>-front.png` / `-rear.png` | 前後 3/4 預覽 |

**座標契約**：原點在地面、車輛中心正下方，車頭朝 glTF +Z；節點 `body` 與 `wheel_fl` / `wheel_fr` / `wheel_rl` / `wheel_rr`
（機車 `wheel_f` / `wheel_r`），輪子原點在輪心、繞本地 X 轉、繞本地 Y 轉向。材質 `paint` 是車身主色（執行期換色），
`headlight` / `taillight` 帶自發光。`seat` 是駕駛 H 點＝角色 drive 動作的 Hips 位置。

**怎麼改**：每支腳本上方是尺寸常數（長、軸距、輪徑…）與側視輪廓點列 `LOWER` / `CABIN`（(y, z) 公尺，車頭在 −y）；
改點列就改車形。在 Blender 裡打開 `.blend` 看完覺得哪裡不對，回腳本改對應數字再重跑：

```sh
blender -b -P tools/blender/vehicles/build_vehicles.py
```

# 可平鋪貼圖（public/art/tiles/）

由 `tools/blender/tiles/build_tiles.py` 產生：由本機生圖工具產出的材質底圖（原圖未入 repo；重建時以環境變數 `TILE_SRC_DIR` 指定原圖目錄，缺檔改純程序生成）
先去掉大範圍明暗、四邊交叉淡化成無縫，再用程式疊上地磚 / 石材接縫與帷幕框（接縫以 512 px 為週期，保證四邊連續）。
清單、用途與建議重複尺度見 `docs/art/ASSETS.md`「可平鋪貼圖」。重建：

```sh
blender -b -P tools/blender/tiles/build_tiles.py
```

three.js 用法：`texture.wrapS = texture.wrapT = THREE.RepeatWrapping`、`texture.colorSpace = THREE.SRGBColorSpace`，
`texture.repeat.set(面寬 / 建議尺度, 面高 / 建議尺度)`。
