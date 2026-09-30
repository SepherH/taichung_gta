// 導航（契約 §17）：車道路網建圖、A* 尋路、導航器（目的地 / 重算 / 抵達清除 / 世界內圖釘）
// buildRoadGraph(roads)：只吃車道（citymodel surfaceRoads，不含步道與地下道）；每個折線頂點都是節點（線段內節點保留），
//   端點 1 m 吸附、共點合併（OSM 共用節點投影後同座標）；鄰接表為 CSR 型 typed array（offsets / adj / w）
//   不考慮單行道（步行與遊戲駕駛皆可逆行）；立體交叉沒有共用節點就不相連
// findRoute(graph, from, to)：起訖各投影到最近邊（只取最大連通塊的邊，避免落在孤立小段），兩端補直線段；
//   A* 以歐氏距離為啟發；找不到回 null；A* 暫存（g / 來源 / 堆積）掛在 graph 上重用
// createNavigator({ bus, graph, scene, heightAt })：
//   setDestination 發 nav:destination、clear 發 nav:clear；也訂閱 bus 上他人發的 nav:destination / nav:clear（不再回發）
//   update：抵達 20 m 內清除（nav:clear source 'arrive'）；偏離路線 > 25 m 或每 3 s 重算
//   圖釘：目的地上方 8 m 的浮動倒錐 + 地面光圈，單一 Group，隨時間上下浮動；每幀不配置新物件
import * as THREE from 'three';

export const SNAP_M = 1; // 端點吸附距離
export const ARRIVE_M = 20; // 抵達清除距離
export const OFFROUTE_M = 25; // 偏離路線重算門檻
export const REROUTE_SEC = 3; // 定時重算間隔
export const PIN_HEIGHT = 8; // 圖釘離地高度

// ---------- 建圖 ----------
export function buildRoadGraph(roads) {
  const xs = [];
  const zs = [];
  const cells = new Map(); // 1 m 格 → 節點索引陣列
  const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);

  // 以 1 m 格加上鄰格查詢：距離 ≤ SNAP_M 的既有節點直接共用
  function nodeAt(x, z) {
    const ix = Math.floor(x / SNAP_M);
    const iz = Math.floor(z / SNAP_M);
    let best = -1;
    let bestD = SNAP_M * SNAP_M;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = cells.get(cellKey(ix + dx, iz + dz));
        if (!list) continue;
        for (const n of list) {
          const d = (xs[n] - x) ** 2 + (zs[n] - z) ** 2;
          if (d <= bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = xs.length;
    xs.push(x);
    zs.push(z);
    const k = cellKey(ix, iz);
    let list = cells.get(k);
    if (!list) {
      list = [];
      cells.set(k, list);
    }
    list.push(id);
    return id;
  }

  // 無向邊（去重）
  const ea = [];
  const eb = [];
  const edgeSet = new Set();
  const eroad = [];
  for (const r of roads || []) {
    if (!r || !r.pts || r.pts.length < 2 || r.foot || r.under) continue;
    let prev = nodeAt(r.pts[0].x, r.pts[0].z);
    for (let i = 1; i < r.pts.length; i++) {
      const cur = nodeAt(r.pts[i].x, r.pts[i].z);
      if (cur !== prev) {
        const lo = Math.min(prev, cur);
        const hi = Math.max(prev, cur);
        const key = lo * 1048576 + hi;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          ea.push(lo);
          eb.push(hi);
          eroad.push(r);
        }
      }
      prev = cur;
    }
  }

  const n = xs.length;
  const m = ea.length;
  const nx = Float64Array.from(xs);
  const nz = Float64Array.from(zs);
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    deg[ea[e]]++;
    deg[eb[e]]++;
  }
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + deg[i];
  const fill = offsets.slice(0, n);
  const adj = new Int32Array(m * 2);
  const w = new Float32Array(m * 2);
  for (let e = 0; e < m; e++) {
    const a = ea[e];
    const b = eb[e];
    const L = Math.hypot(nx[a] - nx[b], nz[a] - nz[b]);
    adj[fill[a]] = b;
    w[fill[a]++] = L;
    adj[fill[b]] = a;
    w[fill[b]++] = L;
  }

  // 連通塊（BFS）；投影只用最大塊
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let nComp = 0;
  let mainComp = -1;
  let mainSize = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = nComp;
    while (head < tail) {
      const u = queue[head++];
      for (let k = offsets[u]; k < offsets[u + 1]; k++) {
        const v = adj[k];
        if (comp[v] < 0) {
          comp[v] = nComp;
          queue[tail++] = v;
        }
      }
    }
    if (tail > mainSize) {
      mainSize = tail;
      mainComp = nComp;
    }
    nComp++;
  }

  // 邊的空間網格（25 m 格），投影查詢用
  const CELL = 25;
  const edgeCells = new Map();
  const edgeA = Int32Array.from(ea);
  const edgeB = Int32Array.from(eb);
  for (let e = 0; e < m; e++) {
    const a = edgeA[e];
    const b = edgeB[e];
    const x0 = Math.floor(Math.min(nx[a], nx[b]) / CELL);
    const x1 = Math.floor(Math.max(nx[a], nx[b]) / CELL);
    const z0 = Math.floor(Math.min(nz[a], nz[b]) / CELL);
    const z1 = Math.floor(Math.max(nz[a], nz[b]) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = cellKey(ix, iz);
        let list = edgeCells.get(k);
        if (!list) {
          list = [];
          edgeCells.set(k, list);
        }
        list.push(e);
      }
    }
  }

  return {
    nodeCount: n,
    edgeCount: m,
    x: nx,
    z: nz,
    offsets,
    adj,
    w,
    edgeA,
    edgeB,
    edgeRoad: eroad,
    comp,
    componentCount: nComp,
    mainComp,
    mainSize,
    cellSize: CELL,
    edgeCells,
    cellKey,
    // A* 暫存（findRoute 重用）
    _g: new Float64Array(n),
    _came: new Int32Array(n),
    _stamp: new Int32Array(n),
    _closed: new Int32Array(n),
    _heapN: new Int32Array(Math.max(16, m * 2 + 4)),
    _heapF: new Float64Array(Math.max(16, m * 2 + 4)),
    _run: 0,
    _mark: new Int32Array(m),
    _markRun: 0,
  };
}

