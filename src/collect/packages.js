// 隱藏包裹（Phase 17，GTA 經典 Hidden Packages）：全城 PACKAGE_TOTAL 個藏在巷弄 / 後巷停車角落 / 橋邊 / 河岸 / 秋紅谷步道與湖岸 / 老虎城下沉廣場 / 公園角落的太陽餅盒，
//   玩家（徒步或車內）水平 PACKAGE_RADIUS 內（且高差 ≤ PICKUP_DY）自動收集（不需按 E）→ 每個 REWARD、toast「隱藏包裹 N / 20」；
//   收集達 5 / 10 / 15 / 20 解鎖安全屋補給（MILESTONES），每次 safehouse:enter 依已達里程碑補給一次（resupply）；20 個找齊另給 COMPLETE_BONUS（一次性）。
// 純邏輯模組，不 import three：3D 圖示在 createPackageMesh（THREE 由參數注入，全部 20 個 = 1 個 InstancedMesh = 1 draw call，頂點色、MeshBasicMaterial，
//   無貼圖 / 光源 / 陰影；已收集者矩陣縮成 0）；createPackages 透過 view（set / commit）推矩陣，無 view 時只跑邏輯（node 測試）
//
// createPackages({ bus?, groundAt?(x, z) → y, list = PACKAGES, earn?(n, reason), toast?(text, sec), weapons?, view?, radius = PACKAGE_RADIUS })
//   → { list, total, found（數量）, tier（已解鎖里程碑 0..4）, bonusPaid, update(dt, playerPos), collect(id) → boolean, isFound(id),
//       resupply({ save? }) → { tier, items, changed, saved }|null, markers(out?) → out, progress() → { found, total, done }, progressText(), cancel(), serialize(), restore(rec), dispose() }
//   playerPos = { x, y?, z }（駕駛中 = 車身位置）；y 缺 / 非有限數 → 只比水平距離
//   weapons = 武器狀態機（src/weapons/weapons.js：owns(id) / give(id) / addAmmo(n, id)）；resupply 以此給武器 / 補彈
//   view = { set(i, x, y, z, rotY, visible), commit() }（createPackageMesh 的回傳值）
// 動畫：只有距玩家 ≤ ANIM_RANGE 的未收集包裹每幀更新（上下浮動 BOB、慢速自轉 SPIN）；其餘維持靜止姿態，矩陣不重寫
// 補給（resupplyItems / applyResupply，純函式）：已達最高 tier 以下各 tier 的武器累計補給——缺武器 → give（附贈彈藥）、已有 → addAmmo 補到 reserveMax；
//   tier 4（20 個）= 全槍（手槍 / 衝鋒槍 / 散彈槍）缺則給、一律補滿；手槍備彈無限（addAmmo 回 0，照列）
//   resupply({ save? })：changed = 有任一 given 或 ammo > 0；只有 changed 才呼叫 save()（main：autosave.flush('safehouse-resupply')，讓補給入檔）並 toast
//   resupplyNotice（存檔結果前綴 + 補給文字，同一則；saved = save() 結果，未傳 save → null）；未 changed → 不存檔、不 toast（安全屋存檔提示保留）
// 存檔 packages：{ found: [id], tier: 0..4, bonus: boolean }；一個都沒收集 → serialize 回 null（省略）；舊存檔缺欄位 → 0 收集
//   restore：只收 list 內的 id、tier 依數量推得（不重發里程碑事件）、bonus 依存檔（20 個已找齊且已付過才為 true）
// 事件（bus）：package:collect { id, found, total, reward } / package:milestone { tier, found, unlock } / package:resupply { tier, items }；
//   收集時另發 ui:sound { kind: 'reward' }（音效沿用 ui_reward）
// 每幀路徑（update / markers / progress）不配置物件；事件 payload 只在事件發生時配置
export const PACKAGE_TOTAL = 20;
export const PACKAGE_RADIUS = 2.5; // m，自動收集半徑（水平）
export const PICKUP_DY = 4; // m，收集高差上限（秋紅谷谷底 / 地面落差）
export const REWARD = 100; // NT$ / 個
export const COMPLETE_BONUS = 10000; // NT$，20 個找齊一次性獎金
export const ANIM_RANGE = 60; // m，此距離內才更新旋轉 / 浮動
export const MIN_GAP = 120; // m，包裹彼此最小距離（測試驗證）
export const LIFT = 0.55; // m，離地高度
export const BOB = 0.12; // m，浮動幅度
export const BOB_SPEED = 2.2; // rad/s
export const SPIN = 1.2; // rad/s，自轉
export const MARKER_KIND = 'package'; // 大地圖：已收集者（淡化），未收集不標示
export const MILESTONES = Object.freeze([
  Object.freeze({ tier: 1, at: 5, unlock: 'pistol', weapons: Object.freeze(['pistol']), label: '手槍 + 彈藥' }),
  Object.freeze({ tier: 2, at: 10, unlock: 'smg', weapons: Object.freeze(['smg']), label: '衝鋒槍 + 彈藥' }),
  Object.freeze({ tier: 3, at: 15, unlock: 'shotgun', weapons: Object.freeze(['shotgun']), label: '散彈槍 + 彈藥' }),
  Object.freeze({ tier: 4, at: 20, unlock: 'all', weapons: Object.freeze(['pistol', 'smg', 'shotgun']), label: '全武器彈藥補滿' }),
]);
export const WEAPON_LABELS = Object.freeze({ pistol: '手槍', smg: '衝鋒槍', shotgun: '散彈槍' });
export const AMMO_MAX = Object.freeze({ pistol: 120, smg: 300, shotgun: 60 }); // 同 src/weapons/defs.js reserveMax（測試交叉比對）
export const toastCollect = (n, total = PACKAGE_TOTAL) => `隱藏包裹 ${n} / ${total}（+NT$${REWARD}）`;
export const toastMilestone = (m) => `隱藏包裹 ${m.at} 個：安全屋解鎖補給「${m.label}」`;
export const toastComplete = (n) => `全部隱藏包裹找齊！獎金 NT$${n}，安全屋補給全武器彈藥`;

