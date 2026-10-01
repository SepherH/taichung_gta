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
| ~~radio~~ | — | 已移除（Q 改 weaponCycle，見 §12） | | |
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
- `SAVE_VERSION = 1`（Phase 4 起為 2，見 §18）；`defaultSave()`：

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

---

# Phase 4 契約（D4-0 定稿 v2，2026-10-01）

原則沿用上文（參數注入、不硬 import 他人內部、共用樞紐只有整合單元改）。新增一條：**功能模組自帶 UI**——武器 HUD / 任務 UI / 大地圖 / 圖鑑各自在自己的目錄建 DOM 與 CSS（class / id 用各自前綴，CSS 由模組 `import './xxx.css'`），hud.js / style.css 只做最小接線。z-index：HUD 模組 50–59、全螢幕面板（大地圖 / 圖鑑 / 結算）80–89（高於選單 70–79 的面板只在遊戲中開啟）。
**美術資產一律可能缺檔**：manifest / glb / 圖片 404 或回退成 index.html → 安靜退回（佔位幾何 / 純色卡片 / 既有 clip），只 `console.info` 一次，不得 `console.error` 或丟例外。

## 10. 事件（§1 表的增補；payload 欄位可多不可少）

| 事件 | payload | 發出者 |
|---|---|---|
| `weapon:equip` | `{ slot: 0\|1\|2, weapon: 'fist'\|'bat'\|'pistol', prev }` | weapons |
| `weapon:swing` | `{ weapon: 'fist'\|'bat', x, y, z, byPlayer }` | weapons |
| `weapon:fire` | `{ weapon: 'pistol', x, y, z, dirX, dirY, dirZ, byPlayer, hit: boolean }` | weapons |
| `weapon:dryFire` | `{ weapon }` | weapons |
| `weapon:reload` | `{ weapon, phase: 'start'\|'end', mag, reserve }` | weapons |
| `weapon:ammo` | `{ weapon, mag, magSize, reserve }` | weapons（任何彈藥變動） |
| `weapon:impact` | `{ x, y, z, nx, ny, nz, surface: 'world'\|'vehicle' }` | weapons（子彈打到非角色） |
| `combat:hit` | `{ attacker, target, weapon: 'fist'\|'bat'\|'pistol'\|'vehicle', damage, hp, x, y, z, dirX, dirZ, side: 'front'\|'back', byPlayer, knockdown: boolean }` | 整合（由 combat 'hit' 轉發） |
| `ped:knockdown` | §1 原欄位，`cause` 擴充為 `'punch'\|'bat'\|'bullet'\|'vehicle'`，另加 `weapon` | 整合 |
| `pickup:ammo` | `{ amount, x, z }` | weapons/pickups |
| `mission:available` | `{ id, title, x, z }` | missions |
| `mission:start` | `{ id, title, cargo }` | missions |
| `mission:stage` | `{ id, stage: 'pickup'\|'deliver', text, x, z }` | missions |
| `mission:complete` | `{ id, reward, timeSec, damagePct, bonus }` | missions |
| `mission:fail` | `{ id, reason: 'timeout'\|'destroyed'\|'ko'\|'abandon' }` | missions |
| `nav:destination` | `{ x, z, label, source: 'map'\|'mission'\|'checkin' }` | map / missions |
| `nav:clear` | `{ source }` | map / navigation（抵達 20 m 內自動清） |
| `collect:checkin` | `{ landmarkId, slug, name, reward }` | collect |
| `collect:food` | `{ id, name, total, found }` | collect |
| `ui:sound` | `{ kind: 'click'\|'confirm'\|'cancel'\|'reward'\|'fail'\|'open'\|'close' }` | 任何 UI |

`combat:hit.side`：目標面向 · (攻擊者 → 目標方向) > 0 = 被從背後打 → `'back'`，否則 `'front'`。

## 11. 設定鍵增補（§2 表）

| 鍵 | 型別 / 範圍 | 預設 |
|---|---|---|
| `showBlood` | boolean（「顯示血液」） | true |
| `recoil` | number 0.2–1.0（step 0.1，「後座力」） | 1.0 |
| `aimAssist` | boolean（「瞄準輔助」，只作用於觸控） | true |

