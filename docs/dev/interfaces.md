# 臺中GTA Phase 3 介面文件（契約定稿 v1）

本檔是各模組之間的**唯一介面來源**。原則：

- 模組不互相硬 import 對方的內部；跨模組只透過本檔列出的 API。
- 依賴一律「參數注入」（bus / settings / adapters 由呼叫端傳入），node 無頭測試用假物件替代。
- 共用樞紐 `main.js` / `hud.js` / `style.css` / `index.html` 只有整合單元會改；其他單元只交獨立模組，並附「接線說明」。
- 程式註解與 UI 文字用繁體中文；ES module；不引入新 npm 套件；不得寫入任何金鑰或個資；不用 alert / confirm。

---

## 1. 事件匯流排 `src/core/events.js`

- `createBus()` → `{ on(name, fn) → off, once(name, fn) → off, off(name, fn), emit(name, payload) }`
  - `emit` 同步依註冊順序呼叫；單一 listener 丟例外會被 catch 並 `console.error`，不影響其他 listener
  - emit 期間增刪 listener 安全：本次 emit 中被 off 的 listener 不再呼叫；本次 emit 中新增的 listener 下次才呼叫
  - `once` 觸發前可用回傳的函式取消；`off(name, fn)` 移除該事件上所有同一函式的訂閱
- `export const bus = createBus()`：全域單例，**只給整合層用**；模組內部一律用注入的 bus

| 事件 | payload | 發出者 |
|---|---|---|
| `game:start` | `{ continued: boolean }` | 選單（開始 / 繼續） |
| `game:pause` | `{ paused: boolean, tab?: string }` | 選單 |
| `game:quitToMenu` | `{}` | 選單 |
| `vehicle:enter` | `{ vehicle, carjack: boolean }` | 整合 |
| `vehicle:exit` | `{ vehicle }` | 整合 |
| `vehicle:horn` | `{ vehicle, x, z, dirX, dirZ }` | vehicle.js（`vehicle.honk()`） |
| `vehicle:damaged` | `{ vehicle, health, delta }` | vehicle-damage.js |
| `vehicle:crash` | `{ vehicle, relSpeed }`（玩家駕駛且 relSpeed ≥ 8 m/s） | vehicle-damage.js |
| `vehicle:disabled` | `{ vehicle }`（耐久歸零：熄火、黑煙，不爆炸） | vehicle-damage.js |
| `vehicle:recovered` | `{ vehicle, driven: boolean, x, y, z }`（掉出世界被重置到最近道路） | vehicle.js（VehicleManager） |
| `vehicle:carjackStart` | `{ car }` | carjack.js |
| `vehicle:carjacked` | `{ vehicle }` | carjack.js |
| `ped:knockdown` | `{ ped, cause: 'punch'\|'vehicle', byPlayer: boolean, x, z }` | 整合（由 combat 'knockdown' 轉發） |
| `player:ko` | `{}` | 整合 |
| `player:money` | `{ money, delta, reason }` | economy.js |
| `toast` | `{ text, seconds }` | 任何模組（整合轉給 `hud.toast`） |

表外的新事件名稱必須先加進本表。

## 2. 設定 `src/core/settings.js`

- 儲存鍵 `tcgta.settings.v1`（JSON）。讀寫全部 try/catch：無痕 / 停用儲存 / node 無 window 時只存記憶體
- `createSettings({ storage } = {})`；storage 省略 = 安全包裝的 `window.localStorage`
  - `get(key)`、`getAll()`（副本）
  - `set(key, value)` → boolean：未知鍵 / 型別不符 / 不在選項內 / 非有限數回 `false` 且不存；數值 clamp 到範圍並取 step；同值不通知
  - `reset(key?)`：省略 key = 全部回預設
  - `subscribe(fn(key, value, all))` → 取消函式（訂閱者例外被隔離）
- `export const settings = createSettings()`（單例，整合用）
- 另匯出 `SETTINGS_SCHEMA`、`SETTINGS_KEY`、`LEGACY_SENS_KEYS`、`normalizeSetting(key, value)`（選單滑桿可用）

