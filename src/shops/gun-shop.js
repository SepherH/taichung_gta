// 武器店（Phase 14）：七期 2 間，門口紅色小光柱（BEACON_COLORS.gunshop #e53935）+ 小地圖 / 大地圖 kind 'gun-shop'
// 步行進入 GUN_SHOP_RADIUS 內按互動鍵（E / 手把 B / tb-interact）開購買面板：衝鋒槍 NT$2,500、散彈槍 NT$3,500、兩種彈藥（價格見 defs）；
//   有通緝星數 → 店家拒絕交易（不開面板，toast REFUSE_TEXT；面板開著時購買也一律拒絕）；金錢不足 → 面板訊息列提示差額、不扣款
// 純邏輯不 import three：光柱池（missions/light-pillar.js createBeaconPool）、經濟、通緝、武器、toast 由整合層注入；doc 省略 = 無面板（node 測試）
//
// 點位（座標 = 世界座標 X 東、Z 南，m；yaw 前方 = (sin yaw, cos yaw)，面向道路）：取 src/data/osm-city.json 既有地標旁的人行道——
//   沿最近道路中心線往地標側退到路緣外 2.5 m，且「離建築輪廓 ≥ 1.5 m、不在車道（0.8 m 餘裕）、不在水域、離路口 ≥ 14 m、
//   離地標輪廓 3–14 m、離地標中心 ≥ 28 m（避開打卡 25 m 半徑）、離既有超商 / 噴漆廠 / 醫院 / 警局 / 競速起點 / 泊車亭 / 出生點 ≥ 25 m」；
//   tools/test/p14-shops.mjs 以 osm-city.json 重驗（不壓建築、在人行道、與出生點之間步行可達）
//   - gunshop-ntc：B 482673864 NTC國家商貿中心｜R 市政北二路（路寬 8 m）北側人行道
//   - gunshop-skm：B 148849083 新光三越｜R 惠來路二段（路寬 12.8 m）東側人行道
//
// createGunShop({ bus?, weapons, getMoney() → number, spend(n, reason) → boolean, getStars() → number, beacons?, toast?(text, sec),
//   doc?（DOM document；省略 = 無面板）, root?（面板掛載點，預設 doc.body）, keyTarget?（鍵盤監聽目標，預設 window；手把合成鍵送 window）,
//   shops = GUN_SHOPS, items = SHOP_ITEMS, clockMs?() → 毫秒（防連點計時，預設 performance.now）})
//   → { shops, items, nearest(pos) → interactable|null, open(shopId) → boolean, close(), isOpen(), current（開著的店）,
//       buy(itemId) → { ok, reason, text }, check(itemId) → { ok, reason, text }, focus（面板焦點索引）, moveFocus(d), activate(),
//       update(dt), markers() → [{ x, z, kind: 'gun-shop', label }], cancel(), dispose() }
//   interactable：{ id: 'gunshop:<id>', text, dist, priority: GUN_SHOP_PRIORITY, act() }（act = open）
//   reason：'wanted'（通緝中）| 'owned'（已擁有）| 'notOwned'（買彈藥但沒槍）| 'full'（備彈已滿）| 'money'（錢不夠）| 'closed' | 'unknown'
//   彈藥：備彈將滿（剩餘空間 < 一盒）時只賣放得下的發數、按比例收費（ammoQuote，無條件進位到元）；按鈕價格、扣款、shop:purchase price 皆為實收
// 面板（DOM，沿用委託面板 ms-panel / ms-card / ms-btn 樣式）：品項按鈕列 + 訊息列 + 「離開」；鍵盤 ↑ / ↓ 移焦點、Enter / 空白 = 購買（焦點在
//   「離開」= 關閉）、Esc = 關閉；手把在面板開啟時（input 停用）由 gamepad.js 送合成 Arrow / Enter / Escape，同一套處理；觸控直接點按鈕
//   單一觸發路徑：鍵盤只走 keydown（onKey），keyup 的 Space / Enter 一併攔下，按鈕 click 不受理鍵盤合成的 click（detail 0）；
//   滑鼠 / 觸控 click 另有防連點（detail > 1 的連點、CLICK_GUARD_MS 內的第二下不受理）
// 事件（bus）：shop:open { shop } / shop:close { shop } / shop:refused { shop, reason } / shop:purchase { shop, item, weapon, kind, price, amount? }
// 每幀（update / nearest / markers）不配置新物件（interactable 與 markers 陣列重用）
import { WEAPONS } from '../weapons/defs.js';

