# 手機版參考：aether / aether-online 的做法整理

整理日期 2026-09-30（唯讀閱讀兩個參考專案後的摘要，供臺中GTA 手機版 D4 移植參考）。
單機版 aether 幾乎沒有手機支援（只有基本 viewport、窄螢幕隱藏說明、DPR 上限、動態解析度）；手機相關實作集中在 aether-online 的 public/js/touch.js、public/js/lobby.js、public/style.css 檔尾「手機 / 觸控」段、public/js/main.js 前段與輸入段。以下行號指 aether-online，除非另註。

## 1. 螢幕旋轉
- 鎖方向必須先成功進入全螢幕：在 requestFullscreen() 的 then 裡呼叫 screen.orientation.lock('landscape')，外包 try/catch，promise 也 .catch(() => {}) 靜默（lobby.js:171-177；「回到全螢幕」按鈕 touch.js:327-335）。
- PWA manifest.webmanifest 設 "orientation": "landscape"。
- 直向提示遮罩 #rotateMask（圖示 + 「請轉橫」）純 CSS 控制：@media (orientation: portrait) { body.touch.playing #rotateMask { display: flex; } }（style.css:346-352），z-index 60，圖示在 0 與 -90 度間擺動。只在遊戲中擋直向（body.playing），大廳可直向操作。
- 沒有專門 orientationchange 處理：resize 與 visualViewport.resize 都呼叫 resize()（main.js:191,193）；上滑全螢幕流程另把 resize、visualViewport.resize、orientationchange 接到 300ms 防抖的 check()（touch.js:94-97,113-115）。
- 判斷橫向用 innerWidth > innerHeight（touch.js:30），不讀 screen.orientation.type。
- 踩坑：iOS 的 screen.width/height 固定為直向值，須依方向取對應邊（touch.js:31）；直向遮罩與上滑遮罩用 orientation media query 互斥（style.css:388-393）。
- iOS 退路：沒有 lock，靠直向遮罩提示；另有一次性 #iosHint「橫向拿手機，加到主畫面可全螢幕」（lobby.js:186-196）。
- 移植建議：照搬「全螢幕成功後才 lock、失敗靜默」與「純 CSS 直向遮罩（只在 playing 時顯示）」；開車需寬視野，橫向鎖定合適。

## 2. 全螢幕
- 觸發時機：在「出發」按鈕 click handler 內同步呼叫 goFullscreen()（註解：須在使用者手勢內同步呼叫，lobby.js:208）；同一手勢內依序做 wake lock 與音訊解鎖（lobby.js:209-210）。只對觸控裝置做，桌機用 F 鍵。
- API 順序：① de.requestFullscreen({ navigationUI: 'hide' })，成功則鎖方向，失敗走 swipeFallback；② 無標準 API 用 de.webkitRequestFullscreen()，舊 webkit 無 promise，500ms 後檢查 webkitFullscreenElement / fullscreenElement，都沒有視為被拒（lobby.js:168-183）；③ 都沒有（iPhone Safari）直接 swipeFallback()。
- 退出偵測（touch.js:303-317）：監聽 fullscreenchange 與 webkitfullscreenchange；已退出且仍在遊戲中，防抖 300ms 後顯示大按鈕「點一下，回到全螢幕」（#fsBackBtn），再 request 一次，被拒改走上滑流程（touch.js:318-338）。
- iOS 退路一「上滑全螢幕」（touch.js:15-127）：html.swipe-scroll 讓 body 高度 calc(100vh + 240px)；顯示 #swipeUp 遮罩「往上滑，進入全螢幕」；判定參數 GROW=60（innerHeight 增加 60px 以上算網址列收起）、FULL_K=0.95（或高度達螢幕對應邊 95%）、DROP=40（縮回 40px 以上算工具列回來）、DEBOUNCE=300（避免鍵盤彈出誤判）；收起後 scrollTo(0,1) 並重算 canvas；canvas 與 HUD 都 position: fixed; inset: 0；遮罩期間 body.swipe-mask { touch-action: pan-y }。
- 遮罩期間觸控輸入歸零並自動巡航（touch.js:38-54，避免無輸入撞山）。
- iOS 退路二 PWA：apple-mobile-web-app-capable=yes、mobile-web-app-capable=yes、apple-mobile-web-app-status-bar-style=black-translucent、theme-color、link rel=manifest（index.html:5-10）；manifest "display": "fullscreen"；已從主畫面啟動（navigator.standalone 或 matchMedia('(display-mode: fullscreen), (display-mode: standalone)')）就不跑上滑流程（touch.js:98-104）。
- iosHint 只顯示一次（localStorage key 記錄，顯示 5 秒）。
- 高度：html, body { height: 100%; height: 100dvh; }（style.css:2）。
- 移植建議：三段式退路 requestFullscreen → webkit 前綴 + 500ms 檢查 → 上滑流程，再加 PWA manifest；遮罩期間的「自動接管」在開車時改為「自動煞停」。

