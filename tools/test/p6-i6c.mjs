#!/usr/bin/env node
// Phase 6 I6c 接線回歸：打工委託進遊戲 + 新道具擺放（docs/dev/interfaces.md §23.4、§24；§20 時間步）
// 用法：node tools/test/p6-i6c.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）；不需要 node_modules（three 只在選用段，缺 → SKIP 不計分）
// 項目：
//   1. createMissions 注入（原始碼）：jobSpots { stall, stallBack, sidewalkNear, valet }、spawnValetCar / releaseValetCar / healthOf、missionCtx.vehicle；hud.js job 跳字 / job-car 貼邊
//   2. 車輛轉接（main.js 原始碼抽出、假 vehicles / dmg 執行）：adopt + attach、release 拉手煞 + 回收名單、下一趟清掉留在車格的舊車
//      + 真 createJobs 跑一趟代客泊車（注入 job-props 座標與上述轉接）：接單 → 上車 → 停妥 1 s → 入帳 'job'、release
//   3. 手機打工分頁：jobs.listings 帶 category 'job' → createPhoneLink.frame → phone.setData 收到
//   4. 道具鍵名退回：resolvePropKey / stallRow（變體缺 → 原攤車、全缺 → 不擺無碰撞）、泊車亭缺模型 → 程式幾何、鍵名都在 manifest
//   5. 泊車亭碰撞盒只取亭身（不含立牌與空隙、yaw 旋轉後仍成立）、攤位碰撞盒 = propColliderBox('night_market_stall')
//   6. 地圖選點（真 citymodel）：三格攤位 / stallBack / 泊車亭 / 客人車 / 車格位置合格；sidewalkNear 距離帶與路緣外
//   7. events.js：simDt = 0 不開放、不判定逾時 / 抵達（step <= 0 早退）
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

