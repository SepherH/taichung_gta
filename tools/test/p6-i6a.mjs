#!/usr/bin/env node
// Phase 6 I6a 接線回歸（docs/dev/interfaces.md §20 時間步、§23.1 攤車碰撞盒、§23.2 鏡頭段位、§23.5 垃圾車警示燈）
// 用法：node tools/test/p6-i6a.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 不需要 node_modules；有 three 時另跑真 CameraRig 段（無 three → 印 SKIP，不計分）
// 項目：
//   1. 攤車：main.js stallBox = propColliderBox('night_market_stall', pl)，盒尺寸 = §23.1 定值
//   2. 垃圾車警示燈：registerNightOnce 跳過 beacon 材質（真函式抽出執行）、missionCtx.night = dayNight.night 在 missions.update 之前、
//      syncGarbageTruck 在 truck 非 null 時 applyBeacon(模板材質, tk.beaconLevel)；applyBeacon + beaconLevel 晝夜套到假材質
//   3. 鏡頭段位：建 rig 後 setViews(settings)、rig.update opts.onViewChange 寫回 settings、settings 訂閱兩鍵 → rig.setViews；
//      以真 createSettings（假 storage）+ 假 rig 跑一輪（含持久化到 storage、重載後段位還原）
//   4. 觸控視角鈕 tb-view：KeyV / tap / slot view / always；style.css slot-view 各尺寸（橫 / 直 / 極矮橫）不與既有鈕 / HUD 重疊
//   5. HUD 段位提示：cam-view-hint 文字「鏡頭：近 / 中 / 遠」、1.2 s（渲染 dt）後隱藏、非法 index 忽略；hud.js 接 showCamView / update
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const mainSrc = read('src/main.js');
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ======================= 1. 攤車碰撞盒 =======================
{
  const { propColliderBox } = await import('../../src/prop-model.js');
  // I6c：攤位改為 job-props.js stallRow 逐格（原攤車 + 變體），每格 box = propColliderBox('night_market_stall', pl)（p6-i6c.mjs 驗行為）
  const jpSrc = read('src/job-props.js');
  check('main.js / job-props.js：攤位碰撞盒 = propColliderBox(\'night_market_stall\', pl)（不再用 manifest 外接盒）',
    jpSrc.includes('box: model ? propColliderBox(STALL_BASE_KEY, pl) : null') && mainSrc.includes('stallBoxes.push(s.box);') && !mainSrc.includes('width: info.width, depth: info.depth')
    && /import \{[^}]*\bpropColliderBox\b[^}]*\} from '\.\/prop-model\.js';/.test(jpSrc));
  check('main.js：攤位碰撞盒仍在物理世界建好後交給 addStaticBox', mainSrc.indexOf('for (const b of [...stallBoxes, ...valetBoxes]) addStaticBox(RAPIER, pw.world, b);') > mainSrc.indexOf('const pw = new PhysicsWorld(RAPIER);'));
  const pl = { x: 557.2, y: 12.5, z: -125.1, yaw: 0.7 };
  const b = propColliderBox('night_market_stall', pl);
  check('攤車盒：寬 2.22 / 深 1.56 / 高 3.04、底面 = placement.y、中心水平無偏移、yaw 沿用',
    !!b && near(b.width, 2.22) && near(b.depth, 1.56) && near(b.height, 3.04) && near(b.y, 12.5) && near(b.x, 557.2) && near(b.z, -125.1) && b.yaw === 0.7, JSON.stringify(b));
}

