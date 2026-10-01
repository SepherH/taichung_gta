#!/usr/bin/env node
// M6 選單運鏡巡覽（契約 §25，src/ui/menu-tour.js）：以真 citymodel（osm-city.json + terrain.js）建立巡覽並逐幀驗證
//   鏡位由資料推導（7 處、名稱 / 來源）、型態輪替與秒數（每段 8–12 s、四型皆有）、
//   路徑連續（60 Hz 相鄰幀位移 ≤ MAX_STEP_M、視線轉角 ≤ MAX_TURN_DEG）、全程 ≥ 地形 + SAFE_CLEAR（terrain.querySurface 取樣）且不在建築輪廓內低於屋頂、
//   循環銜接（末段 → 首段連續、t = duration 與 t = 0 同點）、30 Hz 與 60 Hz 同時刻同鏡位（計時吃渲染 dt、與 simDt 無關）、
//   進出遊戲（stop → update 不動鏡頭、handoff 由巡覽鏡位平順內插到玩家鏡頭並收斂、start 由玩家鏡頭平順回到巡覽）、
//   進出遊戲掃描（整輪各時刻 × 3 個玩家鏡頭點，雙向逐幀：高度變化 ≤ 1.6 m/幀、不低於 floor、> 300 m 改淡出淡入且只在全黑時切鏡）、
//   取景（每段看點視線遮擋率 ≤ 10%、市政府推軌離立面 ≥ 90 m）、
//   減少動態效果（老虎城慢速環繞、偏好切換平順）、每幀成本、main.js 只接線（靜態檢查）
// 用法：node tools/test/p6-m6.mjs（任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n）
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const cm = await import('../../src/citymodel.js');
const osm = (await import('../../src/data/osm-city.json')).default;
const { NIGHT_MARKET_DELIVERY } = await import('../../src/missions/events.js');
const T = await import('../../src/ui/menu-tour.js');
const geom = await import('../../src/geom.js');

let pass = 0;
let fail = 0;
function check(name, cond, info = '') {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
}

// 驗收門檻（寫明數值）
const FPS = 60;
const DT = 1 / FPS;
const MAX_STEP_M = 1.6; // 60 Hz 相鄰幀鏡頭位移上限（m）= 96 m/s；實測最大值約 1.39 m（段間長距滑行弧頂）
const MAX_TURN_DEG = 1.5; // 60 Hz 相鄰幀視線方向轉角上限（°）= 90°/s
const MAX_PER_FRAME_MS = 0.05; // node 內每幀 update 平均成本上限（ms；low 檔 8 ms 預算的 < 1%）

const terrain = cm.getTerrain();
const q = {};
const groundY = (x, z) => terrain.querySurface(x, z, -Infinity, q).y;
const deps = {
  terrain,
  buildings: cm.buildings,
  namedBuildings: cm.namedBuildings,
  roads: cm.surfaceRoads,
  basins: osm.T.basins,
  stall: { ...NIGHT_MARKET_DELIVERY.pickup, source: 'NIGHT_MARKET_DELIVERY.pickup' },
};

// ---------- 模組本身不 import three / DOM ----------
{
  const src = read('src/ui/menu-tour.js');
  const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
  check('menu-tour.js 只 import ../geom.js（不拖入 three / DOM）', imports.length === 1 && imports[0].includes("'../geom.js'"), imports.join(' | '));
  const code = src.replace(/\/\/[^\n]*/g, '');
  check('menu-tour.js 不讀 document / window / navigator', !/\b(document|window|navigator)\b/.test(code));
}

