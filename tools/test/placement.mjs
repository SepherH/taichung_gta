#!/usr/bin/env node
// 擺放 / 貼地無頭檢查（Node + node_modules/three）：所有放到地面上的東西都吃 terrain 唯一高度場
// 檢查：建築底部 / 裙邊無浮空、出生點 / 停車點、玩家走坡道到湖邊步道與紅橋甲板、車輛下北端坡道（四輪平均 / pitch 符號）、
//       車輛不可開下大階梯、玩家不可走進湖面、鏡頭在坡下往外看不鑽進邊坡、秋紅谷細節網格 draw call / 三角形 / 甲板高度、world 步道疊在甲板上的三角形已移除
// JSON 以 loader hook 轉成 ES module（等同 Vite 的 JSON import）；document / canvas 用最小 mock
// 用法：node tools/test/placement.mjs（任一斷言失敗 exit 1）
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

const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const { getTerrain, buildings: cityBuildings, surfaceFootways } = await import('../../src/citymodel.js');
const { buildBuildings, wallBottoms, WALL_SKIRT } = await import('../../src/buildings.js');
const { computeSpawn, computeParkedVehicles } = await import('../../src/places.js');
const { Player } = await import('../../src/player.js');
const { Vehicle } = await import('../../src/vehicle.js');
const { CollisionWorld } = await import('../../src/collision.js');
const { buildQiuhonggu, stripDeckOverlays } = await import('../../src/qiuhonggu.js');
const { buildWorld } = await import('../../src/world.js');
const { CameraRig } = await import('../../src/camera.js');
const { pointInPolygon, closestOnPolygon } = await import('../../src/geom.js');

const DT = 1 / 60;
const PLACE_TOL = 0.01;
const PLACE_MAX_SLOPE = 12;
const FOOT_TOL = 0.05;
const WHEEL_TOL = 0.05;
const DECK_TOL = 0.01;
const MAX_DRAWS = 12;
const MAX_TRIS = 60000;

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

const terrain = getTerrain();
const basin = terrain.patches.find((p) => p.kind === 'basin').feature.src;
const lv = basin.levels;
const q = {};
const inLake = (x, z) => terrain.lakes.some((l) => pointInPolygon(x, z, l.poly));

const scene = new THREE.Scene();
const qhg = buildQiuhonggu(terrain, { footways: surfaceFootways });
scene.add(qhg.group);

// ---------- 1. 建築 ----------
const blds = buildBuildings(scene, { anisotropy: 1 });
{
  let mismatch = 0;
  let maxGap = -Infinity;
  let worst = null;
  let verts = 0;
  let maxEdgeGap = -Infinity;
  let edgeSamples = 0;
  let thin = 0;
  let deep = 0;
  let lowest = Infinity;
  const byId = new Map(cityBuildings.map((b) => [b.id, b]));
  for (const c of blds.colliders) {
    if (c.base !== terrain.buildingBase(c.id)) mismatch++;
    const p = byId.get(c.id).poly;
    const n = p.length / 2;
    const bottoms = wallBottoms(p, c.base, terrain.heightAt);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (bottoms[i] > c.base - WALL_SKIRT + 1e-9) thin++;
      if (bottoms[i] < c.base - WALL_SKIRT - 1e-9) deep++;
      lowest = Math.min(lowest, bottoms[i]);
      // 縫隙 = 牆底高出地面多少（邊兩端頂點 + 沿邊每 0.5 m）；≤ 0 表示牆埋進地面
      for (const k of [i, j]) {
        verts++;
        const gap = bottoms[i] - terrain.heightAt(p[k * 2], p[k * 2 + 1]);
        if (gap > maxGap) {
          maxGap = gap;
          worst = c;
        }
      }
      const L = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
      const m = Math.max(1, Math.ceil(L / 0.5));
      for (let k = 1; k < m; k++) {
        const x = p[i * 2] + ((p[j * 2] - p[i * 2]) * k) / m;
        const z = p[i * 2 + 1] + ((p[j * 2 + 1] - p[i * 2 + 1]) * k) / m;
        edgeSamples++;
        maxEdgeGap = Math.max(maxEdgeGap, bottoms[i] - terrain.heightAt(x, z));
      }
    }
  }
  const nonZero = blds.colliders.filter((c) => c.base !== 0).length;
  check(mismatch === 0, `建築 ${blds.colliders.length} 棟 collider.base = terrain.buildingBase（不符 ${mismatch}；base ≠ 0 者 ${nonZero} 棟）`);
  check(thin === 0, `每條邊牆底 ≤ base − ${WALL_SKIRT}（裙邊不足 ${thin} 邊；因邊下地面更低而加深 ${deep} 邊）`);
  check(maxGap <= 0, `輪廓頂點 ${verts} 點（每邊兩端）牆底 ≤ 地面：最大縫隙 ${f3(maxGap)} m（${worst ? `${worst.id} ${worst.name}` : ''}；≤ 0 = 無浮空）`);
  check(maxEdgeGap <= 0, `輪廓邊每 0.5 m ${edgeSamples} 點同上：最大縫隙 ${f3(maxEdgeGap)} m`);
  let minY = Infinity;
  for (const m of blds.meshes) {
    const a = m.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) minY = Math.min(minY, a.getY(i));
  }
  check(Math.abs(minY - lowest) < 1e-4, `建築網格最低頂點 y ${f3(minY)} = 最低牆底 ${f3(lowest)}（網格確實採用 wallBottoms）`);
}

