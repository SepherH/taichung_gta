// 暫停選單「地圖」頁：2D canvas 大地圖（真實 OSM 道路依等級粗細、建築灰、公園綠、水域藍、主要道路標名稱）+ 玩家箭頭
// 拖曳平移（pointer events，觸控可用）、滾輪 / 雙指縮放、+ / − 鈕、「回到自己」；只在開啟時繪製（有變動才排下一幀）
// 座標：世界 X 向東、Z 向南（北方為 -Z），與 hud.js 小地圖相同 → 螢幕 x = 世界 x、螢幕 y = 世界 z，北朝上
// 世界↔螢幕轉換與縮放 / 平移為匯出的純函式（view = { cx, cz, scale, w, h }，scale = 每公尺幾 CSS px）
import { BOUNDS, surfaceRoads, surfaceFootways, buildings, parks, water } from '../citymodel.js';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif';
const MAX_SCALE = 6; // 最大放大：每公尺 6 px
const DEFAULT_SCALE = 0.7; // 開啟時的預設比例
const BTN_ZOOM = 1.5; // + / − 鈕一次縮放倍率
const KEY_PAN_PX = 80; // 方向鍵一次平移像素

// 道路樣式：依等級決定顏色、最細線寬與繪製順序（rank 大的後畫、蓋在上面）
const ROAD_STYLE = {
  primary: { color: '#f5c55a', min: 3.2, rank: 4 },
  secondary: { color: '#f1e0a6', min: 2.6, rank: 3 },
  tertiary: { color: '#e8e2d2', min: 2, rank: 2 },
};
const ROAD_OTHER = { color: '#cbc5b6', min: 1, rank: 1 };
// 道路名稱在此比例以上才顯示（primary / secondary 較早出現）
const LABEL_SCALE = { primary: 0.3, secondary: 0.45, tertiary: 0.9 };

// ---------- 純函式 ----------
export function worldToScreen(view, x, z, out = {}) {
  out.x = (x - view.cx) * view.scale + view.w / 2;
  out.y = (z - view.cz) * view.scale + view.h / 2;
  return out;
}

export function screenToWorld(view, sx, sy, out = {}) {
  out.x = (sx - view.w / 2) / view.scale + view.cx;
  out.z = (sy - view.h / 2) / view.scale + view.cz;
  return out;
}

// 可把整張地圖塞進 w×h 的比例
export function fitScale(w, h, bounds = BOUNDS) {
  const W = bounds.maxX - bounds.minX;
  const H = bounds.maxZ - bounds.minZ;
  return Math.min(w / W, h / H);
}

// 比例夾在 [整圖 0.8 倍, MAX_SCALE]、中心夾在地圖範圍內；回傳新 view
export function clampView(view, bounds = BOUNDS) {
  const minScale = Math.min(fitScale(view.w, view.h, bounds) * 0.8, MAX_SCALE);
  const scale = Math.min(MAX_SCALE, Math.max(minScale, view.scale));
  const cx = Math.min(bounds.maxX, Math.max(bounds.minX, view.cx));
  const cz = Math.min(bounds.maxZ, Math.max(bounds.minZ, view.cz));
  return { ...view, scale, cx, cz };
}

// 以螢幕點 (sx, sy) 為錨縮放 factor 倍（錨點下的世界座標不變）；不夾範圍
export function zoomAt(view, factor, sx, sy) {
  const p = screenToWorld(view, sx, sy);
  const scale = view.scale * factor;
  return {
    ...view,
    scale,
    cx: p.x - (sx - view.w / 2) / scale,
    cz: p.z - (sy - view.h / 2) / scale,
  };
}

// 拖曳 (dx, dy) 螢幕像素：地圖跟著手指走
export function panBy(view, dx, dy) {
  return { ...view, cx: view.cx - dx / view.scale, cz: view.cz - dy / view.scale };
}