// ---------- 鏡位 ----------
const tour = T.buildTour(deps);
{
  const keys = tour.stops.map((s) => s.key);
  const want = ['tiger', 'shinkong', 'stall', 'opera', 'cityhall', 'mrt', 'qiuhonggu'];
  check('鏡位 7 處皆由資料推導（老虎城 / 新光三越 / 夜市攤車 / 歌劇院 / 市政府 / 捷運站 / 秋紅谷）', want.every((k) => keys.includes(k)) && keys.length === 7, keys.join(','));
  check('第一站為老虎城', keys[0] === 'tiger');
  const byKey = Object.fromEntries(tour.stops.map((s) => [s.key, s]));
  const tiger = cm.buildingById(150999799);
  check('老虎城座標 = OSM 輪廓中心', Math.hypot(byKey.tiger.x - tiger.center.x, byKey.tiger.z - tiger.center.z) < 1e-6 && byKey.tiger.source === 'osm B 150999799');
  const sk = cm.namedBuildings.find((b) => b.name === '新光三越');
  check('新光三越座標 = OSM 輪廓中心、高度 = OSM 高度', Math.hypot(byKey.shinkong.x - sk.center.x, byKey.shinkong.z - sk.center.z) < 1e-6 && byKey.shinkong.top === sk.height);
  check('秋紅谷來自 osm T.basins', /^osm T\.basins /.test(byKey.qiuhonggu.source));
  check('夜市攤車 = 注入的攤車點', byKey.stall.x === NIGHT_MARKET_DELIVERY.pickup.x && byKey.stall.z === NIGHT_MARKET_DELIVERY.pickup.z);
  const mrtAll = cm.namedBuildings.filter((b) => b.name === '捷運市政府站');
  check('捷運站取同名建築中面積最大者', byKey.mrt.id === mrtAll.reduce((a, b) => (b.area > a.area ? b : a)).id);
  for (const s of tour.stops) console.log(`  鏡位 ${s.key} ${s.name} ← ${s.source} (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`);
  // 缺資料：略過該站，不丟例外
  const partial = T.tourStops({ ...deps, stall: null, basins: [] });
  check('缺攤車 / basin 資料 → 略過該站', partial.length === 5 && !partial.some((s) => s.key === 'stall' || s.key === 'qiuhonggu'));
}

// ---------- 型態與秒數 ----------
{
  const shots = tour.segments.filter((s) => s.type !== 'glide');
  const glides = tour.segments.filter((s) => s.type === 'glide');
  const types = new Set(shots.map((s) => s.type));
  check('四種型態皆有（環繞 / 推軌 / 升降 / 沿道路低空飛行）', ['orbit', 'dolly', 'crane', 'road'].every((t) => types.has(t)), [...types].join(','));
  check('每段 8–12 s', shots.every((s) => s.sec >= 8 - 0.1 && s.sec <= 12 + 0.1), shots.map((s) => s.sec.toFixed(1)).join(','));
  check('型態依序輪替（相鄰兩段型態不同）', shots.every((s, i) => s.type !== shots[(i + 1) % shots.length].type));
  check('段與段之間各有一段滑行銜接（含末段 → 首段）', glides.length === shots.length && tour.segments[tour.segments.length - 1].type === 'glide');
  check(`滑行秒數 ${T.GLIDE_MIN}–${T.GLIDE_MAX} s`, glides.every((g) => g.sec >= T.GLIDE_MIN - 0.1 && g.sec <= T.GLIDE_MAX + 0.1));
  const sum = tour.segments.reduce((a, s) => a + s.sec, 0);
  check('段落表總長 = 一輪秒數', Math.abs(sum - tour.duration) < 1e-6, `${tour.duration.toFixed(1)} s`);
  for (const s of tour.segments) {
    const fr = s.dist !== undefined ? `  （距 ${s.dist.toFixed(0)} m${s.alt !== undefined ? `、高 ${s.alt.toFixed(0)} m` : ''}${s.occ !== undefined ? `、遮擋 ${(s.occ * 100).toFixed(0)}%` : ''}）` : '';
    console.log(`  ${s.t0.toFixed(1).padStart(6)} s  ${s.type.padEnd(6)} ${s.sec.toFixed(1)} s  ${s.name}${fr}`);
  }
}

