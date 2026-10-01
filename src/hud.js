// HUD：右上時間 · 金錢（+/− 跳動）、左下圓形小地圖 + 地名 + 綠色血條、右下駕駛時圓形時速錶 + 車名 + 藍底路牌路名、
// 中下互動提示膠囊、左上新手提示卡（可關、每張只出現一次）與 FPS 小字、底部常駐按鍵提示、訊息 toast
// 版面（桌機 / 觸控橫向 / 觸控直向）全部在 style.css「HUD」段；本檔只切 class 與填文字，不寫死任何鍵位文字
//
// 接線（整合層 main.js）：
//   const hud = new HUD();                         // 可傳 { storage }（預設安全包裝的 localStorage）
//   hud.update(dt, state)                           // 每幀；state：{ x, z, yaw, driving, speedKmh, location, time, fast, markers,
//                                                   //   money, hp, hpMax, vehicleLabel, roadName, route }（新欄位可省略）
//     markers：[{ x, z, kind? }]，kind 依 MARKER_COLORS 著色（無 kind = 可駕駛車輛，藍）；超出小地圖半徑的
//       mission-start / mission-dest / dest 貼在邊緣並畫朝外箭頭指出方向，其餘超出者不畫
//     route：[{ x, z }] 或 null（navigator.route()），在小地圖畫亮青色 3 px 路線，只畫落在小地圖範圍內的段
//   hud.setMoney(money, delta) / hud.setHealth(hp, hpMax) / hud.setPrompt(text | null)
//   hud.setInteractPrompt(text | null)              // 互動提示（任務 / 打卡 / 外送取餐 / 倒垃圾 / 小吃）：同 setPrompt，另控制觸控「互動」鈕 tb-interact 顯示（步行 / 駕駛皆可）
//   hud.setPrompts(vehicleText, interactText)       // 兩者同時存在：同一膠囊並列（車輛在前），「上車」鈕 ready / tb-interact 各自依自己的提示；
//                                                   //   setPrompt / setInteractPrompt 各自會清掉另一則（單一膠囊），只有一種提示時呼叫對應那個即可
//                                                   //   與 setPrompt 共用同一個膠囊：每幀依仲裁結果二擇一呼叫（後呼叫者生效）
//   hud.showHint(id, text)                          // 同 id 只出現一次（localStorage 'tcgta.hints.seen'）；回傳是否排入
//   hud.setHintsEnabled(settings.get('showHints')) / hud.resetHints()
//   hud.setControlsHint([{ keys, desc }])           // 由 KEYMAP_HELP / TOUCH_HELP 產生後傳入
//   hud.setFps(fps | null)                          // null = 隱藏
//   hud.setUiScale(k)                               // 寫 CSS 變數 --ui-scale / --tg-ui-scale；HUD 用 --hud-scale（觸控或小螢幕 ≤ 1）
// 觸控裝置（body.touch）：本檔依 state.driving 切換觸控按鈕配置；提示文字「按 F …」改指向「上車 / 下車」鈕；
//   觸控駕駛中版面沒有提示卡的位置，新手提示延到下車後才顯示
// Phase 5：
//   state.weatherIcon（weather.getState().icon：'sun'|'rain'|'fog'）→ 右上狀態列最前面的天氣圖示（桌機 / 觸控同一處，位於觸控右上小鈕下方，不擋按鈕）
//   state.radio（radio.getState()：{ on, playing, index, name }）→ 駕駛面板車名上方的台名：駕駛中且 playing 時常駐；
//     駕駛中換台（index / on 改變）時以強調樣式顯示 RADIO_FLASH_SEC 秒（含「關閉」）；步行不顯示
//   觸控換台鈕 tb-radio（top2，駕駛專屬；沿用 touch.js 按鈕樣式 / pointer 處理，送虛擬鍵 KeyQ = core/actions radioNext）
//   markers kind 'event-start' / 'event-dest'（時段事件取餐點 / 送達點）與 'event-truck'（垃圾車，會移動）著色且超出半徑時貼邊
//   setMoney(money, delta, reason)：reason 'event'（外送入帳）時跳動文字前加「外送」、'garbage'（垃圾車入帳）加「清運」
// Phase 6（I6a）：hud.showCamView(index) → 畫面上方短暫顯示「鏡頭：近 / 中 / 遠」1.2 s（src/ui/cam-view-hint.js，倒數吃 update 的渲染 dt）
// 小地圖預先把真實 OSM 道路 / 建築輪廓 / 公園水域畫到離屏畫布，每幀依玩家位置取樣
import { BOUNDS, surfaceRoads, surfaceFootways, buildings, namedBuildings, parks, water } from './citymodel.js';
import { makeCanvas, FONT_STACK } from './utils.js';
import { isTouch } from './mobile.js';
import { setTouchMode, setTouchButtonVisible, registerTouchButton } from './touch.js';
import { MARKER_COLORS as BASE_MARKER_COLORS, CAR_MARKER_COLOR } from './map/marker-colors.js';
import { createCamViewHint } from './ui/cam-view-hint.js';

