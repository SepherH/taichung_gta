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
| `wanted:change` | `{ stars, prev, heat, reason }`（reason = 犯行名 \| `'evaded'\|'busted'\|'wasted'\|'debug'`） | wanted/wanted.js（§26） |
| `wanted:state` | `{ state: 'clear'\|'active'\|'searching', prev }` | wanted/wanted.js |
| `wanted:spotted` | `{ x, z }`（searching 中被警力再次看見） | wanted/wanted.js |
| `wanted:cleared` | `{ reason: 'evaded'\|'busted'\|'wasted'\|'debug' }` | wanted/wanted.js |
| `police:bust` | `{ x, z, officer }`（逮捕進度滿，清星前只發一次） | wanted/police.js |
| `police:shoot` | `{ officer, x, y, z, targetX, targetZ }`（傷害已在 adapters officerAim → combat.applyHit 處理，收到勿再扣血） | wanted/police.js |
| `player:busted` | `{ fine, x, z }`（fine = 實扣罰鍰 min(150, 餘額)；x, z = 被捕地點；傳送 / 清星之後發） | 整合 |
| `player:wasted` | `{ fee, x, z }`（fee = economy 在 `player:ko` 實扣的醫藥費 min(100, 餘額)；x, z = 倒地地點） | 整合 |
| `robbery:start` | `{ storeId, x, z }`（開始搶劫；x, z = 櫃檯點；同一刻已 `wanted.report('robbery', { witnessed: false })`） | wanted/robbery.js（§28） |
| `robbery:done` | `{ storeId, amount }`（搶劫成功；amount = 入帳金額 NT$300–800，已經 `ctx.earn` 入帳） | wanted/robbery.js |
| `robbery:failed` | `{ storeId, reason: 'aim'\|'distance'\|'clerk'\|'cleared' }`（停止瞄準 > 1 s / 離店員 > 8 m / 店員倒地 / 清星中止） | wanted/robbery.js |
| `vigilante:start` | `{}`（駕駛警車按互動鍵開始警車任務；下一次 update 開第 1 關） | missions/vigilante.js（§29） |
| `vigilante:level` | `{ level, phase: 'start', count, timeSec, speed }`（每關開始）/ `{ level, phase: 'clear', reward, earned }`（全部制伏，賞金已 `ctx.earn`） | missions/vigilante.js |
| `vigilante:end` | `{ reason: 'timeout'\|'left'\|'wrecked'\|'busted'\|'wasted'\|'cancel', levels, earned, level }`（levels = 完成關數、earned = 本次共得 NT$） | missions/vigilante.js |
| `vigilante:subdued` | `{ id, level, x, z, remaining }`（單台逃犯車制伏；附加事件） | missions/vigilante.js |
| `race:start` | `{ id, name, rivals, checkpoints, countdown }`（駕車在起點光柱內按互動鍵開賽；開始 3–2–1 倒數） | missions/race.js（§34） |
| `race:checkpoint` | `{ id, index, total, time, rank, name }`（玩家依序通過第 index 個檢查點；time = 比賽秒數、rank = 當下名次） | missions/race.js |
| `race:finish` | `{ id, name, rank, total, time, reward, best, newBest }`（玩家過終點；獎金已 `ctx.earn`、最佳成績已更新） | missions/race.js |
| `race:abort` | `{ id, reason: 'left'\|'wrecked'\|'busted'\|'wasted'\|'cancel', time, cp }`（退賽；對手車已回收） | missions/race.js |
| `taxi:start` | `{}`（駕駛計程車按互動鍵開始載客） | missions/taxi.js（§35） |
| `taxi:fare` | `{ x, z }`（路邊出現招手乘客） | missions/taxi.js |
| `taxi:pickup` | `{ dest, x, z, dist, limit }`（乘客上車；dest = 目的地名、dist = 路網距離 m、limit = 限時 s） | missions/taxi.js |
| `taxi:paid` | `{ dest, dist, meter, tip, bonus, total, streak, fares, timeLeft }`（送達付費；total 已 `ctx.earn`） | missions/taxi.js |
| `taxi:failed` | `{ reason: 'timeout'\|'damaged', dest, streak }`（乘客下車不付費；連載歸零，任務繼續） | missions/taxi.js |
| `taxi:end` | `{ reason: 'left'\|'wrecked'\|'busted'\|'wasted'\|'quit'\|'cancel', fares, earned, streak }` | missions/taxi.js |
| `ems:start` | `{ level }`（駕駛救護車按互動鍵出勤） | missions/ems.js（§35） |
| `ems:patients` | `{ level, patients, limit }`（本關傷患生成完畢、開始計時） | missions/ems.js |
| `ems:pickup` | `{ level, picked, patients }`（一名傷患停車 3 s 抬上車） | missions/ems.js |
| `ems:level` | `{ level, reward, patients, timeLeft, earned }`（送達醫院；賞金已 `ctx.earn`、`ctx.heal()` 已回血） | missions/ems.js |
| `ems:end` | `{ reason: 'timeout'\|'lost'\|'left'\|'wrecked'\|'busted'\|'wasted'\|'quit'\|'complete'\|'cancel', level, cleared, earned }` | missions/ems.js |
| `street:start` | `{ id, kind: 'robbery'\|'chase'\|'gang'\|'drunk', x, z }`（街頭事件開始；x, z = 事發點） | street-events.js（§32） |
| `street:resolve` | `{ id, kind, outcome: 'subdued'\|'escaped'\|'arrested'\|'crashed'\|'over'\|'timeout'\|'cancel', reward, x, z }`（reward > 0 時已 `ctx.earn` 入帳） | street-events.js |
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
| `lookSensPad` | number 0.3–3.0（step 0.1） | 1.0（遊戲手把右搖桿，§4.6） |
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
- `hud.setMoney(money, delta)`、`hud.setHealth(hp, hpMax)`、`hud.setPrompt(text | null)`（中下提示膠囊：車輛提示——上車 / 搶車 / 扶起 / 下車）
  - `hud.setInteractPrompt(text | null)`（互動提示：接委託 / 打卡 / 外送取餐 / 倒垃圾 / 小吃；觸控另顯示 `tb-interact`，步行 / 駕駛皆可）
  - `hud.setPrompts(vehicleText, interactText)`（G2）：兩者同時存在 → 同一膠囊並列（車輛在前、全形空白分隔），「上車」鈕 `.ready` 依車輛提示、`tb-interact` 依互動提示，互不覆蓋
  - 膠囊只有一個：`setPrompt` / `setInteractPrompt` 各自會清掉另一則。整合層規則（main.js `setPrompts`）：兩者都有 → `setPrompts`；只有一種 → 只呼叫對應那個；都沒有 → `setPrompt(null)`（不可先 `setPrompt(車輛)` 再 `setInteractPrompt(null)`，後者會蓋掉「按 F 上車」）
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
| ~~radio~~ | — | 已移除（Q 改 weaponCycle，見 §12）；Phase 5 起駕駛中 Q = 情境動作 `radioNext`（`CONTEXT_ACTIONS`，見 §12、§21.2） | | |
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

- `KEYMAP_HELP`：`[{ group: '步行'|'駕駛'|'通用', items: [{ keys: '顯示文字', action, desc }] }]`，桌機說明單一來源；涵蓋所有非預留 action，不列預留 action；`action: null` 為非動作的說明列（滑鼠轉視角、滾輪），以及 `CONTEXT_ACTIONS` 的情境動作列（`action` 只收 `ACTIONS` 鍵）
- 電台列：桌機「駕駛」組 `Q`「換電台（只在車上；循環含關閉）」、觸控「駕駛」組「「電台」鈕」（tb-radio）「換台（車上顯示）」，兩者 `action: null`（實際動作 = `radioNext`）；駕駛組另列 `E` 互動（接委託 / 打卡 / 外送取餐 / 倒垃圾，駕駛中也有效）
- 時段事件說明列（G2）：桌機「通用」組與觸控「通用」組各一列 `keys: '傍晚垃圾車'`、`action: null`（16–18 時出現、小地圖紅點、3 分鐘內追上車尾按 E / 點「互動」鈕倒垃圾）；夜市外送沿用 E 互動列（外送取餐）；選單操作說明頁由此表產生，menu.js 不另寫
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
| 互動 | `tb-interact` | KeyE | tap | 步行 / 駕駛（`showWhen: 'always'` + 預設隱藏；有互動提示時由 hud.js `setTouchButtonVisible` 顯示）。位置：步行 = 攻擊鈕左側（slot `interact`）；駕駛 = 橫向在下車鈕左側同列（右 176–232、上 134–190）；直向在右半下車鈕正下方（右 106–162、上 206–262，不與左半轉向區 `#touch-pad` 重疊），直向駕駛踏板上緣讓到 274px（style.css `body.touch-drive .tbtn.slot-interact` / `body.touch-drive #touch-pedals`） |
| 電台 | `tb-radio` | KeyQ | tap | 駕駛（hud.js 註冊，slot `top2`，§21.2） |
| 暫停（左上） | `tb-pause` | Escape | tap | 一直 |
| 地圖（左上） | `tb-map` | KeyM | tap | 一直 |
| 手機（左上，預留隱藏） | `tb-phone` | KeyT | tap | 隱藏 |

- 每個 pointerId 只綁一個控制，多指互不搶；`registerTouchButton(def)` 可擴充；已移除的 `tb-flip` / `tb-sens` / `tb-punch` / `tb-gas` / `tb-brake` 再註冊會被忽略（回 null）
- `setTouchMode('walk'|'drive')`（hud.js 依是否駕駛呼叫）、`getTouchMode()`

### 4.6 遊戲手把（`src/gamepad.js`，Gamepad API）

- `createGamepad(input, { getMode, getSlot })` → `{ supported, connected, poll(), rumble(strong, weak, ms), release(), dispose() }`；`navigator.getGamepads` 不存在時回 no-op 物件（不拋例外）
- 輪詢：`input.addFrameHook(poll)`（`endFrame` 清 `pressed` 之後；`onFrame` 仍為觸控專用）；取第一支 `mapping === 'standard'`，無則第一支非 null；斷線（事件或輪詢不到）→ `input.resetPad()` + 視角累積量歸零
- Input 來源：`padKeys`（併入 `_syncKeys`）、`padDown(code, edge)` / `padUp(code)`（按下沿進 `pressed`，停用中不吃）、`setPadAnalog(x, y, throttle, brake, drive)`、`padLook(ux, uy)`（× `lookSensPad`、尊重 `invertY`）、`resetPad()`；觸控與手把類比量並存規則：每軸取絕對值較大者、踏板各取較大深度；`padDrive` 只在手把類比量非 0 時影響 `moveAxis` 分支（純鍵盤不變）
- 步行 / 駕駛：`getMode()` = main.js `state.mode`（未給時 `input.touchMode`）
- 配置（standard 索引）：左搖桿移動（死區 0.15 重映射）；右搖桿視角（死區 0.12、平方曲線、推到底 ≈ 225°/s × 倍率，垂直 0.65）；RT(7) 步行 Mouse0 / 駕駛油門類比；LT(6) 步行 Mouse2 / 駕駛煞車倒車類比；A(0) Space；B(1) KeyE；X(2) 步行 KeyR / 駕駛 KeyH；Y(3) KeyF；LB(4) KeyQ；RB(5) KeyV；Back(8) KeyM；Start(9) Escape；L3(10) ShiftLeft；R3(11) KeyC；↑ KeyT；↓ KeyN；←（步行）Digit{上一格}（讀 `getSlot()`）；→（步行）KeyQ
- 選單模式（`input.enabled === false`）：十字鍵 / 左搖桿 → 合成 `keydown`+`keyup` ArrowUp/Down/Left/Right（按住 400 ms 後每 120 ms，`repeat: true`）；A = Enter、B = Escape、Start = Escape、Back = KeyM，dispatch 到 `window`（menu.js / phone.js / 大地圖既有鍵盤處理生效）；模式切換時仍按著的鍵鎖到放開
- 震動（main.js）：`weapon:fire`（byPlayer）短震；`vehicle:crash` 依 relSpeed；無 `vibrationActuator.playEffect` 時略過
- 說明表：`GAMEPAD_HELP`（`src/core/actions.js`，結構同 `TOUCH_HELP`），選單「操作說明」頁籤「手把」（`createMenu({ gamepadHelp })`）

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
| `weapon:impact` | `{ x, y, z, nx, ny, nz, surface: 'world'\|'vehicle', vehicle?, damage?, byPlayer? }`（V4：打到車時 `vehicle` = 車輛物件、`damage` = `WEAPONS.pistol.vehicleDamage`） | weapons（子彈打到非角色） |
| `combat:hit` | `{ attacker, target, weapon: 'fist'\|'bat'\|'pistol'\|'vehicle', damage, hp, x, y, z, dirX, dirZ, side: 'front'\|'back', byPlayer, knockdown: boolean }` | 整合（由 combat 'hit' 轉發） |
| `ped:knockdown` | §1 原欄位，`cause` 擴充為 `'punch'\|'bat'\|'bullet'\|'vehicle'`，另加 `weapon` | 整合 |
| `pickup:ammo` | `{ amount, x, z }` | weapons/pickups |
| `mission:available` | `{ id, title, x, z }` | missions |
| `mission:start` | `{ id, title, cargo }` | missions |
| `mission:stage` | `{ id, stage: 'pickup'\|'deliver', text, x, z }` | missions |
| `mission:complete` | `{ id, reward, timeSec, damagePct, bonus }` | missions |
| `mission:fail` | `{ id, reason: 'timeout'\|'destroyed'\|'ko'\|'abandon'\|'busted'\|'wasted' }`（busted / wasted 由整合層 `missions.failActive(reason)`，§26） | missions |
| `nav:destination` | `{ x, z, label, source: 'map'\|'mission'\|'checkin' }` | map / missions |
| `nav:clear` | `{ source }` | map / navigation（抵達 20 m 內自動清） |
| `collect:checkin` | `{ landmarkId, slug, name, reward }` | collect |
| `collect:food` | `{ id, name, total, found }` | collect |
| `ui:sound` | `{ kind: 'click'\|'confirm'\|'cancel'\|'reward'\|'fail'\|'open'\|'close' }` | 任何 UI |
| `vehicle:fire` | `{ vehicle, x, y, z（引擎蓋）, fuse（秒）}`（V4，§31） | explosions |
| `vehicle:explode` | `{ vehicle, x, y, z, source（actor \| null）, byPlayer }`（V4，§31） | explosions |
| `explosion` | `{ x, y, z, radius, power, source, byPlayer, vehicle（車爆 = 該車；直接 explode = null）}`（V4，§31） | explosions |
| `explosion:shake` | `{ x, y, z, radius, power }`（鏡頭震動；整合層以 `shakeTrauma(距離, radius, power)` 換算 trauma） | explosions |

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
| interact | KeyE | 互動：接委託 / 打卡 / 外送取餐 / 倒垃圾 / 收集小吃 / 撿彈藥（**取消預留**；駕駛中只有接委託 / 打卡 / 外送取餐 / 倒垃圾） | |
| weaponCycle | KeyQ | 循環切換武器（取代 radio；radio 移除） | |
| slot1 / slot2 / slot3 | Digit1 / Digit2 / Digit3 | 直選 空手 / 球棒 / 手槍 | |
| reload | KeyR | 裝填（**取消預留**） | |
| map | KeyM | 開 / 關大地圖（不再開暫停選單地圖頁；暫停選單地圖頁保留） | |

- 情境動作（Phase 5，`CONTEXT_ACTIONS`，與 `ACTIONS` 共用按鍵、`mode` 互斥）：`radioNext` = KeyQ、`mode: 'vehicle'`（駕駛中換台：下一台 → … → 關閉 → 第一台）；步行時 Q 仍為 weaponCycle。以 `reader.pressedIn(action, mode)` / `actionForKey(code, mode)` 分流；說明表電台列見 §4.3
- `input.snapshot()`：`down` 增 `aim`、`attack`；`pressed` 增 `slot1`、`slot2`、`slot3`、`weaponCycle`、`reload`（`interact` 已有）
- 滾輪：持手槍瞄準中不縮放（整合層判斷）；其餘照舊
- 觸控新增（touch.js `registerTouchButton` 或武器模組自建）：`tb-weapon`（武器鈕：點擊 = weaponCycle；長按 ≥ 350 ms 開三格輪盤，滑到格子放開 = 直選）、`tb-reload`（持手槍才顯示）、`tb-aim`（持手槍才顯示，hold = 肩後瞄準）、`tb-interact`（有互動提示才顯示，送 KeyE；步行 / 駕駛皆顯示，位置見 §4.5）；其餘步行模式顯示，駕駛隱藏；按鈕 ≥ 44 px
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
  - `state = { x, z, yaw, driving, speedKmh, rpm01, throttle, skid01, walkSpeed, grounded, nearJunction: 距離 m|null, paused, rain（§21.1）, garbageTruckDist（§22） }`；footstep 依 walkSpeed 與步距自行觸發；paused 時持續音源靜音
  - 持續音源（loops）：engine / tire（sfx）、ambience（music）、rain（sfx，§21.1）、garbage_truck（music，§22）；`stats()` 另帶 `loops`（持續音源數）、`garbageTruck`（垃圾車旋律是否開啟）

## 16. 任務：資料驅動委託（W4，src/missions/**）

- 委託資料 `public/art/cargo/manifest.json`（美術線產出，可能缺）：`{ items: [ { slug, name, file, title, brief, client, from, to, timeLimitSec, reward, conditions: ['fragile'|'heavy'|'timed'] } ] }`（也接受頂層陣列；`from` / `to` 為地標 manifest 的 `id` 或 slug（檔名去 .glb））；缺檔 → 內建 3 個委託；圖卡 `art/cargo/<file>` 缺 → 純色卡片
- 地標點由整合層注入：`landmarks = [{ id, slug, name, x, z, radius }]`（§17）
- `createMissions({ bus, scene, root, landmarks, addMoney, fetchJson, now, rng })` → `{ ready: Promise, update(dt, ctx), nearest(pos) → interactable|null, markers() → [{ x, z, kind: 'mission-start'|'mission-dest', label }], objective() → { text, timerSec|null, distM|null, damagePct|null }|null, onVehicleImpact({ relSpeed }), onPlayerKo(), active(), serialize(), restore(data), dispose() }`
  - 流程：起點地標光柱（`mission-start`）→ 按 E 接單（顯示貨物圖卡 + 文案 + 條件 + 報酬，確認 / 取消）→ 目的地光柱 + `nav:destination` → 抵達 8 m 內（步行或駕駛）結算 → 結算面板（時間、損壞度、報酬、「再挑戰」/「繼續」）
  - 條件：`timed` 超時失敗；`fragile` 以 `onVehicleImpact` 與玩家被擊倒累積損壞度，100% 失敗，報酬依損壞度遞減；`heavy` 步行速度上限 × 0.6（回傳於 `ctx` 回饋：`speedScale()`）
  - 失敗可重試（回起點重接）；輪替：同時開放 3 個起點、完成後該委託冷卻 120 s 遊戲時間
  - 自帶 UI（前綴 `ms-`）：目標列（上中）、字幕、接單卡、結算面板
- 委託統計：另匯出 `MISSION_STAT_EVENTS`（bus 事件 → stats 欄位：`mission:complete` / `event:complete` → `missionsDone`、`mission:fail` / `event:fail` → `missionsFailed`）與 `trackMissionStats(bus, stats)` → 取消訂閱函式（依該表每次 +1 寫進 stats；整合層傳 extraStats）
- 存檔（§18）`missions`

## 17. 大地圖與導航（W5）/ 打卡圖鑑（W6）/ 地標點

- 地標點 `src/core/landmark-points.js`（D4-0）：`landmarkPoints(manifestList, project = projectLatLon)` → `[{ id, slug, name, x, z, radius }]`（slug = file 去 .glb；radius = 25 m 預設，footprint false 者 15 m）；純函式
- 導航 `src/navigation.js`：`buildRoadGraph(roads)`（citymodel surfaceRoads → 節點 / 邊，端點吸附 1 m、交叉點合併）→ graph；`findRoute(graph, from, to)` → `{ points:[{x,z}], lengthM } | null`（A*，起訖投影到最近邊）；`createNavigator({ bus, graph, scene })` → `{ setDestination(x, z, label, source), clear(source), update(dt, playerPos), route() → points|null, destination() }`：偏離路線 > 25 m 或每 3 s 重算一次、抵達 20 m 內清除並 emit `nav:clear`；世界內導航圖釘（目的地上方浮動錐體）
- 大地圖 `src/map/**`（前綴 `mp-`）：`createBigMap({ root, getPlayer, getMarkers, getRoute, onPick, bus })` → `{ open(), close(), toggle(), isOpen(), draw(), destroy() }`：canvas 全螢幕、OSM 路網 / 公園 / 水域 / 地標、圖例、滾輪 / 雙指縮放、拖曳、點擊空白處設目的地（`onPick(x,z)` → 整合層呼叫 navigator）、路線與任務 / 打卡 / 小吃標記（kind 同小地圖，另含時段事件 `event-start` / `event-dest`，顏色 / 圖例 / 圖釘見 §21.3）；可 import `src/ui/map-view.js` 的匯出函式
- 小地圖：hud.update 的 `state.route`（`[{x,z}]` 或 null）與 `state.markers` 增 `kind`（`'mission-start'|'mission-dest'|'dest'|'checkin'|'food'|'ammo'`，Phase 5 加 `'event-start'|'event-dest'`，G2 加 `'event-truck'`）；hud.js 依 kind 著色、route 畫線（I4）
- **標記色表來源**：`src/map/marker-colors.js` 的 `MARKER_COLORS`（kind → 色碼）與 `CAR_MARKER_COLOR`（無 kind = 可駕駛車輛 / 未知 kind 後備）為唯一來源；小地圖 `hud.js MARKER_COLORS = { car, ...MARKER_COLORS }`、大地圖 `big-map.js` 轉匯出同一物件，兩者不得再寫死色碼；新增 kind 時同步 `big-map.js MARKER_LABELS`（圖例，與色表同一份 kind 清單、同順序）、需要時 `PIN_KINDS`（畫圖釘）與 hud.js `EDGE_KINDS`（超出小地圖半徑時貼邊）
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
- **Phase 5 增補（不升版，`SAVE_VERSION` 仍為 2）**：`missions.events`（選填）＝ 時段事件狀態（`missions/events.js` `serialize()`，由 `missions.serialize()` 只在有狀態時帶出）
```
missions.events?: { completed: { <事件 id>: 正整數次數 }, cooldowns: { <事件 id>: 剩餘冷卻秒 > 0 } }
```
  - `validateSave`：`events` 非物件、或 `completed` / `cooldowns` 存在但非物件 → **整欄丟棄**（其他 missions 欄位照常保留）；表內鍵規則同 completed / cooldowns（字串鍵、非負有限數、≤ 200 鍵），另 completed 只收 ≥ 1（取整數）、cooldowns 只收 > 0；清洗後兩表皆空 → 省略此欄（與 serialize 一致）
  - 讀檔：`missions.restore(save.missions)` 轉交 `events.restore(src.events)`（未知 id 由 events.js 再過濾；冷卻夾到該事件 cooldownSec）；進行中的外送不存檔（讀檔一律作廢）
  - 經濟：外送入帳 `economy.add(n, 'event')`；統計：`event:complete` / `event:fail` 與委託同列各計入 missionsDone / missionsFailed 一次（`trackMissionStats`，§16；放棄外送走 fail → 計入 missionsFailed；讀檔作廢的進行中外送不發 fail、不計）

