#!/usr/bin/env node
// 導航無頭驗證（契約 §17）：真 citymodel surfaceRoads 建圖 + A* + createNavigator（真 three Scene，不需物理）
// 用法：node tools/test/navigation.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：建圖節點 / 邊數與耗時（< 50 ms）、端點 1 m 吸附 / 共點合併 / 線段內節點保留 / 略過步道與地下道、
//   隨機 20 對點 A* 有解率 ≥ 90% 且路長 ≥ 直線距離、findRoute 單次 < 20 ms、投影（垂足 / 兩端補直線段）、
//   非法輸入回 null、導航器（事件、3 s 定時重算、偏離 > 25 m 重算、抵達 20 m 清除、外部事件不回發、圖釘）
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

const THREE = await import('three');
const { surfaceRoads, BOUNDS, heightAt } = await import('../../src/citymodel.js');
const { createBus } = await import('../../src/core/events.js');
const { buildRoadGraph, findRoute, projectToGraph, createNavigator, distanceToPolyline, ARRIVE_M, OFFROUTE_M, REROUTE_SEC, PIN_HEIGHT } = await import('../../src/navigation.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

// 固定亂數（mulberry32），結果可重現
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 建圖（真資料）----------
let t0 = performance.now();
const graph = buildRoadGraph(surfaceRoads);
const buildMs = performance.now() - t0;
let vertexTotal = 0;
for (const r of surfaceRoads) vertexTotal += r.pts.length;
check('建圖 < 50 ms', buildMs < 50, `${f2(buildMs)} ms`);
check('節點數合理（> 1000，≤ 頂點總數）', graph.nodeCount > 1000 && graph.nodeCount <= vertexTotal, `nodes ${graph.nodeCount} / 頂點 ${vertexTotal}`);
check('邊數合理（> 節點數，路網有環）', graph.edgeCount > graph.nodeCount, `edges ${graph.edgeCount}`);
check('最大連通塊 ≥ 95% 節點', graph.mainSize >= graph.nodeCount * 0.95, `main ${graph.mainSize} / ${graph.nodeCount}，塊數 ${graph.componentCount}`);
check('鄰接表為 typed array（CSR）', graph.offsets instanceof Int32Array && graph.adj instanceof Int32Array && graph.w instanceof Float32Array && graph.offsets[graph.nodeCount] === graph.edgeCount * 2);

// ---------- 建圖（合成資料：吸附 / 合併 / 線段內節點 / 略過）----------
const P = (arr) => {
  const pts = [];
  for (let i = 0; i < arr.length; i += 2) pts.push({ x: arr[i], z: arr[i + 1] });
  return pts;
};
const syn = buildRoadGraph([
  { pts: P([0, 0, 50, 0, 100, 0]) }, // A：線段內節點 (50,0)
  { pts: P([100.6, 0.4, 100, 80]) }, // B：起點離 A 終點 0.72 m → 吸附
  { pts: P([50, 0, 50, -60]) }, // C：共點 (50,0)
  { pts: P([100, 80, 103, 80]) }, // D：起點共點
  { pts: P([0, 0, 0, 90]), foot: true }, // 步道：略過
  { pts: P([0, 0, -90, 0]), under: true }, // 地下道：略過
  { pts: P([200, 0, 201.5, 0]) }, // E：距 1.5 m，不吸附（兩節點）
]);
check('合成：節點數（吸附 + 共點合併 + 線段內節點保留）', syn.nodeCount === 8, `nodes ${syn.nodeCount}（期望 8）`);
check('合成：邊數', syn.edgeCount === 6, `edges ${syn.edgeCount}（期望 6）`);
const midNode = (() => {
  for (let i = 0; i < syn.nodeCount; i++) if (syn.x[i] === 50 && syn.z[i] === 0) return i;
  return -1;
})();
check('合成：線段內節點 (50,0) 度 = 3', midNode >= 0 && syn.offsets[midNode + 1] - syn.offsets[midNode] === 3);
const synRoute = findRoute(syn, { x: 50, z: -60 }, { x: 103, z: 80 });
check('合成：跨吸附點可達', !!synRoute && Math.abs(synRoute.lengthM - (60 + 50 + 80 + 3)) < 1e-6, synRoute ? `${f2(synRoute.lengthM)} m` : 'null');

// ---------- 投影 ----------
const pr = projectToGraph(syn, 30, 7, {});
check('投影：垂足落在邊上', !!pr && Math.abs(pr.x - 30) < 1e-9 && Math.abs(pr.z) < 1e-9 && Math.abs(pr.dist - 7) < 1e-9, pr ? `(${f2(pr.x)}, ${f2(pr.z)}) d=${f2(pr.dist)}` : 'null');
const pr2 = projectToGraph(syn, -20, -5, {});
check('投影：超出端點時夾在端點', !!pr2 && pr2.x === 0 && pr2.z === 0);
const r2 = findRoute(syn, { x: 30, z: 7 }, { x: 80, z: -4 });
check(
  '起訖補直線段（首尾 = 輸入點、第二點 / 倒數第二點 = 投影點）',
  !!r2 && r2.points[0].x === 30 && r2.points[0].z === 7 && r2.points[1].z === 0 && r2.points[r2.points.length - 1].x === 80 && r2.points[r2.points.length - 2].x === 80,
  r2 ? JSON.stringify(r2.points) : 'null',
);
check('同一路段內：路長 = 7 + 50 + 4', !!r2 && Math.abs(r2.lengthM - 61) < 1e-6, r2 ? f2(r2.lengthM) : '');
check('非法輸入回 null', findRoute(graph, { x: NaN, z: 0 }, { x: 0, z: 0 }) === null && findRoute(null, { x: 0, z: 0 }, { x: 1, z: 1 }) === null);
check('空圖回 null', findRoute(buildRoadGraph([]), { x: 0, z: 0 }, { x: 10, z: 0 }) === null);

// ---------- 隨機 20 對 ----------
const rand = rng(20261001);
const W = BOUNDS.maxX - BOUNDS.minX;
const H = BOUNDS.maxZ - BOUNDS.minZ;
let solved = 0;
let shorter = 0;
let maxMs = 0;
let sumMs = 0;
const routeMs = [];
for (let i = 0; i < 20; i++) {
  const a = { x: BOUNDS.minX + rand() * W, z: BOUNDS.minZ + rand() * H };
  const b = { x: BOUNDS.minX + rand() * W, z: BOUNDS.minZ + rand() * H };
  t0 = performance.now();
  const res = findRoute(graph, a, b);
  const ms = performance.now() - t0;
  maxMs = Math.max(maxMs, ms);
  sumMs += ms;
  routeMs.push(ms);
  if (!res) continue;
  solved++;
  if (res.lengthM + 1e-6 < Math.hypot(a.x - b.x, a.z - b.z)) shorter++;
}
check('隨機 20 對 A* 有解率 ≥ 90%', solved >= 18, `${solved}/20`);
check('路長 ≥ 直線距離', shorter === 0, `違反 ${shorter}`);
const routeSorted = [...routeMs].sort((a, b) => a - b);
const routeUseP95 = routeSorted.length >= 20;
const routeStat = routeUseP95 ? routeSorted[Math.ceil(0.95 * routeSorted.length) - 1] : routeSorted[Math.floor((routeSorted.length - 1) / 2)];
const routeStatName = routeUseP95 ? 'p95' : '中位數';
check(`findRoute 單次 ${routeStatName} < 20 ms（n=${routeSorted.length}）`, routeStat < 20, `${routeStatName} ${f2(routeStat)} ms、max ${f2(maxMs)} ms（max 僅供參考）、平均 ${f2(sumMs / 20)} ms、樣本數 ${routeSorted.length}`);

// A* 最佳性抽驗：與 Dijkstra（啟發 = 0）同長
function dijkstraLen(g, from, to) {
  const S = projectToGraph(g, from.x, from.z, {});
  const E = projectToGraph(g, to.x, to.z, {});
  const dist = new Float64Array(g.nodeCount).fill(Infinity);
  const done = new Uint8Array(g.nodeCount);
  dist[S.a] = Math.hypot(S.x - g.x[S.a], S.z - g.z[S.a]);
  dist[S.b] = Math.hypot(S.x - g.x[S.b], S.z - g.z[S.b]);
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < g.nodeCount; i++) if (!done[i] && dist[i] < best) (best = dist[i]), (u = i);
    if (u < 0) break;
    done[u] = 1;
    for (let k = g.offsets[u]; k < g.offsets[u + 1]; k++) {
      const v = g.adj[k];
      if (dist[u] + g.w[k] < dist[v]) dist[v] = dist[u] + g.w[k];
    }
  }
  let L = Math.min(dist[E.a] + Math.hypot(g.x[E.a] - E.x, g.z[E.a] - E.z), dist[E.b] + Math.hypot(g.x[E.b] - E.x, g.z[E.b] - E.z));
  if (S.edge === E.edge) L = Math.min(L, Math.hypot(S.x - E.x, S.z - E.z));
  return L + S.dist + E.dist;
}
let optBad = 0;
for (let i = 0; i < 3; i++) {
  const a = { x: BOUNDS.minX + rand() * W, z: BOUNDS.minZ + rand() * H };
  const b = { x: BOUNDS.minX + rand() * W, z: BOUNDS.minZ + rand() * H };
  const res = findRoute(graph, a, b);
  const ref = dijkstraLen(graph, a, b);
  if (!res || Math.abs(res.lengthM - ref) > 0.05) optBad++;
}
check('A* 路長 = Dijkstra（3 對抽驗）', optBad === 0, `不一致 ${optBad}`);

