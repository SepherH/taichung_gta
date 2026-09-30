// 手機支援：觸控偵測、開始手勢內全螢幕 / 螢幕不變暗（wake lock，不支援時靜音影片迴圈後備）、上滑全螢幕退路、
// 退出全螢幕偵測、直向一次性提示、輸入封鎖判斷、效能分級（core/quality.js）與自適應解析度
// 移植自 aether-online（docs/ref/mobile-reference.md §1、§2、§5、§6）；本檔不 import three，可在 node 無頭測試
//
// 自註冊：Input 建構時呼叫 initMobile()（冪等），在 #start-btn 上另掛 click，與 loading.js 的開始 handler 同屬一次手勢
// 橫直向都可玩：不鎖方向；直向時 #rotate-mask 改為一次性提示（按「仍用直向遊玩」關閉，記在 sessionStorage），關閉後觸控照常
// 上滑全螢幕遮罩（全螢幕被拒時）：附「不用全螢幕，直接玩」鈕（本次分頁不再出現，記在 sessionStorage）；
//   顯示 4 秒後 innerHeight 仍沒變化（in-app 瀏覽器 / 無 allowfullscreen 的 iframe，網址列收不起來）→ 縮成角落小提示並解除輸入封鎖
// 整合接線：setQualitySetting(settings.get('quality'))、setGameActive(是否遊戲進行中)、
//   applyRendererQuality(renderer, 1, scene) / createAdaptiveResolution(renderer).tick(dt)
import { QUALITY_TIERS, resolveQuality } from './core/quality.js';

// ---------- 參數 ----------
const WEBKIT_CHECK_MS = 500; // 舊 webkit 全螢幕無 promise，延遲檢查是否成功
const FS_BACK_DEBOUNCE_MS = 300; // 被退出全螢幕後顯示「回到全螢幕」的防抖
// 上滑全螢幕（iOS Safari 退路）
const SWIPE_GROW = 60; // innerHeight 增加超過此值視為網址列已收起
const SWIPE_FULL_K = 0.95; // 或高度達螢幕對應邊的此比例
const SWIPE_DROP = 40; // 從最大值縮回超過此值視為工具列回來
const SWIPE_DEBOUNCE_MS = 300; // 防抖（避免鍵盤彈出誤判）
const SWIPE_STALL_MS = 4000; // 遮罩顯示此時間後 innerHeight 仍沒變化 → 縮成角落小提示、不再封鎖輸入
const SWIPE_SKIP_KEY = 'tcgta.noFullscreen'; // sessionStorage：本次分頁已選「不用全螢幕，直接玩」
// 直向提示
const PORTRAIT_OK_KEY = 'tcgta.portraitOk'; // sessionStorage：本次分頁已選「仍用直向遊玩」
// NoSleep 後備（無 Wake Lock API）：隱藏的 1×1 canvas 串流影片靜音迴圈播放
const NOSLEEP_FPS = 1;
const NOSLEEP_DRAW_MS = 10000; // 定期重畫一次，讓串流持續有畫格
// 自適應解析度
const FPS_LERP = 0.05;
const EVAL_INTERVAL = 1; // 秒
const FPS_LOW = 40;
const FPS_HIGH = 57;
const LOW_SECONDS = 2;
const HIGH_SECONDS = 6;
const SCALE_DOWN = 0.15;
const SCALE_UP = 0.1;
const SCALE_MIN = 0.55;
const SCALE_MAX = 1;

const hasWindow = typeof window !== 'undefined';

function urlParam(name) {
  if (!hasWindow || !window.location) return null;
  try {
    return new URLSearchParams(window.location.search || '').get(name);
  } catch (err) {
    return null;
  }
}

function mediaMatches(q) {
  return !!(hasWindow && window.matchMedia && window.matchMedia(q).matches);
}

// ---------- 觸控偵測 ----------
let touchCache = null;

export function isTouch() {
  if (touchCache !== null) return touchCache;
  const forced = urlParam('touch');
  if (forced === '1') touchCache = true;
  else if (forced === '0') touchCache = false;
  else touchCache = hasWindow && (mediaMatches('(pointer:coarse)') || 'ontouchstart' in window);
  return touchCache;
}

