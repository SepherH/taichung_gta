#!/usr/bin/env node
// CS6（§23.2）鏡頭與視角設定無頭驗證：
//   settings：camWalkView / camDriveView 兩鍵（預設 1、0–2 整數正規化、舊存檔缺鍵給預設、存讀往返、reset）、靈敏度 0.3–3.0 / invertY 沿用
//   camera：步行 / 駕駛 V 三段循環、上下車段位各自記憶、setViews / getViews / cycleView / onViewChange（同幀最多一次）、
//     速度拉遠（平滑、66 km/h ≈ +0.5 m）、公車 / 垃圾車 / 機車比例、滾輪微調不改段位
//   input：反轉 Y（滑鼠 / 觸控）與靈敏度倍率；actions：phone 取消預留（T）並列入說明表、既有鍵位不變
//   menu：設定頁兩列（在反轉 Y 後）、數值 segment 高亮、點選寫回設定、設定改變（V 鍵寫回）後選單同步
// 用法：node tools/test/p6-cs6.mjs（任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n）
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const j = JSON.stringify;

// ---------- 最小 DOM 替身（同 menu.mjs 的子集） ----------
class Listeners {
  constructor() {
    this._l = {};
  }
  addEventListener(t, fn) {
    (this._l[t] ||= []).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this._l[t];
    if (a) this._l[t] = a.filter((f) => f !== fn);
  }
  dispatchEvent(e) {
    for (const fn of (this._l[e.type] || []).slice()) fn(e);
    return !e.defaultPrevented;
  }
}
class FakeEl extends Listeners {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._cls = new Set();
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.hidden = false;
    this._text = '';
    this.value = '';
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._cls.add(x)),
      remove: (...c) => c.forEach((x) => self._cls.delete(x)),
      toggle: (c, on) => {
        const v = on === undefined ? !self._cls.has(c) : !!on;
        if (v) self._cls.add(c);
        else self._cls.delete(c);
        return v;
      },
      contains: (c) => self._cls.has(c),
    };
  }
  get className() {
    return [...this._cls].join(' ');
  }
  set className(v) {
    this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get textContent() {
    return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this.children.forEach((c) => typeof c !== 'string' && (c.parentNode = null));
    this.children = [];
    this._text = String(v);
  }
  appendChild(c) {
    if (typeof c !== 'string') {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
    }
    this.children.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  get clientWidth() {
    return 800;
  }
  get clientHeight() {
    return 500;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 500 };
  }
  getContext() {
    return new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 12 }) : () => {}), set: () => true });
  }
  setPointerCapture() {}
  focus() {
    doc.activeElement = this;
  }
  scrollIntoView() {}
  click() {
    this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  }
  *walk() {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      yield c;
      yield* c.walk();
    }
  }
  querySelector(sel) {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase());
    for (const e of this.walk()) if (tags.includes(e.tagName)) return e;
    return null;
  }
  findClass(c) {
    for (const e of this.walk()) if (e._cls.has(c)) return e;
    return null;
  }
  findAllClass(c) {
    return [...this.walk()].filter((e) => e._cls.has(c));
  }
}
const doc = Object.assign(new Listeners(), {
  createElement: (t) => new FakeEl(t),
  fullscreenEnabled: false,
  fullscreenElement: null,
  documentElement: new FakeEl('html'),
  activeElement: null,
  pointerLockElement: null,
});
globalThis.document = doc;

const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