// ---------- 逐幀：連續 / 高度下限 / 不入建築 ----------
function scanPath(path, label) {
  const p = {};
  const l = {};
  const n = Math.ceil(path.duration / DT) + 1;
  let maxStep = 0;
  let maxTurn = 0;
  let minClear = Infinity;
  let inside = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  let fx0 = 0;
  let fy0 = 0;
  let fz0 = 0;
  for (let i = 0; i <= n; i++) {
    T.samplePathAt(path, i * DT, p, l);
    const c = p.y - groundY(p.x, p.z);
    if (c < minClear) minClear = c;
    const b = cm.buildingAt(p.x, p.z, 0);
    if (b && p.y < terrain.buildingBase(b.id) + b.height) inside++;
    let fx = l.x - p.x;
    let fy = l.y - p.y;
    let fz = l.z - p.z;
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    if (i > 0) {
      maxStep = Math.max(maxStep, Math.hypot(p.x - px, p.y - py, p.z - pz));
      maxTurn = Math.max(maxTurn, (Math.acos(Math.min(1, fx * fx0 + fy * fy0 + fz * fz0)) * 180) / Math.PI);
    }
    px = p.x;
    py = p.y;
    pz = p.z;
    fx0 = fx;
    fy0 = fy;
    fz0 = fz;
  }
  check(`${label}：60 Hz 相鄰幀位移 ≤ ${MAX_STEP_M} m（含循環接縫）`, maxStep <= MAX_STEP_M, `最大 ${maxStep.toFixed(3)} m`);
  check(`${label}：60 Hz 相鄰幀視線轉角 ≤ ${MAX_TURN_DEG}°（含循環接縫）`, maxTurn <= MAX_TURN_DEG, `最大 ${maxTurn.toFixed(3)}°`);
  check(`${label}：全程 ≥ 地形 + SAFE_CLEAR ${T.SAFE_CLEAR} m`, minClear >= T.SAFE_CLEAR - 1e-6, `最小離地 ${minClear.toFixed(2)} m`);
  check(`${label}：全程不在建築輪廓內低於屋頂`, inside === 0, `${inside} 幀`);
  return { maxStep, maxTurn, minClear };
}
scanPath(tour, '巡覽');
{
  // 循環銜接：t = duration 與 t = 0 同點；末段最後一幀 → 首段第一幀位移在上限內
  const a = {};
  const b = {};
  const la = {};
  const lb = {};
  T.samplePathAt(tour, 0, a, la);
  T.samplePathAt(tour, tour.duration, b, lb);
  check('循環：t = duration 與 t = 0 同一鏡位', Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9 && Math.hypot(la.x - lb.x, la.y - lb.y, la.z - lb.z) < 1e-9);
  T.samplePathAt(tour, tour.duration - DT, b, lb);
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  check(`循環：末段最後一幀 → 首段第一幀位移 ≤ ${MAX_STEP_M} m`, d <= MAX_STEP_M, `${d.toFixed(3)} m`);
  // 末段是「最後一站 → 首站」的滑行，終點 = 首段（環繞）起點附近
  const last = tour.segments[tour.segments.length - 1];
  check('循環：末段為滑行回首站', last.type === 'glide' && last.name.endsWith(tour.stops[0].name));
}

// ---------- 控制器：mock 相機 ----------
function mockCamera() {
  return {
    position: { x: 0, y: 50, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
  };
}
const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))) * (180 / Math.PI);
const snap = (cam) => ({ x: cam.position.x, y: cam.position.y, z: cam.position.z, q: { ...cam.quaternion } });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

{
  // lookQuat：three.js lookAt 慣例（本地 −Z 指向目標）
  const o = T.lookQuat(0, 0, 0, 10, 0, 0, {});
  // 以四元數旋轉 (0, 0, −1)
  const rot = (qq, v) => {
    const { x, y, z, w } = qq;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
  };
  const f = rot(o, { x: 0, y: 0, z: -1 });
  const u = rot(T.lookQuat(0, 10, 0, 5, 0, 5, {}), { x: 0, y: 1, z: 0 });
  check('lookQuat：前方 (0,0,−1) 轉到目標方向、上方保持 +Y 側', Math.abs(f.x - 1) < 1e-9 && Math.abs(f.y) < 1e-9 && Math.abs(f.z) < 1e-9 && u.y > 0);
}

