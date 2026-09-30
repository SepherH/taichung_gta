// 鏡頭無頭測試：以 mock terrain（querySurface）與 mock occluder（半空間牆 / 天花板 / 地面的球體掃掠）驅動 src/camera.js 的 CameraRig
// 驗證俯仰上下限、仰角 80° 時鏡頭離地、仰視不穿牆 / 不穿天花板、預設視角（4.1 m + 越肩 0.3）、轉動換算；
// A1：V 三段循環、滾輪微調範圍、越肩貼牆縮小、駕駛三段 / 車種比例 / 速度拉遠 / FOV、回正時序、lookBack、shake 衰減
// 用法：node tools/test/camera.mjs（任一斷言失敗 exit 1）
import * as THREE from 'three';

const { CameraRig, PITCH_MIN, PITCH_MAX, WALK_DISTS, CAR_DISTS, BIKE_DISTS } = await import('../../src/camera.js');
const { LOOK_RAD_PER_UNIT } = await import('../../src/input.js');

let pass = 0;
let total = 0;
const DEG = 180 / Math.PI;
function check(name, ok, detail = '') {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------- mock ----------
// 地面：height(x, z)；waterY 可選
function mockTerrain(height, waterY = null) {
  return {
    querySurface(x, z, yHint, out) {
      out.y = height(x, z);
      out.waterY = waterY;
      return out;
    },
  };
}

// 障礙物 = 半空間 { axis: 'x'|'y'|'z', side: -1（值以下是實體）| 1（值以上是實體）, v }
// sweep：球心沿 from → to，碰到「平面 − 半徑」的比例；起點已在內部時回傳下限 0.05（同 PhysicsOccluder）
function mockOccluder(planes) {
  return {
    calls: 0,
    sweep(from, to, r) {
      this.calls++;
      let best = 1;
      for (const p of planes) {
        const a = from[p.axis];
        const b = to[p.axis];
        const lim = p.v - p.side * r; // 球心不可越過的位置
        const inside = (x) => (p.side < 0 ? x < lim : x > lim);
        if (inside(a)) return 0.05;
        if (!inside(b)) continue;
        best = Math.min(best, (lim - a) / (b - a));
      }
      return Math.max(0.05, best);
    },
  };
}

function makeInput() {
  const q = { dx: 0, dy: 0, wheel: 0 };
  return {
    q,
    consumeMouse() {
      const out = { ...q };
      q.dx = 0;
      q.dy = 0;
      q.wheel = 0;
      return out;
    },
  };
}

// 跑 n 幀（dt = 1/60），第一幀送入 dy；回傳 { rig, cam, elev（視線仰角，度）}
function run({ terrain, occ, focus = new THREE.Vector3(0, 0, 0), dy = 0, pitch = null, yaw = 0, frames = 180, opts = {} }) {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 2000);
  const rig = new CameraRig(cam, occ, terrain);
  rig.yaw = yaw;
  if (pitch !== null) rig.pitch = pitch;
  const input = makeInput();
  input.q.dy = dy;
  for (let i = 0; i < frames; i++) rig.update(1 / 60, input, focus, opts);
  const dir = cam.getWorldDirection(new THREE.Vector3());
  return { rig, cam, elev: Math.asin(dir.y) * DEG };
}

const flat = mockTerrain(() => 0);
const noOcc = mockOccluder([]);

// 1. 俯仰上下限
const up = run({ terrain: flat, occ: noOcc, dy: -1e6 });
const down = run({ terrain: flat, occ: noOcc, dy: 1e6 });
check('仰角上限 = 80°', Math.abs(-up.rig.pitch * DEG - 80) < 1e-9 && PITCH_MIN === up.rig.pitch, `pitch=${(up.rig.pitch * DEG).toFixed(2)}°`);
check('俯角上限 ≈ 70°（72°）', Math.abs(down.rig.pitch * DEG - 72) < 1e-9 && PITCH_MAX === down.rig.pitch, `pitch=${(down.rig.pitch * DEG).toFixed(2)}°`);

