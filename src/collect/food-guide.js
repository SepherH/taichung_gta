// 小吃圖鑑（契約 §17，前綴 cl-，面板 z-index 85）：收集點浮動圖示 → 按 E 收集（priority 1）→ 卡片彈窗 + NT$50 → 圖鑑面板
// 資料：fetchJson(manifestUrl)；接受 { items:[…] } 或頂層陣列；欄位別名 id/slug、desc/description/text/intro、file/image；
//   缺檔 / 壞 JSON / 空清單 → 內建 BUILTIN_FOODS（12 項，無圖 → 純色卡片），只 console.info 一次
// 收集點 spots（food-spots.js）以 food 欄位對應小吃 id；對不上的點依序補上尚未分配的小吃；只有分配到點的小吃計入圖鑑（N）
// 場景圖示：單一 InstancedMesh（每點一個 instance、instanceColor 依小吃上色），已收集者矩陣縮成 0；update 重用暫存物件
// 圖卡 art/food/<file>：載入成功才蓋上，缺圖 → 純色卡片 + 名稱
import * as THREE from 'three';
import './collect.css';
import { docOf, el, colorOf, hueOf, firstChar, cleanIdList, infoOnce, lazyImage } from './util.js';
import { FOOD_SPOTS } from './food-spots.js';

export const FOOD_PRIORITY = 1;
export const FOOD_REWARD = 50;
export const FOOD_RADIUS = 4; // 可收集距離（m）
export const FOOD_POPUP_SECONDS = 4;
const ICON_LIFT = 1.3; // 圖示離地高度（m）
const ICON_BOB = 0.15;

// 內建清單（manifest 缺時）：id 與 public/art/food/manifest.json 相同，收集點對應不變；介紹為本專案自寫，不提店家品牌
export const BUILTIN_FOODS = [
  { id: 'fried-noodles-chili', name: '炒麵配東泉辣椒醬', desc: '臺中早餐的經典組合：油麵炒得微乾，淋上甜中帶辣的紅色辣椒醬，再配一碗熱湯。' },
  { id: 'da-mian-geng', name: '大麵羹', desc: '粗鹼麵在微稠湯頭裡煮得軟滑，撒上韭菜與紅蔥酥，是臺中人的平價飽足感。' },
  { id: 'sun-cake', name: '太陽餅', desc: '層層酥皮包著麥芽糖餡，輕咬就掉滿身酥屑，臺中最具代表性的伴手禮。' },
  { id: 'bubble-tea', name: '珍珠奶茶', desc: '濃郁奶茶加上 Q 彈粉圓，臺中常被視為手搖飲的發源地之一。' },
  { id: 'fengren-ice', name: '豐仁冰', desc: '綿細刨冰搭配熬煮入味的紅豆，是許多臺中人夏天的老味道。' },
  { id: 'mitou-ice', name: '蜜豆冰', desc: '刨冰鋪上蜜豆與蜜餞水果，最後淋一圈煉乳，古早味的消暑冰品。' },
  { id: 'mayi-soup', name: '麻薏湯', desc: '夏天限定的臺中家常湯：黃麻嫩葉搭地瓜與小魚乾，入口微苦、尾韻回甘。' },
  { id: 'chicken-feet-jelly', name: '雞腳凍', desc: '滷得入味的雞腳冰鎮成凍，冰涼 Q 彈，大學商圈的人氣點心。' },
  { id: 'yizhong-chicken-cutlet', name: '大雞排', desc: '比臉還大的炸雞排外酥內嫩，撒上胡椒粉，是學生下課最常排隊的小吃。' },
  { id: 'rou-yuan', name: '肉圓', desc: '半透明的地瓜粉外皮包著豬肉與筍丁，淋上甜辣醬，中部常見的古早小吃。' },
  { id: 'mung-bean-cake', name: '綠豆椪', desc: '雪白酥皮裹著綿密綠豆沙，有的還包滷肉燥，中秋時節家家必備。' },
  { id: 'salty-sponge-cake', name: '鹹蛋糕', desc: '鬆軟蛋糕中間夾著鹹香肉燥，甜鹹交織，是臺中糕餅舖的特色點心。' },
];

