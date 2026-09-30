#!/usr/bin/env node
// 地標打卡 + 小吃圖鑑無頭驗證（契約 §17 / §18 collect）：假 bus / DOM 最小替身 / 假 fetchJson / 假計時器
// 用法：node tools/test/collect.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：收集點（全部 pedWalkable、在 BOUNDS 內、彼此 ≥ 80 m、地面高度吻合）；打卡範圍 / 重複拒絕 / 獎勵 / 事件 / 徽章（實檔 URL 與缺檔退回）/ 3 s 自動收；
//   圖鑑 manifest（實檔、404、壞 JSON、頂層陣列 + 欄位別名）；收集流程、場景圖示隱藏、圖鑑面板進度與剪影、存檔往返；CSS 規則
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// ---------- DOM 最小替身 ----------
class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.textContent = '';
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    const self = this;
    this.classList = {
      add(c) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        set.add(c);
        self.className = [...set].join(' ');
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get firstChild() {
    return this.children[0] || null;
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  click() {
    const e = { target: this, stopPropagation() { this.stopped = true; } };
    let node = this;
    while (node && !e.stopped) {
      for (const fn of node.listeners.click || []) fn(e);
      node = node.parentNode;
    }
  }
  // 依 class 找所有後代
  findAll(cls, out = []) {
    for (const c of this.children) {
      if (c.classList.contains(cls)) out.push(c);
      c.findAll(cls, out);
    }
    return out;
  }
  find(cls) {
    return this.findAll(cls)[0] || null;
  }
  get allText() {
    return this.textContent + this.children.map((c) => c.allText).join('');
  }
}
function makeDoc() {
  const doc = { createElement: (tag) => new FakeEl(tag, doc) };
  doc.body = new FakeEl('body', doc);
  return doc;
}
globalThis.document = makeDoc();

// ---------- 假計時器 / bus ----------
function fakeTimers() {
  let seq = 0;
  let clock = 0;
  const jobs = new Map();
  return {
    setTimer: (fn, ms) => {
      jobs.set(++seq, { fn, at: clock + ms });
      return seq;
    },
    clearTimer: (h) => jobs.delete(h),
    advance(ms) {
      clock += ms;
      for (const [h, j] of [...jobs]) {
        if (j.at <= clock) {
          jobs.delete(h);
          j.fn();
        }
      }
    },
    pending: () => jobs.size,
  };
}
function fakeBus() {
  const log = [];
  return { log, emit: (name, payload) => log.push({ name, payload }), of: (name) => log.filter((e) => e.name === name) };
}
function moneySpy() {
  const calls = [];
  const fn = (n, reason) => calls.push({ n, reason });
  fn.calls = calls;
  return fn;
}

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const THREE = await import('three');
const { BOUNDS, inBounds, querySurface } = await import('../../src/citymodel.js');
const { pedWalkable } = await import('../../src/places.js');
const { landmarkPoints } = await import('../../src/core/landmark-points.js');
const manifest = (await import('../../public/models/manifest.json')).default;
const { FOOD_SPOTS, FOOD_SPOT_MIN_GAP } = await import('../../src/collect/food-spots.js');
const { createCheckins, CHECKIN_PRIORITY, BADGE_SECONDS } = await import('../../src/collect/checkins.js');
const { createFoodGuide, normalizeFoods, BUILTIN_FOODS, FOOD_PRIORITY, FOOD_REWARD } = await import('../../src/collect/food-guide.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 假 fetchJson：讀 public/ 實檔；缺檔 → mode 'throw' 丟例外（模擬 404）或 'null' 回 null；壞 JSON → JSON.parse 例外
function fsFetchJson(mode = 'throw') {
  return async (url) => {
    const file = path.join(PUBLIC, url.replace(/^\.\//, ''));
    if (!fs.existsSync(file)) {
      if (mode === 'null') return null;
      throw new Error('404 ' + url);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
}
// 矩陣線性部分全為 0（縮成 0 的 instance；decompose 對零矩陣不可靠）
const zeroScale = (mat) => [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => mat.elements[i] === 0);
const publicExists = (url) => fs.existsSync(path.join(PUBLIC, url));

// console.info 計數（缺檔只 info 一次、不得 console.error）
let infoCount = 0;
let errorCount = 0;
const origInfo = console.info;
const origError = console.error;
console.info = () => infoCount++;
console.error = (...a) => {
  errorCount++;
  origError(...a);
};

// ========== 1. 收集點 ==========
check('收集點 10–12 個', FOOD_SPOTS.length >= 10 && FOOD_SPOTS.length <= 12, String(FOOD_SPOTS.length));
const badWalk = FOOD_SPOTS.filter((s) => !pedWalkable(s.x, s.z)).map((s) => s.id);
check('收集點全部 pedWalkable（人行道上）', badWalk.length === 0, badWalk.join(','));
const badBounds = FOOD_SPOTS.filter((s) => !(s.x >= BOUNDS.minX && s.x <= BOUNDS.maxX && s.z >= BOUNDS.minZ && s.z <= BOUNDS.maxZ && inBounds(s.x, s.z, 3)));
check('收集點全部在 BOUNDS 內', badBounds.length === 0, badBounds.map((s) => s.id).join(','));
let minGap = Infinity;
for (let i = 0; i < FOOD_SPOTS.length; i++) {
  for (let j = i + 1; j < FOOD_SPOTS.length; j++) minGap = Math.min(minGap, Math.hypot(FOOD_SPOTS[i].x - FOOD_SPOTS[j].x, FOOD_SPOTS[i].z - FOOD_SPOTS[j].z));
}
check(`收集點彼此 ≥ ${FOOD_SPOT_MIN_GAP} m`, minGap >= FOOD_SPOT_MIN_GAP, `最近 ${minGap.toFixed(1)} m`);
const q = {};
const badY = FOOD_SPOTS.filter((s) => (querySurface(s.x, s.z, Infinity, q), Math.abs(q.y - s.y) > 0.5));
check('收集點 y 與地面高度吻合（±0.5 m）', badY.length === 0, badY.map((s) => s.id).join(','));
const spotFoods = new Set(FOOD_SPOTS.map((s) => s.food));
check('收集點小吃 id 不重複', spotFoods.size === FOOD_SPOTS.length);
const artManifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'art/food/manifest.json'), 'utf8'));
const artSlugs = new Set(artManifest.items.map((it) => it.slug));
check('收集點小吃 id 全部對應實檔 manifest 與內建清單', [...spotFoods].every((id) => artSlugs.has(id) && BUILTIN_FOODS.some((b) => b.id === id)));
const xs = FOOD_SPOTS.map((s) => s.x);
const zs = FOOD_SPOTS.map((s) => s.z);
check('收集點分散（x 跨 ≥ 800 m、z 跨 ≥ 600 m）', Math.max(...xs) - Math.min(...xs) >= 800 && Math.max(...zs) - Math.min(...zs) >= 600);

// ========== 2. 打卡 ==========
const lms = landmarkPoints(manifest);
check('地標點 12 個', lms.length === 12, String(lms.length));
const badgeMissing = lms.filter((l) => !publicExists(`art/badges/${l.slug}.png`)).map((l) => l.slug);
check('徽章實檔：每個地標 art/badges/<slug>.png 都存在', badgeMissing.length === 0, badgeMissing.join(','));

{
  const bus = fakeBus();
  const money = moneySpy();
  const tm = fakeTimers();
  const root = document.body;
  const ck = createCheckins({ bus, landmarks: lms, addMoney: money, root, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const L = lms.find((l) => l.slug === 'tiger_city');
  check('打卡：地標 radius 外 → null', ck.nearest({ x: L.x + L.radius + 0.5, z: L.z }) === null);
  const it = ck.nearest({ x: L.x + L.radius - 1, z: L.z });
  check(
    '打卡：radius 內 → interactable（priority 2、提示文字、dist）',
    it && it.priority === CHECKIN_PRIORITY && it.priority === 2 && it.text === `按 E 打卡：${L.name}` && Math.abs(it.dist - (L.radius - 1)) < 1e-6 && typeof it.act === 'function',
    it && it.text
  );
  const it2 = ck.nearest({ x: L.x + 2, z: L.z });
  check('打卡：nearest 每幀重用同一物件（不配置）', it2 === it && Math.abs(it2.dist - 2) < 1e-6);
  check('打卡：markers 12 個 kind checkin', ck.markers().length === 12 && ck.markers().every((m) => m.kind === 'checkin' && m.label));
  const mk0 = ck.markers();
  check('打卡：markers 狀態不變時回傳同一陣列', ck.markers() === mk0);
  const r1 = it.act();
  check('打卡：act() 成功', r1 === true);
  check('打卡：addMoney(200, checkin)', money.calls.length === 1 && money.calls[0].n === 200 && money.calls[0].reason === 'checkin');
  const ev = bus.of('collect:checkin');
  check(
    '打卡：emit collect:checkin { landmarkId, slug, name, reward }',
    ev.length === 1 && ev[0].payload.slug === L.slug && ev[0].payload.name === L.name && ev[0].payload.reward === 200 && ev[0].payload.landmarkId === L.id
  );
  const pop = root.find('cl-badge-pop');
  const img = pop && pop.find('cl-badge-img');
  check('徽章彈窗：URL = art/badges/<slug>.png 且實檔存在', img && img.src === `art/badges/${L.slug}.png` && publicExists(img.src), img && img.src);
  check('徽章彈窗：純色圓徽底 + 名稱首字 + 金額', pop.find('cl-badge').style.background.startsWith('hsl(') && pop.find('cl-badge-char').textContent === '老' && pop.allText.includes('+NT$200'));
  img.onload();
  check('徽章圖載入後才顯示（cl-loaded）', img.classList.contains('cl-loaded'));
  check('打卡：同地標再進範圍 → null（已打卡）', ck.nearest({ x: L.x, z: L.z }) === null);
  check('打卡：重複 act() 拒絕、不重複給錢 / 事件', it.act() === false && money.calls.length === 1 && bus.of('collect:checkin').length === 1);
  check('打卡：markers 去掉已打卡（11）', ck.markers().length === 11 && !ck.markers().some((m) => m.label === L.name));
  const p = ck.progress();
  check('打卡：progress 1 / 12', p.done === 1 && p.total === 12);
  tm.advance(BADGE_SECONDS * 1000 - 10);
  check('徽章彈窗：3 s 前仍在', !!root.find('cl-badge-pop'));
  tm.advance(20);
  check('徽章彈窗：3 s 自動收', !root.find('cl-badge-pop') && tm.pending() === 0);

  // 兩地標：取最近者；存檔往返
  const L2 = lms.find((l) => l.slug === 'top_city');
  ck.nearest({ x: L2.x, z: L2.z }).act();
  tm.advance(5000);
  const saved = ck.serialize();
  check('打卡存檔：serialize → slug 陣列', Array.isArray(saved) && saved.length === 2 && saved.includes('tiger_city') && saved.includes('top_city'));
  const ck2 = createCheckins({ bus: fakeBus(), landmarks: lms, addMoney: moneySpy(), root, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  ck2.restore({ checkins: [...saved, 'tiger_city', 5, '', 'removed_landmark'] });
  check('打卡存檔：restore 往返（去重、丟非字串）', ck2.progress().done === 2 && ck2.nearest({ x: L.x, z: L.z }) === null && ck2.markers().length === 10);
  check('打卡存檔：清單外的 slug 保留不遺失', ck2.serialize().includes('removed_landmark') && ck2.serialize().length === 3);
  ck2.restore([]);
  check('打卡存檔：restore([]) 清空', ck2.progress().done === 0 && ck2.markers().length === 12);
}

// 徽章缺檔退回
{
  const root = makeDoc().body;
  const tm = fakeTimers();
  const ck = createCheckins({ landmarks: lms, addMoney: null, root, badgeBase: 'art/no-badges/', setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const L = lms.find((l) => l.slug === 'national_taichung_theater');
  const ok = ck.nearest({ x: L.x, z: L.z }).act();
  const pop = root.find('cl-badge-pop');
  const img = pop.find('cl-badge-img');
  check('徽章缺檔：URL 不存在時 onerror → 圖隱藏、純色圓徽 + 首字「臺」留著', ok && !publicExists(img.src) && (img.onerror(), img.hidden) && pop.find('cl-badge-char').textContent === '臺');
  pop.click();
  check('徽章彈窗：點擊即關', !root.find('cl-badge-pop'));
  // 無 DOM（root 無 document）也不丟例外
  const saveDoc = globalThis.document;
  globalThis.document = undefined;
  let threw = false;
  try {
    const c3 = createCheckins({ landmarks: lms, addMoney: moneySpy() });
    c3.nearest({ x: L.x, z: L.z }).act();
  } catch (e) {
    threw = true;
  }
  globalThis.document = saveDoc;
  check('打卡：無 document 時 UI no-op、不丟例外', !threw);
  const bad = createCheckins({ landmarks: [null, { slug: 'a', x: NaN, z: 0 }, { slug: 'b', x: 0, z: 0 }, { slug: 'b', x: 1, z: 1 }] });
  check('打卡：不合法 / 重複地標略過', bad.progress().total === 1);
}

// ========== 3. 小吃圖鑑 ==========
const infoBefore = infoCount;
{
  // 實檔 manifest
  const bus = fakeBus();
  const money = moneySpy();
  const tm = fakeTimers();
  const root = makeDoc().body;
  const scene = new THREE.Scene();
  const fg = createFoodGuide({ bus, scene, root, fetchJson: fsFetchJson(), addMoney: money, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  check('圖鑑：ready 前 nearest 為 null', fg.nearest({ x: FOOD_SPOTS[0].x, z: FOOD_SPOTS[0].z }) === null);
  await fg.ready;
  const items = fg.items();
  check('圖鑑實檔：manifest 12 項（slug → id、intro → desc）', fg.source() === 'manifest' && items.length === 12 && items[0].id === 'fried-noodles-chili' && items[0].desc === artManifest.items[0].intro);
  check('圖鑑實檔：圖卡 URL = art/food/<file>', items.every((it, i) => it.image === 'art/food/' + artManifest.items[i].file));
  const imgExist = items.filter((it) => publicExists(it.image)).length;
  check('圖鑑實檔：圖卡 URL 可解析（存在數記錄於此，缺者走純色卡片）', imgExist >= 0, `存在 ${imgExist} / ${items.length}`);
  const mesh = scene.getObjectByName('cl-food-icons');
  check('場景圖示：單一 InstancedMesh、每點一個 instance、有 instanceColor', mesh && mesh.isInstancedMesh && mesh.count === 12 && !!mesh.instanceColor);
  check('圖鑑：markers 12 個 kind food', fg.markers().length === 12 && fg.markers().every((m) => m.kind === 'food'));

  const S = FOOD_SPOTS[3];
  check('收集：半徑外（5 m）→ null', fg.nearest({ x: S.x + 5, z: S.z }) === null);
  const it = fg.nearest({ x: S.x + 2, z: S.z });
  check('收集：半徑內 → interactable（priority 1、提示文字）', it && it.priority === FOOD_PRIORITY && it.priority === 1 && it.text.includes('珍珠奶茶') && Math.abs(it.dist - 2) < 1e-6);
  check('收集：nearest 重用同一物件', fg.nearest({ x: S.x + 1, z: S.z }) === it);
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  const qu = new THREE.Quaternion();
  mesh.getMatrixAt(3, m);
  m.decompose(v, qu, s);
  const y0 = v.y;
  check('場景圖示：未收集時顯示在收集點上方', Math.abs(v.x - S.x) < 1e-3 && Math.abs(v.z - S.z) < 1e-3 && v.y > S.y + 1 && s.x > 0.9);
  fg.update(0.5, { x: 0, z: 0 }, null);
  mesh.getMatrixAt(3, m);
  m.decompose(v, qu, s);
  check('場景圖示：update 浮動動畫', Math.abs(v.y - y0) > 1e-4);
  check('收集：act() 成功', it.act() === true);
  check('收集：addMoney(50, food)', money.calls.length === 1 && money.calls[0].n === FOOD_REWARD && money.calls[0].n === 50 && money.calls[0].reason === 'food');
  const ev = bus.of('collect:food');
  check('收集：emit collect:food { id, name, total, found }', ev.length === 1 && ev[0].payload.id === 'bubble-tea' && ev[0].payload.name === '珍珠奶茶' && ev[0].payload.total === 12 && ev[0].payload.found === 1);
  mesh.getMatrixAt(3, m);
  m.decompose(v, qu, s);
  check('場景圖示：已收集者隱藏（縮成 0）', zeroScale(m));
  const pop = root.find('cl-food-pop');
  check('卡片彈窗：名稱 + 介紹 + 金額 + 進度', pop && pop.allText.includes('珍珠奶茶') && pop.allText.includes('+NT$50') && pop.allText.includes('1 / 12') && pop.find('cl-art-img').src === 'art/food/bubble-tea.jpg');
  check('收集：重複 act() 拒絕、nearest → null', it.act() === false && money.calls.length === 1 && fg.nearest({ x: S.x, z: S.z }) === null);
  check('收集：markers 11、progress 1 / 12', fg.markers().length === 11 && fg.progress().found === 1 && fg.progress().total === 12);

  // 卡片彈窗「查看圖鑑」→ 開面板
  pop.find('cl-pop-btn').click();
  check('卡片彈窗：查看圖鑑 → 關彈窗、開面板', !root.find('cl-food-pop') && fg.isOpen() && bus.of('ui:sound').some((e) => e.payload.kind === 'open'));
  const panel = root.find('cl-guide');
  const cards = panel.findAll('cl-card');
  const foundCards = panel.findAll('cl-found');
  const locked = panel.findAll('cl-locked');
  check('面板：12 張卡、1 張已收集、11 張剪影', cards.length === 12 && foundCards.length === 1 && locked.length === 11);
  check('面板：已收集卡顯示名稱 + 介紹 + 圖卡', foundCards[0].find('cl-card-name').textContent === '珍珠奶茶' && !!foundCards[0].find('cl-card-desc') && !!foundCards[0].find('cl-art-img'));
  check('面板：未收集卡顯示「？？？」、無介紹、無圖', locked.every((c) => c.find('cl-card-name').textContent === '？？？' && !c.find('cl-card-desc') && !c.find('cl-art-img')));
  check('面板：進度 1 / 12', panel.find('cl-guide-count').textContent === '1 / 12');
  // 開著時再收集 → 面板即時更新
  fg.nearest({ x: FOOD_SPOTS[0].x, z: FOOD_SPOTS[0].z }).act();
  check('面板：開啟中收集 → 進度即時 2 / 12', panel.find('cl-guide-count').textContent === '2 / 12' && panel.findAll('cl-found').length === 2);
  const closeBtn = panel.find('cl-close');
  check('面板：關閉鈕為 button', closeBtn && closeBtn.tagName === 'BUTTON');
  closeBtn.click();
  check('面板：關閉鈕 → 關閉 + ui:sound close', !fg.isOpen() && bus.of('ui:sound').some((e) => e.payload.kind === 'close'));
  fg.toggle();
  panel.click();
  check('面板：toggle 開、點背景關', !fg.isOpen());
  tm.advance(5000);
  check('卡片彈窗：自動收', !root.find('cl-food-pop'));

  // 存檔往返
  const saved = fg.serialize();
  check('圖鑑存檔：serialize → id 陣列', saved.length === 2 && saved.includes('bubble-tea') && saved.includes('fried-noodles-chili'));
  const scene2 = new THREE.Scene();
  const fg2 = createFoodGuide({ scene: scene2, root: makeDoc().body, fetchJson: fsFetchJson(), addMoney: moneySpy() });
  fg2.restore({ checkins: ['x'], foods: [...saved, 'bubble-tea', 3, 'old-food'] }); // ready 前 restore
  await fg2.ready;
  const mesh2 = scene2.getObjectByName('cl-food-icons');
  mesh2.getMatrixAt(3, m);
  m.decompose(v, qu, s);
  check('圖鑑存檔：ready 前 restore 往返（進度、圖示隱藏、markers）', fg2.progress().found === 2 && zeroScale(m) && fg2.markers().length === 10 && fg2.nearest({ x: S.x, z: S.z }) === null);
  check('圖鑑存檔：清單外 id 保留、去重、丟非字串', fg2.serialize().length === 3 && fg2.serialize().includes('old-food'));
  fg2.dispose();
  check('圖鑑：dispose 移除場景圖示', !scene2.getObjectByName('cl-food-icons'));
}

{
  // 404（丟例外）與 null 回傳 → 內建清單；只 info 一次
  const root = makeDoc().body;
  const fgA = createFoodGuide({ root, manifestUrl: 'art/nofood/manifest.json', fetchJson: fsFetchJson('throw') });
  const fgB = createFoodGuide({ root, manifestUrl: 'art/nofood/manifest.json', fetchJson: fsFetchJson('null') });
  await Promise.all([fgA.ready, fgB.ready]);
  check('圖鑑 404：退回內建清單（≥ 10 項、全部有名稱與介紹）', fgA.source() === 'builtin' && fgA.items().length >= 10 && fgA.items().every((it) => it.name && it.desc && it.image === null));
  check('圖鑑回 null：退回內建清單', fgB.source() === 'builtin' && fgB.progress().total === 12);
  check('圖鑑缺檔：console.info 只一次、無 console.error', infoCount - infoBefore === 1 && errorCount === 0, `info ${infoCount - infoBefore}、error ${errorCount}`);
  const tm = fakeTimers();
  const fgC = createFoodGuide({ root, manifestUrl: 'art/nofood/manifest.json', fetchJson: fsFetchJson(), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await fgC.ready;
  fgC.nearest({ x: FOOD_SPOTS[1].x, z: FOOD_SPOTS[1].z }).act();
  const pop = root.find('cl-food-pop');
  check('圖卡缺：純色卡片 + 名稱首字、無 img', pop && pop.find('cl-pop-art').style.background.startsWith('hsl(') && pop.find('cl-art-char').textContent === '大' && !pop.find('cl-art-img'));

  // 壞 JSON（fetchJson 丟 SyntaxError）
  const fgD = createFoodGuide({ root, fetchJson: async () => JSON.parse('{ bad json') });
  await fgD.ready;
  check('圖鑑壞 JSON：退回內建清單、不丟例外', fgD.source() === 'builtin' && fgD.progress().total === 12);
  const fgE = createFoodGuide({ root, fetchJson: async () => ({ items: 'nope' }) });
  await fgE.ready;
  check('圖鑑格式不符（items 非陣列）：退回內建', fgE.source() === 'builtin');

  // 頂層陣列 + 欄位別名；id 對不上收集點者依序補位
  const fgF = createFoodGuide({
    root,
    manifestUrl: 'custom/food.json',
    fetchJson: async () => [
      { slug: 'sun-cake', name: '太陽餅', description: '甲', image: 'a.png' },
      { id: 'x1', name: '自訂一', text: '乙', file: 'b.png' },
      { id: 'x2', name: '自訂二', desc: '丙' },
      { id: 'x1', name: '重複' },
      { name: '沒 id' },
    ],
  });
  await fgF.ready;
  const itF = fgF.items();
  check('圖鑑頂層陣列 + 別名（slug / description / image / text）', fgF.source() === 'manifest' && itF.length === 3 && itF[0].desc === '甲' && itF[0].image === 'custom/a.png' && itF[1].desc === '乙' && itF[2].image === null);
  const cakeSpot = FOOD_SPOTS.find((sp) => sp.food === 'sun-cake');
  const itCake = fgF.nearest({ x: cakeSpot.x, z: cakeSpot.z });
  check('圖鑑：id 相符者綁定原收集點、其餘依序補位', itCake && itCake.text.includes('太陽餅') && fgF.markers().length === 3);
  const n = normalizeFoods({ items: [{ id: 7, name: '數字 id' }] });
  check('normalizeFoods：數字 id 轉字串', n.length === 1 && n[0].id === '7');
}

// ========== 4. CSS ==========
{
  const css = fs.readFileSync(path.join(ROOT, 'src/collect/collect.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = css
    .split('}')
    .map((b) => b.split('{')[0].trim())
    .filter((sel) => sel && !sel.startsWith('@') && !/^(from|to)$/.test(sel));
  const badSel = selectors.flatMap((sel) => sel.split(',')).map((x) => x.trim()).filter((x) => x && !/^\.cl-/.test(x));
  check('CSS：選擇器全部 cl- 前綴', badSel.length === 0, badSel.join(' | '));
  check('CSS：圖鑑面板 z-index 85', /\.cl-guide\s*\{[^}]*z-index:\s*85;/.test(css));
  check('CSS：格狀 橫向 4 欄 / 直向 2 欄', /repeat\(4,/.test(css) && /@media \(orientation: portrait\)\s*\{\s*\.cl-grid\s*\{\s*grid-template-columns:\s*repeat\(2,/.test(css));
  check('CSS：關閉鈕 ≥ 44 px', /\.cl-close\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/.test(css));
  check('CSS：safe-area 內縮', /env\(safe-area-inset-top\)/.test(css) && /env\(safe-area-inset-bottom\)/.test(css));
}

console.info = origInfo;
console.error = origError;
const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
