// 打卡 / 圖鑑共用小工具：安全建 DOM（無 document 時回 null）、依 id 決定的純色、缺檔只 console.info 一次、字串陣列清洗
const infoSeen = new Set();

// 同一 key 只 console.info 一次（契約：缺檔安靜退回，不得 console.error）
export function infoOnce(key, text) {
  if (infoSeen.has(key)) return;
  infoSeen.add(key);
  if (typeof console !== 'undefined' && console.info) console.info(text);
}

export function docOf(root) {
  if (root && root.ownerDocument) return root.ownerDocument;
  return globalThis.document || null;
}

// 建元素：cls = class 字串，text = textContent；doc 為 null 時回 null
export function el(doc, tag, cls, text) {
  if (!doc) return null;
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

// 字串 → 穩定色相（純色卡片 / 徽章底色）
export function hueOf(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function colorOf(s, sat = 62, light = 46) {
  return `hsl(${hueOf(s)}, ${sat}%, ${light}%)`;
}

// 名稱首字（處理代理對，emoji / 罕用字不會切半）
export function firstChar(name) {
  const s = String(name || '').trim();
  if (!s) return '？';
  return Array.from(s)[0];
}

export const LIST_MAX = 200; // 存檔 checkins / foods 上限（§18）

// 存檔陣列清洗：只收非空字串、去重、上限 LIST_MAX
export function cleanIdList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const v of list) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

// 圖片：載入成功才顯示（加 .cl-loaded），失敗就維持純色底；node 替身沒有 onload 也不會出錯
export function lazyImage(doc, cls, src, alt) {
  const img = el(doc, 'img', cls);
  if (!img) return null;
  img.alt = alt || '';
  img.onload = () => img.classList && img.classList.add('cl-loaded');
  img.onerror = () => {
    img.hidden = true;
  };
  img.src = src;
  return img;
}
