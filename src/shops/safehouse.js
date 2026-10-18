// 安全屋（Phase 14）：1 間（出生點附近），門口藍色小光柱（BEACON_COLORS.safehouse #1e88e5）+ 小地圖 / 大地圖 kind 'safehouse'
// 步行進入 SAFEHOUSE_RADIUS 內按互動鍵 → 回滿血、通緝清零、記為「最後使用的安全屋」、立即存檔（toast 提示）；
//   有通緝星數時不可進入（toast WANTED_TEXT「先甩掉警察」）；busy() 回非空字串（例：搶劫中）時也不可進入並提示該字串
// 載入遊戲（繼續）：存檔 safehouse.last 為已知安全屋 → 從該安全屋門口出生（spawnPoint）；舊存檔沒有此欄 → 沿用存檔位置 / 出生點
// 純邏輯不 import three：光柱池、存檔、回血、清通緝、toast 由整合層注入
//
// 點位：src/data/osm-city.json 河南路三段（路寬 12 m）路緣外 2.5 m 的人行道，出生點（老虎城外河南路三段側，約 x 45.4, z 26.8）
//   沿河南路往南約 81 m；離建築輪廓 ≥ 1.5 m、不在車道（0.8 m 餘裕）、不在水域、離路口 ≥ 14 m、離泊車亭 / 競速起點 / 彈藥點 ≥ 22 m；
//   yaw 面向道路（出門就是河南路）；tools/test/p14-shops.mjs 以 osm-city.json 重驗並驗步行可達
//
// createSafehouses({ bus?, getStars() → number, beacons?, save() → boolean, heal(), clearWanted(), toast?(text, sec), busy?() → string|null,
//   places = SAFEHOUSES })
//   → { places, lastUsed（id|null）, nearest(pos) → interactable|null, enter(id) → { ok, reason, saved? }, serialize() → { last }|null,
//       restore(rec), spawnPoint(rec?) → { id, x, z, yaw }|null, update(dt), markers(), cancel(), dispose() }
//   interactable：{ id: 'safehouse:<id>', text, dist, priority: SAFEHOUSE_PRIORITY, act() }（act = enter）
//   reason：'wanted' | 'busy' | 'unknown'
// 事件（bus）：safehouse:enter { id, x, z, saved } / safehouse:refused { id, reason }
// 每幀（update / nearest / markers）不配置新物件

export const SAFEHOUSE_RADIUS = 2.5;
export const SAFEHOUSE_PRIORITY = 2; // 同武器店 / 打卡；委託 3 優先
export const SAFEHOUSE_BEACON = { height: 7, radius: 0.7, sink: 1 };
export const WANTED_TEXT = '警察還在追你！先甩掉警察再回安全屋。';
export const SAVED_TEXT = '已在安全屋存檔，體力回滿。下次「繼續」從這裡出發。';
export const PROMPT_TEXT = '按 E 進安全屋（存檔 / 回滿血）';

export const SAFEHOUSES = Object.freeze([
  Object.freeze({ id: 'safehouse-henan', name: '河南路安全屋', x: 42.0, z: 108.1, yaw: -2.102, road: '河南路三段' }),
]);

export function createSafehouses({
  bus = null,
  getStars = () => 0,
  beacons = null,
  save = () => false,
  heal = () => {},
  clearWanted = () => {},
  toast = null,
  busy = null,
  places = SAFEHOUSES,
} = {}) {
  const emit = (n, p) => {
    if (bus) bus.emit(n, p);
  };
  const say = (text, sec = 3) => {
    if (toast && text) toast(text, sec);
  };
  let disposed = false;
  let last = null;
  const pillars = beacons ? places.map((s) => beacons.acquire('safehouse', s.x, s.z, s)) : [];
  const markerList = places.map((s) => ({ x: s.x, z: s.z, kind: 'safehouse', label: s.name }));
  const inter = { id: '', text: PROMPT_TEXT, dist: 0, priority: SAFEHOUSE_PRIORITY, act: null, place: null };
  inter.act = () => (inter.place ? enter(inter.place.id).ok : false);
  const byId = (id) => places.find((s) => s.id === id) || null;

  function enter(id) {
    const s = byId(id);
    if (disposed || !s) return { ok: false, reason: 'unknown' };
    if ((Number(getStars()) || 0) > 0) {
      say(WANTED_TEXT, 3);
      emit('safehouse:refused', { id, reason: 'wanted' });
      return { ok: false, reason: 'wanted' };
    }
    const why = busy ? busy() : null;
    if (why) {
      say(why, 2.5);
      emit('safehouse:refused', { id, reason: 'busy' });
      return { ok: false, reason: 'busy' };
    }
    heal();
    clearWanted();
    last = s.id; // 先記錄再存檔：存檔內容帶 safehouse.last
    let saved = false;
    try {
      saved = save() === true;
    } catch (err) {
      saved = false;
    }
    say(saved ? SAVED_TEXT : '體力回滿（存檔失敗，請稍後再試）', 3);
    emit('safehouse:enter', { id: s.id, x: s.x, z: s.z, saved });
    return { ok: true, reason: null, saved };
  }

  function nearest(pos) {
    if (disposed || !pos) return null;
    let best = null;
    let bestD = SAFEHOUSE_RADIUS;
    for (const s of places) {
      const d = Math.hypot(pos.x - s.x, pos.z - s.z);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return null;
    inter.id = `safehouse:${best.id}`;
    inter.dist = bestD;
    inter.place = best;
    return inter;
  }

  const serialize = () => (last ? { last } : null);

  // 讀檔：rec = 存檔 safehouse 欄（{ last }）；未知 id / 缺 → null
  function restore(rec) {
    last = rec && typeof rec.last === 'string' && byId(rec.last) ? rec.last : null;
    return last;
  }

  // 出生點：rec 省略 = 目前 lastUsed；未知 → null（整合層退回存檔位置 / 出生點）
  function spawnPoint(rec) {
    const id = rec === undefined ? last : rec && typeof rec.last === 'string' ? rec.last : null;
    const s = id ? byId(id) : null;
    return s ? { id: s.id, x: s.x, z: s.z, yaw: s.yaw } : null;
  }

  function update(dt) {
    if (!disposed && beacons && beacons.update) beacons.update(dt);
  }

  function dispose() {
    disposed = true;
    if (beacons) for (const b of pillars) beacons.release(b);
  }

  return {
    places,
    get lastUsed() {
      return last;
    },
    nearest,
    enter,
    serialize,
    restore,
    spawnPoint,
    update,
    markers: () => markerList,
    cancel() {},
    dispose,
  };
}