// 已收集 n 個 → 已達里程碑 tier（0..4）
export function tierFor(n) {
  let t = 0;
  for (const m of MILESTONES) if (n >= m.at) t = m.tier;
  return t;
}

// tier → 本次補給的武器清單（累計、去重，依 MILESTONES 順序 = pistol / smg / shotgun）；fill = 已有者補到上限（tier 4 新給的也補滿）
export function resupplyItems(tier) {
  const ids = [];
  for (const m of MILESTONES) if (m.tier <= tier) for (const id of m.weapons) if (!ids.includes(id)) ids.push(id);
  return ids.map((weapon) => ({ weapon, fillNew: tier >= 4 }));
}

// 對 weapons 執行 tier 補給 → [{ weapon, given, ammo（實際加入備彈數）}]；weapons 缺 → 全部 given false、ammo 0
export function applyResupply(weapons, tier) {
  const out = [];
  for (const it of resupplyItems(tier)) {
    let given = false;
    let ammo = 0;
    if (weapons) {
      const had = typeof weapons.owns === 'function' ? !!weapons.owns(it.weapon) : false;
      if (!had && typeof weapons.give === 'function') given = weapons.give(it.weapon) === true;
      if ((had || (given && it.fillNew)) && typeof weapons.addAmmo === 'function') ammo = Number(weapons.addAmmo(AMMO_MAX[it.weapon], it.weapon)) || 0;
    }
    out.push({ weapon: it.weapon, given, ammo });
  }
  return out;
}

export function resupplyText(tier, items) {
  const parts = items.map((it) => (it.given ? `${WEAPON_LABELS[it.weapon]}（新取得）` : `${WEAPON_LABELS[it.weapon]}彈藥${it.ammo > 0 ? ` +${it.ammo}` : ''}`));
  return `安全屋補給（隱藏包裹里程碑 ${tier}）：${parts.join('、')}`;
}

// 補給 toast 文字：saved true / false = 補給後再存檔的結果（前綴存檔提示）；null = 未存檔（除錯直接呼叫）→ 只有補給文字
export const RESUPPLY_SAVED_TEXT = '已在安全屋存檔，體力回滿。';
export const RESUPPLY_SAVE_FAILED_TEXT = '體力回滿（存檔失敗，請稍後再試）。';
export function resupplyNotice(tier, items, saved = null) {
  const head = saved === true ? RESUPPLY_SAVED_TEXT : saved === false ? RESUPPLY_SAVE_FAILED_TEXT : '';
  return `${head}${resupplyText(tier, items)}`;
}

