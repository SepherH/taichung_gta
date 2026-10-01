// 天氣（p5-s1）：晴 / 雨 / 霧三態狀態機 + 過場插值 + 雨絲粒子；不 import three（THREE 由呼叫端注入），node 可測
//
// 對外 API（docs 不可改，介面以本檔頭為準）：
//   createWeather({ scene, camera, quality, THREE, rng, auto, initial }) →
//     { update(dt, simDt), setWeather(kind, opts), getState(), getEnv(), setQuality(q), setAuto(on), stats(), dispose() }
//   - scene / camera / THREE：任一缺少就不建粒子（狀態機照跑）；camera 只讀 position.x/y/z
//   - quality：畫質 id（'low'|'mid'|'high'|'ultra'，沿用 core/quality.js qualityBudget）或 budget 物件（取 .id）；預設 high
//   - rng：() → [0,1)，預設 Math.random（隨機切換與過場長度用）
//   - auto：預設 true，晴 / 雨 / 霧依 HOLD_MIN–HOLD_MAX 秒隨機切換；false 只接受 setWeather
//   - initial：初始天氣，預設 'clear'
//   setWeather(kind, { instant = false, duration }) → boolean：kind ∈ 'clear'|'rain'|'fog'；
//     instant 立即到位；否則從「目前插值值」起過場 duration 秒（預設 8–15 s 隨機），目前過場中途改向也不跳變
//   getState() → { kind, target, t, rain, fog, icon }：kind = 目前（過場完成前為起點）天氣、target = 目標、
//     t = 過場進度 0–1（smoothstep 前的線性值；靜止時 1）、rain / fog = 0–1 強度、icon = 'sun'|'rain'|'fog'（過場過半換成目標）
//     回傳共用物件（每幀不配置），要保留請自行複製
//   getEnv() → 給 environment 的天氣參數（共用物件）：{ rain, fog, fogNearMul, fogFarMul, sunMul, hemiMul, overcast, haze }
//   stats() → { particles: 已配置雨絲數, drawn: 本幀畫出數, visible }
//
// 時間（契約 §20）：天氣不影響物理結果（濕地抓地未做），屬「遊戲時鐘」；狀態機計時吃 simDt（暫停時 0 → 天氣凍結），
//   simDt 未提供（非有限數）時退回渲染 dt；雨絲粒子屬特效，一律吃渲染 dt
// 粒子：LineSegments（每滴一段），在相機周圍 RADIUS × HEIGHT 的盒內，水平座標以相機為中心環繞包回；
//   畫出數 = 配置數 × rain（setDrawRange），rain ≈ 0 時整個隱藏；low 檔大幅降量（RAIN_COUNT）

import { QUALITY_IDS } from './core/quality.js';

export const WEATHER_KINDS = ['clear', 'rain', 'fog'];
export const WEATHER_ICONS = { clear: 'sun', rain: 'rain', fog: 'fog' };

// 各天氣的目標參數；過場時所有欄位一起插值
export const WEATHER_PROFILES = {
  clear: { rain: 0, fog: 0, fogNearMul: 1, fogFarMul: 1, sunMul: 1, hemiMul: 1, overcast: 0, haze: 0 },
  rain: { rain: 1, fog: 0.3, fogNearMul: 0.35, fogFarMul: 0.5, sunMul: 0.3, hemiMul: 0.7, overcast: 0.8, haze: 0.1 },
  fog: { rain: 0, fog: 1, fogNearMul: 0.03, fogFarMul: 0.16, sunMul: 0.5, hemiMul: 0.85, overcast: 0.55, haze: 0.6 },
};
const PARAM_KEYS = Object.keys(WEATHER_PROFILES.clear);

export const TRANSITION_MIN = 8; // s
export const TRANSITION_MAX = 15; // s
export const HOLD_MIN = 150; // s：自動模式下每種天氣維持時間
export const HOLD_MAX = 360; // s
// 自動切換的下一個天氣權重（排除目前天氣後依權重抽）
const AUTO_WEIGHTS = { clear: 0.6, rain: 0.25, fog: 0.15 };