`volumeSfx` 的 note「音效將於後續版本加入」移除。三組音量 `volumeMaster / volumeMusic / volumeSfx` 由 audio 訂閱。

## 12. 動作與輸入增補（§4）

| action | 桌機 | 說明 | hold |
|---|---|---|---|
| attack | Mouse0 | 攻擊（依目前武器：揮拳 / 揮棒 / 開槍） | 手槍可按住連發（半自動，最短間隔由武器定） |
| aim | Mouse2 | 肩後瞄準（持手槍時；**取消預留**） | ✓ |
| interact | KeyE | 互動：接委託 / 打卡 / 收集小吃 / 撿彈藥（**取消預留**） | |
| weaponCycle | KeyQ | 循環切換武器（取代 radio；radio 移除） | |
| slot1 / slot2 / slot3 | Digit1 / Digit2 / Digit3 | 直選 空手 / 球棒 / 手槍 | |
| reload | KeyR | 裝填（**取消預留**） | |
| map | KeyM | 開 / 關大地圖（不再開暫停選單地圖頁；暫停選單地圖頁保留） | |

- `input.snapshot()`：`down` 增 `aim`、`attack`；`pressed` 增 `slot1`、`slot2`、`slot3`、`weaponCycle`、`reload`（`interact` 已有）
- 滾輪：持手槍瞄準中不縮放（整合層判斷）；其餘照舊
- 觸控新增（touch.js `registerTouchButton` 或武器模組自建）：`tb-weapon`（武器鈕：點擊 = weaponCycle；長按 ≥ 350 ms 開三格輪盤，滑到格子放開 = 直選）、`tb-reload`（持手槍才顯示）、`tb-aim`（持手槍才顯示，hold = 肩後瞄準）、`tb-interact`（有互動提示才顯示，送 KeyE）；步行模式顯示，駕駛隱藏；按鈕 ≥ 44 px
- 武器切換只在「待機或攻擊收尾」允許：`weapons.canSwitch()` 為假時切換請求被忽略（不排隊）

## 13. 武器 `src/weapons/**`（W1）

- 定義 `WEAPONS`（src/weapons/defs.js）：`fist`（沿用 combat 拳擊）、`bat`（傷害 35、冷卻 0.75 s、命中窗讀 clip `bat_swing_a/b` 的 manifest events，缺則 [0.3, 0.55]×長度、揮擊交替 a / b）、`pistol`（傷害 40、彈匣 12、起始備彈 36、備彈上限 120、射速最短 0.22 s、裝填 1.4 s、射程 80 m）；數值常數匯出供測試
- `createWeapons({ bus, combat, player, raycast, sweep, settings, now, isTouch })` → 
  `{ current, slot, state: 'idle'|'equipping'|'attacking'|'reloading', canSwitch(), select(slot), cycle(), attack(aim), reload(), update(dt, aim), ammo() → { mag, magSize, reserve }, addAmmo(n), serialize(), restore(data), dispose() }`
  - `aim = { origin:{x,y,z}, dir:{x,y,z}, aiming: boolean, muzzle?:{x,y,z}, candidates?: actor[] }`（整合層每幀以鏡頭中心射線填入）
  - 注入 `raycast(origin, dir, maxDist, { excludeActor }) → { point, normal, actor|null, surface } | null`、`sweep(from, to, radius, { excludeActor }) → actor[]`（整合層以 PhysicsWorld.castRay / castShape + 剛體 → actor 對照實作；測試用假物件）
  - 手槍：鏡頭射線取瞄點 → 槍口到瞄點再射一次確認遮擋（被擋則打在遮擋物）；觸控且 `aimAssist` 時對視野內無遮擋、與射線夾角 ≤ 6°、≤ 40 m 的行人弱吸附（只修正方向不鎖定）；後座 = `recoilKick()` 回傳的鏡頭 pitch / yaw 增量 × settings.recoil
  - 球棒：命中窗開啟期間每幀以前後幀棒身端點做膠囊掃掠（`sweep`），同一揮對同一人只傷一次（combat 去重）
  - NPC 中彈 / 被棒擊：走 combat 公開 API（下條），不直接改 combat.entries