// 已從主畫面（PWA）啟動
export function isStandalone() {
  return !!(hasWindow && (window.navigator.standalone || mediaMatches('(display-mode: fullscreen), (display-mode: standalone)')));
}

function isPortrait() {
  return hasWindow && window.innerWidth < window.innerHeight;
}

// ---------- 狀態 ----------
const state = {
  inited: false,
  playing: false, // 已按過開始（全螢幕等只在第一次開始手勢做）
  active: false, // 遊戲進行中（非暫停 / 選單）：螢幕不變暗只在此時啟用
  swipeActive: false, // 上滑遮罩顯示中（含縮成角落小提示）
  swipeMini: false, // 上滑遮罩已縮成角落小提示（不封鎖輸入）
  swipeSkipMem: false, // sessionStorage 不可用時的「不用全螢幕」記憶
  portraitTip: false, // 直向提示顯示中
  portraitOkMem: false, // sessionStorage 不可用時的「仍用直向」記憶
  wakeLock: null,
  noSleep: null, // { video, timer } 後備
};

// ---------- 直向一次性提示 ----------
function portraitDismissed() {
  try {
    return window.sessionStorage.getItem(PORTRAIT_OK_KEY) === '1';
  } catch (err) {
    return state.portraitOkMem === true;
  }
}

function dismissPortrait(e) {
  if (e && e.preventDefault) e.preventDefault();
  state.portraitOkMem = true;
  try {
    window.sessionStorage.setItem(PORTRAIT_OK_KEY, '1');
  } catch (err) {
    // 無痕 / 停用儲存：只記在記憶體
  }
  updatePortraitTip();
}

// 以行內 style 控制 #rotate-mask（蓋過 style.css 直向媒體查詢的 display:flex）；回傳是否顯示中
function updatePortraitTip() {
  if (!hasWindow || typeof document === 'undefined') return false;
  const show = state.playing && isTouch() && isPortrait() && !portraitDismissed();
  if (show !== state.portraitTip) {
    state.portraitTip = show;
    const mask = document.getElementById('rotate-mask');
    if (mask) mask.style.display = show ? 'flex' : 'none';
  }
  return show;
}

function ensurePortraitButton() {
  const mask = document.getElementById('rotate-mask');
  if (!mask) return;
  mask.style.display = 'none';
  if (document.getElementById('portrait-ok')) return;
  const btn = document.createElement('button');
  btn.id = 'portrait-ok';
  btn.type = 'button';
  btn.textContent = '仍用直向遊玩';
  btn.addEventListener('click', dismissPortrait);
  mask.appendChild(btn);
}

// 觸控輸入是否應封鎖（直向提示或上滑全螢幕遮罩顯示中）；touch.js 每幀查詢（順便更新直向提示）
// 上滑遮罩在直向時被 style.css 隱藏（#swipe-up display:none），因此只在橫向時封鎖，避免直向遊玩時無聲卡住；
// 縮成角落小提示後也不封鎖
export function isInputBlocked() {
  if (!state.playing || !isTouch()) return false;
  return updatePortraitTip() || (state.swipeActive && !state.swipeMini && !isPortrait());
}

// ---------- 全螢幕 ----------
function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

// 必須在使用者手勢內同步呼叫
function goFullscreen() {
  const de = document.documentElement;
  if (de.requestFullscreen) {
    let p;
    try {
      p = de.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      startSwipeFallback();
      return;
    }
    if (p && p.then) p.then(null, startSwipeFallback);
  } else if (de.webkitRequestFullscreen) {
    try {
      de.webkitRequestFullscreen();
    } catch (err) {
      // 由下方延遲檢查處理
    }
    setTimeout(() => {
      if (!fsElement()) startSwipeFallback();
    }, WEBKIT_CHECK_MS);
  } else {
    startSwipeFallback();
  }
}

// ---------- 上滑全螢幕退路 ----------
let swipeInited = false;
let swipeBase = 0;
let swipeMax = 0;
let swipeTimer = 0;
let stallTimer = 0;
let stallHeight = 0;

