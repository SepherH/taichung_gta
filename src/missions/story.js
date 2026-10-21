// 故事任務線第一章「七期夜雨」（P20，GTA 式固定劇情三連環）：虛構聯絡人「阿海」（夜浪KTV 後巷）依序發出三個任務——
//   S1 送貨 → S2 追債 → S3 清場；起點為地圖金色「S」圖示（kind 'story'），步行到點按互動鍵接任務；任務前後各一段 3–4 句對白（HUD 字幕框，每句 ≤ 30 字，
//   互動鍵下一句、STORY_SKIP_KEY 整段跳過、每句 LINE_SEC 秒自動下一句），不做過場動畫。內容為 M 級虛構犯罪題材，人物 / 店名 / 幫派皆虛構。
// 純邏輯模組，不 import three / rapier；DOM 只在 createStoryHud（整合層給 root）；世界操作一律經 ctx.world 轉接（測試以替身注入）。
//
// createStory({ bus, rng, gangOf, config }) → { update(dt, ctx) → snapshot, prompt(ctx) → text|null, interact(ctx) → boolean, accept(ctx), next(), skip(),
//   end(kind), cancel(), markers(out), serialize(), restore(rec), dispose(), active, phase, dialogActive, current, stage, timeLeft, kills, goal,
//   done, doneCount, unlocked, chapterDone, contact, rival, stronghold }
//   bus：emit story:start / story:stage / story:complete / story:fail / story:chapter、toast（ctx.toast 省略時）；
//     訂閱 ped:knockdown / ped:dead（S2 byPlayer 且是叛徒 → KO；S3 byPlayer 且 gangOf(ped) === 對手幫派且 world.isEnlisted(ped)（本任務徵用）→ 擊倒 +1，同一人只算一次）
//   gangOf(actor) → 幫派 id | null（main：gangs.gangOf）
// 呼叫端（main.js）每幀建 ctx（重用同一物件）= { player: { x, z }, onFoot, vehicle（正駕駛的車 | null）, topSpeed（玩家車極速 m/s）, wantedStars,
//   busy（其他任務進行中 / 重生 / 噴漆：只擋接任務）, frozen（手機 / BUSTED・WASTED / 噴漆：計時停、不推進）, world, earn(n, reason), toast?(text, sec), save?() }
//   world（世界轉接，見 docs/dev/interfaces.md §42）：
//     S1：spawnVan(spot) → 車 | null；vanState(car) → { exists, health（0–1 比例 | null）}；releaseVan(car)（交還一般車輛回收）
//     S2：spawnPoint(x, z, rMin, rMax) → { x, z, heading } | null；spawn(pt) → handle | null；state(h) → { x, z, speed, health, exists }；
//       drive(h, { x, z, maxSpeed })；eject(h) → actor | null；remove(h)；isDown(actor) → boolean（下車摔倒不算，起身後再倒地才算）；actorPos(actor) → { x, z } | null
//     S3：aliveGang(id, x, z, r) → 人數；spawnGang(id, x, z, n) → 實際人數；releaseGang()；provokeGang(id, gain)；isEnlisted(actor) → 是否本任務徵用（省略 = 不過濾）
// 接任務：S1 時通緝 ≥ WANTED_FAIL 星不可接（提示 PROMPT_WANTED「先甩掉警察」）
// 流程：idle（S 圖示可接）→ accept → intro（對白，計時未開始）→ run（任務中，stage 依關卡）→ 完成：賞金入帳 → outro（對白）→ idle（下一關）
//   失敗（timeout / seized / cargo / escaped / left / nospawn / busted / wasted）→ toast、回 idle，可無限重試（回 S 重接）；cancel（回主選單 / 開新局）→ 無聲、事件 reason 'cancel'
//   S1 送貨：開始時在起點旁生成一輛 suv（VAN_SPOT，車身耐久 = 貨物）→ 開到 DROP 停車場 DROP_RADIUS 內（限時 S1_LIMIT）；通緝 ≥ WANTED_FAIL 星 → seized；耐久 < CARGO_MIN → cargo
//   S2 追債：叛徒車在 TRAITOR_SPOT 地標附近車道點生成（玩家接近 TRAITOR_SPOT_DIST 內才發現），沿路網背離玩家逃（maxSpeed = 玩家車極速 × TRAITOR_SPEED_FRAC，clamp）；限時 S2_LIMIT 內撞停
//     （耐久歸零，或速度 < STOP_SPEED 持續 STOP_SEC 且玩家在 STOP_NEAR 內）→ 叛徒下車逃跑（world.eject），玩家 KO 他即完成；徒步拉開 > ESCAPE_DIST 或 KO_LIMIT 內沒 KO → escaped
//   S3 清場：對手幫派（rivalGang：與阿海所屬幫派地盤中心最近的另一幫，皆由 gangs.js GANGS 決定）地盤據點（暴走點座標，RAMPAGES 同幫那一處）
//     抵達 ARRIVE_RADIUS 內 → 徵用 FIRST_WAVE 名成員（gangs.enlist 經 world.spawnGang），擊倒 REINFORCE_AT 名後增援 REINFORCE_WAVE 名，
//     SPAWN_SEC 秒補到 MIN_ALIVE（以「已徵用 − 已計入擊倒」與 aliveGang 取小判斷）；補不足持續 SHORT_SEC → 提前增援（已增援 → 補到剩餘目標數）；擊倒 GOAL 名完成 → 釋放徵用成員、world.provokeGang(對手, HOSTILITY_GAIN) 敵意上升；抵達後離據點 > LEAVE_DIST → left
//   賞金 REWARDS（只在首次完成發，done 內的關不會再開）；三關全完成 → 額外 CHAPTER_BONUS + 永久獎勵（unlocked：安全屋停一輛 REWARD_CAR，只發一次）+ ctx.save()
// 時間一律吃呼叫端 dt（clamp ≤ MAX_DT）；每幀路徑不配置物件（snapshot / 標記 / 逃竄指令重用；字串只在內容變化時重組）；事件 payload 只在事件發生時配置
import { GANGS, territoryAt, territoryCenter } from '../gangs.js';
import { RAMPAGES } from './rampage.js';