const MAP_SCALE = 1; // 預先繪製的全圖：1px = 1m
const MAP_LABEL_AREA = 4000; // 輪廓面積（m²）超過此值的具名建築在小地圖上顯示名稱
const PLACE_TOAST = '📍 '; // main.js 進場地名 toast 的前綴：與地名 pill 同名時不重複顯示（見 toast()）
export const HINTS_KEY = 'tcgta.hints.seen'; // localStorage：已看過的新手提示 id（JSON 陣列）
const HINT_SEC = 12; // 提示卡自動收起秒數
const HINT_GAP_SEC = 0.6; // 連續提示之間的間隔
const MONEY_DELTA_SEC = 1.8; // 金錢 +/− 顯示秒數
const SPEEDO_MAX = 160; // 時速錶滿格（km/h）
const SPEEDO_HOT = 0.8; // 超過滿格此比例改警示色
const HP_LOW = 0.3; // 血量低於此比例改警示色
const SMALL_SCREEN = 700; // 視窗短邊小於此值（px；手機、小視窗）時介面縮放上限 1，放大後的角落群組才不會互相擠到
const TOUCH_BTN_LABEL = { walk: '上車', drive: '下車' }; // 對應 touch.js 的 tb-enter / tb-exit 文字
const TOUCH_INTERACT_LABEL = '互動'; // 對應 touch.js 的 tb-interact 文字
const INTERACT_BTN_ID = 'tb-interact';
export const RADIO_BTN_ID = 'tb-radio';
const RADIO_FLASH_SEC = 2.5; // 換台時台名強調顯示秒數
// 天氣圖示（weather.getState().icon）→ 顯示字元與無障礙名稱
export const WEATHER_ICONS = { sun: ['☀️', '晴'], rain: ['🌧️', '雨'], fog: ['🌫️', '霧'] };
const MONEY_REASON_LABEL = { event: '外送 ', garbage: '清運 ', job: '打工 ' }; // economy 入帳原因 → 跳動文字前綴
const PROMPT_SEP = '　'; // setPrompts 並列兩則提示的分隔（全形空白）
// 小地圖標記顏色（契約 §17 kind）：色碼來自 map/marker-colors.js（與大地圖同源）；無 kind = 可駕駛車輛
export const MARKER_COLORS = { car: CAR_MARKER_COLOR, ...BASE_MARKER_COLORS };
// 超出小地圖半徑時貼邊顯示方向的 kind
const EDGE_KINDS = new Set(['mission-start', 'mission-dest', 'dest', 'event-start', 'event-dest', 'event-truck', 'job-car']);
export const ROUTE_COLOR = '#3ff6ff'; // 導航路線：亮青色
export const ROUTE_WIDTH = 3; // 螢幕 px
const MARKER_PX = 4; // 標記半徑（螢幕 px）
const EDGE_PAD = 9; // 貼邊標記距外框的內縮（px）

// localStorage 安全包裝：無痕 / 停用儲存 / node 無 window 時回 null
function defaultStorage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch (err) {
    return null;
  }
}