// ---------- 投影：點 → 最近邊上的投影點 ----------
// 回傳 out = { edge, a, b, t, x, z, dist }；只看最大連通塊（mainOnly=false 時全部）；找不到回 null
export function projectToGraph(graph, px, pz, out = {}, mainOnly = true) {
  if (!graph || !graph.edgeCount) return null;
  const { x, z, edgeA, edgeB, comp, mainComp, cellSize, edgeCells, cellKey } = graph;
  const cx = Math.floor(px / cellSize);
  const cz = Math.floor(pz / cellSize);
  const run = ++graph._markRun;
  const mark = graph._mark;
  let best = -1;
  let bestD = Infinity;
  let bestT = 0;
  // 由近而遠擴大搜尋圈；找到後再多看一圈即可確定最近
  const maxR = 400;
  for (let r = 0; r <= maxR; r++) {
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        if (r > 0 && ix !== cx - r && ix !== cx + r && iz !== cz - r && iz !== cz + r) continue;
        const list = edgeCells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const e of list) {
          if (mark[e] === run) continue;
          mark[e] = run;
          const a = edgeA[e];
          const b = edgeB[e];
          if (mainOnly && comp[a] !== mainComp) continue;
          const dx = x[b] - x[a];
          const dz = z[b] - z[a];
          const L2 = dx * dx + dz * dz;
          let t = L2 > 1e-12 ? ((px - x[a]) * dx + (pz - z[a]) * dz) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x[a] + dx * t - px;
          const qz = z[a] + dz * t - pz;
          const d = qx * qx + qz * qz;
          if (d < bestD) {
            bestD = d;
            best = e;
            bestT = t;
          }
        }
      }
    }
    // 圈 r 已涵蓋距離 ≥ r * cellSize 的所有點
    if (best >= 0 && Math.sqrt(bestD) <= r * cellSize) break;
  }
  if (best < 0) return null;
  const a = edgeA[best];
  const b = edgeB[best];
  out.edge = best;
  out.a = a;
  out.b = b;
  out.t = bestT;
  out.x = x[a] + (x[b] - x[a]) * bestT;
  out.z = z[a] + (z[b] - z[a]) * bestT;
  out.dist = Math.sqrt(bestD);
  return out;
}

// ---------- 堆積（最小 f）----------
function heapPush(graph, size, node, f) {
  const H = graph._heapN;
  const F = graph._heapF;
  let i = size;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (F[p] <= f) break;
    H[i] = H[p];
    F[i] = F[p];
    i = p;
  }
  H[i] = node;
  F[i] = f;
}
function heapPop(graph, size) {
  // 回傳頂端節點；呼叫端負責 size - 1
  const H = graph._heapN;
  const F = graph._heapF;
  const top = H[0];
  const last = size - 1;
  const ln = H[last];
  const lf = F[last];
  let i = 0;
  for (;;) {
    let c = i * 2 + 1;
    if (c >= last) break;
    if (c + 1 < last && F[c + 1] < F[c]) c++;
    if (F[c] >= lf) break;
    H[i] = H[c];
    F[i] = F[c];
    i = c;
  }
  H[i] = ln;
  F[i] = lf;
  return top;
}

