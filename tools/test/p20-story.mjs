#!/usr/bin/env node
// P20 故事任務線第一章無頭測試：src/missions/story.js（純邏輯 + 替身世界）+ 真 gangs.js / save.js / events.js
// 用法：node tools/test/p20-story.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：常數 / 對白長度、阿海與對手幫派由 gangs 資料決定、據點在對手地盤內；接任務條件（步行 / 站在 S / 互斥 busy / 凍結）；
//   對白（下一句 / 整段跳過 / 自動下一句 / 開場對白中不計時）；S1 送貨（上車 → 送達入帳、時間到、通緝 ≥ 2 查扣、耐久 < 40% 貨毀、車消失）；
//   S2 追債（找生成點、接近才逃、逃竄速度、耐久歸零 / 低速 3 s 撞停 → 下車 → KO 完成、時間到、甩開、nospawn）；
//   S3 清場（抵達徵用、擊倒計數只算對手 byPlayer 且同人一次、增援、補人、離開失敗、完成後敵意上升）；
//   賞金與章節獎勵只發一次、BUSTED / WASTED 失敗、cancel 無聲、無限重試、serialize / restore 與 save.js 舊存檔相容、
//   snapshot / 標記重用、createStoryCarDepot、gangs.provokeGang（真模組）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { validateSave, defaultSave } from '../../src/save.js';
import { createGangs, GANGS, territoryAt } from '../../src/gangs.js';
import {
  createStory,
  createStoryCarDepot,
  createStoryHud,
  buildChapter,
  contactGang,
  rivalGang,
  strongholdOf,
  traitorSpeed,
  storyRecord,
  formatClock,
  CHAPTER,
  CHAPTER_TITLE,
  CONTACT,
  VAN_SPOT,
  VAN_TYPE,
  DROP,
  DROP_RADIUS,
  S1_LIMIT,
  S2_LIMIT,
  WANTED_FAIL,
  CARGO_MIN,
  TRAITOR_SPOT,
  TRAITOR_SPOT_DIST,
  STOP_SEC,
  STOP_NEAR,
  SPAWN_TIMEOUT_SEC,
  CAR_ESCAPE_DIST,
  ESCAPE_DIST,
  GOAL,
  FIRST_WAVE,
  REINFORCE_AT,
  REINFORCE_WAVE,
  ARRIVE_RADIUS,
  LEAVE_DIST,
  HOSTILITY_GAIN,
  REWARDS,
  CHAPTER_BONUS,
  REWARD_CAR,
  LINE_SEC,
  LINE_MAX,
  STORY_SKIP_KEY,
  MARKER_KIND,
  TARGET_KIND,
  STORY_IDS,
  START_RADIUS,
  PROMPT_NEXT,
  TRAITOR_SPEED_MIN,
  TRAITOR_SPEED_MAX,
} from '../../src/missions/story.js';
import { KO_LIMIT, SHORT_SEC, SPAWN_SEC, MIN_ALIVE, PROMPT_WANTED, WRECK_CLEAR } from '../../src/missions/story.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 替身世界 ----------
function makeWorld() {
  const w = {
    vans: [],
    released: [],
    traitorCars: [],
    removed: [],
    drives: [],
    gangSpawns: [],
    gangReleases: 0,
    provoked: [],
    spawnPointOk: true,
    downActors: new Set(),
    vanHealth: 1,
    vanExists: true,
    traitor: { x: 0, z: 0, speed: 0, health: 1000, exists: true },
    actor: null,
    alive: 0,
    spawnVan(spot) {
      const v = { pos: { x: spot.x, z: spot.z }, yaw: spot.yaw, type: VAN_TYPE };
      w.vans.push(v);
      w.vanExists = true;
      w.vanHealth = 1;
      return v;
    },
    vanState: () => ({ exists: w.vanExists, health: w.vanHealth }),
    releaseVan: (v) => w.released.push(v),
    spawnPoint: (x, z) => (w.spawnPointOk ? { x: x + 20, z, heading: 0 } : null),
    spawn(pt) {
      const h = { id: w.traitorCars.length + 1 };
      w.traitorCars.push(h);
      w.traitor.x = pt.x;
      w.traitor.z = pt.z;
      w.traitor.speed = 0;
      w.traitor.health = 1000;
      w.traitor.exists = true;
      return h;
    },
    state: () => w.traitor,
    drive: (h, c) => w.drives.push({ h, x: c.x, z: c.z, maxSpeed: c.maxSpeed }),
    eject() {
      w.actor = { id: 'traitor', pos: { x: w.traitor.x + 2, z: w.traitor.z } };
      return w.actor;
    },
    remove: (h) => w.removed.push(h),
    isDown: (a) => w.downActors.has(a),
    actorPos: (a) => (a ? a.pos : null),
    aliveGang: () => w.alive,
    spawnGang(id, x, z, n) {
      w.gangSpawns.push({ id, n });
      w.alive += n;
      return n;
    },
    releaseGang: () => {
      w.gangReleases++;
    },
    provokeGang: (id, gain) => w.provoked.push({ id, gain }),
  };
  return w;
}