// ======================= settings（§23.2 兩鍵） =======================
const { createSettings, SETTINGS_SCHEMA, SETTINGS_KEY, normalizeSetting } = await import('../../src/core/settings.js');
{
  const w = SETTINGS_SCHEMA.camWalkView;
  const d = SETTINGS_SCHEMA.camDriveView;
  check('settings：camWalkView / camDriveView = number 0–2 step 1 預設 1',
    [w, d].every((s) => s && s.type === 'number' && s.min === 0 && s.max === 2 && s.step === 1 && s.default === 1));
  check('settings：label 步行鏡頭距離 / 駕駛鏡頭距離', w.label === '步行鏡頭距離' && d.label === '駕駛鏡頭距離');
  const norm = [[1.4, 1], [1.6, 2], [5, 2], [-3, 0], [0, 0], [2, 2]].map(([v, want]) => normalizeSetting('camWalkView', v) === want);
  check('settings：段位正規化 1.4→1、1.6→2、5→2、−3→0', norm.every(Boolean));
  check('settings：段位非法值 \'1\' / NaN / null / true → undefined',
    ['1', NaN, null, true, undefined].every((v) => normalizeSetting('camDriveView', v) === undefined));
  check('settings：靈敏度沿用 lookSensMouse / lookSensTouch 0.3–3.0 預設 1.0、invertY 預設 false（不另開 lookSens）',
    ['lookSensMouse', 'lookSensTouch'].every((k) => SETTINGS_SCHEMA[k].min === 0.3 && SETTINGS_SCHEMA[k].max === 3 && SETTINGS_SCHEMA[k].step === 0.1 && SETTINGS_SCHEMA[k].default === 1) &&
      SETTINGS_SCHEMA.invertY.default === false && !('lookSens' in SETTINGS_SCHEMA));

  // 舊存檔（Phase 5 之前，無兩鍵）→ 預設 1，其他鍵照讀
  const old = createSettings({ storage: fakeStorage({ [SETTINGS_KEY]: j({ quality: 'low', lookSensMouse: 2.2, invertY: true }) }) });
  check('settings：舊存檔缺鍵 → camWalkView / camDriveView = 1，既有鍵保留',
    old.get('camWalkView') === 1 && old.get('camDriveView') === 1 && old.get('quality') === 'low' && old.get('lookSensMouse') === 2.2 && old.get('invertY') === true);
  const none = createSettings({ storage: fakeStorage() });
  check('settings：全新（無存檔）→ 兩鍵 = 1', none.get('camWalkView') === 1 && none.get('camDriveView') === 1);
  const bad = createSettings({ storage: fakeStorage({ [SETTINGS_KEY]: j({ camWalkView: '2', camDriveView: 7.2 }) }) });
  check('settings：存檔內段位字串 → 預設 1、超出 → clamp 2', bad.get('camWalkView') === 1 && bad.get('camDriveView') === 2);

  // 存讀往返
  const st = fakeStorage();
  const s = createSettings({ storage: st });
  const notes = [];
  s.subscribe((k, v) => notes.push([k, v]));
  const ok = s.set('camWalkView', 2) && s.set('camDriveView', 0) && s.set('lookSensTouch', 2.5) && s.set('invertY', true);
  const saved = JSON.parse(st.m.get(SETTINGS_KEY));
  check('settings：set 兩鍵回 true、寫入 tcgta.settings.v1', ok && saved.camWalkView === 2 && saved.camDriveView === 0 && saved.lookSensTouch === 2.5 && saved.invertY === true);
  check('settings：subscribe 收到段位變更', j(notes.slice(0, 2)) === j([['camWalkView', 2], ['camDriveView', 0]]));
  check('settings：set 字串段位回 false 且不改值', s.set('camWalkView', '1') === false && s.get('camWalkView') === 2);
  const s2 = createSettings({ storage: st });
  check('settings：重新載入讀回段位 / 靈敏度 / 反轉 Y', s2.get('camWalkView') === 2 && s2.get('camDriveView') === 0 && s2.get('lookSensTouch') === 2.5 && s2.get('invertY') === true);
  s2.reset();
  check('settings：reset() 兩鍵回 1', s2.get('camWalkView') === 1 && s2.get('camDriveView') === 1 && JSON.parse(st.m.get(SETTINGS_KEY)).camWalkView === 1);
}

// ======================= actions（phone 取消預留、既有鍵位不變） =======================
const { ACTIONS, KEYMAP_HELP, TOUCH_HELP, actionForKey } = await import('../../src/core/actions.js');
{
  check('actions：phone = KeyT、不再 reserved', ACTIONS.phone.keys.join() === 'KeyT' && !ACTIONS.phone.reserved);
  check('actions：既有鍵位不變（V 鏡頭、Q 武器 / 駕駛電台、1–3 直選）',
    ACTIONS.camera.keys.join() === 'KeyV' && ACTIONS.weaponCycle.keys.join() === 'KeyQ' && actionForKey('KeyQ', 'vehicle') === 'radioNext' &&
      ['slot1', 'slot2', 'slot3'].every((k, i) => ACTIONS[k].keys.join() === `Digit${i + 1}`));
  const flat = (help) => help.flatMap((g) => g.items);
  check('actions：KEYMAP_HELP 通用列「T 手機」', KEYMAP_HELP.find((g) => g.group === '通用').items.some((i) => i.keys === 'T' && i.action === 'phone'));
  check('actions：TOUCH_HELP 列手機 / 視角鈕', flat(TOUCH_HELP).some((i) => i.action === 'phone' && i.keys.includes('手機')) && flat(TOUCH_HELP).some((i) => i.action === 'camera'));
}