| 鍵 | 型別 / 範圍 | 預設 |
|---|---|---|
| `quality` | `'auto'\|'low'\|'mid'\|'high'\|'ultra'` | `'auto'` |
| `lookSensMouse` | number 0.3–3.0（step 0.1） | 1.0 |
| `lookSensTouch` | number 0.3–3.0（step 0.1） | 1.0 |
| `invertY` | boolean | false |
| `volumeMaster` | number 0–1 | 0.8 |
| `volumeMusic` | number 0–1 | 0.6 |
| `volumeSfx` | number 0–1 | 0.9 |
| `showFps` | boolean | false |
| `showHints` | boolean | true |
| `uiScale` | number 0.8–1.3（step 0.05） | 1.0 |

- **舊版遷移**：`tcgta.settings.v1` 不存在時讀 `tcgta.lookSens.mouse` / `tcgta.lookSens.touch`（`'low'/'mid'/'high'` → 0.6 / 1.0 / 1.6）當初值，並立即寫入 v1（只遷移一次）
- **損毀**：JSON parse 失敗 / 非物件 → 全部預設；單鍵非法 → 該鍵預設；未知鍵丟棄；不丟例外

## 3. 畫質分級 `src/core/quality.js`

| id | label | dprCap | shadowMap（0=關） | peds | cars | pedNear（m，完整骨架動畫半徑） | pedFar（m，此外改替身） | viewDist |
|---|---|---|---|---|---|---|---|---|
| low | 低 | 1 | 0 | 40 | 18 | 30 | 70 | 420 |
| mid | 中 | 1.25 | 1024 | 80 | 30 | 40 | 90 | 650 |
| high | 高 | 1.5 | 2048 | 140 | 45 | 50 | 110 | 900 |
| ultra | 極致 | 2 | 4096 | 200 | 60 | 60 | 130 | 1300 |

- `resolveQuality(setting, { touch, urlQ })` → tier id：URL `?q=low|mid|high|ultra` 優先 → 設定值（非 auto）→ `auto`：`touch ? 'low' : 'high'`；非法值當 auto
- `qualityBudget(id)` → 上表該列副本 + `motorbikeShare: 0.4`；未知 id 當 high
- 人數 peds 40 / 80 / 140 / 200 為主控裁決（Phase 3 用戶要求路人多；原契約 30 / 60 / 90 / 120 已廢止）；**市民總數（骨架 + 遠景替身）≤ floor(peds × 1.05)**（traffic.js `crowdCap`：42 / 84 / 147 / 210），畫質降級後多的人逐步回收（約 3–4 s 壓回上限）；唯一臨時例外是搶車拖出的司機（下一次密度管理回收別人補回）
- 分層模擬：pedNear 內完整骨架動畫與碰撞；pedNear–pedFar 降頻 / 簡化、物理休眠；pedFar 外替身；倒地播動畫，不做全員布娃娃（細節見 §3.1）

### 3.1 行人分層（`src/crowd.js` `crowdPlan(budget)` → traffic.js）

| 層 | 範圍 | 表現 | 動畫（mixer） | 大腦 / 走路 | 物理 |
|---|---|---|---|---|---|
| 骨架 near | < pedNear | 完整骨架角色（characters glb） | 每幀 | 每幀；物理子步走路 | 剛體在 physicsRadius 內啟用 |
| 骨架 mid | pedNear–pedFar | 完整骨架角色 | 每 3 幀；視野外凍結 | 每 3 幀（累積 dt） | physicsRadius 外休眠 |
| 遠景替身 far | > pedFar | InstancedMesh 簡化人形（軀幹 / 腿 / 頭 3 draw calls、instanceColor），骨架回池 | 無 | 無大腦；每 6 幀以累積 dt 走路線 | 無剛體 |