function setup(opts = {}) {
  const bus = createBus();
  const events = [];
  for (const n of ['story:start', 'story:stage', 'story:complete', 'story:fail', 'story:chapter']) bus.on(n, (e) => events.push({ n, e }));
  const gangMap = new Map();
  const story = createStory({ bus, rng: () => 0.5, gangOf: (a) => gangMap.get(a) || null, ...opts });
  const world = makeWorld();
  const earned = [];
  const toasts = [];
  let saves = 0;
  const ctx = {
    player: { x: CONTACT.x, z: CONTACT.z },
    onFoot: true,
    vehicle: null,
    topSpeed: 42,
    wantedStars: 0,
    busy: false,
    frozen: false,
    world,
    earn: (n, reason) => earned.push({ n, reason }),
    toast: (text) => toasts.push(text),
    save: () => saves++,
  };
  const step = (sec, dt = 0.05) => {
    let s;
    for (let t = 0; t < sec - 1e-9; t += dt) s = story.update(dt, ctx);
    return s;
  };
  const at = (x, z) => {
    ctx.player.x = x;
    ctx.player.z = z;
  };
  return { bus, story, world, ctx, events, earned, toasts, step, at, gangMap, saves: () => saves };
}
const of = (events, n) => events.filter((x) => x.n === n);
// 接任務並跳過開場對白 → 任務開始
function acceptAndSkip(T) {
  T.at(CONTACT.x, CONTACT.z);
  T.ctx.onFoot = true;
  T.ctx.vehicle = null;
  T.story.update(0.016, T.ctx);
  const ok = T.story.interact(T.ctx);
  T.story.skip();
  return ok;
}
function finishOutro(T) {
  T.story.skip();
}
function completeS1(T) {
  acceptAndSkip(T);
  const van = T.world.vans[T.world.vans.length - 1];
  T.ctx.vehicle = van;
  T.ctx.onFoot = false;
  T.at(DROP.x, DROP.z);
  T.story.update(0.05, T.ctx);
  finishOutro(T);
  T.ctx.vehicle = null;
  T.ctx.onFoot = true;
}
function completeS2(T) {
  acceptAndSkip(T);
  T.story.update(0.05, T.ctx); // 找到生成點 → chase
  T.at(T.world.traitor.x + 5, T.world.traitor.z);
  T.world.traitor.health = 0;
  T.story.update(0.05, T.ctx); // 撞停 → ko
  T.bus.emit('ped:knockdown', { ped: T.world.actor, byPlayer: true, cause: 'punch' });
  T.story.update(0.05, T.ctx);
  finishOutro(T);
}
function completeS3(T) {
  acceptAndSkip(T);
  const sh = T.story.stronghold;
  T.at(sh.x, sh.z);
  T.story.update(0.05, T.ctx);
  for (let i = 0; i < GOAL; i++) {
    const a = { id: `m${i}` };
    T.gangMap.set(a, T.story.rival.id);
    T.bus.emit('ped:knockdown', { ped: a, byPlayer: true, cause: 'punch' });
    T.story.update(0.05, T.ctx);
  }
  T.story.update(0.05, T.ctx);
}