{
  const cam = mockCamera();
  const mt = T.createMenuTour({ ...deps, camera: cam });
  check('建立後為巡覽中（tour 模式）', mt.active && mt.mode === 'tour');
  // 第一幀直接到路徑上（開機不內插）
  mt.update(DT);
  const p = {};
  const l = {};
  T.samplePathAt(mt.path, DT, p, l);
  check('第一幀鏡頭 = 路徑鏡位', dist(snap(cam), p) < 1e-9);
  check('focus = 看點（xz）', Math.abs(mt.focus.x - l.x) < 1e-9 && Math.abs(mt.focus.z - l.z) < 1e-9);
  // 30 Hz 與 60 Hz 推進同樣的渲染秒數 → 同一鏡位（計時只吃 dt，與 simDt 無關）
  const c30 = mockCamera();
  const c60 = mockCamera();
  const m30 = T.createMenuTour({ ...deps, camera: c30 });
  const m60 = T.createMenuTour({ ...deps, camera: c60 });
  for (let i = 0; i < 30 * 20; i++) m30.update(1 / 30);
  for (let i = 0; i < 60 * 20; i++) m60.update(1 / 60);
  check('30 Hz × 20 s 與 60 Hz × 20 s 鏡位一致（計時 = 渲染 dt 累加）', dist(snap(c30), snap(c60)) < 1e-6 && Math.abs(m30.time - m60.time) < 1e-9, `${dist(snap(c30), snap(c60)).toExponential(2)} m`);
  // 跑完整一輪 + 1 s：time 取模回到開頭附近
  for (let i = 0; i < Math.ceil(mt.path.duration * 60); i++) mt.update(DT);
  check('跑超過一輪：time 取模（< duration）', mt.time >= 0 && mt.time < mt.path.duration);

  // ---- 進入遊戲 ----
  const tourPose = snap(cam);
  mt.stop();
  check('stop → 巡覽停止', !mt.active && mt.blending === 'out');
  mt.update(DT);
  check('停止後 update 不動鏡頭', dist(snap(cam), tourPose) === 0);
  // 玩家鏡頭（rig.update 每幀寫入）：出生點那條路（河南路三段）中心線上離老虎城最近的點，離地 2.6 m 看向老虎城
  const tigerB = cm.buildingById(150999799);
  let rp = null;
  for (const r of cm.surfaceRoads.filter((r) => r.name === '河南路三段')) {
    for (const pt of r.pts) if (!rp || Math.hypot(pt.x - tigerB.center.x, pt.z - tigerB.center.z) < Math.hypot(rp.x - tigerB.center.x, rp.z - tigerB.center.z)) rp = pt;
  }
  const rigY = groundY(rp.x, rp.z) + 2.6;
  const rigPose = { x: rp.x, y: rigY, z: rp.z, q: T.lookQuat(rp.x, rigY, rp.z, tigerB.center.x, rigY - 1, tigerB.center.z, {}) };
  check('玩家鏡頭測試點在路面上、不在建築內', !!cm.onRoadSurface(rp.x, rp.z, 0, false) && !cm.buildingAt(rp.x, rp.z, 0));
  const rigWrite = () => {
    cam.position.set(rigPose.x, rigPose.y, rigPose.z);
    cam.quaternion.set(rigPose.q.x, rigPose.q.y, rigPose.q.z, rigPose.q.w);
  };
  let prev = tourPose;
  let maxStep = 0;
  let maxRot = 0;
  let frames = 0;
  let still = true;
  let firstStep = 0;
  let insideHand = 0;
  while (still && frames < 600) {
    rigWrite();
    still = mt.handoff(DT);
    const cur = snap(cam);
    const bIn = cm.buildingAt(cur.x, cur.z, 0);
    if (bIn && cur.y < terrain.buildingBase(bIn.id) + bIn.height) insideHand++;
    const st = dist(cur, prev);
    if (frames === 0) firstStep = st;
    maxStep = Math.max(maxStep, st);
    maxRot = Math.max(maxRot, qAngle(cur.q, prev.q));
    prev = cur;
    frames++;
  }
  const handSec = frames * DT;
  check(`handoff 在 ${T.HANDOFF_MIN}–${T.HANDOFF_MAX} s 內結束`, !still && handSec >= T.HANDOFF_MIN - DT && handSec <= T.HANDOFF_MAX + DT, `${handSec.toFixed(2)} s`);
  check('handoff 第一幀不跳到玩家鏡頭（位移 < 總距離的 5%）', firstStep < dist(tourPose, rigPose) * 0.05, `${firstStep.toFixed(2)} / ${dist(tourPose, rigPose).toFixed(1)} m`);
  check('handoff 途中不在建築輪廓內低於屋頂', insideHand === 0, `${insideHand} 幀`);
  check('handoff 結束 = 玩家鏡頭', dist(snap(cam), rigPose) < 1e-9 && qAngle(snap(cam).q, rigPose.q) < 1e-4);
  // 水平 smoothstep 峰值 1.5 × 平均；高度在半程內走完 → 峰值 3 × 平均：每幀位移上限 = 3 × 總距離 ÷ 內插秒數 × dt
  const maxStepAllowed = (dist(tourPose, rigPose) / handSec) * 3 * DT;
  check('handoff 途中每幀位移 ≤ 3 × 平均速度 × dt、轉角 ≤ 3°', maxStep <= maxStepAllowed && maxRot <= 3, `${maxStep.toFixed(2)} m（上限 ${maxStepAllowed.toFixed(2)}）/ ${maxRot.toFixed(2)}°`);
  // handoff 結束後不再改動鏡頭
  cam.position.set(1, 2, 3);
  check('handoff 結束後回傳 false 且不動鏡頭', mt.handoff(DT) === false && cam.position.x === 1 && cam.position.z === 3);

  // ---- 回主選單 ----
  rigWrite();
  const tBefore = mt.time;
  const playerPose = snap(cam);
  mt.start();
  check('start → 巡覽恢復、時間接續', mt.active && mt.blending === 'in' && mt.time === tBefore);
  mt.update(DT);
  const f1 = snap(cam);
  check('回主選單第一幀不跳離玩家鏡頭（< 1 m）', dist(f1, playerPose) < 1, `${dist(f1, playerPose).toFixed(2)} m`);
  let n = 0;
  while (mt.blending && n < 600) {
    mt.update(DT);
    n++;
  }
  mt.update(DT);
  T.samplePathAt(mt.path, mt.time, p, l);
  check('回主選單內插結束後回到巡覽路徑', !mt.blending && dist(snap(cam), p) < 1e-9, `${(n * DT).toFixed(2)} s`);
  // stop / start 冪等
  mt.start();
  check('巡覽中再 start 無作用', mt.active && !mt.blending);
}