function swipeSkipped() {
  try {
    return window.sessionStorage.getItem(SWIPE_SKIP_KEY) === '1' || state.swipeSkipMem;
  } catch (err) {
    return state.swipeSkipMem === true;
  }
}

// 「不用全螢幕，直接玩」：關閉遮罩，本次分頁不再出現
function skipSwipe(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (e && e.stopPropagation) e.stopPropagation();
  state.swipeSkipMem = true;
  try {
    window.sessionStorage.setItem(SWIPE_SKIP_KEY, '1');
  } catch (err) {
    // 無痕 / 停用儲存：只記在記憶體
  }
  setSwipeMask(false);
  // 不再需要比視窗高的捲動版面：還原並讓 main.js 的 onResize 重算 canvas
  document.documentElement.classList.remove('swipe-scroll');
  if (window.scrollTo) window.scrollTo(0, 0);
  window.dispatchEvent(new Event('resize'));
}

function ensureSwipeButton() {
  const mask = document.getElementById('swipe-up');
  if (!mask || document.getElementById('swipe-skip')) return;
  const btn = document.createElement('button');
  btn.id = 'swipe-skip';
  btn.type = 'button';
  btn.textContent = '不用全螢幕，直接玩';
  btn.addEventListener('click', skipSwipe);
  mask.appendChild(btn);
}

function setSwipeMini(on) {
  state.swipeMini = on;
  const mask = document.getElementById('swipe-up');
  if (mask) mask.classList.toggle('mini', on);
  document.body.classList.toggle('swipe-mask', state.swipeActive && !on);
}

// 遮罩顯示 SWIPE_STALL_MS 後檢查：高度沒變化（網址列收不起來）→ 縮成小提示；有變化（玩家正在滑）→ 再等一輪
function armStall() {
  clearTimeout(stallTimer);
  stallHeight = window.innerHeight;
  stallTimer = setTimeout(() => {
    if (!state.swipeActive || state.swipeMini) return;
    if (Math.abs(window.innerHeight - stallHeight) < 1) setSwipeMini(true);
    else armStall();
  }, SWIPE_STALL_MS);
}

function screenSide() {
  const s = window.screen || {};
  // iOS 的 screen.width / height 固定為直向值，依目前方向取對應邊
  const long = Math.max(s.width || 0, s.height || 0);
  const short = Math.min(s.width || 0, s.height || 0);
  return isPortrait() ? long : short;
}

function setSwipeMask(on) {
  if (on && swipeSkipped()) on = false;
  state.swipeActive = on;
  const mask = document.getElementById('swipe-up');
  if (mask) mask.classList.toggle('hidden', !on);
  setSwipeMini(false);
  clearTimeout(stallTimer);
  if (on) armStall();
}

function swipeCheck() {
  const h = window.innerHeight;
  if (state.swipeActive) {
    if (h >= swipeBase + SWIPE_GROW || h >= screenSide() * SWIPE_FULL_K) {
      setSwipeMask(false);
      swipeMax = h;
      window.scrollTo(0, 1);
      window.dispatchEvent(new Event('resize')); // 讓 main.js 的 onResize 重算 canvas
    } else {
      swipeBase = Math.min(swipeBase, h);
    }
  } else {
    swipeMax = Math.max(swipeMax, h);
    if (h <= swipeMax - SWIPE_DROP) {
      swipeBase = h;
      setSwipeMask(true);
    }
  }
}

function scheduleSwipeCheck() {
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(swipeCheck, SWIPE_DEBOUNCE_MS);
}

function startSwipeFallback() {
  if (isStandalone() || swipeSkipped()) return;
  ensureSwipeButton();
  document.documentElement.classList.add('swipe-scroll');
  swipeBase = window.innerHeight;
  swipeMax = swipeBase;
  setSwipeMask(true);
  if (swipeInited) return;
  swipeInited = true;
  window.addEventListener('resize', scheduleSwipeCheck);
  window.addEventListener('orientationchange', scheduleSwipeCheck);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleSwipeCheck);
}