- 分級遲滯 `CROWD_HYSTERESIS` 5 m（外移超過邊界 + 5 m 才降級、內移一過邊界就升級：pedNear 內一定是 near）；倒地 / 起身 / 還手 / 逃跑 / 走回路線 / 被玩家鎖定者強制 near
- 骨架池上限 `plan.poolMax` = pedFar 內預期人數 × 1.3（且 ≤ peds）：low 32 / mid 70 / high 131 / ultra 196；池滿時 pedFar 內也可能暫用替身，near 的人可借走最遠 mid、視野外、漫步中者的骨架；每幀取還 ≤ 6、新建 ≤ 2（near 不受限）
- **物理半徑** `plan.physicsRadius` = pedNear + `PHYSICS_PAD` 10 m（low 40 / mid 50 / high 60 / ultra 70）：半徑內的骨架行人剛體（膠囊，半徑 `PED_RADIUS` 0.3 m）啟用，超過半徑 + 15 m（npc-bodies `ACTIVE_HYSTERESIS`）休眠；倒地 / 起身中者保持啟用；traffic.sync 內自行處理（`traffic.pedBodies()` / `traffic.physicsRadius` 供自管）
- 密度：`plan.radius` = pedFar + 20 m 內維持 peds 人、`plan.recycle` = radius + 40 m 外回收；補生成只在視野外（視錐外或被建築遮擋）的 spawnMin–radius 環帶，另在 80 m 內維持 `innerTarget` = ceil(peds × (80 / radius)² × 1.15) 人（low 37 / mid 49 / high 61 / ultra 66）
- 除錯 / HUD 人數：`traffic.citizens.length`（總數 = 骨架 + 替身）、`traffic.peds.length`（骨架）、`traffic.impostors.count`（顯示中的替身）
- `src/mobile.js` 相容層：`qualityTier(setting?)` 內部呼叫 `resolveQuality`（仍回傳 `'low'|'mid'|'high'|'ultra'`，只判斷 `'low'` 的舊呼叫端照常）；`setQualitySetting(v)`；`pixelRatioFor(tier, dpr, scale)` = `min(dpr, dprCap) × scale`；`applyRendererQuality(renderer, scale, scene, tier?)` 依 shadowMap 關陰影或設定陰影貼圖邊長

### 3.2 HUD API（`src/hud.js`，整合層 main.js 呼叫）

版面（桌機 / 觸控橫向 / 觸控直向）全部在 style.css「HUD」段；hud.js 只切 class 與填文字，不寫死任何鍵位文字。

- `new HUD({ storage } = {})`：storage 預設為安全包裝的 localStorage（無痕 / node 時只存記憶體）
- `hud.update(dt, state)`：每幀；`state = { x, z, yaw, driving, speedKmh, location, time, fast, markers, money, hp, hpMax, vehicleLabel, roadName }`（新欄位可省略）
  - 右上時間 · 金錢（+/− 跳動）、左下圓形小地圖 + 地名 + 血條、右下駕駛時圓形時速錶 + 車名 + 路牌路名
  - 觸控裝置（body.touch）依 `state.driving` 切換觸控按鈕配置；提示文字「按 F …」改指向「上車 / 下車」鈕
- `hud.setMoney(money, delta)`、`hud.setHealth(hp, hpMax)`、`hud.setPrompt(text | null)`（中下互動提示膠囊）
- `hud.toast(text, seconds = 6)`：訊息 toast；以「📍 」開頭的進場地名 toast 與地名 pill 重複時不另外顯示
- `hud.showHint(id, text)` → boolean：左上新手提示卡，同 id 只出現一次（localStorage `tcgta.hints.seen`）；觸控駕駛中延到下車後才顯示
- `hud.setHintsEnabled(settings.get('showHints'))`、`hud.resetHints()`
- `hud.setControlsHint([{ keys, desc }])`：底部常駐按鍵提示，由 `KEYMAP_HELP` / `TOUCH_HELP` 產生後傳入；空陣列 / 非陣列 = 清空隱藏
- `hud.setFps(fps | null)`（null = 隱藏）、`hud.setUiScale(k)`（寫 CSS 變數 `--ui-scale` / `--tg-ui-scale`；HUD 用 `--hud-scale`，觸控或小螢幕 ≤ 1）、`hud.setVisible(v)`
- 另匯出 `HINTS_KEY`、`formatMoney(n)`（整數千分位）、`touchPromptText(text, driving)`
- `#attribution`（OpenStreetMap / ODbL）常駐角落，HUD 任何版面都不得覆蓋或移除

