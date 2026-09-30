// 路口號誌（C1）：在 citymodel 的車流路口建立兩軸號誌、時相推進與查詢，並建立燈桿 / 燈頭 / 行人燈 / 停止線 / 倒數秒數的網格
// - 號誌路口：junctions 中連接 ≥ 2 條車流等級道路（TRAFFIC_TYPES）且車流路段腳數 ≥ 3 者
// - 分軸：各路段腳依方位配對（夾角最接近 180° 者成一軸），第一對 = A 軸、第二對 = B 軸，剩下的腳歸最近的軸（方向以 π 為週期比較）
// - 時相：A 綠 → A 黃 3 s → 全紅 1.5 s → B 綠 → B 黃 3 s → 全紅 1.5 s；綠燈秒數依路口最高道路等級（primary 30 / secondary 24 / tertiary 18），
//   每路口以位置 + seed 雜湊出固定偏移（可重現）
// - 行人燈：行走方向與某軸平行的行人穿越，在該軸綠燈時可走，綠燈剩 ≤ PED_FLASH 秒閃爍，其餘禁止
// - 方位（bearing）一律用 yaw 慣例：atan2(dx, dz)（x 向東、z 向南），與 traffic.js / vehicle.js 相同
// - 視覺：全部路口共用 4 個 InstancedMesh（燈桿 / 燈殼 / 燈泡 / 停止線）＋ 最多 COUNTDOWN_POOL 個倒數 Sprite；
//   燈泡用 instanceColor 切換亮暗（emissive 也乘上 instanceColor，夜間明顯），只在時相 / 閃爍狀態改變時寫入
// 純邏輯部分（號誌建立、時相、查詢）不依賴 three 場景，可在 node 無頭測試
//
// 接線說明（給 traffic.js / main.js）：
// 1. 建立：main.js `const lights = createTrafficLights()`；`lights.buildMeshes(scene, { heightAt })`；以 `new Traffic(scene, { ..., lights })` 注入
// 2. 每幀：`lights.update(dt)`（與遊戲時間同步，暫停時不呼叫）、`lights.updateVisuals(camX, camZ)`（鏡頭焦點）
// 3. 車（traffic.js _driveCar，在前車 check 迴圈之後、算 accel 之前）：
//    const ns = this.lights && this.lights.nextStop(car.road, car.dir, car.s, 80);
//    if (ns && !this.lights.carMayProceed(ns.stop.signal, v.pos.x, v.pos.z, ns.distToStop - v.spec.length / 2, car.speed)) {
//      target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, ns.distToStop - v.spec.length / 2 - 0.5)));
//    }
//    - 距離用沿路距離 ns.distToStop（停止線 = 路口中心往回 stopDistance(signal)）扣半車長 = 車頭到停止線
//    - 與跟車合併：兩者都只壓低 target，取 min；前車停在停止線前時跟車邏輯自然排隊
//    - distToStop < 0（車頭已過停止線）carMayProceed 回 true，車會清空路口；黃燈的煞不住判斷每幀重算，結果單調不會反覆
//    - wrecked / 玩家車不需處理；_advanceNode 換路後 nextStop 以新 road 重新查即可（路口節點同時在兩條路的停止點表內）
// 4. 行人（traffic.js _walkPed / 大腦 wander）：下一步位置 signalAt(nx, nz) 非 null 且目前位置不在該路口內 → 即將穿越；
//    bearing = Math.atan2(移動 dx, dz)；const w = lights.pedWalk(sig, bearing)；!w.walk 或（w.flashing 且 w.remaining < 穿越距離 / 步速）→ 原地等（速度 0、idle），
//    已在斑馬線上（signalAt 已命中）則不管燈號走完。react（逃跑 / 還手）狀態不看燈
import * as THREE from 'three';
import { junctions, TRAFFIC_TYPES, heightAt as cityHeightAt } from './citymodel.js';
import { samplePolyline, SpatialGrid } from './geom.js';
import { CITY_SEED } from './data/city.js';
import { mulberry32, angleDelta, makeCanvas, FONT_STACK } from './utils.js';

