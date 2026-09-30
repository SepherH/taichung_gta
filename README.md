# 臺中GTA（prototype M1）

以臺中七期、Tiger City（老虎城）為中心的網頁 3D 開放世界原型。對齊參考作「臺北GTA」的做法：風格化、距離壓縮、軸對齊棋盤街廓，搭配程序生成的盒狀建築與手工地標。

- 技術：Vite + three.js（只用核心 API，不用 addon），純 JavaScript ES modules，沒有物理引擎。
- 所有幾何與貼圖都由程式生成（three.js 幾何 + CanvasTexture），不載入任何外部模型、貼圖、字型或地圖資料。

## 啟動

需要 Node.js 20.19 以上（Vite 7 的需求）。

```bash
npm install
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
index.html            載入畫面與 HUD 的 DOM
vite.config.js
src/
  main.js             進入點：分步載入、遊戲狀態、主迴圈
  data/city.js        城市資料（道路、地標、停車、車流路線、小知識）——校正地圖只需改這個檔
  world.js            地面、秋紅谷地形、道路、人行道、路口、斑馬線、路名、行道樹、路燈；heightAt / 位置描述
  buildings.js        程序生成建築（固定種子、合併成單一幾何、夜間窗戶發光）
  landmarks.js        老虎城、秋紅谷、新光三越、大遠百、臺中市政府、臺中國家歌劇院
  collision.js        AABB 網格碰撞、圓形推出、隱形牆
  player.js           第三人稱步行角色
  humanoid.js         方塊人形（玩家與行人共用）
  vehicle.js          車輛外型與街機駕駛手感、上下車
  traffic.js          行人與車流巡迴
  camera.js           第三人稱鏡頭（含避免穿牆）
  input.js            鍵盤 / 滑鼠 / pointer lock
  hud.js              小地圖、位置、時速、時間、提示
  daynight.js         日夜循環、夜間自發光
  loading.js          載入畫面
  utils.js            亂數、數學、文字貼圖
  style.css
```

## 座標系

X 向東、Z 向南（北方為 -Z）、Y 向上，單位公尺。臺灣大道視為東西向。世界範圍約 900m × 700m（x −450~450、z −350~350）。

## 除錯

主控台可以用 `window.__game` 檢視場景、玩家、車輛、碰撞與日夜狀態。