// ---------- 2. 出生點 / 停車點 ----------
const spawn = computeSpawn();
const parked = computeParkedVehicles(spawn);
{
  const pts = [{ name: 'spawn', ...spawn }, ...parked.map((p, i) => ({ name: `park${i}:${p.type}`, ...p }))];
  let maxD = 0;
  let wet = 0;
  let maxSlope = 0;
  for (const p of pts) {
    terrain.querySurface(p.x, p.z, Infinity, q);
    maxD = Math.max(maxD, Math.abs(p.y - q.y));
    if (inLake(p.x, p.z)) wet++;
    maxSlope = Math.max(maxSlope, (Math.acos(Math.min(1, q.ny)) * 180) / Math.PI);
  }
  check(pts.every((p) => Number.isFinite(p.y)) && maxD < PLACE_TOL, `出生點 + 停車 ${parked.length} 台：y 與 querySurface 最大差 ${maxD.toExponential(2)}（出生點 y ${f3(spawn.y)}）`);
  check(wet === 0 && maxSlope <= PLACE_MAX_SLOPE, `落在湖內 ${wet} 點、最大地面坡度 ${maxSlope.toFixed(2)}°（≤ ${PLACE_MAX_SLOPE}°）`);
}

// ---------- 共用：碰撞、mock 輸入 ----------
const collision = new CollisionWorld(25);
for (const c of blds.colliders) collision.addPolygon(c.poly, c.base + c.h, c.name);
const keys = new Set();
const input = { down: (c) => keys.has(c), wasPressed: () => false };

// 往 (tx, tz) 走（鏡頭朝向目標、按住 W）；回傳統計
function walkTo(player, tx, tz, maxFrames, stat, stopDist = 0.3) {
  keys.add('KeyW');
  let f = 0;
  for (; f < maxFrames; f++) {
    const dx = tx - player.pos.x;
    const dz = tz - player.pos.z;
    if (Math.hypot(dx, dz) < stopDist) break;
    player.update(DT, input, Math.atan2(dx, dz), collision, terrain, []);
    stat.frames++;
    if (player.onGround) {
      const y = terrain.querySurface(player.pos.x, player.pos.z, player.pos.y, q).y;
      stat.maxFoot = Math.max(stat.maxFoot, Math.abs(player.pos.y - y));
    } else stat.air++;
    if (inLake(player.pos.x, player.pos.z) && !q.walkable) stat.wet++;
    stat.minY = Math.min(stat.minY, player.pos.y);
  }
  keys.delete('KeyW');
  return f < maxFrames;
}
const newStat = () => ({ frames: 0, maxFoot: 0, air: 0, wet: 0, minY: Infinity });