- `src/combat.js` 增：`applyHit({ attacker, target, damage, weapon, dir:{x,z}, impulse? })`（通用受擊入口：扣血、連擊計數、hit / knockdown、hitStop、emit 'hit' 含 `weapon`、`side`、`x,y,z`）與 `knockdownActor(actor, { cause, impulse })`（取代外部直接改 entries 的做法）；`anim.trigger('hit', { side })`（animator 不認第二參數時自然退回 'hit'）；'knockdown' payload `cause` 加 `'bat'|'bullet'`；拳擊路徑行為不變
- `src/npc-ai.js`：`brain.hear({ type: 'gunshot', x, z })` → 30 m 內行人逃跑（不還手）；被槍擊者一律逃跑或倒地，不還手；被棒擊者照一般被打（還手比例不變）
- 鏡頭 `src/camera.js`：`rig.update(…, opts)` 增 `aim: boolean`（肩後：距離 1.6 m、右肩偏移 0.45 m、FOV 55、切換 0.15 s 內插）與 `rig.addRecoil(pitch, yaw)`（衰減回原位）；仰角範圍不得收窄
- 武器模型：`loadWeaponModels(base = 'models/weapons/')` 讀 `manifest.json`（`{ bat:{ file, gripOffset:[x,y,z], tipOffset:[x,y,z], length, type }, pistol:{…, muzzleOffset? } }`，也接受陣列形式）；缺檔 → 佔位幾何（棒 0.85 m 圓柱、槍 L 形方塊），同樣提供 grip / tip / muzzle
- 彈藥拾取 `createAmmoPickups({ scene, bus, points, amount = 12, respawnSec = 90 })` → `{ update(dt, playerPos), nearest(pos) → interactable|null, dispose() }`；接近 1.5 m 自動拾取（不必按 E）
- 武器 HUD（src/weapons/hud.js + weapons.css，前綴 `wp-`）：右上武器圖示（`art/hud/weapon-<id>.png`，缺則文字）+ 彈藥 `12 / 36`、裝填進度、準星（持手槍顯示，瞄準時收窄）、觸控武器鈕與輪盤（`tb-weapon` 自建於 `#touch-ui` 內）

## 14. 動畫層與流血（W3）

- 角色 manifest 增補（A7，可能缺）：`clips[].upperBodyOnly`、`clips[].loop`、`boneGroups: { upper: [...], lower: [...] }`、`weaponSocket`（實檔為物件 `{ bone, parent, axes, notes }`，也接受字串；右手子骨）；缺 `boneGroups` 時預設 upper = Spine, Chest, Neck, Head, 兩側 Shoulder / UpperArm / LowerArm / Hand
- `src/characters/animator.js`：`trigger('hit', { side })` → 有 `hit_front` / `hit_back` 用之，缺則 `hit`；新狀態 clip 缺時以既有 clip 代替（`bat_swing_*` / `pistol_fire` → `punch`、`*_hold` / `pistol_aim` → 不疊加、`weapon_equip` → 略過），`missing` 記錄
- `src/character-animation.js`：`createWeaponLayer(animator, { boneGroups })` → `{ setPose('none'|'bat_hold'|'pistol_hold'|'pistol_aim'), play('weapon_equip'|'bat_swing_a'|'bat_swing_b'|'pistol_fire'|'pistol_reload') → duration|false, addRecoil(k), update(dt), on('hitWindow', cb) }`：上半身 clip 以 boneGroups.upper 過濾軌道後疊在下半身移動上；後座為 additive 層；`attachWeapon(character, object3d, { gripOffset })` 掛到 `weapon_socket`，缺則右手 `RightHand` 骨
- `src/blood-fx.js`：`createBloodFx({ scene, settings, heightAt, atlasUrl = 'art/fx/blood-atlas.png', dropUrl = 'art/fx/blood-drop.png', maxDecals = 16, maxDrops = 32 })` → `{ onHit(e), onKnockdown(e), update(dt, camera), clear(), stats() → { decals, drops } }`；地面貼片（4×4 圖集、物件池、全場 ≤ 16、12 s 後 2 s 淡出、最舊者先回收）、血滴粒子（單一 InstancedMesh 或 Points、同屏 ≤ 32、無碰撞、落地即消失）；`settings.showBlood` 為 false 時不生成且清空；圖集缺 → 程序畫 CanvasTexture；不做肢解與傷口特寫；每幀不配置新物件
- 內容標示（開始畫面）：文字「本遊戲含槍械、暴力與血液畫面」由選單顯示（I4）