// 2. 平地仰角 80°：鏡頭離地 ≥ 0.3、實際視線仰角 ≈ 80°、仍保有距離
const g = up.cam.position;
const horiz = Math.hypot(g.x, g.z);
check('平地仰角 80°：鏡頭 y ≥ 地面 + 0.3', g.y >= 0.3, `y=${g.y.toFixed(3)}`);
check('平地仰角 80°：實際視線仰角 ≥ 79°', up.elev >= 79, `elev=${up.elev.toFixed(2)}°`);
check('平地仰角 80°：目標點抬高、鏡頭距目標 ≥ 3 m', up.cam.position.distanceTo(up.rig._target) >= 3 && up.rig._target.y > 1.5, `dist=${up.cam.position.distanceTo(up.rig._target).toFixed(2)} target.y=${up.rig._target.y.toFixed(2)} 水平=${horiz.toFixed(2)}`);
check('俯角 72°：視線俯角 ≈ 72°', Math.abs(-down.elev - 72) < 0.5, `elev=${down.elev.toFixed(2)}°`);

// 3. 斜坡 / 起伏地形：鏡頭所在點 ≥ 地面 + 0.3（鏡頭在坡上方 / 下方兩種方向）
let minClear = Infinity;
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  for (const h of [(x, z) => 0.35 * x + 0.2 * z, (x, z) => Math.sin(x * 0.4) * 1.5 + Math.cos(z * 0.3)]) {
    const terrain = mockTerrain(h);
    const focus = new THREE.Vector3(3, h(3, 2), 2);
    for (const dy of [-1e6, -300, 0, 1e6]) {
      const r = run({ terrain, occ: noOcc, focus, dy, yaw });
      const p = r.cam.position;
      minClear = Math.min(minClear, p.y - h(p.x, p.z));
    }
  }
}
check('起伏地形 32 種組合：鏡頭離地皆 ≥ 0.3', minClear >= 0.3, `最小離地=${minClear.toFixed(3)} m`);

// 4. 仰視貼牆：角色背後 1.2 m 是建築（z < -1.2 為實體），鏡頭球體不可進牆
const wallZ = -1.2;
let minWallGap = Infinity;
for (const dy of [-1e6, -200, 0, 400]) {
  const r = run({ terrain: flat, occ: mockOccluder([{ axis: 'z', side: -1, v: wallZ }]), dy });
  minWallGap = Math.min(minWallGap, r.cam.position.z - wallZ);
  if (dy === -1e6) check('背後貼牆仰角 80°：鏡頭 y ≥ 0.3', r.cam.position.y >= 0.3, `y=${r.cam.position.y.toFixed(3)} elev=${r.elev.toFixed(1)}°`);
}
check('背後貼牆 4 種俯仰：鏡頭中心離牆 ≥ 碰撞半徑 0.35', minWallGap >= 0.35 - 1e-9, `最小離牆=${minWallGap.toFixed(3)} m`);

// 5. 騎樓天花板（y > 3 為實體）：仰視抬高的目標點與鏡頭不進天花板
const ceil = run({ terrain: flat, occ: mockOccluder([{ axis: 'y', side: 1, v: 3 }]), dy: -1e6 });
check('騎樓下仰視：目標點不進天花板', ceil.rig._target.y <= 3 - 0.35 + 1e-9, `target.y=${ceil.rig._target.y.toFixed(3)}`);
check('騎樓下仰視：鏡頭在天花板下、離地 ≥ 0.3', ceil.cam.position.y <= 3 && ceil.cam.position.y >= 0.3, `y=${ceil.cam.position.y.toFixed(3)}`);

// 6. 物理掃掠含地面（PhysicsOccluder 的 heightfield 也會擋）：y < 0 為實體
const withGround = run({ terrain: flat, occ: mockOccluder([{ axis: 'y', side: -1, v: 0 }]), dy: -1e6 });
check('掃掠含地面：仰角 80° 鏡頭 y ≥ 0.3 且視線仰角 ≥ 79°', withGround.cam.position.y >= 0.3 && withGround.elev >= 79, `y=${withGround.cam.position.y.toFixed(3)} elev=${withGround.elev.toFixed(2)}°`);