// ---------- 導航器 ----------
const bus = createBus();
const events = [];
bus.on('nav:destination', (e) => events.push(['dest', e]));
bus.on('nav:clear', (e) => events.push(['clear', e]));
const scene = new THREE.Scene();
const nav = createNavigator({ bus, graph, scene, heightAt });

// 取一條長路的兩端：起點在路網上
const longRoad = surfaceRoads.slice().sort((a, b) => b.length - a.length)[0];
const start = { x: longRoad.pts[0].x, z: longRoad.pts[0].z };
const far = { x: BOUNDS.minX + W * 0.8, z: BOUNDS.minZ + H * 0.8 };
const destP = projectToGraph(graph, far.x, far.z, {});
const dest = { x: destP.x, z: destP.z };

check('初始無目的地 / 無路線', nav.destination() === null && nav.route() === null && nav.pin && nav.pin.visible === false);
nav.setDestination(dest.x, dest.z, '測試目的地', 'map');
check('setDestination 發 nav:destination', events.length === 1 && events[0][0] === 'dest' && events[0][1].source === 'map' && events[0][1].label === '測試目的地');
check('圖釘顯示且在場景內', nav.pin.visible === true && nav.pin.parent === scene);
nav.update(1 / 60, start);
const route1 = nav.route();
check('第一次 update 算出路線', Array.isArray(route1) && route1.length >= 2, route1 ? `${route1.length} 點、${f2(nav.routeLength())} m` : 'null');
const cone = nav.pin.getObjectByName('nav-pin-cone');
const ring = nav.pin.getObjectByName('nav-pin-ring');
const gy = heightAt(dest.x, dest.z);
check('圖釘：Group 在目的地地面、錐體約 8 m 高、光圈貼地', Math.abs(nav.pin.position.x - dest.x) < 1e-6 && Math.abs(nav.pin.position.y - gy) < 1e-6 && Math.abs(cone.position.y - PIN_HEIGHT) < 1 && ring.position.y < 0.5);
const ys = [];
for (let i = 0; i < 90; i++) {
  nav.update(1 / 60, start);
  ys.push(cone.position.y);
}
check('圖釘隨時間上下浮動', Math.max(...ys) - Math.min(...ys) > 0.3, `振幅 ${f2(Math.max(...ys) - Math.min(...ys))} m`);
check('3 s 內路線不重算（同一物件）', nav.route() === route1);
for (let i = 0; i < REROUTE_SEC * 60; i++) nav.update(1 / 60, start);
check('每 3 s 重算', nav.route() !== route1);
const route2 = nav.route();
nav.update(1 / 60, start);
check('重算後立刻不再重算', nav.route() === route2);
// 偏離 > 25 m：沿路線法向推開
const off = { x: start.x, z: start.z };
for (let d = 26; d < 400; d += 2) {
  off.x = start.x + d;
  if (distanceToPolyline(route2, off.x, off.z) > OFFROUTE_M + 0.5) break;
}
const offD = distanceToPolyline(route2, off.x, off.z);
nav.update(1 / 60, off);
check('偏離 > 25 m 立刻重算', offD > OFFROUTE_M && nav.route() !== route2, `偏離 ${f2(offD)} m`);
const route3 = nav.route();
nav.update(1 / 60, { x: off.x + 0.5, z: off.z });
check('偏離 ≤ 25 m 不重算', nav.route() === route3);
const mk = nav.markers();
check('markers() 回 dest 標記', mk.length === 1 && mk[0].kind === 'dest' && mk[0].x === dest.x);