## 15. 音效 `src/audio/**`（W2）

- `createAudio({ bus, settings, AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext })` → `{ unlock(), update(dt, state), play(name, opts), stats() → { voices, maxVoices: 12, unlocked }, dispose() }`
  - 首次 pointerdown / keydown / touchend 由整合層呼叫 `unlock()`（resume context）；未解鎖前 play 靜默略過；無 AudioContext（node）時整個模組為 no-op
  - 程序合成（噪聲 buffer + 振盪器 + 濾波 + 包絡），不下載音檔：`gunshot`、`dryfire`、`ricochet`（跳彈 / 擊中，依 surface world / vehicle 分音色）、`reload`、`bat_hit`、`bat_swing`、`punch`、`footstep`、`crash`、`horn`、`tire`、`ui_*`、引擎（持續音源，依轉速）、路口聲景（持續、低音量）
  - 同時音源 ≤ 12（超過時丟棄最舊或最小聲者）；一次性音效 3D 衰減以 `state.x/z` 為聆聽點
  - 訂閱：`weapon:fire / dryFire / reload / swing / impact`、`combat:hit`、`vehicle:horn`、`vehicle:crash`、`mission:complete / fail`、`collect:*`、`ui:sound`；`settings.subscribe` 的三組音量（master × music / sfx）；`weapon:impact` → `ricochet`（帶 x/z 做 3D 定位、走 sfx 群組與音源上限）
  - `state = { x, z, yaw, driving, speedKmh, rpm01, throttle, skid01, walkSpeed, grounded, nearJunction: 距離 m|null, paused }`；footstep 依 walkSpeed 與步距自行觸發；paused 時持續音源靜音

## 16. 任務：資料驅動委託（W4，src/missions/**）

- 委託資料 `public/art/cargo/manifest.json`（美術線產出，可能缺）：`{ items: [ { slug, name, file, title, brief, client, from, to, timeLimitSec, reward, conditions: ['fragile'|'heavy'|'timed'] } ] }`（也接受頂層陣列；`from` / `to` 為地標 manifest 的 `id` 或 slug（檔名去 .glb））；缺檔 → 內建 3 個委託；圖卡 `art/cargo/<file>` 缺 → 純色卡片
- 地標點由整合層注入：`landmarks = [{ id, slug, name, x, z, radius }]`（§17）
- `createMissions({ bus, scene, root, landmarks, addMoney, fetchJson, now, rng })` → `{ ready: Promise, update(dt, ctx), nearest(pos) → interactable|null, markers() → [{ x, z, kind: 'mission-start'|'mission-dest', label }], objective() → { text, timerSec|null, distM|null, damagePct|null }|null, onVehicleImpact({ relSpeed }), onPlayerKo(), active(), serialize(), restore(data), dispose() }`
  - 流程：起點地標光柱（`mission-start`）→ 按 E 接單（顯示貨物圖卡 + 文案 + 條件 + 報酬，確認 / 取消）→ 目的地光柱 + `nav:destination` → 抵達 8 m 內（步行或駕駛）結算 → 結算面板（時間、損壞度、報酬、「再挑戰」/「繼續」）
  - 條件：`timed` 超時失敗；`fragile` 以 `onVehicleImpact` 與玩家被擊倒累積損壞度，100% 失敗，報酬依損壞度遞減；`heavy` 步行速度上限 × 0.6（回傳於 `ctx` 回饋：`speedScale()`）
  - 失敗可重試（回起點重接）；輪替：同時開放 3 個起點、完成後該委託冷卻 120 s 遊戲時間
  - 自帶 UI（前綴 `ms-`）：目標列（上中）、字幕、接單卡、結算面板
- 存檔（§18）`missions`

## 17. 大地圖與導航（W5）/ 打卡圖鑑（W6）/ 地標點