// ---------- 螢幕不變暗 ----------
function hasWakeLockApi() {
  const wl = window.navigator && window.navigator.wakeLock;
  return !!(wl && wl.request);
}

function requestWakeLock() {
  if (!hasWakeLockApi()) {
    startNoSleepVideo(); // iOS < 16.4 等：靜音影片迴圈後備
    return;
  }
  if (state.wakeLock) return;
  window.navigator.wakeLock.request('screen').then(
    (lock) => {
      if (!state.active) {
        lock.release().catch(() => {}); // 取得前已暫停
        return;
      }
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    },
    () => {},
  );
}

function releaseWakeLock() {
  if (state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    try {
      const p = lock.release();
      if (p && p.catch) p.catch(() => {});
    } catch (err) {
      // 已釋放
    }
  }
  stopNoSleepVideo();
}

// 以程式產生的影片來源（不新增素材檔）：1×1 canvas 的 captureStream，靜音、inline、迴圈播放
function startNoSleepVideo() {
  if (state.noSleep) {
    playQuiet(state.noSleep.video);
    return;
  }
  const canvas = document.createElement('canvas');
  if (!canvas.captureStream) return; // 無法產生串流：放棄（螢幕可能變暗）
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext && canvas.getContext('2d');
  const draw = () => {
    if (!ctx) return;
    ctx.fillStyle = ctx.fillStyle === '#000001' ? '#000000' : '#000001';
    ctx.fillRect(0, 0, 1, 1);
  };
  draw();
  let stream;
  try {
    stream = canvas.captureStream(NOSLEEP_FPS);
  } catch (err) {
    return;
  }
  const video = document.createElement('video');
  video.id = 'nosleep-video';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none' });
  video.srcObject = stream;
  document.body.appendChild(video);
  state.noSleep = { video, timer: setInterval(draw, NOSLEEP_DRAW_MS) };
  playQuiet(video);
}

function playQuiet(video) {
  try {
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  } catch (err) {
    // 自動播放被擋：下次手勢（開始 / 繼續）再試
  }
}

function stopNoSleepVideo() {
  if (!state.noSleep) return;
  try {
    state.noSleep.video.pause();
  } catch (err) {
    // 忽略
  }
}

// 遊戲進行中 / 暫停：由整合層在 game:start、game:pause、game:quitToMenu 時呼叫；螢幕不變暗只在進行中啟用
// 請在使用者手勢（開始 / 繼續按鈕的 click）內呼叫 setGameActive(true)，影片後備才能播放
export function setGameActive(on) {
  const next = !!on;
  if (next === state.active) return;
  state.active = next;
  if (!isTouch()) return;
  if (next) requestWakeLock();
  else releaseWakeLock();
}

// ---------- 開始遊戲 ----------
function onStart() {
  if (state.playing) return;
  state.playing = true;
  document.body.classList.add('playing');
  if (!isTouch()) {
    state.active = true;
    return;
  }
  // 同一手勢內依序：全螢幕 → 螢幕不變暗（不鎖方向：橫直向都可玩）
  if (!isStandalone()) goFullscreen();
  setGameActive(true);
  updatePortraitTip();
}

// ---------- 退出全螢幕偵測 ----------
let fsBackTimer = 0;

function onFullscreenChange() {
  clearTimeout(fsBackTimer);
  const btn = document.getElementById('fs-back');
  if (!btn) return;
  if (fsElement()) {
    btn.classList.add('hidden');
    return;
  }
  fsBackTimer = setTimeout(() => {
    if (state.playing && !fsElement() && !state.swipeActive) btn.classList.remove('hidden');
  }, FS_BACK_DEBOUNCE_MS);
}

function onFsBack(e) {
  e.preventDefault();
  e.currentTarget.classList.add('hidden');
  goFullscreen();
}

