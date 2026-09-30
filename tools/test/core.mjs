#!/usr/bin/env node
// P3-0 介面核心無頭測試：src/core/events.js（bus）、settings.js、quality.js、actions.js
// 用法：node tools/test/core.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 比照 tools/test/crowd.mjs：掛 JSON import hook、document 最小替身（core 模組本身不碰 DOM，替身僅確保無副作用）
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
globalThis.document = { createElement: () => ({ style: {} }) };

const { createBus, bus } = await import('../../src/core/events.js');
const { createSettings, settings, SETTINGS_SCHEMA, SETTINGS_KEY, LEGACY_SENS_KEYS } = await import('../../src/core/settings.js');
const { QUALITY_TIERS, QUALITY_IDS, resolveQuality, qualityBudget } = await import('../../src/core/quality.js');
const { ACTIONS, KEYMAP_HELP, TOUCH_HELP, createActionReader } = await import('../../src/core/actions.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 暫時攔 console.error（例外隔離會印錯誤）
function quietErrors(fn) {
  const orig = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a);
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return logs;
}

// ======================= events =======================
{
  const b = createBus();
  const seq = [];
  b.on('x', (p) => seq.push(`a${p.n}`));
  b.on('x', (p) => seq.push(`b${p.n}`));
  b.on('x', (p) => seq.push(`c${p.n}`));
  b.emit('x', { n: 1 });
  check('bus：依註冊順序同步呼叫', seq.join(',') === 'a1,b1,c1', seq.join(','));

  const b2 = createBus();
  const got = [];
  b2.on('e', () => got.push(1));
  b2.on('e', () => {
    throw new Error('故意');
  });
  b2.on('e', () => got.push(3));
  const logs = quietErrors(() => b2.emit('e'));
  check('bus：listener 例外被 catch、其他照常、console.error 1 次', got.join(',') === '1,3' && logs.length === 1);

  const b3 = createBus();
  const s3 = [];
  let offB = null;
  b3.on('e', () => {
    s3.push('a');
    offB();
  });
  offB = b3.on('e', () => s3.push('b'));
  b3.on('e', () => s3.push('c'));
  b3.emit('e');
  b3.emit('e');
  check('bus：emit 中 off 後面的 listener → 本次即不呼叫', s3.join('') === 'acac', s3.join(''));

  const b4 = createBus();
  const s4 = [];
  b4.on('e', () => {
    s4.push('a');
    b4.on('e', () => s4.push('new'));
  });
  b4.emit('e');
  check('bus：emit 中新增的 listener 本次不呼叫、下次才呼叫', s4.join(',') === 'a', s4.join(','));
  b4.emit('e');
  check('bus：下次 emit 呼叫新增的 listener', s4.join(',') === 'a,a,new', s4.join(','));

  const b5 = createBus();
  const s5 = [];
  const self = () => {
    s5.push('self');
    b5.off('e', self);
  };
  b5.on('e', self);
  b5.on('e', () => s5.push('z'));
  b5.emit('e');
  b5.emit('e');
  check('bus：listener 在 emit 中 off 自己', s5.join(',') === 'self,z,z');

  const b6 = createBus();
  let n6 = 0;
  b6.once('e', () => n6++);
  b6.emit('e');
  b6.emit('e');
  check('bus：once 只觸發一次', n6 === 1);
  let n6b = 0;
  const cancel = b6.once('e', () => n6b++);
  cancel();
  b6.emit('e');
  check('bus：once 觸發前取消', n6b === 0);
  let n6c = 0;
  b6.once('r', () => {
    n6c++;
    b6.emit('r'); // 遞迴 emit 不會再觸發 once
  });
  b6.emit('r');
  check('bus：once 內遞迴 emit 不重複觸發', n6c === 1);

  const b7 = createBus();
  let n7 = 0;
  const fn = () => n7++;
  const off7 = b7.on('e', fn);
  off7();
  off7(); // 重複取消安全
  b7.emit('e');
  b7.on('e', fn);
  b7.off('e', fn);
  b7.emit('e');
  b7.emit('無人訂閱', {});
  check('bus：on 回傳的 off 與 off(name, fn) 皆可取消；無訂閱 emit 不出錯', n7 === 0);
  const b8 = createBus();
  const p8 = { money: 1 };
  let got8 = null;
  b8.on('player:money', (p) => (got8 = p));
  b8.emit('player:money', p8);
  check('bus：payload 原樣傳遞', got8 === p8);
  let threw = false;
  try {
    b8.on('e', 123);
  } catch (err) {
    threw = true;
  }
  check('bus：非函式 listener 丟 TypeError', threw);
  check('bus：全域單例存在且有四個方法', ['on', 'once', 'off', 'emit'].every((k) => typeof bus[k] === 'function'));
}