// ---------- 進出遊戲掃描：整輪各時刻 stop → handoff → start，雙向逐幀 ----------
//   平滑內插：相鄰幀高度變化 ≤ MAX_DY_M、位移 ≤ MAX_HAND_STEP_M、不在建築內、兩端 HANDOFF_MASK_R 外不低於 floor；
//   距離 > HANDOFF_FADE_DIST → 必走淡出淡入（≤ FADE_SEC），大位移只出現在全黑那一幀
const MAX_DY_M = 1.6; // handoff / 回主選單相鄰幀高度變化上限（m，= 巡覽每幀位移門檻；模組速率上限 HANDOFF_VRATE 90 m/s = 1.5 m）
// 平滑內插每幀位移上限（m）：水平 smoothstep 峰值 1.5 × 平均（平均 ≤ max(HANDOFF_SPEED, HANDOFF_FADE_DIST ÷ HANDOFF_MAX) = 120 m/s）與高度速率合成，
//   再加目標本身每幀的移動（回主選單時目標 = 巡覽鏡位，每幀 ≤ MAX_STEP_M）；改前實測峰值約 600 m/s（10 m/幀）
const MAX_HAND_STEP_M = Math.hypot(1.5 * Math.max(T.HANDOFF_SPEED, T.HANDOFF_FADE_DIST / T.HANDOFF_MAX), T.HANDOFF_VRATE) * DT + MAX_STEP_M;
const FLOOR_TOL_M = 0.05; // floor 容差（m）：回主選單時目標（巡覽鏡位）高度在剖面樣本間為曲線、剖面為線性內插，差值為毫米級
const CUT_ALPHA = 0.95; // 淡出淡入：位移 / 高度超限的幀，淡出量須 ≥ 此值（全黑時切鏡）
function nearRoadPose(stop) {
  let best = null;
  for (const r of cm.surfaceRoads) {
    for (const pt of r.pts) {
      if (cm.buildingAt(pt.x, pt.z, 0) || !cm.onRoadSurface(pt.x, pt.z, 0, false)) continue;
      const d = Math.hypot(pt.x - stop.x, pt.z - stop.z);
      if (!best || d < best.d) best = { x: pt.x, z: pt.z, d };
    }
  }
  const y = groundY(best.x, best.z) + 2.6;
  return { x: best.x, y, z: best.z, q: T.lookQuat(best.x, y, best.z, stop.x, y - 1, stop.z, {}), name: stop.key };
}
{
  const floorAt = tour.floorAt;
  const byKey = Object.fromEntries(tour.stops.map((s) => [s.key, s]));
  const rigs = [nearRoadPose(byKey.tiger), nearRoadPose(byKey.shinkong), nearRoadPose(byKey.cityhall)];
  const fades = [];
  const cam = mockCamera();
  const mt = T.createMenuTour({ ...deps, camera: cam, fade: (a) => fades.push(a) });
  mt.update(DT);
  const agg = { belowMax: -Infinity, fadeShort: 0, smooth: 0, fade: 0, maxDy: 0, maxStep: 0, inside: 0, below: 0, longNoFade: 0, fadeSecMax: 0, cutBad: 0, endBad: 0, maxDist: 0, fadeMaxDist: 0, smoothMaxDist: 0, longFade1100: false, alphaEnd: 0 };
  // 逐幀記錄一次內插：step() 推一幀並回傳是否仍在內插、from（起點鏡位）、targetAt()（當幀目標鏡位）
  const record = (step, from, targetAt) => {
    let prev = snap(cam);
    let n = 0;
    let still = true;
    const fading = [];
    let first = true;
    let isFade = false;
    let dist0 = 0;
    while (still && n < 600) {
      still = step();
      if (first) {
        isFade = mt.fading;
        dist0 = dist(from, targetAt());
        if (isFade) agg.fadeSecMax = Math.max(agg.fadeSecMax, mt.blendSec);
        first = false;
      }
      const cur = snap(cam);
      const tg = targetAt();
      const dy = Math.abs(cur.y - prev.y);
      const st = dist(cur, prev);
      if (isFade) {
        if ((dy > MAX_DY_M || st > MAX_HAND_STEP_M) && mt.fade < CUT_ALPHA) agg.cutBad++;
        fading.push(mt.fade);
      } else {
        agg.maxDy = Math.max(agg.maxDy, dy);
        agg.maxStep = Math.max(agg.maxStep, st);
        const bIn = cm.buildingAt(cur.x, cur.z, 0);
        if (bIn && cur.y < terrain.buildingBase(bIn.id) + bIn.height) agg.inside++;
        if (Math.hypot(cur.x - from.x, cur.z - from.z) > T.HANDOFF_MASK_R && Math.hypot(cur.x - tg.x, cur.z - tg.z) > T.HANDOFF_MASK_R) {
          const under = floorAt(cur.x, cur.z) - cur.y;
          agg.belowMax = Math.max(agg.belowMax, under);
          if (under > FLOOR_TOL_M) agg.below++;
        }
      }
      prev = cur;
      n++;
    }
    if (still || dist(snap(cam), targetAt()) > 1e-6) agg.endBad++;
    agg.maxDist = Math.max(agg.maxDist, dist0);
    if (isFade) {
      agg.fade++;
      agg.fadeMaxDist = Math.max(agg.fadeMaxDist, dist0);
      if (dist0 > 1000) agg.longFade1100 = true;
      if (dist0 <= T.HANDOFF_FADE_DIST) agg.fadeShort++;
      if (Math.max(...fading) < 0.999) agg.cutBad++;
    } else {
      agg.smooth++;
      agg.smoothMaxDist = Math.max(agg.smoothMaxDist, dist0);
      if (dist0 > T.HANDOFF_FADE_DIST) agg.longNoFade++;
    }
    agg.alphaEnd = Math.max(agg.alphaEnd, mt.fade);
  };
  const p = {};
  const l = {};
  let cycles = 0;
  for (const rig of rigs) {
    const rigWrite = () => {
      cam.position.set(rig.x, rig.y, rig.z);
      cam.quaternion.set(rig.q.x, rig.q.y, rig.q.z, rig.q.w);
    };
    let span = 0;
    while (span < mt.path.duration) {
      for (let i = 0; i < 100; i++) mt.update(DT); // 每輪往前 100 幀（≈ 1.67 s）再進遊戲
      span += 100 * DT;
      const tourPose = snap(cam);
      mt.stop();
      record(() => {
        rigWrite();
        return mt.handoff(DT);
      }, tourPose, () => rig);
      rigWrite();
      mt.start();
      record(() => {
        mt.update(DT);
        return !!mt.blending;
      }, rig, () => {
        T.samplePathAt(mt.path, mt.time, p, l);
        return p;
      });
      cycles++;
      if (cycles > 400) break;
    }
  }
  console.log(`  進出遊戲掃描：${cycles} 輪 × 雙向，平滑 ${agg.smooth}（最遠 ${agg.smoothMaxDist.toFixed(0)} m）/ 淡出淡入 ${agg.fade}（最遠 ${agg.fadeMaxDist.toFixed(0)} m；其中 ≤ ${T.HANDOFF_FADE_DIST} m 但高度速率不可行 ${agg.fadeShort}）`);
  check(`進出遊戲（平滑內插）相鄰幀高度變化 ≤ ${MAX_DY_M} m`, agg.smooth > 0 && agg.maxDy <= MAX_DY_M, `最大 ${agg.maxDy.toFixed(3)} m（${agg.smooth} 次）`);
  check(`進出遊戲（平滑內插）相鄰幀位移 ≤ ${MAX_HAND_STEP_M.toFixed(2)} m（≤ ${(MAX_HAND_STEP_M / DT).toFixed(0)} m/s）`, agg.maxStep <= MAX_HAND_STEP_M, `最大 ${agg.maxStep.toFixed(3)} m`);
  check('進出遊戲（平滑內插）途中不在建築輪廓內低於屋頂', agg.inside === 0, `${agg.inside} 幀`);
  check(`進出遊戲（平滑內插）兩端 ${T.HANDOFF_MASK_R} m 外全程不低於 floor（容差 ${FLOOR_TOL_M} m）`, agg.below === 0, `${agg.below} 幀；最大低於 ${Math.max(0, agg.belowMax).toFixed(3)} m`);
  check(`距離 > ${T.HANDOFF_FADE_DIST} m 一律淡出淡入`, agg.longNoFade === 0 && agg.fade > 0, `平滑內插最遠 ${agg.smoothMaxDist.toFixed(0)} m`);
  check('約 1100 m 的進出遊戲（實測情境）走淡出淡入', agg.longFade1100, `最遠 ${agg.maxDist.toFixed(0)} m`);
  check(`淡出淡入 ≤ ${T.FADE_SEC} s、只在全黑（淡出量 ≥ ${CUT_ALPHA}）那一幀切鏡、途中到達全黑`, agg.fadeSecMax <= T.FADE_SEC + 1e-9 && agg.cutBad === 0, `最長 ${agg.fadeSecMax.toFixed(2)} s、違規 ${agg.cutBad}`);
  check('每次內插結束 = 目標鏡位、淡出量歸 0、fade 回呼最後為 0', agg.endBad === 0 && agg.alphaEnd === 0 && fades[fades.length - 1] === 0, `${agg.endBad} 次未收斂`);
}

