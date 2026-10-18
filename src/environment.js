// 環境參數單一出口（p5-s1）：彙整「日夜基準值」與「天氣參數」，輸出最終的天空色、霧色 / 霧距、環境光（hemi）/ 主光（sun）
// 不 import three（只讀寫 .r/.g/.b 與 intensity），node 可測
//
// 對外 API（docs 不可改，介面以本檔頭為準）：
//   createEnvironment({ scene, dayNight, hemi, sun, viewDist, fogNear = 180, fogFar = 720, fogNearRatio = 0.25, apply = true }) →
//     { update(dt, { dayNight, weather }), getParams(), setViewDist(d), attach(dayNight), detach(), dispose() }
//   - dayNight：DayNight 實例（src/daynight.js）；有給就 attach —— DayNight 從此只算基準值（dayNight.base）、
//     不再直接改 scene.background / fog 色 / 光；detach() 或 dispose() 還原舊路徑
//   - hemi / sun：預設取 dayNight.hemi / dayNight.sun
//   - viewDist：畫質視距（budget.viewDist）；霧終點 = min(fogFar, viewDist × 0.95)、霧起點 = min(fogNear, 霧終點 × fogNearRatio)
//     （同 main.js applyViewDist 規則）；attach 後 main 改畫質時請改呼叫 setViewDist(budget.viewDist)，否則每幀會被本模組覆蓋
//   - update(dt, { dayNight, weather })：dayNight 省略時用 attach 的那個；weather 可為 createWeather() 實例（取 getEnv()）
//     或參數物件 { rain, fog, fogNearMul, fogFarMul, sunMul, hemiMul, overcast, haze }（缺欄位當晴天）；
//     dayNight 也可為純物件 { base: {...} }（測試用）；apply 為 true 時順手寫進 scene / 光源
//   - getParams() → 共用物件（每幀不配置）：
//     { sky: {r,g,b}, fog: { color: {r,g,b}, near, far }, hemi: { intensity, color, groundColor }, sun: { intensity, color },
//       weather: { rain, fog }, day, night }
// 呼叫順序（整合層）：dayNight.update(dt, focus) → weather.update(dt, simDt) → environment.update(dt, { dayNight, weather })
// v1-neon：夜間天空 / 霧往 Vice City 深紫偏移（NIGHT_TINT，白天 night = 0 不變；霧色仍 = 天空色）；
//   並驅動 neon.js（招牌閃爍 uniform、濕亮路面），畫質 id 取 weather.getTier()（未提供則沿用 neon 目前值）
import { updateNeon } from './neon.js';

const CLEAR = { rain: 0, fog: 0, fogNearMul: 1, fogFarMul: 1, sunMul: 1, hemiMul: 1, overcast: 0, haze: 0 };
const FALLBACK_SKY = { r: 0.36, g: 0.58, b: 0.82 };
const FALLBACK_HEMI_SKY = { r: 0.62, g: 0.79, b: 1 };
const FALLBACK_HEMI_GROUND = { r: 0.1, g: 0.14, b: 0.07 };
const WHITE = { r: 1, g: 1, b: 1 };
// 夜色參數表（v1-neon）：天空 / 霧往深紫混合 amt × night（雨 / 陰天灰化後重新帶回紫調）
const NIGHT_TINT = { color: { r: 0.075, g: 0.035, b: 0.16 }, amt: 0.35 };

function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