## 19. 效能預算（手機 low 檔）

render + 物理 + 更新 < 8 ms（`__game.perf()`）；血跡 ≤ 16、血滴 ≤ 32、同時音源 ≤ 12；大地圖開啟時暫停 3D 渲染或降頻；各模組 update 不得每幀配置新物件（重用暫存）

## 20. 時間步契約（p5-c1；`src/physics/world.js` FixedStepper、`src/core/loop.js`）

兩種時間，不得混用：

| 名稱 | 來源 | 用途 |
|---|---|---|
| 模擬時間（固定子步 `step` = 1/60 s） | `PhysicsWorld.step(frameDt)` 內 FixedStepper 每個子步呼叫 `onBeforeStep(dt)` / `onAfterStep(dt)`，`dt` 恆為 `step` | 會影響遊戲結果的狀態 |
| 本幀模擬秒數 `simDt` | 三個來源（皆 = 子步數 × step）：① `pw.step()` 回傳的 `simDt`；② `core/loop.js` 在 step **之前**取 `pw.simTimeFor(frameDt)`（純查詢；`worldStep.simDt` getter 即此值，給 step 之後的消費者如天氣）；③ traffic 由 `_step` 每子步累加 `_simAcc`、`sync` 取走歸零。三者一致的條件：同一幀內 `simTimeFor` 與 `step` 用同一個 `frameDt` 且中間不改 paused / 累加器，traffic 的 `onBeforeStep` 已登記在該 `pw` 上且每幀 `sync` 恰一次；暫停中三者皆 0 | 每幀呼叫、但推進的是模擬狀態的地方 |
| 渲染時間 `dt` | rAF 幀間隔，`core/loop.js` 夾到 `MAX_FRAME_DT` = 0.1 s | 只做插值、動畫 mixer、相機、UI / HUD、音效、特效粒子 |

- **屬模擬時間**（只在固定子步推進，或每幀以 `simDt` 推進）：剛體 / 角色膠囊 / 車輛控制器（子步內）；車流車道邏輯與行人位置、擊退（traffic `_step` / traffic-peds `stepPeds`、`afterStepPeds`）；mid 級與替身行人的降頻走路、行人大腦 `brain.update` 的累積秒數（`thinkPeds(simDt)`，`simDt` 由 traffic `_step` 在子步內累加、`sync` 取走）；自建 combat 時鐘與密度管理計時（traffic.sync）；遊戲對抗時鐘 `gameTime` 與 `combat.update`、號誌相位 `lights.update`、玩家 KO 倒數、搶來 / 報廢車回收計時（main.js / loop.js）；委託 / 時段事件 / 垃圾車 `missions.update(worldStep.simDt)`（G2 起，含任務 elapsed、垃圾車行駛與車體輪子）
- **屬渲染時間**：選單運鏡巡覽計時（`menu-tour.js update(dt)` / `handoff(dt)`，§25）、`InterpolatedBody.interpolate(alpha)` 擺網格、`anim.update` / 輪子 `animate`、`rig.update`、`hud` / `whud`、`audio.update`、`blood.update`、煙霧粒子、FPS、自適應解析度
- **遊戲時鐘（目前用渲染 dt，可接受）**：日夜 `dayNight.update`、自動存檔、遊玩 / 步行秒數、導航重算、補給重生；不影響物理狀態，差異只在累加器餘量（< 1 子步）與卡頓丟棄的時間
- **速度一律 = 推進距離 ÷ 實際推進的模擬秒數**：例 行人動畫速度 = `moveD / moveT`（`moveT` 只在子步或降頻走路時累加）；某幀沒有推進（`moveT` = 0）就沿用上次速度。禁止「當幀位移 ÷ 渲染幀時間」——高於 60 Hz 時約半數幀沒有子步，會得到 0 / 加倍的速度
- **上限**：渲染 `dt` ≤ `MAX_FRAME_DT` 0.1 s；單幀子步 ≤ `DEFAULT_MAX_SUBSTEPS` 5（= 0.083 s 模擬時間），超過即丟棄累加器餘量（`stepper.dropped` 累計）——卡頓時模擬時間會少於渲染時間，所以模擬計時必須吃 `simDt` 而不是 `dt`
- **60 Hz 等價**：`dt` 恰為 1/60 時每幀恰 1 子步，`simDt === dt`；本契約不改 60 Hz 下的結果
- **實機 rAF 抖動**：幀間隔在 1/60 上下浮動時每幀子步數為 0 / 1 / 2，模擬時間量化推進（每幀 `simDt` ∈ {0, 1/60, 2/60}），但累加器保留餘量，總量不變（不觸發子步上限時）
- **更新順序**（`core/loop.js`）：tick = 自適應解析度 → 世界更新（暫停時略過；遊戲中 `updateGame`、開始畫面 `updateAttract`）→ 音效 → 渲染 → 效能統計 → FPS → `input.endFrame()`；物理一幀 `createWorldStep().step(dt, center)` = 車流外部狀態（blockers / context / view）→ `lights.update(simDt)` / `updateVisuals` → `pw.step(dt)` → `gameTime += simDt` → `combat.update(simDt)` → `player.syncPhysics(dt)`（非駕駛）→ `vehicles.sync()` → `traffic.sync(dt, center)` → `dmg.update(dt)` → 車輛 `setActiveByDistance(ACTIVE_RADIUS)` → 回收（`simDt`）
- 回歸：`node tools/test/framerate-invariance.mjs`（60 / 120 / 144 Hz 推進相同模擬時間，行人位置、動畫速度、walk ↔ idle 切換次數一致）

## 21. Phase 5 整合（i5：天氣 / 環境、車上電台、時段事件；接線點在 `src/main.js`）

### 21.1 天氣 / 環境（`src/weather.js`、`src/environment.js`；介面以各檔頭為準）
- 建立：`env = createEnvironment({ scene, dayNight, viewDist: budget.viewDist, fogNearRatio: 0.25 })`（傳 dayNight 即 attach：DayNight 只算基準值，天空 / 霧色 / 霧距 / hemi / sun 由 env 套用）；`weather = createWeather({ scene, camera, quality: budget, THREE, auto, initial })`（THREE 注入才有雨絲）
- 每幀順序（遊戲中與開始畫面相同）：`dayNight.update(dt, focus)` → `weather.update(dt, worldStep.simDt)` → `env.update(dt, { dayNight, weather })`
  - `worldStep.simDt`（`core/loop.js` createWorldStep 新增 getter）= 本幀物理實際推進的模擬秒數；每幀 `resetPerf()` 歸零 → 暫停 / 全螢幕面板開啟時世界不 step、天氣狀態機不推進（§20：天氣屬遊戲時鐘，吃 simDt；雨絲粒子屬特效吃 dt）
- 視距：`applyViewDist(d)` = 鏡頭 far + `env.setViewDist(d)`（attach 後不再直接寫 `scene.fog`，否則每幀被 env 覆蓋）；畫質切換另呼叫 `weather.setQuality(budget)`（雨絲數）
- 設定 `weather` ∈ `auto | clear | rain | fog`（選單「天氣」列）：`auto` → `weather.setAuto(true)`；其他 → `setAuto(false)` + `setWeather(kind, { instant: true })`
  - `src/core/settings.js` SETTINGS_SCHEMA 已有 `weather: { type: 'enum', values: ['auto','clear','rain','fog'], default: 'auto', label: '天氣' }`，選單寫入即持久化；注入的 settings 不認此鍵（`settings.set` 回 false）時選單仍退回本地值（不持久化）。兩種情況選單都 `bus.emit('weather:setting', { value })`，整合層同時訂閱 settings 的 `weather` 與此事件
- 雨聲：音效每幀 state 加 `rain`（= `weather.getState().rain`）；`audio/index.js` 在 `rain > 0.01` 開 `LOOPS.rain`（sfx 群組，≤ 0.005 關），每幀 `ctrl.set(state, now)`，暫停時外層增益 0
- HUD：`hud.update` state 加 `weatherIcon`（`getState().icon`：sun / rain / fog），顯示在右上狀態列最前面（桌機 / 觸控相同，位於觸控右上小鈕下方）

### 21.2 車上電台（`src/audio/radio.js`）
- `audio.getOutput()` → `{ ctx, out: master } | null`（解鎖前 / 無 AudioContext / dispose 後 null；回傳物件重用）
- `radio = createRadio({ getAudio: () => audio.getOutput(), getMusicVolume: () => settings.get('volumeMusic') })`；out 接 **master**（radio 自己乘音樂音量，不可接 music 群組）
- 每幀（`updateAudio`，暫停中也呼叫）：`radio.update(dt, { inVehicle: 駕駛中, paused: 開始畫面 / 暫停 / 全螢幕面板 })`
- 鍵位：駕駛分支 `input.actions.pressedIn('radioNext', 'vehicle')` → `radio.next()`；步行時 Q 仍是 weaponCycle（只在步行分支讀）
- 觸控：`hud.js` 以 `registerTouchButton({ id: 'tb-radio', label: '電台', code: 'KeyQ', slot: 'top2', showWhen: 'drive' })` 註冊（沿用 touch.js 按鈕樣式與 pointer 處理，送虛擬 KeyQ）
- HUD：state 加 `radio`（`radio.getState()`）；駕駛中 playing 時於駕駛面板車名上方顯示「📻 台名」，換台（含關閉）時強調顯示 2.5 s；步行不顯示。電台無選單項（音量沿用「音樂」）

### 21.3 時段事件（夜市外送，`src/missions/events.js`）
- `createMissions({ …, getGameHour: () => dayNight.hour, routeLength: (a, b) => findRoute(graph, a, b)?.lengthM })`（graph 在 missions 之後建立，閉包呼叫時已存在；查無路線 → events.js 以直線 × 1.3 估算）
- 標記：`missions.markers()` 附 `event-start`（取餐點）/ `event-dest`（送達點）；色碼在 `map/marker-colors.js`（§17 色表來源：`event-start` #8dff3a、`event-dest` #2ee86a），小地圖超出半徑時貼邊；大地圖 `map/big-map.js` 定義 `MARKER_LABELS` 圖例（外送取餐點 / 外送送達點）、`PIN_KINDS`（`event-dest` 與 dest / mission-dest 同畫圖釘，其餘畫圓點）；main.js 不改寫 MARKER_COLORS
- 事件提示：`event:available` → toast「🌙 <title>開放中：到<取餐點>取餐」；`event:closed` 且該 id 的事件自身未進行中（`missions.eventRunning(e.id)` 為 false；追垃圾車中外送關閉照常提示）→ toast「夜市外送時段結束」；`event:start / complete / fail` 字幕由 missions 自己顯示；`player:money` → `hud.setMoney(money, delta, reason)`：reason `'event'`（外送）跳動文字前加「外送」、`'garbage'`（垃圾車）加「清運」
- 存檔：§18 Phase 5 增補 `missions.events`

### 21.4 回歸
- `node tools/test/integration-p5.mjs`：main.js + loop.js 靜態接線檢查、save.js missions.events 清洗、audio getOutput 解鎖前 null / 解鎖後 master、雨聲 loop 開關、選單天氣列（hud 事件標記色以 hud.js + map/marker-colors.js 合併內容檢查）

## 22. 垃圾車事件 / 夜市攤車 / 互動提示（G2；接線點在 `src/main.js`）

### 22.1 垃圾車事件（`src/missions/garbage-truck.js`，由 `missions/index.js createMissions` 掛上；規則以該檔頭為準）
- 規則：遊戲時刻 16:00–18:00 且無進行中委託 / 外送時出現；時限 180 s；完成冷卻 240 s、失敗 / 收走冷卻 120 s；獎勵 `garbageReward(剩餘秒)` = 250 + 剩餘秒（`economy.add(n, 'garbage')`，HUD 跳字「清運」）；玩家進 60 m 內 → `event:start`；車尾投入口 5 m 內（步行或駕駛）按 E 完成；逾時（已追車）或追車後離車 > 250 m 持續 10 s → 失敗；未追車逾時只 `event:closed`、不計失敗
- 介面：`createMissions({ …, routeFor(player, rng) })`——**有注入 routeFor 才掛垃圾車**（未注入 = 既有行為不變）；`missions.truckState()` → `{ x, z, heading, speed, stopped, rearX, rearZ, distM, phase: 'open'|'chase', beacon }` 或 null（物件重用）；`missions.truck` = 完整 API（`update / truck / nearest / markers / objective / active / isOpen / isEngaged / abandon / serialize / restore / dispose`）
- `missions.eventActive()` / `eventObjective()`：外送進行中回外送；否則追車中（`truck.isEngaged()`）回垃圾車——`eventActive()` → `{ id: 'garbage-truck', kind: 'truck', stage: 'chase', from: null, to: { x, z }（車尾投入口，隨車移動）, routeM: null, limitSec, elapsedSec, timerSec }`（欄位比照外送）、`eventObjective()` → `{ text, timerSec, distM, rewardNow }`（同 `truck.objective()`）；都沒有 → null。HUD 目標列不經這兩個方法，行為不變
- `missions.eventRunning(id)` → boolean：該 id 的事件自身是否進行中（外送已取餐 / 垃圾車追車中），不受另一事件影響；main.js `event:closed` 提示用
- 觸控文字：`createMissions({ …, isTouch, interactLabel })`（選填；`interactLabel` 預設 `isTouch ? '點「互動」鈕' : '按 E'`）——垃圾車目標列（`追上垃圾車，到車尾${interactLabel} 倒垃圾`）與 `event:available` / `event:start` 字幕用此操作詞；main.js 依 `mobile.js isTouch()` 注入 `isTouch: touch`（missions 內不讀 DOM / navigator）。互動提示本身（`按 E 倒垃圾` / `按 E 取餐`）仍由 hud.js `touchPromptText` 轉換；夜市外送目標列 / 字幕本來就不含「按 E」
- 整合（main.js）：
  - `routeFor: (p, rng) => garbageTruckRoute(graph, p || focus, rng)`：隨機方向取玩家 150–300 m 外的點以 `projectToGraph` 投影為起點（投影後須在 75–450 m），同方向 ±45° 再往外 250–450 m 投影為終點，`findRoute(graph, 起點, 終點).points`（≥ 100 m）；最多試 4 個方向，失敗回 null（garbage-truck.js 2 s 後再問）。graph 在 missions 之後建立，閉包呼叫時已存在
  - 車體：`createVehicleModel('garbage_truck')`（public/models/vehicles/manifest.json 的 garbage_truck）**純視覺**——不建物理剛體、不進 `VehicleManager`（不可上車 / 搶車）、不進 traffic 車流（traffic.js `CAR_TYPES` 不含）；每幀 `missions.update` 之後依 `truckState()` 擺 `position.set(x, heightAt(x, z), z)`、`rotation.y = heading`、輪子滾動角 += speed × simDt / 輪徑；null → `visible = false`；讀檔 / 新局後立即同步一次。glb 缺檔 → 無車體（事件與標記照常）
  - 夜間發光（**勘誤 I6c**：警示燈不登記 daynight）：`vehicleTemplateMaterials('garbage_truck')` 中名稱在 `EMISSIVE_MATERIALS` 者經 main.js `registerNightOnce` → `registerNight(m, m.emissiveIntensity || 1)`（同一材質只登記一次），但**名稱含 `beacon` 者跳過**；警示燈亮度改由 `syncGarbageTruck` 每幀 `applyBeacon(模板材質, truckState().beaconLevel)`（garbage-truck.js 匯出，脈衝 × 日夜 `missionCtx.night`，§23.5 / I6a）——登記了會被 daynight 每幀覆寫
  - 時間步（§20）：`missions.update(worldStep.simDt, ctx)`（委託 / 外送 / 垃圾車同屬模擬時間：暫停 / 全螢幕面板開啟時 updateGame 不跑、本幀無子步時 simDt = 0 不推進）；車體同步同吃 simDt
- 事件（bus，與夜市外送共用 `event:*`，id `'garbage-truck'`）：

| 事件 | payload |
|---|---|
| `event:available` | `{ id, title, x, z, kind: 'truck' }` |
| `event:closed` | `{ id }`（未追車逾時 / 委託開始時收走） |
| `event:start` | `{ id, title, limitSec, leftSec, kind: 'truck' }` |
| `event:complete` | `{ id, reward, timeSec, leftSec }` |
| `event:fail` | `{ id, reason: 'timeout'\|'lost'\|'abandon' }` |

  - 字幕由 missions 顯示；main.js `event:available` 且 `kind === 'truck'` → 簡短 toast「🚛 垃圾車來了：看小地圖紅點追上它」（不走夜市外送的「🌙 …開放中：到…取餐」）；`event:closed` 且 `id === 'garbage-truck'` 不提示「夜市外送時段結束」；不發 `nav:*`（目標會移動，靠標記追）
  - HUD 目標列 / 互動提示沿用事件既有路徑：追車中 missions 目標列顯示倒數；`missions.nearest()` 回傳 `{ id: 'event:garbage-truck', text: '按 E 倒垃圾', priority: 3 }` 經 interactable 仲裁 → `hud.setInteractPrompt` / `setPrompts`；入帳 reason `'garbage'`
- 存檔：`missions.events`（§18 Phase 5 增補）同一欄，垃圾車以 id `'garbage-truck'` 併入 `completed` / `cooldowns`；進行中的追車不存檔（讀檔作廢、不發 fail）；統計同 `trackMissionStats`（complete → missionsDone、fail → missionsFailed）
- 音效：`audioState.garbageTruckDist` = `truckState().distM`（玩家到車體，無車 / 未知 = `Infinity`）；`audio/index.js` 在 `< TRUCK_ON`（220 m）開 `LOOPS.garbage_truck`（voices.js，《給愛麗絲》程序合成，**music 群組**），`≥ 235 m` 或非有限值關（遲滯）；未暫停時每幀 `ctrl.set(state, now)`（voices.js 依距離 `garbageTruckLevel` 調內部音量並排程音符），暫停時外層增益 0 且不排程
- 標記：`missions.markers()` 附 `{ x, z, kind: 'event-truck', label: '垃圾車' }`；色碼 `map/marker-colors.js` `'event-truck'`（#ff4f6d）；大地圖圖例「垃圾車」（圓點，不在 `PIN_KINDS`）；小地圖超出半徑時貼邊（hud.js `EDGE_KINDS`）

### 22.2 夜市攤車（`src/prop-model.js`；格式與 glb 契約見該檔頭與 public/models/props/manifest.json）
- API：`loadPropModels(manifestUrl?, { fetch? })` → `Promise<Map<id, entry>>`（只含 glb 載入成功者；缺 manifest → 空 Map，不報錯）、`createPropModel(id)` → Object3D | null、`propInfo(id)` → manifest 條目（`width / depth / height / counter?`）| null、`propEmissiveMaterials(id)` → 需登記夜間發光的共用材質、`placeProp(obj, { x, z, y, faceX, faceZ | yaw, anchor? })` → `{ x, y, z, yaw }`（本地 +Z 朝向 face 點；`propPlacement` / `propWorldPoint` 為純數學，node 可測）
- 整合（main.js）：啟動 `await Promise.all([loadCharacterModels(), loadVehicleModels(), loadPropModels()])`；`createPropModel('night_market_stall')` 非 null 時以 `stallPlacement(NIGHT_MARKET_DELIVERY.pickup, depth)` 擺位——取餐點（events.js pickup ≈ (557.2, −125.1)，新光三越北側、惠來路二段西側路緣外；19 時月光不被新光三越遮住，原道路中心點 (556.3, −107.9) 落在商場陰影裡已移出）最近的地面車道中心線點 → 垂直方向「半寬 + 1.2 m + 半個攤車深」的兩側候選（合格 = 不在車道上、不在步道上、離建築外牆 ≥ 3 m；合格者取離牆較遠的一側，都不合格退回第一側；目前選到惠來路西側 ≈ (557.2, −125.1)，與取餐點重合（距離 < 0.1 m，攤車＝取餐點）、19 時無月影、離最近建築外牆約 22 m），`faceX / faceZ` = 該道路點（+Z 顧客面朝道路）、`y = heightAt(x, z)`；`scene.add`；`propEmissiveMaterials` 逐一 `registerNight(m, m.emissiveIntensity || 1)`（同材質只登記一次）；物理世界建好後 `addStaticBox(RAPIER, pw.world, { ...placeProp 回傳, width, depth, height })`（`physics/colliders.js`：底面中心 + 半高、繞 Y 轉 yaw 的 cuboid，無父剛體、WORLD 組；各畫質皆有）
- 各畫質（含 low）都擺；**有碰撞體**（勘誤 I6c，原「無碰撞體」作廢）：WORLD 組靜態方塊，尺寸 `propColliderBox('night_market_stall', pl)`（半尺寸 1.11 / 1.52 / 0.78，見 §23.1）；glb 缺檔 → 不擺（外送照常）。Phase 6 起改為原攤車 + 兩款變體混擺，見 §24.1

### 22.3 互動提示與 tb-interact
- 車輛提示與互動提示互不覆蓋：見 §3.2 `setPrompts`；觸控 `tb-interact` 步行 / 駕駛有互動提示都顯示（§4.5 表）；直向駕駛位置在右半下車鈕下方（不落在左半轉向區 `#touch-pad`），見 §4.5 表

### 22.4 回歸
- `node tools/test/integration-gt.mjs`：main.js + loop.js + audio/index.js 靜態接線（routeFor / truckState / garbage_truck 車體 / garbageTruckDist / LOOPS.garbage_truck / loadPropModels / night_market_stall / placeProp / event-truck / simDt / setPrompts）、traffic.js CAR_TYPES 不含 garbage_truck；行為：main.js `garbageTruckRoute` / `stallPlacement` 原始碼抽出以假路網與真 citymodel 執行、colliders.js `addStaticBox`（假 RAPIER）、event:closed 改用 `eventRunning`、入帳 reason garbage「清運」、garbage-truck.js 接 routeFor 出現在玩家附近且 simDt = 0 不推進、audio 垃圾車 loop 開關 / 遲滯 / 暫停、色表 / 圖例 / 操作說明
- `node tools/test/hud.mjs`：`setPrompts` 並列 / 各自按鈕狀態、event-truck 小地圖貼邊；`node tools/test/combat-integration.mjs`：`self` polyfill 只包住車輛模型載入（見該檔頭註解）

