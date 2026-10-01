#!/usr/bin/env node
// 換武器「找得到、按得動」（fix1-P2）無頭測試：不需 three
//   1. 桌機武器 HUD 顯示換武器鍵位提示（Q 循環、1/2/3 對應槽位，讀 core/actions.js ACTIONS）；觸控不顯示；駕駛中隱藏
//   2. 切換被狀態（equipping / attacking < 80% / reloading）擋下時排隊最後一次請求，可切時於 update 套用
// 用法：node tools/test/weapon-switch-hint.mjs [-v]（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）

import { register } from 'node:module';

// .css import → 空模組（hud.js 引入 weapons.css）
const HOOK = `export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// ---------- document 最小替身 ----------
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.id = '';
    this.cls = new Set();
    this.ownerDocument = globalThis.document;
    const set = this.cls;
    this.classList = {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, on) => {
        const v = on === undefined ? !set.has(c) : !!on;
        if (v) set.add(c);
        else set.delete(c);
        return v;
      },
      contains: (c) => set.has(c),
    };
  }
  get className() {
    return [...this.cls].join(' ');
  }
  set className(v) {
    this.cls.clear();
    for (const c of String(v).split(/\s+/).filter(Boolean)) this.cls.add(c);
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
  }
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  // 類 innerText：hidden / display none 的子樹不算
  visibleText() {
    if (this.hidden || this.style.display === 'none') return '';
    return this.textContent + this.children.map((c) => c.visibleText()).join('');
  }
  findClass(c) {
    if (this.cls.has(c)) return this;
    for (const k of this.children) {
      const r = k.findClass(c);
      if (r) return r;
    }
    return null;
  }
}
globalThis.document = { createElement: (tag) => new FakeEl(tag), body: null };
globalThis.document.body = new FakeEl('body');

const { ACTIONS } = await import('../../src/core/actions.js');
const { createBus } = await import('../../src/core/events.js');
const { SLOT_IDS, EQUIP_SEC, WEAPONS } = await import('../../src/weapons/defs.js');
const { createWeapons } = await import('../../src/weapons/weapons.js');
const { createWeaponHud, weaponKeyHints } = await import('../../src/weapons/hud.js');

let pass = 0;
let total = 0;
const fails = [];
const VERBOSE = process.argv.includes('-v');
function ok(cond, msg) {
  total++;
  if (VERBOSE) console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (cond) pass++;
  else fails.push(msg);
}

const FRAME = 1 / 60;
let clock = 0;
const now = () => clock;

function setup() {
  clock = 0;
  const bus = createBus();
  const equips = [];
  bus.on('weapon:equip', (e) => equips.push(e));
  const actor = { kind: 'player', pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const w = createWeapons({ bus, player: { actor, punch: () => true }, now });
  // 每幀：先處理輸入（如 main.js handleWeaponInput），再 update
  const frames = (n, each = null) => {
    for (let i = 0; i < n; i++) {
      clock += FRAME;
      if (each) each(i);
      w.update(FRAME, null);
    }
  };
  return { w, equips, frames };
}

// ---------- 1. 排隊：P0 實測情境（Q 之後 2–6 幀內按 3 / 1） ----------
{
  const { w, equips, frames } = setup();
  ok(w.cycle() === true && w.current === 'bat' && w.state === 'equipping', 'Q：空手 → 球棒（equipping）');
  frames(2);
  ok(w.select(2) === false && w.current === 'bat' && w.pending === 2, 'Q 後 2 幀按 3：不立即切、排隊手槍');
  frames(Math.ceil(EQUIP_SEC / FRAME));
  ok(w.current === 'pistol' && equips.length === 2 && equips[1].prev === 'bat', `換裝 ${EQUIP_SEC} s 結束 → 自動套用手槍`);
  ok(w.pending === -1, '套用後清空排隊');
}
{
  const { w, equips, frames } = setup();
  w.cycle();
  frames(2);
  w.select(2); // 3
  frames(4);
  w.select(0); // 1（距 Q 6 幀）：覆蓋前一個請求
  ok(w.pending === 0, '連按 3 → 1：只留最後一次（pending 0）');
  frames(30);
  ok(w.current === 'fist' && equips.length === 2, '換裝結束後只套用最後請求：空手（共 2 次 equip，3 沒被套用）');
}
{
  const { w, frames } = setup();
  w.cycle(); // fist → bat
  frames(2);
  ok(w.cycle() === false && w.pending === 2, '換裝中再按 Q：排隊下一格（手槍）');
  ok(w.cycle() === false && w.pending === 0, '再按 Q：從排隊的槽往下（空手）');
  ok(w.cycle() === false && w.pending === -1, '再按 Q 回到目前槽（球棒）→ 取消排隊');
  frames(30);
  ok(w.current === 'bat', '取消後維持球棒');
  ok(w.select(2) === true, 'idle 時按 3 立即切手槍');
  frames(2);
  w.select(0);
  ok(w.pending === 0 && w.select(2) === false && w.pending === -1, '排隊中選回目前的槽 → 取消');
  frames(30);
  ok(w.current === 'pistol', '取消後不改槽（仍為已切換的手槍）');
}

// ---------- 2. 攻擊中 < 80% 排隊、≥ 80% 套用 ----------
{
  const { w, frames } = setup();
  w.select(1);
  frames(30);
  ok(w.attack() === true && w.state === 'attacking', '揮棒 → attacking');
  frames(6);
  ok(w.select(0) === false && w.pending === 0, '揮擊初段按 1 → 排隊');
  frames(Math.round(0.4 / FRAME));
  ok(w.current === 'bat' && w.pending === 0, '揮擊 0.5 s（< 80%）仍是球棒、仍在排隊');
  frames(Math.round(0.2 / FRAME));
  ok(w.current === 'fist' && w.pending === -1, '揮擊達 80% 後自動換成空手');
}

// ---------- 3. 裝填中排隊、裝填完成後套用 ----------
{
  const { w, frames } = setup();
  w.select(2);
  frames(30);
  w.attack();
  frames(20);
  ok(w.reload() === true && w.state === 'reloading', '開 1 發後裝填');
  ok(w.select(1) === false && w.pending === 1, '裝填中按 2 → 排隊');
  frames(Math.round(1.0 / FRAME));
  ok(w.current === 'pistol' && w.state === 'reloading', '裝填未完成不打斷');
  frames(Math.round(0.5 / FRAME));
  ok(w.current === 'bat' && w.ammo().mag === WEAPONS.pistol.magSize, '裝填完成（彈匣補滿）後換成球棒');
}

// ---------- 4. 讀檔 / dispose 清空排隊 ----------
{
  const { w, frames } = setup();
  w.cycle();
  w.select(2);
  ok(w.pending === 2, '排隊中');
  w.restore({ slot: 0 });
  frames(30);
  ok(w.current === 'fist' && w.pending === -1, 'restore 清空排隊（不在讀檔後亂切）');
  w.cycle();
  w.select(2);
  w.dispose();
  ok(w.pending === -1 && w.select(0) === false, 'dispose 清空排隊、之後不再受理');
}

// ---------- 5. 桌機 HUD 鍵位提示 ----------
{
  const hints = weaponKeyHints();
  ok(hints.length === 1 + SLOT_IDS.length, `鍵位提示 ${hints.length} 項（循環 + ${SLOT_IDS.length} 槽）`);
  ok(hints[0].slot === -1 && hints[0].text.startsWith('Q ') && ACTIONS.weaponCycle.keys[0] === 'KeyQ', `循環鍵讀 ACTIONS.weaponCycle：「${hints[0].text}」`);
  ok(hints.slice(1).map((h) => h.text).join('|') === '1 空手|2 球棒|3 手槍', `直選讀 ACTIONS.slot1–3 + 武器名：${hints.slice(1).map((h) => h.text).join('、')}`);

  clock = 0;
  const root = new FakeEl('div');
  const { w, frames } = setup();
  const hud = createWeaponHud({ root, weapons: w, isTouch: false });
  hud.update(FRAME, {});
  const keys = root.findClass('wp-keys');
  ok(keys && hud.keys === keys && keys.parentNode === hud.el, '桌機：武器面板內有 .wp-keys');
  const txt = hud.el.visibleText();
  ok(/Q 換武器/.test(txt) && /1 空手/.test(txt) && /2 球棒/.test(txt) && /3 手槍/.test(txt), `桌機面板可見文字含鍵位：「${txt}」`);
  ok(keys.children.length === 4 && keys.children[1].classList.contains('wp-cur') && !keys.children[2].classList.contains('wp-cur'), '目前槽（空手）標 .wp-cur');
  w.select(2);
  frames(1);
  hud.update(FRAME, {});
  ok(keys.children[3].classList.contains('wp-cur') && !keys.children[1].classList.contains('wp-cur') && keys.children[3].style.fontWeight === 'bold', '換手槍 → .wp-cur 移到「3 手槍」');
  hud.setDriving(true);
  hud.update(FRAME, { driving: true });
  ok(keys.hidden && !/Q 換武器/.test(hud.el.visibleText()), '駕駛中隱藏鍵位提示（車上不處理武器鍵）');
  hud.setDriving(false);
  hud.update(FRAME, {});
  ok(!keys.hidden && /Q 換武器/.test(hud.el.visibleText()), '下車後恢復顯示');
  hud.dispose();
}
{
  const root = new FakeEl('div');
  const touchRoot = new FakeEl('div');
  const { w } = setup();
  const hud = createWeaponHud({ root, touchRoot, weapons: w, isTouch: true });
  hud.update(FRAME, {});
  ok(hud.keys === null && root.findClass('wp-keys') === null, '觸控：不建鍵位提示（已有 tb-weapon）');
  ok(!/Q 換武器/.test(hud.el.visibleText()) && hud.buttons.weapon, '觸控：面板無 Q / 1 / 2 / 3 文字、武器鈕存在');
  hud.dispose();
}

for (const f of fails) console.log(`  ✗ ${f}`);
console.log(fails.length ? `FAIL ${fails.length}/${total}` : `PASS ${pass}/${total}`);
process.exit(fails.length ? 1 : 0);
