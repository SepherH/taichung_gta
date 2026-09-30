// 地標打卡（契約 §17，前綴 cl-）：進入地標 radius 內且未打卡 → interactable（priority 2，「按 E 打卡：<名稱>」）
// act() → 記錄、addMoney(reward, 'checkin')、emit collect:checkin、徽章彈窗（art/badges/<slug>.png；缺 → 純色圓徽 + 名稱首字；3 s 自動收）
// 每幀路徑（nearest / markers / progress）不配置新物件：interactable 每個地標預建一個、markers 陣列只在打卡狀態改變時重建
// 地標 landmarks 由整合層注入（core/landmark-points.js 的輸出）；DOM 掛在 root（省略 = document.body；無 document 時 UI 為 no-op）
import './collect.css';
import { docOf, el, colorOf, firstChar, cleanIdList, lazyImage } from './util.js';

export const CHECKIN_PRIORITY = 2;
export const CHECKIN_REWARD = 200;
export const BADGE_SECONDS = 3;

export function createCheckins({
  bus = null,
  landmarks = [],
  addMoney = null,
  reward = CHECKIN_REWARD,
  badgeBase = 'art/badges/',
  root = null,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (h) => globalThis.clearTimeout(h),
} = {}) {
  const list = [];
  const seenSlug = new Set();
  for (const l of Array.isArray(landmarks) ? landmarks : []) {
    if (!l || typeof l.slug !== 'string' || !l.slug || seenSlug.has(l.slug)) continue;
    if (!Number.isFinite(l.x) || !Number.isFinite(l.z)) continue;
    seenSlug.add(l.slug);
    list.push({
      id: l.id !== undefined ? l.id : l.slug,
      slug: l.slug,
      name: typeof l.name === 'string' && l.name ? l.name : l.slug,
      x: l.x,
      z: l.z,
      radius: Number.isFinite(l.radius) && l.radius > 0 ? l.radius : 25,
    });
  }
  // done 保留存檔裡不在本次地標清單的 slug（地標清單變動時不遺失進度）
  const done = new Set();

  // 每個地標預建 interactable（dist 就地更新）
  for (const l of list) {
    l.inter = {
      id: 'checkin:' + l.slug,
      text: `按 E 打卡：${l.name}`,
      dist: 0,
      priority: CHECKIN_PRIORITY,
      act: () => checkIn(l),
    };
  }

  const markerList = [];
  let markersDirty = true;
  const prog = { done: 0, total: list.length };

  function rebuildMarkers() {
    markerList.length = 0;
    for (const l of list) if (!done.has(l.slug)) markerList.push({ x: l.x, z: l.z, kind: 'checkin', label: l.name });
    markersDirty = false;
  }

  // ---------- 徽章彈窗 ----------
  const host = root || (globalThis.document && globalThis.document.body) || null;
  const doc = docOf(host);
  let popup = null;
  let popupTimer = null;

  function closeBadge() {
    if (popupTimer !== null) clearTimer(popupTimer);
    popupTimer = null;
    if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
    popup = null;
  }

  function showBadge(l) {
    closeBadge();
    if (!doc || !host) return;
    const box = el(doc, 'div', 'cl-badge-pop');
    box.setAttribute('role', 'status');
    const medal = el(doc, 'div', 'cl-badge');
    medal.style.background = colorOf(l.slug, 58, 42);
    medal.appendChild(el(doc, 'span', 'cl-badge-char', firstChar(l.name)));
    const img = lazyImage(doc, 'cl-badge-img', `${badgeBase}${l.slug}.png`, l.name);
    if (img) medal.appendChild(img);
    box.appendChild(medal);
    const txt = el(doc, 'div', 'cl-badge-text');
    txt.appendChild(el(doc, 'div', 'cl-badge-title', '打卡成功'));
    txt.appendChild(el(doc, 'div', 'cl-badge-name', l.name));
    txt.appendChild(el(doc, 'div', 'cl-badge-reward', `+NT$${reward}`));
    box.appendChild(txt);
    box.addEventListener('click', closeBadge);
    host.appendChild(box);
    popup = box;
    popupTimer = setTimer(closeBadge, BADGE_SECONDS * 1000);
  }

  function checkIn(l) {
    if (done.has(l.slug)) return false;
    done.add(l.slug);
    markersDirty = true;
    if (typeof addMoney === 'function' && reward > 0) addMoney(reward, 'checkin');
    if (bus) bus.emit('collect:checkin', { landmarkId: l.id, slug: l.slug, name: l.name, reward });
    showBadge(l);
    return true;
  }

  return {
    // pos = { x, z }；radius 內最近且未打卡者，否則 null
    nearest(pos) {
      if (!pos) return null;
      let best = null;
      let bestD = Infinity;
      for (const l of list) {
        if (done.has(l.slug)) continue;
        const dx = pos.x - l.x;
        const dz = pos.z - l.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= l.radius && d < bestD) {
          bestD = d;
          best = l;
        }
      }
      if (!best) return null;
      best.inter.dist = bestD;
      return best.inter;
    },
    // 未打卡地標（回傳同一個陣列，呼叫端勿修改）
    markers() {
      if (markersDirty) rebuildMarkers();
      return markerList;
    },
    progress() {
      let n = 0;
      for (const l of list) if (done.has(l.slug)) n++;
      prog.done = n;
      prog.total = list.length;
      return prog;
    },
    isDone(slug) {
      return done.has(slug);
    },
    list() {
      return list.map((l) => ({ id: l.id, slug: l.slug, name: l.name, x: l.x, z: l.z, radius: l.radius, done: done.has(l.slug) }));
    },
    // → 地標 slug 字串陣列（§18 collect.checkins）
    serialize() {
      return cleanIdList(Array.from(done));
    },
    // data = slug 陣列，或 { checkins: [...] }（整份 collect 物件也可）
    restore(data) {
      const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? data.checkins : null;
      done.clear();
      for (const s of cleanIdList(arr)) done.add(s);
      markersDirty = true;
      closeBadge();
    },
    closeBadge,
    dispose() {
      closeBadge();
    },
  };
}