export const GUN_SHOP_RADIUS = 2.5; // 互動半徑（m）：門口光柱周圍
export const GUN_SHOP_PRIORITY = 2; // interactable 仲裁級別（同打卡；委託 3 優先，同級取近）
export const GUN_SHOP_BEACON = { height: 7, radius: 0.7, sink: 1 }; // 門口小光柱（同超商尺寸；顏色 BEACON_COLORS.gunshop）
export const REFUSE_TEXT = '老闆：「你被通緝了，先把條子甩掉再來！」';
export const PROMPT_TEXT = '按 E 進武器店';
export const CLICK_GUARD_MS = 300; // 品項按鈕防連點：前一次受理後此時間內的 click 不受理

export const GUN_SHOPS = Object.freeze([
  Object.freeze({ id: 'gunshop-ntc', name: '七期槍械行（NTC 商貿中心）', x: -120.6, z: 50.7, yaw: -0.564, landmark: 'NTC國家商貿中心', road: '市政北二路' }),
  Object.freeze({ id: 'gunshop-skm', name: '惠來槍械行（新光三越）', x: 530.4, z: -50.7, yaw: -2.13, landmark: '新光三越', road: '惠來路二段' }),
]);

export const SHOP_ITEMS = Object.freeze([
  Object.freeze({ id: 'smg', kind: 'weapon', weapon: 'smg', label: WEAPONS.smg.label, price: WEAPONS.smg.price, desc: `全自動、彈匣 ${WEAPONS.smg.magSize}（附 ${WEAPONS.smg.startReserve} 發）` }),
  Object.freeze({ id: 'shotgun', kind: 'weapon', weapon: 'shotgun', label: WEAPONS.shotgun.label, price: WEAPONS.shotgun.price, desc: `泵動、${WEAPONS.shotgun.pellets} 顆彈丸、彈匣 ${WEAPONS.shotgun.magSize}（附 ${WEAPONS.shotgun.startReserve} 發）` }),
  Object.freeze({ id: 'ammo-smg', kind: 'ammo', weapon: 'smg', label: `${WEAPONS.smg.label}彈藥`, amount: WEAPONS.smg.ammoPack, price: WEAPONS.smg.ammoPrice, desc: `${WEAPONS.smg.ammoPack} 發` }),
  Object.freeze({ id: 'ammo-shotgun', kind: 'ammo', weapon: 'shotgun', label: `${WEAPONS.shotgun.label}彈藥`, amount: WEAPONS.shotgun.ammoPack, price: WEAPONS.shotgun.ammoPrice, desc: `${WEAPONS.shotgun.ammoPack} 發` }),
]);