const _ps = {};
const _pe = {};

// ---------- A* ----------
// from / to：{ x, z }；回傳 { points:[{x,z}], lengthM } 或 null
export function findRoute(graph, from, to) {
  if (!graph || !from || !to) return null;
  if (!Number.isFinite(from.x) || !Number.isFinite(from.z) || !Number.isFinite(to.x) || !Number.isFinite(to.z)) return null;
  const S = projectToGraph(graph, from.x, from.z, _ps);
  const E = projectToGraph(graph, to.x, to.z, _pe);
  if (!S || !E) return null;
  const { x, z, offsets, adj, w } = graph;
  const g = graph._g;
  const came = graph._came;
  const stamp = graph._stamp;
  const closed = graph._closed;
  const run = ++graph._run;
  const ex = E.x;
  const ez = E.z;
  const h = (n) => Math.hypot(x[n] - ex, z[n] - ez);

  let bestTotal = Infinity;
  let bestEnd = -1; // 最後一個圖節點；-2 = 起訖在同一邊直接相連
  // 同一條邊：直接沿邊走
  if (S.edge === E.edge) {
    bestTotal = Math.hypot(S.x - ex, S.z - ez);
    bestEnd = -2;
  }
  const endA = E.a;
  const endB = E.b;
  const endDA = Math.hypot(x[endA] - ex, z[endA] - ez);
  const endDB = Math.hypot(x[endB] - ex, z[endB] - ez);

  let size = 0;
  const seed = (n, d) => {
    if (stamp[n] === run && g[n] <= d) return;
    stamp[n] = run;
    g[n] = d;
    came[n] = -1;
    heapPush(graph, size++, n, d + h(n));
  };
  seed(S.a, Math.hypot(S.x - x[S.a], S.z - z[S.a]));
  seed(S.b, Math.hypot(S.x - x[S.b], S.z - z[S.b]));

  while (size > 0) {
    const fTop = graph._heapF[0];
    if (fTop >= bestTotal) break;
    const u = heapPop(graph, size--);
    if (closed[u] === run) continue;
    closed[u] = run;
    const gu = g[u];
    if (u === endA && gu + endDA < bestTotal) {
      bestTotal = gu + endDA;
      bestEnd = u;
    }
    if (u === endB && gu + endDB < bestTotal) {
      bestTotal = gu + endDB;
      bestEnd = u;
    }
    for (let k = offsets[u]; k < offsets[u + 1]; k++) {
      const v = adj[k];
      if (closed[v] === run) continue;
      const nd = gu + w[k];
      if (stamp[v] !== run || nd < g[v]) {
        stamp[v] = run;
        g[v] = nd;
        came[v] = u;
        if (size >= graph._heapN.length) break; // 理論上不會發生（每條有向邊至多推一次）
        heapPush(graph, size++, v, nd + h(v));
      }
    }
  }
  if (bestEnd === -1) return null;

  // 組路線：from → 起點投影 → 圖節點… → 終點投影 → to（相鄰重複點略過）
  const mid = [];
  if (bestEnd >= 0) {
    for (let n = bestEnd; n >= 0; n = came[n]) mid.push(n);
    mid.reverse();
  }
  const points = [];
  const push = (px, pz) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - px) < 0.01 && Math.abs(last.z - pz) < 0.01) return;
    points.push({ x: px, z: pz });
  };
  push(from.x, from.z);
  push(S.x, S.z);
  for (const n of mid) push(x[n], z[n]);
  push(ex, ez);
  push(to.x, to.z);
  let lengthM = 0;
  for (let i = 1; i < points.length; i++) lengthM += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { points, lengthM };
}