// 由點 (x, z) 沿單位向量 (ux, uz) 前進，直到 pred(h) 成立（最多 maxD m），回傳該點
function march(x, z, ux, uz, pred, maxD = 80) {
  for (let s = 0; s < maxD; s += 0.25) {
    const px = x + ux * s;
    const pz = z + uz * s;
    if (pred(terrain.heightAt(px, pz), px, pz)) return { x: px, z: pz, s };
  }
  return null;
}

// 北端坡道剖面：ramp_start（T.features）往最近的 ramp 外框邊找坡頂、往最近湖岸找湖邊步道
const rampStart = basin.features.find((f) => f.k === 'ramp_start');
const rs = { x: rampStart.p[0], z: rampStart.p[1] };
closestOnPolygon(rs.x, rs.z, basin.lake, q);
const lakeDir = (() => {
  const d = Math.hypot(q.x - rs.x, q.z - rs.z);
  return { ux: (q.x - rs.x) / d, uz: (q.z - rs.z) / d, d };
})();
const walkwayPt = { x: q.x - lakeDir.ux * 1.5, z: q.z - lakeDir.uz * 1.5 }; // 湖岸外 1.5 m（湖邊步道帶內）

// ---------- 3. 玩家：坡道起點 → 湖邊步道 ----------
{
  const player = new Player(scene, { x: rs.x, z: rs.z, yaw: 0 });
  player.placeAt(rs.x, rs.z, 0, terrain);
  const y0 = player.pos.y;
  const st = newStat();
  const reached = walkTo(player, walkwayPt.x, walkwayPt.z, 60 * 60, st);
  const endG = terrain.querySurface(player.pos.x, player.pos.z, player.pos.y, q).y;
  check(reached, `玩家由北端坡道起點 (${rs.x}, ${rs.z}) y ${f3(y0)} 走 ${(st.frames * DT).toFixed(1)} s 抵達湖邊步道點（距 ${f3(Math.hypot(player.pos.x - walkwayPt.x, player.pos.z - walkwayPt.z))} m）`);
  check(st.maxFoot < FOOT_TOL && st.air === 0, `每幀腳底 y 與 querySurface 最大差 ${st.maxFoot.toExponential(2)}（${st.frames} 幀，離地 ${st.air} 幀）`);
  check(Math.abs(player.pos.y - lv.walkway) < 0.1 && Math.abs(player.pos.y - endG) < 1e-9, `終點 y ${f3(player.pos.y)} ≈ walkway ${lv.walkway}`);

  // 繼續往湖心走 3 s：不可進入湖面
  const st2 = newStat();
  walkTo(player, q.x + lakeDir.ux * 20, q.z + lakeDir.uz * 20, 180, st2);
  closestOnPolygon(player.pos.x, player.pos.z, basin.lake, q);
  check(st2.wet === 0 && !inLake(player.pos.x, player.pos.z), `往湖心再走 3 s：進入湖面 ${st2.wet} 幀，停在湖岸外 ${f3(Math.sqrt(q.d2))} m、y ${f3(player.pos.y)}`);
}