### 22.5 檔案清單（G2）
- 前一批新增 / 修改：`src/missions/garbage-truck.js`（新）、`src/missions/index.js`、`src/audio/voices.js`（`LOOPS.garbage_truck`、`garbageTruckLevel`）、`public/models/vehicles/manifest.json`（garbage_truck）、`src/vehicle.js`（`VEHICLE_TYPES.garbage_truck`）、`src/vehicle-model.js`（`EMISSIVE_MATERIALS` 含 beacon）、`src/touch.js` / `src/hud.js` / `src/style.css`（tb-interact 駕駛也顯示）、`src/map/marker-colors.js`（新，共用色表）、`src/prop-model.js`（新）、`public/models/props/manifest.json`（新）
- 本批（整合）：`src/main.js`、`src/audio/index.js`、`src/hud.js`（`setPrompts`、`EDGE_KINDS` 加 event-truck）、`src/map/marker-colors.js`（event-truck）、`src/map/big-map.js`（圖例）、`src/core/actions.js`（說明列）、`docs/dev/interfaces.md`；測試 `tools/test/integration-gt.mjs`（新）、`tools/test/hud.mjs`、`tools/test/integration-p5.mjs`、`tools/test/combat-integration.mjs`

## 23. Phase 6 契約（K6 定稿，2026-10-01；單元 B6 / CS6 / E6 / P6，整合 I6）

原則沿用上文（參數注入、功能模組自帶 UI、共用樞紐只有整合單元改）。各小節格式：**現況（檔名:行號）→ Phase 6 定值 / 介面**。行號以 K6 撰寫當下的程式碼為準（改碼後會漂移，以符號名為主）。

### 23.1 夜市攤車碰撞盒（B6）

**現況**
- 擺放：`src/main.js:446-456`（`createPropModel('night_market_stall')` → `stallPlacement(NIGHT_MARKET_DELIVERY.pickup, info.depth)` → `placeProp`）；擺位函式 `src/main.js:332-356`、常數 `STALL_CURB_GAP` 1.2 / `STALL_WALL_GAP` 3 / `STALL_CLEAR_SCAN` 20（`src/main.js:119-121`）；取餐點 `src/missions/events.js:41`（557.2, −125.1，radius 12）
- 碰撞盒：`src/main.js:453` `stallBox = { ...pl, width: info.width, depth: info.depth, height: info.height }`（直接拿 manifest 外接盒尺寸）→ `src/main.js:469` `addStaticBox(RAPIER, pw.world, stallBox)`；`src/physics/colliders.js:248-255` 建 `cuboid(width/2, height/2, depth/2)`、平移 `(x, y + height/2, z)`、繞 Y 轉 yaw、WORLD 組，**無水平中心偏移參數**
- 尺寸來源：`public/models/props/manifest.json`（本工作目錄未附 public/；值取自測試）：depth 1.56（`tools/test/integration-gt.mjs:191`）、width 2.1 / depth 1.56 / height 3.04 → 半尺寸 [1.05, 1.52, 0.78]（`tools/test/integration-gt.mjs:243-247`）；counter（取餐檯）本地 [0, 0.95, 0.7]（`tools/test/props.mjs:35`）；glb 原點 = 外接盒中心正下方（`src/prop-model.js:5`）
- **文件矛盾**：§22.2 第一條（本檔 `docs/dev/interfaces.md:563`）寫物理世界建好後 `addStaticBox` 補靜態方塊，下一條（`docs/dev/interfaces.md:564`）卻寫「無碰撞體（純裝飾，玩家可穿過）」。程式碼（`src/main.js:469`）**有**碰撞體 → 以程式碼為準，564 行「無碰撞體」為過期敘述，Phase 6 起作廢。另一差異：遮雨棚實際比碰撞盒寬約 0.12 m（manifest width 2.1 未含遮雨棚外伸），車輛 / 玩家側面可穿進棚緣

**Phase 6 定值**（攤車本地座標，+Z = 顧客面，單位 m）
| 項目 | 值 | 說明 |
|---|---|---|
| 半寬 halfW（本地 X） | **1.11** | = 2.1 / 2 + 0.06（遮雨棚每側外伸 0.06，總寬 2.22 與棚同寬） |
| 半深 halfD（本地 Z） | **0.78** | = 1.56 / 2（維持；counter z 0.7 < 0.78，取餐檯仍在盒內緣，取餐判定用 radius 12 不受影響） |
| 半高 halfH | **1.52** | = 3.04 / 2（維持） |
| 中心偏移 | **(0, +1.52, 0)** | 相對 glb 原點（底面中心）：水平 0、垂直 = halfH；即現行 `y + height/2` |

- 實作：B6 在 `src/prop-model.js`（`propInfo` 旁，`src/prop-model.js:93-96`）新增匯出 `PROP_COLLIDERS = { night_market_stall: { halfW: 1.11, halfD: 0.78, halfH: 1.52, offX: 0, offY: 1.52, offZ: 0 } }` 與 `propColliderBox(id, placement)` → `{ x, y, z, yaw, width, depth, height }`（offX / offZ 依 yaw 轉到世界、y = placement.y + offY − halfH，交給既有 `addStaticBox`；未知 id → 退回 manifest 外接盒；node 可測）。`src/physics/colliders.js:248` **不改**
- 接線：`src/main.js:453` 改為 `stallBox = propColliderBox('night_market_stall', pl)`（一行；main.js 屬 I6 → B6 交接線說明，I6 改；`stallPlacement(…, depth)` 的 depth 維持 manifest depth 1.56，不改擺位）
- 文件：B6 交付時把本檔 §22.2 第 564 行改為「有碰撞體（WORLD 組靜態方塊，尺寸見 §23.1）；各畫質（含 low）都擺；glb 缺檔 → 不擺（外送照常）」
- 測試：`tools/test/p6-b6.mjs` 檢查 `propColliderBox` 半尺寸 [1.11, 1.52, 0.78]、yaw 0.7 時中心 = placement + 旋轉後偏移；`integration-gt.mjs:243` 原 addStaticBox 案例不動

### 23.2 鏡頭與設定（CS6）

**現況**
- 鏡頭距離：`src/camera.js:44-51` `WALK_DISTS = [2.7, 4.1, 6.0]`、`CAR_DISTS = [5.2, 6.4, 8.9]`、`BIKE_DISTS = [4.3, 5.0, 6.0]`、`DEFAULT_VIEW = 1`、滾輪範圍 `WALK_DIST_MIN 2.5` / `WALK_DIST_MAX 12`、`CAR_REF_SCALE 1.35`；段位狀態 `rig.walkView` / `rig.driveView` / `rig.dist`（`src/camera.js:91-93`）；駕駛距離 = 段位 × distScale / ref + 速度拉遠 ≤ 1 m（`src/camera.js:124-131`）
- V 鍵：`src/core/actions.js:18` `camera: KeyV`、說明列 `src/core/actions.js:103`；`src/main.js:1499` `cycleView: snap.pressed.camera` → `src/camera.js:145-150` 循環段位（步行同時把 dist 重設為段位值）
- 滾輪：`src/input.js:132-136` 累加 `wheel`（±300 / 事件）；`src/camera.js:151` 步行 `dist *= 1 + wheel × 0.001` 夾 2.5–12；駕駛不吃滾輪；`src/main.js:1491` 瞄準中 `input.wheel = 0`
- 鏡頭碰撞：`src/camera.js:32-35` `CAM_GROUND_CLEAR 0.4`、`CAM_RADIUS 0.35`、`MIN_FRAC 0.05`；`src/camera.js:228` `collision.sweep(t, desired, CAM_RADIUS)` + 地形取樣；`src/camera.js:246-248` 拉近立即、拉遠 `DIST_EASE` 4/s
- **段位不持久化**：`CameraRig` 無 setter，每次載入回 `DEFAULT_VIEW`
- 設定：`src/core/settings.js:12-29` `SETTINGS_SCHEMA`（已含 `lookSensMouse` / `lookSensTouch` 0.3–3.0 step 0.1 預設 1.0、`invertY` 預設 false）；儲存鍵 `tcgta.settings.v1`（`src/core/settings.js:7`）；載入 `loadInitial`（`src/core/settings.js:106-133`：先取全預設、再逐鍵 `normalizeSetting` 覆蓋 → 缺鍵 = 預設、非法鍵 = 預設）；`createSettings` → `get / set / getAll / reset / subscribe`（`src/core/settings.js:135-191`）
- 接線：`src/main.js:519-520` 開局 `input.setSensitivity` / `setInvertY`；`src/main.js:1186-1189` `settings.subscribe` 即時套用；`src/input.js:214-221` `setSensitivity` / `setInvertY`
- 選單：`src/ui/menu.js:19-45` `SETTING_ROWS`（`lookSensMouse` / `lookSensTouch` range、`invertY` toggle 在 33-35）；segment 型以 `options[i][0]` 值循環（`src/ui/menu.js:352-356`，數值 option 可用）；`src/ui/menu-model.js:20-27` 頁籤；存檔 `src/save.js` **不含設定**（§6 末條，`src/save.js:21` defaultSave 無 settings 欄）

**Phase 6 定值**（全部存在 `tcgta.settings.v1` 的 `SETTINGS_SCHEMA`，不新增儲存鍵、不升 `SAVE_VERSION`）
| 鍵 | 型別 / 範圍 | 預設 | 說明 |
|---|---|---|---|
| `lookSensMouse` / `lookSensTouch` | number 0.3–3.0 step 0.1 | 1.0 | **沿用既有鍵**＝「視角靈敏度」，不另開 `lookSens`（避免與現有遷移衝突） |
| `invertY` | boolean | false | 沿用既有鍵 |
| `camWalkView`（新） | number 0–2 step 1 | 1 | 步行段位 → `WALK_DISTS` 0/1/2 = 2.7 / 4.1 / 6.0 m |
| `camDriveView`（新） | number 0–2 step 1 | 1 | 駕駛段位 → 汽車 `CAR_DISTS` 5.2 / 6.4 / 8.9、機車 `BIKE_DISTS` 4.3 / 5.0 / 6.0（再乘 distScale / ref） |

- 型別用 `type: 'number', min: 0, max: 2, step: 1`（`normalizeSetting` 自動四捨五入到整數、clamp；1.4 → 1、5 → 2、'1' → 非法）；label `'步行鏡頭距離'` / `'駕駛鏡頭距離'`
- 讀寫函式：讀 `settings.get('camWalkView')`、寫 `settings.set('camWalkView', i)`（回 boolean）；舊存檔缺欄位 → `loadInitial` 給預設 1（不需遷移碼）；`settings.reset()` 一併回 1
- 鏡頭 API（CS6，`src/camera.js`）：新增 `rig.setViews({ walk, drive })`（非 0–2 整數忽略；walk 同時把 `rig.dist` 設為 `WALK_DISTS[walk]`）、`rig.getViews()` → `{ walk, drive }`；`update` 內按 V 後若段位改變呼叫 `opts.onViewChange?.(kind: 'walk'|'drive', index)`（同幀最多一次）。滾輪微調仍只改 `rig.dist`、**不持久化**（下次載入回段位值）；常數表與碰撞參數 Phase 6 不改
- 整合（I6，`src/main.js`）：建 rig 後 `rig.setViews({ walk: settings.get('camWalkView'), drive: settings.get('camDriveView') })`（`src/main.js:523` 附近）；`rig.update` opts 加 `onViewChange: (k, i) => settings.set(k === 'walk' ? 'camWalkView' : 'camDriveView', i)`；`settings.subscribe` 分支加兩鍵 → `rig.setViews`
- 選單（CS6，`src/ui/menu.js` SETTING_ROWS，插在 `invertY` 後）：`{ key: 'camWalkView', type: 'segment', label: '步行鏡頭', options: [[0, '近'], [1, '中'], [2, '遠']] }`、`camDriveView` 同格式；V 鍵改段位後選單重開時顯示新值（refreshSetting 已訂閱）
- 測試：`tools/test/p6-cs6.mjs`（schema 兩鍵、缺鍵預設 1、非整數正規化、`setViews` / `getViews` / onViewChange、選單列存在）；既有 `camera.mjs` / `menu.mjs` / `core.mjs` 須照過

### 23.3 遊戲內手機（P6 做模組、I6 接線）

**現況**
- 鍵位：`src/core/actions.js:24` `phone: KeyT, reserved: true`（預留、不在說明表）；`input.snapshot().pressed` 無 phone
- 觸控：`src/touch.js:51` `tb-phone`（KeyT、slot `tl3`、`hidden: true`）與 `src/touch.js:53` `tb-guide`（slot `tl3`）**同格**——`src/touch.js:15-16` 註明「日後啟用須另排位置」；左上小鈕 CSS `src/style.css:1197-1229`（tl1–tl3）
- 既有面板機制：`src/main.js:840` `panelOpen()`（missions modal / 大地圖 / 圖鑑）→ `src/main.js:1286-1302` `syncPanels`：開啟 → `input.enabled = false`、`releaseLock()`、清提示、駕駛中手煞；`src/main.js:1376` `updateGame` 在面板開啟時 **直接 return（世界暫停）**；Esc / 同鍵關閉由 window keydown capture 處理（`src/main.js:1304-1318` `onPanelKey`、`src/ui/menu.js:497-512` `onKey`）
- 大地圖：`bigMap.open()` / `close()` / `toggle()` / `isOpen()`（§17；`src/main.js:1385` M 鍵開啟）；設定頁：`menu.openPause('settings')`（`src/ui/menu.js:694-707`，tab ∈ `PAUSE_PAGES` `src/ui/menu-model.js:24`）
- `src/mobile.js:138` `isInputBlocked()`（直向提示 / 全螢幕遮罩）；`src/input.js:152-160` `enabled = false` 清空所有按住狀態並通知觸控層釋放指標

**介面**（`src/ui/phone.js` + `src/ui/phone.css`；class / id 前綴 `ph-`；z-index 80–89 的 **80**（全螢幕面板層，只在遊戲中開））
```
createPhone({ root, bus, doc = globalThis.document, keyTarget = window, isTouch = false,
              onOpenMap, onOpenSettings, onNavigate, now }) →
  { open(app?: 'home'|'jobs'|'map'|'settings'), close(), toggle(), isOpen() → boolean,
    update(dt), setData(data), destroy(), get app() }
setData({ hour, weatherIcon, money?, jobs })   // 每幀或節流呼叫皆可；只存參照、不配置
  hour：dayNight.hour（0–24 浮點，手機顯示 HH:MM）
  weatherIcon：weather.getState().icon（'sun'|'rain'|'fog'）
  jobs：[{ id, title, category: 'nearby'|'mission'|'job', reward, distanceM, navigable, x, z, active }]
```
- 生命週期：`open()` 冪等；**無指定 App 時先顯示鎖屏**（時鐘 / 天氣，`LOCK_SEC` 0.8 s 渲染時間後自動解鎖，點一下或任何非返回操作立即解鎖；`open(app)` 指定 App 則不鎖屏直接進該 App；勘誤 I6c）；開啟時 `bus.emit('ui:sound', { kind: 'open' })`、`bus.emit('phone:open', {})`；`close()` 冪等、emit `phone:close`；`update(dt)` 用**渲染 dt**（只做 UI 動畫 / 時鐘刷新，§20 屬渲染時間）；`destroy()` 移除 DOM 與 listener
- **不暫停模擬**：手機**不得**列入 `panelOpen()`（否則 `updateGame` return、世界停）。I6 另寫 `syncPhone()`：`phone.isOpen()` 轉真 → `input.enabled = false`（沿用既有 `enabled` 清空機制，等同鎖住移動 / 射擊 / 上下車 / 互動 / 視角）、`releaseLock()`、駕駛中 `setControls(driveControls({x:0,y:0}, true))`；轉假 → `input.enabled = true`。世界 / 車流 / 任務計時照常吃 simDt（委託倒數不因開手機停止——預期行為）
- 關閉：Esc、KeyT、手機內「返回」鈕（app 頁先回 home，home 再按 = 關閉）；phone.js 自己在 `keyTarget` 註冊 keydown **capture**，處理後 `preventDefault` + `stopPropagation`（同 `onPanelKey` 作法），因此 Esc 不會同時開暫停選單
- 互斥：I6 只在 `state.started && !state.paused && !panelOpen() && !menu.isOpen()` 時開手機；手機開啟中按 M / 選單鍵由手機吞掉；開大地圖 / 設定前先 `phone.close()`
- 開啟入口：桌機 `input.actions.pressed('phone')`（CS6 把 `src/core/actions.js:24` `reserved` 拿掉並補 `KEYMAP_HELP` / `TOUCH_HELP` 列「T 手機」，`core.mjs` 一致性檢查）；觸控 I6 在 `src/touch.js` `SLOTS` 加 `tl4`（`src/style.css` 加 `.tbtn.slot-tl4`，x 接 tl3 右側 +56 px、≥ 44 px），`registerTouchButton({ id: 'tb-phone', label: '手機', slot: 'tl4', showWhen: 'always', onTap: () => openPhone() })` 重新註冊顯示（同 tb-guide 作法 `src/main.js:849`）
- 三個 App：**任務**（列 `jobs`，依 category 分「附近 / 委託 / 打工」三段，點「導航」→ `onNavigate(item)`；`navigable` 假時按鈕停用）；**地圖** → `onOpenMap()`（I6：`phone.close(); bigMap.open(); syncPanels()`）；**設定** → `onOpenSettings()`（I6：`phone.close(); menu.openPause('settings')`）
- I6 注入：`onNavigate: (it) => nav.setDestination(it.x, it.z, it.title, 'phone', playerPos)`；`setData` 的 `jobs` = `missions.listings(focus)`（§23.4）；`hour` / `weatherIcon` 同上
- 新事件（加進 §1 表）：`phone:open` `{}`、`phone:close` `{}`（發出者 phone.js）
- 測試：`tools/test/p6-p6.mjs`（假 DOM：open / close / isOpen 冪等、Esc 關閉且 stopPropagation、setData 後任務 App 分三類、navigable false 停用、onOpenMap / onOpenSettings 呼叫一次）

### 23.4 打工委託（E6，`src/missions/**`）

**現況**
- 目錄：`src/missions/catalog.js:16-55` `BUILTIN_MISSIONS`（`{ slug, name, file, title, client, brief, from, to, timeLimitSec, reward, conditions }`，無 category）、`normalizeCatalog` `src/missions/catalog.js:133`、`loadCatalog` `:161`
- 時段事件：`src/missions/events.js:37-47` `NIGHT_MARKET_DELIVERY`（window 18–24、cooldownSec 180、pickup radius 12）、`createTimedEvents` `:78`
- 互斥：`src/missions/index.js:138` `evActive`、`:145` 垃圾車 `isBusy: () => !!run || evActive()`、`:147` `truckEngaged`；委託進行中不開放事件、事件進行中不開放委託（檔頭 `src/missions/index.js:12`）→ **同時只能一個進行中**
- 冷卻：委託 `COOLDOWN_SEC` 120（`src/missions/index.js:33`），`now()` = main.js `gameTime`（`src/main.js:745`，`gameTime += simDt` 於 `src/main.js:1147`）→ 已是模擬時間
- 統計：`MISSION_STAT_EVENTS` / `trackMissionStats`（`src/missions/index.js:46-75`）；結算 `settleReward`（`:85`）、`addMoney(n, reason)`；HUD 跳字前綴 `src/hud.js:56` `MONEY_REASON_LABEL`
- 標記：`markers()` → `{ x, z, kind, label }`；色表 `src/map/marker-colors.js:3-13`；互動 `nearest(pos)`（`src/missions/index.js:511`）
- 每幀：`src/main.js:1483` `missions.update(worldStep.simDt, missionCtx)`（ctx `{ x, z, driving }`）
- 存檔：`serialize` / `restore`（`src/missions/index.js:701` / `:762`）；`missions.events` 欄（§18 Phase 5 增補）

**Phase 6 介面**
- 新檔 `src/missions/jobs.js`：`createJobs({ bus, now, rng, addMoney, getGameHour, spots, isTouch, interactLabel })` → `{ update(simDt, ctx), nearest(pos), markers(), objective(), active(), listings(pos, out), isEngaged(), abandon(), serialize(), restore(data), dispose() }`；由 `createMissions` 建立並合併（同垃圾車模式），整合層只碰 `createMissions`
- **類別欄位**：所有可列表項帶 `category`：catalog 委託正規化時補 `category: 'mission'`（manifest 可省略）；時段事件 / 垃圾車 = `'nearby'`；打工定義 = `'job'`。`JOB_DEFS = [NIGHT_MARKET_RUN, VALET_PARKING]`，每筆 `{ id, category: 'job', title, window?, cooldownSec, failCooldownSec, … }`
- `missions.listings(pos, out = [])` → `[{ id, title, category, reward, distanceM, navigable, x, z, active }]`（重用 out；reward = 預估值；`navigable` = 有座標且目前沒有其他進行中工作；給 §23.3 手機）
- 互斥：打工加入同一把鎖——`isBusy = !!run || evActive() || truckEngaged() || jobs.isEngaged()`；打工進行中隱藏委託起點 / 取餐點、垃圾車不出現；他者進行中打工不開放
- 計時：`jobs.update` 的時限 / 停妥維持 / 離車計時一律累加 **simDt**（§20）；冷卻用 `now()`（= gameTime，同屬模擬時間）
- 事件（加進 §1 表）：`job:available { id, title, x, z }`、`job:start { id, title, limitSec }`、`job:stage { id, stage, text, x, z }`、`job:complete { id, reward, timeSec, leftSec }`、`job:fail { id, reason }`；`MISSION_STAT_EVENTS` 增 `'job:complete' → missionsDone`、`'job:fail' → missionsFailed`（不新增 stats 欄位，save.js 不改）
- 結算：`addMoney(n, 'job')`；I6 在 `src/hud.js:56` 加 `job: '打工 '`
- 標記 kind：`'job-start'`、`'job-dest'`、`'job-car'`（E6 改 `src/map/marker-colors.js` 與 `src/map/big-map.js MARKER_LABELS`；`job-dest` 加入 `PIN_KINDS`；hud.js `EDGE_KINDS` 加 `job-car` 由 I6）
- 存檔：不升版。打工狀態併入 `missions.events`（`{ completed: { 'night-market-run': n, 'valet-parking': n }, cooldowns: { … } }`，id 不與既有事件重複）；`index.js restore` 依 id 分流給 events / truck / jobs；進行中打工不存檔（讀檔作廢、不發 fail）
- 注入（I6，`createMissions({ …, jobSpots, spawnValetCar, releaseValetCar, healthOf })`；夜市跑單缺 `stall` / `stallBack` / `sidewalkNear` → 跑單不作用；泊車缺 `valet` / `spawnValetCar` / `releaseValetCar` → 泊車不作用；`healthOf` 選填（缺 → 損壞比 0）；實際接線見 §24）：
  - `jobSpots = { stall: { x, z, yaw }, stallBack: { x, z }, sidewalkNear(x, z, rng, minM, maxM) → { x, z } | null, valet: [{ id, standX, standZ, carX, carZ, carYaw, slotX, slotZ, slotYaw }] }`；`stall` = §23.1 placeProp 回傳、`stallBack` = `propWorldPoint([0, 0, -(0.78 + 0.6)], pl)`（攤主側）
  - `spawnValetCar({ x, z, yaw }) → vehicle`（I6 以 `vehicles.adopt` 實作）、`releaseValetCar(vehicle)`（結束後轉為路邊停放）、`healthOf(vehicle) → number`（I6 包 `dmg.healthOf`；車毀判定 = `vehicle:disabled` 或 `healthOf === 0`）
  - update ctx 擴充：`{ x, z, driving, vehicle: 駕駛中的 Vehicle | null }`