// Input 建構時呼叫；冪等
export function initMobile() {
  if (state.inited || !hasWindow || typeof document === 'undefined') return;
  state.inited = true;
  const touch = isTouch();
  document.body.classList.toggle('touch', touch);

  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.addEventListener('click', onStart);
  if (!touch) return; // 桌機：F 鍵已被上 / 下車占用，不加全螢幕切換鍵

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  const fsBack = document.getElementById('fs-back');
  if (fsBack) fsBack.addEventListener('click', onFsBack);
  // 擋 iOS 雙指縮放與長按選單
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if (state.playing) e.preventDefault();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.active) requestWakeLock();
    else if (document.visibilityState === 'hidden') stopNoSleepVideo();
  });
  ensurePortraitButton();
  const onOrient = () => updatePortraitTip();
  window.addEventListener('resize', onOrient);
  window.addEventListener('orientationchange', onOrient);
}

// ---------- 效能分級 ----------
let qualitySetting = 'auto';

// 整合層以 settings.get('quality') 設定（並在 settings 變更時再呼叫）；非法值視為 'auto'
export function setQualitySetting(v) {
  qualitySetting = typeof v === 'string' ? v : 'auto';
}

// 相容舊呼叫：回傳 'low' | 'mid' | 'high' | 'ultra'（URL ?q= 優先 → 設定 → auto：觸控 low、桌機 high）
export function qualityTier(setting = qualitySetting) {
  return resolveQuality(setting, { touch: isTouch(), urlQ: urlParam('q') });
}

function tierOf(tier) {
  return QUALITY_TIERS[tier] || QUALITY_TIERS.high;
}

export function pixelRatioFor(tier, dpr, renderScale) {
  return Math.min(dpr || 1, tierOf(tier).dprCap) * renderScale;
}

// 依分級設定 pixelRatio 與陰影：shadowMap = 0 → 關閉陰影；否則把投影光源的陰影貼圖邊長設為該級數值
// scene 可省略（此時只處理開關）；tier 省略 = qualityTier()
export function applyRendererQuality(renderer, renderScale = 1, scene = null, tier = qualityTier()) {
  const t = tierOf(tier);
  renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio, renderScale));
  if (!t.shadowMap) {
    renderer.shadowMap.enabled = false;
    return tier;
  }
  if (!scene) return tier;
  scene.traverse((o) => {
    const sh = o.isLight && o.castShadow && o.shadow;
    if (!sh || sh.mapSize.x === t.shadowMap) return;
    sh.mapSize.set(t.shadowMap, t.shadowMap);
    if (sh.map) {
      sh.map.dispose();
      sh.map = null;
    }
  });
  return tier;
}

// 純邏輯的 fps 自適應控制器（可無頭測試）：回傳 { tick(dt) → 是否改變, scale, fpsAvg }
export function createScaleController() {
  const c = {
    scale: SCALE_MAX,
    fpsAvg: 60,
    acc: 0,
    lowSec: 0,
    highSec: 0,
    tick(dt) {
      if (!(dt > 0)) return false;
      c.fpsAvg += (1 / dt - c.fpsAvg) * FPS_LERP;
      c.acc += dt;
      if (c.acc < EVAL_INTERVAL) return false;
      c.acc -= EVAL_INTERVAL;
      c.lowSec = c.fpsAvg < FPS_LOW ? c.lowSec + 1 : 0;
      c.highSec = c.fpsAvg > FPS_HIGH ? c.highSec + 1 : 0;
      let next = c.scale;
      if (c.lowSec >= LOW_SECONDS) next = Math.max(SCALE_MIN, c.scale - SCALE_DOWN);
      else if (c.highSec >= HIGH_SECONDS) next = Math.min(SCALE_MAX, c.scale + SCALE_UP);
      else return false;
      c.lowSec = 0;
      c.highSec = 0;
      next = Math.round(next * 1000) / 1000;
      if (next === c.scale) return false;
      c.scale = next;
      return true;
    },
  };
  return c;
}

// 回傳 { tick, controller }：每幀呼叫 tick(dt)；renderScale 改變時重設 pixelRatio 與尺寸
export function createAdaptiveResolution(renderer, tier = qualityTier()) {
  const ctrl = createScaleController();
  const tick = (dt) => {
    if (!ctrl.tick(dt)) return;
    renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio, ctrl.scale));
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  return { tick, controller: ctrl };
}
