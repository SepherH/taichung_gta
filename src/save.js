// 存檔：localStorage 讀寫、版本遷移、清洗驗證、備份 / 損毀保留，以及定時自動存檔
// 損毀處理：主鍵壞、.bak 好 → recovered；兩者皆壞 → corrupt-reset（最後一份原文留在 .corrupt，壞掉的主鍵 / .bak 清掉）
// storage 由呼叫端注入（介面同 localStorage：getItem / setItem / removeItem）；未注入時用 globalThis.localStorage，
// 仍不可用（node、停用儲存）時退回記憶體；所有讀寫都 try/catch，不向外丟例外
// schema v2（契約 §18）：新增 weapons / missions / collect 與三個統計欄位；v1 存檔讀入時補預設、保留原有全部值
// Phase 5（§18 增補，不升版）：missions.events（時段事件，missions/events.js serialize）選填——
//   { completed: { id: 正整數 }, cooldowns: { id: 正秒數 } }；格式錯誤整欄丟棄（不影響其他欄位），清洗後兩表皆空也省略
// Phase 12（§34 增補，不升版）：races（街頭競速，missions/race.js serialize）選填頂層欄位——{ best: { raceId: 正秒數 } }；
//   舊存檔沒有此欄 → 省略（無最佳成績）；格式錯誤整欄丟棄、非法值的鍵個別丟棄，清洗後為空也省略（defaultSave 不含此欄）
// Phase 14（不升版，皆選填、defaultSave 不含）：
//   weapons.owned：已購買的武器 id 陣列（只收 'smg' / 'shotgun'、去重）；空 → 省略
//   weapons.ammo.smg / weapons.ammo.shotgun：{ mag, reserve }，只在 owned 含該槍時保留（缺 → 彈匣滿、附贈備彈；clamp 到上限）
//   weapons.slot：{0,1,2} 之外只接受已擁有的 3（衝鋒槍）/ 4（散彈槍），其餘 → 0（舊存檔 slot 3 仍歸 0）
//   safehouse：{ last: 安全屋 id（[\w-]{1,64} 字串）}——最後使用的安全屋（src/shops/safehouse.js）；格式錯誤整欄丟棄
// Phase 15（§37，不升版，選填、defaultSave 不含）：rampage：{ done: 已完成的暴走點 id 陣列（[\w-]{1,64}、去重、≤ LIST_MAX）}
//   （missions/rampage.js serialize）；舊存檔沒有此欄 → 省略（全部未完成）；格式錯誤整欄丟棄、非法 id 個別丟棄，清洗後為空也省略
// Phase 16（§38，不升版，選填、defaultSave 不含）：stunts：{ done: 已完成的特技跳台 id 陣列 }（src/stunts.js serialize）；清洗規則同 rampage

export const SAVE_VERSION = 2;

// 統計欄位：計數類取整數，距離 / 時間類保留小數
const STAT_INT_KEYS = ['pedsHit', 'pedsKnockedOut', 'carjacks', 'crashes', 'kos', 'moneyEarned', 'moneySpent', 'missionsDone', 'missionsFailed', 'shotsFired'];
const STAT_FLOAT_KEYS = ['playTimeSec', 'distWalkM', 'distDriveM'];
// v2 清洗上限
const PISTOL_MAG_MAX = 12;
const PISTOL_RESERVE_MAX = 120;
// Phase 14 長槍（與 src/weapons/defs.js 的 magSize / reserveMax / startReserve 一致，測試交叉比對）
const LONG_GUNS = {
  smg: { slot: 3, mag: 30, reserveMax: 300, reserve: 90 },
  shotgun: { slot: 4, mag: 6, reserveMax: 60, reserve: 18 },
};
const SAFEHOUSE_ID_RE = /^[\w-]{1,64}$/;
const LIST_MAX = 200; // checkins / foods 陣列長度上限
const MAP_MAX = 200; // completed / best / cooldowns 鍵數上限（契約未定，本檔自訂）
const MISSION_STAGES = ['pickup', 'deliver'];

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    savedAt: 0,
    money: 500,
    stats: {
      playTimeSec: 0,
      distWalkM: 0,
      distDriveM: 0,
      pedsHit: 0,
      pedsKnockedOut: 0,
      carjacks: 0,
      crashes: 0,
      kos: 0,
      moneyEarned: 0,
      moneySpent: 0,
      missionsDone: 0,
      missionsFailed: 0,
      shotsFired: 0,
    },
    player: { x: null, z: null, yaw: 0 },
    world: { hour: 16.5 },
    weapons: { slot: 0, ammo: { pistol: { mag: PISTOL_MAG_MAX, reserve: 36 } } },
    missions: { completed: {}, best: {}, cooldowns: {}, active: null },
    collect: { checkins: [], foods: [] },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// finite 且 ≥ 0 才採用，否則用預設值
