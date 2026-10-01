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

const CLEAR = { rain: 0, fog: 0, fogNearMul: 1, fogFarMul: 1, sunMul: 1, hemiMul: 1, overcast: 0, haze: 0 };
const FALLBACK_SKY = { r: 0.36, g: 0.58, b: 0.82 };
const FALLBACK_HEMI_SKY = { r: 0.62, g: 0.79, b: 1 };
const FALLBACK_HEMI_GROUND = { r: 0.1, g: 0.14, b: 0.07 };
const WHITE = { r: 1, g: 1, b: 1 };

function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

function rgb() {
  return { r: 0, g: 0, b: 0 };
}

function copyRgb(out, c) {
  out.r = num(c && c.r, 0);
  out.g = num(c && c.g, 0);
  out.b = num(c && c.b, 0);
  return out;
}

const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// 往灰階（亮度 × k）混合 amt
function towardGrey(c, amt, k) {
  if (amt <= 0) return;
  const g = lum(c) * k;
  c.r += (g - c.r) * amt;
  c.g += (g - c.g) * amt;
  c.b += (g - c.b) * amt;
}

function writeColor(target, c) {
  if (!target) return;
  if (typeof target.setRGB === 'function') target.setRGB(c.r, c.g, c.b);
  else {
    target.r = c.r;
    target.g = c.g;
    target.b = c.b;
  }
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

  const params = {
    sky: rgb(),
    fog: { color: rgb(), near: range.near, far: range.far },
    hemi: { intensity: 1, color: rgb(), groundColor: rgb() },
    sun: { intensity: 1, color: rgb() },
    weather: { rain: 0, fog: 0 },
    day: 1,
    night: 0,
  };

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
    const w = weatherParams(src && src.weather);
    const rain = num(w.rain, 0);
    const fog = num(w.fog, 0);
    const overcast = num(w.overcast, 0);
    const haze = num(w.haze, 0);
    const day = num(b && b.day, 1);
    const night = num(b && b.night, 0);

    params.day = day;
    params.night = night;
    params.weather.rain = rain;
    params.weather.fog = fog;

    // 天空：陰天往暗灰；霧天再往亮灰（霧白），亮度隨白天
    const sky = copyRgb(params.sky, (b && b.sky) || FALLBACK_SKY);
    towardGrey(sky, overcast * 0.85, 0.75);
    if (haze > 0) {
      const g = 0.25 + 0.5 * day;
      sky.r += (g - sky.r) * haze * 0.6;
      sky.g += (g - sky.g) * haze * 0.6;
      sky.b += (g * 1.02 - sky.b) * haze * 0.6;
    }

    // 霧：色同天空（遠處融入背景）；距離 = 視距夾過的基準 × 天氣倍率
    copyRgb(params.fog.color, sky);
    params.fog.far = range.far * num(w.fogFarMul, 1);
    params.fog.near = Math.min(range.near * num(w.fogNearMul, 1), params.fog.far * 0.9);

    // 主光：陰雨 / 霧壓暗並往灰白
    params.sun.intensity = num(b && b.sunIntensity, 2.6) * num(w.sunMul, 1);
    copyRgb(params.sun.color, (b && b.sunColor) || WHITE);
    towardGrey(params.sun.color, overcast * 0.6, 1.1);

    // 環境光：同理（較溫和；夜間保底亮度不被壓過頭）
    params.hemi.intensity = num(b && b.hemiIntensity, 1) * num(w.hemiMul, 1);
    copyRgb(params.hemi.color, (b && b.hemiSky) || FALLBACK_HEMI_SKY);
    towardGrey(params.hemi.color, overcast * 0.5, 1);
    copyRgb(params.hemi.groundColor, (b && b.hemiGround) || FALLBACK_HEMI_GROUND);
    towardGrey(params.hemi.groundColor, overcast * 0.3, 0.9);

    if (apply) applyToScene(dn);
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