// ======================= input：反轉 Y 與靈敏度（桌機滑鼠 / 觸控） =======================
{
  const { Input } = await import('../../src/input.js');
  const winL = new Map();
  const domL = new Map();
  const add = (m) => (name, fn) => {
    if (!m.has(name)) m.set(name, []);
    m.get(name).push(fn);
  };
  globalThis.window = { addEventListener: add(winL), innerWidth: 1000, innerHeight: 600 };
  const dom = { addEventListener: add(domL) };
  const fire = (m, name, ev) => (m.get(name) || []).forEach((fn) => fn({ preventDefault() {}, ...ev }));
  const input = new Input(dom);
  input.enabled = true;
  input.setSensitivity({ mouse: 1, touch: 1 });
  fire(domL, 'mousedown', { button: 1 }); // 中鍵：只開始拖曳
  const look = (invert, sens) => {
    input.setInvertY(invert);
    input.setSensitivity({ mouse: sens });
    input.consumeMouse();
    fire(winL, 'mousemove', { movementX: 10, movementY: 20 });
    return input.consumeMouse();
  };
  const n = look(false, 1);
  const inv = look(true, 1);
  const fast = look(false, 3);
  const slow = look(false, 0.3);
  check('input：反轉 Y 只翻轉滑鼠 dy', n.dy === 20 && inv.dy === -20 && inv.dx === n.dx, `${n.dy} / ${inv.dy}`);
  check('input：滑鼠靈敏度 3.0× / 0.3× 線性倍率', Math.abs(fast.dx - 30) < 1e-9 && Math.abs(slow.dy - 6) < 1e-9, `${fast.dx} / ${slow.dy}`);
  input.setSensitivity({ mouse: 9 });
  check('input：靈敏度夾在 0.3–3.0', input.sensMul('mouse') === 3);
  input.setInvertY(false);
  input.consumeMouse();
  input.touchLook(0, 10);
  const tn = input.consumeMouse().dy;
  input.setInvertY(true);
  input.touchLook(0, 10);
  const ti = input.consumeMouse().dy;
  check('input：反轉 Y 觸控同樣生效', tn > 0 && Math.abs(ti + tn) < 1e-9, `${tn.toFixed(3)} / ${ti.toFixed(3)}`);
  delete globalThis.window;
}