// ======================= settings =======================
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    writes: 0,
    getItem(k) {
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      this.writes++;
      m.set(k, String(v));
    },
    removeItem(k) {
      m.delete(k);
    },
  };
}
{
  const st = fakeStorage();
  const s = createSettings({ storage: st });
  const all = s.getAll();
  check(
    'settings：預設值',
    all.quality === 'auto' && all.lookSensMouse === 1 && all.lookSensTouch === 1 && all.invertY === false && all.volumeMaster === 0.8 && all.volumeMusic === 0.6 && all.volumeSfx === 0.9 && all.showFps === false && all.showHints === true && all.uiScale === 1,
    JSON.stringify(all),
  );
  check('settings：schema 有 10 個鍵', Object.keys(SETTINGS_SCHEMA).length === 10 && Object.keys(all).length === 10);
  check('settings：全新且無舊鍵時不寫入 storage', st.writes === 0);
  all.quality = 'low';
  check('settings：getAll 回傳副本', s.get('quality') === 'auto');

  check('settings：clamp 上限 5 → 3.0', s.set('lookSensMouse', 5) === true && s.get('lookSensMouse') === 3);
  check('settings：clamp 下限 0 → 0.3', s.set('lookSensMouse', 0) && s.get('lookSensMouse') === 0.3);
  check('settings：step 0.1（1.26 → 1.3）', s.set('lookSensTouch', 1.26) && s.get('lookSensTouch') === 1.3, String(s.get('lookSensTouch')));
  check('settings：step 0.1 無浮點誤差（0.7 → 0.7）', s.set('lookSensTouch', 0.7) && s.get('lookSensTouch') === 0.7, String(s.get('lookSensTouch')));
  check('settings：uiScale step 0.05（1.12 → 1.1、1.13 → 1.15）', s.set('uiScale', 1.12) && s.get('uiScale') === 1.1 && s.set('uiScale', 1.13) && s.get('uiScale') === 1.15, String(s.get('uiScale')));
  check('settings：音量無 step、clamp 0–1', s.set('volumeSfx', 0.333) && s.get('volumeSfx') === 0.333 && s.set('volumeSfx', -1) && s.get('volumeSfx') === 0);
  const before = JSON.stringify(s.getAll());
  const bad = [
    ['quality', 'super'],
    ['quality', 1],
    ['lookSensMouse', 'fast'],
    ['lookSensMouse', NaN],
    ['lookSensMouse', Infinity],
    ['lookSensMouse', null],
    ['invertY', 'true'],
    ['invertY', 1],
    ['showFps', undefined],
    ['noSuchKey', 1],
  ];
  const rejected = bad.every(([k, v]) => s.set(k, v) === false);
  check('settings：非法值回 false 且不存', rejected && JSON.stringify(s.getAll()) === before);
  check('settings：enum / boolean 合法值', s.set('quality', 'ultra') && s.get('quality') === 'ultra' && s.set('invertY', true) && s.get('invertY') === true);

  // 訂閱
  const ev = [];
  const unsub = s.subscribe((k, v, a) => ev.push(`${k}=${v}:${a[k] === v}`));
  s.set('showFps', true);
  s.set('showFps', true); // 同值不通知
  s.set('showFps', 'x'); // 非法不通知
  check('settings：subscribe 收到 (key, value, all)、同值與非法值不通知', ev.join(',') === 'showFps=true:true', ev.join(','));
  const logs = quietErrors(() => {
    const off2 = s.subscribe(() => {
      throw new Error('故意');
    });
    s.set('showHints', false);
    off2();
  });
  check('settings：訂閱者例外被隔離', logs.length === 1 && s.get('showHints') === false && ev.at(-1) === 'showHints=false:true');
  unsub();
  s.set('showFps', false);
  check('settings：取消訂閱後不再通知', ev.length === 2);

  // 持久化
  const saved = JSON.parse(st.m.get(SETTINGS_KEY));
  check('settings：寫入 tcgta.settings.v1（JSON）', SETTINGS_KEY === 'tcgta.settings.v1' && saved.quality === 'ultra' && saved.invertY === true && saved.lookSensTouch === 0.7);
  const s2 = createSettings({ storage: st });
  check('settings：新實例從假 storage 讀回', JSON.stringify(s2.getAll()) === JSON.stringify(s.getAll()));

  // reset
  s.reset('quality');
  check('settings：reset(key) 單鍵回預設', s.get('quality') === 'auto' && s.get('invertY') === true);
  s.reset();
  check('settings：reset() 全部回預設並存檔', s.get('invertY') === false && s.get('lookSensMouse') === 1 && JSON.parse(st.m.get(SETTINGS_KEY)).invertY === false);
}
{
  // 舊鍵遷移
  const st = fakeStorage({ [LEGACY_SENS_KEYS.mouse]: 'high', [LEGACY_SENS_KEYS.touch]: 'low' });
  const s = createSettings({ storage: st });
  check('settings：舊鍵遷移 high → 1.6、low → 0.6', s.get('lookSensMouse') === 1.6 && s.get('lookSensTouch') === 0.6);
  check('settings：遷移結果寫入 v1', JSON.parse(st.m.get(SETTINGS_KEY)).lookSensMouse === 1.6);
  const st2 = fakeStorage({ [LEGACY_SENS_KEYS.mouse]: 'mid', [LEGACY_SENS_KEYS.touch]: 'weird' });
  const s2 = createSettings({ storage: st2 });
  check('settings：舊鍵 mid → 1.0、未知值 → 預設', s2.get('lookSensMouse') === 1 && s2.get('lookSensTouch') === 1);
  const st3 = fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ lookSensMouse: 2.2 }), [LEGACY_SENS_KEYS.mouse]: 'low' });
  const s3 = createSettings({ storage: st3 });
  check('settings：v1 已存在時不讀舊鍵；缺鍵補預設', s3.get('lookSensMouse') === 2.2 && s3.get('lookSensTouch') === 1 && s3.get('quality') === 'auto');
  // 實測修正：遷移成功後刪除舊鍵；v1 已存在的殘留舊鍵也刪；寫入 v1 失敗時保留舊鍵（下次可再遷移）
  check('settings：遷移成功後刪除兩個舊鍵', !st.m.has(LEGACY_SENS_KEYS.mouse) && !st.m.has(LEGACY_SENS_KEYS.touch) && st.m.has(SETTINGS_KEY));
  check('settings：v1 已存在時殘留舊鍵被刪除、v1 不被改寫', !st3.m.has(LEGACY_SENS_KEYS.mouse) && JSON.parse(st3.m.get(SETTINGS_KEY)).lookSensMouse === 2.2 && st3.writes === 0);
  const again = createSettings({ storage: st });
  check('settings：遷移後再載入 → 讀 v1（1.6 / 0.6），不再依賴舊鍵', again.get('lookSensMouse') === 1.6 && again.get('lookSensTouch') === 0.6);
  const st4 = fakeStorage({ [LEGACY_SENS_KEYS.mouse]: 'high' });
  st4.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const s4 = createSettings({ storage: st4 });
  check('settings：寫入 v1 失敗 → 保留舊鍵、記憶體值仍為遷移值', st4.m.get(LEGACY_SENS_KEYS.mouse) === 'high' && s4.get('lookSensMouse') === 1.6);
}
{
  // 損毀
  const cases = ['{壞掉', 'null', '[1,2]', '42', '"str"', ''];
  const ok = cases.every((raw) => {
    const s = createSettings({ storage: fakeStorage({ [SETTINGS_KEY]: raw }) });
    return s.get('quality') === 'auto' && s.get('lookSensMouse') === 1;
  });
  check('settings：損毀 JSON / 非物件 → 預設、不丟例外', ok);
  const s = createSettings({ storage: fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ quality: 'bogus', lookSensMouse: 9, invertY: 'yes', extra: 1 }) }) });
  check('settings：存檔內單鍵非法 → 該鍵預設、數值 clamp、未知鍵丟棄', s.get('quality') === 'auto' && s.get('lookSensMouse') === 3 && s.get('invertY') === false && s.getAll().extra === undefined);
  // storage 丟例外（無痕模式）
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceeded');
    },
  };
  let ok2 = true;
  let s4;
  try {
    s4 = createSettings({ storage: throwing });
    ok2 = s4.set('uiScale', 1.2) && s4.get('uiScale') === 1.2;
  } catch (err) {
    ok2 = false;
  }
  check('settings：storage 讀寫丟例外 → 只存記憶體、不丟例外', ok2);
  check('settings：node 無 window 時預設單例可用', settings.get('quality') === 'auto' && settings.set('showFps', true) && settings.get('showFps') === true);
}