const nonNeg = (v, def) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def);
const nonNegInt = (v, def) => Math.floor(nonNeg(v, def));
// 座標可為負；null / 非有限值 → null（整合端改用出生點）
const coord = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// 非負整數，超過上限 clamp 到上限；非法 → 預設
const intCap = (v, def, max) => Math.min(max, nonNegInt(v, def));
// 字串鍵 → 非負有限數的表（int = true 取整數）；非法值的鍵丟棄；'__proto__' / 空字串不收
function numMap(src, int) {
  const out = {};
  if (!isObj(src)) return out;
  let n = 0;
  for (const k of Object.keys(src)) {
    if (n >= MAP_MAX) break;
    if (k === '' || k === '__proto__') continue;
    const v = src[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[k] = int ? Math.floor(v) : v;
    n++;
  }
  return out;
}
// 字串陣列：只收非空字串、去重（保留首次出現順序）、上限 LIST_MAX
function strList(src) {
  if (!Array.isArray(src)) return [];
  const seen = new Set();
  for (const v of src) {
    if (seen.size >= LIST_MAX) break;
    if (typeof v === 'string' && v !== '') seen.add(v);
  }
  return [...seen];
}
// 進行中任務：只收 { slug: 非空字串, stage: 'pickup'|'deliver' }，其餘 → null
function activeMission(src) {
  if (!isObj(src) || typeof src.slug !== 'string' || src.slug === '' || !MISSION_STAGES.includes(src.stage)) return null;
  return { slug: src.slug, stage: src.stage };
}
// 時段事件狀態（missions.events）：必須是物件，completed / cooldowns 若存在必須是物件，否則整欄作廢（回 null）；
// 表內非法值的鍵個別丟棄（同 numMap）；completed 只收 ≥ 1、cooldowns 只收 > 0；兩表都空 → null（同 serialize 不帶）
function missionEvents(src) {
  if (!isObj(src)) return null;
  if ((src.completed !== undefined && !isObj(src.completed)) || (src.cooldowns !== undefined && !isObj(src.cooldowns))) return null;
  const completed = numMap(src.completed, true);
  const cooldowns = numMap(src.cooldowns, false);
  for (const k of Object.keys(completed)) if (completed[k] < 1) delete completed[k];
  for (const k of Object.keys(cooldowns)) if (!(cooldowns[k] > 0)) delete cooldowns[k];
  if (!Object.keys(completed).length && !Object.keys(cooldowns).length) return null;
  return { completed, cooldowns };
}

// 街頭競速最佳成績（races）：必須是物件且 best 為物件，否則整欄作廢（回 null）；best 只收 > 0 的有限秒數；空 → null
function raceRecords(src) {
  if (!isObj(src) || !isObj(src.best)) return null;
  const best = numMap(src.best, false);
  for (const k of Object.keys(best)) if (!(best[k] > 0)) delete best[k];
  return Object.keys(best).length ? { best } : null;
}

// 已購買武器清單：只收 LONG_GUNS 的鍵、去重；非陣列 → []
function ownedGuns(src) {
  if (!Array.isArray(src)) return [];
  return Object.keys(LONG_GUNS).filter((id) => src.includes(id));
}

// 最後使用的安全屋：{ last: id } → 同形；格式錯誤 → null（省略）
function safehouseRecord(src) {
  if (!isObj(src) || typeof src.last !== 'string' || !SAFEHOUSE_ID_RE.test(src.last)) return null;
  return { last: src.last };
}

// 暴走完成紀錄：{ done: [id] } → 同形；非物件 / done 非陣列 → null；只收 SAFEHOUSE_ID_RE 格式字串、去重；空 → null
function rampageRecord(src) {
  if (!isObj(src) || !Array.isArray(src.done)) return null;
  const done = [...new Set(src.done.filter((id) => typeof id === 'string' && SAFEHOUSE_ID_RE.test(id)))].slice(0, LIST_MAX);
  return done.length ? { done } : null;
}

// 版本遷移：version < SAVE_VERSION 逐版升級；version > SAVE_VERSION 視為無法讀取（回 null，不覆寫）
export function migrate(obj) {
  if (!isObj(obj)) return null;
  let v = obj.version === undefined ? SAVE_VERSION : obj.version;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v > SAVE_VERSION) return null;
  const out = { ...obj };
  if (v < 1) v = 1;
  // v1 → v2：只補缺少的新欄位，v1 原有值（含已存在的同名欄位）一律保留，清洗交給 validateSave
  if (v < 2) {
    const d = defaultSave();
    for (const k of ['weapons', 'missions', 'collect']) if (!(k in out)) out[k] = d[k];
    if (isObj(out.stats)) {
      const st = { ...out.stats };
      for (const k of ['missionsDone', 'missionsFailed', 'shotsFired']) if (!(k in st)) st[k] = 0;
      out.stats = st;
    }
    v = 2;
  }
  // 之後新增版本時在此補：if (v < 3) { ...; v = 3; }
  out.version = v;
  return out;
}