// 點到折線的最短距離（route 偏離判斷用）
export function distanceToPolyline(points, px, pz) {
  if (!points || !points.length) return Infinity;
  if (points.length === 1) return Math.hypot(points[0].x - px, points[0].z - pz);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 1e-12 ? ((px - a.x) * dx + (pz - a.z) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + dx * t - px;
    const qz = a.z + dz * t - pz;
    const d = qx * qx + qz * qz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ---------- 世界內圖釘 ----------
function makePin() {
  const group = new THREE.Group();
  group.name = 'nav-pin';
  const mat = new THREE.MeshBasicMaterial({ color: 0x2fe0e0, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
  // 倒錐：尖端朝下
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3, 16), mat);
  cone.rotation.x = Math.PI;
  cone.name = 'nav-pin-cone';
  group.add(cone);
  // 地面光圈
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x2fe0e0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'nav-pin-ring';
  group.add(ring);
  group.visible = false;
  group.renderOrder = 5;
  return { group, cone, ring, mat, ringMat };
}

// ---------- 導航器 ----------
export function createNavigator({ bus = null, graph, scene = null, heightAt = null } = {}) {
  let dest = null; // { x, z, label, source }
  let routeRes = null;
  let timer = 0;
  let time = 0;
  let emitting = false;
  let groundY = 0;
  const pin = scene ? makePin() : null;
  if (pin) scene.add(pin.group);
  const offs = [];

  function reroute(pos) {
    if (!dest || !pos) return;
    routeRes = findRoute(graph, pos, dest);
    timer = 0;
  }

  function place() {
    if (!pin) return;
    pin.group.visible = !!dest;
    if (!dest) return;
    groundY = 0;
    if (typeof heightAt === 'function') {
      const y = heightAt(dest.x, dest.z);
      if (Number.isFinite(y)) groundY = y;
    }
    pin.group.position.set(dest.x, groundY, dest.z);
    pin.ring.position.y = 0.15;
    pin.cone.position.y = PIN_HEIGHT;
  }

  // 內部設定（不發事件）
  function applyDest(x, z, label, source) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    dest = { x, z, label: label || '目的地', source: source || 'map' };
    routeRes = null;
    timer = REROUTE_SEC; // 下一次 update 立刻算路
    place();
    return true;
  }
  function applyClear() {
    const had = !!dest;
    dest = null;
    routeRes = null;
    timer = 0;
    place();
    return had;
  }

  function emit(name, payload) {
    if (!bus) return;
    emitting = true;
    try {
      bus.emit(name, payload);
    } finally {
      emitting = false;
    }
  }

  function setDestination(x, z, label, source = 'map', playerPos = null) {
    if (!applyDest(x, z, label, source)) return false;
    if (playerPos) reroute(playerPos);
    emit('nav:destination', { x: dest.x, z: dest.z, label: dest.label, source: dest.source });
    return true;
  }

  function clear(source = 'map') {
    if (!applyClear()) return false;
    emit('nav:clear', { source });
    return true;
  }

  if (bus && typeof bus.on === 'function') {
    offs.push(
      bus.on('nav:destination', (e) => {
        if (emitting || !e) return;
        applyDest(e.x, e.z, e.label, e.source);
      }),
    );
    offs.push(
      bus.on('nav:clear', () => {
        if (emitting) return;
        applyClear();
      }),
    );
  }

  function update(dt, playerPos) {
    time += dt;
    if (pin && dest) {
      pin.cone.position.y = PIN_HEIGHT + Math.sin(time * 2.2) * 0.6;
      pin.cone.rotation.y = time * 1.5;
      const s = 1 + 0.12 * Math.sin(time * 3);
      pin.ring.scale.set(s, s, s);
    }
    if (!dest || !playerPos) return;
    const dx = playerPos.x - dest.x;
    const dz = playerPos.z - dest.z;
    if (dx * dx + dz * dz <= ARRIVE_M * ARRIVE_M) {
      clear('arrive');
      return;
    }
    timer += dt;
    if (!routeRes || timer >= REROUTE_SEC || distanceToPolyline(routeRes.points, playerPos.x, playerPos.z) > OFFROUTE_M) {
      reroute(playerPos);
    }
  }

  const markerList = [];
  const markerItem = { x: 0, z: 0, kind: 'dest', label: '' };

  return {
    setDestination,
    clear,
    update,
    reroute,
    route: () => (routeRes ? routeRes.points : null),
    routeLength: () => (routeRes ? routeRes.lengthM : null),
    destination: () => (dest ? { ...dest } : null),
    // 給小地圖 / 大地圖：目的地標記（重用同一陣列與物件）
    markers() {
      markerList.length = 0;
      if (dest) {
        markerItem.x = dest.x;
        markerItem.z = dest.z;
        markerItem.label = dest.label;
        markerList.push(markerItem);
      }
      return markerList;
    },
    pin: pin ? pin.group : null,
    dispose() {
      for (const off of offs) if (typeof off === 'function') off();
      offs.length = 0;
      if (pin) {
        if (pin.group.parent) pin.group.parent.remove(pin.group);
        pin.cone.geometry.dispose();
        pin.ring.geometry.dispose();
        pin.mat.dispose();
        pin.ringMat.dispose();
      }
    },
  };
}