// ---------- 4. 玩家：湖岸 → 紅橋甲板中央 ----------
{
  const bridge = terrain.walkables.filter((w) => w.kind === 'bridge');
  const feat = basin.features.find((f) => f.k === 'lake_bridge_osm') || basin.features.find((f) => f.k === 'red_bridge');
  const P = [];
  for (let i = 0; i < feat.p.length; i += 2) P.push({ x: feat.p[i], z: feat.p[i + 1] });
  const L = Math.hypot(P[1].x - P[0].x, P[1].z - P[0].z);
  const ux = (P[1].x - P[0].x) / L;
  const uz = (P[1].z - P[0].z) / L;
  const sx = P[0].x - ux * 4;
  const sz = P[0].z - uz * 4;
  const player = new Player(scene, { x: sx, z: sz, yaw: 0 });
  player.placeAt(sx, sz, 0, terrain);
  const y0 = player.pos.y;
  const st = newStat();
  const mid = Math.floor(P.length / 2);
  let ok = true;
  for (let i = 0; i <= mid && ok; i++) ok = walkTo(player, P[i].x, P[i].z, 60 * 30, st);
  const deckY = bridge[0].heightAt(player.pos.x, player.pos.z);
  terrain.querySurface(player.pos.x, player.pos.z, player.pos.y, q);
  check(ok && st.maxFoot < FOOT_TOL && st.wet === 0, `玩家由湖岸 y ${f3(y0)} 沿紅橋走到第 ${mid} 折點：每幀腳底差最大 ${st.maxFoot.toExponential(2)}、落湖 ${st.wet} 幀、最低 y ${f3(st.minY)}`);
  check(Math.abs(player.pos.y - deckY) < 0.01 && !!q.walkable && player.pos.y > q.waterY, `紅橋甲板中央 y ${f3(player.pos.y)} ≈ 甲板 ${f3(deckY)}（水面 ${q.waterY}、湖床 ${f3(terrain.heightAt(player.pos.x, player.pos.z))}）`);
}

// ---------- 4b. 玩家：東岸 → Z 字湖上步道（瀏覽器實測東端卡在 x≈128.6 的回歸）----------
{
  const zig = terrain.walkables.filter((w) => w.kind === 'boardwalk');
  const feat = basin.features.find((f) => f.k === 'zigzag_walk');
  const P = [];
  for (let i = 0; i < feat.p.length; i += 2) P.push({ x: feat.p[i], z: feat.p[i + 1] });
  const L = Math.hypot(P[1].x - P[0].x, P[1].z - P[0].z);
  const ux = (P[1].x - P[0].x) / L;
  const uz = (P[1].z - P[0].z) / L;
  const sx = P[0].x - ux * 5;
  const sz = P[0].z - uz * 5;
  const player = new Player(scene, { x: sx, z: sz, yaw: 0 });
  player.placeAt(sx, sz, 0, terrain);
  const y0 = player.pos.y;
  const st = newStat();
  let ok = true;
  for (let i = 0; i < P.length && ok; i++) ok = walkTo(player, P[i].x, P[i].z, 60 * 30, st);
  const deckY = zig[0].heightAt(player.pos.x, player.pos.z);
  terrain.querySurface(player.pos.x, player.pos.z, player.pos.y, q);
  check(ok && st.maxFoot < FOOT_TOL && st.wet === 0, `玩家由東岸 y ${f3(y0)} 走上 Z 字步道到湖心端（${P.length} 點）：每幀腳底差最大 ${st.maxFoot.toExponential(2)}、落湖 ${st.wet} 幀、終點 (${f3(player.pos.x)}, ${f3(player.pos.z)})`);
  check(Math.abs(player.pos.y - deckY) < 0.01 && !!q.walkable, `Z 字步道湖心端 y ${f3(player.pos.y)} ≈ 甲板 ${f3(deckY)}`);
}