- **夜市跑單** `NIGHT_MARKET_RUN`：window 18–24；起點 = `stallBack` 2.5 m 內按 E（與外送取餐點 radius 12 重疊時，`nearest()` 在 2.5 m 內優先打工）；隨機 2–3 位客人（`sidewalkNear(stall.x, stall.z, rng, 40, 160)`——簽名 `(x, z, rng, minM, maxM)`，勘誤 I6c；每位最多要 8 次點、彼此 ≥ 20 m，湊不到 2 位不接單）；**只限步行**：`ctx.driving` 連續 > 3 s → fail `'vehicle'`；每位客人 3 m 內按 E 送達；時限 = Σ 路段直線 × 1.3 / 3.5 m/s + 20 s；報酬 = 每位 80 + 0.25 × 路段 m，全送完加剩餘秒 × 1；失敗 `'timeout'|'vehicle'|'ko'|'abandon'`；冷卻 150 s、失敗 60 s
- **代客泊車** `VALET_PARKING`：不限時段；起點 = valet stand 按 E → `spawnValetCar` 於 car 位姿（**指定車辨識 = 回傳的 vehicle 物件參照**，`ctx.vehicle === job.car`；標記 `job-car`）→ 上車後顯示 `job-dest`（slot）
  - 停妥條件（同時成立且維持 1.0 s 模擬時間）：車中心到 slot 中心 ≤ 1.2 m；`|angleDelta(car.yaw, slotYaw)|` ≤ 15°；`|car.speed|` ≤ 0.5 m/s；玩家正駕駛該車
  - 失敗：車毀（訂閱 `vehicle:disabled` 且 `vehicle === job.car`）→ `'destroyed'`；逾時（時限 = 路線長 / 8 m/s + 45 s）→ `'timeout'`；玩家不在車上且與車距離 > 40 m 持續 5 s → `'lost'`；`'ko'` / `'abandon'` 同委託
  - 報酬 = 300 × (1 − 損壞比 × 0.7) + 剩餘秒 × 2；損壞比由注入 `healthOf(vehicle)`（I6 包 `dmg.healthOf`）讀；結束 `releaseValetCar`；冷卻 120 s、失敗 60 s
- 測試：`tools/test/p6-e6.mjs`（互斥、category、listings、跑單 2–3 客、駕駛 3 s 失敗、泊車停妥 / 角度 / 速度門檻、三種失敗、simDt = 0 不推進、120/144 Hz 子步等價、serialize 併入 events）

### 23.5 第 1 批共用檔案責任表

四單元（B6 / CS6 / E6 / P6）檔案集**兩兩不相交**；「其他可改」= 否 表示其他單元只能 import / 讀。I6（整合）在四單元之後。

| 檔案 | 擁有者 | 其他單元可改 | 備註 |
|---|---|---|---|
| `src/player.js` | B6 | 否 | 刪無物理模式死碼（約 `:294` 起的 `update` 非物理分支） |
| `src/vehicle.js` | B6 | 否 | 刪死碼（約 `:397` 起的舊 `update(dt, ctrl, collision, …)`）；`adopt` 介面不變（E6 經 I6 注入使用） |
| `src/prop-model.js` | B6 | 否 | §23.1 `PROP_COLLIDERS` / `propColliderBox` |
| `src/missions/garbage-truck.js` | B6 | 否 | 警示燈夜間自發光（如需閃爍，匯出純函式 `beaconLevel(t, night)`，I6 套到材質） |
| `tools/test/framerate-invariance.mjs` | B6 | 否 | >60 Hz 計時測試擴充（或另開 p6-b6.mjs） |
| `src/camera.js` | CS6 | 否 | §23.2 setViews / getViews / onViewChange |
| `src/core/settings.js` | CS6 | 否 | `camWalkView` / `camDriveView` |
| `src/core/actions.js` | CS6 | 否 | `phone` 取消預留 + 說明列（P6 不改） |
| `src/input.js` | CS6 | 否 | 如需 snapshot 加 `pressed.phone` |
| `src/ui/menu.js`、`src/ui/menu-model.js`、`src/ui/menu.css` | CS6 | 否 | SETTING_ROWS 兩列 |
| `src/missions/index.js`、`catalog.js`、`events.js`、`ui.js`、`missions.css`、`light-pillar.js`、`jobs.js`（新） | E6 | 否 | events.js / index.js B6 **不需要改**；若 B6 實作中發現必須改 → 「序列：B6 先」，E6 在 B6 合併後再動 |
| `src/map/marker-colors.js`、`src/map/big-map.js` | E6 | 否 | job-* 色表 / 圖例 |
| `src/ui/phone.js`（新）、`src/ui/phone.css`（新） | P6 | 否 | 不改 main.js / actions.js |
| `src/main.js`、`src/core/loop.js`、`src/hud.js`、`src/touch.js`、`src/mobile.js`、`src/style.css` | I6 | 否 | 攤車 `main.js:453`、rig setViews、syncPhone、tb-phone `tl4`、createMissions 注入、`MONEY_REASON_LABEL.job`、`EDGE_KINDS` |
| `src/save.js`、`src/physics/colliders.js`、`src/missions/` 外其他檔 | 無（凍結） | 否 | 本批不改；需要改先回報主控 |
| `docs/dev/interfaces.md` | I6（各單元只改自己負責的 §22.2 第 564 行 / §23 子節勘誤，於 FINDINGS 註明） | 限本表註記 | |
| `tools/test/run-all.mjs`、`package.json` | 經理 / I6 | 否 | 見下 |

- 跨單元依賴（介面先行、實作可平行）：P6 只依 §23.3 簽名，不 import missions；E6 的 `listings` 由 I6 餵給 phone；B6 的 `propColliderBox` 由 I6 接到 `main.js:453` 與 `jobSpots.stall`
- 序列：B6 與 E6 檔案集無交集（攤車擺放 `stallPlacement` 在 main.js 屬 I6、取餐點常數在 events.js 屬 E6 唯讀給 B6），**目前無需序列**；唯一可能交集 `src/missions/events.js` / `index.js` 若 B6 需要 → 序列：B6 先
- 測試命名：`tools/test/p6-b6.mjs`、`p6-cs6.mjs`、`p6-e6.mjs`、`p6-p6.mjs`、整合 `p6-i6.mjs`；各單元只新增自己的測試檔、可修改自己擁有的模組對應的既有測試
- **run-all 自動掃描**：`tools/test/run-all.mjs:14-17` `readdirSync(testDir).filter(f.endsWith('.mjs') && f !== 'run-all.mjs').sort()` → 新增的 `p6-*.mjs` 放進 `tools/test/` 即自動被 `npm run test:all` 執行，**不需登錄**；`package.json` 個別 `test:*` script 為選用，由經理 / I6 統一加（各單元不改 package.json）


## 24. Phase 6 整合接線摘要（I6a / I6b / I6c；接線點在 `src/main.js`，細節以各檔頭為準）

- **I6a 鏡頭 / 攤車碰撞 / 警示燈**：建 rig 後 `rig.setViews({ walk: settings.get('camWalkView'), drive: settings.get('camDriveView') })`、`rig.update` opts `onViewChange` 寫回 settings、`settings.subscribe` 兩鍵 → `rig.setViews`；觸控 `tb-view`（KeyV、slot `view`）；HUD 段位提示 `src/ui/cam-view-hint.js`（「鏡頭：近 / 中 / 遠」1.2 s 渲染時間）；攤車碰撞 = `propColliderBox`（§23.1）；垃圾車 beacon 走 `applyBeacon`（§22.1 勘誤）、`missionCtx.night = dayNight.night`
- **I6b 手機**：`src/ui/phone-link.js`（`canOpenPhone` 互斥、`createPhoneLink` 開關 / 鎖輸入 / 每幀 `fillData`）；T = `input.actions.pressed('phone')`、觸控 `tb-phone`（slot `tl4`）；手機不列入 `panelOpen()`；`setData.jobs = missions.listings(focus, 重用陣列)`
- **I6c 打工委託**（本節下列各條）；回歸 `tools/test/p6-i6a.mjs`、`p6-i6b.mjs`、`p6-i6c.mjs`

### 24.1 夜市攤位（`src/job-props.js` `stallRow`，main.js 逐格擺）
- 道具一律以 manifest 鍵名指定：`STALL_ROW` = `night_market_stall`（slot 0，即 §22.2 `stallPlacement` 原位，夜市外送取餐點旁）、`night_market_stall_oyster`（slot +1）、`night_market_stall_tea`（slot −1）；沿攤車本地 X（平行路緣）每格 `STALL_ROW_PITCH` 2.72 m（碰撞盒寬 2.22 + 走道 0.5）、同一 yaw（+Z 朝道路）；目前三格 ≈ (557.17, −125.12) / (558.61, −127.42) / (555.73, −122.81)，皆不在車道 / 步道上、離建築 ≥ 3 m
- 退回：`resolvePropKey(key, has, 'night_market_stall')`——變體缺 glb → 該格擺原攤車；原攤車也缺 → 該格不擺、無碰撞體（座標照算，外送 / 打工照常）；`has` = `loadPropModels()` 回傳 Map（只含載入成功者）
- 碰撞：每個擺出的格 `propColliderBox('night_market_stall', pl)`（變體車架同原攤車），物理世界建好後與泊車亭盒一起 `addStaticBox`；夜間發光逐鍵 `propEmissiveMaterials(key)` → `registerNightOnce`
- 夜市跑單接單攤 = oyster 那一格（`runStallSpot`；缺該格 → slot 0）：`jobSpots.stall` = 該格 pl、`stallBack` = `propWorldPoint([0, 0, −1.38], pl)` ≈ (557.44, −128.16)（離外送取餐點 3.1 m，取餐 radius 12 內；2.5 m 內打工優先）
- `takeout_bag`：接單攤有擺且 bag glb 有載入時，掛 2 個在攤車本地 `TAKEOUT_BAG_LOCAL`（檯面 y 0.88）；`missions.jobs.isOpen('night-market-run')` 時顯示（開放接單）、其餘隱藏（`syncTakeoutBags` 每幀，在 `missions.update` 之後）；**未做手持**（右手插槽給武器用，見 FINDINGS）；bag 缺 glb → 無袋

### 24.2 代客泊車亭與車輛轉接
- 位置 `VALET_SITES`（job-props.js，地圖選點）：`tiger-city`——亭 (37.24, 64.27)，正面朝河南路三段西側車道（老虎城側、單行北上）道路點 (44.11, 68.31)，離出生點約 40 m；接單點 = counter 世界座標 ≈ (37.94, 65.18)；客人車 (37.50, 70.22, yaw −0.53)（亭前方 5 m 路邊、順向貼路緣，離路邊停放車 ≥ 26 m）；車格 (−111.57, −95.97, yaw 2.61)（朝富路東側南向車道路邊，林酒店側，直線約 218 m，離路口 ≥ 50 m）
- `valetSpots(VALET_SITES, heightAt, propInfo('valet_stand')?.counter)` → `jobSpots.valet`（§23.4 欄位 + `pl`）
- 模型：`valet_stand` 有 glb → `createPropModel`；缺 → `buildValetStandFallback(THREE)`（亭身 / 屋頂 / 立牌桿 / 立牌面）。發光材質同攤車登記
- 碰撞（**只取亭身**）：`valetStandBoxes(pl)` 一個盒，`VALET_BOOTH` 本地中心 (−0.61, 1.25, −0.22)、半尺寸 0.65 / 1.25 / 0.55（亭 1.3 × 1.1、牆 2.25 + 屋頂）；本地 X 右緣 +0.04，立牌（+X 端）與兩者間空隙不擋；不用 2.52 × 1.54 外接盒
- `spawnValetCar(p)`：先移除同亭客人車位 / 車格 4 m 內（`VALET_CLEAR_M`）、無人駕駛的上一趟泊車車 → `vehicles.adopt({ type, color, x, z, yaw })`（`VALET_CAR_LOOKS`：轎車 / 休旅，不含機車與大車）→ `dmg.attach`；`releaseValetCar(v)`：無人駕駛 → 拉手煞（靜止後 `VehicleManager._park` 轉 kinematic 停放）、加入 `adopted`（玩家離開 `ADOPTED_FAR` 200 m 後回收）；`healthOf: (v) => dmg.healthOf(v)`
- `missionCtx = { x, z, driving, vehicle, night }`：`vehicle` = 駕駛中的 `state.vehicle`（步行 null），`missions.update(worldStep.simDt, missionCtx)` 前每幀寫入

### 24.3 客人點 / HUD / 手機 / 時間步
- `jobSpots.sidewalkNear = createSidewalkNear({ nearestRoadPoint, onRoadSurface, buildingAt, inBounds })`：隨機方向 / 距離 → 最近地面車道中心線點 → 往取樣側推到路緣外 1.5 m；合格 = 距離在 [minM, maxM]、不在車道、不在建築、在範圍內；6 次不合格 → null
- hud.js：`MONEY_REASON_LABEL.job = '打工 '`、`EDGE_KINDS` 加 `'job-car'`
- 手機任務 App「打工」分頁：注入 jobSpots 後 `missions.listings` 帶 `category: 'job'` 項（開放中的夜市跑單 / 代客泊車，或進行中那一筆），經 I6b `fillData` → `phone.setData({ jobs })`
- events.js（夜市外送）`update` 在 `step <= 0`（本幀無子步）時只刷新位置 / 時刻後早退，不做開放 / 抵達 / 逾時判定（同 garbage-truck.js）
- 垃圾車仍只走純視覺車體，traffic `CAR_TYPES` 不含 garbage_truck；泊車車輛是一般 `VehicleManager` 車（不進車流）

## 25. 選單運鏡巡覽（M6；`src/ui/menu-tour.js`，接線點在 `src/main.js`）

未進入遊戲（開始畫面、回到主選單）時鏡頭以電影式運鏡循環巡覽全區，取代原「出生點環繞」。模組純邏輯（只 import `geom.js`），細節以檔頭為準。

- **鏡位**（`tourStops`，全部由資料推導）：Tiger City / 新光三越 / 臺中國家歌劇院 / 市政府（臺灣大道市政大樓）/ 捷運市政府站 = citymodel `namedBuildings` 依名稱比對（同名取面積最大）的輪廓中心、OSM 高度、`terrain.buildingBase`；秋紅谷 = `osm.T.basins` 輪廓中心；夜市攤車 = `stallRow` 原攤車格 `pl`（缺 → `NIGHT_MARKET_DELIVERY.pickup`）。資料缺者略過。順序 = 老虎城起點的最短封閉迴圈
- **型態**：`SHOT_TYPES` orbit 12 s / dolly 9 s / crane 10 s / road 11 s 依序輪替（road = 最近主要道路中心線上方 `ROAD_ALT` 10 m、14 m/s）；段間 Hermite 滑行（位置與速度 C1 連續、弧頂加高），秒數 = 距離 ÷ 45 m/s，夾 4–14 s；目前一輪約 138 s
- **不穿地 / 不穿建物**：載入時以 10 Hz 取樣整輪，水平與看點循環平滑 1.2 s；高度 ≥ `floor` = max(地形（湖面取較高）+ `SAFE_CLEAR` 4 m, 水平 10 m 內建築頂 + 6 m)，並以 ≤ 12 m/s 的前後向包絡提早爬升；執行期 Catmull-Rom 內插、不配置物件
- **時間步（§20）**：巡覽計時屬**渲染時間**——`update(dt)` 吃 `core/loop.js` 的渲染 `dt`（≤ `MAX_FRAME_DT`），不吃 `simDt`；卡頓丟子步時運鏡不變慢、與幀率無關（30 / 60 Hz 同時刻同鏡位）。暫停 / 切背景時 loop 不呼叫 `updateAttract`，計時停住。世界照常：`updateAttract` 仍為 `dayNight.update → stepWorld → updateEnvironment(dt, worldStep.simDt)`，模擬部分照舊吃 simDt；center 改為巡覽看點（`attractFocus`，原為老虎城中心）
- **進出遊戲**：`startGame` → `tour.stop()`；`updateGame` 在 `rig.update` 之後 `tour.handoff(dt)`；`quitToMenu` → `tour.start()`（時間接續）。不讀寫存檔、不碰遊戲狀態。內插方式（M6F）：
  - **平滑內插**（距離 ≤ `HANDOFF_FADE_DIST` 300 m）：秒數 = 距離 ÷ 80 m/s（夾 1–2.5 s），水平 smoothstep、四元數 slerp；高度在開始內插時沿預定水平路徑建 90 格剖面（原高度曲線〔out 後半程才下降 / in 先升高〕與沿途 `floor` 取大、兩端 `HANDOFF_MASK_R` 12 m 內不套 floor），再做 `HANDOFF_VRATE` 90 m/s 的上包絡（提早爬升 / 延後下降）並與兩端點出發的同速率錐取小 → 相鄰幀高度變化 ≤ 1.5 m（60 Hz）且不低於 floor；速率不夠時把秒數拉長（≤ 2.5 s）。回主選單時目標 = 巡覽路徑（依時間預測），結束後不再動鏡頭
  - **淡出淡入**（距離 > 300 m，或 2.5 s 內滿足不了 90 m/s 高度速率）：`FADE_SEC` 0.6 s——前 0.3 s 停在起點淡出到全黑、全黑那一幀切到目標（玩家鏡頭 / 巡覽當前鏡位）、後 0.3 s 淡入；被打斷時由當下淡出量接續。黑幕 = main.js 建的最小 DOM 元素 `#tour-fade`（全螢幕黑、`pointer-events:none`、z-index 8：蓋 3D 畫面、在 HUD 10 與選單 70 之下），經 `opts.fade(alpha)` 寫 `opacity`；模組本身不碰 DOM（`fading` / `fade` / `blendSec` 可讀）
- **取景（M6F）**：orbit / dolly / crane 在 `makeShot` 做看點視線遮擋檢查（`makeOcclusion` + `shotOcclusion`）：每段取 7 幀 × 5 條射線（看點、頂 90%、底 20%、左右兩側 50% 高）每 4 m 取樣，落在其他建築（同名地標各棟不算）輪廓內且低於屋頂即算被擋；方位角以朝最近道路為預設、每 22.5° 一個候選（環繞另加半徑 ×1 / ×1.4、高度 +0 / +20 m），取遮擋率最低者（要少 > 2% 才換）。目前老虎城環繞起始方位 30° → −36°（原 43% → 0%）、捷運市政府站環繞 32° → 145° 且高 35 → 55 m（原 40% → 0%）。有輪廓且高 ≥ 10 m 的推軌：整條軌道離立面 ≥ max(`DOLLY_GAP_MIN` 70 m, 2 × 高)、高度 = 地面 + max(8, 0.8 × 高)——市政府離立面約 35 → 90 m、高 22.5 → 36 m
- **減少動態效果**：main.js 注入 `reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches`；為真時改走老虎城固定高度慢速環繞（`REDUCED_OMEGA` 0.03 rad/s、半徑 150 m、高度 max(70 m, 整圈 floor)），偏好中途切換時內插轉場
- **效能**：每幀只做一次 Catmull-Rom + lookAt 四元數（node 實測 < 1 µs）；建路徑約 30 ms（含取景遮擋檢查，載入時一次）；內插剖面在開始內插時建一次（90 格）；手機 / low 檔同樣生效
- **回歸**：`node tools/test/p6-m6.mjs`（鏡位、型態秒數、60 Hz 每幀位移 ≤ 1.6 m / 轉角 ≤ 1.5°、全程 ≥ 地形 + 4 m 且不在建築內、循環接縫、handoff / start、進出遊戲整輪掃描〔平滑內插每幀高度變化 ≤ 1.6 m、不低於 floor、> 300 m 一律淡出淡入 ≤ 0.6 s 且只在全黑時切鏡〕、每段看點視線遮擋率 ≤ 10%、市政府推軌離立面 ≥ 90 m、減少動態效果、main.js 接線）

## 26. Phase 7 通緝 / 警力（原規劃 §22，該號已由 G2 使用故順延；接線點在 `src/main.js`，介面以各檔頭為準）

### 26.1 模組介面摘要
- `src/wanted/wanted.js`：`createWanted({ bus, config? })` → `{ report(crime, { x, z, witnessed = true }), update(dt, { playerX, playerZ, seen }), clear(reason), setStars(n), stars, heat, state, flashing, lastKnown, searchCircle }`；`CRIMES` = assault / assaultPolice / kill / killPolice / gunfire / carjack / vehicleHit / vehicleKill / policeVehicle / robbery（Phase 9，§28）；heat → 星數（`STAR_HEAT`）、active ↔ searching ↔ clear 狀態機、搜索圈（`searchCircle` 只在 searching 時非 null：`{ x, z, r }`）。witnessed=false（只有路人報案）heat × 0.5、至少 1 星
- `src/wanted/police.js`：`createPolice({ bus, wanted, adapters, rng?, config? })` → `{ update(dt, { player: { x, z, inVehicle, speed, down } }) → { seen }, witness(x, z) → boolean, dispose(), cars, officers, bustProgress }`；依星數生成 / 回收警車與警員、追捕、開槍（emit `police:shoot`）、逮捕（emit `police:bust`）
- `src/wanted/adapters.js`：`createPoliceAdapters(deps)` → 契約 B adapters（findSpawnPoint / spawnCar / despawnCar / driveCar / spawnOfficer / despawnOfficer / moveOfficer / officerAim / canSee）+ `update(dt, { stars, listener, paused })`、`isPoliceVehicle(v)`、`stats()`、`dispose()`；deps 見檔頭（vehicles / dmg / traffic / findRoute / combat / characters / physics / scene / heightAt / blocked / audio / settings / bus / getPlayer / isNight / surfaceOffset）。警車 = `vehicles.adopt({ type: 'police' })`（manifest 第 7 種車），警員開槍命中走 `combat.applyHit`；patrol 只開到路線的路網投影點（不進原始目標點），抵達時煞停並設 `car.patrolArrived = true`（police.js 據此換巡邏點）；耐久歸 0 的警車煞停一次並 `v.ai = false`；`vehicles.findNearby` 對 `v.ai` 車速 > 3 m/s 的車不回傳（行駛中警車不可上車）
- `src/wanted/ui.js`：`createWantedUI({ root, canvas, doc?, hints? })` → `{ setStars(n, { flashing }), showBusted({ fine }) → Promise<{ reason }>, showWasted({ fee }) → Promise<{ reason }>, showHint(key, text) → boolean, dispose(), overlayActive }`；reason = `'done'`（時間到）\| `'skipped'`（點擊跳過）\| `'preempted'`（被新畫面搶占）\| `'disposed'`；畫面期間 doc 層點擊一律 stopPropagation / preventDefault；`hints`（HUD）注入時 `showHint` 委派 `hud.showHint`（`tcgta.hints.seen`，`hud.resetHints()` 一併重置），未注入才用本檔 `tcgta.hints` 退路；`drawSearchCircle(ctx, { cx, cy, r, t })`。本檔不 import css：整合層 `import './wanted/wanted.css'`
- `src/wanted/places.js`（整合新增）：`POLICE_STATION`（臺中市政府警察局第六分局門口人行道 x 93.3, z 506.9）、`HOSPITAL`（osm-city.json 無醫院 / 診所 → 推測位置：河南路三段老虎城南側人行道 x 106.9, z −55.1，`inferred: true`）、`respawnPlace(kind)`