// ======================= quality =======================
{
  check('quality：四級 id', QUALITY_IDS.join(',') === 'low,mid,high,ultra' && QUALITY_IDS.every((id) => QUALITY_TIERS[id].id === id));
  const t = QUALITY_TIERS;
  check(
    'quality：定稿表數值',
    t.low.dprCap === 1 && t.low.shadowMap === 0 && t.low.peds === 40 && t.low.cars === 18 && t.low.pedNear === 30 && t.low.pedFar === 70 && t.low.viewDist === 420 &&
      t.mid.dprCap === 1.25 && t.mid.shadowMap === 1024 && t.mid.peds === 80 && t.mid.cars === 30 && t.mid.viewDist === 650 &&
      t.high.dprCap === 1.5 && t.high.shadowMap === 2048 && t.high.peds === 140 && t.high.cars === 45 && t.high.pedFar === 110 &&
      t.ultra.dprCap === 2 && t.ultra.shadowMap === 4096 && t.ultra.peds === 200 && t.ultra.cars === 60 && t.ultra.pedNear === 60 && t.ultra.viewDist === 1300,
  );
  check('quality：label 中文', t.low.label === '低' && t.mid.label === '中' && t.high.label === '高' && t.ultra.label === '極致');
  check('quality：人車數 / 半徑隨等級遞增', QUALITY_IDS.every((id, i) => i === 0 || (t[id].peds > t[QUALITY_IDS[i - 1]].peds && t[id].cars > t[QUALITY_IDS[i - 1]].cars && t[id].pedFar > t[id].pedNear)));
  check('quality：auto + touch → low', resolveQuality('auto', { touch: true }) === 'low');
  check('quality：auto + 桌機 → high', resolveQuality('auto', { touch: false }) === 'high' && resolveQuality('auto') === 'high');
  check('quality：url 優先（?q=ultra 蓋過設定 low 與觸控）', resolveQuality('low', { touch: true, urlQ: 'ultra' }) === 'ultra' && resolveQuality('auto', { touch: true, urlQ: 'mid' }) === 'mid');
  check('quality：非法 url 忽略', resolveQuality('mid', { touch: true, urlQ: 'max' }) === 'mid' && resolveQuality('auto', { touch: false, urlQ: '' }) === 'high');
  check('quality：設定值（非 auto）優先於裝置判斷', resolveQuality('ultra', { touch: true }) === 'ultra' && resolveQuality('low', { touch: false }) === 'low');
  check('quality：非法設定當 auto', resolveQuality('bogus', { touch: true }) === 'low' && resolveQuality(undefined, { touch: false }) === 'high');
  const b = qualityBudget('mid');
  b.peds = 999;
  check('quality：qualityBudget 回副本、含 motorbikeShare 0.4', QUALITY_TIERS.mid.peds === 80 && qualityBudget('mid').motorbikeShare === 0.4 && qualityBudget('low').peds === 40);
  check('quality：qualityBudget 未知 id → high', qualityBudget('nope').id === 'high');
}