## 4. 輸入動作 `src/core/actions.js` 與 Input `src/input.js`

### 4.1 鍵位表（`ACTIONS`）

| action | 桌機 | 說明 | hold | 預留 |
|---|---|---|---|---|
| move | WASD / 方向鍵 | 走 / 轉向油門（類比軸，由 `Input.moveAxis` 提供） | ✓ | |
| sprint | ShiftLeft, ShiftRight | 衝刺（觸控：搖桿推到底 ≥ 0.9 或「跑」鈕） | ✓ | |
| jump | Space | 步行跳；駕駛時 = 手煞車（同鍵） | ✓ | |
| attack | Mouse0 | 攻擊（揮拳）；觸控攻擊鈕送 Mouse0 | | |
| aim | Mouse2 | 瞄準（無武器） | ✓ | ✓ |
| interact | KeyE | 互動（目前無互動物件） | | ✓ |
| enterExit | KeyF | 上下車 / 搶車 / 扶起翻覆車 | | |
| horn | KeyH | 喇叭（駕駛時） | ✓ | |
| camera | KeyV | 鏡頭距離三段循環 | | |
| lookBack | KeyC | 回頭看（按住，駕駛時） | ✓ | |
| radio | KeyQ | 電台 | | ✓ |
| phone | KeyT | 手機 | | ✓ |
| map | KeyM | 開暫停選單的「地圖」頁 | | |
| pause | Escape, KeyP | 暫停選單（P 在暫停中 = 繼續） | | |
| timeSkip | KeyN | 時間快轉 | | |
| reload | KeyR | 裝填（無武器） | | ✓ |

- 滾輪：步行時連續縮放鏡頭距離（無武器前保留）
- 同一 code 不綁兩個 action（Escape / KeyP 同屬 pause）

### 4.2 三個鍵位衝突的處理

| 舊鍵 | 舊功能 | 新功能 | 舊功能去處 |
|---|---|---|---|
| H | 操作說明收合 | 喇叭 | 暫停選單「操作說明」頁（由 `KEYMAP_HELP` / `TOUCH_HELP` 產生） |
| R | 翻車自救 | 預留裝填 | F 扶起（翻覆 ≥ 1.5 s 時 `vehicle.isOverturned()` 為真，按 F 呼叫 `vehicle.upright()`） |
| E | 揮拳 | 預留互動 | 攻擊改滑鼠左鍵 `Mouse0`（觸控攻擊鈕送 Mouse0） |

另取消：O 靈敏度循環（改設定頁連續滑桿）。

### 4.3 說明表

- `KEYMAP_HELP`：`[{ group: '步行'|'駕駛'|'通用', items: [{ keys: '顯示文字', action, desc }] }]`，桌機說明單一來源；涵蓋所有非預留 action，不列預留 action；`action: null` 為非動作的說明列（滑鼠轉視角、滾輪）
- `TOUCH_HELP`：同格式，觸控版；選單操作說明頁與 HUD 提示都由此產生
- `createActionReader(input)` → `{ down(action), pressed(action) }`：`input.down(code)` / `input.wasPressed(code)` 對該 action 的 keys 任一為真；未知 action 回 false

### 4.4 Input（`src/input.js`）

- 保留：`down(code)`、`wasPressed(code)`、`moveAxis()`、`consumeMouse()`、`endFrame()`、`touchPress(code, hold)`、`touchRelease(code)`、`setStick(x, y)`、`setTouchMode(mode)`、`resetTouch()`、`enabled`
- 滑鼠按鍵：canvas 上的 mousedown 記為 `Mouse0`（左）/ `Mouse2`（右），寫入 pressed + 按住；mouseup 放開；UI 元素上的點擊不算
- `setSensitivity({ mouse, touch })`：連續倍率 0.3–3.0（非法值維持原值）；`setInvertY(bool)`；由整合以 settings 驅動
  - 倍率 1.0：滑鼠 800 px ≈ 360°（`LOOK_RAD_PER_UNIT = 2π / 800`）；觸控拖半個螢幕寬 ≈ 180°