// ---------- 5. 車輛：北端坡道頂 → 坡底 ----------
{
  // 坡頂：由 ramp_start 反湖方向找到路面高（h ≥ −0.01）；再往回 1 m 保持在坡上
  const top = march(rs.x, rs.z, -lakeDir.ux, -lakeDir.uz, (h) => h >= -0.01);
  const sx = top.x + lakeDir.ux * 1;
  const sz = top.z + lakeDir.uz * 1;
  const car = new Vehicle(scene, 'sedan', '#ffffff', sx, sz, Math.atan2(lakeDir.ux, lakeDir.uz));
  car.pos.y = terrain.querySurface(sx, sz, Infinity, q).y;
  car.settle(terrain, 0, true);
  const y0 = car.pos.y;
  let maxWheel = 0;
  let downFrames = 0;
  let noseDown = 0;
  let meshNoseDown = 0;
  let wet = 0;
  let frames = 0;
  const p = {};
  const ctrl = { throttle: true, reverse: false, left: false, right: false, handbrake: false };
  for (; frames < 60 * 30; frames++) {
    // 保持朝湖、限速約 25 km/h
    ctrl.throttle = car.speed < 7;
    car.update(DT, ctrl, collision, terrain, []);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      car.wheelPos(k, car.pos.x, car.pos.z, car.yaw, p);
      sum += terrain.querySurface(p.x, p.z, car.pos.y, q).y;
      if (inLake(p.x, p.z) && !q.walkable) wet++;
    }
    maxWheel = Math.max(maxWheel, Math.abs(sum / 4 - car.pos.y));
    const drop = car.wheelY[0] + car.wheelY[1] - car.wheelY[2] - car.wheelY[3];
    if (frames > 30 && drop < -0.1) {
      downFrames++;
      if (car.pitch < 0) noseDown++;
      car.syncMesh();
      if (car.mesh.rotation.x > 0) meshNoseDown++;
    }
    if (car.pos.y <= lv.walkway + 0.05 && Math.abs(car.speed) < 0.5) break;
    if (Math.abs(car.speed) < 0.05 && frames > 120) break;
  }
  check(maxWheel < WHEEL_TOL, `轎車由坡頂 y ${f3(y0)} 開下北端坡道 ${frames} 幀：四輪平均高度與車身 y 最大差 ${maxWheel.toExponential(2)}`);
  check(downFrames > 60 && noseDown === downFrames && meshNoseDown === downFrames, `下坡幀 ${downFrames}：pitch < 0（車頭朝下）${noseDown} 幀、mesh.rotation.x > 0 ${meshNoseDown} 幀`);
  check(wet === 0 && Math.abs(car.pos.y - lv.walkway) < 0.3, `抵達坡底 y ${f3(car.pos.y)}（walkway ${lv.walkway}），輪位落湖 ${wet} 次`);
}

// ---------- 6. 車輛：下沉廣場大階梯開不下去 ----------
{
  const st = terrain.walkables.find((w) => w.kind === 'stairs');
  const pl = st.poly;
  const mx = (pl[0] + pl[2]) / 2;
  const mz = (pl[1] + pl[3]) / 2;
  const dL = Math.hypot(pl[6] - pl[0], pl[7] - pl[1]);
  const dx = (pl[6] - pl[0]) / dL;
  const dz = (pl[7] - pl[1]) / dL;
  const car = new Vehicle(scene, 'sedan', '#ffffff', mx - dx * 5, mz - dz * 5, Math.atan2(dx, dz));
  car.pos.y = terrain.querySurface(car.pos.x, car.pos.z, Infinity, q).y;
  car.settle(terrain, 0, true);
  const ctrl = { throttle: true, reverse: false, left: false, right: false, handbrake: false };
  let minY = Infinity;
  for (let f = 0; f < 60 * 5; f++) {
    car.update(DT, ctrl, collision, terrain, []);
    minY = Math.min(minY, car.pos.y);
  }
  check(minY > -0.3, `轎車朝下沉廣場大階梯全油門 5 s：車身最低 y ${f3(minY)}（未開下階梯）`);
}

// ---------- 7. 鏡頭：湖邊步道往湖看（鏡頭在背後的邊坡側），不得低於地面 + 0.4、連線不穿地 ----------
{
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 2000);
  const rig = new CameraRig(cam, collision, terrain);
  const mouse = { consumeMouse: () => ({ dx: 0, dy: 0, wheel: 0 }) };
  const focus = new THREE.Vector3(walkwayPt.x, terrain.heightAt(walkwayPt.x, walkwayPt.z), walkwayPt.z);
  let worstClear = Infinity;
  let worstRay = Infinity;
  let minRatio = Infinity;
  for (const pitch of [-0.12, 0, 0.1, 0.32]) {
    for (const dist of [7, 15, 30]) {
      rig.yaw = Math.atan2(lakeDir.ux, lakeDir.uz); // 看向湖 → 鏡頭在坡道側
      rig.pitch = pitch;
      rig.dist = dist;
      rig.curDist = dist;
      for (let f = 0; f < 90; f++) rig.update(DT, mouse, focus, {});
      const c = cam.position;
      worstClear = Math.min(worstClear, c.y - rig.groundAt(c.x, c.z));
      const t = new THREE.Vector3(focus.x, focus.y + 1.5, focus.z);
      const n = Math.ceil(t.distanceTo(c) / 0.25);
      for (let i = 1; i <= n; i++) {
        const p = t.clone().lerp(c, i / n);
        worstRay = Math.min(worstRay, p.y - terrain.heightAt(p.x, p.z));
      }
      minRatio = Math.min(minRatio, rig.curDist / dist);
    }
  }
  check(worstClear >= 0.4 - 1e-9 && worstRay > 0, `鏡頭 12 組 pitch / 距離：離地最小 ${f3(worstClear)} m（≥ 0.4）、目標→鏡頭連線（每 0.25 m）離地最小 ${f3(worstRay)} m、被邊坡擋住時最多拉近到設定距離的 ${f3(minRatio)}`);
}