// 7. 駕駛同樣適用
const drv = run({ terrain: flat, occ: noOcc, dy: -1e6, opts: { driving: true, vehicleYaw: 0, speed: 0, distScale: 1.3 } });
check('駕駛仰角 80°：鏡頭 y ≥ 0.3、視線仰角 ≥ 79°', drv.cam.position.y >= 0.3 && drv.elev >= 79, `y=${drv.cam.position.y.toFixed(3)} elev=${drv.elev.toFixed(2)}°`);

// 8. 湖面：鏡頭不低於水面 + 0.3
const lake = run({ terrain: mockTerrain(() => -4, -1), occ: noOcc, focus: new THREE.Vector3(0, -1, 0), dy: -1e6 });
check('湖面上仰視：鏡頭 y ≥ 水面 + 0.3', lake.cam.position.y >= -1 + 0.3, `y=${lake.cam.position.y.toFixed(3)}`);

// 9. 預設視角（pitch 0.32、平地無遮擋）：目標 = 腳底 + 1.5 再右移 0.3、距離 4.1；鏡頭同樣右移（右方 = (−cos, 0, sin)）
const def = run({ terrain: flat, occ: noOcc, yaw: 0.7 });
const cp = Math.cos(0.32);
const rx = -Math.cos(0.7) * 0.3;
const rz = Math.sin(0.7) * 0.3;
const exp = new THREE.Vector3(rx - Math.sin(0.7) * cp * 4.1, 1.5 + Math.sin(0.32) * 4.1, rz - Math.cos(0.7) * cp * 4.1);
const expT = new THREE.Vector3(rx, 1.5, rz);
check('預設視角：距離 4.1、越肩右偏 0.3（鏡頭與注視點同移）', def.cam.position.distanceTo(exp) < 1e-6 && def.rig._target.distanceTo(expT) < 1e-9,
  `誤差=${def.cam.position.distanceTo(exp).toExponential(1)}`);
check('步行 FOV = 60', Math.abs(def.cam.fov - 60) < 1e-6, `fov=${def.cam.fov.toFixed(3)}`);

// 10. 轉動換算：dx 800 → 360°；dy 同比例
{
  const cam = new THREE.PerspectiveCamera();
  const rig = new CameraRig(cam, noOcc, flat);
  const input = makeInput();
  input.q.dx = 800;
  rig.update(1 / 60, input, new THREE.Vector3());
  const y0 = rig.pitch;
  input.q.dy = 50;
  rig.update(1 / 60, input, new THREE.Vector3());
  check('dx 800 → yaw −360°、dy 50 → pitch +50×LOOK_RAD_PER_UNIT', Math.abs(rig.yaw + 2 * Math.PI) < 1e-9 && Math.abs(rig.pitch - y0 - 50 * LOOK_RAD_PER_UNIT) < 1e-9);
}

// ---------- A1 新增 ----------
// 逐幀驅動：step(n, opts, { dx, wheel }) 每幀可換 opts
function makeRig({ yaw = 0, pitch = null, occ = noOcc, terrain = flat } = {}) {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 2000);
  const rig = new CameraRig(cam, occ, terrain);
  rig.yaw = yaw;
  if (pitch !== null) rig.pitch = pitch;
  const input = makeInput();
  const focus = new THREE.Vector3();
  const step = (n, opts = {}, send = null) => {
    for (let i = 0; i < n; i++) {
      if (send && i === 0) Object.assign(input.q, send);
      rig.update(1 / 60, input, focus, typeof opts === 'function' ? opts(i) : opts);
    }
  };
  const camDist = () => cam.position.distanceTo(rig._target);
  return { rig, cam, step, camDist, focus };
}

// 11. V 三段循環（步行）：4.1 → 6.0 → 2.7 → 4.1，實際鏡頭距離平滑到位
{
  const { rig, step, camDist } = makeRig();
  const seen = [];
  for (let k = 0; k < 4; k++) {
    step(1, { cycleView: true });
    step(180);
    seen.push(camDist());
  }
  const want = [6.0, 2.7, 4.1, 6.0];
  check('步行 V 三段循環 4.1 → 6.0 → 2.7 → 4.1 → 6.0', seen.every((d, i) => Math.abs(d - want[i]) < 1e-3) && WALK_DISTS.join() === '2.7,4.1,6',
    seen.map((d) => d.toFixed(2)).join(' / '));
  // 單次按 V 後下一幀不跳動（平滑）
  const r2 = makeRig();
  r2.step(60);
  const d0 = r2.camDist();
  r2.step(1, { cycleView: true });
  check('V 切段平滑：第一幀距離變化 < 0.2 m', Math.abs(r2.camDist() - d0) < 0.2 && Math.abs(r2.camDist() - d0) > 0, `Δ=${(r2.camDist() - d0).toFixed(3)}`);
}