// 預設 fetchJson：404 / 回退成 index.html（非 JSON）→ null
async function defaultFetchJson(url) {
  if (typeof globalThis.fetch !== 'function') return null;
  const res = await globalThis.fetch(url);
  if (!res || !res.ok) return null;
  const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (type && !type.includes('json')) return null;
  return res.json();
}

const pickStr = (...vals) => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
};

// manifest → [{ id, name, desc, file, area }]；不合法回空陣列
export function normalizeFoods(data) {
  const arr = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray(data.items) ? data.items : null;
  const out = [];
  if (!arr) return out;
  const seen = new Set();
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const id = pickStr(typeof e.id === 'number' ? String(e.id) : e.id, e.slug);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: pickStr(e.name, e.title) || id,
      desc: pickStr(e.desc, e.description, e.text, e.intro),
      file: pickStr(e.file, e.image) || null,
      area: pickStr(e.area) || null,
    });
  }
  return out;
}

// 收集點 × 小吃 → [{ spot, item }]：先依 spot.food 精確對應，對不上者依序補未分配的小吃；多出的點不用
export function bindSpots(spots, items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const used = new Set();
  const out = [];
  const pending = [];
  for (const s of Array.isArray(spots) ? spots : []) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
    const it = byId.get(s.food);
    if (it && !used.has(it.id)) {
      used.add(it.id);
      out.push({ spot: s, item: it });
    } else pending.push(s);
  }
  let k = 0;
  for (const s of pending) {
    while (k < items.length && used.has(items[k].id)) k++;
    if (k >= items.length) break;
    used.add(items[k].id);
    out.push({ spot: s, item: items[k] });
  }
  return out;
}