// ======================= camera（需要 three） =======================
{
  const THREE = await import('three');
  const C = await import('../../src/camera.js');
  const { CameraRig, WALK_DISTS, CAR_DISTS, BIKE_DISTS, nextView } = C;
  const flat = { querySurface: (x, z, y, out) => Object.assign(out, { y: 0, waterY: null }) };
  const noOcc = { sweep: () => 1 };
  const makeRig = () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 2000);
    const rig = new CameraRig(cam, noOcc, flat);
    const q = { dx: 0, dy: 0, wheel: 0 };
    const input = { consumeMouse: () => { const o = { ...q }; q.dx = q.dy = q.wheel = 0; return o; } };
    const focus = new THREE.Vector3();
    const step = (n, opts = {}) => {
      for (let i = 0; i < n; i++) rig.update(1 / 60, input, focus, opts);
    };
    const camDist = () => cam.position.distanceTo(rig._target);
    return { rig, q, step, camDist };
  };

  check('camera：常數 2.7 / 4.1 / 6.0、汽車 5.2 / 6.4 / 8.9、預設中段、越肩 0.3',
    WALK_DISTS.join() === '2.7,4.1,6' && CAR_DISTS.join() === '5.2,6.4,8.9' && BIKE_DISTS.join() === '4.3,5,6' && C.DEFAULT_VIEW === 1 && C.SHOULDER_OFFSET === 0.3);
  check('camera：nextView 0 → 1 → 2 → 0', nextView(0) === 1 && nextView(1) === 2 && nextView(2) === 0);

  // 三段循環 + onViewChange
  {
    const { rig, step, camDist } = makeRig();
    const calls = [];
    const onViewChange = (k, i) => calls.push([k, i]);
    step(240, { onViewChange });
    const d0 = camDist();
    const seen = [];
    for (let k = 0; k < 3; k++) {
      step(1, { cycleView: true, onViewChange });
      step(240, { onViewChange });
      seen.push(camDist());
    }
    check('camera：步行預設 4.1，V 循環 6.0 → 2.7 → 4.1', Math.abs(d0 - 4.1) < 1e-3 && [6.0, 2.7, 4.1].every((v, i) => Math.abs(seen[i] - v) < 1e-3), seen.map((d) => d.toFixed(2)).join(' / '));
    check('camera：步行 V 每次觸發 onViewChange(walk, i) 恰一次', j(calls) === j([['walk', 2], ['walk', 0], ['walk', 1]]), j(calls));
    // 駕駛：V 改 driveView，步行段位不動
    calls.length = 0;
    const drv = { driving: true, vehicleYaw: 0, speed: 0, distScale: 1.35, onViewChange };
    step(1, { ...drv, cycleView: true });
    step(240, drv);
    check('camera：駕駛 V → 8.9（6.4 下一段）並 onViewChange(drive, 2)', Math.abs(camDist() - 8.9) < 1e-3 && j(calls) === j([['drive', 2]]), camDist().toFixed(3));
    step(1, { ...drv, cycleView: true });
    step(1, { ...drv, cycleView: true });
    check('camera：駕駛循環 2 → 0 → 1', rig.driveView === 1 && j(calls.map((c) => c[1])) === j([2, 0, 1]));
    // 上下車段位各自記憶
    rig.setViews({ walk: 2, drive: 0 });
    step(1, { cycleView: true }); // 步行 2 → 0
    step(1, { ...drv }); // 上車
    const inCar = rig.getViews();
    step(1, { ...drv, cycleView: true }); // 駕駛 0 → 1
    step(240, {}); // 下車
    check('camera：上下車段位各自記憶（步行 0 維持、駕駛 0 → 1）', inCar.walk === 0 && inCar.drive === 0 && j(rig.getViews()) === j({ walk: 0, drive: 1 }) && Math.abs(camDist() - 2.7) < 1e-3, j(rig.getViews()));
    // 同幀 V + cycleView() 只通知一次（最終值）
    calls.length = 0;
    rig.cycleView('walk');
    step(1, { cycleView: true, onViewChange });
    check('camera：同幀多次改段位 onViewChange 最多一次（最終段位）', j(calls) === j([['walk', 2]]), j(calls));
    step(5, { onViewChange });
    check('camera：沒改段位的幀不呼叫 onViewChange', calls.length === 1);
  }

  // setViews / getViews
  {
    const { rig, q, step, camDist } = makeRig();
    const calls = [];
    rig.setViews({ walk: 0, drive: 2 });
    step(240, { onViewChange: (k, i) => calls.push([k, i]) });
    check('camera：setViews({ walk: 0, drive: 2 }) → getViews、步行距離 2.7、不觸發 onViewChange',
      j(rig.getViews()) === j({ walk: 0, drive: 2 }) && rig.dist === 2.7 && Math.abs(camDist() - 2.7) < 1e-3 && calls.length === 0);
    for (const bad of [{ walk: 3 }, { walk: -1 }, { walk: 1.5 }, { walk: '1' }, { drive: null }, {}]) rig.setViews(bad);
    rig.setViews();
    check('camera：setViews 非 0–2 整數忽略', j(rig.getViews()) === j({ walk: 0, drive: 2 }) && rig.dist === 2.7);
    rig.setViews({ drive: 1 });
    check('camera：setViews 只給 drive 時步行不動', j(rig.getViews()) === j({ walk: 0, drive: 1 }) && rig.dist === 2.7);
    // 滾輪微調只改 dist、不改段位
    q.wheel = 300;
    step(1, { onViewChange: (k, i) => calls.push([k, i]) });
    check('camera：滾輪微調只改 dist（不改段位、不通知）', rig.dist > 2.7 && rig.walkView === 0 && calls.length === 0, rig.dist.toFixed(3));
    // cycleView()：省略 kind = 依上一幀是否駕駛
    step(1, { driving: true, vehicleYaw: 0, speed: 0 });
    const r1 = rig.cycleView();
    step(1, {});
    const r2 = rig.cycleView();
    check('camera：cycleView() 依上一幀模式（駕駛 1 → 2、步行 0 → 1 並重設距離 4.1）',
      j(r1) === j({ kind: 'drive', index: 2 }) && j(r2) === j({ kind: 'walk', index: 1 }) && rig.dist === 4.1, `${j(r1)} ${j(r2)}`);
  }

  // 速度拉遠（平滑）與車型比例
  const driveDist = (opts, frames = 300) => {
    const { step, camDist } = makeRig();
    step(frames, { driving: true, vehicleYaw: 0, ...opts });
    return camDist();
  };
  {
    const still = driveDist({ speed: 0, distScale: 1.35 });
    const v66 = driveDist({ speed: 66 / 3.6, distScale: 1.35 });
    check('camera：汽車中段 6.4、66 km/h 再拉遠 ≈ 0.5 m', Math.abs(still - 6.4) < 1e-3 && Math.abs(v66 - still - 0.5) < 1e-3, `${still.toFixed(3)} → ${v66.toFixed(3)}`);
    // 平滑：靜止到位後突然 66 km/h，第一幀變化 < 0.1 m、約 1 s 內到位
    const { step, camDist } = makeRig();
    const o = { driving: true, vehicleYaw: 0, distScale: 1.35 };
    step(300, { ...o, speed: 0 });
    const a = camDist();
    step(1, { ...o, speed: 66 / 3.6 });
    const b = camDist();
    step(60, { ...o, speed: 66 / 3.6 });
    const c = camDist();
    check('camera：速度拉遠平滑（首幀 < 0.1 m、1 s 後 > 0.45 m）', b - a > 0 && b - a < 0.1 && c - a > 0.45, `Δ1=${(b - a).toFixed(3)} Δ60=${(c - a).toFixed(3)}`);
    const bus = driveDist({ speed: 0, distScale: 2.4 });
    const truck = driveDist({ speed: 0, distScale: 1.9 });
    const bike = driveDist({ speed: 0, distScale: 1.0, twoWheeler: true });
    check('camera：公車 / 垃圾車 / 機車依車型比例（6.4×2.4/1.35、6.4×1.9/1.35、5.0）',
      Math.abs(bus - (6.4 * 2.4) / 1.35) < 1e-3 && Math.abs(truck - (6.4 * 1.9) / 1.35) < 1e-3 && Math.abs(bike - 5.0) < 1e-3,
      `${bus.toFixed(2)} / ${truck.toFixed(2)} / ${bike.toFixed(2)}`);
  }
}