- 地標點 `src/core/landmark-points.js`（D4-0）：`landmarkPoints(manifestList, project = projectLatLon)` → `[{ id, slug, name, x, z, radius }]`（slug = file 去 .glb；radius = 25 m 預設，footprint false 者 15 m）；純函式
- 導航 `src/navigation.js`：`buildRoadGraph(roads)`（citymodel surfaceRoads → 節點 / 邊，端點吸附 1 m、交叉點合併）→ graph；`findRoute(graph, from, to)` → `{ points:[{x,z}], lengthM } | null`（A*，起訖投影到最近邊）；`createNavigator({ bus, graph, scene })` → `{ setDestination(x, z, label, source), clear(source), update(dt, playerPos), route() → points|null, destination() }`：偏離路線 > 25 m 或每 3 s 重算一次、抵達 20 m 內清除並 emit `nav:clear`；世界內導航圖釘（目的地上方浮動錐體）
- 大地圖 `src/map/**`（前綴 `mp-`）：`createBigMap({ root, getPlayer, getMarkers, getRoute, onPick, bus })` → `{ open(), close(), toggle(), isOpen(), draw(), destroy() }`：canvas 全螢幕、OSM 路網 / 公園 / 水域 / 地標、圖例、滾輪 / 雙指縮放、拖曳、點擊空白處設目的地（`onPick(x,z)` → 整合層呼叫 navigator）、路線與任務 / 打卡 / 小吃標記；可 import `src/ui/map-view.js` 的匯出函式
- 小地圖：hud.update 的 `state.route`（`[{x,z}]` 或 null）與 `state.markers` 增 `kind`（`'mission-start'|'mission-dest'|'dest'|'checkin'|'food'|'ammo'`）；hud.js 依 kind 著色、route 畫線（I4）
- 打卡 `src/collect/**`（前綴 `cl-`）：`createCheckins({ bus, landmarks, addMoney, reward = 200, badgeBase = 'art/badges/' })` → `{ nearest(pos) → interactable|null, markers(), progress() → { done, total }, serialize(), restore(data) }`；進入地標 radius 內可按 E 打卡（每地標一次、徽章彈窗 + 金錢）；徽章 `art/badges/<slug>.png` 缺 → 純色圓徽
- 小吃圖鑑：`createFoodGuide({ bus, scene, root, manifestUrl = 'art/food/manifest.json', spots, fetchJson, addMoney })` → `{ ready, nearest(pos), markers(), open(), close(), isOpen(), progress(), serialize(), restore(data), update(dt, playerPos, camera) }`；food manifest `{ items:[{ id, name, file, desc, area? }] }`（缺 → 內建 10 項名稱與說明、純色卡片）；收集點（`src/collect/food-spots.js`，10–12 點散在七期街區人行道，座標為遊戲世界 x/z）顯示小型浮動圖示，按 E 收集，圖鑑面板列已收集卡 + 未收集剪影
- **互動介面（interactable）**：`{ id, text, dist, priority, act() }`；整合層每幀向 missions / checkins / food / pickups 各問 `nearest(playerPos)`，取 priority 高者（任務 3 > 打卡 2 > 小吃 1），相同取近者 → `hud.setPrompt(text)`，按 E 呼叫 `act()`

## 18. 存檔 schema v2（src/save.js）

- `SAVE_VERSION = 2`；`defaultSave()` 在 v1 欄位外新增：
```
weapons: { slot: 0, ammo: { pistol: { mag: 12, reserve: 36 } } },
missions: { completed: {}, best: {}, cooldowns: {}, active: null },   // completed/best/cooldowns：slug → 整數 / 秒 / 遊戲秒數
collect: { checkins: [], foods: [] },                                  // 地標 slug / 小吃 id 字串陣列（去重）
stats 增：missionsDone: 0, missionsFailed: 0, shotsFired: 0
```
- `migrate(v1)` → v2：補上述預設、保留 v1 所有值；`version > 2` → null（不覆寫）
- `validateSave`：weapons.slot ∈ {0,1,2}；彈藥非負整數且 mag ≤ 12、reserve ≤ 120；completed / best / cooldowns 只收字串鍵 → 非負有限數；checkins / foods 只收字串、去重、上限 200；`missions.active` 只收 `{ slug, stage }` 或 null（讀檔時整合層可選擇作廢進行中的任務）
- 經濟：任務報酬 `economy.add(n, 'mission')`、打卡 `economy.add(n, 'checkin')`（reason 字串，§7 無需改碼）