// ======================= 2. 垃圾車警示燈 =======================
{
  const GT = await import('../../src/missions/garbage-truck.js');
  const { applyBeacon, beaconLevel, BEACON_DAY, BEACON_NIGHT, BEACON_COLOR } = GT;
  // registerNightOnce：從 main.js 抽出真函式本體，注入假 nightMaterials / registerNight 執行
  const m = mainSrc.match(/function registerNightOnce\(m\) \{[\s\S]*?\n\}/);
  check('main.js：registerNightOnce 存在', !!m);
  if (m) {
    const nightMaterials = [];
    const registerNight = (mat, k) => nightMaterials.push({ material: mat, k });
    const registerNightOnce = new Function('nightMaterials', 'registerNight', `${m[0]}; return registerNightOnce;`)(nightMaterials, registerNight);
    const head = { name: 'headlight', emissiveIntensity: 2 };
    const beacon = { name: 'beacon', emissiveIntensity: 1 };
    const beacon2 = { name: 'truck_beacon_amber', emissiveIntensity: 1 };
    for (const x of [head, head, beacon, beacon2, null, { emissiveIntensity: 0 }]) registerNightOnce(x);
    check('registerNightOnce：名稱含 beacon 者不登記 daynight、其餘照舊（同材質一次、無名稱不炸）',
      nightMaterials.length === 2 && nightMaterials[0].material === head && nightMaterials[0].k === 2 && !nightMaterials.some((e) => /beacon/.test(e.material.name || '')),
      nightMaterials.map((e) => e.material.name).join(','));
  }
  const iNight = mainSrc.indexOf('missionCtx.night = dayNight.night;');
  const iUpd = mainSrc.indexOf('missions.update(worldStep.simDt, missionCtx);');
  check('main.js：missionCtx.night = dayNight.night 在 missions.update(worldStep.simDt, …) 之前', iNight > 0 && iUpd > iNight && /const missionCtx = \{[^}]*\bnight: 0\b/.test(mainSrc));
  const sync = (mainSrc.match(/const syncGarbageTruck = \(simDt\) => \{[\s\S]*?\n  \};/) || [''])[0];
  const iNull = sync.indexOf('if (!tk) {');
  const iApply = sync.indexOf('applyBeacon(truckMaterials, tk.beaconLevel);');
  check('main.js：syncGarbageTruck 在 truck 非 null 分支呼叫 applyBeacon(truckMaterials, tk.beaconLevel)', iNull > 0 && iApply > iNull);
  check('main.js：truckMaterials = vehicleTemplateMaterials(\'garbage_truck\')（模板共用材質）、applyBeacon 自 garbage-truck.js import',
    mainSrc.includes("const truckMaterials = truckMesh ? vehicleTemplateMaterials('garbage_truck') : [];")
    && /import \{[^}]*\bapplyBeacon\b[^}]*\} from '\.\/missions\/garbage-truck\.js';/.test(mainSrc));
  // 套到假材質：夜間峰值 BEACON_NIGHT、白天峰值 BEACON_DAY；非 beacon 材質不動；黑 emissive 補琥珀色
  const mk = (name) => ({ name, emissiveIntensity: 1, emissive: { r: 0, g: 0, b: 0, setHex(h) { this.hex = h; this.r = 1; } } });
  const mats = [mk('beacon'), mk('headlight'), mk('body')];
  const nNight = applyBeacon(mats, beaconLevel(0, 1));
  const lvNight = mats[0].emissiveIntensity;
  applyBeacon(mats, beaconLevel(0, 0));
  const lvDay = mats[0].emissiveIntensity;
  applyBeacon(mats, beaconLevel(1 / 3, 1)); // 半週期（1.5 Hz）→ 暗
  const lvOff = mats[0].emissiveIntensity;
  check('applyBeacon：只動 beacon（1 個）、夜 2 / 日 0.15 / 半週期 ≈ 0、黑 emissive 補 BEACON_COLOR',
    nNight === 1 && near(lvNight, BEACON_NIGHT) && near(lvDay, BEACON_DAY) && lvOff < 1e-6 && mats[0].emissive.hex === BEACON_COLOR && mats[1].emissiveIntensity === 1 && mats[2].emissiveIntensity === 1,
    `${lvNight} / ${lvDay} / ${lvOff}`);
  // createGarbageTruck：ctx.night 傳入 → truck().beaconLevel 隨 night 變（確認 missionCtx.night 有被讀）
  const route = [{ x: 0, z: 0 }, { x: 200, z: 0 }];
  const mkTruck = () => GT.createGarbageTruck({ routeFor: () => route, getGameHour: () => 17, now: () => 0, rng: () => 0 });
  const tN = mkTruck();
  const tD = mkTruck();
  for (let i = 0; i < 30; i++) tN.update(1 / 60, { x: 5, z: 30, night: 1 });
  for (let i = 0; i < 30; i++) tD.update(1 / 60, { x: 5, z: 30, night: 0 });
  const kN = tN.truck();
  const kD = tD.truck();
  check('garbage-truck：ctx.night 1 → beaconLevel 夜間值、0 → 白天值（missionCtx.night 生效）',
    !!kN && !!kD && near(kN.beaconLevel, beaconLevel(kN.beaconT, 1)) && near(kD.beaconLevel, beaconLevel(kD.beaconT, 0)) && kN.beaconLevel > kD.beaconLevel,
    kN && kD ? `${kN.beaconLevel} vs ${kD.beaconLevel}` : 'truck null');
}