// ======================= menu：設定頁兩列 =======================
{
  globalThis.window = Object.assign(new Listeners(), { devicePixelRatio: 1 });
  const { createMenu } = await import('../../src/ui/menu.js');
  const settings = createSettings({ storage: fakeStorage() });
  const bus = { emit() {}, on() {}, off() {} };
  const body = new FakeEl('body');
  const menu = createMenu({ root: body, settings, bus, keymapHelp: KEYMAP_HELP, touchHelp: TOUCH_HELP, isTouch: false, attribution: '© test', mapView: null });
  menu.openPause('settings');
  const rows = body.findAllClass('tg-set-row');
  const order = rows.map((r) => r.dataset.item);
  const rowOf = (k) => rows.find((r) => r.dataset.item === k);
  check('menu：camWalkView / camDriveView 兩列緊接在 invertY 後',
    order.indexOf('camWalkView') === order.indexOf('invertY') + 1 && order.indexOf('camDriveView') === order.indexOf('invertY') + 2, order.join(','));
  const btns = (k) => rowOf(k).findAllClass('tg-seg-btn');
  const on = (k) => btns(k).findIndex((b) => b._cls.has('tg-on'));
  check('menu：標題步行鏡頭 / 駕駛鏡頭、選項近 / 中 / 遠', rowOf('camWalkView').textContent.includes('步行鏡頭') && rowOf('camDriveView').textContent.includes('駕駛鏡頭') &&
    btns('camWalkView').map((b) => b.textContent).join() === '近,中,遠');
  check('menu：數值段位高亮預設「中」', on('camWalkView') === 1 && on('camDriveView') === 1);
  btns('camWalkView')[2].click();
  check('menu：點「遠」→ settings camWalkView = 2（數值）並高亮', settings.get('camWalkView') === 2 && on('camWalkView') === 2);
  settings.set('camDriveView', 0); // 模擬 V 鍵 onViewChange 寫回
  check('menu：設定改變（V 鍵寫回）後選單同步顯示', on('camDriveView') === 0);
  menu.destroy?.();
  delete globalThis.window;
}

console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