// 點位（遊戲世界 x / z，m；y 由 groundAt 決定，秋紅谷 / 下沉廣場為谷底 / 廣場面高度）：離線以 osm-city.json + terrain.js 挑選後寫死——
//   巷弄 / 後巷 = 窄路（residential / service）路緣外 0.6 m、貼建築 1.5–4 m；橋下 = 橋面側緣外 2–3.5 m；河岸 = 橋頭兩側 6 m；
//   秋紅谷步道 / 湖岸 = 谷地步道（walkway）與湖岸 2–5 m；下沉廣場角落；公園角落 = 頂點往形心內縮 12%
//   一律放地面（無可由坡道 / 樓梯到達的樓頂資料，不放樓頂）；離建築 ≥ 1.5 m、不在車流道路路面（半寬 + 1 m）、不在巷道中央（半寬 − 1 m 內）、
//   不在水面 / 湖底、地圖內 20 m、離小吃點 / 安全屋 / 特技跳台 ≥ 25 m、彼此 ≥ MIN_GAP（實際最近約 165 m）；tools/test/p17-packages.mjs 以原始資料重驗
export const PACKAGES = Object.freeze([
  { id: 'pkg-01', x: 1161.9, z: 510.7, spot: '巷弄', hint: '大墩十九街' },
  { id: 'pkg-02', x: -339.3, z: 768.3, spot: '後巷停車角落', hint: '西南角後巷' },
  { id: 'pkg-03', x: -51.9, z: -452.6, spot: '橋下', hint: '朝馬一橋' },
  { id: 'pkg-04', x: 954, z: -513.4, spot: '河岸', hint: '青海一號橋' },
  { id: 'pkg-05', x: 196.9, z: -255.9, spot: '秋紅谷步道', hint: '秋紅谷' },
  { id: 'pkg-06', x: 106.9, z: -393.9, spot: '秋紅谷湖岸', hint: '秋紅谷' },
  { id: 'pkg-07', x: 8.9, z: -8.6, spot: '下沉廣場角落', hint: '老虎城下沉廣場' },
  { id: 'pkg-08', x: 583, z: 383.1, spot: '公園角落', hint: '夏綠地公園' },
  { id: 'pkg-09', x: 115.8, z: 469.3, spot: '巷弄', hint: '市政路南側巷弄' },
  { id: 'pkg-10', x: 1221.9, z: -35.8, spot: '後巷停車角落', hint: '駐車彎' },
  { id: 'pkg-11', x: 642.2, z: -234.3, spot: '橋下', hint: '惠來一號橋' },
  { id: 'pkg-12', x: -403.1, z: -334.2, spot: '河岸', hint: '朝貴橋' },
  { id: 'pkg-13', x: -573.8, z: 20.4, spot: '公園角落', hint: '龍門公園' },
  { id: 'pkg-14', x: 60.2, z: 879.2, spot: '巷弄', hint: '惠來路一段' },
  { id: 'pkg-15', x: 879.2, z: 733.1, spot: '後巷停車角落', hint: '得來速車道旁' },
  { id: 'pkg-16', x: 1313.4, z: -412.6, spot: '公園角落', hint: '洛陽公園' },
  { id: 'pkg-17', x: -129.5, z: 576.5, spot: '巷弄', hint: '惠文七街' },
  { id: 'pkg-18', x: 357, z: 90.7, spot: '公園角落', hint: '街角小公園' },
  { id: 'pkg-19', x: 428.1, z: -352.1, spot: '巷弄', hint: '杏林路26巷' },
  { id: 'pkg-20', x: 803.7, z: 150.7, spot: '後巷停車角落', hint: '大樓後巷' },
].map((p) => Object.freeze(p)));

const ID_RE = /^[\w-]{1,64}$/;

