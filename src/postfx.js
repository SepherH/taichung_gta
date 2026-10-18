// 後製：選擇性泛光（v1b-bloom「罪惡之都」霓虹光暈）
// 本檔不 import three（THREE 與 three/addons 的 pass 類別由呼叫端注入），參數 / 解析度 / 強度曲線為純邏輯，node 可測。
//
// 選擇方式：亮度門檻（不另渲染 bloom layer 場景 → draw call 不增加）。高通改用「最大色版」而非 luminance：
//   飽和霓虹（emissive 2.2，粉 / 紫 / 青最大色版皆 ≈ 2.2）、車頭燈 2.0–2.5、警燈 4–6、爆炸火光 > 門檻 1.45；
//   窗光 1.3、店面微光 1.2、夜間受光表面 < 1 → 不發光暈。
// 門檻隨 night 等比縮放（v1b-rf-fix）：霓虹 / 窗光 / 車燈的 emissive 皆 = max × night，門檻與過渡寬同乘 night，
//   比例維持「霓虹 2.2 ≥ 門檻 + 過渡 1.85 > 窗光 1.3」→ 泛光開啟期間（night ≥ nightLo）霓虹任何時刻都過高通。
// 程式變體固定（v1b-rf-fix）：mid 以上 tier 全天都走 composer（白天 bloom pass 停用、只多 OutputPass 一次全螢幕），
//   材質永遠畫進 RT（NoToneMapping + Linear 變體），黃昏不會在越過門檻那一幀同步重編整城 shader。
// toneMapped: false 材質：用 keepUntoneMapped(material) 登記，composer 路徑時在材質內預先套 ACES 反函數，
//   OutputPass 套 ACES 後還原為原本不經 tone map 的外觀；同時 alpha 寫入標記讓高通略過（不因預補償的 HDR 值發光暈）。
//   scene.background（純色）與 fog 色在畫布直出時同樣不經 tone map：composer 路徑 render 期間暫換成反 ACES 值、結束還原。
//
// 對外 API：
//   loadPostFxPasses() → Promise<{ EffectComposer, RenderPass, UnrealBloomPass, OutputPass } | null>（動態 import three/addons；失敗 → null = 不建 composer）
//   createPostFx(renderer, scene, camera, { tier, THREE, passes, night })
//     → { render(), setTier(id), resize(), dispose(), info }
//     night：() → 0–1（main.js 傳 () => dayNight.night）；
//     info：{ tier, enabled, active, bloomOn, highPass, width, height, bloomWidth, bloomHeight, strength, threshold, smooth, sceneCalls }
//     （同一物件每幀原地更新；active = 本幀走 composer、bloomOn = 本幀泛光 pass 生效；
//      highPass = 'maxChannel' | 'luminance'（UnrealBloomPass 找不到 materialHighPassFilter → 退化並 console.warn 一次）；
//      sceneCalls = 場景本身的 draw call，不含 post pass）
//   keepUntoneMapped(material) → material：toneMapped:false 材質在 composer 路徑維持不套 ACES 的外觀
//   acesFilmic(rgb) / acesFilmicInverse(rgb)：three ACESFilmicToneMapping 與其反函數（純 JS，測試用；GLSL 由同一組常數產生）
//   postFxConfig(tier) → null（low：不建 composer）| { scale, samples }
//   bloomParams(night, out) → out = { strength, threshold, smooth }：夜間 / 黃昏明顯、白天 0；門檻 / 過渡寬隨 night 等比
//   bloomSize(w, h, scale) → { width, height }（drawing buffer 像素 × scale，至少 1）

export const POSTFX_TIERS = {
  low: null,
  mid: { scale: 0.5, samples: 2 }, // 半解析度泛光
  high: { scale: 1, samples: 4 }, // 全解析度泛光
  ultra: { scale: 1, samples: 4 },
};

export const BLOOM = {
  strength: 0.9, // 全夜強度
  radius: 0.55,
  threshold: 1.45, // 全夜門檻（最大色版，線性 HDR）；實際門檻 = threshold × max(night, nightLo)
  smooth: 0.4, // 全夜門檻過渡寬度（同樣乘 night）
  neonMax: 2.2, // 霓虹 emissive 上限（= neon.js NEON_NIGHT_MAX；霓虹亮度 = neonMax × night）
  nightLo: 0.2, // night 低於此值 → 強度 0（夕照仍強，門檻等比降低會讓受光表面發光暈）
  nightHi: 0.6, // night 達此值 → 全強度（night 0.45 已 ≥ 60%）
  eps: 0.005, // 強度低於此值停用 bloom pass
};
export const BLOOM_SKIP_ALPHA = 0.5; // keepUntoneMapped 材質在 RT 寫入的 alpha 標記（其餘不透明像素 alpha ≥ 1）

