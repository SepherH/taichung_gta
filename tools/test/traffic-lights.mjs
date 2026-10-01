#!/usr/bin/env node
// C1 路口號誌無頭驗證（純邏輯 + 網格建立；不需 Rapier / 瀏覽器）
// 用法：node tools/test/traffic-lights.mjs（任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n）
// 項目：號誌數 > 0、每路口兩軸；模擬 600 s（dt 0.1）同一路口不會兩軸同時綠 / 黃、黃燈 3 s、週期長度、綠燈秒數依等級；
//   carMayProceed 綠 / 黃（煞得住 / 煞不住）/ 紅；pedWalk 只在平行軸綠燈、閃爍 ≤ 5 s；stopDistance > 路口半徑；
//   signalAt 範圍；同 seed 可重現；buildMeshes 在 node 可建立（canvas 替身）並回報物件數；倒數物件池上限與只在整數秒變化時重畫
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

// 倒數秒數貼圖用 2D canvas：最小替身
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const { createTrafficLights, YELLOW_TIME, ALL_RED_TIME, GREEN_BY_TYPE, PED_FLASH } = await import('../../src/traffic-lights.js');
const { heightAt, junctions, TRAFFIC_TYPES } = await import('../../src/citymodel.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const tl = createTrafficLights();
const S = tl.signals;
check('號誌路口數 > 0', S.length > 0, `${S.length} 個（路口總數 ${junctions.length}）`);
check('每個號誌路口都連接 ≥ 2 條車流道路且 ≥ 3 條腳', S.every((s) => s.legs.length >= 3 && new Set(s.legs.map((l) => l.road).filter((r) => TRAFFIC_TYPES.has(r.type))).size >= 2));
const twoAxis = S.filter((s) => s.axes.length === 2).length;
check('分軸：每個路口有 A 軸、每條腳都歸到存在的軸', S.every((s) => s.axes.length >= 1 && s.legs.every((l) => l.axis < s.axes.length)), `兩軸路口 ${twoAxis}/${S.length}`);
check('綠燈秒數依最高道路等級', S.every((s) => s.green === GREEN_BY_TYPE[s.type]), Object.entries(GREEN_BY_TYPE).map(([k]) => `${k} ${S.filter((s) => s.type === k).length}`).join('、'));
check('週期長度 = 2 × (綠 + 黃 3 + 全紅 1.5)', S.every((s) => Math.abs(s.cycle - 2 * (s.green + YELLOW_TIME + ALL_RED_TIME)) < 1e-9));
check('stopDistance > 路口半徑', S.every((s) => tl.stopDistance(s) > s.radius && Math.abs(tl.stopDistance(s) - s.radius - 1.5) < 1e-9));

// 每條軸的代表來車位置（該軸第一條腳往外 20 m）
function axisProbe(s, axis) {
  const leg = s.legs.find((l) => l.axis === axis);
  return leg ? { x: s.x + leg.ux * 20, z: s.z + leg.uz * 20, leg } : null;
}

// ---------- 模擬 600 s ----------
const DT = 0.1;
let conflicts = 0;
const yellowRuns = [];
const greenRuns = [];
const cycleObs = new Map(); // signal → A 軸綠燈起點時間
const cycleErr = [];
const run = S.map(() => [{ c: null, len: 0 }, { c: null, len: 0 }]);
for (let step = 0; step < 6000; step++) {
  tl.update(DT);
  S.forEach((s, si) => {
    const cols = [];
    for (let a = 0; a < 2; a++) {
      const p = axisProbe(s, a);
      if (!p) continue;
      const st = tl.approachState(s, p.x, p.z);
      cols.push(st.color);
      const r = run[si][a];
      if (st.color === r.c) r.len++;
      else {
        if (r.c === 'yellow' && r.started) yellowRuns.push(r.len * DT);
        if (r.c === 'green' && r.started) greenRuns.push({ len: r.len * DT, want: s.green });
        if (st.color === 'green' && a === 0 && r.c !== null) {
          const prev = cycleObs.get(s);
          if (prev !== undefined) cycleErr.push(Math.abs(tl.time - prev - s.cycle));
          cycleObs.set(s, tl.time);
        }
        r.started = r.c !== null;
        r.c = st.color;
        r.len = 1;
      }
    }
    if (cols.length === 2 && cols[0] !== 'red' && cols[1] !== 'red') conflicts++;
  });
}
check('600 s 內同一路口兩軸不會同時綠或黃', conflicts === 0, `衝突 ${conflicts} 次（${S.length} 路口 × 6000 步）`);
const yBad = yellowRuns.filter((y) => Math.abs(y - YELLOW_TIME) > DT + 1e-6);
check('黃燈持續 3 s（±1 步）', yellowRuns.length > 0 && yBad.length === 0, `量到 ${yellowRuns.length} 次，偏差 ${yBad.length}`);
const gBad = greenRuns.filter((g) => Math.abs(g.len - g.want) > DT + 1e-6);
check('綠燈持續時間 = 等級綠燈秒數（±1 步）', greenRuns.length > 0 && gBad.length === 0, `量到 ${greenRuns.length} 次，偏差 ${gBad.length}`);
check('週期長度實測（A 軸兩次綠燈起點間隔）', cycleErr.length > 0 && Math.max(...cycleErr) <= DT + 1e-6, `量到 ${cycleErr.length} 次，最大誤差 ${Math.max(...cycleErr).toFixed(3)} s`);

// 全紅：A 黃結束到 B 綠開始間隔 1.5 s（取一個兩軸路口，細步長掃描一個週期）
{
  const s = S.find((x) => x.axes.length === 2);
  const t2 = createTrafficLights();
  const s2 = t2.signals[s.id];
  const pa = axisProbe(s2, 0);
  const pb = axisProbe(s2, 1);
  let allRed = 0;
  const step = 0.01;
  for (let t = 0; t < s2.cycle; t += step) {
    t2.update(step);
    if (t2.approachState(s2, pa.x, pa.z).color === 'red' && t2.approachState(s2, pb.x, pb.z).color === 'red') allRed += step;
  }
  check('每週期全紅合計 3 s（1.5 s × 2）', Math.abs(allRed - 2 * ALL_RED_TIME) < 0.05, `${allRed.toFixed(2)} s`);
}

// 可重現：同 seed 偏移相同、不同 seed 至少部分不同
{
  const a = createTrafficLights();
  const b = createTrafficLights({ seed: 12345 });
  check('同 seed 偏移可重現', a.signals.every((s, i) => s.offset === S[i].offset));
  check('不同 seed 偏移不同', b.signals.some((s, i) => s.offset !== S[i].offset));
  check('路口間偏移錯開', new Set(S.map((s) => s.offset.toFixed(3))).size > S.length * 0.8);
}

// ---------- carMayProceed ----------
// 用新實例控制時間：找到指定燈色的時刻
function atColor(inst, s, axis, color, minRemaining = 0) {
  const p = axisProbe(s, axis);
  for (let i = 0; i < 2000; i++) {
    const st = inst.approachState(s, p.x, p.z);
    if (st.color === color && st.remaining > minRemaining) return { p, st };
    inst.update(0.05);
  }
  return null;
}
{
  const inst = createTrafficLights();
  const s = inst.signals.find((x) => x.axes.length === 2);
  let g = atColor(inst, s, 0, 'green', 1);
  check('綠燈：可通行', g && inst.carMayProceed(s, g.p.x, g.p.z, 20, 10) === true && inst.carMayProceed(s, g.p.x, g.p.z, 2, 0) === true);
  const y = atColor(inst, s, 0, 'yellow', 1);
  // 10 m/s 煞車距離 = 100 / 9 ≈ 11.1 m
  const stopAble = inst.carMayProceed(s, y.p.x, y.p.z, 20, 10);
  const cannot = inst.carMayProceed(s, y.p.x, y.p.z, 5, 10);
  check('黃燈：煞得住（20 m、10 m/s）→ 停', stopAble === false);
  check('黃燈：煞不住（5 m、10 m/s）→ 行', cannot === true);
  const r = atColor(inst, s, 0, 'red', 1);
  check('紅燈：停（含慢速貼近停止線）', inst.carMayProceed(s, r.p.x, r.p.z, 20, 10) === false && inst.carMayProceed(s, r.p.x, r.p.z, 0.5, 13) === false);
  check('紅燈：已越過停止線（distToStop < 0）→ 清空路口', inst.carMayProceed(s, r.p.x, r.p.z, -1, 5) === true);
  // 對向同軸同色、另一軸相反
  const leg0 = s.legs.find((l) => l.axis === 0);
  const opp = s.legs.find((l) => l.axis === 0 && l !== leg0);
  g = atColor(inst, s, 0, 'green', 1);
  const b = axisProbe(s, 1);
  check('同軸兩端同色、另一軸紅', opp && inst.approachState(s, s.x + opp.ux * 15, s.z + opp.uz * 15).color === 'green' && inst.approachState(s, b.x, b.z).color === 'red');
}

// ---------- pedWalk ----------
{
  const inst = createTrafficLights();
  const s = inst.signals.find((x) => x.axes.length === 2);
  const A = s.axes[0];
  const B = s.axes[1];
  let bad = 0;
  let flashOk = true;
  let flashSeen = 0;
  let walkSeen = 0;
  const pa = axisProbe(s, 0);
  const pb = axisProbe(s, 1);
  for (let i = 0; i < s.cycle * 20 * 2; i++) {
    inst.update(0.05);
    const ca = inst.approachState(s, pa.x, pa.z);
    const cb = inst.approachState(s, pb.x, pb.z);
    for (const [bear, st] of [[A, ca], [A + Math.PI, ca], [B, cb], [B + Math.PI, cb]]) {
      const w = inst.pedWalk(s, bear);
      if (w.walk !== (st.color === 'green')) bad++;
      if (w.walk) walkSeen++;
      if (w.flashing) flashSeen++;
      if (w.flashing !== (w.walk && st.remaining <= PED_FLASH)) flashOk = false;
      if (!w.walk && !(w.remaining > 0)) flashOk = false;
    }
  }
  check('pedWalk 只在平行軸綠燈時可走（兩軸 × 正反向）', bad === 0 && walkSeen > 0, `不符 ${bad} 次`);
  check('pedWalk 綠燈剩 ≤ 5 s 閃爍、禁止時 remaining > 0', flashOk && flashSeen > 0, `閃爍取樣 ${flashSeen}`);
}

// ---------- signalAt ----------
{
  const s = S[0];
  const inR = tl.signalAt(s.x + s.radius + 1.9, s.z);
  const out = tl.signalAt(s.x + s.radius + 2.2, s.z);
  check('signalAt：半徑 +2 m 內命中、外面不命中', inR === s && (out === null || out !== s));
  check('signalAt：遠處回 null', tl.signalAt(1e6, 1e6) === null);
}

// ---------- nextStop（接線輔助）----------
{
  const s = S.find((x) => x.legs.some((l) => l.inbound && l.road.length > s0(x)));
  function s0(x) {
    return x.stopDist + 10;
  }
  const leg = s.legs.find((l) => l.inbound && l.road.length > s0(s) && (l.outDir > 0 ? l.road.length - l.s : l.s) > s0(s));
  const dir = -leg.outDir;
  const carS = leg.s + leg.outDir * (s.stopDist + 10);
  const ns = tl.nextStop(leg.road, dir, carS);
  check('nextStop：停止線前 10 m 的車找到該路口、距離 10 m', ns && ns.stop.signal === s && Math.abs(ns.distToStop - 10) < 1e-6, ns ? `${ns.distToStop.toFixed(2)} m` : 'null');
  const past = tl.nextStop(leg.road, dir, leg.s + dir * 0.5);
  check('nextStop：駛過路口中心後不再回報同一路口', !past || past.stop.signal !== s);
}

// ---------- 網格 ----------
{
  const inst = createTrafficLights();
  const scene = new THREE.Scene();
  const group = inst.buildMeshes(scene, { heightAt });
  const st = inst.stats();
  check('buildMeshes 建立 Group 並加入場景', group.isGroup && group.parent === scene);
  check('Mesh 物件數少（共用 InstancedMesh，≤ 4）', st.meshes <= 4, `Mesh ${st.meshes}、Sprite ${st.sprites}、燈頭 ${st.heads}、行人燈 ${st.pedHeads}、燈桿 ${st.poles}、燈泡 ${st.lamps}、停止線 ${st.stopLines}`);
  check('燈泡數 = 車用燈頭 × 3 + 行人燈 × 2', st.lamps === st.heads * 3 + st.pedHeads * 2);
  check('stats().signals / heads', st.signals === S.length && st.heads > 0, `signals ${st.signals}、heads ${st.heads}`);
  const lampMesh = group.children.find((o) => o.name === 'signal-lamps');
  check('燈泡有 instanceColor 且材質 emissive', !!lampMesh.instanceColor && lampMesh.material.emissiveIntensity > 0);
  const lines = group.children.find((o) => o.name === 'signal-stoplines');
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let lineOk = true;
  for (let i = 0; i < lines.count; i++) {
    lines.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    if (Math.abs(p.y - (heightAt(p.x, p.z) + 0.03)) > 1e-4) lineOk = false;
  }
  check('停止線貼路面 heightAt + 0.03', lineOk && lines.count === st.heads);
  // instanceColor 只在時相變化時更新
  const ic = lampMesh.instanceColor;
  let v0 = ic.version;
  inst.update(0.001);
  const noChange = ic.version === v0;
  let changed = false;
  for (let i = 0; i < 400 && !changed; i++) {
    v0 = ic.version;
    inst.update(0.1);
    if (ic.version !== v0) changed = true;
  }
  check('instanceColor：無變化時不上傳、時相變化時上傳', noChange && changed);
  // 倒數：出生點附近，物件池 ≤ 24、120 m 外不顯示、只在整數秒變化重畫
  const c = S[0];
  inst.updateVisuals(c.x, c.z);
  const s1 = inst.stats();
  check('倒數 Sprite 物件池 ≤ 24 且有顯示', s1.sprites <= 24 && s1.spritesVisible > 0 && s1.spritesVisible <= 24, `顯示 ${s1.spritesVisible}`);
  const within = group.children.filter((o) => o.isSprite && o.visible).every((o) => Math.hypot(o.position.x - c.x, o.position.z - c.z) <= 120);
  check('倒數只在 120 m 內顯示', within);
  const r0 = s1.redraws;
  for (let i = 0; i < 10; i++) {
    inst.update(1 / 60);
    inst.updateVisuals(c.x, c.z);
  }
  const r1 = inst.stats().redraws;
  check('倒數重畫次數受控（10 幀 ≈ 0.17 s 內每個 Sprite 至多重畫 1 次）', r1 - r0 <= s1.spritesVisible, `重畫 ${r1 - r0}`);
  inst.updateVisuals(1e6, 1e6);
  check('遠離後倒數全部隱藏', inst.stats().spritesVisible === 0);
  console.log(`INFO  號誌路口 ${st.signals}、車用燈頭 ${st.heads}、行人燈 ${st.pedHeads}、Mesh ${st.meshes} + Sprite ${st.sprites}`);
}

// 效能：update 每幀成本
{
  const inst = createTrafficLights();
  inst.buildMeshes(null, { heightAt });
  const t0 = performance.now();
  for (let i = 0; i < 3600; i++) {
    inst.update(1 / 60);
    inst.updateVisuals(S[0].x, S[0].z);
  }
  const ms = (performance.now() - t0) / 3600;
  check('update + updateVisuals 每幀 < 0.5 ms', ms < 0.5, `${ms.toFixed(4)} ms`);
}

// 時間步契約（p5-d1）：step(h) 每個物理子步推進模擬時間；update() 不帶 dt 只刷新相位不推進；update(dt) = step(dt) + 刷新
{
  const a = createTrafficLights();
  const b = createTrafficLights();
  const s = a.signals.find((x) => x.axes.length === 2) || a.signals[0];
  for (let i = 0; i < 1800; i++) {
    a.step(1 / 60);
    if (i % 3 === 2) a.update(); // 高更新率：有的幀沒有子步，刷新照做
    b.update(1 / 60);
  }
  a.update();
  const t0 = a.time;
  a.update();
  a.step(0);
  a.step(-1);
  check('step(h) 推進模擬時間、update() 只刷新不推進、相位與 update(dt) 一致', Math.abs(t0 - b.time) < 1e-9 && a.time === t0 && a.signals[s.id].phase === b.signals[s.id].phase,
    `time ${t0.toFixed(4)} / ${b.time.toFixed(4)}`);
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