// 12. 滾輪：步行連續微調、範圍 2.5–12；V 重設到該段；駕駛時滾輪不改步行距離
{
  const { rig, step } = makeRig();
  step(1, {}, { wheel: 100 });
  const far = rig.dist;
  for (let i = 0; i < 5; i++) step(1, {}, { wheel: 5000 });
  const farMax = rig.dist;
  for (let i = 0; i < 10; i++) step(1, {}, { wheel: -900 });
  const nearMin = rig.dist;
  step(1, { cycleView: true }); // 段位 1 → 2
  const reset = rig.dist;
  step(1, { driving: true, vehicleYaw: 0, speed: 0 }, { wheel: 5000 });
  check('滾輪微調：單次連續變化、上限 12、下限 2.5', far > 4.1 && far < 12 && farMax === 12 && nearMin === 2.5, `${far.toFixed(2)} / ${farMax} / ${nearMin}`);
  check('滾輪後按 V 重設到段位值（6.0）；駕駛時滾輪不改步行距離', reset === 6.0 && rig.dist === 6.0, `reset=${reset} dist=${rig.dist}`);
}

// 13. 越肩貼牆：右方（yaw 0 → −X）0.5 m 處是牆（x < −0.5 實體），偏移縮小且注視點不進牆
{
  const { rig, step } = makeRig({ occ: mockOccluder([{ axis: 'x', side: -1, v: -0.5 }]) });
  step(120);
  const off = -rig._target.x;
  check('越肩貼牆：右偏縮到可用空間（0.15 m）、注視點離牆 ≥ 0.35', Math.abs(off - 0.15) < 1e-6 && rig._target.x - -0.5 >= 0.35 - 1e-9, `右偏=${off.toFixed(3)}`);
  // 離開牆邊後平滑回到 0.3
  rig.collision = noOcc;
  step(1);
  const mid = -rig._target.x;
  step(120);
  check('離牆後越肩平滑回到 0.3', mid > 0.15 && mid < 0.3 && Math.abs(-rig._target.x - 0.3) < 1e-4, `第一幀=${mid.toFixed(3)} 最終=${(-rig._target.x).toFixed(4)}`);
  // 駕駛無越肩
  step(120, { driving: true, vehicleYaw: 0, speed: 0 });
  check('駕駛時無越肩偏移', Math.abs(rig._target.x) < 1e-4, `x=${rig._target.x.toFixed(5)}`);
}

// 14. 駕駛距離：三段 × 車種比例（distScale / 轎車 1.35）、機車組、速度拉遠
function driveDist(opts, cycles = 0) {
  const { step, camDist } = makeRig();
  const o = { driving: true, vehicleYaw: 0, ...opts };
  for (let k = 0; k < cycles; k++) step(1, { ...o, cycleView: true });
  step(240, o);
  return camDist();
}
{
  const sedan = [0, 1, 2].map((c) => driveDist({ speed: 0, distScale: 1.35 }, c));
  check('汽車三段 6.4（預設）→ 8.9 → 5.2（轎車 camScale 1.35 = 基準）', [6.4, 8.9, 5.2].every((v, i) => Math.abs(sedan[i] - v) < 1e-3) && CAR_DISTS.join() === '5.2,6.4,8.9',
    sedan.map((d) => d.toFixed(2)).join(' / '));
  const bus = driveDist({ speed: 0, distScale: 2.4 });
  check('公車 camScale 2.4：6.4 × 2.4 / 1.35 ≈ 11.38 m', Math.abs(bus - (6.4 * 2.4) / 1.35) < 1e-3, `${bus.toFixed(2)}`);
  const bike = [0, 1, 2].map((c) => driveDist({ speed: 0, distScale: 1.0, twoWheeler: true }, c));
  check('機車組 5.0（預設）→ 6.0 → 4.3', [5.0, 6.0, 4.3].every((v, i) => Math.abs(bike[i] - v) < 1e-3) && BIKE_DISTS.join() === '4.3,5,6',
    bike.map((d) => d.toFixed(2)).join(' / '));
  const v66 = driveDist({ speed: 66 / 3.6, distScale: 1.35 });
  const v200 = driveDist({ speed: 200 / 3.6, distScale: 1.35 });
  const rev = driveDist({ speed: -33 / 3.6, distScale: 1.35 });
  check('速度拉遠：66 km/h ≈ +0.5 m、上限 +1.0 m', Math.abs(v66 - 6.9) < 1e-3 && Math.abs(v200 - 7.4) < 1e-3, `66=${v66.toFixed(3)} 200=${v200.toFixed(3)}`);
  check('倒車 33 km/h 同樣依速率拉遠 +0.25 m', Math.abs(rev - 6.65) < 1e-3, `${rev.toFixed(3)}`);
}