- `setPedals(throttle, brake)`：觸控踏板類比深度 0..1；駕駛模式下 `moveAxis().y = 鍵盤 W/S + throttle − brake`，x / y 各自 clamp ±1
- `snapshot()` → `{ move, look: { dx, dy }, wheel, down: { sprint, jump, attack, lookBack }, pressed: { attack, jump, interact, enterExit, horn, camera, map, pause, timeSkip } }`；**不清除**累積量（仍每幀 `consumeMouse()` + `endFrame()`）
- `enabled = false`（暫停 / 選單）：不吃任何輸入，並清空鍵盤、滑鼠、觸控按鈕、搖桿、踏板與累積量，通知觸控層釋放所有指標
- 相容：`SENS_LEVELS`、`onSensitivityChange()` 保留匯出（deprecated，後者不再觸發）；O 鍵循環與 `cycleSensitivity` 已移除

### 4.5 觸控（`src/touch.js`）

| 區域 / 按鈕 | id | 送出 | 模式 | 顯示 |
|---|---|---|---|---|
| 左半浮動搖桿 | `#touch-pad` | `setStick`（推到底 ≥ 0.9 = ShiftLeft 衝刺） | — | 一直 |
| 右半視角拖曳 / 雙指捏合 | `#touch-look` | `touchLook` / wheel | — | 步行 |
| 煞車 / 油門踏板 | `#pedal-brake` / `#pedal-gas` | `setPedals`（越下越深，最上 0.35） | — | 駕駛 |
| 跳 | `tb-jump` | Space | tap | 步行 |
| 跑 | `tb-run` | ShiftLeft | hold | 步行 |
| 上車 | `tb-enter` | KeyF | tap | 步行 |
| 攻擊（最大、紅） | `tb-attack` | Mouse0 | tap | 步行 |
| 下車 / 扶起 | `tb-exit` | KeyF | tap | 駕駛 |
| 手煞 | `tb-handbrake` | Space | hold | 駕駛 |
| 喇叭 | `tb-horn` | KeyH | hold | 駕駛 |
| 暫停（左上） | `tb-pause` | Escape | tap | 一直 |
| 地圖（左上） | `tb-map` | KeyM | tap | 一直 |
| 手機（左上，預留隱藏） | `tb-phone` | KeyT | tap | 隱藏 |

- 每個 pointerId 只綁一個控制，多指互不搶；`registerTouchButton(def)` 可擴充；已移除的 `tb-flip` / `tb-sens` / `tb-punch` / `tb-gas` / `tb-brake` 再註冊會被忽略（回 null）
- `setTouchMode('walk'|'drive')`（hud.js 依是否駕駛呼叫）、`getTouchMode()`

## 5. 第二波模組間轉接器

- **車流 traffic.js（C1）**
  - `traffic.carjackCandidates(x, z, maxDist)` → `[{ car, x, z, yaw, type, color, speed, driverVariant }]`（依距離排序；車速 > 6 m/s 不列）
  - `traffic.releaseCar(car)` → `{ type, color, x, y, z, yaw, vx, vz, driverVariant }`：自車流移除（剛體與網格釋放或回池），之後自行補車
  - `traffic.spawnEjectedDriver({ x, z, yaw, variant })` → ped：生成剛被拖出的司機（先播 knockdown，再依 NpcBrain 逃跑或還手）
  - 號誌：依 traffic-lights.js API 在停止線前停車