## 19. 效能預算（手機 low 檔）

render + 物理 + 更新 < 8 ms（`__game.perf()`）；血跡 ≤ 16、血滴 ≤ 32、同時音源 ≤ 12；大地圖開啟時暫停 3D 渲染或降頻；各模組 update 不得每幀配置新物件（重用暫存）

## 20. 時間步契約（p5-c1；`src/physics/world.js` FixedStepper、`src/core/loop.js`）

兩種時間，不得混用：

| 名稱 | 來源 | 用途 |
|---|---|---|
| 模擬時間（固定子步 `step` = 1/60 s） | `PhysicsWorld.step(frameDt)` 內 FixedStepper 每個子步呼叫 `onBeforeStep(dt)` / `onAfterStep(dt)`，`dt` 恆為 `step` | 會影響遊戲結果的狀態 |
| 本幀模擬秒數 `simDt` | `pw.step()` 回傳的 `simDt`（= 子步數 × step）；物理 step **之前**要用時取 `pw.simTimeFor(frameDt)`（純查詢，同一幀內與實際推進值相同；暫停中 0） | 每幀呼叫、但推進的是模擬狀態的地方 |
| 渲染時間 `dt` | rAF 幀間隔，`core/loop.js` 夾到 `MAX_FRAME_DT` = 0.1 s | 只做插值、動畫 mixer、相機、UI / HUD、音效、特效粒子 |

- **屬模擬時間**（只在固定子步推進，或每幀以 `simDt` 推進）：剛體 / 角色膠囊 / 車輛控制器（子步內）；車流車道邏輯與行人位置、擊退（traffic `_step` / traffic-peds `stepPeds`、`afterStepPeds`）；mid 級與替身行人的降頻走路、行人大腦 `brain.update` 的累積秒數（`thinkPeds(simDt)`，`simDt` 由 traffic `_step` 在子步內累加、`sync` 取走）；自建 combat 時鐘與密度管理計時（traffic.sync）；遊戲對抗時鐘 `gameTime` 與 `combat.update`、號誌相位 `lights.update`、玩家 KO 倒數、搶來 / 報廢車回收計時（main.js / loop.js）
- **屬渲染時間**：`InterpolatedBody.interpolate(alpha)` 擺網格、`anim.update` / 輪子 `animate`、`rig.update`、`hud` / `whud`、`audio.update`、`blood.update`、煙霧粒子、FPS、自適應解析度
- **遊戲時鐘（目前用渲染 dt，可接受）**：日夜 `dayNight.update`、任務 elapsed、自動存檔、遊玩 / 步行秒數、導航重算、補給重生；不影響物理狀態，差異只在累加器餘量（< 1 子步）與卡頓丟棄的時間
- **速度一律 = 推進距離 ÷ 實際推進的模擬秒數**：例 行人動畫速度 = `moveD / moveT`（`moveT` 只在子步或降頻走路時累加）；某幀沒有推進（`moveT` = 0）就沿用上次速度。禁止「當幀位移 ÷ 渲染幀時間」——高於 60 Hz 時約半數幀沒有子步，會得到 0 / 加倍的速度
- **上限**：渲染 `dt` ≤ `MAX_FRAME_DT` 0.1 s；單幀子步 ≤ `DEFAULT_MAX_SUBSTEPS` 5（= 0.083 s 模擬時間），超過即丟棄累加器餘量（`stepper.dropped` 累計）——卡頓時模擬時間會少於渲染時間，所以模擬計時必須吃 `simDt` 而不是 `dt`
- **60 Hz 等價**：`dt` 恰為 1/60 時每幀恰 1 子步，`simDt === dt`；本契約不改 60 Hz 下的結果
- **更新順序**（`core/loop.js`）：tick = 自適應解析度 → 世界更新（暫停時略過；遊戲中 `updateGame`、開始畫面 `updateAttract`）→ 音效 → 渲染 → 效能統計 → FPS → `input.endFrame()`；物理一幀 `createWorldStep().step(dt, center)` = 車流外部狀態（blockers / context / view）→ `lights.update(simDt)` / `updateVisuals` → `pw.step(dt)` → `gameTime += simDt` → `combat.update(simDt)` → `player.syncPhysics(dt)`（非駕駛）→ `vehicles.sync()` → `traffic.sync(dt, center)` → `dmg.update(dt)` → 車輛 `setActiveByDistance(ACTIVE_RADIUS)` → 回收（`simDt`）
- 回歸：`node tools/test/framerate-invariance.mjs`（60 / 120 / 144 Hz 推進相同模擬時間，行人位置、動畫速度、walk ↔ idle 切換次數一致）