// ======================= actions =======================
{
  const names = Object.keys(ACTIONS);
  const expected = ['move', 'sprint', 'jump', 'attack', 'aim', 'interact', 'enterExit', 'horn', 'camera', 'lookBack', 'radio', 'phone', 'map', 'pause', 'timeSkip', 'reload'];
  check('actions：16 個定稿動作', expected.every((n) => names.includes(n)) && names.length === expected.length, names.join(','));
  check(
    'actions：鍵位對齊契約',
    ACTIONS.attack.keys.join() === 'Mouse0' && ACTIONS.aim.keys.join() === 'Mouse2' && ACTIONS.interact.keys.join() === 'KeyE' && ACTIONS.enterExit.keys.join() === 'KeyF' &&
      ACTIONS.horn.keys.join() === 'KeyH' && ACTIONS.camera.keys.join() === 'KeyV' && ACTIONS.lookBack.keys.join() === 'KeyC' && ACTIONS.map.keys.join() === 'KeyM' &&
      ACTIONS.pause.keys.join() === 'Escape,KeyP' && ACTIONS.timeSkip.keys.join() === 'KeyN' && ACTIONS.reload.keys.join() === 'KeyR' && ACTIONS.jump.keys.join() === 'Space' &&
      ACTIONS.sprint.keys.join() === 'ShiftLeft,ShiftRight' && ACTIONS.radio.keys.join() === 'KeyQ' && ACTIONS.phone.keys.join() === 'KeyT',
  );
  check('actions：每個動作有 keys / label / hold', names.every((n) => Array.isArray(ACTIONS[n].keys) && ACTIONS[n].keys.length > 0 && typeof ACTIONS[n].label === 'string' && typeof ACTIONS[n].hold === 'boolean'));
  check('actions：取消的舊鍵不再綁定（O 靈敏度、G 舊喇叭）', !names.some((n) => ACTIONS[n].keys.includes('KeyO') || ACTIONS[n].keys.includes('KeyG')));
  // 同一 code 不綁兩個 action（Escape / KeyP 同屬 pause 不算重複）
  const owner = new Map();
  const dups = [];
  for (const n of names) {
    for (const c of ACTIONS[n].keys) {
      if (owner.has(c) && owner.get(c) !== n) dups.push(`${c}:${owner.get(c)}/${n}`);
      owner.set(c, n);
    }
  }
  check('actions：同一 code 不重複綁兩個 action', dups.length === 0, dups.join(' '));
  check('actions：pause 例外（Escape / KeyP 同屬 pause）', owner.get('Escape') === 'pause' && owner.get('KeyP') === 'pause');
  const reserved = names.filter((n) => ACTIONS[n].reserved);
  check('actions：預留動作 = aim / interact / radio / phone / reload', reserved.sort().join(',') === 'aim,interact,phone,radio,reload', reserved.join(','));

  const helpShape = (help) =>
    Array.isArray(help) && help.every((g) => ['步行', '駕駛', '通用'].includes(g.group) && Array.isArray(g.items) && g.items.every((it) => typeof it.keys === 'string' && typeof it.desc === 'string' && (it.action === null || ACTIONS[it.action])));
  check('actions：KEYMAP_HELP / TOUCH_HELP 格式', helpShape(KEYMAP_HELP) && helpShape(TOUCH_HELP) && KEYMAP_HELP.map((g) => g.group).join() === '步行,駕駛,通用');
  const covered = new Set(KEYMAP_HELP.flatMap((g) => g.items.map((i) => i.action)));
  const missing = names.filter((n) => !ACTIONS[n].reserved && !covered.has(n));
  check('actions：KEYMAP_HELP 涵蓋所有非預留 action', missing.length === 0, missing.join(','));
  const leak = [...covered].filter((a) => a && ACTIONS[a].reserved);
  check('actions：KEYMAP_HELP 不列預留 action', leak.length === 0, leak.join(','));
  const helpText = JSON.stringify(KEYMAP_HELP);
  const items = KEYMAP_HELP.flatMap((g) => g.items);
  check('actions：說明不再列 O 靈敏度 / E 揮拳 / R 翻車，H 只當喇叭', !items.some((i) => ['O', 'E', 'R'].includes(i.keys)) && items.filter((i) => i.keys === 'H').every((i) => i.action === 'horn'));
  check('actions：H 說明為喇叭、F 含扶起', /"keys":"H","action":"horn"/.test(helpText) && KEYMAP_HELP[1].items.some((i) => i.action === 'enterExit' && i.desc.includes('扶起')));

  // reader：假 input
  const held = new Set(['ShiftRight', 'KeyC']);
  const pressed = new Set(['KeyP', 'Mouse0']);
  const fake = { down: (c) => held.has(c), wasPressed: (c) => pressed.has(c) };
  const r = createActionReader(fake);
  check('actions：reader.down 任一鍵按住即真（ShiftRight → sprint）', r.down('sprint') && r.down('lookBack') && !r.down('jump'));
  check('actions：reader.pressed（KeyP → pause、Mouse0 → attack）', r.pressed('pause') && r.pressed('attack') && !r.pressed('map'));
  check('actions：reader 未知動作 → false', r.down('fly') === false && r.pressed('fly') === false);
  held.add('Space');
  pressed.clear();
  check('actions：reader 即時反映 input 狀態', r.down('jump') && !r.pressed('pause'));
}

console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