- **車輛 vehicle.js（A3）**
  - `vehicles.adopt({ type, color, x, y, z, yaw, vx, vz })` → Vehicle：在該位姿建立可駕駛車
  - `vehicle.honk()` → emit `vehicle:horn`；建構時注入 bus 與道路：`new VehicleManager(scene, parked, terrain, physics, { bus, roads: surfaceRoads })`
  - 掉出世界回收：每個物理子步檢查動態車輪底 y < 地面 − 20 m（`FALL_OUT_DEPTH`）→ 玩家駕駛中的車重置到最近道路（右側車道、直立、速度歸零、仍在駕駛），無人車重置後停放；emit `vehicle:recovered`；也可手動 `vehicles.recover(v)`
  - 機車倒地滑行：倒地後世界座標水平速度以 8 m/s² + 2/s 阻尼減速（76 km/h 約 0.9 s、6.6 m 停下）、角速度衰減、底盤摩擦 1.2，不會倒退加速
  - `vehicle.setPowerScale(k)`（0–1；0 = 熄火）
  - `vehicle.isOverturned()`（汽車翻覆 / 機車倒地持續 ≥ 1.5 s）、`vehicle.upright()`（原 `flip()`，flip 保留別名）
  - Vehicle 既有欄位：`pos`、`yaw`、`speed`、`spec`（`label`、`twoWheeler`、`mass`、`length`、`width`、`height`、`camScale`）、`mesh`、`driven`、`body`
- **行人 npc-ai.js（C2）**：`brain.hear({ type: 'horn', x, z, dirX, dirZ })` → 前方 15 m、±40° 內行人閃避或走開；traffic.js 訂閱 `vehicle:horn` 後呼叫附近行人的 `brain.hear`
- **鏡頭 camera.js（A1）**：`rig.update(dt, input, focus, opts)`，opts 新增 `cycleView`（本幀按 V）、`lookBack`（按住 C）、`twoWheeler`；仰角範圍須能看到樓頂，不可收窄

## 6. 存檔 `src/save.js`（B2）

- 儲存鍵 `tcgta.save`；備份 `tcgta.save.bak`（上一份讀回驗證通過的存檔）；損毀原文 `tcgta.save.corrupt`（只留最後一份）
- `SAVE_VERSION = 1`；`defaultSave()`：

```
{ version: 1, savedAt: 0, money: 500,
  stats: { playTimeSec: 0, distWalkM: 0, distDriveM: 0, pedsHit: 0, pedsKnockedOut: 0,
           carjacks: 0, crashes: 0, kos: 0, moneyEarned: 0, moneySpent: 0 },
  player: { x: null, z: null, yaw: 0 },
  world: { hour: 16.5 } }
```

- `validateSave(obj)` → 清洗後物件或 null（數值 finite 且 ≥ 0、未知鍵丟棄、缺鍵補預設）
- `migrate(obj)`：version < SAVE_VERSION 走遷移骨架；version > SAVE_VERSION → null（不覆寫）
- `createSaveStore({ storage, key = 'tcgta.save', now })` → `{ load() → { data, status: 'new'|'ok'|'recovered'|'corrupt-reset' }, save(data) → boolean, clear(), hasSave() }`
- `createAutosave({ store, getState, intervalSec = 15 })` → `{ tick(dt), flush(reason) }`
- 設定不在存檔內（由 core/settings 自己存）

## 7. 經濟與統計 `src/economy.js`（B2）

- `createEconomy({ bus, initial })`（initial = 存檔的 `{ money, stats }`）→ `{ get money(), stats, add(n, reason), spend(n, reason) → boolean, addDistance('walk'|'drive', m), addPlayTime(dt), snapshot(), dispose() }`
- 訂閱：`ped:knockdown`（byPlayer）→ 'vehicle' 記 pedsHit、'punch' 記 pedsKnockedOut 並掉落 NT$10–40（reason 'loot'）；`vehicle:carjacked` → carjacks；`vehicle:crash` → crashes；`player:ko` → kos 並扣醫藥費 NT$100（不低於 0，reason 'hospital'）
- 金錢變動一律 emit `player:money`；起始 NT$500
- 不做通緝、任務、捷運

## 8. 選單 `src/ui/**`（B1）

- `createMenu({ root, settings, bus, keymapHelp, touchHelp, isTouch, attribution, getStats, getMoney, hasSave, mapView })` → `{ showStart({ canContinue }), hideStart(), openPause(tab?), close(), isOpen(), destroy() }`
- class / id 一律 `tg-` 前綴；CSS 只寫在 `src/ui/menu.css`；z-index 70–79（HUD 最高 60）
- 地圖授權標示（OpenStreetMap / ODbL）：遊戲中的 `#attribution` 常駐角落不可被擋或移除；選單內頁尾另顯示一份
- 不用 alert / confirm（回主選單確認用選單內對話框）
- `src/ui/map-view.js`：`createMapView({ getPlayer })` → `{ el, open(), close(), draw() }`：citymodel 的 roads / buildings / parks 畫 2D 大地圖，拖曳平移、+/- 縮放、「回到自己」