// ---------- 常數 / 資料 ----------
{
  check('章節 1「七期夜雨」、三關 id 固定順序', CHAPTER === 1 && CHAPTER_TITLE === '七期夜雨' && STORY_IDS.join() === 's1-delivery,s2-debt,s3-sweep');
  check('賞金 S1 1500 / S2 2500 / S3 4000、章節額外 5000', REWARDS['s1-delivery'] === 1500 && REWARDS['s2-debt'] === 2500 && REWARDS['s3-sweep'] === 4000 && CHAPTER_BONUS === 5000);
  check('限時 S1 150 s / S2 120 s、通緝 ≥ 2 星失敗、耐久 < 40% 失敗', S1_LIMIT === 150 && S2_LIMIT === 120 && WANTED_FAIL === 2 && CARGO_MIN === 0.4);
  check('S2 撞停：低速 3 s 且 15 m 內；S3 擊倒 8 名', STOP_SEC === 3 && STOP_NEAR === 15 && GOAL === 8);
  const ch = buildChapter(rivalGang(contactGang()));
  const lines = ch.flatMap((d) => [...d.intro, ...d.outro]);
  check('每關開場 / 收尾對白各 3–4 句', ch.every((d) => d.intro.length >= 3 && d.intro.length <= 4 && d.outro.length >= 3 && d.outro.length <= 4));
  check('每句對白 ≤ 30 字且非空、有說話者', LINE_MAX === 30 && lines.every((l) => l.text.length > 0 && [...l.text].length <= 30 && typeof l.who === 'string' && l.who), lines.filter((l) => [...l.text].length > 30).map((l) => l.text).join(' | '));
  check('對白 / 地點無真實店名（KTV 用虛構「夜浪KTV」）', !lines.some((l) => /銀櫃|錢櫃|好樂迪/.test(l.text)) && CONTACT.place.includes('夜浪KTV') && CONTACT.name === '阿海');
  check('S1 廂型車 = suv；起點旁生成（≤ 20 m）', VAN_TYPE === 'suv' && Math.hypot(VAN_SPOT.x - CONTACT.x, VAN_SPOT.z - CONTACT.z) <= 20);
  check('S1 停車場在秋紅谷飆車族地盤（秋紅谷邊）', territoryAt(DROP.x, DROP.z)?.id === 'qiuhonggu');
  const c = contactGang();
  const r = rivalGang(c);
  check('阿海所屬幫派 / 對手由 gangs 資料決定（秋紅谷飆車族 vs 夜市角頭）、對手 ≠ 自己', c && r && c.id === 'qiuhonggu' && r.id === 'nightmarket' && GANGS.includes(r));
  const sh = strongholdOf(r);
  check('對手據點在對手地盤內', territoryAt(sh.x, sh.z)?.id === r.id, `${sh.x},${sh.z}`);
  check('S3 對白帶入對手幫派名稱', ch[2].intro.some((l) => l.text.includes(r.name)));
  check('叛徒極速 = 玩家車 × 0.65，clamp 14–26（略低於玩家車）', traitorSpeed(42) < 42 && traitorSpeed(42) === Math.min(TRAITOR_SPEED_MAX, 42 * 0.65) && traitorSpeed(5) === TRAITOR_SPEED_MIN && traitorSpeed(0) <= TRAITOR_SPEED_MAX);
  check('formatClock', formatClock(150) === '02:30' && formatClock(0.2) === '00:01' && formatClock(-3) === '00:00');
  check('標記 kind：起點 story、目標 mission-dest；跳過鍵 Enter', MARKER_KIND === 'story' && TARGET_KIND === 'mission-dest' && STORY_SKIP_KEY === 'Enter');
  check('獎勵座車 = 既有車種換色', ['sedan', 'suv', 'taxi'].includes(REWARD_CAR.type) && /^#[0-9a-f]{6}$/i.test(REWARD_CAR.color));
  const src = readFileSync(`${ROOT}src/missions/story.js`, 'utf8');
  check('story.js 不 import three / rapier', !/^import[^\n]*from '(three|@dimforge\/rapier3d-compat)'/m.test(src) && (src.match(/^import /gm) || []).length === 2);
}

// ---------- 接任務 / 互斥 / 對白 ----------
{
  const T = setup();
  const s0 = T.story.update(0.016, T.ctx);
  const mk = T.story.markers([]);
  check('idle：起點 S 標記、非 active', !T.story.active && mk.length === 1 && mk[0].kind === 'story' && mk[0].x === CONTACT.x && !s0.active);
  check('站在 S 上步行 → 提示接受「送貨」', /送貨/.test(T.story.prompt(T.ctx) || ''));
  T.ctx.busy = true;
  check('互斥：其他任務進行中（busy）不能接、無提示', !T.story.prompt(T.ctx) && !T.story.interact(T.ctx) && !T.story.active);
  T.ctx.busy = false;
  T.ctx.onFoot = false;
  check('駕駛中不能接（需步行）', !T.story.accept(T.ctx));
  T.ctx.onFoot = true;
  T.at(CONTACT.x + START_RADIUS + 1, CONTACT.z);
  check('離 S 超過半徑不能接', !T.story.accept(T.ctx));
  T.at(CONTACT.x, CONTACT.z);
  T.ctx.frozen = true;
  check('凍結中不能接', !T.story.accept(T.ctx));
  T.ctx.frozen = false;
  check('接任務 → intro 對白、active、story:start', T.story.interact(T.ctx) && T.story.phase === 'intro' && T.story.active && T.story.dialogActive && of(T.events, 'story:start')[0]?.e.id === 's1-delivery');
  check('對白中提示 = 下一句', T.story.prompt(T.ctx) === PROMPT_NEXT);
  const first = T.story.dialogLine;
  T.story.interact(T.ctx);
  check('互動鍵 → 下一句', T.story.dialogLine && T.story.dialogLine !== first && T.story.phase === 'intro');
  T.step(LINE_SEC * 0.5);
  const mid = T.story.dialogLine;
  T.step(LINE_SEC * 0.6);
  check('每句 LINE_SEC 自動下一句', T.story.dialogLine !== mid);
  check('開場對白中不計時、貨車未生成', T.story.elapsed === 0 && T.world.vans.length === 0);
  const snapA = T.story.update(0, T.ctx);
  check('snapshot 對白欄位（who / line / 序號）', snapA.dialog && snapA.who && snapA.line && snapA.lineIndex >= 1 && snapA.lineTotal >= 3);
  T.story.skip();
  check('Enter 整段跳過 → 任務開始（run / board）、生成貨車、story:stage', T.story.phase === 'run' && T.story.stage === 'board' && T.world.vans.length === 1 && of(T.events, 'story:stage')[0]?.e.stage === 'board');
  const snapB = T.story.update(0.05, T.ctx);
  check('snapshot 重用同一物件、限時顯示', snapA === snapB && snapB.timed && snapB.timeLeft < S1_LIMIT && /02:30/.test(snapB.text) && /送貨/.test(snapB.title));
  const m1 = T.story.markers([]);
  check('任務中無起點 S、目標 = mission-dest（貨車）', m1.length === 1 && m1[0].kind === 'mission-dest' && m1[0].x === VAN_SPOT.x);
  const m2 = T.story.markers([]);
  check('目標標記物件重用', m1[0] === m2[0]);
  check('任務中接不了下一關（同時只有一個）', !T.story.accept(T.ctx));
}

// ---------- S1 送貨 ----------
{
  const T = setup();
  acceptAndSkip(T);
  const van = T.world.vans[0];
  T.ctx.vehicle = van;
  T.ctx.onFoot = false;
  T.story.update(0.05, T.ctx);
  check('S1 上車 → deliver 階段、目標 = 停車場', T.story.stage === 'deliver' && T.story.markers([])[0].x === DROP.x);
  T.ctx.vehicle = null;
  T.story.update(0.05, T.ctx);
  check('S1 下車 → 回 board', T.story.stage === 'board');
  T.ctx.vehicle = van;
  T.at(DROP.x + DROP_RADIUS + 2, DROP.z);
  T.story.update(0.05, T.ctx);
  check('S1 停車場半徑外不算送達', T.story.phase === 'run');
  T.at(DROP.x + DROP_RADIUS - 1, DROP.z);
  T.story.update(0.05, T.ctx);
  const c = of(T.events, 'story:complete');
  check('S1 送達 → 賞金 NT$1500（reason story）、story:complete、貨車交還', c.length === 1 && c[0].e.reward === 1500 && T.earned.length === 1 && T.earned[0].n === 1500 && T.earned[0].reason === 'story' && T.world.released[0] === van);
  check('S1 完成 → 收尾對白（outro）', T.story.phase === 'outro' && T.story.dialogActive);
  T.step(LINE_SEC * 5);
  check('收尾對白自動播完 → idle、下一關 = 追債', T.story.phase === 'idle' && T.story.done.join() === 's1-delivery' && /追債/.test(T.story.prompt({ ...T.ctx, player: { x: CONTACT.x, z: CONTACT.z }, onFoot: true, vehicle: null }) || ''));
}
for (const [name, mut, reason] of [
  ['S1 時間到（150 s）→ timeout', (T) => T.step(S1_LIMIT + 0.2, 0.1), 'timeout'],
  ['S1 通緝 2 星 → seized（貨被查扣）', (T) => { T.ctx.wantedStars = 2; T.story.update(0.05, T.ctx); }, 'seized'],
  ['S1 耐久 39% → cargo（貨毀了）', (T) => { T.world.vanHealth = 0.39; T.story.update(0.05, T.ctx); }, 'cargo'],
  ['S1 貨車消失 → cargo', (T) => { T.world.vanExists = false; T.story.update(0.05, T.ctx); }, 'cargo'],
]) {
  const T = setup();
  acceptAndSkip(T);
  mut(T);
  const f = of(T.events, 'story:fail');
  check(name, f.length === 1 && f[0].e.reason === reason && T.story.phase === 'idle' && T.earned.length === 0 && T.world.released.length === 1 && T.toasts.some((t) => t.includes('失敗')));
  if (reason === 'timeout') {
    // 失敗可無限重試：回 S 重接（新貨車）
    check('S1 失敗後回 S 可重接（無限重試）', acceptAndSkip(T) && T.story.phase === 'run' && T.world.vans.length === 2 && T.story.current.id === 's1-delivery');
  }
}
{
  const T = setup();
  acceptAndSkip(T);
  T.ctx.wantedStars = 1;
  T.world.vanHealth = 0.41;
  T.step(1);
  check('S1 通緝 1 星 / 耐久 41% 不失敗', T.story.phase === 'run');
  T.ctx.frozen = true;
  const t0 = T.story.elapsed;
  T.step(5);
  check('凍結（手機 / 重生 / 噴漆）不計時', T.story.elapsed === t0 && T.story.phase === 'run');
}

// ---------- S2 追債 ----------
{
  const T = setup();
  completeS1(T);
  T.earned.length = 0;
  acceptAndSkip(T);
  check('S2 開始 → seek', T.story.current.id === 's2-debt' && T.story.stage === 'seek');
  T.story.update(0.05, T.ctx);
  check('S2 找到生成點 → chase、叛徒車生成在地標附近', T.story.stage === 'chase' && T.world.traitorCars.length === 1 && Math.hypot(T.world.traitor.x - TRAITOR_SPOT.x, T.world.traitor.z - TRAITOR_SPOT.z) <= 80);
  T.at(T.world.traitor.x + TRAITOR_SPOT_DIST + 20, T.world.traitor.z);
  T.step(1);
  check('S2 玩家未接近 → 叛徒停著不逃（不下 drive 指令）', T.world.drives.length === 0 && !T.story.spotted);
  T.at(T.world.traitor.x + 40, T.world.traitor.z);
  T.story.update(0.05, T.ctx);
  const d = T.world.drives[T.world.drives.length - 1];
  check('S2 接近 → 逃竄：目標背離玩家、極速略低於玩家車', T.story.spotted && d && d.x < T.world.traitor.x && d.maxSpeed === traitorSpeed(42) && d.maxSpeed < 42);
  T.world.traitor.speed = 1;
  T.at(T.world.traitor.x + STOP_NEAR - 2, T.world.traitor.z);
  T.step(STOP_SEC - 0.5);
  check('S2 低速不滿 3 s 不算撞停', T.story.stage === 'chase');
  T.at(T.world.traitor.x + STOP_NEAR + 5, T.world.traitor.z);
  T.step(0.5);
  T.at(T.world.traitor.x + STOP_NEAR - 2, T.world.traitor.z);
  T.step(STOP_SEC - 0.5);
  check('S2 玩家離開 15 m 外 → 低速計時重置', T.story.stage === 'chase');
  T.step(0.7);
  check('S2 低速 < 2 m/s 持續 3 s 且 15 m 內 → 叛徒下車（ko）', T.story.stage === 'ko' && !!T.world.actor);
  check('S2 ko 階段：目標標記 = 叛徒', T.story.markers([])[0]?.x === T.world.actor.pos.x);
  T.bus.emit('ped:knockdown', { ped: { id: 'other' }, byPlayer: true });
  T.story.update(0.05, T.ctx);
  check('S2 打倒別人不算', T.story.stage === 'ko');
  T.world.downActors.add(T.world.actor);
  T.story.update(0.05, T.ctx);
  const c = of(T.events, 'story:complete').pop();
  check('S2 KO 叛徒 → 完成、賞金 NT$2500、叛徒車回收', c && c.e.id === 's2-debt' && c.e.reward === 2500 && T.earned.length === 1 && T.earned[0].n === 2500 && T.world.removed.length === 1);
}
{
  const T = setup();
  completeS1(T);
  acceptAndSkip(T);
  T.story.update(0.05, T.ctx);
  T.at(T.world.traitor.x + 5, T.world.traitor.z);
  T.world.traitor.health = 0;
  T.story.update(0.05, T.ctx);
  check('S2 叛徒車耐久歸零 → 立即下車（ko）', T.story.stage === 'ko');
  T.bus.emit('ped:dead', { ped: T.world.actor, byPlayer: true });
  T.story.update(0.05, T.ctx);
  check('S2 ped:dead 也算 KO 完成', of(T.events, 'story:complete').some((x) => x.e.id === 's2-debt'));
}
for (const [name, mut, reason] of [
  ['S2 120 s 內沒撞停 → timeout', (T) => { T.at(T.world.traitor.x + 40, T.world.traitor.z); T.world.traitor.speed = 20; T.step(S2_LIMIT + 0.2, 0.1); }, 'timeout'],
  ['S2 叛徒車甩開 > 450 m → escaped', (T) => { T.at(T.world.traitor.x + CAR_ESCAPE_DIST + 1, T.world.traitor.z); T.story.update(0.05, T.ctx); }, 'escaped'],
  ['S2 叛徒車消失 → escaped', (T) => { T.world.traitor.exists = false; T.story.update(0.05, T.ctx); }, 'escaped'],
  ['S2 下車後徒步拉開 > 120 m → escaped', (T) => { T.at(T.world.traitor.x + 5, T.world.traitor.z); T.world.traitor.health = 0; T.story.update(0.05, T.ctx); T.world.actor.pos.x += ESCAPE_DIST + 10; T.story.update(0.05, T.ctx); }, 'escaped'],
]) {
  const T = setup();
  completeS1(T);
  acceptAndSkip(T);
  T.story.update(0.05, T.ctx);
  mut(T);
  const f = of(T.events, 'story:fail');
  check(name, f.length === 1 && f[0].e.reason === reason && f[0].e.id === 's2-debt' && T.story.phase === 'idle' && T.world.removed.length === 1);
}
{
  const T = setup();
  completeS1(T);
  T.world.spawnPointOk = false;
  acceptAndSkip(T);
  T.step(SPAWN_TIMEOUT_SEC + 0.3, 0.1);
  check('S2 一直找不到生成點 → nospawn', of(T.events, 'story:fail')[0]?.e.reason === 'nospawn');
}

// ---------- S3 清場 ----------
{
  const T = setup();
  completeS1(T);
  completeS2(T);
  T.earned.length = 0;
  acceptAndSkip(T);
  const sh = T.story.stronghold;
  check('S3 開始 → go、目標 = 對手據點', T.story.current.id === 's3-sweep' && T.story.stage === 'go' && T.story.markers([])[0]?.x === sh.x);
  T.at(sh.x + ARRIVE_RADIUS + 5, sh.z);
  T.story.update(0.05, T.ctx);
  check('S3 未抵達不生成', T.world.gangSpawns.length === 0);
  T.at(sh.x, sh.z);
  T.story.update(0.05, T.ctx);
  check('S3 抵達 → fight、徵用第一波（對手幫派）', T.story.stage === 'fight' && T.world.gangSpawns[0]?.n === FIRST_WAVE && T.world.gangSpawns[0].id === T.story.rival.id);
  const rivalId = T.story.rival.id;
  const other = GANGS.find((g) => g.id !== rivalId).id;
  const m = (id, g) => {
    const a = { id };
    T.gangMap.set(a, g);
    return a;
  };
  const a1 = m('a1', rivalId);
  T.bus.emit('ped:knockdown', { ped: a1, byPlayer: true });
  T.bus.emit('ped:dead', { ped: a1, byPlayer: true });
  check('S3 同一人 knockdown + dead 只算一次', T.story.kills === 1);
  T.bus.emit('ped:knockdown', { ped: m('b1', other), byPlayer: true });
  T.bus.emit('ped:knockdown', { ped: m('c1', null), byPlayer: true });
  T.bus.emit('ped:knockdown', { ped: m('a2', rivalId), byPlayer: false });
  check('S3 非對手 / 非成員 / 非玩家擊倒不算', T.story.kills === 1);
  const snap = T.story.update(0.05, T.ctx);
  check('S3 HUD 計數 1 / 8', snap.counting && /1 \/ 8/.test(snap.text) && !snap.timed);
  for (let i = 0; i < REINFORCE_AT - 1; i++) T.bus.emit('ped:knockdown', { ped: m(`r${i}`, rivalId), byPlayer: true });
  T.story.update(0.05, T.ctx);
  check('S3 擊倒 4 名 → 增援一波（4 名）、story:stage reinforce、toast', T.story.stage === 'reinforce' && T.world.gangSpawns.some((g, i) => i > 0 && g.n === REINFORCE_WAVE) && of(T.events, 'story:stage').some((x) => x.e.stage === 'reinforce') && T.toasts.some((t) => t.includes('增援')));
  const nSpawn = T.world.gangSpawns.length;
  T.story.update(0.05, T.ctx);
  check('S3 增援只一次', T.world.gangSpawns.filter((g) => g.n === REINFORCE_WAVE).length === 1);
  T.world.alive = 0;
  T.step(2.2, 0.1);
  check('S3 場上人數不足 → 每 2 s 補人', T.world.gangSpawns.length > nSpawn);
  for (let i = T.story.kills; i < GOAL; i++) T.bus.emit('ped:knockdown', { ped: m(`k${i}`, rivalId), byPlayer: true });
  T.story.update(0.05, T.ctx);
  const c = of(T.events, 'story:complete').pop();
  check('S3 擊倒 8 名 → 完成、賞金 NT$4000', c && c.e.id === 's3-sweep' && c.e.reward === 4000 && T.earned[0].n === 4000);
  check('S3 完成 → 釋放徵用成員、對手敵意上升（provokeGang）', T.world.gangReleases >= 1 && T.world.provoked.length === 1 && T.world.provoked[0].id === rivalId && T.world.provoked[0].gain === HOSTILITY_GAIN);
  const ch = of(T.events, 'story:chapter');
  check('章節完成 → 額外 NT$5000、story:chapter、unlocked、存檔', ch.length === 1 && ch[0].e.bonus === 5000 && T.earned.length === 2 && T.earned[1].n === 5000 && T.story.unlocked && T.story.chapterDone && T.saves() === 1);
  T.story.skip();
  T.at(CONTACT.x, CONTACT.z);
  T.story.update(0.05, T.ctx);
  check('全破後：無起點 S、不能再接（賞金 / 章節獎勵只發一次）', T.story.markers([]).length === 0 && !T.story.accept(T.ctx) && !T.story.startVisible);
  T.bus.emit('ped:knockdown', { ped: m('late', rivalId), byPlayer: true });
  T.step(1);
  check('全破後事件不再入帳', T.earned.length === 2 && of(T.events, 'story:chapter').length === 1);
}
{
  const T = setup();
  completeS1(T);
  completeS2(T);
  acceptAndSkip(T);
  const sh = T.story.stronghold;
  T.at(sh.x, sh.z);
  T.story.update(0.05, T.ctx);
  T.at(sh.x + LEAVE_DIST + 5, sh.z);
  T.story.update(0.05, T.ctx);
  const f = of(T.events, 'story:fail')[0];
  check('S3 抵達後離開據點 > 220 m → left、徵用成員釋放', f && f.e.reason === 'left' && T.world.gangReleases === 1);
  check('S3 失敗不發賞金、可重試', !T.story.done.includes('s3-sweep') && acceptAndSkip(T) && T.story.current.id === 's3-sweep');
}
{
  // 全流程金額：1500 + 2500 + 4000 + 5000
  const T = setup();
  completeS1(T);
  completeS2(T);
  completeS3(T);
  const sum = T.earned.reduce((a, b) => a + b.n, 0);
  check('全流程入帳 = 13000（各關一次 + 章節一次）', sum === 1500 + 2500 + 4000 + 5000 && T.earned.length === 4);
}

// ---------- BUSTED / WASTED / cancel ----------
for (const kind of ['busted', 'wasted']) {
  const T = setup();
  acceptAndSkip(T);
  T.story.end(kind);
  const f = of(T.events, 'story:fail');
  check(`任務中 ${kind} → 失敗（reason ${kind}）、貨車交還`, f.length === 1 && f[0].e.reason === kind && T.story.phase === 'idle' && T.world.released.length === 1);
}
{
  const T = setup();
  T.story.update(0.016, T.ctx);
  T.story.interact(T.ctx);
  T.story.end('wasted');
  check('開場對白中送醫 → 失敗', of(T.events, 'story:fail')[0]?.e.reason === 'wasted' && !T.story.dialogActive);
  completeS1(T);
  const T2 = setup();
  acceptAndSkip(T2);
  T2.ctx.vehicle = T2.world.vans[0];
  T2.at(DROP.x, DROP.z);
  T2.story.update(0.05, T2.ctx);
  T2.story.end('busted');
  check('收尾對白中被捕 → 只收起對白，賞金保留、不算失敗', T2.story.phase === 'idle' && of(T2.events, 'story:fail').length === 0 && T2.story.done.includes('s1-delivery'));
}
{
  const T = setup();
  completeS1(T);
  acceptAndSkip(T);
  T.story.update(0.05, T.ctx);
  const nToast = T.toasts.length;
  T.story.cancel();
  const f = of(T.events, 'story:fail');
  check('cancel（回主選單）→ 無聲（無 toast）、reason cancel、叛徒車回收、idle', f.length === 1 && f[0].e.reason === 'cancel' && T.toasts.length === nToast && T.world.removed.length === 1 && T.story.phase === 'idle' && !T.story.active);
  T.story.cancel();
  check('idle 時 cancel 不發事件', of(T.events, 'story:fail').length === 1);
  check('cancel 保留已完成進度', T.story.done.join() === 's1-delivery');
}

// ---------- 存檔 ----------
{
  const T = setup();
  check('未完成任何關 → serialize null（存檔省略）', T.story.serialize() === null);
  completeS1(T);
  const rec = T.story.serialize();
  check('serialize { chapter: 1, done, unlocked }', rec && rec.chapter === 1 && rec.done.join() === 's1-delivery' && rec.unlocked === false);
  const T2 = setup();
  T2.story.restore(rec);
  check('restore → 從下一關（追債）繼續', T2.story.done.join() === 's1-delivery' && /追債/.test(T2.story.prompt(T2.ctx) || ''));
  T2.story.restore(undefined);
  check('restore(舊存檔無 story) → 從第一關開始', T2.story.doneCount === 0 && !T2.story.unlocked);
  check('storyRecord 清洗：未知 id 丟棄、unlocked 需三關全完成、非物件 null', storyRecord({ done: ['x', 's2-debt', 's2-debt'] })?.done.join() === 's2-debt' && storyRecord({ done: ['s1-delivery'], unlocked: true }).unlocked === false && storyRecord([1]) === null && storyRecord('a') === null && storyRecord({ done: [] }) === null);
  const all = { chapter: 1, done: [...STORY_IDS], unlocked: true };
  T2.story.restore(all);
  check('restore 全破存檔 → unlocked、無起點', T2.story.unlocked && T2.story.chapterDone && T2.story.markers([]).length === 0);
  const old = defaultSave();
  delete old.story;
  const v1 = validateSave(old);
  check('save.js：舊存檔（無 story）相容、不產生 story 欄、defaultSave 不含', v1 && !('story' in v1) && !('story' in defaultSave()));
  const v2 = validateSave({ ...defaultSave(), story: rec });
  check('save.js：story 往返', v2 && JSON.stringify(v2.story) === JSON.stringify(storyRecord(rec)));
  const v3 = validateSave({ ...defaultSave(), story: { done: 'bad', unlocked: true } });
  const v4 = validateSave({ ...defaultSave(), story: 42 });
  check('save.js：story 格式錯誤整欄丟棄（其他欄位不受影響）', v3 && !('story' in v3) && v4 && !('story' in v4) && v4.money === defaultSave().money);
  const v5 = validateSave({ ...defaultSave(), story: all });
  check('save.js：全破存檔保留 unlocked', v5 && v5.story.unlocked === true && v5.story.done.length === 3);
  const saveSrc = readFileSync(`${ROOT}src/save.js`, 'utf8');
  check('save.js STORY_IDS 與 story.js 一致、不升版', saveSrc.includes(`const STORY_IDS = ${JSON.stringify(STORY_IDS).replace(/"/g, "'").replace(/,/g, ', ')};`) && /export const SAVE_VERSION = 2;/.test(saveSrc));
}

// ---------- 獎勵座車 depot ----------
{
  const list = [];
  const vehicles = {
    vehicles: list,
    adopt: ({ type, color, x, z, yaw }) => {
      const v = { type, color, pos: { x, z }, yaw, driven: false };
      list.push(v);
      return v;
    },
    remove: (v) => list.splice(list.indexOf(v), 1),
  };
  const hp = new Map();
  const dmg = { attach: (v) => hp.set(v, 1000), detach: (v) => hp.delete(v), healthOf: (v) => (hp.has(v) ? hp.get(v) : null) };
  const depot = createStoryCarDepot({ vehicles, dmg });
  check('座車 depot：未解鎖不生成', depot.ensure(true, null, false) === null && list.length === 0);
  const car = depot.ensure(true, null, true);
  check('座車 depot：解鎖 → 安全屋旁生成專屬塗裝車（storyCar）', car && car.type === REWARD_CAR.type && car.color === REWARD_CAR.color && car.storyCar && hp.get(car) === 1000 && Math.hypot(car.pos.x - REWARD_CAR.x, car.pos.z - REWARD_CAR.z) < 0.01);
  check('座車 depot：已存在不重複生成', depot.ensure(true, null, true) === car && list.length === 1);
  hp.set(car, 0);
  depot.ensure(false, { x: REWARD_CAR.x, z: REWARD_CAR.z }, true);
  check('座車 depot：殘骸 + 玩家在旁 → 不在眼前補車', list.length === 1 && !depot.vehicle);
  depot.ensure(false, { x: REWARD_CAR.x + 500, z: REWARD_CAR.z }, true);
  check('座車 depot：玩家走遠 → 補一台新車', list.length === 1 && depot.vehicle && depot.vehicle !== car);
  check('座車 depot：停放點旁的殘骸補車前移除（不與新車重疊）', !list.includes(car) && list.filter((v) => Math.hypot(v.pos.x - REWARD_CAR.x, v.pos.z - REWARD_CAR.z) < WRECK_CLEAR).length === 1);
  depot.ensure(true, null, false);
  check('座車 depot：新局未解鎖 → 收回專屬車', !depot.vehicle && list.length === 0);
  const car2 = depot.ensure(true, null, true);
  hp.set(car2, 0);
  car2.pos.x += 40; // 殘骸在遠處（撞爛在路上）→ 交一般回收，不動它
  depot.ensure(false, { x: REWARD_CAR.x + 500, z: REWARD_CAR.z }, true);
  check('座車 depot：遠處殘骸不移除（交一般回收）、停放點補新車', list.includes(car2) && list.length === 2 && depot.vehicle && depot.vehicle !== car2);
}

// ---------- 審查修正（p20-rf-fix）----------
{
  // 任務條文字：key 變化必重組（S3 go 非空、S2 ko 換文字）
  const T = setup();
  completeS1(T);
  acceptAndSkip(T);
  T.story.update(0.05, T.ctx);
  T.at(T.world.traitor.x + 40, T.world.traitor.z);
  const sc = T.story.update(0.05, T.ctx);
  check('S2 chase 任務條：撞停文字 + 時鐘', /撞停叛徒的車｜\d\d:\d\d/.test(sc.text));
  T.at(T.world.traitor.x + 5, T.world.traitor.z);
  T.world.traitor.health = 0;
  const sk = T.story.update(0.05, T.ctx);
  check('S2 ko 任務條文字更新（不再顯示撞停）', T.story.stage === 'ko' && sk.text.includes('放倒他') && !sk.text.includes('撞停'), sk.text);
  const k1 = sk.text;
  T.step(2.1);
  const k2 = T.story.update(0.05, T.ctx).text;
  check('S2 ko 時鐘持續走（不凍結）', k2 !== k1 && k2.includes('放倒他'), `${k1} → ${k2}`);
  T.bus.emit('ped:knockdown', { ped: T.world.actor, byPlayer: false });
  T.story.update(0.05, T.ctx);
  check('S2 叛徒被非玩家打倒不算 KO', T.story.stage === 'ko' && !of(T.events, 'story:complete').some((x) => x.e.id === 's2-debt'));
  T.step(KO_LIMIT);
  const f = of(T.events, 'story:fail').pop();
  check(`S2 下車後 ${KO_LIMIT} s 沒 KO → escaped（不給賞金）`, f && f.e.id === 's2-debt' && f.e.reason === 'escaped' && !T.story.done.includes('s2-debt') && !T.earned.some((x) => x.n === REWARDS['s2-debt']));
  const T3 = setup();
  completeS1(T3);
  completeS2(T3);
  acceptAndSkip(T3);
  const s3 = T3.story.update(0.05, T3.ctx);
  check('S3 go 任務條目標非空（前往據點）', T3.story.stage === 'go' && s3.text.length > 0 && s3.text.includes(T3.story.stronghold.name), JSON.stringify(s3.text));
  T3.at(T3.story.stronghold.x, T3.story.stronghold.z);
  const s4 = T3.story.update(0.05, T3.ctx);
  check('S3 fight 任務條：擊倒文字 + 0 / 8', T3.story.stage === 'fight' && /擊倒.*成員｜0 \/ 8/.test(s4.text), s4.text);
}
{
  // S2 撞停後必須 KO：撞停當幀不完成、world.isDown 為假時一直在 ko
  const T = setup();
  completeS1(T);
  T.earned.length = 0;
  acceptAndSkip(T);
  T.story.update(0.05, T.ctx);
  T.at(T.world.traitor.x + 5, T.world.traitor.z);
  T.world.traitor.health = 0;
  T.step(1);
  check('S2 撞停後不自動完成（無 KO 不給賞金）', T.story.stage === 'ko' && T.earned.length === 0 && !T.story.done.includes('s2-debt'));
}
// S3 補人 / 保底 / 只算徵用者
function s3Setup(spawnCap) {
  const T = setup();
  completeS1(T);
  completeS2(T);
  const rivalId = T.story.rival.id;
  const enlisted = [];
  T.world.enlisted = enlisted;
  T.world.isEnlisted = (a) => enlisted.includes(a);
  T.world.spawnGang = (id, x, z, n) => {
    const got = Math.min(n, spawnCap());
    T.world.gangSpawns.push({ id, n, got });
    for (let i = 0; i < got; i++) {
      const a = { id: `e${enlisted.length}` };
      T.gangMap.set(a, rivalId);
      enlisted.push(a);
    }
    return got;
  };
  T.world.alive = 99; // 起身的已計入成員也算活著（aliveGang 高估）
  acceptAndSkip(T);
  T.at(T.story.stronghold.x, T.story.stronghold.z);
  T.story.update(0.05, T.ctx);
  return { T, rivalId, enlisted };
}
{
  const { T, enlisted } = s3Setup(() => 2);
  check('S3 首波生成不足（只徵到 2 名）', T.story.stage === 'fight' && enlisted.length === 2);
  let hit = 0;
  for (let t = 0; t < 120 && T.story.phase === 'run'; t += 0.5) {
    while (hit < enlisted.length && T.story.phase === 'run') T.bus.emit('ped:knockdown', { ped: enlisted[hit++], byPlayer: true });
    T.step(0.5);
  }
  const c = of(T.events, 'story:complete').find((x) => x.e.id === 's3-sweep');
  check('S3 起身成員算活著時仍會補人 → 打滿 8 名完成（不卡死）', !!c && T.story.phase !== 'run', `kills=${T.story.kills} enlisted=${enlisted.length}`);
}
{
  let cap = 1;
  const { T } = s3Setup(() => cap);
  cap = 0; // 之後附近沒有閒置行人可徵用
  T.bus.emit('ped:knockdown', { ped: T.world.enlisted[0], byPlayer: true });
  T.step(SHORT_SEC - SPAWN_SEC - 0.5, 0.1);
  check('S3 補人不足未滿保底時間 → 未提前增援', T.story.stage === 'fight' && T.story.kills === 1 && T.world.gangSpawns.every((g) => g.n !== REINFORCE_WAVE));
  T.step(SPAWN_SEC + 1, 0.1);
  check(`S3 補人不足持續 ${SHORT_SEC} s → 保底提前增援（reinforce）`, T.story.stage === 'reinforce' && T.world.gangSpawns.some((g) => g.n === REINFORCE_WAVE) && T.toasts.some((x) => x.includes('增援')));
  T.step(SHORT_SEC + SPAWN_SEC + 0.5, 0.1);
  check('S3 已增援仍不足 → 保底要求補到剩餘目標數', T.world.gangSpawns.some((g) => g.n === GOAL - T.story.kills));
  check('S3 每 2 s 補人量 ≤ MIN_ALIVE（保底除外）', T.world.gangSpawns.filter((g) => g.n !== FIRST_WAVE && g.n !== REINFORCE_WAVE && g.n !== GOAL - T.story.kills).every((g) => g.n <= MIN_ALIVE));
}
{
  const { T, rivalId, enlisted } = s3Setup(() => 99);
  for (let i = 0; i < GOAL; i++) {
    const a = { id: `native${i}` };
    T.gangMap.set(a, rivalId);
    T.bus.emit('ped:knockdown', { ped: a, byPlayer: true });
  }
  T.story.update(0.05, T.ctx);
  check('S3 只擊倒地盤原生（非徵用）成員不計數、不完成', T.story.kills === 0 && T.story.phase === 'run');
  T.bus.emit('ped:knockdown', { ped: enlisted[0], byPlayer: true });
  check('S3 擊倒徵用成員計數', T.story.kills === 1);
}
{
  // 帶星不能接 S1
  const T = setup();
  T.story.update(0.016, T.ctx);
  T.ctx.wantedStars = WANTED_FAIL;
  check(`S1：通緝 ≥ ${WANTED_FAIL} 星不可接、提示先甩掉警察`, !T.story.canAccept(T.ctx) && !T.story.interact(T.ctx) && T.story.phase === 'idle' && T.story.prompt(T.ctx) === PROMPT_WANTED && PROMPT_WANTED.includes('甩掉警察'));
  check('S1：帶星接不到 → 無 seized 失敗事件', of(T.events, 'story:fail').length === 0);
  T.ctx.wantedStars = WANTED_FAIL - 1;
  check(`S1：${WANTED_FAIL - 1} 星可接`, T.story.canAccept(T.ctx) && /送貨/.test(T.story.prompt(T.ctx) || ''));
  completeS1(T);
  T.at(CONTACT.x, CONTACT.z);
  T.ctx.wantedStars = 5;
  check('S2 帶星仍可接（只擋 S1）', T.story.canAccept(T.ctx));
}

// ---------- HUD（無 DOM 環境） ----------
{
  const h = createStoryHud({ root: null, doc: null });
  let ok = true;
  try {
    h.set(null);
    h.set({ phase: 'run', title: 'x', text: 'y', dialog: true, who: 'a', line: 'b' });
  } catch (e) {
    ok = false;
  }
  check('createStoryHud 無 DOM 時為 no-op', ok);
}

// ---------- gangs.provokeGang（真模組） ----------
{
  const bus = createBus();
  const hostile = [];
  bus.on('gang:hostile', (e) => hostile.push(e));
  const gangs = createGangs({ bus, rng: () => 0.5 });
  check('gangs.provokeGang：未知 id → false', gangs.provokeGang('nope', 'story', 100) === false);
  check('gangs.provokeGang：敵意 + gain → 進入敵對（gang:hostile cause story）', gangs.provokeGang('nightmarket', 'story', HOSTILITY_GAIN) === true && gangs.hostility('nightmarket') === 100 && gangs.isHostile('nightmarket') && hostile[0]?.cause === 'story');
  gangs.dispose();
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
