// v1b-bloom 選擇性泛光 + 招牌加強 無頭驗證：node tools/test/v1b-bloom.mjs
// 不需 node_modules：postfx.js / neon.js 皆不 import three；composer 與各 pass 以假類別注入（計數建構 / setSize / dispose）。
// 驗：tier 對應開關與解析度（low 不建 composer、mid 半解析度、high 全解析度）、白天強度 0 且繞過 composer、夜間 / 黃昏明顯、
// resize / dpr 變化、dispose、draw call 不計 post pass、高通門檻分得開霓虹與窗光、招牌尺寸範圍、固定種子可重現、main.js 呼叫點。
// v1b-rf-fix：門檻隨 night 等比（霓虹 night 0.3–1 皆過高通）、mid+ 全天走 composer（program 變體固定）、
// toneMapped:false 材質 ACES 預補償、高通退化 console.warn + info.highPass、autoReset 例外還原。
// 任一斷言失敗 exit 1。
import { register } from 'node:module';
import fs from 'node:fs';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import fs from 'node:fs';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + fs.readFileSync(new URL(url), 'utf8') + ';' };
  }
  return next(url, context);
}`),
);

const root = new URL('../../', import.meta.url);
const P = await import(new URL('src/postfx.js', root));
const N = await import(new URL('src/neon.js', root));
const { buildings, surfaceRoads, getTerrain } = await import(new URL('src/citymodel.js', root));

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (ok) passed++;
  else failed++;
}

// ---------- 純邏輯：tier / 強度曲線 / 尺寸 ----------
{
  const c = (t) => P.postFxConfig(t);
  check('postFxConfig：low = null、mid 半解析度、high / ultra 全解析度、未知當 high',
    c('low') === null && c('mid').scale === 0.5 && c('high').scale === 1 && c('ultra').scale === 1 && c('xyz').scale === 1 && c({ id: 'mid' }).scale === 0.5);
  const s = (n) => P.bloomParams(n).strength;
  check('白天（night 0）泛光強度 0、night 0.01 仍 < eps', s(0) === 0 && s(0.01) < P.BLOOM.eps && s(NaN) === 0, `${s(0)} ${s(0.01)}`);
  check('黃昏（night 0.45）明顯（≥ 60% 全夜）、全夜 ≥ 0.8', s(0.45) >= 0.6 * s(1) && s(1) >= 0.8, `dusk ${s(0.45).toFixed(2)} night ${s(1).toFixed(2)}`);
  let mono = true;
  for (let n = 0; n < 1; n += 0.01) if (s(n + 0.01) < s(n) - 1e-12) mono = false;
  let thMono = true;
  for (let n = 0; n < 1; n += 0.01) if (P.bloomParams(n + 0.01).threshold < P.bloomParams(n).threshold - 1e-12) thMono = false;
  check('強度隨 night 單調不減；門檻與霓虹亮度同方向（隨 night 不減，全夜 = BLOOM.threshold）', mono && thMono && P.bloomParams(1).threshold === P.BLOOM.threshold);
  const out = { strength: 0, threshold: 0 };
  check('bloomParams 原地寫入 out（每幀不配置）', P.bloomParams(0.7, out) === out && out.strength > 0);
  const b = P.bloomSize(1920, 1080, 0.5);
  check('bloomSize：mid 半解析度、至少 1 px', b.width === 960 && b.height === 540 && P.bloomSize(1, 1, 0.5).width === 1);
}

// 高通（最大色版）：霓虹 / 車燈 / 警燈 > 夜間門檻，窗光 / 店面微光 < 門檻
{
  const lin = (hex) => [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const maxCh = (hex, k) => Math.max(...lin(hex)) * k;
  const th = P.bloomParams(1).threshold;
  const neon = N.NEON_COLORS.map((c) => maxCh(c, N.NEON_NIGHT_MAX));
  // v1b-rf-fix #1：霓虹 emissive = NEON_NIGHT_MAX × night，泛光開啟期間每一刻都要整段過高通（≥ 門檻 + 過渡寬）
  const pass = (n) => {
    const b = P.bloomParams(n);
    const sm = b.smooth === undefined ? P.BLOOM.smooth : b.smooth;
    return N.NEON_COLORS.map((c) => maxCh(c, N.NEON_NIGHT_MAX * n)).every((v) => v >= b.threshold + sm);
  };
  for (const n of [0.3, 0.5, 0.7, 1.0]) {
    const b = P.bloomParams(n);
    check(`night ${n}：泛光開啟且霓虹 5 色最大色版皆過門檻 + 過渡寬`, b.strength >= P.BLOOM.eps && pass(n),
      `neon ${(N.NEON_NIGHT_MAX * n).toFixed(2)} th ${b.threshold.toFixed(2)}+${(b.smooth ?? P.BLOOM.smooth).toFixed(2)} str ${b.strength.toFixed(2)}`);
  }
  let sweep = true;
  let win = true;
  for (let n = 0; n <= 1.0001; n += 0.01) {
    const b = P.bloomParams(n);
    if (b.strength >= P.BLOOM.eps && !pass(n)) sweep = false;
    if (b.strength >= P.BLOOM.eps && maxCh('#ffffff', 1.3 * n) >= b.threshold) win = false;
  }
  check('night 0–1 掃描：泛光強度 ≥ eps 的每一刻霓虹皆過高通、窗光 1.3×night 皆不過', sweep && win);
  check('BLOOM.neonMax 與 neon.js NEON_NIGHT_MAX 一致', P.BLOOM.neonMax === N.NEON_NIGHT_MAX);
  check('霓虹 5 色（emissive 2.2）最大色版皆超過夜間門檻 + 一半過渡寬', neon.every((v) => v >= th + P.BLOOM.smooth / 2), neon.map((v) => v.toFixed(2)).join(' '));
  check('車頭燈 2.0 / 警燈 6 / 直升機燈 4 超過門檻', [maxCh('#fff4d8', 2), maxCh('#ff2020', 6), maxCh('#2050ff', 4)].every((v) => v > th));
  check('窗光 1.3、店面微光 1.2（白色上限）不發光暈', maxCh('#ffffff', 1.3) < th && maxCh('#ffffff', 1.2) < th, `th ${th}`);
  check('高通 shader 改用最大色版、保留 UnrealBloomPass uniform 名', /max\( texel\.r, max\( texel\.g, texel\.b \) \)/.test(P.HIGHPASS_FRAG) &&
    ['luminosityThreshold', 'smoothWidth', 'defaultColor', 'defaultOpacity', 'tDiffuse'].every((u) => P.HIGHPASS_FRAG.includes(u)));
}

// ---------- 假 renderer / THREE / passes ----------
const log = { composer: 0, rt: 0, render: 0, bloom: 0, output: 0, disposed: [], composerRender: 0 };
class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
}
class WebGLRenderTarget {
  constructor(w, h, o = {}) {
    log.rt++;
    this.width = w;
    this.height = h;
    this.samples = o.samples || 0;
    this.type = o.type;
  }
  setSize(w, h) {
    this.width = w;
    this.height = h;
  }
  clone() {
    return new WebGLRenderTarget(this.width, this.height, { samples: this.samples, type: this.type });
  }
  dispose() {
    log.disposed.push('rt');
  }
}
const THREE = { Vector2, WebGLRenderTarget, HalfFloatType: 1016, ACESFilmicToneMapping: 4 };
class EffectComposer {
  constructor(renderer, rt) {
    log.composer++;
    this.renderer = renderer;
    this.renderTarget1 = rt;
    this.renderTarget2 = rt.clone();
    this.passes = [];
    this._pr = 1;
  }
  addPass(p) {
    this.passes.push(p);
  }
  setPixelRatio(pr) {
    this._pr = pr;
  }
  setSize(w, h) {
    const ew = w * this._pr;
    const eh = h * this._pr;
    this.renderTarget1.setSize(ew, eh);
    this.renderTarget2.setSize(ew, eh);
    for (const p of this.passes) p.setSize(ew, eh);
  }
  render() {
    log.composerRender++;
    for (const p of this.passes) if (p.enabled) p.render(this.renderer);
  }
  dispose() {
    this.renderTarget1.dispose();
    this.renderTarget2.dispose();
    log.disposed.push('composer');
  }
}
class RenderPass {
  constructor(scene, camera) {
    log.render++;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
  }
  setSize() {}
  render(r) {
    r.render(this.scene, this.camera);
  }
  dispose() {
    log.disposed.push('renderPass');
  }
}
class UnrealBloomPass {
  constructor(res, strength, radius, threshold) {
    log.bloom++;
    this.enabled = true;
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    this.highPassUniforms = { smoothWidth: { value: 0.01 }, luminosityThreshold: { value: threshold } };
    this.materialHighPassFilter = { fragmentShader: 'luminance', needsUpdate: false };
    this.w = 0;
    this.h = 0;
  }
  setSize(w, h) {
    this.w = w;
    this.h = h;
  }
  render(r) {
    r.info.render.calls += 11; // 高通 + 5 級模糊 × 2 + 合成
  }
  dispose() {
    log.disposed.push('bloom');
  }
}
class OutputPass {
  constructor() {
    log.output++;
    this.enabled = true;
  }
  setSize() {}
  render(r) {
    r.info.render.calls += 1;
  }
  dispose() {
    log.disposed.push('output');
  }
}
const passes = { EffectComposer, RenderPass, UnrealBloomPass, OutputPass };
const SCENE_CALLS = 137;
function makeRenderer(w = 1280, h = 720, pr = 1.5) {
  const r = {
    w, h, pr, direct: 0,
    domElement: { width: Math.floor(w * pr), height: Math.floor(h * pr) },
    toneMapping: 4, toneMappingExposure: 1,
    info: { autoReset: true, render: { calls: 0 }, reset() { this.render.calls = 0; } },
    getSize(v) { return v.set(r.w, r.h); },
    getPixelRatio() { return r.pr; },
    setPixelRatio(p) { r.pr = p; r.domElement.width = Math.floor(r.w * p); r.domElement.height = Math.floor(r.h * p); },
    setSize(a, b) { r.w = a; r.h = b; r.domElement.width = Math.floor(a * r.pr); r.domElement.height = Math.floor(b * r.pr); },
    render() {
      if (r.info.autoReset) r.info.reset();
      r.info.render.calls += SCENE_CALLS;
      r.direct++;
    },
  };
  return r;
}
const scene = {};
const camera = {};
const reset = () => Object.assign(log, { composer: 0, rt: 0, render: 0, bloom: 0, output: 0, disposed: [], composerRender: 0 });

// low：完全不建 composer
{
  reset();
  const r = makeRenderer();
  const fx = P.createPostFx(r, scene, camera, { tier: 'low', THREE, passes, night: () => 1 });
  fx.render();
  check('low：不建 composer / render target / 任何 pass，夜間也直接 renderer.render', log.composer + log.rt + log.render + log.bloom + log.output === 0 && fx.composer === null && r.direct === 1 && !fx.info.enabled && !fx.info.active);
  check('low：draw call = 場景本身', fx.info.sceneCalls === SCENE_CALLS);
  fx.dispose();
}

// mid / high：解析度、MSAA、shader、白天繞過、夜間生效
let nightV = 0;
for (const [tier, scale] of [['mid', 0.5], ['high', 1], ['ultra', 1]]) {
  reset();
  nightV = 0;
  const r = makeRenderer(1280, 720, 1.5);
  const fx = P.createPostFx(r, scene, camera, { tier, THREE, passes, night: () => nightV });
  const comp = fx.composer;
  const bl = comp && comp.passes.find((p) => p instanceof UnrealBloomPass);
  check(`${tier}：建 1 composer（RenderPass → 探針 → Bloom → Output）、HalfFloat + MSAA`,
    log.composer === 1 && comp.passes.length === 4 && comp.passes[0] instanceof RenderPass && comp.passes[3] instanceof OutputPass &&
    comp.renderTarget1.type === THREE.HalfFloatType && comp.renderTarget1.samples === P.POSTFX_TIERS[tier].samples);
  check(`${tier}：泛光解析度 = drawing buffer × ${scale}`, bl.w === Math.round(1920 * scale) && bl.h === Math.round(1080 * scale) && fx.info.bloomWidth === bl.w,
    `${bl.w}×${bl.h}`);
  check(`${tier}：高通換成最大色版、smoothWidth = BLOOM.smooth`, bl.materialHighPassFilter.fragmentShader === P.HIGHPASS_FRAG && bl.materialHighPassFilter.needsUpdate && bl.highPassUniforms.smoothWidth.value === P.BLOOM.smooth);
  fx.render();
  // v1b-rf-fix #2：白天也走 composer（材質永遠畫進 RT → program 變體固定），只停用 bloom pass；白天 post 成本 = OutputPass 1 次
  check(`${tier}：白天強度 0 → 仍走 composer、bloom pass 停用、白天 post draw call 僅 OutputPass 1`,
    log.composerRender === 1 && r.direct === 1 && fx.info.active && fx.info.bloomOn === false && bl.enabled === false && fx.info.strength === 0 &&
    r.info.render.calls === SCENE_CALLS + 1, `total ${r.info.render.calls}`);
  nightV = 1;
  fx.render();
  check(`${tier}：夜間走 composer、bloom 強度 / 門檻寫入`, log.composerRender === 2 && fx.info.active && bl.enabled && bl.strength === P.bloomParams(1).strength && bl.threshold === P.bloomParams(1).threshold);
  {
    // 日夜掃描：每一幀都經 composer（渲染目標不在 RT / 畫布間切換 → 越過門檻那一幀不重編 shader）
    const c0 = log.composerRender;
    const d0 = r.direct;
    let allActive = true;
    for (let i = 0; i <= 20; i++) {
      nightV = i / 20;
      fx.render();
      if (!fx.info.active) allActive = false;
    }
    check(`${tier}：night 0→1 掃描 21 幀全部經 composer（無畫布直出幀）`, allActive && log.composerRender - c0 === 21 && r.direct - d0 === 21);
    nightV = 0.3;
    fx.render();
    check(`${tier}：黃昏 night 0.3 門檻 / 過渡寬寫入 bloom（霓虹可過）`, bl.enabled && bl.threshold === P.bloomParams(0.3).threshold && bl.highPassUniforms.smoothWidth.value === P.bloomParams(0.3).smooth);
    nightV = 0;
    fx.render();
    const dayUntoned = P.UNTONEMAPPED && P.UNTONEMAPPED.active.value;
    nightV = 1;
    fx.render();
    const nightUntoned = P.UNTONEMAPPED && P.UNTONEMAPPED.active.value;
    check(`${tier}：toneMapped:false 預補償旗標白天 / 夜間一致（皆 1，不在門檻處跳變）`, dayUntoned === 1 && nightUntoned === 1);
    check(`${tier}：高通為最大色版（info.highPass = maxChannel）`, fx.info.highPass === 'maxChannel');
  }
  check(`${tier}：draw call 不計 post pass（探針 = 場景 ${SCENE_CALLS}）、autoReset 還原`, fx.info.sceneCalls === SCENE_CALLS && r.info.render.calls > SCENE_CALLS && r.info.autoReset === true,
    `scene ${fx.info.sceneCalls} total ${r.info.render.calls}`);
  nightV = 0.45;
  fx.render();
  check(`${tier}：黃昏（night 0.45）bloom 明顯、霓虹過門檻`, fx.info.active && bl.strength > 0.6 * P.BLOOM.strength && N.NEON_NIGHT_MAX * 0.45 >= bl.threshold + P.BLOOM.smooth * 0.45);

  // resize：視窗縮放 / dpr 變化
  r.setSize(800, 600);
  fx.resize();
  check(`${tier}：resize 後 render target / 泛光跟上新尺寸`, comp.renderTarget1.width === 1200 && comp.renderTarget2.height === 900 && bl.w === Math.round(1200 * scale) && bl.h === Math.round(900 * scale));
  r.setPixelRatio(2); // dpr 變化（無 resize 事件）
  nightV = 1;
  fx.render();
  check(`${tier}：dpr 變化未呼叫 resize，下一幀 render 自動跟上`, comp.renderTarget1.width === 1600 && bl.w === Math.round(1600 * scale) && fx.info.width === 1600, `${comp.renderTarget1.width}`);
  const setSizes = [];
  const orig = bl.setSize.bind(bl);
  bl.setSize = (w, h) => (setSizes.push([w, h]), orig(w, h));
  for (let i = 0; i < 10; i++) fx.render();
  check(`${tier}：尺寸不變時不重複 setSize`, setSizes.length === 0);

  // dispose
  fx.dispose();
  const d = log.disposed;
  check(`${tier}：dispose 釋放 composer + 2 render target + RenderPass / Bloom / Output`,
    ['composer', 'renderPass', 'bloom', 'output'].every((k) => d.filter((x) => x === k).length === 1) && d.filter((x) => x === 'rt').length === 2 && fx.composer === null, d.join(','));
  const n = d.length;
  fx.dispose();
  fx.setTier('high');
  check(`${tier}：dispose 重複呼叫 / 之後 setTier 為 no-op、render 退回直接渲染`, d.length === n && fx.composer === null && (fx.render(), r.direct > 0) && log.composer === 1);
}

// pass 載入失敗（passes = null）：任何 tier 都不建 composer、照常渲染
{
  reset();
  const r = makeRenderer();
  const fx = P.createPostFx(r, scene, camera, { tier: 'high', THREE, passes: null, night: () => 1 });
  fx.render();
  check('passes = null：high 也不建 composer、直接 renderer.render', log.composer + log.rt === 0 && fx.composer === null && r.direct === 1 && fx.info.sceneCalls === SCENE_CALLS);
  // 無 three（外包容器）→ null；有 three（宿主）→ 含 composer / pass 建構子的物件；兩者都不得丟例外
  let lp, lpErr = null;
  try { lp = await P.loadPostFxPasses(); } catch (e) { lpErr = e; }
  check('loadPostFxPasses 為 async 匯出（無 three → null、有 three → passes 物件，不丟例外）',
    typeof P.loadPostFxPasses === 'function' && lpErr === null && (lp === null || (typeof lp === 'object' && Object.keys(lp).length > 0)),
    lpErr ? String(lpErr) : (lp === null ? 'null' : Object.keys(lp).join(',')));
  fx.dispose();
}

// setTier：high → low 釋放、low → mid 重建、同級不重建
{
  reset();
  const r = makeRenderer();
  const fx = P.createPostFx(r, scene, camera, { tier: 'high', THREE, passes, night: () => 1 });
  const c0 = fx.composer;
  fx.setTier('ultra');
  check('setTier high → ultra（同設定）不重建 composer', fx.composer === c0 && log.composer === 1);
  fx.setTier('low');
  check('setTier → low：composer 釋放、不再走 post、toneMapped:false 預補償關閉（畫布直出本來就不套 ACES）',
    fx.composer === null && log.disposed.includes('composer') && (fx.render(), !fx.info.active) && P.UNTONEMAPPED && P.UNTONEMAPPED.active.value === 0);
  fx.setTier('mid');
  const bl = fx.composer && fx.composer.passes.find((p) => p instanceof UnrealBloomPass);
  check('setTier low → mid：重建 composer 且為半解析度', log.composer === 2 && bl && bl.w === Math.round(r.domElement.width * 0.5));
  fx.dispose();
}

// v1b-rf-fix #2 / #3：全天走 composer 時，純色天空 / 霧色（畫布直出不經 tone map）在 RenderPass 期間換成反 ACES 值、結束還原
{
  const col = (r, g, b) => ({ isColor: true, r, g, b });
  const sc = { background: col(0.27, 0.56, 0.89), fog: { color: col(0.27, 0.56, 0.89) } };
  const seen = [];
  class SpyRenderPass extends RenderPass {
    render(r) {
      seen.push([sc.background.r, sc.background.g, sc.background.b, sc.fog.color.b]);
      super.render(r);
    }
  }
  const r = makeRenderer();
  const fx = P.createPostFx(r, sc, camera, { tier: 'high', THREE, passes: { ...passes, RenderPass: SpyRenderPass }, night: () => 0 });
  fx.render();
  const inv = typeof P.acesFilmicInverse === 'function' ? P.acesFilmicInverse([0.27, 0.56, 0.89]) : [];
  const back = typeof P.acesFilmic === 'function' ? P.acesFilmic(inv) : [];
  check('白天 composer：天空 / 霧色 render 期間 = 反 ACES（OutputPass 後 = 原色）、render 後還原',
    seen.length === 1 && Math.abs(seen[0][0] - inv[0]) < 1e-9 && Math.abs(seen[0][3] - inv[2]) < 1e-9 && Math.abs(back[2] - 0.89) < 2e-3 &&
    sc.background.r === 0.27 && sc.background.b === 0.89 && sc.fog.color.b === 0.89, seen.length ? seen[0].map((v) => v.toFixed(3)).join(',') : 'no render');
  fx.dispose();
}

// v1b-rf-fix #4：materialHighPassFilter 不存在 → console.warn 一次 + info.highPass = 'luminance'（不得靜默）
{
  class BloomNoFilter extends UnrealBloomPass {
    constructor(...a) {
      super(...a);
      delete this.materialHighPassFilter;
    }
  }
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let fx1, fx2;
  try {
    fx1 = P.createPostFx(makeRenderer(), scene, camera, { tier: 'high', THREE, passes: { ...passes, UnrealBloomPass: BloomNoFilter }, night: () => 1 });
    fx2 = P.createPostFx(makeRenderer(), scene, camera, { tier: 'mid', THREE, passes: { ...passes, UnrealBloomPass: BloomNoFilter }, night: () => 1 });
    fx1.render();
  } finally {
    console.warn = ow;
  }
  const hp = warns.filter((w) => w.includes('materialHighPassFilter'));
  check('高通退化：console.warn 一次（兩個 composer 也只一次）、info.highPass = luminance', hp.length === 1 && fx1.info.highPass === 'luminance' && fx2.info.highPass === 'luminance',
    `warn ${hp.length} highPass ${fx1.info.highPass}`);
  fx1.dispose();
  fx2.dispose();
}

// 🔵 autoReset：composer.render 丟例外（context lost）後仍還原
{
  class ThrowPass extends OutputPass {
    render() {
      throw new Error('context lost');
    }
  }
  const r = makeRenderer();
  const fx = P.createPostFx(r, scene, camera, { tier: 'high', THREE, passes: { ...passes, OutputPass: ThrowPass }, night: () => 1 });
  let threw = false;
  try { fx.render(); } catch { threw = true; }
  check('composer.render 例外後 renderer.info.autoReset 還原', threw && r.info.autoReset === true);
  fx.dispose();
}

// v1b-rf-fix #3：toneMapped:false 材質（建物名稱牌、計程車頂燈）在 composer 路徑預補償 ACES，外觀與畫布直出一致
{
  // three ACESFilmicToneMapping 常數（tonemapping_pars_fragment；列優先），獨立於 postfx.js 驗 GLSL 反矩陣
  const IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
  const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
  const src = P.UNTONEMAPPED_APPLY || '';
  const mats = [...src.matchAll(/mat3\(([^;]*?\) )\)/g)].map((m) => [...m[1].matchAll(/-?\d+\.\d+/g)].map((x) => +x[0]));
  // GLSL mat3(col0, col1, col2) → 列優先 M[i][j] = cols[j][i]
  const rowMajor = (v) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => v[j * 3 + i]));
  const mm = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  const isI = (m) => m.every((r, i) => r.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-5));
  check('GLSL 反矩陣 × three ACES 輸出 / 輸入矩陣 = 單位矩陣', mats.length === 2 && isI(mm(rowMajor(mats[0]), OUT)) && isI(mm(rowMajor(mats[1]), IN)));
  const lin = (hex) => [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  let worst = 0;
  let worstNeutral = 0;
  const fwdInv = typeof P.acesFilmic === 'function' && typeof P.acesFilmicInverse === 'function';
  for (const hex of ['#ffffff', '#f2f2f2', '#2d3136', '#111111', '#000000', '#808080', '#f5c518']) { // 名稱牌字 / 底、計程車黃 / 黑字（ACES 色域外的高飽和色無解）
    if (!fwdInv) break;
    const c = lin(hex);
    const back = P.acesFilmic(P.acesFilmicInverse(c));
    const e = Math.max(...back.map((v, i) => Math.abs(v - c[i])));
    worst = Math.max(worst, e);
    if (c[0] === c[1] && c[1] === c[2]) worstNeutral = Math.max(worstNeutral, e);
  }
  check('ACES(反 ACES(c)) ≈ c：灰階 / 白字誤差 < 0.002、招牌色（含計程車黃）< 0.06', fwdInv && worstNeutral < 0.002 && worst < 0.06,
    `neutral ${worstNeutral.toFixed(4)} worst ${worst.toFixed(4)}`);
  const white = fwdInv ? P.acesFilmicInverse([1, 1, 1]) : [0, 0, 0];
  check('白字預補償值 > 1（反之只得 ACES(1) = 0.76）且以 alpha 標記排除高通（不發光暈）',
    white[0] > 1 && P.BLOOM_SKIP_ALPHA < 0.75 && /\* step\( 0\.75, texel\.a \)/.test(P.HIGHPASS_FRAG) && src.includes(`gl_FragColor.a = ${(P.BLOOM_SKIP_ALPHA ?? 0).toFixed(2)}`));
  const mat = { userData: {}, onBeforeCompile: null };
  const ok = typeof P.keepUntoneMapped === 'function' && P.keepUntoneMapped(mat) === mat;
  const shader = { uniforms: {}, fragmentShader: 'void main() {\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n#include <fog_fragment>\n}' };
  if (ok) mat.onBeforeCompile(shader);
  check('keepUntoneMapped：fog 之後注入、共用 uniform、固定 program cache key、不加 sampler',
    ok && shader.uniforms.postfxUntoned === P.UNTONEMAPPED.active && shader.uniforms.postfxExposure === P.UNTONEMAPPED.exposure &&
    shader.fragmentShader.indexOf('#include <fog_fragment>') < shader.fragmentShader.indexOf('postfxUntoned > 0.5') &&
    !/sampler2D/.test(shader.fragmentShader) && mat.customProgramCacheKey() === 'postfx-untoned');
  const bsrc = fs.readFileSync(new URL('src/buildings.js', root), 'utf8');
  const vsrc = fs.readFileSync(new URL('src/vehicle.js', root), 'utf8');
  check('建物名稱牌、計程車頂燈（toneMapped:false）皆經 keepUntoneMapped',
    /keepUntoneMapped\(new THREE\.MeshBasicMaterial\(\{ map: atlas\.textures\[a\], toneMapped: false \}\)\)/.test(bsrc) &&
    /taxiSignMat = keepUntoneMapped\(new THREE\.MeshBasicMaterial\(/.test(vsrc) &&
    (bsrc.match(/toneMapped: false/g) || []).length === 1 && (vsrc.match(/toneMapped: false/g) || []).length === 1);
}

// ---------- 招牌尺寸 ----------
const terrain = getTerrain();
const SEED = 20261018;
const opts = { roads: surfaceRoads, terrain, seed: SEED };
const signs = N.placeNeonSigns(buildings, opts);
const W = (s) => Math.hypot(s.corners[1][0] - s.corners[0][0], s.corners[1][2] - s.corners[0][2]);
const H = (s) => s.corners[3][1] - s.corners[0][1];
const of = (k) => signs.filter((s) => s.kind === k);
const range = (list, f) => list.reduce((a, s) => [Math.min(a[0], f(s)), Math.max(a[1], f(s))], [Infinity, -Infinity]).map((v) => v.toFixed(2)).join('–');
const eps = 1e-6;
{
  const shop = of('shop');
  const blade = of('blade');
  const roof = of('roof');
  check('店面帶招牌寬 2.5–5 m', shop.length > 0 && shop.every((s) => W(s) >= 2.5 - eps && W(s) <= 5 + eps), `${shop.length} 面 ${range(shop, W)} m`);
  check('直立招牌高 3–6 m（外伸 0.8–1.3 m）', blade.length > 0 && blade.every((s) => H(s) >= 3 - eps && H(s) <= 6 + eps && W(s) >= 0.8 - eps && W(s) <= 1.3 + eps), `${blade.length} 面 ${range(blade, H)} m`);
  check('直立招牌高度有變化（非全為上下限）', blade.some((s) => H(s) > 3.5 && H(s) < 5.5));
  check('樓頂招牌寬 ≥ 8 m、高 ≤ 4.8 m、平均寬 ≥ 10 m（較 V1 6–18 m / ×0.5 醒目）',
    roof.length > 0 && roof.every((s) => W(s) >= 8 - eps && H(s) <= N.SIGN_SIZE.roofH + eps) && roof.reduce((a, s) => a + W(s), 0) / roof.length >= 10, `${roof.length} 面 ${range(roof, W)} m`);
  check('招牌總數維持 V1 規模（300–MAX_SIGNS、四類皆有）', signs.length >= 300 && signs.length <= N.MAX_SIGNS && ['shop', 'blade', 'roof', 'side'].every((k) => of(k).length > 0), `${signs.length}`);
  const strip = (list) => JSON.stringify(list.map(({ wall, ...s }) => s));
  check('固定種子可重現（兩次擺放完全相同）', strip(N.placeNeonSigns(buildings, opts)) === strip(signs));
  check('不同種子結果不同', strip(N.placeNeonSigns(buildings, { ...opts, seed: SEED + 7 })) !== strip(signs));
  const tris = signs.reduce((a, s) => a + s.tris, 0);
  check('三角形仍 ≤ 20000（單一 mesh）', tris <= 20000, `${tris}`);
}
check('白天不變亮：NEON_NIGHT_MAX 仍 2.2（emissive = max × night，白天 0）', N.NEON_NIGHT_MAX === 2.2);

// ---------- main.js 呼叫點（源碼文字檢查；main.js import three 無頭跑不動） ----------
{
  const src = fs.readFileSync(new URL('src/main.js', root), 'utf8');
  check('main.js：createPostFx 建立（passes = await loadPostFxPasses()、night 取 dayNight.night）、第三方 import 仍只有 three',
    /createPostFx\(renderer, scene, camera, \{[^}]*tier[^}]*passes: await loadPostFxPasses\(\)[^}]*dayNight\.night/.test(src) && !/from 'three\/addons/.test(src));
  check('main.js：渲染改走 postfx.render()、draw call 取 postfx.info.sceneCalls、不再直接 renderer.render(scene, camera)',
    src.includes('postfx.render();') && src.includes('drawCalls = postfx.info.sceneCalls') && !src.includes('renderer.render(scene, camera)'));
  check('main.js：onResize 呼叫 postfx.resize()、applyQuality 呼叫 postfx.setTier(tier)', /onResize = \(\) => \{[\s\S]*?postfx\.resize\(\);[\s\S]*?\};/.test(src) && /applyQuality = \(\) => \{[\s\S]*?postfx\.setTier\(tier\);/.test(src));
  check('main.js：toneMapping 設定保留（OutputPass 沿用 renderer.toneMapping）', src.includes('renderer.toneMapping = THREE.ACESFilmicToneMapping;'));
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