// ---------- 取景：看點視線遮擋率、市政府推軌距離 ----------
const MAX_OCC = 0.1; // 每段（環繞 / 推軌 / 升降 / 低空飛行）看點視線遮擋率上限：OCC_FRAMES 幀 × 5 條射線（看點、頂、底、左右兩側）被其他建築擋住的比例
{
  const blocked = T.makeOcclusion(terrain, cm.buildings);
  const byKey = Object.fromEntries(tour.stops.map((s) => [s.key, s]));
  const p = {};
  const l = {};
  const occ = [];
  for (const sg of tour.segments) {
    if (sg.type === 'glide') continue;
    const r = T.shotOcclusion(null, byKey[sg.key], blocked, null, (u, o) => T.samplePathAt(tour, sg.t0 + u * (sg.t1 - sg.t0), o, l));
    occ.push(`${sg.key} ${(r * 100).toFixed(0)}%`);
    sg.occ = r;
  }
  const shots = tour.segments.filter((s) => s.type !== 'glide');
  check(`每段看點視線遮擋率 ≤ ${MAX_OCC * 100}%（含老虎城環繞、捷運市政府站）`, shots.every((s) => s.occ <= MAX_OCC), occ.join(' / '));
  // 遮擋檢查本身：原取景（朝最近道路、半徑 R + 60 m、高 top + 25 m）的老虎城環繞會被近景高樓擋到（實測約 40%）
  const tiger = byKey.tiger;
  const r0 = tiger.ext / 2 + 60;
  const raw = {};
  let worst = 0;
  for (let k = 0; k < 16; k++) {
    const a0 = (k / 16) * 2 * Math.PI;
    raw.pos = (u, o) => { const a = a0 + ((14 * 12) / r0) * u; o.x = tiger.x + Math.cos(a) * r0; o.y = tiger.top + 25; o.z = tiger.z + Math.sin(a) * r0; };
    worst = Math.max(worst, T.shotOcclusion(raw, tiger, blocked, tour.floorAt));
  }
  check('遮擋檢查有效：老虎城環繞某些方位遮擋率 > 30%（被選取景避開）', worst > 0.3, `最差方位 ${(worst * 100).toFixed(0)}%`);
  // 市政府推軌：鏡頭離立面 ≥ max(DOLLY_GAP_MIN, 2 × 高)、高度 ≥ DOLLY_ALT_K × 高
  const ch = tour.segments.find((s) => s.key === 'cityhall' && s.type === 'dolly');
  const chStop = byKey.cityhall;
  const cpt = {};
  let gap = Infinity;
  let yMin = Infinity;
  for (let i = 0; i <= 30; i++) {
    T.samplePathAt(tour, ch.t0 + (i / 30) * (ch.t1 - ch.t0), p, l);
    const g = geom.pointInPolygon(p.x, p.z, chStop.poly) ? 0 : Math.sqrt(geom.closestOnPolygon(p.x, p.z, chStop.poly, cpt).d2);
    gap = Math.min(gap, g);
    yMin = Math.min(yMin, p.y - chStop.base);
  }
  const wantGap = Math.max(T.DOLLY_GAP_MIN, 2 * chStop.top);
  check(`市政府推軌：離立面 ≥ ${wantGap.toFixed(0)} m（原約 35 m）、離地 ≥ ${(chStop.top * T.DOLLY_ALT_K).toFixed(0)} m`, gap >= wantGap - 1 && yMin >= chStop.top * T.DOLLY_ALT_K - 0.5, `最近 ${gap.toFixed(1)} m、最低 ${yMin.toFixed(1)} m`);
}