### 26.2 接線（main.js）
- 建立：`wanted = createWanted({ bus })`、`policeAdapters = createPoliceAdapters({...})`、`police = createPolice({ bus, wanted, adapters: policeAdapters })`、`wantedUI = createWantedUI({ root: document.body, canvas: renderer.domElement, hints: hud })`
- 每幀 `updateWanted(dt, phoneOpen)`（updateGame 內 stepWorld / handleFall 之後）：`policeAdapters.update(dt, { stars, listener: camera.position })` → `police.update(dt, { player })` → `wanted.update(dt, { playerX, playerZ, seen })`；暫停 / 全螢幕面板（updateGame 不跑）/ 手機開著時不更新，手機開著與 `updateAudio` 在 paused 時以 `policeAdapters.update(0, { paused: true })` 靜音警笛並凍結警車控制（煞停，不續倒車 / 全油門）
- 犯行（只算玩家所為；`reportCrime`：`police.witness(x, z)` 為真 → witnessed；否則 35 m 內有行人 → witnessed=false；都沒有不報）：`combat:hit` byPlayer → assault（目標 faction 'police' → assaultPolice）；`ped:dead` byPlayer → kill / killPolice（cause 'vehicle' 的非警員 → vehicleKill）；`ped:knockdown` cause 'vehicle' 且 byPlayer → vehicleHit；`weapon:fire` byPlayer 且非 police、40 m 內有行人或警員 → gunfire；`vehicle:carjacked` → carjack（警車另報 policeVehicle）；路邊上車開走警車（`vehicle:enter` 非 carjack）→ carjack + policeVehicle（每台一次）；玩家車撞警車（contacts onVehicleHitVehicle，relSpeed ≥ 3 m/s 且玩家車較快，同車 2 s 冷卻）→ policeVehicle
- 被捕（`police:bust`）：取消進行中的搶車 / 上車動畫、鎖輸入、玩家 untargetable → `fine = min(150, 餘額)`、`economy.spend(fine, 'busted')`（不足扣到 0；economy 未匯出 charge）、`wantedUI.showBusted({ fine })`（顯示實扣值）、`missions.failActive('busted')`；畫面結束且 reason 為 done / skipped → 傳送警察局門口、hp 回滿、`wanted.clear('busted')`、emit `player:busted { fine }`（實扣）、解鎖；preempted / disposed 不重生
- 送醫：玩家 hp 歸零 → 照發 `player:ko`（economy 扣醫藥費 min(100, 餘額)，整合層記實扣值 koFee）→ 倒地 2 s（`WASTED_DELAY_SEC`）→ `showWasted({ fee: koFee })`（不重複扣款）、`missions.failActive('wasted')`；畫面結束（reason done / skipped）→ 傳送醫院門口、hp 回滿、`wanted.clear('wasted')`、emit `player:wasted { fee: koFee }`。取代原 `PLAYER_KO_SEC` 原地起身；`missions.onPlayerKo` 不再由整合層呼叫（fragile 委託也直接以 'wasted' 失敗）
- `missions.failActive(reason)`：進行中的委託 → `mission:fail`；打工 → `job:fail`；外送 / 追垃圾車 → `event:fail`（同 reason）；無進行中回 false
- HUD：`wanted:change` / `wanted:state` → `wantedUI.setStars(stars, { flashing })`；首次被通緝 `wantedUI.showHint('wanted', …)` → 委派 `hud.showHint`（settings.showHints 關閉時不出；`hud.resetHints()` 後會再出）；`hud.update` 新欄位 `searchCircle`（`wanted.searchCircle`）→ 小地圖 `drawSearchCircle`、`policeCars`（`police.cars` 的 pos）→ 紅藍交替點
- 除錯：`window.__game.wanted / police / policeAdapters / wantedUI`（僅 dev）
- 新局 / 回主選單：`cancelRespawn()` 作廢進行中的被捕 / 送醫並 `wanted.clear('debug')`

### 26.3 回歸
- `node tools/test/integration-p7.mjs`（靜態接線 + 行為：犯行 → 星數、bust → 扣款 / 傳送 / 清星、wasted 流程、暫停不更新）；`node tools/test/p7-adapters.mjs`

---

## 27. Phase 8 噴漆廠（P8；接線點在 `src/main.js`，介面以 `src/wanted/spray.js` 檔頭為準）

### 27.1 模組介面
- `src/wanted/spray.js`：`createSprayShops({ bus, wanted, shops, config? })`（`police` 參數已移除；呼叫端多傳會被忽略）→ `{ update(dt, ctx) → { active, shopId, progress }, cancel(), shops, dispose() }`；純邏輯，不碰 DOM / three；訂閱 `bus` 的 `wanted:cleared`（`dispose()` 取消訂閱）
  - `shops`：`src/wanted/places.js` 的 `SPRAY_SHOPS`（`{ id, name, x, z, yaw, inferred }[]`）；回傳的 `shops` 是加了計時器欄位的內部複本（`cooldown` / `hold` / `rejected` / `needExit` / `spraying` / `aborting` / `sprayT` / `fee` / `starsBefore`）
  - `ctx = { player: { x, z }, vehicle, money, spend(n) → 實扣金額, refund?(n), seen? }`：`vehicle` = 玩家駕駛中的車或 `null`（非駕駛中）；非 null 時為 duck type `{ x, z, speed, isPolice, color, repaint(color), repair(), ref? }`（呼叫端用實際 Vehicle 包一層，spray.js 不 import vehicle.js；`ref` = 實體車識別，呼叫端重用同一 duck 物件時必填，省略時以 duck 物件本身識別）；`seen`：本幀 `police.update` 的 `seen`，main.js 只在有星時傳入（0 星一律 false，避免巡邏車視線擋下單純換色）（省略視為 false，`wanted.state === 'active'` 一樣視為被看見）
  - 觸發：車速 `< SPEED_LIMIT`（2 m/s）在店 `TRIGGER_RADIUS`（6 m）內連續 `ENTER_HOLD_SEC`（1.5 s）→ 開始噴漆（`active: true`，`progress` 0→1 共 `SPRAY_DURATION_SEC` 2 s）；開始時只檢查 `money ≥ fee`，**不扣款**；`ctx.spend` 不是函式 → 不開始噴漆（`console.warn` 一次）；拒絕（`vehicle.isPolice` / 被看見 / 錢不夠）→ `emit('toast', { text })`，同一原因在離開範圍（`hold` 歸零、`rejected` / `needExit` 重置）前只 toast 一次（原因改變時再發）
  - 費用 `sprayFee(stars)`：0 星 `BASE_FEE`（NT$50）；有星 `STAR_FEE_BASE + STAR_FEE_PER_STAR × stars`（NT$100 + 50 × 星數）；以開始時的星數計
  - 中止：進行中若 `wanted.state === 'active'`（被看見）、收到 `wanted:cleared` 且 `reason` 不是 `'spray'` 或 `'evaded'`（被捕 / 送醫等；噴漆中自然擺脫不中止）、或 `ctx.vehicle` 為 null / `ref` 與開始時不同（下車 / 換車 / 車輛棄置）→ toast「噴漆中斷」，`progress` 跳到後半段同一不透明度後淡入收回；結束時不扣錢、不換色、不清星，須離開範圍才可再觸發（不進冷卻）
  - 結束（`sprayT ≥ 2 s`）：此時才呼叫 `spend(fee)`；實扣 `< fee` 視為失敗（已扣部分以 `refund(paid)` 退回，若有提供；toast 錢不夠，不換色不清星，須離開範圍）；成功 → `vehicle.repaint(color)`（`pickPaintColor` 從 `PAINT_COLORS` 8 色排除目前色隨機挑一；目前色 number / THREE.Color 型 / 字串一律正規化成 `#rrggbb` 再比較）、`vehicle.repair()`、`wanted.clear('spray')`、`emit('spray:done', { shopId, fee: 實扣值, color, starsBefore })`、toast（`starsBefore > 0` 顯示「換色完成！警方失去你的蹤跡」，否則「煥然一新！」）、該店進入 `COOLDOWN_SEC`（30 s）冷卻，且須離開範圍才可再觸發；repaint / repair 拋錯時例外照常往外拋，但 `spraying` 等狀態以 try/finally 一定重置
  - `cancel()`：立即取消進行中的噴漆並清各店停妥計時（不扣錢 / 不換色 / 不清星 / 不 toast；冷卻保留）
- `src/wanted/wanted.js`：`CLEAR_REASONS` 新增 `'spray'`（`clear('spray')` 行為與既有 reason 相同，只是多一個合法值）
- `src/wanted/places.js`：新增 `SPRAY_SHOPS`（3 處，`osm-city.json` 無「汽車 / 保養 / 修車 / 車業 / 輪胎 / 美容」商家 → 皆為推測位置，`inferred: true`，取七期 / 市政府周邊大路路緣外人行道點）
- `src/vehicle.js`：`Vehicle.prototype.repaint(color)`（新增 export 方法，不改既有行為）：原地重建外觀網格換色（glb 走 `createVehicleModel` 的 paint 材質快取；程序化車材質由 `cachedStandardMaterial` 共用不可直接改色，故整台重建），保留位置 / 姿態，物理模式下重算 `_wheelIdx`；`src/vehicle-damage.js` 既有 `repair(vehicle)` 直接沿用（耐久回滿 / 停止冒煙 / 功率恢復），未新增 API
- `src/missions/light-pillar.js`：`BEACON_COLORS` 新增 `spray: 0xe040fb`（洋紅）；整合層另建一個 `createBeaconPool` 實例，店門口各 `acquire('spray', x, z)` 一次、常駐不釋放
- `src/map/marker-colors.js` / `src/map/big-map.js`：`MARKER_COLORS['spray-shop'] = '#e040fb'`、`MARKER_LABELS['spray-shop'] = '噴漆廠'`；小地圖沿用 `hud.js` 既有的 `_drawMarkers`（依 kind 著色圓點，不貼邊），大地圖圖例自動列出（`Object.keys(MARKER_COLORS)` 迴圈）
- `src/vehicle.js` repaint 換網格與 `src/vehicle-damage.js`：後者只讀 `v.pos` / `v.spec`、煙霧粒子自建於 scene，不持有 `v.mesh` 或其子節點 → repaint 後不需 detach / attach；`player.js` / `traffic.js` 每幀即時讀 `v.mesh`，同樣不受影響
- `src/hud.js`：`setSprayFade(frac)`（0 透明 → 1 全黑）操作新建的全螢幕 `div#spray-fade`（本檔動態建立，`index.html` / `style.css` 不動；找不到既有淡出工具時的簡單實作）；z-index 65：高於 HUD 上限 60、低於暫停選單 `tg-`（70–79），噴漆中暫停時選單不被黑幕蓋住

### 27.2 接線（main.js）
- 建立：`sprayShops = createSprayShops({ bus, wanted, police, shops: SPRAY_SHOPS })`；`sprayBeacons = createBeaconPool({ scene, heightAt })` 並對每間店 `acquire('spray', x, z)`；`sprayMarkers` 併入 `collectMarkers`（小地圖 / 大地圖共用）
- 每幀（`updateGame`，手機開著時不跑）：`updateWanted` 之後呼叫 `updateSprayShops(dt)` → 組 `ctx`（`vehicle` 僅 `state.mode === 'drive' && state.vehicle && !state.respawn` 時提供，`ref` = 該 Vehicle；`repaint` / `repair` closure 只建一次、經 `sprayTarget` 指向本幀的車；`isPolice` 來自 `policeAdapters.isPoliceVehicle`，`seen` 沿用 `updateWanted` 本幀 `police.update` 的 `seen`，不重算）→ `sprayShops.update(...)`；`spend` 包 `economy.spend`（原子：不足整筆拒扣 → 回 0），不提供 `refund`
- `active` 由 false → true：`state.spraying = shopId`、`input.enabled = false`、車輛 `setControls` 拉手煞車；噴漆期間 `updateGame` 套用駕駛輸入處（`braked = phoneOpen || state.spraying`）每幀維持手煞，不被 `driveControls(snap.move, …)` 覆寫；`true → false`：`state.spraying = null`、`hud.setSprayFade(0)`、（未被 respawn / 面板 / 手機搶占時）還原 `input.enabled = true`；過程中 `hud.setSprayFade(progress)`（三角波：前半淡出、後半淡入）
- 互斥：`beginRespawn(kind)` 在 `state.spraying` 真值時直接 return（噴漆中不觸發 BUSTED / WASTED）；`state.respawn` 真值時 `updateSprayShops` 不建立新噴漆（`ctx.vehicle = null`、dt 傳 0）
- 輸入還原：`resumeGame`（`if (!state.respawn && !state.spraying) input.enabled = true`）與 `syncPanels`（`input.enabled = !state.respawn && !state.spraying`）噴漆中都不開放輸入，由噴漆結束時解鎖
- 取消：`cancelSpray()`（`sprayShops.cancel()`、`state.spraying = null`、`hud.setSprayFade(0)`）在 `quitToMenu` / `startGame` 中於 `cancelRespawn()` 之前呼叫（避免 `cancelRespawn` 的 `wanted.clear('debug')` 觸發「噴漆中斷」toast）
- 除錯：`window.__game.sprayShops`（僅 dev，與既有 `wanted / police / policeAdapters / wantedUI` 同一批）

### 27.3 回歸
- `node tools/test/p8-spray.mjs`（純邏輯：觸發條件 / 拒絕條件各款 / 費用 / 冷卻 + 需離開範圍 / 噴完才扣款（重複扣款、部分扣款退回、無 spend）/ 中途被看見 / 被捕 / 下車 / 換車中止 / `cancel()` / 非字串車色 / repaint 拋錯後狀態重置 / `wanted.clear('spray')` / `spray:done` payload / 幀率無關）
- `node tools/test/p7-wanted.mjs`（`CLEAR_REASONS` 含 `'spray'`）
- `node tools/test/integration-p8.mjs`（接線靜態檢查：`main.js` 匯入 `createSprayShops` / `SPRAY_SHOPS`、呼叫 `updateSprayShops`、`beginRespawn` 的 `state.spraying` 互斥判斷存在、resume / syncPanels 看 `state.spraying`、`quitToMenu` / `startGame` 先 `cancelSpray()`、噴漆中每幀手煞、`#spray-fade` z-index 低於暫停選單、`vehicle-damage.js` 不持有 mesh）

---

## 28. Phase 9 超商搶劫（P9；接線點在 `src/main.js`，介面以 `src/wanted/robbery.js` 檔頭為準）

### 28.1 模組介面
- `src/wanted/robbery.js`：`createRobberies({ bus, wanted, police?, stores, rng?, config? })` → `{ update(dt, ctx) → { active, storeId, progress }, cancel({ resetAll? }), clerkDown(storeId) → boolean, dispose(), stores, active }`；純邏輯，不碰 DOM / three；`police` 保留未用
  - `stores`：`src/wanted/places.js` 的 `STORES`（`{ id, name, osmId, x, z（門口人行道）, counterX, counterZ（櫃檯 = 門口往內 2 m）, clerkYaw, inferred }[]`）；回傳的 `stores` 是內部複本，附 `state`（`'ready'\|'robbing'\|'cooldown'`）/ `cooldown` / `robT` / `aimLost` / `clerkDown` / `robbed` / `available`（= `state === 'ready'`）
  - `ctx = { player: { x, z, yaw }, onFoot, aiming, aimAt(x, z) → boolean, earn(n), toast?(text, sec), showHint?(id, text) → boolean }`：`aimAt` = 準星是否對著該點附近 1.2 m（整合層用 `aimNear(origin, dir, x, y, z, tol = AIM_TOL)` 實作）；`toast` 省略改 `emit('toast')`
  - 開始：`onFoot && aiming && aimAt(櫃檯) && 距櫃檯 ≤ START_DIST`（6 m）→ `state 'robbing'`、`wanted.report('robbery', { x, z: 櫃檯, witnessed: false })`（店員報警）、emit `robbery:start`
  - 進行：持續瞄準累計 `ROB_SEC`（6 s）→ 成功：`earn(lootAmount)`（`LOOT_MIN`–`LOOT_MAX` NT$300–800 均勻整數）、emit `robbery:done { storeId, amount }`、toast「搶到 NT$x，快逃！」、冷卻 `COOLDOWN_SEC`（180 s，`robbed = true`：整合層讓店員消失）
  - 失敗：停止瞄準（含準星移開 / 上車）連續 > `AIM_GRACE_SEC`（1 s，期間進度暫停）或離櫃檯 > `ABORT_DIST`（8 m）→ toast「店員報警了！」、星數不足 1 時 `wanted.setStars(1)`、emit `robbery:failed`、冷卻 `FAIL_COOLDOWN_SEC`（180 s）
  - 店員倒地：bus `ped:knockdown` / `ped:dead` 的 `ped.clerkOf === store.id`，或 `clerkDown(storeId)` → `clerkDown = true`、進行中的搶劫中止（reason `'clerk'`，不 toast、不給錢）、冷卻 180 s（從倒地起算）；冷卻結束才重置
  - `wanted:cleared`（被捕 / 送醫 / debug）→ 進行中的搶劫無聲中止（reason `'cleared'`，進冷卻）
  - 冷卻中瞄準無反應；首次在可搶店門口 `HINT_DIST`（20 m）內 → `ctx.showHint('robbery', '拿槍瞄準店員就能搶劫超商，但會立刻被通緝！')`，回傳真值後不再呼叫
  - `cancel()`：進行中的搶劫無聲取消，各店冷卻 / 店員倒地全部重置為 ready；時間吃呼叫端 dt（clamp ≤ `MAX_DT` 0.1 s），幀率無關
- `src/wanted/wanted.js`：`CRIMES.robbery` / `HEAT.robbery = 2.5`；新增 `CRIME_MIN_STARS = { robbery: 2 }`（`config.minStars` 可覆寫）：`report` 後星數至少為該值（不論 witnessed；heat 照 HEAT 累加不抬高）
- `src/wanted/places.js`：新增 `STORES`（4 間）：`osm-city.json` 只有 B「全家便利商店」（id 491492673，黎明路二段）1 筆符合；其餘 3 間為七期路口推測點（`inferred: true`）。座標推導見檔頭
- `src/missions/light-pillar.js`：`BEACON_COLORS.store = 0x43a047`（綠）；`createBeaconPool` 新增選用 `height` / `radius` / `sink`（預設不變）
- `src/map/marker-colors.js` / `src/map/big-map.js`：`MARKER_COLORS.store = '#43a047'`、`MARKER_LABELS.store = '超商'`（大地圖圖例自動列出）
- `src/hud.js`：`setRobberyProgress(frac | null, label = '搶劫中…')`（`.rob-bar` / `.rob-label` / `.rob-track` / `.rob-fill`，掛 body，樣式在 `style.css` 末段；觸控改放畫面上方中央）；小地圖 kind `'store'` 畫綠底「超」字小方塊（`ICON_KINDS`）；入帳跳字 reason `robbery` 前綴「搶劫」

### 28.2 接線（main.js）
- 建立：`robberies = createRobberies({ bus, wanted, police, stores: STORES, rng: Math.random })`；`storeBeacons = createBeaconPool({ scene, heightAt, ...STORE_BEACON })`（高 7 m、半徑 0.7 m）；`robberyMarkers`（kind `'store'`）併入 `collectMarkers`
- 店員：玩家距櫃檯 ≤ `CLERK_SPAWN_DIST`（120 m）且該店 ready / robbing 才生成（> `CLERK_DESPAWN_DIST` 150 m 回收）：`createCharacter({ variant: 'pedestrian', colors: CLERK_COLORS })`（綠制服執行期換色）+ `CharacterAnimator` + combat actor（`faction 'clerk'`、`clerkOf = store.id`、`recoverOnKo`）+ `createPedestrianBody`（`owner` = 店員，子彈 / 車撞得到）；搶完（`robbed`）→ 消失；倒地留在原地，判定死亡或冷卻結束回收、下一幀重生
- 每幀 `updateRobberies(dt, phoneOpen)`（updateGame 內 `updateSprayShops` 之後）：手機開著 / `state.respawn` / `state.spraying` → 凍結（店員以 dt 0 擺位、進度條收起）；暫停 / 全螢幕面板時 updateGame 不跑；`onFoot = state.mode === 'walk'`、`aiming = onFoot && aim.aiming`（`fillAim`：按住瞄準且持手槍，含手把 LT）、`aimAt = aimNear(aim.origin, aim.dir, x, heightAt + AIM_HEIGHT, z)`、`earn = economy.add(n, 'robbery')`、`showHint` 走 `wantedUI.showHint`（HUD 注入，settings.showHints 關閉時不出）
- 光柱：每幀依 `store.available` acquire / release（只在可搶時顯示）
- 取消：`cancelRobbery()`（`robberies.cancel({ resetAll })`：只取消進行中的搶劫，開新局才重置各店冷卻 / 店員倒地；店員全回收、進度條收起）在 `quitToMenu` / `startGame` 中於 `cancelSpray()` / `cancelRespawn()` 之前
- 除錯：`window.__game.robberies` / `clerks`（僅 dev）

### 28.3 回歸
- `node tools/test/p9-robbery.mjs`（純邏輯：觸發距離 / 條件、aimNear、瞄準中斷、離開 8 m、報警星數、收入範圍、冷卻、店員倒地、wanted:cleared、幀率無關、cancel / dispose、提示）
- `node tools/test/p7-wanted.mjs`（robbery 犯行：HEAT 2.5、保底 2 星）
- `node tools/test/integration-p9.mjs`（main.js 接線靜態檢查 + 抽出超商段以替身執行）
- `tools/build-city.mjs` 會把 places.js 點位列為不蓋建築區：新增 `STORES` 後 `osm-city.json` 需重建（check-city / p8b-infill 在重建前可能不一致）