## 9. 號誌、群眾 LOD、搶車 / 耐久

- 號誌 `src/traffic-lights.js`（C1）、群眾 LOD `src/crowd.js`（C2）、搶車 `src/carjack.js` / 耐久 `src/vehicle-damage.js`（C3）：API 以各檔檔頭註解與對應單元 task 為準；對外事件一律走 §1 的表

## 手機注意事項（跨單元）

- 觸控、全螢幕、橫直向都可玩（直向只顯示一次性提示）、safe-area（`env(safe-area-inset-*)`）
- 觸控按鈕 ≥ 44 px；主角 hero.glb 身高讀 manifest

---

## 附錄 A：P3-0 接線說明（整合單元照做）

### main.js

1. `import { bus } from './core/events.js'`、`import { settings } from './core/settings.js'`、`import { KEYMAP_HELP, TOUCH_HELP } from './core/actions.js'`、`import { qualityBudget } from './core/quality.js'`
2. 建立 renderer 前：`setQualitySetting(settings.get('quality'))`；之後 `const tier = qualityTier(); const budget = qualityBudget(tier);`，把 `budget.peds / cars / pedNear / pedFar / viewDist / motorbikeShare` 傳給 traffic / crowd / camera far；`applyRendererQuality(renderer, 1, scene, tier)`、`createAdaptiveResolution(renderer, tier)`
3. 建立 Input 後：`input.setSensitivity({ mouse: settings.get('lookSensMouse'), touch: settings.get('lookSensTouch') }); input.setInvertY(settings.get('invertY'));`，並 `settings.subscribe((k, v) => { if (k === 'lookSensMouse') input.setSensitivity({ mouse: v }); else if (k === 'lookSensTouch') input.setSensitivity({ touch: v }); else if (k === 'invertY') input.setInvertY(v); else if (k === 'quality') { setQualitySetting(v); /* 重設 pixelRatio / 陰影；人車數下次載入生效 */ } })`
4. 刪除 `registerTouchButton({ id: 'tb-flip' … })` 與 `registerTouchButton({ id: 'tb-punch' … })` 兩行（已被忽略，只是清掉死碼）；`FLIP_KEY` / `ATTACK_KEY` 常數改讀 action
5. 每幀讀 `const snap = input.snapshot();`（之後照舊 `consumeMouse()` + `endFrame()`）：
   - `snap.pressed.attack` → `player.punch()`（取代 `KeyE` 與 `mousePunchListener`，觸控攻擊鈕也送 Mouse0）
   - `snap.pressed.enterExit` → 上 / 下車 / 搶車；駕駛中 `vehicle.isOverturned()` 為真時改呼叫 `vehicle.upright()`（取代 R 翻車）
   - `snap.pressed.horn`（或 `input.down('KeyH')` 持續按）→ `vehicle.honk()`；**刪除** `if (input.wasPressed('KeyH')) hud.toggleHelp()`
   - `snap.pressed.pause` → 選單 `openPause()`；`snap.pressed.map` → `openPause('map')`；`snap.pressed.camera` / `snap.down.lookBack` → `rig.update(..., { cycleView, lookBack, twoWheeler })`；`snap.pressed.timeSkip` → 原 KeyN
6. 選單開啟 / 暫停：`input.enabled = false`（會自動清空按住狀態並釋放觸控）；繼續：`input.enabled = true`
7. `bus.on('game:start', () => setGameActive(true))`、`bus.on('game:pause', ({ paused }) => setGameActive(!paused))`、`bus.on('game:quitToMenu', () => setGameActive(false))`（`setGameActive` 由 mobile.js 匯出；請在按鈕 click 的同一手勢內 emit，影片後備才能播放）
8. `createMenu({ …, settings, bus, keymapHelp: KEYMAP_HELP, touchHelp: TOUCH_HELP, isTouch: isTouch() })`