// 清洗：數值 finite 且 ≥ 0、未知鍵丟棄、缺鍵補預設；非物件或版本較新 → null
// v2 欄位：slot ∈ {0,1,2}、彈藥非負整數且 clamp 到 mag ≤ 12 / reserve ≤ 120、任務表只收字串鍵 → 非負有限數、收集陣列只收字串去重 ≤ 200
//   missions.events（選填）見 missionEvents
export function validateSave(obj) {
  const m = migrate(obj);
  if (!m) return null;
  const d = defaultSave();
  const out = defaultSave();
  out.savedAt = nonNeg(m.savedAt, d.savedAt);
  out.money = nonNegInt(m.money, d.money);
  const st = isObj(m.stats) ? m.stats : {};
  for (const k of STAT_INT_KEYS) out.stats[k] = nonNegInt(st[k], d.stats[k]);
  for (const k of STAT_FLOAT_KEYS) out.stats[k] = nonNeg(st[k], d.stats[k]);
  const p = isObj(m.player) ? m.player : {};
  out.player.x = coord(p.x);
  out.player.z = coord(p.z);
  // x / z 需成對有效，只有一個有效時一起作廢
  if (out.player.x === null || out.player.z === null) out.player.x = out.player.z = null;
  out.player.yaw = typeof p.yaw === 'number' && Number.isFinite(p.yaw) ? p.yaw : d.player.yaw;
  const w = isObj(m.world) ? m.world : {};
  out.world.hour = nonNeg(w.hour, d.world.hour) % 24;
  // v2：武器 / 任務 / 收集
  const wp = isObj(m.weapons) ? m.weapons : {};
  const own = ownedGuns(wp.owned);
  const ownedSlots = own.map((id) => LONG_GUNS[id].slot);
  out.weapons.slot = [0, 1, 2].includes(wp.slot) || ownedSlots.includes(wp.slot) ? wp.slot : d.weapons.slot;
  const pa = isObj(wp.ammo) && isObj(wp.ammo.pistol) ? wp.ammo.pistol : {};
  out.weapons.ammo.pistol.mag = intCap(pa.mag, d.weapons.ammo.pistol.mag, PISTOL_MAG_MAX);
  out.weapons.ammo.pistol.reserve = intCap(pa.reserve, d.weapons.ammo.pistol.reserve, PISTOL_RESERVE_MAX);
  if (own.length) {
    out.weapons.owned = own;
    for (const id of own) {
      const L = LONG_GUNS[id];
      const ga = isObj(wp.ammo) && isObj(wp.ammo[id]) ? wp.ammo[id] : {};
      out.weapons.ammo[id] = { mag: intCap(ga.mag, L.mag, L.mag), reserve: intCap(ga.reserve, L.reserve, L.reserveMax) };
    }
  }
  const ms = isObj(m.missions) ? m.missions : {};
  out.missions.completed = numMap(ms.completed, true);
  out.missions.best = numMap(ms.best, false);
  out.missions.cooldowns = numMap(ms.cooldowns, false);
  out.missions.active = activeMission(ms.active);
  const ev = missionEvents(ms.events);
  if (ev) out.missions.events = ev;
  const cl = isObj(m.collect) ? m.collect : {};
  out.collect.checkins = strList(cl.checkins);
  out.collect.foods = strList(cl.foods);
  const rc = raceRecords(m.races);
  if (rc) out.races = rc;
  const sh = safehouseRecord(m.safehouse);
  if (sh) out.safehouse = sh;
  const rp = rampageRecord(m.rampage);
  if (rp) out.rampage = rp;
  const sj = rampageRecord(m.stunts); // 同形 { done: [id] }，清洗規則相同
  if (sj) out.stunts = sj;
  return out;
}

