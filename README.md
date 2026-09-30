# 臺中GTA（prototype M1）

以臺中七期、Tiger City（老虎城）為中心的網頁 3D 開放世界原型。街區依真實 OpenStreetMap 資料生成：道路、建築輪廓、公園與水域都來自 OSM，1:1 真實比例、不壓縮，不憑空杜撰地圖內容。

- 技術：Vite + three.js（核心 API，另用 addon 的 GLTFLoader 載入地標模型），純 JavaScript ES modules，沒有物理引擎。
- 地圖資料在建置前轉成 `src/data/osm-city.json`（`npm run build:city`）；執行期不連網，只從本站 `public/models/` 載入地標 glb（沒有檔案時全部走通用擠出）。
- 建築依 OSM 輪廓擠出，高度取自 `height` / `building:levels`（缺資料時依類型保守估算並標記 `estimated`）；外牆為中性的程序窗格貼圖，具名建築屋頂上方掛名稱牌。地標的實景外觀由 `public/models/manifest.json` 列出的 glb 取代（`src/landmarks/`）。

## 啟動

需要 Node.js 20.19 以上（Vite 7 的需求）。

```bash
npm install
npm run build:city  # 由 data/osm/qiqi-raw.json 重新產生 src/data/osm-city.json（已附產出檔，改資料時才需要）
npm run dev       # 開發伺服器，預設 http://localhost:5273（通道 https://tcgta.i23iv.cc）
npm run build     # 產出 dist/
npm run preview   # 預覽 build 結果
```

## 操作鍵位

| 狀態 | 按鍵 | 功能 |
|---|---|---|
| 步行 | W A S D / 方向鍵 | 移動（相對鏡頭方向） |
| 步行 | Shift | 跑步 |
| 步行 | Space | 跳躍 |
| 共通 | 滑鼠拖曳 | 轉視角（點擊畫面會鎖定滑鼠，Esc 解除） |
| 共通 | 滾輪 | 鏡頭遠近 |
| 共通 | F | 靠近車輛時上車 / 駕駛中下車 |
| 駕駛 | W / S | 油門 / 煞車、倒車 |
| 駕駛 | A / D | 轉向 |
| 駕駛 | Space | 手煞車（可以甩尾） |
| 共通 | N | 時間快轉開 / 關 |
| 共通 | H | 收合 / 展開右上角的操作說明 |

## 目錄結構

```
index.html            載入畫面、HUD 與授權標示的 DOM
vite.config.js
data/osm/qiqi-raw.json  Overpass API 原始輸出（out tags geom）
tools/build-city.mjs  轉檔工具（純 Node）：投影、高度 / 路寬規則、輸出精簡 JSON 並印統計
src/
  main.js             進入點：分步載入、遊戲狀態、主迴圈
  data/osm-city.json  轉檔產出：建築、道路、步道、公園、水域、世界邊界
  data/city.js        遊戲參數（出生點道路、停放車輛種類、車流 / 行人數量）與臺中小知識
  citymodel.js        載入 osm-city.json，整理建築 / 道路 / 路口並提供空間查詢
  geom.js             平面幾何（點在多邊形內、最近點、耳切三角化、折線取樣、空間網格）
  world.js            地面鋪面、公園、水面、路面帶狀網格、標線、路名地面字、行道樹、路燈；heightAt / 位置描述
  buildings.js        依輪廓擠出建築（依材質分桶合併、夜間窗戶發光）、具名建築名稱牌
  landmarks/index.js  依 public/models/manifest.json 載入地標 glb（投影擺放、sign: 招牌字卡、夜間發光；缺檔退回通用擠出，碰撞仍用 OSM 輪廓）
  places.js           依資料計算出生點與路邊停車位置
  collision.js        多邊形網格碰撞、圓形推出、隱形牆
  player.js           第三人稱步行角色
  humanoid.js         方塊人形（玩家與行人共用）
  vehicle.js          車輛外型與街機駕駛手感、上下車
  traffic.js          車流（沿主要道路靠右行駛、路口換路 / 掉頭）與行人（沿路緣來回）
  camera.js           第三人稱鏡頭（含避免穿牆）
  input.js            鍵盤 / 滑鼠 / pointer lock
  hud.js              小地圖、位置、時速、時間、提示
  daynight.js         日夜循環、夜間自發光
  loading.js          載入畫面
  utils.js            亂數、數學、文字貼圖
  style.css
```

## 座標系

X 向東、Z 向南（北方為 -Z）、Y 向上，單位公尺，1:1 真實比例。原點為老虎城輪廓中心（等距圓柱近似投影）。世界範圍為資料 bbox（緯度 24.1575–24.1705、經度 120.6310–120.6470）投影後的矩形，約 1625m × 1447m（x −696~929、z −688~760），邊界為隱形牆。

## 資料來源

地圖資料 © OpenStreetMap contributors（ODbL）。道路、建築輪廓與高度、公園、水域皆取自 OpenStreetMap（<https://www.openstreetmap.org/copyright>），以 Open Database License 授權；遊戲畫面右下角常駐同樣的標示。

## 除錯

主控台可以用 `window.__game` 檢視場景、玩家、車輛、碰撞與日夜狀態。