// 高通：最大色版門檻（取代 LuminosityHighPassShader 的 luminance；uniform 名稱相同，UnrealBloomPass 照常寫入）
export const HIGHPASS_FRAG = `uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
	vec4 texel = texture2D( tDiffuse, vUv );
	float v = max( texel.r, max( texel.g, texel.b ) );
	float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v ) * step( 0.75, texel.a );
	gl_FragColor = mix( vec4( defaultColor.rgb, defaultOpacity ), texel, alpha );
}`;

export function postFxConfig(tier) {
  const id = typeof tier === 'string' ? tier : tier && tier.id;
  if (id === 'low') return null;
  const c = POSTFX_TIERS[id] || POSTFX_TIERS.high;
  return { scale: c.scale, samples: c.samples };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function bloomParams(night, out = { strength: 0, threshold: BLOOM.threshold, smooth: BLOOM.smooth }) {
  const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0;
  const k = smoothstep(BLOOM.nightLo, BLOOM.nightHi, n);
  const s = Math.max(n, BLOOM.nightLo); // 門檻跟著 emissive（max × night）走，霓虹 / 窗光比例不變
  out.strength = BLOOM.strength * k;
  out.threshold = BLOOM.threshold * s;
  out.smooth = BLOOM.smooth * s;
  return out;
}

// ---------- ACES Filmic（three ACESFilmicToneMapping）與反函數 ----------
// 列優先（row-major）；GLSL mat3 為行優先，輸出時轉置
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
function inv3([[a, b, c], [d, e, f], [g, h, i]]) {
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
const ACES_IN_INV = inv3(ACES_IN);
const ACES_OUT_INV = inv3(ACES_OUT);
const mul3 = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
function fitInv(y) {
  const A = 1 - 0.983729 * y;
  const B = 0.0245786 - 0.432951 * y;
  const C = -(0.000090537 + 0.238081 * y);
  return (-B + Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A);
}
export function acesFilmic(rgb, exposure = 1) {
  return mul3(ACES_OUT, mul3(ACES_IN, rgb.map((c) => (c * exposure) / 0.6)).map(fit)).map(clamp01);
}
export function acesFilmicInverse(rgb, exposure = 1) {
  const v = mul3(ACES_OUT_INV, rgb).map(clamp01).map(fitInv);
  return mul3(ACES_IN_INV, v).map((c) => (Math.max(c, 0) * 0.6) / exposure);
}

const glslMat = (m) => `mat3( ${[0, 1, 2].map((j) => `vec3( ${m.map((r) => r[j].toFixed(7)).join(', ')} )`).join(', ')} )`;
// 共用 uniform：postfx.render 每幀寫入（active 1 = 本幀走 composer、OutputPass 會套 ACES）
export const UNTONEMAPPED = { active: { value: 0 }, exposure: { value: 1 } };
export const UNTONEMAPPED_DECL = 'uniform float postfxUntoned;\nuniform float postfxExposure;\n';
export const UNTONEMAPPED_APPLY = `#include <fog_fragment>
	if ( postfxUntoned > 0.5 ) {
		vec3 acesY = clamp( ${glslMat(ACES_OUT_INV)} * gl_FragColor.rgb, 0.0, 1.0 );
		vec3 acesA = 1.0 - 0.983729 * acesY;
		vec3 acesB = 0.0245786 - 0.432951 * acesY;
		vec3 acesC = -( 0.000090537 + 0.238081 * acesY );
		vec3 acesV = ( -acesB + sqrt( max( acesB * acesB - 4.0 * acesA * acesC, 0.0 ) ) ) / ( 2.0 * acesA );
		gl_FragColor.rgb = max( ${glslMat(ACES_IN_INV)} * acesV, 0.0 ) * ( 0.6 / postfxExposure );
		gl_FragColor.a = ${BLOOM_SKIP_ALPHA.toFixed(2)};
	}`;

// toneMapped: false 材質：composer 路徑（OutputPass 統一套 ACES）時預先套反函數，畫面與畫布直出（不套 ACES）一致。
// 只加兩個 float uniform，不加貼圖單元；畫布路徑（low tier / 無 composer）uniform = 0 → 原樣輸出
export function keepUntoneMapped(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    if (typeof prev === 'function') prev.call(material, shader, r);
    shader.uniforms.postfxUntoned = UNTONEMAPPED.active;
    shader.uniforms.postfxExposure = UNTONEMAPPED.exposure;
    shader.fragmentShader = UNTONEMAPPED_DECL + shader.fragmentShader.replace('#include <fog_fragment>', UNTONEMAPPED_APPLY);
  };
  material.customProgramCacheKey = () => 'postfx-untoned';
  material.userData.postfxUntoned = true;
  return material;
}

export function bloomSize(w, h, scale, out = { width: 1, height: 1 }) {
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  return out;
}

// 動態 import：main.js 第三方 import 只有 three（integration-p4），node 測試也不需 node_modules
export async function loadPostFxPasses() {
  try {
    const [a, b, c, d] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);
    return { EffectComposer: a.EffectComposer, RenderPass: b.RenderPass, UnrealBloomPass: c.UnrealBloomPass, OutputPass: d.OutputPass };
  } catch (err) {
    console.warn('[postfx] 載入 postprocessing 失敗，停用泛光：', err && err.message);
    return null;
  }
}