// 記憶體替身（無 localStorage 時）
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch (e) {
    // 部分瀏覽器停用儲存時存取 localStorage 本身就會丟例外
  }
  return memoryStorage();
}

export function createSaveStore({ storage, key = 'tcgta.save', now = () => Date.now() } = {}) {
  const st = storage || defaultStorage();
  const BAK = key + '.bak';
  const CORRUPT = key + '.corrupt';
  let blocked = false; // 讀到較新版本的存檔：不覆寫，直到 clear()

  const get = (k) => {
    try { return st.getItem(k); } catch (e) { return null; }
  };
  const set = (k, v) => {
    try { st.setItem(k, v); return true; } catch (e) { return false; }
  };
  const remove = (k) => {
    try { st.removeItem(k); } catch (e) { /* 忽略 */ }
  };

  // 讀一個槽：{ kind: 'empty'|'ok'|'bad'|'newer', raw, data }
  function readSlot(k) {
    const raw = get(k);
    if (raw === null || raw === undefined) return { kind: 'empty', raw: null, data: null };
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return { kind: 'bad', raw, data: null }; }
    if (isObj(obj) && typeof obj.version === 'number' && obj.version > SAVE_VERSION) {
      return { kind: 'newer', raw, data: null };
    }
    const data = validateSave(obj);
    return data ? { kind: 'ok', raw, data } : { kind: 'bad', raw, data: null };
  }

  function load() {
    const main = readSlot(key);
    if (main.kind === 'ok') {
      set(BAK, JSON.stringify(main.data));
      return { data: main.data, status: 'ok' };
    }
    if (main.kind === 'newer') {
      blocked = true;
      return { data: defaultSave(), status: 'incompatible' };
    }
    if (main.kind === 'bad') set(CORRUPT, main.raw);
    const bak = readSlot(BAK);
    if (bak.kind === 'ok') return { data: bak.data, status: 'recovered' };
    if (bak.kind === 'newer') {
      blocked = true;
      return { data: defaultSave(), status: 'incompatible' };
    }
    if (main.kind === 'empty' && bak.kind === 'empty') return { data: defaultSave(), status: 'new' };
    if (main.kind === 'empty' && bak.kind === 'bad') set(CORRUPT, bak.raw);
    // 主檔與備份都救不回：原文已留在 .corrupt，清掉壞槽，下次啟動不再重複報損毀（開新局存檔後也不會被壞 .bak 蓋回）
    if (main.kind === 'bad') remove(key);
    if (bak.kind === 'bad') remove(BAK);
    return { data: defaultSave(), status: 'corrupt-reset' };
  }

  function save(data) {
    if (blocked) return false;
    const clean = validateSave(data);
    if (!clean) return false;
    let t = 0;
    try { t = now(); } catch (e) { t = 0; }
    clean.savedAt = nonNeg(t, 0);
    let text;
    try { text = JSON.stringify(clean); } catch (e) { return false; }
    return set(key, text);
  }

  function clear() {
    remove(key);
    remove(BAK);
    remove(CORRUPT);
    blocked = false;
  }

  // 有可「繼續」的存檔（主鍵或備份可讀且相容）
  function hasSave() {
    return readSlot(key).kind === 'ok' || readSlot(BAK).kind === 'ok';
  }

  return { load, save, clear, hasSave, get blocked() { return blocked; } };
}

// 自動存檔：tick 累計滿 intervalSec 存一次；flush(reason) 立即存（切背景、暫停、回主選單時）
export function createAutosave({ store, getState, intervalSec = 15 }) {
  let acc = 0;
  let lastReason = null;

  function doSave(reason) {
    acc = 0;
    let state;
    try {
      state = getState();
    } catch (e) {
      console.error('[save] getState 失敗，略過本次存檔', e);
      return false;
    }
    lastReason = reason;
    try {
      return store.save(state) === true;
    } catch (e) {
      console.error('[save] 存檔失敗', e);
      return false;
    }
  }

  return {
    tick(dt) {
      if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return false;
      acc += dt;
      if (acc < intervalSec) return false;
      return doSave('interval');
    },
    flush(reason = 'manual') {
      return doSave(reason);
    },
    get lastReason() { return lastReason; },
  };
}