// ---------- 道路名稱標籤（每個名稱取最長的一段、標在其中點所在線段上）----------
function buildLabels() {
  const best = new Map();
  for (const r of surfaceRoads) {
    if (!r.name || !LABEL_SCALE[r.type]) continue;
    const cur = best.get(r.name);
    if (!cur || r.length > cur.length) best.set(r.name, r);
  }
  const labels = [];
  for (const r of best.values()) {
    const half = r.length / 2;
    let i = 0;
    while (i < r.pts.length - 2 && r.cum[i + 1] < half) i++;
    const a = r.pts[i];
    const b = r.pts[i + 1];
    let ang = Math.atan2(b.z - a.z, b.x - a.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    else if (ang < -Math.PI / 2) ang += Math.PI;
    labels.push({ name: r.name, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, ang, minScale: LABEL_SCALE[r.type], rank: ROAD_STYLE[r.type].rank });
  }
  labels.sort((p, q) => q.rank - p.rank);
  return labels;
}

const labels = buildLabels();
const roadsSorted = surfaceRoads
  .slice()
  .sort((a, b) => (ROAD_STYLE[a.type] || ROAD_OTHER).rank - (ROAD_STYLE[b.type] || ROAD_OTHER).rank || a.width - b.width);

// ---------- 繪製（純：只用傳入的 ctx 與 view，node 可用假 context 測）----------
export function drawMap(ctx, view, player) {
  const k = view.scale;
  const X = (x) => (x - view.cx) * k + view.w / 2;
  const Y = (z) => (z - view.cz) * k + view.h / 2;
  // 視窗外的物件略過（世界座標外框）
  const vx0 = view.cx - view.w / 2 / k;
  const vx1 = view.cx + view.w / 2 / k;
  const vz0 = view.cz - view.h / 2 / k;
  const vz1 = view.cz + view.h / 2 / k;
  const visible = (bb) => bb.x1 >= vx0 && bb.x0 <= vx1 && bb.z1 >= vz0 && bb.z0 <= vz1;
  const polyPath = (p) => {
    ctx.beginPath();
    for (let i = 0; i < p.length; i += 2) {
      if (i === 0) ctx.moveTo(X(p[i]), Y(p[i + 1]));
      else ctx.lineTo(X(p[i]), Y(p[i + 1]));
    }
    ctx.closePath();
  };
  const linePath = (pts) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(X(pts[i].x), Y(pts[i].z));
      else ctx.lineTo(X(pts[i].x), Y(pts[i].z));
    }
  };

  // 地圖外底色 + 地圖範圍內鋪面色
  ctx.fillStyle = '#141a22';
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.fillStyle = '#5d5a54';
  ctx.fillRect(X(BOUNDS.minX), Y(BOUNDS.minZ), (BOUNDS.maxX - BOUNDS.minX) * k, (BOUNDS.maxZ - BOUNDS.minZ) * k);

  ctx.fillStyle = '#4c8a4a';
  for (const p of parks) {
    if (!visible(p.bbox)) continue;
    polyPath(p.poly);
    ctx.fill();
  }
  ctx.fillStyle = '#3f86b8';
  for (const w of water) {
    if (!visible(w.bbox)) continue;
    polyPath(w.poly);
    ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (k >= 0.5) {
    ctx.strokeStyle = '#8f897b';
    for (const r of surfaceFootways) {
      ctx.lineWidth = Math.max(0.8, r.width * k);
      linePath(r.pts);
      ctx.stroke();
    }
  }
  for (const r of roadsSorted) {
    const st = ROAD_STYLE[r.type] || ROAD_OTHER;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(st.min, r.width * k);
    linePath(r.pts);
    ctx.stroke();
  }

  ctx.fillStyle = '#8b9096';
  ctx.strokeStyle = '#5b6066';
  ctx.lineWidth = 1;
  for (const b of buildings) {
    if (!visible(b.bbox)) continue;
    polyPath(b.poly);
    ctx.fill();
    if (k >= 0.6) ctx.stroke();
  }

  // 道路名稱：比例夠大才出現；以螢幕外框簡單避讓，不互相重疊
  ctx.font = `bold ${Math.round(Math.min(16, 11 + k * 3))}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const placed = [];
  for (const L of labels) {
    if (k < L.minScale) continue;
    const sx = X(L.x);
    const sy = Y(L.z);
    if (sx < -60 || sx > view.w + 60 || sy < -20 || sy > view.h + 20) continue;
    const tw = ctx.measureText(L.name).width || L.name.length * 14;
    const half = tw / 2 + 4;
    const box = { x0: sx - half, x1: sx + half, y0: sy - half, y1: sy + half };
    if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) continue;
    placed.push(box);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(L.ang);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(L.name, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(L.name, 0, 0);
    ctx.restore();
  }

  // 玩家箭頭（與小地圖同轉法）
  if (player && Number.isFinite(player.x) && Number.isFinite(player.z)) {
    ctx.save();
    ctx.translate(X(player.x), Y(player.z));
    ctx.rotate(Math.PI - (player.yaw || 0));
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 北方標記
  ctx.font = `bold 15px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText('N ▲', view.w - 30, 18);
  ctx.fillStyle = '#ff6a6a';
  ctx.fillText('N ▲', view.w - 30, 18);
}