## 29. Phase 11 警車任務 Vigilante（P11；接線點在 `src/main.js`，介面以 `src/missions/vigilante.js` 檔頭為準）

### 29.1 模組介面
- `createVigilante({ bus, wanted?, rng?, config? })` → `{ update(dt, ctx) → { active, phase, level, remaining, timeLeft, text }, start() → boolean, cancel(), end(reason), canStart(ctx), markers(out), isFugitiveActor(actor), shotAtFugitive(x, z), dispose(), active, phase, level, levelsDone, earned, timeLeft, fugitives }`；純邏輯，不碰 DOM / three；`wanted` 保留未用（不呼叫 report）
  - `ctx = { player: { x, z }, inPolice, policeWrecked, busy?, world, earn(n), toast?(text, sec), showHint?(id, text) → boolean }`；`world` = `{ spawnPoint(px, pz, rMin, rMax), spawn(pt, { level }), state(h) → { x, z, speed, health, exists, driven }, drive(h, { x, z, maxSpeed }), eject(h) → actor | null, remove(h) }`
  - 啟動：`canStart(ctx)` = 未進行中 && `inPolice` && `!busy`（星數不限）；`start()` 後下一次 `update` 開第 1 關；首次 `inPolice` → `showHint('vigilante', '按 E 開始警車任務')`
  - 每關：`min(關數, MAX_FUGITIVES 4)` 台，生成在玩家 `SPAWN_MIN`–`SPAWN_MAX`（150–300 m）的車道點；時限 `120 + 30 × 台數` s；逃竄目標 = 背離玩家方向 ± 0.6 rad、250 m（8 s 或接近 30 m 重選），速度 `min(16 + 2 × (關數 − 1), 30)` m/s（警車極速 42）
  - 制伏：耐久 ≤ `SUBDUE_HEALTH`（= vehicle-damage `SMOKE_DARK_AT` 300，黑灰煙降功率）、玩家開走該車，或車速 < 1 m/s 持續 3 s 且玩家（在警車內）≤ 15 m → `world.eject`（駕駛座側車門外 `traffic.spawnEjectedDriver`）、toast「逃犯制伏」；全部制伏 → `earn(500 × 關數)`、toast、`NEXT_LEVEL_SEC` 5 s 後下一關（上一關的車此時回收）
  - 結束：時限到 `timeout`、離開警車 > 10 s `left`、駕駛中警車耐久 0 `wrecked`、`end('busted'\|'wasted')`（整合層 beginRespawn；另訂閱 `player:busted` / `player:wasted` 保底）→ toast「警車任務結束：完成 N 關、共得 NT$X」；`cancel()` 無聲結束（不 toast，仍 emit `vigilante:end { reason: 'cancel' }`）；逃犯車全部 `world.remove`（玩家正駕駛者保留）、標記清空
  - 不算犯行：`isFugitiveActor(a)`（任務中已下車的逃犯）、`shotAtFugitive(x, z)`（子彈落點距未制伏逃犯車 ≤ `SHOT_RADIUS` 4.5 m；已制伏的車不豁免）；任務結束即失效
  - 時間吃呼叫端 dt（clamp ≤ 0.1 s），幀率無關
- `createFugitiveWorld({ vehicles, dmg, traffic, findRoute, rng?, attacker?, isKept?, onKeep? })` → 上述 `world` + `update(dt)` / `brakeAll()`（凍結時煞停在逃的車）/ `dispose()` / `cars`；`remove` 對玩家正駕駛或 `isKept(v)` 為真的車保留並交 `onKeep(v)`：`vehicles.adopt`（sedan / taxi / suv、traffic 同色盤，`v.ai = true`、`v.fugitive = true`）+ `dmg.attach`；駕駛沿 `findRoute` 路線（同 adapters.js 警車控制，卡住倒車門檻 4 s > 制伏 3 s）
- `createVigilanteBar({ root })` → `{ set(text | null, urgent), dispose() }`：`.vig-bar` / `.vig-text` / `.vig-urgent`（`style.css`），文字「警車任務 第 N 關｜剩 M 台｜mm:ss」，過關倒數顯示「第 N 關完成｜下一關 mm:ss」
- 標記：`MARKER_COLORS.fugitive = '#ff1744'`、`MARKER_LABELS.fugitive = '逃犯車'`、`hud.js EDGE_KINDS` 含 `'fugitive'`（超出小地圖半徑貼邊）；入帳跳字 reason `vigilante` 前綴「警車任務」

### 29.2 接線（main.js）
- 建立（車輛回收段之後、超商段之前）：`vigilante = createVigilante({ bus, wanted, rng })`、`fugitiveWorld = createFugitiveWorld({ vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng, attacker: () => player.actor, isKept: v === state.vehicle \|\| v === cj.vehicle, onKeep: adopted.add })`（保留下來的逃犯車照搶來車回收）、`vigBar`；`fugitiveMarkers()` 併入 `collectMarkers`
- 警車判定 `isPoliceCar(v)` = `v.type === 'police' \|\| policeAdapters.isPoliceVehicle(v)`；其他任務 `otherMissionBusy()` = 委託 / 外送 / 垃圾車 / 打工 / 搶劫 / 噴漆；反向：任務中 `robCtx.onFoot` 為假（不開始搶劫）、噴漆廠視同未駕駛、`createMissions({ extraBusy })` 擋接委託 / 垃圾車 / 打工
- 互動：駕駛中 `inter = vigilanteInteractable(v) \|\| nearestInteractable(...)`（priority 4，E / 手把 B / tb-interact 同一路徑）；任務中 `nearestInteractable` 不列委託
- 每幀 `updateVigilante(dt, phoneOpen)` 接在 `updateRobberies` 之後：手機 / `state.respawn` / `state.spraying` / 搶劫中不推進並 `fugitiveWorld.brakeAll()`；`fugitiveWorld.update(dt)` → `vigilante.update` → `vigBar.set`
- 犯行：通緝段宣告 `vigHooks = { fugitiveActor, fugitiveShot, end, active }`（預設無作用，警車任務段覆寫為 vigilante 方法；integration-p7 抽段不需注入 vigilante）；`combat:hit` / `ped:dead` / `ped:knockdown` 對 `vigHooks.fugitiveActor` 不報；`weapon:fire` 落點 `vigHooks.fugitiveShot(ex, ez, vehicle)`（vehicle = 打中的車，街頭事件比對用）不報 gunfire；撞一般市民車輛 / 行人照常
- `beginRespawn` → `vigHooks.end(kind)`（在 `missions.failActive(kind)` 之後；同時收起任務條）；`quitToMenu` / `startGame` → `cancelVigilante()`（在 `cancelRobbery` 之前）
- 除錯：`window.__game.vigilante` / `fugitiveWorld` / `vigBar`（僅 dev）

### 29.3 回歸
- `node tools/test/p11-vigilante.mjs`（純邏輯 + createFugitiveWorld 替身）、`node tools/test/integration-p11.mjs`（main.js / hud / 標記 / CSS / 文件靜態檢查）

## 30. V2 幫派地盤（罪惡之都；接線點在 `src/main.js`，介面以 `src/gangs.js` 檔頭為準）

### 30.1 模組介面（`src/gangs.js`，純邏輯，只 import `geom.js`）
- `GANGS`：三個虛構幫派 `{ id, name, area, color, carColor, carType, outfit: { shirts[], pants, shoes, hair? }, territory（扁平 [x, z, …]）, bbox }`——`nightmarket` 夜市角頭（紅黑花襯衫；新光三越．大遠百商圈，即夜市外送取餐點一帶，OSM 範圍內無逢甲 / 大墩夜市）、`qiuhonggu` 秋紅谷飆車族（螢光綠夾克；秋紅谷廣場周邊）、`suits` 七期西裝幫（黑西裝；臺灣大道市政大樓 / 市議會 / 捷運市政府站商辦區）；地盤互不重疊、全在 `BOUNDS` 內；`GANG_ZONES` = 地圖用 `{ id, name, label, color, poly, bbox }`
- `createGangs({ bus, rng?, config? })`（另訂閱 `player:busted` / `player:wasted` → `cancel()`）→ `{ update(dt, ctx), territoryAt(x, z) → GANGS 一筆 | null, hostility(id?) → 0–100（省略 = 最大值）, cancel(), dispose(), pedHooks, zones, gangs, members, config, isHostile(id), car(id), territory, stats() }`
  - `ctx = { frozen, combat, cars?（createGangCars）, damageVehicle?(n), player: { x, z, actor, inVehicle, aiming, aimDirX, aimDirZ, disabled } }`；`frozen` 時成員原地面向目標不出手、幫派車煞停、計時不前進
  - `pedHooks`（給 `new Traffic(…, { gangs })`）：`onSpawn(c)` → 同夥數（地盤內生成點以 `leaderChance(memberShare 0.3, 2, 4)` 成為帶頭者，換幫派配色 `c.gang` / `c.look`）、`onCrew(c, leader)`、`onAttach(p)`（設 `p.brain.override`）、`onDetach(p)`
  - 敵意（每幫 0–100）：地盤內步行離該幫成員 6 m 內累計 3 s +60、步行持槍瞄準成員（±10°、30 m）+70、攻擊成員（`combat:hit` / `ped:knockdown` / `ped:dead` 且 `byPlayer`）+100；≥ 50 圍攻（45 m 內 ≤ 8 人；近戰衝上來出拳 / 揮棒、持槍者保持 6–15 m 射擊）、≥ 85 派幫派車；地盤內最後挑釁 10 s 後 −2/s、離開地盤 −6/s，< 25 收手
  - 開車掃射：幫派車追玩家，20 m 內乘客 5 連發 / 輪（間隔 0.35 s、換輪 2.5 s），最長 45 s，結束冷卻 40 s；命中走 `combat.applyHit`（玩家在車內 `throughVehicle: true`）+ `damageVehicle(25)`
  - 幫派互毆：每 20 s 以 0.35 機率讓「入侵的敵對 crew」（`rivalChance` 0.1）與 25 m 內在地成員互毆 12 s
  - 開槍一律 emit `weapon:fire { weapon: 'pistol', byPlayer: false, police: false, gang, shooter, hit, miss, ex, ey, ez, … }`（行人聽到槍聲、音效；通緝只認 byPlayer）
- `createGangCars({ vehicles, dmg?, traffic, findRoute?, characters?, seatHips?, rng?, canSee?, isKept?, onKeep? })` → `{ spawn(def, px, pz), drive(car, x, z, hold?), brake(car), brakeAll(), alive(car), despawn(car, now?), muzzle(car), update(dt, px, pz), cancel(), count() }`：`vehicles.adopt({ type: def.carType, color: def.carColor })` + `dmg.attach`，前座兩名幫派配色角色掛在車身網格下（drive 坐姿）；生成點跳過 10 m 內有車（VehicleManager / `traffic.cars`）與 `canSee` 為真的點，全不合格回 null；`despawn` 時玩家 60 m 內先開走（90 m 外或 20 s 後回收）；被搶 / `isKept(v)` → `v.ai = false` + `onKeep(v)`，熄火 → `v.ai = false`、殘骸留給整合層照報廢車回收（兩者都不移除車體）；近距離（25 m）追玩家側邊 5 m 點並依接近速度煞車，`hold`（玩家步行 10 m）內煞停；`brakeAll()` = frozen 時含 leaving 全部煞停
- 事件（bus）：`gang:enter { gang, name, area }` / `gang:leave { gang, name }`、`gang:hostile { gang, name, hostile, level, cause: 'linger'|'aim'|'attack'|'calm' }`、`gang:driveby { gang, name, phase: 'start'|'end', reason? }`、`gang:war { a, b, x, z }`

### 30.2 跨檔最小擴充
- `npc-ai.js`：`NpcBrain.override = (brain, dt, ctx, it) → boolean`（預設 null；回 true 時意圖由 override 決定、mode / state `'gang'`、刺激丟棄）
- `combat.js`：`applyHit({ …, throughVehicle })`——目標 `untargetable`（玩家在車內）時只扣血、發 `hit { inVehicle: true, knockback: null }`，不硬直 / 不擊倒（NPC 用槍沿用既有 applyHit 'pistol'，不新增武器流程）
- `vehicle-damage.js`：`addDamage(vehicle, amount)`（子彈直接扣耐久，發 `vehicle:damaged`、冒煙 / 熄火門檻照舊）
- `traffic.js`：建構參數 `gangs`（pedHooks）；同夥在帶頭者身後同一路線每 1.3 m 生成、同方向同步速；持棒 / 槍成員右手掛 `placeholderBat` / `placeholderPistol`
- `hud.js`：`state.gangZones` → 小地圖半透明地盤色塊；`map/big-map.js`：`createBigMap({ zones })` → 色塊 + 圖例「〇〇地盤」三列

### 30.3 接線（main.js）
- `gangs = createGangs({ bus })` 在 `new Traffic` 之前（`gangs: gangs.pedHooks`）；`gangCars = createGangCars(…)` 在車流 / 行人外部狀態段
- 每幀 `updateGangs(dt, phoneOpen)` 接在 `updateVigilante` 之後（`updateWanted` → `updateSprayShops` 相鄰順序不變）：`frozen = 手機 || state.respawn || state.spraying`（暫停 / 全螢幕面板時 updateGame 不跑）；車內中彈 hp 歸零 → 強制下車 + `combat.knockdownActor(player.actor, { cause: 'bullet', emit: true })` 走既有 `player:ko` → WASTED
- `gang:enter` → toast「⚠ 進入〇〇地盤」、`gang:hostile`（hostile）→「〇〇盯上你了！」、`gang:driveby` start →「〇〇開車來找你了！」
- `startGame`、`quitToMenu` → `gangs.cancel()`（敵意歸零、收手、幫派車回收）；被捕 / 送醫：gangs 訂閱 `player:busted` / `player:wasted`（`finishRespawn` 發）自動 cancel，BUSTED・WASTED 畫面期間 `frozen`
- 幫派段位置：`updateTrafficContext` / `ambientCtx` 之後（不落在 integration-p7 / p9 / p11 抽段範圍內）
- 打幫派照常算犯行（既有 `combat:hit` / `ped:dead` byPlayer 規則不變）；除錯 `window.__game.gangs` / `gangCars`（僅 dev）

### 30.4 回歸
- `node tools/test/v2-gangs.mjs`（純邏輯 + 替身；含幀率無關、穩態無 GC、每幀成本 < 0.5 ms）

---

## 31. V4 車輛起火爆炸（罪惡之都；接線點在 `src/main.js`，介面以 `src/explosions.js` 檔頭為準）

### 31.1 模組介面（`src/explosions.js`，純邏輯，不 import three；THREE 注入）
- `createExplosions({ THREE, scene, bus, combat, physics, config })` → `{ explode(x, y, z, { radius, power, source, vehicle? }), update(dt, simDt = dt, camX?, camZ?), damageVehicle(v, amount, { source }), setSource(v, actor), transfer(from, to, restore?), stateOf(v) → 'ok'|'smoke'|'fire'|'wreck', fuseOf(v), isWreck(v), nearestFire(x, z), cancel(v), forget(v), clear(), stats(), dispose }`
  - `config = { healthOf(v), maxHealthOf?(v), addDamage(v, n) → 實扣, vehicles?() → iterable, actors?() → iterable（省略 = combat.entries 全部）, onWreck?(v), quality?() → tier（'low' 粒子 / 池減半）, pointScale?() → 像素比例, rng? }`；`physics = { radialImpulse(x, y, z, radius, power) }`（可省略）
  - 車輛狀態依損壞比（1 − health / maxHealth，耐久即 vehicle-damage.js 那份）：≥ 70% `'smoke'`（煙沿用 vehicle-damage）、≥ 85% `'fire'`（引擎蓋火焰 + 黑煙，引信 4–6 s，起火中每 1 點傷害縮短 0.02 s，點燃當下下限 0.35 s；修好回門檻下自動熄火）→ 爆炸 `'wreck'`：耐久扣到 0（熄火）、`vehicle.burnt = true`、材質複製後變黑、`onWreck(v)`、殘骸冒黑煙 14 s
  - `explode`：角色 `combat.applyHit({ weapon: 'explosion', impulse（依距離擊飛）, throughVehicle: true })`，傷害 = power × (1 − d / radius)，核心（0.3 × radius）必死（倒地 / 起身中者 applyHit 不受理 → `combat.damageDown`），車內（非核心）× 0.5；車輛 `damageVehicle(power × 10 × 衰減)`（約 3.5 m 內起火 → 連鎖爆炸）；`physics.radialImpulse`；預設 radius 9 m / power 140（公車等 > 5 t × 1.35、機車 × 0.7）
  - 殘骸以 `v.burnt` 為準（`clear` / `forget` 後再受損也不會重新起火）；`setSource` 的來源 `SOURCE_TTL`（10 s 模擬時間）內有效，爆炸只採用有效來源；`transfer` 把起火狀態搬到新 Vehicle（搶車），`restore(to)` 期間的 `vehicle:damaged` 不觸發起火判斷
  - 池化：同時爆炸紀錄 ≤ 6（滿了回收最舊）、閃光 PointLight ≤ 2（常駐場景、intensity 0 = 關）、粒子兩個 `Points` 圖層（火：加色 320 / 煙與碎片：256，low 減半；池滿丟新粒子）；每幀路徑不配置物件
- 匯出純函式：`blastFalloff`、`actorBlastDamage`、`vehicleBlastDamage`、`shakeTrauma(dist, radius, power)`、`fireStage(ratio)`、`charMesh(root)`；常數 `SMOKE_AT / FIRE_AT / FUSE_* / BLAST_* / MAX_EXPLOSIONS / MAX_LIGHTS / PARTICLE_CAPS / BURST`
- 事件：`vehicle:fire`、`vehicle:explode`、`explosion`、`explosion:shake`（payload 見 §10 表）

### 31.2 跨檔最小擴充
- `combat.js`：武器 `'explosion'`（`KNOCKDOWN_RULES` 一下即倒、`WEAPON_CAUSE` `'explosion'`、擊退 1.5 m / 預設衝量 300；攻擊者不頓幀）；`ped:dead` / `knockdown` 的 cause 多 `'explosion'`；`damageDown(actor, damage, { weapon, attacker, impulse })`：只受理倒地 / 起身中、未判定死亡者，強制扣血（hp 歸零 → dying + 重發 'knockdown' + `ped:dead`；起身中 → 再倒地）
- 槍擊車輛：`weapons/defs.js` `pistol.vehicleDamage = 34`；`aim.js resolveShot` 把 raycast 的 `vehicle` 抄進 `out.vehicle`；`weapons.js` 的 `weapon:impact` 多帶 `vehicle / damage / byPlayer`；main.js raycast 以 collider → `VehicleBody.owner` / 車流 `car.v` 填 `vehicle`
- `vehicle-damage.js`：`maxHealthOf(v)`；`vehicle.js`：`findNearby` / `findOverturned` 跳過 `v.burnt`；`traffic.js`：`car.v.burnt` 的 wrecked 車流車不交還車道、遠了照回收；`_step` / `carjackCandidates` / 喇叭反應跳過 `car.v.burnt`（停用中爆炸未轉 wrecked 也不再行駛、不可搶）
- 音效：`voices.js` `RECIPES.explosion` / `fire_ignite`、`LOOPS.fire`；`audio/index.js` 訂閱 `explosion` / `vehicle:fire`，`state.fireDist` < 35 m 開燃燒聲；`combat:hit` 的 explosion 不另發擊中聲

### 31.3 接線（main.js）
- `explosions = createExplosions(…)` 在幫派段之後：`config.addDamage` 先 `ensureDamageable`（車流車第一次被打 / 波及才 `dmg.attach`，被 traffic 回收後 detach + `forget`）、`vehicles()` = VehicleManager 的車 + 啟用中的車流車、`onWreck` 把車流車 `body.hit` 成殘骸剛體（停用中先 `setActive(true)`）；`physics` = `createExplosionImpulse`（Rapier 球形查詢：停放車轉 dynamic、車流車 wreck、動態雜物，Δv 9 m/s × 衰減）
- `weapon:impact`（帶 vehicle）→ `explosions.damageVehicle(e.vehicle, e.damage, { source: 玩家 })`；碰撞 `impact()` 中玩家駕駛的車實扣耐久 > 0 → `setSource(v, player.actor)`（別人打 / 炸玩家的車不算玩家）；搶車 `releaseCar` 記下舊車耐久，`adopt` 以 `explosions.transfer(舊, 新, 扣耐久)` 帶過損壞與起火；`vehicle:fire`（玩家的車）→ toast 提示下車
- `explosion:shake` → `rig.shake(shakeTrauma(鏡頭距離, radius, power))` + 手把震動；`explosion` → 45 m 內行人 `hear({ type: 'gunshot' })`
- 通緝：沿用既有犯行（`p7-wanted` 鎖定 HEAT 10 鍵，不新增 explosion）——爆炸致死 `ped:dead`（cause 'explosion'，byPlayer）→ `kill` / `killPolice`、傷人 `combat:hit` → `assault` / `assaultPolice`、玩家炸警車（`vehicle:explode` byPlayer）→ `policeVehicle`（警車任務逃犯車豁免）
- 每幀 `updateExplosions(dt)` 接在 `updateGangs` 之後（`explosions.update(dt, worldStep.simDt, focus.x, focus.z)`）；車內爆炸 hp 歸零沿用 V2 的 `gangCarKo`，由 `handleCarKo()` 在 `updateGangs` 結尾與 `updateExplosions` 之後各處理一次（強制下車 + `player:ko`；同幀已按 F 下車也照樣倒地 WASTED）
- `startGame`、`quitToMenu` → `clearExplosions()`（熄火、終止爆炸 / 閃光、清粒子與殘骸冒煙；殘骸車本身照 `cleanupVehicles` 報廢車回收）

### 31.4 回歸
- `node tools/test/v4-explode.mjs`（純邏輯，無 three：門檻 / 時序 / 加速 / 範圍傷害 / 擊飛 / 連鎖 / 殘骸 / 槍擊累積 / 犯行 / 池化 / cancel・dispose / 幀率無關 / 每幀成本）

## 32. V3 街頭隨機犯罪事件（罪惡之都；接線點在 `src/main.js`，介面以 `src/street-events.js` 檔頭為準）