export const CHAPTER = 1;
export const CHAPTER_TITLE = '七期夜雨';
export const MAX_DT = 0.1; // s
export const START_RADIUS = 2.5; // m，走到 S 圖示此半徑內可按互動鍵接任務
export const LINE_SEC = 4.5; // s，對白每句自動下一句
export const LINE_MAX = 30; // 字，每句上限（測試鎖定）
export const STORY_SKIP_KEY = 'Enter'; // 整段對白跳過（互動鍵 = 下一句）
export const MARKER_KIND = 'story'; // 小地圖 / 大地圖金色 S（marker-colors story；hud.js ICON_KINDS）
export const TARGET_KIND = 'mission-dest'; // 任務目標沿用委託目的地圖釘
export const URGENT_SEC = 20; // s，剩餘時間 ≤ 此值 HUD 轉急迫樣式

// 聯絡人（虛構：夜浪KTV 後巷；座標取 osm-city.json B 層七期 KTV 建築西南側外牆與朝富一街之間的人行道）
export const CONTACT = Object.freeze({ name: '阿海', place: '夜浪KTV 後巷', x: 15.9, z: -517.3 });
// S1：廂型貨車（suv 換深色）停在巷口朝富一街路邊；送到秋紅谷東北角平面停車場（service 車道）
export const VAN_SPOT = Object.freeze({ x: 6.4, z: -508.3, yaw: -0.611 });
export const VAN_TYPE = 'suv';
export const VAN_COLOR = '#2b2f36';
export const DROP = Object.freeze({ name: '秋紅谷東北角停車場', x: 235.3, z: -341.0 });
export const DROP_RADIUS = 8; // m
export const S1_LIMIT = 150; // s
export const WANTED_FAIL = 2; // 星
export const CARGO_MIN = 0.4; // 耐久比例
// S2：叛徒從秋紅谷北端展示館附近出發
export const TRAITOR_SPOT = Object.freeze({ name: '秋紅谷展示館', x: 155.4, z: -452.7 });
export const TRAITOR_SPAWN_MIN = 10; // m，以地標為中心的車道點距離帶
export const TRAITOR_SPAWN_MAX = 80;
export const SPAWN_RETRY_SEC = 0.5;
export const SPAWN_TIMEOUT_SEC = 15; // s，一直找不到生成點 → nospawn
export const S2_LIMIT = 120; // s，撞停時限
export const TRAITOR_SPOT_DIST = 70; // m，玩家接近到此距離內叛徒才發現、開始逃（之前停在路邊）
export const STOP_SPEED = 2; // m/s
export const STOP_SEC = 3; // s
export const STOP_NEAR = 15; // m
export const TRAITOR_SPEED_FRAC = 0.65; // 叛徒極速 = 玩家車極速 × 此值（AI 過彎另會減速 → 略低於玩家車）
export const TRAITOR_SPEED_MIN = 14; // m/s
export const TRAITOR_SPEED_MAX = 26; // m/s
export const DEFAULT_TOP_SPEED = 42; // m/s，玩家步行時以轎車計
export const FLEE_DIST = 220; // m
export const FLEE_SPREAD = 1.0; // rad
export const FLEE_REPLAN_SEC = 6;
export const FLEE_REACH = 30; // m
export const CAR_ESCAPE_DIST = 450; // m，叛徒車甩開玩家此距離 → escaped
export const ESCAPE_DIST = 120; // m，下車後徒步拉開此距離 → escaped
export const KO_LIMIT = 60; // s，叛徒下車後此時間內沒被 KO → escaped
// S3
export const GOAL = 8;
export const FIRST_WAVE = 5;
export const REINFORCE_AT = 4;
export const REINFORCE_WAVE = 4;
export const SPAWN_SEC = 2; // s
export const ENEMY_RADIUS = 60; // m
export const MIN_ALIVE = 3;
export const SHORT_SEC = 20; // s，補人持續不足此時間 → 保底（提前增援 / 補到剩餘目標數）
export const ARRIVE_RADIUS = 30; // m
export const LEAVE_DIST = 220; // m
export const HOSTILITY_GAIN = 100;
// 賞金 / 章節獎勵
export const REWARDS = Object.freeze({ 's1-delivery': 1500, 's2-debt': 2500, 's3-sweep': 4000 });
export const CHAPTER_BONUS = 5000;
// 永久獎勵：安全屋（河南路安全屋，src/shops/safehouse.js）門口河南路路邊停一輛專屬塗裝轎車（既有車種換金色）
export const REWARD_CAR = Object.freeze({ type: 'sedan', color: '#c9a227', label: '阿海的金色轎車', x: 38.6, z: 106.0, yaw: 2.61 });
export const CAR_CHECK_SEC = 2; // s
export const CAR_RESPAWN_DIST = 60; // m，玩家離停放點此距離外才補車（不在眼前憑空出現）
export const CAR_HOME_DIST = 150; // m，完好但棄置在離停放點此距離外、玩家也不在旁 → 收回補到停放點
export const WRECK_CLEAR = 8; // m，殘骸在停放點此半徑內 → 補車前先移除（避免新車與殘骸重疊）
export const STORY_BEACON = Object.freeze({ height: 7, radius: 0.7, sink: 1 }); // S 起點小光柱（BEACON_COLORS.story）