// 每幀不配置（v1-neon 子行程量測；修前 apply 關 + 開合計約 640 B/次）：
// - 浮點數一律經物件欄位進出：helper 只收物件參照、不收 / 不回傳浮點數（update 內聯預算用完後的 helper 呼叫不內聯，浮點參數 / 回傳值會裝箱成 HeapNumber）
// - 不寫 x && x.field 取浮點欄位：浮點與 null 在同一個 phi 匯合會強制裝箱
// - 容器用 class：各自獨立的 hidden class、浮點初值建立 Double 表示，欄位原地覆寫不配置
class Rgb {
  constructor() {
    this.r = 0.5;
    this.g = 0.5;
    this.b = 0.5;
  }
}
class FogParams {
  constructor(near, far) {
    this.color = new Rgb();
    this.near = 0.5;
    this.far = 0.5;
    this.near = near;
    this.far = far;
  }
}
class HemiParams {
  constructor() {
    this.intensity = 0.5;
    this.color = new Rgb();
    this.groundColor = new Rgb();
  }
}
class SunParams {
  constructor() {
    this.intensity = 0.5;
    this.color = new Rgb();
  }
}
class WeatherOut {
  constructor() {
    this.rain = 0.5;
    this.fog = 0.5;
  }
}
class EnvParams {
  constructor(near, far) {
    this.sky = new Rgb();
    this.fog = new FogParams(near, far);
    this.hemi = new HemiParams();
    this.sun = new SunParams();
    this.weather = new WeatherOut();
    this.day = 0.5;
    this.night = 0.5;
  }
}
// 本幀輸入（日夜基準 + 天氣）讀進固定形狀的暫存，後續計算只讀這裡（單態、不經多型載入）
class EnvInput {
  constructor() {
    this.rain = 0.5;
    this.fog = 0.5;
    this.overcast = 0.5;
    this.haze = 0.5;
    this.fogNearMul = 0.5;
    this.fogFarMul = 0.5;
    this.sunMul = 0.5;
    this.hemiMul = 0.5;
    this.day = 0.5;
    this.night = 0.5;
    this.sunIntensity = 0.5;
    this.hemiIntensity = 0.5;
    this.greyAmt = 0.5; // towardGrey 的參數（欄位傳遞）
    this.greyK = 0.5;
  }
}
class NeonIn {
  constructor() {
    this.night = 0.5;
    this.rain = 0.5;
    this.tier = null;
  }
}

function readInput(inp, w, b) {
  inp.rain = num(w.rain, 0);
  inp.fog = num(w.fog, 0);
  inp.overcast = num(w.overcast, 0);
  inp.haze = num(w.haze, 0);
  inp.fogNearMul = num(w.fogNearMul, 1);
  inp.fogFarMul = num(w.fogFarMul, 1);
  inp.sunMul = num(w.sunMul, 1);
  inp.hemiMul = num(w.hemiMul, 1);
  // 不寫成 num(b && b.day, 1)：浮點欄位與 null 在同一個 phi 匯合會強制裝箱（每次配置 HeapNumber）
  if (b) {
    inp.day = num(b.day, 1);
    inp.night = num(b.night, 0);
    inp.sunIntensity = num(b.sunIntensity, 2.6);
    inp.hemiIntensity = num(b.hemiIntensity, 1);
  } else {
    inp.day = 1;
    inp.night = 0;
    inp.sunIntensity = 2.6;
    inp.hemiIntensity = 1;
  }
}

// c 必為物件（呼叫端以 || FALLBACK 保底）：同上，不用 c && c.r
function copyRgb(out, c) {
  out.r = num(c.r, 0);
  out.g = num(c.g, 0);
  out.b = num(c.b, 0);
  return out;
}

// 往灰階（亮度 × inp.greyK）混合 inp.greyAmt
function towardGrey(c, inp) {
  const amt = inp.greyAmt;
  if (amt <= 0) return;
  const g = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * inp.greyK;
  c.r += (g - c.r) * amt;
  c.g += (g - c.g) * amt;
  c.b += (g - c.b) * amt;
}

// THREE.Color 也直接寫欄位（等同 setRGB(r, g, b) 於工作色彩空間）：不把浮點數當參數傳給未內聯的 setRGB 而裝箱
function writeColor(target, c) {
  if (!target) return;
  if (target.isColor || typeof target.setRGB !== 'function') {
    target.r = c.r;
    target.g = c.g;
    target.b = c.b;
  } else target.setRGB(c.r, c.g, c.b);
}

export function fogRange(viewDist, fogNear = 180, fogFar = 720, ratio = 0.25) {
  const far = Number.isFinite(viewDist) && viewDist > 0 ? Math.min(fogFar, viewDist * 0.95) : fogFar;
  return { near: Math.min(fogNear, far * ratio), far };
}