### 32.1 模組介面（`src/street-events.js`，純邏輯，只 import `gangs.js` / `vehicle-damage.js` / `carjack.js`，不 import three / rapier）
- `createStreetEvents({ bus, rng?, config? })` → `{ update(dt, ctx), active, cancel(), dispose(), isEventActor(a), shotAtEvent(x, z, vehicle), vehicleHitByPlayer(v), markers(out), events, config, cooldown, stats() }`
  - `ctx = { player: { x, z }, view?: { dx, dz }（鏡頭水平朝向）, hour, busy, world, earn(n), toast?(text, sec), zoneAt?(x, z) }`；`busy` 時不生成新事件、既有事件照常收尾
  - 排程：事件開始時起算冷卻 45–90 s；之後每 5 s 以 `spawnChance(hour, 地盤內)` 擲骰（基礎 0.12，夜間 20–5 時 ×2、玩家在幫派地盤內 ×1.6）；同時 ≤ 2 件；種類權重 `kindWeights`（夜間搶劫 / 酒駕較多；槍戰只在環帶內有地盤邊界點 `BORDER_POINTS` 時、地盤內加倍）；`config.kindMul` 可逐種調整
  - 生成點：玩家 60–200 m（搶劫 / 槍戰 ≤ 100 m：骨架行人只在 pedFar 內）、與鏡頭朝向夾角 60–100°（視野邊緣；下限 > 水平半視角：vfov 60° 時 16:9 = 45.7°、21:9 = 53.4°）；world 吸附後再驗一次（+15 m 容許），不合格 `release(h, 'cancel')` 換候選
  - 事件（每件超時 60–120 s）：`robbery` 歹徒跑向路人推倒 → 逃跑，玩家打倒歹徒 → `subdued` 賞金 NT$100–200、受害者道謝；歹徒離玩家 > 120 m → `escaped`｜`chase` 罪犯車背離玩家逃竄（22 m/s）、1–2 台警車追（25 m 內 ram）；耐久 ≤ `SMOKE_DARK_AT` 或低速 7 s（起步 5 s 後；> 事件車卡住倒車 `STUCK_SEC` 4 + `REVERSE_SEC` 1.5 s）→ 玩家出手過（玩家駕駛車撞擊 `vehicleHitByPlayer`、射中事件車 `weapon:impact` byPlayer）= `subdued` 賞金 NT$300–500，否則 `arrested`（玩家只是在旁邊不算）；玩家開走罪犯車也算 `subdued`；> 260 m `escaped`｜`gang` 地盤邊界兩幫成員互射 10–20 s → `over`｜`drunk` 車速 5–20 m/s 正弦起伏 + 方向盤蛇行、不理號誌；自己撞停 / 卡住 8 s → `crashed`（玩家出手過才 `subdued` NT$100–200）；搶劫同樣只認玩家出手（bus byPlayer），被別人撞倒、玩家在旁不給賞金
  - 呈現：事件在玩家 80 m 內（開始時或之後首次接近）toast `HINTS[kind]`；開始 / 提示後 6 s 內 `markers()` 回 kind `'street-event'` 黃點（0.25 s 亮暗閃爍）
  - 犯行豁免（只限罪犯本人）：`isEventActor(a)`（搶匪 / 下車罪犯 / 槍戰成員；結束後 20 s 內仍算；以登記時的 `a.id` 比對——traffic 骨架回池換給別的市民只改 id，新身分不沿用）、`shotAtEvent(x, z, vehicle)`（打中的車就是進行中的罪犯車 / 酒駕車本身 `handle.vehicle`、落點 4.5 m 內；罪犯車旁的警車 / 路人照算）；`combat:hit` / `ped:knockdown` / `ped:dead` byPlayer 打到歹徒、`weapon:impact` byPlayer 打到事件車 → 記為玩家出手
  - 錯開更新：事件邏輯每 0.1 s 輪詢（兩 slot 相位錯開）、排程每 5 s；slot / 輸出 / 標記建構時配置，每幀路徑不配置
- `ctx.world`（`createStreetWorld` 或測試替身）：`spawn(kind, x, z, ev) → handle | null`（`handle.x / z / actors`、車輛事件 `handle.vehicle`）、`poll(h, out)`、`act(h, verb, ev)`（`approach / grab / flee / subdued / drive / eject`）、`release(h, outcome)`
- `createStreetWorld({ traffic, combat, vehicles, dmg?, findRoute?, police, gangs?, repaint?(p), canSee?, getPlayer, bus?, rng?, isKept?, onKeep? })` → 上列 world + `update(dt, frozen)`（每幀事件車控制、離開 / 回收）、`reset()`（回主選單 / 開新局：離場中的事件車 / 收隊警車立即收掉、待回收行人清 override 交還 traffic）、`dispose()`（= reset + 取消訂閱）、`cars`、`isEventVehicle(v)`、`stats()`
  - 行人事件徵用 30 m 內漫步中的骨架行人（無 override、非幫派、combat normal），以 `brain.override` 控制；推倒 = `combat.knockdownActor(受害者, { emit: true, attacker: 歹徒 })`（目擊者 / ped-ambient 照既有反應）；喊叫 / 道謝走 `traffic.ambient.bubbles` + `anim.playGesture`
  - 槍戰 = `gangs.skirmish(sideA, sideB, { a, b, sec, weapon: 'pistol' })`（成員換色 `repaint(p)`）；流彈：槍戰成員未命中的 `weapon:fire` 沿射線 40 m 內第一個 0.45 m 內的路人 / 玩家 `combat.applyHit`（pistol 10，玩家在車內 `throughVehicle`）
  - 事件車 = `vehicles.adopt` + `dmg.attach`（`v.ai`、`v.streetEvent`），駕駛同 vigilante 逃犯車（路線跟隨、彎道減速、卡住倒車）+ wobble；事件車 / 警車生成點只取 `canSee(玩家 → 點)` 為 false 的車道點（同 adapters findSpawnPoint；`canSee` 省略 = 都看得到 → 不生成）；追車警車 = `police.spawnCar / driveCar / despawnCar`（既有 adapters 控制，不經 police.js、不追玩家）
  - 回收（不在玩家眼前消失）：行人解除 override，> 110 m 且離開視線（`traffic._hidden`）才 `traffic._recyclePed`；> 110 m 但看得到 → 不強制回收、交還 traffic 一般 LOD（90 s 上限同樣交還）；事件車：玩家正駕駛 / 下車棄置 / 熄火殘骸 → `onKeep`（一般回收名單），仍在逃者繼續開、> 150 m 且看不到才移除（45 s 上限交 onKeep）；收隊警車同樣只在 > 150 m 且看不到時 `despawnCar`，超過 90 s 仍看得到 → 停止巡邏、`driveCar(stop)` 煞停，之後一樣等看不到才移除；`cancel` 一律立即移除

### 32.2 跨檔最小擴充
- `gangs.js`：`skirmish(sideA, sideB, { a, b, sec, weapon })` → 成員 actor[]（指定骨架行人換成兩幫成員、`engage(war)` 互射 sec 秒，emit `gang:war { …, street: true }`）、`warring(actors?)` → 互毆中人數
- `map/marker-colors.js`：`'street-event': '#ffee58'`；`hud.js` `EDGE_KINDS` 加 `'street-event'`（超出半徑貼邊）；`map/big-map.js` 圖例「街頭事件」

### 32.3 接線（main.js）
- `streetEvents` / `streetWorld` 建在爆炸段之後；`repaint` = `repaintCharacter(p.character, p.citizen.look)` + `traffic._gangWeapon(p, weapon)`；`canSee` = `policeAdapters.canSee`；`isKept / onKeep` 同警車任務逃犯車（`adopted`）
- 每幀 `updateStreetEvents(dt, phoneOpen)` 接在 `updateExplosions` / `handleCarKo` 之後：手機 / BUSTED・WASTED / 噴漆 → 凍結（事件車煞停、邏輯 dt 0）；搶劫 / 警車任務 / 委託・外送・打工（`otherMissionBusy`）→ `busy`；暫停 / 全螢幕面板時 updateGame 不跑；專案目前無競速模式
- `view = traffic.view`（上一幀鏡頭）、`hour = dayNight.hour`、賞金 `economy.add(n, 'street')`、toast 走 `hud.toast`；小地圖 / 大地圖 `collectMarkers` 併入 `streetMarkers()`
- 犯行：`vigHooks.fugitiveActor` / `fugitiveShot(x, z, vehicle)` 併入 `streetEvents.isEventActor` / `shotAtEvent`（既有 `combat:hit` / `ped:dead` / `ped:knockdown` / `weapon:fire`（帶 `e.vehicle` = 打中的車）/ `vehicle:explode`（帶被炸的車）監聽沿用）；誤傷路人 / 警察、炸罪犯車旁的警車、撞警車照算
- 賞金歸屬：`router.onVehicleHitVehicle` 玩家駕駛的車撞到事件車 → `streetEvents.vehicleHitByPlayer(v)`
- `startGame`、`quitToMenu` → `cancelStreetEvents()`（`streetEvents.cancel()` + `streetWorld.reset()`）；除錯 `window.__game.streetEvents` / `streetWorld`（僅 dev）

### 32.4 回歸
- `node tools/test/v3-events.mjs`（純邏輯 + 替身，無 three：排程頻率 / 權重、同時上限 / 冷卻、生成距離 / 視野、四種事件開始・結束・制伏・逃脫、賞金與犯行豁免（真 wanted）、busy、cancel、幀率無關、每幀不配置、每幀成本 < 0.3 ms、world 轉接、接線）

## 33. V5 警方升級（罪惡之都；接線點在 `src/main.js`，介面以 `src/wanted/helicopter.js` / `police.js` / `adapters.js` 檔頭為準）

### 33.1 星數行為表
| 星數 | 下車警員開槍 | 車上警察開槍 | 直升機 | 艙門射手 | 路障 | 特警車 |
|---|---|---|---|---|---|---|
| 0–2 | ✗（追捕 / 拘捕，同 Phase 7） | ✗ | ✗ | ✗ | ✗ | ✗ |
| 3 | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 4 | ✓ | ✓ | ✓（1 架） | ✗ | ✗ | ✗ |
| 5 | ✓ | ✓ | ✓ | ✓ | ✓（≤ 2 組） | ✓（≤ 1 台、4 名特警） |
- 命中率：`police.js speedHitFactor(speed)` = 1 − 0.65 × 速度 / 30 m/s（下限 0.35）；警員 `hitChance(d, speed)` = 距離曲線（70% → 30%）× 速度係數；車上 × 0.8；直升機 `heliHitChance(d3, speed)` = 55% → 25%（45–95 m）× 速度係數。玩家在車內一律 `throughVehicle`，並扣玩家車耐久（警員 / 車上 20、直升機 20）

### 33.2 模組介面
- `src/wanted/helicopter.js`（純邏輯，不 import three；THREE / scene 注入才建模型）：`createHelicopter({ THREE?, scene?, bus?, wanted, combat?, heightAt?, obstacleTop?, explode?(x, y, z, { byPlayer, radius, power }), damageVehicle?(n), getPlayerActor?, isNight?, quality?, rng? })` → `{ update(dt, { player: { x, z, inVehicle, speed, down }, paused }) → seen, damage(n, { byPlayer }) → 是否打下, rayHit(ox, oy, oz, dx, dy, dz, max) → t | -1, cancel(), dispose(), setQuality(), state, active, pos, hp, spot, seen, cooldown, stats(), view }`
  - 狀態 `off → arrive → orbit → leave → off`；被打下 `down`（自旋墜落）→ 觸地 / 屋頂 `explode` → `off`、`HELI_RESPAWN` 60 s 內不再出動；同時至多 1 架（單一物件重用）
  - 高度：離地 `ALT_BASE` 50 ± 6 m（44–56，規格帶 40–60）；避障 = 機身圓盤（半徑 6 m 內 1.4 m 格點 + 外緣環）+ 前方 2.5 s 的 `obstacleTop` 最大值 + 12 m；下一步（每 1.4 m 一段）外緣環淨空 < 4 m → 本幀不水平前進、急升 22 m/s（水平寬度 ≥ 2 m 的障礙保證不穿模）
  - 高度場：`createHeliObstacleTop({ heightAt, solids, landmarkSolids? })`；main.js 傳 `buildings.colliders`（地標替換建築用模型高），地標另用 `src/ui/menu-tour.js` 的 `LANDMARK_SOLIDS` 分層量體（含伸出 OSM 輪廓外的部分）
  - 探照燈：地面光點以 16 m/s（5★ 21 m/s）追玩家；searching 時沿搜索圈內半徑 r × 0.6 的玫瑰線掃描（掃描點速度 ≤ 光點速度 × 0.85，盤旋中心跟著掃描點）；玩家在光圈 7 m 內且機腹到玩家的線段未被 `obstacleTop` 擋住 = `seen`；光點離機身 ≤ 65 m；SpotLight 常駐場景（intensity 0 = 關），low 檔 `castShadow = false`，關閉時 `shadow.autoUpdate = false`
  - 受擊：訂閱 `weapon:fire`（byPlayer、非 police），射線打機身球（3.2 m）/ 尾桁球（1.4 m），距離須 ≤ `e.dist` + 0.5；手槍每發 34、耐久 500（約 15 發）
  - 射手（5★）：`seen`（含遮蔽）、玩家未倒地（`down`）、3D 距離 ≤ 95 m，每 1.0–1.6 s 一發 `combat.applyHit({ weapon: 'pistol', damage: 12, throughVehicle: 車內 })`，emit `weapon:fire { police: true, heli: true }`
- `src/wanted/police.js` 增補：`createPolice` 回傳多 `cancelExtras()`、`roadblocks`（`[{ obj, recall }]`）、`swat`（特警車或 null）、`heading`；adapters 增補（皆選用，缺 = 功能關閉，Phase 7 測試替身不受影響）：`carFire(car, { x, z })`、`findRoadblockPoint(px, pz, dirX, dirZ, min, max) → { x, z, heading } | null`、`spawnRoadblock({ x, z, heading }) → { pos, alive }`、`despawnRoadblock(rb)`、`spawnSwat({ x, z, heading }) → car`、`spawnOfficer({ …, swat: true })`；`update` 的 `player` 可帶 `dirX / dirZ`（車頭方向，路障方向用；缺 = 位移取樣）
  - 車上開槍：≥3★、active、追捕中（無警員在外）、距 6–35 m 且看得見，每 1.2–2.0 s；emit `police:carshoot`（`police:shoot` 仍只代表下車警員）
  - 路障（5★、active）：前進方向 ±25.7°、150–250 m 的路口（`graph` 度數 ≥ 3 節點，退回玩家側 6 m），2 台橫停警車（停放車，可撞開 / 搶走，`isPoliceVehicle` 真）+ 4 個路錐（池化 ≤ 8）；生成間隔 ≥ 12 s、同時 ≤ 2 組；玩家越過 60 m / 距離 > 400 m / 星數 < 5 / 解除 → 離開玩家視線即回收（searching 只停止生成、既有路障保留）
  - 特警（5★）：1 台深色休旅車（`suv` #16181d、耐久 2000）不佔 `MAX_CARS`；靠近停車放 4 名特警（黑制服、hp 200、每發 18）不佔 `MAX_OFFICERS`，殉職不補；被毀 / 回收後 30 s 才再派；星數 < 5 → 全員依一般回收規則回收，回收中重回 5★ → 取消回收（孤兒特警除外）；`cancelExtras()` 連孤兒特警與特警殘骸立即回收
  - 玩家倒地（`player.down`：KO / BUSTED / WASTED）：車上警察、下車警員、直升機射手全部停火；main.js 在 `state.respawn` 期間凍結直升機
- `src/wanted/adapters.js` 增補：`hitChance(d, speed = 0)`、`sirenStarGain(stars)`（1★ 1.0 → 5★ 1.5）、`sirenFreq(t, offset, half)`（≥4★ 0.3 s 急促）、`graphJunctions(graph)`；deps 多 `damageVehicle(v, n)`、`graph`、`createCone()`；`getPlayer` 可回 `inVehicle / speed / vehicle`；`stats()` 多 `roadblocks / blockCars / cones`
- `src/wanted/ui.js` 增補：`createWantedUI({ …, alert = true, reducedMotion })`、`setAlertEnabled(on)`、`alertActive`；星星列 class `wanted-lv-N`（wanted.css：4★ 脈動、5★ 急促紅光）；≥4★ body 層 `.wanted-alert` 紅藍邊緣光暈（`reducedMotion()` 預設 `prefers-reduced-motion` 為真時不顯示、星星列加 `wanted-calm` 不脈動；搜索中閃爍 `wanted-flashing` 保留）

### 33.3 事件（§10 增補）
| 事件 | payload | 發出者 |
|---|---|---|
| `police:heli` | `{ type: 'arrive' \| 'orbit' \| 'leave' \| 'gone' \| 'down' \| 'crash' \| 'fire' \| 'cancel', x, y, z, byPlayer, stars }`（物件重用，聽者勿保存） | helicopter.js |
| `police:roadblock` | `{ type: 'spawn' \| 'despawn', x, z, count? }` | police.js |
| `police:swat` | `{ type: 'spawn' \| 'deploy' \| 'despawn', x, z, officers? }` | police.js |
| `police:carshoot` | `{ car, x, z, targetX, targetZ }` | police.js |

### 33.4 接線（main.js）
- 通緝段 `policeAdapters` deps 加 `damageVehicle: (v, n) => dmg.addDamage(v, n)`、`graph`、`createCone`（模組層 `createRoadCone()`，幾何 / 材質共用）；`getPlayer` 多回 `inVehicle / speed / vehicle`；`vigHooks` 旁宣告 `policeV5 = { update, cancel }` 掛鉤（預設無作用）
- `updateWanted`：`policeCtx.player.dirX / dirZ` = 駕駛中車頭方向；`seen = policeV5.update(dt, pl) || groundSeen`（直升機照到也算）→ `lastPoliceSeen` / `wanted.update`；暫停 / 全螢幕面板 / 手機開著時 updateWanted 不跑 = 凍結，噴漆換色中 `paused: true`
- V5 段（爆炸段之後）：`heli = createHelicopter({ …, obstacleTop: 地面 + buildingAt(x, z).height, explode → explosions.explode(…, { source: byPlayer ? 玩家 : null }) })`；覆寫 `policeV5.update / cancel`；`police:heli` down（byPlayer）→ `wanted.report(killPolice, witnessed)`；首次直升機 / 路障提示卡、特警 toast
- `startGame`、`quitToMenu` → `cancelRespawn()` 之後 `policeV5.cancel()`（直升機立即收起、路障 / 特警立即回收）；畫質切換 `applyQuality` → `heli.setQuality()`；除錯 `window.__game.heli`
- 被捕 / 送醫 / 噴漆 / 擺脫：一律經 `wanted.clear` → 直升機飛離、路障 / 特警回收（離開視線才 despawn；被捕 / 送醫傳送後即離開視線）

### 33.5 回歸
- `node tools/test/v5-police.mjs`（純邏輯 + 替身，無 three：星數行為表、直升機出現 / 離開 / 射手、避障高度、探照燈 seen、打下墜毀、命中率曲線、清除條件、上限、cancel、幀率無關、每幀成本）；`p7-police` / `p7-adapters` / `p7-ui` / `integration-p7` 不放寬

## 34. Phase 12 街頭競速 Street Race（P12；接線點在 `src/main.js`，介面以 `src/missions/race.js` 檔頭為準）

### 34.1 模組介面（`src/missions/race.js`，純邏輯，不 import three / rapier；DOM 只在 `createRaceHud`）
- `RACES`：3 條賽道 `{ id, name, difficulty 1–3, rivals 2–3, start: { name, x, z, heading, src }, checkpoints: [{ name, x, z, src }] × 5–7 }`——`qiqi-classic` 七期經典賽（老虎城 → 新光三越 → 大遠百 → 臺中市政府 → 國家歌劇院 → 秋紅谷）、`civic-loop` 市政環線賽（夏綠地公園 → 臺中市政府 → 捷運市政府站 → 都市發展局 → 惠中公園 → 新光三越 → 國家歌劇院）、`qiuhonggu-sprint` 秋紅谷飆速賽（秋紅谷 → 林酒店 → 惠泰公園 → 小來公園 → 第六分局 → 國家歌劇院 → 寶輝秋紅谷 → 老虎城）
  - 點位 = 地標（OSM B 層具名建築 / L 層公園，`src` 欄註明 id）旁的車道折線頂點（= `buildRoadGraph` 節點，最大連通塊、非橋梁）；起點取 ≥ 12 m 寬車道的直線段，`heading` = 起跑方向 `atan2(dx, dz)`
- `createRaces({ bus, rng?, config? })` → `{ update(dt, ctx) → snapshot, start(raceId, startCtx?) → boolean, cancel(), end(reason), canStart(raceId, startCtx) → { ok, reason }, nearestStart(x, z), markers(out), beacons(), serialize(), restore(data), bestOf(id), rank(), isRivalHandle(h), dispose(), active, phase, locked, race, elapsed, checkpoint, rivals, races }`
  - `startCtx = { inCar, player: { x, z }, stars, busy, speed?, stalled?, overturned?, toast? }`；`reason` ∈ `active` / `unknown` / `notDriving` / `far`（起點 `START_RADIUS` 8 m 外）/ `busy` / `wanted` / `stalled`（熄火）/ `overturned`（翻車 / 機車倒地）/ `moving`（\|speed\| ≥ `START_MAX_SPEED` 3 m/s）；`start` 遇 `wanted` toast「被通緝中不能開賽…」、`busy` / `stalled` / `overturned` / `moving`（「先停車再開賽」）toast 後回 false；省略 `startCtx` 不檢查（除錯）
  - `ctx = { player: { x, z }, inCar, wrecked, world, earn(n), toast?(text, sec) }`；`world` = `{ spawn(pt, { index, raceId }) → h | null, state(h) → { x, z, speed, health, exists, driven }, drive(h, { x, z, maxSpeed }), hold(h), remove(h) }`
  - `snapshot = { active, phase: 'idle'|'countdown'|'running', raceId, name, rank, total, cp, cpTotal, time, locked, countdown: 3|2|1|null, go, next: 檢查點|null, text: '名次 n/m｜檢查點 k/K｜mm:ss.s' }`
  - 倒數 `COUNTDOWN_SEC` 3 s：`locked` 真（整合層 `RACE_LOCK_CONTROLS` 全煞 + 手煞，煞停並維持位置）、對手車在 `gridSlots(start)`（起點兩側 ±3.5 m 並排、後排 8 m 遞補；被佔回 null 換下一格）生成並 `world.hold`；計時從 GO 起算（倒數多扣的時間計入，幀率無關）
  - 檢查點：本幀與上幀位置連線離「下一個」檢查點 ≤ `CP_RADIUS` 12 m 即通過（掃掠判定）；漏點不算（不會跳點）；對手車同規則
  - 對手車：`world.drive(h, 下一檢查點, DIFFICULTY_SPEED[難度] (19 / 22 / 25 m/s) × 個體差 ±4% × rubberBand(玩家進度 − 對手進度))`，橡皮筋 ±`RUBBER_MAX` 10%（進度差 150 m 飽和）；完賽後 `hold`（完賽判定優先：之後被撞毀 / 搶走不判退出）；未完賽而 `state` 不存在 / `driven`（被玩家搶走）/ 耐久 0 → 退出（名次排最後）並 `world.hold`（棄置車不再自行行駛）
  - 名次：完賽者依完賽時間（完賽後車況不影響）；未完賽先比已過檢查點數，同檢查點再比離下一點距離；比賽中 `nearestInteractable` 遮掉委託（同警車任務）
  - 完賽：`REWARDS` 第 1 / 2 / 3 名 NT$1000 / 400 / 150（`ctx.earn`）、toast「完賽！第 n 名｜mm:ss.s｜獎金 NT$X（｜新紀錄！）」、`best[id]` 取較小者、emit `race:finish`、對手車 `world.remove`
  - 退賽：下車 > `LEFT_SEC` 10 s `left`、`ctx.wrecked` `wrecked`（倒數中也算）、`end('busted'\|'wasted')`（另訂閱 `player:busted` / `player:wasted` 保底）→ toast「退賽：…」；`cancel()` 無聲（仍 emit `race:abort { reason: 'cancel' }`）
  - 標記：未開賽 → 各起點 `{ kind: 'race-start' }`；比賽中 → 下一檢查點 `{ kind: 'race-cp' }`；`beacons()` → `{ starts, checkpoint, last }`
  - 存檔：`serialize()` → `{ best: { raceId: 秒 } }` | null；`restore(data)`（undefined = 舊存檔 → 清空）
  - 時間吃呼叫端 dt（clamp ≤ 0.1 s），幀率無關