// ---------- 減少動態效果 ----------
{
  const slow = T.buildReducedTour(deps);
  const tiger = cm.buildingById(150999799);
  check('減少動態效果：繞老虎城、角速度 ≤ 0.05 rad/s（原出生點環繞速度）', slow.center.key === 'tiger' && Math.abs(slow.center.x - tiger.center.x) < 1e-6 && T.REDUCED_OMEGA <= 0.05, `一圈 ${slow.duration.toFixed(0)} s`);
  const r = scanPath(slow, '減少動態效果');
  check('減少動態效果：每幀位移 ≤ 0.1 m（≤ 6 m/s）', r.maxStep <= 0.1, `${r.maxStep.toFixed(3)} m`);
  let pref = true;
  const cam = mockCamera();
  const mt = T.createMenuTour({ ...deps, camera: cam, reducedMotion: () => pref });
  mt.update(DT);
  check('reducedMotion() = true → reduced 模式', mt.mode === 'reduced');
  for (let i = 0; i < 120; i++) mt.update(DT);
  pref = false;
  let prev = snap(cam);
  mt.update(DT);
  check('偏好關閉 → 切回巡覽並內插（第一幀不跳 > 3 m）', mt.mode === 'tour' && mt.blending === 'in' && dist(snap(cam), prev) < 3);
  pref = true;
  for (let i = 0; i < 300; i++) mt.update(DT);
  check('偏好再開 → 回 reduced 模式', mt.mode === 'reduced' && !mt.blending);
}