### hud.js

- 刪除 `onSensitivityChange` 訂閱與 `SENS_TOAST_SEC` / `SENS_KIND_LABEL`（匯出保留但不再觸發）
- 右上操作說明（`#help`，原 H 收合）改由 `KEYMAP_HELP` / `TOUCH_HELP` 產生或移到選單；`setTouchMode` 照舊每幀呼叫；`tb-enter` 的 `.ready` 照舊

### index.html

- `#rotate-mask` 文字改為「建議橫向遊玩」之類的提示語（mobile.js 會自動在其中加「仍用直向遊玩」按鈕 `#portrait-ok`，並以行內 style 控制顯示）
- 移除開始畫面 / HUD 中提到 H 說明、O 靈敏度、E 揮拳、R 翻車的文字

### style.css（新增規則；全部限定 body.touch，桌機不變）

```
/* 左上三顆小鈕：排在小地圖（120px）右側，≥ 44px */
.tbtn.slot-tl1, .tbtn.slot-tl2, .tbtn.slot-tl3 {
  top: calc(12px + env(safe-area-inset-top));
  width: 48px; height: 48px; font-size: 13px;
}
.tbtn.slot-tl1 { left: calc(140px + env(safe-area-inset-left)); }
.tbtn.slot-tl2 { left: calc(196px + env(safe-area-inset-left)); }
.tbtn.slot-tl3 { left: calc(252px + env(safe-area-inset-left)); }
.tbtn[hidden] { display: none; }

/* 駕駛踏板：右半區兩大塊，步行隱藏；駕駛時隱藏視角區 */
#touch-pedals {
  position: absolute; right: 0; top: 0; width: 50%; height: 100%;
  display: none; gap: 12px; box-sizing: border-box;
  padding: calc(84px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) 12px;
}
body.touch-drive #touch-pedals { display: flex; }
body.touch-drive #touch-look { display: none; }
.tpedal {
  position: relative; flex: 1; min-width: 44px; overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.45); border-radius: 18px;
  background: rgba(0, 0, 0, 0.25); touch-action: none;
}
#pedal-brake { border-color: rgba(255, 110, 90, 0.7); }
#pedal-gas { border-color: rgba(120, 230, 120, 0.7); }
.tpedal-fill { position: absolute; left: 0; right: 0; top: 0; height: 0; background: rgba(255, 255, 255, 0.22); }
.tpedal-label { position: absolute; left: 0; right: 0; bottom: 12px; text-align: center; font-weight: bold; color: #fff; pointer-events: none; }
.tpedal.active { background: rgba(255, 255, 255, 0.12); }

/* 直向提示按鈕 */
#portrait-ok {
  min-height: 44px; padding: 0 20px; border-radius: 22px;
  border: 2px solid #fff; background: transparent; color: #fff; font: inherit;
}
```

- 駕駛時 `tb-exit`（sec2）、`tb-handbrake`（sec3）、`tb-horn`（top1）疊在踏板上方（`.tbtn` z-index 2 已高於踏板），按鈕會 capture 自己的指標，不會誤踩踏板
- 直向時 `#touch-pad` / `#touch-pedals` 仍各占一半寬；搖桿基準點 `left: 110px` 在窄螢幕仍可用，實機若擠可改 `left: 25%`
- 可刪除：`@media (orientation: portrait) { body.touch.playing #rotate-mask { display: flex } }`（已由 mobile.js 行內控制，留著也無害）
- `#attribution`（OSM / ODbL）位置不動；左上小鈕與踏板都不覆蓋左下角

---

## 變更流程

**改介面先改本檔，再改程式。** 流程：

1. 在本檔修改對應章節（新事件加進 §1 表、新設定鍵加進 §2 表、新 action 加進 §4.1 表…）
2. 通知相關單元（在 result 的 FINDINGS 註明）
3. 再改程式與測試（`tools/test/core.mjs` 會檢查 action 表與說明表的一致性）