// ======================= 3. 鏡頭段位 ↔ 設定 =======================
const hintMod = await import('../../src/ui/cam-view-hint.js');
{
  const { camViewSettingKey, camViewsFromSettings, isCamViewKey } = hintMod;
  const { createSettings, SETTINGS_KEY } = await import('../../src/core/settings.js');
  const iRig = mainSrc.indexOf('const rig = new CameraRig(camera, occluder, terrain);');
  const iSet = mainSrc.indexOf('rig.setViews(camViewsFromSettings(settings));');
  check('main.js：建 rig 後 rig.setViews(camViewsFromSettings(settings))', iRig > 0 && iSet > iRig && iSet - iRig < 400);
  check('main.js：settings.subscribe 分支 isCamViewKey(key) → rig.setViews', /settings\.subscribe\(\(key, value\) => \{[\s\S]*?else if \(isCamViewKey\(key\)\) rig\.setViews\(camViewsFromSettings\(settings\)\);[\s\S]*?\}\);/.test(mainSrc));
  const upd = (mainSrc.match(/rig\.update\(dt, input, focus, \{[\s\S]*?\}\);/) || [''])[0];
  check('main.js：rig.update opts 帶 onViewChange（每幀不建新閉包）', upd.includes('onViewChange: onCamViewChange,'));
  const cb = (mainSrc.match(/const onCamViewChange = \(kind, index\) => \{[\s\S]*?\};/) || [''])[0];
  check('main.js：onCamViewChange → settings.set(camViewSettingKey(kind), index) + hud.showCamView(index)', cb.includes('settings.set(camViewSettingKey(kind), index);') && cb.includes('hud.showCamView(index);'));
  check('段位鍵對應：walk → camWalkView、drive → camDriveView；isCamViewKey 只認兩鍵',
    camViewSettingKey('walk') === 'camWalkView' && camViewSettingKey('drive') === 'camDriveView' && isCamViewKey('camWalkView') && isCamViewKey('camDriveView') && !isCamViewKey('invertY'));

  // 假 rig（setViews / onViewChange 語意同 camera.js：非 0–2 整數忽略、setViews 不觸發 onViewChange）+ 真 settings
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const boot = () => {
    const settings = createSettings({ storage });
    const rig = {
      walk: 1, drive: 1, setCalls: 0, _pending: null,
      setViews({ walk, drive } = {}) {
        this.setCalls++;
        if (Number.isInteger(walk) && walk >= 0 && walk <= 2) this.walk = walk;
        if (Number.isInteger(drive) && drive >= 0 && drive <= 2) this.drive = drive;
      },
      cycleView(kind) {
        this[kind] = (this[kind] + 1) % 3;
        this._pending = kind;
      },
      update(opts) {
        if (opts.cycleView) this.cycleView(opts.driving ? 'drive' : 'walk');
        if (this._pending && opts.onViewChange) opts.onViewChange(this._pending, this[this._pending]);
        this._pending = null;
      },
    };
    const shown = [];
    const hud = { showCamView: (i) => shown.push(i) };
    // 與 main.js 同步驟
    rig.setViews(camViewsFromSettings(settings));
    settings.subscribe((key) => {
      if (isCamViewKey(key)) rig.setViews(camViewsFromSettings(settings));
    });
    const onCamViewChange = (kind, index) => {
      settings.set(camViewSettingKey(kind), index);
      hud.showCamView(index);
    };
    return { settings, rig, shown, onCamViewChange };
  };
  const A = boot();
  check('開局：缺鍵 → 段位 1 / 1', A.rig.walk === 1 && A.rig.drive === 1);
  A.rig.update({ cycleView: true, driving: false, onViewChange: A.onCamViewChange });
  A.rig.update({ cycleView: true, driving: true, onViewChange: A.onCamViewChange });
  A.rig.update({ cycleView: true, driving: true, onViewChange: A.onCamViewChange });
  check('V（步行 1 次、駕駛 2 次）→ settings camWalkView 2 / camDriveView 0、HUD 顯示 [2, 2, 0]',
    A.settings.get('camWalkView') === 2 && A.settings.get('camDriveView') === 0 && A.shown.join() === '2,2,0', `${A.settings.get('camWalkView')} / ${A.settings.get('camDriveView')} / ${A.shown}`);
  const saved = JSON.parse(mem.get(SETTINGS_KEY) || '{}');
  check('段位已寫入 tcgta.settings.v1', saved.camWalkView === 2 && saved.camDriveView === 0);
  A.settings.set('camDriveView', 1);
  check('設定頁改 camDriveView → 訂閱觸發 rig.setViews（rig.drive 1）、不顯示 HUD 提示', A.rig.drive === 1 && A.shown.length === 3);
  const before = A.rig.setCalls;
  A.rig.update({ cycleView: false, driving: false, onViewChange: A.onCamViewChange });
  check('沒按 V → 不寫設定、不呼叫 setViews', A.rig.setCalls === before && A.shown.length === 3);
  const B = boot();
  check('重載（同 storage）→ 段位還原 walk 2 / drive 1', B.rig.walk === 2 && B.rig.drive === 1);

  // 真 CameraRig（需要 three；容器無 node_modules 時略過）
  let THREE = null;
  try {
    THREE = await import('three');
  } catch {
    console.log('SKIP  真 CameraRig 段（找不到 three）');
  }
  if (THREE) {
    const { CameraRig, WALK_DISTS } = await import('../../src/camera.js');
    const flat = { querySurface: (x, z, y, out) => Object.assign(out, { y: 0, waterY: null }) };
    const rig = new CameraRig(new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 2000), { sweep: () => 1 }, flat);
    const settings = createSettings({ storage: { getItem: () => JSON.stringify({ camWalkView: 0, camDriveView: 2 }), setItem() {}, removeItem() {} } });
    rig.setViews(camViewsFromSettings(settings));
    const input = { consumeMouse: () => ({ dx: 0, dy: 0, wheel: 0 }) };
    const focus = new THREE.Vector3();
    const calls = [];
    rig.update(1 / 60, input, focus, { cycleView: true, onViewChange: (k, i) => { calls.push([k, i]); settings.set(camViewSettingKey(k), i); } });
    check('真 CameraRig：setViews(settings 0 / 2) → V → onViewChange(walk, 1) → settings camWalkView 1、dist = WALK_DISTS[1]',
      rig.getViews().drive === 2 && calls.length === 1 && calls[0][0] === 'walk' && calls[0][1] === 1 && settings.get('camWalkView') === 1 && near(rig.dist, WALK_DISTS[1]), JSON.stringify(calls));
  }
}

