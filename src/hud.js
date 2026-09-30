// HUD：左下小地圖、所在位置、時速、時間、右上操作提示（H 收合）、上車提示、地標小知識
import { BOUNDS, LANDMARKS, SIDEWALK } from './data/city.js';
import { ROADS } from './world.js';
import { makeCanvas, FONT_STACK } from './utils.js';

const MAP_SCALE = 1; // 預先繪製的全圖：1px = 1m

export class HUD {
  constructor({ footprints }) {
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
    this.mapCanvas = this._buildMap(footprints);
  }

  _buildMap(footprints) {
    const W = (BOUNDS.maxX - BOUNDS.minX) * MAP_SCALE;
    const H = (BOUNDS.maxZ - BOUNDS.minZ) * MAP_SCALE;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const X = (x) => (x - BOUNDS.minX) * MAP_SCALE;
    const Z = (z) => (z - BOUNDS.minZ) * MAP_SCALE;
    ctx.fillStyle = '#2f4a33';
    ctx.fillRect(0, 0, W, H);
    // 人行道 + 道路
    for (const r of ROADS) {
      const extra = SIDEWALK;
      ctx.fillStyle = '#8c887e';
      if (r.axis === 'x') ctx.fillRect(X(r.from), Z(r.c - r.hw - extra), (r.to - r.from) * MAP_SCALE, (r.width + extra * 2) * MAP_SCALE);
      else ctx.fillRect(X(r.c - r.hw - extra), Z(r.from), (r.width + extra * 2) * MAP_SCALE, (r.to - r.from) * MAP_SCALE);
    }
    for (const r of ROADS) {
      ctx.fillStyle = '#e6e1d3';
      if (r.axis === 'x') ctx.fillRect(X(r.from), Z(r.c - r.hw), (r.to - r.from) * MAP_SCALE, r.width * MAP_SCALE);
      else ctx.fillRect(X(r.c - r.hw), Z(r.from), r.width * MAP_SCALE, (r.to - r.from) * MAP_SCALE);
    }
    // 建築
    ctx.fillStyle = '#5b6570';
    for (const f of footprints) ctx.fillRect(X(f.x0), Z(f.z0), (f.x1 - f.x0) * MAP_SCALE, (f.z1 - f.z0) * MAP_SCALE);
    // 地標
    for (const lm of LANDMARKS) {
      const rects = lm.buildings || (lm.footprint ? [lm.footprint] : []);
      ctx.fillStyle = lm.mapColor;
      if (lm.id === 'qiuhong') {
        const z = lm.zone;
        ctx.fillRect(X(z.x0 + 17), Z(z.z0 + 30), (z.x1 - z.x0 - 37) * MAP_SCALE, (z.z1 - z.z0 - 47) * MAP_SCALE);
      }
      for (const r of rects) ctx.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * MAP_SCALE, (r.z1 - r.z0) * MAP_SCALE);
    }
    // 地標名稱
    ctx.font = `bold 22px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const lm of LANDMARKS) {
      const z = lm.zone;
      const cx = X((z.x0 + z.x1) / 2);
      const cz = Z((z.z0 + z.z1) / 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(lm.shortName, cx, cz);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(lm.shortName, cx, cz);
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
    if (text) {
      this.promptEl.textContent = text;
      this.promptEl.classList.remove('hidden');
    } else {
      this.promptEl.classList.add('hidden');
    }
  }

  toast(text, seconds = 6) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    this._toastTimer = seconds;
  }

  // state：{ x, z, yaw, driving, speedKmh, location, time, fast, markers }
  update(dt, state) {
    if (state.location !== this._lastLocation) {
      this._lastLocation = state.location;
      this.locationEl.textContent = state.location;
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