export const GREEN_BY_TYPE = { primary: 30, secondary: 24, tertiary: 18 };
const TYPE_RANK = { tertiary: 1, secondary: 2, primary: 3 };
export const YELLOW_TIME = 3;
export const ALL_RED_TIME = 1.5;
export const PED_FLASH = 5; // 行人綠燈剩此秒數以下閃爍
export const YELLOW_DECEL = 4.5; // 黃燈判斷「煞得住」的減速度（m/s²）
export const STOP_LINE_GAP = 1.5; // 停止線在路口半徑外的距離（m）
const SIGNAL_PAD = 2; // signalAt 判定半徑 = 路口半徑 + 此值
const PAIR_MAX_DEV = 0.7; // 配成一軸的兩腳與 180° 的最大偏差（rad，約 40°）
const AXIS_MIN_SEP = 0.8; // 新軸與既有軸至少相差（rad，約 46°，以 π 為週期），否則併入最近軸
const LEG_SAMPLE = 8; // 腳方位取樣：沿路離路口此距離的點（m）
const COUNTDOWN_RADIUS = 120; // 倒數秒數只顯示在此半徑內（m）
const COUNTDOWN_POOL = 24; // 倒數 Sprite 物件池上限
const PED_BLINK_HZ = 2; // 行人綠燈閃爍頻率

// 燈色（亮 / 暗）
const LAMP_ON = { red: new THREE.Color('#ff2a1a'), yellow: new THREE.Color('#ffb000'), green: new THREE.Color('#1ee070') };
const LAMP_DIM = {};
for (const k of Object.keys(LAMP_ON)) LAMP_DIM[k] = LAMP_ON[k].clone().multiplyScalar(0.08);
const COUNT_COLOR = { red: '#ff4a3a', yellow: '#ffc030', green: '#40f090' };

// 尺寸（m）
const POLE_H = 4.2; // 車用燈桿高
const PED_POLE_H = 2.9; // 行人燈桿高
const HEAD_W = 0.42;
const HEAD_H = 1.2;
const HEAD_D = 0.3;
const LAMP_SIZE = 0.28;
const PED_HEAD_W = 0.36;
const PED_HEAD_H = 0.72;
const PED_LAMP_W = 0.24;
const PED_LAMP_H = 0.28;
const POLE_CURB = 0.8; // 燈桿在路緣外的距離
const STOP_LINE_W = 0.4;

// 以 π 為週期的方向差（0 ~ π/2）：軸不分正反
function axisDiff(a, b) {
  const d = Math.abs(angleDelta(a, b)) % Math.PI;
  return d > Math.PI / 2 ? Math.PI - d : d;
}