export const FAIL_REASONS = Object.freeze(['timeout', 'seized', 'cargo', 'escaped', 'left', 'nospawn', 'busted', 'wasted', 'cancel']);
export const FAIL_TEXT = Object.freeze({
  timeout: '時間到',
  seized: '貨被警察查扣',
  cargo: '貨毀了',
  escaped: '叛徒跑了',
  left: '離開據點',
  nospawn: '目標不見了',
  busted: '被捕',
  wasted: '送醫',
});
export const PROMPT_NEXT = '按 E 下一句（Enter 跳過）';
export const PROMPT_NEXT_TOUCH = '點互動鈕下一句';
export const PROMPT_WANTED = '先甩掉警察再來找阿海';
export const promptAccept = (title) => `按 E 接受故事任務「${title}」`;
export const toastFail = (title, reason) => `「${title}」失敗：${FAIL_TEXT[reason] || reason}。回阿海那裡可重接`;
export const toastComplete = (title, reward) => `「${title}」完成！賞金 NT$${reward}`;
export const toastChapter = (bonus) => `第一章「${CHAPTER_TITLE}」完成！額外獎勵 NT$${bonus}，安全屋停了一輛專屬座車`;
export const TOAST_REINFORCE = '對方叫人增援了！';

export function formatClock(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// 阿海所屬幫派：聯絡點所在地盤；不在任何地盤內 → 地盤中心最近的幫派
export function contactGang(x = CONTACT.x, z = CONTACT.z, gangs = GANGS) {
  const t = gangs === GANGS ? territoryAt(x, z) : null;
  if (t) return t;
  let best = null;
  let bestD = Infinity;
  for (const g of gangs) {
    const c = territoryCenter(g);
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
// 對手幫派：與阿海所屬幫派地盤中心最近的另一幫（地盤相鄰 = 搶地盤的死對頭）
export function rivalGang(contact, gangs = GANGS) {
  if (!contact) return gangs[0] || null;
  const c0 = territoryCenter(contact);
  let best = null;
  let bestD = Infinity;
  for (const g of gangs) {
    if (g.id === contact.id) continue;
    const c = territoryCenter(g);
    const d = Math.hypot(c.x - c0.x, c.z - c0.z);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
// 對手據點：RAMPAGES 中該幫地盤點（p15 測試已驗證在地盤內、人行道上）；沒有 → 地盤中心
export function strongholdOf(gang) {
  if (!gang) return { name: '據點', x: 0, z: 0 };
  const r = RAMPAGES.find((p) => p.target === 'gang' && p.gang === gang.id);
  const c = r || territoryCenter(gang);
  return { name: `${gang.name}據點`, x: c.x, z: c.z };
}
export const traitorSpeed = (top) => Math.min(TRAITOR_SPEED_MAX, Math.max(TRAITOR_SPEED_MIN, (Number(top) > 0 ? Number(top) : DEFAULT_TOP_SPEED) * TRAITOR_SPEED_FRAC));

const L = (who, text) => Object.freeze({ who, text });
// 第一章三關（順序固定；rival 名稱在建立時代入 S3 對白）
export function buildChapter(rival = rivalGang(contactGang())) {
  const rn = rival ? rival.name : '對頭';
  return Object.freeze([
    Object.freeze({
      id: 's1-delivery',
      title: '送貨',
      reward: REWARDS['s1-delivery'],
      limit: S1_LIMIT,
      intro: Object.freeze([
        L('阿海', '你就是新來的？我是阿海，這條後巷歸我管。'),
        L('阿海', '巷口那台休旅車裡有貨，開去秋紅谷停車場。'),
        L('阿海', '別惹條子，貨也別給我撞爛了。'),
        L('你', '交給我。'),
      ]),
      outro: Object.freeze([
        L('阿海', '貨到了，手腳挺俐落的嘛。'),
        L('阿海', '這是你的份，過兩天還有事找你。'),
        L('你', '隨時候命。'),
      ]),
    }),
    Object.freeze({
      id: 's2-debt',
      title: '追債',
      reward: REWARDS['s2-debt'],
      limit: S2_LIMIT,
      intro: Object.freeze([
        L('阿海', '小陳捲了一筆錢想跑路，人在秋紅谷那頭。'),
        L('阿海', '把他的車撞停，再把人給我放倒。'),
        L('阿海', '兩分鐘內追不到，他就出城了。'),
      ]),
      outro: Object.freeze([
        L('阿海', '錢追回來了，小陳也學到教訓。'),
        L('阿海', '最後一件事，這次要動真格的。'),
        L('你', '說吧。'),
      ]),
    }),
    Object.freeze({
      id: 's3-sweep',
      title: '清場',
      reward: REWARDS['s3-sweep'],
      limit: 0,
      intro: Object.freeze([
        L('阿海', `${rn}最近一直踩過界。`),
        L('阿海', `去${rn}的據點，放倒八個人。`),
        L('阿海', '小心，他們一定會叫人增援。'),
      ]),
      outro: Object.freeze([
        L('阿海', '幹得漂亮，今晚七期是我們的了。'),
        L('阿海', '安全屋門口停了台車，送你的。'),
        L('阿海', '以後有事，我再打給你。'),
      ]),
    }),
  ]);
}
export const STORY_IDS = Object.freeze(['s1-delivery', 's2-debt', 's3-sweep']);

// 存檔清洗：{ chapter: 1, done: [id], unlocked: bool } → 同形；非物件 → null；未知 id 丟棄；三關全完成才可能 unlocked；全空 → null
export function storyRecord(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const done = STORY_IDS.filter((id) => Array.isArray(src.done) && src.done.includes(id));
  const unlocked = src.unlocked === true && done.length === STORY_IDS.length;
  if (!done.length && !unlocked) return null;
  return { chapter: CHAPTER, done, unlocked };
}

const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const clampDt = (dt) => (Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_DT) : 0);

export function createStory({ bus = null, rng = Math.random, gangOf = null, config = {} } = {}) {
  const C = {
    lineSec: LINE_SEC,
    s1Limit: S1_LIMIT,
    s2Limit: S2_LIMIT,
    goal: GOAL,
    ...config,
  };
  const contact = contactGang();
  const rival = rivalGang(contact);
  const stronghold = strongholdOf(rival);
  const chapter = buildChapter(rival);
  const done = new Set();
  let unlocked = false;

  const st = {
    phase: 'idle', // idle | intro | run | outro
    def: null,
    stage: null,
    t: 0,
    dialog: null,
    line: 0,
    lineT: 0,
    // S1
    van: null,
    // S2
    traitor: null,
    actor: null,
    actorDown: false,
    stopT: 0,
    spotted: false,
    spawnT: 0,
    fleeT: 0,
    fleeX: 0,
    fleeZ: 0,
    // S3
    kills: 0,
    reinforced: false,
    arrived: false,
    topT: 0,
    spawned: 0,
    shortT: 0,
    koT: 0,
  };
  const counted = new Set(); // S3 已計入的 actor（knockdown 後再 dead 不重複算）
  const cmd = { x: 0, z: 0, maxSpeed: 0 };
  let lastCtx = null;
  const offs = [];

  const snap = {
    active: false,
    phase: 'idle',
    id: null,
    title: '',
    text: '',
    stage: null,
    timeLeft: 0,
    timed: false,
    count: 0,
    goal: 0,
    counting: false,
    urgent: false,
    dialog: false,
    who: '',
    line: '',
    lineIndex: 0,
    lineTotal: 0,
  };
  const startMk = { x: CONTACT.x, z: CONTACT.z, kind: MARKER_KIND, label: `故事任務：${CONTACT.name}` };
  const targetMk = { x: 0, z: 0, kind: TARGET_KIND, label: '' };

  function emit(name, payload) {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  }
  function toast(text, seconds = 4, ctx = lastCtx) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }
  const world = () => (lastCtx && lastCtx.world) || null;

  const nextDef = () => chapter.find((d) => !done.has(d.id)) || null;
  const chapterDone = () => done.size === chapter.length;

  function stageText() {
    const d = st.def;
    if (!d) return '';
    switch (st.stage) {
      case 'board':
        return '坐上巷口那台休旅車';
      case 'deliver':
        return `把貨送到${DROP.name}`;
      case 'seek':
        return '找出叛徒小陳的車';
      case 'chase':
        return st.spotted ? '撞停叛徒的車' : `叛徒在${TRAITOR_SPOT.name}附近，撞停他的車`;
      case 'ko':
        return '叛徒下車逃跑了，放倒他';
      case 'go':
        return `前往${stronghold.name}`;
      case 'fight':
        return `擊倒${rival ? rival.name : ''}成員`;
      case 'reinforce':
        return '對方增援了！繼續擊倒';
      default:
        return '';
    }
  }

  function setStage(stage, x = NaN, z = NaN) {
    st.stage = stage;
    emit('story:stage', { id: st.def.id, chapter: CHAPTER, stage, text: stageText(), x, z });
  }

  function openDialog(lines, phase) {
    st.phase = phase;
    st.dialog = lines;
    st.line = 0;
    st.lineT = 0;
  }

  function closeDialog() {
    const phase = st.phase;
    st.dialog = null;
    st.line = 0;
    st.lineT = 0;
    if (phase === 'intro') begin();
    else if (phase === 'outro') {
      st.phase = 'idle';
      st.def = null;
      st.stage = null;
    }
  }

  function next() {
    if (!st.dialog) return false;
    st.line++;
    st.lineT = 0;
    if (st.line >= st.dialog.length) closeDialog();
    return true;
  }

  function skip() {
    if (!st.dialog) return false;
    closeDialog();
    return true;
  }

  function nearStart(ctx) {
    return !!ctx && !!ctx.player && dist(ctx.player.x, ctx.player.z, CONTACT.x, CONTACT.z) <= START_RADIUS;
  }

  // S1 帶 ≥ WANTED_FAIL 星接 → 第一幀即 seized，先擋下
  function wantedBlocked(ctx) {
    const d = nextDef();
    return !!d && d.id === 's1-delivery' && (Number(ctx.wantedStars) || 0) >= WANTED_FAIL;
  }

  function canAccept(ctx) {
    return st.phase === 'idle' && !!nextDef() && nearStart(ctx) && !!ctx.onFoot && !ctx.busy && !ctx.frozen && !wantedBlocked(ctx);
  }

  function accept(ctx = lastCtx) {
    if (!canAccept(ctx || {})) return false;
    lastCtx = ctx;
    const d = nextDef();
    st.def = d;
    st.stage = null;
    emit('story:start', { id: d.id, title: d.title, chapter: CHAPTER, index: chapter.indexOf(d) + 1 });
    openDialog(d.intro, 'intro');
    return true;
  }

  function resetRun() {
    st.t = 0;
    st.van = null;
    st.traitor = null;
    st.actor = null;
    st.actorDown = false;
    st.stopT = 0;
    st.spotted = false;
    st.spawnT = 0;
    st.fleeT = 0;
    st.kills = 0;
    st.reinforced = false;
    st.arrived = false;
    st.topT = 0;
    st.spawned = 0;
    st.shortT = 0;
    st.koT = 0;
    counted.clear();
  }

  // intro 結束 → 任務開始計時
  function begin() {
    const d = st.def;
    const w = world();
    resetRun();
    st.phase = 'run';
    if (d.id === 's1-delivery') {
      st.van = w && typeof w.spawnVan === 'function' ? w.spawnVan(VAN_SPOT) : null;
      if (!st.van) {
        fail('nospawn');
        return;
      }
      setStage('board', VAN_SPOT.x, VAN_SPOT.z);
    } else if (d.id === 's2-debt') {
      st.spawnT = SPAWN_RETRY_SEC; // 第一次 update 立即嘗試
      setStage('seek', TRAITOR_SPOT.x, TRAITOR_SPOT.z);
    } else {
      setStage('go', stronghold.x, stronghold.z);
    }
  }

  // 世界清理（完成 / 失敗 / 取消共用）
  function cleanup() {
    const w = world();
    if (st.van && w && typeof w.releaseVan === 'function') w.releaseVan(st.van);
    if (st.traitor && w && typeof w.remove === 'function') w.remove(st.traitor);
    if (st.def && st.def.id === 's3-sweep' && w && typeof w.releaseGang === 'function') w.releaseGang();
    st.van = null;
    st.traitor = null;
    st.actor = null;
  }

  function complete(ctx) {
    const d = st.def;
    if (!d || done.has(d.id)) return;
    const timeSec = Math.round(st.t * 10) / 10;
    const s3 = d.id === 's3-sweep';
    cleanup();
    if (s3 && ctx && ctx.world && typeof ctx.world.provokeGang === 'function' && rival) ctx.world.provokeGang(rival.id, HOSTILITY_GAIN);
    done.add(d.id);
    if (ctx && typeof ctx.earn === 'function') ctx.earn(d.reward, 'story');
    emit('story:complete', { id: d.id, title: d.title, chapter: CHAPTER, reward: d.reward, timeSec });
    toast(toastComplete(d.title, d.reward), 4, ctx);
    if (chapterDone() && !unlocked) {
      unlocked = true;
      if (ctx && typeof ctx.earn === 'function') ctx.earn(CHAPTER_BONUS, 'story');
      emit('story:chapter', { chapter: CHAPTER, title: CHAPTER_TITLE, bonus: CHAPTER_BONUS, car: REWARD_CAR.label });
      toast(toastChapter(CHAPTER_BONUS), 6, ctx);
      if (ctx && typeof ctx.save === 'function') ctx.save();
    }
    st.stage = null;
    openDialog(d.outro, 'outro');
  }

  function fail(reason, ctx = lastCtx) {
    const d = st.def;
    if (!d) return;
    cleanup();
    emit('story:fail', { id: d.id, title: d.title, chapter: CHAPTER, reason, stage: st.stage });
    if (reason !== 'cancel') toast(toastFail(d.title, reason), 5, ctx);
    st.phase = 'idle';
    st.def = null;
    st.stage = null;
    st.dialog = null;
    resetRun();
  }

  // BUSTED / WASTED（整合層 vigHooks.end）：任務中 → 失敗；收尾對白中 → 直接收起（賞金已入帳）
  function end(kind = 'cancel') {
    if (st.phase === 'intro' || st.phase === 'run') fail(kind);
    else if (st.phase === 'outro') closeDialog();
  }

  function cancel() {
    if (st.phase === 'intro' || st.phase === 'run') fail('cancel');
    st.phase = 'idle';
    st.def = null;
    st.stage = null;
    st.dialog = null;
    resetRun();
  }

  // ---------- 各關 ----------
  function runS1(ctx, w) {
    const vs = w && typeof w.vanState === 'function' ? w.vanState(st.van) : null;
    if (!vs || !vs.exists || (vs.health !== null && vs.health !== undefined && vs.health < CARGO_MIN)) return fail('cargo', ctx);
    if ((Number(ctx.wantedStars) || 0) >= WANTED_FAIL) return fail('seized', ctx);
    if (st.t >= C.s1Limit) return fail('timeout', ctx);
    const inVan = !!ctx.vehicle && ctx.vehicle === st.van;
    if (inVan && st.stage === 'board') setStage('deliver', DROP.x, DROP.z);
    else if (!inVan && st.stage === 'deliver') setStage('board', NaN, NaN);
    if (inVan && dist(ctx.player.x, ctx.player.z, DROP.x, DROP.z) <= DROP_RADIUS) complete(ctx);
  }

  function planFlee(s, ctx) {
    let dx = s.x - ctx.player.x;
    let dz = s.z - ctx.player.z;
    const len = Math.hypot(dx, dz) || 1;
    const a = Math.atan2(dx / len, dz / len) + ((Number(rng()) || 0) - 0.5) * FLEE_SPREAD;
    st.fleeX = s.x + Math.sin(a) * FLEE_DIST;
    st.fleeZ = s.z + Math.cos(a) * FLEE_DIST;
    st.fleeT = 0;
  }

  function runS2(dt, ctx, w) {
    if (!w) return;
    if (st.stage === 'seek') {
      if (st.t >= SPAWN_TIMEOUT_SEC) return fail('nospawn', ctx);
      st.spawnT += dt;
      if (st.spawnT < SPAWN_RETRY_SEC) return;
      st.spawnT = 0;
      const pt = typeof w.spawnPoint === 'function' ? w.spawnPoint(TRAITOR_SPOT.x, TRAITOR_SPOT.z, TRAITOR_SPAWN_MIN, TRAITOR_SPAWN_MAX) : null;
      const h = pt && typeof w.spawn === 'function' ? w.spawn(pt) : null;
      if (!h) return;
      st.traitor = h;
      st.fleeT = FLEE_REPLAN_SEC; // 立刻規劃逃竄
      setStage('chase', pt.x, pt.z);
      return;
    }
    if (st.stage === 'chase') {
      if (st.t >= C.s2Limit) return fail('timeout', ctx);
      const s = w.state(st.traitor);
      if (!s || !s.exists) return fail('escaped', ctx);
      const d = dist(ctx.player.x, ctx.player.z, s.x, s.z);
      if (d > CAR_ESCAPE_DIST) return fail('escaped', ctx);
      if (!st.spotted) {
        if (d > TRAITOR_SPOT_DIST) return; // 還沒發現玩家：停在路邊（不下 drive 指令 = 煞停）
        st.spotted = true;
      }
      if (Math.abs(s.speed || 0) < STOP_SPEED && d <= STOP_NEAR) st.stopT += dt;
      else st.stopT = 0;
      if (s.health === 0 || st.stopT >= STOP_SEC) {
        const actor = typeof w.eject === 'function' ? w.eject(st.traitor) : null;
        if (!actor) return complete(ctx); // 駕駛已不在車上（極端情況）：撞停即算追回
        st.actor = actor;
        st.actorDown = false;
        st.koT = 0;
        setStage('ko', s.x, s.z);
        return;
      }
      st.fleeT += dt;
      if (st.fleeT >= FLEE_REPLAN_SEC || dist(s.x, s.z, st.fleeX, st.fleeZ) < FLEE_REACH) planFlee(s, ctx);
      cmd.x = st.fleeX;
      cmd.z = st.fleeZ;
      cmd.maxSpeed = traitorSpeed(ctx.topSpeed);
      if (typeof w.drive === 'function') w.drive(st.traitor, cmd);
      return;
    }
    if (st.stage === 'ko') {
      if (st.actorDown || (typeof w.isDown === 'function' && w.isDown(st.actor))) return complete(ctx);
      const p = typeof w.actorPos === 'function' ? w.actorPos(st.actor) : null;
      if (!p || dist(ctx.player.x, ctx.player.z, p.x, p.z) > ESCAPE_DIST) return fail('escaped', ctx);
      st.koT += dt;
      if (st.koT >= KO_LIMIT) return fail('escaped', ctx);
    }
  }

  function runS3(dt, ctx, w) {
    if (!w || !rival) return;
    const px = ctx.player.x;
    const pz = ctx.player.z;
    if (st.stage === 'go') {
      if (dist(px, pz, stronghold.x, stronghold.z) > ARRIVE_RADIUS) return;
      st.arrived = true;
      spawnGang(w, px, pz, FIRST_WAVE);
      st.topT = 0;
      st.shortT = 0;
      setStage('fight', stronghold.x, stronghold.z);
      return;
    }
    if (st.kills >= C.goal) return complete(ctx);
    if (dist(px, pz, stronghold.x, stronghold.z) > LEAVE_DIST) return fail('left', ctx);
    if (!st.reinforced && st.kills >= REINFORCE_AT) return reinforce(ctx, w, px, pz);
    st.topT += dt;
    if (st.topT < SPAWN_SEC) return;
    st.topT = 0;
    const want = Math.min(C.goal - st.kills, MIN_ALIVE);
    // 場上可打的人數：本任務徵用且未計入擊倒者（被拳棒打倒後起身的已計入成員不算）；aliveGang 另扣掉被別人打死的徵用者
    const fresh = st.spawned - st.kills;
    const alive = typeof w.aliveGang === 'function' ? w.aliveGang(rival.id, px, pz, ENEMY_RADIUS) : fresh;
    const have = Math.max(0, Math.min(fresh, alive));
    if (have >= want) {
      st.shortT = 0;
      return;
    }
    if (have + spawnGang(w, px, pz, want - have) >= want) {
      st.shortT = 0;
      return;
    }
    // 保底：附近閒置行人不夠、持續補不足 → 提前增援；已增援 → 直接要求補到剩餘目標數（避免無時限卡死）
    st.shortT += SPAWN_SEC;
    if (st.shortT < SHORT_SEC) return;
    st.shortT = 0;
    if (!st.reinforced) return reinforce(ctx, w, px, pz);
    spawnGang(w, px, pz, C.goal - st.kills);
  }

  function spawnGang(w, x, z, n) {
    if (typeof w.spawnGang !== 'function' || !(n > 0)) return 0;
    const got = Number(w.spawnGang(rival.id, x, z, n)) || 0;
    st.spawned += got;
    return got;
  }

  function reinforce(ctx, w, px, pz) {
    st.reinforced = true;
    spawnGang(w, px, pz, REINFORCE_WAVE);
    toast(TOAST_REINFORCE, 3, ctx);
    setStage('reinforce', px, pz);
    st.topT = 0;
    st.shortT = 0;
  }

  // ---------- 事件 ----------
  function onDown(e) {
    if (!e || !e.ped || st.phase !== 'run' || !st.def) return;
    if (st.def.id === 's2-debt') {
      if (st.stage === 'ko' && e.ped === st.actor && e.byPlayer) st.actorDown = true;
      return;
    }
    if (st.def.id !== 's3-sweep' || (st.stage !== 'fight' && st.stage !== 'reinforce') || !e.byPlayer || !rival) return;
    if (typeof gangOf !== 'function' || gangOf(e.ped) !== rival.id || counted.has(e.ped)) return;
    const w = world();
    if (w && typeof w.isEnlisted === 'function' && !w.isEnlisted(e.ped)) return; // 地盤原生成員不算，只算本任務徵用者
    counted.add(e.ped);
    st.kills++;
  }
  if (bus && typeof bus.on === 'function') {
    for (const name of ['ped:knockdown', 'ped:dead']) {
      const off = bus.on(name, onDown);
      if (typeof off === 'function') offs.push(off);
    }
  }

  // ---------- 每幀 ----------
  let snapDef = null;
  let snapStage = null;
  let snapSpotted = false;
  let snapSec = NaN;
  function fillSnap() {
    const d = st.def;
    snap.active = st.phase !== 'idle';
    snap.phase = st.phase;
    snap.id = d ? d.id : null;
    snap.stage = st.stage;
    snap.dialog = !!st.dialog;
    if (st.dialog) {
      const l = st.dialog[Math.min(st.line, st.dialog.length - 1)];
      snap.who = l.who;
      snap.line = l.text;
      snap.lineIndex = st.line + 1;
      snap.lineTotal = st.dialog.length;
    } else {
      snap.who = '';
      snap.line = '';
      snap.lineIndex = 0;
      snap.lineTotal = 0;
    }
    const running = st.phase === 'run' && !!d;
    const ko = running && d.id === 's2-debt' && st.stage === 'ko';
    const timed = running && (d.id === 's1-delivery' || d.id === 's2-debt');
    const limit = d ? (d.id === 's1-delivery' ? C.s1Limit : d.id === 's2-debt' ? C.s2Limit : 0) : 0;
    snap.timed = timed;
    snap.timeLeft = !timed ? 0 : ko ? Math.max(0, KO_LIMIT - st.koT) : Math.max(0, limit - st.t);
    snap.counting = running && d.id === 's3-sweep' && st.stage !== 'go';
    snap.count = st.kills;
    snap.goal = C.goal;
    snap.urgent = timed && snap.timeLeft <= URGENT_SEC;
    const keyDef = running ? d : null;
    const keyStage = running ? st.stage : null;
    if (keyDef !== snapDef || keyStage !== snapStage || st.spotted !== snapSpotted) {
      snapDef = keyDef;
      snapStage = keyStage;
      snapSpotted = st.spotted;
      snap.title = running ? `第一章「${CHAPTER_TITLE}」｜${d.title}` : '';
      snapSec = NaN; // 哨兵：sec 不可能為 NaN → key 變化後必重組 snap.text（-1 會與非計時階段的 sec 撞值）
    }
    const sec = timed ? Math.ceil(snap.timeLeft) : snap.counting ? -2 - st.kills : -1;
    if (sec !== snapSec) {
      snapSec = sec;
      const base = running ? stageText() : '';
      snap.text = !running ? '' : timed ? `${base}｜${formatClock(snap.timeLeft)}` : snap.counting ? `${base}｜${st.kills} / ${C.goal}` : base;
    }
    return snap;
  }

  function update(dt, ctx = {}) {
    lastCtx = ctx;
    dt = clampDt(dt);
    if (ctx.frozen || !ctx.player) return fillSnap();
    if (st.dialog) {
      st.lineT += dt;
      if (st.lineT >= C.lineSec) next();
    }
    if (st.phase === 'run' && st.def) {
      st.t += dt;
      const w = ctx.world || null;
      if (st.def.id === 's1-delivery') runS1(ctx, w);
      else if (st.def.id === 's2-debt') runS2(dt, ctx, w);
      else runS3(dt, ctx, w);
    }
    return fillSnap();
  }

  // 互動提示：對白中 → 下一句；idle、站在 S 內步行、可接 → 接任務；其他 → null
  function prompt(ctx = lastCtx, touch = false) {
    if (st.dialog) return touch ? PROMPT_NEXT_TOUCH : PROMPT_NEXT;
    if (ctx && canAccept(ctx)) return promptAccept(nextDef().title);
    if (ctx && st.phase === 'idle' && nearStart(ctx) && ctx.onFoot && !ctx.busy && !ctx.frozen && wantedBlocked(ctx)) return PROMPT_WANTED;
    return null;
  }
  function interact(ctx = lastCtx) {
    if (st.dialog) return next();
    return accept(ctx);
  }

  function markers(out = []) {
    if (st.phase === 'idle' && !chapterDone()) out.push(startMk);
    if (st.phase !== 'run' || !st.def) return out;
    const w = world();
    let x = NaN;
    let z = NaN;
    let label = '';
    if (st.stage === 'board' && st.van && st.van.pos) {
      x = st.van.pos.x;
      z = st.van.pos.z;
      label = '貨車';
    } else if (st.stage === 'deliver') {
      x = DROP.x;
      z = DROP.z;
      label = DROP.name;
    } else if (st.stage === 'seek') {
      x = TRAITOR_SPOT.x;
      z = TRAITOR_SPOT.z;
      label = TRAITOR_SPOT.name;
    } else if (st.stage === 'chase' && w && st.traitor) {
      const s = w.state(st.traitor);
      if (s && s.exists) {
        x = s.x;
        z = s.z;
      }
      label = '叛徒的車';
    } else if (st.stage === 'ko' && w && st.actor && typeof w.actorPos === 'function') {
      const p = w.actorPos(st.actor);
      if (p) {
        x = p.x;
        z = p.z;
      }
      label = '叛徒';
    } else if (st.stage === 'go') {
      x = stronghold.x;
      z = stronghold.z;
      label = stronghold.name;
    }
    if (Number.isFinite(x) && Number.isFinite(z)) {
      targetMk.x = x;
      targetMk.z = z;
      targetMk.label = label;
      out.push(targetMk);
    }
    return out;
  }

  function serialize() {
    if (!done.size && !unlocked) return null;
    return { chapter: CHAPTER, done: STORY_IDS.filter((id) => done.has(id)), unlocked };
  }

  function restore(rec) {
    cancel();
    done.clear();
    unlocked = false;
    const r = storyRecord(rec);
    if (!r) return;
    for (const id of r.done) done.add(id);
    unlocked = r.unlocked;
  }

  function dispose() {
    cancel();
    for (const off of offs) off();
    offs.length = 0;
  }

  return {
    update,
    prompt,
    interact,
    accept,
    canAccept,
    next,
    skip,
    end,
    cancel,
    markers,
    serialize,
    restore,
    dispose,
    chapter,
    contact,
    rival,
    stronghold,
    snapshot: snap,
    get active() {
      return st.phase !== 'idle';
    },
    get running() {
      return st.phase === 'run';
    },
    get phase() {
      return st.phase;
    },
    get dialogActive() {
      return !!st.dialog;
    },
    get dialogLine() {
      return st.dialog ? st.dialog[Math.min(st.line, st.dialog.length - 1)] : null;
    },
    get current() {
      return st.def;
    },
    get stage() {
      return st.stage;
    },
    get elapsed() {
      return st.t;
    },
    get spotted() {
      return st.spotted;
    },
    get kills() {
      return st.kills;
    },
    get goal() {
      return C.goal;
    },
    get van() {
      return st.van;
    },
    get traitor() {
      return st.traitor;
    },
    get traitorActor() {
      return st.actor;
    },
    get done() {
      return STORY_IDS.filter((id) => done.has(id));
    },
    get doneCount() {
      return done.size;
    },
    get unlocked() {
      return unlocked;
    },
    get chapterDone() {
      return chapterDone();
    },
    get startVisible() {
      return st.phase === 'idle' && !chapterDone();
    },
  };
}

// ---------- 永久獎勵座車（三者 adapter，不 import three）----------
// createStoryCarDepot({ vehicles, dmg?, spot = REWARD_CAR, isBusy?(v) }) → { update(dt, player, unlocked), ensure(force, player?, unlocked), vehicle, spot, dispose() }
//   unlocked 時：停放點沒有專屬車（或殘骸）→ 玩家離停放點 > CAR_RESPAWN_DIST（或 force）時 adopt 一台（REWARD_CAR.type 換 REWARD_CAR.color，v.storyCar = true）；
//   完好但棄置在離停放點 > CAR_HOME_DIST、無人駕駛、!isBusy、玩家也不在旁（或 force）→ 收回補到停放點；未解鎖（新局）→ 收回既有的專屬車
//   殘骸：交一般回收；但殘骸在停放點 WRECK_CLEAR 內 → 補車當下先移除殘骸（避免新車與殘骸同座標重疊）
export function createStoryCarDepot({ vehicles = null, dmg = null, spot = REWARD_CAR, isBusy = () => false } = {}) {
  let car = null;
  let wreck = null; // 上一台成殘骸的專屬車（補車前若仍在停放點旁 → 移除）
  let t = CAR_CHECK_SEC;
  const exists = (v) => !!v && !!vehicles && vehicles.vehicles.includes(v);

  function drop(v) {
    if (!v) return;
    v.storyCar = false;
    if (dmg && typeof dmg.detach === 'function') dmg.detach(v);
    if (vehicles && typeof vehicles.remove === 'function') vehicles.remove(v);
  }

  function spawn() {
    if (!vehicles || typeof vehicles.adopt !== 'function') return null;
    const v = vehicles.adopt({ type: spot.type || REWARD_CAR.type, color: spot.color || REWARD_CAR.color, x: spot.x, z: spot.z, yaw: spot.yaw });
    if (!v) return null;
    v.storyCar = true;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    car = v;
    return v;
  }

  function ensure(force = false, player = null, unlocked = false) {
    const far = (x, z, r) => !player || Math.hypot(player.x - x, player.z - z) > r;
    if (!unlocked) {
      if (exists(car) && !car.driven && !isBusy(car)) drop(car);
      if (!exists(car) || !car.driven) car = null;
      wreck = null;
      return null;
    }
    if (exists(car)) {
      if (car.driven || isBusy(car)) return car;
      const wrecked = dmg && typeof dmg.healthOf === 'function' && dmg.healthOf(car) === 0;
      const away = Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z) > CAR_HOME_DIST;
      if (!wrecked && !away) return car;
      if (wrecked) {
        car.storyCar = false; // 殘骸交一般回收（cleanupVehicles）；停在停放點旁的話補車前移除
        wreck = car;
        car = null;
      } else {
        if (!force && !(far(car.pos.x, car.pos.z, CAR_RESPAWN_DIST) && far(spot.x, spot.z, CAR_RESPAWN_DIST))) return car;
        drop(car);
        car = null;
      }
    }
    if (!force && !far(spot.x, spot.z, CAR_RESPAWN_DIST)) return null;
    if (exists(wreck) && !wreck.driven && !isBusy(wreck) && Math.hypot(wreck.pos.x - spot.x, wreck.pos.z - spot.z) < WRECK_CLEAR) drop(wreck);
    wreck = null;
    return spawn();
  }

  function update(dt, player, unlocked) {
    t += Number.isFinite(dt) ? dt : 0;
    if (t < CAR_CHECK_SEC) return;
    t = 0;
    ensure(false, player, unlocked);
  }

  return {
    update,
    ensure,
    spot,
    dispose() {
      car = null;
      wreck = null;
    },
    get vehicle() {
      return exists(car) ? car : null;
    },
  };
}

// ---------- HUD：任務條 + 字幕框（DOM；root 由整合層給，.story- 前綴樣式在 src/style.css）----------
// createStoryHud({ root, isTouch }) → { set(snapshot | null), dispose(), bar, box }：只在文字變化時寫 DOM
export function createStoryHud({ root = null, isTouch = false, doc = (root && root.ownerDocument) || globalThis.document } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return { set() {}, dispose() {}, bar: null, box: null };
  const bar = doc.createElement('div');
  bar.className = 'story-bar';
  bar.hidden = true;
  const title = doc.createElement('div');
  title.className = 'story-title';
  const goal = doc.createElement('div');
  goal.className = 'story-goal';
  bar.append(title, goal);
  const box = doc.createElement('div');
  box.className = 'story-dialog';
  box.hidden = true;
  const who = doc.createElement('span');
  who.className = 'story-who';
  const text = doc.createElement('span');
  text.className = 'story-line';
  const hint = doc.createElement('div');
  hint.className = 'story-hint';
  hint.textContent = isTouch ? '點互動鈕下一句' : 'E 下一句・Enter 跳過';
  box.append(who, text, hint);
  if (root) root.append(bar, box);
  let lastTitle = null;
  let lastGoal = null;
  let lastWho = null;
  let lastLine = null;
  let lastUrgent = null;

  function set(s) {
    const running = !!s && s.phase === 'run' && !!s.title;
    if (bar.hidden === running) bar.hidden = !running;
    if (running) {
      if (s.title !== lastTitle) title.textContent = lastTitle = s.title;
      if (s.text !== lastGoal) goal.textContent = lastGoal = s.text;
      if (s.urgent !== lastUrgent) {
        lastUrgent = s.urgent;
        bar.classList.toggle('story-urgent', !!s.urgent);
      }
    }
    const talk = !!s && s.dialog;
    if (box.hidden === talk) box.hidden = !talk;
    if (talk) {
      if (s.who !== lastWho) who.textContent = lastWho = s.who;
      if (s.line !== lastLine) text.textContent = lastLine = s.line;
    }
  }

  return {
    set,
    bar,
    box,
    dispose() {
      bar.remove();
      box.remove();
    },
  };
}