export function createPackages({
  bus = null,
  groundAt = null,
  list = PACKAGES,
  earn = null,
  toast = null,
  weapons = null,
  view = null,
  radius = PACKAGE_RADIUS,
} = {}) {
  const emit = (n, p) => {
    if (bus) bus.emit(n, p);
  };
  const say = (text, sec = 3) => {
    if (toast && text) toast(text, sec);
  };
  const items = list.map((p, i) => {
    const g = typeof groundAt === 'function' ? Number(groundAt(p.x, p.z)) : 0;
    return { id: p.id, x: p.x, z: p.z, y: Number.isFinite(g) ? g : 0, i, found: false, anim: false };
  });
  const total = items.length;
  const byId = new Map(items.map((it) => [it.id, it]));
  let found = 0;
  let tier = 0;
  let bonusPaid = false;
  let t = 0;
  let disposed = false;
  const r2 = radius * radius;
  const a2 = ANIM_RANGE * ANIM_RANGE;
  const markerList = [];
  let markersDirty = true;
  const prog = { found: 0, total, done: 0 };

  // 靜止姿態（離開動畫範圍 / 讀檔 / cancel）：未收集 = 離地 LIFT、固定朝向；已收集 = 隱藏
  function pose(it) {
    if (!view) return;
    if (it.found) view.set(it.i, it.x, it.y, it.z, 0, false);
    else view.set(it.i, it.x, it.y + LIFT, it.z, it.i * 0.7, true);
  }
  function poseAll() {
    if (!view) return;
    for (const it of items) {
      it.anim = false;
      pose(it);
    }
    view.commit();
  }

  function grantMilestones(prevTier) {
    for (const m of MILESTONES) {
      if (m.tier <= prevTier || m.tier > tier) continue;
      emit('package:milestone', { tier: m.tier, found, unlock: m.unlock });
      if (m.tier === 4) {
        if (!bonusPaid) {
          bonusPaid = true;
          if (typeof earn === 'function') earn(COMPLETE_BONUS, 'package');
          say(toastComplete(COMPLETE_BONUS), 5);
        }
      } else say(toastMilestone(m), 4);
    }
  }

  function take(it) {
    if (disposed || !it || it.found) return false;
    it.found = true;
    it.anim = false;
    found++;
    markersDirty = true;
    if (view) {
      pose(it);
      view.commit();
    }
    if (typeof earn === 'function' && REWARD > 0) earn(REWARD, 'package');
    emit('package:collect', { id: it.id, found, total, reward: REWARD });
    emit('ui:sound', { kind: 'reward' });
    say(toastCollect(found, total), 2.5);
    const prev = tier;
    tier = Math.max(tier, tierFor(found));
    if (tier > prev) grantMilestones(prev);
    return true;
  }

  function update(dt, pos) {
    if (disposed) return;
    t += dt > 0 ? dt : 0;
    if (t > 1e4) t -= 1e4;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;
    const hasY = Number.isFinite(pos.y);
    let dirty = false;
    for (let k = 0; k < total; k++) {
      const it = items[k];
      if (it.found) continue;
      const dx = pos.x - it.x;
      const dz = pos.z - it.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2 && (!hasY || Math.abs(pos.y - it.y) <= PICKUP_DY)) {
        take(it);
        continue;
      }
      if (!view) continue;
      if (d2 <= a2) {
        it.anim = true;
        view.set(k, it.x, it.y + LIFT + Math.sin(t * BOB_SPEED + k) * BOB, it.z, t * SPIN + k * 0.7, true);
        dirty = true;
      } else if (it.anim) {
        it.anim = false; // 剛離開範圍：回靜止姿態一次
        pose(it);
        dirty = true;
      }
    }
    if (dirty) view.commit();
  }

  // 安全屋補給：依已達 tier 補給一次（未達 5 個 → null，不發事件）；實際有給武器 / 補到彈藥才 toast（否則不蓋掉安全屋的存檔提示）；
  //   save?() → boolean：有補給時先再存一次（補給入檔），存檔結果併入同一則 toast（存檔失敗字樣不被補給訊息蓋掉）
  function resupply({ save = null } = {}) {
    if (disposed || tier <= 0) return null;
    const items2 = applyResupply(weapons, tier);
    emit('package:resupply', { tier, items: items2 });
    const got = items2.filter((it) => it.given || it.ammo > 0);
    let saved = null;
    if (got.length) {
      if (typeof save === 'function') {
        try {
          saved = save() === true;
        } catch (err) {
          saved = false;
        }
      }
      say(resupplyNotice(tier, got, saved), 4);
    }
    return { tier, items: items2, changed: got.length > 0, saved };
  }

  // 已收集者（大地圖淡化小圖示；未收集不標示）。out 省略 = 內部重用陣列
  function markers(out) {
    if (markersDirty) {
      markerList.length = 0;
      for (const it of items) if (it.found) markerList.push({ x: it.x, z: it.z, kind: MARKER_KIND, id: it.id });
      markersDirty = false;
    }
    if (!out) return markerList;
    for (let k = 0; k < markerList.length; k++) out.push(markerList[k]);
    return out;
  }

  function serialize() {
    if (found === 0 && !bonusPaid) return null;
    return { found: items.filter((it) => it.found).map((it) => it.id), tier, bonus: bonusPaid };
  }

  function restore(rec) {
    found = 0;
    for (const it of items) it.found = false;
    const ids = rec && typeof rec === 'object' && Array.isArray(rec.found) ? rec.found : [];
    for (const id of ids) {
      if (typeof id !== 'string' || !ID_RE.test(id)) continue;
      const it = byId.get(id);
      if (!it || it.found) continue;
      it.found = true;
      found++;
    }
    tier = tierFor(found); // 以數量為準（存檔 tier 僅供檢視；被改大也不會多解鎖）
    bonusPaid = !!(rec && rec.bonus === true) && found >= total; // 未找齊時 bonus 旗標無效（髒 / 手改存檔）→ 收齊時照常發一次
    // 已找齊但存檔沒記到獎金（理論上不會發生）：不補發，避免讀檔刷錢
    markersDirty = true;
    poseAll();
  }

  function cancel() {
    t = 0;
    poseAll();
  }

  function dispose() {
    disposed = true;
    if (view && typeof view.dispose === 'function') view.dispose();
  }

  poseAll();

  return {
    list: items,
    total,
    get found() {
      return found;
    },
    get tier() {
      return tier;
    },
    get bonusPaid() {
      return bonusPaid;
    },
    update,
    collect: (id) => take(byId.get(id)),
    isFound: (id) => {
      const it = byId.get(id);
      return !!(it && it.found);
    },
    resupply,
    markers,
    progress() {
      prog.found = found;
      prog.done = found;
      prog.total = total;
      return prog;
    },
    progressText: () => `隱藏包裹 ${found} / ${total}`,
    cancel,
    serialize,
    restore,
    dispose,
  };
}