// 整數加千分位（不依賴 toLocaleString 的地區設定）
export function formatMoney(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '−' : ''}NT$ ${s}`;
}

// 觸控版提示文字：「按 F 上車（…）」→「點「上車」鈕 上車（…）」（駕駛中指向「下車」鈕）；「按 E …」→「點「互動」鈕 …」（步行 / 駕駛皆同）
export function touchPromptText(text, driving) {
  const t = text.replace(/按\s*F\s*/g, `點「${TOUCH_BTN_LABEL[driving ? 'drive' : 'walk']}」鈕 `);
  return t.replace(/按\s*E\s*/g, `點「${TOUCH_INTERACT_LABEL}」鈕 `); // tb-interact 步行 / 駕駛都顯示
}

// 點 (px, pz) 到線段 a–b 的距離平方（小地圖路線裁切用，不配置物件）
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}

export class HUD {
  constructor({ storage = defaultStorage() } = {}) {
    const $ = (id) => document.getElementById(id);
    this.root = $('hud');
    this.locationEl = $('location');
    this.driveEl = $('drive-panel');
    this.speedNum = $('speed-num');
    this.speedArc = $('speedo-arc');
    this.vehicleLabelEl = $('vehicle-label');
    this.roadSignEl = $('road-sign');
    this.roadNameEl = $('road-name');
    this.clockEl = $('clock');
    this.moneyEl = $('money');
    this.moneyDeltaEl = $('money-delta');
    this.healthEl = $('health');
    this.healthFill = $('health-fill');
    this.promptEl = $('prompt');
    this.promptText = $('prompt-text');
    this.toastEl = $('toast');
    this.fpsEl = $('fps');
    this.hintCard = $('hint-card');
    this.hintText = $('hint-text');
    this.ctrlHintEl = $('ctrl-hint'); // 桌機底部按鍵提示（觸控版由 style.css 隱藏）
    this.touchHintEl = $('touch-hint'); // 觸控底部提示（桌機隱藏）
    this.minimap = $('minimap');
    this.mctx = this.minimap.getContext('2d');
    this.touch = isTouch();
    this.enterBtn = null; // 觸控「上車」鈕：附近有車時加上 .ready 提示
    this.storage = storage;
    this._lastDriving = null;
    this._lastLocation = '';
    this._lastPrompt = null;
    this._rawPrompt = null; // 車輛提示原文（setPrompt / setPrompts）
    this._rawInteract = null; // 互動提示原文（setInteractPrompt / setPrompts）
    this._interactShown = null; // tb-interact 目前顯示狀態（null = 尚未同步）
    this._toastTimer = 0;
    this._pendingPlace = null; // 待判斷的進場地名 toast（等本幀 pill 更新後再決定）
    this._clock = '';
    this._money = null;
    this._moneyDeltaTimer = 0;
    this._hp = null;
    this._hpMax = null;
    this._speed = null;
    this._vehicleLabel = null;
    this._roadName = null;
    this._fps = null;
    this._uiScale = 1;
    // 新手提示
    this._hintsEnabled = true;
    this._hintsSeen = this._loadSeen();
    this._hintQueue = []; // [{ id, text }]
    this._hintCurrent = null;
    this._hintTimer = 0;
    this._hintGap = 0;
    const close = $('hint-close');
    if (close) {
      close.addEventListener('click', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this._closeHint();
      });
    }
    this._buildPhase5();
    this._camViewHint = createCamViewHint({ parent: this.root });
    this.mapCanvas = this._buildMap();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', () => this._applyScale());
    }
  }

  // 天氣圖示（狀態列最前面）、台名列（駕駛面板內車名上方）、觸控換台鈕；index.html / style.css 不動，樣式以 inline 補
  _buildPhase5() {
    this._weatherIcon = null;
    this._radioText = null;
    this._radioKey = null;
    this._radioFlash = 0;
    this._radioShown = null;
    const status = this.clockEl && this.clockEl.parentNode ? this.clockEl.parentNode : document.getElementById('status');
    const w = document.createElement('span');
    w.id = 'weather-icon';
    w.classList.add('hidden');
    w.setAttribute('role', 'img');
    const sep = document.createElement('span');
    sep.className = 'status-sep';
    sep.textContent = '·';
    if (status) {
      if (status.style) status.style.maxWidth = '260px'; // 多一個圖示，放寬原本 220px 上限
      if (typeof status.insertBefore === 'function' && status.firstChild) {
        status.insertBefore(sep, status.firstChild);
        status.insertBefore(w, sep);
      } else {
        status.appendChild(w);
        status.appendChild(sep);
      }
    }
    this.weatherEl = w;
    this.weatherSepEl = sep;
    const r = document.createElement('div');
    r.id = 'radio-label';
    r.classList.add('hidden');
    r.setAttribute('aria-live', 'polite');
    if (r.style) {
      r.style.fontSize = '13px';
      r.style.textAlign = 'right';
      r.style.whiteSpace = 'nowrap';
      r.style.opacity = '0.9';
      r.style.textShadow = '0 1px 2px rgba(0,0,0,0.8)';
    }
    if (this.driveEl) {
      if (typeof this.driveEl.insertBefore === 'function' && this.vehicleLabelEl && this.vehicleLabelEl.parentNode === this.driveEl) this.driveEl.insertBefore(r, this.vehicleLabelEl);
      else this.driveEl.appendChild(r);
    }
    this.radioEl = r;
    registerTouchButton({ id: RADIO_BTN_ID, label: '電台', code: 'KeyQ', mode: 'tap', slot: 'top2', showWhen: 'drive' });
  }

  // icon：'sun'|'rain'|'fog'；其他 / 省略 = 隱藏
  _updateWeather(icon) {
    const key = WEATHER_ICONS[icon] ? icon : null;
    if (key === this._weatherIcon) return;
    this._weatherIcon = key;
    this.weatherEl.classList.toggle('hidden', !key);
    this.weatherSepEl.classList.toggle('hidden', !key);
    if (!key) return;
    this.weatherEl.textContent = WEATHER_ICONS[key][0];
    this.weatherEl.setAttribute('aria-label', `天氣：${WEATHER_ICONS[key][1]}`);
    this.weatherEl.setAttribute('title', WEATHER_ICONS[key][1]);
  }

  // radio：{ on, playing, index, name } 或 null；駕駛中 playing 時常駐，換台時強調顯示 RADIO_FLASH_SEC 秒
  _updateRadio(dt, radio, driving) {
    const key = radio ? (radio.on ? radio.index : -1) : null;
    if (key !== this._radioKey) {
      if (driving && this._radioKey !== null && key !== null) this._radioFlash = RADIO_FLASH_SEC;
      this._radioKey = key;
    }
    if (!driving) this._radioFlash = 0;
    else if (this._radioFlash > 0) this._radioFlash -= dt;
    const flash = this._radioFlash > 0;
    const show = driving && !!radio && (flash || !!radio.playing);
    const text = show ? `📻 ${radio.name}` : null;
    const shown = show ? (flash ? 2 : 1) : 0;
    if (text === this._radioText && shown === this._radioShown) return;
    this._radioText = text;
    this._radioShown = shown;
    this.radioEl.classList.toggle('hidden', !show);
    if (!show) return;
    this.radioEl.textContent = text;
    if (this.radioEl.style) {
      this.radioEl.style.fontWeight = flash ? 'bold' : 'normal';
      this.radioEl.style.color = flash ? '#ffe28a' : '';
    }
  }

  _buildMap() {
    const W = Math.ceil((BOUNDS.maxX - BOUNDS.minX) * MAP_SCALE);
    const H = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) * MAP_SCALE);
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const X = (x) => (x - BOUNDS.minX) * MAP_SCALE;
    const Z = (z) => (z - BOUNDS.minZ) * MAP_SCALE;
    const polyPath = (p) => {
      ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) {
        if (i === 0) ctx.moveTo(X(p[i]), Z(p[i + 1]));
        else ctx.lineTo(X(p[i]), Z(p[i + 1]));
      }
      ctx.closePath();
    };
    const linePath = (pts) => {
      ctx.beginPath();
      pts.forEach((q, i) => (i === 0 ? ctx.moveTo(X(q.x), Z(q.z)) : ctx.lineTo(X(q.x), Z(q.z))));
    };
    // 底色：人行鋪面
    ctx.fillStyle = '#6c6860';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#4a7a45';
    for (const p of parks) {
      polyPath(p.poly);
      ctx.fill();
    }
    ctx.fillStyle = '#3f7fa8';
    for (const w of water) {
      polyPath(w.poly);
      ctx.fill();
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#a9a292';
    for (const r of surfaceFootways) {
      ctx.lineWidth = Math.max(1.5, r.width * MAP_SCALE);
      linePath(r.pts);
      ctx.stroke();
    }
    ctx.strokeStyle = '#e6e1d3';
    for (const r of surfaceRoads.slice().sort((a, b) => a.width - b.width)) {
      ctx.lineWidth = r.width * MAP_SCALE;
      linePath(r.pts);
      ctx.stroke();
    }
    // 建築輪廓
    ctx.fillStyle = '#4c5560';
    ctx.strokeStyle = '#2f353c';
    ctx.lineWidth = 1;
    for (const b of buildings) {
      polyPath(b.poly);
      ctx.fill();
      ctx.stroke();
    }
    // 具名建築標點
    for (const b of namedBuildings) {
      ctx.beginPath();
      ctx.arc(X(b.center.x), Z(b.center.z), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd23f';
      ctx.fill();
    }
    // 大型具名建築的名稱
    ctx.font = `bold 20px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of namedBuildings) {
      if (b.area < MAP_LABEL_AREA) continue;
      const cx = X(b.center.x);
      const cz = Z(b.center.z) - 14;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(b.name, cx, cz);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(b.name, cx, cz);
    }
    return c;
  }

  setVisible(v) {
    this.root.classList.toggle('hidden', !v);
  }

  // ---------- 互動提示膠囊 ----------
  // 上車 / 搶車等提示（觸控時「上車」鈕加 .ready）；同時清掉互動提示（單一膠囊）
  setPrompt(text) {
    this._setPrompt(text, null);
  }

  // 互動提示（接委託 / 打卡 / 收集小吃）：觸控時顯示「互動」鈕，提示消失即隱藏；同時清掉車輛提示（單一膠囊）
  setInteractPrompt(text) {
    this._setPrompt(null, text);
  }

  // 車輛提示與互動提示同時存在：同一膠囊並列（車輛在前），「上車」鈕 ready 與 tb-interact 各依自己的提示，互不覆蓋
  setPrompts(vehicleText, interactText) {
    this._setPrompt(vehicleText, interactText);
  }

  _setPrompt(vehicleText, interactText) {
    const veh = vehicleText || null;
    const inter = interactText || null;
    // 每幀重複呼叫同樣內容：不重算文字（不配置新字串）
    if (veh === this._rawPrompt && inter === this._rawInteract && this._lastPrompt !== undefined) return;
    this._rawPrompt = veh;
    this._rawInteract = inter;
    let shown = veh && inter ? `${veh}${PROMPT_SEP}${inter}` : veh || inter;
    if (this.touch && shown) shown = touchPromptText(shown, !!this._lastDriving);
    if (this.touch) {
      if (!this.enterBtn) this.enterBtn = document.getElementById('tb-enter');
      if (this.enterBtn) this.enterBtn.classList.toggle('ready', !!veh && !this._lastDriving);
    }
    this._syncInteractBtn();
    if (shown === this._lastPrompt) return;
    this._lastPrompt = shown;
    if (shown) {
      this.promptText.textContent = shown;
      this.promptEl.classList.remove('hidden');
    } else {
      this.promptEl.classList.add('hidden');
    }
  }

  // tb-interact：觸控、目前有互動提示時才顯示（步行 / 駕駛皆同；駕駛中可取外送餐 / 倒垃圾等，與桌機按 E 同路徑）
  _syncInteractBtn() {
    const on = this.touch && !!this._rawInteract;
    if (on === this._interactShown) return;
    this._interactShown = on;
    setTouchButtonVisible(INTERACT_BTN_ID, on);
  }

  // ---------- 訊息 toast ----------
  // 進場地名 toast（PLACE_TOAST 開頭）與地名 pill 重複：先暫存，update() 更新 pill 後，
  // 只有「pill 看不到（隱藏 / 不在版面上）或被截斷、或 pill 顯示的不是這個地名」時才顯示，其餘 toast 照常立即顯示
  toast(text, seconds = 6) {
    if (text.startsWith(PLACE_TOAST)) {
      this._pendingPlace = { name: text.slice(PLACE_TOAST.length), text, seconds };
      return;
    }
    this._showToast(text, seconds);
  }

  _showToast(text, seconds) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    this._toastTimer = seconds;
  }

  // ---------- 金錢 / 血量 ----------
  // delta 省略時以上次金額推算；delta 為 0 不跳動；reason（economy 的入帳原因）'event' 加「外送」、'garbage' 加「清運」
  setMoney(money, delta, reason) {
    const m = Math.round(Number(money));
    if (!Number.isFinite(m)) return;
    const d = delta === undefined || delta === null ? (this._money === null ? 0 : m - this._money) : Math.round(Number(delta) || 0);
    if (m !== this._money) {
      this._money = m;
      this.moneyEl.textContent = formatMoney(m);
    }
    if (!d) return;
    const el = this.moneyDeltaEl;
    el.textContent = `${(d > 0 && MONEY_REASON_LABEL[reason]) || ''}${d > 0 ? '+' : '−'}${formatMoney(Math.abs(d))}`;
    el.classList.toggle('gain', d > 0);
    el.classList.toggle('loss', d < 0);
    el.classList.remove('hidden');
    // 重播跳動動畫：移除 class 後讀一次版面再加回
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    this._moneyDeltaTimer = MONEY_DELTA_SEC;
  }

  setHealth(hp, hpMax) {
    const max = Number(hpMax) > 0 ? Number(hpMax) : this._hpMax || 100;
    const v = Math.max(0, Math.min(max, Number(hp) || 0));
    if (v === this._hp && max === this._hpMax) return;
    this._hp = v;
    this._hpMax = max;
    const k = v / max;
    this.healthFill.style.width = `${(k * 100).toFixed(1)}%`;
    this.healthEl.classList.toggle('low', k < HP_LOW);
  }

  // ---------- 新手提示卡 ----------
  _loadSeen() {
    try {
      const raw = this.storage && this.storage.getItem(HINTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
    } catch (err) {
      return new Set();
    }
  }

  _saveSeen() {
    try {
      if (this.storage) this.storage.setItem(HINTS_KEY, JSON.stringify([...this._hintsSeen]));
    } catch (err) {
      // 儲存不可用：只記在記憶體
    }
  }

  // 同 id 只出現一次（跨次遊玩記在 localStorage）；已看過 / 已排隊 / 提示關閉時回傳 false
  showHint(id, text) {
    if (!this._hintsEnabled || !id || !text) return false;
    const key = String(id);
    if (this._hintsSeen.has(key)) return false;
    if ((this._hintCurrent && this._hintCurrent.id === key) || this._hintQueue.some((h) => h.id === key)) return false;
    this._hintQueue.push({ id: key, text: String(text) });
    this._pumpHints();
    return true;
  }

  setHintsEnabled(on) {
    this._hintsEnabled = !!on;
    if (!this._hintsEnabled) {
      // 尚未顯示的提示直接丟棄（之後重新開啟時可再依情境出現）
      this._hintQueue.length = 0;
      if (this._hintCurrent) this._closeHint();
    }
  }

  resetHints() {
    this._hintsSeen.clear();
    this._hintQueue.length = 0;
    if (this._hintCurrent) this._closeHint();
    try {
      if (this.storage) this.storage.removeItem(HINTS_KEY);
    } catch (err) {
      // 忽略
    }
  }

  // 觸控駕駛中沒有提示卡的位置（左半欄給時速錶），延到下車後
  _hintBlocked() {
    return this.touch && !!this._lastDriving;
  }

  _pumpHints() {
    if (this._hintCurrent || this._hintGap > 0 || !this._hintQueue.length || this._hintBlocked()) return;
    const h = this._hintQueue.shift();
    this._hintCurrent = h;
    this._hintTimer = HINT_SEC;
    this._hintsSeen.add(h.id);
    this._saveSeen();
    this.hintText.textContent = h.text;
    this.hintCard.classList.remove('hidden');
  }

  _closeHint() {
    this._hintCurrent = null;
    this._hintTimer = 0;
    this._hintGap = HINT_GAP_SEC;
    this.hintCard.classList.add('hidden');
  }

  // ---------- 底部按鍵提示 / FPS / 介面縮放 ----------
  // items：[{ keys, desc }]（由 core/actions 的 KEYMAP_HELP / TOUCH_HELP 產生）；桌機與觸控容器寫同樣內容，由 CSS 決定顯示哪個
  setControlsHint(items) {
    const list = Array.isArray(items) ? items.filter((it) => it && (it.keys || it.desc)) : [];
    for (const el of [this.ctrlHintEl, this.touchHintEl]) {
      if (!el) continue;
      el.textContent = '';
      list.forEach((it, i) => {
        if (i > 0) el.appendChild(document.createTextNode(' · '));
        if (it.keys) {
          const b = document.createElement('b');
          b.textContent = String(it.keys);
          el.appendChild(b);
        }
        if (it.desc) el.appendChild(document.createTextNode(`${it.keys ? ' ' : ''}${it.desc}`));
      });
      el.classList.toggle('hidden', !list.length);
    }
  }

  setFps(fps) {
    if (fps === null || fps === undefined || !Number.isFinite(Number(fps))) {
      this._fps = null;
      this.fpsEl.classList.add('hidden');
      return;
    }
    const v = Math.round(Number(fps));
    this.fpsEl.classList.remove('hidden');
    if (v === this._fps) return;
    this._fps = v;
    this.fpsEl.textContent = `${v} FPS`;
  }

  // k：settings.uiScale（0.8–1.3）；--ui-scale / --tg-ui-scale 原值寫入（選單用），HUD 自己的 --hud-scale 在觸控或小螢幕上限 1（避免蓋到觸控鈕）
  setUiScale(k) {
    const v = Number(k);
    if (!Number.isFinite(v) || v <= 0) return;
    this._uiScale = v;
    this._applyScale();
  }

  _applyScale() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const st = document.documentElement.style;
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;
    const small = this.touch || (w > 0 && h > 0 && Math.min(w, h) < SMALL_SCREEN);
    const hud = small ? Math.min(1, this._uiScale) : this._uiScale;
    st.setProperty('--ui-scale', String(this._uiScale));
    st.setProperty('--tg-ui-scale', String(this._uiScale));
    st.setProperty('--hud-scale', String(hud));
  }

  // 鏡頭段位提示（index 0–2 = 近 / 中 / 遠）；回傳是否顯示
  showCamView(index) {
    return this._camViewHint.show(index);
  }

  // ---------- 每幀 ----------
  // state：{ x, z, yaw, driving, speedKmh, location, time, fast, markers, money, hp, hpMax, vehicleLabel, roadName, weatherIcon, radio }
  update(dt, state) {
    const driving = !!state.driving;
    if (this.touch) setTouchMode(driving ? 'drive' : 'walk');
    if (driving !== this._lastDriving) {
      this._lastDriving = driving;
      this.driveEl.classList.toggle('hidden', !driving);
      // 觸控提示文字依模式指向「上車 / 下車」鈕：以原文重算
      if (this.touch) {
        this._lastPrompt = undefined;
        this._setPrompt(this._rawPrompt, this._rawInteract);
      }
    }
    if (state.location !== undefined && state.location !== this._lastLocation) {
      this._lastLocation = state.location;
      this.locationEl.textContent = state.location;
    }
    if (this._pendingPlace) {
      const p = this._pendingPlace;
      this._pendingPlace = null;
      if (!this._pillShows(p.name)) this._showToast(p.text, p.seconds);
    }
    if (driving) this._updateDrive(state);
    this._updateWeather(state.weatherIcon);
    this._updateRadio(dt, state.radio || null, driving);
    if (state.time !== undefined) {
      const clock = state.fast ? `${state.time} ⏩` : String(state.time);
      if (clock !== this._clock) {
        this._clock = clock;
        this.clockEl.textContent = clock;
      }
    }
    if (Number.isFinite(state.money) && Math.round(state.money) !== this._money) this.setMoney(state.money);
    if (Number.isFinite(state.hp)) this.setHealth(state.hp, state.hpMax);
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.add('hidden');
    }
    if (this._moneyDeltaTimer > 0) {
      this._moneyDeltaTimer -= dt;
      if (this._moneyDeltaTimer <= 0) this.moneyDeltaEl.classList.add('hidden');
    }
    this._camViewHint.update(dt);
    this._updateHints(dt);
    if (Number.isFinite(state.x) && Number.isFinite(state.z)) this._drawMinimap(state);
  }

  _updateDrive(state) {
    const kmh = Math.max(0, Math.round(Math.abs(Number(state.speedKmh) || 0)));
    if (kmh !== this._speed) {
      this._speed = kmh;
      this.speedNum.textContent = String(kmh);
      const k = Math.min(1, kmh / SPEEDO_MAX);
      this.speedArc.setAttribute('stroke-dasharray', `${(k * 100).toFixed(1)} 100`);
      this.driveEl.classList.toggle('hot', k >= SPEEDO_HOT);
    }
    const label = state.vehicleLabel ? String(state.vehicleLabel) : '';
    if (label !== this._vehicleLabel) {
      this._vehicleLabel = label;
      this.vehicleLabelEl.textContent = label;
    }
    const road = state.roadName ? String(state.roadName) : '';
    if (road !== this._roadName) {
      this._roadName = road;
      this.roadNameEl.textContent = road;
      this.roadSignEl.classList.toggle('hidden', !road);
    }
  }

  _updateHints(dt) {
    if (this._hintCurrent) {
      // 觸控上車時收起目前提示（位置讓給時速錶），放回佇列最前面、下車後重新顯示
      if (this._hintBlocked()) {
        const h = this._hintCurrent;
        this._hintsSeen.delete(h.id);
        this._saveSeen();
        this._closeHint();
        this._hintQueue.unshift(h);
      } else {
        this._hintTimer -= dt;
        if (this._hintTimer <= 0) this._closeHint();
      }
    } else if (this._hintGap > 0) {
      this._hintGap -= dt;
    }
    this._pumpHints();
  }

  // 地名 pill 是否完整顯示 name：文字相同、HUD 與 pill 在版面上可見、未被 ellipsis 截斷
  _pillShows(name) {
    const el = this.locationEl;
    if (el.textContent !== name || this.root.classList.contains('hidden') || !el.getClientRects().length) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    return el.scrollWidth <= el.clientWidth;
  }

  _drawMinimap(state) {
    const ctx = this.mctx;
    const S = this.minimap.width;
    const R = S / 2;
    const k = state.driving ? 0.45 : 0.7; // 每公尺幾像素
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1e2a22';
    ctx.fillRect(0, 0, S, S);
    ctx.translate(R, R);
    ctx.scale(k / MAP_SCALE, k / MAP_SCALE);
    ctx.translate(-(state.x - BOUNDS.minX) * MAP_SCALE, -(state.z - BOUNDS.minZ) * MAP_SCALE);
    ctx.drawImage(this.mapCanvas, 0, 0);
    // 導航路線（世界座標系內畫，跟著小地圖縮放；線寬換算回螢幕 3 px）
    if (state.route && state.route.length > 1) this._drawRoute(ctx, state.route, state.x, state.z, R / k, k);
    ctx.restore();

    // 標記（螢幕座標系：北朝上、+x 往右、+z 往下，與底圖一致）
    if (state.markers && state.markers.length) this._drawMarkers(ctx, state.markers, state.x, state.z, R, k);

    // 玩家箭頭（北方朝上，箭頭依角色朝向旋轉）
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(Math.PI - state.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 外框與北方標記
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.font = `bold 14px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff5a5a';
    ctx.fillText('N', R, 12);
  }

  // 路線：只畫與小地圖圓（半徑 viewR 公尺，外擴線寬）相交的段；連續可見段接成一條 path
  _drawRoute(ctx, route, px, pz, viewR, k) {
    const lim = viewR + ROUTE_WIDTH / k;
    const lim2 = lim * lim;
    const ox = BOUNDS.minX;
    const oz = BOUNDS.minZ;
    let open = false;
    let drawn = 0;
    ctx.beginPath();
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(b.x) || !Number.isFinite(b.z)) {
        open = false;
        continue;
      }
      if (segDist2(px, pz, a.x, a.z, b.x, b.z) > lim2) {
        open = false;
        continue;
      }
      if (!open) ctx.moveTo((a.x - ox) * MAP_SCALE, (a.z - oz) * MAP_SCALE);
      ctx.lineTo((b.x - ox) * MAP_SCALE, (b.z - oz) * MAP_SCALE);
      open = true;
      drawn++;
    }
    if (!drawn) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (ROUTE_WIDTH * MAP_SCALE) / k; // 底圖座標系已縮放 k / MAP_SCALE
    ctx.strokeStyle = ROUTE_COLOR;
    ctx.stroke();
  }

  // 標記依 kind 著色；超出半徑的任務 / 目的地標記貼邊並畫朝外三角形指出方向
  _drawMarkers(ctx, markers, px, pz, R, k) {
    const inner = R - EDGE_PAD;
    for (const m of markers) {
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
      const color = (m.kind && MARKER_COLORS[m.kind]) || MARKER_COLORS.car;
      let dx = (m.x - px) * k;
      let dz = (m.z - pz) * k;
      const d = Math.sqrt(dx * dx + dz * dz);
      const edge = d > inner;
      if (edge) {
        if (!m.kind || !EDGE_KINDS.has(m.kind)) continue;
        const ux = dx / d;
        const uz = dz / d;
        dx = ux * inner;
        dz = uz * inner;
        // 朝外三角形：尖端在外側
        const cx = R + dx;
        const cz = R + dz;
        ctx.beginPath();
        ctx.moveTo(cx + ux * 7, cz + uz * 7);
        ctx.lineTo(cx - ux * 4 - uz * 6, cz - uz * 4 + ux * 6);
        ctx.lineTo(cx - ux * 4 + uz * 6, cz - uz * 4 - ux * 6);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        continue;
      }
      ctx.beginPath();
      ctx.arc(R + dx, R + dz, EDGE_KINDS.has(m.kind) ? MARKER_PX + 1.5 : MARKER_PX, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (EDGE_KINDS.has(m.kind)) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}