// 位置 + seed 的整數雜湊
function hashPos(x, z, seed) {
  let h = (Math.round(x * 10) * 73856093) ^ (Math.round(z * 10) * 19349663) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

// 路口的車流路段腳：[{ road, idx, outDir, bearing, ux, uz, inbound }]
// outDir：沿 road 離開路口的方向（+1 = 往 idx 增加）；inbound：此腳有駛入路口的車流（單行道只出不進者為 false）
function junctionLegs(j) {
  const legs = [];
  const tmp = {};
  for (const road of j.roads) {
    if (!TRAFFIC_TYPES.has(road.type)) continue;
    const last = road.pts.length - 1;
    road.pts.forEach((p, idx) => {
      if (Math.abs(p.x - j.x) > 0.05 || Math.abs(p.z - j.z) > 0.05) return;
      const s0 = road.cum[idx];
      for (const outDir of [1, -1]) {
        if ((outDir > 0 && idx >= last) || (outDir < 0 && idx <= 0)) continue;
        const avail = outDir > 0 ? road.length - s0 : s0;
        samplePolyline(road, s0 + outDir * Math.min(LEG_SAMPLE, avail), tmp);
        let dx = tmp.x - j.x;
        let dz = tmp.z - j.z;
        const L = Math.hypot(dx, dz);
        if (L < 1e-6) continue;
        dx /= L;
        dz /= L;
        // 駛入車流方向 = -outDir：outDir +1 的腳要允許 dir -1（oneway !== 1），反之亦然
        const inbound = outDir > 0 ? road.oneway !== 1 : road.oneway !== -1;
        legs.push({ road, idx, outDir, s: s0, bearing: Math.atan2(dx, dz), ux: dx, uz: dz, inbound, axis: 0, hw: road.hw });
      }
    });
  }
  return legs;
}

// 把腳分成兩軸；回傳軸方向陣列 [A, B?]（rad），並寫入 leg.axis
function assignAxes(legs) {
  const pairs = [];
  for (let i = 0; i < legs.length; i++) {
    for (let k = i + 1; k < legs.length; k++) {
      const dev = Math.PI - Math.abs(angleDelta(legs[i].bearing, legs[k].bearing));
      if (dev < PAIR_MAX_DEV) pairs.push({ i, k, dev });
    }
  }
  pairs.sort((a, b) => a.dev - b.dev);
  const axes = [];
  const used = new Set();
  for (const p of pairs) {
    if (axes.length >= 2) break;
    if (used.has(p.i) || used.has(p.k)) continue;
    const dir = legs[p.i].bearing;
    if (axes.length === 1 && axisDiff(axes[0], dir) < AXIS_MIN_SEP) continue;
    used.add(p.i);
    used.add(p.k);
    legs[p.i].axis = axes.length;
    legs[p.k].axis = axes.length;
    axes.push(dir);
  }
  // 沒有任何對：第一條腳當 A 軸
  if (!axes.length) {
    axes.push(legs[0].bearing);
    legs[0].axis = 0;
    used.add(0);
  }
  legs.forEach((leg, i) => {
    if (used.has(i)) return;
    if (axes.length < 2 && axisDiff(axes[0], leg.bearing) >= AXIS_MIN_SEP) {
      leg.axis = 1;
      axes.push(leg.bearing);
      return;
    }
    let best = 0;
    for (let a = 1; a < axes.length; a++) if (axisDiff(axes[a], leg.bearing) < axisDiff(axes[best], leg.bearing)) best = a;
    leg.axis = best;
  });
  return axes;
}

// 建立號誌資料（不含網格）
function buildSignals(seed) {
  const signals = [];
  for (const j of junctions) {
    const troads = j.roads.filter((r) => TRAFFIC_TYPES.has(r.type));
    if (troads.length < 2) continue;
    const legs = junctionLegs(j);
    if (legs.length < 3) continue;
    const axes = assignAxes(legs);
    let top = 'tertiary';
    for (const r of troads) if ((TYPE_RANK[r.type] || 0) > TYPE_RANK[top]) top = r.type;
    const green = GREEN_BY_TYPE[top];
    const cycle = 2 * (green + YELLOW_TIME + ALL_RED_TIME);
    const offset = mulberry32(hashPos(j.x, j.z, seed))() * cycle;
    signals.push({
      id: signals.length,
      x: j.x,
      z: j.z,
      radius: j.radius,
      stopDist: j.radius + STOP_LINE_GAP,
      type: top,
      green,
      cycle,
      offset,
      legs,
      axes,
      phase: -1, // 目前時相索引 0–5（update 時寫入）
      pedBlink: false,
      heads: [], // buildMeshes 後：車用燈頭 { leg, lamp0 }
      pedHeads: [], // 行人燈 { bearing, lamp0 }
    });
  }
  return signals;
}

// 時相：local = (t + offset) mod cycle；回傳該軸 { color, remaining }（remaining：目前燈色還剩幾秒）
function axisState(sig, axis, t, out = {}) {
  const G = sig.green;
  const local = (((t + sig.offset) % sig.cycle) + sig.cycle) % sig.cycle;
  const start = axis === 0 ? 0 : G + YELLOW_TIME + ALL_RED_TIME; // 此軸綠燈起點
  const rel = (local - start + sig.cycle) % sig.cycle;
  if (rel < G) {
    out.color = 'green';
    out.remaining = G - rel;
  } else if (rel < G + YELLOW_TIME) {
    out.color = 'yellow';
    out.remaining = G + YELLOW_TIME - rel;
  } else {
    out.color = 'red';
    out.remaining = sig.cycle - rel;
  }
  return out;
}

function phaseIndex(sig, t) {
  const G = sig.green;
  const local = (((t + sig.offset) % sig.cycle) + sig.cycle) % sig.cycle;
  const bounds = [G, G + YELLOW_TIME, G + YELLOW_TIME + ALL_RED_TIME, 2 * G + YELLOW_TIME + ALL_RED_TIME, 2 * G + 2 * YELLOW_TIME + ALL_RED_TIME];
  for (let i = 0; i < bounds.length; i++) if (local < bounds[i]) return i;
  return 5;
}

// 來車所在方位最近的腳
function nearestLeg(sig, fromX, fromZ) {
  const b = Math.atan2(fromX - sig.x, fromZ - sig.z);
  let best = sig.legs[0];
  let bestD = Infinity;
  for (const leg of sig.legs) {
    const d = Math.abs(angleDelta(leg.bearing, b));
    if (d < bestD) {
      bestD = d;
      best = leg;
    }
  }
  return best;
}

function nearestAxis(sig, bearing) {
  let best = 0;
  for (let a = 1; a < sig.axes.length; a++) if (axisDiff(sig.axes[a], bearing) < axisDiff(sig.axes[best], bearing)) best = a;
  return best;
}

// 燈泡材質：emissive 乘上 instanceColor（亮燈自發光、暗燈幾乎不發光；夜間仍明顯）
function makeLampMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.35, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n\ttotalEmissiveRadiance *= vColor.rgb;\n#endif',
    );
  };
  m.customProgramCacheKey = () => 'tcgta-signal-lamp';
  return m;
}

