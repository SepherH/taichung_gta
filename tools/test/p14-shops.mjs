#!/usr/bin/env node
// Phase 14 武器店 / 安全屋驗證：點位（osm-city.json 重驗：不壓建築、在人行道、不在車道 / 水域、在既有地標旁、與出生點步行可達）、
//   購買扣款與金錢不足、通緝拒絕、面板鍵盤操作、安全屋存檔回血清星、有星不可進入、存檔 safehouse 欄與出生點
// 用法：node tools/test/p14-shops.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 純邏輯：shops/*.js、weapons.js、economy.js、save.js、geom.js；osm-city.json 以 readFileSync 讀（不經 citymodel.js 的 JSON import）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWeapons } from '../../src/weapons/weapons.js';
import { WEAPONS } from '../../src/weapons/defs.js';
import { createEconomy } from '../../src/economy.js';
import { validateSave, defaultSave, createSaveStore } from '../../src/save.js';
import { pointInPolygon, distanceToPolygon, closestOnSegment, polygonBBox, polygonCentroid } from '../../src/geom.js';
import { GUN_SHOPS, SHOP_ITEMS, GUN_SHOP_RADIUS, GUN_SHOP_PRIORITY, REFUSE_TEXT, createGunShop, checkPurchase, ammoQuote } from '../../src/shops/gun-shop.js';
import { SAFEHOUSES, SAFEHOUSE_RADIUS, WANTED_TEXT, createSafehouses } from '../../src/shops/safehouse.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ======================= 點位（osm-city.json）=======================
const osm = JSON.parse(read('src/data/osm-city.json'));
const SPAWN = { x: 45.4, z: 26.8 }; // places.js computeSpawn（老虎城外河南路三段側人行道；2026-10 以 citymodel 實算）
const BUCKET = 20;
const buckets = new Map();
const bkey = (i, j) => `${i},${j}`;
const blds = osm.B.map((b) => ({ id: b.i, name: b.n || '', poly: b.p, bbox: polygonBBox(b.p) }));
for (const b of blds) {
  for (let i = Math.floor(b.bbox.x0 / BUCKET); i <= Math.floor(b.bbox.x1 / BUCKET); i++) {
    for (let j = Math.floor(b.bbox.z0 / BUCKET); j <= Math.floor(b.bbox.z1 / BUCKET); j++) {
      const k = bkey(i, j);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(b);
    }
  }
}
// 建築內或離輪廓 < pad
function inBuilding(x, z, pad = 0) {
  const seen = new Set();
  for (let i = Math.floor((x - pad) / BUCKET); i <= Math.floor((x + pad) / BUCKET); i++) {
    for (let j = Math.floor((z - pad) / BUCKET); j <= Math.floor((z + pad) / BUCKET); j++) {
      for (const b of buckets.get(bkey(i, j)) || []) {
        if (seen.has(b)) continue;
        seen.add(b);
        if (x < b.bbox.x0 - pad || x > b.bbox.x1 + pad || z < b.bbox.z0 - pad || z > b.bbox.z1 + pad) continue;
        if (pointInPolygon(x, z, b.poly)) return true;
        if (pad > 0 && distanceToPolygon(x, z, b.poly) < pad) return true;
      }
    }
  }
  return false;
}
const inWater = (x, z) => osm.W.some((w) => pointInPolygon(x, z, w.p));
const seg = { x: 0, z: 0, d2: 0, t: 0 };
// 最近道路（R，地面層）：{ road, dist（離中心線）, hw }
function nearestRoad(x, z) {
  let best = null;
  for (const r of osm.R) {
    if (r.ly && r.ly < 0) continue;
    const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      closestOnSegment(x, z, p[i], p[i + 1], p[i + 2], p[i + 3], seg);
      const d = Math.sqrt(seg.d2);
      if (!best || d - r.w / 2 < best.dist - best.hw) best = { road: r, dist: d, hw: r.w / 2 };
    }
  }
  return best;
}
const places = [...GUN_SHOPS.map((s) => ({ ...s, kind: 'gun' })), ...SAFEHOUSES.map((s) => ({ ...s, kind: 'safe' }))];
check('武器店：七期 1–2 間、id 唯一、座標有限', GUN_SHOPS.length >= 1 && GUN_SHOPS.length <= 2 && new Set(GUN_SHOPS.map((s) => s.id)).size === GUN_SHOPS.length && GUN_SHOPS.every((s) => Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.yaw)));
check('安全屋：1 間', SAFEHOUSES.length === 1 && Number.isFinite(SAFEHOUSES[0].x));
const b = osm.bounds;
for (const p of places) {
  const nr = nearestRoad(p.x, p.z);
  const curb = nr.dist - nr.hw;
  check(`點位 ${p.id}：不壓建築（輪廓外 ≥ 1.5 m）`, !inBuilding(p.x, p.z, 1.5));
  check(`點位 ${p.id}：人行道（離最近道路路緣 0.8–6 m，不在車道）`, curb >= 0.8 && curb <= 6, `${nr.road.n || '無名路'} 路緣外 ${curb.toFixed(2)} m`);
  check(`點位 ${p.id}：不在水域、在地圖界內`, !inWater(p.x, p.z) && p.x > b.x0 + 20 && p.x < b.x1 - 20 && p.z > b.z0 + 20 && p.z < b.z1 - 20);
  check(`點位 ${p.id}：互動半徑內（${p.kind === 'gun' ? GUN_SHOP_RADIUS : SAFEHOUSE_RADIUS} m）也不壓建築`, [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
    const a = (k * Math.PI) / 4;
    const r = p.kind === 'gun' ? GUN_SHOP_RADIUS : SAFEHOUSE_RADIUS;
    return !inBuilding(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 0.3);
  }));
}
// 地標：武器店在既有具名地標輪廓 15 m 內（且 landmark 名稱對得上）
for (const s of GUN_SHOPS) {
  const lm = blds.find((x) => x.name === s.landmark);
  const d = lm ? distanceToPolygon(s.x, s.z, lm.poly) : Infinity;
  check(`武器店 ${s.id}：在地標「${s.landmark}」旁（輪廓 3–15 m）`, !!lm && d >= 3 && d <= 15, `${d.toFixed(1)} m`);
  const c = lm ? polygonCentroid(lm.poly) : { x: 0, z: 0 };
  check(`武器店 ${s.id}：離地標中心 ≥ 25 m（不與地標打卡半徑重疊）`, Math.hypot(s.x - c.x, s.z - c.z) >= 25);
}
// 與其他互動點保持距離（超商 / 噴漆廠 / 醫院 / 警局 / 競速起點 / 泊車亭 / 出生點）
{
  const placesSrc = read('src/wanted/places.js');
  const others = [...placesSrc.matchAll(/x: (-?[\d.]+),\s*\n\s*z: (-?[\d.]+),/g)].map((m) => ({ x: +m[1], z: +m[2] }));
  const raceSrc = read('src/missions/race.js');
  for (const m of raceSrc.matchAll(/start: \{ name: '[^']+', x: (-?[\d.]+), z: (-?[\d.]+)/g)) others.push({ x: +m[1], z: +m[2] });
  others.push(SPAWN);
  const minD = Math.min(...places.flatMap((p) => others.map((o) => Math.hypot(p.x - o.x, p.z - o.z))));
  check('點位：離超商 / 噴漆廠 / 醫院 / 警局 / 競速起點 / 出生點都 ≥ 22 m（互動不重疊）', others.length >= 10 && minD >= 22, `最近 ${minD.toFixed(1)} m（${others.length} 點）`);
  const pair = Math.min(...places.flatMap((p, i) => places.slice(i + 1).map((q) => Math.hypot(p.x - q.x, p.z - q.z))));
  check('點位：武器店 / 安全屋彼此相距 ≥ 50 m', pair >= 50, `${pair.toFixed(1)} m`);
}
// 步行可達：1 m 格點自出生點泛洪（擋：建築輪廓 0.3 m 內、水域），每個點位都要連通
{
  const xs = [SPAWN.x, ...places.map((p) => p.x)];
  const zs = [SPAWN.z, ...places.map((p) => p.z)];
  const x0 = Math.floor(Math.min(...xs) - 60);
  const z0 = Math.floor(Math.min(...zs) - 60);
  const W = Math.ceil(Math.max(...xs) + 60) - x0;
  const H = Math.ceil(Math.max(...zs) + 60) - z0;
  const blocked = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = x0 + i + 0.5;
    const z = z0 + j + 0.5;
    if (inBuilding(x, z, 0.3) || inWater(x, z)) blocked[j * W + i] = 1;
  }
  const seen = new Uint8Array(W * H);
  const cell = (x, z) => Math.floor(z - z0) * W + Math.floor(x - x0);
  const q = new Int32Array(W * H);
  let qh = 0;
  let qt = 0;
  const s0 = cell(SPAWN.x, SPAWN.z);
  check('步行可達：出生點格可走', !blocked[s0]);
  seen[s0] = 1;
  q[qt++] = s0;
  while (qh < qt) {
    const c = q[qh++];
    const i = c % W;
    const j = (c - i) / W;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const n = nj * W + ni;
      if (seen[n] || blocked[n]) continue;
      seen[n] = 1;
      q[qt++] = n;
    }
  }
  let nBlocked = 0;
  for (let k = 0; k < blocked.length; k++) nBlocked += blocked[k];
  check('步行可達：格點區域含建築阻擋（泛洪有效）', nBlocked > W * H * 0.05 && qt < W * H - nBlocked + 1, `${W}×${H}、阻擋 ${nBlocked}、可達 ${qt}`);
  for (const p of places) check(`步行可達：${p.id} 與出生點連通（1 m 格點、避開建築與水域）`, !!seen[cell(p.x, p.z)]);
  const sh = SAFEHOUSES[0];
  const ds = Math.hypot(sh.x - SPAWN.x, sh.z - SPAWN.z);
  check('安全屋靠近出生點（≤ 120 m）', ds <= 120, `${ds.toFixed(1)} m`);
}

