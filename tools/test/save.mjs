#!/usr/bin/env node
// B2 存檔與經濟無頭驗證：假 storage（含會丟 QuotaExceeded 的版本）、假 bus、注入 now / rng
// 用法：node tools/test/save.mjs（任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n）
// 項目：load 狀態 new / ok / recovered / corrupt-reset / incompatible、.bak / .corrupt 內容（corrupt-reset 清掉壞槽）、save 失敗回 false、
//   validateSave 清洗（NaN、負數、未知鍵、缺鍵）、autosave 時序與例外、economy 事件計數 / 金錢 / 醫藥費 / dispose
// D4-0（schema v2，契約 §18）：v1 舊檔升版不遺失、v2 欄位非法值清洗、陣列去重與上限、備份 / 損毀流程在 v2 下照常
import { register } from 'node:module';

const JSON_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(JSON_HOOK)}`, import.meta.url);

// document 最小替身（本測試不畫圖，比照其他測試保留）
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), style: {} }) };

const { SAVE_VERSION, defaultSave, validateSave, migrate, createSaveStore, createAutosave } = await import('../../src/save.js');
const { createEconomy } = await import('../../src/economy.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 假 storage：Map 實作；quota = true 時 setItem 丟 QuotaExceededError
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  const s = {
    quota: false,
    writes: 0,
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (s.quota) {
        const e = new Error('空間不足');
        e.name = 'QuotaExceededError';
        throw e;
      }
      s.writes++;
      m.set(k, String(v));
    },
    removeItem: (k) => { m.delete(k); },
  };
  return s;
}
// 假 bus：on → off
function fakeBus() {
  const map = new Map();
  const log = [];
  return {
    log,
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name).delete(fn);
    },
    emit(name, payload) {
      log.push({ name, payload });
      for (const fn of [...(map.get(name) || [])]) fn(payload);
    },
    count: (name) => (map.get(name) ? map.get(name).size : 0),
  };
}

const K = 'tcgta.save';
const good = () => ({ ...defaultSave(), money: 1234, player: { x: -120.5, z: 88, yaw: 1.2 }, world: { hour: 8 } });

// ---------- defaultSave / migrate ----------
{
  const d = defaultSave();
  check('defaultSave 版本 / 起始金錢 / 時間 / 位置 null', d.version === 2 && SAVE_VERSION === 2 && d.money === 500 && d.world.hour === 16.5 && d.player.x === null && d.player.z === null);
  check('defaultSave 統計 13 欄皆 0（v1 十欄 + missionsDone / missionsFailed / shotsFired）', Object.keys(d.stats).length === 13 && Object.values(d.stats).every((v) => v === 0) && ['missionsDone', 'missionsFailed', 'shotsFired'].every((k) => k in d.stats));
  check(
    'defaultSave v2 欄位',
    JSON.stringify(d.weapons) === JSON.stringify({ slot: 0, ammo: { pistol: { mag: 12, reserve: 36 } } }) &&
      JSON.stringify(d.missions) === JSON.stringify({ completed: {}, best: {}, cooldowns: {}, active: null }) &&
      JSON.stringify(d.collect) === JSON.stringify({ checkins: [], foods: [] }),
  );
  check('defaultSave 每次回新物件（含巢狀）', defaultSave() !== defaultSave() && defaultSave().stats !== d.stats && defaultSave().weapons.ammo.pistol !== d.weapons.ammo.pistol && defaultSave().collect.checkins !== d.collect.checkins);
  check('migrate：version 3 → null、version 0 / 1 → 2、非物件 → null', migrate({ version: 3 }) === null && migrate({ version: 0 }).version === 2 && migrate({ version: 1 }).version === 2 && migrate('x') === null && migrate([]) === null);
}

// ---------- validateSave 清洗 ----------
{
  const v = validateSave({
    version: 1, savedAt: -5, money: NaN, hacker: true,
    stats: { playTimeSec: -1, distWalkM: 12.5, pedsHit: 3.7, carjacks: Infinity, extra: 9 },
    player: { x: 10, z: NaN, yaw: 'a', god: 1 },
    world: { hour: 30, weather: 'rain' },
  });
  check('validate：NaN 金錢 → 預設 500、負 savedAt → 0', v && v.money === 500 && v.savedAt === 0);
  check('validate：未知鍵丟棄（頂層 / stats / player / world）', v && !('hacker' in v) && !('extra' in v.stats) && !('god' in v.player) && !('weather' in v.world));
  check('validate：負數 / Infinity 統計 → 0、計數取整數、距離保留小數', v && v.stats.playTimeSec === 0 && v.stats.carjacks === 0 && v.stats.pedsHit === 3 && v.stats.distWalkM === 12.5);
  check('validate：缺鍵補預設（stats 其餘欄位）', v && Object.keys(v.stats).length === 13 && v.stats.kos === 0 && v.stats.shotsFired === 0);
  check('validate：x / z 不成對有效 → 皆 null、非數 yaw → 0', v && v.player.x === null && v.player.z === null && v.player.yaw === 0);
  check('validate：hour 30 → 6（mod 24）', v && v.world.hour === 6);
  const empty = validateSave({ version: 1 });
  check('validate：只有 version → 完整預設', JSON.stringify(empty) === JSON.stringify(defaultSave()));
  check('validate：非物件 / 陣列 / null / 較新版本 → null', validateSave(null) === null && validateSave(5) === null && validateSave([1]) === null && validateSave({ version: 9 }) === null);
  const neg = validateSave({ version: 1, money: -50, player: { x: -3, z: -4, yaw: -1 } });
  check('validate：負金錢 → 預設、負座標 / 負 yaw 保留', neg.money === 500 && neg.player.x === -3 && neg.player.z === -4 && neg.player.yaw === -1);
  check('validate：金錢小數取整', validateSave({ version: 1, money: 99.9 }).money === 99);
}

// ---------- load 狀態 ----------
{
  // new
  const s = fakeStorage();
  const st = createSaveStore({ storage: s, now: () => 1000 });
  const r = st.load();
  check('load：空 storage → new + 預設', r.status === 'new' && r.data.money === 500);
  check('hasSave：空 → false', st.hasSave() === false);

  // save + ok + .bak
  check('save：成功回 true', st.save(good()) === true);
  const saved = JSON.parse(s.getItem(K));
  check('save：savedAt 用注入 now', saved.savedAt === 1000 && saved.money === 1234);
  check('hasSave：存後 → true', st.hasSave() === true);
  const st2 = createSaveStore({ storage: s, now: () => 2000 });
  const r2 = st2.load();
  check('load：有效主鍵 → ok 且資料一致', r2.status === 'ok' && r2.data.money === 1234 && r2.data.player.x === -120.5 && r2.data.world.hour === 8);
  check('load ok：主鍵複製到 .bak', s.getItem(K + '.bak') !== null && JSON.parse(s.getItem(K + '.bak')).money === 1234);

  // recovered：主鍵 parse 失敗 → 讀 .bak，損毀原文寫 .corrupt
  s.setItem(K, '{壞掉的 json');
  const r3 = createSaveStore({ storage: s }).load();
  check('load：主鍵 parse 失敗 + .bak 有效 → recovered', r3.status === 'recovered' && r3.data.money === 1234);
  check('recovered：損毀原文寫入 .corrupt', s.getItem(K + '.corrupt') === '{壞掉的 json');

  // recovered：主鍵驗證失敗（非物件）
  s.setItem(K, '[1,2,3]');
  const r4 = createSaveStore({ storage: s }).load();
  check('load：主鍵驗證失敗（陣列）+ .bak 有效 → recovered', r4.status === 'recovered' && s.getItem(K + '.corrupt') === '[1,2,3]');

  // corrupt-reset：主鍵與 .bak 都壞
  s.setItem(K, 'garbage');
  s.setItem(K + '.bak', 'null');
  const r5 = createSaveStore({ storage: s }).load();
  check('load：主鍵與 .bak 皆壞 → corrupt-reset + 預設', r5.status === 'corrupt-reset' && r5.data.money === 500);
  check('corrupt-reset：.corrupt 只保留最後一份（主鍵原文）', s.getItem(K + '.corrupt') === 'garbage');
  check('corrupt-reset：壞掉的主鍵與 .bak 已清掉、hasSave → false', s.getItem(K) === null && s.getItem(K + '.bak') === null && createSaveStore({ storage: s }).hasSave() === false);
  check('corrupt-reset 後再讀 → new（不重複報損毀）、.corrupt 仍保留原文', createSaveStore({ storage: s }).load().status === 'new' && s.getItem(K + '.corrupt') === 'garbage');
  const st5 = createSaveStore({ storage: s, now: () => 3000 });
  st5.load();
  const saved5 = st5.save(good());
  const r5b = createSaveStore({ storage: s }).load();
  check('corrupt-reset 後 save 成功 → 下次讀 ok、.bak 為新存檔（不會被壞 .bak 蓋回）', saved5 && r5b.status === 'ok' && r5b.data.money === 1234 && JSON.parse(s.getItem(K + '.bak')).money === 1234);

  // corrupt-reset：主鍵不存在、只有壞 .bak → 原文寫 .corrupt、.bak 清掉
  const s7 = fakeStorage({ [K + '.bak']: '{壞備份' });
  const r7 = createSaveStore({ storage: s7 }).load();
  check('load：主鍵不存在 + .bak 壞 → corrupt-reset、.corrupt = 備份原文、.bak 清掉', r7.status === 'corrupt-reset' && s7.getItem(K + '.corrupt') === '{壞備份' && s7.getItem(K + '.bak') === null);

  // 主鍵不存在但 .bak 有效 → recovered
  const s6 = fakeStorage({ [K + '.bak']: JSON.stringify(good()) });
  check('load：主鍵不存在 + .bak 有效 → recovered', createSaveStore({ storage: s6 }).load().status === 'recovered');
}

// ---------- incompatible ----------
{
  const newer = JSON.stringify({ version: 3, money: 99999 });
  const s = fakeStorage({ [K]: newer });
  const st = createSaveStore({ storage: s, now: () => 5 });
  const r = st.load();
  check('load：version > SAVE_VERSION → incompatible + 預設資料', r.status === 'incompatible' && r.data.money === 500);
  check('incompatible：save() 回 false 且不覆寫', st.save(good()) === false && s.getItem(K) === newer);
  check('incompatible：不寫 .bak / .corrupt', s.getItem(K + '.bak') === null && s.getItem(K + '.corrupt') === null);
  check('incompatible：hasSave → false', st.hasSave() === false);
  st.clear();
  check('clear 後：主鍵移除、save() 恢復可寫', s.getItem(K) === null && st.save(good()) === true && JSON.parse(s.getItem(K)).money === 1234);
}

// ---------- schema v2（§18）：v1 升版 / 清洗 / 去重上限 / 備份流程 ----------
{
  // 典型 v1 舊檔（Phase 3 main.js 存的形狀）
  const v1 = {
    version: 1, savedAt: 123456, money: 4321,
    stats: { playTimeSec: 3600.5, distWalkM: 812.25, distDriveM: 15000.75, pedsHit: 7, pedsKnockedOut: 11, carjacks: 3, crashes: 9, kos: 2, moneyEarned: 5000, moneySpent: 1179 },
    player: { x: -210.5, z: 333.25, yaw: -2.5 },
    world: { hour: 21.75 },
  };
  const m = migrate(v1);
  check('migrate v1 → v2：version 2、v1 各欄原值保留', m.version === 2 && m.money === 4321 && m.savedAt === 123456 && m.player === v1.player && m.world === v1.world && m.stats.distDriveM === 15000.75);
  check('migrate v1 → v2：補 weapons / missions / collect 與三個新統計', m.weapons.slot === 0 && m.weapons.ammo.pistol.mag === 12 && m.missions.active === null && Array.isArray(m.collect.foods) && m.stats.missionsDone === 0 && m.stats.shotsFired === 0);
  check('migrate 不改動輸入物件', v1.version === 1 && !('weapons' in v1) && !('missionsDone' in v1.stats));
  const v = validateSave(v1);
  const v1Keys = Object.keys(v1.stats);
  check('validate v1 舊檔：金錢 / 時間 / 位置 / 十項統計全部保留', v.version === 2 && v.money === 4321 && v.savedAt === 123456 && v.player.x === -210.5 && v.player.z === 333.25 && v.player.yaw === -2.5 && v.world.hour === 21.75 && v1Keys.every((k) => v.stats[k] === v1.stats[k]));
  check('validate v1 舊檔：v2 欄位為預設', JSON.stringify({ w: v.weapons, m: v.missions, c: v.collect }) === JSON.stringify({ w: defaultSave().weapons, m: defaultSave().missions, c: defaultSave().collect }));
  // 版本標 1 但已帶 v2 欄位（整合層尚未改 version 時）：遷移不蓋掉既有值
  const mixed = validateSave({ version: 1, weapons: { slot: 2, ammo: { pistol: { mag: 5, reserve: 80 } } }, stats: { shotsFired: 40 }, collect: { checkins: ['tiger_city'] } });
  check('version 1 但已帶 v2 欄位 → 保留（不以預設覆蓋）', mixed.weapons.slot === 2 && mixed.weapons.ammo.pistol.mag === 5 && mixed.weapons.ammo.pistol.reserve === 80 && mixed.stats.shotsFired === 40 && mixed.collect.checkins.join() === 'tiger_city');
  check('無 version 的物件視為 v2 清洗', validateSave({ money: 10 }).version === 2 && validateSave({ money: 10 }).weapons.slot === 0);

  // 非法值清洗
  const bad = validateSave({
    version: 2,
    stats: { missionsDone: 3.9, missionsFailed: -1, shotsFired: NaN },
    weapons: { slot: 3, ammo: { pistol: { mag: 99, reserve: 500 }, rifle: { mag: 30 } }, extra: 1 },
    missions: {
      completed: { tiger_city: 2.7, bad_neg: -1, bad_nan: NaN, bad_str: '3', __proto__: 5, '': 1 },
      best: { tiger_city: 87.25, bad: Infinity },
      cooldowns: { top_city: 45.5, x: null },
      active: { slug: 'tiger_city', stage: 'deliver', timer: 30 },
      junk: true,
    },
    collect: { checkins: ['a', 'b', 'a', 5, null, '', 'c', { x: 1 }], foods: 'not-array' },
  });
  check('validate v2：新統計取整、負數 / NaN → 0', bad.stats.missionsDone === 3 && bad.stats.missionsFailed === 0 && bad.stats.shotsFired === 0);
  check('validate v2：weapons.slot 不在 {0,1,2} → 0；未知鍵丟棄', bad.weapons.slot === 0 && !('extra' in bad.weapons) && !('rifle' in bad.weapons.ammo));
  check('validate v2：mag > 12 → 12、reserve > 120 → 120', bad.weapons.ammo.pistol.mag === 12 && bad.weapons.ammo.pistol.reserve === 120);
  const neg = validateSave({ version: 2, weapons: { slot: 1, ammo: { pistol: { mag: -3, reserve: 7.8 } } } });
  check('validate v2：負 mag → 預設 12、reserve 小數取整、slot 1 保留', neg.weapons.slot === 1 && neg.weapons.ammo.pistol.mag === 12 && neg.weapons.ammo.pistol.reserve === 7);
  check('validate v2：slot 非整數 / 字串 → 0', validateSave({ version: 2, weapons: { slot: 1.5 } }).weapons.slot === 0 && validateSave({ version: 2, weapons: { slot: '2' } }).weapons.slot === 0);
  check('validate v2：completed 只收字串鍵 → 非負整數（非法值的鍵丟棄）', JSON.stringify(bad.missions.completed) === JSON.stringify({ tiger_city: 2 }), JSON.stringify(bad.missions.completed));
  check('validate v2：best / cooldowns 保留小數、非有限數 / null 丟棄', JSON.stringify(bad.missions.best) === '{"tiger_city":87.25}' && JSON.stringify(bad.missions.cooldowns) === '{"top_city":45.5}');
  check('validate v2：missions 未知鍵丟棄、active 只留 { slug, stage }', !('junk' in bad.missions) && JSON.stringify(bad.missions.active) === '{"slug":"tiger_city","stage":"deliver"}');
  const act = (a) => validateSave({ version: 2, missions: { active: a } }).missions.active;
  check('validate v2：active 非法（缺 slug / 空 slug / 未知 stage / 陣列 / 字串）→ null', [{ stage: 'pickup' }, { slug: '', stage: 'pickup' }, { slug: 'x', stage: 'fly' }, ['x'], 'x', 5].every((a) => act(a) === null) && act({ slug: 'x', stage: 'pickup' }).stage === 'pickup');
  check('validate v2：missions 表非物件（陣列 / 字串）→ {}', JSON.stringify(validateSave({ version: 2, missions: { completed: [1, 2], best: 'x', cooldowns: null } }).missions) === JSON.stringify(defaultSave().missions));
  check('validate v2：checkins 只收非空字串、去重保序', bad.collect.checkins.join(',') === 'a,b,c', bad.collect.checkins.join(','));
  check('validate v2：foods 非陣列 → []', Array.isArray(bad.collect.foods) && bad.collect.foods.length === 0);
  const many = Array.from({ length: 450 }, (_, i) => `id${i % 300}`);
  const capped = validateSave({ version: 2, collect: { checkins: many, foods: many } });
  check('validate v2：陣列去重後上限 200（保留前 200 個）', capped.collect.checkins.length === 200 && capped.collect.foods.length === 200 && capped.collect.checkins[0] === 'id0' && capped.collect.checkins[199] === 'id199');
  const bigMap = {};
  for (let i = 0; i < 300; i++) bigMap[`m${i}`] = i;
  check('validate v2：completed 鍵數上限 200', Object.keys(validateSave({ version: 2, missions: { completed: bigMap } }).missions.completed).length === 200);
  check('validate v2：清洗結果可 JSON 來回不變', JSON.stringify(validateSave(JSON.parse(JSON.stringify(bad)))) === JSON.stringify(bad));
  check('validate v2：clean 後 missions 表原型正常（__proto__ 未污染）', Object.getPrototypeOf(bad.missions.completed) === Object.prototype && !Object.prototype.hasOwnProperty.call(bad.missions.completed, '__proto__'));
  // JSON 文字中的 __proto__ 鍵（JSON.parse 會產生自有屬性）
  const protoText = validateSave(JSON.parse('{"version":2,"missions":{"completed":{"__proto__":{"x":1},"ok":1}}}'));
  check('validate v2：JSON 文字 __proto__ 鍵被丟棄', JSON.stringify(protoText.missions.completed) === '{"ok":1}' && ({}).x === undefined);

  // store：v1 舊檔 load → ok（升版）→ save 寫 v2；v2 資料來回
  const s = fakeStorage({ [K]: JSON.stringify(v1) });
  const st = createSaveStore({ storage: s, now: () => 9000 });
  const r = st.load();
  check('load v1 舊檔 → ok、資料升為 v2 且不遺失', r.status === 'ok' && r.data.version === 2 && r.data.money === 4321 && r.data.stats.carjacks === 3 && r.data.player.x === -210.5 && r.data.weapons.ammo.pistol.reserve === 36);
  check('load v1 舊檔：.bak 寫入升版後的 v2', JSON.parse(s.getItem(K + '.bak')).version === 2 && JSON.parse(s.getItem(K + '.bak')).money === 4321);
  check('load v1 舊檔：主鍵在 save 前不被改寫', JSON.parse(s.getItem(K)).version === 1);
  const d2 = { ...r.data, weapons: { slot: 2, ammo: { pistol: { mag: 4, reserve: 60 } } }, missions: { completed: { tiger_city: 1 }, best: { tiger_city: 70.5 }, cooldowns: {}, active: { slug: 'top_city', stage: 'pickup' } }, collect: { checkins: ['tiger_city', 'top_city'], foods: ['bubble_tea'] } };
  check('save v2 → true、主鍵為 v2', st.save(d2) === true && JSON.parse(s.getItem(K)).version === 2);
  const r2 = createSaveStore({ storage: s }).load();
  check('v2 存讀來回一致（weapons / missions / collect）', r2.status === 'ok' && r2.data.weapons.slot === 2 && r2.data.weapons.ammo.pistol.mag === 4 && r2.data.missions.best.tiger_city === 70.5 && r2.data.missions.active.slug === 'top_city' && r2.data.collect.checkins.join() === 'tiger_city,top_city' && r2.data.collect.foods.join() === 'bubble_tea' && r2.data.money === 4321);
  // 備份 / 損毀：v2 主檔壞 → 從 v2 .bak 救回
  s.setItem(K, '{v2 壞掉');
  const r3 = createSaveStore({ storage: s }).load();
  check('v2：主鍵壞 + .bak 有效 → recovered、v2 欄位完整', r3.status === 'recovered' && r3.data.weapons.slot === 2 && r3.data.collect.checkins.length === 2 && s.getItem(K + '.corrupt') === '{v2 壞掉');
  // 主鍵壞 + .bak 為 v1 舊檔 → recovered 並升版
  const s4 = fakeStorage({ [K]: 'xx', [K + '.bak']: JSON.stringify(v1) });
  const r4 = createSaveStore({ storage: s4 }).load();
  check('v2：主鍵壞 + .bak 為 v1 → recovered 且升版不遺失', r4.status === 'recovered' && r4.data.version === 2 && r4.data.money === 4321 && r4.data.stats.kos === 2);
  // 兩者皆壞 → corrupt-reset（v2 預設）
  const s5 = fakeStorage({ [K]: 'bad', [K + '.bak']: '[]' });
  const r5 = createSaveStore({ storage: s5 }).load();
  check('v2：主鍵與 .bak 皆壞 → corrupt-reset、預設為 v2', r5.status === 'corrupt-reset' && r5.data.version === 2 && r5.data.weapons.ammo.pistol.mag === 12 && s5.getItem(K) === null && s5.getItem(K + '.bak') === null && s5.getItem(K + '.corrupt') === 'bad');
  // version 3 → incompatible、不覆寫；.bak 為 v3 時同樣 incompatible
  const s6 = fakeStorage({ [K]: JSON.stringify({ version: 3, money: 1 }) });
  const st6 = createSaveStore({ storage: s6 });
  check('v2：主鍵 version 3 → incompatible、save 不覆寫', st6.load().status === 'incompatible' && st6.save(d2) === false && JSON.parse(s6.getItem(K)).version === 3);
  const s7 = fakeStorage({ [K]: 'bad', [K + '.bak']: JSON.stringify({ version: 3 }) });
  check('v2：主鍵壞 + .bak version 3 → incompatible', createSaveStore({ storage: s7 }).load().status === 'incompatible');
  // economy 以 validateSave 初始化：新統計欄位經 economy.snapshot 仍保留
  const eco = createEconomy({ initial: { money: 10, stats: { ...defaultSave().stats, missionsDone: 4, shotsFired: 9 } } });
  check('economy.snapshot 保留 v2 新統計（missionsDone / shotsFired）', eco.snapshot().stats.missionsDone === 4 && eco.snapshot().stats.shotsFired === 9);
}

// ---------- save 失敗 ----------
{
  const s = fakeStorage();
  const st = createSaveStore({ storage: s });
  s.quota = true;
  let threw = false;
  let ok;
  try { ok = st.save(good()); } catch (e) { threw = true; }
  check('save：QuotaExceeded → 回 false、不丟例外', ok === false && !threw);
  s.quota = false;
  check('save：非法資料（非物件）→ false', st.save('x') === false && st.save(null) === false);
  const broken = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('x'); } };
  let threw2 = false;
  let r;
  try {
    const bs = createSaveStore({ storage: broken });
    r = bs.load();
    bs.save(good());
    bs.clear();
    bs.hasSave();
  } catch (e) { threw2 = true; }
  check('storage 全部丟例外 → 不外拋、load 視為 new', !threw2 && r.status === 'new');
  const mem = createSaveStore({ now: () => 7 });
  check('未注入 storage（node 無 localStorage）→ 記憶體可存讀', mem.save(good()) === true && mem.load().status === 'ok');
}

// ---------- autosave ----------
{
  const s = fakeStorage();
  let n = 0;
  let money = 500;
  const store = createSaveStore({ storage: s, now: () => ++n });
  const saves = [];
  const wrapped = { save: (d) => { saves.push(d.money); return store.save(d); } };
  const auto = createAutosave({ store: wrapped, getState: () => ({ ...defaultSave(), money }), intervalSec: 15 });
  let t = 0;
  for (let i = 0; i < 60 * 14; i++) { auto.tick(1 / 60); t += 1 / 60; }
  check('autosave：14 s 內不存', saves.length === 0);
  for (let i = 0; i < 60 * 2; i++) auto.tick(1 / 60);
  check('autosave：累計滿 15 s 存 1 次', saves.length === 1);
  for (let i = 0; i < 60 * 30; i++) auto.tick(1 / 60);
  check('autosave：再 30 s 共存 3 次（每 15 s 一次）', saves.length === 3, `次數 ${saves.length}`);
  money = 777;
  check('flush：立即存且回 true', auto.flush('pause') === true && saves.length === 4 && JSON.parse(s.getItem(K)).money === 777 && auto.lastReason === 'pause');
  for (let i = 0; i < 60 * 14; i++) auto.tick(1 / 60);
  check('flush 後計時歸零（14 s 內不再存）', saves.length === 4);
  auto.tick(NaN); auto.tick(-5);
  check('tick 非法 dt 忽略', saves.length === 4);

  let boom = true;
  const saves2 = [];
  const auto2 = createAutosave({ store: { save: (d) => { saves2.push(d); return true; } }, getState: () => { if (boom) throw new Error('狀態未就緒'); return defaultSave(); }, intervalSec: 1 });
  const origErr = console.error;
  console.error = () => {};
  let threw = false;
  let r1;
  let r2;
  try { r1 = auto2.tick(1.5); r2 = auto2.flush('hide'); } catch (e) { threw = true; }
  console.error = origErr;
  check('getState 丟例外：不存、不中斷、回 false', !threw && r1 === false && r2 === false && saves2.length === 0);
  boom = false;
  auto2.tick(1.2);
  check('getState 恢復後照常存', saves2.length === 1);

  s.quota = true;
  check('autosave：storage 滿時 flush 回 false 不丟例外', auto.flush('quota') === false);
}

// ---------- economy ----------
{
  const bus = fakeBus();
  const rolls = [0, 0.999999, 0.5];
  let ri = 0;
  const eco = createEconomy({ bus, initial: { money: 500, stats: defaultSave().stats }, rng: () => rolls[ri++ % rolls.length] });
  check('economy：起始 NT$500、統計 0', eco.money === 500 && eco.stats.pedsHit === 0);

  bus.emit('ped:knockdown', { ped: {}, cause: 'vehicle', byPlayer: true, x: 0, z: 0 });
  bus.emit('ped:knockdown', { ped: {}, cause: 'vehicle', byPlayer: false, x: 0, z: 0 });
  check('ped:knockdown vehicle（byPlayer）→ pedsHit +1、非玩家不計、不掉錢', eco.stats.pedsHit === 1 && eco.money === 500);

  bus.emit('ped:knockdown', { ped: {}, cause: 'punch', byPlayer: true, x: 0, z: 0 });
  bus.emit('ped:knockdown', { ped: {}, cause: 'punch', byPlayer: true, x: 0, z: 0 });
  bus.emit('ped:knockdown', { ped: {}, cause: 'punch', byPlayer: true, x: 0, z: 0 });
  bus.emit('ped:knockdown', { ped: {}, cause: 'punch', byPlayer: false, x: 0, z: 0 });
  const loots = bus.log.filter((e) => e.name === 'player:money' && e.payload.reason === 'loot').map((e) => e.payload.delta);
  check('punch（byPlayer）→ pedsKnockedOut 3、掉錢 3 次', eco.stats.pedsKnockedOut === 3 && loots.length === 3);
  check('掉錢金額 rng 0 / 0.999999 / 0.5 → 10 / 40 / 25（整數 10–40）', loots.join(',') === '10,40,25', loots.join(','));
  check('掉錢後金錢 575、moneyEarned 75', eco.money === 575 && eco.stats.moneyEarned === 75);
  const lastMoney = bus.log.filter((e) => e.name === 'player:money').pop().payload;
  check('player:money payload { money, delta, reason }', lastMoney.money === 575 && lastMoney.delta === 25 && lastMoney.reason === 'loot');

  bus.emit('vehicle:carjacked', { vehicle: {} });
  bus.emit('vehicle:carjacked', { vehicle: {} });
  bus.emit('vehicle:crash', { vehicle: {}, relSpeed: 10 });
  check('vehicle:carjacked → carjacks 2、vehicle:crash → crashes 1', eco.stats.carjacks === 2 && eco.stats.crashes === 1);

  bus.emit('player:ko', {});
  const hosp = bus.log.filter((e) => e.name === 'player:money').pop().payload;
  check('player:ko → kos 1、扣醫藥費 NT$100（reason hospital）', eco.stats.kos === 1 && eco.money === 475 && hosp.delta === -100 && hosp.reason === 'hospital' && eco.stats.moneySpent === 100);

  check('spend 足額 → true 並扣款', eco.spend(400, 'shop') === true && eco.money === 75);
  const before = bus.log.length;
  check('spend 不足 → false、不扣、不 emit', eco.spend(100, 'shop') === false && eco.money === 75 && bus.log.length === before);
  bus.emit('player:ko', {});
  check('醫藥費不低於 0（75 → 0，實扣 75）', eco.money === 0 && eco.stats.kos === 2 && eco.stats.moneySpent === 575);
  const n1 = bus.log.length;
  bus.emit('player:ko', {});
  check('金錢 0 時 KO：kos +1、金錢仍 0、無金錢變動事件', eco.money === 0 && eco.stats.kos === 3 && bus.log.filter((e, i) => i >= n1 && e.name === 'player:money').length === 0);

  check('add 小數取整、負數 / NaN 不入帳', eco.add(12.6, 'x') === 13 && eco.add(-5, 'x') === 0 && eco.add(NaN, 'x') === 0 && eco.money === 13);
  eco.addDistance('walk', 12.5); eco.addDistance('drive', 100); eco.addDistance('walk', -3); eco.addDistance('fly', 9); eco.addDistance('walk', NaN);
  eco.addPlayTime(1.5); eco.addPlayTime(-1); eco.addPlayTime(NaN);
  const snap = eco.snapshot();
  check('addDistance / addPlayTime 累計且忽略非法值', snap.stats.distWalkM === 12.5 && snap.stats.distDriveM === 100 && snap.stats.playTimeSec === 1.5);
  snap.stats.kos = 999;
  check('snapshot / stats 回副本（外部改不影響）', eco.stats.kos === 3 && eco.snapshot().money === 13);
  check('snapshot 可直接進 validateSave', validateSave({ ...defaultSave(), ...eco.snapshot() }).money === 13);

  eco.dispose();
  const nd = bus.log.length;
  bus.emit('ped:knockdown', { ped: {}, cause: 'punch', byPlayer: true, x: 0, z: 0 });
  bus.emit('vehicle:carjacked', { vehicle: {} });
  bus.emit('vehicle:crash', { vehicle: {}, relSpeed: 10 });
  bus.emit('player:ko', {});
  const sa = eco.stats;
  check('dispose 後不再計數、不掉錢', sa.pedsKnockedOut === 3 && sa.carjacks === 2 && sa.crashes === 1 && sa.kos === 3 && eco.money === 13
    && bus.log.slice(nd).every((e) => e.name !== 'player:money'));
  check('dispose 解除所有訂閱', ['ped:knockdown', 'vehicle:carjacked', 'vehicle:crash', 'player:ko'].every((n) => bus.count(n) === 0));

  const eco2 = createEconomy({ bus: fakeBus(), initial: { money: -9, stats: { kos: NaN, crashes: 4 } } });
  check('initial 清洗：負金錢 → 500、NaN 統計 → 0、有效值保留', eco2.money === 500 && eco2.stats.kos === 0 && eco2.stats.crashes === 4);
  const eco3 = createEconomy({});
  check('無 bus / initial 也可運作', eco3.money === 500 && eco3.add(5) === 5 && eco3.money === 505);
}

// ---------- 手槍無限備彈（fix1-P4）：weapons.serialize → store.save（JSON）→ load → restore 後仍無限；JSON 不含 null / Infinity ----------
{
  const { createWeapons } = await import('../../src/weapons/weapons.js');
  const mk = () => createWeapons({ player: { actor: { id: 'p', kind: 'player', pos: { x: 0, y: 0, z: 0 }, yaw: 0 } } });
  const w = mk();
  w.select(2);
  w.update(0.5, null);
  w.attack(null);
  const s = fakeStorage({});
  const st = createSaveStore({ storage: s, now: () => 1 });
  check('無限備彈：save 含 weapons.serialize() → true', st.save({ ...defaultSave(), weapons: w.serialize() }) === true);
  const raw = s.getItem('tcgta.save');
  check('無限備彈：存檔 JSON 不含 Infinity、weapons 段不含 null', !/Infinity/.test(raw) && !/null/.test(JSON.stringify(JSON.parse(raw).weapons)), JSON.stringify(JSON.parse(raw).weapons));
  const r = createSaveStore({ storage: s }).load();
  const w2 = mk();
  w2.restore(r.data.weapons);
  check('無限備彈：讀回 restore 後 reserve 仍為 ∞、mag 11', r.status === 'ok' && w2.ammo().reserve === Infinity && w2.ammo().mag === 11 && w2.current === 'pistol');
  const old = createSaveStore({ storage: fakeStorage({ 'tcgta.save': JSON.stringify({ ...defaultSave(), weapons: { slot: 2, ammo: { pistol: { mag: 0, reserve: 0 } } } }) }) }).load();
  const w3 = mk();
  w3.restore(old.data.weapons);
  check('無限備彈：舊存檔（mag 0 / reserve 0）讀入不壞、可換彈', old.status === 'ok' && w3.ammo().reserve === Infinity && w3.reload() === true);
  check('無限備彈：validateSave 遇 reserve Infinity / null → 數字預設 36（不寫入非數字）', validateSave({ version: 2, weapons: { ammo: { pistol: { mag: 3, reserve: Infinity } } } }).weapons.ammo.pistol.reserve === 36
    && validateSave(JSON.parse(JSON.stringify({ version: 2, weapons: { ammo: { pistol: { mag: 3, reserve: Infinity } } } }))).weapons.ammo.pistol.reserve === 36);
}

const total = passed + failed;
console.log(`\nsave.mjs：${passed} 通過 / ${failed} 失敗`);
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