export function createTrafficLights({ seed = CITY_SEED } = {}) {
  const signals = buildSignals(seed);
  const grid = new SpatialGrid(40);
  for (const s of signals) {
    const r = s.radius + SIGNAL_PAD;
    grid.insert(s, s.x - r, s.z - r, s.x + r, s.z + r);
  }
  // 每條道路上的停止點（給 traffic.js 沿路前瞻）：road → [{ signal, leg, dir（駛入的行進方向）, nodeS, stopS }]
  const stopsByRoad = new Map();
  for (const sig of signals) {
    for (const leg of sig.legs) {
      if (!leg.inbound) continue;
      const stopS = Math.max(0, Math.min(leg.road.length, leg.s + leg.outDir * sig.stopDist));
      let list = stopsByRoad.get(leg.road);
      if (!list) {
        list = [];
        stopsByRoad.set(leg.road, list);
      }
      list.push({ signal: sig, leg, dir: -leg.outDir, nodeS: leg.s, stopS });
    }
  }
  for (const list of stopsByRoad.values()) list.sort((a, b) => a.nodeS - b.nodeS);

  let time = 0;
  const _q = [];
  const _st = {};
  const vis = { built: false, lampMesh: null, group: null, sprites: [], dirty: new Set() };

  function signalAt(x, z) {
    const list = grid.query(x - SIGNAL_PAD, z - SIGNAL_PAD, x + SIGNAL_PAD, z + SIGNAL_PAD, _q);
    let best = null;
    let bestD = Infinity;
    for (const s of list) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d <= s.radius + SIGNAL_PAD && d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  function approachState(signal, fromX, fromZ) {
    const leg = nearestLeg(signal, fromX, fromZ);
    const st = axisState(signal, leg.axis, time, {});
    return { color: st.color, remaining: st.remaining };
  }

  function carMayProceed(signal, fromX, fromZ, distToStop, speed) {
    if (distToStop < 0) return true; // 已越過停止線（在路口內）：清空路口
    const st = axisState(signal, nearestLeg(signal, fromX, fromZ).axis, time, _st);
    if (st.color === 'green') return true;
    if (st.color === 'red') return false;
    // 黃燈：以 YELLOW_DECEL 煞不住（煞車距離 > 到停止線距離）就通過
    return (speed * speed) / (2 * YELLOW_DECEL) > distToStop;
  }

  function stopDistance(signal) {
    return signal.stopDist;
  }

  // bearing：行人行走方向（yaw 慣例）；與哪一軸平行就看該軸綠燈
  function pedWalk(signal, bearing) {
    const axis = nearestAxis(signal, bearing);
    const st = axisState(signal, axis, time, _st);
    if (st.color === 'green') return { walk: true, flashing: st.remaining <= PED_FLASH, remaining: st.remaining };
    // 禁止：remaining = 距該軸下次綠燈的秒數
    const G = signal.green;
    const toGreen = st.color === 'yellow' ? st.remaining + (signal.cycle - G - YELLOW_TIME) : st.remaining;
    return { walk: false, flashing: false, remaining: toGreen };
  }

  // 行人燈閃爍中的亮暗（以時間 2 Hz 切換）
  function pedLit(signal, bearing) {
    const w = pedWalk(signal, bearing);
    if (!w.walk) return { walk: false, on: true };
    if (!w.flashing) return { walk: true, on: true };
    return { walk: true, on: Math.floor(w.remaining * PED_BLINK_HZ) % 2 === 0 };
  }

  function update(dt) {
    time += dt;
    for (const s of signals) {
      const ph = phaseIndex(s, time);
      let blink = false;
      if (s.pedHeads.length && (ph === 0 || ph === 3)) for (const h of s.pedHeads) if (!pedLit(s, h.bearing).on) blink = true;
      if (ph !== s.phase || blink !== s.pedBlink) {
        s.phase = ph;
        s.pedBlink = blink;
        if (vis.built) vis.dirty.add(s);
      }
    }
    if (vis.built && vis.dirty.size) {
      for (const s of vis.dirty) writeLamps(s);
      vis.dirty.clear();
      vis.lampMesh.instanceColor.needsUpdate = true;
    }
  }

  // ---------- 視覺 ----------
  function writeLamps(s) {
    const mesh = vis.lampMesh;
    for (const h of s.heads) {
      const c = axisState(s, h.leg.axis, time, _st).color;
      mesh.setColorAt(h.lamp0, c === 'red' ? LAMP_ON.red : LAMP_DIM.red);
      mesh.setColorAt(h.lamp0 + 1, c === 'yellow' ? LAMP_ON.yellow : LAMP_DIM.yellow);
      mesh.setColorAt(h.lamp0 + 2, c === 'green' ? LAMP_ON.green : LAMP_DIM.green);
    }
    for (const p of s.pedHeads) {
      const { walk, on } = pedLit(s, p.bearing);
      mesh.setColorAt(p.lamp0, !walk ? LAMP_ON.red : LAMP_DIM.red);
      mesh.setColorAt(p.lamp0 + 1, walk && on ? LAMP_ON.green : LAMP_DIM.green);
    }
  }

  function buildMeshes(scene, { heightAt = cityHeightAt } = {}) {
    // 先收集每個實例的變換，再一次建 InstancedMesh
    const poles = [];
    const housings = [];
    const lamps = [];
    const lines = [];
    const put = (arr, x, y, z, yaw, sx, sy, sz) => arr.push({ x, y, z, yaw, sx, sy, sz });
    for (const s of signals) {
      s.heads.length = 0;
      s.pedHeads.length = 0;
      for (const leg of s.legs) {
        const { ux, uz, hw } = leg;
        const yaw = leg.bearing; // 燈面（本地 +z）朝向來車（沿腳往外）
        const rx = uz; // 駛入車流（行進方向 -u）的右側 = (uz, -ux)
        const rz = -ux;
        const d = s.stopDist;
        if (leg.inbound) {
          // 右側路角立桿，燈頭朝來車
          const px = s.x + ux * d + rx * (hw + POLE_CURB);
          const pz = s.z + uz * d + rz * (hw + POLE_CURB);
          const gy = heightAt(px, pz);
          put(poles, px, gy + POLE_H / 2, pz, 0, 1, POLE_H, 1);
          const hy = gy + POLE_H - HEAD_H / 2;
          const hx = px + ux * 0.2;
          const hz = pz + uz * 0.2;
          put(housings, hx, hy, hz, yaw, HEAD_W, HEAD_H, HEAD_D);
          const lamp0 = lamps.length;
          const fx = hx + ux * (HEAD_D / 2 + 0.01);
          const fz = hz + uz * (HEAD_D / 2 + 0.01);
          for (let k = 0; k < 3; k++) put(lamps, fx, hy + (1 - k) * 0.36, fz, yaw, LAMP_SIZE, LAMP_SIZE, 0.04); // 紅 / 黃 / 綠由上而下
          s.heads.push({ leg, lamp0, x: fx, y: hy - HEAD_H / 2 - 0.35, z: fz });
          // 停止線：駛入車道半幅（單行道全幅），貼路面
          const two = leg.road.oneway === 0;
          const off = two ? hw / 2 : 0;
          const len = two ? hw : hw * 2;
          const lx = s.x + ux * d + rx * off;
          const lz = s.z + uz * d + rz * off;
          put(lines, lx, heightAt(lx, lz) + 0.03, lz, yaw, len, 0.02, STOP_LINE_W);
        }
        // 行人燈：斑馬線位置（路口半徑外 0.75 m）兩側路緣，面向對側；行走方向 = 跨越此腳的方向
        const cd = s.radius + STOP_LINE_GAP / 2;
        for (const side of [1, -1]) {
          const px = s.x + ux * cd + rx * side * (hw + POLE_CURB);
          const pz = s.z + uz * cd + rz * side * (hw + POLE_CURB);
          const gy = heightAt(px, pz);
          put(poles, px, gy + PED_POLE_H / 2, pz, 0, 0.8, PED_POLE_H, 0.8);
          const face = Math.atan2(-rx * side, -rz * side); // 朝對側
          const hy = gy + PED_POLE_H - PED_HEAD_H / 2;
          const hx = px - rx * side * 0.15;
          const hz = pz - rz * side * 0.15;
          put(housings, hx, hy, hz, face, PED_HEAD_W, PED_HEAD_H, 0.22);
          const lamp0 = lamps.length;
          const fx = hx - rx * side * 0.12;
          const fz = hz - rz * side * 0.12;
          put(lamps, fx, hy + 0.17, fz, face, PED_LAMP_W, PED_LAMP_H, 0.04); // 小紅人（上）
          put(lamps, fx, hy - 0.17, fz, face, PED_LAMP_W, PED_LAMP_H, 0.04); // 小綠人（下）
          s.pedHeads.push({ bearing: face, lamp0 });
        }
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const cyl = new THREE.CylinderGeometry(0.07, 0.09, 1, 8);
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.6, metalness: 0.4 });
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const lampMat = makeLampMaterial();
    const m4 = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const make = (geo, mat, list, name, shadow) => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      mesh.name = name;
      mesh.count = list.length;
      list.forEach((it, i) => {
        qt.setFromAxisAngle(up, it.yaw);
        m4.compose(pos.set(it.x, it.y, it.z), qt, scl.set(it.sx, it.sy, it.sz));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = shadow;
      mesh.receiveShadow = false;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = false; // 實例散布全城，包圍球很大，交給 GPU
      return mesh;
    };
    const group = new THREE.Group();
    group.name = 'traffic-lights';
    group.add(make(cyl, darkMat, poles, 'signal-poles', true));
    group.add(make(box, darkMat, housings, 'signal-housings', true));
    const lampMesh = make(box, lampMat, lamps, 'signal-lamps', false);
    for (let i = 0; i < lamps.length; i++) lampMesh.setColorAt(i, LAMP_DIM.red);
    group.add(lampMesh);
    group.add(make(box, lineMat, lines, 'signal-stoplines', false));

    // 倒數秒數 Sprite 物件池
    const sprites = [];
    for (let i = 0; i < COUNTDOWN_POOL; i++) {
      const canvas = makeCanvas(64, 32);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      sp.scale.set(0.7, 0.35, 1);
      sp.visible = false;
      sp.name = 'signal-countdown';
      group.add(sp);
      sprites.push({ sprite: sp, canvas, ctx: canvas.getContext('2d'), tex, head: null, sig: null, key: '' });
    }

    vis.lampMesh = lampMesh;
    vis.group = group;
    vis.sprites = sprites;
    vis.built = true;
    vis.counts = { poles: poles.length, housings: housings.length, lamps: lamps.length, stopLines: lines.length };
    for (const s of signals) {
      s.phase = phaseIndex(s, time);
      s.pedBlink = s.pedHeads.some((h) => !pedLit(s, h.bearing).on);
      writeLamps(s);
    }
    lampMesh.instanceColor.needsUpdate = true;
    if (scene) scene.add(group);
    return group;
  }

  function drawCount(slot, color, sec) {
    const { ctx, canvas } = slot;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(10, 10, 12, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `bold 26px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COUNT_COLOR[color];
    ctx.fillText(String(sec), canvas.width / 2, canvas.height / 2 + 1);
    slot.tex.needsUpdate = true;
    vis.redraws = (vis.redraws || 0) + 1;
  }

  // 每幀：鏡頭（或玩家）附近 COUNTDOWN_RADIUS 內最近的燈頭掛上倒數秒數
  const _near = [];
  function updateVisuals(camX, camZ) {
    if (!vis.built) return;
    const R = COUNTDOWN_RADIUS;
    const list = grid.query(camX - R, camZ - R, camX + R, camZ + R, _q);
    _near.length = 0;
    for (const s of list) {
      for (const h of s.heads) {
        const d2 = (h.x - camX) ** 2 + (h.z - camZ) ** 2;
        if (d2 <= R * R) _near.push({ s, h, d2 });
      }
    }
    _near.sort((a, b) => a.d2 - b.d2);
    if (_near.length > COUNTDOWN_POOL) _near.length = COUNTDOWN_POOL;
    const want = new Set(_near.map((n) => n.h));
    const free = [];
    for (const slot of vis.sprites) {
      if (slot.head && want.has(slot.head)) want.delete(slot.head);
      else {
        slot.head = null;
        slot.sprite.visible = false;
        free.push(slot);
      }
    }
    for (const n of _near) {
      if (!want.has(n.h)) continue;
      const slot = free.pop();
      slot.head = n.h;
      slot.sig = n.s;
      slot.key = '';
      slot.sprite.position.set(n.h.x, n.h.y, n.h.z);
      slot.sprite.visible = true;
    }
    for (const slot of vis.sprites) {
      if (!slot.head) continue;
      const st = axisState(slot.sig, slot.head.leg.axis, time, _st);
      const sec = Math.max(0, Math.ceil(st.remaining - 1e-6));
      const key = st.color + sec;
      if (key !== slot.key) {
        slot.key = key;
        drawCount(slot, st.color, sec);
      }
    }
  }

  function stats() {
    let heads = 0;
    let pedHeads = 0;
    for (const s of signals) {
      heads += s.heads.length || s.legs.filter((l) => l.inbound).length;
      pedHeads += s.pedHeads.length;
    }
    const out = { signals: signals.length, heads, pedHeads };
    if (vis.built) {
      let meshes = 0;
      let sprites = 0;
      vis.group.traverse((o) => {
        if (o.isMesh) meshes++;
        if (o.isSprite) sprites++;
      });
      Object.assign(out, vis.counts, { meshes, sprites, spritesVisible: vis.sprites.filter((x) => x.sprite.visible).length, redraws: vis.redraws || 0 });
    }
    return out;
  }

  // 沿路前瞻用：此道路上的停止點（依 nodeS 排序）；traffic.js 以 car.road / car.dir / car.s 找下一個停止線
  function roadStops(road) {
    return stopsByRoad.get(road) || [];
  }

  // 行進方向 dir、位於 s 的車在此道路上前方最近的號誌路口（尚未駛過路口中心）；回傳 { stop, distToStop } 或 null
  // distToStop < 0 表示已越過停止線、還沒過路口中心（carMayProceed 會放行）
  function nextStop(road, dir, s, maxAhead = 80) {
    const list = stopsByRoad.get(road);
    if (!list) return null;
    let best = null;
    let bestNode = Infinity;
    for (const st of list) {
      if (st.dir !== dir) continue;
      const toNode = dir * (st.nodeS - s);
      if (toNode < 0 || toNode > maxAhead + st.signal.stopDist || toNode >= bestNode) continue;
      best = st;
      bestNode = toNode;
    }
    return best ? { stop: best, distToStop: dir * (best.stopS - s) } : null;
  }

  return {
    signals,
    get time() {
      return time;
    },
    update,
    signalAt,
    approachState,
    carMayProceed,
    stopDistance,
    pedWalk,
    buildMeshes,
    updateVisuals,
    stats,
    roadStops,
    nextStop,
  };
}
