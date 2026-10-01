// M 大地圖（契約 §17，前綴 mp-，z-index 85）：全螢幕 canvas 面板，只在遊戲中開啟
// 繪製：路網（主要道路粗、巷弄細）、公園、水域、建築（淡）、地標名稱、路線（亮色粗線）、標記（依 kind 著色）、玩家箭頭
// 操作：pointer events 統一滑鼠 / 觸控——單指拖曳平移、雙指捏合縮放（以兩指中點為錨）、滾輪縮放（以指標為錨）；
//   總位移 < 6 px 且全程單指 = 點擊 → onPick(x, z)（地圖範圍外忽略）；右側圖例、「回到自己」「清除目的地」、關閉鈕
// 只在開啟且 dirty 時重繪（靜止不重繪）；外部狀態改變（玩家移動 / 路線更新）由整合層呼叫 draw() 標記重繪
// 座標與縮放 / 平移沿用 src/ui/map-view.js 的純函式（世界 X 東、Z 南，北朝上）
import { BOUNDS, MAJOR_TYPES, ATTRIBUTION, surfaceRoads, surfaceFootways, buildings, namedBuildings, parks, water } from '../citymodel.js';
import { screenToWorld, worldToScreen, clampView, zoomAt, panBy, fitScale } from '../ui/map-view.js';
import { MARKER_COLORS, CAR_MARKER_COLOR } from './marker-colors.js';
import './map.css';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif';
export const TAP_PX = 6; // 移動小於此值視為點擊
const BTN_ZOOM = 1.5;
const WHEEL_K = 0.0015;

// 標記顏色（src/map/marker-colors.js，與小地圖同源）/ 圖例文字（MARKER_LABELS）/ 圖釘樣式（PIN_KINDS）：三者同一份 kind 清單，含時段事件 event-start / event-dest、垃圾車 event-truck（圓點）與打工 job-start / job-dest（圖釘）/ job-car
export { MARKER_COLORS };
export const MARKER_LABELS = {
  'mission-start': '委託起點',
  'mission-dest': '委託目的地',
  dest: '目的地',
  checkin: '打卡地標',
  food: '小吃',
  ammo: '彈藥',
  'event-start': '外送取餐點',
  'event-dest': '外送送達點',
  'event-truck': '垃圾車',
  'job-start': '打工接單點',
  'job-dest': '打工目的地',
  'job-car': '泊車指定車',
};
// 畫成圖釘的 kind（目的地類）；其餘 kind 畫圓點
export const PIN_KINDS = new Set(['dest', 'mission-dest', 'job-dest', 'event-dest']);
const ROUTE_COLOR = '#35f2ff';
const PLAYER_COLOR = '#ffd23f';

// ---------- 靜態資料（模組載入時整理一次）----------
function lineBBox(pts, pad) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}
const majorRoads = [];
const minorRoads = [];
for (const r of surfaceRoads) {
  const item = { road: r, bbox: lineBBox(r.pts, r.hw) };
  (MAJOR_TYPES.has(r.type) || r.type === 'trunk' ? majorRoads : minorRoads).push(item);
}
majorRoads.sort((a, b) => a.road.width - b.road.width);
const footItems = surfaceFootways.map((r) => ({ road: r, bbox: lineBBox(r.pts, r.hw) }));

// 未注入地標時：面積前 30 大的具名建築
function defaultLandmarks() {
  return namedBuildings
    .slice()
    .sort((a, b) => b.area - a.area)
    .slice(0, 30)
    .map((b) => ({ name: b.name, x: b.center.x, z: b.center.z }));
}