// 太陽餅盒幾何（BoxGeometry 3 段高 + 頂點色）：盒身金黃、中段紅色封條、盒蓋奶油色；純程式、不用貼圖
export const BOX_SIZE = Object.freeze({ w: 0.6, h: 0.34, d: 0.6 });
const COL_BODY = [1.0, 0.72, 0.18];
const COL_BAND = [0.92, 0.16, 0.12];
const COL_LID = [1.0, 0.95, 0.7];

export function buildPackageGeometry(THREE) {
  const geo = new THREE.BoxGeometry(BOX_SIZE.w, BOX_SIZE.h, BOX_SIZE.d, 1, 3, 1);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const top = BOX_SIZE.h / 2 - 1e-4;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const c = y >= top ? COL_LID : Math.abs(y) < BOX_SIZE.h / 4 ? COL_BAND : COL_BODY;
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// 全部包裹 = 1 個 InstancedMesh（1 draw call）；回傳 view 給 createPackages。set 重用同一個 Matrix4
export function createPackageMesh({ THREE, scene = null, count = PACKAGE_TOTAL } = {}) {
  const geo = buildPackageGeometry(THREE);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'hidden-packages';
  mesh.frustumCulled = false; // instance 遍布全城，包圍球不準
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const m4 = new THREE.Matrix4();
  if (scene) scene.add(mesh);
  return {
    mesh,
    set(i, x, y, z, rotY, visible) {
      if (visible) m4.makeRotationY(rotY);
      else m4.makeScale(0, 0, 0);
      m4.setPosition(x, visible ? y : y - 1000, z);
      mesh.setMatrixAt(i, m4);
    },
    commit() {
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      if (mesh.parent) mesh.parent.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
