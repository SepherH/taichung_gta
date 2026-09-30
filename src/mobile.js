// 手機支援：觸控偵測、開始手勢內全螢幕 / 鎖橫向 / wake lock、上滑全螢幕退路、退出全螢幕偵測、
// 直向遮罩期間輸入封鎖判斷、效能分級與自適應解析度
// 移植自 aether-online（docs/ref/mobile-reference.md §1、§2、§5、§6）；本檔不 import three，可在 node 無頭測試
//
// 自註冊：Input 建構時呼叫 initMobile()（冪等），在 #start-btn 上另掛 click，與 loading.js 的開始 handler 同屬一次手勢
// main.js 接線（尚未接，由整合單元處理）：applyRendererQuality(renderer) / createAdaptiveResolution(renderer).tick(dt)

// ---------- 參數 ----------
const WEBKIT_CHECK_MS = 500; // 舊 webkit 全螢幕無 promise，延遲檢查是否成功
const FS_BACK_DEBOUNCE_MS = 300; // 被退出全螢幕後顯示「回到全螢幕」的防抖
// 上滑全螢幕（iOS Safari 退路）
const SWIPE_GROW = 60; // innerHeight 增加超過此值視為網址列已收起
const SWIPE_FULL_K = 0.95; // 或高度達螢幕對應邊的此比例
const SWIPE_DROP = 40; // 從最大值縮回超過此值視為工具列回來
const SWIPE_DEBOUNCE_MS = 300; // 防抖（避免鍵盤彈出誤判）
// 效能分級
const DPR_CAP_LOW = 1.5;
const DPR_CAP_HIGH = 2;
const LOW_SHADOW_MAP = 1024; // 低品質時光源陰影貼圖邊長上限
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
  playing: false,
  swipeActive: false, // 上滑遮罩顯示中
  wakeLock: null,
};

// 觸控輸入是否應封鎖（直向遮罩或上滑遮罩顯示中）；touch.js 每幀查詢
export function isInputBlocked() {
  if (!state.playing || !isTouch()) return false;
  return isPortrait() || state.swipeActive;
}

// ---------- 全螢幕 ----------
function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function lockLandscape() {
  try {
    const o = window.screen && window.screen.orientation;
    if (o && o.lock) {
      const p = o.lock('landscape');
      if (p && p.catch) p.catch(() => {});
    }
  } catch (err) {
    // 不支援鎖方向：靠直向遮罩提示
  }
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
    if (p && p.then) p.then(lockLandscape, startSwipeFallback);
    else lockLandscape();
  } else if (de.webkitRequestFullscreen) {
    try {
      de.webkitRequestFullscreen();
    } catch (err) {
      // 由下方延遲檢查處理
    }
    setTimeout(() => {
      if (fsElement()) lockLandscape();
      else startSwipeFallback();
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

function screenSide() {
  const s = window.screen || {};
  // iOS 的 screen.width / height 固定為直向值，依目前方向取對應邊
  const long = Math.max(s.width || 0, s.height || 0);
  const short = Math.min(s.width || 0, s.height || 0);
  return isPortrait() ? long : short;
}

function setSwipeMask(on) {
  state.swipeActive = on;
  const mask = document.getElementById('swipe-up');
  if (mask) mask.classList.toggle('hidden', !on);
  document.body.classList.toggle('swipe-mask', on);
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
  if (isStandalone()) return;
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
function requestWakeLock() {
  const wl = window.navigator.wakeLock;
  if (!wl || !wl.request) return; // 無 wakeLock（iOS < 16.4）：本版不做 NoSleep 影片退路
  wl.request('screen').then(
    (lock) => {
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    },
    () => {},
  );
}

// ---------- 開始遊戲 ----------
function onStart() {
  if (state.playing) return;
  state.playing = true;
  document.body.classList.add('playing');
  if (!isTouch()) return;
  // 同一手勢內依序：全螢幕 → 鎖方向（全螢幕成功後）→ wake lock
  if (!isStandalone()) goFullscreen();
  requestWakeLock();
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
    if (document.visibilityState === 'visible' && state.playing && !state.wakeLock) requestWakeLock();
  });
}

// ---------- 效能分級 ----------
export function qualityTier() {
  const q = urlParam('q');
  if (q === 'high' || q === 'low') return q;
  return isTouch() ? 'low' : 'high';
}

export function pixelRatioFor(tier, dpr, renderScale) {
  return Math.min(dpr || 1, tier === 'low' ? DPR_CAP_LOW : DPR_CAP_HIGH) * renderScale;
}

// scene 可省略：有 scene 時低品質把光源陰影貼圖降到 LOW_SHADOW_MAP；沒有則直接關閉陰影
export function applyRendererQuality(renderer, renderScale = 1, scene = null) {
  const tier = qualityTier();
  renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio, renderScale));
  if (tier !== 'low') return tier;
  if (!scene) {
    renderer.shadowMap.enabled = false;
    return tier;
  }
  scene.traverse((o) => {
    const sh = o.isLight && o.castShadow && o.shadow;
    if (!sh || sh.mapSize.x <= LOW_SHADOW_MAP) return;
    sh.mapSize.set(LOW_SHADOW_MAP, LOW_SHADOW_MAP);
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
export function createAdaptiveResolution(renderer) {
  const ctrl = createScaleController();
  const tier = qualityTier();
  const tick = (dt) => {
    if (!ctrl.tick(dt)) return;
    renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio, ctrl.scale));
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  return { tick, controller: ctrl };
}