// 抵達
events.length = 0;
nav.update(1 / 60, { x: dest.x + ARRIVE_M - 1, z: dest.z });
check('抵達 20 m 內清除並發 nav:clear', nav.destination() === null && nav.route() === null && events.length === 1 && events[0][0] === 'clear' && events[0][1].source === 'arrive');
check('清除後圖釘隱藏、markers 空', nav.pin.visible === false && nav.markers().length === 0);
nav.setDestination(dest.x, dest.z, 'x', 'map');
events.length = 0;
nav.update(1 / 60, { x: dest.x + ARRIVE_M + 5, z: dest.z });
check('20 m 外不清除', nav.destination() !== null && events.length === 0);

// 外部事件：任務發 nav:destination → 導航器接手、不回發
events.length = 0;
bus.emit('nav:destination', { x: start.x + 100, z: start.z, label: '委託目的地', source: 'mission' });
check('外部 nav:destination 設定目的地且不回發', nav.destination() && nav.destination().source === 'mission' && events.length === 1);
events.length = 0;
bus.emit('nav:clear', { source: 'map' });
check('外部 nav:clear 清除且不回發', nav.destination() === null && events.length === 1);
check('clear() 無目的地時不發事件', nav.clear('map') === false && events.length === 1);
check('非法座標 setDestination 回 false', nav.setDestination(NaN, 0, 'x') === false && nav.destination() === null);

// 無 scene / 無 bus 也可用
const nav2 = createNavigator({ graph });
nav2.setDestination(dest.x, dest.z, 'y');
nav2.update(0.016, start);
check('無 scene / bus 可用（無圖釘）', nav2.pin === null && Array.isArray(nav2.route()));

nav.dispose();
check('dispose 移除圖釘並退訂', nav.pin.parent === null && (bus.emit('nav:destination', { x: 0, z: 0 }), nav.destination() === null));

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
