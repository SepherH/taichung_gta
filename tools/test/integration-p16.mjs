#!/usr/bin/env node
// Phase 16 整合驗證：特技跳台接線（main.js 原始碼字串比對 + 抽出特技跳台段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p16.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立 stunts / 坡道網格 / 碰撞 / HUD、互斥 stuntBusy（含暴走 rampage.active / 重生畫面 state.respawn、不含通緝）、timeScale 套用點（updateGame：輸入 / 選單之後、
//   角色 / 物理 step / AI 之前 dt *= stunts.timeScale；updateStunts 吃 realDt；updateAudio 在 updateGame 之外）、電影鏡頭 applyStuntCam 接在 rig.update / tour.handoff 之後、
//   collectMarkers、存檔 / 讀檔、startGame / quitToMenu → cancelStunts（cancelRampage 之後、cancelRespawn 之前）、window.__game、
//   行為（抽段 + 替身）：坡道 1 Mesh + 5 凸包、駕車衝坡起飛 → 慢動作 / 鏡頭、busy / 警車任務 / 暴走不觸發、空中被捕 / 死亡 → 立即中止不給錢、步行不取樣、cancel 復原
// 注意：staging 無 node_modules；main.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { GROUPS } from '../../src/physics/groups.js';
import { createStunts, createRampMesh, addRampColliders, createStuntHud, STUNTS, SLOWMO_SCALE, RAMP_LEN, RAMP_HEIGHT } from '../../src/stunts.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 靜態（main.js 原始碼）----------
const mainSrc = read('src/main.js');
const missing = (code, list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
const GROUPS_STATIC = [
  ['import：stunts.js', ["import { createStunts, createRampMesh, addRampColliders, createStuntHud } from './stunts.js';"]],
  ['建立 stunts / 坡道網格 / 碰撞（WORLD 組）/ HUD', [
    'const stunts = createStunts({ bus, groundAt: heightAt });',
    'const stuntRamps = createRampMesh({ THREE, scene, groundAt: heightAt });',
    'const stuntColliders = addRampColliders(RAPIER, pw.world, { groundAt: heightAt, groups: GROUPS.WORLD });',
    'const stuntHud = createStuntHud({ root: document.body });',
  ]],
  ['互斥：stuntBusy = otherMissionBusy() || vigilante.active || rampage.active || !!state.respawn', ['const stuntBusy = () => otherMissionBusy() || vigilante.active || rampage.active || !!state.respawn;', 'stuntCtx.busy = stuntBusy();']],
  ['入帳 reason stunt、toast 走 hud', ["earn: (n) => economy.add(n, 'stunt'),", 'toast: (text, seconds) => hud.toast(text, seconds),']],
  ['取樣：插值位置 + 剛體速度 / 姿態 + 車輪接地', ['stuntSample.active = !!vb && !vb.kinematic && vb.active;', 'const lv = vb.body.linvel();', 'grounded = !!vb.controller.wheelIsInContact(i);']],
  ['timeScale 套用點：updateGame 內 realDt / dt *= stunts.timeScale', [/const realDt = dt;\s*\n\s*dt \*= stunts\.timeScale;/]],
  ['每幀：updateStunts(realDt) 接在 updateRampage 之後', [/updateRampage\(dt, phoneOpen\);\s*\n\s*updateStunts\(realDt\);/]],
  ['電影鏡頭：applyStuntCam 接在 tour.handoff 之後', [/tour\.handoff\(dt\);[^\n]*\n\s*applyStuntCam\(\);/]],
  ['鏡頭內插：位置 lerp、朝向 slerp、weight 0 不動', ['if (!(c.weight > 0)) return;', 'camera.position.lerpVectors(stuntRigPos, camera.position, c.weight);', 'camera.quaternion.slerpQuaternions(stuntRigQuat, stuntCamQuat, c.weight);']],
  ['標記：collectMarkers 併入 stuntMarkers', ['pushAll(out, stuntMarkers());', 'return stunts.markers(stuntMk);']],
  ['存檔：stunts.serialize', ['stunts: stunts.serialize(),']],
  ['開局：rampage.restore 後 stunts.restore', [/rampage\.restore\(save\.rampage\);[^\n]*\n\s*stunts\.restore\(save\.stunts\);/]],
  ['window.__game：stunts / stuntHud', ['stunts, stuntHud, stuntRamps, stuntColliders,']],
  ['檔頭說明 Phase 16', ['// 特技跳台（Phase 16，§38 Unique Stunt Jumps）']],
];
for (const [name, list] of GROUPS_STATIC) {
  const miss = missing(mainSrc, list);
  check(name, miss.length === 0, miss.map(String).join(' | '));
}

const fnBody = (name) => {
  const i = mainSrc.indexOf(`const ${name} = (`);
  if (i < 0) return '';
  const j = mainSrc.indexOf('\n  };\n', i);
  return mainSrc.slice(i, j);
};
for (const fn of ['startGame', 'quitToMenu']) {
  const b = fnBody(fn);
  const a = b.indexOf('cancelRampage();');
  const s = b.indexOf('cancelStunts();');
  const r = b.indexOf('cancelRespawn();');
  check(`${fn}：cancelStunts() 在 cancelRampage() 之後、cancelRespawn() 之前`, a > 0 && s > a && r > s);
}
check('cancelStunts 定義：stunts.cancel + HUD 收起', /const cancelStunts = \(\) => \{\s*\n\s*stunts\.cancel\(\);\s*\n\s*stuntHud\.set\(null\);/.test(mainSrc));

// timeScale 套用點：updateGame 內的位置與範圍
{
  const ug = fnBody('updateGame');
  const at = (s) => ug.indexOf(s);
  const scale = at('dt *= stunts.timeScale;');
  check('updateGame 參數仍為 (dt)（既有接線字串不變）', mainSrc.includes('const updateGame = (dt) => {'));
  check('dt 縮放在面板 / 暫停 / 地圖 / 手機 / 快轉處理之後', scale > at('if (syncPanels()) return;') && scale > at('menu.openPause();') && scale > at('bigMap.open();') && scale > at('dayNight.toggleFast();'));
  const worldCalls = ['player.update(dt, input, rig.yaw);', 'updateKnockout(dt);', 'stepWorld(dt, ', 'updateWanted(dt, phoneOpen);', 'updateGangs(dt, phoneOpen);', 'updateExplosions(dt);', 'updateRampage(dt, phoneOpen);', 'weapons.update(dt, aim);', 'player.sitOn(v, dt);', 'dayNight.update(dt, focus);', 'blood.update(dt, camera);'];
  const before = worldCalls.filter((c) => !(at(c) > scale));
  check('物理 step / 角色 / AI / 任務 / 動畫呼叫都在縮放之後（吃縮放後的 dt）', scale > 0 && before.length === 0, before.join(' | '));
  const realUses = ug.replace(/\/\/[^\n]*/g, '').match(/realDt/g) || [];
  check('realDt 只給 updateStunts（宣告 + 1 次使用）', realUses.length === 2 && ug.includes('updateStunts(realDt);'));
  check('updateGame 內沒有其他 timeScale 套用（單一套用點）', (ug.replace(/\/\/[^\n]*/g, '').match(/timeScale/g) || []).length === 1);
  check('音效不慢：updateAudio 不在 updateGame 內（core/loop.js tick 以原始 dt 呼叫）', !ug.includes('updateAudio(') && /d\.updateAudio\(dt\);/.test(read('src/core/loop.js')));
  check('applyStuntCam 在 rig.update 之後', at('applyStuntCam();') > at('rig.update(dt, input, focus, {'));
}

const section = (() => {
  const i = mainSrc.indexOf('// ---------- 特技跳台（Phase 16，§38）');
  const j = mainSrc.indexOf('\n  // ---------- 畫質 / 設定', i);
  return i > 0 && j > i ? mainSrc.slice(i, j) : '';
})();
check('抽出特技跳台段（stepWorld 之後、畫質段之前；不在暴走段抽取範圍內）', section.length > 500 && mainSrc.indexOf('const stepWorld = worldStep.step;') < mainSrc.indexOf('// ---------- 特技跳台（Phase 16，§38）') && mainSrc.indexOf('// ---------- 特技跳台（Phase 16，§38）') > mainSrc.indexOf('\n  // 車流停車判斷用'));
check('特技段不新增光源 / 貼圖 / 陰影', !/Light\(|Texture|castShadow|shadowMap/.test(section));
{
  // 互斥清單須與 stunts.js 檔頭 / interfaces.md 一致：暴走（rampage.active）、被捕 / 死亡重生畫面（state.respawn，對照 rampageBusy）
  const m = mainSrc.match(/const stuntBusy = \(\) => ([^;\n]*);/);
  const expr = m ? m[1] : '';
  check('stuntBusy 含暴走 rampage.active（stunts.js / interfaces.md 互斥清單列有暴走）', /\brampage\.active\b/.test(expr) && /暴走/.test(read('src/stunts.js').split('\n').slice(0, 30).join('\n')), expr);
  check('stuntBusy 含 state.respawn（同 rampageBusy；空中被捕 / 死亡中止跳躍）', /!!state\.respawn\b/.test(expr) && /const rampageBusy = \(\) => [^;\n]*!!state\.respawn/.test(mainSrc), expr);
  check('interfaces.md §38.4 互斥式與 main.js 一致', read('docs/dev/interfaces.md').includes(`\`stuntBusy = ${expr}\``));
}
check('互斥不含通緝（有星數照常觸發）', !/wanted|stars/.test(section.replace(/\/\/[^\n]*/g, '')));

// ---------- 行為（抽段 + 替身）----------
{
  const body = `${section}\nreturn { stunts, stuntRamps, stuntColliders, stuntHud, updateStunts, applyStuntCam, cancelStunts, stuntMarkers, fillStuntSample };`;
  class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    lerpVectors(a, b, t) { return this.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  }
  class Q {
    constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    slerpQuaternions(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; this.w = a.w + (b.w - a.w) * t; return this; }
  }
  const made = { meshes: 0, mats: [] };
  class Geo { constructor() { this.attrs = {}; } setAttribute(k, v) { this.attrs[k] = v; } setIndex() {} computeBoundingSphere() {} dispose() {} }
  const THREE = {
    Vector3: V3,
    Quaternion: Q,
    BufferGeometry: Geo,
    BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshStandardMaterial: class { constructor(o) { Object.assign(this, o); made.mats.push(this); } dispose() {} },
    Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; made.meshes++; } },
  };
  const camera = { position: new V3(0, 10, 0), quaternion: new Q(), lookAt() { this.quaternion.x = 0.5; this.quaternion.w = 0.5; } };
  const sceneAdds = [];
  const colliders = [];
  const RAPIER = { ColliderDesc: { convexHull: (pts) => ({ pts, setCollisionGroups(g) { this.g = g; return this; }, setSolverGroups(g) { this.sg = g; return this; } }) } };
  const pw = { world: { createCollider: (d) => (colliders.push(d), { d }) } };
  const bus = createBus();
  const launches = [];
  bus.on('stunt:launch', (e) => launches.push(e));
  const busy = { on: false };
  const vigilante = { active: false };
  const rampage = { active: false };
  const money = [];
  const lands = [];
  bus.on('stunt:land', (e) => lands.push(e));
  const state = { mode: 'drive', vehicle: null, respawn: null };
  let grounded = true;
  const lv = { x: 0, y: 0, z: 0 };
  const rq = { x: 0, y: 0, z: 0, w: 1 };
  const car = {
    pos: new V3(),
    body: { kinematic: false, active: true, body: { linvel: () => lv, rotation: () => rq }, layout: { wheels: [0, 1, 2, 3] }, controller: { wheelIsInContact: () => grounded } },
  };
  state.vehicle = car;
  const deps = {
    THREE, scene: { add: (o) => sceneAdds.push(o) }, heightAt: () => 0, bus, RAPIER, pw, GROUPS,
    document: { body: null }, otherMissionBusy: () => busy.on, vigilante, rampage, economy: { add: (n, r) => money.push([n, r]) }, hud: { toast() {} },
    state, camera, createStunts, createRampMesh, addRampColliders, createStuntHud,
  };
  let w = null;
  try {
    w = new Function(...Object.keys(deps), body)(...Object.values(deps));
  } catch (e) {
    check('抽段可執行', false, e.message);
  }
  if (w) {
    check('坡道：1 個 Mesh 加入場景（draw call 1）、5 個 WORLD 組凸包', made.meshes === 1 && sceneAdds.length === 1 && colliders.length === STUNTS.length && colliders.every((c) => c.g === GROUPS.WORLD && c.sg === GROUPS.WORLD));
    const def = STUNTS[0];
    const f = def.frame;
    // 駕車衝坡：每幀 0.45 m（27 m/s @60fps）；坡面接地、過坡頂離地
    const drive = (frames = 60) => {
      for (let i = 0; i < frames; i++) {
        const s = -10 + i * 0.45;
        car.pos.set(def.x + f.fx * s, s > RAMP_LEN ? RAMP_HEIGHT + 1 : 0.6, def.z + f.fz * s);
        lv.x = f.fx * 27;
        lv.z = f.fz * 27;
        grounded = s < RAMP_LEN;
        w.updateStunts(1 / 60);
        w.applyStuntCam();
      }
    };
    const cam0 = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    w.applyStuntCam();
    check('weight 0：applyStuntCam 不動鏡頭', camera.position.x === cam0.x && camera.position.y === cam0.y && camera.quaternion.w === 1);
    drive();
    check('駕車衝坡 ≥ 22 m/s 起飛 → stunt:launch、stunts.timeScale = 0.35（updateGame 下一幀起縮放世界 dt）', launches.length === 1 && w.stunts.timeScale === SLOWMO_SCALE && w.stunts.phase === 'air');
    check('電影鏡頭接管：camera 位置 / 朝向被內插', w.stunts.cam.weight > 0 && (camera.position.x !== cam0.x || camera.position.z !== cam0.z) && camera.quaternion.x > 0);
    w.cancelStunts();
    check('cancelStunts：timeScale 1、phase idle、鏡頭權重 0', w.stunts.timeScale === 1 && w.stunts.phase === 'idle' && w.stunts.cam.weight === 0);
    busy.on = true;
    drive();
    check('其他任務 / 競速進行中（otherMissionBusy）→ 不觸發', launches.length === 1 && w.stunts.timeScale === 1);
    busy.on = false;
    vigilante.active = true;
    drive();
    check('警車任務進行中 → 不觸發', launches.length === 1 && w.stunts.timeScale === 1);
    vigilante.active = false;
    drive();
    check('解除後照常觸發', launches.length === 2 && w.stunts.timeScale === SLOWMO_SCALE);
    w.cancelStunts();
    rampage.active = true;
    drive();
    check('暴走進行中（rampage.active）→ 不觸發', launches.length === 2 && w.stunts.timeScale === 1);
    rampage.active = false;
    // 空中被捕 / 死亡：起飛後 state.respawn 轉真 → 下一幀立即中止（cancel、不給錢、timeScale 1、鏡頭立即歸還）
    drive(56);
    const airBefore = w.stunts.phase === 'air' && w.stunts.timeScale === SLOWMO_SCALE && launches.length === 3;
    const nLand = lands.length;
    state.respawn = { kind: 'busted' };
    car.pos.set(def.x + f.fx * (RAMP_LEN + 20), 0.6, def.z + f.fz * (RAMP_LEN + 20));
    grounded = true;
    w.updateStunts(1 / 60);
    const ab = lands[nLand];
    check('空中被捕 / 死亡（state.respawn）→ 立即中止：stunt:land cancel、timeScale 1、phase idle、鏡頭權重 0', airBefore && lands.length === nLand + 1 && ab.reason === 'cancel' && w.stunts.timeScale === 1 && w.stunts.phase === 'idle' && w.stunts.cam.weight === 0);
    for (let i = 0; i < 120; i++) w.updateStunts(1 / 60);
    check('重生畫面期間落在區內也不結算、不入帳、不記完成', lands.length === nLand + 1 && money.length === 0 && !w.stunts.isDone(def.id));
    state.respawn = null;
    state.mode = 'walk';
    w.updateStunts(1 / 60);
    check('步行（下車）：取樣 inactive → 中止、timeScale 1', w.fillStuntSample().active === false && w.stunts.timeScale === 1 && w.stunts.phase === 'idle');
    state.mode = 'drive';
    car.body.kinematic = true;
    check('車體 kinematic（停放）不取樣', w.fillStuntSample().active === false);
    car.body.kinematic = false;
    check('小地圖：stuntMarkers 列 5 處 kind stunt', w.stuntMarkers().length === 5 && w.stuntMarkers().every((m) => m.kind === 'stunt'));
  }
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