---

## 附錄 B：Phase 4 接線說明（各單元 result 彙整，整合單元 I4a / I4b 照做）

### 共通
- 地標點：`landmarks = landmarkPoints(manifest ?? [], projectLatLon)`（manifest = public/models/manifest.json；缺檔回 []），傳給 missions / checkins / 大地圖
- interactable 仲裁（§17）：missions（3）> checkins（2）> food（1）；ammo pickups 自動拾取不需按 E；`hud.setPrompt(text)`；`snap.pressed.interact` → `act()`
- 全螢幕面板（任務接單 / 結算、大地圖、圖鑑）開啟時 `input.enabled = false`、遊戲暫停輸入；關閉時恢復；E / Esc 在面板開啟中由面板處理，遊戲不再處理
- 存檔 getState：`version: SAVE_VERSION`，帶 `weapons.serialize()`、`missions.serialize()`、`collect: { checkins: checkins.serialize(), foods: food.serialize() }`（兩者回傳陣列時直接放入）；讀檔後各自 `restore(save.xxx)`；stats 的 missionsDone / missionsFailed / shotsFired 由整合層依 `mission:complete` / `mission:fail` / `weapon:fire`（byPlayer）累加（economy.snapshot 已保留新統計欄位）

### 武器（W1，細節見 src/weapons/WIRING.md）
- `weapons.attack(aim)` 取代 `player.punch()`（fist 內部仍走 combat 拳擊）；持手槍時 `snap.down.attack` 可連發（半自動間隔由武器定）
- 每幀：`aim = { origin, dir（鏡頭中心射線）, aiming: snap.down.aim && current==='pistol', muzzle, candidates }` → `weapons.update(dt, aim)`；`const k = weapons.recoilKick?.()` → `rig.addRecoil(k.pitch, k.yaw)`；`rig.update(…, { …, aim: aim.aiming })`
- `raycast` / `sweep` 以 `PhysicsWorld.castRay` / `castShape` 實作，collider → actor 以行人剛體對照表查
- `weapon:fire`（byPlayer）→ 對 30 m 內行人 `brain.hear({ type: 'gunshot', x, z })`（`gunshotListeners` 見 WIRING.md）
- `snap.pressed.slot1/2/3` → `weapons.select(0/1/2)`；`weaponCycle` → `cycle()`；`reload` → `reload()`；駕駛中不處理武器輸入且武器模型隱藏
- 武器 HUD / 觸控武器鈕 / 輪盤 / 裝填鈕 / 瞄準鈕：`src/weapons/hud.js`（依 WIRING.md 建立於 `#touch-ui` 或 body）；`tb-interact` 由整合層以 `registerTouchButton` 註冊（有提示才顯示）
- 動畫：createWeapons 的 `playAnim` 注入 W3 的 weaponLayer.play；持武器姿勢 `weaponLayer.setPose`
- `pickup:ammo` → `weapons.addAmmo(n)`；`createAmmoPickups` 每幀 `update(dt, playerPos)`
- 行人：拳 / 棒 hp 歸零只倒地、起身回滿（recoverOnKo）；槍擊歸零 → dying → dead 回收
- combat 'hit' → emit `combat:hit`（§10 欄位）；'knockdown' → `ped:knockdown`（cause 含 bat / bullet）；兩者也餵 blood-fx 的 onHit / onKnockdown