// ======================= 4. 觸控視角鈕 =======================
{
  const touchSrc = read('src/touch.js');
  const defaults = touchSrc.slice(touchSrc.indexOf('const DEFAULT_BUTTONS'), touchSrc.indexOf('];', touchSrc.indexOf('const DEFAULT_BUTTONS')));
  check('touch.js：DEFAULT_BUTTONS 有 tb-view（視角、KeyV、tap、slot view、always）',
    defaults.includes("{ id: 'tb-view', label: '視角', code: 'KeyV', mode: 'tap', slot: 'view', showWhen: 'always' }"));
  check('touch.js：SLOTS 含 view；slot view 只有 tb-view 使用', /export const SLOTS = \[[^\]]*'view'[^\]]*\]/.test(touchSrc) && [...defaults.matchAll(/slot: 'view'/g)].length === 1 && !/slot: 'view'/.test(mainSrc));
  const { ACTIONS, TOUCH_HELP } = await import('../../src/core/actions.js');
  check('actions：camera = KeyV、TOUCH_HELP 視角列', ACTIONS.camera.keys.includes('KeyV') && TOUCH_HELP.some((g) => g.items.some((i) => i.action === 'camera' && i.keys.includes('視角'))));

  // 版面：依 style.css slot-view 數值推算矩形，與既有按鈕 / HUD 元件不重疊（按鈕間距 ≥ 8 px、HUD ≥ 2 px）
  const css = read('src/style.css');
  const wpCss = read('src/weapons/weapons.css');
  const num = (b, prop) => {
    const m = b.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(?:calc\\()?(-?\\d+)px`));
    return m ? Number(m[1]) : NaN;
  };
  const base = (css.match(/\n\.tbtn\.slot-view\s*\{([^}]*)\}/) || [])[1] || '';
  const short = (css.match(/@media \(orientation: landscape\) and \(max-height: 379px\)\s*\{\s*\.tbtn\.slot-view\s*\{([^}]*)\}/) || [])[1] || '';
  const port = (css.match(/@media \(orientation: portrait\)\s*\{\s*\.tbtn\.slot-view\s*\{([^}]*)\}/) || [])[1] || '';
  check('style.css：slot-view 橫向 / 極矮橫向 / 直向規則存在、≥ 44 px',
    [base, short, port].every((b) => b && (num(b, 'width') >= 44 || Number.isNaN(num(b, 'width')))) && num(base, 'width') >= 44 && num(short, 'width') >= 44 && num(port, 'width') >= 44 && /right:\s*auto/.test(port));
  const wpShortHud = (wpCss.match(/max-height: 379px\)\s*\{\s*body\.touch \.wp-hud\s*\{([^}]*)\}/) || [])[1] || '';
  const wpReload = (wpCss.match(/max-height: 540px\)\s*\{[\s\S]*?body\.touch \.wp-tb-reload\s*\{([^}]*)\}/) || [])[1] || '';
  check('weapons.css：極矮橫向武器面板 / 裝填鈕位置可讀（版面推算依據）', num(wpShortHud, 'right') === 76 && num(wpShortHud, 'top') === 26 && num(wpReload, 'right') === 16);
  const R = (x, y, w, h, name, minGap = 8) => ({ x, y, w, h, name, minGap });
  const gap = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
  const bad = [];
  for (const [W, H] of [[568, 320], [640, 360], [667, 375], [740, 360], [844, 390], [932, 430], [1024, 768], [360, 640], [375, 667], [390, 844], [430, 932], [768, 1024]]) {
    const portrait = H > W;
    const narrow = portrait && W <= 400;
    const veryShort = !portrait && H < 380;
    let me;
    if (portrait) me = R(num(port, 'left'), num(port, 'top'), num(port, 'width'), num(port, 'height'), 'view');
    else {
      const b = veryShort ? { ...{ top: num(base, 'top') }, right: num(short, 'right'), w: num(short, 'width') } : { top: num(base, 'top'), right: num(base, 'right'), w: num(base, 'width') };
      me = R(W - b.right - b.w, b.top, b.w, b.w, 'view');
    }
    const topSz = narrow ? 48 : 56;
    const others = [
      R(140, 12, 48, 48, 'tl1'),
      R(narrow ? 192 : 196, 12, 48, 48, 'tl2'),
      R(narrow ? 244 : 252, 12, 48, 48, 'tl3'),
      R(W - (narrow ? 12 : 16) - topSz, 12, topSz, topSz, 'top1 喇叭'),
      R(W - 82 - topSz, 12, topSz, topSz, 'top2 電台'),
      R(10, 10, 120, 162, '小地圖群組', 2),
    ];
    const statusW = portrait ? Math.min(220, W - 160) : 260;
    others.push(R(W - 16 - statusW, 76, statusW, 30, '#status', 2));
    if (portrait) {
      others.push(R(W / 2 + 4, 132, W / 2 - 14, 140, '#hint-card', 2));
      others.push(R(10, 180, W / 2 - 14, 60, '#prompt', 2));
      others.push(R(W - 104 - 60, 134, 60, 60, '駕駛 下車'), R(W - 16 - 60, 134, 60, 60, '駕駛 手煞'));
    } else {
      others.push(R(140, 76, W / 2 - 144, 44, '#prompt', 2));
      if (H <= 540) others.push(R(W - num(wpReload, 'right') - 52, 14, 52, 52, '裝填鈕'));
      if (veryShort) others.push(R(W - num(wpShortHud, 'right') - 112, num(wpShortHud, 'top'), 112, 28, '武器面板', 2));
    }
    if (!(me.x >= 0 && me.y >= 0 && me.x + me.w <= W && me.y + me.h <= H)) bad.push(`${W}x${H} 出界`);
    for (const o of others) if (gap(me, o) < o.minGap) bad.push(`${W}x${H} ${o.name} 間距 ${gap(me, o)}`);
  }
  check('tb-view 版面：橫 / 直 / 極矮橫 12 種尺寸不與 tl1–tl3、喇叭 / 電台、駕駛下車 / 手煞、裝填鈕、武器面板、小地圖、#status、提示重疊', bad.length === 0, bad.join('; '));
}

// ======================= 5. HUD 段位提示 =======================
{
  const { createCamViewHint, camViewText, CAM_VIEW_HINT_SEC } = hintMod;
  check('camViewText：0 / 1 / 2 → 鏡頭：近 / 中 / 遠；非法 → null',
    camViewText(0) === '鏡頭：近' && camViewText(1) === '鏡頭：中' && camViewText(2) === '鏡頭：遠' && camViewText(3) === null && camViewText(1.5) === null && camViewText('1') === null);
  const mkEl = () => {
    const cls = new Set();
    return { id: '', textContent: '', attrs: {}, parentNode: null, setAttribute(k, v) { this.attrs[k] = v; },
      set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
      classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) } };
  };
  const root = { kids: [], appendChild(e) { this.kids.push(e); e.parentNode = this; }, removeChild(e) { this.kids.splice(this.kids.indexOf(e), 1); e.parentNode = null; } };
  const doc = { createElement: () => mkEl(), body: null };
  const h = createCamViewHint({ doc, parent: root });
  const el = h.el;
  check('建立：#cam-view-hint 掛在 parent、預設隱藏', root.kids.length === 1 && el.id === 'cam-view-hint' && el.classList.contains('hidden') && !h.visible);
  check('show(2) → 顯示「鏡頭：遠」', h.show(2) === true && el.textContent === '鏡頭：遠' && !el.classList.contains('hidden') && h.text === '鏡頭：遠');
  for (let i = 0; i < 66; i++) h.update(1 / 60); // 1.1 s
  check('1.1 s 後仍顯示', h.visible && !el.classList.contains('hidden'));
  for (let i = 0; i < 7; i++) h.update(1 / 60); // 1.2167 s
  check(`${CAM_VIEW_HINT_SEC} s 後隱藏`, CAM_VIEW_HINT_SEC === 1.2 && !h.visible && el.classList.contains('hidden') && h.text === null);
  h.show(0);
  h.update(1);
  h.show(1);
  h.update(1);
  check('連按：重設倒數、顯示最後段位', h.visible && el.textContent === '鏡頭：中');
  h.update(0.3);
  check('非法 index 忽略（不改文字、不延長）', h.show(7) === false && !h.visible && el.textContent === '鏡頭：中');
  h.update(NaN);
  h.destroy();
  check('destroy 移除元素；無 document 時只算狀態', root.kids.length === 0 && (() => {
    const n = createCamViewHint({ doc: null });
    return n.el === null && n.show(1) && n.text === '鏡頭：中';
  })());
  const hudSrc = read('src/hud.js');
  check('hud.js：建立 createCamViewHint({ parent: this.root })、showCamView(index)、update 每幀 _camViewHint.update(dt)',
    hudSrc.includes("import { createCamViewHint } from './ui/cam-view-hint.js';") && hudSrc.includes('this._camViewHint = createCamViewHint({ parent: this.root });')
    && /showCamView\(index\) \{\s*return this\._camViewHint\.show\(index\);/.test(hudSrc) && hudSrc.includes('this._camViewHint.update(dt);'));
  check('style.css：#cam-view-hint 置中、不吃指標事件', /#cam-view-hint\s*\{[^}]*left: 50%[^}]*pointer-events: none/.test(read('src/style.css')));
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