## 3. 觸控操作機制
- 一律用 Pointer Events，不用 touch events 做遊戲輸入（唯一例外：排行榜 passive touchstart 只用來暫停自動捲動）。
- 浮動虛擬搖桿（touch.js:215-257、style.css:291-303）：感應區 #touchPad 左半螢幕（width 50%、height 100%、touch-action: none、z-index 7，只在 body.touch.playing 顯示）；靜止時底座在 left: calc(110px + safe-area-inset-left); top: 70%，透明度 .55；pointerdown 時底座移到觸點、透明度 1；RADIUS = 64px（底座 128px、頭 58px）；DEAD = 0.08，死區外重新映射到 0..1（避免跨死區跳值）；記下 stickId = e.pointerId，pointermove 只處理同 id，setPointerCapture；結束事件 pointerup / pointercancel / lostpointercapture 三個；放開時搖桿頭 transition: transform .12s 彈回；所有 handler 都 e.preventDefault()。
- 按住型按鈕 #boostBtn（touch.js:259-281）：右下 calc(28px + safe-area)，直徑 108px；自己追蹤 pointerId 並 capture，按下 transform: scale(.94)。開關型按鈕用 click，放右上小鈕列。
- 輸入介面與裝置無關：window.AetherTouch.state = {x, y, boost} 與鍵盤同名同型，readInput() 相加後 clamp 到 -1..1（main.js:1371-1383）。
- 失焦歸零：blur 或 visibilitychange（hidden）時搖桿與按鈕全部歸零（touch.js:294-301）。
- 防縮放 / 防選單：viewport user-scalable=no；body { touch-action: none; overscroll-behavior: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; user-select: none }；document 上 gesturestart preventDefault 擋 iOS 雙指縮放；遊戲中擋 contextmenu；按鈕 touch-action: manipulation。
- 長按：pointerdown 開 setTimeout（1000ms），移出範圍 / pointerup / pointerleave / pointercancel 取消，長按觸發後的 click 忽略（voice.js:529-549）。
- 手勢衝突：大廳 touch-action: pan-y; overscroll-behavior: contain；可橫滑清單 touch-action: pan-x pan-y + scroll-snap。
- 鏡頭拖曳：未實作（飛行遊戲）。
- 移植建議：搖桿模組（pointerId、capture、三種結束事件、死區重映射）直接沿用；臺中GTA 另需右半螢幕拖曳鏡頭，參考專案沒有，要自寫並沿用同一套 pointerId 追蹤。

## 4. 安全區與版面
- viewport：width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no。
- 安全區兩層：body 四邊 padding 為 env(safe-area-inset-*)；canvas position: fixed; inset: 0 鋪滿含瀏海區；每個觸控 HUD 元素各自 calc(Npx + env(safe-area-inset-*)) 定位。
- 觸控版 HUD 重新配置（body.touch，style.css:313-343）：速度 / 高度 / 分數從左下搬到上方置中（top: calc(10px + safe-top)，數字 30px 改 18px）；表情列收進一顆切換鈕，4 秒無動作自動收起；排行榜 max-width: min(60vw, 320px) 只顯示 5 列；.help 與鍵盤提示在觸控裝置隱藏；提示文案分 .kb-hint / .touch-hint 兩套。
- 字級大量用 clamp()；名牌字級隨 DPR 調整（高 DPR 螢幕實體較小，略縮）。
- 斷點：max-width 700px、900px。沒有另做直向遊戲 HUD，只有直向遮罩。
- 移植建議：「canvas 鋪滿 + HUD 元素各自加 safe-area」與「body.touch class 一次切換整套 HUD 配置」照搬；駕駛時儀表放上方置中、右下放油門 / 煞車大鈕。