// ---------- 繪製（純：只用傳入的 ctx 與 view）----------
// data = { player:{x,z,yaw}|null, markers:[{x,z,kind,label?}]|null, route:[{x,z}]|null, landmarks:[{name,x,z}] }
export function drawBigMap(ctx, view, data = {}) {
  const k = view.scale;
  const hw = view.w / 2;
  const hh = view.h / 2;
  const X = (x) => (x - view.cx) * k + hw;
  const Y = (z) => (z - view.cz) * k + hh;
  const vx0 = view.cx - hw / k;
  const vx1 = view.cx + hw / k;
  const vz0 = view.cz - hh / k;
  const vz1 = view.cz + hh / k;
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

  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.fillStyle = '#2a2f36';
  ctx.fillRect(X(BOUNDS.minX), Y(BOUNDS.minZ), (BOUNDS.maxX - BOUNDS.minX) * k, (BOUNDS.maxZ - BOUNDS.minZ) * k);

  ctx.fillStyle = '#35643a';
  for (const p of parks) {
    if (!visible(p.bbox)) continue;
    polyPath(p.poly);
    ctx.fill();
  }
  ctx.fillStyle = '#2f6f9e';
  for (const w of water) {
    if (!visible(w.bbox)) continue;
    polyPath(w.poly);
    ctx.fill();
  }

  // 建築：淡色填充
  ctx.fillStyle = 'rgba(170,176,186,0.28)';
  for (const b of buildings) {
    if (!visible(b.bbox)) continue;
    polyPath(b.poly);
    ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (k >= 0.8) {
    ctx.strokeStyle = 'rgba(150,145,130,0.6)';
    ctx.lineWidth = 1;
    for (const it of footItems) {
      if (!visible(it.bbox)) continue;
      linePath(it.road.pts);
      ctx.stroke();
    }
  }
  // 巷弄：細
  ctx.strokeStyle = '#8d8a82';
  for (const it of minorRoads) {
    if (!visible(it.bbox)) continue;
    ctx.lineWidth = Math.max(1.2, it.road.width * k * 0.8);
    linePath(it.road.pts);
    ctx.stroke();
  }
  // 主要道路：粗
  ctx.strokeStyle = '#f0c75e';
  for (const it of majorRoads) {
    if (!visible(it.bbox)) continue;
    ctx.lineWidth = Math.max(3, it.road.width * k);
    linePath(it.road.pts);
    ctx.stroke();
  }

  // 路線：深色描邊 + 亮色粗線
  const route = data.route;
  if (route && route.length >= 2) {
    linePath(route);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = ROUTE_COLOR;
    ctx.lineWidth = 5;
    ctx.stroke();
  }

  // 地標：小方點 + 名稱
  const lms = data.landmarks || [];
  if (lms.length) {
    ctx.font = `bold ${Math.round(Math.min(15, 11 + k * 2))}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    for (const L of lms) {
      const sx = X(L.x);
      const sy = Y(L.z);
      if (sx < -80 || sx > view.w + 20 || sy < -20 || sy > view.h + 20) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(sx - 3, sy - 3, 6, 6);
      if (k >= 0.35 && L.name) {
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(L.name, sx + 6, sy);
        ctx.fillStyle = '#f2f4f8';
        ctx.fillText(L.name, sx + 6, sy);
      }
    }
  }

  // 標記：目的地畫成圖釘，其他為圓點
  const markers = data.markers;
  if (markers) {
    for (const m of markers) {
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
      const sx = X(m.x);
      const sy = Y(m.z);
      if (sx < -20 || sx > view.w + 20 || sy < -30 || sy > view.h + 20) continue;
      const color = MARKER_COLORS[m.kind] || CAR_MARKER_COLOR;
      ctx.fillStyle = color;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (PIN_KINDS.has(m.kind)) {
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx - 8, sy - 14);
        ctx.arc(sx, sy - 16, 8, Math.PI * 0.8, Math.PI * 0.2, false);
        ctx.closePath();
      } else {
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }
  }

  // 玩家箭頭（與小地圖同轉法）
  const player = data.player;
  if (player && Number.isFinite(player.x) && Number.isFinite(player.z)) {
    ctx.save();
    ctx.translate(X(player.x), Y(player.z));
    ctx.rotate(Math.PI - (player.yaw || 0));
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(10, 11);
    ctx.lineTo(0, 5);
    ctx.lineTo(-10, 11);
    ctx.closePath();
    ctx.fillStyle = PLAYER_COLOR;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ---------- DOM 元件 ----------
// createBigMap({ root, getPlayer, getMarkers, getRoute, onPick, bus, landmarks?, onClear?, onClose? })
//   → { el, open(), close(), toggle(), isOpen(), draw(), destroy(), getView(), setView(v), zoomBy(f), recenter(), stats() }
export function createBigMap({
  root = null,
  getPlayer = () => null,
  getMarkers = () => null,
  getRoute = () => null,
  onPick = null,
  bus = null,
  landmarks = null,
  onClear = null,
  onClose = null,
} = {}) {
  const doc = globalThis.document;
  const win = typeof window !== 'undefined' ? window : null;
  const lmList = Array.isArray(landmarks) && landmarks.length ? landmarks : defaultLandmarks();
  const sound = (kind) => {
    if (bus) bus.emit('ui:sound', { kind });
  };

  const mk = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const el = mk('div', 'mp-panel');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '大地圖');
  el.setAttribute('aria-hidden', 'true');
  const canvas = mk('canvas', 'mp-canvas');
  canvas.setAttribute('aria-label', '城市大地圖：點擊設定目的地');
  el.appendChild(canvas);

  const top = mk('div', 'mp-top');
  top.appendChild(mk('div', 'mp-title', '地圖'));
  top.appendChild(mk('div', 'mp-hint', '點擊地圖設定目的地'));
  const closeBtn = mk('button', 'mp-btn mp-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '關閉地圖');
  top.appendChild(closeBtn);
  el.appendChild(top);

  const tools = mk('div', 'mp-tools');
  el.appendChild(tools);
  const mkBtn = (text, label, fn, cls = '') => {
    const b = mk('button', `mp-btn${cls ? ' ' + cls : ''}`, text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    tools.appendChild(b);
    return b;
  };

  const legend = mk('div', 'mp-legend');
  legend.appendChild(mk('div', 'mp-legend-title', '圖例'));
  const addLegend = (swCls, color, text) => {
    const row = mk('div', 'mp-legend-row');
    const sw = mk('span', `mp-sw ${swCls}`);
    sw.style.background = color;
    row.appendChild(sw);
    row.appendChild(mk('span', 'mp-legend-text', text));
    legend.appendChild(row);
  };
  addLegend('mp-sw-arrow', PLAYER_COLOR, '你的位置');
  addLegend('mp-sw-line', ROUTE_COLOR, '導航路線');
  for (const kind of Object.keys(MARKER_COLORS)) addLegend('mp-sw-dot', MARKER_COLORS[kind], MARKER_LABELS[kind]);
  addLegend('mp-sw-sq', '#ffffff', '地標');
  addLegend('mp-sw-line mp-sw-thick', '#f0c75e', '主要道路');
  addLegend('mp-sw-line', '#8d8a82', '巷弄');
  addLegend('mp-sw-dot', '#35643a', '公園');
  addLegend('mp-sw-dot', '#2f6f9e', '水域');
  el.appendChild(legend);

  const attr = mk('div', 'mp-attr', ATTRIBUTION);
  el.appendChild(attr);

  if (root && root.appendChild) root.appendChild(el);

  let opened = false;
  let dirty = true;
  let rafId = 0;
  let renders = 0;
  let legendOpen = null; // null = 依螢幕寬度自動
  let view = { cx: (BOUNDS.minX + BOUNDS.maxX) / 2, cz: (BOUNDS.minZ + BOUNDS.maxZ) / 2, scale: 0.7, w: 1, h: 1 };
  const pointers = new Map(); // pointerId → { x, y }
  let tap = null; // { x, y, moved, multi }
  let lastPinch = null;
  const _w = { x: 0, z: 0 };
  const data = { player: null, markers: null, route: null, landmarks: lmList };

  const dpr = () => (win && win.devicePixelRatio) || 1;

  function measure() {
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const w = Math.max(1, Math.round((r && r.width) || canvas.clientWidth || (win && win.innerWidth) || 800));
    const h = Math.max(1, Math.round((r && r.height) || canvas.clientHeight || (win && win.innerHeight) || 600));
    const d = dpr();
    const bw = Math.round(w * d);
    const bh = Math.round(h * d);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    if (w !== view.w || h !== view.h) view = clampView({ ...view, w, h });
  }

  function render() {
    rafId = 0;
    if (!opened || !dirty) return;
    dirty = false;
    measure();
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;
    const d = dpr();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    data.player = getPlayer();
    data.markers = getMarkers();
    data.route = getRoute();
    drawBigMap(ctx, view, data);
    renders++;
  }

  // 標記重繪並排一幀（沒有 rAF 的環境直接畫）
  function invalidate() {
    dirty = true;
    if (!opened || rafId) return;
    if (win && win.requestAnimationFrame) rafId = win.requestAnimationFrame(render);
    else render();
  }

  function setView(v) {
    view = clampView(v);
    invalidate();
  }

  function recenter() {
    const p = getPlayer();
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) setView({ ...view, cx: p.x, cz: p.z });
    else setView({ ...view, cx: (BOUNDS.minX + BOUNDS.maxX) / 2, cz: (BOUNDS.minZ + BOUNDS.maxZ) / 2 });
  }
  const zoomBy = (f) => setView(zoomAt(view, f, view.w / 2, view.h / 2));

  function clearDest() {
    if (typeof onClear === 'function') onClear();
    else if (bus) bus.emit('nav:clear', { source: 'map' });
    sound('cancel');
    invalidate();
  }

  function applyLegend() {
    const wide = !win || !win.innerWidth || win.innerWidth >= 720;
    const show = legendOpen === null ? wide : legendOpen;
    legend.classList.toggle('mp-legend-open', show);
    legendBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
  }

  mkBtn('+', '放大', () => zoomBy(BTN_ZOOM));
  mkBtn('−', '縮小', () => zoomBy(1 / BTN_ZOOM));
  mkBtn('◎ 回到自己', '回到自己', () => {
    recenter();
    sound('click');
  }, 'mp-wide');
  mkBtn('清除目的地', '清除目的地', clearDest, 'mp-wide');
  const legendBtn = mkBtn('圖例', '顯示或隱藏圖例', () => {
    legendOpen = !legend.classList.contains('mp-legend-open');
    applyLegend();
    sound('click');
  }, 'mp-wide');
  closeBtn.addEventListener('click', () => {
    close();
    if (typeof onClose === 'function') onClose();
  });

  // ---------- 指標 ----------
  const local = (e) => {
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinch = () => {
    const it = pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  function onDown(e) {
    if (!opened) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 指標已失效時忽略
      }
    }
    if (pointers.size === 1) tap = { x: p.x, y: p.y, moved: false, multi: false };
    else if (tap) tap.multi = true;
    lastPinch = pointers.size === 2 ? pinch() : null;
    canvas.classList.add('mp-dragging');
    if (e.preventDefault) e.preventDefault();
  }
  function onMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.size >= 2) {
      pointers.set(e.pointerId, p);
      const cur = pinch();
      if (lastPinch && lastPinch.d > 0 && cur.d > 0) {
        // 前一幀兩指中點下的世界點 → 縮放後移到這一幀的中點
        let v = zoomAt(view, cur.d / lastPinch.d, lastPinch.mx, lastPinch.my);
        v = panBy(v, cur.mx - lastPinch.mx, cur.my - lastPinch.my);
        setView(v);
      }
      lastPinch = cur;
    } else {
      setView(panBy(view, p.x - prev.x, p.y - prev.y));
      pointers.set(e.pointerId, p);
      if (tap && !tap.moved && Math.hypot(p.x - tap.x, p.y - tap.y) >= TAP_PX) tap.moved = true;
    }
    if (e.preventDefault) e.preventDefault();
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = e.type === 'pointerup' ? local(e) : null;
    pointers.delete(e.pointerId);
    lastPinch = pointers.size === 2 ? pinch() : null;
    if (pointers.size) return;
    canvas.classList.remove('mp-dragging');
    const t = tap;
    tap = null;
    if (!p || !t || t.moved || t.multi || Math.hypot(p.x - t.x, p.y - t.y) >= TAP_PX) return;
    pick(p.x, p.y);
  }
  function pick(sx, sy) {
    screenToWorld(view, sx, sy, _w);
    if (_w.x < BOUNDS.minX || _w.x > BOUNDS.maxX || _w.z < BOUNDS.minZ || _w.z > BOUNDS.maxZ) return;
    if (typeof onPick === 'function') onPick(_w.x, _w.z);
    sound('confirm');
    invalidate();
  }
  function onWheel(e) {
    if (e.preventDefault) e.preventDefault();
    if (!opened) return;
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setView(zoomAt(view, Math.exp(-dy * WHEEL_K), p.x, p.y));
  }
  const onResize = () => {
    applyLegend();
    invalidate();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault && e.preventDefault());

  function open() {
    if (opened) return;
    opened = true;
    el.classList.add('mp-open');
    el.setAttribute('aria-hidden', 'false');
    if (win) {
      win.addEventListener('resize', onResize);
      win.addEventListener('orientationchange', onResize);
    }
    applyLegend();
    measure();
    // 開啟時以玩家為中心、比例至少能看清街區
    const p = getPlayer();
    const s = Math.max(view.scale, fitScale(view.w, view.h) * 1.2);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) view = clampView({ ...view, scale: s, cx: p.x, cz: p.z });
    else view = clampView({ ...view, scale: s });
    sound('open');
    dirty = true;
    render();
  }

  function close() {
    if (!opened) return;
    opened = false;
    el.classList.remove('mp-open');
    el.setAttribute('aria-hidden', 'true');
    pointers.clear();
    tap = null;
    lastPinch = null;
    canvas.classList.remove('mp-dragging');
    if (rafId && win && win.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
    rafId = 0;
    if (win) {
      win.removeEventListener('resize', onResize);
      win.removeEventListener('orientationchange', onResize);
    }
    sound('close');
  }

  function toggle() {
    if (opened) close();
    else open();
    return opened;
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
    toggle,
    isOpen: () => opened,
    draw: invalidate,
    destroy,
    recenter,
    zoomBy,
    setView,
    getView: () => ({ ...view }),
    worldToScreen: (x, z, out) => worldToScreen(view, x, z, out),
    stats: () => ({ renders, dirty }),
  };
}
