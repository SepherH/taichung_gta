#!/usr/bin/env node
// P10 路人生活行為（src/ped-ambient.js + npc-ai 拍片 / onThreatened 分流 + animator overlay + traffic-peds walkPed pace / faceHold）
// 用法：node tools/test/p10-ped-ambient.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 不依賴 rapier；行人以假物件（同 Traffic.peds 的欄位：slot / x / z / yaw / speed / state / route.kind / citizen.level / brain / anim / actor）
//   在直線人行道上來回走（套用 pace / faceHold），stagger 照 src/crowd.js createStagger 語意複製（該檔間接 import three）
// animator 段：有 three 用真的；沒有（容器內無 node_modules）時以 loader hook 換成最小 three 替身（只供 animator 的 overlay 邏輯）
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const STUB = process.env.P10_THREE_STUB === '1';
const THREE_SRC = \`
export class BoxGeometry { translate() { return this; } }
export class Group {} export class Mesh {} export class Color { set() { return this; } }
export class MeshStandardMaterial {} export class MeshLambertMaterial {} export class AnimationMixer {}
export const LoopOnce = 2200; export const LoopRepeat = 2201; export const SRGBColorSpace = 'srgb';
export class AnimationClip { constructor(name, duration, tracks) { this.name = name; this.duration = duration; this.tracks = tracks || []; } clone() { return new AnimationClip(this.name, this.duration, this.tracks.map((t) => t.clone())); } }
export const PropertyBinding = { parseTrackName(n) { return { nodeName: n.split('.')[0] }; } };
export const AnimationUtils = { makeClipAdditive(c) { return c; } };
\`;
export async function resolve(spec, context, next) {
  if (STUB && (spec === 'three' || spec.startsWith('three/'))) {
    const src = spec === 'three' ? THREE_SRC : spec.includes('GLTFLoader') ? 'export class GLTFLoader {}' : 'export function clone(o) { return o; }';
    return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
  }
  return next(spec, context);
}
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
let threeStub = false;
try {
  await import('three');
} catch {
  threeStub = true;
  process.env.P10_THREE_STUB = '1';
}
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

const A = await import('../../src/ped-ambient.js');
const { NpcBrain, createBrainGroup, FILM_MIN_DIST, FILM_MIN_TIME, FILM_MAX_TIME } = await import('../../src/npc-ai.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 假世界 ----------
const stagger = {
  shouldTick(index, frame, every) {
    if (every <= 1) return every === 1;
    return (frame + index) % every === 0;
  },
};

function fakeAnim() {
  return {
    amb: null,
    gestures: [],
    setAmbient(n) {
      this.amb = n;
      return true;
    },
    playGesture(n) {
      this.gestures.push(n);
      return 1;
    },
  };
}

function fakeBrain() {
  return { state: 'wander', filming: false, filmChance: 0, threatened: null, onThreatened(t) { this.threatened = t || {}; } };
}

// 一條沿 x 的直線人行道上來回走（|x| ≤ half），z 固定；kind = route.kind
function makePed(i, x, z, { kind = 'sidewalk', level = 'near', dir = 1, half = 60, brain = null } = {}) {
  const actor = { id: `ped-${i}`, kind: 'pedestrian', pos: { x, y: 0, z }, yaw: 0 };
  const p = {
    slot: i, x, y: 0, z, yaw: dir > 0 ? Math.PI / 2 : -Math.PI / 2, speed: 1.2 + ((i * 37) % 10) / 25, dir, half,
    state: 'walk', route: { kind }, citizen: { level }, actor, anim: fakeAnim(), pace: 1, faceHold: null,
  };
  p.brain = brain || fakeBrain();
  if (p.brain.actor === undefined) p.brain.actor = actor;
  return p;
}

function walk(p, dt) {
  if (p.state !== 'walk') return;
  p.x += p.dir * p.speed * (p.pace ?? 1) * dt;
  if (p.x > p.half) p.dir = -1;
  if (p.x < -p.half) p.dir = 1;
  const want = p.faceHold ?? (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  p.yaw = want;
  p.actor.pos.x = p.x;
  p.actor.pos.z = p.z;
  p.actor.yaw = p.yaw;
}

function world(peds, player = null) {
  return { peds, frame: 0, stagger, context: { player, playerInVehicle: false } };
}

function step(amb, t, dt) {
  t.frame++;
  for (const p of t.peds) walk(p, dt);
  amb.update(t, dt);
  amb.updateBubbles(dt);
}

function crowd(n, { kinds = ['sidewalk', 'plaza'], seedZ = 0 } = {}) {
  const peds = [];
  for (let i = 0; i < n; i++) {
    const lane = i % 24;
    peds.push(makePed(i, ((i * 53) % 120) - 60, seedZ + lane * 1.3, { kind: kinds[i % kinds.length], level: i % 3 === 0 ? 'near' : 'mid', dir: i % 2 ? 1 : -1 }));
  }
  return peds;
}

function runRatio(hour, fps, seconds = 120, peds = crowd(147)) {
  const amb = A.createPedAmbient({ seed: 7 });
  amb.setContext({ hour });
  for (const p of peds) amb.attach(p);
  const t = world(peds);
  const dt = 1 / fps;
  let sum = 0;
  let n = 0;
  let lo = 1;
  let hi = 0;
  for (let k = 0; k < seconds * fps; k++) {
    step(amb, t, dt);
    if (k * dt >= 40) {
      const r = amb.stats.active / Math.max(1, amb.stats.eligible);
      sum += r;
      n++;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
  }
  return { mean: sum / n, lo, hi, amb, peds };
}

// ---------- 1. 活動比例 ----------
{
  const day = runRatio(12, 60);
  check('活動比例（日間 147 人、穩態 40–120 s 平均）約 25–40%', day.mean >= 0.25 && day.mean <= 0.4, `平均 ${(day.mean * 100).toFixed(1)}%、範圍 ${(day.lo * 100).toFixed(1)}–${(day.hi * 100).toFixed(1)}%`);
  check('活動比例穩定（穩態最低 ≥ 18%、最高 ≤ 45%）', day.lo >= 0.18 && day.hi <= 0.45, `${(day.lo * 100).toFixed(1)}–${(day.hi * 100).toFixed(1)}%`);
  const s = day.amb.stats;
  check('活動種類多樣（電話 / 東張西望 / 聊天群組都有）', s.started > 100 && s.chats > 0 && s.joins > 0, JSON.stringify({ started: s.started, chats: s.chats, joins: s.joins, waves: s.waves }));
  const night = runRatio(2, 60);
  check('深夜比例較低但仍在 20–35%', night.mean < day.mean && night.mean >= 0.2 && night.mean <= 0.35, `夜 ${(night.mean * 100).toFixed(1)}% < 日 ${(day.mean * 100).toFixed(1)}%`);
  // 夜市（熱點）時段：附近的人活動比例較高
  const hotPeds = crowd(147);
  const mk = A.DEFAULT_HOTSPOTS[0];
  for (let i = 0; i < 60; i++) {
    hotPeds[i].z = mk.z + (i % 12) * 1.3;
    hotPeds[i].x = mk.x + ((i * 7) % 40) - 20;
    hotPeds[i].half = Infinity;
  }
  const amb = A.createPedAmbient({ seed: 3 });
  amb.setContext({ hour: 20 });
  for (const p of hotPeds) amb.attach(p);
  const t = world(hotPeds);
  let hotSum = 0;
  let coldSum = 0;
  let n = 0;
  for (let k = 0; k < 90 * 60; k++) {
    step(amb, t, 1 / 60);
    if (k < 40 * 60) continue;
    let ha = 0;
    let ca = 0;
    for (let i = 0; i < hotPeds.length; i++) {
      const on = amb.activityOf(hotPeds[i]) ? 1 : 0;
      if (i < 60) ha += on;
      else ca += on;
    }
    hotSum += ha / 60;
    coldSum += ca / (hotPeds.length - 60);
    n++;
  }
  check('夜市時段熱點附近活動比例較高', hotSum / n > coldSum / n + 0.08, `熱點 ${((hotSum / n) * 100).toFixed(1)}%、其他 ${((coldSum / n) * 100).toFixed(1)}%`);
}

// ---------- 2. 聊天群組互相面對 ----------
{
  const amb = A.createPedAmbient({ seed: 11 });
  amb.setContext({ hour: 12 });
  const a = makePed(0, 0, 0, { kind: 'plaza' });
  const b = makePed(1, -6, 1.3, { kind: 'plaza', dir: 1 });
  const c = makePed(2, 7, -1.2, { kind: 'plaza', dir: -1 });
  const peds = [a, b, c];
  for (const p of peds) amb.attach(p);
  for (const p of peds) p.amb.cool = 999; // 不自行抽活動，只看聊天
  const t = world(peds);
  const started = amb.start(a, 'chat');
  let joinedB = -1;
  for (let k = 0; k < 8 * 60 && joinedB < 0; k++) {
    step(amb, t, 1 / 60);
    if (b.amb.group && b.amb.group === a.amb.group) joinedB = k;
  }
  const g = a.amb.group;
  for (let k = 0; k < 30; k++) step(amb, t, 1 / 60);
  const faces = (p, x, z) => {
    const fx = Math.sin(p.faceHold);
    const fz = Math.cos(p.faceHold);
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.hypot(dx, dz);
    return d < 1e-6 || (fx * dx + fz * dz) / d > 0.95;
  };
  check('聊天：發起者等人、路過 2.4 m 內的漫步者加入', started && joinedB >= 0 && g && g.n >= 2, `joined@${joinedB} n=${g && g.n}`);
  check('聊天：兩人互相面對（faceHold 指向對方）', g && faces(a, b.x, b.z) && faces(b, a.x, a.z) && a.pace === 0 && b.pace === 0, `a ${a.faceHold?.toFixed(2)} b ${b.faceHold?.toFixed(2)}`);
  let joinedC = false;
  for (let k = 0; k < 10 * 60 && !joinedC; k++) {
    step(amb, t, 1 / 60);
    joinedC = c.amb.group === g;
  }
  for (let k = 0; k < 30; k++) step(amb, t, 1 / 60);
  const cx = (a.x + b.x + c.x) / 3;
  const cz = (a.z + b.z + c.z) / 3;
  check('聊天：第三人加入後三人都面向群組中心', joinedC && g.n === 3 && [a, b, c].every((p) => faces(p, cx, cz)), `n=${g.n}`);
  const clips = new Set();
  let ended = false;
  for (let k = 0; k < 70 * 60 && !ended; k++) {
    step(amb, t, 1 / 60);
    for (const p of peds) if (p.anim.amb) clips.add(p.anim.amb);
    ended = !a.amb.act && !b.amb.act && !c.amb.act;
  }
  check('聊天：chat_gesture / look_around 交錯、20–60 s 後散開恢復漫步', clips.has('chat_gesture') && clips.has('look_around') && ended && peds.every((p) => p.pace === 1 && p.faceHold === null && p.anim.amb === null), [...clips].join(','));
  check('聊天：群組回池', !g.used);
}

// ---------- 3. 慢跑只在指定時段與區域 ----------
{
  const jogRun = (hour, kind) => {
    const peds = crowd(60, { kinds: [kind] });
    const amb = A.createPedAmbient({ seed: 5 });
    amb.setContext({ hour });
    for (const p of peds) amb.attach(p);
    const t = world(peds);
    let maxSpeed = 0;
    let bad = 0;
    for (let k = 0; k < 60 * 60; k++) {
      step(amb, t, 1 / 60);
      for (const p of peds) {
        if (p.amb.act !== 'jog') continue;
        maxSpeed = Math.max(maxSpeed, p.speed * p.pace);
        if (!A.JOG_KINDS.has(p.route.kind) || !A.isJogHour(hour) || p.anim.amb !== 'jog') bad++;
      }
    }
    return { jogs: amb.stats.jogs, maxSpeed, bad, amb, peds, t };
  };
  const am = jogRun(7, 'qiuhonggu');
  const pm = jogRun(18, 'footway');
  const noon = jogRun(12, 'qiuhonggu');
  const street = jogRun(7, 'sidewalk');
  check('慢跑：早上 7 時秋紅谷 / 傍晚 18 時步道有人慢跑、速度 2.8 m/s、播 jog', am.jogs > 0 && pm.jogs > 0 && am.bad === 0 && Math.abs(am.maxSpeed - A.JOG_SPEED) < 1e-9, `早 ${am.jogs}、晚 ${pm.jogs}、速度 ${am.maxSpeed.toFixed(2)}`);
  check('慢跑：中午 / 一般人行道不慢跑', noon.jogs === 0 && street.jogs === 0, `中午 ${noon.jogs}、人行道 ${street.jogs}`);
  am.amb.setContext({ hour: 9.5 });
  for (let k = 0; k < 30; k++) step(am.amb, am.t, 1 / 60);
  check('慢跑：時段結束即停（恢復原步速）', am.peds.every((p) => p.amb.act !== 'jog'), '');
}

// ---------- 4. 坐著休息：有座位才坐 ----------
{
  const amb = A.createPedAmbient({ seed: 2 });
  const p = makePed(0, 0, 0);
  amb.attach(p);
  const t = world([p]);
  const noSeat = amb.start(p, 'sit');
  amb.setSeats([{ x: 0.5, z: 0.8, yaw: 1 }]);
  const sat = amb.start(p, 'sit');
  step(amb, t, 1 / 60);
  check('坐：沒有座位道具時略過、有座位（1.5 m 內）就坐 sit_idle 並面向座位方向', !noSeat && sat && p.anim.amb === 'sit_idle' && p.pace === 0 && p.faceHold === 1);
}

// ---------- 5. 拍片目擊者 ----------
{
  // npc-ai 分流：8 m 內目擊者（filmChance = 1）走開到 ≥ 8 m 後面向事發點拍 5–10 s
  const ev = { x: 0, z: 0 };
  const actor = { id: 'film-0', kind: 'pedestrian', pos: { x: 3, y: 0, z: 1 }, yaw: 0 };
  const brain = new NpcBrain({ actor });
  brain.filmChance = 1;
  brain.onWitness(ev, null);
  let t = 0;
  let standAt = -1;
  let minDistFilming = Infinity;
  let faceOk = true;
  let endAt = -1;
  for (let k = 0; k < 30 * 60; k++) {
    const it = brain.update(1 / 60, {});
    if (brain.state === 'watch' && brain.filming) {
      actor.pos.x += it.moveX * 1.3 * (1 / 60);
      actor.pos.z += it.moveZ * 1.3 * (1 / 60);
      if (brain.filmStart >= 0) {
        if (standAt < 0) standAt = t;
        const d = Math.hypot(actor.pos.x - ev.x, actor.pos.z - ev.z);
        minDistFilming = Math.min(minDistFilming, d);
        const want = Math.atan2(ev.x - actor.pos.x, ev.z - actor.pos.z);
        if (it.faceYaw !== null && Math.abs(Math.atan2(Math.sin(it.faceYaw - want), Math.cos(it.faceYaw - want))) > 0.05) faceOk = false;
        if (it.moveX || it.moveZ) faceOk = false;
      }
    } else if (standAt >= 0 && endAt < 0) endAt = t;
    t += 1 / 60;
  }
  const filmT = endAt - standAt;
  check('拍片（npc-ai）：目擊者走開到 ≥ 8 m 才拍、面向事發點不動', standAt >= 0 && minDistFilming >= FILM_MIN_DIST - 1e-6 && faceOk, `距離 ${minDistFilming.toFixed(2)} m`);
  check('拍片（npc-ai）：持續 5–10 s 後回漫步', filmT >= FILM_MIN_TIME - 0.05 && filmT <= FILM_MAX_TIME + 0.05 && brain.state === 'wander' && !brain.filming, `${filmT.toFixed(2)} s → ${brain.state}`);
  // 比例：filmChance 0.3 → 約 30% 目擊者拍片；其餘照舊（圍觀 / 逃跑）；filmChance 0 → 沒有人拍
  let films = 0;
  let watch = 0;
  let flee = 0;
  let filmsOff = 0;
  for (let i = 0; i < 400; i++) {
    for (const on of [true, false]) {
      const b = new NpcBrain({ actor: { id: `w-${i}`, kind: 'pedestrian', pos: { x: 2, y: 0, z: 2 }, yaw: 0 } });
      b.filmChance = on ? A.FILM_CHANCE : 0;
      b.onWitness(ev, null);
      b.update(1 / 60, {});
      if (!on) {
        if (b.filming) filmsOff++;
        continue;
      }
      if (b.state === 'watch' && b.filming) films++;
      else if (b.state === 'watch') watch++;
      else if (b.state === 'flee') flee++;
    }
  }
  check('拍片（npc-ai）：約 30% 目擊者拍片、其餘照舊圍觀 / 逃跑；filmChance 0（預設）時無人拍', films >= 400 * 0.22 && films <= 400 * 0.38 && films + watch + flee === 400 && filmsOff === 0, `拍 ${films}、圍觀 ${watch}、逃 ${flee}`);

  // ped-ambient：遠處（8–25 m）漫步者看到打架 → 約 30% 停下拍（phone_film、面向事發點）
  const amb = A.createPedAmbient({ seed: 9 });
  const peds = [];
  for (let i = 0; i < 200; i++) {
    const ang = (i / 200) * Math.PI * 2 * 7;
    const r = 4 + (i % 25);
    peds.push(makePed(i, Math.cos(ang) * r, Math.sin(ang) * r, { half: Infinity }));
  }
  for (const p of peds) {
    amb.attach(p);
    p.amb.cool = 999;
  }
  const w = world(peds);
  amb.notify({ type: 'incident', x: 0, z: 0, kind: 'fight' });
  for (let k = 0; k < 20; k++) step(amb, w, 1 / 60);
  let inBand = 0;
  let filming = 0;
  let ok = true;
  for (const p of peds) {
    const d0 = Math.hypot(p.x, p.z);
    if (d0 >= A.FILM_MIN_DIST && d0 <= A.FILM_RADIUS) inBand++;
    if (p.amb.act !== 'film') continue;
    filming++;
    const want = Math.atan2(-p.x, -p.z);
    if (d0 < A.FILM_MIN_DIST || p.anim.amb !== 'phone_film' || p.pace !== 0 || Math.abs(Math.atan2(Math.sin(p.faceHold - want), Math.cos(p.faceHold - want))) > 1e-6) ok = false;
  }
  check('拍片（ped-ambient）：遠處約 30% 漫步者停下拍、距離 ≥ 8 m 且面向事發點', ok && filming >= inBand * 0.18 && filming <= inBand * 0.42, `${filming} / ${inBand}`);
  amb.notify({ type: 'incident', x: 0.5, z: 0.5, kind: 'fight' });
  check('事件合併：同一處未過期的騷動不重複觸發', amb.incidents.filter((s) => s.id > 0).length === 1);
}

// ---------- 6. 被瞄準 cower → 之後逃跑 ----------
{
  const amb = A.createPedAmbient({ seed: 4 });
  const player = { id: 'player', kind: 'player', pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const aimed = makePed(0, 0.4, 6, { brain: new NpcBrain({ actor: { id: 'ped-0', kind: 'pedestrian', pos: { x: 0.4, y: 0, z: 6 }, yaw: 0 } }) });
  aimed.actor = aimed.brain.actor;
  const far = makePed(1, 0, 14);
  const side = makePed(2, 5, 3);
  const peds = [aimed, far, side];
  for (const p of peds) amb.attach(p);
  for (const p of peds) p.half = Infinity;
  const t = world(peds, player);
  amb.setContext({ aiming: true, aimDirX: 0, aimDirZ: 1 });
  step(amb, t, 1 / 60);
  const cowered = aimed.anim.amb === 'cower' && aimed.pace === 0;
  const facing = Math.abs(aimed.faceHold - Math.atan2(-aimed.x, -aimed.z)) < 1e-6;
  check('瞄準：10 m 內瞄準線上的市民 cower、停下面向玩家；10 m 外 / 偏離瞄準線的不受影響', cowered && facing && far.anim.amb !== 'cower' && side.anim.amb !== 'cower', `${aimed.anim.amb} / ${far.anim.amb} / ${side.anim.amb}`);
  amb.setContext({ aiming: false });
  let fled = false;
  for (let k = 0; k < 3 * 60 && !fled; k++) {
    step(amb, t, 1 / 60);
    aimed.brain.update(1 / 60, {});
    fled = aimed.brain.state === 'flee';
  }
  check('瞄準：蹲縮完照既有邏輯逃跑（brain flee、逃離玩家）', fled && aimed.brain.fleeFrom && aimed.brain.fleeFrom.actor === player && amb.stats.cowers === 1);
}

// ---------- 7. 衝刺撞到 → angry_shout + 台詞（池上限 3、2 s 淡出） ----------
{
  const views = [];
  const pool = A.createBubblePool({
    makeSlot: (i) => {
      const v = { i, text: '', opacity: 0, visible: false, x: 0, y: 0, z: 0 };
      views.push(v);
      return {
        setText: (s) => (v.text = s),
        setOpacity: (o) => (v.opacity = o),
        setVisible: (b) => (v.visible = b),
        setPosition: (x, y, z) => Object.assign(v, { x, y, z }),
      };
    },
  });
  const amb = A.createPedAmbient({ seed: 6, bubbles: pool });
  const player = { id: 'player', kind: 'player', pos: { x: -10, y: 0, z: 0 }, yaw: Math.PI / 2 };
  const peds = [];
  for (let i = 0; i < 5; i++) peds.push(makePed(i, i * 3, 0.4, { half: Infinity, dir: -1 }));
  for (const p of peds) {
    amb.attach(p);
    p.amb.cool = 999;
  }
  const t = world(peds, player);
  let maxActive = 0;
  for (let k = 0; k < 200; k++) {
    player.pos.x += 8.5 / 60; // 衝刺 8.5 m/s 沿 z = 0 擦過每個人
    step(amb, t, 1 / 60);
    maxActive = Math.max(maxActive, pool.active, views.filter((v) => v.visible).length);
  }
  const shouted = peds.filter((p) => p.anim.gestures.includes('angry_shout')).length;
  check('衝撞：被撞者 angry_shout、轉向玩家', shouted === 5 && amb.stats.shouts === 5, `${shouted} / 5`);
  check('台詞：取自台詞池、同時最多 3 個（池化 3 張 sprite）', views.length === 3 && maxActive <= 3 && maxActive >= 2 && views.every((v) => !v.text || A.SHOUT_LINES.includes(v.text)), `同時 ${maxActive}`);
  const mid = views.find((v) => v.visible);
  for (let k = 0; k < 60; k++) amb.updateBubbles(1 / 60);
  const fading = mid && mid.opacity < 1 && mid.opacity > 0;
  for (let k = 0; k < 120; k++) amb.updateBubbles(1 / 60);
  check('台詞：跟著頭頂、淡出後 2 s 內消失', fading && pool.active === 0 && views.every((v) => !v.visible), `opacity ${mid && mid.opacity.toFixed(2)}`);
  const slow = A.createPedAmbient({ seed: 6, bubbles: pool });
  const q = makePed(9, 0, 0.3, { half: Infinity });
  slow.attach(q);
  const pl = { id: 'player', pos: { x: -3, y: 0, z: 0 } };
  const t2 = world([q], pl);
  for (let k = 0; k < 120; k++) {
    pl.pos.x += 3 / 60; // 步行速度擦過不算
    step(slow, t2, 1 / 60);
  }
  check('衝撞：步行擦過不罵人', slow.stats.shouts === 0);
}

// ---------- 8. 大腦狀態的動畫對應：喇叭 look → look_around ----------
{
  const amb = A.createPedAmbient({ seed: 1 });
  const actor = { id: 'h-0', kind: 'pedestrian', pos: { x: 3, y: 0, z: 8 }, yaw: 0 }; // 離喇叭軸線 3 m：人行道上（不側跳）
  const p = makePed(0, 3, 8, { brain: new NpcBrain({ actor }) });
  p.actor = actor;
  amb.attach(p);
  amb.start(p, 'phone_text');
  const t = world([p]);
  p.brain.hear({ type: 'horn', x: 0, z: 0, dirX: 0, dirZ: 1 });
  p.brain.update(1 / 60, {});
  step(amb, t, 1 / 60);
  step(amb, t, 1 / 60);
  const during = p.anim.amb;
  const st = p.brain.state;
  check('喇叭：車前 15 m 內行人轉頭看（brain look → look_around），原活動取消', (st === 'look' && during === 'look_around') || (st === 'glare' && p.anim.gestures.includes('angry_shout')), `${st} / ${during} / act=${p.amb.act}`);
}

// ---------- 9. 幀率無關 ----------
{
  const durAt = (fps) => {
    const amb = A.createPedAmbient({ seed: 21 });
    const p = makePed(3, 0, 0, { level: 'mid' });
    amb.attach(p);
    p.amb.cool = 999;
    amb.start(p, 'phone_talk');
    const t = world([p]);
    let sim = 0;
    while (p.amb.act && sim < 60) {
      step(amb, t, 1 / fps);
      sim += 1 / fps;
    }
    return sim;
  };
  const d30 = durAt(30);
  const d60 = durAt(60);
  const d144 = durAt(144);
  const tol = A.EVERY_MID / 30 + 1e-9;
  check('幀率無關：同一活動的持續模擬秒數 30 / 60 / 144 Hz 一致（≤ 一個判斷間隔）', Math.abs(d30 - d60) <= tol && Math.abs(d144 - d60) <= tol, `${d30.toFixed(3)} / ${d60.toFixed(3)} / ${d144.toFixed(3)} s`);
  const r30 = runRatio(12, 30, 100);
  const r144 = runRatio(12, 144, 100);
  check('幀率無關：30 / 144 Hz 活動比例都在 25–40%', [r30.mean, r144.mean].every((m) => m >= 0.25 && m <= 0.4), `${(r30.mean * 100).toFixed(1)}% / ${(r144.mean * 100).toFixed(1)}%`);
}

// ---------- 10. 無每幀配置 + 效能（high 147 人） ----------
{
  const peds = crowd(147);
  const amb = A.createPedAmbient({ seed: 13 });
  amb.setContext({ hour: 18 });
  for (const p of peds) amb.attach(p);
  const player = { id: 'player', pos: { x: 0, y: 0, z: 5 } };
  const t = world(peds, player);
  for (let k = 0; k < 30 * 60; k++) step(amb, t, 1 / 60);
  const allocs0 = amb.stats.allocs;
  const started0 = amb.stats.started;
  // 量測：只算 ambient.update（不含假世界的走路）
  let total = 0;
  let worst = 0;
  const N = 1800;
  for (let k = 0; k < N; k++) {
    t.frame++;
    for (const p of peds) walk(p, 1 / 60);
    if (k % 300 === 0) amb.setContext({ aiming: k % 600 === 0, aimDirX: 1, aimDirZ: 0 });
    const t0 = process.hrtime.bigint();
    amb.update(t, 1 / 60);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    total += ms;
    worst = Math.max(worst, ms);
  }
  const avg = total / N;
  check('無每幀配置：穩態 30 s 內配置計數器不增加（活動照常開始 / 結束）', amb.stats.allocs === allocs0 && amb.stats.started > started0, `allocs ${allocs0} → ${amb.stats.allocs}、started +${amb.stats.started - started0}`);
  check('效能：high 檔 147 人每幀新增成本 < 0.3 ms', avg < 0.3, `平均 ${avg.toFixed(4)} ms、最大 ${worst.toFixed(3)} ms`);
}

// ---------- 11. walkPed：pace / faceHold ----------
{
  const P = await import('../../src/traffic-peds.js');
  const { polylineInfo } = await import('../../src/geom.js');
  const road = polylineInfo([0, 0, 100, 0]);
  const tt = { _tmp: { x: 0, z: 0, dx: 0, dz: 1, seg: 0 }, _q: {}, terrain: { querySurface: () => ({ y: 0 }) } };
  const mk = (pace, faceHold) => ({ road, off: 2, s: 50, s0: 0, s1: 100, dir: 1, speed: 1.4, x: 0, y: 0, z: 0, yaw: 0, pace, faceHold });
  const base = mk(undefined, undefined);
  const stop = mk(0, 2);
  const jog = mk(2, null);
  let db = 0;
  let ds = 0;
  let dj = 0;
  for (let k = 0; k < 60; k++) {
    db += P.walkPed(tt, base, 1 / 60);
    ds += P.walkPed(tt, stop, 1 / 60);
    dj += P.walkPed(tt, jog, 1 / 60);
  }
  check('walkPed：pace 缺欄位 = 原速、0 = 停下並轉向 faceHold、2 = 加倍', Math.abs(db - 1.4) < 1e-9 && ds === 0 && Math.abs(dj - 2.8) < 1e-9 && Math.abs(stop.yaw - 2) < 1e-3 && Math.abs(base.yaw - Math.PI / 2) < 1e-3, `${db.toFixed(3)} / ${ds} / ${dj.toFixed(3)} yaw ${stop.yaw.toFixed(3)}`);
}

// ---------- 12. animator：缺 clip 退回 / overlay ----------
{
  let An = null;
  try {
    An = await import('../../src/characters/animator.js');
  } catch (e) {
    check('animator 載入', false, String(e && e.message));
  }
  if (An) {
    const track = (bone) => ({ name: `${bone}.quaternion`, clone() { return { ...this }; } });
    const clip = (name, duration = 1) => ({ name, duration, tracks: [track('Hips'), track('Spine'), track('LeftUpperLeg')], clone() { return { ...this, tracks: this.tracks.map((t) => t.clone()) }; } });
    const makeMixer = () => {
      const actions = new Map();
      return {
        actions,
        clipAction(c) {
          if (!actions.has(c)) actions.set(c, { clip: c, w: 0, ts: 1, playing: false, setLoop() {}, reset() { return this; }, play() { this.playing = true; return this; }, stop() { this.playing = false; return this; }, setEffectiveWeight(w) { this.w = w; return this; }, setEffectiveTimeScale(s) { this.ts = s; return this; }, crossFadeTo() { return this; } });
          return actions.get(c);
        },
        update() {},
        stopAllAction() { for (const a of actions.values()) a.playing = false; },
      };
    };
    const base = ['idle', 'walk', 'run', 'jump', 'punch', 'hit', 'knockdown', 'getup', 'enter_car', 'drive'];
    const info = console.info;
    const warn = console.warn;
    const infos = [];
    const warns = [];
    console.info = (m) => infos.push(m);
    console.warn = (m) => warns.push(m);
    const ch = { mixer: makeMixer(), clips: new Map(base.map((n) => [n, clip(n)])), fallback: false, root: {} };
    const anim = new An.CharacterAnimator(ch, []);
    console.info = info;
    console.warn = warn;
    const used = Object.fromEntries(anim.ambientMissing.map((m) => [m.state, m.used]));
    check('animator：缺 11 個生活行為 clip → 退回規則（jog→run、cower→hit、phone / chat / look / sit / 手勢→idle）',
      anim.ambientMissing.length === 11 && used.jog === 'run' && used.cower === 'hit' && used.phone_talk === 'idle' && used.sit_idle === 'idle' && used.wave === 'idle',
      JSON.stringify(used));
    check('animator：生活行為缺檔不記入 missing、不逐個 warn（既有斷言不受影響）', !anim.missing.some((m) => A.AMBIENT_CLIPS.includes(m.state)) && warns.length === 0 && infos.filter((m) => String(m).includes('生活行為')).length <= 1, `missing ${anim.missing.length}、warn ${warns.length}`);
    let threw = null;
    try {
      const okPhone = anim.setAmbient('phone_talk');
      for (let k = 0; k < 30; k++) anim.update(1 / 60, { speed: 0 });
      const okJog = anim.setAmbient('jog');
      for (let k = 0; k < 30; k++) anim.update(1 / 60, { speed: 2.8 });
      const jogAct = [...ch.mixer.actions.values()].find((a) => a.clip.name === 'jog<-run');
      const g = anim.playGesture('wave');
      for (let k = 0; k < 30; k++) anim.update(1 / 60, { speed: 2.8 });
      check('animator：缺 clip 時 setAmbient / playGesture 照常（jog 以 run 副本疊加、速率依 run 參考速度、手勢只計時）',
        okPhone && okJog && jogAct && jogAct.playing && jogAct.w > 100 && Math.abs(jogAct.ts - 0.6) < 1e-9 && g > 0 && anim.state === 'walk',
        `jog w=${jogAct && jogAct.w.toFixed(1)} ts=${jogAct && jogAct.ts}`);
      anim.trigger('knockdown');
      for (let k = 0; k < 30; k++) anim.update(1 / 60, { speed: 0 });
      check('animator：倒地時 overlay 淡出且不接受新的', anim.ambient === null && jogAct.w === 0 && !jogAct.playing && anim.setAmbient('cower') === false);
    } catch (e) {
      threw = e;
    }
    check('animator：overlay 過程無例外', !threw, threw ? String(threw.stack || threw) : '');
    // 有 clip：全身 sit_idle 權重淡入到 AMBIENT_FULL_WEIGHT、上半身 phone_text 濾掉下半身軌道
    const ch2 = { mixer: makeMixer(), clips: new Map([...base, ...A.AMBIENT_CLIPS].map((n) => [n, clip(n)])), fallback: false, root: {} };
    const a2 = new An.CharacterAnimator(ch2, []);
    a2.setAmbient('sit_idle');
    for (let k = 0; k < 30; k++) a2.update(1 / 60, { speed: 0 });
    const sit = ch2.mixer.actions.get(ch2.clips.get('sit_idle'));
    a2.setAmbient('phone_text');
    for (let k = 0; k < 30; k++) a2.update(1 / 60, { speed: 0 });
    const phone = [...ch2.mixer.actions.values()].find((a) => a.clip.name === 'phone_text<-phone_text');
    check('animator：clip 齊全 → ambientMissing 0、全身 overlay 權重 200、換上半身 overlay 時舊的淡出、上半身濾掉腿部軌道',
      a2.ambientMissing.length === 0 && sit && sit.w === 0 && !sit.playing && phone && phone.w === An.AMBIENT_UPPER_WEIGHT && phone.clip.tracks.every((t) => !t.name.startsWith('LeftUpperLeg')),
      `sit w=${sit && sit.w} phone w=${phone && phone.w} tracks=${phone && phone.clip.tracks.map((t) => t.name).join(',')}`);
    if (threeStub) console.log('INFO  animator 段使用 three 替身（容器內無 node_modules）；宿主有 three 時用真的');
  }
}

// ---------- 13. 倒地 / 被拖出的司機 / 打鬥中不被生活行為介入；活動不擋回收（traffic-flow 回歸） ----------
{
  // 倒地中（大腦剛建好仍是 wander）、走回路線中、被拖出待起身的司機：玩家衝刺擦過 + 持槍瞄準都不起反應、不排活動
  const amb = A.createPedAmbient({ seed: 21 });
  amb.setContext({ hour: 12, aiming: true, aimDirX: 1, aimDirZ: 0 });
  const player = { id: 'player', kind: 'player', pos: { x: -2, y: 0, z: 0 }, yaw: Math.PI / 2 };
  const down = makePed(0, 1, 0.2, { half: Infinity });
  const ret = makePed(1, 3, -0.2, { half: Infinity });
  const ejected = makePed(2, 5, 0.1, { half: Infinity });
  const fighter = makePed(3, 7, 0.3, { half: Infinity });
  const peds = [down, ret, ejected, fighter];
  for (const p of peds) amb.attach(p);
  down.state = 'down';
  ret.state = 'return';
  ejected.state = 'getup';
  ejected.pendingFrom = { x: 5, z: 2 };
  fighter.brain.state = 'fight';
  for (const p of peds) p.amb.cool = 0;
  const t = world(peds, player);
  let touched = 0;
  for (let k = 0; k < 120; k++) {
    player.pos.x += 8.5 / 60; // 衝刺沿 z ≈ 0 擦過每個人，同時瞄準 +x
    step(amb, t, 1 / 60);
    for (const p of peds) if (p.amb.act || p.amb.react || p.pace !== 1 || p.faceHold !== null || p.anim.gestures.length || p.brain.threatened) touched++;
  }
  const notified = peds.map((p) => amb.notify({ type: 'bump', ped: p, from: player }) || amb.notify({ type: 'aim', ped: p, from: player }));
  const started = peds.map((p) => amb.start(p, 'phone_talk'));
  check('不介入：倒地 / 走回路線 / 被拖出待起身 / 打鬥中者不被衝撞罵人、瞄準蹲縮、活動影響（pace / faceHold / 手勢 / onThreatened 皆不動）',
    touched === 0 && amb.stats.shouts === 0 && amb.stats.cowers === 0 && notified.every((v) => !v) && started.every((v) => !v),
    `touched ${touched}、shouts ${amb.stats.shouts}、cowers ${amb.stats.cowers}、notify ${notified.join(',')}、start ${started.join(',')}`);
}
{
  // 真 NpcBrain：被拖出的司機起身後只看性格（倒地中被威脅 / 目擊記下逃離對象、搶車者當下倒地，都不改變還手 / 逃跑）
  const group = createBrainGroup();
  const isDown = new Set();
  const combat = { isDown: (a) => isDown.has(a), requestPunch: () => true };
  const ctx = { combat };
  const attacker = { id: 'player', kind: 'player', pos: { x: 0.6, y: 0, z: 0 }, yaw: 0, hp: 100 }; // 出拳距離內
  const pick = (want) => {
    for (let i = 0; i < 500; i++) {
      const actor = { id: `ej-${i}`, kind: 'pedestrian', pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
      const b = new NpcBrain({ actor, heavy: i % 2 === 0, seed: 1, group });
      if (b.fights === want) return b;
    }
    return null;
  };
  const run = (b, attackerDown) => {
    group.brains.set(b.actor.id, b);
    isDown.add(b.actor);
    b.update(1 / 60, ctx); // 倒地中
    b.onThreatened(attacker); // 生活行為的 threat / 目擊恐慌：倒地中只記下逃離對象
    b.onWitness({ x: 0.5, z: 0 }, attacker);
    b.update(1 / 60, ctx);
    const remembered = !!b.fleeFrom;
    isDown.delete(b.actor);
    if (attackerDown) isDown.add(attacker);
    else isDown.delete(attacker);
    b.onAttacked({ attacker, ejected: true }); // traffic-peds thinkPeds：起身後才交給大腦
    const states = [];
    let punched = false;
    let early = false;
    for (let k = 0; k < 90; k++) {
      if (k === 45) isDown.delete(attacker); // 搶車者起身
      const it = b.update(1 / 60, ctx);
      states.push(b.state);
      if (it.wantPunch && k < 45) early = true;
      if (it.wantPunch && k >= 45) punched = true;
    }
    group.brains.delete(b.actor.id);
    isDown.delete(attacker);
    return { remembered, first: states[0], states, punched, early };
  };
  const brave = pick(true);
  const timid = pick(false);
  const bUp = run(brave, false);
  check('被拖出的司機（brave）：倒地中被威脅 / 目擊仍照性格還手（起身第一個狀態 fight）', bUp.remembered && bUp.first === 'fight', `${bUp.first}`);
  brave.state = 'wander';
  brave.fleeFrom = null;
  brave.grudge = null;
  const bDown = run(brave, true);
  const waited = bDown.states.slice(0, 45).every((s) => s === 'fight');
  check('被拖出的司機（brave）：搶車者當下倒地 / 起身中也還手——面向他等起身、不出拳，起身後才打', bDown.first === 'fight' && waited && !bDown.early && bDown.punched, `${bDown.first}、等待中維持 fight ${waited}、倒地中出拳 ${bDown.early}、起身後出拳 ${bDown.punched}`);
  const tUp = run(timid, true);
  check('被拖出的司機（timid）：照性格逃跑', tUp.first === 'flee', `${tUp.first}`);
  // 一般行人（非被拖出）：對象已倒地照舊不加入（既有規則不變）
  const other = pick(true);
  group.brains.set(other.actor.id, other);
  isDown.add(attacker);
  other.onAttacked({ attacker });
  other.update(1 / 60, ctx);
  isDown.delete(attacker);
  check('一般行人（brave）：對象已倒地照舊不加入還手（改逃跑，既有規則不變）', other.state === 'flee', other.state);
}
{
  // 活動不擋回收：活動中 ped.state 維持 walk（traffic._canRecycle / _stealVictim 只看 state、combat、視野）；
  // 活動中途 detach（回收 / 骨架被借走）→ 活動收尾、群組 / 座位釋放、pace / faceHold 歸位，同一骨架再 attach 可重用
  const r = runRatio(12, 60, 60);
  const active = r.peds.filter((p) => p.amb.act);
  const allWalk = active.every((p) => p.state === 'walk');
  const groupsUsed0 = r.amb.groups.filter((g) => g.used).length;
  for (const p of active) r.amb.detach(p);
  const clean = active.every((p) => !p.amb.act && !p.amb.group && p.pace === 1 && p.faceHold === null && p.anim.amb === null);
  const groupsLeft = r.amb.groups.filter((g) => g.used && g.members.slice(0, g.n).some((m) => active.includes(m))).length;
  check('活動不擋回收：活動中皆 state walk；中途 detach 收尾乾淨（群組不殘留已回收者）',
    active.length > 10 && allWalk && clean && groupsLeft === 0, `活動中 ${active.length} 人、walk ${allWalk}、群組 ${groupsUsed0} → 殘留 ${groupsLeft}`);
}

// ---------- 回歸（cr-p10-beh）：事件 slot 繞回、持續騷動不重擲、下車 / 瞬移不誤判衝撞 ----------
{
  // slot 繞回後 id 順序 ≠ slot 順序：同時有效、id 較小的近處事件不能被 id 較大的遠處事件擋掉
  const amb = A.createPedAmbient({ seed: 1 });
  amb.setContext({ hour: 12 });
  const peds = [];
  for (let i = 0; i < 300; i++) peds.push(makePed(i, 15 + (i % 10), (i % 30) * 0.5 - 7, { half: Infinity }));
  for (const p of peds) {
    amb.attach(p);
    p.amb.cool = 1e9;
    p.speed = 0;
  }
  const w = world(peds);
  for (let k = 0; k < 3; k++) {
    amb.notify({ type: 'incident', x: 5000 + k * 100, z: 0 }); // 遠處、隨後過期
    step(amb, w, 0.6);
  }
  amb.notify({ type: 'incident', x: 0, z: 0, kind: 'fight' }); // 近處（id 4）
  amb.notify({ type: 'incident', x: 900, z: 0, kind: 'fight' }); // 遠處（id 5，繞回到較前面的 slot）
  const order = amb.incidents.map((s) => s.id);
  for (let f = 0; f < 4; f++) step(amb, w, 1 / 60);
  const films = amb.stats.films;
  check('事件 slot 繞回：id 較小的有效事件不被跳過（約 30% 拍片）', order.indexOf(5) < order.indexOf(4) && films >= 300 * 0.18 && films <= 300 * 0.42, `slots ${order.join(',')}、拍 ${films} / 300`);
}
{
  // 同一處持續打 20 s（每 0.4 s 一拳）：合併時刷新 age、沿用原 id，每人只擲一次 FILM_CHANCE
  const amb = A.createPedAmbient({ seed: 1 });
  amb.setContext({ hour: 12 });
  const peds = [];
  for (let i = 0; i < 200; i++) peds.push(makePed(i, 12 + (i % 10), (i % 20) * 0.5 - 5, { half: Infinity }));
  for (const p of peds) {
    amb.attach(p);
    p.amb.cool = 1e9;
    p.speed = 0;
  }
  const w = world(peds);
  const filmed = new Set();
  for (let f = 0; f < 20 * 60; f++) {
    if (f % 24 === 0) amb.notify({ type: 'incident', x: 0, z: 0, kind: 'fight' });
    step(amb, w, 1 / 60);
    for (const p of peds) if (p.amb.act === 'film') filmed.add(p);
  }
  const ids = new Set(amb.incidents.filter((s) => s.id > 0).map((s) => s.id));
  const ratio = filmed.size / peds.length;
  check('持續騷動：同處打 20 s 只算一個事件，曾拍片比例 ≈ FILM_CHANCE', ids.size === 1 && ratio >= A.FILM_CHANCE - 0.12 && ratio <= A.FILM_CHANCE + 0.12, `事件 ${ids.size} 個、曾拍片 ${filmed.size} / ${peds.length}`);
}
{
  // 開車時 actor.pos 停在上車點；下車 = actor.pos 瞬移到車門旁 → 不罵人
  const amb = A.createPedAmbient({ seed: 1, bubbles: A.createBubblePool() });
  const player = { id: 'player', kind: 'player', pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const ped = makePed(0, 300.6, 0, { half: Infinity });
  const w = world([ped], player);
  amb.attach(ped);
  ped.amb.cool = 1e9;
  ped.speed = 0;
  for (let f = 0; f < 60; f++) step(amb, w, 1 / 60);
  w.context.playerInVehicle = true;
  for (let f = 0; f < 600; f++) step(amb, w, 1 / 60);
  w.context.playerInVehicle = false;
  player.pos.x = 300;
  for (let f = 0; f < 10; f++) step(amb, w, 1 / 60);
  const exitShouts = amb.stats.shouts;
  // 步行中瞬移（傳送）到行人旁：同樣不算衝撞
  player.pos.x = -500;
  ped.x = -500.5;
  ped.actor.pos.x = ped.x;
  ped.amb.shoutCool = 0;
  for (let f = 0; f < 10; f++) step(amb, w, 1 / 60);
  check('下車 / 瞬移：位置跳動不算衝刺、車門旁的人不罵人', exitShouts === 0 && amb.stats.shouts === 0 && !ped.amb.react && amb.bubbles.active === 0, `下車 ${exitShouts}、瞬移後 ${amb.stats.shouts}、react ${ped.amb.react}`);
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