// ---------- DOM 元件 ----------
// getPlayer：() => ({ x, z, yaw })；回傳 { el, open(), close(), draw(), isOpen(), getView(), zoomBy(f), panKeys(dx, dy), recenter(), destroy() }
export function createMapView({ getPlayer = () => null } = {}) {
  const doc = globalThis.document;
  const win = typeof window !== 'undefined' ? window : null;
  const el = doc.createElement('div');
  el.className = 'tg-map';
  const canvas = doc.createElement('canvas');
  canvas.className = 'tg-map-canvas';
  canvas.setAttribute('aria-label', '城市地圖');
  el.appendChild(canvas);
  const tools = doc.createElement('div');
  tools.className = 'tg-map-tools';
  el.appendChild(tools);
  const mkBtn = (text, title, fn) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'tg-btn tg-map-btn';
    b.textContent = text;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    tools.appendChild(b);
    return b;
  };

  let opened = false;
  let rafId = 0;
  let view = { cx: 0, cz: 0, scale: DEFAULT_SCALE, w: 1, h: 1 };
  const pointers = new Map(); // pointerId → { x, y }

  const dpr = () => (win && win.devicePixelRatio) || 1;

  function resize() {
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const w = Math.max(1, Math.round((r && r.width) || canvas.clientWidth || 640));
    const h = Math.max(1, Math.round((r && r.height) || canvas.clientHeight || 400));
    const d = dpr();
    const bw = Math.round(w * d);
    const bh = Math.round(h * d);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    view = clampView({ ...view, w, h });
  }

  function draw() {
    if (!opened) return;
    rafId = 0;
    resize();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const d = dpr();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    drawMap(ctx, view, getPlayer());
  }

  // 有變動才排一幀（沒有 rAF 的環境直接畫）
  function schedule() {
    if (!opened || rafId) return;
    if (win && win.requestAnimationFrame) rafId = win.requestAnimationFrame(draw);
    else draw();
  }

  function setView(v) {
    view = clampView(v);
    schedule();
  }

  function recenter() {
    const p = getPlayer();
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) setView({ ...view, cx: p.x, cz: p.z });
    else setView({ ...view, cx: (BOUNDS.minX + BOUNDS.maxX) / 2, cz: (BOUNDS.minZ + BOUNDS.maxZ) / 2 });
  }

  const zoomBy = (f) => setView(zoomAt(view, f, view.w / 2, view.h / 2));
  const panKeys = (dx, dy) => setView(panBy(view, -dx * KEY_PAN_PX, -dy * KEY_PAN_PX));

  mkBtn('+', '放大', () => zoomBy(BTN_ZOOM));
  mkBtn('−', '縮小', () => zoomBy(1 / BTN_ZOOM));
  const meBtn = mkBtn('◎ 回到自己', '回到自己', () => recenter());
  meBtn.classList.add('tg-map-me');

  // ---------- 指標：單指拖曳、雙指縮放 ----------
  const local = (e) => {
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinch = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  let lastPinch = null;

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, local(e));
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 指標已失效時忽略
      }
    }
    lastPinch = pointers.size === 2 ? pinch() : null;
    canvas.classList.add('tg-dragging');
    e.preventDefault();
  }
  function onMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.size >= 2) {
      pointers.set(e.pointerId, p);
      const cur = pinch();
      if (lastPinch && lastPinch.d > 0) {
        let v = zoomAt(view, cur.d / lastPinch.d, cur.mx, cur.my);
        v = panBy(v, cur.mx - lastPinch.mx, cur.my - lastPinch.my);
        setView(v);
      }
      lastPinch = cur;
    } else {
      setView(panBy(view, p.x - prev.x, p.y - prev.y));
      pointers.set(e.pointerId, p);
    }
    e.preventDefault();
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    lastPinch = pointers.size === 2 ? pinch() : null;
    if (!pointers.size) canvas.classList.remove('tg-dragging');
  }
  function onWheel(e) {
    e.preventDefault();
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setView(zoomAt(view, Math.exp(-dy * 0.0015), p.x, p.y));
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const onResize = () => schedule();

  function open() {
    if (opened) return;
    opened = true;
    if (win) win.addEventListener('resize', onResize);
    resize();
    recenter();
    draw();
  }

  function close() {
    if (!opened) return;
    opened = false;
    pointers.clear();
    lastPinch = null;
    if (rafId && win && win.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
    rafId = 0;
    if (win) win.removeEventListener('resize', onResize);
  }

  function destroy() {
    close();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('lostpointercapture', onUp);
    canvas.removeEventListener('wheel', onWheel);
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    el,
    open,
    close,
    draw,
    destroy,
    recenter,
    zoomBy,
    panKeys,
    isOpen: () => opened,
    getView: () => ({ ...view }),
  };
}