// 15. FOV：駕駛 62 → 66（0 → 100 km/h 線性），平滑
{
  const fovAt = (kmh) => {
    const { cam, step } = makeRig();
    step(300, { driving: true, vehicleYaw: 0, speed: kmh / 3.6, distScale: 1.35 });
    return cam.fov;
  };
  const f = [0, 50, 100, 160].map(fovAt);
  check('駕駛 FOV：0 → 62、50 → 64、100 → 66、160 → 66', [62, 64, 66, 66].every((v, i) => Math.abs(f[i] - v) < 1e-3), f.map((x) => x.toFixed(2)).join(' / '));
  const { cam, step } = makeRig();
  step(300, { driving: true, vehicleYaw: 0, speed: 0 });
  step(1, { driving: true, vehicleYaw: 0, speed: 100 / 3.6 });
  const f1 = cam.fov;
  step(1, { walk: true });
  check('FOV 平滑：62 → 66 首幀變化 < 0.2°、下車逐步回 60', f1 > 62 && f1 - 62 < 0.2 && cam.fov < f1, `首幀=${f1.toFixed(3)} 下車首幀=${cam.fov.toFixed(3)}`);
}

// 16. 回正時序：yaw 被轉到 +90° 後，1.9 s 不回、2.5 s 開始回；速率約 90°/s；倒車 / 低速不回
{
  const drive = (speed) => ({ driving: true, vehicleYaw: 0, speed, distScale: 1.35 });
  const { rig, step } = makeRig();
  step(1, drive(10), { dx: -200 }); // yaw = +90°，lastManual = 1/60 s
  const y0 = rig.yaw;
  step(Math.round(1.9 * 60) - 1, drive(10)); // 到 t = 1.9 s
  const y19 = rig.yaw;
  step(36, drive(10)); // 到 t = 2.5 s
  const y25 = rig.yaw;
  step(30, drive(10)); // 到 t = 3.0 s
  const y30 = rig.yaw;
  step(120, drive(10));
  const rate = (y25 - y30) * DEG / 0.5;
  check('回正：1.9 s 不回、2.5 s 已開始回', Math.abs(y0 - Math.PI / 2) < 1e-9 && y19 === y0 && y25 < y0 - 1e-3, `1.9s=${(y19 * DEG).toFixed(2)}° 2.5s=${(y25 * DEG).toFixed(2)}°`);
  check('回正速率 ≈ 90°/s，最後對準車尾', Math.abs(rate - 90) < 1 && Math.abs(rig.yaw) < 1e-9, `${rate.toFixed(1)}°/s 最終=${(rig.yaw * DEG).toFixed(3)}°`);
  const noRe = (speed) => {
    const r = makeRig();
    r.step(1, drive(speed), { dx: -200 });
    const a = r.rig.yaw;
    r.step(240, drive(speed));
    return r.rig.yaw - a;
  };
  check('倒車（−5 m/s）與低速（4 km/h）4 s 內不回正', noRe(-5) === 0 && noRe(4 / 3.6) === 0);
  // 轉視角輸入會重新計時
  const r3 = makeRig();
  r3.step(1, drive(10), { dx: -200 });
  r3.step(90, drive(10));
  r3.step(1, drive(10), { dx: -1 });
  const ya = r3.rig.yaw;
  r3.step(90, drive(10));
  check('轉視角輸入後重新計時（1.5 s 內不回）', r3.rig.yaw === ya);
}