## 5. 手機偵測與效能分級
- 偵測：matchMedia('(pointer:coarse)').matches || ('ontouchstart' in window)；網址參數 ?touch=1 / ?touch=0 強制切換（方便桌機測試）；結果寫到全域 isTouch，故觸控模組要先於主程式載入。沒有 UA 判斷，iOS 分支靠功能偵測。
- 品質兩級 QUALITY = IS_TOUCH ? 0 : 1（main.js:97-103）：DPR 上限 1.5（桌機也 1.5）；bloom 解析度觸控 1/8、桌機 1/4；樹木實例觸控減半；地形觸控每邊格數減半（只重建 index）；shader 以 uQuality 控制細節八度 / AO 取樣。
- 動態解析度（兩專案都有）：fpsAvg 以 lerp 0.05 平滑、每秒評估；連續 2 秒 < 40fps → renderScale -= 0.15（下限 0.55）；連續 6 秒 > 57fps → += 0.1（上限 1）；調整後 resize() 重建 render target；HUD 顯示 fps · N%。
- WebGL context { antialias: false, alpha: false, powerPreference: 'high-performance' }，自建 MSAA FBO（觸控未降）。
- 陰影 / 視距降級：未實作。
- 踩坑（由程式推斷，原始碼無註解）：'ontouchstart' in window 會把觸控筆電判成觸控，整套降級與觸控 UI 都會套上。
- 移植建議：renderer.setPixelRatio(Math.min(dpr, 1.5) * renderScale) + 同一套 fps 自適應 + 「觸控 = 低品質」兩級開關（建築 / 樹木實例減半、陰影降級或關閉由本專案自訂）。

## 6. 其他細節
- 螢幕不變暗（touch.js:129-190）：同一出發手勢內 navigator.wakeLock.request('screen')；被系統釋放或回前景時若仍在遊戲中重新 request；被拒靜默；無 wakeLock（iOS < 16.4）用 NoSleep 手法（隱藏 playsinline muted loop 的靜音 mp4，每 15 秒檢查 paused 再 play）。
- 音效解鎖：手勢內 new AudioContext()（webkitAudioContext 退路）並 resume()、播 1-sample 靜音 buffer；另 play 一個 playsinline 靜音 audio 元素（iOS 音訊 session）；之後在 document 以 capture + passive 監聽 pointerdown / touchend / click / keydown，AudioContext 非 running 就 resume（處理 iOS interrupted）。
- 切背景：只做輸入歸零與重取 wake lock，沒有明確暫停，靠 rAF 在背景停止；dt 上限 min(0.05, …) 避免回前景跳幀。
- 震動 API：未實作（「震動」是鏡頭 shake）。
- 大廳背景跑遊戲 demo 兼預熱。
- 輸入法：e.isComposing 時不截字，compositionend 再處理；出發時 blur() 收鍵盤。
- 移植建議：出發鍵一次手勢內做完「全螢幕 + 鎖方向 + wake lock + 音訊解鎖」；切背景時比參考專案多做一步：明確暫停車輛物理（固定步累加器歸零）。

## 參考檔案索引（唯讀，本 repo 外）
- aether-online：public/js/touch.js（觸控偵測、搖桿、按鈕、上滑全螢幕、退出偵測、wake lock）、public/js/lobby.js（goFullscreen、鎖方向、iOS 提示，155-218 行）、public/style.css（1-10、260-419 行）、public/index.html（viewport / PWA meta、遮罩 DOM）、public/manifest.webmanifest、public/js/main.js（品質分級 97-103、resize / DPR 190-193 與 304-311、輸入合併 1338-1385、動態解析度 1750-1765）、public/js/voice.js（音訊解鎖、長按）
- aether：index.html、style.css、js/main.js（DPR 上限與動態解析度 224-229、884-892）