const ZERO = () => 0;
let warnedHighPass = false; // materialHighPassFilter 不存在的警告整個執行期只印一次

export function createPostFx(renderer, scene, camera, { tier = 'high', THREE, passes = {}, night = ZERO } = {}) {
  const { EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = passes || {};
  const canBuild = !!(EffectComposer && RenderPass && UnrealBloomPass && OutputPass);
  const nightOf = typeof night === 'function' ? night : ZERO;
  const info = {
    tier: null, enabled: false, active: false, bloomOn: false, highPass: null, width: 0, height: 0, bloomWidth: 0, bloomHeight: 0,
    strength: 0, threshold: BLOOM.threshold, smooth: BLOOM.smooth, sceneCalls: 0,
  };
  const params = { strength: 0, threshold: BLOOM.threshold, smooth: BLOOM.smooth };
  const aces = THREE.ACESFilmicToneMapping;
  const bgSave = [0, 0, 0];
  const fogSave = [0, 0, 0];
  const bsize = { width: 1, height: 1 };
  const size = new THREE.Vector2();
  let cfg = null;
  let composer = null;
  let bloom = null;
  let list = []; // 本模組建立的 pass（dispose 用）
  let lastW = -1; // 上次 resize 時的 canvas 像素尺寸 / pixelRatio（每幀比對，dpr 變化不發 resize 事件也能跟上）
  let lastH = -1;
  let lastPR = -1;
  let disposed = false;

  // 場景 draw call 探針：插在 RenderPass 之後，記錄 post pass 之前的 renderer.info 計數
  const probe = {
    enabled: true, needsSwap: false, clear: false, renderToScreen: false,
    setSize() {}, dispose() {},
    render(r) {
      info.sceneCalls = r.info.render.calls;
    },
  };

  function destroy() {
    for (const p of list) if (p && typeof p.dispose === 'function') p.dispose();
    if (composer && typeof composer.dispose === 'function') composer.dispose(); // 釋放兩張 render target 與 copy pass
    list = [];
    composer = null;
    bloom = null;
    info.enabled = false;
    info.active = false;
    info.bloomOn = false;
    info.highPass = null;
    UNTONEMAPPED.active.value = 0;
    info.bloomWidth = 0;
    info.bloomHeight = 0;
  }

  function build() {
    renderer.getSize(size);
    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(size.x * pr)), Math.max(1, Math.floor(size.y * pr)), {
      type: THREE.HalfFloatType, samples: cfg.samples,
    });
    composer = new EffectComposer(renderer, rt);
    const renderPass = new RenderPass(scene, camera);
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, BLOOM.radius, BLOOM.threshold);
    if (bloom.highPassUniforms && bloom.highPassUniforms.smoothWidth) bloom.highPassUniforms.smoothWidth.value = BLOOM.smooth;
    if (bloom.materialHighPassFilter) {
      bloom.materialHighPassFilter.fragmentShader = HIGHPASS_FRAG;
      bloom.materialHighPassFilter.needsUpdate = true;
      info.highPass = 'maxChannel';
    } else {
      // three 升版改名 → 退回 luminance 高通（霓虹 5 色有 4 色低於門檻），不得靜默
      info.highPass = 'luminance';
      if (!warnedHighPass) {
        warnedHighPass = true;
        console.warn('[postfx] UnrealBloomPass 找不到 materialHighPassFilter，泛光退回 luminance 高通（霓虹多半不發光暈）');
      }
    }
    const output = new OutputPass(); // tone mapping（renderer.toneMapping / exposure）+ sRGB 輸出
    list = [renderPass, bloom, output];
    composer.addPass(renderPass);
    composer.addPass(probe);
    composer.addPass(bloom);
    composer.addPass(output);
    info.enabled = true;
    resize();
  }

  function resize() {
    lastW = renderer.domElement ? renderer.domElement.width : -1;
    lastH = renderer.domElement ? renderer.domElement.height : -1;
    lastPR = renderer.getPixelRatio();
    renderer.getSize(size);
    info.width = Math.floor(size.x * lastPR);
    info.height = Math.floor(size.y * lastPR);
    if (!composer) return;
    composer.setPixelRatio(lastPR);
    composer.setSize(size.x, size.y); // 各 pass 以 drawing buffer 尺寸 setSize
    bloomSize(size.x * lastPR, size.y * lastPR, cfg.scale, bsize);
    bloom.setSize(bsize.width, bsize.height); // mid：泛光鏈改半解析度（合成時線性取樣放大）
    info.bloomWidth = bsize.width;
    info.bloomHeight = bsize.height;
  }

  function setTier(id) {
    if (disposed) return;
    const t = typeof id === 'string' ? id : id && id.id;
    const next = postFxConfig(t);
    info.tier = t || 'high';
    const same = next && cfg && next.scale === cfg.scale && next.samples === cfg.samples;
    cfg = next;
    if (same && composer) {
      resize();
      return;
    }
    destroy();
    if (cfg && canBuild) build(); // low（或 pass 載入失敗）：完全不建 composer
  }

  // 純色背景 / 霧色：暫換為反 ACES 值（OutputPass 套 ACES 後 = 原色），回傳是否已替換
  function swapColor(c, save, exposure) {
    if (!c || !c.isColor) return false;
    save[0] = c.r;
    save[1] = c.g;
    save[2] = c.b;
    const v = acesFilmicInverse(save, exposure);
    c.r = v[0];
    c.g = v[1];
    c.b = v[2];
    return true;
  }
  function restoreColor(c, save) {
    c.r = save[0];
    c.g = save[1];
    c.b = save[2];
  }

  function render() {
    bloomParams(nightOf(), params);
    info.strength = params.strength;
    info.threshold = params.threshold;
    info.smooth = params.smooth;
    if (!composer) {
      info.active = false;
      info.bloomOn = false;
      UNTONEMAPPED.active.value = 0;
      renderer.render(scene, camera);
      info.sceneCalls = renderer.info.render.calls;
      return;
    }
    // mid 以上全天走 composer（材質 program 變體固定為 RT 版本，黃昏不重編）；白天只停用 bloom pass
    const el = renderer.domElement;
    if ((el && (el.width !== lastW || el.height !== lastH)) || renderer.getPixelRatio() !== lastPR) resize();
    info.active = true;
    info.bloomOn = params.strength >= BLOOM.eps;
    bloom.enabled = info.bloomOn;
    bloom.strength = params.strength;
    bloom.threshold = params.threshold;
    if (bloom.highPassUniforms && bloom.highPassUniforms.smoothWidth) bloom.highPassUniforms.smoothWidth.value = params.smooth;
    const tone = aces === undefined || renderer.toneMapping === aces;
    const exposure = renderer.toneMappingExposure || 1;
    UNTONEMAPPED.active.value = tone ? 1 : 0;
    UNTONEMAPPED.exposure.value = exposure;
    const bg = tone && swapColor(scene.background, bgSave, exposure);
    const fog = tone && scene.fog && swapColor(scene.fog.color, fogSave, exposure);
    // composer 內多次 render 呼叫：關 autoReset 讓探針讀到整個場景（含陰影）的計數，結束後還原（例外時也還原）
    const ri = renderer.info;
    const auto = ri.autoReset;
    ri.autoReset = false;
    ri.reset();
    try {
      composer.render();
    } finally {
      ri.autoReset = auto;
      if (bg) restoreColor(scene.background, bgSave);
      if (fog) restoreColor(scene.fog.color, fogSave);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    destroy();
    cfg = null;
  }

  setTier(tier);
  return {
    render, setTier, resize, dispose, info,
    get composer() {
      return composer;
    },
  };
}