### 音效（W2）
- `audio = createAudio({ bus, settings })`；每次 pointerdown / keydown / touchend 呼叫 `audio.unlock()`
- 每幀 `audio.update(dt, state)`：x / z / yaw 用鏡頭；`rpm01 = |speed| / 最高速`、`skid01 = 側滑速度 / 8`、`twoWheeler`、`nearJunction` = traffic-lights 最近路口距離（無 = null）；暫停中也呼叫並帶 `paused: true`
- 選單與各面板按鈕 `bus.emit('ui:sound', { kind })`

### 任務（W4）
- `missions = createMissions({ bus, scene, root: document.body, landmarks, addMoney: (n, r) => economy.add(n, r), fetchJson, now: () => 遊戲秒, rng, heightAt })`；`restore(save.missions)`
- 每幀 `missions.update(dt, { x, z, driving })`；步行移速 × `missions.speedScale()`；`isModalOpen()` 為真 → 暫停輸入
- `player:ko` → `missions.onPlayerKo()`；玩家駕駛的車碰撞（contacts / vehicle-damage 的 relSpeed）→ `missions.onVehicleImpact({ relSpeed })`
- markers 併入 hud / 大地圖；`nav:destination` / `nav:clear` 由 navigator 自行訂閱

### 導航與大地圖（W5）
- `graph = buildRoadGraph(surfaceRoads)`；`nav = createNavigator({ bus, graph, scene, heightAt })`；每幀 `nav.update(dt, playerPos)`；`hud.update` 的 `state.route = nav.route()`、markers 併入 `nav.markers()`
- `bigMap = createBigMap({ root: document.body, bus, getPlayer, getMarkers: 各模組 markers 合併, getRoute: () => nav.route(), onPick: (x, z) => nav.setDestination(x, z, '地圖標記', 'map', playerPos), landmarks, onClose })`；`snap.pressed.map` / 觸控 `tb-map` → `bigMap.toggle()`；Esc 關閉；開啟時暫停 3D 渲染，玩家移動才 `draw()`
- 大地圖面板自帶 OSM / ODbL 標示（面板 z 85 蓋住遊戲 `#attribution` 屬預期）

### 打卡與圖鑑（W6）
- `checkins = createCheckins({ bus, landmarks, addMoney: (n, r) => economy.add(n, r), root: document.body })`；`food = createFoodGuide({ bus, scene, root: document.body, fetchJson, addMoney })`；每幀 `food.update(dt, playerPos, camera)`
- 兩者 `nearest(pos)` 納入仲裁（小吃只在步行時問）；markers 串 `checkins.markers()` + `food.markers()`（回傳重用陣列，勿修改）
- 存檔 `collect: { checkins: checkins.serialize(), foods: food.serialize() }`；讀檔 `checkins.restore(save.collect)`、`food.restore(save.collect)`
- 圖鑑入口：暫停選單加「圖鑑」按鈕（與觸控 tl 區可選加 `tb-guide`）→ `food.open()`；開啟時暫停輸入；Esc 先 `food.close()`
- food manifest 實檔欄位為 `{ slug, name, file, intro }`（已別名處理）

### 動畫層與流血（W3）
- player 與 traffic 行人：建 animator 後 `layer = createWeaponLayer(anim)`，每次 `anim.update` 後緊接 `layer.update(同 dt)`；回池時 `anim.reset()`、`layer.reset()`、`detachWeapon`（行人目前不持武器，只需 layer 以播定向受擊 / 後續擴充；若成本高可只給玩家建 layer）
- weapons 的 `playAnim` → `layer.play(clip)`（回傳秒數或 false）；姿勢 `layer.setPose('bat_hold'|'pistol_hold'|'pistol_aim'|'none')`；`layer.on('hitWindow'|'fire'|'swap')`；開槍 `layer.addRecoil(settings.get('recoil'))`；`attachWeapon(character, weaponObj, weaponMount(entry))`（weaponMount 讀 FX1 後 models.js 的 socketQuaternion / grip）
- `blood = createBloodFx({ scene, settings, heightAt })`；`combat:hit` → `blood.onHit(e)`、`ped:knockdown` → `blood.onKnockdown(e)`；每幀 `blood.update(dt, camera)`
- 上半身層權重約 92%（非硬遮罩），腿不受影響