// ---------- 每幀成本 ----------
{
  const cam = mockCamera();
  const mt = T.createMenuTour({ ...deps, camera: cam });
  for (let i = 0; i < 600; i++) mt.update(DT);
  const N = 20000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) mt.update(DT);
  const per = (performance.now() - t0) / N;
  check(`每幀 update 平均 ≤ ${MAX_PER_FRAME_MS} ms`, per <= MAX_PER_FRAME_MS, `${(per * 1000).toFixed(2)} µs`);
  const t1 = performance.now();
  T.buildTour(deps);
  T.buildReducedTour(deps);
  const build = performance.now() - t1;
  check('建立路徑（載入時一次）≤ 300 ms', build <= 300, `${build.toFixed(1)} ms`);
}

// ---------- main.js 只接線 ----------
{
  const main = read('src/main.js');
  const code = main.replace(/\/\/[^\n]*/g, '');
  check('main.js import createMenuTour', /import \{ createMenuTour \} from '\.\/ui\/menu-tour\.js';/.test(code));
  const attract = code.slice(code.indexOf('const updateAttract'), code.indexOf('const ring = '));
  check('updateAttract：tour.update → dayNight.update → stepWorld → updateEnvironment（center = 巡覽看點）',
    /tour\.update\(dt\);\s*dayNight\.update\(dt, attractFocus\);\s*stepWorld\(dt, attractFocus\);\s*updateEnvironment\(dt, worldStep\.simDt\);/.test(attract));
  check('舊出生點環繞已移除', !/orbitCenter|orbitT/.test(code));
  check('淡出淡入接最小黑幕元素（#tour-fade，opts.fade 寫 opacity）', /createElement\('div'\)/.test(code) && /tourFade\.id = 'tour-fade'/.test(code) && /fade: \(a\) => \{\s*tourFade\.style\.opacity = String\(a\);/.test(code));
  check('reducedMotion 接 prefers-reduced-motion', /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(code) && /reducedMotion: \(\) =>/.test(code));
  const sg = code.slice(code.indexOf('const startGame'), code.indexOf('const pauseGame'));
  check('startGame 呼叫 tour.stop()', sg.includes('tour.stop();'));
  const qm = code.slice(code.indexOf('const quitToMenu'), code.indexOf("bus.on('game:start'"));
  check('quitToMenu 呼叫 tour.start()', qm.includes('tour.start();'));
  const iRig = code.indexOf('rig.update(dt, input, focus, {');
  const iHand = code.indexOf('tour.handoff(dt);');
  check('updateGame：tour.handoff(dt) 緊接 rig.update 之後', iRig > 0 && iHand > iRig && iHand - code.indexOf('});', iRig) < 20);
  check('stall 取 stallRow 原攤車格（缺 → NIGHT_MARKET_DELIVERY.pickup）', /stallSlots\.find\(\(s\) => s\.key === STALL_BASE_KEY\)/.test(code) && /NIGHT_MARKET_DELIVERY\.pickup/.test(code.slice(code.indexOf('createMenuTour({'))));
  const traffic = read('src/traffic.js');
  const ct = (traffic.match(/CAR_TYPES\s*=\s*\[[^\]]*\]/) || [''])[0];
  check('traffic CAR_TYPES 不含 garbage_truck', ct !== '' && !ct.includes('garbage'), ct.slice(0, 80));
}

console.log(fail === 0 ? `PASS ${pass}/${pass + fail}` : `FAIL ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
