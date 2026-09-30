// 鏡頭無頭測試：以 mock terrain（querySurface）與 mock occluder（半空間牆 / 天花板 / 地面的球體掃掠）驅動 src/camera.js 的 CameraRig
// 驗證俯仰上下限、仰角 80° 時鏡頭離地、仰視不穿牆 / 不穿天花板、預設視角與舊版一致、轉動換算
// 用法：node tools/test/camera.mjs（任一斷言失敗 exit 1）
import * as THREE from 'three';

const { CameraRig, PITCH_MIN, PITCH_MAX } = await import('../../src/camera.js');
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

// 9. 未仰視時（預設 pitch 0.32、平地無遮擋）與原公式一致：目標 = 腳底 + 1.5、距離 7
const def = run({ terrain: flat, occ: noOcc, yaw: 0.7 });
const cp = Math.cos(0.32);
const exp = new THREE.Vector3(-Math.sin(0.7) * cp * 7, 1.5 + Math.sin(0.32) * 7, -Math.cos(0.7) * cp * 7);
check('預設視角位置不變', def.cam.position.distanceTo(exp) < 1e-6 && def.rig._target.y === 1.5, `誤差=${def.cam.position.distanceTo(exp).toExponential(1)}`);

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

console.log(`\n可達最大仰角 ${up.elev.toFixed(1)}°（pitch 下限 ${(-PITCH_MIN * DEG).toFixed(0)}°）、最大俯角 ${(-down.elev).toFixed(1)}°（pitch 上限 ${(PITCH_MAX * DEG).toFixed(0)}°）`);
console.log(`通過 ${pass} / ${total}`);
process.exit(pass === total ? 0 : 1);