// 雨絲數（依畫質）；low 大幅降量
export const RAIN_COUNT = { low: 400, mid: 1800, high: 3500, ultra: 5000 };
const RADIUS = { low: 22, mid: 32, high: 40, ultra: 45 }; // m：相機周圍水平半徑
const HEIGHT = 28; // m：盒高（相機上下各半）
const FALL_SPEED = 24; // m/s
const DROP_LEN = 0.9; // m
const WIND_X = 2.2; // m/s：輕微斜雨
const WIND_Z = 0.8;

export function qualityId(q) {
  const id = q && typeof q === 'object' ? q.id : q;
  return QUALITY_IDS.includes(id) ? id : 'high';
}

export function rainParticleCount(q) {
  return RAIN_COUNT[qualityId(q)];
}

export function smooth01(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function createWeather({ scene = null, camera = null, quality = 'high', THREE = null, rng = Math.random, auto = true, initial = 'clear' } = {}) {
  const start = WEATHER_KINDS.includes(initial) ? initial : 'clear';
  let kind = start;
  let target = start;
  let t = 1; // 過場線性進度
  let duration = 0;
  let autoOn = !!auto;
  let hold = randRange(HOLD_MIN, HOLD_MAX);
  let disposed = false;

  const from = { ...WEATHER_PROFILES[start] }; // 過場起點（插值快照）
  const env = { ...WEATHER_PROFILES[start] }; // 目前值
  const state = { kind, target, t, rain: env.rain, fog: env.fog, icon: WEATHER_ICONS[start] };

  // ---- 粒子 ----
  let tier = qualityId(quality);
  let rain = null; // { mesh, geo, attr, pos(Float32Array), count, radius }
  let drawn = 0;

  function randRange(a, b) {
    return a + (b - a) * rng();
  }

  function buildRain() {
    destroyRain();
    const count = RAIN_COUNT[tier];
    if (!THREE || !scene || !camera || count <= 0) return;
    const radius = RADIUS[tier];
    const pos = new Float32Array(count * 6);
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    for (let i = 0; i < count; i++) {
      const x = cx + (rng() * 2 - 1) * radius;
      const y = cy + (rng() - 0.5) * HEIGHT;
      const z = cz + (rng() * 2 - 1) * radius;
      writeDrop(pos, i, x, y, z);
    }
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(pos, 3);
    if (THREE.DynamicDrawUsage !== undefined && typeof attr.setUsage === 'function') attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.4, depthWrite: false, fog: true });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.frustumCulled = false; // 頂點每幀在相機周圍移動，包圍球不準
    mesh.visible = false;
    mesh.name = 'weather-rain';
    scene.add(mesh);
    rain = { mesh, geo, mat, attr, pos, count, radius };
  }

  function destroyRain() {
    if (!rain) return;
    if (scene && typeof scene.remove === 'function') scene.remove(rain.mesh);
    if (rain.geo && typeof rain.geo.dispose === 'function') rain.geo.dispose();
    if (rain.mat && typeof rain.mat.dispose === 'function') rain.mat.dispose();
    rain = null;
    drawn = 0;
  }

  // 一滴 = 兩個頂點：頭 (x,y,z)、尾（沿風向往上 DROP_LEN）
  const tailX = (WIND_X / FALL_SPEED) * DROP_LEN;
  const tailZ = (WIND_Z / FALL_SPEED) * DROP_LEN;
  function writeDrop(pos, i, x, y, z) {
    const o = i * 6;
    pos[o] = x;
    pos[o + 1] = y;
    pos[o + 2] = z;
    pos[o + 3] = x - tailX;
    pos[o + 4] = y + DROP_LEN;
    pos[o + 5] = z - tailZ;
  }

  function stepRain(dt) {
    if (!rain) return;
    const k = env.rain;
    const n = k > 0.01 ? Math.round(rain.count * k) : 0;
    drawn = n;
    rain.mesh.visible = n > 0;
    if (n <= 0) return;
    const pos = rain.pos;
    const r = rain.radius;
    const span = r * 2;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const bottom = cy - HEIGHT * 0.5;
    const d = dt > 0 ? dt : 0;
    const dy = FALL_SPEED * d;
    const dx = WIND_X * d;
    const dz = WIND_Z * d;
    // 只推進畫出的那幾滴（rain 小時省工）
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      let x = pos[o] + dx;
      let y = pos[o + 1] - dy;
      let z = pos[o + 2] + dz;
      if (y < bottom) y += HEIGHT;
      else if (y > bottom + HEIGHT) y -= HEIGHT;
      // 水平環繞包回相機周圍
      let rx = x - cx;
      if (rx > r || rx < -r) x = cx + (((rx + r) % span) + span) % span - r;
      let rz = z - cz;
      if (rz > r || rz < -r) z = cz + (((rz + r) % span) + span) % span - r;
      writeDrop(pos, i, x, y, z);
    }
    rain.attr.needsUpdate = true;
    rain.geo.setDrawRange(0, n * 2);
    rain.mat.opacity = 0.25 + 0.3 * k;
  }

  // ---- 狀態機 ----
  function syncState() {
    state.kind = kind;
    state.target = target;
    state.t = t;
    state.rain = env.rain;
    state.fog = env.fog;
    state.icon = WEATHER_ICONS[t >= 0.5 ? target : kind];
  }

  function applyMix() {
    const s = smooth01(t);
    const to = WEATHER_PROFILES[target];
    for (let i = 0; i < PARAM_KEYS.length; i++) {
      const key = PARAM_KEYS[i];
      env[key] = from[key] + (to[key] - from[key]) * s;
    }
  }

  function setWeather(next, opts = {}) {
    if (disposed || !WEATHER_KINDS.includes(next)) return false;
    const o = opts || {};
    if (o.instant) {
      kind = next;
      target = next;
      t = 1;
      Object.assign(from, WEATHER_PROFILES[next]);
      Object.assign(env, WEATHER_PROFILES[next]);
    } else {
      if (next === target) return true; // 已是該天氣或正往該天氣過場
      // 從目前插值值出發（過場中途改向不跳變）；起點天氣 = 目前顯示較接近的一方
      if (t < 1) kind = t >= 0.5 ? target : kind;
      Object.assign(from, env);
      target = next;
      t = 0;
      duration = Number.isFinite(o.duration) && o.duration > 0 ? o.duration : randRange(TRANSITION_MIN, TRANSITION_MAX);
    }
    hold = randRange(HOLD_MIN, HOLD_MAX);
    syncState();
    return true;
  }

  function pickNext() {
    let total = 0;
    for (const k of WEATHER_KINDS) if (k !== target) total += AUTO_WEIGHTS[k];
    let r = rng() * total;
    for (const k of WEATHER_KINDS) {
      if (k === target) continue;
      r -= AUTO_WEIGHTS[k];
      if (r <= 0) return k;
    }
    return target === 'clear' ? 'rain' : 'clear';
  }

  function update(dt, simDt) {
    if (disposed) return;
    const sdt = Number.isFinite(simDt) ? simDt : Number.isFinite(dt) ? dt : 0;
    const step = sdt > 0 ? sdt : 0;
    if (t < 1) {
      t = Math.min(1, t + step / duration);
      applyMix();
      if (t >= 1) {
        kind = target;
        Object.assign(env, WEATHER_PROFILES[target]);
      }
    } else if (autoOn && step > 0) {
      hold -= step;
      if (hold <= 0) setWeather(pickNext());
    }
    syncState();
    stepRain(Number.isFinite(dt) ? dt : 0);
  }

  function setQuality(q) {
    const next = qualityId(q);
    if (next === tier && (rain || RAIN_COUNT[next] <= 0 || !THREE)) return;
    tier = next;
    buildRain();
  }

  function dispose() {
    if (disposed) return;
    destroyRain();
    disposed = true;
  }

  buildRain();
  syncState();

  return {
    update,
    setWeather,
    getState: () => state,
    getEnv: () => env,
    setQuality,
    setAuto(on) {
      autoOn = !!on;
      hold = randRange(HOLD_MIN, HOLD_MAX);
    },
    stats: () => ({ particles: rain ? rain.count : 0, drawn, visible: !!(rain && rain.mesh.visible), tier }),
    dispose,
  };
}
