// HUD：左下小地圖、所在位置、時速、時間、右上操作提示（H 收合）、上車提示、地點提示
// 觸控裝置（body.touch）版面由 style.css 重新配置；本檔負責依 state.driving 切換觸控按鈕配置、把鍵盤提示改成觸控用語
// 小地圖預先把真實 OSM 道路 / 建築輪廓 / 公園水域畫到離屏畫布，每幀依玩家位置取樣
import { BOUNDS, surfaceRoads, surfaceFootways, buildings, namedBuildings, parks, water } from './citymodel.js';
import { makeCanvas, FONT_STACK } from './utils.js';
import { isTouch } from './mobile.js';
import { setTouchMode } from './touch.js';

const MAP_SCALE = 1; // 預先繪製的全圖：1px = 1m
const MAP_LABEL_AREA = 4000; // 輪廓面積（m²）超過此值的具名建築在小地圖上顯示名稱
const PLACE_TOAST = '📍 '; // main.js 進場地名 toast 的前綴：與地名 pill 同名時不重複顯示（見 toast()）

export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.locationEl = document.getElementById('location');
    this.speedEl = document.getElementById('speed');
    this.speedNum = document.getElementById('speed-num');
    this.clockEl = document.getElementById('clock');
    this.helpEl = document.getElementById('help');
    this.promptEl = document.getElementById('prompt');
    this.toastEl = document.getElementById('toast');
    this.minimap = document.getElementById('minimap');
    this.mctx = this.minimap.getContext('2d');
    this._lastLocation = '';
    this._lastPrompt = null;
    this._toastTimer = 0;
    this._pendingPlace = null; // 待判斷的進場地名 toast（等本幀 pill 更新後再決定）
    this.touch = isTouch();
    this.enterBtn = null; // 觸控「上車」鈕：附近有車時加上 .ready 提示
    this.mapCanvas = this._buildMap();
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

  toggleHelp() {
    this.helpEl.classList.toggle('collapsed');
  }

  setPrompt(text) {
    if (text === this._lastPrompt) return;
    this._lastPrompt = text;
    if (this.touch) {
      // main.js 的提示文案是「按 F 上車（…）」，觸控時改指向按鈕
      if (text) text = text.replace(/^按 F /, '點「上車」鈕 ');
      if (!this.enterBtn) this.enterBtn = document.getElementById('tb-enter');
      if (this.enterBtn) this.enterBtn.classList.toggle('ready', !!text);
    }
    if (text) {
      this.promptEl.textContent = text;
      this.promptEl.classList.remove('hidden');
    } else {
      this.promptEl.classList.add('hidden');
    }
  }

  // 進場地名 toast（PLACE_TOAST 開頭）與頂部地名 pill 重複：先暫存，update() 更新 pill 後，
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

  // state：{ x, z, yaw, driving, speedKmh, location, time, fast, markers }
  update(dt, state) {
    if (this.touch) setTouchMode(state.driving ? 'drive' : 'walk');
    if (state.location !== this._lastLocation) {
      this._lastLocation = state.location;
      this.locationEl.textContent = state.location;
    }
    if (this._pendingPlace) {
      const p = this._pendingPlace;
      this._pendingPlace = null;
      if (!this._pillShows(p.name)) this._showToast(p.text, p.seconds);
    }
    if (state.driving) {
      this.speedEl.classList.remove('hidden');
      this.speedNum.textContent = String(Math.round(state.speedKmh));
    } else {
      this.speedEl.classList.add('hidden');
    }
    this.clockEl.textContent = state.fast ? `${state.time} ⏩` : state.time;
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.add('hidden');
    }
    this._drawMinimap(state);
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
    // 可駕駛車輛位置
    if (state.markers) {
      ctx.fillStyle = '#4fc3ff';
      for (const m of state.markers) {
        ctx.beginPath();
        ctx.arc((m.x - BOUNDS.minX) * MAP_SCALE, (m.z - BOUNDS.minZ) * MAP_SCALE, 4 / k, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

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
}