- `createRivalWorld({ vehicles, dmg?, traffic?, findRoute?, rng?, isFree?, isKept?, onKeep? })` → 上述 `world` + `update(dt)` / `brakeAll()` / `dispose()` / `cars`：`vehicles.adopt`（sedan / suv，`v.ai = true`、`v.racer = true`）+ `dmg.attach`；一般動態剛體（會被撞、會撞車流車），生成後不改寫座標（不瞬移）；生成格位與既有車輛（VehicleManager / `traffic.cars`）格位座標系淨空 2.8 × 5.5 m、`isFree(x, z)` 假（建築內）回 null；駕駛同 vigilante `createFugitiveWorld`（findRoute 路線跟隨、彎道減速、卡住 2.5 s 倒車）
- `createRaceHud({ root })` → `{ set(snapshot | null, arrowRad), dispose() }`：`.race-bar`（任務條）/ `.race-count`（3–2–1 / GO!）/ `.race-arrow`（下一檢查點方向箭頭，`arrowAngle(px, pz, yaw, tx, tz)` 順時針 rad）（`style.css`）
- 其他：`MARKER_COLORS['race-start'] = '#fb8c00'`（小地圖 `hud.js FLAG_KINDS` 畫旗幟）、`MARKER_COLORS['race-cp'] = '#ffca28'`（`EDGE_KINDS` 貼邊）、`MARKER_LABELS` 競速起點 / 競速檢查點；`BEACON_COLORS.race = 0xfb8c00`；入帳 reason `race` 跳字「競速」；`save.js` 選填頂層欄位 `races: { best }`（不升版；舊存檔無此欄 → 省略，格式錯誤整欄丟棄）

### 34.2 接線（main.js）
- 建立（車流外部狀態段之後、幫派段之前）：`races = createRaces({ bus, rng })`、`rivalWorld = createRivalWorld({ vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng, isFree: !buildingAt(x, z, RACE_SPAWN_PAD), isKept: v === state.vehicle \|\| v === cj.vehicle, onKeep: adopted.add })`、`raceHud`、起點光柱池（220 m 柱）與檢查點光柱池（`RACE_CP_BEACON`：半徑 12 m、高 45 m）；`raceMarkers()` 併入 `collectMarkers`
- 互斥：`state.racing`（getter = `races.active`）併入警車任務 `otherMissionBusy()` 與搶劫守門（`robCtx.onFoot = false`）；`vigHooks.active` 包裝為「警車任務 \|\| 競速」（委託 / 外送 / 垃圾車 / 打工 `extraBusy`、噴漆廠入口）；開賽 `busy` = `otherMissionBusy() \|\| vigilante.active`；比賽中犯行照常（`vigHooks.fugitiveActor / fugitiveShot` 未併入）
- 互動：駕駛中 `inter = raceInteractable(v)`（起點 8 m 內、priority 5），null 才走 `vigilanteInteractable(v) \|\| nearestInteractable(...)`；E / 手把 B / tb-interact 同一路徑；有星數仍顯示提示，按下 toast 不開賽
- 倒數：`races.locked` → 駕駛段 `v.setControls(driveControls({ x: 0, y: 0 }, true))`（手煞）
- 每幀 `updateRace(dt, phoneOpen)` 接在 `updateVigilante` 之後：手機 / `state.respawn` / `state.spraying` / 搶劫 / 警車任務中不推進並 `rivalWorld.brakeAll()`；`raceCar`（開賽 / 比賽中駕駛的車）`dmg.healthOf === 0` → `wrecked`；`rivalWorld.update(dt)` → `races.update` → `raceHud.set(r, arrowAngle(玩家, 車頭 yaw, 下一點))` → 光柱同步
- `beginRespawn` → `vigHooks.end(kind)`（包裝：先原警車任務掛鉤，再 `races.end(kind)`、收 HUD）；`quitToMenu` / `startGame` → `cancelRace()`（緊接 `cancelVigilante()`）；存檔 `getState().races = races.serialize()`、`startGame` → `races.restore(save.races)`
- 除錯：`window.__game.races` / `rivalWorld` / `raceHud`（`races.start('qiqi-classic')` 不檢查條件直接開賽）

### 34.3 回歸
- `node tools/test/p12-race.mjs`（賽道點位在路網上、純邏輯、對手車世界 / HUD 替身、save.js 相容）、`node tools/test/integration-p12.mjs`（main.js 抽段執行 + hud / 標記 / CSS / 文件靜態檢查）

## 35. Phase 13 計程車 / 救護車副任務 Taxi / EMS（P13；接線點在 `src/main.js`，介面以 `src/missions/taxi.js` / `ems.js` 檔頭為準）

### 35.1 模組介面（純邏輯，不 import three / rapier；DOM 只在 `createSideJobBar`）
- `createTaxi({ bus, rng?, config? })`（`taxi.js`）→ `{ update(dt, ctx) → snapshot, start(startCtx?) → boolean, cancel(), end(reason, ctx?), canStart(startCtx) → { ok, reason }, markers(out), beacons() → { dest }, snapshot(), dispose(), active, phase: 'idle'|'seek'|'ride', fares, earned, streak, fare, dest, trip }`
  - `startCtx = { inTaxi, busy, stalled?, overturned?, toast? }`；`reason` ∈ `active` / `notTaxi` / `busy` / `stalled` / `overturned`（後三者 toast 後回 false）；省略 `startCtx` 不檢查（除錯）
  - `ctx = { player: { x, z }, inTaxi, car?, speed, health, maxHealth, wrecked, world, earn(n), toast?, routeLength?(a, b) → m | null }`；載客中以上車那台車（`ctx.car`）為準：換開別台計程車 = 視同下車（不判到達 / 不比耐久，> 10 s → `left`，換回原車繼續）；`world = { spawnFare(center, rMin, rMax) → h | null, state(h) → { x, z, exists }, board(h), alight(h, at), remove(h) }`
  - 招客：每 `FARE_RETRY_SEC` 1 s 試 `spawnFare`（玩家 25–90 m）；乘客消失（`world.remove` 交還 handle）或離 > 250 m → 重找。上車：駕駛計程車、離乘客 ≤ `BOARD_RADIUS` 6 m、\|車速\| < 2 m/s
  - 目的地：`DESTINATIONS`（沿用 `RACES` 起點 / 檢查點的七期地標車道點，15 處）中離上車點直線 250–1400 m 者隨機；限時 = 路網距離 ÷ 10 m/s + 20 s（`tripLimit`）
  - 付費（離目的地 ≤ 10 m、\|車速\| < 2 m/s）：跳表 `meterFare` = NT$80 + NT$40 × 公里（四捨五入）、小費 `tipFor` = floor(跳表 × 0.5 × 剩餘時間 / 限時)、連載加成 `streakBonus` = round((跳表 + 小費) × 10% × min(連載 − 1, 5))
  - 乘客下車不付費（連載歸零、任務繼續）：`timeout` 超時、`damaged` 載客中耐久掉 > 25% 滿耐久
  - 結束：`left`（不在計程車上 > 10 s）/ `wrecked` / `busted` / `wasted`（另訂閱 `player:busted` / `player:wasted`）/ `quit`（任務中再按互動鍵）/ `cancel`（無聲）
  - 標記：招手乘客 `{ kind: 'taxi-fare' }`、載客中目的地 `{ kind: 'taxi-dest', label }`；`beacons().dest` = 目的地（光柱）
- `createEms({ bus, rng?, config? })`（`ems.js`）→ `{ update(dt, ctx) → snapshot, start(startCtx?), cancel(), end(reason, ctx?), canStart(startCtx), markers(out), beacons() → { dest }, snapshot(), dispose(), slots, active, phase: 'idle'|'spawn'|'collect'|'deliver', level, patients, picked, timeLeft, limit, earned, cleared }`
  - `startCtx = { inAmbulance, busy, stalled?, overturned?, toast? }`；`ctx = { player: { x, z }, inAmbulance, speed, wrecked, world, earn(n), heal(), toast? }`；`world` = `{ spawnPatient(center, rMin, rMax) → h | null, state(h), board(h), remove(h) }`
  - 關卡：傷患數 `patientsFor(level)` = 1 / 2 / 3（第 3 關起 3 名）；`spawn` 每 0.5 s 補 1 名（玩家 30–110 m），湊齊或 4 s 後已有 ≥ 1 名 → `collect` 開始計時；限時 `levelLimit` = 30 + 10 × 傷患數 + 估計路程（玩家 → 傷患貪婪鏈 → 醫院直線 × 1.4）÷ 10 m/s
  - 撿取：駕駛救護車、離最近未上車傷患 ≤ 6 m、\|車速\| < 2 m/s 連續 `PICK_SEC` 3 s（中斷歸零）→ `world.board`；全數上車 → `deliver`（`HOSPITAL` 12 m 內停車）→ `ctx.earn(300 × 關數)`、`ctx.heal()`（玩家生命值回滿）、下一關；通過 `MAX_LEVEL` 12 關 → `complete`
  - 結束：`timeout` / `lost`（傷患死亡 / 消失）/ `left` / `wrecked` / `busted` / `wasted` / `quit` / `complete` / `cancel`（無聲）；未上車傷患 `world.remove`（照常起身）
  - 標記：未上車傷患 `{ kind: 'ems-patient' }`、送醫中 `{ kind: 'ems-hospital' }`；`beacons().dest` = 送醫中的 `HOSPITAL`
- `createCurbPedWorld({ traffic, combat?, rng?, getPlayer?, spawnWalker? })`（`taxi.js`）：上述兩個 `world`。徵用 `traffic.peds` 漫步中路人（walk / wander、無 override、非幫派、combat normal）；乘客 = `brain.override` 原地站立面向玩家、每 2.6 s `anim.playGesture('wave')`；傷患 = `combat.knockdownActor` 倒地，`update(dt)` 每 0.5 s 刷新 combat 倒地計時（不自行起身），被扶起（getup / normal）→ 立即再 `knockdownActor` 壓回；傷患 `dying` / `dead` 一經判定即 `exists: false`（revive 後也不回任務）；徵用期間 `citizen.pinned = true`（`traffic.js` 依距離回收 / `_canRecycle` 跳過），`board` / `remove` / `dispose` 解除；`board` = `traffic._recyclePed`（人消失於車內）；`alight` 只在給 `spawnWalker` 時生成下車路人（目前未接）
- `createAmbulanceDepot({ vehicles, dmg?, spot, decorate?, isBusy? })`（`ems.js`）→ `{ update(dt, player), ensure(force, player?), isAmbulance(v), vehicle, spot, dispose() }`：遊戲中無救護車 → `vehicles.adopt({ type: 'suv', color: '#f4f4f2' })`（`v.ambulance = true`）+ `dmg.attach` + `decorate(v)`；毀損且無人駕駛 → 交一般回收，玩家離停放點 > 60 m 時補車；完好但棄置在離停放點 > `AMB_HOME_DIST` 30 m、無人駕駛且非 `isBusy`（main：正駕駛 / 搶車中 / 任務中的 `emsCar`）→ 玩家離棄車與停放點都 > 60 m（`ensure(true)` 不看玩家）時 `dmg.detach` + `vehicles.remove` 收回並在停放點補車；`ambulanceSpot()` = `HOSPITAL` 往道路 4.5 m、沿路緣 9 m（河南路三段車道內，車頭沿道路）
- `createSideJobBar({ root, prefix: 'taxi'|'ems' })` → `{ set(text | null, urgent), dispose(), el }`：`.taxi-bar` / `.ems-bar`（同 `.vig-bar` 樣式）、剩 ≤ 15 s 加 `.taxi-urgent` / `.ems-urgent`（`style.css`）
- 效能：snapshot / 標記 / 光柱目標重用物件；任務條文字只在顯示內容（整秒、趟數、金額、抬上車十分位）變化時重建；招客 / 傷患生成與倒地刷新錯開（1 s / 0.5 s）；時間吃呼叫端 dt（clamp ≤ 0.1 s），幀率無關
- 其他：`MARKER_COLORS` `taxi-fare` `#f5c518` / `taxi-dest` `#00e5a0` / `ems-patient` `#ff6e6e` / `ems-hospital` `#e53935`（`hud.js EDGE_KINDS` 貼邊、`MARKER_LABELS`）；`BEACON_COLORS.taxi = 0xf5c518`、`ems = 0xe53935`；入帳 reason `taxi` / `ems` 跳字「計程車」/「救護車」

### 35.2 接線（main.js）
- 建立（街頭競速段之前）：`taxi` / `ems` / `curbPeds = createCurbPedWorld({ traffic, combat, getPlayer: playerPos })` / `taxiBar` / `emsBar` / 光柱池 `SIDEJOB_BEACON` / `ambulances = createAmbulanceDepot({ vehicles, dmg, spot: ambulanceSpot(), decorate: decorateAmbulance })`
  - 救護車外觀：`decorateAmbulance` 在 `v.mesh` 下加 `ems-decor` 群組（兩側紅條 + 車頂紅 / 藍燈，共用單位方塊幾何、無貼圖 `MeshStandardMaterial`、不投影、不加光源）；頂燈 `AMB_FLASH_SEC` 0.25 s 紅藍交替（只改 `emissiveIntensity`，救護車任務中才閃）
- 互斥：`state.sideJob`（getter = `taxi.active || ems.active`）併入 `otherMissionBusy()`（警車任務 / 競速開賽 / 街頭事件 busy）、搶劫守門、`nearestInteractable` 遮掉委託；`vigHooks.active` 包裝（委託類 `extraBusy` / 噴漆廠入口）；開始 `busy` = `otherMissionBusy() || vigilante.active`
- 互動：駕駛中 `inter = raceInteractable(v)` → `vigilanteInteractable` / `nearestInteractable`（委託 / 打卡）→ 都沒有才 `sideJobInteractable(v)`（計程車 / 救護車：未開始 = 開始、進行中 = 收工；後備，不擋既有互動）；E / 手把 B / tb-interact 同一路徑
- 每幀 `updateSideJobs(dt, phoneOpen)` 接在 `updateGangs` 之後：手機 / `state.respawn` / `state.spraying` 不推進，但 `curbPeds.update(dt)` 照跑（世界照跑時 combat 仍推進起身）；`taxiCar` / `emsCar` 耐久 0 → `wrecked`；`routeLength` = `findRoute(graph, a, b).lengthM`；`earn` = `economy.add(n, 'taxi'|'ems')`；`heal` = `player.actor.hp = maxHp`
- `beginRespawn` → `vigHooks.end(kind)`（包裝：`taxi.end(kind)` / `ems.end(kind)`、收任務條）；`quitToMenu` / `startGame` → `cancelSideJobs()`（緊接 `cancelRace()`；含 `curbPeds.dispose()`、頂燈轉暗）；`startGame` → `ambulances.ensure(true)`
- 除錯：`window.__game.taxi` / `ems` / `curbPeds` / `ambulances`

### 35.3 回歸
- `node tools/test/p13-taxi.mjs`、`node tools/test/p13-ems.mjs`（純邏輯 + 世界 / HUD 替身）、`node tools/test/integration-p13.mjs`（main.js 靜態檢查 + 抽段執行、hud / 標記 / CSS / 文件）

## 附錄 B：Phase 4 接線說明（各單元 result 彙整，整合單元 I4a / I4b 照做）

### 共通
- 地標點：`landmarks = landmarkPoints(manifest ?? [], projectLatLon)`（manifest = public/models/manifest.json；缺檔回 []），傳給 missions / checkins / 大地圖
- interactable 仲裁（§17）：missions（3）> checkins（2）> food（1）；ammo pickups 自動拾取不需按 E；`hud.setPrompt(text)`；`snap.pressed.interact` → `act()`
- 全螢幕面板（任務接單 / 結算、大地圖、圖鑑）開啟時 `input.enabled = false`、遊戲暫停輸入；關閉時恢復；E / Esc 在面板開啟中由面板處理，遊戲不再處理
- 存檔 getState：`version: SAVE_VERSION`，帶 `weapons.serialize()`、`missions.serialize()`、`collect: { checkins: checkins.serialize(), foods: food.serialize() }`（兩者回傳陣列時直接放入）；讀檔後各自 `restore(save.xxx)`；stats 的 missionsDone / missionsFailed 由 `trackMissionStats(bus, extraStats)`（missions/index.js，依 `MISSION_STAT_EVENTS`：`mission:*` 與 `event:*` 的 complete / fail）累加，shotsFired 由整合層依 `weapon:fire`（byPlayer）累加（economy.snapshot 已保留新統計欄位）

### 武器（W1，細節見 src/weapons/WIRING.md）
- `weapons.attack(aim)` 取代 `player.punch()`（fist 內部仍走 combat 拳擊）；持手槍時 `snap.down.attack` 可連發（半自動間隔由武器定）
- 每幀：`aim = { origin, dir（鏡頭中心射線）, aiming: snap.down.aim && current==='pistol', muzzle, candidates }` → `weapons.update(dt, aim)`；`const k = weapons.recoilKick?.()` → `rig.addRecoil(k.pitch, k.yaw)`；`rig.update(…, { …, aim: aim.aiming })`
- `raycast` / `sweep` 以 `PhysicsWorld.castRay` / `castShape` 實作，collider → actor 以行人剛體對照表查
- `weapon:fire`（byPlayer）→ 對 30 m 內行人 `brain.hear({ type: 'gunshot', x, z })`（`gunshotListeners` 見 WIRING.md）
- `snap.pressed.slot1/2/3` → `weapons.select(0/1/2)`；`weaponCycle` → `cycle()`；`reload` → `reload()`；駕駛中不處理武器輸入且武器模型隱藏
- 武器 HUD / 觸控武器鈕 / 輪盤 / 裝填鈕 / 瞄準鈕：`src/weapons/hud.js`（依 WIRING.md 建立於 `#touch-ui` 或 body）；`tb-interact` 由 touch.js 預設註冊（隱藏）、hud.js 依互動提示顯示（步行 / 駕駛皆可，§4.5）
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

## 霓虹夜色（V1，src/neon.js）
- `buildBuildings(scene, opts)`（src/buildings.js）回傳值新增 `neon`：`buildNeon` 的結果（單一合併 mesh `neon-signs` + 店名貼圖集，固定種子擺放）；`dispose()` 釋放幾何、材質、貼圖與濕亮路面 envMap
- 每幀由 `environment.update` 呼叫 `updateNeon`（重用參數物件，不配置）：日夜亮度走 `registerNight`、閃爍為 shader uniform；quality tier 經 `weather.getTier()` 帶入，low 關閉閃爍與濕亮路面
- 濕亮路面：材質以 `registerWetSurface(material)` 登記（src/world.js 車道、src/street.js 路口），濕度 = max(夜間 × 0.85, 雨量)；envMap 只在 tier 切換時增減（重編譯一次）
- 色調：黃昏洋紅 / 橘紫、夜晚深藍紫（src/daynight.js SKY_KEYS），白天數值與 V1 前相同（tools/test/v1-neon.mjs 逐點比對）
- 招牌尺寸（V1b，`SIGN_SIZE`）：店面帶橫招牌寬 = 立面寬 × 0.85 夾 2.5–5 m（高 = 寬 / 4，0.7–1.25 m）；直立招牌高 3–6 m（種子決定，外伸 = 高 / 4.5 夾 0.8–1.3 m）；樓頂招牌寬 = 臨路邊 × 0.7 夾 8–22 m、高 ≤ 4.8 m、出現率 0.4；側面直條 2.4 × 9 m。emissive 上限仍 2.2（白天 0）
- 選擇性泛光（V1b，src/postfx.js）：`createPostFx(renderer, scene, camera, { tier, THREE, passes: await loadPostFxPasses(), night: () => dayNight.night })` → `{ render(), setTier(id), resize(), dispose(), info }`；main.js 以 `postfx.render()` 取代 `renderer.render`，`drawCalls = postfx.info.sceneCalls`（探針 pass 記錄場景本身 draw call，不計 post pass），`onResize` 呼叫 `resize()`、`applyQuality` 呼叫 `setTier(tier)`；canvas 尺寸 / pixelRatio 改變而未呼叫 resize 時，下一幀 render 自動跟上
  - 流程：RenderPass（HalfFloat RT + MSAA：mid 2 / high 4）→ UnrealBloomPass → OutputPass（沿用 renderer.toneMapping ACES / exposure、sRGB 輸出）
  - 選擇方式：亮度門檻、不另渲染 bloom layer（draw call 不增）；高通改「最大色版」：霓虹 2.2、車頭燈 2.0–2.5、警燈 4–6、爆炸火光超過夜間門檻 1.45，窗光 1.3 / 店面微光 1.2 不發光暈。要讓新物件發光暈，emissive 最大色版需 ≥ 1.65（門檻 + 半過渡寬）
  - 強度：`bloomParams(night)` = 0.9 × smoothstep(0.02, 0.5, night)（黃昏 night 0.4 ≈ 0.8）；門檻黃昏 2.1 → 全夜 1.45；強度 < 0.005（白天）時直接 `renderer.render`，零 post 成本且保留 canvas MSAA
  - tier：low 完全不建 composer（含 pass 載入失敗）；mid 泛光鏈半解析度；high / ultra 全解析度；tier 切換時釋放 / 重建
  - `dispose()` 釋放 composer（兩張 RT）與 RenderPass / Bloom / Output；之後 render 退回直接渲染