let pass = 0;
let fail = 0;
function check(name, cond, info = '') {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}${info ? ' — ' + info : ''}`);
  }
}
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const mainSrc = read('src/main.js');
const hudSrc = read('src/hud.js');
const manifest = JSON.parse(read('public/models/props/manifest.json'));
const manifestIds = new Set(manifest.props.map((p) => p.id));
const JP = await import('../../src/job-props.js');
const { propColliderBox, propWorldPoint } = await import('../../src/prop-model.js');
const { createJobs, NIGHT_MARKET_RUN, VALET_PARKING } = await import('../../src/missions/jobs.js');

// ======================= 1. createMissions 注入（原始碼） =======================
{
  const i = mainSrc.indexOf('const missions = createMissions({');
  const call = mainSrc.slice(i, mainSrc.indexOf('\n  });', i));
  check('createMissions：jobSpots = { stall: runStall.stall, stallBack: runStall.stallBack, sidewalkNear, valet: valetSites }',
    i > 0 && call.includes('jobSpots: { stall: runStall.stall, stallBack: runStall.stallBack, sidewalkNear, valet: valetSites },'));
  check('createMissions：spawnValetCar / releaseValetCar / healthOf: (v) => dmg.healthOf(v)',
    /\n\s+spawnValetCar,\n/.test(call) && /\n\s+releaseValetCar,\n/.test(call) && call.includes('healthOf: (v) => dmg.healthOf(v),'));
  check('createMissions 之前已建好 vehicles / dmg / adopted（閉包取用）',
    mainSrc.indexOf('const vehicles = new VehicleManager(') < i && mainSrc.indexOf('const dmg = createVehicleDamage(') < i && mainSrc.indexOf('const adopted = new Set();') < i);
  check('sidewalkNear = createSidewalkNear({ nearestRoadPoint, onRoadSurface, buildingAt, inBounds })',
    mainSrc.includes('const sidewalkNear = createSidewalkNear({ nearestRoadPoint, onRoadSurface, buildingAt, inBounds });'));
  const iv = mainSrc.indexOf('missionCtx.vehicle = v;');
  const iu = mainSrc.indexOf('missions.update(worldStep.simDt, missionCtx);');
  check('missionCtx 帶 vehicle（初值 null），每幀在 missions.update 之前寫入駕駛中的車',
    /const missionCtx = \{[^}]*\bvehicle: null\b[^}]*\}/.test(mainSrc) && iv > 0 && iu > iv && mainSrc.includes('const v = driving ? state.vehicle : null;'));
  check('hud.js：MONEY_REASON_LABEL.job = \'打工 \'', /MONEY_REASON_LABEL = \{[^}]*\bjob: '打工 '/.test(hudSrc));
  check('hud.js：EDGE_KINDS 含 job-car', /const EDGE_KINDS = new Set\(\[[^\]]*'job-car'/.test(hudSrc));
  check('takeout_bag：每幀 syncTakeoutBags 在 missions.update 之後（依 jobs.isOpen(\'night-market-run\')）',
    mainSrc.indexOf('syncTakeoutBags();') > iu && mainSrc.includes("missions.jobs.isOpen('night-market-run')"));
  check('垃圾車仍不進 traffic CAR_TYPES', !/const CAR_TYPES = \[[^\]]*garbage_truck/.test(read('src/traffic.js')));
}

// ======================= 2. 車輛轉接（main.js 抽出執行） =======================
const adapterSrc = (() => {
  const a = mainSrc.indexOf('  const valetCars = new Set();');
  const b = mainSrc.indexOf('  // 夜市跑單的客人點', a);
  return a > 0 && b > a ? mainSrc.slice(a, b) : '';
})();
const constSrc = (name) => {
  const m = mainSrc.match(new RegExp(`^const ${name} = [^;]*;`, 'm'));
  return m ? m[0] : '';
};
check('main.js：抽得到泊車轉接區塊與 VALET_CLEAR_M / VALET_CAR_LOOKS', !!adapterSrc && !!constSrc('VALET_CLEAR_M') && !!constSrc('VALET_CAR_LOOKS'));
function makeAdapters() {
  const log = [];
  const vehicles = {
    vehicles: [],
    adopt(p) {
      const v = { ...p, pos: { x: p.x, z: p.z }, speed: 0, driven: false, controls: null, setControls(c) { this.controls = c; } };
      this.vehicles.push(v);
      log.push(['adopt', p]);
      return v;
    },
    remove(v) {
      const i = this.vehicles.indexOf(v);
      if (i >= 0) this.vehicles.splice(i, 1);
      log.push(['remove', v]);
      return i >= 0;
    },
  };
  const health = new Map();
  const dmg = {
    attach: (v) => { health.set(v, 100); log.push(['attach', v]); },
    detach: (v) => { health.delete(v); log.push(['detach', v]); },
    healthOf: (v) => (health.has(v) ? health.get(v) : 100),
  };
  const adopted = new Set();
  const state = { vehicle: null };
  const valetSites = JP.valetSpots(JP.VALET_SITES, () => 10);
  const driveControls = (axis, hb) => ({ throttle: axis.y, steer: -axis.x, brake: 0, handbrake: !!hb });
  const fn = new Function('vehicles', 'dmg', 'adopted', 'state', 'valetSites', 'driveControls',
    `${constSrc('VALET_CLEAR_M')}\n${constSrc('VALET_CAR_LOOKS')}\n${adapterSrc}\nreturn { spawnValetCar, releaseValetCar, valetCars, VALET_CAR_LOOKS };`);
  return { ...fn(vehicles, dmg, adopted, state, valetSites, driveControls), vehicles, dmg, adopted, state, valetSites, health, log };
}
if (adapterSrc) {
  const A = makeAdapters();
  const s0 = A.valetSites[0];
  const car = A.spawnValetCar({ x: s0.carX, z: s0.carZ, yaw: s0.carYaw });
  check('spawnValetCar：vehicles.adopt({ type, color, x, z, yaw }) + dmg.attach，回傳同一物件',
    A.vehicles.vehicles.includes(car) && car.x === s0.carX && car.z === s0.carZ && car.yaw === s0.carYaw && A.log.some((e) => e[0] === 'attach' && e[1] === car)
    && A.VALET_CAR_LOOKS.some((l) => l.type === car.type && l.color === car.color));
  check('泊車客人車型不含機車 / 大車 / 垃圾車', A.VALET_CAR_LOOKS.every((l) => ['sedan', 'suv'].includes(l.type)));
  check('spawn 之後尚未列入 adopted（打工中不被回收）', !A.adopted.has(car));
  // 開到車格停好、下車 → release：拉手煞 + 回收名單
  car.pos.x = s0.slotX;
  car.pos.z = s0.slotZ;
  A.releaseValetCar(car);
  check('releaseValetCar：無人駕駛 → 拉手煞（停妥後轉路邊停放）+ 加入 adopted（遠離回收）', car.controls && car.controls.handbrake === true && A.adopted.has(car));
  const car2 = A.spawnValetCar({ x: s0.carX, z: s0.carZ, yaw: s0.carYaw });
  check('下一趟接單：清掉留在車格 4 m 內的上一台泊車車（detach + remove）', !A.vehicles.vehicles.includes(car) && A.log.some((e) => e[0] === 'remove' && e[1] === car) && A.vehicles.vehicles.includes(car2));
  car2.driven = true;
  A.state.vehicle = car2;
  A.releaseValetCar(car2);
  check('releaseValetCar：玩家正在開 → 不拉手煞（只列入回收名單）', car2.controls === null && A.adopted.has(car2));
  const before = A.adopted.size;
  A.releaseValetCar({ pos: { x: 0, z: 0 } });
  check('releaseValetCar：不在 VehicleManager 的車忽略；被清掉的舊車也移出 adopted', A.adopted.size === before && !A.adopted.has(car) && !A.valetCars.has(car));

  // 真 createJobs：注入 job-props 座標 + 上述轉接，跑一趟代客泊車
  const B = makeAdapters();
  const s = B.valetSites[0];
  const money = [];
  let t = 0;
  const jobs = createJobs({
    now: () => t, rng: () => 0.5, addMoney: (n, r) => money.push([n, r]), getGameHour: () => 12,
    spots: { stall: { x: 557, z: -127, yaw: 1 }, stallBack: { x: 557.4, z: -128.2 }, sidewalkNear: () => null, valet: B.valetSites },
    spawnValetCar: B.spawnValetCar, releaseValetCar: B.releaseValetCar, healthOf: B.dmg.healthOf,
  });
  const ctx = { x: s.standX, z: s.standZ, driving: false, vehicle: null };
  jobs.update(1 / 60, ctx);
  const it = jobs.nearest({ x: s.standX, z: s.standZ });
  check('代客泊車：站在泊車亭接單點（counter 世界座標）2.5 m 內 → 打工互動', !!it && it.id === 'job:valet-parking');
  if (it) it.act();
  const vcar = B.vehicles.vehicles[0];
  check('代客泊車：接單 → spawnValetCar 於客人車位姿、標記 job-car', !!vcar && vcar.x === s.carX && jobs.markers().some((m) => m.kind === 'job-car'));
  if (vcar) {
    vcar.driven = true;
    Object.assign(ctx, { driving: true, vehicle: vcar });
    vcar.pos.x = s.slotX;
    vcar.pos.z = s.slotZ;
    vcar.yaw = s.slotYaw;
    vcar.speed = 0;
    for (let k = 0; k < 75; k++) {
      t += 1 / 60;
      ctx.x = vcar.pos.x;
      ctx.z = vcar.pos.z;
      jobs.update(1 / 60, ctx);
    }
    check('代客泊車：停妥 1 s → addMoney(n, \'job\')、releaseValetCar（列入回收）', money.length === 1 && money[0][1] === 'job' && money[0][0] > 0 && B.adopted.has(vcar), JSON.stringify(money));
  }
}

// ======================= 3. 手機打工分頁 =======================
{
  const { createPhoneLink } = await import('../../src/ui/phone-link.js');
  const valet = JP.valetSpots(JP.VALET_SITES, () => 0);
  const jobs = createJobs({
    now: () => 0, rng: () => 0.5, getGameHour: () => 19,
    spots: { stall: { x: 557, z: -127, yaw: 1 }, stallBack: { x: 557.4, z: -128.2 }, sidewalkNear: () => ({ x: 600, z: -100 }), valet },
    spawnValetCar: () => ({ pos: { x: 0, z: 0 } }), releaseValetCar: () => {},
  });
  jobs.update(1 / 60, { x: 0, z: 0, driving: false, vehicle: null });
  let got = null;
  const phone = { open: false, isOpen() { return this.open; }, setData(d) { got = d; }, update() {} };
  const out = [];
  const link = createPhoneLink({ phone, input: { enabled: true }, fillData: (d) => { d.jobs = jobs.listings({ x: 0, z: 0 }, (out.length = 0, out)); } });
  link.open = undefined;
  phone.open = true;
  link.frame(1 / 60);
  const ids = got && got.jobs ? got.jobs.filter((j) => j.category === 'job').map((j) => j.id).sort() : [];
  check('手機：注入 jobSpots 後 listings 帶打工兩項（category job），phone.setData 收得到', ids.join(',') === 'night-market-run,valet-parking', ids.join(','));
  const v = got && got.jobs.find((j) => j.id === 'valet-parking');
  check('手機：代客泊車列表項座標 = 接單點、navigable', !!v && near(v.x, valet[0].standX) && near(v.z, valet[0].standZ) && v.navigable === true);
  check('main.js：手機 fillData 仍取 missions.listings(focus, phoneJobs)', mainSrc.includes('d.jobs = missions.listings(focus, phoneJobs);'));
  let THREE = null;
  try {
    THREE = await import('three');
  } catch {
    console.log('SKIP  真 createMissions 段（找不到 three）');
  }
  if (THREE) {
    const { createMissions } = await import('../../src/missions/index.js');
    const ms = createMissions({
      now: () => 0, rng: () => 0.5, getGameHour: () => 19, fetchJson: async () => null, info: () => {}, doc: null,
      jobSpots: { stall: { x: 557, z: -127, yaw: 1 }, stallBack: { x: 557.4, z: -128.2 }, sidewalkNear: () => null, valet },
      spawnValetCar: () => ({ pos: { x: 0, z: 0 } }), releaseValetCar: () => {}, healthOf: () => 100,
    });
    await ms.ready;
    ms.update(1 / 60, { x: 0, z: 0, driving: false, vehicle: null });
    const cats = ms.listings({ x: 0, z: 0 }, []).filter((j) => j.category === 'job').length;
    check('真 createMissions：listings 有打工項', cats >= 1, String(cats));
  }
}

// ======================= 4. 道具鍵名退回 =======================
{
  const has = (set) => (k) => set.has(k);
  check('resolvePropKey：有 → 原鍵；缺 → fallback；都缺 → null',
    JP.resolvePropKey('a', has(new Set(['a', 'b'])), 'b') === 'a' && JP.resolvePropKey('a', has(new Set(['b'])), 'b') === 'b' && JP.resolvePropKey('a', has(new Set()), 'b') === null
    && JP.resolvePropKey('a', has(new Set()), null) === null);
  const base = { x: 100, z: 50, faceX: 100, faceZ: 60 }; // 正面朝 +Z（yaw 0）
  const all = JP.stallRow(base, () => 3, has(manifestIds));
  check('stallRow：三格（原攤車 + oyster + tea），鍵名都在 manifest、全有模型 → 各用自己的鍵',
    all.length === 3 && all.every((r) => manifestIds.has(r.key) && r.model === r.key) && new Set(all.map((r) => r.key)).size === 3, all.map((r) => r.model).join(','));
  const s0 = all.find((r) => r.key === 'night_market_stall');
  check('stallRow：原攤車在 slot 0（= stallPlacement 原位，不動外送取餐點）、y = heightAt、同 yaw',
    near(s0.pl.x, 100) && near(s0.pl.z, 50) && s0.pl.y === 3 && all.every((r) => near(r.pl.yaw, 0)));
  const xs = all.map((r) => r.pl.x).sort((a, b) => a - b);
  check('stallRow：沿路緣（本地 X）間距 2.72 m，相鄰碰撞盒不重疊（2.22 + 0.5）', near(xs[1] - xs[0], 2.72) && near(xs[2] - xs[1], 2.72) && all.every((r) => near(r.pl.z, 50)));
  const noVar = JP.stallRow(base, () => 0, has(new Set(['night_market_stall'])));
  check('變體缺模型 → 該格退回原攤車（night_market_stall），座標不變', noVar.every((r) => r.model === 'night_market_stall') && noVar.every((r, i) => near(r.pl.x, all[i].pl.x)));
  const none = JP.stallRow(base, () => 0, has(new Set()));
  check('原攤車也缺 → 每格不擺（model null）、無碰撞盒，但座標照算', none.every((r) => r.model === null && r.box === null && Number.isFinite(r.pl.x)));
  const rs = JP.runStallSpot(none);
  check('夜市跑單接單攤 = oyster 那格（缺模型照樣給 stall / stallBack 座標）', rs.entry.key === 'night_market_stall_oyster' && rs.stall === rs.entry.pl);
  const back = propWorldPoint([0, 0, -1.38], rs.stall);
  check('stallBack = propWorldPoint([0, 0, −(0.78 + 0.6)], pl)（攤主側）', near(rs.stallBack.x, back.x) && near(rs.stallBack.z, back.z) && near(rs.stallBack.z, 50 - 1.38));
  check('jobs.js 道具鍵（propKey / altPropKeys / fallback）與 job-props 一致且都在 manifest',
    NIGHT_MARKET_RUN.propKey === JP.STALL_RUN_KEY && NIGHT_MARKET_RUN.altPropKeys.every((k) => JP.STALL_ROW.some((r) => r.key === k)) && NIGHT_MARKET_RUN.fallbackPropKey === JP.STALL_BASE_KEY
    && VALET_PARKING.propKey === JP.VALET_STAND_KEY && [JP.VALET_STAND_KEY, JP.TAKEOUT_BAG_KEY, JP.STALL_BASE_KEY].every((k) => manifestIds.has(k)));
  const vInfo = manifest.props.find((p) => p.id === 'valet_stand');
  check('VALET_COUNTER = manifest valet_stand.counter（propInfo 缺時的退回值）', JSON.stringify(JP.VALET_COUNTER) === JSON.stringify(vInfo.counter));
  check('main.js：valet_stand 有模型用 createPropModel、缺 → buildValetStandFallback(THREE)；攤位逐格 createPropModel(s.model)',
    mainSrc.includes('hasProp(VALET_STAND_KEY) ? createPropModel(VALET_STAND_KEY) : buildValetStandFallback(THREE)') && mainSrc.includes('const obj = createPropModel(s.model);')
    && mainSrc.includes('if (!s.model) continue;') && mainSrc.includes('const hasProp = (k) => propModels.has(k);'));
  check('main.js：takeout_bag 只在接單攤有擺且 bag 模型有載入時建立', mainSrc.includes('if (runStallObj && hasProp(TAKEOUT_BAG_KEY)) {'));
  // 程式幾何：假 THREE 記錄網格
  class V3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { Object.assign(this, { x, y, z }); } }
  class Obj { constructor() { this.position = new V3(); this.children = []; } add(c) { this.children.push(c); } }
  const FT = {
    Group: Obj,
    Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
    BoxGeometry: class { constructor(w, h, d) { Object.assign(this, { w, h, d }); } },
    MeshStandardMaterial: class { constructor(o) { Object.assign(this, o); } },
  };
  const g = JP.buildValetStandFallback(FT);
  const inBox = g.children.every((m) => {
    const { w, h, d } = m.geometry;
    const p = m.position;
    return p.x - w / 2 >= -vInfo.width / 2 - 1e-6 && p.x + w / 2 <= vInfo.width / 2 + 1e-6 && p.z - d / 2 >= -vInfo.depth / 2 - 1e-6 && p.z + d / 2 <= vInfo.depth / 2 + 1e-6
      && p.y - h / 2 >= -1e-6 && p.y + h / 2 <= vInfo.height + 1e-6;
  });
  check('泊車亭程式幾何：亭身 / 屋頂 / 立牌桿 / 立牌面 4 塊，全在 manifest 外接盒內', g.children.length === 4 && inBox);
}

// ======================= 5. 碰撞盒 =======================
{
  const vInfo = manifest.props.find((p) => p.id === 'valet_stand');
  // 世界點 → 盒本地（盒中心為原點、繞 Y 轉 −yaw）
  const inside = (b, wx, wy, wz) => {
    const cx = b.x;
    const cz = b.z;
    const dx = wx - cx;
    const dz = wz - cz;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return Math.abs(lx) <= b.width / 2 && Math.abs(lz) <= b.depth / 2 && wy >= b.y && wy <= b.y + b.height;
  };
  for (const yaw of [0, 0.7, -2.1]) {
    const pl = { x: 37.24, y: 5, z: 64.27, yaw };
    const boxes = JP.valetStandBoxes(pl);
    const b = boxes[0];
    const w = (l) => propWorldPoint(l, pl);
    const gap = [[0.2, 1.0, 0], [0.5, 1.0, 0.3], [0.8, 1.5, -0.3]].map(w); // 亭（−X）與立牌（+X 端）之間
    const sign = w([1.1, 1.2, 0.3]);
    const booth = w([-0.61, 1.0, -0.22]);
    const counter = w(vInfo.counter);
    check(`泊車亭碰撞（yaw ${yaw}）：只有一個盒（亭身），不是 2.52 × 1.54 外接盒`, boxes.length === 1 && b.width < vInfo.width - 1 && b.depth < vInfo.depth && near(b.yaw, yaw));
    check(`泊車亭碰撞（yaw ${yaw}）：亭身點在盒內；亭與立牌間空隙、立牌、接單站位都在盒外`,
      inside(b, booth.x, booth.y, booth.z) && gap.every((p) => !inside(b, p.x, p.y, p.z)) && !inside(b, sign.x, sign.y, sign.z) && !inside(b, counter.x, 1.0 + 5, counter.z));
    check(`泊車亭碰撞（yaw ${yaw}）：盒底 = 地面、盒在外接盒內`, near(b.y, 5) && b.height <= vInfo.height
      && [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sz]) => {
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const lx = sx * b.width / 2;
        const lz = sz * b.depth / 2;
        // 盒角 → 世界 → 道具本地
        const wx = b.x + lx * c + lz * sn - pl.x;
        const wz = b.z - lx * sn + lz * c - pl.z;
        const px = wx * c - wz * sn;
        const pz = wx * sn + wz * c;
        return Math.abs(px) <= vInfo.width / 2 + 1e-6 && Math.abs(pz) <= vInfo.depth / 2 + 1e-6 && px <= 0.05;
      }));
  }
  const row = JP.stallRow({ x: 0, z: 0, faceX: 3, faceZ: 4 }, () => 1, () => true);
  check('攤位碰撞盒：每格 = propColliderBox(\'night_market_stall\', pl)（變體同原攤車，寬 2.22 / 深 1.56 / 高 3.04）',
    row.every((r) => JSON.stringify(r.box) === JSON.stringify(propColliderBox('night_market_stall', r.pl)) && near(r.box.width, 2.22) && near(r.box.depth, 1.56) && near(r.box.height, 3.04)));
  check('main.js：攤位與泊車亭盒在物理世界建好後 addStaticBox', mainSrc.indexOf('for (const b of [...stallBoxes, ...valetBoxes]) addStaticBox(RAPIER, pw.world, b);') > mainSrc.indexOf('const pw = new PhysicsWorld(RAPIER);')
    && mainSrc.includes('valetBoxes.push(...valetStandBoxes(s.pl));'));
}

// ======================= 6. 地圖選點（真 citymodel） =======================
{
  const city = await import('../../src/citymodel.js');
  const { NIGHT_MARKET_DELIVERY } = await import('../../src/missions/events.js');
  const extractFn = (name) => {
    const i = mainSrc.indexOf(`function ${name}(`);
    return mainSrc.slice(i, mainSrc.indexOf('\n}\n', i) + 2);
  };
  const constDecls = [...mainSrc.matchAll(/^const (STALL_\w+) = [\d.]+;/gm)].map((m) => m[0]).join('\n');
  const H = new Function('surfaceRoads', 'onRoadSurface', 'buildingAt',
    `${constDecls}\n${extractFn('nearestRoadPoint')}\n${extractFn('stallPlacement')}\nreturn { nearestRoadPoint, stallPlacement };`)(city.surfaceRoads, city.onRoadSurface, city.buildingAt);
  const pk = NIGHT_MARKET_DELIVERY.pickup;
  const row = JP.stallRow(H.stallPlacement(pk, 1.56), () => 0, () => true);
  check('攤位三格：不在車道 / 步道上、離建築外牆 ≥ 3 m',
    row.every((r) => !city.onRoadSurface(r.pl.x, r.pl.z, 0.3, false) && !city.onRoadSurface(r.pl.x, r.pl.z, 0.78, true) && !city.buildingAt(r.pl.x, r.pl.z, 3)),
    row.map((r) => `${r.pl.x.toFixed(1)},${r.pl.z.toFixed(1)}`).join(' / '));
  const rs = JP.runStallSpot(row);
  check('stallBack：不在車道 / 建築內，在外送取餐點 radius 內', !city.onRoadSurface(rs.stallBack.x, rs.stallBack.z, 0.3, false) && !city.buildingAt(rs.stallBack.x, rs.stallBack.z, 0.5)
    && Math.hypot(rs.stallBack.x - pk.x, rs.stallBack.z - pk.z) < pk.radius);
  for (const s of JP.valetSpots(JP.VALET_SITES, () => 0)) {
    const site = JP.VALET_SITES.find((v) => v.id === s.id);
    const st = site.stand;
    check(`泊車亭 ${s.id}：亭不在車道 / 步道 / 建築上、正面朝向的道路點在車道上`, !city.onRoadSurface(st.x, st.z, 1.3, false) && !city.onRoadSurface(st.x, st.z, 0.8, true) && !city.buildingAt(st.x, st.z, 1.5)
      && !!city.onRoadSurface(st.faceX, st.faceZ, 0, false));
    const carRoad = city.onRoadSurface(s.carX, s.carZ, 0, false);
    const slotRoad = city.onRoadSurface(s.slotX, s.slotZ, 0, false);
    check(`泊車亭 ${s.id}：客人車 / 車格在車道上（路邊）、接單點離客人車 < 10 m、車格離亭 > 100 m`, !!carRoad && !!slotRoad
      && Math.hypot(s.carX - s.standX, s.carZ - s.standZ) < 10 && Math.hypot(s.slotX - s.standX, s.slotZ - s.standZ) > 100);
    // 車頭朝向 = 車道行駛方向（單行道順向；雙向道右側通行）
    const dirOk = (road, x, z, yaw) => {
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < road.pts.length - 1; i++) {
        const a = road.pts[i];
        const b = road.pts[i + 1];
        const mx = (a.x + b.x) / 2;
        const mz = (a.z + b.z) / 2;
        const d = Math.hypot(mx - x, mz - z);
        if (d < bd) { bd = d; best = { dx: b.x - a.x, dz: b.z - a.z }; }
      }
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const L = Math.hypot(best.dx, best.dz);
      const dot = (fx * best.dx + fz * best.dz) / L;
      if (road.oneway) return dot * (road.oneway === -1 ? -1 : 1) > 0.97;
      // 雙向：右側 = (−dz, dx) 方向；車在中心線右側 ↔ 順向
      return Math.abs(dot) > 0.97;
    };
    check(`泊車亭 ${s.id}：客人車 / 車格車頭平行車道（單行道順向）`, dirOk(carRoad, s.carX, s.carZ, s.carYaw) && dirOk(slotRoad, s.slotX, s.slotZ, s.slotYaw));
  }
  const sw = JP.createSidewalkNear({ nearestRoadPoint: H.nearestRoadPoint, onRoadSurface: city.onRoadSurface, buildingAt: city.buildingAt, inBounds: city.inBounds });
  let seed = 7;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push(sw(rs.stall.x, rs.stall.z, rng, 40, 160));
  const okPts = pts.filter(Boolean);
  check('sidewalkNear：真路網 40 次取樣大多有點（≥ 35）', okPts.length >= 35, String(okPts.length));
  check('sidewalkNear：點在 [40, 160] m 距離帶、不在車道、不在建築內', okPts.every((p) => {
    const d = Math.hypot(p.x - rs.stall.x, p.z - rs.stall.z);
    return d >= 40 && d <= 160 && !city.onRoadSurface(p.x, p.z, 0.3, false) && !city.buildingAt(p.x, p.z, 0.5);
  }));
  const swNull = JP.createSidewalkNear({ nearestRoadPoint: () => null, onRoadSurface: () => null, buildingAt: () => null });
  check('sidewalkNear：找不到路 → null（jobs.js 會再要 / 湊不到不接單）', swNull(0, 0, Math.random, 40, 160) === null);
}

// ======================= 7. events.js simDt = 0 =======================
{
  const { createTimedEvents } = await import('../../src/missions/events.js');
  const evs = [];
  let t = 0;
  const ev = createTimedEvents({
    getGameHour: () => 19, destinations: [{ slug: 'far', name: '遠方', x: 557.2 + 400, z: -125.1 }], now: () => t, rng: () => 0.1,
    bus: { emit: (n, p) => evs.push([n, p]) },
  });
  const pk = { x: 557.2, z: -125.1 };
  for (let k = 0; k < 5; k++) ev.update(0, pk);
  check('events.js：simDt = 0 不開放（無 event:available）', !evs.some((e) => e[0] === 'event:available'));
  ev.update(1 / 60, pk);
  check('events.js：有子步才開放', evs.some((e) => e[0] === 'event:available'));
  const it = ev.nearest(pk);
  if (it) it.act();
  const act = ev.active();
  check('events.js：接單後進行中', !!act);
  if (act) {
    const lim = act.limitSec;
    for (let k = 0; k < 10; k++) ev.update(0, { x: act.to.x, z: act.to.z });
    check('events.js：simDt = 0 在送達點不判定抵達', !!ev.active() && !evs.some((e) => e[0] === 'event:complete'));
    ev.update(lim + 1 > 0.5 ? 0.5 : lim, pk);
    check('events.js：子步推進照常計時（elapsed 只吃 step）', near(ev.active() ? ev.active().elapsedSec : -1, 0.5, 1e-9));
    ev.update(1 / 60, { x: act.to.x, z: act.to.z });
    check('events.js：有子步後在送達點完成', evs.some((e) => e[0] === 'event:complete'));
  }
}

console.log(fail ? `FAIL ${fail}/${pass + fail}` : `PASS ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