// ======================= 武器店：購買 =======================
function mkFakeDoc() {
  const mk = (tag) => {
    const e = {
      tag, children: [], parentNode: null, hidden: false, textContent: '', className: '', style: {}, dataset: {}, attrs: {}, listeners: {}, type: '',
      classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
      append(...cs) { for (const c of cs) e.appendChild(c); },
      removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; },
      setAttribute(k, v) { e.attrs[k] = v; },
      addEventListener(t, fn) { (e.listeners[t] ||= []).push(fn); },
      focus() { doc.activeElement = e; },
      click(detail) { for (const fn of e.listeners.click || []) fn({ stopPropagation() {}, ...(detail === undefined ? {} : { detail }) }); },
    };
    return e;
  };
  const doc = { createElement: mk, body: null, activeElement: null, defaultView: null };
  doc.body = mk('body');
  return doc;
}
function mkKeyTarget() {
  const fns = { keydown: [], keyup: [] };
  return {
    addEventListener: (t, fn) => (fns[t] ||= []).push(fn),
    removeEventListener: (t, fn) => {
      const l = fns[t] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    key(code, type = 'keydown') {
      const e = { code, repeat: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
      for (const fn of [...(fns[type] || [])]) fn(e);
      return e;
    },
    get count() { return Object.values(fns).reduce((a, l) => a + l.length, 0); },
  };
}
function mkShop({ money = 10000, stars = 0, doc = null } = {}) {
  const bus = createBus();
  const events = [];
  for (const n of ['shop:open', 'shop:close', 'shop:refused', 'shop:purchase', 'player:money', 'weapon:acquire']) bus.on(n, (e) => events.push({ n, e }));
  const player = { actor: { id: 'p', kind: 'player', pos: { x: 0, y: 0, z: 0 }, yaw: 0 } };
  const weapons = createWeapons({ bus, player });
  const economy = createEconomy({ bus, initial: { money } });
  const world = { stars };
  const toasts = [];
  const beaconLog = [];
  const beacons = { acquire: (kind, x, z) => (beaconLog.push({ kind, x, z }), { kind }), release() {}, update() {} };
  const keys = mkKeyTarget();
  const shop = createGunShop({
    bus, weapons, getMoney: () => economy.money, spend: (n, r) => economy.spend(n, r), getStars: () => world.stars,
    beacons, toast: (t) => toasts.push(t), doc, keyTarget: doc ? keys : null,
  });
  return { bus, events, weapons, economy, world, toasts, beaconLog, shop, keys, doc };
}
{
  const s = mkShop({ money: 3000 });
  const S0 = GUN_SHOPS[0];
  check('武器店：門口光柱 kind gunshop（每間一根、在店門口）', s.beaconLog.length === GUN_SHOPS.length && s.beaconLog.every((b, i) => b.kind === 'gunshop' && b.x === GUN_SHOPS[i].x && b.z === GUN_SHOPS[i].z));
  const mk = s.shop.markers();
  check('武器店：小地圖 / 大地圖標記 kind gun-shop', mk.length === GUN_SHOPS.length && mk.every((m) => m.kind === 'gun-shop') && s.shop.markers() === mk);
  check('武器店：nearest 只在互動半徑內、priority 2、重用物件', s.shop.nearest({ x: S0.x + 1, z: S0.z }) !== null && s.shop.nearest({ x: S0.x + GUN_SHOP_RADIUS + 0.5, z: S0.z }) === null && s.shop.nearest({ x: S0.x, z: S0.z }).priority === GUN_SHOP_PRIORITY && s.shop.nearest({ x: S0.x, z: S0.z }) === s.shop.nearest({ x: S0.x + 0.5, z: S0.z }));
  const it = s.shop.nearest({ x: S0.x, z: S0.z });
  check('武器店：互動 act → 開面板、shop:open', it.act() === true && s.shop.isOpen() && s.events.some((x) => x.n === 'shop:open' && x.e.shop === S0.id));
  const r1 = s.shop.buy('smg');
  check('購買 smg NT$2500：扣款 3000 → 500、取得衝鋒槍、shop:purchase', r1.ok && s.economy.money === 500 && s.weapons.owns('smg') && s.events.some((x) => x.n === 'shop:purchase' && x.e.item === 'smg' && x.e.price === 2500));
  check('購買：economy reason gunshop（player:money delta −2500）', s.events.some((x) => x.n === 'player:money' && x.e.delta === -2500 && x.e.reason === 'gunshop'));
  const r2 = s.shop.buy('shotgun');
  check('購買 shotgun NT$3500 金錢不足：拒絕、不扣款、提示差額', !r2.ok && r2.reason === 'money' && s.economy.money === 500 && !s.weapons.owns('shotgun') && r2.text.includes('還差 NT$3,000'), r2.text);
  const r3 = s.shop.buy('smg');
  check('購買：已擁有的 smg → owned、不扣款', !r3.ok && r3.reason === 'owned' && s.economy.money === 500);
  const r4 = s.shop.buy('ammo-shotgun');
  check('購買彈藥：沒有散彈槍 → notOwned', !r4.ok && r4.reason === 'notOwned');
  const before = s.weapons.ammo('smg').reserve;
  const r5 = s.shop.buy('ammo-smg');
  check(`購買衝鋒槍彈藥 NT$${WEAPONS.smg.ammoPrice}：+${WEAPONS.smg.ammoPack} 發、扣款`, r5.ok && s.weapons.ammo('smg').reserve === before + WEAPONS.smg.ammoPack && s.economy.money === 500 - WEAPONS.smg.ammoPrice);
  s.weapons.addAmmo(9999, 'smg');
  const r6 = s.shop.buy('ammo-smg');
  check('購買彈藥：備彈已滿 → full、不扣款', !r6.ok && r6.reason === 'full' && s.economy.money === 500 - WEAPONS.smg.ammoPrice);
  s.shop.close();
  check('關閉：shop:close、isOpen false；關閉後 buy → closed', !s.shop.isOpen() && s.events.some((x) => x.n === 'shop:close') && s.shop.buy('ammo-smg').reason === 'closed');
  check('品項價格：smg 2500、shotgun 3500、彈藥各自價格', SHOP_ITEMS.find((i) => i.id === 'smg').price === 2500 && SHOP_ITEMS.find((i) => i.id === 'shotgun').price === 3500 && SHOP_ITEMS.find((i) => i.id === 'ammo-smg').price === WEAPONS.smg.ammoPrice && SHOP_ITEMS.find((i) => i.id === 'ammo-shotgun').price === WEAPONS.shotgun.ammoPrice);
}
// P14 審查修正：備彈將滿時按實際可加入的量計價（不收整盒錢只加部分）
{
  const s = mkShop({ money: 10000 });
  s.shop.open(GUN_SHOPS[0].id);
  s.shop.buy('smg');
  s.shop.buy('shotgun');
  s.weapons.addAmmo(WEAPONS.smg.reserveMax - WEAPONS.smg.startReserve - 1, 'smg'); // 299 / 300
  const m0 = s.economy.money;
  const r = s.shop.buy('ammo-smg');
  const ev = s.events.filter((x) => x.n === 'shop:purchase' && x.e.item === 'ammo-smg').pop();
  const want = Math.ceil(WEAPONS.smg.ammoPrice / WEAPONS.smg.ammoPack);
  check('備彈 299 / 300 買衝鋒槍彈藥：只加 1 發、按比例收費（不收整盒）、shop:purchase price / amount 為實收', r.ok && s.weapons.ammo('smg').reserve === WEAPONS.smg.reserveMax && m0 - s.economy.money === want && ev && ev.e.price === want && ev.e.amount === 1, `扣 ${m0 - s.economy.money}`);
  s.weapons.addAmmo(WEAPONS.shotgun.reserveMax - WEAPONS.shotgun.startReserve - 5, 'shotgun'); // 55 / 60
  const m1 = s.economy.money;
  const r2 = s.shop.buy('ammo-shotgun');
  check('備彈 55 / 60 買散彈槍彈藥：只加 5 發、收 ceil(400 × 5 / 12)', r2.ok && s.weapons.ammo('shotgun').reserve === WEAPONS.shotgun.reserveMax && m1 - s.economy.money === Math.ceil((WEAPONS.shotgun.ammoPrice * 5) / WEAPONS.shotgun.ammoPack), `扣 ${m1 - s.economy.money}`);
  const q = ammoQuote(SHOP_ITEMS.find((i) => i.id === 'ammo-smg'), 0);
  check('ammoQuote：空間足夠 → 整盒原價；已滿 → amount 0', q.amount === WEAPONS.smg.ammoPack && q.price === WEAPONS.smg.ammoPrice && ammoQuote(SHOP_ITEMS.find((i) => i.id === 'ammo-smg'), WEAPONS.smg.reserveMax).amount === 0);
}
// 通緝拒絕
{
  const s = mkShop({ money: 99999, stars: 2 });
  const ok = s.shop.open(GUN_SHOPS[0].id);
  check('通緝中：店家拒絕交易（不開面板、toast、shop:refused wanted）', ok === false && !s.shop.isOpen() && s.toasts.includes(REFUSE_TEXT) && s.events.some((x) => x.n === 'shop:refused' && x.e.reason === 'wanted'));
  s.world.stars = 0;
  s.shop.open(GUN_SHOPS[0].id);
  s.world.stars = 1;
  const r = s.shop.buy('smg');
  check('通緝中：面板已開也拒絕購買、不扣款', !r.ok && r.reason === 'wanted' && s.economy.money === 99999 && !s.weapons.owns('smg'));
  check('checkPurchase：stars 優先於其他理由', checkPurchase(SHOP_ITEMS[0], { money: 0, stars: 1, owns: () => true, ammo: () => ({ reserve: 0 }) }).reason === 'wanted');
}
// 面板（DOM 替身）鍵盤 / 手把操作
{
  const doc = mkFakeDoc();
  const s = mkShop({ money: 5900, doc });
  const panel = s.shop.el;
  check('面板：沿用委託面板樣式（ms-panel / ms-card / ms-btn）、預設隱藏', !!panel && panel.className.includes('ms-panel') && panel.hidden === true && JSON.stringify(panel.children[0].className).includes('ms-card'));
  s.shop.open(GUN_SHOPS[1].id);
  check('面板：開啟顯示店名與現金、焦點在第一項', panel.hidden === false && s.shop.focus === 0 && JSON.stringify(collectText(panel)).includes(GUN_SHOPS[1].name) && JSON.stringify(collectText(panel)).includes('NT$5,900'));
  s.keys.key('ArrowDown');
  check('鍵盤 / 手把：↓ 移到第二項（散彈槍）', s.shop.focus === 1);
  const e = s.keys.key('Enter');
  check('鍵盤 / 手把：Enter（手把 A）購買焦點品項 → 散彈槍 NT$3500', e.prevented && s.weapons.owns('shotgun') && s.economy.money === 2400);
  s.keys.key('KeyE');
  check('鍵盤：E 不購買（進店互動鍵連按不誤買）', s.economy.money === 2400);
  // P14 審查修正：Space 只觸發一次購買（keydown 購買；keyup 攔下；鍵盤合成的 click（detail 0）不受理）
  s.keys.key('ArrowDown');
  s.keys.key('ArrowDown'); // 焦點 1 → 3（散彈槍彈藥 NT$400）
  const btn = panel.children[0].children[0].children[3].children[3];
  const ms = s.economy.money;
  s.keys.key('Space');
  const up = s.keys.key('Space', 'keyup');
  btn.click(0);
  check('鍵盤：Space 在按鈕上只購買一次（keyup 攔下、合成 click 不重複扣款）', up.prevented && ms - s.economy.money === WEAPONS.shotgun.ammoPrice, `扣 ${ms - s.economy.money}`);
  const mc = s.economy.money;
  btn.click(1);
  btn.click(1);
  btn.click(2);
  check('滑鼠 / 觸控：連點只購買一次（防連點）', mc - s.economy.money === WEAPONS.shotgun.ammoPrice, `扣 ${mc - s.economy.money}`);
  check('滑鼠 / 觸控：點按鈕後焦點 = 該品項索引（之後鍵盤 ↑↓ 從這裡移動）', s.shop.focus === 3, `${s.shop.focus}`);
  s.keys.key('ArrowUp');
  s.keys.key('ArrowUp'); // 焦點回 1（散彈槍），下方再 ↑ 到衝鋒槍
  const mPoor = s.economy.money;
  s.keys.key('ArrowUp');
  s.keys.key('Enter');
  check('鍵盤：再選衝鋒槍錢不足 → 不扣款、訊息列提示', s.economy.money === mPoor && !s.weapons.owns('smg') && JSON.stringify(collectText(panel)).includes('錢不夠'));
  s.keys.key('Escape');
  check('鍵盤 / 手把：Esc（手把 B）關閉面板', !s.shop.isOpen() && panel.hidden === true);
  const k2 = s.keys.key('ArrowDown');
  check('面板關閉時不攔截按鍵', !k2.prevented);
  s.shop.dispose();
  check('dispose：移除鍵盤監聽與面板', s.keys.count === 0 && !doc.body.children.includes(panel));
}
function collectText(e, out = []) {
  if (e.textContent) out.push(e.textContent);
  for (const c of e.children || []) collectText(c, out);
  return out;
}

// ======================= 安全屋 =======================
function mkSafe({ stars = 0, busy = null } = {}) {
  const bus = createBus();
  const events = [];
  bus.on('safehouse:enter', (e) => events.push({ n: 'enter', e }));
  bus.on('safehouse:refused', (e) => events.push({ n: 'refused', e }));
  const player = { hp: 30, maxHp: 100 };
  const world = { stars, cleared: 0, saves: [] };
  const toasts = [];
  const beaconLog = [];
  const storage = new Map();
  const store = createSaveStore({ storage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) } });
  let sh = null;
  sh = createSafehouses({
    bus,
    getStars: () => world.stars,
    beacons: { acquire: (kind, x, z) => (beaconLog.push({ kind, x, z }), {}), release() {}, update() {} },
    save: () => {
      const data = { ...defaultSave(), player: { x: 1, z: 2, yaw: 0 }, safehouse: sh.serialize() };
      world.saves.push(data);
      return store.save(data);
    },
    heal: () => {
      player.hp = player.maxHp;
    },
    clearWanted: () => {
      world.cleared++;
      world.stars = 0;
    },
    toast: (t) => toasts.push(t),
    busy,
  });
  return { sh, events, player, world, toasts, beaconLog, store };
}
{
  const H = SAFEHOUSES[0];
  const s = mkSafe();
  check('安全屋：門口光柱 kind safehouse、標記 kind safehouse', s.beaconLog.length === 1 && s.beaconLog[0].kind === 'safehouse' && s.sh.markers()[0].kind === 'safehouse');
  check('安全屋：nearest 半徑內才有、priority 2', s.sh.nearest({ x: H.x + 1, z: H.z }) !== null && s.sh.nearest({ x: H.x + SAFEHOUSE_RADIUS + 0.5, z: H.z }) === null && s.sh.nearest({ x: H.x, z: H.z }).priority === 2);
  const r = s.sh.nearest({ x: H.x, z: H.z }).act();
  check('安全屋進入：回滿血', r === true && s.player.hp === 100);
  check('安全屋進入：通緝清零（clearWanted 呼叫）', s.world.cleared === 1);
  check('安全屋進入：存檔（存檔內容帶 safehouse.last）', s.world.saves.length === 1 && s.world.saves[0].safehouse && s.world.saves[0].safehouse.last === H.id);
  const loaded = s.store.load();
  check('安全屋進入：存檔可讀回 safehouse.last、事件 safehouse:enter saved', loaded.status === 'ok' && loaded.data.safehouse.last === H.id && s.events.some((x) => x.n === 'enter' && x.e.saved === true));
  check('安全屋：lastUsed / serialize', s.sh.lastUsed === H.id && s.sh.serialize().last === H.id);

  const w = mkSafe({ stars: 3 });
  const rr = w.sh.enter(H.id);
  check('有星不可進入：refused wanted、提示先甩掉警察、不回血不存檔不清星', !rr.ok && rr.reason === 'wanted' && w.toasts.includes(WANTED_TEXT) && WANTED_TEXT.includes('甩掉警察') && w.player.hp === 30 && w.world.saves.length === 0 && w.world.cleared === 0 && w.world.stars === 3);
  const bz = mkSafe({ busy: () => '搶劫進行中，不能進安全屋' });
  check('busy（搶劫中）不可進入', bz.sh.enter(H.id).reason === 'busy' && bz.world.saves.length === 0);
  check('未知安全屋 id → unknown', s.sh.enter('nope').reason === 'unknown');
}
// 存檔欄位與出生點
{
  const H = SAFEHOUSES[0];
  check('存檔：defaultSave 不含 safehouse（舊存檔相容）', !('safehouse' in defaultSave()));
  check('存檔清洗：safehouse { last } 保留、非法格式整欄丟棄', validateSave({ version: 2, safehouse: { last: H.id } }).safehouse.last === H.id && !('safehouse' in validateSave({ version: 2, safehouse: { last: 5 } })) && !('safehouse' in validateSave({ version: 2, safehouse: 'x' })) && !('safehouse' in validateSave({ version: 2, safehouse: { last: 'a b<script>' } })));
  const s = mkSafe();
  const sp = s.sh.spawnPoint({ last: H.id });
  check('出生點：存檔有 safehouse.last → 安全屋門口（x / z / yaw）', sp && sp.x === H.x && sp.z === H.z && sp.yaw === H.yaw);
  check('出生點：舊存檔（無 safehouse）/ 未知 id → null（沿用存檔位置）', s.sh.spawnPoint(null) === null && s.sh.spawnPoint({ last: 'gone' }) === null);
  check('restore：已知 id 記為 lastUsed、未知 → null', s.sh.restore({ last: H.id }) === H.id && s.sh.restore({ last: 'gone' }) === null && s.sh.restore(undefined) === null);
  // 往返：安全屋存檔 → load → spawnPoint
  const st = s.store;
  st.save({ ...defaultSave(), safehouse: { last: H.id } });
  const r = st.load();
  check('出生點：存讀往返後 spawnPoint 指向安全屋', r.status === 'ok' && s.sh.spawnPoint(r.data.safehouse).id === H.id);
  const mainSrc = read('src/main.js');
  check('main.js：placePlayer 以 safehouses.spawnPoint(save.safehouse) 取代存檔位置（仍經 validSavedPosition）', /const home = safehouses\.spawnPoint\(save\.safehouse \|\| null\);\s*\n\s*const p = home \? \{ x: home\.x, z: home\.z, yaw: home\.yaw \} : save\.player;\s*\n\s*const ok = validSavedPosition\(p,/.test(mainSrc));
}
// 光柱顏色 / 標記色碼
{
  const lp = read('src/missions/light-pillar.js');
  check('光柱顏色：武器店紅 #e53935、安全屋藍 #1e88e5', /gunshop: 0xe53935/.test(lp) && /safehouse: 0x1e88e5/.test(lp));
  const hud = read('src/hud.js');
  const big = read('src/map/big-map.js');
  check('小地圖 / 大地圖：gun-shop / safehouse 圖示與圖例', hud.includes("'gun-shop': '槍'") && hud.includes("safehouse: '家'") && big.includes("'gun-shop': '武器店'") && big.includes("safehouse: '安全屋'"));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