// ---------- 8. 秋紅谷細節網格 ----------
{
  const s = qhg.stats;
  check(s.drawCalls <= MAX_DRAWS && s.triangles <= MAX_TRIS, `qiuhonggu draw call ${s.drawCalls}（≤ ${MAX_DRAWS}）、三角形 ${s.triangles}（≤ ${MAX_TRIS}）`);
  let maxD = 0;
  let maxW = 0;
  const bridge = terrain.walkables.filter((w) => w.kind === 'bridge');
  for (const [x, y, z] of qhg.deckTop) {
    maxD = Math.max(maxD, Math.abs(terrain.querySurface(x, z, Infinity, q).y - y));
    const w = bridge.find((b) => pointInPolygon(x, z, b.poly));
    maxW = Math.max(maxW, w ? Math.abs(w.heightAt(x, z) - y) : Infinity);
  }
  check(qhg.deckTop.length > 0 && maxD < DECK_TOL && maxW < DECK_TOL, `紅橋甲板頂面 ${qhg.deckTop.length} 頂點：與 querySurface 最大差 ${maxD.toExponential(2)}、與所在 walkable 平面最大差 ${maxW.toExponential(2)}`);
  console.log(`INFO 紅橋 ${s.bridges} 座、Z 字步道 ${s.boardwalks} 條、柱墩 ${s.piers} 根、退台踏階 ${s.terraceFlights} 道、灰色欄杆立柱 ${s.guardPosts} 根`);
  console.log(`INFO 下沉廣場大階梯 ${s.plazaSteps} 級（級高 0.15、級深 ${f3(s.plazaTread)} m）、木平台 ${s.platform ? `${s.platform.length} 角` : '無'}`);
  for (const m of qhg.meshes) console.log(`INFO   ${m.name}：${m.geometry.attributes.position.count / 3} 三角形`);

  // 木平台 walkable：中心 querySurface = 平台頂
  const plat = terrain.walkables.find((w) => w.kind === 'deck');
  if (plat) {
    let cx = 0;
    let cz = 0;
    const n = plat.poly.length / 2;
    for (let i = 0; i < plat.poly.length; i += 2) {
      cx += plat.poly[i] / n;
      cz += plat.poly[i + 1] / n;
    }
    const floor = terrain.heightAt(cx, cz);
    terrain.querySurface(cx, cz, floor, q);
    check(Math.abs(q.y - plat.heightAt(cx, cz)) < 1e-9, `下沉廣場木平台中心 y ${f3(q.y)}（廣場底 ${f3(floor)}，由廣場底可跨上）`);
  } else check(false, '下沉廣場缺木平台 walkable');

  // world.js 步道 ribbon 疊在甲板上的三角形移除
  const world = buildWorld(new THREE.Scene());
  const removed = stripDeckOverlays(world.group, terrain);
  const again = stripDeckOverlays(world.group, terrain);
  check(removed > 0 && again === 0, `world 步道 ribbon 貼在甲板上的三角形移除 ${removed} 個（再跑一次 ${again}）`);
}

if (failed) {
  console.log(`\n${failed} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