export function createEnvironment({
  scene = null, dayNight = null, hemi = null, sun = null, viewDist = Infinity,
  fogNear = 180, fogFar = 720, fogNearRatio = 0.25, apply = true,
} = {}) {
  let attached = null;
  let vd = viewDist;
  let range = fogRange(vd, fogNear, fogFar, fogNearRatio);

  const neonIn = new NeonIn(); // updateNeon 參數（重用，每幀不配置）
  const input = new EnvInput();
  const params = new EnvParams(range.near, range.far);

  function attach(dn) {
    if (attached && attached !== dn && typeof attached.attachEnvironment === 'function') attached.attachEnvironment(null);
    attached = dn || null;
    if (attached && typeof attached.attachEnvironment === 'function') attached.attachEnvironment(api);
  }

  function detach() {
    if (attached && typeof attached.attachEnvironment === 'function') attached.attachEnvironment(null);
    attached = null;
  }

  function weatherParams(w) {
    if (!w) return CLEAR;
    if (typeof w.getEnv === 'function') return w.getEnv() || CLEAR;
    return w;
  }

  function update(dt, src = {}) {
    const dn = (src && src.dayNight) || attached;
    const b = (dn && dn.base) || null;
    const inp = input;
    readInput(inp, weatherParams(src && src.weather), b);
    const day = inp.day;
    const night = inp.night;
    const overcast = inp.overcast;
    const haze = inp.haze;

    params.day = day;
    params.night = night;
    params.weather.rain = inp.rain;
    params.weather.fog = inp.fog;

    // 天空：陰天往暗灰；霧天再往亮灰（霧白），亮度隨白天
    const sky = copyRgb(params.sky, (b && b.sky) || FALLBACK_SKY);
    inp.greyAmt = overcast * 0.85;
    inp.greyK = 0.75;
    towardGrey(sky, inp);
    if (haze > 0) {
      const g = 0.25 + 0.5 * day;
      sky.r += (g - sky.r) * haze * 0.6;
      sky.g += (g - sky.g) * haze * 0.6;
      sky.b += (g * 1.02 - sky.b) * haze * 0.6;
    }

    // 夜間深紫（Vice City）：night = 0 時不動
    const nt = night * NIGHT_TINT.amt;
    if (nt > 0) {
      sky.r += (NIGHT_TINT.color.r - sky.r) * nt;
      sky.g += (NIGHT_TINT.color.g - sky.g) * nt;
      sky.b += (NIGHT_TINT.color.b - sky.b) * nt;
    }

    // 霧：色同天空（遠處融入背景）；距離 = 視距夾過的基準 × 天氣倍率
    copyRgb(params.fog.color, sky);
    params.fog.far = range.far * inp.fogFarMul;
    params.fog.near = Math.min(range.near * inp.fogNearMul, params.fog.far * 0.9);

    // 主光：陰雨 / 霧壓暗並往灰白
    params.sun.intensity = inp.sunIntensity * inp.sunMul;
    copyRgb(params.sun.color, (b && b.sunColor) || WHITE);
    inp.greyAmt = overcast * 0.6;
    inp.greyK = 1.1;
    towardGrey(params.sun.color, inp);

    // 環境光：同理（較溫和；夜間保底亮度不被壓過頭）
    params.hemi.intensity = inp.hemiIntensity * inp.hemiMul;
    copyRgb(params.hemi.color, (b && b.hemiSky) || FALLBACK_HEMI_SKY);
    inp.greyAmt = overcast * 0.5;
    inp.greyK = 1;
    towardGrey(params.hemi.color, inp);
    copyRgb(params.hemi.groundColor, (b && b.hemiGround) || FALLBACK_HEMI_GROUND);
    inp.greyAmt = overcast * 0.3;
    inp.greyK = 0.9;
    towardGrey(params.hemi.groundColor, inp);

    if (apply) applyToScene(dn);

    const ws = src && src.weather;
    neonIn.night = night;
    neonIn.rain = inp.rain;
    neonIn.tier = ws && typeof ws.getTier === 'function' ? ws.getTier() : null;
    updateNeon(dt, neonIn);
  }

  function applyToScene(dn) {
    const h = hemi || (dn && dn.hemi);
    const s = sun || (dn && dn.sun);
    if (scene) {
      if (scene.background && typeof scene.background === 'object' && 'r' in scene.background) writeColor(scene.background, params.sky);
      if (scene.fog) {
        writeColor(scene.fog.color, params.fog.color);
        if ('near' in scene.fog) {
          scene.fog.near = params.fog.near;
          scene.fog.far = params.fog.far;
        }
      }
    }
    if (h) {
      h.intensity = params.hemi.intensity;
      writeColor(h.color, params.hemi.color);
      writeColor(h.groundColor, params.hemi.groundColor);
    }
    if (s) {
      s.intensity = params.sun.intensity;
      writeColor(s.color, params.sun.color);
    }
  }

  function setViewDist(d) {
    vd = d;
    range = fogRange(vd, fogNear, fogFar, fogNearRatio);
  }

  const api = {
    update,
    getParams: () => params,
    setViewDist,
    attach,
    detach,
    dispose: detach,
  };
  if (dayNight) attach(dayNight);
  return api;
}