export function createFoodGuide({
  bus = null,
  scene = null,
  root = null,
  manifestUrl = 'art/food/manifest.json',
  spots = FOOD_SPOTS,
  fetchJson = defaultFetchJson,
  addMoney = null,
  reward = FOOD_REWARD,
  radius = FOOD_RADIUS,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (h) => globalThis.clearTimeout(h),
} = {}) {
  const imageBase = manifestUrl.replace(/[^/]*$/, '');
  const found = new Set(); // 已收集的小吃 id（含存檔中目前清單沒有的 id，存檔往返不遺失）
  let items = []; // 圖鑑卡（只含分配到收集點者，依 manifest 順序）
  let active = []; // [{ spot, item, inter, idx }]
  let source = 'none'; // 'manifest' | 'builtin'
  let loaded = false;
  let disposed = false;
  const markerList = [];
  let markersDirty = true;
  const prog = { found: 0, total: 0, done: 0 };

  // ---------- 場景圖示 ----------
  let mesh = null;
  let iconsDirty = true;
  let t = 0;
  const _obj = new THREE.Object3D();
  const _col = new THREE.Color();

  function buildIcons() {
    if (!scene || !active.length) return;
    // 小碗形：上寬下窄的截錐
    const geo = new THREE.CylinderGeometry(0.42, 0.24, 0.32, 14);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mesh = new THREE.InstancedMesh(geo, mat, active.length);
    mesh.name = 'cl-food-icons';
    mesh.frustumCulled = false;
    for (let i = 0; i < active.length; i++) {
      _col.setHSL(hueOf(active[i].item.id) / 360, 0.75, 0.58);
      mesh.setColorAt(i, _col);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    iconsDirty = true;
    updateIcons();
  }

  function updateIcons() {
    if (!mesh) return;
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      if (found.has(a.item.id)) {
        if (!iconsDirty) continue; // 已收集者只在狀態改變時寫一次零矩陣
        _obj.position.set(a.spot.x, -1000, a.spot.z);
        _obj.scale.set(0, 0, 0);
      } else {
        _obj.position.set(a.spot.x, (Number.isFinite(a.spot.y) ? a.spot.y : 0) + ICON_LIFT + Math.sin(t * 2 + i) * ICON_BOB, a.spot.z);
        _obj.scale.set(1, 1, 1);
      }
      _obj.rotation.set(0, t * 1.5 + i, 0);
      _obj.updateMatrix();
      mesh.setMatrixAt(i, _obj.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    iconsDirty = false;
  }

  function applyItems(list, src) {
    if (disposed) return;
    source = src;
    active = bindSpots(spots, list).map((b, idx) => ({
      spot: b.spot,
      item: b.item,
      idx,
      inter: { id: 'food:' + b.item.id, text: `按 E 收集小吃：${b.item.name}`, dist: 0, priority: FOOD_PRIORITY, act: null },
    }));
    for (const a of active) a.inter.act = () => collect(a);
    const bound = new Set(active.map((a) => a.item.id));
    items = list.filter((it) => bound.has(it.id));
    loaded = true;
    markersDirty = true;
    buildIcons();
  }

  const ready = (async () => {
    let list = [];
    try {
      const data = await fetchJson(manifestUrl);
      list = normalizeFoods(data);
    } catch (e) {
      list = [];
    }
    if (list.length) applyItems(list, 'manifest');
    else {
      infoOnce('food-manifest', `小吃圖鑑：${manifestUrl} 缺檔或格式不符，改用內建清單`);
      applyItems(normalizeFoods(BUILTIN_FOODS), 'builtin');
    }
  })();

  function countFound() {
    let n = 0;
    for (const it of items) if (found.has(it.id)) n++;
    return n;
  }

  function imageUrl(it) {
    return it.file ? imageBase + it.file : null;
  }

  // ---------- DOM ----------
  const host = root || (globalThis.document && globalThis.document.body) || null;
  const doc = docOf(host);
  let panel = null;
  let grid = null;
  let countEl = null;
  let popup = null;
  let popupTimer = null;

  function artBox(it, cls, locked) {
    const box = el(doc, 'div', cls);
    if (locked) {
      box.appendChild(el(doc, 'span', 'cl-art-mark', '？'));
      return box;
    }
    box.style.background = colorOf(it.id, 55, 40);
    box.appendChild(el(doc, 'span', 'cl-art-char', firstChar(it.name)));
    const src = imageUrl(it);
    if (src) {
      const img = lazyImage(doc, 'cl-art-img', src, it.name);
      if (img) box.appendChild(img);
    }
    return box;
  }

  function buildPanel() {
    if (panel || !doc || !host) return;
    panel = el(doc, 'div', 'cl-guide');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '小吃圖鑑');
    const frame = el(doc, 'div', 'cl-guide-frame');
    const head = el(doc, 'div', 'cl-guide-head');
    head.appendChild(el(doc, 'h2', 'cl-guide-title', '臺中小吃圖鑑'));
    countEl = el(doc, 'div', 'cl-guide-count', '');
    head.appendChild(countEl);
    const btn = el(doc, 'button', 'cl-close', '✕');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', '關閉圖鑑');
    btn.addEventListener('click', () => api.close());
    head.appendChild(btn);
    frame.appendChild(head);
    grid = el(doc, 'div', 'cl-grid');
    frame.appendChild(grid);
    panel.appendChild(frame);
    // 點背景關閉
    panel.addEventListener('click', (e) => {
      if (e && e.target === panel) api.close();
    });
    host.appendChild(panel);
  }

  function renderPanel() {
    if (!panel) return;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    for (const it of items) {
      const got = found.has(it.id);
      const card = el(doc, 'div', got ? 'cl-card cl-found' : 'cl-card cl-locked');
      card.appendChild(artBox(it, 'cl-card-art', !got));
      card.appendChild(el(doc, 'div', 'cl-card-name', got ? it.name : '？？？'));
      if (got && it.desc) card.appendChild(el(doc, 'div', 'cl-card-desc', it.desc));
      grid.appendChild(card);
    }
    countEl.textContent = `${countFound()} / ${items.length}`;
  }

  function closePopup() {
    if (popupTimer !== null) clearTimer(popupTimer);
    popupTimer = null;
    if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
    popup = null;
  }

  function showPopup(it) {
    closePopup();
    if (!doc || !host) return;
    const box = el(doc, 'div', 'cl-food-pop');
    box.setAttribute('role', 'status');
    box.appendChild(artBox(it, 'cl-pop-art', false));
    const body = el(doc, 'div', 'cl-pop-body');
    body.appendChild(el(doc, 'div', 'cl-pop-title', `收集到新小吃！ ${countFound()} / ${items.length}`));
    body.appendChild(el(doc, 'div', 'cl-pop-name', it.name));
    if (it.desc) body.appendChild(el(doc, 'div', 'cl-pop-desc', it.desc));
    body.appendChild(el(doc, 'div', 'cl-pop-reward', `+NT$${reward}`));
    const open = el(doc, 'button', 'cl-pop-btn', '查看圖鑑');
    open.setAttribute('type', 'button');
    open.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      closePopup();
      api.open();
    });
    body.appendChild(open);
    box.appendChild(body);
    box.addEventListener('click', closePopup);
    host.appendChild(box);
    popup = box;
    popupTimer = setTimer(closePopup, FOOD_POPUP_SECONDS * 1000);
  }

  function collect(a) {
    if (found.has(a.item.id)) return false;
    found.add(a.item.id);
    markersDirty = true;
    iconsDirty = true;
    updateIcons();
    if (typeof addMoney === 'function' && reward > 0) addMoney(reward, 'food');
    if (bus) bus.emit('collect:food', { id: a.item.id, name: a.item.name, total: items.length, found: countFound() });
    showPopup(a.item);
    if (api.isOpen()) renderPanel();
    return true;
  }

  const api = {
    ready,
    // pos = { x, z }；radius 內最近且未收集者，否則 null
    nearest(pos) {
      if (!pos || !loaded) return null;
      let best = null;
      let bestD = Infinity;
      for (const a of active) {
        if (found.has(a.item.id)) continue;
        const dx = pos.x - a.spot.x;
        const dz = pos.z - a.spot.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= radius && d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (!best) return null;
      best.inter.dist = bestD;
      return best.inter;
    },
    // 未收集的收集點（回傳同一個陣列，呼叫端勿修改）
    markers() {
      if (markersDirty) {
        markerList.length = 0;
        for (const a of active) if (!found.has(a.item.id)) markerList.push({ x: a.spot.x, z: a.spot.z, kind: 'food', label: a.item.name });
        markersDirty = false;
      }
      return markerList;
    },
    open() {
      buildPanel();
      if (!panel) return;
      renderPanel();
      if (panel.hidden && bus) bus.emit('ui:sound', { kind: 'open' });
      panel.hidden = false;
    },
    close() {
      if (!panel || panel.hidden) return;
      panel.hidden = true;
      if (bus) bus.emit('ui:sound', { kind: 'close' });
    },
    toggle() {
      if (api.isOpen()) api.close();
      else api.open();
    },
    isOpen() {
      return !!panel && !panel.hidden;
    },
    // { found, total }（done 同 found，與 checkins.progress 對齊）
    progress() {
      prog.found = countFound();
      prog.done = prog.found;
      prog.total = items.length;
      return prog;
    },
    items() {
      return items.map((it) => ({ ...it, image: imageUrl(it), found: found.has(it.id) }));
    },
    source() {
      return source;
    },
    update(dt, playerPos, camera) {
      if (!mesh) return;
      t += dt > 0 ? dt : 0;
      if (t > 1e4) t -= 1e4;
      updateIcons();
    },
    // → 小吃 id 字串陣列（§18 collect.foods）
    serialize() {
      return cleanIdList(Array.from(found));
    },
    // data = id 陣列，或 { foods: [...] }（整份 collect 物件也可）；ready 前呼叫也可
    restore(data) {
      const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? data.foods : null;
      found.clear();
      for (const s of cleanIdList(arr)) found.add(s);
      markersDirty = true;
      iconsDirty = true;
      updateIcons();
      closePopup();
      if (api.isOpen()) renderPanel();
    },
    closePopup,
    dispose() {
      disposed = true;
      closePopup();
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      if (mesh) {
        if (mesh.parent) mesh.parent.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh = null;
      }
    },
  };
  return api;
}