// 17. lookBack：按住時鏡頭在車前方看車尾，放開立即回原本；不改 rig.yaw
{
  const o = { driving: true, vehicleYaw: 0, speed: 0, distScale: 1.35 };
  const { rig, cam, step } = makeRig();
  step(120, o);
  const zNormal = cam.position.z;
  step(1, { ...o, lookBack: true });
  const zBack = cam.position.z;
  const dir = cam.getWorldDirection(new THREE.Vector3());
  step(1, o);
  check('lookBack：鏡頭移到車頭前方、朝車後方看', zNormal < 0 && zBack > 5 && dir.z < -0.9, `z 平常=${zNormal.toFixed(2)} 回頭=${zBack.toFixed(2)} dir.z=${dir.z.toFixed(2)}`);
  check('放開 C 立即回原本、rig.yaw 未被改動', Math.abs(cam.position.z - zNormal) < 1e-6 && rig.yaw === 0, `z=${cam.position.z.toFixed(3)}`);
  const w = makeRig();
  w.step(60);
  const zw = w.cam.position.z;
  w.step(1, { lookBack: true });
  check('步行時 lookBack 無作用', Math.abs(w.cam.position.z - zw) < 1e-9);
}

// 18. 俯仰範圍未收窄
check('俯仰範圍：PITCH_MIN ≤ −80°（仰）、PITCH_MAX ≥ 72°（俯）', PITCH_MIN <= -80 / DEG + 1e-12 && PITCH_MAX >= 72 / DEG - 1e-12,
  `${(PITCH_MIN * DEG).toFixed(1)}° ～ ${(PITCH_MAX * DEG).toFixed(1)}°`);

// 19. shake：trauma² 振幅、指數衰減約 0.6 s、累加上限 1、結束後位置回原
{
  const base = makeRig();
  const s = makeRig();
  base.step(120);
  s.step(120);
  s.rig.shake(0.7);
  s.rig.shake(0.7);
  const capped = s.rig.trauma;
  let maxDev = 0;
  for (let i = 0; i < 6; i++) {
    base.step(1);
    s.step(1);
    maxDev = Math.max(maxDev, s.cam.position.distanceTo(base.cam.position));
  }
  s.step(30);
  base.step(30);
  const amp06 = s.rig.trauma ** 2; // t ≈ 0.6 s
  s.step(120);
  base.step(120);
  check('shake：累加上限 1、立即有位移（≤ 0.25 m）', capped === 1 && maxDev > 0.02 && maxDev <= 0.25 * Math.sqrt(3) + 1e-9, `最大位移=${maxDev.toFixed(3)} m`);
  check('shake：0.6 s 後振幅（trauma²）< 3%', amp06 < 0.03 && amp06 > 0, `trauma²=${amp06.toFixed(4)}`);
  const q = s.cam.quaternion.angleTo(base.cam.quaternion);
  check('shake 結束：trauma 歸零、位置與朝向回到無震動值', s.rig.trauma === 0 && s.cam.position.distanceTo(base.cam.position) < 1e-9 && q < 1e-6);
  const n = makeRig();
  n.rig.shake(0);
  n.rig.shake(-1);
  n.rig.shake(NaN);
  check('shake 非正值忽略', n.rig.trauma === 0);
}

console.log(`\n可達最大仰角 ${up.elev.toFixed(1)}°（pitch 下限 ${(-PITCH_MIN * DEG).toFixed(0)}°）、最大俯角 ${(-down.elev).toFixed(1)}°（pitch 上限 ${(PITCH_MAX * DEG).toFixed(0)}°）`);
console.log(pass === total ? `PASS ${pass}/${total}` : `FAIL ${total - pass}/${total}`);
process.exit(pass === total ? 0 : 1);