export function formatNT(n) {
  const v = Math.round(Number(n) || 0);
  return `NT$${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

// 彈藥報價（純函式）：備彈剩餘空間不足一盒 → 只賣放得下的發數、按比例收費（進位到元）；回 { amount, price }（amount 0 = 已滿）
export function ammoQuote(item, reserve) {
  const room = Math.max(0, WEAPONS[item.weapon].reserveMax - (Number(reserve) || 0));
  const amount = Math.min(item.amount, Math.floor(room));
  return { amount, price: amount >= item.amount ? item.price : Math.ceil((item.price * amount) / item.amount) };
}

// 購買資格（純函式）：ctx = { money, stars, owns(id), ammo(id) → { reserve } }；回 { ok, reason, text, price（實收）, amount?（彈藥實際發數）}
export function checkPurchase(item, ctx) {
  if (!item) return { ok: false, reason: 'unknown', text: '沒有這個品項' };
  if (ctx.stars > 0) return { ok: false, reason: 'wanted', text: REFUSE_TEXT };
  const owns = ctx.owns(item.weapon);
  if (item.kind === 'weapon' && owns) return { ok: false, reason: 'owned', text: `你已經有${item.label}了` };
  let price = item.price;
  let amount;
  if (item.kind === 'ammo') {
    if (!owns) return { ok: false, reason: 'notOwned', text: `要先買${WEAPONS[item.weapon].label}` };
    const q = ammoQuote(item, ctx.ammo(item.weapon).reserve);
    if (q.amount <= 0) return { ok: false, reason: 'full', text: '備彈已滿' };
    price = q.price;
    amount = q.amount;
  }
  if (!(ctx.money >= price)) return { ok: false, reason: 'money', text: `錢不夠：${item.label} ${formatNT(price)}（還差 ${formatNT(price - (ctx.money || 0))}）`, price, amount };
  return { ok: true, reason: null, text: '', price, amount };
}

export function createGunShop({
  bus = null,
  weapons,
  getMoney = () => 0,
  spend = () => false,
  getStars = () => 0,
  beacons = null,
  toast = null,
  doc = null,
  root = null,
  keyTarget = null,
  shops = GUN_SHOPS,
  items = SHOP_ITEMS,
  clockMs = () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
} = {}) {
  const emit = (n, p) => {
    if (bus) bus.emit(n, p);
  };
  const say = (text, sec = 3) => {
    if (toast && text) toast(text, sec);
  };
  let disposed = false;
  let openShop = null;
  let focus = 0;
  let lastClickAt = -Infinity; // 防連點：上一次受理品項 click 的時刻（毫秒）

  // 光柱：每間店一根，常駐（店不會關門）
  const pillars = beacons ? shops.map((s) => beacons.acquire('gunshop', s.x, s.z, s)) : [];
  const markerList = shops.map((s) => ({ x: s.x, z: s.z, kind: 'gun-shop', label: s.name }));
  const inter = { id: '', text: PROMPT_TEXT, dist: 0, priority: GUN_SHOP_PRIORITY, act: null, shop: null };
  inter.act = () => (inter.shop ? open(inter.shop.id) : false);

  const ctx = { money: 0, stars: 0, owns: (id) => !!(weapons && weapons.owns && weapons.owns(id)), ammo: (id) => weapons.ammo(id) };
  const fillCtx = () => {
    ctx.money = Number(getMoney()) || 0;
    ctx.stars = Number(getStars()) || 0;
    return ctx;
  };

  // ---------- 面板（DOM） ----------
  const ui = doc && typeof doc.createElement === 'function' ? buildPanel() : null;

  function buildPanel() {
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const panel = el('div', 'ms-panel gs-panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.dataset.mode = 'shop';
    const card = el('div', 'ms-card gs-card');
    const body = el('div', 'ms-card-body');
    const kicker = el('div', 'ms-kicker', '武器店');
    const title = el('h2', 'ms-card-title', '');
    const money = el('div', 'ms-card-client gs-money', '');
    const list = el('div', 'ms-stats gs-items');
    const buttons = items.map((it, idx) => {
      const b = el('button', 'ms-btn gs-item');
      b.type = 'button';
      b.dataset.item = it.id;
      Object.assign(b.style, { display: 'flex', justifyContent: 'space-between', gap: '12px', width: '100%', marginTop: '6px' });
      const name = el('span', 'gs-item-name', `${it.label}（${it.desc}）`);
      const price = el('span', 'gs-item-price', formatNT(it.price));
      b.append(name, price);
      b.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        // 鍵盤合成的 click（detail 0）已由 onKey 處理；連點（detail > 1 或 CLICK_GUARD_MS 內）不重複購買
        if (e && typeof e.detail === 'number' && e.detail !== 1) return;
        const now = clockMs();
        if (now - lastClickAt < CLICK_GUARD_MS) return;
        lastClickAt = now;
        focus = idx; // buttons 是 { b, price, it } 陣列，不能用 indexOf(b)
        buy(it.id);
      });
      list.appendChild(b);
      return { b, price, it };
    });
    const msg = el('p', 'ms-card-brief gs-msg', '');
    const actions = el('div', 'ms-actions');
    const leave = el('button', 'ms-btn ms-btn-ghost gs-leave', '離開（Esc）');
    leave.type = 'button';
    leave.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      close();
    });
    actions.appendChild(leave);
    body.append(kicker, title, money, list, msg, actions);
    card.appendChild(body);
    panel.appendChild(card);
    (root || doc.body).appendChild(panel);
    const focusables = [...buttons.map((x) => x.b), leave];
    return { panel, title, money, msg, buttons, leave, focusables };
  }

  function refresh(message = null) {
    if (!ui || !openShop) return;
    fillCtx();
    ui.title.textContent = openShop.name;
    ui.money.textContent = `現金 ${formatNT(ctx.money)}`;
    for (const { b, price, it } of ui.buttons) {
      const r = checkPurchase(it, ctx);
      const owned = it.kind === 'weapon' && r.reason === 'owned';
      price.textContent = owned ? '已擁有' : it.kind === 'ammo' && r.reason === 'notOwned' ? '需先買槍' : it.kind === 'ammo' && r.reason === 'full' ? '已滿' : formatNT(r.price !== undefined ? r.price : it.price);
      b.classList.toggle('ms-btn-primary', r.ok);
      b.setAttribute('aria-disabled', r.ok ? 'false' : 'true');
    }
    if (message !== null) ui.msg.textContent = message;
    ui.msg.hidden = !ui.msg.textContent;
    const f = ui.focusables[focus];
    if (f && f.focus) f.focus();
  }

  function moveFocus(d) {
    const n = ui ? ui.focusables.length : items.length + 1;
    focus = (((focus + d) % n) + n) % n;
    if (ui) {
      const f = ui.focusables[focus];
      if (f && f.focus) f.focus();
    }
    return focus;
  }

  // 焦點項目執行：品項 = 購買、「離開」= 關閉
  function activate() {
    if (!openShop) return null;
    if (focus >= items.length) {
      close();
      return null;
    }
    return buy(items[focus].id);
  }

  // keyup：Space / Enter 一律攔下（原生 <button> 的 Space 在 keyup 才派 click，避免與 keydown 的 activate 重複購買）
  function onKeyUp(e) {
    if (!openShop || !e) return;
    const code = e.code || e.key;
    if (code !== 'Enter' && code !== 'NumpadEnter' && code !== 'Space') return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onKey(e) {
    if (!openShop || !e || e.repeat) return;
    const code = e.code || e.key;
    let handled = true;
    if (code === 'ArrowUp' || code === 'ArrowLeft') moveFocus(-1);
    else if (code === 'ArrowDown' || code === 'ArrowRight') moveFocus(1);
    else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') activate(); // 不收 E：進店的互動鍵連按不會誤買
    else if (code === 'Escape' || code === 'Esc') close();
    else handled = false;
    if (!handled) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  const keyHost = keyTarget || (ui ? doc.defaultView || globalThis.window || doc : null);
  if (keyHost && keyHost.addEventListener) {
    keyHost.addEventListener('keydown', onKey, true);
    keyHost.addEventListener('keyup', onKeyUp, true);
  }

  // ---------- 邏輯 ----------
  function open(shopId) {
    if (disposed) return false;
    const s = shops.find((x) => x.id === shopId);
    if (!s) return false;
    if ((Number(getStars()) || 0) > 0) {
      say(REFUSE_TEXT, 3);
      emit('shop:refused', { shop: s.id, reason: 'wanted' });
      return false;
    }
    openShop = s;
    focus = 0;
    if (ui) {
      ui.msg.textContent = '';
      ui.panel.hidden = false;
      refresh();
    }
    emit('shop:open', { shop: s.id });
    return true;
  }

  function close() {
    if (!openShop) return;
    const id = openShop.id;
    openShop = null;
    if (ui) ui.panel.hidden = true;
    emit('shop:close', { shop: id });
  }

  function check(itemId) {
    const it = items.find((x) => x.id === itemId);
    return checkPurchase(it, fillCtx());
  }

  function buy(itemId) {
    if (!openShop) return { ok: false, reason: 'closed', text: '' };
    const it = items.find((x) => x.id === itemId);
    const r = checkPurchase(it, fillCtx());
    if (!r.ok) {
      refresh(r.text);
      if (r.reason === 'wanted') emit('shop:refused', { shop: openShop.id, reason: 'wanted' });
      return r;
    }
    const price = r.price;
    if (!spend(price, 'gunshop')) {
      const fail = { ok: false, reason: 'money', text: `錢不夠：${it.label} ${formatNT(price)}` };
      refresh(fail.text);
      return fail;
    }
    let amount;
    if (it.kind === 'weapon') weapons.give(it.weapon);
    else amount = weapons.addAmmo(r.amount, it.weapon); // 只加報價的發數（備彈將滿時 < 一盒，已按比例收費）
    emit('shop:purchase', { shop: openShop.id, item: it.id, weapon: it.weapon, kind: it.kind, price, amount });
    const text = it.kind === 'weapon' ? `買到${it.label}！（按 ${WEAPONS[it.weapon].slot + 1} 或 Q 切換）` : `補充${it.label} ×${amount}`;
    refresh(text);
    return { ok: true, reason: null, text };
  }

  function nearest(pos) {
    if (disposed || !pos) return null;
    let best = null;
    let bestD = GUN_SHOP_RADIUS;
    for (const s of shops) {
      const d = Math.hypot(pos.x - s.x, pos.z - s.z);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return null;
    inter.id = `gunshop:${best.id}`;
    inter.dist = bestD;
    inter.shop = best;
    return inter;
  }

  function update(dt) {
    if (disposed) return;
    if (beacons && beacons.update) beacons.update(dt);
  }

  const markers = () => markerList;

  // 回主選單 / 開新局：無聲關面板（不發 shop:close 以外的事件）
  function cancel() {
    close();
  }

  function dispose() {
    close();
    disposed = true;
    if (keyHost && keyHost.removeEventListener) {
      keyHost.removeEventListener('keydown', onKey, true);
      keyHost.removeEventListener('keyup', onKeyUp, true);
    }
    if (beacons) for (const b of pillars) beacons.release(b);
    if (ui && ui.panel.parentNode) ui.panel.parentNode.removeChild(ui.panel);
  }

  return {
    shops,
    items,
    nearest,
    open,
    close,
    isOpen: () => openShop !== null,
    get current() {
      return openShop;
    },
    get focus() {
      return focus;
    },
    moveFocus,
    activate,
    check,
    buy,
    update,
    markers,
    cancel,
    dispose,
    el: ui ? ui.panel : null,
  };
}
